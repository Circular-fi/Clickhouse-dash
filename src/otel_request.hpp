#pragma once

// The routes of the OpenTelemetry pages (Traces, Logs, Metrics, and the detection of the signals) run these steps first.
// They find the host that the request names. Then they open a connection to it with the system account. Each page had its own copy.

#include "ch_client_pool.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "server.hpp"

#include <chrono>
#include <memory>
#include <string>

namespace chdash {
namespace otel {

// The host of `host_id`. When the request names no host and the configuration has one host, that host is used.
// `*host_id` is the id that was used. It is "" when there is none. The result is null when the host does not exist for this request.
inline const HostSpec* request_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id;
  if (req.has_param("host_id")) id = req.get_param_value("host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_request_host(cfg, req, id);
}

// The connection uses the system account of `host`. `what` names the page in the message for a host that has none ("OTel logs").
// The receive timeout is how long the server can stay silent before the first block. A read over a wide window can take a while to merge.
// The timeout must be longer than the max_execution_time of the page.
inline std::shared_ptr<clickhouse::Client> acquire_client(
    const HostSpec& host, const std::shared_ptr<ClickHouseClientPool>& pool, const char* what,
    std::chrono::seconds receive_timeout, std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = std::string(what) + ": system credentials are required for the selected host.";
    return nullptr;
  }
  const auto connect_timeout = std::chrono::seconds(5);
  const auto send_timeout = std::chrono::seconds(15);
  return pool ? pool->acquire(host.system_uri, connect_timeout, receive_timeout, send_timeout, error)
              : make_client_from_uri(host.system_uri, connect_timeout, receive_timeout, send_timeout, error);
}

} // namespace otel
} // namespace chdash
