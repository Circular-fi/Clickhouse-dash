"""Source contract of the statements and the connections of ChDash (src/ch_query.hpp).

Every statement goes through ch_select / ch_select_cancelable / ch_execute, so a connection that a
statement left in an unknown state is never lent again (ARCH-B-011), and every statement carries the
settings of its scope. Every connection is opened by ch_open_client, which keeps its state.
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


def test_the_preview_limit_is_a_cancel_packet_not_a_kill():
    session = read("src/query_session.cpp")
    assert "q.OnDataCancelable([&](const clickhouse::Block& block) -> bool {" in session
    assert 'throw std::runtime_error("result_limit_reached")' not in session
    assert "if (!(limit_reached && (error.GetCode() == 394 || error.GetCode() == 735))) throw;" in session
    # A KILL only for a statement in an unknown state (a cancel, a transport failure).
    assert "if (client_query_ && ch_connection_dirty(*client_query_)) {" in session
