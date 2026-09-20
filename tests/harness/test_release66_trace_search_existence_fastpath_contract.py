from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel):
    return (ROOT / rel).read_text()


def test_trace_discovery_uses_existence_instead_of_counting_every_span():
    cpp = read("src/api_traces.cpp")
    prefill = cpp[cpp.index("void Server::handle_traces_prefill"):cpp.index("void Server::handle_traces_tags")]
    assert "LIMIT 1 BY ServiceName, SpanName LIMIT" in prefill
    assert "GROUP BY ServiceName, SpanName" not in prefill
    tags = cpp[cpp.index("void Server::handle_traces_tags"):cpp.index("void Server::handle_traces_search")]
    assert "LIMIT 1 BY tag_key LIMIT 500" in tags
    assert "LIMIT 1 BY tag_value LIMIT 1000" in tags


def test_filtered_trace_search_is_index_driven_and_bounded_before_enrichment():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_trace_detail")]
    assert "kCandidateBatch = 1000" in search
    assert "ORDER BY Start DESC LIMIT 1 BY TraceId LIMIT" in search
    assert "OFFSET " in search
    assert '" LIMIT 1 BY TraceId"' in search
    assert 'search_path = "trace_index_filtered"' in search
    assert '" WHERE " + visibility + " AND TraceId IN " + trace_id_list' in search


def test_trace_analytics_deduplicates_by_existence_and_runs_one_quantile_rollup():
    cpp = read("src/api_traces.cpp")
    search = cpp[cpp.index("void Server::handle_traces_search"):cpp.index("void Server::handle_trace_detail")]
    assert "matching_ids AS (SELECT TraceId" in search
    assert "LIMIT 1 BY TraceId), " in search
    assert "read_analytics(analytics_sql)" in search
    assert "count_by_bucket" in search
    assert "std::gcd(bucket_seconds, quantile_bucket_seconds)" in search
