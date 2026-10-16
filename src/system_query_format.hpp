#pragma once

// This unit formats the text of a query shape. See docs/system.md, "Queries".
// The text of a shape is the output of normalizeQuery. Its literals are `?`, and its lists are `?..`. No SQL parser accepts these placeholders.
//
// The formatter (format_service.hpp) gets a numeric literal in place of each placeholder.
// A normalized query has no number of its own in the range of the masks. After the format step, the placeholders come back.
// The AS column that the formatter aligned keeps its alignment. Quoted text and comments are left alone.
//
// This unit has no I/O. The caller supplies the formatter as a function. The rules are tested without ClickHouse.

#include <cstddef>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {
namespace system_page {

// The first stand-in, and how many there can be: 90900 .. 99899, five digits that start with 9.
constexpr int kShapeMaskBase = 90900;
constexpr size_t kShapeMaskMax = 9000;

struct ShapeMask {
  // The text with a number for each placeholder: the k-th one (from 0) is kShapeMaskBase + k.
  std::string sql;
  // The placeholder of each number: "?" or "?..".
  std::vector<std::string> marks;
};

// The masked text. Nothing is returned when the text cannot be masked.
// This happens when there are more placeholders than kShapeMaskMax. It also happens when the text already has a number of the range of the masks.
// Such a number cannot be told from a stand-in.
std::optional<ShapeMask> mask_shape_placeholders(std::string_view normalized);

// The formatted text, with its placeholders back. Nothing is returned when the formatter did not keep every placeholder exactly once.
// A placeholder is shorter than its stand-in. A line that gets this width back gives it to the padding of its AS column.
std::optional<std::string> restore_shape_placeholders(std::string_view formatted, const std::vector<std::string>& marks);

// This is what the formatter said of a masked text. The result is the text, or nothing.
// `transient` is set when the failure is not the text's fault. The host may be down, or the time may run out, or ClickHouse may refuse.
// The same text may then be formatted a moment later.
struct ShapeFormatReply {
  std::optional<std::string> text;
  bool transient = false;
};
using ShapeFormatFn = std::function<ShapeFormatReply(const std::string& masked_sql)>;

enum class ShapeFormatStatus {
  Formatted,
  // The text cannot be formatted, and it never will be.
  // Examples are: no text, too many placeholders, or a number of the masks in the text.
  //
  // The formatter can refuse a text, or it can fail to format it. A placeholder can also fail to come back.
  // The answer is the raw text.
  Unformattable,
  // The formatter cannot be asked. The result is not kept.
  Transient,
};

struct ShapeFormat {
  ShapeFormatStatus status = ShapeFormatStatus::Unformattable;
  std::string text;  // Formatted only
};

// The normalized text of a shape, formatted. The function calls `format` at most once, with the masked text.
ShapeFormat format_shape_text(std::string_view normalized, const ShapeFormatFn& format);

// This is what the cache of the service keeps for a text.
// It keeps the formatted text, or it keeps the fact that the text cannot be formatted.
struct ShapeFormatted {
  bool formatted = false;
  std::string text;
};

}  // namespace system_page
}  // namespace chdash
