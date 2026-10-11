"""The HTTP hardening of the server (docs/operations.md): the security headers, the policy of the page shells, the
guard of the writes, the probes, the metrics, the request ids, the JSON answer of every error, and the cache of a
versioned static asset.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})

# Every write of the API (POST, PATCH, DELETE), with a body that would be valid JSON for the route or close to it.
WRITES = [
    ("POST", "/api/format", {"queries": ["SELECT 1"], "host_id": "local"}),
    ("POST", "/api/query/run", {"sql": "SELECT 1", "host_id": "local"}),
    ("POST", "/api/query", {"sql": "SELECT 1", "host_id": "local"}),
    ("POST", "/api/query/cancel", {"cancel_token": "x"}),
    ("POST", "/api/query/analysis", {"query_id": "x", "host_id": "local"}),
    ("POST", "/api/query/deep-analysis", {"query_id": "x", "host_id": "local"}),
    ("POST", "/api/query/deep-analysis/cancel", {"job_id": "x", "host_id": "local"}),
    ("POST", "/api/export/run", {"queries": ["SELECT 1"], "host_id": "local"}),
    ("POST", "/api/export/stream", {"token": "x"}),
    ("POST", "/api/explorer/table/data", {"host_id": "local", "database": "system", "table": "one"}),
    ("POST", "/api/mcp/keys", {"name": "x"}),
    ("DELETE", "/api/mcp/keys/x", None),
    ("POST", "/api/query-library/folders", {"host_id": "local", "name": "x"}),
    ("PATCH", "/api/query-library/folders/f_x", {"name": "x"}),
    ("DELETE", "/api/query-library/queries/q_x", None),
]


def get(path: str, **kwargs) -> requests.Response:
    return SESSION.get(f"{BASE_URL}{path}", timeout=30, allow_redirects=False, **kwargs)


def error_code(response: requests.Response) -> str:
    body = response.json()
    assert body.get("error_code") == body.get("error") or "error" not in body, body
    return body.get("error_code") or body.get("error")


def test_every_answer_carries_the_security_headers():
    for path in ("/api/version", "/api/hosts", "/static/app_common.js", "/no-such-path", "/livez"):
        response = get(path)
        headers = response.headers
        assert headers["X-Content-Type-Options"] == "nosniff", path
        assert headers["X-Frame-Options"] == "DENY", path
        assert headers["Referrer-Policy"] == "same-origin", path
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"], path
        assert len(response.raw.headers.getlist("Content-Security-Policy")) == 1, path
        assert re.fullmatch(r"[0-9a-f]{16}", headers["X-Request-Id"]), path


def test_a_page_runs_only_the_inline_scripts_of_its_shell():
    for path in ("/", "/query", "/explorer/catalog", "/system", "/mcp-integration"):
        response = get(path)
        assert response.status_code == 200, path
        policy = response.headers["Content-Security-Policy"]
        assert len(response.raw.headers.getlist("Content-Security-Policy")) == 1, path
        scripts = re.findall(r"<script(\s[^>]*)?>(.*?)</script", response.text, re.DOTALL | re.IGNORECASE)
        expected = []
        for attributes, body in scripts:
            attributes = (attributes or "").lower()
            if "src=" in attributes or "application/json" in attributes:
                continue
            expected.append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
        assert expected, path
        script_src = re.search(r"script-src ([^;]*);", policy).group(1).split()
        assert script_src[:2] == ["'self'", "'wasm-unsafe-eval'"], policy
        assert script_src[2:] == expected, path
        assert "'unsafe-inline'" not in script_src and "'unsafe-eval'" not in script_src


def test_a_request_id_from_a_proxy_is_kept():
    response = get("/api/version", headers={"X-Request-Id": "proxy-id.42:abc"})
    assert response.headers["X-Request-Id"] == "proxy-id.42:abc"
    response = get("/api/version", headers={"X-Request-Id": "not ok\tid"})
    assert re.fullmatch(r"[0-9a-f]{16}", response.headers["X-Request-Id"])


@pytest.mark.parametrize("method,path,body", WRITES)
def test_a_write_from_another_site_is_refused(method, path, body):
    for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                    {"Origin": "https://evil.example"}, {"Origin": "null"}):
        response = SESSION.request(method, BASE_URL + path, json=body, headers=headers, timeout=30)
        assert response.status_code == 403, (path, headers, response.text)
        assert error_code(response) == "cross_site_request"
        assert response.headers.get("Cache-Control") == "no-store"


@pytest.mark.parametrize("method,path,body", [w for w in WRITES if w[2] is not None])
def test_a_write_body_must_be_json(method, path, body):
    for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", None):
        headers = {"Content-Type": content_type} if content_type else {}
        response = SESSION.request(method, BASE_URL + path, data=json.dumps(body).encode(), headers=headers, timeout=30)
        if content_type is None:
            # requests sends no Content-Type for bytes.
            assert "Content-Type" not in response.request.headers
        assert response.status_code == 415, (path, content_type, response.text)
        assert error_code(response) == "unsupported_media_type"


def test_a_write_from_the_page_itself_passes_the_guard():
    host = BASE_URL.split("//", 1)[1]
    for headers in ({"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "none"}, {"Origin": f"http://{host}"},
                    {"Origin": "https://dash.example.com", "X-Forwarded-Host": "dash.example.com"}, {}):
        response = SESSION.post(BASE_URL + "/api/format", json={"queries": ["SELECT 1"], "host_id": "local"}, headers=headers, timeout=60)
        assert response.status_code not in (403, 415), (headers, response.text)


def test_a_read_from_another_site_is_not_a_write():
    assert get("/api/version", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200
    assert get("/api/hosts", headers={"Origin": "https://evil.example"}).status_code == 200


def test_the_probes():
    live = get("/livez")
    assert live.status_code == 200 and live.text == "ok"
    assert live.headers["Cache-Control"] == "no-store"
    ready = get("/readyz")
    assert ready.status_code == 200, ready.text
    assert ready.json() == {"ready": True, "stopping": False, "healthy_hosts": ready.json()["total_hosts"],
                            "total_hosts": ready.json()["total_hosts"]}
    assert ready.json()["total_hosts"] >= 1
    assert get("/healthz").status_code == 200


def test_the_metrics_text():
    get("/api/version")
    response = get("/metrics")
    assert response.status_code == 200
    assert response.headers["Content-Type"].startswith("text/plain; version=0.0.4")
    text = response.text
    for family in ("chdash_build_info", "chdash_uptime_seconds", "chdash_stopping", "chdash_http_requests_total",
                   "chdash_http_request_duration_seconds", "chdash_http_requests_in_flight", "chdash_http_connections_active",
                   "chdash_http_connections_queued", "chdash_http_connections_refused_total", "chdash_query_sessions",
                   "chdash_query_threads", "chdash_query_streams", "chdash_host_streams", "chdash_exports_active",
                   "chdash_host_up", "chdash_clickhouse_connections", "chdash_clickhouse_connections_opened_total",
                   "chdash_clickhouse_connections_invalidated_total"):
        assert f"# TYPE {family} " in text, family
    assert re.search(r'^chdash_http_requests_total\{method="GET",route="/api/version",code="200"\} \d+$', text, re.M)
    assert re.search(r'^chdash_host_up\{host="local"\} 1$', text, re.M)
    assert "chdash_stopping 0\n" in text
    # The URIs of the hosts carry passwords: the metrics name hosts and identities only.
    assert "clickhouse://" not in text and "runner_test" not in text
    for line in text.splitlines():
        assert line.startswith("#") or re.fullmatch(r'[a-z_]+(\{.*\})? (-?[0-9.e+-]+|NaN|\+Inf)', line), line


def test_an_error_of_the_http_layer_is_json():
    response = get("/no-such-path")
    assert response.status_code == 404
    assert response.headers["Content-Type"].startswith("application/json")
    assert error_code(response) == "not_found"
    response = SESSION.put(BASE_URL + "/api/version", timeout=30)
    assert response.status_code in (404, 405)
    assert response.headers["Content-Type"].startswith("application/json")


def test_a_versioned_asset_is_immutable_only_with_its_own_version():
    body = get("/static/app_common.js").content
    version = hashlib.sha256(body).hexdigest()[:12]
    own = get(f"/static/app_common.js?v={version}")
    assert own.status_code == 200
    assert own.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    for other in ("0123456789ab", "x", "", version.upper()):
        stale = get(f"/static/app_common.js?v={other}")
        assert stale.status_code == 200 and stale.content == body
        assert stale.headers["Cache-Control"] == "no-store", other
    assert get("/static/app_common.js").headers["Cache-Control"] == "public, max-age=0, must-revalidate"
    # The icon sprite of the shells (tools/icons.py: ten digits).
    sprite = get("/static/icons.svg").content
    assert get(f"/static/icons.svg?v={hashlib.sha256(sprite).hexdigest()[:10]}").headers["Cache-Control"].endswith("immutable")
    # A shell is never immutable, whatever ?v= it is given.
    assert "immutable" not in get(f"/?v={version}").headers["Cache-Control"]
