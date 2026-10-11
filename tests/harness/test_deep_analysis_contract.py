from pathlib import Path
import config_keys
from session_sources import read_session


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_deep_analysis_is_a_separate_explicit_endpoint() -> None:
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    api = read("src/api_analysis.cpp")
    query_api = read("src/api_query.cpp")
    session = read_session()

    assert 'Post("/api/query/deep-analysis"' in server
    assert 'Get("/api/query/deep-analysis"' in server
    assert 'Post("/api/query/deep-analysis/cancel"' in server
    assert "handle_query_deep_analysis" in header and "handle_query_deep_analysis_status" in header and "handle_query_deep_analysis_cancel" in header
    assert "cfg_.analysis.allow_deep_analyze" in api
    assert "authenticate_request" not in api
    assert "query_registry_->find(query_id, host_id)" in api
    assert "host.runner_uri, client_pool_, &deep, &error" in api
    assert "run_deep_analysis" not in query_api
    assert "EXPLAIN ANALYZE" not in session


def test_deep_analysis_is_a_bounded_job_that_can_be_polled_and_canceled() -> None:
    # ARCH-B-016: the request does not wait for EXPLAIN ANALYZE. POST starts a job that holds a place of the analysis admission
    # until it ends, GET polls it, POST .../cancel stops it and KILLs its statements; the store of jobs is bounded.
    api = read("src/api_analysis.cpp")
    jobs = read("src/deep_analysis_jobs.hpp")
    header = read("src/server.hpp")
    assert "admit(WorkClass::Analysis, req, res)" in api
    assert "ticket = std::move(*ticket)" in api and "ticket = Admission::Ticket();" in api
    assert "group->enter()" in api and "group->leave();" in api  # the server waits for the thread before it goes
    assert "res.status = 202;" in api
    assert "kill_deep_statements(" in api and "query_started" in read("src/deep_analysis.hpp")
    assert "add_stop_hook(" in api  # a stop of the server cancels the job
    assert "limits.deadline = std::chrono::steady_clock::now() + std::chrono::seconds(cfg_.analysis.deep_max_execution_time_s);" in api
    assert "DeepAnalysisJobs deep_jobs_{16, 64u * 1024u * 1024u, std::chrono::minutes(10)};" in header
    assert "max_jobs" in jobs and "max_bytes" in jobs and "retention" in jobs
    assert config_keys.row("analysis", "deep_max_execution_time_s")["kind"] == "INT"
    assert 'Allow Deep Analyze' in read("src/config_keys.def")


def test_deep_analysis_replays_exact_bounded_original_sql() -> None:
    registry_h = read("src/query_registry.hpp")
    registry_cpp = read("src/query_registry.cpp")
    query_api = read("src/api_query.cpp")
    config = read("src/config.cpp")

    assert "std::string original_sql;" in registry_h
    assert config_keys.row("analysis", "registry_sql_max_bytes")["field"] == "c.analysis.registry_sql_max_bytes"
    assert "const std::string registry_sql = sql;" in query_api
    assert "register_query(qid, host_id, run_mode, registry_sql)" in query_api
    assert "retained_sql_bytes_" in registry_cpp
    assert "trim_sql_budget_locked(query_id);" in registry_cpp
    assert "original_sql.clear();" in registry_cpp


def test_deep_analysis_is_fail_closed_for_mutating_statements() -> None:
    source = read("src/deep_analysis.cpp")

    assert 'keyword == "select" || keyword == "with"' in source
    assert '"EXPLAIN AST\\n" + record.original_sql' in source
    assert "ast_is_select_family(ast_lines)" in source
    assert 'starts_with(value, "SelectWithUnionQuery")' in source
    assert '"EXPLAIN ANALYZE\\n" + record.original_sql' in source
    assert "deep_analysis_unsafe_query" in source


def test_deep_analysis_uses_runner_and_discards_result_rows() -> None:
    source = read("src/deep_analysis.cpp")
    api = read("src/api_analysis.cpp")

    assert "const std::string& runner_uri" in source
    assert "system_uri" not in source
    assert 'writer.Key("reexecuted"); writer.Bool(true);' in api
    assert 'writer.Key("result_rows_returned"); writer.Bool(false);' in api
    assert 'writer.Key("statement_policy"); writer.String("select_family_only");' in api


def test_deep_analysis_and_raw_are_removed_from_the_current_ui_and_disabled_by_default() -> None:
    html = read("src/static/query.html")
    ui = read("src/static/app_analysis.js")
    header = read("src/server.hpp")
    example = read("config.example.hcl")

    assert 'id="deepAnalyzeButton"' not in html
    assert 'data-analysis-tab="deep"' not in html
    assert 'data-analysis-tab="raw"' not in html
    assert 'analysisRaw' not in ui
    assert 'runDeepAnalyze' not in ui
    assert 'bool allow_deep_analyze = false;' in header
    assert 'allow_deep_analyze    = false' in example
