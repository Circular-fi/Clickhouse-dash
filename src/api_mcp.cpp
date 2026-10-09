// MCP endpoint (POST /mcp) and the REST routes of the MCP page (/api/mcp/*).
// See docs/mcp.md. The endpoint exists only when mcp.enabled = true.
//
// Every query of a tool runs through the client pool with the host's mcp_uri
// identity (never runner_uri or system_uri), with readonly=1 and the caps of
// the configuration. This file never logs SQL or row data.

#include "server.hpp"

#include "allowed_objects.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "json_clickhouse.hpp"
#include "mcp_grants.hpp"
#include "mcp_identity.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <system_error>

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

void put(Writer& w, std::string_view s) { w.String(s.data(), static_cast<rapidjson::SizeType>(s.size())); }

// {"error": code, "message": text} and, for a validation error, "field" and "reason".
void api_error(httplib::Response& res, int status, const std::string& code, const std::string& message,
               const std::string& field = {}, const std::string& reason = {}) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("error"); put(w, code);
  w.Key("message"); put(w, message);
  if (!field.empty() || !reason.empty()) {
    w.Key("field"); put(w, field);
    w.Key("reason"); put(w, reason);
  }
  w.EndObject();
  res.status = status;
  set_no_store(res);
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

void api_ok(httplib::Response& res, int status, const rapidjson::StringBuffer& sb) {
  res.status = status;
  set_no_store(res);
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

std::string origin_authority(const std::string& origin) {
  const auto scheme = origin.find("://");
  if (scheme == std::string::npos) return {};
  std::string authority = origin.substr(scheme + 3);
  const auto slash = authority.find('/');
  if (slash != std::string::npos) authority.resize(slash);
  return lower_ascii(authority);
}

// Cross-site guard of the key routes: the same rule as the query library's
// (api_query_library.cpp). ChDash has no login, so a write only needs protecting
// from a third-party page that drives the user's browser:
// - Sec-Fetch-Site, set by the browser, must be absent, same-origin or none;
// - without it, an Origin header must name this server (Host or X-Forwarded-Host);
// - a body must be application/json, which a cross-origin page cannot send without a CORS preflight.
bool allow_mutation(const httplib::Request& req, httplib::Response& res, bool has_body) {
  const std::string site = lower_ascii(trim_spaces(req.get_header_value("Sec-Fetch-Site")));
  if (!site.empty() && site != "same-origin" && site != "none") {
    api_error(res, 403, "cross_site_request", "MCP key changes are accepted from the ChDash page only");
    return false;
  }
  const std::string origin = trim_spaces(req.get_header_value("Origin"));
  if (site.empty() && !origin.empty()) {
    const std::string authority = origin_authority(origin);
    const std::string host = lower_ascii(trim_spaces(req.get_header_value("Host")));
    std::string forwarded = req.get_header_value("X-Forwarded-Host");
    if (const auto comma = forwarded.find(','); comma != std::string::npos) forwarded.resize(comma);
    forwarded = lower_ascii(trim_spaces(forwarded));
    if (authority.empty() || (authority != host && authority != forwarded)) {
      api_error(res, 403, "cross_site_request", "MCP key changes are accepted from the ChDash page only");
      return false;
    }
  }
  if (has_body) {
    std::string type = req.get_header_value("Content-Type");
    if (const auto semi = type.find(';'); semi != std::string::npos) type.resize(semi);
    if (lower_ascii(trim_spaces(type)) != "application/json") {
      api_error(res, 415, "unsupported_media_type", "the request body must be application/json");
      return false;
    }
  }
  return true;
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
  const std::string header = trim_spaces(req.get_header_value(header_name));
  const bool bearer = header.size() >= 8 && lower_ascii(header.substr(0, 7)) == "bearer ";
  if (bearer) return trim_spaces(std::string_view(header).substr(7));
  if (lower_ascii(header_name) == "authorization") return {};
  return header;
}

// ---- what a key reaches ---------------------------------------------------------------------

// The objects that the MCP ClickHouse user of a host may read (CHECK GRANT, never SHOW GRANTS), kept 60 s: the
// answer costs one check for each table of a database that is not granted whole.
struct McpReadable {
  std::shared_ptr<const AllowedObjectSet> objects;
  std::string user;
  std::string error;
};

McpReadable mcp_readable_objects(const std::shared_ptr<ClickHouseClientPool>& pool, const HostSpec& host, bool refresh) {
  struct Entry {
    std::chrono::steady_clock::time_point at;
    McpReadable value;
  };
  static std::mutex mutex;
  static std::map<std::string, Entry> cache;
  const auto now = std::chrono::steady_clock::now();
  const std::string key = host.id + '\x1f' + host.mcp_uri;
  if (!refresh) {
    std::lock_guard<std::mutex> lock(mutex);
    const auto it = cache.find(key);
    if (it != cache.end() && now - it->second.at < std::chrono::seconds(60)) return it->second.value;
  }
  McpReadable out;
  if (const auto parsed = parse_clickhouse_uri(host.mcp_uri, nullptr)) out.user = parsed->user;
  std::string error;
  auto client = pool ? pool->acquire(host.mcp_uri, std::chrono::seconds(5), std::chrono::seconds(20), std::chrono::seconds(20), &error)
                     : make_client_from_uri(host.mcp_uri, std::chrono::seconds(5), std::chrono::seconds(20), std::chrono::seconds(20), &error);
  if (!client) {
    out.error = error.empty() ? "cannot connect to ClickHouse as the MCP user" : error;
  } else {
    try {
      out.objects = std::make_shared<const AllowedObjectSet>(discover_allowed_objects(*client));
    } catch (const std::exception& e) {
      out.error = e.what();
      if (pool) pool->invalidate(client);
    }
  }
  std::lock_guard<std::mutex> lock(mutex);
  if (cache.size() > 64) cache.clear();
  cache[key] = Entry{now, out};
  return out;
}

// ---- the ClickHouse side -------------------------------------------------------------------

// Bytes of a cell on the native wire, close enough to ClickHouse's own count of the result size:
// the fixed-width types by their width, the rest by the length of their JSON text.
uint64_t native_cell_bytes(const clickhouse::ColumnRef& column, uint64_t json_length) {
  using Code = clickhouse::Type::Code;
  switch (column->Type()->GetCode()) {
    case Code::Int8: case Code::UInt8: case Code::Enum8: return 1;
    case Code::Int16: case Code::UInt16: case Code::Enum16: case Code::Date: return 2;
    case Code::Int32: case Code::UInt32: case Code::Float32: case Code::Date32: case Code::DateTime: case Code::IPv4: return 4;
    case Code::Int64: case Code::UInt64: case Code::Float64: case Code::DateTime64: return 8;
    case Code::UUID: case Code::Int128: case Code::UInt128: case Code::IPv6: return 16;
    default: return json_length;
  }
}

std::string error_code_of(int clickhouse_code) {
  switch (clickhouse_code) {
    case 159: return "timeout";            // TIMEOUT_EXCEEDED
    case 497: return "permission_denied";  // ACCESS_DENIED
    case 164: return "readonly";           // READONLY
    case 241: return "memory_limit";       // MEMORY_LIMIT_EXCEEDED
    case 158:                              // TOO_MANY_ROWS
    case 307: return "read_limit";         // TOO_MANY_BYTES
    case 60:                               // UNKNOWN_TABLE
    case 81: return "not_found";           // UNKNOWN_DATABASE
    case 62: return "syntax_error";        // SYNTAX_ERROR
    case 394: return "cancelled";          // QUERY_WAS_CANCELLED
    default: return "query_failed";
  }
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

    clickhouse::Query query(sql);
    const auto set = [&query](const char* name, const std::string& value) {
      clickhouse::QuerySettingsField field;
      field.value = value;
      query.SetSetting(name, field);
    };
    // The settings are applied together; readonly=1 first in meaning: from here the SQL cannot change anything,
    // nor any of the limits below.
    set("readonly", "1");
    set("max_execution_time", std::to_string(limits.timeout_seconds));
    set("max_result_rows", std::to_string(limits.max_rows + 1));
    set("result_overflow_mode", "break");
    set("max_result_bytes", std::to_string(limits.max_bytes));
    set("max_memory_usage", std::to_string(limits.max_memory_bytes));
    set("max_query_size", std::to_string(std::max<int64_t>(262144, static_cast<int64_t>(sql.size()) + 1024)));
    if (limits.max_rows_to_read > 0) set("max_rows_to_read", std::to_string(limits.max_rows_to_read));
    set("log_comment", "chdash-mcp key=" + limits.key_id);

    McpDbResult result;
    bool done = false;
    uint64_t json_bytes = 0;
    uint64_t native_bytes = 0;
    rapidjson::StringBuffer cell_buffer;
    rapidjson::Writer<rapidjson::StringBuffer> cell_writer(cell_buffer);
    const uint64_t max_rows = static_cast<uint64_t>(limits.max_rows);
    const uint64_t max_bytes = static_cast<uint64_t>(limits.max_bytes);

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
      client->Execute(query);
    } catch (const clickhouse::ServerException& error) {
      // A cut query ends with "cancelled" on some servers: the rows we kept are the answer.
      if (!(done && error.GetCode() == 394)) {
        throw McpDbError(error_code_of(error.GetCode()), error.what());
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
    // ClickHouse itself may have stopped at max_result_bytes (result_overflow_mode = break).
    if (native_bytes >= max_bytes) result.truncated = true;
    return result;
  }

  std::optional<bool> host_healthy(const std::string& host) override { return health_ ? health_(host) : std::nullopt; }

private:
  std::shared_ptr<ClickHouseClientPool> pool_;
  std::vector<HostSpec> hosts_;
  int64_t timeout_cap_;
  HealthFn health_;
};

// A query string part: everything but the unreserved characters is %XX.
std::string percent_encode(std::string_view text) {
  static const char hex[] = "0123456789ABCDEF";
  std::string out;
  for (const unsigned char c : text) {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back(static_cast<char>(c));
    } else {
      out.push_back('%');
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 15]);
    }
  }
  return out;
}

// The API tools call the API of ChDash through its own listening port. Each call holds a thread of the
// server while it waits for another: at most kLoopbackCalls at once, so MCP can never use the whole pool.
class LoopbackMcpApi : public McpApiClient {
public:
  explicit LoopbackMcpApi(int port) : port_(port) {}

  McpApiResponse call(const McpApiRequest& request) override {
    McpApiResponse out;
    if (in_flight_.fetch_add(1) >= kLoopbackCalls) {
      in_flight_.fetch_sub(1);
      out.error = "too many API calls at once through MCP: retry in a moment";
      return out;
    }
    struct Release {
      std::atomic<int>& n;
      ~Release() { n.fetch_sub(1); }
    } release{in_flight_};

    httplib::Client client("127.0.0.1", port_);
    const time_t seconds = static_cast<time_t>(std::max<int64_t>(1, request.timeout_seconds));
    client.set_connection_timeout(2, 0);
    client.set_read_timeout(seconds, 0);
    client.set_write_timeout(seconds, 0);
    client.set_keep_alive(false);
    std::string target = request.path;
    char separator = '?';
    for (const auto& [name, value] : request.query) {
      target += separator;
      target += percent_encode(name) + "=" + percent_encode(value);
      separator = '&';
    }
    // The token of the process lets the call name the MCP identities of a host (mcp_identity.hpp).
    const httplib::Headers headers = {{"Accept", "application/json"}, {"X-ChDash-Caller", "mcp"}, {kMcpInternalHeader, mcp_internal_token()}};
    httplib::Result result = request.method == "POST" ? client.Post(target, headers, request.body, "application/json")
                                                       : client.Get(target, headers);
    if (!result) {
      out.error = std::string("the API of ChDash did not answer: ") + httplib::to_string(result.error());
      return out;
    }
    out.status = result->status;
    if (static_cast<int64_t>(result->body.size()) > request.max_bytes) {
      out.too_large = true;
      return out;
    }
    out.body = std::move(result->body);
    return out;
  }

private:
  static constexpr int kLoopbackCalls = 4;
  int port_;
  std::atomic<int> in_flight_{0};
};

// One audit line per call: who, what, where, how long, how it ended. Never SQL, never data.
void audit(const std::string& key, const std::string& what, const std::string& host, const std::string& status,
           int64_t duration_ms, uint64_t rows) {
  std::cerr << "[mcp] key=" << key << " call=" << what << " host=" << (host.empty() ? "-" : host)
            << " status=" << status << " duration_ms=" << duration_ms << " rows=" << rows << std::endl;
}

} // namespace

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
    if (!host) return std::nullopt;
    const HostAccess& access = host->access;
    const std::string user = access.mcp_user.empty() ? std::string("<user>") : access.mcp_user;
    if (access.mcp_audited && !access.mcp_connected) {
      return McpValidationError{"hosts", "mcp_user_unavailable",
                                "the MCP user " + user + " cannot connect to host " + host->id + ": " + access.mcp_error};
    }
    for (const auto& gap : mcp_tool_gaps(cfg_, access)) {
      if (std::find(key.tools.begin(), key.tools.end(), gap.tool) == key.tools.end()) continue;
      return McpValidationError{"tools", "not_grantable",
                                "tool " + gap.tool + " cannot be served: the " + gap.role + " " + gap.user + " lacks " + gap.grants.front() +
                                    (gap.grants.size() > 1 ? " and more" : "") + ". " + mcp_grant_statement(gap.grants, gap.user)};
    }
    return std::nullopt;
  };
  mcp_keys_ = std::make_unique<McpKeyStore>(std::move(store));

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
  // Where the OpenTelemetry data lives: the same settings that the Observability pages read.
  tools.observability = mcp_observability_config(cfg_);
  int port = 8080;
  if (const auto pos = cfg_.listen.rfind(':'); pos != std::string::npos) {
    try {
      port = std::stoi(cfg_.listen.substr(pos + 1));
    } catch (const std::exception&) {
    }
  }
  mcp_api_ = std::make_unique<LoopbackMcpApi>(port);
  mcp_tools_ = std::make_unique<McpTools>(std::move(tools), *mcp_db_, mcp_api_.get());
}

// ---- POST /mcp ----------------------------------------------------------------------------------

void Server::handle_mcp_not_allowed(const httplib::Request&, httplib::Response& res) {
  res.set_header("Allow", "POST");
  api_error(res, 405, "method_not_allowed", "the MCP endpoint answers POST only (single JSON responses, no stream)");
}

void Server::handle_mcp_post(const httplib::Request& req, httplib::Response& res, const httplib::ContentReader& reader) {
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
  const auto auth = mcp_keys_->authenticate(token, now);
  if (auth.status != McpKeyStore::AuthStatus::Ok) {
    const char* reason = auth.status == McpKeyStore::AuthStatus::Missing ? "missing" : "unknown";
    audit("-", "request", "", std::string("401_") + reason, elapsed(), 0);
    if (standard_header) res.set_header("WWW-Authenticate", "Bearer realm=\"chdash-mcp\"");
    early(401, "unauthorized", "the key is missing or unknown: send " + cfg_.mcp.auth_header + (standard_header ? ": Bearer <key>" : ": <key>"));
    return;
  }
  const McpKey& key = auth.key;

  // 3. The rate limit of the key.
  int retry_after = 1;
  if (!mcp_rate_.allow(key.id, steady_ms(), cfg_.mcp.rate_limit_per_minute, &retry_after)) {
    audit(key.id, "request", "", "429_rate_limited", elapsed(), 0);
    res.set_header("Retry-After", std::to_string(retry_after));
    early(429, "rate_limited", "too many calls for this key; retry in " + std::to_string(retry_after) + " seconds");
    return;
  }

  // 4. The request itself.
  std::string type = req.get_header_value("Content-Type");
  if (const auto semi = type.find(';'); semi != std::string::npos) type.resize(semi);
  if (lower_ascii(trim_spaces(type)) != "application/json") {
    audit(key.id, "request", "", "415_unsupported_media_type", elapsed(), 0);
    early(415, "unsupported_media_type", "the request body must be application/json");
    return;
  }
  const std::string version_header = trim_spaces(req.get_header_value("MCP-Protocol-Version"));
  if (!version_header.empty()) {
    const auto& supported = mcp_protocol_versions();
    if (std::find(supported.begin(), supported.end(), version_header) == supported.end()) {
      audit(key.id, "request", "", "400_protocol_version", elapsed(), 0);
      early(400, "unsupported_protocol_version", "MCP-Protocol-Version " + version_header + " is not supported");
      return;
    }
  }
  // One JSON message: the SQL (at most max_sql_bytes) plus its escapes and the envelope.
  const size_t max_body = static_cast<size_t>(cfg_.mcp.max_sql_bytes) * 2 + 16 * 1024;
  const std::string length_header = req.get_header_value("Content-Length");
  const bool length_is_number = !length_header.empty() && length_header.size() < 19 &&
      std::all_of(length_header.begin(), length_header.end(), [](char c) { return c >= '0' && c <= '9'; });
  if (length_is_number && std::stoull(length_header) > max_body) {
    audit(key.id, "request", "", "413_too_large", elapsed(), 0);
    early(413, "payload_too_large", "the request body is larger than " + std::to_string(max_body) + " bytes");
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
    audit(key.id, "request", "", "413_too_large", elapsed(), 0);
    early(413, "payload_too_large", "the request body is larger than " + std::to_string(max_body) + " bytes");
    return;
  }
  if (!read_ok) {
    audit(key.id, "request", "", "400_unreadable", elapsed(), 0);
    early(400, "bad_request", "the request body could not be read");
    return;
  }

  // 5. The message.
  McpServerInfo info;
  info.version = cfg_.version_semver;
  const McpRpcResult result = mcp_handle_message(body, key, *mcp_tools_, info, now);
  res.status = result.http_status;
  if (result.http_status == 202) {
    res.set_content("", 0, "application/json");
  } else {
    res.set_content(result.body, "application/json");
  }
  std::string what = result.method.empty() ? "request" : result.method;
  if (result.tool_called) what = "tools/call:" + result.tool;
  std::string status = "ok";
  if (result.rpc_error != 0) status = "rpc_error_" + std::to_string(-result.rpc_error);
  else if (result.tool_called && result.outcome.is_error) status = result.outcome.error_code;
  audit(key.id, what, result.outcome.host, status, elapsed(), result.outcome.rows);
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
        w.Key("unavailable_tools");
        w.StartArray();
        if (access) {
          for (const auto& gap : mcp_tool_gaps(cfg_, *access)) {
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
      w.Key("tools");
      w.StartArray();
      for (const auto& tool : mcp_tool_catalog()) {
        w.StartObject();
        w.Key("name"); put(w, tool.name);
        w.Key("group"); put(w, tool.group);
        w.Key("section"); put(w, tool.section ? tool.section : "");
        w.Key("description"); put(w, tool.description);
        w.Key("needs_all_data"); w.Bool(tool.needs_all_data);
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
      w.Key("secret_min_bytes"); w.Uint64(kMcpSecretMinBytes);
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
    mcp_write_key(w, *result.key, result.last_used_at);
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
    for (const auto& item : store.list()) mcp_write_key(w, item.key, item.last_used_at);
    w.EndArray();
    w.EndObject();
    api_ok(res, 200, sb);
    return;
  }

  const bool has_body = route == McpApiRoute::KeyCreate;
  if (!allow_mutation(req, res, has_body)) return;
  // Showing a secret is a read, so it works while the keys are read-only (manage_from_ui = false).
  if (route == McpApiRoute::KeyReveal) {
    const auto result = store.reveal(req.matches.size() > 1 ? std::string(req.matches[1]) : std::string());
    if (!result.key) return write_failure(result);
    audit("-", "keys/reveal", "", "ok:" + result.key->id, 0, 0);
    rapidjson::StringBuffer sb;
    Writer w(sb);
    w.StartObject();
    w.Key("id"); put(w, result.key->id);
    w.Key("secret"); put(w, result.secret);
    w.EndObject();
    api_ok(res, 200, sb);
    return;
  }
  // What the key reaches: the tables that the MCP user of each host may read, cut by the patterns of the key.
  if (route == McpApiRoute::KeyAccess) {
    const std::string wanted = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
    std::optional<McpKey> found;
    for (const auto& item : store.list()) {
      if (item.key.id == wanted) found = item.key;
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
    w.Key("hosts");
    w.StartArray();
    for (const auto& host_id : mcp_scope_hosts(key.hosts, available)) {
      const HostSpec* host = find_host(cfg_.hosts, host_id);
      if (!host) continue;
      const McpReadable readable = mcp_readable_objects(client_pool_, *host, refresh);
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
          w.Key("columns");
          if (tables[i]->all_columns) w.String("all");
          else w.Uint64(tables[i]->columns.size());
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
  if (!store.manage_from_ui()) {
    api_error(res, 403, "manage_disabled", "keys are managed in the configuration (mcp.manage_from_ui = false)");
    return;
  }
  if (has_body && req.body.size() > 256 * 1024) {
    api_error(res, 413, "payload_too_large", "the request body is too large");
    return;
  }
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();

  switch (route) {
    case McpApiRoute::KeyCreate: {
      McpKeyInput input;
      if (const auto err = mcp_parse_key_input(req.body, true, &input)) {
        api_error(res, 400, "validation", err->message, err->field, err->reason);
        return;
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
    case McpApiRoute::KeyReveal:
    case McpApiRoute::KeyAccess:
      break;
  }
  api_error(res, 404, "not_found", "unknown MCP route");
}

} // namespace chdash
