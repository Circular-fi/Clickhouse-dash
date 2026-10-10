#pragma once

#include "ch_query.hpp"

#include <clickhouse/client.h>

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace chdash {

// Small exclusive-use pool for clickhouse-cpp TCP clients.
// clickhouse::Client instances are never shared concurrently: acquire() removes
// one idle client from the pool and the shared_ptr deleter returns it after use.
// Idle clients are closed before ClickHouse's server-side idle/read timeout so
// the server does not accumulate expected socket-timeout exceptions.
//
// A client goes back to the idle pool only when its last statement ended in a
// known state (ch_query.hpp): a statement that a callback, a socket error or a
// timeout interrupted leaves its connection marked, and the deleter closes it.
//
// The leases of one URI are bounded (max_leased_per_uri): past the bound,
// acquire() waits up to lease_wait for a lease to end, then fails with
// "pool_exhausted" instead of opening one more connection.
class ClickHouseClientPool : public std::enable_shared_from_this<ClickHouseClientPool> {
public:
  explicit ClickHouseClientPool(
    size_t max_idle_per_key = 4,
    std::chrono::milliseconds idle_ttl = std::chrono::seconds(60),
    std::chrono::milliseconds validate_after_idle = std::chrono::seconds(15),
    std::chrono::milliseconds reaper_interval = std::chrono::seconds(5),
    size_t max_leased_per_uri = 0,
    std::chrono::milliseconds lease_wait = std::chrono::seconds(5)
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
  // of returning it to the idle pool (ch_mark_dirty).
  void invalidate(const std::shared_ptr<clickhouse::Client>& client) noexcept;

  void clear();

  // The clients lent now for `uri` (all timeouts together).
  size_t leased(const std::string& uri);

private:
  struct IdleClient {
    ChClientPtr client;
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
    const std::string& key,
    const std::string& uri,
    clickhouse::Client* client,
    bool bounded_receive_timeout
  ) noexcept;
  void reaper_loop();
  void collect_expired_locked(
    std::chrono::steady_clock::time_point now,
    std::vector<ChClientPtr>& expired
  );

  size_t max_idle_per_key_ = 4;
  std::chrono::milliseconds idle_ttl_{std::chrono::seconds(60)};
  std::chrono::milliseconds validate_after_idle_{std::chrono::seconds(15)};
  std::chrono::milliseconds reaper_interval_{std::chrono::seconds(5)};
  size_t max_leased_per_uri_ = 0;
  std::chrono::milliseconds lease_wait_{std::chrono::seconds(5)};

  std::mutex mu_;
  std::condition_variable cv_;
  std::condition_variable lease_cv_;
  bool stopping_ = false;
  std::thread reaper_thread_;

  std::unordered_map<std::string, IdleBucket> idle_;
  std::unordered_map<std::string, size_t> leased_;
};

} // namespace chdash
