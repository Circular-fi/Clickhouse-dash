#pragma once

#include "query_analysis.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

// Lossless, versioned transport for counters and full-resolution summary windows.
// Keep this writer independent of HTTP so the real codec can be tested end to end.
inline void write_processors_json(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const std::vector<ProcessorAnalysisRow>& processors,
    const std::vector<ProcessorTraceSummaryRow>& summaries) {
  std::vector<std::string> strings{std::string{}};
  std::unordered_map<std::string, uint32_t> string_refs{{std::string{}, 0}};
  auto intern = [&](const std::string& value) {
    auto [it, inserted] = string_refs.try_emplace(value, static_cast<uint32_t>(strings.size()));
    if (inserted) strings.push_back(value);
    return it->second;
  };
  auto uint = [&](uint64_t value) {
    constexpr uint64_t max_js_integer = 9007199254740991ULL;
    if (value <= max_js_integer) writer.Uint64(value);
    else writer.String(std::to_string(value).c_str());
  };
  using SummaryKey = std::array<uint32_t, 5>;
  struct Series { SummaryKey key; std::vector<const ProcessorTraceSummaryRow*> rows; };
  std::map<SummaryKey, size_t> series_refs;
  std::vector<Series> series;
  uint64_t origin = summaries.empty() ? 0 : summaries.front().first_start_time_us;
  for (const auto& row : summaries) {
    if (row.last_finish_time_us < row.first_start_time_us) {
      throw std::invalid_argument("Processor activity finishes before its start");
    }
    origin = std::min(origin, row.first_start_time_us);
    SummaryKey key{intern(row.hostname), intern(row.trace_id), intern(row.query_id),
                   intern(row.parent_span_id), intern(row.operation_name)};
    auto [it, inserted] = series_refs.try_emplace(key, series.size());
    if (inserted) series.push_back({key, {}});
    series[it->second].rows.push_back(&row);
  }

  writer.StartObject();
  writer.Key("format"); writer.String("chdash.processors.json.v1");
  writer.Key("row_schema");
  writer.StartArray();
  for (const char* field : {"hostname_ref", "initial_query_id_ref", "query_id_ref", "id_ref",
       "parent_id_refs", "plan_step_ref", "plan_step_name_ref", "plan_step_description_ref",
       "plan_group_ref", "name_ref", "elapsed_us", "input_wait_elapsed_us",
       "output_wait_elapsed_us", "input_rows", "input_bytes", "output_rows", "output_bytes"}) writer.String(field);
  writer.EndArray();
  writer.Key("rows");
  writer.StartArray();
  for (const auto& row : processors) {
    writer.StartArray();
    writer.Uint(intern(row.hostname));
    writer.Uint(intern(row.initial_query_id));
    writer.Uint(intern(row.query_id));
    writer.Uint(intern(std::to_string(row.id)));
    writer.StartArray();
    for (uint64_t parent : row.parent_ids) writer.Uint(intern(std::to_string(parent)));
    writer.EndArray();
    writer.Uint(intern(std::to_string(row.plan_step)));
    writer.Uint(intern(row.plan_step_name));
    writer.Uint(intern(row.plan_step_description));
    writer.Uint(intern(std::to_string(row.plan_group)));
    writer.Uint(intern(row.name));
    uint(row.elapsed_us);
    uint(row.input_wait_elapsed_us);
    uint(row.output_wait_elapsed_us);
    uint(row.input_rows);
    uint(row.input_bytes);
    uint(row.output_rows);
    uint(row.output_bytes);
    writer.EndArray();
  }
  writer.EndArray();
  writer.Key("summary_origin_us"); uint(origin);
  writer.Key("summary_row_count"); writer.Uint64(summaries.size());
  writer.Key("summary_series_schema");
  writer.StartArray();
  for (const char* field : {"hostname_ref", "trace_id_ref", "query_id_ref",
       "parent_span_id_ref", "operation_name_ref", "windows"}) writer.String(field);
  writer.EndArray();
  writer.Key("summary_window_schema");
  writer.StartArray();
  for (const char* field : {"start_offset_us", "finish_offset_us", "active_time_us", "event_count"}) writer.String(field);
  writer.EndArray();
  writer.Key("summary_series");
  writer.StartArray();
  for (const auto& entry : series) {
    writer.StartArray();
    for (auto ref : entry.key) writer.Uint(ref);
    writer.StartArray();
    for (const auto* row : entry.rows) {
      uint(row->first_start_time_us - origin);
      uint(row->last_finish_time_us - origin);
      uint(row->active_time_us);
      uint(row->event_count);
    }
    writer.EndArray();
    writer.EndArray();
  }
  writer.EndArray();
  writer.Key("strings");
  writer.StartArray();
  for (const auto& value : strings) writer.String(value.data(), static_cast<rapidjson::SizeType>(value.size()));
  writer.EndArray();
  writer.EndObject();
}

} // namespace chdash
