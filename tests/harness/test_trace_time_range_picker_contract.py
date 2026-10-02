from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_time_range_picker_is_loaded_before_the_traces_page():
    bootstrap = read("src/static/app_observability.js")
    # Common modules (the picker included) load before any view's modules.
    assert 'const COMMON_MODULES = ["app_format.js", "app_palette.js", "app_dom.js", "app_state.js", "app_util.js", "app_api.js", "app_ui.js", "app_timerange.js"];' in bootstrap
    assert '    traces: ["app_chart_core.js", "app_traces.js", ' in bootstrap


def test_time_range_panel_ships_grafana_layout_in_the_range_picker():
    html = read("src/static/observability.html")
    menu = html[html.index('<div id="tracesTimeRangePanel"'):html.index('<div class="traceSearchField traceSearchField--status">')]
    for token in (
        'id="tracesRangeStart"', 'id="tracesRangeEnd"', 'id="tracesTimeCalendar"', 'id="tracesCustomRangeApply"',
        'placeholder="Search quick ranges"', 'id="tracesQuickRanges"', 'id="tracesTimeZone"',
        'aria-label="Move time range backwards"', 'aria-label="Zoom out time range"', 'aria-label="Move time range forwards"',
    ):
        assert token in menu, token


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
    assert "const RECENT_LIMIT = 5;" in picker
    assert "if (!QUICK_RANGES.some((option) => sameRange(option, result.raw))) saveRecent(result.raw);" in picker


def test_default_window_follows_meta_until_the_user_picks_one():
    js = read("src/static/app_traces.js")
    assert 'if (!model.timeRangeTouched && model.meta) model.timeRange = { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };' in js
