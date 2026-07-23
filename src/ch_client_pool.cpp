#include "ch_client_pool.hpp"

#include "ch_uri.hpp"

#include <algorithm>
#include <exception>
#include <utility>

namespace chdash {

ClickHouseClientPool::ClickHouseClientPool(
  size_t max_idle_per_key,
  std::chrono::milliseconds idle_ttl,
  std::chrono::milliseconds validate_after_idle,
  std::chrono::milliseconds reaper_interval
) : max_idle_per_key_(max_idle_per_key),
    idle_ttl_(std::max(std::chrono::milliseconds(0), idle_ttl)),
    validate_after_idle_(std::max(std::chrono::milliseconds(0), validate_after_idle)),
    reaper_interval_(std::max(std::chrono::milliseconds(250), reaper_interval)) {
  if (max_idle_per_key_ > 0 && idle_ttl_.count() > 0) {
    reaper_thread_ = std::thread([this] { reaper_loop(); });
  }
}

ClickHouseClientPool::~ClickHouseClientPool() {
  {
    std::lock_guard<std::mutex> lock(mu_);
    stopping_ = true;
  }
  cv_.notify_all();
  if (reaper_thread_.joinable()) reaper_thread_.join();
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
  const auto now = std::chrono::steady_clock::now();

  std::unique_ptr<clickhouse::Client> client;
  std::vector<std::unique_ptr<clickhouse::Client>> expired;
  bool validate = false;
  bool bounded_receive_timeout = recv_timeout.count() > 0;
  {
    std::lock_guard<std::mutex> lock(mu_);
    collect_expired_locked(now, expired);

    auto it = idle_.find(key);
    if (it != idle_.end()) {
      while (!it->second.clients.empty() && !client) {
        IdleClient entry = std::move(it->second.clients.back());
        it->second.clients.pop_back();
        if (!entry.client) continue;

        const auto idle_for = now - entry.returned_at;
        if (idle_ttl_.count() > 0 && idle_for >= idle_ttl_) {
          expired.push_back(std::move(entry.client));
          continue;
        }

        const bool validation_due = validate_after_idle_.count() > 0 &&
                                    idle_for >= validate_after_idle_;
        if (validation_due && !entry.bounded_receive_timeout) {
          // Query clients intentionally use an unbounded receive timeout so a
          // legitimate long query cannot be aborted locally. Never Ping such a
          // socket for validation: a half-open peer could block forever. Open a
          // fresh connection instead after the validation threshold.
          expired.push_back(std::move(entry.client));
          continue;
        }

        validate = validation_due;
        bounded_receive_timeout = entry.bounded_receive_timeout;
        client = std::move(entry.client);
      }
      if (it->second.clients.empty()) idle_.erase(it);
    }
  }

  // Destroy expired sockets outside the pool mutex. Closing the client sends a
  // normal FIN to ClickHouse instead of leaving the server blocked until its
  // receive timeout expires.
  expired.clear();

  if (client && validate) {
    try {
      client->Ping();
    } catch (...) {
      // The peer or a proxy closed the idle socket. Drop it and create a fresh
      // connection; do not return a half-open client to callers.
      client.reset();
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
  return std::shared_ptr<clickhouse::Client>(
      raw,
      [self, key, bounded_receive_timeout](clickhouse::Client* c) mutable {
        self->release(std::move(key), c, bounded_receive_timeout);
      });
}

void ClickHouseClientPool::invalidate(
  const std::shared_ptr<clickhouse::Client>& client
) noexcept {
  if (!client) return;

  try {
    std::lock_guard<std::mutex> lock(mu_);
    invalidated_.insert(client.get());
  } catch (...) {
    // If bookkeeping allocation fails, the caller can still reset or release
    // the client. Avoid throwing from an error-recovery path.
  }
}

void ClickHouseClientPool::release(
  std::string key,
  clickhouse::Client* client,
  bool bounded_receive_timeout
) noexcept {
  if (!client) return;

  std::unique_ptr<clickhouse::Client> owned(client);

  try {
    std::lock_guard<std::mutex> lock(mu_);
    if (stopping_ || invalidated_.erase(client) != 0 || max_idle_per_key_ == 0) {
      return;
    }

    auto& bucket = idle_[key];
    if (bucket.clients.size() < max_idle_per_key_) {
      bucket.clients.push_back(IdleClient{
        std::move(owned),
        std::chrono::steady_clock::now(),
        bounded_receive_timeout,
      });
      cv_.notify_one();
    }
  } catch (...) {
    // Drop the client if the pool cannot accept it.
  }
}

void ClickHouseClientPool::collect_expired_locked(
  std::chrono::steady_clock::time_point now,
  std::vector<std::unique_ptr<clickhouse::Client>>& expired
) {
  if (idle_ttl_.count() <= 0) return;

  for (auto bucket_it = idle_.begin(); bucket_it != idle_.end();) {
    auto& clients = bucket_it->second.clients;
    auto keep_it = std::remove_if(clients.begin(), clients.end(), [&](IdleClient& entry) {
      if (!entry.client || now - entry.returned_at >= idle_ttl_) {
        if (entry.client) expired.push_back(std::move(entry.client));
        return true;
      }
      return false;
    });
    clients.erase(keep_it, clients.end());

    if (clients.empty()) {
      bucket_it = idle_.erase(bucket_it);
    } else {
      ++bucket_it;
    }
  }
}

void ClickHouseClientPool::reaper_loop() {
  for (;;) {
    std::vector<std::unique_ptr<clickhouse::Client>> expired;
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait_for(lock, reaper_interval_, [&] { return stopping_; });
      if (stopping_) return;
      collect_expired_locked(std::chrono::steady_clock::now(), expired);
    }
    expired.clear();
  }
}

void ClickHouseClientPool::clear() {
  std::unordered_map<std::string, IdleBucket> idle;
  {
    std::lock_guard<std::mutex> lock(mu_);
    idle.swap(idle_);
    invalidated_.clear();
  }
  // Destroy sockets outside the mutex.
  idle.clear();
}

} // namespace chdash
