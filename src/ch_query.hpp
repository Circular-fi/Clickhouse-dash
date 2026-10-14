#pragma once

// Every statement that ChDash sends to ClickHouse goes through the functions of this file
// (docs/configuration.md, "The bounds of the queries"). They keep three promises.
//
// 1. A connection that a statement left in an unknown state is never used again as it is. A statement
//    ends in a known state when ClickHouse ends it: the end of the stream, or an error that the server
//    sends (the error is the last packet of the statement). Anything else (a callback that throws, a socket
//    error, a receive timeout, a protocol error) can leave packets of the statement in the socket. The
//    connection is then marked: the pool closes it instead of lending it again, and a next statement on
//    the same lease opens a new socket first.
// 2. A statement carries the bounds of its request (ChQueryScope): log_comment, max_execution_time (what
//    remains of the deadline of the request), max_memory_usage, and the read and result caps and readonly = 2
//    when the route sets them. A bound is never
//    looser than the settings profile of the ClickHouse user: each connection reads the profile once
//    (getSetting) and the smaller value goes. A user with readonly = 1 cannot change a setting: its
//    statements get none. A SETTINGS clause in the SQL wins over all of them.
// 3. A statement of a request whose caller went away stops: the next progress or data packet throws
//    ChQueryCanceled, the connection is marked, and its socket is closed, which makes ClickHouse cancel it.
//
// The scope is a property of the thread (one HTTP request, one run, one export). A later RequestContext
// can carry it explicitly; until then the functions read ChQueryScope::current().

#include <clickhouse/block.h>
#include <clickhouse/client.h>
#include <clickhouse/query.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace chdash {

// The bounds and the label of the statements of one scope. 0 or empty: not set by ChDash.
struct ChQueryLimits {
  std::string log_comment;
  // max_execution_time = the seconds that remain before it (at least 1). A statement that would start
  // after it fails at once with TIMEOUT_EXCEEDED (159), without reaching ClickHouse.
  std::chrono::steady_clock::time_point deadline{};
  int64_t max_execution_time_s = 0;  // a cap of each statement, with the deadline: the smaller one
  std::string timeout_overflow_mode;  // sent with max_execution_time: "throw" or "break"; empty: the profile's
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  std::string read_overflow_mode;  // sent with max_rows_to_read: "throw" or "break"; empty: the profile's
  uint64_t max_result_rows = 0;
  uint64_t max_result_bytes = 0;
  std::string result_overflow_mode;  // sent with a result cap: "throw" or "break"; empty: the profile's
  // readonly = 2: a statement that writes fails, the settings stay changeable. Sent when the profile
  // has readonly = 0.
  bool read_only = false;
  // True when the caller went away (the browser closed the connection). Asked at most every 200 ms.
  std::function<bool()> canceled;
  // A new query_id for each statement of the scope (ch_statement_query_id): the statements of a call of MCP are named for their
  // key and their tool (mcp_cost.hpp). Empty: ClickHouse names each statement. A query_id is a field of the statement, not a
  // setting: a readonly = 1 user gets it too, and no SETTINGS clause changes it.
  std::function<std::string()> query_id;
};

// The limits of the statements that this thread sends while the scope lives. Scopes nest: the inner one
// replaces the outer one until it ends.
class ChQueryScope {
 public:
  explicit ChQueryScope(ChQueryLimits limits);
  ~ChQueryScope();
  ChQueryScope(const ChQueryScope&) = delete;
  ChQueryScope& operator=(const ChQueryScope&) = delete;

  // The limits of this thread; nullptr outside of every scope.
  static const ChQueryLimits* current();

  // A copy of the current limits (empty ones outside of every scope), to open a narrower inner scope.
  static ChQueryLimits current_copy();

 private:
  friend void ch_check_canceled();
  ChQueryLimits limits_;
  ChQueryScope* previous_ = nullptr;
  std::chrono::steady_clock::time_point last_check_{};
  bool canceled_ = false;
};

// The caller of the scope went away: its statements stop.
class ChQueryCanceled : public std::runtime_error {
 public:
  ChQueryCanceled() : std::runtime_error("canceled: the client closed the connection") {}
};

// Throws ChQueryCanceled when the caller of the current scope went away.
void ch_check_canceled();

// The query_id of a statement that this thread is about to build: the one that the scope makes, or "" (ClickHouse names it).
// Every clickhouse::Query of ChDash is built with it, or with an id of its own (a run, an export, Deep Analyze).
std::string ch_statement_query_id();

// The statements. Each one applies the limits of the current scope, keeps the connection state of point 1,
// and throws what ClickHouse or the callback throws.
void ch_select(clickhouse::Client& client, const std::string& sql,
               const std::function<void(const clickhouse::Block&)>& on_block);
// on_block returns false to stop reading: ClickHouse gets a Cancel packet, the rest of the stream is read
// and dropped, and the connection stays usable (no KILL QUERY, no new socket).
// The same with query parameters ({name:Type} in the SQL, set with SetParam): a value that is sent apart from the text is never parsed
// as SQL, and the text does not change with it. Use SqlParams (sql_params.hpp) for what a user wrote or a name that can hold a quote
// mark or a backslash: one String parameter for each value. An Array(String) is the text of sql::quote_array (sql_literal.hpp), which is
// right only for values without a quote mark or a backslash (the hexadecimal trace ids).
using ChParams = std::vector<std::pair<std::string, std::string>>;
void ch_select(clickhouse::Client& client, const std::string& sql, const ChParams& params,
               const std::function<void(const clickhouse::Block&)>& on_block);
void ch_select_cancelable(clickhouse::Client& client, const std::string& sql,
                          const std::function<bool(const clickhouse::Block&)>& on_block);
void ch_execute(clickhouse::Client& client, const std::string& sql);
inline void ch_execute(clickhouse::Client& client, const char* sql) { ch_execute(client, std::string(sql)); }
// The callbacks and the settings of `query` stay as the caller set them; a setting that the caller set is
// never replaced by the one of the scope.
void ch_execute(clickhouse::Client& client, const clickhouse::Query& query);

// The connections. Every clickhouse::Client of ChDash comes from ch_open_client: the state of point 1 and
// what the settings profile allows are kept for it until it is destroyed.
struct ChClientDeleter {
  void operator()(clickhouse::Client* client) const noexcept;
};
using ChClientPtr = std::unique_ptr<clickhouse::Client, ChClientDeleter>;
ChClientPtr ch_open_client(const clickhouse::ClientOptions& options);

// True when a statement left the connection in an unknown state, or when ch_mark_dirty marked it.
bool ch_connection_dirty(const clickhouse::Client& client) noexcept;
// Marks a connection that must not be lent again (session state that a USE or SET changed, for example).
void ch_mark_dirty(const clickhouse::Client& client) noexcept;

// The settings that a statement gets, from the limits and the profile of the user (point 2). Pure: the
// native tests check it without a server.
struct ChSettingsProfile {
  bool known = false;  // false: the profile could not be read; no setting is sent
  uint64_t readonly = 0;
  double max_execution_time = 0;  // seconds; 0 = none
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  uint64_t max_result_rows = 0;
  uint64_t max_result_bytes = 0;
};
std::vector<std::pair<std::string, std::string>> ch_query_settings(
    const ChQueryLimits& limits, const ChSettingsProfile& profile, std::chrono::steady_clock::time_point now);

// What the settings profile of the user of `client` allows: read once for the connection (the probe of point 2), then
// kept. known = false when it could not be read (an old server) or when `client` did not come from ch_open_client.
ChSettingsProfile ch_connection_profile(clickhouse::Client& client);

// The guard rails of one statement of the MCP tools (docs/mcp.md, "Per-request guard rails"). Not a scope: the tools send
// their settings themselves, and a profile of the user decides what of them can be sent.
struct ChMcpLimits {
  int64_t max_rows = 0;
  int64_t max_bytes = 0;
  int64_t timeout_seconds = 0;
  int64_t max_memory_bytes = 0;
  int64_t max_rows_to_read = 0;  // 0 = none
  int64_t sql_bytes = 0;         // the size of the statement: max_query_size follows it
  std::string log_comment;
};

struct ChMcpSettings {
  std::vector<std::pair<std::string, std::string>> settings;
  // What the statement can return, when the profile of the user cuts it earlier than the guard rails: a result that
  // reaches one of them may have been cut by ClickHouse, whose own cut the caller cannot see.
  int64_t max_rows = 0;
  int64_t max_bytes = 0;
  bool rows_cut_by_profile = false;
  bool bytes_cut_by_profile = false;
};

// The settings of a MCP statement for a user whose profile is `profile`:
// - readonly = 1 when the profile leaves readonly at 0 (the statement cannot change anything, nor any limit). A profile
//   that has readonly = 2 or 1 already has it: ClickHouse refuses to change the setting, even to 1.
// - readonly = 1 in the profile: no setting at all, ClickHouse refuses every one. The profile then holds the limits.
// - The profile wins: a limit that the profile sets is sent only when the guard rail is smaller (the request can only
//   lower it, never raise it), and the rows and bytes the statement returns follow the smaller one.
// An unreadable profile gets everything, as a user without a profile would.
ChMcpSettings ch_mcp_settings(const ChMcpLimits& limits, const ChSettingsProfile& profile);

}  // namespace chdash
