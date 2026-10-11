#pragma once

// What the server gives the formatter (format_service.hpp) to reach ClickHouse: formatQuery and EXPLAIN AST on a pooled connection of a host's
// runner account, and what the health check of the host knows of its server. The route of the formatter (api_format.cpp) and the formatted text
// of a query shape (api_system.cpp) use them.

#include "ch_client_pool.hpp"
#include "format_clickhouse.hpp"
#include "format_service.hpp"
#include "health_runner.hpp"

#include <cstddef>
#include <memory>
#include <string>

namespace chdash {

// What the health check of the host knows of its server (the host of an MCP identity, <host>\x1fmcp, is the host that it is for).
struct FormatterHost {
  // formatQuery may answer another layout after an upgrade, so the version is part of the key of the cache.
  std::string version;
  // max_query_size: the longest text that ClickHouse parses (0 when the check did not read it).
  size_t max_query_size = 0;
};

FormatterHost formatter_host(const HealthRunner* health, const std::string& host_id);

// formatQuery on a pooled connection of the host. Each text takes a connection when it needs ClickHouse (a text with comments never
// does) and gives it back at once, or closes it when it is no longer good, so a batch holds no connection between two texts (a client
// that failed while idle is reconnected once, format_query_with_client). The host is checked once, and a connection that cannot be
// opened is not tried again in the same request: the other texts fail at once with the same error instead of waiting for it again.
// The statements carry the limits of the scope of the thread (ch_query.hpp).
class PooledFormatPort final : public FormatQueryPort {
public:
  PooledFormatPort(const std::shared_ptr<ClickHouseClientPool>& pool, const HealthRunner* health, const HostSpec& host, std::string host_id);

  FormatQueryResult format_query(const std::string& sql, size_t max_bytes) override;
  FormatQueryResult explain_ast(const std::string& sql, size_t max_bytes) override;

  // The host is down (its health check): the answer is the one of every other route, not a transport error.
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
