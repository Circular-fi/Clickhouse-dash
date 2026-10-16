#pragma once

// SQL formatting as a service. The text goes in, and the formatted text comes out.
// The service needs one call from ClickHouse, formatQuery. The call is behind a port.
// The server gives the port the pooled connections of the host. A test gives the port a fake.
// The route (api_format.cpp) is an adapter. It reads the JSON, chooses the host, calls this service, and writes the answer.
//
// The service formats a statement in these steps.
// First, it sets aside an inline INSERT payload, because the payload is data.
// Next, it swaps each heredoc and each text that spans lines for a placeholder of the same width.
// A text with comments, or with an INSERT ... VALUES, is laid out by the local formatter. formatQuery would drop the comments.
//
// Any other text goes through formatQuery first.
// Last, it puts back the exact spelling of the names and of the texts that the user wrote. It also puts back the heredocs and the payload.

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

// The formatter asks ClickHouse for two things, for one text: formatQuery and EXPLAIN AST.
class FormatQueryPort {
public:
  virtual ~FormatQueryPort() = default;
  virtual FormatQueryResult format_query(const std::string& sql, size_t max_bytes) = 0;
  // The tree that ClickHouse reads from the text (EXPLAIN AST) is in `formatted_sql`. Two layouts of one statement give the same tree.
  // A text with and without its comments gives the same tree too. The check of the meaning compares these trees (format_service.cpp, FormatBatch::check_meaning).
  virtual FormatQueryResult explain_ast(const std::string& sql, size_t max_bytes) = 0;
};

struct FormatSettings {
  int line_width = 80;
  // false: the formatter starts from scratch. The idempotence checks of the formatter suite run the formatter on its own output.
  bool use_cache = true;
  // The layout depends on the text, and also on the host and its ClickHouse version.
  // formatQuery can answer with another layout after an upgrade.
  std::string cache_scope;
  // The largest text that the service accepts.
  size_t max_sql_bytes = 500 * 1024;
  // max_query_size of the ClickHouse server, from its health check. The value is 0 when it is not known.
  // ClickHouse refuses a text that is longer than this when it parses the text (formatQuery and EXPLAIN AST).
  // So the service refuses a longer text here, with a message that says so.
  // A text that is longer than this is formatted, but it is not checked.
  size_t clickhouse_max_query_size = 0;
};

struct FormatStats {
  size_t cache_hits = 0;
  size_t cache_misses = 0;
  size_t deduplicated = 0;
};

// A text that was formatted, with a fact that its author must know. The text is still the answer.
struct FormatWarning {
  std::string code;
  std::string message;
};

struct FormatOutcome {
  FormatCache::ValuePtr formatted;
  FormatQueryFailureKind failure = FormatQueryFailureKind::none;
  std::string error;
  // A failure of ClickHouse. This is the byte offset (from 0) in the text that the caller sent, where ClickHouse stopped, if ClickHouse says so.
  // The offset is in that text, not in the text that was sent to ClickHouse.
  // Names between backticks, heredocs, and literals on many lines change the offset.
  std::optional<size_t> error_offset;
  // The formatter laid out the text in a way that ClickHouse reads as another statement. In this case, `formatted` is the text as it was written.
  std::optional<FormatWarning> warning;
  bool ok() const { return failure == FormatQueryFailureKind::none && formatted != nullptr; }
};

// The texts of one request. The duplicates in a batch, for example an editor buffer that is sent twice, are formatted once.
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

// A batch gives one answer for each text. A text that fails does not fail the other texts.
// A text that comes after the time limit of the batch, or after a stop, gets no work. Such a text is Skipped.
// The client keeps the text, and asks again for it.
enum class FormatItemStatus { Formatted, Error, Skipped };

struct FormatItem {
  FormatItemStatus status = FormatItemStatus::Skipped;
  // Formatted: the value is in `formatted`. Error: the values are in `failure` and `error`. Skipped: `skipped_for_stop` gives the reason.
  // The value is true when `stop` ended the batch for this text. This happens when the caller went away or the server stops.
  // The value is false when the time of the batch ran out.
  FormatOutcome outcome;
  bool skipped_for_stop = false;
};

struct FormatBatchLimits {
  // The texts that start after this time are Skipped. A text that runs has its own bound (postprocess_format_query, formatQuery).
  std::chrono::steady_clock::time_point deadline{};
  // The function returns true when the caller went away or the server stops. The rest is then Skipped.
  // `stop` is called before each text.
  std::function<bool()> stop;
};

std::vector<FormatItem> format_texts(FormatBatch& batch, const std::vector<std::string>& texts, const FormatBatchLimits& limits);

// The steps of the text that need no ClickHouse. These steps are public for the tests.

// Returns true for an INSERT ... VALUES at the top level. Its rows are data.
bool has_top_level_values_insert(std::string_view sql);
// For an INSERT ... FORMAT <name>, returns the offset just past the name. A payload can follow the name.
// Returns npos when there is no such statement.
size_t insert_format_name_end(std::string_view sql);
// Returns `sql` with the reserved words that are used as an alias between backticks. formatQuery would refuse these words.
// If `quoted` is not null, it receives the range of each such word in `sql`. Two bytes are added for each word.
std::string quote_reserved_aliases_for_format_query(std::string_view sql, std::vector<std::pair<size_t, size_t>>* quoted = nullptr);

// Returns the byte offset (from 0) in the text of the user, for the byte `sent_offset` of the text that was sent to ClickHouse.
// The text that was sent is the text of the user, with changes. `masked` is what the heredocs and the literals on many lines were swapped for.
// `masks` holds the swaps. The changes also include the `quoted` words, which are written between backticks (quote_reserved_aliases_for_format_query).
size_t offset_in_user_text(size_t sent_offset, const std::vector<std::pair<size_t, size_t>>& quoted, const SqlHeredocMask& masks,
                           std::string_view masked);
// Returns the `message` of ClickHouse, with its "position N" and its "(line L, col C)" rewritten for `offset` (from 0) in `text`.
std::string rebase_error_position(std::string message, std::string_view text, size_t offset);

// Returns true when the rows of an INSERT ... VALUES have the same tokens in the two texts.
// The layout of the rows can differ, and so can the commas between the rows.
bool values_rows_unchanged(std::string_view before, std::string_view after);

} // namespace chdash
