// The routes of the System page (docs/system.md) are /api/system/overview, series (the Performance history and the disk growth), disks, queries, and
// queries/<hash>. A route is an adapter. It parses the request (system_request.hpp), finds the host, and checks that the host is up.
// It calls the service (system_service.hpp) with the context of the request. Then it writes the JSON of its answer (system_json.hpp).
//
// Each read is a fixed, allowlisted, bounded system-table SELECT. The units of the sections build each SELECT (system_overview, system_series, system_queries, system_disks).
// The request only names the host, a clamped window, and allowlisted enums. Rows that name an object pass the runner SHOW boundary before they count. The rest is server-level.
// The Activity and the Keeper status are in api_system_activity.cpp.
#include "server.hpp"

#include "api_error.hpp"
#include "ch_executor.hpp"
#include "ch_uri.hpp"
#include "format_pooled_port.hpp"
#include "format_service.hpp"
#include "host_util.hpp"
#include "system_json.hpp"
#include "system_request.hpp"
#include "system_service.hpp"
#include "time_util.hpp"

#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace {

// This is the host that the request names. It applies only when the host is known and up. Otherwise, the answer is written.
const HostSpec* usable_host(const AppConfig& cfg, const HealthRunner* health, const httplib::Request& req, const std::string& host_id,
                            httplib::Response& res) {
  const HostSpec* host = find_request_host(cfg, req, host_id);
  if (!host) {
    json_error(res, 404, "unknown_host", "Unknown host_id.");
    return nullptr;
  }
  if (!is_host_healthy(health, host_id)) {
    json_error(res, 503, "host_unavailable", "Selected host is down.");
    return nullptr;
  }
  return host;
}

// This is the answer of a service. It is either its error or its JSON.
template <typename Answer, typename Json>
void send_system_result(httplib::Response& res, const Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.set_header("Cache-Control", "private, no-store");
  const std::string body = json(*result.value);
  res.set_content(body, "application/json");
}

uint64_t system_now_ms() { return static_cast<uint64_t>(now_ms()); }

// This is a connection with the account of `uri`. The receive timeout is the time that the server can stay silent before the first block.
std::shared_ptr<clickhouse::Client> acquire_system_client(const std::shared_ptr<ClickHouseClientPool>& pool, const std::string& uri,
                                                          std::chrono::seconds receive_timeout, std::string* error) {
  return pool ? pool->acquire(uri, std::chrono::seconds(5), receive_timeout, std::chrono::seconds(15), error)
              : make_client_from_uri(uri, std::chrono::seconds(5), receive_timeout, std::chrono::seconds(15), error);
}

} // namespace

// This is what a host exposes. It includes its optional system logs and versioned columns. The result is kept for 10 minutes.
// While an optional log table is missing, the result is kept for 1 minute. ClickHouse creates the table at its first flush.
// A failed detection is not kept. Only its short back-off is kept. The panels then read their base columns. They let ClickHouse answer.
TtlCache<std::string, MonitorCapabilities>::Options Server::capabilities_cache_options() {
  auto options = cache_options<MonitorCapabilities>(std::chrono::minutes(10), {}, 256, 8u << 20);
  options.ttl_of = [](const MonitorCapabilities& caps) -> std::chrono::milliseconds {
    for (const auto& table : monitor_detected_tables()) {
      if (table != "zookeeper_connection" && caps.tables.count(table) == 0) return std::chrono::minutes(1);
    }
    return std::chrono::minutes(10);
  };
  return options;
}

// This is the system account of the host. It makes the server-level reads. If the host has no system account, the runner account makes them.
std::unique_ptr<ChExecutor> Server::open_system_executor(const HostSpec& host, std::string* error) {
  const std::string uri = host.system_uri.empty() ? host.runner_uri : host.system_uri;
  return ClientExecutor::open(
      client_pool_, [this, uri](std::string* reason) { return acquire_system_client(client_pool_, uri, std::chrono::seconds(15), reason); }, error);
}

// This is the runner account of the host. It serves the Queries. The receive timeout is longer than their time budgets.
// So ClickHouse answers TIMEOUT_EXCEEDED first.
std::unique_ptr<ChExecutor> Server::open_system_runner_executor(const HostSpec& host, std::string* error) {
  const std::string uri = host.runner_uri;
  return ClientExecutor::open(
      client_pool_, [this, uri](std::string* reason) { return acquire_system_client(client_pool_, uri, std::chrono::seconds(30), reason); }, error);
}

// This is the masked text of a shape. The runner account of the host makes it. The formatter of the Query page makes the text (format_service.hpp).
// The check of the meaning and the limits of the formatter apply. The formatter does not use its own cache. The service keeps the final text.
// The statements carry the scope of the request. The scope has the label chdash-system, the deadline, and the stop of a caller that went away.
// A failure that is not caused by the text is transient. Examples are a host that is down, a time that ran out, a ClickHouse refusal, and a broken connection. Such a failure is not kept.
system_page::ShapeFormatReply Server::format_shape_sql(const HostSpec& host, const std::string& masked_sql) {
  system_page::ShapeFormatReply reply;
  const FormatterHost formatter = formatter_host(health_.get(), host.id);
  FormatSettings settings;
  settings.use_cache = false;
  settings.cache_scope = host.id + '\x1f' + formatter.version;
  settings.clickhouse_max_query_size = formatter.max_query_size;
  settings.max_sql_bytes = 5 * system_page::kShapeFormatMaxInputBytes;  // a stand-in is five bytes for a placeholder of one
  PooledFormatPort port(client_pool_, health_.get(), host, host.id);
  FormatBatch batch(nullptr, settings, port);
  const FormatOutcome outcome = batch.format(masked_sql);
  if (outcome.ok()) {
        // This is a warning. The formatter could not lay out the text without a change of its meaning. It gave back the text as it was written.
    if (!outcome.warning) reply.text = *outcome.formatted;
    return reply;
  }
  reply.transient = port.host_down() || (outcome.failure != FormatQueryFailureKind::server && outcome.failure != FormatQueryFailureKind::input &&
                                         outcome.failure != FormatQueryFailureKind::empty_result);
  return reply;
}

// GET /api/system/overview
void Server::handle_system_overview(const httplib::Request& req, httplib::Response& res) {
  system_page::HostRequest request;
  ApiError error;
  if (!system_page::parse_host_request(req, &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  send_system_result(res, system_service_.overview(current_request_context(), *host, request), [&](const auto& cached) {
    return system_page::overview_json(request.host_id, *cached.value, cached.stale);
  });
}

// GET /api/system/series: the Performance history, bucketed from the server's system logs, or (panel=disk_growth) the growth of the disks.
// The request names the host, a window (milliseconds, clamped and validated), an allowlisted panel and scope, and nothing else.
// An unknown parameter is refused. So no request text can reach the SQL.
void Server::handle_system_series(const httplib::Request& req, httplib::Response& res) {
  system_page::SeriesRequest request;
  ApiError error;
  if (!system_page::parse_series_request(req, cfg_.system, system_now_ms(), &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  if (request.growth) {
    return send_system_result(res, system_service_.disk_growth(current_request_context(), *host, request), [&](const auto& cached) {
      return system_page::growth_json(request.host_id, request, *cached.value, cached.stale, cfg_.system);
    });
  }
  send_system_result(res, system_service_.series(current_request_context(), *host, request), [&](const auto& cached) {
    return system_page::series_json(request.host_id, request, *cached.value, cached.stale, cfg_.system);
  });
}

// GET /api/system/disks: the server's disks (capacity, free and reserved space, kind, flags, the policies they belong to), its storage policies,
// and the bytes of the active parts of each runner-visible database on each disk. The request names the host and refresh only.
void Server::handle_system_disks(const httplib::Request& req, httplib::Response& res) {
  system_page::HostRequest request;
  ApiError error;
  if (!system_page::parse_host_request(req, &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  send_system_result(res, system_service_.disks(current_request_context(), *host, request), [&](const auto& cached) {
    return system_page::disks_json(request.host_id, *cached.value, cached.stale, cfg_.system);
  });
}

// GET /api/system/queries: the shapes of the queries in the window, by an allowlisted measure. It reads system.query_log with the RUNNER account.
// ClickHouse grants decide what the account reads. The Query page reads the same rows.
// The request names the host, a window, and allowlisted values for sort, kind, errors, and hide_chdash.
// It can also name one user, one database, and one table. These are bound query parameters of the SELECT, never SQL text. Anything else is refused before the host is looked up.
void Server::handle_system_queries(const httplib::Request& req, httplib::Response& res) {
  system_page::QueriesRequest request;
  ApiError error;
  if (!system_page::parse_queries_request(req, cfg_.system, system_now_ms(), &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  send_system_result(res, system_service_.queries(current_request_context(), *host, request), [&](const auto& cached) {
    return system_page::queries_json(request.host_id, request.from_ms, request.to_ms, *cached.value, cached.stale, cfg_.system);
  });
}

// GET /api/system/queries/<hash>: one query shape. The response has its timeline over the window and its 20 slowest, latest or largest runs.
// It also has the latest run's text, and that text formatted (`normalized_formatted`). This value is null when the text cannot be formatted. The page then shows `normalized`.
// The route uses the Runner account, as the list does. The formatter runs on this account too. It formats each text once (SystemService::shape_text_formatted).
void Server::handle_system_query(const httplib::Request& req, httplib::Response& res) {
  system_page::QueryRequest request;
  ApiError error;
  const std::string hash_text = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  if (!system_page::parse_query_request(req, hash_text, cfg_.system, system_now_ms(), &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  send_system_result(res, system_service_.query(current_request_context(), *host, request), [&](const auto& cached) {
    const auto formatted = cached.value->status == "ok" ? system_service_.shape_text_formatted(current_request_context(), *host, cached.value->normalized) : nullptr;
    return system_page::query_json(request.host_id, request.from_ms, request.to_ms, *cached.value, cached.stale, cfg_.system, formatted.get());
  });
}

} // namespace chdash
