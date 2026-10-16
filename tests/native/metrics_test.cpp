// These unit tests check the parts of the Metrics page below its routes.
// They check the parse of a request (src/metrics_request.cpp), the statements (src/metrics_sql.cpp),
// the aggregation of the rows (src/metrics_aggregate.cpp), and the service with a fake executor and its JSON
// (src/metrics_service.cpp, src/metrics_json.cpp). The tests do not need a ClickHouse server.
//
// The tests compare the statements with the ones that the code before the split of src/api_metrics.cpp sent for the same requests.
// The expected text is in metrics_golden.hpp, with each query parameter written in place.
// A statement that changes its text makes a test fail.
// A change on purpose must change the expected text in the same commit.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_METRICS_TESTS=ON
//        cmake --build build --target chdash_metrics_test
// Run:   ./build/chdash_metrics_test   (exit code 0 = every check passed)

#include "api_error.hpp"
#include "ch_error.hpp"
#include "fake_executor.hpp"
#include "metrics_aggregate.hpp"
#include "metrics_golden.hpp"
#include "metrics_json.hpp"
#include "metrics_request.hpp"
#include "metrics_service.hpp"
#include "metrics_sql.hpp"
#include "native_check.hpp"

#include <httplib.h>
#include <rapidjson/document.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using namespace chdash;
using namespace chdash::metrics;
using namespace nt;

namespace {

using Params = std::initializer_list<std::pair<const char*, const char*>>;

httplib::Request request(Params params) {
  httplib::Request req;
  req.method = "GET";
  for (const auto& [name, value] : params) req.params.emplace(name, value);
  return req;
}

// The window of the battery for the differential check is the newest day of the fixture.
constexpr int64_t kEnd = 1789867360999LL;
constexpr int64_t kHour = 3600000LL;
const std::string kStart2h = std::to_string(kEnd - 2 * kHour), kStart24h = std::to_string(kEnd - 24 * kHour);
const std::string kStart6h = std::to_string(kEnd - 6 * kHour);
const std::string kEndText = std::to_string(kEnd);

// A statement with every {pN:String} written in place as a quoted text. The numbering of the parameters is not part of the text.
std::string inlined(const Statement& statement) {
  std::string out = statement.sql;
  for (const auto& [name, value] : statement.params.list()) {
    std::string quoted = "'";
    for (const char c : value) {
      if (c == '\\' || c == '\'') quoted.push_back('\\');
      quoted.push_back(c);
    }
    quoted += "'";
    const std::string mark = "{" + name + ":String}";
    for (size_t at = out.find(mark); at != std::string::npos; at = out.find(mark, at + quoted.size())) out.replace(at, mark.size(), quoted);
  }
  return out;
}

// The statements of the code before the split, with the changes on purpose of ARCH-B-086.
// The information of a sum has the least of IsMonotonic too. The other kinds have a constant.
// The rows of a histogram come in the order of their bounds.
std::string changed_info(std::string golden, bool sum) {
  const size_t at = golden.find(" FROM `otel`.`otel_metrics_");
  CHECK(at != std::string::npos);
  golden.insert(at, sum ? ", toString(min(toUInt8(IsMonotonic)))" : ", '0'");
  return golden;
}

MetricSettings settings() {
  MetricSettings metrics;
  metrics.enabled = true;
  metrics.database = "otel";
  metrics.table_prefix = "otel_metrics";
  return metrics;
}

AttributesRequest attributes_request(Params params) {
  AttributesRequest out;
  ApiError error;
  const bool ok = parse_attributes(request(params), &out, &error);
  CHECK(ok);
  return out;
}

SeriesRequest series_request(Params params) {
  SeriesRequest out;
  ApiError error;
  const bool ok = parse_series(request(params), &out, &error);
  CHECK(ok);
  return out;
}

ExemplarsRequest exemplars_request(Params params) {
  ExemplarsRequest out;
  ApiError error;
  const bool ok = parse_exemplars(request(params), &out, &error);
  CHECK(ok);
  return out;
}

std::string table_of(const std::string& kind) { return kind_table(settings(), kind); }

// ---- the parse of a request ----

void test_the_window_of_the_routes() {
  ApiError error;
  CatalogRequest catalog;
  // The catalog takes the last day when the request names no window.
  CHECK(parse_catalog(request({}), 1789867360999LL, &catalog, &error));
  CHECK_EQ(catalog.window.end_ms, int64_t(1789867360999LL));
  CHECK_EQ(catalog.window.start_ms, int64_t(1789867360999LL - 24 * kHour));
  CHECK(!catalog.refresh);
  CHECK(parse_catalog(request({{"refresh", "1"}}), 5, &catalog, &error) && catalog.refresh);
  CHECK(parse_catalog(request({{"refresh", "true"}}), 5, &catalog, &error) && catalog.refresh);
  CHECK(parse_catalog(request({{"refresh", "0"}}), 5, &catalog, &error) && !catalog.refresh);
  // The catalog checks a window that the request names. It says invalid_metrics_range. The other routes say invalid_metrics_request.
  CHECK(!parse_catalog(request({{"start_ms", "9"}, {"end_ms", "3"}}), 5, &catalog, &error));
  CHECK_EQ(error.status, 400);
  CHECK_EQ(error.code, std::string("invalid_metrics_range"));
  CHECK_EQ(error.message, std::string("Invalid metrics time range."));
  CHECK(!parse_catalog(request({{"start_ms", "9"}}), 5, &catalog, &error));
  CHECK_EQ(error.message, std::string("start_ms and end_ms (milliseconds) are required."));
  CHECK(!parse_catalog(request({{"start_ms", "1000"}, {"end_ms", std::to_string(1000 + 91 * 24 * kHour).c_str()}}), 5, &catalog, &error));
  CHECK_EQ(error.message, std::string("Metrics time range exceeds 90 days."));
  CHECK(!parse_catalog(request({{"start_ms", "1"}, {"end_ms", "9223372036854775"}}), 5, &catalog, &error));
  CHECK_EQ(error.message, std::string("Invalid metrics time range."));
  // A number is the whole text of the value.
  CHECK(!parse_catalog(request({{"start_ms", "1x"}, {"end_ms", "9"}}), 5, &catalog, &error));
  SeriesRequest series;
  CHECK(!parse_series(request({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}}), &series, &error));
  CHECK_EQ(error.code, std::string("invalid_metrics_request"));
  CHECK_EQ(error.message, std::string("start_ms and end_ms (milliseconds) are required."));
}

void test_the_fields_of_a_request() {
  ApiError error;
  SeriesRequest series;
  const auto fails = [&](Params params, const std::string& message) {
    const bool ok = parse_series(request(params), &series, &error);
    CHECK(!ok);
    CHECK_EQ(error.status, 400);
    CHECK_EQ(error.code, std::string("invalid_metrics_request"));
    CHECK_EQ(error.message, message);
  };
  fails({{"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}}, "kind is required.");
  fails({{"kind", "bogus"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}},
        "kind must be gauge, sum, histogram, exponential_histogram or summary.");
  fails({{"kind", "gauge"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}}, "service is required.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"start_ms", "1"}, {"end_ms", "9"}}, "metric is required.");
  const std::string long_name(1025, 'x');
  fails({{"kind", "gauge"}, {"service", long_name.c_str()}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}}, "service is too long.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"filter", "nokey"}}, "filter must be key=value.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"filter_not", "=v"}}, "filter_not must be key=value.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"limit", "0"}}, "limit must be between 1 and 50.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"limit", "51"}}, "limit must be between 1 and 50.");
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"group_by", "a,b,c,d,e,f"}},
        "group_by accepts at most 5 attribute keys.");
  const std::string long_key(257, 'k');
  fails({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"group_by", long_key.c_str()}},
        "group_by key is too long.");
  // At most 32 attribute filters.
  httplib::Request many = request({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}});
  for (int i = 0; i < 33; ++i) many.params.emplace("filter", "k" + std::to_string(i) + "=v");
  CHECK(!parse_series(many, &series, &error));
  CHECK_EQ(error.message, std::string("Too many attribute filters (max 32)."));

  // The filters keep their operator. The group_by keys are unique and in order. An empty key and an empty filter are dropped.
  const auto ok = series_request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                                  {"filter", "x=1"}, {"filter", ""}, {"filter_not", "y=a=b"}, {"group_by", "b,,a,b"}, {"limit", "7"}, {"agg", "rate"}});
  CHECK_EQ(ok.filters.size(), size_t(2));
  CHECK_EQ(ok.filters[0].key, std::string("x"));
  CHECK_EQ(ok.filters[0].op, std::string("="));
  CHECK_EQ(ok.filters[1].key, std::string("y"));
  CHECK_EQ(ok.filters[1].op, std::string("!="));
  CHECK_EQ(ok.filters[1].value, std::string("a=b"));
  CHECK_EQ(ok.group_by.size(), size_t(2));
  CHECK_EQ(ok.group_by[0], std::string("b"));
  CHECK_EQ(ok.group_by[1], std::string("a"));
  CHECK_EQ(ok.top_k, 7);
  CHECK_EQ(ok.agg, std::string("rate"));

  ExemplarsRequest exemplars;
  CHECK(!parse_exemplars(request({{"kind", "summary"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}}), &exemplars, &error));
  CHECK_EQ(error.message, std::string("Summaries have no exemplars."));
  CHECK(!parse_exemplars(request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"per_bucket", "21"}}), &exemplars, &error));
  CHECK_EQ(error.message, std::string("per_bucket must be between 1 and 20."));
  CHECK(!parse_exemplars(request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"limit", "2001"}}), &exemplars, &error));
  CHECK_EQ(error.message, std::string("limit must be between 1 and 2000."));
  // A value that is not a number is the default.
  const auto defaults = exemplars_request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"limit", "x"}});
  CHECK_EQ(defaults.limit, int64_t(500));
  CHECK_EQ(defaults.per_bucket, int64_t(3));
  // The parser reads the key of the attribute route and does not check it. The service checks its length after the table.
  const auto attributes = attributes_request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}, {"key", "k"}});
  CHECK_EQ(attributes.key, std::string("k"));
}

void test_the_bucket_grid() {
  // About 120 buckets or fewer, on the steps of 10 s to 7 days.
  const auto grid_of = [](Params params) { return series_request(params).grid; };
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}}).size_ms, int64_t(60000));
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", kStart24h.c_str()}, {"end_ms", kEndText.c_str()}}).size_ms, int64_t(900000));
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "11000"}}).size_ms, int64_t(10000));
  // step_ms asks for a size within [range / 1000, range]. The code takes the origin modulo the size, also when the origin is negative.
  const auto step = grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                             {"step_ms", "90000"}, {"bucket_origin_ms", "1234567"}});
  CHECK_EQ(step.size_ms, int64_t(90000));
  CHECK_EQ(step.origin_ms, int64_t(1234567 % 90000));
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "901000"}, {"step_ms", "1"}}).size_ms, int64_t(1000));
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"step_ms", "999999999999"}}).size_ms, 2 * kHour - 0 + 1 - 1 + 0);
  CHECK_EQ(grid_of({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "9000"}, {"bucket_origin_ms", "-1"}}).origin_ms, int64_t(9999));
  BucketGrid grid;
  grid.size_ms = 60000;
  grid.origin_ms = 34567;
  CHECK_EQ(grid.floor(100000), int64_t(94567));
  CHECK_EQ(grid.floor(100), int64_t(-25433));
  CHECK_EQ(grid.floor(34567), int64_t(34567));
  CHECK_EQ(grid.sql("TimeUnix"), std::string("34567 + intDiv(toUnixTimestamp64Milli(TimeUnix) - 34567, 60000) * 60000"));
  // The bucket starts of a window, and the part of a bucket that the window covers.
  TimeWindow window{100000, 400000};
  const auto timestamps = bucket_timestamps(grid, window);
  CHECK_EQ(timestamps.front(), int64_t(94567));
  CHECK_EQ(timestamps.back(), int64_t(394567));
  CHECK_EQ(covered_seconds(grid, window, 94567, 60.0), 54.567);
  CHECK_EQ(covered_seconds(grid, window, 154567, 60.0), 60.0);
  CHECK_EQ(covered_seconds(grid, window, 394567, 60.0), 5.433);
}

// ---- the statements, against the text that the code before the split sent ----

void test_the_catalog_statements_are_unchanged() {
  CHECK_EQ(existing_kinds_sql(settings()), std::string(golden::kExistingKinds));
  const std::set<std::string> all = {"gauge", "sum", "histogram", "exponential_histogram", "summary"};
  CHECK_EQ(catalog_sql(settings(), all, "1", TimeWindow{kEnd - 24 * kHour, kEnd}), std::string(golden::kCatalogAll));
  // Only the kinds that exist appear, in the order of the kinds. When no kind exists, there is no statement.
  const std::string some = catalog_sql(settings(), {"summary", "gauge"}, "1", TimeWindow{kEnd - 2 * kHour, kEnd});
  CHECK(some.find("otel_metrics_gauge") != std::string::npos && some.find("otel_metrics_summary") != std::string::npos);
  CHECK(some.find("otel_metrics_sum`") == std::string::npos && some.find("histogram") == std::string::npos);
  CHECK(some.find("'gauge' AS kind") < some.find("'summary' AS kind"));
  CHECK_EQ(catalog_sql(settings(), {}, "1", TimeWindow{1, 2}), std::string());
  // Each branch checks the visibility of the allowlist.
  const std::string hidden = catalog_sql(settings(), {"gauge", "sum"}, "ServiceName IN ('a')", TimeWindow{1, 2});
  size_t count = 0;
  for (size_t at = hidden.find("WHERE ServiceName IN ('a')"); at != std::string::npos; at = hidden.find("WHERE ServiceName IN ('a')", at + 1)) ++count;
  CHECK_EQ(count, size_t(2));
  CHECK(hidden.find("LIMIT 5001 SETTINGS max_execution_time = 30") != std::string::npos);
}

void test_the_attribute_statements_are_unchanged() {
  const auto keys = attributes_request({{"kind", "gauge"}, {"service", "api_service"}, {"metric", "queue.depth"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  CHECK_EQ(inlined(attribute_keys_statement(table_of("gauge"), "1", keys)), std::string(golden::kAttrKeys));
  const auto not_filter = attributes_request({{"kind", "sum"}, {"service", "api_service"}, {"metric", "traces.span.metrics.calls"},
                                              {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"filter_not", "span.kind=SERVER"}});
  CHECK_EQ(inlined(attribute_keys_statement(table_of("sum"), "1", not_filter)), std::string(golden::kAttrKeysFilterNot));
  const auto values = attributes_request({{"kind", "sum"}, {"service", "api_service"}, {"metric", "traces.span.metrics.calls"},
                                          {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"key", "span.kind"}});
  CHECK_EQ(inlined(attribute_values_statement(table_of("sum"), "1", values)), std::string(golden::kAttrValues));
  const auto filtered = attributes_request({{"kind", "sum"}, {"service", "api_service"}, {"metric", "traces.span.metrics.calls"},
                                            {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"key", "span.name"}, {"filter", "span.kind=SERVER"}});
  CHECK_EQ(inlined(attribute_values_statement(table_of("sum"), "1", filtered)), std::string(golden::kAttrValuesFiltered));
  // The code leaves out the filters on the listed key. The other values of that key stay visible.
  const auto self = attributes_request({{"kind", "sum"}, {"service", "api_service"}, {"metric", "traces.span.metrics.calls"},
                                        {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"key", "span.kind"}, {"filter", "span.kind=SERVER"}});
  CHECK_EQ(inlined(attribute_values_statement(table_of("sum"), "1", self)), std::string(golden::kAttrValuesSelf));
  // A user value is a parameter. A quote mark or a backslash never reaches the text of the statement.
  const auto quote = attributes_request({{"kind", "sum"}, {"service", "api_service"}, {"metric", "traces.span.metrics.calls"},
                                         {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"key", "it's"}, {"filter", "a'b=c\\d"}});
  const Statement statement = attribute_values_statement(table_of("sum"), "1", quote);
  CHECK(statement.sql.find("it's") == std::string::npos && statement.sql.find("a'b") == std::string::npos && statement.sql.find("c\\d") == std::string::npos);
  CHECK_EQ(inlined(statement), std::string(golden::kAttrQuote));
  // Each value has its own parameter: the service, the metric, the key, the filter key and its value.
  CHECK_EQ(statement.params.list().size(), size_t(5));
}

void test_the_series_statements_are_unchanged() {
  // The groups that a ranking kept. A grouped request reads them. The other groups form one group, folded in the statement.
  const std::vector<std::string> kept_summary = {"16723269243102733365"};
  const std::vector<std::string> kept_grouped = {"SPAN_KIND_CLIENT\x1fSTATUS_CODE_OK", "SPAN_KIND_CLIENT\x1fSTATUS_CODE_ERROR"};
  const std::vector<std::string> kept_none;
  const std::vector<std::string> kept_name = {"session.lookup"};
  const std::vector<std::string> kept_hosts = {"api-service-2", "api-service-0", "api-service-1"};
  const auto gauge = series_request({{"kind", "gauge"}, {"service", "api_service"}, {"metric", "queue.depth"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements gauge_statements(gauge, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(gauge_statements.info()), changed_info(golden::kInfoGauge, false));
  CHECK_EQ(inlined(gauge_statements.series(Mode::Gauge, false, "")), std::string(golden::kSeriesGauge));

  const auto sum = series_request({{"kind", "sum"}, {"service", "auth_service"}, {"metric", "traces.span.metrics.calls"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements sum_statements(sum, table_of("sum"), "1", true);
  CHECK_EQ(inlined(sum_statements.info()), changed_info(golden::kInfoSum, true));
  CHECK_EQ(inlined(sum_statements.series(Mode::Delta, false, "")), std::string(golden::kSeriesSumCumulative));

  const auto histogram_delta = series_request({{"kind", "histogram"}, {"service", "api_service"}, {"metric", "http.server.request.duration"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements delta_statements(histogram_delta, table_of("histogram"), "1", true);
  CHECK_EQ(inlined(delta_statements.info()), changed_info(golden::kInfoHistogram, false));
  CHECK_EQ(inlined(delta_statements.series(Mode::Histogram, true, "")), std::string(golden::kSeriesHistogramDelta));
  const auto histogram_cumulative = series_request({{"kind", "histogram"}, {"service", "auth_service"}, {"metric", "http.server.request.duration"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements cumulative_statements(histogram_cumulative, table_of("histogram"), "1", true);
  CHECK_EQ(inlined(cumulative_statements.series(Mode::Histogram, false, "")), std::string(golden::kSeriesHistogramCumulative));

  const auto exponential = series_request({{"kind", "exponential_histogram"}, {"service", "api_service"}, {"metric", "span.duration.exponential"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements exponential_statements(exponential, table_of("exponential_histogram"), "1", true);
  CHECK_EQ(inlined(exponential_statements.info()), changed_info(golden::kInfoExponential, false));
  CHECK_EQ(inlined(exponential_statements.series(Mode::Exponential, true, "")), std::string(golden::kSeriesExponentialDelta));

  const auto summary = series_request({{"kind", "summary"}, {"service", "auth_service"}, {"metric", "span.duration.summary"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements summary_statements(summary, table_of("summary"), "1", true);
  CHECK_EQ(inlined(summary_statements.info()), changed_info(golden::kInfoSummary, false));
  CHECK_EQ(inlined(summary_statements.series(Mode::SummaryQuantile, false, "0.5", &kept_summary)), std::string(golden::kSeriesSummaryQuantile));
  const auto summary_delta = series_request({{"kind", "summary"}, {"service", "auth_service"}, {"metric", "span.duration.summary"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements summary_delta_statements(summary_delta, table_of("summary"), "1", true);
  CHECK_EQ(inlined(summary_delta_statements.series(Mode::SummaryDelta, false, "")), std::string(golden::kSeriesSummaryDelta));

  // Grouping, filters, a grid that the request chose, and a user's quote marks.
  const auto grouped = series_request({{"kind", "sum"}, {"service", "auth_service"}, {"metric", "traces.span.metrics.calls"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                                       {"group_by", "span.kind,status.code"}, {"limit", "3"}});
  SeriesStatements grouped_statements(grouped, table_of("sum"), "1", true);
  CHECK_EQ(inlined(grouped_statements.series(Mode::Delta, false, "", &kept_grouped)), std::string(golden::kSeriesGrouped));
  const auto filters = series_request({{"kind", "sum"}, {"service", "auth_service"}, {"metric", "traces.span.metrics.calls"}, {"start_ms", kStart6h.c_str()}, {"end_ms", kEndText.c_str()},
                                       {"group_by", "span.kind"}, {"filter", "span.kind=SERVER"}, {"filter", "span.kind=CLIENT"}});
  SeriesStatements filter_statements(filters, table_of("sum"), "1", true);
  CHECK_EQ(inlined(filter_statements.info()), changed_info(golden::kInfoFiltered, true));
  CHECK_EQ(inlined(filter_statements.series(Mode::Delta, false, "", &kept_none)), std::string(golden::kSeriesFiltered));
  const auto filter_not = series_request({{"kind", "sum"}, {"service", "auth_service"}, {"metric", "traces.span.metrics.calls"}, {"start_ms", kStart6h.c_str()}, {"end_ms", kEndText.c_str()},
                                          {"group_by", "span.name"}, {"filter_not", "span.kind=SERVER"}, {"step_ms", "600000"}});
  SeriesStatements filter_not_statements(filter_not, table_of("sum"), "1", true);
  CHECK_EQ(inlined(filter_not_statements.series(Mode::Delta, false, "", &kept_name)), std::string(golden::kSeriesFilterNot));
  const auto gauge_group = series_request({{"kind", "gauge"}, {"service", "api_service"}, {"metric", "process.cpu.utilization"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                                           {"group_by", "host.name"}, {"agg", "max"}});
  SeriesStatements gauge_group_statements(gauge_group, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(gauge_group_statements.series(Mode::Gauge, false, "", &kept_hosts)), std::string(golden::kSeriesGaugeGrouped));
  const auto aligned = series_request({{"kind", "gauge"}, {"service", "api_service"}, {"metric", "queue.depth"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                                       {"bucket_origin_ms", "1234567"}, {"step_ms", "90000"}});
  SeriesStatements aligned_statements(aligned, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(aligned_statements.series(Mode::Gauge, false, "")), std::string(golden::kSeriesGaugeAligned));
  const auto quote = series_request({{"kind", "gauge"}, {"service", "a'b"}, {"metric", "m\\n"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}, {"filter", "k'=v'"}});
  SeriesStatements quote_statements(quote, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(quote_statements.info()), changed_info(golden::kInfoQuote, false));
  CHECK_EQ(inlined(quote_statements.series(Mode::Gauge, false, "")), std::string(golden::kSeriesQuote));
  CHECK(quote_statements.info().sql.find("a'b") == std::string::npos);

  // Some kinds have no capture of their own. The statement of a delta sum is the plain sum.
  // A cumulative exponential histogram takes the difference of each of its arrays with the point before it.
  SeriesStatements plain_sum(sum, table_of("sum"), "1", true);
  const std::string delta_sum = plain_sum.series(Mode::Delta, true, "").sql;
  CHECK(delta_sum.find("lagInFrame") == std::string::npos && delta_sum.find("sum(Value)") != std::string::npos);
  SeriesStatements cumulative_exponential(exponential, table_of("exponential_histogram"), "1", true);
  const std::string exp_sql = cumulative_exponential.series(Mode::Exponential, false, "").sql;
  CHECK(exp_sql.find("lagInFrame(PositiveBucketCounts) OVER w AS ppos") != std::string::npos && exp_sql.find("Scale != pscale") != std::string::npos);
  // Every statement of a series carries its own time bound and the cap of its rows.
  CHECK(exp_sql.find("LIMIT 300001 SETTINGS max_execution_time = 30, max_memory_usage = 2000000000") != std::string::npos);
}


// ---- the ranking of the groups in ClickHouse (ARCH-B-025) ----

void test_the_ranking_statements_are_the_ones_that_were_sent() {
  const auto window = [&](const char* kind, const char* service, const char* metric, const char* group_by, const char* agg) {
    return series_request({{"kind", kind}, {"service", service}, {"metric", metric}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()},
                           {"group_by", group_by}, {"agg", agg}, {"limit", "2"}});
  };
  const auto seconds = [](const SeriesRequest& request) { return static_cast<double>(request.grid.size_ms) / 1000.0; };
  const auto gauge_avg = window("gauge", "api_service", "process.cpu.utilization", "host.name", "avg");
  SeriesStatements gauge_avg_statements(gauge_avg, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(gauge_avg_statements.ranking(Mode::Gauge, false, "", "avg", seconds(gauge_avg), 2)), std::string(golden::kRankingGauge));
  const std::vector<std::string> hosts = {"api-service-2", "api-service-1"};
  CHECK_EQ(inlined(gauge_avg_statements.series(Mode::Gauge, false, "", &hosts)), std::string(golden::kSeriesKeepGauge));
  const auto gauge_last = window("gauge", "api_service", "process.cpu.utilization", "host.name", "last");
  SeriesStatements gauge_last_statements(gauge_last, table_of("gauge"), "1", true);
  CHECK_EQ(inlined(gauge_last_statements.ranking(Mode::Gauge, false, "", "last", seconds(gauge_last), 2)), std::string(golden::kRankingGaugeLast));
  const auto rate = window("sum", "auth_service", "traces.span.metrics.calls", "span.name", "rate");
  SeriesStatements rate_statements(rate, table_of("sum"), "1", true);
  CHECK_EQ(inlined(rate_statements.ranking(Mode::Delta, false, "", "rate", seconds(rate), 2)), std::string(golden::kRankingDelta));
  const auto increase = window("sum", "auth_service", "traces.span.metrics.calls", "span.name", "increase");
  SeriesStatements increase_statements(increase, table_of("sum"), "1", true);
  CHECK_EQ(inlined(increase_statements.ranking(Mode::Delta, false, "", "increase", seconds(increase), 2)), std::string(golden::kRankingDeltaIncrease));
  const auto p99 = window("histogram", "api_service", "http.server.request.duration", "span.name", "p99");
  SeriesStatements p99_statements(p99, table_of("histogram"), "1", true);
  CHECK_EQ(inlined(p99_statements.ranking(Mode::Histogram, true, "", "p99", seconds(p99), 2)), std::string(golden::kRankingHistogramQuantile));
  const std::vector<std::string> routes = {"request.validate"};
  CHECK_EQ(inlined(p99_statements.series(Mode::Histogram, true, "", &routes)), std::string(golden::kSeriesKeepHistogram));
  const auto average = window("histogram", "api_service", "http.server.request.duration", "span.name", "avg");
  SeriesStatements average_statements(average, table_of("histogram"), "1", true);
  CHECK_EQ(inlined(average_statements.ranking(Mode::Histogram, true, "", "avg", seconds(average), 2)), std::string(golden::kRankingHistogramAverage));
  const auto count_rate = window("histogram", "api_service", "http.server.request.duration", "span.name", "count_rate");
  SeriesStatements count_rate_statements(count_rate, table_of("histogram"), "1", true);
  CHECK_EQ(inlined(count_rate_statements.ranking(Mode::Histogram, true, "", "count_rate", seconds(count_rate), 2)), std::string(golden::kRankingHistogramCountRate));
  const auto exponential = window("exponential_histogram", "api_service", "span.duration.exponential", "span.name", "count");
  SeriesStatements exponential_statements(exponential, table_of("exponential_histogram"), "1", true);
  CHECK_EQ(inlined(exponential_statements.ranking(Mode::Exponential, true, "", "count", seconds(exponential), 2)), std::string(golden::kRankingExponentialCount));
  const auto quantile = window("summary", "api_service", "span.duration.summary", "span.name", "p50");
  SeriesStatements quantile_statements(quantile, table_of("summary"), "1", true);
  CHECK_EQ(inlined(quantile_statements.ranking(Mode::SummaryQuantile, false, "0.5", "p50", seconds(quantile), 2)), std::string(golden::kRankingSummaryQuantile));
  const std::vector<std::string> series_ids = {"4574312782914746434"};
  CHECK_EQ(inlined(quantile_statements.series(Mode::SummaryQuantile, false, "0.5", &series_ids)), std::string(golden::kSeriesKeepSummary));
  const auto summary_delta = window("summary", "api_service", "span.duration.summary", "span.name", "avg");
  SeriesStatements summary_delta_statements(summary_delta, table_of("summary"), "1", true);
  CHECK_EQ(inlined(summary_delta_statements.ranking(Mode::SummaryDelta, false, "", "avg", seconds(summary_delta), 2)), std::string(golden::kRankingSummaryDelta));

  // The kept groups are parameters. An empty list reads no group.
  const std::vector<std::string> none;
  const std::string empty = gauge_avg_statements.series(Mode::Gauge, false, "", &none).sql;
  CHECK(empty.find("IN ('')") != std::string::npos);
  // Without a list, the statement reads every group. The other groups are not folded.
  CHECK(gauge_avg_statements.series(Mode::Gauge, false, "").sql.find("__other__") == std::string::npos);
  // The ranking and the series carry the memory settings. The other statements carry only the time.
  CHECK(gauge_avg_statements.series(Mode::Gauge, false, "").sql.find("max_memory_usage = 2000000000") != std::string::npos);
  CHECK(gauge_avg_statements.info().sql.find("max_memory_usage") == std::string::npos);
}

void test_the_exemplars_statement_is_unchanged() {
  const auto histogram = exemplars_request({{"kind", "histogram"}, {"service", "api_service"}, {"metric", "http.server.request.duration"},
                                            {"start_ms", kStart24h.c_str()}, {"end_ms", kEndText.c_str()}});
  CHECK_EQ(inlined(exemplars_statement(table_of("histogram"), "1", histogram)), std::string(golden::kExemplars));
  const auto filtered = exemplars_request({{"kind", "histogram"}, {"service", "api_service"}, {"metric", "http.server.request.duration"},
                                           {"start_ms", kStart24h.c_str()}, {"end_ms", kEndText.c_str()}, {"filter", "span.name=x"}});
  CHECK_EQ(inlined(exemplars_statement(table_of("histogram"), "1", filtered)), std::string(golden::kExemplarsFiltered));
  const auto limited = exemplars_request({{"kind", "histogram"}, {"service", "auth_service"}, {"metric", "http.server.request.duration"},
                                          {"start_ms", kStart24h.c_str()}, {"end_ms", kEndText.c_str()}, {"per_bucket", "1"}, {"limit", "5"}});
  CHECK_EQ(inlined(exemplars_statement(table_of("histogram"), "1", limited)), std::string(golden::kExemplarsLimited));
}

void test_a_series_is_told_apart_by_its_scope_when_the_table_has_one() {
  const auto gauge = series_request({{"kind", "gauge"}, {"service", "api_service"}, {"metric", "queue.depth"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements scoped(gauge, table_of("gauge"), "1", true);
  const std::string text = scoped.series(Mode::Gauge, false, "").sql;
  CHECK(text.find("cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion) AS sid") != std::string::npos);
  CHECK_EQ(scoped.series_id(), std::string("cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion)"));
  // The code partitions a differenced series by the same identity.
  const auto sum = series_request({{"kind", "sum"}, {"service", "auth_service"}, {"metric", "traces.span.metrics.calls"}, {"start_ms", kStart2h.c_str()}, {"end_ms", kEndText.c_str()}});
  SeriesStatements scoped_sum(sum, table_of("sum"), "1", true);
  CHECK(scoped_sum.series(Mode::Delta, false, "").sql.find("WINDOW w AS (PARTITION BY cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion) ORDER BY") != std::string::npos);
  SeriesStatements plain(gauge, table_of("gauge"), "1", false);
  CHECK(plain.series(Mode::Gauge, false, "").sql.find("ScopeName") == std::string::npos);
  CHECK_EQ(scope_columns_sql(settings()),
           std::string("SELECT toString(`table`) FROM system.columns WHERE database = 'otel' AND `table` IN ('otel_metrics_gauge', 'otel_metrics_sum', "
                       "'otel_metrics_histogram', 'otel_metrics_exponential_histogram', 'otel_metrics_summary') AND name IN ('ScopeName', 'ScopeVersion') "
                       "GROUP BY `table` HAVING count() = 2"));
}

// ---- the aggregation of the rows ----

void test_explicit_quantiles() {
  const std::vector<double> bounds = {1, 2, 5};
  // Prometheus histogram_quantile interpolates linearly inside the bucket that holds the rank. The first bucket starts at 0.
  CHECK_EQ(explicit_quantile(0.5, bounds, {10, 10, 0, 0}), 1.0);
  CHECK_EQ(explicit_quantile(0.75, bounds, {10, 10, 0, 0}), 1.5);
  CHECK_EQ(explicit_quantile(1.0, bounds, {10, 10, 0, 0}), 2.0);
  CHECK_EQ(explicit_quantile(0.9, bounds, {0, 0, 10, 0}), 4.7);
  // A rank in the +Inf bucket answers the largest finite bound.
  CHECK_EQ(explicit_quantile(0.9, bounds, {1, 1, 1, 10}), 5.0);
  // Without a count or a bound, the result has no value.
  CHECK(std::isnan(explicit_quantile(0.5, bounds, {0, 0, 0, 0})));
  CHECK(std::isnan(explicit_quantile(0.5, {}, {5})));
  // A first bucket whose bound is not positive answers its bound.
  CHECK_EQ(explicit_quantile(0.5, {0, 1}, {4, 0, 0}), 0.0);
  // A negative count is no count.
  CHECK_EQ(explicit_quantile(0.5, bounds, {-5, 10, 0, 0}), 1.5);
}

void test_exponential_quantiles() {
  ExpState state;
  state.present = true;
  state.scale = 0;
  // Scale 0: the bucket k covers (2^k, 2^(k+1)].
  state.positive[0] = 10;
  state.positive[1] = 10;
  CHECK_EQ(exponential_quantile(0.5, state), 2.0);
  CHECK_EQ(exponential_quantile(1.0, state), 4.0);
  CHECK_EQ(exponential_quantile(0.75, state), 3.0);
  // The zero bucket and the negative buckets rank below the positive ones.
  state.zero = 20;
  CHECK_EQ(exponential_quantile(0.25, state), 0.0);
  state.negative[0] = 20;
  CHECK_EQ(exponential_quantile(0.1, state), -1.7);
  ExpState empty;
  empty.present = true;
  CHECK(std::isnan(exponential_quantile(0.5, empty)));
}

void test_cells_merge() {
  Cell a, b;
  a.sum = 3;
  a.count = 2;
  a.min = 1;
  a.max = 2;
  a.last_sum = 5;
  a.series = 1;
  b.sum = 4;
  b.count = 1;
  b.min = 0.5;
  b.max = 9;
  b.last_sum = 1;
  b.series = 1;
  merge_cell(a, b);
  CHECK_EQ(a.sum, 7.0);
  CHECK_EQ(a.count, 3.0);
  CHECK_EQ(a.min, 0.5);
  CHECK_EQ(a.max, 9.0);
  CHECK_EQ(a.last_sum, 6.0);
  CHECK_EQ(a.series, 2.0);
  // Histograms with the same bounds add up bucket by bucket.
  Cell h1, h2;
  h1.bounds = {1, 2};
  h1.counts = {1, 2, 3};
  h2.bounds = {1, 2};
  h2.counts = {10, 20, 30};
  merge_cell(h1, h2);
  CHECK_EQ(h1.counts.size(), size_t(3));
  CHECK_EQ(h1.counts[0], 11.0);
  CHECK_EQ(h1.counts[2], 33.0);
  // With other bounds, the code uses the sorted union of the bounds. Each bucket goes to the bucket that has its upper bound.
  Cell wide;
  wide.bounds = {1, 2, 4};
  wide.counts = {1, 1, 1, 1};
  Cell fine;
  fine.bounds = {2, 3};
  fine.counts = {5, 7, 9};
  merge_cell(wide, fine);
  CHECK((wide.bounds == std::vector<double>{1, 2, 3, 4}));
  CHECK((wide.counts == std::vector<double>{1, 6, 7, 1, 10}));
  // The code rescales exponential buckets to the coarser scale before it adds them.
  Cell e1, e2;
  e1.exp.present = true;
  e1.exp.scale = 1;
  e1.exp.positive = {{2, 4}, {3, 6}};
  e2.exp.present = true;
  e2.exp.scale = 0;
  e2.exp.positive = {{1, 10}};
  e2.exp.zero = 2;
  merge_cell(e1, e2);
  CHECK_EQ(e1.exp.scale, 0);
  CHECK_EQ(e1.exp.positive.size(), size_t(1));
  CHECK_EQ(e1.exp.positive[1], 20.0);
  CHECK_EQ(e1.exp.zero, 2.0);
}

void test_the_merge_of_histograms_does_not_depend_on_the_order_of_the_rows() {
  struct Source { std::vector<double> bounds, counts; };
  const std::vector<Source> sources = {{{1, 2, 5}, {1, 2, 3, 4}}, {{2, 3}, {5, 7, 9}}, {{}, {6}}, {{1, 5, 10}, {1, 1, 1, 1}}, {{2, 3}, {1, 0, 0}}};
  const auto merged = [&](std::vector<size_t> order) {
    Cell cell;
    for (const size_t i : order) {
      Cell next;
      next.bounds = sources[i].bounds;
      next.counts = sources[i].counts;
      merge_cell(cell, next);
    }
    return cell;
  };
  const Cell first = merged({0, 1, 2, 3, 4});
  // The bounds are the sorted union. No count is lost.
  CHECK((first.bounds == std::vector<double>{1, 2, 3, 5, 10}));
  double total = 0, expected = 0;
  for (const double c : first.counts) total += c;
  for (const auto& source : sources) for (const double c : source.counts) expected += c;
  CHECK_EQ(total, expected);
  CHECK_EQ(first.counts.size(), size_t(6));
  // Every other order gives the same cell.
  std::vector<size_t> order = {0, 1, 2, 3, 4};
  do {
    const Cell other = merged(order);
    CHECK(other.bounds == first.bounds);
    CHECK(other.counts == first.counts);
  } while (std::next_permutation(order.begin(), order.end()));
  // A row with no bounds comes first. Its count is not put in the first bucket. The quantile is not NaN.
  Cell empty_first;
  Cell no_bounds;
  no_bounds.counts = {4};
  merge_cell(empty_first, no_bounds);
  Cell real;
  real.bounds = {1, 2};
  real.counts = {10, 10, 0};
  merge_cell(empty_first, real);
  CHECK((empty_first.bounds == std::vector<double>{1, 2}));
  CHECK((empty_first.counts == std::vector<double>{10, 10, 4}));
  CHECK(!std::isnan(explicit_quantile(0.5, empty_first.bounds, empty_first.counts)));
  // The same bounds stay a plain sum.
  Cell same_a, same_b;
  same_a.bounds = same_b.bounds = {1, 2};
  same_a.counts = {1, 1, 1};
  same_b.counts = {2, 2, 2};
  merge_cell(same_a, same_b);
  CHECK((same_a.counts == std::vector<double>{3, 3, 3}));
}

void test_the_values_of_a_cell() {
  Cell gauge;
  gauge.sum = 10;
  gauge.count = 4;
  gauge.min = 1;
  gauge.max = 6;
  gauge.last_sum = 9;
  gauge.series = 3;
  CHECK_EQ(cell_value(gauge, Mode::Gauge, "avg", 60), 2.5);
  CHECK_EQ(cell_value(gauge, Mode::Gauge, "min", 60), 1.0);
  CHECK_EQ(cell_value(gauge, Mode::Gauge, "max", 60), 6.0);
  CHECK_EQ(cell_value(gauge, Mode::Gauge, "last", 60), 3.0);
  CHECK_EQ(cell_value(gauge, Mode::Gauge, "sum", 60), 9.0);
  CHECK(std::isnan(cell_value(Cell{}, Mode::Gauge, "avg", 60)));
  CHECK_EQ(cell_value(gauge, Mode::Delta, "rate", 5), 2.0);
  CHECK_EQ(cell_value(gauge, Mode::Delta, "increase", 5), 10.0);
  Cell hist;
  hist.bounds = {1, 2};
  hist.counts = {10, 10, 0};
  hist.count = 20;
  hist.sum = 30;
  CHECK_EQ(cell_value(hist, Mode::Histogram, "avg", 10), 1.5);
  CHECK_EQ(cell_value(hist, Mode::Histogram, "count", 10), 20.0);
  CHECK_EQ(cell_value(hist, Mode::Histogram, "count_rate", 10), 2.0);
  CHECK_EQ(cell_value(hist, Mode::Histogram, "p50", 10), 1.0);
  CHECK(std::isnan(cell_value(hist, Mode::Histogram, "bogus", 10)));
  Cell summary;
  summary.last_sum = 8;
  summary.series = 2;
  CHECK_EQ(cell_value(summary, Mode::SummaryQuantile, "p99", 60), 4.0);
}

void test_the_names_of_the_quantiles() {
  CHECK_EQ(quantile_agg_name(0.5), std::string("p50"));
  CHECK_EQ(quantile_agg_name(0.999), std::string("p99.9"));
  CHECK_EQ(quantile_agg_name(1.0), std::string("p100"));
  CHECK_EQ(quantile_agg_name(0.0), std::string("p0"));
  CHECK(is_quantile_agg("p50") && is_quantile_agg("p99.9") && !is_quantile_agg("p") && !is_quantile_agg("pxx") && !is_quantile_agg("avg"));
  CHECK_EQ(quantile_of("p50"), 0.5);
  CHECK(std::fabs(quantile_of("p99.9") - 0.999) < 1e-12);
}

void test_the_aggregations_that_a_metric_offers() {
  MetricInfo info;
  AggregationPlan plan;
  std::string error;
  info.points = 100;
  // Gauge.
  CHECK(plan_aggregation("gauge", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("avg"));
  CHECK_EQ(plan.agg, std::string("avg"));
  CHECK(plan.mode == Mode::Gauge && !plan.per_series);
  CHECK(!plan_aggregation("gauge", info, "p50", &plan, &error));
  CHECK_EQ(error, std::string("agg must be one of: avg, min, max, last, sum."));
  // The code reads a monotonic sum as increases. It reads a cumulative gauge-like sum as a gauge. It reads a delta sum as sums.
  info.monotonic = true;
  info.temporality_min = info.temporality_max = 2;
  CHECK(plan_aggregation("sum", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("rate"));
  CHECK(plan.mode == Mode::Delta && !plan.all_delta && plan.any_cumulative);
  info.monotonic = false;
  CHECK(plan_aggregation("sum", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("last"));
  CHECK(plan.mode == Mode::Gauge);
  info.temporality_min = info.temporality_max = 1;
  CHECK(plan_aggregation("sum", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("sum"));
  CHECK(plan.mode == Mode::Delta && plan.all_delta);
  info.points = 0;
  CHECK(plan_aggregation("sum", info, "increase", &plan, &error));
  info.points = 5;
  // Histograms.
  CHECK(plan_aggregation("histogram", info, "p99", &plan, &error));
  CHECK(plan.mode == Mode::Histogram);
  CHECK(plan_aggregation("exponential_histogram", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("p50"));
  CHECK(plan.mode == Mode::Exponential);
  // A summary offers its own quantiles, then avg and count_rate. The code reads a quantile per series. It reads the others as deltas.
  info.quantiles = {"0.5", "0.99"};
  CHECK(plan_aggregation("summary", info, "", &plan, &error));
  CHECK_EQ(plan.aggs.size(), size_t(4));
  CHECK_EQ(plan.default_agg, std::string("p50"));
  CHECK(plan.mode == Mode::SummaryQuantile && plan.per_series);
  CHECK(plan_aggregation("summary", info, "avg", &plan, &error));
  CHECK(plan.mode == Mode::SummaryDelta && !plan.per_series);
  CHECK(!plan_aggregation("summary", info, "p90", &plan, &error));
  CHECK_EQ(error, std::string("agg must be one of: p50, p99, avg, count_rate."));
  info.quantiles = {"0.9"};
  CHECK(plan_aggregation("summary", info, "", &plan, &error));
  CHECK_EQ(plan.default_agg, std::string("p90"));
  CHECK_EQ(summary_quantile_literal(info, "p90"), std::string("0.9"));
  CHECK_EQ(summary_quantile_literal(info, "p42"), std::to_string(0.42));
  CHECK_EQ(temporality_name(MetricInfo{}), std::string());
  MetricInfo mixed;
  mixed.points = 1;
  mixed.temporality_min = 1;
  mixed.temporality_max = 2;
  CHECK_EQ(temporality_name(mixed), std::string("mixed"));
  mixed.temporality_min = 2;
  CHECK_EQ(temporality_name(mixed), std::string("cumulative"));
  mixed.temporality_min = mixed.temporality_max = 1;
  CHECK_EQ(temporality_name(mixed), std::string("delta"));
}

// A block of text columns, as ClickHouse sends the rows of a statement here.
clickhouse::Block text_block(const Rows& rows) {
  clickhouse::Block block;
  for (size_t c = 0; c < rows.front().size(); ++c) {
    auto column = std::make_shared<clickhouse::ColumnString>();
    for (const auto& row : rows) column->Append(row[c]);
    block.AppendColumn("c" + std::to_string(c), column);
  }
  return block;
}

void test_rows_become_groups_and_the_best_groups_are_kept() {
  // Gauge rows: g, bucket, sum, count, min, max, sum of last values, series.
  const Rows rows = {{"a", "60000", "10", "2", "4", "6", "6", "1"}, {"a", "60000", "20", "2", "8", "12", "12", "1"},
                     {"b", "60000", "1", "1", "1", "1", "1", "1"}, {"c", "120000", "2", "1", "2", "2", "2", "1"},
                     {"d", "120000", "100", "10", "10", "10", "10", "1"}};
  const auto block = text_block(rows);
  std::map<std::string, Group> groups;
  for (size_t row = 0; row < rows.size(); ++row) add_series_row(block, row, Mode::Gauge, &groups);
  CHECK_EQ(groups.size(), size_t(4));
  // Two rows of one cell are merged.
  CHECK_EQ(groups["a"].cells.size(), size_t(1));
  CHECK_EQ(groups["a"].cells[60000].sum, 30.0);
  CHECK_EQ(groups["a"].cells[60000].count, 4.0);
  CHECK_EQ(groups["a"].cells[60000].min, 4.0);
  CHECK_EQ(groups["a"].cells[60000].max, 12.0);
  // The code ranks the groups by the sum of |value| over the buckets. Ties go by key. The top 2 are kept. The others fold into one.
  auto ranked = rank_groups(&groups, Mode::Gauge, "sum", 60.0, 2, false);
  CHECK_EQ(ranked.ordered.size(), size_t(4));
  CHECK_EQ(ranked.kept, size_t(2));
  CHECK_EQ(ranked.ordered[0]->key, std::string("a"));   // 18
  CHECK_EQ(ranked.ordered[1]->key, std::string("d"));   // 10
  CHECK_EQ(ranked.other_count, size_t(2));
  CHECK_EQ(ranked.other.key, std::string("__other__"));
  CHECK_EQ(ranked.other.cells.size(), size_t(2));
  CHECK_EQ(ranked.other.cells[60000].last_sum, 1.0);
  CHECK_EQ(ranked.other.score, 3.0);
  // A summary shows every series and folds none.
  auto per_series = rank_groups(&groups, Mode::Gauge, "sum", 60.0, 2, true);
  CHECK_EQ(per_series.other_count, size_t(0));
  CHECK(per_series.other.cells.empty());
  // When k is larger than the number of groups, all groups are kept.
  auto all = rank_groups(&groups, Mode::Gauge, "sum", 60.0, 50, false);
  CHECK_EQ(all.kept, size_t(4));
  CHECK_EQ(all.other_count, size_t(0));
  // The code ranks quantiles of a histogram by their observation count. It does not rank them by their value.
  const Rows hist_rows = {{"x", "60000", "1,2", "10,0,0", "10", "10"}, {"y", "60000", "1,2", "0,0,3", "3", "9"}};
  const auto hist_block = text_block(hist_rows);
  std::map<std::string, Group> hist_groups;
  for (size_t row = 0; row < hist_rows.size(); ++row) add_series_row(hist_block, row, Mode::Histogram, &hist_groups);
  auto by_count = rank_groups(&hist_groups, Mode::Histogram, "p50", 60.0, 1, false);
  CHECK_EQ(by_count.ordered[0]->key, std::string("x"));
  CHECK_EQ(by_count.ordered[0]->score, 10.0);
  // The empty group key of an ungrouped series is a key: "".
  const Rows ungrouped = {{"", "60000", "5", "1"}};
  std::map<std::string, Group> plain;
  add_series_row(text_block(ungrouped), 0, Mode::Delta, &plain);
  CHECK_EQ(plain.size(), size_t(1));
  CHECK_EQ(plain.begin()->second.cells[60000].sum, 5.0);
}

void test_exponential_and_summary_rows() {
  // g, bucket, scale, positive offset, negative offset, positive counts, negative counts, zero, count, sum.
  const Rows exp_rows = {{"", "60000", "0", "-1", "0", "0,4,6", "2", "3", "15", "42.5"}};
  std::map<std::string, Group> groups;
  add_series_row(text_block(exp_rows), 0, Mode::Exponential, &groups);
  const Cell& cell = groups[""].cells[60000];
  CHECK(cell.exp.present);
  CHECK_EQ(cell.exp.scale, 0);
  CHECK_EQ(cell.exp.positive.size(), size_t(2));   // the zero count of the first bucket is not kept
  CHECK_EQ(cell.exp.positive.at(0), 4.0);
  CHECK_EQ(cell.exp.positive.at(1), 6.0);
  CHECK_EQ(cell.exp.negative.at(0), 2.0);
  CHECK_EQ(cell.exp.zero, 3.0);
  CHECK_EQ(cell.count, 15.0);
  CHECK_EQ(cell.sum, 42.5);
  // Summary quantile rows: series id, labels, bucket, value. A value that is not finite is no point.
  const Rows quantile_rows = {{"11", "{\"a\":\"b\"}", "60000", "7.5"}, {"11", "{\"a\":\"b\"}", "120000", "nan"}};
  const auto quantile_block = text_block(quantile_rows);
  std::map<std::string, Group> series;
  for (size_t row = 0; row < quantile_rows.size(); ++row) add_series_row(quantile_block, row, Mode::SummaryQuantile, &series);
  CHECK_EQ(series.size(), size_t(1));
  CHECK_EQ(series["11"].labels_json, std::string("{\"a\":\"b\"}"));
  CHECK_EQ(series["11"].cells[60000].series, 1.0);
  CHECK_EQ(series["11"].cells[60000].last_sum, 7.5);
  CHECK_EQ(series["11"].cells[120000].series, 0.0);
  CHECK(std::isnan(cell_value(series["11"].cells[120000], Mode::SummaryQuantile, "p50", 60)));
}

void test_text_from_clickhouse() {
  CHECK(std::isnan(text_to_double("")));
  CHECK(std::isnan(text_to_double("nan")));
  CHECK(std::isnan(text_to_double("-nan")));
  CHECK(std::isnan(text_to_double("x")));
  CHECK_EQ(text_to_double("inf"), std::numeric_limits<double>::infinity());
  CHECK_EQ(text_to_double("-inf"), -std::numeric_limits<double>::infinity());
  CHECK_EQ(text_to_double("2.5e3"), 2500.0);
  CHECK_EQ(text_to_i64(""), int64_t(0));
  CHECK_EQ(text_to_i64("x"), int64_t(0));
  CHECK_EQ(text_to_i64("-42"), int64_t(-42));
  const auto doubles = text_to_doubles("1,,2.5,inf");
  CHECK_EQ(doubles.size(), size_t(4));
  CHECK(std::isnan(doubles[1]));
  CHECK_EQ(doubles[2], 2.5);
  CHECK(text_to_doubles("").empty());
  const auto parts = split_keep(std::string("a\x1f" "\x1f" "c"), '\x1f');
  CHECK_EQ(parts.size(), size_t(3));
  CHECK_EQ(parts[1], std::string());
}

// ---- the service ----

HostSpec metrics_host() {
  HostSpec host;
  host.id = "local";
  host.system_uri = "clickhouse://system@clickhouse:9000";
  host.otel.metrics = settings();
  host.otel.traces.enabled = true;
  return host;
}

struct TestCaches {
  CatalogCache catalog{CatalogCache::Options{}};
  KindTablesCache kinds{KindTablesCache::Options{}};
  MetricsCaches refs() { return MetricsCaches{catalog, kinds}; }
};

MetricsService service_over(FakeDb& db, TestCaches& caches) {
  return MetricsService([&db](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, caches.refs());
}

const Rows kAllKinds = {{"otel_metrics_gauge"}, {"otel_metrics_sum"}, {"otel_metrics_histogram"}, {"otel_metrics_exponential_histogram"}, {"otel_metrics_summary"}};

rapidjson::Document parse(const std::string& text) {
  rapidjson::Document doc;
  doc.Parse(text.c_str());
  CHECK(!doc.HasParseError());
  return doc;
}

void test_the_service_cannot_connect() {
  TestCaches caches;
  MetricsService service([](const HostSpec&, std::string* error) -> std::unique_ptr<ChExecutor> {
    if (error) *error = "OTel metrics: system credentials are required for the selected host.";
    return nullptr;
  }, caches.refs());
  RequestContext context;
  CatalogRequest catalog;
  catalog.window = TimeWindow{1000, 2000};
  const auto answer = service.catalog(context, metrics_host(), "local", catalog);
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  CHECK_EQ(answer.error.code, std::string("metrics_source_unavailable"));
  CHECK_EQ(answer.error.message, std::string("OTel metrics: system credentials are required for the selected host."));
  const auto attributes = service.attributes(context, metrics_host(), attributes_request({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}}));
  CHECK_EQ(attributes.error.code, std::string("metrics_source_unavailable"));
  // No reason: a message of its own.
  MetricsService silent([](const HostSpec&, std::string*) -> std::unique_ptr<ChExecutor> { return nullptr; }, caches.refs());
  CHECK_EQ(silent.series(context, metrics_host(), "local", series_request({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1"}, {"end_ms", "9"}})).error.message,
           std::string("Cannot connect to the metrics ClickHouse source."));
}

void test_the_catalog_and_its_json() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  // kind, service, metric, unit, description, tmin, tmax, mono_min, mono_max, points
  db.on("SELECT kind, service, metric", {
    {"gauge", "api", "cpu", "1", "CPU", "", "", "", "", "100"},
    {"sum", "api", "calls", "{calls}", "", "2", "2", "1", "1", "50"},
    {"histogram", "api", "latency", "s", "", "1", "2", "", "", "7"},
    {"sum", "web", "calls", "", "", "1", "1", "0", "0", "3"}});
  RequestContext context;
  CatalogRequest request;
  request.window = TimeWindow{kEnd - kHour, kEnd};
  const auto service = service_over(db, caches);
  const auto first = service.catalog(context, metrics_host(), "local", request);
  CHECK(first);
  CHECK(!first.value->hit);
  CHECK_EQ(db.count("FROM system.tables WHERE database"), size_t(1));
  const auto doc = parse(catalog_json(*first.value));
  CHECK_EQ(doc["v"].GetInt(), 1);
  CHECK_EQ(std::string(doc["source_host_id"].GetString()), std::string("local"));
  CHECK_EQ(doc["range"][0].GetInt64(), kEnd - kHour);
  CHECK_EQ(doc["service_count"].GetInt(), 2);
  CHECK_EQ(doc["metric_count"].GetInt(), 4);
  CHECK(!doc["truncated"].GetBool() && !doc["estimated"].GetBool());
  CHECK_EQ(doc["limit"].GetInt(), 5000);
  CHECK_EQ(doc["kinds"].Size(), 5u);
  CHECK(!doc.HasMember("error_code"));
  const auto& api = doc["services"][0];
  CHECK_EQ(std::string(api["name"].GetString()), std::string("api"));
  CHECK_EQ(api["metrics"].Size(), 3u);
  const auto& calls = api["metrics"][1];
  CHECK_EQ(std::string(calls["temporality"].GetString()), std::string("cumulative"));
  CHECK(calls["monotonic"].GetBool());
  CHECK_EQ(calls["points"].GetInt64(), 50);
  CHECK(api["metrics"][0]["temporality"].IsNull() && api["metrics"][0]["monotonic"].IsNull());
  CHECK_EQ(std::string(api["metrics"][2]["temporality"].GetString()), std::string("mixed"));
  CHECK(!doc["services"][1]["metrics"][0]["monotonic"].GetBool());
  CHECK_EQ(std::string(doc["services"][1]["metrics"][0]["temporality"].GetString()), std::string("delta"));
  CHECK(!doc["cache"]["hit"].GetBool());
  CHECK_EQ(doc["cache"]["ttl_ms"].GetInt64(), int64_t(60000));
  CHECK(doc["timing_ms"].HasMember("query") && doc["timing_ms"].HasMember("total"));
  // The second request of the window reads the cache. It sends no statement and no query time.
  const size_t statements = db.sqls.size();
  const auto second = service.catalog(context, metrics_host(), "local", request);
  CHECK(second && second.value->hit);
  CHECK_EQ(db.sqls.size(), statements);
  CHECK_EQ(second.value->query_ms, int64_t(0));
  CHECK(parse(catalog_json(*second.value))["cache"]["hit"].GetBool());
  // refresh=1 reads again.
  request.refresh = true;
  const auto third = service.catalog(context, metrics_host(), "local", request);
  CHECK(third && !third.value->hit);
  CHECK(db.sqls.size() > statements);
  // For the key, the window is the same minute and not the same millisecond.
  CatalogRequest next = request;
  next.refresh = false;
  next.window.end_ms += 1;
  CHECK(service.catalog(context, metrics_host(), "local", next).value->hit);
  // Another source host does not share the entry.
  CHECK(!service.catalog(context, metrics_host(), "other", next).value->hit);
}

void test_the_catalog_is_bounded_and_says_so() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", {{"otel_metrics_gauge"}});
  Rows many;
  for (int i = 0; i < 5001; ++i) many.push_back({"gauge", "svc", "m" + std::to_string(1000 + i), "", "", "", "", "", "", "1"});
  db.on("SELECT kind, service, metric", many);
  db.bounded_result.read_rows = kCatalogReadRowsCap;
  TestCaches fresh;
  const auto service = service_over(db, fresh);
  RequestContext context;
  CatalogRequest request;
  request.window = TimeWindow{1000, 2000};
  const auto answer = service.catalog(context, metrics_host(), "local", request);
  CHECK(answer);
  const auto doc = parse(catalog_json(*answer.value));
  CHECK(doc["truncated"].GetBool());
  CHECK(doc["estimated"].GetBool());
  CHECK_EQ(doc["metric_count"].GetInt(), 5000);
  CHECK_EQ(doc["services"][0]["metrics"].Size(), 5000u);
}

void test_a_source_without_tables_says_so() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", {});
  const auto service = service_over(db, caches);
  RequestContext context;
  CatalogRequest request;
  request.window = TimeWindow{1000, 2000};
  const auto answer = service.catalog(context, metrics_host(), "local", request);
  CHECK(answer);
  CHECK_EQ(db.sqls.size(), size_t(1));
  const auto doc = parse(catalog_json(*answer.value));
  CHECK_EQ(doc["kinds"].Size(), 0u);
  CHECK_EQ(std::string(doc["error_code"].GetString()), std::string("metrics_tables_missing"));
  CHECK_EQ(std::string(doc["message"].GetString()),
           std::string("No OpenTelemetry exporter metrics tables named otel.otel_metrics_{gauge,sum,histogram,exponential_histogram,summary} exist."));
}

void test_a_failure_of_the_catalog_is_the_error_of_the_route() {
  FakeDb db;
  TestCaches caches;
  db.fail_on("FROM system.tables WHERE database", [] { throw server_error(159, "Timeout exceeded"); });
  RequestContext context;
  CatalogRequest request;
  request.window = TimeWindow{1000, 2000};
  const auto timeout = service_over(db, caches).catalog(context, metrics_host(), "local", request);
  CHECK(!timeout);
  CHECK_EQ(timeout.error.status, 504);
  CHECK_EQ(timeout.error.code, std::string("metrics_timeout"));
  FakeDb other;
  TestCaches other_caches;
  other.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  other.fail_on("SELECT kind, service, metric", [] { throw server_error(60, "Table otel.otel_metrics_gauge does not exist"); });
  const auto failed = service_over(other, other_caches).catalog(context, metrics_host(), "local", request);
  CHECK_EQ(failed.error.status, 503);
  CHECK_EQ(failed.error.code, std::string("metrics_query_failed"));
}

void test_the_table_of_a_kind_may_be_missing_or_not_readable() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", {{"otel_metrics_gauge"}});
  db.on("CHECK GRANT SELECT ON `otel`.`otel_metrics_sum`", {{"0"}});
  db.on("CHECK GRANT SELECT ON `otel`.`otel_metrics_histogram`", {{"1"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto request = [&](const char* kind) {
    return series_request({{"kind", kind}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "9000"}});
  };
  // The table does not exist anywhere. The user may read it. The answer says it does not exist.
  const auto missing = service.series(context, metrics_host(), "local", request("histogram"));
  CHECK_EQ(missing.error.status, 404);
  CHECK_EQ(missing.error.code, std::string("metrics_table_missing"));
  CHECK_EQ(missing.error.message, std::string("Table otel.otel_metrics_histogram does not exist on this host."));
  // The user may not read it: a grant to give.
  const auto denied = service.series(context, metrics_host(), "local", request("sum"));
  CHECK_EQ(denied.error.status, 503);
  CHECK_EQ(denied.error.code, std::string("metrics_table_not_granted"));
  CHECK(denied.error.message.find("Table otel.otel_metrics_sum is not readable by the system user") == 0);
  CHECK(denied.error.message.find("system: Not enough privileges") != std::string::npos);
  CHECK(denied.error.message.find("SELECT ON otel.otel_metrics_sum") != std::string::npos);
  const std::string json = error_json(denied.error);
  CHECK(json.find("\"reason\":\"not_granted\"") != std::string::npos && json.find("\"user\":\"system\"") != std::string::npos);
  // The code reads the list of the kinds once for these requests.
  CHECK_EQ(db.count("FROM system.tables WHERE database"), size_t(1));
  // The attributes and the exemplars check the table too.
  CHECK_EQ(service.attributes(context, metrics_host(), attributes_request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "9000"}})).error.code,
           std::string("metrics_table_not_granted"));
  CHECK_EQ(service.exemplars(context, metrics_host(), "local", exemplars_request({{"kind", "histogram"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "1000"}, {"end_ms", "9000"}})).error.code,
           std::string("metrics_table_missing"));
  // When a server cannot answer CHECK GRANT, the code treats the table as missing.
  FakeDb quiet;
  TestCaches quiet_caches;
  quiet.on("FROM system.tables WHERE database = 'otel'", {});
  quiet.fail_on("CHECK GRANT", [] { throw server_error(62, "Syntax error"); });
  CHECK_EQ(service_over(quiet, quiet_caches).series(context, metrics_host(), "local", request("gauge")).error.code, std::string("metrics_table_missing"));
}

void test_the_service_tells_series_apart_by_their_scope() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("FROM system.columns WHERE database = 'otel'", {{"otel_metrics_gauge"}, {"otel_metrics_histogram"}});
  db.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "1", "", "0"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto request = [&](const char* kind) {
    return series_request({{"kind", kind}, {"service", "a"}, {"metric", "b"}, {"start_ms", "60000"}, {"end_ms", "179999"}});
  };
  CHECK(service.series(context, metrics_host(), "local", request("gauge")));
  CHECK(db.sqls.back().find("cityHash64(Attributes, ResourceAttributes, ScopeName, ScopeVersion)") != std::string::npos);
  CHECK(service.series(context, metrics_host(), "local", request("histogram")));
  CHECK(db.sqls.back().find("ScopeVersion") != std::string::npos);
  // A table without them: the attributes only.
  CHECK(service.series(context, metrics_host(), "local", request("sum")));
  CHECK(db.sqls.back().find("ScopeName") == std::string::npos);
  // The code reads the columns once with the kinds.
  CHECK_EQ(db.count("FROM system.columns"), size_t(1));
  // A source that cannot answer keeps the previous behavior.
  FakeDb quiet;
  TestCaches quiet_caches;
  quiet.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  quiet.fail_on("FROM system.columns", [] { throw server_error(497, "Not enough privileges"); });
  quiet.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "1", "", "0"}});
  CHECK(service_over(quiet, quiet_caches).series(context, metrics_host(), "local", request("gauge")));
  CHECK(quiet.sqls.back().find("ScopeName") == std::string::npos);
}

void test_monotonic_is_said_to_be_mixed() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  // kind, service, metric, unit, description, tmin, tmax, mono_min, mono_max, points
  db.on("SELECT kind, service, metric", {
    {"sum", "api", "all", "", "", "2", "2", "1", "1", "5"}, {"sum", "api", "none", "", "", "2", "2", "0", "0", "5"},
    {"sum", "api", "some", "", "", "2", "2", "0", "1", "5"}, {"gauge", "api", "g", "", "", "", "", "", "", "5"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  CatalogRequest request;
  request.window = TimeWindow{1000, 2000};
  const auto doc = parse(catalog_json(*service.catalog(context, metrics_host(), "local", request).value));
  const auto& metrics = doc["services"][0]["metrics"];
  CHECK(metrics[0]["monotonic"].GetBool() && !metrics[0]["monotonic_mixed"].GetBool());      // all
  CHECK(!metrics[1]["monotonic"].GetBool() && !metrics[1]["monotonic_mixed"].GetBool());     // none
  CHECK(metrics[2]["monotonic"].GetBool() && metrics[2]["monotonic_mixed"].GetBool());       // some
  CHECK(metrics[3]["monotonic"].IsNull() && metrics[3]["monotonic_mixed"].IsNull());         // a gauge
  // The series of a sum: the information has the least and the most of IsMonotonic.
  FakeDb sums;
  TestCaches sum_caches;
  sums.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  sums.on("SELECT any(MetricUnit)", {{"", "", "2", "2", "1", "9", "", "0"}});
  sums.on("SELECT g, toString(b), toString(sum(d1))", {{"", "60000", "1", "0"}});
  const auto answer = service_over(sums, sum_caches).series(context, metrics_host(), "local",
                                                              series_request({{"kind", "sum"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "60000"}, {"end_ms", "179999"}}));
  CHECK(answer);
  const auto series = parse(series_json(*answer.value));
  CHECK(series["monotonic"].GetBool());
  CHECK(series["monotonic_mixed"].GetBool());
  // A gauge says nothing about it.
  FakeDb gauges;
  TestCaches gauge_caches;
  gauges.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  gauges.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "9", "", "0"}});
  const auto gauge = service_over(gauges, gauge_caches).series(context, metrics_host(), "local",
                                                                series_request({{"kind", "gauge"}, {"service", "a"}, {"metric", "b"}, {"start_ms", "60000"}, {"end_ms", "179999"}}));
  CHECK(parse(series_json(*gauge.value))["monotonic_mixed"].IsNull());
}

void test_the_attributes_of_a_metric() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes)))", {{"zeta"}, {"alpha"}, {"mid"}});
  db.on("SELECT v, toString(n) FROM", {{"GET", "10"}, {"POST", "3"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto keys = service.attributes(context, metrics_host(), attributes_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "1000"}, {"end_ms", "9000"}}));
  CHECK(keys);
  // The keys are sorted.
  const auto keys_doc = parse(attributes_json(*keys.value));
  CHECK_EQ(std::string(keys_doc["keys"][0].GetString()), std::string("alpha"));
  CHECK_EQ(std::string(keys_doc["keys"][2].GetString()), std::string("zeta"));
  CHECK(!keys_doc["truncated"].GetBool());
  CHECK(!keys_doc.HasMember("values"));
  CHECK_EQ(db.params.back().size(), size_t(2));
  CHECK_EQ(db.params.back()[0].second, std::string("api"));
  // One key more than the limit. The answer is cut, and it says so.
  FakeDb wide;
  TestCaches wide_caches;
  wide.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  Rows many;
  for (int i = 0; i < 201; ++i) many.push_back({"k" + std::to_string(1000 + i)});
  wide.on("SELECT DISTINCT", many);
  const auto cut = service_over(wide, wide_caches).attributes(context, metrics_host(), attributes_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "1000"}, {"end_ms", "9000"}}));
  const auto cut_doc = parse(attributes_json(*cut.value));
  CHECK_EQ(cut_doc["keys"].Size(), 200u);
  CHECK(cut_doc["truncated"].GetBool());
  // The values of one key, with their points.
  const auto values = service.attributes(context, metrics_host(), attributes_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "1000"}, {"end_ms", "9000"}, {"key", "http.method"}}));
  const auto values_doc = parse(attributes_json(*values.value));
  CHECK_EQ(std::string(values_doc["key"].GetString()), std::string("http.method"));
  CHECK_EQ(values_doc["values"].Size(), 2u);
  CHECK_EQ(std::string(values_doc["values"][0]["value"].GetString()), std::string("GET"));
  CHECK_EQ(values_doc["values"][0]["points"].GetInt64(), 10);
  CHECK(!values_doc.HasMember("keys"));
  // A key that is too long is refused after the table is known.
  const std::string long_key(257, 'k');
  const auto refused = service.attributes(context, metrics_host(), attributes_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "1000"}, {"end_ms", "9000"}, {"key", long_key.c_str()}}));
  CHECK_EQ(refused.error.status, 400);
  CHECK_EQ(refused.error.code, std::string("invalid_metrics_request"));
  CHECK_EQ(refused.error.message, std::string("key is too long."));
}

void test_a_gauge_series_and_its_json() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT any(MetricUnit)", {{"%", "CPU use", "0", "0", "0", "30", ""}});
  // g, bucket, sum, count, min, max, last, series
  // The ranking comes first. It gives the key of the best group, the number of groups, its score, and the sum of the scores.
  // Then it gives the series of the best group and of "other". The group "other" is the group that ClickHouse folds the others into.
  db.on("toString(count() OVER ())", {{"host-b", "2", "10", "14"}});
  db.on("SELECT g, toString(b), toString(sum(s_sum))", {
    {"__other__", "60000", "2", "2", "1", "1", "1", "1"}, {"__other__", "120000", "6", "2", "2", "4", "4", "1"},
    {"host-b", "60000", "30", "3", "10", "10", "10", "1"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto request = series_request({{"kind", "gauge"}, {"service", "api"}, {"metric", "cpu"}, {"start_ms", "60000"}, {"end_ms", "179999"},
                                       {"group_by", "host"}, {"limit", "1"}, {"agg", "max"}});
  const auto answer = service.series(context, metrics_host(), "local", request);
  CHECK(answer);
  CHECK_EQ(db.count("toString(count() OVER ())"), size_t(1));
  CHECK_EQ(db.count("LIMIT 300001"), size_t(1));
  // The series statement reads the kept group by its key, as a parameter.
  CHECK(db.sqls.back().find("IN ({p4:String}), Attributes") != std::string::npos || db.sqls.back().find("IN ({p4:String})") != std::string::npos);
  CHECK_EQ(db.params.back().back().second, std::string("host-b"));
  const auto doc = parse(series_json(*answer.value));
  CHECK_EQ(std::string(doc["kind"].GetString()), std::string("gauge"));
  CHECK_EQ(std::string(doc["unit"].GetString()), std::string("%"));
  CHECK_EQ(std::string(doc["description"].GetString()), std::string("CPU use"));
  CHECK(doc["temporality"].IsNull() && doc["monotonic"].IsNull());
  CHECK_EQ(std::string(doc["agg"].GetString()), std::string("max"));
  CHECK_EQ(std::string(doc["default_agg"].GetString()), std::string("avg"));
  CHECK_EQ(doc["aggs"].Size(), 5u);
  CHECK_EQ(std::string(doc["value_unit"].GetString()), std::string("%"));
  CHECK_EQ(doc["bucket_ms"].GetInt64(), int64_t(10000));
  CHECK_EQ(doc["timestamps"].Size(), 12u);
  CHECK_EQ(doc["group_by"].Size(), 1u);
  CHECK_EQ(doc["series"].Size(), 2u);   // the best group, and the others folded
  CHECK_EQ(std::string(doc["series"][0]["key"].GetString()), std::string("host-b"));
  CHECK_EQ(std::string(doc["series"][0]["labels"]["host"].GetString()), std::string("host-b"));
  CHECK(!doc["series"][0]["other"].GetBool());
  CHECK(doc["series"][1]["other"].GetBool());
  CHECK_EQ(std::string(doc["series"][1]["key"].GetString()), std::string("__other__"));
  CHECK_EQ(doc["series"][1]["labels"].MemberCount(), 0u);
  CHECK_EQ(doc["other_series_count"].GetInt(), 1);
  CHECK_EQ(doc["group_count"].GetInt(), 2);
  // The score of "other" is what the best group leaves of the sum of the scores.
  CHECK_EQ(doc["series"][1]["total"].GetDouble(), 4.0);
  CHECK(doc["truncated"].GetBool());
  CHECK(!doc["truncated_rows"].GetBool());
  CHECK(!doc["per_series"].GetBool());
  CHECK(doc["note"].IsNull());
  // The values by bucket: a bucket that has no point is null.
  const auto& values = doc["series"][0]["values"];
  CHECK_EQ(values.Size(), 12u);
  size_t points = 0;
  for (const auto& value : values.GetArray()) points += value.IsNull() ? 0 : 1;
  CHECK_EQ(points, size_t(1));
  CHECK_EQ(db.params.back()[0].second, std::string("api"));
  CHECK_EQ(db.params.back()[2].second, std::string("host"));
}

void test_the_temporality_and_the_aggregation_of_a_sum() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  // A cumulative, monotonic counter: increases, the default is the rate.
  db.on("SELECT any(MetricUnit)", {{"1", "", "2", "2", "1", "40", ""}});
  db.on("SELECT g, toString(b), toString(sum(d1))", {{"", "60000", "120", "0"}, {"", "120000", "60", "0"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto request = series_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "60000"}, {"end_ms", "179999"}, {"step_ms", "60000"}});
  const auto answer = service.series(context, metrics_host(), "local", request);
  CHECK(answer);
  const auto doc = parse(series_json(*answer.value));
  CHECK_EQ(std::string(doc["temporality"].GetString()), std::string("cumulative"));
  CHECK(doc["monotonic"].GetBool());
  CHECK_EQ(std::string(doc["default_agg"].GetString()), std::string("rate"));
  CHECK_EQ(std::string(doc["value_unit"].GetString()), std::string("1/s"));
  CHECK_EQ(doc["timestamps"].Size(), 2u);
  // A rate divides the delta by the seconds of the bucket that lie in the window: 120 / 60.
  CHECK_EQ(doc["series"][0]["values"][0].GetDouble(), 2.0);
  CHECK(std::fabs(doc["series"][0]["values"][1].GetDouble() - 1.0) < 1e-4);   // the last bucket is cut by the window: 59.999 s
  CHECK_EQ(doc["series"][0]["total"].GetDouble(), 3.0);
  CHECK_EQ(doc["points"].GetInt64(), 40);
  // The statement that reads the buckets takes the differences with the previous point. The scan starts one bucket (at least 15 minutes) before the window.
  CHECK(db.sqls.back().find("lagInFrame") != std::string::npos);
  CHECK(db.sqls.back().find("fromUnixTimestamp64Milli(0)") != std::string::npos);
  // The code refuses an aggregation that the metric does not offer. It refuses it after it reads the information.
  const auto bad = service.series(context, metrics_host(), "local", series_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"},
                                                                                     {"start_ms", "60000"}, {"end_ms", "179999"}, {"agg", "avg"}}));
  CHECK(!bad);
  CHECK_EQ(bad.error.status, 400);
  CHECK_EQ(bad.error.code, std::string("invalid_metrics_request"));
  CHECK_EQ(bad.error.message, std::string("agg must be one of: rate, increase."));
}

void test_a_histogram_series() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT any(MetricUnit)", {{"s", "", "1", "1", "0", "20", ""}});
  // g, bucket, bounds, counts, count, sum
  db.on("SELECT g, toString(b) AS bt, bstr", {{"", "60000", "1,2", "10,10,0", "20", "30"}, {"", "60000", "1,2,4", "0,0,0,5", "5", "40"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto answer = service.series(context, metrics_host(), "local",
                                     series_request({{"kind", "histogram"}, {"service", "api"}, {"metric", "latency"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"agg", "p50"}}));
  CHECK(answer);
  const auto doc = parse(series_json(*answer.value));
  CHECK_EQ(std::string(doc["temporality"].GetString()), std::string("delta"));
  CHECK_EQ(std::string(doc["value_unit"].GetString()), std::string("s"));
  CHECK_EQ(doc["aggs"].Size(), 7u);
  CHECK(!doc["series"][0]["values"][0].IsNull());
  // count_rate and count have their own units.
  const auto count = service.series(context, metrics_host(), "local",
                                    series_request({{"kind", "histogram"}, {"service", "api"}, {"metric", "latency"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"agg", "count"}}));
  CHECK_EQ(std::string(parse(series_json(*count.value))["value_unit"].GetString()), std::string(""));
  CHECK_EQ(parse(series_json(*count.value))["series"][0]["values"][0].GetDouble(), 25.0);
  const auto count_rate = service.series(context, metrics_host(), "local",
                                         series_request({{"kind", "histogram"}, {"service", "api"}, {"metric", "latency"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"agg", "count_rate"}}));
  CHECK_EQ(std::string(parse(series_json(*count_rate.value))["value_unit"].GetString()), std::string("/s"));
}

void test_a_summary_is_read_per_series() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT any(MetricUnit)", {{"ms", "", "0", "0", "0", "9", "0.5,0.99"}});
  db.on("toString(count() OVER ())", {{"22", "2", "9.5", "17"}, {"11", "2", "7.5", "17"}});
  db.on("SELECT toString(sid) AS g, any(attrs)", {{"11", "{\"route\":\"/a\",\"n\":3}", "60000", "7.5"}, {"22", "{\"route\":\"/b\"}", "60000", "9.5"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto answer = service.series(context, metrics_host(), "local",
                                     series_request({{"kind", "summary"}, {"service", "api"}, {"metric", "dur"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"group_by", "route"}}));
  CHECK(answer);
  const auto doc = parse(series_json(*answer.value));
  CHECK_EQ(std::string(doc["default_agg"].GetString()), std::string("p50"));
  CHECK(doc["per_series"].GetBool());
  // A summary is not grouped. The code ignores the group_by and says so.
  CHECK_EQ(doc["group_by"].Size(), 0u);
  CHECK(doc["note"].IsString());
  CHECK_EQ(doc["series"].Size(), 2u);
  CHECK_EQ(std::string(doc["series"][0]["key"].GetString()), std::string("22"));
  // The labels are the attributes of the series. The code leaves out the members that are not texts.
  CHECK_EQ(std::string(doc["series"][1]["labels"]["route"].GetString()), std::string("/a"));
  CHECK(!doc["series"][1]["labels"].HasMember("n"));
  CHECK_EQ(doc["other_series_count"].GetInt(), 0);
  CHECK(db.sqls.back().find("indexOf(`ValueAtQuantiles.Quantile`, 0.5)") != std::string::npos);
  CHECK(db.sqls.back().find("route") == std::string::npos);
}


void test_a_grouped_request_reads_the_groups_that_ClickHouse_ranked() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT any(MetricUnit)", {{"1", "", "2", "2", "1", "10", ""}});
  // 40,000 groups: the ranking keeps the two best groups. It says how many groups there are, and what the sum of their scores is.
  db.on("toString(count() OVER ())", {{"u39999", "40000", "39999", "800000000"}, {"u39998", "40000", "39998", "800000000"}});
  // g, bucket, sum of the deltas, sum of the counts: the two groups and the others.
  db.on("SELECT g, toString(b), toString(sum(d1))", {{"u39999", "60000", "6", "0"}, {"u39998", "60000", "5", "0"}, {"__other__", "60000", "100", "0"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto answer = service.series(context, metrics_host(), "local",
                                     series_request({{"kind", "sum"}, {"service", "api"}, {"metric", "calls"}, {"start_ms", "60000"}, {"end_ms", "119999"},
                                                     {"group_by", "user"}, {"limit", "2"}, {"agg", "increase"}}));
  CHECK(answer);
  CHECK_EQ(answer.value->group_count, size_t(40000));
  CHECK_EQ(answer.value->other_count, size_t(39998));
  CHECK_EQ(answer.value->series.size(), size_t(2));
  CHECK_EQ(answer.value->series[0].key, std::string("u39999"));
  CHECK_EQ(answer.value->other.key, std::string("__other__"));
  CHECK_EQ(answer.value->other.score, 800000000.0 - 39999.0 - 39998.0);
  CHECK(!answer.value->truncated_rows);
  // The statements are: the information, the ranking, and then the series of the kept groups. Their keys are parameters.
  CHECK_EQ(db.count("toString(count() OVER ())"), size_t(1));
  CHECK(db.sqls.back().find("'__other__'") != std::string::npos);
  CHECK_EQ(db.params.back().back().second, std::string("u39998"));
  const auto doc = parse(series_json(*answer.value));
  CHECK_EQ(doc["group_count"].GetInt(), 40000);
  CHECK_EQ(doc["other_series_count"].GetInt(), 39998);
  CHECK(doc["truncated"].GetBool());
  // A failed ranking gives the error of the route (a memory limit).
  FakeDb memory;
  TestCaches memory_caches;
  memory.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  memory.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "1", ""}});
  memory.fail_on("toString(count() OVER ())", [] { throw server_error(241, "Memory limit exceeded"); });
  const auto failed = service_over(memory, memory_caches).series(context, metrics_host(), "local",
      series_request({{"kind", "gauge"}, {"service", "api"}, {"metric", "cpu"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"group_by", "user"}}));
  CHECK_EQ(failed.error.code, std::string("metrics_memory_limit"));
}

void test_the_rows_of_a_series_are_capped() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  db.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "1", ""}});
  // One block has more rows than the cap. The code counts the rest as cut, and the answer says so.
  Rows rows;
  rows.reserve(kMaxSeriesRows + 2);
  for (size_t i = 0; i < kMaxSeriesRows + 2; ++i) rows.push_back({"g" + std::to_string(1000000 + i), "60000", "1", "1", "1", "1", "1", "1"});
  db.on("SELECT g, toString(b), toString(sum(s_sum))", rows);
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto answer = service.series(context, metrics_host(), "local",
                                     series_request({{"kind", "gauge"}, {"service", "api"}, {"metric", "cpu"}, {"start_ms", "60000"}, {"end_ms", "119999"}, {"limit", "3"}}));
  CHECK(answer);
  // No grouping: nothing to rank.
  CHECK_EQ(db.count("toString(count() OVER ())"), size_t(0));
  CHECK(answer.value->truncated_rows);
  CHECK_EQ(answer.value->group_count, kMaxSeriesRows);
  CHECK_EQ(answer.value->series.size(), size_t(3));
  CHECK_EQ(answer.value->other_count, kMaxSeriesRows - 3);
  CHECK(parse(series_json(*answer.value))["truncated_rows"].GetBool());
}

void test_a_failed_series_statement_is_the_error_of_the_route() {
  RequestContext context;
  const auto request = series_request({{"kind", "gauge"}, {"service", "api"}, {"metric", "cpu"}, {"start_ms", "60000"}, {"end_ms", "119999"}});
  FakeDb timeout;
  TestCaches timeout_caches;
  timeout.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  timeout.fail_on("SELECT any(MetricUnit)", [] { throw server_error(159, "Timeout exceeded"); });
  const auto a = service_over(timeout, timeout_caches).series(context, metrics_host(), "local", request);
  CHECK_EQ(a.error.status, 504);
  CHECK_EQ(a.error.code, std::string("metrics_timeout"));
  FakeDb memory;
  TestCaches memory_caches;
  memory.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  memory.on("SELECT any(MetricUnit)", {{"", "", "0", "0", "0", "1", ""}});
  memory.fail_on("SELECT g, toString(b)", [] { throw server_error(241, "Memory limit exceeded"); });
  const auto b = service_over(memory, memory_caches).series(context, metrics_host(), "local", request);
  CHECK_EQ(b.error.status, 422);
  CHECK_EQ(b.error.code, std::string("metrics_memory_limit"));
  FakeDb scan;
  TestCaches scan_caches;
  scan.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  scan.fail_on("SELECT any(MetricUnit)", [] { throw server_error(158, "Too many rows to read"); });
  CHECK_EQ(service_over(scan, scan_caches).series(context, metrics_host(), "local", request).error.code, std::string("metrics_scan_limit"));
  FakeDb other;
  TestCaches other_caches;
  other.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  other.fail_on("SELECT any(MetricUnit)", [] { throw server_error(47, "Unknown identifier"); });
  const auto c = service_over(other, other_caches).series(context, metrics_host(), "local", request);
  CHECK_EQ(c.error.status, 503);
  CHECK_EQ(c.error.code, std::string("metrics_query_failed"));
}

void test_the_exemplars_and_their_json() {
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  // bucket, t, value, trace id, span id, attributes
  db.on("SELECT toString(", {
    {"60000", "90000", "1.5", "aaaa", "bbbb", "{\"k\":\"v\"}"}, {"60000", "70000", "9.5", "cccc", "dddd", "{}"}, {"120000", "130000", "2", "eeee", "ffff", "{\"x\":1}"}});
  const auto service = service_over(db, caches);
  RequestContext context;
  const auto request = exemplars_request({{"kind", "histogram"}, {"service", "api"}, {"metric", "latency"}, {"start_ms", "60000"}, {"end_ms", "179999"}, {"limit", "2"}});
  const auto answer = service.exemplars(context, metrics_host(), "local", request);
  CHECK(answer);
  CHECK(answer.value->truncated);
  CHECK_EQ(answer.value->exemplars.size(), size_t(2));
  const auto doc = parse(exemplars_json(*answer.value));
  CHECK_EQ(doc["exemplars"].Size(), 2u);
  // Oldest first, after the cut to the limit.
  CHECK_EQ(doc["exemplars"][0]["t"].GetInt64(), 70000);
  CHECK_EQ(doc["exemplars"][1]["t"].GetInt64(), 90000);
  CHECK_EQ(std::string(doc["exemplars"][1]["trace_id"].GetString()), std::string("aaaa"));
  CHECK_EQ(doc["exemplars"][0]["attributes"].MemberCount(), 0u);
  CHECK_EQ(std::string(doc["exemplars"][1]["attributes"]["k"].GetString()), std::string("v"));
  CHECK_EQ(doc["per_bucket"].GetInt64(), 3);
  CHECK(doc["truncated"].GetBool());
  CHECK(doc["traces_enabled"].GetBool());
  CHECK_EQ(doc["bucket_ms"].GetInt64(), int64_t(10000));
  CHECK_EQ(db.sqls.back().find("LIMIT 3 BY b LIMIT 3 SETTINGS") != std::string::npos, true);
  // Traces are turned off for the host. The exemplars say so.
  HostSpec off = metrics_host();
  off.otel.traces.enabled = false;
  FakeDb quiet;
  TestCaches quiet_caches;
  quiet.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  const auto none = service_over(quiet, quiet_caches).exemplars(context, off, "local", request);
  CHECK(none);
  CHECK(!parse(exemplars_json(*none.value))["traces_enabled"].GetBool());
  CHECK_EQ(parse(exemplars_json(*none.value))["exemplars"].Size(), 0u);
}

void test_the_allowlist_is_in_every_statement() {
  HostSpec host = metrics_host();
  host.otel.traces.service_allowlist = {"api", "web"};
  FakeDb db;
  TestCaches caches;
  db.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  const auto service = service_over(db, caches);
  RequestContext context;
  CatalogRequest catalog;
  catalog.window = TimeWindow{1000, 2000};
  CHECK(service.catalog(context, host, "local", catalog));
  CHECK(service.attributes(context, host, attributes_request({{"kind", "sum"}, {"service", "api"}, {"metric", "c"}, {"start_ms", "1000"}, {"end_ms", "9000"}})));
  CHECK(service.series(context, host, "local", series_request({{"kind", "gauge"}, {"service", "api"}, {"metric", "c"}, {"start_ms", "1000"}, {"end_ms", "9000"}})));
  CHECK(service.exemplars(context, host, "local", exemplars_request({{"kind", "sum"}, {"service", "api"}, {"metric", "c"}, {"start_ms", "1000"}, {"end_ms", "9000"}})));
  size_t with_filter = 0;
  for (const auto& sql : db.sqls) with_filter += sql.find("ServiceName IN") != std::string::npos || sql.find("ServiceName =") != std::string::npos;
  CHECK(with_filter >= 5);
  // The code does not share the catalog of a restricted source with a source that has no restriction.
  TestCaches shared;
  FakeDb a, b;
  a.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  b.on("FROM system.tables WHERE database = 'otel'", kAllKinds);
  const auto restricted = service_over(a, shared).catalog(context, host, "local", catalog);
  const auto open = service_over(b, shared).catalog(context, metrics_host(), "local", catalog);
  CHECK(restricted && !restricted.value->hit);
  CHECK(open && !open.value->hit);
}

}  // namespace

int main() {
  RUN(test_the_window_of_the_routes);
  RUN(test_the_fields_of_a_request);
  RUN(test_the_bucket_grid);
  RUN(test_the_catalog_statements_are_unchanged);
  RUN(test_the_attribute_statements_are_unchanged);
  RUN(test_the_series_statements_are_unchanged);
  RUN(test_the_ranking_statements_are_the_ones_that_were_sent);
  RUN(test_the_exemplars_statement_is_unchanged);
  RUN(test_a_series_is_told_apart_by_its_scope_when_the_table_has_one);
  RUN(test_the_merge_of_histograms_does_not_depend_on_the_order_of_the_rows);
  RUN(test_the_service_tells_series_apart_by_their_scope);
  RUN(test_monotonic_is_said_to_be_mixed);
  RUN(test_explicit_quantiles);
  RUN(test_exponential_quantiles);
  RUN(test_cells_merge);
  RUN(test_the_values_of_a_cell);
  RUN(test_the_names_of_the_quantiles);
  RUN(test_the_aggregations_that_a_metric_offers);
  RUN(test_rows_become_groups_and_the_best_groups_are_kept);
  RUN(test_exponential_and_summary_rows);
  RUN(test_text_from_clickhouse);
  RUN(test_the_service_cannot_connect);
  RUN(test_the_catalog_and_its_json);
  RUN(test_the_catalog_is_bounded_and_says_so);
  RUN(test_a_source_without_tables_says_so);
  RUN(test_a_failure_of_the_catalog_is_the_error_of_the_route);
  RUN(test_the_table_of_a_kind_may_be_missing_or_not_readable);
  RUN(test_the_attributes_of_a_metric);
  RUN(test_a_gauge_series_and_its_json);
  RUN(test_the_temporality_and_the_aggregation_of_a_sum);
  RUN(test_a_histogram_series);
  RUN(test_a_summary_is_read_per_series);
  RUN(test_a_grouped_request_reads_the_groups_that_ClickHouse_ranked);
  RUN(test_the_rows_of_a_series_are_capped);
  RUN(test_a_failed_series_statement_is_the_error_of_the_route);
  RUN(test_the_exemplars_and_their_json);
  RUN(test_the_allowlist_is_in_every_statement);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
