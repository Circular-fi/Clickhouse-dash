#pragma once

// The text search of the logs routes as pure functions (api_logs.cpp, docs/logs.md): the tokens that hasToken() and the tokenbf_v1
// index of the exporter see, the terms of a search ("phrase", -negated) and the SQL predicate of one term. The values of a term go
// through SqlParams, so no text of a user is in a statement.
#include "sql_params.hpp"

#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace chdash::logs {

// A search keeps at most this many terms.
constexpr size_t kMaxTextTerms = 16;

struct TextTerm {
  std::string text;
  bool negate = false;
};

bool token_byte(unsigned char ch);
std::vector<std::string> split_tokens(std::string_view text);
std::vector<TextTerm> parse_terms(std::string_view q);
std::string to_lower_ascii(std::string text);
// Token mode: hasToken() for each token of the term (and position() when the term has separators).
std::string token_term_sql(const TextTerm& term, bool lower_index, SqlParams& params);
// Substring mode: Body ILIKE '%term%' with the LIKE wildcards of the term escaped.
std::string substring_term_sql(const TextTerm& term, SqlParams& params);

}  // namespace chdash::logs
