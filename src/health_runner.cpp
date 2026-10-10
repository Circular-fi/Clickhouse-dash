#include "health_runner.hpp"

#include "ch_block_numeric.hpp"

#include "ch_query.hpp"
#include "ch_uri.hpp"
#include "log.hpp"

#include <clickhouse/client.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <optional>
#include <string_view>

namespace chdash {

static int64_t now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}


int normalize_health_interval_ms(int interval_ms) {
  return std::max(250, std::min(600 * 1000, interval_ms));
}

static constexpr int64_t kSystemTablesRefreshMs = 10 * 60 * 1000;
static constexpr int64_t kHostVersionRefreshMs = 10 * 60 * 1000;
// A health connection is useful only while checks are frequent. Close it
// before a long sleep so ClickHouse never has to reap an idle dashboard socket
// through its receive/idle timeout path.
static constexpr int kMaxPersistentHealthClientIdleMs = 60 * 1000;

// What bounds one audit of a host: the runner stops, or the time budget is spent. A query that the budget does not
// allow is not sent, and what it would have said is unknown (never reported as a missing grant).
struct AuditBudget {
  const std::atomic<bool>* stop = nullptr;
  std::chrono::steady_clock::time_point deadline;
  bool exhausted() const {
    return (stop && stop->load(std::memory_order_acquire)) || std::chrono::steady_clock::now() >= deadline;
  }
};

// A detection is read again after kSystemTablesRefreshMs; after 1 min while query_log is missing (ClickHouse creates
// it at its first flush); after 30 s when it failed: the host then says "not checked", never "no query_log".
static int64_t system_tables_refresh_ms(const HostSystemTables& tables) {
  if (!tables.checked) return 30 * 1000;
  if (!tables.query_log) return 60 * 1000;
  return kSystemTablesRefreshMs;
}

static HostSystemTables detect_system_tables(clickhouse::Client* client, int64_t ts_ms, const AuditBudget& budget) {
  HostSystemTables out;
  out.checked = true;
  out.checked_at_ms = ts_ms;
  if (!client || budget.exhausted()) return out;

  try {
    ch_select(*client,
      "SELECT name FROM system.tables WHERE database = 'system' AND name IN "
      "('query_log', 'query_views_log', 'processors_profile_log', 'opentelemetry_span_log')",
      [&](const clickhouse::Block& b) {
        if (b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
        auto col = b[0]->As<clickhouse::ColumnString>();
        if (!col) return;
        for (size_t i = 0; i < b.GetRowCount(); ++i) {
          const std::string_view sv = col->At(i);
          if (sv == "query_log") out.query_log = true;
          else if (sv == "query_views_log") out.query_views_log = true;
          else if (sv == "processors_profile_log") out.processors_profile_log = true;
          else if (sv == "opentelemetry_span_log") out.opentelemetry_span_log = true;
        }
      }
    );
  } catch (...) {
    out.checked = false;
    return out;
  }

  return out;
}

// CHECK GRANT: true when the grant is held; `known` is false when the server did not answer in a way that
// can be read (an unsupported form, a missing table): the audit then says nothing about it.
static bool check_grant(clickhouse::Client& client, const std::string& expression, bool* known, const AuditBudget& budget) {
  *known = false;
  bool granted = false;
  if (budget.exhausted()) return false;
  try {
    ch_select(client, "CHECK GRANT " + expression, [&](const clickhouse::Block& b) {
      if (*known || b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
      bool flag_ok = false;
      const bool flag = ch_column_flag_at(b[0], 0, &flag_ok);
      if (flag_ok) {
        *known = true;
        granted = flag;
      }
    });
  } catch (...) {
    *known = false;
  }
  return *known && granted;
}

static std::string quote_name(const std::string& name) {
  std::string out = "`";
  for (const char c : name) {
    if (c == '`' || c == '\\') out.push_back('\\');
    out.push_back(c);
  }
  out.push_back('`');
  return out;
}

static std::string join_list(const std::vector<std::string>& items) {
  std::string out;
  for (size_t i = 0; i < items.size(); ++i) out += (i ? ", " : "") + items[i];
  return out;
}

static std::string user_of(const std::string& uri) {
  const auto parsed = parse_clickhouse_uri(uri, nullptr);
  return parsed ? parsed->user : std::string();
}

// The system tables that the Explorer and the System page read with the system user. Without
// one of them a figure of the page is missing (the first line of each pair says which).
static const char* const kSystemReads[] = {"system.databases", "system.tables", "system.columns", "system.parts", "system.disks", "system.dictionaries",
                                             "system.metrics", "system.asynchronous_metrics", "system.clusters", "system.query_log"};
// What the runner reads for the Functions page and for the dictionaries.
static const char* const kRunnerReads[] = {"system.functions", "system.documentation", "system.dictionaries"};

// Does the user of the client read any table? A database-wide SELECT is enough; else a table of a database it can SHOW.
// nullopt: the budget ran out before an answer (the audit then says nothing).
static std::optional<bool> reads_a_table(clickhouse::Client& client, const AuditBudget& budget) {
  std::vector<std::string> databases;
  if (budget.exhausted()) return std::nullopt;
  try {
    ch_select(client, "SHOW DATABASES", [&](const clickhouse::Block& b) {
      if (b.GetColumnCount() == 0) return;
      if (auto col = b[0]->As<clickhouse::ColumnString>()) {
        for (size_t i = 0; i < b.GetRowCount(); ++i) databases.emplace_back(col->At(i));
      }
    });
  } catch (...) {
  }
  size_t table_budget = 200;
  for (const auto& database : databases) {
    if (database == "system" || database == "INFORMATION_SCHEMA" || database == "information_schema") continue;
    if (budget.exhausted()) return std::nullopt;
    bool known = false;
    if (check_grant(client, "SELECT ON " + quote_name(database) + ".*", &known, budget)) return true;
    if (!known || table_budget == 0) continue;
    try {
      std::vector<std::string> tables;
      ch_select(client, "SHOW TABLES FROM " + quote_name(database), [&](const clickhouse::Block& b) {
        if (b.GetColumnCount() == 0) return;
        if (auto col = b[0]->As<clickhouse::ColumnString>()) {
          for (size_t i = 0; i < b.GetRowCount(); ++i) tables.emplace_back(col->At(i));
        }
      });
      for (const auto& table : tables) {
        if (table_budget == 0) break;
        if (budget.exhausted()) return std::nullopt;
        --table_budget;
        bool table_known = false;
        if (check_grant(client, "SELECT ON " + quote_name(database) + "." + quote_name(table), &table_known, budget)) return true;
      }
    } catch (...) {
    }
  }
  if (budget.exhausted()) return std::nullopt;
  return false;
}

static HostAccess audit_access(
    clickhouse::Client* runner,
    clickhouse::Client* system,
    const HostSpec& host,
    const HealthSettings& settings,
    int64_t ts_ms,
    const AuditBudget& budget) {
  const std::vector<std::string>& extra_system_reads = settings.system_reads;
  HostAccess out;
  out.checked = true;
  out.checked_at_ms = ts_ms;
  out.runner_user = user_of(host.runner_uri);
  out.system_user = user_of(host.system_uri);
  const auto describe = [](const std::string& who, const std::string& user) { return who + " user " + (user.empty() ? std::string("(default)") : user); };

  if (system) {
    std::vector<std::string> reads(std::begin(kSystemReads), std::end(kSystemReads));
    // The OpenTelemetry tables of this host (they can differ from a host to another), then the extra reads of the settings.
    for (const auto& table : otel_system_reads(host.otel)) reads.push_back(table);
    reads.insert(reads.end(), extra_system_reads.begin(), extra_system_reads.end());
    for (const auto& table : reads) {
      bool known = false;
      const bool granted = check_grant(*system, "SELECT ON " + table, &known, budget);
      if (known && !granted) out.system_missing.push_back("SELECT ON " + table);
    }
    if (!out.system_missing.empty()) {
      std::vector<std::string> tables;
      for (const auto& grant : out.system_missing) tables.push_back(grant.substr(10));
      out.warnings.push_back("The " + describe("system", out.system_user) + " has no SELECT on " + join_list(tables) +
                             ". The Explorer, the System page and the OpenTelemetry pages lose what comes from these tables (storage, parts, disks, dictionaries, server metrics, query log, traces, logs, metrics). Grant it: GRANT SELECT ON ... TO " +
                             (out.system_user.empty() ? std::string("<user>") : out.system_user) + ";");
    }
  }
  if (runner) {
    for (const char* table : kRunnerReads) {
      bool known = false;
      const bool granted = check_grant(*runner, std::string("SELECT ON ") + table, &known, budget);
      if (known && !granted) out.runner_missing.push_back(std::string("SELECT ON ") + table);
    }
    out.runner_reads_nothing = reads_a_table(*runner, budget) == std::optional<bool>(false);
    if (out.runner_reads_nothing) {
      out.warnings.push_back("The " + describe("runner", out.runner_user) +
                             " can read no table: the Explorer, the Query page and the Functions page show nothing. Grant SELECT on the databases that it must show: GRANT SELECT ON <database>.* TO " +
                             (out.runner_user.empty() ? std::string("<user>") : out.runner_user) + ";");
    }
    const auto missing = [&](const char* table) {
      return std::find(out.runner_missing.begin(), out.runner_missing.end(), std::string("SELECT ON ") + table) != out.runner_missing.end();
    };
    const std::string who = describe("runner", out.runner_user);
    const std::string target = out.runner_user.empty() ? std::string("<user>") : out.runner_user;
    std::vector<std::string> function_tables;
    if (missing("system.functions")) function_tables.push_back("system.functions");
    if (missing("system.documentation")) function_tables.push_back("system.documentation");
    if (!function_tables.empty()) {
      out.warnings.push_back("The " + who + " has no SELECT on " + join_list(function_tables) + ": the Functions page of the Explorer is unavailable. GRANT SELECT ON " +
                             function_tables.front() + " TO " + target + ";");
    }
    if (missing("system.dictionaries")) {
      out.warnings.push_back("The " + who + " has no SELECT on system.dictionaries: SHOW DICTIONARIES is refused, so a dictionary shows in the Explorer only when SHOW TABLES lists it.");
    }
  }
  // The MCP user: the API tools run as this user (mcp_identity.hpp), so what the pages ask of the runner and of the
  // system user, the tools ask of it.
  if (settings.mcp_audit && !host.mcp_uri.empty() && !budget.exhausted()) {
    out.mcp_user = user_of(host.mcp_uri);
    std::string error;
    auto mcp = make_client_from_uri(host.mcp_uri, std::chrono::milliseconds(settings.timeout_ms), std::chrono::milliseconds(settings.timeout_ms),
                                    std::chrono::milliseconds(settings.timeout_ms), &error);
    const std::string who = describe("MCP", out.mcp_user);
    out.mcp_audited = true;
    if (!mcp) {
      out.mcp_error = error.empty() ? std::string("connection failed") : error;
      out.warnings.push_back("The " + who + " cannot connect: " + out.mcp_error);
    } else {
      out.mcp_connected = true;
      for (const auto& table : settings.mcp_reads) {
        bool known = false;
        const bool granted = check_grant(*mcp, "SELECT ON " + table, &known, budget);
        if (known && !granted) out.mcp_missing.push_back("SELECT ON " + table);
      }
      out.mcp_reads_nothing = reads_a_table(*mcp, budget) == std::optional<bool>(false);
      if (out.mcp_reads_nothing) {
        out.warnings.push_back("The " + who + " can read no table: every tool of MCP answers with nothing. GRANT SELECT ON <database>.* TO " +
                               (out.mcp_user.empty() ? std::string("<user>") : out.mcp_user) + ";");
      }
      if (!out.mcp_missing.empty()) {
        std::vector<std::string> tables;
        for (const auto& grant : out.mcp_missing) tables.push_back(grant.substr(10));
        out.warnings.push_back("The " + who + " has no SELECT on " + join_list(tables) +
                               ": the tools that read them (Traces, Logs, Metrics, the Functions of the Explorer) answer permission_denied. GRANT SELECT ON ... TO " +
                               (out.mcp_user.empty() ? std::string("<user>") : out.mcp_user) + ";");
      }
    }
  }
  return out;
}

struct HostVersion {
  std::string version;
  // The server's timezone(): ClickHouse prints DateTime values of system
  // tables in it, and the UI converts them to the browser's zone.
  std::string timezone;
};

static HostVersion detect_host_version(clickhouse::Client* client) {
  HostVersion out;
  if (!client) return out;
  try {
    ch_select(*client,
      "SELECT version(), timezone()",
      [&](const clickhouse::Block& b) {
        if (!out.version.empty() || b.GetRowCount() == 0 || b.GetColumnCount() < 2) return;
        auto version = b[0]->As<clickhouse::ColumnString>();
        auto timezone = b[1]->As<clickhouse::ColumnString>();
        if (!version) return;
        out.version = std::string(version->At(0));
        if (timezone) out.timezone = std::string(timezone->At(0));
      }
    );
  } catch (...) {
    return HostVersion{};
  }
  return out;
}


HealthRunner::HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings)
  : hosts_(std::move(hosts)), settings_(settings) {

  settings_.interval_ms = normalize_health_interval_ms(settings_.interval_ms);
  settings_.timeout_ms = std::max(100, std::min(60 * 1000, settings_.timeout_ms));

  // Initialize snapshot with all hosts non-healthy.
  std::lock_guard<std::mutex> lk(mu_);
  ctx_.reserve(hosts_.size());
  for (const auto& h : hosts_) {
    HostCtx c;
    c.spec = h;
    c.last.id = h.id;
    c.last.label = h.label;
    c.last.healthy = false;
    c.last.ping_ms = -1;
    c.last.checked_at_ms = 0;
    ctx_.push_back(std::move(c));
  }
}

HealthRunner::~HealthRunner() {
  stop();
}

void HealthRunner::start() {
  if (!threads_.empty()) return;
  {
    std::lock_guard<std::mutex> lk(mu_);
    stop_ = false;
  }
  stop_flag_.store(false, std::memory_order_release);
  threads_.reserve(hosts_.size() + 1);
  for (size_t i = 0; i < hosts_.size(); ++i) threads_.emplace_back([this, i] { ping_loop(i); });
  if (!hosts_.empty()) threads_.emplace_back([this] { audit_loop(); });
}

void HealthRunner::stop() {
  {
    // Under the lock: a thread that checked the flag and is about to wait cannot miss the notification.
    std::lock_guard<std::mutex> lk(mu_);
    stop_ = true;
  }
  stop_flag_.store(true, std::memory_order_release);
  cv_.notify_all();
  for (auto& thread : threads_) {
    if (thread.joinable()) thread.join();
  }
  threads_.clear();
}

bool HealthRunner::sleep_until(std::chrono::steady_clock::time_point deadline) {
  std::unique_lock<std::mutex> lk(mu_);
  cv_.wait_until(lk, deadline, [&] { return stop_; });
  return stop_;
}

HostsSnapshot HealthRunner::snapshot() const {
  HostsSnapshot s;
  s.ts_ms = now_ms();
  s.interval_ms = settings_.interval_ms;
  s.timeout_ms = settings_.timeout_ms;

  std::lock_guard<std::mutex> lk(mu_);
  s.hosts.reserve(ctx_.size());
  for (const auto& c : ctx_) {
    s.hosts.push_back(c.last);
    s.hosts.back().error = c.last.healthy ? std::string() : c.last_error;
  }
  return s;
}

uint64_t HealthRunner::version() const {
  std::lock_guard<std::mutex> lk(mu_);
  return version_;
}

bool HealthRunner::wait_for_update(uint64_t last_version, int wait_ms, uint64_t* new_version) {
  if (wait_ms < 0) wait_ms = 0;
  std::unique_lock<std::mutex> lk(mu_);
  const auto pred = [&]() { return version_ != last_version || stop_; };
  if (wait_ms == 0) {
    if (pred()) {
      if (new_version) *new_version = version_;
      return version_ != last_version;
    }
    return false;
  }
  cv_.wait_for(lk, std::chrono::milliseconds(wait_ms), pred);
  if (new_version) *new_version = version_;
  return version_ != last_version;
}

bool HealthRunner::all_healthy() const {
  std::lock_guard<std::mutex> lk(mu_);
  if (ctx_.empty()) return false;
  for (const auto& c : ctx_) {
    if (!c.last.healthy) return false;
  }
  return true;
}

size_t HealthRunner::healthy_count() const {
  std::lock_guard<std::mutex> lk(mu_);
  return static_cast<size_t>(std::count_if(ctx_.begin(), ctx_.end(), [](const HostCtx& c) { return c.last.healthy; }));
}

void HealthRunner::ping_loop(size_t index) {
  using namespace std::chrono;
  // The statements of the health checks and of the access audit are labelled (ch_query.hpp).
  ChQueryLimits limits;
  limits.log_comment = "chdash:health";
  ChQueryScope scope(std::move(limits));
  const HostSpec spec = hosts_[index];
  const auto timeout = milliseconds(settings_.timeout_ms);
  // One runner client per host, owned by this thread: the health of a host is measured with the credentials that
  // run the user queries (the system user is only audited).
  std::shared_ptr<clickhouse::Client> client;
  int64_t version_checked_at_ms = 0;

  while (!stopping()) {
    const auto tick_start = steady_clock::now();
    const int64_t ts = now_ms();
    bool ok = false;
    int64_t ping_ms = -1;
    std::string error;

    if (!client) {
      // DNS and connect may block for the timeout: outside the lock, in this host's thread only.
      std::string err;
      client = make_client_from_uri(spec.runner_uri, timeout, timeout, timeout, &err);
      if (!client) error = err.empty() ? "client initialization failed" : err;
    }
    if (client) {
      const auto ping = [&] {
        const auto started = steady_clock::now();
        client->Ping();
        ok = true;
        ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
      };
      try {
        ping();
      } catch (const std::exception& e) {
        error = e.what();
      } catch (...) {
        error = "unknown ping failure";
      }
      if (!ok) {
        // A stale socket (the server or a proxy closed it): reconnect once before the host is reported down.
        try {
          client->ResetConnection();
          ping();
          error.clear();
        } catch (const std::exception& reconnect_error) {
          error += "; reconnect failed: ";
          error += reconnect_error.what();
        } catch (...) {
          error += "; reconnect failed";
        }
      }
      if (!ok) client.reset();
    }

    std::optional<HostVersion> version;
    if (ok && (version_checked_at_ms == 0 || ts - version_checked_at_ms >= kHostVersionRefreshMs)) {
      version = detect_host_version(client.get());
      version_checked_at_ms = ts;
    }

    {
      std::lock_guard<std::mutex> lk(mu_);
      auto& ctx = ctx_[index];
      const bool was_healthy = ctx.last.healthy;
      const bool first = ctx.last.checked_at_ms == 0;
      ctx.last.checked_at_ms = ts;
      ctx.last.healthy = ok;
      ctx.last.ping_ms = ok ? ping_ms : -1;
      if (ok) {
        if (!was_healthy) {
          ctx.audit_due = true;
          if (!first) log_event(LogLevel::Info, "health.host_up", {{"host", spec.id}, {"ping_ms", ping_ms}});
        }
        ctx.last_error.clear();
      } else {
        const std::string message = error.empty() ? "ping failed" : error;
        // A failure is logged when the host goes down and when its reason changes, not at every retry.
        if (was_healthy || ctx.last_error != message) {
          log_event(LogLevel::Warn, "health.host_down", {{"host", spec.id}, {"error", message}});
        }
        ctx.last_error = message;
      }
      if (version) {
        ctx.last.version_checked_at_ms = ts;
        if (!version->version.empty()) ctx.last.clickhouse_version = std::move(version->version);
        if (!version->timezone.empty()) ctx.last.clickhouse_timezone = std::move(version->timezone);
      }
      ++version_;
    }
    cv_.notify_all();

    // A host without a connection is retried every second.
    int interval_ms = settings_.interval_ms;
    if (!client) interval_ms = std::min(interval_ms, 1000);
    // A health connection is useful only while checks are frequent: close it before a long sleep, so ClickHouse
    // never reaps an idle dashboard socket through its receive timeout.
    if (interval_ms > kMaxPersistentHealthClientIdleMs) client.reset();
    if (sleep_until(tick_start + milliseconds(interval_ms))) break;
  }
}

void HealthRunner::audit_loop() {
  using namespace std::chrono;
  ChQueryLimits limits;
  limits.log_comment = "chdash:health";
  ChQueryScope scope(std::move(limits));
  const auto timeout = milliseconds(settings_.timeout_ms);
  while (!stopping()) {
    for (size_t index = 0; index < ctx_.size() && !stopping(); ++index) {
      HostSpec spec;
      bool due = false;
      const int64_t ts = now_ms();
      {
        std::lock_guard<std::mutex> lk(mu_);
        const auto& ctx = ctx_[index];
        due = ctx.last.healthy && (ctx.audit_due || ctx.last.system_tables.checked_at_ms == 0 ||
                                   ts - ctx.last.system_tables.checked_at_ms >= system_tables_refresh_ms(ctx.last.system_tables));
        if (due) spec = ctx.spec;
      }
      if (!due) continue;

      // Connections of the audit only (a clickhouse::Client serves one thread): the ping thread keeps its own.
      const AuditBudget budget{&stop_flag_, steady_clock::now() + milliseconds(kAuditBudgetMs)};
      std::string runner_error;
      auto runner = make_client_from_uri(spec.runner_uri, timeout, timeout, timeout, &runner_error);
      const bool same_credentials = spec.system_uri == spec.runner_uri;
      std::string system_error;
      auto system = same_credentials ? runner : make_client_from_uri(spec.system_uri, timeout, timeout, timeout, &system_error);
      HostSystemTables tables;
      HostAccess access;
      if (system) {
        tables = detect_system_tables(system.get(), ts, budget);
        access = audit_access(runner.get(), system.get(), spec, settings_, ts, budget);
      } else {
        access = audit_access(runner.get(), nullptr, spec, settings_, ts, budget);
        const std::string user = user_of(spec.system_uri);
        access.warnings.push_back("The system user " + (user.empty() ? std::string("(default)") : user) +
                                  " cannot connect: " + (system_error.empty() ? std::string("connection failed") : system_error));
        tables.checked = false;
        tables.checked_at_ms = ts;
      }
      runner.reset();
      system.reset();
      if (stopping()) break;
      if (budget.exhausted()) {
        log_event(LogLevel::Warn, "access.audit_incomplete", {{"host", spec.id}, {"budget_ms", kAuditBudgetMs}});
      }

      {
        std::lock_guard<std::mutex> lk(mu_);
        auto& ctx = ctx_[index];
        ctx.audit_due = false;
        ctx.last.system_tables = tables;
        // A finding is logged when it appears and when it changes, once for each: the start of the
        // process, or a grant that is revoked later. A host with no finding says nothing.
        if (access.warnings != ctx.last.access.warnings) {
          for (const auto& warning : access.warnings) {
            log_event(LogLevel::Warn, "access.finding", {{"host", spec.id}, {"finding", warning}});
          }
        }
        ctx.last.access = std::move(access);
        ++version_;
      }
      cv_.notify_all();
    }

    // Until a host turns healthy again (its audit is due now), or the next check of the 10-minute refresh.
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait_for(lk, seconds(5), [&] {
      if (stop_) return true;
      return std::any_of(ctx_.begin(), ctx_.end(), [](const HostCtx& c) { return c.last.healthy && c.audit_due; });
    });
    if (stop_) break;
  }
}

} // namespace chdash
