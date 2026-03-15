import difflib
import os
import time
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://clickhouse-dash:8080").rstrip("/")
HEALTH_PATH = os.environ.get("API_HEALTH_PATH", "/api/health")
TIMEOUT_SECONDS = int(os.environ.get("API_TIMEOUT_SECONDS", "10"))
READY_TIMEOUT_SECONDS = int(os.environ.get("API_READY_TIMEOUT_SECONDS", "90"))

CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "test")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")
CLICKHOUSE_TIMEOUT_SECONDS = int(os.environ.get("CLICKHOUSE_TIMEOUT_SECONDS", "10"))
RAW_DIR = Path(
    os.environ.get("CLICKHOUSE_RAW_DIR", str(Path(__file__).with_name("sql_raw")))
)
SQL_DIR = Path(os.environ.get("EXPECTED_SQL_DIR", str(Path(__file__).with_name("sql"))))
ARTIFACTS_DIR = Path(os.environ.get("TEST_ARTIFACTS_DIR", "/tests/artifacts"))
FAIL_DIR = ARTIFACTS_DIR / "format_failures"


def wait_for_api_ready() -> None:
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
                last_error = (
                    f"health status={response.status_code} body={response.text}"
                )
        except requests.RequestException as exc:
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"API did not become ready: {last_error}")


@pytest.fixture(scope="session", autouse=True)
def api_ready() -> None:
    wait_for_api_ready()


def normalize_sql_file_content(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")


def load_sql_text(path: Path) -> str:
    return normalize_sql_file_content(path.read_text(encoding="utf-8"))


def write_sql_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(normalize_sql_file_content(text), encoding="utf-8")


def escape_clickhouse_string(value: str) -> str:
    escaped = []
    for char in value:
        if char == "\\":
            escaped.append("\\\\")
        elif char == "'":
            escaped.append("\\'")
        elif char == "\n":
            escaped.append("\\n")
        elif char == "\r":
            escaped.append("\\r")
        elif char == "\t":
            escaped.append("\\t")
        else:
            escaped.append(char)
    return "".join(escaped)


def fetch_clickhouse_raw_formatted_sql(sql_text: str) -> str:
    escaped_sql = escape_clickhouse_string(sql_text)
    query = f"SELECT formatQuery('{escaped_sql}') AS query FORMAT TSVRaw"
    response = requests.post(
        f"{CLICKHOUSE_URL}/",
        params={"database": "default"},
        data=query.encode("utf-8"),
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        timeout=CLICKHOUSE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return normalize_sql_file_content(response.text)


def iter_expected_sql_files() -> list[Path]:
    return sorted(SQL_DIR.glob("*.sql"))


def require_expected_sql_files() -> list[Path]:
    files = iter_expected_sql_files()
    if not files:
        raise SystemExit(f"no .sql files found in {SQL_DIR}")
    return files


def require_raw_sql_path(expected_sql_path: Path) -> Path:
    raw_path = RAW_DIR / expected_sql_path.name
    if not raw_path.exists():
        raise SystemExit(
            f"missing raw sql file for {expected_sql_path.name}: {raw_path}"
        )
    return raw_path


def update_sql_raw_from_clickhouse() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for sql_path in require_expected_sql_files():
        raw_sql = fetch_clickhouse_raw_formatted_sql(load_sql_text(sql_path))
        raw_path = RAW_DIR / sql_path.name
        write_sql_text(raw_path, raw_sql)
        print(f"updated {raw_path}")
    return 0


def unified_sql_diff(expected_sql: str, actual_sql: str, file_name: str) -> str:
    diff_lines = list(
        difflib.unified_diff(
            expected_sql.split("\n"),
            actual_sql.split("\n"),
            fromfile=f"{file_name}:expected",
            tofile=f"{file_name}:actual",
            lineterm="",
            n=2,
        )
    )
    return "\n".join(diff_lines)


def write_failure_artifacts(
    expected_sql_path: Path,
    input_sql: str,
    expected_sql: str,
    actual_sql: str,
) -> tuple[Path, Path, Path]:
    FAIL_DIR.mkdir(parents=True, exist_ok=True)
    input_path = FAIL_DIR / f"{expected_sql_path.stem}.input.sql"
    expected_path = FAIL_DIR / f"{expected_sql_path.stem}.expected.sql"
    actual_path = FAIL_DIR / f"{expected_sql_path.stem}.actual.sql"
    write_sql_text(input_path, input_sql)
    write_sql_text(expected_path, expected_sql)
    write_sql_text(actual_path, actual_sql)
    return input_path, expected_path, actual_path


@pytest.mark.parametrize(
    "expected_sql_path", require_expected_sql_files(), ids=lambda path: path.stem
)
def test_format_sql_roundtrip(expected_sql_path: Path) -> None:
    raw_sql_path = require_raw_sql_path(expected_sql_path)
    input_sql = load_sql_text(raw_sql_path)
    expected_sql = load_sql_text(expected_sql_path)

    response = requests.post(
        f"{BASE_URL}/api/format",
        json={
            "host_id": "local",
            "sql": input_sql,
        },
        timeout=TIMEOUT_SECONDS,
    )

    assert response.status_code == 200, (
        f"{expected_sql_path.name}: status={response.status_code} body={response.text}"
    )

    payload = response.json()
    formatted_sql = normalize_sql_file_content(payload.get("formatted_sql", ""))

    if formatted_sql == expected_sql:
        return

    input_path, expected_path, actual_path = write_failure_artifacts(
        expected_sql_path=expected_sql_path,
        input_sql=input_sql,
        expected_sql=expected_sql,
        actual_sql=formatted_sql,
    )
    diff = unified_sql_diff(expected_sql, formatted_sql, expected_sql_path.name)
    if not diff:
        diff = "(no unified diff available)"

    pytest.fail(
        "\n".join(
            [
                f"format mismatch: {expected_sql_path.name}",
                f"input:    {input_path}",
                f"expected: {expected_path}",
                f"actual:   {actual_path}",
                "",
                diff,
            ]
        )
    )
