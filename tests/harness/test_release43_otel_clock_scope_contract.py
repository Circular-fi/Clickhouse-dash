from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CPP = (ROOT / 'src/query_analysis.cpp').read_text()
HPP = (ROOT / 'src/query_analysis.hpp').read_text()


def test_query_log_exposes_clickhouse_microsecond_clock_for_trace_window():
    assert 'uint64_t event_time_us = 0;' in HPP
    assert 'toUInt64(toUnixTimestamp64Micro(event_time_microseconds))' in CPP
    assert 'value.event_time_us = block_u64(block, 5, row);' in CPP


def test_otel_window_is_derived_from_clickhouse_query_log_not_only_app_wall_clock():
    assert 'clickhouse_query_bounds_us' in CPP
    assert 'row.event_time_us' in CPP
    assert 'row.duration_ms * 1000ULL' in CPP
    assert 'const auto [trace_lo_us, trace_hi_us] = clickhouse_query_bounds_us(record, result.query_log);' in CPP
    assert 'otel_log_prewhere(trace_lo_us, trace_hi_us)' in CPP


def test_otel_still_prunes_by_order_by_time_prefix():
    assert 'finish_date BETWEEN' in CPP
    assert 'finish_time_us BETWEEN' in CPP
    assert 'fromUnixTimestamp64Micro' not in CPP
    assert 'system.opentelemetry_span_log PREWHERE " + time_scope' in CPP
