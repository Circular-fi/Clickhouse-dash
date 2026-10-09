// OpenTelemetry metrics browser: catalog, attribute keys/values, bucketed
// series and exemplars over the ClickHouse exporter tables
// <database>.<table_prefix>_{gauge,sum,histogram,exponential_histogram,summary}.
//
// Every query filters on the table's primary-key prefix (ServiceName,
// MetricName) and PREWHEREs the TimeUnix window, so a request reads only the
// granules of one metric (or, for the catalog, of the window). Counter
// increases, histogram bucket differences, quantile interpolation, exponential
// bucket merging and the top-K + "other" folding are documented in
// docs/metrics.md ("Metrics browser API").
#include "server.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "otel_allowlist.hpp"

#include <clickhouse/client.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {
namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;
using Clock = std::chrono::steady_clock;

constexpr int64_t kMaxRangeMs = 90LL * 24 * 60 * 60 * 1000;
constexpr size_t kCatalogLimit = 5000;
constexpr auto kCatalogTtl = std::chrono::seconds(60);
constexpr size_t kCatalogCacheMaxEntries = 256;
constexpr size_t kAttributeKeyLimit = 200;
constexpr size_t kAttributeValueLimit = 100;
constexpr size_t kMaxSeriesRows = 300000;
constexpr size_t kMaxGroupBy = 5;
constexpr int kDefaultTopK = 20;
constexpr int kMaxTopK = 50;
constexpr int64_t kLagLookbackMinMs = 15 * 60 * 1000;
constexpr const char* kQuerySettings = " SETTINGS max_execution_time = 30";
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

const char* const kKinds[] = {"gauge", "sum", "histogram", "exponential_histogram", "summary"};

struct BadRequest : std::runtime_error {
  using std::runtime_error::runtime_error;
};

struct NotFound : std::runtime_error {
  NotFound(std::string c, const std::string& message) : std::runtime_error(message), code(std::move(c)) {}
  std::string code;
};

std::string quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

int64_t elapsed_ms(Clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - since).count();
}

double text_to_double(const std::string& text) {
  if (text.empty()) return kNaN;
  if (text == "nan" || text == "-nan") return kNaN;
  if (text == "inf" || text == "+inf") return std::numeric_limits<double>::infinity();
  if (text == "-inf") return -std::numeric_limits<double>::infinity();
  char* end = nullptr;
  const double value = std::strtod(text.c_str(), &end);
  return end == text.c_str() ? kNaN : value;
}

int64_t text_to_i64(const std::string& text) {
  if (text.empty()) return 0;
  char* end = nullptr;
  const long long value = std::strtoll(text.c_str(), &end, 10);
  return end == text.c_str() ? 0 : static_cast<int64_t>(value);
}

std::vector<double> text_to_doubles(const std::string& text) {
  std::vector<double> out;
  if (text.empty()) return out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != ',') continue;
    out.push_back(text_to_double(text.substr(start, i - start)));
    start = i + 1;
  }
  return out;
}

// Splits on a delimiter, keeping empty fields (an absent attribute is "").
std::vector<std::string> split_keep(std::string_view text, char delimiter) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != delimiter) continue;
    out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

void write_number(JsonWriter& w, double value) {
  if (std::isfinite(value)) w.Double(value);
  else w.Null();
}

void write_str(JsonWriter& w, const std::string& value) {
  w.String(value.data(), static_cast<rapidjson::SizeType>(value.size()));
}

void send_json(httplib::Response& res, const std::string& body) {
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body, "application/json");
}

// ---------------------------------------------------------------------------
// Request parsing.

std::string param(const httplib::Request& req, const char* name) {
  return req.has_param(name) ? req.get_param_value(name) : std::string{};
}

bool parse_i64_param(const httplib::Request& req, const char* name, int64_t* out) {
  const std::string text = param(req, name);
  if (text.empty()) return false;
  char* end = nullptr;
  const long long value = std::strtoll(text.c_str(), &end, 10);
  if (end == text.c_str() || *end != '\0') return false;
  *out = static_cast<int64_t>(value);
  return true;
}

struct TimeWindow {
  int64_t start_ms = 0;
  int64_t end_ms = 0;
};

TimeWindow parse_window(const httplib::Request& req) {
  TimeWindow window;
  if (!parse_i64_param(req, "start_ms", &window.start_ms) || !parse_i64_param(req, "end_ms", &window.end_ms)) {
    throw BadRequest("start_ms and end_ms (milliseconds) are required.");
  }
  constexpr int64_t kMaxTimeMs = INT64_MAX / 1000000 - 1;
  if (window.start_ms < 0 || window.end_ms <= window.start_ms || window.end_ms > kMaxTimeMs) {
    throw BadRequest("Invalid metrics time range.");
  }
  if (window.end_ms - window.start_ms > kMaxRangeMs) {
    throw BadRequest("Metrics time range exceeds 90 days.");
  }
  return window;
}

std::string required(const httplib::Request& req, const char* name) {
  std::string value = param(req, name);
  if (value.empty()) throw BadRequest(std::string(name) + " is required.");
  if (value.size() > 1024) throw BadRequest(std::string(name) + " is too long.");
  return value;
}

std::string parse_kind(const httplib::Request& req) {
  const std::string kind = required(req, "kind");
  for (const char* k : kKinds) {
    if (kind == k) return kind;
  }
  throw BadRequest("kind must be gauge, sum, histogram, exponential_histogram or summary.");
}

struct AttributeFilter {
  std::string key;
  std::string op;  // "=" or "!="
  std::string value;
};

std::vector<AttributeFilter> parse_filters(const httplib::Request& req) {
  std::vector<AttributeFilter> out;
  for (const auto& [name, op] : {std::pair<const char*, const char*>{"filter", "="}, {"filter_not", "!="}}) {
    const auto range = req.params.equal_range(name);
    for (auto it = range.first; it != range.second; ++it) {
      const std::string& text = it->second;
      if (text.empty()) continue;
      const size_t eq = text.find('=');
      if (eq == std::string::npos || eq == 0) throw BadRequest(std::string(name) + " must be key=value.");
      if (text.size() > 2048) throw BadRequest(std::string(name) + " is too long.");
      out.push_back(AttributeFilter{text.substr(0, eq), op, text.substr(eq + 1)});
    }
  }
  if (out.size() > 32) throw BadRequest("Too many attribute filters (max 32).");
  return out;
}

// Same key and operator: "=" values become IN (OR), "!=" values NOT IN.
std::string filters_sql(const std::vector<AttributeFilter>& filters, const std::string& skip_key = {}) {
  std::map<std::pair<std::string, std::string>, std::vector<std::string>> grouped;
  for (const auto& f : filters) {
    if (!skip_key.empty() && f.key == skip_key) continue;
    grouped[{f.key, f.op}].push_back(f.value);
  }
  std::string out;
  for (const auto& [key_op, values] : grouped) {
    std::string list;
    for (size_t i = 0; i < values.size(); ++i) {
      if (i) list += ", ";
      list += quote_string(values[i]);
    }
    out += " AND Attributes[" + quote_string(key_op.first) + "] " + (key_op.second == "=" ? "IN (" : "NOT IN (") + list + ")";
  }
  return out;
}

std::vector<std::string> parse_group_by(const httplib::Request& req) {
  std::vector<std::string> out;
  for (auto& key : split_keep(param(req, "group_by"), ',')) {
    if (key.empty()) continue;
    if (key.size() > 256) throw BadRequest("group_by key is too long.");
    if (std::find(out.begin(), out.end(), key) == out.end()) out.push_back(key);
  }
  if (out.size() > kMaxGroupBy) throw BadRequest("group_by accepts at most 5 attribute keys.");
  return out;
}

// ---------------------------------------------------------------------------
// Connection and table existence.

const HostSpec* metrics_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id = param(req, "host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_host(cfg.hosts, id);
}

std::shared_ptr<clickhouse::Client> acquire_metrics_client(
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = "OTel metrics require system credentials for the selected host.";
    return nullptr;
  }
  // (connect, receive, send): aggregations over wide windows may stay silent
  // for a while before the first block.
  const auto connect_timeout = std::chrono::seconds(5);
  const auto receive_timeout = std::chrono::seconds(60);
  const auto send_timeout = std::chrono::seconds(15);
  return pool
      ? pool->acquire(host.system_uri, connect_timeout, receive_timeout, send_timeout, error)
      : make_client_from_uri(host.system_uri, connect_timeout, receive_timeout, send_timeout, error);
}

struct KindTablesEntry {
  std::set<std::string> kinds;
  Clock::time_point loaded_at;
};

std::mutex g_kind_tables_mutex;
std::unordered_map<std::string, KindTablesEntry> g_kind_tables;

// Kinds whose table exists (one system.tables read, cached like the catalog).
std::set<std::string> existing_kinds(clickhouse::Client& client, const HostSpec& host, const MetricSettings& metrics) {
  const std::string key = host.system_uri + '\x1f' + metrics.database + '\x1f' + metrics.table_prefix;
  {
    std::lock_guard<std::mutex> lock(g_kind_tables_mutex);
    const auto it = g_kind_tables.find(key);
    if (it != g_kind_tables.end() && Clock::now() - it->second.loaded_at < kCatalogTtl) return it->second.kinds;
  }
  std::string names = "(";
  for (size_t i = 0; i < std::size(kKinds); ++i) {
    if (i) names += ", ";
    names += quote_string(metrics.table_prefix + "_" + kKinds[i]);
  }
  names += ")";
  std::set<std::string> tables;
  client.Select("SELECT toString(name) FROM system.tables WHERE database = " + quote_string(metrics.database) +
                    " AND name IN " + names,
                [&](const clickhouse::Block& block) {
                  for (size_t row = 0; row < block.GetRowCount(); ++row) tables.insert(ch_block_text_at(block, 0, row));
                });
  std::set<std::string> kinds;
  for (const char* kind : kKinds) {
    if (tables.count(metrics.table_prefix + "_" + kind)) kinds.insert(kind);
  }
  std::lock_guard<std::mutex> lock(g_kind_tables_mutex);
  if (g_kind_tables.size() >= kCatalogCacheMaxEntries) g_kind_tables.clear();
  g_kind_tables[key] = KindTablesEntry{kinds, Clock::now()};
  return kinds;
}

std::string kind_table(const MetricSettings& metrics, const std::string& kind) {
  return quote_ident(metrics.database) + "." + quote_ident(metrics.table_prefix + "_" + kind);
}

std::string time_predicate(int64_t start_ms, int64_t end_ms) {
  return "TimeUnix >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND TimeUnix <= fromUnixTimestamp64Milli(" +
         std::to_string(end_ms) + ")";
}

std::string metric_predicate(const std::string& service, const std::string& metric, int64_t start_ms, int64_t end_ms) {
  return "ServiceName = " + quote_string(service) + " AND MetricName = " + quote_string(metric) + " AND " +
         time_predicate(start_ms, end_ms);
}

// ---------------------------------------------------------------------------
// Buckets: ~60-120 per window on a grid anchored at the browser's midnight.

struct BucketGrid {
  int64_t size_ms = 60000;
  int64_t origin_ms = 0;  // bucket_origin_ms mod size

  int64_t floor(int64_t t) const {
    const int64_t offset = t - origin_ms;
    return origin_ms + (offset >= 0 ? offset / size_ms : -((-offset + size_ms - 1) / size_ms)) * size_ms;
  }

  std::string sql(const std::string& column) const {
    return std::to_string(origin_ms) + " + intDiv(toUnixTimestamp64Milli(" + column + ") - " + std::to_string(origin_ms) +
           ", " + std::to_string(size_ms) + ") * " + std::to_string(size_ms);
  }
};

BucketGrid choose_grid(const httplib::Request& req, const TimeWindow& window) {
  const int64_t range_ms = window.end_ms - window.start_ms;
  static const int64_t kCandidates[] = {10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
                                        86400, 172800, 604800};
  BucketGrid grid;
  grid.size_ms = kCandidates[std::size(kCandidates) - 1] * 1000;
  for (int64_t seconds : kCandidates) {
    if (seconds * 1000 * 120 >= range_ms) {
      grid.size_ms = seconds * 1000;
      break;
    }
  }
  int64_t step_ms = 0;
  if (parse_i64_param(req, "step_ms", &step_ms) && step_ms > 0) {
    const int64_t min_step = std::max<int64_t>(1000, (range_ms + 999) / 1000);
    grid.size_ms = std::max(min_step, std::min(step_ms, std::max<int64_t>(range_ms, 1000)));
  }
  int64_t origin = 0;
  parse_i64_param(req, "bucket_origin_ms", &origin);
  grid.origin_ms = ((origin % grid.size_ms) + grid.size_ms) % grid.size_ms;
  return grid;
}

// ---------------------------------------------------------------------------
// Per (group, bucket) aggregation state. One struct covers every kind: the
// fields a mode does not use stay at their neutral value.

struct ExpState {
  bool present = false;
  int scale = 0;
  std::map<int64_t, double> positive;  // absolute bucket index -> count
  std::map<int64_t, double> negative;
  double zero = 0;
};

struct Cell {
  double sum = 0;      // gauge: sum of values; sums: sum of deltas; histograms/summary: Sum delta
  double count = 0;    // gauge: number of points; histograms/summary: Count delta
  double min = std::numeric_limits<double>::infinity();
  double max = -std::numeric_limits<double>::infinity();
  double last_sum = 0; // sum over series of each series' last value
  double series = 0;   // number of series contributing a last value
  std::vector<double> bounds;  // explicit histogram
  std::vector<double> counts;
  ExpState exp;
};

int64_t floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
  return q;
}

void downscale(ExpState& state, int scale) {
  if (!state.present || scale >= state.scale) return;
  const int64_t factor = int64_t{1} << std::min(62, state.scale - scale);
  for (auto* buckets : {&state.positive, &state.negative}) {
    std::map<int64_t, double> next;
    for (const auto& [index, count] : *buckets) next[floor_div(index, factor)] += count;
    buckets->swap(next);
  }
  state.scale = scale;
}

void merge_exp(ExpState& into, ExpState from) {
  if (!from.present) return;
  if (!into.present) {
    into = std::move(from);
    return;
  }
  const int scale = std::min(into.scale, from.scale);
  downscale(into, scale);
  downscale(from, scale);
  for (const auto& [index, count] : from.positive) into.positive[index] += count;
  for (const auto& [index, count] : from.negative) into.negative[index] += count;
  into.zero += from.zero;
}

// Adds explicit-bucket counts. Rows with other bounds are re-bucketed: each
// source bucket's count goes to the target bucket holding its upper bound.
void merge_hist(Cell& into, const std::vector<double>& bounds, const std::vector<double>& counts) {
  if (counts.empty()) return;
  if (into.counts.empty()) {
    into.bounds = bounds;
    into.counts.assign(std::max(counts.size(), bounds.size() + 1), 0.0);
  }
  if (bounds == into.bounds) {
    if (counts.size() > into.counts.size()) into.counts.resize(counts.size(), 0.0);
    for (size_t i = 0; i < counts.size(); ++i) into.counts[i] += counts[i];
    return;
  }
  for (size_t i = 0; i < counts.size(); ++i) {
    const double upper = i < bounds.size() ? bounds[i] : std::numeric_limits<double>::infinity();
    size_t target = into.bounds.size();
    for (size_t j = 0; j < into.bounds.size(); ++j) {
      if (into.bounds[j] >= upper) {
        target = j;
        break;
      }
    }
    if (target >= into.counts.size()) into.counts.resize(target + 1, 0.0);
    into.counts[target] += counts[i];
  }
}

void merge_cell(Cell& into, const Cell& from) {
  into.sum += from.sum;
  into.count += from.count;
  into.min = std::min(into.min, from.min);
  into.max = std::max(into.max, from.max);
  into.last_sum += from.last_sum;
  into.series += from.series;
  merge_hist(into, from.bounds, from.counts);
  merge_exp(into.exp, from.exp);
}

// Prometheus histogram_quantile: the bucket holding rank q * total, linear
// inside it; the first bucket starts at 0 when its upper bound is positive,
// and a rank in the +Inf bucket answers the largest finite bound.
double explicit_quantile(double q, const std::vector<double>& bounds, const std::vector<double>& counts) {
  double total = 0;
  for (double c : counts) total += std::max(0.0, c);
  if (!(total > 0) || bounds.empty()) return kNaN;
  const double rank = q * total;
  double cumulative = 0;
  for (size_t i = 0; i < counts.size(); ++i) {
    const double c = std::max(0.0, counts[i]);
    if (c > 0 && cumulative + c >= rank) {
      if (i >= bounds.size()) return bounds.back();
      const double upper = bounds[i];
      if (i == 0 && upper <= 0) return upper;
      const double lower = i == 0 ? 0.0 : bounds[i - 1];
      return lower + (upper - lower) * (rank - cumulative) / c;
    }
    cumulative += c;
  }
  return bounds.back();
}

// Exponential buckets: index k covers (base^k, base^(k+1)] with
// base = 2^(2^-scale); negative buckets mirror them; linear inside a bucket.
double exp_bound(int64_t index, int scale) {
  return std::exp2(std::ldexp(static_cast<double>(index), -scale));
}

double exponential_quantile(double q, const ExpState& state) {
  struct Range { double lower, upper, count; };
  std::vector<Range> ranges;
  for (auto it = state.negative.rbegin(); it != state.negative.rend(); ++it) {
    if (it->second > 0) ranges.push_back({-exp_bound(it->first + 1, state.scale), -exp_bound(it->first, state.scale), it->second});
  }
  if (state.zero > 0) ranges.push_back({0.0, 0.0, state.zero});
  for (const auto& [index, count] : state.positive) {
    if (count > 0) ranges.push_back({exp_bound(index, state.scale), exp_bound(index + 1, state.scale), count});
  }
  double total = 0;
  for (const auto& r : ranges) total += r.count;
  if (!(total > 0)) return kNaN;
  const double rank = q * total;
  double cumulative = 0;
  for (const auto& r : ranges) {
    if (cumulative + r.count >= rank) return r.lower + (r.upper - r.lower) * (rank - cumulative) / r.count;
    cumulative += r.count;
  }
  return ranges.back().upper;
}

enum class Mode { Gauge, Delta, Histogram, Exponential, SummaryQuantile, SummaryDelta };

double quantile_of(const std::string& agg) {
  // "p50" -> 0.5, "p99.9" -> 0.999
  return text_to_double(agg.substr(1)) / 100.0;
}

bool is_quantile_agg(const std::string& agg) {
  return agg.size() > 1 && agg[0] == 'p' && std::isfinite(text_to_double(agg.substr(1)));
}

double cell_value(const Cell& cell, Mode mode, const std::string& agg, double bucket_seconds) {
  switch (mode) {
    case Mode::Gauge:
      if (agg == "avg") return cell.count > 0 ? cell.sum / cell.count : kNaN;
      if (agg == "min") return cell.count > 0 ? cell.min : kNaN;
      if (agg == "max") return cell.count > 0 ? cell.max : kNaN;
      if (agg == "last") return cell.series > 0 ? cell.last_sum / cell.series : kNaN;
      if (agg == "sum") return cell.series > 0 ? cell.last_sum : kNaN;
      return kNaN;
    case Mode::Delta:
      if (agg == "rate") return cell.sum / bucket_seconds;
      return cell.sum;  // increase / sum
    case Mode::SummaryQuantile:
      return cell.series > 0 ? cell.last_sum / cell.series : kNaN;
    case Mode::Histogram:
    case Mode::Exponential:
    case Mode::SummaryDelta:
      if (agg == "avg") return cell.count > 0 ? cell.sum / cell.count : kNaN;
      if (agg == "count") return cell.count;
      if (agg == "count_rate") return cell.count / bucket_seconds;
      if (is_quantile_agg(agg)) {
        return mode == Mode::Exponential ? exponential_quantile(quantile_of(agg), cell.exp)
                                         : explicit_quantile(quantile_of(agg), cell.bounds, cell.counts);
      }
      return kNaN;
  }
  return kNaN;
}

// Summary quantile names: 0.5 -> "p50", 0.999 -> "p99.9", 1 -> "p100".
std::string quantile_agg_name(double q) {
  char buffer[64];
  std::snprintf(buffer, sizeof(buffer), "%.6f", q * 100.0);
  std::string text = buffer;
  if (text.find('.') != std::string::npos) {
    while (!text.empty() && text.back() == '0') text.pop_back();
    if (!text.empty() && text.back() == '.') text.pop_back();
  }
  return "p" + text;
}

struct Group {
  std::string key;
  std::string labels_json;  // summary per-series: toJSONString(Attributes)
  std::map<int64_t, Cell> cells;
  double score = 0;
};

// ---------------------------------------------------------------------------
// Metric information (one small aggregation on the primary-key prefix).

struct MetricInfo {
  std::string unit;
  std::string description;
  int64_t temporality_min = 0;
  int64_t temporality_max = 0;
  bool monotonic = false;
  int64_t points = 0;
  std::vector<std::string> quantiles;  // summary: textual quantile values ("0.5")
};

std::string temporality_name(const MetricInfo& info) {
  if (info.points == 0 || info.temporality_max == 0) return {};
  if (info.temporality_min == info.temporality_max) {
    if (info.temporality_min == 1) return "delta";
    if (info.temporality_min == 2) return "cumulative";
    return {};
  }
  return "mixed";
}

MetricInfo load_metric_info(clickhouse::Client& client, const std::string& table, const std::string& kind,
                            const std::string& prewhere, const std::string& where, int64_t* query_ms) {
  const bool has_temporality = kind == "sum" || kind == "histogram" || kind == "exponential_histogram";
  const std::string sql =
      "SELECT any(MetricUnit), any(MetricDescription), " +
      std::string(has_temporality ? "toString(min(AggregationTemporality)), toString(max(AggregationTemporality)), "
                                  : "'0', '0', ") +
      std::string(kind == "sum" ? "toString(max(toUInt8(IsMonotonic))), " : "'0', ") + "toString(count()), " +
      std::string(kind == "summary"
                      ? "arrayStringConcat(arrayMap(x -> toString(x), arraySort(groupUniqArrayArray(`ValueAtQuantiles.Quantile`))), ',')"
                      : "''") +
      " FROM " + table + " PREWHERE " + prewhere + " WHERE " + where + kQuerySettings;
  MetricInfo info;
  const auto started = Clock::now();
  client.Select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      info.unit = ch_block_text_at(block, 0, row);
      info.description = ch_block_text_at(block, 1, row);
      info.temporality_min = text_to_i64(ch_block_text_at(block, 2, row));
      info.temporality_max = text_to_i64(ch_block_text_at(block, 3, row));
      info.monotonic = ch_block_text_at(block, 4, row) == "1";
      info.points = text_to_i64(ch_block_text_at(block, 5, row));
      for (auto& q : split_keep(ch_block_text_at(block, 6, row), ',')) {
        if (!q.empty() && std::isfinite(text_to_double(q))) info.quantiles.push_back(q);
      }
    }
  });
  *query_ms += elapsed_ms(started);
  return info;
}

// ---------------------------------------------------------------------------
// Catalog cache (serialized bodies).

struct CatalogCacheEntry {
  std::string body;
  Clock::time_point loaded_at;
};

std::mutex g_catalog_mutex;
std::unordered_map<std::string, CatalogCacheEntry> g_catalog_cache;

// The cached catalog body has no timing: each answer reports its own (a hit
// spends no query time).
std::string with_cache_status(const std::string& body, bool hit, int64_t age_ms, int64_t query_ms, int64_t total_ms) {
  std::string out = body;
  if (!out.empty() && out.back() == '}') out.pop_back();
  out += ",\"timing_ms\":{\"query\":" + std::to_string(query_ms) + ",\"total\":" + std::to_string(total_ms) + "}";
  out += ",\"cache\":{\"hit\":";
  out += hit ? "true" : "false";
  out += ",\"age_ms\":" + std::to_string(age_ms);
  out += ",\"ttl_ms\":" + std::to_string(std::chrono::duration_cast<std::chrono::milliseconds>(kCatalogTtl).count());
  out += "}}";
  return out;
}

template <typename Fn>
void run_guarded(httplib::Response& res, Fn&& fn) {
  try {
    fn();
  } catch (const BadRequest& e) {
    json_error(res, 400, "invalid_metrics_request", e.what());
  } catch (const NotFound& e) {
    json_error(res, 404, e.code, e.what());
  } catch (const std::exception& e) {
    json_error(res, 503, "metrics_query_failed", e.what());
  }
}

struct MetricsContext {
  const HostSpec* host = nullptr;
  std::string host_id;
  std::shared_ptr<clickhouse::Client> client;
};

// Resolves the host and connects; answers the error itself when it fails.
bool open_context(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool,
                  const httplib::Request& req, httplib::Response& res, MetricsContext* ctx) {
  ctx->host = metrics_host(cfg, req, &ctx->host_id);
  if (!ctx->host) {
    json_error(res, 404, "unknown_host", "Metrics source host is not configured.");
    return false;
  }
  std::string error;
  ctx->client = acquire_metrics_client(*ctx->host, pool, &error);
  if (!ctx->client) {
    json_error(res, 503, "metrics_source_unavailable",
               error.empty() ? "Cannot connect to the metrics ClickHouse source." : error);
    return false;
  }
  return true;
}

void require_kind_table(clickhouse::Client& client, const HostSpec& host, const MetricSettings& metrics,
                        const std::string& kind) {
  if (!existing_kinds(client, host, metrics).count(kind)) {
    throw NotFound("metrics_table_missing", "Table " + metrics.database + "." + metrics.table_prefix + "_" + kind +
                                                " does not exist on this host.");
  }
}

void write_timing(JsonWriter& w, int64_t query_ms, Clock::time_point started) {
  w.Key("timing_ms");
  w.StartObject();
  w.Key("query"); w.Int64(query_ms);
  w.Key("total"); w.Int64(elapsed_ms(started));
  w.EndObject();
}

}  // namespace

// ---------------------------------------------------------------------------
// GET /api/metrics/catalog

void Server::handle_metrics_catalog(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  TimeWindow window;
  try {
    window = parse_window(req);
  } catch (const BadRequest& e) {
    return json_error(res, 400, "invalid_metrics_range", e.what());
  }
  std::string host_id;
  const HostSpec* host = metrics_host(cfg_, req, &host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Metrics source host is not configured.");

  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  // The answer names the host (source_host_id): hosts that share an identity do not share it.
  const std::string key = host_id + '\x1f' + host->system_uri + '\x1f' + cfg_.metrics.database + '\x1f' + cfg_.metrics.table_prefix + '\x1f' +
                          visibility + '\x1f' + std::to_string(window.start_ms / 60000) + '\x1f' +
                          std::to_string(window.end_ms / 60000);
  const bool refresh = param(req, "refresh") == "1" || param(req, "refresh") == "true";
  if (!refresh) {
    std::lock_guard<std::mutex> lock(g_catalog_mutex);
    const auto it = g_catalog_cache.find(key);
    if (it != g_catalog_cache.end()) {
      const auto age = Clock::now() - it->second.loaded_at;
      if (age < kCatalogTtl) {
        return send_json(res, with_cache_status(it->second.body, true,
                                                std::chrono::duration_cast<std::chrono::milliseconds>(age).count(),
                                                0, elapsed_ms(started)));
      }
    }
  }

  std::string error;
  auto client = acquire_metrics_client(*host, client_pool_, &error);
  if (!client) {
    return json_error(res, 503, "metrics_source_unavailable",
                      error.empty() ? "Cannot connect to the metrics ClickHouse source." : error);
  }

  run_guarded(res, [&] {
    int64_t query_ms = 0;
    const auto kinds_started = Clock::now();
    const std::set<std::string> kinds = existing_kinds(*client, *host, cfg_.metrics);
    query_ms += elapsed_ms(kinds_started);

    struct Entry {
      std::string kind, metric, unit, description, temporality;
      int monotonic = -1;  // -1 = not a sum
      int64_t points = 0;
    };
    std::map<std::string, std::vector<Entry>> services;
    size_t rows = 0;
    bool truncated = false;

    std::vector<std::string> branches;
    const std::string window_sql = time_predicate(window.start_ms, window.end_ms);
    for (const char* kind : kKinds) {
      if (!kinds.count(kind)) continue;
      const std::string k = kind;
      const bool has_temporality = k == "sum" || k == "histogram" || k == "exponential_histogram";
      branches.push_back(
          "SELECT '" + k + "' AS kind, toString(ServiceName) AS service, MetricName AS metric, any(MetricUnit) AS unit, "
          "any(MetricDescription) AS description, " +
          (has_temporality ? std::string("toString(min(AggregationTemporality)) AS tmin, toString(max(AggregationTemporality)) AS tmax, ")
                           : std::string("'' AS tmin, '' AS tmax, ")) +
          (k == "sum" ? std::string("toString(min(toUInt8(IsMonotonic))) AS mono_min, toString(max(toUInt8(IsMonotonic))) AS mono_max, ")
                      : std::string("'' AS mono_min, '' AS mono_max, ")) +
          "toString(count()) AS points FROM " + kind_table(cfg_.metrics, k) + " PREWHERE " + window_sql + " WHERE " +
          visibility + " GROUP BY ServiceName, MetricName");
    }
    if (!branches.empty()) {
      std::string sql = "SELECT kind, service, metric, unit, description, tmin, tmax, mono_min, mono_max, points FROM (";
      for (size_t i = 0; i < branches.size(); ++i) {
        if (i) sql += " UNION ALL ";
        sql += branches[i];
      }
      sql += ") ORDER BY service, metric, kind LIMIT " + std::to_string(kCatalogLimit + 1) + kQuerySettings;
      const auto query_started = Clock::now();
      client->Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          if (rows >= kCatalogLimit) {
            truncated = true;
            continue;
          }
          ++rows;
          Entry e;
          e.kind = ch_block_text_at(block, 0, row);
          const std::string service = ch_block_text_at(block, 1, row);
          e.metric = ch_block_text_at(block, 2, row);
          e.unit = ch_block_text_at(block, 3, row);
          e.description = ch_block_text_at(block, 4, row);
          const std::string tmin = ch_block_text_at(block, 5, row);
          const std::string tmax = ch_block_text_at(block, 6, row);
          if (!tmin.empty()) {
            if (tmin != tmax) e.temporality = "mixed";
            else if (tmin == "1") e.temporality = "delta";
            else if (tmin == "2") e.temporality = "cumulative";
          }
          const std::string mono_max = ch_block_text_at(block, 8, row);
          if (!mono_max.empty()) e.monotonic = mono_max == "1" ? 1 : 0;
          e.points = text_to_i64(ch_block_text_at(block, 9, row));
          services[service].push_back(std::move(e));
        }
      });
      query_ms += elapsed_ms(query_started);
    }

    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("v"); w.Int(1);
    w.Key("source_host_id"); write_str(w, host_id);
    w.Key("range"); w.StartArray(); w.Int64(window.start_ms); w.Int64(window.end_ms); w.EndArray();
    w.Key("services");
    w.StartArray();
    for (const auto& [service, entries] : services) {
      w.StartObject();
      w.Key("name"); write_str(w, service);
      w.Key("metrics");
      w.StartArray();
      for (const auto& e : entries) {
        w.StartObject();
        w.Key("name"); write_str(w, e.metric);
        w.Key("kind"); write_str(w, e.kind);
        w.Key("unit"); write_str(w, e.unit);
        w.Key("description"); write_str(w, e.description);
        w.Key("temporality");
        if (e.temporality.empty()) w.Null();
        else write_str(w, e.temporality);
        w.Key("monotonic");
        if (e.monotonic < 0) w.Null();
        else w.Bool(e.monotonic == 1);
        w.Key("points"); w.Int64(e.points);
        w.EndObject();
      }
      w.EndArray();
      w.EndObject();
    }
    w.EndArray();
    w.Key("service_count"); w.Uint64(services.size());
    w.Key("metric_count"); w.Uint64(rows);
    w.Key("truncated"); w.Bool(truncated);
    w.Key("limit"); w.Uint64(kCatalogLimit);
    w.Key("kinds");
    w.StartArray();
    for (const char* kind : kKinds) {
      if (kinds.count(kind)) w.String(kind);
    }
    w.EndArray();
    if (kinds.empty()) {
      w.Key("error_code"); w.String("metrics_tables_missing");
      const std::string message = "No OpenTelemetry exporter metrics tables named " + cfg_.metrics.database + "." +
                                  cfg_.metrics.table_prefix + "_{gauge,sum,histogram,exponential_histogram,summary} exist.";
      w.Key("message"); write_str(w, message);
    }
    w.EndObject();
    const std::string body = sb.GetString();
    {
      std::lock_guard<std::mutex> lock(g_catalog_mutex);
      if (g_catalog_cache.size() >= kCatalogCacheMaxEntries) g_catalog_cache.clear();
      g_catalog_cache[key] = CatalogCacheEntry{body, Clock::now()};
    }
    send_json(res, with_cache_status(body, false, 0, query_ms, elapsed_ms(started)));
  });
}

// ---------------------------------------------------------------------------
// GET /api/metrics/attributes

void Server::handle_metrics_attributes(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  std::string kind, service, metric;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  try {
    kind = parse_kind(req);
    service = required(req, "service");
    metric = required(req, "metric");
    window = parse_window(req);
    filters = parse_filters(req);
  } catch (const BadRequest& e) {
    return json_error(res, 400, "invalid_metrics_request", e.what());
  }
  const std::string key = param(req, "key");
  MetricsContext ctx;
  if (!open_context(cfg_, client_pool_, req, res, &ctx)) return;

  run_guarded(res, [&] {
    require_kind_table(*ctx.client, *ctx.host, cfg_.metrics, kind);
    const std::string table = kind_table(cfg_.metrics, kind);
    const std::string prewhere = metric_predicate(service, metric, window.start_ms, window.end_ms);
    const std::string visibility = service_allowlist_predicate(cfg_.traces);
    int64_t query_ms = 0;
    rapidjson::StringBuffer sb;
    JsonWriter w(sb);
    w.StartObject();
    w.Key("v"); w.Int(1);
    w.Key("kind"); write_str(w, kind);
    w.Key("service"); write_str(w, service);
    w.Key("metric"); write_str(w, metric);
    if (key.empty()) {
      std::vector<std::string> keys;
      const std::string sql = "SELECT DISTINCT toString(arrayJoin(mapKeys(Attributes))) AS k FROM " + table +
                              " PREWHERE " + prewhere + " WHERE " + visibility + filters_sql(filters) + " LIMIT " +
                              std::to_string(kAttributeKeyLimit + 1) + kQuerySettings;
      const auto query_started = Clock::now();
      ctx.client->Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) keys.push_back(ch_block_text_at(block, 0, row));
      });
      query_ms += elapsed_ms(query_started);
      const bool truncated = keys.size() > kAttributeKeyLimit;
      if (truncated) keys.resize(kAttributeKeyLimit);
      std::sort(keys.begin(), keys.end());
      w.Key("keys");
      w.StartArray();
      for (const auto& k : keys) write_str(w, k);
      w.EndArray();
      w.Key("truncated"); w.Bool(truncated);
    } else {
      if (key.size() > 256) throw BadRequest("key is too long.");
      std::vector<std::pair<std::string, int64_t>> values;
      const std::string sql = "SELECT v, toString(n) FROM (SELECT Attributes[" + quote_string(key) + "] AS v, count() AS n FROM " +
                              table + " PREWHERE " + prewhere + " WHERE " + visibility + " AND mapContains(Attributes, " +
                              quote_string(key) + ")" + filters_sql(filters, key) + " GROUP BY v ORDER BY n DESC, v LIMIT " +
                              std::to_string(kAttributeValueLimit + 1) + ")" + kQuerySettings;
      const auto query_started = Clock::now();
      ctx.client->Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          values.emplace_back(ch_block_text_at(block, 0, row), text_to_i64(ch_block_text_at(block, 1, row)));
        }
      });
      query_ms += elapsed_ms(query_started);
      const bool truncated = values.size() > kAttributeValueLimit;
      if (truncated) values.resize(kAttributeValueLimit);
      w.Key("key"); write_str(w, key);
      w.Key("values");
      w.StartArray();
      for (const auto& [value, points] : values) {
        w.StartObject();
        w.Key("value"); write_str(w, value);
        w.Key("points"); w.Int64(points);
        w.EndObject();
      }
      w.EndArray();
      w.Key("truncated"); w.Bool(truncated);
    }
    write_timing(w, query_ms, started);
    w.EndObject();
    send_json(res, sb.GetString());
  });
}

// ---------------------------------------------------------------------------
// GET /api/metrics/series

void Server::handle_metrics_series(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  std::string kind, service, metric, agg_param;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  std::vector<std::string> group_by;
  BucketGrid grid;
  int top_k = kDefaultTopK;
  try {
    kind = parse_kind(req);
    service = required(req, "service");
    metric = required(req, "metric");
    window = parse_window(req);
    filters = parse_filters(req);
    group_by = parse_group_by(req);
    grid = choose_grid(req, window);
    agg_param = param(req, "agg");
    int64_t limit = 0;
    if (parse_i64_param(req, "limit", &limit)) {
      if (limit < 1 || limit > kMaxTopK) throw BadRequest("limit must be between 1 and 50.");
      top_k = static_cast<int>(limit);
    }
  } catch (const BadRequest& e) {
    return json_error(res, 400, "invalid_metrics_request", e.what());
  }
  MetricsContext ctx;
  if (!open_context(cfg_, client_pool_, req, res, &ctx)) return;

  run_guarded(res, [&] {
    require_kind_table(*ctx.client, *ctx.host, cfg_.metrics, kind);
    const std::string table = kind_table(cfg_.metrics, kind);
    const std::string visibility = service_allowlist_predicate(cfg_.traces);
    const std::string where = visibility + filters_sql(filters);
    const std::string window_prewhere = metric_predicate(service, metric, window.start_ms, window.end_ms);
    // Per-series differences need each series' previous point: the scan
    // starts earlier, only points inside the window contribute.
    const int64_t scan_start_ms = std::max<int64_t>(0, window.start_ms - std::max(grid.size_ms, kLagLookbackMinMs));
    const std::string lag_prewhere = metric_predicate(service, metric, scan_start_ms, window.end_ms);
    const std::string in_window = "TimeUnix >= fromUnixTimestamp64Milli(" + std::to_string(window.start_ms) + ")";
    const double bucket_seconds = static_cast<double>(grid.size_ms) / 1000.0;
    int64_t query_ms = 0;

    const MetricInfo info = load_metric_info(*ctx.client, table, kind, window_prewhere, where, &query_ms);
    const bool any_cumulative = info.temporality_max >= 2 || kind == "summary";
    const bool all_delta = info.temporality_min == 1 && info.temporality_max == 1;

    // Aggregations offered for the kind; the first is the default.
    std::vector<std::string> aggs;
    Mode mode = Mode::Gauge;
    std::string default_agg;
    if (kind == "gauge") {
      aggs = {"avg", "min", "max", "last", "sum"};
    } else if (kind == "sum") {
      if (info.monotonic || info.points == 0) aggs = {"rate", "increase"};
      else if (any_cumulative) aggs = {"last", "avg", "min", "max"};
      else aggs = {"sum", "rate"};
    } else if (kind == "histogram" || kind == "exponential_histogram") {
      aggs = {"p50", "p90", "p95", "p99", "avg", "count_rate", "count"};
    } else {
      for (const auto& q : info.quantiles) aggs.push_back(quantile_agg_name(text_to_double(q)));
      aggs.push_back("avg");
      aggs.push_back("count_rate");
    }
    default_agg = aggs.front();
    if (kind == "summary" && std::find(aggs.begin(), aggs.end(), "p50") != aggs.end()) default_agg = "p50";
    const std::string agg = agg_param.empty() ? default_agg : agg_param;
    if (std::find(aggs.begin(), aggs.end(), agg) == aggs.end()) {
      std::string list;
      for (const auto& a : aggs) list += (list.empty() ? "" : ", ") + a;
      throw BadRequest("agg must be one of: " + list + ".");
    }

    if (kind == "gauge") mode = Mode::Gauge;
    else if (kind == "sum") mode = (!info.monotonic && info.points > 0 && any_cumulative) ? Mode::Gauge : Mode::Delta;
    else if (kind == "histogram") mode = Mode::Histogram;
    else if (kind == "exponential_histogram") mode = Mode::Exponential;
    else mode = is_quantile_agg(agg) ? Mode::SummaryQuantile : Mode::SummaryDelta;
    const bool per_series = mode == Mode::SummaryQuantile;

    std::string group_expr = "''";
    if (!group_by.empty() && !per_series) {
      group_expr = "arrayStringConcat([";
      for (size_t i = 0; i < group_by.size(); ++i) {
        if (i) group_expr += ", ";
        group_expr += "Attributes[" + quote_string(group_by[i]) + "]";
      }
      group_expr += "], char(31))";
    }
    const std::string series_id = "cityHash64(Attributes, ResourceAttributes)";
    const std::string bucket = grid.sql("TimeUnix");
    const std::string lag_window = " WINDOW w AS (PARTITION BY " + series_id +
                                   " ORDER BY TimeUnix ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)";
    const std::string row_limit = " LIMIT " + std::to_string(kMaxSeriesRows + 1) + kQuerySettings;

    std::string sql;
    if (mode == Mode::Gauge) {
      sql = "SELECT g, toString(b), toString(sum(s_sum)), toString(sum(s_cnt)), toString(min(s_min)), toString(max(s_max)), "
            "toString(sum(s_last)), toString(count()) FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, " + series_id +
            " AS sid, sum(Value) AS s_sum, count() AS s_cnt, min(Value) AS s_min, max(Value) AS s_max, "
            "argMax(Value, TimeUnix) AS s_last FROM " + table + " PREWHERE " + window_prewhere + " WHERE " + where +
            " GROUP BY g, b, sid) GROUP BY g, b ORDER BY g, b" + row_limit;
    } else if (mode == Mode::Delta && all_delta) {
      sql = "SELECT " + group_expr + " AS g, toString(" + bucket + ") AS b, toString(sum(Value)), toString(count()) FROM " +
            table + " PREWHERE " + window_prewhere + " WHERE " + where + " GROUP BY g, b ORDER BY g, b" + row_limit;
    } else if (mode == Mode::Delta || mode == Mode::SummaryDelta) {
      // Delta points count as they are. A cumulative point contributes its
      // difference to the previous point of the same series, or its whole
      // value after a reset (new StartTimeUnix or a decrease); the first
      // point of a series has no predecessor and no difference.
      const bool summary = mode == Mode::SummaryDelta;
      const std::string temporality = summary ? "2" : "AggregationTemporality";
      const std::string v1 = summary ? "Sum" : "Value";
      const std::string v2 = summary ? "toFloat64(Count)" : "toFloat64(0)";
      const std::string reset_value = summary ? "v2 < p2" : "v1 < p1";
      sql = "SELECT g, toString(b), toString(sum(d1)), toString(sum(d2)) FROM (SELECT g, b, TimeUnix, "
            "multiIf(temporality = 1, v1, rn = 1, nan, ps != StartTimeUnix OR " + reset_value + ", v1, v1 - p1) AS d1, "
            "multiIf(temporality = 1, v2, rn = 1, nan, ps != StartTimeUnix OR " + reset_value + ", v2, v2 - p2) AS d2 "
            "FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, TimeUnix, StartTimeUnix, " + temporality +
            " AS temporality, " + v1 + " AS v1, " + v2 + " AS v2, lagInFrame(v1) OVER w AS p1, lagInFrame(v2) OVER w AS p2, "
            "lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " + table + " PREWHERE " + lag_prewhere +
            " WHERE " + where + lag_window + ") WHERE " + in_window + " AND NOT isNaN(d1)) GROUP BY g, b ORDER BY g, b" +
            row_limit;
    } else if (mode == Mode::Histogram) {
      const std::string counts = "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dc)), ',')";
      if (all_delta) {
        sql = "SELECT g, toString(b), bstr, " + counts + ", toString(sum(dcount)), toString(sum(dsum)) FROM (SELECT " +
              group_expr + " AS g, " + bucket + " AS b, arrayStringConcat(arrayMap(x -> toString(x), ExplicitBounds), ',') AS bstr, "
              "BucketCounts AS dc, toFloat64(Count) AS dcount, Sum AS dsum FROM " + table + " PREWHERE " + window_prewhere +
              " WHERE " + where + ") GROUP BY g, b, bstr ORDER BY g, b" + row_limit;
      } else {
        sql = "SELECT g, toString(b), bstr, " + counts + ", toString(sum(dcount)), toString(sum(dsum)) FROM (SELECT g, b, bstr, "
              "if(plain, arrayMap(x -> toInt64(x), BucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(pc[i]), BucketCounts, "
              "arrayEnumerate(BucketCounts))) AS dc, if(plain, toFloat64(Count), toFloat64(Count) - toFloat64(pcount)) AS dcount, "
              "if(plain, Sum, Sum - psum) AS dsum FROM (SELECT g, b, bstr, TimeUnix, BucketCounts, Count, Sum, pc, pcount, psum, rn, "
              "temporality = 1 OR ps != StartTimeUnix OR Count < pcount OR length(BucketCounts) != length(pc) OR "
              "ExplicitBounds != pb OR arrayExists((c, i) -> toInt64(c) < toInt64(pc[i]), BucketCounts, "
              "arrayEnumerate(BucketCounts)) AS plain FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, "
              "arrayStringConcat(arrayMap(x -> toString(x), ExplicitBounds), ',') AS bstr, TimeUnix, StartTimeUnix, "
              "AggregationTemporality AS temporality, BucketCounts, ExplicitBounds, Count, Sum, "
              "lagInFrame(BucketCounts) OVER w AS pc, lagInFrame(ExplicitBounds) OVER w AS pb, lagInFrame(Count) OVER w AS pcount, "
              "lagInFrame(Sum) OVER w AS psum, lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " + table +
              " PREWHERE " + lag_prewhere + " WHERE " + where + lag_window + ") WHERE " + in_window +
              " AND (temporality = 1 OR rn > 1))) GROUP BY g, b, bstr ORDER BY g, b" + row_limit;
      }
    } else if (mode == Mode::Exponential) {
      const std::string sums = "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dpos)), ','), "
                               "arrayStringConcat(arrayMap(x -> toString(x), sumForEach(dneg)), ','), "
                               "toString(sum(dzero)), toString(sum(dcount)), toString(sum(dsum))";
      if (all_delta) {
        sql = "SELECT g, toString(b), toString(Scale), toString(PositiveOffset), toString(NegativeOffset), " + sums +
              " FROM (SELECT " + group_expr + " AS g, " + bucket + " AS b, Scale, PositiveOffset, NegativeOffset, "
              "PositiveBucketCounts AS dpos, NegativeBucketCounts AS dneg, toFloat64(ZeroCount) AS dzero, "
              "toFloat64(Count) AS dcount, Sum AS dsum FROM " + table + " PREWHERE " + window_prewhere + " WHERE " + where +
              ") GROUP BY g, b, Scale, PositiveOffset, NegativeOffset ORDER BY g, b" + row_limit;
      } else {
        sql = "SELECT g, toString(b), toString(Scale), toString(PositiveOffset), toString(NegativeOffset), " + sums +
              " FROM (SELECT g, b, Scale, PositiveOffset, NegativeOffset, "
              "if(plain, arrayMap(x -> toInt64(x), PositiveBucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(ppos[i]), "
              "PositiveBucketCounts, arrayEnumerate(PositiveBucketCounts))) AS dpos, "
              "if(plain, arrayMap(x -> toInt64(x), NegativeBucketCounts), arrayMap((c, i) -> toInt64(c) - toInt64(pneg[i]), "
              "NegativeBucketCounts, arrayEnumerate(NegativeBucketCounts))) AS dneg, "
              "if(plain, toFloat64(ZeroCount), toFloat64(ZeroCount) - toFloat64(pzero)) AS dzero, "
              "if(plain, toFloat64(Count), toFloat64(Count) - toFloat64(pcount)) AS dcount, if(plain, Sum, Sum - psum) AS dsum "
              "FROM (SELECT *, temporality = 1 OR ps != StartTimeUnix OR Count < pcount OR Scale != pscale OR "
              "PositiveOffset != ppoff OR NegativeOffset != pnoff OR length(PositiveBucketCounts) < length(ppos) OR "
              "length(NegativeBucketCounts) < length(pneg) OR ZeroCount < pzero AS plain FROM (SELECT " + group_expr + " AS g, " +
              bucket + " AS b, TimeUnix, StartTimeUnix, AggregationTemporality AS temporality, Scale, PositiveOffset, "
              "NegativeOffset, PositiveBucketCounts, NegativeBucketCounts, ZeroCount, Count, Sum, "
              "lagInFrame(PositiveBucketCounts) OVER w AS ppos, lagInFrame(NegativeBucketCounts) OVER w AS pneg, "
              "lagInFrame(ZeroCount) OVER w AS pzero, lagInFrame(Count) OVER w AS pcount, lagInFrame(Sum) OVER w AS psum, "
              "lagInFrame(Scale) OVER w AS pscale, lagInFrame(PositiveOffset) OVER w AS ppoff, "
              "lagInFrame(NegativeOffset) OVER w AS pnoff, lagInFrame(StartTimeUnix) OVER w AS ps, row_number() OVER w AS rn FROM " +
              table + " PREWHERE " + lag_prewhere + " WHERE " + where + lag_window + ") WHERE " + in_window +
              " AND (temporality = 1 OR rn > 1))) GROUP BY g, b, Scale, PositiveOffset, NegativeOffset ORDER BY g, b" + row_limit;
      }
    } else {
      // Summary quantiles: one line per series, the last value in each bucket.
      std::string q_literal;
      const double wanted = quantile_of(agg);
      for (const auto& q : info.quantiles) {
        if (quantile_agg_name(text_to_double(q)) == agg) q_literal = q;
      }
      if (q_literal.empty()) q_literal = std::to_string(wanted);
      sql = "SELECT toString(sid), any(attrs), toString(b), toString(argMax(qv, TimeUnix)) FROM (SELECT " + series_id +
            " AS sid, toJSONString(Attributes) AS attrs, " + bucket + " AS b, TimeUnix, indexOf(`ValueAtQuantiles.Quantile`, " +
            q_literal + ") AS qi, `ValueAtQuantiles.Value`[qi] AS qv FROM " + table + " PREWHERE " + window_prewhere +
            " WHERE " + where + ") WHERE qi > 0 GROUP BY sid, b ORDER BY sid, b" + row_limit;
    }

    std::map<std::string, Group> groups;
    size_t rows = 0;
    bool truncated_rows = false;
    const auto query_started = Clock::now();
    ctx.client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (rows >= kMaxSeriesRows) {
          truncated_rows = true;
          continue;
        }
        ++rows;
        std::string g = ch_block_text_at(block, 0, row);
        Group& group = groups[g];
        if (group.key.empty()) group.key = g;
        Cell cell;
        int64_t b = 0;
        switch (mode) {
          case Mode::Gauge:
            b = text_to_i64(ch_block_text_at(block, 1, row));
            cell.sum = text_to_double(ch_block_text_at(block, 2, row));
            cell.count = text_to_double(ch_block_text_at(block, 3, row));
            cell.min = text_to_double(ch_block_text_at(block, 4, row));
            cell.max = text_to_double(ch_block_text_at(block, 5, row));
            cell.last_sum = text_to_double(ch_block_text_at(block, 6, row));
            cell.series = text_to_double(ch_block_text_at(block, 7, row));
            break;
          case Mode::Delta:
            b = text_to_i64(ch_block_text_at(block, 1, row));
            cell.sum = text_to_double(ch_block_text_at(block, 2, row));
            break;
          case Mode::SummaryDelta:
            b = text_to_i64(ch_block_text_at(block, 1, row));
            cell.sum = text_to_double(ch_block_text_at(block, 2, row));
            cell.count = text_to_double(ch_block_text_at(block, 3, row));
            break;
          case Mode::Histogram:
            b = text_to_i64(ch_block_text_at(block, 1, row));
            cell.bounds = text_to_doubles(ch_block_text_at(block, 2, row));
            cell.counts = text_to_doubles(ch_block_text_at(block, 3, row));
            cell.count = text_to_double(ch_block_text_at(block, 4, row));
            cell.sum = text_to_double(ch_block_text_at(block, 5, row));
            break;
          case Mode::Exponential: {
            b = text_to_i64(ch_block_text_at(block, 1, row));
            cell.exp.present = true;
            cell.exp.scale = static_cast<int>(text_to_i64(ch_block_text_at(block, 2, row)));
            const int64_t positive_offset = text_to_i64(ch_block_text_at(block, 3, row));
            const int64_t negative_offset = text_to_i64(ch_block_text_at(block, 4, row));
            const auto pos = text_to_doubles(ch_block_text_at(block, 5, row));
            const auto neg = text_to_doubles(ch_block_text_at(block, 6, row));
            for (size_t i = 0; i < pos.size(); ++i) {
              if (pos[i] != 0) cell.exp.positive[positive_offset + static_cast<int64_t>(i)] += pos[i];
            }
            for (size_t i = 0; i < neg.size(); ++i) {
              if (neg[i] != 0) cell.exp.negative[negative_offset + static_cast<int64_t>(i)] += neg[i];
            }
            cell.exp.zero = text_to_double(ch_block_text_at(block, 7, row));
            cell.count = text_to_double(ch_block_text_at(block, 8, row));
            cell.sum = text_to_double(ch_block_text_at(block, 9, row));
            break;
          }
          case Mode::SummaryQuantile:
            if (group.labels_json.empty()) group.labels_json = ch_block_text_at(block, 1, row);
            b = text_to_i64(ch_block_text_at(block, 2, row));
            cell.last_sum = text_to_double(ch_block_text_at(block, 3, row));
            cell.series = std::isfinite(cell.last_sum) ? 1 : 0;
            if (!std::isfinite(cell.last_sum)) cell.last_sum = 0;
            break;
        }
        auto it = group.cells.find(b);
        if (it == group.cells.end()) group.cells.emplace(b, std::move(cell));
        else merge_cell(it->second, cell);
      }
    });
    query_ms += elapsed_ms(query_started);

    // Rank groups: quantiles by their observation count, everything else by
    // the sum of |value| over the buckets.
    const bool rank_by_count = (mode == Mode::Histogram || mode == Mode::Exponential) && is_quantile_agg(agg);
    std::vector<Group*> ordered;
    for (auto& [key, group] : groups) {
      double score = 0;
      for (const auto& [b, cell] : group.cells) {
        const double v = rank_by_count ? cell.count : cell_value(cell, mode, agg, bucket_seconds);
        if (std::isfinite(v)) score += std::fabs(v);
      }
      group.score = score;
      ordered.push_back(&group);
    }
    std::sort(ordered.begin(), ordered.end(), [](const Group* a, const Group* b) {
      if (a->score != b->score) return a->score > b->score;
      return a->key < b->key;
    });
    const size_t kept = std::min(ordered.size(), static_cast<size_t>(top_k));
    Group other;
    other.key = "__other__";
    size_t other_count = 0;
    if (!per_series) {
      for (size_t i = kept; i < ordered.size(); ++i) {
        ++other_count;
        other.score += ordered[i]->score;
        for (const auto& [b, cell] : ordered[i]->cells) {
          auto it = other.cells.find(b);
          if (it == other.cells.end()) other.cells.emplace(b, cell);
          else merge_cell(it->second, cell);
        }
      }
    }

    std::vector<int64_t> timestamps;
    for (int64_t t = grid.floor(window.start_ms); t <= grid.floor(window.end_ms) && timestamps.size() < 5000; t += grid.size_ms) {
      timestamps.push_back(t);
    }

    // Rates divide by the part of the bucket inside the window: the first and
    // last buckets are usually cut by the range, and only their points count.
    const auto covered_seconds = [&](int64_t t) {
      const int64_t lo = std::max(t, window.start_ms);
      const int64_t hi = std::min(t + grid.size_ms, window.end_ms);
      return hi > lo ? static_cast<double>(hi - lo) / 1000.0 : bucket_seconds;
    };

    std::string value_unit = info.unit;
    if (agg == "rate") value_unit = info.unit.empty() ? "/s" : info.unit + "/s";
    else if (agg == "count_rate") value_unit = "/s";
    else if (agg == "count") value_unit = "";

    rapidjson::StringBuffer sb(nullptr, 64 * 1024);
    JsonWriter w(sb);
    const auto write_series = [&](const Group& group, bool is_other) {
      w.StartObject();
      w.Key("key"); write_str(w, group.key);
      w.Key("labels");
      w.StartObject();
      if (!is_other) {
        if (per_series) {
          rapidjson::Document doc;
          doc.Parse(group.labels_json.c_str());
          if (doc.IsObject()) {
            for (auto m = doc.MemberBegin(); m != doc.MemberEnd(); ++m) {
              if (!m->value.IsString()) continue;
              w.Key(m->name.GetString(), m->name.GetStringLength());
              w.String(m->value.GetString(), m->value.GetStringLength());
            }
          }
        } else if (!group_by.empty()) {
          const auto parts = split_keep(group.key, '\x1f');
          for (size_t i = 0; i < group_by.size(); ++i) {
            w.Key(group_by[i].data(), static_cast<rapidjson::SizeType>(group_by[i].size()));
            write_str(w, i < parts.size() ? parts[i] : std::string{});
          }
        }
      }
      w.EndObject();
      w.Key("values");
      w.StartArray();
      for (int64_t t : timestamps) {
        const auto it = group.cells.find(t);
        write_number(w, it == group.cells.end() ? kNaN : cell_value(it->second, mode, agg, covered_seconds(t)));
      }
      w.EndArray();
      w.Key("total"); write_number(w, group.score);
      w.Key("other"); w.Bool(is_other);
      w.EndObject();
    };

    w.StartObject();
    w.Key("v"); w.Int(1);
    w.Key("source_host_id"); write_str(w, ctx.host_id);
    w.Key("kind"); write_str(w, kind);
    w.Key("service"); write_str(w, service);
    w.Key("metric"); write_str(w, metric);
    w.Key("unit"); write_str(w, info.unit);
    w.Key("description"); write_str(w, info.description);
    const std::string temporality = kind == "gauge" || kind == "summary" ? std::string{} : temporality_name(info);
    w.Key("temporality");
    if (temporality.empty()) w.Null();
    else write_str(w, temporality);
    w.Key("monotonic");
    if (kind == "sum" && info.points > 0) w.Bool(info.monotonic);
    else w.Null();
    w.Key("points"); w.Int64(info.points);
    w.Key("agg"); write_str(w, agg);
    w.Key("default_agg"); write_str(w, default_agg);
    w.Key("aggs");
    w.StartArray();
    for (const auto& a : aggs) write_str(w, a);
    w.EndArray();
    w.Key("value_unit"); write_str(w, value_unit);
    w.Key("range"); w.StartArray(); w.Int64(window.start_ms); w.Int64(window.end_ms); w.EndArray();
    w.Key("bucket_ms"); w.Int64(grid.size_ms);
    w.Key("bucket_origin_ms"); w.Int64(grid.origin_ms);
    w.Key("group_by");
    w.StartArray();
    if (!per_series) {
      for (const auto& k : group_by) write_str(w, k);
    }
    w.EndArray();
    w.Key("filters");
    w.StartArray();
    for (const auto& f : filters) {
      w.StartObject();
      w.Key("key"); write_str(w, f.key);
      w.Key("op"); write_str(w, f.op);
      w.Key("value"); write_str(w, f.value);
      w.EndObject();
    }
    w.EndArray();
    w.Key("timestamps");
    w.StartArray();
    for (int64_t t : timestamps) w.Int64(t);
    w.EndArray();
    w.Key("series");
    w.StartArray();
    for (size_t i = 0; i < kept; ++i) write_series(*ordered[i], false);
    if (other_count > 0) write_series(other, true);
    w.EndArray();
    w.Key("other_series_count"); w.Uint64(other_count);
    w.Key("group_count"); w.Uint64(groups.size());
    w.Key("top_k"); w.Int(top_k);
    w.Key("truncated"); w.Bool(ordered.size() > kept);
    w.Key("truncated_rows"); w.Bool(truncated_rows);
    w.Key("per_series"); w.Bool(per_series);
    w.Key("note");
    if (per_series) {
      w.String("Summary quantiles are precomputed per series and cannot be aggregated across series: each series is shown "
               "separately and group by is ignored.");
    } else {
      w.Null();
    }
    write_timing(w, query_ms, started);
    w.EndObject();
    send_json(res, sb.GetString());
  });
}

// ---------------------------------------------------------------------------
// GET /api/metrics/exemplars

void Server::handle_metrics_exemplars(const httplib::Request& req, httplib::Response& res) {
  const auto started = Clock::now();
  std::string kind, service, metric;
  TimeWindow window;
  std::vector<AttributeFilter> filters;
  BucketGrid grid;
  int64_t per_bucket = 3;
  int64_t limit = 500;
  try {
    kind = parse_kind(req);
    if (kind == "summary") throw BadRequest("Summaries have no exemplars.");
    service = required(req, "service");
    metric = required(req, "metric");
    window = parse_window(req);
    filters = parse_filters(req);
    grid = choose_grid(req, window);
    if (parse_i64_param(req, "per_bucket", &per_bucket) && (per_bucket < 1 || per_bucket > 20)) {
      throw BadRequest("per_bucket must be between 1 and 20.");
    }
    if (parse_i64_param(req, "limit", &limit) && (limit < 1 || limit > 2000)) {
      throw BadRequest("limit must be between 1 and 2000.");
    }
  } catch (const BadRequest& e) {
    return json_error(res, 400, "invalid_metrics_request", e.what());
  }
  MetricsContext ctx;
  if (!open_context(cfg_, client_pool_, req, res, &ctx)) return;

  run_guarded(res, [&] {
    require_kind_table(*ctx.client, *ctx.host, cfg_.metrics, kind);
    const std::string table = kind_table(cfg_.metrics, kind);
    const std::string visibility = service_allowlist_predicate(cfg_.traces);
    const std::string start = "fromUnixTimestamp64Milli(" + std::to_string(window.start_ms) + ")";
    const std::string end = "fromUnixTimestamp64Milli(" + std::to_string(window.end_ms) + ")";
    const std::string sql =
        "SELECT toString(" + grid.sql("e.1") + ") AS b, toString(toUnixTimestamp64Milli(e.1)), toString(e.2), e.3, e.4, attrs "
        "FROM (SELECT arrayJoin(arrayZip(`Exemplars.TimeUnix`, `Exemplars.Value`, `Exemplars.TraceId`, `Exemplars.SpanId`)) AS e, "
        "toJSONString(Attributes) AS attrs FROM " + table + " PREWHERE " +
        metric_predicate(service, metric, window.start_ms, window.end_ms) + " WHERE " + visibility + filters_sql(filters) +
        " AND notEmpty(`Exemplars.TraceId`)) WHERE notEmpty(e.3) AND e.1 >= " + start + " AND e.1 <= " + end +
        " ORDER BY e.2 DESC, e.1 LIMIT " + std::to_string(per_bucket) + " BY b LIMIT " + std::to_string(limit + 1) + kQuerySettings;

    struct Exemplar {
      int64_t t = 0;
      double value = 0;
      std::string trace_id, span_id, attrs;
    };
    std::vector<Exemplar> exemplars;
    const auto query_started = Clock::now();
    ctx.client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        exemplars.push_back(Exemplar{text_to_i64(ch_block_text_at(block, 1, row)), text_to_double(ch_block_text_at(block, 2, row)),
                                     ch_block_text_at(block, 3, row), ch_block_text_at(block, 4, row),
                                     ch_block_text_at(block, 5, row)});
      }
    });
    const int64_t query_ms = elapsed_ms(query_started);
    const bool truncated = exemplars.size() > static_cast<size_t>(limit);
    if (truncated) exemplars.resize(static_cast<size_t>(limit));
    std::sort(exemplars.begin(), exemplars.end(), [](const Exemplar& a, const Exemplar& b) { return a.t < b.t; });

    rapidjson::StringBuffer sb(nullptr, 32 * 1024);
    JsonWriter w(sb);
    w.StartObject();
    w.Key("v"); w.Int(1);
    w.Key("source_host_id"); write_str(w, ctx.host_id);
    w.Key("kind"); write_str(w, kind);
    w.Key("service"); write_str(w, service);
    w.Key("metric"); write_str(w, metric);
    w.Key("range"); w.StartArray(); w.Int64(window.start_ms); w.Int64(window.end_ms); w.EndArray();
    w.Key("bucket_ms"); w.Int64(grid.size_ms);
    w.Key("bucket_origin_ms"); w.Int64(grid.origin_ms);
    w.Key("exemplars");
    w.StartArray();
    for (const auto& e : exemplars) {
      w.StartObject();
      w.Key("t"); w.Int64(e.t);
      w.Key("value"); write_number(w, e.value);
      w.Key("trace_id"); write_str(w, e.trace_id);
      w.Key("span_id"); write_str(w, e.span_id);
      w.Key("attributes");
      w.StartObject();
      rapidjson::Document doc;
      doc.Parse(e.attrs.c_str());
      if (doc.IsObject()) {
        for (auto m = doc.MemberBegin(); m != doc.MemberEnd(); ++m) {
          if (!m->value.IsString()) continue;
          w.Key(m->name.GetString(), m->name.GetStringLength());
          w.String(m->value.GetString(), m->value.GetStringLength());
        }
      }
      w.EndObject();
      w.EndObject();
    }
    w.EndArray();
    w.Key("truncated"); w.Bool(truncated);
    w.Key("per_bucket"); w.Int64(per_bucket);
    w.Key("traces_enabled"); w.Bool(cfg_.traces.enabled);
    write_timing(w, query_ms, started);
    w.EndObject();
    send_json(res, sb.GetString());
  });
}

}  // namespace chdash
