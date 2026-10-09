#!/usr/bin/env python3
"""Smoke test of the release binary.

The test image is not the shipped binary: the release is static, stripped, optimized, serves its
files from the embedded copy and has its own libc. v2.16.3 passed every test of the test image and
answered /observability with 404 in the release binary (a handler read a destroyed local lambda).
This script starts the binary with a production-like configuration (tests/smoke/release-smoke.hcl:
every page on, ClickHouse unreachable) and probes the routes that must answer.

    python3 tests/smoke/release_smoke.py --binary build/chdash            # run the binary as a process
    python3 tests/smoke/release_smoke.py --binary build/chdash --scratch  # run it in a FROM scratch container

Exit status: 0 when every probe passes, 1 when a probe fails or the server dies, 2 on a setup error.
"""
from __future__ import annotations

import argparse
import contextlib
import gzip
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "release-smoke.hcl"
STARTUP_SECONDS = 30
HTML = "text/html"

# (path, status or tuple of statuses, extra checks). "location" is the exact Location header of a redirect; "type" a
# Content-Type prefix; "has" a text that the body must hold; "json" the keys the JSON body must hold.
PROBES = [
    ("/", 200, {"type": HTML, "has": "<title>"}),
    ("/query", 200, {"type": HTML, "has": "<title>"}),
    ("/observability", 302, {"location": "observability/traces"}),
    ("/observability?x=1", 302, {"location": "observability/traces?x=1"}),
    ("/observability/zzz", 302, {"location": "traces"}),
    ("/observability/traces", 200, {"type": HTML}),
    ("/observability/logs", 200, {"type": HTML}),
    ("/observability/metrics", 200, {"type": HTML}),
    ("/observability/traces/0123456789abcdef0123456789abcdef", 200, {"type": HTML}),
    ("/explorer", 302, {"location": "explorer/catalog"}),
    ("/explorer/catalog", 200, {"type": HTML}),
    ("/explorer/functions", 200, {"type": HTML}),
    ("/system", 200, {"type": HTML}),
    ("/system/queries", 200, {"type": HTML}),
    ("/system/disks", 200, {"type": HTML}),
    ("/mcp-integration", 200, {"type": HTML}),
    ("/api/mcp/meta", 200, {"type": "application/json", "json": ["enabled", "endpoint_path"]}),
    ("/system/zzz", 302, {"location": "../system"}),
    ("/static/does-not-exist.js", 404, {}),
    ("/api/version", 200, {"type": "application/json", "json": ["name", "version", "features"]}),
    # ClickHouse is unreachable: these answer 503 with a JSON body (a crash or a 404 is the failure).
    ("/api/health", (200, 503), {"type": "application/json", "json": ["ok", "total_hosts"]}),
    ("/api/hosts", 200, {"type": "application/json"}),
    ("/api/logs/meta", (200, 503), {"type": "application/json"}),
    ("/api/metrics/meta", (200, 503), {"type": "application/json"}),
]
FEATURES = ["explorer", "system", "traces", "logs", "metrics", "query_library", "mcp"]
# The staged shells carry the version of every script and stylesheet: window.__chdashAssetVersions={"static/app.js":"<hash>",...}
VERSIONS = re.compile(r"window\.__chdashAssetVersions=(\{[^}]*\})")


class Failure(Exception):
    pass


def get(port: int, path: str, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def post(port: int, path: str, body: bytes, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        connection.request("POST", path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def free_port() -> int:
    with contextlib.closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def write_config(source: Path, target: Path, library: str, port: int) -> None:
    text = source.read_text(encoding="utf-8")
    text = text.replace('file     = "/data/query_library.json"', f'file     = "{library}"')
    text = re.sub(r"listen_port = \d+", f"listen_port = {port}", text)
    target.write_text(text, encoding="utf-8")


class Process:
    """The binary as a child process."""

    def __init__(self, binary: Path, config: Path, work: Path):
        self.log = work / "server.log"
        self._log = self.log.open("wb")
        self.proc = subprocess.Popen([str(binary), "--config", str(config)], stdout=self._log, stderr=subprocess.STDOUT)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def stop(self) -> None:
        if self.alive():
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self._log.close()

    def logs(self) -> str:
        return self.log.read_text(errors="replace")

    def describe_exit(self) -> str:
        code = self.proc.returncode
        return f"exit status {code}" + (f" (signal {signal.Signals(-code).name})" if code is not None and code < 0 else "")


class Scratch:
    """The binary in a container built FROM scratch: no libc, no shell, no files but the binary."""

    def __init__(self, binary: Path, config: Path, work: Path, port: int):
        context = work / "context"
        context.mkdir()
        shutil.copy(binary, context / "chdash")
        shutil.copy(config, context / "chdash.hcl")
        (context / "Dockerfile").write_text(
            "FROM scratch\nCOPY chdash /chdash\nCOPY chdash.hcl /chdash.hcl\n"
            'ENTRYPOINT ["/chdash", "--config", "/chdash.hcl"]\n'
        )
        self.tag = f"chdash-release-smoke:{os.getpid()}"
        self.name = f"chdash-release-smoke-{os.getpid()}"
        run(["docker", "build", "-q", "-t", self.tag, str(context)])
        run(["docker", "run", "-d", "--name", self.name, "--read-only", "--tmpfs", "/data",
             "-p", f"127.0.0.1:{port}:8080", self.tag])

    def alive(self) -> bool:
        out = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", self.name], capture_output=True, text=True)
        return out.stdout.strip() == "true"

    def stop(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)
        subprocess.run(["docker", "rmi", "-f", self.tag], capture_output=True)

    def logs(self) -> str:
        out = subprocess.run(["docker", "logs", self.name], capture_output=True, text=True)
        return out.stdout + out.stderr

    def describe_exit(self) -> str:
        out = subprocess.run(["docker", "inspect", "-f", "{{.State.ExitCode}}", self.name], capture_output=True, text=True)
        return f"exit status {out.stdout.strip()}"


def run(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"setup error: {' '.join(command)}\n{result.stdout}{result.stderr}")


def wait_until_up(server, port: int) -> None:
    deadline = time.time() + STARTUP_SECONDS
    while time.time() < deadline:
        if not server.alive():
            raise Failure(f"the server stopped at start ({server.describe_exit()})")
        try:
            if get(port, "/api/version")[0] == 200:
                return
        except OSError:
            time.sleep(0.2)
    raise Failure(f"the server did not answer within {STARTUP_SECONDS} s")


def check_probe(port: int, path: str, status: int | tuple[int, ...], checks: dict) -> str:
    code, headers, body = get(port, path)
    allowed = status if isinstance(status, tuple) else (status,)
    if code not in allowed:
        expected = " or ".join(str(item) for item in allowed)
        raise Failure(f"{path}: status {code}, expected {expected}: {body[:120]!r}")
    if "location" in checks and headers.get("location") != checks["location"]:
        raise Failure(f"{path}: Location {headers.get('location')!r}, expected {checks['location']!r}")
    if "type" in checks and not headers.get("content-type", "").startswith(checks["type"]):
        raise Failure(f"{path}: Content-Type {headers.get('content-type')!r}, expected {checks['type']}")
    if "has" in checks and checks["has"].encode() not in body:
        raise Failure(f"{path}: the body has no {checks['has']!r}")
    if "json" in checks:
        document = json.loads(body)
        missing = [key for key in checks["json"] if key not in document]
        if missing:
            raise Failure(f"{path}: JSON keys missing: {missing}")
    return f"{code}"


def check_features(port: int) -> None:
    features = json.loads(get(port, "/api/version")[2])["features"]
    for name in FEATURES:
        if not features.get(name, {}).get("enabled"):
            raise Failure(f"/api/version: feature {name!r} is not enabled: {features.get(name)!r}")


def check_assets(port: int) -> int:
    """A script or a stylesheet of the page: addressed with ?v=, immutable, and gzip on request."""
    page = get(port, "/query")[2].decode("utf-8", "replace")
    match = VERSIONS.search(page)
    versions = json.loads(match.group(1)) if match else {}
    if not versions:
        raise Failure("/query: no window.__chdashAssetVersions in the page (the embedded files carry no version)")
    found = [f"{name}?v={version}" for name, version in sorted(versions.items())[:3]] + [f"static/app.js?v={versions['static/app.js']}"]
    for asset in sorted(set(found)):
        path = "/" + asset
        code, headers, body = get(port, path, {"Accept-Encoding": "gzip"})
        if code != 200:
            raise Failure(f"{path}: status {code}")
        if "immutable" not in headers.get("cache-control", ""):
            raise Failure(f"{path}: Cache-Control {headers.get('cache-control')!r} is not immutable")
        if headers.get("content-encoding") != "gzip":
            raise Failure(f"{path}: no gzip copy (Content-Encoding {headers.get('content-encoding')!r})")
        packed = gzip.decompress(body)
        code, headers, plain = get(port, path)
        if code != 200 or "content-encoding" in headers or plain != packed:
            raise Failure(f"{path}: the plain copy differs from the gzip copy or carries Content-Encoding")
    return len(set(found))


def check_wasm(port: int) -> str:
    """A WebAssembly kernel is served as application/wasm, immutable, with a gzip copy, and compiles as a module."""
    page = get(port, "/query")[2].decode("utf-8", "replace")
    match = VERSIONS.search(page)
    versions = json.loads(match.group(1)) if match else {}
    kernels = sorted(name for name in versions if name.endswith(".wasm"))
    if not kernels:
        # Kernels are lazy groups: the shells list the versions of every file, so a missing entry means none is staged.
        raise Failure("/query: no .wasm file in window.__chdashAssetVersions")
    for name in kernels:
        path = f"/{name}?v={versions[name]}"
        code, headers, body = get(port, path, {"Accept-Encoding": "gzip"})
        if code != 200:
            raise Failure(f"{path}: status {code}")
        if headers.get("content-type", "").split(";")[0].strip() != "application/wasm":
            raise Failure(f"{path}: Content-Type {headers.get('content-type')!r}, expected application/wasm")
        if "immutable" not in headers.get("cache-control", ""):
            raise Failure(f"{path}: Cache-Control {headers.get('cache-control')!r} is not immutable")
        if headers.get("content-encoding") != "gzip":
            raise Failure(f"{path}: no gzip copy (Content-Encoding {headers.get('content-encoding')!r})")
        if gzip.decompress(body)[:4] != b"\0asm":
            raise Failure(f"{path}: the body is not a WebAssembly module")
    return f"{len(kernels)} kernels"


def check_mcp(port: int) -> str:
    """The MCP endpoint is on, wants a key, and answers a key; the cross-site guard stays on."""
    code, _, _ = post(port, "/mcp", b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
    if code != 401:
        raise Failure(f"/mcp without a key: status {code}, expected 401")
    code, _, body = post(port, "/mcp", b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
                         {"Authorization": "Bearer 5a0c0000-0000-4000-8000-000000000012"})
    if code != 200 or b"list_hosts" not in body:
        raise Failure(f"/mcp tools/list with a key: status {code}: {body[:120]!r}")
    return "tools/list"


def check_query_library(port: int) -> None:
    # The write path of the library creates its file: a read only host is fine, a crash is not.
    code, _, body = get(port, "/api/query-library?host_id=unreachable")
    if code != 200:
        raise Failure(f"/api/query-library: status {code}: {body[:120]!r}")
    if "folders" not in json.loads(body):
        raise Failure("/api/query-library: no 'folders' in the answer")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", required=True, type=Path, help="the chdash binary of the release build")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--scratch", action="store_true", help="run the binary in a FROM scratch container (needs Docker)")
    args = parser.parse_args()
    if not args.binary.is_file() or not os.access(args.binary, os.X_OK):
        print(f"setup error: {args.binary} is not an executable file", file=sys.stderr)
        return 2

    port = free_port()
    with tempfile.TemporaryDirectory(prefix="chdash-smoke-") as work_name:
        work = Path(work_name)
        config = work / "chdash.hcl"
        write_config(args.config, config, "/data/query_library.json" if args.scratch else str(work / "query_library.json"),
                     8080 if args.scratch else port)
        server = Scratch(args.binary.resolve(), config, work, port) if args.scratch else Process(args.binary.resolve(), config, work)
        failures: list[str] = []
        try:
            wait_until_up(server, port)
            for path, status, checks in PROBES:
                try:
                    result = check_probe(port, path, status, checks)
                    print(f"ok    {path} {result}")
                except (Failure, OSError, ValueError) as error:
                    failures.append(str(error))
                    print(f"FAIL  {error}")
            for label, check in (("features", check_features), ("static assets", check_assets), ("wasm kernels", check_wasm), ("mcp", check_mcp), ("query library", check_query_library)):
                try:
                    detail = check(port)
                    print(f"ok    {label}" + (f" ({detail})" if detail else ""))
                except (Failure, OSError, ValueError, KeyError) as error:
                    failures.append(f"{label}: {error}")
                    print(f"FAIL  {label}: {error}")
            if not server.alive():
                failures.append(f"the server died during the probes ({server.describe_exit()})")
        except Failure as error:
            failures.append(str(error))
            print(f"FAIL  {error}")
        finally:
            tail = server.logs()[-3000:]
            server.stop()
        if failures:
            print(f"\n{len(failures)} failure(s). Server log (tail):\n{tail}", file=sys.stderr)
            return 1
    print("release smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
