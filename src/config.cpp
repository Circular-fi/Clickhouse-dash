#include "config.hpp"

#include "ch_uri.hpp"
#include "hcl.hpp"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <initializer_list>
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
  cfg.analysis.registry_ttl_ms = std::max(1000, std::min(24 * 60 * 60 * 1000, cfg.analysis.registry_ttl_ms));
  cfg.analysis.registry_max_entries = std::max<size_t>(1, std::min<size_t>(1'000'000, cfg.analysis.registry_max_entries));
  cfg.analysis.registry_sql_max_bytes = std::min<size_t>(512 * 1024 * 1024, cfg.analysis.registry_sql_max_bytes);
  cfg.analysis.log_lookup_timeout_ms = std::max(0, std::min(60 * 1000, cfg.analysis.log_lookup_timeout_ms));
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

  cfg.health.interval_ms = std::min(600 * 1000, cfg.health.interval_ms);
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
        {"name", "label", "runner_uri", "system_uri", "password_file", "runner_password_file", "system_password_file"}, {});
    const auto name = string_attr(host, "name", "clickhouse.host");
    const auto label = string_attr(host, "label", "clickhouse.host");
    auto runner_uri = string_attr(host, "runner_uri", "clickhouse.host");
    auto system_uri = string_attr(host, "system_uri", "clickhouse.host");
    const auto password_file = string_attr(host, "password_file", "clickhouse.host");
    auto runner_password_file = string_attr(host, "runner_password_file", "clickhouse.host");
    auto system_password_file = string_attr(host, "system_password_file", "clickhouse.host");

    if (!name || name->empty()) throw std::runtime_error("clickhouse.host.name is required");
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

    HostSpec spec;
    spec.id = *name;
    spec.label = label && !label->empty() ? *label : *name;
    spec.runner_uri = std::move(*runner_uri);
    spec.system_uri = std::move(*system_uri);
    cfg.hosts.push_back(std::move(spec));
  }
}

void apply_full_hcl(AppConfig& cfg, const HclObject& root, std::string_view source) {
  validate_object(root, source, {}, {
      "server", "query", "client_pool", "format_cache", "health",
      "explorer", "analysis", "export", "clickhouse"});

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
    validate_object(*explorer, "explorer", {"browse", "cache_ttl_ms", "live_refresh_ms", "function_cache_ttl_ms", "function_markdown_links"}, {"graph"});
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
