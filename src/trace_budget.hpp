#pragma once

// This header defines the bounds of the reads of one route of the Traces page. The page has bounds already: the deadline of the
// request, a memory cap and a read cap (generated_queries, docs/configuration.md, "The bounds of the queries"). A route that
// knows its own work adds a narrower bound. This bound is the time that all its statements share, and a read cap for each
// statement.
//
// The statements of the route run inside a BudgetScope. The scope narrows the bounds of the request. It never raises a bound. A
// deadline that is sooner, or a cap that is lower, remains in effect.
//
// A statement gets max_execution_time = the time that remains for the route. When no time remains, the statement fails at once.
// It does not reach ClickHouse (ch_query.hpp). A route that can answer with its partial result asks the scope for `remaining_ms`
// before the time runs out.

#include "ch_query.hpp"
#include "request_context.hpp"

#include <chrono>
#include <cstdint>
#include <limits>

namespace chdash {
namespace trace {

struct RouteBudget {
  int64_t time_ms = 0;            // the time that all the statements of the route share; 0: the one of the request
  uint64_t max_rows_to_read = 0;  // what each statement may read; 0: the one of the request
};

// This budget applies to the search: the pages of the index, the span aggregation (used when the index cannot answer), and the
// summary of the traces.
constexpr RouteBudget kSearchBudget{45 * 1000, 0};
// This budget applies to the charts: one aggregation of the spans of the window.
constexpr RouteBudget kAnalyticsBudget{45 * 1000, 0};
// This budget applies to one trace. The trace index gives the window of the trace. Therefore its statements read a few granules.
constexpr RouteBudget kTraceDetailBudget{20 * 1000, 2'000'000'000ULL};

// This function returns `limits` with the bounds of `budget` where they are narrower. The argument `now` is the start of the
// route.
inline ChQueryLimits narrowed_limits(ChQueryLimits limits, const RouteBudget& budget, std::chrono::steady_clock::time_point now) {
  if (budget.time_ms > 0) {
    const auto deadline = now + std::chrono::milliseconds(budget.time_ms);
    if (limits.deadline == std::chrono::steady_clock::time_point{} || deadline < limits.deadline) limits.deadline = deadline;
  }
  if (budget.max_rows_to_read > 0 && (limits.max_rows_to_read == 0 || budget.max_rows_to_read < limits.max_rows_to_read)) {
    limits.max_rows_to_read = budget.max_rows_to_read;
    if (limits.read_overflow_mode.empty()) limits.read_overflow_mode = "throw";
  }
  return limits;
}

class BudgetScope {
 public:
  BudgetScope(const RequestContext& context, const RouteBudget& budget)
      : limits_(narrowed_limits(context.limits, budget, std::chrono::steady_clock::now())), scope_(limits_) {}
  BudgetScope(const BudgetScope&) = delete;
  BudgetScope& operator=(const BudgetScope&) = delete;

  // The time that remains before the deadline of the route. The largest number applies when the route has no deadline.
  int64_t remaining_ms() const {
    if (limits_.deadline == std::chrono::steady_clock::time_point{}) return std::numeric_limits<int64_t>::max();
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(limits_.deadline - std::chrono::steady_clock::now()).count();
    return left < 0 ? 0 : static_cast<int64_t>(left);
  }

  const ChQueryLimits& limits() const { return limits_; }

 private:
  ChQueryLimits limits_;
  ChQueryScope scope_;
};

}  // namespace trace
}  // namespace chdash
