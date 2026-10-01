"""Static contract of the server-side query library (docs/query-library.md)."""

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
    """The brace-balanced block that starts at `opener` (which ends with '{')."""
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


def test_routes_exist_only_behind_the_feature_gate() -> None:
    server = read("src/server.cpp")
    gated = block_after(server, "if (cfg_.query_library.enabled) {\n    const auto library")
    outside = server.replace(gated, "")
    assert "/api/query-library" not in outside
    for route in (
        'http_.Get("/api/query-library"',
        'http_.Post("/api/query-library/folders"',
        'http_.Patch(R"(/api/query-library/folders/',
        'http_.Delete(R"(/api/query-library/folders/',
        'http_.Post("/api/query-library/queries"',
        'http_.Patch(R"(/api/query-library/queries/',
        'http_.Delete(R"(/api/query-library/queries/',
        'http_.Post("/api/query-library/import"',
    ):
        assert route in gated, route
    history = block_after(gated, "if (cfg_.query_library.history_on_server()) {")
    for route in (
        'http_.Get("/api/query-library/history"',
        'http_.Post("/api/query-library/history"',
        'http_.Delete("/api/query-library/history"',
        'http_.Delete(R"(/api/query-library/history/',
    ):
        assert route in history, route
    assert gated.replace(history, "").count("/api/query-library/history") == 0
    # Path ids are a restricted token, never a path.
    assert "([A-Za-z0-9_.\\-]+)" in gated
    # The store only exists when enabled.
    assert "if (cfg_.query_library.enabled) {\n    QueryLibraryOptions library;" in server
    assert 'w.Key("query_library");' in server
    assert 'w.Key("history_store"); w.String(cfg_.query_library.history_on_server() ? "server" : "browser");' in server


def test_mutations_share_the_cross_site_guard() -> None:
    api = read("src/api_query_library.cpp")
    assert "bool allow_mutation(const httplib::Request& req, httplib::Response& res, bool has_body)" in api
    assert 'req.get_header_value("Sec-Fetch-Site")' in api
    assert 'req.get_header_value("Origin")' in api
    assert '!= "application/json"' in api
    assert "if (mutating && !allow_mutation(req, res, has_body)) return;" in api
    assert "const bool mutating = route != QueryLibraryRoute::Get && route != QueryLibraryRoute::HistoryList;" in api
    assert '"read_only"' in read("src/query_library.cpp")


def test_library_never_runs_sql_or_derives_paths_from_requests() -> None:
    api = read("src/api_query_library.cpp")
    store = read("src/query_library.cpp")
    for source in (api, store):
        for forbidden in ("client_pool_", "make_client", "Execute(", "QuerySession", "clickhouse/", "ch_client_pool"):
            assert forbidden not in source, forbidden
    # The HTTP layer never touches the filesystem; the store only opens the configured file.
    for forbidden in ("fopen", "ofstream", "ifstream", "std::filesystem", "::open(", "req.path"):
        assert forbidden not in api, forbidden
    assert "options_.file" in store
    assert "req" not in re.findall(r"\b\w+\b", store)


def test_logs_never_contain_sql() -> None:
    store = read("src/query_library.cpp")
    api = read("src/api_query_library.cpp")
    assert "std::cerr" not in api and "std::cout" not in api
    assert store.count("std::cerr") == 1  # only inside log_line
    calls = re.findall(r"(?<!void )log_line\((.*?)\);\n", store, re.DOTALL)
    assert calls, "log_line calls not found"
    for call in calls:
        assert ".sql" not in call and "body" not in call, call


def test_atomic_write_is_temp_fsync_rename_0600() -> None:
    store = read("src/query_library.cpp")
    body = block_after(store, "bool atomic_write_file(const std::string& path, std::string_view data, std::string* error) {")
    assert "O_WRONLY | O_CREAT | O_EXCL" in body
    assert "O_NOFOLLOW" in body
    assert "::open(tmp.c_str(), flags, S_IRUSR | S_IWUSR)" in body
    assert "::fchmod(fd, S_IRUSR | S_IWUSR)" in body
    order = [body.index(token) for token in ("::write(fd", "::fsync(fd)", "::close(fd)", "::rename(tmp.c_str(), target.c_str())", "::fsync(dfd)")]
    assert order == sorted(order)
    assert "::unlink(tmp.c_str());" in body
    # The temporary file is a sibling of the target (same filesystem for rename).
    assert 'dir / ("." + base + ".tmp-"' in body
    # Every mutation goes through commit_locked, which is the only writer.
    assert store.count("atomic_write_file(options_.file") == 1
    commit = block_after(store, "void QueryLibraryStore::commit_locked(QueryLibraryState candidate) {")
    assert "options_.max_file_bytes" in commit and "candidate.history.pop_front()" in commit


def test_malformed_file_is_never_overwritten() -> None:
    store = read("src/query_library.cpp")
    editable = block_after(store, "void QueryLibraryStore::require_editable_locked() const {")
    assert "load_error_.empty()" in editable
    history = block_after(store, "void QueryLibraryStore::require_history_writable_locked() const {")
    assert "load_error_.empty()" in history
    # Every handler that commits checks one of the two guards first.
    for name in ("append_history", "clear_history", "delete_history_entry", "create_folder", "update_folder",
                 "delete_folder", "create_query", "update_query", "delete_query", "import_library"):
        match = re.search(rf"QueryLibraryStore::Response QueryLibraryStore::{name}\(.*?\n}}\n", store, re.DOTALL)
        assert match, name
        handler = match.group(0)
        if "commit_locked" in handler:
            guard = min(i for i in (handler.find("require_editable_locked()"), handler.find("require_history_writable_locked()")) if i >= 0)
            assert guard < handler.index("commit_locked"), name
    # Reload when the file changed on disk (stat stamp), before every operation.
    guarded = block_after(store, "QueryLibraryStore::Response QueryLibraryStore::guarded(Fn&& fn) {")
    assert "std::lock_guard<std::mutex> lk(mu_);" in guarded and "refresh_locked();" in guarded


def test_config_docs_and_suite_registration() -> None:
    config = read("src/config.cpp")
    assert '"query_library"' in config
    assert 'validate_object(*library, "query_library", {"enabled", "file", "writable", "max_file_bytes", "max_query_bytes"}, {"history"});' in config
    assert 'validate_object(*history, "query_library.history", {"store", "max_entries"}, {});' in config
    assert "query_library.file is required when query_library.enabled = true" in config
    example = read("config.example.hcl")
    assert "query_library {" in example and "max_entries" in example
    docs = read("docs/configuration.md")
    assert "query_library {" in docs and "query-library.md" in docs
    api_docs = read("docs/query-library.md")
    for route in ("GET /api/query-library", "POST /api/query-library/import", "DELETE /api/query-library/history", "If-Match"):
        assert route in api_docs, route
    runner = read("tests/test-suite/run-all-tests.py")
    assert "'test_query_library.py'" in runner
    cmake = read("src/CMakeLists.txt")
    assert "query_library.cpp" in cmake and "api_query_library.cpp" in cmake
    assert "CHDASH_BUILD_QUERY_LIBRARY_TESTS" in cmake


def test_native_unit_tests_pass_when_built() -> None:
    binary = os.environ.get("QUERY_LIBRARY_TEST_BINARY")
    if not binary:
        pytest.skip("QUERY_LIBRARY_TEST_BINARY is not set (build chdash_query_library_test)")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout
