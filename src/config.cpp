#include "config.hpp"

#include "access_settings.hpp"

#include "ch_uri.hpp"
#include "config_schema.hpp"
#include "config_secret.hpp"
#include "hcl.hpp"
#include "mcp_identity.hpp"
#include "mcp_keys.hpp"
#include "mcp_scope.hpp"
#include "mcp_usage.hpp"
#include "mcp_usage_store.hpp"
#include "telemetry_settings.hpp"

#include <algorithm>
#include <cctype>
#include <ctime>
#include <set>
#include <fstream>
#include <initializer_list>
#include <filesystem>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <unordered_set>

namespace chdash {
namespace {

QueryDescribeMode parse_describe_mode(const std::string& text) {
  if (text == "always") return QueryDescribeMode::Always;
  if (text == "never") return QueryDescribeMode::Never;
  if (text == "auto") return QueryDescribeMode::Auto;
  throw std::runtime_error("query.describe_mode must be auto, always or never, not \"" + text + "\"");
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

// The table of keys cannot express these rules.
// Examples are a bound that depends on another key, a value that is derived, and the settings of each host.
// A value outside its bounds never gets here. config_schema.cpp stops the start with an error that names the key.
// Nothing is clamped.
void finish_config(AppConfig& cfg) {
  const auto at_most = [](int64_t value, int64_t limit, const char* name, const char* limit_name) {
    if (value > limit) {
      throw std::runtime_error(std::string(name) + " must be at most " + limit_name + " (" + std::to_string(limit) + "), not " + std::to_string(value));
    }
  };
  at_most(static_cast<int64_t>(cfg.query_options.sse_write_batch_bytes), static_cast<int64_t>(cfg.query_options.sse_queue_max_bytes), "query.sse_batch_bytes", "query.sse_queue_max_bytes");
  at_most(cfg.system.disk_growth_days, cfg.system.max_lookback_days, "system.disk_growth_days", "system.max_lookback_days");
  at_most(cfg.system.default_lookback_minutes, cfg.system.max_lookback_days * 24 * 60, "system.default_lookback_minutes", "system.max_lookback_days in minutes");

  TraceSettings& traces = cfg.otel_defaults.traces;
  LogSettings& logs = cfg.otel_defaults.logs;
  MetricSettings& metrics = cfg.otel_defaults.metrics;
  at_most(traces.default_lookback_minutes, traces.max_lookback_minutes, "observability.traces.default_lookback_minutes", "observability.traces.max_lookback_minutes");
  for (const auto& pattern : traces.service_allowlist) {
    if (pattern.empty()) throw std::runtime_error("observability.service_allowlist cannot contain an empty pattern");
    if (pattern.size() > 256) {
      throw std::runtime_error("observability.service_allowlist patterns must be at most 256 bytes, not " + std::to_string(pattern.size()) + " bytes (\"" + pattern.substr(0, 40) + "...\")");
    }
  }
  if (traces.highlighted_attributes.size() > 32) {
    throw std::runtime_error("observability.traces.highlighted_attributes accepts at most 32 keys, not " + std::to_string(traces.highlighted_attributes.size()));
  }
  for (size_t i = 0; i < traces.highlighted_attributes.size(); ++i) {
    const auto& key = traces.highlighted_attributes[i];
    if (key.empty() || key.size() > 256) {
      throw std::runtime_error("observability.traces.highlighted_attributes keys must be 1 to 256 bytes, not " + std::to_string(key.size()) + " bytes");
    }
    for (size_t j = 0; j < i; ++j) {
      if (traces.highlighted_attributes[j] == key) throw std::runtime_error("observability.traces.highlighted_attributes lists " + key + " twice");
    }
  }
  if (traces.enabled && (traces.database.empty() || traces.table.empty())) {
    throw std::runtime_error("observability.traces.database and observability.traces.table cannot be empty");
  }
  if (logs.enabled && (logs.database.empty() || logs.table.empty())) {
    throw std::runtime_error("observability.logs.database and observability.logs.table cannot be empty");
  }
  if (metrics.enabled && (metrics.database.empty() || metrics.table_prefix.empty())) {
    throw std::runtime_error("observability.metrics.database and observability.metrics.table_prefix cannot be empty");
  }

  if (cfg.export_settings.compression) {
    throw std::runtime_error("export.compression = true is not supported: the ZIP64 archive is stored without compression; use false");
  }

  // The HTTP server. worker_threads = 0 sets the value automatically. It is the larger of 8 and the hardware threads, at most max_worker_threads.
  if (cfg.server.worker_threads == 0) {
    cfg.server.worker_threads = std::min<size_t>(cfg.server.max_worker_threads, std::max<size_t>(8, std::thread::hardware_concurrency()));
  }
  if (cfg.server.worker_threads > cfg.server.max_worker_threads) {
    throw std::runtime_error("server.max_worker_threads must be at least server.worker_threads (" +
                             std::to_string(cfg.server.worker_threads) + "), not " + std::to_string(cfg.server.max_worker_threads));
  }
  // A request body carries one SQL text, escaped in JSON (twice its size at most for real text).
  // The request body can also carry the file of the query library (an import).
  // 0 means that the value is derived from these sizes.
  if (cfg.server.max_body_bytes == 0) {
    cfg.server.max_body_bytes = cfg.query_max_sql_bytes * 2 + 1024 * 1024;
    for (const auto& library : cfg.query_libraries) {
      cfg.server.max_body_bytes = std::max(cfg.server.max_body_bytes, library.max_file_bytes + 64 * 1024);
    }
  }
  // At most half of the threads hold a host status stream. The other threads stay free for the queries.
  // A value above that limit stops the start. ChDash does not lower the value.
  at_most(static_cast<int64_t>(cfg.server.max_host_streams), static_cast<int64_t>(cfg.server.max_worker_threads / 2), "server.max_host_streams",
          "half of server.max_worker_threads");

  // The settings that apply to each host are taken from the block of the configuration, with the override of the host.
  // The identity entries of MCP are copies of a host. They hold the same settings.
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

// The same, with the attributes that the table of keys (config_keys.def) lists for `block`. The table is the only list.
void validate_object_of_table(const HclObject& object, std::string_view context, const std::string& block,
                              std::initializer_list<const char*> allowed_blocks) {
  std::unordered_set<std::string> attrs;
  for (const auto& name : config::keys_of(block)) attrs.insert(name);
  for (const auto& item : object.attrs) {
    if (attrs.count(item.first) == 0) throw std::runtime_error(std::string(context) + ": unknown attribute " + item.first);
  }
  std::unordered_set<std::string> blocks;
  for (const char* name : allowed_blocks) blocks.emplace(name);
  for (const auto& item : object.blocks) {
    if (blocks.count(item.first) == 0) throw std::runtime_error(std::string(context) + ": unknown block " + item.first);
  }
}

// An object that holds no attribute of its own. It holds only the named blocks. The attributes are read through the table of keys.
void validate_blocks(const HclObject& object, std::string_view context, std::initializer_list<const char*> allowed_blocks) {
  std::unordered_set<std::string> blocks;
  for (const char* name : allowed_blocks) blocks.emplace(name);
  for (const auto& item : object.blocks) {
    if (blocks.count(item.first) == 0) throw std::runtime_error(std::string(context) + ": unknown block " + item.first);
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
    throw std::runtime_error(std::string(context) + "." + name + " must be a string, not " + hcl_value_text(it->second));
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
    throw std::runtime_error(std::string(context) + "." + name + " must be a list of strings, not " + hcl_value_text(it->second));
  }
  return it->second.as_string_list();
}

std::optional<int64_t> int_attr(const HclObject& object, const std::string& name, std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_int()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be an integer, not " + hcl_value_text(it->second));
  }
  return it->second.as_int();
}

std::optional<bool> bool_attr(const HclObject& object, const std::string& name, std::string_view context) {
  const auto it = object.attrs.find(name);
  if (it == object.attrs.end()) return std::nullopt;
  if (!it->second.is_bool()) {
    throw std::runtime_error(std::string(context) + "." + name + " must be a boolean, not " + hcl_value_text(it->second));
  }
  return it->second.as_bool();
}

// ---- observability: the settings of Traces, Logs and Metrics -------------------------------------------------------------------

// One signal, in `observability { traces { } }` (context "observability.traces"), or in the top-level block of the same name.
// Older configurations use the top-level block (context "traces").
// The settings that every host shares. The location of the tables can be overridden for a host (load_host_override).
void load_traces_block(AppConfig& cfg, const HclObject& traces, const std::string& context, bool legacy_allowlist) {
  TraceSettings& out = cfg.otel_defaults.traces;
  validate_blocks(traces, context, {"features"});
  if (legacy_allowlist) config::apply_block(cfg, traces, "observability.traces", context, {"service_allowlist"});
  else config::apply_block(cfg, traces, "observability.traces", context);
  if (legacy_allowlist) {
    if (auto v = string_list_attr(traces, "service_allowlist", context)) {
      out.service_allowlist = std::move(*v);
      cfg.value_sources["observability.service_allowlist"] = "file";
    }
  }
  if (auto v = string_list_attr(traces, "highlighted_attributes", context)) {
    out.highlighted_attributes = std::move(*v);
    cfg.value_sources["observability.traces.highlighted_attributes"] = "file";
  }
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

void load_logs_block(AppConfig& cfg, const HclObject& logs, const std::string& context) {
  validate_blocks(logs, context, {});
  config::apply_block(cfg, logs, "observability.logs", context);
}

void load_metrics_block(AppConfig& cfg, const HclObject& metrics, const std::string& context) {
  validate_blocks(metrics, context, {});
  config::apply_block(cfg, metrics, "observability.metrics", context);
}

// `observability { service_allowlist = [...]  traces { } logs { } metrics { } }` configures the Traces, Logs and Metrics pages.
// The top-level `traces`, `logs` and `metrics` blocks of older configurations still work. So does `traces.service_allowlist`, which is the allowlist of the three signals.
// A signal is never set in both places.
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
    if (auto v = string_list_attr(*observability, "service_allowlist", "observability")) {
      out.traces.service_allowlist = std::move(*v);
      cfg.value_sources["observability.service_allowlist"] = "file";
    }
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
  if (traces) load_traces_block(cfg, *traces, "observability.traces", false);
  else if (legacy_traces) load_traces_block(cfg, *legacy_traces, "traces", true);
  if (logs) load_logs_block(cfg, *logs, "observability.logs");
  else if (legacy_logs) load_logs_block(cfg, *legacy_logs, "logs");
  if (metrics) load_metrics_block(cfg, *metrics, "observability.metrics");
  else if (legacy_metrics) load_metrics_block(cfg, *legacy_metrics, "metrics");
}

// `clickhouse.host { observability { traces { table = "..." } } }` sets where the tables of this host are.
// It also sets whether a signal is on for this host.
// The rest (the limits, the allowlist, the features) is taken from the block of the configuration. It is the same for every host.
OtelHostOverride load_host_override(const HclObject& host) {
  OtelHostOverride out;
  const auto* observability = optional_block(host, "observability", "clickhouse.host");
  if (!observability) return out;
  validate_object(*observability, "clickhouse.host.observability", {}, {"traces", "logs", "metrics"});
  if (const auto* traces = optional_block(*observability, "traces", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.traces";
    validate_object_of_table(*traces, c, "clickhouse.host.observability.traces", {});
    out.traces_enabled = bool_attr(*traces, "enabled", c);
    out.traces_database = string_attr(*traces, "database", c);
    out.traces_table = string_attr(*traces, "table", c);
    out.traces_index_table = string_attr(*traces, "trace_index_table", c);
  }
  if (const auto* logs = optional_block(*observability, "logs", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.logs";
    validate_object_of_table(*logs, c, "clickhouse.host.observability.logs", {});
    out.logs_enabled = bool_attr(*logs, "enabled", c);
    out.logs_database = string_attr(*logs, "database", c);
    out.logs_table = string_attr(*logs, "table", c);
  }
  if (const auto* metrics = optional_block(*observability, "metrics", "clickhouse.host.observability")) {
    const std::string c = "clickhouse.host.observability.metrics";
    validate_object_of_table(*metrics, c, "clickhouse.host.observability.metrics", {});
    out.metrics_enabled = bool_attr(*metrics, "enabled", c);
    out.metrics_database = string_attr(*metrics, "database", c);
    out.metrics_table_prefix = string_attr(*metrics, "table_prefix", c);
  }
  return out;
}

// A URI of the file never holds a password. It gives the user and the address.
// The password is set by `<name>_env` or `<name>_file` of the host. The program puts it into the URI once, at start (config.cpp, load_hosts).
void refuse_secret_in_uri(const std::string& uri, const std::string& where, const char* field, const std::string& attributes) {
  std::string error;
  const auto parsed = parse_clickhouse_uri(uri, &error);
  if (!parsed) throw std::runtime_error(where + ": " + field + ": invalid ClickHouse URI: " + error);
  if (!parsed->password.empty()) {
    throw std::runtime_error(where + ": " + field + " holds a password in clear text: remove it and give the password with " + attributes);
  }
  if (parsed->query.count("password_file") != 0) {
    throw std::runtime_error(where + ": " + field + " has the parameter password_file: remove it and give the password with " + attributes);
  }
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
    const auto name = string_attr(host, "name", "clickhouse.host");
    if (!name || name->empty()) throw std::runtime_error("clickhouse.host.name is required");
    // The id of a host never holds a control character. The identities of MCP are created with one (mcp_identity.hpp).
    if (std::any_of(name->begin(), name->end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; })) {
      throw std::runtime_error("clickhouse.host.name must not contain a control character");
    }
    const std::string where = "clickhouse.host " + *name;
    const std::string prefix = "clickhouse.host[" + *name + "].";

    // The forms of the passwords are checked here. A password in clear text is refused before the unknown attributes, so the error can say why.
    // Exactly one form gives the password of a URI. The password of the host (for the runner and the system user) and the password of a role never apply together.
    // This rule means that no password takes precedence silently.
    //
    // The MCP identity is separate. Its password has its own attributes, and no other attribute applies to it.
    const auto shared = find_secret_ref(host, "password", where);
    const auto runner_own = find_secret_ref(host, "runner_password", where);
    const auto system_own = find_secret_ref(host, "system_password", where);
    const auto mcp_own = find_secret_ref(host, "mcp_password", where);

    validate_object_of_table(host, "clickhouse.host", "clickhouse.host", {"observability"});
    const auto label = string_attr(host, "label", "clickhouse.host");
    auto runner_uri = string_attr(host, "runner_uri", "clickhouse.host");
    auto system_uri = string_attr(host, "system_uri", "clickhouse.host");
    auto mcp_uri = string_attr(host, "mcp_uri", "clickhouse.host");
    if (!runner_uri || runner_uri->empty()) throw std::runtime_error("clickhouse.host.runner_uri is required");
    if (!system_uri || system_uri->empty()) throw std::runtime_error("clickhouse.host.system_uri is required");
    if (!ids.insert(*name).second) throw std::runtime_error("duplicate clickhouse.host.name: " + *name);

    if (shared && runner_own) {
      throw std::runtime_error(where + ": " + shared->attribute + " and " + runner_own->attribute +
                               " both give the password of runner_uri: give only one of them");
    }
    if (shared && system_own) {
      throw std::runtime_error(where + ": " + shared->attribute + " and " + system_own->attribute +
                               " both give the password of system_uri: give only one of them");
    }
    if (mcp_own && (!mcp_uri || mcp_uri->empty())) {
      throw std::runtime_error(where + ": " + mcp_own->attribute + " needs mcp_uri, and the host has none");
    }

    refuse_secret_in_uri(*runner_uri, where, "runner_uri", "runner_password_env, runner_password_file, password_env or password_file");
    refuse_secret_in_uri(*system_uri, where, "system_uri", "system_password_env, system_password_file, password_env or password_file");
    if (mcp_uri && !mcp_uri->empty()) refuse_secret_in_uri(*mcp_uri, where, "mcp_uri", "mcp_password_env or mcp_password_file");

    // The code reads each secret here, one time. The connections of the process never read a file or the environment.
    const auto apply = [&](const std::optional<SecretRef>& ref, std::string& uri, const char* role, const std::string& shared_value,
                           const std::string& shared_source) {
      if (ref) {
        const SecretValue secret = read_secret(*ref, where);
        uri = clickhouse_uri_with_password(uri, secret.value);
        cfg.value_sources[prefix + role + "_password"] = secret.source;
      } else if (!shared_value.empty()) {
        uri = clickhouse_uri_with_password(uri, shared_value);
        cfg.value_sources[prefix + role + "_password"] = shared_source;
      }
    };
    std::string shared_value;
    std::string shared_source;
    if (shared) {
      const SecretValue secret = read_secret(*shared, where);
      shared_value = secret.value;
      shared_source = secret.source;
    }
    apply(runner_own, *runner_uri, "runner", shared_value, shared_source);
    apply(system_own, *system_uri, "system", shared_value, shared_source);
    if (mcp_uri && !mcp_uri->empty()) apply(mcp_own, *mcp_uri, "mcp", std::string(), std::string());

    // The code checks every URI here (the address and the parameters). A mistake stops the start and names the host and the field.
    // It does not wait for the first request to find the mistake.
    const auto check_uri = [&](const std::string& uri, const char* field) {
      const std::string problem = validate_clickhouse_uri(uri);
      if (!problem.empty()) throw std::runtime_error("clickhouse.host " + *name + ": " + field + ": " + problem);
    };
    check_uri(*runner_uri, "runner_uri");
    check_uri(*system_uri, "system_uri");
    if (mcp_uri && !mcp_uri->empty()) check_uri(*mcp_uri, "mcp_uri");

    HostSpec spec;
    spec.id = *name;
    spec.label = label && !label->empty() ? *label : *name;
    if (label && !label->empty()) cfg.value_sources[prefix + "label"] = "file";
    spec.runner_uri = std::move(*runner_uri);
    spec.system_uri = std::move(*system_uri);
    if (mcp_uri) spec.mcp_uri = std::move(*mcp_uri);
    spec.otel_override = load_host_override(host);
    cfg.hosts.push_back(std::move(spec));
  }
}

// The values of a key that both forms of the block share are checked here: the name and the token.
void check_mcp_key_token(AppConfig& cfg, McpKey& key, const SecretRef& ref, const std::string& context, const std::string& prefix) {
  const SecretValue secret = read_secret(ref, context);
  if (!mcp_valid_secret(secret.value)) {
    throw std::runtime_error(context + "." + ref.attribute + ": the token (" + secret.source +
                             ") must be mcp_ and 43 base64url characters, or the UUID version 4 of an older key");
  }
  key.secret_hash = mcp_hash_secret(secret.value);
  key.secret_hint = mcp_secret_hint(secret.value);
  key.legacy_token = !mcp_valid_token(secret.value);
  if (key.legacy_token) {
    cfg.warnings.push_back(context + ": the token is a UUID of an older version. ChDash accepts it until you replace it: make an mcp_ token "
                           "(mcp_ and the base64url text of 32 random bytes) and give it to the client");
  }
  cfg.value_sources[prefix + "token"] = secret.source;
}

// ChDash reads the older block `key { name = ..., secret_env | secret_file, hosts, tools, databases, max_rows, timeout_seconds }` for one release, with a warning.
// The block of the contract is mcp_key "name" { } (parse_mcp_key_block).
McpKey parse_mcp_key(AppConfig& cfg, const HclObject& block) {
  if (block.labeled) throw std::runtime_error("mcp.key takes no label: write mcp_key \"" + block.label + "\" { ... }");
  const auto name = string_attr(block, "name", "mcp.key");
  if (!name || name->empty()) throw std::runtime_error("mcp.key.name is required");
  const std::string context = "mcp.key " + *name;
  const std::string prefix = "mcp.key[" + *name + "].";
  // A hash alone is not a secret that ChDash can compare with a key file. A secret in clear text is never in the file.
  if (block.attrs.count("secret_sha256") != 0) {
    throw std::runtime_error(context + ": secret_sha256 is not accepted: give the secret with secret_env or secret_file");
  }
  const auto ref = find_secret_ref(block, "secret", context);  // refuses a secret in clear text before the unknown attributes
  validate_object_of_table(block, "mcp.key", "mcp.key", {});
  McpKey key;
  key.source = "config";
  key.name = *name;
  key.id = *name;
  if (!mcp_valid_key_name(key.name)) {
    throw std::runtime_error(context + ": name must use a-z, 0-9, - and _ (at most 32 bytes), start with a letter or digit, and not start with ui_");
  }

  // The code reads the secret here. It keeps only its hash and its hint. The page never shows the secret of a key.
  if (!ref) throw std::runtime_error(context + ": exactly one of secret_env and secret_file is required");
  check_mcp_key_token(cfg, key, *ref, context, prefix);
  cfg.value_sources[prefix + "secret"] = cfg.value_sources[prefix + "token"];
  cfg.value_sources.erase(prefix + "token");
  cfg.warnings.push_back(context + ": the key block is deprecated and ChDash reads it for one release only. Write mcp_key \"" + key.name +
                         "\" { token_file = ..., tools = [...], scope { hosts = [...], databases = [...] }, limits { max_rows = ..., timeout_seconds = ... } }");

  if (auto v = string_list_attr(block, "hosts", "mcp.key")) key.hosts = std::move(*v);
  if (auto v = string_list_attr(block, "tools", "mcp.key")) key.tools = std::move(*v);
  if (auto v = string_list_attr(block, "databases", "mcp.key")) key.databases = std::move(*v);
  if (auto v = int_attr(block, "max_rows", "mcp.key")) key.max_rows = v;
  if (auto v = int_attr(block, "timeout_seconds", "mcp.key")) key.timeout_seconds = v;
  for (const char* attribute : {"tools", "databases", "max_rows", "timeout_seconds"}) {
    if (block.attrs.count(attribute) != 0) cfg.value_sources[prefix + attribute] = "file";
  }
  return key;
}

// The subject of a key: the name of a user. 1 to 64 characters of A-Z a-z 0-9 . _ @ + -.
bool valid_subject(const std::string& subject) {
  return !subject.empty() && subject.size() <= 64 && std::all_of(subject.begin(), subject.end(), [](unsigned char c) {
    return std::isalnum(c) || c == '.' || c == '_' || c == '@' || c == '+' || c == '-';
  });
}

// The block of the contract (docs/mcp.md, "The mcp_key block"):
//   mcp_key "name" { token_file | token_env, subject, tools, expires, scope { hosts, databases }, limits { max_rows, timeout_seconds,
//   rate_limit_per_minute } }
// `mcp_hosts` are the hosts that have an mcp_uri. When there is only one such host, a key without scope.hosts reads that host.
McpKey parse_mcp_key_block(AppConfig& cfg, const HclObject& block, const std::vector<std::string>& mcp_hosts) {
  if (!block.labeled || block.label.empty()) throw std::runtime_error("mcp.mcp_key needs its name as a label: mcp_key \"name\" { ... }");
  McpKey key;
  key.source = "config";
  key.name = block.label;
  key.id = block.label;
  const std::string context = "mcp.mcp_key " + key.name;
  const std::string prefix = "mcp.mcp_key[" + key.name + "].";
  if (!mcp_valid_key_name(key.name)) {
    throw std::runtime_error(context + ": the name must use a-z, 0-9, - and _ (at most 32 bytes), start with a letter or digit, and not start with ui_, not \"" +
                             key.name + "\"");
  }
  // A token in clear text is refused before the unknown attributes, so the error can say why.
  const auto ref = find_secret_ref(block, "token", context);
  validate_object_of_table(block, context, "mcp.mcp_key", {"scope", "limits"});
  if (!ref) throw std::runtime_error(context + ": exactly one of token_env and token_file is required");
  check_mcp_key_token(cfg, key, *ref, context, prefix);

  if (auto v = string_attr(block, "subject", context)) {
    if (!valid_subject(*v)) {
      throw std::runtime_error(context + ".subject must be 1 to 64 characters of A-Z a-z 0-9 . _ @ + -, not " + hcl_value_text(block.attrs.at("subject")));
    }
    key.subject = *v;
    cfg.value_sources[prefix + "subject"] = "file";
  }
  if (auto v = string_list_attr(block, "tools", context)) {
    key.tools = std::move(*v);
    cfg.value_sources[prefix + "tools"] = "file";
  }
  if (auto v = string_attr(block, "expires", context)) {
    int64_t at = 0;
    if (!mcp_parse_rfc3339(*v, &at)) {
      throw std::runtime_error(context + ".expires must be an RFC 3339 time (2027-10-15T00:00:00Z), not " + hcl_value_text(block.attrs.at("expires")));
    }
    key.expires_at = at;
    cfg.value_sources[prefix + "expires"] = "file";
  }
  if (const auto* scope = optional_block(block, "scope", context)) {
    if (scope->labeled) throw std::runtime_error(context + ".scope takes no label");
    validate_object_of_table(*scope, context + ".scope", "mcp.mcp_key.scope", {});
    if (auto v = string_list_attr(*scope, "hosts", context + ".scope")) {
      key.hosts = std::move(*v);
      cfg.value_sources[prefix + "scope.hosts"] = "file";
    }
    if (auto v = string_list_attr(*scope, "databases", context + ".scope")) {
      key.databases = std::move(*v);
      cfg.value_sources[prefix + "scope.databases"] = "file";
    }
  }
  // A key reads one host. When the configuration has one host with mcp_uri, a key that names no host reads that host.
  if (key.hosts.empty() && cfg.value_sources.count(prefix + "scope.hosts") == 0 && mcp_hosts.size() == 1) key.hosts = mcp_hosts;
  if (const auto* limits = optional_block(block, "limits", context)) {
    if (limits->labeled) throw std::runtime_error(context + ".limits takes no label");
    validate_object_of_table(*limits, context + ".limits", "mcp.mcp_key.limits", {});
    if (auto v = int_attr(*limits, "max_rows", context + ".limits")) {
      key.max_rows = v;
      cfg.value_sources[prefix + "limits.max_rows"] = "file";
    }
    if (auto v = int_attr(*limits, "timeout_seconds", context + ".limits")) {
      key.timeout_seconds = v;
      cfg.value_sources[prefix + "limits.timeout_seconds"] = "file";
    }
    if (auto v = int_attr(*limits, "rate_limit_per_minute", context + ".limits")) {
      key.rate_limit_per_minute = v;
      cfg.value_sources[prefix + "limits.rate_limit_per_minute"] = "file";
    }
  }
  return key;
}

// The mcp { } block. Every check of the startup errors in docs/mcp.md ("Startup errors") is here.
// A bad configuration stops the process with "config error".
void load_mcp(AppConfig& cfg, const HclObject& root, std::string_view source) {
  const HclObject* mcp = optional_block(root, "mcp", source);
  if (!mcp) return;
  McpSettings& out = cfg.mcp;
  validate_blocks(*mcp, "mcp", {"key", "mcp_key", "keys", "usage"});
  config::apply_block(cfg, *mcp, "mcp", "mcp");
  // The mode of the keys (keys { mode }), or its older form manage_from_ui. The two together contradict each other.
  const bool manage_given = mcp->attrs.count("manage_from_ui") != 0;
  if (const auto* keys = optional_block(*mcp, "keys", "mcp")) {
    if (keys->labeled) throw std::runtime_error("mcp.keys takes no label");
    validate_object_of_table(*keys, "mcp.keys", "mcp.keys", {});
    if (manage_given) {
      throw std::runtime_error("mcp.manage_from_ui and mcp.keys.mode are both in the file: remove manage_from_ui (keys.mode replaces it)");
    }
    if (auto v = string_attr(*keys, "mode", "mcp.keys")) {
      if (*v == "static") out.keys_mode = McpKeysMode::Static;
      else if (*v == "dynamic") out.keys_mode = McpKeysMode::Dynamic;
      else if (*v == "hybrid") out.keys_mode = McpKeysMode::Hybrid;
      else throw std::runtime_error("mcp.keys.mode must be one of static, dynamic and hybrid, not " + hcl_value_text(keys->attrs.at("mode")));
      cfg.value_sources["mcp.keys.mode"] = "file";
    }
  } else if (manage_given) {
    out.keys_mode = out.manage_from_ui ? McpKeysMode::Hybrid : McpKeysMode::Static;
    cfg.value_sources["mcp.keys.mode"] = "file";
    cfg.warnings.push_back(std::string("mcp.manage_from_ui is deprecated: write mcp { keys { mode = \"") + mcp_keys_mode_name(out.keys_mode) +
                           "\" } } (false is static, true is hybrid)");
  }
  out.manage_from_ui = out.keys_mode != McpKeysMode::Static;
  if (const auto* usage = optional_block(*mcp, "usage", "mcp")) {
    validate_blocks(*usage, "mcp.usage", {});
    config::apply_block(cfg, *usage, "mcp.usage", "mcp.usage");
  }
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
    cfg.value_sources["mcp.auth_header"] = "file";
  }
  if (auto v = string_list_attr(*mcp, "allowed_origins", "mcp")) {
    for (const auto& origin : *v) {
      const auto scheme = origin.find("://");
      const bool ok = origin.size() <= 256 && scheme != std::string::npos && (origin.compare(0, scheme, "http") == 0 || origin.compare(0, scheme, "https") == 0) &&
                      origin.size() > scheme + 3 && origin.find_first_of("/ \t*?#", scheme + 3) == std::string::npos;
      if (!ok) throw std::runtime_error("mcp.allowed_origins: \"" + origin + "\" must look like https://host[:port] (no path, no *)");
    }
    out.allowed_origins = std::move(*v);
    cfg.value_sources["mcp.allowed_origins"] = "file";
  }
  McpKeyContext context;
  for (const auto& host : cfg.hosts) {
    if (!host.mcp_uri.empty()) context.hosts.push_back(host.id);
  }
  if (const auto keys = mcp->blocks.find("mcp_key"); keys != mcp->blocks.end()) {
    for (const auto& block : keys->second) out.keys.push_back(parse_mcp_key_block(cfg, block, context.hosts));
  }
  if (const auto keys = mcp->blocks.find("key"); keys != mcp->blocks.end()) {
    for (const auto& block : keys->second) out.keys.push_back(parse_mcp_key(cfg, block));
  }
  // The dynamic mode has only the keys of the page.
  if (out.keys_mode == McpKeysMode::Dynamic && !out.keys.empty()) {
    throw std::runtime_error("mcp.keys.mode = \"dynamic\" takes the keys of the page only: remove the mcp_key block " + out.keys.front().name +
                             " or use the mode hybrid");
  }
  // The name of this instance in the call log.
  out.instance = out.usage.instance.empty() ? mcp_usage_host_name() : out.usage.instance;
  if (!out.enabled) return;

  // 1. Check that a place exists to read keys from.
  if (out.keys_mode == McpKeysMode::Static && out.keys.empty()) {
    throw std::runtime_error("mcp.keys.mode = \"static\" needs at least one mcp_key block");
  }
  if (out.keys_mode == McpKeysMode::Dynamic && out.storage_file.empty()) {
    throw std::runtime_error("mcp.keys.mode = \"dynamic\" needs mcp.storage_file: the page keeps its keys there");
  }
  if (out.storage_file.empty() && out.keys.empty()) {
    throw std::runtime_error("mcp.enabled needs mcp.storage_file or at least one mcp_key block");
  }
  // 2. A ClickHouse identity for MCP.
  if (context.hosts.empty()) {
    throw std::runtime_error("mcp.enabled needs at least one clickhouse.host with mcp_uri");
  }
  // The identity of the API tools (mcp_identity.hpp): the MCP user takes the place of the runner.
  // The system user keeps its role for the pages (figures and the OpenTelemetry tables).
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
  context.rate_limit_cap = out.rate_limit_per_minute;
  // 4. Names and secrets are unique (the storage file is checked below, with the same rule).
  for (size_t i = 0; i < out.keys.size(); ++i) {
    for (size_t j = 0; j < i; ++j) {
      if (out.keys[i].name == out.keys[j].name) throw std::runtime_error("mcp.mcp_key: two keys have the name " + out.keys[i].name);
      if (out.keys[i].secret_hash == out.keys[j].secret_hash) {
        throw std::runtime_error("mcp.mcp_key: keys " + out.keys[j].name + " and " + out.keys[i].name + " have the same token");
      }
    }
  }
  // 5 and 6. Hosts and tools exist; SQL tools go with databases = ["*"].
  for (const auto& key : out.keys) {
    if (const auto err = mcp_validate_key(key, context)) {
      const std::string field = err->field.empty() ? "" : err->field + ": ";
      // A limit outside its range: the message also says which value the file gives.
      std::string given;
      if (err->reason == "range" && err->field == "max_rows" && key.max_rows) given = ", not " + std::to_string(*key.max_rows);
      if (err->reason == "range" && err->field == "timeout_seconds" && key.timeout_seconds) given = ", not " + std::to_string(*key.timeout_seconds);
      if (err->reason == "range" && err->field == "rate_limit_per_minute" && key.rate_limit_per_minute) given = ", not " + std::to_string(*key.rate_limit_per_minute);
      // The block of the key, as the file writes it: mcp_key "name" { }, or the older key { name = ... }.
      const bool contract_block = cfg.value_sources.count("mcp.mcp_key[" + key.name + "].token") != 0;
      throw std::runtime_error((contract_block ? "mcp.mcp_key " : "mcp.key ") + key.name + ": " + field + err->message + given);
    }
  }
  // A key that is already expired at start is a warning. It gets the 401 of an unknown key.
  const int64_t started = static_cast<int64_t>(std::time(nullptr));
  for (const auto& key : out.keys) {
    if (key.expires_at && *key.expires_at <= started) {
      cfg.warnings.push_back("mcp key " + key.name + " expired at " + mcp_iso_utc(*key.expires_at) + ": its requests get 401");
    }
  }
  // 3. The storage file must be valid JSON. The code never rewrites the file when it is not valid.
  // Its directory must exist. The static mode does not read the file.
  if (!out.storage_file.empty() && out.keys_mode == McpKeysMode::Static) {
    try {
      const auto stored = mcp_load_key_file(out.storage_file);
      if (!stored.empty()) {
        cfg.warnings.push_back("mcp.storage_file " + out.storage_file + " has " + std::to_string(stored.size()) +
                               " keys of the page: mcp.keys.mode = \"static\" does not read them, and these keys get 401");
      }
    } catch (const std::exception& error) {
      cfg.warnings.push_back("mcp.storage_file " + out.storage_file + " is not read in the static mode: " + error.what());
    }
  } else if (!out.storage_file.empty()) {
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
  // 8. The usage: the name of this instance, and a directory.
  // The code writes the file of this instance in that directory, and reads the files of the others there.
  //
  // The file of this instance is a file of its own.
  // It is neither the key file nor a library. It is the usage file of this ChDash.
  // The code never rewrites this file when it is not valid.
  McpUsageSettings& usage = out.usage;
  if (usage.enabled) {
    if (usage.instance.empty()) {
      const std::string host_name = mcp_usage_host_name();
      if (!mcp_valid_usage_instance(host_name)) {
        throw std::runtime_error("mcp.usage.instance: the host name \"" + host_name +
                                 "\" is not the name of an instance (1 to 64 characters of A-Z a-z 0-9 . _ -): set mcp.usage.instance");
      }
      usage.instance = host_name;
    } else if (!mcp_valid_usage_instance(usage.instance)) {
      throw std::runtime_error("mcp.usage.instance \"" + usage.instance + "\" must be 1 to 64 characters of A-Z a-z 0-9 . _ -");
    }
    if (usage.dir.empty()) throw std::runtime_error("mcp.usage.dir is required when mcp.usage.enabled = true");
    const std::string file = usage.dir + "/" + McpUsageFileStore::file_name(usage.instance);
    const auto same = [](const std::string& a, const std::string& b) {
      return std::filesystem::path(a).lexically_normal() == std::filesystem::path(b).lexically_normal();
    };
    if (!out.storage_file.empty() && same(file, out.storage_file)) {
      throw std::runtime_error("mcp.usage.dir " + usage.dir + ": " + file + " is the key file (mcp.storage_file): the usage needs a file of its own");
    }
    for (const auto& library : cfg.query_libraries) {
      if (same(file, library.file)) {
        throw std::runtime_error("mcp.usage.dir " + usage.dir + ": " + file + " is the file of the query library " + library.name + ": the usage needs a file of its own");
      }
    }
    try {
      mcp_check_usage_dir(usage.dir, usage.instance);
    } catch (const std::exception& error) {
      throw std::runtime_error("mcp.usage.dir " + usage.dir + ": " + error.what());
    }
  }
}

// The query_library blocks: one block is the library of the server, as before.
// More blocks, each with a name, are more libraries.
// The libraries are shown side by side on the Query page.
// Some of them are read-only (writable = false).
//
// A block that is not enabled is ignored. The first enabled block is the default library. A request without ?library= reaches it.
void load_query_libraries(AppConfig& cfg, const HclObject& root) {
  cfg.query_libraries.clear();
  const auto found = root.blocks.find("query_library");
  if (found == root.blocks.end()) return;
  std::vector<std::vector<std::string>> set_keys;  // the keys that the file gives, for each library that is on
  for (const auto& block : found->second) {
    if (optional_block(block, "history", "query_library")) {
      throw std::runtime_error("query_library.history was removed: the query history is always kept in the browser; delete the block");
    }
    validate_blocks(block, "query_library", {});
    cfg.query_library = QueryLibrarySettings{};
    std::vector<std::string> given;
    config::apply_block(cfg, block, "query_library", "query_library", {}, &given);
    if (cfg.query_library.max_query_bytes > cfg.query_library.max_file_bytes) {
      throw std::runtime_error("query_library.max_query_bytes must be at most query_library.max_file_bytes (" + std::to_string(cfg.query_library.max_file_bytes) +
                               "), not " + std::to_string(cfg.query_library.max_query_bytes));
    }
    if (cfg.query_library.enabled) {
      cfg.query_libraries.push_back(cfg.query_library);
      set_keys.push_back(std::move(given));
    }
  }
  cfg.query_library = QueryLibrarySettings{};

  // Any text that the UI can show has no control character and no space at either end. It is at most 128 bytes.
  // The API takes the text as the value of ?library= (encoded as any query value).
  const auto valid_name = [](const std::string& name) {
    return !name.empty() && name.size() <= 128 && name.front() != ' ' && name.back() != ' ' &&
           std::none_of(name.begin(), name.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; });
  };
  std::unordered_set<std::string> names;
  std::unordered_set<std::string> files;
  for (size_t i = 0; i < cfg.query_libraries.size(); ++i) {
    QueryLibrarySettings& library = cfg.query_libraries[i];
    if (library.name.empty() && i == 0) library.name = "default";
    if (library.name.empty()) {
      throw std::runtime_error("query_library.name is required when there are several libraries (only the first may leave it out, it is then \"default\")");
    }
    if (!valid_name(library.name)) {
      throw std::runtime_error("query_library.name must be 1 to 128 bytes, with no control character and no space at either end, not \"" + library.name + "\"");
    }
    if (!names.insert(library.name).second) throw std::runtime_error("duplicate query_library.name: " + library.name);
    if (library.file.empty()) {
      throw std::runtime_error("query_library.file is required when query_library.enabled = true (library " + library.name + ")");
    }
    if (!files.insert(library.file).second) {
      throw std::runtime_error("query_library.file " + library.file + " is used by two libraries (" + library.name + " and another): each library has its own file");
    }
    for (const auto& key : set_keys[i]) cfg.value_sources["query_library[" + library.name + "]." + key] = "file";
  }
}

// The telemetry { } block (docs/server-telemetry.md) sets the OTLP export of the spans and of the call log of MCP. Its keys are in the table.
// The otlp_endpoint key has three forms (the file, a variable, a file). The durations are read here.
void load_telemetry(AppConfig& cfg, const HclObject& root, std::string_view source) {
  const HclObject* block = optional_block(root, "telemetry", source);
  if (!block) return;
  validate_blocks(*block, "telemetry", {});
  config::apply_block(cfg, *block, "telemetry", "telemetry");
  TelemetrySettings& out = cfg.telemetry;

  if (const auto endpoint = read_value_forms(*block, "otlp_endpoint", "telemetry")) {
    std::string error;
    if (!otlp_parse_endpoint(endpoint->value, &error)) {
      throw std::runtime_error("telemetry.otlp_endpoint (" + endpoint->source + ") " + error + ", not \"" + endpoint->value + "\"");
    }
    out.otlp_endpoint = endpoint->value;
    cfg.value_sources["telemetry.otlp_endpoint"] = endpoint->source;
  }

  const auto duration = [&](const char* key, int64_t min_ms, int64_t max_ms, int64_t* field) {
    const auto text = string_attr(*block, key, "telemetry");
    if (!text) return;
    const auto ms = parse_duration_ms(*text);
    if (!ms) {
      throw std::runtime_error(std::string("telemetry.") + key + " must be a duration (an integer and one of ms, s, m and h, for example \"15s\"), not \"" +
                               *text + "\"");
    }
    if (*ms < min_ms || *ms > max_ms) {
      throw std::runtime_error(std::string("telemetry.") + key + " must be between " + duration_text(min_ms) + " and " + duration_text(max_ms) +
                               ", not \"" + *text + "\"");
    }
    *field = *ms;
    cfg.value_sources[std::string("telemetry.") + key] = "file";
  };
  duration("export_interval", 100, 3600 * 1000, &out.export_interval_ms);
  duration("export_timeout", 100, 5 * 60 * 1000, &out.export_timeout_ms);
  duration("connect_timeout", 100, 60 * 1000, &out.connect_timeout_ms);

  if (out.service_name.empty() || out.service_name.size() > 255 ||
      std::any_of(out.service_name.begin(), out.service_name.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; })) {
    throw std::runtime_error("telemetry.service_name must be 1 to 255 bytes without a control character, not \"" + out.service_name + "\"");
  }
  // The keys that contradict each other.
  if (out.max_export_batch_size > out.max_queue_size) {
    throw std::runtime_error("telemetry.max_export_batch_size (" + std::to_string(out.max_export_batch_size) + ") must be at most telemetry.max_queue_size (" +
                             std::to_string(out.max_queue_size) + ")");
  }
  if (out.connect_timeout_ms > out.export_timeout_ms) {
    throw std::runtime_error("telemetry.connect_timeout (" + duration_text(out.connect_timeout_ms) + ") must be at most telemetry.export_timeout (" +
                             duration_text(out.export_timeout_ms) + ")");
  }
  if (out.enabled && out.otlp_endpoint.empty()) {
    throw std::runtime_error("telemetry.enabled = true needs otlp_endpoint (or otlp_endpoint_env, or otlp_endpoint_file)");
  }
  if (out.enabled && !cfg.mcp.enabled && !cfg.access.enforced()) {
    cfg.warnings.push_back("telemetry.enabled = true, but mcp.enabled = false and access.mode = \"open\": the export has no span and no log record to send");
  }
}

// The access { } block (docs/access.md, contract 11.2) is mandatory. A file without it stops the start. This prevents anyone from receiving the open mode by mistake.
// The code reads every key here. The table lists the keys for the reference.
void load_access(AppConfig& cfg, const HclObject& root, std::string_view source) {
  const HclObject* block = optional_block(root, "access", source);
  if (!block) {
    throw std::runtime_error(
        "the access block is missing: write access { mode = \"authzen\" ... } (the identity token and the PDP), or access { mode = \"open\" } "
        "for a server on a closed network (docs/access.md)");
  }
  validate_object(*block, "access", {"mode"}, {"identity", "pdp"});
  AccessSettings& out = cfg.access;
  const auto mode = string_attr(*block, "mode", "access");
  if (!mode) throw std::runtime_error("access.mode is required: \"authzen\" or \"open\"");
  if (*mode == "authzen") out.mode = AccessMode::Authzen;
  else if (*mode == "open") out.mode = AccessMode::Open;
  else throw std::runtime_error("access.mode must be \"authzen\" or \"open\", not \"" + *mode + "\"");
  cfg.value_sources["access.mode"] = "file";

  const HclObject* identity = optional_block(*block, "identity", "access");
  const HclObject* pdp = optional_block(*block, "pdp", "access");
  if (out.mode == AccessMode::Open) {
    if (identity || pdp) {
      throw std::runtime_error(std::string("access.mode = \"open\" and the access.") + (identity ? "identity" : "pdp") +
                               " block contradict each other: the open mode checks no identity and asks no PDP. Remove the block, or use mode = \"authzen\"");
    }
    cfg.warnings.push_back("access.mode = \"open\": ChDash checks no identity and no permission. Use it only for a server alone on a closed network (docs/access.md)");
    return;
  }
  if (!identity) throw std::runtime_error("access.mode = \"authzen\" needs the access.identity block (issuer, audience, public_keys)");
  if (!pdp) throw std::runtime_error("access.mode = \"authzen\" needs the access.pdp block (url, token_env or token_file)");

  const auto text_without_control = [](const std::string& text) {
    return std::none_of(text.begin(), text.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; });
  };
  const auto duration = [&](const HclObject& object, const std::string& context, const char* key, int64_t min_ms, int64_t max_ms, int64_t* field) {
    const auto text = string_attr(object, key, context);
    if (!text) return;
    const auto ms = parse_duration_ms(*text);
    if (!ms) {
      throw std::runtime_error(context + "." + key + " must be a duration (an integer and one of ms, s, m and h, for example \"5m\"), not \"" + *text + "\"");
    }
    if (*ms < min_ms || *ms > max_ms) {
      throw std::runtime_error(context + "." + key + " must be between " + duration_text(min_ms) + " and " + duration_text(max_ms) + ", not \"" + *text + "\"");
    }
    *field = *ms;
    cfg.value_sources[context + "." + key] = "file";
  };

  // identity { }
  validate_object(*identity, "access.identity", {"header", "issuer", "audience", "public_keys", "public_keys_env", "public_keys_file", "max_age"}, {});
  if (const auto header = string_attr(*identity, "header", "access.identity")) {
    const bool token_chars = !header->empty() && header->size() <= 128 && std::all_of(header->begin(), header->end(), [](unsigned char c) {
      return std::isalnum(c) || std::string_view("!#$%&'*+-.^_`|~").find(static_cast<char>(c)) != std::string_view::npos;
    });
    if (!token_chars) throw std::runtime_error("access.identity.header must be an HTTP header name (1 to 128 letters, digits and !#$%&'*+-.^_`|~), not \"" + *header + "\"");
    std::string lower = *header;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (lower == "cookie" || lower == "authorization" || lower == "host" || lower == "content-type" || lower == "content-length") {
      throw std::runtime_error("access.identity.header must be a header of its own (the token is never read from a cookie), not \"" + *header + "\"");
    }
    out.header = *header;
    cfg.value_sources["access.identity.header"] = "file";
  }
  const auto issuer = string_attr(*identity, "issuer", "access.identity");
  if (!issuer || issuer->empty() || issuer->size() > 1024 || !text_without_control(*issuer)) {
    throw std::runtime_error("access.identity.issuer is required: the iss of the tokens, 1 to 1024 bytes without a control character" +
                             (issuer ? ", not \"" + *issuer + "\"" : std::string()));
  }
  out.issuer = *issuer;
  cfg.value_sources["access.identity.issuer"] = "file";
  const auto audience = string_attr(*identity, "audience", "access.identity");
  if (!audience || audience->empty() || audience->size() > 256 || !text_without_control(*audience)) {
    throw std::runtime_error("access.identity.audience is required: the name of this server in the aud of the tokens, 1 to 256 bytes without a control character" +
                             (audience ? ", not \"" + *audience + "\"" : std::string()));
  }
  out.audience = *audience;
  cfg.value_sources["access.identity.audience"] = "file";
  const auto keys_text = read_value_forms(*identity, "public_keys", "access.identity");
  if (!keys_text) throw std::runtime_error("access.identity needs the public keys of the issuer: give one of public_keys, public_keys_env and public_keys_file");
  {
    std::string error;
    auto keys = parse_identity_public_keys(keys_text->value, &error);
    if (!keys) throw std::runtime_error("access.identity.public_keys (" + keys_text->source + "): " + error);
    out.keys = std::move(*keys);
    cfg.value_sources["access.identity.public_keys"] = keys_text->source;
  }
  duration(*identity, "access.identity", "max_age", 1000, 24 * 3600 * 1000, &out.max_age_ms);

  // pdp { }
  validate_object(*pdp, "access.pdp", {"url", "url_env", "url_file", "token", "token_env", "token_file", "timeout", "cache_ttl"}, {});
  const auto url = read_value_forms(*pdp, "url", "access.pdp");
  if (!url) throw std::runtime_error("access.pdp needs the address of the PDP: give one of url, url_env and url_file");
  if (url->value.rfind("https://", 0) == 0) {
    throw std::runtime_error("access.pdp.url (" + url->source + ") https is not available: ChDash has no TLS client. Use http on a private network that only ChDash and the PDP reach (docs/access.md), not \"" +
                             url->value + "\"");
  }
  {
    std::string error;
    const auto endpoint = otlp_parse_endpoint(url->value, &error);
    if (!endpoint) throw std::runtime_error("access.pdp.url (" + url->source + ") " + error + ", not \"" + url->value + "\"");
    out.pdp_endpoint = *endpoint;
  }
  out.pdp_url = url->value;
  cfg.value_sources["access.pdp.url"] = url->source;
  const auto token_ref = find_secret_ref(*pdp, "token", "access.pdp");
  if (!token_ref) throw std::runtime_error("access.pdp needs the token of this server at the PDP: give token_env or token_file");
  const SecretValue token = read_secret(*token_ref, "access.pdp");
  if (token.value.size() > 4096 || !std::all_of(token.value.begin(), token.value.end(), [](unsigned char c) { return c > 0x20 && c < 0x7f; })) {
    throw std::runtime_error("access.pdp.token (" + token.source + ") must be 1 to 4096 visible ASCII characters without a space (the value is not shown)");
  }
  out.pdp_token = token.value;
  cfg.value_sources["access.pdp.token"] = token.source;
  duration(*pdp, "access.pdp", "timeout", 10, 60 * 1000, &out.pdp_timeout_ms);
  duration(*pdp, "access.pdp", "cache_ttl", 0, 3600 * 1000, &out.pdp_cache_ttl_ms);
}

// A label is the name of an mcp_key block only (mcp_key "name" { }).
// On each other block, a label stops the start. The block takes its name in an attribute.
void refuse_labels(const HclObject& object, const std::string& path) {
  for (const auto& [name, list] : object.blocks) {
    const std::string child = path.empty() ? name : path + "." + name;
    for (const auto& block : list) {
      if (block.labeled && child != "mcp.mcp_key") {
        throw std::runtime_error(child + " takes no label: write " + name + " { ... }, not " + name + " \"" + block.label + "\" { ... }");
      }
      refuse_labels(block, child);
    }
  }
}

void apply_full_hcl(AppConfig& cfg, const HclObject& root, std::string_view source) {
  refuse_labels(root, "");
  validate_object(root, source, {}, {
      "server", "query", "client_pool", "generated_queries", "admission", "format_cache", "health",
      "observability", "traces", "logs", "metrics", "explorer", "system", "analysis", "export", "clickhouse", "query_library", "mcp",
      "telemetry", "access"});

  // The blocks whose keys are all in the table. The type and the bounds of a key are checked there (config_schema.cpp).
  for (const char* name : {"query", "client_pool", "generated_queries", "admission", "format_cache", "health", "analysis", "export"}) {
    if (const auto* block = optional_block(root, name, source)) {
      validate_blocks(*block, name, {});
      config::apply_block(cfg, *block, name, name);
    }
  }

  if (const auto* server = optional_block(root, "server", source)) {
    validate_blocks(*server, "server", {});
    config::apply_block(cfg, *server, "server", "server");
    std::string host = "0.0.0.0";
    int port = 8080;
    if (const auto pos = cfg.listen.rfind(':'); pos != std::string::npos) {
      host = cfg.listen.substr(0, pos);
      port = std::stoi(cfg.listen.substr(pos + 1));
    }
    if (auto value = string_attr(*server, "listen_host", "server")) host = *value;
    if (auto value = int_attr(*server, "listen_port", "server")) {
      if (*value < 1 || *value > 65535) throw std::runtime_error("server.listen_port must be between 1 and 65535, not " + std::to_string(*value));
      port = static_cast<int>(*value);
    }
    if (host.empty()) throw std::runtime_error("server.listen_host cannot be empty");
    cfg.listen = host + ":" + std::to_string(port);
    if (server->attrs.count("listen_host") != 0 || server->attrs.count("listen_port") != 0) cfg.value_sources["server.listen"] = "file";
  }

  if (const auto* query = optional_block(root, "query", source)) {
    if (auto v = string_attr(*query, "describe_mode", "query")) {
      cfg.query_options.describe_mode = parse_describe_mode(*v);
      cfg.value_sources["query.describe_mode"] = "file";
    }
  }

  if (const auto* explorer = optional_block(root, "explorer", source)) {
    validate_blocks(*explorer, "explorer", {"graph", "operations"});
    config::apply_block(cfg, *explorer, "explorer", "explorer");
    if (const auto* graph = optional_block(*explorer, "graph", "explorer")) {
      validate_blocks(*graph, "explorer.graph", {});
      config::apply_block(cfg, *graph, "explorer.graph", "explorer.graph");
    }
    // v2.14.0's Server operations switches are now the System page's Activity and Keeper. enabled = false removes both, as it removed both routes then.
    // keeper = false removes the Keeper only. This block is an older form of system.activity and system.keeper.
    // A system { } block with it is an error. The two blocks say the same thing in two places.
    if (const auto* operations = optional_block(*explorer, "operations", "explorer")) {
      validate_object(*operations, "explorer.operations", {"enabled", "keeper"}, {});
      if (root.blocks.count("system") != 0) {
        throw std::runtime_error("explorer.operations and the system block are both in the file: remove explorer.operations and use system.activity and system.keeper");
      }
      const auto enabled = bool_attr(*operations, "enabled", "explorer.operations");
      const auto keeper = bool_attr(*operations, "keeper", "explorer.operations");
      if (enabled && !*enabled && keeper && *keeper) {
        throw std::runtime_error("explorer.operations.enabled = false and explorer.operations.keeper = true contradict each other: enabled = false removes the Keeper too");
      }
      if (enabled && !*enabled) {
        cfg.system.activity = false;
        cfg.system.keeper = false;
        cfg.value_sources["system.activity"] = "file";
        cfg.value_sources["system.keeper"] = "file";
      }
      if (keeper) {
        cfg.system.keeper = cfg.system.keeper && *keeper;
        cfg.value_sources["system.keeper"] = "file";
      }
    }
  }

  if (const auto* system = optional_block(root, "system", source)) {
    validate_blocks(*system, "system", {});
    config::apply_block(cfg, *system, "system", "system");
  }

  load_observability(cfg, root, source);

  load_query_libraries(cfg, root);

  load_hosts(cfg, root, source);
  load_mcp(cfg, root, source);
  load_access(cfg, root, source);
  load_telemetry(cfg, root, source);
}

} // namespace

AppConfig load_config_from_file(const std::string& path) {
  if (path.empty()) throw std::runtime_error("--config path cannot be empty");
  AppConfig cfg = config::default_config();
  const HclObject root = parse_hcl(read_text_file(path));
  apply_full_hcl(cfg, root, path);
  finish_config(cfg);
  set_version_info(cfg);
  return cfg;
}

} // namespace chdash
