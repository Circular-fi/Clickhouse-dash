#pragma once

// The settings of the configuration file are a table (config_keys.def).
// This table is the one place that knows the type, the bounds, the default and the description of a key.
// config.cpp reads each block of the file through this table.
// main.cpp writes the values that apply at start.
// tools/gen_config_reference.py writes docs/configuration-reference.md from this table.
//
// A value outside its bounds stops the start. The error names the key and says what is allowed.
// Nothing is clamped. The value in the file is the value that applies. Otherwise the process does not start.

#include "hcl.hpp"
#include "server.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {
namespace config {

struct KeyInfo {
  std::string block;  // "server", "observability.traces"
  std::string key;
  std::string type;   // "integer", "boolean", "text", "one of a|b|c", "list of texts"
  std::string def;    // the default, as text, read from AppConfig
  std::string range;  // "1 to 1024", "0 or 1 to 1024", "" when there is none
  std::string unit;   // "ms", "bytes", ""
  std::string doc;    // one sentence
  bool read_by_code = false;  // the key is read by config.cpp, not by apply_block()
  std::string declared_default;  // the default as the table says it (the reference prints it); it equals def
};

// Every key of the table, in the order of the file. The default is the value of a configuration with no file.
const std::vector<KeyInfo>& schema();

// The configuration for a start with no file at all. It uses the defaults of the table.
AppConfig default_config();

// The keys of `block` (a path such as "server") that `object` holds are set in `cfg`.
// A key that the table does not know for the block is an error. So is a key that `extra_known` does not name (a key that the caller reads).
// A value of the wrong type or outside its bounds is also an error.
// The error names the key, what it must be and the value.
//
// `object` is the body of the block. `context` names the block in an error. The block of an older configuration has another name than its path.
// The call notes each key that it sets in `cfg.value_sources`, with the source "file".
//
// With `set_keys`, the call gives the names of these keys to the caller instead. Use this for a block that can appear more than once. The caller knows its name.
void apply_block(AppConfig& cfg, const HclObject& object, const std::string& block, const std::string& context,
                 std::initializer_list<const char*> extra_known = {}, std::vector<std::string>* set_keys = nullptr);

// The table gives the attribute names for `block`. The list of allowed names uses these names.
std::vector<std::string> keys_of(const std::string& block);

// One value that applies. `name` is "block.key".
// For a block that can appear more than once, `name` is, for example, "clickhouse.host[prod].runner_uri", "mcp.key[ci].hosts" or "query_library[team].file".
// `value` hides the secrets. A secret shows as <hidden>, or as <none> when it is not set. A password in a URI shows as ***.
//
// `source` is "file" when the file gives the value. It is "env:VAR" for the variable VAR.
// It is "file:/path" for the file at that path. It is "default" when the program gives the value.
struct EffectiveValue {
  std::string name;
  std::string value;
  std::string source;
};

// Everything that applies, in a fixed order. The order is: the keys of the table, then the keys that code reads (listen, describe_mode, the allowlist of services, the highlighted attributes).
// Then come each host, each library and each MCP key of the file.
// The start log line and --print-config use this list.
std::vector<EffectiveValue> effective_config(const AppConfig& cfg);

// The same list, without the sources: "block.key" and the text.
std::vector<std::pair<std::string, std::string>> effective_values(const AppConfig& cfg);

} // namespace config
} // namespace chdash
