#pragma once

// The port of a service to ClickHouse. It defines the statements that the service sends, and the connection under them.
//
// A service (the Traces service, trace_service.hpp) builds its SQL with pure functions (trace_sql.hpp).
// It sends the SQL through a ChExecutor.
// The executor of the server is ClientExecutor. It uses one connection of the pool.
// Every statement of ch_query.hpp applies the bounds of the scope of the request. It also stops when a caller goes away.
//
// The native tests use another executor.
// It returns answers that a test writes. A search strategy is tested without a ClickHouse server.

#include "ch_client_pool.hpp"
#include "ch_query.hpp"
#include "facet_limits.hpp"

#include <clickhouse/block.h>

#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

namespace chdash {

// "host:port" of the server that a connection reaches.
inline std::string client_endpoint(clickhouse::Client& client) {
  const auto& endpoint = client.GetCurrentEndpoint();
  return endpoint ? endpoint->host + ":" + std::to_string(endpoint->port) : std::string{};
}

class ChExecutor {
 public:
  using OnBlock = std::function<void(const clickhouse::Block&)>;

  virtual ~ChExecutor() = default;

  // A SELECT statement. `params` are the query parameters of its {name:Type} placeholders (ch_query.hpp).
  // It throws what ClickHouse or `on_block` throws.
  virtual void select(const std::string& sql, const ChParams& params, const OnBlock& on_block) = 0;
  void select(const std::string& sql, const OnBlock& on_block) { select(sql, ChParams{}, on_block); }

  // A SELECT statement. Its work is bounded by its SETTINGS. It returns what it read (facet_limits.hpp).
  virtual BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& params) = 0;
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block) { return bounded_select(sql, on_block, ChParams{}); }

  // The server that receives the statements ("host:port"). A service keeps this value for each server. The value is empty when it is not known.
  virtual std::string endpoint() const { return {}; }

  // After a failed statement, the connection is never lent again.
  virtual void invalidate() = 0;
  // After a failed statement, the method opens a new connection. It returns false and gives the reason in *error when no connection is available.
  virtual bool renew(std::string* error) = 0;
};

// The executor of the server. It uses one connection that `connect` takes from the pool.
class ClientExecutor final : public ChExecutor {
 public:
  using Connect = std::function<std::shared_ptr<clickhouse::Client>(std::string* error)>;

  // Returns the connection. It returns null and gives the reason in *error on failure.
  static std::unique_ptr<ClientExecutor> open(std::shared_ptr<ClickHouseClientPool> pool, Connect connect, std::string* error) {
    auto client = connect(error);
    if (!client) return nullptr;
    return std::unique_ptr<ClientExecutor>(new ClientExecutor(std::move(pool), std::move(connect), std::move(client)));
  }

  using ChExecutor::select;
  using ChExecutor::bounded_select;

  void select(const std::string& sql, const ChParams& params, const OnBlock& on_block) override {
    ch_select(connection(), sql, params, on_block);
  }
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& params) override {
    return chdash::bounded_select(connection(), sql, on_block, params);
  }
  std::string endpoint() const override { return client_ ? client_endpoint(*client_) : std::string{}; }
  void invalidate() override {
    if (pool_ && client_) pool_->invalidate(client_);
  }
  bool renew(std::string* error) override {
    client_ = connect_(error);
    return client_ != nullptr;
  }

 private:
  ClientExecutor(std::shared_ptr<ClickHouseClientPool> pool, Connect connect, std::shared_ptr<clickhouse::Client> client)
      : pool_(std::move(pool)), connect_(std::move(connect)), client_(std::move(client)) {}

  clickhouse::Client& connection() {
    if (!client_) throw std::runtime_error("no connection to ClickHouse");
    return *client_;
  }

  std::shared_ptr<ClickHouseClientPool> pool_;
  Connect connect_;
  std::shared_ptr<clickhouse::Client> client_;
};

// An executor over a connection that another owner holds. For example, a route has its own client and calls a function that takes the port.
// It cannot take another connection. renew() fails.
class BorrowedExecutor final : public ChExecutor {
 public:
  explicit BorrowedExecutor(clickhouse::Client& client) : client_(client) {}

  using ChExecutor::select;
  using ChExecutor::bounded_select;

  void select(const std::string& sql, const ChParams& params, const OnBlock& on_block) override {
    ch_select(client_, sql, params, on_block);
  }
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& params) override {
    return chdash::bounded_select(client_, sql, on_block, params);
  }
  std::string endpoint() const override { return client_endpoint(client_); }
  void invalidate() override {}
  bool renew(std::string* error) override {
    if (error) *error = "a borrowed connection cannot be renewed";
    return false;
  }

 private:
  clickhouse::Client& client_;
};

}  // namespace chdash
