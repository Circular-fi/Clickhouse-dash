import json
import os
import time
from pathlib import Path
from typing import Any

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://clickhouse-dash:8080").rstrip("/")
HEALTH_PATH = os.environ.get("API_HEALTH_PATH", "/api/health")
TIMEOUT_SECONDS = int(os.environ.get("API_TIMEOUT_SECONDS", "10"))
READY_TIMEOUT_SECONDS = int(os.environ.get("API_READY_TIMEOUT_SECONDS", "90"))
STREAM_TIMEOUT_SECONDS = int(os.environ.get("API_STREAM_TIMEOUT_SECONDS", "30"))
ARTIFACTS_DIR = Path(os.environ.get("TEST_ARTIFACTS_DIR", "/tests/artifacts"))
FAIL_DIR = ARTIFACTS_DIR / "query_types_failures"

SESSION = requests.Session()
SESSION.headers.update({"Connection": "close"})


def wait_for_api_ready() -> None:
    deadline = time.time() + READY_TIMEOUT_SECONDS
    last_error = None
    url = f"{BASE_URL}{HEALTH_PATH}"

    while time.time() < deadline:
        try:
            response = SESSION.get(url, timeout=TIMEOUT_SECONDS)
            if response.status_code == 200:
                payload = response.json()
                if payload.get("ok") is True:
                    return
                last_error = f"health payload not ready: {payload}"
            else:
                last_error = (
                    f"health status={response.status_code} body={response.text}"
                )
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(1)

    raise RuntimeError(f"API did not become ready: {last_error}")


@pytest.fixture(scope="session", autouse=True)
def api_ready() -> None:
    wait_for_api_ready()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip("\n") + "\n", encoding="utf-8")


def normalize_stream_url(stream_url: str) -> str:
    if stream_url.startswith("http://") or stream_url.startswith("https://"):
        return stream_url
    if not stream_url.startswith("/"):
        stream_url = "/" + stream_url
    return f"{BASE_URL}{stream_url}"


def parse_sse_events(response: requests.Response) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    event_name: str | None = None
    data_lines: list[str] = []

    for raw_line in response.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue

        line = raw_line
        if line == "":
            if event_name is not None or data_lines:
                raw_data = "\n".join(data_lines)
                payload = None
                if raw_data:
                    payload = json.loads(raw_data)
                events.append(
                    {
                        "event": event_name or "message",
                        "data": payload,
                        "raw_data": raw_data,
                    }
                )
                if (event_name or "message") == "done":
                    break
            event_name = None
            data_lines = []
            continue

        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line[len("event:") :].strip()
            continue
        if line.startswith("data:"):
            data_lines.append(line[len("data:") :].lstrip())
            continue

    return events


def run_query_and_collect_events(
    sql: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    run_response = SESSION.post(
        f"{BASE_URL}/api/query/run",
        json={
            "host_id": "local",
            "sql": sql,
        },
        timeout=TIMEOUT_SECONDS,
    )
    run_response.raise_for_status()
    run_payload = run_response.json()

    stream_url = normalize_stream_url(run_payload["stream_url"])
    with SESSION.get(
        stream_url,
        stream=True,
        timeout=(TIMEOUT_SECONDS, STREAM_TIMEOUT_SECONDS),
        headers={"Accept": "text/event-stream"},
    ) as stream_response:
        stream_response.raise_for_status()
        events = parse_sse_events(stream_response)

    return run_payload, events


def write_failure_artifacts(
    case_name: str, sql: str, events: list[dict[str, Any]]
) -> tuple[Path, Path]:
    FAIL_DIR.mkdir(parents=True, exist_ok=True)
    sql_path = FAIL_DIR / f"{case_name}.sql"
    events_path = FAIL_DIR / f"{case_name}.events.json"
    write_text(sql_path, sql)
    events_path.write_text(
        json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return sql_path, events_path


def assert_query_stream_ok(case_name: str, sql: str) -> None:
    run_payload, events = run_query_and_collect_events(sql)

    meta_events = [event for event in events if event["event"] == "result_meta"]
    row_events = [event for event in events if event["event"] == "result_rows"]
    error_events = [event for event in events if event["event"] == "error"]
    done_event = next(
        (event for event in reversed(events) if event["event"] == "done"), None
    )

    unsupported_messages = []
    for event in error_events:
        payload = event.get("data") or {}
        message = payload.get("message")
        if isinstance(message, str) and "unsupported column type" in message.lower():
            unsupported_messages.append(message)

    ok = (
        bool(meta_events)
        and bool(row_events)
        and done_event is not None
        and isinstance(done_event.get("data"), dict)
        and done_event["data"].get("status") == "finished"
        and not error_events
        and not unsupported_messages
    )

    if ok:
        return

    sql_path, events_path = write_failure_artifacts(case_name, sql, events)
    pretty_run_payload = json.dumps(run_payload, ensure_ascii=False, indent=2)
    pretty_done = json.dumps(
        done_event.get("data") if done_event else None, ensure_ascii=False, indent=2
    )
    pretty_errors = json.dumps(
        [event.get("data") for event in error_events], ensure_ascii=False, indent=2
    )

    pytest.fail(
        "\n".join(
            [
                f"query stream regression for {case_name}",
                f"sql:        {sql_path}",
                f"events:     {events_path}",
                "",
                f"run_payload:\n{pretty_run_payload}",
                "",
                f"done_event:\n{pretty_done}",
                "",
                f"error_events:\n{pretty_errors}",
            ]
        )
    )


@pytest.mark.parametrize(
    ("case_name", "sql"),
    [
        (
            "aggregate_function_low_cardinality_argmax_state",
            "SELECT argMaxState(toLowCardinality('binance'), toUInt64(1)) AS last_source",
        ),
        (
            "json_top_level",
            'SELECT CAST(\'{"a":1,"b":["x","y"],"nested":{"ok":true}}\' AS JSON) AS payload',
        ),
        (
            "uint256_top_level",
            "SELECT toUInt256('1234567890123456789012345678901234567890') AS amount",
        ),
        (
            "aggregate_function_low_cardinality_argmax_state force",
            "SELECT CAST(argMaxState(toLowCardinality('binance'), toUInt64(1)) AS AggregateFunction(argMax, LowCardinality(String), UInt64)) AS last_source",
        ),
    ],
    ids=lambda item: item,
)
def test_query_stream_supports_native_edge_types(case_name: str, sql: str) -> None:
    assert_query_stream_ok(case_name, sql)
