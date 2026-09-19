#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "deep_analysis.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "query_analysis.hpp"
#include "processor_json.hpp"

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
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace {

uint64_t now_ms_analysis() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string analysis_security_key(const std::string& host_id) {
  return host_id;
}


std::shared_ptr<clickhouse::Client> acquire_analysis_runner(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error)
    : make_client_from_uri(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error);
}

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
  for (const auto& value : values) writer.String(value.c_str());
  writer.EndArray();
}

void write_query_log_row(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const QueryLogAnalysisRow& row,
    bool include_query) {
  writer.StartObject();
  writer.Key("hostname"); writer.String(row.hostname.c_str());
  writer.Key("query_id"); writer.String(row.query_id.c_str());
  writer.Key("initial_query_id"); writer.String(row.initial_query_id.c_str());
  writer.Key("status"); writer.String(row.status.c_str());
  writer.Key("event_time"); writer.String(row.event_time.c_str());
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
  writer.Key("exception"); writer.String(row.exception.c_str());
  writer.Key("is_initial_query"); writer.Bool(row.is_initial_query);
  if (include_query) {
    writer.Key("query"); writer.String(row.query.c_str());
  }
  writer.EndObject();
}

void write_processor(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const ProcessorAnalysisRow& row) {
  writer.StartObject();
  writer.Key("hostname"); writer.String(row.hostname.c_str());
  writer.Key("initial_query_id"); writer.String(row.initial_query_id.c_str());
  writer.Key("query_id"); writer.String(row.query_id.c_str());
  writer.Key("id"); writer.String(std::to_string(row.id).c_str());
  writer.Key("parent_ids");
  writer.StartArray();
  for (uint64_t id : row.parent_ids) writer.String(std::to_string(id).c_str());
  writer.EndArray();
  writer.Key("plan_step"); writer.String(std::to_string(row.plan_step).c_str());
  writer.Key("plan_step_name"); writer.String(row.plan_step_name.c_str());
  writer.Key("plan_step_description"); writer.String(row.plan_step_description.c_str());
  writer.Key("plan_group"); writer.String(std::to_string(row.plan_group).c_str());
  writer.Key("name"); writer.String(row.name.c_str());
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
  writer.Key("hostname"); writer.String(row.hostname.c_str());
  writer.Key("trace_id"); writer.String(row.trace_id.c_str());
  writer.Key("query_id"); writer.String(row.query_id.c_str());
  writer.Key("parent_span_id"); writer.String(row.parent_span_id.c_str());
  writer.Key("operation_name"); writer.String(row.operation_name.c_str());
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
  for (const auto& value : trace.hosts) writer.String(value.c_str());
  writer.EndArray();
  writer.Key("traces");
  writer.StartArray();
  for (const auto& value : trace.traces) writer.String(value.c_str());
  writer.EndArray();
  writer.Key("operations");
  writer.StartArray();
  for (const auto& value : trace.operations) writer.String(value.c_str());
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
    writer.Key("hostname"); writer.String(row.hostname.c_str());
    writer.Key("trace_id"); writer.String(row.trace_id.c_str());
    writer.Key("span_id"); writer.String(row.span_id.c_str());
    writer.Key("parent_span_id"); writer.String(row.parent_span_id.c_str());
    writer.Key("operation_name"); writer.String(row.operation_name.c_str());
    writer.Key("start_time_us"); writer.Uint64(row.start_time_us);
    writer.Key("finish_time_us"); writer.Uint64(row.finish_time_us);
    writer.Key("duration_us"); writer.Uint64(row.finish_time_us >= row.start_time_us ? row.finish_time_us - row.start_time_us : 0);
    writer.Key("query_id"); writer.String(row.query_id.c_str());
    writer.Key("thread_id"); writer.String(row.thread_id.c_str());
    writer.Key("thread_number"); writer.String(row.thread_number.c_str());
    writer.EndObject();
  }
  writer.EndArray();
}

void write_view(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const QueryViewAnalysisRow& row) {
  writer.StartObject();
  writer.Key("hostname"); writer.String(row.hostname.c_str());
  writer.Key("event_time"); writer.String(row.event_time.c_str());
  writer.Key("duration_ms"); writer.Uint64(row.duration_ms);
  writer.Key("initial_query_id"); writer.String(row.initial_query_id.c_str());
  writer.Key("view_name"); writer.String(row.view_name.c_str());
  writer.Key("view_type"); writer.String(row.view_type.c_str());
  writer.Key("view_target"); writer.String(row.view_target.c_str());
  writer.Key("read_rows"); writer.Uint64(row.read_rows);
  writer.Key("read_bytes"); writer.Uint64(row.read_bytes);
  writer.Key("written_rows"); writer.Uint64(row.written_rows);
  writer.Key("written_bytes"); writer.Uint64(row.written_bytes);
  writer.Key("peak_memory_usage"); writer.Uint64(row.peak_memory_usage);
  writer.Key("status"); writer.String(row.status.c_str());
  writer.Key("exception_code"); writer.Int(row.exception_code);
  writer.Key("exception"); writer.String(row.exception.c_str());
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

  const uint64_t timestamp = now_ms_analysis();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = analysis_security_key(host_id);
  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, timestamp, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_analysis_runner(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        try {
          value = discover_allowed_objects(*runner);
          return true;
        } catch (const std::exception& e) {
          code = "acl_discovery_failed";
          message = e.what();
          if (client_pool_) client_pool_->invalidate(runner);
          return false;
        }
      });
  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }

  QueryAnalysisOptions options;
  options.log_lookup_timeout_ms = cfg_.analysis.log_lookup_timeout_ms;
  options.flush_logs = cfg_.analysis.flush_logs;
  options.include_original_trace_fields = include_original_trace;
  const std::string& system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
  auto analysis = collect_query_analysis(*record, system_uri, client_pool_, options);
  if (!analysis.fatal_error.empty()) {
    return json_error(res, 503, "analysis_collection_failed", analysis.fatal_error);
  }
  filter_analysis(analysis, *allowed_result.value);

  rapidjson::StringBuffer buffer(nullptr, 4096);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); writer.String(query_id.c_str());
  writer.Key("host_id"); writer.String(host_id.c_str());
  writer.Key("run_mode"); writer.String(record->run_mode == QueryRunMode::Profiling ? "profiling" : "normal");
  writer.Key("terminal_status"); writer.String(record->terminal_status.c_str());
  writer.Key("partial_execution"); writer.Bool(record->partial_execution);
  writer.Key("session_elapsed_ms"); writer.Int64(record->session_elapsed_ms);
  writer.Key("logs_pending"); writer.Bool(analysis.logs_pending);
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
  writer.Key("processor_profiling_status"); writer.String(processor_profiling_status.c_str());
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
  writer.Key("query_log_error"); writer.String(analysis.query_log_error.c_str());
  writer.Key("processors_profile_error"); writer.String(analysis.processors_profile_error.c_str());
  writer.Key("opentelemetry_span_log_error"); writer.String(analysis.opentelemetry_span_log_error.c_str());
  writer.Key("processor_trace_summary_error"); writer.String(analysis.processor_trace_summary_error.c_str());
  writer.Key("query_views_error"); writer.String(analysis.query_views_error.c_str());
  writer.Key("distributed_error"); writer.String(analysis.distributed_error.c_str());
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

  DeepAnalysisResult deep;
  DeepAnalysisError deep_error;
  if (!run_deep_analysis(*record, host->runner_uri, client_pool_, &deep, &deep_error)) {
    return json_error(
        res,
        deep_error.http_status > 0 ? deep_error.http_status : 500,
        deep_error.code.empty() ? "deep_analysis_failed" : deep_error.code,
        deep_error.message.empty() ? "Deep Analyze failed." : deep_error.message);
  }

  rapidjson::StringBuffer buffer(nullptr, 8192);
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("query_id"); writer.String(query_id.c_str());
  writer.Key("host_id"); writer.String(host_id.c_str());
  writer.Key("deep_query_id"); writer.String(deep.deep_query_id.c_str());
  writer.Key("reexecuted"); writer.Bool(true);
  writer.Key("result_rows_returned"); writer.Bool(false);
  writer.Key("statement_policy"); writer.String("select_family_only");

  writer.Key("summary");
  writer.StartObject();
  writer.Key("time"); writer.String(deep.summary.time.c_str());
  writer.Key("read"); writer.String(deep.summary.read.c_str());
  writer.Key("peak_memory"); writer.String(deep.summary.peak_memory.c_str());
  writer.Key("output"); writer.String(deep.summary.output.c_str());
  writer.EndObject();

  writer.Key("plan_nodes");
  writer.StartArray();
  for (const auto& node : deep.nodes) {
    writer.StartObject();
    writer.Key("id"); writer.String(node.id.c_str());
    writer.Key("parent_id"); writer.String(node.parent_id.c_str());
    writer.Key("depth"); writer.Uint64(static_cast<uint64_t>(node.depth));
    writer.Key("label"); writer.String(node.label.c_str());
    writer.Key("details");
    writer.StartArray();
    for (const auto& detail : node.details) writer.String(detail.c_str());
    writer.EndArray();
    writer.EndObject();
  }
  writer.EndArray();

  writer.Key("plan_lines");
  writer.StartArray();
  for (const auto& line : deep.lines) writer.String(line.c_str());
  writer.EndArray();
  writer.EndObject();

  res.status = 200;
  res.set_content(buffer.GetString(), "application/json");
}

} // namespace chdash
