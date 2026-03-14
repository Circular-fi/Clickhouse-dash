import os
import time
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://host.docker.internal:8080").rstrip("/")
HEALTH_PATH = os.environ.get("API_HEALTH_PATH", "/api/health")
TIMEOUT_SECONDS = int(os.environ.get("API_TIMEOUT_SECONDS", "20"))
READY_TIMEOUT_SECONDS = int(os.environ.get("API_READY_TIMEOUT_SECONDS", "120"))
CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "default")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "")
CLICKHOUSE_TIMEOUT_SECONDS = int(os.environ.get("CLICKHOUSE_TIMEOUT_SECONDS", "20"))
CLICKHOUSE_READY_TIMEOUT_SECONDS = int(os.environ.get("CLICKHOUSE_READY_TIMEOUT_SECONDS", "120"))
UPDATE_EXPECTED_SQL = os.environ.get("UPDATE_EXPECTED_SQL", "0") == "1"
ASSERT_CLICKHOUSE_SUCCESS = os.environ.get("ASSERT_CLICKHOUSE_SUCCESS", "1") == "1"
RAW_DIR = Path(os.environ.get("CLICKHOUSE_RAW_DIR", "/artifacts/sql_raw"))
SQL_DIR = Path(__file__).with_name("sql")


def wait_for_api_ready():
    deadline = time.time() + READY_TIMEOUT_SECONDS
    last_error = None
    url = f"{BASE_URL}{HEALTH_PATH}"
    while time.time() < deadline:
        try:
            response = requests.get(url, timeout=TIMEOUT_SECONDS)
            if response.status_code == 200:
                payload = response.json()
                if payload.get("ok") is True:
                    return
                last_error = f"health payload not ready: {payload}"
            else:
                last_error = f"health status={response.status_code} body={response.text}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"API did not become ready: {last_error}")


def clickhouse_request(method: str, path: str = "/", *, params=None, data=None):
    url = f"{CLICKHOUSE_URL}{path}"
    return requests.request(
        method,
        url,
        params=params,
        data=data,
        timeout=CLICKHOUSE_TIMEOUT_SECONDS,
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD) if CLICKHOUSE_PASSWORD else None,
    )


def wait_for_clickhouse_ready():
    deadline = time.time() + CLICKHOUSE_READY_TIMEOUT_SECONDS
    last_error = None
    while time.time() < deadline:
        try:
            response = clickhouse_request("GET", "/ping")
            if response.status_code == 200 and response.text.strip() == "Ok.":
                return
            last_error = f"ping status={response.status_code} body={response.text}"
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"ClickHouse did not become ready: {last_error}")


@pytest.fixture(scope="session", autouse=True)
def services_ready():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    wait_for_api_ready()
    wait_for_clickhouse_ready()


def iter_sql_files():
    return sorted(SQL_DIR.glob("*.sql"))


def load_sql_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def compact_sql(text: str) -> str:
    out = []
    in_string = False
    in_line_comment = False
    in_block_comment = False
    pending_space = False
    i = 0
    n = len(text)

    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if in_string:
            out.append(c)
            if c == "'":
                if nxt == "'":
                    out.append(nxt)
                    i += 2
                    continue
                in_string = False
            i += 1
            continue

        if in_line_comment:
            out.append(c)
            if c == "\n":
                in_line_comment = False
                pending_space = False
            i += 1
            continue

        if in_block_comment:
            out.append(c)
            if c == "*" and nxt == "/":
                out.append(nxt)
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue

        if c == "'":
            if pending_space and out and out[-1] not in (" ", "\n"):
                out.append(" ")
            pending_space = False
            out.append(c)
            in_string = True
            i += 1
            continue

        if c == "-" and nxt == "-":
            if pending_space and out and out[-1] not in (" ", "\n"):
                out.append(" ")
            pending_space = False
            out.append(c)
            out.append(nxt)
            in_line_comment = True
            i += 2
            continue

        if c == "/" and nxt == "*":
            if pending_space and out and out[-1] not in (" ", "\n"):
                out.append(" ")
            pending_space = False
            out.append(c)
            out.append(nxt)
            in_block_comment = True
            i += 2
            continue

        if c.isspace():
            pending_space = True
            i += 1
            continue

        if pending_space and out and out[-1] not in (" ", "\n", "(", "[", ","):
            out.append(" ")
        pending_space = False
        out.append(c)
        i += 1

    return "".join(out).strip()


def normalize_fixture_text(text: str) -> str:
    return text.replace("\r\n", "\n")


def fetch_clickhouse_syntax(sql: str):
    query = f"EXPLAIN SYNTAX {sql}"
    return clickhouse_request(
        "POST",
        "/",
        params={"default_format": "TabSeparatedRaw"},
        data=query.encode("utf-8"),
    )


def write_raw_sql(path: Path, text: str):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.mark.parametrize("sql_path", iter_sql_files(), ids=lambda path: path.stem)
def test_format_sql_roundtrip(sql_path):
    expected_sql = load_sql_text(sql_path)
    response = requests.post(
        f"{BASE_URL}/api/format",
        json={
            "host_id": "local",
            "sql": compact_sql(expected_sql),
        },
        timeout=TIMEOUT_SECONDS,
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    formatted_sql = payload.get("formatted_sql")
    assert isinstance(formatted_sql, str), payload

    if UPDATE_EXPECTED_SQL:
        updated_sql = normalize_fixture_text(formatted_sql)
        if expected_sql != updated_sql:
            sql_path.write_text(updated_sql, encoding="utf-8")
            expected_sql = updated_sql

    assert formatted_sql == expected_sql, payload

    ch_response = fetch_clickhouse_syntax(formatted_sql)
    raw_path = RAW_DIR / f"{sql_path.stem}.sql"
    write_raw_sql(raw_path, ch_response.text)

    if ASSERT_CLICKHOUSE_SUCCESS:
        assert ch_response.status_code == 200, (
            f"ClickHouse syntax explain failed for {sql_path.name}:\n{ch_response.text}"
        )
