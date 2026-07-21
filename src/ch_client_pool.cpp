#include "ch_client_pool.hpp"

#include "ch_uri.hpp"

#include <exception>
#include <utility>

namespace chdash {

ClickHouseClientPool::ClickHouseClientPool(size_t max_idle_per_key)
  : max_idle_per_key_(max_idle_per_key) {}

ClickHouseClientPool::~ClickHouseClientPool() {
  clear();
}

std::string ClickHouseClientPool::make_key(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout
) {
  std::string key;
  key.reserve(uri.size() + 64);
  key += uri;
  key += "|ct=";
  key += std::to_string(connect_timeout.count());
  key += "|rt=";
  key += std::to_string(recv_timeout.count());
  key += "|st=";
  key += std::to_string(send_timeout.count());
  return key;
}

std::shared_ptr<clickhouse::Client> ClickHouseClientPool::acquire(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout,
  std::string* err
) {
  const std::string key = make_key(uri, connect_timeout, recv_timeout, send_timeout);

  std::unique_ptr<clickhouse::Client> client;
  {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = idle_.find(key);
    if (it != idle_.end() && !it->second.clients.empty()) {
      client = std::move(it->second.clients.back());
      it->second.clients.pop_back();
    }
  }

  if (!client) {
    auto opt = client_options_from_uri(uri, connect_timeout, recv_timeout, send_timeout, err);
    if (!opt) return nullptr;
    try {
      client = std::make_unique<clickhouse::Client>(*opt);
    } catch (const std::exception& e) {
      if (err) *err = e.what();
      return nullptr;
    }
  }

  clickhouse::Client* raw = client.release();
  auto self = shared_from_this();
  return std::shared_ptr<clickhouse::Client>(raw, [self, key](clickhouse::Client* c) mutable {
    self->release(std::move(key), c);
  });
}

void ClickHouseClientPool::release(std::string key, clickhouse::Client* client) noexcept {
  if (!client) return;

  std::unique_ptr<clickhouse::Client> owned(client);
  if (max_idle_per_key_ == 0) {
    return;
  }

  try {
    std::lock_guard<std::mutex> lk(mu_);
    auto& bucket = idle_[key];
    if (bucket.clients.size() < max_idle_per_key_) {
      bucket.clients.push_back(std::move(owned));
    }
  } catch (...) {
    // Drop the client if the pool cannot accept it.
  }
}

void ClickHouseClientPool::clear() {
  std::lock_guard<std::mutex> lk(mu_);
  idle_.clear();
}

} // namespace chdash
