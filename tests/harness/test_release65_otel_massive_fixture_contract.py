from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = (ROOT / "tests/otel-fixture/seed.py").read_text(encoding="utf-8")
COMPOSE = (ROOT / "tests/docker-compose.yml").read_text(encoding="utf-8")
README = (ROOT / "tests/README.md").read_text(encoding="utf-8")


def test_massive_fixture_has_server_side_sql_generator():
    assert 'OTEL_FIXTURE_GENERATOR' in SEED
    assert 'numbers_mt(' in SEED
    assert 'INSERT INTO otel.otel_traces' in SEED
    assert 'INSERT INTO otel.otel_traces_trace_id_ts' in SEED
    assert 'SQL_CHUNK_TRACES' in SEED
    assert 'bulk_trace_insert_sql' in SEED
    assert 'SQL_TARGET_SPANS_PER_CHUNK' in SEED


def test_massive_fixture_does_not_scan_all_traces_on_rebuild():
    assert 'FROM system.parts' in SEED
    fixture_present = SEED.split('def existing_fixture_counts()', 1)[1].split('PROJECTION_INDEXES', 1)[0]
    assert 'SELECT uniqExact(TraceId)' not in fixture_present


def test_sql_generator_builds_trace_index_without_post_group_by():
    sql_path = SEED.split('def _sql_worker(', 1)[1].split('def mark_ready_and_maybe_wait()', 1)[0]
    assert 'bulk_trace_index_insert_sql' in sql_path
    assert 'GROUP BY TraceId' not in sql_path


def test_compose_exposes_massive_fixture_knobs_and_long_health_window():
    for name in (
        'OTEL_FIXTURE_GENERATOR',
        'OTEL_FIXTURE_SQL_THRESHOLD',
        'OTEL_FIXTURE_SQL_CHUNK_TRACES',
        'OTEL_FIXTURE_SQL_TARGET_SPANS_PER_CHUNK',
        'OTEL_FIXTURE_SQL_PROCESSES',
        'OTEL_FIXTURE_INSERT_TIMEOUT_SECONDS',
    ):
        assert name in COMPOSE
    assert 'retries: 3600' in COMPOSE


def test_readme_documents_150m_span_load_test():
    assert 'OTEL_FIXTURE_TRACES=2000000' in README
    assert 'OTEL_FIXTURE_SPREAD_MINUTES=1440' in README
    assert 'OTEL_FIXTURE_TRACES=50000000' in README
    assert 'OTEL_FIXTURE_MIN_SPANS=1' in README
    assert 'numbers_mt()' in README
    assert '~150 million spans' in README


def test_massive_fixture_only_resumes_partial_data_when_single_process_is_safe():
    assert 'existing_fixture_counts()' in SEED
    assert 'existing_traces < TRACE_COUNT' in SEED
    assert 'partial parallel OTEL fixture cannot be resumed safely' in SEED
    assert 'SQL_PROCESSES > 1' in SEED
    assert 'growing existing fixture' in SEED
    assert 'start_offset=existing_traces' in SEED
    assert 'TRACE_COUNT - existing_traces' in SEED


def test_sql_generator_is_single_optimized_rich_path():
    assert 'OTEL_FIXTURE_SQL_PROFILE' not in SEED
    assert 'bulk_single_span_insert_sql' not in SEED
    assert 'bulk_optimized_rich_trace_insert_sql' not in SEED
    assert 'def bulk_trace_insert_sql' in SEED
    optimized = SEED.split('def bulk_trace_insert_sql', 1)[1].split('def bulk_trace_index_insert_sql', 1)[0]
    assert 'numbers_mt(' in optimized
    assert 'ARRAY JOIN range' not in optimized
    assert 'cityHash64(' not in optimized


def test_sql_generator_uses_independent_process_workers():
    assert 'OTEL_FIXTURE_SQL_PROCESSES' in SEED
    assert 'ProcessPoolExecutor' in SEED
    assert 'def _sql_worker' in SEED
    worker = SEED.split('def _sql_worker', 1)[1].split('def _split_ranges', 1)[0]
    assert 'while offset < end_offset' in worker
    assert 'bulk_trace_insert_sql' in worker
    assert 'bulk_trace_index_insert_sql' in worker
    assert 'OTEL_FIXTURE_SQL_PROCESSES' in COMPOSE
    assert 'OTEL_FIXTURE_SQL_PROCESSES=4' in README
