#include "metrics_aggregate.hpp"

#include "ch_block_value.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace chdash {
namespace metrics {

// ---- text from ClickHouse ----

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

// ---- merging ----

namespace {

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

// The bucket of `bounds` (explicit bounds, then the +Inf bucket) that holds the upper bound `upper`.
size_t bucket_of(const std::vector<double>& bounds, double upper) {
  if (!std::isfinite(upper)) return bounds.size();
  const auto at = std::lower_bound(bounds.begin(), bounds.end(), upper);
  return static_cast<size_t>(at - bounds.begin());
}

// Adds explicit-bucket counts. Rows with the same bounds add up bucket by bucket. Rows with other bounds are re-bucketed onto the sorted
// union of their bounds: each source bucket's count goes to the bucket that has its upper bound, so the result does not depend on the
// order of the rows (a row with no bounds is one +Inf bucket).
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
  std::vector<double> merged;
  const std::vector<double>* const lists[] = {&into.bounds, &bounds};
  for (const std::vector<double>* list : lists) {
    for (const double bound : *list) {
      if (std::isfinite(bound)) merged.push_back(bound);
    }
  }
  std::sort(merged.begin(), merged.end());
  merged.erase(std::unique(merged.begin(), merged.end()), merged.end());
  std::vector<double> next(merged.size() + 1, 0.0);
  const auto add = [&](const std::vector<double>& from_bounds, const std::vector<double>& from_counts) {
    for (size_t i = 0; i < from_counts.size(); ++i) {
      const double upper = i < from_bounds.size() ? from_bounds[i] : std::numeric_limits<double>::infinity();
      next[bucket_of(merged, upper)] += from_counts[i];
    }
  };
  add(into.bounds, into.counts);
  add(bounds, counts);
  into.bounds = std::move(merged);
  into.counts = std::move(next);
}

}  // namespace

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

// ---- quantiles ----

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

namespace {

double exp_bound(int64_t index, int scale) { return std::exp2(std::ldexp(static_cast<double>(index), -scale)); }

}  // namespace

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

double quantile_of(const std::string& agg) { return text_to_double(agg.substr(1)) / 100.0; }

bool is_quantile_agg(const std::string& agg) { return agg.size() > 1 && agg[0] == 'p' && std::isfinite(text_to_double(agg.substr(1))); }

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

// ---- what a metric is ----

void read_metric_info(const clickhouse::Block& block, MetricInfo* info) {
  for (size_t row = 0; row < block.GetRowCount(); ++row) {
    info->unit = ch_block_text_at(block, 0, row);
    info->description = ch_block_text_at(block, 1, row);
    info->temporality_min = text_to_i64(ch_block_text_at(block, 2, row));
    info->temporality_max = text_to_i64(ch_block_text_at(block, 3, row));
    info->monotonic = ch_block_text_at(block, 4, row) == "1";
    info->monotonic_min = block.GetColumnCount() > 7 && ch_block_text_at(block, 7, row) == "1";
    info->points = text_to_i64(ch_block_text_at(block, 5, row));
    for (auto& q : split_keep(ch_block_text_at(block, 6, row), ',')) {
      if (!q.empty() && std::isfinite(text_to_double(q))) info->quantiles.push_back(q);
    }
  }
}

std::string temporality_name(const MetricInfo& info) {
  if (info.points == 0 || info.temporality_max == 0) return {};
  if (info.temporality_min == info.temporality_max) {
    if (info.temporality_min == 1) return "delta";
    if (info.temporality_min == 2) return "cumulative";
    return {};
  }
  return "mixed";
}

bool plan_aggregation(const std::string& kind, const MetricInfo& info, const std::string& requested, AggregationPlan* plan,
                      std::string* error) {
  AggregationPlan out;
  out.any_cumulative = info.temporality_max >= 2 || kind == "summary";
  out.all_delta = info.temporality_min == 1 && info.temporality_max == 1;
  if (kind == "gauge") {
    out.aggs = {"avg", "min", "max", "last", "sum"};
  } else if (kind == "sum") {
    if (info.monotonic || info.points == 0) out.aggs = {"rate", "increase"};
    else if (out.any_cumulative) out.aggs = {"last", "avg", "min", "max"};
    else out.aggs = {"sum", "rate"};
  } else if (kind == "histogram" || kind == "exponential_histogram") {
    out.aggs = {"p50", "p90", "p95", "p99", "avg", "count_rate", "count"};
  } else {
    for (const auto& q : info.quantiles) out.aggs.push_back(quantile_agg_name(text_to_double(q)));
    out.aggs.push_back("avg");
    out.aggs.push_back("count_rate");
  }
  out.default_agg = out.aggs.front();
  if (kind == "summary" && std::find(out.aggs.begin(), out.aggs.end(), "p50") != out.aggs.end()) out.default_agg = "p50";
  out.agg = requested.empty() ? out.default_agg : requested;
  if (std::find(out.aggs.begin(), out.aggs.end(), out.agg) == out.aggs.end()) {
    std::string list;
    for (const auto& a : out.aggs) list += (list.empty() ? "" : ", ") + a;
    if (error) *error = "agg must be one of: " + list + ".";
    return false;
  }
  if (kind == "gauge") out.mode = Mode::Gauge;
  else if (kind == "sum") out.mode = (!info.monotonic && info.points > 0 && out.any_cumulative) ? Mode::Gauge : Mode::Delta;
  else if (kind == "histogram") out.mode = Mode::Histogram;
  else if (kind == "exponential_histogram") out.mode = Mode::Exponential;
  else out.mode = is_quantile_agg(out.agg) ? Mode::SummaryQuantile : Mode::SummaryDelta;
  out.per_series = out.mode == Mode::SummaryQuantile;
  *plan = std::move(out);
  return true;
}

std::string summary_quantile_literal(const MetricInfo& info, const std::string& agg) {
  std::string literal;
  for (const auto& q : info.quantiles) {
    if (quantile_agg_name(text_to_double(q)) == agg) literal = q;
  }
  if (literal.empty()) literal = std::to_string(quantile_of(agg));
  return literal;
}

// ---- rows to groups ----

void add_series_row(const clickhouse::Block& block, size_t row, Mode mode, std::map<std::string, Group>* groups) {
  std::string g = ch_block_text_at(block, 0, row);
  Group& group = (*groups)[g];
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

RankedGroups rank_groups(std::map<std::string, Group>* groups, Mode mode, const std::string& agg, double bucket_seconds, int top_k,
                         bool per_series) {
  // Rank groups: quantiles by their observation count, everything else by the sum of |value| over the buckets.
  const bool rank_by_count = (mode == Mode::Histogram || mode == Mode::Exponential) && is_quantile_agg(agg);
  RankedGroups out;
  for (auto& [key, group] : *groups) {
    double score = 0;
    for (const auto& [b, cell] : group.cells) {
      const double v = rank_by_count ? cell.count : cell_value(cell, mode, agg, bucket_seconds);
      if (std::isfinite(v)) score += std::fabs(v);
    }
    group.score = score;
    out.ordered.push_back(&group);
  }
  std::sort(out.ordered.begin(), out.ordered.end(), [](const Group* a, const Group* b) {
    if (a->score != b->score) return a->score > b->score;
    return a->key < b->key;
  });
  out.kept = std::min(out.ordered.size(), static_cast<size_t>(top_k));
  out.other.key = "__other__";
  if (!per_series) {
    for (size_t i = out.kept; i < out.ordered.size(); ++i) {
      ++out.other_count;
      out.other.score += out.ordered[i]->score;
      for (const auto& [b, cell] : out.ordered[i]->cells) {
        auto it = out.other.cells.find(b);
        if (it == out.other.cells.end()) out.other.cells.emplace(b, cell);
        else merge_cell(it->second, cell);
      }
    }
  }
  return out;
}

std::vector<int64_t> bucket_timestamps(const BucketGrid& grid, const TimeWindow& window) {
  std::vector<int64_t> timestamps;
  for (int64_t t = grid.floor(window.start_ms); t <= grid.floor(window.end_ms) && timestamps.size() < 5000; t += grid.size_ms) {
    timestamps.push_back(t);
  }
  return timestamps;
}

double covered_seconds(const BucketGrid& grid, const TimeWindow& window, int64_t t, double bucket_seconds) {
  const int64_t lo = std::max(t, window.start_ms);
  const int64_t hi = std::min(t + grid.size_ms, window.end_ms);
  return hi > lo ? static_cast<double>(hi - lo) / 1000.0 : bucket_seconds;
}

}  // namespace metrics
}  // namespace chdash
