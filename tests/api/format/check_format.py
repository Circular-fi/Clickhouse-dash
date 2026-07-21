import difflib
import json
import os
import threading
import time
from pathlib import Path

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://clickhouse-dash:8080").rstrip("/")
HEALTH_PATH = os.environ.get("API_HEALTH_PATH", "/api/health")
TIMEOUT_SECONDS = int(os.environ.get("API_TIMEOUT_SECONDS", "10"))
READY_TIMEOUT_SECONDS = int(os.environ.get("API_READY_TIMEOUT_SECONDS", "90"))
REQUEST_RETRIES = int(os.environ.get("API_REQUEST_RETRIES", "2"))
RETRY_DELAY_SECONDS = float(os.environ.get("API_RETRY_DELAY_SECONDS", "0.5"))
INTER_TEST_DELAY_SECONDS = float(os.environ.get("API_INTER_TEST_DELAY_SECONDS", "0"))

CLICKHOUSE_URL = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
CLICKHOUSE_USER = os.environ.get("CLICKHOUSE_USER", "test")
CLICKHOUSE_PASSWORD = os.environ.get("CLICKHOUSE_PASSWORD", "test")
CLICKHOUSE_TIMEOUT_SECONDS = int(os.environ.get("CLICKHOUSE_TIMEOUT_SECONDS", "10"))
INPUT_SQL_DIR = Path(os.environ.get("FORMAT_INPUT_SQL_DIR", str(Path(__file__).with_name("input"))))
OUTPUT_SQL_DIR = Path(os.environ.get("FORMAT_OUTPUT_SQL_DIR", str(Path(__file__).with_name("output"))))
ARTIFACTS_DIR = Path(os.environ.get("TEST_ARTIFACTS_DIR", "/tests/artifacts"))
FAIL_DIR = ARTIFACTS_DIR / "format_failures"
CRASH_DIR = ARTIFACTS_DIR / "api_crash"
FORMAT_RESULTS_PATH = ARTIFACTS_DIR / "format_results.json"
FORMAT_RESULTS_LOCK = threading.Lock()
FORMAT_RESULTS_FLUSH_EVERY = max(1, int(os.environ.get("FORMAT_RESULTS_FLUSH_EVERY", "20")))
FORMAT_RESULTS_STATE: dict = {}
FORMAT_RESULTS_DIRTY = 0

# requests.Session keeps one connection pool per origin. Reusing it avoids a new
# TCP handshake for every formatter fixture and every ClickHouse reference call.
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-tests/1"})


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _new_format_manifest() -> dict:
    now = utc_now()
    return {
        "version": 1,
        "generated_at": now,
        "updated_at": now,
        "total_expected": len(iter_output_sql_files()),
        "completed": 0,
        "passed": 0,
        "failed": 0,
        "errors": 0,
        "items": [],
    }


def _refresh_format_totals_locked() -> None:
    items = FORMAT_RESULTS_STATE.get("items", [])
    FORMAT_RESULTS_STATE["updated_at"] = utc_now()
    FORMAT_RESULTS_STATE["completed"] = len(items)
    FORMAT_RESULTS_STATE["passed"] = sum(1 for row in items if row.get("status") == "passed")
    FORMAT_RESULTS_STATE["failed"] = sum(1 for row in items if row.get("status") == "failed")
    FORMAT_RESULTS_STATE["errors"] = sum(1 for row in items if row.get("status") == "error")


def _flush_format_results_locked() -> None:
    global FORMAT_RESULTS_DIRTY
    _refresh_format_totals_locked()
    write_json_atomic(FORMAT_RESULTS_PATH, FORMAT_RESULTS_STATE)
    FORMAT_RESULTS_DIRTY = 0


def flush_format_results() -> None:
    with FORMAT_RESULTS_LOCK:
        if FORMAT_RESULTS_STATE:
            _flush_format_results_locked()


def initialize_format_results() -> None:
    global FORMAT_RESULTS_STATE, FORMAT_RESULTS_DIRTY
    with FORMAT_RESULTS_LOCK:
        FORMAT_RESULTS_STATE = _new_format_manifest()
        FORMAT_RESULTS_DIRTY = 0
        _flush_format_results_locked()


def relative_artifact(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return str(path.resolve().relative_to(ARTIFACTS_DIR.resolve()))
    except ValueError:
        return str(path)


def record_format_result(
    *,
    output_sql_path: Path,
    status: str,
    input_sql: str,
    expected_sql: str,
    actual_sql: str,
    diff: str,
    duration_ms: float,
    input_artifact: Path | None = None,
    expected_artifact: Path | None = None,
    actual_artifact: Path | None = None,
    error: str | None = None,
) -> None:
    global FORMAT_RESULTS_STATE, FORMAT_RESULTS_DIRTY
    diff_lines = diff.splitlines()
    added_lines = sum(1 for line in diff_lines if line.startswith("+") and not line.startswith("+++"))
    removed_lines = sum(1 for line in diff_lines if line.startswith("-") and not line.startswith("---"))
    changed_blocks = sum(1 for line in diff_lines if line.startswith("@@"))

    item = {
        "name": output_sql_path.stem,
        "file": output_sql_path.name,
        "status": status,
        "duration_ms": round(duration_ms, 3),
        "input": input_sql,
        "expected": expected_sql,
        "actual": actual_sql,
        "diff": diff,
        "error": error,
        "expected_lines": len(expected_sql.splitlines()),
        "actual_lines": len(actual_sql.splitlines()),
        "added_lines": added_lines,
        "removed_lines": removed_lines,
        "changed_blocks": changed_blocks,
        "artifacts": {
            "input": relative_artifact(input_artifact),
            "expected": relative_artifact(expected_artifact),
            "actual": relative_artifact(actual_artifact),
        },
    }

    with FORMAT_RESULTS_LOCK:
        if not FORMAT_RESULTS_STATE:
            FORMAT_RESULTS_STATE = _new_format_manifest()
        items = [
            previous
            for previous in FORMAT_RESULTS_STATE.get("items", [])
            if isinstance(previous, dict) and previous.get("file") != output_sql_path.name
        ]
        items.append(item)
        items.sort(key=lambda row: str(row.get("file") or ""))
        FORMAT_RESULTS_STATE["items"] = items
        FORMAT_RESULTS_DIRTY += 1

        # Persist failures immediately so diagnostics survive a crash. Successful
        # cases are flushed in batches, avoiding O(n²) JSON read/modify/write I/O.
        if status != "passed" or FORMAT_RESULTS_DIRTY >= FORMAT_RESULTS_FLUSH_EVERY:
            _flush_format_results_locked()


def wait_for_api_ready() -> None:
    deadline = time.time() + READY_TIMEOUT_SECONDS
    last_error = None
    url = f"{BASE_URL}{HEALTH_PATH}"

    while time.time() < deadline:
        try:
            response = SESSION.get(url, timeout=TIMEOUT_SECONDS)
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


@pytest.fixture(scope="module", autouse=True)
def format_results_manifest():
    initialize_format_results()
    try:
        yield
    finally:
        flush_format_results()


def normalize_sql_file_content(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")


def trim_sql_input(text: str) -> str:
    lines = normalize_sql_file_content(text).split("\n")
    trimmed_lines = [line.rstrip() for line in lines]

    while trimmed_lines and trimmed_lines[0] == "":
        trimmed_lines.pop(0)
    while trimmed_lines and trimmed_lines[-1] == "":
        trimmed_lines.pop()

    collapsed_lines = []
    previous_blank = False

    for line in trimmed_lines:
        is_blank = line == ""
        if is_blank and previous_blank:
            continue
        collapsed_lines.append(line)
        previous_blank = is_blank

    return "\n".join(collapsed_lines)


def load_sql_text(path: Path) -> str:
    return normalize_sql_file_content(path.read_text(encoding="utf-8"))


def load_trimmed_sql_text(path: Path) -> str:
    return trim_sql_input(path.read_text(encoding="utf-8"))


def write_sql_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(normalize_sql_file_content(text), encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip("\n"), encoding="utf-8")


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
    response = SESSION.post(
        f"{CLICKHOUSE_URL}/",
        params={"database": "default"},
        data=query.encode("utf-8"),
        auth=(CLICKHOUSE_USER, CLICKHOUSE_PASSWORD),
        timeout=CLICKHOUSE_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return normalize_sql_file_content(response.text)


def iter_output_sql_files() -> list[Path]:
    return sorted(OUTPUT_SQL_DIR.glob("*.sql"))


def input_sql_path_for(output_sql_path: Path) -> Path:
    return INPUT_SQL_DIR / output_sql_path.name


def load_input_sql_text(output_sql_path: Path) -> str:
    input_sql_path = input_sql_path_for(output_sql_path)
    if not input_sql_path.exists():
        raise FileNotFoundError(
            f"missing formatter input fixture for {output_sql_path.name}: {input_sql_path}"
        )
    return load_trimmed_sql_text(input_sql_path)


def require_output_sql_files() -> list[Path]:
    files = iter_output_sql_files()
    if not files:
        raise SystemExit(f"no .sql files found in {OUTPUT_SQL_DIR}")

    missing_inputs = [path.name for path in files if not input_sql_path_for(path).exists()]
    if missing_inputs:
        raise SystemExit(
            "missing matching formatter input fixture(s) in "
            f"{INPUT_SQL_DIR}: {', '.join(missing_inputs)}"
        )

    extra_inputs = sorted(
        path.name for path in INPUT_SQL_DIR.glob("*.sql") if not (OUTPUT_SQL_DIR / path.name).exists()
    )
    if extra_inputs:
        raise SystemExit(
            "formatter input fixture(s) without matching output in "
            f"{OUTPUT_SQL_DIR}: {', '.join(extra_inputs)}"
        )

    return files


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
    output_sql_path: Path,
    input_sql: str,
    expected_sql: str,
    actual_sql: str,
) -> tuple[Path, Path, Path]:
    FAIL_DIR.mkdir(parents=True, exist_ok=True)
    input_path = FAIL_DIR / f"{output_sql_path.stem}.input.sql"
    expected_path = FAIL_DIR / f"{output_sql_path.stem}.expected.sql"
    actual_path = FAIL_DIR / f"{output_sql_path.stem}.actual.sql"
    write_sql_text(input_path, input_sql)
    write_sql_text(expected_path, expected_sql)
    write_sql_text(actual_path, actual_sql)
    return input_path, expected_path, actual_path


def probe_api_health() -> tuple[bool, str]:
    url = f"{BASE_URL}{HEALTH_PATH}"
    try:
        response = SESSION.get(url, timeout=TIMEOUT_SECONDS)
        body = response.text
        if response.headers.get("content-type", "").startswith("application/json"):
            try:
                body = json.dumps(response.json(), ensure_ascii=False, indent=2)
            except Exception:
                pass
        return response.status_code == 200, f"status={response.status_code}\n{body}"
    except requests.RequestException as exc:
        return False, f"health request failed: {exc}"


def write_crash_artifacts(output_sql_path: Path, input_sql: str, note: str) -> Path:
    CRASH_DIR.mkdir(parents=True, exist_ok=True)
    crash_prefix = CRASH_DIR / output_sql_path.stem
    write_sql_text(crash_prefix.with_suffix(".input.sql"), input_sql)
    write_text(crash_prefix.with_suffix(".diagnostic.txt"), note)
    return crash_prefix


def call_format_api(output_sql_path: Path, input_sql: str) -> str:
    url = f"{BASE_URL}/api/format"
    last_error = None

    for attempt in range(REQUEST_RETRIES + 1):
        try:
            response = SESSION.post(
                url,
                json={
                    "host_id": "local",
                    "sql": input_sql,
                },
                timeout=TIMEOUT_SECONDS,
            )

            if response.status_code != 200:
                last_error = f"status={response.status_code}\nbody={response.text}"
            else:
                try:
                    payload = response.json()
                except ValueError as exc:
                    last_error = f"invalid json response: {exc}\nbody={response.text}"
                else:
                    return normalize_sql_file_content(payload.get("formatted_sql", ""))

        except requests.RequestException as exc:
            last_error = str(exc)

        if attempt < REQUEST_RETRIES:
            time.sleep(RETRY_DELAY_SECONDS)

    health_ok, health_note = probe_api_health()
    diagnostic = "\n\n".join(
        [
            f"format request failed for {output_sql_path.name}",
            f"last_error:\n{last_error or '(none)'}",
            f"health_ok={health_ok}",
            f"health_probe:\n{health_note}",
        ]
    )
    crash_prefix = write_crash_artifacts(output_sql_path, input_sql, diagnostic)

    if not health_ok:
        pytest.exit(
            "\n".join(
                [
                    f"API became unhealthy while testing {output_sql_path.name}",
                    f"input:      {crash_prefix.with_suffix('.input.sql')}",
                    f"diagnostic: {crash_prefix.with_suffix('.diagnostic.txt')}",
                ]
            )
        )

    pytest.fail(
        "\n".join(
            [
                f"API request failed for {output_sql_path.name}",
                f"input:      {crash_prefix.with_suffix('.input.sql')}",
                f"diagnostic: {crash_prefix.with_suffix('.diagnostic.txt')}",
            ]
        )
    )


@pytest.mark.parametrize(
    "output_sql_path", require_output_sql_files(), ids=lambda path: path.stem
)
def test_format_sql_roundtrip(output_sql_path: Path) -> None:
    started = time.perf_counter()
    input_sql = load_input_sql_text(output_sql_path)
    expected_sql = load_sql_text(output_sql_path)

    try:
        formatted_sql = call_format_api(output_sql_path, input_sql)
    except BaseException as exc:
        record_format_result(
            output_sql_path=output_sql_path,
            status="error",
            input_sql=input_sql,
            expected_sql=expected_sql,
            actual_sql="",
            diff="",
            duration_ms=(time.perf_counter() - started) * 1000.0,
            error=str(exc),
        )
        raise

    if INTER_TEST_DELAY_SECONDS > 0:
        time.sleep(INTER_TEST_DELAY_SECONDS)

    if formatted_sql == expected_sql:
        record_format_result(
            output_sql_path=output_sql_path,
            status="passed",
            input_sql=input_sql,
            expected_sql=expected_sql,
            actual_sql=formatted_sql,
            diff="",
            duration_ms=(time.perf_counter() - started) * 1000.0,
        )
        return

    input_path, expected_path, actual_path = write_failure_artifacts(
        output_sql_path=output_sql_path,
        input_sql=input_sql,
        expected_sql=expected_sql,
        actual_sql=formatted_sql,
    )
    diff = unified_sql_diff(expected_sql, formatted_sql, output_sql_path.name)
    if not diff:
        diff = "(no unified diff available)"

    record_format_result(
        output_sql_path=output_sql_path,
        status="failed",
        input_sql=input_sql,
        expected_sql=expected_sql,
        actual_sql=formatted_sql,
        diff=diff,
        duration_ms=(time.perf_counter() - started) * 1000.0,
        input_artifact=input_path,
        expected_artifact=expected_path,
        actual_artifact=actual_path,
    )

    pytest.fail(
        "\n".join(
            [
                f"format mismatch: {output_sql_path.name}",
                f"input:    {input_path}",
                f"expected: {expected_path}",
                f"actual:   {actual_path}",
                "",
                diff,
            ]
        )
    )


def post_format_payload(payload: dict) -> requests.Response:
    response = SESSION.post(
        f"{BASE_URL}/api/format",
        json={"host_id": "local", **payload},
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return response


def test_format_batch_deduplicates_identical_statements() -> None:
    sql = f"SELECT 1 AS cache_probe_{time.time_ns()}"
    response = post_format_payload({"sqls": [sql, sql]})
    payload = response.json()
    assert payload["formatted_sqls"][0] == payload["formatted_sqls"][1]
    assert payload["cache"]["deduplicated"] >= 1
    assert response.headers.get("X-Chdash-Format-Cache") in {"hit", "partial"}


def test_format_global_cache_is_reused() -> None:
    sql = f"SELECT 2 AS cache_probe_{time.time_ns()}"
    first = post_format_payload({"sql": sql})
    second = post_format_payload({"sql": sql})
    assert first.json()["formatted_sql"] == second.json()["formatted_sql"]
    assert second.json()["cache"]["hits"] >= 1
    assert second.headers.get("X-Chdash-Format-Cache") == "hit"


def test_format_preserves_exact_literal_spelling() -> None:
    sql = "SELECT 1 AS \"identifier'with_quote\", 'it''s \\\\ exact' AS value"
    formatted = post_format_payload({"sql": sql}).json()["formatted_sql"]
    assert "\"identifier'with_quote\"" in formatted
    assert "'it''s \\\\ exact'" in formatted


def test_format_preserves_function_delimiter_literal() -> None:
    sql = "SELECT arrayStringConcat(['a', 'b'], ',') AS joined"
    formatted = post_format_payload({"sql": sql}).json()["formatted_sql"]
    assert "arrayStringConcat(['a', 'b'], ',')" in formatted
    assert "arrayStringConcat(['a', 'b'], ', ')" not in formatted


def test_format_preserves_quoted_identifier_after_unquoted_alias() -> None:
    sql = 'SELECT 1 AS first_alias, 2 AS "second alias"'
    formatted = post_format_payload({"sql": sql}).json()["formatted_sql"]
    assert '"second alias"' in formatted
    assert '`first_alias`' in formatted


def test_format_preserves_doubled_quotes_in_commented_identifier() -> None:
    sql = '/* keep */ SELECT 1 AS "commented""alias"'
    formatted = post_format_payload({"sql": sql}).json()["formatted_sql"]
    assert '"commented""alias"' in formatted
    assert '`commented""alias`' not in formatted


def test_format_clamps_line_width() -> None:
    payload = post_format_payload({"sql": "SELECT 1", "line_width": 10_000}).json()
    assert payload["line_width"] == 200


def test_expected_format_fixtures_are_idempotent_in_batch() -> None:
    fixtures = iter_output_sql_files()
    for offset in range(0, len(fixtures), 20):
        batch = fixtures[offset : offset + 20]
        expected = [load_sql_text(path) for path in batch]
        payload = post_format_payload({"sqls": expected}).json()
        actual = [normalize_sql_file_content(value) for value in payload["formatted_sqls"]]
        mismatches = [
            path.name
            for path, wanted, got in zip(batch, expected, actual)
            if wanted != got
        ]
        assert not mismatches, "non-idempotent formatter fixtures: " + ", ".join(mismatches)
