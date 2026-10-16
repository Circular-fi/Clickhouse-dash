#include "mcp_usage.hpp"

#include "json_text.hpp"
#include "log.hpp"
#include "mcp_usage_state.hpp"
#include "mcp_usage_store.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <array>
#include <functional>
#include <map>
#include <stdexcept>
#include <tuple>
#include <unordered_set>

namespace chdash {
namespace {

using namespace mcp_usage;

constexpr int64_t kSaveEvery = 60;
constexpr int64_t kSaveEveryLarge = 300;
constexpr int64_t kRefreshEvery = 60;
constexpr size_t kLargeFile = 8u * 1024 * 1024;

// The windows of the answers: the tier that each one reads, its points, and the retention that offers it.
struct WindowSpec {
  const char* name;
  size_t tier;
  size_t points;
  int64_t min_days;
};
constexpr WindowSpec kWindowSpecs[] = {{"1h", kTierM1, 60, 0},   {"6h", kTierM5, 72, 0},   {"24h", kTierM15, 96, 0}, {"7d", kTierH3, 56, 7},
                                       {"30d", kTierH12, 60, 30}, {"90d", kTierD1, 90, 90}, {"365d", kTierD1, 365, 365}};

bool listed(const std::vector<std::string>& values, const std::string& value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

// ---- the JSON of the answers and of the state --------------------------------------------------------

void put(McpJsonWriter& w, std::string_view text) { write_json_text(w, text); }

void put_time(McpJsonWriter& w, const char* name, int64_t seconds) {
  w.Key(name);
  if (seconds > 0) put(w, mcp_iso_utc(seconds));
  else w.Null();
}

const std::vector<Usage::Bucket>& window_buckets(const Usage::Entry& entry, const McpUsageWindow& window) { return entry.tiers[window.tier]; }

bool in_window(const Usage::Bucket& bucket, const McpUsageWindow& window) {
  return bucket.start >= window.from && bucket.start < window.from + static_cast<int64_t>(window.points) * window.step;
}

void put_head(McpJsonWriter& w, const McpUsageWindow& window, int64_t now, int64_t since, int64_t retention_days) {
  w.Key("window"); put(w, window.name);
  w.Key("from"); put(w, mcp_iso_utc(window.from));
  w.Key("to"); put(w, mcp_iso_utc(now));
  w.Key("since"); put(w, mcp_iso_utc(since));
  w.Key("retention_days"); w.Int64(retention_days);
}

// The instances that an answer reads, with how each one went.
void put_instances(McpJsonWriter& w, const std::vector<McpUsageInstance>& instances) {
  w.Key("instances");
  w.StartArray();
  for (const auto& item : instances) {
    w.StartObject();
    w.Key("instance"); put(w, item.instance);
    put_time(w, "written_at", item.written_at);
    w.Key("status"); put(w, item.status);
    w.Key("reason"); put(w, item.reason);
    w.EndObject();
  }
  w.EndArray();
}

void put_key(McpJsonWriter& w, const McpUsageKeyRef& key, int64_t deleted_at, bool elsewhere) {
  w.Key("id"); put(w, key.id);
  w.Key("name"); put(w, key.name);
  w.Key("host"); put(w, key.host);
  w.Key("source"); put(w, key.source);
  put_time(w, "deleted_at", deleted_at);
  w.Key("elsewhere"); w.Bool(elsewhere);
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

void put_strings(McpJsonWriter& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) put(w, value);
  w.EndArray();
}

// The rows of an entry, as a file or a table holds them.
// The row has the key, its clients, and then its cells by tier and by start. These are the names of the ids.
void write_rows(McpUsageWriter& writer, const Usage::State& state, const Usage::Entry& entry) {
  McpUsageKeyRow key;
  key.key = entry.key.id;
  key.name = entry.key.name;
  key.host = entry.key.host;
  key.source = entry.key.source;
  key.first_used = entry.first_used;
  key.last_used = entry.last_used;
  key.deleted_at = entry.deleted_at;
  writer.key(key);
  for (const auto& client : entry.clients) {
    McpUsageClientRow row;
    row.key = entry.key.id;
    row.name = client.name;
    row.version = client.version;
    row.user_agent = client.user_agent;
    row.first_seen = client.first_seen;
    row.last_seen = client.last_seen;
    row.requests = client.requests;
    writer.client(row);
  }
  for (size_t tier = 0; tier < kMcpUsageTiers; ++tier) {
    for (const auto& bucket : entry.tiers[tier]) {
      for (const auto& cell : bucket.cells) {
        McpUsageCellRow row;
        row.key = entry.key.id;
        row.tier = kTierSpecs[tier].member;
        row.start = bucket.start;
        row.kind = kKindNames[static_cast<size_t>(kind_of(cell.key))];
        row.client = state.clients.by_id[client_of(cell.key)];
        row.method = state.names.by_id[method_of(cell.key)];
        row.result = state.names.by_id[result_of(cell.key)];
        row.count = cell.count;
        row.duration_ms_sum = cell.duration_ms_sum;
        row.duration_ms_max = cell.duration_ms_max;
        row.rows = cell.rows;
        row.bytes = cell.bytes;
        writer.cell(row);
      }
    }
  }
}

// ---- what an answer reads -------------------------------------------------------------------------------

constexpr uint32_t kNone = UINT32_MAX;

// The names of the methods and the results (or of the clients) that an answer sees.
// The answer reads them from all the instances, by their text.
// The id of a name is made for the answer. The names of all the instances are as many as they are.
// An instance has at most 4096 names of its own.
//
// A name has its flags. They show whether the first filter of its dimension (the methods, the clients) chose it.
// They also show whether the second filter (the results) chose it.
class Table {
public:
  explicit Table(const std::vector<std::string>& first = {}, const std::vector<std::string>& second = {})
      : first_(first.begin(), first.end()), second_(second.begin(), second.end()) {}

  uint32_t intern(const std::string& text) {
    const auto it = ids_.find(text);
    if (it != ids_.end()) return it->second;
    const auto id = static_cast<uint32_t>(by_id_.size());
    by_id_.push_back(text);
    ids_.emplace(text, id);
    chosen_.push_back(static_cast<uint8_t>((first_.count(text) != 0 ? 1 : 0) | (second_.count(text) != 0 ? 2 : 0)));
    return id;
  }
  bool first(uint32_t id) const { return (chosen_[id] & 1) != 0; }
  bool second(uint32_t id) const { return (chosen_[id] & 2) != 0; }
  const std::string& name(size_t id) const { return by_id_[id]; }
  size_t size() const { return by_id_.size(); }

private:
  std::unordered_set<std::string> first_;
  std::unordered_set<std::string> second_;
  std::vector<std::string> by_id_;
  std::unordered_map<std::string, uint32_t> ids_;
  std::vector<uint8_t> chosen_;
};

// One instance that an answer reads. The translation of the ids of its names and its clients goes into the ids of the answer.
// The translation is made as the cells come. An id that no cell uses is never checked.
struct Source {
  std::string instance;
  bool selected = true;                 // the filter of the instances keeps it
  const Usage::State* state = nullptr;  // null: the live state of this instance, which is locked while it is read
  std::vector<uint32_t> name_to;
  std::vector<uint32_t> client_to;

  uint32_t name(const Usage::State& st, Table& table, uint16_t id) {
    if (id >= name_to.size()) name_to.resize(static_cast<size_t>(id) + 1, kNone);
    if (name_to[id] == kNone) name_to[id] = table.intern(st.names.by_id[id]);
    return name_to[id];
  }
  uint32_t client(const Usage::State& st, Table& table, uint16_t id) {
    if (id >= client_to.size()) client_to.resize(static_cast<size_t>(id) + 1, kNone);
    if (client_to[id] == kNone) client_to[id] = table.intern(st.clients.by_id[id]);
    return client_to[id];
  }
};

// The instances that an answer reads. This instance comes first.
// Its state is live. The code takes one entry at a time under its lock.
// So a call that is counted meanwhile waits for one entry, never for all of them.
//
// The other instances follow. They were read before, and they are immutable, so they need no lock.
// An entry is found again by its id each time it is read. The entry may be gone.
class View {
public:
  View(std::mutex* mutex, const Usage::State* own, const std::string& instance, std::shared_ptr<const std::vector<Usage::Other>> others,
       const std::vector<std::string>& filter)
      : mutex_(mutex), own_(own), others_(std::move(others)) {
    const auto chosen = [&](const std::string& name) { return filter.empty() || listed(filter, name); };
    Source here;
    here.instance = instance;
    here.selected = chosen(instance);
    sources.push_back(std::move(here));
    for (const auto& other : *others_) {
      if (other.status != "ok" || !other.state) continue;
      Source source;
      source.instance = other.instance;
      source.selected = chosen(other.instance);
      source.state = other.state.get();
      sources.push_back(std::move(source));
    }
  }

  std::vector<Source> sources;

  size_t size() const { return sources.size(); }

  // f(state, entry or null, source) for the entry of `id` in the source: the live state is locked for the call.
  template <typename F>
  void with_entry(size_t index, const std::string& id, F&& f) {
    Source& source = sources[index];
    if (source.state) {
      const auto it = source.state->entries.find(id);
      f(*source.state, it == source.state->entries.end() ? nullptr : &it->second, source);
      return;
    }
    std::lock_guard<std::mutex> lock(*mutex_);
    const auto it = own_->entries.find(id);
    f(*own_, it == own_->entries.end() ? nullptr : &it->second, source);
  }

  // The ids of the keys that any instance has an entry for, sorted.
  std::vector<std::string> key_ids() const {
    std::vector<std::string> ids;
    {
      std::lock_guard<std::mutex> lock(*mutex_);
      ids.reserve(own_->entries.size());
      for (const auto& item : own_->entries) ids.push_back(item.first);
    }
    for (size_t i = 1; i < sources.size(); ++i) {
      for (const auto& item : sources[i].state->entries) ids.push_back(item.first);
    }
    std::sort(ids.begin(), ids.end());
    ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
    return ids;
  }

private:
  std::mutex* mutex_;
  const Usage::State* own_;
  std::shared_ptr<const std::vector<Usage::Other>> others_;
};

// What the instances know of a key, put together.
// This is the name that the newest use recorded, the first and the last use, and the last deletion that an instance recorded.
// It also holds the usage of a window.
struct KeyFacts {
  McpUsageKeyRef ref;
  int64_t first_used = 0;
  int64_t last_used = 0;
  int64_t deleted_at = 0;
  bool found = false;      // an instance has an entry
  bool here = false;       // this instance has one
  bool has_usage = false;  // an instance still keeps a day of it
  bool named = false;
  int64_t named_use = 0;
  Usage::Counters total;   // the window, with every instance summed

  void add(const Usage::Entry& entry, bool is_here, const McpUsageWindow* window) {
    found = true;
    here = here || is_here;
    if (entry.first_used != 0 && (first_used == 0 || entry.first_used < first_used)) first_used = entry.first_used;
    last_used = std::max(last_used, entry.last_used);
    if (!named || entry.last_used > named_use) {
      ref = entry.key;
      named = true;
      named_use = entry.last_used;
    }
    if (entry.deleted_at != 0) deleted_at = std::max(deleted_at, entry.deleted_at);
    if (!entry.tiers[kTierD1].empty()) has_usage = true;
    if (!window) return;
    for (const auto& bucket : window_buckets(entry, *window)) {
      if (!in_window(bucket, *window)) continue;
      for (const auto& cell : bucket.cells) add_to_counters(total, cell);
    }
  }
};

// The facts of a key in the instances that the answer sums (all of them, or the ones that the filter of the instances chose).
KeyFacts facts_of(View& view, const std::string& id, const McpUsageWindow* window, bool selected_only) {
  KeyFacts facts;
  for (size_t s = 0; s < view.size(); ++s) {
    if (selected_only && !view.sources[s].selected) continue;
    view.with_entry(s, id, [&](const Usage::State&, const Usage::Entry* entry, Source&) {
      if (entry) facts.add(*entry, s == 0, window);
    });
  }
  return facts;
}

void put_summary(McpJsonWriter& w, const McpUsageKeyRef& key, const KeyFacts& facts, int64_t deleted_at, bool elsewhere) {
  w.StartObject();
  put_key(w, key, deleted_at, elsewhere);
  w.Key("requests"); w.Uint64(facts.total.requests);
  w.Key("calls"); w.Uint64(facts.total.calls);
  w.Key("errors"); w.Uint64(facts.total.errors);
  w.Key("rate_limited"); w.Uint64(facts.total.rate_limited);
  w.Key("rejected"); w.Uint64(facts.total.rejected);
  put_time(w, "first_used_at", facts.first_used);
  put_time(w, "last_used_at", facts.last_used);
  w.EndObject();
}

// ---- the overview ----------------------------------------------------------------------------------

constexpr size_t kSeriesGroups = 8;
constexpr size_t kClientVersions = 5;

// What the series is grouped by.
enum class Group { Key, Method, Client, Result, Type, Instance };

Group group_of(const std::string& name) {
  if (name == "key") return Group::Key;
  if (name == "client") return Group::Client;
  if (name == "result") return Group::Result;
  if (name == "type") return Group::Type;
  if (name == "instance") return Group::Instance;
  return Group::Method;
}

// The metrics of a point of the series, in the order of their members.
// The members are the requests, the errors, the calls, the time of the calls, the bytes and the refusals.
// The refusals are the 429 and what was refused before it was read.
// add_to_counters says what each one counts.
constexpr const char* kSeriesMetrics[] = {"requests", "errors", "calls", "duration_ms_sum", "bytes", "refused"};
constexpr size_t kMetrics = sizeof(kSeriesMetrics) / sizeof(kSeriesMetrics[0]);

// The metrics that can rank the groups of the series (the parameter `order`). The time of the calls is a sum that the calls average.
// So it is not one of them.
constexpr const char* kSeriesOrders[] = {"requests", "errors", "refused", "calls", "bytes"};
constexpr size_t kOrders = sizeof(kSeriesOrders) / sizeof(kSeriesOrders[0]);

bool valid_order(const std::string& order) {
  for (const char* name : kSeriesOrders) {
    if (order == name) return true;
  }
  return false;
}

// The metric of the series that an order ranks by. For a name that is not an order, the metric is the requests. The check refuses such a name before.
size_t order_metric(const std::string& order) {
  if (!valid_order(order)) return 0;
  for (size_t metric = 0; metric < kMetrics; ++metric) {
    if (order == kSeriesMetrics[metric]) return metric;
  }
  return 0;
}

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

// The figures of the cells of a row (a tool, a method, a result): the time is the one of every request of the row.
struct Figures {
  uint64_t requests = 0;
  uint64_t errors = 0;
  uint64_t duration_ms_sum = 0;
  uint64_t duration_ms_max = 0;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  uint64_t keys = 0;             // the keys that have a request in the row
  size_t last_entry = SIZE_MAX;  // the key that was counted last: the keys are walked one after the other
};

void add_figures(Figures& into, const Usage::Cell& cell, size_t key) {
  into.requests += cell.count;
  if (is_error(cell.key)) into.errors += cell.count;
  into.duration_ms_sum += cell.duration_ms_sum;
  into.duration_ms_max = std::max(into.duration_ms_max, cell.duration_ms_max);
  into.rows += cell.rows;
  into.bytes += cell.bytes;
  if (into.last_entry != key) {
    ++into.keys;
    into.last_entry = key;
  }
}

// The value at `index` of a vector that grows as the names of the answer do.
template <typename T>
T& at_grow(std::vector<T>& values, size_t index) {
  if (index >= values.size()) values.resize(index + 1);
  return values[index];
}

// What the filters keep, in the terms of the cells. A value that no cell has is chosen by no name of the tables.
// Examples are a key that is not there, or a name that was never counted. The filter then keeps nothing.
// The filter of the instances is in the sources.
struct Filter {
  bool keys_on = false;
  std::unordered_set<std::string> keys;
  bool methods_on = false;
  bool clients_on = false;
  bool results_on = false;
  bool types_on = false;
  std::array<bool, kKinds> types{};

  bool key(const std::string& id) const { return !keys_on || keys.count(id) != 0; }
  bool method(const Table& names, uint32_t id) const { return !methods_on || names.first(id); }
  bool client(const Table& clients, uint32_t id) const { return !clients_on || clients.first(id); }
  bool result(const Table& names, uint32_t id) const { return !results_on || names.second(id); }
  bool type(McpUsageKind kind) const { return !types_on || types[static_cast<size_t>(kind)]; }
};

struct KeyRow {
  std::string id;
  std::string name;
  std::string host;
  std::string source;
  int64_t deleted_at = 0;
  bool elsewhere = false;
  int64_t last_used = 0;
  Usage::Counters counters;
  bool selected = false;
};

// The cells of one client in the facet of the clients. They hold the totals of a key.
// They also hold the keys that have a request of the client.
struct ClientFigures {
  Usage::Counters counters;
  uint64_t keys = 0;
  size_t last_entry = SIZE_MAX;  // the key that was counted last: the keys are walked one after the other
};

void add_client_figures(ClientFigures& into, const Usage::Cell& cell, size_t key) {
  add_to_counters(into.counters, cell);
  if (into.last_entry != key) {
    ++into.keys;
    into.last_entry = key;
  }
}

// The cells of one instance in the facet of the instances: the totals, and the keys that have a request in the instance.
struct InstanceFigures {
  Usage::Counters counters;
  uint64_t keys = 0;
  size_t last_entry = SIZE_MAX;
};

// The records of the clients of the keys that the filter keeps tell two things about a client name.
// These things are when the name was last seen, and its versions.
struct ClientSeen {
  int64_t last_seen = 0;
  std::vector<std::pair<int64_t, std::string>> versions;  // when a record was last seen, and its version
};

// Everything that the entries add to an answer. A key is walked once, in all the instances.
// The totals and the series use all the filters. Each facet uses all the filters but its own.
//
// The records of the clients use the filter of the keys. The rows are indexed by the ids of the answer, which grow with the names.
// A cell costs a few additions, whatever the number of rows.
struct Tally {
  Tally(const Filter& f, const McpUsageWindow& w, Group g, size_t key_count, size_t instance_count, Table& method_names, Table& client_names, bool with_series)
      : filter(f),
        window(w),
        group(g),
        names(method_names),
        clients(client_names),
        by_instance(instance_count),
        series_wanted(with_series) {
    if (g == Group::Key) series.resize(key_count);
    else if (g == Group::Type) series.resize(kKinds);
    else if (g == Group::Instance) series.resize(instance_count);
  }
  const Filter& filter;
  const McpUsageWindow& window;
  Group group;
  Table& names;
  Table& clients;
  Usage::Counters totals;
  size_t active_keys = 0;  // the keys that have a request that every filter keeps
  size_t elsewhere = 0;    // the keys that only another instance knows and that nobody deleted: they exist, though this instance has no key of their name
  std::unordered_map<std::string, KeyRow> keys;
  std::array<std::vector<Figures>, kRowKinds> methods;  // by kind of row, then by name
  std::vector<Figures> results;                          // by result
  std::array<uint64_t, kKinds> types{};
  std::vector<ClientFigures> by_client;                  // by client
  std::vector<InstanceFigures> by_instance;              // by source
  // The metrics at each point of the window, by group. The group is the key (its index) for a group by key, or the instance (its source).
  // Otherwise, the group is the method, the client, the result or the type. A group without a request has none.
  // Else, the group has kMetrics * points counts, one metric after the other.
  std::vector<std::vector<uint64_t>> series;
  bool series_wanted = true;
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

// A cell adds to a group at one point of the series. The metrics are the counts of add_to_counters. So the groups add up to the totals.
// The refusals are the 429 and the rejected requests of the totals.
void add_to_series(std::vector<uint64_t>& values, size_t points, size_t point, const Usage::Cell& cell) {
  if (values.empty()) values.assign(kMetrics * points, 0);
  Usage::Counters one;
  add_to_counters(one, cell);
  const uint64_t counts[kMetrics] = {one.requests, one.errors, one.calls, one.duration_ms_sum, one.bytes, one.rate_limited + one.rejected};
  for (size_t metric = 0; metric < kMetrics; ++metric) values[metric * points + point] += counts[metric];
}

// Adds a key (the `index`-th of the sorted ids) to the tally, from every instance that has it. `live` is the key when it exists.
void tally_key(Tally& t, View& view, size_t index, const std::string& id, const McpUsageKeyRef* live) {
  const Filter& f = t.filter;
  const bool key_kept = f.key(id);
  Usage::Counters mine;  // the facet of the keys: every filter but the one of the keys
  bool any = false;
  KeyFacts facts;
  for (size_t s = 0; s < view.size(); ++s) {
    view.with_entry(s, id, [&](const Usage::State& st, const Usage::Entry* entry, Source& src) {
      if (!entry) return;
      facts.add(*entry, s == 0, nullptr);
      if (key_kept && src.selected) tally_records(t, *entry);
      InstanceFigures& instance = t.by_instance[s];
      for (const auto& bucket : window_buckets(*entry, t.window)) {
        if (!in_window(bucket, t.window)) continue;
        const auto point = static_cast<size_t>((bucket.start - t.window.from) / t.window.step);
        for (const auto& cell : bucket.cells) {
          const McpUsageKind kind = kind_of(cell.key);
          const uint32_t client = src.client(st, t.clients, client_of(cell.key));
          const uint32_t method = src.name(st, t.names, method_of(cell.key));
          const uint32_t result = src.name(st, t.names, result_of(cell.key));
          const bool by_client = f.client(t.clients, client);
          const bool by_method = f.method(t.names, method);
          const bool by_result = f.result(t.names, result);
          const bool by_type = f.type(kind);
          const bool others = by_client && by_method && by_result && by_type;  // every filter but the ones of the keys and of the instances
          if (others && src.selected) add_to_counters(mine, cell);
          if (!key_kept) continue;
          if (others) {  // the facet of the instances: every filter but its own
            add_to_counters(instance.counters, cell);
            if (instance.last_entry != index) {
              ++instance.keys;
              instance.last_entry = index;
            }
          }
          if (!src.selected) continue;
          if (by_client && by_result && by_type) add_figures(at_grow(t.methods[row_kind_of(kind)], method), cell, index);
          if (by_client && by_method && by_type) add_figures(at_grow(t.results, result), cell, index);
          if (by_client && by_method && by_result) t.types[static_cast<size_t>(kind)] += cell.count;
          if (by_method && by_result && by_type) add_client_figures(at_grow(t.by_client, client), cell, index);
          if (!others) continue;
          any = true;
          add_to_counters(t.totals, cell);
          if (!t.series_wanted) continue;
          size_t group = 0;
          switch (t.group) {
            case Group::Key: group = index; break;
            case Group::Method: group = method; break;
            case Group::Client: group = client; break;
            case Group::Result: group = result; break;
            case Group::Type: group = static_cast<size_t>(kind); break;
            case Group::Instance: group = s; break;
          }
          add_to_series(at_grow(t.series, group), t.window.points, point, cell);
        }
      }
    });
  }
  if (any) ++t.active_keys;
  const bool elsewhere = !live && facts.deleted_at == 0 && facts.found && !facts.here;
  if (elsewhere) ++t.elsewhere;
  const bool selected = f.keys_on && f.keys.count(id) != 0;
  if (mine.requests == 0 && !selected) return;
  KeyRow& row = t.keys[id];
  const McpUsageKeyRef& named = live ? *live : facts.ref;
  row.id = id;
  row.name = named.name;
  row.host = named.host;
  row.source = named.source;
  row.deleted_at = live ? 0 : facts.deleted_at;
  row.elsewhere = elsewhere;
  row.last_used = facts.last_used;
  row.counters = mine;
  row.selected = selected;
}

// The facet rows to show: the first ones, and the selected ones after them. Returns how many were omitted.
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

struct InstanceRow {
  McpUsageInstance info;
  InstanceFigures figures;
  bool selected = false;
};

// What a ranking of the series shows: its groups, and the others summed in `rest`. The metrics of a group are the counts of the tally.
// They are a pointer, never a copy. So a series that is ranked several times holds them once.
struct Ranking {
  struct Shown {
    std::string id;
    std::string label;
    uint64_t total = 0;                              // its requests
    const std::vector<uint64_t>* metrics = nullptr;  // as the series of the tally
  };
  std::vector<Shown> groups;
  size_t folded = 0;                   // the groups that are in `rest`
  uint64_t rest_total = 0;             // their requests
  std::vector<uint64_t> rest_metrics;  // as the series of the tally
};

// The metrics of a group, one array for each, as the members of an object.
void put_metrics(McpJsonWriter& w, const std::vector<uint64_t>& metrics, size_t points) {
  for (size_t metric = 0; metric < kMetrics; ++metric) {
    w.Key(kSeriesMetrics[metric]);
    w.StartArray();
    for (size_t point = 0; point < points; ++point) w.Uint64(metrics[metric * points + point]);
    w.EndArray();
  }
}

// A ranking as the members `groups` and `rest` of the object that is open.
void put_ranking(McpJsonWriter& w, const Ranking& ranking, size_t points) {
  w.Key("groups");
  w.StartArray();
  for (const auto& group : ranking.groups) {
    w.StartObject();
    w.Key("id"); put(w, group.id);
    w.Key("label"); put(w, group.label);
    w.Key("total"); w.Uint64(group.total);
    put_metrics(w, *group.metrics, points);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rest");
  w.StartObject();
  w.Key("groups"); w.Uint64(ranking.folded);
  w.Key("total"); w.Uint64(ranking.rest_total);
  put_metrics(w, ranking.rest_metrics, points);
  w.EndObject();
}

// The series: its points, then its groups as `order` ranks them.
// Then once more for each of `orders`, in `rankings`. The rankings are only there when some were asked.
// A series grouped by a dimension that is filtered shows the values that were chosen, in their order.
// A value without a request is a line of zeros, whatever the metric. `id_of` names a group, and `label_of` names a group by its id.
//
// Otherwise, the series shows the 8 largest groups by the metric over the window.
// The smaller id comes first when the totals are equal.
//
// The others are summed in `rest`. A group that has none of that metric is one of them, even when there are fewer than 8.
// The results that are not errors are one such group, when the errors rank.
// The groups are counted once, from the tally. Each ranking sorts the same counts.
void put_series(McpJsonWriter& w, const Tally& t, const std::string& order, const std::vector<std::string>& orders,
                const std::vector<std::string>& chosen, const std::function<std::string(size_t)>& id_of,
                const std::function<std::string(const std::string&)>& label_of) {
  const size_t points = t.window.points;
  // The groups that have requests, by id, with their total of each metric over the window (the requests come first).
  struct Counted {
    std::string id;
    std::array<uint64_t, kMetrics> sums{};
    const std::vector<uint64_t>* metrics = nullptr;
  };
  std::vector<Counted> counted;
  for (size_t group = 0; group < t.series.size(); ++group) {
    const std::vector<uint64_t>& metrics = t.series[group];
    if (metrics.empty()) continue;
    Counted item;
    item.id = id_of(group);
    for (size_t metric = 0; metric < kMetrics; ++metric) {
      for (size_t point = 0; point < points; ++point) item.sums[metric] += metrics[metric * points + point];
    }
    item.metrics = &metrics;
    counted.push_back(std::move(item));
  }
  const std::vector<uint64_t> zeros(kMetrics * points, 0);  // a value that was chosen and has no request
  const auto rank = [&](const std::string& by) {
    const size_t metric = order_metric(by);
    Ranking ranking;
    ranking.rest_metrics.assign(kMetrics * points, 0);
    const auto show = [&](const std::string& id, const Counted* item) {
      Ranking::Shown group;
      group.id = id;
      group.label = label_of(id);
      group.total = item ? item->sums[0] : 0;
      group.metrics = item ? item->metrics : &zeros;
      ranking.groups.push_back(std::move(group));
    };
    if (!chosen.empty()) {
      for (const auto& id : chosen) {
        const auto it = std::find_if(counted.begin(), counted.end(), [&](const Counted& item) { return item.id == id; });
        show(id, it == counted.end() ? nullptr : &*it);
      }
      return ranking;
    }
    std::vector<const Counted*> sorted;
    sorted.reserve(counted.size());
    for (const auto& item : counted) sorted.push_back(&item);
    std::sort(sorted.begin(), sorted.end(), [&](const Counted* a, const Counted* b) {
      return a->sums[metric] != b->sums[metric] ? a->sums[metric] > b->sums[metric] : a->id < b->id;
    });
    for (size_t i = 0; i < sorted.size(); ++i) {
      if (i < kSeriesGroups && sorted[i]->sums[metric] != 0) {
        show(sorted[i]->id, sorted[i]);
        continue;
      }
      ++ranking.folded;
      ranking.rest_total += sorted[i]->sums[0];
      for (size_t m = 0; m < kMetrics * points; ++m) ranking.rest_metrics[m] += (*sorted[i]->metrics)[m];
    }
    return ranking;
  };
  w.Key("series");
  w.StartObject();
  w.Key("step"); w.Int64(t.window.step);
  w.Key("t");
  w.StartArray();
  for (size_t i = 0; i < points; ++i) put(w, mcp_iso_utc(t.window.from + static_cast<int64_t>(i) * t.window.step));
  w.EndArray();
  put_ranking(w, rank(order), points);
  if (!orders.empty()) {
    w.Key("rankings");
    w.StartObject();
    for (const auto& name : orders) {
      w.Key(name.c_str());
      w.StartObject();
      put_ranking(w, rank(name), points);
      w.EndObject();
    }
    w.EndObject();
  }
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

// The facets and the clients follow the totals and the series. `known` is every instance with how it went.
// `source_of` is the source that reads each instance. The instances that were skipped have none.
void put_facets(McpJsonWriter& w, const Tally& t, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                const std::vector<McpUsageInstance>& known, const std::unordered_map<std::string, size_t>& source_of, size_t limit) {
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
  const size_t keys_omitted = cap_rows(&keys, limit);

  std::vector<MethodRow> methods;
  for (size_t kind = 0; kind < kRowKinds; ++kind) {
    for (size_t id = 0; id < t.methods[kind].size(); ++id) {
      if (t.methods[kind][id].requests == 0) continue;
      MethodRow row;
      row.method = t.names.name(id);
      row.kind = static_cast<uint8_t>(kind);
      row.figures = t.methods[kind][id];
      row.selected = listed(query.methods, row.method);
      methods.push_back(std::move(row));
    }
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
  const size_t methods_omitted = cap_rows(&methods, limit);

  std::vector<ResultRow> results;
  for (size_t id = 0; id < t.results.size(); ++id) {
    if (t.results[id].requests == 0) continue;
    ResultRow row;
    row.result = t.names.name(id);
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
  const size_t results_omitted = cap_rows(&results, limit);

  // The clients: those that have a request in the window (every filter but their own), and the ones that were chosen.
  std::vector<ClientRow> clients;
  for (size_t id = 0; id < t.by_client.size(); ++id) {
    if (t.by_client[id].counters.requests == 0) continue;
    ClientRow row;
    row.client = t.clients.name(id);
    row.figures = t.by_client[id];
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
  const size_t clients_omitted = cap_rows(&clients, limit);

  // The instances: every one that is known. This one comes first, then the others by name. An instance with no request has 0.
  // The instances that were chosen and are not known are also listed. The list applies every filter but its own.
  std::vector<InstanceRow> instances;
  for (const auto& info : known) {
    InstanceRow row;
    row.info = info;
    const auto source = source_of.find(info.instance);
    if (source != source_of.end()) row.figures = t.by_instance[source->second];
    row.selected = listed(query.instances, info.instance);
    instances.push_back(std::move(row));
  }
  for (const auto& instance : query.instances) {
    const bool counted = std::any_of(instances.begin(), instances.end(), [&](const InstanceRow& row) { return row.info.instance == instance; });
    if (counted) continue;
    InstanceRow row;
    row.info.instance = instance;
    row.info.status = "unknown";
    row.info.reason = "no instance of this name was found";
    row.selected = true;
    instances.push_back(std::move(row));
  }
  const size_t instances_omitted = cap_rows(&instances, limit);

  w.Key("instances");
  w.StartArray();
  for (const auto& row : instances) {
    w.StartObject();
    w.Key("instance"); put(w, row.info.instance);
    w.Key("status"); put(w, row.info.status);
    w.Key("reason"); put(w, row.info.reason);
    put_time(w, "written_at", row.info.written_at);
    put_counters(w, row.figures.counters);
    w.Key("keys"); w.Uint64(row.figures.keys);
    w.EndObject();
  }
  w.EndArray();
  w.Key("keys");
  w.StartArray();
  for (const auto& row : keys) {
    w.StartObject();
    put_key(w, McpUsageKeyRef{row.id, row.name, row.host, row.source}, row.deleted_at, row.elsewhere);
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
  w.Key("instances"); w.Uint64(instances_omitted);
  w.EndObject();
}

} // namespace

// ---- keys, windows, text --------------------------------------------------------------------------

McpUsageKeyRef mcp_usage_key_ref(const McpKey& key) {
  return McpUsageKeyRef{key.id, key.name, key.hosts.size() == 1 ? key.hosts.front() : std::string(), key.source};
}

bool mcp_valid_key_id(std::string_view id) {
  if (mcp_valid_key_name(id)) return true;
  if (id.size() != 15 || id.substr(0, 3) != "ui_") return false;
  return std::all_of(id.begin() + 3, id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

bool mcp_valid_usage_instance(std::string_view instance) {
  return !instance.empty() && instance.size() <= kInstanceBytes &&
         std::all_of(instance.begin(), instance.end(), [](char c) {
           return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
         });
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

std::optional<McpValidationError> mcp_usage_overview_check(McpUsageOverviewQuery* query) {
  const auto bad = [](const char* field, const char* reason, std::string message) {
    return McpValidationError{field, reason, std::move(message)};
  };
  if (query->group != "key" && query->group != "method" && query->group != "client" && query->group != "result" && query->group != "type" &&
      query->group != "instance") {
    return bad("group", "invalid", "group must be key, method, client, result, type or instance");
  }
  if (!valid_order(query->order)) return bad("order", "invalid", "order must be requests, errors, refused, calls or bytes");
  const auto check = [&](const char* field, std::vector<std::string>* values, bool (*valid)(const std::string&), const char* rule,
                         size_t most = kMcpUsageOverviewMaxValues) -> std::optional<McpValidationError> {
    std::vector<std::string> once;
    for (auto& value : *values) {
      if (!listed(once, value)) once.push_back(std::move(value));
    }
    *values = std::move(once);
    if (values->size() > most) return bad(field, "too_many", std::string(field) + " takes at most " + std::to_string(most) + " values");
    for (const auto& value : *values) {
      if (!valid(value)) return bad(field, "invalid", std::string(field) + " must be " + rule);
    }
    return std::nullopt;
  };
    // The orders of the rankings: at most the 5 that there are, each one once. A sixth value cannot be one of them, because the number is checked first.
  if (const auto error = check("orders", &query->orders, valid_order, "requests, errors, refused, calls or bytes", kOrders)) return error;
  if (const auto error = check("key", &query->keys, [](const std::string& v) { return mcp_valid_key_id(v); }, "the id of a key")) return error;
  if (const auto error = check("method", &query->methods, [](const std::string& v) { return valid_method(v); }, "a tool or a method of the protocol (A-Z a-z 0-9 _ /, at most 64)")) return error;
  if (const auto error = check("client", &query->clients, [](const std::string& v) { return valid_client(v); }, "a client name (printable ASCII, 1 to 64 bytes)")) return error;
  if (const auto error = check("instance", &query->instances, [](const std::string& v) { return mcp_valid_usage_instance(v); }, "an instance (A-Z a-z 0-9 . _ -, 1 to 64 bytes)")) return error;
  if (const auto error = check("result", &query->results, [](const std::string& v) { return valid_name(v); }, "a result (a-z 0-9 _, at most 64)")) return error;
  if (const auto error = check("type", &query->types, [](const std::string& v) { return kind_index(v) >= 0; }, "call, request, limited or rejected")) return error;
  return std::nullopt;
}

// ---- the state of this instance --------------------------------------------------------------------

McpUsage::McpUsage(McpUsageOptions options, int64_t now) : options_(std::move(options)) {
  options_.retention_days = std::clamp<int64_t>(options_.retention_days, 1, kMcpUsageMaxRetentionDays);
  store_ = options_.store;
  instance_ = store_ ? store_->instance() : options_.instance;
  others_ = std::make_shared<const std::vector<Other>>();
  bool loaded = false;
  if (store_) loaded = store_->load(&state_, options_.max_clients);
  since_ = loaded ? state_.since : now;
  state_.since = since_;
  written_at_ = loaded ? state_.written_at : 0;
  // A state that was not stored yet is written at the first save, so the start of the counting is kept.
  dirty_ = store_ != nullptr && !loaded;
  last_save_ = now;
  prune_locked(now);
  cap_deleted_locked();
}

int64_t McpUsage::since() const {
  int64_t since = since_;
  for (const auto& other : *others_snapshot()) {
    if (other.status == "ok" && other.since > 0) since = std::min(since, other.since);
  }
  return since;
}

std::shared_ptr<const std::vector<McpUsage::Other>> McpUsage::others_snapshot() const {
  std::lock_guard<std::mutex> lock(others_mu_);
  return others_;
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
    // The key as it is now. A key of the configuration can change its host from one start to the next.
    // A call that ends after the deletion of its key counts for the deleted key, as it was.
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
        // Nothing is kept past the retention. A tier that the retention no longer reaches is emptied. This happens when the retention was lowered.
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
    // A deleted key is gone when its usage is older than the retention. A deleted key that was never used is gone after 2 hours.
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
  std::unordered_map<std::string, int64_t> out;
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (const auto& [id, entry] : state_.entries) {
      if (entry.last_used > 0) out.emplace(id, entry.last_used);
    }
  }
  for (const auto& other : *others_snapshot()) {
    if (!other.state) continue;
    for (const auto& [id, entry] : other.state->entries) {
      if (entry.last_used <= 0) continue;
      int64_t& last = out[id];
      last = std::max(last, entry.last_used);
    }
  }
  return out;
}

std::optional<McpUsageKeyRef> McpUsage::entry_key(const std::string& id) const {
  {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = state_.entries.find(id);
    if (it != state_.entries.end()) return it->second.key;
  }
  for (const auto& other : *others_snapshot()) {
    if (!other.state) continue;
    const auto it = other.state->entries.find(id);
    if (it != other.state->entries.end()) return it->second.key;
  }
  return std::nullopt;
}

std::vector<McpUsageInstance> McpUsage::instances() const {
  std::vector<McpUsageInstance> out;
  {
    std::lock_guard<std::mutex> lock(mu_);
    McpUsageInstance own;
    own.instance = instance_;
    own.written_at = written_at_;
    own.status = conflict_ ? "conflict" : "ok";
    own.reason = conflict_ ? conflict_reason_ : std::string();
    out.push_back(std::move(own));
  }
  for (const auto& other : *others_snapshot()) {
    McpUsageInstance item;
    item.instance = other.instance;
    item.written_at = other.written_at;
    item.status = other.status;
    item.reason = other.reason;
    out.push_back(std::move(item));
  }
  return out;
}

// ---- the answers --------------------------------------------------------------------------------------

void McpUsage::write_list(McpJsonWriter& w, const std::vector<McpUsageKeyRef>& live, const McpUsageWindow& window, int64_t now) const {
  View view(&mu_, &state_, instance_, others_snapshot(), {});
  w.StartObject();
  put_head(w, window, now, since(), options_.retention_days);
  put_instances(w, instances());
  w.Key("keys");
  w.StartArray();
  std::unordered_set<std::string> listed_ids;
  for (const auto& key : live) {
    listed_ids.insert(key.id);
    const KeyFacts facts = facts_of(view, key.id, &window, false);
    put_summary(w, key, facts, 0, false);
  }
  // The keys that are not live here, and that still have usage, follow. The deleted keys come first, in the order of the last deletion.
  // The keys that only another instance knows follow, in the order of the last use.
  std::vector<std::pair<KeyFacts, std::string>> gone;
  for (const auto& id : view.key_ids()) {
    if (listed_ids.count(id)) continue;
    KeyFacts facts = facts_of(view, id, nullptr, false);  // what the entries say, before the window of the ones that are kept is summed
    if (!facts.found || !facts.has_usage) continue;
    if (facts.deleted_at == 0 && facts.here) continue;  // this instance has it and does not say that it is deleted: not a key of the list
    gone.emplace_back(facts_of(view, id, &window, false), id);
  }
  std::sort(gone.begin(), gone.end(), [](const auto& a, const auto& b) {
    const bool a_deleted = a.first.deleted_at != 0;
    const bool b_deleted = b.first.deleted_at != 0;
    if (a_deleted != b_deleted) return a_deleted;
    if (a_deleted && a.first.deleted_at != b.first.deleted_at) return a.first.deleted_at > b.first.deleted_at;
    if (!a_deleted && a.first.last_used != b.first.last_used) return a.first.last_used > b.first.last_used;
    return a.second < b.second;
  });
  for (const auto& item : gone) put_summary(w, item.first.ref, item.first, item.first.deleted_at, item.first.deleted_at == 0);
  w.EndArray();
  w.EndObject();
}

bool McpUsage::write_detail(McpJsonWriter& w, const std::string& id, const McpUsageKeyRef* live, const McpUsageWindow& window, int64_t now,
                            const McpUsageDetailQuery& query) const {
  View view(&mu_, &state_, instance_, others_snapshot(), query.instances);
  const KeyFacts any = facts_of(view, id, nullptr, false);  // whether the key exists is for every instance, whatever the filter
  if (!live && !any.found) return false;
  const KeyFacts mine = facts_of(view, id, &window, true);
  const McpUsageKeyRef& key = live ? *live : any.ref;
  const int64_t deleted_at = live ? 0 : any.deleted_at;

  // One pass visits the instances that are summed. The pass collects the points of the series, and the tools (the tool calls, by tool).
  // It also collects the results (every cell but the successful protocol requests) of the window, and the records of the clients.
  Table names;
  std::vector<Usage::Counters> points(window.points);
  std::unordered_map<uint32_t, Figures> tools;
  std::unordered_map<uint32_t, uint64_t> results;
  std::map<std::tuple<std::string, std::string, std::string>, Usage::Client> clients;
  for (size_t s = 0; s < view.size(); ++s) {
    if (!view.sources[s].selected) continue;
    view.with_entry(s, id, [&](const Usage::State& st, const Usage::Entry* entry, Source& src) {
      if (!entry) return;
      for (const auto& bucket : window_buckets(*entry, window)) {
        if (!in_window(bucket, window)) continue;
        const auto point = static_cast<size_t>((bucket.start - window.from) / window.step);
        for (const auto& cell : bucket.cells) {
          add_to_counters(points[point], cell);
          const McpUsageKind kind = kind_of(cell.key);
          if (kind == McpUsageKind::ToolCall) add_figures(tools[src.name(st, names, method_of(cell.key))], cell, 0);
          if (kind != McpUsageKind::Request || result_of(cell.key) != kNameOk) results[src.name(st, names, result_of(cell.key))] += cell.count;
        }
      }
      for (const auto& record : entry->clients) {
        // The records of a client add up. A record has the name, the version and the User-Agent of the client, as the instances kept them.
        const auto found = clients.emplace(std::make_tuple(record.name, record.version, record.user_agent), record);
        if (found.second) continue;
        Client& merged = found.first->second;
        merged.requests += record.requests;
        merged.first_seen = std::min(merged.first_seen, record.first_seen);
        merged.last_seen = std::max(merged.last_seen, record.last_seen);
      }
    });
  }

  w.StartObject();
  put_key(w, key, deleted_at, !live && deleted_at == 0 && any.found && !any.here);
  put_head(w, window, now, since(), options_.retention_days);
  put_instances(w, instances());
  put_time(w, "first_used_at", mine.first_used);
  put_time(w, "last_used_at", mine.last_used);

  w.Key("totals");
  w.StartObject();
  put_counters(w, mine.total);
  w.EndObject();

  // One point for each step of the window, from its start: a step without a bucket has no request.
  if (query.series) {
    w.Key("series");
    w.StartObject();
    w.Key("step"); w.Int64(window.step);
    w.Key("points");
    w.StartArray();
    for (size_t i = 0; i < window.points; ++i) {
      w.StartObject();
      w.Key("t"); put(w, mcp_iso_utc(window.from + static_cast<int64_t>(i) * window.step));
      w.Key("requests"); w.Uint64(points[i].requests);
      w.Key("calls"); w.Uint64(points[i].calls);
      w.Key("errors"); w.Uint64(points[i].errors);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }

  // The most frequent first.
  std::vector<std::pair<std::string, Figures>> tool_rows;
  for (const auto& [name, figures] : tools) tool_rows.emplace_back(names.name(name), figures);
  std::sort(tool_rows.begin(), tool_rows.end(), [](const auto& a, const auto& b) {
    return a.second.requests != b.second.requests ? a.second.requests > b.second.requests : a.first < b.first;
  });
  std::vector<std::pair<std::string, uint64_t>> result_rows;
  for (const auto& [name, count] : results) result_rows.emplace_back(names.name(name), count);
  std::sort(result_rows.begin(), result_rows.end(), [](const auto& a, const auto& b) { return a.second != b.second ? a.second > b.second : a.first < b.first; });
  std::vector<Client> client_rows;
  for (const auto& item : clients) client_rows.push_back(item.second);
  std::sort(client_rows.begin(), client_rows.end(), [](const Client& a, const Client& b) {
    if (a.last_seen != b.last_seen) return a.last_seen > b.last_seen;
    return std::tie(a.name, a.version, a.user_agent) < std::tie(b.name, b.version, b.user_agent);
  });
  if (client_rows.size() > options_.max_clients) client_rows.resize(options_.max_clients);
  size_t tools_omitted = 0;
  size_t results_omitted = 0;
  size_t clients_omitted = 0;
  if (query.limit != 0) {
    const auto cut = [&](auto& rows, size_t& omitted) {
      if (rows.size() <= query.limit) return;
      omitted = rows.size() - query.limit;
      rows.resize(query.limit);
    };
    cut(tool_rows, tools_omitted);
    cut(result_rows, results_omitted);
    cut(client_rows, clients_omitted);
  }

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
  w.Key("statuses");
  w.StartArray();
  for (const auto& [name, count] : result_rows) {
    w.StartObject();
    w.Key("status"); put(w, name);
    w.Key("count"); w.Uint64(count);
    w.EndObject();
  }
  w.EndArray();
  w.Key("clients");
  w.StartArray();
  for (const auto& client : client_rows) {
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
  // For a caller that asked for fewer rows: how many were omitted from each list.
  if (query.limit != 0) {
    w.Key("omitted");
    w.StartObject();
    w.Key("tools"); w.Uint64(tools_omitted);
    w.Key("statuses"); w.Uint64(results_omitted);
    w.Key("clients"); w.Uint64(clients_omitted);
    w.EndObject();
  }
  w.EndObject();
  return true;
}

void McpUsage::write_overview(McpJsonWriter& w, const McpUsageOverviewQuery& query, const std::vector<McpUsageKeyRef>& live,
                              const McpUsageWindow& window, int64_t now) const {
  // 1. The filters in the terms of the cells: a name that was never counted is chosen by no id, so it keeps nothing.
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
  Table names(query.methods, query.results);
  Table clients(query.clients);

  // 2. The keys, one after the other, each one in every instance that has it.
  View view(&mu_, &state_, instance_, others_snapshot(), query.instances);
  const std::vector<std::string> ids = view.key_ids();
  Tally tally(filter, window, group_of(query.group), ids.size(), view.size(), names, clients, query.series);
  std::unordered_map<std::string, const McpUsageKeyRef*> live_by_id;
  for (const auto& key : live) live_by_id.emplace(key.id, &key);
  for (size_t i = 0; i < ids.size(); ++i) {
    const auto named = live_by_id.find(ids[i]);
    tally_key(tally, view, i, ids[i], named == live_by_id.end() ? nullptr : named->second);
  }

  std::unordered_map<std::string, std::string> key_names;
  for (const auto& key : live) key_names.emplace(key.id, key.name);
  for (const auto& item : tally.keys) key_names[item.first] = item.second.name;
  const std::vector<McpUsageInstance> known = instances();
  std::unordered_map<std::string, size_t> source_of;
  for (size_t s = 0; s < view.size(); ++s) source_of.emplace(view.sources[s].instance, s);
  const size_t limit = query.limit != 0 ? query.limit : kMcpUsageFacetRows;

  w.StartObject();
  put_head(w, window, now, since(), options_.retention_days);
  w.Key("group"); put(w, query.group);
  w.Key("order"); put(w, query.order);
  w.Key("filters");
  w.StartObject();
  w.Key("key"); put_strings(w, query.keys);
  w.Key("method"); put_strings(w, query.methods);
  w.Key("client"); put_strings(w, query.clients);
  w.Key("instance"); put_strings(w, query.instances);
  w.Key("result"); put_strings(w, query.results);
  w.Key("type"); put_strings(w, query.types);
  w.EndObject();
  w.Key("totals");
  w.StartObject();
  put_counters(w, tally.totals);
  w.Key("active_keys"); w.Uint64(tally.active_keys);
  // The keys that exist are those of this instance, and those that only another instance knows. A deleted key is not one of them.
  // The count is the same whichever instance answers.
  w.Key("keys"); w.Uint64(live.size() + tally.elsewhere);
  w.EndObject();
  if (query.series) {
    const std::vector<std::string>* chosen = nullptr;
    switch (tally.group) {
      case Group::Key: chosen = &query.keys; break;
      case Group::Method: chosen = &query.methods; break;
      case Group::Client: chosen = &query.clients; break;
      case Group::Result: chosen = &query.results; break;
      case Group::Type: chosen = &query.types; break;
      case Group::Instance: chosen = &query.instances; break;
    }
    const auto id_of = [&](size_t group) -> std::string {
      switch (tally.group) {
        case Group::Key: return ids[group];
        case Group::Method:
        case Group::Result: return names.name(group);
        case Group::Client: return clients.name(group);
        case Group::Instance: return view.sources[group].instance;
        case Group::Type: break;
      }
      return kKindNames[group];
    };
    const auto label_of = [&](const std::string& id) -> std::string {
      if (tally.group != Group::Key) return id;
      const auto it = key_names.find(id);
      return it == key_names.end() ? id : it->second;
    };
    put_series(w, tally, query.order, query.orders, *chosen, id_of, label_of);
  }
  put_facets(w, tally, query, live, known, source_of, limit);
  w.EndObject();
}

// ---- the store ------------------------------------------------------------------------------------

bool McpUsage::save(int64_t now) {
  std::lock_guard<std::mutex> writing(write_mu_);
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(mu_);
    last_save_ = now;
    prune_locked(now);
    if (!store_ || !dirty_) return true;
    dirty_ = false;
    ids.reserve(state_.entries.size());
    for (const auto& item : state_.entries) ids.push_back(item.first);
  }
  std::sort(ids.begin(), ids.end());
  McpUsageHeader header;
  header.since = since_;
  header.written_at = now;
  header.retention_days = options_.retention_days;
  McpUsageSaveStatus status = McpUsageSaveStatus::Ok;
  std::string error;
  std::unique_ptr<McpUsageWriter> writer = store_->begin(header, &status, &error);
  if (!writer) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      dirty_ = true;
      conflict_ = status == McpUsageSaveStatus::Conflict;
      conflict_reason_ = conflict_ ? "another ChDash process writes the file of this instance: give each instance its own mcp.usage.instance" : std::string();
    }
    // A conflict is logged by the store, once for each change.
    if (status != McpUsageSaveStatus::Conflict) log_event(LogLevel::Error, "mcp.usage_save_failed", {{"file", store_->location()}, {"error", error}});
    return false;
  }
  // The code takes one entry at a time under the lock. The rows are made in memory.
  // So a call that counts meanwhile waits for one entry, never for the whole state, and never for the disk.
  // The rows are written once the lock is released.
  for (const auto& id : ids) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      const auto it = state_.entries.find(id);
      if (it != state_.entries.end()) write_rows(*writer, state_, it->second);
    }
    writer->flush();
  }
  const size_t bytes = writer->bytes();
  const bool ok = writer->commit(&error);
  {
    std::lock_guard<std::mutex> lock(mu_);
    if (ok) {
      last_size_ = bytes;
      written_at_ = now;
      conflict_ = false;
      conflict_reason_.clear();
    } else {
      dirty_ = true;
    }
  }
  if (!ok) log_event(LogLevel::Error, "mcp.usage_save_failed", {{"file", store_->location()}, {"error", error}});
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

void McpUsage::refresh_others(int64_t now) {
  if (!store_) return;
  std::lock_guard<std::mutex> lock(refresh_mu_);
  last_refresh_ = now;
  std::vector<Other> found;
  // The files of the instances that are gone first (what the last read saw), then what changed in the others.
  store_->prune(now, options_.retention_days);
  if (!store_->refresh(&found, options_.max_clients, cancel_)) return;
  auto next = std::make_shared<const std::vector<Other>>(std::move(found));
  std::lock_guard<std::mutex> swap(others_mu_);
  others_ = std::move(next);
}

void McpUsage::refresh_if_due(int64_t now) {
  if (!store_ || cancel_.load(std::memory_order_relaxed)) return;
  {
    std::lock_guard<std::mutex> lock(refresh_mu_);
    if (last_refresh_ != 0 && now >= last_refresh_ && now - last_refresh_ < kRefreshEvery) return;
  }
  refresh_others(now);
}

void McpUsage::tick(int64_t now) {
  save_if_due(now);
  refresh_if_due(now);
}

} // namespace chdash
