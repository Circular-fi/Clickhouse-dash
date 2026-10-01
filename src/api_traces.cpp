#include "server.hpp"
#include "time_util.hpp"

#include "api_error.hpp"
#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "otel_allowlist.hpp"

#include <clickhouse/client.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <iterator>
#include <memory>
#include <mutex>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>
#include <unordered_map>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace chdash {
namespace {

std::string quote_ident(std::string_view ident) {
  std::string out;
  out.reserve(ident.size() + 2);
  out.push_back('`');
  for (char ch : ident) {
    if (ch == '`') out += "``";
    else out.push_back(ch);
  }
  out.push_back('`');
  return out;
}

std::string quote_string(std::string_view value) {
  std::string out;
  out.reserve(value.size() + 2);
  out.push_back('\'');
  for (char ch : value) {
    if (ch == '\\') out += "\\\\";
    else if (ch == '\'') out += "\\'";
    else out.push_back(ch);
  }
  out.push_back('\'');
  return out;
}

std::string qualified(std::string_view database, std::string_view table) {
  return quote_ident(database) + "." + quote_ident(table);
}

const HostSpec* trace_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  std::string id;
  if (req.has_param("host_id")) id = req.get_param_value("host_id");
  if (id.empty() && cfg.hosts.size() == 1) id = cfg.hosts.front().id;
  if (host_id) *host_id = id;
  return id.empty() ? nullptr : find_host(cfg.hosts, id);
}

std::shared_ptr<clickhouse::Client> acquire_trace_client(
    const AppConfig& cfg,
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error) {
  if (host.system_uri.empty()) {
    if (error) *error = "Trace Explorer requires system credentials for the selected host.";
    return nullptr;
  }
  const std::string& uri = host.system_uri;
  const auto connect_timeout = std::chrono::seconds(5);
  const auto send_timeout = std::chrono::seconds(15);
  // Wide-window span aggregations (analytics, duration search) can spend tens
  // of seconds merging without sending a packet. The arguments are
  // (connect, receive, send): they used to be swapped, which made the receive
  // timeout 15 s and aborted such queries with "can't receive string data".
  const auto receive_timeout = std::chrono::seconds(60);
  return pool
      ? pool->acquire(uri, connect_timeout, receive_timeout, send_timeout, error)
      : make_client_from_uri(uri, connect_timeout, receive_timeout, send_timeout, error);
}

int int_param(const httplib::Request& req, const char* name, int fallback, int lo, int hi) {
  if (!req.has_param(name)) return fallback;
  try {
    long long value = std::stoll(req.get_param_value(name));
    return static_cast<int>(std::max<long long>(lo, std::min<long long>(hi, value)));
  } catch (...) {
    return fallback;
  }
}

double double_param(const httplib::Request& req, const char* name, double fallback, double lo, double hi) {
  if (!req.has_param(name)) return fallback;
  try {
    const double value = std::stod(req.get_param_value(name));
    if (!std::isfinite(value)) return fallback;
    return std::max(lo, std::min(hi, value));
  } catch (...) {
    return fallback;
  }
}

std::vector<std::string> split_us(std::string_view text) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != '\x1f') continue;
    if (i > start) out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

void write_string_array(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) w.String(value.c_str());
  w.EndArray();
}

// The ServiceName allowlist predicate is shared with the other OTel signals.
using otel::service_allowlist_predicate;
bool feature_param_rejected(const TraceSettings& cfg, const httplib::Request& req, std::string* message) {
  struct Check { const char* param; bool enabled; const char* label; };
  const Check checks[] = {
    {"service", cfg.features.service_filter, "service filter"},
    {"operation", cfg.features.operation_filter, "operation filter"},
    {"status", cfg.features.status_filter, "status filter"},
    {"service_not", cfg.features.service_filter, "service filter"},
    {"operation_not", cfg.features.operation_filter, "operation filter"},
    {"status_not", cfg.features.status_filter, "status filter"},
    {"min_duration_ms", cfg.features.duration_filter, "duration filter"},
    {"max_duration_ms", cfg.features.duration_filter, "duration filter"},
  };
  for (const auto& check : checks) {
    if (req.has_param(check.param) && !req.get_param_value(check.param).empty() && !check.enabled) {
      if (message) *message = std::string(check.label) + " is disabled by traces.features";
      return true;
    }
  }
  return false;
}


bool parse_i64_param(const httplib::Request& req, const char* name, int64_t* out) {
  if (!req.has_param(name) || req.get_param_value(name).empty()) return false;
  try {
    *out = std::stoll(req.get_param_value(name));
    return true;
  } catch (...) {
    return false;
  }
}

bool trace_time_range(const TraceSettings& cfg, const httplib::Request& req, int64_t* start_ms, int64_t* end_ms, std::string* error) {
  int64_t lo = 0, hi = 0;
  const bool has_lo = parse_i64_param(req, "start_ms", &lo);
  const bool has_hi = parse_i64_param(req, "end_ms", &hi);
  if (has_lo || has_hi) {
    if (!has_lo || !has_hi) {
      if (error) *error = "start_ms and end_ms must be provided together.";
      return false;
    }
  } else {
    const int lookback = int_param(req, "lookback_minutes", cfg.default_lookback_minutes, 1, cfg.max_lookback_minutes);
    const auto now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    hi = now_ms;
    lo = hi - static_cast<int64_t>(lookback) * 60 * 1000;
  }
  // Searches convert bounds to nanoseconds (int64 overflows after year 2262).
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  if (lo < 0 || hi <= lo || hi > kMaxTraceTimeMs) {
    if (error) *error = "Invalid trace time range.";
    return false;
  }
  const int64_t max_ms = static_cast<int64_t>(cfg.max_lookback_minutes) * 60 * 1000;
  if (hi - lo > max_ms) {
    if (error) *error = "Trace time range exceeds traces.max_lookback_minutes.";
    return false;
  }
  *start_ms = lo;
  *end_ms = hi;
  return true;
}

std::string trace_time_predicate(int64_t start_ms, int64_t end_ms) {
  return "Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND Timestamp <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")";
}

std::vector<std::string> repeated_param_values(const httplib::Request& req, std::string_view name) {
  std::vector<std::string> values;
  const auto range = req.params.equal_range(std::string(name));
  for (auto it = range.first; it != range.second; ++it) {
    if (!it->second.empty()) values.push_back(it->second);
  }
  std::sort(values.begin(), values.end());
  values.erase(std::unique(values.begin(), values.end()), values.end());
  return values;
}

std::string exact_values_predicate(std::string_view column, const std::vector<std::string>& values) {
  if (values.empty()) return {};
  if (values.size() == 1) return std::string(column) + " = " + quote_string(values.front());
  std::string out = std::string(column) + " IN (";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out += ", ";
    out += quote_string(values[i]);
  }
  out += ")";
  return out;
}

// --- Span filters -----------------------------------------------------------
// Every filter describes one span: a trace matches when at least one of its
// visible spans satisfies all of them (Jaeger's semantics). Values arrive as
// request parameters and only ever reach SQL through quote_string().
//
//   service / operation / status             column equals (repeated: any of)
//   service_not / operation_not / status_not column differs from every value
//   tag=[scope:]key=value                    attribute equals
//   tag_not=[scope:]key=value                attribute absent or different
//   tag_exists=[scope:]key / tag_missing=... attribute key present / absent
//
// scope is "span:" (SpanAttributes), "resource:" (ResourceAttributes) or none
// (either map). Different keys are ANDed; several `tag` values of one key
// match any of them (one attribute holds one value, so AND would never
// match), several `tag_not` values of one key exclude all of them.
// tag_scope + tag_key + tag_value is the older single-tag form of `tag`.
enum class TagOp { Eq, Ne, Exists, Missing };

struct TagFilter {
  std::string scope;  // "span", "resource" or "any"
  TagOp op = TagOp::Eq;
  std::string key;
  std::string value;
};

struct TraceFilterSpec {
  std::vector<std::string> services, operations, services_not, operations_not, status_not;
  std::string status;
  std::vector<TagFilter> tags;
  // Primary-key predicates only (ServiceName / SpanName, positive or negated):
  // these may use the broad HAVING countIf form (see filters_are_broad).
  bool key_only() const { return status.empty() && status_not.empty() && tags.empty(); }
};

constexpr size_t kMaxTagFilters = 32;
constexpr size_t kMaxTagKeyBytes = 512;
constexpr size_t kMaxTagValueBytes = 4096;

bool valid_status(std::string_view status) { return status == "Error" || status == "Ok" || status == "Unset"; }

// "[span:|resource:]rest": the attribute scope prefix of a tag parameter.
std::string split_tag_scope(std::string_view text, std::string_view* rest) {
  for (std::string_view scope : {std::string_view("span"), std::string_view("resource")}) {
    if (text.size() > scope.size() && text.substr(0, scope.size()) == scope && text[scope.size()] == ':') {
      *rest = text.substr(scope.size() + 1);
      return std::string(scope);
    }
  }
  *rest = text;
  return "any";
}

bool parse_trace_filters(const httplib::Request& req, TraceFilterSpec* spec, std::string* validation_error) {
  auto fail = [&](std::string message) {
    if (validation_error) *validation_error = std::move(message);
    return false;
  };
  spec->services = repeated_param_values(req, "service");
  spec->operations = repeated_param_values(req, "operation");
  spec->services_not = repeated_param_values(req, "service_not");
  spec->operations_not = repeated_param_values(req, "operation_not");
  spec->status_not = repeated_param_values(req, "status_not");
  spec->status = req.has_param("status") ? req.get_param_value("status") : std::string{};
  if (!spec->status.empty() && !valid_status(spec->status)) return fail("status must be Error, Ok, Unset, or empty.");
  for (const auto& status : spec->status_not) {
    if (!valid_status(status)) return fail("status_not must be Error, Ok or Unset.");
  }

  const std::string tag_scope = req.has_param("tag_scope") ? req.get_param_value("tag_scope") : std::string{};
  const std::string tag_key = req.has_param("tag_key") ? req.get_param_value("tag_key") : std::string{};
  const std::string tag_value = req.has_param("tag_value") ? req.get_param_value("tag_value") : std::string{};
  if ((!tag_key.empty() || !tag_value.empty()) && (tag_key.empty() || tag_value.empty())) {
    return fail("tag_key and tag_value must be provided together.");
  }
  if (!tag_key.empty() && tag_scope != "span" && tag_scope != "resource" && tag_scope != "any") {
    return fail("tag_scope must be span, resource, or any.");
  }
  if (!tag_key.empty()) spec->tags.push_back(TagFilter{tag_scope, TagOp::Eq, tag_key, tag_value});

  struct TagParam { const char* name; TagOp op; };
  for (const TagParam param : {TagParam{"tag", TagOp::Eq}, TagParam{"tag_not", TagOp::Ne},
                               TagParam{"tag_exists", TagOp::Exists}, TagParam{"tag_missing", TagOp::Missing}}) {
    for (const auto& raw : repeated_param_values(req, param.name)) {
      std::string_view rest;
      TagFilter tag;
      tag.scope = split_tag_scope(raw, &rest);
      tag.op = param.op;
      if (param.op == TagOp::Eq || param.op == TagOp::Ne) {
        const size_t eq = rest.find('=');
        if (eq == std::string_view::npos || eq == 0) {
          return fail(std::string(param.name) + " must be [span:|resource:]key=value.");
        }
        tag.key = std::string(rest.substr(0, eq));
        tag.value = std::string(rest.substr(eq + 1));
      } else {
        tag.key = std::string(rest);
      }
      if (tag.key.empty()) return fail(std::string(param.name) + " needs an attribute key.");
      spec->tags.push_back(std::move(tag));
    }
  }
  for (const auto& tag : spec->tags) {
    if (tag.key.size() > kMaxTagKeyBytes) return fail("Attribute keys are limited to 512 bytes.");
    if (tag.value.size() > kMaxTagValueBytes) return fail("Attribute values are limited to 4096 bytes.");
  }
  if (spec->tags.size() > kMaxTagFilters) return fail("At most 32 attribute filters are accepted.");
  return true;
}

// Which attribute maps tag filters and facets may read: stored as
// Map(String, String) (JSON columns are not supported) and enabled by
// traces.features (a hidden attribute scope must not become an oracle).
struct AttributeColumns {
  bool span_map = false, resource_map = false;
  bool span_enabled = true, resource_enabled = true;
  bool span() const { return span_map && span_enabled; }
  bool resource() const { return resource_map && resource_enabled; }
};

// One (scope, key) of the tag filters with all its conditions.
struct TagGroup {
  std::string scope, key;
  std::vector<std::string> eq, ne;
  bool exists = false, missing = false;
};

std::vector<TagGroup> group_tag_filters(const std::vector<TagFilter>& tags) {
  std::vector<TagGroup> groups;
  for (const auto& tag : tags) {
    auto it = std::find_if(groups.begin(), groups.end(), [&](const TagGroup& g) { return g.scope == tag.scope && g.key == tag.key; });
    if (it == groups.end()) it = groups.insert(groups.end(), TagGroup{tag.scope, tag.key, {}, {}, false, false});
    if (tag.op == TagOp::Eq) it->eq.push_back(tag.value);
    else if (tag.op == TagOp::Ne) it->ne.push_back(tag.value);
    else if (tag.op == TagOp::Exists) it->exists = true;
    else it->missing = true;
  }
  for (auto& group : groups) {
    for (auto* values : {&group.eq, &group.ne}) {
      std::sort(values->begin(), values->end());
      values->erase(std::unique(values->begin(), values->end()), values->end());
    }
  }
  return groups;
}

// (mapContains(C, 'k') AND C['k'] IN (...)): mapContains first, since a
// missing key reads as '' and must not match an empty value.
std::string map_values_predicate(const std::string& column, const std::string& key, const std::vector<std::string>& values) {
  return "(mapContains(" + column + ", " + quote_string(key) + ") AND " +
         exact_values_predicate(column + "[" + quote_string(key) + "]", values) + ")";
}

std::string any_of(const std::vector<std::string>& terms) {
  if (terms.size() == 1) return terms.front();
  std::string out = "(";
  for (size_t i = 0; i < terms.size(); ++i) out += (i ? " OR " : "") + terms[i];
  return out + ")";
}

// " AND ..." for the tag filters (skipping the group of `skip_scope` /
// `skip_key` when given: a facet's own values ignore its own filters), or
// false with an error code when a filter needs an attribute map that is not
// usable.
bool tag_filters_sql(const std::vector<TagFilter>& tags, const AttributeColumns& cols, std::string* out,
                     std::string* error_code, std::string* error, const std::string* skip_scope = nullptr,
                     const std::string* skip_key = nullptr) {
  for (const auto& group : group_tag_filters(tags)) {
    if (skip_key && group.key == *skip_key && (group.scope == "any" || group.scope == *skip_scope)) continue;
    std::vector<std::string> columns;
    const bool want_span = group.scope != "resource";
    const bool want_resource = group.scope != "span";
    if (want_span && cols.span()) columns.push_back("SpanAttributes");
    if (want_resource && cols.resource()) columns.push_back("ResourceAttributes");
    if (columns.empty() || (group.scope == "span" && !cols.span()) || (group.scope == "resource" && !cols.resource())) {
      const bool disabled = (group.scope == "span" && !cols.span_enabled) || (group.scope == "resource" && !cols.resource_enabled) ||
                            (group.scope == "any" && !cols.span_enabled && !cols.resource_enabled);
      *error_code = disabled ? "trace_filter_disabled" : "trace_tag_search_unsupported";
      *error = disabled ? "Attribute filters on this scope are disabled by traces.features."
                        : "Selected attribute scope is not stored as Map(String, String).";
      return false;
    }
    auto per_column = [&](auto make) {
      std::vector<std::string> terms;
      for (const auto& column : columns) terms.push_back(make(column));
      return any_of(terms);
    };
    const std::string key = quote_string(group.key);
    if (!group.eq.empty()) *out += " AND " + per_column([&](const std::string& c) { return map_values_predicate(c, group.key, group.eq); });
    if (!group.ne.empty()) *out += " AND NOT " + per_column([&](const std::string& c) { return map_values_predicate(c, group.key, group.ne); });
    if (group.exists) *out += " AND " + per_column([&](const std::string& c) { return "mapContains(" + c + ", " + key + ")"; });
    if (group.missing) *out += " AND NOT " + per_column([&](const std::string& c) { return "mapContains(" + c + ", " + key + ")"; });
  }
  return true;
}

// " AND ..." for the column filters followed by the tag SQL.
std::string span_filters_sql(const TraceFilterSpec& spec, const std::string& tags_sql) {
  std::vector<std::string> filters;
  if (!spec.services.empty()) filters.push_back(exact_values_predicate("ServiceName", spec.services));
  if (!spec.operations.empty()) filters.push_back(exact_values_predicate("SpanName", spec.operations));
  if (!spec.services_not.empty()) filters.push_back("NOT (" + exact_values_predicate("ServiceName", spec.services_not) + ")");
  if (!spec.operations_not.empty()) filters.push_back("NOT (" + exact_values_predicate("SpanName", spec.operations_not) + ")");
  if (!spec.status.empty()) filters.push_back("StatusCode = " + quote_string(spec.status));
  if (!spec.status_not.empty()) filters.push_back("NOT (" + exact_values_predicate("StatusCode", spec.status_not) + ")");
  std::string out;
  for (const auto& filter : filters) out += " AND " + filter;
  return out + tags_sql;
}

int choose_trace_bucket_seconds(int64_t range_ms) {
  // Aim for roughly 60 visible buckets. A one-hour range therefore has one bar per minute.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 60);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800, 1209600, 2592000};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

int choose_trace_quantile_bucket_seconds(int64_t range_ms) {
  // Keep latency quantiles denser than the count chart while retaining a one-minute floor.
  const int64_t desired = std::max<int64_t>(60, range_ms / 1000 / 120);
  const int candidates[] = {60, 120, 180, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800};
  for (int value : candidates) if (value >= desired) return value;
  return candidates[sizeof(candidates) / sizeof(candidates[0]) - 1];
}

std::vector<std::string> split_char(std::string_view text, char delimiter) {
  std::vector<std::string> out;
  size_t start = 0;
  for (size_t i = 0; i <= text.size(); ++i) {
    if (i != text.size() && text[i] != delimiter) continue;
    out.emplace_back(text.substr(start, i - start));
    start = i + 1;
  }
  return out;
}

bool trace_attribute_maps(clickhouse::Client& client, const TraceSettings& cfg, bool* span_map, bool* resource_map) {
  *span_map = false;
  *resource_map = false;
  try {
    client.Select(
        "SELECT toString(name), toString(type) FROM system.columns WHERE database = " + quote_string(cfg.database) +
        " AND `table` = " + quote_string(cfg.table) + " AND name IN ('SpanAttributes','ResourceAttributes')",
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            const std::string name = ch_block_text_at(block, 0, row);
            const std::string type = ch_block_text_at(block, 1, row);
            const bool map = type.rfind("Map(", 0) == 0;
            if (name == "SpanAttributes") *span_map = map;
            if (name == "ResourceAttributes") *resource_map = map;
          }
        });
    return true;
  } catch (...) {
    return false;
  }
}

// Tagged searches only need to know whether the attribute columns are Maps.
// That schema fact changes on DDL, not per request, so cache it per source
// (system URI + table) instead of querying system.columns on every search.
// /api/traces/meta always reads it fresh and refreshes the cache.
struct AttributeMapCacheEntry {
  bool span_map = false;
  bool resource_map = false;
  std::chrono::steady_clock::time_point loaded_at;
};
constexpr auto kAttributeMapCacheTtl = std::chrono::seconds(60);
std::mutex g_attribute_map_mutex;
std::unordered_map<std::string, AttributeMapCacheEntry> g_attribute_map_cache;

std::string attribute_map_cache_key(const HostSpec& host, const TraceSettings& cfg) {
  return host.system_uri + '\x1f' + cfg.database + '\x1f' + cfg.table;
}

void store_trace_attribute_maps(const HostSpec& host, const TraceSettings& cfg, bool span_map, bool resource_map) {
  std::lock_guard<std::mutex> lock(g_attribute_map_mutex);
  g_attribute_map_cache[attribute_map_cache_key(host, cfg)] =
      AttributeMapCacheEntry{span_map, resource_map, std::chrono::steady_clock::now()};
}

void cached_trace_attribute_maps(clickhouse::Client& client, const HostSpec& host, const TraceSettings& cfg,
                                 bool* span_map, bool* resource_map) {
  const std::string key = attribute_map_cache_key(host, cfg);
  {
    std::lock_guard<std::mutex> lock(g_attribute_map_mutex);
    const auto it = g_attribute_map_cache.find(key);
    if (it != g_attribute_map_cache.end() &&
        std::chrono::steady_clock::now() - it->second.loaded_at < kAttributeMapCacheTtl) {
      *span_map = it->second.span_map;
      *resource_map = it->second.resource_map;
      return;
    }
  }
  // Only successful lookups are cached; a transient failure is retried next time.
  if (trace_attribute_maps(client, cfg, span_map, resource_map)) {
    store_trace_attribute_maps(host, cfg, *span_map, *resource_map);
  }
}

AttributeColumns trace_attribute_columns(clickhouse::Client& client, const HostSpec& host, const TraceSettings& cfg) {
  AttributeColumns cols;
  cols.span_enabled = cfg.features.span_attributes;
  cols.resource_enabled = cfg.features.resource_attributes;
  cached_trace_attribute_maps(client, host, cfg, &cols.span_map, &cols.resource_map);
  return cols;
}

// The span filter SQL of a request (" AND ..." or empty), or false with an
// error code when a tag filter needs an unusable attribute map. The attribute
// schema is looked up (cached) only when tag filters are present.
bool trace_filters_sql(clickhouse::Client& client, const HostSpec& host, const TraceSettings& cfg,
                       const TraceFilterSpec& spec, std::string* out, std::string* error_code, std::string* error,
                       const std::string* skip_scope = nullptr, const std::string* skip_key = nullptr) {
  std::string tags;
  if (!spec.tags.empty()) {
    const AttributeColumns cols = trace_attribute_columns(client, host, cfg);
    if (!tag_filters_sql(spec.tags, cols, &tags, error_code, error, skip_scope, skip_key)) return false;
  }
  *out = span_filters_sql(spec, tags);
  return true;
}

// A SELECT whose work is capped by its SETTINGS (read limit / time budget):
// the progress packets tell whether it read every row it would have read
// (read_rows == total_rows_to_read) or stopped early (LIMIT, a read_overflow
// or timeout_overflow break), i.e. whether its answer is only an estimate.
// Both progress fields are per-packet deltas.
struct BoundedRead {
  uint64_t read_rows = 0;
  uint64_t total_rows = 0;
  uint64_t elapsed_ms = 0;
  bool partial() const { return read_rows < total_rows; }
};

BoundedRead bounded_select(clickhouse::Client& client, const std::string& sql,
                           const std::function<void(const clickhouse::Block&)>& on_block) {
  BoundedRead out;
  const auto started = std::chrono::steady_clock::now();
  clickhouse::Query query(sql);
  query.OnData(on_block);
  query.OnProgress([&](const clickhouse::Progress& progress) {
    out.read_rows += progress.rows;
    out.total_rows += progress.total_rows;
  });
  client.Execute(query);
  out.elapsed_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count());
  return out;
}

// Attribute discovery caps (after HyperDX's metadata queries): an inner LIMIT
// of sampled spans, a hard cap on the rows read from storage (a selective
// filter would otherwise scan the whole window looking for enough spans), a
// GROUP BY size cap for high-cardinality values and a time budget. The read
// cap breaks like an exhausted source, so the aggregation still answers from
// what was read; the time budget is a last resort (a timeout break may drop
// the partial aggregate) and is reported as an estimate as well.
constexpr uint64_t kFacetSampleRows = 3000000;
constexpr uint64_t kFacetReadRowsCap = 50000000;
constexpr uint64_t kFacetGroupByCap = 100000;
constexpr int kFacetTimeBudgetSeconds = 5;
constexpr uint64_t kTaggedPrefillReadRowsCap = 100000000;

std::string facet_settings_sql(uint64_t read_rows_cap, bool group_by_cap) {
  std::string out = " SETTINGS max_execution_time = " + std::to_string(kFacetTimeBudgetSeconds) +
      ", timeout_overflow_mode = 'break', max_rows_to_read = " + std::to_string(read_rows_cap) +
      ", read_overflow_mode = 'break'";
  if (group_by_cap) {
    out += ", max_rows_to_group_by = " + std::to_string(kFacetGroupByCap) + ", group_by_overflow_mode = 'any'";
  }
  return out;
}

bool timed_out(const BoundedRead& read) {
  return read.elapsed_ms + 250 >= static_cast<uint64_t>(kFacetTimeBudgetSeconds) * 1000;
}

struct TraceFacetKeys {
  struct Key { std::string scope, key; uint64_t count = 0; };
  std::vector<Key> keys;
  uint64_t sampled_spans = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};

struct TraceFacetValues {
  std::vector<std::pair<std::string, uint64_t>> values;
  uint64_t spans_with_key = 0;
  uint64_t distinct_values = 0;
  bool estimated = false;
  bool timed_out = false;
  uint64_t query_ms = 0;
};

StaleCache<std::string, TraceFacetKeys> g_trace_facet_keys_cache;
StaleCache<std::string, TraceFacetValues> g_trace_facet_values_cache;

constexpr int64_t kNsPerMs = 1000000;

std::string ns_time(int64_t ns) {
  return "fromUnixTimestamp64Nano(" + std::to_string(ns) + ")";
}

std::string trace_id_list_sql(const std::vector<std::string>& ids) {
  std::string out = "(";
  for (size_t i = 0; i < ids.size(); ++i) {
    if (i) out += ",";
    out += quote_string(ids[i]);
  }
  out += ")";
  return out;
}

// Walks the trace index newest-first in the order of
//   ORDER BY Start DESC LIMIT 1 BY TraceId
// over the whole search window, i.e. traces ranked by their newest in-window
// index row (ties at an identical Start are unordered, as in that query).
// Paging that query with OFFSET re-sorts the entire window for every page (a
// 7-day window reads ~25M index rows per page). The cursor instead walks
// disjoint Start slices [lo, hi] newest-first through prj_start and reads each
// slice *completely*, one row per trace (max(Start) GROUP BY TraceId), into a
// buffer that next() drains:
//   * slices never overlap, so equal Starts can never straddle a page seam
//     (no skipped or duplicated trace on ties);
//   * a trace appears at most once per slice however many index rows it has
//     (the OTel MV writes one row per insert batch), so long-lived traces cannot
//     multiply the number of queries;
//   * a trace whose newest row was in an earlier slice re-appears in later
//     slices only through older rows and is dropped via seen_.
// Slice width adapts to the observed density; a slice holding more than
// kSliceRowCap traces is halved and re-read, so memory and per-query cost stay
// bounded.
class TraceIndexCursor {
 public:
  struct Hit {
    std::string trace_id;
    int64_t start_ns = 0;
  };

  TraceIndexCursor(clickhouse::Client& client, std::string index_table, int64_t start_ms, int64_t end_ms)
      : client_(client),
        table_(std::move(index_table)),
        window_("Start >= fromUnixTimestamp64Milli(" + std::to_string(start_ms) + ") AND "
                "Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")"),
        lo_ns_(start_ms * kNsPerMs),
        hi_ns_(end_ms * kNsPerMs),
        slice_ns_(std::max<int64_t>(1, std::min<int64_t>(kInitialSliceNs, hi_ns_ - lo_ns_ + 1))) {}

  const std::string& window() const { return window_; }
  const std::string& table() const { return table_; }

  // Up to n not-yet-emitted traces in rank order; fewer only when the window
  // has no more traces.
  std::vector<Hit> next(size_t n) {
    std::vector<Hit> out;
    while (out.size() < n) {
      if (buffer_pos_ < buffer_.size()) {
        out.push_back(std::move(buffer_[buffer_pos_++]));
        continue;
      }
      if (exhausted_) break;
      fill(n - out.size());
    }
    return out;
  }

 private:
  static constexpr int64_t kInitialSliceNs = 60LL * 1000 * kNsPerMs;
  static constexpr size_t kSliceRowCap = 20000;

  // Read the next non-empty slice below hi_ns_ into buffer_ (or exhaust).
  void fill(size_t wanted) {
    buffer_.clear();
    buffer_pos_ = 0;
    while (buffer_.empty() && !exhausted_) {
      if (hi_ns_ < lo_ns_) {
        exhausted_ = true;
        return;
      }
      const int64_t lo = std::max(lo_ns_, hi_ns_ - slice_ns_ + 1);
      // toDateTime64(…, 9) accepts both DateTime and DateTime64 index schemas.
      const std::string sql =
          "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(toDateTime64(max(Start), 9))) FROM " + table_ +
          " PREWHERE " + window_ + " AND Start >= " + ns_time(lo) + " AND Start <= " + ns_time(hi_ns_) +
          " GROUP BY TraceId LIMIT " + std::to_string(kSliceRowCap + 1);
      std::vector<Hit> rows;
      client_.Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          rows.push_back(Hit{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row))});
        }
      });
      if (rows.size() > kSliceRowCap && slice_ns_ > 1) {
        // Too dense to read in one piece: re-read a narrower slice.
        slice_ns_ = std::max<int64_t>(1, slice_ns_ / 4);
        continue;
      }
      size_t fresh = 0;
      for (auto& row : rows) {
        if (!seen_.insert(row.trace_id).second) continue;
        buffer_.push_back(std::move(row));
        ++fresh;
      }
      std::sort(buffer_.begin(), buffer_.end(), [](const Hit& a, const Hit& b) {
        if (a.start_ns != b.start_ns) return a.start_ns > b.start_ns;
        return a.trace_id < b.trace_id;
      });
      if (lo <= lo_ns_) {
        exhausted_ = true;
      } else {
        hi_ns_ = lo - 1;
        // Aim the next slice at roughly the traces still wanted (x2 headroom),
        // growing at most 8x per step; empty slices grow 4x.
        double factor = 4.0;
        if (fresh > 0) {
          factor = std::min(8.0, std::max(0.5, 2.0 * static_cast<double>(std::max<size_t>(wanted, 1)) /
                                                    static_cast<double>(fresh)));
        }
        const double next = static_cast<double>(slice_ns_) * factor;
        const double remaining = static_cast<double>(hi_ns_ - lo_ns_ + 1);
        slice_ns_ = static_cast<int64_t>(std::max(1.0, std::min(next, remaining)));
      }
    }
  }

  clickhouse::Client& client_;
  std::string table_;
  std::string window_;
  int64_t lo_ns_ = 0;
  int64_t hi_ns_ = 0;
  int64_t slice_ns_ = 1;
  bool exhausted_ = false;
  std::vector<Hit> buffer_;
  size_t buffer_pos_ = 0;
  std::unordered_set<std::string> seen_;
};

// Span filters (service, operation, status, tags) select traces having at
// least one matching visible span. Two equivalent SQL forms exist:
//   narrow: TraceId IN (candidate_ids)   -- cheap when few traces match
//   broad:  HAVING countIf(filters) > 0  -- one pass, no giant IN set
// With a broad filter the IN set holds most traces of the window, and building
// and probing it costs more than the aggregation itself (24 h, one service:
// 6.5 s vs 3.7 s). Only primary-key filters (service / operation) are probed:
// their candidate scan is cheap, and a LIMIT stops it early when the filter
// is broad. Status and tag filters keep the narrow form.
constexpr double kBroadFilterShare = 0.25;

bool filters_are_broad(clickhouse::Client& client, const std::string& table, const std::string& index_table,
                       const std::string& time_predicate, const std::string& visibility,
                       const std::string& span_filters, int64_t start_ms, int64_t end_ms) {
  if (span_filters.empty() || index_table.empty()) return false;
  // Only a performance hint: any failure (e.g. a missing index table) keeps
  // the narrow form, which needs no index.
  try {
    uint64_t index_rows = 0;
    client.Select(
        "SELECT toString(count()) FROM " + index_table + " PREWHERE Start >= fromUnixTimestamp64Milli(" +
            std::to_string(start_ms) + ") AND Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) + ")",
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) index_rows = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
        });
    // Index rows >= traces (one row per insert batch), so the share is conservative.
    const uint64_t threshold =
        std::max<uint64_t>(1000, static_cast<uint64_t>(static_cast<double>(index_rows) * kBroadFilterShare));
    uint64_t matching = 0;
    client.Select(
        "SELECT toString(count()) FROM (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
            " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId LIMIT " + std::to_string(threshold) + ")",
        [&](const clickhouse::Block& block) {
          if (block.GetRowCount()) matching = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
        });
    return matching >= threshold;
  } catch (...) {
    return false;
  }
}

// " HAVING a AND b" -> "a AND b".
std::string having_terms(const std::string& having) {
  static const std::string kPrefix = " HAVING ";
  return having.rfind(kPrefix, 0) == 0 ? having.substr(kPrefix.size()) : having;
}

struct SpanRankQuery {
  std::string table;
  std::string time_predicate;
  std::string visibility;
  std::string span_filters;  // " AND ..." or empty
  std::string having;        // " HAVING ..." or empty
  bool broad_filters = false;  // evaluate span_filters as HAVING countIf(...) > 0
  int64_t start_ms = 0;
  int64_t end_ms = 0;
  size_t limit = 0;
};

struct RankedTrace {
  std::string trace_id;
  int64_t first_span_ns = 0;  // min(Timestamp) of its visible window spans
  // max(Timestamp + Duration) when a duration HAVING already aggregates it,
  // else 0 (unknown): an extra per-trace aggregate is not free on wide windows.
  int64_t span_end_ns = 0;
};

// Exact, newest-slice-first evaluation of
//   [WITH candidate_ids AS (spans matching the filters, LIMIT 1 BY TraceId)]
//   SELECT TraceId FROM spans PREWHERE window WHERE visibility [AND TraceId IN candidate_ids]
//   GROUP BY TraceId [HAVING duration] ORDER BY min(Timestamp) DESC LIMIT limit
// Aggregating every trace of a wide window only to keep the newest `limit` is
// the dominant cost of span-based search. A trace whose first visible window
// span is at or after t has all of its window spans in [t, end], so a query
// restricted to that slice computes exactly the same min/duration/filter
// match for it. Other traces seen in the slice ("straddlers") have visible
// spans before t; they rank below every trace starting at or after t, their
// slice aggregates are partial, and they are dropped after an IN-list
// existence probe on [start, t). When the slice yields `limit` exact traces
// they are the global answer; otherwise the slice widens, ending with the
// plain whole-window query.
std::vector<RankedTrace> rank_traces_by_start(clickhouse::Client& client, const SpanRankQuery& q) {
  const int64_t lo_ns = q.start_ms * kNsPerMs;
  const int64_t hi_ns = q.end_ms * kNsPerMs;
  const int64_t range_ns = hi_ns - lo_ns;
  constexpr int64_t kMinSliceNs = 5LL * 60 * 1000 * kNsPerMs;
  const bool has_filters = !q.span_filters.empty() && !q.broad_filters;
  std::string having = q.having;
  if (!q.span_filters.empty() && q.broad_filters) {
    having = " HAVING countIf(1" + q.span_filters + ") > 0" + (q.having.empty() ? std::string{} : " AND " + having_terms(q.having));
  }
  double fraction = range_ns > 16 * kMinSliceNs ? 1.0 / 16.0 : 1.0;
  size_t pad = 16;

  while (true) {
    const bool whole = fraction >= 1.0;
    const int64_t t = whole ? lo_ns : hi_ns - static_cast<int64_t>(static_cast<double>(range_ns) * fraction);
    const std::string slice = whole ? std::string{} : " AND Timestamp >= " + ns_time(t);
    const std::string candidates = has_filters
        ? "WITH candidate_ids AS (SELECT TraceId FROM " + q.table + " PREWHERE " + q.time_predicate + slice +
          " WHERE " + q.visibility + q.span_filters + " LIMIT 1 BY TraceId) "
        : std::string{};
    const std::string candidate_where = has_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};
    const size_t fetch = whole ? q.limit : q.limit + pad;
    // Same expression as the duration HAVING, so it is aggregated only once.
    const std::string span_end = q.having.empty()
        ? std::string("'0'")
        : std::string("toString(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration)))");
    const std::string sql = candidates +
        "SELECT toString(TraceId), toString(toUnixTimestamp64Nano(min(Timestamp))), " + span_end +
        " FROM " + q.table +
        " PREWHERE " + q.time_predicate + slice + " WHERE " + q.visibility + candidate_where +
        " GROUP BY TraceId" + having + " ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(fetch);
    std::vector<RankedTrace> rows;
    client.Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        rows.push_back(RankedTrace{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row)),
                                   std::stoll(ch_block_text_at(block, 2, row))});
      }
    });
    if (whole) return rows;

    std::unordered_set<std::string> straddlers;
    if (!rows.empty()) {
      std::vector<std::string> ids;
      ids.reserve(rows.size());
      for (const auto& row : rows) ids.push_back(row.trace_id);
      const std::string probe_sql =
          "SELECT DISTINCT toString(TraceId) FROM " + q.table + " PREWHERE " + q.time_predicate +
          " AND Timestamp < " + ns_time(t) + " WHERE " + q.visibility + " AND TraceId IN " + trace_id_list_sql(ids);
      client.Select(probe_sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) straddlers.insert(ch_block_text_at(block, 0, row));
      });
    }
    std::vector<RankedTrace> kept;
    for (auto& row : rows) {
      if (straddlers.count(row.trace_id) == 0) kept.push_back(std::move(row));
    }
    if (kept.size() >= q.limit) {
      kept.resize(q.limit);
      return kept;
    }
    if (rows.size() >= fetch && pad < 1024) {
      // Straddlers took result slots and the slice holds more traces.
      pad *= 4;
      continue;
    }
    // Widen from the observed density; an empty slice goes straight to the
    // whole window so sparse results cost at most one extra slice.
    fraction = kept.empty()
        ? fraction * 8.0
        : fraction * std::max(2.0, 1.5 * static_cast<double>(q.limit) / static_cast<double>(kept.size()));
    if (fraction > 0.4 || rows.size() >= fetch) fraction = 1.0;
    pad = 16;
  }
}

// Surrounding-context windows (± around the anchor span) offered by the span
// inspector; /api/traces/context accepts only these.
constexpr int64_t kContextWindowsMs[] = {1000, 10000, 60000, 300000};
constexpr size_t kLinkedFromLimit = 100;

// One span row of the linked-from and context answers.
struct SpanListRow {
  std::string timestamp, start_ns, trace_id, span_id, parent_span_id, name, kind, service, duration_ns, status;
  std::string link_span_ids, link_attributes;
};

const char* kSpanListColumns =
    "toString(Timestamp), toString(toUnixTimestamp64Nano(Timestamp)), toString(TraceId), toString(SpanId), "
    "toString(ParentSpanId), toString(SpanName), toString(SpanKind), toString(ServiceName), toString(Duration), "
    "toString(StatusCode)";

void select_span_rows(clickhouse::Client& client, const std::string& sql, std::vector<SpanListRow>* rows, bool with_links) {
  client.Select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      SpanListRow out;
      out.timestamp = ch_block_text_at(block, 0, row);
      out.start_ns = ch_block_text_at(block, 1, row);
      out.trace_id = ch_block_text_at(block, 2, row);
      out.span_id = ch_block_text_at(block, 3, row);
      out.parent_span_id = ch_block_text_at(block, 4, row);
      out.name = ch_block_text_at(block, 5, row);
      out.kind = ch_block_text_at(block, 6, row);
      out.service = ch_block_text_at(block, 7, row);
      out.duration_ns = ch_block_text_at(block, 8, row);
      out.status = ch_block_text_at(block, 9, row);
      if (with_links) {
        out.link_span_ids = ch_block_text_at(block, 10, row);
        out.link_attributes = ch_block_text_at(block, 11, row);
      }
      rows->push_back(std::move(out));
    }
  });
}

// start_ns is also sent as text: epoch nanoseconds pass 2^53, and the context
// keyset cursor must be exact.
void write_span_row(rapidjson::Writer<rapidjson::StringBuffer>& w, const SpanListRow& row, bool with_links) {
  w.StartObject();
  w.Key("timestamp"); w.String(row.timestamp.c_str());
  w.Key("start_ns"); w.Int64(std::stoll(row.start_ns));
  w.Key("start_ns_text"); w.String(row.start_ns.c_str());
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
  w.Key("trace_id"); w.String(row.trace_id.c_str());
  w.Key("span_id"); w.String(row.span_id.c_str());
  w.Key("parent_span_id"); w.String(row.parent_span_id.c_str());
  w.Key("span_name"); w.String(row.name.c_str());
  w.Key("span_kind"); w.String(row.kind.c_str());
  w.Key("service_name"); w.String(row.service.c_str());
  w.Key("status_code"); w.String(row.status.c_str());
  if (with_links) {
    w.Key("link_span_ids"); w.String(row.link_span_ids.c_str());
    w.Key("link_attributes"); w.String(row.link_attributes.c_str());
  }
  w.EndObject();
}

double elapsed_ms_since(std::chrono::steady_clock::time_point started) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
}

// --- Span search (/api/traces/spans) ----------------------------------------
// Newest-first spans matching the span filters (each span must match all of
// them), after HyperDX's row search (DBSearchPage, useOffsetPaginatedQuery,
// searchWindows) but paged by keyset instead of OFFSET:
//   * order: Timestamp DESC, SpanId DESC, TraceId DESC. (TraceId, SpanId)
//     is not unique (a span exported twice has two timestamps), so the key
//     starts with Timestamp; rows equal on all three columns stay on one page.
//   * slices: a page reads [lo, upper] time slices newest-first (15 min, 1 h,
//     6 h, 24 h, then 24 h again) until it holds `limit` spans. A top-N over a
//     slice reads about every row the slice holds, so a dense range answers
//     from its first slice and a sparse filter widens. Each slice is sized from
//     the cost seen so far to keep the page within kSpanPageBudgetMs; once the
//     budget is spent the page stops with a resume cursor at the slice
//     boundary (incomplete) instead of widening further.
//   * cursor "1.<ts_ns>.<slice_ns>.<k|b>.<hex SpanId>.<hex TraceId>": k = the
//     spans after the row key (ts, SpanId, TraceId); b = every span at or
//     before ts (a slice boundary). slice_ns is the width the next page
//     starts with.
constexpr int kSpanPageDefaultLimit = 100;
constexpr int kSpanPageMaxLimit = 500;
constexpr int64_t kNsPerMinute = 60LL * 1000 * kNsPerMs;
constexpr int64_t kSpanSlicesNs[] = {15 * kNsPerMinute, 60 * kNsPerMinute, 360 * kNsPerMinute, 1440 * kNsPerMinute};
constexpr int64_t kSpanMinSliceNs = kNsPerMinute;
constexpr double kSpanPageBudgetMs = 2000.0;
// Per-slice guards: a slice that would read more rows, or run longer, fails
// (throw mode, so a truncated top-N is never returned as a page).
constexpr int kSpanSliceTimeoutSeconds = 20;
constexpr uint64_t kSpanSliceReadRowsCap = 1000000000ULL;
constexpr size_t kSpanColumnsMax = 20;
constexpr size_t kSpanKindsMax = 16;

struct SpanCursor {
  bool present = false;
  int64_t ts_ns = 0;
  int64_t slice_ns = 0;
  bool after_key = false;  // k: after (ts, span_id, trace_id); b: Timestamp <= ts
  std::string span_id, trace_id;
};

std::string hex_text(std::string_view raw) {
  static const char* digits = "0123456789abcdef";
  std::string out;
  out.reserve(raw.size() * 2);
  for (unsigned char ch : raw) {
    out.push_back(digits[ch >> 4]);
    out.push_back(digits[ch & 15]);
  }
  return out;
}

bool unhex_text(std::string_view hex, std::string* out) {
  if (hex.size() % 2) return false;
  auto nibble = [](char ch) -> int {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
  };
  out->clear();
  for (size_t i = 0; i < hex.size(); i += 2) {
    const int hi = nibble(hex[i]), lo = nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out->push_back(static_cast<char>(hi * 16 + lo));
  }
  return true;
}

std::string encode_span_cursor(const SpanCursor& c) {
  return "1." + std::to_string(c.ts_ns) + "." + std::to_string(c.slice_ns) + "." + (c.after_key ? "k" : "b") + "." +
         hex_text(c.span_id) + "." + hex_text(c.trace_id);
}

bool decode_span_cursor(std::string_view text, SpanCursor* out) {
  if (text.size() > 2048) return false;
  const auto parts = split_char(text, '.');
  if (parts.size() != 6 || parts[0] != "1" || (parts[3] != "k" && parts[3] != "b")) return false;
  try {
    size_t used = 0;
    out->ts_ns = std::stoll(parts[1], &used);
    if (used != parts[1].size()) return false;
    out->slice_ns = std::stoll(parts[2], &used);
    if (used != parts[2].size()) return false;
  } catch (...) {
    return false;
  }
  out->after_key = parts[3] == "k";
  if (!unhex_text(parts[4], &out->span_id) || !unhex_text(parts[5], &out->trace_id)) return false;
  if (out->ts_ns < 0 || out->slice_ns < 0) return false;
  out->present = true;
  return true;
}

// columns=span:http.route,resource:host.name,key: attribute values returned
// with each span (scope "any" reads the span map first).
struct SpanAttributeColumn {
  std::string scope, key;
};

bool parse_span_columns(const httplib::Request& req, std::vector<SpanAttributeColumn>* out, std::string* error) {
  for (const auto& raw : repeated_param_values(req, "columns")) {
    for (const auto& item : split_char(raw, ',')) {
      if (item.empty()) continue;
      std::string_view rest;
      SpanAttributeColumn column;
      column.scope = split_tag_scope(item, &rest);
      column.key = std::string(rest);
      if (column.key.empty() || column.key.size() > kMaxTagKeyBytes) {
        *error = "columns entries must be [span:|resource:]key with a 1 to 512 byte key.";
        return false;
      }
      const bool seen = std::any_of(out->begin(), out->end(), [&](const SpanAttributeColumn& other) {
        return other.scope == column.scope && other.key == column.key;
      });
      if (!seen) out->push_back(std::move(column));
    }
  }
  if (out->size() > kSpanColumnsMax) {
    *error = "At most 20 attribute columns are accepted.";
    return false;
  }
  return true;
}

// ", toString(has), toString(value)" for each attribute column, or false when
// a column needs an attribute map that is unusable (same rules as filters).
bool span_columns_sql(const std::vector<SpanAttributeColumn>& columns, const AttributeColumns& cols, std::string* out,
                      std::string* error_code, std::string* error) {
  for (const auto& column : columns) {
    std::vector<std::string> maps;
    if (column.scope != "resource" && cols.span()) maps.push_back("SpanAttributes");
    if (column.scope != "span" && cols.resource()) maps.push_back("ResourceAttributes");
    if (maps.empty() || (column.scope == "span" && !cols.span()) || (column.scope == "resource" && !cols.resource())) {
      const bool disabled = (column.scope == "span" && !cols.span_enabled) ||
                            (column.scope == "resource" && !cols.resource_enabled) ||
                            (column.scope == "any" && !cols.span_enabled && !cols.resource_enabled);
      *error_code = disabled ? "trace_filter_disabled" : "trace_tag_search_unsupported";
      *error = disabled ? "Attribute columns on this scope are disabled by traces.features."
                        : "Selected attribute scope is not stored as Map(String, String).";
      return false;
    }
    const std::string key = quote_string(column.key);
    const std::string has0 = "mapContains(" + maps[0] + ", " + key + ")";
    if (maps.size() == 1) {
      *out += ", toString(toUInt8(" + has0 + ")), toString(" + maps[0] + "[" + key + "])";
    } else {
      const std::string has1 = "mapContains(" + maps[1] + ", " + key + ")";
      *out += ", toString(toUInt8(" + has0 + " OR " + has1 + ")), toString(if(" + has0 + ", " + maps[0] + "[" + key +
              "], " + maps[1] + "[" + key + "]))";
    }
  }
  return true;
}

struct SpanSearchRow {
  std::string timestamp, start_ns, trace_id, span_id, parent_span_id, service, name, kind, duration_ns, status, status_message;
  std::vector<std::pair<bool, std::string>> attributes;
  bool same_key(const SpanSearchRow& other) const {
    return start_ns == other.start_ns && span_id == other.span_id && trace_id == other.trace_id;
  }
};

const char* kSpanSearchColumns =
    "toString(Timestamp), toString(toUnixTimestamp64Nano(Timestamp)), toString(TraceId), toString(SpanId), "
    "toString(ParentSpanId), toString(ServiceName), toString(SpanName), toString(SpanKind), toString(Duration), "
    "toString(StatusCode), toString(StatusMessage)";

void select_span_search_rows(clickhouse::Client& client, const std::string& sql, size_t attribute_count,
                             std::vector<SpanSearchRow>* rows) {
  client.Select(sql, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      SpanSearchRow out;
      out.timestamp = ch_block_text_at(block, 0, row);
      out.start_ns = ch_block_text_at(block, 1, row);
      out.trace_id = ch_block_text_at(block, 2, row);
      out.span_id = ch_block_text_at(block, 3, row);
      out.parent_span_id = ch_block_text_at(block, 4, row);
      out.service = ch_block_text_at(block, 5, row);
      out.name = ch_block_text_at(block, 6, row);
      out.kind = ch_block_text_at(block, 7, row);
      out.duration_ns = ch_block_text_at(block, 8, row);
      out.status = ch_block_text_at(block, 9, row);
      out.status_message = ch_block_text_at(block, 10, row);
      for (size_t i = 0; i < attribute_count; ++i) {
        out.attributes.emplace_back(ch_block_text_at(block, 11 + 2 * i, row) == "1", ch_block_text_at(block, 12 + 2 * i, row));
      }
      rows->push_back(std::move(out));
    }
  });
}

// The next slice width of the sequence after `width` (24 h repeats).
int64_t next_span_slice_ns(int64_t width) {
  for (int64_t candidate : kSpanSlicesNs) {
    if (candidate > width) return candidate;
  }
  return kSpanSlicesNs[std::size(kSpanSlicesNs) - 1];
}

bool slice_guard_error(const clickhouse::ServerException& e) {
  // TOO_MANY_ROWS (158), TIMEOUT_EXCEEDED (159).
  return e.GetCode() == 158 || e.GetCode() == 159;
}

} // namespace

void Server::handle_traces_meta(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::set<std::string> columns;
  bool schema_ok = false;
  bool index_available = false;
  bool span_attribute_map = false;
  bool resource_attribute_map = false;
  try {
    const std::string db = quote_string(cfg_.traces.database);
    const std::string table = quote_string(cfg_.traces.table);
    client->Select(
        "SELECT toString(name) FROM system.columns WHERE database = " + db + " AND `table` = " + table,
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) columns.insert(ch_block_text_at(block, 0, row));
        });
    const char* required[] = {"Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "ServiceName", "Duration", "StatusCode"};
    schema_ok = std::all_of(std::begin(required), std::end(required), [&](const char* name) { return columns.count(name) != 0; });

    if (!cfg_.traces.trace_index_table.empty()) {
      uint64_t count = 0;
      client->Select(
          "SELECT toString(count()) FROM system.tables WHERE database = " + db +
          " AND name = " + quote_string(cfg_.traces.trace_index_table),
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
          });
      index_available = count > 0;
    }
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_schema_failed", e.what());
  }

  if (trace_attribute_maps(*client, cfg_.traces, &span_attribute_map, &resource_attribute_map)) {
    store_trace_attribute_maps(*host, cfg_.traces, span_attribute_map, resource_attribute_map);
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("analytics_enabled"); w.Bool(cfg_.traces.analytics);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("database"); w.String(cfg_.traces.database.c_str());
  w.Key("table"); w.String(cfg_.traces.table.c_str());
  w.Key("trace_index_table"); w.String(cfg_.traces.trace_index_table.c_str());
  w.Key("trace_index_available"); w.Bool(index_available);
  w.Key("schema_ok"); w.Bool(schema_ok);
  w.Key("default_lookback_minutes"); w.Int(cfg_.traces.default_lookback_minutes);
  w.Key("max_lookback_minutes"); w.Int(cfg_.traces.max_lookback_minutes);
  w.Key("search_limit"); w.Uint64(cfg_.traces.search_limit);
  w.Key("max_spans_per_trace"); w.Uint64(cfg_.traces.max_spans_per_trace);
  w.Key("tag_search_supported"); w.Bool(span_attribute_map || resource_attribute_map);
  w.Key("span_attribute_map"); w.Bool(span_attribute_map);
  w.Key("resource_attribute_map"); w.Bool(resource_attribute_map);
  w.Key("highlighted_attributes"); write_string_array(w, cfg_.traces.highlighted_attributes);
  w.Key("linked_from_margin_minutes"); w.Int(cfg_.traces.linked_from_margin_minutes);
  w.Key("context_windows_ms"); w.StartArray();
  for (int64_t window : kContextWindowsMs) w.Int64(window);
  w.EndArray();
  w.Key("features");
  w.StartObject();
  w.Key("service_filter"); w.Bool(cfg_.traces.features.service_filter);
  w.Key("operation_filter"); w.Bool(cfg_.traces.features.operation_filter);
  w.Key("status_filter"); w.Bool(cfg_.traces.features.status_filter);
  w.Key("duration_filter"); w.Bool(cfg_.traces.features.duration_filter);
  w.Key("resource_attributes"); w.Bool(cfg_.traces.features.resource_attributes);
  w.Key("span_attributes"); w.Bool(cfg_.traces.features.span_attributes);
  w.Key("events"); w.Bool(cfg_.traces.features.events);
  w.Key("links"); w.Bool(cfg_.traces.features.links);
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_prefill(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  // Minute-aligned superset of the requested range: the list only feeds the
  // service/operation pickers, and alignment lets "last N minutes" requests
  // made within the same minute (reloads, range toggles) share one scan.
  constexpr int64_t kPrefillAlignMs = 60 * 1000;
  constexpr uint64_t kPrefillTtlMs = 60 * 1000;
  const int64_t aligned_start_ms = (start_ms / kPrefillAlignMs) * kPrefillAlignMs;
  const int64_t aligned_end_ms = ((end_ms + kPrefillAlignMs - 1) / kPrefillAlignMs) * kPrefillAlignMs;
  // Only the tag filters narrow the picker lists (service / operation /
  // status choices must stay selectable). A tagged prefill reads attribute
  // maps, so its scan is capped (kTaggedPrefillReadRowsCap) and reported as
  // an estimate when the cap stopped it.
  TraceFilterSpec filters;
  std::string validation_error;
  if (!parse_trace_filters(req, &filters, &validation_error)) return json_error(res, 400, "invalid_trace_filter", validation_error);
  std::string tag_filters;
  if (!filters.tags.empty()) {
    std::string error;
    auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
    if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    std::string filter_code, filter_error;
    if (!tag_filters_sql(filters.tags, trace_attribute_columns(*client, *host, cfg_.traces), &tag_filters, &filter_code, &filter_error)) {
      return json_error(res, 400, filter_code, filter_error);
    }
  }
  const std::string cache_key = source_host_id + '\0' + std::to_string(aligned_start_ms) + '\0' +
      std::to_string(aligned_end_ms) + '\0' + tag_filters;
  const size_t hard_limit = 20000;

  auto cached = trace_prefill_cache_.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kPrefillTtlMs, 5000,
      [&](TracePrefill& value, std::string& code, std::string& message) {
        std::string error;
        auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
        if (!client) {
          code = "trace_source_unavailable";
          message = error.empty() ? "Cannot connect to trace ClickHouse source." : error;
          return false;
        }
        const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
        const std::string visibility = service_allowlist_predicate(cfg_.traces);
        const std::string time_predicate = trace_time_predicate(aligned_start_ms, aligned_end_ms);
        try {
          // Discovery only needs existence. Counting every span per service/operation pair
          // turns a cheap dictionary prefill into a large aggregation on busy trace tables.
          const std::string sql =
              "SELECT toString(ServiceName), toString(SpanName) FROM " + table +
              " PREWHERE " + time_predicate + " WHERE " + visibility + tag_filters +
              " LIMIT 1 BY ServiceName, SpanName LIMIT " + std::to_string(hard_limit + 1) +
              (tag_filters.empty() ? std::string{} : facet_settings_sql(kTaggedPrefillReadRowsCap, false));
          const BoundedRead read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.pairs.emplace_back(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
            }
          });
          value.estimated = !tag_filters.empty() && (read.partial() || timed_out(read));
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(client);
          code = "trace_prefill_failed";
          message = e.what();
          return false;
        }
        std::sort(value.pairs.begin(), value.pairs.end());
        value.truncated = value.pairs.size() > hard_limit;
        if (value.truncated) value.pairs.resize(hard_limit);
        value.start_ms = aligned_start_ms;
        value.end_ms = aligned_end_ms;
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "trace_prefill_failed" : cached.error_code,
                      cached.error_message.empty() ? "Trace prefill failed." : cached.error_message);
  }
  const bool truncated = cached.value->truncated;
  const auto& pairs = cached.value->pairs;

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("truncated"); w.Bool(truncated);
  w.Key("tag_filtered"); w.Bool(!tag_filters.empty());
  w.Key("estimated"); w.Bool(cached.value->estimated);
  w.Key("pairs"); w.StartArray();
  for (const auto& [service, operation] : pairs) {
    // The count column is kept for payload compatibility (existence only).
    w.StartArray(); w.String(service.c_str()); w.String(operation.c_str()); w.Uint64(1); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

namespace {

// Shared front half of /api/traces/facets and /api/traces/facet_values: the
// window (minute-aligned like prefill, so requests made within the same minute
// share one cached scan), the filters and the usable attribute maps.
struct FacetScope {
  std::string source_host_id;
  const HostSpec* host = nullptr;
  int64_t start_ms = 0, end_ms = 0;
  int64_t aligned_start_ms = 0, aligned_end_ms = 0;
  TraceFilterSpec filters;
  AttributeColumns columns;
};

constexpr uint64_t kFacetTtlMs = 60 * 1000;
constexpr size_t kFacetMaxKeys = 500;
constexpr int kFacetMaxValues = 500;

bool facet_scope(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool, const httplib::Request& req,
                 httplib::Response& res, FacetScope* scope, std::shared_ptr<clickhouse::Client>* client) {
  if (!cfg.traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled."); return false; }
  std::string disabled_message;
  if (feature_param_rejected(cfg.traces, req, &disabled_message)) {
    json_error(res, 400, "trace_filter_disabled", disabled_message);
    return false;
  }
  scope->host = trace_host(cfg, req, &scope->source_host_id);
  if (!scope->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  std::string error;
  if (!trace_time_range(cfg.traces, req, &scope->start_ms, &scope->end_ms, &error)) {
    json_error(res, 400, "invalid_trace_range", error);
    return false;
  }
  constexpr int64_t kAlignMs = 60 * 1000;
  scope->aligned_start_ms = (scope->start_ms / kAlignMs) * kAlignMs;
  scope->aligned_end_ms = ((scope->end_ms + kAlignMs - 1) / kAlignMs) * kAlignMs;
  if (!parse_trace_filters(req, &scope->filters, &error)) {
    json_error(res, 400, "invalid_trace_filter", error);
    return false;
  }
  *client = acquire_trace_client(cfg, *scope->host, pool, &error);
  if (!*client) {
    json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    return false;
  }
  scope->columns = trace_attribute_columns(**client, *scope->host, cfg.traces);
  return true;
}

void write_facet_common(rapidjson::Writer<rapidjson::StringBuffer>& w, const FacetScope& scope, bool estimated,
                        bool timed_out_flag, uint64_t query_ms, bool cached) {
  w.Key("range"); w.StartArray(); w.Int64(scope.start_ms); w.Int64(scope.end_ms); w.EndArray();
  w.Key("scanned_range"); w.StartArray(); w.Int64(scope.aligned_start_ms); w.Int64(scope.aligned_end_ms); w.EndArray();
  w.Key("estimated"); w.Bool(estimated);
  w.Key("timed_out"); w.Bool(timed_out_flag);
  w.Key("sample_limit"); w.Uint64(kFacetSampleRows);
  w.Key("read_rows_limit"); w.Uint64(kFacetReadRowsCap);
  w.Key("cached"); w.Bool(cached);
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(query_ms); w.EndObject();
}

} // namespace

// Top attribute keys (span + resource) of the spans matching the filters, by
// the number of sampled spans carrying them. One capped pass reads only the
// maps' key subcolumns.
void Server::handle_traces_facets(const httplib::Request& req, httplib::Response& res) {
  FacetScope scope;
  std::shared_ptr<clickhouse::Client> client;
  if (!facet_scope(cfg_, client_pool_, req, res, &scope, &client)) return;
  std::string span_filters, filter_code, filter_error;
  if (!trace_filters_sql(*client, *scope.host, cfg_.traces, scope.filters, &span_filters, &filter_code, &filter_error)) {
    return json_error(res, 400, filter_code, filter_error);
  }
  const bool span = scope.columns.span();
  const bool resource = scope.columns.resource();
  const std::string cache_key = scope.source_host_id + '\0' + std::to_string(scope.aligned_start_ms) + '\0' +
      std::to_string(scope.aligned_end_ms) + '\0' + (span ? "s" : "") + (resource ? "r" : "") + '\0' + span_filters;
  bool fetched = false;
  auto cached = g_trace_facet_keys_cache.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kFacetTtlMs, 5000,
      [&](TraceFacetKeys& value, std::string& code, std::string& message) {
        fetched = true;
        if (!span && !resource) return true;
        const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
        const std::string ones = "arrayResize([toUInt64(1)], length(%), toUInt64(1))";
        auto sum_map = [&](const std::string& column) {
          std::string counts = ones;
          counts.replace(counts.find('%'), 1, column);
          return "sumMap(" + column + ", " + counts + ")";
        };
        std::vector<std::string> inner_columns, aggregates, tuples;
        if (span) {
          inner_columns.push_back("SpanAttributes.keys AS sk");
          aggregates.push_back(sum_map("sk") + " AS sm");
          tuples.push_back("arrayMap((k, c) -> tuple('span', toString(k), c), sm.1, sm.2)");
        }
        if (resource) {
          inner_columns.push_back("ResourceAttributes.keys AS rk");
          aggregates.push_back(sum_map("rk") + " AS rm");
          tuples.push_back("arrayMap((k, c) -> tuple('resource', toString(k), c), rm.1, rm.2)");
        }
        auto join = [](const std::vector<std::string>& parts) {
          std::string out;
          for (size_t i = 0; i < parts.size(); ++i) out += (i ? ", " : "") + parts[i];
          return out;
        };
        const std::string sql =
            "SELECT toString(sampled), toString(t.1), toString(t.2), toString(t.3) FROM ("
            "SELECT count() AS sampled, " + join(aggregates) + " FROM ("
            "SELECT " + join(inner_columns) + " FROM " + table +
            " PREWHERE " + trace_time_predicate(scope.aligned_start_ms, scope.aligned_end_ms) +
            " WHERE " + service_allowlist_predicate(cfg_.traces) + span_filters +
            " LIMIT " + std::to_string(kFacetSampleRows) + ")) LEFT ARRAY JOIN arrayConcat(" + join(tuples) + ") AS t" +
            facet_settings_sql(kFacetReadRowsCap, false);
        try {
          const BoundedRead read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.sampled_spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, row)));
              const std::string key_scope = ch_block_text_at(block, 1, row);
              if (key_scope.empty()) continue;
              value.keys.push_back(TraceFacetKeys::Key{key_scope, ch_block_text_at(block, 2, row),
                                                       static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)))});
            }
          });
          value.timed_out = timed_out(read);
          value.estimated = read.partial() || value.timed_out;
          value.query_ms = read.elapsed_ms;
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(client);
          code = "trace_facets_failed";
          message = e.what();
          return false;
        }
        std::sort(value.keys.begin(), value.keys.end(), [](const TraceFacetKeys::Key& a, const TraceFacetKeys::Key& b) {
          if (a.count != b.count) return a.count > b.count;
          if (a.key != b.key) return a.key < b.key;
          return a.scope > b.scope;  // span before resource
        });
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "trace_facets_failed" : cached.error_code,
                      cached.error_message.empty() ? "Trace attribute discovery failed." : cached.error_message);
  }
  const auto& value = *cached.value;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("supported"); w.Bool(span || resource);
  w.Key("scopes"); w.StartArray(); if (span) w.String("span"); if (resource) w.String("resource"); w.EndArray();
  write_facet_common(w, scope, value.estimated, value.timed_out, value.query_ms, !fetched);
  w.Key("sampled_spans"); w.Uint64(value.sampled_spans);
  w.Key("truncated"); w.Bool(value.keys.size() > kFacetMaxKeys);
  w.Key("keys"); w.StartArray();
  for (size_t i = 0; i < value.keys.size() && i < kFacetMaxKeys; ++i) {
    const auto& key = value.keys[i];
    w.StartArray(); w.String(key.scope.c_str()); w.String(key.key.c_str()); w.Uint64(key.count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// Top values of one attribute key with their sampled span counts. The key's
// own filters are left out, so its other values stay visible (and can be
// added: several values of one key match any of them).
void Server::handle_traces_facet_values(const httplib::Request& req, httplib::Response& res) {
  FacetScope scope;
  std::shared_ptr<clickhouse::Client> client;
  const std::string key_scope = req.has_param("scope") ? req.get_param_value("scope") : std::string{};
  const std::string key = req.has_param("key") ? req.get_param_value("key") : std::string{};
  if (key_scope != "span" && key_scope != "resource") return json_error(res, 400, "invalid_trace_facet", "scope must be span or resource.");
  if (key.empty() || key.size() > kMaxTagKeyBytes) return json_error(res, 400, "invalid_trace_facet", "key must be 1 to 512 bytes.");
  const int limit = int_param(req, "limit", 10, 1, kFacetMaxValues);
  if (!facet_scope(cfg_, client_pool_, req, res, &scope, &client)) return;
  if (key_scope == "span" ? !scope.columns.span() : !scope.columns.resource()) {
    const bool disabled = key_scope == "span" ? !scope.columns.span_enabled : !scope.columns.resource_enabled;
    return json_error(res, 400, disabled ? "trace_filter_disabled" : "trace_tag_search_unsupported",
                      disabled ? "Attribute filters on this scope are disabled by traces.features."
                               : "Selected attribute scope is not stored as Map(String, String).");
  }
  std::string span_filters, filter_code, filter_error;
  if (!trace_filters_sql(*client, *scope.host, cfg_.traces, scope.filters, &span_filters, &filter_code, &filter_error,
                         &key_scope, &key)) {
    return json_error(res, 400, filter_code, filter_error);
  }
  const std::string cache_key = scope.source_host_id + '\0' + std::to_string(scope.aligned_start_ms) + '\0' +
      std::to_string(scope.aligned_end_ms) + '\0' + key_scope + '\0' + key + '\0' + std::to_string(limit) + '\0' + span_filters;
  bool fetched = false;
  auto cached = g_trace_facet_values_cache.get_or_refresh(
      cache_key, static_cast<uint64_t>(now_ms()), kFacetTtlMs, 5000,
      [&](TraceFacetValues& value, std::string& code, std::string& message) {
        fetched = true;
        const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
        const std::string column = key_scope == "span" ? "SpanAttributes" : "ResourceAttributes";
        const std::string sql =
            "SELECT toString(v), toString(c), toString(sum(c) OVER ()), toString(count() OVER ()) FROM ("
            "SELECT v, count() AS c FROM ("
            "SELECT " + column + "[" + quote_string(key) + "] AS v FROM " + table +
            " PREWHERE " + trace_time_predicate(scope.aligned_start_ms, scope.aligned_end_ms) +
            " WHERE " + service_allowlist_predicate(cfg_.traces) + " AND mapContains(" + column + ", " + quote_string(key) + ")" +
            span_filters + " LIMIT " + std::to_string(kFacetSampleRows) + ") GROUP BY v) "
            "ORDER BY c DESC, v LIMIT " + std::to_string(limit) + facet_settings_sql(kFacetReadRowsCap, true);
        try {
          const BoundedRead read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.values.emplace_back(ch_block_text_at(block, 0, row),
                                        static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row))));
              value.spans_with_key = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
              value.distinct_values = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)));
            }
          });
          value.timed_out = timed_out(read);
          value.estimated = read.partial() || value.timed_out || value.distinct_values >= kFacetGroupByCap;
          value.query_ms = read.elapsed_ms;
        } catch (const std::exception& e) {
          if (client_pool_) client_pool_->invalidate(client);
          code = "trace_facet_values_failed";
          message = e.what();
          return false;
        }
        return true;
      });
  if (!cached.has_value || !cached.value) {
    return json_error(res, 503, cached.error_code.empty() ? "trace_facet_values_failed" : cached.error_code,
                      cached.error_message.empty() ? "Trace attribute values failed." : cached.error_message);
  }
  const auto& value = *cached.value;
  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("scope"); w.String(key_scope.c_str());
  w.Key("key"); w.String(key.c_str());
  w.Key("limit"); w.Int(limit);
  write_facet_common(w, scope, value.estimated, value.timed_out, value.query_ms, !fetched);
  w.Key("spans_with_key"); w.Uint64(value.spans_with_key);
  w.Key("distinct_values"); w.Uint64(value.distinct_values);
  w.Key("has_more"); w.Bool(value.distinct_values > value.values.size());
  w.Key("values"); w.StartArray();
  for (const auto& [text, count] : value.values) {
    w.StartArray(); w.String(text.c_str(), static_cast<rapidjson::SizeType>(text.size())); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_search(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  const int limit = int_param(req, "limit", static_cast<int>(cfg_.traces.search_limit), 1, static_cast<int>(cfg_.traces.search_limit));
  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }

  std::string validation_error;
  TraceFilterSpec filters;
  if (!parse_trace_filters(req, &filters, &validation_error)) return json_error(res, 400, "invalid_trace_filter", validation_error);

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::string span_filters;
  {
    std::string filter_code, filter_error;
    if (!trace_filters_sql(*client, *host, cfg_.traces, filters, &span_filters, &filter_code, &filter_error)) {
      return json_error(res, 400, filter_code, filter_error);
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const bool has_candidate_filters = !span_filters.empty();
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = has_candidate_filters && filters.key_only();
  const bool has_duration_filters = min_duration_ms > 0.0 || max_duration_ms > 0.0;
  const bool needs_span_match = has_candidate_filters || visibility != "1";
  const bool has_index = !cfg_.traces.trace_index_table.empty();
  const std::string index_table = has_index ? qualified(cfg_.traces.database, cfg_.traces.trace_index_table) : std::string{};

  // Duration is a trace-level filter and therefore stays after candidate span matching.
  const std::string duration_expr =
      "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
      "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";
  std::string having;
  if (min_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " >= " + std::to_string(ns);
  }
  if (max_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " <= " + std::to_string(ns);
  }

  // first_span_ns: offset of the service's earliest window span from the
  // trace's earliest window span (the UI orders services by it).
  struct ServiceStat { std::string service; uint64_t spans = 0, errors = 0, first_span_ns = 0; };
  struct Row {
    std::string trace_id, operation, service;
    int64_t start_ms = 0;
    uint64_t duration_ns = 0, spans = 0, errors = 0, missing_parents = 0;
    std::vector<ServiceStat> service_stats;
  };
  std::vector<Row> rows;

  auto read_summary = [&](const std::string& sql) {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Row out;
        out.trace_id = ch_block_text_at(block, 0, row);
        out.start_ms = std::stoll(ch_block_text_at(block, 1, row));
        out.operation = ch_block_text_at(block, 2, row);
        out.service = ch_block_text_at(block, 3, row);
        out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
        out.spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
        out.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row)));
        // One "service RS spans RS errors RS first_span_ns" item per service
        // (see aggregate_select).
        for (const auto& item : split_char(ch_block_text_at(block, 7, row), '\x1f')) {
          const size_t first_sep = item.rfind('\x1e');
          if (first_sep == std::string::npos || first_sep == 0) continue;
          const size_t errors_sep = item.rfind('\x1e', first_sep - 1);
          if (errors_sep == std::string::npos || errors_sep == 0) continue;
          const size_t spans_sep = item.rfind('\x1e', errors_sep - 1);
          if (spans_sep == std::string::npos || spans_sep == 0) continue;
          ServiceStat stat;
          stat.service = item.substr(0, spans_sep);
          stat.spans = static_cast<uint64_t>(std::stoull(item.substr(spans_sep + 1, errors_sep - spans_sep - 1)));
          stat.errors = static_cast<uint64_t>(std::stoull(item.substr(errors_sep + 1, first_sep - errors_sep - 1)));
          stat.first_span_ns = static_cast<uint64_t>(std::stoull(item.substr(first_sep + 1)));
          out.service_stats.push_back(std::move(stat));
        }
        std::sort(out.service_stats.begin(), out.service_stats.end(), [](const ServiceStat& a, const ServiceStat& b) {
          if (a.spans != b.spans) return a.spans > b.spans;
          return a.service < b.service;
        });
        out.missing_parents = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)));
        rows.push_back(std::move(out));
      }
    });
  };

  // Per-service span/error counts are aggregated server-side with sumMap, so
  // the per-trace state and the payload are O(services), not O(spans).
  // Spans without a ServiceName are not reported as a service (as before).
  // minMap keeps each service's earliest span start in the same O(services)
  // state; both maps sort the same key set, so their arrays zip aligned.
  const std::string service_stats_map =
      "sumMap([toString(ServiceName)], [toUInt64(1)], [toUInt64(StatusCode = 'Error')])";
  const std::string service_first_span_map = "minMap([toString(ServiceName)], [toUnixTimestamp64Nano(Timestamp)])";
  // Parent span ids that no span of the trace carries (Jaeger's "incomplete
  // trace" hint): distinct span and parent ids minus distinct span ids, over
  // the same window spans as the other columns.
  const std::string missing_parents_expr =
      "toString(uniqExactArray(arrayFilter(id -> notEmpty(id), [toString(SpanId), toString(ParentSpanId)])) - "
      "uniqExactIf(toString(SpanId), notEmpty(SpanId)))";
  const std::string aggregate_select =
      "SELECT toString(TraceId), toString(toUnixTimestamp64Milli(min(Timestamp))), "
      "toString(if(empty(argMinIf(SpanName, Timestamp, empty(ParentSpanId))), argMin(SpanName, Timestamp), argMinIf(SpanName, Timestamp, empty(ParentSpanId)))), "
      "toString(if(empty(argMinIf(ServiceName, Timestamp, empty(ParentSpanId))), argMin(ServiceName, Timestamp), argMinIf(ServiceName, Timestamp, empty(ParentSpanId)))), "
      "toString(" + duration_expr + "), toString(count()), toString(countIf(StatusCode = 'Error')), "
      "arrayStringConcat(arrayMap(stat -> concat(stat.1, char(30), toString(stat.2), char(30), toString(stat.3), char(30), "
      "toString(stat.4 - toUnixTimestamp64Nano(min(Timestamp)))), "
      "arrayFilter(stat -> notEmpty(stat.1), arrayZip(tupleElement(" + service_stats_map + ", 1), tupleElement(" +
      service_stats_map + ", 2), tupleElement(" + service_stats_map + ", 3), tupleElement(" + service_first_span_map +
      ", 2)))), char(31)), " + missing_parents_expr + " ";

  // The summary aggregates every window span of <= limit selected traces, so
  // it only needs the time range those spans occupy instead of probing every
  // part of the window. Span-ranked traces carry exact bounds (earliest window
  // span, and the latest span end when the duration HAVING computed it);
  // index-selected traces use their index bounds (every span Timestamp is
  // covered by the [Start, End] row of its insert batch) with the same 1 s
  // margin as trace detail.
  auto summary_sql_for = [&](const std::vector<std::string>& selected_ids, int64_t first_span_ns, int64_t span_end_ns) {
    const std::string trace_id_list = trace_id_list_sql(selected_ids);
    std::string with;
    std::string bounds;
    if (first_span_ns > 0) {
      bounds = " AND Timestamp >= " + ns_time(first_span_ns);
      if (span_end_ns >= first_span_ns) bounds += " AND Timestamp <= " + ns_time(span_end_ns);
    } else if (has_index) {
      with = "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
             " WHERE TraceId IN " + trace_id_list + ") AS trace_bounds ";
      bounds = " AND Timestamp >= tupleElement(trace_bounds, 1) AND Timestamp <= tupleElement(trace_bounds, 2)";
    }
    return with + aggregate_select +
        "FROM " + table + " PREWHERE " + time_predicate + bounds +
        " WHERE " + visibility + " AND TraceId IN " + trace_id_list +
        " GROUP BY TraceId ORDER BY min(Timestamp) DESC LIMIT " + std::to_string(limit);
  };

  auto elapsed_ms = [](std::chrono::steady_clock::time_point since) {
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - since).count());
  };

  uint64_t candidate_query_ms = 0;
  uint64_t summary_query_ms = 0;
  bool used_trace_index_fast_path = false;
  std::string search_path = "span_aggregation";
  const bool index_fast_path_eligible = !has_duration_filters && has_index;

  if (index_fast_path_eligible) {
    try {
      TraceIndexCursor cursor(*client, index_table, start_ms, end_ms);
      std::vector<std::string> selected_ids;
      const auto candidate_started = std::chrono::steady_clock::now();

      if (!needs_span_match) {
        for (auto& hit : cursor.next(static_cast<size_t>(limit))) selected_ids.push_back(std::move(hit.trace_id));
        search_path = "trace_index";
      } else {
        // Traces are tested in index rank order until `limit` match, over at
        // most the newest kCandidateScanCap traces (then the span fallback
        // below answers). Pages start at kCandidateBatch traces and grow when
        // matches are rare, so a rare filter reaches the cap in a handful of
        // pages instead of 64 fixed ones; the traces tested and their order
        // are unchanged.
        constexpr size_t kCandidateBatch = 1000;
        constexpr size_t kMaxCandidateBatch = 32000;
        constexpr size_t kCandidateScanCap = 64000;
        size_t considered = 0;
        size_t batch_size = kCandidateBatch;
        bool exhausted = false;

        while (selected_ids.size() < static_cast<size_t>(limit) && considered < kCandidateScanCap) {
          const auto batch = cursor.next(std::min(batch_size, kCandidateScanCap - considered));
          if (batch.empty()) {
            exhausted = true;
            break;
          }
          considered += batch.size();

          // The page is every trace whose newest index row lies in
          // [newest, oldest] Start of the page (plus older rows of already
          // tested traces, discarded below). Its spans lie inside the page's
          // index bounds, so matching reads only that time range rather than
          // probing the whole window.
          const std::string batch_ids =
              "(SELECT TraceId FROM " + index_table + " PREWHERE " + cursor.window() +
              " AND Start >= " + ns_time(batch.back().start_ns) + " AND Start <= " + ns_time(batch.front().start_ns) + ")";
          std::unordered_set<std::string> matching_ids;
          const std::string match_sql =
              "WITH (SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
              " WHERE TraceId IN " + batch_ids + ") AS batch_bounds "
              "SELECT toString(TraceId) FROM " + table +
              " PREWHERE " + time_predicate +
              " AND Timestamp >= tupleElement(batch_bounds, 1) AND Timestamp <= tupleElement(batch_bounds, 2)"
              " WHERE " + visibility + span_filters + " AND TraceId IN " + batch_ids +
              " LIMIT 1 BY TraceId";
          client->Select(match_sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) matching_ids.insert(ch_block_text_at(block, 0, row));
          });

          for (const auto& hit : batch) {
            if (matching_ids.find(hit.trace_id) == matching_ids.end()) continue;
            selected_ids.push_back(hit.trace_id);
            if (selected_ids.size() >= static_cast<size_t>(limit)) break;
          }
          if (batch.size() < std::min(batch_size, kCandidateScanCap - (considered - batch.size()))) {
            exhausted = true;
            break;
          }

          const size_t missing = static_cast<size_t>(limit) - std::min(selected_ids.size(), static_cast<size_t>(limit));
          if (missing == 0) break;
          const double projected = selected_ids.empty()
              ? static_cast<double>(batch_size) * 4.0
              : 1.25 * static_cast<double>(missing) * static_cast<double>(considered) / static_cast<double>(selected_ids.size());
          batch_size = std::max(kCandidateBatch, std::min(kMaxCandidateBatch, static_cast<size_t>(projected)));
        }

        if (selected_ids.size() < static_cast<size_t>(limit) && !exhausted && considered >= kCandidateScanCap) {
          throw std::runtime_error("filtered trace-index candidate scan cap reached");
        }
        search_path = "trace_index_filtered";
      }

      candidate_query_ms = elapsed_ms(candidate_started);

      if (!selected_ids.empty()) {
        const auto summary_started = std::chrono::steady_clock::now();
        read_summary(summary_sql_for(selected_ids, 0, 0));
        summary_query_ms = elapsed_ms(summary_started);
      }

      used_trace_index_fast_path = true;
    } catch (...) {
      rows.clear();
      candidate_query_ms = 0;
      summary_query_ms = 0;
      search_path = "span_aggregation";
    }
  }

  if (!used_trace_index_fast_path) {
    // Span-based search: duration filters (a trace-level HAVING the index
    // cannot answer -- the OTel exporter's trace_id_ts MV stores
    // End = max(Timestamp), the last span *start*), no trace index, or the
    // filtered index scan reached its cap. Rank the TraceIds with only the
    // cheap min/max aggregates (newest slice first, see
    // rank_traces_by_start), then compute the expensive summary (argMin*,
    // per-service stats) for those <= limit traces only. Same spans, same
    // HAVING, same ORDER BY as a single whole-window aggregation.
    try {
      const auto candidate_started = std::chrono::steady_clock::now();
      SpanRankQuery rank;
      rank.table = table;
      rank.time_predicate = time_predicate;
      rank.visibility = visibility;
      rank.span_filters = span_filters;
      rank.having = having;
      rank.broad_filters = key_only_filters &&
          filters_are_broad(*client, table, index_table, time_predicate, visibility, span_filters, start_ms, end_ms);
      rank.start_ms = start_ms;
      rank.end_ms = end_ms;
      rank.limit = static_cast<size_t>(limit);
      const auto ranked = rank_traces_by_start(*client, rank);
      candidate_query_ms = elapsed_ms(candidate_started);
      if (!ranked.empty()) {
        std::vector<std::string> selected_ids;
        int64_t first_span_ns = std::numeric_limits<int64_t>::max();
        int64_t span_end_ns = 0;
        bool span_end_known = true;
        for (const auto& trace : ranked) {
          selected_ids.push_back(trace.trace_id);
          first_span_ns = std::min(first_span_ns, trace.first_span_ns);
          span_end_known = span_end_known && trace.span_end_ns > 0;
          span_end_ns = std::max(span_end_ns, trace.span_end_ns);
        }
        if (!span_end_known) span_end_ns = 0;
        const auto summary_started = std::chrono::steady_clock::now();
        read_summary(summary_sql_for(selected_ids, first_span_ns, span_end_ns));
        summary_query_ms = elapsed_ms(summary_started);
      }
      if (has_duration_filters) search_path = "span_duration_two_phase";
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_search_failed", e.what());
    }
  }

  std::vector<std::string> service_dict;
  std::unordered_map<std::string, size_t> service_index;
  auto intern_service = [&](const std::string& name) -> size_t {
    auto it = service_index.find(name);
    if (it != service_index.end()) return it->second;
    const size_t idx = service_dict.size();
    service_dict.push_back(name);
    service_index.emplace(name, idx);
    return idx;
  };
  for (const auto& row : rows) {
    intern_service(row.service);
    for (const auto& stat : row.service_stats) intern_service(stat.service);
  }

  const uint64_t total_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - request_started).count());

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(3);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("search_path"); w.String(search_path.c_str());
  w.Key("timing_ms"); w.StartObject();
  w.Key("candidates"); w.Uint64(candidate_query_ms);
  w.Key("summary"); w.Uint64(summary_query_ms);
  w.Key("total"); w.Uint64(total_ms);
  w.EndObject();
  w.Key("services"); write_string_array(w, service_dict);
  w.Key("columns"); w.StartArray();
  for (const char* col : {"trace_id", "start_ms", "root_operation", "root_service", "duration_ns", "span_count", "error_count", "service_stats", "missing_parents"}) w.String(col);
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) {
    w.StartArray();
    w.String(row.trace_id.c_str()); w.Int64(row.start_ms); w.String(row.operation.c_str()); w.Uint64(intern_service(row.service));
    w.Uint64(row.duration_ns); w.Uint64(row.spans); w.Uint64(row.errors);
    w.StartArray();
    for (const auto& stat : row.service_stats) {
      w.StartArray(); w.Uint64(intern_service(stat.service)); w.Uint64(stat.spans); w.Uint64(stat.errors); w.Uint64(stat.first_span_ns);
      w.EndArray();
    }
    w.EndArray();
    w.Uint64(row.missing_parents);
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_analytics(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  if (!cfg_.traces.analytics) return json_error(res, 404, "trace_analytics_disabled", "Trace analytics are disabled by configuration.");

  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }

  std::string validation_error;
  TraceFilterSpec filters;
  if (!parse_trace_filters(req, &filters, &validation_error)) return json_error(res, 400, "invalid_trace_filter", validation_error);

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::string span_filters;
  {
    std::string filter_code, filter_error;
    if (!trace_filters_sql(*client, *host, cfg_.traces, filters, &span_filters, &filter_code, &filter_error)) {
      return json_error(res, 400, filter_code, filter_error);
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string index_table = cfg_.traces.trace_index_table.empty()
      ? std::string{}
      : qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
  const std::string time_predicate = trace_time_predicate(start_ms, end_ms);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const bool has_candidate_filters = !span_filters.empty();
  // Only service / operation filters (primary-key columns) may use the broad form.
  const bool key_only_filters = has_candidate_filters && filters.key_only();

  const std::string candidate_cte = has_candidate_filters
      ? "candidate_ids AS (SELECT TraceId FROM " + table + " PREWHERE " + time_predicate +
        " WHERE " + visibility + span_filters + " LIMIT 1 BY TraceId)"
      : std::string{};
  const std::string candidate_where = has_candidate_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};

  const std::string duration_expr =
      "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
      "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";
  std::string having;
  if (min_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " >= " + std::to_string(ns);
  }
  if (max_duration_ms > 0.0) {
    const uint64_t ns = static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0));
    having += (having.empty() ? " HAVING " : " AND ") + duration_expr + " <= " + std::to_string(ns);
  }

  struct TraceCountPoint { int64_t bucket_ms = 0; uint64_t count = 0; };
  struct QuantilePoint { int64_t bucket_ms = 0; uint64_t p50 = 0, p90 = 0, p95 = 0, p99 = 0; };
  std::vector<TraceCountPoint> trace_counts;
  std::vector<QuantilePoint> quantiles;

  const int bucket_seconds = choose_trace_bucket_seconds(end_ms - start_ms);
  int quantile_bucket_seconds = choose_trace_quantile_bucket_seconds(end_ms - start_ms);
  if (bucket_seconds % quantile_bucket_seconds != 0) {
    quantile_bucket_seconds = std::max(60, std::gcd(bucket_seconds, quantile_bucket_seconds));
  }
  const int64_t bucket_ms = static_cast<int64_t>(bucket_seconds) * 1000;
  const int64_t quantile_bucket_ms = static_cast<int64_t>(quantile_bucket_seconds) * 1000;
  // Buckets lie on a grid anchored at bucket_origin_ms (the browser sends its
  // local midnight, so 3 h / 1 d buckets start at local 00:00 rather than UTC
  // 00:00). Only the origin modulo the bucket size matters, and the quantile
  // bucket divides the count bucket, so both grids nest.
  int64_t bucket_origin_ms = 0;
  parse_i64_param(req, "bucket_origin_ms", &bucket_origin_ms);
  const auto grid_origin = [&](int64_t size_ms) { return ((bucket_origin_ms % size_ms) + size_ms) % size_ms; };
  const auto grid_floor = [](int64_t t, int64_t size_ms, int64_t origin) {
    const int64_t offset = t - origin;
    return origin + (offset >= 0 ? offset / size_ms : -((-offset + size_ms - 1) / size_ms)) * size_ms;
  };
  const int64_t count_origin_ms = grid_origin(bucket_ms);
  const int64_t quantile_origin_ms = grid_origin(quantile_bucket_ms);
  const auto grid_bucket_sql = [](const std::string& column, int64_t size_ms, int64_t origin) {
    return "toString(" + std::to_string(origin) + " + intDiv(toUnixTimestamp64Milli(" + column + ") - " +
           std::to_string(origin) + ", " + std::to_string(size_ms) + ") * " + std::to_string(size_ms) + ")";
  };
  const bool align_buckets = req.has_param("align_buckets") && req.get_param_value("align_buckets") == "1";
  const int64_t analytics_start_ms = align_buckets ? grid_floor(start_ms, bucket_ms, count_origin_ms) : start_ms;
  const int64_t analytics_end_ms = align_buckets ? grid_floor(end_ms + bucket_ms - 1, bucket_ms, count_origin_ms) : end_ms;

  // charts=counts asks for the trace count chart alone, charts=durations for
  // the percentiles alone; both by default.
  const std::string charts_param = req.has_param("charts") ? req.get_param_value("charts") : std::string{};
  const bool want_counts = charts_param.empty() || charts_param.find("counts") != std::string::npos;
  const bool want_durations = charts_param.empty() || charts_param.find("durations") != std::string::npos;
  if (!want_counts && !want_durations) {
    return json_error(res, 400, "invalid_trace_charts", "charts must list counts and/or durations.");
  }

  auto read_analytics = [&](const std::string& sql) {
    std::map<int64_t, uint64_t> count_by_bucket;
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const int64_t q_bucket_ms = std::stoll(ch_block_text_at(block, 0, row));
        const uint64_t count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row)));
        const int64_t count_bucket_ms = grid_floor(q_bucket_ms, bucket_ms, count_origin_ms);
        count_by_bucket[count_bucket_ms] += count;
        quantiles.push_back(QuantilePoint{
            q_bucket_ms,
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row))),
            static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)))});
      }
    });
    for (const auto& [bucket, count] : count_by_bucket) trace_counts.push_back(TraceCountPoint{bucket, count});
  };

  // Duration quantiles are always computed from the spans themselves. The
  // trace index cannot provide them: the OTel exporter's trace_id_ts MV stores
  // End = max(Timestamp), i.e. the *start* of the last span, and one row per
  // insert batch (so any single row may hold partial bounds). Index-based
  // quantiles were therefore systematically wrong (e.g. P50 226 ms instead of
  // 182 ms on the local fixture). When both charts are asked for, trace counts
  // come from the same query, so both describe exactly the same set of traces.
  //
  // That span aggregation groups every span of the window by TraceId and grows
  // linearly with the window (local fixture, 1.6 B spans over 7 days: ~15 s,
  // most of it decompressing TraceId). A count-only request therefore reads
  // the trace index when nothing restricts the traces: one small row per
  // (trace, insert batch) holding its first span start; 7 days take < 1 s.
  // A trace is bucketed by its earliest indexed start in the window, i.e. its
  // first span start (rows are per insert batch, so a batch that began before
  // the window start can only move a trace by one bucket at that edge).
  // Measured and rejected: hash sampling (cityHash64(TraceId) % N) still
  // decompresses TraceId and saved < 30 %; root spans (ParentSpanId = '') are
  // not traces (the fixture has 1.6 roots per trace, 175 ms roots in 14 min
  // traces); the table has no SAMPLE BY key.
  uint64_t analytics_query_ms = 0;
  std::string analytics_path = "span_aggregation";
  std::string trace_count_source = "span_bounds";
  const std::string quantile_source = "span_bounds";
  const bool index_counts_eligible = want_counts && !want_durations && !index_table.empty() &&
      !has_candidate_filters && having.empty() && visibility == "1";
  bool have_counts = false;
  bool have_durations = false;

  if (index_counts_eligible) {
    try {
      const auto started = std::chrono::steady_clock::now();
      const std::string index_sql =
          "SELECT " + grid_bucket_sql("first_start", bucket_ms, count_origin_ms) + " AS bucket_ms, toString(count()) "
          "FROM (SELECT min(Start) AS first_start FROM " + index_table + " PREWHERE Start >= fromUnixTimestamp64Milli(" +
          std::to_string(start_ms) + ") AND Start <= fromUnixTimestamp64Milli(" + std::to_string(end_ms) +
          ") GROUP BY TraceId) GROUP BY bucket_ms ORDER BY bucket_ms";
      std::map<int64_t, uint64_t> count_by_bucket;
      client->Select(index_sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          count_by_bucket[std::stoll(ch_block_text_at(block, 0, row))] +=
              static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 1, row)));
        }
      });
      for (const auto& [bucket, count] : count_by_bucket) trace_counts.push_back(TraceCountPoint{bucket, count});
      analytics_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started).count());
      analytics_path = "trace_index";
      trace_count_source = "trace_index";
      have_counts = true;
    } catch (const std::exception&) {
      // A missing or unreadable index falls back to the span aggregation, on a
      // fresh connection (a failed query may leave this one unusable).
      trace_counts.clear();
      client = acquire_trace_client(cfg_, *host, client_pool_, &error);
      if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    }
  }

  if (!have_counts) {
    try {
      const auto analytics_started = std::chrono::steady_clock::now();
      // Broad service / operation filters aggregate once with HAVING countIf
      // instead of building an IN set of most traces (see filters_are_broad).
      const bool broad = key_only_filters && filters_are_broad(
          *client, table, index_table, time_predicate, visibility, span_filters, start_ms, end_ms);
      const std::string scope_having = broad
          ? " HAVING countIf(1" + span_filters + ") > 0" + (having.empty() ? std::string{} : " AND " + having_terms(having))
          : having;
      const std::string trace_scope = " FROM " + table + " PREWHERE " + time_predicate + " WHERE " + visibility +
          (broad ? std::string{} : candidate_where) + " GROUP BY TraceId" + scope_having;
      const std::string with_candidate = has_candidate_filters && !broad ? "WITH " + candidate_cte + ", " : "WITH ";
      const std::string trace_durations_cte = with_candidate +
          "trace_durations AS (SELECT min(Timestamp) AS trace_start, " + duration_expr + " AS duration_ns" + trace_scope + ") ";
      const std::string analytics_sql = trace_durations_cte +
          "SELECT " + grid_bucket_sql("trace_start", quantile_bucket_ms, quantile_origin_ms) + " AS bucket_ms, toString(count()), "
          "toString(toUInt64(quantileTDigest(0.50)(duration_ns))), toString(toUInt64(quantileTDigest(0.90)(duration_ns))), "
          "toString(toUInt64(quantileTDigest(0.95)(duration_ns))), toString(toUInt64(quantileTDigest(0.99)(duration_ns))) "
          "FROM trace_durations GROUP BY bucket_ms ORDER BY bucket_ms";
      read_analytics(analytics_sql);
      analytics_query_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - analytics_started).count());
      have_counts = true;
      have_durations = true;
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_analytics_failed", e.what());
    }
  }

  const uint64_t total_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - request_started).count());

  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("analytics_path"); w.String(analytics_path.c_str());
  w.Key("duration_quantiles_source"); w.String(quantile_source.c_str());
  w.Key("trace_count_source"); w.String(trace_count_source.c_str());
  w.Key("charts"); w.StartArray();
  if (have_counts) w.String("counts");
  if (have_durations) w.String("durations");
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("analytics"); w.Uint64(analytics_query_ms);
  w.Key("total"); w.Uint64(total_ms);
  w.EndObject();
  w.Key("range"); w.StartArray(); w.Int64(analytics_start_ms); w.Int64(analytics_end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(bucket_ms);
  w.Key("quantile_bucket_ms"); w.Int64(quantile_bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(count_origin_ms);
  w.Key("trace_count_chart"); w.StartArray();
  for (const auto& point : trace_counts) {
    w.StartArray(); w.Int64(point.bucket_ms); w.Uint64(point.count); w.EndArray();
  }
  w.EndArray();
  w.Key("duration_quantiles"); w.StartArray();
  for (const auto& point : quantiles) {
    w.StartArray(); w.Int64(point.bucket_ms); w.Uint64(point.p50); w.Uint64(point.p90); w.Uint64(point.p95); w.Uint64(point.p99); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

namespace {

// --- Service map -------------------------------------------------------------
// GET /api/traces/service_map: the services and the calls between them, after
// HyperDX's DBServiceMapPage. An edge A -> B counts the spans of service B
// whose parent span (same TraceId) belongs to another service A. That covers
// Client -> Server / Producer -> Consumer instrumentation (HyperDX joins those
// kinds) as well as flat traces whose root span's direct children run in other
// services: the OTel fixture has no Client span above a Server span, so a
// kind-based join finds no edge there. Edge metrics describe the callee spans;
// node metrics every span of the service.
//
// The filters are the search's and select traces (a trace is on the map when
// one of its spans matches them, as in the result list); the map then counts
// every visible span of those traces inside the window.
//
// Cost (measured on the ~2 B span fixture, 33 M spans in its peak hour): the
// self-join scans TraceId / SpanId / ParentSpanId once per side and hashes the
// parent side. Two budgets bound it:
//  * rows read: when the window holds more than kServiceMapReadRows spans
//    (EXPLAIN ESTIMATE: primary-key granules, no scan), only evenly spaced
//    ~3 minute time slices holding about that many spans are read. Trace
//    sampling alone does not bound this: every TraceId must still be read and
//    hashed (the peak hour took 2.8 s with 1 trace in 10);
//  * join size: cityHash64(TraceId) % N = 0 keeps whole traces (HyperDX's
//    sampling), N = ceil(rows read / kServiceMapJoinRows).
// Counts are scaled by N / time coverage, and the factors are reported.
// Measured: 10 min unsampled 0.59 s; 1 h 0.64 s; 24 h 0.77 s; 7 d 0.84 s.
// Parent lookups join a 64-bit hash of (TraceId, SpanId) instead of the two
// strings (0.45 s instead of 1.3 s on 10 minutes) with ANY (the exporter may
// store a span twice: a child still counts once).
constexpr uint64_t kServiceMapReadRows = 12000000;
constexpr uint64_t kServiceMapJoinRows = 3000000;
constexpr int64_t kServiceMapSliceMs = 3 * 60 * 1000;
constexpr int kServiceMapMaxSlices = 48;
constexpr int kServiceMapTimeBudgetSeconds = 30;
constexpr int64_t kServiceMapFallbackWindowMs = 10 * 60 * 1000;
constexpr size_t kServiceMapMaxNodes = 500;
constexpr size_t kServiceMapMaxEdges = 2000;
constexpr int kServiceMapMaxSampleFactor = 10000;

// The time predicate of a service map read: the whole window, or `count`
// equally long slices (together `coverage` of the window), each centred in
// its share of the window. *actual is the coverage really read.
std::string service_map_time_predicate(int64_t start_ms, int64_t end_ms, double coverage, int* slices, double* actual) {
  const int64_t window_ms = end_ms - start_ms;
  *slices = 0;
  *actual = 1.0;
  if (coverage >= 1.0) return trace_time_predicate(start_ms, end_ms);
  const double covered_ms = static_cast<double>(window_ms) * coverage;
  const int count = static_cast<int>(std::max<long long>(1, std::min<long long>(kServiceMapMaxSlices, std::llround(covered_ms / kServiceMapSliceMs))));
  const int64_t length_ms = std::max<int64_t>(1000, static_cast<int64_t>(covered_ms / count));
  if (length_ms * count >= window_ms) return trace_time_predicate(start_ms, end_ms);
  const double stride_ms = static_cast<double>(window_ms) / count;
  std::string out = "(";
  for (int i = 0; i < count; ++i) {
    const int64_t lo = start_ms + static_cast<int64_t>(i * stride_ms + (stride_ms - static_cast<double>(length_ms)) / 2.0);
    if (i) out += " OR ";
    out += "(Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(lo) + ") AND Timestamp < fromUnixTimestamp64Milli(" +
           std::to_string(lo + length_ms) + "))";
  }
  *slices = count;
  *actual = static_cast<double>(length_ms * count) / static_cast<double>(window_ms);
  return out + ")";
}

struct ServiceMapStats {
  uint64_t count = 0, errors = 0, p50 = 0, p95 = 0, p99 = 0;
};

void write_service_map_stats(rapidjson::Writer<rapidjson::StringBuffer>& w, const ServiceMapStats& stats, double scale,
                             const char* count_key) {
  w.Key(count_key); w.Uint64(static_cast<uint64_t>(std::llround(static_cast<double>(stats.count) * scale)));
  w.Key("errors"); w.Uint64(static_cast<uint64_t>(std::llround(static_cast<double>(stats.errors) * scale)));
  w.Key("error_rate"); w.Double(stats.count ? static_cast<double>(stats.errors) / static_cast<double>(stats.count) : 0.0);
  w.Key("sampled_count"); w.Uint64(stats.count);
  w.Key("p50_ns"); w.Uint64(stats.p50);
  w.Key("p95_ns"); w.Uint64(stats.p95);
  w.Key("p99_ns"); w.Uint64(stats.p99);
}

}  // namespace

void Server::handle_traces_service_map(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");

  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }
  // sample_factor forces the trace sampling factor (1 = every trace); the
  // time slicing still applies above the read budget.
  const int forced_factor = int_param(req, "sample_factor", 0, 1, kServiceMapMaxSampleFactor);

  std::string validation_error;
  TraceFilterSpec filters;
  if (!parse_trace_filters(req, &filters, &validation_error)) return json_error(res, 400, "invalid_trace_filter", validation_error);

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::string span_filters;
  {
    std::string filter_code, filter_error;
    if (!trace_filters_sql(*client, *host, cfg_.traces, filters, &span_filters, &filter_code, &filter_error)) {
      return json_error(res, 400, filter_code, filter_error);
    }
  }

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const int64_t window_ms = end_ms - start_ms;

  // Spans in the window, from the primary index alone (EXPLAIN ESTIMATE rows:
  // database, table, parts, rows, marks). Selecting FROM (EXPLAIN ...) would
  // need CREATE TEMPORARY TABLE, so the rows are summed here.
  const auto estimate_started = std::chrono::steady_clock::now();
  uint64_t estimated_spans = 0;
  std::string estimate_source = "explain";
  try {
    client->Select("EXPLAIN ESTIMATE SELECT 1 FROM " + table + " PREWHERE " + trace_time_predicate(start_ms, end_ms),
                   [&](const clickhouse::Block& block) {
                     if (block.GetColumnCount() < 4 || block.GetRowCount() == 0) return;
                     const auto rows = block[3]->As<clickhouse::ColumnUInt64>();
                     if (!rows) throw std::runtime_error("EXPLAIN ESTIMATE returned no rows column.");
                     for (size_t row = 0; row < block.GetRowCount(); ++row) estimated_spans += rows->At(row);
                   });
  } catch (const std::exception&) {
    // Without an estimate the window size decides: the read budget is
    // assumed to cover ten minutes (on a fresh connection, see analytics).
    estimate_source = "window";
    estimated_spans = kServiceMapReadRows * static_cast<uint64_t>(std::max<int64_t>(1, window_ms / kServiceMapFallbackWindowMs));
    client = acquire_trace_client(cfg_, *host, client_pool_, &error);
    if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
  }
  const double estimate_ms = elapsed_ms_since(estimate_started);

  const double wanted_coverage = estimated_spans > kServiceMapReadRows
      ? static_cast<double>(kServiceMapReadRows) / static_cast<double>(estimated_spans)
      : 1.0;
  int slices = 0;
  double time_coverage = 1.0;
  const std::string time_predicate = service_map_time_predicate(start_ms, end_ms, wanted_coverage, &slices, &time_coverage);
  const double spans_read = static_cast<double>(estimated_spans) * time_coverage;
  const uint64_t trace_factor = forced_factor > 0
      ? static_cast<uint64_t>(forced_factor)
      : std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(spans_read / static_cast<double>(kServiceMapJoinRows))));
  const double scale = static_cast<double>(trace_factor) / time_coverage;
  const bool sampled = trace_factor > 1 || slices > 0;
  const std::string sample_sql = trace_factor > 1 ? " AND cityHash64(TraceId) % " + std::to_string(trace_factor) + " = 0" : std::string{};

  // Trace selection by the search filters, on the same (sampled) spans.
  const std::string duration_expr =
      "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - toInt64(min(toUnixTimestamp64Nano(Timestamp))))";
  std::vector<std::string> duration_terms;
  if (min_duration_ms > 0.0) {
    duration_terms.push_back(duration_expr + " >= " + std::to_string(static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0))));
  }
  if (max_duration_ms > 0.0) {
    duration_terms.push_back(duration_expr + " <= " + std::to_string(static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0))));
  }
  const std::string scan = " FROM " + table + " PREWHERE " + time_predicate + sample_sql + " WHERE " + visibility;
  std::string candidate;
  if (!duration_terms.empty()) {
    std::string having = span_filters.empty() ? std::string{} : "countIf(1" + span_filters + ") > 0";
    for (const auto& term : duration_terms) having += (having.empty() ? "" : " AND ") + term;
    candidate = "SELECT TraceId" + scan + " GROUP BY TraceId HAVING " + having;
  } else if (!span_filters.empty()) {
    candidate = "SELECT TraceId" + scan + span_filters;
  }
  const std::string side = scan + (candidate.empty() ? std::string{} : " AND TraceId IN (" + candidate + ")");

  const std::string sql =
      "SELECT toString(GROUPING(caller)), caller, service, toString(count()), toString(countIf(err)), "
      "toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[1])), toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[2])), "
      "toString(toUInt64(quantiles(0.5, 0.95, 0.99)(dur)[3])) "
      "FROM (SELECT if(ParentSpanId = '', 0, cityHash64(TraceId, ParentSpanId)) AS pk, toString(ServiceName) AS service, "
      "Duration AS dur, StatusCode = 'Error' AS err" + side + ") AS c "
      "ANY LEFT JOIN (SELECT cityHash64(TraceId, SpanId) AS k, toString(ServiceName) AS parent_service" + side + ") AS p ON c.pk = p.k "
      "GROUP BY GROUPING SETS ((if(p.parent_service != c.service, p.parent_service, '') AS caller, service), (service)) "
      "HAVING GROUPING(caller) = 1 OR caller != '' "
      "SETTINGS max_execution_time = " + std::to_string(kServiceMapTimeBudgetSeconds) +
      ", timeout_overflow_mode = 'throw', force_grouping_standard_compatibility = 1, join_use_nulls = 0";

  struct NodeRow { std::string service; ServiceMapStats stats; };
  struct EdgeRow { std::string source, target; ServiceMapStats stats; };
  std::vector<NodeRow> nodes;
  std::vector<EdgeRow> edges;
  const auto query_started = std::chrono::steady_clock::now();
  try {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ServiceMapStats stats;
        stats.count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row)));
        stats.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
        stats.p50 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
        stats.p95 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row)));
        stats.p99 = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 7, row)));
        if (ch_block_text_at(block, 0, row) == "1") nodes.push_back(NodeRow{ch_block_text_at(block, 2, row), stats});
        else edges.push_back(EdgeRow{ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), stats});
      }
    });
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_service_map_failed", e.what());
  }
  const double query_ms = elapsed_ms_since(query_started);

  // Busiest first; a map beyond these sizes is unreadable anyway.
  std::sort(nodes.begin(), nodes.end(), [](const NodeRow& a, const NodeRow& b) {
    return a.stats.count != b.stats.count ? a.stats.count > b.stats.count : a.service < b.service;
  });
  std::sort(edges.begin(), edges.end(), [](const EdgeRow& a, const EdgeRow& b) {
    if (a.stats.count != b.stats.count) return a.stats.count > b.stats.count;
    return a.source != b.source ? a.source < b.source : a.target < b.target;
  });
  const bool truncated = nodes.size() > kServiceMapMaxNodes || edges.size() > kServiceMapMaxEdges;
  if (nodes.size() > kServiceMapMaxNodes) nodes.resize(kServiceMapMaxNodes);
  if (edges.size() > kServiceMapMaxEdges) edges.resize(kServiceMapMaxEdges);

  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("edge_rule"); w.String("parent_child_cross_service");
  w.Key("sampled"); w.Bool(sampled);
  w.Key("sample_factor"); w.Double(scale);
  w.Key("sampling"); w.StartObject();
  w.Key("trace_factor"); w.Uint64(trace_factor);
  w.Key("time_coverage"); w.Double(time_coverage);
  w.Key("slices"); w.Int(slices);
  w.Key("estimated_spans"); w.Uint64(estimated_spans);
  w.Key("estimate_source"); w.String(estimate_source.c_str());
  w.EndObject();
  w.Key("truncated"); w.Bool(truncated);
  w.Key("timing_ms"); w.StartObject();
  w.Key("estimate"); w.Double(estimate_ms);
  w.Key("query"); w.Double(query_ms);
  w.Key("total"); w.Double(elapsed_ms_since(request_started));
  w.EndObject();
  w.Key("nodes"); w.StartArray();
  for (const auto& node : nodes) {
    w.StartObject();
    w.Key("service"); w.String(node.service.c_str());
    write_service_map_stats(w, node.stats, scale, "spans");
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : edges) {
    w.StartObject();
    w.Key("source"); w.String(edge.source.c_str());
    w.Key("target"); w.String(edge.target.c_str());
    write_service_map_stats(w, edge.stats, scale, "calls");
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

namespace {

// --- Services view -----------------------------------------------------------
// After HyperDX's ServicesDashboardPage: RED metrics (rate, errors, duration)
// of each service's entry spans. Entry spans are the spans that receive work:
// SpanKind Server or Consumer (the OTel exporter writes 'Server', the proto
// enum spelling is 'SPAN_KIND_SERVER'), or a root span of any kind. The span
// filters of the search (service, operation, status, tags and their
// negations) describe these spans themselves; min / max_duration_ms bound the
// span's own Duration. The primary key starts with (ServiceName, SpanName),
// so a drill-down into one service reads only that service's granules.
//
// Cost: one pass over the window reading ServiceName, SpanName, SpanKind,
// ParentSpanId, StatusCode, Duration and Timestamp. On the ~2 B span fixture
// (up to 23 M spans per hour) one hour of all services takes ~0.3 s and its
// densest day ~3.6 s, a week ~15-30 s. A window estimated (EXPLAIN ESTIMATE,
// index only) above kServicesExactRows is therefore sampled by time: one
// slice per chart bucket, at a stable pseudo-random offset inside it, sized
// to read about kServicesSampleRows; counts are scaled back by the sampled
// share of the window and the answer is marked estimated. exact=1 asks for
// the whole window; the time budget still stops it (marked partial).
constexpr const char* kServiceEntrySpans =
    "(SpanKind IN ('Server', 'Consumer', 'SPAN_KIND_SERVER', 'SPAN_KIND_CONSUMER') OR ParentSpanId = '')";
constexpr const char* kServiceRootSpans = "ParentSpanId = ''";
constexpr uint64_t kServicesExactRows = 150000000;
constexpr uint64_t kServicesSampleRows = 50000000;
constexpr int64_t kServicesMinSliceMs = 60 * 1000;
constexpr int kServicesTimeBudgetSeconds = 25;
constexpr uint64_t kServicesGroupByCap = 200000;
constexpr size_t kServicesMaxEndpoints = 100;
constexpr size_t kServicesSlowestSpans = 20;
constexpr size_t kServicesMaxReleases = 50;
constexpr uint64_t kServicesReleaseReadRowsCap = 200000000;
constexpr size_t kServicesMaxStatements = 50;
constexpr uint64_t kServicesDbReadRowsCap = 200000000;
constexpr size_t kServicesMaxDetailBytes = 1024;

// The front half shared by /api/traces/services and /api/traces/services/db.
struct ServicesScope {
  std::string source_host_id;
  const HostSpec* host = nullptr;
  int64_t start_ms = 0, end_ms = 0;
  std::string detail;           // the drilled-down service, or empty
  std::string span_scope;       // "entry" or "root"
  std::string where;            // " AND ..." after the allowlist predicate
  AttributeColumns columns;
};

bool services_scope(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool, const httplib::Request& req,
                    httplib::Response& res, ServicesScope* scope, std::shared_ptr<clickhouse::Client>* client) {
  if (!cfg.traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled."); return false; }
  if (!cfg.traces.analytics) {
    json_error(res, 404, "trace_analytics_disabled", "Trace analytics (and the services view) are disabled by configuration.");
    return false;
  }
  std::string message;
  if (feature_param_rejected(cfg.traces, req, &message)) { json_error(res, 400, "trace_filter_disabled", message); return false; }
  scope->host = trace_host(cfg, req, &scope->source_host_id);
  if (!scope->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  if (!trace_time_range(cfg.traces, req, &scope->start_ms, &scope->end_ms, &message)) {
    json_error(res, 400, "invalid_trace_range", message);
    return false;
  }
  scope->span_scope = req.has_param("scope") && !req.get_param_value("scope").empty() ? req.get_param_value("scope") : "entry";
  if (scope->span_scope != "entry" && scope->span_scope != "root") {
    json_error(res, 400, "invalid_trace_filter", "scope must be entry or root.");
    return false;
  }
  scope->detail = req.has_param("detail") ? req.get_param_value("detail") : std::string{};
  if (scope->detail.size() > kServicesMaxDetailBytes) {
    json_error(res, 400, "invalid_trace_filter", "detail is limited to 1024 bytes.");
    return false;
  }
  if (!scope->detail.empty() && !cfg.traces.features.service_filter) {
    json_error(res, 400, "trace_filter_disabled", "service filter is disabled by traces.features");
    return false;
  }
  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
    return false;
  }
  TraceFilterSpec filters;
  if (!parse_trace_filters(req, &filters, &message)) { json_error(res, 400, "invalid_trace_filter", message); return false; }
  *client = acquire_trace_client(cfg, *scope->host, pool, &message);
  if (!*client) {
    json_error(res, 503, "trace_source_unavailable", message.empty() ? "Cannot connect to trace ClickHouse source." : message);
    return false;
  }
  std::string span_filters, filter_code;
  if (!trace_filters_sql(**client, *scope->host, cfg.traces, filters, &span_filters, &filter_code, &message)) {
    json_error(res, 400, filter_code, message);
    return false;
  }
  scope->where = span_filters;
  if (!scope->detail.empty()) scope->where += " AND ServiceName = " + quote_string(scope->detail);
  if (min_duration_ms > 0.0) scope->where += " AND Duration >= " + std::to_string(std::llround(min_duration_ms * 1000000.0));
  if (max_duration_ms > 0.0) scope->where += " AND Duration <= " + std::to_string(std::llround(max_duration_ms * 1000000.0));
  scope->columns = trace_attribute_columns(**client, *scope->host, cfg.traces);
  return true;
}

// The time predicate of a services query: the whole window, or one slice per
// bucket of the chart grid (see above). scale_for(bucket) turns a bucket's
// sampled counts into window counts; `factor` does it for window totals.
struct ServicesWindow {
  bool sampled = false;
  uint64_t estimated_rows = 0;
  int64_t sampled_ms = 0;
  double factor = 1.0;
  std::string time_sql;
  std::map<int64_t, double> bucket_scale;
  double scale_for(int64_t bucket) const {
    const auto it = bucket_scale.find(bucket);
    return it == bucket_scale.end() ? 1.0 : it->second;
  }
};

uint64_t estimate_window_rows(clickhouse::Client& client, const std::string& from_where) {
  uint64_t rows = 0;
  client.Select("EXPLAIN ESTIMATE SELECT 1" + from_where, [&](const clickhouse::Block& block) {
    for (size_t row = 0; row < block.GetRowCount(); ++row) {
      if (block.GetColumnCount() >= 4) rows += ch_block_u64_at(block, 3, row);
    }
  });
  return rows;
}

ServicesWindow services_window(int64_t start_ms, int64_t end_ms, int64_t bucket_ms, int64_t origin_ms,
                               uint64_t estimated_rows, bool exact) {
  ServicesWindow out;
  out.estimated_rows = estimated_rows;
  out.time_sql = trace_time_predicate(start_ms, end_ms);
  out.sampled_ms = end_ms - start_ms;
  if (exact || estimated_rows <= kServicesExactRows) return out;
  const double fraction = static_cast<double>(kServicesSampleRows) / static_cast<double>(estimated_rows);
  const int64_t slice_ms = std::max<int64_t>(kServicesMinSliceMs, static_cast<int64_t>(std::llround(bucket_ms * fraction / 1000.0)) * 1000);
  if (slice_ms * 2 > bucket_ms) return out;
  const int64_t offset = start_ms - origin_ms;
  int64_t bucket = origin_ms + (offset >= 0 ? offset / bucket_ms : -((-offset + bucket_ms - 1) / bucket_ms)) * bucket_ms;
  std::string terms;
  int64_t sampled = 0;
  for (; bucket < end_ms; bucket += bucket_ms) {
    const int64_t lo = std::max(bucket, start_ms), hi = std::min(bucket + bucket_ms, end_ms);
    if (hi <= lo) continue;
    const int64_t length = std::min(slice_ms, hi - lo);
    // Golden-ratio offsets: spread over the bucket, stable for a given grid.
    const double phase = std::fmod(static_cast<double>(bucket / bucket_ms) * 0.6180339887498949, 1.0);
    const int64_t at = lo + static_cast<int64_t>(std::floor(std::fabs(phase) * static_cast<double>(hi - lo - length)));
    if (!terms.empty()) terms += " OR ";
    terms += "(Timestamp >= fromUnixTimestamp64Milli(" + std::to_string(at) + ") AND Timestamp < fromUnixTimestamp64Milli(" +
             std::to_string(at + length) + "))";
    out.bucket_scale[bucket] = static_cast<double>(hi - lo) / static_cast<double>(length);
    sampled += length;
  }
  if (terms.empty() || sampled <= 0) return out;
  out.sampled = true;
  out.sampled_ms = sampled;
  out.factor = static_cast<double>(end_ms - start_ms) / static_cast<double>(sampled);
  out.time_sql = "(" + terms + ")";
  return out;
}

std::string services_settings_sql() {
  return " SETTINGS max_execution_time = " + std::to_string(kServicesTimeBudgetSeconds) +
         ", timeout_overflow_mode = 'break', max_rows_to_group_by = " + std::to_string(kServicesGroupByCap) +
         ", group_by_overflow_mode = 'any'";
}

struct ServiceStats {
  uint64_t spans = 0, errors = 0;
  double total_ns = 0;
  uint64_t p50 = 0, p95 = 0, p99 = 0;
};

uint64_t scaled_count(uint64_t value, double factor) {
  return static_cast<uint64_t>(std::llround(static_cast<double>(value) * factor));
}

void write_service_stats(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::string& name, const ServiceStats& s, double factor) {
  w.StartArray();
  w.String(name.c_str());
  w.Uint64(scaled_count(s.spans, factor));
  w.Uint64(scaled_count(s.errors, factor));
  w.Uint64(s.p50); w.Uint64(s.p95); w.Uint64(s.p99);
  w.Uint64(static_cast<uint64_t>(std::llround(s.total_ns * factor)));
  w.EndArray();
}

} // namespace

// Per service (and, with detail=<service>, per endpoint = SpanName of that
// service): entry-span rate, errors, p50 / p95 / p99 Duration and total time
// (sum of Duration), plus the same per chart bucket (sparklines and the RED
// charts). The detail drill-down also lists the slowest entry spans and the
// first time each ResourceAttributes['service.version'] was seen (release
// markers).
void Server::handle_traces_services(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  ServicesScope scope;
  std::shared_ptr<clickhouse::Client> client;
  if (!services_scope(cfg_, client_pool_, req, res, &scope, &client)) return;
  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string span_kind = scope.span_scope == "root" ? kServiceRootSpans : kServiceEntrySpans;
  const bool detail = !scope.detail.empty();

  // The count chart grid of /api/traces/analytics (same bucket sizes and
  // bucket_origin_ms anchoring, align_buckets widens to whole buckets).
  const int64_t bucket_ms = static_cast<int64_t>(choose_trace_bucket_seconds(scope.end_ms - scope.start_ms)) * 1000;
  int64_t bucket_origin_ms = 0;
  parse_i64_param(req, "bucket_origin_ms", &bucket_origin_ms);
  const int64_t origin_ms = ((bucket_origin_ms % bucket_ms) + bucket_ms) % bucket_ms;
  const auto grid_floor = [&](int64_t t) {
    const int64_t offset = t - origin_ms;
    return origin_ms + (offset >= 0 ? offset / bucket_ms : -((-offset + bucket_ms - 1) / bucket_ms)) * bucket_ms;
  };
  const bool align_buckets = req.has_param("align_buckets") && req.get_param_value("align_buckets") == "1";
  const int64_t range_start = align_buckets ? grid_floor(scope.start_ms) : scope.start_ms;
  const int64_t range_end = align_buckets ? grid_floor(scope.end_ms + bucket_ms - 1) : scope.end_ms;
  const bool exact = req.has_param("exact") && req.get_param_value("exact") == "1";
  // The span kind test joins the time range in PREWHERE: it drops most rows
  // before Duration, StatusCode and the filter columns are read.
  const std::string kind_and_where = " AND " + span_kind + " WHERE " + visibility + scope.where;

  uint64_t estimated_rows = 0;
  uint64_t estimate_ms = 0;
  try {
    const auto started = std::chrono::steady_clock::now();
    estimated_rows = estimate_window_rows(*client, " FROM " + table + " PREWHERE " +
                                                   trace_time_predicate(scope.start_ms, scope.end_ms) + kind_and_where);
    estimate_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count());
  } catch (const std::exception&) {
    // Without an estimate the window is read whole (still time-bounded).
    if (client_pool_) client_pool_->invalidate(client);
    std::string error;
    client = acquire_trace_client(cfg_, *scope.host, client_pool_, &error);
    if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
  }
  const ServicesWindow window = services_window(scope.start_ms, scope.end_ms, bucket_ms, origin_ms, estimated_rows, exact);
  const std::string from = " FROM " + table + " PREWHERE " + window.time_sql + kind_and_where;

  const std::string bucket_sql = std::to_string(origin_ms) + " + intDiv(toUnixTimestamp64Milli(Timestamp) - " +
      std::to_string(origin_ms) + ", " + std::to_string(bucket_ms) + ") * " + std::to_string(bucket_ms);
  // One scan grouped by (service, bucket[, endpoint]) into t-digest states;
  // the outer GROUPING SETS merge them into service totals, service buckets
  // and endpoint totals. grouping(b, op): 3 service, 1 bucket, 2 endpoint (a
  // single '' endpoint per service outside the drill-down, ignored).
  const std::string inner =
      "SELECT ServiceName AS svc, " + bucket_sql + " AS b, " + (detail ? "SpanName" : "''") + " AS op, count() AS c, "
      "countIf(StatusCode = 'Error') AS e, quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS st, sum(Duration) AS s" +
      from + " GROUP BY svc, b, op";
  const std::string sql =
      "SELECT toString(grouping(b, op)), toString(svc), toString(b), toString(op), toString(sum(c)), toString(sum(e)), "
      "arrayStringConcat(arrayMap(x -> toString(toUInt64(x)), quantilesTDigestMerge(0.5, 0.95, 0.99)(st)), ','), "
      "toString(sum(s)) FROM (" + inner +
      ") GROUP BY GROUPING SETS ((svc), (svc, b), (svc, op))" + services_settings_sql();

  std::map<std::string, ServiceStats> services;
  std::map<std::string, std::map<int64_t, ServiceStats>> series;
  std::map<std::string, ServiceStats> endpoints;
  BoundedRead read;
  try {
    read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        ServiceStats stats;
        stats.spans = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)));
        stats.errors = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 5, row)));
        const auto quantiles = split_char(ch_block_text_at(block, 6, row), ',');
        if (quantiles.size() >= 3) {
          stats.p50 = static_cast<uint64_t>(std::stoull(quantiles[0]));
          stats.p95 = static_cast<uint64_t>(std::stoull(quantiles[1]));
          stats.p99 = static_cast<uint64_t>(std::stoull(quantiles[2]));
        }
        stats.total_ns = std::stod(ch_block_text_at(block, 7, row));
        const int set = std::stoi(ch_block_text_at(block, 0, row));
        const std::string service = ch_block_text_at(block, 1, row);
        if (set == 3) services[service] = stats;
        else if (set == 1) series[service][std::stoll(ch_block_text_at(block, 2, row))] = stats;
        else if (set == 2 && detail) endpoints[ch_block_text_at(block, 3, row)] = stats;
      }
    });
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(client);
    return json_error(res, 503, "trace_services_failed", e.what());
  }
  // Only the time budget stops this read (skip indexes and the slices make
  // read_rows fall short of total_rows without any cap).
  const bool partial = read.elapsed_ms + 250 >= static_cast<uint64_t>(kServicesTimeBudgetSeconds) * 1000;

  // Detail: the slowest entry spans of the (sampled) window, and releases.
  struct SlowSpan { std::string trace_id, span_id, operation, status; int64_t start_ms = 0; uint64_t duration_ns = 0; };
  std::vector<SlowSpan> slowest;
  struct Release { std::string version; int64_t first_ms = 0; uint64_t spans = 0; };
  std::vector<Release> releases;
  bool releases_supported = false, releases_estimated = false;
  uint64_t slowest_ms = 0, releases_ms = 0;
  if (detail) {
    try {
      const auto started = std::chrono::steady_clock::now();
      client->Select(
          "SELECT TraceId, SpanId, toString(SpanName), toString(toUnixTimestamp64Milli(Timestamp)), toString(Duration), "
          "toString(StatusCode)" + from + " ORDER BY Duration DESC LIMIT " + std::to_string(kServicesSlowestSpans) +
          " SETTINGS max_execution_time = " + std::to_string(kServicesTimeBudgetSeconds) + ", timeout_overflow_mode = 'break'",
          [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              slowest.push_back(SlowSpan{ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row),
                                         ch_block_text_at(block, 2, row), ch_block_text_at(block, 5, row),
                                         std::stoll(ch_block_text_at(block, 3, row)),
                                         static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row)))});
            }
          });
      slowest_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started).count());
    } catch (const std::exception& e) {
      if (client_pool_) client_pool_->invalidate(client);
      return json_error(res, 503, "trace_services_failed", e.what());
    }
    // Releases (HyperDX useReleaseAnnotations): the first span of each
    // service.version in the whole window, any span kind. The key's bloom
    // filter index skips granules without it; a read cap bounds the rest.
    releases_supported = scope.columns.resource();
    if (releases_supported) {
      try {
        const std::string version = "ResourceAttributes['service.version']";
        const BoundedRead release_read = bounded_select(
            *client,
            "SELECT " + version + " AS v, toString(toUnixTimestamp64Milli(min(Timestamp))), toString(count()) FROM " + table +
                " PREWHERE " + trace_time_predicate(scope.start_ms, scope.end_ms) + " AND ServiceName = " + quote_string(scope.detail) +
                " WHERE " + visibility + " AND mapContains(ResourceAttributes, 'service.version') AND " + version +
                " != '' GROUP BY v ORDER BY min(Timestamp) LIMIT " + std::to_string(kServicesMaxReleases) +
                facet_settings_sql(kServicesReleaseReadRowsCap, true),
            [&](const clickhouse::Block& block) {
              for (size_t row = 0; row < block.GetRowCount(); ++row) {
                releases.push_back(Release{ch_block_text_at(block, 0, row), std::stoll(ch_block_text_at(block, 1, row)),
                                           static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)))});
              }
            });
        releases_estimated = release_read.read_rows >= kServicesReleaseReadRowsCap || timed_out(release_read);
        releases_ms = release_read.elapsed_ms;
      } catch (const std::exception&) {
        // Markers are decoration: a failure leaves them out.
        if (client_pool_) client_pool_->invalidate(client);
        releases.clear();
        releases_estimated = true;
      }
    }
  }

  std::vector<std::pair<std::string, ServiceStats>> endpoint_rows(endpoints.begin(), endpoints.end());
  std::sort(endpoint_rows.begin(), endpoint_rows.end(), [](const auto& a, const auto& b) {
    if (a.second.total_ns != b.second.total_ns) return a.second.total_ns > b.second.total_ns;
    return a.first < b.first;
  });

  const uint64_t total_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - request_started).count());
  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("scope"); w.String(scope.span_scope.c_str());
  w.Key("span_predicate"); w.String(span_kind.c_str());
  w.Key("detail"); w.String(scope.detail.c_str());
  w.Key("range"); w.StartArray(); w.Int64(range_start); w.Int64(range_end); w.EndArray();
  w.Key("window"); w.StartArray(); w.Int64(scope.start_ms); w.Int64(scope.end_ms); w.EndArray();
  w.Key("bucket_ms"); w.Int64(bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(origin_ms);
  w.Key("estimated"); w.Bool(window.sampled);
  w.Key("sample_fraction"); w.Double(window.sampled ? static_cast<double>(window.sampled_ms) / static_cast<double>(scope.end_ms - scope.start_ms) : 1.0);
  w.Key("estimated_rows"); w.Uint64(window.estimated_rows);
  w.Key("exact_rows_limit"); w.Uint64(kServicesExactRows);
  w.Key("partial"); w.Bool(partial);
  w.Key("timing_ms"); w.StartObject();
  w.Key("estimate"); w.Uint64(estimate_ms);
  w.Key("services"); w.Uint64(read.elapsed_ms);
  w.Key("slowest"); w.Uint64(slowest_ms);
  w.Key("releases"); w.Uint64(releases_ms);
  w.Key("total"); w.Uint64(total_ms);
  w.EndObject();
  w.Key("columns"); w.StartArray();
  for (const char* col : {"service", "spans", "errors", "p50_ns", "p95_ns", "p99_ns", "total_ns"}) w.String(col);
  w.EndArray();
  w.Key("services"); w.StartArray();
  for (const auto& [name, stats] : services) write_service_stats(w, name, stats, window.factor);
  w.EndArray();
  w.Key("series_columns"); w.StartArray();
  for (const char* col : {"bucket_ms", "spans", "errors", "p50_ns", "p95_ns", "p99_ns"}) w.String(col);
  w.EndArray();
  w.Key("series"); w.StartObject();
  for (const auto& [name, buckets] : series) {
    w.Key(name.c_str());
    w.StartArray();
    for (const auto& [bucket, stats] : buckets) {
      const double scale = window.sampled ? window.scale_for(bucket) : 1.0;
      w.StartArray(); w.Int64(bucket); w.Uint64(scaled_count(stats.spans, scale)); w.Uint64(scaled_count(stats.errors, scale));
      w.Uint64(stats.p50); w.Uint64(stats.p95); w.Uint64(stats.p99); w.EndArray();
    }
    w.EndArray();
  }
  w.EndObject();
  if (detail) {
    w.Key("endpoints_truncated"); w.Bool(endpoint_rows.size() > kServicesMaxEndpoints);
    w.Key("endpoints"); w.StartArray();
    for (size_t i = 0; i < endpoint_rows.size() && i < kServicesMaxEndpoints; ++i) {
      write_service_stats(w, endpoint_rows[i].first, endpoint_rows[i].second, window.factor);
    }
    w.EndArray();
    w.Key("slowest_columns"); w.StartArray();
    for (const char* col : {"trace_id", "span_id", "operation", "start_ms", "duration_ns", "status"}) w.String(col);
    w.EndArray();
    w.Key("slowest"); w.StartArray();
    for (const auto& span : slowest) {
      w.StartArray(); w.String(span.trace_id.c_str()); w.String(span.span_id.c_str()); w.String(span.operation.c_str());
      w.Int64(span.start_ms); w.Uint64(span.duration_ns); w.String(span.status.c_str()); w.EndArray();
    }
    w.EndArray();
    w.Key("releases_supported"); w.Bool(releases_supported);
    w.Key("releases_estimated"); w.Bool(releases_estimated);
    w.Key("releases"); w.StartArray();
    for (const auto& release : releases) {
      w.StartArray(); w.String(release.version.c_str()); w.Int64(release.first_ms); w.Uint64(release.spans); w.EndArray();
    }
    w.EndArray();
  }
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// Database statements (HyperDX DatabaseTab): spans carrying db.query.text
// (current semconv) or db.statement (older), grouped by statement text:
// count, total time, p95 Duration, per service. Any span kind (database calls
// are Client spans). The keys' bloom filter index skips granules without
// them; a read cap, a GROUP BY cap and the time budget bound the rest and
// mark the answer estimated.
void Server::handle_traces_services_db(const httplib::Request& req, httplib::Response& res) {
  ServicesScope scope;
  std::shared_ptr<clickhouse::Client> client;
  if (!services_scope(cfg_, client_pool_, req, res, &scope, &client)) return;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  const bool supported = scope.columns.span();
  struct Statement { std::string service, statement, system; uint64_t spans = 0, errors = 0, p95 = 0; double total_ns = 0; };
  std::vector<Statement> rows;
  BoundedRead read;
  if (supported) {
    const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
    const std::string statement =
        "coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])";
    const std::string sql =
        "SELECT toString(ServiceName), " + statement + " AS stmt, "
        "any(coalesce(nullif(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system'])), toString(count()), "
        "toString(countIf(StatusCode = 'Error')), toString(sum(Duration)), toString(toUInt64(quantileTDigest(0.95)(Duration))) FROM " +
        table + " PREWHERE " + trace_time_predicate(scope.start_ms, scope.end_ms) +
        " WHERE " + service_allowlist_predicate(cfg_.traces) + scope.where +
        " AND (mapContains(SpanAttributes, 'db.query.text') OR mapContains(SpanAttributes, 'db.statement')) AND stmt != ''"
        " GROUP BY ServiceName, stmt ORDER BY sum(Duration) DESC LIMIT " + std::to_string(kServicesMaxStatements) +
        facet_settings_sql(kServicesDbReadRowsCap, true);
    try {
      read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          rows.push_back(Statement{ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row),
                                   static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 3, row))),
                                   static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 4, row))),
                                   static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 6, row))),
                                   std::stod(ch_block_text_at(block, 5, row))});
        }
      });
    } catch (const std::exception& e) {
      if (client_pool_) client_pool_->invalidate(client);
      return json_error(res, 503, "trace_services_failed", e.what());
    }
  }
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("supported"); w.Bool(supported);
  w.Key("detail"); w.String(scope.detail.c_str());
  w.Key("range"); w.StartArray(); w.Int64(scope.start_ms); w.Int64(scope.end_ms); w.EndArray();
  // Estimated only when a cap stopped the read (the bloom filter index makes
  // read_rows fall short of total_rows without one).
  w.Key("estimated"); w.Bool(read.read_rows >= kServicesDbReadRowsCap || timed_out(read));
  w.Key("timing_ms"); w.StartObject(); w.Key("query"); w.Uint64(read.elapsed_ms); w.EndObject();
  w.Key("columns"); w.StartArray();
  for (const char* col : {"service", "statement", "db_system", "spans", "errors", "total_ns", "p95_ns"}) w.String(col);
  w.EndArray();
  w.Key("statements"); w.StartArray();
  for (const auto& row : rows) {
    w.StartArray(); w.String(row.service.c_str()); w.String(row.statement.c_str()); w.String(row.system.c_str());
    w.Uint64(row.spans); w.Uint64(row.errors); w.Uint64(static_cast<uint64_t>(std::llround(row.total_ns))); w.Uint64(row.p95);
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// Spans of OTHER traces whose Links point to this trace (or to one of its
// spans). Links are stored on the linking span only, so the lookup scans
// otel_traces: always inside the trace's own window widened by
// traces.linked_from_margin_minutes on each side, never unbounded.
void Server::handle_traces_linked_from(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  if (!cfg_.traces.features.links) return json_error(res, 404, "trace_links_disabled", "Span links are disabled by traces.features.");
  const std::string trace_id = req.has_param("trace_id") ? req.get_param_value("trace_id") : std::string{};
  const std::string span_id = req.has_param("span_id") ? req.get_param_value("span_id") : std::string{};
  if (trace_id.empty()) return json_error(res, 400, "missing_trace_id", "trace_id is required.");
  if (trace_id.size() > 256) return json_error(res, 400, "invalid_trace_id", "trace_id is too long.");
  if (span_id.size() > 256) return json_error(res, 400, "invalid_span_id", "span_id is too long.");

  int64_t start_ms = 0, end_ms = 0;
  const bool has_lo = parse_i64_param(req, "start_ms", &start_ms);
  const bool has_hi = parse_i64_param(req, "end_ms", &end_ms);
  if (has_lo != has_hi) return json_error(res, 400, "invalid_trace_range", "start_ms and end_ms must be provided together.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const std::string trace_literal = quote_string(trace_id);
  std::string range_source = "request";
  if (!has_lo) {
    // No window from the caller: the trace index gives the trace's bounds.
    if (cfg_.traces.trace_index_table.empty()) {
      return json_error(res, 503, "trace_index_unavailable", "Linked-from lookups without start_ms/end_ms require traces.trace_index_table.");
    }
    uint64_t count = 0;
    try {
      client->Select(
          "SELECT toString(count()), toString(toUnixTimestamp64Milli(min(Start))), toString(toUnixTimestamp64Milli(max(End))) FROM " +
              qualified(cfg_.traces.database, cfg_.traces.trace_index_table) + " WHERE TraceId = " + trace_literal,
          [&](const clickhouse::Block& block) {
            if (!block.GetRowCount()) return;
            count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
            if (count) {
              start_ms = std::stoll(ch_block_text_at(block, 1, 0));
              end_ms = std::stoll(ch_block_text_at(block, 2, 0)) + 1;
            }
          });
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_index_lookup_failed", e.what());
    }
    if (!count) return json_error(res, 404, "trace_not_found", "Trace was not found in the trace index.");
    range_source = "trace_index";
  }
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  const int64_t margin_ms = static_cast<int64_t>(cfg_.traces.linked_from_margin_minutes) * 60 * 1000;
  if (start_ms < 0 || end_ms < start_ms || end_ms > kMaxTraceTimeMs - margin_ms) {
    return json_error(res, 400, "invalid_trace_range", "Invalid trace time range.");
  }
  if (end_ms - start_ms > static_cast<int64_t>(cfg_.traces.max_lookback_minutes) * 60 * 1000) {
    return json_error(res, 400, "invalid_trace_range", "Trace time range exceeds traces.max_lookback_minutes.");
  }
  const int64_t lo_ms = std::max<int64_t>(0, start_ms - margin_ms);
  const int64_t hi_ms = end_ms + margin_ms;

  // has() reads Links.TraceId alone (PREWHERE); a span id also needs the pair
  // to match, so the zipped arrays are checked for the remaining rows.
  const std::string link_match = span_id.empty()
      ? "t = trace"
      : "t = trace AND s = " + quote_string(span_id);
  const std::string sql =
      "WITH " + trace_literal + " AS trace SELECT " + kSpanListColumns +
      ", toJSONString(arrayFilter((s, t) -> " + link_match + ", Links.SpanId, Links.TraceId))"
      ", toJSONString(arrayFilter((a, t, s) -> " + link_match + ", Links.Attributes, Links.TraceId, Links.SpanId))"
      " FROM " + qualified(cfg_.traces.database, cfg_.traces.table) +
      " PREWHERE has(Links.TraceId, trace)"
      " WHERE " + trace_time_predicate(lo_ms, hi_ms) + " AND TraceId != trace AND " + service_allowlist_predicate(cfg_.traces) +
      (span_id.empty() ? std::string{} : " AND arrayExists((t, s) -> " + link_match + ", Links.TraceId, Links.SpanId)") +
      " ORDER BY Timestamp DESC, SpanId DESC LIMIT " + std::to_string(kLinkedFromLimit + 1) +
      " SETTINGS max_execution_time = 15";

  std::vector<SpanListRow> rows;
  const auto started = std::chrono::steady_clock::now();
  try {
    select_span_rows(*client, sql, &rows, true);
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_linked_from_failed", e.what());
  }
  const double elapsed = elapsed_ms_since(started);
  const bool truncated = rows.size() > kLinkedFromLimit;
  if (truncated) rows.resize(kLinkedFromLimit);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("trace_id"); w.String(trace_id.c_str());
  w.Key("span_id"); w.String(span_id.c_str());
  w.Key("range_source"); w.String(range_source.c_str());
  w.Key("range"); w.StartArray(); w.Int64(lo_ms); w.Int64(hi_ms); w.EndArray();
  w.Key("margin_minutes"); w.Int(cfg_.traces.linked_from_margin_minutes);
  w.Key("limit"); w.Uint64(kLinkedFromLimit);
  w.Key("truncated"); w.Bool(truncated);
  w.Key("elapsed_ms"); w.Double(elapsed);
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) write_span_row(w, row, true);
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// Spans around an anchor timestamp (±window_ms), newest first, with a keyset
// cursor on (Timestamp, SpanId) in both directions. "around" returns the
// spans nearest the anchor on each side. Every read is bounded by the window;
// "service" hits the ServiceName primary-key prefix, the others rely on the
// time bound (and the attribute bloom filters).
void Server::handle_traces_context(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  int64_t anchor_ns = 0;
  if (!parse_i64_param(req, "timestamp_ns", &anchor_ns)) return json_error(res, 400, "missing_timestamp", "timestamp_ns is required.");
  int64_t window_ms = 60000;
  if (req.has_param("window_ms") && !parse_i64_param(req, "window_ms", &window_ms)) window_ms = -1;
  if (std::find(std::begin(kContextWindowsMs), std::end(kContextWindowsMs), window_ms) == std::end(kContextWindowsMs)) {
    return json_error(res, 400, "invalid_context_window", "window_ms must be 1000, 10000, 60000 or 300000.");
  }
  const int64_t window_ns = window_ms * kNsPerMs;
  if (anchor_ns < window_ns || anchor_ns > INT64_MAX - window_ns) return json_error(res, 400, "invalid_timestamp", "timestamp_ns is out of range.");

  const std::string filter = req.has_param("filter") && !req.get_param_value("filter").empty() ? req.get_param_value("filter") : "any";
  const std::string direction = req.has_param("direction") && !req.get_param_value("direction").empty() ? req.get_param_value("direction") : "around";
  if (direction != "around" && direction != "older" && direction != "newer") {
    return json_error(res, 400, "invalid_direction", "direction must be around, older or newer.");
  }
  const int limit = int_param(req, "limit", 50, 1, 200);
  int64_t cursor_ns = 0;
  const std::string cursor_span = req.has_param("cursor_span_id") ? req.get_param_value("cursor_span_id") : std::string{};
  if (direction != "around") {
    if (!parse_i64_param(req, "cursor_ns", &cursor_ns)) return json_error(res, 400, "missing_cursor", "cursor_ns is required to page older or newer.");
    if (cursor_span.size() > 256) return json_error(res, 400, "invalid_cursor", "cursor_span_id is too long.");
  }

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  std::string filter_sql;
  if (filter == "service") {
    const std::string service = param("service");
    if (service.empty() || service.size() > 1024) return json_error(res, 400, "invalid_context_filter", "service is required for the service filter.");
    filter_sql = "ServiceName = " + quote_string(service);
  } else if (filter == "host" || filter == "pod" || filter == "attribute") {
    std::string scope = "resource", key, value;
    if (filter == "attribute") {
      scope = param("attr_scope");
      key = param("attr_key");
      value = param("attr_value");
      if (scope != "span" && scope != "resource") return json_error(res, 400, "invalid_context_filter", "attr_scope must be span or resource.");
      if (key.empty() || key.size() > 256) return json_error(res, 400, "invalid_context_filter", "attr_key must be 1 to 256 bytes.");
    } else {
      key = filter == "host" ? "host.name" : "k8s.pod.name";
      value = param("value");
      if (value.empty()) return json_error(res, 400, "invalid_context_filter", "value is required for the " + filter + " filter.");
    }
    if (value.size() > 4096) return json_error(res, 400, "invalid_context_filter", "The attribute value is too long.");
    const bool resource = scope == "resource";
    if (!(resource ? cfg_.traces.features.resource_attributes : cfg_.traces.features.span_attributes)) {
      return json_error(res, 400, "context_filter_disabled", std::string(resource ? "resource" : "span") + " attributes are disabled by traces.features.");
    }
    bool span_map = false, resource_map = false;
    cached_trace_attribute_maps(*client, *host, cfg_.traces, &span_map, &resource_map);
    if (!(resource ? resource_map : span_map)) {
      return json_error(res, 400, "context_filter_unavailable", "Attribute filters need Map attribute columns.");
    }
    const std::string column = resource ? "ResourceAttributes" : "SpanAttributes";
    filter_sql = "mapContains(" + column + ", " + quote_string(key) + ") AND " + column + "[" + quote_string(key) + "] = " + quote_string(value);
  } else if (filter != "any") {
    return json_error(res, 400, "invalid_context_filter", "filter must be any, service, host, pod or attribute.");
  }

  const int64_t lo_ns = anchor_ns - window_ns;
  const int64_t hi_ns = anchor_ns + window_ns;
  const std::string base =
      " FROM " + qualified(cfg_.traces.database, cfg_.traces.table) +
      " WHERE Timestamp >= " + ns_time(lo_ns) + " AND Timestamp <= " + ns_time(hi_ns) +
      " AND " + service_allowlist_predicate(cfg_.traces) + (filter_sql.empty() ? std::string{} : " AND " + filter_sql);
  const std::string settings = " SETTINGS max_execution_time = 10";
  const auto older_sql = [&](const std::string& keyset, int n) {
    return std::string("SELECT ") + kSpanListColumns + base + " AND " + keyset +
           " ORDER BY Timestamp DESC, SpanId DESC LIMIT " + std::to_string(n + 1) + settings;
  };
  const auto newer_sql = [&](const std::string& keyset, int n) {
    return std::string("SELECT ") + kSpanListColumns + base + " AND " + keyset +
           " ORDER BY Timestamp ASC, SpanId ASC LIMIT " + std::to_string(n + 1) + settings;
  };
  const std::string cursor_time = ns_time(cursor_ns);
  const std::string cursor_id = quote_string(cursor_span);

  std::vector<SpanListRow> older, newer;
  bool query_older = false, query_newer = false, more_older = false, more_newer = false;
  const auto started = std::chrono::steady_clock::now();
  try {
    if (direction == "around") {
      const int newer_limit = limit / 2;
      const int older_limit = limit - newer_limit;
      query_older = true;
      select_span_rows(*client, older_sql("Timestamp <= " + ns_time(anchor_ns), older_limit), &older, false);
      more_older = older.size() > static_cast<size_t>(older_limit);
      if (more_older) older.resize(older_limit);
      query_newer = true;
      if (newer_limit > 0) {
        select_span_rows(*client, newer_sql("Timestamp > " + ns_time(anchor_ns), newer_limit), &newer, false);
        more_newer = newer.size() > static_cast<size_t>(newer_limit);
        if (more_newer) newer.resize(newer_limit);
      } else {
        std::vector<SpanListRow> probe;
        select_span_rows(*client, newer_sql("Timestamp > " + ns_time(anchor_ns), 0), &probe, false);
        more_newer = !probe.empty();
      }
    } else if (direction == "older") {
      query_older = true;
      select_span_rows(*client, older_sql("(Timestamp < " + cursor_time + " OR (Timestamp = " + cursor_time + " AND SpanId < " + cursor_id + "))", limit), &older, false);
      more_older = older.size() > static_cast<size_t>(limit);
      if (more_older) older.resize(limit);
    } else {
      query_newer = true;
      select_span_rows(*client, newer_sql("(Timestamp > " + cursor_time + " OR (Timestamp = " + cursor_time + " AND SpanId > " + cursor_id + "))", limit), &newer, false);
      more_newer = newer.size() > static_cast<size_t>(limit);
      if (more_newer) newer.resize(limit);
    }
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_context_failed", e.what());
  }
  const double elapsed = elapsed_ms_since(started);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("timestamp_ns"); w.String(std::to_string(anchor_ns).c_str());
  w.Key("window_ms"); w.Int64(window_ms);
  w.Key("range_ns"); w.StartArray(); w.String(std::to_string(lo_ns).c_str()); w.String(std::to_string(hi_ns).c_str()); w.EndArray();
  w.Key("filter"); w.String(filter.c_str());
  w.Key("direction"); w.String(direction.c_str());
  w.Key("limit"); w.Int(limit);
  if (query_newer) { w.Key("has_newer"); w.Bool(more_newer); }
  if (query_older) { w.Key("has_older"); w.Bool(more_older); }
  w.Key("elapsed_ms"); w.Double(elapsed);
  w.Key("rows"); w.StartArray();
  for (auto it = newer.rbegin(); it != newer.rend(); ++it) write_span_row(w, *it, false);
  for (const auto& row : older) write_span_row(w, row, false);
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_trace_detail(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  if (!req.has_param("trace_id") || req.get_param_value("trace_id").empty()) {
    return json_error(res, 400, "missing_trace_id", "trace_id is required.");
  }
  const std::string trace_id = req.get_param_value("trace_id");
  if (trace_id.size() > 256) return json_error(res, 400, "invalid_trace_id", "trace_id is too long.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto& f = cfg_.traces.features;
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string span_attrs = f.span_attributes ? "toJSONString(SpanAttributes)" : "'{}'";
  const std::string resource_attrs = f.resource_attributes ? "toJSONString(ResourceAttributes)" : "'{}'";
  const std::string events_ts = f.events ? "toJSONString(Events.Timestamp)" : "'[]'";
  const std::string events_name = f.events ? "toJSONString(Events.Name)" : "'[]'";
  const std::string events_attrs = f.events ? "toJSONString(Events.Attributes)" : "'[]'";
  const std::string links_trace = f.links ? "toJSONString(Links.TraceId)" : "'[]'";
  const std::string links_span = f.links ? "toJSONString(Links.SpanId)" : "'[]'";
  const std::string links_attrs = f.links ? "toJSONString(Links.Attributes)" : "'[]'";
  const std::string main_table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string trace_literal = quote_string(trace_id);
  const size_t limit = cfg_.traces.max_spans_per_trace + 1;

  const std::string select_columns =
      "SELECT toString(Timestamp), toString(toUnixTimestamp64Nano(Timestamp)), toString(TraceId), toString(SpanId), "
      "toString(ParentSpanId), toString(SpanName), toString(SpanKind), toString(ServiceName), toString(Duration), "
      "toString(StatusCode), toString(StatusMessage), " + span_attrs + ", " + resource_attrs + ", " +
      events_ts + ", " + events_name + ", " + events_attrs + ", " + links_trace + ", " + links_span + ", " + links_attrs + " ";

  struct Span {
    std::string timestamp, trace_id, span_id, parent_span_id, name, kind, service, status, status_message;
    std::string span_attributes, resource_attributes, events_timestamp, events_name, events_attributes;
    std::string links_trace_id, links_span_id, links_attributes;
    int64_t start_ns = 0;
    uint64_t duration_ns = 0;
  };
  std::vector<Span> spans;

  auto load_spans = [&](const std::string& sql) {
    client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        Span out;
        out.timestamp = ch_block_text_at(block, 0, row);
        out.start_ns = std::stoll(ch_block_text_at(block, 1, row));
        out.trace_id = ch_block_text_at(block, 2, row);
        out.span_id = ch_block_text_at(block, 3, row);
        out.parent_span_id = ch_block_text_at(block, 4, row);
        out.name = ch_block_text_at(block, 5, row);
        out.kind = ch_block_text_at(block, 6, row);
        out.service = ch_block_text_at(block, 7, row);
        out.duration_ns = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 8, row)));
        out.status = ch_block_text_at(block, 9, row);
        out.status_message = ch_block_text_at(block, 10, row);
        out.span_attributes = ch_block_text_at(block, 11, row);
        out.resource_attributes = ch_block_text_at(block, 12, row);
        out.events_timestamp = ch_block_text_at(block, 13, row);
        out.events_name = ch_block_text_at(block, 14, row);
        out.events_attributes = ch_block_text_at(block, 15, row);
        out.links_trace_id = ch_block_text_at(block, 16, row);
        out.links_span_id = ch_block_text_at(block, 17, row);
        out.links_attributes = ch_block_text_at(block, 18, row);
        spans.push_back(std::move(out));
      }
    });
  };

  if (cfg_.traces.trace_index_table.empty()) {
    return json_error(res, 503, "trace_index_unavailable", "Trace detail requires traces.trace_index_table.");
  }

  try {
    const std::string index_table = qualified(cfg_.traces.database, cfg_.traces.trace_index_table);
    // One index lookup yields both bounds (previously two scalar subqueries
    // each read the trace's index rows).
    const std::string indexed_sql =
        "WITH " + trace_literal + " AS trace, "
        "(SELECT tuple(min(Start) - toIntervalSecond(1), max(End) + toIntervalSecond(1)) FROM " + index_table +
        " WHERE TraceId = trace) AS trace_bounds " +
        select_columns +
        "FROM " + main_table + " PREWHERE Timestamp >= tupleElement(trace_bounds, 1) AND Timestamp <= tupleElement(trace_bounds, 2) "
        "WHERE TraceId = trace AND " + visibility +
        " ORDER BY Timestamp, SpanId LIMIT " + std::to_string(limit);
    load_spans(indexed_sql);
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_index_lookup_failed", e.what());
  }

  bool truncated = spans.size() > cfg_.traces.max_spans_per_trace;
  if (truncated) spans.resize(cfg_.traces.max_spans_per_trace);
  if (spans.empty()) return json_error(res, 404, "trace_not_found", "Trace was not found in the configured time scope.");

  // Do not leak the SpanId of a parent that was hidden by the service
  // allowlist. Treat the first visible descendant as a visible root instead.
  std::unordered_set<std::string> visible_span_ids;
  visible_span_ids.reserve(spans.size());
  for (const auto& span : spans) visible_span_ids.insert(span.span_id);
  for (auto& span : spans) {
    if (!span.parent_span_id.empty() && visible_span_ids.count(span.parent_span_id) == 0) {
      span.parent_span_id.clear();
    }
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("trace_id"); w.String(trace_id.c_str());
  w.Key("range_source"); w.String("trace_index");
  w.Key("truncated"); w.Bool(truncated);
  w.Key("spans"); w.StartArray();
  for (const auto& span : spans) {
    w.StartObject();
    w.Key("timestamp"); w.String(span.timestamp.c_str());
    w.Key("start_ns"); w.Int64(span.start_ns);
    w.Key("duration_ns"); w.Uint64(span.duration_ns);
    w.Key("trace_id"); w.String(span.trace_id.c_str());
    w.Key("span_id"); w.String(span.span_id.c_str());
    w.Key("parent_span_id"); w.String(span.parent_span_id.c_str());
    w.Key("span_name"); w.String(span.name.c_str());
    w.Key("span_kind"); w.String(span.kind.c_str());
    w.Key("service_name"); w.String(span.service.c_str());
    w.Key("status_code"); w.String(span.status.c_str());
    w.Key("status_message"); w.String(span.status_message.c_str());
    if (f.span_attributes) { w.Key("span_attributes"); w.String(span.span_attributes.c_str()); }
    if (f.resource_attributes) { w.Key("resource_attributes"); w.String(span.resource_attributes.c_str()); }
    if (f.events) {
      w.Key("events_timestamp"); w.String(span.events_timestamp.c_str());
      w.Key("events_name"); w.String(span.events_name.c_str());
      w.Key("events_attributes"); w.String(span.events_attributes.c_str());
    }
    if (f.links) {
      w.Key("links_trace_id"); w.String(span.links_trace_id.c_str());
      w.Key("links_span_id"); w.String(span.links_span_id.c_str());
      w.Key("links_attributes"); w.String(span.links_attributes.c_str());
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// --- Duration heatmap and box-select attribute deltas ----------------------
// After HyperDX's DBSearchHeatmapChart / DBDeltaChart ("why is this slow").
// The unit is the trace, exactly as in the "Trace duration" percentiles:
// traces with at least one matching visible span, each placed at its first
// span start with its span-bounds duration (see handle_traces_analytics). So
// the Percentiles / Heatmap toggle shows the same traces, and a box maps to
// the search's own time range + min / max trace duration filters.
namespace {

constexpr int kHeatmapBinsPerOctave = 32;  // fine log2 bins (~2.2 % wide)
constexpr int kHeatmapTimeBudgetSeconds = 55;  // below the 60 s receive timeout
constexpr int kDeltaTimeBudgetSeconds = 30;
constexpr int64_t kDeltaMaxCoreMs = 30LL * 60 * 1000;  // box time sampled at most
constexpr int kDeltaSlices = 6;
constexpr int kDeltaDefaultSample = 1000;
constexpr int kDeltaMaxSample = 2500;  // per side: keeps the IN lists < 256 KiB
constexpr size_t kDeltaTopValuesPerKey = 40;  // read per key, before ranking
constexpr size_t kDeltaMaxKeys = 20;
constexpr size_t kDeltaValuesShown = 6;
constexpr size_t kDeltaMaxValueBytes = 1024;
constexpr uint64_t kDeltaMinOccurrences = 5;  // HyperDX MIN_PROPERTY_OCCURENCES

const char* kTraceDurationExpr =
    "(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
    "toInt64(min(toUnixTimestamp64Nano(Timestamp))))";

// What /api/traces/heatmap and /api/traces/deltas share with
// /api/traces/analytics: the window, the span filters and the trace duration
// filters, validated the same way.
struct TraceWindowRequest {
  std::string source_host_id;
  const HostSpec* host = nullptr;
  int64_t start_ms = 0, end_ms = 0;
  TraceFilterSpec filters;
  std::string span_filters;  // " AND ..." or empty
  std::string having;        // " HAVING <duration> ..." or empty
  std::string table, index_table, visibility;
  std::shared_ptr<clickhouse::Client> client;
};

bool trace_window_request(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool,
                          const httplib::Request& req, httplib::Response& res, TraceWindowRequest* out) {
  if (!cfg.traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled."); return false; }
  if (!cfg.traces.analytics) {
    json_error(res, 404, "trace_analytics_disabled", "Trace analytics are disabled by configuration.");
    return false;
  }
  std::string error;
  if (feature_param_rejected(cfg.traces, req, &error)) { json_error(res, 400, "trace_filter_disabled", error); return false; }
  out->host = trace_host(cfg, req, &out->source_host_id);
  if (!out->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  if (!trace_time_range(cfg.traces, req, &out->start_ms, &out->end_ms, &error)) {
    json_error(res, 400, "invalid_trace_range", error);
    return false;
  }
  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
    return false;
  }
  if (!parse_trace_filters(req, &out->filters, &error)) { json_error(res, 400, "invalid_trace_filter", error); return false; }
  out->client = acquire_trace_client(cfg, *out->host, pool, &error);
  if (!out->client) {
    json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    return false;
  }
  std::string filter_code, filter_error;
  if (!trace_filters_sql(*out->client, *out->host, cfg.traces, out->filters, &out->span_filters, &filter_code, &filter_error)) {
    json_error(res, 400, filter_code, filter_error);
    return false;
  }
  if (min_duration_ms > 0.0) {
    out->having += std::string(out->having.empty() ? " HAVING " : " AND ") + kTraceDurationExpr + " >= " +
                   std::to_string(static_cast<uint64_t>(std::llround(min_duration_ms * 1000000.0)));
  }
  if (max_duration_ms > 0.0) {
    out->having += std::string(out->having.empty() ? " HAVING " : " AND ") + kTraceDurationExpr + " <= " +
                   std::to_string(static_cast<uint64_t>(std::llround(max_duration_ms * 1000000.0)));
  }
  out->table = qualified(cfg.traces.database, cfg.traces.table);
  out->index_table = cfg.traces.trace_index_table.empty() ? std::string{} : qualified(cfg.traces.database, cfg.traces.trace_index_table);
  out->visibility = service_allowlist_predicate(cfg.traces);
  return true;
}

int64_t grid_floor_ms(int64_t t, int64_t size_ms, int64_t origin) {
  const int64_t offset = t - origin;
  return origin + (offset >= 0 ? offset / size_ms : -((-offset + size_ms - 1) / size_ms)) * size_ms;
}

std::string grid_bucket_expr(const std::string& column, int64_t size_ms, int64_t origin) {
  return "toString(" + std::to_string(origin) + " + intDiv(toUnixTimestamp64Milli(" + column + ") - " +
         std::to_string(origin) + ", " + std::to_string(size_ms) + ") * " + std::to_string(size_ms) + ")";
}

double fine_bin_edge_ns(int bin) {
  return std::exp2(static_cast<double>(bin) / kHeatmapBinsPerOctave);
}

uint64_t elapsed_ms_u64(std::chrono::steady_clock::time_point started) {
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count());
}

// --- Delta heuristics (HyperDX eventDeltas.ts) ---

std::string lower_ascii(std::string_view text) {
  std::string out(text);
  for (char& ch : out) if (ch >= 'A' && ch <= 'Z') ch = static_cast<char>(ch - 'A' + 'a');
  return out;
}

bool ends_with(std::string_view text, std::string_view suffix) {
  return text.size() >= suffix.size() && text.substr(text.size() - suffix.size()) == suffix;
}

// Identifier and timestamp keys: every value is (nearly) unique, so they never
// explain a difference and would crowd the ranking. The high-cardinality rule
// below catches most of them anyway; the names catch small samples.
bool id_or_time_key(std::string_view key) {
  const std::string k = lower_ascii(key);
  for (std::string_view suffix : {"trace_id", "traceid", "span_id", "spanid", "parent_id", "parentid",
                                  "request_id", "requestid", "correlation_id", "uuid", "guid",
                                  "timestamp", "time_unix_nano", "_time", ".time", "_at", ".ts"}) {
    if (ends_with(k, suffix)) return true;
  }
  return false;
}

bool id_like_value(std::string_view value) {
  size_t hex = 0, digits = 0;
  for (char ch : value) {
    if ((ch >= '0' && ch <= '9')) { ++hex; ++digits; }
    else if ((ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) ++hex;
    else if (ch != '-') return false;
  }
  return (value.size() >= 16 && hex >= 16) || digits >= 13;
}

// Well-known OTel semantic-convention keys win ties (HyperDX semanticBoost).
bool semconv_key(std::string_view key) {
  const std::string k = lower_ascii(key);
  for (std::string_view suffix : {"service.name", "http.method", "http.request.method", "http.status_code",
                                  "http.response.status_code", "http.route", "error", "error.type", "exception.type",
                                  "deployment.environment", "deployment.environment.name", "rpc.method", "rpc.service",
                                  "rpc.grpc.status_code", "db.system", "db.operation", "db.operation.name",
                                  "messaging.system", "messaging.operation", "k8s.pod.name", "host.name",
                                  "cloud.region", "service.version"}) {
    if (k == suffix || ends_with(k, std::string(".") + std::string(suffix))) return true;
  }
  return false;
}

}  // namespace

// GET /api/traces/heatmap: trace counts per (time bucket, log-scaled duration
// row), same parameters as /api/traces/analytics plus rows (8..80, default 40).
//
// One pass instead of HyperDX's two (quantile / max, then widthBucket): the
// traces are counted into fixed log2 bins (32 per octave) per time bucket,
// then the server derives the displayed scale from that histogram itself
// (lowest row edge = the bin holding the 1 % quantile, top = the slowest
// bin) and merges the fine bins into `rows` rows. Row edges therefore lie on
// fine-bin edges and every count is exact; traces faster than the lowest row
// are counted in it (greatest(duration, min)). A separate bounds pass would
// read the same spans twice: the trace aggregation is the whole cost.
void Server::handle_traces_heatmap(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  TraceWindowRequest scope;
  if (!trace_window_request(cfg_, client_pool_, req, res, &scope)) return;
  const int rows_wanted = int_param(req, "rows", 40, 8, 80);

  const int64_t bucket_ms = static_cast<int64_t>(choose_trace_bucket_seconds(scope.end_ms - scope.start_ms)) * 1000;
  int64_t bucket_origin_ms = 0;
  parse_i64_param(req, "bucket_origin_ms", &bucket_origin_ms);
  const int64_t origin = ((bucket_origin_ms % bucket_ms) + bucket_ms) % bucket_ms;
  const bool align_buckets = req.has_param("align_buckets") && req.get_param_value("align_buckets") == "1";
  const int64_t range_start = align_buckets ? grid_floor_ms(scope.start_ms, bucket_ms, origin) : scope.start_ms;
  const int64_t range_end = align_buckets ? grid_floor_ms(scope.end_ms + bucket_ms - 1, bucket_ms, origin) : scope.end_ms;

  const std::string time_predicate = trace_time_predicate(scope.start_ms, scope.end_ms);
  const bool has_filters = !scope.span_filters.empty();
  std::map<std::pair<int64_t, int>, uint64_t> fine_cells;
  std::map<int, uint64_t> fine_totals;
  uint64_t query_ms = 0;
  bool broad = false;
  try {
    const auto started = std::chrono::steady_clock::now();
    // The analytics' own cheap path for broad service / operation filters.
    broad = has_filters && scope.filters.key_only() && filters_are_broad(
        *scope.client, scope.table, scope.index_table, time_predicate, scope.visibility, scope.span_filters,
        scope.start_ms, scope.end_ms);
    const std::string candidates = has_filters && !broad
        ? "candidate_ids AS (SELECT TraceId FROM " + scope.table + " PREWHERE " + time_predicate + " WHERE " +
          scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId), "
        : std::string{};
    const std::string candidate_where = has_filters && !broad ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : std::string{};
    const std::string having = broad
        ? " HAVING countIf(1" + scope.span_filters + ") > 0" + (scope.having.empty() ? std::string{} : " AND " + having_terms(scope.having))
        : scope.having;
    const std::string sql =
        "WITH " + candidates + "trace_durations AS (SELECT min(Timestamp) AS trace_start, " + kTraceDurationExpr +
        " AS duration_ns FROM " + scope.table + " PREWHERE " + time_predicate + " WHERE " + scope.visibility +
        candidate_where + " GROUP BY TraceId" + having + ") "
        "SELECT " + grid_bucket_expr("trace_start", bucket_ms, origin) + " AS bucket_ms, "
        "toString(toInt32(floor(log2(greatest(duration_ns, 1)) * " + std::to_string(kHeatmapBinsPerOctave) + "))) AS fine_bin, "
        "toString(count()) FROM trace_durations GROUP BY bucket_ms, fine_bin"
        " SETTINGS max_execution_time = " + std::to_string(kHeatmapTimeBudgetSeconds);
    scope.client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const int64_t bucket = std::stoll(ch_block_text_at(block, 0, row));
        const int bin = std::stoi(ch_block_text_at(block, 1, row));
        const uint64_t count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
        fine_cells[{bucket, bin}] += count;
        fine_totals[bin] += count;
      }
    });
    query_ms = elapsed_ms_u64(started);
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_heatmap_failed", e.what());
  }

  uint64_t total = 0;
  for (const auto& [bin, count] : fine_totals) total += count;
  int lo_bin = 0, hi_bin = 0, rows = 0;
  uint64_t below_count = 0;
  std::map<std::pair<int64_t, int>, uint64_t> cells;
  std::vector<double> edges;
  if (total > 0) {
    // The fine bin holding the 1 % quantile, and the slowest bin.
    const uint64_t cut = std::max<uint64_t>(1, static_cast<uint64_t>(std::ceil(static_cast<double>(total) * 0.01)));
    uint64_t seen = 0;
    lo_bin = fine_totals.begin()->first;
    for (const auto& [bin, count] : fine_totals) {
      seen += count;
      if (seen >= cut) { lo_bin = bin; break; }
    }
    hi_bin = fine_totals.rbegin()->first;
    const int span = hi_bin - lo_bin + 1;
    rows = std::min(rows_wanted, span);
    // Row r holds the fine bins f with floor((f - lo) * rows / span) == r.
    const auto row_of = [&](int bin) { return bin <= lo_bin ? 0 : static_cast<int>((static_cast<int64_t>(bin - lo_bin) * rows) / span); };
    for (int r = 0; r <= rows; ++r) {
      const int first_bin = lo_bin + static_cast<int>((static_cast<int64_t>(r) * span + rows - 1) / rows);
      edges.push_back(fine_bin_edge_ns(first_bin));
    }
    for (const auto& [key, count] : fine_cells) {
      cells[{key.first, row_of(key.second)}] += count;
      if (key.second < lo_bin) below_count += count;
    }
  }
  uint64_t max_count = 0;
  for (const auto& [key, count] : cells) max_count = std::max(max_count, count);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("unit"); w.String("traces");
  w.Key("unit_label"); w.String("Traces with a matching span, at their first span start, by span-bounds duration");
  w.Key("duration_source"); w.String("span_bounds");
  w.Key("heatmap_path"); w.String(broad ? "broad_filters" : has_filters ? "candidate_filters" : "span_aggregation");
  w.Key("range"); w.StartArray(); w.Int64(range_start); w.Int64(range_end); w.EndArray();
  w.Key("bucket_ms"); w.Int64(bucket_ms);
  w.Key("bucket_origin_ms"); w.Int64(origin);
  w.Key("bins_per_octave"); w.Int(kHeatmapBinsPerOctave);
  w.Key("rows"); w.Int(rows);
  w.Key("y_edges_ns"); w.StartArray();
  for (double edge : edges) w.Double(std::round(edge * 1000.0) / 1000.0);
  w.EndArray();
  w.Key("total"); w.Uint64(total);
  w.Key("below_min_count"); w.Uint64(below_count);
  w.Key("max_count"); w.Uint64(max_count);
  w.Key("cells"); w.StartArray();
  for (const auto& [key, count] : cells) {
    w.StartArray(); w.Int64(key.first); w.Int(key.second); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("heatmap"); w.Uint64(query_ms);
  w.Key("total"); w.Uint64(elapsed_ms_u64(request_started));
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// GET /api/traces/deltas: which attribute values set the traces of a heatmap
// box apart. Parameters: the heatmap's (window + filters) plus the box
// t0 / t1 (epoch ms, trace start) and d0 / d1 (trace duration, ms), baseline
// (outside: the other traces of the box's time range, default; all: every
// trace of that time range) and sample (per side, 100..2500, default 1000).
//
//  1. Two stable samples: the box's time range (sampled as up to 6 evenly
//     spread 5-minute slices when it is wider than 30 minutes, so the cost is
//     bounded whatever the box) is aggregated per trace like the analytics;
//     traces in the duration range form the selection, the others the
//     baseline; each side keeps its first `sample` traces by cityHash64(TraceId)
//     (the same traces on every request).
//  2. One aggregation over the spans of the sampled traces only: ARRAY JOIN of
//     the span and resource attribute maps plus ServiceName / SpanName /
//     StatusCode, counting per (key, value) the sampled traces of each side
//     having a span with it (a filter on that value matches exactly those
//     traces). Per key: the values ranked by share of sampled traces.
//  3. Ranking (HyperDX eventDeltas.ts): keys seen fewer than 5 times,
//     identifier / timestamp keys and high-cardinality keys (> 90 % unique
//     values on both sides, > 20 occurrences) are hidden; a key's score is the
//     largest |selection % - baseline %| of its values, + 2 points for OTel
//     semantic-convention keys and the three columns. Top 20 keys, top 6
//     values each.
void Server::handle_traces_deltas(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  TraceWindowRequest scope;
  if (!trace_window_request(cfg_, client_pool_, req, res, &scope)) return;

  int64_t t0 = 0, t1 = 0;
  if (!parse_i64_param(req, "t0", &t0) || !parse_i64_param(req, "t1", &t1) || t1 <= t0) {
    return json_error(res, 400, "invalid_trace_box", "t0 and t1 (epoch ms, t0 < t1) are required.");
  }
  t0 = std::max(t0, scope.start_ms);
  t1 = std::min(t1, scope.end_ms);
  if (t1 <= t0) return json_error(res, 400, "invalid_trace_box", "The box lies outside the time range.");
  const double d0_ms = double_param(req, "d0", -1.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double d1_ms = double_param(req, "d1", -1.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (d0_ms < 0.0 || d1_ms <= 0.0 || d0_ms > d1_ms) {
    return json_error(res, 400, "invalid_trace_box", "d0 and d1 (trace duration in ms, d0 <= d1) are required.");
  }
  const std::string baseline = req.has_param("baseline") ? req.get_param_value("baseline") : std::string("outside");
  if (baseline != "outside" && baseline != "all") {
    return json_error(res, 400, "invalid_trace_baseline", "baseline must be outside or all.");
  }
  const int sample = int_param(req, "sample", kDeltaDefaultSample, 100, kDeltaMaxSample);
  const uint64_t d0_ns = static_cast<uint64_t>(std::llround(d0_ms * 1000000.0));
  const uint64_t d1_ns = static_cast<uint64_t>(std::llround(d1_ms * 1000000.0));

  // Sampled slices of the box's time range ("cores": trace starts), each read
  // with a margin so that a selected trace's later spans and an earlier start
  // are seen (a trace no longer than d1 is aggregated exactly).
  std::vector<std::pair<int64_t, int64_t>> cores;
  const int64_t width = t1 - t0;
  if (width <= kDeltaMaxCoreMs) {
    cores.emplace_back(t0, t1);
  } else {
    const int64_t slice = kDeltaMaxCoreMs / kDeltaSlices;
    for (int i = 0; i < kDeltaSlices; ++i) {
      const int64_t center = t0 + static_cast<int64_t>((static_cast<double>(i) + 0.5) * static_cast<double>(width) / kDeltaSlices);
      cores.emplace_back(std::max(t0, center - slice / 2), std::min(t1, center + slice / 2));
    }
  }
  const int64_t margin_ms = std::max<int64_t>(1000, std::min<int64_t>(300000, static_cast<int64_t>(std::ceil(d1_ms * 2.0))));
  std::string reads, core_having;
  int64_t sampled_ms = 0;
  for (const auto& [lo, hi] : cores) {
    sampled_ms += hi - lo;
    reads += std::string(reads.empty() ? "" : " OR ") + "(" +
             trace_time_predicate(std::max(scope.start_ms, lo - margin_ms), std::min(scope.end_ms, hi + margin_ms)) + ")";
    core_having += std::string(core_having.empty() ? "" : " OR ") + "(trace_start >= fromUnixTimestamp64Milli(" +
                   std::to_string(lo) + ") AND trace_start <= fromUnixTimestamp64Milli(" + std::to_string(hi) + "))";
  }
  reads = "(" + reads + ")";

  std::vector<std::string> ids_in, ids_out;
  uint64_t total_in = 0, total_out = 0;
  uint64_t sample_ms = 0, attributes_ms = 0;
  const std::string settings = " SETTINGS max_execution_time = " + std::to_string(kDeltaTimeBudgetSeconds);
  try {
    const auto started = std::chrono::steady_clock::now();
    const bool has_filters = !scope.span_filters.empty();
    const std::string candidates = has_filters
        ? "WITH candidate_ids AS (SELECT TraceId FROM " + scope.table + " PREWHERE " + reads + " WHERE " +
          scope.visibility + scope.span_filters + " LIMIT 1 BY TraceId) "
        : std::string{};
    const std::string sql = candidates +
        "SELECT toString(TraceId), toString(in_box), toString(count() OVER (PARTITION BY in_box)) FROM ("
        "SELECT TraceId, duration_ns >= " + std::to_string(d0_ns) + " AND duration_ns <= " + std::to_string(d1_ns) + " AS in_box FROM ("
        "SELECT TraceId, min(Timestamp) AS trace_start, " + kTraceDurationExpr + " AS duration_ns FROM " + scope.table +
        " PREWHERE " + reads + " WHERE " + scope.visibility +
        (has_filters ? " AND TraceId IN (SELECT TraceId FROM candidate_ids)" : "") +
        " GROUP BY TraceId HAVING (" + core_having + ")" +
        (scope.having.empty() ? std::string{} : " AND " + having_terms(scope.having)) +
        ")) ORDER BY in_box DESC, cityHash64(TraceId) LIMIT " + std::to_string(sample) + " BY in_box" + settings;
    scope.client->Select(sql, [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const bool in = ch_block_text_at(block, 1, row) == "1";
        const uint64_t side_total = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 2, row)));
        (in ? ids_in : ids_out).push_back(ch_block_text_at(block, 0, row));
        (in ? total_in : total_out) = side_total;
      }
    });
    sample_ms = elapsed_ms_u64(started);
  } catch (const std::exception& e) {
    return json_error(res, 503, "trace_deltas_failed", e.what());
  }

  struct ValueStat { std::string value; uint64_t n_in = 0, n_out = 0; double in_pct = 0, base_pct = 0; };
  struct KeyStat {
    std::string scope, key;
    uint64_t uniq_in = 0, uniq_out = 0, occ_in = 0, occ_out = 0;
    std::vector<ValueStat> values;
    double score = 0;
    bool boosted = false;
  };
  std::vector<KeyStat> keys;
  const uint64_t n_in = ids_in.size(), n_out = ids_out.size();
  if (n_in > 0) {
    try {
      const auto started = std::chrono::steady_clock::now();
      const AttributeColumns cols = trace_attribute_columns(*scope.client, *scope.host, cfg_.traces);
      std::string pairs = "[('column', 'ServiceName', toString(ServiceName)), ('column', 'SpanName', toString(SpanName)), "
                          "('column', 'StatusCode', toString(StatusCode))]";
      if (cols.span()) pairs += ", arrayMap((k, v) -> ('span', toString(k), toString(v)), SpanAttributes.keys, SpanAttributes.values)";
      if (cols.resource()) pairs += ", arrayMap((k, v) -> ('resource', toString(k), toString(v)), ResourceAttributes.keys, ResourceAttributes.values)";
      std::vector<std::string> all_ids = ids_in;
      all_ids.insert(all_ids.end(), ids_out.begin(), ids_out.end());
      // Share of the side's sampled traces, so that values are ranked alike
      // whatever the two sample sizes.
      const std::string share = "x.2 / " + std::to_string(n_in) + " + x.3 / " + std::to_string(std::max<uint64_t>(1, n_out));
      const std::string sql =
          "SELECT scope, key, toString(uniq_in), toString(uniq_out), toString(occ_in), toString(occ_out), "
          "tv.1, toString(tv.2), toString(tv.3) FROM ("
          "SELECT scope, key, countIf(n_in > 0) AS uniq_in, countIf(n_out > 0) AS uniq_out, sum(n_in) AS occ_in, sum(n_out) AS occ_out, "
          "arraySlice(arrayReverseSort(x -> " + share + ", groupArray((value, n_in, n_out))), 1, " +
          std::to_string(kDeltaTopValuesPerKey) + ") AS top FROM ("
          "SELECT kv.1 AS scope, kv.2 AS key, kv.3 AS value, uniqExactIf(TraceId, side) AS n_in, uniqExactIf(TraceId, NOT side) AS n_out FROM ("
          "SELECT TraceId, TraceId IN " + trace_id_list_sql(ids_in) + " AS side, arrayJoin(arrayConcat(" + pairs + ")) AS kv FROM " +
          scope.table + " PREWHERE " + reads + " AND TraceId IN " + trace_id_list_sql(all_ids) + " WHERE " + scope.visibility +
          ") WHERE length(kv.3) <= " + std::to_string(kDeltaMaxValueBytes) +
          " GROUP BY scope, key, value) GROUP BY scope, key HAVING occ_in + occ_out >= " + std::to_string(kDeltaMinOccurrences) +
          ") ARRAY JOIN top AS tv" + settings;
      std::map<std::pair<std::string, std::string>, size_t> index;
      scope.client->Select(sql, [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          auto key = std::make_pair(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
          auto it = index.find(key);
          if (it == index.end()) {
            KeyStat stat;
            stat.scope = key.first;
            stat.key = key.second;
            stat.uniq_in = std::stoull(ch_block_text_at(block, 2, row));
            stat.uniq_out = std::stoull(ch_block_text_at(block, 3, row));
            stat.occ_in = std::stoull(ch_block_text_at(block, 4, row));
            stat.occ_out = std::stoull(ch_block_text_at(block, 5, row));
            it = index.emplace(key, keys.size()).first;
            keys.push_back(std::move(stat));
          }
          ValueStat value;
          value.value = ch_block_text_at(block, 6, row);
          value.n_in = std::stoull(ch_block_text_at(block, 7, row));
          value.n_out = std::stoull(ch_block_text_at(block, 8, row));
          keys[it->second].values.push_back(std::move(value));
        }
      });
      attributes_ms = elapsed_ms_u64(started);
    } catch (const std::exception& e) {
      return json_error(res, 503, "trace_deltas_failed", e.what());
    }
  }

  // Baseline shares: the outside sample, or all traces of the sampled time
  // range (both samples weighted by the traces they stand for).
  const double all_total = static_cast<double>(total_in + total_out);
  const auto baseline_pct = [&](const ValueStat& v) {
    const double out_share = n_out ? static_cast<double>(v.n_out) / static_cast<double>(n_out) : 0.0;
    if (baseline == "outside") return out_share * 100.0;
    const double in_share = n_in ? static_cast<double>(v.n_in) / static_cast<double>(n_in) : 0.0;
    return all_total > 0 ? (in_share * static_cast<double>(total_in) + out_share * static_cast<double>(total_out)) / all_total * 100.0 : 0.0;
  };
  struct Hidden { std::string scope, key, reason; };
  std::vector<Hidden> hidden;
  std::vector<KeyStat> ranked;
  for (auto& key : keys) {
    const uint64_t occ = key.occ_in + key.occ_out;
    size_t id_values = 0;
    for (const auto& v : key.values) if (id_like_value(v.value)) ++id_values;
    if (key.scope != "column" && (id_or_time_key(key.key) || (!key.values.empty() && id_values * 5 >= key.values.size() * 4))) {
      hidden.push_back({key.scope, key.key, "id_like"});
      continue;
    }
    if (occ > 20) {
      const double u_in = key.occ_in ? static_cast<double>(key.uniq_in) / static_cast<double>(key.occ_in) : -1.0;
      const double u_out = key.occ_out ? static_cast<double>(key.uniq_out) / static_cast<double>(key.occ_out) : -1.0;
      const double uniqueness = u_in >= 0 && u_out >= 0 ? std::min(u_in, u_out) : std::max(u_in, u_out);
      if (uniqueness > 0.9) {
        hidden.push_back({key.scope, key.key, "high_cardinality"});
        continue;
      }
    }
    double best = 0;
    for (auto& v : key.values) {
      v.in_pct = n_in ? static_cast<double>(v.n_in) / static_cast<double>(n_in) * 100.0 : 0.0;
      v.base_pct = baseline_pct(v);
      best = std::max(best, std::fabs(v.in_pct - v.base_pct));
    }
    if (best < 0.5) continue;  // same distribution on both sides
    key.boosted = key.scope == "column" || semconv_key(key.key);
    key.score = best + (key.boosted ? 2.0 : 0.0);
    std::sort(key.values.begin(), key.values.end(), [](const ValueStat& a, const ValueStat& b) {
      const double da = std::fabs(a.in_pct - a.base_pct), db = std::fabs(b.in_pct - b.base_pct);
      if (da != db) return da > db;
      return a.value < b.value;
    });
    if (key.values.size() > kDeltaValuesShown) key.values.resize(kDeltaValuesShown);
    ranked.push_back(std::move(key));
  }
  std::sort(ranked.begin(), ranked.end(), [](const KeyStat& a, const KeyStat& b) {
    if (a.score != b.score) return a.score > b.score;
    if (a.scope != b.scope) return a.scope < b.scope;
    return a.key < b.key;
  });
  const size_t ranked_keys = ranked.size();
  if (ranked.size() > kDeltaMaxKeys) ranked.resize(kDeltaMaxKeys);
  const auto field_of = [](const KeyStat& key) -> const char* {
    if (key.scope != "column") return "tag";
    if (key.key == "ServiceName") return "service";
    if (key.key == "SpanName") return "operation";
    return "status";
  };

  const auto round2 = [](double value) { return std::round(value * 100.0) / 100.0; };
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(scope.source_host_id.c_str());
  w.Key("unit"); w.String("traces");
  w.Key("box"); w.StartObject();
  w.Key("t0"); w.Int64(t0);
  w.Key("t1"); w.Int64(t1);
  w.Key("d0"); w.Double(d0_ms);
  w.Key("d1"); w.Double(d1_ms);
  w.EndObject();
  w.Key("baseline"); w.String(baseline.c_str());
  w.Key("sample_limit"); w.Int(sample);
  w.Key("sampled_windows"); w.StartArray();
  for (const auto& [lo, hi] : cores) { w.StartArray(); w.Int64(lo); w.Int64(hi); w.EndArray(); }
  w.EndArray();
  w.Key("sampled_ms"); w.Int64(sampled_ms);
  w.Key("window_sampled"); w.Bool(width > kDeltaMaxCoreMs);
  w.Key("read_margin_ms"); w.Int64(margin_ms);
  w.Key("selection"); w.StartObject(); w.Key("sampled"); w.Uint64(n_in); w.Key("traces"); w.Uint64(total_in); w.EndObject();
  w.Key("baseline_sample"); w.StartObject();
  w.Key("sampled"); w.Uint64(baseline == "outside" ? n_out : n_in + n_out);
  w.Key("traces"); w.Uint64(baseline == "outside" ? total_out : total_in + total_out);
  w.EndObject();
  w.Key("ranked_keys"); w.Uint64(ranked_keys);
  w.Key("keys"); w.StartArray();
  for (const auto& key : ranked) {
    w.StartObject();
    w.Key("scope"); w.String(key.scope.c_str());
    w.Key("key"); w.String(key.key.c_str());
    w.Key("field"); w.String(field_of(key));
    w.Key("score"); w.Double(round2(key.score));
    w.Key("boosted"); w.Bool(key.boosted);
    w.Key("distinct_values"); w.Uint64(std::max(key.uniq_in, key.uniq_out));
    w.Key("values"); w.StartArray();
    for (const auto& v : key.values) {
      w.StartObject();
      w.Key("value"); w.String(v.value.c_str());
      w.Key("selection_pct"); w.Double(round2(v.in_pct));
      w.Key("baseline_pct"); w.Double(round2(v.base_pct));
      w.Key("selection_count"); w.Uint64(v.n_in);
      w.Key("baseline_count"); w.Uint64(baseline == "outside" ? v.n_out : v.n_in + v.n_out);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("hidden_keys"); w.StartArray();
  for (size_t i = 0; i < hidden.size() && i < 50; ++i) {
    w.StartObject();
    w.Key("scope"); w.String(hidden[i].scope.c_str());
    w.Key("key"); w.String(hidden[i].key.c_str());
    w.Key("reason"); w.String(hidden[i].reason.c_str());
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("sample"); w.Uint64(sample_ms);
  w.Key("attributes"); w.Uint64(attributes_ms);
  w.Key("total"); w.Uint64(elapsed_ms_u64(request_started));
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}


void Server::handle_traces_spans(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  std::string disabled_message;
  if (feature_param_rejected(cfg_.traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }
  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");

  int64_t start_ms = 0, end_ms = 0;
  std::string error;
  if (!trace_time_range(cfg_.traces, req, &start_ms, &end_ms, &error)) return json_error(res, 400, "invalid_trace_range", error);
  const int limit = int_param(req, "limit", kSpanPageDefaultLimit, 1, kSpanPageMaxLimit);
  // budget_ms may only lower the widening budget (tests use it to reach a
  // resume point deterministically).
  const double budget_ms = static_cast<double>(int_param(req, "budget_ms", static_cast<int>(kSpanPageBudgetMs), 0,
                                                         static_cast<int>(kSpanPageBudgetMs)));
  // Span-level here: the span's own Duration.
  const double min_duration_ms = double_param(req, "min_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  const double max_duration_ms = double_param(req, "max_duration_ms", 0.0, 0.0, 24.0 * 60.0 * 60.0 * 1000.0);
  if (max_duration_ms > 0.0 && min_duration_ms > max_duration_ms) {
    return json_error(res, 400, "invalid_trace_duration", "minimum duration cannot exceed maximum duration.");
  }
  TraceFilterSpec filters;
  if (!parse_trace_filters(req, &filters, &error)) return json_error(res, 400, "invalid_trace_filter", error);
  const std::vector<std::string> kinds = repeated_param_values(req, "kind");
  if (kinds.size() > kSpanKindsMax) return json_error(res, 400, "invalid_trace_filter", "At most 16 span kinds are accepted.");
  for (const auto& kind : kinds) {
    if (kind.size() > 64) return json_error(res, 400, "invalid_trace_filter", "kind values are limited to 64 bytes.");
  }
  std::vector<SpanAttributeColumn> attribute_columns;
  if (!parse_span_columns(req, &attribute_columns, &error)) return json_error(res, 400, "invalid_trace_columns", error);

  const int64_t start_ns = start_ms * kNsPerMs;
  const int64_t end_ns = end_ms * kNsPerMs;
  SpanCursor cursor;
  if (req.has_param("cursor") && !req.get_param_value("cursor").empty()) {
    if (!decode_span_cursor(req.get_param_value("cursor"), &cursor) || cursor.ts_ns > end_ns) {
      return json_error(res, 400, "invalid_cursor", "cursor is not a span search cursor of this range.");
    }
  }

  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  // Column predicates (primary key ServiceName / SpanName, status, kind,
  // duration) and the allowlist go to PREWHERE; attribute map predicates,
  // which read the large map columns, stay in WHERE for the rows left.
  std::string tag_sql, columns_sql;
  if (!filters.tags.empty() || !attribute_columns.empty()) {
    const AttributeColumns cols = trace_attribute_columns(*client, *host, cfg_.traces);
    std::string code;
    if (!tag_filters_sql(filters.tags, cols, &tag_sql, &code, &error)) return json_error(res, 400, code, error);
    if (!span_columns_sql(attribute_columns, cols, &columns_sql, &code, &error)) return json_error(res, 400, code, error);
  }
  std::string column_filters = span_filters_sql(filters, "");
  if (!kinds.empty()) column_filters += " AND " + exact_values_predicate("SpanKind", kinds);
  if (min_duration_ms > 0.0) column_filters += " AND Duration >= " + std::to_string(static_cast<uint64_t>(std::llround(min_duration_ms * 1e6)));
  if (max_duration_ms > 0.0) column_filters += " AND Duration <= " + std::to_string(static_cast<uint64_t>(std::llround(max_duration_ms * 1e6)));

  const std::string table = qualified(cfg_.traces.database, cfg_.traces.table);
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string select = std::string("SELECT ") + kSpanSearchColumns + columns_sql + " FROM " + table;
  const std::string settings =
      " SETTINGS max_execution_time = " + std::to_string(kSpanSliceTimeoutSeconds) +
      ", timeout_overflow_mode = 'throw', max_rows_to_read = " + std::to_string(kSpanSliceReadRowsCap) +
      ", read_overflow_mode = 'throw'";
  const auto keyset_sql = [&](const SpanCursor& at) {
    if (!at.after_key) return std::string{};
    const std::string ts = ns_time(at.ts_ns);
    return " AND (Timestamp < " + ts + " OR (Timestamp = " + ts + " AND (SpanId < " + quote_string(at.span_id) +
           " OR (SpanId = " + quote_string(at.span_id) + " AND TraceId < " + quote_string(at.trace_id) + "))))";
  };

  struct Slice { int64_t lo_ns = 0, hi_ns = 0; size_t rows = 0; double ms = 0; };
  std::vector<Slice> slices;
  std::vector<SpanSearchRow> rows;
  SpanCursor position = cursor;  // the spans still to read: at or before / after this
  if (!position.present) {
    position.present = true;
    position.ts_ns = end_ns;
    position.after_key = false;
  }
  int64_t width = cursor.present && cursor.slice_ns > 0
      ? std::max(kSpanMinSliceNs, std::min(cursor.slice_ns, kSpanSlicesNs[std::size(kSpanSlicesNs) - 1]))
      : kSpanSlicesNs[0];
  bool exhausted = false;     // no span left in the range
  bool incomplete = false;    // stopped by the budget or a slice guard
  std::string stop_reason;
  double query_ms = 0;
  int64_t covered_ns = 0;
  const auto loop_started = std::chrono::steady_clock::now();
  SpanCursor next;
  bool retried = false;
  const int64_t page_upper_ns = position.ts_ns;

  try {
    while (true) {
      if (position.ts_ns < start_ns) { exhausted = true; break; }
      const int64_t upper = position.ts_ns;
      const int64_t lo = std::max(start_ns, upper - width + 1);
      const size_t need = static_cast<size_t>(limit) - rows.size();
      const std::string sql = select +
          " PREWHERE Timestamp >= " + ns_time(lo) + " AND Timestamp <= " + ns_time(upper) + " AND " + visibility + column_filters +
          " WHERE 1" + keyset_sql(position) + tag_sql +
          " ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC LIMIT " + std::to_string(need + 1) + settings;
      const auto slice_started = std::chrono::steady_clock::now();
      std::vector<SpanSearchRow> got;
      try {
        select_span_search_rows(*client, sql, attribute_columns.size(), &got);
      } catch (const clickhouse::ServerException& e) {
        if (!slice_guard_error(e)) throw;
        if (slices.empty() && width > kSpanMinSliceNs && !retried) {
          // The page's first slice is too heavy: retry once, narrower.
          retried = true;
          width = std::max(kSpanMinSliceNs, width / 8);
          continue;
        }
        if (slices.empty()) throw;
        // A guard stop after answered slices is a resume point.
        incomplete = true;
        stop_reason = e.GetCode() == 158 ? "read_rows_limit" : "slice_timeout";
        next = position;
        next.slice_ns = std::max(kSpanMinSliceNs, width / 4);
        break;
      }
      const double ms = elapsed_ms_since(slice_started);
      query_ms += ms;
      covered_ns += upper - lo + 1;
      slices.push_back(Slice{lo, upper, std::min(got.size(), need), ms});

      if (got.size() > need) {
        // The page fills inside this slice: it ends after its last row.
        got.resize(need + 1);
        const SpanSearchRow boundary = got[need - 1];
        const bool tie = got[need].same_key(boundary);
        got.resize(need);
        if (tie) {
          // Exact copies of the boundary key straddle the seam: the page
          // takes all of them, so the strict keyset after it skips none.
          got.erase(std::remove_if(got.begin(), got.end(), [&](const SpanSearchRow& row) { return row.same_key(boundary); }), got.end());
          const std::string ts = ns_time(std::stoll(boundary.start_ns));
          select_span_search_rows(*client,
              select + " PREWHERE Timestamp = " + ts + " AND " + visibility + column_filters +
              " WHERE SpanId = " + quote_string(boundary.span_id) + " AND TraceId = " + quote_string(boundary.trace_id) + tag_sql +
              settings, attribute_columns.size(), &got);
        }
        for (auto& row : got) rows.push_back(std::move(row));
        next.present = true;
        next.ts_ns = std::stoll(boundary.start_ns);
        next.after_key = true;
        next.span_id = boundary.span_id;
        next.trace_id = boundary.trace_id;
        // The next page starts with a slice about 4x the time this page
        // covered (dense ranges then read far fewer rows per page).
        next.slice_ns = std::max(kSpanMinSliceNs, std::min(width, 4 * (page_upper_ns - next.ts_ns + 1)));
        break;
      }
      for (auto& row : got) rows.push_back(std::move(row));
      if (lo <= start_ns) { exhausted = true; break; }
      // The slice is exhausted: continue strictly before it.
      position = SpanCursor{};
      position.present = true;
      position.ts_ns = lo - 1;
      position.after_key = false;
      if (rows.size() >= static_cast<size_t>(limit)) {
        next = position;
        next.slice_ns = width;
        break;
      }
      // Widen, within the page budget at the cost rate seen so far.
      const double spent = elapsed_ms_since(loop_started);
      const double remaining = budget_ms - spent;
      if (remaining <= 0) {
        incomplete = true;
        stop_reason = "time_budget";
        next = position;
        next.slice_ns = width;
        break;
      }
      int64_t wider = next_span_slice_ns(width);
      const double ms_per_ns = covered_ns > 0 ? query_ms / static_cast<double>(covered_ns) : 0.0;
      if (ms_per_ns > 0 && ms_per_ns * static_cast<double>(wider) > remaining) {
        wider = std::max(kSpanMinSliceNs, static_cast<int64_t>(0.8 * remaining / ms_per_ns));
      }
      width = wider;
    }
  } catch (const std::exception& e) {
    if (client_pool_ && client) client_pool_->invalidate(client);
    return json_error(res, 503, "trace_spans_failed", e.what());
  }

  // A parent hidden by the service allowlist must not leak its SpanId (as in
  // trace detail): with a restricted allowlist parent ids are not reported.
  const bool hide_parents = visibility != "1";
  const bool has_more = !exhausted && next.present;
  const int64_t searched_to_ns = exhausted ? start_ns : (next.present ? next.ts_ns : start_ns);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("limit"); w.Int(limit);
  w.Key("attribute_columns"); w.StartArray();
  for (const auto& column : attribute_columns) {
    w.StartObject();
    w.Key("scope"); w.String(column.scope.c_str());
    w.Key("key"); w.String(column.key.c_str());
    w.EndObject();
  }
  w.EndArray();
  w.Key("has_more"); w.Bool(has_more);
  w.Key("cursor");
  if (has_more) w.String(encode_span_cursor(next).c_str()); else w.Null();
  w.Key("incomplete"); w.Bool(incomplete);
  w.Key("budget_ms"); w.Double(budget_ms);
  w.Key("stop_reason"); w.String(stop_reason.c_str());
  w.Key("searched_to_ns"); w.String(std::to_string(searched_to_ns).c_str());
  w.Key("slices"); w.StartArray();
  for (const auto& slice : slices) {
    w.StartObject();
    w.Key("start_ns"); w.String(std::to_string(slice.lo_ns).c_str());
    w.Key("end_ns"); w.String(std::to_string(slice.hi_ns).c_str());
    w.Key("rows"); w.Uint64(slice.rows);
    w.Key("ms"); w.Double(std::round(slice.ms * 10.0) / 10.0);
    w.EndObject();
  }
  w.EndArray();
  w.Key("timing_ms"); w.StartObject();
  w.Key("queries"); w.Double(std::round(query_ms * 10.0) / 10.0);
  w.Key("total"); w.Double(std::round(elapsed_ms_since(request_started) * 10.0) / 10.0);
  w.EndObject();
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) {
    w.StartObject();
    w.Key("timestamp"); w.String(row.timestamp.c_str());
    w.Key("start_ns"); w.String(row.start_ns.c_str());
    w.Key("trace_id"); w.String(row.trace_id.c_str());
    w.Key("span_id"); w.String(row.span_id.c_str());
    w.Key("parent_span_id"); w.String(hide_parents ? "" : row.parent_span_id.c_str());
    w.Key("service_name"); w.String(row.service.c_str());
    w.Key("span_name"); w.String(row.name.c_str());
    w.Key("span_kind"); w.String(row.kind.c_str());
    w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
    w.Key("status_code"); w.String(row.status.c_str());
    w.Key("status_message"); w.String(row.status_message.c_str());
    w.Key("attributes"); w.StartArray();
    for (const auto& [present, value] : row.attributes) {
      if (present) w.String(value.c_str(), static_cast<rapidjson::SizeType>(value.size())); else w.Null();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// One span with its attributes, events and links, addressed by its full row
// key (HyperDX's row WHERE): the exact Timestamp bounds the read to a few
// granules.
void Server::handle_traces_span(const httplib::Request& req, httplib::Response& res) {
  if (!cfg_.traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled.");
  const auto param = [&](const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string{}; };
  const std::string trace_id = param("trace_id");
  const std::string span_id = param("span_id");
  int64_t timestamp_ns = 0;
  if (trace_id.empty() || span_id.empty() || !parse_i64_param(req, "timestamp_ns", &timestamp_ns)) {
    return json_error(res, 400, "missing_span_key", "trace_id, span_id and timestamp_ns are required.");
  }
  if (trace_id.size() > 256 || span_id.size() > 256 || timestamp_ns < 0) {
    return json_error(res, 400, "invalid_span_key", "The span key is invalid.");
  }
  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  std::string error;
  auto client = acquire_trace_client(cfg_, *host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto& f = cfg_.traces.features;
  const std::string visibility = service_allowlist_predicate(cfg_.traces);
  const std::string sql =
      std::string("SELECT ") + kSpanSearchColumns + ", " +
      (f.span_attributes ? "toJSONString(SpanAttributes)" : "'{}'") + ", " +
      (f.resource_attributes ? "toJSONString(ResourceAttributes)" : "'{}'") + ", " +
      (f.events ? "toJSONString(Events.Timestamp), toJSONString(Events.Name), toJSONString(Events.Attributes)" : "'[]', '[]', '[]'") + ", " +
      (f.links ? "toJSONString(Links.TraceId), toJSONString(Links.SpanId), toJSONString(Links.Attributes)" : "'[]', '[]', '[]'") +
      " FROM " + qualified(cfg_.traces.database, cfg_.traces.table) +
      " PREWHERE Timestamp = " + ns_time(timestamp_ns) + " AND " + visibility +
      " WHERE TraceId = " + quote_string(trace_id) + " AND SpanId = " + quote_string(span_id) +
      " LIMIT 1 SETTINGS max_execution_time = 10";
  std::vector<std::string> values;
  try {
    client->Select(sql, [&](const clickhouse::Block& block) {
      if (!values.empty() || block.GetRowCount() == 0) return;
      for (size_t column = 0; column < block.GetColumnCount(); ++column) values.push_back(ch_block_text_at(block, column, 0));
    });
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(client);
    return json_error(res, 503, "trace_span_failed", e.what());
  }
  if (values.size() < 19) return json_error(res, 404, "span_not_found", "Span was not found.");

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); w.String(source_host_id.c_str());
  w.Key("span"); w.StartObject();
  w.Key("timestamp"); w.String(values[0].c_str());
  w.Key("start_ns_text"); w.String(values[1].c_str());
  w.Key("start_ns"); w.Int64(std::stoll(values[1]));
  w.Key("trace_id"); w.String(values[2].c_str());
  w.Key("span_id"); w.String(values[3].c_str());
  w.Key("parent_span_id"); w.String(visibility != "1" ? "" : values[4].c_str());
  w.Key("service_name"); w.String(values[5].c_str());
  w.Key("span_name"); w.String(values[6].c_str());
  w.Key("span_kind"); w.String(values[7].c_str());
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(values[8])));
  w.Key("status_code"); w.String(values[9].c_str());
  w.Key("status_message"); w.String(values[10].c_str());
  if (f.span_attributes) { w.Key("span_attributes"); w.String(values[11].c_str()); }
  if (f.resource_attributes) { w.Key("resource_attributes"); w.String(values[12].c_str()); }
  if (f.events) {
    w.Key("events_timestamp"); w.String(values[13].c_str());
    w.Key("events_name"); w.String(values[14].c_str());
    w.Key("events_attributes"); w.String(values[15].c_str());
  }
  if (f.links) {
    w.Key("links_trace_id"); w.String(values[16].c_str());
    w.Key("links_span_id"); w.String(values[17].c_str());
    w.Key("links_attributes"); w.String(values[18].c_str());
  }
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
