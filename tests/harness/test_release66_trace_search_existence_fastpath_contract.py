from pathlib import Path
from trace_sources import read_traces, read_unit

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()


def test_trace_prefill_uses_existence_and_tag_discovery_is_removed():
    cpp = read("src/api_traces.cpp")
    server = read("src/server.cpp")
    api = read("src/static/app_api.js")
    prefill = cpp[cpp.index("void Server::handle_traces_prefill"):cpp.index("void Server::handle_traces_search")]
    assert "LIMIT 1 BY ServiceName, SpanName LIMIT" in prefill
    assert "GROUP BY ServiceName, SpanName" not in prefill
    assert "handle_traces_tags" not in cpp
    assert '/api/traces/tags' not in server
    assert "getTraceTags" not in api


def test_filtered_trace_search_is_index_driven_and_bounded_before_enrichment():
    search_unit = read_unit("trace_search.cpp")
    sql = read_unit("trace_sql.cpp")
    search = search_unit[search_unit.index("select_by_index("):search_unit.index("SearchOutcome search_traces")]
    cursor = search_unit[search_unit.index("void TraceIndexCursor::fill"):search_unit.index("// ---- the broad form of the filters ----")]
    assert "kCandidateBatch = 1000" in read_unit("trace_search.hpp")
    assert "kCandidateScanCap = 64000" in read_unit("trace_search.hpp")
    assert "TraceIndexCursor cursor(db, scope.index_table, scope.start_ms, scope.end_ms);" in search
    # Keyset pagination over disjoint, fully-read Start slices: no OFFSET
    # re-sorting per page, no tie skipped at a page seam, one row per trace
    # per slice (bounded queries for traces with many index rows).
    assert "OFFSET " not in search and "OFFSET " not in cursor and "OFFSET " not in sql
    slice_sql = sql[sql.index("std::string index_slice_sql"):sql.index("std::string index_count_sql")]
    assert "max(Start), 9)" in slice_sql and '" GROUP BY TraceId LIMIT "' in slice_sql
    assert "hi_ns_ = lo - 1;" in cursor
    assert "kSliceRowCap" in cursor
    assert "seen_.insert(row.trace_id).second" in cursor
    assert "last - 1" not in cursor
    # Each page's span match reads only the page's index time bounds.
    match = sql[sql.index("std::string batch_match_sql"):sql.index("std::string broad_having")]
    assert "AS batch_bounds" in match
    assert "tupleElement(batch_bounds, 1)" in match and "tupleElement(batch_bounds, 2)" in match
    assert '" LIMIT 1 BY TraceId"' in match
    assert 'search_path = "trace_index_filtered"' in search
    summary = sql[sql.index("std::string summary_sql"):]
    assert '" WHERE " + scope.visibility + " AND TraceId IN " + ids_list' in summary
    # Per-service stats are aggregated server-side: O(services), not O(spans).
    assert "sumMap([toString(ServiceName)], [toUInt64(1)], [toUInt64(StatusCode = 'Error')])" in summary
    assert "groupArray(concat(toString(ServiceName)" not in summary


def test_span_based_trace_search_ranks_newest_slice_first_then_summarizes():
    search_unit = read_unit("trace_search.cpp")
    sql = read_unit("trace_sql.cpp")
    search = search_unit[search_unit.index("SearchOutcome search_traces"):]
    rank = search_unit[search_unit.index("std::vector<RankedTrace> rank_traces_by_start"):search_unit.index("// ---- the search ----")]
    assert "rank_traces_by_start(db, scope, broad, limit)" in search
    assert 'search_path = "span_duration_two_phase"' in search
    # Exactness: traces with visible window spans before the slice are probed and dropped.
    assert '" AND Timestamp < " + ns_time(before_ns)' in sql
    assert "straddlers.count(row.trace_id) == 0" in rank
    assert '" GROUP BY TraceId" + slice.having + " ORDER BY min(Timestamp) DESC LIMIT' in sql
    # Broad service / operation filters become one HAVING countIf pass.
    assert '" HAVING countIf(1" + span_filters + ") > 0"' in sql
    assert "having = broad_having(scope.span_filters, scope.having)" in rank
    assert "filters_are_broad(db, scope)" in search
    # The last resort is exactly the whole-window query.
    assert "if (whole) return rows;" in rank


def test_trace_attribute_map_schema_is_cached_per_source():
    cpp = read("src/api_traces.cpp")
    service = read_unit("trace_service.cpp")
    attributes = read_unit("trace_attributes.cpp")
    meta = cpp[cpp.index("void Server::handle_traces_meta"):cpp.index("void Server::handle_traces_prefill")]
    # Every window route resolves its filters in open_scope, which reads the
    # cached attribute schema only when tag filters are present.
    open_scope = service[service.index("TraceService::open_scope"):service.index("Result<SearchAnswer> TraceService::search")]
    assert "if (!request.filters.tags.empty()) {" in open_scope
    assert "attribute_columns(*opened.db, attribute_maps_, host, traces)" in open_scope
    for route in ("search", "analytics", "service_map", "heatmap", "deltas"):
        assert f"TraceService::{route}(" in service and "open_scope(host, request" in service
    assert "cache.get(" in attributes and "cached_attribute_maps(" in attributes
    assert "trace::store_attribute_maps(trace_attribute_maps_cache_, *host, traces" in meta
    # One cache for the server (a member of Server, trace_service.hpp), with a 60 s TTL.
    assert "options.ttl = std::chrono::seconds(60);" in attributes
    assert "trace_attribute_maps_cache_{trace::attribute_map_cache_options()}" in read("src/server.hpp")


def test_trace_analytics_is_separate_and_deduplicates_by_existence():
    sql = read_unit("trace_sql.cpp")
    analytics_unit = read_unit("trace_analytics.cpp")
    json = read_unit("trace_json.cpp")
    search_json = json[json.index("std::string search_json"):json.index("std::string analytics_json")]
    cte = sql[sql.index("std::string trace_durations_cte"):sql.index("AnalyticsGrid analytics_grid")]
    assert "analytics_sql" not in read_unit("trace_search.cpp")
    assert 'w.Key("trace_count_chart")' not in search_json
    # Span filters are deduplicated by existence before the span aggregation.
    assert "candidate_ids AS (SELECT TraceId" in cte
    assert '" LIMIT 1 BY TraceId)"' in cte
    # Quantiles never come from the trace index (End = max(Timestamp)).
    assert 'w.Key("duration_quantiles_source"); write_json_text(w, "span_bounds");' in json
    assert "trace_bounds AS" not in analytics_unit
    assert "db.select(analytics_sql(scope, broad, grid)" in analytics_unit
    assert "count_by_bucket" in analytics_unit
    assert "std::gcd(bucket_seconds, quantile_bucket_seconds)" in sql


def test_trace_detail_has_no_all_history_traceid_fallback():
    cpp = read("src/api_traces.cpp")
    detail = cpp[cpp.index("void Server::handle_trace_detail"):]
    assert "full_trace_id_lookup" not in detail
    assert "used_full_trace_lookup" not in detail
    assert "fromUnixTimestamp64Nano(min(Timestamp))" not in detail
    assert 'w.Key("range_source"); w.String("trace_index");' in detail
    assert "trace_index_lookup_failed" in detail


def test_trace_filters_never_use_like_or_ilike():
    cpp = read("src/api_traces.cpp")
    trace_code = read_traces()
    assert " ILIKE " not in trace_code
    assert " LIKE " not in trace_code
    assert "service_match" not in trace_code
    assert "operation_match" not in trace_code
    assert 'exact_values_predicate("ServiceName", spec.services)' in trace_code
    assert 'exact_values_predicate("SpanName", spec.operations)' in trace_code
