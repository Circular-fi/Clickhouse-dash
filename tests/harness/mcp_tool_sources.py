"""The sources of the MCP tools for the contract tests.

src/mcp_tools.cpp picks a tool by its name. What the tools share is src/mcp_tool_support.{hpp,cpp}, and the tools are in src/mcp_tools_<family>.cpp
(schema, query, otel, api). A test that checks one tool reads its unit (`read_unit`), or all of them (`read_tools`).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"


def units() -> list[Path]:
    """The dispatch first, then what the tools share, then the families in the order of their names."""
    return [SRC / "mcp_tools.cpp", SRC / "mcp_tool_support.hpp", SRC / "mcp_tool_support.cpp", SRC / "mcp_tools_units.hpp"] + sorted(SRC.glob("mcp_tools_*.cpp"))


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("mcp_tools_api.cpp")."""
    return (SRC / name).read_text()


def read_tools() -> str:
    """Every unit of the tools in one text."""
    return "\n".join(path.read_text() for path in units())
