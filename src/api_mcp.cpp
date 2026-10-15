// MCP endpoint (POST /mcp) and the REST routes of the MCP page (/api/mcp/*).
// See docs/mcp.md. The endpoint exists only when mcp.enabled = true.
//
// Every query of a tool runs through the client pool with the host's mcp_uri
// identity (never runner_uri or system_uri), with readonly=1 and the caps of
// the configuration. This file never logs SQL or row data.

#include "server.hpp"

#include "ch_error.hpp"

#include "allowed_objects.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_guard.hpp"
#include "json_clickhouse.hpp"
#include "log.hpp"
#include "mcp_grants.hpp"
#include "mcp_cost.hpp"
#include "mcp_identity.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"
#include "mcp_usage.hpp"
#include "mcp_usage_store.hpp"
#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <system_error>
#include <unordered_map>

namespace chdash {
namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

std::string lower_ascii(std::string s) {
  for (auto& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::string trim_spaces(std::string_view s) {
  size_t b = 0;
  size_t e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t')) ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t')) --e;
  return std::string(s.substr(b, e - b));
}

int64_t unix_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

int64_t steady_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// One Cache-Control header, however many layers ask for it.
void set_no_store(httplib::Response& res) {
  res.headers.erase("Cache-Control");
  res.set_header("Cache-Control", "no-store");
}

void put(Writer& w, std::string_view s) { write_json_text(w, s); }

// The one error answer (api_error.hpp) and, for a validation error, "field" and "reason".
void api_error(httplib::Response& res, int status, const std::string& code, const std::string& message,
               const std::string& field = {}, const std::string& reason = {}) {
  ApiError error;
  error.status = status;
  error.code = code;
  error.message = message;
  if (!field.empty() || !reason.empty()) {
    error.text.emplace_back("field", field);
    error.text.emplace_back("reason", reason);
  }
  send_error(res, error);
  set_no_store(res);
}

void api_ok(httplib::Response& res, int status, const rapidjson::StringBuffer& sb) {
  res.status = status;
  set_no_store(res);
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

// Cross-site guard of the key routes that are reads: what a key reaches is shown on the ChDash page
// only (http_guard.hpp). Every write of the page (create, delete) has the same guard for every route, with the check
// of its body, before the routing (Server::before_routing).
bool allow_from_page(const httplib::Request& req, httplib::Response& res) {
  if (!is_cross_site_request(req)) return true;
  api_error(res, 403, "cross_site_request", "MCP key routes are accepted from the ChDash page only");
  return false;
}

// The parameters of GET /api/mcp/usage/overview besides the window: `group`, and the filters `key`, `method`, `client`, `instance`, `result`
// and `type`, each of them repeatable, checked by mcp_usage_overview_check. A name that the route does not read is refused (400 validation,
// reason unknown), so a typo is an error and not a filter that does nothing (the old `split` is one). Nullopt when they are valid.
std::optional<McpValidationError> read_usage_overview_query(const httplib::Request& req, McpUsageOverviewQuery* query) {
  for (const auto& item : req.params) {
    if (item.first != "window" && item.first != "group" && item.first != "key" && item.first != "method" && item.first != "client" &&
        item.first != "instance" && item.first != "result" && item.first != "type") {
      return McpValidationError{item.first, "unknown", "unknown parameter: " + item.first};
    }
  }
  if (req.has_param("group")) query->group = req.get_param_value("group");
  const auto values = [&](const char* name) {
    std::vector<std::string> out;
    const auto range = req.params.equal_range(name);
    for (auto it = range.first; it != range.second; ++it) out.push_back(it->second);
    return out;
  };
  query->keys = values("key");
  query->methods = values("method");
  query->clients = values("client");
  query->instances = values("instance");
  query->results = values("result");
  query->types = values("type");
  return mcp_usage_overview_check(query);
}

bool origin_listed(const std::string& origin, const std::vector<std::string>& allowed) {
  std::string normalized = lower_ascii(origin);
  while (!normalized.empty() && normalized.back() == '/') normalized.pop_back();
  for (const auto& entry : allowed) {
    std::string candidate = lower_ascii(entry);
    while (!candidate.empty() && candidate.back() == '/') candidate.pop_back();
    if (candidate == normalized) return true;
  }
  return false;
}

// The key of the request, or empty. The header is mcp.auth_header: "Authorization" takes "Bearer <key>";
// any other name takes the key alone, or "Bearer <key>".
std::string bearer_token(const httplib::Request& req, const std::string& header_name) {
  std::string header = trim_spaces(req.get_header_value(header_name));
  const bool bearer = header.size() >= 8 && lower_ascii(header.substr(0, 7)) == "bearer ";
  if (bearer) return trim_spaces(std::string_view(header).substr(7));
  if (lower_ascii(header_name) == "authorization") return {};
  return header;
}

// ---- what a key reaches ---------------------------------------------------------------------

// The objects that the MCP ClickHouse user of a host may read (CHECK GRANT and zero-row probes as that user, never
// SHOW GRANTS): the AclService answer of the MCP identity, shared with the routes that run as it. A failure is not kept.
struct McpReadable {
  std::shared_ptr<const AllowedObjectSet> objects;
  bool truncated = false;
  std::string user;
  std::string error;
};

McpReadable mcp_readable_objects(AclService& acl, const std::shared_ptr<ClickHouseClientPool>& pool, const HostSpec& host, bool refresh) {
  McpReadable out;
  if (const auto parsed = parse_clickhouse_uri(host.mcp_uri, nullptr)) out.user = parsed->user;
  const AclAccess access = make_acl_access(pool, host.mcp_uri);
  if (refresh) acl.invalidate(access);
  try {
    const auto set = acl.table_set(access);
    out.objects = std::shared_ptr<const AllowedObjectSet>(set, &set->allowed);
    out.truncated = set->truncated;
  } catch (const AclUnavailable& e) {
    out.error = e.what();
  }
  return out;
}

// The answers of several hosts, read at the same time: a cold host does not wait for the others.
std::map<std::string, McpReadable> mcp_readable_by_host(AclService& acl, const std::shared_ptr<ClickHouseClientPool>& pool,
                                                        const std::vector<const HostSpec*>& hosts, bool refresh) {
  std::map<std::string, std::future<McpReadable>> pending;
  for (const HostSpec* host : hosts) {
    if (pending.count(host->id)) continue;
    pending.emplace(host->id, std::async(std::launch::async, [&acl, pool, host, refresh] {
      return mcp_readable_objects(acl, pool, *host, refresh);
    }));
  }
  std::map<std::string, McpReadable> out;
  for (auto& [id, future] : pending) out.emplace(id, future.get());
  return out;
}

// ---- the ClickHouse side -------------------------------------------------------------------

// Bytes of a cell on the native wire, close enough to ClickHouse's own count of the result size:
// the fixed-width types by their width, the rest by the length of their JSON text.
uint64_t native_cell_bytes(const clickhouse::ColumnRef& column, uint64_t json_length) {
  using Code = clickhouse::Type::Code;
  switch (column->Type()->GetCode()) {
    case Code::Int8: case Code::UInt8: case Code::Bool: case Code::Enum8: return 1;
    case Code::Int16: case Code::UInt16: case Code::Enum16: case Code::Date: return 2;
    case Code::Int32: case Code::UInt32: case Code::Float32: case Code::Date32: case Code::DateTime: case Code::IPv4: return 4;
    case Code::Int64: case Code::UInt64: case Code::Float64: case Code::DateTime64: return 8;
    case Code::UUID: case Code::Int128: case Code::UInt128: case Code::IPv6: return 16;
    default: return json_length;
  }
}

// The code of an error of a tool, from what the failure is (ch_error.hpp): the same classification as the pages.
std::string error_code_of(const ChError& failure) {
  switch (failure.kind) {
    case ChErrorKind::Timeout: return "timeout";
    case ChErrorKind::AccessDenied: return "permission_denied";
    case ChErrorKind::ReadOnly: return "readonly";
    case ChErrorKind::MemoryLimit: return "memory_limit";
    case ChErrorKind::ScanLimit: return "read_limit";
    case ChErrorKind::NotFound: return failure.code == 60 || failure.code == 81 ? "not_found" : "query_failed";
    case ChErrorKind::BadQuery: return failure.code == 62 ? "syntax_error" : "query_failed";
    case ChErrorKind::Canceled: return "cancelled";
    default: return "query_failed";
  }
}

// What a key of a host can ask for at most: the smaller of the configuration of MCP and the profile of the ClickHouse user of the
// host, and which of them binds ("mcp", "clickhouse", or "both" when they are equal). The page shows it and the key is refused above it.
struct McpHostLimit {
  int64_t value = 0;
  const char* source = "mcp";
};
struct McpHostLimits {
  McpHostLimit max_rows;
  McpHostLimit timeout_seconds;
};

McpHostLimits mcp_host_limits(const McpSettings& settings, const HostAccess* access) {
  McpHostLimits out;
  out.max_rows.value = settings.max_rows;
  out.timeout_seconds.value = settings.query_timeout_seconds;
  if (!access || !access->mcp_profile_known) return out;
  const auto bind = [](McpHostLimit* limit, int64_t profile) {
    if (profile <= 0) return;
    if (profile < limit->value) {
      limit->value = profile;
      limit->source = "clickhouse";
    } else if (profile == limit->value) {
      limit->source = "both";
    }
  };
  bind(&out.max_rows, static_cast<int64_t>(std::min<uint64_t>(access->mcp_max_result_rows, static_cast<uint64_t>(INT64_MAX))));
  // A fraction of a second is the second it is rounded up to (a limit of 0.5 s still lets a call ask for 1).
  bind(&out.timeout_seconds, access->mcp_max_execution_time > 0 ? std::max<int64_t>(1, static_cast<int64_t>(access->mcp_max_execution_time)) : 0);
  return out;
}

class ClickHouseMcpDatabase final : public McpDatabase {
public:
  using HealthFn = std::function<std::optional<bool>(const std::string&)>;

  ClickHouseMcpDatabase(std::shared_ptr<ClickHouseClientPool> pool, std::vector<HostSpec> hosts,
                        int64_t timeout_cap_seconds, HealthFn health)
      : pool_(std::move(pool)), hosts_(std::move(hosts)), timeout_cap_(timeout_cap_seconds), health_(std::move(health)) {}

  McpDbResult run(const std::string& host, const std::string& sql, const McpDbLimits& limits) override {
    const HostSpec* spec = nullptr;
    for (const auto& candidate : hosts_) {
      if (candidate.id == host) spec = &candidate;
    }
    // A host without mcp_uri is invisible to MCP: there is no fallback to the runner. The OpenTelemetry tools read their
    // tables with the system user of the host, as the pages do (`as_system`); every other query is the MCP user's.
    if (!spec || spec->mcp_uri.empty()) throw McpDbError("host_unavailable", "the host " + host + " has no MCP identity");
    if (!pool_) throw McpDbError("host_unavailable", "no ClickHouse client pool");
    const std::string& uri = limits.as_system && !spec->system_uri.empty() ? spec->system_uri : spec->mcp_uri;
    const char* who = uri == spec->mcp_uri ? "the MCP user" : "the system user";

    std::string connect_error;
    auto client = pool_->acquire(uri, std::chrono::milliseconds(5000),
                                 std::chrono::seconds(timeout_cap_ + 15), std::chrono::milliseconds(10000), &connect_error);
    if (!client) throw McpDbError("host_unavailable", "cannot connect to ClickHouse host " + host + " as " + who + ": " + connect_error);

    // The settings profile of the user decides what is sent (ch_mcp_settings): readonly = 1 when the profile leaves it at 0
    // (the SQL then cannot change anything, nor any limit below), none when the profile has it at 1, and a limit only
    // when it is smaller than the profile's. The profile of the connection is read once.
    ChMcpLimits guard;
    guard.max_rows = limits.max_rows;
    guard.max_bytes = limits.max_bytes;
    guard.timeout_seconds = limits.timeout_seconds;
    guard.max_memory_bytes = limits.max_memory_bytes;
    guard.max_rows_to_read = limits.max_rows_to_read;
    guard.sql_bytes = static_cast<int64_t>(sql.size());
    guard.log_comment = "chdash-mcp key=" + limits.key_id;
    ChMcpSettings plan;
    try {
      plan = ch_mcp_settings(guard, ch_connection_profile(*client));
    } catch (const std::system_error& error) {
      pool_->invalidate(client);
      throw McpDbError("host_unavailable", std::string("the connection to ClickHouse failed: ") + error.what());
    } catch (const std::exception& error) {
      pool_->invalidate(client);
      throw McpDbError("query_failed", error.what());
    }

    // Named for the key and the tool (mcp_cost.hpp): what the statement costs is found in system.query_log, whatever its profile
    // lets ChDash send and whatever its SQL says.
    clickhouse::Query query(sql, mcp_query_id(limits.key_id, limits.tool));
    for (const auto& [name, value] : plan.settings) {
      clickhouse::QuerySettingsField field;
      field.value = value;
      query.SetSetting(name, field);
    }

    McpDbResult result;
    bool done = false;
    uint64_t json_bytes = 0;
    uint64_t native_bytes = 0;
    rapidjson::StringBuffer cell_buffer;
    rapidjson::Writer<rapidjson::StringBuffer> cell_writer(cell_buffer);
    // The rows and bytes the call can return: the guard rails, or the profile's when it cuts earlier.
    const uint64_t max_rows = static_cast<uint64_t>(plan.max_rows);
    const uint64_t max_bytes = static_cast<uint64_t>(plan.max_bytes);

    query.OnDataCancelable([&](const clickhouse::Block& block) -> bool {
      if (done) return false;
      if (result.columns.empty() && block.GetColumnCount() > 0) {
        for (size_t i = 0; i < block.GetColumnCount(); ++i) {
          result.columns.push_back({block.GetColumnName(i), block[i]->Type()->GetName()});
        }
      }
      const size_t rows = block.GetRowCount();
      for (size_t row = 0; row < rows; ++row) {
        if (result.rows.size() >= max_rows) {
          result.truncated = true;
          done = true;
          return false;
        }
        std::vector<std::string> cells;
        cells.reserve(block.GetColumnCount());
        uint64_t row_json = 0;
        uint64_t row_native = 0;
        for (size_t col = 0; col < block.GetColumnCount(); ++col) {
          cell_buffer.Clear();
          cell_writer.Reset(cell_buffer);
          write_cell_json(cell_writer, block[col], row);
          row_json += cell_buffer.GetSize() + 1;
          row_native += native_cell_bytes(block[col], cell_buffer.GetSize());
          cells.emplace_back(cell_buffer.GetString(), cell_buffer.GetSize());
        }
        if (json_bytes + row_json > max_bytes) {
          result.truncated = true;
          done = true;
          return false;
        }
        json_bytes += row_json;
        native_bytes += row_native;
        result.rows.push_back(std::move(cells));
      }
      return true;
    });

    const auto started = std::chrono::steady_clock::now();
    try {
      ch_execute(*client, query);
    } catch (const clickhouse::ServerException& error) {
      // A cut query ends with "cancelled" on some servers: the rows we kept are the answer.
      if (!(done && error.GetCode() == 394)) {
        throw McpDbError(error_code_of(classify_clickhouse_error(error)), error.what());
      }
    } catch (const std::system_error& error) {
      pool_->invalidate(client);
      const auto waited = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - started).count();
      throw McpDbError(waited >= limits.timeout_seconds ? "timeout" : "host_unavailable",
                       std::string("the connection to ClickHouse failed: ") + error.what());
    } catch (const std::exception& error) {
      pool_->invalidate(client);
      throw McpDbError("query_failed", error.what());
    }
    result.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    // ClickHouse itself may have stopped at max_result_bytes (result_overflow_mode = break), and a cut of the profile leaves
    // no extra row to show it: a result that fills what the profile allows is reported as cut.
    if (native_bytes >= max_bytes) result.truncated = true;
    if (plan.rows_cut_by_profile && result.rows.size() >= max_rows) result.truncated = true;
    return result;
  }

  std::optional<bool> host_healthy(const std::string& host) override { return health_ ? health_(host) : std::nullopt; }

private:
  std::shared_ptr<ClickHouseClientPool> pool_;
  std::vector<HostSpec> hosts_;
  int64_t timeout_cap_;
  HealthFn health_;
};

// The API tools call the routes of the API in the process (Server::call_mcp_api): the same handlers that answer the browser,
// run on the thread of the call, with the limits of MCP (admission.hpp keeps the number of calls at once).
class InProcessMcpApi : public McpApiClient {
public:
  explicit InProcessMcpApi(Server& server) : server_(server) {}
  McpApiResponse call(const McpApiRequest& request) override { return server_.call_mcp_api(request); }

private:
  Server& server_;
};

// One audit line per call: who, what, where, how long, how it ended. Never SQL, never data.
void audit(const std::string& key, const std::string& what, const std::string& host, const std::string& status,
           int64_t duration_ms, uint64_t rows) {
  log_event(LogLevel::Info, "mcp.call",
            {{"key", key}, {"call", what}, {"host", host.empty() ? std::string("-") : host}, {"status", status},
             {"duration_ms", duration_ms}, {"rows", rows}});
}

} // namespace

// ---- the analysis of the keys ---------------------------------------------------------------------------------

// What the analysis tools ask of the server (mcp_tools.hpp): the state of the rate limit of a key, its usage and its cost, and the usage of every
// key. A class of Server, so that it reads what the routes of the page read, and the tools never see Server. It holds no state of its own.
class Server::McpAnalysisPort final : public McpAnalysis {
public:
  explicit McpAnalysisPort(Server& server) : server_(server) {}

  McpToolAvailability availability() const override { return server_.mcp_tool_availability(); }

  std::vector<std::string> usage_windows() const override {
    if (!server_.mcp_usage_) return {};
    return mcp_usage_windows(server_.cfg_.mcp.usage.retention_days);
  }

  McpAnalysisLimits limits(const McpKey& key) override {
    McpAnalysisLimits out;
    if (server_.mcp_usage_) out.instance = server_.mcp_usage_->instance();
    out.rate = server_.mcp_rate_.peek(key.id, steady_ms(), server_.cfg_.mcp.rate_limit_per_minute);
    // What a key of its host can ask for at most, with who sets it: the same figures as `limits` of the host in the meta. A key of an older file
    // that names several hosts has the first one's.
    const HostsSnapshot health = server_.health_ ? server_.health_->snapshot() : HostsSnapshot{};
    const HostAccess* access = nullptr;
    for (const auto& item : health.hosts) {
      if (!key.hosts.empty() && item.id == key.hosts.front()) access = &item.access;
    }
    const McpHostLimits caps = mcp_host_limits(server_.cfg_.mcp, access);
    out.max_rows.value = caps.max_rows.value;
    out.max_rows.source = caps.max_rows.source;
    out.timeout_seconds.value = caps.timeout_seconds.value;
    out.timeout_seconds.source = caps.timeout_seconds.source;
    return out;
  }

  std::string my_usage(const McpKey& key, const std::string& window_name, const McpUsageDetailQuery& query, int64_t now) override {
    McpUsage& usage = need_usage();
    const McpUsageWindow window = window_of(window_name, now);
    const McpUsageKeyRef self = mcp_usage_key_ref(key);  // it just authenticated: it exists
    rapidjson::StringBuffer sb;
    Writer w(sb);
    usage.write_detail(w, key.id, &self, window, now, query);
    return std::string(sb.GetString(), sb.GetSize());
  }

  std::string my_cost(const McpKey& key, const std::string& window_name, int64_t now) override {
    return server_.mcp_tool_cost(key, window_name, now);
  }

  std::string all_usage(const std::string& window_name, const McpUsageOverviewQuery& query, int64_t now) override {
    McpUsage& usage = need_usage();
    // The double lock again: the tool names the key, and the configuration must allow it (mcp.usage.all_keys).
    if (!server_.cfg_.mcp.usage.all_keys) {
      throw McpAnalysisError("not_enabled", "reading the usage of all the keys is off: the administrator must set mcp.usage.all_keys in the ChDash configuration");
    }
    const McpUsageWindow window = window_of(window_name, now);
    std::vector<McpUsageKeyRef> live;
    for (const auto& key : server_.mcp_keys_->list()) live.push_back(mcp_usage_key_ref(key));
    rapidjson::StringBuffer sb;
    Writer w(sb);
    usage.write_overview(w, query, live, window, now);
    return std::string(sb.GetString(), sb.GetSize());
  }

private:
  McpUsage& need_usage() const {
    if (!server_.mcp_usage_) throw McpAnalysisError("not_enabled", "the usage of the keys is off: the administrator must set mcp.usage.enabled in the ChDash configuration");
    return *server_.mcp_usage_;
  }

  // The tool checked the window against `usage_windows()`; a name that the retention does not keep is refused here too.
  McpUsageWindow window_of(const std::string& name, int64_t now) const {
    const int64_t retention = server_.cfg_.mcp.usage.retention_days;
    if (const auto window = mcp_usage_window(name, retention, now)) return *window;
    std::string names;
    for (const auto& offered : mcp_usage_windows(retention)) names += (names.empty() ? "" : ", ") + offered;
    throw McpAnalysisError("invalid_argument", "window must be one of " + names);
  }

  Server& server_;
};

McpToolAvailability Server::mcp_tool_availability() const { return {mcp_usage_ != nullptr, cfg_.mcp.usage.all_keys}; }

// ---- setup -----------------------------------------------------------------------------------

void Server::init_mcp() {
  McpStoreOptions store;
  store.storage_file = cfg_.mcp.storage_file;
  store.manage_from_ui = cfg_.mcp.manage_from_ui;
  store.config_keys = cfg_.mcp.keys;
  for (const auto& host : cfg_.hosts) {
    if (!host.mcp_uri.empty()) store.context.hosts.push_back(host.id);
  }
  store.context.max_rows_cap = cfg_.mcp.max_rows;
  store.context.timeout_cap = cfg_.mcp.query_timeout_seconds;
  // A key created from the page needs a host whose MCP user connects, and tools that this user serves. `this`,
  // never a local: the store outlives the constructor.
  store.context.live_check = [this](const McpKey& key) -> std::optional<McpValidationError> {
    if (key.hosts.empty() || !health_) return std::nullopt;
    const HostHealth* host = nullptr;
    const HostsSnapshot health = health_->snapshot();
    for (const auto& item : health.hosts) {
      if (item.id == key.hosts.front()) host = &item;
    }
    const HostSpec* spec = find_host(cfg_.hosts, key.hosts.front());
    if (!host || !spec) return std::nullopt;
    const HostAccess& access = host->access;
    const std::string user = access.mcp_user.empty() ? std::string("<user>") : access.mcp_user;
    if (access.mcp_audited && !access.mcp_connected) {
      return McpValidationError{"hosts", "mcp_user_unavailable",
                                "the MCP user " + user + " cannot connect to host " + host->id + ": " + access.mcp_error};
    }
    for (const auto& gap : mcp_tool_gaps(spec->otel, access)) {
      if (std::find(key.tools.begin(), key.tools.end(), gap.tool) == key.tools.end()) continue;
      return McpValidationError{"tools", "not_grantable",
                                "tool " + gap.tool + " cannot be served: the " + gap.role + " " + gap.user + " lacks " + gap.grants.front() +
                                    (gap.grants.size() > 1 ? " and more" : "") + ". " + mcp_grant_statement(gap.grants, gap.user)};
    }
    return std::nullopt;
  };
  mcp_keys_ = std::make_unique<McpKeyStore>(std::move(store));
  // What each key did, when the usage is on (mcp.usage.enabled): the state of this instance is read from its file (an invalid file stopped
  // the start in config.cpp), then the keys that are gone since the last run are deleted from now on. The files of the other instances are
  // read by the background loop. When it is off nothing is counted: there is no usage object.
  const int64_t started = unix_seconds();
  if (cfg_.mcp.usage.enabled) {
    McpUsageOptions usage;
    usage.store = std::make_shared<McpUsageFileStore>(cfg_.mcp.usage.dir, cfg_.mcp.usage.instance);  // the only storage mode: files
    usage.retention_days = cfg_.mcp.usage.retention_days;
    mcp_usage_ = std::make_unique<McpUsage>(std::move(usage), started);
    std::vector<McpUsageKeyRef> live;
    for (const auto& key : mcp_keys_->list()) live.push_back(mcp_usage_key_ref(key));
    mcp_usage_->sync_live_keys(live, started);
  }

  // `this`, never a local: the callback outlives the constructor.
  mcp_db_ = std::make_unique<ClickHouseMcpDatabase>(
      client_pool_, cfg_.hosts, cfg_.mcp.query_timeout_seconds, [this](const std::string& host) -> std::optional<bool> {
        if (!health_) return std::nullopt;
        for (const auto& item : health_->snapshot().hosts) {
          if (item.id == host) return item.checked_at_ms > 0 ? std::optional<bool>(item.healthy) : std::nullopt;
        }
        return std::nullopt;
      });

  McpToolsConfig tools;
  for (const auto& host : cfg_.hosts) {
    if (!host.mcp_uri.empty()) tools.hosts.push_back({host.id, host.label});
  }
  tools.max_rows = cfg_.mcp.max_rows;
  tools.max_result_bytes = cfg_.mcp.max_result_bytes;
  tools.query_timeout_seconds = cfg_.mcp.query_timeout_seconds;
  tools.max_sql_bytes = cfg_.mcp.max_sql_bytes;
  tools.max_memory_bytes = cfg_.mcp.max_memory_bytes;
  tools.max_rows_to_read = cfg_.mcp.max_rows_to_read;
  // Where the OpenTelemetry data lives: the settings that the Observability pages read, for each host (the tables can
  // differ from a host to another).
  tools.observability = mcp_observability_config(cfg_.otel_defaults);
  for (const auto& host : cfg_.hosts) {
    if (!host.mcp_uri.empty()) tools.observability_by_host[host.id] = mcp_observability_config(host.otel);
  }
  mcp_api_ = std::make_unique<InProcessMcpApi>(*this);
  mcp_analysis_ = std::make_unique<McpAnalysisPort>(*this);
  mcp_tools_ = std::make_unique<McpTools>(std::move(tools), *mcp_db_, mcp_api_.get(), mcp_analysis_.get());
}

void Server::save_mcp_usage(bool force) {
  if (!mcp_usage_) return;
  const int64_t now = unix_seconds();
  // The loop writes the state of this instance every minute when it changed, and reads the others' files when they did.
  if (force) mcp_usage_->save(now);
  else mcp_usage_->tick(now);
}

// ---- POST /mcp ----------------------------------------------------------------------------------

void Server::handle_mcp_not_allowed(const httplib::Request&, httplib::Response& res) {
  res.set_header("Allow", "POST");
  api_error(res, 405, "method_not_allowed", "the MCP endpoint answers POST only (single JSON responses, no stream)");
}

void Server::handle_mcp_post(const httplib::Request& req, httplib::Response& res, const httplib::ContentReader& reader) {
  // The statements of the call stop when the client goes away; each tool sets its own time limit.
  RequestScope scope(make_context(req, false));
  const int64_t started = steady_ms();
  const int64_t now = unix_seconds();
  const auto elapsed = [&] { return steady_ms() - started; };
  set_no_store(res);
  if (!mcp_keys_ || !mcp_tools_) {
    api_error(res, 404, "mcp_disabled", "MCP is disabled");
    return;
  }
  // An early answer does not read the body: close the connection rather than drain it.
  const auto early = [&](int status, const char* code, const std::string& message) {
    res.set_header("Connection", "close");
    api_error(res, status, code, message);
  };

  // 1. A browser page must be listed. A request without Origin (a CLI, an SDK, an IDE) passes.
  const std::string origin = trim_spaces(req.get_header_value("Origin"));
  if (!origin.empty() && !origin_listed(origin, cfg_.mcp.allowed_origins)) {
    audit("-", "request", "", "origin_not_allowed", elapsed(), 0);
    early(403, "origin_not_allowed", "this Origin is not listed in mcp.allowed_origins");
    return;
  }

  // 2. The key.
  const std::string token = bearer_token(req, cfg_.mcp.auth_header);
  const bool standard_header = lower_ascii(cfg_.mcp.auth_header) == "authorization";
  const auto auth = mcp_keys_->authenticate(token);
  if (auth.status != McpKeyStore::AuthStatus::Ok) {
    const char* reason = auth.status == McpKeyStore::AuthStatus::Missing ? "missing" : "unknown";
    audit("-", "request", "", std::string("401_") + reason, elapsed(), 0);
    if (standard_header) res.set_header("WWW-Authenticate", "Bearer realm=\"chdash-mcp\"");
    early(401, "unauthorized", "the key is missing or unknown: send " + cfg_.mcp.auth_header + (standard_header ? ": Bearer <key>" : ": <key>"));
    return;
  }
  const McpKey& key = auth.key;
  const std::string user_agent = req.get_header_value("User-Agent");
  // A request that came with a key: its audit line, and its count in the usage of the key (mcp_usage.hpp), once its answer
  // is set (its size is counted).
  const auto account = [&](McpUsageKind kind, const std::string& what, const std::string& host, const std::string& status, uint64_t rows,
                           const McpRpcResult* result) {
    const int64_t duration = elapsed();
    audit(key.id, what, host, status, duration, rows);
    if (!mcp_usage_) return;
    McpUsageEvent event;
    event.key_id = key.id;
    event.key_name = key.name;
    event.key_host = key.hosts.size() == 1 ? std::string_view(key.hosts.front()) : std::string_view();
    event.key_source = key.source;
    event.at = now;
    event.kind = kind;
    if (result) event.method = result->method;
    if (result && result->tool_called) event.tool = result->tool;
    event.status = status;
    event.duration_ms = duration;
    event.rows = rows;
    event.bytes = res.body.size();
    if (result) {
      event.client_name = result->client_name;
      event.client_version = result->client_version;
    }
    event.user_agent = user_agent;
    mcp_usage_->record(event);
  };

  // 3. The rate limit of the key.
  int retry_after = 1;
  if (!mcp_rate_.allow(key.id, steady_ms(), cfg_.mcp.rate_limit_per_minute, &retry_after)) {
    res.set_header("Retry-After", std::to_string(retry_after));
    early(429, "rate_limited", "too many calls for this key; retry in " + std::to_string(retry_after) + " seconds");
    account(McpUsageKind::RateLimited, "request", "", "429_rate_limited", 0, nullptr);
    return;
  }

  // 4. The request itself.
  std::string type = req.get_header_value("Content-Type");
  if (const auto semi = type.find(';'); semi != std::string::npos) type.resize(semi);
  if (lower_ascii(trim_spaces(type)) != "application/json") {
    early(415, "unsupported_media_type", "the request body must be application/json");
    account(McpUsageKind::Rejected, "request", "", "415_unsupported_media_type", 0, nullptr);
    return;
  }
  const std::string version_header = trim_spaces(req.get_header_value("MCP-Protocol-Version"));
  if (!version_header.empty()) {
    const auto& supported = mcp_protocol_versions();
    if (std::find(supported.begin(), supported.end(), version_header) == supported.end()) {
      early(400, "unsupported_protocol_version", "MCP-Protocol-Version " + version_header + " is not supported");
      account(McpUsageKind::Rejected, "request", "", "400_protocol_version", 0, nullptr);
      return;
    }
  }
  // One JSON message: the SQL (at most max_sql_bytes) plus its escapes and the envelope.
  const size_t max_body = static_cast<size_t>(cfg_.mcp.max_sql_bytes) * 2 + 16 * 1024;
  const std::string length_header = req.get_header_value("Content-Length");
  const bool length_is_number = !length_header.empty() && length_header.size() < 19 &&
      std::all_of(length_header.begin(), length_header.end(), [](char c) { return c >= '0' && c <= '9'; });
  if (length_is_number && std::stoull(length_header) > max_body) {
    early(413, "payload_too_large", "the request body is larger than " + std::to_string(max_body) + " bytes");
    account(McpUsageKind::Rejected, "request", "", "413_too_large", 0, nullptr);
    return;
  }
  std::string body;
  bool too_large = false;
  const bool read_ok = reader([&](const char* data, size_t length) {
    if (body.size() + length > max_body) {
      too_large = true;
      return false;
    }
    body.append(data, length);
    return true;
  });
  if (too_large) {
    early(413, "payload_too_large", "the request body is larger than " + std::to_string(max_body) + " bytes");
    account(McpUsageKind::Rejected, "request", "", "413_too_large", 0, nullptr);
    return;
  }
  if (!read_ok) {
    early(400, "bad_request", "the request body could not be read");
    account(McpUsageKind::Rejected, "request", "", "400_unreadable", 0, nullptr);
    return;
  }

  // 5. The message.
  McpServerInfo info;
  info.version = cfg_.version_semver;
  McpRpcResult result = mcp_handle_message(body, key, *mcp_tools_, info, now, version_header);
  res.status = result.http_status;
  if (result.http_status == 202) {
    res.set_content("", 0, "application/json");
  } else {
    // The body can be as large as max_result_bytes: it moves into the answer.
    res.set_content(std::move(result.body), "application/json");
  }
  std::string what = result.method.empty() ? "request" : result.method;
  if (result.tool_called) what = "tools/call:" + result.tool;
  std::string status = "ok";
  if (result.rpc_error != 0) status = "rpc_error_" + std::to_string(-result.rpc_error);
  else if (result.tool_called && result.outcome.is_error) status = result.outcome.error_code;
  account(result.tool_called ? McpUsageKind::ToolCall : McpUsageKind::Request, what, result.outcome.host, status, result.outcome.rows, &result);
}

// ---- /api/mcp/* -----------------------------------------------------------------------------------

void Server::handle_api_mcp(const httplib::Request& req, httplib::Response& res, McpApiRoute route) {
  const int64_t now = unix_seconds();
  set_no_store(res);

  if (route == McpApiRoute::Meta) {
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("enabled"); w.Bool(cfg_.mcp.enabled && mcp_keys_ != nullptr);
    if (cfg_.mcp.enabled && mcp_keys_) {
      const McpSettings& s = cfg_.mcp;
      w.Key("endpoint_path"); w.String("/mcp");
      w.Key("auth_header"); put(w, s.auth_header);
      w.Key("storage_configured"); w.Bool(mcp_keys_->storage_configured());
      w.Key("manage_from_ui"); w.Bool(mcp_keys_->manage_from_ui());
      w.Key("can_manage"); w.Bool(mcp_keys_->can_manage());
      w.Key("protocol_versions");
      w.StartArray();
      for (const auto& version : mcp_protocol_versions()) put(w, version);
      w.EndArray();
      const HostsSnapshot health = health_ ? health_->snapshot() : HostsSnapshot{};
      w.Key("hosts");
      w.StartArray();
      for (const auto& host : cfg_.hosts) {
        if (host.mcp_uri.empty()) continue;
        w.StartObject();
        w.Key("name"); put(w, host.id);
        w.Key("label"); put(w, host.label);
        w.Key("healthy");
        bool known = false;
        const HostAccess* access = nullptr;
        for (const auto& item : health.hosts) {
          if (item.id != host.id) continue;
          access = &item.access;
          if (item.checked_at_ms > 0) {
            w.Bool(item.healthy);
            known = true;
          }
        }
        if (!known) w.Null();
        // The MCP user of the host: "ok" (it connects), "unavailable" (it does not: no key can read this host) or
        // "unknown" (not audited yet, or the host is down). The tools that it cannot serve come with the grant
        // that is missing: the page greys them and the API refuses them (mcp_grants.hpp).
        w.Key("mcp");
        w.StartObject();
        const bool audited = access && access->mcp_audited;
        w.Key("user"); put(w, access ? access->mcp_user : std::string());
        w.Key("state"); w.String(!audited ? "unknown" : access->mcp_connected ? "ok" : "unavailable");
        w.Key("error"); put(w, access ? access->mcp_error : std::string());
        w.Key("reads_nothing"); w.Bool(audited && access->mcp_connected && access->mcp_reads_nothing);
        // The settings profile of the MCP user, and what a key of this host can ask for at most (and what binds it).
        w.Key("profile");
        w.StartObject();
        const bool profiled = access && access->mcp_audited && access->mcp_profile_known;
        w.Key("known"); w.Bool(profiled);
        w.Key("readonly"); w.Uint64(profiled ? access->mcp_readonly : 0);
        w.Key("max_execution_time"); w.Double(profiled ? access->mcp_max_execution_time : 0);
        w.Key("max_result_rows"); w.Uint64(profiled ? access->mcp_max_result_rows : 0);
        w.EndObject();
        const McpHostLimits caps = mcp_host_limits(s, access);
        w.Key("limits");
        w.StartObject();
        w.Key("max_rows");
        w.StartObject();
        w.Key("value"); w.Int64(caps.max_rows.value);
        w.Key("source"); w.String(caps.max_rows.source);
        w.EndObject();
        w.Key("timeout_seconds");
        w.StartObject();
        w.Key("value"); w.Int64(caps.timeout_seconds.value);
        w.Key("source"); w.String(caps.timeout_seconds.source);
        w.EndObject();
        w.EndObject();
        w.Key("unavailable_tools");
        w.StartArray();
        if (access) {
          for (const auto& gap : mcp_tool_gaps(host.otel, *access)) {
            w.StartObject();
            w.Key("tool"); put(w, gap.tool);
            w.Key("role"); put(w, gap.role);
            w.Key("user"); put(w, gap.user);
            w.Key("grants");
            w.StartArray();
            for (const auto& grant : gap.grants) put(w, grant);
            w.EndArray();
            w.Key("statement"); put(w, mcp_grant_statement(gap.grants, gap.user));
            w.EndObject();
          }
        }
        w.EndArray();
        w.EndObject();
        w.EndObject();
      }
      w.EndArray();
      w.Key("tool_groups");
      w.StartArray();
      for (const auto& group : mcp_tool_groups()) {
        w.StartObject();
        w.Key("id"); put(w, group.id);
        w.Key("title"); put(w, group.title);
        w.Key("note"); put(w, group.note);
        // The sub-headings of the card of the family, in the order of the page.
        w.Key("sections");
        w.StartArray();
        for (const auto& section : mcp_tool_sections()) {
          if (std::string(section.group) != group.id) continue;
          w.StartObject();
          w.Key("id"); put(w, section.id);
          w.Key("title"); put(w, section.title);
          w.EndObject();
        }
        w.EndArray();
        w.EndObject();
      }
      w.EndArray();
      // The catalog with how each tool is given: `always` (every key has it, whatever its list says), `explicit_only` ("*" does not give it) and
      // `available` (the configuration offers it now: the tools of the usage need the usage, the one of all the keys needs mcp.usage.all_keys too).
      const McpToolAvailability availability = mcp_tool_availability();
      w.Key("tools");
      w.StartArray();
      for (const auto& tool : mcp_tool_catalog()) {
        w.StartObject();
        w.Key("name"); put(w, tool.name);
        w.Key("group"); put(w, tool.group);
        w.Key("section"); put(w, tool.section ? tool.section : "");
        w.Key("description"); put(w, tool.description);
        w.Key("needs_all_data"); w.Bool(tool.needs_all_data);
        w.Key("always"); w.Bool(tool.always);
        w.Key("explicit_only"); w.Bool(tool.explicit_only);
        w.Key("available"); w.Bool(mcp_tool_available(tool, availability));
        w.EndObject();
      }
      w.EndArray();
      w.Key("limits");
      w.StartObject();
      w.Key("max_rows"); w.Int64(s.max_rows);
      w.Key("max_result_bytes"); w.Int64(s.max_result_bytes);
      w.Key("query_timeout_seconds"); w.Int64(s.query_timeout_seconds);
      w.Key("max_sql_bytes"); w.Int64(s.max_sql_bytes);
      w.Key("max_memory_bytes"); w.Int64(s.max_memory_bytes);
      w.Key("max_rows_to_read"); w.Int64(s.max_rows_to_read);
      w.Key("rate_limit_per_minute"); w.Int64(s.rate_limit_per_minute);
      w.EndObject();
      w.Key("name_pattern"); w.String(kMcpNamePattern);
      // The usage of the keys (mcp_usage.hpp): off, or kept in files by instance (mcp.usage), and the windows of its answers.
      w.Key("usage");
      w.StartObject();
      w.Key("enabled"); w.Bool(mcp_usage_ != nullptr);
      if (mcp_usage_) {
        const McpUsageSettings& usage = s.usage;
        w.Key("storage"); put(w, usage.storage);
        w.Key("instance"); put(w, mcp_usage_->instance());
        w.Key("retention_days"); w.Int64(usage.retention_days);
        w.Key("windows");
        w.StartArray();
        for (const auto& window : mcp_usage_windows(usage.retention_days)) put(w, window);
        w.EndArray();
        w.Key("default_window"); put(w, mcp_usage_default_window(usage.retention_days));
        w.Key("since"); put(w, mcp_iso_utc(mcp_usage_->since()));
      }
      // The windows of the ClickHouse cost of a key (api_mcp_cost.cpp): none when System > Queries is off (it reads query_log the same way).
      w.Key("cost_windows");
      w.StartArray();
      if (cfg_.system.top_queries_enabled()) {
        for (const auto& window : mcp_cost_windows()) put(w, window);
      }
      w.EndArray();
      // Whether a key can read the usage of all the keys (the tool mcp_analysis_all_usage): the usage must be on.
      if (mcp_usage_) {
        w.Key("all_keys"); w.Bool(s.usage.all_keys);
      }
      w.EndObject();
    }
    w.EndObject();
    api_ok(res, 200, sb);
    return;
  }

  if (!cfg_.mcp.enabled || !mcp_keys_) {
    api_error(res, 404, "mcp_disabled", "MCP is disabled");
    return;
  }
  McpKeyStore& store = *mcp_keys_;

  const auto write_key_response = [&](int status, const McpKeyStore::Result& result, bool with_secret) {
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("key");
    mcp_write_key(w, *result.key, std::nullopt);
    if (with_secret) {
      w.Key("secret");
      put(w, result.secret);
    }
    w.EndObject();
    api_ok(res, status, sb);
  };
  const auto write_failure = [&](const McpKeyStore::Result& result) {
    api_error(res, result.status, result.error, result.message, result.field, result.reason);
  };

  if (route == McpApiRoute::KeysList) {
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("keys");
    w.StartArray();
    // When a key was last used is its usage's (all the instances): none when the usage is off.
    const auto last_used = mcp_usage_ ? mcp_usage_->last_used_all() : std::unordered_map<std::string, int64_t>{};
    for (const auto& key : store.list()) {
      const auto used = last_used.find(key.id);
      mcp_write_key(w, key, used == last_used.end() ? std::nullopt : std::optional<int64_t>(used->second));
    }
    w.EndArray();
    w.EndObject();
    api_ok(res, 200, sb);
    return;
  }

  if (!allow_from_page(req, res)) return;
  // What the key reaches: the tables that the MCP user of each host may read, cut by the patterns of the key.
  if (route == McpApiRoute::AccessSummary) {
    // One answer for the table of the page: for each key, how many databases and tables it reaches (what the MCP user of its
    // host may read, cut by the patterns of the key). The grants of a host are read once and kept 60 s, whatever the keys.
    const bool refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
    std::vector<const HostSpec*> hosts;
    for (const auto& key : store.list()) {
      const HostSpec* host = key.hosts.size() == 1 ? find_host(cfg_.hosts, key.hosts.front()) : nullptr;
      if (host && !host->mcp_uri.empty()) hosts.push_back(host);
    }
    const std::map<std::string, McpReadable> readable_by_host = mcp_readable_by_host(acl_, client_pool_, hosts, refresh);
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("keys");
    w.StartArray();
    for (const auto& key : store.list()) {
      w.StartObject();
      w.Key("id"); put(w, key.id);
      const HostSpec* host = key.hosts.size() == 1 ? find_host(cfg_.hosts, key.hosts.front()) : nullptr;
      if (!host || host->mcp_uri.empty()) {
        w.Key("status"); w.String("no_host");
        w.EndObject();
        continue;
      }
      const McpReadable& readable = readable_by_host.at(host->id);
      if (!readable.objects) {
        w.Key("status"); w.String("unavailable");
        w.Key("error"); put(w, readable.error);
        w.EndObject();
        continue;
      }
      std::set<std::string> databases;
      size_t tables = 0;
      size_t partial = 0;
      for (const auto& table : readable.objects->tables()) {
        if (!mcp_scope_table_allowed(key.databases, table.database, table.table)) continue;
        databases.insert(table.database);
        ++tables;
        if (!table.all_columns) ++partial;
      }
      w.Key("status"); w.String("ok");
      w.Key("host"); put(w, host->id);
      w.Key("user"); put(w, readable.user);
      w.Key("databases"); w.Uint64(databases.size());
      w.Key("tables"); w.Uint64(tables);
      w.Key("partial_tables"); w.Uint64(partial);
      w.Key("truncated"); w.Bool(readable.truncated);
      w.Key("all_data"); w.Bool(mcp_scope_all_data(key.databases));
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    audit("-", "keys/access-summary", "", "ok", 0, 0);
    api_ok(res, 200, sb);
    return;
  }

  if (route == McpApiRoute::KeyAccess) {
    const std::string wanted = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
    std::optional<McpKey> found;
    for (const auto& key : store.list()) {
      if (key.id == wanted) found = key;
    }
    if (!found) return api_error(res, 404, "not_found", "no such key");
    const McpKey& key = *found;
    const bool refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
    std::vector<std::string> available;
    for (const auto& host : cfg_.hosts) {
      if (!host.mcp_uri.empty()) available.push_back(host.id);
    }
    constexpr size_t kTablesPerDatabase = 300;
    constexpr size_t kTablesInAll = 3000;
    size_t listed = 0;
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("id"); put(w, key.id);
    w.Key("name"); put(w, key.name);
    w.Key("all_data"); w.Bool(mcp_scope_all_data(key.databases));
    w.Key("databases");
    w.StartArray();
    for (const auto& pattern : key.databases) put(w, pattern);
    w.EndArray();
    std::vector<const HostSpec*> hosts;
    for (const auto& host_id : mcp_scope_hosts(key.hosts, available)) {
      if (const HostSpec* host = find_host(cfg_.hosts, host_id)) hosts.push_back(host);
    }
    const std::map<std::string, McpReadable> readable_by_host = mcp_readable_by_host(acl_, client_pool_, hosts, refresh);
    w.Key("hosts");
    w.StartArray();
    for (const HostSpec* host : hosts) {
      const McpReadable& readable = readable_by_host.at(host->id);
      w.StartObject();
      w.Key("host"); put(w, host->id);
      w.Key("label"); put(w, host->label);
      w.Key("user"); put(w, readable.user);
      if (!readable.objects) {
        w.Key("status"); w.String("unavailable");
        w.Key("error"); put(w, readable.error);
        w.EndObject();
        continue;
      }
      w.Key("status"); w.String("ok");
      // database -> the tables of the user that the key's patterns allow
      std::map<std::string, std::vector<const AllowedTable*>> by_database;
      size_t readable_total = 0;
      size_t excluded = 0;
      for (const auto& table : readable.objects->tables()) {
        ++readable_total;
        if (!mcp_scope_table_allowed(key.databases, table.database, table.table)) {
          ++excluded;
          continue;
        }
        by_database[table.database].push_back(&table);
      }
      w.Key("readable_by_user"); w.Uint64(readable_total);
      // A bound of the privilege discovery stopped it: the tables that were not checked are not counted.
      w.Key("acl_truncated"); w.Bool(readable.truncated);
      w.Key("excluded_by_key"); w.Uint64(excluded);
      w.Key("databases");
      w.StartArray();
      for (auto& [database, tables] : by_database) {
        std::sort(tables.begin(), tables.end(), [](const AllowedTable* a, const AllowedTable* b) { return a->table < b->table; });
        w.StartObject();
        w.Key("name"); put(w, database);
        w.Key("table_count"); w.Uint64(tables.size());
        bool truncated = tables.size() > kTablesPerDatabase;
        w.Key("tables");
        w.StartArray();
        for (size_t i = 0; i < tables.size() && i < kTablesPerDatabase; ++i) {
          if (listed >= kTablesInAll) {
            truncated = true;
            break;
          }
          ++listed;
          w.StartObject();
          w.Key("name"); put(w, tables[i]->table);
          // "some": the user reads some columns only (the columns are checked when a tool opens the table).
          w.Key("columns");
          w.String(tables[i]->all_columns ? "all" : "some");
          w.EndObject();
        }
        w.EndArray();
        w.Key("truncated"); w.Bool(truncated);
        w.EndObject();
      }
      w.EndArray();
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    audit("-", "keys/access", "", "ok:" + key.id, 0, 0);
    api_ok(res, 200, sb);
    return;
  }
  // What the keys did (mcp_usage.hpp): every key in one answer (the Used column of the page), one key (its details), and every
  // key cut by key, method, client, instance, result and type (the Usage tab), in a window of the usage, with every instance summed. A read
  // of the page, as the access above; it never holds SQL, data, a secret or an address. Off (mcp.usage.enabled): 404 not_enabled.
  if (route == McpApiRoute::Usage || route == McpApiRoute::KeyUsage || route == McpApiRoute::UsageOverview) {
    if (!mcp_usage_) return api_error(res, 404, "not_enabled", "the usage of the keys is off: mcp.usage.enabled");
    const int64_t retention = cfg_.mcp.usage.retention_days;
    const std::string asked = req.has_param("window") ? req.get_param_value("window") : std::string();
    const auto window = mcp_usage_window(asked.empty() ? mcp_usage_default_window(retention) : asked, retention, now);
    if (!window) {
      std::string names;
      for (const auto& name : mcp_usage_windows(retention)) names += (names.empty() ? "" : ", ") + name;
      return api_error(res, 400, "validation", "window must be one of " + names, "window", "invalid");
    }
    std::vector<McpUsageKeyRef> live;
    for (const auto& key : store.list()) live.push_back(mcp_usage_key_ref(key));
    rapidjson::StringBuffer sb;
    Writer w(sb);
    if (route == McpApiRoute::Usage) {
      mcp_usage_->write_list(w, live, *window, now);
      audit("-", "keys/usage-summary", "", "ok", 0, 0);
    } else if (route == McpApiRoute::UsageOverview) {
      McpUsageOverviewQuery query;
      if (const auto error = read_usage_overview_query(req, &query)) {
        return api_error(res, 400, "validation", error->message, error->field, error->reason);
      }
      mcp_usage_->write_overview(w, query, live, *window, now);
      audit("-", "keys/usage-overview", "", "ok", 0, 0);
    } else {
      const std::string wanted = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
      const McpUsageKeyRef* key = nullptr;
      for (const auto& item : live) {
        if (item.id == wanted) key = &item;
      }
      // A deleted key answers as long as its usage is kept.
      if (!mcp_usage_->write_detail(w, wanted, key, *window, now)) return api_error(res, 404, "not_found", "no such key");
      audit("-", "keys/usage", "", "ok:" + wanted, 0, 0);
    }
    api_ok(res, 200, sb);
    return;
  }
  // What the statements of a key cost ClickHouse, read from system.query_log of its host (api_mcp_cost.cpp): a read of the page too.
  if (route == McpApiRoute::KeyCost) return handle_mcp_key_cost(req, res, now);
  if (!store.manage_from_ui()) {
    api_error(res, 403, "manage_disabled", "keys are managed in the configuration (mcp.manage_from_ui = false)");
    return;
  }
  if (route == McpApiRoute::KeyCreate && req.body.size() > 256 * 1024) {
    api_error(res, 413, "payload_too_large", "the request body is too large");
    return;
  }
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();

  switch (route) {
    case McpApiRoute::KeyCreate: {
      McpKeyInput input;
      if (const auto err = mcp_parse_key_input(req.body, &input)) {
        api_error(res, 400, "validation", err->message, err->field, err->reason);
        return;
      }
      // A key can lower the limits of its host and never raise them: the limit of the MCP user's profile counts as the configuration's.
      const HostsSnapshot health = health_ ? health_->snapshot() : HostsSnapshot{};
      for (const auto& host_name : input.hosts.value_or(std::vector<std::string>{})) {
        const HostAccess* access = nullptr;
        for (const auto& item : health.hosts) {
          if (item.id == host_name) access = &item.access;
        }
        const McpHostLimits caps = mcp_host_limits(cfg_.mcp, access);
        const auto refuse = [&](const char* field, int64_t asked, const McpHostLimit& cap, const char* what) -> bool {
          if (asked <= cap.value) return false;
          const std::string by = std::string(cap.source) == "clickhouse" ? "the ClickHouse user of the host (its settings profile)" : "the MCP configuration";
          api_error(res, 400, "validation", std::string(field) + " must be between 1 and " + std::to_string(cap.value) + ": " + what + " is limited by " + by,
                    field, "range");
          return true;
        };
        if (input.max_rows && refuse("max_rows", *input.max_rows, caps.max_rows, "the number of rows")) return;
        if (input.timeout_seconds && refuse("timeout_seconds", *input.timeout_seconds, caps.timeout_seconds, "the time of a query")) return;
      }
      const auto result = store.create(input, now);
      if (!result.key) return write_failure(result);
      audit("-", "keys/create", "", "ok:" + result.key->id, 0, 0);
      write_key_response(201, result, true);
      return;
    }
    case McpApiRoute::KeyDelete: {
      const auto result = store.remove(id);
      if (!result.key) return write_failure(result);
      // Its usage stays until it is older than mcp.usage.retention_days.
      if (mcp_usage_) mcp_usage_->mark_deleted(mcp_usage_key_ref(*result.key), now);
      audit("-", "keys/delete", "", "ok:" + id, 0, 0);
      rapidjson::StringBuffer sb;
      Writer w(sb);
      w.StartObject();
      w.Key("ok"); w.Bool(true);
      w.Key("id"); put(w, id);
      w.EndObject();
      api_ok(res, 200, sb);
      return;
    }
    case McpApiRoute::Meta:
    case McpApiRoute::KeysList:
    case McpApiRoute::KeyAccess:
    case McpApiRoute::AccessSummary:
    case McpApiRoute::Usage:
    case McpApiRoute::KeyUsage:
    case McpApiRoute::UsageOverview:
    case McpApiRoute::KeyCost:
      break;
  }
  api_error(res, 404, "not_found", "unknown MCP route");
}

} // namespace chdash
