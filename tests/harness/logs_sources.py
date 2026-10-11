"""The sources of the Logs page for the contract tests.

The routes are adapters in src/api_logs.cpp. What they call lives in src/logs_*.{hpp,cpp}: the request parsing, the filters, the SQL builders,
the text search, the patterns, the service and the JSON writers. A test that checks the text of a statement or of a rule reads the unit that
holds it (`read_unit`), or all of them (`read_logs`).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def units() -> list[Path]:
    """The adapters first, then the units in the order of their names (headers before sources)."""
    return [SRC / "api_logs.cpp"] + sorted(SRC.glob("logs_*.hpp")) + sorted(SRC.glob("logs_*.cpp"))


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("logs_sql.cpp")."""
    return (SRC / name).read_text()


def read_logs() -> str:
    """Every unit of the page in one text: the adapters, then the headers, then the sources."""
    return "\n".join(path.read_text() for path in units())
