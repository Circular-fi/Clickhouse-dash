from __future__ import annotations

import importlib.util
import json
import threading
import sys
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import requests

MODULE_PATH = Path(__file__).resolve().parents[1] / "benchmark" / "benchmark_sse.py"
SPEC = importlib.util.spec_from_file_location("chdash_benchmark_sse", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
benchmark = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = benchmark
SPEC.loader.exec_module(benchmark)


@contextmanager
def body_server(
    body: bytes,
    *,
    chunked: bool,
    chunks: list[bytes] | None = None,
) -> Iterator[str]:
    pieces = chunks or [body]

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self) -> None:  # noqa: N802 - stdlib callback name
            length = int(self.headers.get("Content-Length", "0"))
            if length:
                self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header(
                "X-ClickHouse-Summary",
                json.dumps({"elapsed_ns": "2500000"}, separators=(",", ":")),
            )
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()

            if chunked:
                for piece in pieces:
                    self.wfile.write(f"{len(piece):X}\r\n".encode("ascii"))
                    self.wfile.write(piece)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            else:
                self.wfile.write(body)
            self.wfile.flush()

        def log_message(self, _format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def collect(url: str, chunk_size: int = 64 * 1024) -> dict:
    start = time.perf_counter()
    with requests.post(
        url,
        data=b"SELECT 1",
        stream=True,
        timeout=(2, 2),
        headers={"Accept-Encoding": "identity"},
    ) as response:
        response.raise_for_status()
        aggregate, _trace = benchmark.collect_direct_http(response, start, chunk_size)
    return aggregate


def test_direct_http_chunked_stream_is_consumed_by_one_iterator() -> None:
    body = (
        '["number","label"]\n'
        '["UInt64","String"]\n'
        '[1,"caf"]\n'
        '[2,"ok"]\n'
    ).replace("\u0011", "€").encode("utf-8")

    # Deliberately split a UTF-8 code point and the JSON lines across HTTP
    # chunks. The old harness first called raw.read(1) and then raw.stream(),
    # which deterministically raised urllib3 InvalidChunkLength here.
    marker = body.index("€".encode("utf-8"))
    chunks = [body[:1], body[1:marker + 1], body[marker + 1 : marker + 2], body[marker + 2 :]]
    with body_server(body, chunked=True, chunks=chunks) as url:
        aggregate = collect(url)

    assert aggregate["columns"] == ["number", "label"]
    assert aggregate["types"] == ["UInt64", "String"]
    assert aggregate["result_rows_total"] == 2
    assert aggregate["done_payload"]["status"] == "finished"
    assert aggregate["time_to_first_byte_ms"] is not None
    assert aggregate["time_to_first_result_rows_ms"] is not None
    assert aggregate["raw_stream_bytes"] == len(body)
    assert aggregate["json_decode_errors"] == 0


def test_direct_http_content_length_response_is_supported() -> None:
    body = b'["one"]\n["UInt8"]\n[1]\n'
    with body_server(body, chunked=False) as url:
        aggregate = collect(url, chunk_size=3)

    assert aggregate["columns"] == ["one"]
    assert aggregate["types"] == ["UInt8"]
    assert aggregate["result_rows_total"] == 1
    assert aggregate["raw_stream_bytes"] == len(body)


def test_direct_http_sql_strips_semicolons_and_appends_reference_format() -> None:
    sql = benchmark.direct_http_sql({"name": "case", "sql": "SELECT 1;;;  "})
    assert sql == "SELECT 1\nFORMAT JSONCompactEachRowWithNamesAndTypes"


def test_host_parser_ignores_commented_examples(tmp_path: Path) -> None:
    config = tmp_path / "CH_HOSTS.hcl"
    config.write_text(
        '''
clickhouse {
  host {
    name = "local"
    runner_uri = "clickhouse://test:test@clickhouse:9000"
  }
  # host { name = "commented_hash" }
  // host { name = "commented_slashes" }
  /* host { name = "commented_block" } */
}
''',
        encoding="utf-8",
    )
    assert benchmark.parse_host_ids_from_hcl(config) == ["local"]


def test_benchmark_flags_duplicate_sse_content_type_values() -> None:
    assert benchmark.sse_content_type_issues(
        "text/event-stream; charset=utf-8, text/event-stream"
    ) == [
        "invalid_sse_content_type_values:'text/event-stream; charset=utf-8, text/event-stream'"
    ]


def test_benchmark_accepts_single_sse_content_type_value() -> None:
    assert benchmark.sse_content_type_issues("text/event-stream; charset=utf-8") == []


def test_direct_http_overhead_reports_wire_and_verified_baselines() -> None:
    summaries = [
        {
            "target": "http_direct",
            "transport": "clickhouse_http",
            "host_id": "local",
            "query_name": "q",
            "median_done_ms": 2.0,
            "median_verified_done_ms": 8.0,
            "median_verification_ms": 6.0,
            "median_server_elapsed_ms": 1.0,
            "median_first_byte_ms": 1.5,
            "median_first_row_ms": 1.8,
            "median_raw_stream_bytes": 100,
            "failed_runs": 0,
            "row_hashes_seen": ["rows"],
            "columns_signatures_seen": ["cols"],
        },
        {
            "target": "source",
            "transport": "dashboard_sse",
            "host_id": "local",
            "query_name": "q",
            "median_done_ms": 6.0,
            "median_first_byte_ms": 2.5,
            "median_first_row_ms": 3.0,
            "median_raw_stream_bytes": 120,
            "failed_runs": 0,
            "row_hashes_seen": ["rows"],
            "columns_signatures_seen": ["cols"],
        },
    ]
    row = benchmark.build_direct_http_overheads(summaries)[0]
    assert row["overhead_ms"] == 4.0
    assert row["duration_ratio_vs_direct_http"] == 3.0
    assert row["verified_overhead_ms"] == -2.0
    assert row["duration_ratio_vs_verified_direct_http"] == 0.75
    assert row["row_hash_match"] is True
    assert row["columns_match"] is True


def dashboard_summary(
    target: str,
    *,
    result_row_events: int,
    tick_events: int,
    tick_schema: str,
) -> dict:
    counts = {
        "meta": 1,
        "result_meta": 1,
        "result_rows": result_row_events,
        "tick": tick_events,
        "done": 1,
        "error": 0,
    }
    return {
        "target": target,
        "transport": "dashboard_sse",
        "host_id": "local",
        "query_name": "q",
        "median_done_ms": 10.0 if target == "source" else 12.0,
        "median_first_row_ms": 3.0,
        "median_total_events": sum(counts.values()),
        "median_result_row_events": result_row_events,
        "median_tick_events": tick_events,
        "event_count_medians": counts,
        "semantic_failed_runs": 0,
        "failed_runs": 0,
        "transport_warning_runs": 0,
        "row_hashes_seen": ["same-rows"],
        "columns_signatures_seen": ["same-columns"],
        "core_event_sequences_seen": [["meta", "result_meta", "result_rows", "done"]],
        "tick_schemas_seen": [tick_schema],
        "telemetry_sources_seen": ["clickhouse_native_tcp" if tick_schema == "v2" else "legacy"],
    }


def test_operational_event_count_differences_are_non_blocking() -> None:
    summaries = [
        dashboard_summary("source", result_row_events=10, tick_events=2, tick_schema="v2"),
        dashboard_summary("release", result_row_events=50, tick_events=3, tick_schema="legacy"),
    ]
    comparisons = benchmark.compare_targets(
        summaries,
        baseline_name="source",
        strict_event_counts=False,
        optional_events={"keepalive", "message"},
    )
    assert len(comparisons) == 1
    comparison = comparisons[0]
    assert comparison["correctness_classification"] == "equivalent"
    assert comparison["event_count_match"] is True
    assert comparison["raw_event_count_match"] is False
    assert comparison["result_batching_differs"] is True
    assert comparison["tick_cadence_differs"] is True
    assert comparison["telemetry_schema_differs"] is True

    issues, warnings = benchmark.compute_findings(
        results=[],
        comparisons=comparisons,
        direct_http_overheads=[],
        strict_event_counts=False,
        baseline_name="source",
    )
    assert issues == []
    assert any("result_rows count differs" in warning for warning in warnings)
    assert any("tick count differs" in warning for warning in warnings)
    assert any("telemetry schema differs" in warning for warning in warnings)


def test_strict_mode_can_promote_operational_event_count_differences() -> None:
    summaries = [
        dashboard_summary("source", result_row_events=10, tick_events=2, tick_schema="v2"),
        dashboard_summary("release", result_row_events=50, tick_events=3, tick_schema="legacy"),
    ]
    comparisons = benchmark.compare_targets(
        summaries,
        baseline_name="source",
        strict_event_counts=True,
        optional_events={"keepalive", "message"},
    )
    issues, _warnings = benchmark.compute_findings(
        results=[],
        comparisons=comparisons,
        direct_http_overheads=[],
        strict_event_counts=True,
        baseline_name="source",
    )
    assert any("strict operational event count mismatch" in issue for issue in issues)
