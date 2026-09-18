from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def test_processor_codec_behavior() -> None:
    result = subprocess.run(
        ["node", "--test", "tests/frontend/model/processors-compact.test.cjs"],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_live_response_omits_expanded_processor_duplicates() -> None:
    source = (ROOT / "src/api_analysis.cpp").read_text(encoding="utf-8")
    compact = source.index('writer.Key("processors_compact")')
    debug = source.index("if (include_original_trace)", compact)
    assert 'writer.Key("processors")' not in source[compact:debug]
    assert 'writer.Key("processor_trace_summary")' not in source[compact:debug]
    assert 'writer.Key("processors")' in source[debug:]
    assert 'writer.Key("processor_trace_summary")' in source[debug:]


def test_processor_decoder_is_loaded_before_analysis() -> None:
    source = (ROOT / "src/static/app.js").read_text(encoding="utf-8")
    assert source.index('"app_analysis_data.js"') < source.index('"app_analysis.js"')
