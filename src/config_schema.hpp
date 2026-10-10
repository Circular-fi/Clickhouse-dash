#pragma once

// The settings of the configuration file as a table (config_keys.def): the one place that knows the type, the bounds, the
// default and the description of a key. config.cpp reads each block of the file through it; main.cpp writes the values
// that apply at the start; tools/gen_config_reference.py writes docs/configuration-reference.md from it.
//
// A value outside its bounds stops the start with an error that names the key and says what is allowed. Nothing is
// clamped: the value in the file is the value that applies, or the process does not start.

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

// Every key of the table, in the order of the file; the default is the one of a configuration with no file.
const std::vector<KeyInfo>& schema();

// The configuration of a start with no file at all (the defaults of the table).
AppConfig default_config();

// The keys of `block` (a path such as "server") that `object` holds, set in `cfg`. A key that the table does not know for the
// block, and that `extra_known` does not name (a key that the caller reads), is an error; so is a value of the wrong type
// or outside its bounds. `object` is the body of the block; `context` names it in an error (the block of an older
// configuration has another name than its path).
void apply_block(AppConfig& cfg, const HclObject& object, const std::string& block, const std::string& context,
                 std::initializer_list<const char*> extra_known = {});

// The attribute names that the table has for `block`, to build the list of allowed names.
std::vector<std::string> keys_of(const std::string& block);

// What applies, as "block.key" and text: every key of the table, then the keys that code reads (listen, describe_mode).
// Used by the log line of the start and by --print-config.
std::vector<std::pair<std::string, std::string>> effective_values(const AppConfig& cfg);

} // namespace config
} // namespace chdash
