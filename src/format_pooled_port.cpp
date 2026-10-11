#include "format_pooled_port.hpp"

#include "ch_uri.hpp"
#include "host_util.hpp"

#include <chrono>
#include <utility>

namespace chdash {

FormatterHost formatter_host(const HealthRunner* health, const std::string& host_id) {
  FormatterHost out;
  if (!health) return out;
  const std::string base = host_id.substr(0, host_id.find('\x1f'));
  const HostsSnapshot snap = health->snapshot();
  for (const auto& h : snap.hosts) {
    if (h.id != base) continue;
    out.version = h.clickhouse_version;
    out.max_query_size = h.clickhouse_max_query_size;
  }
  return out;
}

PooledFormatPort::PooledFormatPort(const std::shared_ptr<ClickHouseClientPool>& pool, const HealthRunner* health, const HostSpec& host,
                                   std::string host_id)
    : pool_(pool), health_(health), host_(host), host_id_(std::move(host_id)) {}

FormatQueryResult PooledFormatPort::format_query(const std::string& sql, size_t max_bytes) {
  return run(sql, max_bytes, format_query_with_client);
}

FormatQueryResult PooledFormatPort::explain_ast(const std::string& sql, size_t max_bytes) {
  return run(sql, max_bytes, explain_ast_with_client);
}

FormatQueryResult PooledFormatPort::run(const std::string& sql, size_t max_bytes, Call call) {
  FormatQueryResult result;
  auto client = connect();
  if (!client) {
    result.failure = FormatQueryFailureKind::transport;
    result.message = connect_error_.empty() ? "Failed to connect to ClickHouse for formatQuery." : connect_error_;
    return result;
  }
  result = call(*client, sql, max_bytes);
  reconnect_attempted_ = reconnect_attempted_ || result.reconnect_attempted;
  if (!result.connection_reusable && pool_) pool_->invalidate(client);
  return result;
}

std::shared_ptr<clickhouse::Client> PooledFormatPort::connect() {
  if (connect_failed_) return {};
  if (!is_host_healthy(health_, host_id_)) {
    connect_error_ = "Selected host is down.";
    host_down_ = true;
    connect_failed_ = true;
    return {};
  }
  const auto timeout = std::chrono::seconds(5);
  auto client = pool_ ? pool_->acquire(host_.runner_uri, timeout, timeout, timeout, &connect_error_)
                      : make_client_from_uri(host_.runner_uri, timeout, timeout, timeout, &connect_error_);
  if (!client) connect_failed_ = true;
  return client;
}

}  // namespace chdash
