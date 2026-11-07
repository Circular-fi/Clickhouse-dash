#include "mcp_access.hpp"

#include <algorithm>
#include <limits>

namespace chdash {
namespace {

void lower_member(std::optional<int64_t>* mine, const std::optional<int64_t>& other) {
  if (!other) return;
  if (!*mine || *other < **mine) *mine = other;
}

} // namespace

bool McpCeilings::any() const {
  return max_rows || max_duration_seconds || max_rows_read || max_memory_bytes || max_result_bytes || max_bytes_read;
}

void McpCeilings::lower(const McpCeilings& other) {
  lower_member(&max_rows, other.max_rows);
  lower_member(&max_duration_seconds, other.max_duration_seconds);
  lower_member(&max_rows_read, other.max_rows_read);
  lower_member(&max_memory_bytes, other.max_memory_bytes);
  lower_member(&max_result_bytes, other.max_result_bytes);
  lower_member(&max_bytes_read, other.max_bytes_read);
}

bool mcp_ceilings_of(const PdpLimits& limits, McpCeilings* out, std::string* refused) {
  McpCeilings found;
  for (const auto& [name, raw] : limits) {
    std::optional<int64_t>* member = nullptr;
    if (name == "max_rows") member = &found.max_rows;
    else if (name == "max_duration") member = &found.max_duration_seconds;
    else if (name == "max_rows_read") member = &found.max_rows_read;
    else if (name == "max_memory") member = &found.max_memory_bytes;
    else if (name == "max_result_size") member = &found.max_result_bytes;
    else if (name == "max_read_size") member = &found.max_bytes_read;
    // An unknown name, and a value below the minimum of every ceiling (1), cannot be applied.
    if (!member || raw < 1) {
      if (refused) *refused = name;
      return false;
    }
    *member = static_cast<int64_t>(std::min<uint64_t>(raw, static_cast<uint64_t>(std::numeric_limits<int64_t>::max())));
  }
  if (out) *out = found;
  return true;
}

int64_t mcp_apply_ceiling(int64_t value, const std::optional<int64_t>& ceiling, bool* binds, bool zero_is_none) {
  if (binds) *binds = false;
  if (!ceiling) return value;
  if (zero_is_none && value == 0) {
    if (binds) *binds = true;
    return *ceiling;
  }
  if (*ceiling >= value) return value;
  if (binds) *binds = true;
  return *ceiling;
}

} // namespace chdash
