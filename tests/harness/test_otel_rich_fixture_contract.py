"""The rich OTel dataset (tests/otel-fixture/rich_fixture.py) stays inside its day.

It is the only fixture part besides the bulk trace generators that inserts
into otel.otel_traces, and every write or delete it issues is bound to
2026-09-12 UTC, a day the bulk fixture never uses.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


RICH = read("tests/otel-fixture/rich_fixture.py")
SEED = read("tests/otel-fixture/seed.py")


def test_rich_fixture_is_bound_to_its_own_day():
    assert 'RICH_DAY = "2026-09-12"' in RICH
    assert 'RICH_PARTITION = "20260912"' in RICH
    assert "WINDOW_END_NS = WINDOW_START_NS + 24 * HOUR" in RICH
    # Inserts only: never a TRUNCATE or a DROP TABLE.
    assert "TRUNCATE" not in RICH
    assert "DROP TABLE" not in RICH
    assert "INSERT INTO otel.otel_traces FORMAT JSONEachRow" in RICH
    assert "INSERT INTO otel.otel_traces_trace_id_ts FORMAT JSONEachRow" in RICH
    # The only deletions: the rich day's partition, and the index rows whose
    # Start lies in that day; refused when the day holds other services.
    clear = RICH.split("def clear_window(", 1)[1].split("\ndef ", 1)[0]
    assert "DROP PARTITION '{RICH_DAY}'" in clear
    assert "ALTER TABLE otel.otel_traces_trace_id_ts DELETE WHERE {window_literal('Start')}" in clear
    assert "foreign_rows(" in clear and "refusing to clear the rich window" in clear
    assert RICH.count("DROP PARTITION") == 1 and RICH.count(" DELETE WHERE") == 1
    # Only an explicit OTEL_FIXTURE_RICH_FORCE=1 clears anything.
    populate = RICH.split("def populate(", 1)[1]
    assert 'if cfg["force"]:\n        clear_window(' in populate
    assert '"force": _env_flag("OTEL_FIXTURE_RICH_FORCE")' in RICH
    # Metrics derived from the stored spans read the rich day only.
    for name in ("def histogram_sql(", "def calls_sql("):
        body = RICH.split(name, 1)[1].split("\ndef ", 1)[0]
        assert "FROM otel.otel_traces" in body and "WHERE {window_literal('Timestamp')}" in body


def test_rich_fixture_is_seeded_and_idempotent():
    assert 'random.Random(f"{seed}:plan")' in RICH
    assert 'random.Random(f"{seed}:trace:{plan.no}")' in RICH
    assert "def trace_id_of(seed: int, no: int)" in RICH and "def producer_span_of(seed: int, no: int)" in RICH
    # Completion: a marker in the table comment plus rows in the rich day; a
    # partial load is left untouched unless forced.
    assert 'MARKER = "chdash-rich-fixture"' in RICH
    assert "def set_marker(" in RICH and "MODIFY COMMENT" in RICH
    assert '"""empty | complete | stale (another marker) | partial."""' in RICH
    assert 'if states["traces"] in ("stale", "partial"):\n        return' in RICH
    # Index rows follow the exporter's view: End is a span start, never an end.
    index = RICH.split("def index_rows(", 1)[1].split("\ndef ", 1)[0]
    assert '"End": dt64(hi)' in index and "lo_hi[1] = max(lo_hi[1], s.start)" in index


def test_seed_runs_the_rich_part_and_keeps_it_out_of_the_bulk_counts():
    compose = read("tests/docker-compose.yml")
    dockerfile = read("tests/otel-fixture/Dockerfile")
    assert 'OTEL_FIXTURE_RICH: "${OTEL_FIXTURE_RICH:-1}"' in compose
    assert 'OTEL_FIXTURE_RICH_FORCE: "${OTEL_FIXTURE_RICH_FORCE:-0}"' in compose
    assert "COPY tests/otel-fixture/rich_fixture.py /fixture/rich_fixture.py" in dockerfile
    assert 'RICH = _env_flag("OTEL_FIXTURE_RICH")' in SEED
    main = SEED.split("def main()", 1)[1]
    assert main.count("populate_rich()") == 2
    counts = SEED.split("def existing_fixture_counts()", 1)[1].split("PROJECTION_INDEXES", 1)[0]
    assert "rich_fixture.window_counts(connection())" in counts
    index = SEED.split("def populate_trace_index_from_spans()", 1)[1].split("\ndef ", 1)[0]
    assert "WHERE NOT ({rich_fixture.window_literal('Timestamp')})" in index
    readme = read("tests/README.md")
    assert "OTEL_FIXTURE_RICH" in readme and "2026-09-12" in readme
    assert "test_rich_fixture.py" in read("tests/test-suite/run-all-tests.py")
