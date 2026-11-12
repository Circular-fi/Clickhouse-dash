"""The limit of the requests with no valid key (contract 3.9; docs/mcp.md, "The rate limit").

Instance (the test skips without it; in the official run, CHDASH_REQUIRE_FIXTURES=1 makes a missing one a failure):
- MCP_UNAUTH_BASE_URL: tests/config/mcp.unauth.hcl (the compose service chdash_mcp_unauth): one config key, and
  mcp.unauthenticated_rate_limit_per_minute = 3.
"""
from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("MCP_UNAUTH_BASE_URL", "").rstrip("/")
needs_unauth = pytest.mark.skipif(not BASE_URL, reason="MCP_UNAUTH_BASE_URL is not set")
PING = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
# The token of config/secrets/mcp-key-only-key (a key of the older form: a UUID version 4).
VALID_KEY = "0a17e100-0000-4000-8000-000000000008"


def post(token: str | None) -> requests.Response:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.post(f"{BASE_URL}/mcp", json=PING, headers=headers, timeout=10)


@needs_unauth
def test_requests_with_no_valid_key_are_limited_for_each_client_address():
    # Each request with no valid key counts for the address of the client: 3 get 401, then 429 with Retry-After and no body.
    statuses = [post("mcp_" + "B" * 43).status_code for _ in range(3)]
    assert statuses == [401, 401, 401]
    limited = post(None)
    assert limited.status_code == 429
    assert limited.content == b""
    assert int(limited.headers["Retry-After"]) >= 1
    # A request with a valid key never counts here: it is answered while the address has no token left.
    valid = post(VALID_KEY)
    assert valid.status_code == 200, valid.text
    # The limit holds for another bad key too.
    assert post("mcp_" + "C" * 43).status_code == 429
