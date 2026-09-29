from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_bulk_replication_metadata_avoids_keeper_on_every_build() -> None:
    catalog = read("src/explorer_catalog.cpp")
    load = catalog[catalog.index("bool load_replication("):catalog.index("bool load_database_summaries(")]
    bulk = load[:load.index("ReplicaCountCache::instance().get(")]
    # The per-build query only reads in-memory columns.
    assert "total_replicas" not in bulk and "active_replicas" not in bulk
    assert "toString(queue_size), toString(absolute_delay), toString(is_readonly)" in bulk
    cache = catalog[catalog.index("class ReplicaCountCache"):catalog.index("bool load_replication(")]
    assert "kReplicaCountTtl = std::chrono::seconds(60)" in cache
    assert '"FROM system.replicas WHERE database IN " + in_list(stale_databases) + " AND `table` IN " + in_list(stale_tables)' in cache


def test_compose_runs_a_second_replica_with_embedded_keeper() -> None:
    compose = read("tests/docker-compose.yml")
    assert "  clickhouse_replica:\n" in compose
    assert "./clickhouse-config/keeper.xml" in compose
    assert "./clickhouse-config/node-r2.xml" in compose
    assert "<chdash_cluster>" in read("tests/clickhouse-config/replication.xml")
    fixtures = read("tests/clickhouse-init/04-replicated-fixtures.sql")
    assert "ENGINE = ReplicatedMergeTree(" in fixtures and "insert_quorum = 2" in fixtures
    assert '"04-replicated-fixtures.sql"' in read("tests/test-suite/run-all-tests.py")
    assert '"04-replicated-fixtures.sql"' in read("tests/backend-functional/conftest.py")
