#pragma once

#include <clickhouse/client.h>

#include <chrono>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {

// Small exclusive-use pool for clickhouse-cpp TCP clients.
// clickhouse::Client instances are not shared concurrently: acquire() removes
// one idle client from the pool and the shared_ptr deleter returns it after use.
class ClickHouseClientPool : public std::enable_shared_from_this<ClickHouseClientPool> {
public:
  explicit ClickHouseClientPool(size_t max_idle_per_key = 4);
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
  struct IdleBucket {
    std::vector<std::unique_ptr<clickhouse::Client>> clients;
  };

  static std::string make_key(
    const std::string& uri,
    std::chrono::milliseconds connect_timeout,
    std::chrono::milliseconds recv_timeout,
    std::chrono::milliseconds send_timeout
  );

  void release(std::string key, clickhouse::Client* client) noexcept;

  size_t max_idle_per_key_ = 4;
  std::mutex mu_;
  std::unordered_map<std::string, IdleBucket> idle_;
  std::unordered_set<clickhouse::Client*> invalidated_;
};

} // namespace chdash
