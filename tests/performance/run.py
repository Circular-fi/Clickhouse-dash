#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
RUNS = max(1, int(os.environ.get("PERF_RUNS", "5")))
WARMUP = max(0, int(os.environ.get("PERF_WARMUP", "1")))
ARTIFACTS = Path(os.environ.get("PERF_ARTIFACTS_DIR", "/artifacts/test-run/performance"))
CASES_PATH = Path("/tests/performance/cases.json")
EXPECTED_PATH = Path("/tests/performance/expected.json")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-performance/1"})


def parse_events(response: requests.Response) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    events: list[dict[str, Any]] = []
    name = "message"
    data: list[str] = []
    done: dict[str, Any] = {}
    for raw in response.iter_lines(decode_unicode=True):
        line = raw or ""
        if line == "":
            if data or name != "message":
                payload: Any = None
                raw_data = "\n".join(data)
                if raw_data:
                    payload = json.loads(raw_data)
                event = {"event": name, "data": payload}
                events.append(event)
                if name == "done" and isinstance(payload, dict):
                    done = payload
                    break
                if name == "error":
                    break
            name, data = "message", []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    return events, done


def run_sql(sql: str, host_id: str) -> dict[str, Any]:
    start = time.perf_counter()
    r = SESSION.post(f"{BASE_URL}/api/query/run", json={"host_id": host_id, "sql": sql}, timeout=15)
    r.raise_for_status()
    handshake = r.json()
    stream_url = urljoin(BASE_URL + "/", str(handshake["stream_url"]))
    with SESSION.get(stream_url, stream=True, timeout=(10, 180), headers={"Accept": "text/event-stream"}) as stream:
        stream.raise_for_status()
        events, done = parse_events(stream)
    elapsed_ms = (time.perf_counter() - start) * 1000.0
    errors = [e for e in events if e.get("event") == "error"]
    if errors or done.get("status") != "finished":
        raise RuntimeError(f"query failed: errors={errors!r} done={done!r} sql={sql!r}")
    return {
        "elapsed_ms": elapsed_ms,
        "session_elapsed_seconds": done.get("elapsed_seconds"),
        "query_id": handshake.get("query_id"),
    }


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return ordered[idx]


def compare_expected(actual: dict[str, Any], expected: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if not expected:
        return failures
    cases = expected.get("cases") if isinstance(expected, dict) else None
    if not isinstance(cases, dict):
        return ["expected.json must contain an object named 'cases' when a baseline is configured"]
    by_name = {row["name"]: row for row in actual.get("cases", []) if isinstance(row, dict) and row.get("name")}
    for name, limits in cases.items():
        if name not in by_name:
            failures.append(f"missing measured case: {name}")
            continue
        if not isinstance(limits, dict):
            failures.append(f"invalid expected limits for {name}")
            continue
        row = by_name[name]
        for metric, limit in limits.items():
            if not metric.endswith("_max"):
                failures.append(f"unsupported expected metric {name}.{metric}; use *_max")
                continue
            actual_metric = metric[:-4]
            value = row.get(actual_metric)
            if not isinstance(value, (int, float)) or not isinstance(limit, (int, float)):
                failures.append(f"invalid numeric comparison for {name}.{metric}")
                continue
            if float(value) > float(limit):
                failures.append(f"{name}.{actual_metric}={value:.3f} exceeds max={float(limit):.3f}")
    return failures


def main() -> int:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    config = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    expected = json.loads(EXPECTED_PATH.read_text(encoding="utf-8") or "{}")
    host_id = str(config.get("host_id") or "local")

    # Shared database setup is deliberately outside measured intervals.
    run_sql("CREATE DATABASE IF NOT EXISTS chdash_perf", host_id)

    rows: list[dict[str, Any]] = []
    for case in config.get("cases", []):
        name = str(case["name"])
        sql = str(case["sql"])
        before_each = [str(x) for x in case.get("before_each", [])]
        samples: list[float] = []
        all_runs: list[dict[str, Any]] = []
        for index in range(WARMUP + RUNS):
            for setup_sql in before_each:
                run_sql(setup_sql, host_id)
            result = run_sql(sql, host_id)
            result["warmup"] = index < WARMUP
            all_runs.append(result)
            if index >= WARMUP:
                samples.append(float(result["elapsed_ms"]))
        row = {
            "name": name,
            "sql": sql,
            "runs": RUNS,
            "warmup": WARMUP,
            "min_ms": round(min(samples), 3),
            "median_ms": round(statistics.median(samples), 3),
            "p95_ms": round(percentile(samples, 0.95), 3),
            "max_ms": round(max(samples), 3),
            "samples": [round(x, 3) for x in samples],
            "raw_runs": all_runs,
        }
        rows.append(row)
        print(f"[perf] {name}: median={row['median_ms']:.3f}ms p95={row['p95_ms']:.3f}ms")

    actual = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "expected_baseline_configured": bool(expected),
        "cases": rows,
    }
    failures = compare_expected(actual, expected)
    actual["failures"] = failures
    actual["success"] = not failures
    (ARTIFACTS / "actual.json").write_text(json.dumps(actual, indent=2, sort_keys=True), encoding="utf-8")
    (ARTIFACTS / "expected.json").write_text(json.dumps(expected, indent=2, sort_keys=True), encoding="utf-8")
    (ARTIFACTS / "cases.json").write_text(json.dumps(config, indent=2, sort_keys=True), encoding="utf-8")
    lines = ["# Performance", "", f"Expected baseline configured: **{'yes' if expected else 'no'}**", "", "| Case | Median ms | p95 ms | Max ms |", "|---|---:|---:|---:|"]
    for row in rows:
        lines.append(f"| {row['name']} | {row['median_ms']:.3f} | {row['p95_ms']:.3f} | {row['max_ms']:.3f} |")
    if failures:
        lines += ["", "## Failures", ""] + [f"- {x}" for x in failures]
    elif not expected:
        lines += ["", "No performance gate is active yet because `tests/performance/expected.json` is intentionally empty."]
    (ARTIFACTS / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
