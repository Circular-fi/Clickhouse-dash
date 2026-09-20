from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_explorer_detail_cache_uses_metadata_revision_without_hover_prefetch():
    catalog_hpp = read("src/explorer_catalog.hpp")
    catalog_cpp = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")

    assert "metadata_modification_time" in catalog_hpp
    assert "toString(metadata_modification_time)" in catalog_cpp
    assert "kExplorerTableDetailCacheTtlMs = 30 * 1000" in api
    assert "detailMatchesCatalog" in ui
    assert "applyFreshSidebarSummary" in ui
    assert "prefetchTableDetail" not in ui
    assert 'addEventListener("pointerenter"' not in ui


def test_pipeline_reports_effective_processor_profile_state():
    query = read("src/query_analysis.cpp")
    api = read("src/api_analysis.cpp")
    viewer = read("src/static/app_pipeline_viewer.js")

    assert "Settings['log_processors_profiles']" in query
    for status in (
        "recorded",
        "table_unavailable",
        "query_log_pending",
        "disabled_for_query",
        "enabled_no_rows",
        "unknown_no_rows",
    ):
        assert status in api
    assert "log_processors_profiles=0" in viewer


def test_health_capabilities_only_probe_features_consumed_by_product():
    header = read("src/health_runner.hpp")
    source = read("src/health_runner.cpp")
    hosts = read("src/api_hosts.cpp")
    joined = header + source + hosts

    for capability in (
        "query_log",
        "query_views_log",
        "processors_profile_log",
        "opentelemetry_span_log",
    ):
        assert capability in joined
    for legacy in (
        "flamegraph_tables_available",
        "logs_table_available",
        "jemalloc_profile_text",
        "query_thread_log",
    ):
        assert legacy not in joined


def test_trace_explorer_is_config_gated_and_uses_otel_clickhouse_schema():
    config = read("src/config.cpp")
    server = read("src/server.cpp")
    api = read("src/api_traces.cpp")
    example = read("config.example.hcl")

    assert 'optional_block(root, "traces"' in config
    assert 'if (cfg_.traces.enabled)' in server
    assert 'http_.Get("/api/traces/meta"' in server
    assert 'http_.Get("/api/traces/search"' in server
    assert 'http_.Get("/api/traces/trace"' in server
    for column in (
        "Timestamp",
        "TraceId",
        "SpanId",
        "ParentSpanId",
        "SpanName",
        "ServiceName",
        "Duration",
        "StatusCode",
    ):
        assert column in api
    assert "otel_traces" in example
    assert "otel_traces_trace_id_ts" in example
    assert "credential_scope" not in example
    assert "host_id" not in example[example.index("traces {"):example.index("analysis {")]


def test_trace_search_is_bounded_and_trace_detail_prefers_aux_index():
    api = read("src/api_traces.cpp")
    trace_ui = read("src/static/app_traces.js")
    trace_html = read("src/static/traces.html")

    assert "Timestamp >= fromUnixTimestamp64Milli" in api
    assert "start_ms" in api and "end_ms" in api
    assert "candidate_ids" in api
    assert "TraceId IN (SELECT TraceId FROM candidate_ids)" in api
    detail = api[api.index("void Server::handle_trace_detail"): ]
    assert 'WITH " + trace_literal + " AS trace' in detail
    assert "SELECT min(Start) - toIntervalSecond(1)" in detail
    assert "SELECT max(End) + toIntervalSecond(1)" in detail
    assert "PREWHERE Timestamp >= trace_start AND Timestamp <= trace_end" in detail
    assert "WHERE TraceId = trace AND" in detail
    assert 'w.Key("range_source"); w.String("trace_index");' in detail
    assert "full_trace_id_lookup" not in detail
    assert "max_lookback_minutes" not in detail
    assert "traceWaterfall" in trace_ui
    assert "traceInspector" in trace_ui
    assert "traceWaterfall" in trace_html
