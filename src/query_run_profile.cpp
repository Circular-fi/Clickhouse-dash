#include "query_run_profile.hpp"

#include <clickhouse/columns/enum.h>
#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>

#include <algorithm>
#include <limits>
#include <string_view>

namespace chdash {

bool RunProfile::apply(const clickhouse::Block& block) {
  if (block.GetRowCount() == 0) return false;

  auto column_index = [&](std::string_view expected) -> int {
    for (size_t i = 0; i < block.GetColumnCount(); ++i) {
      if (block.GetColumnName(i) == expected) return static_cast<int>(i);
    }
    return -1;
  };

  const int host_index = column_index("host_name");
  const int thread_index = column_index("thread_id");
  const int type_index = column_index("type");
  const int name_index = column_index("name");
  const int value_index = column_index("value");
  if (host_index < 0 || thread_index < 0 || type_index < 0 ||
      name_index < 0 || value_index < 0) {
    return false;
  }

  const auto hosts = block[static_cast<size_t>(host_index)]->As<clickhouse::ColumnString>();
  const auto threads = block[static_cast<size_t>(thread_index)]->As<clickhouse::ColumnUInt64>();
  const auto types = block[static_cast<size_t>(type_index)]->As<clickhouse::ColumnEnum8>();
  const auto names = block[static_cast<size_t>(name_index)]->As<clickhouse::ColumnString>();
  const auto values_i64 = block[static_cast<size_t>(value_index)]->As<clickhouse::ColumnInt64>();
  const auto values_u64 = block[static_cast<size_t>(value_index)]->As<clickhouse::ColumnUInt64>();
  if (!hosts || !threads || !types || !names || (!values_i64 && !values_u64)) return false;

  auto saturating_add = [](int64_t current, int64_t increment) {
    if (increment <= 0) return current;
    if (current > std::numeric_limits<int64_t>::max() - increment) {
      return std::numeric_limits<int64_t>::max();
    }
    return current + increment;
  };
  auto sum_gauges = [](const std::unordered_map<std::string, int64_t>& gauges) {
    __int128 total = 0;
    for (const auto& item : gauges) total += std::max<int64_t>(0, item.second);
    if (total > std::numeric_limits<int64_t>::max()) {
      return std::numeric_limits<int64_t>::max();
    }
    return static_cast<int64_t>(total);
  };

  for (size_t row = 0; row < block.GetRowCount(); ++row) {
    if (threads->At(row) != 0) continue;

    const std::string_view event_type = types->NameAt(row);
    const std::string_view event_name = names->At(row);
    int64_t value = 0;
    if (values_i64) {
      value = values_i64->At(row);
    } else {
      const uint64_t unsigned_value = values_u64->At(row);
      value = unsigned_value > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())
        ? std::numeric_limits<int64_t>::max()
        : static_cast<int64_t>(unsigned_value);
    }

    if (event_type == "increment") {
      if (event_name == "UserTimeMicroseconds") {
        cpu_time_available = true;
        user_time_us_total = saturating_add(user_time_us_total, value);
      } else if (event_name == "SystemTimeMicroseconds") {
        cpu_time_available = true;
        system_time_us_total = saturating_add(system_time_us_total, value);
      }
      continue;
    }

    if (event_type != "gauge") continue;
    const std::string_view host_view = hosts->At(row);
    const std::string host(host_view.data(), host_view.size());
    const int64_t gauge_value = std::max<int64_t>(0, value);
    if (event_name == "MemoryTrackerUsage") {
      memory_usage_by_host[host] = gauge_value;
      current_mem_bytes = sum_gauges(memory_usage_by_host);
    } else if (event_name == "MemoryTrackerPeakUsage") {
      peak_memory_usage_by_host[host] = gauge_value;
      peak_mem_bytes = sum_gauges(peak_memory_usage_by_host);
    }
  }
  return true;
}

} // namespace chdash
