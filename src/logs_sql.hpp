#pragma once

// Each statement of the Logs routes (docs/logs.md) is a pure function. It takes the request and the schema of the table.
// Each statement filters on the primary-key columns first. ServiceName passes the allowlist and the service filter.
//
// TimestampTime and Timestamp pass the time range. Each statement searches Body with hasToken().
// So the tokenbf_v1 index of the exporter skips granules. Each statement has a max_execution_time guard and a max_rows_to_read guard.
// The values that a user writes are query parameters (sql_params.hpp).
// The statement holds the {pN:String} placeholders, and its `params` hold the values.

#include "logs_filters.hpp"
#include "otel_caches.hpp"
#include "otel_settings.hpp"
#include "sql_params.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {
namespace logs {

// Per-query guards. A query that reads more rows fails with logs_scan_limit.
// This stops a scan of a table of billions of rows.
constexpr int kMaxExecutionSeconds = 30;
constexpr uint64_t kMaxRowsToRead = 1000000000ULL;
constexpr size_t kBodyMaxChars = 16384;
// The patterns read the first characters of each body.
constexpr int kPatternBodyChars = 2048;
// A sample is whole blocks of this many rows.
constexpr int kSampleBlockRows = 64;

std::string settings_clause(int max_execution_seconds = kMaxExecutionSeconds);

// "`database`.`table`".
std::string table_name(const LogSettings& logs);

// ---- the schema probe (system tables only) ----

SqlStatement schema_columns_statement(const LogSettings& logs);
SqlStatement schema_indexes_statement(const LogSettings& logs);

// ---- time, order and the keyset ----

// The time predicate for Timestamp in [lo_ns, hi_ns] has two parts.
// It has the coarse TimestampTime bound (the primary key of the older exporter layout), and the exact Timestamp bound.
std::string time_predicate(const LogsSchema& schema, int64_t lo_ns, int64_t hi_ns);
// The stable tiebreak orders records that share a Timestamp.
// The order of the pages is Timestamp DESC, then tiebreak DESC.
std::string tiebreak_expr(const LogsSchema& schema);
std::string ts_literal(int64_t ns);

struct Cursor {
  int64_t ts_ns = 0;
  uint64_t tie = 0;
};

// "<timestamp ns>-<tiebreak>".
bool parse_cursor(const std::string& text, Cursor* out);
std::string cursor_text(const Cursor& cursor);
bool parse_u64(const std::string& text, uint64_t* out);

// Rows strictly after or before (ts, tie) in (Timestamp, tiebreak) order.
std::string keyset_predicate(const std::string& tie_expr, const Cursor& cursor, bool older);

// The columns of a row, in the order that the reader of a row expects.
std::string row_columns(const LogsSchema& schema);

// ---- the routes ----

// One window of the search returns the newest `limit` rows of [lo_ns, hi_ns].
// The cursor applies to the first window only, when the caller gives one.
SqlStatement search_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t lo_ns, int64_t hi_ns,
                              const std::optional<Cursor>& after, size_t limit, int window_seconds);

// The bucket sizes of the histogram, and the grid that its buckets lie on.
int64_t choose_bucket_ms(int64_t range_ms, int target);
int64_t grid_floor(int64_t t, int64_t size, int64_t origin);
std::string bucket_sql(const LogsSchema& schema, int64_t size, int64_t origin);
SqlStatement histogram_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t bucket_ms, int64_t origin);

// The records around one record. The older records are in [ts - window, anchor), newest first.
// The anchor and the newer records are in [anchor, ts + window], oldest first.
// The `filter` and `params` come from the preset (build_context_filter).
// `limit` is the number of records requested on each side.
SqlStatement context_older_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit);
SqlStatement context_newer_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit);

// The patterns: the count of the matching records, then a sample of them.
// A sample larger than `target` is a deterministic sample of whole blocks. The blocks are picked by a hash of (part, block).
// Only the filter columns are read for every row. Body is read for the granules that hold a picked block.
//
// This uses about 1/5 of the bytes of ORDER BY rand().
// `rate_ppm` is its share. The value 0 means a read of every record.
SqlStatement patterns_count_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query);
SqlStatement patterns_sample_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, uint64_t rate_ppm,
                                       size_t fetch_limit);
// The share of a block sample, in parts per million, for `target` rows out of `total`.
uint64_t sample_rate_ppm(uint64_t total, size_t target);

// The service picker. ServiceName leads the sorting key.
// So this reads one LowCardinality column.
SqlStatement services_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query);

// ---- the facets of the Fields panel ----
// The scopes are "log", "resource" and "scope". They are the LogAttributes, ResourceAttributes and ScopeAttributes maps (Map columns only).
// The scope "column" is for the record columns below. A key=value filter compares them, except the unique TraceId and SpanId.

extern const char* const kFacetColumns[4];
bool facet_column_known(const std::string& name);
bool facet_column_present(const LogsSchema& schema, const std::string& name);
const char* facet_map_column(const std::string& scope);
bool facet_map_present(const LogsSchema& schema, const std::string& scope);
int facet_scope_rank(const std::string& scope);

// A facet request scans a window that aligns to the minute. Requests made within one minute share one cached scan.
// The window is [start, end], both ends included.
struct FacetWindow {
  int64_t start_ms = 0, end_ms = 0;
};
FacetWindow facet_window(const LogsQuery& query);

// The keys of the fields come from one capped pass. The pass reads the key subcolumns of the maps and the columns.
// `scopes` lists the maps that the table has. `columns` lists the record columns that it has.
SqlStatement facet_keys_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                  const std::vector<std::string>& scopes, const std::vector<std::string>& columns);
// The top values of one field.
SqlStatement facet_values_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                    const std::string& scope, const std::string& key, int limit);

}  // namespace logs
}  // namespace chdash
