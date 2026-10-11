"""The Node unit scripts of the harness (explorer_card_unit.js, chart_axis_unit.js, ui_foundations_unit.js).

Each script loads the real ES modules of src/static in a bare vm context (esm_vm.js) and prints {"checks": n, "failures": [...]}.
They run once per time zone when the result depends on it: browser-local time is the display zone, so the date, year and DST edges
of the axis labels and of ns.format move with TZ. The newer Node tests of the pure modules are tests/frontend/model/*.test.cjs
(test_frontend_models.py).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent
ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
ZONES = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]


def run_unit(script: str, zone: str | None, timeout: int) -> dict:
    node = shutil.which("node")
    assert node, "node is not installed: run the harness in the tests image (tests/Dockerfile.tests)"
    env = {**os.environ, **({"TZ": zone} if zone else {})}
    proc = subprocess.run([node, "--experimental-vm-modules", "--no-warnings", str(HERE / script), str(ROOT)],
                          capture_output=True, text=True, env=env, timeout=timeout, check=False)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert not result["failures"], json.dumps(result["failures"], indent=1, ensure_ascii=False)
    return result


def test_the_sql_expression_helpers_of_the_table_card_and_the_highlighter() -> None:
    assert run_unit("explorer_card_unit.js", None, 60)["checks"] >= 30


@pytest.mark.parametrize("zone", ZONES)
def test_the_time_axis_labels_of_the_chart_engine(zone: str) -> None:
    # The labels of 1 h, 24 h, 7 d and 30 d ranges on plots of 1440 and 390 px from many starts: no two labels or date lines touch,
    # the date shows on the first label and where it changes, the year only there and where the year changes.
    result = run_unit("chart_axis_unit.js", zone, 120)
    assert result["zone"] == zone
    assert result["checks"] > 20000


@pytest.mark.parametrize("zone", ZONES)
def test_ns_format_and_ns_palette(zone: str) -> None:
    result = run_unit("ui_foundations_unit.js", zone, 60)
    assert result["zone"] == zone
    assert result["checks"] > 250
