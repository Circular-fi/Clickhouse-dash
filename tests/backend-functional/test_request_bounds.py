"""Requests that once read files outside ./static or stopped the whole process.

- A static path that is absolute or leaves ./static once read any file of the host
  (`path("./static") / "/etc/passwd"` is "/etc/passwd").
- A JSON body of a few kilobytes of "[" overflowed the 128 KiB stack of a worker thread (musl).
- A SQL text of a few hundred bytes of nested calls overflowed the formatter's recursion.
- A request body had no size limit.

After each one the server must still answer: a crash restarts the container and fails the
health check below.
"""
from __future__ import annotations

import json
import os

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def raw_get(path: str) -> requests.Response:
    # requests keeps `//` and `%2F` as written: the path reaches the server unchanged.
    return SESSION.get(f"{BASE_URL}{path}", timeout=15, allow_redirects=False)


def post_body(path: str, body: bytes) -> requests.Response:
    return SESSION.post(f"{BASE_URL}{path}", data=body, headers={"Content-Type": "application/json"}, timeout=30)


def assert_alive() -> None:
    response = SESSION.get(f"{BASE_URL}/api/version", timeout=15)
    assert response.status_code == 200, response.text


def test_static_paths_never_leave_the_static_directory() -> None:
    for path in (
        "/static//etc/passwd",
        "/static/%2Fetc%2Fpasswd",
        "/static//proc/self/environ",
        "/static/..%2F..%2Fetc%2Fpasswd",
        "/static/%2E%2E/%2E%2E/etc/passwd",
        "/static//config/CH_HOSTS.hcl",
        "/static/css/../../../etc/passwd",
        "//etc/passwd",
    ):
        response = raw_get(path)
        assert response.status_code == 404, (path, response.status_code)
        assert "root:" not in response.text and "runner_uri" not in response.text, path
    assert raw_get("/static/app.js").status_code == 200
    assert_alive()


def test_deeply_nested_json_bodies_are_refused_not_fatal() -> None:
    for route in ("/api/format", "/api/query/run", "/api/query/cancel", "/api/export/run"):
        for body in (
            b"[" * 5000 + b"]" * 5000,
            b'{"a":' * 5000 + b"1" + b"}" * 5000,
            b'{"sql":' + b"[" * 100000,
        ):
            response = post_body(route, body)
            assert response.status_code in {400, 403, 404, 413}, (route, response.status_code, response.text[:200])
    assert_alive()


def test_deeply_nested_sql_is_formatted_or_given_back() -> None:
    for depth in (62, 80, 500, 3000):
        for sql in (
            "SELECT " + "plus(1, " * depth + "1" + ")" * depth + " -- deep",
            "SELECT " + "plus(1, " * depth + "1" + ")" * depth,
            "SELECT * FROM (" * depth + "SELECT 1" + ")" * depth + " -- deep",
            "SELECT " + "[" * depth + "1" + "]" * depth + " -- deep",
            "SELECT " + "x -> " * depth + "x -- deep",
        ):
            response = post_body("/api/format", json.dumps({"host_id": "local", "sql": sql, "cache": False}).encode())
            # The local formatter (comments) answers with the text, laid out or as written; ClickHouse
            # refuses (422) a statement deeper than its own max_parser_depth.
            assert response.status_code in {200, 422}, (depth, response.status_code, response.text[:200])
    assert_alive()


def test_request_body_over_the_limit_is_refused() -> None:
    # Default max_body_bytes: twice query.max_sql_bytes (4 MiB) plus 1 MiB.
    response = post_body("/api/format", b"a" * (12 * 1024 * 1024))
    assert response.status_code == 413, response.status_code
    assert_alive()


def test_comment_text_never_becomes_code() -> None:
    sql = "DELETE FROM db.t WHERE id = 5 -- old version: or 1 = 1"
    response = post_body("/api/format", json.dumps({"host_id": "local", "sql": sql, "cache": False}).encode())
    assert response.status_code == 200, response.text
    formatted = response.json()["formatted_sql"]
    assert "-- old version: or 1 = 1" in formatted, formatted
    assert not any(line.strip().upper().startswith("OR 1 = 1") for line in formatted.splitlines()), formatted
