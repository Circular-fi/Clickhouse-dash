"""Explorer table card metadata: Columns tab, About panel, lineage chips, replication.

/api/explorer/table carries everything the card renders, through the same
runner-ACL + system-enrichment flow as the rest of the detail payload.
"""
from __future__ import annotations

import os

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def detail(database: str, table: str) -> dict:
    response = SESSION.get(
        f"{BASE_URL}/api/explorer/table",
        params={"host_id": "local", "database": database, "table": table, "refresh": "1"},
        timeout=20,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_columns_carry_comment_key_membership_and_defaults() -> None:
    payload = detail("chdash_ui", "weather_observations")
    columns = {column["name"]: column for column in payload["columns"] if not column.get("is_subcolumn")}
    for column in columns.values():
        for key in ("comment", "is_in_partition_key", "is_in_sorting_key", "is_in_primary_key", "is_in_sampling_key", "default_kind", "default_expression", "codec"):
            assert key in column, (key, column)
    # PARTITION BY toYYYYMM(observation_date) ORDER BY (observation_date, station_id, observed_at, id)
    assert columns["observation_date"]["is_in_partition_key"] is True
    assert columns["observation_date"]["is_in_sorting_key"] is True
    assert columns["observation_date"]["default_kind"] == "MATERIALIZED"
    assert "toDate(observed_at)" in columns["observation_date"]["default_expression"]
    for name in ("observed_at", "station_id", "id"):
        assert columns[name]["is_in_sorting_key"] is True, name
        assert columns[name]["is_in_primary_key"] is True, name
        assert columns[name]["is_in_partition_key"] is False, name
    assert columns["city"]["is_in_sorting_key"] is False
    assert columns["temperature_c"]["comment"] == "Air temperature in degrees Celsius"
    assert columns["notes"]["comment"].startswith("Free-text observer remark")
    assert columns["city"]["comment"] == ""
    # Compressed bytes per column stay available for the Columns tab bars.
    assert all(column.get("compressed_bytes") is not None for column in columns.values())


def test_table_ttl_is_the_top_level_clause_without_column_ttls() -> None:
    payload = detail("chdash_ui", "weather_observations")
    ttl = payload["table_ttl"]
    assert ttl.startswith("observed_at + "), ttl
    assert "RECOMPRESS" in ttl and "TO VOLUME 'warm'" in ttl, ttl
    assert "SETTINGS" not in ttl and "storage_policy" not in ttl, ttl
    summary = payload["summary"]
    assert summary["sorting_key"] == "observation_date, station_id, observed_at, id"
    assert summary["partition_key"] == "toYYYYMM(observation_date)"
    assert summary["storage_policy"] == "fixture_tiered"
    assert summary["metadata_modification_time"]
    # A table without TTL reports an empty clause.
    assert detail("chdash_ui", "wide_types")["table_ttl"] == ""


def test_dependencies_name_their_kind_and_engine() -> None:
    deps = detail("chdash_ui", "weather_observations")["dependencies"]
    by_name = {(dep["relation"], dep["table"]): dep for dep in deps}
    assert by_name[("upstream", "weather_buffer")]["kind"] == "buffer"
    assert by_name[("upstream", "weather_buffer")]["engine"] == "Buffer"
    assert by_name[("downstream", "weather_daily_summary_mv")]["kind"] == "materialized_view"
    assert by_name[("downstream", "weather_daily_summary_mv")]["engine"] == "MaterializedView"
    assert by_name[("downstream", "valid_weather_observations")]["kind"] == "view"
    assert by_name[("downstream", "valid_weather_observations")]["engine"] == "View"
    mv = detail("chdash_ui", "weather_daily_summary_mv")["dependencies"]
    target = next(dep for dep in mv if dep["relation"] == "downstream" and dep["table"] == "weather_daily_summary")
    assert target["kind"] == "materialized_view"
    assert target["engine"] == "AggregatingMergeTree"


def test_distributed_detail_names_its_cluster_and_local_table() -> None:
    payload = detail("chdash_repl", "replicated_events_all")
    assert payload["distributed"] == {"cluster": "chdash_cluster", "database": "chdash_repl", "table": "replicated_events"}
    route = [dep for dep in payload["dependencies"] if dep["kind"] == "distributed_route"]
    assert route == [{
        "database": "chdash_repl", "table": "replicated_events", "relation": "downstream",
        "kind": "distributed_route", "engine": "ReplicatedMergeTree",
    }]
    assert len(payload["topology"]) == 2
    # Non-Distributed objects carry no distributed block.
    assert "distributed" not in detail("chdash_repl", "replicated_events")


def test_replicated_detail_lists_every_replica_and_queue_split() -> None:
    replication = detail("chdash_repl", "replicated_events")["summary"]["replication"]
    assert replication["available"] is True
    assert replication["total_replicas"] == 2
    assert replication["active_replicas"] == 2
    assert replication["replicas"] == [{"name": "r1", "active": True}, {"name": "r2", "active": True}]
    for key in ("is_leader", "inserts_in_queue", "merges_in_queue", "log_lag", "last_queue_update"):
        assert key in replication, key
    assert replication["inserts_in_queue"] + replication["merges_in_queue"] <= replication["queue_size"]
    # A non-replicated table keeps an empty replica list.
    plain = detail("chdash_ui", "weather_observations")["summary"]["replication"]
    assert plain["available"] is False
    assert plain["replicas"] == []


def test_lazy_catalog_marks_replicated_tables_with_their_local_health() -> None:
    response = SESSION.get(
        f"{BASE_URL}/api/explorer/catalog",
        params={"host_id": "local", "database": "chdash_repl", "refresh": "1"},
        timeout=20,
    )
    assert response.status_code == 200, response.text
    tables = {table["name"]: table for table in response.json()["tables"]}
    assert tables["replicated_events"]["replicated"] is True
    assert tables["replicated_events"]["health"] == "healthy"
    assert tables["replicated_daily"]["replicated"] is True
    # Distributed / MV objects have no replica state of their own.
    assert "replicated" not in tables["replicated_events_all"]
    assert "health" not in tables["replicated_daily_mv"]
