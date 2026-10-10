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

#include <cstddef>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>

namespace chdash {

// formatQuery of ClickHouse, for one text.
class FormatQueryPort {
public:
  virtual ~FormatQueryPort() = default;
  virtual FormatQueryResult format_query(const std::string& sql, size_t max_bytes) = 0;
};

struct FormatSettings {
  int line_width = 80;
  // false: format from scratch (the idempotence checks of the formatter suite run the formatter on its own output).
  bool use_cache = true;
  // What the layout depends on besides the text: the host and its ClickHouse version (formatQuery may answer another layout after
  // an upgrade).
  std::string cache_scope;
  size_t max_sql_bytes = 500 * 1024;
};

struct FormatStats {
  size_t cache_hits = 0;
  size_t cache_misses = 0;
  size_t deduplicated = 0;
};

struct FormatOutcome {
  FormatCache::ValuePtr formatted;
  FormatQueryFailureKind failure = FormatQueryFailureKind::none;
  std::string error;
  bool ok() const { return failure == FormatQueryFailureKind::none && formatted != nullptr; }
};

// The texts of one request. The duplicates of a batch (an editor buffer twice) are formatted once.
class FormatBatch {
public:
  FormatBatch(FormatCache* cache, FormatSettings settings, FormatQueryPort& port);

  FormatOutcome format(std::string sql);
  const FormatStats& stats() const { return stats_; }

private:
  FormatCache* cache_;
  FormatSettings settings_;
  FormatQueryPort& port_;
  FormatStats stats_;
  std::unordered_map<std::string, FormatCache::ValuePtr> request_results_;
};

// The steps of the text that need no ClickHouse (public for the tests).

// True for an INSERT ... VALUES at the top level: its rows are data.
bool has_top_level_values_insert(std::string_view sql);
// For an INSERT ... FORMAT <name>, the offset just past the name (the payload may follow); npos when there is no such statement.
size_t insert_format_name_end(std::string_view sql);
// `sql` with the reserved words that are used as an alias written between backticks (formatQuery would refuse them).
std::string quote_reserved_aliases_for_format_query(std::string_view sql);

} // namespace chdash
