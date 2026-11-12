#pragma once

// Every statement that ChDash sends to ClickHouse passes through the functions of this file.
// See docs/configuration.md, "The bounds of the queries". The functions keep three promises.
//
// 1. A connection that a statement left in an unknown state is never used again as it is.
//    A statement ends in a known state when ClickHouse ends it.
//    This happens at the end of the stream, or after an error that the server sends.
//    The error is the last packet of the statement.
//
//    Other events can leave packets of the statement in the socket.
//    Examples are a callback that throws, a socket error, a receive timeout and a protocol error.
//    The connection is then marked. The pool closes it. The pool never lends it again.
//    A next statement on the same lease opens a new socket first.
//
// 2. A statement carries the bounds of its request (ChQueryScope): log_comment, max_execution_time (what remains of the deadline of the request), max_memory_usage, and the read and result caps.
//    The route can set readonly = 2.
//    A bound is never looser than the settings profile of the ClickHouse user.
//
//    Each connection reads the profile once (getSetting). The smaller value applies.
//    A user with readonly = 1 cannot change a setting. Its statements get none.
//    A SETTINGS clause in the SQL wins over all of them.
//
// 3. A statement of a request whose caller went away stops.
//    The next progress or data packet throws ChQueryCanceled. The connection is marked, and its socket is closed. This makes ClickHouse cancel the statement.
//
// The scope is a property of the thread. One HTTP request, one run or one export has one scope.
// A later RequestContext can carry the scope explicitly. Until then, the functions read ChQueryScope::current().

#include "access_ceilings.hpp"

#include <clickhouse/block.h>
#include <clickhouse/client.h>
#include <clickhouse/query.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

// The record of one statement, for the trace of its request (docs/server-telemetry.md). It never holds the text or the data of the statement.
struct ChStatementRecord {
  // The first word of the statement, in upper case (SELECT, SHOW, DESCRIBE, EXPLAIN ...). It is "" when the word is not known.
  std::string operation;
  std::string query_id;
  std::string server_address;  // the endpoint of the connection; "" when it is not known
  int server_port = 0;
  std::chrono::system_clock::time_point started{};
  std::chrono::system_clock::time_point ended{};
  // The code of the ClickHouse error that ended the statement. It is 0 when the server sent no code.
  int error_code = 0;
  // The value is "" when the statement ended well.
  // Otherwise, the value is the server error code as text ("159").
  // The value is "canceled" when the caller went away. It is "connection" for a socket error, or "client" for another error of the client.
  std::string error_type;
};

// The first word of `sql` gives ChStatementRecord::operation. The code skips comments, spaces and open parentheses.
// WITH gives SELECT. DESC gives DESCRIBE.
// The value is "" when the word is not one of the known statements.
std::string ch_statement_operation(std::string_view sql);

// The bounds of a statement that a ceiling of a grant can lower (apply_ceilings). ChQueryLimits::before_ceilings keeps the value that
// these fields had before the first ceiling lowered them.
struct ChQueryBounds {
  int64_t max_execution_time_s = 0;
  std::string timeout_overflow_mode;
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  uint64_t max_bytes_to_read = 0;
  std::string read_overflow_mode;
  uint64_t max_result_rows = 0;
  uint64_t max_result_bytes = 0;
  std::string result_overflow_mode;
};

// The bounds and the label of the statements of one scope.
// A value of 0 or an empty value means that ChDash does not set it.
struct ChQueryLimits {
  std::string log_comment;
  // max_execution_time is the number of seconds that remain before the deadline (at least 1).
  // A statement that starts after the deadline fails at once with TIMEOUT_EXCEEDED (159).
  // It does not reach ClickHouse.
  std::chrono::steady_clock::time_point deadline{};
  int64_t max_execution_time_s = 0;  // a cap of each statement, with the deadline: the smaller one
  std::string timeout_overflow_mode;  // sent with max_execution_time: "throw" or "break"; empty: the profile's
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  uint64_t max_bytes_to_read = 0;
  std::string read_overflow_mode;  // sent with max_rows_to_read and max_bytes_to_read: "throw" or "break"; empty: the profile's
  uint64_t max_result_rows = 0;
  uint64_t max_result_bytes = 0;
  std::string result_overflow_mode;  // sent with a result cap: "throw" or "break"; empty: the profile's
  // readonly = 2: a statement that writes fails. The settings stay changeable.
  // ChDash sends it when the profile has readonly = 0.
  bool read_only = false;
  // readonly = 1: a statement that writes fails, and no setting can change.
  // The access of humans (docs/access.md) sets it for a run of a user.
  // That user has query.run.read and not query.run.write.
  // It is also sent when the settings profile is not known (fail closed).
  // It wins over read_only.
  bool read_only_strict = false;
  // True when the caller went away (the browser closed the connection). The code asks at most every 200 ms.
  std::function<bool()> canceled;
  // The ceilings of the grant that apply to the statements of this scope (apply_ceilings sets them). They already lower the bounds above.
  // A statement that ChDash builds (ch_select, ch_select_cancelable and ch_execute with a text) also counts the rows and the bytes read, the
  // rows of the result and the time of the statement, and it ends with ChCeilingExceeded past a ceiling. A SETTINGS clause in the SQL of
  // the statement, and a profile with readonly = 1, thus never loosen a ceiling.
  AccessCeilings ceilings;
  // The bounds of this scope before the first ceiling lowered them. apply_ceilings keeps them, so that an internal statement can go back
  // to them (ChInternalScope). It is empty when no ceiling applies.
  std::optional<ChQueryBounds> before_ceilings;
  // True for the statements that ChDash writes for its own work and not as a data statement of a person (ChInternalScope). The ceilings of a
  // grant never apply to such a statement: apply_ceilings does nothing for it, and its scope holds no ceiling.
  bool internal = false;
  // The scope gives each statement a new query_id (ch_statement_query_id).
  // The statements of an MCP call are named for their key and their tool (mcp_cost.hpp).
  // An empty value means that ClickHouse names each statement.
  // A query_id is a field of the statement, not a setting. A readonly = 1 user gets it too, and no SETTINGS clause changes it.
  std::function<std::string()> query_id;
  // The code calls this after each statement of the scope that reached the point where it is sent (its end, or its error).
  // An MCP call makes a child span of the statement.
  // A copy of the limits (ChQueryScope::current_copy) keeps the callback. It can be called from more than one thread.
  std::function<void(const ChStatementRecord&)> on_statement;
};

// The limits of the statements that this thread sends while the scope lives. Scopes nest.
// The inner scope replaces the outer scope until it ends.
class ChQueryScope {
 public:
  explicit ChQueryScope(ChQueryLimits limits);
  ~ChQueryScope();
  ChQueryScope(const ChQueryScope&) = delete;
  ChQueryScope& operator=(const ChQueryScope&) = delete;

  // The limits of this thread. The value is nullptr outside of every scope.
  static const ChQueryLimits* current();

  // A copy of the current limits. Outside of every scope, the copy is empty. Use the copy to open a narrower inner scope.
  static ChQueryLimits current_copy();

 private:
  friend void ch_check_canceled();
  ChQueryLimits limits_;
  ChQueryScope* previous_ = nullptr;
  std::chrono::steady_clock::time_point last_check_{};
  bool canceled_ = false;
};

// The limits of an internal statement (ChQueryLimits::internal): the limits `limits` without the ceilings of the grant. The bounds go back to
// the value that they had before the ceilings (before_ceilings). The deadline, the cancel function, the label and the readonly mode stay.
// This function is pure. The native tests check it without a server.
ChQueryLimits ch_internal_limits(ChQueryLimits limits);

// The statements of this thread are internal while the object lives: they ignore the ceilings of the grant. Use it for each statement that
// ChDash writes for its own work: the discovery of the ACL (CHECK GRANT, SHOW, zero-row probes), the probes of the capabilities of the
// server, the reads of the schema for the editor, the lookup of query_log and the flush of the logs. Do not use it for a statement of a
// person (the Query page, an export) or for a statement that a page runs to show data: the ceilings bound these. Scopes nest, and the
// object ends the internal scope when it goes out of scope. The internal scope goes back to the bounds of before_ceilings. A scope that
// changes a bound after apply_ceilings, and then runs an internal statement, must reset before_ceilings (see handle_export_stream).
class ChInternalScope {
 public:
  ChInternalScope();
  ChInternalScope(const ChInternalScope&) = delete;
  ChInternalScope& operator=(const ChInternalScope&) = delete;

 private:
  std::optional<ChQueryScope> scope_;
};

// True when the statements of this thread carry a ceiling of a grant: the current scope is not internal and holds at least one ceiling.
// A shared cache of the answers of the pages (docs/access.md, "Shared caches and ceilings") then gives no kept answer and keeps no new
// answer: the work runs for this request alone, so the ceilings bound it. A cache hit would run no statement, and no ceiling would apply.
bool ch_scope_has_ceilings();

// A ceiling of a grant that a statement of this thread went past (docs/access.md, "A result past a ceiling"): a row or byte ceiling,
// max_rows_read, max_read_size, max_rows or max_result_size, and its value. The route then answers a refusal that names the ceiling
// (HTTP 403, ceiling_exceeded), never a cut answer.
struct ChCeilingRefusal {
  std::string ceiling;
  uint64_t value = 0;
};
// Keep the first refusal of this thread. The backstop of the statements of ChDash and the limit errors of ClickHouse call it.
void ch_note_ceiling_refusal(ChCeilingRefusal refusal);
// The kept refusal of this thread, and forget it.
std::optional<ChCeilingRefusal> ch_take_ceiling_refusal();
// The ceiling of `limits` that set the bound of a ClickHouse limit error with `code` (158 rows read, 307 bytes read, 396 rows or bytes of
// the result; `message` tells "max rows" from "max bytes"). nullopt when the scope has no ceiling, or when the bound of the route (the
// configuration) is lower than the ceiling: then the error is not the one of the grant. Pure: the native tests check it.
std::optional<ChCeilingRefusal> ch_ceiling_of_server_error(int code, std::string_view message, const ChQueryLimits& limits);

// The refusals of one route (Server, the routes of the pages): the object takes the refusal of an outer request (an MCP tool that calls
// the route in the process) away and gives it back at its end, so the route sees only its own. Without an outer request, an old refusal
// of the thread is dropped.
class ChCeilingRefusalScope {
 public:
  explicit ChCeilingRefusalScope(bool nested);
  ~ChCeilingRefusalScope();
  ChCeilingRefusalScope(const ChCeilingRefusalScope&) = delete;
  ChCeilingRefusalScope& operator=(const ChCeilingRefusalScope&) = delete;
  // The refusal of a statement of this route, if one went past a ceiling.
  std::optional<ChCeilingRefusal> take();

 private:
  std::optional<ChCeilingRefusal> outer_;
};

// The caller of the scope went away. Its statements stop.
class ChQueryCanceled : public std::runtime_error {
 public:
  ChQueryCanceled() : std::runtime_error("canceled: the client closed the connection") {}
};

// A statement went past a ceiling of the grant. The client counted it and stopped it (ChQueryLimits::ceilings). `code` is the code of the
// ClickHouse error that has the same meaning: 158 (rows), 307 (bytes) or 159 (time). The answer of a route follows this code
// (classify_clickhouse_error). The connection is not clean: the statement did not end, so the pool closes it.
class ChCeilingExceeded : public std::runtime_error {
 public:
  ChCeilingExceeded(int code, const std::string& text) : std::runtime_error(text), code_(code) {}
  int code() const { return code_; }

 private:
  int code_;
};

// Throws ChQueryCanceled when the caller of the current scope went away.
void ch_check_canceled();

// The query_id of a statement that this thread is about to build.
// It is the one that the scope makes, or "" when ClickHouse names the statement.
// Every clickhouse::Query of ChDash uses this query_id. Otherwise it uses an id of its own (a run, an export, Deep Analyze).
std::string ch_statement_query_id();

// The statements. Each one applies the limits of the current scope and keeps the connection state of point 1.
// It throws what ClickHouse or the callback throws.
void ch_select(clickhouse::Client& client, const std::string& sql,
               const std::function<void(const clickhouse::Block&)>& on_block);
// on_block returns false to end the read. ClickHouse receives a Cancel packet.
// The rest of the stream is read and dropped. The connection stays usable: there is no KILL QUERY and no new socket.
//
// Query parameters ({name:Type} in the SQL, set with SetParam) work the same way. A value sent apart from the text is never parsed as SQL. The text does not change with it.
// Use SqlParams (sql_params.hpp) for what a user wrote, or for a name that can hold a quote mark or a backslash. Use one String parameter for each value.
// An Array(String) is the text of sql::hex_id_array (sql_literal.hpp).
//
// That text is right only for values without a quote mark or a backslash, so it keeps only hexadecimal trace ids.
using ChParams = std::vector<std::pair<std::string, std::string>>;
void ch_select(clickhouse::Client& client, const std::string& sql, const ChParams& params,
               const std::function<void(const clickhouse::Block&)>& on_block);
void ch_select_cancelable(clickhouse::Client& client, const std::string& sql,
                          const std::function<bool(const clickhouse::Block&)>& on_block);
void ch_execute(clickhouse::Client& client, const std::string& sql);
inline void ch_execute(clickhouse::Client& client, const char* sql) { ch_execute(client, std::string(sql)); }
// The callbacks and the settings of `query` stay as the caller set them.
// The scope never replaces a setting that the caller set.
void ch_execute(clickhouse::Client& client, const clickhouse::Query& query);

// The connections. Every clickhouse::Client of ChDash is created by ch_open_client.
// The state of point 1, and what the settings profile allows, are kept for the client until it is destroyed.
struct ChClientDeleter {
  void operator()(clickhouse::Client* client) const noexcept;
};
using ChClientPtr = std::unique_ptr<clickhouse::Client, ChClientDeleter>;
ChClientPtr ch_open_client(const clickhouse::ClientOptions& options);

// True when a statement left the connection in an unknown state, or when ch_mark_dirty marked it.
bool ch_connection_dirty(const clickhouse::Client& client) noexcept;
// Marks a connection that must not be lent again. For example, a USE or SET statement changed its session state.
void ch_mark_dirty(const clickhouse::Client& client) noexcept;

// The settings that a statement gets are derived from the limits and the profile of the user (point 2).
// This function is pure. The native tests check it without a server.
struct ChSettingsProfile {
  bool known = false;  // false: the profile could not be read; no setting is sent (only readonly = 1 of read_only_strict)
  uint64_t readonly = 0;
  double max_execution_time = 0;  // seconds; 0 = none
  uint64_t max_memory_usage = 0;
  uint64_t max_rows_to_read = 0;
  uint64_t max_bytes_to_read = 0;
  uint64_t max_result_rows = 0;
  uint64_t max_result_bytes = 0;
};
std::vector<std::pair<std::string, std::string>> ch_query_settings(
    const ChQueryLimits& limits, const ChSettingsProfile& profile, std::chrono::steady_clock::time_point now);

// The settings profile of the user of `client` defines what is allowed. The code reads it once for the connection (the probe of point 2), then keeps it.
// known = false when the code cannot read the profile (an old server) or when ch_open_client did not create `client`.
ChSettingsProfile ch_connection_profile(clickhouse::Client& client);

// The guard rails of one statement of the MCP tools (docs/mcp.md, "Per-request guard rails"). This is not a scope.
// The tools send their own settings. The profile of the user decides which of these settings can be sent.
struct ChMcpLimits {
  int64_t max_rows = 0;
  int64_t max_bytes = 0;
  int64_t timeout_seconds = 0;
  int64_t max_memory_bytes = 0;
  int64_t max_rows_to_read = 0;  // 0 = none
  int64_t max_bytes_to_read = 0; // 0 = none
  int64_t sql_bytes = 0;         // the size of the statement: max_query_size follows it
  std::string log_comment;
  // The statement changes data (the write account of the host, mcp_write_uri): the settings carry no readonly = 1.
  bool allow_write = false;
};

struct ChMcpSettings {
  std::vector<std::pair<std::string, std::string>> settings;
  // The profile has readonly = 1: ClickHouse refuses every setting of the statement, so `settings` is empty and no limit reaches the server.
  // The caller must count what it can itself (the backstop of a ceiling) and refuse what it cannot count (a memory ceiling).
  bool settings_refused = false;
  // This describes what the statement can return when the profile of the user cuts it earlier than the guard rails.
  // A result that reaches one of the guard rails may have been cut by ClickHouse. The caller cannot see that cut.
  int64_t max_rows = 0;
  int64_t max_bytes = 0;
  bool rows_cut_by_profile = false;
  bool bytes_cut_by_profile = false;
};

// The settings of an MCP statement for a user whose profile is `profile`:
// - readonly = 1 when the profile leaves readonly at 0. Then the statement cannot change anything, nor any limit.
//   A profile that has readonly = 2 or 1 already has it. ClickHouse refuses to change the setting, even to 1.
//
// - readonly = 1 in the profile: no setting at all. ClickHouse refuses every one. The profile then holds the limits.
// - The profile wins. A limit that the profile sets is sent only when the guard rail is smaller.
//
//   The request can only lower the limit, never raise it. The rows and bytes that the statement returns follow the smaller one.
// An unreadable profile gets everything, as a user without a profile does.
ChMcpSettings ch_mcp_settings(const ChMcpLimits& limits, const ChSettingsProfile& profile);

}  // namespace chdash
