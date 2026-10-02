import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


# Jaeger UI's --span-color-1..20 without the reds 6 and 16.
JAEGER_DARK = ['#1192e8', '#ff832b', '#a56eff', '#f1c21b', '#009d9a', '#24a148', '#ee538b', '#00539c', '#8d8d8d',
               '#0072c3', '#ba4e00', '#8a3ffc', '#b28600', '#005d5d', '#198038', '#9f1853', '#002d9c', '#6929c4']
JAEGER_LIGHT = ['#0072c3', '#eb6200', '#8a3ffc', '#b28600', '#005d5d', '#198038', '#9f1853', '#002d9c', '#6f6f6f',
                '#00539c', '#8a3800', '#6929c4', '#8e6a00', '#002d2d', '#0e6027', '#510224', '#001141', '#491d8b']


def palette(block):
    return [re.search(rf'--trace-span-color-{i}: (#[0-9a-f]{{6}});', block).group(1) for i in range(1, 19)]


def test_service_colours_are_jaegers_palette_without_red_in_first_seen_order():
    js = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    # The assignment is ns.palette's (app_palette.js), shared with Logs and Metrics.
    shared = read('src/static/app_palette.js')
    assert 'const SERVICE_SLOTS = 18;' in shared
    assert 'slot = map.size % SERVICE_SLOTS;' in shared
    assert 'return tokenRef(`--trace-span-color-${serviceSlot(name, options) + 1}`);' in shared
    assert 'palette.service(span.service_name)' in js and 'palette.registerServices(' in read('src/static/app_trace_spans.js')
    assert 'SERVICE_COLORS' not in js and 'SPAN_COLOR_COUNT' not in js and 'trace-span-color-' not in js
    dark = css.split('html[data-theme="dark"] {\n  --trace-span-color-1', 1)[1].split('}', 1)[0]
    light = css.split('html[data-theme="light"] {\n  --trace-span-color-1', 1)[1].split('}', 1)[0]
    assert palette('--trace-span-color-1' + dark) == JAEGER_DARK
    assert palette('--trace-span-color-1' + light) == JAEGER_LIGHT
    for red in ('#da1e28', '#a2191f', '#fa4d56', '#570408'):
        assert red not in JAEGER_DARK + JAEGER_LIGHT


def test_error_bars_keep_service_colour_and_collapsed_errors_get_a_hollow_marker():
    js = read('src/static/app_traces.js')
    css = read('src/static/style.css')
    assert 'const childError = !error && collapsed && cache.errorBelow.has(node);' in js
    assert 'traceSpanRow__errorBadge--hollow' in js and '.traceSpanRow__errorBadge--hollow {' in css
    assert 'background: #e45756;' not in css
    assert '.traceSpanBar--error { background: #ef4444; }' not in css


def test_waterfall_has_jaeger_tree_ticks_critical_path_and_virtual_rows():
    js = read('src/static/app_traces.js')
    assert 'function treeOffsetHtml(node, cache)' in js
    assert 'const MIN_TICK_LABEL_SPACING_PX = 130;' in js
    assert 'function wallClockLabel(startNs, offsetNs = 0, stepNs = Infinity)' in js
    assert 'function criticalPathSections(cache)' in js
    assert 'function expandOneLevel()' in js and 'function collapseOneLevel()' in js
    assert 'function startTimelineDrag(header, event)' in js
    assert 'const OVERVIEW_CANVAS_ABOVE = 1000;' in js
    assert 'const VIRTUAL_ROWS_ABOVE = 1000;' in js
    for key in ('"[": expandAllSpans', '"]": collapseAllSpans', 'o: expandOneLevel', 'p: collapseOneLevel'):
        assert key in js
