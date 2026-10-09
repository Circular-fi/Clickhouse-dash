"""Static contract of the MCP server side (docs/mcp.md)."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def block_after(source: str, opener: str) -> str:
    start = source.index(opener) + len(opener)
    depth = 1
    for i in range(start, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[start:i]
    raise AssertionError(f"unbalanced block after {opener!r}")


def test_the_endpoint_exists_only_when_mcp_is_enabled() -> None:
    server = read("src/server.cpp")
    opener = "if (cfg_.mcp.enabled) {\n    http_.Post(\"/mcp\""
    gated = block_after(server, opener)
    outside = server.replace(opener + gated, "")
    assert 'http_.Post("/mcp"' not in outside
    for method in ("Get", "Delete", "Put", "Patch"):
        assert f'http_.{method}("/mcp", not_allowed)' in gated
    # The 405 names the one method.
    api = read("src/api_mcp.cpp")
    assert 'res.set_header("Allow", "POST")' in api
    assert "if (cfg_.mcp.enabled) init_mcp();" in server
    # The page shell is always served; its file belongs to the page.
    assert 'http_.Get("/mcp-integration", serve_view_shell("mcp.html"));' in outside
    assert server.index('"/mcp-integration"') < server.index('R"(/static/.*)"')
    # The /api/mcp routes always answer (meta says enabled: false, the others 404 mcp_disabled).
    for route in ('"/api/mcp/meta"', '"/api/mcp/keys"', 'R"(/api/mcp/keys/([A-Za-z0-9_.\\-]+))"', 'R"(/api/mcp/keys/([A-Za-z0-9_.\\-]+)/secret)"'):
        assert route in outside, route
    assert '"mcp_disabled"' in api
    assert 'w.Key("mcp");' in server


def test_mcp_code_is_not_reachable_from_other_routes_and_never_uses_other_identities() -> None:
    for path in sorted((ROOT / "src").glob("*.cpp")):
        if path.name in ("api_mcp.cpp", "server.cpp", "mcp_tools.cpp", "mcp_protocol.cpp", "config.cpp", "main.cpp"):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        assert "McpTools" not in text and "mcp_tools_" not in text and "handle_mcp_post" not in text, path.name
    api = read("src/api_mcp.cpp")
    assert "mcp_uri" in api
    code = re.sub(r"//[^\n]*", "", api)
    assert "runner_uri" not in code and "system_uri" not in code
    config = read("src/config.cpp")
    # The MCP identity has no fallback: password_file never touches mcp_uri, and there is no password key of its own.
    assert "mcp_password_file" not in config
    assert re.search(r'spec\.mcp_uri = std::move\(\*mcp_uri\)', config)
    # The health runner reads mcp_uri for one thing: the grant audit of the MCP user (CHECK GRANT, SHOW; no data).
    health = read("src/health_runner.cpp")
    audit = block_after(health, "static HostAccess audit_access(")
    assert health.count("mcp_uri") == audit.count("mcp_uri") and "mcp_uri" in audit


def test_every_query_has_the_guard_rails() -> None:
    api = read("src/api_mcp.cpp")
    order = [api.index(s) for s in (
        'set("readonly", "1")', 'set("max_execution_time"', 'set("max_result_rows"', 'set("result_overflow_mode", "break")',
        'set("max_result_bytes"', 'set("max_memory_usage"', 'set("max_rows_to_read"', 'set("log_comment", "chdash-mcp key="')]
    assert order == sorted(order), "readonly = 1 comes first"
    assert "limits.max_rows + 1" in api
    # A host without mcp_uri is refused, never completed with another account.
    assert "has no MCP identity" in api
    # One audit line per call, with no SQL and no data in it.
    audit = block_after(api, "void audit(")
    assert "sql" not in audit.lower() and "body" not in audit.lower()
    for call in re.findall(r"audit\(([^;]*);", api):
        assert "sql" not in call.lower() and "body" not in call.lower() and "secret" not in call.lower(), call


def test_keys_are_hashed_compared_in_constant_time_and_written_atomically() -> None:
    keys = read("src/mcp_keys.cpp")
    assert "constant_time_equal(" in keys
    assert "atomic_write_file(" in keys  # temporary file, fsync, rename, mode 0600
    assert "getrandom" in keys and "/dev/urandom" in keys
    serialize = block_after(keys, "std::string mcp_serialize_key_file(const std::vector<McpKey>& ui_keys) {")
    assert '"secret_sha256"' in serialize and '"secret_hint"' in serialize
    # The file keeps the secret too, so that the page can show it again; only when the store knows it.
    assert 'if (!key.secret.empty()) {' in serialize and 'w.Key("secret"); write_string(w, key.secret);' in serialize
    # The key of a list answer never has the secret: the page asks for it, key by key (GET .../secret).
    listing = block_after(keys, "void mcp_write_key(McpJsonWriter& w, const McpKey& key, std::optional<int64_t> last_used) {")
    assert 'w.Key("secret_available")' in listing and 'w.Key("secret")' not in listing and "key.secret)" not in listing
    # Name and secret uniqueness, across the two sources.
    assert "have the same secret" in keys and "two keys have the name" in keys
    # The key file is never rewritten when it is invalid: loading throws and the store never starts.
    assert "mcp_load_key_file(options_.storage_file)" in keys
    keys_h = read("src/mcp_keys.hpp")
    assert "kMcpSecretMinBytes = 24" in keys_h and "kMcpNameMaxBytes = 32" in keys_h
    # A page key's secret is a version 4 UUID from the system random source.
    generate = block_after(keys, "std::string mcp_generate_secret() {")
    assert "random_fill(bytes, sizeof(bytes))" in generate and "0x40" in generate and "0x80" in generate


def test_sql_tools_need_all_data_in_every_layer() -> None:
    scope = read("src/mcp_scope.cpp")
    assert scope.count("true},") + scope.count("true}\n") >= 2 or '"run_query", "sql"' in scope
    assert "if (tool.needs_all_data && !all_data) continue;" in scope
    assert "needs_all_data" in read("src/mcp_keys.cpp")
    protocol = read("src/mcp_protocol.cpp")
    assert "mcp_scope_tool_allowed(key.tools, key.databases, tool_name)" in protocol
    # No batching: 2025-06-18.
    assert "batch requests are not supported" in protocol


def test_startup_errors_of_the_specification_exist() -> None:
    config = read("src/config.cpp")
    for message in (
        "mcp.enabled needs mcp.storage_file or at least one mcp key block",       # 1
        "mcp.enabled needs at least one clickhouse.host with mcp_uri",            # 2
        "(the file is not changed)",                                              # 3
        "two keys have the name",                                                 # 4
        "have the same secret",                                                   # 4
        "exactly one of secret, secret_file and secret_sha256 is required",       # 7
        "must be at least",                                                       # secret size
    ):
        assert message in config, message
    # 5 and 6 come from the shared key validation.
    keys = read("src/mcp_keys.cpp")
    assert '"unknown_host"' in keys and '"unknown_tool"' in keys and '"needs_all_data"' in keys
    assert 'validate_object(*mcp, "mcp"' in config and 'validate_object(block, "mcp.key"' in config
    # The 7 cases are tested on the loader and on the real binary.
    native = read("tests/native/mcp_test.cpp")
    functional = read("tests/backend-functional/test_mcp.py")
    for n in range(1, 8):
        assert f"test_startup_error_{n}_" in functional
    assert "// 1. enabled" in native and "// 7. an unknown attribute" in native


def test_api_contract_codes() -> None:
    api = read("src/api_mcp.cpp")
    store = read("src/mcp_keys.cpp")
    for code in ("manage_disabled", "cross_site_request", "mcp_disabled", "not_found", "unsupported_media_type"):
        assert f'"{code}"' in api or f'"{code}"' in store, code
    for code in ("config_key", "storage_not_configured", "name_taken", "storage_error", "validation"):
        assert f'"{code}"' in store, code
    assert 'w.Key("endpoint_path"); w.String("/mcp")' in api
    assert "kMcpNamePattern" in api and "kMcpSecretMinBytes" in api
    assert 'Sec-Fetch-Site' in api and "X-Forwarded-Host" in api
    assert 'set_no_store(res);' in api
    assert 'features.mcp' not in api  # reported by /api/version only
    version = read("src/server.cpp")
    assert 'w.Key("enabled"); w.Bool(cfg_.mcp.enabled);' in version


def test_test_user_has_reads_only() -> None:
    sql = read("tests/clickhouse-init/01-chdash-users.sql")
    mcp = sql[sql.index("CREATE USER IF NOT EXISTS chdash_mcp"):]
    assert "REVOKE ALL ON *.* FROM chdash_mcp" in mcp
    grants = [line for line in mcp.splitlines() if line.startswith("GRANT")]
    assert grants
    for line in grants:
        assert line.startswith("GRANT SELECT ON "), line
        for forbidden in ("FILE", "URL", "REMOTE", "S3", "INSERT", "ALTER", "CREATE", "DROP", "SYSTEM", "KILL", "ACCESS"):
            assert forbidden not in line.upper().split("GRANT SELECT ON ")[0], line
    docs = read("docs/mcp.md")
    assert "Do not grant `FILE`, `URL`, `REMOTE`, `S3`" in docs
    assert "STATE_QUERIES" in read("tests/backend-functional/conftest.py") and "SHOW GRANTS FOR chdash_mcp" in read("tests/backend-functional/conftest.py")


def test_docs_and_wiring() -> None:
    docs = read("docs/mcp.md")
    for tool in ("list_hosts", "list_databases", "list_tables", "describe_table", "query_table", "run_query", "explain_query"):
        assert f"`{tool}`" in docs and f"### `{tool}`" in docs, tool
    for route in ("/api/mcp/meta", "/api/mcp/keys", "/secret", "POST /mcp", "/mcp-integration", "features.mcp"):
        assert route in docs, route
    for heading in ("## Decisions", "## Security limits", "## Connect a client", "### Startup errors", "## The ClickHouse MCP user"):
        assert heading in docs, heading
    assert "claude mcp add --transport http" in docs
    assert "mcp_uri" in docs and "mcp_password_file" not in docs and "mcp_password_file" not in read("config.example.hcl")
    example = read("config.example.hcl")
    assert "mcp {" in example and "docs/mcp.md" in example and "mcp_uri" in example
    assert "docs/mcp.md" in read("README.md") and "mcp.md" in read("docs/configuration.md")
    cmake = read("src/CMakeLists.txt")
    for source in ("mcp_scope.cpp", "mcp_keys.cpp", "mcp_sql.cpp", "mcp_protocol.cpp", "mcp_tools.cpp", "api_mcp.cpp"):
        assert source in cmake, source
    assert "CHDASH_BUILD_MCP_TESTS" in cmake and "chdash_mcp_test" in cmake
    assert "'test_mcp.py'" in read("tests/test-suite/run-all-tests.py")
    assert "mcp_uri" in read("src/health_runner.hpp")
    for config in ("mcp.hcl", "mcp.readonly.hcl", "mcp.nostorage.hcl", "mcp.seed.json"):
        assert (ROOT / "tests/config" / config).exists(), config
    assert "manage_from_ui = false" in read("tests/config/mcp.readonly.hcl")


def test_native_unit_tests_pass_when_built() -> None:
    binary = os.environ.get("MCP_TEST_BINARY")
    if not binary:
        pytest.skip("MCP_TEST_BINARY is not set (build chdash_mcp_test)")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout


def api_tool_rows() -> list[tuple[str, str, str, str]]:
    """(name, group, method, path) of every row of the API tool table."""
    source = read("src/mcp_api_tools.cpp")
    rows = re.findall(r'\{"([a-z_]+)", "([a-z]+)", "[^"]*",\s*(?:"[^"]*"\s*)+,\s*"(GET|POST)", "(/api/[^"]+)"\}', source)
    return rows


def test_every_api_tool_is_one_row_that_names_a_route_of_the_server() -> None:
    rows = api_tool_rows()
    assert len(rows) >= 40
    server = read("src/server.cpp")
    names = [name for name, *_ in rows]
    assert len(set(names)) == len(names)
    groups = re.findall(r'\{"([a-z]+)", "[A-Za-z]+", "[^"]+"\},', read("src/mcp_scope.cpp"))
    for name, group, method, path in rows:
        assert group in groups, (name, group)
        # The route is registered with that method (a {name} of the path is a capture of the server's route).
        static = path.split("{")[0].rstrip("/")
        verb = "Get" if method == "GET" else "Post"
        assert re.search(r'http_\.' + verb + r'\(R?"\(?' + re.escape(static), server), (name, method, path)
    # The wrapper is one function: no tool of the table has its own branch in the dispatcher.
    tools = read("src/mcp_tools.cpp")
    dispatch = tools[tools.index("McpToolOutcome McpTools::call_tool"):]
    assert "if (info && info->api) json = tool_api(ctx, *info, arguments);" in dispatch
    for name in names:
        assert f'tool == "{name}"' not in dispatch, name
        assert f'"{name}"' not in tools and f'"{name}"' not in read("src/mcp_protocol.cpp"), name


def test_the_api_tools_run_no_query_of_their_own_and_are_documented() -> None:
    wrapper = read("src/mcp_tools.cpp")
    wrapper = wrapper[wrapper.index("std::string tool_api("):wrapper.index("McpToolOutcome McpTools::call_tool")]
    # An API tool reads through the API of ChDash: no SQL here, no ClickHouse identity here.
    assert "ctx.db" not in wrapper and "run(ctx" not in wrapper and "runner_uri" not in wrapper and "system_uri" not in wrapper
    # The server answers the call itself, on the loopback, with a bounded number of calls at once.
    api = read("src/api_mcp.cpp")
    assert 'httplib::Client client("127.0.0.1", port_);' in api and "kLoopbackCalls" in api
    # They need all the data (no data scope can narrow them), like free SQL.
    assert "all.push_back({api.name, api.group, api.title, api.description, true, &api});" in read("src/mcp_scope.cpp")
    docs = read("docs/mcp.md")
    for name, *_ in api_tool_rows():
        assert f"`{name}`" in docs, name
