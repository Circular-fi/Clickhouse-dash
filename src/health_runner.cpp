#include "health_runner.hpp"

#include "ch_uri.hpp"

#include <clickhouse/client.h>

#include <algorithm>
#include <chrono>
#include <future>
#include <iterator>
#include <iostream>
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

static HostSystemTables detect_system_tables(clickhouse::Client* client, int64_t ts_ms) {
  HostSystemTables out;
  out.checked = true;
  out.checked_at_ms = ts_ms;
  if (!client) return out;

  try {
    client->Select(
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
    return out;
  }

  return out;
}

// CHECK GRANT: true when the grant is held; `known` is false when the server did not answer in a way that
// can be read (an unsupported form, a missing table): the audit then says nothing about it.
static bool check_grant(clickhouse::Client& client, const std::string& expression, bool* known) {
  *known = false;
  bool granted = false;
  try {
    client.Select("CHECK GRANT " + expression, [&](const clickhouse::Block& b) {
      if (*known || b.GetRowCount() == 0 || b.GetColumnCount() == 0) return;
      if (auto col = b[0]->As<clickhouse::ColumnUInt8>()) {
        *known = true;
        granted = col->At(0) != 0;
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
static bool reads_a_table(clickhouse::Client& client) {
  std::vector<std::string> databases;
  try {
    client.Select("SHOW DATABASES", [&](const clickhouse::Block& b) {
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
    bool known = false;
    if (check_grant(client, "SELECT ON " + quote_name(database) + ".*", &known)) return true;
    if (!known || table_budget == 0) continue;
    try {
      std::vector<std::string> tables;
      client.Select("SHOW TABLES FROM " + quote_name(database), [&](const clickhouse::Block& b) {
        if (b.GetColumnCount() == 0) return;
        if (auto col = b[0]->As<clickhouse::ColumnString>()) {
          for (size_t i = 0; i < b.GetRowCount(); ++i) tables.emplace_back(col->At(i));
        }
      });
      for (const auto& table : tables) {
        if (table_budget == 0) break;
        --table_budget;
        bool table_known = false;
        if (check_grant(client, "SELECT ON " + quote_name(database) + "." + quote_name(table), &table_known)) return true;
      }
    } catch (...) {
    }
  }
  return false;
}

static HostAccess audit_access(
    clickhouse::Client* runner,
    clickhouse::Client* system,
    const HostSpec& host,
    const HealthSettings& settings,
    int64_t ts_ms) {
  const std::vector<std::string>& extra_system_reads = settings.system_reads;
  HostAccess out;
  out.checked = true;
  out.checked_at_ms = ts_ms;
  out.runner_user = user_of(host.runner_uri);
  out.system_user = user_of(host.system_uri);
  const auto describe = [](const std::string& who, const std::string& user) { return who + " user " + (user.empty() ? std::string("(default)") : user); };

  if (system) {
    std::vector<std::string> reads(std::begin(kSystemReads), std::end(kSystemReads));
    reads.insert(reads.end(), extra_system_reads.begin(), extra_system_reads.end());
    for (const auto& table : reads) {
      bool known = false;
      const bool granted = check_grant(*system, "SELECT ON " + table, &known);
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
      const bool granted = check_grant(*runner, std::string("SELECT ON ") + table, &known);
      if (known && !granted) out.runner_missing.push_back(std::string("SELECT ON ") + table);
    }
    out.runner_reads_nothing = !reads_a_table(*runner);
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
  if (settings.mcp_audit && !host.mcp_uri.empty()) {
    out.mcp_user = user_of(host.mcp_uri);
    std::string error;
    auto mcp = make_client_from_uri(host.mcp_uri, std::chrono::milliseconds(settings.timeout_ms), std::chrono::milliseconds(settings.timeout_ms),
                                    std::chrono::milliseconds(settings.timeout_ms), &error);
    const std::string who = describe("MCP", out.mcp_user);
    if (!mcp) {
      out.warnings.push_back("The " + who + " cannot connect: " + (error.empty() ? std::string("connection failed") : error));
    } else {
      for (const auto& table : settings.mcp_reads) {
        bool known = false;
        const bool granted = check_grant(*mcp, "SELECT ON " + table, &known);
        if (known && !granted) out.mcp_missing.push_back("SELECT ON " + table);
      }
      out.mcp_reads_nothing = !reads_a_table(*mcp);
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
    client->Select(
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
  if (th_.joinable()) return;
  stop_.store(false, std::memory_order_relaxed);
  th_ = std::thread([this] { loop(); });
}

void HealthRunner::stop() {
  stop_.store(true, std::memory_order_relaxed);
  cv_.notify_all();
  if (th_.joinable()) th_.join();
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
  const auto pred = [&]() { return version_ != last_version || stop_.load(std::memory_order_relaxed); };
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

void HealthRunner::loop() {
  using namespace std::chrono;

  while (!stop_.load(std::memory_order_relaxed)) {
    const auto tick_start = steady_clock::now();
    const int64_t ts = now_ms();

    struct InitJob {
      size_t index = 0;
      std::string id;
      std::string uri;
    };

    std::vector<InitJob> init_jobs;
    {
      std::lock_guard<std::mutex> lk(mu_);
      init_jobs.reserve(ctx_.size());
      for (size_t i = 0; i < ctx_.size(); ++i) {
        if (!ctx_[i].client) init_jobs.push_back(InitJob{i, ctx_[i].spec.id, ctx_[i].spec.runner_uri});
      }
    }

    // Client creation is intentionally outside the runner mutex because DNS and
    // connect timeouts may block. Repeated identical failures are logged once,
    // not every retry cycle.
    for (const auto& job : init_jobs) {
      if (stop_.load(std::memory_order_relaxed)) break;
      std::string err;
      auto client = make_client_from_uri(
          job.uri,
          milliseconds(settings_.timeout_ms),
          milliseconds(settings_.timeout_ms),
          milliseconds(settings_.timeout_ms),
          &err);

      std::lock_guard<std::mutex> lk(mu_);
      if (job.index >= ctx_.size() || ctx_[job.index].client) continue;
      auto& ctx = ctx_[job.index];
      if (client) {
        ctx.client = std::move(client);
        ctx.last_error.clear();
      } else {
        const std::string message = err.empty() ? "client initialization failed" : err;
        if (ctx.last_error != message) {
          std::cerr << "[health] host=" << job.id << " client init error: " << message << "\n";
        }
        ctx.last_error = message;
        ctx.last.checked_at_ms = ts;
        ctx.last.healthy = false;
        ctx.last.ping_ms = -1;
      }
    }

    struct PingJob {
      size_t index = 0;
      std::shared_ptr<clickhouse::Client> client;
    };
    struct PingResult {
      size_t index = 0;
      bool ok = false;
      bool discard_client = false;
      int64_t ping_ms = -1;
      std::string error;
    };
    struct AuxiliaryJob {
      size_t index = 0;
      std::shared_ptr<clickhouse::Client> client;
      std::string uri;
      // The runner client and the host, for the access audit that runs with the system tables check.
      std::shared_ptr<clickhouse::Client> runner;
      HostSpec spec;
    };

    std::vector<PingJob> ping_jobs;
    std::vector<AuxiliaryJob> caps_jobs;
    std::vector<AuxiliaryJob> version_jobs;
    size_t context_count = 0;
    {
      std::lock_guard<std::mutex> lk(mu_);
      context_count = ctx_.size();
      ping_jobs.reserve(ctx_.size());
      for (size_t i = 0; i < ctx_.size(); ++i) {
        const auto& ctx = ctx_[i];
        ping_jobs.push_back(PingJob{i, ctx.client});
        if (ctx.client &&
            (ctx.last.system_tables.checked_at_ms == 0 ||
             ts - ctx.last.system_tables.checked_at_ms >= kSystemTablesRefreshMs)) {
          const bool same_credentials = ctx.spec.system_uri == ctx.spec.runner_uri;
          caps_jobs.push_back(AuxiliaryJob{
              i,
              same_credentials ? ctx.client : std::shared_ptr<clickhouse::Client>{},
              same_credentials ? std::string{} : ctx.spec.system_uri,
              ctx.client,
              ctx.spec,
          });
        }
        if (ctx.client &&
            (ctx.last.version_checked_at_ms == 0 ||
             ts - ctx.last.version_checked_at_ms >= kHostVersionRefreshMs)) {
          version_jobs.push_back(AuxiliaryJob{i, ctx.client, {}, {}, {}});
        }
      }
    }

    auto ping_one = [](const PingJob& job) {
      PingResult result;
      result.index = job.index;
      if (!job.client) {
        result.error = "no client";
        return result;
      }
      try {
        const auto started = steady_clock::now();
        job.client->Ping();
        result.ok = true;
        result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
      } catch (const std::exception& e) {
        result.error = e.what();
        try {
          const auto started = steady_clock::now();
          job.client->ResetConnection();
          job.client->Ping();
          result.ok = true;
          result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
          result.error.clear();
        } catch (const std::exception& reconnect_error) {
          result.discard_client = true;
          result.error += "; reconnect failed: ";
          result.error += reconnect_error.what();
        } catch (...) {
          result.discard_client = true;
          result.error += "; reconnect failed";
        }
      } catch (...) {
        result.error = "unknown ping failure";
        try {
          const auto started = steady_clock::now();
          job.client->ResetConnection();
          job.client->Ping();
          result.ok = true;
          result.ping_ms = duration_cast<milliseconds>(steady_clock::now() - started).count();
          result.error.clear();
        } catch (const std::exception& reconnect_error) {
          result.discard_client = true;
          result.error += "; reconnect failed: ";
          result.error += reconnect_error.what();
        } catch (...) {
          result.discard_client = true;
          result.error += "; reconnect failed";
        }
      }
      return result;
    };

    std::vector<PingResult> ping_results;
    ping_results.reserve(ping_jobs.size());
    if (ping_jobs.size() <= 1) {
      for (const auto& job : ping_jobs) ping_results.push_back(ping_one(job));
    } else {
      // Preserve parallel health checks for multiple hosts, but avoid spawning a
      // short-lived std::async worker every five seconds in the common 1-host case.
      std::vector<std::future<PingResult>> futures;
      futures.reserve(ping_jobs.size());
      for (const auto& job : ping_jobs) {
        futures.push_back(std::async(std::launch::async, [job, ping_one] { return ping_one(job); }));
      }
      for (auto& future : futures) ping_results.push_back(future.get());
    }

    std::vector<bool> ping_ok(context_count, false);
    for (const auto& result : ping_results) {
      if (result.index < ping_ok.size()) ping_ok[result.index] = result.ok;
    }

    std::vector<std::pair<size_t, HostSystemTables>> caps_results;
    std::vector<std::pair<size_t, HostAccess>> access_results;
    caps_results.reserve(caps_jobs.size());
    for (const auto& job : caps_jobs) {
      if (job.index < ping_ok.size() && ping_ok[job.index]) {
        if (job.client) {
          caps_results.emplace_back(job.index, detect_system_tables(job.client.get(), ts));
          access_results.emplace_back(job.index, audit_access(job.runner.get(), job.client.get(), job.spec, settings_, ts));
          continue;
        }

        std::string error;
        auto system_client = make_client_from_uri(
            job.uri,
            milliseconds(settings_.timeout_ms),
            milliseconds(settings_.timeout_ms),
            milliseconds(settings_.timeout_ms),
            &error);
        if (system_client) {
          caps_results.emplace_back(job.index, detect_system_tables(system_client.get(), ts));
          access_results.emplace_back(job.index, audit_access(job.runner.get(), system_client.get(), job.spec, settings_, ts));
        } else {
          HostAccess unreachable = audit_access(job.runner.get(), nullptr, job.spec, settings_, ts);
          unreachable.warnings.push_back("The system user " + (user_of(job.spec.system_uri).empty() ? std::string("(default)") : user_of(job.spec.system_uri)) +
                                         " cannot connect: " + (error.empty() ? std::string("connection failed") : error));
          access_results.emplace_back(job.index, std::move(unreachable));
          HostSystemTables unavailable;
          unavailable.checked = true;
          unavailable.checked_at_ms = ts;
          caps_results.emplace_back(job.index, unavailable);
        }
      }
    }

    std::vector<std::pair<size_t, HostVersion>> version_results;
    version_results.reserve(version_jobs.size());
    for (const auto& job : version_jobs) {
      if (job.index < ping_ok.size() && ping_ok[job.index]) {
        version_results.emplace_back(job.index, detect_host_version(job.client.get()));
      }
    }

    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& result : ping_results) {
        if (result.index >= ctx_.size()) continue;
        auto& ctx = ctx_[result.index];
        const bool was_healthy = ctx.last.healthy;
        ctx.last.checked_at_ms = ts;
        ctx.last.healthy = result.ok;
        ctx.last.ping_ms = result.ok ? result.ping_ms : -1;
        if (result.ok) {
          ctx.last_error.clear();
        } else {
          std::string message = result.error.empty() ? "ping failed" : result.error;
          // No client: the connection error of the last attempt is the reason, keep it.
          if (message == "no client" && !ctx.last_error.empty()) message = ctx.last_error;
          if (was_healthy || ctx.last_error != message) {
            std::cerr << "[health] host=" << ctx.spec.id << " down: " << message << "\n";
          }
          ctx.last_error = message;
        }
        if (result.discard_client) ctx.client.reset();
      }
      for (auto& result : caps_results) {
        if (result.first < ctx_.size()) ctx_[result.first].last.system_tables = result.second;
      }
      for (auto& result : access_results) {
        if (result.first >= ctx_.size()) continue;
        auto& health = ctx_[result.first].last;
        // A finding is logged when it appears and when it changes, once for each: the start of the
        // process, or a grant that is revoked later. A host with no finding says nothing.
        if (result.second.warnings != health.access.warnings) {
          for (const auto& warning : result.second.warnings) std::cerr << "[access] host=" << health.id << " " << warning << "\n";
        }
        health.access = std::move(result.second);
      }
      for (auto& result : version_results) {
        if (result.first >= ctx_.size()) continue;
        auto& health = ctx_[result.first].last;
        health.version_checked_at_ms = ts;
        if (!result.second.version.empty()) health.clickhouse_version = std::move(result.second.version);
        if (!result.second.timezone.empty()) health.clickhouse_timezone = std::move(result.second.timezone);
      }
      ++version_;
    }
    cv_.notify_all();

    const auto elapsed = duration_cast<milliseconds>(steady_clock::now() - tick_start);
    int effective_interval_ms = settings_.interval_ms;
    {
      std::lock_guard<std::mutex> lk(mu_);
      for (const auto& ctx : ctx_) {
        if (!ctx.client) {
          effective_interval_ms = std::min(effective_interval_ms, 1000);
          break;
        }
      }
    }

    const bool release_clients_before_wait =
        effective_interval_ms > kMaxPersistentHealthClientIdleMs;
    if (release_clients_before_wait) {
      {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& ctx : ctx_) ctx.client.reset();
      }
      // The job vectors also own shared references. Release them before the
      // sleep so the TCP sockets are actually closed now, not next cycle.
      ping_jobs.clear();
      caps_jobs.clear();
      version_jobs.clear();
    }

    const auto remaining = milliseconds(effective_interval_ms) - elapsed;
    if (remaining.count() > 0) {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait_for(lk, remaining, [&] { return stop_.load(std::memory_order_relaxed); });
    }
  }
}

} // namespace chdash
