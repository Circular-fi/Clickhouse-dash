#pragma once

#include "query_registry.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

class ClickHouseClientPool;

struct QueryAnalysisOptions {
  int log_lookup_timeout_ms = 2000;
  bool flush_logs = false;
  bool include_original_trace_fields = false;
};

struct QueryLogAnalysisRow {
  std::string hostname;
  std::string query_id;
  std::string initial_query_id;
  std::string status;
  std::string event_time;
  uint64_t event_time_us = 0;
  uint64_t duration_ms = 0;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t written_rows = 0;
  uint64_t written_bytes = 0;
  uint64_t result_rows = 0;
  uint64_t result_bytes = 0;
  int64_t memory_usage = 0;
  uint64_t peak_threads_usage = 0;
  uint64_t user_time_us = 0;
  uint64_t system_time_us = 0;
  std::vector<std::string> databases;
  std::vector<std::string> tables;
  std::vector<std::string> projections;
  int32_t exception_code = 0;
  std::string exception;
  std::string query;
  std::string log_processors_profiles;
  bool is_initial_query = false;
};

struct ProcessorAnalysisRow {
  std::string hostname;
  std::string initial_query_id;
  std::string query_id;
  uint64_t id = 0;
  std::vector<uint64_t> parent_ids;
  uint64_t plan_step = 0;
  std::string plan_step_name;
  std::string plan_step_description;
  uint64_t plan_group = 0;
  std::string name;
  uint64_t elapsed_us = 0;
  uint64_t input_wait_elapsed_us = 0;
  uint64_t output_wait_elapsed_us = 0;
  uint64_t input_rows = 0;
  uint64_t input_bytes = 0;
  uint64_t output_rows = 0;
  uint64_t output_bytes = 0;
};


struct ProcessorTraceSummaryRow {
  std::string hostname;
  std::string trace_id;
  std::string query_id;
  std::string parent_span_id;
  std::string operation_name;
  uint64_t first_start_time_us = 0;
  uint64_t last_finish_time_us = 0;
  uint64_t active_time_us = 0;
  uint64_t event_count = 0;
};

struct OpenTelemetrySpanAnalysisRow {
  std::string hostname;
  std::string trace_id;
  std::string span_id;
  std::string parent_span_id;
  std::string operation_name;
  uint64_t start_time_us = 0;
  uint64_t finish_time_us = 0;
  std::string query_id;
  std::string thread_id;
  std::string thread_number;
};

struct QueryViewAnalysisRow {
  std::string hostname;
  std::string event_time;
  uint64_t event_time_us = 0;
  uint64_t duration_ms = 0;
  std::string initial_query_id;
  std::string view_name;
  std::string view_type;
  std::string view_target;
  uint64_t read_rows = 0;
  uint64_t read_bytes = 0;
  uint64_t written_rows = 0;
  uint64_t written_bytes = 0;
  uint64_t peak_memory_usage = 0;
  std::string status;
  int32_t exception_code = 0;
  std::string exception;
};

struct QueryAnalysisResult {
  QueryRegistryRecord record;
  bool query_log_available = false;
  bool processors_profile_available = false;
  bool query_views_available = false;
  bool opentelemetry_span_log_available = false;
  bool trace_truncated = false;
  bool processors_truncated = false;
  bool processor_trace_summary_truncated = false;
  bool processor_trace_summary_available = false;
  uint64_t processor_trace_bucket_us = 0;
  bool logs_pending = false;
  // Fatal collection failures (system context, mandatory flush, core query_log)
  // are surfaced by the API as an explicit non-2xx error. Optional profiling
  // tables keep their dedicated availability/error fields below.
  std::string fatal_error;
  std::string query_log_error;
  std::string processors_profile_error;
  std::string query_views_error;
  std::string opentelemetry_span_log_error;
  std::string processor_trace_summary_error;
  std::string distributed_error;
  std::vector<QueryLogAnalysisRow> query_log;
  std::vector<QueryLogAnalysisRow> distributed_children;
  std::vector<ProcessorAnalysisRow> processors;
  std::vector<OpenTelemetrySpanAnalysisRow> trace_spans;
  std::vector<ProcessorTraceSummaryRow> processor_trace_summary;
  std::vector<QueryViewAnalysisRow> views;
};

QueryAnalysisResult collect_query_analysis(
    const QueryRegistryRecord& record,
    const std::string& system_uri,
    const std::shared_ptr<ClickHouseClientPool>& client_pool,
    const QueryAnalysisOptions& options);

} // namespace chdash
