#pragma once

#include <algorithm>
#include <cctype>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

struct SqlMaskResult {
  // Same byte length as the input. String/identifier/comment contents are
  // replaced with spaces while newlines are preserved. ASCII code outside
  // those regions is lower-cased to make cheap token scans deterministic.
  std::string code_lower;
  bool has_comments = false;
};

inline bool sql_is_ident_start(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return std::isalpha(c) != 0 || ch == '_';
}

inline bool sql_is_ident_continue(char ch) {
  const unsigned char c = static_cast<unsigned char>(ch);
  return std::isalnum(c) != 0 || ch == '_';
}

inline char sql_ascii_lower(char ch) {
  if (ch >= 'A' && ch <= 'Z') return static_cast<char>(ch - 'A' + 'a');
  return ch;
}

inline SqlMaskResult mask_sql_surface(std::string_view sql) {
  SqlMaskResult result;
  result.code_lower.assign(sql.size(), ' ');

  enum class State {
    Code,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
  };

  State state = State::Code;
  bool escaped = false;

  for (size_t i = 0; i < sql.size(); ++i) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    if (state == State::LineComment) {
      if (ch == '\n' || ch == '\r') {
        result.code_lower[i] = ch;
        state = State::Code;
      }
      continue;
    }

    if (state == State::BlockComment) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (ch == '*' && next == '/') {
        ++i;
      }
      if (ch == '*' && next == '/') state = State::Code;
      continue;
    }

    if (state == State::SingleQuote) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == '\'' && next == '\'') {
        ++i; // SQL doubled quote inside a literal.
        continue;
      }
      if (ch == '\'') state = State::Code;
      continue;
    }

    if (state == State::DoubleQuote) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch == '\\') {
        escaped = true;
        continue;
      }
      if (ch == '"' && next == '"') {
        ++i;
        continue;
      }
      if (ch == '"') state = State::Code;
      continue;
    }

    if (state == State::Backtick) {
      if (ch == '\n' || ch == '\r') result.code_lower[i] = ch;
      if (ch == '`' && next == '`') {
        ++i;
        continue;
      }
      if (ch == '`') state = State::Code;
      continue;
    }

    // Code state.
    if (ch == '\'') {
      state = State::SingleQuote;
      escaped = false;
      continue;
    }
    if (ch == '"') {
      state = State::DoubleQuote;
      escaped = false;
      continue;
    }
    if (ch == '`') {
      state = State::Backtick;
      continue;
    }
    if (ch == '-' && next == '-') {
      result.has_comments = true;
      state = State::LineComment;
      ++i;
      continue;
    }
    if (ch == '#') {
      result.has_comments = true;
      state = State::LineComment;
      continue;
    }
    if (ch == '/' && next == '*') {
      result.has_comments = true;
      state = State::BlockComment;
      ++i;
      continue;
    }

    result.code_lower[i] = sql_ascii_lower(ch);
  }

  return result;
}

// Return the first SQL keyword outside comments and quoted regions. The result
// is ASCII-lowercase and empty for a comment/whitespace-only buffer. This keeps
// statement classification correct for editor queries beginning with comments.
inline std::string sql_first_keyword_lower(std::string_view sql) {
  const auto masked = mask_sql_surface(sql);
  const std::string_view code(masked.code_lower);
  for (size_t i = 0; i < code.size();) {
    if (!sql_is_ident_start(code[i])) {
      ++i;
      continue;
    }
    const size_t start = i++;
    while (i < code.size() && sql_is_ident_continue(code[i])) ++i;
    return std::string(code.substr(start, i - start));
  }
  return {};
}

inline std::vector<std::pair<size_t, size_t>> sql_single_quoted_literal_ranges(
    std::string_view sql
) {
  std::vector<std::pair<size_t, size_t>> ranges;

  enum class State {
    Code,
    SingleQuote,
    DoubleQuote,
    Backtick,
    LineComment,
    BlockComment,
  };

  State state = State::Code;
  bool escaped = false;
  size_t literal_start = 0;

  for (size_t i = 0; i < sql.size(); ++i) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    switch (state) {
      case State::LineComment:
        if (ch == '\n' || ch == '\r') state = State::Code;
        continue;
      case State::BlockComment:
        if (ch == '*' && next == '/') {
          ++i;
          state = State::Code;
        }
        continue;
      case State::DoubleQuote:
        if (escaped) {
          escaped = false;
        } else if (ch == '\\') {
          escaped = true;
        } else if (ch == '"' && next == '"') {
          ++i;
        } else if (ch == '"') {
          state = State::Code;
        }
        continue;
      case State::Backtick:
        if (ch == '`' && next == '`') {
          ++i;
        } else if (ch == '`') {
          state = State::Code;
        }
        continue;
      case State::SingleQuote:
        if (escaped) {
          escaped = false;
        } else if (ch == '\\') {
          escaped = true;
        } else if (ch == '\'' && next == '\'') {
          ++i;
        } else if (ch == '\'') {
          ranges.emplace_back(literal_start, i + 1);
          state = State::Code;
        }
        continue;
      case State::Code:
        break;
    }

    if (ch == '-' && next == '-') {
      state = State::LineComment;
      ++i;
    } else if (ch == '#') {
      state = State::LineComment;
    } else if (ch == '/' && next == '*') {
      state = State::BlockComment;
      ++i;
    } else if (ch == '"') {
      state = State::DoubleQuote;
      escaped = false;
    } else if (ch == '`') {
      state = State::Backtick;
    } else if (ch == '\'') {
      state = State::SingleQuote;
      escaped = false;
      literal_start = i;
    }
  }

  return ranges;
}

inline std::vector<std::string> extract_sql_single_quoted_literals(std::string_view sql) {
  const auto ranges = sql_single_quoted_literal_ranges(sql);
  std::vector<std::string> out;
  out.reserve(ranges.size());
  for (const auto& range : ranges) {
    out.emplace_back(sql.substr(range.first, range.second - range.first));
  }
  return out;
}

inline std::string restore_sql_single_quoted_literals(
    std::string formatted,
    std::string_view original
) {
  const auto source_literals = extract_sql_single_quoted_literals(original);
  if (source_literals.empty()) return formatted;

  const auto formatted_ranges = sql_single_quoted_literal_ranges(formatted);
  if (formatted_ranges.empty()) return formatted;

  std::string out;
  out.reserve(std::max(formatted.size(), original.size()));
  size_t cursor = 0;
  for (size_t i = 0; i < formatted_ranges.size(); ++i) {
    const auto [begin, end] = formatted_ranges[i];
    out.append(formatted, cursor, begin - cursor);
    if (i < source_literals.size()) {
      out += source_literals[i];
    } else {
      out.append(formatted, begin, end - begin);
    }
    cursor = end;
  }
  out.append(formatted, cursor, formatted.size() - cursor);
  return out;
}

inline bool sql_identifier_ends_with(std::string_view ident, std::string_view suffix) {
  return ident.size() >= suffix.size() &&
         ident.substr(ident.size() - suffix.size()) == suffix;
}

// Detect result types which clickhouse-cpp v2.6 cannot reliably decode through
// the native protocol. This is deliberately lexical and conservative: a false
// positive costs one cached DESCRIBE, while a false negative can corrupt a
// streamed result before the driver reports its decode error.
inline bool sql_likely_requires_compat_describe(std::string_view sql) {
  const auto masked = mask_sql_surface(sql);
  const std::string_view code(masked.code_lower);

  for (size_t i = 0; i < code.size();) {
    if (!sql_is_ident_start(code[i])) {
      ++i;
      continue;
    }

    const size_t start = i++;
    while (i < code.size() && sql_is_ident_continue(code[i])) ++i;
    const std::string_view ident = code.substr(start, i - start);

    size_t next = i;
    while (next < code.size() && std::isspace(static_cast<unsigned char>(code[next]))) ++next;
    const bool is_call = next < code.size() && code[next] == '(';

    if (ident == "aggregatefunction" || ident == "json" || ident == "dynamic" ||
        ident == "uint256" || ident == "int256" || ident == "decimal256") {
      return true;
    }

    if (ident == "object" && is_call) return true;

    // Aggregate combinators ending in State return AggregateFunction(...), for
    // example argMaxState, uniqState and quantilesMergeState.
    if (is_call && sql_identifier_ends_with(ident, "state")) return true;

    // Explicit conversion helpers expose 256-bit values even when their type
    // name does not otherwise occur in the query text.
    if (is_call && (ident == "touint256" || ident == "toint256" || ident == "todecimal256")) {
      return true;
    }
  }

  return false;
}

} // namespace chdash
