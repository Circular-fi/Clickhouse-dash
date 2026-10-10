// libFuzzer target: the HCL parser of the configuration file (src/hcl.cpp).
//
// The only failure the parser may report is HclParseError (main prints it with its line): any other exception, a
// crash or a stack overflow is a finding. A parsed object is walked with the typed getters of the config loader.
#include "hcl.hpp"

#include <cstdint>
#include <cstdlib>
#include <string_view>

namespace {

void walk(const chdash::HclObject& object, int depth) {
  if (depth > 10000) std::abort();
  for (const auto& [key, value] : object.attrs) {
    (void)chdash::hcl_get_string(object, key);
    (void)chdash::hcl_get_int(object, key);
    (void)chdash::hcl_get_bool(object, key);
    (void)chdash::hcl_get_string_list(object, key);
    (void)value;
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
