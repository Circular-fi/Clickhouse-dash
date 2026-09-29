from pathlib import Path

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
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_traces_analytics")]
    cursor = cpp[cpp.index("class TraceIndexCursor"):cpp.index("struct SpanRankQuery")]
    assert "kCandidateBatch = 1000" in search
    assert "kCandidateScanCap = 64000" in search
    assert "TraceIndexCursor cursor(*client, index_table, start_ms, end_ms);" in search
    # Keyset pagination over disjoint, fully-read Start slices: no OFFSET
    # re-sorting per page, no tie skipped at a page seam, one row per trace
    # per slice (bounded queries for traces with many index rows).
    assert "OFFSET " not in search and "OFFSET " not in cursor
    assert "max(Start), 9)" in cursor and '" GROUP BY TraceId LIMIT "' in cursor
    assert "hi_ns_ = lo - 1;" in cursor
    assert "kSliceRowCap" in cursor
    assert "seen_.insert(row.trace_id).second" in cursor
    assert "last - 1" not in cursor
    # Each page's span match reads only the page's index time bounds.
    assert "AS batch_bounds" in search
    assert "tupleElement(batch_bounds, 1)" in search and "tupleElement(batch_bounds, 2)" in search
    assert '" LIMIT 1 BY TraceId"' in search
    assert 'search_path = "trace_index_filtered"' in search
    assert '" WHERE " + visibility + " AND TraceId IN " + trace_id_list' in search
    # Per-service stats are aggregated server-side: O(services), not O(spans).
    assert "sumMap([toString(ServiceName)], [toUInt64(1)], [toUInt64(StatusCode = 'Error')])" in search
    assert "groupArray(concat(toString(ServiceName)" not in search


def test_span_based_trace_search_ranks_newest_slice_first_then_summarizes():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_traces_analytics")]
    rank = cpp[cpp.index("std::vector<RankedTrace> rank_traces_by_start"):cpp.index("} // namespace\n\nvoid Server::handle_traces_meta")]
    assert "rank_traces_by_start(*client, rank)" in search
    assert 'search_path = "span_duration_two_phase"' in search
    # Exactness: traces with visible window spans before the slice are probed and dropped.
    assert '" AND Timestamp < " + ns_time(t)' in rank
    assert "straddlers.count(row.trace_id) == 0" in rank
    assert "GROUP BY TraceId\" + having + \" ORDER BY min(Timestamp) DESC LIMIT" in rank
    # Broad service / operation filters become one HAVING countIf pass.
    assert 'having = " HAVING countIf(1" + q.span_filters + ") > 0"' in rank
    assert "filters_are_broad(*client, table, index_table" in search
    # The last resort is exactly the whole-window query.
    assert "if (whole) return rows;" in rank


def test_trace_attribute_map_schema_is_cached_per_source():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_traces_analytics")]
    analytics = cpp[cpp.index("void Server::handle_traces_analytics"):cpp.index("void Server::handle_trace_detail")]
    meta = cpp[cpp.index("void Server::handle_traces_meta"):cpp.index("void Server::handle_traces_prefill")]
    assert "cached_trace_attribute_maps(*client, *host, cfg_.traces" in search
    assert "cached_trace_attribute_maps(*client, *host, cfg_.traces" in analytics
    assert "store_trace_attribute_maps(*host, cfg_.traces" in meta
    assert "kAttributeMapCacheTtl" in cpp


def test_trace_analytics_is_separate_and_deduplicates_by_existence():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_traces_analytics")]
    analytics = cpp[cpp.index("void Server::handle_traces_analytics"):cpp.index("void Server::handle_trace_detail")]
    assert "read_analytics(analytics_sql)" not in search
    assert 'w.Key("trace_count_chart")' not in search
    # Span filters are deduplicated by existence before the span aggregation.
    assert "candidate_ids AS (SELECT TraceId" in analytics
    assert '" LIMIT 1 BY TraceId)"' in analytics
    # Quantiles never come from the trace index (End = max(Timestamp)).
    assert 'quantile_source = "span_bounds"' in analytics
    assert "trace_bounds AS" not in analytics
    assert "read_analytics(analytics_sql)" in analytics
    assert "count_by_bucket" in analytics
    assert "std::gcd(bucket_seconds, quantile_bucket_seconds)" in analytics


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
    trace_code = cpp[cpp.index("std::vector<std::string> repeated_param_values"):]
    assert " ILIKE " not in trace_code
    assert " LIKE " not in trace_code
    assert "service_match" not in trace_code
    assert "operation_match" not in trace_code
    assert 'exact_values_predicate("ServiceName", services)' in trace_code
    assert 'exact_values_predicate("SpanName", operations)' in trace_code
