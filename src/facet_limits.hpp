#pragma once

// Attribute facet discovery. It is shared by /api/traces/facets (api_traces.cpp) and
// /api/logs/facets (api_logs.cpp).
// Both routes use one set of caps. So the Traces Attributes and the Logs Fields panels sample, cap and estimate in the same way.

#include "ch_query.hpp"

#include <clickhouse/client.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

// A SELECT whose work is capped by its SETTINGS (read limit or time budget).
// Read whether a cap cut the scan from what the caps act on. Do not read it from
// the progress packets' total_rows_to_read. ClickHouse announces that value after
// the primary key analysis. It announces it before the skip indexes (the attribute bloom
// filters) and the query condition cache drop granules.
//
// So a scan that read every row it had to can still read fewer rows than announced (a selective tag
// on a rich hour: 85 k of 456 k). The read cap (max_rows_to_read with
// read_overflow_mode = 'break') stops the sources when the rows read reach
// it. So read_rows >= cap is the sign that it stopped the scan (capped()).
//
// A LIMIT is checked against the rows that it returned. The time budget is checked against
// the elapsed time (timed_out()). Progress fields are per-packet deltas.
struct BoundedRead {
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t total_rows = 0;
  uint64_t elapsed_ms = 0;
  bool capped(uint64_t read_rows_cap) const { return read_rows_cap > 0 && read_rows >= read_rows_cap; }
};

// params: query parameters ({name:Type} in the SQL). They are sent apart from the SQL
// text. So a value is never parsed as SQL.
inline BoundedRead bounded_select(clickhouse::Client& client, const std::string& sql,
                                  const std::function<void(const clickhouse::Block&)>& on_block,
                                  const std::vector<std::pair<std::string, std::string>>& params = {}) {
  BoundedRead out;
  const auto started = std::chrono::steady_clock::now();
  clickhouse::Query query(sql, ch_statement_query_id());
  for (const auto& [name, value] : params) query.SetParam(name, value);
  // The caller of the request can go away while the scan runs (ch_query.hpp).
  query.OnData([&on_block](const clickhouse::Block& block) {
    ch_check_canceled();
    on_block(block);
  });
  query.OnProgress([&](const clickhouse::Progress& progress) {
    out.read_rows += progress.rows;
    out.read_bytes += progress.bytes;
    out.total_rows += progress.total_rows;
    ch_check_canceled();
  });
  ch_execute(client, query);
  out.elapsed_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count());
  return out;
}

// Attribute discovery caps (after HyperDX's metadata queries). The first cap is an inner LIMIT
// of sampled rows (spans or log records). The second cap is a hard cap on the rows read from
// storage. A selective filter otherwise scans the whole window to find enough rows.
//
// The third cap is a GROUP BY size cap for high-cardinality values. The fourth cap is a time budget.
// The read cap breaks like an exhausted source. So the aggregation still answers from the rows that were read.
//
// The time budget is a last resort. A timeout break can drop the partial aggregate. It is reported as an estimate too.
constexpr uint64_t kFacetSampleRows = 3000000;
constexpr uint64_t kFacetReadRowsCap = 50000000;
constexpr uint64_t kFacetGroupByCap = 100000;
constexpr int kFacetTimeBudgetSeconds = 5;
// Answers are cached per minute-aligned window for this duration.
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
