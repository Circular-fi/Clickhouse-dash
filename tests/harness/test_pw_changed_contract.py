"""tests/tools/pw-changed.sh picks the Playwright specs of a change (ARCH-F-284): every file of the frontend maps to
specs that exist, and the files that once fell to the general set map to their own."""
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tests/tools/pw-changed.sh"
SPECS = {path.name[: -len(".spec.js")] for path in (ROOT / "tests/frontend/specs").glob("*.spec.js")}
GENERAL = {"functional", "ui-foundations", "page-chrome"}


def selection(*files):
    run = subprocess.run(
        ["bash", str(SCRIPT), "-n"], capture_output=True, text=True, check=False,
        env={**os.environ, "PW_CHANGED_FILES": " ".join(files)},
    )
    assert run.returncode == 0, run.stderr
    # "pw-changed: specs/a.spec.js specs/b.spec.js", plus a line for each name of the table that is not a spec.
    stale = [line for line in run.stderr.splitlines() if "no spec named" in line]
    assert stale == [], stale
    line = next((l for l in run.stderr.splitlines() if l.startswith("pw-changed: specs/")), "")
    return {name.removeprefix("specs/").removesuffix(".spec.js") for name in line.removeprefix("pw-changed: ").split()}


FILES = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "src/static").glob("app_*.js")) + \
    sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "src/static").glob("*.html")) + \
    sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "src/wasm").glob("*.c")) + \
    sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "src/static/wasm").glob("*.wasm"))


@pytest.mark.parametrize("file", FILES)
def test_every_frontend_file_maps_to_specs_that_exist(file):
    chosen = selection(file)
    assert chosen, file
    assert chosen <= SPECS, sorted(chosen - SPECS)


@pytest.mark.parametrize("file, expected", [
    ("src/static/app_mcp_form.js", "mcp-page"),
    ("src/static/mcp.html", "mcp-page"),
    ("src/static/app_mcp_overview.js", "mcp-usage"),
    ("src/static/app_page_mcpusage.js", "mcp-usage"),
    ("src/static/mcpusage.html", "mcp-usage"),
    ("src/static/app_mcp_view.js", "mcp-usage"),
    ("src/static/app_mcp_view.js", "mcp-page"),
    ("src/static/css/20-features/mcp.css", "mcp-usage"),
    ("src/static/app_page_trace.js", "trace-page"),
    ("src/static/trace.html", "trace-page"),
    ("src/static/app_page_shape.js", "system"),
    ("src/static/shape.html", "system"),
    ("src/static/app_highlight.js", "wasm-highlight"),
    ("src/static/app_autocomplete.js", "wasm-sql"),
    ("src/static/app_sql.js", "wasm-sql"),
    ("src/static/app_results_sort.js", "wasm-rowsort"),
    ("src/static/app_wasm_chartprep.js", "wasm-chartprep"),
    ("src/wasm/sqlscan.c", "wasm-sql"),
    ("src/static/wasm/treemap.wasm", "wasm-treemap"),
    ("src/static/app_ui_filterbar.js", "obs-filterbar"),
    ("src/static/app_trace_nav.js", "trace-page"),
])
def test_the_files_that_fell_to_the_general_set_have_their_own_specs(file, expected):
    assert expected in selection(file)


def test_a_module_of_one_page_does_not_run_the_general_set():
    # app_system_charts.js is loaded by the System pages only.
    chosen = selection("src/static/app_system_charts.js")
    assert "system" in chosen and not (GENERAL <= chosen)
