#include "mcp_tools_units.hpp"

#include "mcp_scope.hpp"
#include "otel_allowlist.hpp"
#include "sql_literal.hpp"

#include <algorithm>
#include <cmath>
#include <functional>

namespace chdash {
namespace mcp_tools {

// ---- observability --------------------------------------------------------------------------------------
//
// Six simple tools read the OpenTelemetry tables of the ClickHouse exporter (traces, logs, metrics).
// ChDash writes the SQL, so the client needs none. Every statement is bounded by a time window and a row limit.
// Each statement reads only the tables that the key's data scope allows.

namespace {

std::string qualified(const std::string& database, const std::string& table) {
  return sql::quote_ident(database) + "." + sql::quote_ident(table);
}

const McpObservabilityConfig& obs(const Ctx& ctx) {
  const auto it = ctx.config.observability_by_host.find(ctx.host);
  return it == ctx.config.observability_by_host.end() ? ctx.config.observability : it->second;
}

void need_traces(const Ctx& ctx) {
  if (!obs(ctx).traces) fail("not_enabled", "traces are not enabled in the ChDash configuration (traces { enabled = true })");
}

void need_logs(const Ctx& ctx) {
  if (!obs(ctx).logs) fail("not_enabled", "logs are not enabled in the ChDash configuration (logs { enabled = true })");
}

const char* const kMetricKinds[] = {"gauge", "sum", "histogram"};

std::string metric_table(const Ctx& ctx, const std::string& kind) { return obs(ctx).metrics_prefix + "_" + kind; }

void need_metrics(const Ctx& ctx) {
  if (!obs(ctx).metrics) fail("not_enabled", "metrics are not enabled in the ChDash configuration (metrics { enabled = true })");
}

// The services that the pages show are set by traces.service_allowlist, the allowlist of the three signals.
// The allowlist is ANDed into the WHERE clause of every query of these tools. The tools read with the system user.
// So a key never reads more than the pages show.
std::string visible_services(const Ctx& ctx) { return otel::service_allowlist_predicate(obs(ctx).service_allowlist); }

// Minutes back from now, within what the configuration allows.
int64_t since_minutes(const Ctx& ctx, const rapidjson::Value& args) {
  return opt_int(args, "since_minutes", 1, std::max<int64_t>(1, obs(ctx).max_lookback_minutes), 60);
}

std::string window(const char* column, int64_t minutes) {
  return std::string(column) + " >= now() - INTERVAL " + std::to_string(minutes) + " MINUTE";
}

// Rows the client asked for (default `fallback`), never above the cap of the key.
int64_t wanted_rows(const Ctx& ctx, const rapidjson::Value& args, int64_t fallback) {
  return std::min(opt_int(args, "limit", 1, 1000000, fallback), ctx.max_rows);
}

bool hex_id(const std::string& text) {
  return text.size() == 32 && std::all_of(text.begin(), text.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  });
}

// An object for each row, with its fields named by `names`. The SQL columns come in the same order.
// The fields of `untrusted` are text of the telemetry (a service, a span name, a log line, a metric label).
// They go in the object `untrusted` of the row (contract 5.2).
// A field whose name ends with _truncated is a flag. It is written next to `untrusted`, and only when it is true.
void write_records(Writer& w, const char* key, const McpDbResult& res, const std::vector<const char*>& names, size_t keep,
                   const std::vector<std::string>& untrusted) {
  const auto is_untrusted = [&](const char* name) { return std::find(untrusted.begin(), untrusted.end(), name) != untrusted.end(); };
  const auto is_flag = [](std::string_view name) { return name.size() > 10 && name.substr(name.size() - 10) == "_truncated"; };
  w.Key(key);
  w.StartArray();
  size_t written = 0;
  for (const auto& row : res.rows) {
    if (written++ >= keep) break;
    w.StartObject();
    for (size_t i = 0; i < names.size() && i < row.size(); ++i) {
      if (is_untrusted(names[i])) continue;
      if (is_flag(names[i])) {
        if (row[i] == "1" || row[i] == "true") {
          w.Key(names[i]);
          w.Bool(true);
        }
        continue;
      }
      w.Key(names[i]);
      put_cell(w, row[i]);
    }
    if (!untrusted.empty()) {
      w.Key("untrusted");
      w.StartObject();
      for (size_t i = 0; i < names.size() && i < row.size(); ++i) {
        if (!is_untrusted(names[i])) continue;
        w.Key(names[i]);
        put_cell(w, row[i]);
      }
      w.EndObject();
    }
    w.EndObject();
  }
  w.EndArray();
}

// The answer of a list: the rows kept, how many, and whether more existed than the limit.
std::string finish_records(Ctx& ctx, const McpDbResult& res, const char* key, const std::vector<const char*>& names, int64_t limit,
                           const std::function<void(Writer&)>& extra = nullptr, const std::vector<std::string>& untrusted = {}) {
  const size_t keep = static_cast<size_t>(limit);
  const bool more = res.rows.size() > keep || res.truncated;
  rapidjson::StringBuffer sb;
  Writer w(sb);
  w.StartObject();
  w.Key("host"); put(w, ctx.host);
  if (extra) extra(w);
  write_records(w, key, res, names, keep, untrusted);
  w.Key("count"); w.Uint64(std::min(res.rows.size(), keep));
  w.Key("truncated"); w.Bool(more);
  w.Key("elapsed_ms"); w.Int64(res.elapsed_ms);
  w.EndObject();
  ctx.rows_out = std::min(res.rows.size(), keep);
  return finish(sb);
}

}  // namespace

std::string tool_list_services(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "since_minutes", "signal"});
  resolve_host(ctx, args);
  const std::string signal = opt_string(args, "signal", 16).value_or("traces");
  const int64_t minutes = since_minutes(ctx, args);
  std::string sql;
  std::vector<const char*> names;
  if (signal == "traces") {
    need_traces(ctx);
    sql = "SELECT ServiceName, count() AS spans, countIf(StatusCode = 'Error') AS errors, round(avg(Duration) / 1000000, 3) AS avg_ms FROM " +
          qualified(obs(ctx).traces_database, obs(ctx).traces_table) + " WHERE " + window("Timestamp", minutes) + " AND " + visible_services(ctx) +
          " GROUP BY ServiceName ORDER BY spans DESC";
    names = {"service", "spans", "errors", "avg_ms"};
  } else if (signal == "logs") {
    need_logs(ctx);
    sql = "SELECT ServiceName, count() AS records, countIf(SeverityNumber >= 17) AS errors FROM " +
          qualified(obs(ctx).logs_database, obs(ctx).logs_table) + " WHERE " + window("Timestamp", minutes) + " AND " + visible_services(ctx) +
          " GROUP BY ServiceName ORDER BY records DESC";
    names = {"service", "records", "errors"};
  } else {
    fail("invalid_argument", "signal must be traces or logs");
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx, sql + " LIMIT " + std::to_string(limit + 1), ctx.system_limits);
  return finish_records(ctx, res, "services", names, limit, [&](Writer& w) {
    w.Key("signal"); put(w, signal);
    w.Key("since_minutes"); w.Int64(minutes);
  }, {"service"});
}

std::string tool_search_traces(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "operation", "status", "min_duration_ms", "order", "since_minutes", "limit"});
  resolve_host(ctx, args);
  need_traces(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  const int64_t limit = wanted_rows(ctx, args, 20);
  std::string where = window("Timestamp", minutes) + " AND ParentSpanId = '' AND " + visible_services(ctx);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + sql::quote_string(*service);
  }
  if (const auto operation = opt_string(args, "operation", 256); operation && !operation->empty()) {
    where += " AND positionCaseInsensitive(SpanName, " + sql::quote_string(*operation) + ") > 0";
  }
  if (const auto status = opt_string(args, "status", 16); status && !status->empty()) {
    if (*status != "Error" && *status != "Ok" && *status != "Unset") fail("invalid_argument", "status must be Error, Ok or Unset");
    where += " AND StatusCode = " + sql::quote_string(*status);
  }
  if (const auto it = args.FindMember("min_duration_ms"); it != args.MemberEnd() && !it->value.IsNull()) {
    if (!it->value.IsNumber() || it->value.GetDouble() < 0 || !std::isfinite(it->value.GetDouble())) {
      fail("invalid_argument", "min_duration_ms must be a number of 0 or more");
    }
    char buf[40];
    std::snprintf(buf, sizeof(buf), "%.0f", it->value.GetDouble() * 1000000.0);
    where += std::string(" AND Duration >= ") + buf;
  }
  const std::string order = opt_string(args, "order", 16).value_or("recent");
  if (order != "recent" && order != "slowest") fail("invalid_argument", "order must be recent or slowest");
  const McpDbResult res = run(ctx,
      "SELECT TraceId, ServiceName, SpanName, toString(Timestamp) AS started, round(Duration / 1000000, 3) AS duration_ms, StatusCode FROM " +
          qualified(obs(ctx).traces_database, obs(ctx).traces_table) + " WHERE " + where + " ORDER BY " +
          (order == "slowest" ? "Duration DESC" : "Timestamp DESC") + " LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "traces", {"trace_id", "service", "operation", "started", "duration_ms", "status"}, limit,
                        [&](Writer& w) {
                          w.Key("since_minutes"); w.Int64(minutes);
                          w.Key("order"); put(w, order);
                        },
                        {"service", "operation"});
}

std::string tool_get_trace(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "trace_id"});
  resolve_host(ctx, args);
  need_traces(ctx);
  const std::string trace_id = req_string(args, "trace_id", 64);
  if (!hex_id(trace_id)) fail("invalid_argument", "trace_id must be 32 hexadecimal characters");
  const std::string table = qualified(obs(ctx).traces_database, obs(ctx).traces_table);

  // The window of the trace comes from its index, when the configuration has one. Otherwise, it is the whole lookback.
  std::string range = window("Timestamp", std::max<int64_t>(1, obs(ctx).max_lookback_minutes));
  if (!obs(ctx).traces_index_table.empty()) {
    try {
      const McpDbResult bounds = run(ctx,
          "SELECT toString(min(Start)), toString(max(End)), count() FROM " + qualified(obs(ctx).traces_database, obs(ctx).traces_index_table) +
              " WHERE TraceId = " + sql::quote_string(trace_id),
          ctx.system_schema_limits);
      if (!bounds.rows.empty() && bounds.rows[0].size() >= 3 && cell_u64(bounds.rows[0][2]) > 0) {
        range = "Timestamp >= parseDateTime64BestEffort(" + sql::quote_string(cell_text(bounds.rows[0][0])) + ", 9) - INTERVAL 1 MINUTE AND " +
                "Timestamp <= parseDateTime64BestEffort(" + sql::quote_string(cell_text(bounds.rows[0][1])) + ", 9) + INTERVAL 1 MINUTE";
      }
    } catch (const ToolFailure&) {
      // No usable index: the lookback window still bounds the read.
    }
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx,
      "SELECT SpanId, ParentSpanId, ServiceName, SpanName, SpanKind, toString(Timestamp) AS started, round(Duration / 1000000, 3) AS duration_ms, "
      "StatusCode, StatusMessage FROM " + table + " WHERE TraceId = " + sql::quote_string(trace_id) + " AND " + range + " AND " + visible_services(ctx) +
          " ORDER BY Timestamp LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  if (res.rows.empty()) fail("trace_not_found", "no span of the trace " + trace_id + " in the last " + std::to_string(obs(ctx).max_lookback_minutes) + " minutes");
  return finish_records(ctx, res, "spans", {"span_id", "parent_span_id", "service", "operation", "kind", "started", "duration_ms", "status", "status_message"}, limit,
                        [&](Writer& w) { w.Key("trace_id"); put(w, trace_id); }, {"service", "operation", "status_message"});
}

std::string tool_search_logs(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "severity", "contains", "trace_id", "since_minutes", "limit"});
  resolve_host(ctx, args);
  need_logs(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  const int64_t limit = wanted_rows(ctx, args, 20);
  std::string where = window("Timestamp", minutes) + " AND " + visible_services(ctx);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + sql::quote_string(*service);
  }
  if (const auto severity = opt_string(args, "severity", 16); severity && !severity->empty()) {
    static const std::pair<const char*, int> levels[] = {{"trace", 1}, {"debug", 5}, {"info", 9}, {"warn", 13}, {"error", 17}};
    int number = 0;
    for (const auto& level : levels) {
      if (*severity == level.first) number = level.second;
    }
    if (number == 0) fail("invalid_argument", "severity must be trace, debug, info, warn or error");
    where += " AND SeverityNumber >= " + std::to_string(number);
  }
  if (const auto text = opt_string(args, "contains", 512); text && !text->empty()) {
    where += " AND positionCaseInsensitive(Body, " + sql::quote_string(*text) + ") > 0";
  }
  if (const auto trace = opt_string(args, "trace_id", 64); trace && !trace->empty()) {
    if (!hex_id(*trace)) fail("invalid_argument", "trace_id must be 32 hexadecimal characters");
    where += " AND TraceId = " + sql::quote_string(*trace);
  }
  const McpDbResult res = run(ctx,
      "SELECT toString(Timestamp) AS time, ServiceName, SeverityText, SeverityNumber, TraceId, SpanId, substringUTF8(Body, 1, 2000) AS message, "
      "lengthUTF8(Body) > 2000 AS message_truncated FROM " +
          qualified(obs(ctx).logs_database, obs(ctx).logs_table) + " WHERE " + where + " ORDER BY Timestamp DESC LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "records", {"time", "service", "severity", "severity_number", "trace_id", "span_id", "message", "message_truncated"},
                        limit, [&](Writer& w) { w.Key("since_minutes"); w.Int64(minutes); }, {"service", "message"});
}

std::string tool_list_metrics(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "service", "filter", "since_minutes"});
  resolve_host(ctx, args);
  need_metrics(ctx);
  const int64_t minutes = since_minutes(ctx, args);
  std::string where = window("TimeUnix", minutes) + " AND " + visible_services(ctx);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    where += " AND ServiceName = " + sql::quote_string(*service);
  }
  if (const auto filter = opt_string(args, "filter", 256); filter && !filter->empty()) {
    where += " AND MetricName LIKE " + sql::quote_string(mcp_glob_to_like(*filter));
  }
  std::string sql;
  for (const char* kind : kMetricKinds) {
    if (!sql.empty()) sql += " UNION ALL ";
    sql += std::string("SELECT '") + kind + "' AS kind, MetricName, any(MetricUnit) AS unit, any(MetricDescription) AS description FROM " +
           qualified(obs(ctx).metrics_database, metric_table(ctx, kind)) + " WHERE " + where + " GROUP BY MetricName";
  }
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx, "SELECT * FROM (" + sql + ") ORDER BY MetricName, kind LIMIT " + std::to_string(limit + 1), ctx.system_limits);
  return finish_records(ctx, res, "metrics", {"kind", "name", "unit", "description"}, limit,
                        [&](Writer& w) { w.Key("since_minutes"); w.Int64(minutes); }, {"name", "unit", "description"});
}

std::string tool_query_metric(Ctx& ctx, const rapidjson::Value& args) {
  reject_unknown(args, {"host", "metric", "service", "kind", "aggregation", "step_seconds", "since_minutes"});
  resolve_host(ctx, args);
  need_metrics(ctx);
  const std::string metric = req_string(args, "metric", 512);
  const int64_t minutes = since_minutes(ctx, args);
  std::string base = window("TimeUnix", minutes) + " AND " + visible_services(ctx) + " AND MetricName = " + sql::quote_string(metric);
  if (const auto service = opt_string(args, "service", 256); service && !service->empty()) {
    base += " AND ServiceName = " + sql::quote_string(*service);
  }

  std::string kind = opt_string(args, "kind", 16).value_or("");
  if (!kind.empty() && kind != "gauge" && kind != "sum" && kind != "histogram") fail("invalid_argument", "kind must be gauge, sum or histogram");
  if (kind.empty()) {
    // The kind of the metric: the first table that has it in the window.
    for (const char* candidate : kMetricKinds) {
      const McpDbResult found = run(ctx,
          "SELECT 1 FROM " + qualified(obs(ctx).metrics_database, metric_table(ctx, candidate)) + " WHERE " + base + " LIMIT 1", ctx.system_schema_limits);
      if (!found.rows.empty()) {
        kind = candidate;
        break;
      }
    }
    if (kind.empty()) fail("metric_not_found", "no point of the metric " + metric + " in the last " + std::to_string(minutes) + " minutes; call list_metrics");
  }

  const std::string aggregation = opt_string(args, "aggregation", 16).value_or("avg");
  std::string value;
  if (kind == "histogram") {
    if (aggregation == "avg") value = "sum(Sum) / greatest(sum(Count), 1)";
    else if (aggregation == "sum") value = "sum(Sum)";
    else if (aggregation == "count") value = "sum(Count)";
    else fail("invalid_argument", "a histogram has the aggregations avg, sum and count");
  } else {
    if (aggregation == "avg") value = "avg(Value)";
    else if (aggregation == "min") value = "min(Value)";
    else if (aggregation == "max") value = "max(Value)";
    else if (aggregation == "sum") value = "sum(Value)";
    else if (aggregation == "last") value = "argMax(Value, TimeUnix)";
    else fail("invalid_argument", "a " + kind + " has the aggregations avg, min, max, sum and last");
  }
  const int64_t step = opt_int(args, "step_seconds", 1, minutes * 60, std::max<int64_t>(10, minutes * 60 / 100));
  const int64_t limit = ctx.max_rows;
  const McpDbResult res = run(ctx,
      "SELECT toString(toStartOfInterval(TimeUnix, INTERVAL " + std::to_string(step) + " SECOND)) AS time, round(" + value + ", 6) AS value, count() AS points FROM " +
          qualified(obs(ctx).metrics_database, metric_table(ctx, kind)) + " WHERE " + base + " GROUP BY time ORDER BY time LIMIT " + std::to_string(limit + 1),
      ctx.system_limits);
  return finish_records(ctx, res, "series", {"time", "value", "points"}, limit, [&](Writer& w) {
    w.Key("metric"); put(w, metric);
    w.Key("kind"); put(w, kind);
    w.Key("aggregation"); put(w, aggregation);
    w.Key("step_seconds"); w.Int64(step);
    w.Key("since_minutes"); w.Int64(minutes);
  });
}

}  // namespace mcp_tools
}  // namespace chdash
