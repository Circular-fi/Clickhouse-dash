"""Time axis labels of the shared chart engine (app_chart_core.js).

The unit checks live in chart_axis_unit.js (Node runs the engine in a bare
window, no DOM) and run once per time zone below: the axis reads
browser-local time, so midnights, year ends and DST days move with TZ. They
lay the labels of 1 h, 24 h, 7 d and 30 d ranges (and longer) out on plots of
a 1440 px and a 390 px page from many starts, and check that no two labels
and no two date lines touch, that the date line shows on the first label and
where the date changes, and the year only there and where the year changes.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
UNIT = Path(__file__).with_name("chart_axis_unit.js")
ZONES = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]


def read(name: str) -> str:
    return (ROOT / "src" / "static" / name).read_text(encoding="latin-1")


@pytest.mark.parametrize("zone", ZONES)
def test_time_axis_labels_unit_checks(zone: str) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed (the tests image has it)")
    env = {**os.environ, "TZ": zone}
    proc = subprocess.run([node, str(UNIT), str(ROOT)], capture_output=True, text=True, env=env, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["zone"] == zone
    assert result["checks"] > 20000, result["checks"]
    assert not result["failures"], json.dumps(result["failures"], indent=1)


def test_the_engine_lays_the_labels_out_once_per_draw_from_cached_widths() -> None:
    engine = read("app_chart_core.js")
    # Laid out with the plot (computeLayout), drawn from the layout.
    assert "L.xLabels = layoutXLabels(L.xTicks, L.xOf, left, left + plotW, width, measure, measureBold);" in engine
    assert "for (const t of L.xLabels) ctx.fillText(t.label, t.x, y1);" in engine
    # The date line is measured at the bold font it is drawn in; both caches
    # are dropped with the theme (fonts may have changed).
    assert "const measureBold = (text) => measureIn(boldWidths, theme.fontBold, text);" in engine
    assert "widths.clear();\n      boldWidths.clear();" in engine
    assert '"textMeasures"' in engine
    assert "layoutXLabels," in engine
