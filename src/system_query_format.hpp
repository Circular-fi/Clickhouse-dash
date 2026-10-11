#pragma once

// The formatted text of a query shape (docs/system.md, "Queries"). A shape's text is normalizeQuery's: its literals are `?` and its lists
// `?..`, which no SQL parser accepts. The formatter (format_service.hpp) gets a numeric literal in their place (a normalized query has no
// number of its own in the range of the masks), and the placeholders come back after it; the AS column that the formatter aligned keeps
// its alignment. Quoted text and comments are left alone. This unit has no I/O: the formatter is the caller's (a function), so the rules
// are tested without ClickHouse.

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

// The masked text, or nothing when it cannot be masked: more placeholders than kShapeMaskMax, or a number of the range of the masks
// already in the text (it could not be told from a stand-in).
std::optional<ShapeMask> mask_shape_placeholders(std::string_view normalized);

// The formatted text with its placeholders back, or nothing when the formatter did not keep every one of them exactly once. A line that gives
// width back (a placeholder is shorter than its stand-in) gives it to the padding of the AS column of that line.
std::optional<std::string> restore_shape_placeholders(std::string_view formatted, const std::vector<std::string>& marks);

// What the formatter said of a masked text: its text, or nothing. `transient`: the failure is not the text's (the host is down, the time
// ran out, ClickHouse refused), so the same text may be formatted a moment later.
struct ShapeFormatReply {
  std::optional<std::string> text;
  bool transient = false;
};
using ShapeFormatFn = std::function<ShapeFormatReply(const std::string& masked_sql)>;

enum class ShapeFormatStatus {
  Formatted,
  // The text cannot be formatted, and will not be (no text, too many placeholders, a number of the masks in it, a text that the formatter
  // refuses or that it did not lay out, a placeholder that did not come back): the answer is the raw text.
  Unformattable,
  // The formatter could not be asked: not kept.
  Transient,
};

struct ShapeFormat {
  ShapeFormatStatus status = ShapeFormatStatus::Unformattable;
  std::string text;  // Formatted only
};

// The normalized text of a shape, formatted. `format` is called at most once, with the masked text.
ShapeFormat format_shape_text(std::string_view normalized, const ShapeFormatFn& format);

// What the cache of the service keeps for a text: the formatted text, or that it cannot be formatted.
struct ShapeFormatted {
  bool formatted = false;
  std::string text;
};

}  // namespace system_page
}  // namespace chdash
