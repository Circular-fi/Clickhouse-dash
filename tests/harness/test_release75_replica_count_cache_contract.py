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
    fixtures = read("tests/clickhouse-cluster/04-replicated-fixtures.sql")
    assert "ENGINE = ReplicatedMergeTree(" in fixtures and "insert_quorum = 2" in fixtures
    assert 'Path("/repo/tests/clickhouse-cluster") / "04-replicated-fixtures.sql"' in read("tests/test-suite/run-all-tests.py")
    assert '("clickhouse-cluster", "04-replicated-fixtures.sql")' in read("tests/backend-functional/conftest.py")


def test_replicated_fixtures_run_once_both_replicas_reach_keeper() -> None:
    # The primary's init server listens on 127.0.0.1 only (Keeper included) and
    # the replica starts after it: ON CLUSTER DDL cannot run there (CI, fresh
    # volumes). The replica's init applies the fixtures through the primary.
    assert not (ROOT / "tests/clickhouse-init/04-replicated-fixtures.sql").exists()
    assert not [p.name for p in (ROOT / "tests/clickhouse-init").iterdir() if "ON CLUSTER" in p.read_text(encoding="utf-8")]
    compose = read("tests/docker-compose.yml")
    replica = compose.split("  clickhouse_replica:\n", 1)[1].split("\n  otel_fixture:\n", 1)[0]
    assert "source: ./clickhouse-cluster/04-replicated-fixtures.sh\n        target: /docker-entrypoint-initdb.d/04-replicated-fixtures.sh" in replica
    assert "source: ./clickhouse-cluster/04-replicated-fixtures.sql\n        target: /chdash-fixtures/04-replicated-fixtures.sql" in replica
    # Healthy means reachable from the other containers, not from loopback only.
    assert '--host \\"$$(hostname)\\" --port 9000' in compose
    assert "--host 127.0.0.1 --port 9000" not in compose
    script = read("tests/clickhouse-cluster/04-replicated-fixtures.sh")
    assert (ROOT / "tests/clickhouse-cluster/04-replicated-fixtures.sh").stat().st_mode & 0o111
    assert "SELECT count() FROM system.zookeeper WHERE path = '/'" in script
    assert "deadline=$((SECONDS + timeout_seconds))" in script
    assert 'clickhouse-client --host clickhouse "${auth[@]}" --queries-file "$sql"' in script
