"""Source contract of the statements and the connections of ChDash (src/ch_query.hpp).

Every statement goes through ch_select / ch_select_cancelable / ch_execute, so a connection that a
statement left in an unknown state is never lent again (ARCH-B-011), and every statement carries the
label and the bounds of its scope (ARCH-B-015..028, ARCH-B-101). Every connection is opened by
ch_open_client, which keeps its state. Every /api/ route that reads ClickHouse runs in a query scope.
The behaviour itself is tested by tests/native/ch_query_test.cpp (with a server) and by
backend-functional/test_query_bounds.py.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
SRC = ROOT / "src"


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def sources():
    for path in sorted(list(SRC.glob("*.cpp")) + list(SRC.glob("*.hpp"))):
        yield path.name, path.read_text(encoding="utf-8")


def test_no_statement_bypasses_the_connection_state():
    direct = re.compile(r"(?:\.|->)(Select|SelectCancelable|SelectWithExternalData\w*|Execute|Insert|BeginSelect|BeginInsert)\(")
    offenders = []
    for name, text in sources():
        if name == "ch_query.cpp":
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if direct.search(line):
                offenders.append(f"{name}:{number}: {line.strip()}")
    assert not offenders, "a statement must go through ch_select / ch_execute:\n" + "\n".join(offenders)


def test_every_connection_is_opened_by_ch_open_client():
    construct = re.compile(r"make_(?:unique|shared)<clickhouse::Client>|new clickhouse::Client\b|clickhouse::Client \w+\(")
    offenders = [name for name, text in sources() if name != "ch_query.cpp" and construct.search(text)]
    assert not offenders, offenders
    assert "ChClientPtr client(new clickhouse::Client(options));" in read("src/ch_query.cpp")
    assert "ch_open_client(*opt)" in read("src/ch_uri.cpp")
    assert "client = ch_open_client(*opt);" in read("src/ch_client_pool.cpp")


def test_a_statement_is_clean_only_when_clickhouse_ended_it():
    source = read("src/ch_query.cpp")
    execute = source[source.index("  void execute(const clickhouse::Query& query) {"):source.index("  // What the settings profile of the user allows")]
    assert "set_dirty(client_, true);" in execute
    assert "catch (const clickhouse::ServerError&) {\n      set_dirty(client_, false);\n      throw;" in execute
    assert execute.count("set_dirty(client_, false);") == 2
    # A caller that goes on with a marked lease gets a new socket.
    assert "client_.ResetConnection();" in source
    # The pool closes a marked connection instead of lending it again.
    pool = read("src/ch_client_pool.cpp")
    assert "const bool dirty = ch_connection_dirty(*client);" in pool
    assert "invalidated_" not in pool and "invalidated_" not in read("src/ch_client_pool.hpp")


def test_settings_never_loosen_the_profile_and_skip_readonly_users():
    source = read("src/ch_query.cpp")
    assert "if (!profile.known || profile.readonly == 1) return out;" in source
    assert "getSetting('readonly')" in source and "getSetting('max_memory_usage')" in source
    assert "if (query.GetQuerySettings().count(name) != 0) continue;" in source
    assert "if (!is_setting_refusal(error.GetCode(), error.what(), sent)) throw;" in source
    assert 'message.find("Cannot modify") == std::string_view::npos' in source


def test_every_api_route_runs_in_a_query_scope():
    server = read("src/server.cpp")
    unscoped = {
        '"/api/version"', '"/api/hosts"', '"/api/hosts/stream"', '"/api/health"',
        '"/api/query/run"', '"/api/query"', '"/api/query/stream"',
    }
    offenders = []
    for line in server.splitlines():
        match = re.match(r'\s*http_\.(?:Get|Post|Patch|Delete|Put)\((R?"[^"]*"(?:\)"|)|R"\([^)]*\)")', line)
        if not match or "/api/" not in match.group(1):
            continue
        path = match.group(1)
        if path in unscoped or "/api/query-library" in path:
            continue
        if "scoped(" in line or "mcp_api(" in line or line.strip().endswith(("activity);", "keeper);")):
            continue
        offenders.append(line.strip())
    assert not offenders, offenders
    assert "ChQueryScope scope(request_limits(req));" in server
    assert "return scoped([this, route]" in server
    assert 'const auto activity = scoped(' in server and 'const auto keeper = scoped(' in server
    # The MCP endpoint, the run and Deep Analyze open scopes of their own.
    assert "ChQueryScope scope(request_limits(req, false));" in read("src/api_mcp.cpp")
    assert 'limits.log_comment = "chdash-run";' in read("src/query_session.cpp")
    assert 'ChQueryScope scope(user_sql_limits(req, "chdash-deep-analysis"));' in read("src/api_analysis.cpp")


def test_request_limits_label_and_bound_the_generated_queries():
    server = read("src/server.cpp")
    body = server[server.index("ChQueryLimits Server::request_limits("):server.index("ChQueryLimits Server::user_sql_limits(")]
    assert 'std::string("chdash-system") : "chdash:" + req.path.substr(0, 160)' in body
    assert "std::chrono::milliseconds(cfg_.generated_queries.timeout_ms)" in body
    assert "limits.max_memory_usage = cfg_.generated_queries.max_memory_usage;" in body
    assert "req.is_connection_closed()" in body
    # System > Queries leaves the generated reads out with hide_chdash.
    assert "AND NOT startsWith(log_comment, 'chdash:')" in read("src/system_monitor.cpp")


def test_the_preview_limit_is_a_cancel_packet_not_a_kill():
    session = read("src/query_session.cpp")
    assert "q.OnDataCancelable([&](const clickhouse::Block& block) -> bool {" in session
    assert 'throw std::runtime_error("result_limit_reached")' not in session
    assert "if (!(limit_reached && (error.GetCode() == 394 || error.GetCode() == 735))) throw;" in session
    # A KILL only for a statement in an unknown state (a cancel, a transport failure).
    assert "if (client_query_ && ch_connection_dirty(*client_query_)) {" in session
