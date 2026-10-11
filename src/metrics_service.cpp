#include "metrics_service.hpp"

#include "allowed_objects.hpp"
#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "ch_uri.hpp"
#include "otel_allowlist.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace chdash {
namespace metrics {

namespace {

using Clock = std::chrono::steady_clock;

int64_t elapsed_ms(Clock::time_point since) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - since).count();
}

ApiError bad_request(std::string message) { return make_error(400, "invalid_metrics_request", std::move(message)); }

}  // namespace

size_t snapshot_bytes(const CatalogSnapshot& snapshot) {
  size_t bytes = sizeof(snapshot) + snapshot.source_host_id.size() + snapshot.missing_message.size();
  for (const auto& [service, entries] : snapshot.services) {
    bytes += service.size() + 64;
    for (const auto& e : entries) {
      bytes += sizeof(e) + e.kind.size() + e.metric.size() + e.unit.size() + e.description.size() + e.temporality.size();
    }
  }
  return bytes;
}

std::string MetricsService::connect_error(const std::string& reason) const {
  return reason.empty() ? "Cannot connect to the metrics ClickHouse source." : reason;
}

std::set<std::string> MetricsService::existing_kinds(ChExecutor& db, const HostSpec& host) const {
  const MetricSettings& metrics = host.otel.metrics;
  const std::string key = host.system_uri + '\x1f' + metrics.database + '\x1f' + metrics.table_prefix;
  const auto result = kinds_.get(key, [&](std::set<std::string>& kinds, std::string&, std::string&) {
    std::set<std::string> tables;
    db.select(existing_kinds_sql(metrics), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) tables.insert(ch_block_text_at(block, 0, row));
    });
    for (const char* kind : kKinds) {
      if (tables.count(metrics.table_prefix + "_" + kind)) kinds.insert(kind);
    }
    return true;
  });
  return *KindTablesCache::value_or_throw(result);
}

std::optional<ApiError> MetricsService::check_kind_table(ChExecutor& db, const HostSpec& host, const std::string& kind) const {
  const MetricSettings& metrics = host.otel.metrics;
  if (existing_kinds(db, host).count(kind)) return std::nullopt;
  const std::string table = metrics.database + "." + metrics.table_prefix + "_" + kind;
  if (const auto grant = missing_select_grant(db, metrics.database, metrics.table_prefix + "_" + kind)) {
    const auto user = parse_clickhouse_uri(host.system_uri, nullptr);
    return not_granted_error(503, "metrics_table_not_granted", user ? user->user : std::string(), *grant,
                             "Table " + table + " is not readable by the system user");
  }
  return make_error(404, "metrics_table_missing", "Table " + table + " does not exist on this host.");
}

// ---------------------------------------------------------------------------
// The catalog

Result<CatalogAnswer> MetricsService::catalog(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                              const CatalogRequest& request) const {
  using Out = Result<CatalogAnswer>;
  const auto started = Clock::now();
  const MetricSettings& metrics = host.otel.metrics;
  const TimeWindow& window = request.window;
  const std::string visibility = otel::service_allowlist_predicate(host.otel.traces);
  // The answer names the host (source_host_id): hosts that share an identity do not share it.
  const std::string key = source_host_id + '\x1f' + host.system_uri + '\x1f' + metrics.database + '\x1f' + metrics.table_prefix + '\x1f' +
                          visibility + '\x1f' + std::to_string(window.start_ms / 60000) + '\x1f' + std::to_string(window.end_ms / 60000);
  // One read per key at a time: a second viewer of the same window waits for it (the scan covers the whole window).
  const auto result = catalog_.get(
      key,
      [&](CatalogSnapshot& snapshot, std::string& code, std::string& message) {
        std::string error;
        auto db = open_(host, &error);
        if (!db) {
          code = "metrics_source_unavailable";
          message = connect_error(error);
          return false;
        }
        snapshot.source_host_id = source_host_id;
        snapshot.window = window;
        int64_t query_ms = 0;
        const auto kinds_started = Clock::now();
        snapshot.kinds = existing_kinds(*db, host);
        query_ms += elapsed_ms(kinds_started);

        const std::string sql = catalog_sql(metrics, snapshot.kinds, visibility, window);
        if (!sql.empty()) {
          const auto query_started = Clock::now();
          // The catalog groups every point of its window: past this many rows read, the scan stops and the counts are estimates.
          ChQueryLimits catalog_limits = ChQueryScope::current_copy();
          catalog_limits.max_rows_to_read = kCatalogReadRowsCap;
          catalog_limits.read_overflow_mode = "break";
          ChQueryScope catalog_scope(std::move(catalog_limits));
          const BoundedRead read = db->bounded_select(sql, [&](const clickhouse::Block& block) {
            for (size_t row = 0; row < block.GetRowCount(); ++row) {
              if (snapshot.rows >= kCatalogLimit) {
                snapshot.truncated = true;
                continue;
              }
              ++snapshot.rows;
              CatalogEntry e;
              e.kind = ch_block_text_at(block, 0, row);
              const std::string service = ch_block_text_at(block, 1, row);
              e.metric = ch_block_text_at(block, 2, row);
              e.unit = ch_block_text_at(block, 3, row);
              e.description = ch_block_text_at(block, 4, row);
              const std::string tmin = ch_block_text_at(block, 5, row);
              const std::string tmax = ch_block_text_at(block, 6, row);
              if (!tmin.empty()) {
                if (tmin != tmax) e.temporality = "mixed";
                else if (tmin == "1") e.temporality = "delta";
                else if (tmin == "2") e.temporality = "cumulative";
              }
              const std::string mono_max = ch_block_text_at(block, 8, row);
              if (!mono_max.empty()) e.monotonic = mono_max == "1" ? 1 : 0;
              e.points = text_to_i64(ch_block_text_at(block, 9, row));
              snapshot.services[service].push_back(std::move(e));
            }
          });
          snapshot.estimated = read.capped(kCatalogReadRowsCap);
          query_ms += elapsed_ms(query_started);
        }
        if (snapshot.kinds.empty()) {
          snapshot.missing_message = "No OpenTelemetry exporter metrics tables named " + metrics.database + "." + metrics.table_prefix +
                                     "_{gauge,sum,histogram,exponential_histogram,summary} exist.";
        }
        snapshot.query_ms = query_ms;
        return true;
      },
      request.refresh);
  if (!result.has_value && !result.exception) {
    return Out::fail(make_error(503, result.error_code.empty() ? "metrics_query_failed" : result.error_code, result.error_message));
  }
  CatalogAnswer answer;
  try {
    answer.snapshot = CatalogCache::value_or_throw(result);
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "metrics", "metrics_query_failed"));
  }
  answer.hit = !result.fetched;
  answer.age_ms = static_cast<int64_t>(result.age_ms);
  // A request that did not read spends no query time.
  answer.query_ms = result.fetched ? answer.snapshot->query_ms : 0;
  answer.total_ms = elapsed_ms(started);
  return Out::ok(std::move(answer));
}

// ---------------------------------------------------------------------------
// The attributes of a metric

Result<AttributesAnswer> MetricsService::attributes(const RequestContext&, const HostSpec& host, const AttributesRequest& request) const {
  using Out = Result<AttributesAnswer>;
  const auto started = Clock::now();
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "metrics_source_unavailable", connect_error(error)));
  try {
    if (auto problem = check_kind_table(*db, host, request.kind)) return Out::fail(std::move(*problem));
    const std::string table = kind_table(host.otel.metrics, request.kind);
    const std::string visibility = otel::service_allowlist_predicate(host.otel.traces);
    AttributesAnswer answer;
    answer.kind = request.kind;
    answer.service = request.service;
    answer.metric = request.metric;
    if (request.key.empty()) {
      const Statement statement = attribute_keys_statement(table, visibility, request);
      const auto query_started = Clock::now();
      db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) answer.keys.push_back(ch_block_text_at(block, 0, row));
      });
      answer.query_ms = elapsed_ms(query_started);
      answer.truncated = answer.keys.size() > kAttributeKeyLimit;
      if (answer.truncated) answer.keys.resize(kAttributeKeyLimit);
      std::sort(answer.keys.begin(), answer.keys.end());
    } else {
      if (request.key.size() > 256) return Out::fail(bad_request("key is too long."));
      answer.key = request.key;
      const Statement statement = attribute_values_statement(table, visibility, request);
      const auto query_started = Clock::now();
      db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          answer.values.emplace_back(ch_block_text_at(block, 0, row), text_to_i64(ch_block_text_at(block, 1, row)));
        }
      });
      answer.query_ms = elapsed_ms(query_started);
      answer.truncated = answer.values.size() > kAttributeValueLimit;
      if (answer.truncated) answer.values.resize(kAttributeValueLimit);
    }
    answer.total_ms = elapsed_ms(started);
    return Out::ok(std::move(answer));
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "metrics", "metrics_query_failed"));
  }
}

// ---------------------------------------------------------------------------
// The values of a metric

Result<SeriesAnswer> MetricsService::series(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                            const SeriesRequest& request) const {
  using Out = Result<SeriesAnswer>;
  const auto started = Clock::now();
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "metrics_source_unavailable", connect_error(error)));
  try {
    if (auto problem = check_kind_table(*db, host, request.kind)) return Out::fail(std::move(*problem));
    const std::string table = kind_table(host.otel.metrics, request.kind);
    const std::string visibility = otel::service_allowlist_predicate(host.otel.traces);
    SeriesAnswer answer;
    answer.source_host_id = source_host_id;
    answer.request = request;
    SeriesStatements statements(answer.request, table, visibility, /*with_scope=*/false);
    int64_t query_ms = 0;

    const Statement info_statement = statements.info();
    const auto info_started = Clock::now();
    db->select(info_statement.sql, info_statement.params.list(), [&](const clickhouse::Block& block) { read_metric_info(block, &answer.info); });
    query_ms += elapsed_ms(info_started);

    std::string plan_error;
    if (!plan_aggregation(request.kind, answer.info, request.agg, &answer.plan, &plan_error)) return Out::fail(bad_request(plan_error));
    const AggregationPlan& plan = answer.plan;
    const std::string quantile = plan.mode == Mode::SummaryQuantile ? summary_quantile_literal(answer.info, plan.agg) : std::string();
    const Statement statement = statements.series(plan.mode, plan.all_delta, quantile);

    std::map<std::string, Group> groups;
    size_t rows = 0;
    const auto query_started = Clock::now();
    db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        if (rows >= kMaxSeriesRows) {
          answer.truncated_rows = true;
          continue;
        }
        ++rows;
        add_series_row(block, row, plan.mode, &groups);
      }
    });
    query_ms += elapsed_ms(query_started);

    const double bucket_seconds = static_cast<double>(request.grid.size_ms) / 1000.0;
    RankedGroups ranked = rank_groups(&groups, plan.mode, plan.agg, bucket_seconds, request.top_k, plan.per_series);
    answer.group_count = groups.size();
    answer.other_count = ranked.other_count;
    answer.other = std::move(ranked.other);
    for (size_t i = 0; i < ranked.kept; ++i) answer.series.push_back(*ranked.ordered[i]);
    answer.timestamps = bucket_timestamps(request.grid, request.window);

    answer.value_unit = answer.info.unit;
    if (plan.agg == "rate") answer.value_unit = answer.info.unit.empty() ? "/s" : answer.info.unit + "/s";
    else if (plan.agg == "count_rate") answer.value_unit = "/s";
    else if (plan.agg == "count") answer.value_unit = "";

    answer.query_ms = query_ms;
    answer.total_ms = elapsed_ms(started);
    return Out::ok(std::move(answer));
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "metrics", "metrics_query_failed"));
  }
}

// ---------------------------------------------------------------------------
// The exemplars of a metric

Result<ExemplarsAnswer> MetricsService::exemplars(const RequestContext&, const HostSpec& host, const std::string& source_host_id,
                                                  const ExemplarsRequest& request) const {
  using Out = Result<ExemplarsAnswer>;
  const auto started = Clock::now();
  std::string error;
  auto db = open_(host, &error);
  if (!db) return Out::fail(make_error(503, "metrics_source_unavailable", connect_error(error)));
  try {
    if (auto problem = check_kind_table(*db, host, request.kind)) return Out::fail(std::move(*problem));
    const std::string table = kind_table(host.otel.metrics, request.kind);
    const std::string visibility = otel::service_allowlist_predicate(host.otel.traces);
    const Statement statement = exemplars_statement(table, visibility, request);
    ExemplarsAnswer answer;
    answer.source_host_id = source_host_id;
    answer.request = request;
    const auto query_started = Clock::now();
    db->select(statement.sql, statement.params.list(), [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        answer.exemplars.push_back(ExemplarRow{text_to_i64(ch_block_text_at(block, 1, row)), text_to_double(ch_block_text_at(block, 2, row)),
                                               ch_block_text_at(block, 3, row), ch_block_text_at(block, 4, row),
                                               ch_block_text_at(block, 5, row)});
      }
    });
    answer.query_ms = elapsed_ms(query_started);
    answer.truncated = answer.exemplars.size() > static_cast<size_t>(request.limit);
    if (answer.truncated) answer.exemplars.resize(static_cast<size_t>(request.limit));
    std::sort(answer.exemplars.begin(), answer.exemplars.end(), [](const ExemplarRow& a, const ExemplarRow& b) { return a.t < b.t; });
    answer.traces_enabled = host.otel.traces.enabled;
    answer.total_ms = elapsed_ms(started);
    return Out::ok(std::move(answer));
  } catch (const std::exception& e) {
    return Out::fail(error_from_clickhouse(e, "metrics", "metrics_query_failed"));
  }
}

}  // namespace metrics
}  // namespace chdash
