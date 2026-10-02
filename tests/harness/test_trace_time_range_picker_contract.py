import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_time_range_picker_is_loaded_before_the_traces_page():
    manifest = json.loads(read("src/static/modules.json"))
    page = manifest["pages"]["observability"]
    # Common modules (the picker included) load before any view's modules.
    common = manifest["common"] + page["modules"]
    assert common[:11] == ["app_format.js", "app_palette.js", "app_dom.js", "app_ui_layers.js", "app_ui_popover.js", "app_ui_panel.js", "app_ui_tabs.js", "app_ui_segmented.js", "app_ui_menu.js", "app_state.js", "app_util.js"]
    assert {"app_dom.js", "app_state.js", "app_util.js", "app_api.js", "app_ui.js", "app_timerange.js"} <= set(common)
    assert "app_timerange.js" not in [name for files in page["views"].values() for name in files]
    assert page["views"]["traces"][:3] == ["app_chart_core.js", "app_facet_panel.js", "app_traces.js"]
    assert "await loader.startModules();" in read("src/static/app_observability.js")


def test_time_range_panel_ships_grafana_layout_in_the_range_picker():
    html = read("src/static/observability.html")
    picker = read("src/static/app_timerange.js")
    # One panel builder (app_timerange.js panelHtml) instead of a copy of the
    # markup per view: the page ships only the range picker's button.
    assert "timeRangePanel" not in html
    assert html.count('<div class="themeSelect tracePicker tracePicker--range">') == 3
    menu = picker[picker.index("  function panelHtml(p) {"):picker.index("  function create(root, options) {")]
    for token in (
        'id="${p}Range${side}"', 'field("Start", "From"', 'field("End", "To"', 'id="${p}TimeCalendar"', 'id="${p}CustomRangeApply"',
        'placeholder="Search quick ranges"', 'id="${p}QuickRanges"', 'id="${p}TimeZone"',
        '"Move time range backwards"', '"Zoom out time range"', '"Move time range forwards"',
    ):
        assert token in menu, token
    for view in ("traces", "logs", "metrics"):
        assert f'idPrefix: "{view}",' in read(f"src/static/app_{view}.js"), view


def test_ranges_resolve_per_request_in_browser_local_time():
    js = read("src/static/app_traces.js")
    picker = read("src/static/app_timerange.js")
    assert 'const { startMs, endMs } = tr.resolveRange(model.timeRange, Date.now());' in js
    assert 'return { startMs: parseTime(raw?.from, false, nowMs), endMs: parseTime(raw?.to, true, nowMs) };' in picker
    assert "Intl.DateTimeFormat().resolvedOptions().timeZone" in picker
    assert 'timeZone.textContent = `Browser time · ${timeZoneLabel()}`;' in picker


def test_recent_ranges_are_kept_per_browser_and_bounded():
    picker = read("src/static/app_timerange.js")
    assert 'const RECENT_KEY = "chdash.traceTimeRanges.v1";' in picker
    assert "const RECENT_LIMIT = 2;" in picker
    assert "if (!QUICK_RANGES.some((option) => sameRange(option, result.raw))) saveRecent(result.raw);" in picker


def test_default_window_follows_meta_until_the_user_picks_one():
    js = read("src/static/app_traces.js")
    assert 'if (!model.timeRangeTouched && model.meta) model.timeRange = { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };' in js
