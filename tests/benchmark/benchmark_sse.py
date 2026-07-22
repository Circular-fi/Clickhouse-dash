#!/usr/bin/env python3
"""Benchmark chdash source/release SSE streams and a direct ClickHouse HTTP floor.

The dashboard targets are validated event-by-event, including row hashes, column
types, done payloads and raw SSE byte counts.  A separate direct HTTP target runs
the same SELECT queries with JSONCompactEachRowWithNamesAndTypes.  It is not an
SSE compatibility target: it provides the lowest application-free HTTP timing
and a semantic result reference for rows and types.
"""

from __future__ import annotations

import argparse
import codecs
import csv
import gzip
import hashlib
import json
import math
import os
import re
import statistics
import sys
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse, urlunparse

import requests


@dataclass(frozen=True)
class Target:
    name: str
    base_url: str


@dataclass(frozen=True)
class DirectHttpEndpoint:
    host_id: str
    url: str
    username: str
    password: str

    def public_dict(self) -> dict[str, str]:
        return {
            "host_id": self.host_id,
            "target": "http_direct",
            "url": self.url,
        }


def env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def env_int(name: str, default: int) -> int:
    try:
        return int(env(name, str(default)))
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(env(name, str(default)))
    except ValueError:
        return default


def env_bool(name: str, default: bool = False) -> bool:
    value = env(name, "1" if default else "0").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


TRACE_GZIP_LEVEL = max(0, min(9, env_int("BENCH_TRACE_COMPRESSION_LEVEL", 3)))

TELEMETRY_SCHEMA_CURRENT = "legacy_array"
TELEMETRY_V2_SAMPLE_WIDTH = 7
TELEMETRY_V3_SAMPLE_WIDTH = 6
TELEMETRY_V2_PROFILE_FIELDS = {
    "cpu_percent_centi",
    "memory_bytes",
    "peak_memory_bytes",
    "cpu_wait_percent_centi",
    "io_wait_percent_centi",
    "temporary_data_bytes",
    "cpu_time_us",
    "cpu_wait_time_us",
    "io_wait_time_us",
}
TELEMETRY_V3_PROFILE_FIELDS = {
    "cpu_percent_centi",
    "memory_bytes",
    "peak_memory_bytes",
    "io_wait_percent_centi",
    "temporary_data_bytes",
    "cpu_time_us",
    "user_time_us",
    "system_time_us",
    "io_wait_time_us",
}
TELEMETRY_V3_ACTIVITY_FIELDS = {
    "read_complete",
    "aggregation_observed",
    "arena_activity_observed",
    "external_aggregation_observed",
}


def now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime())


def safe_name(value: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return out.strip("._-") or "item"


def parse_targets(value: str) -> list[Target]:
    targets: list[Target] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"invalid target entry, expected name=url: {part}")
        name, url = part.split("=", 1)
        name = safe_name(name)
        url = url.rstrip("/")
        if not name or not url.startswith(("http://", "https://")):
            raise ValueError(f"invalid target entry: {part}")
        targets.append(Target(name=name, base_url=url))
    if len(targets) < 2:
        raise ValueError("at least two targets are required")
    return targets




def _url_without_userinfo(value: str) -> tuple[str, str | None, str | None]:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"invalid direct ClickHouse HTTP URL: {value}")
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = host
    if parsed.port is not None:
        netloc += f":{parsed.port}"
    clean = urlunparse((parsed.scheme, netloc, parsed.path or "/", parsed.params, parsed.query, parsed.fragment)).rstrip("/")
    username = unquote(parsed.username) if parsed.username is not None else None
    password = unquote(parsed.password) if parsed.password is not None else None
    return clean, username, password


def parse_direct_http_targets(value: str, default_user: str, default_password: str) -> dict[str, DirectHttpEndpoint]:
    endpoints: dict[str, DirectHttpEndpoint] = {}
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"invalid direct HTTP target, expected host_id=url: {part}")
        host_id_raw, url_raw = part.split("=", 1)
        host_id = safe_name(host_id_raw)
        clean_url, url_user, url_password = _url_without_userinfo(url_raw.strip())
        if host_id in endpoints:
            raise ValueError(f"duplicate direct HTTP host id: {host_id}")
        endpoints[host_id] = DirectHttpEndpoint(
            host_id=host_id,
            url=clean_url,
            username=url_user if url_user is not None else default_user,
            password=url_password if url_password is not None else default_password,
        )
    return endpoints


def strip_hcl_comments(text: str) -> str:
    # This is intentionally lightweight, but it is enough for the benchmark
    # config files. Without this, a commented example such as
    # `# name = "active"` is accidentally treated as a real host.
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    cleaned_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line
        # The benchmark HCL files do not contain URL-like strings outside quoted
        # values for host URIs. Strip comments only when the marker appears
        # before the first quote or when no quote is present.
        quote_pos = line.find('"')
        cut_positions = []
        for marker in ("#", "//"):
            pos = line.find(marker)
            if pos >= 0 and (quote_pos < 0 or pos < quote_pos):
                cut_positions.append(pos)
        if cut_positions:
            line = line[: min(cut_positions)]
        cleaned_lines.append(line)
    return "\n".join(cleaned_lines)


def parse_host_ids_from_hcl(path: Path) -> list[str]:
    if not path.is_file():
        return ["local"]
    text = strip_hcl_comments(path.read_text(encoding="utf-8", errors="replace"))
    names = re.findall(r"\bname\s*=\s*\"([^\"]+)\"", text)
    out: list[str] = []
    for name in names:
        if name not in out:
            out.append(name)
    return out or ["local"]


def parse_host_ids(value: str, hcl_path: Path) -> list[str]:
    if value.strip():
        return [safe_name(x) for x in re.split(r"[,\s]+", value.strip()) if x.strip()]
    return parse_host_ids_from_hcl(hcl_path)


def load_queries(path: Path) -> list[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        items = payload.get("queries")
    else:
        items = payload
    if not isinstance(items, list):
        raise ValueError(f"invalid queries file: {path}")

    queries: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError(f"query #{index + 1} must be an object")
        if item.get("enabled", True) is False:
            continue
        sql = item.get("sql")
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError(f"query #{index + 1} has no sql")
        q = dict(item)
        q["name"] = safe_name(str(q.get("name") or f"query_{index + 1}"))
        q["sql"] = sql
        q.setdefault("required_events", ["meta", "result_meta", "result_rows", "tick", "done"])
        q.setdefault("expected_status", "finished")
        queries.append(q)
    if not queries:
        raise ValueError(f"no enabled queries in {path}")
    return queries


def select_cases(queries: list[dict[str, Any]], names: list[str]) -> list[dict[str, Any]]:
    if not names:
        return queries
    wanted = {safe_name(n) for n in names}
    out = [q for q in queries if q["name"] in wanted]
    missing = sorted(wanted - {q["name"] for q in out})
    if missing:
        raise ValueError(f"unknown case(s): {', '.join(missing)}")
    return out


def wait_for_health(target: Target, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    url = f"{target.base_url}/api/health"
    last = "not checked"
    session = requests.Session()
    while time.monotonic() < deadline:
        try:
            response = session.get(url, timeout=2)
            if response.status_code == 200:
                try:
                    payload = response.json()
                except Exception:
                    payload = {}
                if payload.get("ok") is True:
                    return
                last = f"payload={payload or response.text[:200]}"
            else:
                last = f"status={response.status_code} body={response.text[:200]}"
        except requests.RequestException as exc:
            last = str(exc)
        time.sleep(0.25)
    raise RuntimeError(f"target {target.name} not healthy at {url}: {last}")


def fetch_available_hosts(target: Target, timeout_seconds: float = 5.0) -> list[str]:
    url = f"{target.base_url}/api/hosts"
    response = requests.get(url, timeout=timeout_seconds)
    response.raise_for_status()
    payload = response.json()
    hosts = payload.get("hosts") if isinstance(payload, dict) else []
    ids: list[str] = []
    if isinstance(hosts, list):
        for host in hosts:
            if isinstance(host, dict) and isinstance(host.get("id"), str):
                ids.append(host["id"])
    return ids


def validate_requested_hosts(targets: list[Target], host_ids: list[str]) -> dict[str, list[str]]:
    available_by_target: dict[str, list[str]] = {}
    errors: list[str] = []
    for target in targets:
        try:
            available = fetch_available_hosts(target)
        except Exception as exc:
            raise RuntimeError(f"cannot fetch hosts from target {target.name}: {exc!r}") from exc
        available_by_target[target.name] = available
        missing = [host_id for host_id in host_ids if host_id not in available]
        if missing:
            errors.append(
                f"target {target.name} does not expose host id(s) {', '.join(missing)}; "
                f"available: {', '.join(available) if available else '(none)'}"
            )
    if errors:
        hint = (
            "Requested host ids must exist in tests/config/CH_HOSTS.hcl for both dashboards. "
            "To test a remote active instance, add a real host { name = \"active\" ... } block to that file; "
            "setting BENCH_HOST_IDS=local,active alone is not enough."
        )
        raise RuntimeError("\n".join(errors + [hint]))
    return available_by_target




def wait_for_direct_http(endpoint: DirectHttpEndpoint, timeout_seconds: float, verify_tls: bool) -> None:
    deadline = time.monotonic() + timeout_seconds
    last = "not checked"
    session = requests.Session()
    session.headers.update({"Connection": "keep-alive", "Accept-Encoding": "identity"})
    while time.monotonic() < deadline:
        try:
            response = session.post(
                endpoint.url,
                data=b"SELECT 1 FORMAT TabSeparated",
                auth=(endpoint.username, endpoint.password) if endpoint.username else None,
                timeout=2,
                verify=verify_tls,
            )
            if response.status_code == 200 and response.text.strip() == "1":
                session.close()
                return
            last = f"status={response.status_code} body={response.text[:200]}"
        except requests.RequestException as exc:
            last = str(exc)
        time.sleep(0.25)
    session.close()
    raise RuntimeError(
        f"direct ClickHouse HTTP endpoint for host {endpoint.host_id} is not ready at {endpoint.url}: {last}"
    )


def direct_http_sql(query: dict[str, Any]) -> str:
    sql = str(query.get("direct_http_sql") or query["sql"]).strip()
    while sql.endswith(";"):
        sql = sql[:-1].rstrip()
    if re.search(r"\bFORMAT\s+[A-Za-z0-9_]+\s*$", sql, flags=re.I):
        raise ValueError(
            f"query {query['name']} already contains a FORMAT clause; set direct_http_sql without FORMAT"
        )
    return sql + "\nFORMAT JSONCompactEachRowWithNamesAndTypes"


def parse_clickhouse_summary(response: requests.Response) -> tuple[dict[str, Any], float | None]:
    raw = response.headers.get("X-ClickHouse-Summary", "").strip()
    if not raw:
        return {}, None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}, None
    elapsed_ms = None
    elapsed_ns = payload.get("elapsed_ns") if isinstance(payload, dict) else None
    try:
        if elapsed_ns is not None:
            elapsed_ms = float(elapsed_ns) / 1_000_000.0
    except (TypeError, ValueError):
        elapsed_ms = None
    return payload if isinstance(payload, dict) else {"value": payload}, elapsed_ms


def collect_direct_http(
    response: requests.Response,
    start_time: float,
    chunk_size: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Consume the ClickHouse HTTP body and separate transport from verification.

    ``time_to_done_ms`` is the point at which the complete response body has
    arrived. JSON decoding and canonical row hashing happen afterwards and are
    reported independently as ``verification_ms``. This keeps the HTTP reference
    a useful lower bound instead of charging Python's JSON/hash work to ClickHouse.
    """

    rows_hash = hashlib.sha256()
    trace: list[dict[str, Any]] = []
    body = bytearray()
    complete_lines_seen = 0
    aggregate: dict[str, Any] = {
        "transport": "clickhouse_http",
        "raw_stream_bytes": 0,
        "event_data_bytes": 0,
        "json_decode_errors": 0,
        "event_counts": {},
        "event_sequence": [],
        "event_sequence_hash": hashlib.sha256(b"").hexdigest(),
        "total_events": 0,
        "time_to_first_byte_ms": None,
        "time_to_first_event_ms": None,
        "time_to_result_meta_ms": None,
        "time_to_first_result_rows_ms": None,
        "time_to_done_ms": None,
        "verified_done_ms": None,
        "verification_ms": None,
        "columns": [],
        "types": [],
        "original_types": [],
        "transport_modes": [],
        "result_rows_total": 0,
        "result_row_events": 0,
        "tick_events": 0,
        "tick_samples_total": 0,
        "done_payload": None,
        "error_messages": [],
    }

    # Use one requests iterator only. Mixing ``response.raw.read`` and
    # ``response.raw.stream`` corrupts urllib3's chunk decoder for ClickHouse's
    # HTTP/1.1 chunked responses.
    for chunk in response.iter_content(chunk_size=max(1, int(chunk_size))):
        if not chunk:
            continue
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        if aggregate["time_to_first_byte_ms"] is None:
            aggregate["time_to_first_byte_ms"] = elapsed_ms

        body.extend(chunk)
        aggregate["raw_stream_bytes"] += len(chunk)
        aggregate["event_data_bytes"] += len(chunk)

        previous_lines = complete_lines_seen
        complete_lines_seen += chunk.count(b"\n")
        if previous_lines < 2 <= complete_lines_seen and aggregate["time_to_result_meta_ms"] is None:
            aggregate["time_to_result_meta_ms"] = elapsed_ms
            trace.append({"kind": "meta_arrived", "elapsed_ms": round(elapsed_ms, 3)})
        if previous_lines < 3 <= complete_lines_seen and aggregate["time_to_first_result_rows_ms"] is None:
            aggregate["time_to_first_result_rows_ms"] = elapsed_ms
            trace.append({"kind": "first_row_arrived", "elapsed_ms": round(elapsed_ms, 3)})

    transport_done = time.perf_counter()
    transport_done_ms = (transport_done - start_time) * 1000.0
    aggregate["time_to_done_ms"] = transport_done_ms

    verification_start = time.perf_counter()
    try:
        text = bytes(body).decode("utf-8")
    except UnicodeDecodeError as exc:
        aggregate["json_decode_errors"] += 1
        raise RuntimeError(f"invalid UTF-8 in ClickHouse direct response: {exc}") from exc

    raw_lines = text.splitlines()
    lines = [line[:-1] if line.endswith("\r") else line for line in raw_lines if line != ""]
    if len(lines) < 2:
        raise RuntimeError(
            f"ClickHouse direct response is incomplete: expected names and types, got {len(lines)} line(s)"
        )

    decoded: list[list[Any]] = []
    for line_index, raw_line in enumerate(lines, start=1):
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            aggregate["json_decode_errors"] += 1
            raise RuntimeError(
                f"invalid ClickHouse direct JSON line #{line_index}: {exc}: {raw_line[:500]}"
            ) from exc
        if not isinstance(payload, list):
            raise RuntimeError(f"unexpected ClickHouse direct row #{line_index}: expected JSON array")
        decoded.append(payload)

    aggregate["columns"] = decoded[0]
    aggregate["types"] = decoded[1]
    aggregate["original_types"] = decoded[1]
    aggregate["transport_modes"] = ["http_json" for _ in decoded[1]]

    for payload in decoded[2:]:
        aggregate["result_rows_total"] += 1
        canonical_hash_update(rows_hash, payload)

    verification_done = time.perf_counter()
    aggregate["verification_ms"] = (verification_done - verification_start) * 1000.0
    aggregate["verified_done_ms"] = (verification_done - start_time) * 1000.0
    aggregate["rows_hash"] = rows_hash.hexdigest()
    aggregate["done_payload"] = {
        "status": "finished",
        "result_rows_returned": aggregate["result_rows_total"],
        "result_truncated": False,
    }

    trace.append(
        {
            "kind": "transport_done",
            "elapsed_ms": round(transport_done_ms, 3),
            "raw_stream_bytes": aggregate["raw_stream_bytes"],
        }
    )
    trace.append(
        {
            "kind": "verified",
            "elapsed_ms": round(aggregate["verified_done_ms"], 3),
            "verification_ms": round(aggregate["verification_ms"], 3),
            "result_rows_returned": aggregate["result_rows_total"],
        }
    )
    return aggregate, trace


def sse_content_type_issues(content_type: str) -> list[str]:
    value = (content_type or "").strip()
    values = [item.strip() for item in value.split(",") if item.strip()]
    if len(values) != 1:
        return [f"invalid_sse_content_type_values:{value!r}"]
    media_type = values[0].split(";", 1)[0].strip().lower()
    if media_type != "text/event-stream":
        return [f"invalid_sse_content_type:{value!r}"]
    return []


def normalize_stream_url(base_url: str, stream_url: str) -> str:
    if not stream_url:
        raise ValueError("empty stream_url")
    if stream_url.startswith("/"):
        return base_url.rstrip("/") + stream_url
    parsed = urlparse(stream_url)
    if parsed.scheme and parsed.netloc:
        if parsed.hostname in {"127.0.0.1", "localhost", "0.0.0.0", "::1"}:
            base = urlparse(base_url)
            return urlunparse((base.scheme, base.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))
        return stream_url
    return base_url.rstrip("/") + "/" + stream_url.lstrip("/")


def canonicalize_hash_value(value: Any) -> Any:
    """Normalize JSON-equivalent values before cross-transport hashing.

    ClickHouse JSON formats may encode an integral Float64 as ``0`` while the
    native TCP serializer emits ``0.0``. Column types are compared separately,
    so these two JSON number spellings must not create a false row mismatch.
    """
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [canonicalize_hash_value(item) for item in value]
    if isinstance(value, tuple):
        return [canonicalize_hash_value(item) for item in value]
    if isinstance(value, dict):
        return {key: canonicalize_hash_value(item) for key, item in value.items()}
    return value


def canonical_hash_update(hasher: Any, value: Any) -> None:
    normalized = canonicalize_hash_value(value)
    data = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    hasher.update(data)
    hasher.update(b"\n")


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(math.ceil(len(ordered) * pct / 100.0)) - 1))
    return ordered[index]


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def rounded(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(float(value), digits)


def summarize_event(index: int, name: str, raw_data: str, payload: Any, json_ok: bool, elapsed_ms: float) -> dict[str, Any]:
    row: dict[str, Any] = {
        "index": index,
        "event": name,
        "elapsed_ms": round(elapsed_ms, 3),
        "data_bytes": len(raw_data.encode("utf-8")),
        "json_ok": json_ok,
    }
    if name == "result_rows" and isinstance(payload, dict):
        rows = payload.get("rows")
        row["row_count"] = len(rows) if isinstance(rows, list) else 0
    elif name == "result_meta" and isinstance(payload, dict):
        columns = payload.get("columns")
        types = payload.get("types")
        row["column_count"] = len(columns) if isinstance(columns, list) else 0
        row["type_count"] = len(types) if isinstance(types, list) else 0
        if payload.get("describe_mode") is not None:
            row["describe_mode"] = payload.get("describe_mode")
        if payload.get("used_transport_wrapper") is not None:
            row["used_transport_wrapper"] = payload.get("used_transport_wrapper")
    elif name == "done" and isinstance(payload, dict):
        for key in ["status", "result_rows_returned", "read_rows", "read_bytes", "result_truncated"]:
            if key in payload:
                row[key] = payload.get(key)
    elif name == "tick" and isinstance(payload, list):
        row["schema"] = "legacy_array"
        row["fields"] = len(payload)
        if len(payload) > 14 and isinstance(payload[14], list):
            row["samples"] = len(payload[14])
    elif name == "tick" and isinstance(payload, dict):
        row["schema"] = f"object_v{payload.get('schema_version')}"
        samples = payload.get("samples")
        if isinstance(samples, list):
            row["samples"] = len(samples)
        progress = payload.get("progress")
        profile = payload.get("profile")
        if isinstance(progress, dict):
            row["read_rows"] = progress.get("read_rows")
            row["read_bytes"] = progress.get("read_bytes")
        if isinstance(profile, dict):
            row["profile_fields"] = sorted(profile)
    elif name == "error" and isinstance(payload, dict):
        row["message"] = payload.get("message")
    return row


def collect_sse(response: requests.Response, start_time: float, chunk_size: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending = ""
    event_name: str | None = None
    data_lines: list[str] = []
    event_index = 0
    events_lite: list[dict[str, Any]] = []
    rows_hash = hashlib.sha256()

    aggregate: dict[str, Any] = {
        "raw_stream_bytes": 0,
        "event_data_bytes": 0,
        "json_decode_errors": 0,
        "event_counts": Counter(),
        "event_sequence": [],
        "time_to_first_byte_ms": None,
        "time_to_first_event_ms": None,
        "time_to_result_meta_ms": None,
        "time_to_first_result_rows_ms": None,
        "time_to_done_ms": None,
        "columns": [],
        "types": [],
        "original_types": [],
        "transport_modes": [],
        "result_rows_total": 0,
        "result_row_events": 0,
        "tick_events": 0,
        "tick_samples_total": 0,
        "tick_schema_versions": [],
        "telemetry_sources": [],
        "telemetry_thread_fields": [],
        "telemetry_scheduler_fields": [],
        "telemetry_shape_issues": [],
        "done_payload": None,
        "error_messages": [],
    }

    def emit() -> bool:
        nonlocal event_name, data_lines, event_index
        if event_name is None and not data_lines:
            return False
        name = event_name or "message"
        raw_data = "\n".join(data_lines)
        elapsed_ms = (time.perf_counter() - start_time) * 1000.0
        payload: Any = None
        json_ok = True
        if raw_data:
            try:
                payload = json.loads(raw_data)
            except json.JSONDecodeError:
                json_ok = False
        event_index += 1

        aggregate["event_counts"][name] += 1
        aggregate["event_sequence"].append(name)
        aggregate["event_data_bytes"] += len(raw_data.encode("utf-8"))
        if aggregate["time_to_first_event_ms"] is None:
            aggregate["time_to_first_event_ms"] = elapsed_ms
        if not json_ok:
            aggregate["json_decode_errors"] += 1

        if name == "meta" and isinstance(payload, dict):
            telemetry = payload.get("telemetry")
            if isinstance(telemetry, dict):
                version = telemetry.get("schema_version")
                source = telemetry.get("source")
                if version is not None:
                    aggregate["tick_schema_versions"].append(version)
                if source:
                    aggregate["telemetry_sources"].append(str(source))
                metrics = telemetry.get("metrics")
                if isinstance(metrics, list):
                    aggregate["telemetry_thread_fields"].extend(
                        sorted(str(metric) for metric in metrics if "thread" in str(metric).lower())
                    )
                    aggregate["telemetry_scheduler_fields"].extend(
                        sorted(str(metric) for metric in metrics if "scheduler" in str(metric).lower() or "cpu_wait" in str(metric).lower())
                    )
        elif name == "result_meta" and isinstance(payload, dict):
            if aggregate["time_to_result_meta_ms"] is None:
                aggregate["time_to_result_meta_ms"] = elapsed_ms
            for key in ["columns", "types", "original_types", "transport_modes"]:
                if isinstance(payload.get(key), list):
                    aggregate[key] = payload[key]
        elif name == "result_rows" and isinstance(payload, dict):
            if aggregate["time_to_first_result_rows_ms"] is None:
                aggregate["time_to_first_result_rows_ms"] = elapsed_ms
            rows = payload.get("rows")
            if isinstance(rows, list):
                aggregate["result_rows_total"] += len(rows)
                aggregate["result_row_events"] += 1
                for row in rows:
                    canonical_hash_update(rows_hash, row)
        elif name == "tick" and isinstance(payload, list):
            aggregate["tick_events"] += 1
            aggregate["tick_schema_versions"].append("legacy_array")
            if len(payload) < 15:
                aggregate["telemetry_shape_issues"].append(
                    f"legacy_tick_width:{len(payload)}:expected_at_least:15"
                )
            else:
                if payload[12] is not None or payload[13] is not None:
                    aggregate["telemetry_thread_fields"].append("legacy_thread_slots")
                samples = payload[14]
                if samples is not None and not isinstance(samples, list):
                    aggregate["telemetry_shape_issues"].append(
                        "legacy_tick_samples_not_array_or_null"
                    )
                elif isinstance(samples, list):
                    aggregate["tick_samples_total"] += len(samples)
                    for sample in samples:
                        # Source samples contain five values. Historical releases
                        # may append a sixth legacy thread value; comparison targets
                        # are allowed to differ without generating a global warning.
                        if not isinstance(sample, list) or len(sample) not in {5, 6}:
                            aggregate["telemetry_shape_issues"].append(
                                "legacy_tick_sample_width:"
                                f"{len(sample) if isinstance(sample, list) else 'not_array'}:"
                                "expected:5_or_6"
                            )
                            break
        elif name == "tick" and isinstance(payload, dict):
            aggregate["tick_events"] += 1
            schema_version = payload.get("schema_version")
            aggregate["tick_schema_versions"].append(schema_version)
            if schema_version not in {2, 3}:
                aggregate["telemetry_shape_issues"].append(f"unsupported_tick_schema:{schema_version!r}")
            for object_field in ("progress", "rates", "profile"):
                if not isinstance(payload.get(object_field), dict):
                    aggregate["telemetry_shape_issues"].append(f"tick_missing_object:{object_field}")

            samples = payload.get("samples")
            if samples is not None and not isinstance(samples, list):
                aggregate["telemetry_shape_issues"].append("tick_samples_not_array_or_null")
            elif isinstance(samples, list):
                aggregate["tick_samples_total"] += len(samples)
                expected_width = TELEMETRY_V3_SAMPLE_WIDTH if schema_version == 3 else TELEMETRY_V2_SAMPLE_WIDTH
                for sample in samples:
                    if not isinstance(sample, list) or len(sample) != expected_width:
                        aggregate["telemetry_shape_issues"].append(
                            f"tick_sample_width:{len(sample) if isinstance(sample, list) else 'not_array'}:expected:{expected_width}"
                        )
                        break

            profile = payload.get("profile")
            if isinstance(profile, dict):
                aggregate["telemetry_thread_fields"].extend(
                    sorted(key for key in profile if "thread" in str(key).lower())
                )
                aggregate["telemetry_scheduler_fields"].extend(
                    sorted(key for key in profile if "scheduler" in str(key).lower() or "cpu_wait" in str(key).lower())
                )
                required_profile_fields = (
                    TELEMETRY_V3_PROFILE_FIELDS if schema_version == 3 else TELEMETRY_V2_PROFILE_FIELDS
                )
                missing_profile_fields = sorted(required_profile_fields.difference(profile))
                if missing_profile_fields:
                    aggregate["telemetry_shape_issues"].append(
                        "tick_missing_profile_fields:" + ",".join(missing_profile_fields)
                    )
                for forbidden in ("peak_cpu_percent_centi", "peak_wait_percent_centi"):
                    if forbidden in profile:
                        aggregate["telemetry_shape_issues"].append(f"sampled_peak_field:{forbidden}")

            if schema_version == 3:
                progress = payload.get("progress")
                if isinstance(progress, dict) and progress.get("scope") != "read":
                    aggregate["telemetry_shape_issues"].append("tick_progress_scope_not_read")
                activity = payload.get("native_activity")
                if not isinstance(activity, dict):
                    aggregate["telemetry_shape_issues"].append("tick_missing_object:native_activity")
                else:
                    missing_activity = sorted(TELEMETRY_V3_ACTIVITY_FIELDS.difference(activity))
                    if missing_activity:
                        aggregate["telemetry_shape_issues"].append(
                            "tick_missing_activity_fields:" + ",".join(missing_activity)
                        )
                if not isinstance(payload.get("profile_events"), dict):
                    aggregate["telemetry_shape_issues"].append("tick_missing_object:profile_events")
                serialized = json.dumps(payload, sort_keys=True).lower()
                for forbidden in ("aggregation_percent", "overall_percent"):
                    if forbidden in serialized:
                        aggregate["telemetry_shape_issues"].append(f"fabricated_progress_field:{forbidden}")
        elif name == "done" and isinstance(payload, dict):
            if aggregate["time_to_done_ms"] is None:
                aggregate["time_to_done_ms"] = elapsed_ms
            aggregate["done_payload"] = payload
            telemetry = payload.get("telemetry")
            if telemetry is not None:
                if not isinstance(telemetry, dict):
                    aggregate["telemetry_shape_issues"].append("done_telemetry_not_object")
                else:
                    aggregate["telemetry_thread_fields"].extend(
                        sorted(key for key in telemetry if "thread" in str(key).lower())
                    )
                    aggregate["telemetry_scheduler_fields"].extend(
                        sorted(key for key in telemetry if "scheduler" in str(key).lower() or "cpu_wait" in str(key).lower())
                    )
                    if payload.get("status") == "finished" and telemetry.get("schema_version") not in {2, 3}:
                        aggregate["telemetry_shape_issues"].append("done_telemetry_schema_version")
        elif name == "error" and isinstance(payload, dict):
            aggregate["error_messages"].append(str(payload.get("message") or payload))

        events_lite.append(summarize_event(event_index, name, raw_data, payload, json_ok, elapsed_ms))
        event_name = None
        data_lines = []
        return name == "done"

    def line(line_text: str) -> bool:
        nonlocal event_name, data_lines
        if line_text.endswith("\r"):
            line_text = line_text[:-1]
        if line_text == "":
            return emit()
        if line_text.startswith(":"):
            return False
        if line_text.startswith("event:"):
            event_name = line_text[len("event:") :].strip()
        elif line_text.startswith("data:"):
            data = line_text[len("data:") :]
            if data.startswith(" "):
                data = data[1:]
            data_lines.append(data)
        return False

    done = False
    for chunk in response.iter_content(chunk_size=chunk_size):
        if not chunk:
            continue
        if aggregate["time_to_first_byte_ms"] is None:
            aggregate["time_to_first_byte_ms"] = (time.perf_counter() - start_time) * 1000.0
        aggregate["raw_stream_bytes"] += len(chunk)
        pending += decoder.decode(chunk)
        while True:
            pos = pending.find("\n")
            if pos < 0:
                break
            current = pending[:pos]
            pending = pending[pos + 1 :]
            if line(current):
                done = True
                break
        if done:
            break

    tail = decoder.decode(b"", final=True)
    if tail:
        pending += tail
    if not done and pending:
        done = line(pending)
    if not done and (event_name is not None or data_lines):
        emit()

    aggregate["rows_hash"] = rows_hash.hexdigest()
    aggregate["event_counts"] = dict(sorted(aggregate["event_counts"].items()))
    aggregate["event_sequence_hash"] = hashlib.sha256("\n".join(aggregate["event_sequence"]).encode("utf-8")).hexdigest()
    core_sequence: list[str] = []
    for event in aggregate["event_sequence"]:
        if event in {"tick", "keepalive", "message"}:
            continue
        if event == "result_rows" and core_sequence and core_sequence[-1] == "result_rows":
            continue
        core_sequence.append(event)
    aggregate["core_event_sequence"] = core_sequence
    aggregate["core_event_sequence_hash"] = hashlib.sha256(
        "\n".join(core_sequence).encode("utf-8")
    ).hexdigest()
    aggregate["tick_schema_versions"] = sorted(
        {str(value) for value in aggregate["tick_schema_versions"] if value is not None}
    )
    aggregate["telemetry_sources"] = sorted(set(aggregate["telemetry_sources"]))
    aggregate["telemetry_thread_fields"] = sorted(set(aggregate["telemetry_thread_fields"]))
    aggregate["telemetry_shape_issues"] = sorted(set(aggregate["telemetry_shape_issues"]))
    aggregate["total_events"] = sum(aggregate["event_counts"].values())
    return aggregate, events_lite


def write_events(path: Path, events: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Compact JSON and a moderate compression level keep diagnostic traces
    # complete without letting artifact generation distort benchmark timings.
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=TRACE_GZIP_LEVEL) as fh:
        json.dump(events, fh, ensure_ascii=False, separators=(",", ":"))


def run_once(
    target: Target,
    session: requests.Session,
    host_id: str,
    query: dict[str, Any],
    run_index: int,
    warmup: bool,
    artifacts_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    start = time.perf_counter()
    row: dict[str, Any] = {
        "target": target.name,
        "target_url": target.base_url,
        "transport": "dashboard_sse",
        "host_id": host_id,
        "query_name": query["name"],
        "run_index": run_index,
        "warmup": warmup,
        "sql": query["sql"],
        "exception": None,
    }
    try:
        response = session.post(
            f"{target.base_url}/api/query/run",
            json={"host_id": host_id, "sql": query["sql"]},
            timeout=args.request_timeout_seconds,
        )
        row["run_post_ms"] = (time.perf_counter() - start) * 1000.0
        row["run_status_code"] = response.status_code
        response.raise_for_status()
        payload = response.json()
        row["query_id"] = payload.get("query_id")
        row["stream_url"] = payload.get("stream_url")
        stream_url = normalize_stream_url(target.base_url, str(payload.get("stream_url") or ""))
        with session.get(
            stream_url,
            stream=True,
            timeout=(args.request_timeout_seconds, args.stream_timeout_seconds),
            headers={"Accept": "text/event-stream"},
        ) as stream:
            row["stream_status_code"] = stream.status_code
            row["stream_content_type"] = stream.headers.get("Content-Type", "")
            stream.raise_for_status()
            aggregate, events_lite = collect_sse(stream, start, args.stream_chunk_size)
        row.update(aggregate)
        run_key = "__".join(
            [safe_name(target.name), safe_name(host_id), safe_name(query["name"]), "warmup" if warmup else "run", str(run_index)]
        )
        events_path = artifacts_dir / "events" / f"{run_key}.events_lite.json.gz"
        write_events(events_path, events_lite)
        row["events_lite"] = str(events_path)
    except Exception as exc:
        row["exception"] = repr(exc)
        row.setdefault("event_counts", {})
        row.setdefault("total_events", 0)
        row.setdefault("result_rows_total", 0)
        row.setdefault("rows_hash", "")
        row.setdefault("columns", [])
        row.setdefault("types", [])
        row.setdefault("done_payload", None)
        row.setdefault("time_to_done_ms", None)
        row.setdefault("time_to_first_result_rows_ms", None)
    row["validation_issues"] = validate_run(query, row)
    return row




def run_direct_http_once(
    endpoint: DirectHttpEndpoint,
    session: requests.Session,
    query: dict[str, Any],
    run_index: int,
    warmup: bool,
    artifacts_dir: Path,
    args: argparse.Namespace,
) -> dict[str, Any]:
    start = time.perf_counter()
    query_id = f"chdash-bench-http-{uuid.uuid4()}"
    row: dict[str, Any] = {
        "target": "http_direct",
        "target_url": endpoint.url,
        "transport": "clickhouse_http",
        "host_id": endpoint.host_id,
        "query_name": query["name"],
        "run_index": run_index,
        "warmup": warmup,
        "sql": query["sql"],
        "query_id": query_id,
        "exception": None,
    }
    try:
        sql = direct_http_sql(query)
        with session.post(
            endpoint.url,
            params={
                "database": args.direct_http_database,
                "query_id": query_id,
                # chdash serializes Int64/UInt64 as JSON numbers. Keep the
                # direct reference semantically identical for row hashing.
                "output_format_json_quote_64bit_integers": "0",
            },
            data=sql.encode("utf-8"),
            auth=(endpoint.username, endpoint.password) if endpoint.username else None,
            stream=True,
            timeout=(args.request_timeout_seconds, args.stream_timeout_seconds),
            verify=args.direct_http_verify_tls,
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "identity",
                "Connection": "keep-alive",
                "Content-Type": "text/plain; charset=utf-8",
            },
        ) as response:
            row["run_post_ms"] = (time.perf_counter() - start) * 1000.0
            row["run_status_code"] = response.status_code
            row["stream_status_code"] = response.status_code
            if response.status_code != 200:
                body = response.text[:4000]
                raise requests.HTTPError(
                    f"ClickHouse direct HTTP {response.status_code}: {body}", response=response
                )
            aggregate, trace = collect_direct_http(response, start, args.direct_http_chunk_size)
            summary, server_elapsed_ms = parse_clickhouse_summary(response)
            aggregate["clickhouse_summary"] = summary
            aggregate["server_elapsed_ms"] = server_elapsed_ms
            aggregate["clickhouse_query_id"] = response.headers.get("X-ClickHouse-Query-Id") or query_id
            row.update(aggregate)
        run_key = "__".join(
            ["http_direct", safe_name(endpoint.host_id), safe_name(query["name"]), "warmup" if warmup else "run", str(run_index)]
        )
        trace_path = artifacts_dir / "http_direct" / f"{run_key}.trace.json.gz"
        write_events(trace_path, trace)
        row["events_lite"] = str(trace_path)
    except Exception as exc:
        row["exception"] = repr(exc)
        row.setdefault("event_counts", {})
        row.setdefault("total_events", 0)
        row.setdefault("result_rows_total", 0)
        row.setdefault("rows_hash", "")
        row.setdefault("columns", [])
        row.setdefault("types", [])
        row.setdefault("done_payload", None)
        row.setdefault("time_to_done_ms", None)
        row.setdefault("time_to_first_result_rows_ms", None)
        row.setdefault("server_elapsed_ms", None)
    row["validation_issues"] = validate_run(query, row)
    return row


def validate_run(query: dict[str, Any], row: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if row.get("exception"):
        return [f"exception:{row['exception']}"]

    is_direct_http = row.get("transport") == "clickhouse_http"
    if is_direct_http:
        if int(row.get("json_decode_errors") or 0) > 0:
            issues.append(f"json_decode_errors:{row.get('json_decode_errors')}")
        if not isinstance(row.get("columns"), list) or not isinstance(row.get("types"), list):
            issues.append("missing_http_meta")
        elif len(row.get("columns") or []) != len(row.get("types") or []):
            issues.append("http_columns_types_length_mismatch")
    counts = row.get("event_counts") or {}
    if not is_direct_http:
        issues.extend(sse_content_type_issues(str(row.get("stream_content_type") or "")))
        for event_name in query.get("required_events") or []:
            if int(counts.get(event_name, 0)) <= 0:
                issues.append(f"missing_event:{event_name}")
        if int(counts.get("done", 0)) != 1:
            issues.append(f"done_count:{counts.get('done', 0)}")
        if int(counts.get("error", 0)) > 0:
            issues.append("error_event_present")
        if int(row.get("json_decode_errors") or 0) > 0:
            issues.append(f"json_decode_errors:{row.get('json_decode_errors')}")

        if row.get("target") == "source":
            tick_schemas = {str(value) for value in (row.get("tick_schema_versions") or [])}
            if tick_schemas and str(TELEMETRY_SCHEMA_CURRENT) not in tick_schemas:
                issues.append(
                    f"source_tick_schema:{sorted(tick_schemas)!r}:"
                    f"expected:{TELEMETRY_SCHEMA_CURRENT!r}"
                )
            thread_fields = row.get("telemetry_thread_fields") or []
            if thread_fields:
                issues.append(f"nondeterministic_thread_fields:{thread_fields!r}")
            scheduler_fields = row.get("telemetry_scheduler_fields") or []
            if scheduler_fields:
                issues.append(f"unexpected_scheduler_wait_fields:{scheduler_fields!r}")
            for telemetry_issue in row.get("telemetry_shape_issues") or []:
                issues.append(f"telemetry_shape:{telemetry_issue}")

    done = row.get("done_payload") if isinstance(row.get("done_payload"), dict) else {}
    expected_status = query.get("expected_status")
    if expected_status and done.get("status") != expected_status:
        issues.append(f"done_status:{done.get('status')!r}:expected:{expected_status!r}")

    expected_rows = query.get("expected_rows")
    if expected_rows is not None:
        if int(row.get("result_rows_total") or 0) != int(expected_rows):
            issues.append(f"result_rows_total:{row.get('result_rows_total')}:expected:{expected_rows}")
    expected_min_rows = query.get("expected_min_rows")
    if expected_min_rows is not None:
        if int(row.get("result_rows_total") or 0) < int(expected_min_rows):
            issues.append(f"result_rows_total:{row.get('result_rows_total')}:min:{expected_min_rows}")

    returned = done.get("result_rows_returned")
    if returned is not None:
        try:
            if int(returned) != int(row.get("result_rows_total") or 0):
                issues.append(f"done_result_rows_returned:{returned}:parsed:{row.get('result_rows_total')}")
        except (TypeError, ValueError):
            issues.append(f"invalid_done_result_rows_returned:{returned!r}")
    if done.get("result_truncated") is True and query.get("allow_truncated") is not True:
        issues.append("unexpected_result_truncated")

    return issues


def finite(rows: list[dict[str, Any]], key: str) -> list[float]:
    out: list[float] = []
    for row in rows:
        value = row.get(key)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            out.append(float(value))
    return out


def signature(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def is_transport_warning(issue: str) -> bool:
    return issue.startswith("invalid_sse_content_type_values:")


def semantic_validation_issues(row: dict[str, Any]) -> list[str]:
    return [
        str(issue)
        for issue in (row.get("validation_issues") or [])
        if not is_transport_warning(str(issue))
    ]


def summarize_group(rows: list[dict[str, Any]]) -> dict[str, Any]:
    counts_by_event: dict[str, list[int]] = defaultdict(list)
    for row in rows:
        for event_name, count in (row.get("event_counts") or {}).items():
            counts_by_event[event_name].append(int(count))
    event_medians = {
        name: int(statistics.median(values))
        for name, values in sorted(counts_by_event.items())
    }
    issues = sorted({str(issue) for row in rows for issue in (row.get("validation_issues") or [])})
    done_status_counts = Counter(
        ((row.get("done_payload") or {}).get("status") if isinstance(row.get("done_payload"), dict) else None)
        for row in rows
    )
    row_hashes = sorted({str(row.get("rows_hash") or "") for row in rows if row.get("rows_hash")})
    result_row_counts = sorted({int(row.get("result_rows_total") or 0) for row in rows})
    col_sigs = sorted(
        {
            signature({"columns": row.get("columns") or [], "types": row.get("types") or []})
            for row in rows
        }
    )
    core_event_sequences = sorted({tuple(row.get("core_event_sequence") or []) for row in rows})
    tick_schemas = sorted({str(schema) for row in rows for schema in (row.get("tick_schema_versions") or [])})
    telemetry_sources = sorted(
        {str(source) for row in rows for source in (row.get("telemetry_sources") or []) if source}
    )
    return {
        "target": rows[0]["target"],
        "target_url": rows[0]["target_url"],
        "transport": rows[0].get("transport", "dashboard_sse"),
        "host_id": rows[0]["host_id"],
        "query_name": rows[0]["query_name"],
        "runs": len(rows),
        "failed_runs": sum(1 for row in rows if row.get("validation_issues")),
        "semantic_failed_runs": sum(1 for row in rows if semantic_validation_issues(row)),
        "transport_warning_runs": sum(
            1
            for row in rows
            if row.get("validation_issues") and not semantic_validation_issues(row)
        ),
        "median_done_ms": rounded(median(finite(rows, "time_to_done_ms"))),
        "p95_done_ms": rounded(percentile(finite(rows, "time_to_done_ms"), 95.0)),
        "median_verified_done_ms": rounded(median(finite(rows, "verified_done_ms"))),
        "median_verification_ms": rounded(median(finite(rows, "verification_ms"))),
        "median_first_byte_ms": rounded(median(finite(rows, "time_to_first_byte_ms"))),
        "median_first_event_ms": rounded(median(finite(rows, "time_to_first_event_ms"))),
        "median_result_meta_ms": rounded(median(finite(rows, "time_to_result_meta_ms"))),
        "median_first_row_ms": rounded(median(finite(rows, "time_to_first_result_rows_ms"))),
        "median_run_post_ms": rounded(median(finite(rows, "run_post_ms"))),
        "median_server_elapsed_ms": rounded(median(finite(rows, "server_elapsed_ms"))),
        "median_raw_stream_bytes": rounded(median(finite(rows, "raw_stream_bytes")), 0),
        "median_event_data_bytes": rounded(median(finite(rows, "event_data_bytes")), 0),
        "median_total_events": rounded(median(finite(rows, "total_events")), 0),
        "median_result_row_events": event_medians.get("result_rows", 0),
        "median_tick_events": event_medians.get("tick", 0),
        "event_count_medians": event_medians,
        "done_status_counts": dict(done_status_counts),
        "result_row_counts_seen": result_row_counts,
        "row_hashes_seen": row_hashes,
        "columns_signatures_seen": col_sigs,
        "core_event_sequences_seen": [list(sequence) for sequence in core_event_sequences],
        "tick_schemas_seen": tick_schemas,
        "telemetry_sources_seen": telemetry_sources,
        "validation_issues": issues,
    }

def build_summaries(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in results:
        if not row.get("warmup"):
            groups[(row["target"], row["host_id"], row["query_name"])].append(row)
    return [summarize_group(rows) for _, rows in sorted(groups.items())]


def compare_targets(
    summaries: list[dict[str, Any]],
    baseline_name: str,
    strict_event_counts: bool,
    optional_events: set[str],
) -> list[dict[str, Any]]:
    by_case: dict[tuple[str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for summary in summaries:
        if summary.get("transport") != "dashboard_sse":
            continue
        by_case[(summary["host_id"], summary["query_name"])][summary["target"]] = summary

    comparisons: list[dict[str, Any]] = []
    for (host_id, query_name), items in sorted(by_case.items()):
        if baseline_name not in items:
            continue
        baseline = items[baseline_name]
        for target_name, other in sorted(items.items()):
            if target_name == baseline_name:
                continue

            base_ms = baseline.get("median_done_ms")
            other_ms = other.get("median_done_ms")
            speedup = None
            if isinstance(base_ms, (int, float)) and isinstance(other_ms, (int, float)) and float(other_ms) > 0:
                speedup = round((float(other_ms) - float(base_ms)) / float(other_ms) * 100.0, 2)

            base_counts = baseline.get("event_count_medians") or {}
            other_counts = other.get("event_count_medians") or {}
            base_operational_counts = {k: v for k, v in base_counts.items() if k not in optional_events}
            other_operational_counts = {k: v for k, v in other_counts.items() if k not in optional_events}
            deterministic_events = {"meta", "result_meta", "done", "error"}
            base_deterministic_counts = {
                event: int(base_operational_counts.get(event, 0)) for event in deterministic_events
            }
            other_deterministic_counts = {
                event: int(other_operational_counts.get(event, 0)) for event in deterministic_events
            }

            baseline_failed = int(baseline.get("semantic_failed_runs") or 0)
            other_failed = int(other.get("semantic_failed_runs") or 0)
            if baseline_failed == 0 and other_failed == 0:
                correctness_classification = "equivalent"
            elif baseline_failed == 0 and other_failed > 0:
                correctness_classification = "baseline_correctness_improvement"
            elif baseline_failed > 0 and other_failed == 0:
                correctness_classification = "baseline_regression"
            else:
                correctness_classification = "both_failed"

            both_successful = correctness_classification == "equivalent"
            row_hash_match = both_successful and set(baseline.get("row_hashes_seen") or []) == set(
                other.get("row_hashes_seen") or []
            )
            columns_match = both_successful and set(baseline.get("columns_signatures_seen") or []) == set(
                other.get("columns_signatures_seen") or []
            )
            event_presence_match = both_successful and {
                key for key, value in base_operational_counts.items() if int(value) > 0
            } == {
                key for key, value in other_operational_counts.items() if int(value) > 0
            }
            event_count_match = both_successful and base_deterministic_counts == other_deterministic_counts
            raw_event_count_match = both_successful and base_operational_counts == other_operational_counts
            core_event_order_match = both_successful and set(
                tuple(sequence) for sequence in (baseline.get("core_event_sequences_seen") or [])
            ) == set(
                tuple(sequence) for sequence in (other.get("core_event_sequences_seen") or [])
            )
            result_batching_differs = both_successful and (
                baseline.get("median_result_row_events") != other.get("median_result_row_events")
            )
            tick_cadence_differs = both_successful and (
                baseline.get("median_tick_events") != other.get("median_tick_events")
            )
            baseline_tick_schemas = baseline.get("tick_schemas_seen") or []
            compared_tick_schemas = other.get("tick_schemas_seen") or []
            telemetry_schema_differs = baseline_tick_schemas != compared_tick_schemas

            comparisons.append(
                {
                    "host_id": host_id,
                    "query_name": query_name,
                    "baseline_target": baseline_name,
                    "compared_target": target_name,
                    "correctness_classification": correctness_classification,
                    "baseline_median_done_ms": base_ms,
                    "compared_median_done_ms": other_ms,
                    "speedup_pct_positive_means_baseline_faster": speedup,
                    "baseline_first_row_ms": baseline.get("median_first_row_ms"),
                    "compared_first_row_ms": other.get("median_first_row_ms"),
                    "baseline_total_events": baseline.get("median_total_events"),
                    "compared_total_events": other.get("median_total_events"),
                    "baseline_result_row_events": baseline.get("median_result_row_events"),
                    "compared_result_row_events": other.get("median_result_row_events"),
                    "baseline_tick_events": baseline.get("median_tick_events"),
                    "compared_tick_events": other.get("median_tick_events"),
                    "baseline_event_count_medians": base_counts,
                    "compared_event_count_medians": other_counts,
                    "baseline_operational_event_count_medians": base_operational_counts,
                    "compared_operational_event_count_medians": other_operational_counts,
                    # Backward-compatible aliases retained in machine-readable reports.
                    "baseline_semantic_event_count_medians": base_operational_counts,
                    "compared_semantic_event_count_medians": other_operational_counts,
                    "baseline_deterministic_event_count_medians": base_deterministic_counts,
                    "compared_deterministic_event_count_medians": other_deterministic_counts,
                    "ignored_optional_events": sorted(optional_events),
                    "event_count_match": event_count_match,
                    "raw_event_count_match": raw_event_count_match,
                    "event_presence_match": event_presence_match,
                    "core_event_order_match": core_event_order_match,
                    "result_batching_differs": result_batching_differs,
                    "tick_cadence_differs": tick_cadence_differs,
                    "baseline_tick_schemas": baseline_tick_schemas,
                    "compared_tick_schemas": compared_tick_schemas,
                    "baseline_telemetry_sources": baseline.get("telemetry_sources_seen") or [],
                    "compared_telemetry_sources": other.get("telemetry_sources_seen") or [],
                    "telemetry_schema_differs": telemetry_schema_differs,
                    "strict_event_counts": strict_event_counts,
                    "row_hash_match": row_hash_match,
                    "columns_match": columns_match,
                    "baseline_failed_runs": baseline.get("failed_runs"),
                    "compared_failed_runs": other.get("failed_runs"),
                    "baseline_semantic_failed_runs": baseline_failed,
                    "compared_semantic_failed_runs": other_failed,
                    "baseline_transport_warning_runs": baseline.get("transport_warning_runs", 0),
                    "compared_transport_warning_runs": other.get("transport_warning_runs", 0),
                }
            )
    return comparisons

def build_direct_http_overheads(summaries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_case: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for summary in summaries:
        by_case[(summary["host_id"], summary["query_name"])].append(summary)

    rows: list[dict[str, Any]] = []
    for (host_id, query_name), items in sorted(by_case.items()):
        direct = next((item for item in items if item.get("transport") == "clickhouse_http"), None)
        if direct is None:
            continue
        for dashboard in sorted(
            (item for item in items if item.get("transport") == "dashboard_sse"),
            key=lambda item: str(item.get("target")),
        ):
            dashboard_ms = dashboard.get("median_done_ms")
            direct_ms = direct.get("median_done_ms")
            overhead_ms = None
            overhead_pct = None
            ratio = None
            verified_overhead_ms = None
            verified_overhead_pct = None
            verified_ratio = None
            if (
                isinstance(dashboard_ms, (int, float))
                and isinstance(direct_ms, (int, float))
                and float(direct_ms) > 0
            ):
                overhead_ms = round(float(dashboard_ms) - float(direct_ms), 3)
                overhead_pct = round(overhead_ms / float(direct_ms) * 100.0, 2)
                ratio = round(float(dashboard_ms) / float(direct_ms), 3)
            direct_verified_ms = direct.get("median_verified_done_ms")
            if (
                isinstance(dashboard_ms, (int, float))
                and isinstance(direct_verified_ms, (int, float))
                and float(direct_verified_ms) > 0
            ):
                verified_overhead_ms = round(float(dashboard_ms) - float(direct_verified_ms), 3)
                verified_overhead_pct = round(
                    verified_overhead_ms / float(direct_verified_ms) * 100.0,
                    2,
                )
                verified_ratio = round(float(dashboard_ms) / float(direct_verified_ms), 3)

            dashboard_failed = int(dashboard.get("semantic_failed_runs") or 0)
            direct_failed = int(direct.get("semantic_failed_runs") or direct.get("failed_runs") or 0)
            both_successful = dashboard_failed == 0 and direct_failed == 0
            rows.append(
                {
                    "host_id": host_id,
                    "query_name": query_name,
                    "dashboard_target": dashboard.get("target"),
                    "dashboard_median_done_ms": dashboard_ms,
                    "direct_http_median_done_ms": direct_ms,
                    "direct_http_server_elapsed_ms": direct.get("median_server_elapsed_ms"),
                    "direct_http_verified_done_ms": direct.get("median_verified_done_ms"),
                    "direct_http_verification_ms": direct.get("median_verification_ms"),
                    "dashboard_first_byte_ms": dashboard.get("median_first_byte_ms"),
                    "direct_http_first_byte_ms": direct.get("median_first_byte_ms"),
                    "dashboard_first_row_ms": dashboard.get("median_first_row_ms"),
                    "direct_http_first_row_ms": direct.get("median_first_row_ms"),
                    "overhead_ms": overhead_ms,
                    "overhead_pct_vs_direct_http": overhead_pct,
                    "duration_ratio_vs_direct_http": ratio,
                    "verified_overhead_ms": verified_overhead_ms,
                    "verified_overhead_pct_vs_direct_http": verified_overhead_pct,
                    "duration_ratio_vs_verified_direct_http": verified_ratio,
                    "dashboard_raw_bytes": dashboard.get("median_raw_stream_bytes"),
                    "direct_http_raw_bytes": direct.get("median_raw_stream_bytes"),
                    "row_hash_match": both_successful
                    and set(dashboard.get("row_hashes_seen") or []) == set(direct.get("row_hashes_seen") or []),
                    "columns_match": both_successful
                    and set(dashboard.get("columns_signatures_seen") or [])
                    == set(direct.get("columns_signatures_seen") or []),
                    "dashboard_failed_runs": dashboard_failed,
                    "direct_http_failed_runs": direct_failed,
                    "dashboard_transport_warning_runs": dashboard.get("transport_warning_runs", 0),
                }
            )
    return rows

def scalar(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: scalar(row.get(field)) for field in fields})


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    def cell(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, float):
            return f"{value:.3f}".rstrip("0").rstrip(".")
        if isinstance(value, (dict, list)):
            return "`" + json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "`"
        return str(value).replace("|", "\\|").replace("\n", " ")

    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for row in rows:
        out.append("| " + " | ".join(cell(v) for v in row) + " |")
    return "\n".join(out)


def write_report(
    path: Path,
    targets: list[Target],
    direct_endpoints: dict[str, DirectHttpEndpoint],
    host_ids: list[str],
    queries: list[dict[str, Any]],
    summaries: list[dict[str, Any]],
    comparisons: list[dict[str, Any]],
    direct_http_overheads: list[dict[str, Any]],
    issues: list[str],
    warnings: list[str],
    args: argparse.Namespace,
) -> None:
    lines: list[str] = []
    lines.append("# chdash source-vs-release SSE benchmark")
    lines.append("")
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S %z')}")
    lines.append(f"Runs: {args.runs} measured + {args.warmup} warmup")
    lines.append(f"SSE baseline target: `{args.baseline}`")
    lines.append("")
    lines.append(
        "The direct ClickHouse HTTP result uses a persistent HTTP connection and "
        "`JSONCompactEachRowWithNamesAndTypes`. It is a latency floor, not an SSE "
        "compatibility target; event comparisons remain source vs release only."
    )
    lines.append("")
    lines.append(
        "SSE compatibility is split into deterministic control events and operational "
        "streaming events. `meta`, `result_meta`, `done`, and `error` have deterministic "
        "counts. `result_rows` depends on batch size, while `tick` depends on query duration "
        "and scheduling; their counts may differ without changing semantics."
    )
    lines.append("")
    lines.append("## Targets")
    lines.append("")
    target_rows = [[t.name, "dashboard_sse", "all", t.base_url] for t in targets]
    target_rows.extend(
        ["http_direct", "clickhouse_http", host_id, endpoint.url]
        for host_id, endpoint in sorted(direct_endpoints.items())
        if host_id in host_ids
    )
    lines.append(markdown_table(["target", "transport", "host", "url"], target_rows))
    lines.append("")
    lines.append("## Hosts and queries")
    lines.append("")
    lines.append(f"Hosts: `{', '.join(host_ids)}`")
    lines.append("")
    lines.append(
        markdown_table(
            ["query", "expected", "direct HTTP", "sql"],
            [
                [
                    q["name"],
                    q.get("expected_rows", q.get("expected_min_rows", "")),
                    "off" if q.get("direct_http_enabled") is False else "on",
                    q["sql"],
                ]
                for q in queries
            ],
        )
    )
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(
        markdown_table(
            [
                "target",
                "transport",
                "host",
                "query",
                "semantic failures",
                "transport warnings",
                "done ms",
                "p95 ms",
                "first byte ms",
                "first row ms",
                "events",
                "row events",
                "tick events",
                "telemetry schema",
            ],
            [
                [
                    s.get("target"),
                    s.get("transport"),
                    s.get("host_id"),
                    s.get("query_name"),
                    s.get("semantic_failed_runs"),
                    s.get("transport_warning_runs"),
                    s.get("median_done_ms"),
                    s.get("p95_done_ms"),
                    s.get("median_first_byte_ms"),
                    s.get("median_first_row_ms"),
                    s.get("median_total_events"),
                    s.get("median_result_row_events"),
                    s.get("median_tick_events"),
                    s.get("tick_schemas_seen"),
                ]
                for s in summaries
            ],
        )
    )
    lines.append("")
    lines.append("## Source vs release SSE comparisons")
    lines.append("")
    lines.append(
        markdown_table(
            [
                "host",
                "query",
                "classification",
                "baseline ms",
                "compared ms",
                "speedup %",
                "rows",
                "columns",
                "required events",
                "control counts",
                "core order",
                "result batching",
                "tick cadence",
                "schemas",
            ],
            [
                [
                    c.get("host_id"),
                    c.get("query_name"),
                    c.get("correctness_classification"),
                    c.get("baseline_median_done_ms"),
                    c.get("compared_median_done_ms"),
                    c.get("speedup_pct_positive_means_baseline_faster"),
                    "OK" if c.get("row_hash_match") else "DIFF",
                    "OK" if c.get("columns_match") else "DIFF",
                    "OK" if c.get("event_presence_match") else "DIFF",
                    "OK" if c.get("event_count_match") else "DIFF",
                    "OK" if c.get("core_event_order_match") else "DIFF",
                    "DIFFERENT (expected)" if c.get("result_batching_differs") else "same",
                    "DIFFERENT (expected)" if c.get("tick_cadence_differs") else "same",
                    f"{c.get('baseline_tick_schemas')} / {c.get('compared_tick_schemas')}",
                ]
                for c in comparisons
            ],
        )
    )
    lines.append("")
    lines.append("## Dashboard overhead above direct ClickHouse HTTP")
    lines.append("")
    if direct_http_overheads:
        lines.append(
            markdown_table(
                [
                    "host",
                    "query",
                    "dashboard",
                    "HTTP wire ms",
                    "HTTP verified ms",
                    "dashboard ms",
                    "wire overhead ms",
                    "wire ratio",
                    "verified delta ms",
                    "verified ratio",
                    "rows",
                    "columns",
                ],
                [
                    [
                        row.get("host_id"),
                        row.get("query_name"),
                        row.get("dashboard_target"),
                        row.get("direct_http_median_done_ms"),
                        row.get("direct_http_verified_done_ms"),
                        row.get("dashboard_median_done_ms"),
                        row.get("overhead_ms"),
                        row.get("duration_ratio_vs_direct_http"),
                        row.get("verified_overhead_ms"),
                        row.get("duration_ratio_vs_verified_direct_http"),
                        "OK" if row.get("row_hash_match") else "DIFF",
                        "OK" if row.get("columns_match") else "DIFF",
                    ]
                    for row in direct_http_overheads
                ],
            )
        )
    else:
        lines.append("No direct ClickHouse HTTP endpoint was configured for the selected host(s).")
    lines.append("")
    lines.append("## Warnings")
    lines.append("")
    if warnings:
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("No non-fatal warning detected.")
    lines.append("")
    lines.append("## Issues")
    lines.append("")
    if issues:
        lines.extend(f"- {issue}" for issue in issues)
    else:
        lines.append("No validation issue detected.")
    lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")

def compute_findings(
    results: list[dict[str, Any]],
    comparisons: list[dict[str, Any]],
    direct_http_overheads: list[dict[str, Any]],
    strict_event_counts: bool,
    baseline_name: str,
) -> tuple[list[str], list[str]]:
    issues: list[str] = []
    warnings: list[str] = []

    # Only the selected baseline is the product under test. Historical releases
    # and direct HTTP are references: their unsupported types, legacy headers,
    # telemetry cadence and batching remain visible in raw tables without
    # polluting the top-level warning count.
    for row in results:
        if row.get("warmup") or row.get("target") != baseline_name:
            continue
        if row.get("transport") != "dashboard_sse":
            continue
        prefix = (
            f"{row.get('target')} host={row.get('host_id')} "
            f"query={row.get('query_name')} run={row.get('run_index')}"
        )
        for issue in row.get("validation_issues") or []:
            issue_text = str(issue)
            if is_transport_warning(issue_text):
                warnings.append(f"{prefix}: {issue_text}")
            else:
                issues.append(f"{prefix}: {issue_text}")

    for comp in comparisons:
        prefix = (
            f"compare {comp.get('baseline_target')} vs {comp.get('compared_target')} "
            f"host={comp.get('host_id')} query={comp.get('query_name')}"
        )
        classification = comp.get("correctness_classification")
        if classification == "baseline_regression":
            issues.append(f"{prefix}: baseline failed while the comparison target succeeded")
            continue

        # A failing historical release is not an actionable source warning.
        if classification in {"baseline_correctness_improvement", "both_failed"}:
            continue

        if not comp.get("row_hash_match"):
            issues.append(f"{prefix}: result row hash mismatch")
        if not comp.get("columns_match"):
            issues.append(f"{prefix}: columns/types mismatch")
        if not comp.get("event_presence_match"):
            issues.append(f"{prefix}: required event presence mismatch")
        if not comp.get("event_count_match"):
            issues.append(f"{prefix}: deterministic control event count mismatch")
        if not comp.get("core_event_order_match"):
            issues.append(f"{prefix}: normalized core event order mismatch")
        if strict_event_counts and not comp.get("raw_event_count_match"):
            issues.append(f"{prefix}: strict operational event count mismatch")

        # result_rows, tick, keepalive and telemetry schema counts are operational
        # details. They intentionally do not create warnings when source and
        # release segment the same semantic result differently.

    for overhead in direct_http_overheads:
        if overhead.get("dashboard_target") != baseline_name:
            continue
        prefix = (
            f"compare {overhead.get('dashboard_target')} vs http_direct "
            f"host={overhead.get('host_id')} query={overhead.get('query_name')}"
        )
        dashboard_failed = int(overhead.get("dashboard_failed_runs") or 0)
        direct_failed = int(overhead.get("direct_http_failed_runs") or 0)
        if dashboard_failed or direct_failed:
            continue
        if not overhead.get("row_hash_match"):
            issues.append(f"{prefix}: result row hash mismatch")
        if not overhead.get("columns_match"):
            issues.append(f"{prefix}: columns/types mismatch")

    return sorted(set(issues)), sorted(set(warnings))

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    parser.add_argument(
        "--targets",
        default=env(
            "BENCH_TARGETS",
            "source=http://chdash_source:8080,release=http://chdash_release:8080",
        ),
        help="Comma separated dashboard target map: name=url,name=url",
    )
    parser.add_argument(
        "--baseline",
        default=env("BENCH_BASELINE", "source"),
        help="Dashboard target used as SSE performance baseline. Positive speedup means this target is faster.",
    )
    parser.add_argument(
        "--direct-http-targets",
        default=env("BENCH_CLICKHOUSE_HTTP_TARGETS", env("BENCH_DIRECT_HTTP_TARGETS", "local=http://clickhouse:8123")),
        help=(
            "Comma separated ClickHouse HTTP endpoints keyed by chdash host id. "
            "Credentials may be embedded in the URL or supplied by the direct HTTP user/password options."
        ),
    )
    parser.add_argument(
        "--direct-http-user",
        default=env("BENCH_CLICKHOUSE_HTTP_USER", env("BENCH_DIRECT_HTTP_USER", env("CLICKHOUSE_USER", "test"))),
    )
    parser.add_argument(
        "--direct-http-password",
        default=env("BENCH_CLICKHOUSE_HTTP_PASSWORD", env("BENCH_DIRECT_HTTP_PASSWORD", env("CLICKHOUSE_PASSWORD", "test"))),
    )
    parser.add_argument(
        "--direct-http-database",
        default=env("BENCH_CLICKHOUSE_HTTP_DATABASE", env("BENCH_DIRECT_HTTP_DATABASE", "default")),
    )
    parser.add_argument(
        "--direct-http-verify-tls",
        action=argparse.BooleanOptionalAction,
        default=env_bool("BENCH_CLICKHOUSE_HTTP_VERIFY_TLS", env_bool("BENCH_DIRECT_HTTP_VERIFY_TLS", True)),
        help="Verify TLS certificates for direct HTTPS ClickHouse endpoints.",
    )
    parser.add_argument(
        "--disable-direct-http",
        action="store_true",
        default=env_bool("BENCH_DISABLE_DIRECT_HTTP", False),
        help="Disable the direct ClickHouse HTTP floor.",
    )
    parser.add_argument(
        "--host-id",
        action="append",
        default=[],
        help="Host id to benchmark. May be repeated. Defaults to BENCH_HOST_IDS or CH_HOSTS file names.",
    )
    parser.add_argument(
        "--ch-hosts-file",
        default=env("BENCH_CH_HOSTS_FILE", "/tests/config/CH_HOSTS.hcl"),
        help="CH_HOSTS HCL file used to infer host ids.",
    )
    parser.add_argument(
        "--queries-file",
        default=env("BENCH_QUERIES_FILE", "/tests/benchmark/queries.json"),
        help="Benchmark queries JSON file.",
    )
    parser.add_argument("--case", action="append", default=[], help="Only run this query name. May be repeated.")
    parser.add_argument("--runs", type=int, default=env_int("BENCH_RUNS", 5), help="Measured runs per target/query/host.")
    parser.add_argument("--warmup", type=int, default=env_int("BENCH_WARMUP", 1), help="Warmup runs excluded from summaries.")
    parser.add_argument(
        "--artifacts-dir",
        default=env("BENCH_ARTIFACTS_DIR", "/artifacts/benchmark"),
        help="Artifact root directory.",
    )
    parser.add_argument(
        "--run-id",
        default=env("BENCH_RUN_ID", ""),
        help="Optional stable artifact directory name. Defaults to a timestamp.",
    )
    parser.add_argument(
        "--request-timeout-seconds",
        type=float,
        default=env_float("BENCH_REQUEST_TIMEOUT_SECONDS", 10.0),
    )
    parser.add_argument(
        "--stream-timeout-seconds",
        type=float,
        default=env_float("BENCH_STREAM_TIMEOUT_SECONDS", 180.0),
    )
    parser.add_argument(
        "--ready-timeout-seconds",
        type=float,
        default=env_float("BENCH_READY_TIMEOUT_SECONDS", 120.0),
    )
    parser.add_argument("--stream-chunk-size", type=int, default=env_int("BENCH_STREAM_CHUNK_SIZE", 8192))
    parser.add_argument(
        "--direct-http-chunk-size",
        type=int,
        default=env_int("BENCH_CLICKHOUSE_HTTP_CHUNK_SIZE", 65536),
    )
    parser.add_argument(
        "--strict-event-counts",
        action="store_true",
        default=env_bool("BENCH_STRICT_EVENT_COUNTS", False),
        help="Fail when semantic SSE event counts differ between dashboard targets.",
    )
    parser.add_argument(
        "--optional-events",
        default=env("BENCH_OPTIONAL_EVENTS", "keepalive,message"),
        help="SSE event names ignored for semantic event presence/count comparisons. Raw counts are still recorded.",
    )
    parser.add_argument(
        "--no-strict",
        action="store_true",
        default=env_bool("BENCH_NO_STRICT", False),
        help="Always exit 0 after writing artifacts.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    if args.runs <= 0:
        raise SystemExit("--runs must be > 0")
    if args.warmup < 0:
        raise SystemExit("--warmup must be >= 0")

    targets = parse_targets(args.targets)
    if args.baseline not in {t.name for t in targets}:
        raise SystemExit(f"baseline target not found: {args.baseline}")

    hcl_path = Path(args.ch_hosts_file)
    host_ids = args.host_id or parse_host_ids(env("BENCH_HOST_IDS", ""), hcl_path)
    queries = select_cases(load_queries(Path(args.queries_file)), args.case)
    direct_endpoints = (
        {}
        if args.disable_direct_http
        else parse_direct_http_targets(
            args.direct_http_targets,
            args.direct_http_user,
            args.direct_http_password,
        )
    )
    selected_direct_endpoints = {
        host_id: direct_endpoints[host_id]
        for host_id in host_ids
        if host_id in direct_endpoints
    }

    artifacts_root = Path(args.artifacts_dir)
    run_id = safe_name(args.run_id) if str(args.run_id).strip() else now_stamp()
    artifacts_dir = artifacts_root / run_id
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    print(f"artifacts: {artifacts_dir}", file=sys.stderr)
    print("dashboard targets: " + ", ".join(f"{t.name}={t.base_url}" for t in targets), file=sys.stderr)
    if selected_direct_endpoints:
        print(
            "direct HTTP: "
            + ", ".join(f"{host_id}={endpoint.url}" for host_id, endpoint in selected_direct_endpoints.items()),
            file=sys.stderr,
        )
    elif not args.disable_direct_http:
        print(
            "direct HTTP: no endpoint matches the selected host ids; configure BENCH_CLICKHOUSE_HTTP_TARGETS",
            file=sys.stderr,
        )
    else:
        print("direct HTTP: disabled", file=sys.stderr)
    print("hosts: " + ", ".join(host_ids), file=sys.stderr)
    print("queries: " + ", ".join(q["name"] for q in queries), file=sys.stderr)

    for target in targets:
        wait_for_health(target, args.ready_timeout_seconds)
    for endpoint in selected_direct_endpoints.values():
        wait_for_direct_http(endpoint, args.ready_timeout_seconds, args.direct_http_verify_tls)

    available_hosts = validate_requested_hosts(targets, host_ids)
    print(
        "available hosts: "
        + "; ".join(f"{name}=[{', '.join(ids)}]" for name, ids in available_hosts.items()),
        file=sys.stderr,
    )
    optional_events = {
        safe_name(x)
        for x in re.split(r"[,\s]+", args.optional_events.strip())
        if x.strip()
    }

    # Reuse dashboard connections across warmups and measured runs. Reopening a
    # socket for every query would benchmark HTTP/TCP handshakes rather than the
    # dashboard's query and SSE overhead.
    dashboard_sessions: dict[str, requests.Session] = {}
    for target in targets:
        session = requests.Session()
        session.headers.update({"User-Agent": "chdash-benchmark/1", "Accept-Encoding": "identity"})
        dashboard_sessions[target.name] = session

    direct_sessions: dict[str, requests.Session] = {}
    for host_id in selected_direct_endpoints:
        session = requests.Session()
        session.headers.update({"Connection": "keep-alive", "Accept-Encoding": "identity"})
        direct_sessions[host_id] = session

    total = 0
    for host_id in host_ids:
        for query in queries:
            allowed_hosts = query.get("host_ids")
            if isinstance(allowed_hosts, list) and host_id not in allowed_hosts:
                continue
            participant_count = len(targets)
            if host_id in selected_direct_endpoints and query.get("direct_http_enabled", True) is not False:
                participant_count += 1
            total += (args.warmup + args.runs) * participant_count

    results: list[dict[str, Any]] = []
    partial_path = artifacts_dir / "runs.partial.jsonl"
    partial_path.write_text("", encoding="utf-8")
    completed = 0
    try:
        for host_id in host_ids:
            for query in queries:
                allowed_hosts = query.get("host_ids")
                if isinstance(allowed_hosts, list) and host_id not in allowed_hosts:
                    continue
                participants: list[tuple[str, Any]] = [("dashboard", target) for target in targets]
                if host_id in selected_direct_endpoints and query.get("direct_http_enabled", True) is not False:
                    participants.append(("http_direct", selected_direct_endpoints[host_id]))

                for logical_run in range(args.warmup + args.runs):
                    warmup = logical_run < args.warmup
                    run_index = logical_run + 1 if warmup else logical_run - args.warmup + 1
                    offset = logical_run % len(participants)
                    ordered_participants = participants[offset:] + participants[:offset]
                    for participant_kind, participant in ordered_participants:
                        completed += 1
                        phase = "warmup" if warmup else "run"
                        target_name = participant.name if participant_kind == "dashboard" else "http_direct"
                        print(
                            f"[{completed}/{total}] {phase}#{run_index} target={target_name} "
                            f"host={host_id} query={query['name']}",
                            file=sys.stderr,
                        )
                        if participant_kind == "dashboard":
                            result = run_once(
                                participant,
                                dashboard_sessions[participant.name],
                                host_id,
                                query,
                                run_index,
                                warmup,
                                artifacts_dir,
                                args,
                            )
                        else:
                            result = run_direct_http_once(
                                participant,
                                direct_sessions[host_id],
                                query,
                                run_index,
                                warmup,
                                artifacts_dir,
                                args,
                            )
                        results.append(result)
                        append_jsonl(partial_path, result)
    finally:
        for session in dashboard_sessions.values():
            session.close()
        for session in direct_sessions.values():
            session.close()

    summaries = build_summaries(results)
    comparisons = compare_targets(summaries, args.baseline, args.strict_event_counts, optional_events)
    direct_http_overheads = build_direct_http_overheads(summaries)
    issues, warnings = compute_findings(
        results,
        comparisons,
        direct_http_overheads,
        args.strict_event_counts,
        args.baseline,
    )

    # ``runs.partial.jsonl`` already contains every measurement in order.
    # Promote it atomically instead of serializing the full in-memory result
    # list a second time. This removes duplicate disk I/O and guarantees that a
    # completed run does not expose both ``runs.jsonl`` and an identical
    # ``runs.partial.jsonl``. An interrupted benchmark intentionally keeps the
    # partial file for diagnosis.
    runs_path = artifacts_dir / "runs.jsonl"
    try:
        os.replace(partial_path, runs_path)
    except OSError:
        write_jsonl(runs_path, results)
        try:
            partial_path.unlink()
        except FileNotFoundError:
            pass
    write_csv(
        artifacts_dir / "summary.csv",
        summaries,
        [
            "target",
            "target_url",
            "transport",
            "host_id",
            "query_name",
            "runs",
            "failed_runs",
            "semantic_failed_runs",
            "transport_warning_runs",
            "median_done_ms",
            "p95_done_ms",
            "median_verified_done_ms",
            "median_verification_ms",
            "median_first_byte_ms",
            "median_first_event_ms",
            "median_result_meta_ms",
            "median_first_row_ms",
            "median_run_post_ms",
            "median_server_elapsed_ms",
            "median_raw_stream_bytes",
            "median_event_data_bytes",
            "median_total_events",
            "median_result_row_events",
            "median_tick_events",
            "event_count_medians",
            "done_status_counts",
            "result_row_counts_seen",
            "validation_issues",
        ],
    )
    write_csv(
        artifacts_dir / "comparisons.csv",
        comparisons,
        [
            "host_id",
            "query_name",
            "baseline_target",
            "compared_target",
            "baseline_median_done_ms",
            "compared_median_done_ms",
            "speedup_pct_positive_means_baseline_faster",
            "baseline_first_row_ms",
            "compared_first_row_ms",
            "baseline_total_events",
            "compared_total_events",
            "baseline_result_row_events",
            "compared_result_row_events",
            "baseline_tick_events",
            "compared_tick_events",
            "correctness_classification",
            "event_presence_match",
            "event_count_match",
            "raw_event_count_match",
            "core_event_order_match",
            "result_batching_differs",
            "tick_cadence_differs",
            "baseline_tick_schemas",
            "compared_tick_schemas",
            "telemetry_schema_differs",
            "row_hash_match",
            "columns_match",
            "baseline_failed_runs",
            "compared_failed_runs",
            "baseline_event_count_medians",
            "compared_event_count_medians",
            "baseline_semantic_event_count_medians",
            "compared_semantic_event_count_medians",
            "ignored_optional_events",
        ],
    )
    write_csv(
        artifacts_dir / "direct_http_overhead.csv",
        direct_http_overheads,
        [
            "host_id",
            "query_name",
            "dashboard_target",
            "dashboard_median_done_ms",
            "direct_http_median_done_ms",
            "direct_http_server_elapsed_ms",
            "direct_http_verified_done_ms",
            "direct_http_verification_ms",
            "dashboard_first_byte_ms",
            "direct_http_first_byte_ms",
            "dashboard_first_row_ms",
            "direct_http_first_row_ms",
            "overhead_ms",
            "overhead_pct_vs_direct_http",
            "duration_ratio_vs_direct_http",
            "verified_overhead_ms",
            "verified_overhead_pct_vs_direct_http",
            "duration_ratio_vs_verified_direct_http",
            "dashboard_raw_bytes",
            "direct_http_raw_bytes",
            "row_hash_match",
            "columns_match",
            "dashboard_failed_runs",
            "direct_http_failed_runs",
            "dashboard_transport_warning_runs",
        ],
    )

    summary_payload = {
        "run_id": run_id,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "targets": [
            {"name": t.name, "url": t.base_url, "transport": "dashboard_sse"}
            for t in targets
        ],
        "direct_http_targets": [
            endpoint.public_dict()
            for _, endpoint in sorted(selected_direct_endpoints.items())
        ],
        "hosts": host_ids,
        "available_hosts": available_hosts,
        "optional_events": sorted(optional_events),
        "settings": {
            "runs": args.runs,
            "warmup": args.warmup,
            "baseline": args.baseline,
            "dashboard_keepalive": True,
            "direct_http_keepalive": True,
            "stream_chunk_size": args.stream_chunk_size,
            "direct_http_chunk_size": args.direct_http_chunk_size,
            "trace_compression_level": TRACE_GZIP_LEVEL,
            "strict_event_counts": bool(args.strict_event_counts),
        },
        "queries": queries,
        "summaries": summaries,
        "comparisons": comparisons,
        "direct_http_overheads": direct_http_overheads,
        "warnings": warnings,
        "issues": issues,
    }
    (artifacts_dir / "summary.json").write_text(
        json.dumps(summary_payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    write_report(
        artifacts_dir / "comparison.md",
        targets,
        selected_direct_endpoints,
        host_ids,
        queries,
        summaries,
        comparisons,
        direct_http_overheads,
        issues,
        warnings,
        args,
    )

    print("\nSSE comparisons:", file=sys.stderr)
    for comp in comparisons:
        print(
            f"  host={comp['host_id']} query={comp['query_name']} "
            f"{comp['baseline_target']}={comp['baseline_median_done_ms']}ms "
            f"{comp['compared_target']}={comp['compared_median_done_ms']}ms "
            f"speedup={comp['speedup_pct_positive_means_baseline_faster']}% "
            f"rows={'OK' if comp['row_hash_match'] else 'DIFF'} "
            f"columns={'OK' if comp['columns_match'] else 'DIFF'} "
            f"events_presence={'OK' if comp['event_presence_match'] else 'DIFF'} "
            f"control_events={'OK' if comp['event_count_match'] else 'DIFF'} "
            f"core_order={'OK' if comp['core_event_order_match'] else 'DIFF'} "
            f"classification={comp['correctness_classification']}",
            file=sys.stderr,
        )

    if direct_http_overheads:
        print("\nDirect HTTP floor:", file=sys.stderr)
        for row in direct_http_overheads:
            print(
                f"  host={row['host_id']} query={row['query_name']} "
                f"target={row['dashboard_target']} direct={row['direct_http_median_done_ms']}ms "
                f"dashboard={row['dashboard_median_done_ms']}ms "
                f"overhead={row['overhead_ms']}ms ({row['overhead_pct_vs_direct_http']}%)",
                file=sys.stderr,
            )

    if warnings:
        print("\nwarnings:", file=sys.stderr)
        for warning in warnings:
            print(f"  - {warning}", file=sys.stderr)
    if issues:
        print("\nissues:", file=sys.stderr)
        for issue in issues:
            print(f"  - {issue}", file=sys.stderr)

    print(f"\nreport: {artifacts_dir / 'comparison.md'}", file=sys.stderr)
    return 0 if args.no_strict or not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
