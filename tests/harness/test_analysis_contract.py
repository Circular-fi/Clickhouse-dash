from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_run_with_profiling_is_explicit_and_query_scoped() -> None:
    api = read("src/api_query.cpp")
    session = read("src/query_session.cpp")
    assert 'QueryRunMode run_mode = QueryRunMode::Normal;' in api
    assert 'mode == "profiling"' in api
    assert 'authenticate_request' not in api
    assert 'host->runner_uri' in api
    assert 'if (!detailed_profiling_) return;' in session
    assert 'set_bool("log_queries")' in session
    assert 'set_bool("log_profile_events")' in session
    assert 'set_bool("log_processors_profiles")' in session
    assert 'set_bool("log_query_views")' in session
    assert 'set_bool("opentelemetry_trace_processors")' in session
    assert 'set_bool("opentelemetry_start_trace_probability")' in session
    assert 'query.SetSetting(name, field);' in session
    assert 'SETTINGS log_processors_profiles' not in session


def test_normal_run_does_not_implicitly_invoke_analysis() -> None:
    api = read("src/api_query.cpp")
    session = read("src/query_session.cpp")
    assert 'QueryRunMode::Normal' in api
    config = read("src/config.cpp")
    assert 'collect_query_analysis' not in api
    assert 'SYSTEM FLUSH LOGS' not in api
    assert 'system.query_log' not in session
    assert 'final_stats_from_query_log' not in config
    assert 'final_stats_flush_logs' not in config
    assert 'send_profile_events' in session  # pre-existing interactive telemetry only


def test_analysis_uses_host_registry_and_runner_acl_without_user_auth() -> None:
    source = read("src/api_analysis.cpp")
    assert 'authenticate_request' not in source
    assert 'query_registry_->find(query_id, host_id)' in source
    assert 'analysis_not_found' in source
    assert 'query_not_finished' in source
    assert 'discover_allowed_objects(*runner)' in source
    assert 'filter_analysis(analysis, *allowed_result.value)' in source
    assert 'allowed_qualified_name' in source


def test_analysis_log_lookup_is_bounded_and_flush_is_opt_in() -> None:
    source = read("src/query_analysis.cpp")
    assert 'options.log_lookup_timeout_ms' in source
    assert 'std::this_thread::sleep_for(std::chrono::milliseconds(50))' in source
    assert 'if (options.flush_logs)' in source
    assert 'SYSTEM FLUSH LOGS query_log, processors_profile_log, query_views_log' in source
    assert 'system.processors_profile_log' in source
    assert 'system.query_views_log' in source
    assert 'system.query_log' in source
    assert 'system.opentelemetry_span_log' in source
    assert 'SYSTEM FLUSH LOGS opentelemetry_span_log' in source



def test_analysis_collection_failures_are_explicit_not_partial_success() -> None:
    collector = read("src/query_analysis.cpp")
    api = read("src/api_analysis.cpp")

    flush = collector[collector.index("if (options.flush_logs)"):collector.index("const auto deadline")]
    assert "catch (const std::exception& e)" in flush
    assert 'result.fatal_error = std::string("SYSTEM FLUSH LOGS failed: ") + e.what();' in flush
    assert "return result;" in flush
    assert "catch (...)" not in flush
    assert 'result.fatal_error = std::string("query_log lookup failed: ") + e.what();' in collector
    assert 'if (!analysis.fatal_error.empty())' in api
    assert 'json_error(res, 503, "analysis_collection_failed", analysis.fatal_error)' in api

def test_optional_distributed_lookup_failure_is_preserved_in_payload() -> None:
    collector = read("src/query_analysis.cpp")
    api = read("src/api_analysis.cpp")
    ui = read("src/static/app_analysis.js")
    assert "result.distributed_error = e.what();" in collector
    assert 'writer.Key("distributed_error")' in api
    # Views/distributed diagnostics remain backend/export data. The UI exposes
    # only the processor Pipeline and raw Tracing tabs.
    assert "analysisDistributedTab" not in ui


def test_analysis_ui_supports_single_multi_and_pipeline_degradation() -> None:
    html = read("src/static/index.html")
    api = read("src/static/app_api.js")
    run = read("src/static/app_run.js")
    results = read("src/static/app_results.js")
    analysis = read("src/static/app_analysis.js")
    assert 'id="runWithProfilingButton"' in html
    assert 'id="analysisModalBackdrop"' in html
    assert 'api/query/analysis' in api
    assert 'handleRunMode("profiling")' in run
    assert 'analysis.setContext({ hostId, queryId: out.queryId, runMode })' in run
    assert 'setAnalyzeAction' in results
    assert 'Execution stopped by result preview limit.' in analysis
    assert 'id="analysisTabs"' in html
    assert 'id="analysisPipelineTab"' in html
    assert 'id="analysisTraceTab"' in html
    assert 'ns.pipelineViewer.render(root' in analysis
    assert 'ns.traceViewer.render(root' in analysis
    trace_viewer = read("src/static/app_trace_viewer.js")
    assert 'traceViewer__row' in trace_viewer
    assert 'start_time_us' in trace_viewer
    assert 'finish_time_us' in trace_viewer


def test_analysis_exposes_session_elapsed_separately_from_clickhouse_duration() -> None:
    registry_h = read("src/query_registry.hpp")
    registry_cpp = read("src/query_registry.cpp")
    query_api = read("src/api_query.cpp")
    session_h = read("src/query_session.hpp")
    session_cpp = read("src/query_session.cpp")
    analysis_api = read("src/api_analysis.cpp")
    analysis_ui = read("src/static/app_analysis.js")

    assert "int64_t session_elapsed_ms = -1;" in registry_h
    assert "int64_t session_elapsed_ms);" in registry_h
    assert "it->second.session_elapsed_ms = std::max<int64_t>(0, session_elapsed_ms);" in registry_cpp
    assert "std::function<void(SessionStatus, int64_t)> terminal_status_observer" in session_h
    assert "elapsed_ms = ms_since(started_at_, finished_at_);" in session_cpp
    assert "terminal_status_observer_(status, elapsed_ms);" in session_cpp
    assert "SessionStatus status, int64_t session_elapsed_ms" in query_api
    assert "session_elapsed_ms);" in query_api
    assert 'writer.Key("session_elapsed_ms"); writer.Int64(record->session_elapsed_ms);' in analysis_api
    assert 'parts.push(`ClickHouse ${fmtMs(overview.duration_ms)}`)' in analysis_ui
    assert 'parts.push(`Session ${fmtSessionElapsed(data.session_elapsed_ms)}`)' in analysis_ui
    assert 'util.formatSeconds(Number(v) / 1000)' in analysis_ui


def test_analysis_system_log_strings_are_normalized_before_cpp_decoding() -> None:
    cpp = read("src/query_analysis.cpp")

    assert "toString(hostname())" in cpp
    assert "toString(query_id)" in cpp
    assert "toString(initial_query_id)" in cpp
    assert "toString(plan_step_name)" in cpp
    assert "toString(view_name)" in cpp
    assert "toString(exception)" in cpp



def test_test_system_account_can_flush_profile_logs_immediately() -> None:
    users = (ROOT / "tests/clickhouse-init/01-chdash-users.sql").read_text(encoding="utf-8")
    docs = (ROOT / "docs/configuration.md").read_text(encoding="utf-8")
    assert "GRANT SYSTEM FLUSH LOGS ON *.* TO chdash_system;" in users
    assert "GRANT SYSTEM FLUSH LOGS ON *.* TO chdash_system;" in docs



def test_integration_analysis_requires_real_processor_samples() -> None:
    config = (ROOT / "tests/config/CH_HOSTS.local.hcl").read_text(encoding="utf-8")
    routes = (ROOT / "tests/backend-functional/test_routes.py").read_text(encoding="utf-8")
    functional = (ROOT / "tests/frontend/specs/functional.spec.js").read_text(encoding="utf-8")
    design = (ROOT / "tests/frontend/specs/design.spec.js").read_text(encoding="utf-8")

    assert "flush_logs = true" in config
    assert 'analysis.get("processor_profiling_recorded") is True' in routes
    assert "traceViewer__row" in functional
    assert "analysis-trace" in design


def test_profiling_trace_uses_real_clickhouse_otel_wall_clock_spans() -> None:
    analysis = read("src/static/app_analysis.js")
    css = read("src/static/style.css")
    collector = read("src/query_analysis.cpp")
    session = read("src/query_session.cpp")

    assert 'set_bool("opentelemetry_trace_processors")' in session
    assert 'set_bool("opentelemetry_start_trace_probability")' in session
    assert 'system.opentelemetry_span_log' in collector
    assert 'start_time_us' in collector and 'finish_time_us' in collector
    assert "attribute[\'clickhouse.query_id\']" in collector
    viewer = read("src/static/app_trace_viewer.js")
    assert 'traceViewer__row' in viewer
    assert 'start_time_us' in viewer and 'finish_time_us' in viewer
    assert '.traceViewer__bar' in css
    assert 'ns.traceViewer.render(root' in analysis

def test_analysis_has_pipeline_first_trace_second_and_modal_uses_nearly_full_viewport() -> None:
    html = read("src/static/index.html")
    ui = read("src/static/app_analysis.js")
    css = read("src/static/style.css")

    assert 'id="analysisTabs"' in html
    assert 'id="analysisPipelineTab"' in html and 'id="analysisTraceTab"' in html
    assert 'analysisViewsTab' not in html and 'analysisDistributedTab' not in html
    assert 'let activeTab = "pipeline";' in ui
    assert 'if (activeTab === "tracing") renderTrace();' in ui
    assert 'else renderPipeline();' in ui
    assert 'ns.traceViewer.render(root' in ui
    backdrop = css[css.index(".analysisModalBackdrop"):css.index(".analysisModalBackdrop[hidden]")]
    assert 'padding: 6px' in backdrop
    assert 'width: min(1800px, calc(100vw - 12px));' in css
    assert 'height: calc(100vh - 12px);' in css
    assert 'padding: 6px 8px 8px;' in css


def test_trace_uses_real_otel_wall_clock_without_processor_counter_reconstruction() -> None:
    analysis = read("src/static/app_analysis.js")
    viewer = read("src/static/app_trace_viewer.js")
    assert 'ns.traceViewer.render(root' in analysis
    assert 'decodeTraceSpans(payload)' in analysis
    assert 'trace_compact' in analysis
    assert 'elapsed - waitTotal' not in analysis
    assert 'processorPhases' not in analysis
    assert 'traceGroups' not in analysis
    assert 'span.start - model.start' in viewer
    assert 'span.duration / model.window' in viewer
