// The routes of the System Activity and of the Keeper status are /api/system/activity and /api/system/keeper. Both are fixed, allowlisted, bounded reads
// (system_activity.cpp). No SQL or filter comes from the request. Activity rows that name an object pass the runner SHOW boundary before they
// are kept. The Keeper status is server-level and names no object. A route is an adapter over SystemService (system_service.hpp).
#include "server.hpp"

#include "api_error.hpp"
#include "host_util.hpp"
#include "system_json.hpp"
#include "system_request.hpp"
#include "system_service.hpp"

#include <string>

namespace chdash {
namespace {

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

} // namespace

// GET /api/system/activity
void Server::handle_system_activity(const httplib::Request& req, httplib::Response& res) {
  system_page::HostRequest request;
  ApiError error;
  if (!system_page::parse_host_request(req, &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  const auto answer = system_service_.activity(current_request_context(), *host, request);
  if (!answer.value) return send_error(res, answer.error);
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(system_page::activity_json(request.host_id, *answer.value->value, answer.value->stale), "application/json");
}

// GET /api/system/keeper
void Server::handle_system_keeper(const httplib::Request& req, httplib::Response& res) {
  system_page::HostRequest request;
  ApiError error;
  if (!system_page::parse_host_request(req, &request, &error)) return send_error(res, error);
  const HostSpec* host = usable_host(cfg_, health_.get(), req, request.host_id, res);
  if (!host) return;
  const auto answer = system_service_.keeper(current_request_context(), *host, request);
  if (!answer.value) return send_error(res, answer.error);
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(system_page::keeper_json(request.host_id, *answer.value->value, answer.value->stale), "application/json");
}

} // namespace chdash
