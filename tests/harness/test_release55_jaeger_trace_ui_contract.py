from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel):
    return (ROOT / rel).read_text()


def test_trace_search_layout_tracks_jaeger_structure():
    html = read('src/static/traces.html')
    css = read('src/static/style.css')
    js = read('src/static/app_traces.js')

    for token in (
        'id="tracesRangeUnit"',
        'id="tracesPrefillButton"',
        'id="tracesService"',
        'id="tracesOperation"',
        'id="tracesTagsButton"',
        'id="tracesTagKey"',
        'id="tracesTagValue"',
        'id="tracesStatus"',
        'id="tracesLimit"',
        'id="traceServiceChart"',
        'id="traceDurationChart"',
        'id="tracesSort"',
        'id="traceDetail"',
        'id="traceWaterfall"',
        'id="traceInspector"',
    ):
        assert token in html

    assert 'Trace search dashboard' in css
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
