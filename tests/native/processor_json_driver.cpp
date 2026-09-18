#include "processor_json.hpp"
#include <rapidjson/document.h>
#include <iostream>
#include <iterator>
#include <string>

int main() {
  std::string input{std::istreambuf_iterator<char>(std::cin), {}};
  rapidjson::Document doc;
  doc.Parse(input.data(), input.size());
  if (doc.HasParseError() || !doc.IsObject()) return 2;
  const auto text = [](const rapidjson::Value& row, const char* key) {
    return row.HasMember(key) ? std::string(row[key].GetString(), row[key].GetStringLength()) : std::string{};
  };
  const auto uint = [](const rapidjson::Value& value) -> uint64_t {
    return value.IsString() ? std::stoull(value.GetString()) : value.GetUint64();
  };
  const auto counter = [&](const rapidjson::Value& row, const char* key) -> uint64_t {
    return row.HasMember(key) ? uint(row[key]) : 0;
  };
  std::vector<chdash::ProcessorAnalysisRow> processors;
  std::vector<chdash::ProcessorTraceSummaryRow> summary;
  for (const auto& row : doc["processors"].GetArray()) {
    chdash::ProcessorAnalysisRow p;
    p.hostname = text(row, "hostname"); p.initial_query_id = text(row, "initial_query_id");
    p.query_id = text(row, "query_id"); p.name = text(row, "name");
    p.id = counter(row, "id"); p.plan_step = counter(row, "plan_step"); p.plan_group = counter(row, "plan_group");
    p.plan_step_name = text(row, "plan_step_name"); p.plan_step_description = text(row, "plan_step_description");
    for (const auto& parent : row["parent_ids"].GetArray()) p.parent_ids.push_back(uint(parent));
    p.elapsed_us = counter(row, "elapsed_us");
    p.input_wait_elapsed_us = counter(row, "input_wait_elapsed_us"); p.output_wait_elapsed_us = counter(row, "output_wait_elapsed_us");
    p.input_rows = counter(row, "input_rows"); p.input_bytes = counter(row, "input_bytes");
    p.output_rows = counter(row, "output_rows"); p.output_bytes = counter(row, "output_bytes");
    processors.push_back(std::move(p));
  }
  for (const auto& row : doc["processor_trace_summary"].GetArray()) {
    chdash::ProcessorTraceSummaryRow p;
    p.hostname = text(row, "hostname"); p.trace_id = text(row, "trace_id"); p.query_id = text(row, "query_id");
    p.parent_span_id = text(row, "parent_span_id"); p.operation_name = text(row, "operation_name");
    p.first_start_time_us = counter(row, "first_start_time_us"); p.last_finish_time_us = counter(row, "last_finish_time_us");
    p.active_time_us = counter(row, "active_time_us"); p.event_count = counter(row, "event_count");
    summary.push_back(std::move(p));
  }
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  writer.StartObject();
  writer.Key("processors_compact");
  chdash::write_processors_json(writer, processors, summary);
  writer.EndObject();
  std::cout.write(buffer.GetString(), buffer.GetSize());
}
