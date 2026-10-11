"""Deep Analyze as a job (docs/query-analysis.md, ARCH-B-016): POST starts it (202), GET polls it, POST .../cancel stops it and kills
its statements, a second POST for the same query gives the same job, and the store of jobs that ended is bounded.

API_BASE_URL is an instance of tests/config/CH_HOSTS.local.hcl (allow_deep_analyze = true); CLICKHOUSE_URL an admin account of the
same ClickHouse.
"""

from __future__ import annotations

import os
import time
import uuid
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


SLOW = ("SELECT sum(s) AS n FROM (SELECT sleepEachRow(0.5) AS s FROM numbers(40) SETTINGS max_block_size = 1) "
        "SETTINGS interactive_delay = 60000000")


def profiled_run(sql: str) -> str:
    response = post("/api/query/run", json={"host_id": "local", "sql": sql, "mode": "profiling"})
    assert response.status_code == 200, response.text
    run = response.json()
    with SESSION.get(urljoin(BASE_URL + "/", run["stream_url"]), stream=True, timeout=(10, 120)) as events:
        for _ in events.iter_lines():
            pass
    return run["query_id"]


def start_job(query_id: str) -> requests.Response:
    for _ in range(12):
        response = post("/api/query/deep-analysis", json={"host_id": "local", "query_id": query_id})
        if response.status_code != 409:
            return response
        time.sleep(0.25)
    return response


def poll(job_id: str) -> dict:
    response = get(f"/api/query/deep-analysis?host_id=local&job_id={job_id}")
    assert response.status_code == 200, response.text
    return response.json()


def test_deep_analyze_answers_at_once_and_the_poll_gives_the_result():
    query_id = profiled_run(SLOW)
    began = time.monotonic()
    response = start_job(query_id)
    assert response.status_code == 202, response.text
    # The analysis replays a 20 s statement twice: the request does not wait for it.
    assert time.monotonic() - began < 5
    job = response.json()
    assert job["status"] == "running" and job["query_id"] == query_id and job["poll_after_ms"] > 0, job
    # Asking again while it runs gives the same job: no second EXPLAIN ANALYZE.
    assert start_job(query_id).json()["job_id"] == job["job_id"]
    running = poll(job["job_id"])
    assert running["status"] == "running" and "result" not in running, running
    finished = wait_for(lambda: (lambda state: state if state["status"] != "running" else None)(poll(job["job_id"])), timeout=90)
    assert finished and finished["status"] == "finished", finished
    assert finished["result"]["query_id"] == query_id and finished["result"]["plan_nodes"], finished
    # The result is kept for the poll that comes late.
    assert poll(job["job_id"])["status"] == "finished"


def test_a_deep_analyze_job_can_be_canceled_and_its_statement_is_killed():
    tag = uuid.uuid4().hex
    query_id = profiled_run(SLOW.replace("sum(s) AS n", f"sum(s) AS n, '{tag}' AS tag"))
    job = start_job(query_id).json()
    assert wait_for(lambda: ch(
        f"SELECT count() FROM system.processes WHERE position(query, 'EXPLAIN ANALYZE') > 0 AND position(query, '{tag}') > 0 "
        "AND query NOT LIKE '%system.processes%'").strip() != "0", timeout=15)
    canceled = post("/api/query/deep-analysis/cancel", json={"host_id": "local", "job_id": job["job_id"]})
    assert canceled.status_code == 200 and canceled.json()["cancel_requested"] is True, canceled.text
    state = wait_for(lambda: (lambda s: s if s["status"] != "running" else None)(poll(job["job_id"])), timeout=15)
    assert state and state["status"] == "canceled", state
    # ClickHouse stops the statement: the 20 s of the query are not run to the end.
    assert wait_for(lambda: ch(
        f"SELECT count() FROM system.processes WHERE position(query, '{tag}') > 0 AND query NOT LIKE '%system.processes%'").strip() == "0",
        timeout=15)
    # Canceling again is harmless.
    again = post("/api/query/deep-analysis/cancel", json={"host_id": "local", "job_id": job["job_id"]})
    assert again.status_code == 200 and again.json()["status"] == "canceled", again.text


def test_a_deep_analyze_job_is_not_found_by_another_host_or_an_unknown_id():
    for path in ("/api/query/deep-analysis?host_id=local&job_id=nope", "/api/query/deep-analysis?host_id=nowhere&job_id=nope"):
        response = get(path)
        assert response.status_code == 404, response.text
    assert get("/api/query/deep-analysis?host_id=local").status_code == 400
    assert get("/api/query/deep-analysis?job_id=x").status_code == 400
    refused = post("/api/query/deep-analysis/cancel", json={"host_id": "local", "job_id": "nope"})
    assert refused.status_code == 404 and refused.json()["error_code"] == "deep_analysis_job_not_found", refused.text


def test_the_jobs_that_ended_are_bounded():
    # At most 16 jobs are kept: the oldest one that ended goes when a 17th starts.
    first = None
    for index in range(18):
        query_id = profiled_run(f"SELECT {index} AS n")
        job = start_job(query_id).json()
        first = first or job["job_id"]
        wait_for(lambda: poll(job["job_id"])["status"] != "running", timeout=30)
    assert get(f"/api/query/deep-analysis?host_id=local&job_id={first}").status_code == 404
    assert poll(job["job_id"])["status"] == "finished"


def test_a_statement_that_is_not_a_select_is_refused_before_the_job_starts():
    query_id = profiled_run("SELECT 1")
    # (The run is a SELECT: the refusals that need no job are the ones of the route.)
    assert post("/api/query/deep-analysis", json={"host_id": "local"}).status_code == 400
    assert post("/api/query/deep-analysis", json={"host_id": "nowhere", "query_id": query_id}).status_code == 404
