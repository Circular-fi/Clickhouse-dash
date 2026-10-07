from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_search_layout_tracks_jaeger_structure():
    html = read('src/static/traces.html')
    css = css_sources.text()
    js = read('src/static/app_traces.js')

    for token in (
        'id="tracesRangeUnit"',
        'id="tracesService"',
        'id="tracesOperation"',
        'id="tracesTagKey"',
        'id="tracesTagValue"',
        'id="tracesStatus"',
        'id="tracesLimit"',
        'id="traceServiceChart"',
        'id="traceDurationChart"',
        'id="tracesSort"',
    ):
        assert token in html
    # One trace is a page of its own (trace.html, /observability/traces/<id>), not a pane of the search.
    trace_html = read('src/static/trace.html')
    for token in ('id="traceDetail"', 'id="traceWaterfall"', 'id="traceInspector"'):
        assert token in trace_html
        assert token not in html

    assert 'Trace search dashboard' in css
    assert 'id="tracesPrefillButton"' not in html
    assert 'renderServiceChart' in js
    assert 'renderDurationChart' in js
    assert 'buildTree' in js
    assert 'traceBackButton' in js
    assert 'setView(' in js


def test_trace_duration_filters_are_trace_level():
    cpp = read('src/api_traces.cpp')
    assert 'max_duration_ms' in cpp
    assert 'duration is a trace-' in cpp.lower()
    assert 'level filter' in cpp.lower()
    assert 'duration_ns' in cpp
    assert 'HAVING' in cpp


def test_fixture_error_rate_is_low_and_no_forced_periodic_error():
    generator = read('examples/generate_otel_traces.py')
    seed = read('tests/otel-fixture/seed.py')
    compose = read('tests/docker-compose.yml')
    env = read('tests/.env.example')

    assert 'default=0.0002' in generator
    assert '"0.0002"' in seed
    assert 'OTEL_FIXTURE_ERROR_RATE:-0.0002' in compose
    assert 'OTEL_FIXTURE_ERROR_RATE=0.0002' in env
    assert 'trace_index % 4' not in generator
