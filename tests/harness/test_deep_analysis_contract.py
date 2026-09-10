from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_deep_analysis_is_a_separate_explicit_endpoint() -> None:
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    api = read("src/api_analysis.cpp")
    query_api = read("src/api_query.cpp")
    session = read("src/query_session.cpp")

    assert 'Post("/api/query/deep-analysis"' in server
    assert "handle_query_deep_analysis" in header
    assert "cfg_.analysis.allow_deep_analyze" in api
    assert "authenticate_request" not in api
    assert "query_registry_->find(query_id, host_id)" in api
    assert "run_deep_analysis(*record, host->runner_uri" in api
    assert "run_deep_analysis" not in query_api
    assert "EXPLAIN ANALYZE" not in session


def test_deep_analysis_replays_exact_bounded_original_sql() -> None:
    registry_h = read("src/query_registry.hpp")
    registry_cpp = read("src/query_registry.cpp")
    query_api = read("src/api_query.cpp")
    config = read("src/config.cpp")

    assert "std::string original_sql;" in registry_h
    assert "registry_sql_max_bytes" in config
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
    html = read("src/static/index.html")
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
