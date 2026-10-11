"""The sources of the Query page run session for the contract tests.

src/query_session.cpp is the life of a run: the connection, the retries, the cancel, the samples and the queue of events. What it uses lives in
src/query_session_kill.cpp (KILL QUERY), src/query_result_plan.cpp (the plan of the columns, the wrapper, the DESCRIBE cache),
src/query_result_events.cpp (the events of a result) and src/query_run_profile.cpp (the cost that ProfileEvents report). A contract test that checks a rule of
the run reads them all (`read_session`); the headers are `read_session_header`.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"

SOURCES = ["query_session.cpp", "query_session_kill.cpp", "query_result_plan.cpp", "query_result_events.cpp", "query_run_profile.cpp"]
HEADERS = ["query_session.hpp", "query_result_plan.hpp", "query_result_events.hpp", "query_run_profile.hpp"]


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("query_result_plan.cpp")."""
    return (SRC / name).read_text(encoding="utf-8")


def read_session() -> str:
    """The sources of the session and of its units in one text."""
    return "\n".join(read_unit(name) for name in SOURCES)


def read_session_header() -> str:
    """The headers of the session and of its units in one text."""
    return "\n".join(read_unit(name) for name in HEADERS)
