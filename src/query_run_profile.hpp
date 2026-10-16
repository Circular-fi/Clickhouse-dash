#pragma once

// A run gets its own cost from the ProfileEvents packets of the native protocol. The cost has the CPU time of the query group and the memory
// that its hosts hold. Only counters and gauges that ClickHouse emits are kept. A missing event stays unavailable (-1, or no CPU time).
// Such an event is never inferred from another value.

#include <clickhouse/block.h>

#include <cstdint>
#include <string>
#include <unordered_map>

namespace chdash {

struct RunProfile {
  int64_t user_time_us_total = 0;
  int64_t system_time_us_total = 0;
  bool cpu_time_available = false;

  int64_t current_mem_bytes = -1;
  int64_t peak_mem_bytes = -1;
  // The last gauge of each host; the memory of the run is their sum.
  std::unordered_map<std::string, int64_t> memory_usage_by_host;
  std::unordered_map<std::string, int64_t> peak_memory_usage_by_host;

  void reset() { *this = RunProfile{}; }

  // One ProfileEvents block has these columns: host_name, current_time, thread_id, type, name, value.
  // Only the aggregate of the query group counts, where thread_id = 0.
  // UserTimeMicroseconds and SystemTimeMicroseconds add up. MemoryTrackerUsage and MemoryTrackerPeakUsage are gauges of a host.
  // Thread counts are deliberately not inferred or exposed. The result is false when the block was not read.
  // That happens when the block has no rows, or when it lacks a column of that schema.
  bool apply(const clickhouse::Block& block);
};

} // namespace chdash
