"""Cross-cutting foundations (docs/ui-foundations.md): the base rules every page
relies on, so the drift the design audits found does not come back.

- Form controls take the page font (no browser Arial) and code / pre / kbd /
  samp the mono token at the size around them (01-base.css).
- One tab look: every row of sections is the underline row (.contentTabs);
  the nav rows' rows stand on their border (.contentTabs--nav).
- One size band (app_explorer_treemap.js band()) for All databases, the
  database page, the System Overview and the Disks rows: one height token, one
  colour rule (no colour picked from a name), Others hatched and in the legend.
- Range labels through ns.format.range (24 h, "Sep 12 14:00 -> 15:00").
- The categorical (service) slots keep 3:1 on --panel and --bg in each theme.
- One h1 per page shell.

The browser side of the same rules: tests/frontend/specs/ui-guards.spec.js.
"""
from __future__ import annotations

import re
from pathlib import Path

import css_sources

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="latin-1")


def test_form_controls_inherit_the_page_font_and_code_is_the_mono_token():
    base = css_sources.text()
    assert "button,\ninput,\nselect,\ntextarea {\n  font: inherit;\n  color: inherit;\n}" in base
    assert "code,\npre,\nkbd,\nsamp {\n  font-family: var(--font-mono);\n  font-size: inherit;\n}" in base
    # Both live in the base layer: any component sets its own size over them.
    block = (STATIC / "css" / "01-base.css").read_text(encoding="latin-1")
    assert "font: inherit;" in block and "font-family: var(--font-mono);" in block


def test_one_underline_tab_look_and_no_pill_tier():
    tabs = read("app_ui_tabs.js")
    assert 'const TAB_CLASS = "contentTabs__tab";' in tabs
    css = css_sources.text()
    assert not re.search(r"\.viewTabs?\b", css)
    for shell in ("query.html", "explorer.html", "observability.html", "system.html"):
        html = read(shell)
        assert "viewTab" not in html, shell
    docs = (ROOT / "docs" / "ui-foundations.md").read_text(encoding="utf-8")
    assert "**Segmented = modes, underline = sections.**" in docs


def test_one_size_band_and_one_colour_rule():
    treemap = read("app_explorer_treemap.js")
    assert "function band(container, options = {}) {" in treemap
    assert "const DOMINANT_SHARE = 0.85;" in treemap
    # No colour picked from a name: databases, tables and partitions are the
    # accent tint, only columns take their (legend-backed) type family.
    assert "hashName" not in treemap and "databaseColor" not in treemap
    assert 'return node?.kind === "column" ? columnFamily(node.type).color : "";' in treemap
    # Its four users.
    assert "storageView.renderTreemap(container, {" in read("app_explorer.js")
    assert "const band = treemap.band(container, {" in read("app_explorer_storage.js")
    assert "ns.explorerTreemap.band(treemapHost, {" in read("app_system_overview.js")
    assert "ns.explorerTreemap?.band(strip, {" in read("app_system_disks.js")
    assert "const colour = (name) =>" not in read("app_system_disks.js")
    css = css_sources.text()
    assert "height: var(--sizemap-h);" in css
    assert "--hatch: color-mix(in srgb, var(--text) 14%, transparent);" in css
    for old in ("--hatch-strong", "--tile-label-shadow", "explorerTreemapPanel--database", "systemDiskDb__swatch", "systemDiskDb__segment"):
        assert old not in css, old


def test_range_labels_read_the_shared_formatter():
    fmt = read("app_format.js")
    assert 'function range(from, to, { precision = "auto" } = {}) {' in fmt
    assert "const day = (f) => dateText(f, f.year !== thisYear);" in fmt
    timerange = read("app_timerange.js")
    assert "ns.format.range(startMs, endMs)" in timerange
    assert 'const stamp = (ms) => ns.format.time(ms, { precision: seconds ? "s" : "min" });' in timerange
    chart = read("app_query_chart.js")
    assert "ns.format.range(lo, hi, { precision })" in chart


def _hex_luminance(value: str) -> float:
    value = value.lstrip("#")
    channels = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _ratio(a: str, b: str) -> float:
    la, lb = sorted((_hex_luminance(a), _hex_luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def test_categorical_slots_keep_three_to_one_on_the_panel_and_the_page_in_each_theme():
    tokens = (STATIC / "css" / "00-tokens.css").read_text(encoding="latin-1")
    starts = [m.start() for m in re.finditer(r'^(?::root|@media \(prefers-color-scheme: light\)|html\[data-theme="(?:dark|light)"\]) \{', tokens, flags=re.M)]
    assert len(starts) >= 4
    checked = 0
    for index, start in enumerate(starts):
        body = tokens[start:starts[index + 1] if index + 1 < len(starts) else len(tokens)]
        values = dict(re.findall(r"--(qchart-\d+|panel|bg):\s*(#[0-9a-fA-F]{6});", body))
        if "panel" not in values:
            continue
        for name, value in values.items():
            if not name.startswith("qchart"):
                continue
            for surface in ("panel", "bg"):
                assert _ratio(value, values[surface]) >= 3, (body[:40], name, surface)
            checked += 1
    assert checked >= 4 * 18


def test_one_h1_per_page_shell_and_an_h2_per_view_and_card():
    for shell in ("query.html", "explorer.html", "observability.html", "system.html"):
        assert len(re.findall(r"<h1\b", read(shell))) == 1, shell
    obs = read("observability.html")
    for view in ("Traces", "Logs", "Metrics"):
        assert f'<h2 class="srOnly">{view}</h2>' in obs
    explorer = read("explorer.html")
    assert '<h2 id="explorerDetailName" class="explorerDetailName"></h2>' in explorer
    assert '<h2 id="explorerFunctionDetailName" class="explorerDetailName"></h2>' in explorer


def test_chart_canvas_colours_come_from_the_tokens():
    core = read("app_chart_core.js")
    assert 'color("var(--panel)")' in core and "grid: rgba(text, 0.09)," in core
    assert "#0f1623" not in core and "rgba(240, 250, 255" not in core
