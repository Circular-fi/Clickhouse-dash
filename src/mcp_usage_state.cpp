#include "mcp_usage_state.hpp"

#include <algorithm>
#include <stdexcept>

namespace chdash {

McpUsage::Names::Names() {
  const auto add = [this](const char* name) {
    ids.emplace(name, static_cast<uint16_t>(by_id.size()));
    by_id.emplace_back(name);
  };
  add("other");
  add("ok");
  for (const char* method : mcp_usage::kProtocolMethods) add(method);
  add("invalid");
  add("unread");
}

uint16_t McpUsage::Names::intern(std::string_view name) {
  const std::string text(name);
  if (const auto it = ids.find(text); it != ids.end()) return it->second;
  if (by_id.size() >= mcp_usage::kMaxNames) return 0;
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
  if (by_id.size() >= mcp_usage::kMaxNames) return mcp_usage::kClientOther;
  const auto id = static_cast<uint16_t>(by_id.size());
  by_id.push_back(text);
  ids.emplace(text, id);
  return id;
}

namespace mcp_usage {

int64_t floor_to(int64_t t, int64_t step) {
  const int64_t r = t % step;
  return t - (r < 0 ? r + step : r);
}

bool tier_kept(size_t tier, int64_t retention_days) { return retention_days >= kTierSpecs[tier].min_days; }

int64_t tier_first(size_t tier, int64_t at, int64_t retention_days) {
  const TierSpec& spec = kTierSpecs[tier];
  const int64_t points = tier == kTierD1 ? retention_days : static_cast<int64_t>(spec.points);
  return floor_to(at, spec.step) - (points - 1) * spec.step;
}

int tier_index(std::string_view name) {
  for (size_t i = 0; i < kMcpUsageTiers; ++i) {
    if (name == kTierSpecs[i].member) return static_cast<int>(i);
  }
  return -1;
}

namespace {
bool name_char(char c) { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'; }
} // namespace

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

bool valid_method(std::string_view name) {
  return !name.empty() && name.size() <= kNameBytes &&
         std::all_of(name.begin(), name.end(), [](char c) { return name_char(c) || (c >= 'A' && c <= 'Z') || c == '/'; });
}

bool valid_client(std::string_view name) {
  return !name.empty() && name.size() <= kCellClientBytes && name.front() != ' ' && name.back() != ' ' &&
         std::all_of(name.begin(), name.end(), [](char c) { return c >= 0x20 && c <= 0x7e; });
}

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

uint64_t cell_key_of(Usage::Names& names, const McpUsageEvent& event, uint16_t client) {
  uint16_t method = kNameUnread;
  if (event.kind == McpUsageKind::ToolCall) method = names.intern(clean_name(event.tool));
  else if (event.kind == McpUsageKind::Request) method = event.method.empty() ? kNameInvalid : protocol_method(event.method);
  const uint16_t result = event.status == "ok" ? kNameOk : names.intern(clean_name(event.status));
  return cell_key(event.kind, client, method, result);
}

uint64_t overflow_key(uint64_t key) {
  return cell_key(kind_of(key), kClientOther, kNameOther, result_of(key) == kNameOk ? kNameOk : kNameOther);
}

bool is_error(uint64_t key) {
  const McpUsageKind kind = kind_of(key);
  return (kind == McpUsageKind::ToolCall || kind == McpUsageKind::Request) && result_of(key) != kNameOk;
}

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

size_t cells_of(const Usage::Bucket& bucket) { return bucket.cells.size(); }

void take_cells(size_t* cells, size_t count) { *cells -= std::min(*cells, count); }

Usage::Bucket& bucket_at(std::vector<Usage::Bucket>& buckets, int64_t start) {
  if (buckets.empty() || buckets.back().start < start) {
    buckets.emplace_back();
    buckets.back().start = start;
  }
  return buckets.back();
}

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

namespace {

// Whether a bucket has its 512 cells. The overflow cells (at most 6) are not among them.
// So, a bucket that is written and then read again keeps the same cells.
bool bucket_full(const Usage::Bucket& bucket) {
  if (bucket.cells.size() < kCellsPerBucket) return false;
  const auto overflow = std::count_if(bucket.cells.begin(), bucket.cells.end(), [](const Usage::Cell& cell) { return cell.key == overflow_key(cell.key); });
  return bucket.cells.size() - static_cast<size_t>(overflow) >= kCellsPerBucket;
}

} // namespace

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

std::string client_name_of(const Usage::Client& client) {
  std::string name = mcp_usage_clean(client.name, kCellClientBytes);
  if (!name.empty()) return name;
  name = mcp_usage_clean(client.user_agent.substr(0, client.user_agent.find_first_of("/ ")), kCellClientBytes);
  return name.empty() ? std::string("unknown") : name;
}

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

void release_cells(const Usage::Entry& entry, size_t* cells) {
  for (const auto& tier : entry.tiers) {
    for (const auto& bucket : tier) take_cells(cells, cells_of(bucket));
  }
}

// ---- the rows -----------------------------------------------------------------------------------------

namespace {

[[noreturn]] void bad(const std::string& what) { throw std::runtime_error(what); }

// A text is valid when it is printable ASCII, as the usage keeps it. The usage never writes another byte.
// A file with another byte was not written by the usage.
bool is_clean(std::string_view text, size_t max_bytes) { return text == mcp_usage_clean(text, max_bytes); }

Usage::Entry& entry_of(Usage::State& state, std::string_view key, const char* row) {
  const auto it = state.entries.find(std::string(key));
  if (it == state.entries.end()) bad(std::string("a ") + row + " row names a key that has no key row before it");
  return it->second;
}

} // namespace

void apply_key(Usage::State& state, const McpUsageKeyRow& row, size_t max_keys) {
  if (!mcp_valid_key_id(row.key)) bad("a key row has an id that is not the id of a key");
  if (!mcp_valid_key_name(row.name)) bad("a key row has a name that is not the name of a key");
  if (row.source != "config" && row.source != "ui") bad("a key row has a source that is not config or ui");
  if (row.host.size() > kHostBytes) bad("a key row has a host that is too long");
  if (row.first_used < 0 || row.last_used < 0 || row.deleted_at < 0) bad("a key row has a time that is negative");
  if (state.entries.size() >= max_keys) bad("more than " + std::to_string(max_keys) + " keys");
  Usage::Entry entry;
  entry.key.id = std::string(row.key);
  entry.key.name = std::string(row.name);
  entry.key.host = std::string(row.host);
  entry.key.source = std::string(row.source);
  entry.first_used = row.first_used;
  entry.last_used = row.last_used;
  entry.deleted_at = row.deleted_at;
  if (!state.entries.emplace(entry.key.id, std::move(entry)).second) bad("two key rows have the id " + std::string(row.key));
}

void apply_client(Usage::State& state, const McpUsageClientRow& row, size_t max_clients) {
  Usage::Entry& entry = entry_of(state, row.key, "client");
  Usage::Client client;
  client.name = std::string(row.name);
  client.version = std::string(row.version);
  client.user_agent = std::string(row.user_agent);
  if (client.name.size() > kClientNameBytes || client.version.size() > kClientVersionBytes || client.user_agent.size() > kUserAgentBytes) {
    bad("a client row has a text that is too long");
  }
  if (!is_clean(client.name, kClientNameBytes) || !is_clean(client.version, kClientVersionBytes) || !is_clean(client.user_agent, kUserAgentBytes)) {
    bad("a client row has a text that is not printable ASCII");
  }
  if (row.first_seen < 0 || row.last_seen < 0) bad("a client row has a time that is negative");
  client.first_seen = row.first_seen;
  client.last_seen = row.last_seen;
  client.requests = row.requests;
  entry.clients.push_back(std::move(client));
  // There are more clients than the cap. This happens when the cap was lowered, or when a file holds more clients. The clients seen last stay.
  if (entry.clients.size() > max_clients) {
    const auto oldest = std::min_element(entry.clients.begin(), entry.clients.end(),
                                         [](const Usage::Client& a, const Usage::Client& b) { return a.last_seen < b.last_seen; });
    entry.clients.erase(oldest);
  }
}

void apply_cell(Usage::State& state, const McpUsageCellRow& row) {
  Usage::Entry& entry = entry_of(state, row.key, "cell");
  const int tier = tier_index(row.tier);
  if (tier < 0) bad("a cell row has a tier that is not known");
  const TierSpec& spec = kTierSpecs[tier];
  if (row.start <= 0 || row.start % spec.step != 0) {
    bad(std::string("a cell row must start at a multiple of ") + std::to_string(spec.step) + " seconds, the step of the tier " + spec.member);
  }
  const int kind = kind_index(row.kind);
  if (kind < 0) bad("a cell row has a type that is not known");
  if (!valid_client(row.client)) bad("a cell row has a client that is not valid");
  if (!valid_method(row.method)) bad("a cell row has a method that is not valid");
  if (!valid_name(row.result)) bad("a cell row has a result that is not valid");
  if (row.count == 0) return;
  std::vector<Usage::Bucket>& buckets = entry.tiers[static_cast<size_t>(tier)];
  if (!buckets.empty() && buckets.back().start > row.start) bad(std::string("a cell row of the tier ") + spec.member + " is not after the bucket before it");
  Usage::Bucket& bucket = bucket_at(buckets, row.start);
  const uint16_t client = client_id_of(entry, state.clients, std::string(row.client));
  const uint64_t key = cell_key(static_cast<McpUsageKind>(kind), client, state.names.intern(row.method), state.names.intern(row.result));
  Usage::Cell& cell = cell_of(bucket, key, &state.cells, SIZE_MAX);
  cell.count += row.count;
  cell.duration_ms_sum += row.duration_ms_sum;
  cell.duration_ms_max = std::max(cell.duration_ms_max, row.duration_ms_max);
  cell.rows += row.rows;
  cell.bytes += row.bytes;
}

void finish_state(Usage::State& state) {
  for (auto& item : state.entries) rebuild_client_ids(item.second);
}

} // namespace mcp_usage
} // namespace chdash
