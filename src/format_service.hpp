#pragma once

// SQL formatting as a service. The text goes in, the formatted text comes out. What the service needs of ClickHouse is one
// call, formatQuery, behind a port: the server gives it the pooled connections of the host, a test gives it a fake. The route
// (api_format.cpp) is an adapter: it reads the JSON, chooses the host, calls this, and writes the answer.
//
// A statement is formatted in these steps: an inline INSERT payload is set aside (it is data); a heredoc and a text that spans
// lines are swapped for placeholders of the same width; the text with comments or with an INSERT ... VALUES is laid out by the
// local formatter (formatQuery would drop the comments), any other text goes through formatQuery first; the exact spelling of
// the names and the texts that the user wrote is put back, and so are the heredocs and the payload.

#include "format_cache.hpp"
#include "format_clickhouse.hpp"
#include "sql_scan.hpp"

#include <chrono>
#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

// What the formatter asks of ClickHouse, for one text: formatQuery, and EXPLAIN AST.
class FormatQueryPort {
public:
  virtual ~FormatQueryPort() = default;
  virtual FormatQueryResult format_query(const std::string& sql, size_t max_bytes) = 0;
  // The tree that ClickHouse reads from the text (EXPLAIN AST), in `formatted_sql`: the same tree for two layouts of one statement, and for a
  // text with and without its comments. It is what the check of the meaning compares (format_service.cpp, FormatBatch::check_meaning).
  virtual FormatQueryResult explain_ast(const std::string& sql, size_t max_bytes) = 0;
};

struct FormatSettings {
  int line_width = 80;
  // false: format from scratch (the idempotence checks of the formatter suite run the formatter on its own output).
  bool use_cache = true;
  // What the layout depends on besides the text: the host and its ClickHouse version (formatQuery may answer another layout after
  // an upgrade).
  std::string cache_scope;
  // The largest text that the service takes.
  size_t max_sql_bytes = 500 * 1024;
  // max_query_size of the ClickHouse server (its health check); 0 when it is not known. ClickHouse refuses a text that is longer than this
  // when it parses it (formatQuery and EXPLAIN AST), so a longer text is refused here with a message that says it, and a text that
  // is longer than this is formatted but not checked.
  size_t clickhouse_max_query_size = 0;
};

struct FormatStats {
  size_t cache_hits = 0;
  size_t cache_misses = 0;
  size_t deduplicated = 0;
};

// A text that was formatted, with a thing that its author must know. The text is the answer anyway.
struct FormatWarning {
  std::string code;
  std::string message;
};

struct FormatOutcome {
  FormatCache::ValuePtr formatted;
  FormatQueryFailureKind failure = FormatQueryFailureKind::none;
  std::string error;
  // A failure of ClickHouse: the byte offset (from 0) in the text that the caller sent, where ClickHouse stopped, when it says. The offset is
  // in that text, not in the text that was sent to ClickHouse (names between backticks, heredocs and literals on many lines change it).
  std::optional<size_t> error_offset;
  // The formatter laid the text out in a way that ClickHouse reads as another statement: `formatted` is the text as it was written.
  std::optional<FormatWarning> warning;
  bool ok() const { return failure == FormatQueryFailureKind::none && formatted != nullptr; }
};

// The texts of one request. The duplicates of a batch (an editor buffer twice) are formatted once.
class FormatBatch {
public:
  FormatBatch(FormatCache* cache, FormatSettings settings, FormatQueryPort& port);

  FormatOutcome format(std::string sql);
  const FormatStats& stats() const { return stats_; }

private:
  std::optional<FormatWarning> check_meaning(const std::string& before, const std::string& after);

  FormatCache* cache_;
  FormatSettings settings_;
  FormatQueryPort& port_;
  FormatStats stats_;
  std::unordered_map<std::string, FormatOutcome> request_results_;
};

// A batch gives one answer for each text. A text that fails does not fail the others, and the texts that come after the time of the
// batch or after a stop get no work: they are Skipped (the client has their text, and asks again for them).
enum class FormatItemStatus { Formatted, Error, Skipped };

struct FormatItem {
  FormatItemStatus status = FormatItemStatus::Skipped;
  // Formatted: `formatted`. Error: `failure` and `error`. Skipped: `skipped_for_stop` says why: true when `stop` ended it
  // (the caller went away or the server stops), false when the time of the batch ran out.
  FormatOutcome outcome;
  bool skipped_for_stop = false;
};

struct FormatBatchLimits {
  // The texts that start after it are Skipped. A text that runs has its own bound (postprocess_format_query, formatQuery).
  std::chrono::steady_clock::time_point deadline{};
  // True when the caller went away or the server stops: the rest is Skipped (asked before each text).
  std::function<bool()> stop;
};

std::vector<FormatItem> format_texts(FormatBatch& batch, const std::vector<std::string>& texts, const FormatBatchLimits& limits);

// The steps of the text that need no ClickHouse (public for the tests).

// True for an INSERT ... VALUES at the top level: its rows are data.
bool has_top_level_values_insert(std::string_view sql);
// For an INSERT ... FORMAT <name>, the offset just past the name (the payload may follow); npos when there is no such statement.
size_t insert_format_name_end(std::string_view sql);
// `sql` with the reserved words that are used as an alias written between backticks (formatQuery would refuse them). `*quoted` gets the
// range of each such word in `sql` (two bytes are added for each).
std::string quote_reserved_aliases_for_format_query(std::string_view sql, std::vector<std::pair<size_t, size_t>>* quoted = nullptr);

// The byte offset (from 0) in the text of the user of the byte `sent_offset` of the text that was sent to ClickHouse. That text is the text
// of the user (`masked` is what the heredocs and the literals on many lines were swapped for, `masks` the swaps) with the `quoted` words
// written between backticks (quote_reserved_aliases_for_format_query).
size_t offset_in_user_text(size_t sent_offset, const std::vector<std::pair<size_t, size_t>>& quoted, const SqlHeredocMask& masks,
                           std::string_view masked);
// `message` of ClickHouse with its "position N" and its "(line L, col C)" rewritten for `offset` (from 0) in `text`.
std::string rebase_error_position(std::string message, std::string_view text, size_t offset);

// True when the rows of an INSERT ... VALUES are the same tokens in the two texts (the layout of the rows may differ, and so may the commas
// between the rows).
bool values_rows_unchanged(std::string_view before, std::string_view after);

} // namespace chdash
