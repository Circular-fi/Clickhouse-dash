#pragma once

// The usage of the MCP keys (docs/mcp.md, "Usage of a key"): what ChDash saw of the requests of each key, counted where a
// call writes its audit line (Server::handle_mcp_post). One entry for each key that was used:
// - its requests in six tiers of buckets, one for the step of each window: by the minute (the last hour), by 5 minutes (6 hours), by
//   15 minutes (24 hours), by 3 hours (7 days), by 12 hours (30 days) and by the UTC day (mcp.usage.retention_days). A tier is kept
//   only when the retention reaches its window, and a window reads its own tier: nothing is summed to a larger step. A bucket holds
//   cells: the requests that share a type (a tool call, a protocol request, a 429, a refusal), a client (the name that it gave), a
//   method (the tool, or the JSON-RPC method) and a result, with their count, time, rows and bytes. Everything that is shown is summed
//   from the cells;
// - its clients: the clientInfo of `initialize` and the User-Agent of the requests, kept for their life apart from the cells.
// A deleted key keeps its entry until its last day is older than the retention. Never SQL, never data, never a secret, never an address.
//
// Each ChDash (an instance) counts its own state, and a store (mcp_usage_store.hpp) keeps it: the files mode writes it every minute when
// something changed and at the stop, in a directory that several instances can share, one file for each instance. The other instances'
// files are read again in the background, never in a request, and their states are swapped in whole: an answer sums this instance and the
// others, by cell, and the instance that a cell comes from is a dimension of the overview. A file of this instance that is not valid
// stops the start and is never rewritten; a file of another instance that is not valid is skipped and listed with its reason.

#include "mcp_keys.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chdash {

class McpUsageStore;

inline constexpr int kMcpUsageFileVersion = 1;
inline constexpr int64_t kMcpUsageMaxRetentionDays = 365;
// The tiers of an entry: m1, m5, m15, h3, h12 and d1 (the steps of 1 minute, 5 minutes, 15 minutes, 3 hours, 12 hours and 1 day).
inline constexpr size_t kMcpUsageTiers = 6;
// The values of each filter of the overview.
inline constexpr size_t kMcpUsageOverviewMaxValues = 20;
// The rows of each list of an answer when the caller does not ask for fewer.
inline constexpr size_t kMcpUsageFacetRows = 200;

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
  // of the protocol (mcp_usage_state.cpp) and as "other" otherwise: a text that a client chose is never kept.
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
  // Where the state of this instance is kept and the states of the others are read. Null: nothing outlives the process and no other
  // instance is read (the unit tests; the server always has one when the usage is on).
  std::shared_ptr<McpUsageStore> store;
  // The name of this instance when there is no store; with a store, the name of the store.
  std::string instance = "local";
  int64_t retention_days = 90;
  size_t max_deleted = 1000;    // entries of deleted keys; the oldest deletion goes first
  size_t max_cells = 1000000;   // cells of all the buckets; a new one past it is counted in the overflow cell of its type
  size_t max_clients = 8;       // clients of a key; the one seen least recently goes first
};

// A window of the answers, read from the tier of its step. Its last point is the one that holds `now`, and its steps are aligned on
// UTC: 1h is 60 points by the minute, 6h 72 points by 5 minutes, 24h 96 points by 15 minutes, 7d 56 points by 3 hours, 30d 60 points by
// 12 hours, and 90d and 365d are the last days, today included, by the UTC day.
struct McpUsageWindow {
  std::string name;
  int64_t from = 0;  // the start of its first bucket
  int64_t step = 0;  // seconds: 60, 300, 900, 10800, 43200 or 86400
  size_t points = 0;
  size_t tier = 0;   // the tier that it reads: 0 m1, 1 m5, 2 m15, 3 h3, 4 h12, 5 d1
};

// The windows that a retention keeps: 1h, 6h and 24h, then 7d, 30d, 90d and 365d up to it.
std::vector<std::string> mcp_usage_windows(int64_t retention_days);
std::string mcp_usage_default_window(int64_t retention_days);
std::optional<McpUsageWindow> mcp_usage_window(std::string_view name, int64_t retention_days, int64_t now);

// Printable ASCII (another byte is "?"), the spaces at both ends removed, at most `max_bytes`.
std::string mcp_usage_clean(std::string_view text, size_t max_bytes);

// The rule of the name of an instance, and of the value of the filter `instance`: [A-Za-z0-9._-], 1 to 64 bytes.
bool mcp_valid_usage_instance(std::string_view instance);

// An instance that an answer reads, and how it went. `ok`: its state is read (this instance: its own); `skipped`: its file was not valid (the
// reason says why: it is never read); `conflict`: this instance cannot write its file because another process writes the same name (its
// counts stay in memory).
struct McpUsageInstance {
  std::string instance;
  int64_t written_at = 0;  // Unix seconds, when its file was last written (0: not yet)
  std::string status;
  std::string reason;
};

// The parameters of GET /api/mcp/usage/overview (its window apart): what the series is grouped by, and the filters. A value
// of a filter keeps the requests that have it; the values of a dimension are OR, the dimensions are AND.
struct McpUsageOverviewQuery {
  std::string group = "method";  // key, method, client, result, type or instance
  std::vector<std::string> keys;       // the ids of keys
  std::vector<std::string> methods;    // a tool or a method of the protocol: [A-Za-z0-9_/]{1,64}
  std::vector<std::string> clients;    // a client name: printable ASCII, 1 to 64 bytes, no space at either end
  std::vector<std::string> instances;  // an instance: [A-Za-z0-9._-]{1,64}
  std::vector<std::string> results;    // [a-z0-9_]{1,64}
  std::vector<std::string> types;      // call, request, limited or rejected
  // For a caller that is not a page (the tools of MCP): the rows of each list (0: kMcpUsageFacetRows; the values that were chosen are always
  // kept), and whether the series is made (it is the largest part of an answer).
  size_t limit = 0;
  bool series = true;
};

// What the details of one key read besides its window: the instances that it sums (none: all of them), the rows of each list (0: all), and
// whether the series is made.
struct McpUsageDetailQuery {
  std::vector<std::string> instances;
  size_t limit = 0;
  bool series = true;
};

// The rules of the parameters of the overview: a value that is repeated counts once, then each one is checked. Nullopt when
// they hold; else the field and the reason (`invalid`, or `too_many` past 20 values) of the 400.
std::optional<McpValidationError> mcp_usage_overview_check(McpUsageOverviewQuery* query);

class McpUsage {
public:
  // Reads the state of this instance from the store (nothing stored yet is no usage yet). Throws std::runtime_error when it is not valid.
  McpUsage(McpUsageOptions options, int64_t now);
  McpUsage(const McpUsage&) = delete;
  McpUsage& operator=(const McpUsage&) = delete;

  // The name of this instance.
  const std::string& instance() const { return instance_; }
  int64_t retention_days() const { return options_.retention_days; }
  // Since when the usage is counted: the earliest start of counting of the instances that are read (the first start of each one with its
  // file, or the start of the process without one).
  int64_t since() const;

  // At the start: the entry of a key that is gone is deleted from now on; a key of the configuration that is back takes
  // its entry again. Only the state of this instance changes.
  void sync_live_keys(const std::vector<McpUsageKeyRef>& live, int64_t now);
  void record(const McpUsageEvent& event);
  // The key is deleted: its entry stays until its last day is older than the retention. A key that was never used gets an
  // empty entry for 2 hours, so a call that was running when it was deleted is counted as deleted.
  void mark_deleted(const McpUsageKeyRef& key, int64_t now);

  // When each key was last used, on any instance that is read.
  std::unordered_map<std::string, int64_t> last_used_all() const;
  // The key as an entry names it (a deleted key too, a key that only another instance saw too); nullopt when none has it.
  std::optional<McpUsageKeyRef> entry_key(const std::string& id) const;

  // The instances that the answers read: this one first, then the others by name.
  std::vector<McpUsageInstance> instances() const;

  // GET /api/mcp/usage: the live keys in this order (zeros for a key that was not used), then the keys that are not live here and that still
  // have usage: the deleted ones, the last deletion first, then the ones that only another instance knows, the last use first. Every
  // instance is summed.
  void write_list(McpJsonWriter& w, const std::vector<McpUsageKeyRef>& live, const McpUsageWindow& window, int64_t now) const;
  // GET /api/mcp/keys/<id>/usage. `live` is the key when it exists. False when the key exists nowhere (404).
  bool write_detail(McpJsonWriter& w, const std::string& id, const McpUsageKeyRef* live, const McpUsageWindow& window, int64_t now,
                    const McpUsageDetailQuery& query = {}) const;
  // GET /api/mcp/usage/overview: the requests of every key in a window, cut by the filters of `query` (checked by
  // mcp_usage_overview_check): the totals and the series with all of them, and each facet (the keys, the methods, the clients, the
  // instances, the results, the types) with all of them but its own. The clients are those of the cells of the window; their versions and
  // their last sight come from the clients that the keys of the filter saw. `live` names the keys that exist. One entry at a time under the
  // lock, as save() does.
  void write_overview(McpJsonWriter& w, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                      const McpUsageWindow& window, int64_t now) const;

  // Drops what is older than the retention, then writes the state of this instance when something changed. False when the write failed
  // or when another process writes the same instance: the next save tries again.
  bool save(int64_t now);
  // save() when the last one is a minute old (5 minutes when the state is larger than 8 MiB).
  bool save_if_due(int64_t now);
  // Reads again the files of the other instances that changed, and removes the file of an instance that is gone. Never in a request.
  void refresh_others(int64_t now);
  // refresh_others() when the last one is a minute old.
  void refresh_if_due(int64_t now);
  // What the background loop calls: save_if_due() and refresh_if_due().
  void tick(int64_t now);
  // Stops a refresh that is running and the next ones (the stop of the server): the file that it reads is left as it was.
  void cancel() { cancel_.store(true, std::memory_order_relaxed); }

  // The requests of one type, one client, one method and one result, in one bucket. `key` is kind << 36 | client << 24 | method << 12 |
  // result: the client is an id of the ClientNames, the method and the result are ids of the Names.
  struct Cell {
    uint64_t key = 0;
    uint64_t count = 0;
    uint64_t duration_ms_sum = 0;
    uint64_t duration_ms_max = 0;
    uint64_t rows = 0;
    uint64_t bytes = 0;
  };
  // The nine totals of some cells (add_to_counters in mcp_usage_state.cpp is the one place that says what each one counts).
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
    // By start, one array for each tier: m1 the last 60 minutes, m5 the last 72 steps of 5 minutes, m15 the last 96 steps of 15
    // minutes, h3 the last 56 steps of 3 hours (kept when the retention is 7 days or more), h12 the last 60 steps of 12 hours (30
    // days or more) and d1 the last retention_days days.
    std::array<std::vector<Bucket>, kMcpUsageTiers> tiers;
    // The ids of the clients that its cells use (not other and unknown), at most 16: a key does not use more over its retention.
    // Made again from the cells when the state is read and when a day of d1 goes.
    std::vector<uint16_t> client_ids;
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
  // The names of the clients, apart from the Names (a tool is no client): an id of 12 bits in the cells. 0 is other (what a key counts
  // under past its 16 names, and when the table is full), 1 is unknown (no name and no User-Agent), then the names that were counted.
  // It grows like Names, and is made again from the cells at the start.
  struct ClientNames {
    std::vector<std::string> by_id;
    std::unordered_map<std::string, uint16_t> ids;
    ClientNames();
    uint16_t intern(std::string_view name);
  };
  // The state of one instance: its own while it counts, or one that a store read (then it never changes: it is swapped in whole).
  struct State {
    int64_t since = 0;
    int64_t written_at = 0;  // the header of the file that it was read from (0: it was not)
    Names names;
    ClientNames clients;
    std::unordered_map<std::string, Entry> entries;
    size_t cells = 0;
  };
  // What a store says of another instance: its state, or why that was not read.
  struct Other {
    std::string instance;
    int64_t written_at = 0;
    int64_t since = 0;
    std::string status;  // ok or skipped
    std::string reason;
    std::shared_ptr<const State> state;  // null when it was skipped
  };

private:
  void prune_locked(int64_t now);
  void cap_deleted_locked();
  std::shared_ptr<const std::vector<Other>> others_snapshot() const;

  McpUsageOptions options_;
  std::shared_ptr<McpUsageStore> store_;
  std::string instance_;
  int64_t since_ = 0;
  // write_mu_ makes the saves one at a time; mu_ guards state_ and is never held while the file is written.
  std::mutex write_mu_;
  mutable std::mutex mu_;
  State state_;
  bool dirty_ = false;
  int64_t last_save_ = 0;
  size_t last_size_ = 0;
  int64_t written_at_ = 0;   // the last time that the state of this instance was written, or read
  bool conflict_ = false;    // the last save found another process that writes this instance
  std::string conflict_reason_;
  // The other instances: read by the background loop, swapped in whole under others_mu_, never changed after.
  std::mutex refresh_mu_;
  int64_t last_refresh_ = 0;
  mutable std::mutex others_mu_;
  std::shared_ptr<const std::vector<Other>> others_;
  std::atomic<bool> cancel_{false};
};

} // namespace chdash
