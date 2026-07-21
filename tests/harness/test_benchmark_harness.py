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
    ).replace("\u0011", "é").encode("utf-8")

    # Deliberately split a UTF-8 code point and the JSON lines across HTTP
    # chunks. The old harness first called raw.read(1) and then raw.stream(),
    # which deterministically raised urllib3 InvalidChunkLength here.
    marker = body.index("é".encode("utf-8"))
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
