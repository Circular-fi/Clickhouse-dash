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

// The ServiceName allowlist predicate is shared with the other OTel signals.
using otel::service_allowlist_predicate;

// The routes that are not services yet read the attribute columns with the cache of the server (trace_attributes.hpp).
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

// The schema of the source: the columns, the trace index, the attribute maps.
void Server::handle_traces_meta(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  send_trace_result(res, trace_service_.meta(current_request_context(), *route.host, route.source_host_id), trace::meta_json);
}

void Server::handle_traces_prefill(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::PrefillRequest request;
  ApiError error;
  if (!trace::parse_prefill(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.prefill(current_request_context(), *route.host, request), trace::prefill_json);
}

// Top attribute keys (span + resource) of the spans matching the filters, by the number of sampled spans carrying them. One capped
// pass reads only the maps' key subcolumns.
void Server::handle_traces_facets(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::FacetRequest request;
  ApiError error;
  if (!trace::parse_facets(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.facet_keys(current_request_context(), *route.host, request), trace::facet_keys_json);
}

// Top values of one attribute key with their sampled span counts. The key's own filters are left out, so its other values stay
// visible (and can be added: several values of one key match any of them).
void Server::handle_traces_facet_values(const httplib::Request& req, httplib::Response& res) {
  trace::FacetRequest request;
  ApiError error;
  // The key is checked before the host, as the route always did.
  if (!trace::parse_facet_key(req, &request, &error)) return send_error(res, error);
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  if (!trace::parse_facets(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.facet_values(current_request_context(), *route.host, request), trace::facet_values_json);
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

// Per service (and, with detail=<service>, per endpoint = SpanName of that service): entry-span rate, errors, p50 / p95 / p99 Duration
// and total time (sum of Duration), plus the same per chart bucket (sparklines and the RED charts). The detail drill-down also lists the
// slowest entry spans and the first time each ResourceAttributes['service.version'] was seen (release markers). See trace_services.hpp.
void Server::handle_traces_services(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServicesRequest request;
  ApiError error;
  if (!trace::parse_services(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.services(current_request_context(), *route.host, request), trace::services_json);
}

// Database statements (HyperDX DatabaseTab): spans carrying db.query.text (current semconv) or db.statement (older), grouped by
// statement text: count, total time, p95 Duration, per service. Any span kind (database calls are Client spans).
void Server::handle_traces_services_db(const httplib::Request& req, httplib::Response& res) {
  TraceRoute route;
  if (!open_trace_route(cfg_, req, res, &route)) return;
  trace::ServicesRequest request;
  ApiError error;
  if (!trace::parse_services(req, route.host->otel.traces, &request, &error)) return send_error(res, error);
  request.source_host_id = route.source_host_id;
  send_trace_result(res, trace_service_.services_db(current_request_context(), *route.host, request), trace::services_db_json);
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
