#pragma once

// The usage of the MCP keys (docs/mcp.md, "Usage of a key"): what ChDash saw of the requests of each key, counted where a
// call writes its audit line (Server::handle_mcp_post). One entry for each key that was used:
// - its last 24 hours by the hour and its last days (mcp.usage_retention_days) by the UTC day. A bucket holds cells: the
//   requests that share a type (a tool call, a protocol request, a 429, a refusal), a method (the tool, or the JSON-RPC
//   method) and a result, with their count, time, rows and bytes. Everything that is shown is summed from the cells;
// - its clients: the clientInfo of `initialize` and the User-Agent of the requests.
// A deleted key keeps its entry until its last day is older than the retention. Never SQL, never data, never a secret.
// The entries are kept in mcp.usage_file, written every minute when something changed and at the stop, atomically (a
// temporary file, fsync, rename, mode 0600), or in memory only when it is not set. One process owns the file: two
// instances that share it overwrite each other's counts. A file that is not valid stops the start; it is never rewritten.

#include "mcp_keys.hpp"

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chdash {

inline constexpr int kMcpUsageFileVersion = 1;
inline constexpr int64_t kMcpUsageMaxRetentionDays = 365;
// The values of each filter of the overview.
inline constexpr size_t kMcpUsageOverviewMaxValues = 20;

// What a request of a key was. The order is the one of the types in the answers.
enum class McpUsageKind {
  ToolCall,     // tools/call of a tool of the catalog (its result: ok or the code of the error of the tool)
  Request,      // every other message: initialize, tools/list, ping, a notification, a JSON-RPC error
  RateLimited,  // 429: the key sent more than rate_limit_per_minute
  Rejected,     // refused before the message was read: 400, 413, 415
};

// One request of a key. The views live while record() runs.
struct McpUsageEvent {
  std::string_view key_id;
  std::string_view key_name;
  std::string_view key_host;    // the host of the key; empty when it names none or several
  std::string_view key_source;  // config or ui
  int64_t at = 0;               // Unix seconds
  McpUsageKind kind = McpUsageKind::Request;
  // Request: the JSON-RPC method of the message, empty when it could not be read. It is counted when it is one of the methods
  // of the protocol (mcp_usage.cpp) and as "other" otherwise: a text that a client chose is never kept.
  std::string_view method;
  std::string_view tool;        // ToolCall: the name of the tool
  std::string_view status;      // ok, the error code of the tool, rpc_error_<n>, or <http status>_<reason>
  int64_t duration_ms = 0;
  uint64_t rows = 0;            // the rows of a result (the tools that build their own SQL; the API tools say 0)
  uint64_t bytes = 0;           // the body of the answer
  std::string_view client_name;     // initialize: clientInfo.name
  std::string_view client_version;  // initialize: clientInfo.version
  std::string_view user_agent;
};

// A key as the usage names it.
struct McpUsageKeyRef {
  std::string id;
  std::string name;
  std::string host;
  std::string source;
};
McpUsageKeyRef mcp_usage_key_ref(const McpKey& key);

// A key of the configuration (its name) or of the page (ui_ and 12 hexadecimal digits).
bool mcp_valid_key_id(std::string_view id);

struct McpUsageOptions {
  std::string file;  // empty: in memory only, since the start
  int64_t retention_days = 90;
  size_t max_deleted = 1000;    // entries of deleted keys; the oldest deletion goes first
  size_t max_cells = 1000000;   // cells of all the buckets; a new one past it is counted in the overflow cell of its type
  size_t max_clients = 8;       // clients of a key; the one seen least recently goes first
};

// A window of the answers: 24h is the current hour and the 23 before it (by the hour); 7d, 30d, 90d and 365d are the last
// days, today included (by the UTC day).
struct McpUsageWindow {
  std::string name;
  int64_t from = 0;  // the start of its first bucket
  int64_t step = 0;  // 3600 or 86400
  size_t points = 0;
};

// The windows that a retention keeps: 24h, then 7d, 30d, 90d and 365d up to it.
std::vector<std::string> mcp_usage_windows(int64_t retention_days);
std::string mcp_usage_default_window(int64_t retention_days);
std::optional<McpUsageWindow> mcp_usage_window(std::string_view name, int64_t retention_days, int64_t now);

// Printable ASCII (another byte is "?"), the spaces at both ends removed, at most `max_bytes`.
std::string mcp_usage_clean(std::string_view text, size_t max_bytes);

// Throws std::runtime_error (a message without the content of the file) when `path` is not a usage file of this ChDash,
// or when the directory of an absent file does not exist.
void mcp_check_usage_file(const std::string& path);

// The parameters of GET /api/mcp/usage/overview (its window apart): what the series is split by, and the filters. A value
// of a filter keeps the requests that have it; the values of a dimension are OR, the dimensions are AND.
struct McpUsageOverviewQuery {
  std::string split = "method";  // key, method, result or type
  std::vector<std::string> keys;     // the ids of keys
  std::vector<std::string> methods;  // a tool or a method of the protocol: [A-Za-z0-9_/]{1,64}
  std::vector<std::string> results;  // [a-z0-9_]{1,64}
  std::vector<std::string> types;    // call, request, limited or rejected
};

// The rules of the parameters of the overview: a value that is repeated counts once, then each one is checked. Nullopt when
// they hold; else the field and the reason (`invalid`, or `too_many` past 20 values) of the 400.
std::optional<McpValidationError> mcp_usage_overview_check(McpUsageOverviewQuery* query);

class McpUsage {
public:
  // Reads the file (an absent file is no usage yet). Throws std::runtime_error when it is not valid.
  McpUsage(McpUsageOptions options, int64_t now);
  McpUsage(const McpUsage&) = delete;
  McpUsage& operator=(const McpUsage&) = delete;

  bool persisted() const { return !options_.file.empty(); }
  int64_t retention_days() const { return options_.retention_days; }
  // Since when the usage is counted: the first start with this file, or the start of the process without one.
  int64_t since() const { return since_; }

  // At the start: the entry of a key that is gone is deleted from now on; a key of the configuration that is back takes
  // its entry again.
  void sync_live_keys(const std::vector<McpUsageKeyRef>& live, int64_t now);
  void record(const McpUsageEvent& event);
  // The key is deleted: its entry stays until its last day is older than the retention. A key that was never used gets an
  // empty entry for 2 hours, so a call that was running when it was deleted is counted as deleted.
  void mark_deleted(const McpUsageKeyRef& key, int64_t now);

  std::unordered_map<std::string, int64_t> last_used_all() const;
  // The key as its entry names it (a deleted key too); nullopt when it has none.
  std::optional<McpUsageKeyRef> entry_key(const std::string& id) const;

  // GET /api/mcp/usage: the live keys in this order (zeros for a key that was not used), then the deleted keys that still
  // have usage, the last deletion first.
  void write_list(McpJsonWriter& w, const std::vector<McpUsageKeyRef>& live, const McpUsageWindow& window, int64_t now) const;
  // GET /api/mcp/keys/<id>/usage. `live` is the key when it exists. False when the key exists nowhere (404).
  bool write_detail(McpJsonWriter& w, const std::string& id, const McpUsageKeyRef* live, const McpUsageWindow& window,
                    int64_t now) const;
  // GET /api/mcp/usage/overview: the requests of every key in a window, cut by the filters of `query` (checked by
  // mcp_usage_overview_check): the totals and the series with all of them, and each facet (the keys, the methods, the results,
  // the types) with all of them but its own. The clients of the keys that the filter keeps (the window does not cut them).
  // `live` names the keys that exist. One entry at a time under the lock, as save() does.
  void write_overview(McpJsonWriter& w, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                      const McpUsageWindow& window, int64_t now) const;

  // Drops what is older than the retention, then writes the file when something changed. False when the write failed:
  // the next save tries again.
  bool save(int64_t now);
  // save() when the last one is a minute old (5 minutes when the file is larger than 8 MiB).
  bool save_if_due(int64_t now);

  // The requests of one type, one method and one result, in one hour or one day. `key` is kind << 24 | method << 12 | result:
  // the method and the result are ids of the Names.
  struct Cell {
    uint32_t key = 0;
    uint64_t count = 0;
    uint64_t duration_ms_sum = 0;
    uint64_t duration_ms_max = 0;
    uint64_t rows = 0;
    uint64_t bytes = 0;
  };
  // The nine totals of some cells (add_to_counters in mcp_usage.cpp is the one place that says what each one counts).
  struct Counters {
    uint64_t requests = 0;
    uint64_t calls = 0;
    uint64_t errors = 0;
    uint64_t rate_limited = 0;
    uint64_t rejected = 0;
    uint64_t duration_ms_sum = 0;
    uint64_t duration_ms_max = 0;
    uint64_t rows = 0;
    uint64_t bytes = 0;
  };
  struct Bucket {
    int64_t start = 0;
    std::vector<Cell> cells;  // by key
  };
  struct Client {
    std::string name;
    std::string version;
    std::string user_agent;
    int64_t first_seen = 0;
    int64_t last_seen = 0;
    uint64_t requests = 0;
  };
  struct Entry {
    McpUsageKeyRef key;
    int64_t first_used = 0;  // 0: never
    int64_t last_used = 0;
    int64_t deleted_at = 0;  // 0: the key exists
    std::vector<Client> clients;
    std::vector<Bucket> hours;  // by start, the last 24 hours
    std::vector<Bucket> days;   // by start, the last retention_days days
  };
  // The names of the methods and of the results: an id of 12 bits in the cells. The fixed names come first (0 other, 1 ok, the
  // methods of the protocol, invalid, unread), then the tools and the results that were counted. `by_id` grows: it is never
  // read outside the lock.
  struct Names {
    std::vector<std::string> by_id;
    std::unordered_map<std::string, uint16_t> ids;
    Names();
    uint16_t intern(std::string_view name);
  };
  struct State {
    int64_t since = 0;
    Names names;
    std::unordered_map<std::string, Entry> entries;
    size_t cells = 0;
  };

private:
  void prune_locked(int64_t now);
  void cap_deleted_locked();
  void write_entry_locked(McpJsonWriter& w, const Entry& entry) const;

  McpUsageOptions options_;
  int64_t since_ = 0;
  // write_mu_ makes the saves one at a time; mu_ guards state_ and is never held while the file is written.
  std::mutex write_mu_;
  mutable std::mutex mu_;
  State state_;
  bool dirty_ = false;
  int64_t last_save_ = 0;
  size_t last_size_ = 0;
};

} // namespace chdash
