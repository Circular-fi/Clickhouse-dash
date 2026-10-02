from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import pytest
import requests


def _split_sql_script(text: str) -> list[str]:
    statements: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if line_comment:
            current.append(ch)
            if ch == "\n":
                line_comment = False
            i += 1
            continue
        if block_comment:
            current.append(ch)
            if ch == "*" and nxt == "/":
                current.append(nxt)
                i += 2
                block_comment = False
            else:
                i += 1
            continue
        if quote:
            current.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\" and quote == "'":
                escaped = True
            elif ch == quote:
                # SQL doubled quote escapes the delimiter.
                if nxt == quote:
                    current.append(nxt)
                    i += 2
                    continue
                quote = None
            i += 1
            continue
        if ch == "-" and nxt == "-":
            current.extend([ch, nxt])
            i += 2
            line_comment = True
            continue
        if ch == "/" and nxt == "*":
            current.extend([ch, nxt])
            i += 2
            block_comment = True
            continue
        if ch in {"'", '"', "`"}:
            quote = ch
            current.append(ch)
            i += 1
            continue
        if ch == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    tail = "".join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def _execute_script(session: requests.Session, base_url: str, user: str, password: str, path: Path) -> None:
    for index, statement in enumerate(_split_sql_script(path.read_text(encoding="utf-8")), 1):
        response = session.post(
            base_url,
            params={"user": user, "password": password},
            data=statement.encode("utf-8"),
            timeout=180,
        )
        if response.status_code != 200:
            preview = statement.replace("\n", " ")[:180]
            raise RuntimeError(
                f"ClickHouse fixture {path.name} statement {index} failed ({response.status_code}): "
                f"{preview}\n{response.text}"
            )


FIXTURE_SCRIPTS = (
    "01-chdash-users.sql",
    "02-frontend-fixtures.sql",
    # ReplicatedMergeTree fixtures on chdash_cluster (clickhouse + clickhouse_replica).
    "04-replicated-fixtures.sql",
    # OTel logs/metrics exporter tables (CREATE ... IF NOT EXISTS only): a
    # persistent volume created before they existed still gets them.
    "05-otel-logs-metrics.sql",
)
# The marker lives in the comment of the chdash_ui database: ChDash never reads
# system.databases, so no page or API shows it.
MARKER_DATABASE = "chdash_ui"
MARKER_PREFIX = "chdash-test-fixtures="
# What a reset converges to, read from system tables only: the fixture objects and
# their UUIDs (a dropped and recreated table gets a new one), users, grants and
# dictionaries, and the row count of every table whose count only moves when
# something writes to it. A Buffer reports its destination's rows plus its own, so
# counting the Buffer and not its destination keeps the count across a flush;
# Summing/Aggregating engines (merges, flush-fed views) are left out.
TABLES_QUERY = (
    "SELECT database, name, engine, toString(uuid), toString(total_rows), engine_full FROM system.tables"
    " WHERE database IN ('chdash_ui', 'chdash_repl', 'otel') AND NOT is_temporary ORDER BY database, name"
    " FORMAT TSVRaw"
)
COUNTED_ENGINES = {"MergeTree", "ReplicatedMergeTree", "Memory", "Buffer"}
BUFFER_TARGET = re.compile(r"^Buffer\(\s*'?(\w+)'?\s*,\s*'?(\w+)'?")
STATE_QUERIES = (
    "SELECT name, auth_type FROM system.users WHERE name IN ('chdash_runner', 'chdash_system') ORDER BY name",
    "SHOW GRANTS FOR chdash_runner",
    "SHOW GRANTS FOR chdash_system",
    "SELECT database, name, status FROM system.dictionaries WHERE database = 'chdash_ui' ORDER BY name",
)


def _query(session: requests.Session, base_url: str, user: str, password: str, sql: str) -> str:
    response = session.post(base_url, params={"user": user, "password": password}, data=sql.encode("utf-8"), timeout=30)
    response.raise_for_status()
    return response.text


def _scripts_digest(init_root: Path) -> str:
    digest = hashlib.sha256()
    for name in FIXTURE_SCRIPTS:
        digest.update(name.encode("utf-8") + b"\0" + (init_root / name).read_bytes() + b"\0")
    return digest.hexdigest()[:16]


def _state_digest(session: requests.Session, base_url: str, user: str, password: str) -> str:
    rows = [line.split("\t") for line in _query(session, base_url, user, password, TABLES_QUERY).splitlines() if line]
    buffer_targets = {(m.group(1), m.group(2)) for *_, engine_full in rows if (m := BUFFER_TARGET.match(engine_full))}
    tables = [
        (database, name, engine, uuid,
         total_rows if engine in COUNTED_ENGINES and database != "otel" and (database, name) not in buffer_targets else "")
        for database, name, engine, uuid, total_rows, _ in rows
    ]
    digest = hashlib.sha256(repr(tables).encode("utf-8"))
    for sql in STATE_QUERIES:
        digest.update(b"\0" + _query(session, base_url, user, password, sql).encode("utf-8"))
    return digest.hexdigest()[:16]


def _marker(session: requests.Session, base_url: str, user: str, password: str) -> str:
    try:
        return _query(
            session, base_url, user, password,
            f"SELECT comment FROM system.databases WHERE name = '{MARKER_DATABASE}' FORMAT TSVRaw",
        ).strip()
    except requests.RequestException:
        return ""


def _expected_marker(scripts: str, state: str) -> str:
    return f"{MARKER_PREFIX}{scripts}/{state}"


@pytest.fixture(scope="session", autouse=True)
def reset_clickhouse_integration_fixture() -> None:
    """Reapply grants + deterministic Explorer fixtures for every Docker review.

    docker-entrypoint-initdb.d only runs when the ClickHouse data directory is first
    initialized. Reusing the compose container previously left stale users/grants and
    old three-table fixtures in place, which made the review nondeterministic.

    The reset is incremental: after a reset the chdash_ui database comment records
    the digest of the fixture scripts and of the state they produced (tables and
    their UUIDs, row counts, users, grants, dictionaries). The next session skips the
    reset while both still match, so an unchanged fixture is never dropped and
    recreated under a concurrent run. CHDASH_FIXTURE_RESET=always forces it, =never
    skips it; run-all-tests.py sets CHDASH_FIXTURES_FRESH=1 after its own reset.
    """
    base_url = os.environ.get("CLICKHOUSE_URL")
    if not base_url:
        return
    mode = os.environ.get("CHDASH_FIXTURE_RESET", "auto").strip().lower()
    if mode == "never" or os.environ.get("CHDASH_FIXTURES_FRESH") == "1":
        return
    base_url = base_url.rstrip("/")
    repo_root = Path(os.environ.get("TEST_REPOSITORY_ROOT", "/repo"))
    init_root = repo_root / "tests" / "clickhouse-init"
    user = os.environ.get("CLICKHOUSE_USER", "test")
    password = os.environ.get("CLICKHOUSE_PASSWORD", "test")
    scripts = _scripts_digest(init_root)
    with requests.Session() as session:
        if mode != "always":
            try:
                state = _state_digest(session, base_url, user, password)
            except requests.RequestException:
                state = ""
            if state and _marker(session, base_url, user, password) == _expected_marker(scripts, state):
                print(f"[fixtures] unchanged ({scripts}/{state}): reset skipped", flush=True)
                return
        for name in FIXTURE_SCRIPTS:
            _execute_script(session, base_url, user, password, init_root / name)
        state = _state_digest(session, base_url, user, password)
        marker = _expected_marker(scripts, state)
        _query(session, base_url, user, password, f"ALTER DATABASE {MARKER_DATABASE} MODIFY COMMENT '{marker}'")
        print(f"[fixtures] reset applied ({scripts}/{state})", flush=True)
