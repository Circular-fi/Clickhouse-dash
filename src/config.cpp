#include "config.hpp"

#include "ch_uri.hpp"
#include "hcl.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <initializer_list>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <unordered_set>

namespace chdash {
namespace {

std::string env_string(const char* key, const std::string& fallback = "") {
  const char* value = std::getenv(key);
  if (!value || !*value) return fallback;
  return std::string(value);
}

int env_int(const char* key, int fallback) {
  const char* value = std::getenv(key);
  if (!value || !*value) return fallback;
  try {
    return std::stoi(value);
  } catch (...) {
    return fallback;
  }
}

bool env_bool(const char* key, bool fallback) {
  const char* value = std::getenv(key);
  if (!value || !*value) return fallback;
  std::string text(value);
  for (auto& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (text == "1" || text == "true" || text == "yes" || text == "on") return true;
  if (text == "0" || text == "false" || text == "no" || text == "off") return false;
  return fallback;
}

QueryDescribeMode parse_describe_mode(std::string text, QueryDescribeMode fallback, bool strict) {
  for (auto& ch : text) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
  if (text == "always" || text == "on" || text == "1" || text == "true") return QueryDescribeMode::Always;
  if (text == "never" || text == "off" || text == "0" || text == "false") return QueryDescribeMode::Never;
  if (text == "auto") return QueryDescribeMode::Auto;
  if (strict) throw std::runtime_error("query.describe_mode must be auto, always, or never");
  return fallback;
}

QueryDescribeMode env_describe_mode(const char* key, QueryDescribeMode fallback) {
  const char* value = std::getenv(key);
  if (!value || !*value) return fallback;
  return parse_describe_mode(value, fallback, false);
}

AppConfig default_config() {
  AppConfig cfg;
  // The historical environment loader used 10000 even though AppConfig's
  // member initializer was zero. Keep the effective runtime default stable.
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
  validate_object(root, source, {}, {"server", "query", "client_pool", "format_cache", "health", "clickhouse"});

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
        "final_stats_from_query_log", "final_stats_flush_logs", "sample_interval_ms",
        "result_batch_rows", "result_batch_bytes", "sse_batch_events", "sse_batch_bytes",
        "sse_queue_max_bytes", "describe_cache_entries", "describe_cache_ttl_ms",
        "session_max_count", "session_abandoned_ttl_ms", "session_terminal_ttl_ms",
        "session_reaper_interval_ms"}, {});
    if (auto v = int_attr(*query, "result_preview_row_limit", "query")) cfg.result_preview_row_limit = int_value(*v, "query.result_preview_row_limit");
    if (auto v = int_attr(*query, "max_sql_bytes", "query")) cfg.query_max_sql_bytes = size_value(*v, "query.max_sql_bytes");
    if (auto v = string_attr(*query, "describe_mode", "query")) cfg.query_options.describe_mode = parse_describe_mode(*v, QueryDescribeMode::Auto, true);
    if (auto v = bool_attr(*query, "final_stats_from_query_log", "query")) cfg.query_options.final_stats_from_query_log = *v;
    if (auto v = bool_attr(*query, "final_stats_flush_logs", "query")) cfg.query_options.flush_query_log_for_final_stats = *v;
    if (auto v = int_attr(*query, "sample_interval_ms", "query")) cfg.query_options.sample_interval_ms = int_value(*v, "query.sample_interval_ms");
    if (auto v = int_attr(*query, "result_batch_rows", "query")) cfg.query_options.result_rows_batch_size = int_value(*v, "query.result_batch_rows");
    if (auto v = int_attr(*query, "result_batch_bytes", "query")) cfg.query_options.result_rows_batch_bytes = size_value(*v, "query.result_batch_bytes");
    if (auto v = int_attr(*query, "sse_batch_events", "query")) cfg.query_options.sse_write_batch_events = size_value(*v, "query.sse_batch_events");
    if (auto v = int_attr(*query, "sse_batch_bytes", "query")) cfg.query_options.sse_write_batch_bytes = size_value(*v, "query.sse_batch_bytes");
    if (auto v = int_attr(*query, "sse_queue_max_bytes", "query")) cfg.query_options.sse_queue_max_bytes = size_value(*v, "query.sse_queue_max_bytes");
    if (auto v = int_attr(*query, "describe_cache_entries", "query")) cfg.query_options.describe_cache_entries = size_value(*v, "query.describe_cache_entries");
    if (auto v = int_attr(*query, "describe_cache_ttl_ms", "query")) cfg.query_options.describe_cache_ttl_ms = int_value(*v, "query.describe_cache_ttl_ms");
    if (auto v = int_attr(*query, "session_max_count", "query")) cfg.query_session_max_count = size_value(*v, "query.session_max_count");
    if (auto v = int_attr(*query, "session_abandoned_ttl_ms", "query")) cfg.query_session_abandoned_ttl_ms = int_value(*v, "query.session_abandoned_ttl_ms");
    if (auto v = int_attr(*query, "session_terminal_ttl_ms", "query")) cfg.query_session_terminal_ttl_ms = int_value(*v, "query.session_terminal_ttl_ms");
    if (auto v = int_attr(*query, "session_reaper_interval_ms", "query")) cfg.query_session_reaper_interval_ms = int_value(*v, "query.session_reaper_interval_ms");
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

  if (const auto* health = optional_block(root, "health", source)) {
    validate_object(*health, "health", {"interval_ms", "timeout_ms"}, {});
    if (auto v = int_attr(*health, "interval_ms", "health")) cfg.health.interval_ms = int_value(*v, "health.interval_ms");
    if (auto v = int_attr(*health, "timeout_ms", "health")) cfg.health.timeout_ms = int_value(*v, "health.timeout_ms");
  }

  load_hosts(cfg, root, source);
}

} // namespace

AppConfig load_config_from_environment() {
  AppConfig cfg = default_config();
  cfg.listen = env_string("LISTEN_HOST", "0.0.0.0") + ":" + std::to_string(env_int("LISTEN_PORT", 8080));
  cfg.result_preview_row_limit = env_int("RESULT_PREVIEW_ROW_LIMIT", 10000);
  cfg.query_max_sql_bytes = static_cast<size_t>(std::max(0, env_int("QUERY_MAX_SQL_BYTES", 4 * 1024 * 1024)));
  cfg.query_options.describe_mode = env_describe_mode("QUERY_DESCRIBE_MODE", QueryDescribeMode::Auto);
  cfg.query_options.final_stats_from_query_log = env_bool("QUERY_FINAL_STATS_FROM_QUERY_LOG", false);
  cfg.query_options.flush_query_log_for_final_stats = env_bool("QUERY_FINAL_STATS_FLUSH_LOGS", false);
  cfg.query_options.sample_interval_ms = env_int("QUERY_SAMPLE_INTERVAL_MS", 40);
  cfg.query_options.result_rows_batch_size = env_int("QUERY_RESULT_BATCH_ROWS", 1000);
  cfg.query_options.result_rows_batch_bytes = static_cast<size_t>(std::max(0, env_int("QUERY_RESULT_BATCH_BYTES", 256 * 1024)));
  cfg.query_options.sse_write_batch_events = static_cast<size_t>(std::max(1, env_int("QUERY_SSE_BATCH_EVENTS", 8)));
  cfg.query_options.sse_write_batch_bytes = static_cast<size_t>(std::max(0, env_int("QUERY_SSE_BATCH_BYTES", 256 * 1024)));
  cfg.query_options.sse_queue_max_bytes = static_cast<size_t>(std::max(0, env_int("QUERY_SSE_QUEUE_MAX_BYTES", 8 * 1024 * 1024)));
  cfg.query_options.describe_cache_entries = static_cast<size_t>(std::max(0, env_int("QUERY_DESCRIBE_CACHE_ENTRIES", 256)));
  cfg.query_options.describe_cache_ttl_ms = env_int("QUERY_DESCRIBE_CACHE_TTL_MS", 60 * 1000);
  cfg.client_pool_max_idle_per_key = static_cast<size_t>(std::max(0, env_int("CH_CLIENT_POOL_MAX_IDLE", 4)));
  cfg.client_pool_idle_ttl_ms = env_int("CH_CLIENT_POOL_IDLE_TTL_MS", 60 * 1000);
  cfg.client_pool_validate_after_idle_ms = env_int("CH_CLIENT_POOL_VALIDATE_AFTER_IDLE_MS", 15 * 1000);
  cfg.client_pool_reaper_interval_ms = env_int("CH_CLIENT_POOL_REAPER_INTERVAL_MS", 5 * 1000);
  cfg.format_cache_max_entries = static_cast<size_t>(std::max(0, env_int("FORMAT_CACHE_MAX_ENTRIES", 512)));
  cfg.format_cache_max_bytes = static_cast<size_t>(std::max(0, env_int("FORMAT_CACHE_MAX_BYTES", 16 * 1024 * 1024)));
  cfg.format_cache_ttl_ms = env_int("FORMAT_CACHE_TTL_MS", 10 * 60 * 1000);
  cfg.query_session_max_count = static_cast<size_t>(std::max(0, env_int("QUERY_SESSION_MAX_COUNT", 256)));
  cfg.query_session_abandoned_ttl_ms = env_int("QUERY_SESSION_ABANDONED_TTL_MS", 60 * 1000);
  cfg.query_session_terminal_ttl_ms = env_int("QUERY_SESSION_TERMINAL_TTL_MS", 30 * 1000);
  cfg.query_session_reaper_interval_ms = env_int("QUERY_SESSION_REAPER_INTERVAL_MS", 5 * 1000);

  const std::string hosts_hcl = env_string("CH_HOSTS");
  if (hosts_hcl.empty()) throw std::runtime_error("CH_HOSTS is required");
  const HclObject root = parse_hcl(hosts_hcl);
  validate_object(root, "CH_HOSTS", {}, {"health", "clickhouse"});
  if (const auto* health = optional_block(root, "health", "CH_HOSTS")) {
    validate_object(*health, "health", {"interval_ms", "timeout_ms"}, {});
    if (auto v = int_attr(*health, "interval_ms", "health")) cfg.health.interval_ms = int_value(*v, "health.interval_ms");
    if (auto v = int_attr(*health, "timeout_ms", "health")) cfg.health.timeout_ms = int_value(*v, "health.timeout_ms");
  }
  load_hosts(cfg, root, "CH_HOSTS");
  normalize_config(cfg);
  set_version_info(cfg);
  return cfg;
}

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
