"""The sources of the Traces page for the contract tests.

The routes are adapters in src/api_traces.cpp. What they call lives in src/trace_*.{hpp,cpp}: the request parsing, the span
filters, the SQL builders, the search strategies, the analytics and the detail reads, and the JSON writers. A test that
checks the text of a statement or of a rule reads the unit that holds it (`read_unit`), or all of them (`read_traces`).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def units() -> list[Path]:
    """The adapters first, then the units in the order of their names (headers before sources)."""
    found = sorted(SRC.glob("trace_*.hpp")) + sorted(SRC.glob("trace_*.cpp"))
    return [SRC / "api_traces.cpp"] + found


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("trace_sql.cpp")."""
    return (SRC / name).read_text()


def read_traces() -> str:
    """Every unit of the page in one text: the adapters, then the headers, then the sources."""
    return "\n".join(path.read_text() for path in units())
