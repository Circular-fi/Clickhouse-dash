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

    assert "client_pool_->invalidate(client);" in api_source
    assert "void invalidate(" in pool_header
    assert "invalidated_.erase(client)" in pool_source


def test_transport_failures_are_not_reported_as_sql_validation_errors() -> None:
    source = read("src/api_format.cpp")
    assert '"clickhouse_transport_error"' in source
    assert "is_format_transport_failure(kind) ? 502 : 422" in source
    assert '"X-Chdash-Format-Reconnect"' in source
