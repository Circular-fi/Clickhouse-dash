#pragma once

// The usage of the MCP keys (docs/mcp.md, "Usage of a key"). It shows what ChDash saw of the requests of each key.
// ChDash counts a request where the call writes its audit line (Server::handle_mcp_post).
// ChDash makes one entry for each key that was used:
// - Its requests are in six tiers of buckets, one tier for each window step:
//   by the minute (the last hour), by 5 minutes (6 hours), by 15 minutes (24 hours),
//   by 3 hours (7 days), by 12 hours (30 days) and by the UTC day (mcp.usage.retention_days).
//   A tier is kept only when the retention reaches its window.
//   A window reads its own tier. ChDash never sums a tier to a larger step.
//   A bucket holds cells.
//   A cell holds the requests that share one type, one client, one method and one result.
//   The types are a tool call, a protocol request, a 429 and a refusal.
//   A cell has its count, time, rows and bytes.
//   Everything that is shown is summed from the cells.
// - Its clients: the clientInfo of `initialize` and the User-Agent of the requests.
//   ChDash keeps them for their life, apart from the cells.
// A deleted key keeps its entry until its last day is older than the retention.
// An entry never holds SQL, data, a secret or an address.
//
// Each ChDash instance counts its own state. A store (mcp_usage_store.hpp) keeps that state.
// In the files mode, the store writes the state every minute when something changed, and at the stop.
// The store uses a directory that several instances can share. Each instance has one file in it.
// The store reads the files of the other instances again in the background. It never reads them in a request.
// ChDash swaps in each state as a whole. An answer sums this instance and the others, by cell.
// The instance of a cell is a dimension of the overview.
// A file of this instance that is not valid stops the start. ChDash never rewrites that file.
// A file of another instance that is not valid is skipped. The answer lists it with its reason.

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
// The tiers of an entry: m1, m5, m15, h3, h12 and d1. They are the steps of 1 minute, 5 minutes, 15 minutes, 3 hours, 12 hours and 1 day.
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
  // Request: the JSON-RPC method of the message. It is empty when ChDash cannot read it.
  // ChDash counts the method when it is one of the methods of the protocol (mcp_usage_state.cpp).
  // Otherwise, it counts the method as "other". ChDash never keeps a text that a client chose.
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
  // The store that keeps the state of this instance and reads the states of the others.
  // Null: nothing outlives the process, and no other instance is read. Null is for the unit tests.
  std::shared_ptr<McpUsageStore> store;
  // The name of this instance when there is no store; with a store, the name of the store.
  std::string instance = "local";
  int64_t retention_days = 90;
  size_t max_deleted = 1000;    // entries of deleted keys; the oldest deletion goes first
  size_t max_cells = 1000000;   // cells of all the buckets; a new one past it is counted in the overflow cell of its type
  size_t max_clients = 8;       // clients of a key; the one seen least recently goes first
};

// A window of the answers reads the tier of its step. Its last point holds `now`. Its steps are aligned on UTC.
// 1h is 60 points by the minute. 6h is 72 points by 5 minutes. 24h is 96 points by 15 minutes.
// 7d is 56 points by 3 hours. 30d is 60 points by 12 hours.
// 90d and 365d are the last days, today included, by the UTC day.
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

// Keep printable ASCII only. Another byte becomes "?". Remove the spaces at both ends. The result has at most `max_bytes` bytes.
std::string mcp_usage_clean(std::string_view text, size_t max_bytes);

// The rule for the name of an instance, and for the value of the filter `instance`: [A-Za-z0-9._-], 1 to 64 bytes.
bool mcp_valid_usage_instance(std::string_view instance);

// An instance that an answer reads, and the result of the read.
// `ok`: ChDash reads its state. For this instance, the state is its own.
// `skipped`: its file is not valid. The reason says why. ChDash never reads the file.
// `conflict`: this instance cannot write its file. Another process writes the same name. The counts stay in memory.
struct McpUsageInstance {
  std::string instance;
  int64_t written_at = 0;  // Unix seconds, when its file was last written (0: not yet)
  std::string status;
  std::string reason;
};

// The parameters of GET /api/mcp/usage/overview, apart from its window. They set the groups of the series, the metric that ranks the groups and the filters.
// A value of a filter keeps the requests that have it. The values of one dimension combine with OR. The dimensions combine with AND.
struct McpUsageOverviewQuery {
  std::string group = "method";  // key, method, client, result, type or instance
  // The metric ranks the groups of the series. Its total is over the window. It ranks only when its dimension is not filtered.
  // The 8 largest groups are shown. The others are summed in `rest`. The metrics are: requests, errors, refused (the 429 and the refusals before the read), calls or bytes.
  std::string order = "requests";
  // More metrics to rank by, from the same read. The series then has `rankings`, with one member for each metric, in this order.
  // Each member has `groups` and `rest`, as `order` has. A page that draws a chart for each metric asks for all of them at once.
  // A repeated value counts once. There are 5 orders at most. An empty list gives no `rankings`, and the answer is the one of `order` alone.
  std::vector<std::string> orders;
  std::vector<std::string> keys;       // the ids of keys
  std::vector<std::string> methods;    // a tool or a method of the protocol: [A-Za-z0-9_/]{1,64}
  std::vector<std::string> clients;    // a client name: printable ASCII, 1 to 64 bytes, no space at either end
  std::vector<std::string> instances;  // an instance: [A-Za-z0-9._-]{1,64}
  std::vector<std::string> results;    // [a-z0-9_]{1,64}
  std::vector<std::string> types;      // call, request, limited or rejected
  // For a caller that is not a page, such as the MCP tools: the rows of each list. 0 means kMcpUsageFacetRows. The chosen values are always kept.
  // Also set whether the series is made. The series is the largest part of an answer.
  size_t limit = 0;
  bool series = true;
};

// The details of one key read, apart from its window. They set: the instances that it sums (none: all of them), the rows of each list (0: all), and whether the series is made.
struct McpUsageDetailQuery {
  std::vector<std::string> instances;
  size_t limit = 0;
  bool series = true;
};

// The rules for the parameters of the overview. A repeated value counts once. Then ChDash checks each value.
// The result is nullopt when the rules hold. Otherwise, it gives the field and the reason of the 400: `invalid`, or `too_many` past 20 values (5 for `orders`).
std::optional<McpValidationError> mcp_usage_overview_check(McpUsageOverviewQuery* query);

class McpUsage {
public:
  // Reads the state of this instance from the store. Nothing stored yet means no usage yet. Throws std::runtime_error when the state is not valid.
  McpUsage(McpUsageOptions options, int64_t now);
  McpUsage(const McpUsage&) = delete;
  McpUsage& operator=(const McpUsage&) = delete;

  // The name of this instance.
  const std::string& instance() const { return instance_; }
  int64_t retention_days() const { return options_.retention_days; }
  // The start of the count: the earliest start of the count of the instances that are read.
  // For each instance, that is the first start with its file. Without a file, it is the start of the process.
  int64_t since() const;

  // At the start, the entry of a key that is gone is deleted. A key of the configuration that is back gets its entry again. Only the state of this instance changes.
  void sync_live_keys(const std::vector<McpUsageKeyRef>& live, int64_t now);
  void record(const McpUsageEvent& event);
  // When the key is deleted, its entry stays until its last day is older than the retention.
  // A key that was never used gets an empty entry for 2 hours. So, a call that is in progress when the key is deleted counts as deleted.
  void mark_deleted(const McpUsageKeyRef& key, int64_t now);

  // The last use of each key, on any instance that is read.
  std::unordered_map<std::string, int64_t> last_used_all() const;
  // The key as an entry names it. A deleted key counts too, and so does a key that only another instance saw. The result is nullopt when no entry has the key.
  std::optional<McpUsageKeyRef> entry_key(const std::string& id) const;

  // The instances that the answers read. This instance comes first, then the others by name.
  std::vector<McpUsageInstance> instances() const;

  // GET /api/mcp/usage. The list has the live keys first, in this order. A key that was not used has zeros.
  // Then come the keys that are not live here, but that still have usage.
  // The deleted keys come first, the last deletion first. Then come the keys that only another instance knows, the last use first.
  // The answer sums every instance.
  void write_list(McpJsonWriter& w, const std::vector<McpUsageKeyRef>& live, const McpUsageWindow& window, int64_t now) const;
  // GET /api/mcp/keys/<id>/usage. `live` is the key when it exists. The result is false when the key exists nowhere (404).
  bool write_detail(McpJsonWriter& w, const std::string& id, const McpUsageKeyRef* live, const McpUsageWindow& window, int64_t now,
                    const McpUsageDetailQuery& query = {}) const;
  // GET /api/mcp/usage/overview. It gives the requests of every key in a window. The filters of `query` cut them. mcp_usage_overview_check checks the filters.
  // The answer has the totals and the series with all of them. It has each facet too: the keys, the methods, the clients, the instances, the results and the types.
  // Each facet has all the values except its own. The series ranks its groups by `query.order`.
  // It ranks them once more by each of `query.orders` (`rankings`), from the same counts. The cells are walked once.
  // The clients are those of the cells of the window. Their versions and their last sight are taken from the clients that the keys of the filter saw.
  // `live` names the keys that exist. The function takes one entry at a time under the lock, as save() does.
  void write_overview(McpJsonWriter& w, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                      const McpUsageWindow& window, int64_t now) const;

  // Removes what is older than the retention. Then writes the state of this instance when something changed.
  // The result is false when the write failed, or when another process writes the same instance. The next save tries again.
  bool save(int64_t now);
  // Calls save() when the last save is a minute old. The limit is 5 minutes when the state is larger than 8 MiB.
  bool save_if_due(int64_t now);
  // Reads again the files of the other instances that changed. It removes the file of an instance that is gone. Never call it in a request.
  void refresh_others(int64_t now);
  // Calls refresh_others() when the last refresh is a minute old.
  void refresh_if_due(int64_t now);
  // The background loop calls save_if_due() and refresh_if_due().
  void tick(int64_t now);
  // Stops a refresh that is in progress, and the next ones, at the stop of the server. The file that the refresh reads stays as it was.
  void cancel() { cancel_.store(true, std::memory_order_relaxed); }

  // The requests of one type, one client, one method and one result, in one bucket.
  // `key` is kind << 36 | client << 24 | method << 12 | result. The client is an id of the ClientNames. The method and the result are ids of the Names.
  struct Cell {
    uint64_t key = 0;
    uint64_t count = 0;
    uint64_t duration_ms_sum = 0;
    uint64_t duration_ms_max = 0;
    uint64_t rows = 0;
    uint64_t bytes = 0;
  };
  // The nine totals of some cells. The function add_to_counters in mcp_usage_state.cpp is the only place that defines what each total counts.
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
    // Ordered by start. There is one array for each tier.
    // m1 has the last 60 minutes. m5 has the last 72 steps of 5 minutes. m15 has the last 96 steps of 15 minutes.
    // h3 has the last 56 steps of 3 hours. ChDash keeps h3 when the retention is 7 days or more.
    // h12 has the last 60 steps of 12 hours, when the retention is 30 days or more. d1 has the last retention_days days.
    std::array<std::vector<Bucket>, kMcpUsageTiers> tiers;
    // The ids of the clients that its cells use. The ids are not other and not unknown. There are at most 16, because a key does not use more over its retention.
    // ChDash makes the list again from the cells when the state is read, and when a day of d1 is removed.
    std::vector<uint16_t> client_ids;
  };
  // The names of the methods and of the results. Each id has 12 bits in the cells.
  // The fixed names come first: 0 other, 1 ok, the methods of the protocol, invalid and unread.
  // Then come the tools and the results that were counted. `by_id` grows. Nothing reads it outside the lock.
  struct Names {
    std::vector<std::string> by_id;
    std::unordered_map<std::string, uint16_t> ids;
    Names();
    uint16_t intern(std::string_view name);
  };
  // The names of the clients, apart from the Names. A tool is no client. Each id has 12 bits in the cells.
  // 0 is other. A key counts a client as other past its 16 names, and when the table is full.
  // 1 is unknown: there is no name and no User-Agent. Then come the names that were counted.
  // It grows like Names. ChDash makes it again from the cells at the start.
  struct ClientNames {
    std::vector<std::string> by_id;
    std::unordered_map<std::string, uint16_t> ids;
    ClientNames();
    uint16_t intern(std::string_view name);
  };
  // The state of one instance. While this instance counts, the state is its own. Otherwise, the state is one that a store read.
  // A read state never changes. ChDash swaps it in as a whole.
  struct State {
    int64_t since = 0;
    int64_t written_at = 0;  // the header of the file that it was read from (0: it was not)
    Names names;
    ClientNames clients;
    std::unordered_map<std::string, Entry> entries;
    size_t cells = 0;
  };
  // What a store says about another instance: its state, or the reason that it was not read.
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
  // write_mu_ lets one save run at a time. mu_ guards state_. ChDash never holds mu_ while it writes the file.
  std::mutex write_mu_;
  mutable std::mutex mu_;
  State state_;
  bool dirty_ = false;
  int64_t last_save_ = 0;
  size_t last_size_ = 0;
  int64_t written_at_ = 0;   // the last time that the state of this instance was written, or read
  bool conflict_ = false;    // the last save found another process that writes this instance
  std::string conflict_reason_;
  // The other instances. The background loop reads them. ChDash swaps them in as a whole under others_mu_. They never change after the swap.
  std::mutex refresh_mu_;
  int64_t last_refresh_ = 0;
  mutable std::mutex others_mu_;
  std::shared_ptr<const std::vector<Other>> others_;
  std::atomic<bool> cancel_{false};
};

} // namespace chdash
