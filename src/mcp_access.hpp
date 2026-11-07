#pragma once

// The types that the MCP endpoint shares with the access of the identity mode (docs/mcp.md, "The identity mode"): the three results of
// an access check and the ceilings of a true answer. Pure code: no I/O.

#include "access_pdp.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// The result of an access check of the MCP endpoint (binding 5.1 and 5.5).
enum class McpAccess {
  Allowed,
  Denied,  // false: the answer of a tool that does not exist (-32602), or HTTP 403 for another request
  Failed,  // the PDP gave no valid answer: HTTP 503 with -32603
};

// The ceilings that a call must keep (ProcurAuth 7.3, 7.5). Each member is the lowest ceiling of the actions that the tool uses.
// The six names of the PDP and the settings that they lower:
//   max_rows -> the rows that a call returns       max_duration (seconds) -> the time of a call
//   max_rows_read -> max_rows_to_read              max_memory (bytes) -> max_memory_usage
//   max_read_size (bytes) -> max_bytes_to_read     max_result_size (bytes) -> the bytes that a call returns
// A call never gets more than the configuration gives. The ceiling can only lower a value. An API tool gives the ceilings to the route
// that it calls (RequestContext::mcp_ceilings), so the route applies them as it does for the pages.
struct McpCeilings {
  std::optional<int64_t> max_rows;
  std::optional<int64_t> max_duration_seconds;
  std::optional<int64_t> max_rows_read;
  std::optional<int64_t> max_memory_bytes;
  std::optional<int64_t> max_result_bytes;
  std::optional<int64_t> max_bytes_read;

  bool any() const;
  // Keep the lower value of each member (the lowest ceiling of several actions).
  void lower(const McpCeilings& other);
};

// The ceilings of `limits`. The result is false when MCP cannot apply one of them: a name that is not one of the six ceilings of the
// document, or a value below 1 (0 means unlimited in ClickHouse). The caller first checks that the action of the tool declares each name
// (access_ceilings_enforceable). Then `*refused` has the first name (when it is not
// null), and the caller treats the answer as false (ProcurAuth 7.5). A value above the largest whole number lowers nothing, so it
// counts as the largest whole number.
bool mcp_ceilings_of(const PdpLimits& limits, McpCeilings* out, std::string* refused = nullptr);

// The value of a limit after a ceiling: the lower of the two. `*binds` (when it is not null) is true when the ceiling is below the
// value, so the ceiling is the limit that binds. No ceiling gives `value`. A `value` of 0 is "no limit" when `zero_is_none` is true.
// The one function that the call of a tool (McpTools) and the limits of a host (mcp_host_limits) use.
int64_t mcp_apply_ceiling(int64_t value, const std::optional<int64_t>& ceiling, bool* binds = nullptr, bool zero_is_none = false);

} // namespace chdash
