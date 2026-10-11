"""The sources of the query library for the contract tests.

The store is src/query_library.cpp. What it calls lives in src/query_library_*.{hpp,cpp}: the file format and the atomic write, the reading of
a request, the rules of the tree and the import. A test that checks one rule reads the unit that holds it (`read_unit`), or all of them
(`read_library`).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def units() -> list[Path]:
    """The store first, then the units in the order of their names (headers before sources)."""
    return [SRC / "query_library.hpp", SRC / "query_library.cpp"] + sorted(SRC.glob("query_library_*.hpp")) + sorted(SRC.glob("query_library_*.cpp"))


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("query_library_file.cpp")."""
    return (SRC / name).read_text()


def read_library() -> str:
    """Every unit of the library in one text, without the HTTP adapters (src/api_query_library.cpp)."""
    return "\n".join(path.read_text() for path in units())
