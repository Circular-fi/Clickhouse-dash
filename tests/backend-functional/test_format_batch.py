"""A format batch answers a status for each statement (README.md, "POST /api/format"; ARCH-B-124): a statement that fails does not
fail the others, the single-statement form keeps its HTTP error, and a batch that is refused as a whole has its HTTP status.

API_BASE_URL is an instance of tests/config/CH_HOSTS.local.hcl.
"""

from __future__ import annotations

import os

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")


# One connection for each call: a test that waits for ClickHouse for several seconds would find its kept-alive connection closed
# by the server (a POST is not retried on a closed connection).
def post(path: str, **kwargs):
    return requests.post(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)


def get(path: str, **kwargs):
    return requests.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 30), **kwargs)


def format_batch(sqls: list[str], **extra) -> dict:
    response = post("/api/format", json={"host_id": "local", "sqls": sqls, **extra}, timeout=60)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_format_batch_answers_a_status_for_each_statement():
    body = format_batch(["select 1", "select * frm t where ((", "select 2 from  numbers(3)"])
    results = body["results"]
    assert [item["index"] for item in results] == [0, 1, 2], body
    assert [item["status"] for item in results] == ["formatted", "error", "formatted"], body
    assert results[0]["formatted_sql"] == "SELECT 1" and results[2]["formatted_sql"].startswith("SELECT 2"), body
    error = results[1]["error"]
    assert error["error_code"] == "format_failed" and error["index"] == 1 and error["retryable"] is False, body
    assert error["clickhouse"]["position"] > 0, body
    assert (body["formatted"], body["failed"], body["skipped"]) == (2, 1, 0), body
    assert "formatted_sql" not in results[1]


def test_a_format_batch_with_no_error_has_only_formatted_statements():
    body = format_batch(["select 1", "select 2"])
    assert [item["status"] for item in body["results"]] == ["formatted", "formatted"] and body["failed"] == 0, body


def test_the_single_statement_form_keeps_its_http_error():
    response = post("/api/format", json={"host_id": "local", "sql": "select * frm t where (("})
    assert response.status_code == 422 and response.json()["error_code"] == "format_failed", response.text
    assert response.json()["clickhouse"]["position"] > 0


def test_a_format_batch_that_is_refused_as_a_whole_has_its_http_status():
    assert post("/api/format", json={"host_id": "local", "sqls": [1]}).status_code == 400
    assert post("/api/format", json={"host_id": "local", "sqls": ["select 1"] * 1025}).status_code == 413
    assert post("/api/format", json={"host_id": "nowhere", "sqls": ["select 1"]}).status_code == 404
