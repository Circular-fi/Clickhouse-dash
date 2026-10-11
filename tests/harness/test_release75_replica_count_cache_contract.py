from pathlib import Path
from explorer_sources import read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_bulk_replication_metadata_avoids_keeper_on_every_build() -> None:
    catalog = read_unit("explorer_catalog.cpp")
    statements = read_unit("explorer_sql.cpp")
    load = catalog[catalog.index("bool load_replication("):catalog.index("bool load_database_summaries(")]
    bulk = load[:load.index("load_cached_replica_counts(system, caches, replicated")]
    # The per-build statement only reads in-memory columns.
    assert "replicas_sql()" in bulk
    bulk_sql = statements[statements.index("SqlStatement replicas_sql()"):statements.index("SqlStatement replica_counts_sql(")]
    assert "total_replicas" not in bulk_sql and "active_replicas" not in bulk_sql
    assert "toString(queue_size), toString(absolute_delay), toString(is_readonly)" in bulk_sql
    # The counts (one Keeper read for each table) are cached per server (explorer_replicas.cpp) and asked for in a statement of their own.
    replicas = read_unit("explorer_replicas.cpp")
    cache = replicas[replicas.index("class ReplicaCountCache"):replicas.index("load_cached_replica_counts(\n")]
    assert "kReplicaCountTtl = std::chrono::seconds(60)" in cache
    assert "replica_counts_sql(" in cache
    counts_sql = statements[statements.index("SqlStatement replica_counts_sql("):statements.index("SqlStatement disks_with_host_sql()")]
    assert '"FROM system.replicas WHERE database IN (" + database_list + ") AND `table` IN (" + table_list + ")"' in counts_sql
    assert "out.params.texts(databases)" in counts_sql and "out.params.texts(tables)" in counts_sql


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
