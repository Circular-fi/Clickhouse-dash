#include "config_schema.hpp"

#include "ch_uri.hpp"
#include "telemetry_settings.hpp"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <type_traits>

namespace chdash {
namespace config {
namespace {

enum class Kind { Int, Bool, String, Enum, Custom };

struct Row {
  KeyInfo info;
  Kind kind = Kind::Custom;
  int64_t min = 0;
  int64_t max = 0;
  bool zero = false;
  std::vector<std::string> choices;
  // The field of the configuration, read and written through the same reference.
  std::function<int64_t(AppConfig&)> get_int;
  std::function<void(AppConfig&, int64_t)> set_int;
  std::function<bool(AppConfig&)> get_bool;
  std::function<void(AppConfig&, bool)> set_bool;
  std::function<std::string(AppConfig&)> get_string;
  std::function<void(AppConfig&, const std::string&)> set_string;
};

std::string join(const std::vector<std::string>& items, const char* separator) {
  std::string out;
  for (size_t i = 0; i < items.size(); ++i) out += (i ? separator : "") + items[i];
  return out;
}

std::vector<std::string> split_choices(const std::string& text) {
  std::vector<std::string> out;
  size_t begin = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i == text.size() || text[i] == '|') {
      out.push_back(text.substr(begin, i - begin));
      begin = i + 1;
    }
  }
  return out;
}

template <typename T>
Row int_row(const char* block, const char* key, T& (*ref)(AppConfig&), const char* declared, int64_t min, int64_t max, bool zero,
            const char* unit, const char* doc) {
  static_assert(std::is_integral_v<T>, "an integer field");
  Row row;
  row.kind = Kind::Int;
  row.min = min;
  row.max = max;
  row.zero = zero;
  row.get_int = [ref](AppConfig& c) { return static_cast<int64_t>(ref(c)); };
  row.set_int = [ref](AppConfig& c, int64_t value) { ref(c) = static_cast<T>(value); };
  row.info = {block, key, "integer", "", "", unit, doc, false, declared};
  return row;
}

Row bool_row(const char* block, const char* key, bool& (*ref)(AppConfig&), const char* declared, const char* doc) {
  Row row;
  row.kind = Kind::Bool;
  row.get_bool = [ref](AppConfig& c) { return ref(c); };
  row.set_bool = [ref](AppConfig& c, bool value) { ref(c) = value; };
  row.info = {block, key, "boolean", "", "", "", doc, false, declared};
  return row;
}

Row string_row(const char* block, const char* key, std::string& (*ref)(AppConfig&), const char* declared, const char* doc) {
  Row row;
  row.kind = Kind::String;
  row.get_string = [ref](AppConfig& c) { return ref(c); };
  row.set_string = [ref](AppConfig& c, const std::string& value) { ref(c) = value; };
  row.info = {block, key, "text", "", "", "", doc, false, declared};
  return row;
}

Row enum_row(const char* block, const char* key, std::string& (*ref)(AppConfig&), const char* declared, const char* choices,
             const char* doc) {
  Row row = string_row(block, key, ref, declared, doc);
  row.kind = Kind::Enum;
  row.choices = split_choices(choices);
  row.info.type = std::string("one of ") + choices;
  return row;
}

Row custom_row(const char* block, const char* key, const char* type, const char* def, const char* range, const char* doc) {
  Row row;
  row.kind = Kind::Custom;
  row.info = {block, key, type, def, range, "", doc, true, def};
  return row;
}

const std::vector<Row>& rows() {
  static const std::vector<Row> table = [] {
    std::vector<Row> out;
#define CFG_INT(BLOCK, KEY, TYPE, FIELD, DEFAULT, MIN, MAX, ZERO, UNIT, DOC) \
    out.push_back(int_row<TYPE>(BLOCK, KEY, [](AppConfig& c) -> TYPE& { return FIELD; }, DEFAULT, MIN, MAX, ZERO, UNIT, DOC));
#define CFG_BOOL(BLOCK, KEY, FIELD, DEFAULT, DOC) \
    out.push_back(bool_row(BLOCK, KEY, [](AppConfig& c) -> bool& { return FIELD; }, DEFAULT, DOC));
#define CFG_STRING(BLOCK, KEY, FIELD, DEFAULT, DOC) \
    out.push_back(string_row(BLOCK, KEY, [](AppConfig& c) -> std::string& { return FIELD; }, DEFAULT, DOC));
#define CFG_ENUM(BLOCK, KEY, FIELD, DEFAULT, CHOICES, DOC) \
    out.push_back(enum_row(BLOCK, KEY, [](AppConfig& c) -> std::string& { return FIELD; }, DEFAULT, CHOICES, DOC));
#define CFG_CUSTOM(BLOCK, KEY, TYPE, DEF, RANGE, DOC) out.push_back(custom_row(BLOCK, KEY, TYPE, DEF, RANGE, DOC));
#include "config_keys.def"
#undef CFG_INT
#undef CFG_BOOL
#undef CFG_STRING
#undef CFG_ENUM
#undef CFG_CUSTOM
    // The defaults as the code has them (a configuration that no file changed; tests/native/config_test.cpp compares them
    // with the declared ones), and the ranges as text.
    AppConfig defaults = default_config();
    for (Row& row : out) {
      switch (row.kind) {
        case Kind::Int:
          row.info.def = std::to_string(row.get_int(defaults));
          row.info.range = (row.zero ? "0 or " : "") + std::to_string(row.min) + " to " + std::to_string(row.max);
          break;
        case Kind::Bool:
          row.info.def = row.get_bool(defaults) ? "true" : "false";
          break;
        case Kind::String:
          row.info.def = row.get_string(defaults);
          break;
        case Kind::Enum:
          row.info.def = row.get_string(defaults);
          break;
        case Kind::Custom:
          break;
      }
    }
    return out;
  }();
  return table;
}

const Row* find_row(const std::string& block, const std::string& key) {
  for (const Row& row : rows()) {
    if (row.info.block == block && row.info.key == key) return &row;
  }
  return nullptr;
}

} // namespace

AppConfig default_config() {
  AppConfig cfg;
  // The interactive preview default is explicit in the file path: it is the one that a start with a file gets.
  cfg.result_preview_row_limit = 10000;
  return cfg;
}

const std::vector<KeyInfo>& schema() {
  static const std::vector<KeyInfo> infos = [] {
    std::vector<KeyInfo> out;
    for (const Row& row : rows()) out.push_back(row.info);
    return out;
  }();
  return infos;
}

std::vector<std::string> keys_of(const std::string& block) {
  std::vector<std::string> out;
  for (const Row& row : rows()) {
    if (row.info.block == block) out.push_back(row.info.key);
  }
  return out;
}

void apply_block(AppConfig& cfg, const HclObject& object, const std::string& block, const std::string& context,
                 std::initializer_list<const char*> extra_known, std::vector<std::string>* set_keys) {
  for (const auto& item : object.attrs) {
    const std::string& name = item.first;
    const HclValue& value = item.second;
    const std::string where = context + "." + name;
    const Row* row = find_row(block, name);
    if (!row) {
      if (std::find_if(extra_known.begin(), extra_known.end(), [&](const char* known) { return name == known; }) != extra_known.end()) continue;
      throw std::runtime_error(context + ": unknown attribute " + name);
    }
    if (row->kind == Kind::Custom) continue;  // config.cpp reads it
    switch (row->kind) {
      case Kind::Int: {
        if (!value.is_int()) throw std::runtime_error(where + " must be an integer, not " + hcl_value_text(value));
        const int64_t v = value.as_int();
        const bool zero_ok = row->zero && v == 0;
        if (!zero_ok && (v < row->min || v > row->max)) {
          throw std::runtime_error(where + " must be " + (row->zero ? "0 or " : "") + "between " + std::to_string(row->min) + " and " +
                                   std::to_string(row->max) + ", not " + std::to_string(v) +
                                   (row->info.unit.empty() ? std::string() : " (" + row->info.unit + ")"));
        }
        row->set_int(cfg, v);
        break;
      }
      case Kind::Bool:
        if (!value.is_bool()) throw std::runtime_error(where + " must be a boolean, not " + hcl_value_text(value));
        row->set_bool(cfg, value.as_bool());
        break;
      case Kind::String:
        if (!value.is_string()) throw std::runtime_error(where + " must be a string, not " + hcl_value_text(value));
        row->set_string(cfg, value.as_string());
        break;
      case Kind::Enum: {
        if (!value.is_string()) throw std::runtime_error(where + " must be a string, not " + hcl_value_text(value));
        const auto& choices = row->choices;
        if (std::find(choices.begin(), choices.end(), value.as_string()) == choices.end()) {
          throw std::runtime_error(where + " must be " + join(choices, ", ") + ", not " + hcl_value_text(value));
        }
        row->set_string(cfg, value.as_string());
        break;
      }
      case Kind::Custom:
        break;
    }
    if (set_keys) set_keys->push_back(name);
    else cfg.value_sources[block + "." + name] = "file";
  }
}

namespace {

std::string quote_text(const std::string& text) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out = "\"";
  for (const unsigned char c : text) {
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c < 0x20 || c == 0x7f) {
      out += "\\u00";
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0f]);
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  out.push_back('"');
  return out;
}

std::string list_text(const std::vector<std::string>& items) {
  std::string out = "[";
  for (size_t i = 0; i < items.size(); ++i) out += (i ? ", " : "") + quote_text(items[i]);
  return out + "]";
}

class Collector {
 public:
  explicit Collector(const AppConfig& cfg) : cfg_(cfg) {}

  // A value that the file may give: its source is "file" or an indirect form that the load noted, or "default".
  void add(const std::string& name, std::string value) {
    const auto found = cfg_.value_sources.find(name);
    out_.push_back({name, std::move(value), found == cfg_.value_sources.end() ? "default" : found->second});
  }
  // A value that the file always gives (a required attribute).
  void add_from_file(const std::string& name, std::string value) { out_.push_back({name, std::move(value), "file"}); }
  // A secret: its value is never shown.
  void add_secret(const std::string& name) {
    const auto found = cfg_.value_sources.find(name);
    if (found == cfg_.value_sources.end()) out_.push_back({name, "<none>", "default"});
    else out_.push_back({name, "<hidden>", found->second});
  }
  std::vector<EffectiveValue> take() { return std::move(out_); }

 private:
  const AppConfig& cfg_;
  std::vector<EffectiveValue> out_;
};

std::string uri_text(const std::string& uri) { return redact_clickhouse_uri(uri); }

} // namespace

std::vector<EffectiveValue> effective_config(const AppConfig& cfg) {
  AppConfig copy = cfg;  // the rows read through a reference that can write
  Collector out(cfg);
  out.add("server.listen", cfg.listen);
  out.add("query.describe_mode", cfg.query_options.describe_mode == QueryDescribeMode::Always  ? "always"
                                 : cfg.query_options.describe_mode == QueryDescribeMode::Never ? "never"
                                                                                                : "auto");
  for (const Row& row : rows()) {
    const std::string name = row.info.block + "." + row.info.key;
    // The blocks that can appear more than once are written below, one entry for each block of the file.
    if (row.info.block == "query_library" || row.info.block == "clickhouse.host" || row.info.block.rfind("clickhouse.host.", 0) == 0 ||
        row.info.block == "mcp.key" || row.info.block.rfind("mcp.mcp_key", 0) == 0) {
      continue;
    }
    switch (row.kind) {
      case Kind::Int: out.add(name, std::to_string(row.get_int(copy))); break;
      case Kind::Bool: out.add(name, row.get_bool(copy) ? "true" : "false"); break;
      case Kind::String:
      case Kind::Enum: out.add(name, row.get_string(copy)); break;
      case Kind::Custom:
        if (name == "observability.service_allowlist") out.add(name, list_text(cfg.otel_defaults.traces.service_allowlist));
        else if (name == "observability.traces.highlighted_attributes") out.add(name, list_text(cfg.otel_defaults.traces.highlighted_attributes));
        else if (name == "mcp.auth_header") out.add(name, cfg.mcp.auth_header);
        else if (name == "mcp.allowed_origins") out.add(name, list_text(cfg.mcp.allowed_origins));
        else if (name == "mcp.keys.mode") out.add(name, mcp_keys_mode_name(cfg.mcp.keys_mode));
        // The endpoint with its source (file, env:VAR or file:/path); its _env and _file forms have no entry of their own.
        else if (name == "telemetry.otlp_endpoint") out.add(name, cfg.telemetry.otlp_endpoint);
        else if (name == "telemetry.export_interval") out.add(name, duration_text(cfg.telemetry.export_interval_ms));
        else if (name == "telemetry.export_timeout") out.add(name, duration_text(cfg.telemetry.export_timeout_ms));
        else if (name == "telemetry.connect_timeout") out.add(name, duration_text(cfg.telemetry.connect_timeout_ms));
        else if (name == "access.mode") out.add(name, cfg.access.enforced() ? "authzen" : "open");
        // The open mode has no identity and no PDP: their keys have no value.
        else if (name.rfind("access.", 0) == 0 && !cfg.access.enforced()) break;
        else if (name == "access.identity.header") out.add(name, cfg.access.header);
        else if (name == "access.identity.issuer") out.add(name, cfg.access.issuer);
        else if (name == "access.identity.audience") out.add(name, cfg.access.audience);
        // The keys are not secret: their type and their JWK thumbprint (the kid of the tokens).
        else if (name == "access.identity.public_keys") {
          std::vector<std::string> keys;
          for (const IdentityKey& key : cfg.access.keys) keys.push_back(std::string(identity_key_type_name(key.type)) + " kid=" + key.kid);
          out.add(name, list_text(keys));
        }
        else if (name == "access.identity.max_age") out.add(name, duration_text(cfg.access.max_age_ms));
        else if (name == "access.pdp.url") out.add(name, cfg.access.pdp_url);
        else if (name == "access.pdp.token_env") out.add_secret("access.pdp.token");
        else if (name == "access.pdp.timeout") out.add(name, duration_text(cfg.access.pdp_timeout_ms));
        else if (name == "access.pdp.cache_ttl") out.add(name, duration_text(cfg.access.pdp_cache_ttl_ms));
        break;
    }
  }

  // The hosts. A URI shows with the password hidden; the password has its own entries.
  for (const HostSpec& host : cfg.hosts) {
    const std::string p = "clickhouse.host[" + host.id + "].";
    out.add_from_file(p + "name", host.id);
    out.add(p + "label", host.label);
    out.add_from_file(p + "runner_uri", uri_text(host.runner_uri));
    out.add_secret(p + "runner_password");
    out.add_from_file(p + "system_uri", uri_text(host.system_uri));
    out.add_secret(p + "system_password");
    if (!host.mcp_uri.empty()) {
      out.add_from_file(p + "mcp_uri", uri_text(host.mcp_uri));
      out.add_secret(p + "mcp_password");
    }
    const OtelHostOverride& o = host.otel_override;
    const auto flag = [&](const char* name, const std::optional<bool>& v) { if (v) out.add_from_file(p + name, *v ? "true" : "false"); };
    const auto text = [&](const char* name, const std::optional<std::string>& v) { if (v) out.add_from_file(p + name, *v); };
    flag("observability.traces.enabled", o.traces_enabled);
    text("observability.traces.database", o.traces_database);
    text("observability.traces.table", o.traces_table);
    text("observability.traces.trace_index_table", o.traces_index_table);
    flag("observability.logs.enabled", o.logs_enabled);
    text("observability.logs.database", o.logs_database);
    text("observability.logs.table", o.logs_table);
    flag("observability.metrics.enabled", o.metrics_enabled);
    text("observability.metrics.database", o.metrics_database);
    text("observability.metrics.table_prefix", o.metrics_table_prefix);
  }

  // The libraries that are on, in the order of the file.
  for (const QueryLibrarySettings& library : cfg.query_libraries) {
    const std::string p = "query_library[" + library.name + "].";
    out.add(p + "enabled", library.enabled ? "true" : "false");
    out.add(p + "name", library.name);
    out.add(p + "file", library.file);
    out.add(p + "writable", library.writable ? "true" : "false");
    out.add(p + "max_file_bytes", std::to_string(library.max_file_bytes));
    out.add(p + "max_query_bytes", std::to_string(library.max_query_bytes));
  }

  // The keys of the file. The token is never shown, only where it comes from. A key of the older block (key { }) has its
  // names: mcp.key[name].secret and the attributes at the top of the block.
  for (const McpKey& key : cfg.mcp.keys) {
    const std::string p_new = "mcp.mcp_key[" + key.name + "].";
    if (cfg.value_sources.count(p_new + "token") != 0) {
      out.add_secret(p_new + "token");
      out.add(p_new + "subject", key.subject);
      out.add(p_new + "tools", list_text(key.tools));
      out.add(p_new + "expires", key.expires_at ? mcp_iso_utc(*key.expires_at) : std::string());
      out.add(p_new + "scope.hosts", list_text(key.hosts));
      out.add(p_new + "scope.databases", list_text(key.databases));
      out.add(p_new + "limits.max_rows", std::to_string(key.max_rows.value_or(cfg.mcp.max_rows)));
      out.add(p_new + "limits.timeout_seconds", std::to_string(key.timeout_seconds.value_or(cfg.mcp.query_timeout_seconds)));
      out.add(p_new + "limits.rate_limit_per_minute", std::to_string(key.rate_limit_per_minute.value_or(cfg.mcp.rate_limit_per_minute)));
      continue;
    }
    const std::string p = "mcp.key[" + key.name + "].";
    out.add_from_file(p + "name", key.name);
    out.add_secret(p + "secret");
    out.add_from_file(p + "hosts", list_text(key.hosts));
    out.add(p + "tools", list_text(key.tools));
    out.add(p + "databases", list_text(key.databases));
    out.add(p + "max_rows", std::to_string(key.max_rows.value_or(cfg.mcp.max_rows)));
    out.add(p + "timeout_seconds", std::to_string(key.timeout_seconds.value_or(cfg.mcp.query_timeout_seconds)));
  }
  return out.take();
}

std::vector<std::pair<std::string, std::string>> effective_values(const AppConfig& cfg) {
  std::vector<std::pair<std::string, std::string>> out;
  for (auto& value : effective_config(cfg)) out.emplace_back(std::move(value.name), std::move(value.value));
  return out;
}

} // namespace config
} // namespace chdash
