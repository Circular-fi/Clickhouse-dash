#pragma once

// Hands the blocks of a result to one thread that encodes them (src/query_session.cpp).

#include <clickhouse/block.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <functional>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace chdash {

// Encodes the blocks of a result on a thread of its own. The native client decodes
// the next block of columns while this thread turns the previous one into JSON, so
// the two steps overlap instead of adding up (for 120 000 rows with nested columns:
// 190 ms of decoding and 150 ms of encoding, 340 ms in a row, about 200 ms overlapped).
// At most `depth` decoded blocks wait, which bounds the memory. A failure of the
// encoder (the cell limit, the result limit, a cancel) stops the next submit().
class BlockEncoder {
 public:
  BlockEncoder(std::function<void(const clickhouse::Block&)> encode, size_t depth)
      : encode_(std::move(encode)), depth_(std::max<size_t>(1, depth)) {
    worker_ = std::thread([this] { run(); });
  }

  BlockEncoder(const BlockEncoder&) = delete;
  BlockEncoder& operator=(const BlockEncoder&) = delete;

  ~BlockEncoder() { stop(false); }

  // Hands one block over; blocks while `depth` blocks wait. Throws what the encoder threw.
  void submit(const clickhouse::Block& block, const std::atomic<bool>& canceled) {
    std::unique_lock<std::mutex> lk(mu_);
    not_full_.wait(lk, [&] { return queue_.size() < depth_ || error_ || canceled.load(std::memory_order_relaxed); });
    if (error_) std::rethrow_exception(error_);
    if (canceled.load(std::memory_order_relaxed)) throw std::runtime_error("canceled");
    queue_.push_back(block);
    not_empty_.notify_one();
  }

  // The end of the result: encodes what waits, joins the thread, throws what the encoder threw.
  void finish() {
    stop(true);
    std::lock_guard<std::mutex> lk(mu_);
    if (error_) std::rethrow_exception(error_);
  }

 private:
  void stop(bool drain) {
    {
      std::lock_guard<std::mutex> lk(mu_);
      closing_ = true;
      if (!drain) queue_.clear();
    }
    not_empty_.notify_all();
    not_full_.notify_all();
    if (worker_.joinable()) worker_.join();
  }

  void run() {
    for (;;) {
      clickhouse::Block block;
      {
        std::unique_lock<std::mutex> lk(mu_);
        not_empty_.wait(lk, [&] { return !queue_.empty() || closing_; });
        if (queue_.empty()) return;
        block = std::move(queue_.front());
        queue_.pop_front();
      }
      not_full_.notify_one();
      try {
        encode_(block);
      } catch (...) {
        {
          std::lock_guard<std::mutex> lk(mu_);
          error_ = std::current_exception();
          queue_.clear();
        }
        not_full_.notify_all();
        return;
      }
    }
  }

  std::function<void(const clickhouse::Block&)> encode_;
  const size_t depth_;
  std::mutex mu_;
  std::condition_variable not_empty_;
  std::condition_variable not_full_;
  std::deque<clickhouse::Block> queue_;
  bool closing_ = false;
  std::exception_ptr error_;
  std::thread worker_;
};

} // namespace chdash
