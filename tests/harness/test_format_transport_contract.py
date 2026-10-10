from __future__ import annotations

import os
from pathlib import Path


ROOT = Path(
    os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])
).resolve()


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_format_query_reconnects_once_after_native_transport_failure() -> None:
    source = read("src/format_clickhouse.cpp")
    assert "catch (const std::system_error& e)" in source
    assert "client.ResetConnection();" in source
    assert "FormatQueryResult second = format_query_once" in source
    assert "formatQuery retry failed after reconnect" in source


def test_broken_format_connections_are_not_returned_to_the_pool() -> None:
    api_source = read("src/api_format.cpp")
    pool_header = read("src/ch_client_pool.hpp")
    pool_source = read("src/ch_client_pool.cpp")

    assert "pool_->invalidate(client);" in api_source
    assert "void invalidate(" in pool_header
    # A marked connection (ch_mark_dirty, or a statement that did not end) is closed, never lent again.
    assert "if (client) ch_mark_dirty(*client);" in pool_source
    assert "const bool dirty = ch_connection_dirty(*client);" in pool_source
    assert "if (stopping_ || dirty || max_idle_per_key_ == 0) {" in pool_source


def test_transport_failures_are_not_reported_as_sql_validation_errors() -> None:
    source = read("src/api_format.cpp")
    assert '"clickhouse_transport_error"' in source
    assert "if (is_format_transport_failure(kind)) return 502;" in source
    assert "return 422;" in source
    assert '"X-Chdash-Format-Reconnect"' in source
    # The cache key is a digest of the text and of the ClickHouse version of the host; a hit compares the text, and
    # the formatted output is never stored as a key of its own (it would hide a layout that is not idempotent).
    service = read("src/format_service.cpp")
    assert "format_cache_key(settings_.cache_scope, settings_.line_width, sql)" in service
    assert "cache_->get(key, sql)" in service
    assert "cache_->put(key, input, value)" in service
    assert "canonical_key" not in service and "canonical_key" not in source
    cache = read("src/format_cache.cpp")
    assert "if (it->second.input != input) return {};" in cache
