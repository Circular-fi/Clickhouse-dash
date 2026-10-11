#include "logs_service.hpp"

#include "allowed_objects.hpp"
#include "api_error.hpp"
#include "api_params.hpp"
#include "ch_block_value.hpp"
#include "ch_error.hpp"
#include "ch_uri.hpp"
#include "facet_limits.hpp"
#include "jwt.hpp"
#include "otel_caches.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <chrono>
#include <map>

namespace chdash {
namespace logs {

namespace {

int64_t to_i64(const std::string& text) { return parse_whole_i64(text).value_or(0); }

uint64_t to_u64(const std::string& text) {
  uint64_t value = 0;
  parse_u64(text, &value);
  return value;
}

void read_rows(ChExecutor& db, const SqlStatement& statement, std::vector<LogRow>* rows) {
  db.select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
    for (size_t r = 0; r < block.GetRowCount(); ++r) {
      LogRow row;
      row.ts_ns = to_i64(ch_block_text_at(block, 0, r));
      row.tie = to_u64(ch_block_text_at(block, 1, r));
      row.service = ch_block_text_at(block, 2, r);
      row.severity_text = ch_block_text_at(block, 3, r);
      row.severity_number = static_cast<int>(to_i64(ch_block_text_at(block, 4, r)));
      row.body = ch_block_text_at(block, 5, r);
      row.body_length = to_i64(ch_block_text_at(block, 6, r));
      row.trace_id = ch_block_text_at(block, 7, r);
      row.span_id = ch_block_text_at(block, 8, r);
      row.trace_flags = static_cast<int>(to_i64(ch_block_text_at(block, 9, r)));
      row.scope_name = ch_block_text_at(block, 10, r);
      row.scope_version = ch_block_text_at(block, 11, r);
      row.log_attrs = ch_block_text_at(block, 12, r);
      row.resource_attrs = ch_block_text_at(block, 13, r);
      row.scope_attrs = ch_block_text_at(block, 14, r);
      rows->push_back(std::move(row));
    }
  });
}

TextSearchInfo text_search_of(const LogsQuery& q) {
  TextSearchInfo info;
  info.active = q.text_search;
  info.mode = q.body_mode;
  info.index_backed = q.text_index_backed;
  return info;
}

// Substring search of Body scans it, so a wide range is refused.
std::optional<ApiError> substring_range_rejected(const LogsQuery& q) {
  if (q.text_search && q.body_mode == "substring" && q.end_ms - q.start_ms > kSubstringMaxRangeMs) {
    return make_error(400, "logs_substring_range",
                      "Substring Body search is limited to 6 hours for histograms and patterns (logs.body_search = \"substring\").");
  }
  return std::nullopt;
}

FacetCommon facet_common(const std::string& source_host_id, const LogsQuery& q, const FacetWindow& window, const TextSearchInfo& text_search) {
  FacetCommon common;
  common.source_host_id = source_host_id;
  common.start_ms = q.start_ms;
  common.end_ms = q.end_ms;
  common.scanned = window;
  common.text_search = text_search;
  return common;
}

}  // namespace

LogsClock LogsClock::real() {
  LogsClock clock;
  clock.steady_ms = [] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  };
  clock.wall_ms = [] { return now_ms(); };
  return clock;
}

// ---------------------------------------------------------------------------
// The connection and the schema

LogsSchema LogsService::load_schema(ChExecutor& db, const HostSpec& host) const {
  const LogSettings& logs = host.otel.logs;
  const std::string key = host.system_uri + '\x1f' + logs.database + '\x1f' + logs.table;
  const auto result = caches_.schema.get(key, [&](LogsSchema& schema, std::string&, std::string&) {
    std::map<std::string, std::string> columns;
    const SqlStatement column_statement = schema_columns_statement(logs);
    db.select(column_statement.sql, column_statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) columns[ch_block_text_at(block, 0, row)] = ch_block_text_at(block, 1, row);
    });
    schema = schema_from_columns(columns);
    if (schema.exists) {
      std::vector<std::pair<std::string, std::string>> indexes;
      const SqlStatement index_statement = schema_indexes_statement(logs);
      db.select(index_statement.sql, index_statement.params.list(), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) indexes.emplace_back(ch_block_text_at(block, 0, row), ch_block_text_at(block, 1, row));
      });
      apply_skipping_indexes(&schema, indexes);
    }
    return true;
  });
  return *LogsSchemaCache::value_or_throw(result);
}

std::optional<ApiError> LogsService::open(const HostSpec& host, Opened* out) const {
  std::string error;
  out->db = open_(host, &error);
  if (!out->db) return make_error(503, "logs_source_unavailable", error.empty() ? "Cannot connect to the logs ClickHouse source." : error);
  const LogSettings& logs = host.otel.logs;
  try {
    out->schema = load_schema(*out->db, host);
  } catch (const std::exception& e) {
    out->db->invalidate();
    return error_from_clickhouse(e, "logs", "logs_schema_failed");
  }
  if (!out->schema.exists) {
    // A table that the system user may not read is absent from system.columns: say why, not "missing".
    if (const auto grant = missing_select_grant(*out->db, logs.database, logs.table)) {
      const auto user = parse_clickhouse_uri(host.system_uri, nullptr);
      return not_granted_error(503, "logs_table_not_granted", user ? user->user : std::string(), *grant,
                               "Table " + logs.database + "." + logs.table + " is not readable by the system user");
    }
    return make_error(404, "logs_table_missing",
                      "Table " + logs.database + "." + logs.table + " is missing or is not an OpenTelemetry exporter logs table.");
  }
  out->table = table_name(logs);
  return std::nullopt;
}

// ---------------------------------------------------------------------------
// The search

Result<SearchAnswer> LogsService::search(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                         const SearchRequest& request) const {
  using Out = Result<SearchAnswer>;
  const int64_t started = clock_.steady_ms();
  const auto elapsed = [&](int64_t since) { return clock_.steady_ms() - since; };
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  const int search_limit = static_cast<int>(host.otel.logs.search_limit);
  const size_t limit = static_cast<size_t>(clamp_or(request.limit, search_limit, 1, search_limit));
  const int64_t range_lo_ns = q.start_ms * 1000000;
  const int64_t range_hi_ns = q.end_ms * 1000000 + 999999;

  Cursor cursor;
  const bool has_cursor = !request.cursor.empty();
  if (has_cursor && !parse_cursor(request.cursor, &cursor)) {
    return Out::fail(make_error(400, "invalid_logs_cursor", "cursor must be <timestamp_ns>-<tiebreak>."));
  }
  // No live tail: a former client's after=<row id> is ignored (a page).

  SearchAnswer answer;
  answer.source_host_id = source_host_id;
  answer.start_ms = q.start_ms;
  answer.end_ms = q.end_ms;
  answer.limit = limit;
  std::vector<LogRow>& rows = answer.rows;
  bool exhausted = false;
  bool budget_hit = false;
  int64_t scanned_lo_ns = range_hi_ns;

  try {
    int64_t hi_ns = has_cursor ? std::min(range_hi_ns, cursor.ts_ns) : range_hi_ns;
    const bool substring = q.text_search && q.body_mode == "substring";
    size_t index = 0;
    bool first = true;
    while (rows.size() < limit) {
      if (hi_ns < range_lo_ns) {
        exhausted = true;
        break;
      }
      if (!first && elapsed(started) > kSearchBudgetMs) {
        budget_hit = true;
        break;
      }
      const size_t count = sizeof(kSearchWindowsSeconds) / sizeof(kSearchWindowsSeconds[0]);
      const int64_t size_s = substring ? kSubstringWindowSeconds : kSearchWindowsSeconds[std::min(index, count - 1)];
      const int64_t lo_ns = std::max<int64_t>(range_lo_ns, hi_ns - size_s * int64_t{1000000000} + 1);
      const int64_t window_started = clock_.steady_ms();
      const size_t before = rows.size();
      // The first window may use the whole limit of a query; the next ones what is left of the search budget (at least 1 s): a search never
      // runs past its budget by more than one second. A window that runs out of time ends the search with the rows that it has
      // (budget_exhausted and a cursor), and fails only when there are none.
      const int window_seconds =
          first ? kMaxExecutionSeconds : static_cast<int>(std::max<int64_t>(1, (kSearchBudgetMs - elapsed(started) + 999) / 1000));
      const SqlStatement statement =
          search_statement(o.schema, o.table, q, lo_ns, hi_ns, first && has_cursor ? std::optional<Cursor>(cursor) : std::nullopt,
                           limit - rows.size(), window_seconds);
      try {
        read_rows(*o.db, statement, &rows);
      } catch (const std::exception& e) {
        if (first || rows.empty() || classify_clickhouse_error(e).kind != ChErrorKind::Timeout) throw;
        // A partial window is dropped (a keyset page never skips a row): the cursor continues from the end of the last whole one.
        rows.resize(before);
        budget_hit = true;
        break;
      }
      answer.windows.push_back(WindowStat{lo_ns, hi_ns, rows.size() - before, elapsed(window_started)});
      scanned_lo_ns = lo_ns;
      hi_ns = lo_ns - 1;
      first = false;
      ++index;
    }
    if (rows.size() < limit && hi_ns < range_lo_ns) exhausted = true;
  } catch (const std::exception& e) {
    o.db->invalidate();
    return Out::fail(error_from_clickhouse(e, "logs", "logs_search_failed"));
  }

  // Next page: after the last row when the page is full, else from where the windows stopped (rows at scanned_lo_ns were read: continue
  // strictly below).
  if (!exhausted) {
    answer.next_cursor = rows.size() >= limit ? cursor_text(Cursor{rows.back().ts_ns, rows.back().tie}) : cursor_text(Cursor{scanned_lo_ns, 0});
  }
  answer.exhausted = exhausted;
  answer.budget_exhausted = budget_hit;
  answer.scanned_from_ms = scanned_lo_ns / 1000000;
  answer.text_search = text_search_of(q);
  answer.total_ms = elapsed(started);
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The histogram

Result<HistogramAnswer> LogsService::histogram(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                               const HistogramRequest& request) const {
  using Out = Result<HistogramAnswer>;
  const int64_t started = clock_.steady_ms();
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  if (auto problem = substring_range_rejected(q)) return Out::fail(std::move(*problem));
  const int target = clamp_or(request.buckets, 80, 10, 300);
  const int64_t bucket_ms = choose_bucket_ms(q.end_ms - q.start_ms, target);
  // Buckets lie on a grid anchored at bucket_origin_ms (the browser's local midnight), as in the Traces analytics; only origin mod size
  // matters.
  int64_t origin = request.bucket_origin_ms.value_or(0);
  origin = ((origin % bucket_ms) + bucket_ms) % bucket_ms;

  HistogramAnswer answer;
  answer.source_host_id = source_host_id;
  answer.start_ms = q.start_ms;
  answer.end_ms = q.end_ms;
  try {
    const SqlStatement statement = histogram_statement(o.schema, o.table, q, bucket_ms, origin);
    o.db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        HistogramBucket b;
        b.t = to_i64(ch_block_text_at(block, 0, row));
        for (int k = 0; k < 4; ++k) {
          b.counts[k] = to_u64(ch_block_text_at(block, static_cast<size_t>(k) + 1, row));
          answer.totals[k] += b.counts[k];
        }
        answer.buckets.push_back(b);
      }
    });
  } catch (const std::exception& e) {
    o.db->invalidate();
    return Out::fail(error_from_clickhouse(e, "logs", "logs_histogram_failed"));
  }
  answer.grid_start_ms = grid_floor(q.start_ms, bucket_ms, origin);
  answer.bucket_ms = bucket_ms;
  answer.bucket_origin_ms = origin;
  answer.text_search = text_search_of(q);
  answer.total_ms = clock_.steady_ms() - started;
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The context of a record

Result<ContextAnswer> LogsService::context(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                           const ContextRequest& request) const {
  using Out = Result<ContextAnswer>;
  const int64_t started = clock_.steady_ms();
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));

  const auto ts = parse_whole_i64(request.ts_ns);
  if (!ts || *ts <= 0) return Out::fail(make_error(400, "invalid_logs_context", "ts_ns (record timestamp in nanoseconds) is required."));
  const int64_t ts_ns = *ts;
  uint64_t anchor_tie = 0;
  const bool has_tie = parse_u64(request.tie, &anchor_tie);
  const std::optional<uint64_t> tie = has_tie ? std::optional<uint64_t>(anchor_tie) : std::nullopt;
  const std::string preset = request.preset.empty() ? "anything" : request.preset;
  const int64_t window_ms = clamp_or(request.window_ms, 5 * 60 * 1000, 1000, 60 * 60 * 1000);
  const size_t limit = static_cast<size_t>(clamp_or(request.limit, 50, 1, 200));

  SqlParams params;
  std::string filter;
  ApiError error;
  if (!build_context_filter(host.otel, o.schema, request, preset, &filter, &params, &error)) return Out::fail(std::move(error));

  const int64_t delta_ns = window_ms * 1000000;
  std::vector<LogRow> older, newer;
  try {
    // Older records: [ts - window, anchor), newest first.
    read_rows(*o.db, context_older_statement(o.schema, o.table, filter, params, ts_ns, tie, delta_ns, limit), &older);
    // The anchor and newer records: [anchor, ts + window], oldest first.
    read_rows(*o.db, context_newer_statement(o.schema, o.table, filter, params, ts_ns, tie, delta_ns, limit), &newer);
  } catch (const std::exception& e) {
    o.db->invalidate();
    return Out::fail(error_from_clickhouse(e, "logs", "logs_context_failed"));
  }
  ContextAnswer answer;
  answer.more_before = older.size() > limit;
  if (answer.more_before) older.resize(limit);
  for (const auto& row : newer) {
    if (has_tie && row.ts_ns == ts_ns && row.tie == anchor_tie) answer.anchor_found = true;
  }
  const size_t newer_limit = limit + (answer.anchor_found ? 1 : 0);
  answer.more_after = newer.size() > newer_limit;
  if (answer.more_after) newer.resize(newer_limit);

  answer.source_host_id = source_host_id;
  answer.preset = preset;
  answer.window_ms = window_ms;
  answer.range_start_ms = (ts_ns - delta_ns) / 1000000;
  answer.range_end_ms = (ts_ns + delta_ns) / 1000000;
  answer.has_anchor = has_tie;
  if (has_tie) answer.anchor_id = cursor_text(Cursor{ts_ns, anchor_tie});
  for (auto it = newer.rbegin(); it != newer.rend(); ++it) answer.rows.push_back(std::move(*it));
  for (auto& row : older) answer.rows.push_back(std::move(row));
  answer.before_count = older.size();
  answer.after_count = newer.size() - (answer.anchor_found ? 1 : 0);
  answer.total_ms = clock_.steady_ms() - started;
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The patterns

Result<PatternsAnswer> LogsService::patterns(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                             const PatternsRequest& request) const {
  using Out = Result<PatternsAnswer>;
  const int64_t started = clock_.steady_ms();
  const auto elapsed = [&](int64_t since) { return clock_.steady_ms() - since; };
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  if (auto problem = substring_range_rejected(q)) return Out::fail(std::move(*problem));
  const size_t sample_target = static_cast<size_t>(clamp_or(request.sample, 10000, 100, 20000));
  const int sparkline_buckets = clamp_or(request.buckets, 24, 4, 120);
  const size_t max_patterns = static_cast<size_t>(clamp_or(request.max_patterns, 200, 1, 1000));

  PatternsAnswer answer;
  uint64_t total = 0;
  std::vector<SampleRow> sample;
  answer.sample_method = "all";
  uint64_t rate_ppm = 1000000;
  try {
    int64_t t0 = clock_.steady_ms();
    const SqlStatement count_statement = patterns_count_statement(o.schema, o.table, q);
    o.db->select(count_statement.sql, count_statement.params.list(), [&](const clickhouse::Block& block) {
      if (block.GetRowCount()) total = to_u64(ch_block_text_at(block, 0, 0));
    });
    answer.count_ms = elapsed(t0);
    size_t fetch_limit = sample_target;
    uint64_t block_rate = 0;
    if (total > sample_target) {
      // A deterministic block sample: only the filter columns are read for every row, and Body for the granules that hold a picked block.
      answer.sample_method = "block_hash";
      rate_ppm = sample_rate_ppm(total, sample_target);
      block_rate = rate_ppm;
      fetch_limit = sample_target * 2;
    }
    t0 = clock_.steady_ms();
    const SqlStatement sample_statement = patterns_sample_statement(o.schema, o.table, q, block_rate, fetch_limit);
    o.db->select(sample_statement.sql, sample_statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        SampleRow s;
        s.ts_ms = to_i64(ch_block_text_at(block, 0, row));
        s.severity = static_cast<int>(to_i64(ch_block_text_at(block, 1, row)));
        s.service = ch_block_text_at(block, 2, row);
        s.body = ch_block_text_at(block, 3, row);
        sample.push_back(std::move(s));
      }
    });
    answer.sample_ms = elapsed(t0);
  } catch (const std::exception& e) {
    o.db->invalidate();
    return Out::fail(error_from_clickhouse(e, "logs", "logs_patterns_failed"));
  }
  // An overshooting block sample is thinned evenly to the target size.
  if (sample.size() > sample_target) {
    std::vector<SampleRow> thinned;
    thinned.reserve(sample_target);
    const double step = static_cast<double>(sample.size()) / static_cast<double>(sample_target);
    for (size_t i = 0; i < sample_target; ++i) thinned.push_back(std::move(sample[static_cast<size_t>(static_cast<double>(i) * step)]));
    sample.swap(thinned);
  }

  const int64_t mine_started = clock_.steady_ms();
  const int64_t span_ms = std::max<int64_t>(1, q.end_ms - q.start_ms);
  // The mining is CPU on a thread of the server: it stops at its budget and says so (partial).
  answer.mined = mine_patterns(sample, q.start_ms, span_ms, sparkline_buckets, max_patterns, total, [&] { return elapsed(mine_started) > kMiningBudgetMs; });
  answer.mine_ms = elapsed(mine_started);

  answer.source_host_id = source_host_id;
  answer.start_ms = q.start_ms;
  answer.end_ms = q.end_ms;
  answer.total = total;
  answer.sample_size = sample.size();
  answer.sample_target = sample_target;
  answer.sample_rate_ppm = rate_ppm;
  answer.sparkline_buckets = sparkline_buckets;
  answer.sparkline_bucket_ms = static_cast<double>(span_ms) / sparkline_buckets;
  answer.text_search = text_search_of(q);
  answer.total_ms = elapsed(started);
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The services

Result<ServicesAnswer> LogsService::services(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                             const ServicesRequest& request) const {
  using Out = Result<ServicesAnswer>;
  const int64_t started = clock_.steady_ms();
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  ServicesAnswer answer;
  try {
    const SqlStatement statement = services_statement(o.schema, o.table, q);
    o.db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        answer.services.emplace_back(ch_block_text_at(block, 0, row), to_u64(ch_block_text_at(block, 1, row)));
      }
    });
  } catch (const std::exception& e) {
    o.db->invalidate();
    return Out::fail(error_from_clickhouse(e, "logs", "logs_services_failed"));
  }
  answer.source_host_id = source_host_id;
  answer.start_ms = q.start_ms;
  answer.end_ms = q.end_ms;
  answer.total_ms = clock_.steady_ms() - started;
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The facets

Result<FacetKeysAnswer> LogsService::facets(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                            const FacetsRequest& request) const {
  using Out = Result<FacetKeysAnswer>;
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  if (auto problem = substring_range_rejected(q)) return Out::fail(std::move(*problem));
  const FacetWindow window = facet_window(q);
  FacetKeysAnswer answer;
  for (const char* scope : {"log", "resource", "scope"}) {
    if (facet_map_present(o.schema, scope)) answer.scopes.emplace_back(scope);
  }
  for (const char* column : kFacetColumns) {
    if (facet_column_present(o.schema, column)) answer.columns.emplace_back(column);
  }
  std::string shape;
  for (const auto& scope : answer.scopes) shape += scope + ",";
  for (const auto& column : answer.columns) shape += column + ",";
  // The client's text (the filters) enters the key as a digest.
  const std::string cache_key = source_host_id + '\0' + o.table + '\0' + std::to_string(window.start_ms) + '\0' + std::to_string(window.end_ms) +
                                '\0' + shape + '\0' + sha256_hex(q.where + '\0' + q.params.key());
  auto cached = caches_.facet_keys.get(cache_key, [&](LogFacetKeys& value, std::string& code, std::string& message) {
    const SqlStatement statement = facet_keys_statement(o.schema, o.table, q, window, answer.scopes, answer.columns);
    try {
      const BoundedRead read = o.db->bounded_select(
          statement.sql,
          [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.sampled = to_u64(ch_block_text_at(block, 0, row));
              LogFacetKeys::Key key{ch_block_text_at(block, 1, row), ch_block_text_at(block, 2, row), to_u64(ch_block_text_at(block, 3, row))};
              // A column empty on every sampled record is not a field.
              if (key.scope.empty() || key.count == 0) continue;
              value.keys.push_back(std::move(key));
            }
          },
          statement.params.list());
      value.timed_out = timed_out(read);
      // The sample LIMIT, the read cap or the time budget stopped it.
      value.estimated = value.sampled >= kFacetSampleRows || read.capped(kFacetReadRowsCap) || value.timed_out;
      value.query_ms = read.elapsed_ms;
    } catch (const std::exception& e) {
      o.db->invalidate();
      code = "logs_facets_failed";
      message = e.what();
      return false;
    }
    // Most frequent first; ties: the record columns, then the maps, by key.
    std::sort(value.keys.begin(), value.keys.end(), [](const LogFacetKeys::Key& a, const LogFacetKeys::Key& b) {
      if (a.count != b.count) return a.count > b.count;
      if (a.scope != b.scope) return facet_scope_rank(a.scope) < facet_scope_rank(b.scope);
      return a.key < b.key;
    });
    if (value.keys.size() > kFacetMaxKeys + 1) value.keys.resize(kFacetMaxKeys + 1);
    return true;
  });
  if (!cached.has_value || !cached.value) {
    return Out::fail(make_error(503, cached.error_code.empty() ? "logs_facets_failed" : cached.error_code,
                                cached.error_message.empty() ? "Log field discovery failed." : cached.error_message));
  }
  answer.common = facet_common(source_host_id, q, window, text_search_of(q));
  answer.common.cached = !cached.fetched;
  answer.value = cached.value;
  return Out::ok(std::move(answer));
}

Result<FacetValuesAnswer> LogsService::facet_values(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                                    const FacetValuesRequest& request) const {
  using Out = Result<FacetValuesAnswer>;
  const int limit = clamp_or(request.limit, 10, 1, kFacetMaxValues);
  Opened o;
  if (auto problem = open(host, &o)) return Out::fail(std::move(*problem));
  LogsQuery q;
  ApiError error;
  if (!build_filters(host.otel, o.schema, request.filter, clock_.wall_ms(), true, &q, &error)) return Out::fail(std::move(error));
  if (auto problem = substring_range_rejected(q)) return Out::fail(std::move(*problem));
  const std::string& scope = request.scope;
  const std::string& key = request.key;
  if (scope == "column" ? !facet_column_present(o.schema, key) : !facet_map_present(o.schema, scope)) {
    return Out::fail(make_error(400, "logs_facet_unsupported",
                                scope == "column" ? "Column " + key + " is not in the logs table."
                                                  : std::string(facet_map_column(scope)) + " is not stored as a Map column."));
  }
  const FacetWindow window = facet_window(q);
  // The client's text (the field key and the filters) enters the key as a digest.
  const std::string cache_key = source_host_id + '\0' + o.table + '\0' + std::to_string(window.start_ms) + '\0' + std::to_string(window.end_ms) +
                                '\0' + scope + '\0' + std::to_string(limit) + '\0' + sha256_hex(key + '\0' + q.where + '\0' + q.params.key());
  auto cached = caches_.facet_values.get(cache_key, [&](LogFacetValues& value, std::string& code, std::string& message) {
    const SqlStatement statement = facet_values_statement(o.schema, o.table, q, window, scope, key, limit);
    try {
      const BoundedRead read = o.db->bounded_select(
          statement.sql,
          [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              value.values.emplace_back(ch_block_text_at(block, 0, row), to_u64(ch_block_text_at(block, 1, row)));
              value.with_key = to_u64(ch_block_text_at(block, 2, row));
              value.distinct_values = to_u64(ch_block_text_at(block, 3, row));
            }
          },
          statement.params.list());
      value.timed_out = timed_out(read);
      value.estimated = value.with_key >= kFacetSampleRows || read.capped(kFacetReadRowsCap) || value.timed_out ||
                        value.distinct_values >= kFacetGroupByCap;
      value.query_ms = read.elapsed_ms;
    } catch (const std::exception& e) {
      o.db->invalidate();
      code = "logs_facet_values_failed";
      message = e.what();
      return false;
    }
    return true;
  });
  if (!cached.has_value || !cached.value) {
    return Out::fail(make_error(503, cached.error_code.empty() ? "logs_facet_values_failed" : cached.error_code,
                                cached.error_message.empty() ? "Log field values failed." : cached.error_message));
  }
  FacetValuesAnswer answer;
  answer.common = facet_common(source_host_id, q, window, text_search_of(q));
  answer.common.cached = !cached.fetched;
  answer.scope = scope;
  answer.key = key;
  answer.limit = limit;
  answer.value = cached.value;
  return Out::ok(std::move(answer));
}

}  // namespace logs
}  // namespace chdash
