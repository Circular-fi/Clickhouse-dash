// The routes of the System page (docs/system.md): /api/system/overview, series (the Performance history and the disk growth), disks, queries and
// queries/<hash>. A route is an adapter: it parses the request (system_request.hpp), finds the host and checks that it is up, calls the service
// (system_service.hpp) with the context of the request, and writes the JSON of its answer (system_json.hpp). Every read is a fixed, allowlisted,
// bounded system-table SELECT built in the units of the sections (system_overview, system_series, system_queries, system_disks); the request
// only names the host, a clamped window and allowlisted enums. Rows that name an object pass the runner SHOW boundary before they count; the rest
// is server-level. The Activity and the Keeper status are in api_system_activity.cpp.
#include "server.hpp"

#include "api_error.hpp"
#include "ch_executor.hpp"
#include "ch_uri.hpp"
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

// The host that the request names, when it is known and up: else the answer is written.
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

// The answer of a service: its error, or its JSON.
template <typename Answer, typename Json>
void send_system_result(httplib::Response& res, const Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.set_header("Cache-Control", "private, no-store");
  const std::string body = json(*result.value);
  res.set_content(body, "application/json");
}

uint64_t system_now_ms() { return static_cast<uint64_t>(now_ms()); }

// A connection with the account of `uri`. The receive timeout is how long the server may stay silent before the first block.
std::shared_ptr<clickhouse::Client> acquire_system_client(const std::shared_ptr<ClickHouseClientPool>& pool, const std::string& uri,
                                                          std::chrono::seconds receive_timeout, std::string* error) {
  return pool ? pool->acquire(uri, std::chrono::seconds(5), receive_timeout, std::chrono::seconds(15), error)
              : make_client_from_uri(uri, std::chrono::seconds(5), receive_timeout, std::chrono::seconds(15), error);
}

} // namespace

// What a host exposes (its optional system logs and versioned columns): kept
// 10 minutes, 1 minute while an optional log table is missing (ClickHouse
// creates it at its first flush). A failed detection is not kept (only its
// short back-off): the panels then read their base columns and let
// ClickHouse answer.
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

// The system account of the host: the server-level reads (the account of the runner when the host has no system account).
std::unique_ptr<ChExecutor> Server::open_system_executor(const HostSpec& host, std::string* error) {
  const std::string uri = host.system_uri.empty() ? host.runner_uri : host.system_uri;
  return ClientExecutor::open(
      client_pool_, [this, uri](std::string* reason) { return acquire_system_client(client_pool_, uri, std::chrono::seconds(15), reason); }, error);
}

// The runner account of the host, for the Queries: the receive timeout outlasts their time budgets, so ClickHouse answers TIMEOUT_EXCEEDED first.
std::unique_ptr<ChExecutor> Server::open_system_runner_executor(const HostSpec& host, std::string* error) {
  const std::string uri = host.runner_uri;
  return ClientExecutor::open(
      client_pool_, [this, uri](std::string* reason) { return acquire_system_client(client_pool_, uri, std::chrono::seconds(30), reason); }, error);
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

// GET /api/system/series: the Performance history, bucketed from the server's system logs, or (panel=disk_growth) the growth of the disks. The
// request names the host, a window (milliseconds, clamped and validated), an allowlisted panel and scope, and nothing else: an unknown
// parameter is refused, so no request text can reach the SQL.
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

// GET /api/system/disks: the server's disks (capacity, free and reserved space, kind, flags, the policies they belong to), its storage policies, and
// the bytes of the active parts of each runner-visible database on each disk. The request names the host (and refresh) only.
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

// GET /api/system/queries: the shapes of the window's queries by an allowlisted measure, read from system.query_log with the RUNNER account
// (ClickHouse grants decide; the Query page reads the same rows). The request names the host, a window and allowlisted sort / kind / errors /
// hide_chdash values, and optionally one user, one database and one table (bound query parameters of the SELECT, never SQL text); anything else
// is refused before the host is looked up.
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

// GET /api/system/queries/<hash>: one query shape: its timeline over the window and its 20 slowest, latest or largest runs, with the latest run's
// text. Runner account, as the list.
void Server::handle_system_query(const httplib::Request& req, httplib::Response& res) {
  system_page::QueryRequest request;
  ApiError error;
  const std::string hash_text = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  if (!system_page::parse_query_request(req, hash_text, cfg_.system, system_now_ms(), &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  send_system_result(res, system_service_.query(current_request_context(), *host, request), [&](const auto& cached) {
    return system_page::query_json(request.host_id, request.from_ms, request.to_ms, *cached.value, cached.stale, cfg_.system);
  });
}

} // namespace chdash
