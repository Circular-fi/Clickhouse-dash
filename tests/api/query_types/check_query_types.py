from __future__ import annotations

import json
import os
import re
import time
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://clickhouse-dash:8080").rstrip("/")
REFERENCE_BASE_URL = os.environ.get("API_REFERENCE_BASE_URL", "").rstrip("/")
HEALTH_PATH = os.environ.get("API_HEALTH_PATH", "/api/health")
TIMEOUT_SECONDS = int(os.environ.get("API_TIMEOUT_SECONDS", "10"))
READY_TIMEOUT_SECONDS = int(os.environ.get("API_READY_TIMEOUT_SECONDS", "90"))
STREAM_TIMEOUT_SECONDS = int(os.environ.get("API_STREAM_TIMEOUT_SECONDS", "30"))
ARTIFACTS_DIR = Path(os.environ.get("TEST_ARTIFACTS_DIR", "/tests/artifacts"))
FAIL_DIR = ARTIFACTS_DIR / "query_types_failures"
RESULTS_PATH = ARTIFACTS_DIR / "query_types_results.json"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-tests/2"})
REFERENCE_SESSION = requests.Session()
REFERENCE_SESSION.headers.update({"User-Agent": "chdash-tests-reference/2"})

EDGE_CASES: list[tuple[str, str]] = [
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
        "aggregate_function_low_cardinality_argmax_state_force",
        "SELECT CAST(argMaxState(toLowCardinality('binance'), toUInt64(1)) "
        "AS AggregateFunction(argMax, LowCardinality(String), UInt64)) AS last_source",
    ),
]

CASE_RESULTS: dict[str, dict[str, Any]] = {}
_REFERENCE_READY = False


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return cleaned.strip("._-") or "case"


def wait_for_api_ready(base_url: str, session: requests.Session) -> None:
    deadline = time.time() + READY_TIMEOUT_SECONDS
    last_error: str | None = None
    url = f"{base_url}{HEALTH_PATH}"

    while time.time() < deadline:
        try:
            response = session.get(url, timeout=TIMEOUT_SECONDS)
            if response.status_code == 200:
                payload = response.json()
                if payload.get("ok") is True:
                    return
                last_error = f"health payload not ready: {payload}"
            else:
                last_error = f"health status={response.status_code} body={response.text[:500]}"
        except (requests.RequestException, ValueError) as exc:
            last_error = repr(exc)
        time.sleep(0.5)

    raise RuntimeError(f"API did not become ready at {base_url}: {last_error}")


@pytest.fixture(scope="session", autouse=True)
def api_ready() -> None:
    wait_for_api_ready(BASE_URL, SESSION)


def ensure_reference_ready() -> None:
    global _REFERENCE_READY
    if _REFERENCE_READY or not REFERENCE_BASE_URL or REFERENCE_BASE_URL == BASE_URL:
        return
    wait_for_api_ready(REFERENCE_BASE_URL, REFERENCE_SESSION)
    _REFERENCE_READY = True


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip("\n") + "\n", encoding="utf-8")


def normalize_stream_url(base_url: str, stream_url: str) -> str:
    if stream_url.startswith("http://") or stream_url.startswith("https://"):
        return stream_url
    if not stream_url.startswith("/"):
        stream_url = "/" + stream_url
    return f"{base_url}{stream_url}"


def validate_sse_content_type(response: requests.Response) -> str:
    content_type = response.headers.get("Content-Type", "").strip()
    # requests joins duplicate Content-Type headers with a comma. Such a value
    # makes its charset parser interpret "utf-8, text/event-stream" as an
    # encoding name and masks the real server-side protocol bug.
    values = [value.strip() for value in content_type.split(",") if value.strip()]
    if len(values) != 1:
        raise RuntimeError(f"invalid SSE Content-Type (expected one value): {content_type!r}")
    media_type = values[0].split(";", 1)[0].strip().lower()
    if media_type != "text/event-stream":
        raise RuntimeError(f"invalid SSE Content-Type: {content_type!r}")
    response.encoding = "utf-8"
    return content_type


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
                payload: Any = None
                if raw_data:
                    payload = json.loads(raw_data)
                name = event_name or "message"
                events.append({"event": name, "data": payload, "raw_data": raw_data})
                if name == "done":
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

    return events


def run_query_and_collect_events(
    sql: str,
    *,
    base_url: str,
    session: requests.Session,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    run_response = session.post(
        f"{base_url}/api/query/run",
        json={"host_id": "local", "sql": sql},
        timeout=TIMEOUT_SECONDS,
    )
    run_response.raise_for_status()
    run_payload = run_response.json()

    stream_url = normalize_stream_url(base_url, str(run_payload["stream_url"]))
    with session.get(
        stream_url,
        stream=True,
        timeout=(TIMEOUT_SECONDS, STREAM_TIMEOUT_SECONDS),
        headers={"Accept": "text/event-stream"},
    ) as stream_response:
        stream_response.raise_for_status()
        validate_sse_content_type(stream_response)
        events = parse_sse_events(stream_response)

    return run_payload, events


def redact_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "<redacted>" if key.lower() in {"cancel_token", "authorization", "password"} else redact_payload(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_payload(item) for item in value]
    return value


def summarize_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    counts = Counter(str(event.get("event") or "message") for event in events)
    done_event = next((event for event in reversed(events) if event.get("event") == "done"), None)
    done_payload = done_event.get("data") if isinstance(done_event, dict) and isinstance(done_event.get("data"), dict) else {}
    errors: list[dict[str, Any]] = []
    row_count = 0
    columns: list[Any] = []
    types: list[Any] = []
    original_types: list[Any] = []
    transport_modes: list[Any] = []
    first_row: list[Any] | None = None
    result_meta: dict[str, Any] = {}

    for event in events:
        name = event.get("event")
        payload = event.get("data")
        if name == "error":
            errors.append(payload if isinstance(payload, dict) else {"value": payload})
        elif name == "result_rows" and isinstance(payload, dict):
            rows = payload.get("rows")
            if isinstance(rows, list):
                row_count += len(rows)
                if first_row is None and rows and isinstance(rows[0], list):
                    first_row = rows[0]
        elif name == "result_meta" and isinstance(payload, dict):
            result_meta = payload
            if isinstance(payload.get("columns"), list):
                columns = payload["columns"]
            if isinstance(payload.get("types"), list):
                types = payload["types"]
            if isinstance(payload.get("original_types"), list):
                original_types = payload["original_types"]
            if isinstance(payload.get("transport_modes"), list):
                transport_modes = payload["transport_modes"]

    success = (
        counts.get("result_meta", 0) > 0
        and counts.get("result_rows", 0) > 0
        and counts.get("done", 0) == 1
        and done_payload.get("status") == "finished"
        and not errors
    )
    return {
        "success": success,
        "event_counts": dict(sorted(counts.items())),
        "done": done_payload,
        "errors": errors,
        "result_rows_parsed": row_count,
        "columns": columns,
        "types": types,
        "original_types": original_types,
        "transport_modes": transport_modes,
        "first_row": first_row,
        "result_meta": result_meta,
    }


def execute_case(
    sql: str,
    *,
    base_url: str,
    session: requests.Session,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    started = time.perf_counter()
    try:
        run_payload, events = run_query_and_collect_events(sql, base_url=base_url, session=session)
        return (
            {
                "transport_ok": True,
                "duration_ms": round((time.perf_counter() - started) * 1000.0, 3),
                "run_payload": redact_payload(run_payload),
                "outcome": summarize_events(events),
            },
            events,
        )
    except Exception as exc:
        return (
            {
                "transport_ok": False,
                "duration_ms": round((time.perf_counter() - started) * 1000.0, 3),
                "exception": repr(exc),
                "outcome": {"success": False},
            },
            [],
        )


def terminal_signature(result: dict[str, Any]) -> tuple[Any, ...]:
    outcome = result.get("outcome") if isinstance(result.get("outcome"), dict) else {}
    done = outcome.get("done") if isinstance(outcome.get("done"), dict) else {}
    errors = outcome.get("errors") if isinstance(outcome.get("errors"), list) else []
    normalized_errors = []
    for error in errors:
        if isinstance(error, dict):
            normalized_errors.append((error.get("error_code"), error.get("message")))
        else:
            normalized_errors.append(repr(error))
    return result.get("transport_ok"), done.get("status"), tuple(normalized_errors)


def classify_failure(source: dict[str, Any], reference: dict[str, Any] | None) -> str:
    if not source.get("transport_ok"):
        return "test_infrastructure_or_transport_error"
    if reference is None:
        return "clickhouse_dash_source_failure"
    if not reference.get("transport_ok"):
        return "reference_transport_error"
    if bool((reference.get("outcome") or {}).get("success")):
        return "source_regression_vs_release"
    if terminal_signature(source) == terminal_signature(reference):
        return "shared_product_or_clickhouse_limitation"
    return "source_and_release_fail_differently"


def write_failure_artifacts(
    case_name: str,
    sql: str,
    source_events: list[dict[str, Any]],
    reference_events: list[dict[str, Any]],
) -> dict[str, str]:
    FAIL_DIR.mkdir(parents=True, exist_ok=True)
    stem = safe_name(case_name)
    sql_path = FAIL_DIR / f"{stem}.sql"
    source_path = FAIL_DIR / f"{stem}.source.events.json"
    write_text(sql_path, sql)
    source_path.write_text(json.dumps(source_events, ensure_ascii=False, indent=2), encoding="utf-8")
    paths = {"sql": str(sql_path), "source_events": str(source_path)}
    if reference_events:
        reference_path = FAIL_DIR / f"{stem}.reference.events.json"
        reference_path.write_text(json.dumps(reference_events, ensure_ascii=False, indent=2), encoding="utf-8")
        paths["reference_events"] = str(reference_path)
    return paths


def flush_results() -> None:
    items = [CASE_RESULTS[name] for name, _sql in EDGE_CASES if name in CASE_RESULTS]
    classifications = Counter(str(item.get("classification") or "passed") for item in items)
    payload = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "source_base_url": BASE_URL,
        "reference_base_url": REFERENCE_BASE_URL or None,
        "summary": {
            "total_expected": len(EDGE_CASES),
            "completed": len(items),
            "passed": sum(1 for item in items if item.get("status") == "passed"),
            "failed": sum(1 for item in items if item.get("status") == "failed"),
            "source_regressions_vs_release": classifications.get("source_regression_vs_release", 0),
            "test_infrastructure_errors": classifications.get("test_infrastructure_or_transport_error", 0)
            + classifications.get("reference_transport_error", 0),
            "classifications": dict(sorted(classifications.items())),
        },
        "cases": items,
    }
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = RESULTS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, RESULTS_PATH)


def concise_result(result: dict[str, Any] | None) -> str:
    if result is None:
        return "not configured"
    if not result.get("transport_ok"):
        return f"transport_error={result.get('exception')!r}"
    outcome = result.get("outcome") if isinstance(result.get("outcome"), dict) else {}
    done = outcome.get("done") if isinstance(outcome.get("done"), dict) else {}
    errors = outcome.get("errors") if isinstance(outcome.get("errors"), list) else []
    messages = []
    for error in errors:
        if isinstance(error, dict):
            messages.append(str(error.get("message") or error.get("error_code") or error))
        else:
            messages.append(str(error))
    return (
        f"status={done.get('status')!r}, success={bool(outcome.get('success'))}, "
        f"rows={outcome.get('result_rows_parsed')}, events={outcome.get('event_counts')}, "
        f"errors={messages}, duration_ms={result.get('duration_ms')}"
    )


def assert_query_stream_ok(case_name: str, sql: str) -> None:
    source, source_events = execute_case(sql, base_url=BASE_URL, session=SESSION)
    source_success = bool((source.get("outcome") or {}).get("success"))
    if source_success:
        CASE_RESULTS[case_name] = {
            "case_name": case_name,
            "status": "passed",
            "classification": "passed",
            "sql": sql,
            "source": source,
        }
        flush_results()
        return

    reference: dict[str, Any] | None = None
    reference_events: list[dict[str, Any]] = []
    if REFERENCE_BASE_URL and REFERENCE_BASE_URL != BASE_URL:
        try:
            ensure_reference_ready()
            reference, reference_events = execute_case(
                sql,
                base_url=REFERENCE_BASE_URL,
                session=REFERENCE_SESSION,
            )
        except Exception as exc:
            reference = {
                "transport_ok": False,
                "exception": repr(exc),
                "outcome": {"success": False},
            }

    classification = classify_failure(source, reference)
    artifacts = write_failure_artifacts(case_name, sql, source_events, reference_events)
    CASE_RESULTS[case_name] = {
        "case_name": case_name,
        "status": "failed",
        "classification": classification,
        "sql": sql,
        "source": source,
        "reference": reference,
        "artifacts": artifacts,
    }
    flush_results()

    explanations = {
        "source_regression_vs_release": (
            "The POST/SSE harness works and the reference release succeeds, so the failure belongs "
            "to the source binary under test."
        ),
        "clickhouse_dash_source_failure": (
            "The POST/SSE harness works, but no reference release is configured."
        ),
        "shared_product_or_clickhouse_limitation": (
            "The source and release fail in the same way; verify ClickHouse/version compatibility."
        ),
        "source_and_release_fail_differently": (
            "The source and release fail differently; both event traces are attached."
        ),
        "reference_transport_error": (
            "The source failed and the reference release could not be queried."
        ),
        "test_infrastructure_or_transport_error": (
            "The harness could not complete the source HTTP/SSE cycle."
        ),
    }
    message = [
        f"query stream failure: {case_name}",
        f"classification: {classification}",
        explanations.get(classification, ""),
        f"sql: {artifacts['sql']}",
        f"source events: {artifacts['source_events']}",
        f"manifest: {RESULTS_PATH}",
        "source: " + concise_result(source),
    ]
    if reference is not None:
        if artifacts.get("reference_events"):
            message.append(f"reference events: {artifacts['reference_events']}")
        message.append("reference: " + concise_result(reference))
    pytest.fail("\n".join(part for part in message if part), pytrace=False)


@pytest.mark.parametrize(
    ("case_name", "sql"),
    [pytest.param(case_name, sql, id=case_name) for case_name, sql in EDGE_CASES],
)
def test_query_stream_supports_native_edge_types(case_name: str, sql: str) -> None:
    assert_query_stream_ok(case_name, sql)


@pytest.mark.parametrize(
    ("case_name", "sql", "original_fragment", "transport_mode"),
    [
        pytest.param(
            "json_transport",
            'SELECT CAST(\'{"a":1,"nested":{"ok":true}}\' AS JSON) AS payload_transport',
            "JSON",
            "stringify",
            id="json",
        ),
        pytest.param(
            "uint256_transport",
            "SELECT toUInt256('123456789012345678901234567890') AS amount_transport",
            "UInt256",
            "stringify",
            id="uint256",
        ),
        pytest.param(
            "aggregate_state_transport",
            "SELECT argMaxState(toLowCardinality('binance'), toUInt64(1)) AS state_transport",
            "AggregateFunction",
            "opaque",
            id="aggregate_function",
        ),
    ],
)
def test_compat_transport_metadata_and_values(
    case_name: str,
    sql: str,
    original_fragment: str,
    transport_mode: str,
) -> None:
    result, _events = execute_case(sql, base_url=BASE_URL, session=SESSION)
    outcome = result.get("outcome") or {}
    assert outcome.get("success"), f"{case_name}: {concise_result(result)}"
    assert outcome.get("types") == ["String"]
    assert original_fragment in str((outcome.get("original_types") or [""])[0])
    assert outcome.get("transport_modes") == [transport_mode]
    first_row = outcome.get("first_row")
    assert isinstance(first_row, list) and len(first_row) == 1
    assert isinstance(first_row[0], str)
    if case_name == "json_transport":
        assert json.loads(first_row[0]) == {"a": 1, "nested": {"ok": True}}


def test_compat_describe_plan_is_cached() -> None:
    alias = f"payload_cache_{time.time_ns()}"
    sql = f"SELECT CAST('{{\"cache\":true}}' AS JSON) AS {alias}"
    first, _ = execute_case(sql, base_url=BASE_URL, session=SESSION)
    second, _ = execute_case(sql, base_url=BASE_URL, session=SESSION)
    assert (first.get("outcome") or {}).get("success"), concise_result(first)
    assert (second.get("outcome") or {}).get("success"), concise_result(second)
    first_meta = (first.get("outcome") or {}).get("result_meta") or {}
    second_meta = (second.get("outcome") or {}).get("result_meta") or {}
    assert first_meta.get("used_transport_wrapper") is True
    assert second_meta.get("used_transport_wrapper") is True
    assert second_meta.get("describe_cache_hit") is True


def test_query_classification_ignores_leading_comments() -> None:
    sql = "/* editor header */\n-- keep this comment\nSELECT 1 AS value"
    result, _events = execute_case(sql, base_url=BASE_URL, session=SESSION)
    outcome = result.get("outcome") or {}
    assert outcome.get("success"), concise_result(result)
    assert outcome.get("first_row") == [1]
    meta = outcome.get("result_meta") or {}
    assert meta.get("describe_mode") == "fast"



def result_rows_from_events(events: list[dict[str, Any]]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for event in events:
        if event.get("event") != "result_rows":
            continue
        payload = event.get("data")
        if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
            continue
        rows.extend(row for row in payload["rows"] if isinstance(row, list))
    return rows


def test_non_finite_float_is_serialized_as_json_null() -> None:
    sql = (
        "SELECT number % (number / 2) AS value, count() AS count "
        "FROM numbers(10) GROUP BY ALL ORDER BY isNaN(value), value"
    )
    result, events = execute_case(sql, base_url=BASE_URL, session=SESSION)
    outcome = result.get("outcome") or {}
    assert outcome.get("success"), concise_result(result)
    assert result_rows_from_events(events) == [[0.0, 9], [None, 1]]


def test_native_telemetry_keeps_original_metrics_without_threads() -> None:
    result, events = execute_case(
        "SELECT sum(cityHash64(number)) AS checksum FROM numbers(1000000)",
        base_url=BASE_URL,
        session=SESSION,
    )
    outcome = result.get("outcome") or {}
    assert outcome.get("success"), concise_result(result)

    meta = next(
        (event.get("data") for event in events if event.get("event") == "meta"),
        None,
    )
    assert isinstance(meta, dict)
    assert meta.get("status") == "connected"
    assert "telemetry" not in meta

    ticks = [
        event.get("data")
        for event in events
        if event.get("event") == "tick" and isinstance(event.get("data"), list)
    ]
    assert ticks, "expected at least one telemetry tick"

    for tick in ticks:
        assert len(tick) >= 15
        assert isinstance(tick[0], int)  # elapsed milliseconds
        assert isinstance(tick[1], int)  # read progress in centi-percent
        assert tick[2] in (0, 1)
        assert isinstance(tick[3], int)  # read rows
        assert isinstance(tick[4], int)  # read bytes
        assert isinstance(tick[5], int)  # total rows to read
        assert isinstance(tick[6], int)  # rows per second
        assert isinstance(tick[7], int)  # bytes per second
        assert tick[8] is None or isinstance(tick[8], int)  # CPU centi-percent
        assert tick[9] is None or isinstance(tick[9], int)  # maximum CPU centi-percent
        assert tick[10] is None or isinstance(tick[10], int)  # current memory
        assert tick[11] is None or isinstance(tick[11], int)  # peak memory

        # Reserved legacy positions must remain null. ClickHouse does not expose
        # a deterministic live active-thread count through these packets.
        assert tick[12] is None
        assert tick[13] is None

        samples = tick[14]
        assert samples is None or all(
            isinstance(sample, list) and len(sample) == 5
            for sample in samples
        )

    done = next(
        (event.get("data") for event in reversed(events) if event.get("event") == "done"),
        None,
    )
    assert isinstance(done, dict)
    assert done.get("status") == "finished"
    assert "telemetry" not in done
