#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "deep_analysis.hpp"
#include "deep_analysis_jobs.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "json_text.hpp"
#include "query_analysis.hpp"
#include "processor_json.hpp"
#include "secure_random.hpp"
#include "sql_literal.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace {

std::optional<std::pair<std::string, std::string>> split_qualified_name(std::string value) {
  // system.query_log/system.query_views_log normally use database.table. Keep
  // this parser deliberately conservative: an unparseable system-account name
  // is omitted rather than leaked.
  if (value.empty()) return std::nullopt;
  if (value.front() == '`' && value.back() == '`') value = value.substr(1, value.size() - 2);
  const size_t dot = value.find('.');
  if (dot == std::string::npos || dot == 0 || dot + 1 >= value.size()) return std::nullopt;
  auto clean = [](std::string part) {
    if (part.size() >= 2 && part.front() == '`' && part.back() == '`') {
      part = part.substr(1, part.size() - 2);
    }
    return part;
  };
  std::string database = clean(value.substr(0, dot));
  std::string table = clean(value.substr(dot + 1));
  if (database.empty() || table.empty()) return std::nullopt;
  return std::make_pair(std::move(database), std::move(table));
}

bool allowed_qualified_name(const AllowedObjectSet& allowed, const std::string& value) {
  auto parsed = split_qualified_name(value);
  return parsed && allowed.allows_table(parsed->first, parsed->second);
}

void filter_query_log_row(QueryLogAnalysisRow& row, const AllowedObjectSet& allowed) {
  row.databases.erase(
      std::remove_if(row.databases.begin(), row.databases.end(), [&](const std::string& db) {
        return !allowed.allows_database(db);
      }),
      row.databases.end());
  row.tables.erase(
      std::remove_if(row.tables.begin(), row.tables.end(), [&](const std::string& table) {
        return !allowed_qualified_name(allowed, table);
      }),
      row.tables.end());
  // Projection names are not globally qualified. Only return them when the
  // query still has at least one readable table after ACL filtering.
  if (row.tables.empty()) row.projections.clear();
}

void filter_analysis(QueryAnalysisResult& result, const AllowedObjectSet& allowed) {
  for (auto& row : result.query_log) filter_query_log_row(row, allowed);
  for (auto& row : result.distributed_children) filter_query_log_row(row, allowed);

  result.views.erase(
      std::remove_if(result.views.begin(), result.views.end(), [&](QueryViewAnalysisRow& view) {
        if (!allowed_qualified_name(allowed, view.view_name)) return true;
        if (!view.view_target.empty() && !allowed_qualified_name(allowed, view.view_target)) {
          view.view_target.clear();
        }
        return false;
      }),
      result.views.end());
}

void write_string_array(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const std::vector<std::string>& values) {
  writer.StartArray();
  for (const auto& value : values) write_json_text(writer, value);
  writer.EndArray();
}

void write_query_log_row(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const QueryLogAnalysisRow& row,
    bool include_query) {
  writer.StartObject();
  writer.Key("hostname"); write_json_text(writer, row.hostname);
  writer.Key("query_id"); write_json_text(writer, row.query_id);
  writer.Key("initial_query_id"); write_json_text(writer, row.initial_query_id);
  writer.Key("status"); write_json_text(writer, row.status);
  writer.Key("event_time"); write_json_text(writer, row.event_time);
  writer.Key("duration_ms"); writer.Uint64(row.duration_ms);
  writer.Key("read_rows"); writer.Uint64(row.read_rows);
  writer.Key("read_bytes"); writer.Uint64(row.read_bytes);
  writer.Key("written_rows"); writer.Uint64(row.written_rows);
  writer.Key("written_bytes"); writer.Uint64(row.written_bytes);
  writer.Key("result_rows"); writer.Uint64(row.result_rows);
  writer.Key("result_bytes"); writer.Uint64(row.result_bytes);
  writer.Key("memory_usage"); writer.Int64(row.memory_usage);
  writer.Key("peak_threads_usage"); writer.Uint64(row.peak_threads_usage);
  writer.Key("user_time_us"); writer.Uint64(row.user_time_us);
  writer.Key("system_time_us"); writer.Uint64(row.system_time_us);
  writer.Key("databases"); write_string_array(writer, row.databases);
  writer.Key("tables"); write_string_array(writer, row.tables);
  writer.Key("projections"); write_string_array(writer, row.projections);
  writer.Key("exception_code"); writer.Int(row.exception_code);
  writer.Key("exception"); write_json_text(writer, row.exception);
  writer.Key("is_initial_query"); writer.Bool(row.is_initial_query);
  if (include_query) {
    writer.Key("query"); write_json_text(writer, row.query);
  }
  writer.EndObject();
}

void write_processor(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const ProcessorAnalysisRow& row) {
  writer.StartObject();
  writer.Key("hostname"); write_json_text(writer, row.hostname);
  writer.Key("initial_query_id"); write_json_text(writer, row.initial_query_id);
  writer.Key("query_id"); write_json_text(writer, row.query_id);
  writer.Key("id"); write_json_text(writer, std::to_string(row.id));
  writer.Key("parent_ids");
  writer.StartArray();
  for (uint64_t id : row.parent_ids) write_json_text(writer, std::to_string(id));
  writer.EndArray();
  writer.Key("plan_step"); write_json_text(writer, std::to_string(row.plan_step));
  writer.Key("plan_step_name"); write_json_text(writer, row.plan_step_name);
  writer.Key("plan_step_description"); write_json_text(writer, row.plan_step_description);
  writer.Key("plan_group"); write_json_text(writer, std::to_string(row.plan_group));
  writer.Key("name"); write_json_text(writer, row.name);
  writer.Key("elapsed_us"); writer.Uint64(row.elapsed_us);
  writer.Key("input_wait_elapsed_us"); writer.Uint64(row.input_wait_elapsed_us);
  writer.Key("output_wait_elapsed_us"); writer.Uint64(row.output_wait_elapsed_us);
  writer.Key("input_rows"); writer.Uint64(row.input_rows);
  writer.Key("input_bytes"); writer.Uint64(row.input_bytes);
  writer.Key("output_rows"); writer.Uint64(row.output_rows);
  writer.Key("output_bytes"); writer.Uint64(row.output_bytes);
  writer.EndObject();
}


void write_processor_trace_summary(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const ProcessorTraceSummaryRow& row) {
  writer.StartObject();
  writer.Key("hostname"); write_json_text(writer, row.hostname);
  writer.Key("trace_id"); write_json_text(writer, row.trace_id);
  writer.Key("query_id"); write_json_text(writer, row.query_id);
  writer.Key("parent_span_id"); write_json_text(writer, row.parent_span_id);
  writer.Key("operation_name"); write_json_text(writer, row.operation_name);
  writer.Key("first_start_time_us"); writer.Uint64(row.first_start_time_us);
  writer.Key("last_finish_time_us"); writer.Uint64(row.last_finish_time_us);
  writer.Key("active_time_us"); writer.Uint64(row.active_time_us);
  writer.Key("event_count"); writer.Uint64(row.event_count);
  writer.EndObject();
}

constexpr uint64_t kTraceTimelinePixels = 3840;

uint64_t trace_origin_us(const std::vector<OpenTelemetrySpanAnalysisRow>& rows) {
  uint64_t origin = 0;
  for (const auto& row : rows) {
    if (row.start_time_us == 0) continue;
    if (origin == 0 || row.start_time_us < origin) origin = row.start_time_us;
  }
  return origin;
}

uint64_t trace_finish_us(const std::vector<OpenTelemetrySpanAnalysisRow>& rows) {
  uint64_t finish = 0;
  for (const auto& row : rows) finish = std::max(finish, row.finish_time_us);
  return finish;
}

uint64_t trace_bucket_floor(uint64_t offset_us, uint64_t duration_us) {
  if (duration_us == 0) return 0;
  const unsigned __int128 scaled = static_cast<unsigned __int128>(offset_us) * kTraceTimelinePixels;
  return static_cast<uint64_t>(scaled / duration_us);
}

uint64_t trace_bucket_ceil(uint64_t offset_us, uint64_t duration_us) {
  if (duration_us == 0) return 0;
  const unsigned __int128 scaled = static_cast<unsigned __int128>(offset_us) * kTraceTimelinePixels;
  return static_cast<uint64_t>((scaled + duration_us - 1) / duration_us);
}

struct TraceJsonNode {
  uint64_t trace_index = 0;
  uint64_t host_ref = 0;
  uint64_t parent_ref = 0;
  uint64_t operation_index = 0;
  bool leaf_group = false;
  std::vector<std::pair<uint16_t, uint16_t>> segments_px;
};

struct TraceJsonBuild {
  uint64_t origin_us = 0;
  uint64_t duration_us = 1;
  std::vector<std::string> hosts;
  std::vector<std::string> traces;
  std::vector<std::string> operations;
  std::vector<TraceJsonNode> nodes;
  size_t source_span_count = 0;
  size_t leaf_group_count = 0;
  size_t segment_count_before_lod = 0;
  size_t segment_count_after_lod = 0;
  bool processor_summary_overlay = false;
  uint64_t processor_summary_bucket_us = 0;
};

std::string trace_operation_instance_name(std::string_view value) {
  size_t end = value.size();
  while (end > 0) {
    size_t digits = end;
    while (digits > 0 && std::isdigit(static_cast<unsigned char>(value[digits - 1]))) --digits;
    if (digits == end || digits == 0 || value[digits - 1] != '_') break;
    end = digits - 1;
  }
  return std::string(value.substr(0, end));
}

std::string trace_operation_family(std::string_view value) {
  const std::string instance_name = trace_operation_instance_name(value);
  size_t end = instance_name.size();
  size_t pos = end;
  while (pos > 0 && std::isdigit(static_cast<unsigned char>(instance_name[pos - 1]))) --pos;
  if (pos < end && pos > 0 && (instance_name[pos - 1] == '.' || instance_name[pos - 1] == '-')) --pos;
  return std::string(instance_name.substr(0, pos));
}

TraceJsonBuild build_trace_json(
    const std::vector<OpenTelemetrySpanAnalysisRow>& rows,
    const std::vector<ProcessorTraceSummaryRow>& processor_summary = {},
    const std::vector<ProcessorAnalysisRow>& processors = {},
    bool use_processor_summary_overlay = false,
    uint64_t processor_summary_bucket_us = 0) {
  struct PendingNode {
    std::string hostname;
    std::string trace_id;
    std::string parent_span_id;
    std::string operation_name;
    std::string source_span_id; // Server-side only: resolves local parent references.
    bool leaf_group = false;
    std::vector<std::pair<uint64_t, uint64_t>> segments;
  };

  TraceJsonBuild out;
  out.source_span_count = rows.size();
  out.origin_us = trace_origin_us(rows);
  const uint64_t finish_us = trace_finish_us(rows);
  out.duration_us = finish_us > out.origin_us ? finish_us - out.origin_us : 1;

  std::unordered_set<std::string> parent_keys;
  parent_keys.reserve(std::min<size_t>(rows.size(), 8192));
  for (const auto& row : rows) {
    if (row.parent_span_id.empty() || row.parent_span_id == "0") continue;
    std::string key;
    key.reserve(row.trace_id.size() + row.parent_span_id.size() + 1);
    key.append(row.trace_id).push_back('\x1f');
    key.append(row.parent_span_id);
    parent_keys.insert(std::move(key));
  }

  std::vector<PendingNode> pending;
  pending.reserve(std::min<size_t>(rows.size(), 1024));
  std::unordered_map<std::string, size_t> leaf_groups;
  leaf_groups.reserve(std::min<size_t>(rows.size(), 4096));

  std::unordered_set<std::string> processor_families;
  if (use_processor_summary_overlay) {
    processor_families.reserve(processors.size());
    for (const auto& processor : processors) {
      const std::string family = trace_operation_family(processor.name);
      if (!family.empty()) processor_families.insert(family);
    }
  }

  auto leaf_group_key = [](std::string_view trace_id, std::string_view parent_span_id, std::string_view operation_name) {
    std::string key;
    key.reserve(trace_id.size() + parent_span_id.size() + operation_name.size() + 2);
    key.append(trace_id).push_back('\x1f');
    key.append(parent_span_id).push_back('\x1f');
    key.append(operation_name);
    return key;
  };

  for (const auto& row : rows) {
    std::string own_key;
    own_key.reserve(row.trace_id.size() + row.span_id.size() + 1);
    own_key.append(row.trace_id).push_back('\x1f');
    own_key.append(row.span_id);
    const bool has_children = parent_keys.find(own_key) != parent_keys.end();

    const std::string operation_name = trace_operation_instance_name(row.operation_name);

    if (has_children) {
      PendingNode node;
      node.hostname = row.hostname;
      node.trace_id = row.trace_id;
      node.parent_span_id = row.parent_span_id;
      node.operation_name = operation_name;
      node.source_span_id = row.span_id;
      node.segments.emplace_back(row.start_time_us, row.finish_time_us);
      pending.push_back(std::move(node));
      continue;
    }

    // Strict leaf-only aggregation: same trace + parent + operation, and only
    // spans that are not parents of any other span are eligible.
    const std::string group_key = leaf_group_key(row.trace_id, row.parent_span_id, operation_name);
    auto [it, inserted] = leaf_groups.emplace(group_key, pending.size());
    if (inserted) {
      PendingNode node;
      node.hostname = row.hostname;
      node.trace_id = row.trace_id;
      node.parent_span_id = row.parent_span_id;
      node.operation_name = operation_name;
      node.leaf_group = true;
      pending.push_back(std::move(node));
    } else if (pending[it->second].hostname != row.hostname) {
      pending[it->second].hostname.clear();
    }
    pending[it->second].segments.emplace_back(row.start_time_us, row.finish_time_us);
  }

  // A breadth-first detailed trace cap preserves structure, but for very busy
  // processor leaves it necessarily retains only a chronological prefix at the
  // final retained depth. When that cap is hit, replace processor leaf groups
  // with the independent full-trace temporal summary used by Pipeline. This
  // keeps Tracing representative across the complete query without sending all
  // raw processor calls. Structural/non-processor spans remain exact.
  if (use_processor_summary_overlay && !processor_families.empty() && !processor_summary.empty()) {
    std::unordered_set<size_t> replaced_groups;
    replaced_groups.reserve(processor_families.size() * 2);
    for (const auto& row : processor_summary) {
      if (row.trace_id.empty() || row.parent_span_id.empty() || row.parent_span_id == "0" ||
          row.operation_name.empty() || row.first_start_time_us == 0 ||
          row.last_finish_time_us < row.first_start_time_us) continue;
      if (!processor_families.count(trace_operation_family(row.operation_name))) continue;

      const std::string operation_name = trace_operation_instance_name(row.operation_name);
      const std::string group_key = leaf_group_key(row.trace_id, row.parent_span_id, operation_name);
      auto it = leaf_groups.find(group_key);
      size_t index = 0;
      if (it == leaf_groups.end()) {
        index = pending.size();
        leaf_groups.emplace(group_key, index);
        PendingNode node;
        node.hostname = row.hostname;
        node.trace_id = row.trace_id;
        node.parent_span_id = row.parent_span_id;
        node.operation_name = operation_name;
        node.leaf_group = true;
        pending.push_back(std::move(node));
      } else {
        index = it->second;
      }

      auto& node = pending[index];
      if (!node.leaf_group) continue;
      if (replaced_groups.insert(index).second) node.segments.clear();
      if (!row.hostname.empty()) {
        if (node.hostname.empty()) node.hostname = row.hostname;
        else if (node.hostname != row.hostname) node.hostname.clear();
      }
      node.segments.emplace_back(row.first_start_time_us, row.last_finish_time_us);
      out.processor_summary_overlay = true;
    }
    if (out.processor_summary_overlay) out.processor_summary_bucket_us = processor_summary_bucket_us;
  }

  // Exact overlap merge first. The 4K temporal LOD below then merges segments
  // that are indistinguishable at a 3840-pixel timeline resolution.
  for (auto& node : pending) {
    if (!node.leaf_group || node.segments.size() < 2) continue;
    std::sort(node.segments.begin(), node.segments.end());
    std::vector<std::pair<uint64_t, uint64_t>> merged;
    merged.reserve(node.segments.size());
    for (const auto& interval : node.segments) {
      if (merged.empty() || interval.first > merged.back().second) merged.push_back(interval);
      else merged.back().second = std::max(merged.back().second, interval.second);
    }
    node.segments = std::move(merged);
  }

  std::sort(pending.begin(), pending.end(), [](const PendingNode& a, const PendingNode& b) {
    const uint64_t as = a.segments.empty() ? 0 : a.segments.front().first;
    const uint64_t bs = b.segments.empty() ? 0 : b.segments.front().first;
    if (as != bs) return as < bs;
    if (a.trace_id != b.trace_id) return a.trace_id < b.trace_id;
    if (a.parent_span_id != b.parent_span_id) return a.parent_span_id < b.parent_span_id;
    if (a.operation_name != b.operation_name) return a.operation_name < b.operation_name;
    return a.source_span_id < b.source_span_id;
  });

  std::unordered_map<std::string, uint64_t> host_index;
  std::unordered_map<std::string, uint64_t> trace_index;
  std::unordered_map<std::string, uint64_t> operation_index;
  auto intern = [](const std::string& value, std::vector<std::string>& values,
                   std::unordered_map<std::string, uint64_t>& index) -> uint64_t {
    auto it = index.find(value);
    if (it != index.end()) return it->second;
    const uint64_t id = static_cast<uint64_t>(values.size());
    values.push_back(value);
    index.emplace(value, id);
    return id;
  };

  std::unordered_map<std::string, uint64_t> local_parent_index;
  local_parent_index.reserve(pending.size());
  for (size_t i = 0; i < pending.size(); ++i) {
    auto& node = pending[i];
    if (!node.hostname.empty()) intern(node.hostname, out.hosts, host_index);
    intern(node.trace_id, out.traces, trace_index);
    intern(node.operation_name, out.operations, operation_index);
    if (!node.source_span_id.empty()) {
      std::string key;
      key.reserve(node.trace_id.size() + node.source_span_id.size() + 1);
      key.append(node.trace_id).push_back('\x1f');
      key.append(node.source_span_id);
      local_parent_index.emplace(std::move(key), static_cast<uint64_t>(i));
    }
  }

  out.nodes.reserve(pending.size());
  for (const auto& source : pending) {
    TraceJsonNode node;
    node.trace_index = trace_index.at(source.trace_id);
    node.host_ref = source.hostname.empty() ? 0 : host_index.at(source.hostname) + 1;
    node.operation_index = operation_index.at(source.operation_name);
    node.leaf_group = source.leaf_group;

    if (!source.parent_span_id.empty() && source.parent_span_id != "0") {
      std::string key;
      key.reserve(source.trace_id.size() + source.parent_span_id.size() + 1);
      key.append(source.trace_id).push_back('\x1f');
      key.append(source.parent_span_id);
      const auto it = local_parent_index.find(key);
      if (it != local_parent_index.end()) node.parent_ref = it->second + 1;
    }

    out.segment_count_before_lod += source.segments.size();
    std::vector<std::pair<uint16_t, uint16_t>> buckets;
    buckets.reserve(source.segments.size());
    for (const auto& segment : source.segments) {
      const uint64_t start_offset = segment.first > out.origin_us ? segment.first - out.origin_us : 0;
      const uint64_t finish_offset = segment.second > out.origin_us ? segment.second - out.origin_us : 0;
      uint64_t start_px = std::min<uint64_t>(kTraceTimelinePixels - 1, trace_bucket_floor(start_offset, out.duration_us));
      uint64_t finish_px = std::min<uint64_t>(kTraceTimelinePixels, trace_bucket_ceil(finish_offset, out.duration_us));
      if (finish_px <= start_px) finish_px = std::min<uint64_t>(kTraceTimelinePixels, start_px + 1);
      const auto pixel_interval = std::make_pair(static_cast<uint16_t>(start_px), static_cast<uint16_t>(finish_px));
      if (source.leaf_group && !buckets.empty() && pixel_interval.first <= buckets.back().second) {
        buckets.back().second = std::max(buckets.back().second, pixel_interval.second);
      } else {
        buckets.push_back(pixel_interval);
      }
    }
    out.segment_count_after_lod += buckets.size();
    node.segments_px = std::move(buckets);
    out.nodes.push_back(std::move(node));
  }

  out.leaf_group_count = static_cast<size_t>(std::count_if(
      out.nodes.begin(), out.nodes.end(), [](const TraceJsonNode& node) { return node.leaf_group; }));
  return out;
}

void write_trace_json(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const TraceJsonBuild& trace) {
  writer.StartObject();
  writer.Key("format"); writer.String("chdash.trace.json.lod.v2");
  writer.Key("timeline_px"); writer.Uint64(kTraceTimelinePixels);
  writer.Key("origin_us"); writer.Uint64(trace.origin_us);
  writer.Key("duration_us"); writer.Uint64(trace.duration_us);
  writer.Key("source_span_count"); writer.Uint64(trace.source_span_count);
  writer.Key("node_count"); writer.Uint64(trace.nodes.size());
  writer.Key("leaf_group_count"); writer.Uint64(trace.leaf_group_count);
  writer.Key("segment_count_before_lod"); writer.Uint64(trace.segment_count_before_lod);
  writer.Key("segment_count_after_lod"); writer.Uint64(trace.segment_count_after_lod);
  writer.Key("processor_summary_overlay"); writer.Bool(trace.processor_summary_overlay);
  writer.Key("processor_summary_bucket_us"); writer.Uint64(trace.processor_summary_bucket_us);

  writer.Key("hosts");
  writer.StartArray();
  for (const auto& value : trace.hosts) write_json_text(writer, value);
  writer.EndArray();
  writer.Key("traces");
  writer.StartArray();
  for (const auto& value : trace.traces) write_json_text(writer, value);
  writer.EndArray();
  writer.Key("operations");
  writer.StartArray();
  for (const auto& value : trace.operations) write_json_text(writer, value);
  writer.EndArray();

  writer.Key("node_schema");
  writer.StartArray();
  writer.String("trace_index");
  writer.String("host_ref");
  writer.String("parent_ref");
  writer.String("operation_index");
  writer.String("flags");
  writer.String("segments_px");
  writer.EndArray();
  writer.Key("segment_schema");
  writer.StartArray();
  writer.String("start_px");
  writer.String("finish_px");
  writer.EndArray();

  writer.Key("nodes");
  writer.StartArray();
  for (const auto& node : trace.nodes) {
    writer.StartArray();
    writer.Uint64(node.trace_index);
    writer.Uint64(node.host_ref);
    writer.Uint64(node.parent_ref);
    writer.Uint64(node.operation_index);
    writer.Uint(node.leaf_group ? 1u : 0u);
    writer.StartArray();
    for (const auto& segment : node.segments_px) {
      writer.Uint(segment.first);
      writer.Uint(segment.second);
    }
    writer.EndArray();
    writer.EndArray();
  }
  writer.EndArray();
  writer.EndObject();
}

void write_original_otel_spans(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const std::vector<OpenTelemetrySpanAnalysisRow>& rows) {
  writer.StartArray();
  for (const auto& row : rows) {
    writer.StartObject();
    writer.Key("hostname"); write_json_text(writer, row.hostname);
    writer.Key("trace_id"); write_json_text(writer, row.trace_id);
    writer.Key("span_id"); write_json_text(writer, row.span_id);
    writer.Key("parent_span_id"); write_json_text(writer, row.parent_span_id);
    writer.Key("operation_name"); write_json_text(writer, row.operation_name);
    writer.Key("start_time_us"); writer.Uint64(row.start_time_us);
    writer.Key("finish_time_us"); writer.Uint64(row.finish_time_us);
    writer.Key("duration_us"); writer.Uint64(row.finish_time_us >= row.start_time_us ? row.finish_time_us - row.start_time_us : 0);
    writer.Key("query_id"); write_json_text(writer, row.query_id);
    writer.Key("thread_id"); write_json_text(writer, row.thread_id);
    writer.Key("thread_number"); write_json_text(writer, row.thread_number);
    writer.EndObject();
  }
  writer.EndArray();
}

void write_view(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const QueryViewAnalysisRow& row) {
  writer.StartObject();
  writer.Key("hostname"); write_json_text(writer, row.hostname);
  writer.Key("event_time"); write_json_text(writer, row.event_time);
  writer.Key("duration_ms"); writer.Uint64(row.duration_ms);
  writer.Key("initial_query_id"); write_json_text(writer, row.initial_query_id);
  writer.Key("view_name"); write_json_text(writer, row.view_name);
  writer.Key("view_type"); write_json_text(writer, row.view_type);
  writer.Key("view_target"); write_json_text(writer, row.view_target);
  writer.Key("read_rows"); writer.Uint64(row.read_rows);
  writer.Key("read_bytes"); writer.Uint64(row.read_bytes);
  writer.Key("written_rows"); writer.Uint64(row.written_rows);
  writer.Key("written_bytes"); writer.Uint64(row.written_bytes);
  writer.Key("peak_memory_usage"); writer.Uint64(row.peak_memory_usage);
  writer.Key("status"); write_json_text(writer, row.status);
  writer.Key("exception_code"); writer.Int(row.exception_code);
  writer.Key("exception"); write_json_text(writer, row.exception);
  writer.EndObject();
}

} // namespace

void Server::handle_query_analysis(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }
  if (!doc.HasMember("query_id") || !doc["query_id"].IsString()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const std::string query_id = doc["query_id"].GetString();
  const bool include_original_trace = doc.HasMember("include_original_trace") && doc["include_original_trace"].IsBool() && doc["include_original_trace"].GetBool();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  if (!query_registry_) {
    return json_error(res, 404, "analysis_not_found", "Query is not available for analysis.");
  }

  auto record = query_registry_->find(query_id, host_id);
  if (!record) {
    // Missing and foreign-owned query ids deliberately return the same result.
    return json_error(res, 404, "analysis_not_found", "Query is not available for analysis.");
  }
  if (record->terminal_status.empty()) {
    return json_error(res, 409, "query_not_finished", "Query analysis is available after execution finishes.");
  }
  if (record->run_mode != QueryRunMode::Profiling) {
    return json_error(
        res, 409, "analysis_not_enabled",
        "Analysis is available only for queries executed in profiling mode.");
  }

  // The objects the runner reads (the ACL of its identity, shared with the Explorer and the System pages).
  std::shared_ptr<const AclTableSet> allowed;
  try {
    allowed = acl_.table_set(runner_access(*host));
  } catch (const AclUnavailable& e) {
    return json_error(res, 503, e.code == "acl_unavailable" ? "acl_unavailable" : e.code, e.what());
  }

  QueryAnalysisOptions options;
  options.flush_gate = &system_log_flush_gate_;
  options.log_lookup_timeout_ms = cfg_.analysis.log_lookup_timeout_ms;
  options.flush_logs = cfg_.analysis.flush_logs;
  options.include_original_trace_fields = include_original_trace;
  const std::string& system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  auto analysis = collect_query_analysis(*record, system_uri, client_pool_, options);
  if (!analysis.fatal_error.empty()) {
    return json_error(res, 503, "analysis_collection_failed", analysis.fatal_error);
  }
  filter_analysis(analysis, allowed->allowed);

  rapidjson::StringBuffer buffer(nullptr, 4096);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); write_json_text(writer, query_id);
  writer.Key("host_id"); write_json_text(writer, host_id);
  writer.Key("run_mode"); writer.String(record->run_mode == QueryRunMode::Profiling ? "profiling" : "normal");
  writer.Key("terminal_status"); write_json_text(writer, record->terminal_status);
  writer.Key("partial_execution"); writer.Bool(record->partial_execution);
  writer.Key("session_elapsed_ms"); writer.Int64(record->session_elapsed_ms);
  writer.Key("logs_pending"); writer.Bool(analysis.logs_pending);
  writer.Key("profiling_logs_pending"); writer.Bool(analysis.profiling_logs_pending);
  writer.Key("processor_profiling_recorded"); writer.Bool(!analysis.processors.empty());
  bool processor_setting_seen = false;
  bool processor_setting_enabled = false;
  for (const auto& row : analysis.query_log) {
    if (row.log_processors_profiles.empty()) continue;
    processor_setting_seen = true;
    if (row.log_processors_profiles == "1" || row.log_processors_profiles == "true") processor_setting_enabled = true;
  }
  std::string processor_profiling_status;
  if (!analysis.processors.empty()) processor_profiling_status = "recorded";
  else if (!analysis.processors_profile_available) processor_profiling_status = "table_unavailable";
  else if (analysis.logs_pending) processor_profiling_status = "query_log_pending";
  else if (processor_setting_seen && !processor_setting_enabled) processor_profiling_status = "disabled_for_query";
  else if (processor_setting_enabled) processor_profiling_status = "enabled_no_rows";
  else processor_profiling_status = "unknown_no_rows";
  writer.Key("processor_profiling_requested"); writer.Bool(processor_setting_enabled);
  writer.Key("processor_profiling_status"); write_json_text(writer, processor_profiling_status);
  // Applicability is derived from the filtered execution itself. The frontend
  // must never infer cluster/view usage from database names or configuration.
  writer.Key("views_applicable"); writer.Bool(!analysis.views.empty());
  writer.Key("distributed_applicable"); writer.Bool(!analysis.distributed_children.empty());
  writer.Key("distributed_scope"); writer.String("local_replica");
  writer.Key("deep_analysis_allowed"); writer.Bool(cfg_.analysis.allow_deep_analyze);
  writer.Key("deep_analysis_available"); writer.Bool(
      cfg_.analysis.allow_deep_analyze && !record->original_sql.empty() &&
      deep_analysis_candidate_sql(record->original_sql));

  writer.Key("availability");
  writer.StartObject();
  writer.Key("query_log"); writer.Bool(analysis.query_log_available);
  writer.Key("processors_profile_log"); writer.Bool(analysis.processors_profile_available);
  writer.Key("opentelemetry_span_log"); writer.Bool(analysis.opentelemetry_span_log_available);
  writer.Key("processor_trace_summary"); writer.Bool(analysis.processor_trace_summary_available);
  writer.Key("query_views_log"); writer.Bool(analysis.query_views_available);
  writer.Key("query_log_error"); write_json_text(writer, analysis.query_log_error);
  writer.Key("processors_profile_error"); write_json_text(writer, analysis.processors_profile_error);
  writer.Key("opentelemetry_span_log_error"); write_json_text(writer, analysis.opentelemetry_span_log_error);
  writer.Key("processor_trace_summary_error"); write_json_text(writer, analysis.processor_trace_summary_error);
  writer.Key("query_views_error"); write_json_text(writer, analysis.query_views_error);
  writer.Key("distributed_error"); write_json_text(writer, analysis.distributed_error);
  writer.EndObject();

  writer.Key("native_query_ids"); write_string_array(writer, record->native_query_ids);

  writer.Key("overview");
  if (!analysis.query_log.empty()) write_query_log_row(writer, analysis.query_log.front(), false);
  else writer.Null();

  writer.Key("attempts");
  writer.StartArray();
  for (const auto& row : analysis.query_log) write_query_log_row(writer, row, false);
  writer.EndArray();

  writer.Key("processors_compact");
  write_processors_json(writer, analysis.processors, analysis.processor_trace_summary);

  writer.Key("trace_truncated"); writer.Bool(analysis.trace_truncated);
  writer.Key("processors_truncated"); writer.Bool(analysis.processors_truncated);
  writer.Key("processor_trace_summary_truncated"); writer.Bool(analysis.processor_trace_summary_truncated);
  writer.Key("processor_trace_bucket_us"); writer.Uint64(analysis.processor_trace_bucket_us);
  const bool overlay_processor_activity = analysis.trace_truncated &&
      analysis.processor_trace_summary_available && !analysis.processor_trace_summary_truncated;
  const TraceJsonBuild trace_json = build_trace_json(
      analysis.trace_spans, analysis.processor_trace_summary, analysis.processors,
      overlay_processor_activity, analysis.processor_trace_bucket_us);
  writer.Key("trace_compact");
  write_trace_json(writer, trace_json);
  if (include_original_trace) {
    writer.Key("processors");
    writer.StartArray();
    for (const auto& row : analysis.processors) write_processor(writer, row);
    writer.EndArray();
    writer.Key("processor_trace_summary");
    writer.StartArray();
    for (const auto& row : analysis.processor_trace_summary) write_processor_trace_summary(writer, row);
    writer.EndArray();
    writer.Key("trace_spans_original");
    write_original_otel_spans(writer, analysis.trace_spans);
  }

  writer.Key("views");
  writer.StartArray();
  for (const auto& row : analysis.views) write_view(writer, row);
  writer.EndArray();

  writer.Key("distributed");
  writer.StartArray();
  for (const auto& row : analysis.distributed_children) write_query_log_row(writer, row, false);
  writer.EndArray();

  writer.EndObject();

  res.status = 200;
  res.set_content(buffer.GetString(), buffer.GetSize(), "application/json; charset=utf-8");
}


// The JSON object of a finished analysis (the `result` of the job that the poll answers).
static std::string deep_analysis_result_json(const std::string& query_id, const std::string& host_id, const DeepAnalysisResult& deep) {
  rapidjson::StringBuffer buffer(nullptr, 8192);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); write_json_text(writer, query_id);
  writer.Key("host_id"); write_json_text(writer, host_id);
  writer.Key("deep_query_id"); write_json_text(writer, deep.deep_query_id);
  writer.Key("reexecuted"); writer.Bool(true);
  writer.Key("result_rows_returned"); writer.Bool(false);
  writer.Key("statement_policy"); writer.String("select_family_only");

  writer.Key("summary");
  writer.StartObject();
  writer.Key("time"); write_json_text(writer, deep.summary.time);
  writer.Key("read"); write_json_text(writer, deep.summary.read);
  writer.Key("peak_memory"); write_json_text(writer, deep.summary.peak_memory);
  writer.Key("output"); write_json_text(writer, deep.summary.output);
  writer.EndObject();

  writer.Key("plan_nodes");
  writer.StartArray();
  for (const auto& node : deep.nodes) {
    writer.StartObject();
    writer.Key("id"); write_json_text(writer, node.id);
    writer.Key("parent_id"); write_json_text(writer, node.parent_id);
    writer.Key("depth"); writer.Uint64(static_cast<uint64_t>(node.depth));
    writer.Key("label"); write_json_text(writer, node.label);
    writer.Key("details");
    writer.StartArray();
    for (const auto& detail : node.details) write_json_text(writer, detail);
    writer.EndArray();
    writer.EndObject();
  }
  writer.EndArray();

  writer.Key("plan_lines");
  writer.StartArray();
  for (const auto& line : deep.lines) write_json_text(writer, line);
  writer.EndArray();
  writer.EndObject();
  return std::string(buffer.GetString(), buffer.GetSize());
}

// KILL QUERY for the statements of a job, through the system account like every cancel (docs/configuration.md, "Authorization model").
static void kill_deep_statements(const HostSpec& host, const std::vector<std::string>& statements) {
  if (statements.empty()) return;
  std::string where = "query_id IN (";
  for (size_t i = 0; i < statements.size(); ++i) {
    if (i > 0) where += ", ";
    where += sql::quote_string(statements[i]);
  }
  where += ")";
  kill_queries(host.system_uri.empty() ? host.runner_uri : host.system_uri, where, false);
}

static void write_deep_job_head(rapidjson::Writer<rapidjson::StringBuffer>& writer, const std::string& job_id, const std::string& host_id,
                                const std::string& query_id, const char* status) {
  writer.Key("job_id"); write_json_text(writer, job_id);
  writer.Key("host_id"); write_json_text(writer, host_id);
  writer.Key("query_id"); write_json_text(writer, query_id);
  writer.Key("status"); writer.String(status);
}

// POST /api/query/deep-analysis starts the job and answers 202 at once; the analysis runs in a thread of the server that holds one
// place of the analysis admission for each host (operations.md, "Admission") until it ends. The client polls
// GET /api/query/deep-analysis and can cancel with POST /api/query/deep-analysis/cancel.
void Server::handle_query_deep_analysis(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) {
    return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  }
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) {
    return json_error(res, 400, "missing_host_id", "Missing host_id.");
  }
  if (!doc.HasMember("query_id") || !doc["query_id"].IsString()) {
    return json_error(res, 400, "missing_query_id", "Missing query_id.");
  }
  if (!cfg_.analysis.allow_deep_analyze) {
    return json_error(res, 403, "deep_analysis_disabled", "Deep Analyze is disabled by configuration.");
  }

  const std::string host_id = doc["host_id"].GetString();
  const std::string query_id = doc["query_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  // Deep Analyze replays the retained user SQL with runner_uri only.
  if (!query_registry_) {
    return json_error(res, 404, "analysis_not_found", "Query is not available for analysis.");
  }

  auto record = query_registry_->find(query_id, host_id);
  if (!record) {
    return json_error(res, 404, "analysis_not_found", "Query is not available for analysis.");
  }
  if (record->terminal_status.empty()) {
    return json_error(res, 409, "query_not_finished", "Deep Analyze is available after execution finishes.");
  }
  if (record->run_mode != QueryRunMode::Profiling) {
    return json_error(
        res, 409, "analysis_not_enabled",
        "Deep Analyze is available only for queries executed in profiling mode.");
  }
  DeepAnalysisError precheck;
  if (!deep_analysis_precheck(*record, &precheck)) {
    return json_error(res, precheck.http_status, precheck.code, precheck.message);
  }

  const auto started = deep_jobs_.start(host_id, query_id, random_uuid_v4());
  const auto answer = [&](const std::string& job_id) {
    rapidjson::StringBuffer buffer(nullptr, 512);
    rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
    writer.StartObject();
    write_deep_job_head(writer, job_id, host_id, query_id, "running");
    writer.Key("poll_after_ms"); writer.Int(1000);
    writer.EndObject();
    res.status = 202;
    res.set_header("Cache-Control", "no-store");
    res.set_content(buffer.GetString(), buffer.GetSize(), "application/json");
  };
  // The analysis of this query already runs: the same job, no second EXPLAIN ANALYZE.
  if (!started.created) return answer(started.job_id);

  // A place for the job: it is held until the job ends. Without one (a burst of analyses), 503 server_busy.
  auto ticket = admit(WorkClass::Analysis, req, res);
  if (!ticket) {
    deep_jobs_.discard(started.job_id);
    return;
  }
  const std::shared_ptr<WorkerGroup> group = query_workers_;
  if (!group->enter()) {
    deep_jobs_.discard(started.job_id);
    return json_error(res, 503, "server_stopping", "the server is stopping");
  }

  ChQueryLimits limits = user_sql_limits(req, "chdash-deep-analysis");
  // The request is over when the job runs: the job stops by its own cancel, or when the server stops.
  const std::shared_ptr<DeepJobControl> control = started.control;
  limits.canceled = [this, control] { return stopping() || control->cancel_requested(); };
  // The bound of the job (analysis.deep_max_execution_time_s); the query { } bounds of a run apply too, the smaller one wins.
  if (cfg_.analysis.deep_max_execution_time_s > 0) {
    limits.deadline = std::chrono::steady_clock::now() + std::chrono::seconds(cfg_.analysis.deep_max_execution_time_s);
  }

  const std::string job_id = started.job_id;
  try {
    std::thread([this, group, ticket = std::move(*ticket), record = std::move(*record), host = *host, job_id, control,
                 limits = std::move(limits)]() mutable {
      {
        // A stop of the server, or a cancel, kills the statements: EXPLAIN ANALYZE can send nothing for as long as the run did.
        struct StopHook {
          Server& server;
          uint64_t id;
          ~StopHook() { server.remove_stop_hook(id); }
        } stop_hook{*this, add_stop_hook([host, control] {
                      control->request_cancel();
                      kill_deep_statements(host, control->statements());
                    })};
        ChQueryScope scope(std::move(limits));
        DeepAnalysisResult deep;
        DeepAnalysisError error;
        const bool ok = run_deep_analysis(record, host.runner_uri, client_pool_, &deep, &error,
                                          [&control](const std::string& statement) { control->add_statement(statement); });
        if (control->cancel_requested() || error.code == "canceled") {
          deep_jobs_.cancel_done(job_id);
        } else if (ok) {
          deep_jobs_.finish(job_id, deep_analysis_result_json(record.query_id, record.host_id, deep));
        } else {
          deep_jobs_.fail(job_id, error.code.empty() ? "deep_analysis_failed" : error.code,
                          error.message.empty() ? "Deep Analyze failed." : error.message,
                          error.http_status > 0 ? error.http_status : 500);
        }
      }
      // The place goes back before the thread leaves the group: the server waits for the group, then destroys the admission.
      ticket = Admission::Ticket();
      group->leave();
    }).detach();
  } catch (...) {
    group->leave();
    deep_jobs_.discard(job_id);
    throw;
  }
  answer(job_id);
}

// GET /api/query/deep-analysis?host_id=&job_id=: the state of the job, and the analysis once it finished.
void Server::handle_query_deep_analysis_status(const httplib::Request& req, httplib::Response& res) {
  res.set_header("Cache-Control", "no-store");
  if (!req.has_param("host_id")) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  if (!req.has_param("job_id")) return json_error(res, 400, "missing_job_id", "Missing job_id.");
  const std::string host_id = req.get_param_value("host_id");
  if (!find_host(cfg_.hosts, host_id)) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  DeepJobSnapshot job;
  if (!deep_jobs_.snapshot(req.get_param_value("job_id"), host_id, &job)) {
    return json_error(res, 404, "deep_analysis_job_not_found", "The Deep Analyze job is unknown, or its result is no longer kept.");
  }
  rapidjson::StringBuffer buffer(nullptr, job.result_json ? job.result_json->size() + 512 : 512);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  write_deep_job_head(writer, job.job_id, job.host_id, job.query_id, deep_job_state_name(job.state));
  writer.Key("elapsed_ms"); writer.Int64(job.elapsed_ms);
  if (job.state == DeepJobState::Finished && job.result_json) {
    writer.Key("result");
    writer.RawValue(job.result_json->data(), job.result_json->size(), rapidjson::kObjectType);
  } else if (job.state == DeepJobState::Failed) {
    // The poll itself succeeded: the failure is the state of the job, with the code and the message of the envelope (operations.md,
    // "Errors"). `http_status` is the status that a synchronous answer would have had.
    writer.Key("error_code"); write_json_text(writer, job.error_code);
    writer.Key("message"); write_json_text(writer, job.error_message);
    writer.Key("retryable"); writer.Bool(false);
    writer.Key("http_status"); writer.Int(job.error_status);
  }
  writer.EndObject();
  res.status = 200;
  res.set_content(buffer.GetString(), buffer.GetSize(), "application/json");
}

// POST /api/query/deep-analysis/cancel {host_id, job_id}: the job stops and its statements are killed. The state turns "canceled" when
// the thread of the job has seen it: the client polls once more.
void Server::handle_query_deep_analysis_cancel(const httplib::Request& req, httplib::Response& res) {
  res.set_header("Cache-Control", "no-store");
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  if (!doc.HasMember("job_id") || !doc["job_id"].IsString()) return json_error(res, 400, "missing_job_id", "Missing job_id.");
  const std::string host_id = doc["host_id"].GetString();
  const std::string job_id = doc["job_id"].GetString();
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  std::shared_ptr<DeepJobControl> control;
  if (!deep_jobs_.request_cancel(job_id, host_id, &control)) {
    return json_error(res, 404, "deep_analysis_job_not_found", "The Deep Analyze job is unknown, or its result is no longer kept.");
  }
  if (control) kill_deep_statements(*host, control->statements());

  DeepJobSnapshot job;
  deep_jobs_.snapshot(job_id, host_id, &job);
  rapidjson::StringBuffer buffer(nullptr, 512);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  write_deep_job_head(writer, job_id, host_id, job.query_id, deep_job_state_name(job.state));
  writer.Key("cancel_requested"); writer.Bool(control != nullptr);
  writer.EndObject();
  res.status = 200;
  res.set_content(buffer.GetString(), buffer.GetSize(), "application/json");
}

} // namespace chdash
