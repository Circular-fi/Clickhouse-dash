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
// The supported grammar is enough for the complete application configuration:
//   - Blocks:  ident "{" ... "}"  (at most 16 levels deep)
//   - A block with one label: ident "label" "{" ... "}". The parser keeps the label.
//     The configuration loader refuses a label on each block that does not take one (config.cpp).
//   - Assignments: ident "=" (string|integer|bool|string-list)
//   - Repeated blocks with the same name are stored as a vector.
//   - Strings in double quotes, with the escapes \" \\ \n \r \t \uXXXX \UXXXXXXXX. A string holds no line break.
//   - Comments: # ... EOL, // ... EOL, /* ... */
//
// This is NOT a full HCL parser. These forms are not supported. The parser refuses each one with an error:
// two labels or more on a block (a "b" "c" { }), numbers with a fraction, an exponent or a digit separator,
// heredoc strings, and expressions. An error names the line and the column.

struct HclValue {
  using V = std::variant<std::string, int64_t, bool, std::vector<std::string>>;
  V v;

  bool is_string() const { return std::holds_alternative<std::string>(v); }
  bool is_int() const { return std::holds_alternative<int64_t>(v); }
  bool is_bool() const { return std::holds_alternative<bool>(v); }
  bool is_string_list() const { return std::holds_alternative<std::vector<std::string>>(v); }

  const std::string& as_string() const { return std::get<std::string>(v); }
  int64_t as_int() const { return std::get<int64_t>(v); }
  bool as_bool() const { return std::get<bool>(v); }
  const std::vector<std::string>& as_string_list() const { return std::get<std::vector<std::string>>(v); }
};

struct HclObject {
  std::unordered_map<std::string, HclValue> attrs;
  std::unordered_map<std::string, std::vector<HclObject>> blocks;
  // The label of the block (mcp_key "name" { }). `labeled` is false for a block without a label.
  bool labeled = false;
  std::string label;
};

struct HclParseError : public std::runtime_error {
  using std::runtime_error::runtime_error;
};

HclObject parse_hcl(std::string_view src);

// This function gives the value as an error message shows it: "text", 5, true or ["a", "b"]. A text of more than 80 bytes is truncated.
// Never call it for a secret.
std::string hcl_value_text(const HclValue& value);

} // namespace chdash
