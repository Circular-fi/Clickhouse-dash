#include "format_service.hpp"

#include "format_postprocess.hpp"
#include "jwt.hpp"
#include "sql_lexer.hpp"
#include "sql_scan.hpp"
#include "sql_util.hpp"

#include <algorithm>
#include <cctype>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace chdash {
namespace {

std::string lower_word(std::string_view word) {
  std::string out(word);
  for (char& c : out) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return out;
}

// A word of the code at the top level (outside every bracket), in order, in lower case.
struct TopWord {
  std::string lower;
  size_t token = 0;  // the index of its token
};

std::vector<TopWord> top_level_words(const std::vector<sql::Token>& tokens, std::string_view sql) {
  std::vector<TopWord> out;
  int depth = 0;
  for (size_t i = 0; i < tokens.size(); ++i) {
    const sql::Token& token = tokens[i];
    if (token.kind == sql::TokenKind::Punct) {
      const char c = sql[token.begin];
      if (c == '(' || c == '[' || c == '{') ++depth;
      else if ((c == ')' || c == ']' || c == '}') && depth > 0) --depth;
    } else if (token.kind == sql::TokenKind::Word && depth == 0 && sql_is_ident_start(sql[token.begin])) {
      out.push_back({lower_word(token.text(sql)), i});
    }
  }
  return out;
}

// The key is a digest of the text; the cache compares the text itself on a hit (FormatCache), so two texts with
// the same digest never share a layout.
std::string format_cache_key(std::string_view scope, int line_width, std::string_view sql) {
  std::string key;
  key.reserve(scope.size() + 96);
  key.append(scope.data(), scope.size());
  key.push_back('\x1f');
  key += std::to_string(line_width);
  key.push_back('\x1f');
  key += std::to_string(sql.size());
  key.push_back(':');
  key += sha256_hex(sql);
  return key;
}

} // namespace

bool has_top_level_values_insert(std::string_view sql) {
  const auto tokens = sql::lex(sql);
  bool seen_insert = false;
  for (const TopWord& word : top_level_words(tokens, sql)) {
    if (!seen_insert && word.lower == "insert") {
      seen_insert = true;
    } else if (seen_insert && word.lower == "values") {
      return true;
    } else if (seen_insert && (word.lower == "select" || word.lower == "format")) {
      return false;
    }
  }
  return false;
}

size_t insert_format_name_end(std::string_view sql) {
  const auto tokens = sql::lex(sql);
  const auto words = top_level_words(tokens, sql);
  if (words.empty() || words.front().lower != "insert") return std::string_view::npos;
  for (size_t w = 1; w < words.size(); ++w) {
    const std::string& word = words[w].lower;
    if (word == "values" || word == "select" || word == "with") return std::string_view::npos;
    if (word != "format") continue;
    // The name of the format follows FORMAT after blanks, and is a word.
    size_t next = words[w].token + 1;
    while (next < tokens.size() && tokens[next].kind == sql::TokenKind::Blank) ++next;
    if (next >= tokens.size() || tokens[next].kind != sql::TokenKind::Word || !sql_is_ident_start(sql[tokens[next].begin])) {
      return std::string_view::npos;
    }
    return tokens[next].end;
  }
  return std::string_view::npos;
}

std::string quote_reserved_aliases_for_format_query(std::string_view sql) {
  static const std::unordered_set<std::string> reserved_aliases = {
      "all", "alter", "and", "array", "as", "asc", "by", "case",
      "cross", "desc", "distinct", "else", "end", "except", "exists",
      "final", "format", "from", "full", "global", "group", "having",
      "inner", "intersect", "into", "join", "left", "limit", "not",
      "null", "offset", "on", "or", "order", "outer", "prewhere",
      "qualify", "right", "sample", "select", "semi", "settings",
      "then", "union", "using", "when", "where", "window", "with"};

  const auto tokens = sql::lex(sql);
  std::vector<size_t> significant;  // the tokens that are not a blank or a comment
  for (size_t i = 0; i < tokens.size(); ++i) {
    if (!sql::is_trivia(tokens[i].kind)) significant.push_back(i);
  }
  const auto word_at = [&](size_t k) -> const sql::Token* {
    if (k >= significant.size()) return nullptr;
    const sql::Token& token = tokens[significant[k]];
    return token.kind == sql::TokenKind::Word && sql_is_ident_start(sql[token.begin]) ? &token : nullptr;
  };

  std::vector<std::string> leading_keywords;
  for (size_t k = 0; k < significant.size() && leading_keywords.size() < 5; ++k) {
    if (const sql::Token* word = word_at(k)) leading_keywords.push_back(lower_word(word->text(sql)));
  }
  // CREATE/REPLACE/ATTACH statements with a query body ([MATERIALIZED] VIEW,
  // TABLE ... AS SELECT, REFRESH ... AS SELECT) introduce that body with a
  // top-level `AS SELECT` / `AS WITH`; that keyword is not an alias.
  const bool create_query_statement = !leading_keywords.empty() &&
      (leading_keywords[0] == "create" || leading_keywords[0] == "replace" || leading_keywords[0] == "attach");

  struct Range { size_t begin; size_t end; };
  std::vector<Range> ranges;
  bool view_query_boundary_consumed = false;
  for (size_t k = 0; k + 1 < significant.size(); ++k) {
    const sql::Token* as = word_at(k);
    if (!as || lower_word(as->text(sql)) != "as") continue;
    // The token after AS is read on the original text: a name between quote marks is an alias already.
    const sql::Token* alias = word_at(k + 1);
    if (!alias) continue;
    const std::string candidate = lower_word(alias->text(sql));
    if (reserved_aliases.find(candidate) == reserved_aliases.end()) continue;

    // In CREATE [MATERIALIZED] VIEW / CREATE TABLE ... AS SELECT, the first
    // `AS SELECT` / `AS WITH` introduces the stored query; SELECT/WITH is not
    // an alias. The formatter compatibility pass still has to quote reserved
    // aliases *inside* that SELECT, e.g. `SELECT 1 AS FROM`.
    if (create_query_statement && !view_query_boundary_consumed && (candidate == "select" || candidate == "with")) {
      view_query_boundary_consumed = true;
      continue;
    }
    ranges.push_back({alias->begin, alias->end});
  }

  if (ranges.empty()) return std::string(sql);
  std::string out;
  out.reserve(sql.size() + ranges.size() * 2);
  size_t cursor = 0;
  for (const auto& range : ranges) {
    out.append(sql.substr(cursor, range.begin - cursor));
    out.push_back('`');
    out.append(sql.substr(range.begin, range.end - range.begin));
    out.push_back('`');
    cursor = range.end;
  }
  out.append(sql.substr(cursor));
  return out;
}

FormatBatch::FormatBatch(FormatCache* cache, FormatSettings settings, FormatQueryPort& port)
    : cache_(cache), settings_(std::move(settings)), port_(port) {}

FormatOutcome FormatBatch::format(std::string sql_raw) {
  FormatOutcome outcome;
  const auto fail = [&](FormatQueryFailureKind kind, std::string message) {
    outcome.failure = kind;
    outcome.error = std::move(message);
    return outcome;
  };

  std::string sql = trim_sql(std::move(sql_raw));
  if (sql.empty()) return fail(FormatQueryFailureKind::input, "Missing SQL text.");
  if (sql.size() > settings_.max_sql_bytes) return fail(FormatQueryFailureKind::input, "SQL text is too large to format.");

  const std::string key = format_cache_key(settings_.cache_scope, settings_.line_width, sql);
  if (auto local = request_results_.find(key); local != request_results_.end()) {
    ++stats_.deduplicated;
    outcome.formatted = local->second;
    return outcome;
  }
  const bool cached = cache_ && settings_.use_cache;
  if (cached) {
    if (auto hit = cache_->get(key, sql)) {
      ++stats_.cache_hits;
      request_results_.emplace(key, hit);
      outcome.formatted = std::move(hit);
      return outcome;
    }
  }
  ++stats_.cache_misses;
  // The text of the key, kept for the cache entry (`sql` loses its INSERT payload below).
  const std::string input = cached ? sql : std::string();

  // Inline INSERT payloads are data, not SQL: keep them byte-for-byte after
  // the formatted statement, on their own line when they started on one.
  std::string insert_payload;
  if (const size_t name_end = insert_format_name_end(sql); name_end != std::string::npos) {
    size_t data = name_end;
    while (data < sql.size() && (sql[data] == ' ' || sql[data] == '\t' || sql[data] == '\n' || sql[data] == '\r')) ++data;
    if (data < sql.size()) {
      const bool own_line = sql.find_first_of("\r\n", name_end) < data;
      size_t end = sql.size();
      while (end > data && (sql[end - 1] == '\n' || sql[end - 1] == '\r')) --end;
      insert_payload = (own_line ? "\n" : " ") + sql.substr(data, end - data);
      sql.resize(name_end);
    }
  }

  // Heredoc literals ($$...$$) are swapped for same-width placeholders so
  // neither formatQuery (which re-quotes them) nor the local scanners see
  // their bodies; the exact spelling is put back at the end, like other literal spellings.
  SqlHeredocMask heredocs = mask_sql_heredocs(sql);
  // Placeholders use private-use code points: never mask SQL that already contains them (same guard as mask_sql_heredocs).
  if (sql.find('\xEE') == std::string::npos) mask_sql_multiline_literals(heredocs);
  const std::string& source_sql = heredocs.sql;

  std::string pretty;
  const auto masked = mask_sql_surface(source_sql);
  if (masked.has_comments || has_top_level_values_insert(source_sql)) {
    // ClickHouse formatQuery removes or restructures these surfaces. The local
    // post-processor preserves comments and VALUES payloads byte-for-byte.
    pretty = postprocess_format_query(source_sql, static_cast<size_t>(settings_.line_width));
  } else {
    const std::string parseable_sql = quote_reserved_aliases_for_format_query(source_sql);
    FormatQueryResult format_result = port_.format_query(parseable_sql, settings_.max_sql_bytes);
    if (!format_result.formatted_sql) {
      return fail(format_result.failure == FormatQueryFailureKind::none ? FormatQueryFailureKind::client : format_result.failure,
                  format_result.message.empty() ? "Failed to format query." : format_result.message);
    }
    // formatQuery may normalize literal escaping. Restore the user's exact literal spelling, including doubled SQL quotes,
    // before line wrapping.
    pretty = unwrap_alter_table_commands(postprocess_format_query(
        restore_sql_single_quoted_literals(*format_result.formatted_sql, source_sql), static_cast<size_t>(settings_.line_width)));
  }

  // formatQuery and the local post-processor intentionally normalize many identifiers to backticks. Keep formatting
  // deterministic while restoring the exact spelling of identifiers that the user explicitly quoted, as well as the
  // original spelling of string literals.
  pretty = restore_sql_quoted_identifiers(std::move(pretty), source_sql);
  pretty = unquote_call_identifiers_written_unquoted(std::move(pretty), source_sql);
  pretty = restore_sql_single_quoted_literals(std::move(pretty), source_sql);
  pretty = restore_sql_heredocs(std::move(pretty), heredocs);
  pretty += insert_payload;

  auto value = std::make_shared<const std::string>(std::move(pretty));
  request_results_.emplace(key, value);
  // Only the text that was formatted is a key: the output is not stored as a key of its own, so formatting a formatted text runs
  // the formatter again and a layout that is not idempotent shows.
  if (cached) cache_->put(key, input, value);
  outcome.formatted = std::move(value);
  return outcome;
}

std::vector<FormatItem> format_texts(FormatBatch& batch, const std::vector<std::string>& texts, const FormatBatchLimits& limits) {
  std::vector<FormatItem> items(texts.size());
  bool stopped = false;
  for (size_t i = 0; i < texts.size(); ++i) {
    FormatItem& item = items[i];
    // Once the caller is gone or the server stops, nothing else is asked (the answer reaches nobody, or the process ends).
    if (!stopped && limits.stop && limits.stop()) stopped = true;
    if (stopped) {
      item.skipped_for_stop = true;
      continue;
    }
    if (std::chrono::steady_clock::now() > limits.deadline) continue;
    item.outcome = batch.format(texts[i]);
    item.status = item.outcome.ok() ? FormatItemStatus::Formatted : FormatItemStatus::Error;
  }
  return items;
}

} // namespace chdash
