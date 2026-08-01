#pragma once

#include <cctype>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace chdash {

// Minimal HCL subset parser.
// Supported grammar (sufficient for the complete application config):
//   - Blocks:  ident "{" ... "}"
//   - Assignments: ident "=" (string|number|bool)
//   - Repeated blocks with same name (stored as vector)
//   - Comments: # ... EOL, // ... EOL
//
// This is NOT a full HCL parser.

struct HclValue {
  using V = std::variant<std::string, int64_t, bool>;
  V v;

  bool is_string() const { return std::holds_alternative<std::string>(v); }
  bool is_int() const { return std::holds_alternative<int64_t>(v); }
  bool is_bool() const { return std::holds_alternative<bool>(v); }

  const std::string& as_string() const { return std::get<std::string>(v); }
  int64_t as_int() const { return std::get<int64_t>(v); }
  bool as_bool() const { return std::get<bool>(v); }
};

struct HclObject {
  std::unordered_map<std::string, HclValue> attrs;
  std::unordered_map<std::string, std::vector<HclObject>> blocks;
};

struct HclParseError : public std::runtime_error {
  using std::runtime_error::runtime_error;
};

HclObject parse_hcl(std::string_view src);

// Helpers
std::optional<std::string> hcl_get_string(const HclObject& o, const std::string& key);
std::optional<int64_t> hcl_get_int(const HclObject& o, const std::string& key);
std::optional<bool> hcl_get_bool(const HclObject& o, const std::string& key);

} // namespace chdash
