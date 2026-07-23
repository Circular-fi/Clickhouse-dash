#pragma once

#include <clickhouse/client.h>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {

// Small exclusive-use pool for clickhouse-cpp TCP clients.
// clickhouse::Client instances are never shared concurrently: acquire() removes
// one idle client from the pool and the shared_ptr deleter returns it after use.
// Idle clients are closed before ClickHouse's server-side idle/read timeout so
// the server does not accumulate expected socket-timeout exceptions.
class ClickHouseClientPool : public std::enable_shared_from_this<ClickHouseClientPool> {
public:
  explicit ClickHouseClientPool(
    size_t max_idle_per_key = 4,
    std::chrono::milliseconds idle_ttl = std::chrono::seconds(60),
    std::chrono::milliseconds validate_after_idle = std::chrono::seconds(15),
    std::chrono::milliseconds reaper_interval = std::chrono::seconds(5)
  );
  ~ClickHouseClientPool();

  ClickHouseClientPool(const ClickHouseClientPool&) = delete;
  ClickHouseClientPool& operator=(const ClickHouseClientPool&) = delete;

  std::shared_ptr<clickhouse::Client> acquire(
    const std::string& uri,
    std::chrono::milliseconds connect_timeout,
    std::chrono::milliseconds recv_timeout,
    std::chrono::milliseconds send_timeout,
    std::string* err
  );

  // Mark a leased client as unsafe so its custom deleter destroys it instead
  // of returning it to the idle pool.
  void invalidate(const std::shared_ptr<clickhouse::Client>& client) noexcept;

  void clear();

private:
  struct IdleClient {
    std::unique_ptr<clickhouse::Client> client;
    std::chrono::steady_clock::time_point returned_at;
    bool bounded_receive_timeout = false;
  };

  struct IdleBucket {
    std::vector<IdleClient> clients;
  };

  static std::string make_key(
    const std::string& uri,
    std::chrono::milliseconds connect_timeout,
    std::chrono::milliseconds recv_timeout,
    std::chrono::milliseconds send_timeout
  );

  void release(
    std::string key,
    clickhouse::Client* client,
    bool bounded_receive_timeout
  ) noexcept;
  void reaper_loop();
  void collect_expired_locked(
    std::chrono::steady_clock::time_point now,
    std::vector<std::unique_ptr<clickhouse::Client>>& expired
  );

  size_t max_idle_per_key_ = 4;
  std::chrono::milliseconds idle_ttl_{std::chrono::seconds(60)};
  std::chrono::milliseconds validate_after_idle_{std::chrono::seconds(15)};
  std::chrono::milliseconds reaper_interval_{std::chrono::seconds(5)};

  std::mutex mu_;
  std::condition_variable cv_;
  bool stopping_ = false;
  std::thread reaper_thread_;

  std::unordered_map<std::string, IdleBucket> idle_;
  std::unordered_set<clickhouse::Client*> invalidated_;
};

} // namespace chdash
