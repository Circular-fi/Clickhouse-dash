import re
from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


# The one categorical palette (--qchart-1..18): services and chart series.
QCHART_DARK = ['#4296fb', '#e86a34', '#29ae81', '#d28f09', '#de669a', '#4ba435', '#9e8cf4', '#49c1ea', '#febad9',
               '#ddd674', '#7572ae', '#a86751', '#9fb83c', '#0695b5', '#cf95c1', '#bdbcfd', '#8e8945', '#85e2ed']
QCHART_LIGHT = ['#1a73d5', '#c14802', '#088963', '#9c6900', '#b84379', '#227702', '#644fb1', '#046480', '#700048',
                '#433f01', '#39346a', '#7c3f2a', '#768c02', '#078ead', '#7c4972', '#7b78b4', '#656019', '#03464c']
SURFACES = {'dark': ('#0d0f12', '#13161a', '#191d22'), 'light': ('#f6f7f9', '#ffffff', '#ffffff')}


def _luminance(color):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    r, g, b = (c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a, b):
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _hue(color):
    import colorsys
    h, _, s = colorsys.rgb_to_hls(*(int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)))
    return h * 360, s


def test_service_colours_are_the_categorical_palette_without_red_in_first_seen_order():
    js = read('src/static/app_traces.js')
    css = css_sources.text()
    # The assignment is ns.palette's (app_palette.js), shared with Logs and Metrics.
    shared = read('src/static/app_palette.js')
    assert 'const SERVICE_SLOTS = 18;' in shared
    assert 'slot = map.size % SERVICE_SLOTS;' in shared
    assert 'return tokenRef(`--trace-span-color-${serviceSlot(name, options) + 1}`);' in shared
    assert 'palette.service(span.service_name)' in js and 'palette.registerServices(' in read('src/static/app_trace_spans.js')
    assert 'SERVICE_COLORS' not in js and 'SPAN_COLOR_COUNT' not in js and 'trace-span-color-' not in js
    root = css_sources.decls(':root')
    dark = css_sources.decls('html[data-theme="dark"]')
    light = css_sources.decls('html[data-theme="light"]')
    # Services name the categorical slots (one palette); the slot values are per theme.
    assert [root[f'--trace-span-color-{i}'] for i in range(1, 19)] == [f'var(--qchart-{i})' for i in range(1, 19)]
    assert [dark[f'--qchart-{i}'] for i in range(1, 19)] == QCHART_DARK
    assert [light[f'--qchart-{i}'] for i in range(1, 19)] == QCHART_LIGHT
    # 3:1 on every surface of its theme, 18 distinct values, no red (hue 345-15 degrees, saturated).
    for theme, colors in (('dark', QCHART_DARK), ('light', QCHART_LIGHT)):
        assert len(set(colors)) == 18
        for color in colors:
            assert min(_contrast(color, surface) for surface in SURFACES[theme]) >= 3, (theme, color)
            hue, saturation = _hue(color)
            assert not ((hue >= 345 or hue <= 15) and saturation > 0.5 and _luminance(color) < 0.3), (theme, color, hue)


def test_error_bars_keep_service_colour_and_collapsed_errors_get_a_hollow_marker():
    js = read('src/static/app_traces.js')
    css = css_sources.text()
    assert 'const childError = !error && collapsed && cache.errorBelow.has(node);' in js
    # The hollow marker is the shared error badge without its fill.
    assert 'tone: "error", className: "badge--count traceSpanRow__errorBadge traceSpanRow__errorBadge--hollow"' in js
    assert 'tone: "error", solid: true, className: "badge--count traceSpanRow__errorBadge"' in js
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
