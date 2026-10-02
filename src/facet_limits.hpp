#pragma once

// Attribute facet discovery shared by /api/traces/facets (api_traces.cpp) and
// /api/logs/facets (api_logs.cpp): one set of caps, so the Traces Attributes
// and the Logs Fields panels sample, cap and estimate the same way.

#include <clickhouse/client.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace chdash {

// A SELECT whose work is capped by its SETTINGS (read limit / time budget):
// the progress packets tell whether it read every row it would have read
// (read_rows == total_rows_to_read) or stopped early (LIMIT, a read_overflow
// or timeout_overflow break), i.e. whether its answer is only an estimate.
// Both progress fields are per-packet deltas.
struct BoundedRead {
  uint64_t read_rows = 0;
  uint64_t total_rows = 0;
  uint64_t elapsed_ms = 0;
  bool partial() const { return read_rows < total_rows; }
};

inline BoundedRead bounded_select(clickhouse::Client& client, const std::string& sql,
                                  const std::function<void(const clickhouse::Block&)>& on_block) {
  BoundedRead out;
  const auto started = std::chrono::steady_clock::now();
  clickhouse::Query query(sql);
  query.OnData(on_block);
  query.OnProgress([&](const clickhouse::Progress& progress) {
    out.read_rows += progress.rows;
    out.total_rows += progress.total_rows;
  });
  client.Execute(query);
  out.elapsed_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count());
  return out;
}

// Attribute discovery caps (after HyperDX's metadata queries): an inner LIMIT
// of sampled rows (spans or log records), a hard cap on the rows read from
// storage (a selective filter would otherwise scan the whole window looking
// for enough rows), a GROUP BY size cap for high-cardinality values and a
// time budget. The read cap breaks like an exhausted source, so the
// aggregation still answers from what was read; the time budget is a last
// resort (a timeout break may drop the partial aggregate) and is reported as
// an estimate as well.
constexpr uint64_t kFacetSampleRows = 3000000;
constexpr uint64_t kFacetReadRowsCap = 50000000;
constexpr uint64_t kFacetGroupByCap = 100000;
constexpr int kFacetTimeBudgetSeconds = 5;
// Answers are cached per minute-aligned window for this long.
constexpr uint64_t kFacetTtlMs = 60 * 1000;
constexpr size_t kFacetMaxKeys = 500;
constexpr int kFacetMaxValues = 500;
constexpr size_t kFacetMaxKeyBytes = 512;

inline std::string facet_settings_sql(uint64_t read_rows_cap, bool group_by_cap) {
  std::string out = " SETTINGS max_execution_time = " + std::to_string(kFacetTimeBudgetSeconds) +
      ", timeout_overflow_mode = 'break', max_rows_to_read = " + std::to_string(read_rows_cap) +
      ", read_overflow_mode = 'break'";
  if (group_by_cap) {
    out += ", max_rows_to_group_by = " + std::to_string(kFacetGroupByCap) + ", group_by_overflow_mode = 'any'";
  }
  return out;
}

inline bool timed_out(const BoundedRead& read) {
  return read.elapsed_ms + 250 >= static_cast<uint64_t>(kFacetTimeBudgetSeconds) * 1000;
}

} // namespace chdash
