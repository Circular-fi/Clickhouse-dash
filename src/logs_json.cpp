#include "logs_json.hpp"

#include "facet_limits.hpp"
#include "json_text.hpp"
#include "logs_filters.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {
namespace logs {

namespace {

using JsonWriter = rapidjson::Writer<rapidjson::StringBuffer>;

std::string text_of(const rapidjson::StringBuffer& sb) { return std::string(sb.GetString(), sb.GetSize()); }

void write_raw_object(JsonWriter& w, const std::string& json) {
  if (json.size() >= 2 && json.front() == '{' && json.back() == '}') w.RawValue(json.c_str(), json.size(), rapidjson::kObjectType);
  else w.RawValue("{}", 2, rapidjson::kObjectType);
}

void write_row(JsonWriter& w, const LogRow& row) {
  w.StartObject();
  w.Key("id"); write_json_text(w, cursor_text(Cursor{row.ts_ns, row.tie}));
  w.Key("ts_ns"); write_json_text(w, std::to_string(row.ts_ns));
  w.Key("ts_ms"); w.Int64(row.ts_ns / 1000000);
  w.Key("service"); write_json_text(w, row.service);
  w.Key("severity_text"); write_json_text(w, row.severity_text);
  w.Key("severity_number"); w.Int(row.severity_number);
  w.Key("body"); write_json_text(w, row.body);
  if (row.body_length > static_cast<int64_t>(kBodyMaxChars)) {
    w.Key("body_truncated"); w.Bool(true);
    w.Key("body_length"); w.Int64(row.body_length);
  }
  w.Key("trace_id"); write_json_text(w, row.trace_id);
  w.Key("span_id"); write_json_text(w, row.span_id);
  w.Key("trace_flags"); w.Int(row.trace_flags);
  w.Key("scope_name"); write_json_text(w, row.scope_name);
  w.Key("scope_version"); write_json_text(w, row.scope_version);
  w.Key("log_attributes"); write_raw_object(w, row.log_attrs);
  w.Key("resource_attributes"); write_raw_object(w, row.resource_attrs);
  w.Key("scope_attributes"); write_raw_object(w, row.scope_attrs);
  w.EndObject();
}

void write_text_search(JsonWriter& w, const TextSearchInfo& info) {
  w.Key("text_search");
  w.StartObject();
  w.Key("active"); w.Bool(info.active);
  w.Key("mode"); write_json_text(w, info.mode);
  w.Key("index_backed"); w.Bool(info.index_backed);
  w.EndObject();
}

void write_range(JsonWriter& w, int64_t start_ms, int64_t end_ms) {
  w.Key("range");
  w.StartArray();
  w.Int64(start_ms);
  w.Int64(end_ms);
  w.EndArray();
}

void write_total_timing(JsonWriter& w, int64_t total_ms) {
  w.Key("timing_ms");
  w.StartObject();
  w.Key("total"); w.Int64(total_ms);
  w.EndObject();
}

void write_facet_common(JsonWriter& w, const FacetCommon& common, bool estimated, bool timed_out_flag, uint64_t query_ms) {
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, common.source_host_id);
  write_range(w, common.start_ms, common.end_ms);
  w.Key("scanned_range"); w.StartArray(); w.Int64(common.scanned.start_ms); w.Int64(common.scanned.end_ms); w.EndArray();
  w.Key("estimated"); w.Bool(estimated);
  w.Key("timed_out"); w.Bool(timed_out_flag);
  w.Key("sample_limit"); w.Uint64(kFacetSampleRows);
  w.Key("read_rows_limit"); w.Uint64(kFacetReadRowsCap);
  w.Key("cached"); w.Bool(common.cached);
  write_text_search(w, common.text_search);
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(query_ms); w.EndObject();
}

}  // namespace

std::string search_json(const SearchAnswer& a) {
  rapidjson::StringBuffer sb(nullptr, 256 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, a.source_host_id);
  write_range(w, a.start_ms, a.end_ms);
  w.Key("limit"); w.Uint64(a.limit);
  w.Key("mode"); w.String("page");
  w.Key("rows"); w.StartArray();
  for (const auto& row : a.rows) write_row(w, row);
  w.EndArray();
  w.Key("row_count"); w.Uint64(a.rows.size());
  w.Key("next_cursor");
  if (a.next_cursor.empty()) w.Null(); else write_json_text(w, a.next_cursor);
  w.Key("exhausted"); w.Bool(a.exhausted);
  w.Key("truncated"); w.Bool(!a.exhausted);
  w.Key("budget_exhausted"); w.Bool(a.budget_exhausted);
  w.Key("scanned_from_ms"); w.Int64(a.scanned_from_ms);
  write_text_search(w, a.text_search);
  w.Key("windows"); w.StartArray();
  for (const auto& win : a.windows) {
    w.StartObject();
    w.Key("start_ms"); w.Int64(win.lo_ns / 1000000);
    w.Key("end_ms"); w.Int64(win.hi_ns / 1000000);
    w.Key("rows"); w.Uint64(win.rows);
    w.Key("ms"); w.Int64(win.ms);
    w.EndObject();
  }
  w.EndArray();
  write_total_timing(w, a.total_ms);
  w.EndObject();
  return text_of(sb);
}

std::string histogram_json(const HistogramAnswer& a) {
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, a.source_host_id);
  write_range(w, a.start_ms, a.end_ms);
  w.Key("grid_start_ms"); w.Int64(a.grid_start_ms);
  w.Key("bucket_ms"); w.Int64(a.bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(a.bucket_origin_ms);
  w.Key("classes"); w.StartArray();
  for (const auto& s : kSeverityClasses) w.String(s.name);
  w.EndArray();
  w.Key("buckets"); w.StartArray();
  for (const auto& b : a.buckets) {
    w.StartArray(); w.Int64(b.t);
    for (int k = 0; k < 4; ++k) w.Uint64(b.counts[k]);
    w.EndArray();
  }
  w.EndArray();
  w.Key("totals"); w.StartObject();
  uint64_t total = 0;
  for (int k = 0; k < 4; ++k) {
    w.Key(kSeverityClasses[k].name); w.Uint64(a.totals[k]);
    total += a.totals[k];
  }
  w.Key("total"); w.Uint64(total);
  w.EndObject();
  write_text_search(w, a.text_search);
  write_total_timing(w, a.total_ms);
  w.EndObject();
  return text_of(sb);
}

std::string context_json(const ContextAnswer& a) {
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, a.source_host_id);
  w.Key("preset"); write_json_text(w, a.preset);
  w.Key("window_ms"); w.Int64(a.window_ms);
  write_range(w, a.range_start_ms, a.range_end_ms);
  w.Key("anchor_id");
  if (a.has_anchor) write_json_text(w, a.anchor_id); else w.Null();
  w.Key("anchor_found"); w.Bool(a.anchor_found);
  w.Key("rows"); w.StartArray();
  for (const auto& row : a.rows) write_row(w, row);
  w.EndArray();
  w.Key("before_count"); w.Uint64(a.before_count);
  w.Key("after_count"); w.Uint64(a.after_count);
  w.Key("more_before"); w.Bool(a.more_before);
  w.Key("more_after"); w.Bool(a.more_after);
  write_total_timing(w, a.total_ms);
  w.EndObject();
  return text_of(sb);
}

std::string patterns_json(const PatternsAnswer& a) {
  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, a.source_host_id);
  write_range(w, a.start_ms, a.end_ms);
  w.Key("total"); w.Uint64(a.total);
  w.Key("sample_size"); w.Uint64(a.sample_size);
  w.Key("sample_target"); w.Uint64(a.sample_target);
  w.Key("sampled"); w.Bool(a.sample_size < a.total);
  w.Key("sample_method"); write_json_text(w, a.sample_method);
  w.Key("sample_rate_ppm"); w.Uint64(a.sample_rate_ppm);
  w.Key("scale"); w.Double(a.mined.scale);
  w.Key("noise_share"); w.Double(0.10);
  w.Key("mining_partial"); w.Bool(a.mined.partial);
  w.Key("pattern_count"); w.Uint64(a.mined.pattern_count);
  w.Key("sparkline_buckets"); w.Int(a.sparkline_buckets);
  w.Key("sparkline_bucket_ms"); w.Double(a.sparkline_bucket_ms);
  write_text_search(w, a.text_search);
  w.Key("patterns"); w.StartArray();
  for (const auto& p : a.mined.patterns) {
    w.StartObject();
    w.Key("pattern"); write_json_text(w, p.text);
    w.Key("sample_count"); w.Uint64(p.sample_count);
    w.Key("count"); w.Uint64(p.count);
    w.Key("share"); w.Double(p.share);
    w.Key("noisy"); w.Bool(p.noisy);
    w.Key("sample"); write_json_text(w, p.sample);
    w.Key("search"); write_json_text(w, p.search);
    w.Key("service"); write_json_text(w, p.service);
    w.Key("service_count"); w.Uint64(p.service_count);
    w.Key("severity"); w.String(p.severity.c_str());
    w.Key("sparkline"); w.StartArray();
    for (uint64_t n : p.sparkline) w.Uint64(n);
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("count"); w.Int64(a.count_ms);
  w.Key("sample"); w.Int64(a.sample_ms);
  w.Key("mine"); w.Int64(a.mine_ms);
  w.Key("total"); w.Int64(a.total_ms);
  w.EndObject();
  w.EndObject();
  return text_of(sb);
}

std::string services_json(const ServicesAnswer& a) {
  rapidjson::StringBuffer sb;
  JsonWriter w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, a.source_host_id);
  write_range(w, a.start_ms, a.end_ms);
  w.Key("services"); w.StartArray();
  for (const auto& [name, n] : a.services) {
    w.StartObject();
    w.Key("name"); write_json_text(w, name);
    w.Key("count"); w.Uint64(n);
    w.EndObject();
  }
  w.EndArray();
  write_total_timing(w, a.total_ms);
  w.EndObject();
  return text_of(sb);
}

std::string facets_json(const FacetKeysAnswer& a) {
  const LogFacetKeys& value = *a.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("supported"); w.Bool(true);
  w.Key("scopes"); w.StartArray(); for (const auto& scope : a.scopes) write_json_text(w, scope); w.String("column"); w.EndArray();
  w.Key("columns"); w.StartArray(); for (const auto& column : a.columns) write_json_text(w, column); w.EndArray();
  write_facet_common(w, a.common, value.estimated, value.timed_out, value.query_ms);
  w.Key("sampled_records"); w.Uint64(value.sampled);
  w.Key("truncated"); w.Bool(value.keys.size() > kFacetMaxKeys);
  w.Key("keys"); w.StartArray();
  for (size_t i = 0; i < value.keys.size() && i < kFacetMaxKeys; ++i) {
    const auto& key = value.keys[i];
    w.StartArray(); write_json_text(w, key.scope); write_json_text(w, key.key); w.Uint64(key.count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return text_of(sb);
}

std::string facet_values_json(const FacetValuesAnswer& a) {
  const LogFacetValues& value = *a.value;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  JsonWriter w(sb);
  w.StartObject();
  w.Key("scope"); write_json_text(w, a.scope);
  w.Key("key"); write_json_text(w, a.key);
  w.Key("limit"); w.Int(a.limit);
  write_facet_common(w, a.common, value.estimated, value.timed_out, value.query_ms);
  w.Key("records_with_key"); w.Uint64(value.with_key);
  w.Key("distinct_values"); w.Uint64(value.distinct_values);
  w.Key("has_more"); w.Bool(value.distinct_values > value.values.size());
  w.Key("values"); w.StartArray();
  for (const auto& [text, count] : value.values) {
    w.StartArray(); write_json_text(w, text); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  return text_of(sb);
}

}  // namespace logs
}  // namespace chdash
