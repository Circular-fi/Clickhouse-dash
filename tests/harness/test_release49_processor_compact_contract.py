import json
import modules
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_live_response_omits_expanded_processor_duplicates() -> None:
    source = (ROOT / "src/api_analysis.cpp").read_text(encoding="utf-8")
    compact = source.index('writer.Key("processors_compact")')
    debug = source.index("if (include_original_trace)", compact)
    assert 'writer.Key("processors")' not in source[compact:debug]
    assert 'writer.Key("processor_trace_summary")' not in source[compact:debug]
    assert 'writer.Key("processors")' in source[debug:]
    assert 'writer.Key("processor_trace_summary")' in source[debug:]


def test_processor_decoder_is_loaded_before_analysis() -> None:
    # The decoder is imported by the analysis module: it is evaluated first.
    files = modules.page_files("query")
    assert files.index("app_analysis_data.js") < files.index("app_analysis.js")
