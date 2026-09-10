#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "deep_analysis.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "query_analysis.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
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
  writer.Key("id"); writer.Uint64(row.id);
  writer.Key("parent_ids");
  writer.StartArray();
  for (uint64_t id : row.parent_ids) writer.Uint64(id);
  writer.EndArray();
  writer.Key("plan_step"); writer.Uint64(row.plan_step);
  writer.Key("plan_step_name"); writer.String(row.plan_step_name.c_str());
  writer.Key("plan_step_description"); writer.String(row.plan_step_description.c_str());
  writer.Key("plan_group"); writer.Uint64(row.plan_group);
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

void write_otel_span(
    rapidjson::Writer<rapidjson::StringBuffer>& writer,
    const OpenTelemetrySpanAnalysisRow& row) {
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
  writer.Key("query_views_log"); writer.Bool(analysis.query_views_available);
  writer.Key("query_log_error"); writer.String(analysis.query_log_error.c_str());
  writer.Key("processors_profile_error"); writer.String(analysis.processors_profile_error.c_str());
  writer.Key("opentelemetry_span_log_error"); writer.String(analysis.opentelemetry_span_log_error.c_str());
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

  writer.Key("processors");
  writer.StartArray();
  for (const auto& row : analysis.processors) write_processor(writer, row);
  writer.EndArray();

  writer.Key("trace_truncated"); writer.Bool(analysis.trace_truncated);
  writer.Key("trace_spans");
  writer.StartArray();
  for (const auto& row : analysis.trace_spans) write_otel_span(writer, row);
  writer.EndArray();

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
  res.set_content(buffer.GetString(), "application/json");
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
