#include "mcp_usage.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "query_library_file.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <array>
#include <bitset>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <tuple>
#include <unordered_set>

namespace chdash {
namespace {

using Usage = McpUsage;

constexpr int64_t kHour = 3600;
constexpr int64_t kDay = 86400;
constexpr size_t kMaxFileBytes = 128u * 1024 * 1024;
constexpr size_t kMaxNames = 4096;  // the id of a name has 12 bits
constexpr size_t kCellsPerBucket = 512;
constexpr int64_t kTombstoneSeconds = 2 * kHour;
constexpr size_t kNameBytes = 64;
constexpr size_t kClientNameBytes = 128;   // the name of a client record, which is kept for the life of the client
constexpr size_t kCellClientBytes = 64;    // the name of a client in the cells: the record's name, cut
constexpr size_t kClientVersionBytes = 64;
constexpr size_t kUserAgentBytes = 256;
constexpr size_t kHostBytes = 256;
constexpr size_t kKeyClients = 16;  // the client names that a key uses in its cells over its retention
constexpr int64_t kSaveEvery = 60;
constexpr int64_t kSaveEveryLarge = 300;
constexpr size_t kLargeFile = 8u * 1024 * 1024;
constexpr size_t kBucketFields = 2;  // start, the cells
constexpr size_t kCellFields = 9;    // type, client, method, result, count, duration sum, duration max, rows, bytes

// The methods of the protocol that a request is counted under (docs/mcp.md, "Usage of a key"). Any other method is "other":
// a notification accepts any name, and a text that a client chose would fill the names for the whole retention.
constexpr const char* kProtocolMethods[] = {
    "initialize", "ping", "tools/list", "tools/call", "response", "notifications/initialized", "notifications/cancelled",
    "notifications/progress", "notifications/roots/list_changed", "resources/list", "resources/read", "resources/templates/list",
    "resources/subscribe", "resources/unsubscribe", "prompts/list", "prompts/get", "completion/complete", "logging/setLevel"};
constexpr size_t kProtocolMethodCount = sizeof(kProtocolMethods) / sizeof(kProtocolMethods[0]);

// The fixed names, as ids: other, ok, the methods, then the two that stand for a request without a method.
constexpr uint16_t kNameOther = 0;
constexpr uint16_t kNameOk = 1;
constexpr uint16_t kNameFirstMethod = 2;
constexpr uint16_t kNameInvalid = static_cast<uint16_t>(kNameFirstMethod + kProtocolMethodCount);  // the message could not be read
constexpr uint16_t kNameUnread = static_cast<uint16_t>(kNameInvalid + 1);  // refused before the message was read

// The fixed names of the clients are 0 other (what a key counts under past its names, or when the table is full) and 1 unknown (a
// request that gives no name and no User-Agent). No cap counts them.
constexpr uint16_t kClientOther = 0;
constexpr uint16_t kClientFixed = 2;  // the ids below it are the fixed names

// The types of a cell, in the order of McpUsageKind.
constexpr const char* kKindNames[] = {"call", "request", "limited", "rejected"};
constexpr size_t kKinds = sizeof(kKindNames) / sizeof(kKindNames[0]);

// The tiers of an entry, in the order of the members of its file entry. A tier keeps `points` buckets of `step` seconds, aligned on UTC
// (d1 keeps one for each day of the retention), and only when the retention reaches `min_days`: nothing is kept past the retention.
enum Tier : size_t { kTierM1, kTierM5, kTierM15, kTierH3, kTierH12, kTierD1 };
static_assert(kTierD1 + 1 == kMcpUsageTiers, "one spec for each tier");
struct TierSpec {
  const char* member;
  int64_t step;
  size_t points;
  int64_t min_days;
};
constexpr TierSpec kTierSpecs[kMcpUsageTiers] = {{"m1", 60, 60, 0},        {"m5", 300, 72, 0},         {"m15", 900, 96, 0},
                                                  {"h3", 3 * kHour, 56, 7}, {"h12", 12 * kHour, 60, 30}, {"d1", kDay, 0, 0}};

// The windows of the answers: the tier that each one reads, its points, and the retention that offers it.
struct WindowSpec {
  const char* name;
  size_t tier;
  size_t points;
  int64_t min_days;
};
constexpr WindowSpec kWindowSpecs[] = {{"1h", kTierM1, 60, 0},   {"6h", kTierM5, 72, 0},   {"24h", kTierM15, 96, 0}, {"7d", kTierH3, 56, 7},
                                       {"30d", kTierH12, 60, 30}, {"90d", kTierD1, 90, 90}, {"365d", kTierD1, 365, 365}};

int64_t floor_to(int64_t t, int64_t step) {
  const int64_t r = t % step;
  return t - (r < 0 ? r + step : r);
}

// Whether a retention keeps a tier.
bool tier_kept(size_t tier, int64_t retention_days) { return retention_days >= kTierSpecs[tier].min_days; }

// The start of the oldest bucket that a tier keeps when `at` is in its last one.
int64_t tier_first(size_t tier, int64_t at, int64_t retention_days) {
  const TierSpec& spec = kTierSpecs[tier];
  const int64_t points = tier == kTierD1 ? retention_days : static_cast<int64_t>(spec.points);
  return floor_to(at, spec.step) - (points - 1) * spec.step;
}

bool name_char(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'; }

// The name of a tool or of a result as the usage keeps it: [a-z0-9_], at most 64 bytes.
std::string clean_name(std::string_view text) {
  std::string out;
  for (char c : text) {
    if (out.size() >= kNameBytes) break;
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    out.push_back(name_char(c) ? c : '_');
  }
  return out.empty() ? std::string("unknown") : out;
}

bool valid_name(std::string_view name) {
  return !name.empty() && name.size() <= kNameBytes && std::all_of(name.begin(), name.end(), name_char);
}

// A method of the file: [A-Za-z0-9_/], at most 64 bytes (logging/setLevel has a capital and a slash).
bool valid_method(std::string_view name) {
  return !name.empty() && name.size() <= kNameBytes &&
         std::all_of(name.begin(), name.end(), [](char c) { return name_char(c) || (c >= 'A' && c <= 'Z') || c == '/'; });
}

// A client name as the cells keep it: printable ASCII, 1 to 64 bytes, no space at either end.
bool valid_client(std::string_view name) {
  return !name.empty() && name.size() <= kCellClientBytes && name.front() != ' ' && name.back() != ' ' &&
         std::all_of(name.begin(), name.end(), [](char c) { return c >= 0x20 && c <= 0x7e; });
}

// The id of a method of the protocol (the text must be exactly one of them), "other" for any other text.
uint16_t protocol_method(std::string_view method) {
  for (size_t i = 0; i < kProtocolMethodCount; ++i) {
    if (method == kProtocolMethods[i]) return static_cast<uint16_t>(kNameFirstMethod + i);
  }
  return kNameOther;
}

int kind_index(std::string_view name) {
  for (size_t i = 0; i < kKinds; ++i) {
    if (name == kKindNames[i]) return static_cast<int>(i);
  }
  return -1;
}

uint64_t cell_key(McpUsageKind kind, uint16_t client, uint16_t method, uint16_t result) {
  return static_cast<uint64_t>(kind) << 36 | static_cast<uint64_t>(client) << 24 | static_cast<uint64_t>(method) << 12 | result;
}
McpUsageKind kind_of(uint64_t key) { return static_cast<McpUsageKind>(key >> 36); }
uint16_t client_of(uint64_t key) { return static_cast<uint16_t>((key >> 24) & 0xfff); }
uint16_t method_of(uint64_t key) { return static_cast<uint16_t>((key >> 12) & 0xfff); }
uint16_t result_of(uint64_t key) { return static_cast<uint16_t>(key & 0xfff); }

// The cell of an event, for the id of its client: its type, its method and its result. The names that this adds (a tool, a result) come
// from the catalog and from the code of ChDash: a method of the protocol is looked up, never added.
uint64_t cell_key_of(Usage::Names& names, const McpUsageEvent& event, uint16_t client) {
  uint16_t method = kNameUnread;
  if (event.kind == McpUsageKind::ToolCall) method = names.intern(clean_name(event.tool));
  else if (event.kind == McpUsageKind::Request) method = event.method.empty() ? kNameInvalid : protocol_method(event.method);
  const uint16_t result = event.status == "ok" ? kNameOk : names.intern(clean_name(event.status));
  return cell_key(event.kind, client, method, result);
}

// Where the requests of a cell go when no cell can be made for them: the cell of their type with the client "other", the method "other"
// and the result "ok" or "other". No cap stops it (at most 6 for a bucket), so a total stays exact.
uint64_t overflow_key(uint64_t key) {
  return cell_key(kind_of(key), kClientOther, kNameOther, result_of(key) == kNameOk ? kNameOk : kNameOther);
}

// A tool call or a protocol request that did not end ok. A refusal (429, 400, 413, 415) is counted apart.
bool is_error(uint64_t key) {
  const McpUsageKind kind = kind_of(key);
  return (kind == McpUsageKind::ToolCall || kind == McpUsageKind::Request) && result_of(key) != kNameOk;
}

// The nine totals: what each one counts is said here and nowhere else. The requests are all the cells; the calls, the errors,
// the 429 and the refusals count by type; the time is the one of the tool calls (a protocol request has its own time in its
// cell, which a page shows for its method, but it is no tool call).
void add_to_counters(Usage::Counters& into, const Usage::Cell& cell) {
  into.requests += cell.count;
  into.rows += cell.rows;
  into.bytes += cell.bytes;
  if (is_error(cell.key)) into.errors += cell.count;
  switch (kind_of(cell.key)) {
    case McpUsageKind::ToolCall:
      into.calls += cell.count;
      into.duration_ms_sum += cell.duration_ms_sum;
      into.duration_ms_max = std::max(into.duration_ms_max, cell.duration_ms_max);
      break;
    case McpUsageKind::Request:
      break;
    case McpUsageKind::RateLimited:
      into.rate_limited += cell.count;
      break;
    case McpUsageKind::Rejected:
      into.rejected += cell.count;
      break;
  }
}

Usage::Counters totals_of(const Usage::Bucket& bucket) {
  Usage::Counters total;
  for (const auto& cell : bucket.cells) add_to_counters(total, cell);
  return total;
}

// The figures of the cells of a row (a tool, a method, a result): the time is the one of every request of the row.
struct Figures {
  uint64_t requests = 0;
  uint64_t errors = 0;
  uint64_t duration_ms_sum = 0;
  uint64_t duration_ms_max = 0;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  uint64_t keys = 0;             // the keys that have a request in the row
  size_t last_entry = SIZE_MAX;  // the entry that was counted last: the entries are walked one after the other
};

void add_figures(Figures& into, const Usage::Cell& cell, size_t entry) {
  into.requests += cell.count;
  if (is_error(cell.key)) into.errors += cell.count;
  into.duration_ms_sum += cell.duration_ms_sum;
  into.duration_ms_max = std::max(into.duration_ms_max, cell.duration_ms_max);
  into.rows += cell.rows;
  into.bytes += cell.bytes;
  if (into.last_entry != entry) {
    ++into.keys;
    into.last_entry = entry;
  }
}

size_t cells_of(const Usage::Bucket& bucket) { return bucket.cells.size(); }

void take_cells(size_t* cells, size_t count) { *cells -= std::min(*cells, count); }

// The bucket of `start` (the buckets are sorted by start): the last one, or a new one after it. A time before the last
// bucket (the clock went back) counts in the last bucket.
Usage::Bucket& bucket_at(std::vector<Usage::Bucket>& buckets, int64_t start) {
  if (buckets.empty() || buckets.back().start < start) {
    buckets.emplace_back();
    buckets.back().start = start;
  }
  return buckets.back();
}

// Drops the buckets before `first_kept`. True when one went.
bool drop_before(std::vector<Usage::Bucket>& buckets, int64_t first_kept, size_t* cells) {
  size_t gone = 0;
  while (gone < buckets.size() && buckets[gone].start < first_kept) {
    take_cells(cells, cells_of(buckets[gone]));
    ++gone;
  }
  if (gone == 0) return false;
  buckets.erase(buckets.begin(), buckets.begin() + static_cast<std::ptrdiff_t>(gone));
  return true;
}

// Whether a bucket has its 512 cells. The overflow cells (at most 6) are not among them, so a bucket that is written and read
// again keeps the same cells.
bool bucket_full(const Usage::Bucket& bucket) {
  if (bucket.cells.size() < kCellsPerBucket) return false;
  const auto overflow = std::count_if(bucket.cells.begin(), bucket.cells.end(), [](const Usage::Cell& cell) { return cell.key == overflow_key(cell.key); });
  return bucket.cells.size() - static_cast<size_t>(overflow) >= kCellsPerBucket;
}

// The cell of `key` (the cells are sorted by key). A new cell past the caps (of the bucket, of all the buckets) is the overflow
// cell of its type, which no cap stops.
Usage::Cell& cell_of(Usage::Bucket& bucket, uint64_t key, size_t* used, size_t max_cells) {
  const auto find = [&bucket](uint64_t wanted) {
    return std::lower_bound(bucket.cells.begin(), bucket.cells.end(), wanted, [](const Usage::Cell& cell, uint64_t k) { return cell.key < k; });
  };
  auto at = find(key);
  if (at != bucket.cells.end() && at->key == key) return *at;
  if (key != overflow_key(key) && (bucket_full(bucket) || *used >= max_cells)) {
    key = overflow_key(key);
    at = find(key);
    if (at != bucket.cells.end() && at->key == key) return *at;
  }
  Usage::Cell fresh;
  fresh.key = key;
  at = bucket.cells.insert(at, fresh);
  ++*used;
  return *at;
}

void add_event(Usage::Bucket& bucket, const McpUsageEvent& event, uint64_t key, size_t* cells, size_t max_cells) {
  Usage::Cell& cell = cell_of(bucket, key, cells, max_cells);
  const auto ms = static_cast<uint64_t>(std::max<int64_t>(0, event.duration_ms));
  ++cell.count;
  cell.duration_ms_sum += ms;
  cell.duration_ms_max = std::max(cell.duration_ms_max, ms);
  if (event.kind == McpUsageKind::ToolCall) cell.rows += event.rows;
  cell.bytes += event.bytes;
}

// The client of a request: an initialize with clientInfo is the client of that name, version and User-Agent (or the client
// with that User-Agent that had no name yet); any other request is the client last seen with its User-Agent. Returns the record that
// the request counted for, a copy: the least recently seen record may go as the new one comes (the cap of the records).
Usage::Client note_client(Usage::Entry& entry, const McpUsageEvent& event, size_t max_clients) {
  const std::string agent = mcp_usage_clean(event.user_agent, kUserAgentBytes);
  const std::string name = mcp_usage_clean(event.client_name, kClientNameBytes);
  const std::string version = mcp_usage_clean(event.client_version, kClientVersionBytes);
  Usage::Client* found = nullptr;
  if (!name.empty() || !version.empty()) {
    for (auto& client : entry.clients) {
      if (client.name == name && client.version == version && client.user_agent == agent) found = &client;
    }
    if (!found) {
      for (auto& client : entry.clients) {
        if (client.name.empty() && client.version.empty() && client.user_agent == agent) {
          client.name = name;
          client.version = version;
          found = &client;
          break;
        }
      }
    }
  } else {
    for (auto& client : entry.clients) {
      if (client.user_agent == agent && (!found || client.last_seen > found->last_seen)) found = &client;
    }
  }
  if (!found) {
    entry.clients.push_back(Usage::Client{name, version, agent, event.at, event.at, 0});
    found = &entry.clients.back();
  }
  ++found->requests;
  found->last_seen = std::max(found->last_seen, event.at);
  found->first_seen = std::min(found->first_seen, event.at);
  const Usage::Client chosen = *found;
  if (entry.clients.size() > max_clients) {
    const auto oldest = std::min_element(entry.clients.begin(), entry.clients.end(),
                                         [](const Usage::Client& a, const Usage::Client& b) { return a.last_seen < b.last_seen; });
    entry.clients.erase(oldest);
  }
  return chosen;
}

// The name that a request counts under in the cells: the name of its client (clientInfo), else the product of its User-Agent (the text
// before the first "/" or space: python-httpx/0.27.0 is python-httpx), else "unknown". The version is no part of it, so an upgrade does not
// cut a series.
std::string client_name_of(const Usage::Client& client) {
  std::string name = mcp_usage_clean(client.name, kCellClientBytes);
  if (!name.empty()) return name;
  name = mcp_usage_clean(client.user_agent.substr(0, client.user_agent.find_first_of("/ ")), kCellClientBytes);
  return name.empty() ? std::string("unknown") : name;
}

// The id of a client name for a key. The name is its own id when the key has it, or can add it (a key uses at most 16 names over its
// retention, whatever a client sends) and the table has it, or can add it (4096 names); else the requests count as "other", and the
// totals stay exact. The names other and unknown are fixed: they count in no cap.
uint16_t client_id_of(Usage::Entry& entry, Usage::ClientNames& table, const std::string& name) {
  const auto known = table.ids.find(name);
  if (known != table.ids.end() && known->second < kClientFixed) return known->second;
  const auto& ids = entry.client_ids;
  if (known != table.ids.end() && std::find(ids.begin(), ids.end(), known->second) != ids.end()) return known->second;
  if (ids.size() >= kKeyClients) return kClientOther;
  const uint16_t id = known != table.ids.end() ? known->second : table.intern(name);
  if (id == kClientOther) return id;  // the table is full
  entry.client_ids.push_back(id);
  return id;
}

// The ids of the clients that the cells of an entry use, in all its tiers (not the fixed names), made again.
void rebuild_client_ids(Usage::Entry& entry) {
  std::vector<uint16_t> ids;
  for (const auto& tier : entry.tiers) {
    for (const auto& bucket : tier) {
      for (const auto& cell : bucket.cells) {
        if (client_of(cell.key) >= kClientFixed) ids.push_back(client_of(cell.key));
      }
    }
  }
  std::sort(ids.begin(), ids.end());
  ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
  entry.client_ids = std::move(ids);
}

// What a deleted entry gives back: the cells of all its tiers.
void release_cells(const Usage::Entry& entry, size_t* cells) {
  for (const auto& tier : entry.tiers) {
    for (const auto& bucket : tier) take_cells(cells, cells_of(bucket));
  }
}

// ---- the file -------------------------------------------------------------------------------------

[[noreturn]] void file_error(const std::string& what) { throw std::runtime_error(what); }

// `where` is a view: the answer refers to `obj` only (a std::string made for `where` would read as a dangling reference).
const rapidjson::Value& member(const rapidjson::Value& obj, const char* name, std::string_view where) {
  const auto it = obj.FindMember(name);
  if (it == obj.MemberEnd()) file_error(std::string(where) + "." + name + " is missing");
  return it->value;
}

std::string text_of(const rapidjson::Value& value, const std::string& where, size_t max_bytes) {
  if (!value.IsString()) file_error(where + " must be a string");
  if (value.GetStringLength() > max_bytes) file_error(where + " is too long");
  return std::string(value.GetString(), value.GetStringLength());
}

int64_t time_of(const rapidjson::Value& value, const std::string& where) {
  if (value.IsNull()) return 0;
  int64_t seconds = 0;
  if (!value.IsString() || !mcp_parse_iso_utc(std::string_view(value.GetString(), value.GetStringLength()), &seconds) || seconds <= 0) {
    file_error(where + " must be an ISO 8601 UTC time or null");
  }
  return seconds;
}

uint64_t count_of(const rapidjson::Value& value, const std::string& where) {
  if (!value.IsUint64()) file_error(where + " must be a count");
  return value.GetUint64();
}

std::string_view view_of(const rapidjson::Value& value) { return std::string_view(value.GetString(), value.GetStringLength()); }

// The cells of a bucket: [[type, client, method, result, count, duration sum, duration max, rows, bytes], ...]. A cell that is a
// duplicate adds to the first one, a cell without request is ignored, and the cells past the cap of a bucket go to the overflow cell of
// their type: no request is lost. The client of a cell that its key has no room for (16 names) or that the table has no room for (4096)
// is "other": the cells that this makes equal are one cell.
void cells_into(Usage::Bucket* bucket, const rapidjson::Value& cells, const std::string& at, Usage::State* state, Usage::Entry* entry) {
  for (const auto& item : cells.GetArray()) {
    if (!item.IsArray() || item.Size() != kCellFields) file_error(at + " has a cell that is not a type, a client, a method, a result and 5 counts");
    for (rapidjson::SizeType i = 0; i < 4; ++i) {
      if (!item[i].IsString()) file_error(at + " has a cell whose type, client, method and result are not text");
    }
    const int kind = kind_index(view_of(item[0]));
    if (kind < 0) file_error(at + " has a cell of a type that is not known");
    if (!valid_client(view_of(item[1]))) file_error(at + " has a client that is not valid");
    if (!valid_method(view_of(item[2]))) file_error(at + " has a method that is not valid");
    if (!valid_name(view_of(item[3]))) file_error(at + " has a result that is not valid");
    uint64_t counts[5];
    for (rapidjson::SizeType i = 0; i < 5; ++i) counts[i] = count_of(item[i + 4], at);
    if (counts[0] == 0) continue;
    const uint16_t client = client_id_of(*entry, state->clients, std::string(view_of(item[1])));
    const uint64_t key = cell_key(static_cast<McpUsageKind>(kind), client, state->names.intern(view_of(item[2])), state->names.intern(view_of(item[3])));
    Usage::Cell& cell = cell_of(*bucket, key, &state->cells, SIZE_MAX);
    cell.count += counts[0];
    cell.duration_ms_sum += counts[1];
    cell.duration_ms_max = std::max(cell.duration_ms_max, counts[2]);
    cell.rows += counts[3];
    cell.bytes += counts[4];
  }
}

// The buckets of a tier: [[start, cells], ...] by start. The start is a multiple of the step of the tier.
std::vector<Usage::Bucket> buckets_of(const rapidjson::Value& value, const std::string& where, size_t tier, Usage::State* state, Usage::Entry* entry) {
  if (!value.IsArray()) file_error(where + " must be an array");
  const TierSpec& spec = kTierSpecs[tier];
  std::vector<Usage::Bucket> out;
  size_t index = 0;
  for (const auto& item : value.GetArray()) {
    const std::string at = where + "[" + std::to_string(index++) + "]";
    if (!item.IsArray() || item.Size() != kBucketFields) file_error(at + " must be an array of 2 fields: the start and the cells");
    Usage::Bucket bucket;
    if (!item[0].IsInt64() || item[0].GetInt64() <= 0 || item[0].GetInt64() % spec.step != 0) {
      file_error(at + " must start at a multiple of " + std::to_string(spec.step) + " seconds, the step of the tier " + spec.member);
    }
    bucket.start = item[0].GetInt64();
    if (!out.empty() && out.back().start >= bucket.start) file_error(at + " is not after the bucket before it");
    if (!item[1].IsArray()) file_error(at + " must end with the cells (an array)");
    cells_into(&bucket, item[1], at, state, entry);
    out.push_back(std::move(bucket));
  }
  return out;
}

// Parses a usage file into `state`. Throws std::runtime_error with a message that never holds the content of the file.
void parse_usage(std::string_view text, Usage::State* state, size_t max_clients) {
  rapidjson::Document doc;
  parse_json_bounded<rapidjson::kParseValidateEncodingFlag>(doc, text);
  if (doc.HasParseError()) file_error("not valid JSON");
  if (!doc.IsObject()) file_error("the top level must be a JSON object");
  const auto version = doc.FindMember("version");
  if (version == doc.MemberEnd() || !version->value.IsInt() || version->value.GetInt() != kMcpUsageFileVersion) file_error("version must be 1");
  state->since = time_of(member(doc, "since", "the file"), "since");
  if (state->since == 0) file_error("since must be an ISO 8601 UTC time");
  const rapidjson::Value& keys = member(doc, "keys", "the file");
  if (!keys.IsArray()) file_error("keys must be an array");
  size_t index = 0;
  for (const auto& item : keys.GetArray()) {
    const std::string where = "keys[" + std::to_string(index++) + "]";
    if (!item.IsObject()) file_error(where + " must be an object");
    Usage::Entry entry;
    entry.key.id = text_of(member(item, "id", where), where + ".id", 32);
    if (!mcp_valid_key_id(entry.key.id)) file_error(where + ".id is not the id of a key");
    entry.key.name = text_of(member(item, "name", where), where + ".name", kMcpNameMaxBytes);
    if (!mcp_valid_key_name(entry.key.name)) file_error(where + ".name is not the name of a key");
    entry.key.source = text_of(member(item, "source", where), where + ".source", 16);
    if (entry.key.source != "config" && entry.key.source != "ui") file_error(where + ".source must be config or ui");
    entry.key.host = text_of(member(item, "host", where), where + ".host", kHostBytes);
    entry.first_used = time_of(member(item, "first_used_at", where), where + ".first_used_at");
    entry.last_used = time_of(member(item, "last_used_at", where), where + ".last_used_at");
    entry.deleted_at = time_of(member(item, "deleted_at", where), where + ".deleted_at");
    const rapidjson::Value& clients = member(item, "clients", where);
    if (!clients.IsArray()) file_error(where + ".clients must be an array");
    for (const auto& value : clients.GetArray()) {
      const std::string at = where + ".clients";
      if (!value.IsObject()) file_error(at + " must hold objects");
      Usage::Client client;
      client.name = text_of(member(value, "name", at), at + ".name", kClientNameBytes);
      client.version = text_of(member(value, "version", at), at + ".version", kClientVersionBytes);
      client.user_agent = text_of(member(value, "user_agent", at), at + ".user_agent", kUserAgentBytes);
      if (client.name != mcp_usage_clean(client.name, kClientNameBytes) || client.version != mcp_usage_clean(client.version, kClientVersionBytes) ||
          client.user_agent != mcp_usage_clean(client.user_agent, kUserAgentBytes)) {
        file_error(at + " has a text that is not printable ASCII");
      }
      client.first_seen = time_of(member(value, "first_seen_at", at), at + ".first_seen_at");
      client.last_seen = time_of(member(value, "last_seen_at", at), at + ".last_seen_at");
      client.requests = count_of(member(value, "requests", at), at + ".requests");
      entry.clients.push_back(std::move(client));
    }
    // More clients than the cap (a cap that was lowered): the ones seen last stay.
    if (entry.clients.size() > max_clients) {
      std::sort(entry.clients.begin(), entry.clients.end(), [](const Usage::Client& a, const Usage::Client& b) { return a.last_seen > b.last_seen; });
      entry.clients.resize(max_clients);
    }
    for (size_t tier = 0; tier < kMcpUsageTiers; ++tier) {
      const std::string name = kTierSpecs[tier].member;
      entry.tiers[tier] = buckets_of(member(item, kTierSpecs[tier].member, where), where + "." + name, tier, state, &entry);
    }
    rebuild_client_ids(entry);
    const std::string id = entry.key.id;
    if (!state->entries.emplace(id, std::move(entry)).second) file_error("two entries have the id " + id);
  }
}

// The text of the file, or nullopt when it does not exist (its directory must).
std::optional<std::string> read_usage_file(const std::string& path) {
  namespace fs = std::filesystem;
  std::error_code ec;
  const fs::path target(path);
  if (!fs::exists(target, ec)) {
    fs::path dir = target.parent_path();
    if (dir.empty()) dir = ".";
    if (!fs::is_directory(dir, ec)) file_error("the directory " + dir.string() + " does not exist");
    return std::nullopt;
  }
  if (!fs::is_regular_file(target, ec)) file_error("not a regular file");
  const auto size = fs::file_size(target, ec);
  if (ec) file_error(std::string("cannot read the file: ") + ec.message());
  if (size > kMaxFileBytes) file_error("the file is larger than 128 MiB");
  std::ifstream input(path, std::ios::binary);
  if (!input) file_error(std::string("cannot open the file: ") + std::generic_category().message(errno));
  std::ostringstream content;
  content << input.rdbuf();
  if (input.bad()) file_error("cannot read the file");
  return content.str();
}

// ---- the JSON of the answers and of the file ---------------------------------------------------------

void put(McpJsonWriter& w, std::string_view text) { write_json_text(w, text); }

void put_time(McpJsonWriter& w, const char* name, int64_t seconds) {
  w.Key(name);
  if (seconds > 0) put(w, mcp_iso_utc(seconds));
  else w.Null();
}

void put_bucket(McpJsonWriter& w, const Usage::Bucket& bucket, const Usage::Names& names, const Usage::ClientNames& clients) {
  w.StartArray();
  w.Int64(bucket.start);
  w.StartArray();
  for (const auto& cell : bucket.cells) {
    w.StartArray();
    w.String(kKindNames[static_cast<size_t>(kind_of(cell.key))]);
    put(w, clients.by_id[client_of(cell.key)]);
    put(w, names.by_id[method_of(cell.key)]);
    put(w, names.by_id[result_of(cell.key)]);
    for (const uint64_t value : {cell.count, cell.duration_ms_sum, cell.duration_ms_max, cell.rows, cell.bytes}) w.Uint64(value);
    w.EndArray();
  }
  w.EndArray();
  w.EndArray();
}

const std::vector<Usage::Bucket>& window_buckets(const Usage::Entry& entry, const McpUsageWindow& window) { return entry.tiers[window.tier]; }

bool in_window(const Usage::Bucket& bucket, const McpUsageWindow& window) {
  return bucket.start >= window.from && bucket.start < window.from + static_cast<int64_t>(window.points) * window.step;
}

Usage::Counters window_total(const Usage::Entry* entry, const McpUsageWindow& window) {
  Usage::Counters total;
  if (!entry) return total;
  for (const auto& bucket : window_buckets(*entry, window)) {
    if (!in_window(bucket, window)) continue;
    for (const auto& cell : bucket.cells) add_to_counters(total, cell);
  }
  return total;
}

void put_head(McpJsonWriter& w, const McpUsageWindow& window, int64_t now, int64_t since, bool persisted, int64_t retention_days) {
  w.Key("window"); put(w, window.name);
  w.Key("from"); put(w, mcp_iso_utc(window.from));
  w.Key("to"); put(w, mcp_iso_utc(now));
  w.Key("since"); put(w, mcp_iso_utc(since));
  w.Key("persisted"); w.Bool(persisted);
  w.Key("retention_days"); w.Int64(retention_days);
}

void put_key(McpJsonWriter& w, const McpUsageKeyRef& key, int64_t deleted_at) {
  w.Key("id"); put(w, key.id);
  w.Key("name"); put(w, key.name);
  w.Key("host"); put(w, key.host);
  w.Key("source"); put(w, key.source);
  put_time(w, "deleted_at", deleted_at);
}

void put_summary(McpJsonWriter& w, const McpUsageKeyRef& key, const Usage::Entry* entry, int64_t deleted_at, const McpUsageWindow& window) {
  const Usage::Counters total = window_total(entry, window);
  w.StartObject();
  put_key(w, key, deleted_at);
  w.Key("requests"); w.Uint64(total.requests);
  w.Key("calls"); w.Uint64(total.calls);
  w.Key("errors"); w.Uint64(total.errors);
  w.Key("rate_limited"); w.Uint64(total.rate_limited);
  w.Key("rejected"); w.Uint64(total.rejected);
  put_time(w, "first_used_at", entry ? entry->first_used : 0);
  put_time(w, "last_used_at", entry ? entry->last_used : 0);
  w.EndObject();
}

// The average over `count` (null when there is none), rounded.
void put_average(McpJsonWriter& w, const char* name, uint64_t sum, uint64_t count) {
  w.Key(name);
  if (count == 0) w.Null();
  else w.Uint64((sum + count / 2) / count);
}

// A figure that has no value when `has` is false (the largest time of nothing).
void put_largest(McpJsonWriter& w, const char* name, bool has, uint64_t value) {
  w.Key(name);
  if (!has) w.Null();
  else w.Uint64(value);
}

// The nine totals as the members of an object, in the order of the answers: the time is the one of the tool calls.
void put_counters(McpJsonWriter& w, const Usage::Counters& total) {
  w.Key("requests"); w.Uint64(total.requests);
  w.Key("calls"); w.Uint64(total.calls);
  w.Key("errors"); w.Uint64(total.errors);
  w.Key("rate_limited"); w.Uint64(total.rate_limited);
  w.Key("rejected"); w.Uint64(total.rejected);
  put_average(w, "duration_ms_avg", total.duration_ms_sum, total.calls);
  put_largest(w, "duration_ms_max", total.calls != 0, total.duration_ms_max);
  w.Key("rows"); w.Uint64(total.rows);
  w.Key("bytes"); w.Uint64(total.bytes);
}

// ---- the overview ----------------------------------------------------------------------------------

constexpr size_t kFacetRows = 200;
constexpr size_t kSeriesGroups = 8;
constexpr size_t kClientVersions = 5;

// What the series is grouped by.
enum class Group { Key, Method, Client, Result, Type };

Group group_of(const std::string& name) {
  if (name == "key") return Group::Key;
  if (name == "client") return Group::Client;
  if (name == "result") return Group::Result;
  if (name == "type") return Group::Type;
  return Group::Method;
}

// The metrics of a point of the series, in the order of their members: the requests, the errors, the calls, the time of the calls and
// the bytes (add_to_counters says what each one counts).
constexpr const char* kSeriesMetrics[] = {"requests", "errors", "calls", "duration_ms_sum", "bytes"};
constexpr size_t kMetrics = sizeof(kSeriesMetrics) / sizeof(kSeriesMetrics[0]);

// The kind of a row of the methods: a tool, a method of the protocol, or what was refused before its message was read.
enum RowKind : uint8_t { kRowCall, kRowRequest, kRowRefused };
constexpr size_t kRowKinds = 3;
constexpr const char* kRowKindNames[] = {"call", "request", "refused"};

RowKind row_kind_of(McpUsageKind kind) {
  switch (kind) {
    case McpUsageKind::ToolCall: return kRowCall;
    case McpUsageKind::Request: return kRowRequest;
    case McpUsageKind::RateLimited:
    case McpUsageKind::Rejected: break;
  }
  return kRowRefused;
}

// The kind of the row of a method that nothing used in the window: it is only known by its name.
RowKind row_kind_named(const std::string& method) {
  if (method == "unread") return kRowRefused;
  if (method == "other" || method == "invalid" || protocol_method(method) != kNameOther) return kRowRequest;
  return kRowCall;
}

// What the filters keep, in the terms of the cells. A value that no cell has (a key that is not there, a name that was never
// counted) is in no set: the filter then keeps nothing.
struct Filter {
  bool keys_on = false;
  std::unordered_set<std::string> keys;
  bool methods_on = false;
  std::bitset<kMaxNames> methods;
  bool clients_on = false;
  std::bitset<kMaxNames> clients;
  bool results_on = false;
  std::bitset<kMaxNames> results;
  bool types_on = false;
  std::array<bool, kKinds> types{};

  bool key(const std::string& id) const { return !keys_on || keys.count(id) != 0; }
  bool method(uint16_t id) const { return !methods_on || methods.test(id); }
  bool client(uint16_t id) const { return !clients_on || clients.test(id); }
  bool result(uint16_t id) const { return !results_on || results.test(id); }
  bool type(McpUsageKind kind) const { return !types_on || types[static_cast<size_t>(kind)]; }
};

struct KeyRow {
  std::string id;
  std::string name;
  std::string host;
  std::string source;
  int64_t deleted_at = 0;
  int64_t last_used = 0;
  Usage::Counters counters;
  bool selected = false;
};

// The cells of one client in the facet of the clients: the totals of a key, and the keys that have a request of the client.
struct ClientFigures {
  Usage::Counters counters;
  uint64_t keys = 0;
  size_t last_entry = SIZE_MAX;  // the entry that was counted last: the entries are walked one after the other
};

void add_client_figures(ClientFigures& into, const Usage::Cell& cell, size_t entry) {
  add_to_counters(into.counters, cell);
  if (into.last_entry != entry) {
    ++into.keys;
    into.last_entry = entry;
  }
}

// What the records of the clients of the keys that the filter keeps say of a client name: when it was last seen, and its versions.
struct ClientSeen {
  int64_t last_seen = 0;
  std::vector<std::pair<int64_t, std::string>> versions;  // when a record was last seen, and its version
};

// Everything that the entries add to an answer. An entry is walked once: the totals and the series with all the filters, each facet
// with all the filters but its own, the records of the clients with the filter of the keys. The rows are indexed by id: a cell costs a
// few additions, whatever the number of rows.
struct Tally {
  Tally(const Filter& f, const McpUsageWindow& w, Group g, size_t entries)
      : filter(f),
        window(w),
        group(g),
        methods(kRowKinds * kMaxNames),
        results(kMaxNames),
        clients(kMaxNames),
        series(g == Group::Key ? entries : g == Group::Type ? kKinds : kMaxNames) {}
  const Filter& filter;
  const McpUsageWindow& window;
  Group group;
  Usage::Counters totals;
  size_t active_keys = 0;  // the keys that have a request that every filter keeps
  std::unordered_map<std::string, KeyRow> keys;
  std::vector<Figures> methods;  // by kind of row and method: kind * kMaxNames + method
  std::vector<Figures> results;  // by result
  std::array<uint64_t, kKinds> types{};
  std::vector<ClientFigures> clients;  // by client
  // The metrics at each point of the window, by group: the entry (its index) for a group by key, else the method, the client, the
  // result or the type. A group without a request has none; else it has kMetrics * points counts, a metric after the other.
  std::vector<std::vector<uint64_t>> series;
  std::unordered_map<std::string, ClientSeen> seen;  // by client name
};

// The records of the clients of an entry that the filter of the keys keeps, by the name that their requests count under.
void tally_records(Tally& t, const Usage::Entry& entry) {
  for (const auto& record : entry.clients) {
    ClientSeen& seen = t.seen[client_name_of(record)];
    seen.last_seen = std::max(seen.last_seen, record.last_seen);
    if (!record.version.empty()) seen.versions.emplace_back(record.last_seen, record.version);
  }
}

// A cell adds to a group at one point of the series: the metrics are the counts of add_to_counters, so the groups add up to the totals.
void add_to_series(std::vector<uint64_t>& values, size_t points, size_t point, const Usage::Cell& cell) {
  if (values.empty()) values.assign(kMetrics * points, 0);
  Usage::Counters one;
  add_to_counters(one, cell);
  const uint64_t counts[kMetrics] = {one.requests, one.errors, one.calls, one.duration_ms_sum, one.bytes};
  for (size_t metric = 0; metric < kMetrics; ++metric) values[metric * points + point] += counts[metric];
}

// Adds an entry (the `index`-th of the sorted ids) to the tally. `live` is the key when it exists.
void tally_entry(Tally& t, size_t index, const std::string& id, const Usage::Entry& entry, const McpUsageKeyRef* live) {
  const Filter& f = t.filter;
  const bool key_kept = f.key(id);
  if (key_kept) tally_records(t, entry);
  Usage::Counters mine;  // the facet of the keys: every filter but the one of the keys
  bool any = false;
  for (const auto& bucket : window_buckets(entry, t.window)) {
    if (!in_window(bucket, t.window)) continue;
    const auto point = static_cast<size_t>((bucket.start - t.window.from) / t.window.step);
    for (const auto& cell : bucket.cells) {
      const McpUsageKind kind = kind_of(cell.key);
      const uint16_t client = client_of(cell.key);
      const uint16_t method = method_of(cell.key);
      const uint16_t result = result_of(cell.key);
      const bool by_client = f.client(client);
      const bool by_method = f.method(method);
      const bool by_result = f.result(result);
      const bool by_type = f.type(kind);
      if (by_client && by_method && by_result && by_type) add_to_counters(mine, cell);
      if (!key_kept) continue;
      if (by_client && by_result && by_type) add_figures(t.methods[row_kind_of(kind) * kMaxNames + method], cell, index);
      if (by_client && by_method && by_type) add_figures(t.results[result], cell, index);
      if (by_client && by_method && by_result) t.types[static_cast<size_t>(kind)] += cell.count;
      if (by_method && by_result && by_type) add_client_figures(t.clients[client], cell, index);
      if (!(by_client && by_method && by_result && by_type)) continue;
      any = true;
      add_to_counters(t.totals, cell);
      size_t group = 0;
      switch (t.group) {
        case Group::Key: group = index; break;
        case Group::Method: group = method; break;
        case Group::Client: group = client; break;
        case Group::Result: group = result; break;
        case Group::Type: group = static_cast<size_t>(kind); break;
      }
      add_to_series(t.series[group], t.window.points, point, cell);
    }
  }
  if (any) ++t.active_keys;
  const bool selected = f.keys_on && f.keys.count(id) != 0;
  if (mine.requests == 0 && !selected) return;
  KeyRow& row = t.keys[id];
  const McpUsageKeyRef& named = live ? *live : entry.key;
  row.id = id;
  row.name = named.name;
  row.host = named.host;
  row.source = named.source;
  row.deleted_at = live ? 0 : entry.deleted_at;
  row.last_used = entry.last_used;
  row.counters = mine;
  row.selected = selected;
}

// The facet rows to show: the first ones, and the selected ones after them. Returns how many were left out.
template <typename Row>
size_t cap_rows(std::vector<Row>* rows, size_t most) {
  const size_t before = rows->size();
  size_t kept = 0;
  for (size_t i = 0; i < rows->size(); ++i) {
    if (i >= most && !(*rows)[i].selected) continue;
    if (kept != i) (*rows)[kept] = std::move((*rows)[i]);
    ++kept;
  }
  rows->resize(kept);
  return before - kept;
}

struct MethodRow {
  std::string method;
  uint8_t kind = kRowCall;
  Figures figures;
  bool selected = false;
};

struct ResultRow {
  std::string result;
  Figures figures;
  bool selected = false;
};

struct ClientRow {
  std::string client;
  ClientFigures figures;
  bool selected = false;
};

struct SeriesGroup {
  std::string id;
  std::string label;
  uint64_t total = 0;             // its requests
  std::vector<uint64_t> metrics;  // as the series of the tally
};

bool listed(const std::vector<std::string>& values, const std::string& value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

// The metrics of a group, one array for each, as the members of an object.
void put_metrics(McpJsonWriter& w, const std::vector<uint64_t>& metrics, size_t points) {
  for (size_t metric = 0; metric < kMetrics; ++metric) {
    w.Key(kSeriesMetrics[metric]);
    w.StartArray();
    for (size_t point = 0; point < points; ++point) w.Uint64(metrics[metric * points + point]);
    w.EndArray();
  }
}

void put_strings(McpJsonWriter& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) put(w, value);
  w.EndArray();
}

// The groups of the series, from the metrics that were counted at each point. A series grouped by a dimension that is filtered shows
// the values that were chosen, in their order (a value without a request is a line of zeros); else the 8 largest groups by requests
// (the same total: the smaller id first), and the others summed in `rest`.
void put_series(McpJsonWriter& w, const Tally& t, const McpUsageOverviewQuery& query, const std::vector<std::string>& names,
                const std::vector<std::string>& client_names, const std::vector<std::string>& ids,
                const std::unordered_map<std::string, std::string>& key_names) {
  const size_t points = t.window.points;
  const auto id_of = [&](size_t group) -> std::string {
    switch (t.group) {
      case Group::Key: return ids[group];
      case Group::Method:
      case Group::Result: return names[group];
      case Group::Client: return client_names[group];
      case Group::Type: break;
    }
    return kKindNames[group];
  };
  const auto label_of = [&](const std::string& id) -> std::string {
    if (t.group != Group::Key) return id;
    const auto it = key_names.find(id);
    return it == key_names.end() ? id : it->second;
  };
  const std::vector<std::string>* chosen = nullptr;
  switch (t.group) {
    case Group::Key: chosen = &query.keys; break;
    case Group::Method: chosen = &query.methods; break;
    case Group::Client: chosen = &query.clients; break;
    case Group::Result: chosen = &query.results; break;
    case Group::Type: chosen = &query.types; break;
  }
  // The groups that have requests, by id.
  struct Counted {
    std::string id;
    uint64_t total = 0;
    const std::vector<uint64_t>* metrics = nullptr;
  };
  std::vector<Counted> counted;
  for (size_t group = 0; group < t.series.size(); ++group) {
    const std::vector<uint64_t>& metrics = t.series[group];
    if (metrics.empty()) continue;
    Counted item;
    item.id = id_of(group);
    for (size_t point = 0; point < points; ++point) item.total += metrics[point];  // the requests come first
    item.metrics = &metrics;
    counted.push_back(std::move(item));
  }
  std::vector<SeriesGroup> groups;
  SeriesGroup rest;
  rest.metrics.assign(kMetrics * points, 0);
  size_t folded = 0;
  const auto show = [&](const std::string& id, const Counted* item) {
    SeriesGroup group;
    group.id = id;
    group.label = label_of(id);
    group.total = item ? item->total : 0;
    group.metrics = item ? *item->metrics : std::vector<uint64_t>(kMetrics * points, 0);
    groups.push_back(std::move(group));
  };
  if (!chosen->empty()) {
    for (const auto& id : *chosen) {
      const auto it = std::find_if(counted.begin(), counted.end(), [&](const Counted& item) { return item.id == id; });
      show(id, it == counted.end() ? nullptr : &*it);
    }
  } else {
    std::sort(counted.begin(), counted.end(), [](const Counted& a, const Counted& b) { return a.total != b.total ? a.total > b.total : a.id < b.id; });
    for (size_t i = 0; i < counted.size(); ++i) {
      if (i < kSeriesGroups) {
        show(counted[i].id, &counted[i]);
        continue;
      }
      ++folded;
      rest.total += counted[i].total;
      for (size_t m = 0; m < kMetrics * points; ++m) rest.metrics[m] += (*counted[i].metrics)[m];
    }
  }
  w.Key("series");
  w.StartObject();
  w.Key("step"); w.Int64(t.window.step);
  w.Key("t");
  w.StartArray();
  for (size_t i = 0; i < points; ++i) put(w, mcp_iso_utc(t.window.from + static_cast<int64_t>(i) * t.window.step));
  w.EndArray();
  w.Key("groups");
  w.StartArray();
  for (const auto& group : groups) {
    w.StartObject();
    w.Key("id"); put(w, group.id);
    w.Key("label"); put(w, group.label);
    w.Key("total"); w.Uint64(group.total);
    put_metrics(w, group.metrics, points);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rest");
  w.StartObject();
  w.Key("groups"); w.Uint64(folded);
  w.Key("total"); w.Uint64(rest.total);
  put_metrics(w, rest.metrics, points);
  w.EndObject();
  w.EndObject();
}

// Up to 5 distinct versions that the records of a client saw, the one seen last first.
std::vector<std::string> versions_of(std::vector<std::pair<int64_t, std::string>> versions) {
  std::sort(versions.begin(), versions.end(), [](const auto& a, const auto& b) { return a.first != b.first ? a.first > b.first : a.second < b.second; });
  std::vector<std::string> out;
  for (const auto& item : versions) {
    if (out.size() >= kClientVersions) break;
    if (!listed(out, item.second)) out.push_back(item.second);
  }
  return out;
}

// The facets and the clients, after the totals and the series.
void put_facets(McpJsonWriter& w, const Tally& t, const McpUsageOverviewQuery& query, const std::vector<std::string>& names,
                const std::vector<std::string>& client_names, const std::vector<McpUsageKeyRef>& live) {
  // The keys: those that have a request (every filter but their own), and the ones that were chosen.
  std::vector<KeyRow> keys;
  for (const auto& item : t.keys) keys.push_back(item.second);
  for (const auto& id : query.keys) {
    if (t.keys.count(id)) continue;
    KeyRow row;
    row.id = id;
    row.name = id;  // a key that is not there (its usage is gone) is known by its id
    row.selected = true;
    for (const auto& ref : live) {
      if (ref.id != id) continue;
      row.name = ref.name;
      row.host = ref.host;
      row.source = ref.source;
    }
    keys.push_back(std::move(row));
  }
  std::sort(keys.begin(), keys.end(), [](const KeyRow& a, const KeyRow& b) {
    if (a.counters.requests != b.counters.requests) return a.counters.requests > b.counters.requests;
    return a.name != b.name ? a.name < b.name : a.id < b.id;
  });
  const size_t keys_omitted = cap_rows(&keys, kFacetRows);

  std::vector<MethodRow> methods;
  for (size_t i = 0; i < t.methods.size(); ++i) {
    if (t.methods[i].requests == 0) continue;
    MethodRow row;
    row.method = names[i % kMaxNames];
    row.kind = static_cast<uint8_t>(i / kMaxNames);
    row.figures = t.methods[i];
    row.selected = listed(query.methods, row.method);
    methods.push_back(std::move(row));
  }
  for (const auto& method : query.methods) {
    const bool counted = std::any_of(methods.begin(), methods.end(), [&](const MethodRow& row) { return row.method == method; });
    if (counted) continue;
    MethodRow row;
    row.method = method;
    row.kind = row_kind_named(method);
    row.selected = true;
    methods.push_back(std::move(row));
  }
  std::sort(methods.begin(), methods.end(), [](const MethodRow& a, const MethodRow& b) {
    if (a.figures.requests != b.figures.requests) return a.figures.requests > b.figures.requests;
    return a.method != b.method ? a.method < b.method : a.kind < b.kind;
  });
  const size_t methods_omitted = cap_rows(&methods, kFacetRows);

  std::vector<ResultRow> results;
  for (size_t id = 0; id < t.results.size(); ++id) {
    if (t.results[id].requests == 0) continue;
    ResultRow row;
    row.result = names[id];
    row.figures = t.results[id];
    row.selected = listed(query.results, row.result);
    results.push_back(std::move(row));
  }
  for (const auto& result : query.results) {
    const bool counted = std::any_of(results.begin(), results.end(), [&](const ResultRow& row) { return row.result == result; });
    if (counted) continue;
    ResultRow row;
    row.result = result;
    row.selected = true;
    results.push_back(std::move(row));
  }
  std::sort(results.begin(), results.end(), [](const ResultRow& a, const ResultRow& b) {
    return a.figures.requests != b.figures.requests ? a.figures.requests > b.figures.requests : a.result < b.result;
  });
  const size_t results_omitted = cap_rows(&results, kFacetRows);

  // The clients: those that have a request in the window (every filter but their own), and the ones that were chosen.
  std::vector<ClientRow> clients;
  for (size_t id = 0; id < t.clients.size(); ++id) {
    if (t.clients[id].counters.requests == 0) continue;
    ClientRow row;
    row.client = client_names[id];
    row.figures = t.clients[id];
    row.selected = listed(query.clients, row.client);
    clients.push_back(std::move(row));
  }
  for (const auto& client : query.clients) {
    const bool counted = std::any_of(clients.begin(), clients.end(), [&](const ClientRow& row) { return row.client == client; });
    if (counted) continue;
    ClientRow row;
    row.client = client;
    row.selected = true;
    clients.push_back(std::move(row));
  }
  std::sort(clients.begin(), clients.end(), [](const ClientRow& a, const ClientRow& b) {
    if (a.figures.counters.requests != b.figures.counters.requests) return a.figures.counters.requests > b.figures.counters.requests;
    return a.client < b.client;
  });
  const size_t clients_omitted = cap_rows(&clients, kFacetRows);

  w.Key("keys");
  w.StartArray();
  for (const auto& row : keys) {
    w.StartObject();
    put_key(w, McpUsageKeyRef{row.id, row.name, row.host, row.source}, row.deleted_at);
    put_counters(w, row.counters);
    put_time(w, "last_used_at", row.last_used);
    w.EndObject();
  }
  w.EndArray();
  w.Key("methods");
  w.StartArray();
  for (const auto& row : methods) {
    const Figures& f = row.figures;
    w.StartObject();
    w.Key("method"); put(w, row.method);
    w.Key("kind"); w.String(kRowKindNames[row.kind]);
    w.Key("requests"); w.Uint64(f.requests);
    w.Key("errors"); w.Uint64(f.errors);
    put_average(w, "duration_ms_avg", f.duration_ms_sum, f.requests);
    put_largest(w, "duration_ms_max", f.requests != 0, f.duration_ms_max);
    w.Key("rows"); w.Uint64(f.rows);
    w.Key("bytes"); w.Uint64(f.bytes);
    w.Key("keys"); w.Uint64(f.keys);
    w.EndObject();
  }
  w.EndArray();
  w.Key("results");
  w.StartArray();
  for (const auto& row : results) {
    w.StartObject();
    w.Key("result"); put(w, row.result);
    w.Key("count"); w.Uint64(row.figures.requests);
    w.Key("keys"); w.Uint64(row.figures.keys);
    w.EndObject();
  }
  w.EndArray();
  w.Key("types");
  w.StartArray();
  for (size_t i = 0; i < kKinds; ++i) {
    w.StartObject();
    w.Key("type"); w.String(kKindNames[i]);
    w.Key("requests"); w.Uint64(t.types[i]);
    w.EndObject();
  }
  w.EndArray();
  w.Key("clients");
  w.StartArray();
  for (const auto& row : clients) {
    const auto seen = t.seen.find(row.client);
    w.StartObject();
    w.Key("client"); put(w, row.client);
    put_counters(w, row.figures.counters);
    w.Key("keys"); w.Uint64(row.figures.keys);
    w.Key("versions");
    if (seen == t.seen.end()) put_strings(w, {});
    else put_strings(w, versions_of(seen->second.versions));
    put_time(w, "last_seen_at", seen == t.seen.end() ? 0 : seen->second.last_seen);
    w.EndObject();
  }
  w.EndArray();
  w.Key("omitted");
  w.StartObject();
  w.Key("keys"); w.Uint64(keys_omitted);
  w.Key("methods"); w.Uint64(methods_omitted);
  w.Key("results"); w.Uint64(results_omitted);
  w.Key("clients"); w.Uint64(clients_omitted);
  w.EndObject();
}

} // namespace

// ---- names, windows, text -------------------------------------------------------------------------

McpUsage::Names::Names() {
  const auto add = [this](const char* name) {
    ids.emplace(name, static_cast<uint16_t>(by_id.size()));
    by_id.emplace_back(name);
  };
  add("other");
  add("ok");
  for (const char* method : kProtocolMethods) add(method);
  add("invalid");
  add("unread");
}

uint16_t McpUsage::Names::intern(std::string_view name) {
  const std::string text(name);
  if (const auto it = ids.find(text); it != ids.end()) return it->second;
  if (by_id.size() >= kMaxNames) return 0;
  const auto id = static_cast<uint16_t>(by_id.size());
  by_id.push_back(text);
  ids.emplace(text, id);
  return id;
}

McpUsage::ClientNames::ClientNames() {
  for (const char* name : {"other", "unknown"}) {
    ids.emplace(name, static_cast<uint16_t>(by_id.size()));
    by_id.emplace_back(name);
  }
}

uint16_t McpUsage::ClientNames::intern(std::string_view name) {
  const std::string text(name);
  if (const auto it = ids.find(text); it != ids.end()) return it->second;
  if (by_id.size() >= kMaxNames) return kClientOther;
  const auto id = static_cast<uint16_t>(by_id.size());
  by_id.push_back(text);
  ids.emplace(text, id);
  return id;
}

McpUsageKeyRef mcp_usage_key_ref(const McpKey& key) {
  return McpUsageKeyRef{key.id, key.name, key.hosts.size() == 1 ? key.hosts.front() : std::string(), key.source};
}

bool mcp_valid_key_id(std::string_view id) {
  if (mcp_valid_key_name(id)) return true;
  if (id.size() != 15 || id.substr(0, 3) != "ui_") return false;
  return std::all_of(id.begin() + 3, id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

std::vector<std::string> mcp_usage_windows(int64_t retention_days) {
  std::vector<std::string> out;
  for (const auto& spec : kWindowSpecs) {
    if (retention_days >= spec.min_days) out.push_back(spec.name);
  }
  return out;
}

std::string mcp_usage_default_window(int64_t retention_days) { return retention_days >= 7 ? "7d" : "24h"; }

std::optional<McpUsageWindow> mcp_usage_window(std::string_view name, int64_t retention_days, int64_t now) {
  for (const auto& spec : kWindowSpecs) {
    if (name != spec.name || retention_days < spec.min_days) continue;
    McpUsageWindow window;
    window.name = std::string(name);
    window.tier = spec.tier;
    window.step = kTierSpecs[spec.tier].step;
    window.points = spec.points;
    window.from = floor_to(now, window.step) - (static_cast<int64_t>(spec.points) - 1) * window.step;
    return window;
  }
  return std::nullopt;
}

std::string mcp_usage_clean(std::string_view text, size_t max_bytes) {
  std::string out;
  for (const char c : text) {
    if (out.size() >= max_bytes) break;
    out.push_back(c >= 0x20 && c <= 0x7e ? c : '?');
  }
  const auto first = out.find_first_not_of(' ');
  if (first == std::string::npos) return {};
  out.erase(0, first);
  out.erase(out.find_last_not_of(' ') + 1);
  return out;
}

void mcp_check_usage_file(const std::string& path) {
  const auto text = read_usage_file(path);
  if (!text) return;
  Usage::State state;
  parse_usage(*text, &state, SIZE_MAX);
}

std::optional<McpValidationError> mcp_usage_overview_check(McpUsageOverviewQuery* query) {
  const auto bad = [](const char* field, const char* reason, std::string message) {
    return McpValidationError{field, reason, std::move(message)};
  };
  if (query->group != "key" && query->group != "method" && query->group != "client" && query->group != "result" && query->group != "type") {
    return bad("group", "invalid", "group must be key, method, client, result or type");
  }
  const auto check = [&](const char* field, std::vector<std::string>* values, bool (*valid)(const std::string&),
                         const char* rule) -> std::optional<McpValidationError> {
    std::vector<std::string> once;
    for (auto& value : *values) {
      if (!listed(once, value)) once.push_back(std::move(value));
    }
    *values = std::move(once);
    if (values->size() > kMcpUsageOverviewMaxValues) {
      return bad(field, "too_many", std::string(field) + " takes at most " + std::to_string(kMcpUsageOverviewMaxValues) + " values");
    }
    for (const auto& value : *values) {
      if (!valid(value)) return bad(field, "invalid", std::string(field) + " must be " + rule);
    }
    return std::nullopt;
  };
  if (const auto error = check("key", &query->keys, [](const std::string& v) { return mcp_valid_key_id(v); }, "the id of a key")) return error;
  if (const auto error = check("method", &query->methods, [](const std::string& v) { return valid_method(v); }, "a tool or a method of the protocol (A-Z a-z 0-9 _ /, at most 64)")) return error;
  if (const auto error = check("client", &query->clients, [](const std::string& v) { return valid_client(v); }, "a client name (printable ASCII, 1 to 64 bytes)")) return error;
  if (const auto error = check("result", &query->results, [](const std::string& v) { return valid_name(v); }, "a result (a-z 0-9 _, at most 64)")) return error;
  if (const auto error = check("type", &query->types, [](const std::string& v) { return kind_index(v) >= 0; }, "call, request, limited or rejected")) return error;
  return std::nullopt;
}

// ---- the store ------------------------------------------------------------------------------------

McpUsage::McpUsage(McpUsageOptions options, int64_t now) : options_(std::move(options)) {
  options_.retention_days = std::clamp<int64_t>(options_.retention_days, 1, kMcpUsageMaxRetentionDays);
  bool loaded = false;
  if (persisted()) {
    if (const auto text = read_usage_file(options_.file)) {
      parse_usage(*text, &state_, options_.max_clients);
      loaded = true;
    }
  }
  since_ = loaded ? state_.since : now;
  state_.since = since_;
  // A file that does not exist yet is written at the first save, so the start of the counting is kept.
  dirty_ = persisted() && !loaded;
  last_save_ = now;
  prune_locked(now);
  cap_deleted_locked();
}

void McpUsage::sync_live_keys(const std::vector<McpUsageKeyRef>& live, int64_t now) {
  std::lock_guard<std::mutex> lock(mu_);
  std::unordered_set<std::string> ids;
  for (const auto& key : live) {
    ids.insert(key.id);
    const auto it = state_.entries.find(key.id);
    if (it == state_.entries.end()) continue;
    Entry& entry = it->second;
    // A key of the configuration that is back (its id is its name) takes its entry again.
    if (entry.deleted_at != 0) entry.deleted_at = 0;
    entry.key = key;
    dirty_ = true;
  }
  for (auto& [id, entry] : state_.entries) {
    if (ids.count(id) || entry.deleted_at != 0) continue;
    entry.deleted_at = now;
    dirty_ = true;
  }
  cap_deleted_locked();
}

void McpUsage::record(const McpUsageEvent& event) {
  if (event.key_id.empty()) return;
  std::lock_guard<std::mutex> lock(mu_);
  Entry& entry = state_.entries[std::string(event.key_id)];
  if (entry.deleted_at == 0) {
    // The key as it is now (a key of the configuration can change its host from a start to the next). A call that ends
    // after the deletion of its key counts for the deleted key, as it was.
    if (entry.key.id != event.key_id) entry.key.id = std::string(event.key_id);
    if (entry.key.name != event.key_name) entry.key.name = std::string(event.key_name);
    if (entry.key.host != event.key_host) entry.key.host = std::string(event.key_host);
    if (entry.key.source != event.key_source) entry.key.source = std::string(event.key_source);
  }
  if (entry.first_used == 0 || event.at < entry.first_used) entry.first_used = event.at;
  entry.last_used = std::max(entry.last_used, event.at);

  // The client first: the cell is the one of its name.
  const Client client = note_client(entry, event, options_.max_clients);
  const uint64_t key = cell_key_of(state_.names, event, client_id_of(entry, state_.clients, client_name_of(client)));
  for (size_t tier = 0; tier < kMcpUsageTiers; ++tier) {
    if (!tier_kept(tier, options_.retention_days)) continue;
    std::vector<Bucket>& buckets = entry.tiers[tier];
    add_event(bucket_at(buckets, floor_to(event.at, kTierSpecs[tier].step)), event, key, &state_.cells, options_.max_cells);
    // The memory stays bounded between two saves.
    drop_before(buckets, tier_first(tier, buckets.back().start, options_.retention_days), &state_.cells);
  }
  dirty_ = true;
}

void McpUsage::mark_deleted(const McpUsageKeyRef& key, int64_t now) {
  std::lock_guard<std::mutex> lock(mu_);
  auto [it, created] = state_.entries.try_emplace(key.id);
  if (created) it->second.key = key;
  it->second.deleted_at = now;
  dirty_ = true;
  cap_deleted_locked();
}

void McpUsage::cap_deleted_locked() {
  size_t deleted = 0;
  for (const auto& item : state_.entries) {
    if (item.second.deleted_at != 0) ++deleted;
  }
  while (deleted > options_.max_deleted) {
    auto oldest = state_.entries.end();
    for (auto it = state_.entries.begin(); it != state_.entries.end(); ++it) {
      if (it->second.deleted_at == 0) continue;
      if (oldest == state_.entries.end() || it->second.deleted_at < oldest->second.deleted_at) oldest = it;
    }
    release_cells(oldest->second, &state_.cells);
    state_.entries.erase(oldest);
    --deleted;
    dirty_ = true;
  }
}

void McpUsage::prune_locked(int64_t now) {
  const int64_t first_day = floor_to(now, kDay) - (options_.retention_days - 1) * kDay;
  for (auto it = state_.entries.begin(); it != state_.entries.end();) {
    Entry& entry = it->second;
    bool day_gone = false;
    for (size_t tier = 0; tier < kMcpUsageTiers; ++tier) {
      std::vector<Bucket>& buckets = entry.tiers[tier];
      if (!tier_kept(tier, options_.retention_days)) {
        // Nothing is kept past the retention: a tier that it no longer reaches (it was lowered) is emptied.
        if (buckets.empty()) continue;
        for (const auto& bucket : buckets) take_cells(&state_.cells, cells_of(bucket));
        buckets.clear();
        dirty_ = true;
      } else if (drop_before(buckets, tier_first(tier, now, options_.retention_days), &state_.cells)) {
        dirty_ = true;
        day_gone = day_gone || tier == kTierD1;
      }
    }
    // A client name that no cell uses any more makes room for another one.
    if (day_gone) rebuild_client_ids(entry);
    const size_t clients = entry.clients.size();
    entry.clients.erase(std::remove_if(entry.clients.begin(), entry.clients.end(), [&](const Client& c) { return c.last_seen < first_day; }),
                        entry.clients.end());
    if (entry.clients.size() != clients) dirty_ = true;
    // A deleted key whose usage is older than the retention is gone; a deleted key that was never used, after 2 hours.
    const bool used = entry.last_used != 0;
    if (entry.deleted_at != 0 && entry.tiers[kTierD1].empty() && (used || now - entry.deleted_at >= kTombstoneSeconds)) {
      release_cells(entry, &state_.cells);
      it = state_.entries.erase(it);
      dirty_ = true;
      continue;
    }
    ++it;
  }
}

std::unordered_map<std::string, int64_t> McpUsage::last_used_all() const {
  std::lock_guard<std::mutex> lock(mu_);
  std::unordered_map<std::string, int64_t> out;
  for (const auto& [id, entry] : state_.entries) {
    if (entry.last_used > 0) out.emplace(id, entry.last_used);
  }
  return out;
}

std::optional<McpUsageKeyRef> McpUsage::entry_key(const std::string& id) const {
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = state_.entries.find(id);
  if (it == state_.entries.end()) return std::nullopt;
  return it->second.key;
}

void McpUsage::write_list(McpJsonWriter& w, const std::vector<McpUsageKeyRef>& live, const McpUsageWindow& window, int64_t now) const {
  w.StartObject();
  put_head(w, window, now, since_, persisted(), options_.retention_days);
  w.Key("keys");
  w.StartArray();
  // One entry at a time under the lock: the sum of a window walks the cells of an entry, and a call that is counted
  // meanwhile waits for one entry, never for all of them.
  std::unordered_set<std::string> listed_ids;
  for (const auto& key : live) {
    listed_ids.insert(key.id);
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = state_.entries.find(key.id);
    put_summary(w, key, it == state_.entries.end() ? nullptr : &it->second, 0, window);
  }
  std::vector<std::pair<int64_t, std::string>> deleted;  // when, which
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (const auto& [id, entry] : state_.entries) {
      if (entry.deleted_at != 0 && !entry.tiers[kTierD1].empty() && !listed_ids.count(id)) deleted.emplace_back(entry.deleted_at, id);
    }
  }
  std::sort(deleted.begin(), deleted.end(), [](const auto& a, const auto& b) { return a.first != b.first ? a.first > b.first : a.second < b.second; });
  for (const auto& item : deleted) {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = state_.entries.find(item.second);
    if (it != state_.entries.end() && it->second.deleted_at != 0) put_summary(w, it->second.key, &it->second, it->second.deleted_at, window);
  }
  w.EndArray();
  w.EndObject();
}

bool McpUsage::write_detail(McpJsonWriter& w, const std::string& id, const McpUsageKeyRef* live, const McpUsageWindow& window, int64_t now) const {
  std::lock_guard<std::mutex> lock(mu_);
  const auto it = state_.entries.find(id);
  const Entry* entry = it == state_.entries.end() ? nullptr : &it->second;
  if (!live && !entry) return false;
  const McpUsageKeyRef& key = live ? *live : entry->key;
  w.StartObject();
  put_key(w, key, live ? 0 : entry->deleted_at);
  put_head(w, window, now, since_, persisted(), options_.retention_days);
  put_time(w, "first_used_at", entry ? entry->first_used : 0);
  put_time(w, "last_used_at", entry ? entry->last_used : 0);

  w.Key("totals");
  w.StartObject();
  put_counters(w, window_total(entry, window));
  w.EndObject();

  // One point for each step of the window, from its start: a step without a bucket has no request.
  w.Key("series");
  w.StartObject();
  w.Key("step"); w.Int64(window.step);
  w.Key("points");
  w.StartArray();
  static const std::vector<Bucket> kNone;
  const std::vector<Bucket>& buckets = entry ? window_buckets(*entry, window) : kNone;
  size_t next = 0;
  for (size_t i = 0; i < window.points; ++i) {
    const int64_t t = window.from + static_cast<int64_t>(i) * window.step;
    while (next < buckets.size() && buckets[next].start < t) ++next;
    const Counters point = next < buckets.size() && buckets[next].start == t ? totals_of(buckets[next]) : Counters{};
    w.StartObject();
    w.Key("t"); put(w, mcp_iso_utc(t));
    w.Key("requests"); w.Uint64(point.requests);
    w.Key("calls"); w.Uint64(point.calls);
    w.Key("errors"); w.Uint64(point.errors);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  // The tools (the tool calls, by tool) and the results (every cell but the successful protocol requests) of the window,
  // the most frequent first.
  std::unordered_map<uint16_t, Figures> tools;
  std::unordered_map<uint16_t, uint64_t> results;
  for (const auto& bucket : buckets) {
    if (!in_window(bucket, window)) continue;
    for (const auto& cell : bucket.cells) {
      const McpUsageKind kind = kind_of(cell.key);
      if (kind == McpUsageKind::ToolCall) add_figures(tools[method_of(cell.key)], cell, 0);
      if (kind != McpUsageKind::Request || result_of(cell.key) != kNameOk) results[result_of(cell.key)] += cell.count;
    }
  }
  std::vector<std::pair<std::string, Figures>> tool_rows;
  for (const auto& [name, figures] : tools) tool_rows.emplace_back(state_.names.by_id[name], figures);
  std::sort(tool_rows.begin(), tool_rows.end(), [](const auto& a, const auto& b) {
    return a.second.requests != b.second.requests ? a.second.requests > b.second.requests : a.first < b.first;
  });
  w.Key("tools");
  w.StartArray();
  for (const auto& [name, figures] : tool_rows) {
    w.StartObject();
    w.Key("tool"); put(w, name);
    w.Key("calls"); w.Uint64(figures.requests);
    w.Key("errors"); w.Uint64(figures.errors);
    put_average(w, "duration_ms_avg", figures.duration_ms_sum, figures.requests);
    w.Key("duration_ms_max"); w.Uint64(figures.duration_ms_max);
    w.Key("rows"); w.Uint64(figures.rows);
    w.Key("bytes"); w.Uint64(figures.bytes);
    w.EndObject();
  }
  w.EndArray();
  std::vector<std::pair<std::string, uint64_t>> result_rows;
  for (const auto& [name, count] : results) result_rows.emplace_back(state_.names.by_id[name], count);
  std::sort(result_rows.begin(), result_rows.end(), [](const auto& a, const auto& b) { return a.second != b.second ? a.second > b.second : a.first < b.first; });
  w.Key("statuses");
  w.StartArray();
  for (const auto& [name, count] : result_rows) {
    w.StartObject();
    w.Key("status"); put(w, name);
    w.Key("count"); w.Uint64(count);
    w.EndObject();
  }
  w.EndArray();

  std::vector<const Client*> clients;
  if (entry) {
    for (const auto& client : entry->clients) clients.push_back(&client);
  }
  std::sort(clients.begin(), clients.end(), [](const Client* a, const Client* b) { return a->last_seen > b->last_seen; });
  w.Key("clients");
  w.StartArray();
  for (const Client* client : clients) {
    w.StartObject();
    w.Key("name"); put(w, client->name);
    w.Key("version"); put(w, client->version);
    w.Key("user_agent"); put(w, client->user_agent);
    put_time(w, "first_seen_at", client->first_seen);
    put_time(w, "last_seen_at", client->last_seen);
    w.Key("requests"); w.Uint64(client->requests);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  return true;
}

void McpUsage::write_overview(McpJsonWriter& w, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                              const McpUsageWindow& window, int64_t now) const {
  // 1. Under the lock: the filters as ids (a name that was never counted is in no set: it keeps nothing), and the entries.
  Filter filter;
  filter.keys_on = !query.keys.empty();
  filter.keys.insert(query.keys.begin(), query.keys.end());
  filter.methods_on = !query.methods.empty();
  filter.clients_on = !query.clients.empty();
  filter.results_on = !query.results.empty();
  filter.types_on = !query.types.empty();
  for (const auto& type : query.types) {
    if (const int kind = kind_index(type); kind >= 0) filter.types[static_cast<size_t>(kind)] = true;
  }
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (const auto& method : query.methods) {
      if (const auto it = state_.names.ids.find(method); it != state_.names.ids.end()) filter.methods.set(it->second);
    }
    for (const auto& client : query.clients) {
      if (const auto it = state_.clients.ids.find(client); it != state_.clients.ids.end()) filter.clients.set(it->second);
    }
    for (const auto& result : query.results) {
      if (const auto it = state_.names.ids.find(result); it != state_.names.ids.end()) filter.results.set(it->second);
    }
    ids.reserve(state_.entries.size());
    for (const auto& item : state_.entries) ids.push_back(item.first);
  }
  std::sort(ids.begin(), ids.end());

  // 2. One entry at a time under the lock again, found again by its id (it may be gone): a call that is counted meanwhile waits
  // for one entry, never for all of them. Nothing that points into an entry or into the names outlives its lock.
  Tally tally(filter, window, group_of(query.group), ids.size());
  std::unordered_map<std::string, const McpUsageKeyRef*> live_by_id;
  for (const auto& key : live) live_by_id.emplace(key.id, &key);
  for (size_t i = 0; i < ids.size(); ++i) {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = state_.entries.find(ids[i]);
    if (it == state_.entries.end()) continue;
    const auto named = live_by_id.find(ids[i]);
    tally_entry(tally, i, ids[i], it->second, named == live_by_id.end() ? nullptr : named->second);
  }

  // 3. Under a last lock: the names of the methods, the results and the clients, which grow (and move) while calls are counted.
  std::vector<std::string> names;
  std::vector<std::string> client_names;
  {
    std::lock_guard<std::mutex> lock(mu_);
    names = state_.names.by_id;
    client_names = state_.clients.by_id;
  }

  std::unordered_map<std::string, std::string> key_names;
  for (const auto& key : live) key_names.emplace(key.id, key.name);
  for (const auto& item : tally.keys) key_names[item.first] = item.second.name;

  w.StartObject();
  put_head(w, window, now, since_, persisted(), options_.retention_days);
  w.Key("group"); put(w, query.group);
  w.Key("filters");
  w.StartObject();
  w.Key("key"); put_strings(w, query.keys);
  w.Key("method"); put_strings(w, query.methods);
  w.Key("client"); put_strings(w, query.clients);
  w.Key("result"); put_strings(w, query.results);
  w.Key("type"); put_strings(w, query.types);
  w.EndObject();
  w.Key("totals");
  w.StartObject();
  put_counters(w, tally.totals);
  w.Key("active_keys"); w.Uint64(tally.active_keys);
  w.Key("keys"); w.Uint64(live.size());
  w.EndObject();
  put_series(w, tally, query, names, client_names, ids, key_names);
  put_facets(w, tally, query, names, client_names, live);
  w.EndObject();
}

void McpUsage::write_entry_locked(McpJsonWriter& w, const Entry& entry) const {
  w.StartObject();
  w.Key("id"); put(w, entry.key.id);
  w.Key("name"); put(w, entry.key.name);
  w.Key("source"); put(w, entry.key.source);
  w.Key("host"); put(w, entry.key.host);
  put_time(w, "first_used_at", entry.first_used);
  put_time(w, "last_used_at", entry.last_used);
  put_time(w, "deleted_at", entry.deleted_at);
  w.Key("clients");
  w.StartArray();
  for (const auto& client : entry.clients) {
    w.StartObject();
    w.Key("name"); put(w, client.name);
    w.Key("version"); put(w, client.version);
    w.Key("user_agent"); put(w, client.user_agent);
    put_time(w, "first_seen_at", client.first_seen);
    put_time(w, "last_seen_at", client.last_seen);
    w.Key("requests"); w.Uint64(client.requests);
    w.EndObject();
  }
  w.EndArray();
  for (size_t tier = 0; tier < kMcpUsageTiers; ++tier) {
    w.Key(kTierSpecs[tier].member);
    w.StartArray();
    for (const auto& bucket : entry.tiers[tier]) put_bucket(w, bucket, state_.names, state_.clients);
    w.EndArray();
  }
  w.EndObject();
}

bool McpUsage::save(int64_t now) {
  std::lock_guard<std::mutex> writing(write_mu_);
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(mu_);
    last_save_ = now;
    prune_locked(now);
    if (!persisted() || !dirty_) return true;
    dirty_ = false;
    ids.reserve(state_.entries.size());
    for (const auto& item : state_.entries) ids.push_back(item.first);
  }
  std::sort(ids.begin(), ids.end());
  // One entry at a time under the lock: a call that counts meanwhile waits for one entry, never for the whole file.
  rapidjson::StringBuffer sb;
  McpJsonWriter w(sb);
  w.StartObject();
  w.Key("version"); w.Int(kMcpUsageFileVersion);
  w.Key("since"); put(w, mcp_iso_utc(since_));
  w.Key("saved_at"); put(w, mcp_iso_utc(now));
  w.Key("keys");
  w.StartArray();
  for (const auto& id : ids) {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = state_.entries.find(id);
    if (it != state_.entries.end()) write_entry_locked(w, it->second);
  }
  w.EndArray();
  w.EndObject();
  std::string text(sb.GetString(), sb.GetSize());
  text.push_back('\n');
  std::string error;
  // The file is never larger than a start reads.
  bool ok = text.size() <= kMaxFileBytes;
  if (!ok) error = "the usage is larger than 128 MiB";
  else ok = atomic_write_file(options_.file, text, &error);
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (ok) last_size_ = text.size();
    else dirty_ = true;
  }
  if (!ok) log_event(LogLevel::Error, "mcp.usage_save_failed", {{"file", options_.file}, {"error", error}});
  return ok;
}

bool McpUsage::save_if_due(int64_t now) {
  {
    std::lock_guard<std::mutex> lock(mu_);
    const int64_t every = last_size_ > kLargeFile ? kSaveEveryLarge : kSaveEvery;
    if (now >= last_save_ && now - last_save_ < every) return true;
  }
  return save(now);
}

} // namespace chdash
