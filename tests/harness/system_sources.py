"""The sources of the System page for the contract tests.

The statements and the rules of each section are in src/system_*.{hpp,cpp}: the capability detection (system_monitor), the Overview
(system_overview), the Performance series (system_series), the Queries (system_queries), the Disks and their growth (system_disks) and the
Activity (system_activity). The routes are adapters in src/api_system.cpp and src/api_system_activity.cpp. A test that checks the text of a
statement or of a rule reads the unit that holds it (`read_unit`), or all of the monitor units (`read_monitor`).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"

MONITOR_UNITS = ["system_monitor", "system_monitor_caps", "system_overview", "system_series", "system_queries", "system_disks"]


def read_unit(name: str) -> str:
    """One unit by its file name, for example read_unit("system_series.cpp")."""
    return (SRC / name).read_text()


def read_monitor(suffix: str = ".cpp") -> str:
    """Every monitor source (or, with ".hpp", every header) in one text."""
    paths = [SRC / (unit + suffix) for unit in MONITOR_UNITS if (SRC / (unit + suffix)).exists()]
    return "\n".join(path.read_text() for path in paths)
