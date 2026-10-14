#include "mcp_usage.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "query_library_file.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <unordered_set>

namespace chdash {
namespace {

using Usage = McpUsage;

constexpr int64_t kHour = 3600;
constexpr int64_t kDay = 86400;
constexpr int64_t kHours = 24;
constexpr size_t kMaxFileBytes = 128u * 1024 * 1024;
constexpr size_t kMaxNames = 4096;
constexpr size_t kToolsPerBucket = 256;
constexpr size_t kResultsPerBucket = 32;
constexpr int64_t kTombstoneSeconds = 2 * kHour;
constexpr size_t kNameBytes = 64;
constexpr size_t kClientNameBytes = 128;
constexpr size_t kClientVersionBytes = 64;
constexpr size_t kUserAgentBytes = 256;
constexpr size_t kHostBytes = 256;
constexpr int64_t kSaveEvery = 60;
constexpr int64_t kSaveEveryLarge = 300;
constexpr size_t kLargeFile = 8u * 1024 * 1024;
constexpr size_t kBucketFields = 12;  // start, 9 counters, the tools, the results

int64_t floor_to(int64_t t, int64_t step) {
  const int64_t r = t % step;
  return t - (r < 0 ? r + step : r);
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

// A key of the configuration (its name) or of the page (ui_ and 12 hexadecimal digits).
bool valid_key_id(std::string_view id) {
  if (mcp_valid_key_name(id)) return true;
  if (id.size() != 15 || id.substr(0, 3) != "ui_") return false;
  return std::all_of(id.begin() + 3, id.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

size_t cells_of(const Usage::Bucket& bucket) { return bucket.tools.size() + bucket.results.size(); }

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

// The cell of `id`. A new cell past the caps (of the bucket, of all the buckets) is the cell "other" (id 0).
template <typename T>
T& cell_of(std::vector<std::pair<uint16_t, T>>& cells, uint16_t id, size_t per_bucket, size_t* used, size_t max_cells) {
  for (auto& item : cells) {
    if (item.first == id) return item.second;
  }
  if (id != 0 && (cells.size() + 1 >= per_bucket || *used >= max_cells)) return cell_of(cells, 0, SIZE_MAX, used, SIZE_MAX);
  cells.emplace_back(id, T{});
  ++*used;
  return cells.back().second;
}

void add_counters(Usage::Counters& into, const Usage::Counters& add) {
  into.requests += add.requests;
  into.calls += add.calls;
  into.errors += add.errors;
  into.rate_limited += add.rate_limited;
  into.rejected += add.rejected;
  into.duration_ms_sum += add.duration_ms_sum;
  into.duration_ms_max = std::max(into.duration_ms_max, add.duration_ms_max);
  into.rows += add.rows;
  into.bytes += add.bytes;
}

void add_cell(Usage::Cell& into, const Usage::Cell& add) {
  into.calls += add.calls;
  into.errors += add.errors;
  into.duration_ms_sum += add.duration_ms_sum;
  into.duration_ms_max = std::max(into.duration_ms_max, add.duration_ms_max);
  into.rows += add.rows;
  into.bytes += add.bytes;
}

struct Recorded {
  bool ok = false;
  bool count_result = false;
  uint16_t tool = 0;
  uint16_t result = 0;
};

void add_event(Usage::Bucket& bucket, const McpUsageEvent& event, const Recorded& what, size_t* cells, size_t max_cells) {
  Usage::Counters& total = bucket.total;
  ++total.requests;
  total.bytes += event.bytes;
  switch (event.kind) {
    case McpUsageKind::ToolCall: {
      const auto ms = static_cast<uint64_t>(std::max<int64_t>(0, event.duration_ms));
      ++total.calls;
      if (!what.ok) ++total.errors;
      total.duration_ms_sum += ms;
      total.duration_ms_max = std::max(total.duration_ms_max, ms);
      total.rows += event.rows;
      Usage::Cell& cell = cell_of(bucket.tools, what.tool, kToolsPerBucket, cells, max_cells);
      ++cell.calls;
      if (!what.ok) ++cell.errors;
      cell.duration_ms_sum += ms;
      cell.duration_ms_max = std::max(cell.duration_ms_max, ms);
      cell.rows += event.rows;
      cell.bytes += event.bytes;
      break;
    }
    case McpUsageKind::Request:
      if (!what.ok) ++total.errors;
      break;
    case McpUsageKind::RateLimited:
      ++total.rate_limited;
      break;
    case McpUsageKind::Rejected:
      ++total.rejected;
      break;
  }
  if (what.count_result) ++cell_of(bucket.results, what.result, kResultsPerBucket, cells, max_cells);
}

// The client of a request: an initialize with clientInfo is the client of that name, version and User-Agent (or the client
// with that User-Agent that had no name yet); any other request is the client last seen with its User-Agent.
void note_client(Usage::Entry& entry, const McpUsageEvent& event, size_t max_clients) {
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
  if (entry.clients.size() > max_clients) {
    const auto oldest = std::min_element(entry.clients.begin(), entry.clients.end(),
                                         [](const Usage::Client& a, const Usage::Client& b) { return a.last_seen < b.last_seen; });
    entry.clients.erase(oldest);
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

std::vector<Usage::Bucket> buckets_of(const rapidjson::Value& value, const std::string& where, int64_t step, Usage::State* state) {
  if (!value.IsArray()) file_error(where + " must be an array");
  std::vector<Usage::Bucket> out;
  size_t index = 0;
  for (const auto& item : value.GetArray()) {
    const std::string at = where + "[" + std::to_string(index++) + "]";
    if (!item.IsArray() || item.Size() != kBucketFields) file_error(at + " must be an array of 12 fields");
    Usage::Bucket bucket;
    if (!item[0].IsInt64() || item[0].GetInt64() <= 0 || item[0].GetInt64() % step != 0) file_error(at + " must start on a whole " + (step == kHour ? "hour" : "day"));
    bucket.start = item[0].GetInt64();
    if (!out.empty() && out.back().start >= bucket.start) file_error(at + " is not after the bucket before it");
    uint64_t* counters[] = {&bucket.total.requests, &bucket.total.calls, &bucket.total.errors, &bucket.total.rate_limited, &bucket.total.rejected,
                            &bucket.total.duration_ms_sum, &bucket.total.duration_ms_max, &bucket.total.rows, &bucket.total.bytes};
    for (size_t i = 0; i < 9; ++i) *counters[i] = count_of(item[static_cast<rapidjson::SizeType>(i + 1)], at);
    if (!item[10].IsObject() || !item[11].IsObject()) file_error(at + " must end with the tools and the results (objects)");
    for (const auto& tool : item[10].GetObject()) {
      const std::string name(tool.name.GetString(), tool.name.GetStringLength());
      if (!valid_name(name)) file_error(at + " has a tool name that is not valid");
      if (!tool.value.IsArray() || tool.value.Size() != 6) file_error(at + " has a tool whose cell is not 6 counts");
      Usage::Cell cell;
      uint64_t* fields[] = {&cell.calls, &cell.errors, &cell.duration_ms_sum, &cell.duration_ms_max, &cell.rows, &cell.bytes};
      for (rapidjson::SizeType i = 0; i < 6; ++i) *fields[i] = count_of(tool.value[i], at);
      if (bucket.tools.size() >= kToolsPerBucket) continue;
      add_cell(cell_of(bucket.tools, state->names.intern(name), SIZE_MAX, &state->cells, SIZE_MAX), cell);
    }
    for (const auto& result : item[11].GetObject()) {
      const std::string name(result.name.GetString(), result.name.GetStringLength());
      if (!valid_name(name)) file_error(at + " has a result name that is not valid");
      const uint64_t count = count_of(result.value, at);
      if (bucket.results.size() >= kResultsPerBucket) continue;
      cell_of(bucket.results, state->names.intern(name), SIZE_MAX, &state->cells, SIZE_MAX) += count;
    }
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
    if (!valid_key_id(entry.key.id)) file_error(where + ".id is not the id of a key");
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
    entry.hours = buckets_of(member(item, "hours", where), where + ".hours", kHour, state);
    entry.days = buckets_of(member(item, "days", where), where + ".days", kDay, state);
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

void put_bucket(McpJsonWriter& w, const Usage::Bucket& bucket, const Usage::Names& names) {
  w.StartArray();
  w.Int64(bucket.start);
  const Usage::Counters& t = bucket.total;
  for (const uint64_t value : {t.requests, t.calls, t.errors, t.rate_limited, t.rejected, t.duration_ms_sum, t.duration_ms_max, t.rows, t.bytes}) w.Uint64(value);
  w.StartObject();
  for (const auto& [id, cell] : bucket.tools) {
    write_json_key(w, names.by_id[id]);
    w.StartArray();
    for (const uint64_t value : {cell.calls, cell.errors, cell.duration_ms_sum, cell.duration_ms_max, cell.rows, cell.bytes}) w.Uint64(value);
    w.EndArray();
  }
  w.EndObject();
  w.StartObject();
  for (const auto& [id, count] : bucket.results) {
    write_json_key(w, names.by_id[id]);
    w.Uint64(count);
  }
  w.EndObject();
  w.EndArray();
}

const std::vector<Usage::Bucket>& window_buckets(const Usage::Entry& entry, const McpUsageWindow& window) {
  return window.step == kHour ? entry.hours : entry.days;
}

bool in_window(const Usage::Bucket& bucket, const McpUsageWindow& window) {
  return bucket.start >= window.from && bucket.start < window.from + static_cast<int64_t>(window.points) * window.step;
}

Usage::Counters window_total(const Usage::Entry* entry, const McpUsageWindow& window) {
  Usage::Counters total;
  if (!entry) return total;
  for (const auto& bucket : window_buckets(*entry, window)) {
    if (in_window(bucket, window)) add_counters(total, bucket.total);
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

void put_average(McpJsonWriter& w, const char* name, uint64_t sum, uint64_t count) {
  w.Key(name);
  if (count == 0) w.Null();
  else w.Uint64((sum + count / 2) / count);
}

} // namespace

// ---- names, windows, text -------------------------------------------------------------------------

uint16_t McpUsage::Names::intern(std::string_view name) {
  const std::string text(name);
  if (const auto it = ids.find(text); it != ids.end()) return it->second;
  if (by_id.size() >= kMaxNames) return 0;
  const auto id = static_cast<uint16_t>(by_id.size());
  by_id.push_back(text);
  ids.emplace(text, id);
  return id;
}

McpUsageKeyRef mcp_usage_key_ref(const McpKey& key) {
  return McpUsageKeyRef{key.id, key.name, key.hosts.size() == 1 ? key.hosts.front() : std::string(), key.source};
}

std::vector<std::string> mcp_usage_windows(int64_t retention_days) {
  std::vector<std::string> out{"24h"};
  for (const int64_t days : {7, 30, 90, 365}) {
    if (days <= retention_days) out.push_back(std::to_string(days) + "d");
  }
  return out;
}

std::string mcp_usage_default_window(int64_t retention_days) { return retention_days >= 7 ? "7d" : "24h"; }

std::optional<McpUsageWindow> mcp_usage_window(std::string_view name, int64_t retention_days, int64_t now) {
  const auto names = mcp_usage_windows(retention_days);
  if (std::find(names.begin(), names.end(), name) == names.end()) return std::nullopt;
  McpUsageWindow window;
  window.name = std::string(name);
  if (name == "24h") {
    window.step = kHour;
    window.points = static_cast<size_t>(kHours);
    window.from = floor_to(now, kHour) - (kHours - 1) * kHour;
  } else {
    const int64_t days = std::stoll(std::string(name.substr(0, name.size() - 1)));
    window.step = kDay;
    window.points = static_cast<size_t>(days);
    window.from = floor_to(now, kDay) - (days - 1) * kDay;
  }
  return window;
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

  Recorded what;
  what.ok = event.status == "ok";
  what.count_result = event.kind == McpUsageKind::ToolCall || !what.ok;
  if (event.kind == McpUsageKind::ToolCall) what.tool = state_.names.intern(clean_name(event.tool));
  if (what.count_result) what.result = state_.names.intern(clean_name(event.status));
  const int64_t hour = floor_to(event.at, kHour);
  const int64_t day = floor_to(event.at, kDay);
  add_event(bucket_at(entry.hours, hour), event, what, &state_.cells, options_.max_cells);
  add_event(bucket_at(entry.days, day), event, what, &state_.cells, options_.max_cells);
  // The memory stays bounded between two saves.
  drop_before(entry.hours, floor_to(entry.hours.back().start, kHour) - (kHours - 1) * kHour, &state_.cells);
  drop_before(entry.days, entry.days.back().start - (options_.retention_days - 1) * kDay, &state_.cells);
  note_client(entry, event, options_.max_clients);
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
    for (const auto& bucket : oldest->second.hours) take_cells(&state_.cells, cells_of(bucket));
    for (const auto& bucket : oldest->second.days) take_cells(&state_.cells, cells_of(bucket));
    state_.entries.erase(oldest);
    --deleted;
    dirty_ = true;
  }
}

void McpUsage::prune_locked(int64_t now) {
  const int64_t first_hour = floor_to(now, kHour) - (kHours - 1) * kHour;
  const int64_t first_day = floor_to(now, kDay) - (options_.retention_days - 1) * kDay;
  for (auto it = state_.entries.begin(); it != state_.entries.end();) {
    Entry& entry = it->second;
    if (drop_before(entry.hours, first_hour, &state_.cells)) dirty_ = true;
    if (drop_before(entry.days, first_day, &state_.cells)) dirty_ = true;
    const size_t clients = entry.clients.size();
    entry.clients.erase(std::remove_if(entry.clients.begin(), entry.clients.end(), [&](const Client& c) { return c.last_seen < first_day; }),
                        entry.clients.end());
    if (entry.clients.size() != clients) dirty_ = true;
    // A deleted key whose usage is older than the retention is gone; a deleted key that was never used, after 2 hours.
    const bool used = entry.last_used != 0;
    if (entry.deleted_at != 0 && entry.days.empty() && (used || now - entry.deleted_at >= kTombstoneSeconds)) {
      for (const auto& bucket : entry.hours) take_cells(&state_.cells, cells_of(bucket));
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
  std::lock_guard<std::mutex> lock(mu_);
  w.StartObject();
  put_head(w, window, now, since_, persisted(), options_.retention_days);
  w.Key("keys");
  w.StartArray();
  std::unordered_set<std::string> listed;
  for (const auto& key : live) {
    listed.insert(key.id);
    const auto it = state_.entries.find(key.id);
    put_summary(w, key, it == state_.entries.end() ? nullptr : &it->second, 0, window);
  }
  std::vector<const Entry*> deleted;
  for (const auto& [id, entry] : state_.entries) {
    if (entry.deleted_at != 0 && !entry.days.empty() && !listed.count(id)) deleted.push_back(&entry);
  }
  std::sort(deleted.begin(), deleted.end(), [](const Entry* a, const Entry* b) {
    return a->deleted_at != b->deleted_at ? a->deleted_at > b->deleted_at : a->key.id < b->key.id;
  });
  for (const Entry* entry : deleted) put_summary(w, entry->key, entry, entry->deleted_at, window);
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

  const Counters total = window_total(entry, window);
  w.Key("totals");
  w.StartObject();
  w.Key("requests"); w.Uint64(total.requests);
  w.Key("calls"); w.Uint64(total.calls);
  w.Key("errors"); w.Uint64(total.errors);
  w.Key("rate_limited"); w.Uint64(total.rate_limited);
  w.Key("rejected"); w.Uint64(total.rejected);
  put_average(w, "duration_ms_avg", total.duration_ms_sum, total.calls);
  w.Key("duration_ms_max");
  if (total.calls == 0) w.Null();
  else w.Uint64(total.duration_ms_max);
  w.Key("rows"); w.Uint64(total.rows);
  w.Key("bytes"); w.Uint64(total.bytes);
  w.EndObject();

  // One point for each step of the window, from its start: a step without a bucket has no call.
  w.Key("series");
  w.StartObject();
  w.Key("step"); w.String(window.step == kHour ? "hour" : "day");
  w.Key("points");
  w.StartArray();
  static const std::vector<Bucket> kNone;
  const std::vector<Bucket>& buckets = entry ? window_buckets(*entry, window) : kNone;
  size_t next = 0;
  for (size_t i = 0; i < window.points; ++i) {
    const int64_t t = window.from + static_cast<int64_t>(i) * window.step;
    while (next < buckets.size() && buckets[next].start < t) ++next;
    const Counters* point = next < buckets.size() && buckets[next].start == t ? &buckets[next].total : nullptr;
    w.StartObject();
    w.Key("t"); put(w, mcp_iso_utc(t));
    w.Key("requests"); w.Uint64(point ? point->requests : 0);
    w.Key("calls"); w.Uint64(point ? point->calls : 0);
    w.Key("errors"); w.Uint64(point ? point->errors : 0);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  // The tools and the results of the window, the most frequent first.
  std::unordered_map<uint16_t, Cell> tools;
  std::unordered_map<uint16_t, uint64_t> results;
  for (const auto& bucket : buckets) {
    if (!in_window(bucket, window)) continue;
    for (const auto& [name, cell] : bucket.tools) add_cell(tools[name], cell);
    for (const auto& [name, count] : bucket.results) results[name] += count;
  }
  std::vector<std::pair<std::string, Cell>> tool_rows;
  for (const auto& [name, cell] : tools) tool_rows.emplace_back(state_.names.by_id[name], cell);
  std::sort(tool_rows.begin(), tool_rows.end(), [](const auto& a, const auto& b) {
    return a.second.calls != b.second.calls ? a.second.calls > b.second.calls : a.first < b.first;
  });
  w.Key("tools");
  w.StartArray();
  for (const auto& [name, cell] : tool_rows) {
    w.StartObject();
    w.Key("tool"); put(w, name);
    w.Key("calls"); w.Uint64(cell.calls);
    w.Key("errors"); w.Uint64(cell.errors);
    put_average(w, "duration_ms_avg", cell.duration_ms_sum, cell.calls);
    w.Key("duration_ms_max"); w.Uint64(cell.duration_ms_max);
    w.Key("rows"); w.Uint64(cell.rows);
    w.Key("bytes"); w.Uint64(cell.bytes);
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
  w.Key("hours");
  w.StartArray();
  for (const auto& bucket : entry.hours) put_bucket(w, bucket, state_.names);
  w.EndArray();
  w.Key("days");
  w.StartArray();
  for (const auto& bucket : entry.days) put_bucket(w, bucket, state_.names);
  w.EndArray();
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
