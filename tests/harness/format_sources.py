"""The sources of the SQL formatter for the contract tests.

The formatter is the units src/format_*.cpp (the passes of the layout), the header that they share (src/format_internal.hpp) and the entry
src/format_postprocess.cpp. The service that the route calls is src/format_service.cpp. A test that checks a rule of the layout reads
`read_formatter()`, or one unit by `read_unit`.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"

# What is not the layout: the service, the transport to ClickHouse and the cache.
_NOT_LAYOUT = {"format_service.cpp", "format_service.hpp", "format_clickhouse.cpp", "format_clickhouse.hpp", "format_cache.cpp", "format_cache.hpp"}


def units() -> list[Path]:
    """The shared header, then the units in the order of their names."""
    files = [SRC / "format_internal.hpp"]
    files += sorted(path for path in SRC.glob("format_*.cpp") if path.name not in _NOT_LAYOUT)
    return files


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("format_calls.cpp")."""
    return (SRC / name).read_text()


def read_formatter() -> str:
    """Every unit of the layout in one text."""
    return "\n".join(path.read_text() for path in units())
