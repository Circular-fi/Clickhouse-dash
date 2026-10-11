#include "system_json.hpp"

#include "json_text.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <cmath>
#include <cstdio>
#include <map>
#include <set>

namespace chdash {
namespace system_page {

namespace {

void write_string(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::string& value) {
  w.Key(key);
  write_json_text(w, value);
}

void write_string_value(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::string& value) {
  write_json_text(w, value);
}

void write_optional(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::optional<uint64_t>& value) {
  w.Key(key);
  if (value) w.Uint64(*value);
  else w.Null();
}

void write_series_value(rapidjson::Writer<rapidjson::StringBuffer>& w, double value) {
  const std::string text = series_number(value);
  if (text == "null") {
    w.Null();
    return;
  }
  w.RawValue(text.c_str(), text.size(), rapidjson::kNumberType);
}

void write_optional_bool(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::optional<bool>& value) {
  w.Key(key);
  if (value) w.Bool(*value);
  else w.Null();
}

void write_source(rapidjson::Writer<rapidjson::StringBuffer>& w, const MonitorSeriesSource& source) {
  w.StartObject();
  write_string(w, "table", source.table);
  write_string(w, "status", source.status);
  write_string(w, "message", source.message);
  write_string(w, "hint", source.hint);
  w.Key("rows_read"); w.Uint64(source.rows_read);
  w.Key("elapsed_ms"); w.Uint64(source.elapsed_ms);
  w.Key("missing");
  w.StartArray();
  for (const auto& item : source.missing) write_string_value(w, item);
  w.EndArray();
  w.EndObject();
}

void write_query_read(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const MonitorQueryRead& read) {
  w.Key(key);
  w.StartObject();
  write_string(w, "status", read.status);
  write_string(w, "message", read.message);
  w.Key("rows_read"); w.Uint64(read.rows_read);
  w.Key("bytes_read"); w.Uint64(read.bytes_read);
  w.Key("elapsed_ms"); w.Uint64(read.elapsed_ms);
  w.EndObject();
}

void write_strings(rapidjson::Writer<rapidjson::StringBuffer>& w, const char* key, const std::vector<std::string>& values) {
  w.Key(key);
  w.StartArray();
  for (const auto& value : values) write_string_value(w, value);
  w.EndArray();
}

// The answer's status in the Overview's unavailable_panels shape.
void write_queries_status(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::string& status, const std::string& message,
                          const std::string& hint, uint64_t suggested_span_s) {
  write_string(w, "status", status);
  write_string(w, "message", message);
  write_string(w, "hint", hint);
  w.Key("suggested_span_ms");
  if (suggested_span_s) w.Uint64(suggested_span_s * 1000);
  else w.Null();
  w.Key("unavailable_panels");
  w.StartArray();
  if (status != "ok") {
    w.StartObject();
    write_string(w, "panel", "queries");
    write_string(w, "table", "query_log");
    write_string(w, "reason", status);
    write_string(w, "message", message);
    write_string(w, "hint", hint);
    w.EndObject();
  }
  w.EndArray();
}

} // namespace

// Six significant digits (a chart needs no more), except that a number of a million or more is written whole: a size in bytes keeps every digit,
// and a growth of a few megabytes on a terabyte disk is not rounded away. "null" for a bucket without a sample.
std::string series_number(double value) {
  if (!std::isfinite(value)) return "null";
  if (std::fabs(value) >= 1e6 && std::fabs(value) < 9007199254740992.0) return std::to_string(static_cast<long long>(std::llround(value)));
  char buffer[32];
  const int size = std::snprintf(buffer, sizeof(buffer), "%.6g", value);
  if (size <= 0 || size >= static_cast<int>(sizeof(buffer))) return std::to_string(value);
  return std::string(buffer, static_cast<size_t>(size));
}

std::string overview_json(const std::string& host_id, const SystemMonitorOverview& overview, bool stale) {
  rapidjson::StringBuffer sb(nullptr, 8 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(overview.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  // Every figure is this server's own (system tables are per node); the
  // clusterAllReplicas view is opt-in (system.cluster_fanout).
  write_string(w, "scope", "server");

  w.Key("server");
  w.StartObject();
  write_string(w, "hostname", overview.hostname);
  write_string(w, "version", overview.version);
  write_string(w, "timezone", overview.timezone);
  write_optional(w, "uptime_seconds", overview.uptime_seconds);
  w.EndObject();

  w.Key("metrics");
  w.StartObject();
  for (const auto& [name, value] : overview.metrics) {
    write_json_key(w, name);
    w.Double(value);
  }
  w.EndObject();

  w.Key("topology");
  w.StartObject();
  w.Key("row_limit"); w.Uint64(kMonitorTopologyRowLimit);
  w.Key("truncated"); w.Bool(overview.topology_truncated);
  w.Key("nodes");
  w.StartArray();
  for (const auto& node : overview.topology) {
    w.StartObject();
    write_string(w, "cluster", node.cluster);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("shard_weight"); w.Uint64(node.shard_weight);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    write_string(w, "host_name", node.host_name);
    write_string(w, "host_address", node.host_address);
    w.Key("port"); w.Uint64(node.port);
    w.Key("is_local"); w.Bool(node.is_local);
    write_optional(w, "errors_count", node.errors_count);
    write_optional(w, "slowdowns_count", node.slowdowns_count);
    write_optional(w, "estimated_recovery_time", node.estimated_recovery_time);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  w.Key("replication");
  if (overview.replication) {
    const auto& r = *overview.replication;
    w.StartObject();
    w.Key("tables"); w.Uint64(r.tables);
    w.Key("readonly"); w.Uint64(r.readonly);
    w.Key("session_expired"); w.Uint64(r.session_expired);
    w.Key("max_delay_seconds"); w.Uint64(r.max_delay_seconds);
    w.Key("queue_size"); w.Uint64(r.queue_size);
    w.Key("inserts_in_queue"); w.Uint64(r.inserts_in_queue);
    w.Key("merges_in_queue"); w.Uint64(r.merges_in_queue);
    w.Key("future_parts_over"); w.Uint64(r.future_parts_over);
    w.Key("parts_to_check_over"); w.Uint64(r.parts_to_check_over);
    w.Key("queue_over"); w.Uint64(r.queue_over);
    w.Key("inserts_over"); w.Uint64(r.inserts_over);
    w.Key("truncated"); w.Bool(r.truncated);
    w.EndObject();
  } else {
    w.Null();
  }

  w.Key("logs");
  w.StartObject();
  for (const auto& [name, present] : overview.logs) {
    write_json_key(w, name);
    w.Bool(present);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& issue : overview.unavailable_panels) {
    w.StartObject();
    write_string(w, "panel", issue.panel);
    write_string(w, "table", issue.table);
    write_string(w, "reason", issue.reason);
    write_string(w, "message", issue.message);
    write_string(w, "hint", issue.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string series_json(const std::string& host_id, const SeriesRequest& request, const SystemMonitorSeries& series, bool stale,
                        const SystemSettings& settings) {
  const std::string panel = "performance";
  const uint64_t from_ms = request.from_ms, to_ms = request.to_ms;
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "panel", panel);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(series.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  // The window asked for, and the aligned one the buckets cover.
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(series.window.from_s * 1000);
  w.Key("to_ms"); w.Uint64(series.window.to_s * 1000);
  w.Key("step_seconds"); w.Uint(series.window.step_s);
  w.Key("limits");
  w.StartObject();
  w.Key("max_lookback_days"); w.Int(settings.max_lookback_days);
  w.Key("query_log_max_lookback_hours"); w.Int(settings.query_log_max_lookback_hours);
  w.Key("max_points"); w.Uint64(kMonitorSeriesMaxPoints);
  w.EndObject();
  w.Key("replicated_tables"); w.Bool(series.replicated_tables);

  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : series.buckets) w.Uint64(t * 1000);
  w.EndArray();

  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : series.series) {
    write_json_key(w, name);
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();

  w.Key("sources");
  w.StartObject();
  for (const auto& [name, source] : series.sources) {
    write_json_key(w, name);
    w.StartObject();
    write_string(w, "table", source.table);
    write_string(w, "status", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.Key("rows_read"); w.Uint64(source.rows_read);
    w.Key("elapsed_ms"); w.Uint64(source.elapsed_ms);
    w.Key("missing");
    w.StartArray();
    for (const auto& item : source.missing) write_string_value(w, item);
    w.EndArray();
    w.EndObject();
  }
  w.EndObject();

  // The sources that could not be read, in the Overview's shape (the
  // window being wider than query_log's lookback is not a failure).
  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& [name, source] : series.sources) {
    if (source.status == "ok" || source.status == "out_of_range") continue;
    w.StartObject();
    write_string(w, "panel", name);
    write_string(w, "table", source.table);
    write_string(w, "reason", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string growth_json(const std::string& host_id, const SeriesRequest& request, const SystemMonitorDiskGrowth& data, bool stale,
                        const SystemSettings& settings) {
  const uint64_t from_ms = request.from_ms, to_ms = request.to_ms;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "panel", "disk_growth");
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.window.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.window.to_s * 1000);
  w.Key("step_seconds"); w.Uint(data.window.step_s);
  w.Key("limits");
  w.StartObject();
  w.Key("max_lookback_days"); w.Int(settings.max_lookback_days);
  w.Key("disk_growth_days"); w.Int(settings.disk_growth_days);
  w.Key("max_points"); w.Uint64(kMonitorSeriesMaxPoints);
  w.Key("trend_min_points"); w.Uint64(kMonitorDiskTrendMinPoints);
  w.Key("trend_min_span_seconds"); w.Uint64(kMonitorDiskTrendMinSpanSeconds);
  w.EndObject();
  // Which form of the per-disk metrics this server logs: "key" (26.8+:
  // metric 'DiskUsed' with the disk in `key`, the legacy names read too) or
  // "names" (DiskUsed_<disk>).
  write_string(w, "disk_metric_form", data.key_column ? "key" : "names");

  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : data.buckets) w.Uint64(t * 1000);
  w.EndArray();

  w.Key("disks");
  w.StartArray();
  for (const auto& disk : data.disks) {
    w.StartObject();
    write_string(w, "name", disk.name);
    w.Key("free_space"); w.Uint64(disk.free_space);
    w.Key("total_space"); w.Uint64(disk.total_space);
    w.Key("used");
    w.StartArray();
    for (const double value : disk.used) write_series_value(w, value);
    w.EndArray();
    w.Key("trend");
    w.StartObject();
    write_string(w, "status", disk.trend.status);
    w.Key("points"); w.Uint64(disk.trend.points);
    w.Key("span_seconds"); w.Uint64(disk.trend.span_s);
    w.Key("slope_bytes_per_day");
    if (disk.trend.status == "growing" || disk.trend.status == "not_growing") write_series_value(w, disk.trend.slope_bytes_per_day);
    else w.Null();
    w.Key("days_until_full");
    if (disk.trend.days_until_full) write_series_value(w, *disk.trend.days_until_full);
    else w.Null();
    w.EndObject();
    w.EndObject();
  }
  w.EndArray();

  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : data.series) {
    write_json_key(w, name);
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();

  w.Key("sources");
  w.StartObject();
  for (const auto& [name, source] : data.sources) {
    write_json_key(w, name);
    write_source(w, source);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& [name, source] : data.sources) {
    if (source.status == "ok") continue;
    w.StartObject();
    write_string(w, "panel", name);
    write_string(w, "table", source.table);
    write_string(w, "reason", source.status);
    write_string(w, "message", source.message);
    write_string(w, "hint", source.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string disks_json(const std::string& host_id, const SystemMonitorDisks& data, bool stale, const SystemSettings& settings) {
  // The policies and volumes each disk belongs to.
  std::map<std::string, std::vector<std::pair<std::string, std::string>>> membership;
  for (const auto& volume : data.volumes) {
    for (const auto& disk : volume.disks) membership[disk].emplace_back(volume.policy, volume.volume);
  }

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("limits");
  w.StartObject();
  w.Key("disk_row_limit"); w.Uint64(kMonitorDiskRowLimit);
  w.Key("policy_row_limit"); w.Uint64(kMonitorPolicyRowLimit);
  w.Key("usage_row_limit"); w.Uint64(kMonitorDiskUsageRowLimit);
  w.Key("disk_growth_days"); w.Int(settings.disk_growth_days);
  w.Key("max_lookback_days"); w.Int(settings.max_lookback_days);
  w.EndObject();

  w.Key("disks");
  w.StartArray();
  for (const auto& disk : data.disks) {
    w.StartObject();
    write_string(w, "name", disk.name);
    write_string(w, "path", disk.path);
    write_string(w, "type", disk.type);
    write_string(w, "object_storage_type", disk.object_storage_type);
    write_string(w, "cache_path", disk.cache_path);
    w.Key("free_space"); w.Uint64(disk.free_space);
    w.Key("total_space"); w.Uint64(disk.total_space);
    // Used: what is not free, null when the disk reports no capacity
    // (object storage).
    w.Key("used_space");
    if (disk.total_space > 0) w.Uint64(disk.total_space > disk.free_space ? disk.total_space - disk.free_space : 0);
    else w.Null();
    write_optional(w, "unreserved_space", disk.unreserved_space);
    write_optional(w, "keep_free_space", disk.keep_free_space);
    write_optional_bool(w, "is_read_only", disk.is_read_only);
    write_optional_bool(w, "is_broken", disk.is_broken);
    write_optional_bool(w, "is_encrypted", disk.is_encrypted);
    write_optional_bool(w, "is_remote", disk.is_remote);
    w.Key("policies");
    w.StartArray();
    const auto it = membership.find(disk.name);
    if (it != membership.end()) {
      for (const auto& [policy, volume] : it->second) {
        w.StartObject();
        write_string(w, "policy", policy);
        write_string(w, "volume", volume);
        w.EndObject();
      }
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("disks_truncated"); w.Bool(data.disks_truncated);

  // Policies, their volumes in priority order.
  w.Key("policies");
  w.StartArray();
  for (size_t i = 0; i < data.volumes.size();) {
    const std::string& policy = data.volumes[i].policy;
    w.StartObject();
    write_string(w, "name", policy);
    w.Key("volumes");
    w.StartArray();
    for (; i < data.volumes.size() && data.volumes[i].policy == policy; ++i) {
      const auto& volume = data.volumes[i];
      w.StartObject();
      write_string(w, "name", volume.volume);
      w.Key("priority"); w.Uint64(volume.priority);
      write_strings(w, "disks", volume.disks);
      write_string(w, "volume_type", volume.volume_type);
      write_optional(w, "max_data_part_size", volume.max_data_part_size);
      w.Key("move_factor");
      if (volume.move_factor) write_series_value(w, *volume.move_factor);
      else w.Null();
      write_optional_bool(w, "prefer_not_to_merge", volume.prefer_not_to_merge);
      write_optional_bool(w, "perform_ttl_move_on_insert", volume.perform_ttl_move_on_insert);
      write_string(w, "load_balancing", volume.load_balancing);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("policies_truncated"); w.Bool(data.volumes_truncated);

  // Bytes by disk and database: the runner-visible databases only.
  w.Key("usage");
  w.StartObject();
  w.Key("truncated"); w.Bool(data.usage_truncated);
  w.Key("rows");
  w.StartArray();
  for (const auto& usage : data.usage) {
    w.StartObject();
    write_string(w, "disk", usage.disk);
    write_string(w, "database", usage.database);
    w.Key("bytes"); w.Uint64(usage.bytes);
    w.Key("rows"); w.Uint64(usage.rows);
    w.Key("parts"); w.Uint64(usage.parts);
    w.Key("compact_parts"); w.Uint64(usage.compact_parts);
    w.EndObject();
  }
  w.EndArray();
  // Per disk: every runner-visible database's bytes, parts and count, the
  // rows past the cut included.
  w.Key("disks");
  w.StartObject();
  std::set<std::string> written;
  for (const auto& usage : data.usage) {
    if (!written.insert(usage.disk).second) continue;
    write_json_key(w, usage.disk);
    w.StartObject();
    w.Key("bytes"); w.Uint64(usage.disk_bytes);
    w.Key("parts"); w.Uint64(usage.disk_parts);
    w.Key("databases"); w.Uint64(usage.disk_databases);
    w.EndObject();
  }
  w.EndObject();
  w.EndObject();

  w.Key("logs");
  w.StartObject();
  for (const auto& [name, present] : data.logs) {
    write_json_key(w, name);
    w.Bool(present);
  }
  w.EndObject();

  w.Key("unavailable_panels");
  w.StartArray();
  for (const auto& issue : data.unavailable_panels) {
    w.StartObject();
    write_string(w, "panel", issue.panel);
    write_string(w, "table", issue.table);
    write_string(w, "reason", issue.reason);
    write_string(w, "message", issue.message);
    write_string(w, "hint", issue.hint);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string queries_json(const std::string& host_id, uint64_t from_ms, uint64_t to_ms, const SystemMonitorQueries& data, bool stale,
                          const SystemSettings& settings) {
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.request.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.request.to_s * 1000);
  write_string(w, "sort", data.request.sort);
  write_string(w, "kind", data.request.kind);
  write_string(w, "errors", data.request.errors);
  write_string(w, "user", data.request.user);
  write_string(w, "database", data.request.database);
  write_string(w, "table", data.request.table);
  w.Key("hide_chdash"); w.Bool(data.request.hide_chdash);
  w.Key("limits");
  w.StartObject();
  w.Key("query_log_max_lookback_hours"); w.Int(settings.query_log_max_lookback_hours);
  w.Key("query_log_max_rows"); w.Uint64(settings.query_log_max_rows);
  w.Key("row_limit"); w.Uint64(kMonitorTopQueries);
  w.Key("user_limit"); w.Uint64(kMonitorQueryUsers);
  w.Key("object_limit"); w.Uint64(kMonitorQueryObjects);
  w.EndObject();
  // The user filter's choices: the window's users (same filters), with their
  // query counts, the most active first.
  // The database and table filters' choices: the window's databases and
  // tables ("database.table") the runner can see, with their run counts.
  for (const auto& [list_key, list] : {std::pair<const char*, const std::vector<std::pair<std::string, uint64_t>>*>{"users", &data.users},
                                       {"databases", &data.databases}, {"tables", &data.tables}}) {
    w.Key(list_key);
    w.StartArray();
    for (const auto& [name, calls] : *list) {
      w.StartObject();
      write_string(w, "name", name);
      w.Key("calls"); w.Uint64(calls);
      w.EndObject();
    }
    w.EndArray();
  }
  write_queries_status(w, data.status, data.message, data.hint, data.suggested_span_s);
  w.Key("phases");
  w.StartObject();
  write_query_read(w, "aggregate", data.aggregate);
  write_query_read(w, "text", data.text);
  w.EndObject();
  w.Key("totals");
  w.StartObject();
  w.Key("calls"); w.Uint64(data.totals.calls);
  w.Key("errors"); w.Uint64(data.totals.errors);
  w.Key("total_ms"); w.Double(data.totals.total_ms);
  w.Key("read_bytes"); w.Uint64(data.totals.read_bytes);
  w.Key("shapes"); w.Uint64(data.totals.shapes);
  w.Key("shapes_capped"); w.Bool(data.totals.shapes_capped);
  w.EndObject();
  w.Key("queries");
  w.StartArray();
  for (const auto& shape : data.queries) {
    w.StartObject();
    // A UInt64: a string, so no digit is lost in JavaScript.
    write_string(w, "hash", std::to_string(shape.hash));
    write_string(w, "kind", shape.kind);
    w.Key("calls"); w.Uint64(shape.calls);
    w.Key("errors"); w.Uint64(shape.errors);
    w.Key("total_ms"); w.Double(shape.total_ms);
    w.Key("avg_ms"); w.Double(shape.avg_ms);
    w.Key("p95_ms"); w.Double(shape.p95_ms);
    w.Key("max_ms"); w.Double(shape.max_ms);
    w.Key("read_rows"); w.Uint64(shape.read_rows);
    w.Key("read_bytes"); w.Uint64(shape.read_bytes);
    w.Key("written_rows"); w.Uint64(shape.written_rows);
    w.Key("result_rows"); w.Uint64(shape.result_rows);
    w.Key("avg_memory"); w.Double(shape.avg_memory);
    w.Key("max_memory"); w.Uint64(shape.max_memory);
    write_strings(w, "users", shape.users);
    write_strings(w, "tables", shape.tables);
    w.Key("first_seen_ms"); w.Uint64(shape.first_seen_s * 1000);
    w.Key("last_seen_ms"); w.Uint64(shape.last_seen_s * 1000);
    w.Key("has_text"); w.Bool(shape.has_text);
    write_string(w, "normalized", shape.normalized);
    write_string(w, "example", shape.example);
    w.Key("example_truncated"); w.Bool(shape.example_truncated);
    write_string(w, "last_query_id", shape.last_query_id);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string query_json(const std::string& host_id, uint64_t from_ms, uint64_t to_ms, const SystemMonitorQuery& data, bool stale,
                        const SystemSettings& settings) {
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  write_string(w, "scope", "server");
  write_string(w, "hash", std::to_string(data.request.hash));
  w.Key("generated_at_ms"); w.Uint64(data.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("requested");
  w.StartObject();
  w.Key("from_ms"); w.Uint64(from_ms);
  w.Key("to_ms"); w.Uint64(to_ms);
  w.EndObject();
  w.Key("from_ms"); w.Uint64(data.request.from_s * 1000);
  w.Key("to_ms"); w.Uint64(data.request.to_s * 1000);
  w.Key("step_seconds"); w.Uint(data.request.step_s);
  write_string(w, "order", data.request.order);
  w.Key("hide_chdash"); w.Bool(data.request.hide_chdash);
  w.Key("limits");
  w.StartObject();
  w.Key("query_log_max_lookback_hours"); w.Int(settings.query_log_max_lookback_hours);
  w.Key("query_log_max_rows"); w.Uint64(settings.query_log_max_rows);
  w.Key("run_limit"); w.Uint64(kMonitorQueryRuns);
  w.EndObject();
  write_queries_status(w, data.status, data.message, data.hint, data.suggested_span_s);
  w.Key("summary");
  w.StartObject();
  w.Key("calls"); w.Uint64(data.summary.calls);
  w.Key("errors"); w.Uint64(data.summary.errors);
  w.Key("total_ms"); w.Double(data.summary.total_ms);
  w.Key("avg_ms"); w.Double(data.summary.calls ? data.summary.total_ms / static_cast<double>(data.summary.calls) : 0.0);
  w.Key("p95_ms"); w.Double(data.summary.p95_ms);
  w.Key("max_ms"); w.Double(data.summary.max_ms);
  w.Key("read_rows"); w.Uint64(data.summary.read_rows);
  w.Key("read_bytes"); w.Uint64(data.summary.read_bytes);
  w.Key("max_memory"); w.Uint64(data.summary.max_memory);
  w.Key("cpu_seconds"); w.Double(data.summary.cpu_seconds);
  w.EndObject();
  write_string(w, "kind", data.kind);
  write_string(w, "normalized", data.normalized);
  w.Key("example");
  w.StartObject();
  write_string(w, "text", data.example);
  w.Key("truncated"); w.Bool(data.example_truncated);
  write_string(w, "query_id", data.example_query_id);
  w.EndObject();
  w.Key("reads");
  w.StartObject();
  write_query_read(w, "timeline", data.timeline_read);
  write_query_read(w, "runs", data.runs_read);
  write_query_read(w, "example", data.example_read);
  w.EndObject();
  w.Key("timestamps");
  w.StartArray();
  for (const uint64_t t : data.buckets) w.Uint64(t * 1000);
  w.EndArray();
  w.Key("series");
  w.StartObject();
  for (const auto& [name, values] : data.series) {
    write_json_key(w, name);
    w.StartArray();
    for (const double value : values) write_series_value(w, value);
    w.EndArray();
  }
  w.EndObject();
  w.Key("runs");
  w.StartArray();
  for (const auto& run : data.runs) {
    w.StartObject();
    w.Key("event_time_ms"); w.Uint64(run.event_time_ms);
    write_string(w, "query_id", run.query_id);
    write_string(w, "user", run.user);
    write_string(w, "type", run.type);
    w.Key("duration_ms"); w.Uint64(run.duration_ms);
    w.Key("read_rows"); w.Uint64(run.read_rows);
    w.Key("read_bytes"); w.Uint64(run.read_bytes);
    w.Key("result_rows"); w.Uint64(run.result_rows);
    w.Key("written_rows"); w.Uint64(run.written_rows);
    w.Key("memory_usage"); w.Uint64(run.memory_usage);
    w.Key("cpu_us"); w.Uint64(run.cpu_us);
    w.Key("exception_code"); w.Int64(run.exception_code);
    write_string(w, "exception", run.exception);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string activity_json(const std::string& host_id, const SystemActivity& ops, bool stale) {
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(ops.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("row_limit"); w.Uint64(ops.row_limit);
  write_strings(w, "unavailable_sections", ops.unavailable_sections);
  write_strings(w, "truncated_sections", ops.truncated_sections);

  w.Key("merges");
  w.StartArray();
  for (const auto& item : ops.merges) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    w.Key("elapsed_seconds"); w.Double(item.elapsed_seconds);
    w.Key("progress"); w.Double(item.progress);
    w.Key("num_parts"); w.Uint64(item.num_parts);
    write_string(w, "result_part_name", item.result_part_name);
    write_string(w, "partition_id", item.partition_id);
    w.Key("is_mutation"); w.Bool(item.is_mutation);
    write_string(w, "merge_type", item.merge_type);
    w.Key("total_bytes_compressed"); w.Uint64(item.total_bytes_compressed);
    w.Key("bytes_read_uncompressed"); w.Uint64(item.bytes_read_uncompressed);
    w.Key("rows_read"); w.Uint64(item.rows_read);
    w.Key("memory_usage"); w.Uint64(item.memory_usage);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations");
  w.StartArray();
  for (const auto& item : ops.mutations) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "mutation_id", item.mutation_id);
    write_string(w, "command", item.command);
    write_string(w, "create_time", item.create_time);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("is_done"); w.Bool(item.is_done);
    w.Key("is_killed"); w.Bool(item.is_killed);
    write_string(w, "latest_failed_part", item.latest_failed_part);
    write_string(w, "latest_fail_time", item.latest_fail_time);
    write_string(w, "latest_fail_reason", item.latest_fail_reason);
    write_string(w, "latest_fail_error_code_name", item.latest_fail_error_code_name);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue");
  w.StartArray();
  for (const auto& item : ops.replication_queue) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    w.Key("entries"); w.Uint64(item.entries);
    w.Key("executing"); w.Uint64(item.executing);
    w.Key("postponed"); w.Uint64(item.postponed);
    w.Key("max_tries"); w.Uint64(item.max_tries);
    write_string(w, "oldest_create_time", item.oldest_create_time);
    write_strings(w, "types", item.types);
    write_string(w, "postpone_reason", item.postpone_reason);
    write_string(w, "last_exception", item.last_exception);
    write_string(w, "last_exception_time", item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replicas");
  w.StartArray();
  for (const auto& item : ops.replicas) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "replica_name", item.replica_name);
    w.Key("is_leader"); w.Bool(item.is_leader);
    w.Key("is_readonly"); w.Bool(item.is_readonly);
    w.Key("is_session_expired"); w.Bool(item.is_session_expired);
    w.Key("queue_size"); w.Uint64(item.queue_size);
    w.Key("inserts_in_queue"); w.Uint64(item.inserts_in_queue);
    w.Key("merges_in_queue"); w.Uint64(item.merges_in_queue);
    w.Key("absolute_delay_seconds"); w.Uint64(item.absolute_delay_seconds);
    write_string(w, "queue_oldest_time", item.queue_oldest_time);
    write_string(w, "last_queue_update", item.last_queue_update);
    write_string(w, "last_queue_update_exception", item.last_queue_update_exception);
    w.Key("total_replicas");
    if (item.total_replicas) w.Uint64(*item.total_replicas); else w.Null();
    w.Key("active_replicas");
    if (item.active_replicas) w.Uint64(*item.active_replicas); else w.Null();
    w.EndObject();
  }
  w.EndArray();

  w.Key("distribution_queue");
  w.StartArray();
  for (const auto& item : ops.distribution_queue) {
    w.StartObject();
    write_string(w, "database", item.database);
    write_string(w, "table", item.table);
    write_string(w, "data_path", item.data_path);
    w.Key("is_blocked"); w.Bool(item.is_blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    write_string(w, "last_exception", item.last_exception);
    write_string(w, "last_exception_time", item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

std::string keeper_json(const std::string& host_id, const SystemKeeperStatus& keeper, bool stale) {
  const auto event = [&](const char* name) -> uint64_t {
    const auto it = keeper.events.find(name);
    return it == keeper.events.end() ? 0 : it->second;
  };
  rapidjson::StringBuffer sb(nullptr, 4 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  write_string(w, "host_id", host_id);
  w.Key("generated_at_ms"); w.Uint64(keeper.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("configured"); w.Bool(keeper.configured);
  write_strings(w, "unavailable_sections", keeper.unavailable_sections);
  w.Key("connections");
  w.StartArray();
  for (const auto& item : keeper.connections) {
    w.StartObject();
    write_string(w, "name", item.name);
    write_string(w, "host", item.host);
    w.Key("port"); w.Uint64(item.port);
    w.Key("index"); w.Uint64(item.index);
    write_string(w, "connected_time", item.connected_time);
    w.Key("session_uptime_seconds"); w.Uint64(item.session_uptime_seconds);
    w.Key("is_expired"); w.Bool(item.is_expired);
    w.Key("keeper_api_version"); w.Uint64(item.keeper_api_version);
    w.Key("session_timeout_ms");
    if (item.session_timeout_ms) w.Uint64(*item.session_timeout_ms); else w.Null();
    w.EndObject();
  }
  w.EndArray();
  w.Key("metrics");
  w.StartObject();
  for (const auto& [name, value] : keeper.metrics) {
    write_json_key(w, name);
    w.Int64(value);
  }
  w.EndObject();
  w.Key("events");
  w.StartObject();
  for (const auto& [name, value] : keeper.events) {
    write_json_key(w, name);
    w.Uint64(value);
  }
  w.EndObject();
  // Average wait per Keeper transaction since server start. The browser
  // derives the recent latency from two snapshots while auto-refreshing.
  const uint64_t transactions = event("ZooKeeperTransactions");
  w.Key("average_wait_ms");
  if (transactions > 0) w.Double(static_cast<double>(event("ZooKeeperWaitMicroseconds")) / 1000.0 / static_cast<double>(transactions));
  else w.Null();
  w.EndObject();

  return std::string(sb.GetString(), sb.GetSize());
}

}  // namespace system_page
}  // namespace chdash
