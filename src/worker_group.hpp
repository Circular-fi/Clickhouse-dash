#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>

namespace chdash {

// The threads that a component starts and does not join at once (the query worker of each QuerySession, which may
// end after its session left the server): each one enters the group when it starts and leaves it as its very last
// step. The server closes the group at shutdown and waits until every thread left it, with a deadline, before
// it destroys what these threads use (docs/operations.md, "Shutdown").
class WorkerGroup {
public:
  // One more thread; false once the group is closed: the caller must not start it.
  bool enter() {
    std::lock_guard<std::mutex> lock(mu_);
    if (closed_) return false;
    ++active_;
    return true;
  }

  void leave() {
    std::lock_guard<std::mutex> lock(mu_);
    if (active_ > 0) --active_;
    if (active_ == 0) cv_.notify_all();
  }

  // No thread enters any more; waits at most `timeout` for the active ones. True when none is left.
  bool close_and_wait(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mu_);
    closed_ = true;
    return cv_.wait_for(lock, timeout, [this] { return active_ == 0; });
  }

  size_t active() const {
    std::lock_guard<std::mutex> lock(mu_);
    return active_;
  }

private:
  mutable std::mutex mu_;
  std::condition_variable cv_;
  size_t active_ = 0;
  bool closed_ = false;
};

} // namespace chdash
