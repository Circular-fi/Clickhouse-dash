#include "trace_analytics.hpp"

#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "log.hpp"
#include "sql_literal.hpp"
#include "trace_search.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace chdash {
namespace trace {

namespace {

uint64_t elapsed_ms_since(std::chrono::steady_clock::time_point since) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - since).count());
}

}  // namespace

// ---- the charts ----

bool parse_charts(const std::string& charts, bool* want_counts, bool* want_durations) {
  *want_counts = charts.empty() || charts.find("counts") != std::string::npos;
  *want_durations = charts.empty() || charts.find("durations") != std::string::npos;
  return *want_counts || *want_durations;
}

Result<AnalyticsOutcome> run_analytics(ChExecutor& db, const TraceScope& scope, bool key_only_filters, const AnalyticsGrid& grid,
                                       bool want_counts, bool want_durations) {
  using Out = Result<AnalyticsOutcome>;
  AnalyticsOutcome out;
  out.grid = grid;
  const bool has_candidate_filters = !scope.span_filters.empty();
  const bool index_counts_eligible = want_counts && !want_durations && scope.has_index() && !has_candidate_filters &&
      scope.having.empty() && scope.all_services();

  if (index_counts_eligible) {
    try {
      const auto started = std::chrono::steady_clock::now();
      std::map<int64_t, uint64_t> count_by_bucket;
      db.select(index_counts_sql(scope.index_table, scope.start_ms, scope.end_ms, grid.bucket_ms, grid.count_origin_ms),
                [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          count_by_bucket[std::stoll(ch_block_text_at(block, 0, row))] +=
              static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row)));
        }
      });
      for (const auto& [bucket, count] : count_by_bucket) out.trace_counts.emplace_back(bucket, count);
      out.query_ms = elapsed_ms_since(started);
      out.analytics_path = "trace_index";
      out.trace_count_source = "trace_index";
      out.have_counts = true;
    } catch (const std::exception& e) {
      log_event(LogLevel::Warn, "traces.index_fallback", {{"route", "analytics"}, {"reason", "index_error"}, {"error", std::string(e.what()).substr(0, 300)}});
      // An index that is absent or unreadable uses the span aggregation instead. This runs on a fresh connection.
      // A failed query may leave the old connection unusable.
      out.trace_counts.clear();
      std::string error;
      if (!db.renew(&error)) {
        return Out::fail(make_error(503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error));
      }
    }
  }

  if (!out.have_counts) {
    const auto started = std::chrono::steady_clock::now();
    const bool broad = key_only_filters && filters_are_broad(db, scope);
    std::map<int64_t, uint64_t> count_by_bucket;
    db.select(analytics_sql(scope, broad, grid), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const int64_t q_bucket_ms = std::stoll(ch_block_text_at(block, 0, row));
        const uint64_t count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row)));
        count_by_bucket[grid_floor_ms(q_bucket_ms, grid.bucket_ms, grid.count_origin_ms)] += count;
        out.quantiles.push_back(AnalyticsOutcome::Quantile{
            q_bucket_ms,
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)))});
      }
    });
    for (const auto& [bucket, count] : count_by_bucket) out.trace_counts.emplace_back(bucket, count);
    out.query_ms = elapsed_ms_since(started);
    out.have_counts = true;
    out.have_durations = true;
  }
  return Out::ok(std::move(out));
}

// ---- the heatmap ----

namespace {

double fine_bin_edge_ns(int bin) { return std::exp2(static_cast<double>(bin) / kHeatmapBinsPerOctave); }

}  // namespace

HeatmapBins bin_heatmap(const std::map<std::pair<int64_t, int>, uint64_t>& fine_cells, const std::map<int, uint64_t>& fine_totals,
                        int rows_wanted) {
  HeatmapBins out;
  for (const auto& [bin, count] : fine_totals) out.total += count;
  if (out.total > 0) {
    // The fine bin that holds the 1 % quantile, and the slowest bin.
    const uint64_t cut = std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(static_cast<double>(out.total) * 0.01)));
    uint64_t seen = 0;
    int lo_bin = fine_totals.begin()->first;
    for (const auto& [bin, count] : fine_totals) {
      seen += count;
      if (seen >= cut) { lo_bin = bin; break; }
    }
    const int hi_bin = fine_totals.rbegin()->first;
    const int span = hi_bin - lo_bin + 1;
    out.rows = std::min(rows_wanted, span);
    const int rows = out.rows;
    // Row r holds the fine bins f with floor((f - lo) * rows / span) == r.
    const auto row_of = [&](int bin) { return bin <= lo_bin ? 0 : static_cast<int>((static_cast<int64_t>(bin - lo_bin) * rows) / span); };
    for (int r = 0; r <= rows; ++r) {
      const int first_bin = lo_bin + static_cast<int>((static_cast<int64_t>(r) * span + rows - 1) / rows);
      out.edges.push_back(fine_bin_edge_ns(first_bin));
    }
    for (const auto& [key, count] : fine_cells) {
      out.cells[{key.first, row_of(key.second)}] += count;
      if (key.second < lo_bin) out.below_count += count;
    }
  }
  for (const auto& [key, count] : out.cells) out.max_count = std::max(out.max_count, count);
  return out;
}

HeatmapOutcome run_heatmap(ChExecutor& db, const TraceScope& scope, bool key_only_filters, int64_t bucket_ms, int64_t origin_ms) {
  HeatmapOutcome out;
  const auto started = std::chrono::steady_clock::now();
  // The analytics have their own cheap path for broad service / operation filters.
  out.broad = key_only_filters && filters_are_broad(db, scope);
  db.select(heatmap_sql(scope, out.broad, bucket_ms, origin_ms), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const int64_t bucket = std::stoll(ch_block_text_at(block, 0, row));
      const int bin = std::stoi(ch_block_text_at(block, 1, row));
      const uint64_t count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
      out.fine_cells[{bucket, bin}] += count;
      out.fine_totals[bin] += count;
    }
  });
  out.query_ms = elapsed_ms_since(started);
  return out;
}

// ---- the deltas ----

namespace {

std::string lower_ascii(std::string_view text) {
  std::string out(text);
  for (char& ch : out) if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
  return out;
}

bool ends_with(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

}  // namespace

// Identifier and timestamp keys are not useful. Every value is (nearly) unique, so these keys never explain a difference.
// They also crowd the list of ranked keys. The high-cardinality rule below catches most of them anyway. The names catch the small samples.
bool id_or_time_key(std::string_view key) {
  const std::string k = lower_ascii(key);
  for (std::string_view suffix : {"trace_id", "traceid", "span_id", "spanid", "parent_id", "parentid",
                                  "request_id", "requestid", "correlation_id", "uuid", "guid",
                                  "timestamp", "time_unix_nano", "_time", ".time", "_at", ".ts"}) {
    if (ends_with(k, suffix)) return true;
  }
  return false;
}

bool id_like_value(std::string_view value) {
  size_t hex = 0, digits = 0;
  for (char ch : value) {
    if ((ch >= '0' && ch <= '9')) { ++hex; ++digits; }
    else if ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) ++hex;
    else if (ch != '-') return false;
  }
  return (value.size() >= 16 && hex >= 16) || digits >= 13;
}

// Well-known OTel semantic-convention keys win ties (HyperDX semanticBoost).
bool semconv_key(std::string_view key) {
  const std::string k = lower_ascii(key);
  for (std::string_view suffix : {"service.name", "http.method", "http.request.method", "http.status_code",
                                  "http.response.status_code", "http.route", "error", "error.type", "exception.type",
                                  "deployment.environment", "deployment.environment.name", "rpc.method", "rpc.service",
                                  "rpc.grpc.status_code", "db.system", "db.operation", "db.operation.name",
                                  "messaging.system", "messaging.operation", "k8s.pod.name", "host.name",
                                  "cloud.region", "service.version"}) {
    if (k == suffix || ends_with(k, std::string(".") + std::string(suffix))) return true;
  }
  return false;
}

DeltaRanking rank_deltas(std::vector<DeltaKey> keys, uint64_t n_in, uint64_t n_out, uint64_t total_in, uint64_t total_out,
                         bool baseline_all) {
  DeltaRanking out;
  // Baseline shares come from the outside sample. They can also come from all traces of the sampled time range.
  // Both samples are weighted by the traces that they stand for.
  const double all_total = static_cast<double>(total_in + total_out);
  const auto baseline_pct = [&](const DeltaValue& v) {
    const double out_share = n_out ? static_cast<double>(v.n_out) / static_cast<double>(n_out) : 0.0;
    if (!baseline_all) return out_share * 100.0;
    const double in_share = n_in ? static_cast<double>(v.n_in) / static_cast<double>(n_in) : 0.0;
    return all_total > 0 ? (in_share * static_cast<double>(total_in) + out_share * static_cast<double>(total_out)) / all_total * 100.0 : 0.0;
  };
  for (auto& key : keys) {
    const uint64_t occ = key.occ_in + key.occ_out;
    size_t id_values = 0;
    for (const auto& v : key.values) if (id_like_value(v.value)) ++id_values;
    if (key.scope != "column" && (id_or_time_key(key.key) || (!key.values.empty() && id_values * 5 >= key.values.size() * 4))) {
      out.hidden.push_back({key.scope, key.key, "id_like"});
      continue;
    }
    if (occ > 20) {
      const double u_in = key.occ_in ? static_cast<double>(key.uniq_in) / static_cast<double>(key.occ_in) : -1.0;
      const double u_out = key.occ_out ? static_cast<double>(key.uniq_out) / static_cast<double>(key.occ_out) : -1.0;
      const double uniqueness = u_in >= 0 && u_out >= 0 ? std::min(u_in, u_out) : std::max(u_in, u_out);
      if (uniqueness > 0.9) {
        out.hidden.push_back({key.scope, key.key, "high_cardinality"});
        continue;
      }
    }
    double best = 0;
    for (auto& v : key.values) {
      v.in_pct = n_in ? static_cast<double>(v.n_in) / static_cast<double>(n_in) * 100.0 : 0.0;
      v.base_pct = baseline_pct(v);
      best = std::max(best, std::fabs(v.in_pct - v.base_pct));
    }
    if (best < 0.5) continue;  // same distribution on both sides
    key.boosted = key.scope == "column" || semconv_key(key.key);
    key.score = best + (key.boosted ? 2.0 : 0.0);
    std::sort(key.values.begin(), key.values.end(), [](const DeltaValue& a, const DeltaValue& b) {
      const double da = std::fabs(a.in_pct - a.base_pct), db = std::fabs(b.in_pct - b.base_pct);
      if (da != db) return da > db;
      return a.value < b.value;
    });
    if (key.values.size() > kDeltaValuesShown) key.values.resize(kDeltaValuesShown);
    out.ranked.push_back(std::move(key));
  }
  std::sort(out.ranked.begin(), out.ranked.end(), [](const DeltaKey& a, const DeltaKey& b) {
    if (a.score != b.score) return a.score > b.score;
    if (a.scope != b.scope) return a.scope < b.scope;
    return a.key < b.key;
  });
  out.ranked_keys = out.ranked.size();
  if (out.ranked.size() > kDeltaMaxKeys) out.ranked.resize(kDeltaMaxKeys);
  return out;
}

DeltaSamples read_delta_samples(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, uint64_t d0_ns, uint64_t d1_ns,
                                int sample) {
  DeltaSamples out;
  const auto started = std::chrono::steady_clock::now();
  db.select(deltas_sample_sql(scope, windows, d0_ns, d1_ns, sample), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      const bool in = ch_block_text_at(block, 1, row) == "1";
      const uint64_t side_total = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
      (in ? out.ids_in : out.ids_out).push_back(ch_block_text_at(block, 0, row));
      (in ? out.total_in : out.total_out) = side_total;
    }
  });
  out.sample_ms = elapsed_ms_since(started);
  return out;
}

std::vector<DeltaKey> read_delta_keys(ChExecutor& db, const TraceScope& scope, const DeltaWindows& windows, const DeltaSamples& samples,
                                      const AttributeColumns& columns, uint64_t* attributes_ms) {
  std::vector<DeltaKey> keys;
  const auto started = std::chrono::steady_clock::now();
  std::vector<std::string> all_ids = samples.ids_in;
  all_ids.insert(all_ids.end(), samples.ids_out.begin(), samples.ids_out.end());
  const std::string sql = deltas_attribute_sql(scope, windows, columns.span(), columns.resource(), samples.ids_in.size(), samples.ids_out.size());
  std::map<std::pair<std::string, std::string>, size_t> index;
  // The ids go as parameters. Two lists of up to 2,500 ids, passed as text, exceed max_query_size.
  const ChParams id_params = {{"ids_in", sql::hex_id_array(samples.ids_in)}, {"all_ids", sql::hex_id_array(all_ids)}};
  db.select(sql, id_params, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      auto key = std::make_pair(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
      auto it = index.find(key);
      if (it == index.end()) {
        DeltaKey stat;
        stat.scope = key.first;
        stat.key = key.second;
        stat.uniq_in = std::stoull(ch_block_text_at(block, 2, row));
        stat.uniq_out = std::stoull(ch_block_text_at(block, 3, row));
        stat.occ_in = std::stoull(ch_block_text_at(block, 4, row));
        stat.occ_out = std::stoull(ch_block_text_at(block, 5, row));
        it = index.emplace(key, keys.size()).first;
        keys.push_back(std::move(stat));
      }
      DeltaValue value;
      value.value = ch_block_text_at(block, 6, row);
      value.n_in = std::stoull(ch_block_text_at(block, 7, row));
      value.n_out = std::stoull(ch_block_text_at(block, 8, row));
      keys[it->second].values.push_back(std::move(value));
    }
  });
  *attributes_ms = elapsed_ms_since(started);
  return keys;
}

// ---- the service map ----

namespace {

double elapsed_ms_double(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - since).count();
}

}  // namespace

Result<ServiceMapOutcome> run_service_map(ChExecutor& db, const TraceScope& scope, int forced_factor) {
  using Out = Result<ServiceMapOutcome>;
  ServiceMapOutcome out;
  const int64_t window_ms = scope.end_ms - scope.start_ms;

  // The code counts the spans in the window from the primary index alone. It uses the EXPLAIN ESTIMATE rows: database, table, parts, rows, marks.
  // The FROM (EXPLAIN ...) form needs CREATE TEMPORARY TABLE. So the code sums the rows here.
  const auto estimate_started = std::chrono::steady_clock::now();
  try {
    db.select(service_map_estimate_sql(scope.table, scope.start_ms, scope.end_ms), [&](const clickhouse::Block& block) {
      if (block.GetColumnCount() < 4 || block.GetRowCount() == 0) return;
      const auto rows = block[3]->As<clickhouse::ColumnUInt64>();
      if (!rows) throw std::runtime_error("EXPLAIN ESTIMATE returned no rows column.");
      for (size_t row = 0; row < block.GetRowCount(); ++row) out.estimated_spans += rows->At(row);
    });
  } catch (const std::exception& e) {
    log_event(LogLevel::Warn, "traces.estimate_failed", {{"route", "service_map"}, {"error", std::string(e.what()).substr(0, 300)}});
    // Without an estimate, the window size decides. The read budget is assumed to cover ten minutes.
    // This runs on a fresh connection; see analytics.
    out.estimate_source = "window";
    out.estimated_spans = kServiceMapReadRows * static_cast<uint64_t>(std::max<int64_t>(1, window_ms / kServiceMapFallbackWindowMs));
    std::string error;
    if (!db.renew(&error)) {
      return Out::fail(make_error(503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error));
    }
  }
  out.estimate_ms = elapsed_ms_double(estimate_started);

  out.sampling = service_map_sampling(scope.start_ms, scope.end_ms, out.estimated_spans, forced_factor);

  const auto query_started = std::chrono::steady_clock::now();
  db.select(service_map_sql(scope, out.sampling), [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      ServiceMapStats stats;
      stats.count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)));
      stats.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
      stats.p50 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
      stats.p95 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row)));
      stats.p99 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 7, row)));
      if (ch_block_text_at(block, 0, row) == "1") out.nodes.push_back(ServiceMapNode{ch_block_text_at(block, 2, row), stats});
      else out.edges.push_back(ServiceMapEdge{ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), stats,
                                              static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)))});
    }
  });
  out.query_ms = elapsed_ms_double(query_started);

  // The busiest come first. A map beyond these sizes is unreadable anyway.
  std::sort(out.nodes.begin(), out.nodes.end(), [](const ServiceMapNode& a, const ServiceMapNode& b) {
    return a.stats.count != b.stats.count ? a.stats.count > b.stats.count : a.service < b.service;
  });
  std::sort(out.edges.begin(), out.edges.end(), [](const ServiceMapEdge& a, const ServiceMapEdge& b) {
    if (a.stats.count != b.stats.count) return a.stats.count > b.stats.count;
    return a.source != b.source ? a.source < b.source : a.target < b.target;
  });
  out.truncated = out.nodes.size() > kServiceMapMaxNodes || out.edges.size() > kServiceMapMaxEdges;
  if (out.nodes.size() > kServiceMapMaxNodes) out.nodes.resize(kServiceMapMaxNodes);
  if (out.edges.size() > kServiceMapMaxEdges) out.edges.resize(kServiceMapMaxEdges);
  return Out::ok(std::move(out));
}

}  // namespace trace
}  // namespace chdash
