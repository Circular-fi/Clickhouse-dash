"""Structural rules of the C++ backend: what no unit of src/ may do, whatever it implements.

These checks read the sources because the rule is about the code, not about one answer: a behaviour test cannot see
that some other file opened a connection by hand or logged an address. Each rule says why it exists. What a route or a
service does is tested by tests/native (services over a fake ChExecutor), tests/backend-functional (HTTP on a private
instance) and tests/api; none of that is asserted here.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
SRC = ROOT / "src"


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def sources(suffixes: tuple[str, ...] = (".cpp", ".hpp")):
    for path in sorted(SRC.iterdir()):
        if path.suffix in suffixes:
            yield path.name, path.read_text(encoding="utf-8", errors="replace")


def code_of(text: str) -> str:
    """The text without its // comments (a comment may name what the code must not do)."""
    return re.sub(r"//[^\n]*", "", text)


# ---- ClickHouse access -------------------------------------------------------------------------------------------------------------


def test_no_statement_bypasses_the_connection_state():
    # Why: every statement goes through ch_select / ch_execute so that a connection left in an unknown state is never
    # lent again (ARCH-B-011) and every statement carries the label and the bounds of its scope.
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
    # Why: ch_open_client is the one place that keeps the state of a connection (dirty / clean) the pool relies on.
    construct = re.compile(r"make_(?:unique|shared)<clickhouse::Client>|new clickhouse::Client\b|clickhouse::Client \w+\(")
    offenders = [name for name, text in sources() if name != "ch_query.cpp" and construct.search(text)]
    assert not offenders, offenders


def test_every_api_route_runs_in_a_query_scope():
    # Why: a route that reads ClickHouse outside a RequestScope sends statements with no label, no deadline and no memory bound.
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
        if "scoped(" in line or "limited(" in line or "mcp_api(" in line or line.strip().endswith(("activity);", "keeper);")):
            continue
        offenders.append(line.strip())
    assert not offenders, offenders


def test_the_decoders_of_a_block_throw_instead_of_returning_zero():
    # Why: a result column of an unexpected type used to read as 0 or "" and the page showed a wrong number (fail closed).
    for name in ("src/ch_block_value.hpp", "src/ch_block_numeric.hpp"):
        text = read(name)
        assert "catch (...)" not in text, name
        assert "throw std::" in text, name
    assert "return 0;" not in read("src/ch_block_numeric.hpp")


# ---- identities --------------------------------------------------------------------------------------------------------------------


def test_mcp_code_is_not_reachable_from_other_routes_and_never_uses_the_runner():
    # Why: MCP is a separate identity (mcp_uri): the tools never run as the runner, and only the Traces / Logs / Metrics tools
    # read as the system user (`limits.as_system`, one line); no other route may call into MCP.
    for path in sorted(SRC.glob("*.cpp")):
        if path.name in ("api_mcp.cpp", "server.cpp", "mcp_protocol.cpp", "config.cpp", "main.cpp") or path.name.startswith(("mcp_tools", "mcp_tool_")):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        assert "McpTools" not in text and "mcp_tools_" not in text and "handle_mcp_post" not in text, path.name
    api = code_of(read("src/api_mcp.cpp"))
    assert "mcp_uri" in api and "runner_uri" not in api
    uses = [line for line in api.split("\n") if "system_uri" in line]
    assert len(uses) == 1 and "as_system" in uses[0], uses
    assert "mcp_password_file" not in read("src/config.cpp")


def test_panel_sql_never_runs_on_the_system_account():
    # Why: the runner is the boundary of what a person may read; the system account is for backend-built reads only.
    for name in ("src/deep_analysis.cpp", "src/allowed_objects.cpp"):
        assert "system_uri" not in read(name), name


def test_the_panel_has_no_end_user_authentication_layer():
    # Why: the design is one boundary, the runner identity (docs/configuration.md); a half-built login layer would suggest otherwise.
    for name, text in sources():
        assert "authenticate_request" not in code_of(text), name
    assert "Authorization" not in read("src/static/app_api.js")


def test_no_handler_reads_the_defaults_of_the_otel_block():
    # Why: a request is served with the settings of the host it names (HostSpec::otel); a handler that read the defaults would
    # answer for every host with the tables of the first one.
    for path in sorted(SRC.glob("*.cpp")):
        text = code_of(path.read_text(encoding="utf-8", errors="replace"))
        assert not re.search(r"\bcfg_?\.(traces|logs|metrics)\b(?!_on)", text), path.name
        if path.name == "config.cpp":
            continue
        uses = re.findall(r"otel_defaults[^\n]*", text)
        assert len(uses) <= {"server.cpp": 1, "api_mcp.cpp": 1}.get(path.name, 0), (path.name, uses)


# ---- HTTP, logging, randomness, caches ---------------------------------------------------------------------------------------------


def test_one_guard_for_every_write():
    # Why: the cross-site guard is in one place (http_guard.cpp, before routing); a route with its own copy would drift.
    for path in sorted(SRC.glob("*.cpp")):
        if path.name == "http_guard.cpp":
            continue
        text = path.read_text(encoding="utf-8")
        assert "Sec-Fetch-Site" not in text, path.name
        assert "bool allow_mutation(" not in text, path.name


def test_capability_identifiers_come_from_the_system_random_source():
    # Why: tokens, query ids and key secrets must not come from a seeded generator (secure_random.hpp is the one source).
    for path in sorted(SRC.glob("*.[ch]pp")):
        if path.name == "secure_random.hpp":  # its comment says why not
            continue
        text = path.read_text(encoding="utf-8")
        assert "mt19937" not in text, path.name
        assert "random_device" not in text, path.name


def test_the_log_is_written_by_log_cpp_only_and_never_holds_the_query_string():
    # Why: one JSON line per event, written under one lock; and the query string can hold an export token or a filter value.
    for path in sorted(SRC.glob("*.cpp")):
        if path.name in ("main.cpp", "log.cpp"):
            continue
        assert "std::cerr" not in path.read_text(encoding="utf-8"), path.name
    assert "req.target" not in read("src/server_http.cpp")


def test_no_source_file_keeps_a_function_local_ttl_cache():
    # Why: the caches belong to the Server (sized from the configuration, invalidated by refresh=1); a function-local static would escape both.
    local = re.compile(r"\bstatic\s+(?:\w+::)*(?:TtlCache<|\w+Cache\s+\w+\s*[({])")
    offenders = [path.name for path in sorted(SRC.glob("*.cpp")) if local.search(path.read_text(encoding="utf-8"))]
    assert offenders == []


def test_cache_ages_are_measured_on_a_monotonic_clock():
    # Why: a TTL measured on the wall clock jumps with NTP and daylight saving.
    source = read("src/ttl_cache.hpp")
    assert "typename Clock = std::chrono::steady_clock" in source
    assert "system_clock" not in source


def test_the_configuration_is_read_from_the_file_only():
    # Why: HCL is the one source of configuration (docs/configuration.md); an environment variable read in code would be an undocumented key.
    assert "getenv(" not in read("src/config.cpp")
    assert "load_config_from_environment" not in read("src/config.hpp")


# ---- the query library -------------------------------------------------------------------------------------------------------------


def test_the_query_library_never_runs_sql_and_its_http_layer_never_touches_the_filesystem():
    # Why: the library is a file store of texts; it must not reach ClickHouse, and a path from a request must never reach the filesystem.
    from library_sources import read_library

    api = read("src/api_query_library.cpp")
    store = read_library()
    for source in (api, store):
        for forbidden in ("client_pool_", "make_client", "Execute(", "QuerySession", "clickhouse/", "ch_client_pool"):
            assert forbidden not in source, forbidden
    for forbidden in ("fopen", "ofstream", "ifstream", "std::filesystem", "::open(", "req.path"):
        assert forbidden not in api, forbidden


def test_the_query_library_logs_never_hold_sql():
    # Why: a saved query is user text and may hold a value that must not reach a log.
    from library_sources import read_library

    store = read_library()
    api = read("src/api_query_library.cpp")
    assert "std::cerr" not in api + store and "std::cout" not in api + store
    calls = re.findall(r"(?<!void )log_line\((.*?)\);\n", store, re.DOTALL)
    assert calls, "log_line calls not found"
    for call in calls:
        assert ".sql" not in call and "body" not in call, call


# ---- the build ---------------------------------------------------------------------------------------------------------------------


def test_warning_flags_apply_to_our_targets_only():
    # Why: a warning flag set on the directory or on CMAKE_CXX_FLAGS would reach the dependencies (clickhouse-cpp, httplib, RapidJSON), which
    # do not build clean under -Werror; chdash_configure_target is the one place that sets them.
    flags = read("src/BuildFlags.cmake")
    assert "function(chdash_configure_target)" in flags
    assert "CMAKE_CXX_FLAGS" not in flags
    assert "add_compile_options(${CHDASH_WARNING_FLAGS}" not in flags
    cmake = read("src/CMakeLists.txt")
    for old in ("-Wno-error", "-Wno-implicit-fallthrough"):
        assert old not in cmake, old
