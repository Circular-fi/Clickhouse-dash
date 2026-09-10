import base64
import os
import urllib.request

import pytest


def _query(sql: str, user: str, password: str) -> str:
    base = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
    req = urllib.request.Request(base + "/", data=sql.encode("utf-8"), method="POST")
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read().decode("utf-8", errors="replace").strip()


def test_runner_and_system_accounts_are_separate_and_cancel_is_system_only() -> None:
    if "CLICKHOUSE_URL" not in os.environ:
        pytest.skip("runtime ClickHouse grant check runs inside the Docker integration stack")
    runner_user = os.environ.get("CHDASH_RUNNER_USER", "chdash_runner")
    runner_password = os.environ.get("CHDASH_RUNNER_PASSWORD", "runner_test")
    system_user = os.environ.get("CHDASH_SYSTEM_USER", "chdash_system")
    system_password = os.environ.get("CHDASH_SYSTEM_PASSWORD", "system_test")

    assert runner_user != system_user
    assert _query("SELECT 1", runner_user, runner_password) == "1"
    assert _query("SELECT 1", system_user, system_password) == "1"
    assert _query("CHECK GRANT KILL QUERY ON *.*", runner_user, runner_password) == "0"
    assert _query("CHECK GRANT SHOW DICTIONARIES ON *.*", runner_user, runner_password) == "1"
    assert _query("CHECK GRANT KILL QUERY ON *.*", system_user, system_password) == "1"
    assert _query("CHECK GRANT SYSTEM FLUSH LOGS ON *.*", system_user, system_password) == "1"
    assert _query("CHECK GRANT SHOW DATABASES ON *.*", system_user, system_password) == "1"
    assert _query("CHECK GRANT SHOW TABLES ON *.*", system_user, system_password) == "1"
    assert _query("CHECK GRANT SHOW COLUMNS ON *.*", system_user, system_password) == "1"
    assert _query("CHECK GRANT SHOW DICTIONARIES ON *.*", system_user, system_password) == "1"

    runner_grants = _query("SHOW GRANTS", runner_user, runner_password).upper()
    system_grants = _query("SHOW GRANTS", system_user, system_password).upper()
    assert "KILL QUERY" not in runner_grants
    assert "IMPERSONATE" not in runner_grants
    assert "ACCESS MANAGEMENT" not in runner_grants
    assert "KILL QUERY" in system_grants
    assert "SYSTEM FLUSH LOGS" in system_grants
