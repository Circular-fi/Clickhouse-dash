#include "config_schema.hpp"

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
                 std::initializer_list<const char*> extra_known) {
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
        if (!value.is_int()) throw std::runtime_error(where + " must be an integer");
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
        if (!value.is_bool()) throw std::runtime_error(where + " must be a boolean");
        row->set_bool(cfg, value.as_bool());
        break;
      case Kind::String:
        if (!value.is_string()) throw std::runtime_error(where + " must be a string");
        row->set_string(cfg, value.as_string());
        break;
      case Kind::Enum: {
        if (!value.is_string()) throw std::runtime_error(where + " must be a string");
        const auto& choices = row->choices;
        if (std::find(choices.begin(), choices.end(), value.as_string()) == choices.end()) {
          throw std::runtime_error(where + " must be " + join(choices, ", ") + ", not \"" + value.as_string() + "\"");
        }
        row->set_string(cfg, value.as_string());
        break;
      }
      case Kind::Custom:
        break;
    }
  }
}

std::vector<std::pair<std::string, std::string>> effective_values(const AppConfig& cfg) {
  AppConfig copy = cfg;  // the rows read through a reference that can write
  std::vector<std::pair<std::string, std::string>> out;
  out.emplace_back("server.listen", cfg.listen);
  out.emplace_back("query.describe_mode",
                   cfg.query_options.describe_mode == QueryDescribeMode::Always  ? "always"
                   : cfg.query_options.describe_mode == QueryDescribeMode::Never ? "never"
                                                                                  : "auto");
  for (const Row& row : rows()) {
    const std::string name = row.info.block + "." + row.info.key;
    switch (row.kind) {
      case Kind::Int: out.emplace_back(name, std::to_string(row.get_int(copy))); break;
      case Kind::Bool: out.emplace_back(name, row.get_bool(copy) ? "true" : "false"); break;
      case Kind::String:
      case Kind::Enum: out.emplace_back(name, row.get_string(copy)); break;
      case Kind::Custom: break;
    }
  }
  return out;
}

} // namespace config
} // namespace chdash
