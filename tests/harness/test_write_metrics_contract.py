from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def test_result_payload_and_clickhouse_writes_are_distinct() -> None:
    header = read("src/query_session.hpp")
    source = read("src/query_session.cpp")
    stream = read("src/api_query_stream.cpp")

    assert "result_rows_emitted" in header
    assert "result_bytes_emitted" in header
    assert "written_rows_total" in header
    assert "written_bytes_total" in header
    assert "self->written_rows_total_ += p.written_rows" in source
    assert "self->written_bytes_total_ += p.written_bytes" in source
    assert 'writer.Key("written_rows")' in stream
    assert 'writer.Key("written_bytes")' in stream
    assert 'writer.Key("result_rows_emitted")' in stream
    assert 'writer.Key("result_bytes_emitted")' in stream

def test_frontend_exposes_write_cards_only_when_applicable() -> None:
    index = read("src/static/index.html")
    run = read("src/static/app_run.js")

    assert 'id="writtenRowsCard" class="metricCompact is-hidden"' in index
    assert 'id="writtenBytesCard" class="metricCompact is-hidden"' in index
    assert 'writtenRowsPerSec' in run
    assert 'writtenBytesPerSec' in run
    assert 'const hasWrites =' in run
