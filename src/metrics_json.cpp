#include "metrics_json.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <cmath>

namespace chdash {
namespace metrics {

namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

void write_number(JsonWriter& w, double value) {
  if (std::isfinite(value)) w.Double(value);
  else w.Null();
}

void write_str(JsonWriter& w, const std::string& value) { write_json_text(w, value); }

void write_timing(JsonWriter& w, int64_t query_ms, int64_t total_ms) {
  w.Key("timing_ms");
  w.StartObject();
  w.Key("query"); w.Int64(query_ms);
  w.Key("total"); w.Int64(total_ms);
  w.EndObject();
}

// The members of a JSON object of text that ClickHouse wrote (toJSONString(Attributes)), as the members of the object being written.
void write_labels(JsonWriter& w, const std::string& json) {
  rapidjson::Document doc;
  parse_json_bounded(doc, json);
  if (!doc.IsObject()) return;
  for (auto m = doc.MemberBegin(); m != doc.MemberEnd(); ++m) {
    if (!m->value.IsString()) continue;
    w.Key(m->name.GetString(), m->name.GetStringLength());
    w.String(m->value.GetString(), m->value.GetStringLength());
  }
}

}  // namespace

std::string catalog_json(const CatalogAnswer& answer) {
  const CatalogSnapshot& s = *answer.snapshot;
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_str(w, s.source_host_id);
  w.Key("range"); w.StartArray(); w.Int64(s.window.start_ms); w.Int64(s.window.end_ms); w.EndArray();
  w.Key("services");
  w.StartArray();
  for (const auto& [service, entries] : s.services) {
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
      // "monotonic" is true when any series is monotonic: this says that some are not.
      w.Key("monotonic_mixed");
      if (e.monotonic_mixed < 0) w.Null();
      else w.Bool(e.monotonic_mixed == 1);
      w.Key("points"); w.Int64(e.points);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("service_count"); w.Uint64(s.services.size());
  w.Key("metric_count"); w.Uint64(s.rows);
  w.Key("truncated"); w.Bool(s.truncated);
  w.Key("estimated"); w.Bool(s.estimated);
  w.Key("limit"); w.Uint64(kCatalogLimit);
  w.Key("kinds");
  w.StartArray();
  for (const char* kind : kKinds) {
    if (s.kinds.count(kind)) w.String(kind);
  }
  w.EndArray();
  if (s.kinds.empty()) {
    w.Key("error_code"); w.String("metrics_tables_missing");
    w.Key("message"); write_str(w, s.missing_message);
  }
  // Each answer reports its own timing: a hit spends no query time.
  write_timing(w, answer.query_ms, answer.total_ms);
  w.Key("cache");
  w.StartObject();
  w.Key("hit"); w.Bool(answer.hit);
  w.Key("age_ms"); w.Int64(answer.age_ms);
  w.Key("ttl_ms"); w.Int64(std::chrono::duration_cast<std::chrono::milliseconds>(kCatalogTtl).count());
  w.EndObject();
  w.EndObject();
  return sb.GetString();
}

std::string attributes_json(const AttributesAnswer& answer) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("kind"); write_str(w, answer.kind);
  w.Key("service"); write_str(w, answer.service);
  w.Key("metric"); write_str(w, answer.metric);
  if (answer.key.empty()) {
    w.Key("keys");
    w.StartArray();
    for (const auto& k : answer.keys) write_str(w, k);
    w.EndArray();
    w.Key("truncated"); w.Bool(answer.truncated);
  } else {
    w.Key("key"); write_str(w, answer.key);
    w.Key("values");
    w.StartArray();
    for (const auto& [value, points] : answer.values) {
      w.StartObject();
      w.Key("value"); write_str(w, value);
      w.Key("points"); w.Int64(points);
      w.EndObject();
    }
    w.EndArray();
    w.Key("truncated"); w.Bool(answer.truncated);
  }
  write_timing(w, answer.query_ms, answer.total_ms);
  w.EndObject();
  return sb.GetString();
}

std::string series_json(const SeriesAnswer& answer) {
  const SeriesRequest& request = answer.request;
  const AggregationPlan& plan = answer.plan;
  const double bucket_seconds = static_cast<double>(request.grid.size_ms) / 1000.0;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  JsonWriter w(sb);
  const auto write_series = [&](const Group& group, bool is_other) {
    w.StartObject();
    w.Key("key"); write_str(w, group.key);
    w.Key("labels");
    w.StartObject();
    if (!is_other) {
      if (plan.per_series) {
        write_labels(w, group.labels_json);
      } else if (!request.group_by.empty()) {
        const auto parts = split_keep(group.key, '\x1f');
        for (size_t i = 0; i < request.group_by.size(); ++i) {
          write_json_key(w, request.group_by[i]);
          write_str(w, i < parts.size() ? parts[i] : std::string{});
        }
      }
    }
    w.EndObject();
    w.Key("values");
    w.StartArray();
    for (int64_t t : answer.timestamps) {
      const auto it = group.cells.find(t);
      write_number(w, it == group.cells.end() ? kNaN
                                              : cell_value(it->second, plan.mode, plan.agg, covered_seconds(request.grid, request.window, t, bucket_seconds)));
    }
    w.EndArray();
    w.Key("total"); write_number(w, group.score);
    w.Key("other"); w.Bool(is_other);
    w.EndObject();
  };

  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_str(w, answer.source_host_id);
  w.Key("kind"); write_str(w, request.kind);
  w.Key("service"); write_str(w, request.service);
  w.Key("metric"); write_str(w, request.metric);
  w.Key("unit"); write_str(w, answer.info.unit);
  w.Key("description"); write_str(w, answer.info.description);
  const std::string temporality = request.kind == "gauge" || request.kind == "summary" ? std::string{} : temporality_name(answer.info);
  w.Key("temporality");
  if (temporality.empty()) w.Null();
  else write_str(w, temporality);
  w.Key("monotonic");
  if (request.kind == "sum" && answer.info.points > 0) w.Bool(answer.info.monotonic);
  else w.Null();
  w.Key("monotonic_mixed");
  if (request.kind == "sum" && answer.info.points > 0) w.Bool(monotonic_mixed(answer.info));
  else w.Null();
  w.Key("points"); w.Int64(answer.info.points);
  w.Key("agg"); write_str(w, plan.agg);
  w.Key("default_agg"); write_str(w, plan.default_agg);
  w.Key("aggs");
  w.StartArray();
  for (const auto& a : plan.aggs) write_str(w, a);
  w.EndArray();
  w.Key("value_unit"); write_str(w, answer.value_unit);
  w.Key("range"); w.StartArray(); w.Int64(request.window.start_ms); w.Int64(request.window.end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(request.grid.size_ms);
  w.Key("bucket_origin_ms"); w.Int64(request.grid.origin_ms);
  w.Key("group_by");
  w.StartArray();
  if (!plan.per_series) {
    for (const auto& k : request.group_by) write_str(w, k);
  }
  w.EndArray();
  w.Key("filters");
  w.StartArray();
  for (const auto& f : request.filters) {
    w.StartObject();
    w.Key("key"); write_str(w, f.key);
    w.Key("op"); write_str(w, f.op);
    w.Key("value"); write_str(w, f.value);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timestamps");
  w.StartArray();
  for (int64_t t : answer.timestamps) w.Int64(t);
  w.EndArray();
  w.Key("series");
  w.StartArray();
  for (const auto& group : answer.series) write_series(group, false);
  if (answer.other_count > 0) write_series(answer.other, true);
  w.EndArray();
  w.Key("other_series_count"); w.Uint64(answer.other_count);
  w.Key("group_count"); w.Uint64(answer.group_count);
  w.Key("top_k"); w.Int(request.top_k);
  w.Key("truncated"); w.Bool(answer.group_count > answer.series.size());
  w.Key("truncated_rows"); w.Bool(answer.truncated_rows);
  w.Key("per_series"); w.Bool(plan.per_series);
  w.Key("note");
  if (plan.per_series) {
    w.String("Summary quantiles are precomputed per series and cannot be aggregated across series: each series is shown "
             "separately and group by is ignored.");
  } else {
    w.Null();
  }
  write_timing(w, answer.query_ms, answer.total_ms);
  w.EndObject();
  return sb.GetString();
}

std::string exemplars_json(const ExemplarsAnswer& answer) {
  const ExemplarsRequest& request = answer.request;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_str(w, answer.source_host_id);
  w.Key("kind"); write_str(w, request.kind);
  w.Key("service"); write_str(w, request.service);
  w.Key("metric"); write_str(w, request.metric);
  w.Key("range"); w.StartArray(); w.Int64(request.window.start_ms); w.Int64(request.window.end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(request.grid.size_ms);
  w.Key("bucket_origin_ms"); w.Int64(request.grid.origin_ms);
  w.Key("exemplars");
  w.StartArray();
  for (const auto& e : answer.exemplars) {
    w.StartObject();
    w.Key("t"); w.Int64(e.t);
    w.Key("value"); write_number(w, e.value);
    w.Key("trace_id"); write_str(w, e.trace_id);
    w.Key("span_id"); write_str(w, e.span_id);
    w.Key("attributes");
    w.StartObject();
    write_labels(w, e.attributes_json);
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();
  w.Key("truncated"); w.Bool(answer.truncated);
  w.Key("per_bucket"); w.Int64(request.per_bucket);
  w.Key("traces_enabled"); w.Bool(answer.traces_enabled);
  write_timing(w, answer.query_ms, answer.total_ms);
  w.EndObject();
  return sb.GetString();
}

}  // namespace metrics
}  // namespace chdash
