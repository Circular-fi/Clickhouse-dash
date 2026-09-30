#include "server.hpp"
#include "time_util.hpp"

#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"

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

std::string regex_escape(std::string_view value) {
  std::string out;
  out.reserve(value.size() * 2);
  for (char ch : value) {
    switch (ch) {
      case '.': case '^': case '$': case '|': case '(': case ')':
      case '[': case ']': case '{': case '}': case '+': case '?': case '\\':
        out.push_back('\\');
        break;
      default:
        break;
    }
    out.push_back(ch);
  }
  return out;
}

std::string service_pattern_predicate(std::string_view pattern) {
  if (pattern == "*") return "1";
  const size_t first = pattern.find('*');
  if (first == std::string_view::npos) {
    return "ServiceName = " + quote_string(pattern);
  }
  if (first == pattern.size() - 1 && pattern.find('*', first + 1) == std::string_view::npos) {
    return "startsWith(ServiceName, " + quote_string(pattern.substr(0, pattern.size() - 1)) + ")";
  }
  if (first == 0 && pattern.find('*', 1) == std::string_view::npos) {
    return "endsWith(ServiceName, " + quote_string(pattern.substr(1)) + ")";
  }

  std::string regex = "^";
  size_t start = 0;
  while (start <= pattern.size()) {
    const size_t star = pattern.find('*', start);
    const size_t end = star == std::string_view::npos ? pattern.size() : star;
    regex += regex_escape(pattern.substr(start, end - start));
    if (star == std::string_view::npos) break;
    regex += ".*";
    start = star + 1;
  }
  regex += "$";
  return "match(ServiceName, " + quote_string(regex) + ")";
}

std::string service_allowlist_predicate(const TraceSettings& cfg) {
  if (cfg.service_allowlist.empty()) return "0";
  for (const auto& pattern : cfg.service_allowlist) {
    if (pattern == "*") return "1";
  }
  std::string out = "(";
  bool first = true;
  for (const auto& pattern : cfg.service_allowlist) {
    if (!first) out += " OR ";
    first = false;
    out += service_pattern_predicate(pattern);
  }
  out += ")";
  return out;
}

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

} // namespace chdash
