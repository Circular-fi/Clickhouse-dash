#include "trace_json.hpp"

#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cmath>
#include <unordered_map>

namespace chdash {
namespace trace {

namespace {

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

void write_string_array(Writer& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) write_json_text(w, value);
  w.EndArray();
}

}  // namespace

std::string search_json(const SearchAnswer& answer) {
  const SearchOutcome& outcome = answer.outcome;
  std::vector<std::string> service_dict;
  std::unordered_map<std::string, size_t> service_index;
  auto intern_service = [&](const std::string& name) -> size_t {
    auto it = service_index.find(name);
    if (it != service_index.end()) return it->second;
    const size_t idx = service_dict.size();
    service_dict.push_back(name);
    service_index.emplace(name, idx);
    return idx;
  };
  for (const auto& row : outcome.rows) {
    intern_service(row.service);
    for (const auto& stat : row.service_stats) intern_service(stat.service);
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(3);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("search_path"); write_json_text(w, outcome.search_path);
  if (!outcome.fallback_reason.empty()) { w.Key("fallback_reason"); write_json_text(w, outcome.fallback_reason); }
  w.Key("timing_ms"); w.StartObject();
  w.Key("candidates"); w.Uint64(outcome.candidate_ms);
  w.Key("summary"); w.Uint64(outcome.summary_ms);
  w.Key("total"); w.Uint64(answer.total_ms);
  w.EndObject();
  w.Key("services"); write_string_array(w, service_dict);
  w.Key("columns"); w.StartArray();
  for (const char* col : {"trace_id", "start_ms", "root_operation", "root_service", "duration_ns", "span_count", "error_count", "service_stats", "missing_parents"}) w.String(col);
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : outcome.rows) {
    w.StartArray();
    write_json_text(w, row.trace_id); w.Int64(row.start_ms); write_json_text(w, row.operation); w.Uint64(intern_service(row.service));
    w.Uint64(row.duration_ns); w.Uint64(row.spans); w.Uint64(row.errors);
    w.StartArray();
    for (const auto& stat : row.service_stats) {
      w.StartArray(); w.Uint64(intern_service(stat.service)); w.Uint64(stat.spans); w.Uint64(stat.errors); w.Uint64(stat.first_span_ns);
      w.EndArray();
    }
    w.EndArray();
    // With a restricted allowlist a parent may be absent because it is hidden: the count would reveal it.
    w.Uint64(answer.all_services ? row.missing_parents : 0);
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string analytics_json(const AnalyticsAnswer& answer) {
  const AnalyticsOutcome& outcome = answer.outcome;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("analytics_path"); write_json_text(w, outcome.analytics_path);
  w.Key("duration_quantiles_source"); write_json_text(w, "span_bounds");
  w.Key("trace_count_source"); write_json_text(w, outcome.trace_count_source);
  w.Key("charts"); w.StartArray();
  if (outcome.have_counts) w.String("counts");
  if (outcome.have_durations) w.String("durations");
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("analytics"); w.Uint64(outcome.query_ms);
  w.Key("total"); w.Uint64(answer.total_ms);
  w.EndObject();
  w.Key("range"); w.StartArray(); w.Int64(outcome.grid.range_start_ms); w.Int64(outcome.grid.range_end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(outcome.grid.bucket_ms);
  w.Key("quantile_bucket_ms"); w.Int64(outcome.grid.quantile_bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(outcome.grid.count_origin_ms);
  w.Key("trace_count_chart"); w.StartArray();
  for (const auto& [bucket, count] : outcome.trace_counts) {
    w.StartArray(); w.Int64(bucket); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.Key("duration_quantiles"); w.StartArray();
  for (const auto& point : outcome.quantiles) {
    w.StartArray(); w.Int64(point.bucket_ms); w.Uint64(point.p50); w.Uint64(point.p90); w.Uint64(point.p95); w.Uint64(point.p99); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

namespace {

void write_service_map_stats(Writer& w, const ServiceMapStats& stats, double scale, const char* count_key) {
  w.Key(count_key); w.Uint64(static_cast<uint64_t>(std::llround(static_cast<double>(stats.count) * scale)));
  w.Key("errors"); w.Uint64(static_cast<uint64_t>(std::llround(static_cast<double>(stats.errors) * scale)));
  w.Key("error_rate"); w.Double(stats.count ? static_cast<double>(stats.errors) / static_cast<double>(stats.count) : 0.0);
  w.Key("sampled_count"); w.Uint64(stats.count);
  w.Key("p50_ns"); w.Uint64(stats.p50);
  w.Key("p95_ns"); w.Uint64(stats.p95);
  w.Key("p99_ns"); w.Uint64(stats.p99);
}

}  // namespace

std::string service_map_json(const ServiceMapAnswer& answer) {
  const ServiceMapOutcome& outcome = answer.outcome;
  const ServiceMapSampling& sampling = outcome.sampling;
  const double scale = sampling.scale();
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("range"); w.StartArray(); w.Int64(answer.start_ms); w.Int64(answer.end_ms); w.EndArray();
  w.Key("edge_rule"); w.String("parent_child_cross_service");
  w.Key("sampled"); w.Bool(sampling.sampled());
  w.Key("sample_factor"); w.Double(scale);
  w.Key("sampling"); w.StartObject();
  w.Key("trace_factor"); w.Uint64(sampling.trace_factor);
  w.Key("time_coverage"); w.Double(sampling.time_coverage);
  w.Key("slices"); w.Int(sampling.slices);
  w.Key("estimated_spans"); w.Uint64(outcome.estimated_spans);
  w.Key("estimate_source"); write_json_text(w, outcome.estimate_source);
  w.EndObject();
  w.Key("truncated"); w.Bool(outcome.truncated);
  w.Key("timing_ms"); w.StartObject();
  w.Key("estimate"); w.Double(outcome.estimate_ms);
  w.Key("query"); w.Double(outcome.query_ms);
  w.Key("total"); w.Double(answer.total_ms);
  w.EndObject();
  w.Key("nodes"); w.StartArray();
  for (const auto& node : outcome.nodes) {
    w.StartObject();
    w.Key("service"); write_json_text(w, node.service);
    write_service_map_stats(w, node.stats, scale, "spans");
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : outcome.edges) {
    w.StartObject();
    w.Key("source"); write_json_text(w, edge.source);
    w.Key("target"); write_json_text(w, edge.target);
    w.Key("kind"); w.String(edge.is_async() ? "async" : "sync");
    write_service_map_stats(w, edge.stats, scale, "calls");
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string heatmap_json(const HeatmapAnswer& answer) {
  const HeatmapBins& bins = answer.bins;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("unit"); w.String("traces");
  w.Key("unit_label"); w.String("Traces with a matching span, at their first span start, by span-bounds duration");
  w.Key("duration_source"); w.String("span_bounds");
  w.Key("heatmap_path"); w.String(answer.run.broad ? "broad_filters" : answer.has_filters ? "candidate_filters" : "span_aggregation");
  w.Key("range"); w.StartArray(); w.Int64(answer.range_start_ms); w.Int64(answer.range_end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(answer.bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(answer.origin_ms);
  w.Key("bins_per_octave"); w.Int(kHeatmapBinsPerOctave);
  w.Key("rows"); w.Int(bins.rows);
  w.Key("y_edges_ns"); w.StartArray();
  for (double edge : bins.edges) w.Double(std::round(edge * 1000.0) / 1000.0);
  w.EndArray();
  w.Key("total"); w.Uint64(bins.total);
  w.Key("below_min_count"); w.Uint64(bins.below_count);
  w.Key("max_count"); w.Uint64(bins.max_count);
  w.Key("cells"); w.StartArray();
  for (const auto& [key, count] : bins.cells) {
    w.StartArray(); w.Int64(key.first); w.Int(key.second); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("heatmap"); w.Uint64(answer.run.query_ms);
  w.Key("total"); w.Uint64(answer.total_ms);
  w.EndObject();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string deltas_json(const DeltasAnswer& answer) {
  const bool outside = answer.baseline == "outside";
  const uint64_t n_in = answer.samples.ids_in.size(), n_out = answer.samples.ids_out.size();
  const auto round2 = [](double value) { return std::round(value * 100.0) / 100.0; };
  const auto field_of = [](const DeltaKey& key) -> const char* {
    if (key.scope != "column") return "tag";
    if (key.key == "ServiceName") return "service";
    if (key.key == "SpanName") return "operation";
    return "status";
  };
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("unit"); w.String("traces");
  w.Key("box"); w.StartObject();
  w.Key("t0"); w.Int64(answer.t0);
  w.Key("t1"); w.Int64(answer.t1);
  w.Key("d0"); w.Double(answer.d0_ms);
  w.Key("d1"); w.Double(answer.d1_ms);
  w.EndObject();
  w.Key("baseline"); write_json_text(w, answer.baseline);
  w.Key("sample_limit"); w.Int(answer.sample);
  w.Key("sampled_windows"); w.StartArray();
  for (const auto& [lo, hi] : answer.windows.cores) { w.StartArray(); w.Int64(lo); w.Int64(hi); w.EndArray(); }
  w.EndArray();
  w.Key("sampled_ms"); w.Int64(answer.windows.sampled_ms);
  w.Key("window_sampled"); w.Bool(answer.window_sampled);
  w.Key("read_margin_ms"); w.Int64(answer.windows.margin_ms);
  w.Key("selection"); w.StartObject(); w.Key("sampled"); w.Uint64(n_in); w.Key("traces"); w.Uint64(answer.samples.total_in); w.EndObject();
  w.Key("baseline_sample"); w.StartObject();
  w.Key("sampled"); w.Uint64(outside ? n_out : n_in + n_out);
  w.Key("traces"); w.Uint64(outside ? answer.samples.total_out : answer.samples.total_in + answer.samples.total_out);
  w.EndObject();
  w.Key("ranked_keys"); w.Uint64(answer.ranking.ranked_keys);
  w.Key("keys"); w.StartArray();
  for (const auto& key : answer.ranking.ranked) {
    w.StartObject();
    w.Key("scope"); write_json_text(w, key.scope);
    w.Key("key"); write_json_text(w, key.key);
    w.Key("field"); w.String(field_of(key));
    w.Key("score"); w.Double(round2(key.score));
    w.Key("boosted"); w.Bool(key.boosted);
    w.Key("distinct_values"); w.Uint64(std::max(key.uniq_in, key.uniq_out));
    w.Key("values"); w.StartArray();
    for (const auto& v : key.values) {
      w.StartObject();
      w.Key("value"); write_json_text(w, v.value);
      w.Key("selection_pct"); w.Double(round2(v.in_pct));
      w.Key("baseline_pct"); w.Double(round2(v.base_pct));
      w.Key("selection_count"); w.Uint64(v.n_in);
      w.Key("baseline_count"); w.Uint64(outside ? v.n_out : v.n_in + v.n_out);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("hidden_keys"); w.StartArray();
  for (size_t i = 0; i < answer.ranking.hidden.size() && i < 50; ++i) {
    w.StartObject();
    w.Key("scope"); write_json_text(w, answer.ranking.hidden[i].scope);
    w.Key("key"); write_json_text(w, answer.ranking.hidden[i].key);
    w.Key("reason"); write_json_text(w, answer.ranking.hidden[i].reason);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("sample"); w.Uint64(answer.samples.sample_ms);
  w.Key("attributes"); w.Uint64(answer.attributes_ms);
  w.Key("total"); w.Uint64(answer.total_ms);
  w.EndObject();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

}  // namespace trace
}  // namespace chdash
