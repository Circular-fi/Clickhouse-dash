#include "trace_json.hpp"

#include "facet_limits.hpp"
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

namespace {

uint64_t scaled_count(uint64_t value, double factor) { return static_cast<uint64_t>(std::llround(static_cast<double>(value) * factor)); }

void write_service_stats(Writer& w, const std::string& name, const ServiceStats& s, double factor) {
  w.StartArray();
  write_json_text(w, name);
  w.Uint64(scaled_count(s.spans, factor));
  w.Uint64(scaled_count(s.errors, factor));
  w.Uint64(s.p50); w.Uint64(s.p95); w.Uint64(s.p99);
  w.Uint64(static_cast<uint64_t>(std::llround(s.total_ns * factor)));
  w.EndArray();
}

}  // namespace

std::string services_json(const ServicesAnswer& answer) {
  const ServicesOutcome& out = answer.outcome;
  const bool detail = !answer.detail.empty();
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("scope"); write_json_text(w, answer.span_scope);
  w.Key("span_predicate"); write_json_text(w, out.span_kind);
  w.Key("detail"); write_json_text(w, answer.detail);
  w.Key("range"); w.StartArray(); w.Int64(out.range_start_ms); w.Int64(out.range_end_ms); w.EndArray();
  w.Key("window"); w.StartArray(); w.Int64(answer.start_ms); w.Int64(answer.end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(out.bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(out.origin_ms);
  w.Key("estimated"); w.Bool(out.window.sampled);
  w.Key("sample_fraction"); w.Double(out.window.sampled ? static_cast<double>(out.window.sampled_ms) / static_cast<double>(answer.end_ms - answer.start_ms) : 1.0);
  w.Key("estimated_rows"); w.Uint64(out.window.estimated_rows);
  w.Key("exact_rows_limit"); w.Uint64(kServicesExactRows);
  w.Key("partial"); w.Bool(out.partial);
  w.Key("timing_ms"); w.StartObject();
  w.Key("estimate"); w.Uint64(out.estimate_ms);
  w.Key("services"); w.Uint64(out.read.elapsed_ms);
  w.Key("slowest"); w.Uint64(out.slowest_ms);
  w.Key("releases"); w.Uint64(out.releases_ms);
  w.Key("total"); w.Uint64(answer.total_ms);
  w.EndObject();
  w.Key("columns"); w.StartArray();
  for (const char* col : {"service", "spans", "errors", "p50_ns", "p95_ns", "p99_ns", "total_ns"}) w.String(col);
  w.EndArray();
  w.Key("services"); w.StartArray();
  for (const auto& [name, stats] : out.services) write_service_stats(w, name, stats, out.window.factor);
  w.EndArray();
  w.Key("series_columns"); w.StartArray();
  for (const char* col : {"bucket_ms", "spans", "errors", "p50_ns", "p95_ns", "p99_ns"}) w.String(col);
  w.EndArray();
  w.Key("series"); w.StartObject();
  for (const auto& [name, buckets] : out.series) {
    write_json_key(w, name);
    w.StartArray();
    for (const auto& [bucket, stats] : buckets) {
      const double scale = out.window.sampled ? out.window.scale_for(bucket) : 1.0;
      w.StartArray(); w.Int64(bucket); w.Uint64(scaled_count(stats.spans, scale)); w.Uint64(scaled_count(stats.errors, scale));
      w.Uint64(stats.p50); w.Uint64(stats.p95); w.Uint64(stats.p99); w.EndArray();
    }
    w.EndArray();
  }
  w.EndObject();
  if (detail) {
    w.Key("endpoints_truncated"); w.Bool(out.endpoints.size() > kServicesMaxEndpoints);
    w.Key("endpoints"); w.StartArray();
    for (size_t i = 0; i < out.endpoints.size() && i < kServicesMaxEndpoints; ++i) {
      write_service_stats(w, out.endpoints[i].first, out.endpoints[i].second, out.window.factor);
    }
    w.EndArray();
    w.Key("slowest_columns"); w.StartArray();
    for (const char* col : {"trace_id", "span_id", "operation", "start_ms", "duration_ns", "status"}) w.String(col);
    w.EndArray();
    w.Key("slowest"); w.StartArray();
    for (const auto& span : out.slowest) {
      w.StartArray(); write_json_text(w, span.trace_id); write_json_text(w, span.span_id); write_json_text(w, span.operation);
      w.Int64(span.start_ms); w.Uint64(span.duration_ns); write_json_text(w, span.status); w.EndArray();
    }
    w.EndArray();
    w.Key("releases_supported"); w.Bool(out.releases_supported);
    w.Key("releases_estimated"); w.Bool(out.releases_estimated);
    w.Key("releases"); w.StartArray();
    for (const auto& release : out.releases) {
      w.StartArray(); write_json_text(w, release.version); w.Int64(release.first_ms); w.Uint64(release.spans); w.EndArray();
    }
    w.EndArray();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string services_db_json(const ServicesDbAnswer& answer) {
  const DbOutcome& out = answer.outcome;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("supported"); w.Bool(out.supported);
  w.Key("detail"); write_json_text(w, answer.detail);
  w.Key("range"); w.StartArray(); w.Int64(answer.start_ms); w.Int64(answer.end_ms); w.EndArray();
  // Estimated only when a cap stopped the read (the bloom filter index makes read_rows fall short of total_rows without one).
  w.Key("estimated"); w.Bool(out.read.read_rows >= kServicesDbReadRowsCap || timed_out(out.read));
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(out.read.elapsed_ms); w.EndObject();
  w.Key("columns"); w.StartArray();
  for (const char* col : {"service", "statement", "db_system", "spans", "errors", "total_ns", "p95_ns"}) w.String(col);
  w.EndArray();
  w.Key("statements"); w.StartArray();
  for (const auto& row : out.rows) {
    w.StartArray(); write_json_text(w, row.service); write_json_text(w, row.statement); write_json_text(w, row.system);
    w.Uint64(row.spans); w.Uint64(row.errors); w.Uint64(static_cast<uint64_t>(std::llround(row.total_ns))); w.Uint64(row.p95);
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string meta_json(const MetaAnswer& answer) {
  const TraceSettings& traces = answer.traces;
  const MetaOutcome& outcome = answer.outcome;
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("analytics_enabled"); w.Bool(traces.analytics);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("database"); write_json_text(w, traces.database);
  w.Key("table"); write_json_text(w, traces.table);
  w.Key("trace_index_table"); write_json_text(w, traces.trace_index_table);
  w.Key("trace_index_available"); w.Bool(outcome.index_available);
  w.Key("schema_ok"); w.Bool(outcome.schema_ok);
  w.Key("default_lookback_minutes"); w.Int(traces.default_lookback_minutes);
  w.Key("max_lookback_minutes"); w.Int(traces.max_lookback_minutes);
  w.Key("search_limit"); w.Uint64(traces.search_limit);
  w.Key("max_spans_per_trace"); w.Uint64(traces.max_spans_per_trace);
  w.Key("tag_search_supported"); w.Bool(outcome.span_attribute_map || outcome.resource_attribute_map);
  w.Key("span_attribute_map"); w.Bool(outcome.span_attribute_map);
  w.Key("resource_attribute_map"); w.Bool(outcome.resource_attribute_map);
  w.Key("highlighted_attributes"); write_string_array(w, traces.highlighted_attributes);
  w.Key("linked_from_margin_minutes"); w.Int(traces.linked_from_margin_minutes);
  w.Key("context_windows_ms"); w.StartArray();
  for (int64_t window : kContextWindowsMs) w.Int64(window);
  w.EndArray();
  w.Key("features");
  w.StartObject();
  w.Key("service_filter"); w.Bool(traces.features.service_filter);
  w.Key("operation_filter"); w.Bool(traces.features.operation_filter);
  w.Key("status_filter"); w.Bool(traces.features.status_filter);
  w.Key("duration_filter"); w.Bool(traces.features.duration_filter);
  w.Key("resource_attributes"); w.Bool(traces.features.resource_attributes);
  w.Key("span_attributes"); w.Bool(traces.features.span_attributes);
  w.Key("events"); w.Bool(traces.features.events);
  w.Key("links"); w.Bool(traces.features.links);
  w.EndObject();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string prefill_json(const PrefillAnswer& answer) {
  const Prefill& value = *answer.value;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("range"); w.StartArray(); w.Int64(answer.start_ms); w.Int64(answer.end_ms); w.EndArray();
  w.Key("truncated"); w.Bool(value.truncated);
  w.Key("tag_filtered"); w.Bool(answer.tag_filtered);
  w.Key("estimated"); w.Bool(value.estimated);
  // The scan that filled the cache entry: passes run and rows read.
  w.Key("scan"); w.StartObject();
  w.Key("passes"); w.Int(value.passes);
  w.Key("read_rows"); w.Uint64(value.read_rows);
  w.Key("read_rows_limit"); w.Uint64(answer.read_budget);
  w.EndObject();
  w.Key("pairs"); w.StartArray();
  for (const auto& [service, operation] : value.pairs) {
    // The count column is kept for payload compatibility (existence only).
    w.StartArray(); write_json_text(w, service); write_json_text(w, operation); w.Uint64(1); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

namespace {

void write_facet_common(Writer& w, const FacetRequest& request, bool estimated, bool timed_out_flag, uint64_t query_ms, bool cached,
                        uint64_t read_rows_cap) {
  w.Key("range"); w.StartArray(); w.Int64(request.start_ms); w.Int64(request.end_ms); w.EndArray();
  w.Key("scanned_range"); w.StartArray(); w.Int64(request.aligned_start_ms); w.Int64(request.aligned_end_ms); w.EndArray();
  w.Key("estimated"); w.Bool(estimated);
  w.Key("timed_out"); w.Bool(timed_out_flag);
  w.Key("sample_limit"); w.Uint64(kFacetSampleRows);
  w.Key("read_rows_limit"); w.Uint64(read_rows_cap);
  w.Key("cached"); w.Bool(cached);
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(query_ms); w.EndObject();
}

}  // namespace

std::string facet_keys_json(const FacetKeysAnswer& answer) {
  const FacetKeys& value = *answer.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("supported"); w.Bool(answer.span || answer.resource);
  w.Key("scopes"); w.StartArray(); if (answer.span) w.String("span"); if (answer.resource) w.String("resource"); w.EndArray();
  write_facet_common(w, answer.request, value.estimated, value.timed_out, value.query_ms, answer.cached, answer.request.read_cap);
  w.Key("sampled_spans"); w.Uint64(value.sampled_spans);
  w.Key("truncated"); w.Bool(value.keys.size() > kFacetMaxKeys);
  w.Key("keys"); w.StartArray();
  for (size_t i = 0; i < value.keys.size() && i < kFacetMaxKeys; ++i) {
    const auto& key = value.keys[i];
    w.StartArray(); write_json_text(w, key.scope); write_json_text(w, key.key); w.Uint64(key.count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string facet_values_json(const FacetValuesAnswer& answer) {
  const FacetValues& value = *answer.value;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("scope"); write_json_text(w, answer.request.key_scope);
  w.Key("key"); write_json_text(w, answer.request.key);
  w.Key("limit"); w.Int(answer.request.limit);
  write_facet_common(w, answer.request, value.estimated, value.timed_out, value.query_ms, answer.cached, answer.request.read_cap);
  w.Key("spans_with_key"); w.Uint64(value.spans_with_key);
  w.Key("distinct_values"); w.Uint64(value.distinct_values);
  w.Key("has_more"); w.Bool(value.distinct_values > value.values.size());
  w.Key("values"); w.StartArray();
  for (const auto& [text, count] : value.values) {
    w.StartArray(); write_json_text(w, text); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string trace_detail_json(const TraceDetailAnswer& answer) {
  const TraceFeatureSettings& f = answer.features;
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("trace_id"); write_json_text(w, answer.trace_id);
  w.Key("range_source"); w.String("trace_index");
  w.Key("truncated"); w.Bool(answer.truncated);
  w.Key("spans"); w.StartArray();
  for (const auto& span : answer.spans) {
    w.StartObject();
    w.Key("timestamp"); write_json_text(w, span.timestamp);
    w.Key("start_ns"); w.Int64(span.start_ns);
    w.Key("duration_ns"); w.Uint64(span.duration_ns);
    w.Key("trace_id"); write_json_text(w, span.trace_id);
    w.Key("span_id"); write_json_text(w, span.span_id);
    w.Key("parent_span_id"); write_json_text(w, span.parent_span_id);
    w.Key("span_name"); write_json_text(w, span.name);
    w.Key("span_kind"); write_json_text(w, span.kind);
    w.Key("service_name"); write_json_text(w, span.service);
    w.Key("status_code"); write_json_text(w, span.status);
    w.Key("status_message"); write_json_text(w, span.status_message);
    if (f.span_attributes) { w.Key("span_attributes"); write_json_text(w, span.span_attributes); }
    if (f.resource_attributes) { w.Key("resource_attributes"); write_json_text(w, span.resource_attributes); }
    if (f.events) {
      w.Key("events_timestamp"); write_json_text(w, span.events_timestamp);
      w.Key("events_name"); write_json_text(w, span.events_name);
      w.Key("events_attributes"); write_json_text(w, span.events_attributes);
    }
    if (f.links) {
      w.Key("links_trace_id"); write_json_text(w, span.links_trace_id);
      w.Key("links_span_id"); write_json_text(w, span.links_span_id);
      w.Key("links_attributes"); write_json_text(w, span.links_attributes);
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string span_json(const SpanAnswer& answer) {
  const TraceFeatureSettings& f = answer.features;
  const auto& values = answer.values;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("span"); w.StartObject();
  w.Key("timestamp"); write_json_text(w, values[0]);
  w.Key("start_ns_text"); write_json_text(w, values[1]);
  w.Key("start_ns"); w.Int64(std::stoll(values[1]));
  w.Key("trace_id"); write_json_text(w, values[2]);
  w.Key("span_id"); write_json_text(w, values[3]);
  const std::string_view parent = visible_parent(values[4], answer.all_services);
  w.Key("parent_span_id"); write_json_text(w, parent);
  w.Key("service_name"); write_json_text(w, values[5]);
  w.Key("span_name"); write_json_text(w, values[6]);
  w.Key("span_kind"); write_json_text(w, values[7]);
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(values[8])));
  w.Key("status_code"); write_json_text(w, values[9]);
  w.Key("status_message"); write_json_text(w, values[10]);
  if (f.span_attributes) { w.Key("span_attributes"); write_json_text(w, values[11]); }
  if (f.resource_attributes) { w.Key("resource_attributes"); write_json_text(w, values[12]); }
  if (f.events) {
    w.Key("events_timestamp"); write_json_text(w, values[13]);
    w.Key("events_name"); write_json_text(w, values[14]);
    w.Key("events_attributes"); write_json_text(w, values[15]);
  }
  if (f.links) {
    w.Key("links_trace_id"); write_json_text(w, values[16]);
    w.Key("links_span_id"); write_json_text(w, values[17]);
    w.Key("links_attributes"); write_json_text(w, values[18]);
  }
  w.EndObject();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

namespace {

// start_ns is also sent as text: epoch nanoseconds pass 2^53, and the context keyset cursor must be exact.
void write_span_row(Writer& w, const SpanRow& row, bool with_links, bool all_services) {
  w.StartObject();
  w.Key("timestamp"); write_json_text(w, row.timestamp);
  w.Key("start_ns"); w.Int64(std::stoll(row.start_ns));
  w.Key("start_ns_text"); write_json_text(w, row.start_ns);
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
  w.Key("trace_id"); write_json_text(w, row.trace_id);
  w.Key("span_id"); write_json_text(w, row.span_id);
  const std::string_view parent = visible_parent(row.parent_span_id, all_services);
  w.Key("parent_span_id"); write_json_text(w, parent);
  w.Key("span_name"); write_json_text(w, row.name);
  w.Key("span_kind"); write_json_text(w, row.kind);
  w.Key("service_name"); write_json_text(w, row.service);
  w.Key("status_code"); write_json_text(w, row.status);
  if (with_links) {
    w.Key("link_span_ids"); write_json_text(w, row.link_span_ids);
    w.Key("link_attributes"); write_json_text(w, row.link_attributes);
  }
  w.EndObject();
}

}  // namespace

std::string linked_from_json(const LinkedFromAnswer& answer) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("trace_id"); write_json_text(w, answer.trace_id);
  w.Key("span_id"); write_json_text(w, answer.span_id);
  w.Key("range_source"); write_json_text(w, answer.range_source);
  w.Key("range"); w.StartArray(); w.Int64(answer.lo_ms); w.Int64(answer.hi_ms); w.EndArray();
  w.Key("margin_minutes"); w.Int(answer.margin_minutes);
  w.Key("limit"); w.Uint64(kLinkedFromLimit);
  w.Key("truncated"); w.Bool(answer.truncated);
  w.Key("elapsed_ms"); w.Double(answer.elapsed_ms);
  w.Key("rows"); w.StartArray();
  for (const auto& row : answer.rows) write_span_row(w, row, true, answer.all_services);
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string context_json(const ContextAnswer& answer) {
  const ContextOutcome& out = answer.outcome;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("timestamp_ns"); write_json_text(w, std::to_string(answer.request.anchor_ns));
  w.Key("window_ms"); w.Int64(answer.request.window_ms);
  w.Key("range_ns"); w.StartArray(); write_json_text(w, std::to_string(answer.lo_ns)); write_json_text(w, std::to_string(answer.hi_ns)); w.EndArray();
  w.Key("filter"); write_json_text(w, answer.request.filter);
  w.Key("direction"); write_json_text(w, answer.request.direction);
  w.Key("limit"); w.Int(answer.request.limit);
  if (out.query_newer) { w.Key("has_newer"); w.Bool(out.more_newer); }
  if (out.query_older) { w.Key("has_older"); w.Bool(out.more_older); }
  w.Key("elapsed_ms"); w.Double(out.elapsed_ms);
  w.Key("rows"); w.StartArray();
  for (auto it = out.newer.rbegin(); it != out.newer.rend(); ++it) write_span_row(w, *it, false, answer.all_services);
  for (const auto& row : out.older) write_span_row(w, row, false, answer.all_services);
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

std::string spans_json(const SpansAnswer& answer) {
  const SpansRequest& request = answer.request;
  const SpanSearchOutcome& out = answer.outcome;
  const bool has_more = !out.exhausted && out.next.present;
  const int64_t start_ns = request.start_ms * kNsPerMs;
  const int64_t searched_to_ns = out.exhausted ? start_ns : (out.next.present ? out.next.ts_ns : start_ns);
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  Writer w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, answer.source_host_id);
  w.Key("range"); w.StartArray(); w.Int64(request.start_ms); w.Int64(request.end_ms); w.EndArray();
  w.Key("limit"); w.Int(request.limit);
  w.Key("attribute_columns"); w.StartArray();
  for (const auto& column : request.columns) {
    w.StartObject();
    w.Key("scope"); write_json_text(w, column.scope);
    w.Key("key"); write_json_text(w, column.key);
    w.EndObject();
  }
  w.EndArray();
  w.Key("has_more"); w.Bool(has_more);
  w.Key("cursor");
  if (has_more) write_json_text(w, encode_span_cursor(out.next)); else w.Null();
  w.Key("incomplete"); w.Bool(out.incomplete);
  w.Key("budget_ms"); w.Double(request.budget_ms);
  w.Key("stop_reason"); write_json_text(w, out.stop_reason);
  w.Key("searched_to_ns"); write_json_text(w, std::to_string(searched_to_ns));
  w.Key("slices"); w.StartArray();
  for (const auto& slice : out.slices) {
    w.StartObject();
    w.Key("start_ns"); write_json_text(w, std::to_string(slice.lo_ns));
    w.Key("end_ns"); write_json_text(w, std::to_string(slice.hi_ns));
    w.Key("rows"); w.Uint64(slice.rows);
    w.Key("ms"); w.Double(std::round(slice.ms * 10.0) / 10.0);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("queries"); w.Double(std::round(out.query_ms * 10.0) / 10.0);
  w.Key("total"); w.Double(std::round(answer.total_ms * 10.0) / 10.0);
  w.EndObject();
  w.Key("rows"); w.StartArray();
  for (const auto& row : out.rows) {
    w.StartObject();
    w.Key("timestamp"); write_json_text(w, row.timestamp);
    w.Key("start_ns"); write_json_text(w, row.start_ns);
    w.Key("trace_id"); write_json_text(w, row.trace_id);
    w.Key("span_id"); write_json_text(w, row.span_id);
    const std::string_view parent = visible_parent(row.parent_span_id, answer.all_services);
    w.Key("parent_span_id"); write_json_text(w, parent);
    w.Key("service_name"); write_json_text(w, row.service);
    w.Key("span_name"); write_json_text(w, row.name);
    w.Key("span_kind"); write_json_text(w, row.kind);
    w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
    w.Key("status_code"); write_json_text(w, row.status);
    w.Key("status_message"); write_json_text(w, row.status_message);
    w.Key("attributes"); w.StartArray();
    for (const auto& [present, value] : row.attributes) {
      if (present) write_json_text(w, value); else w.Null();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

}  // namespace trace
}  // namespace chdash
