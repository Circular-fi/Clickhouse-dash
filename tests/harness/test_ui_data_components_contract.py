"""Data display components (app_ui_table.js, app_ui_badge.js, app_ui_copy.js,
app_ui_sql.js, app_ui_kv.js, app_ui_stat.js, app_ui_chart.js): one module per
family, loaded on every page, and no local copy of what they draw.

A new table, badge family, copy helper, SQL view, key / value renderer, stat
tile or chart legend fails here: use the component (or extend it), or add a
justified entry to the allow-lists below."""
from __future__ import annotations

import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
MODULES = ["app_ui_table.js", "app_ui_badge.js", "app_ui_copy.js", "app_ui_sql.js", "app_ui_kv.js", "app_ui_stat.js", "app_ui_chart.js"]


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def scripts():
    for path in sorted(STATIC.glob("*.js")):
        yield path.name, path.read_text(encoding="utf-8")


def css_block(name: str) -> str:
    css = read("style.css")
    start = css.index(f"/* ==== Components: {name}")
    return css[start:css.index(f"/* ==== /Components: {name}", start)]


def offenders(pattern: str, allowed: set[str] = frozenset(), files=None):
    regex = re.compile(pattern)
    found = []
    for name, text in scripts():
        if name in allowed or (files and name not in files):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if regex.search(line):
                found.append(f"{name}:{number}: {line.strip()[:120]}")
    return found


def test_component_modules_load_on_every_page_after_the_foundations():
    # The manifest's common list (src/static/modules.json): every page loads
    # them, after app_dom.js and app_util.js (ns.util.escapeHtml).
    import json
    common = json.loads(read("modules.json"))["common"]
    for module in MODULES:
        assert (STATIC / module).is_file(), module
        assert module in common, module
        assert common.index(module) > common.index("app_dom.js") and common.index(module) > common.index("app_util.js"), module
        assert f"/* ==== Components: " in read("style.css")
    # ns.ui keeps what the component modules put on it.
    assert "ns.ui = Object.assign(ns.ui || {}, {" in read("app_ui.js")


def test_every_table_is_a_data_table():
    tables = re.compile(r"""<table class="([^"]*)"|node\("table", [`"]([^`"]*)[`"]\)|createElement\("table"\)""")
    bad = []
    for name, text in scripts():
        for number, line in enumerate(text.splitlines(), 1):
            for match in tables.finditer(line):
                classes = match.group(1) or match.group(2) or ""
                if "chartCore__legendTable" in classes:  # the chart engine's legend
                    continue
                if match.group(0).startswith("createElement"):
                    # app_results.js names the class on the next line.
                    if name != "app_results.js":
                        bad.append(f"{name}:{number}")
                    continue
                if "dataTable" not in classes:
                    bad.append(f"{name}:{number}: {classes}")
    assert not bad, bad
    results = read("app_results.js")
    assert 'table.className = `resultTable dataTable dataTable--grid${compact ? " dataTable--compact" : ""}`;' in results
    assert '<table class="resultTable dataTable dataTable--grid">' in read("query.html")


def test_one_sort_indicator_and_one_set_of_row_keys():
    # Sort state lives in aria-sort (ns.table), the glyph in CSS only.
    assert not offenders(r"dataset\.sort\s*=|data-sort=\"\$\{|resultTable__thSortable|sortMark\(")
    assert not offenders(r"\\u25b[2c4e]", {"app_explorer_graph.js"})  # canvas group label only
    block = css_block("data table")
    assert 'th[aria-sort="ascending"] > .dataTable__sort::after' in block
    assert "th:hover > .dataTable__sort::after" in block
    # Row keys: ns.rovingRows, not a local ArrowUp / ArrowDown handler.
    local = offenders(r"event\.key === \"ArrowDown\" \|\| event\.key === \"ArrowUp\"|event\.key !== \"ArrowDown\" && event\.key !== \"ArrowUp\"",
                      files={"app_logs.js", "app_trace_spans.js", "app_trace_services.js", "app_traces.js", "app_trace_views.js", "app_trace_insights.js", "app_results.js"})
    # The span panel's own Up / Down (previous / next span while the panel has
    # focus) is panel navigation, not a table's row keys.
    local = [line for line in local if not line.startswith("app_trace_spans.js:") or "select(index + (event.key" not in "\n".join(read("app_trace_spans.js").splitlines()[int(line.split(":")[1]) - 1:int(line.split(":")[1]) + 3])]
    assert not local, local
    for name in ["app_logs.js", "app_trace_spans.js", "app_trace_services.js", "app_traces.js", "app_trace_views.js", "app_trace_insights.js", "app_results.js"]:
        assert "rovingRows(" in read(name), name


def test_in_cell_bars_are_cell_bars_and_stay_off_identifiers_and_signed_columns():
    assert not offenders(r"resultTable__gaugeCell|--gaugeFill|traceTable__bar|traceSpanListRow__bar|explorerOpsProgress|explorerStorageList__bar|traceSvcShare__bar|logsShareBar")
    table = read("app_ui_table.js")
    assert "function barEligible(" in table and "return !(Number(min) < 0);" in table
    assert "ns.table.barEligible({ name, min })" in read("app_results.js")


def test_badges_chips_and_swatches_are_the_shared_ones():
    css = read("style.css")
    for family in [".traceTag {", ".metricsBadge {", ".explorerBadge {", ".traceSvcBadge", ".logsSevBadge", ".traceFilterChip {",
                   ".logsChip {", ".metricsChip {", ".explorerFilterChip {", ".traceStatus {", ".traceSvcPill {", ".traceSpanPill {",
                   ".logsServiceDot", ".traceSvcDot", ".traceSpanListRow__dot", ".traceLogsChip {", ".explorerMetaChip {"]:
        assert not re.search(r"(^|[\n,]\s*)" + re.escape(family), css), family
    block = css_block("badge")
    for tone in ["neutral", "accent", "ok", "warn", "error", "estimate", "key"]:
        assert f".badge--{tone}" in block, tone
    assert ".badge--md" in block and ".badge--pill" in block and ".serviceSwatch--bar" in block and ".chips__clear" in block
    badge = read("app_ui_badge.js")
    assert 'const STATUS_LABEL = { ok: "OK", error: "Error", unset: "Unset" };' in badge
    # Metric kinds are categories: no status (red / orange) hue for a histogram.
    metrics = read("app_metrics.js")
    assert "histogram: ns.palette.categorical(6)" in metrics and "qchart-2" not in metrics


def test_one_copy_helper_and_one_feedback():
    assert not offenders(r"navigator\.clipboard|execCommand\(\"copy\"\)", {"app_ui_copy.js"})
    assert not offenders(r"flashButtonText|copyTextToClipboard|copyJsonToast|classList\.add\(\"is-copied\"\)", {"app_ui_copy.js"})
    assert "copyJsonToast" not in read("query.html")
    for name in ["app_run.js", "app_traces.js", "app_logs.js"]:
        assert "ns.ui.copySplit({" in read(name), name
    assert not offenders(r"function (open|close)(Trace)?CopyMenu")
    css = read("style.css")
    assert ".is-copied" not in css.replace(css_block("copy"), "").replace(css_block("data table"), "")


def test_read_only_sql_is_the_sql_block():
    for name in ["app_explorer_detail.js", "app_explorer_graph.js", "app_trace_services.js", "app_query_library.js", "app_explorer_ops.js"]:
        assert "ns.ui.sqlBlock" in read(name), name
    # Highlighted SQL elsewhere: the editor, autocomplete and function docs.
    assert not offenders(r"ns\.highlight\.renderInto\(", {"app_explorer.js", "app_ui_sql.js"})
    sql = read("app_ui_sql.js")
    assert "ns.highlight.toHtml(" in sql and "ns.loader.loadGroup(HIGHLIGHT_GROUP)" in sql
    # Observability loads the highlighter on first use (a lazy group).
    import json
    assert json.loads(read("modules.json"))["pages"]["observability"]["lazy"]["highlight"] == ["app_highlight.js"]


def test_key_value_lists_are_the_shared_list():
    assert not offenders(r"traceKv__|traceJson__|logsField__|logsFieldAction|explorerGraphPanel__columnName")
    for name in ["app_traces.js", "app_logs.js", "app_results.js", "app_explorer_graph.js"]:
        text = read(name)
        assert "kvList" in text or "kvListHtml" in text, name
    block = css_block("key/value")
    for kind in ["string", "number", "bool", "null"]:
        assert f".kv__v--{kind} {{ color: var(--json-{kind});" in block, kind


def test_stat_tiles_are_sentence_case():
    block = css_block("stat tile")
    assert "text-transform: none;" in block
    css = read("style.css")
    rules = re.findall(r"([^{}]+)\{([^{}]*)\}", re.sub(r"/\*.*?\*/", " ", css, flags=re.S))
    for selector, body in rules:
        if "uppercase" not in body:
            continue
        for family in ["metricCompact__label", "explorerAboutTile", "tracePageOverviewItem", "traceSvcStat", "explorerOpsTile",
                       "graphKitPanel__stats", "pipelineViewer__head", "logsTable__head", "logsPatterns__head", "traceSpanPanel__fact"]:
            assert family not in selector, selector.strip()


def test_charts_share_the_card_legend_readout_and_sparkline():
    engine = read("app_chart_core.js")
    assert '(!!opts.legend && opts.series.length > 1)' in engine
    assert 'opts.legend === "totals"' in engine and "ns.format.range(start, start + Number(opts.bucketMs))" in engine
    assert 'id="logsLegend"' not in read("observability.html")
    for name in ["app_traces.js", "app_trace_services.js", "app_logs.js", "app_metrics.js", "app_trace_heatmap.js"]:
        assert "bucketMs" in read(name), name
        assert "xReadout: (i) => fmt.range" not in read(name), name
    for name, needle in [("observability.html", 'class="traceAnalyticsCard chartCard"'), ("app_metrics.js", '"metricsPanel chartCard"'),
                         ("app_query_chart.js", '"queryChart chartCard"'), ("observability.html", 'class="logsHistogram chartCard"'),
                         ("app_trace_services.js", "ns.ui.chartCardHtml(")]:
        assert needle in read(name), name
    # One sparkline: SVG polylines are drawn by app_ui_chart.js only.
    assert not offenders(r"<polyline", {"app_ui_chart.js"})
    assert "<canvas" not in read("query.html")
