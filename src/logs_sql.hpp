#pragma once

// Every statement of the Logs routes (docs/logs.md) as a pure function of the request and the schema of the table. Each statement filters on
// the primary-key columns first (ServiceName through the allowlist and the service filter, TimestampTime and Timestamp through the time
// range), searches Body with hasToken() so the tokenbf_v1 index of the exporter skips granules, and carries a max_execution_time and a
// max_rows_to_read guard. The values that a user wrote are query parameters (sql_params.hpp): the statement holds the {pN:String}
// placeholders and its `params` hold the values.

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

// Per-query guards. A query that would read more rows fails with logs_scan_limit instead of scanning a table of billions of rows.
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

// Time predicate for Timestamp in [lo_ns, hi_ns]: the coarse TimestampTime bound (the primary key of the older exporter layout) plus the
// exact one.
std::string time_predicate(const LogsSchema& schema, int64_t lo_ns, int64_t hi_ns);
// Stable tiebreak for records that share a Timestamp (the order of the pages is Timestamp DESC, tiebreak DESC).
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

// Rows strictly after / before (ts, tie) in (Timestamp, tiebreak) order.
std::string keyset_predicate(const std::string& tie_expr, const Cursor& cursor, bool older);

// The columns of a row, in the order that the reader of a row expects.
std::string row_columns(const LogsSchema& schema);

// ---- the routes ----

// One window of the search: the newest `limit` rows of [lo_ns, hi_ns], after the cursor when one is given (the first window only).
SqlStatement search_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t lo_ns, int64_t hi_ns,
                              const std::optional<Cursor>& after, size_t limit, int window_seconds);

// The bucket sizes of the histogram and the grid that its buckets lie on.
int64_t choose_bucket_ms(int64_t range_ms, int target);
int64_t grid_floor(int64_t t, int64_t size, int64_t origin);
std::string bucket_sql(const LogsSchema& schema, int64_t size, int64_t origin);
SqlStatement histogram_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, int64_t bucket_ms, int64_t origin);

// The records around one record: the older ones, [ts - window, anchor), newest first; the anchor and the newer ones, [anchor, ts + window],
// oldest first. `filter` and `params` are the preset (build_context_filter). `limit` is the number of records wanted on each side.
SqlStatement context_older_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit);
SqlStatement context_newer_statement(const LogsSchema& schema, const std::string& table, const std::string& filter, const SqlParams& params,
                                     int64_t ts_ns, const std::optional<uint64_t>& tie, int64_t delta_ns, size_t limit);

// The patterns: the count of the matching records, then a sample of them. A sample larger than `target` is a deterministic sample of whole
// blocks, picked by a hash of (part, block): only the filter columns are read for every row, and Body for the granules that hold a picked
// block (about 1/5 of the bytes of ORDER BY rand()). `rate_ppm` is its share, 0 for a read of every record.
SqlStatement patterns_count_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query);
SqlStatement patterns_sample_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, uint64_t rate_ppm,
                                       size_t fetch_limit);
// The share of a block sample, in parts per million, for `target` rows out of `total`.
uint64_t sample_rate_ppm(uint64_t total, size_t target);

// The service picker: ServiceName leads the sorting key, so this reads one LowCardinality column.
SqlStatement services_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query);

// ---- the facets of the Fields panel ----
// Scopes: "log", "resource" and "scope" (the LogAttributes, ResourceAttributes and ScopeAttributes maps, Map columns only) and "column"
// (the record columns below: the ones a key=value filter compares, minus the unique TraceId and SpanId).

extern const char* const kFacetColumns[4];
bool facet_column_known(const std::string& name);
bool facet_column_present(const LogsSchema& schema, const std::string& name);
const char* facet_map_column(const std::string& scope);
bool facet_map_present(const LogsSchema& schema, const std::string& scope);
int facet_scope_rank(const std::string& scope);

// The minute-aligned window that a facet request scans (requests made within one minute share one cached scan), [start, end] inclusive.
struct FacetWindow {
  int64_t start_ms = 0, end_ms = 0;
};
FacetWindow facet_window(const LogsQuery& query);

// The keys of the fields: one capped pass that reads the key subcolumns of the maps and the columns. `scopes` are the maps that the table
// has, `columns` the record columns that it has.
SqlStatement facet_keys_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                  const std::vector<std::string>& scopes, const std::vector<std::string>& columns);
// The top values of one field.
SqlStatement facet_values_statement(const LogsSchema& schema, const std::string& table, const LogsQuery& query, const FacetWindow& window,
                                    const std::string& scope, const std::string& key, int limit);

}  // namespace logs
}  // namespace chdash
