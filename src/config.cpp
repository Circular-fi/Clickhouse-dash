#include "config.hpp"

#include "ch_uri.hpp"
#include "hcl.hpp"
#include "mcp_identity.hpp"
#include "mcp_keys.hpp"
#include "mcp_scope.hpp"

#include <algorithm>
#include <cctype>
#include <set>
#include <fstream>
#include <initializer_list>
#include <filesystem>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_set>

namespace chdash {
namespace {

QueryDescribeMode parse_describe_mode(std::string text, QueryDescribeMode fallback, bool strict) {
  for (auto& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (text == "always" || text == "on" || text == "1" || text == "true") return QueryDescribeMode::Always;
  if (text == "never" || text == "off" || text == "0" || text == "false") return QueryDescribeMode::Never;
  if (text == "auto") return QueryDescribeMode::Auto;
  if (strict) throw std::runtime_error("query.describe_mode must be auto, always, or never");
  return fallback;
}

AppConfig default_config() {
  AppConfig cfg;
  // Keep the established interactive preview default explicit in the HCL path.
  cfg.result_preview_row_limit = 10000;
  return cfg;
}

void set_version_info(AppConfig& cfg) {
#if !defined(CHDASH_SEMVER) && !defined(CHDASH_GIT_SHA) && !defined(CHDASH_BUILD_TIME)
  (void)cfg;
#endif
#ifdef CHDASH_SEMVER
  cfg.version_semver = CHDASH_SEMVER;
#endif
#ifdef CHDASH_GIT_SHA
  cfg.version_git_sha = CHDASH_GIT_SHA;
#endif
#ifdef CHDASH_BUILD_TIME
  cfg.version_build_time = CHDASH_BUILD_TIME;
#endif
}

void normalize_config(AppConfig& cfg) {
  cfg.result_preview_row_limit = std::max(0, std::min(10'000'000, cfg.result_preview_row_limit));
  cfg.query_max_sql_bytes = std::max<size_t>(1024, std::min<size_t>(64 * 1024 * 1024, cfg.query_max_sql_bytes));

  cfg.query_options.result_rows_batch_bytes = std::max<size_t>(0, cfg.query_options.result_rows_batch_bytes);
  cfg.query_options.sse_write_batch_events = std::max<size_t>(1, cfg.query_options.sse_write_batch_events);
  cfg.query_options.sse_write_batch_bytes = std::max<size_t>(0, cfg.query_options.sse_write_batch_bytes);
  cfg.query_options.sse_queue_max_bytes = std::max<size_t>(0, cfg.query_options.sse_queue_max_bytes);
  cfg.query_options.max_result_cell_bytes = std::max<size_t>(1024, std::min<size_t>(128 * 1024 * 1024, cfg.query_options.max_result_cell_bytes));
  cfg.query_options.max_result_event_bytes = std::max<size_t>(1024, std::min<size_t>(128 * 1024 * 1024, cfg.query_options.max_result_event_bytes));
  cfg.query_options.describe_cache_ttl_ms = std::max(0, cfg.query_options.describe_cache_ttl_ms);

  cfg.client_pool_max_idle_per_key = std::min<size_t>(64, cfg.client_pool_max_idle_per_key);
  cfg.client_pool_idle_ttl_ms = std::max(0, std::min(24 * 60 * 60 * 1000, cfg.client_pool_idle_ttl_ms));
  cfg.client_pool_validate_after_idle_ms = std::max(0, std::min(24 * 60 * 60 * 1000, cfg.client_pool_validate_after_idle_ms));
  cfg.client_pool_reaper_interval_ms = std::max(250, std::min(60 * 1000, cfg.client_pool_reaper_interval_ms));

  cfg.format_cache_max_entries = std::min<size_t>(100'000, cfg.format_cache_max_entries);
  cfg.format_cache_max_bytes = std::min<size_t>(1024 * 1024 * 1024, cfg.format_cache_max_bytes);
  cfg.format_cache_ttl_ms = std::max(0, std::min(24 * 60 * 60 * 1000, cfg.format_cache_ttl_ms));

  cfg.query_session_max_count = std::max<size_t>(1, std::min<size_t>(100'000, cfg.query_session_max_count));
  cfg.query_session_abandoned_ttl_ms = std::max(1000, cfg.query_session_abandoned_ttl_ms);
  cfg.query_session_terminal_ttl_ms = std::max(0, cfg.query_session_terminal_ttl_ms);
  cfg.query_session_reaper_interval_ms = std::max(250, cfg.query_session_reaper_interval_ms);
  cfg.cancel_token_ttl_ms = std::max(1000, std::min(48 * 60 * 60 * 1000, cfg.cancel_token_ttl_ms));

  cfg.explorer.cache_ttl_ms = std::max(0, std::min(60 * 60 * 1000, cfg.explorer.cache_ttl_ms));
  cfg.explorer.live_refresh_ms = std::max(250, std::min(60 * 1000, cfg.explorer.live_refresh_ms));
  cfg.explorer.function_cache_ttl_ms = std::max(1000, std::min(24 * 60 * 60 * 1000, cfg.explorer.function_cache_ttl_ms));
  // System windows: 1 min .. 30 d by default, the history up to a year,
  // query_log up to 30 d and 1,000 .. 10 G rows read per request (a tiny
  // cap only makes every Queries read stop early: the tests use one).
  cfg.system.max_lookback_days = std::max(1, std::min(365, cfg.system.max_lookback_days));
  cfg.system.default_lookback_minutes = std::max(1, std::min(cfg.system.max_lookback_days * 24 * 60, cfg.system.default_lookback_minutes));
  cfg.system.query_log_max_lookback_hours = std::max(1, std::min(30 * 24, cfg.system.query_log_max_lookback_hours));
  cfg.system.query_log_max_rows = std::max<uint64_t>(1'000, std::min<uint64_t>(10'000'000'000ULL, cfg.system.query_log_max_rows));
  cfg.system.disk_growth_days = std::max(1, std::min(cfg.system.max_lookback_days, cfg.system.disk_growth_days));
  cfg.analysis.registry_ttl_ms = std::max(1000, std::min(24 * 60 * 60 * 1000, cfg.analysis.registry_ttl_ms));
  cfg.analysis.registry_max_entries = std::max<size_t>(1, std::min<size_t>(1'000'000, cfg.analysis.registry_max_entries));
  cfg.analysis.registry_sql_max_bytes = std::min<size_t>(512 * 1024 * 1024, cfg.analysis.registry_sql_max_bytes);
  cfg.analysis.log_lookup_timeout_ms = std::max(0, std::min(60 * 1000, cfg.analysis.log_lookup_timeout_ms));
  TraceSettings& traces = cfg.otel_defaults.traces;
  LogSettings& logs = cfg.otel_defaults.logs;
  MetricSettings& metrics = cfg.otel_defaults.metrics;
  traces.default_lookback_minutes = std::max(1, std::min(30 * 24 * 60, traces.default_lookback_minutes));
  traces.max_lookback_minutes = std::max(traces.default_lookback_minutes, std::min(365 * 24 * 60, traces.max_lookback_minutes));
  traces.search_limit = std::max<size_t>(1, std::min<size_t>(1000, traces.search_limit));
  traces.max_spans_per_trace = std::max<size_t>(100, std::min<size_t>(100000, traces.max_spans_per_trace));
  for (const auto& pattern : traces.service_allowlist) {
    if (pattern.empty()) throw std::runtime_error("traces.service_allowlist cannot contain an empty pattern");
    if (pattern.size() > 256) throw std::runtime_error("traces.service_allowlist patterns must be at most 256 bytes");
  }
  if (traces.highlighted_attributes.size() > 32) throw std::runtime_error("traces.highlighted_attributes accepts at most 32 keys");
  for (size_t i = 0; i < traces.highlighted_attributes.size(); ++i) {
    const auto& key = traces.highlighted_attributes[i];
    if (key.empty() || key.size() > 256) throw std::runtime_error("traces.highlighted_attributes keys must be 1 to 256 bytes");
    for (size_t j = 0; j < i; ++j) {
      if (traces.highlighted_attributes[j] == key) throw std::runtime_error("traces.highlighted_attributes lists " + key + " twice");
    }
  }
  if (traces.linked_from_margin_minutes < 1 || traces.linked_from_margin_minutes > 24 * 60) {
    throw std::runtime_error("traces.linked_from_margin_minutes must be between 1 and 1440");
  }
  if (traces.enabled) {
    if (traces.database.empty() || traces.table.empty()) throw std::runtime_error("traces.database and traces.table cannot be empty");
  }
  logs.max_lookback_minutes = std::max(1, std::min(365 * 24 * 60, logs.max_lookback_minutes));
  logs.search_limit = std::max<size_t>(1, std::min<size_t>(10000, logs.search_limit));
  logs.trace_logs_limit = std::max<size_t>(1, std::min<size_t>(10000, logs.trace_logs_limit));
  logs.trace_margin_before_seconds = std::max(0, std::min(3600, logs.trace_margin_before_seconds));
  logs.trace_margin_after_seconds = std::max(0, std::min(3600, logs.trace_margin_after_seconds));
  if (logs.body_search != "token" && logs.body_search != "substring" && logs.body_search != "off") {
    throw std::runtime_error("logs.body_search must be token, substring, or off");
  }
  if (logs.enabled && (logs.database.empty() || logs.table.empty())) {
    throw std::runtime_error("logs.database and logs.table cannot be empty");
  }
  if (metrics.enabled && (metrics.database.empty() || metrics.table_prefix.empty())) {
    throw std::runtime_error("metrics.database and metrics.table_prefix cannot be empty");
  }
  cfg.export_settings.max_concurrent = std::max<size_t>(1, std::min<size_t>(64, cfg.export_settings.max_concurrent));
  cfg.export_settings.output_buffer_bytes = std::max<size_t>(16 * 1024, std::min<size_t>(16 * 1024 * 1024, cfg.export_settings.output_buffer_bytes));
  cfg.export_settings.token_ttl_ms = std::max(5000, std::min(10 * 60 * 1000, cfg.export_settings.token_ttl_ms));
  cfg.export_settings.pending_max_entries = std::max<size_t>(1, std::min<size_t>(4096, cfg.export_settings.pending_max_entries));
  cfg.export_settings.pending_sql_max_bytes = std::max<size_t>(1024 * 1024, std::min<size_t>(512 * 1024 * 1024, cfg.export_settings.pending_sql_max_bytes));
  cfg.export_settings.max_queries = std::max<size_t>(1, std::min<size_t>(4096, cfg.export_settings.max_queries));
  if (cfg.export_settings.archive_format != "zip") {
    throw std::runtime_error("export.archive_format must be zip");
  }
  if (cfg.export_settings.compression) {
    throw std::runtime_error("export.compression=true is not supported in ZIP64 V1; use false");
  }

  if (cfg.query_library.enabled && cfg.query_library.file.empty()) {
    throw std::runtime_error("query_library.file is required when query_library.enabled = true");
  }
  cfg.query_library.max_file_bytes = std::max<size_t>(64 * 1024, std::min<size_t>(1024 * 1024 * 1024, cfg.query_library.max_file_bytes));
  cfg.query_library.max_query_bytes = std::max<size_t>(1024, std::min<size_t>(
      std::min<size_t>(64 * 1024 * 1024, cfg.query_library.max_file_bytes), cfg.query_library.max_query_bytes));

  cfg.health.interval_ms = std::min(600 * 1000, cfg.health.interval_ms);
  // The settings that apply to each host: the block of the configuration with the override of the host. The identity entries
  // of MCP are copies of a host: they hold the same settings.
  const auto resolve = [&](HostSpec& host) {
    host.otel = apply_otel_override(cfg.otel_defaults, host.otel_override);
    const std::string where = "clickhouse.host " + host.id + ": observability.";
    if (host.otel.traces.enabled && (host.otel.traces.database.empty() || host.otel.traces.table.empty())) {
      throw std::runtime_error(where + "traces database and table cannot be empty");
    }
    if (host.otel.logs.enabled && (host.otel.logs.database.empty() || host.otel.logs.table.empty())) {
      throw std::runtime_error(where + "logs database and table cannot be empty");
    }
    if (host.otel.metrics.enabled && (host.otel.metrics.database.empty() || host.otel.metrics.table_prefix.empty())) {
      throw std::runtime_error(where + "metrics database and table_prefix cannot be empty");
    }
  };
  for (auto& host : cfg.hosts) resolve(host);
  for (auto& host : cfg.mcp_hosts) resolve(host);
}

std::string read_text_file(const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error("cannot open config file: " + path);
  std::ostringstream content;
  content << input.rdbuf();
  if (input.bad()) throw std::runtime_error("cannot read config file: " + path);
  return content.str();
}

void validate_object(
    const HclObject& object,
    std::string_view context,
    std::initializer_list<const char*> allowed_attrs,
    std::initializer_list<const char*> allowed_blocks) {
  std::unordered_set<std::string> attrs;
  for (const char* name : allowed_attrs) attrs.emplace(name);
  for (const auto& item : object.attrs) {
    if (attrs.count(item.first) == 0) {
      throw std::runtime_error(std::string(context) + ": unknown attribute " + item.first);
    }
  }

  std::unordered_set<std::string> blocks;
  for (const char* name : allowed_blocks) blocks.emplace(name);
  for (const auto& item : object.blocks) {
    if (blocks.count(item.first) == 0) {
      throw std::runtime_error(std::string(context) + ": unknown block " + item.first);
    }
  }
}

const HclObject* optional_block(const HclObject& parent, const std::string& name, std::string_view context) {
  const auto it = parent.blocks.find(name);
  if (it == parent.blocks.end()) return nullptr;
  if (it->second.size() != 1) {
    throw std::runtime_error(std::string(context) + ": block " + name + " must appear exactly once");
  }
  return &it->second.front();
}

std::optional<std::string> string_attr(const HclObject& object, const std::string& name, std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_string()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be a string");
  }
  return it->second.as_string();
}

std::optional<std::vector<std::string>> string_list_attr(
    const HclObject& object,
    const std::string& name,
    std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_string_list()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be a list of strings");
  }
  return it->second.as_string_list();
}

std::optional<int64_t> int_attr(const HclObject& object, const std::string& name, std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_int()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be an integer");
  }
  return it->second.as_int();
}

std::optional<bool> bool_attr(const HclObject& object, const std::string& name, std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_bool()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be a boolean");
  }
  return it->second.as_bool();
}

int int_value(int64_t value, std::string_view field) {
  if (value < std::numeric_limits<int>::min() || value > std::numeric_limits<int>::max()) {
    throw std::runtime_error(std::string(field) + " is outside the supported integer range");
  }
  return static_cast<int>(value);
}

size_t size_value(int64_t value, std::string_view field) {
  if (value < 0) throw std::runtime_error(std::string(field) + " cannot be negative");
  return static_cast<size_t>(value);
}

std::string url_encode_query_value(std::string_view value) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(value.size());
  for (const unsigned char ch : value) {
    const bool unreserved = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == '~' || ch == '/';
    if (unreserved) {
      out.push_back(static_cast<char>(ch));
    } else {
      out.push_back('%');
      out.push_back(kHex[ch >> 4]);
      out.push_back(kHex[ch & 0x0f]);
    }
  }
  return out;
}

std::string attach_password_file(const std::string& uri, const std::string& path, std::string_view field) {
  if (path.empty()) throw std::runtime_error(std::string(field) + " cannot be empty");
  std::string error;
  const auto parsed = parse_clickhouse_uri(uri, &error);
  if (!parsed) throw std::runtime_error(std::string(field) + ": invalid ClickHouse URI: " + error);
  if (!parsed->password.empty()) {
    throw std::runtime_error(std::string(field) + ": URI password and password_file are mutually exclusive");
  }
  if (parsed->query.count("password_file") != 0) {
    throw std::runtime_error(std::string(field) + ": password_file is already present in the URI");
  }
  return uri + (uri.find('?') == std::string::npos ? "?" : "&") +
      "password_file=" + url_encode_query_value(path);
}

// ---- observability: the settings of Traces, Logs and Metrics -------------------------------------------------------------------

// One signal, in `observability { traces { } }` (context "observability.traces") or in the top-level block of the same name
// that older configurations use (context "traces"). The settings that every host shares; where the tables are can be
// overridden for a host (load_host_override).
void load_traces_block(const HclObject& traces, TraceSettings& out, const std::string& context, bool legacy_allowlist) {
  if (legacy_allowlist) {
    validate_object(traces, context, {"enabled", "analytics", "database", "table", "trace_index_table", "service_allowlist",
                                      "default_lookback_minutes", "max_lookback_minutes", "search_limit", "max_spans_per_trace",
                                      "highlighted_attributes", "linked_from_margin_minutes"}, {"features"});
  } else {
    validate_object(traces, context, {"enabled", "analytics", "database", "table", "trace_index_table",
                                      "default_lookback_minutes", "max_lookback_minutes", "search_limit", "max_spans_per_trace",
                                      "highlighted_attributes", "linked_from_margin_minutes"}, {"features"});
  }
  if (auto v = bool_attr(traces, "enabled", context)) out.enabled = *v;
  if (auto v = bool_attr(traces, "analytics", context)) out.analytics = *v;
  if (auto v = string_attr(traces, "database", context)) out.database = *v;
  if (auto v = string_attr(traces, "table", context)) out.table = *v;
  if (auto v = string_attr(traces, "trace_index_table", context)) out.trace_index_table = *v;
  if (legacy_allowlist) {
    if (auto v = string_list_attr(traces, "service_allowlist", context)) out.service_allowlist = std::move(*v);
  }
  if (auto v = int_attr(traces, "default_lookback_minutes", context)) out.default_lookback_minutes = int_value(*v, context + ".default_lookback_minutes");
  if (auto v = int_attr(traces, "max_lookback_minutes", context)) out.max_lookback_minutes = int_value(*v, context + ".max_lookback_minutes");
  if (auto v = int_attr(traces, "search_limit", context)) out.search_limit = size_value(*v, context + ".search_limit");
  if (auto v = int_attr(traces, "max_spans_per_trace", context)) out.max_spans_per_trace = size_value(*v, context + ".max_spans_per_trace");
  if (auto v = string_list_attr(traces, "highlighted_attributes", context)) out.highlighted_attributes = std::move(*v);
  if (auto v = int_attr(traces, "linked_from_margin_minutes", context)) out.linked_from_margin_minutes = int_value(*v, context + ".linked_from_margin_minutes");
  if (const auto* features = optional_block(traces, "features", context)) {
    const std::string fctx = context + ".features";
    validate_object(*features, fctx, {
        "service_filter", "operation_filter", "status_filter", "duration_filter",
        "resource_attributes", "span_attributes", "events", "links"}, {});
    if (auto v = bool_attr(*features, "service_filter", fctx)) out.features.service_filter = *v;
    if (auto v = bool_attr(*features, "operation_filter", fctx)) out.features.operation_filter = *v;
    if (auto v = bool_attr(*features, "status_filter", fctx)) out.features.status_filter = *v;
    if (auto v = bool_attr(*features, "duration_filter", fctx)) out.features.duration_filter = *v;
    if (auto v = bool_attr(*features, "resource_attributes", fctx)) out.features.resource_attributes = *v;
    if (auto v = bool_attr(*features, "span_attributes", fctx)) out.features.span_attributes = *v;
    if (auto v = bool_attr(*features, "events", fctx)) out.features.events = *v;
    if (auto v = bool_attr(*features, "links", fctx)) out.features.links = *v;
  }
}

void load_logs_block(const HclObject& logs, LogSettings& out, const std::string& context) {
  validate_object(logs, context, {
      "enabled", "database", "table", "max_lookback_minutes", "search_limit", "body_search",
      "trace_logs_limit", "trace_margin_before_seconds", "trace_margin_after_seconds"}, {});
  if (auto v = bool_attr(logs, "enabled", context)) out.enabled = *v;
  if (auto v = string_attr(logs, "database", context)) out.database = *v;
  if (auto v = string_attr(logs, "table", context)) out.table = *v;
  if (auto v = int_attr(logs, "max_lookback_minutes", context)) out.max_lookback_minutes = int_value(*v, context + ".max_lookback_minutes");
  if (auto v = int_attr(logs, "search_limit", context)) out.search_limit = size_value(*v, context + ".search_limit");
  if (auto v = string_attr(logs, "body_search", context)) out.body_search = *v;
  if (auto v = int_attr(logs, "trace_logs_limit", context)) out.trace_logs_limit = size_value(*v, context + ".trace_logs_limit");
  if (auto v = int_attr(logs, "trace_margin_before_seconds", context)) out.trace_margin_before_seconds = int_value(*v, context + ".trace_margin_before_seconds");
  if (auto v = int_attr(logs, "trace_margin_after_seconds", context)) out.trace_margin_after_seconds = int_value(*v, context + ".trace_margin_after_seconds");
}

void load_metrics_block(const HclObject& metrics, MetricSettings& out, const std::string& context) {
  validate_object(metrics, context, {"enabled", "database", "table_prefix"}, {});
  if (auto v = bool_attr(metrics, "enabled", context)) out.enabled = *v;
  if (auto v = string_attr(metrics, "database", context)) out.database = *v;
  if (auto v = string_attr(metrics, "table_prefix", context)) out.table_prefix = *v;
}

// `observability { service_allowlist = [...]  traces { } logs { } metrics { } }`: the Traces, Logs and Metrics pages. The
// top-level `traces`, `logs` and `metrics` blocks of older configurations still work (and `traces.service_allowlist`,
// which is the allowlist of the three signals); a signal is never set in both places.
void load_observability(AppConfig& cfg, const HclObject& root, std::string_view source) {
  OtelSettings& out = cfg.otel_defaults;
  const auto* observability = optional_block(root, "observability", source);
  const auto* legacy_traces = optional_block(root, "traces", source);
  const auto* legacy_logs = optional_block(root, "logs", source);
  const auto* legacy_metrics = optional_block(root, "metrics", source);
  const HclObject* traces = nullptr;
  const HclObject* logs = nullptr;
  const HclObject* metrics = nullptr;
  if (observability) {
    validate_object(*observability, "observability", {"service_allowlist"}, {"traces", "logs", "metrics"});
    traces = optional_block(*observability, "traces", "observability");
    logs = optional_block(*observability, "logs", "observability");
    metrics = optional_block(*observability, "metrics", "observability");
    if (auto v = string_list_attr(*observability, "service_allowlist", "observability")) out.traces.service_allowlist = std::move(*v);
  }
  const auto twice = [](const char* name) {
    return std::runtime_error(std::string("the ") + name + " settings are in observability." + name + " and in the top-level " + name +
                              " block: keep observability." + name);
  };
  if (traces && legacy_traces) throw twice("traces");
  if (logs && legacy_logs) throw twice("logs");
  if (metrics && legacy_metrics) throw twice("metrics");
  if (observability && legacy_traces) {
    if (string_list_attr(*legacy_traces, "service_allowlist", "traces") && string_list_attr(*observability, "service_allowlist", "observability")) {
      throw std::runtime_error("the service allowlist is in observability.service_allowlist and in traces.service_allowlist: keep observability.service_allowlist");
    }
  }
  if (traces) load_traces_block(*traces, out.traces, "observability.traces", false);
  else if (legacy_traces) load_traces_block(*legacy_traces, out.traces, "traces", true);
  if (logs) load_logs_block(*logs, out.logs, "observability.logs");
  else if (legacy_logs) load_logs_block(*legacy_logs, out.logs, "logs");
  if (metrics) load_metrics_block(*metrics, out.metrics, "observability.metrics");
  else if (legacy_metrics) load_metrics_block(*legacy_metrics, out.metrics, "metrics");
}

// `clickhouse.host { observability { traces { table = "..." } } }`: where the tables of this host are, and whether a signal
// is on for it. The rest (the limits, the allowlist, the features) is the block of the configuration, the same for every host.
OtelHostOverride load_host_override(const HclObject& host) {
  OtelHostOverride out;
  const auto* observability = optional_block(host, "observability", "clickhouse.host");
  if (!observability) return out;
  validate_object(*observability, "clickhouse.host.observability", {}, {"traces", "logs", "metrics"});
  if (const auto* traces = optional_block(*observability, "traces", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.traces";
    validate_object(*traces, c, {"enabled", "database", "table", "trace_index_table"}, {});
    out.traces_enabled = bool_attr(*traces, "enabled", c);
    out.traces_database = string_attr(*traces, "database", c);
    out.traces_table = string_attr(*traces, "table", c);
    out.traces_index_table = string_attr(*traces, "trace_index_table", c);
  }
  if (const auto* logs = optional_block(*observability, "logs", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.logs";
    validate_object(*logs, c, {"enabled", "database", "table"}, {});
    out.logs_enabled = bool_attr(*logs, "enabled", c);
    out.logs_database = string_attr(*logs, "database", c);
    out.logs_table = string_attr(*logs, "table", c);
  }
  if (const auto* metrics = optional_block(*observability, "metrics", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.metrics";
    validate_object(*metrics, c, {"enabled", "database", "table_prefix"}, {});
    out.metrics_enabled = bool_attr(*metrics, "enabled", c);
    out.metrics_database = string_attr(*metrics, "database", c);
    out.metrics_table_prefix = string_attr(*metrics, "table_prefix", c);
  }
  return out;
}

void load_hosts(AppConfig& cfg, const HclObject& root, std::string_view source) {
  const HclObject* clickhouse = optional_block(root, "clickhouse", source);
  if (!clickhouse) throw std::runtime_error(std::string(source) + ": missing clickhouse block");
  validate_object(*clickhouse, "clickhouse", {}, {"host"});

  const auto hosts_it = clickhouse->blocks.find("host");
  if (hosts_it == clickhouse->blocks.end() || hosts_it->second.empty()) {
    throw std::runtime_error(std::string(source) + ": missing clickhouse.host block");
  }

  std::unordered_set<std::string> ids;
  cfg.hosts.clear();
  for (const auto& host : hosts_it->second) {
    validate_object(host, "clickhouse.host",
        {"name", "label", "runner_uri", "system_uri", "password_file", "runner_password_file", "system_password_file",
         "mcp_uri"}, {"observability"});
    const auto name = string_attr(host, "name", "clickhouse.host");
    const auto label = string_attr(host, "label", "clickhouse.host");
    auto runner_uri = string_attr(host, "runner_uri", "clickhouse.host");
    auto system_uri = string_attr(host, "system_uri", "clickhouse.host");
    const auto password_file = string_attr(host, "password_file", "clickhouse.host");
    auto runner_password_file = string_attr(host, "runner_password_file", "clickhouse.host");
    auto system_password_file = string_attr(host, "system_password_file", "clickhouse.host");
    // The MCP identity is separate: its password lives in mcp_uri; password_file and the runner/system credentials never apply.
    auto mcp_uri = string_attr(host, "mcp_uri", "clickhouse.host");

    if (!name || name->empty()) throw std::runtime_error("clickhouse.host.name is required");
    // The id of a host never holds a control character: the identities of MCP are made with one (mcp_identity.hpp).
    if (std::any_of(name->begin(), name->end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; })) {
      throw std::runtime_error("clickhouse.host.name must not contain a control character");
    }
    if (!runner_uri || runner_uri->empty()) throw std::runtime_error("clickhouse.host.runner_uri is required");
    if (!system_uri || system_uri->empty()) throw std::runtime_error("clickhouse.host.system_uri is required");
    if (!ids.insert(*name).second) throw std::runtime_error("duplicate clickhouse.host.name: " + *name);

    if (!runner_password_file) runner_password_file = password_file;
    if (!system_password_file) system_password_file = password_file;
    if (runner_password_file) {
      *runner_uri = attach_password_file(*runner_uri, *runner_password_file, "clickhouse.host.runner_password_file");
    }
    if (system_password_file) {
      *system_uri = attach_password_file(*system_uri, *system_password_file, "clickhouse.host.system_password_file");
    }

    if (mcp_uri && !mcp_uri->empty()) {
      std::string uri_error;
      if (!parse_clickhouse_uri(*mcp_uri, &uri_error)) {
        throw std::runtime_error("clickhouse.host.mcp_uri: invalid ClickHouse URI: " + uri_error);
      }
    }

    HostSpec spec;
    spec.id = *name;
    spec.label = label && !label->empty() ? *label : *name;
    spec.runner_uri = std::move(*runner_uri);
    spec.system_uri = std::move(*system_uri);
    if (mcp_uri) spec.mcp_uri = std::move(*mcp_uri);
    spec.otel_override = load_host_override(host);
    cfg.hosts.push_back(std::move(spec));
  }
}

std::string read_secret_file(const std::string& path, const std::string& context) {
  std::ifstream input(path, std::ios::binary);
  if (!input) throw std::runtime_error(context + ".secret_file: cannot open " + path);
  std::ostringstream content;
  content << input.rdbuf();
  if (input.bad()) throw std::runtime_error(context + ".secret_file: cannot read " + path);
  std::string text = content.str();
  const auto is_space = [](char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; };
  while (!text.empty() && is_space(text.back())) text.pop_back();
  size_t start = 0;
  while (start < text.size() && is_space(text[start])) ++start;
  return text.substr(start);
}

int64_t mcp_int_value(const HclObject& object, const char* name, int64_t fallback, int64_t lo, int64_t hi) {
  const auto value = int_attr(object, name, "mcp");
  if (!value) return fallback;
  if (*value < lo || *value > hi) {
    throw std::runtime_error(std::string("mcp.") + name + " must be between " + std::to_string(lo) + " and " + std::to_string(hi));
  }
  return *value;
}

McpKey parse_mcp_key(const HclObject& block) {
  validate_object(block, "mcp.key", {
      "name", "secret", "secret_file", "secret_sha256", "hosts", "tools", "databases",
      "max_rows", "timeout_seconds"}, {});
  McpKey key;
  key.source = "config";
  const auto name = string_attr(block, "name", "mcp.key");
  if (!name || name->empty()) throw std::runtime_error("mcp.key.name is required");
  key.name = *name;
  key.id = *name;
  const std::string context = "mcp.key " + key.name;
  if (!mcp_valid_key_name(key.name)) {
    throw std::runtime_error(context + ": name must use a-z, 0-9, - and _ (at most 32 bytes), start with a letter or digit, and not start with ui_");
  }

  const auto secret = string_attr(block, "secret", "mcp.key");
  const auto secret_file = string_attr(block, "secret_file", "mcp.key");
  const auto secret_sha256 = string_attr(block, "secret_sha256", "mcp.key");
  const int given = (secret ? 1 : 0) + (secret_file ? 1 : 0) + (secret_sha256 ? 1 : 0);
  if (given != 1) {
    throw std::runtime_error(context + ": exactly one of secret, secret_file and secret_sha256 is required");
  }
  if (secret || secret_file) {
    const std::string value = secret ? *secret : read_secret_file(*secret_file, context);
    if (value.size() < kMcpSecretMinBytes) {
      throw std::runtime_error(context + ": the secret must be at least " + std::to_string(kMcpSecretMinBytes) + " bytes");
    }
    key.secret_hash = mcp_hash_secret(value);
    key.secret = value;
  } else if (!secret_sha256 || !mcp_parse_hash_hex(*secret_sha256, &key.secret_hash)) {
    throw std::runtime_error(context + ": secret_sha256 must be 64 hexadecimal characters");
  }

  if (auto v = string_list_attr(block, "hosts", "mcp.key")) key.hosts = std::move(*v);
  if (auto v = string_list_attr(block, "tools", "mcp.key")) key.tools = std::move(*v);
  if (auto v = string_list_attr(block, "databases", "mcp.key")) key.databases = std::move(*v);
  if (auto v = int_attr(block, "max_rows", "mcp.key")) key.max_rows = v;
  if (auto v = int_attr(block, "timeout_seconds", "mcp.key")) key.timeout_seconds = v;
  return key;
}

// The mcp { } block. Every check of the startup errors in docs/mcp.md ("Startup
// errors") is here, so a bad configuration stops the process with "config error".
void load_mcp(AppConfig& cfg, const HclObject& root, std::string_view source) {
  const HclObject* mcp = optional_block(root, "mcp", source);
  if (!mcp) return;
  validate_object(*mcp, "mcp", {
      "enabled", "storage_file", "manage_from_ui", "auth_header", "max_rows", "max_result_bytes", "query_timeout_seconds",
      "max_sql_bytes", "max_memory_bytes", "max_rows_to_read", "rate_limit_per_minute", "allowed_origins"}, {"key"});
  McpSettings& out = cfg.mcp;
  if (auto v = bool_attr(*mcp, "enabled", "mcp")) out.enabled = *v;
  if (auto v = string_attr(*mcp, "storage_file", "mcp")) out.storage_file = *v;
  if (auto v = bool_attr(*mcp, "manage_from_ui", "mcp")) out.manage_from_ui = *v;
  if (auto v = string_attr(*mcp, "auth_header", "mcp")) {
    // An HTTP field name (letters, digits and hyphens), not one that the request needs for itself.
    static const std::set<std::string> reserved = {"content-type", "content-length", "host", "origin", "accept", "connection", "transfer-encoding",
                                                   "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie"};
    std::string lower = *v;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const bool token = !v->empty() && v->size() <= 64 && std::all_of(v->begin(), v->end(), [](unsigned char c) { return std::isalnum(c) || c == '-'; }) && (*v)[0] != '-';
    if (!token || reserved.count(lower)) {
      throw std::runtime_error("mcp.auth_header: \"" + *v + "\" must be an HTTP header name (letters, digits and hyphens, at most 64) that the request does not need for itself");
    }
    out.auth_header = *v;
  }
  out.max_rows = mcp_int_value(*mcp, "max_rows", out.max_rows, 1, 1'000'000);
  out.max_result_bytes = mcp_int_value(*mcp, "max_result_bytes", out.max_result_bytes, 1024, 256LL * 1024 * 1024);
  out.query_timeout_seconds = mcp_int_value(*mcp, "query_timeout_seconds", out.query_timeout_seconds, 1, 3600);
  out.max_sql_bytes = mcp_int_value(*mcp, "max_sql_bytes", out.max_sql_bytes, 256, 4LL * 1024 * 1024);
  out.max_memory_bytes = mcp_int_value(*mcp, "max_memory_bytes", out.max_memory_bytes, 16LL * 1024 * 1024, 1LL << 40);
  out.max_rows_to_read = mcp_int_value(*mcp, "max_rows_to_read", out.max_rows_to_read, 0, std::numeric_limits<int64_t>::max());
  out.rate_limit_per_minute = mcp_int_value(*mcp, "rate_limit_per_minute", out.rate_limit_per_minute, 0, 1'000'000);
  if (auto v = string_list_attr(*mcp, "allowed_origins", "mcp")) {
    for (const auto& origin : *v) {
      const auto scheme = origin.find("://");
      const bool ok = origin.size() <= 256 && scheme != std::string::npos && (origin.compare(0, scheme, "http") == 0 || origin.compare(0, scheme, "https") == 0) &&
                      origin.size() > scheme + 3 && origin.find_first_of("/ \t*?#", scheme + 3) == std::string::npos;
      if (!ok) throw std::runtime_error("mcp.allowed_origins: \"" + origin + "\" must look like https://host[:port] (no path, no *)");
    }
    out.allowed_origins = std::move(*v);
  }
  if (const auto keys = mcp->blocks.find("key"); keys != mcp->blocks.end()) {
    for (const auto& block : keys->second) out.keys.push_back(parse_mcp_key(block));
  }
  if (!out.enabled) return;

  // 1. Somewhere to read keys from.
  if (out.storage_file.empty() && out.keys.empty()) {
    throw std::runtime_error("mcp.enabled needs mcp.storage_file or at least one mcp key block");
  }
  // 2. A ClickHouse identity for MCP.
  McpKeyContext context;
  for (const auto& host : cfg.hosts) {
    if (!host.mcp_uri.empty()) context.hosts.push_back(host.id);
  }
  if (context.hosts.empty()) {
    throw std::runtime_error("mcp.enabled needs at least one clickhouse.host with mcp_uri");
  }
  // The identity of the API tools (mcp_identity.hpp): the MCP user takes the place of the runner; the system user stays
  // what it is for the pages (figures, and the OpenTelemetry tables).
  cfg.mcp_hosts.clear();
  for (const auto& host : cfg.hosts) {
    if (host.mcp_uri.empty()) continue;
    HostSpec runner = host;
    runner.id = mcp_api_host(host.id, McpIdentity::Runner);
    runner.runner_uri = host.mcp_uri;
    runner.mcp_uri.clear();
    cfg.mcp_hosts.push_back(std::move(runner));
  }
  context.max_rows_cap = out.max_rows;
  context.timeout_cap = out.query_timeout_seconds;
  // 4. Names and secrets are unique (the storage file is checked below, with the same rule).
  for (size_t i = 0; i < out.keys.size(); ++i) {
    for (size_t j = 0; j < i; ++j) {
      if (out.keys[i].name == out.keys[j].name) throw std::runtime_error("mcp.key: two keys have the name " + out.keys[i].name);
      if (out.keys[i].secret_hash == out.keys[j].secret_hash) {
        throw std::runtime_error("mcp.key: keys " + out.keys[j].name + " and " + out.keys[i].name + " have the same secret");
      }
    }
  }
  // 5 and 6. Hosts and tools exist; SQL tools go with databases = ["*"].
  for (const auto& key : out.keys) {
    if (const auto err = mcp_validate_key(key, context)) {
      const std::string field = err->field.empty() ? "" : err->field + ": ";
      throw std::runtime_error("mcp.key " + key.name + ": " + field + err->message);
    }
  }
  // 3. The storage file is valid JSON (it is never rewritten when it is not) and its directory exists.
  if (!out.storage_file.empty()) {
    std::vector<McpKey> stored;
    try {
      stored = mcp_load_key_file(out.storage_file);
    } catch (const std::exception& error) {
      throw std::runtime_error("mcp.storage_file " + out.storage_file + ": " + error.what() +
                               " (the file is not changed)");
    }
    for (const auto& ui : stored) {
      for (const auto& key : out.keys) {
        if (ui.name == key.name) throw std::runtime_error("mcp.storage_file " + out.storage_file + ": the name " + ui.name + " is also a key of the configuration");
        if (ui.secret_hash == key.secret_hash) {
          throw std::runtime_error("mcp.storage_file " + out.storage_file + ": key " + ui.name + " has the same secret as the configuration key " + key.name);
        }
      }
    }
  }
}

void apply_full_hcl(AppConfig& cfg, const HclObject& root, std::string_view source) {
  validate_object(root, source, {}, {
      "server", "query", "client_pool", "format_cache", "health",
      "observability", "traces", "logs", "metrics", "explorer", "system", "analysis", "export", "clickhouse", "query_library", "mcp"});

  if (const auto* server = optional_block(root, "server", source)) {
    validate_object(*server, "server", {"listen_host", "listen_port"}, {});
    std::string host = "0.0.0.0";
    int port = 8080;
    if (const auto pos = cfg.listen.rfind(':'); pos != std::string::npos) {
      host = cfg.listen.substr(0, pos);
      port = std::stoi(cfg.listen.substr(pos + 1));
    }
    if (auto value = string_attr(*server, "listen_host", "server")) host = *value;
    if (auto value = int_attr(*server, "listen_port", "server")) port = int_value(*value, "server.listen_port");
    if (host.empty()) throw std::runtime_error("server.listen_host cannot be empty");
    if (port < 1 || port > 65535) throw std::runtime_error("server.listen_port must be between 1 and 65535");
    cfg.listen = host + ":" + std::to_string(port);
  }

  if (const auto* query = optional_block(root, "query", source)) {
    validate_object(*query, "query", {
        "result_preview_row_limit", "max_sql_bytes", "describe_mode",
        "sample_interval_ms",
        "result_batch_rows", "result_batch_bytes", "sse_batch_events", "sse_batch_bytes",
        "sse_queue_max_bytes", "max_result_cell_bytes", "max_result_event_bytes",
        "describe_cache_entries", "describe_cache_ttl_ms",
        "session_max_count", "session_abandoned_ttl_ms", "session_terminal_ttl_ms",
        "session_reaper_interval_ms", "cancel_token_ttl_ms"}, {});
    if (auto v = int_attr(*query, "result_preview_row_limit", "query")) cfg.result_preview_row_limit = int_value(*v, "query.result_preview_row_limit");
    if (auto v = int_attr(*query, "max_sql_bytes", "query")) cfg.query_max_sql_bytes = size_value(*v, "query.max_sql_bytes");
    if (auto v = string_attr(*query, "describe_mode", "query")) cfg.query_options.describe_mode = parse_describe_mode(*v, QueryDescribeMode::Auto, true);
    if (auto v = int_attr(*query, "sample_interval_ms", "query")) cfg.query_options.sample_interval_ms = int_value(*v, "query.sample_interval_ms");
    if (auto v = int_attr(*query, "result_batch_rows", "query")) cfg.query_options.result_rows_batch_size = int_value(*v, "query.result_batch_rows");
    if (auto v = int_attr(*query, "result_batch_bytes", "query")) cfg.query_options.result_rows_batch_bytes = size_value(*v, "query.result_batch_bytes");
    if (auto v = int_attr(*query, "sse_batch_events", "query")) cfg.query_options.sse_write_batch_events = size_value(*v, "query.sse_batch_events");
    if (auto v = int_attr(*query, "sse_batch_bytes", "query")) cfg.query_options.sse_write_batch_bytes = size_value(*v, "query.sse_batch_bytes");
    if (auto v = int_attr(*query, "sse_queue_max_bytes", "query")) cfg.query_options.sse_queue_max_bytes = size_value(*v, "query.sse_queue_max_bytes");
    if (auto v = int_attr(*query, "max_result_cell_bytes", "query")) cfg.query_options.max_result_cell_bytes = size_value(*v, "query.max_result_cell_bytes");
    if (auto v = int_attr(*query, "max_result_event_bytes", "query")) cfg.query_options.max_result_event_bytes = size_value(*v, "query.max_result_event_bytes");
    if (auto v = int_attr(*query, "describe_cache_entries", "query")) cfg.query_options.describe_cache_entries = size_value(*v, "query.describe_cache_entries");
    if (auto v = int_attr(*query, "describe_cache_ttl_ms", "query")) cfg.query_options.describe_cache_ttl_ms = int_value(*v, "query.describe_cache_ttl_ms");
    if (auto v = int_attr(*query, "session_max_count", "query")) cfg.query_session_max_count = size_value(*v, "query.session_max_count");
    if (auto v = int_attr(*query, "session_abandoned_ttl_ms", "query")) cfg.query_session_abandoned_ttl_ms = int_value(*v, "query.session_abandoned_ttl_ms");
    if (auto v = int_attr(*query, "session_terminal_ttl_ms", "query")) cfg.query_session_terminal_ttl_ms = int_value(*v, "query.session_terminal_ttl_ms");
    if (auto v = int_attr(*query, "session_reaper_interval_ms", "query")) cfg.query_session_reaper_interval_ms = int_value(*v, "query.session_reaper_interval_ms");
    if (auto v = int_attr(*query, "cancel_token_ttl_ms", "query")) cfg.cancel_token_ttl_ms = int_value(*v, "query.cancel_token_ttl_ms");
  }

  if (const auto* pool = optional_block(root, "client_pool", source)) {
    validate_object(*pool, "client_pool", {"max_idle", "idle_ttl_ms", "validate_after_idle_ms", "reaper_interval_ms"}, {});
    if (auto v = int_attr(*pool, "max_idle", "client_pool")) cfg.client_pool_max_idle_per_key = size_value(*v, "client_pool.max_idle");
    if (auto v = int_attr(*pool, "idle_ttl_ms", "client_pool")) cfg.client_pool_idle_ttl_ms = int_value(*v, "client_pool.idle_ttl_ms");
    if (auto v = int_attr(*pool, "validate_after_idle_ms", "client_pool")) cfg.client_pool_validate_after_idle_ms = int_value(*v, "client_pool.validate_after_idle_ms");
    if (auto v = int_attr(*pool, "reaper_interval_ms", "client_pool")) cfg.client_pool_reaper_interval_ms = int_value(*v, "client_pool.reaper_interval_ms");
  }

  if (const auto* cache = optional_block(root, "format_cache", source)) {
    validate_object(*cache, "format_cache", {"max_entries", "max_bytes", "ttl_ms"}, {});
    if (auto v = int_attr(*cache, "max_entries", "format_cache")) cfg.format_cache_max_entries = size_value(*v, "format_cache.max_entries");
    if (auto v = int_attr(*cache, "max_bytes", "format_cache")) cfg.format_cache_max_bytes = size_value(*v, "format_cache.max_bytes");
    if (auto v = int_attr(*cache, "ttl_ms", "format_cache")) cfg.format_cache_ttl_ms = int_value(*v, "format_cache.ttl_ms");
  }


  if (const auto* explorer = optional_block(root, "explorer", source)) {
    validate_object(*explorer, "explorer", {"browse", "cache_ttl_ms", "live_refresh_ms", "function_cache_ttl_ms", "function_markdown_links"}, {"graph", "operations"});
    if (auto v = bool_attr(*explorer, "browse", "explorer")) cfg.explorer.browse = *v;
    if (const auto* graph = optional_block(*explorer, "graph", "explorer")) {
      validate_object(*graph, "explorer.graph", {"lineage", "storage_topology"}, {});
      if (auto v = bool_attr(*graph, "lineage", "explorer.graph")) cfg.explorer.lineage = *v;
      if (auto v = bool_attr(*graph, "storage_topology", "explorer.graph")) cfg.explorer.storage_topology = *v;
    }
    if (auto v = int_attr(*explorer, "cache_ttl_ms", "explorer")) cfg.explorer.cache_ttl_ms = int_value(*v, "explorer.cache_ttl_ms");
    if (auto v = int_attr(*explorer, "live_refresh_ms", "explorer")) cfg.explorer.live_refresh_ms = int_value(*v, "explorer.live_refresh_ms");
    if (auto v = int_attr(*explorer, "function_cache_ttl_ms", "explorer")) cfg.explorer.function_cache_ttl_ms = int_value(*v, "explorer.function_cache_ttl_ms");
    if (auto v = bool_attr(*explorer, "function_markdown_links", "explorer")) cfg.explorer.function_markdown_links = *v;
    // v2.14.0's Server operations switches, now the System page's Activity
    // and Keeper: enabled = false removes both (as it removed both routes
    // then), keeper = false the Keeper only. A system { } block below wins.
    if (const auto* operations = optional_block(*explorer, "operations", "explorer")) {
      validate_object(*operations, "explorer.operations", {"enabled", "keeper"}, {});
      if (auto v = bool_attr(*operations, "enabled", "explorer.operations"); v && !*v) {
        cfg.system.activity = false;
        cfg.system.keeper = false;
      }
      if (auto v = bool_attr(*operations, "keeper", "explorer.operations")) cfg.system.keeper = cfg.system.keeper && *v;
    }
  }

  if (const auto* system = optional_block(root, "system", source)) {
    const char* context = "system";
    validate_object(*system, context,
                    {"enabled", "activity", "keeper", "top_queries", "cluster_fanout", "default_lookback_minutes", "max_lookback_days",
                     "query_log_max_lookback_hours", "query_log_max_rows", "disk_growth_days"}, {});
    if (auto v = bool_attr(*system, "enabled", context)) cfg.system.enabled = *v;
    if (auto v = bool_attr(*system, "activity", context)) cfg.system.activity = *v;
    if (auto v = bool_attr(*system, "keeper", context)) cfg.system.keeper = *v;
    if (auto v = bool_attr(*system, "top_queries", context)) cfg.system.top_queries = *v;
    if (auto v = bool_attr(*system, "cluster_fanout", context)) cfg.system.cluster_fanout = *v;
    if (auto v = int_attr(*system, "default_lookback_minutes", context)) cfg.system.default_lookback_minutes = int_value(*v, "system.default_lookback_minutes");
    if (auto v = int_attr(*system, "max_lookback_days", context)) cfg.system.max_lookback_days = int_value(*v, "system.max_lookback_days");
    if (auto v = int_attr(*system, "query_log_max_lookback_hours", context)) cfg.system.query_log_max_lookback_hours = int_value(*v, "system.query_log_max_lookback_hours");
    if (auto v = int_attr(*system, "query_log_max_rows", context)) cfg.system.query_log_max_rows = size_value(*v, "system.query_log_max_rows");
    if (auto v = int_attr(*system, "disk_growth_days", context)) cfg.system.disk_growth_days = int_value(*v, "system.disk_growth_days");
  }

  load_observability(cfg, root, source);

  if (const auto* library = optional_block(root, "query_library", source)) {
    if (optional_block(*library, "history", "query_library")) {
      throw std::runtime_error("query_library.history was removed: the query history is always kept in the browser; delete the block");
    }
    validate_object(*library, "query_library", {"enabled", "file", "writable", "max_file_bytes", "max_query_bytes"}, {});
    if (auto v = bool_attr(*library, "enabled", "query_library")) cfg.query_library.enabled = *v;
    if (auto v = string_attr(*library, "file", "query_library")) cfg.query_library.file = *v;
    if (auto v = bool_attr(*library, "writable", "query_library")) cfg.query_library.writable = *v;
    if (auto v = int_attr(*library, "max_file_bytes", "query_library")) cfg.query_library.max_file_bytes = size_value(*v, "query_library.max_file_bytes");
    if (auto v = int_attr(*library, "max_query_bytes", "query_library")) cfg.query_library.max_query_bytes = size_value(*v, "query_library.max_query_bytes");
  }

  if (const auto* analysis = optional_block(root, "analysis", source)) {
    validate_object(*analysis, "analysis", {"registry_ttl_ms", "registry_max_entries", "registry_sql_max_bytes", "log_lookup_timeout_ms", "flush_logs", "allow_deep_analyze"}, {});
    if (auto v = int_attr(*analysis, "registry_ttl_ms", "analysis")) cfg.analysis.registry_ttl_ms = int_value(*v, "analysis.registry_ttl_ms");
    if (auto v = int_attr(*analysis, "registry_max_entries", "analysis")) cfg.analysis.registry_max_entries = size_value(*v, "analysis.registry_max_entries");
    if (auto v = int_attr(*analysis, "registry_sql_max_bytes", "analysis")) cfg.analysis.registry_sql_max_bytes = size_value(*v, "analysis.registry_sql_max_bytes");
    if (auto v = int_attr(*analysis, "log_lookup_timeout_ms", "analysis")) cfg.analysis.log_lookup_timeout_ms = int_value(*v, "analysis.log_lookup_timeout_ms");
    if (auto v = bool_attr(*analysis, "flush_logs", "analysis")) cfg.analysis.flush_logs = *v;
    if (auto v = bool_attr(*analysis, "allow_deep_analyze", "analysis")) cfg.analysis.allow_deep_analyze = *v;
  }

  if (const auto* export_block = optional_block(root, "export", source)) {
    validate_object(*export_block, "export", {"max_concurrent", "output_buffer_bytes", "archive_format", "compression", "token_ttl_ms", "pending_max_entries", "pending_sql_max_bytes", "max_queries"}, {});
    if (auto v = int_attr(*export_block, "max_concurrent", "export")) cfg.export_settings.max_concurrent = size_value(*v, "export.max_concurrent");
    if (auto v = int_attr(*export_block, "output_buffer_bytes", "export")) cfg.export_settings.output_buffer_bytes = size_value(*v, "export.output_buffer_bytes");
    if (auto v = string_attr(*export_block, "archive_format", "export")) cfg.export_settings.archive_format = *v;
    if (auto v = bool_attr(*export_block, "compression", "export")) cfg.export_settings.compression = *v;
    if (auto v = int_attr(*export_block, "token_ttl_ms", "export")) cfg.export_settings.token_ttl_ms = int_value(*v, "export.token_ttl_ms");
    if (auto v = int_attr(*export_block, "pending_max_entries", "export")) cfg.export_settings.pending_max_entries = size_value(*v, "export.pending_max_entries");
    if (auto v = int_attr(*export_block, "pending_sql_max_bytes", "export")) cfg.export_settings.pending_sql_max_bytes = size_value(*v, "export.pending_sql_max_bytes");
    if (auto v = int_attr(*export_block, "max_queries", "export")) cfg.export_settings.max_queries = size_value(*v, "export.max_queries");
  }

  if (const auto* health = optional_block(root, "health", source)) {
    validate_object(*health, "health", {"interval_ms", "timeout_ms"}, {});
    if (auto v = int_attr(*health, "interval_ms", "health")) cfg.health.interval_ms = int_value(*v, "health.interval_ms");
    if (auto v = int_attr(*health, "timeout_ms", "health")) cfg.health.timeout_ms = int_value(*v, "health.timeout_ms");
  }

  load_hosts(cfg, root, source);
  load_mcp(cfg, root, source);
}

} // namespace

AppConfig load_config_from_file(const std::string& path) {
  if (path.empty()) throw std::runtime_error("--config path cannot be empty");
  AppConfig cfg = default_config();
  const HclObject root = parse_hcl(read_text_file(path));
  apply_full_hcl(cfg, root, path);
  normalize_config(cfg);
  set_version_info(cfg);
  return cfg;
}

} // namespace chdash
