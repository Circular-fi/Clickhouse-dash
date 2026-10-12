"""The release smoke test (tests/smoke/release_smoke.py) run against a stand-in server: it passes on a healthy one and fails on the answer of
v2.16.3 (/observability answered 404 in the release binary). The smoke test itself runs against the real release binary in CI
(.github/workflows/release-smoke.yml) and in the release workflow before anything is published."""
import os
import re
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()


FAKE_SERVER = textwrap.dedent('''\
    #!{python}
    """A stand-in for the release binary: the routes of the smoke test, with or without the 2.16.3 bug."""
    import base64, gzip, hashlib, json, re, signal, sys
    from http.server import BaseHTTPRequestHandler, HTTPServer

    BROKEN = {broken}
    port = int(re.search(r"listen_port = (\\d+)", open(sys.argv[2]).read()).group(1))
    JS = b"console.log('chdash');" * 100
    SCRIPT = b'window.__chdashAssetVersions={{"static/app_common.js":"0123456789ab","static/wasm/highlight.wasm":"ba9876543210"}}'
    PAGE = b'<html><head><script>' + SCRIPT + b'</script><title>ChDash</title></head></html>'
    POLICY = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-" + base64.b64encode(hashlib.sha256(SCRIPT).digest()).decode() + "'; frame-ancestors 'none'"
    SECURITY = [("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "DENY"), ("Referrer-Policy", "same-origin")]
    # SIGTERM ends the server with status 0, as the binary does.
    signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, body=b"", ctype="text/html; charset=utf-8", headers=()):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            policy = [("Content-Security-Policy", POLICY if body == PAGE else "default-src 'self'; frame-ancestors 'none'")]
            for key, value in list(headers) + SECURITY + policy:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path != "/mcp":
                return self.send(404, b"not found", "text/plain")
            if self.headers.get("Authorization", "") != "Bearer 5a0c0000-0000-4000-8000-000000000012":
                return self.send(401, b'{{"error":"unauthorized"}}', "application/json")
            return self.send(200, b'{{"jsonrpc":"2.0","id":1,"result":{{"tools":[{{"name":"list_hosts"}}]}}}}', "application/json")

        def do_GET(self):
            path, _, query = self.path.partition("?")
            suffix = "?" + query if query else ""
            if path == "/observability":
                if BROKEN:
                    return self.send(404, b"no observability view is enabled", "text/plain")
                return self.send(302, headers=[("Location", "observability/traces" + suffix)])
            if re.fullmatch(r"/observability/(zzz)", path):
                return self.send(302, headers=[("Location", "traces?redirected_from=%2Fobservability%2Fzzz")])
            if path == "/explorer":
                return self.send(302, headers=[("Location", "explorer/catalog")])
            if path == "/system/zzz":
                return self.send(302, headers=[("Location", "../system?redirected_from=%2Fsystem%2Fzzz")])
            if path == "/static/app_common.js":
                accepts = "gzip" in self.headers.get("Accept-Encoding", "")
                headers = [("Cache-Control", "public, max-age=31536000, immutable" if query == "v=0123456789ab" else "no-store")]
                if accepts:
                    return self.send(200, gzip.compress(JS), "text/javascript", headers + [("Content-Encoding", "gzip")])
                return self.send(200, JS, "text/javascript", headers)
            if path == "/static/wasm/highlight.wasm":
                module = b"\\0asm\\x01\\0\\0\\0" * 20
                headers = [("Cache-Control", "public, max-age=31536000, immutable")]
                if "gzip" in self.headers.get("Accept-Encoding", ""):
                    return self.send(200, gzip.compress(module), "application/wasm", headers + [("Content-Encoding", "gzip")])
                return self.send(200, module, "application/wasm", headers)
            if path == "/api/mcp/meta":
                return self.send(200, b'{{"enabled":true,"endpoint_path":"/mcp"}}', "application/json")
            if path in ("/", "/mcp-integration", "/query", "/observability/traces", "/observability/logs", "/observability/metrics",
                        "/explorer/catalog", "/explorer/functions", "/system", "/system/queries", "/system/disks") \\
                    or path.startswith("/observability/traces/"):
                return self.send(200, PAGE)
            if path == "/api/version":
                features = {{name: {{"enabled": True}} for name in ("explorer", "system", "traces", "logs", "metrics", "query_library", "mcp")}}
                return self.send(200, json.dumps({{"name": "clickhouse-dash", "version": "x", "features": features}}).encode(), "application/json")
            if path == "/api/health":
                return self.send(503, b'{{"ok":false,"total_hosts":1}}', "application/json")
            if path == "/livez":
                return self.send(200, b"ok", "text/plain")
            if path == "/readyz":
                return self.send(503, b'{{"ready":false,"stopping":false,"healthy_hosts":0,"total_hosts":1}}', "application/json")
            if path == "/metrics":
                return self.send(200, b"chdash_build_info 1\\n", "text/plain; version=0.0.4")
            if path in ("/api/hosts", "/api/logs/meta", "/api/metrics/meta"):
                return self.send(200, b"{{}}", "application/json")
            if path == "/api/query-library":
                return self.send(200, b'{{"folders":[]}}', "application/json")
            self.send(404, b"not found", "text/plain")

    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
''')


def run_smoke(tmp_path: Path, broken: bool) -> subprocess.CompletedProcess:
    fake = tmp_path / ("broken" if broken else "good")
    fake.write_text(FAKE_SERVER.format(python=sys.executable, broken=broken), encoding="utf-8")
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    return subprocess.run(
        [sys.executable, str(ROOT / "tests/smoke/release_smoke.py"), "--binary", str(fake)],
        capture_output=True, text=True, timeout=120,
    )


def test_release_smoke_passes_on_a_healthy_server(tmp_path: Path) -> None:
    result = run_smoke(tmp_path, broken=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "ok    /observability 302" in result.stdout
    assert "ok    static assets" in result.stdout
    assert "ok    wasm kernels" in result.stdout and "ok    mcp" in result.stdout
    assert "ok    security headers (1 inline scripts)" in result.stdout
    assert "ok    /livez 200" in result.stdout and "ok    /readyz 503" in result.stdout
    assert "ok    stop on SIGTERM" in result.stdout
    assert "release smoke test passed" in result.stdout


def test_release_smoke_fails_on_the_v2_16_3_answer(tmp_path: Path) -> None:
    # v2.16.3 answered /observability with 404 "no observability view is enabled" in the release binary.
    result = run_smoke(tmp_path, broken=True)
    assert result.returncode == 1, result.stdout + result.stderr
    assert "FAIL  /observability: status 404, expected 302" in result.stdout
