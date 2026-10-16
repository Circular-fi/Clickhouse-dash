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

// A word of the code at the top level, outside every bracket. The words are in order and in lower case.
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

// The key is a digest of the text. The cache compares the text itself on a hit (FormatCache).
// So two texts with the same digest never share a layout.
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
    // The name of the format follows FORMAT after blanks. The name is a word.
    size_t next = words[w].token + 1;
    while (next < tokens.size() && tokens[next].kind == sql::TokenKind::Blank) ++next;
    if (next >= tokens.size() || tokens[next].kind != sql::TokenKind::Word || !sql_is_ident_start(sql[tokens[next].begin])) {
      return std::string_view::npos;
    }
    return tokens[next].end;
  }
  return std::string_view::npos;
}

std::string quote_reserved_aliases_for_format_query(std::string_view sql, std::vector<std::pair<size_t, size_t>>* quoted) {
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
  // CREATE, REPLACE, and ATTACH statements can have a query body ([MATERIALIZED] VIEW,
  // TABLE ... AS SELECT, REFRESH ... AS SELECT). The body starts with a top-level `AS SELECT` or `AS WITH`.
  // That keyword is not an alias.
  const bool create_query_statement = !leading_keywords.empty() &&
      (leading_keywords[0] == "create" || leading_keywords[0] == "replace" || leading_keywords[0] == "attach");

  struct Range { size_t begin; size_t end; };
  std::vector<Range> ranges;
  bool view_query_boundary_consumed = false;
  for (size_t k = 0; k + 1 < significant.size(); ++k) {
    const sql::Token* as = word_at(k);
    if (!as || lower_word(as->text(sql)) != "as") continue;
    // The token after AS is read on the original text. A name between quote marks is already an alias.
    const sql::Token* alias = word_at(k + 1);
    if (!alias) continue;
    const std::string candidate = lower_word(alias->text(sql));
    if (reserved_aliases.find(candidate) == reserved_aliases.end()) continue;

    // In CREATE [MATERIALIZED] VIEW or CREATE TABLE ... AS SELECT, the first `AS SELECT` or `AS WITH` introduces the stored query.
    // SELECT and WITH are not aliases in that case.
    // The formatter compatibility pass must still quote reserved aliases *inside* that SELECT, for example `SELECT 1 AS FROM`.
    if (create_query_statement && !view_query_boundary_consumed && (candidate == "select" || candidate == "with")) {
      view_query_boundary_consumed = true;
      continue;
    }
    ranges.push_back({alias->begin, alias->end});
  }

  if (quoted) {
    quoted->clear();
    for (const auto& range : ranges) quoted->emplace_back(range.begin, range.end);
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

size_t offset_in_user_text(size_t sent_offset, const std::vector<std::pair<size_t, size_t>>& quoted, const SqlHeredocMask& masks,
                           std::string_view masked) {
  // The words written between backticks. Each word adds two bytes, one before the word and one after it.
  size_t added = 0;
  for (size_t i = 0; i < quoted.size(); ++i) {
    const size_t open = quoted[i].first + 2 * i;
    const size_t close = quoted[i].second + 2 * i + 1;
    if (sent_offset > open) ++added;
    if (sent_offset > close) ++added;
  }
  size_t pos = sent_offset >= added ? sent_offset - added : 0;
  if (masks.heredocs.empty()) return pos;
  // The placeholders are undone in the reverse order of their making, each where it stands in the text.
  // A placeholder that ends before `pos` moves `pos` by the difference of the two spellings. A `pos` inside a placeholder goes to its start.
  // A text with very many placeholders is not worth this work, so its offset stays as it is.
  if (masks.heredocs.size() * masked.size() > 64u * 1024 * 1024) return pos;
  std::string text(masked);
  for (size_t i = masks.heredocs.size(); i-- > 0;) {
    const auto& [placeholder, spelling] = masks.heredocs[i];
    const size_t at = text.find(placeholder);
    if (at == std::string::npos) continue;
    if (pos >= at + placeholder.size()) pos = pos - placeholder.size() + spelling.size();
    else if (pos > at) pos = at;
    text.replace(at, placeholder.size(), spelling);
  }
  return pos;
}

std::string rebase_error_position(std::string message, std::string_view text, size_t offset) {
  int line = 1, col = 1;
  sql_line_col(text, offset, line, col);
  const auto replace_number = [&](size_t from, size_t number_at, const std::string& value) -> size_t {
    (void)from;
    size_t end = number_at;
    while (end < message.size() && std::isdigit(static_cast<unsigned char>(message[end]))) ++end;
    if (end == number_at) return number_at;
    message.replace(number_at, end - number_at, value);
    return number_at + value.size();
  };
  const size_t position = message.find("position ");
  if (position == std::string::npos) return message;
  replace_number(position, position + 9, std::to_string(offset + 1));
  if (const size_t at = message.find("(line ", position); at != std::string::npos) {
    const size_t after_line = replace_number(at, at + 6, std::to_string(line));
    if (const size_t col_at = message.find("col ", after_line); col_at != std::string::npos) replace_number(col_at, col_at + 4, std::to_string(col));
  }
  return message;
}

bool values_rows_unchanged(std::string_view before, std::string_view after) {
  // Take the significant tokens (no blank, no comment) after the VALUES of the top level.
  const auto rows = [](std::string_view sql) {
    std::vector<std::string> out;
    const auto tokens = sql::lex(sql);
    const auto words = top_level_words(tokens, sql);
    size_t from = tokens.size();
    for (const TopWord& word : words) {
      if (word.lower == "values") {
        from = word.token + 1;
        break;
      }
    }
    // The rows can follow each other with a comma, or without one (`(1, 2)(3, 4)`). A comma between two rows is not part of the data.
    int depth = 0;
    for (size_t i = from; i < tokens.size(); ++i) {
      if (sql::is_trivia(tokens[i].kind)) continue;
      const std::string_view text = tokens[i].text(sql);
      if (tokens[i].kind == sql::TokenKind::Punct && text.size() == 1) {
        if (text[0] == '(' || text[0] == '[' || text[0] == '{') ++depth;
        else if ((text[0] == ')' || text[0] == ']' || text[0] == '}') && depth > 0) --depth;
        else if (text[0] == ',' && depth == 0) continue;
      }
      out.emplace_back(text);
    }
    return out;
  };
  return rows(before) == rows(after);
}

FormatBatch::FormatBatch(FormatCache* cache, FormatSettings settings, FormatQueryPort& port)
    : cache_(cache), settings_(std::move(settings)), port_(port) {}

namespace {

// The work on one text, step by step. Each field is one form of the text.
struct Work {
  std::string text;     // the text of the user, without the blanks around it
  size_t leading = 0;   // the bytes of blank that were taken off its start (the offsets of an error count from the start of the user's text)
  std::string head;     // the statement: `text` without the payload of an INSERT ... FORMAT
  std::string payload;  // the payload, with the blank before it
  SqlHeredocMask masks; // `head` with its heredocs and its literals on many lines swapped for placeholders
};

// Inline INSERT payloads are data, not SQL. The payload is kept byte-for-byte after the formatted statement.
// It goes on its own line when it started on one.
void split_insert_payload(Work& work) {
  work.head = work.text;
  if (const size_t name_end = insert_format_name_end(work.head); name_end != std::string::npos) {
    size_t data = name_end;
    while (data < work.head.size() && (work.head[data] == ' ' || work.head[data] == '\t' || work.head[data] == '\n' || work.head[data] == '\r')) ++data;
    if (data < work.head.size()) {
      const bool own_line = work.head.find_first_of("\r\n", name_end) < data;
      size_t end = work.head.size();
      while (end > data && (work.head[end - 1] == '\n' || work.head[end - 1] == '\r')) --end;
      work.payload = (own_line ? "\n" : " ") + work.head.substr(data, end - data);
      work.head.resize(name_end);
    }
  }
}

// Heredoc literals ($$...$$) are swapped for same-width placeholders. So neither formatQuery nor the local scanners see their bodies.
// formatQuery re-quotes the literals. The exact spelling is put back at the end, like other literal spellings.
void mask_literals(Work& work) {
  work.masks = mask_sql_heredocs(work.head);
  // Placeholders use private-use code points. Never mask SQL that already contains them (same guard as mask_sql_heredocs).
  if (work.head.find('\xEE') == std::string::npos) mask_sql_multiline_literals(work.masks);
}

// formatQuery and the local post-processor normalize many identifiers to backticks on purpose. The formatting stays deterministic.
// The exact spelling of identifiers that the user explicitly quoted is restored. The original spelling of string literals is restored too.
std::string restore_spelling(std::string pretty, const Work& work) {
  const std::string& source = work.masks.sql;
  pretty = restore_sql_quoted_identifiers(std::move(pretty), source);
  pretty = unquote_call_identifiers_written_unquoted(std::move(pretty), source);
  pretty = restore_sql_single_quoted_literals(std::move(pretty), source);
  return restore_sql_heredocs(std::move(pretty), work.masks);
}

} // namespace

// Does ClickHouse read the formatted statement as it reads the one that was written? This function compares the trees (EXPLAIN AST).
// The trees are the same for two layouts of one statement, and for a text with and without its comments.
// formatQuery is not used for this check, because it prints the parentheses that the text had.
//
// The rows of an INSERT ... VALUES are data that ClickHouse does not parse. So their tokens are compared.
// A statement that ClickHouse cannot parse cannot be judged. The same holds for a text that it will not read (too long), and for a connection that fails.
// In these cases, the layout stays, as before this check existed.
std::optional<FormatWarning> FormatBatch::check_meaning(const std::string& before, const std::string& after) {
  const auto changed = [] {
    return FormatWarning{"format_meaning_changed",
                         "The formatter could not lay this statement out without changing what ClickHouse reads from it. The statement is returned as it was written."};
  };
  if (has_top_level_values_insert(before) && !values_rows_unchanged(before, after)) return changed();
  const std::string sent_before = quote_reserved_aliases_for_format_query(before);
  const std::string sent_after = quote_reserved_aliases_for_format_query(after);
  const size_t limit = settings_.clickhouse_max_query_size ? std::min(settings_.max_sql_bytes, settings_.clickhouse_max_query_size)
                                                           : settings_.max_sql_bytes;
  if (sent_before.size() + 16 > limit || sent_after.size() + 16 > limit) return std::nullopt;
  const FormatQueryResult tree_before = port_.explain_ast(sent_before, limit);
  if (!tree_before) return std::nullopt;
  const FormatQueryResult tree_after = port_.explain_ast(sent_after, limit);
  if (!tree_after) {
    // The statement that was written is understood, but the formatted one is not. That is a change.
    // A connection that failed is not a change. A text that grew past what ClickHouse reads is not a change either (the message names max_query_size).
    if (tree_after.failure != FormatQueryFailureKind::server || tree_after.message.find("max_query_size") != std::string::npos) return std::nullopt;
    return changed();
  }
  if (tree_before.formatted_sql != tree_after.formatted_sql) return changed();
  return std::nullopt;
}

FormatOutcome FormatBatch::format(std::string sql_raw) {
  FormatOutcome outcome;
  const auto fail = [&](FormatQueryFailureKind kind, std::string message) {
    outcome.failure = kind;
    outcome.error = std::move(message);
    return outcome;
  };

  Work work;
  while (work.leading < sql_raw.size() && (sql_raw[work.leading] == ' ' || sql_raw[work.leading] == '\n' || sql_raw[work.leading] == '\r' ||
                                           sql_raw[work.leading] == '\t')) {
    ++work.leading;
  }
  // Error offsets count the blanks that the text starts with, and then the text.
  const std::string leading_blanks = sql_raw.substr(0, work.leading);
  std::string sql = trim_sql(std::move(sql_raw));
  if (sql.empty()) return fail(FormatQueryFailureKind::input, "Missing SQL text.");
  if (sql.size() > settings_.max_sql_bytes) {
    return fail(FormatQueryFailureKind::input, "SQL text is too large to format: the limit is " + std::to_string(settings_.max_sql_bytes) + " bytes.");
  }

  const std::string key = format_cache_key(settings_.cache_scope, settings_.line_width, sql);
  if (auto local = request_results_.find(key); local != request_results_.end()) {
    ++stats_.deduplicated;
    return local->second;
  }
  const bool cached = cache_ && settings_.use_cache;
  if (cached) {
    if (auto hit = cache_->get(key, sql)) {
      ++stats_.cache_hits;
      outcome.formatted = std::move(hit);
      request_results_.emplace(key, outcome);
      return outcome;
    }
  }
  ++stats_.cache_misses;
  work.text = std::move(sql);
  split_insert_payload(work);
  mask_literals(work);
  const std::string& source_sql = work.masks.sql;

  std::string pretty;
  bool local_layout = false;
  const auto masked = mask_sql_surface(source_sql);
  if (masked.has_comments || has_top_level_values_insert(source_sql)) {
    // formatQuery removes or restructures these surfaces. The local post-processor keeps comments and VALUES payloads byte-for-byte.
    local_layout = true;
    pretty = unwrap_alter_table_commands(postprocess_format_query(source_sql, static_cast<size_t>(settings_.line_width)));
  } else {
    std::vector<std::pair<size_t, size_t>> quoted;
    const std::string parseable_sql = quote_reserved_aliases_for_format_query(source_sql, &quoted);
    // ClickHouse reads at most max_query_size bytes of the text that it receives, including the quoted words.
    if (settings_.clickhouse_max_query_size && parseable_sql.size() > settings_.clickhouse_max_query_size) {
      return fail(FormatQueryFailureKind::input, "SQL text is too large to format: ClickHouse reads at most " +
                                                     std::to_string(settings_.clickhouse_max_query_size) +
                                                     " bytes (max_query_size), and this text is " + std::to_string(parseable_sql.size()) +
                                                     " bytes once its reserved words are quoted.");
    }
    FormatQueryResult format_result = port_.format_query(parseable_sql, std::max(settings_.max_sql_bytes, parseable_sql.size()));
    if (!format_result.formatted_sql) {
      const FormatQueryFailureKind kind = format_result.failure == FormatQueryFailureKind::none ? FormatQueryFailureKind::client : format_result.failure;
      std::string message = format_result.message.empty() ? "Failed to format query." : format_result.message;
      if (kind == FormatQueryFailureKind::server) {
        // ClickHouse counts from the start of the text that it was sent. The code gives the position in the text that the user wrote.
        if (const size_t at = message.find("position "); at != std::string::npos) {
          size_t end = at + 9;
          size_t number = 0;
          while (end < message.size() && std::isdigit(static_cast<unsigned char>(message[end])) && number < 100000000) number = number * 10 + (message[end++] - '0');
          if (end > at + 9 && number > 0) {
            const size_t offset = std::min(offset_in_user_text(number - 1, quoted, work.masks, source_sql), work.text.size()) + work.leading;
            outcome.error_offset = offset;
            message = rebase_error_position(std::move(message), leading_blanks + work.text, offset);
          }
        }
      }
      return fail(kind, std::move(message));
    }
    // formatQuery can normalize literal escaping. The code restores the user's exact literal spelling, including doubled SQL quotes, before the line wrapping.
    pretty = unwrap_alter_table_commands(postprocess_format_query(
        restore_sql_single_quoted_literals(*format_result.formatted_sql, source_sql), static_cast<size_t>(settings_.line_width)));
  }

  pretty = restore_spelling(std::move(pretty), work);
  if (local_layout) outcome.warning = check_meaning(work.head, pretty);
  if (outcome.warning) {
    // The statement is returned as it was written. It is not kept in the cache, so the next request checks it again.
    outcome.formatted = std::make_shared<const std::string>(work.text);
    request_results_.emplace(key, outcome);
    return outcome;
  }
  pretty += work.payload;

  auto value = std::make_shared<const std::string>(std::move(pretty));
  outcome.formatted = value;
  request_results_.emplace(key, outcome);
  // Only the text that was formatted is a key. The output is not stored as a key of its own.
  // So formatting a formatted text runs the formatter again. A layout that is not idempotent shows in this way.
  if (cached) cache_->put(key, work.text, std::move(value));
  return outcome;
}

std::vector<FormatItem> format_texts(FormatBatch& batch, const std::vector<std::string>& texts, const FormatBatchLimits& limits) {
  std::vector<FormatItem> items(texts.size());
  bool stopped = false;
  for (size_t i = 0; i < texts.size(); ++i) {
    FormatItem& item = items[i];
    // Once the caller is gone or the server stops, nothing else is asked. The answer reaches nobody, or the process ends.
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
