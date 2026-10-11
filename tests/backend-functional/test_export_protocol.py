"""The export protocol (docs/massive-export.md, ARCH-B-067): the stream starts with a POST that carries the token in its JSON body,
no GET starts anything, a statement that is refused says it is forbidden, and the kill of an abandoned export comes from the
system account.

API_BASE_URL is an instance of tests/config/CH_HOSTS.local.hcl (export.max_concurrent = 1); CLICKHOUSE_URL an admin account of the
same ClickHouse.
"""

from __future__ import annotations

import io
import os
import time
import uuid
import zipfile
from urllib.parse import urljoin

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CLICKHOUSE_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


# One connection for each call: a test that waits for ClickHouse for several seconds would find its kept-alive connection closed
# by the server (a POST is not retried on a closed connection).
def post(path: str, **kwargs):
    return requests.post(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)


def get(path: str, **kwargs):
    return requests.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)


def ch(sql: str) -> str:
    response = requests.post(CLICKHOUSE_URL + "/", data=sql.encode(), auth=CLICKHOUSE_AUTH, timeout=60)
    assert response.status_code == 200, response.text
    return response.text


def wait_for(check, timeout: float = 20.0, step: float = 0.25):
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value or time.monotonic() >= deadline:
            return value
        time.sleep(step)


def handshake(queries: list[str], fmt: str = "csv") -> dict:
    response = post("/api/export/run", json={"host_id": "local", "format": fmt, "queries": queries})
    assert response.status_code == 200, response.text
    return response.json()


def stream(payload: dict, **kwargs):
    return SESSION.post(urljoin(BASE_URL + "/", payload["stream_url"]), json={"token": payload["token"]}, timeout=60, **kwargs)


def test_the_export_token_is_in_the_body_of_a_post_and_never_in_an_address():
    payload = handshake(["SELECT 1 AS one"])
    assert set(payload) == {"export_id", "format", "expires_in_ms", "stream_url", "token"}, payload
    assert "?" not in payload["stream_url"] and payload["token"] not in payload["stream_url"], payload
    archive = stream(payload)
    assert archive.status_code == 200, archive.text
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        assert "results.csv" in zf.namelist()


def test_no_get_starts_an_export_and_a_get_does_not_use_the_token():
    payload = handshake(["SELECT 2 AS two"])
    for path in ("/api/export/stream", f"/api/export/stream?token={payload['token']}"):
        response = get(path)
        assert response.status_code == 405, (path, response.text)
        assert response.headers.get("Allow") == "POST"
        assert response.json()["error_code"] == "method_not_allowed"
    # The token is still good: the GET did not consume it, and it ran nothing.
    archive = stream(payload)
    assert archive.status_code == 200, archive.text
    # And it is one use.
    again = stream(payload)
    assert again.status_code == 404 and again.json()["error_code"] == "export_not_found", again.text


def test_the_stream_needs_a_json_body_with_a_token():
    url = f"{BASE_URL}/api/export/stream"
    refused = SESSION.post(url, data=b'{"token": "x"}', headers={"Content-Type": "text/plain"}, timeout=30)
    assert refused.status_code == 415, refused.text
    assert SESSION.post(url, json={}, timeout=30).json()["error_code"] == "missing_export_token"
    assert SESSION.post(url, json={"token": 5}, timeout=30).json()["error_code"] == "missing_export_token"
    assert SESSION.post(url, data=b"not json", headers={"Content-Type": "application/json"}, timeout=30).status_code == 400
    unknown = SESSION.post(url, json={"token": "not.a.token"}, timeout=30)
    assert unknown.status_code == 404 and unknown.json()["error_code"] == "export_not_found", unknown.text
    # A cross-site page cannot start it either (the guard of every write).
    cross = SESSION.post(url, json={"token": "x"}, headers={"Sec-Fetch-Site": "cross-site"}, timeout=30)
    assert cross.status_code == 403 and cross.json()["error_code"] == "cross_site_request", cross.text


def test_a_command_in_an_export_gets_the_status_member():
    payload = handshake(["SET max_threads = 2"])
    with zipfile.ZipFile(io.BytesIO(stream(payload).content)) as zf:
        assert zf.read("results.csv").decode() == "status\nOK\n"


def test_an_export_statement_that_is_refused_says_it_is_forbidden():
    response = post("/api/export/run", json={"host_id": "local", "format": "csv", "queries": ["KILL QUERY WHERE 0"]})
    assert response.status_code == 403 and response.json()["error_code"] == "sql_forbidden", response.text


def test_the_kill_of_an_abandoned_export_comes_from_the_system_account():
    # The cancel of every statement goes through system_uri (docs/configuration.md, "Authorization model"): the runner has no KILL QUERY grant.
    tag = uuid.uuid4().hex
    sql = (f"SELECT sum(s) AS n, '{tag}' AS tag FROM (SELECT sleepEachRow(3) AS s FROM numbers(20) SETTINGS max_block_size = 1) "
           "SETTINGS interactive_delay = 60000000")
    running = (f"SELECT query_id FROM system.processes WHERE position(query, '{tag}') > 0 "
               "AND query NOT LIKE '%system.processes%' LIMIT 1")
    payload = handshake([sql])
    download = stream(payload, stream=True)
    assert download.status_code == 200, download.text
    next(download.iter_content(chunk_size=64))
    query_id = wait_for(lambda: ch(running).strip())
    assert query_id, "the statement of the export is not running"
    download.close()
    assert wait_for(lambda: ch(running).strip() == "", timeout=15)
    ch("SYSTEM FLUSH LOGS")
    users = ch(f"SELECT DISTINCT user FROM system.query_log WHERE event_time > now() - 120 AND query LIKE 'KILL QUERY%' "
               f"AND position(query, '{query_id}') > 0").split()
    assert users == ["chdash_system"], users
