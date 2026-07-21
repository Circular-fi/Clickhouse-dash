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


struct SqlIdentifierToken {
  size_t begin = 0;
  size_t end = 0;
  std::string decoded;
  bool quoted = false;
};

inline bool sql_identifier_value_equal(std::string_view lhs, std::string_view rhs) {
  if (lhs.size() != rhs.size()) return false;
  for (size_t i = 0; i < lhs.size(); ++i) {
    if (sql_ascii_lower(lhs[i]) != sql_ascii_lower(rhs[i])) return false;
  }
  return true;
}

// Tokenize identifiers while ignoring strings and comments. Quoted identifiers
// are decoded only for alignment; their exact source spelling is kept in the
// original SQL and can later be restored after ClickHouse formatQuery has
// normalized double quotes to backticks.
inline std::vector<SqlIdentifierToken> sql_identifier_tokens(std::string_view sql) {
  std::vector<SqlIdentifierToken> tokens;

  for (size_t i = 0; i < sql.size();) {
    const char ch = sql[i];
    const char next = (i + 1 < sql.size()) ? sql[i + 1] : '\0';

    if (ch == '-' && next == '-') {
      i += 2;
      while (i < sql.size() && sql[i] != '\n' && sql[i] != '\r') ++i;
      continue;
    }
    if (ch == '#') {
      ++i;
      while (i < sql.size() && sql[i] != '\n' && sql[i] != '\r') ++i;
      continue;
    }
    if (ch == '/' && next == '*') {
      i += 2;
      while (i + 1 < sql.size() && !(sql[i] == '*' && sql[i + 1] == '/')) ++i;
      i = std::min(sql.size(), i + 2);
      continue;
    }

    if (ch == '\'') {
      ++i;
      bool escaped = false;
      while (i < sql.size()) {
        const char current = sql[i];
        const char following = (i + 1 < sql.size()) ? sql[i + 1] : '\0';
        if (escaped) {
          escaped = false;
          ++i;
        } else if (current == '\\') {
          escaped = true;
          ++i;
        } else if (current == '\'' && following == '\'') {
          i += 2;
        } else if (current == '\'') {
          ++i;
          break;
        } else {
          ++i;
        }
      }
      continue;
    }

    if (ch == '"' || ch == '`') {
      const char quote = ch;
      const size_t begin = i++;
      std::string decoded;
      bool closed = false;
      while (i < sql.size()) {
        const char current = sql[i];
        const char following = (i + 1 < sql.size()) ? sql[i + 1] : '\0';
        if (current == quote && following == quote) {
          decoded.push_back(quote);
          i += 2;
        } else if (current == '\\' && i + 1 < sql.size()) {
          decoded.push_back(sql[i + 1]);
          i += 2;
        } else if (current == quote) {
          ++i;
          closed = true;
          break;
        } else {
          decoded.push_back(current);
          ++i;
        }
      }
      if (closed) tokens.push_back({begin, i, std::move(decoded), true});
      continue;
    }

    if (sql_is_ident_start(ch)) {
      const size_t begin = i++;
      while (i < sql.size() && sql_is_ident_continue(sql[i])) ++i;
      tokens.push_back({begin, i, std::string(sql.substr(begin, i - begin)), false});
      continue;
    }

    ++i;
  }

  return tokens;
}

inline std::string restore_sql_quoted_identifiers(
    std::string formatted,
    std::string_view original
) {
  const auto source_tokens = sql_identifier_tokens(original);
  if (source_tokens.empty()) return formatted;

  bool has_quoted_source = false;
  for (const auto& token : source_tokens) {
    if (token.quoted) {
      has_quoted_source = true;
      break;
    }
  }
  if (!has_quoted_source) return formatted;

  const auto formatted_tokens = sql_identifier_tokens(formatted);
  if (formatted_tokens.empty()) return formatted;

  struct Replacement {
    size_t begin;
    size_t end;
    std::string text;
  };
  std::vector<Replacement> replacements;

  auto add_replacement = [&](const SqlIdentifierToken& source, const SqlIdentifierToken& target) {
    if (!source.quoted) return;
    const std::string_view wanted = original.substr(source.begin, source.end - source.begin);
    const std::string_view current = std::string_view(formatted).substr(target.begin, target.end - target.begin);
    if (wanted != current) {
      replacements.push_back({target.begin, target.end, std::string(wanted)});
    }
  };

  // The local formatter may change only the outer quote character without
  // rewriting doubled quote escapes inside the identifier. In that case the
  // decoded values differ even though the identifier occupies the same token
  // slot. Prefer positional alignment when the complete token structure is
  // unchanged; all unquoted tokens must still match and quoted source tokens
  // must still be quoted in the formatted output.
  bool structurally_aligned = source_tokens.size() == formatted_tokens.size();
  if (structurally_aligned) {
    for (size_t i = 0; i < source_tokens.size(); ++i) {
      const auto& source = source_tokens[i];
      const auto& target = formatted_tokens[i];
      if ((source.quoted && !target.quoted) ||
          (!source.quoted && !sql_identifier_value_equal(source.decoded, target.decoded))) {
        structurally_aligned = false;
        break;
      }
    }
  }

  if (structurally_aligned) {
    for (size_t i = 0; i < source_tokens.size(); ++i) {
      add_replacement(source_tokens[i], formatted_tokens[i]);
    }
  } else {
    size_t formatted_index = 0;

    // Align the complete identifier stream rather than only quoted tokens. This
    // prevents a quoted alias from being matched to an earlier unquoted alias
    // which formatQuery happened to wrap in backticks.
    for (const auto& source : source_tokens) {
      while (formatted_index < formatted_tokens.size() &&
             !sql_identifier_value_equal(source.decoded, formatted_tokens[formatted_index].decoded)) {
        ++formatted_index;
      }
      if (formatted_index >= formatted_tokens.size()) break;
      add_replacement(source, formatted_tokens[formatted_index++]);
    }
  }

  if (replacements.empty()) return formatted;

  std::string out;
  out.reserve(std::max(formatted.size(), original.size()));
  size_t cursor = 0;
  for (const auto& replacement : replacements) {
    if (replacement.begin < cursor || replacement.end < replacement.begin || replacement.end > formatted.size()) {
      continue;
    }
    out.append(formatted, cursor, replacement.begin - cursor);
    out += replacement.text;
    cursor = replacement.end;
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
