#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>

namespace chdash {

// A component can start threads that it does not join at once.
// For example, the query worker of each QuerySession can end after its session left the server.
// Each thread enters the group when it starts and leaves it as its very last step.
// The server closes the group at shutdown.
// The server waits, with a deadline, until every thread left the group.
// Then the server destroys what these threads use (docs/operations.md, "Shutdown").
class WorkerGroup {
public:
    // Add one more thread. The result is false once the group is closed. The caller must not start the thread then.
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

    // No thread enters the group any more. It waits at most `timeout` for the active threads.
    // The result is true when no thread is left.
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
