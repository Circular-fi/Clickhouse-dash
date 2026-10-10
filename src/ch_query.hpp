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

// The statements. Each one applies the limits of the current scope, keeps the connection state of point 1,
// and throws what ClickHouse or the callback throws.
void ch_select(clickhouse::Client& client, const std::string& sql,
               const std::function<void(const clickhouse::Block&)>& on_block);
// on_block returns false to stop reading: ClickHouse gets a Cancel packet, the rest of the stream is read
// and dropped, and the connection stays usable (no KILL QUERY, no new socket).
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

}  // namespace chdash
