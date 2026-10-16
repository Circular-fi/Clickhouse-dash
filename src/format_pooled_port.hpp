#pragma once

// The server gives the formatter (format_service.hpp) the means to reach ClickHouse.
// The means run formatQuery and EXPLAIN AST on a pooled connection of a host's runner account.
// They also give the health data that the health check of the host holds about its server.
// The route of the formatter (api_format.cpp) and the formatted text of a query shape (api_system.cpp) use them.

#include "ch_client_pool.hpp"
#include "format_clickhouse.hpp"
#include "format_service.hpp"
#include "health_runner.hpp"

#include <cstddef>
#include <memory>
#include <string>

namespace chdash {

// The health data of the host, from its health check. The host of an MCP identity, <host>\x1fmcp, is the host that the identity serves.
struct FormatterHost {
  // formatQuery can answer with another layout after an upgrade. So the version is part of the cache key.
  std::string version;
  // max_query_size: the longest text that ClickHouse parses. The value is 0 when the check did not read it.
  size_t max_query_size = 0;
};

FormatterHost formatter_host(const HealthRunner* health, const std::string& host_id);

// formatQuery runs on a pooled connection of the host. Each text takes a connection when it needs ClickHouse.
// A text with comments never needs one.
//
// Each text gives the connection back at once. If the connection is no longer good, the text closes it.
// So a batch holds no connection between two texts. A client that failed while idle is reconnected once (format_query_with_client).
//
// The host is checked once. A connection that cannot be opened is not tried again in the same request.
// The other texts fail at once with the same error, instead of waiting for it again.
// The statements carry the limits of the scope of the thread (ch_query.hpp).
class PooledFormatPort final : public FormatQueryPort {
public:
  PooledFormatPort(const std::shared_ptr<ClickHouseClientPool>& pool, const HealthRunner* health, const HostSpec& host, std::string host_id);

  FormatQueryResult format_query(const std::string& sql, size_t max_bytes) override;
  FormatQueryResult explain_ast(const std::string& sql, size_t max_bytes) override;

  // The host is down, according to its health check. The answer is the same as that of every other route, not a transport error.
  bool host_down() const { return host_down_; }
  bool reconnect_attempted() const { return reconnect_attempted_; }

private:
  using Call = FormatQueryResult (*)(clickhouse::Client&, const std::string&, size_t);

  FormatQueryResult run(const std::string& sql, size_t max_bytes, Call call);
  std::shared_ptr<clickhouse::Client> connect();

  std::shared_ptr<ClickHouseClientPool> pool_;
  const HealthRunner* health_;
  const HostSpec& host_;
  std::string host_id_;
  std::string connect_error_;
  bool connect_failed_ = false;
  bool reconnect_attempted_ = false;
  bool host_down_ = false;
};

}  // namespace chdash
