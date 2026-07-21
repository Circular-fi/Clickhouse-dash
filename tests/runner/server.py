#!/usr/bin/env python3
from __future__ import annotations

import difflib
import gzip
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import statistics
import subprocess
import sys
import threading
import time
import traceback
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict, dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, quote, unquote, urlparse

ROOT = Path(os.environ.get("TESTS_ROOT", "/tests")).resolve()
ARTIFACTS_ROOT = Path(os.environ.get("TEST_ARTIFACTS_ROOT", "/artifacts")).resolve()
STATIC_ROOT = ROOT / "runner" / "static"
HOST = os.environ.get("TEST_RUNNER_HOST", "0.0.0.0")
PORT = int(os.environ.get("TEST_RUNNER_PORT", "8080"))
AUTO_TESTS = os.environ.get("TEST_RUNNER_AUTO_TESTS", "1").strip().lower() not in {"0", "false", "no", "off"}
AUTO_BENCHMARK = os.environ.get("TEST_RUNNER_AUTO_BENCHMARK", "0").strip().lower() not in {"0", "false", "no", "off"}
MAX_HISTORY = max(5, int(os.environ.get("TEST_RUNNER_MAX_HISTORY", "30")))
MAX_RUNS = max(2, int(os.environ.get("TEST_RUNNER_MAX_RUNS", "30")))
LOG_INITIAL_BYTES = max(4096, int(os.environ.get("TEST_RUNNER_LOG_INITIAL_BYTES", "131072")))
LOG_CHUNK_BYTES = max(4096, int(os.environ.get("TEST_RUNNER_LOG_CHUNK_BYTES", "65536")))
SSE_HEARTBEAT_SECONDS = max(5.0, float(os.environ.get("TEST_RUNNER_SSE_HEARTBEAT_SECONDS", "15")))
FORMAT_PAGE_SIZE = max(5, min(100, int(os.environ.get("TEST_RUNNER_FORMAT_PAGE_SIZE", "20"))))
FORMAT_MAX_DIFF_ROWS = max(100, int(os.environ.get("TEST_RUNNER_FORMAT_MAX_DIFF_ROWS", "1800")))
JSON_GZIP_MIN_BYTES = max(1024, int(os.environ.get("TEST_RUNNER_JSON_GZIP_MIN_BYTES", "4096")))
JSON_GZIP_LEVEL = min(9, max(1, int(os.environ.get("TEST_RUNNER_JSON_GZIP_LEVEL", "3"))))
REPORT_CACHE_ROOT = Path(os.environ.get("TEST_RUNNER_REPORT_CACHE", str(ARTIFACTS_ROOT / ".reports"))).resolve()
REPORT_COMPRESSION_LEVEL = min(9, max(0, int(os.environ.get("TEST_RUNNER_REPORT_COMPRESSION_LEVEL", "3"))))
QUIET_ACCESS_LOGS = os.environ.get("TEST_RUNNER_QUIET_ACCESS_LOGS", "1").strip().lower() not in {"0", "false", "no", "off"}

ARTIFACTS_ROOT.mkdir(parents=True, exist_ok=True)
REPORT_CACHE_ROOT.mkdir(parents=True, exist_ok=True)


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S", time.localtime())


def safe_name(value: str) -> str:
    out = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return out.strip("._-") or "item"


def compact_json(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")


def pretty_json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)


def read_text(path: Path, limit_bytes: int = 512_000) -> str:
    try:
        with path.open("rb") as handle:
            size = path.stat().st_size
            if size > limit_bytes:
                handle.seek(size - limit_bytes)
            data = handle.read(limit_bytes)
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace")


def rel_artifact(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return str(path.resolve().relative_to(ARTIFACTS_ROOT))
    except (OSError, ValueError):
        return None


def artifact_url(path: Path | None) -> str | None:
    rel = rel_artifact(path)
    if rel is None:
        return None
    return "/artifacts/" + "/".join(quote(part) for part in Path(rel).parts)


def latest_dir(parent: Path) -> Path | None:
    try:
        entries = [Path(entry.path) for entry in os.scandir(parent) if entry.is_dir(follow_symlinks=False)]
    except OSError:
        return None
    if not entries:
        return None
    return max(entries, key=lambda path: path.stat().st_mtime_ns)


def file_signature(path: Path) -> tuple[str, int, int] | None:
    try:
        stat = path.stat()
    except OSError:
        return None
    return (str(path), stat.st_mtime_ns, stat.st_size)


def marker_signature(run_dir: Path, names: tuple[str, ...]) -> tuple[Any, ...]:
    values: list[Any] = [str(run_dir)]
    for name in names:
        values.append(file_signature(run_dir / name))
    return tuple(values)


def signature_token(signature: tuple[Any, ...]) -> str:
    return hashlib.sha256(repr(signature).encode("utf-8")).hexdigest()[:16]


def status_for_ui(status: str | None) -> str:
    if status in {"passed", "success"}:
        return "success"
    if status in {"failed", "error"}:
        return "failed"
    if status in {"queued", "running"}:
        return "running"
    if status in {"cancelled", "canceled"}:
        return "cancelled"
    return "idle"


class MemoCache:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.entries: dict[Any, tuple[Any, Any]] = {}

    def get(self, key: Any, signature: Any, loader: Callable[[], Any]) -> Any:
        with self.lock:
            current = self.entries.get(key)
            if current is not None and current[0] == signature:
                return current[1]
        value = loader()
        with self.lock:
            self.entries[key] = (signature, value)
        return value

    def clear_prefix(self, prefix: str) -> None:
        with self.lock:
            for key in list(self.entries):
                if isinstance(key, tuple) and key and str(key[0]).startswith(prefix):
                    self.entries.pop(key, None)


CACHE = MemoCache()
REPORT_LOCK = threading.RLock()
REPORT_INDEX: dict[str, tuple[tuple[Any, ...], Path]] = {}


def read_json_cached(path: Path, default: Any = None) -> Any:
    signature = file_signature(path)
    if signature is None:
        return default

    def load() -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    return CACHE.get(("json", str(path)), signature, load)


def parse_junit(path: Path) -> dict[str, Any]:
    signature = file_signature(path)
    if signature is None:
        return {}

    def load() -> dict[str, Any]:
        try:
            root = ET.parse(path).getroot()
        except Exception as exc:
            return {"parse_error": repr(exc)}

        def as_int(node: ET.Element, key: str) -> int:
            try:
                return int(float(node.attrib.get(key, "0")))
            except (TypeError, ValueError):
                return 0

        def as_float(node: ET.Element, key: str) -> float:
            try:
                return float(node.attrib.get(key, "0") or 0)
            except (TypeError, ValueError):
                return 0.0

        if root.tag == "testsuites":
            suites = list(root.findall("testsuite"))
            totals = {
                "tests": as_int(root, "tests"),
                "failures": as_int(root, "failures"),
                "errors": as_int(root, "errors"),
                "skipped": as_int(root, "skipped"),
                "time_seconds": as_float(root, "time"),
            }
            if totals["tests"] == 0 and suites:
                totals["tests"] = sum(as_int(suite, "tests") for suite in suites)
                totals["failures"] = sum(as_int(suite, "failures") for suite in suites)
                totals["errors"] = sum(as_int(suite, "errors") for suite in suites)
                totals["skipped"] = sum(as_int(suite, "skipped") for suite in suites)
                totals["time_seconds"] = sum(as_float(suite, "time") for suite in suites)
        else:
            totals = {
                "tests": as_int(root, "tests"),
                "failures": as_int(root, "failures"),
                "errors": as_int(root, "errors"),
                "skipped": as_int(root, "skipped"),
                "time_seconds": as_float(root, "time"),
            }

        cases: list[dict[str, Any]] = []
        for case in root.iter("testcase"):
            marker = case.find("failure")
            if marker is None:
                marker = case.find("error")
            if marker is None:
                marker = case.find("skipped")
            if marker is None:
                continue
            text = (marker.text or "").strip()
            cases.append(
                {
                    "classname": case.attrib.get("classname", ""),
                    "name": case.attrib.get("name", ""),
                    "type": marker.tag,
                    "message": marker.attrib.get("message", ""),
                    "details": text[:6000],
                    "time_seconds": as_float(case, "time"),
                }
            )
        totals["failed_cases"] = cases[:100]
        totals["passed"] = max(
            0,
            int(totals.get("tests") or 0)
            - int(totals.get("failures") or 0)
            - int(totals.get("errors") or 0)
            - int(totals.get("skipped") or 0),
        )
        totals["time_seconds"] = round(float(totals.get("time_seconds") or 0), 3)
        return totals

    return CACHE.get(("junit", str(path)), signature, load)


def build_side_by_side_diff(expected: str, actual: str, max_rows: int = FORMAT_MAX_DIFF_ROWS) -> dict[str, Any]:
    expected_lines = expected.splitlines()
    actual_lines = actual.splitlines()
    matcher = difflib.SequenceMatcher(a=expected_lines, b=actual_lines, autojunk=False)
    rows: list[dict[str, Any]] = []
    added = 0
    removed = 0
    changed_blocks = 0

    def append_row(
        kind: str,
        expected_no: int | None,
        expected_text: str | None,
        actual_no: int | None,
        actual_text: str | None,
    ) -> None:
        if len(rows) >= max_rows:
            return
        rows.append(
            {
                "kind": kind,
                "expected_no": expected_no,
                "expected": expected_text,
                "actual_no": actual_no,
                "actual": actual_text,
            }
        )

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                append_row(
                    "equal",
                    i1 + offset + 1,
                    expected_lines[i1 + offset],
                    j1 + offset + 1,
                    actual_lines[j1 + offset],
                )
            continue
        if tag == "delete":
            removed += i2 - i1
            for index in range(i1, i2):
                append_row("delete", index + 1, expected_lines[index], None, None)
            continue
        if tag == "insert":
            added += j2 - j1
            for index in range(j1, j2):
                append_row("insert", None, None, index + 1, actual_lines[index])
            continue

        changed_blocks += 1
        removed += i2 - i1
        added += j2 - j1
        width = max(i2 - i1, j2 - j1)
        for offset in range(width):
            expected_index = i1 + offset
            actual_index = j1 + offset
            has_expected = expected_index < i2
            has_actual = actual_index < j2
            append_row(
                "replace" if has_expected and has_actual else "delete" if has_expected else "insert",
                expected_index + 1 if has_expected else None,
                expected_lines[expected_index] if has_expected else None,
                actual_index + 1 if has_actual else None,
                actual_lines[actual_index] if has_actual else None,
            )

    unified = "\n".join(
        difflib.unified_diff(
            expected_lines,
            actual_lines,
            fromfile="expected.sql",
            tofile="actual.sql",
            lineterm="",
            n=3,
        )
    )
    max_unified_chars = 300_000
    unified_truncated = len(unified) > max_unified_chars
    if unified_truncated:
        unified = unified[:max_unified_chars] + "\n... diff truncated ..."
    return {
        "rows": rows,
        "rows_total": max(len(expected_lines), len(actual_lines)),
        "rows_truncated": max(len(expected_lines), len(actual_lines)) > len(rows),
        "expected_line_count": len(expected_lines),
        "actual_line_count": len(actual_lines),
        "added_lines": added,
        "removed_lines": removed,
        "changed_blocks": changed_blocks,
        "unified": unified,
        "unified_truncated": unified_truncated,
    }


def format_artifact_url(run_dir: Path, relative_value: Any) -> str | None:
    if not isinstance(relative_value, str) or not relative_value:
        return None
    target = (run_dir / relative_value).resolve()
    try:
        target.relative_to(run_dir.resolve())
    except ValueError:
        return None
    return artifact_url(target) if target.is_file() else None


def load_format_manifest(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "format_results.json"
    manifest = read_json_cached(path, {})
    return manifest if isinstance(manifest, dict) else {}


def format_summary(run_dir: Path) -> dict[str, Any]:
    manifest = load_format_manifest(run_dir)
    items = manifest.get("items") if isinstance(manifest.get("items"), list) else []
    return {
        "available": bool(manifest),
        "generated_at": manifest.get("generated_at"),
        "updated_at": manifest.get("updated_at"),
        "total_expected": int(manifest.get("total_expected") or len(items)),
        "completed": int(manifest.get("completed") or len(items)),
        "passed": int(manifest.get("passed") or 0),
        "failed": int(manifest.get("failed") or 0),
        "errors": int(manifest.get("errors") or 0),
        "manifest_url": artifact_url(run_dir / "format_results.json") if (run_dir / "format_results.json").is_file() else None,
    }


def query_types_summary(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "query_types_results.json"
    manifest = read_json_cached(path, {})
    if not isinstance(manifest, dict):
        manifest = {}
    summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    return {
        "available": bool(manifest),
        "generated_at": manifest.get("generated_at"),
        "total_expected": int(summary.get("total_expected") or 0),
        "completed": int(summary.get("completed") or 0),
        "passed": int(summary.get("passed") or 0),
        "failed": int(summary.get("failed") or 0),
        "source_regressions_vs_release": int(summary.get("source_regressions_vs_release") or 0),
        "test_infrastructure_errors": int(summary.get("test_infrastructure_errors") or 0),
        "classifications": summary.get("classifications") if isinstance(summary.get("classifications"), dict) else {},
        "manifest_url": artifact_url(path) if path.is_file() else None,
    }


def format_item_metadata(run_dir: Path, raw_item: dict[str, Any]) -> dict[str, Any]:
    unified = str(raw_item.get("diff") or "")
    if all(key in raw_item for key in ("added_lines", "removed_lines", "changed_blocks")):
        added = int(raw_item.get("added_lines") or 0)
        removed = int(raw_item.get("removed_lines") or 0)
        changed_blocks = int(raw_item.get("changed_blocks") or 0)
    else:
        added = 0
        removed = 0
        changed_blocks = 0
        for line in unified.splitlines():
            if line.startswith("@@"):
                changed_blocks += 1
            elif line.startswith("+") and not line.startswith("+++"):
                added += 1
            elif line.startswith("-") and not line.startswith("---"):
                removed += 1
    artifacts = raw_item.get("artifacts") if isinstance(raw_item.get("artifacts"), dict) else {}
    file_name = str(raw_item.get("file") or raw_item.get("name") or "")
    return {
        "name": raw_item.get("name") or Path(file_name).stem,
        "file": file_name,
        "status": raw_item.get("status") or ("failed" if unified else "passed"),
        "duration_ms": raw_item.get("duration_ms"),
        "error": raw_item.get("error"),
        "expected_lines": int(raw_item.get("expected_lines") or len(str(raw_item.get("expected") or "").splitlines())),
        "actual_lines": int(raw_item.get("actual_lines") or len(str(raw_item.get("actual") or "").splitlines())),
        "added_lines": added,
        "removed_lines": removed,
        "changed_blocks": changed_blocks,
        "has_diff": bool(unified),
        "input_url": format_artifact_url(run_dir, artifacts.get("input")),
        "expected_url": format_artifact_url(run_dir, artifacts.get("expected")),
        "actual_url": format_artifact_url(run_dir, artifacts.get("actual")),
        "detail_url": "/api/format-case?file=" + quote(file_name),
    }


def load_format_page(
    run_dir: Path,
    status_filter: str,
    search: str,
    offset: int,
    limit: int,
) -> dict[str, Any]:
    manifest_path = run_dir / "format_results.json"
    signature = (file_signature(manifest_path), status_filter, search.lower(), offset, limit)

    def load() -> dict[str, Any]:
        manifest = load_format_manifest(run_dir)
        raw_items = manifest.get("items") if isinstance(manifest.get("items"), list) else []
        filtered: list[dict[str, Any]] = []
        needle = search.strip().lower()
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            item_status = str(raw.get("status") or "")
            if status_filter == "failures" and item_status == "passed":
                continue
            label = f"{raw.get('file') or ''} {raw.get('name') or ''}".lower()
            if needle and needle not in label:
                continue
            filtered.append(raw)
        page = filtered[offset : offset + limit]
        items = [format_item_metadata(run_dir, raw) for raw in page]
        return {
            "available": bool(manifest),
            "run_id": run_dir.name,
            "summary": format_summary(run_dir),
            "filter": status_filter,
            "search": search,
            "offset": offset,
            "limit": limit,
            "total": len(filtered),
            "next_offset": offset + len(items),
            "has_more": offset + len(items) < len(filtered),
            "items": items,
        }

    return CACHE.get(("format-page", str(run_dir), status_filter, search.lower(), offset, limit), signature, load)


def load_format_case(run_dir: Path, file_name: str) -> dict[str, Any] | None:
    manifest_path = run_dir / "format_results.json"
    signature = (file_signature(manifest_path), file_name)

    def load() -> dict[str, Any] | None:
        manifest = load_format_manifest(run_dir)
        raw_items = manifest.get("items") if isinstance(manifest.get("items"), list) else []
        selected = next(
            (
                item
                for item in raw_items
                if isinstance(item, dict) and str(item.get("file") or item.get("name") or "") == file_name
            ),
            None,
        )
        if selected is None:
            return None
        expected = str(selected.get("expected") or "")
        actual = str(selected.get("actual") or "")
        result = format_item_metadata(run_dir, selected)
        result.update(build_side_by_side_diff(expected, actual))
        result["run_id"] = run_dir.name
        return result

    return CACHE.get(("format-case", str(run_dir), file_name), signature, load)


def finite_numbers(values: list[Any]) -> list[float]:
    out: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == number and number not in {float("inf"), float("-inf")}:
            out.append(number)
    return out


def median_or_none(values: list[Any]) -> float | None:
    numbers = finite_numbers(values)
    if not numbers:
        return None
    return round(float(statistics.median(numbers)), 3)


def benchmark_overview(summary: dict[str, Any]) -> dict[str, Any]:
    comparisons = summary.get("comparisons") if isinstance(summary.get("comparisons"), list) else []
    overheads = summary.get("direct_http_overheads") if isinstance(summary.get("direct_http_overheads"), list) else []
    issues = summary.get("issues") if isinstance(summary.get("issues"), list) else []
    summaries = summary.get("summaries") if isinstance(summary.get("summaries"), list) else []
    speedups = [row.get("speedup_pct_positive_means_baseline_faster") for row in comparisons if isinstance(row, dict)]
    overhead_ms = [row.get("overhead_ms") for row in overheads if isinstance(row, dict)]
    ratios = [row.get("duration_ratio_vs_direct_http") for row in overheads if isinstance(row, dict)]
    hosts = sorted({str(row.get("host_id")) for row in summaries if isinstance(row, dict) and row.get("host_id")})
    queries = sorted({str(row.get("query_name")) for row in summaries if isinstance(row, dict) and row.get("query_name")})
    targets = sorted({str(row.get("target")) for row in summaries if isinstance(row, dict) and row.get("target")})
    positive = finite_numbers(speedups)
    return {
        "comparisons_count": len(comparisons),
        "direct_http_count": len(overheads),
        "issues_count": len(issues),
        "summaries_count": len(summaries),
        "median_speedup_pct": median_or_none(speedups),
        "source_faster_count": sum(1 for value in positive if value > 0),
        "source_slower_count": sum(1 for value in positive if value < 0),
        "median_direct_overhead_ms": median_or_none(overhead_ms),
        "median_direct_ratio": median_or_none(ratios),
        "hosts": hosts,
        "queries": queries,
        "targets": targets,
    }


class ArtifactRepository:
    TEST_MARKERS = ("runner-result.json", "junit.xml", "format_results.json", "query_types_results.json", "pytest.log")
    BENCH_MARKERS = (
        "summary.json",
        "comparison.md",
        "summary.csv",
        "comparisons.csv",
        "direct_http_overhead.csv",
        "runner.log",
    )

    def latest(self, kind: str) -> Path | None:
        parent = ARTIFACTS_ROOT / ("tests" if kind == "tests" else "benchmark")
        return latest_dir(parent)

    def tests_details(self) -> dict[str, Any]:
        run_dir = self.latest("tests")
        if run_dir is None:
            return {}
        signature = marker_signature(run_dir, self.TEST_MARKERS)
        revision = signature_token(signature)

        def load() -> dict[str, Any]:
            junit_path = run_dir / "junit.xml"
            runner_result = read_json_cached(run_dir / "runner-result.json", {})
            if not isinstance(runner_result, dict):
                runner_result = {}
            return {
                "kind": "tests",
                "run_id": run_dir.name,
                "revision": revision,
                "dir": rel_artifact(run_dir),
                "url": artifact_url(run_dir),
                "junit": parse_junit(junit_path),
                "format_results": format_summary(run_dir),
                "query_types": query_types_summary(run_dir),
                "runner": runner_result,
                "links": {
                    "junit": artifact_url(junit_path) if junit_path.is_file() else None,
                    "log": artifact_url(run_dir / "pytest.log") if (run_dir / "pytest.log").is_file() else None,
                    "result": artifact_url(run_dir / "runner-result.json") if (run_dir / "runner-result.json").is_file() else None,
                    "format_results": artifact_url(run_dir / "format_results.json") if (run_dir / "format_results.json").is_file() else None,
                    "query_types": artifact_url(run_dir / "query_types_results.json") if (run_dir / "query_types_results.json").is_file() else None,
                },
                "report_url": "/api/report/tests.zip",
                "artifacts_api_url": "/api/artifacts/tests",
                "format_api_url": "/api/format-results",
                "log_api_url": "/api/log/tests",
            }

        return CACHE.get(("tests-details", str(run_dir)), signature, load)

    def benchmark_details(self) -> dict[str, Any]:
        run_dir = self.latest("benchmark")
        if run_dir is None:
            return {}
        signature = marker_signature(run_dir, self.BENCH_MARKERS)
        revision = signature_token(signature)

        def load() -> dict[str, Any]:
            summary = read_json_cached(run_dir / "summary.json", {})
            if not isinstance(summary, dict):
                summary = {}
            overview = benchmark_overview(summary)
            # Keep the dashboard payload focused on the rows it actually renders.
            # The complete summary (including per-run raw measurements) remains in
            # summary.json and in the downloadable ZIP report.
            ui_summary = {
                "comparisons": summary.get("comparisons") or [],
                "direct_http_overheads": summary.get("direct_http_overheads") or [],
                "issues": (summary.get("issues") or [])[:500],
            }
            return {
                "kind": "benchmark",
                "run_id": run_dir.name,
                "revision": revision,
                "dir": rel_artifact(run_dir),
                "url": artifact_url(run_dir),
                "summary": ui_summary,
                "overview": overview,
                "links": {
                    "summary": artifact_url(run_dir / "summary.json") if (run_dir / "summary.json").is_file() else None,
                    "comparison": artifact_url(run_dir / "comparison.md") if (run_dir / "comparison.md").is_file() else None,
                    "summary_csv": artifact_url(run_dir / "summary.csv") if (run_dir / "summary.csv").is_file() else None,
                    "comparisons_csv": artifact_url(run_dir / "comparisons.csv") if (run_dir / "comparisons.csv").is_file() else None,
                    "direct_http_csv": artifact_url(run_dir / "direct_http_overhead.csv") if (run_dir / "direct_http_overhead.csv").is_file() else None,
                    "log": artifact_url(run_dir / "runner.log") if (run_dir / "runner.log").is_file() else None,
                    "runs": artifact_url(run_dir / "runs.jsonl") if (run_dir / "runs.jsonl").is_file() else None,
                },
                "report_url": "/api/report/benchmark.zip",
                "artifacts_api_url": "/api/artifacts/benchmark",
                "log_api_url": "/api/log/benchmark",
            }

        return CACHE.get(("benchmark-details", str(run_dir)), signature, load)

    def tests_overview(self) -> dict[str, Any]:
        details = self.tests_details()
        if not details:
            return {}
        junit = details.get("junit") if isinstance(details.get("junit"), dict) else {}
        formats = details.get("format_results") if isinstance(details.get("format_results"), dict) else {}
        query_types = details.get("query_types") if isinstance(details.get("query_types"), dict) else {}
        runner = details.get("runner") if isinstance(details.get("runner"), dict) else {}
        return {
            "run_id": details.get("run_id"),
            "revision": details.get("revision"),
            "dir": details.get("dir"),
            "status": status_for_ui(str(runner.get("status") or "")) if runner else ("failed" if int(junit.get("failures") or 0) + int(junit.get("errors") or 0) else "success"),
            "tests": int(junit.get("tests") or 0),
            "passed": int(junit.get("passed") or 0),
            "failures": int(junit.get("failures") or 0),
            "errors": int(junit.get("errors") or 0),
            "skipped": int(junit.get("skipped") or 0),
            "time_seconds": float(junit.get("time_seconds") or 0),
            "format_failed": int(formats.get("failed") or 0) + int(formats.get("errors") or 0),
            "format_completed": int(formats.get("completed") or 0),
            "format_total": int(formats.get("total_expected") or 0),
            "query_type_failed": int(query_types.get("failed") or 0),
            "query_type_regressions": int(query_types.get("source_regressions_vs_release") or 0),
            "query_type_infrastructure_errors": int(query_types.get("test_infrastructure_errors") or 0),
            "report_url": details.get("report_url"),
            "details_url": "/api/details/tests",
        }

    def benchmark_overview(self) -> dict[str, Any]:
        details = self.benchmark_details()
        if not details:
            return {}
        overview = dict(details.get("overview") or {})
        overview.update(
            {
                "run_id": details.get("run_id"),
                "revision": details.get("revision"),
                "dir": details.get("dir"),
                "status": "failed" if int(overview.get("issues_count") or 0) else "success",
                "report_url": details.get("report_url"),
                "details_url": "/api/details/benchmark",
            }
        )
        return overview

    def list_artifacts(self, kind: str, limit: int = 500) -> dict[str, Any]:
        run_dir = self.latest(kind)
        if run_dir is None:
            return {"kind": kind, "run_id": None, "items": []}
        markers = self.TEST_MARKERS if kind == "tests" else self.BENCH_MARKERS
        signature = marker_signature(run_dir, markers)

        def load() -> dict[str, Any]:
            items: list[dict[str, Any]] = []
            try:
                paths = sorted(
                    (path for path in run_dir.rglob("*") if path.is_file() and not path.is_symlink()),
                    key=lambda path: str(path.relative_to(run_dir)),
                )
            except OSError:
                paths = []
            for path in paths[:limit]:
                try:
                    stat = path.stat()
                    rel = path.relative_to(run_dir)
                except OSError:
                    continue
                items.append(
                    {
                        "path": str(rel),
                        "url": artifact_url(path),
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    }
                )
            return {
                "kind": kind,
                "run_id": run_dir.name,
                "dir": rel_artifact(run_dir),
                "total": len(paths),
                "truncated": len(paths) > limit,
                "items": items,
            }

        return CACHE.get(("artifact-list", kind, str(run_dir), limit), signature, load)


REPOSITORY = ArtifactRepository()


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    phase: str = "queued"
    created_at: str = field(default_factory=utc_now)
    started_at: str | None = None
    ended_at: str | None = None
    returncode: int | None = None
    command: list[str] = field(default_factory=list)
    artifact_dir: str | None = None
    log_path: str | None = None
    summary_path: str | None = None
    error: str | None = None
    pid: int | None = None
    duration_seconds: float | None = None
    summary: dict[str, Any] = field(default_factory=dict)


class JobStore:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.active: Job | None = None
        self.history: list[Job] = []
        self.process: subprocess.Popen[str] | None = None
        self.cancel_requested = False
        self.version = 1
        self.state_cache_version = -1
        self.state_cache: dict[str, Any] | None = None

    def _bump_locked(self) -> None:
        self.version += 1
        self.state_cache = None
        self.state_cache_version = -1
        self.changed.notify_all()

    def bump(self) -> None:
        with self.lock:
            self._bump_locked()

    def current_version(self) -> int:
        with self.lock:
            return self.version

    def has_active(self) -> bool:
        with self.lock:
            return self.active is not None and self.active.status in {"queued", "running", "cancelling"}

    def wait_for_version(self, after: int, timeout: float) -> int:
        with self.changed:
            if self.version <= after:
                self.changed.wait(timeout=timeout)
            return self.version

    def _job_to_dict(self, job: Job | None, include_summary: bool = False) -> dict[str, Any] | None:
        if job is None:
            return None
        data = {
            "id": job.id,
            "kind": job.kind,
            "status": job.status,
            "phase": job.phase,
            "created_at": job.created_at,
            "started_at": job.started_at,
            "ended_at": job.ended_at,
            "returncode": job.returncode,
            "artifact_dir": rel_artifact(Path(job.artifact_dir)) if job.artifact_dir else None,
            "artifact_url": artifact_url(Path(job.artifact_dir)) if job.artifact_dir else None,
            "log_url": artifact_url(Path(job.log_path)) if job.log_path else None,
            "summary_url": artifact_url(Path(job.summary_path)) if job.summary_path else None,
            "error": job.error,
            "pid": job.pid,
            "duration_seconds": job.duration_seconds,
        }
        if include_summary:
            data["summary"] = job.summary
        return data

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            version = self.version
            if self.state_cache_version == version and self.state_cache is not None:
                return self.state_cache
            active = self._job_to_dict(self.active)
            history = [self._job_to_dict(job) for job in self.history[-MAX_HISTORY:]][::-1]

        latest = {
            "tests": REPOSITORY.tests_overview(),
            "benchmark": REPOSITORY.benchmark_overview(),
        }
        jobs = build_jobs_view(active, history, latest)
        payload = {
            "schema_version": 2,
            "version": version,
            "active": active,
            "history": history,
            "latest": latest,
            "jobs": jobs,
            "config": build_config_view(),
            "now": utc_now(),
        }
        with self.lock:
            if self.version == version:
                self.state_cache_version = version
                self.state_cache = payload
        return payload

    def start(self, kind: str) -> Job:
        kind = safe_name(kind)
        if kind not in {"tests", "benchmark", "all"}:
            raise ValueError(f"unknown job kind: {kind}")
        with self.lock:
            if self.active is not None and self.active.status in {"queued", "running", "cancelling"}:
                raise RuntimeError(f"job already running: {self.active.kind} {self.active.id}")
            job = Job(id=f"{stamp()}-{uuid.uuid4().hex[:8]}", kind=kind)
            self.active = job
            self.cancel_requested = False
            self._bump_locked()
        threading.Thread(target=self._run_job, args=(job,), daemon=True).start()
        return job

    def cancel(self) -> bool:
        with self.lock:
            self.cancel_requested = True
            proc = self.process
            active = self.active
            if active is not None:
                active.status = "cancelling"
                active.phase = "cancelling"
                self._bump_locked()
        if proc is None or proc.poll() is not None:
            return active is not None
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                return False

        def force_kill() -> None:
            time.sleep(2.0)
            if proc.poll() is not None:
                return
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

        threading.Thread(target=force_kill, daemon=True).start()
        return True

    def _set_phase(self, job: Job, phase: str) -> None:
        with self.lock:
            job.phase = phase
            self._bump_locked()

    def _finish(self, job: Job) -> None:
        with self.lock:
            job.ended_at = utc_now()
            self.history.append(job)
            if len(self.history) > MAX_HISTORY:
                self.history = self.history[-MAX_HISTORY:]
            if self.active is job:
                self.active = None
            self.process = None
            self._bump_locked()

    def _run_job(self, job: Job) -> None:
        started = time.perf_counter()
        with self.lock:
            job.started_at = utc_now()
            cancelled_before_start = self.cancel_requested or job.status == "cancelling"
            if cancelled_before_start:
                job.status = "cancelled"
                job.phase = "cancelled before start"
                job.returncode = 130
            else:
                job.status = "running"
            self._bump_locked()
        try:
            if not cancelled_before_start:
                if job.kind == "tests":
                    self._run_tests(job)
                elif job.kind == "benchmark":
                    self._run_benchmark(job)
                else:
                    self._run_all(job)
            if self.cancel_requested or job.status == "cancelling":
                job.status = "cancelled"
            elif job.status == "running":
                job.status = "passed" if job.returncode == 0 else "failed"
        except Exception as exc:
            job.status = "failed"
            job.error = repr(exc)
            if job.log_path:
                try:
                    with Path(job.log_path).open("a", encoding="utf-8") as handle:
                        handle.write("\n--- runner exception ---\n")
                        handle.write(traceback.format_exc())
                except OSError:
                    pass
        finally:
            job.duration_seconds = round(time.perf_counter() - started, 3)
            self._write_job_result(job)
            self._finish(job)
            prune_runs("tests")
            prune_runs("benchmark")
            prune_report_cache()

    def _job_result_payload(self, job: Job) -> dict[str, Any]:
        payload = asdict(job)
        if job.kind == "benchmark" and isinstance(job.summary, dict):
            # summary.json is the source of truth for the complete matrix. Keeping
            # only an index here avoids writing the same potentially large payload
            # twice and embedding it again in an `all` job.
            payload["summary"] = {
                "external_summary": rel_artifact(Path(job.summary_path)) if job.summary_path else None,
                "run_id": job.summary.get("run_id"),
                "targets": job.summary.get("targets") or [],
                "hosts": job.summary.get("hosts") or [],
                "comparisons_count": len(job.summary.get("comparisons") or []),
                "direct_http_overheads_count": len(job.summary.get("direct_http_overheads") or []),
                "issues_count": len(job.summary.get("issues") or []),
            }
        return payload

    def _write_job_result(self, job: Job) -> None:
        if not job.artifact_dir:
            return
        path = Path(job.artifact_dir) / "runner-result.json"
        job.summary_path = job.summary_path or str(path)
        try:
            path.write_text(pretty_json(self._job_result_payload(job)), encoding="utf-8")
        except OSError:
            return

    def _run_command(self, job: Job, command: list[str], log_path: Path, env: dict[str, str]) -> int:
        with self.lock:
            job.command = command
            job.log_path = str(log_path)
            if self.active is not None and self.active.kind == "all" and self.active is not job:
                self.active.command = command
                self.active.log_path = str(log_path)
            self._bump_locked()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("w", encoding="utf-8", buffering=64 * 1024) as log:
            log.write(f"$ {' '.join(command)}\n")
            log.flush()
            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                cwd=str(ROOT),
                env=env,
                bufsize=1,
                start_new_session=True,
            )
            with self.lock:
                self.process = proc
                job.pid = proc.pid
                self._bump_locked()
            assert proc.stdout is not None
            last_flush = time.monotonic()
            buffered_chars = 0
            for line in proc.stdout:
                log.write(line)
                buffered_chars += len(line)
                now = time.monotonic()
                if buffered_chars >= 64 * 1024 or now - last_flush >= 0.25:
                    log.flush()
                    buffered_chars = 0
                    last_flush = now
            rc = proc.wait()
            with self.lock:
                self.process = None
                self._bump_locked()
            log.write(f"\nexit_code={rc}\n")
            log.flush()
            return rc

    def _run_tests(self, job: Job) -> None:
        run_dir = ARTIFACTS_ROOT / "tests" / job.id
        run_dir.mkdir(parents=True, exist_ok=True)
        with self.lock:
            job.artifact_dir = str(run_dir)
            self._bump_locked()
        self._set_phase(job, "pytest")
        env = os.environ.copy()
        env["TEST_ARTIFACTS_DIR"] = str(run_dir)
        env.setdefault("API_BASE_URL", "http://chdash_source:8080")
        env.setdefault("API_HEALTH_PATH", "/api/health")
        junit = run_dir / "junit.xml"
        command = [
            sys.executable,
            "-m",
            "pytest",
            "-q",
            str(ROOT / "harness"),
            str(ROOT / "api" / "format" / "check_format.py"),
            str(ROOT / "api" / "query_types" / "check_query_types.py"),
            "--junitxml",
            str(junit),
        ]
        job.returncode = self._run_command(job, command, run_dir / "pytest.log", env)
        job.summary = {
            "kind": "tests",
            "junit": parse_junit(junit),
            "format_results": format_summary(run_dir),
            "query_types": query_types_summary(run_dir),
        }
        job.summary_path = str(run_dir / "runner-result.json")
        job.status = "cancelled" if self.cancel_requested else "passed" if job.returncode == 0 else "failed"

    def _run_benchmark(self, job: Job) -> None:
        root = ARTIFACTS_ROOT / "benchmark"
        run_dir = root / job.id
        run_dir.mkdir(parents=True, exist_ok=True)
        with self.lock:
            job.artifact_dir = str(run_dir)
            self._bump_locked()
        self._set_phase(job, "benchmark / SSE + HTTP direct")
        env = os.environ.copy()
        env["BENCH_ARTIFACTS_DIR"] = str(root)
        env["BENCH_RUN_ID"] = job.id
        env.setdefault("BENCH_TARGETS", "source=http://chdash_source:8080,release=http://chdash_release:8080")
        env.setdefault("BENCH_BASELINE", "source")
        env.setdefault("BENCH_CLICKHOUSE_HTTP_TARGETS", "local=http://clickhouse:8123")
        env.setdefault("BENCH_QUERIES_FILE", str(ROOT / "benchmark" / "queries.json"))
        env.setdefault("BENCH_CH_HOSTS_FILE", str(ROOT / "config" / "CH_HOSTS.hcl"))
        command = [sys.executable, str(ROOT / "benchmark" / "benchmark_sse.py"), "--run-id", job.id]
        job.returncode = self._run_command(job, command, run_dir / "runner.log", env)
        summary_path = run_dir / "summary.json"
        job.summary_path = str(summary_path if summary_path.is_file() else run_dir / "runner-result.json")
        summary = read_json_cached(summary_path, {})
        job.summary = summary if isinstance(summary, dict) else {}
        if not job.summary and not summary_path.is_file():
            job.summary = {"error": "benchmark summary not found"}
        job.status = "cancelled" if self.cancel_requested else "passed" if job.returncode == 0 else "failed"

    def _run_all(self, job: Job) -> None:
        run_dir = ARTIFACTS_ROOT / "all" / job.id
        run_dir.mkdir(parents=True, exist_ok=True)
        with self.lock:
            job.artifact_dir = str(run_dir)
            self._bump_locked()
        phases: list[dict[str, Any]] = []

        self._set_phase(job, "tests")
        tests_job = Job(id=f"{job.id}-tests", kind="tests", started_at=utc_now(), status="running")
        self._run_tests(tests_job)
        phases.append(self._job_result_payload(tests_job))

        if not self.cancel_requested:
            self._set_phase(job, "benchmark")
            benchmark_job = Job(id=f"{job.id}-benchmark", kind="benchmark", started_at=utc_now(), status="running")
            self._run_benchmark(benchmark_job)
            phases.append(self._job_result_payload(benchmark_job))

        job.returncode = 0 if phases and all(int(phase.get("returncode") or 0) == 0 for phase in phases) else 1
        job.summary = {"kind": "all", "phases": phases}
        job.summary_path = str(run_dir / "runner-result.json")
        job.status = "cancelled" if self.cancel_requested else "passed" if job.returncode == 0 else "failed"


STORE = JobStore()


def build_jobs_view(
    active: dict[str, Any] | None,
    history: list[dict[str, Any] | None],
    latest: dict[str, Any],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    active_kind = active.get("kind") if isinstance(active, dict) else None
    for kind in ("tests", "benchmark"):
        latest_job = next(
            (
                item
                for item in history
                if isinstance(item, dict) and (item.get("kind") == kind or item.get("kind") == "all")
            ),
            None,
        )
        overview = latest.get(kind) if isinstance(latest.get(kind), dict) else {}
        is_active = isinstance(active, dict) and active_kind in {kind, "all"}
        if is_active:
            status = "running"
            message = f"{active_kind} / {active.get('phase') or ''}"
        elif latest_job is not None:
            status = status_for_ui(str(latest_job.get("status") or ""))
            message = f"last run {latest_job.get('started_at') or ''}".strip()
        elif overview:
            status = status_for_ui(str(overview.get("status") or ""))
            message = "latest artifact"
        else:
            status = "idle"
            message = "no run"
        result[kind] = {
            "kind": kind,
            "status": status,
            "message": message,
            "active": is_active,
            "exit_code": None if is_active else latest_job.get("returncode") if isinstance(latest_job, dict) else None,
            "overview": overview,
            "report_url": overview.get("report_url") if overview else None,
            "details_url": overview.get("details_url") if overview else f"/api/details/{kind}",
        }
    return result


def configured_target_names(value: str) -> list[str]:
    names: list[str] = []
    for item in value.split(","):
        item = item.strip()
        if not item:
            continue
        name = item.split("=", 1)[0].strip()
        if name:
            names.append(name)
    return names


def build_config_view() -> dict[str, Any]:
    return {
        "benchmark_targets": configured_target_names(
            os.environ.get("BENCH_TARGETS", "source=http://chdash_source:8080,release=http://chdash_release:8080")
        ),
        "benchmark_direct_http_hosts": configured_target_names(
            os.environ.get("BENCH_CLICKHOUSE_HTTP_TARGETS", "local=http://clickhouse:8123")
        ),
        "benchmark_runs": int(os.environ.get("BENCH_RUNS", "5")),
        "benchmark_warmup": int(os.environ.get("BENCH_WARMUP", "1")),
        "benchmark_host_ids": [item for item in re.split(r"[,\s]+", os.environ.get("BENCH_HOST_IDS", "").strip()) if item],
        "auto_tests": AUTO_TESTS,
        "auto_benchmark": AUTO_BENCHMARK,
        "max_runs": MAX_RUNS,
        "format_page_size": FORMAT_PAGE_SIZE,
        "public_ports": {
            "source": int(os.environ.get("TEST_RUNNER_SOURCE_PUBLIC_PORT", "18080")),
            "release": int(os.environ.get("TEST_RUNNER_RELEASE_PUBLIC_PORT", "18081")),
            "clickhouse_http": int(os.environ.get("TEST_RUNNER_CLICKHOUSE_PUBLIC_PORT", "18123")),
        },
    }


def prune_runs(kind: str) -> None:
    parent = ARTIFACTS_ROOT / kind
    try:
        dirs = sorted(
            (Path(entry.path) for entry in os.scandir(parent) if entry.is_dir(follow_symlinks=False)),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
    except OSError:
        return
    for path in dirs[MAX_RUNS:]:
        try:
            shutil.rmtree(path)
        except OSError:
            continue


def prune_report_cache() -> None:
    try:
        files = sorted(
            (Path(entry.path) for entry in os.scandir(REPORT_CACHE_ROOT) if entry.is_file(follow_symlinks=False)),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
    except OSError:
        return
    for path in files[12:]:
        try:
            path.unlink()
        except OSError:
            continue


def resolve_log(kind: str) -> tuple[Path | None, str, bool]:
    with STORE.lock:
        active = STORE.active
        if active is not None and active.kind in {kind, "all"}:
            if active.log_path and Path(active.log_path).is_file():
                return Path(active.log_path), f"{active.id}:{Path(active.log_path).name}", True
    run_dir = REPOSITORY.latest(kind)
    if run_dir is None:
        return None, "", False
    log_name = "pytest.log" if kind == "tests" else "runner.log"
    path = run_dir / log_name
    return (path if path.is_file() else None), f"{run_dir.name}:{log_name}", False


def read_log_chunk(kind: str, client_key: str, offset: int, limit: int) -> dict[str, Any]:
    path, key, active = resolve_log(kind)
    if path is None:
        return {
            "kind": kind,
            "key": "",
            "reset": client_key != "",
            "offset": 0,
            "next_offset": 0,
            "size": 0,
            "text": "",
            "active": active,
            "complete": not active,
        }
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    reset = client_key != key or offset < 0 or offset > size
    start = max(0, size - LOG_INITIAL_BYTES) if reset else offset
    max_bytes = max(4096, min(limit, 512 * 1024))
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            raw = handle.read(max_bytes)
    except OSError:
        raw = b""
    if reset and start > 0 and raw:
        newline = raw.find(b"\n")
        if newline >= 0:
            start += newline + 1
            raw = raw[newline + 1 :]
    next_offset = start + len(raw)
    return {
        "kind": kind,
        "key": key,
        "reset": reset,
        "offset": start,
        "next_offset": next_offset,
        "size": size,
        "text": raw.decode("utf-8", errors="replace"),
        "active": active,
        "complete": not active and next_offset >= size,
        "log_url": artifact_url(path),
    }


def tree_files(run_dir: Path) -> list[tuple[Path, str, os.stat_result]]:
    rows: list[tuple[Path, str, os.stat_result]] = []
    for path in sorted(run_dir.rglob("*"), key=lambda item: str(item.relative_to(run_dir))):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            stat = path.stat()
            rel = str(path.relative_to(run_dir))
        except OSError:
            continue
        rows.append((path, rel, stat))
    return rows


def report_zip_for(kind: str) -> Path | None:
    run_dir = REPOSITORY.latest(kind)
    if run_dir is None:
        return None
    markers = ArtifactRepository.TEST_MARKERS if kind == "tests" else ArtifactRepository.BENCH_MARKERS
    quick_signature = marker_signature(run_dir, markers)
    cache_key = f"{kind}:{run_dir}"
    with REPORT_LOCK:
        cached = REPORT_INDEX.get(cache_key)
        if cached is not None and cached[0] == quick_signature and cached[1].is_file():
            return cached[1]

        files = tree_files(run_dir)
        digest = hashlib.sha256()
        for _, rel, stat in files:
            digest.update(rel.encode("utf-8", errors="surrogatepass"))
            digest.update(str(stat.st_size).encode("ascii"))
            digest.update(str(stat.st_mtime_ns).encode("ascii"))
        signature = digest.hexdigest()[:16]
        output = REPORT_CACHE_ROOT / f"chdash-{kind}-report-{safe_name(run_dir.name)}-{signature}.zip"
        if output.is_file():
            REPORT_INDEX[cache_key] = (quick_signature, output)
            return output

        tmp = output.with_suffix(".tmp")
        details = REPOSITORY.tests_details() if kind == "tests" else REPOSITORY.benchmark_details()
        summary = (
            {
                "junit": details.get("junit") or {},
                "format_results": details.get("format_results") or {},
                "query_types": details.get("query_types") or {},
            }
            if kind == "tests"
            else details.get("overview") or {}
        )
        manifest = {
            "schema_version": 1,
            "generated_at": utc_now(),
            "kind": kind,
            "run_id": run_dir.name,
            "file_count": len(files),
            "uncompressed_bytes": sum(stat.st_size for _, _, stat in files),
            "summary": summary,
            "analysis_hint": "Upload this zip as a complete test or benchmark report. The original artifacts are under artifacts/.",
        }
        readme = (
            "ClickHouse Dash report bundle\n"
            "=============================\n\n"
            f"Kind: {kind}\n"
            f"Run: {run_dir.name}\n\n"
            "report-manifest.json contains a compact machine-readable overview.\n"
            "artifacts/ contains the original JUnit, JSON, CSV, Markdown, log and SSE trace files.\n"
        )
        with zipfile.ZipFile(tmp, "w", allowZip64=True) as archive:
            archive.writestr(
                "report-manifest.json",
                pretty_json(manifest),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=REPORT_COMPRESSION_LEVEL,
            )
            archive.writestr("README.txt", readme, compress_type=zipfile.ZIP_DEFLATED, compresslevel=REPORT_COMPRESSION_LEVEL)
            for path, rel, _ in files:
                suffix = path.suffix.lower()
                compression = zipfile.ZIP_STORED if suffix in {".gz", ".zip", ".tgz", ".png", ".jpg", ".jpeg"} else zipfile.ZIP_DEFLATED
                archive.write(
                    path,
                    arcname=f"artifacts/{rel}",
                    compress_type=compression,
                    compresslevel=REPORT_COMPRESSION_LEVEL if compression == zipfile.ZIP_DEFLATED else None,
                )
        os.replace(tmp, output)
        REPORT_INDEX[cache_key] = (quick_signature, output)
        prune_report_cache()
        return output


class RunnerHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def handle_error(self, request: Any, client_address: Any) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionResetError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "chdash-tests-runner/2.0"
    protocol_version = "HTTP/1.1"

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        if QUIET_ACCESS_LOGS and self.path.startswith(("/api/state", "/api/events", "/api/log/", "/api/health")):
            return
        print(f"[{time.strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", file=sys.stderr)

    def _request_accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "").lower()

    def send_json(
        self,
        status: int,
        payload: Any,
        *,
        etag: str | None = None,
        cache_control: str = "no-cache",
    ) -> None:
        if etag and self.headers.get("If-None-Match") == etag and status == HTTPStatus.OK:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = compact_json(payload)
        compressed = False
        if len(data) >= JSON_GZIP_MIN_BYTES and self._request_accepts_gzip():
            data = gzip.compress(data, compresslevel=JSON_GZIP_LEVEL)
            compressed = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        if etag:
            self.send_header("ETag", etag)
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_path(
        self,
        path: Path,
        *,
        download_name: str | None = None,
        cache_control: str = "private, no-cache",
    ) -> None:
        try:
            stat = path.stat()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        etag = f'"file-{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Cache-Control", cache_control)
        self.send_header("ETag", etag)
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{safe_name(download_name)}"')
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            return

    def send_sse(self, initial_version: int) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        version = initial_version
        try:
            while True:
                current = STORE.current_version()
                if current != version:
                    payload = compact_json({"version": current, "now": utc_now()}).decode("utf-8")
                    self.wfile.write(f"id: {current}\nevent: state\ndata: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    version = current
                next_version = STORE.wait_for_version(version, SSE_HEARTBEAT_SECONDS)
                if next_version == version:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return

    def do_HEAD(self) -> None:
        if urlparse(self.path).path == "/api/events":
            self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.do_GET()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/state":
            state = STORE.snapshot()
            self.send_json(HTTPStatus.OK, state, etag=f'"state-{state["version"]}"')
            return

        if path == "/api/events":
            try:
                initial = int((query.get("version") or ["-1"])[0])
            except ValueError:
                initial = -1
            self.send_sse(initial)
            return

        if path == "/api/details/tests":
            details = REPOSITORY.tests_details()
            if not details:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "no tests report available"})
                return
            run_dir = REPOSITORY.latest("tests")
            assert run_dir is not None
            signature = marker_signature(run_dir, ArtifactRepository.TEST_MARKERS)
            etag = '"tests-' + signature_token(signature) + '"'
            self.send_json(HTTPStatus.OK, details, etag=etag)
            return

        if path == "/api/details/benchmark":
            details = REPOSITORY.benchmark_details()
            if not details:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "no benchmark report available"})
                return
            run_dir = REPOSITORY.latest("benchmark")
            assert run_dir is not None
            signature = marker_signature(run_dir, ArtifactRepository.BENCH_MARKERS)
            etag = '"benchmark-' + signature_token(signature) + '"'
            self.send_json(HTTPStatus.OK, details, etag=etag)
            return

        if path == "/api/format-results":
            run_dir = REPOSITORY.latest("tests")
            if run_dir is None:
                self.send_json(HTTPStatus.OK, {"available": False, "items": [], "total": 0})
                return
            status_filter = (query.get("status") or ["failures"])[0]
            if status_filter not in {"failures", "all"}:
                status_filter = "failures"
            search = (query.get("q") or [""])[0][:200]
            try:
                offset = max(0, int((query.get("offset") or ["0"])[0]))
                limit = max(1, min(100, int((query.get("limit") or [str(FORMAT_PAGE_SIZE)])[0])))
            except ValueError:
                offset = 0
                limit = FORMAT_PAGE_SIZE
            payload = load_format_page(run_dir, status_filter, search, offset, limit)
            signature = (file_signature(run_dir / "format_results.json"), status_filter, search, offset, limit)
            etag = '"format-page-' + signature_token(signature) + '"'
            self.send_json(HTTPStatus.OK, payload, etag=etag)
            return

        if path == "/api/format-case":
            run_dir = REPOSITORY.latest("tests")
            if run_dir is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "no tests report available"})
                return
            file_name = (query.get("file") or [""])[0]
            if not file_name or Path(file_name).name != file_name:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid format case"})
                return
            payload = load_format_case(run_dir, file_name)
            if payload is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "format case not found"})
                return
            signature = (file_signature(run_dir / "format_results.json"), file_name)
            etag = '"format-case-' + signature_token(signature) + '"'
            self.send_json(HTTPStatus.OK, payload, etag=etag)
            return

        if path.startswith("/api/log/"):
            kind = safe_name(path.rsplit("/", 1)[-1])
            if kind not in {"tests", "benchmark"}:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid log kind"})
                return
            client_key = (query.get("key") or [""])[0]
            try:
                offset = int((query.get("offset") or ["0"])[0])
                limit = int((query.get("limit") or [str(LOG_CHUNK_BYTES)])[0])
            except ValueError:
                offset = 0
                limit = LOG_CHUNK_BYTES
            self.send_json(HTTPStatus.OK, read_log_chunk(kind, client_key, offset, limit), cache_control="no-store")
            return

        if path.startswith("/api/artifacts/"):
            kind = safe_name(path.rsplit("/", 1)[-1])
            if kind not in {"tests", "benchmark"}:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid artifact kind"})
                return
            payload = REPOSITORY.list_artifacts(kind)
            etag = f'"artifacts-{kind}-{payload.get("run_id") or "none"}"'
            self.send_json(HTTPStatus.OK, payload, etag=etag)
            return

        if path in {"/api/report/tests.zip", "/api/report/benchmark.zip"}:
            kind = "tests" if path.endswith("tests.zip") else "benchmark"
            report = report_zip_for(kind)
            if report is None:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": f"no {kind} report available"})
                return
            run_dir = REPOSITORY.latest(kind)
            run_id = run_dir.name if run_dir is not None else "latest"
            self.send_path(report, download_name=f"chdash-{kind}-report-{run_id}.zip", cache_control="no-store")
            return

        if path == "/api/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "version": STORE.current_version(),
                    "active": STORE.has_active(),
                    "time": utc_now(),
                },
                cache_control="no-store",
            )
            return

        if path in {"/", "/index.html"}:
            self.send_path(STATIC_ROOT / "index.html", cache_control="no-cache")
            return

        if path.startswith("/static/"):
            name = unquote(path[len("/static/") :])
            target = (STATIC_ROOT / name).resolve()
            static_root = STATIC_ROOT.resolve()
            if target != static_root and static_root not in target.parents:
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            self.send_path(target, cache_control="public, max-age=0, must-revalidate")
            return

        if path.startswith("/artifacts/"):
            rel = unquote(path[len("/artifacts/") :])
            target = (ARTIFACTS_ROOT / rel).resolve()
            artifacts_root = ARTIFACTS_ROOT.resolve()
            if target != artifacts_root and artifacts_root not in target.parents:
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if target.is_dir():
                files: list[dict[str, Any]] = []
                try:
                    children = sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
                except OSError:
                    children = []
                for child in children[:1000]:
                    try:
                        stat = child.stat()
                    except OSError:
                        continue
                    files.append(
                        {
                            "name": child.name,
                            "dir": child.is_dir(),
                            "url": artifact_url(child),
                            "size": stat.st_size if child.is_file() else None,
                            "mtime": int(stat.st_mtime),
                        }
                    )
                self.send_json(HTTPStatus.OK, {"path": rel, "files": files})
                return
            self.send_path(target)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/run/"):
            kind = safe_name(path.rsplit("/", 1)[-1])
            try:
                job = STORE.start(kind)
            except RuntimeError as exc:
                self.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": str(exc)}, cache_control="no-store")
                return
            except Exception as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)}, cache_control="no-store")
                return
            self.send_json(HTTPStatus.ACCEPTED, {"ok": True, "job": STORE._job_to_dict(job)}, cache_control="no-store")
            return

        if path == "/api/cancel":
            self.send_json(HTTPStatus.OK, {"ok": STORE.cancel()}, cache_control="no-store")
            return

        self.send_error(HTTPStatus.NOT_FOUND)


def auto_start() -> None:
    if not AUTO_TESTS and not AUTO_BENCHMARK:
        return
    time.sleep(1.0)
    kind = "all" if AUTO_TESTS and AUTO_BENCHMARK else "benchmark" if AUTO_BENCHMARK else "tests"
    try:
        STORE.start(kind)
    except Exception as exc:
        print(f"auto {kind} did not start: {exc}", file=sys.stderr)


def main() -> int:
    if AUTO_TESTS or AUTO_BENCHMARK:
        threading.Thread(target=auto_start, daemon=True).start()
    httpd = RunnerHTTPServer((HOST, PORT), Handler)
    print(f"chdash tests runner listening on http://{HOST}:{PORT}", file=sys.stderr)
    print(f"artifacts root: {ARTIFACTS_ROOT}", file=sys.stderr)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
