"""Server-side query library + history (docs/query-library.md).

Instances:
- API_BASE_URL (or QUERY_LIBRARY_DISABLED_BASE_URL): query_library disabled,
  every route answers 404.
- QUERY_LIBRARY_BASE_URL: enabled + writable + history on the server
  (tests/config/query-library.writable.hcl, an empty writable /data).
- QUERY_LIBRARY_RO_BASE_URL: enabled + writable = false + history on the
  server (tests/config/query-library.readonly.hcl).
- QUERY_LIBRARY_DATA_DIR: the writable instance's /data as seen by pytest
  (file-mode, external-edit, malformed-file and migration tests).
- QUERY_LIBRARY_RO_DATA_DIR: the read-only instance's /data as seen by
  pytest (the read-only migration test).

Both configs declare two hosts, "local" and "other" (the same ClickHouse):
the library, its folders and its history are per host.
- QUERY_LIBRARY_RESTART_CMD: shell command restarting the writable instance
  (persistence across a restart).

Tests needing an instance that is not configured are skipped, so the default
compose run (one chdash_source with the feature disabled) only runs the
disabled checks.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import time
import uuid
from pathlib import Path

import pytest
import requests

DISABLED_URL = os.environ.get(
    "QUERY_LIBRARY_DISABLED_BASE_URL", os.environ.get("API_BASE_URL", "http://chdash_source:8080")
).rstrip("/")
WRITABLE_URL = os.environ.get("QUERY_LIBRARY_BASE_URL", "").rstrip("/")
READONLY_URL = os.environ.get("QUERY_LIBRARY_RO_BASE_URL", "").rstrip("/")
DATA_DIR = os.environ.get("QUERY_LIBRARY_DATA_DIR", "")
RO_DATA_DIR = os.environ.get("QUERY_LIBRARY_RO_DATA_DIR", "")
RESTART_CMD = os.environ.get("QUERY_LIBRARY_RESTART_CMD", "")
LIBRARY_FILE = "query_library.json"

# Limits of tests/config/query-library.writable.hcl.
MAX_QUERY_BYTES = 16384
MAX_FILE_BYTES = 131072
HISTORY_MAX = 25
# Hosts of both configs.
HOST = "local"
OTHER = "other"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})

needs_writable = pytest.mark.skipif(not WRITABLE_URL, reason="QUERY_LIBRARY_BASE_URL is not set")
needs_readonly = pytest.mark.skipif(not READONLY_URL, reason="QUERY_LIBRARY_RO_BASE_URL is not set")
needs_data_dir = pytest.mark.skipif(not (WRITABLE_URL and DATA_DIR), reason="QUERY_LIBRARY_DATA_DIR is not set")
needs_ro_data_dir = pytest.mark.skipif(not (READONLY_URL and RO_DATA_DIR), reason="QUERY_LIBRARY_RO_DATA_DIR is not set")
needs_restart = pytest.mark.skipif(
    not (WRITABLE_URL and RESTART_CMD), reason="QUERY_LIBRARY_RESTART_CMD is not set"
)


def call(base: str, method: str, path: str, *, body=None, headers=None, params=None) -> requests.Response:
    kwargs: dict = {"timeout": 15, "headers": dict(headers or {}), "params": params}
    if body is not None:
        kwargs["data"] = json.dumps(body)
        kwargs["headers"].setdefault("Content-Type", "application/json")
    return SESSION.request(method, f"{base}{path}", **kwargs)


def w(method: str, path: str, **kwargs) -> requests.Response:
    return call(WRITABLE_URL, method, path, **kwargs)


def ok(response: requests.Response, status: int = 200) -> dict:
    assert response.status_code == status, f"{response.status_code} {response.text[:500]}"
    assert response.headers.get("Content-Type", "").startswith("application/json")
    return response.json()


def library(host: str = HOST) -> dict:
    return ok(w("GET", "/api/query-library", params={"host_id": host}))


def make_folder(name: str, parent_id: str | None = None, host: str = HOST, **extra) -> dict:
    body = {"host_id": host, "parent_id": parent_id, "name": name, **extra}
    return ok(w("POST", "/api/query-library/folders", body=body), 201)


def make_query(name: str, sql: str, folder_id: str | None = None, host: str = HOST, **extra) -> dict:
    body = {"host_id": host, "folder_id": folder_id, "name": name, "description": "", "sql": sql, **extra}
    return ok(w("POST", "/api/query-library/queries", body=body), 201)


def add_history(sql: str, host: str = HOST, **extra) -> dict:
    return ok(w("POST", "/api/query-library/history", body={"sql": sql, "host_id": host, **extra}), 201)


def history_page(host: str = HOST, **params) -> dict:
    return ok(w("GET", "/api/query-library/history", params={"host_id": host, **params}))


def wait_ready(base: str, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            response = SESSION.get(f"{base}/api/version", timeout=2)
            if response.status_code == 200:
                return
            last = response.status_code
        except requests.RequestException as exc:  # restarting
            last = exc
        time.sleep(0.5)
    raise AssertionError(f"{base} did not come back: {last}")


def restart_writable() -> None:
    subprocess.run(RESTART_CMD, shell=True, check=True, timeout=120, capture_output=True)
    time.sleep(0.5)
    wait_ready(WRITABLE_URL)


def library_path() -> Path:
    return Path(DATA_DIR) / LIBRARY_FILE


def replace_file(path: Path, text: str) -> None:
    """Replace the library file like an editor would (new inode)."""
    tmp = path.with_name(f".{path.name}.edit-{uuid.uuid4().hex}")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


@pytest.fixture()
def clean_library():
    """Empty the writable library (folders, queries, history of both hosts) through the API."""
    for host in (HOST, OTHER):
        lib = library(host)
        if lib.get("load_error"):
            pytest.fail(f"writable library has a load error: {lib['load_error']}")
        for folder in lib["folders"]:
            if folder["parent_id"] is None:
                response = w("DELETE", f"/api/query-library/folders/{folder['id']}", params={"recursive": "1"})
                assert response.status_code in (200, 404), response.text
        for query in library(host)["queries"]:
            assert w("DELETE", f"/api/query-library/queries/{query['id']}").status_code in (200, 404)
        ok(w("DELETE", "/api/query-library/history", params={"host_id": host}))
        lib = library(host)
        assert lib["folders"] == [] and lib["queries"] == []
    yield


# --- disabled ---------------------------------------------------------------


def test_disabled_library_routes_are_absent():
    version = SESSION.get(f"{DISABLED_URL}/api/version", timeout=15)
    assert version.status_code == 200, version.text
    feature = version.json()["features"].get("query_library")
    if feature is not None and feature.get("enabled"):
        pytest.skip(f"{DISABLED_URL} has the query library enabled")
    if feature is not None:
        assert feature == {"enabled": False, "writable": False, "history_store": "browser"}
    for method, path in [
        ("GET", "/api/query-library"),
        ("GET", "/api/query-library/history"),
        ("POST", "/api/query-library/history"),
        ("POST", "/api/query-library/folders"),
        ("PATCH", "/api/query-library/folders/f_x"),
        ("DELETE", "/api/query-library/folders/f_x"),
        ("POST", "/api/query-library/queries"),
        ("DELETE", "/api/query-library/queries/q_x"),
        ("POST", "/api/query-library/import"),
    ]:
        body = {"name": "x", "sql": "SELECT 1"} if method in ("POST", "PATCH") else None
        response = call(DISABLED_URL, method, path, body=body)
        assert response.status_code == 404, (method, path, response.status_code, response.text[:200])


# --- writable ---------------------------------------------------------------


@needs_writable
def test_version_reports_the_feature():
    feature = ok(w("GET", "/api/version"))["features"]["query_library"]
    assert feature == {"enabled": True, "writable": True, "history_store": "server"}


@needs_writable
def test_library_get_shape(clean_library):
    lib = library()
    for key in ("host_id", "revision", "folders", "queries", "writable", "history_store", "load_error", "limits"):
        assert key in lib, key
    assert lib["host_id"] == HOST
    assert "history" not in lib
    assert lib["writable"] is True
    assert lib["history_store"] == "server"
    assert lib["load_error"] is None
    assert lib["limits"]["max_query_bytes"] == MAX_QUERY_BYTES
    assert lib["limits"]["max_folder_depth"] == 8
    assert "no-store" in w("GET", "/api/query-library", params={"host_id": HOST}).headers.get("Cache-Control", "")


@needs_writable
def test_folder_and_query_crud(clean_library):
    start = library()["revision"]
    folder = make_folder("Reports", description="Weekly")
    assert folder["id"].startswith("f_")
    assert folder["parent_id"] is None and folder["name"] == "Reports" and folder["description"] == "Weekly"
    assert folder["host_id"] == HOST
    assert folder["revision"] == start + 1

    query = make_query("Top tables", "SELECT 1\n-- first", folder["id"], tags=["ops", "OPS", "daily"])
    assert query["id"].startswith("q_")
    assert query["folder_id"] == folder["id"]
    assert query["sql"] == "SELECT 1\n-- first"
    assert query["host_id"] == "local"
    assert query["tags"] == ["ops", "daily"]
    assert query["revision"] == start + 2

    lib = library()
    assert lib["revision"] == start + 2
    assert [f["id"] for f in lib["folders"]] == [folder["id"]]
    assert [q["id"] for q in lib["queries"]] == [query["id"]]
    assert lib["queries"][0]["sql"] == "SELECT 1\n-- first"

    patched = ok(w("PATCH", f"/api/query-library/queries/{query['id']}",
                   body={"name": "Top tables v2", "description": "desc", "sql": "SELECT 2", "tags": []}))
    assert patched["name"] == "Top tables v2" and patched["sql"] == "SELECT 2" and patched["tags"] == []
    assert patched["created_at_ms"] == query["created_at_ms"]
    assert patched["revision"] == start + 3
    moved = ok(w("PATCH", f"/api/query-library/queries/{query['id']}", body={"folder_id": None}))
    assert moved["folder_id"] is None

    renamed = ok(w("PATCH", f"/api/query-library/folders/{folder['id']}", body={"name": "Reports 2026", "description": ""}))
    assert renamed["name"] == "Reports 2026" and renamed["description"] == ""

    ok(w("DELETE", f"/api/query-library/queries/{query['id']}"))
    ok(w("DELETE", f"/api/query-library/folders/{folder['id']}"))
    lib = library()
    assert lib["folders"] == [] and lib["queries"] == []
    assert w("DELETE", f"/api/query-library/queries/{query['id']}").status_code == 404
    assert w("PATCH", f"/api/query-library/folders/{folder['id']}", body={"name": "x"}).status_code == 404


@needs_writable
def test_validation_errors(clean_library):
    cases = [
        ("POST", "/api/query-library/folders", {"name": ""}, "name"),
        ("POST", "/api/query-library/folders", {"name": "x", "parent_id": "f_missing"}, "parent_id"),
        ("POST", "/api/query-library/folders", {"name": "a\u0001b"}, "name"),
        ("POST", "/api/query-library/folders", {"name": "x" * 300}, "name"),
        ("POST", "/api/query-library/queries", {"name": "q"}, "sql"),
        ("POST", "/api/query-library/queries", {"name": "q", "sql": "   "}, "sql"),
        ("POST", "/api/query-library/queries", {"name": "q", "sql": "SELECT 1", "folder_id": "f_missing"}, "folder_id"),
        ("POST", "/api/query-library/queries", {"name": "q", "sql": "SELECT 1", "tags": "x"}, "tags"),
        ("POST", "/api/query-library/history", {"sql": "SELECT 1", "status": "maybe"}, "status"),
    ]
    for method, path, body, field in cases:
        response = w(method, path, body={"host_id": HOST, **body})
        assert response.status_code == 400, (body, response.text)
        payload = response.json()
        assert payload["error"] == "validation" and payload["field"] == field, payload
    response = SESSION.post(f"{WRITABLE_URL}/api/query-library/folders", data="{not json",
                            headers={"Content-Type": "application/json"}, timeout=15)
    assert response.status_code == 400 and response.json()["field"] == "body"

    make_folder("Shared")
    response = w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": "SHARED"})
    assert response.status_code == 400
    assert response.json()["field"] == "name" and response.json()["reason"] == "duplicate"


@needs_writable
def test_nested_folders_moves_and_cycles(clean_library):
    a = make_folder("A")
    b = make_folder("B", a["id"])
    c = make_folder("C", b["id"])
    other = make_folder("Other")

    # Cycles: into itself, into a descendant.
    for target in (a["id"], b["id"], c["id"]):
        response = w("PATCH", f"/api/query-library/folders/{a['id']}", body={"parent_id": target})
        assert response.status_code == 400, response.text
        assert response.json()["reason"] == "cycle"

    moved = ok(w("PATCH", f"/api/query-library/folders/{b['id']}", body={"parent_id": other["id"]}))
    assert moved["parent_id"] == other["id"]
    lib = library()
    parents = {f["id"]: f["parent_id"] for f in lib["folders"]}
    assert parents[c["id"]] == b["id"] and parents[b["id"]] == other["id"]
    to_root = ok(w("PATCH", f"/api/query-library/folders/{c['id']}", body={"parent_id": None}))
    assert to_root["parent_id"] is None

    # Depth <= 8.
    chain = [make_folder("D1")["id"]]
    for level in range(2, 9):
        chain.append(make_folder(f"D{level}", chain[-1])["id"])
    response = w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": "D9", "parent_id": chain[-1]})
    assert response.status_code == 400 and response.json()["reason"] == "depth"
    response = w("PATCH", f"/api/query-library/folders/{a['id']}", body={"parent_id": chain[-1]})
    assert response.status_code == 400 and response.json()["reason"] == "depth"

    # A move into a folder that already has a sibling of the same name.
    make_folder("Same", other["id"])
    same_root = make_folder("same")
    response = w("PATCH", f"/api/query-library/folders/{same_root['id']}", body={"parent_id": other["id"]})
    assert response.status_code == 400 and response.json()["reason"] == "duplicate"


@needs_writable
def test_delete_non_empty_folder_needs_recursive(clean_library):
    top = make_folder("Top")
    child = make_folder("Child", top["id"])
    make_query("In top", "SELECT 1", top["id"])
    make_query("In child", "SELECT 2", child["id"])
    make_query("Outside", "SELECT 3")

    response = w("DELETE", f"/api/query-library/folders/{top['id']}")
    assert response.status_code == 409, response.text
    payload = response.json()
    assert payload["error"] == "not_empty" and payload["folders"] == 1 and payload["queries"] == 1

    empty = make_folder("Empty")
    ok(w("DELETE", f"/api/query-library/folders/{empty['id']}"))

    result = ok(w("DELETE", f"/api/query-library/folders/{top['id']}", params={"recursive": "1"}))
    assert result["deleted_folders"] == 2 and result["deleted_queries"] == 2
    lib = library()
    assert lib["folders"] == []
    assert [q["name"] for q in lib["queries"]] == ["Outside"]


@needs_writable
def test_if_match_conflict(clean_library):
    folder = make_folder("Conflicts")
    revision = folder["revision"]
    response = w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": "Late"}, headers={"If-Match": str(revision - 1)})
    assert response.status_code == 409, response.text
    assert response.json() == {**response.json(), "error": "conflict", "revision": revision}
    for index, spell in enumerate(("{}", '"{}"', 'W/"{}"', "*")):
        header = spell.format(revision)
        created = ok(w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": f"Ok {index}"},
                       headers={"If-Match": header}), 201)
        assert created["revision"] == revision + 1
        revision = created["revision"]
    assert w("DELETE", f"/api/query-library/folders/{folder['id']}", headers={"If-Match": "nope"}).status_code == 400
    assert w("DELETE", f"/api/query-library/folders/{folder['id']}", headers={"If-Match": "1"}).status_code == 409
    ok(w("DELETE", f"/api/query-library/folders/{folder['id']}", headers={"If-Match": str(revision)}))


@needs_writable
def test_size_limits(clean_library):
    response = w("POST", "/api/query-library/queries", body={"host_id": HOST, "name": "Big", "sql": "S" * (MAX_QUERY_BYTES + 1)})
    assert response.status_code == 413, response.text
    assert response.json()["error"] == "too_large" and response.json()["field"] == "sql"
    response = w("POST", "/api/query-library/history", body={"host_id": HOST, "sql": "S" * (MAX_QUERY_BYTES + 1)})
    assert response.status_code == 413
    response = SESSION.post(f"{WRITABLE_URL}/api/query-library/import", data=b"[" + b" " * (MAX_FILE_BYTES + 70000) + b"]",
                            headers={"Content-Type": "application/json"}, timeout=15)
    assert response.status_code == 413

    for i in range(5):
        add_history(f"SELECT {i} -- " + "h" * 8000)
    created = 0
    response = None
    for i in range(40):
        response = w("POST", "/api/query-library/queries", body={"host_id": HOST, "name": f"Q{i}", "sql": "SELECT '" + "q" * 15000 + "'"})
        if response.status_code != 201:
            break
        created += 1
    assert response is not None and response.status_code == 413, response.text
    assert response.json()["error"] == "too_large"
    assert 5 <= created < 9
    # History is evicted first; the library is intact and still readable.
    assert len(history_page(limit=100)["entries"]) < 5
    assert len(library()["queries"]) == created


@needs_writable
def test_history_ring_buffer_and_pagination(clean_library):
    revision = library()["revision"]
    base_ms = 1_790_000_000_000
    for i in range(HISTORY_MAX + 5):
        status = "error" if i % 7 == 0 else "ok"
        body = {"sql": f"SELECT {i} AS n_{i}", "host_id": "local", "ran_at_ms": base_ms + i * 1000,
                "elapsed_ms": 12.5, "rows": i, "status": status, "error": "boom" if status == "error" else None}
        created = ok(w("POST", "/api/query-library/history", body=body), 201)
        assert created["id"].startswith("h_")
    assert library()["revision"] == revision  # history does not invalidate the library revision

    first = history_page(limit=10)
    assert len(first["entries"]) == 10 and first["has_more"] is True
    assert first["entries"][0]["sql"] == f"SELECT {HISTORY_MAX + 4} AS n_{HISTORY_MAX + 4}"
    entry = first["entries"][0]
    assert set(entry) >= {"id", "sql", "host_id", "ran_at_ms", "elapsed_ms", "rows", "status", "error"}
    assert entry["elapsed_ms"] == 12.5

    seen = [e["id"] for e in first["entries"]]
    cursor = first["entries"][-1]["ran_at_ms"]
    while True:
        page = history_page(limit=10, before_ms=cursor)
        seen += [e["id"] for e in page["entries"]]
        if not page["has_more"]:
            break
        cursor = page["entries"][-1]["ran_at_ms"]
    assert len(seen) == HISTORY_MAX == len(set(seen))  # oldest 5 dropped
    oldest = history_page(limit=1, before_ms=base_ms + 5 * 1000 + 1)["entries"]
    assert [e["sql"] for e in oldest] == ["SELECT 5 AS n_5"]

    filtered = history_page(q="n_1")["entries"]
    assert {e["sql"] for e in filtered} == {f"SELECT {i} AS n_{i}" for i in range(10, 20)}
    errors = [e for e in history_page(limit=100)["entries"] if e["status"] == "error"]
    assert errors and all(e["error"] == "boom" for e in errors)

    assert w("GET", "/api/query-library/history", params={"host_id": HOST, "limit": "0"}).status_code == 400
    assert w("GET", "/api/query-library/history", params={"host_id": HOST, "before_ms": "x"}).status_code == 400

    victim = first["entries"][0]["id"]
    ok(w("DELETE", f"/api/query-library/history/{victim}"))
    assert w("DELETE", f"/api/query-library/history/{victim}").status_code == 404
    cleared = ok(w("DELETE", "/api/query-library/history", params={"host_id": HOST}))
    assert cleared["deleted"] == HISTORY_MAX - 1
    assert history_page()["entries"] == []


@needs_writable
def test_import_deduplicates(clean_library):
    make_query("Existing", "SELECT 1")
    payload = {
        "host_id": HOST,
        "folders": [
            {"id": "local-a", "parent_id": None, "name": "Imported", "description": "from browser"},
            {"id": "local-b", "parent_id": "local-a", "name": "Nested"},
        ],
        "queries": [
            {"name": "Existing", "sql": "SELECT 1"},
            {"name": "Existing", "sql": "SELECT 2"},
            {"name": "Nested query", "sql": "SELECT 3", "folder_id": "local-b", "tags": ["x"]},
            {"name": "Nested query", "sql": "SELECT 3", "folder_id": "local-b"},
            {"name": "Unknown folder", "sql": "SELECT 4", "folder_id": "local-zzz"},
        ],
    }
    result = ok(w("POST", "/api/query-library/import", body=payload))
    assert (result["imported_folders"], result["imported_queries"], result["skipped_queries"]) == (2, 3, 2)
    lib = library()
    assert result["revision"] == lib["revision"]
    folders = {f["name"]: f for f in lib["folders"]}
    assert folders["Nested"]["parent_id"] == folders["Imported"]["id"]
    assert result["folder_ids"] == {"local-a": folders["Imported"]["id"], "local-b": folders["Nested"]["id"]}
    queries = {q["name"]: q for q in lib["queries"]}
    assert set(queries) == {"Existing", "Existing (2)", "Nested query", "Unknown folder"}
    assert queries["Nested query"]["folder_id"] == folders["Nested"]["id"]
    assert queries["Unknown folder"]["folder_id"] is None

    again = ok(w("POST", "/api/query-library/import", body=payload))
    assert (again["imported_folders"], again["merged_folders"], again["imported_queries"]) == (0, 2, 0)
    assert again["skipped_queries"] == 5
    assert again["revision"] == lib["revision"]
    assert len(library()["queries"]) == 4

    cyclic = {"host_id": HOST, "folders": [{"id": "a", "parent_id": "b", "name": "A"}, {"id": "b", "parent_id": "a", "name": "B"}]}
    response = w("POST", "/api/query-library/import", body=cyclic)
    assert response.status_code == 400 and response.json()["reason"] == "cycle"


@needs_writable
def test_import_copy_moves_a_browser_folder_in_whole(clean_library):
    """copy: true (the browser moving a folder of its own storage into the
    server root, under an existing folder): nothing merged, skipped or
    renamed; a clashing name is a 400 duplicate and writes nothing."""
    target = make_folder("Target")
    make_query("Same", "SELECT 1")
    payload = {
        "host_id": HOST,
        "copy": True,
        "folders": [
            {"id": "b-1", "parent_id": target["id"], "name": "Moved", "description": "from the browser"},
            {"id": "b-2", "parent_id": "b-1", "name": "Deeper"},
        ],
        "queries": [
            {"name": "Same", "sql": "SELECT 1", "folder_id": "b-1", "created_at_ms": 1_700_000_000_000},
            {"name": "Twin", "sql": "SELECT 1", "folder_id": "b-2", "tags": ["t"]},
        ],
    }
    result = ok(w("POST", "/api/query-library/import", body=payload))
    assert (result["imported_folders"], result["merged_folders"], result["imported_queries"], result["skipped_queries"]) == (2, 0, 2, 0)
    lib = library()
    folders = {f["name"]: f for f in lib["folders"]}
    assert folders["Moved"]["parent_id"] == target["id"] and folders["Deeper"]["parent_id"] == folders["Moved"]["id"]
    assert result["folder_ids"]["b-1"] == folders["Moved"]["id"]
    moved = [q for q in lib["queries"] if q["folder_id"] in (folders["Moved"]["id"], folders["Deeper"]["id"])]
    assert sorted(q["name"] for q in moved) == ["Same", "Twin"]
    assert next(q for q in moved if q["name"] == "Same")["created_at_ms"] == 1_700_000_000_000
    # The same folder again under the same parent: a duplicate, nothing written.
    response = w("POST", "/api/query-library/import", body=payload)
    assert response.status_code == 400 and response.json()["reason"] == "duplicate"
    assert library()["revision"] == lib["revision"]
    response = w("POST", "/api/query-library/import", body={**payload, "copy": "yes"})
    assert response.status_code == 400 and response.json()["field"] == "copy"


@needs_writable
def test_cross_site_writes_are_refused(clean_library):
    body = {"host_id": HOST, "name": "Evil"}
    for headers in (
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
        {"Origin": "http://evil.example"},
        {"Origin": "null"},
    ):
        response = w("POST", "/api/query-library/folders", body=body, headers=headers)
        assert response.status_code == 403, (headers, response.text)
        assert response.json()["error"] == "cross_site_request"
    response = w("DELETE", "/api/query-library/history", params={"host_id": HOST}, headers={"Sec-Fetch-Site": "cross-site"})
    assert response.status_code == 403
    response = SESSION.post(f"{WRITABLE_URL}/api/query-library/folders", data=json.dumps(body),
                            headers={"Content-Type": "text/plain"}, timeout=15)
    assert response.status_code == 415
    assert library()["folders"] == []
    # The page itself (same origin) is accepted.
    host = WRITABLE_URL.split("://", 1)[1]
    ok(w("POST", "/api/query-library/folders", body=body, headers={"Sec-Fetch-Site": "same-origin"}), 201)
    ok(w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": "Origin ok"}, headers={"Origin": f"http://{host}"}), 201)


@needs_data_dir
def test_file_is_private_and_versioned(clean_library):
    folder = make_folder("On disk")
    make_query("Disk query", "SELECT 'disk'", folder["id"])
    add_history("SELECT 'history'")
    path = library_path()
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600, oct(mode)
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["version"] == 2
    assert all(item["host_id"] == HOST for key in ("folders", "queries", "history") for item in document[key])
    assert document["revision"] == library()["revision"]
    assert [f["name"] for f in document["folders"]] == ["On disk"]
    assert document["queries"][0]["sql"] == "SELECT 'disk'"
    assert document["history"][-1]["sql"] == "SELECT 'history'"
    leftovers = [p.name for p in Path(DATA_DIR).iterdir() if p.name != LIBRARY_FILE and ".tmp-" in p.name]
    assert leftovers == []


@needs_data_dir
def test_external_edit_is_reloaded(clean_library):
    make_folder("Ensures the file exists")
    before = library()["revision"]
    path = library_path()
    document = json.loads(path.read_text(encoding="utf-8"))
    document["queries"].append({"id": "q_external", "folder_id": None, "name": "External", "description": "",
                                "sql": "SELECT 'external'", "host_id": HOST, "tags": []})
    replace_file(path, json.dumps(document))
    lib = library()
    assert lib["revision"] > before
    assert any(q["id"] == "q_external" for q in lib["queries"])
    # The next mutation applies on top of the reloaded file.
    make_query("After external", "SELECT 5")
    names = {q["name"] for q in json.loads(path.read_text(encoding="utf-8"))["queries"]}
    assert {"External", "After external"} <= names


@needs_data_dir
def test_malformed_file_is_served_read_only_and_never_overwritten(clean_library):
    make_query("Keep me", "SELECT 'keep'")
    path = library_path()
    good = path.read_text(encoding="utf-8")
    broken = good[: len(good) // 2]
    try:
        replace_file(path, broken)
        lib = library()
        assert lib["load_error"], lib
        assert lib["writable"] is False
        assert ok(w("GET", "/api/version"))["features"]["query_library"]["writable"] is False
        response = w("POST", "/api/query-library/folders", body={"host_id": HOST, "name": "x"})
        assert response.status_code == 403 and response.json()["error"] == "read_only"
        assert response.json()["load_error"]
        assert w("POST", "/api/query-library/history", body={"host_id": HOST, "sql": "SELECT 1"}).status_code == 403
        assert path.read_text(encoding="utf-8") == broken

        if RESTART_CMD:
            restart_writable()
            lib = library()
            assert lib["load_error"] and lib["writable"] is False
            assert lib["folders"] == [] and lib["queries"] == []
            assert w("POST", "/api/query-library/queries", body={"host_id": HOST, "name": "x", "sql": "SELECT 1"}).status_code == 403
            assert path.read_text(encoding="utf-8") == broken
    finally:
        replace_file(path, good)
    lib = library()
    assert lib["load_error"] is None and lib["writable"] is True
    assert [q["name"] for q in lib["queries"]] == ["Keep me"]


@needs_restart
def test_library_persists_across_restart(clean_library):
    folder = make_folder("Persistent", description="survives")
    child = make_folder("Child", folder["id"])
    query = make_query("Persistent query", "SELECT 'persist'", child["id"], tags=["p"])
    add_history("SELECT 'persisted history'", ran_at_ms=1_790_000_000_000)
    before = library()

    restart_writable()

    after = library()
    assert after["revision"] == before["revision"]
    assert after["folders"] == before["folders"]
    assert after["queries"] == before["queries"]
    assert any(q["id"] == query["id"] and q["sql"] == "SELECT 'persist'" for q in after["queries"])
    assert [e["sql"] for e in history_page()["entries"]] == ["SELECT 'persisted history'"]
    # Still editable after the restart.
    ok(w("PATCH", f"/api/query-library/queries/{query['id']}", body={"name": "Renamed after restart"}))


# --- read-only --------------------------------------------------------------


def ro(method: str, path: str, **kwargs) -> requests.Response:
    return call(READONLY_URL, method, path, **kwargs)


@needs_readonly
def test_read_only_library():
    feature = ok(ro("GET", "/api/version"))["features"]["query_library"]
    assert feature == {"enabled": True, "writable": False, "history_store": "server"}
    lib = ok(ro("GET", "/api/query-library", params={"host_id": HOST}))
    assert lib["writable"] is False and lib["load_error"] is None
    folder_id = lib["folders"][0]["id"] if lib["folders"] else "f_missing"
    query_id = lib["queries"][0]["id"] if lib["queries"] else "q_missing"
    for method, path, body in [
        ("POST", "/api/query-library/folders", {"host_id": HOST, "name": "x"}),
        ("PATCH", f"/api/query-library/folders/{folder_id}", {"name": "y"}),
        ("DELETE", f"/api/query-library/folders/{folder_id}", None),
        ("POST", "/api/query-library/queries", {"host_id": HOST, "name": "x", "sql": "SELECT 1"}),
        ("PATCH", f"/api/query-library/queries/{query_id}", {"name": "y"}),
        ("DELETE", f"/api/query-library/queries/{query_id}", None),
        ("POST", "/api/query-library/import", {"host_id": HOST, "folders": [], "queries": [{"name": "x", "sql": "SELECT 1"}]}),
        ("DELETE", "/api/query-library/history?host_id=local", None),
        ("DELETE", "/api/query-library/history/h_missing", None),
    ]:
        response = ro(method, path, body=body)
        assert response.status_code == 403, (method, path, response.text)
        assert response.json()["error"] == "read_only"
    assert ok(ro("GET", "/api/query-library", params={"host_id": HOST})) == lib

    # Recording history is not library editing: allowed when read-only.
    marker = f"SELECT 'ro-history-{uuid.uuid4().hex}'"
    created = ok(ro("POST", "/api/query-library/history", body={"sql": marker, "host_id": HOST, "status": "ok"}), 201)
    entries = ok(ro("GET", "/api/query-library/history", params={"host_id": HOST, "q": marker}))["entries"]
    assert [e["id"] for e in entries] == [created["id"]]
    assert ok(ro("GET", "/api/query-library/history", params={"host_id": OTHER, "q": marker}))["entries"] == []
    assert ok(ro("GET", "/api/query-library", params={"host_id": HOST}))["revision"] == lib["revision"]


# Version 1 of the file: folders have no host. Every entry without a host is
# dropped on load; a query left in a dropped folder moves to the top level.
VERSION_1 = {
    "version": 1,
    "revision": 5,
    "folders": [
        {"id": "f_v1_ops", "parent_id": None, "name": "Operations", "description": ""},
        {"id": "f_v1_merges", "parent_id": "f_v1_ops", "name": "Merges", "description": ""},
    ],
    "queries": [
        {"id": "q_v1_hostless", "folder_id": None, "name": "Hostless", "sql": "SELECT 1", "host_id": None, "tags": []},
        {"id": "q_v1_parts", "folder_id": "f_v1_merges", "name": "Parts", "sql": "SELECT 2", "host_id": HOST, "tags": []},
        {"id": "q_v1_other", "folder_id": None, "name": "Other top", "sql": "SELECT 3", "host_id": OTHER, "tags": []},
    ],
    "history": [
        {"id": "h_v1_hostless", "sql": "SELECT 4", "host_id": None, "ran_at_ms": 1_790_000_000_000},
        {"id": "h_v1_local", "sql": "SELECT 5", "host_id": HOST, "ran_at_ms": 1_790_000_001_000},
    ],
}


def assert_version_1_migrated(get) -> None:
    lib = ok(get("GET", "/api/query-library", params={"host_id": HOST}))
    assert lib["load_error"] is None
    assert lib["folders"] == []
    assert [(q["id"], q["folder_id"]) for q in lib["queries"]] == [("q_v1_parts", None)]
    assert [q["id"] for q in ok(get("GET", "/api/query-library", params={"host_id": OTHER}))["queries"]] == ["q_v1_other"]
    entries = ok(get("GET", "/api/query-library/history", params={"host_id": HOST}))["entries"]
    assert [e["id"] for e in entries] == ["h_v1_local"]


@needs_data_dir
def test_version_1_file_is_migrated_and_rewritten(clean_library):
    path = library_path()
    good = path.read_text(encoding="utf-8") if path.exists() else None
    try:
        replace_file(path, json.dumps(VERSION_1))
        assert_version_1_migrated(w)
        document = json.loads(path.read_text(encoding="utf-8"))
        assert document["version"] == 2
        assert document["folders"] == []
        assert {q["id"]: q["folder_id"] for q in document["queries"]} == {"q_v1_parts": None, "q_v1_other": None}
        assert [h["id"] for h in document["history"]] == ["h_v1_local"]
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert not [p.name for p in Path(DATA_DIR).iterdir() if ".tmp-" in p.name]
        assert library()["writable"] is True
        if RESTART_CMD:
            restart_writable()
            assert_version_1_migrated(w)
    finally:
        if good is not None:
            replace_file(path, good)


@needs_ro_data_dir
def test_version_1_file_is_migrated_in_memory_when_read_only():
    path = Path(RO_DATA_DIR) / LIBRARY_FILE
    good = path.read_text(encoding="utf-8") if path.exists() else None
    text = json.dumps(VERSION_1)
    try:
        replace_file(path, text)
        assert_version_1_migrated(ro)
        assert path.read_text(encoding="utf-8") == text  # never rewritten
    finally:
        if good is not None:
            replace_file(path, good)
        else:
            path.unlink()


# --- per host ---------------------------------------------------------------


@needs_writable
def test_host_id_is_required_and_validated(clean_library):
    for path in ("/api/query-library", "/api/query-library/history"):
        response = w("GET", path)
        assert response.status_code == 400, response.text
        assert response.json()["field"] == "host_id" and response.json()["reason"] == "required"
        response = w("GET", path, params={"host_id": "nowhere"})
        assert response.status_code == 400 and response.json()["reason"] == "unknown_host", response.text
    for method, path, body in [
        ("POST", "/api/query-library/folders", {"name": "x"}),
        ("POST", "/api/query-library/queries", {"name": "x", "sql": "SELECT 1"}),
        ("POST", "/api/query-library/history", {"sql": "SELECT 1"}),
        ("POST", "/api/query-library/import", {"queries": [{"name": "x", "sql": "SELECT 1"}]}),
        ("DELETE", "/api/query-library/history", None),
    ]:
        response = w(method, path, body=body)
        assert response.status_code == 400, (method, path, response.text)
        assert response.json()["field"] == "host_id" and response.json()["reason"] == "required"
        if body is not None:
            response = w(method, path, body={**body, "host_id": "nowhere"})
            assert response.status_code == 400 and response.json()["reason"] == "unknown_host"
    assert library()["folders"] == [] and library()["queries"] == []


@needs_writable
def test_library_is_per_host(clean_library):
    local = make_folder("Operations")
    other = make_folder("Operations", host=OTHER)  # the top level of each host is its own
    make_query("Parts", "SELECT 'local'", local["id"])
    make_query("Parts", "SELECT 'other'", other["id"], host=OTHER)
    make_query("Other only", "SELECT 2", host=OTHER)
    lib, lib_other = library(), library(OTHER)
    assert lib["host_id"] == HOST and lib_other["host_id"] == OTHER
    assert [f["id"] for f in lib["folders"]] == [local["id"]]
    assert [q["sql"] for q in lib["queries"]] == ["SELECT 'local'"]
    assert {q["name"] for q in lib_other["queries"]} == {"Parts", "Other only"}
    assert all(item["host_id"] == OTHER for item in lib_other["folders"] + lib_other["queries"])
    assert lib["revision"] == lib_other["revision"]


@needs_writable
def test_moving_into_a_folder_of_another_host_is_rejected(clean_library):
    local = make_folder("Local")
    other = make_folder("Other", host=OTHER)
    query = make_query("Q", "SELECT 1", local["id"])
    revision = library()["revision"]
    for method, path, body, field in [
        ("PATCH", f"/api/query-library/queries/{query['id']}", {"folder_id": other["id"]}, "folder_id"),
        ("PATCH", f"/api/query-library/queries/{query['id']}", {"host_id": OTHER}, "host_id"),
        ("PATCH", f"/api/query-library/folders/{local['id']}", {"parent_id": other["id"]}, "parent_id"),
        ("POST", "/api/query-library/queries", {"host_id": HOST, "name": "X", "sql": "SELECT 1", "folder_id": other["id"]}, "folder_id"),
        ("POST", "/api/query-library/folders", {"host_id": HOST, "name": "X", "parent_id": other["id"]}, "parent_id"),
    ]:
        response = w(method, path, body=body)
        assert response.status_code == 400, (path, body, response.text)
        payload = response.json()
        assert payload["error"] == "validation" and payload["reason"] == "host_mismatch" and payload["field"] == field, payload
    assert library()["revision"] == revision
    assert library()["queries"][0]["folder_id"] == local["id"]


@needs_writable
def test_history_is_stamped_and_listed_per_host(clean_library):
    first = add_history("SELECT 'on local'")
    add_history("SELECT 'on other'", host=OTHER)
    entries = history_page()["entries"]
    assert [(e["id"], e["host_id"]) for e in entries] == [(first["id"], HOST)]
    assert [e["sql"] for e in history_page(OTHER)["entries"]] == ["SELECT 'on other'"]
    assert history_page(q="on other")["entries"] == []
    cleared = ok(w("DELETE", "/api/query-library/history", params={"host_id": OTHER}))
    assert cleared["deleted"] == 1
    assert len(history_page()["entries"]) == 1 and history_page(OTHER)["entries"] == []


@needs_writable
def test_import_keeps_the_current_host(clean_library):
    make_folder("Other folder", host=OTHER)
    payload = {
        "host_id": OTHER,
        "folders": [{"id": "b-1", "parent_id": None, "name": "Imported"}],
        "queries": [
            {"name": "A", "sql": "SELECT 'a'", "host_id": HOST, "folder_id": "b-1"},
            {"name": "B", "sql": "SELECT 'b'"},
        ],
    }
    result = ok(w("POST", "/api/query-library/import", body=payload))
    assert result["imported_queries"] == 2
    lib_other = library(OTHER)
    assert {q["name"] for q in lib_other["queries"]} == {"A", "B"}
    assert all(item["host_id"] == OTHER for item in lib_other["folders"] + lib_other["queries"])
    assert library()["queries"] == [] and library()["folders"] == []
    # The same payload into the local host is new there.
    again = ok(w("POST", "/api/query-library/import", body={**payload, "host_id": HOST}))
    assert again["imported_queries"] == 2 and again["merged_folders"] == 0
