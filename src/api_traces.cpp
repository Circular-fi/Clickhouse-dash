#include "server.hpp"
#include "time_util.hpp"

#include "api_error.hpp"
#include "api_params.hpp"
#include "ch_error.hpp"
#include "facet_limits.hpp"
#include "ch_block_numeric.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "jwt.hpp"
#include "ttl_cache.hpp"
#include "otel_allowlist.hpp"
#include "otel_request.hpp"
#include "sql_literal.hpp"
#include "trace_filters.hpp"
#include "trace_json.hpp"
#include "trace_request.hpp"
#include "trace_service.hpp"
#include "trace_sql.hpp"
#include "ch_executor.hpp"

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

using sql::quote_ident;
using sql::quote_string;
using trace::AttributeColumns;
using trace::SpanAttributeColumn;
using trace::TagFilter;
using trace::TagOp;
using trace::TraceFilterSpec;
using trace::double_param;
using trace::exact_values_predicate;
using trace::feature_param_rejected;
using trace::filter_error_status;
using trace::grid_floor_ms;
using trace::having_terms;
using trace::int_param;
using trace::kMaxTagKeyBytes;
using trace::kNsPerMs;
using trace::kTraceDurationExpr;
using trace::ns_time;
using trace::parse_i64_param;
using trace::parse_span_columns;
using trace::parse_trace_filters;
using trace::qualified;
using trace::read_rows_limit_param;
using trace::repeated_param_values;
using trace::set_attribute_scope_error;
using trace::span_columns_sql;
using trace::span_filters_sql;
using trace::split_char;
using trace::split_tag_scope;
using trace::tag_filters_sql;
using trace::trace_time_range;

const HostSpec* trace_host(const AppConfig& cfg, const httplib::Request& req, std::string* host_id) {
  return otel::request_host(cfg, req, host_id);
}

// The two answers that every route gives before it reads anything: the host is unknown, or the page is off for it.
struct TraceRoute {
  std::string source_host_id;
  const HostSpec* host = nullptr;
};

bool open_trace_route(const AppConfig& cfg, const httplib::Request& req, httplib::Response& res, TraceRoute* route) {
  route->host = trace_host(cfg, req, &route->source_host_id);
  if (!route->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  if (!route->host->otel.traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host."); return false; }
  return true;
}

// The answer of a service: its error, or its JSON.
template <typename Answer, typename Json>
void send_trace_result(httplib::Response& res, const trace::Result<Answer>& result, Json json) {
  if (!result.value) return send_error(res, result.error);
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(json(*result.value), "application/json");
}

// Wide-window span aggregations (analytics, duration search) can spend tens of seconds merging without sending a packet: the
// receive timeout is 60 s.
std::shared_ptr<clickhouse::Client> acquire_trace_client(
    const HostSpec& host,
    const std::shared_ptr<ClickHouseClientPool>& pool,
    std::string* error) {
  return otel::acquire_client(host, pool, "Trace Explorer", std::chrono::seconds(60), error);
}

void write_string_array(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::vector<std::string>& values) {
  w.StartArray();
  for (const auto& value : values) write_json_text(w, value);
  w.EndArray();
}

// The ServiceName allowlist predicate is shared with the other OTel signals.
using otel::service_allowlist_predicate;

// The routes that are not services yet read the attribute columns with the cache of the server (trace_attributes.hpp).
bool trace_attribute_maps(clickhouse::Client& client, const TraceSettings& cfg, bool* span_map, bool* resource_map,
                          std::string* error = nullptr) {
  BorrowedExecutor db(client);
  return trace::read_attribute_maps(db, cfg, span_map, resource_map, error);
}

bool cached_trace_attribute_maps(trace::AttributeMapCache& cache, clickhouse::Client& client, const HostSpec& host,
                                 const TraceSettings& cfg, bool* span_map, bool* resource_map) {
  BorrowedExecutor db(client);
  return trace::cached_attribute_maps(db, cache, host, cfg, span_map, resource_map);
}

AttributeColumns trace_attribute_columns(trace::AttributeMapCache& cache, clickhouse::Client& client, const HostSpec& host,
                                         const TraceSettings& cfg) {
  BorrowedExecutor db(client);
  return trace::attribute_columns(db, cache, host, cfg);
}

// The span filter SQL of a request (" AND ..." or empty), or false with an
// error code when a tag filter needs an unusable attribute map. The attribute
// schema is looked up (cached) only when tag filters are present.
bool trace_filters_sql(trace::AttributeMapCache& cache, clickhouse::Client& client, const HostSpec& host, const TraceSettings& cfg,
                       const TraceFilterSpec& spec, std::string* out, std::string* error_code, std::string* error,
                       const std::string* skip_scope = nullptr, const std::string* skip_key = nullptr) {
  std::string tags;
  if (!spec.tags.empty()) {
    const AttributeColumns cols = trace_attribute_columns(cache, client, host, cfg);
    if (!tag_filters_sql(spec.tags, cols, &tags, error_code, error, skip_scope, skip_key)) return false;
  }
  *out = span_filters_sql(spec, tags);
  return true;
}

// Facet caps, BoundedRead and bounded_select: facet_limits.hpp (shared with
// api_logs.cpp).

// read_rows_limit=N lowers a request's read cap (never raises it): a cheaper
// answer, marked estimated when the lower cap stops the scan (the tests force
// a cap with it).
// Service / operation prefill bounds (handle_traces_prefill()).
constexpr uint64_t kPrefillPassRows = 20000000;
constexpr uint64_t kPrefillReadRows = 100000000;
constexpr int kPrefillMaxPasses = 8;
constexpr int64_t kPrefillSeedMs = 5 * 60 * 1000;
constexpr size_t kPrefillExcludeBytes = 128 * 1024;

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
  ch_select(client, sql, [&](const clickhouse::Block& block) {
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

// What an answer may say of the parent of a span (docs/traces.md, "service_allowlist"): never the SpanId of a
// parent that the allowlist hides. With every service allowed (`all_services`) every parent is named. Otherwise
// an answer about one trace names a parent only when it shows that span too (`visible`), and an answer that lists
// spans of many traces (context, linked-from, span search, one span) names none: it cannot know which are hidden.
// Every serialization of a span goes through this.
std::string_view visible_parent(std::string_view parent, bool all_services, const std::unordered_set<std::string>* visible = nullptr) {
  if (parent.empty()) return parent;
  if (visible) return visible->count(std::string(parent)) ? parent : std::string_view{};
  return all_services ? parent : std::string_view{};
}

// start_ns is also sent as text: epoch nanoseconds pass 2^53, and the context
// keyset cursor must be exact.
void write_span_row(rapidjson::Writer<rapidjson::StringBuffer>& w, const SpanListRow& row, bool with_links, bool all_services) {
  w.StartObject();
  w.Key("timestamp"); write_json_text(w, row.timestamp);
  w.Key("start_ns"); w.Int64(std::stoll(row.start_ns));
  w.Key("start_ns_text"); write_json_text(w, row.start_ns);
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
  w.Key("trace_id"); write_json_text(w, row.trace_id);
  w.Key("span_id"); write_json_text(w, row.span_id);
  const std::string_view parent = visible_parent(row.parent_span_id, all_services);
  w.Key("parent_span_id"); write_json_text(w, parent);
  w.Key("span_name"); write_json_text(w, row.name);
  w.Key("span_kind"); write_json_text(w, row.kind);
  w.Key("service_name"); write_json_text(w, row.service);
  w.Key("status_code"); write_json_text(w, row.status);
  if (with_links) {
    w.Key("link_span_ids"); write_json_text(w, row.link_span_ids);
    w.Key("link_attributes"); write_json_text(w, row.link_attributes);
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
  ch_select(client, sql, [&](const clickhouse::Block& block) {
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
  // A read bound or the time bound of a slice (ch_error.hpp: TOO_MANY_ROWS, TOO_MANY_BYTES, TIMEOUT_EXCEEDED).
  const ChErrorKind kind = classify_clickhouse_error(e).kind;
  return kind == ChErrorKind::ScanLimit || kind == ChErrorKind::Timeout;
}

} // namespace

std::unique_ptr<ChExecutor> Server::open_trace_executor(const HostSpec& host, std::string* error) {
  const HostSpec* spec = &host;
  return ClientExecutor::open(client_pool_, [this, spec](std::string* reason) { return acquire_trace_client(*spec, client_pool_, reason); }, error);
}

void Server::handle_traces_meta(const httplib::Request& req, httplib::Response& res) {

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");

  std::string error;
  auto client = acquire_trace_client(*host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  std::set<std::string> columns;
  bool schema_ok = false;
  bool index_available = false;
  bool span_attribute_map = false;
  bool resource_attribute_map = false;
  try {
    const std::string db = quote_string(traces.database);
    const std::string table = quote_string(traces.table);
    ch_select(*client,
        "SELECT toString(name) FROM system.columns WHERE database = " + db + " AND `table` = " + table,
        [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) columns.insert(ch_block_text_at(block, 0, row));
        });
    const char* required[] = {"Timestamp", "TraceId", "SpanId", "ParentSpanId", "SpanName", "ServiceName", "Duration", "StatusCode"};
    schema_ok = std::all_of(std::begin(required), std::end(required), [&](const char* name) { return columns.count(name) != 0; });

    if (!traces.trace_index_table.empty()) {
      uint64_t count = 0;
      ch_select(*client,
          "SELECT toString(count()) FROM system.tables WHERE database = " + db +
          " AND name = " + quote_string(traces.trace_index_table),
          [&](const clickhouse::Block& block) {
            if (block.GetRowCount()) count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
          });
      index_available = count > 0;
    }
  } catch (const std::exception& e) {
    return send_error(res, error_from_clickhouse(e, "trace", "trace_schema_failed"));
  }

  if (trace_attribute_maps(*client, traces, &span_attribute_map, &resource_attribute_map)) {
    trace::store_attribute_maps(trace_attribute_maps_cache_, *host, traces, span_attribute_map, resource_attribute_map);
  }

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("enabled"); w.Bool(true);
  w.Key("analytics_enabled"); w.Bool(traces.analytics);
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("database"); write_json_text(w, traces.database);
  w.Key("table"); write_json_text(w, traces.table);
  w.Key("trace_index_table"); write_json_text(w, traces.trace_index_table);
  w.Key("trace_index_available"); w.Bool(index_available);
  w.Key("schema_ok"); w.Bool(schema_ok);
  w.Key("default_lookback_minutes"); w.Int(traces.default_lookback_minutes);
  w.Key("max_lookback_minutes"); w.Int(traces.max_lookback_minutes);
  w.Key("search_limit"); w.Uint64(traces.search_limit);
  w.Key("max_spans_per_trace"); w.Uint64(traces.max_spans_per_trace);
  w.Key("tag_search_supported"); w.Bool(span_attribute_map || resource_attribute_map);
  w.Key("span_attribute_map"); w.Bool(span_attribute_map);
  w.Key("resource_attribute_map"); w.Bool(resource_attribute_map);
  w.Key("highlighted_attributes"); write_string_array(w, traces.highlighted_attributes);
  w.Key("linked_from_margin_minutes"); w.Int(traces.linked_from_margin_minutes);
  w.Key("context_windows_ms"); w.StartArray();
  for (int64_t window : kContextWindowsMs) w.Int64(window);
  w.EndArray();
  w.Key("features");
  w.StartObject();
  w.Key("service_filter"); w.Bool(traces.features.service_filter);
  w.Key("operation_filter"); w.Bool(traces.features.operation_filter);
  w.Key("status_filter"); w.Bool(traces.features.status_filter);
  w.Key("duration_filter"); w.Bool(traces.features.duration_filter);
  w.Key("resource_attributes"); w.Bool(traces.features.resource_attributes);
  w.Key("span_attributes"); w.Bool(traces.features.span_attributes);
  w.Key("events"); w.Bool(traces.features.events);
  w.Key("links"); w.Bool(traces.features.links);
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_prefill(const httplib::Request& req, httplib::Response& res) {

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");

  int64_t start_ms = 0, end_ms = 0;
  std::string range_error;
  if (!trace_time_range(traces, req, &start_ms, &end_ms, &range_error)) {
    return json_error(res, 400, "invalid_trace_range", range_error);
  }

  // Minute-aligned superset of the requested range: the list only feeds the
  // service/operation pickers, and alignment lets "last N minutes" requests
  // made within the same minute (reloads, range toggles) share one scan.
  constexpr int64_t kPrefillAlignMs = 60 * 1000;
  const int64_t aligned_start_ms = (start_ms / kPrefillAlignMs) * kPrefillAlignMs;
  const int64_t aligned_end_ms = ((end_ms + kPrefillAlignMs - 1) / kPrefillAlignMs) * kPrefillAlignMs;
  // Only the tag filters narrow the picker lists (service / operation /
  // status choices must stay selectable). The scans are bounded (passes of
  // kPrefillPassRows, kPrefillReadRows in all; read_rows_limit lowers both)
  // and the list is reported as an estimate when a bound stopped them.
  TraceFilterSpec filters;
  std::string validation_error;
  if (!parse_trace_filters(req, &filters, &validation_error)) return json_error(res, 400, "invalid_trace_filter", validation_error);
  std::string tag_filters;
  if (!filters.tags.empty()) {
    std::string error;
    auto client = acquire_trace_client(*host, client_pool_, &error);
    if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    std::string filter_code, filter_error;
    if (!tag_filters_sql(filters.tags, trace_attribute_columns(trace_attribute_maps_cache_, *client, *host, traces), &tag_filters, &filter_code, &filter_error)) {
      return json_error(res, filter_error_status(filter_code), filter_code, filter_error);
    }
  }
  const uint64_t read_budget = read_rows_limit_param(req, kPrefillReadRows);
  const uint64_t pass_rows = std::min(read_budget, kPrefillPassRows);
  // The filter part of the key is a digest: up to 32 filters of 4 KiB each are not kept as a key.
  const std::string cache_key = source_host_id + '\0' + std::to_string(aligned_start_ms) + '\0' +
      std::to_string(aligned_end_ms) + '\0' + std::to_string(read_budget) + '\0' + sha256_hex(tag_filters);
  const size_t hard_limit = 20000;

  auto cached = trace_prefill_cache_.get(
      cache_key,
      [&](TracePrefill& value, std::string& code, std::string& message) {
        std::string error;
        auto client = acquire_trace_client(*host, client_pool_, &error);
        if (!client) {
          code = "trace_source_unavailable";
          message = error.empty() ? "Cannot connect to trace ClickHouse source." : error;
          return false;
        }
        const std::string table = qualified(traces.database, traces.table);
        const std::string visibility = service_allowlist_predicate(traces);
        try {
          // Discovery only needs existence, and the sorting key starts with
          // (ServiceName, SpanName): a scan that excludes the pairs already
          // known (NOT IN on the key prefix) skips, through the primary index,
          // every granule holding only them, and reads just the granules where
          // a pair changes plus those of unknown pairs. Reading every span of
          // the window (LIMIT 1 BY alone) cost ~21 CPU-s and 1.8 B rows on 7
          // days of the 2 B-span fixture.
          //   1. seed: the newest kPrefillSeedMs of the window, whose pairs
          //      are usually most of the window's;
          //   2. passes over the whole window, NOT IN the known pairs, each
          //      capped at kPrefillPassRows rows read, until one completes.
          // Every pass is a complete scan of what it did not exclude unless
          // its cap stopped it, so the list is exact when the last pass ran
          // to its end; else (passes, the read budget or the time budget
          // spent) it is a subset, answered as estimated.
          std::set<std::pair<std::string, std::string>> known;
          uint64_t rows_left = read_budget;
          bool complete = false;
          bool stopped = false;
          auto pass = [&](int64_t from_ms, bool exclude) {
            const uint64_t cap = std::min<uint64_t>(rows_left, pass_rows);
            std::string excluded;
            if (exclude && !known.empty()) {
              for (const auto& [service, operation] : known) {
                if (excluded.size() > kPrefillExcludeBytes) break;
                excluded += (excluded.empty() ? "(" : ", (") + quote_string(service) + ", " + quote_string(operation) + ")";
              }
              excluded = " AND (ServiceName, SpanName) NOT IN (" + excluded + ")";
            }
            const std::string sql =
                "SELECT toString(ServiceName), toString(SpanName) FROM " + table +
                " PREWHERE " + trace::time_predicate(from_ms, aligned_end_ms) + " WHERE " + visibility + tag_filters + excluded +
                " LIMIT 1 BY ServiceName, SpanName LIMIT " + std::to_string(hard_limit + 1) + facet_settings_sql(cap, false);
            size_t found = 0;
            const BoundedRead read = bounded_select(*client, sql, [&](const clickhouse::Block& block) {
              for (size_t row = 0; row < block.GetRowCount(); ++row) {
                if (known.emplace(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row)).second) ++found;
              }
            });
            rows_left -= std::min(rows_left, read.read_rows);
            ++value.passes;
            value.read_rows += read.read_rows;
            if (timed_out(read) || known.size() > hard_limit) stopped = true;
            return std::make_pair(read.capped(cap) || timed_out(read), found);
          };
          const int64_t seed_start_ms = std::max(aligned_start_ms, aligned_end_ms - kPrefillSeedMs);
          if (seed_start_ms > aligned_start_ms) pass(seed_start_ms, false);
          for (int i = 0; i < kPrefillMaxPasses && !stopped && !complete && rows_left > 0; ++i) {
            const auto [cut, found] = pass(aligned_start_ms, true);
            complete = !cut;
            // A cut pass that found nothing new would read the same granules again.
            if (cut && found == 0) break;
          }
          value.estimated = !complete && known.size() <= hard_limit;
          value.pairs.assign(known.begin(), known.end());
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
  // The scan that filled the cache entry: passes run and rows read.
  w.Key("scan"); w.StartObject();
  w.Key("passes"); w.Int(cached.value->passes);
  w.Key("read_rows"); w.Uint64(cached.value->read_rows);
  w.Key("read_rows_limit"); w.Uint64(read_budget);
  w.EndObject();
  w.Key("pairs"); w.StartArray();
  for (const auto& [service, operation] : pairs) {
    // The count column is kept for payload compatibility (existence only).
    w.StartArray(); write_json_text(w, service); write_json_text(w, operation); w.Uint64(1); w.EndArray();
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


bool facet_scope(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool, trace::AttributeMapCache& cache,
                 const httplib::Request& req, httplib::Response& res, FacetScope* scope, std::shared_ptr<clickhouse::Client>* client) {
  scope->host = trace_host(cfg, req, &scope->source_host_id);
  if (!scope->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  const TraceSettings& traces = scope->host->otel.traces;
  if (!traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host."); return false; }
  std::string disabled_message;
  if (feature_param_rejected(traces, req, &disabled_message)) {
    json_error(res, 400, "trace_filter_disabled", disabled_message);
    return false;
  }
  std::string error;
  if (!trace_time_range(traces, req, &scope->start_ms, &scope->end_ms, &error)) {
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
  *client = acquire_trace_client(*scope->host, pool, &error);
  if (!*client) {
    json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);
    return false;
  }
  scope->columns = trace_attribute_columns(cache, **client, *scope->host, traces);
  return true;
}

void write_facet_common(rapidjson::Writer<rapidjson::StringBuffer>& w, const FacetScope& scope, bool estimated,
                        bool timed_out_flag, uint64_t query_ms, bool cached, uint64_t read_rows_cap) {
  w.Key("range"); w.StartArray(); w.Int64(scope.start_ms); w.Int64(scope.end_ms); w.EndArray();
  w.Key("scanned_range"); w.StartArray(); w.Int64(scope.aligned_start_ms); w.Int64(scope.aligned_end_ms); w.EndArray();
  w.Key("estimated"); w.Bool(estimated);
  w.Key("timed_out"); w.Bool(timed_out_flag);
  w.Key("sample_limit"); w.Uint64(kFacetSampleRows);
  w.Key("read_rows_limit"); w.Uint64(read_rows_cap);
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
  if (!facet_scope(cfg_, client_pool_, trace_attribute_maps_cache_, req, res, &scope, &client)) return;
  const TraceSettings& traces = scope.host->otel.traces;
  std::string span_filters, filter_code, filter_error;
  if (!trace_filters_sql(trace_attribute_maps_cache_, *client, *scope.host, traces, scope.filters, &span_filters, &filter_code, &filter_error)) {
    return json_error(res, filter_error_status(filter_code), filter_code, filter_error);
  }
  const bool span = scope.columns.span();
  const bool resource = scope.columns.resource();
  const uint64_t read_cap = read_rows_limit_param(req, kFacetReadRowsCap);
  const std::string cache_key = scope.source_host_id + '\0' + std::to_string(scope.aligned_start_ms) + '\0' +
      std::to_string(scope.aligned_end_ms) + '\0' + (span ? "s" : "") + (resource ? "r" : "") + '\0' +
      std::to_string(read_cap) + '\0' + sha256_hex(span_filters);
  auto cached = trace_facet_keys_cache_.get(
      cache_key,
      [&](TraceFacetKeys& value, std::string& code, std::string& message) {
        if (!span && !resource) return true;
        const std::string table = qualified(traces.database, traces.table);
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
            " PREWHERE " + trace::time_predicate(scope.aligned_start_ms, scope.aligned_end_ms) +
            " WHERE " + service_allowlist_predicate(traces) + span_filters +
            " LIMIT " + std::to_string(kFacetSampleRows) + ")) LEFT ARRAY JOIN arrayConcat(" + join(tuples) + ") AS t" +
            // The served keys only (and one more, which says truncated), in the order of the sort below.
            " ORDER BY t.3 DESC, t.2 ASC, t.1 DESC LIMIT " + std::to_string(kFacetMaxKeys + 1) +
            facet_settings_sql(read_cap, false);
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
          // The sample LIMIT, the read cap or the time budget stopped it.
          value.estimated = value.sampled_spans >= kFacetSampleRows || read.capped(read_cap) || value.timed_out;
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
        if (value.keys.size() > kFacetMaxKeys + 1) value.keys.resize(kFacetMaxKeys + 1);
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
  w.Key("source_host_id"); write_json_text(w, scope.source_host_id);
  w.Key("supported"); w.Bool(span || resource);
  w.Key("scopes"); w.StartArray(); if (span) w.String("span"); if (resource) w.String("resource"); w.EndArray();
  write_facet_common(w, scope, value.estimated, value.timed_out, value.query_ms, !cached.fetched, read_cap);
  w.Key("sampled_spans"); w.Uint64(value.sampled_spans);
  w.Key("truncated"); w.Bool(value.keys.size() > kFacetMaxKeys);
  w.Key("keys"); w.StartArray();
  for (size_t i = 0; i < value.keys.size() && i < kFacetMaxKeys; ++i) {
    const auto& key = value.keys[i];
    w.StartArray(); write_json_text(w, key.scope); write_json_text(w, key.key); w.Uint64(key.count); w.EndArray();
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
  if (!facet_scope(cfg_, client_pool_, trace_attribute_maps_cache_, req, res, &scope, &client)) return;
  const TraceSettings& traces = scope.host->otel.traces;
  if (key_scope == "span" ? !scope.columns.span() : !scope.columns.resource()) {
    const bool disabled = key_scope == "span" ? !scope.columns.span_enabled : !scope.columns.resource_enabled;
    std::string scope_code, scope_error;
    set_attribute_scope_error(scope.columns, disabled, "filters", &scope_code, &scope_error);
    return json_error(res, filter_error_status(scope_code), scope_code, scope_error);
  }
  std::string span_filters, filter_code, filter_error;
  if (!trace_filters_sql(trace_attribute_maps_cache_, *client, *scope.host, traces, scope.filters, &span_filters, &filter_code, &filter_error,
                         &key_scope, &key)) {
    return json_error(res, filter_error_status(filter_code), filter_code, filter_error);
  }
  const uint64_t read_cap = read_rows_limit_param(req, kFacetReadRowsCap);
  // The client's text (the attribute key and the filters) enters the key as a digest.
  const std::string cache_key = scope.source_host_id + '\0' + std::to_string(scope.aligned_start_ms) + '\0' +
      std::to_string(scope.aligned_end_ms) + '\0' + key_scope + '\0' + std::to_string(limit) + '\0' +
      std::to_string(read_cap) + '\0' + sha256_hex(key + '\0' + span_filters);
  auto cached = trace_facet_values_cache_.get(
      cache_key,
      [&](TraceFacetValues& value, std::string& code, std::string& message) {
        const std::string table = qualified(traces.database, traces.table);
        const std::string column = key_scope == "span" ? "SpanAttributes" : "ResourceAttributes";
        const std::string sql =
            "SELECT toString(v), toString(c), toString(sum(c) OVER ()), toString(count() OVER ()) FROM ("
            "SELECT v, count() AS c FROM ("
            "SELECT " + column + "[" + quote_string(key) + "] AS v FROM " + table +
            " PREWHERE " + trace::time_predicate(scope.aligned_start_ms, scope.aligned_end_ms) +
            " WHERE " + service_allowlist_predicate(traces) + " AND mapContains(" + column + ", " + quote_string(key) + ")" +
            span_filters + " LIMIT " + std::to_string(kFacetSampleRows) + ") GROUP BY v) "
            "ORDER BY c DESC, v LIMIT " + std::to_string(limit) + facet_settings_sql(read_cap, true);
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
          value.estimated = value.spans_with_key >= kFacetSampleRows || read.capped(read_cap) || value.timed_out ||
              value.distinct_values >= kFacetGroupByCap;
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
  w.Key("source_host_id"); write_json_text(w, scope.source_host_id);
  w.Key("scope"); write_json_text(w, key_scope);
  w.Key("key"); write_json_text(w, key);
  w.Key("limit"); w.Int(limit);
  write_facet_common(w, scope, value.estimated, value.timed_out, value.query_ms, !cached.fetched, read_cap);
  w.Key("spans_with_key"); w.Uint64(value.spans_with_key);
  w.Key("distinct_values"); w.Uint64(value.distinct_values);
  w.Key("has_more"); w.Bool(value.distinct_values > value.values.size());
  w.Key("values"); w.StartArray();
  for (const auto& [text, count] : value.values) {
    w.StartArray(); write_json_text(w, text); w.Uint64(count); w.EndArray();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_search(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  const TraceSettings& traces = route.host->otel.traces;
  trace::WindowRequest window;
  ApiError error;
  if (!trace::parse_window(req, traces, /*analytics_required=*/false, &window, &error)) return send_error(res, error);
  window.source_host_id = route.source_host_id;
  const int limit = int_param(req, "limit", static_cast<int>(traces.search_limit), 1, static_cast<int>(traces.search_limit));
  send_trace_result(res, trace_service_.search(current_request_context(), *route.host, window, static_cast<size_t>(limit)),
                    trace::search_json);
}

void Server::handle_traces_analytics(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::AnalyticsRequest request;
  ApiError error;
  if (!trace::parse_analytics(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.analytics(current_request_context(), *route.host, request), trace::analytics_json);
}

// GET /api/traces/service_map: the services and the calls between them, after HyperDX's DBServiceMapPage (trace_analytics.hpp).
void Server::handle_traces_service_map(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServiceMapRequest request;
  ApiError error;
  if (!trace::parse_service_map(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.service_map(current_request_context(), *route.host, request), trace::service_map_json);
}

// GET /api/traces/heatmap: trace counts per (time bucket, log-scaled duration row), same parameters as /api/traces/analytics plus
// rows (8..80, default 40). One pass instead of HyperDX's two (quantile / max, then widthBucket): see bin_heatmap.
void Server::handle_traces_heatmap(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::HeatmapRequest request;
  ApiError error;
  if (!trace::parse_heatmap(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.heatmap(current_request_context(), *route.host, request), trace::heatmap_json);
}

// GET /api/traces/deltas: which attribute values set the traces of a heatmap box apart. Parameters: the heatmap's (window +
// filters) plus the box t0 / t1 (epoch ms, trace start) and d0 / d1 (trace duration, ms), baseline (outside: the other traces of
// the box's time range, default; all: every trace of that time range) and sample (per side, 100..2500, default 1000).
void Server::handle_traces_deltas(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::DeltasRequest request;
  ApiError error;
  if (!trace::parse_deltas(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.window.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.deltas(current_request_context(), *route.host, request), trace::deltas_json);
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

bool services_scope(const AppConfig& cfg, const std::shared_ptr<ClickHouseClientPool>& pool, trace::AttributeMapCache& cache,
                    const httplib::Request& req, httplib::Response& res, ServicesScope* scope, std::shared_ptr<clickhouse::Client>* client) {
  scope->host = trace_host(cfg, req, &scope->source_host_id);
  if (!scope->host) { json_error(res, 404, "unknown_host", "Trace source host is not configured."); return false; }
  const TraceSettings& traces = scope->host->otel.traces;
  if (!traces.enabled) { json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host."); return false; }
  if (!traces.analytics) {
    json_error(res, 404, "trace_analytics_disabled", "Trace analytics (and the services view) are disabled by configuration.");
    return false;
  }
  std::string message;
  if (feature_param_rejected(traces, req, &message)) { json_error(res, 400, "trace_filter_disabled", message); return false; }
  if (!trace_time_range(traces, req, &scope->start_ms, &scope->end_ms, &message)) {
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
  if (!scope->detail.empty() && !traces.features.service_filter) {
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
  *client = acquire_trace_client(*scope->host, pool, &message);
  if (!*client) {
    json_error(res, 503, "trace_source_unavailable", message.empty() ? "Cannot connect to trace ClickHouse source." : message);
    return false;
  }
  std::string span_filters, filter_code;
  if (!trace_filters_sql(cache, **client, *scope->host, traces, filters, &span_filters, &filter_code, &message)) {
    json_error(res, filter_error_status(filter_code), filter_code, message);
    return false;
  }
  scope->where = span_filters;
  if (!scope->detail.empty()) scope->where += " AND ServiceName = " + quote_string(scope->detail);
  if (min_duration_ms > 0.0) scope->where += " AND Duration >= " + std::to_string(std::llround(min_duration_ms * 1000000.0));
  if (max_duration_ms > 0.0) scope->where += " AND Duration <= " + std::to_string(std::llround(max_duration_ms * 1000000.0));
  scope->columns = trace_attribute_columns(cache, **client, *scope->host, traces);
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
  ch_select(client, "EXPLAIN ESTIMATE SELECT 1" + from_where, [&](const clickhouse::Block& block) {
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
  out.time_sql = trace::time_predicate(start_ms, end_ms);
  out.sampled_ms = end_ms - start_ms;
  if (exact || estimated_rows <= kServicesExactRows) return out;
  const double fraction = static_cast<double>(kServicesSampleRows) / static_cast<double>(estimated_rows);
  const int64_t slice_ms = std::max<int64_t>(kServicesMinSliceMs, static_cast<int64_t>(std::llround(static_cast<double>(bucket_ms) * fraction / 1000.0)) * 1000);
  if (slice_ms * 2 > bucket_ms) return out;
  const int64_t offset = start_ms - origin_ms;
  int64_t bucket = origin_ms + (offset >= 0 ? offset / bucket_ms : -((-offset + bucket_ms - 1) / bucket_ms)) * bucket_ms;
  std::string terms;
  int64_t sampled = 0;
  for (; bucket < end_ms; bucket += bucket_ms) {
    const int64_t lo = std::max(bucket, start_ms), hi = std::min(bucket + bucket_ms, end_ms);
    if (hi <= lo) continue;
    const int64_t length = std::min(slice_ms, hi - lo);
    const int64_t bucket_index = bucket / bucket_ms;
    // Golden-ratio offsets: spread over the bucket, stable for a given grid.
    const double phase = std::fmod(static_cast<double>(bucket_index) * 0.6180339887498949, 1.0);
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
  write_json_text(w, name);
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
  if (!services_scope(cfg_, client_pool_, trace_attribute_maps_cache_, req, res, &scope, &client)) return;
  const TraceSettings& traces = scope.host->otel.traces;
  const std::string table = qualified(traces.database, traces.table);
  const std::string visibility = service_allowlist_predicate(traces);
  const std::string span_kind = scope.span_scope == "root" ? kServiceRootSpans : kServiceEntrySpans;
  const bool detail = !scope.detail.empty();

  // The count chart grid of /api/traces/analytics (same bucket sizes and
  // bucket_origin_ms anchoring, align_buckets widens to whole buckets).
  const int64_t bucket_ms = static_cast<int64_t>(trace::choose_bucket_seconds(scope.end_ms - scope.start_ms)) * 1000;
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
                                                   trace::time_predicate(scope.start_ms, scope.end_ms) + kind_and_where);
    estimate_ms = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count());
  } catch (const std::exception& e) {
    log_event(LogLevel::Warn, "traces.estimate_failed", {{"route", "services"}, {"error", std::string(e.what()).substr(0, 300)}});
    // Without an estimate the window is read whole (still time-bounded).
    if (client_pool_) client_pool_->invalidate(client);
    std::string error;
    client = acquire_trace_client(*scope.host, client_pool_, &error);
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
    return send_error(res, error_from_clickhouse(e, "trace", "trace_services_failed"));
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
      ch_select(*client,
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
      return send_error(res, error_from_clickhouse(e, "trace", "trace_services_failed"));
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
                " PREWHERE " + trace::time_predicate(scope.start_ms, scope.end_ms) + " AND ServiceName = " + quote_string(scope.detail) +
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
      } catch (const std::exception& e) {
        log_event(LogLevel::Warn, "traces.release_markers_failed", {{"error", std::string(e.what()).substr(0, 300)}});
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
  w.Key("source_host_id"); write_json_text(w, scope.source_host_id);
  w.Key("scope"); write_json_text(w, scope.span_scope);
  w.Key("span_predicate"); write_json_text(w, span_kind);
  w.Key("detail"); write_json_text(w, scope.detail);
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
    write_json_key(w, name);
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
      w.StartArray(); write_json_text(w, span.trace_id); write_json_text(w, span.span_id); write_json_text(w, span.operation);
      w.Int64(span.start_ms); w.Uint64(span.duration_ns); write_json_text(w, span.status); w.EndArray();
    }
    w.EndArray();
    w.Key("releases_supported"); w.Bool(releases_supported);
    w.Key("releases_estimated"); w.Bool(releases_estimated);
    w.Key("releases"); w.StartArray();
    for (const auto& release : releases) {
      w.StartArray(); write_json_text(w, release.version); w.Int64(release.first_ms); w.Uint64(release.spans); w.EndArray();
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
  if (!services_scope(cfg_, client_pool_, trace_attribute_maps_cache_, req, res, &scope, &client)) return;
  const TraceSettings& traces = scope.host->otel.traces;
  rapidjson::StringBuffer sb(nullptr, 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  const bool supported = scope.columns.span();
  struct Statement { std::string service, statement, system; uint64_t spans = 0, errors = 0, p95 = 0; double total_ns = 0; };
  std::vector<Statement> rows;
  BoundedRead read;
  if (supported) {
    const std::string table = qualified(traces.database, traces.table);
    const std::string statement =
        "coalesce(nullif(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])";
    const std::string sql =
        "SELECT toString(ServiceName), " + statement + " AS stmt, "
        "any(coalesce(nullif(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system'])), toString(count()), "
        "toString(countIf(StatusCode = 'Error')), toString(sum(Duration)), toString(toUInt64(quantileTDigest(0.95)(Duration))) FROM " +
        table + " PREWHERE " + trace::time_predicate(scope.start_ms, scope.end_ms) +
        " WHERE " + service_allowlist_predicate(traces) + scope.where +
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
      return send_error(res, error_from_clickhouse(e, "trace", "trace_services_failed"));
    }
  }
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, scope.source_host_id);
  w.Key("supported"); w.Bool(supported);
  w.Key("detail"); write_json_text(w, scope.detail);
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
    w.StartArray(); write_json_text(w, row.service); write_json_text(w, row.statement); write_json_text(w, row.system);
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
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");
  if (!traces.features.links) return json_error(res, 404, "trace_links_disabled", "Span links are disabled by traces.features.");
  std::string error;
  auto client = acquire_trace_client(*host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const std::string trace_literal = quote_string(trace_id);
  std::string range_source = "request";
  if (!has_lo) {
    // No window from the caller: the trace index gives the trace's bounds.
    if (traces.trace_index_table.empty()) {
      return json_error(res, 503, "trace_index_unavailable", "Linked-from lookups without start_ms/end_ms require traces.trace_index_table.");
    }
    uint64_t count = 0;
    try {
      ch_select(*client,
          "SELECT toString(count()), toString(toUnixTimestamp64Milli(min(Start))), toString(toUnixTimestamp64Milli(max(End))) FROM " +
              qualified(traces.database, traces.trace_index_table) + " WHERE TraceId = " + trace_literal,
          [&](const clickhouse::Block& block) {
            if (!block.GetRowCount()) return;
            count = static_cast<uint64_t>(std::stoull(ch_block_text_at(block, 0, 0)));
            if (count) {
              start_ms = std::stoll(ch_block_text_at(block, 1, 0));
              end_ms = std::stoll(ch_block_text_at(block, 2, 0)) + 1;
            }
          });
    } catch (const std::exception& e) {
      return send_error(res, error_from_clickhouse(e, "trace", "trace_index_lookup_failed"));
    }
    if (!count) return json_error(res, 404, "trace_not_found", "Trace was not found in the trace index.");
    range_source = "trace_index";
  }
  constexpr int64_t kMaxTraceTimeMs = INT64_MAX / 1000000 - 1;
  const int64_t margin_ms = static_cast<int64_t>(traces.linked_from_margin_minutes) * 60 * 1000;
  if (start_ms < 0 || end_ms < start_ms || end_ms > kMaxTraceTimeMs - margin_ms) {
    return json_error(res, 400, "invalid_trace_range", "Invalid trace time range.");
  }
  if (end_ms - start_ms > static_cast<int64_t>(traces.max_lookback_minutes) * 60 * 1000) {
    return json_error(res, 400, "invalid_trace_range", "Trace time range exceeds traces.max_lookback_minutes.");
  }
  const int64_t lo_ms = std::max<int64_t>(0, start_ms - margin_ms);
  const int64_t hi_ms = end_ms + margin_ms;

  // has() reads Links.TraceId alone (PREWHERE); a span id also needs the pair
  // to match, so the zipped arrays are checked for the remaining rows. With a
  // restricted allowlist a link names only a span of the trace that the
  // allowlist shows (visible_targets): the others are hidden.
  const std::string visibility = service_allowlist_predicate(traces);
  const bool all_services = visibility == "1";
  const std::string visible_targets = all_services ? std::string{} :
      ", (SELECT groupArray(toString(SpanId)) FROM " + qualified(traces.database, traces.table) + " WHERE " +
      trace::time_predicate(lo_ms, hi_ms) + " AND TraceId = " + trace_literal + " AND " + visibility + ") AS visible_targets";
  const std::string link_match = std::string("t = trace") + (all_services ? "" : " AND has(visible_targets, s)") +
      (span_id.empty() ? std::string{} : " AND s = " + quote_string(span_id));
  const std::string sql =
      "WITH " + trace_literal + " AS trace" + visible_targets + " SELECT " + kSpanListColumns +
      ", toJSONString(arrayFilter((s, t) -> " + link_match + ", Links.SpanId, Links.TraceId))"
      ", toJSONString(arrayFilter((a, t, s) -> " + link_match + ", Links.Attributes, Links.TraceId, Links.SpanId))"
      " FROM " + qualified(traces.database, traces.table) +
      " PREWHERE has(Links.TraceId, trace)"
      " WHERE " + trace::time_predicate(lo_ms, hi_ms) + " AND TraceId != trace AND " + visibility +
      (span_id.empty() && all_services ? std::string{} : " AND arrayExists((t, s) -> " + link_match + ", Links.TraceId, Links.SpanId)") +
      " ORDER BY Timestamp DESC, SpanId DESC LIMIT " + std::to_string(kLinkedFromLimit + 1) +
      " SETTINGS max_execution_time = 15";

  std::vector<SpanListRow> rows;
  const auto started = std::chrono::steady_clock::now();
  try {
    select_span_rows(*client, sql, &rows, true);
  } catch (const std::exception& e) {
    return send_error(res, error_from_clickhouse(e, "trace", "trace_linked_from_failed"));
  }
  const double elapsed = elapsed_ms_since(started);
  const bool truncated = rows.size() > kLinkedFromLimit;
  if (truncated) rows.resize(kLinkedFromLimit);

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("trace_id"); write_json_text(w, trace_id);
  w.Key("span_id"); write_json_text(w, span_id);
  w.Key("range_source"); write_json_text(w, range_source);
  w.Key("range"); w.StartArray(); w.Int64(lo_ms); w.Int64(hi_ms); w.EndArray();
  w.Key("margin_minutes"); w.Int(traces.linked_from_margin_minutes);
  w.Key("limit"); w.Uint64(kLinkedFromLimit);
  w.Key("truncated"); w.Bool(truncated);
  w.Key("elapsed_ms"); w.Double(elapsed);
  w.Key("rows"); w.StartArray();
  for (const auto& row : rows) write_span_row(w, row, true, all_services);
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
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");
  std::string error;
  auto client = acquire_trace_client(*host, client_pool_, &error);
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
    if (!(resource ? traces.features.resource_attributes : traces.features.span_attributes)) {
      return json_error(res, 400, "context_filter_disabled", std::string(resource ? "resource" : "span") + " attributes are disabled by traces.features.");
    }
    bool span_map = false, resource_map = false;
    cached_trace_attribute_maps(trace_attribute_maps_cache_, *client, *host, traces, &span_map, &resource_map);
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
      " FROM " + qualified(traces.database, traces.table) +
      " WHERE Timestamp >= " + ns_time(lo_ns) + " AND Timestamp <= " + ns_time(hi_ns) +
      " AND " + service_allowlist_predicate(traces) + (filter_sql.empty() ? std::string{} : " AND " + filter_sql);
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
    return send_error(res, error_from_clickhouse(e, "trace", "trace_context_failed"));
  }
  const double elapsed = elapsed_ms_since(started);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("timestamp_ns"); write_json_text(w, std::to_string(anchor_ns));
  w.Key("window_ms"); w.Int64(window_ms);
  w.Key("range_ns"); w.StartArray(); write_json_text(w, std::to_string(lo_ns)); write_json_text(w, std::to_string(hi_ns)); w.EndArray();
  w.Key("filter"); write_json_text(w, filter);
  w.Key("direction"); write_json_text(w, direction);
  w.Key("limit"); w.Int(limit);
  if (query_newer) { w.Key("has_newer"); w.Bool(more_newer); }
  if (query_older) { w.Key("has_older"); w.Bool(more_older); }
  w.Key("elapsed_ms"); w.Double(elapsed);
  w.Key("rows"); w.StartArray();
  const bool all_services = service_allowlist_predicate(traces) == "1";
  for (auto it = newer.rbegin(); it != newer.rend(); ++it) write_span_row(w, *it, false, all_services);
  for (const auto& row : older) write_span_row(w, row, false, all_services);
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_trace_detail(const httplib::Request& req, httplib::Response& res) {
  if (!req.has_param("trace_id") || req.get_param_value("trace_id").empty()) {
    return json_error(res, 400, "missing_trace_id", "trace_id is required.");
  }
  const std::string trace_id = req.get_param_value("trace_id");
  if (trace_id.size() > 256) return json_error(res, 400, "invalid_trace_id", "trace_id is too long.");

  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");

  std::string error;
  auto client = acquire_trace_client(*host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto& f = traces.features;
  const std::string visibility = service_allowlist_predicate(traces);
  const std::string span_attrs = f.span_attributes ? "toJSONString(SpanAttributes)" : "'{}'";
  const std::string resource_attrs = f.resource_attributes ? "toJSONString(ResourceAttributes)" : "'{}'";
  const std::string events_ts = f.events ? "toJSONString(Events.Timestamp)" : "'[]'";
  const std::string events_name = f.events ? "toJSONString(Events.Name)" : "'[]'";
  const std::string events_attrs = f.events ? "toJSONString(Events.Attributes)" : "'[]'";
  const std::string links_trace = f.links ? "toJSONString(Links.TraceId)" : "'[]'";
  const std::string links_span = f.links ? "toJSONString(Links.SpanId)" : "'[]'";
  const std::string links_attrs = f.links ? "toJSONString(Links.Attributes)" : "'[]'";
  const std::string main_table = qualified(traces.database, traces.table);
  const std::string trace_literal = quote_string(trace_id);
  const size_t limit = traces.max_spans_per_trace + 1;

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
    ch_select(*client, sql, [&](const clickhouse::Block& block) {
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

  if (traces.trace_index_table.empty()) {
    return json_error(res, 503, "trace_index_unavailable", "Trace detail requires traces.trace_index_table.");
  }

  try {
    const std::string index_table = qualified(traces.database, traces.trace_index_table);
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
    return send_error(res, error_from_clickhouse(e, "trace", "trace_index_lookup_failed"));
  }

  bool truncated = spans.size() > traces.max_spans_per_trace;
  if (truncated) spans.resize(traces.max_spans_per_trace);
  if (spans.empty()) return json_error(res, 404, "trace_not_found", "Trace was not found in the configured time scope.");

  // Do not leak the SpanId of a parent that was hidden by the service
  // allowlist. Treat the first visible descendant as a visible root instead.
  std::unordered_set<std::string> visible_span_ids;
  visible_span_ids.reserve(spans.size());
  for (const auto& span : spans) visible_span_ids.insert(span.span_id);
  for (auto& span : spans) {
    span.parent_span_id = std::string(visible_parent(span.parent_span_id, visibility == "1", &visible_span_ids));
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("trace_id"); write_json_text(w, trace_id);
  w.Key("range_source"); w.String("trace_index");
  w.Key("truncated"); w.Bool(truncated);
  w.Key("spans"); w.StartArray();
  for (const auto& span : spans) {
    w.StartObject();
    w.Key("timestamp"); write_json_text(w, span.timestamp);
    w.Key("start_ns"); w.Int64(span.start_ns);
    w.Key("duration_ns"); w.Uint64(span.duration_ns);
    w.Key("trace_id"); write_json_text(w, span.trace_id);
    w.Key("span_id"); write_json_text(w, span.span_id);
    w.Key("parent_span_id"); write_json_text(w, span.parent_span_id);
    w.Key("span_name"); write_json_text(w, span.name);
    w.Key("span_kind"); write_json_text(w, span.kind);
    w.Key("service_name"); write_json_text(w, span.service);
    w.Key("status_code"); write_json_text(w, span.status);
    w.Key("status_message"); write_json_text(w, span.status_message);
    if (f.span_attributes) { w.Key("span_attributes"); write_json_text(w, span.span_attributes); }
    if (f.resource_attributes) { w.Key("resource_attributes"); write_json_text(w, span.resource_attributes); }
    if (f.events) {
      w.Key("events_timestamp"); write_json_text(w, span.events_timestamp);
      w.Key("events_name"); write_json_text(w, span.events_name);
      w.Key("events_attributes"); write_json_text(w, span.events_attributes);
    }
    if (f.links) {
      w.Key("links_trace_id"); write_json_text(w, span.links_trace_id);
      w.Key("links_span_id"); write_json_text(w, span.links_span_id);
      w.Key("links_attributes"); write_json_text(w, span.links_attributes);
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_traces_spans(const httplib::Request& req, httplib::Response& res) {
  const auto request_started = std::chrono::steady_clock::now();
  std::string disabled_message;
  std::string source_host_id;
  const HostSpec* host = trace_host(cfg_, req, &source_host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Trace source host is not configured.");
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");
  if (feature_param_rejected(traces, req, &disabled_message)) {
    return json_error(res, 400, "trace_filter_disabled", disabled_message);
  }

  int64_t start_ms = 0, end_ms = 0;
  std::string error;
  if (!trace_time_range(traces, req, &start_ms, &end_ms, &error)) return json_error(res, 400, "invalid_trace_range", error);
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

  auto client = acquire_trace_client(*host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  // Column predicates (primary key ServiceName / SpanName, status, kind,
  // duration) and the allowlist go to PREWHERE; attribute map predicates,
  // which read the large map columns, stay in WHERE for the rows left.
  std::string tag_sql, columns_sql;
  if (!filters.tags.empty() || !attribute_columns.empty()) {
    const AttributeColumns cols = trace_attribute_columns(trace_attribute_maps_cache_, *client, *host, traces);
    std::string code;
    if (!tag_filters_sql(filters.tags, cols, &tag_sql, &code, &error)) return json_error(res, filter_error_status(code), code, error);
    if (!span_columns_sql(attribute_columns, cols, &columns_sql, &code, &error)) return json_error(res, filter_error_status(code), code, error);
  }
  std::string column_filters = span_filters_sql(filters, "");
  if (!kinds.empty()) column_filters += " AND " + exact_values_predicate("SpanKind", kinds);
  if (min_duration_ms > 0.0) column_filters += " AND Duration >= " + std::to_string(static_cast<uint64_t>(std::llround(min_duration_ms * 1e6)));
  if (max_duration_ms > 0.0) column_filters += " AND Duration <= " + std::to_string(static_cast<uint64_t>(std::llround(max_duration_ms * 1e6)));

  const std::string table = qualified(traces.database, traces.table);
  const std::string visibility = service_allowlist_predicate(traces);
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
        stop_reason = classify_clickhouse_error(e).kind == ChErrorKind::ScanLimit ? "read_rows_limit" : "slice_timeout";
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
    return send_error(res, error_from_clickhouse(e, "trace", "trace_spans_failed"));
  }

  // A parent hidden by the service allowlist must not leak its SpanId (as in
  // trace detail): with a restricted allowlist parent ids are not reported.
  const bool all_services = visibility == "1";
  const bool has_more = !exhausted && next.present;
  const int64_t searched_to_ns = exhausted ? start_ns : (next.present ? next.ts_ns : start_ns);

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("v"); w.Int(1);
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("range"); w.StartArray(); w.Int64(start_ms); w.Int64(end_ms); w.EndArray();
  w.Key("limit"); w.Int(limit);
  w.Key("attribute_columns"); w.StartArray();
  for (const auto& column : attribute_columns) {
    w.StartObject();
    w.Key("scope"); write_json_text(w, column.scope);
    w.Key("key"); write_json_text(w, column.key);
    w.EndObject();
  }
  w.EndArray();
  w.Key("has_more"); w.Bool(has_more);
  w.Key("cursor");
  if (has_more) write_json_text(w, encode_span_cursor(next)); else w.Null();
  w.Key("incomplete"); w.Bool(incomplete);
  w.Key("budget_ms"); w.Double(budget_ms);
  w.Key("stop_reason"); write_json_text(w, stop_reason);
  w.Key("searched_to_ns"); write_json_text(w, std::to_string(searched_to_ns));
  w.Key("slices"); w.StartArray();
  for (const auto& slice : slices) {
    w.StartObject();
    w.Key("start_ns"); write_json_text(w, std::to_string(slice.lo_ns));
    w.Key("end_ns"); write_json_text(w, std::to_string(slice.hi_ns));
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
    w.Key("timestamp"); write_json_text(w, row.timestamp);
    w.Key("start_ns"); write_json_text(w, row.start_ns);
    w.Key("trace_id"); write_json_text(w, row.trace_id);
    w.Key("span_id"); write_json_text(w, row.span_id);
    const std::string_view parent = visible_parent(row.parent_span_id, all_services);
    w.Key("parent_span_id"); write_json_text(w, parent);
    w.Key("service_name"); write_json_text(w, row.service);
    w.Key("span_name"); write_json_text(w, row.name);
    w.Key("span_kind"); write_json_text(w, row.kind);
    w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(row.duration_ns)));
    w.Key("status_code"); write_json_text(w, row.status);
    w.Key("status_message"); write_json_text(w, row.status_message);
    w.Key("attributes"); w.StartArray();
    for (const auto& [present, value] : row.attributes) {
      if (present) write_json_text(w, value); else w.Null();
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
  const TraceSettings& traces = host->otel.traces;
  if (!traces.enabled) return json_error(res, 404, "traces_disabled", "Trace Explorer is disabled for this host.");
  std::string error;
  auto client = acquire_trace_client(*host, client_pool_, &error);
  if (!client) return json_error(res, 503, "trace_source_unavailable", error.empty() ? "Cannot connect to trace ClickHouse source." : error);

  const auto& f = traces.features;
  const std::string visibility = service_allowlist_predicate(traces);
  const std::string sql =
      std::string("SELECT ") + kSpanSearchColumns + ", " +
      (f.span_attributes ? "toJSONString(SpanAttributes)" : "'{}'") + ", " +
      (f.resource_attributes ? "toJSONString(ResourceAttributes)" : "'{}'") + ", " +
      (f.events ? "toJSONString(Events.Timestamp), toJSONString(Events.Name), toJSONString(Events.Attributes)" : "'[]', '[]', '[]'") + ", " +
      (f.links ? "toJSONString(Links.TraceId), toJSONString(Links.SpanId), toJSONString(Links.Attributes)" : "'[]', '[]', '[]'") +
      " FROM " + qualified(traces.database, traces.table) +
      " PREWHERE Timestamp = " + ns_time(timestamp_ns) + " AND " + visibility +
      " WHERE TraceId = " + quote_string(trace_id) + " AND SpanId = " + quote_string(span_id) +
      " LIMIT 1 SETTINGS max_execution_time = 10";
  std::vector<std::string> values;
  try {
    ch_select(*client, sql, [&](const clickhouse::Block& block) {
      if (!values.empty() || block.GetRowCount() == 0) return;
      for (size_t column = 0; column < block.GetColumnCount(); ++column) values.push_back(ch_block_text_at(block, column, 0));
    });
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(client);
    return send_error(res, error_from_clickhouse(e, "trace", "trace_span_failed"));
  }
  if (values.size() < 19) return json_error(res, 404, "span_not_found", "Span was not found.");

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("source_host_id"); write_json_text(w, source_host_id);
  w.Key("span"); w.StartObject();
  w.Key("timestamp"); write_json_text(w, values[0]);
  w.Key("start_ns_text"); write_json_text(w, values[1]);
  w.Key("start_ns"); w.Int64(std::stoll(values[1]));
  w.Key("trace_id"); write_json_text(w, values[2]);
  w.Key("span_id"); write_json_text(w, values[3]);
  const std::string_view parent = visible_parent(values[4], visibility == "1");
  w.Key("parent_span_id"); write_json_text(w, parent);
  w.Key("service_name"); write_json_text(w, values[5]);
  w.Key("span_name"); write_json_text(w, values[6]);
  w.Key("span_kind"); write_json_text(w, values[7]);
  w.Key("duration_ns"); w.Uint64(static_cast<uint64_t>(std::stoull(values[8])));
  w.Key("status_code"); write_json_text(w, values[9]);
  w.Key("status_message"); write_json_text(w, values[10]);
  if (f.span_attributes) { w.Key("span_attributes"); write_json_text(w, values[11]); }
  if (f.resource_attributes) { w.Key("resource_attributes"); write_json_text(w, values[12]); }
  if (f.events) {
    w.Key("events_timestamp"); write_json_text(w, values[13]);
    w.Key("events_name"); write_json_text(w, values[14]);
    w.Key("events_attributes"); write_json_text(w, values[15]);
  }
  if (f.links) {
    w.Key("links_trace_id"); write_json_text(w, values[16]);
    w.Key("links_span_id"); write_json_text(w, values[17]);
    w.Key("links_attributes"); write_json_text(w, values[18]);
  }
  w.EndObject();
  w.EndObject();
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

} // namespace chdash
