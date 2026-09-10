from __future__ import annotations

import os
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
            timeout=60,
        )
        if response.status_code != 200:
            preview = statement.replace("\n", " ")[:180]
            raise RuntimeError(
                f"ClickHouse fixture {path.name} statement {index} failed ({response.status_code}): "
                f"{preview}\n{response.text}"
            )


@pytest.fixture(scope="session", autouse=True)
def reset_clickhouse_integration_fixture() -> None:
    """Reapply grants + deterministic Explorer fixtures for every Docker review.

    docker-entrypoint-initdb.d only runs when the ClickHouse data directory is first
    initialized. Reusing the compose container previously left stale users/grants and
    old three-table fixtures in place, which made the review nondeterministic.
    """
    base_url = os.environ.get("CLICKHOUSE_URL")
    if not base_url:
        return
    repo_root = Path(os.environ.get("TEST_REPOSITORY_ROOT", "/repo"))
    init_root = repo_root / "tests" / "clickhouse-init"
    user = os.environ.get("CLICKHOUSE_USER", "test")
    password = os.environ.get("CLICKHOUSE_PASSWORD", "test")
    with requests.Session() as session:
        _execute_script(session, base_url.rstrip("/"), user, password, init_root / "01-chdash-users.sql")
        _execute_script(session, base_url.rstrip("/"), user, password, init_root / "02-frontend-fixtures.sql")
