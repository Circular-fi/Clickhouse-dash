#pragma once

// What the counting (mcp_usage.cpp) and the stores (mcp_usage_store.cpp) share: the limits of a state, the encoding of a cell, the tiers, the
// rules of a name, and the rows of a file or a table applied to a state. A row that is not valid stops the read with a message that never
// holds the content of the row: the rules are the same for the state of this instance and for the state of another one.

#include "mcp_usage.hpp"
#include "mcp_usage_store.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace chdash {
namespace mcp_usage {

using Usage = McpUsage;

inline constexpr int64_t kHour = 3600;
inline constexpr int64_t kDay = 86400;
inline constexpr size_t kMaxNames = 4096;  // the id of a name has 12 bits
inline constexpr size_t kCellsPerBucket = 512;
inline constexpr int64_t kTombstoneSeconds = 2 * kHour;
inline constexpr size_t kNameBytes = 64;
inline constexpr size_t kClientNameBytes = 128;   // the name of a client record, which is kept for the life of the client
inline constexpr size_t kCellClientBytes = 64;    // the name of a client in the cells: the record's name, cut
inline constexpr size_t kClientVersionBytes = 64;
inline constexpr size_t kUserAgentBytes = 256;
inline constexpr size_t kHostBytes = 256;
inline constexpr size_t kKeyClients = 16;  // the client names that a key uses in its cells over its retention
inline constexpr size_t kInstanceBytes = 64;

// The methods of the protocol that a request is counted under (docs/mcp.md, "Usage of a key"). Any other method is "other":
// a notification accepts any name, and a text that a client chose would fill the names for the whole retention.
inline constexpr const char* kProtocolMethods[] = {
    "initialize", "ping", "tools/list", "tools/call", "response", "notifications/initialized", "notifications/cancelled",
    "notifications/progress", "notifications/roots/list_changed", "resources/list", "resources/read", "resources/templates/list",
    "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel"};
inline constexpr size_t kProtocolMethodCount = sizeof(kProtocolMethods) / sizeof(kProtocolMethods[0]);

// The fixed names, as ids: other, ok, the methods, then the two that stand for a request without a method.
inline constexpr uint16_t kNameOther = 0;
inline constexpr uint16_t kNameOk = 1;
inline constexpr uint16_t kNameFirstMethod = 2;
inline constexpr uint16_t kNameInvalid = static_cast<uint16_t>(kNameFirstMethod + kProtocolMethodCount);  // the message could not be read
inline constexpr uint16_t kNameUnread = static_cast<uint16_t>(kNameInvalid + 1);  // refused before the message was read

// The fixed names of the clients are 0 other (what a key counts under past its names, or when the table is full) and 1 unknown (a
// request that gives no name and no User-Agent). No cap counts them.
inline constexpr uint16_t kClientOther = 0;
inline constexpr uint16_t kClientFixed = 2;  // the ids below it are the fixed names

// The types of a cell, in the order of McpUsageKind.
inline constexpr const char* kKindNames[] = {"call", "request", "limited", "rejected"};
inline constexpr size_t kKinds = sizeof(kKindNames) / sizeof(kKindNames[0]);

// The tiers of an entry, in the order of the tiers of its file. A tier keeps `points` buckets of `step` seconds, aligned on UTC (d1 keeps
// one for each day of the retention), and only when the retention reaches `min_days`: nothing is kept past the retention.
enum Tier : size_t { kTierM1, kTierM5, kTierM15, kTierH3, kTierH12, kTierD1 };
static_assert(kTierD1 + 1 == kMcpUsageTiers, "one spec for each tier");
struct TierSpec {
  const char* member;
  int64_t step;
  size_t points;
  int64_t min_days;
};
inline constexpr TierSpec kTierSpecs[kMcpUsageTiers] = {{"m1", 60, 60, 0},        {"m5", 300, 72, 0},         {"m15", 900, 96, 0},
                                                         {"h3", 3 * kHour, 56, 7}, {"h12", 12 * kHour, 60, 30}, {"d1", kDay, 0, 0}};

int64_t floor_to(int64_t t, int64_t step);
// Whether a retention keeps a tier.
bool tier_kept(size_t tier, int64_t retention_days);
// The start of the oldest bucket that a tier keeps when `at` is in its last one.
int64_t tier_first(size_t tier, int64_t at, int64_t retention_days);
// The tier that a name of the file stands for (m1 ... d1), or -1.
int tier_index(std::string_view name);

// The name of a tool or of a result as the usage keeps it: [a-z0-9_], at most 64 bytes.
std::string clean_name(std::string_view text);
bool valid_name(std::string_view name);
// A method of the file: [A-Za-z0-9_/], at most 64 bytes (logging/setLevel has a capital and a slash).
bool valid_method(std::string_view name);
// A client name as the cells keep it: printable ASCII, 1 to 64 bytes, no space at either end.
bool valid_client(std::string_view name);
// The id of a method of the protocol (the text must be exactly one of them), "other" for any other text.
uint16_t protocol_method(std::string_view method);
int kind_index(std::string_view name);

uint64_t cell_key(McpUsageKind kind, uint16_t client, uint16_t method, uint16_t result);
McpUsageKind kind_of(uint64_t key);
uint16_t client_of(uint64_t key);
uint16_t method_of(uint64_t key);
uint16_t result_of(uint64_t key);
// The cell of an event, for the id of its client: its type, its method and its result. The names that this adds (a tool, a result) come
// from the catalog and from the code of ChDash: a method of the protocol is looked up, never added.
uint64_t cell_key_of(Usage::Names& names, const McpUsageEvent& event, uint16_t client);
// Where the requests of a cell go when no cell can be made for them: the cell of their type with the client "other", the method "other"
// and the result "ok" or "other". No cap stops it (at most 6 for a bucket), so a total stays exact.
uint64_t overflow_key(uint64_t key);
// A tool call or a protocol request that did not end ok. A refusal (429, 400, 413, 415) is counted apart.
bool is_error(uint64_t key);
// The nine totals: what each one counts is said here and nowhere else. The requests are all the cells; the calls, the errors,
// the 429 and the refusals count by type; the time is the one of the tool calls (a protocol request has its own time in its
// cell, which a page shows for its method, but it is no tool call).
void add_to_counters(Usage::Counters& into, const Usage::Cell& cell);
Usage::Counters totals_of(const Usage::Bucket& bucket);

size_t cells_of(const Usage::Bucket& bucket);
void take_cells(size_t* cells, size_t count);
// The bucket of `start` (the buckets are sorted by start): the last one, or a new one after it. A time before the last
// bucket (the clock went back) counts in the last bucket.
Usage::Bucket& bucket_at(std::vector<Usage::Bucket>& buckets, int64_t start);
// Drops the buckets before `first_kept`. True when one went.
bool drop_before(std::vector<Usage::Bucket>& buckets, int64_t first_kept, size_t* cells);
// The cell of `key` (the cells are sorted by key). A new cell past the caps (of the bucket, of all the buckets) is the overflow
// cell of its type, which no cap stops.
Usage::Cell& cell_of(Usage::Bucket& bucket, uint64_t key, size_t* used, size_t max_cells);
void add_event(Usage::Bucket& bucket, const McpUsageEvent& event, uint64_t key, size_t* cells, size_t max_cells);

// The client of a request: an initialize with clientInfo is the client of that name, version and User-Agent (or the client
// with that User-Agent that had no name yet); any other request is the client last seen with its User-Agent. Returns the record that
// the request counted for, a copy: the least recently seen record may go as the new one comes (the cap of the records).
Usage::Client note_client(Usage::Entry& entry, const McpUsageEvent& event, size_t max_clients);
// The name that a request counts under in the cells: the name of its client (clientInfo), else the product of its User-Agent (the text
// before the first "/" or space: python-httpx/0.27.0 is python-httpx), else "unknown". The version is no part of it, so an upgrade does not
// cut a series.
std::string client_name_of(const Usage::Client& client);
// The id of a client name for a key. The name is its own id when the key has it, or can add it (a key uses at most 16 names over its
// retention, whatever a client sends) and the table has it, or can add it (4096 names); else the requests count as "other", and the
// totals stay exact. The names other and unknown are fixed: they count in no cap.
uint16_t client_id_of(Usage::Entry& entry, Usage::ClientNames& table, const std::string& name);
// The ids of the clients that the cells of an entry use, in all its tiers (not the fixed names), made again.
void rebuild_client_ids(Usage::Entry& entry);
// What a deleted entry gives back: the cells of all its tiers.
void release_cells(const Usage::Entry& entry, size_t* cells);

// ---- the rows ----------------------------------------------------------------------------------------

// Apply a row to a state. A row that is not valid throws std::runtime_error. A key row makes the entry of its key (a second row for the
// same key is refused), and the client and cell rows of a key come after it. A cell that repeats another adds to it, a cell without
// a request is ignored, the cells past the cap of a bucket go to the overflow cell, and a client name past the 16 of its key becomes
// `other` (the cells that this makes equal are one cell): no request is lost. The buckets of a tier of a key come in the order of their start.
void apply_key(Usage::State& state, const McpUsageKeyRow& row, size_t max_keys);
void apply_client(Usage::State& state, const McpUsageClientRow& row, size_t max_clients);
void apply_cell(Usage::State& state, const McpUsageCellRow& row);
// After the last row: the ids of the clients that the cells of each key use.
void finish_state(Usage::State& state);

} // namespace mcp_usage
} // namespace chdash
