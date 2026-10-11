"""The production asset path: the files embedded in the binary (tests/docker-compose.yml, chdash_embedded; EMBEDDED_BASE_URL).

The build stages the static files (tools/stage_static.py: a hash in every asset address and in every import, a gzip copy of
each file worth it) and embeds them. The test image serves them from the filesystem, so these answers are only seen here: the
hash that a shell names is the hash of the bytes that the server sends, a versioned address is immutable and a wrong one is not,
the compressed copy is an answer and never an address, a kernel is application/wasm and byte for byte the committed file, and
the policy of a shell hashes its inline scripts as staged (the staged shell is not the source file). Skipped without the instance.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import re
from pathlib import Path

import pytest
import requests

BASE = os.environ.get("EMBEDDED_BASE_URL", "").rstrip("/")
ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
pytestmark = pytest.mark.skipif(not BASE, reason="EMBEDDED_BASE_URL is not set (the build with the files embedded)")

SESSION = requests.Session()
SHELLS = ("/", "/explorer/catalog", "/explorer/functions", "/observability/traces", "/observability/logs", "/observability/metrics", "/system", "/mcp-integration")


def get(path: str, encoding: str = "identity", **kwargs) -> requests.Response:
    return SESSION.get(BASE + path, headers={"Accept-Encoding": encoding}, timeout=30, allow_redirects=False, **kwargs)


def versions(path: str = "/") -> dict[str, str]:
    html = get(path).text
    match = re.search(r"window\.__chdashAssetVersions=(\{.*?\});", html)
    assert match, f"{path} names no asset versions"
    return json.loads(match.group(1))


def test_the_version_that_a_shell_names_is_the_hash_of_the_bytes_that_are_sent():
    mapping = versions()
    assert len(mapping) > 80
    for asset, version in mapping.items():
        response = get(f"/{asset}?v={version}")
        assert response.status_code == 200, asset
        assert hashlib.sha256(response.content).hexdigest()[:12] == version, asset
        assert response.headers["Cache-Control"] == "public, max-age=31536000, immutable", asset


def test_every_shell_names_the_same_versions():
    reference = versions("/")
    for path in SHELLS[1:]:
        assert versions(path) == reference, path


def test_a_wrong_or_missing_version_is_never_immutable_and_a_shell_never_is():
    asset, version = next(iter(versions().items()))
    for other in ("0123456789ab", "x", version.upper()):
        stale = get(f"/{asset}?v={other}")
        assert stale.status_code == 200 and stale.headers["Cache-Control"] == "no-store", other
    assert "immutable" not in get(f"/{asset}").headers["Cache-Control"]
    for path in SHELLS:
        assert "immutable" not in get(f"{path}?v={version}").headers["Cache-Control"], path


def test_a_compressed_asset_is_the_same_bytes_and_the_gzip_file_is_not_an_address():
    mapping = versions()
    packed = 0
    for asset, version in mapping.items():
        identity = get(f"/{asset}?v={version}", "identity")
        assert "Content-Encoding" not in identity.headers, asset
        compressed = get(f"/{asset}?v={version}", "gzip", stream=True)
        assert compressed.status_code == 200, asset
        if compressed.headers.get("Content-Encoding") == "gzip":
            packed += 1
            assert "Accept-Encoding" in compressed.headers["Vary"], asset
            assert gzip.decompress(compressed.raw.read()) == identity.content, asset
            assert int(compressed.headers["Content-Length"]) < len(identity.content), asset
    assert packed > 40, packed
    asset = next(name for name in mapping if name.endswith("app_common.js"))
    assert get(f"/{asset}.gz").status_code == 404
    assert get(f"/{asset}.gz", "gzip").status_code == 404


def test_a_kernel_is_application_wasm_and_the_committed_file_byte_for_byte():
    kernels = sorted((ROOT / "src/static/wasm").glob("*.wasm"))
    assert kernels
    mapping = versions()
    for path in kernels:
        response = get(f"/static/wasm/{path.name}?v={mapping[f'static/wasm/{path.name}']}")
        assert response.status_code == 200, path.name
        assert response.headers["Content-Type"].split(";")[0] == "application/wasm", path.name
        assert response.content == path.read_bytes(), path.name


def test_the_policy_of_a_staged_shell_hashes_exactly_its_inline_scripts():
    for path in SHELLS:
        response = get(path)
        assert response.status_code == 200, path
        policy = response.headers["Content-Security-Policy"]
        expected = []
        for attributes, body in re.findall(r"<script(\s[^>]*)?>(.*?)</script", response.text, re.DOTALL | re.IGNORECASE):
            attributes = (attributes or "").lower()
            if "src=" in attributes or "application/json" in attributes:
                continue
            expected.append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
        assert expected, path
        script_src = re.search(r"script-src ([^;]*);", policy).group(1).split()
        assert script_src[2:] == expected, path
        assert "'unsafe-inline'" not in script_src and "'unsafe-eval'" not in script_src
