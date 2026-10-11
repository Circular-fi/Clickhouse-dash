"""The caches of a source (schema, kind tables, detection answers) belong to the Server, not to a function-local static."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_no_source_file_keeps_a_function_local_ttl_cache():
    local = re.compile(r"\bstatic\s+(?:\w+::)*(?:TtlCache<|\w+Cache\s+\w+\s*[({])")
    offenders = [path.name for path in sorted((ROOT / "src").glob("*.cpp")) if local.search(path.read_text(encoding="utf-8"))]
    assert offenders == []


def test_the_server_owns_the_caches_of_the_otel_routes():
    server = read("src/server.hpp")
    caches = read("src/otel_caches.hpp")
    for member, factory in (
        ("signal_meta_cache_", "signal_meta_cache_options"),
        ("logs_schema_cache_", "logs_schema_cache_options"),
        ("log_columns_cache_", "log_columns_cache_options"),
        ("kind_tables_cache_", "kind_tables_cache_options"),
    ):
        assert f"{member}{{{factory}()}}" in server, member
        assert f"inline " in caches and factory in caches, factory
    assert "signal_meta_cache_.get(" in read("src/api_otel_signals.cpp")
    assert "logs::LogsCaches{logs_schema_cache_, log_facet_keys_cache_, log_facet_values_cache_}" in server
    # The Metrics service takes the kind tables and the catalog as caches of the server.
    assert "metrics::MetricsCaches{metrics_catalog_cache_, kind_tables_cache_}" in server
    assert "log_columns_cache_" in read("src/api_trace_logs.cpp")
