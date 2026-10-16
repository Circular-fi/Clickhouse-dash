// libFuzzer target: the HCL parser of the configuration file (src/hcl.cpp).
//
// The only failure that the parser may report is HclParseError. The main function prints it with its line.
// Any other exception, a crash or a stack overflow is a finding. A parsed object is walked with the typed readers of the config loader.
#include "hcl.hpp"

#include <cstdint>
#include <cstdlib>
#include <string_view>

namespace {

void walk(const chdash::HclObject& object, int depth) {
  // The parser refuses blocks nested more than 16 levels deep.
  if (depth > 16) std::abort();
  for (const auto& [key, value] : object.attrs) {
    (void)key;
    if (value.is_string()) (void)value.as_string();
    if (value.is_int()) (void)value.as_int();
    if (value.is_bool()) (void)value.as_bool();
    if (value.is_string_list()) (void)value.as_string_list();
  }
  for (const auto& [name, blocks] : object.blocks) {
    (void)name;
    for (const auto& block : blocks) walk(block, depth + 1);
  }
}

}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string_view text(reinterpret_cast<const char*>(data), size);
  try {
    walk(chdash::parse_hcl(text), 0);
  } catch (const chdash::HclParseError&) {
  }
  return 0;
}
