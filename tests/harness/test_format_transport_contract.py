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
    # formatQuery and EXPLAIN AST (the check of the meaning) share the one retry.
    assert "FormatQueryResult second = run_text_query_once" in source
    assert "explain_ast_with_client" in source
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
    assert "cache_->put(key, work.text, std::move(value))" in service
    assert "canonical_key" not in service and "canonical_key" not in source
    cache = read("src/format_cache.cpp")
    assert "if (it->second.input != input) return {};" in cache


def test_the_layout_of_a_text_with_comments_is_checked_against_its_meaning() -> None:
    # ARCH-B-120: the local layout is compared with the text as written by the tree of ClickHouse (EXPLAIN AST), not by formatQuery, which
    # prints the parentheses that the text has. A layout that reads as another statement is not returned.
    service = read("src/format_service.cpp")
    assert "port_.explain_ast(" in service
    assert "format_meaning_changed" in service
    assert "if (local_layout) outcome.warning = check_meaning(work.head, pretty);" in service
    # A text that has a warning is not kept in the cache.
    assert "It is not kept in the cache" in service
    api_source = read("src/api_format.cpp")
    assert 'w.Key("warning");' in api_source
    transport = read("src/format_clickhouse.cpp")
    assert '"EXPLAIN AST " + sql' in transport


def test_an_error_of_clickhouse_is_placed_in_the_text_of_the_user() -> None:
    # ARCH-B-125: the position of ClickHouse counts in the text that it was sent; the service counts it back into the text of the user.
    service = read("src/format_service.cpp")
    assert "offset_in_user_text(" in service and "rebase_error_position(" in service
    api_source = read("src/api_format.cpp")
    assert "parse_clickhouse_error_location(outcome.error, sql)" in api_source
    assert "parse_clickhouse_error_location(item.outcome.error, texts[i])" in api_source
    # The limit of the server, read by its health check, bounds the text.
    health = read("src/health_runner.cpp")
    assert "getSetting('max_query_size')" in health
    assert "settings.clickhouse_max_query_size = formatter.max_query_size;" in api_source
