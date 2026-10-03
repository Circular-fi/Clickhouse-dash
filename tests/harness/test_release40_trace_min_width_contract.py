from pathlib import Path
import css_sources


ROOT = Path(__file__).resolve().parents[2]
TRACE = (ROOT / "src/static/app_trace_viewer.js").read_text()
CSS = css_sources.text()


def test_trace_segments_have_screen_pixel_minimum_width():
    assert 'traceViewer__segmentMinWidth' in TRACE
    assert 'vector-effect", "non-scaling-stroke"' in TRACE
    assert 'minWidthCommands.push(`M${x1.toFixed(2)} 6V14`)' in TRACE
    assert '.traceViewer__bar {' in CSS
    assert 'min-width: 2px;' in CSS
    assert '.traceViewer__segmentMinWidth {' in CSS
    assert 'stroke-width: 1px;' in CSS
