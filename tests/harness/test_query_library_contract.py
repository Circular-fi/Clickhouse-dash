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
    # The history of the runs is the browser's: no route, no setting, no field.
    assert "/api/query-library/history" not in server and "history_on_server" not in server
    assert "HistoryList" not in read("src/server.hpp") and "history_store" not in server
    # Path ids are a restricted token, never a path.
    assert "([A-Za-z0-9_.\\-]+)" in gated
    # The store only exists when enabled.
    assert "if (cfg_.query_library.enabled) {\n    QueryLibraryOptions library;" in server
    assert 'w.Key("query_library");' in server


def test_mutations_share_the_cross_site_guard() -> None:
    api = read("src/api_query_library.cpp")
    assert "bool allow_mutation(const httplib::Request& req, httplib::Response& res, bool has_body)" in api
    assert 'req.get_header_value("Sec-Fetch-Site")' in api
    assert 'req.get_header_value("Origin")' in api
    assert '!= "application/json"' in api
    assert "if (mutating && !allow_mutation(req, res, has_body)) return;" in api
    assert "const bool mutating = route != QueryLibraryRoute::Get;" in api
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
    assert "options_.max_file_bytes" in commit and "history" not in commit


def test_malformed_file_is_never_overwritten() -> None:
    store = read("src/query_library.cpp")
    editable = block_after(store, "void QueryLibraryStore::require_editable_locked() const {")
    assert "load_error_.empty()" in editable
    header = read("src/query_library.hpp")
    for symbol in ("QueryLibraryHistoryEntry", "append_history", "list_history", "clear_history", "delete_history_entry",
                   "history_on_server", "history_max_entries", "require_history_writable_locked", "state.history"):
        assert symbol not in store and symbol not in header, symbol
    # A file of an earlier release keeps its history array only to count and drop it.
    assert 'mig.dropped_history = history->Size();' in store
    # Every handler that commits checks the guard first.
    for name in ("create_folder", "update_folder", "delete_folder", "create_query", "update_query", "delete_query",
                 "import_library"):
        match = re.search(rf"QueryLibraryStore::Response QueryLibraryStore::{name}\(.*?\n}}\n", store, re.DOTALL)
        assert match, name
        handler = match.group(0)
        if "commit_locked" in handler:
            guard = handler.find("require_editable_locked()")
            assert 0 <= guard < handler.index("commit_locked"), name
    # Reload when the file changed on disk (stat stamp), before every operation.
    guarded = block_after(store, "QueryLibraryStore::Response QueryLibraryStore::guarded(Fn&& fn) {")
    assert "std::lock_guard<std::mutex> lk(mu_);" in guarded and "refresh_locked();" in guarded


def test_config_docs_and_suite_registration() -> None:
    config = read("src/config.cpp")
    assert '"query_library"' in config
    assert 'validate_object(*library, "query_library", {"enabled", "file", "writable", "max_file_bytes", "max_query_bytes"}, {});' in config
    # A history block of an earlier release is refused with a way out, not silently ignored.
    assert "query_library.history was removed: the query history is always kept in the browser; delete the block" in config
    assert "history_store" not in config
    assert "query_library.file is required when query_library.enabled = true" in config
    example = read("config.example.hcl")
    assert "query_library {" in example and "history" not in example.split("query_library {", 1)[1].split("\n}\n", 1)[0]
    docs = read("docs/configuration.md")
    assert "query_library {" in docs and "query-library.md" in docs
    api_docs = read("docs/query-library.md")
    for route in ("GET /api/query-library", "POST /api/query-library/import", "DELETE /api/query-library/queries", "If-Match"):
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


def test_no_tags_no_folder_description_and_history_is_never_removed() -> None:
    header = read("src/query_library.hpp")
    store = read("src/query_library.cpp")
    api = read("src/api_query_library.cpp")
    front = read("src/static/app_query_library.js")
    # A query has a name, a description, its SQL and a place; a folder a name and a place.
    for source in (header, store, api):
        for gone in ("tags", "kQueryLibraryMaxTag", "read_tags", "max_tag_bytes"):
            assert gone not in source, gone
    folder = block_after(header, "struct QueryLibraryFolder {")
    assert "description" not in folder
    assert "description" in block_after(header, "struct QueryLibraryQuery {")
    assert "f.description" not in store and "folder.description" not in front
    # Earlier clients' fields and files are read and dropped, never refused.
    assert 'member(doc, "tags")' not in store and 'file_string(item, "description", ctx, false);\n      f.' not in store
    for gone in ("tags", "parseTags", "tagList", "qlTag", "MAX_TAGS"):
        assert gone not in front, gone
    # History: the browser's record of what ran, with no removal at all.
    for gone in ("removeHistoryEntry", "Remove from History", "history.remove", "async remove(id)"):
        assert gone not in front, gone
    history_keys = block_after(front, "function onHistoryKeydown(ev) {")
    assert '"Delete"' not in history_keys and '"Backspace"' not in history_keys
    # One word on the pane's primary action.
    assert 'label: "Load", action: "load", primary: true' in front and "Load in editor" not in front


def test_saved_is_a_tree_with_row_menus_and_save_is_in_the_foot() -> None:
    front = read("src/static/app_query_library.js")
    css = read("src/static/css/20-features/query-library.css")
    shell = block_after(front, "function buildLibraryShell(root) {")
    # The head holds the search and New folder; "Save query" is the foot's first control, the count its last.
    assert 'const newFolder = iconButton("folderPlus", "New folder", "new-folder");' in shell
    assert "foot.append(save, count);" in shell and 'save.dataset.action = "save";' in shell and 'h("span", null, "Save query")' in shell
    assert "wrap.append(head, notice, tree, foot);" in shell
    # A tree, as in the Explorer: roots, folders that open in place, a "..." menu per row, ticked rows changed together.
    for name in ("function expandPath(", "function toggleFolder(", "function appendFolderChildren(", "function editorRow(", "function startNewFolder(",
                 "function startRename(", "function openRowMenu(", "async function moveDialog(items) {",
                 "async function deleteItems(items) {", "function rootRow("):
        assert name in front, name
    # No breadcrumb, no places, no file-list columns.
    # No selection of several rows either: no tick box, no bar, no "N selected".
    for gone in ("ctl.checked", "qlRow__box", "qlRow__check", "ql__bar", "qlBulk", "bulkPreview", "setAllChecked"):
        assert gone not in front and gone not in css, gone
    for gone in ("crumb", "ctl.place", "goTo(", "goUp(", "qlColumns", "folderDialog", "renameFolderDialog", "openPlaceMenu"):
        assert gone not in front and gone not in css, gone
    assert "closedRoots" in front and "ctl.expanded" in front
    assert 'row.append(icon(kind === "folder" ? "folder" : "query"));' in front
    assert 'const menu = iconButton("dots", `Actions for ${entity.name}`, "row-menu");' in front
    # The Save window is wide.
    assert 'className: wide ? "qlDialog qlDialog--wide" : "qlDialog",' in front and ".uiDialog.qlDialog--wide {" in css
    # A folder's menu exports it as the JSON body of the import route.
    assert 'menuItem("Export as JSON", "download"' in front and "function exportFolder(item) {" in front
    assert "ns.ui.downloadText(name," in front and "host_id: ctl.host," in front
    # The Edit window does not replace the SQL with the editor's: that is Ctrl+S on the opened query.
    assert "replace_sql" not in front and "Replace the SQL" not in front and ".qlCheck" not in css
