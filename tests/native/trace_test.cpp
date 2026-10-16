// Unit tests of the Traces page below its routes. These tests cover the parse of a request (src/trace_request.cpp).
// They also cover the span filters and the SQL that they become (src/trace_filters.cpp), and the statements (src/trace_sql.cpp).
// They also cover the strategies of the search and of the analytics. These run on a fake executor, with no ClickHouse server.
//
// The texts that these tests expect are the texts that the code before the split logged for the same requests. A statement whose text changes fails here.
// If you change a statement on purpose, change the expected text in the same commit.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_TRACE_TESTS=ON
//        cmake --build build --target chdash_trace_test
// Run:   ./build/chdash_trace_test   (exit code 0 = every check passed)

#include "api_error.hpp"
#include "fake_executor.hpp"
#include "native_check.hpp"
#include "ch_error.hpp"
#include "ch_executor.hpp"
#include "trace_analytics.hpp"
#include "trace_facets.hpp"
#include "trace_attributes.hpp"
#include "trace_budget.hpp"
#include "trace_detail.hpp"
#include "trace_filters.hpp"
#include "trace_golden.hpp"
#include "trace_json.hpp"
#include "trace_request.hpp"
#include "trace_search.hpp"
#include "trace_service.hpp"
#include "trace_services.hpp"
#include "trace_spans.hpp"
#include "trace_sql.hpp"

#include <clickhouse/columns/numeric.h>
#include <clickhouse/columns/string.h>
#include <httplib.h>
#include <rapidjson/document.h>

#include <cmath>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using namespace chdash;
using namespace chdash::trace;
using namespace nt;

namespace {

httplib::Request request(std::initializer_list<std::pair<const char*, const char*>> params) {
  httplib::Request req;
  req.method = "GET";
  for (const auto& [name, value] : params) req.params.emplace(name, value);
  return req;
}

// The " AND ..." filter text of a request. The search puts it after `WHERE 1`. Both attribute maps are usable.
std::string filter_sql_of(std::initializer_list<std::pair<const char*, const char*>> params, std::string* error = nullptr,
                          std::string* code = nullptr) {
  const auto req = request(params);
  TraceFilterSpec spec;
  std::string parse_error;
  if (!parse_trace_filters(req, &spec, &parse_error)) {
    if (error) *error = parse_error;
    return "<invalid>";
  }
  AttributeColumns columns;
  columns.span_map = columns.resource_map = true;
  std::string tags, tag_code, tag_error;
  if (!tag_filters_sql(spec.tags, columns, &tags, &tag_code, &tag_error)) {
    if (error) *error = tag_error;
    if (code) *code = tag_code;
    return "<unusable>";
  }
  return span_filters_sql(spec, tags);
}

// ---- the filters ----

void test_column_filters() {
  CHECK_EQ(filter_sql_of({{"service", "api-gateway"}, {"operation", "GET /api/v1/home"}}),
           std::string(" AND ServiceName = 'api-gateway' AND SpanName = 'GET /api/v1/home'"));
  // A column with several values matches any one of them. The values are sorted and have no duplicates.
  CHECK_EQ(filter_sql_of({{"service", "auth"}, {"service", "api-gateway"}, {"service", "auth"}}),
           std::string(" AND ServiceName IN ('api-gateway', 'auth')"));
  CHECK_EQ(filter_sql_of({{"service_not", "api-gateway"}}), std::string(" AND NOT (ServiceName = 'api-gateway')"));
  CHECK_EQ(filter_sql_of({{"operation_not", "GET /api/v1/home"}}), std::string(" AND NOT (SpanName = 'GET /api/v1/home')"));
  CHECK_EQ(filter_sql_of({{"status_not", "Ok"}}), std::string(" AND NOT (StatusCode = 'Ok')"));
  CHECK_EQ(filter_sql_of({{"status", "Error"}}), std::string(" AND StatusCode = 'Error'"));
  CHECK_EQ(filter_sql_of({}), std::string());
  // An empty value sets no filter.
  CHECK_EQ(filter_sql_of({{"service", ""}, {"status", ""}}), std::string());
}

void test_tag_filters() {
  const std::string value = "frontend.shop.svc.cluster.local";
  const std::string span_eq = "(mapContains(SpanAttributes, 'server.address') AND SpanAttributes['server.address'] = '" + value + "')";
  const std::string resource_eq = "(mapContains(ResourceAttributes, 'server.address') AND ResourceAttributes['server.address'] = '" + value + "')";
  CHECK_EQ(filter_sql_of({{"tag", "span:server.address=frontend.shop.svc.cluster.local"}}), " AND " + span_eq);
  // No scope: either map applies.
  CHECK_EQ(filter_sql_of({{"tag", "server.address=frontend.shop.svc.cluster.local"}}), " AND (" + span_eq + " OR " + resource_eq + ")");
  CHECK_EQ(filter_sql_of({{"tag_not", "span:server.address=frontend.shop.svc.cluster.local"}}), " AND NOT " + span_eq);
  CHECK_EQ(filter_sql_of({{"tag_exists", "span:server.address"}}), std::string(" AND mapContains(SpanAttributes, 'server.address')"));
  CHECK_EQ(filter_sql_of({{"tag_missing", "span:server.address"}}), std::string(" AND NOT mapContains(SpanAttributes, 'server.address')"));
  // The older single-tag form gives the same filter.
  CHECK_EQ(filter_sql_of({{"tag_scope", "span"}, {"tag_key", "server.address"}, {"tag_value", "frontend.shop.svc.cluster.local"}}),
           " AND " + span_eq);
  // Several values of one key: any one of them matches.
  CHECK_EQ(filter_sql_of({{"tag", "span:k=b"}, {"tag", "span:k=a"}}),
           std::string(" AND (mapContains(SpanAttributes, 'k') AND SpanAttributes['k'] IN ('a', 'b'))"));
  // The code escapes a quote in a value. The quote is never SQL.
  CHECK_EQ(filter_sql_of({{"tag", "span:k=a' OR 1=1 --"}}),
           std::string(" AND (mapContains(SpanAttributes, 'k') AND SpanAttributes['k'] = 'a\\' OR 1=1 --')"));
}

void test_filter_errors() {
  std::string error;
  CHECK_EQ(filter_sql_of({{"status", "Bad"}}, &error), std::string("<invalid>"));
  CHECK_EQ(error, std::string("status must be Error, Ok, Unset, or empty."));
  filter_sql_of({{"status_not", "Bad"}}, &error);
  CHECK_EQ(error, std::string("status_not must be Error, Ok or Unset."));
  filter_sql_of({{"tag", "nokey"}}, &error);
  CHECK_EQ(error, std::string("tag must be [span:|resource:]key=value."));
  filter_sql_of({{"tag", "=v"}}, &error);
  CHECK_EQ(error, std::string("tag must be [span:|resource:]key=value."));
  filter_sql_of({{"tag_exists", "span:"}}, &error);
  CHECK_EQ(error, std::string("tag_exists needs an attribute key."));
  filter_sql_of({{"tag_key", "k"}}, &error);
  CHECK_EQ(error, std::string("tag_key and tag_value must be provided together."));
  filter_sql_of({{"tag_key", "k"}, {"tag_value", "v"}, {"tag_scope", "elsewhere"}}, &error);
  CHECK_EQ(error, std::string("tag_scope must be span, resource, or any."));
  filter_sql_of({{"tag_exists", ("span:" + std::string(513, 'k')).c_str()}}, &error);
  CHECK_EQ(error, std::string("Attribute keys are limited to 512 bytes."));
  filter_sql_of({{"tag", ("k=" + std::string(4097, 'v')).c_str()}}, &error);
  CHECK_EQ(error, std::string("Attribute values are limited to 4096 bytes."));
  // At most 32 attribute filters.
  httplib::Request many;
  for (int i = 0; i < 33; ++i) many.params.emplace("tag_exists", "k" + std::to_string(i));
  TraceFilterSpec spec;
  CHECK(!parse_trace_filters(many, &spec, &error));
  CHECK_EQ(error, std::string("At most 32 attribute filters are accepted."));
}

void test_unusable_attribute_maps() {
  const auto req = request({{"tag", "span:k=v"}});
  TraceFilterSpec spec;
  std::string error;
  CHECK(parse_trace_filters(req, &spec, &error));
  std::string out, code;
  // The column is not a Map. The result is 400 trace_tag_search_unsupported.
  AttributeColumns plain;
  CHECK(!tag_filters_sql(spec.tags, plain, &out, &code, &error));
  CHECK_EQ(code, std::string("trace_tag_search_unsupported"));
  CHECK_EQ(filter_error_status(code), 400);
  // The columns cannot be read. This is a failure of the server: 503 trace_schema_unavailable.
  AttributeColumns unknown;
  unknown.lookup_failed = true;
  CHECK(!tag_filters_sql(spec.tags, unknown, &out, &code, &error));
  CHECK_EQ(code, std::string("trace_schema_unavailable"));
  CHECK_EQ(filter_error_status(code), 503);
  // traces.features disables the filter: 400 trace_filter_disabled, whatever the table holds.
  AttributeColumns off;
  off.span_map = true;
  off.span_enabled = false;
  CHECK(!tag_filters_sql(spec.tags, off, &out, &code, &error));
  CHECK_EQ(code, std::string("trace_filter_disabled"));
  CHECK_EQ(error, std::string("Attribute filters on this scope are disabled by traces.features."));
  // The code skips the filters of the facet itself.
  AttributeColumns usable;
  usable.span_map = true;
  out.clear();
  const std::string skip_scope = "span", skip_key = "k";
  CHECK(tag_filters_sql(spec.tags, plain, &out, &code, &error, &skip_scope, &skip_key));
  CHECK_EQ(out, std::string());
}

void test_span_columns() {
  const auto req = request({{"columns", "span:server.address,resource:host.name,span:server.address"}});
  std::vector<SpanAttributeColumn> columns;
  std::string error;
  CHECK(parse_span_columns(req, &columns, &error));
  CHECK_EQ(columns.size(), size_t(2));
  AttributeColumns maps;
  maps.span_map = maps.resource_map = true;
  std::string sql, code;
  CHECK(span_columns_sql(columns, maps, &sql, &code, &error));
  CHECK_EQ(sql, std::string(", toString(toUInt8(mapContains(SpanAttributes, 'server.address'))), toString(SpanAttributes['server.address']), "
                            "toString(toUInt8(mapContains(ResourceAttributes, 'host.name'))), toString(ResourceAttributes['host.name'])"));
  // No scope: the span map first, then the resource map.
  sql.clear();
  CHECK(span_columns_sql({SpanAttributeColumn{"any", "k"}}, maps, &sql, &code, &error));
  CHECK_EQ(sql, std::string(", toString(toUInt8(mapContains(SpanAttributes, 'k') OR mapContains(ResourceAttributes, 'k'))), "
                            "toString(if(mapContains(SpanAttributes, 'k'), SpanAttributes['k'], ResourceAttributes['k']))"));
  CHECK(!parse_span_columns(request({{"columns", ","}, {"columns", "span:"}}), &columns, &error));
  CHECK_EQ(error, std::string("columns entries must be [span:|resource:]key with a 1 to 512 byte key."));
  std::string list;
  for (int i = 0; i < 21; ++i) list += (i ? ",k" : "k") + std::to_string(i);
  columns.clear();
  CHECK(!parse_span_columns(request({{"columns", list.c_str()}}), &columns, &error));
  CHECK_EQ(error, std::string("At most 20 attribute columns are accepted."));
}

// ---- the numbers and the window ----

void test_number_parameters() {
  // A number must be the whole text of the value. Any other text gives the default.
  CHECK_EQ(int_param(request({{"limit", "20"}}), "limit", 100, 1, 500), 20);
  CHECK_EQ(int_param(request({{"limit", "123abc"}}), "limit", 100, 1, 500), 100);
  CHECK_EQ(int_param(request({{"limit", " 12"}}), "limit", 100, 1, 500), 100);
  CHECK_EQ(int_param(request({{"limit", "9999"}}), "limit", 100, 1, 500), 500);
  CHECK_EQ(int_param(request({{"limit", "-4"}}), "limit", 100, 1, 500), 1);
  CHECK_EQ(int_param(request({}), "limit", 100, 1, 500), 100);
  CHECK_EQ(double_param(request({{"d", "1.5"}}), "d", 0.0, 0.0, 10.0), 1.5);
  CHECK_EQ(double_param(request({{"d", "inf"}}), "d", 7.0, 0.0, 10.0), 7.0);
  CHECK_EQ(double_param(request({{"d", "99"}}), "d", 0.0, 0.0, 10.0), 10.0);
  int64_t value = 0;
  CHECK_EQ(parse_i64_param(request({{"n", "42"}}), "n", &value), 1);
  CHECK_EQ(value, int64_t(42));
  CHECK_EQ(parse_i64_param(request({{"n", ""}}), "n", &value), 0);
  CHECK_EQ(parse_i64_param(request({}), "n", &value), 0);
  CHECK_EQ(parse_i64_param(request({{"n", "4x"}}), "n", &value), -1);
}

void test_read_rows_limit() {
  const uint64_t cap = 50000000;
  CHECK_EQ(read_rows_limit_param(request({}), cap), cap);
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "abc"}}), cap), cap);
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "999999999999"}}), cap), cap);
  // The code rounds down to 1, 2 or 5 times a power of ten. The requests then share a few cache keys.
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "3000"}}), cap), uint64_t(2000));
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "7777"}}), cap), uint64_t(5000));
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "1"}}), cap), uint64_t(1));
  CHECK_EQ(read_rows_limit_param(request({{"read_rows_limit", "0"}}), cap), uint64_t(1));
}

TraceSettings settings() {
  TraceSettings s;
  s.default_lookback_minutes = 60;
  s.max_lookback_minutes = 7 * 24 * 60;
  return s;
}

void test_time_range() {
  const auto s = settings();
  int64_t lo = 0, hi = 0;
  std::string error;
  CHECK(trace_time_range(s, request({{"start_ms", "1000"}, {"end_ms", "5000"}}), 99999, &lo, &hi, &error));
  CHECK_EQ(lo, int64_t(1000));
  CHECK_EQ(hi, int64_t(5000));
  // No window: the last default_lookback_minutes before now.
  CHECK(trace_time_range(s, request({}), 10 * 3600 * 1000, &lo, &hi, &error));
  CHECK_EQ(hi, int64_t(10 * 3600 * 1000));
  CHECK_EQ(lo, int64_t(9 * 3600 * 1000));
  CHECK(trace_time_range(s, request({{"lookback_minutes", "5"}}), 10 * 3600 * 1000, &lo, &hi, &error));
  CHECK_EQ(hi - lo, int64_t(5 * 60 * 1000));
  CHECK(!trace_time_range(s, request({{"start_ms", "1000"}}), 1, &lo, &hi, &error));
  CHECK_EQ(error, std::string("start_ms and end_ms must be provided together."));
  CHECK(!trace_time_range(s, request({{"start_ms", "5"}, {"end_ms", "3"}}), 1, &lo, &hi, &error));
  CHECK_EQ(error, std::string("Invalid trace time range."));
  CHECK(!trace_time_range(s, request({{"start_ms", "x"}, {"end_ms", "3"}}), 1, &lo, &hi, &error));
  CHECK_EQ(error, std::string("start_ms must be a whole number of milliseconds."));
  CHECK(!trace_time_range(s, request({{"start_ms", "1"}, {"end_ms", "9223372036854775807"}}), 1, &lo, &hi, &error));
  CHECK_EQ(error, std::string("Invalid trace time range."));
  CHECK(!trace_time_range(s, request({{"start_ms", "1000"}, {"end_ms", "1000000000"}}), 1, &lo, &hi, &error));
  CHECK_EQ(error, std::string("Trace time range exceeds traces.max_lookback_minutes."));
}

void test_disabled_features() {
  auto s = settings();
  s.features.service_filter = false;
  std::string message;
  CHECK(feature_param_rejected(s, request({{"service", "a"}}), &message));
  CHECK_EQ(message, std::string("service filter is disabled by traces.features"));
  CHECK(!feature_param_rejected(s, request({{"service", ""}}), &message));
  CHECK(!feature_param_rejected(s, request({{"operation", "a"}}), &message));
  s.features.duration_filter = false;
  CHECK(feature_param_rejected(s, request({{"max_duration_ms", "4"}}), &message));
  CHECK_EQ(message, std::string("duration filter is disabled by traces.features"));
}

// ---- the statements ----

void test_common_sql() {
  CHECK_EQ(qualified("otel", "otel_traces"), std::string("`otel`.`otel_traces`"));
  CHECK_EQ(qualified("a`b", "t"), std::string("`a\\`b`.`t`"));
  CHECK_EQ(ns_time(1789210800000000000LL), std::string("fromUnixTimestamp64Nano(1789210800000000000)"));
  CHECK_EQ(time_predicate(1789207200000LL, 1789210800000LL),
           std::string("Timestamp >= fromUnixTimestamp64Milli(1789207200000) AND Timestamp <= fromUnixTimestamp64Milli(1789210800000)"));
  const std::string duration = kTraceDurationExpr;
  CHECK_EQ(duration, std::string("(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - toInt64(min(toUnixTimestamp64Nano(Timestamp))))"));
  CHECK_EQ(duration_having(0, 0), std::string());
  CHECK_EQ(duration_having(20, 400),
           " HAVING " + duration + " >= 20000000 AND " + duration + " <= 400000000");
  CHECK_EQ(duration_having(0, 50), " HAVING " + duration + " <= 50000000");
  CHECK_EQ(having_terms(duration_having(5, 0)), duration + " >= 5000000");
  CHECK_EQ(having_terms("a AND b"), std::string("a AND b"));
}

void test_buckets_and_grid() {
  // The code makes about 60 buckets. A bucket is never below a minute.
  CHECK_EQ(choose_bucket_seconds(3600 * 1000LL), 60);
  CHECK_EQ(choose_bucket_seconds(24 * 3600 * 1000LL), 1800);
  CHECK_EQ(choose_bucket_seconds(7 * 24 * 3600 * 1000LL), 10800);
  CHECK_EQ(choose_bucket_seconds(365 * 24 * 3600 * 1000LL), 604800);
  CHECK_EQ(choose_quantile_bucket_seconds(3600 * 1000LL), 60);
  CHECK_EQ(choose_quantile_bucket_seconds(24 * 3600 * 1000LL), 900);
  CHECK_EQ(choose_quantile_bucket_seconds(7 * 24 * 3600 * 1000LL), 7200);
  // The grid: the origin modulo the size. The floor of a time on the grid is also correct before the origin.
  CHECK_EQ(grid_origin_ms(1234567, 60000), int64_t(34567));
  CHECK_EQ(grid_origin_ms(-1, 60000), int64_t(59999));
  CHECK_EQ(grid_floor_ms(100000, 60000, 34567), int64_t(94567));
  CHECK_EQ(grid_floor_ms(100, 60000, 34567), int64_t(-25433));
  CHECK_EQ(grid_floor_ms(34567, 60000, 34567), int64_t(34567));
  CHECK_EQ(grid_bucket_sql("trace_start", 60000, 34567),
           std::string("toString(34567 + intDiv(toUnixTimestamp64Milli(trace_start) - 34567, 60000) * 60000)"));
}


// The golden text, with its placeholders filled.
std::string fill(std::string text, const std::map<std::string, std::string>& values) {
  for (const auto& [key, value] : values) {
    const std::string mark = "@" + key + "@";
    for (size_t at = text.find(mark); at != std::string::npos; at = text.find(mark, at + value.size())) text.replace(at, mark.size(), value);
  }
  return text;
}

// The window of the battery of the differential check: one hour of the rich fixture day.
constexpr int64_t kAStart = 1789207200000LL, kAEnd = 1789210800000LL;
// A whole day of it.
constexpr int64_t kCStart = 1789171200000LL, kCEnd = 1789257600000LL;

TraceScope scope_of(int64_t start, int64_t end, const std::string& filters = "", const std::string& having = "") {
  TraceScope scope;
  scope.table = "`otel`.`otel_traces`";
  scope.index_table = "`otel`.`otel_traces_trace_id_ts`";
  scope.visibility = "1";
  scope.span_filters = filters;
  scope.having = having;
  scope.start_ms = start;
  scope.end_ms = end;
  return scope;
}

const std::string kServiceFilter = " AND ServiceName = 'api-gateway'";
const std::string kTagFilter =
    " AND (mapContains(SpanAttributes, 'server.address') AND SpanAttributes['server.address'] = 'frontend.shop.svc.cluster.local')";

// The code binds the trace ids of a statement ({ids:Array(String)}). It never writes them into its text.
const std::string kIdsParam = "{ids:Array(String)}";

// ---- the statements, against the text that the code before the split wrote ----

void test_search_statements_are_unchanged() {
  const auto a = scope_of(kAStart, kAEnd);
  CHECK_EQ(index_slice_sql(a.index_table, index_window_predicate(kAStart, kAEnd), 1789210740000000001LL, 1789210800000000000LL, 20000),
           std::string(golden::kIndexSliceFirst));
  CHECK_EQ(summary_sql(a, 0, 0, 20), fill(golden::kSummaryIndexBounds, {{"IDS", kIdsParam}}));

  const auto service = scope_of(kAStart, kAEnd, kServiceFilter);
  const std::string batch = batch_ids_sql(service.index_table, index_window_predicate(kAStart, kAEnd), 1789208771633818901LL, 1789210797855243093LL);
  CHECK_EQ(batch_match_sql(service, batch), fill(golden::kBatchMatch, {{"OLDEST", "1789208771633818901"}, {"NEWEST", "1789210797855243093"}}));

  // A broad filter has these statements: the index window size, the probe, the rank in one pass, and the summary with exact bounds.
  const auto both = scope_of(kAStart, kAEnd, kServiceFilter, duration_having(20, 400));
  CHECK_EQ(index_count_sql(both.index_table, kAStart, kAEnd), std::string(golden::kBroadIndexCount));
  CHECK_EQ(broad_probe_sql(both, 1000), std::string(golden::kBroadProbe));
  RankSlice whole;
  whole.scope = &both;
  whole.whole = true;
  whole.having = broad_having(both.span_filters, both.having);
  whole.fetch = 100;
  CHECK_EQ(rank_sql(whole), std::string(golden::kRankBroadDurationWhole));
  CHECK_EQ(summary_sql(both, 1789207260000000000LL, 1789207261500000000LL, 100),
           fill(golden::kSummarySpanBounds, {{"IDS", kIdsParam}, {"FIRST", "1789207260000000000"}, {"END", "1789207261500000000"}}));

  // The newest slice of a wide window. The probe finds the rows of traces that started before it.
  const auto wide = scope_of(kCStart, kCEnd, "", duration_having(100, 0));
  RankSlice slice;
  slice.scope = &wide;
  slice.from_ns = 1789252200000000000LL;
  slice.having = wide.having;
  slice.fetch = 26;
  CHECK_EQ(rank_sql(slice), std::string(golden::kRankSlice));
  CHECK_EQ(rank_probe_sql(wide, 1789252200000000000LL), fill(golden::kRankProbe, {{"IDS", kIdsParam}}));
  const auto wide_service = scope_of(kCStart, kCEnd, kServiceFilter, duration_having(50, 0));
  RankSlice broad_slice;
  broad_slice.scope = &wide_service;
  broad_slice.from_ns = 1789252200000000000LL;
  broad_slice.having = broad_having(wide_service.span_filters, wide_service.having);
  broad_slice.fetch = 21;
  CHECK_EQ(rank_sql(broad_slice), std::string(golden::kRankSliceBroad));
  // A filter on an attribute: the candidate_ids of a CTE hold the traces.
  const auto tagged = scope_of(kAStart, kAEnd, kTagFilter, duration_having(20, 0));
  RankSlice narrow;
  narrow.scope = &tagged;
  narrow.narrow_filters = true;
  narrow.whole = true;
  narrow.having = tagged.having;
  narrow.fetch = 100;
  CHECK_EQ(rank_sql(narrow), std::string(golden::kRankNarrowWhole));
}

void test_chart_statements_are_unchanged() {
  const auto a = scope_of(kAStart, kAEnd);
  const AnalyticsGrid grid = analytics_grid(kAStart, kAEnd, 0, false);
  CHECK_EQ(grid.bucket_ms, int64_t(60000));
  CHECK_EQ(grid.quantile_bucket_ms, int64_t(60000));
  CHECK_EQ(grid.range_start_ms, kAStart);
  CHECK_EQ(index_counts_sql(a.index_table, kAStart, kAEnd, grid.bucket_ms, grid.count_origin_ms), std::string(golden::kIndexCounts));
  CHECK_EQ(analytics_sql(a, false, grid), std::string(golden::kAnalyticsPlain));
  const AnalyticsGrid aligned = analytics_grid(kAStart, kAEnd, 1234567, true);
  CHECK_EQ(aligned.count_origin_ms, int64_t(34567));
  CHECK_EQ(aligned.range_start_ms, int64_t(1789207174567LL));
  CHECK_EQ(aligned.range_end_ms, int64_t(1789210834567LL));
  CHECK_EQ(analytics_sql(a, false, aligned), std::string(golden::kAnalyticsAligned));
  const auto wide_service = scope_of(kCStart, kCEnd, kServiceFilter);
  CHECK_EQ(analytics_sql(wide_service, true, analytics_grid(kCStart, kCEnd, 0, false)), std::string(golden::kAnalyticsBroad));
  const auto tagged = scope_of(kAStart, kAEnd, kTagFilter);
  CHECK_EQ(analytics_sql(tagged, false, grid), std::string(golden::kAnalyticsNarrow));
  CHECK_EQ(heatmap_sql(a, false, 60000, 0), std::string(golden::kHeatmapPlain));
  CHECK_EQ(heatmap_sql(scope_of(kAStart, kAEnd, kServiceFilter), true, 60000, 0), std::string(golden::kHeatmapBroad));
  CHECK_EQ(heatmap_sql(tagged, false, 60000, 0), std::string(golden::kHeatmapNarrow));
}

void test_delta_statements_are_unchanged() {
  const auto a = scope_of(kAStart, kAEnd);
  const DeltaWindows box = delta_windows(a, kAStart, kAEnd, 2000);
  CHECK_EQ(box.cores.size(), size_t(6));
  CHECK_EQ(box.sampled_ms, int64_t(6) * 5 * 60 * 1000);
  CHECK_EQ(box.margin_ms, int64_t(4000));
  CHECK_EQ(deltas_sample_sql(a, box, 50000000, 2000000000, 1000), std::string(golden::kDeltasSampleBox));
  const auto filtered = scope_of(kAStart, kAEnd, kServiceFilter);
  CHECK_EQ(deltas_sample_sql(filtered, delta_windows(filtered, 1789207800000LL, 1789209000000LL, 5000), 10000000, 5000000000ULL, 1000),
           std::string(golden::kDeltasSampleFiltered));
  // A box of 20 minutes is read in one piece, on one core.
  CHECK_EQ(delta_windows(filtered, 1789207800000LL, 1789209000000LL, 5000).cores.size(), size_t(1));
  const auto wide = scope_of(kCStart, kCEnd);
  CHECK_EQ(deltas_sample_sql(wide, delta_windows(wide, 1789174800000LL, 1789243200000LL, 3000), 100000000, 3000000000ULL, 300),
           std::string(golden::kDeltasSampleWide));
  // The attribute pass: the ids are the parameters {ids_in} and {all_ids}. This text cannot be taken from a log.
  // ClickHouse writes a statement with its parameters filled in. So this text is the text of the code before the split.
  const std::string reads = "((Timestamp >= fromUnixTimestamp64Milli(1789207790000) AND Timestamp <= fromUnixTimestamp64Milli(1789209010000)))";
  const DeltaWindows one = delta_windows(filtered, 1789207800000LL, 1789209000000LL, 5000);
  CHECK_EQ(one.reads, reads);
  CHECK_EQ(deltas_attribute_sql(filtered, one, true, true, 371, 519),
           "SELECT scope, key, toString(uniq_in), toString(uniq_out), toString(occ_in), toString(occ_out), tv.1, toString(tv.2), toString(tv.3) FROM ("
           "SELECT scope, key, countIf(n_in > 0) AS uniq_in, countIf(n_out > 0) AS uniq_out, sum(n_in) AS occ_in, sum(n_out) AS occ_out, "
           "arraySlice(arrayReverseSort(x -> x.2 / 371 + x.3 / 519, groupArray((value, n_in, n_out))), 1, 40) AS top FROM ("
           "SELECT kv.1 AS scope, kv.2 AS key, kv.3 AS value, uniqExactIf(TraceId, side) AS n_in, uniqExactIf(TraceId, NOT side) AS n_out FROM ("
           "SELECT TraceId, TraceId IN {ids_in:Array(String)} AS side, arrayJoin(arrayConcat([('column', 'ServiceName', toString(ServiceName)), "
           "('column', 'SpanName', toString(SpanName)), ('column', 'StatusCode', toString(StatusCode))], "
           "arrayMap((k, v) -> ('span', toString(k), toString(v)), SpanAttributes.keys, SpanAttributes.values), "
           "arrayMap((k, v) -> ('resource', toString(k), toString(v)), ResourceAttributes.keys, ResourceAttributes.values))) AS kv FROM "
           "`otel`.`otel_traces` PREWHERE " + reads + " AND TraceId IN {all_ids:Array(String)} WHERE 1) WHERE length(kv.3) <= 1024 "
           "GROUP BY scope, key, value) GROUP BY scope, key HAVING occ_in + occ_out >= 5) ARRAY JOIN top AS tv SETTINGS max_execution_time = 30");
  // No attribute map: only the three columns.
  const std::string columns_only = deltas_attribute_sql(filtered, one, false, false, 1, 0);
  CHECK(columns_only.find("SpanAttributes.keys") == std::string::npos);
  CHECK(columns_only.find("x.2 / 1 + x.3 / 1") != std::string::npos);  // an empty side counts as one
}

void test_service_map_statements_are_unchanged() {
  const auto a = scope_of(kAStart, kAEnd);
  CHECK_EQ(service_map_estimate_sql(a.table, kAStart, kAEnd), std::string(golden::kMapEstimate));
  const ServiceMapSampling whole = service_map_sampling(kAStart, kAEnd, 22000, 0);
  CHECK_EQ(whole.trace_factor, uint64_t(1));
  CHECK(!whole.sampled());
  CHECK_EQ(whole.scale(), 1.0);
  CHECK_EQ(service_map_sql(a, whole), std::string(golden::kMapPlain));
  const ServiceMapSampling forced = service_map_sampling(kAStart, kAEnd, 22000, 3);
  CHECK_EQ(forced.trace_factor, uint64_t(3));
  CHECK(forced.sampled());
  CHECK_EQ(service_map_sql(a, forced), std::string(golden::kMapFactor));
  CHECK_EQ(service_map_sql(scope_of(kAStart, kAEnd, kServiceFilter), whole), std::string(golden::kMapFilter));
  CHECK_EQ(service_map_sql(scope_of(kAStart, kAEnd, "", duration_having(100, 0)), whole), std::string(golden::kMapDuration));
  CHECK_EQ(service_map_sql(scope_of(kAStart, kAEnd, " AND StatusCode = 'Error'", duration_having(100, 0)), whole), std::string(golden::kMapBoth));
}

void test_service_map_sampling() {
  // Up to 3 M spans in a join: one trace in ceil(spans / 3 M).
  CHECK_EQ(service_map_sampling(kAStart, kAEnd, 3000000, 0).trace_factor, uint64_t(1));
  CHECK_EQ(service_map_sampling(kAStart, kAEnd, 3000001, 0).trace_factor, uint64_t(2));
  CHECK_EQ(service_map_sampling(kAStart, kAEnd, 10000000, 0).trace_factor, uint64_t(4));
  // Above the read budget (12 M spans), the code reads only slices of the window. It reads about 12 M of the 48 M spans: 3 minutes each, evenly spaced.
  const ServiceMapSampling wide = service_map_sampling(kAStart, kAEnd + 23 * 3600 * 1000LL, 48000000, 0);
  CHECK(wide.slices > 0);
  CHECK(wide.time_coverage < 0.3 && wide.time_coverage > 0.2);
  CHECK(wide.sampled());
  CHECK(wide.time_predicate.find(" OR ") != std::string::npos);
  CHECK(wide.scale() > 3.0);
  // A window shorter than a slice is read in one piece.
  const ServiceMapSampling tiny = service_map_sampling(0, 900, 48000000, 0);
  CHECK_EQ(tiny.slices, 0);
  CHECK_EQ(tiny.time_coverage, 1.0);
}

// ---- the strategies of the search ----

SearchOutcome search_with(FakeDb& db, const TraceScope& scope, bool key_only, size_t limit) { return search_traces(db, scope, key_only, limit); }

Rows summary_rows(const std::vector<std::string>& ids) {
  Rows rows;
  int64_t start_ms = 1789210000000LL;
  for (const auto& id : ids) {
    rows.push_back({id, std::to_string(start_ms), "GET /home", "api-gateway", "182000000", "12", "1",
                    std::string("api-gateway\x1e") + "8\x1e" + "1\x1e" + "0\x1f" + "auth\x1e" + "4\x1e" + "0\x1e" + "1000", "0"});
    start_ms -= 1000;
  }
  return rows;
}

void test_index_without_filters_takes_the_newest_traces() {
  FakeDb db;
  const auto a = scope_of(kAStart, kAEnd);
  db.on("GROUP BY TraceId LIMIT 20001",
        {{"t1", "1789210799000000000"}, {"t2", "1789210798000000000"}, {"t3", "1789210797000000000"}, {"t4", "1789210796000000000"}}, 1);
  db.on("AS trace_bounds", summary_rows({"t1", "t2", "t3"}));
  const SearchOutcome out = search_with(db, a, false, 3);
  CHECK_EQ(out.search_path, std::string("trace_index"));
  CHECK_EQ(out.rank_by, std::string("newest_index_row"));
  CHECK(out.fallback_reason.empty());
  CHECK_EQ(out.rows.size(), size_t(3));
  CHECK_EQ(out.rows[0].trace_id, std::string("t1"));
  CHECK_EQ(out.rows[0].operation, std::string("GET /home"));
  CHECK_EQ(out.rows[0].service_stats.size(), size_t(2));
  // The services of a trace, by span count and then by name.
  CHECK_EQ(out.rows[0].service_stats[0].service, std::string("api-gateway"));
  CHECK_EQ(out.rows[0].service_stats[0].spans, uint64_t(8));
  CHECK_EQ(out.rows[0].service_stats[1].first_span_ns, uint64_t(1000));
  // Two statements: the first slice of the index, and the summary of the three traces. The fourth trace is not asked for.
  CHECK_EQ(db.sqls.size(), size_t(2));
  CHECK_EQ(db.sqls[0], std::string(golden::kIndexSliceFirst));
  std::string expected = fill(golden::kSummaryIndexBounds, {{"IDS", kIdsParam}});
  expected.replace(expected.rfind("LIMIT 20"), 8, "LIMIT 3");
  CHECK_EQ(db.sqls[1], expected);
  // The statement takes the three traces of the page as its parameter.
  CHECK_EQ(db.params[1].size(), size_t(1));
  CHECK_EQ(db.params[1][0].first, std::string("ids"));
  CHECK_EQ(db.params[1][0].second, std::string("['t1', 't2', 't3']"));
  CHECK(db.sqls[1].find("'t1'") == std::string::npos);
}

void test_a_filter_tests_the_traces_of_the_index_in_pages() {
  FakeDb db;
  const auto service = scope_of(kAStart, kAEnd, kServiceFilter);
  db.on("GROUP BY TraceId LIMIT 20001",
        {{"t1", "1789210797855243093"}, {"t2", "1789210000000000000"}, {"t3", "1789209500000000000"}, {"t4", "1789209000000000000"},
         {"t5", "1789208771633818901"}},
        1);
  db.on("AS batch_bounds", {{"t2"}, {"t4"}});
  db.on("AS trace_bounds", summary_rows({"t2", "t4"}));
  const SearchOutcome out = search_with(db, service, true, 2);
  CHECK_EQ(out.search_path, std::string("trace_index_filtered"));
  CHECK_EQ(out.rank_by, std::string("newest_index_row"));
  CHECK_EQ(out.rows.size(), size_t(2));
  // The page holds every trace whose newest index row lies between the newest and the oldest start of the page.
  CHECK_EQ(db.count("AS batch_bounds"), size_t(1));
  size_t match_at = 0;
  for (size_t i = 0; i < db.sqls.size(); ++i) {
    if (db.sqls[i].find("AS batch_bounds") != std::string::npos) match_at = i;
  }
  CHECK_EQ(db.sqls[match_at], fill(golden::kBatchMatch, {{"OLDEST", "1789208771633818901"}, {"NEWEST", "1789210797855243093"}}));
  // The traces that match keep the rank of the index. The order of the answer does not change this rank.
  CHECK_EQ(db.params.back()[0].second, std::string("['t2', 't4']"));
}

// The index of a busy window: every slice holds 20,000 traces, and none of them matches.
Rows busy_slice(const std::string&) {
  static int64_t next = 0;
  Rows rows;
  for (int i = 0; i < 20000; ++i, ++next) rows.push_back({"busy" + std::to_string(next), std::to_string(1789210800000000000LL - next * 1000)});
  return rows;
}

void test_the_scan_cap_gives_way_to_the_span_aggregation() {
  FakeDb db;
  const auto status = scope_of(kAStart, kAEnd, " AND StatusCode = 'Error'");
  db.on_fn("GROUP BY TraceId LIMIT 20001", busy_slice);
  db.on("argMinIf(SpanName", summary_rows({"s1"}));
  db.on("ORDER BY min(Timestamp) DESC LIMIT 5", {{"s1", "1789210000000000000", "0"}});
  const SearchOutcome out = search_with(db, status, false, 5);
  // The code tests 64,000 traces (pages of 1,000, 4,000, 16,000, 32,000 and 11,000). None of them matches.
  CHECK_EQ(db.count("AS batch_bounds"), size_t(5));
  CHECK_EQ(out.fallback_reason, std::string("index_scan_cap"));
  CHECK_EQ(out.search_path, std::string("span_aggregation"));
  CHECK_EQ(out.rank_by, std::string("first_span"));
  CHECK_EQ(out.rows.size(), size_t(1));
  CHECK_EQ(out.rows[0].trace_id, std::string("s1"));
}

void test_an_error_of_the_index_gives_way_to_the_span_aggregation() {
  FakeDb db;
  const auto a = scope_of(kAStart, kAEnd);
  db.fail_on("GROUP BY TraceId LIMIT 20001", [] { throw std::runtime_error("the index is gone"); });
  db.on("argMinIf(SpanName", summary_rows({"s1", "s2"}));
  db.on("ORDER BY min(Timestamp) DESC LIMIT 4", {{"s1", "1789210000000000000", "0"}, {"s2", "1789209000000000000", "0"}});
  const SearchOutcome out = search_with(db, a, false, 4);
  // No filter and no duration: the index can answer. The span aggregation answers instead, and the answer says why.
  CHECK_EQ(out.fallback_reason, std::string("index_error"));
  CHECK_EQ(out.search_path, std::string("span_aggregation"));
  CHECK_EQ(out.rank_by, std::string("first_span"));
  CHECK_EQ(out.rows.size(), size_t(2));
  CHECK_EQ(out.candidate_ms >= 0, true);
}

void test_a_caller_that_went_away_stops_the_search() {
  FakeDb db;
  const auto a = scope_of(kAStart, kAEnd);
  db.fail_on("GROUP BY TraceId LIMIT 20001", [] { throw ChQueryCanceled(); });
  bool stopped = false;
  try {
    search_with(db, a, false, 4);
  } catch (const ChQueryCanceled&) {
    stopped = true;
  }
  CHECK(stopped);
  // The code asks nothing after the stop.
  CHECK_EQ(db.sqls.size(), size_t(1));
}

void test_a_failure_of_the_span_aggregation_is_the_failure_of_the_search() {
  FakeDb db;
  const auto durations = scope_of(kAStart, kAEnd, "", duration_having(10, 0));
  db.fail_on("ORDER BY min(Timestamp) DESC", [] { throw server_error(159, "Timeout exceeded"); });
  bool timed_out_seen = false;
  try {
    search_with(db, durations, false, 4);
  } catch (const std::exception& e) {
    timed_out_seen = classify_clickhouse_error(e).kind == ChErrorKind::Timeout;
  }
  CHECK(timed_out_seen);
}

void test_a_duration_bound_ranks_the_spans_and_reads_their_bounds() {
  FakeDb db;
  const auto both = scope_of(kAStart, kAEnd, kServiceFilter, duration_having(20, 400));
  db.on("SELECT toString(count()) FROM `otel`.`otel_traces_trace_id_ts`", {{"2300"}});
  db.on("SELECT toString(count()) FROM (SELECT TraceId", {{"1000"}});
  db.on("argMinIf(SpanName", summary_rows({"t1", "t2"}));
  db.on("ORDER BY min(Timestamp) DESC LIMIT 100", {{"t1", "1789207260000000000", "1789207261500000000"}, {"t2", "1789207300000000000", "1789207302000000000"}});
  const SearchOutcome out = search_with(db, both, true, 100);
  CHECK_EQ(out.search_path, std::string("span_duration_two_phase"));
  CHECK_EQ(out.rank_by, std::string("first_span"));
  CHECK_EQ(db.sqls.size(), size_t(4));
  CHECK_EQ(db.sqls[0], std::string(golden::kBroadIndexCount));
  CHECK_EQ(db.sqls[1], std::string(golden::kBroadProbe));  // threshold: a quarter of 2,300 index rows, at least 1,000
  CHECK_EQ(db.sqls[2], std::string(golden::kRankBroadDurationWhole));
  // The summary reads from the first span of the traces to the last span end. The duration filter computed that end already.
  CHECK_EQ(db.sqls[3], fill(golden::kSummarySpanBounds, {{"IDS", kIdsParam}, {"FIRST", "1789207260000000000"}, {"END", "1789207302000000000"}}));
  CHECK_EQ(out.rows.size(), size_t(2));
}

void test_a_filter_that_few_traces_match_keeps_the_narrow_form() {
  FakeDb db;
  const auto both = scope_of(kAStart, kAEnd, kServiceFilter, duration_having(20, 400));
  db.on("SELECT toString(count()) FROM `otel`.`otel_traces_trace_id_ts`", {{"2300"}});
  db.on("SELECT toString(count()) FROM (SELECT TraceId", {{"999"}});
  CHECK(!filters_are_broad(db, both));
  // A bigger index raises the threshold too.
  FakeDb big;
  big.on("SELECT toString(count()) FROM `otel`.`otel_traces_trace_id_ts`", {{"100000"}});
  big.on("SELECT toString(count()) FROM (SELECT TraceId", {{"24999"}});
  CHECK(!filters_are_broad(big, both));
  CHECK(big.sqls[1].find("LIMIT 25000)") != std::string::npos);
  // No filter or no index: the code asks no question.
  FakeDb none;
  CHECK(!filters_are_broad(none, scope_of(kAStart, kAEnd)));
  auto no_index = both;
  no_index.index_table.clear();
  CHECK(!filters_are_broad(none, no_index));
  CHECK(none.sqls.empty());
  // A failure keeps the narrow form. The narrow form needs no index.
  FakeDb broken;
  broken.fail_on("count()", [] { throw std::runtime_error("no such table"); });
  CHECK(!filters_are_broad(broken, both));
}

void test_the_ranking_widens_from_the_newest_slice() {
  FakeDb db;
  const auto wide = scope_of(kCStart, kCEnd, "", duration_having(100, 0));
  // The newest 1/16 of the window holds three traces. One of them started before the slice, so the code drops it.
  // The slice is too thin for the 10 traces that are wanted. The code therefore reads the whole window.
  db.on("ORDER BY min(Timestamp) DESC LIMIT 26",
        {{"a", "1789257000000000000", "1789257000500000000"}, {"b", "1789256000000000000", "1789256000400000000"}, {"c", "1789255000000000000", "1789255000900000000"}}, 1);
  db.on("SELECT DISTINCT toString(TraceId)", {{"b"}});
  Rows whole;
  for (int i = 0; i < 10; ++i) whole.push_back({"w" + std::to_string(i), std::to_string(1789257000000000000LL - i), "0"});
  db.on("ORDER BY min(Timestamp) DESC LIMIT 10", whole);
  const auto ranked = rank_traces_by_start(db, wide, false, 10);
  CHECK_EQ(ranked.size(), size_t(10));
  CHECK_EQ(ranked[0].trace_id, std::string("w0"));
  CHECK_EQ(db.sqls.size(), size_t(3));
  CHECK_EQ(db.sqls[0].find(golden::kRankSlice) != std::string::npos || db.sqls[0] == std::string(golden::kRankSlice), true);
  CHECK_EQ(db.sqls[1], fill(golden::kRankProbe, {{"IDS", kIdsParam}}));
  CHECK_EQ(db.params[1][0].second, std::string("['a', 'b', 'c']"));
  CHECK(db.sqls[2].find("Timestamp >= fromUnixTimestamp64Nano(") == std::string::npos);

  // A slice that holds enough exact traces is the answer.
  FakeDb enough;
  Rows slice;
  for (int i = 0; i < 12; ++i) slice.push_back({"n" + std::to_string(i), std::to_string(1789257000000000000LL - i), "0"});
  enough.on("ORDER BY min(Timestamp) DESC LIMIT 26", slice);
  const auto first = rank_traces_by_start(enough, wide, false, 10);
  CHECK_EQ(first.size(), size_t(10));
  CHECK_EQ(first.back().trace_id, std::string("n9"));
  CHECK_EQ(enough.sqls.size(), size_t(2));  // the slice and its probe

  // A window of one hour is read in one piece.
  FakeDb hour;
  hour.on("ORDER BY min(Timestamp) DESC LIMIT 10", {{"h", "1789207300000000000", "0"}});
  CHECK_EQ(rank_traces_by_start(hour, scope_of(kAStart, kAEnd), false, 10).size(), size_t(1));
  CHECK_EQ(hour.sqls.size(), size_t(1));
}

// ---- the charts, the heatmap, the deltas and the map ----

void test_charts_come_from_the_index_when_nothing_restricts_them() {
  FakeDb db;
  const auto a = scope_of(kAStart, kAEnd);
  db.on("FROM (SELECT min(Start) AS first_start", {{"1789207200000", "5"}, {"1789207260000", "7"}});
  const AnalyticsGrid grid = analytics_grid(kAStart, kAEnd, 0, false);
  const auto result = run_analytics(db, a, false, grid, true, false);
  CHECK(result);
  CHECK_EQ(result.value->analytics_path, std::string("trace_index"));
  CHECK_EQ(result.value->trace_count_source, std::string("trace_index"));
  CHECK_EQ(result.value->trace_counts.size(), size_t(2));
  CHECK_EQ(result.value->trace_counts[1].second, uint64_t(7));
  CHECK(result.value->have_counts && !result.value->have_durations);
  CHECK_EQ(db.sqls[0], std::string(golden::kIndexCounts));
  // The code never reads the quantiles from the index.
  FakeDb both;
  both.on("FROM trace_durations GROUP BY bucket_ms", {{"1789207200000", "5", "1", "2", "3", "4"}});
  const auto spans = run_analytics(both, a, false, grid, true, true);
  CHECK_EQ(spans.value->analytics_path, std::string("span_aggregation"));
  CHECK(spans.value->have_counts && spans.value->have_durations);
  CHECK_EQ(spans.value->quantiles.size(), size_t(1));
  CHECK_EQ(spans.value->quantiles[0].p99, uint64_t(4));
  CHECK_EQ(both.count("trace_id_ts"), size_t(0));
  // A filter, a duration bound or an allowlist excludes the index.
  FakeDb filtered;
  filtered.on("FROM trace_durations GROUP BY bucket_ms", {});
  CHECK_EQ(run_analytics(filtered, scope_of(kAStart, kAEnd, kTagFilter), false, grid, true, false).value->analytics_path, std::string("span_aggregation"));
  auto restricted = a;
  restricted.visibility = "(ServiceName = 'a')";
  CHECK_EQ(run_analytics(filtered, restricted, false, grid, true, false).value->analytics_path, std::string("span_aggregation"));
}

void test_the_counts_of_a_finer_quantile_bucket_add_up_in_the_count_bucket() {
  FakeDb db;
  const auto c = scope_of(kCStart, kCEnd);
  const AnalyticsGrid grid = analytics_grid(kCStart, kCEnd, 0, false);
  CHECK_EQ(grid.bucket_ms, int64_t(1800000));
  CHECK_EQ(grid.quantile_bucket_ms, int64_t(900000));
  db.on("FROM trace_durations GROUP BY bucket_ms", {{"1789171200000", "3", "1", "2", "3", "4"}, {"1789172100000", "4", "1", "2", "3", "4"}, {"1789173000000", "9", "1", "2", "3", "4"}});
  const auto result = run_analytics(db, c, false, grid, true, true);
  CHECK_EQ(result.value->trace_counts.size(), size_t(2));
  CHECK_EQ(result.value->trace_counts[0].first, int64_t(1789171200000LL));
  CHECK_EQ(result.value->trace_counts[0].second, uint64_t(7));
  CHECK_EQ(result.value->trace_counts[1].second, uint64_t(9));
  CHECK_EQ(result.value->quantiles.size(), size_t(3));
}

void test_a_broken_index_falls_back_on_a_new_connection() {
  FakeDb db;
  const auto a = scope_of(kAStart, kAEnd);
  const AnalyticsGrid grid = analytics_grid(kAStart, kAEnd, 0, false);
  db.fail_on("FROM (SELECT min(Start) AS first_start", [] { throw std::runtime_error("index table is missing"); });
  db.on("FROM trace_durations GROUP BY bucket_ms", {{"1789207200000", "5", "1", "2", "3", "4"}});
  const auto result = run_analytics(db, a, false, grid, true, false);
  CHECK(result);
  CHECK_EQ(result.value->analytics_path, std::string("span_aggregation"));
  CHECK_EQ(db.renewed, 1);
  // When no other connection is available, the route says so.
  FakeDb down;
  down.renew_ok = false;
  down.fail_on("FROM (SELECT min(Start) AS first_start", [] { throw std::runtime_error("index table is missing"); });
  const auto refused = run_analytics(down, a, false, grid, true, false);
  CHECK(!refused);
  CHECK_EQ(refused.error.status, 503);
  CHECK_EQ(refused.error.code, std::string("trace_source_unavailable"));
  CHECK_EQ(refused.error.message, std::string("no more connections"));
}

void test_charts_parameter() {
  bool counts = false, durations = false;
  CHECK(parse_charts("", &counts, &durations) && counts && durations);
  CHECK(parse_charts("counts", &counts, &durations) && counts && !durations);
  CHECK(parse_charts("durations,counts", &counts, &durations) && counts && durations);
  CHECK(!parse_charts("none", &counts, &durations));
}

void test_the_heatmap_bins() {
  // Fine bins 10..14 (32 per octave): the lowest row starts at the bin of the 1 % quantile.
  // The cumulative count is 2 of 200. Every count is kept.
  std::map<int, uint64_t> totals{{8, 1}, {10, 94}, {11, 5}, {14, 100}};
  std::map<std::pair<int64_t, int>, uint64_t> cells{{{60000, 8}, 1}, {{60000, 10}, 40}, {{120000, 10}, 54}, {{120000, 11}, 5}, {{120000, 14}, 100}};
  const HeatmapBins bins = bin_heatmap(cells, totals, 8);
  CHECK_EQ(bins.total, uint64_t(200));
  CHECK_EQ(bins.rows, 5);  // fewer fine bins than rows: one row for each, from bin 10 to bin 14
  CHECK_EQ(bins.edges.size(), size_t(6));
  CHECK_EQ(bins.edges[0], std::exp2(10.0 / 32));
  CHECK_EQ(bins.edges[5], std::exp2(15.0 / 32));
  CHECK_EQ(bins.below_count, uint64_t(1));
  // The code counts a trace faster than the lowest row in that row.
  CHECK_EQ((bins.cells.at({60000, 0})), uint64_t(41));
  CHECK_EQ((bins.cells.at({120000, 0})), uint64_t(54));
  CHECK_EQ((bins.cells.at({120000, 1})), uint64_t(5));
  CHECK_EQ((bins.cells.at({120000, 4})), uint64_t(100));
  CHECK_EQ(bins.max_count, uint64_t(100));
  // Many fine bins merge into the rows that are wanted.
  std::map<int, uint64_t> spread;
  std::map<std::pair<int64_t, int>, uint64_t> spread_cells;
  for (int bin = 100; bin < 200; ++bin) {
    spread[bin] = 10;
    spread_cells[{0, bin}] = 10;
  }
  const HeatmapBins merged = bin_heatmap(spread_cells, spread, 10);
  CHECK_EQ(merged.rows, 10);
  uint64_t sum = 0;
  for (const auto& [key, count] : merged.cells) sum += count;
  CHECK_EQ(sum, uint64_t(1000));
  // No trace: no row.
  CHECK_EQ(bin_heatmap({}, {}, 40).rows, 0);
}

void test_the_ranking_of_the_deltas() {
  auto key = [](std::string scope, std::string name, uint64_t occ_in, uint64_t occ_out, uint64_t uniq_in, uint64_t uniq_out,
                std::vector<DeltaValue> values) {
    DeltaKey k;
    k.scope = std::move(scope);
    k.key = std::move(name);
    k.occ_in = occ_in;
    k.occ_out = occ_out;
    k.uniq_in = uniq_in;
    k.uniq_out = uniq_out;
    k.values = std::move(values);
    return k;
  };
  std::vector<DeltaKey> keys;
  // 90 % of the selection and 10 % of the baseline: a score of 80, plus 2 for a key of the conventions.
  keys.push_back(key("span", "http.route", 100, 100, 2, 2, {{"/cart", 90, 10, 0, 0}, {"/home", 10, 90, 0, 0}}));
  // The code always boosts a column of the table.
  keys.push_back(key("column", "StatusCode", 100, 100, 2, 2, {{"Error", 30, 0, 0, 0}, {"Ok", 70, 100, 0, 0}}));
  // The same distribution on both sides says nothing.
  keys.push_back(key("span", "host.arch", 100, 100, 1, 1, {{"arm64", 100, 100, 0, 0}}));
  // The code hides an identifier by its name and by its values.
  keys.push_back(key("span", "user.request_id", 100, 100, 100, 100, {{"a", 1, 0, 0, 0}}));
  keys.push_back(key("span", "session", 100, 100, 4, 4, {{"0123456789abcdef0123", 50, 0, 0, 0}, {"fedcba9876543210fedc", 50, 0, 0, 0}}));
  // Almost every value is new on both sides. The code hides the key as high cardinality.
  keys.push_back(key("span", "cart.total", 100, 100, 99, 98, {{"12.5", 5, 0, 0, 0}}));
  const DeltaRanking ranking = rank_deltas(std::move(keys), 100, 100, 1000, 9000, false);
  CHECK_EQ(ranking.ranked_keys, size_t(2));
  CHECK_EQ(ranking.ranked[0].key, std::string("http.route"));
  CHECK_EQ(ranking.ranked[0].score, 82.0);
  CHECK(ranking.ranked[0].boosted);
  CHECK_EQ(ranking.ranked[0].values[0].value, std::string("/cart"));  // the values by the size of the difference
  CHECK_EQ(ranking.ranked[0].values[0].in_pct, 90.0);
  CHECK_EQ(ranking.ranked[0].values[0].base_pct, 10.0);
  CHECK_EQ(ranking.ranked[1].key, std::string("StatusCode"));
  CHECK_EQ(ranking.ranked[1].score, 32.0);
  CHECK_EQ(ranking.hidden.size(), size_t(3));
  CHECK_EQ(ranking.hidden[0].reason, std::string("id_like"));
  CHECK_EQ(ranking.hidden[1].reason, std::string("id_like"));
  CHECK_EQ(ranking.hidden[2].reason, std::string("high_cardinality"));
  // The baseline of "all" uses both samples. Each sample is weighted by the traces that it stands for (here 10 % selection).
  std::vector<DeltaKey> again;
  again.push_back(key("span", "http.route", 100, 100, 2, 2, {{"/cart", 90, 10, 0, 0}}));
  const DeltaRanking all = rank_deltas(std::move(again), 100, 100, 1000, 9000, true);
  CHECK_EQ(all.ranked[0].values[0].base_pct, 18.0);  // (0.9 * 1000 + 0.1 * 9000) / 10000 = 18 %
  // Names that never explain a difference.
  CHECK(id_or_time_key("Trace_ID") && id_or_time_key("http.request_id") && id_or_time_key("created_at") && !id_or_time_key("http.route"));
  CHECK(id_like_value("550e8400-e29b-41d4-a716-446655440000") && id_like_value("1234567890123") && !id_like_value("GET /home"));
  CHECK(semconv_key("service.name") && semconv_key("custom.http.route") && !semconv_key("custom.thing"));
}



// ---- the service ----

// Each service of a test has its own caches, so no cache is shared between two tests.
struct TestCaches {
  AttributeMapCache attribute_maps{attribute_map_cache_options()};
  PrefillCache prefill{PrefillCache::Options{}};
  FacetKeysCache facet_keys{FacetKeysCache::Options{}};
  FacetValuesCache facet_values{FacetValuesCache::Options{}};
  TraceCaches refs() { return TraceCaches{attribute_maps, prefill, facet_keys, facet_values}; }
};

HostSpec trace_host() {
  HostSpec host;
  host.id = "local";
  host.system_uri = "clickhouse://system@clickhouse:9000";
  host.otel.traces.enabled = true;
  host.otel.traces.analytics = true;
  host.otel.traces.database = "otel";
  host.otel.traces.table = "otel_traces";
  host.otel.traces.trace_index_table = "otel_traces_trace_id_ts";
  return host;
}

WindowRequest window_request(int64_t start = kAStart, int64_t end = kAEnd) {
  WindowRequest request;
  request.source_host_id = "local";
  request.start_ms = start;
  request.end_ms = end;
  return request;
}

void test_the_service_cannot_connect() {
  TestCaches cache;
  TraceService service([](const HostSpec&, std::string* error) -> std::unique_ptr<ChExecutor> {
    *error = "pool_exhausted: no connection";
    return nullptr;
  }, cache.refs());
  RequestContext context;
  const auto answer = service.search(context, trace_host(), window_request(), 10);
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  CHECK_EQ(answer.error.code, std::string("trace_source_unavailable"));
  CHECK_EQ(answer.error.message, std::string("pool_exhausted: no connection"));
  TraceService silent([](const HostSpec&, std::string*) -> std::unique_ptr<ChExecutor> { return nullptr; }, cache.refs());
  CHECK_EQ(silent.search(context, trace_host(), window_request(), 10).error.message, std::string("Cannot connect to trace ClickHouse source."));
  // The connection comes before the checks of the route request. A request that is wrong in two ways reports the first error.
  AnalyticsRequest bad;
  bad.window = window_request();
  bad.charts = "none";
  CHECK_EQ(silent.analytics(context, trace_host(), bad).error.code, std::string("trace_source_unavailable"));
}

void test_the_attribute_columns_are_read_once_for_the_filters_of_a_source() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(LowCardinality(String), String)"}});
  RequestContext context;
  WindowRequest request = window_request();
  request.filters.tags.push_back(TagFilter{"span", TagOp::Eq, "server.address", "frontend.shop.svc.cluster.local"});
  // No trace index: the code ranks the spans, with the filter as a CTE.
  HostSpec host = trace_host();
  host.otel.traces.trace_index_table.clear();
  const auto first = service.search(context, host, request, 10);
  CHECK(first);
  CHECK_EQ(db.count("FROM system.columns"), size_t(1));
  CHECK_EQ(db.sqls[0], std::string("SELECT toString(name), toString(type) FROM system.columns WHERE database = 'otel' AND `table` = 'otel_traces' AND name IN ('SpanAttributes','ResourceAttributes')"));
  CHECK(db.count("mapContains(SpanAttributes, 'server.address')") > 0);
  // The second request of the source reads the cache. A request with no tag filter never asks the source.
  CHECK(service.search(context, host, request, 10));
  CHECK_EQ(db.count("FROM system.columns"), size_t(1));
}

void test_a_table_that_cannot_be_read_is_not_a_table_without_maps() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.fail_on("FROM system.columns", [] { throw std::runtime_error("system.columns is not readable"); });
  RequestContext context;
  WindowRequest request = window_request();
  request.filters.tags.push_back(TagFilter{"any", TagOp::Exists, "k", ""});
  const auto answer = service.search(context, trace_host(), request, 10);
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  CHECK_EQ(answer.error.code, std::string("trace_schema_unavailable"));
  // Columns that are not Maps: 400. Columns that traces.features disables: 400 too, with its own code.
  FakeDb plain;
  TestCaches plain_cache;
  TraceService plain_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(plain)); }, plain_cache.refs());
  plain.on("FROM system.columns", {{"SpanAttributes", "JSON"}, {"ResourceAttributes", "JSON"}});
  const auto unsupported = plain_service.search(context, trace_host(), request, 10);
  CHECK_EQ(unsupported.error.status, 400);
  CHECK_EQ(unsupported.error.code, std::string("trace_tag_search_unsupported"));
  HostSpec off = trace_host();
  off.otel.traces.features.span_attributes = false;
  off.otel.traces.features.resource_attributes = false;
  const auto disabled = plain_service.search(context, off, request, 10);
  CHECK_EQ(disabled.error.code, std::string("trace_filter_disabled"));
}

void test_a_failure_of_a_statement_is_the_error_of_the_route() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  RequestContext context;
  WindowRequest durations = window_request();
  durations.min_duration_ms = 10;
  db.fail_on("ORDER BY min(Timestamp) DESC", [] { throw server_error(159, "Timeout exceeded"); });
  const auto timeout = service.search(context, trace_host(), durations, 10);
  CHECK(!timeout);
  CHECK_EQ(timeout.error.status, 504);
  CHECK_EQ(timeout.error.code, std::string("trace_timeout"));
  CHECK(timeout.error.retryable.value_or(status_is_retryable(timeout.error.status)));
  FakeDb other;
  TraceService other_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(other)); }, cache.refs());
  other.fail_on("ORDER BY min(Timestamp) DESC", [] { throw server_error(60, "Table otel.otel_traces does not exist"); });
  CHECK_EQ(other_service.search(context, trace_host(), durations, 10).error.code, std::string("trace_search_failed"));
  AnalyticsRequest analytics;
  analytics.window = durations;
  FakeDb limit;
  TraceService limit_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(limit)); }, cache.refs());
  limit.fail_on("FROM trace_durations", [] { throw server_error(158, "Too many rows to read"); });
  const auto scan = limit_service.analytics(context, trace_host(), analytics);
  CHECK_EQ(scan.error.status, 422);
  CHECK_EQ(scan.error.code, std::string("trace_scan_limit"));
}

void test_the_box_of_the_deltas_is_checked() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  RequestContext context;
  DeltasRequest request;
  request.window = window_request();
  request.t0_present = request.t1_present = true;
  request.t0 = kAStart;
  request.t1 = kAEnd;
  request.d0_ms = 50;
  request.d1_ms = 2000;
  auto answer = [&](DeltasRequest r) { return service.deltas(context, trace_host(), r); };
  auto missing = request;
  missing.t1_present = false;
  CHECK_EQ(answer(missing).error.message, std::string("t0 and t1 (epoch ms, t0 < t1) are required."));
  auto reversed = request;
  reversed.t0 = kAEnd;
  reversed.t1 = kAStart;
  CHECK_EQ(answer(reversed).error.code, std::string("invalid_trace_box"));
  auto outside = request;
  outside.t0 = kAEnd + 1000;
  outside.t1 = kAEnd + 5000;
  CHECK_EQ(answer(outside).error.message, std::string("The box lies outside the time range."));
  auto no_duration = request;
  no_duration.d1_ms = -1;
  CHECK_EQ(answer(no_duration).error.message, std::string("d0 and d1 (trace duration in ms, d0 <= d1) are required."));
  auto backwards = request;
  backwards.d0_ms = 3000;
  CHECK_EQ(answer(backwards).error.code, std::string("invalid_trace_box"));
  auto baseline = request;
  baseline.baseline = "everything";
  CHECK_EQ(answer(baseline).error.code, std::string("invalid_trace_baseline"));
  CHECK_EQ(answer(baseline).error.status, 400);
  // The code reads nothing for a request that is wrong.
  CHECK(db.sqls.empty());
}

void test_the_deltas_compare_two_samples() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  db.on("count() OVER (PARTITION BY in_box)", {{"i1", "1", "40"}, {"i2", "1", "40"}, {"o1", "0", "400"}, {"o2", "0", "400"}});
  db.on("ARRAY JOIN top AS tv",
        {{"span", "http.route", "2", "2", "2", "2", "/cart", "2", "0"}, {"span", "http.route", "2", "2", "2", "2", "/home", "0", "2"},
         {"column", "StatusCode", "1", "2", "2", "2", "Error", "2", "0"}});
  RequestContext context;
  DeltasRequest request;
  request.window = window_request();
  request.t0_present = request.t1_present = true;
  request.t0 = kAStart;
  request.t1 = kAEnd;
  request.d0_ms = 50;
  request.d1_ms = 2000;
  request.sample = 100;
  const auto answer = service.deltas(context, trace_host(), request);
  CHECK(answer);
  CHECK_EQ(answer.value->samples.ids_in.size(), size_t(2));
  CHECK_EQ(answer.value->samples.ids_out.size(), size_t(2));
  CHECK_EQ(answer.value->samples.total_out, uint64_t(400));
  CHECK_EQ(answer.value->ranking.ranked.size(), size_t(2));
  // Both keys explain all of the difference (a score of 102). The column of the table comes first.
  CHECK_EQ(answer.value->ranking.ranked[0].key, std::string("StatusCode"));
  CHECK_EQ(answer.value->ranking.ranked[1].key, std::string("http.route"));
  CHECK(answer.value->window_sampled);
  // The ids of the sample are the parameters of the attribute pass. They are not part of its text.
  const ChParams& sent = db.params.back();
  CHECK_EQ(sent.size(), size_t(2));
  CHECK_EQ(sent[0].first, std::string("ids_in"));
  CHECK_EQ(sent[0].second, std::string("['i1', 'i2']"));
  CHECK_EQ(sent[1].second, std::string("['i1', 'i2', 'o1', 'o2']"));
  CHECK(db.sqls.back().find("'i1'") == std::string::npos);
  // The JSON of the answer.
  rapidjson::Document doc;
  doc.Parse(deltas_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(std::string(doc["keys"][0]["field"].GetString()), std::string("status"));
  CHECK_EQ(std::string(doc["keys"][1]["field"].GetString()), std::string("tag"));
  CHECK_EQ(doc["selection"]["sampled"].GetUint64(), uint64_t(2));
  CHECK_EQ(std::string(doc["baseline"].GetString()), std::string("outside"));
}

void test_the_service_map_and_its_json() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on_block("EXPLAIN ESTIMATE", [](const std::string&) {
    clickhouse::Block block;
    for (const char* name : {"database", "table"}) {
      auto column = std::make_shared<clickhouse::ColumnString>();
      column->Append("otel");
      block.AppendColumn(name, column);
    }
    for (const char* name : {"parts", "rows", "marks"}) {
      auto column = std::make_shared<clickhouse::ColumnUInt64>();
      column->Append(name == std::string("rows") ? 22000 : 3);
      block.AppendColumn(name, column);
    }
    return block;
  });
  db.on("GROUPING SETS",
        {{"1", "", "api", "100", "2", "10", "20", "30", "0"}, {"1", "", "auth", "300", "9", "11", "21", "31", "0"},
         {"0", "api", "auth", "40", "1", "12", "22", "32", "30"}, {"0", "auth", "queue", "10", "0", "1", "2", "3", "2"}});
  RequestContext context;
  ServiceMapRequest request;
  request.window = window_request();
  const auto answer = service.service_map(context, trace_host(), request);
  CHECK(answer);
  const ServiceMapOutcome& map = answer.value->outcome;
  CHECK_EQ(map.estimated_spans, uint64_t(22000));
  CHECK_EQ(map.estimate_source, std::string("explain"));
  CHECK_EQ(map.nodes.size(), size_t(2));
  CHECK_EQ(map.nodes[0].service, std::string("auth"));  // the busiest first
  CHECK_EQ(map.edges.size(), size_t(2));
  CHECK(map.edges[0].is_async());   // 30 of its 40 calls have a Producer parent or a Consumer child
  CHECK(!map.edges[1].is_async());  // 2 of 10
  CHECK(!map.truncated);
  rapidjson::Document doc;
  doc.Parse(service_map_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(std::string(doc["edges"][0]["kind"].GetString()), std::string("async"));
  CHECK_EQ(std::string(doc["edges"][1]["kind"].GetString()), std::string("sync"));
  CHECK_EQ(doc["nodes"][0]["spans"].GetUint64(), uint64_t(300));
  CHECK_EQ(doc["sampled"].GetBool(), false);
  CHECK_EQ(std::string(doc["edge_rule"].GetString()), std::string("parent_child_cross_service"));

  // An estimate that fails: the size of the window decides, on a new connection.
  FakeDb failing;
  failing.fail_on("EXPLAIN ESTIMATE", [] { throw std::runtime_error("estimate is not available"); });
  failing.on("GROUPING SETS", {});
  const auto fallback = run_service_map(failing, scope_of(kAStart, kAEnd), 0);
  CHECK(fallback);
  CHECK_EQ(fallback.value->estimate_source, std::string("window"));
  CHECK_EQ(failing.renewed, 1);
  // One hour is six ten-minute windows of the read budget. The map reads slices, not the whole window.
  CHECK_EQ(fallback.value->estimated_spans, kServiceMapReadRows * 6);
  CHECK(fallback.value->sampling.slices > 0);
}

void test_the_order_of_a_search_is_named_by_its_path() {
  // The two orders (ARCH-B-083): the index ranks a trace by the Start of its newest index row. The spans rank a trace by its first span. The paths name the order.
  CHECK_EQ(rank_by_of("trace_index"), std::string("newest_index_row"));
  CHECK_EQ(rank_by_of("trace_index_filtered"), std::string("newest_index_row"));
  CHECK_EQ(rank_by_of("trace_index_then_spans"), std::string("newest_index_row_then_first_span"));
  CHECK_EQ(rank_by_of("span_aggregation"), std::string("first_span"));
  CHECK_EQ(rank_by_of("span_duration_two_phase"), std::string("first_span"));
  // A search that never ran states the order of the span paths (the default of the outcome).
  CHECK_EQ(SearchOutcome{}.rank_by, std::string("first_span"));
}

void test_the_json_of_the_search() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("GROUP BY TraceId LIMIT 20001", {{"t1", "1789210799000000000"}, {"t2", "1789210798000000000"}}, 1);
  db.on("AS trace_bounds", summary_rows({"t1", "t2"}));
  RequestContext context;
  const auto answer = service.search(context, trace_host(), window_request(), 2);
  CHECK(answer);
  rapidjson::Document doc;
  const std::string json = search_json(*answer.value);
  doc.Parse(json.c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["v"].GetInt(), 3);
  CHECK_EQ(std::string(doc["search_path"].GetString()), std::string("trace_index"));
  // The answer states how its traces are ordered: by the newest index row of the window, not by the first span.
  CHECK_EQ(std::string(doc["rank_by"].GetString()), std::string("newest_index_row"));
  CHECK(!doc.HasMember("fallback_reason"));
  CHECK_EQ(doc["rows"].Size(), rapidjson::SizeType(2));
  // The services of the rows are in a dictionary. A row holds the index of each service.
  CHECK_EQ(doc["services"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(std::string(doc["services"][0].GetString()), std::string("api-gateway"));
  CHECK_EQ(doc["rows"][0][3].GetUint64(), uint64_t(0));
  CHECK_EQ(doc["rows"][0][8].GetUint64(), uint64_t(0));  // missing parents
  CHECK_EQ(doc["columns"].Size(), rapidjson::SizeType(9));
  // With a restricted allowlist, the count of parents that the allowlist hides states what is hidden. The count is zero.
  HostSpec restricted = trace_host();
  restricted.otel.traces.service_allowlist = {"api-*"};
  FakeDb limited;
  TraceService limited_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(limited)); }, cache.refs());
  limited.on("AS batch_bounds", {{"t1"}});
  limited.on("GROUP BY TraceId LIMIT 20001", {{"t1", "1789210799000000000"}}, 1);
  auto row = summary_rows({"t1"});
  row[0][8] = "7";
  limited.on("AS trace_bounds", row);
  const auto hidden = limited_service.search(context, restricted, window_request(), 2);
  CHECK(hidden);
  CHECK_EQ(hidden.value->outcome.rows[0].missing_parents, uint64_t(7));
  rapidjson::Document hidden_doc;
  hidden_doc.Parse(search_json(*hidden.value).c_str());
  CHECK_EQ(hidden_doc["rows"][0][8].GetUint64(), uint64_t(0));
  // The statements of the restricted search contain the allowlist.
  CHECK(limited.count("startsWith(ServiceName, 'api-')") > 0);
}

void test_the_json_of_the_charts_and_the_heatmap() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("FROM trace_durations GROUP BY bucket_ms, fine_bin", {{"1789207200000", "10", "30"}, {"1789207260000", "12", "70"}, {"1789207260000", "40", "1"}});
  db.on("FROM trace_durations GROUP BY bucket_ms", {{"1789207200000", "5", "1", "2", "3", "4"}});
  RequestContext context;
  AnalyticsRequest analytics;
  analytics.window = window_request();
  analytics.bucket_origin_ms = 1234567;
  analytics.align_buckets = true;
  const auto charts = service.analytics(context, trace_host(), analytics);
  CHECK(charts);
  rapidjson::Document doc;
  doc.Parse(analytics_json(*charts.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["bucket_origin_ms"].GetInt64(), int64_t(34567));
  CHECK_EQ(doc["range"][0].GetInt64(), int64_t(1789207174567LL));
  CHECK_EQ(doc["charts"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(std::string(doc["analytics_path"].GetString()), std::string("span_aggregation"));
  CHECK_EQ(doc["duration_quantiles"][0][4].GetUint64(), uint64_t(4));

  HeatmapRequest heatmap;
  heatmap.window = window_request();
  heatmap.rows = 8;
  const auto map = service.heatmap(context, trace_host(), heatmap);
  CHECK(map);
  rapidjson::Document hm;
  hm.Parse(heatmap_json(*map.value).c_str());
  CHECK(!hm.HasParseError());
  CHECK_EQ(hm["total"].GetUint64(), uint64_t(101));
  CHECK_EQ(std::string(hm["heatmap_path"].GetString()), std::string("span_aggregation"));
  CHECK_EQ(hm["bins_per_octave"].GetInt(), 32);
  CHECK(hm["rows"].GetInt() > 0 && hm["rows"].GetInt() <= 8);
  CHECK_EQ(hm["y_edges_ns"].Size(), rapidjson::SizeType(hm["rows"].GetInt() + 1));
  // The analytics are disabled for the host. The parse states this before the code reads anything (trace_request.hpp).
  httplib::Request req;
  TraceSettings off;
  off.analytics = false;
  AnalyticsRequest parsed;
  ApiError error;
  CHECK(!parse_analytics(req, off, &parsed, &error));
  CHECK_EQ(error.status, 404);
  CHECK_EQ(error.code, std::string("trace_analytics_disabled"));
}


// ---- the services view ----

void test_services_statements_are_unchanged() {
  const std::string table = "`otel`.`otel_traces`";
  const std::string entry = kServiceEntrySpans;
  const auto from = [&](const std::string& time, const std::string& kind, const std::string& where) {
    return services_from(table, time, kind, "1", where);
  };
  const std::string hour = time_predicate(kAStart, kAEnd);
  const std::string plain = from(hour, entry, "");
  CHECK_EQ(services_estimate_sql(plain), std::string(golden::kServicesEstimate));
  CHECK_EQ(services_sql(plain, 60000, 0, false), std::string(golden::kServicesPlain));
  const std::string root = from(hour, kServiceRootSpans, "");
  CHECK_EQ(services_estimate_sql(root), std::string(golden::kServicesRootEstimate));
  CHECK_EQ(services_sql(root, 60000, 0, false), std::string(golden::kServicesRoot));
  // The drill-down groups by endpoint too. It reads the slowest spans and the releases of the service.
  const std::string detail = from(hour, entry, " AND ServiceName = 'api-gateway'");
  CHECK_EQ(services_estimate_sql(detail), std::string(golden::kServicesDetailEstimate));
  CHECK_EQ(services_sql(detail, 60000, 0, true), std::string(golden::kServicesDetail));
  CHECK_EQ(services_slowest_sql(detail), std::string(golden::kServicesSlowest));
  CHECK_EQ(services_releases_sql(table, kAStart, kAEnd, "api-gateway", "1"), std::string(golden::kServicesReleases));
  const std::string filtered = from(hour, entry, " AND StatusCode = 'Error' AND ServiceName = 'api-gateway' AND Duration >= 5000000");
  CHECK_EQ(services_estimate_sql(filtered), std::string(golden::kServicesDetailFilteredEstimate));
  CHECK_EQ(services_sql(filtered, 60000, 0, true), std::string(golden::kServicesDetailFiltered));
  // A day of 565 M spans is read as 48 slices: one for each chart bucket of 30 minutes.
  const int64_t day_start = 1789689600000LL, day_end = 1789776000000LL;
  const ServicesWindow sampled = services_window(day_start, day_end, 1800000, 0, 564912223ULL, false);
  CHECK(sampled.sampled);
  CHECK_EQ(sampled.bucket_scale.size(), size_t(48));
  CHECK_EQ(services_sql(from(sampled.time_sql, entry, ""), 1800000, 0, false), std::string(golden::kServicesSampled));
  CHECK_EQ(services_db_sql(table, kAStart, kAEnd, "1", ""), std::string(golden::kServicesDb));
  CHECK_EQ(services_db_sql(table, kAStart, kAEnd, "1", " AND ServiceName = 'api-gateway'"), std::string(golden::kServicesDbDetail));
}

void test_services_window_sampling() {
  const int64_t day_start = 1789689600000LL, day_end = 1789776000000LL;
  // Up to 150 M spans: the window is read in one piece. exact=1 asks for the whole window, whatever its size.
  const ServicesWindow small = services_window(day_start, day_end, 1800000, 0, 150000000ULL, false);
  CHECK(!small.sampled);
  CHECK_EQ(small.time_sql, time_predicate(day_start, day_end));
  CHECK_EQ(small.factor, 1.0);
  CHECK(!services_window(day_start, day_end, 1800000, 0, 900000000ULL, true).sampled);
  // Above that limit: one slice in each bucket, at a stable offset. Together, the slices are 8.8 % of the window for 565 M spans.
  const ServicesWindow big = services_window(day_start, day_end, 1800000, 0, 564912223ULL, false);
  CHECK_EQ(big.sampled_ms, int64_t(7632000));
  CHECK(std::fabs(big.factor - 86400000.0 / 7632000.0) < 1e-9);
  CHECK(big.scale_for(day_start) > 1.0);
  CHECK_EQ(big.scale_for(day_start - 1800000), 1.0);  // a bucket that was not sampled
  CHECK(big.time_sql.rfind("((Timestamp >= fromUnixTimestamp64Milli(", 0) == 0);
  // The same window and the same estimate always give the same slices.
  CHECK_EQ(services_window(day_start, day_end, 1800000, 0, 564912223ULL, false).time_sql, big.time_sql);
  // A bucket that is too short for a slice of 1 minute twice is not sampled.
  CHECK(!services_window(day_start, day_end, 60000, 0, 564912223ULL, false).sampled);
}

Rows services_rows() {
  return {{"3", "api", "", "", "100", "5", "10,20,30", "123456"},
          {"3", "auth", "", "", "50", "0", "1,2,3", "999"},
          {"1", "api", "1789207200000", "", "60", "2", "11,21,31", "100"},
          {"1", "api", "1789207260000", "", "40", "3", "12,22,32", "200"},
          {"2", "api", "", "GET /home", "70", "1", "5,6,7", "5000"},
          {"2", "api", "", "POST /cart", "30", "4", "8,9,10", "9000"}};
}

clickhouse::Block estimate_block(uint64_t rows) {
  clickhouse::Block block;
  for (const char* name : {"database", "table"}) {
    auto column = std::make_shared<clickhouse::ColumnString>();
    column->Append("otel");
    block.AppendColumn(name, column);
  }
  for (const char* name : {"parts", "rows", "marks"}) {
    auto column = std::make_shared<clickhouse::ColumnUInt64>();
    column->Append(name == std::string("rows") ? rows : 3);
    block.AppendColumn(name, column);
  }
  return block;
}

ServicesQuery services_query() {
  ServicesQuery query;
  query.table = "`otel`.`otel_traces`";
  query.visibility = "1";
  query.span_scope = "entry";
  query.start_ms = kAStart;
  query.end_ms = kAEnd;
  return query;
}

void test_the_services_are_read_in_one_scan() {
  FakeDb db;
  db.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(456356); });
  db.on("GROUPING SETS", services_rows());
  ServicesQuery query = services_query();
  query.detail = "api";
  query.releases_supported = true;
  db.on("ORDER BY Duration DESC", {{"t1", "s1", "GET /home", "1789207200100", "900000000", "Error"}});
  db.on("service.version", {{"1.2.0", "1789207200000", "700"}, {"1.3.0", "1789207900000", "20"}});
  const auto result = run_services(db, query);
  CHECK(result);
  const ServicesOutcome& out = *result.value;
  CHECK_EQ(out.span_kind, std::string(kServiceEntrySpans));
  CHECK_EQ(out.bucket_ms, int64_t(60000));
  CHECK_EQ(out.window.estimated_rows, uint64_t(456356));
  CHECK(!out.window.sampled);
  CHECK_EQ(out.services.size(), size_t(2));
  CHECK_EQ(out.services.at("api").spans, uint64_t(100));
  CHECK_EQ(out.services.at("api").p95, uint64_t(20));
  CHECK_EQ(out.services.at("api").total_ns, 123456.0);
  CHECK_EQ(out.series.at("api").size(), size_t(2));
  CHECK_EQ(out.series.at("api").at(1789207260000LL).errors, uint64_t(3));
  // The endpoints by total time, the longest first.
  CHECK_EQ(out.endpoints.size(), size_t(2));
  CHECK_EQ(out.endpoints[0].first, std::string("POST /cart"));
  CHECK_EQ(out.slowest.size(), size_t(1));
  CHECK_EQ(out.slowest[0].duration_ns, uint64_t(900000000));
  CHECK(out.releases_supported && !out.releases_estimated);
  CHECK_EQ(out.releases.size(), size_t(2));
  CHECK(!out.partial);
  // Without a drill-down: no endpoints, no slowest spans, no releases.
  FakeDb plain;
  plain.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(10); });
  plain.on("GROUPING SETS", services_rows());
  ServicesQuery overview = services_query();
  const auto totals = run_services(plain, overview);
  CHECK(totals.value->endpoints.empty() && totals.value->slowest.empty() && totals.value->releases.empty());
  CHECK_EQ(plain.sqls.size(), size_t(2));
}

void test_the_services_read_stops_at_its_time_budget_and_keeps_what_it_has() {
  FakeDb db;
  db.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(10); });
  db.on("GROUPING SETS", services_rows());
  db.bounded_result.elapsed_ms = 24900;  // 25 s of budget, less the margin of 250 ms
  const auto result = run_services(db, services_query());
  CHECK(result.value->partial);
  CHECK_EQ(result.value->services.size(), size_t(2));
  // The release markers are decoration. A failure leaves them out and states this.
  FakeDb marks;
  marks.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(10); });
  marks.on("GROUPING SETS", services_rows());
  marks.fail_on("service.version", [] { throw std::runtime_error("bloom filter index is missing"); });
  ServicesQuery query = services_query();
  query.detail = "api";
  query.releases_supported = true;
  const auto kept = run_services(marks, query);
  CHECK(kept);
  CHECK(kept.value->releases.empty() && kept.value->releases_estimated);
  CHECK_EQ(marks.invalidated, 1);
  // The scan gives the services of the view. A failure of the scan is a failure of the route.
  FakeDb failing;
  failing.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(10); });
  failing.fail_on("GROUPING SETS", [] { throw server_error(241, "Memory limit exceeded"); });
  bool thrown = false;
  try {
    run_services(failing, services_query());
  } catch (const std::exception&) {
    thrown = true;
  }
  CHECK(thrown);
  CHECK_EQ(failing.invalidated, 1);
}

void test_a_failed_estimate_reads_the_window_whole_on_a_new_connection() {
  FakeDb db;
  db.fail_on("EXPLAIN ESTIMATE", [] { throw std::runtime_error("estimate is not available"); });
  db.on("GROUPING SETS", services_rows());
  const auto result = run_services(db, services_query());
  CHECK(result);
  CHECK_EQ(result.value->window.estimated_rows, uint64_t(0));
  CHECK(!result.value->window.sampled);
  CHECK_EQ(db.renewed, 1);
  CHECK_EQ(db.invalidated, 1);
  FakeDb gone;
  gone.renew_ok = false;
  gone.fail_on("EXPLAIN ESTIMATE", [] { throw std::runtime_error("estimate is not available"); });
  const auto refused = run_services(gone, services_query());
  CHECK(!refused);
  CHECK_EQ(refused.error.code, std::string("trace_source_unavailable"));
}

void test_the_database_statements() {
  FakeDb db;
  db.on("db.query.text", {{"api", "SELECT 1", "postgresql", "10", "1", "5000", "300"}, {"auth", "UPDATE t SET a = 1", "mysql", "4", "0", "900", "100"}});
  db.bounded_result.read_rows = kServicesDbReadRowsCap;
  const DbOutcome out = run_services_db(db, services_query(), true);
  CHECK(out.supported);
  CHECK_EQ(out.rows.size(), size_t(2));
  CHECK_EQ(out.rows[0].system, std::string("postgresql"));
  CHECK_EQ(out.rows[0].total_ns, 5000.0);
  CHECK_EQ(out.rows[0].p95, uint64_t(300));
  CHECK_EQ(out.read.read_rows, kServicesDbReadRowsCap);
  // The page may not read the span attributes, since they are not a Map. The code asks nothing.
  FakeDb none;
  const DbOutcome unsupported = run_services_db(none, services_query(), false);
  CHECK(!unsupported.supported && unsupported.rows.empty() && none.sqls.empty());
}

void test_the_services_service_builds_the_where_of_the_entry_spans() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  db.on_block("EXPLAIN ESTIMATE", [](const std::string&) { return estimate_block(10); });
  db.on("GROUPING SETS", services_rows());
  RequestContext context;
  ServicesRequest request;
  request.source_host_id = "local";
  request.start_ms = kAStart;
  request.end_ms = kAEnd;
  request.detail = "api";
  request.filters.status = "Error";
  request.min_duration_ms = 5;
  request.max_duration_ms = 90;
  const auto answer = service.services(context, trace_host(), request);
  CHECK(answer);
  // The filters, then the service of the drill-down, then the bounds of the duration of the span.
  CHECK(db.sqls[1].find(" WHERE 1 AND StatusCode = 'Error' AND ServiceName = 'api' AND Duration >= 5000000 AND Duration <= 90000000") != std::string::npos);
  CHECK_EQ(answer.value->span_scope, std::string("entry"));
  rapidjson::Document doc;
  doc.Parse(services_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(std::string(doc["detail"].GetString()), std::string("api"));
  CHECK_EQ(doc["services"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(std::string(doc["services"][0][0].GetString()), std::string("api"));
  CHECK_EQ(doc["services"][0][1].GetUint64(), uint64_t(100));
  CHECK_EQ(doc["series"]["api"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(doc["endpoints"].Size(), rapidjson::SizeType(2));
  CHECK(doc.HasMember("slowest") && doc.HasMember("releases"));
  CHECK_EQ(doc["estimated"].GetBool(), false);
  CHECK_EQ(doc["exact_rows_limit"].GetUint64(), kServicesExactRows);
  // The database statements have the same WHERE clause.
  FakeDb dbs;
  TraceService db_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(dbs)); }, cache.refs());
  dbs.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "String"}});
  dbs.on("db.query.text", {{"api", "SELECT 1", "postgresql", "10", "1", "5000", "300"}});
  const auto statements = db_service.services_db(context, trace_host(), request);
  CHECK(statements);
  rapidjson::Document sd;
  sd.Parse(services_db_json(*statements.value).c_str());
  CHECK_EQ(sd["supported"].GetBool(), true);
  CHECK_EQ(sd["statements"].Size(), rapidjson::SizeType(1));
  // A source whose span attributes are not a Map has no statements. The code asks for no statement.
  FakeDb plain;
  TestCaches plain_cache;
  TraceService plain_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(plain)); }, plain_cache.refs());
  plain.on("FROM system.columns", {{"SpanAttributes", "String"}, {"ResourceAttributes", "String"}});
  const auto empty = plain_service.services_db(context, trace_host(), request);
  CHECK(empty && !empty.value->outcome.supported);
  CHECK_EQ(plain.count("db.query.text"), size_t(0));
}

void test_the_services_request() {
  TraceSettings traces = settings();
  traces.analytics = true;
  ServicesRequest parsed;
  ApiError error;
  CHECK(parse_services(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"scope", "root"}, {"detail", "api"}, {"exact", "1"},
                                {"bucket_origin_ms", "1234"}, {"align_buckets", "1"}, {"status", "Error"}}),
                       traces, &parsed, &error));
  CHECK_EQ(parsed.span_scope, std::string("root"));
  CHECK_EQ(parsed.detail, std::string("api"));
  CHECK(parsed.exact && parsed.align_buckets);
  CHECK_EQ(parsed.bucket_origin_ms, int64_t(1234));
  CHECK_EQ(parsed.filters.status, std::string("Error"));
  ServicesRequest defaults;
  CHECK(parse_services(request({{"start_ms", "1000"}, {"end_ms", "9000"}}), traces, &defaults, &error));
  CHECK_EQ(defaults.span_scope, std::string("entry"));
  CHECK(!defaults.exact && !defaults.align_buckets);
  auto refused = [&](std::initializer_list<std::pair<const char*, const char*>> params, const TraceSettings& use) {
    ServicesRequest out;
    ApiError e;
    CHECK(!parse_services(request(params), use, &out, &e));
    return e;
  };
  CHECK_EQ(refused({{"scope", "everything"}}, traces).message, std::string("scope must be entry or root."));
  CHECK_EQ(refused({{"detail", std::string(1025, 'x').c_str()}}, traces).message, std::string("detail is limited to 1024 bytes."));
  CHECK_EQ(refused({{"min_duration_ms", "9"}, {"max_duration_ms", "3"}}, traces).code, std::string("invalid_trace_duration"));
  CHECK_EQ(refused({{"tag", "nokey"}}, traces).code, std::string("invalid_trace_filter"));
  TraceSettings off = traces;
  off.analytics = false;
  const ApiError disabled = refused({{"start_ms", "1000"}}, off);
  CHECK_EQ(disabled.status, 404);
  CHECK_EQ(disabled.message, std::string("Trace analytics (and the services view) are disabled by configuration."));
  TraceSettings no_service_filter = traces;
  no_service_filter.features.service_filter = false;
  CHECK_EQ(refused({{"detail", "api"}}, no_service_filter).message, std::string("service filter is disabled by traces.features"));
}

// ---- the discovery reads ----

void test_prefill_and_facet_statements_are_unchanged() {
  const std::string table = "`otel`.`otel_traces`";
  // The first pass reads the newest 5 minutes. The second pass reads the whole window, without the known pairs.
  CHECK_EQ(prefill_pass_sql(table, 1789210500000LL, kAEnd, "1", "", "", 20000000), std::string(golden::kPrefillSeed));
  const std::set<std::pair<std::string, std::string>> known{{"a", "x"}, {"b", "it's"}};
  const std::string excluded = prefill_excluded_sql(known);
  CHECK_EQ(excluded, std::string(" AND (ServiceName, SpanName) NOT IN (('a', 'x'), ('b', 'it\\'s'))"));
  CHECK_EQ(prefill_pass_sql(table, kAStart, kAEnd, "1", "", excluded, 20000000), fill(golden::kPrefillPass, {{"KNOWN", "('a', 'x'), ('b', 'it\\'s')"}}));
  CHECK_EQ(prefill_pass_sql(table, kAStart, kAEnd, "1", kTagFilter, excluded, 20000000),
           fill(golden::kPrefillPassTagged, {{"KNOWN", "('a', 'x'), ('b', 'it\\'s')"}}));
  CHECK_EQ(prefill_excluded_sql({}), std::string());
  CHECK_EQ(facet_keys_sql(table, kAStart, kAEnd, "1", "", true, true, 50000000), std::string(golden::kFacetKeys));
  CHECK_EQ(facet_keys_sql(table, kAStart, kAEnd, "1", " AND ServiceName = 'api-gateway' AND StatusCode = 'Error'", true, true, 50000000),
           std::string(golden::kFacetKeysFiltered));
  CHECK_EQ(facet_values_sql(table, kAStart, kAEnd, "1", "", "span", "server.address", 10, 50000000), std::string(golden::kFacetValues));
  CHECK_EQ(facet_values_sql(table, kAStart, kAEnd, "1", " AND ServiceName = 'api-gateway'", "span", "server.address", 3, 50000000),
           std::string(golden::kFacetValuesFiltered));
  // A source with one map reads only that map.
  const std::string span_only = facet_keys_sql(table, kAStart, kAEnd, "1", "", true, false, 1000);
  CHECK(span_only.find("ResourceAttributes") == std::string::npos && span_only.find("SpanAttributes.keys AS sk") != std::string::npos);
}

void test_the_prefill_reads_what_it_does_not_know() {
  FakeDb db;
  // The seed holds most of the pairs. The pass over the whole window finds one more pair and completes the list.
  db.on_fn("LIMIT 1 BY ServiceName, SpanName", [](const std::string& sql) -> Rows {
    if (sql.find("NOT IN") == std::string::npos) return {{"api", "GET /"}, {"api", "POST /"}};
    return {{"auth", "login"}};
  });
  const Prefill value = read_prefill(db, "`otel`.`otel_traces`", "1", "", kAStart, kAEnd, kPrefillReadRows);
  CHECK_EQ(value.passes, 2);
  CHECK(!value.estimated);
  CHECK(!value.truncated);
  CHECK_EQ(value.pairs.size(), size_t(3));
  CHECK_EQ(value.pairs[0].first, std::string("api"));
  CHECK_EQ(value.pairs[2].second, std::string("login"));
  CHECK_EQ(value.start_ms, kAStart);
  CHECK_EQ(db.sqls[0].find("NOT IN") == std::string::npos, true);
  CHECK(db.sqls[1].find("NOT IN (('api', 'GET /'), ('api', 'POST /'))") != std::string::npos);
  // A window shorter than the seed has no seed pass.
  FakeDb short_window;
  short_window.on("LIMIT 1 BY ServiceName, SpanName", {{"api", "GET /"}});
  CHECK_EQ(read_prefill(short_window, "`t`", "1", "", kAEnd - 60000, kAEnd, kPrefillReadRows).passes, 1);
  // A pass that its read cap cut is repeated, without the pairs found so far.
  // The code repeats the pass until it finds nothing new. The list is then a subset, and it is estimated.
  FakeDb cut;
  cut.bounded_result.read_rows = kPrefillPassRows;
  cut.on_fn("LIMIT 1 BY ServiceName, SpanName", [](const std::string& sql) -> Rows {
    if (sql.find("NOT IN") == std::string::npos) return {{"api", "GET /"}};
    return {};
  });
  const Prefill subset = read_prefill(cut, "`t`", "1", "", kAStart, kAEnd, kPrefillReadRows);
  CHECK(subset.estimated);
  CHECK_EQ(subset.passes, 2);
  CHECK_EQ(subset.read_rows, uint64_t(2) * kPrefillPassRows);
  // The read budget limits the passes. A budget of one pass leaves no row for the second pass.
  FakeDb budget;
  budget.bounded_result.read_rows = 1000;
  budget.on("LIMIT 1 BY ServiceName, SpanName", {{"api", "GET /"}});
  const Prefill lowered = read_prefill(budget, "`t`", "1", "", kAStart, kAEnd, 1000);
  CHECK(lowered.estimated);
  CHECK_EQ(lowered.passes, 1);
  CHECK(budget.sqls[0].find("max_rows_to_read = 1000") != std::string::npos);
}

void test_the_facet_keys_and_values_are_sorted_and_bounded() {
  FakeDb db;
  db.on("sumMap(sk", {{"3000", "span", "http.route", "300"}, {"3000", "resource", "host.name", "300"}, {"3000", "span", "a.key", "300"},
                      {"3000", "resource", "a.key", "300"}, {"3000", "span", "rare", "7"}});
  const FacetKeys keys = read_facet_keys(db, "SELECT sumMap(sk", 50000000);
  CHECK_EQ(keys.sampled_spans, uint64_t(3000));
  CHECK_EQ(keys.keys.size(), size_t(5));
  // By count, then by key, then the span map before the resource map.
  CHECK_EQ(keys.keys[0].key, std::string("a.key"));
  CHECK_EQ(keys.keys[0].scope, std::string("span"));
  CHECK_EQ(keys.keys[1].scope, std::string("resource"));
  CHECK_EQ(keys.keys[4].key, std::string("rare"));
  CHECK(!keys.estimated);
  // A read that reaches its cap is an estimate. A sample that is full is an estimate too.
  FakeDb capped;
  capped.bounded_result.read_rows = 1000;
  capped.on("sumMap(sk", {{"10", "span", "k", "1"}});
  CHECK(read_facet_keys(capped, "SELECT sumMap(sk", 1000).estimated);
  FakeDb full;
  full.on("sumMap(sk", {{std::to_string(kFacetSampleRows), "span", "k", "1"}});
  CHECK(read_facet_keys(full, "SELECT sumMap(sk", 50000000).estimated);
  // The keys beyond the served ones (and one more, which says truncated) are dropped.
  FakeDb many;
  Rows rows;
  for (size_t i = 0; i < kFacetMaxKeys + 20; ++i) rows.push_back({"1", "span", "k" + std::to_string(1000 + i), "5"});
  many.on("sumMap(sk", rows);
  CHECK_EQ(read_facet_keys(many, "SELECT sumMap(sk", 50000000).keys.size(), kFacetMaxKeys + 1);
  FakeDb values;
  values.on("OVER ()", {{"/cart", "40", "100", "250"}, {"/home", "30", "100", "250"}});
  const FacetValues v = read_facet_values(values, "SELECT toString(v) OVER ()", 50000000);
  CHECK_EQ(v.values.size(), size_t(2));
  CHECK_EQ(v.spans_with_key, uint64_t(100));
  CHECK_EQ(v.distinct_values, uint64_t(250));
  CHECK(!v.estimated);
  FakeDb groups;
  groups.on("OVER ()", {{"/cart", "40", "100", std::to_string(kFacetGroupByCap)}});
  CHECK(read_facet_values(groups, "SELECT toString(v) OVER ()", 50000000).estimated);
}

void test_the_schema_of_the_source() {
  FakeDb db;
  db.on("FROM system.columns", {{"Timestamp"}, {"TraceId"}, {"SpanId"}, {"ParentSpanId"}, {"SpanName"}, {"ServiceName"}, {"Duration"}, {"StatusCode"}, {"SpanAttributes"}});
  db.on("FROM system.tables", {{"1"}});
  MetaOutcome out;
  read_schema(db, trace_host().otel.traces, &out);
  CHECK(out.schema_ok && out.index_available);
  CHECK_EQ(db.sqls[1], std::string("SELECT toString(count()) FROM system.tables WHERE database = 'otel' AND name = 'otel_traces_trace_id_ts'"));
  // A column that the page reads is absent: the result is not ok. Without a trace index table, the code asks nothing about it.
  FakeDb missing;
  missing.on("FROM system.columns", {{"Timestamp"}, {"TraceId"}});
  HostSpec host = trace_host();
  host.otel.traces.trace_index_table.clear();
  MetaOutcome partial;
  read_schema(missing, host.otel.traces, &partial);
  CHECK(!partial.schema_ok && !partial.index_available);
  CHECK_EQ(missing.sqls.size(), size_t(1));
  // The service reads it fresh. The maps that it reads replace the cached ones.
  FakeDb source;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(source)); }, cache.refs());
  source.on("name IN ('SpanAttributes','ResourceAttributes')", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "String"}});
  source.on("FROM system.columns", {{"Timestamp"}});
  source.on("FROM system.tables", {{"0"}});
  RequestContext context;
  const auto answer = service.meta(context, trace_host(), "local");
  CHECK(answer);
  CHECK(!answer.value->outcome.schema_ok && !answer.value->outcome.index_available);
  CHECK(answer.value->outcome.span_attribute_map && !answer.value->outcome.resource_attribute_map);
  bool span_map = false, resource_map = true;
  ForwardDb reader(source);
  const size_t before = source.sqls.size();
  CHECK(cached_attribute_maps(reader, cache.attribute_maps, trace_host(), trace_host().otel.traces, &span_map, &resource_map));
  CHECK(span_map && !resource_map);
  CHECK_EQ(source.sqls.size(), before);  // answered by the cache that meta filled
  rapidjson::Document doc;
  doc.Parse(meta_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["tag_search_supported"].GetBool(), true);
  CHECK_EQ(doc["schema_ok"].GetBool(), false);
  CHECK_EQ(doc["context_windows_ms"].Size(), rapidjson::SizeType(4));
  CHECK_EQ(doc["features"]["links"].GetBool(), true);
  // A failure of the schema read is its own error.
  FakeDb broken;
  TraceService broken_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(broken)); }, cache.refs());
  broken.fail_on("FROM system.columns", [] { throw server_error(497, "Not enough privileges"); });
  const auto denied = broken_service.meta(context, trace_host(), "local");
  CHECK(!denied);
  CHECK_EQ(denied.error.status, 503);  // a missing grant is a 503 not_granted on every page
  CHECK_EQ(denied.error.code, std::string("trace_not_granted"));
}

void test_the_prefill_and_the_facets_are_cached_by_window_and_filters() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  db.on("LIMIT 1 BY ServiceName, SpanName", {{"api", "GET /"}});
  db.on("sumMap(sk", {{"100", "span", "k", "9"}});
  db.on("OVER ()", {{"v1", "9", "9", "1"}});
  RequestContext context;
  PrefillRequest prefill;
  prefill.source_host_id = "local";
  prefill.start_ms = kAStart + 1500;
  prefill.end_ms = kAEnd - 1500;
  prefill.aligned_start_ms = kAStart;
  prefill.aligned_end_ms = kAEnd;
  prefill.read_budget = kPrefillReadRows;
  const auto first = service.prefill(context, trace_host(), prefill);
  CHECK(first);
  const size_t after_first = db.sqls.size();
  CHECK(service.prefill(context, trace_host(), prefill));
  CHECK_EQ(db.sqls.size(), after_first);  // the second request of the minute reads nothing
  rapidjson::Document doc;
  doc.Parse(prefill_json(*first.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["pairs"].Size(), rapidjson::SizeType(1));
  CHECK_EQ(doc["pairs"][0][2].GetUint64(), uint64_t(1));  // the count is kept for compatibility
  CHECK_EQ(doc["range"][0].GetInt64(), kAStart + 1500);   // the range that was asked, not the aligned one
  CHECK_EQ(doc["scan"]["read_rows_limit"].GetUint64(), kPrefillReadRows);
  // A tag filter has its own entry, and it narrows the pairs.
  PrefillRequest tagged = prefill;
  tagged.filters.tags.push_back(TagFilter{"span", TagOp::Eq, "k", "v"});
  CHECK(service.prefill(context, trace_host(), tagged));
  CHECK(db.count("SpanAttributes['k'] = 'v'") > 0);
  // The facets: keys, and the values of a key.
  FacetRequest facets;
  facets.source_host_id = "local";
  facets.start_ms = kAStart;
  facets.end_ms = kAEnd;
  facets.aligned_start_ms = kAStart;
  facets.aligned_end_ms = kAEnd;
  facets.read_cap = kFacetReadRowsCap;
  const auto keys = service.facet_keys(context, trace_host(), facets);
  CHECK(keys && !keys.value->cached);
  CHECK(keys.value->span && keys.value->resource);
  const auto again = service.facet_keys(context, trace_host(), facets);
  CHECK(again.value->cached);
  rapidjson::Document kd;
  kd.Parse(facet_keys_json(*again.value).c_str());
  CHECK(!kd.HasParseError());
  CHECK_EQ(kd["supported"].GetBool(), true);
  CHECK_EQ(kd["cached"].GetBool(), true);
  CHECK_EQ(kd["scopes"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(kd["keys"][0][1].GetString() == std::string("k"), true);
  FacetRequest values = facets;
  values.key_scope = "span";
  values.key = "k";
  values.limit = 5;
  const auto vals = service.facet_values(context, trace_host(), values);
  CHECK(vals);
  rapidjson::Document vd;
  vd.Parse(facet_values_json(*vals.value).c_str());
  CHECK(!vd.HasParseError());
  CHECK_EQ(vd["limit"].GetInt(), 5);
  CHECK_EQ(vd["has_more"].GetBool(), false);
  CHECK_EQ(vd["values"][0][0].GetString() == std::string("v1"), true);
  // The values of a key ignore the filters of that key.
  FacetRequest own = values;
  own.filters.tags.push_back(TagFilter{"span", TagOp::Eq, "k", "v1"});
  own.limit = 6;
  CHECK(service.facet_values(context, trace_host(), own));
  CHECK_EQ(db.count("SpanAttributes['k'] = 'v1'"), size_t(0));
  // A failure of the scan gives 503 with its own code. The code does not keep the failure.
  FakeDb failing;
  TraceService failing_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(failing)); }, cache.refs());
  failing.on("FROM system.columns", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  failing.fail_on("OVER ()", [] { throw std::runtime_error("the scan failed"); });
  FacetRequest other = values;
  other.key = "another";
  const auto failed = failing_service.facet_values(context, trace_host(), other);
  CHECK(!failed);
  CHECK_EQ(failed.error.status, 503);
  CHECK_EQ(failed.error.code, std::string("trace_facet_values_failed"));
  CHECK_EQ(failing.invalidated, 1);
  // A scope that is not a Map is refused before the scan. A scope that traces.features disables is refused too.
  FakeDb plain;
  TestCaches plain_cache;
  TraceService plain_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(plain)); }, plain_cache.refs());
  plain.on("FROM system.columns", {{"SpanAttributes", "String"}, {"ResourceAttributes", "Map(String, String)"}});
  CHECK_EQ(plain_service.facet_values(context, trace_host(), values).error.code, std::string("trace_tag_search_unsupported"));
  // With no usable map, the keys are answered empty, and the code makes no scan.
  FacetRequest none = facets;
  none.aligned_start_ms = kAStart + 60000;
  FakeDb nothing;
  TestCaches nothing_cache;
  TraceService no_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(nothing)); }, nothing_cache.refs());
  nothing.on("FROM system.columns", {{"SpanAttributes", "String"}, {"ResourceAttributes", "String"}});
  const auto empty = no_service.facet_keys(context, trace_host(), none);
  CHECK(empty && !empty.value->span && !empty.value->resource && empty.value->value->keys.empty());
  CHECK_EQ(nothing.count("sumMap"), size_t(0));
}

void test_the_requests_of_the_discovery_routes() {
  TraceSettings traces = settings();
  PrefillRequest prefill;
  ApiError error;
  CHECK(parse_prefill(request({{"start_ms", "1789207201500"}, {"end_ms", "1789210798500"}, {"read_rows_limit", "3000"}}), traces, &prefill, &error));
  CHECK_EQ(prefill.aligned_start_ms, int64_t(1789207200000LL));
  CHECK_EQ(prefill.aligned_end_ms, int64_t(1789210800000LL));
  CHECK_EQ(prefill.read_budget, uint64_t(2000));
  CHECK(!parse_prefill(request({{"start_ms", "5"}, {"end_ms", "3"}}), traces, &prefill, &error));
  CHECK_EQ(error.code, std::string("invalid_trace_range"));
  CHECK(!parse_prefill(request({{"start_ms", "1000"}, {"end_ms", "2000"}, {"status", "Bad"}}), traces, &prefill, &error));
  CHECK_EQ(error.code, std::string("invalid_trace_filter"));
  // The prefill does not refuse a filter that traces.features disables. The pickers stay selectable.
  TraceSettings no_service = traces;
  no_service.features.service_filter = false;
  CHECK(parse_prefill(request({{"start_ms", "1000"}, {"end_ms", "2000"}, {"service", "api"}}), no_service, &prefill, &error));
  FacetRequest facets;
  CHECK(parse_facets(request({{"start_ms", "1789207201500"}, {"end_ms", "1789210798500"}}), traces, &facets, &error));
  CHECK_EQ(facets.aligned_end_ms, int64_t(1789210800000LL));
  CHECK_EQ(facets.read_cap, kFacetReadRowsCap);
  CHECK(!parse_facets(request({{"start_ms", "1000"}, {"end_ms", "2000"}, {"service", "api"}}), no_service, &facets, &error));
  CHECK_EQ(error.code, std::string("trace_filter_disabled"));
  FacetRequest key;
  CHECK(parse_facet_key(request({{"scope", "resource"}, {"key", "host.name"}, {"limit", "9999"}}), &key, &error));
  CHECK_EQ(key.limit, kFacetMaxValues);
  CHECK_EQ(key.key, std::string("host.name"));
  CHECK(!parse_facet_key(request({{"scope", "log"}, {"key", "k"}}), &key, &error));
  CHECK_EQ(error.message, std::string("scope must be span or resource."));
  CHECK(!parse_facet_key(request({{"scope", "span"}}), &key, &error));
  CHECK_EQ(error.message, std::string("key must be 1 to 512 bytes."));
  CHECK(!parse_facet_key(request({{"scope", "span"}, {"key", std::string(513, 'k').c_str()}}), &key, &error));
}


// ---- one trace, one span, the context, the links ----

const std::string kTraceId = "8db8a43cf3f54ba8f984e09812308d7f";
const std::string kSpanId = "57511f4eadbcc3e7";
constexpr int64_t kAnchorNs = 1789210797865030093LL;

void test_trace_statements_are_unchanged() {
  const TraceSettings traces = trace_host().otel.traces;
  CHECK_EQ(trace_detail_sql(traces, kTraceId, "1"), std::string(golden::kTraceDetail));
  CHECK_EQ(trace_index_bounds_sql(traces, kTraceId), std::string(golden::kLinkedIndexBounds));
  CHECK_EQ(linked_from_sql(traces, kTraceId, "", 1789207197855LL, 1789214397877LL, "1"), std::string(golden::kLinkedFrom));
  CHECK_EQ(linked_from_sql(traces, kTraceId, kSpanId, 1789203600000LL, 1789214400000LL, "1"), std::string(golden::kLinkedFromSpan));
  CHECK_EQ(span_sql(traces, kTraceId, kSpanId, kAnchorNs, "1"), std::string(golden::kSpanOne));
  // The code does not select what traces.features disables. A constant takes its place.
  TraceSettings off = traces;
  off.features.span_attributes = false;
  off.features.events = false;
  off.features.links = false;
  const std::string limited = trace_detail_sql(off, kTraceId, "1");
  CHECK(limited.find("toJSONString(SpanAttributes)") == std::string::npos && limited.find("'{}', toJSONString(ResourceAttributes), '[]', '[]', '[]', '[]', '[]', '[]'") != std::string::npos);
  CHECK(span_sql(off, kTraceId, kSpanId, 1, "1").find("'[]', '[]', '[]'") != std::string::npos);
  // With a restricted allowlist, a link names only a span of the trace that the allowlist shows.
  const std::string restricted = linked_from_sql(traces, kTraceId, "", 1000, 2000, "(ServiceName = 'a')");
  CHECK(restricted.find("AS visible_targets") != std::string::npos && restricted.find("has(visible_targets, s)") != std::string::npos);
  CHECK(restricted.find("arrayExists") != std::string::npos);
  // The context: the window, the filter, and a page in a direction.
  const std::string table = "`otel`.`otel_traces`";
  const int64_t window_ns = 60000 * kNsPerMs;
  const std::string base = context_base_sql(table, kAnchorNs - window_ns, kAnchorNs + window_ns, "1", "");
  CHECK_EQ(context_page_sql(base, context_keyset_around(kAnchorNs, false), 25, false), std::string(golden::kContextOlderAround));
  CHECK_EQ(context_page_sql(base, context_keyset_around(kAnchorNs, true), 25, true), std::string(golden::kContextNewerAround));
  const std::string service_base = context_base_sql(table, kAnchorNs - 10000 * kNsPerMs, kAnchorNs + 10000 * kNsPerMs, "1", "ServiceName = 'checkout'");
  CHECK_EQ(context_page_sql(service_base, context_keyset_around(kAnchorNs, false), 25, false), std::string(golden::kContextOlderService));
  CHECK_EQ(context_page_sql(context_base_sql(table, kAnchorNs - window_ns, kAnchorNs + window_ns, "1", context_filter_sql("ResourceAttributes", "host.name", "x")),
                            context_keyset_around(kAnchorNs, false), 25, false), std::string(golden::kContextOlderHost));
  CHECK_EQ(context_page_sql(context_base_sql(table, kAnchorNs - window_ns, kAnchorNs + window_ns, "1",
                                             context_filter_sql("SpanAttributes", "server.address", "frontend.shop.svc.cluster.local")),
                            context_keyset_around(kAnchorNs, false), 25, false), std::string(golden::kContextOlderAttribute));
  CHECK_EQ(context_page_sql(base, context_keyset_after(kAnchorNs, kSpanId, false), 7, false), std::string(golden::kContextOlderCursor));
  const std::string narrow = context_base_sql(table, kAnchorNs - 1000 * kNsPerMs, kAnchorNs + 1000 * kNsPerMs, "1", "");
  CHECK_EQ(context_page_sql(narrow, context_keyset_after(kAnchorNs, kSpanId, true), 7, true), std::string(golden::kContextNewerCursor));
}

void test_a_parent_that_the_allowlist_hides_is_never_named() {
  const std::unordered_set<std::string> shown{"a", "b"};
  CHECK_EQ(std::string(visible_parent("", false)), std::string());
  // Every service is allowed. Every parent is named.
  CHECK_EQ(std::string(visible_parent("p", true)), std::string("p"));
  // A restricted allowlist: an answer about many traces names no parent. An answer about one trace names the parents that it shows too.
  CHECK_EQ(std::string(visible_parent("p", false)), std::string());
  CHECK_EQ(std::string(visible_parent("a", false, &shown)), std::string("a"));
  CHECK_EQ(std::string(visible_parent("hidden", false, &shown)), std::string());
  CHECK_EQ(std::string(visible_parent("hidden", true, &shown)), std::string());  // the list decides, whatever the allowlist
}

Rows span_row(const std::string& trace, const std::string& span, const std::string& parent, const std::string& service, int64_t ts_ns) {
  return {{"2026-09-12 10:00:00.000000000", std::to_string(ts_ns), trace, span, parent, "GET /home", "Server", service, "1000000", "Ok"}};
}

Row detail_row(const std::string& span, const std::string& parent, const std::string& service, int64_t ts_ns) {
  return {"2026-09-12 10:00:00.000000000", std::to_string(ts_ns), kTraceId, span, parent, "GET /home", "Server", service, "1000000", "Ok", "msg",
          "{\"k\":\"v\"}", "{\"host.name\":\"h\"}", "[]", "[]", "[]", "[]", "[]", "[]"};
}

void test_the_spans_of_a_trace_hide_the_parents_that_the_allowlist_hides() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("AS trace_bounds", {detail_row("s1", "", "api", 10), detail_row("s2", "s1", "api", 20), detail_row("s3", "hidden", "auth", 30)});
  RequestContext context;
  TraceDetailRequest request;
  request.source_host_id = "local";
  request.trace_id = kTraceId;
  const auto all = service.trace_detail(context, trace_host(), request);
  CHECK(all);
  CHECK_EQ(all.value->spans.size(), size_t(3));
  // Every service is allowed. A parent that no span of the answer carries is still named. It may be in another window.
  CHECK_EQ(all.value->spans[2].parent_span_id, std::string());  // the parents of an answer about one trace are the spans that it shows
  CHECK_EQ(all.value->spans[1].parent_span_id, std::string("s1"));
  rapidjson::Document doc;
  doc.Parse(trace_detail_json(*all.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(std::string(doc["range_source"].GetString()), std::string("trace_index"));
  CHECK_EQ(doc["spans"].Size(), rapidjson::SizeType(3));
  CHECK_EQ(std::string(doc["spans"][0]["span_attributes"].GetString()), std::string("{\"k\":\"v\"}"));
  CHECK_EQ(doc["truncated"].GetBool(), false);
  // traces.features disables a part of the answer.
  HostSpec off = trace_host();
  off.otel.traces.features.events = false;
  off.otel.traces.features.span_attributes = false;
  const auto limited = service.trace_detail(context, off, request);
  rapidjson::Document less;
  less.Parse(trace_detail_json(*limited.value).c_str());
  CHECK(!less["spans"][0].HasMember("events_name") && !less["spans"][0].HasMember("span_attributes") && less["spans"][0].HasMember("links_span_id"));
  // More spans than traces.max_spans_per_trace: the answer states that it is cut.
  HostSpec small = trace_host();
  small.otel.traces.max_spans_per_trace = 2;
  const auto cut = service.trace_detail(context, small, request);
  CHECK(cut.value->truncated);
  CHECK_EQ(cut.value->spans.size(), size_t(2));
  CHECK(db.sqls.back().find("LIMIT 3") != std::string::npos);
}

void test_the_detail_of_a_trace_says_what_is_missing() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  RequestContext context;
  TraceDetailRequest request;
  request.source_host_id = "local";
  request.trace_id = kTraceId;
  const auto missing = service.trace_detail(context, trace_host(), request);
  CHECK(!missing);
  CHECK_EQ(missing.error.status, 404);
  CHECK_EQ(missing.error.code, std::string("trace_not_found"));
  // The detail needs the trace index. The code reads it after the connection, as the route always did.
  HostSpec no_index = trace_host();
  no_index.otel.traces.trace_index_table.clear();
  const auto unavailable = service.trace_detail(context, no_index, request);
  CHECK_EQ(unavailable.error.status, 503);
  CHECK_EQ(unavailable.error.code, std::string("trace_index_unavailable"));
  TraceService gone([](const HostSpec&, std::string*) -> std::unique_ptr<ChExecutor> { return nullptr; }, cache.refs());
  CHECK_EQ(gone.trace_detail(context, no_index, request).error.code, std::string("trace_source_unavailable"));
  FakeDb failing;
  TraceService failing_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(failing)); }, cache.refs());
  failing.fail_on("AS trace_bounds", [] { throw server_error(60, "Table otel.otel_traces_trace_id_ts does not exist"); });
  CHECK_EQ(failing_service.trace_detail(context, trace_host(), request).error.code, std::string("trace_index_lookup_failed"));
}

void test_one_span_by_its_key() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  Row row = detail_row(kSpanId, "parent", "api", kAnchorNs);
  db.on("PREWHERE Timestamp = ", {row});
  RequestContext context;
  SpanRequest request;
  request.source_host_id = "local";
  request.trace_id = kTraceId;
  request.span_id = kSpanId;
  request.timestamp_ns = kAnchorNs;
  const auto answer = service.span(context, trace_host(), request);
  CHECK(answer);
  CHECK_EQ(db.sqls[0], std::string(golden::kSpanOne));
  rapidjson::Document doc;
  doc.Parse(span_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(std::string(doc["span"]["span_id"].GetString()), kSpanId);
  CHECK_EQ(std::string(doc["span"]["parent_span_id"].GetString()), std::string("parent"));
  CHECK_EQ(doc["span"]["start_ns"].GetInt64(), kAnchorNs);
  CHECK_EQ(std::string(doc["span"]["start_ns_text"].GetString()), std::to_string(kAnchorNs));
  // A restricted allowlist: an answer about one span cannot know which parents are hidden. It names no parent.
  HostSpec restricted = trace_host();
  restricted.otel.traces.service_allowlist = {"api"};
  const auto hidden = service.span(context, restricted, request);
  rapidjson::Document hd;
  hd.Parse(span_json(*hidden.value).c_str());
  CHECK_EQ(std::string(hd["span"]["parent_span_id"].GetString()), std::string());
  FakeDb none;
  TraceService none_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(none)); }, cache.refs());
  const auto absent = none_service.span(context, trace_host(), request);
  CHECK_EQ(absent.error.status, 404);
  CHECK_EQ(absent.error.code, std::string("span_not_found"));
  FakeDb failing;
  TraceService failing_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(failing)); }, cache.refs());
  failing.fail_on("PREWHERE Timestamp = ", [] { throw std::runtime_error("boom"); });
  CHECK_EQ(failing_service.span(context, trace_host(), request).error.code, std::string("trace_span_failed"));
  CHECK_EQ(failing.invalidated, 1);
}

void test_the_spans_that_link_to_a_trace() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  RequestContext context;
  LinkedFromRequest request;
  request.source_host_id = "local";
  request.trace_id = kTraceId;
  // traces.features disables the links.
  HostSpec off = trace_host();
  off.otel.traces.features.links = false;
  CHECK_EQ(service.linked_from(context, off, request).error.code, std::string("trace_links_disabled"));
  CHECK(db.sqls.empty());  // nothing is asked, not even a connection
  // Without a window, the trace index gives the bounds of the trace. A trace that the index does not know gives 404.
  CHECK_EQ(service.linked_from(context, trace_host(), request).error.code, std::string("trace_not_found"));
  db.on("FROM `otel`.`otel_traces_trace_id_ts` WHERE TraceId", {{"3", "1789207200000", "1789210796000"}});
  Rows links;
  for (int i = 0; i < 101; ++i) {
    Row row = {"2026-09-12 10:00:00.000000000", std::to_string(kAnchorNs - i), "other" + std::to_string(i), "sp" + std::to_string(i), "parent", "GET /", "Client", "api",
               "1000", "Ok", "[\"" + kSpanId + "\"]", "[{}]"};
    links.push_back(row);
  }
  db.on("PREWHERE has(Links.TraceId, trace)", links);
  const auto answer = service.linked_from(context, trace_host(), request);
  CHECK(answer);
  CHECK_EQ(answer.value->range_source, std::string("trace_index"));
  // The window of the trace is widened by traces.linked_from_margin_minutes (60) on each side. The end that the index gave is taken, plus 1 ms.
  CHECK_EQ(answer.value->lo_ms, int64_t(1789207200000LL - 3600000));
  CHECK_EQ(answer.value->hi_ms, int64_t(1789210796001LL + 3600000));
  CHECK(answer.value->truncated);
  CHECK_EQ(answer.value->rows.size(), kLinkedFromLimit);
  rapidjson::Document doc;
  doc.Parse(linked_from_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["rows"].Size(), rapidjson::SizeType(100));
  CHECK_EQ(doc["limit"].GetUint64(), uint64_t(100));
  CHECK_EQ(std::string(doc["rows"][0]["link_span_ids"].GetString()), "[\"" + kSpanId + "\"]");
  CHECK_EQ(std::string(doc["rows"][0]["parent_span_id"].GetString()), std::string("parent"));  // every service is allowed
  // The code uses a window from the caller as it is, and checks it.
  LinkedFromRequest windowed = request;
  windowed.has_range = true;
  windowed.start_ms = kAStart;
  windowed.end_ms = kAEnd;
  const auto explicit_window = service.linked_from(context, trace_host(), windowed);
  CHECK_EQ(explicit_window.value->range_source, std::string("request"));
  CHECK_EQ(explicit_window.value->lo_ms, kAStart - 3600000);
  windowed.end_ms = kAStart - 1;
  CHECK_EQ(service.linked_from(context, trace_host(), windowed).error.code, std::string("invalid_trace_range"));
  windowed.end_ms = kAStart + int64_t(8) * 24 * 3600 * 1000;
  CHECK_EQ(service.linked_from(context, trace_host(), windowed).error.message, std::string("Trace time range exceeds traces.max_lookback_minutes."));
  // Without a trace index, the caller must give the window.
  HostSpec no_index = trace_host();
  no_index.otel.traces.trace_index_table.clear();
  CHECK_EQ(service.linked_from(context, no_index, request).error.code, std::string("trace_index_unavailable"));
  // A restricted allowlist: the links name no parent.
  HostSpec restricted = trace_host();
  restricted.otel.traces.service_allowlist = {"api"};
  const auto hidden = service.linked_from(context, restricted, windowed.end_ms == 0 ? request : LinkedFromRequest{"local", kTraceId, "", true, kAStart, kAEnd});
  rapidjson::Document hd;
  hd.Parse(linked_from_json(*hidden.value).c_str());
  CHECK_EQ(std::string(hd["rows"][0]["parent_span_id"].GetString()), std::string());
}

void test_the_context_of_a_span() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("Timestamp <= fromUnixTimestamp64Nano(" + std::to_string(kAnchorNs) + ")", {span_row("t", "o1", "p", "api", kAnchorNs - 1)[0], span_row("t", "o2", "p", "api", kAnchorNs - 2)[0], span_row("t", "o3", "p", "api", kAnchorNs - 3)[0]});
  db.on("Timestamp > fromUnixTimestamp64Nano(" + std::to_string(kAnchorNs) + ")", {span_row("t", "n1", "p", "api", kAnchorNs + 1)[0], span_row("t", "n2", "p", "api", kAnchorNs + 2)[0]});
  RequestContext context;
  ContextRequest request;
  request.source_host_id = "local";
  request.anchor_ns = kAnchorNs;
  request.limit = 3;
  const auto answer = service.context(context, trace_host(), request);
  CHECK(answer);
  const ContextOutcome& out = answer.value->outcome;
  // "around" asks for the nearest spans of each side: 2 at or before the anchor, and 1 after. The limit is 3, and the older side gets the odd one.
  CHECK(out.query_older && out.query_newer);
  CHECK_EQ(out.older.size(), size_t(2));
  CHECK_EQ(out.newer.size(), size_t(1));
  CHECK(out.more_older && out.more_newer);
  CHECK_EQ(db.sqls[0].find("LIMIT 3") != std::string::npos, true);
  CHECK_EQ(db.sqls[1].find("LIMIT 2") != std::string::npos, true);
  rapidjson::Document doc;
  doc.Parse(context_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["has_newer"].GetBool(), true);
  CHECK_EQ(doc["has_older"].GetBool(), true);
  // The rows: the newer ones (oldest of them first), then the older ones (newest first). The result is one list in time order, newest first.
  CHECK_EQ(doc["rows"].Size(), rapidjson::SizeType(3));
  CHECK_EQ(std::string(doc["rows"][0]["span_id"].GetString()), std::string("n1"));
  CHECK_EQ(std::string(doc["rows"][1]["span_id"].GetString()), std::string("o1"));
  CHECK_EQ(std::string(doc["rows"][0]["parent_span_id"].GetString()), std::string("p"));
  CHECK_EQ(std::string(doc["timestamp_ns"].GetString()), std::to_string(kAnchorNs));
  CHECK_EQ(doc["range_ns"].Size(), rapidjson::SizeType(2));
  // When the limit is 1, no span on the newer side is wanted. A probe states whether there is more.
  FakeDb probe;
  TraceService probe_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(probe)); }, cache.refs());
  probe.on("Timestamp <= ", {span_row("t", "o1", "p", "api", kAnchorNs - 1)[0]});
  probe.on("Timestamp > ", {span_row("t", "n1", "p", "api", kAnchorNs + 1)[0]});
  ContextRequest one = request;
  one.limit = 1;
  const auto single = probe_service.context(context, trace_host(), one);
  CHECK(single.value->outcome.newer.empty() && single.value->outcome.more_newer && !single.value->outcome.more_older);
  CHECK(probe.sqls[1].find("LIMIT 1") != std::string::npos);
  // Paging: older than a cursor, newer than a cursor.
  FakeDb paged;
  TraceService paged_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(paged)); }, cache.refs());
  paged.on("ORDER BY Timestamp DESC", {span_row("t", "o1", "p", "api", kAnchorNs - 1)[0], span_row("t", "o2", "p", "api", kAnchorNs - 2)[0]});
  ContextRequest older = request;
  older.direction = "older";
  older.cursor_ns = kAnchorNs;
  older.cursor_span = kSpanId;
  older.limit = 7;
  const auto page = paged_service.context(context, trace_host(), older);
  CHECK(page && page.value->outcome.query_older && !page.value->outcome.query_newer && !page.value->outcome.more_older);
  rapidjson::Document pd;
  pd.Parse(context_json(*page.value).c_str());
  CHECK(pd.HasMember("has_older") && !pd.HasMember("has_newer"));
}

void test_the_filters_of_the_context() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("name IN ('SpanAttributes','ResourceAttributes')", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  RequestContext context;
  ContextRequest request;
  request.source_host_id = "local";
  request.anchor_ns = kAnchorNs;
  auto refused = [&](ContextRequest r, const HostSpec& host = trace_host()) { return service.context(context, host, r).error; };
  ContextRequest service_filter = request;
  service_filter.filter = "service";
  CHECK_EQ(refused(service_filter).message, std::string("service is required for the service filter."));
  service_filter.service = "checkout";
  CHECK(service.context(context, trace_host(), service_filter));
  CHECK(db.sqls.back().find("AND ServiceName = 'checkout' AND Timestamp") != std::string::npos);
  ContextRequest host_filter = request;
  host_filter.filter = "host";
  CHECK_EQ(refused(host_filter).message, std::string("value is required for the host filter."));
  host_filter.value = "web-1";
  CHECK(service.context(context, trace_host(), host_filter));
  CHECK(db.sqls.back().find("mapContains(ResourceAttributes, 'host.name') AND ResourceAttributes['host.name'] = 'web-1'") != std::string::npos);
  ContextRequest pod = request;
  pod.filter = "pod";
  pod.value = "pod-9";
  CHECK(service.context(context, trace_host(), pod));
  CHECK(db.sqls.back().find("ResourceAttributes['k8s.pod.name'] = 'pod-9'") != std::string::npos);
  ContextRequest attribute = request;
  attribute.filter = "attribute";
  attribute.attr_scope = "elsewhere";
  CHECK_EQ(refused(attribute).message, std::string("attr_scope must be span or resource."));
  attribute.attr_scope = "span";
  CHECK_EQ(refused(attribute).message, std::string("attr_key must be 1 to 256 bytes."));
  attribute.attr_key = "server.address";
  attribute.attr_value = std::string(4097, 'v');
  CHECK_EQ(refused(attribute).message, std::string("The attribute value is too long."));
  attribute.attr_value = "frontend";
  CHECK(service.context(context, trace_host(), attribute));
  CHECK(db.sqls.back().find("SpanAttributes['server.address'] = 'frontend'") != std::string::npos);
  ContextRequest bogus = request;
  bogus.filter = "bogus";
  CHECK_EQ(refused(bogus).message, std::string("filter must be any, service, host, pod or attribute."));
  // traces.features disables the attribute scope: its own code. Columns that are not Maps: another code.
  HostSpec off = trace_host();
  off.otel.traces.features.span_attributes = false;
  CHECK_EQ(refused(attribute, off).code, std::string("context_filter_disabled"));
  FakeDb plain;
  TestCaches plain_cache;
  TraceService plain_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(plain)); }, plain_cache.refs());
  plain.on("name IN ('SpanAttributes','ResourceAttributes')", {{"SpanAttributes", "String"}, {"ResourceAttributes", "String"}});
  CHECK_EQ(plain_service.context(context, trace_host(), attribute).error.code, std::string("context_filter_unavailable"));
}

void test_the_requests_of_the_detail_routes() {
  ApiError error;
  TraceDetailRequest detail;
  CHECK(!parse_trace_detail(request({}), &detail, &error));
  CHECK_EQ(error.code, std::string("missing_trace_id"));
  CHECK(!parse_trace_detail(request({{"trace_id", std::string(257, 'a').c_str()}}), &detail, &error));
  CHECK_EQ(error.code, std::string("invalid_trace_id"));
  CHECK(parse_trace_detail(request({{"trace_id", "abc"}}), &detail, &error));
  SpanRequest span;
  CHECK(!parse_span(request({{"trace_id", "t"}, {"span_id", "s"}}), &span, &error));
  CHECK_EQ(error.code, std::string("missing_span_key"));
  CHECK(!parse_span(request({{"trace_id", "t"}, {"span_id", "s"}, {"timestamp_ns", "-5"}}), &span, &error));
  CHECK_EQ(error.code, std::string("invalid_span_key"));
  CHECK(parse_span(request({{"trace_id", "t"}, {"span_id", "s"}, {"timestamp_ns", "12345"}}), &span, &error));
  CHECK_EQ(span.timestamp_ns, int64_t(12345));
  LinkedFromRequest linked;
  CHECK(!parse_linked_from(request({}), &linked, &error));
  CHECK_EQ(error.code, std::string("missing_trace_id"));
  CHECK(!parse_linked_from(request({{"trace_id", "t"}, {"span_id", std::string(257, 's').c_str()}}), &linked, &error));
  CHECK_EQ(error.code, std::string("invalid_span_id"));
  CHECK(!parse_linked_from(request({{"trace_id", "t"}, {"start_ms", "5"}}), &linked, &error));
  CHECK_EQ(error.message, std::string("start_ms and end_ms must be provided together."));
  CHECK(parse_linked_from(request({{"trace_id", "t"}, {"start_ms", "5"}, {"end_ms", "9"}}), &linked, &error));
  CHECK(linked.has_range);
  CHECK(parse_linked_from(request({{"trace_id", "t"}}), &linked, &error));
  CHECK(!linked.has_range);
  ContextRequest context;
  CHECK(!parse_context(request({}), &context, &error));
  CHECK_EQ(error.code, std::string("missing_timestamp"));
  CHECK(parse_context(request({{"timestamp_ns", "1789210797865030093"}}), &context, &error));
  CHECK_EQ(context.window_ms, int64_t(60000));
  CHECK_EQ(context.filter, std::string("any"));
  CHECK_EQ(context.direction, std::string("around"));
  CHECK_EQ(context.limit, 50);
  // A window that is not one of the four is refused. A window that is present and empty is refused too. A text that is not a number keeps the default.
  CHECK(!parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"window_ms", "5"}}), &context, &error));
  CHECK_EQ(error.code, std::string("invalid_context_window"));
  CHECK(!parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"window_ms", ""}}), &context, &error));
  CHECK(parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"window_ms", "abc"}}), &context, &error));
  CHECK_EQ(context.window_ms, int64_t(60000));
  CHECK(parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"window_ms", "1000"}, {"limit", "9999"}}), &context, &error));
  CHECK_EQ(context.limit, 200);
  CHECK(!parse_context(request({{"timestamp_ns", "5"}}), &context, &error));
  CHECK_EQ(error.code, std::string("invalid_timestamp"));
  CHECK(!parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"direction", "sideways"}}), &context, &error));
  CHECK_EQ(error.code, std::string("invalid_direction"));
  CHECK(!parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"direction", "older"}}), &context, &error));
  CHECK_EQ(error.code, std::string("missing_cursor"));
  CHECK(parse_context(request({{"timestamp_ns", "1789210797865030093"}, {"direction", "newer"}, {"cursor_ns", "7"}, {"cursor_span_id", "s"}}), &context, &error));
  CHECK_EQ(context.cursor_ns, int64_t(7));
  CHECK_EQ(context.cursor_span, std::string("s"));
}

// ---- the span search ----

void test_the_span_search_statements_are_unchanged() {
  const std::string table = "`otel`.`otel_traces`";
  SpanSearchSql q;
  q.select = std::string("SELECT ") + kSpanSearchColumns + " FROM " + table;
  q.visibility = "1";
  const int64_t end_ns = kAEnd * kNsPerMs;
  CHECK_EQ(span_slice_sql(q, 1789209900000000001LL, end_ns, "", 100), std::string(golden::kSpansPlain));
  SpanSearchSql service = q;
  service.column_filters = span_column_filters_sql(" AND ServiceName = 'api-gateway'", {}, 0, 0);
  CHECK_EQ(span_slice_sql(service, 1789209900000000001LL, end_ns, "", 30), std::string(golden::kSpansService));
  SpanSearchSql kinds = q;
  kinds.column_filters = span_column_filters_sql("", {"Client", "Server"}, 0, 0);
  CHECK_EQ(span_slice_sql(kinds, 1789209900000000001LL, end_ns, "", 20), std::string(golden::kSpansKinds));
  SpanSearchSql durations = q;
  durations.column_filters = span_column_filters_sql("", {}, 100, 900);
  CHECK_EQ(span_slice_sql(durations, 1789209900000000001LL, end_ns, "", 20), std::string(golden::kSpansDurations));
  SpanSearchSql tagged = q;
  tagged.tag_sql = kTagFilter;
  CHECK_EQ(span_slice_sql(tagged, 1789209900000000001LL, end_ns, "", 20), std::string(golden::kSpansTag));
  SpanSearchSql errors = q;
  errors.column_filters = span_column_filters_sql(" AND StatusCode = 'Error'", {}, 0, 0);
  CHECK_EQ(span_slice_sql(errors, 1789209900000000001LL, end_ns, "", 40), std::string(golden::kSpansError));
  // The attribute columns follow the eleven columns of a span.
  SpanSearchSql columns = q;
  AttributeColumns maps;
  maps.span_map = maps.resource_map = true;
  std::string columns_sql, code, message;
  CHECK(span_columns_sql({SpanAttributeColumn{"span", "server.address"}, SpanAttributeColumn{"resource", "host.name"}}, maps, &columns_sql, &code, &message));
  columns.select = std::string("SELECT ") + kSpanSearchColumns + columns_sql + " FROM " + table;
  CHECK_EQ(span_slice_sql(columns, 1789209900000000001LL, end_ns, "", 5), std::string(golden::kSpansColumns));
  // After a row key: the keyset. The copies of a key that a page seam splits are also kept.
  const std::string keyset = span_keyset_sql(1789210000000000000LL, "span", "trace");
  CHECK_EQ(keyset, std::string(" AND (Timestamp < fromUnixTimestamp64Nano(1789210000000000000) OR (Timestamp = fromUnixTimestamp64Nano(1789210000000000000) "
                                "AND (SpanId < 'span' OR (SpanId = 'span' AND TraceId < 'trace'))))"));
  CHECK(span_slice_sql(q, 1, 2, keyset, 1).find(" WHERE 1 AND (Timestamp < ") != std::string::npos);
  CHECK(span_ties_sql(q, 5, "s", "t").find(" PREWHERE Timestamp = fromUnixTimestamp64Nano(5) AND 1 WHERE SpanId = 's' AND TraceId = 't' SETTINGS max_execution_time = 20") != std::string::npos);
}

void test_the_span_cursor() {
  SpanCursor cursor;
  cursor.ts_ns = 1789210000000000123LL;
  cursor.slice_ns = 900000000000LL;
  cursor.after_key = true;
  cursor.span_id = "ab\x01" "c";
  cursor.trace_id = "trace";
  const std::string text = encode_span_cursor(cursor);
  CHECK_EQ(text, std::string("1.1789210000000000123.900000000000.k.616201") + "63.7472616365");
  SpanCursor back;
  CHECK(decode_span_cursor(text, &back));
  CHECK(back.present && back.after_key);
  CHECK_EQ(back.ts_ns, cursor.ts_ns);
  CHECK_EQ(back.slice_ns, cursor.slice_ns);
  CHECK_EQ(back.span_id, cursor.span_id);
  CHECK_EQ(back.trace_id, std::string("trace"));
  cursor.after_key = false;
  CHECK(encode_span_cursor(cursor).find(".b.") != std::string::npos);
  // What is not a cursor of this version.
  SpanCursor bad;
  CHECK(!decode_span_cursor("zzz", &bad));
  CHECK(!decode_span_cursor("2.1.1.k.00.00", &bad));
  CHECK(!decode_span_cursor("1.1.1.x.00.00", &bad));
  CHECK(!decode_span_cursor("1.1x.1.k.00.00", &bad));
  CHECK(!decode_span_cursor("1.1.1.k.0.00", &bad));
  CHECK(!decode_span_cursor("1.1.1.k.zz.00", &bad));
  CHECK(!decode_span_cursor("1.-1.1.k.00.00", &bad));
  CHECK(!decode_span_cursor(std::string(3000, '1'), &bad));
  CHECK_EQ(hex_text(std::string("\xff\x00", 2)), std::string("ff00"));
  std::string raw;
  CHECK(unhex_text("FF00", &raw) && raw.size() == 2);
  // The widths of the slices: 15 minutes, 1 h, 6 h, 24 h, and 24 h again.
  CHECK_EQ(next_span_slice_ns(15 * kNsPerMinute), int64_t(60 * kNsPerMinute));
  CHECK_EQ(next_span_slice_ns(kNsPerMinute), int64_t(15 * kNsPerMinute));
  CHECK_EQ(next_span_slice_ns(1440 * kNsPerMinute), int64_t(1440 * kNsPerMinute));
  // A slice that fails on its read bound or its time is a guard stop. Any other failure is not a guard stop.
  CHECK(slice_guard_error(server_error(158, "Too many rows")));
  CHECK(slice_guard_error(server_error(159, "Timeout exceeded")));
  CHECK(!slice_guard_error(server_error(60, "Unknown table")));
}

SpanSearchPlan search_plan(int limit = 3) {
  SpanSearchPlan plan;
  plan.sql.select = std::string("SELECT ") + kSpanSearchColumns + " FROM `otel`.`otel_traces`";
  plan.sql.visibility = "1";
  plan.start_ns = kAStart * kNsPerMs;
  plan.end_ns = kAEnd * kNsPerMs;
  plan.limit = limit;
  return plan;
}

Row span_search_row(const std::string& id, int64_t ts_ns, const std::string& trace = "t") {
  return {"2026-09-12 10:00:00.000000000", std::to_string(ts_ns), trace, id, "", "api", "GET /", "Server", "1000", "Ok", ""};
}

void test_a_dense_range_answers_from_its_first_slice() {
  FakeDb db;
  const int64_t end_ns = kAEnd * kNsPerMs;
  // limit 3: the slice has 4 rows (need + 1). The page ends after the third row, and the cursor is that row.
  db.on("LIMIT 4", {span_search_row("d", end_ns - 10), span_search_row("c", end_ns - 20), span_search_row("b", end_ns - 30), span_search_row("a", end_ns - 40)});
  const SpanSearchOutcome out = run_span_search(db, search_plan(3));
  CHECK_EQ(out.rows.size(), size_t(3));
  CHECK(!out.exhausted && !out.incomplete);
  CHECK(out.next.present && out.next.after_key);
  CHECK_EQ(out.next.span_id, std::string("b"));
  CHECK_EQ(out.next.ts_ns, end_ns - 30);
  // The next page starts with a slice of about 4x the time that this page covered. The slice is never below a minute and never wider than this slice.
  CHECK_EQ(out.next.slice_ns, kNsPerMinute);
  CHECK_EQ(out.slices.size(), size_t(1));
  CHECK_EQ(out.slices[0].hi_ns, end_ns);
  CHECK_EQ(out.slices[0].lo_ns, end_ns - 15 * kNsPerMinute + 1);
  CHECK_EQ(db.sqls.size(), size_t(1));
  // The next page starts after that row, with the width that it asked for.
  SpanSearchPlan next = search_plan(3);
  next.cursor = out.next;
  FakeDb second;
  second.on("LIMIT 4", {});
  const SpanSearchOutcome page2 = run_span_search(second, next);
  CHECK(second.sqls[0].find(span_keyset_sql(out.next.ts_ns, "b", "t")) != std::string::npos);
  CHECK(second.sqls[0].find("fromUnixTimestamp64Nano(" + std::to_string(out.next.ts_ns - kNsPerMinute + 1) + ")") != std::string::npos);
  CHECK(page2.rows.empty());
}

void test_copies_of_the_boundary_key_stay_on_one_page() {
  FakeDb db;
  const int64_t end_ns = kAEnd * kNsPerMs;
  // The third and the fourth row are the same span, exported twice. The page takes both rows, so the strict keyset after it skips none.
  db.on("LIMIT 4", {span_search_row("d", end_ns - 10), span_search_row("c", end_ns - 20), span_search_row("b", end_ns - 30), span_search_row("b", end_ns - 30)});
  db.on("PREWHERE Timestamp = ", {span_search_row("b", end_ns - 30), span_search_row("b", end_ns - 30), span_search_row("b", end_ns - 30)});
  const SpanSearchOutcome out = run_span_search(db, search_plan(3));
  // d, c and the three copies of b that the ties statement returns.
  CHECK_EQ(out.rows.size(), size_t(5));
  CHECK_EQ(db.sqls.size(), size_t(2));
  CHECK(db.sqls[1].find("WHERE SpanId = 'b' AND TraceId = 't'") != std::string::npos);
  CHECK_EQ(out.next.span_id, std::string("b"));
}

void test_a_sparse_range_widens_the_slice() {
  FakeDb db;
  const int64_t end_ns = kAEnd * kNsPerMs;
  // Nothing is in the first 15 minutes, and one span is in the next hour. The range ends, so the page is the whole range.
  db.on("LIMIT 4", {}, 1);
  db.on("LIMIT 4", {span_search_row("a", end_ns - 40 * kNsPerMinute)}, 1);
  const SpanSearchOutcome out = run_span_search(db, search_plan(3));
  CHECK_EQ(out.rows.size(), size_t(1));
  CHECK(out.exhausted && !out.incomplete);
  CHECK_EQ(out.slices.size(), size_t(2));
  CHECK_EQ(out.slices[0].lo_ns, end_ns - 15 * kNsPerMinute + 1);
  // The second slice starts right under the first. It is 4x as wide and ends at the start of the range.
  CHECK_EQ(out.slices[1].hi_ns, end_ns - 15 * kNsPerMinute);
  CHECK_EQ(out.slices[1].lo_ns, kAStart * kNsPerMs);
}

void test_a_spent_budget_gives_a_resume_point() {
  FakeDb db;
  SpanSearchPlan plan = search_plan(3);
  plan.budget_ms = 0;
  db.on("LIMIT 4", {});
  const SpanSearchOutcome out = run_span_search(db, plan);
  CHECK(out.incomplete && !out.exhausted);
  CHECK_EQ(out.stop_reason, std::string("time_budget"));
  CHECK(out.next.present && !out.next.after_key);
  // Strictly before the slice that the code read, and the width that the next page starts with.
  CHECK_EQ(out.next.ts_ns, plan.end_ns - 15 * kNsPerMinute);
  CHECK_EQ(out.next.slice_ns, 15 * kNsPerMinute);
  CHECK_EQ(db.sqls.size(), size_t(1));
}

void test_a_slice_that_fails_a_guard_is_retried_narrower_then_a_resume_point() {
  const int64_t end_ns = kAEnd * kNsPerMs;
  // The first slice of the page is too heavy. The code reads it again, narrower (an eighth of its width).
  FakeDb db;
  db.fail_on("LIMIT 4", [] { throw server_error(159, "Timeout exceeded"); }, 1);
  db.on("LIMIT 4", {span_search_row("a", end_ns - 10)});
  const SpanSearchOutcome retried = run_span_search(db, search_plan(3));
  CHECK(retried.rows.size() >= 1);
  CHECK(db.sqls.size() >= 2);
  CHECK(db.sqls[1].find("Timestamp >= fromUnixTimestamp64Nano(" + std::to_string(end_ns - 15 * kNsPerMinute / 8 + 1) + ")") != std::string::npos);
  // Heavy again: the page cannot be answered.
  FakeDb heavy;
  heavy.fail_on("LIMIT 4", [] { throw server_error(158, "Too many rows to read"); });
  bool thrown = false;
  try {
    run_span_search(heavy, search_plan(3));
  } catch (const clickhouse::ServerException&) {
    thrown = true;
  }
  CHECK(thrown);
  CHECK_EQ(heavy.sqls.size(), size_t(2));
  // A guard after answered slices is a resume point with a narrower slice. The answer states which guard stopped the read.
  FakeDb later;
  later.on("LIMIT 4", {}, 1);
  later.fail_on("LIMIT 4", [] { throw server_error(158, "Too many rows to read"); });
  const SpanSearchOutcome stopped = run_span_search(later, search_plan(3));
  CHECK(stopped.incomplete);
  CHECK_EQ(stopped.stop_reason, std::string("read_rows_limit"));
  CHECK_EQ(stopped.next.ts_ns, end_ns - 15 * kNsPerMinute);
  CHECK_EQ(stopped.next.slice_ns, std::max(kSpanMinSliceNs, 60 * kNsPerMinute / 4));
  FakeDb timed;
  timed.on("LIMIT 4", {}, 1);
  timed.fail_on("LIMIT 4", [] { throw server_error(159, "Timeout exceeded"); });
  CHECK_EQ(run_span_search(timed, search_plan(3)).stop_reason, std::string("slice_timeout"));
  // Any other failure is the failure of the search.
  FakeDb broken;
  broken.fail_on("LIMIT 4", [] { throw server_error(60, "Unknown table"); });
  bool failed = false;
  try {
    run_span_search(broken, search_plan(3));
  } catch (const clickhouse::ServerException&) {
    failed = true;
  }
  CHECK(failed);
  CHECK_EQ(broken.sqls.size(), size_t(1));
}

void test_the_span_search_service_and_its_request() {
  FakeDb db;
  TestCaches cache;
  TraceService service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, cache.refs());
  db.on("name IN ('SpanAttributes','ResourceAttributes')", {{"SpanAttributes", "Map(String, String)"}, {"ResourceAttributes", "Map(String, String)"}});
  const int64_t end_ns = kAEnd * kNsPerMs;
  Row row = span_search_row("a", end_ns - 10);
  row.push_back("1");
  row.push_back("frontend");
  row.push_back("0");
  row.push_back("");
  db.on("LIMIT 3", {row});
  RequestContext context;
  httplib::Request req = request({{"start_ms", std::to_string(kAStart).c_str()}, {"end_ms", std::to_string(kAEnd).c_str()}, {"limit", "2"},
                                  {"columns", "span:server.address,resource:host.name"}, {"service", "api"}, {"min_duration_ms", "1.5"}});
  SpansRequest parsed;
  ApiError error;
  CHECK(parse_spans(req, trace_host().otel.traces, &parsed, &error));
  CHECK_EQ(parsed.limit, 2);
  CHECK_EQ(parsed.columns.size(), size_t(2));
  CHECK_EQ(parsed.budget_ms, kSpanPageBudgetMs);
  parsed.source_host_id = "local";
  const auto answer = service.spans(context, trace_host(), parsed);
  CHECK(answer);
  // The service filter and the duration go to PREWHERE with the allowlist. The two attribute columns follow the eleven columns.
  const std::string& sql = db.sqls.back();
  CHECK(sql.find("PREWHERE Timestamp >= ") != std::string::npos);
  CHECK(sql.find(" AND 1 AND ServiceName = 'api' AND Duration >= 1500000 WHERE 1 ORDER BY") != std::string::npos);
  CHECK(sql.find("toString(toUInt8(mapContains(SpanAttributes, 'server.address')))") != std::string::npos);
  rapidjson::Document doc;
  doc.Parse(spans_json(*answer.value).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["rows"].Size(), rapidjson::SizeType(1));
  CHECK_EQ(std::string(doc["rows"][0]["attributes"][0].GetString()), std::string("frontend"));
  CHECK(doc["rows"][0]["attributes"][1].IsNull());
  CHECK_EQ(doc["attribute_columns"].Size(), rapidjson::SizeType(2));
  CHECK_EQ(doc["has_more"].GetBool(), false);
  CHECK(doc["cursor"].IsNull());
  CHECK_EQ(doc["incomplete"].GetBool(), false);
  CHECK_EQ(std::string(doc["searched_to_ns"].GetString()), std::to_string(kAStart * kNsPerMs));
  CHECK_EQ(std::string(doc["rows"][0]["start_ns"].GetString()), std::to_string(end_ns - 10));
  // A filter on an attribute of a source whose maps are not usable is refused before the scan.
  FakeDb plain;
  TestCaches plain_cache;
  TraceService plain_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(plain)); }, plain_cache.refs());
  plain.on("name IN ('SpanAttributes','ResourceAttributes')", {{"SpanAttributes", "String"}, {"ResourceAttributes", "String"}});
  SpansRequest tagged = parsed;
  tagged.filters.tags.push_back(TagFilter{"span", TagOp::Eq, "k", "v"});
  CHECK_EQ(plain_service.spans(context, trace_host(), tagged).error.code, std::string("trace_tag_search_unsupported"));
  CHECK_EQ(plain.count("LIMIT 3"), size_t(0));
  // A failure of the scan gives the code of the route. The connection is not returned to the pool.
  FakeDb failing;
  TraceService failing_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(failing)); }, cache.refs());
  failing.fail_on("LIMIT 3", [] { throw server_error(60, "Unknown table"); });
  SpansRequest plain_request = parsed;
  plain_request.columns.clear();
  const auto broken = failing_service.spans(context, trace_host(), plain_request);
  CHECK_EQ(broken.error.code, std::string("trace_spans_failed"));
  CHECK_EQ(failing.invalidated, 1);
  // A restricted allowlist hides the parent of a span.
  HostSpec restricted = trace_host();
  restricted.otel.traces.service_allowlist = {"api"};
  Row with_parent = span_search_row("a", end_ns - 10);
  with_parent[4] = "parent";
  FakeDb hidden;
  TraceService hidden_service([&](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(hidden)); }, cache.refs());
  hidden.on("LIMIT 3", {with_parent});
  const auto hide = hidden_service.spans(context, restricted, plain_request);
  rapidjson::Document hd;
  hd.Parse(spans_json(*hide.value).c_str());
  CHECK_EQ(std::string(hd["rows"][0]["parent_span_id"].GetString()), std::string());
}

void test_the_span_search_request() {
  TraceSettings traces = settings();
  SpansRequest parsed;
  ApiError error;
  CHECK(parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}}), traces, &parsed, &error));
  CHECK_EQ(parsed.limit, kSpanPageDefaultLimit);
  CHECK(parsed.kinds.empty() && parsed.columns.empty() && !parsed.cursor.present);
  CHECK(parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"limit", "99999"}, {"budget_ms", "99999"}}), traces, &parsed, &error));
  CHECK_EQ(parsed.limit, kSpanPageMaxLimit);
  CHECK_EQ(parsed.budget_ms, kSpanPageBudgetMs);  // the budget may only be lowered
  CHECK(parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"budget_ms", "300"}}), traces, &parsed, &error));
  CHECK_EQ(parsed.budget_ms, 300.0);
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"min_duration_ms", "9"}, {"max_duration_ms", "3"}}), traces, &parsed, &error));
  CHECK_EQ(error.code, std::string("invalid_trace_duration"));
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"kind", std::string(65, 'k').c_str()}}), traces, &parsed, &error));
  CHECK_EQ(error.message, std::string("kind values are limited to 64 bytes."));
  httplib::Request many;
  many.params.emplace("start_ms", "1000");
  many.params.emplace("end_ms", "9000");
  for (int i = 0; i < 17; ++i) many.params.emplace("kind", "k" + std::to_string(i));
  CHECK(!parse_spans(many, traces, &parsed, &error));
  CHECK_EQ(error.message, std::string("At most 16 span kinds are accepted."));
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"columns", ","}, {"columns", "span:"}}), traces, &parsed, &error));
  CHECK_EQ(error.code, std::string("invalid_trace_columns"));
  // A cursor of this range. A cursor that is past its end, or that is not a cursor, is refused.
  SpanCursor cursor;
  cursor.ts_ns = 5000 * kNsPerMs;
  cursor.slice_ns = kNsPerMinute;
  cursor.after_key = true;
  cursor.span_id = "s";
  cursor.trace_id = "t";
  const std::string text = encode_span_cursor(cursor);
  CHECK(parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"cursor", text.c_str()}}), traces, &parsed, &error));
  CHECK(parsed.cursor.present);
  CHECK_EQ(parsed.cursor.span_id, std::string("s"));
  cursor.ts_ns = 9001 * kNsPerMs;
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"cursor", encode_span_cursor(cursor).c_str()}}), traces, &parsed, &error));
  CHECK_EQ(error.code, std::string("invalid_cursor"));
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"cursor", "zzz"}}), traces, &parsed, &error));
  TraceSettings no_status = traces;
  no_status.features.status_filter = false;
  CHECK(!parse_spans(request({{"start_ms", "1000"}, {"end_ms", "9000"}, {"status", "Error"}}), no_status, &parsed, &error));
  CHECK_EQ(error.code, std::string("trace_filter_disabled"));
}


// ---- the budget of a route, the traces that a partial search keeps ----

void test_the_budget_of_a_route_narrows_the_bounds_of_the_request() {
  using clock = std::chrono::steady_clock;
  RequestContext context;
  context.limits.deadline = clock::now() + std::chrono::seconds(60);
  context.limits.max_rows_to_read = 20'000'000'000ULL;
  context.limits.read_overflow_mode = "throw";
  {
    BudgetScope scope(context, RouteBudget{45 * 1000, 2'000'000'000ULL});
    const ChQueryLimits* limits = ChQueryScope::current();
    CHECK(limits != nullptr);
    // The route is bounded by its own time and read cap, which are narrower than the ones of the request.
    CHECK(limits->deadline < context.limits.deadline);
    CHECK_EQ(limits->max_rows_to_read, uint64_t(2'000'000'000ULL));
    CHECK(scope.remaining_ms() > 40 * 1000 && scope.remaining_ms() <= 45 * 1000);
  }
  CHECK(ChQueryScope::current() == nullptr);  // the scope of the route ends with it
  // A bound that the request sets narrower stays as it is. The budget never raises a bound.
  context.limits.deadline = clock::now() + std::chrono::seconds(10);
  context.limits.max_rows_to_read = 1000;
  {
    BudgetScope scope(context, RouteBudget{45 * 1000, 2'000'000'000ULL});
    CHECK(ChQueryScope::current()->deadline == context.limits.deadline);
    CHECK_EQ(ChQueryScope::current()->max_rows_to_read, uint64_t(1000));
    CHECK(scope.remaining_ms() <= 10 * 1000);
  }
  // No bound at all (a call of MCP has no deadline): the budget gives one. A budget of 0 leaves the bounds of the request unchanged.
  RequestContext open;
  {
    BudgetScope scope(open, kSearchBudget);
    CHECK(scope.remaining_ms() <= 45 * 1000);
    CHECK(ChQueryScope::current()->deadline != clock::time_point{});
  }
  {
    BudgetScope scope(open, RouteBudget{});
    CHECK_EQ(scope.remaining_ms(), std::numeric_limits<int64_t>::max());
    CHECK_EQ(ChQueryScope::current()->max_rows_to_read, uint64_t(0));
  }
  // A cap of the budget sets how it fails when the cap is reached. The read cap of the page fails the request. It never cuts the answer.
  {
    BudgetScope scope(open, kTraceDetailBudget);
    CHECK_EQ(ChQueryScope::current()->read_overflow_mode, std::string("throw"));
  }
  // The route reaches the statements. A statement after the deadline fails at once with the timeout of ClickHouse.
  RequestContext late;
  late.limits.deadline = clock::now() - std::chrono::seconds(1);
  BudgetScope scope(late, RouteBudget{1000, 0});
  CHECK_EQ(scope.remaining_ms(), int64_t(0));
}

// A search through a filter that few traces match: the code walks the index in pages of `candidate_cap` traces.
Rows hits_of(const std::string& prefix, int count, int64_t first_ns) {
  Rows rows;
  for (int i = 0; i < count; ++i) rows.push_back({prefix + std::to_string(i), std::to_string(first_ns - static_cast<int64_t>(i) * 1000000)});
  return rows;
}

void test_the_scan_cap_keeps_the_traces_found_and_completes_with_the_older_ones() {
  FakeDb db;
  const auto errors = scope_of(kAStart, kAEnd, " AND StatusCode = 'Error'");
  const int64_t newest = kAEnd * kNsPerMs;
  db.on("GROUP BY TraceId LIMIT 20001", hits_of("h", 20000, newest), 1);
  db.on("AS batch_bounds", {{"h3"}, {"h7"}});
  // The span ranking of the completion: three older traces that match.
  db.on("argMinIf(SpanName", summary_rows({"h3", "h7", "c1", "c2", "c3"}));
  db.on("NOT IN {excluded:Array(String)}", {{"c1", "1789208000000000000", "0"}, {"c2", "1789207900000000000", "0"}, {"c3", "1789207800000000000", "0"}});
  const SearchOutcome out = search_traces(db, errors, false, 5, SearchBudget{}, 50);
  CHECK_EQ(out.search_path, std::string("trace_index_then_spans"));
  CHECK_EQ(out.rank_by, std::string("newest_index_row_then_first_span"));
  CHECK_EQ(out.fallback_reason, std::string("index_scan_cap"));
  CHECK(!out.partial);
  CHECK_EQ(out.rows.size(), size_t(5));
  // The code tests 50 traces (one page of the cap). Two of them match, and 3 more are wanted.
  size_t rank_at = 0, summary_at = 0;
  for (size_t i = 0; i < db.sqls.size(); ++i) {
    if (db.sqls[i].find("NOT IN {excluded") != std::string::npos) rank_at = i;
    if (db.sqls[i].find("argMinIf(SpanName") != std::string::npos) summary_at = i;
  }
  CHECK(rank_at > 0 && summary_at > rank_at);
  const std::string& rank = db.sqls[rank_at];
  // The rank step reads the spans at or before the oldest trace that the code tested (the 50th hit). It never reads the traces that were selected.
  // The rank step finds the traces that match with the candidate_ids of a CTE. The broad form misses a trace whose span that matches lies after the bound.
  CHECK(rank.find("Timestamp <= fromUnixTimestamp64Nano(" + std::to_string(newest - 49 * 1000000)) != std::string::npos);
  CHECK(rank.find("WITH candidate_ids AS (") == 0);
  CHECK(rank.find("HAVING countIf") == std::string::npos);
  CHECK(rank.find("LIMIT 3") != std::string::npos);
  CHECK_EQ(db.params[rank_at].size(), size_t(1));
  CHECK_EQ(db.params[rank_at][0].first, std::string("excluded"));
  CHECK_EQ(db.params[rank_at][0].second, std::string("['h3', 'h7']"));
  // The summary is the one of the index. The traces are of two kinds, so the summary has the ids of both.
  CHECK_EQ(db.params[summary_at][0].second, std::string("['h3', 'h7', 'c1', 'c2', 'c3']"));
  // The code keeps nothing when no trace matches. The whole window is ranked by the spans, as before.
  FakeDb none;
  none.on("GROUP BY TraceId LIMIT 20001", hits_of("h", 20000, newest), 1);
  none.on("argMinIf(SpanName", summary_rows({"w1"}));
  none.on("ORDER BY min(Timestamp) DESC LIMIT 5", {{"w1", "1789210000000000000", "0"}});
  const SearchOutcome whole = search_traces(none, errors, false, 5, SearchBudget{}, 50);
  CHECK_EQ(whole.search_path, std::string("span_aggregation"));
  CHECK_EQ(whole.rank_by, std::string("first_span"));
  CHECK_EQ(whole.fallback_reason, std::string("index_scan_cap"));
  CHECK_EQ(whole.rows.size(), size_t(1));
  CHECK_EQ(none.count("NOT IN {excluded"), size_t(0));
}

void test_a_search_that_runs_out_of_time_answers_with_what_it_found() {
  FakeDb db;
  const auto service = scope_of(kAStart, kAEnd, kServiceFilter);
  db.on("GROUP BY TraceId LIMIT 20001", hits_of("h", 20000, kAEnd * kNsPerMs), 1);
  db.on("AS batch_bounds", {{"h1"}});
  db.on("AS trace_bounds", summary_rows({"h1"}));
  // The time of the route is enough for the first page of the index. Then the time is short, and it is less than the reserve of the summary.
  int calls = 0;
  SearchBudget budget;
  budget.remaining_ms = [&calls] { return ++calls <= 1 ? int64_t(30000) : int64_t(2000); };
  const SearchOutcome out = search_traces(db, service, true, 5, budget);
  CHECK(out.partial);
  CHECK_EQ(out.partial_reason, std::string("time_budget"));
  CHECK_EQ(out.search_path, std::string("trace_index_filtered"));
  CHECK_EQ(out.rank_by, std::string("newest_index_row"));
  CHECK_EQ(out.rows.size(), size_t(1));
  CHECK_EQ(db.count("AS batch_bounds"), size_t(1));  // one page was tested
  // The code summarizes the traces that it found. The budget keeps the time for the summary.
  CHECK_EQ(db.count("AS trace_bounds"), size_t(1));
  // The scan cap has traces to keep, and there is no time for the completion. The traces that the code found are the answer, and the answer is partial.
  FakeDb capped;
  capped.on("GROUP BY TraceId LIMIT 20001", hits_of("h", 20000, kAEnd * kNsPerMs), 1);
  capped.on("AS batch_bounds", {{"h1"}});
  capped.on("AS trace_bounds", summary_rows({"h1"}));
  int polls = 0;
  SearchBudget late;
  late.remaining_ms = [&polls] { return ++polls <= 1 ? int64_t(30000) : int64_t(100); };
  const SearchOutcome kept = search_traces(capped, service, false, 5, late, 50);
  CHECK(kept.partial);
  CHECK_EQ(kept.fallback_reason, std::string("index_scan_cap"));
  CHECK_EQ(kept.search_path, std::string("trace_index_filtered"));
  CHECK_EQ(kept.rank_by, std::string("newest_index_row"));
  CHECK_EQ(capped.count("NOT IN {excluded"), size_t(0));
  CHECK_EQ(kept.rows.size(), size_t(1));
  // The budget is checked before each page. A route with no time left tests nothing and answers an empty partial list.
  FakeDb none;
  none.on("GROUP BY TraceId LIMIT 20001", hits_of("h", 20000, kAEnd * kNsPerMs));
  SearchBudget spent;
  spent.remaining_ms = [] { return int64_t(0); };
  const SearchOutcome empty = search_traces(none, service, true, 5, spent);
  CHECK(empty.partial && empty.rows.empty());
  CHECK_EQ(none.count("AS batch_bounds"), size_t(0));
  // The JSON states that the answer is partial, and why. An answer that is not partial states nothing.
  SearchAnswer answer;
  answer.source_host_id = "local";
  answer.outcome = out;
  rapidjson::Document doc;
  doc.Parse(search_json(answer).c_str());
  CHECK(!doc.HasParseError());
  CHECK_EQ(doc["partial"].GetBool(), true);
  CHECK_EQ(std::string(doc["partial_reason"].GetString()), std::string("time_budget"));
  answer.outcome = SearchOutcome{};
  rapidjson::Document plain;
  plain.Parse(search_json(answer).c_str());
  CHECK(!plain.HasMember("partial") && !plain.HasMember("partial_reason"));
}

void test_the_ranking_of_the_older_part_is_exact_for_a_wide_window() {
  // A window of a day: the code reads the newest 1/16 of the older part first, with the probe of its traces. Then it reads the whole older part.
  FakeDb db;
  const auto wide = scope_of(kCStart, kCEnd, kServiceFilter);
  RankBounds bounds;
  bounds.upper_ns = kCEnd * kNsPerMs - 3600LL * 1000 * kNsPerMs;
  bounds.excluded = {"x1", "x2"};
  db.on("ORDER BY min(Timestamp) DESC LIMIT 18", {{"a", "1789250000000000000", "0"}, {"b", "1789249000000000000", "0"}}, 1);
  db.on("SELECT DISTINCT toString(TraceId)", {{"b"}});
  db.on("ORDER BY min(Timestamp) DESC LIMIT 2", {{"a", "1789250000000000000", "0"}, {"d", "1789240000000000000", "0"}});
  const auto ranked = rank_traces_by_start(db, wide, false, 2, bounds);
  CHECK_EQ(ranked.size(), size_t(2));
  // The slice is the newest 1/16 of the older part, not of the window. Every statement contains the bound and the exclusion.
  const int64_t range = bounds.upper_ns - kCStart * kNsPerMs;
  CHECK(db.sqls[0].find("Timestamp >= fromUnixTimestamp64Nano(" + std::to_string(bounds.upper_ns - range / 16) + ")") != std::string::npos);
  // The first slice, the second (empty, so the window widens), and the whole older part.
  CHECK_EQ(db.sqls.size(), size_t(4));
  for (size_t i : {size_t(0), size_t(2), size_t(3)}) {
    CHECK(db.sqls[i].find("Timestamp <= fromUnixTimestamp64Nano(" + std::to_string(bounds.upper_ns) + ")") != std::string::npos);
    CHECK(db.sqls[i].find("TraceId NOT IN {excluded:Array(String)}") != std::string::npos);
    CHECK_EQ(db.params[i].size(), size_t(1));
  }
  // The probe asks whether a trace has a span before the slice, wherever that span ends. The probe is not bounded above and not excluded.
  CHECK(db.sqls[1].find("Timestamp < fromUnixTimestamp64Nano(") != std::string::npos);
  CHECK(db.sqls[1].find("excluded") == std::string::npos);
  // No bound: the statement is the same as before. The goldens of the search statements are unchanged.
  FakeDb plain;
  plain.on("ORDER BY min(Timestamp) DESC LIMIT 3", {});
  rank_traces_by_start(plain, scope_of(kAStart, kAEnd), false, 3);
  CHECK(plain.sqls[0].find("NOT IN {excluded") == std::string::npos && plain.sqls[0].find("Timestamp <= fromUnixTimestamp64Nano(") == std::string::npos);
  CHECK(plain.params[0].empty());
}

}  // namespace


int main() {
  RUN(test_column_filters);
  RUN(test_tag_filters);
  RUN(test_filter_errors);
  RUN(test_unusable_attribute_maps);
  RUN(test_span_columns);
  RUN(test_number_parameters);
  RUN(test_read_rows_limit);
  RUN(test_time_range);
  RUN(test_disabled_features);
  RUN(test_common_sql);
  RUN(test_buckets_and_grid);
  RUN(test_search_statements_are_unchanged);
  RUN(test_chart_statements_are_unchanged);
  RUN(test_delta_statements_are_unchanged);
  RUN(test_service_map_statements_are_unchanged);
  RUN(test_service_map_sampling);
  RUN(test_index_without_filters_takes_the_newest_traces);
  RUN(test_a_filter_tests_the_traces_of_the_index_in_pages);
  RUN(test_the_scan_cap_gives_way_to_the_span_aggregation);
  RUN(test_an_error_of_the_index_gives_way_to_the_span_aggregation);
  RUN(test_a_caller_that_went_away_stops_the_search);
  RUN(test_a_failure_of_the_span_aggregation_is_the_failure_of_the_search);
  RUN(test_a_duration_bound_ranks_the_spans_and_reads_their_bounds);
  RUN(test_a_filter_that_few_traces_match_keeps_the_narrow_form);
  RUN(test_the_ranking_widens_from_the_newest_slice);
  RUN(test_charts_come_from_the_index_when_nothing_restricts_them);
  RUN(test_the_counts_of_a_finer_quantile_bucket_add_up_in_the_count_bucket);
  RUN(test_a_broken_index_falls_back_on_a_new_connection);
  RUN(test_charts_parameter);
  RUN(test_the_heatmap_bins);
  RUN(test_the_ranking_of_the_deltas);
  RUN(test_the_service_cannot_connect);
  RUN(test_the_attribute_columns_are_read_once_for_the_filters_of_a_source);
  RUN(test_a_table_that_cannot_be_read_is_not_a_table_without_maps);
  RUN(test_a_failure_of_a_statement_is_the_error_of_the_route);
  RUN(test_the_box_of_the_deltas_is_checked);
  RUN(test_the_deltas_compare_two_samples);
  RUN(test_the_service_map_and_its_json);
  RUN(test_the_order_of_a_search_is_named_by_its_path);
  RUN(test_the_json_of_the_search);
  RUN(test_the_json_of_the_charts_and_the_heatmap);
  RUN(test_services_statements_are_unchanged);
  RUN(test_services_window_sampling);
  RUN(test_the_services_are_read_in_one_scan);
  RUN(test_the_services_read_stops_at_its_time_budget_and_keeps_what_it_has);
  RUN(test_a_failed_estimate_reads_the_window_whole_on_a_new_connection);
  RUN(test_the_database_statements);
  RUN(test_the_services_service_builds_the_where_of_the_entry_spans);
  RUN(test_the_services_request);
  RUN(test_prefill_and_facet_statements_are_unchanged);
  RUN(test_the_prefill_reads_what_it_does_not_know);
  RUN(test_the_facet_keys_and_values_are_sorted_and_bounded);
  RUN(test_the_schema_of_the_source);
  RUN(test_the_prefill_and_the_facets_are_cached_by_window_and_filters);
  RUN(test_the_requests_of_the_discovery_routes);
  RUN(test_trace_statements_are_unchanged);
  RUN(test_a_parent_that_the_allowlist_hides_is_never_named);
  RUN(test_the_spans_of_a_trace_hide_the_parents_that_the_allowlist_hides);
  RUN(test_the_detail_of_a_trace_says_what_is_missing);
  RUN(test_one_span_by_its_key);
  RUN(test_the_spans_that_link_to_a_trace);
  RUN(test_the_context_of_a_span);
  RUN(test_the_filters_of_the_context);
  RUN(test_the_requests_of_the_detail_routes);
  RUN(test_the_span_search_statements_are_unchanged);
  RUN(test_the_span_cursor);
  RUN(test_a_dense_range_answers_from_its_first_slice);
  RUN(test_copies_of_the_boundary_key_stay_on_one_page);
  RUN(test_a_sparse_range_widens_the_slice);
  RUN(test_a_spent_budget_gives_a_resume_point);
  RUN(test_a_slice_that_fails_a_guard_is_retried_narrower_then_a_resume_point);
  RUN(test_the_span_search_service_and_its_request);
  RUN(test_the_span_search_request);
  RUN(test_the_budget_of_a_route_narrows_the_bounds_of_the_request);
  RUN(test_the_scan_cap_keeps_the_traces_found_and_completes_with_the_older_ones);
  RUN(test_a_search_that_runs_out_of_time_answers_with_what_it_found);
  RUN(test_the_ranking_of_the_older_part_is_exact_for_a_wide_window);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
