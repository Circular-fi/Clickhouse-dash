from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_user_sql_kill_query_is_blocked_in_run_and_export():
    policy = (ROOT / "src/user_sql_policy.cpp").read_text()
    query_api = (ROOT / "src/api_query.cpp").read_text()
    export_api = (ROOT / "src/api_export.cpp").read_text()
    cmake = (ROOT / "src/CMakeLists.txt").read_text()

    assert 'word_is(sql, token, "KILL")' in policy
    assert 'word_is(sql, tokens[next], "QUERY")' in policy
    assert "sql::lex(sql)" in policy
    assert "user_sql_is_forbidden(sql)" in query_api
    assert "user_sql_is_forbidden(sql)" in export_api
    # The code names the fault (a statement that is not allowed), not the policy: ARCH-B-067.
    assert '"sql_forbidden"' in query_api
    assert '"sql_forbidden"' in export_api
    assert "cancel_requires_token" not in query_api + export_api
    assert "user_sql_policy.cpp" in cmake


def test_the_export_kills_its_statements_through_the_system_account_like_a_run():
    export_api = (ROOT / "src/api_export.cpp").read_text()
    assert "host.system_uri.empty() ? host.runner_uri : host.system_uri" in export_api
    assert "kill_queries(uri, " in export_api
    assert "kill_queries(host.runner_uri" not in export_api


def test_cancel_backend_still_uses_system_side_uri():
    query_api = (ROOT / "src/api_query.cpp").read_text()
    session = (ROOT / "src/query_session.cpp").read_text()
    assert "host->system_uri.empty() ? host->runner_uri : host->system_uri" in query_api
    assert "stats_uri_.empty() ? runner_uri_ : stats_uri_" in session
    assert 'std::string where = "query_id IN (";' in session
    assert '"KILL QUERY WHERE " + where' in session
