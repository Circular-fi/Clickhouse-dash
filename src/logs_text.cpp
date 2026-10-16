#include "logs_text.hpp"

#include "sql_literal.hpp"

#include <cctype>
#include <utility>

namespace chdash::logs {

using sql::like_escape;

// tokenbf_v1 and hasToken() split on every ASCII non-alphanumeric byte.
// Bytes >= 0x80 (UTF-8) belong to tokens.
bool token_byte(unsigned char ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch >= 0x80;
}

std::vector<std::string> split_tokens(std::string_view text) {
  std::vector<std::string> out;
  std::string current;
  for (char c : text) {
    if (token_byte(static_cast<unsigned char>(c))) {
      current.push_back(c);
    } else if (!current.empty()) {
      out.push_back(current);
      current.clear();
    }
  }
  if (!current.empty()) out.push_back(current);
  return out;
}

// Terms are separated by whitespace. A term in double quotes is a phrase.
// A term with a leading minus sign is negated.
std::vector<TextTerm> parse_terms(std::string_view q) {
  std::vector<TextTerm> terms;
  size_t i = 0;
  while (i < q.size()) {
    while (i < q.size() && std::isspace(static_cast<unsigned char>(q[i]))) ++i;
    if (i >= q.size()) break;
    TextTerm term;
    if (q[i] == '-' && i + 1 < q.size() && !std::isspace(static_cast<unsigned char>(q[i + 1]))) {
      term.negate = true;
      ++i;
    }
    if (q[i] == '"') {
      const size_t close = q.find('"', i + 1);
      const size_t end = close == std::string_view::npos ? q.size() : close;
      term.text = std::string(q.substr(i + 1, end - i - 1));
      i = close == std::string_view::npos ? q.size() : close + 1;
    } else {
      size_t end = i;
      while (end < q.size() && !std::isspace(static_cast<unsigned char>(q[end]))) ++end;
      term.text = std::string(q.substr(i, end - i));
      i = end;
    }
    if (!term.text.empty()) terms.push_back(std::move(term));
  }
  return terms;
}

std::string to_lower_ascii(std::string text) {
  for (char& c : text) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return text;
}

// In token mode, every token of a term must be present. The tokenbf index serves this check through hasToken.
// A term with separators ("analytics.events_buffer", "key=user:12") must also appear verbatim.
// The position() function checks this on the granules that the index kept.
std::string token_term_sql(const TextTerm& term, bool lower_index, SqlParams& params) {
  const std::string body = lower_index ? "lower(Body)" : "Body";
  const std::string text = lower_index ? to_lower_ascii(term.text) : term.text;
  const auto tokens = split_tokens(text);
  std::vector<std::string> parts;
  for (const auto& token : tokens) parts.push_back("hasToken(" + body + ", " + params.text(token) + ")");
  if (!(tokens.size() == 1 && tokens.front() == text)) {
    parts.push_back(std::string(lower_index ? "positionCaseInsensitive(Body, " : "position(Body, ") + params.text(term.text) + ") > 0");
  }
  std::string sql = "(";
  for (size_t i = 0; i < parts.size(); ++i) sql += (i ? " AND " : "") + parts[i];
  sql += ")";
  return term.negate ? "NOT " + sql : sql;
}

std::string substring_term_sql(const TextTerm& term, SqlParams& params) {
  return std::string("Body ") + (term.negate ? "NOT " : "") + "ILIKE " + params.text("%" + like_escape(term.text) + "%");
}

}  // namespace chdash::logs
