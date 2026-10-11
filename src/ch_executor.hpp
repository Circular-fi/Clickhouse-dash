#pragma once

// The port of a service to ClickHouse: the statements that it sends and the connection under them.
//
// A service (the Traces service, trace_service.hpp) builds its SQL with pure functions (trace_sql.hpp) and sends it through a
// ChExecutor. The executor of the server is ClientExecutor: one connection of the pool, and every statement of ch_query.hpp
// (the bounds of the scope of the request, the stop of a caller that went away). The native tests use another one, with
// answers that a test writes, so a search strategy is tested without a ClickHouse server.

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

// "host:port" of the server that a connection is on.
inline std::string client_endpoint(clickhouse::Client& client) {
  const auto& endpoint = client.GetCurrentEndpoint();
  return endpoint ? endpoint->host + ":" + std::to_string(endpoint->port) : std::string{};
}

class ChExecutor {
 public:
  using OnBlock = std::function<void(const clickhouse::Block&)>;

  virtual ~ChExecutor() = default;

  // A SELECT; `params` are the query parameters of its {name:Type} placeholders (ch_query.hpp). Throws what ClickHouse or
  // `on_block` throws.
  virtual void select(const std::string& sql, const ChParams& params, const OnBlock& on_block) = 0;
  void select(const std::string& sql, const OnBlock& on_block) { select(sql, ChParams{}, on_block); }

  // A SELECT whose work is bounded by its SETTINGS, and what it read (facet_limits.hpp).
  virtual BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block, const ChParams& params) = 0;
  BoundedRead bounded_select(const std::string& sql, const OnBlock& on_block) { return bounded_select(sql, on_block, ChParams{}); }

  // The server that the statements go to ("host:port"), for what a service keeps for each server; empty when it is not known.
  virtual std::string endpoint() const { return {}; }

  // After a failed statement: the connection is not lent again.
  virtual void invalidate() = 0;
  // After a failed statement: a new connection. False, with the reason in *error, when none can be had.
  virtual bool renew(std::string* error) = 0;
};

// The executor of the server: one connection, taken from the pool by `connect`.
class ClientExecutor final : public ChExecutor {
 public:
  using Connect = std::function<std::shared_ptr<clickhouse::Client>(std::string* error)>;

  // The connection, or null with the reason in *error.
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

// An executor over a connection that someone else owns (a route that has its client and calls a function that takes the port).
// It cannot take another connection: renew() fails.
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
