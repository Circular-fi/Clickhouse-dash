from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_user_sql_kill_query_is_blocked_in_run_and_export():
    policy = (ROOT / "src/user_sql_policy.cpp").read_text()
    query_api = (ROOT / "src/api_query.cpp").read_text()
    export_api = (ROOT / "src/api_export.cpp").read_text()
    cmake = (ROOT / "src/CMakeLists.txt").read_text()

    assert 'first == "KILL"' in policy
    assert 'second == "QUERY"' in policy
    assert "user_sql_is_forbidden(sql)" in query_api
    assert "user_sql_is_forbidden(sql)" in export_api
    assert '"cancel_requires_token"' in query_api
    assert '"cancel_requires_token"' in export_api
    assert "user_sql_policy.cpp" in cmake


def test_cancel_backend_still_uses_system_side_uri():
    query_api = (ROOT / "src/api_query.cpp").read_text()
    session = (ROOT / "src/query_session.cpp").read_text()
    assert "host->system_uri.empty() ? host->runner_uri : host->system_uri" in query_api
    assert "stats_uri_.empty() ? runner_uri_ : stats_uri_" in session
    assert 'sql = "KILL QUERY WHERE query_id IN ("' in session
