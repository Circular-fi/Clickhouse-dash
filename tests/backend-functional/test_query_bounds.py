"""The bounds, the labels and the cancel of the ClickHouse statements of ChDash (docs/configuration.md,
"The bounds of the queries"; src/ch_query.hpp).

- The preview limit of a run is a normal end: no KILL QUERY, no exception (ARCH-B-013).
- Every statement is labelled: the run 'chdash-run', a page 'chdash:<route>' (ARCH-B-101), and the
  statements of a page carry max_execution_time and max_memory_usage (ARCH-B-015..028).
- A cancel says what it did (ARCH-B-010).

API_BASE_URL is an instance of tests/config/CH_HOSTS.local.hcl (result_preview_row_limit = 200000);
CLICKHOUSE_URL an admin account of the same ClickHouse.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from urllib.parse import urljoin

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CLICKHOUSE_AUTH = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def ch(sql: str) -> str:
    response = requests.post(CLICKHOUSE_URL + "/", data=sql.encode(), auth=CLICKHOUSE_AUTH, timeout=60)
    assert response.status_code == 200, response.text
    return response.text


def ch_rows(sql: str) -> list[dict]:
    return [json.loads(line) for line in ch(sql + " FORMAT JSONEachRow").splitlines() if line]


def flush_logs() -> None:
    ch("SYSTEM FLUSH LOGS")


def parse_sse(response: requests.Response) -> list[dict]:
    events, name, data = [], "message", []
    for raw in response.iter_lines(decode_unicode=True):
        line = raw or ""
        if not line:
            if data or name != "message":
                events.append({"event": name, "data": json.loads("\n".join(data)) if data else None})
                if name in ("done", "error"):
                    break
            name, data = "message", []
        elif line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    return events


def start_run(sql: str) -> dict:
    response = SESSION.post(f"{BASE_URL}/api/query/run", json={"host_id": "local", "sql": sql}, timeout=15)
    assert response.status_code == 200, response.text
    return response.json()


def run(sql: str) -> tuple[dict, list[dict]]:
    handshake = start_run(sql)
    with SESSION.get(urljoin(BASE_URL + "/", handshake["stream_url"]), stream=True, timeout=(10, 120)) as stream:
        assert stream.status_code == 200, stream.text
        events = parse_sse(stream)
    return handshake, events


def rows_of(events: list[dict]) -> list[list]:
    return [row for e in events if e["event"] == "result_rows" for row in e["data"]["rows"]]


def wait_for(predicate, timeout: float = 20.0, step: float = 0.5):
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value or time.monotonic() >= deadline:
            return value
        time.sleep(step)


def test_the_preview_limit_ends_a_run_without_kill_query():
    handshake, events = run("SELECT number FROM numbers(1000000) SETTINGS max_block_size = 10000")
    done = next(e["data"] for e in events if e["event"] == "done")
    assert done["status"] == "result_limit_reached", done
    assert len(rows_of(events)) == 200000
    query_id = handshake["query_id"]
    time.sleep(0.3)
    flush_logs()
    kills = ch(
        "SELECT count() FROM system.query_log WHERE event_time > now() - 120 AND query LIKE 'KILL QUERY%' "
        f"AND position(query, '{query_id}') > 0")
    assert kills.strip() == "0", kills
    # The statement ended in ClickHouse on the Cancel packet (QUERY_WAS_CANCELLED_BY_CLIENT or a normal end),
    # not with an error of a lost connection (a KILL gives 394, a closed socket 210 or 394).
    ended = ch_rows(
        "SELECT type, exception_code FROM system.query_log WHERE event_time > now() - 120 "
        f"AND query_id = '{query_id}' AND type != 'QueryStart'")
    assert ended and all(row["exception_code"] in (0, 735) for row in ended), ended


def test_a_run_and_a_page_label_their_statements():
    _, events = run("SELECT getSetting('log_comment') AS comment")
    assert rows_of(events) == [["chdash-run"]], events
    # A page: the Explorer catalog, read again (refresh=1) so the statements run now.
    marker = time.time()
    response = SESSION.get(f"{BASE_URL}/api/explorer/catalog", params={"host_id": "local", "refresh": "1"}, timeout=60)
    assert response.status_code == 200, response.text
    flush_logs()
    rows = ch_rows(
        "SELECT user, Settings['max_memory_usage'] AS memory, Settings['max_execution_time'] AS seconds "
        "FROM system.query_log WHERE event_time >= toDateTime(" + str(int(marker) - 1) + ") "
        "AND log_comment = 'chdash:/api/explorer/catalog' AND type = 'QueryFinish'")
    assert rows, "no statement labelled chdash:/api/explorer/catalog"
    # generated_queries.max_memory_usage (4 GiB by default) and the Explorer's 10 s cap.
    assert {row["memory"] for row in rows} == {"4294967296"}, rows
    assert all(row["seconds"] and float(row["seconds"]) <= 10 for row in rows), rows


def test_system_queries_leave_the_generated_reads_out():
    # The ClickHouse of the tests is shared: other servers run the same shapes without a label, so the
    # check reads the filter that the System page sent, as test_system.py does for its own reads.
    marker = int(time.time()) - 1
    now_ms = int(time.time() * 1000)
    listed = SESSION.get(f"{BASE_URL}/api/system/queries", params={
        "host_id": "local", "from_ms": now_ms - 10 * 60 * 1000, "to_ms": now_ms, "refresh": "1"}, timeout=60)
    if listed.status_code == 404:
        pytest.skip("the Queries section of System is off on this instance")
    assert listed.status_code == 200, listed.text
    flush_logs()
    reads = ch_rows(
        f"SELECT query FROM system.query_log WHERE event_time >= toDateTime({marker}) AND type = 'QueryFinish' "
        "AND log_comment = 'chdash-system' AND query LIKE '%normalized_query_hash%' AND query LIKE '%FROM system.query_log%'")
    assert reads, "no System > Queries read in query_log"
    assert all("NOT startsWith(log_comment, 'chdash:')" in row["query"] for row in reads), reads[0]["query"][:400]
    # hide_chdash=0 lists them.
    shown = SESSION.get(f"{BASE_URL}/api/system/queries", params={
        "host_id": "local", "from_ms": now_ms - 10 * 60 * 1000, "to_ms": now_ms, "refresh": "1", "hide_chdash": "0"}, timeout=60)
    assert shown.status_code == 200, shown.text


def test_a_cancel_says_what_it_did():
    handshake = start_run("SELECT sleepEachRow(0.5), number FROM numbers(120) SETTINGS max_block_size = 1")
    stream = SESSION.get(urljoin(BASE_URL + "/", handshake["stream_url"]), stream=True, timeout=(10, 120))
    try:
        assert stream.status_code == 200
        # The query runs once the stream is attached: wait until ClickHouse lists it.
        assert wait_for(lambda: ch(
            f"SELECT count() FROM system.processes WHERE startsWith(query_id, '{handshake['query_id']}')").strip() != "0")
        answer = SESSION.post(f"{BASE_URL}/api/query/cancel", json={"cancel_token": handshake["cancel_token"]}, timeout=15)
        assert answer.status_code == 200, answer.text
        body = answer.json()
        assert body["ok"] is True and body["stopped"] is True, body
        assert body["killed"] >= 1 and "kill_error" not in body, body
    finally:
        stream.close()
    # Later the run is gone from the server: the KILL alone answers, and finds nothing running.
    assert wait_for(lambda: ch(
        f"SELECT count() FROM system.processes WHERE startsWith(query_id, '{handshake['query_id']}')").strip() == "0")
    time.sleep(1.0)
    again = SESSION.post(f"{BASE_URL}/api/query/cancel", json={"cancel_token": handshake["cancel_token"]}, timeout=15)
    assert again.status_code == 200, again.text
    assert again.json() == {"ok": True, "stopped": False, "killed": 0}, again.text
