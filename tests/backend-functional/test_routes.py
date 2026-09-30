from __future__ import annotations

import re

import csv
import io
import json
import os
import time
import zipfile
from urllib.parse import urljoin

import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 15), **kwargs)


def post(path: str, **kwargs):
    return SESSION.post(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 15), **kwargs)


def parse_sse(response: requests.Response, stop_events: set[str] | None = None) -> list[dict]:
    events: list[dict] = []
    stop_events = stop_events or {"done", "error"}
    name = "message"
    data: list[str] = []
    for raw in response.iter_lines(decode_unicode=True):
        line = raw or ""
        if not line:
            if data or name != "message":
                raw_data = "\n".join(data)
                payload = json.loads(raw_data) if raw_data else None
                events.append({"event": name, "data": payload})
                if name in stop_events:
                    break
            name, data = "message", []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    return events


def run_sql(sql: str, *, alias: bool = False, mode: str = "normal") -> tuple[dict, list[dict]]:
    route = "/api/query" if alias else "/api/query/run"
    r = post(route, json={"host_id": "local", "sql": sql, "mode": mode})
    assert r.status_code == 200, r.text
    handshake = r.json()
    assert handshake["query_id"]
    assert handshake["stream_url"]
    stream_url = urljoin(BASE_URL + "/", handshake["stream_url"])
    with SESSION.get(stream_url, stream=True, timeout=(10, 120), headers={"Accept": "text/event-stream"}) as stream:
        assert stream.status_code == 200, stream.text
        assert stream.headers.get("Content-Type", "").split(";", 1)[0] == "text/event-stream"
        events = parse_sse(stream)
    assert any(e["event"] == "done" and (e["data"] or {}).get("status") == "finished" for e in events), events
    return handshake, events


def retry_json(method: str, path: str, *, attempts: int = 8, **kwargs):
    last = None
    for _ in range(attempts):
        response = SESSION.request(method, f"{BASE_URL}{path}", timeout=20, **kwargs)
        last = response
        if response.status_code == 200:
            return response.json()
        if response.status_code not in {409, 503}:
            break
        time.sleep(0.25)
    assert last is not None
    pytest.fail(f"{method} {path} failed: {last.status_code} {last.text}")



def decode_analysis_envelope(response: requests.Response) -> dict:
    # Analysis is ordinary JSON; the trace itself is compact positional JSON.
    return response.json()


def retry_analysis(path: str, *, attempts: int = 8, **kwargs):
    last = None
    for _ in range(attempts):
        response = SESSION.post(f"{BASE_URL}{path}", timeout=20, **kwargs)
        last = response
        if response.status_code == 200:
            return decode_analysis_envelope(response)
        if response.status_code not in {409, 503}:
            break
        time.sleep(0.25)
    assert last is not None
    pytest.fail(f"POST {path} failed: {last.status_code} {last.text}")

def test_core_routes_are_live_and_json_contracts_are_valid():
    for route in ["/", "/query", "/explorer"]:
        root = get(route)
        assert root.status_code == 200
        assert "text/html" in root.headers.get("Content-Type", "")

    healthz = get("/healthz")
    assert healthz.status_code == 200

    version = get("/api/version")
    assert version.status_code == 200
    assert version.json().get("name") == "clickhouse-dash"

    hosts = get("/api/hosts")
    assert hosts.status_code == 200
    host_rows = hosts.json().get("hosts")
    assert isinstance(host_rows, list) and any(row.get("id") == "local" for row in host_rows)

    health = get("/api/health")
    assert health.status_code == 200
    assert health.json().get("ok") is True

    meta = get("/api/meta", params={"host_id": "local", "types": "keywords,functions"})
    assert meta.status_code == 200, meta.text
    assert meta.json().get("host_id") == "local"


def test_otel_projection_indexes_are_present():
    run_sql(
        """
SELECT throwIf(
    count() != 2,
    'expected exactly 2 OTEL projection indexes (prj_traceid, prj_start)'
)
FROM system.projections
WHERE database = 'otel'
  AND (
      (table = 'otel_traces' AND name = 'prj_traceid')
      OR (table = 'otel_traces_trace_id_ts' AND name = 'prj_start')
  )
"""
    )


def test_hosts_stream_emits_hosts_event():
    with SESSION.get(f"{BASE_URL}/api/hosts/stream", stream=True, timeout=(10, 10)) as response:
        assert response.status_code == 200
        assert response.headers.get("Content-Type", "").split(";", 1)[0] == "text/event-stream"
        events = parse_sse(response, {"hosts"})
    assert events and events[0]["event"] == "hosts"


def test_query_run_alias_stream_analysis_execution_and_deep_analysis():
    handshake, events = run_sql("SELECT sum(number) AS total FROM numbers(10000)", alias=True, mode="profiling")
    assert handshake["run_mode"] == "profiling"
    assert handshake["analysis_available"] is True
    assert any(e["event"] == "result_rows" for e in events)
    qid = handshake["query_id"]

    analysis = retry_analysis("/api/query/analysis", json={"host_id": "local", "query_id": qid})
    assert analysis["query_id"] == qid
    assert analysis["terminal_status"] == "finished"
    assert isinstance(analysis.get("session_elapsed_ms"), int)
    assert analysis.get("availability", {}).get("processors_profile_log") is True, analysis
    assert analysis.get("processor_profiling_recorded") is True, analysis
    # The default analysis payload is compact; raw processor rows are only
    # emitted in the debug section (release49 processor compact contract).
    assert analysis.get("processors_compact"), analysis
    compact = analysis.get("trace_compact", {})
    assert compact.get("format") == "chdash.trace.json.lod.v2", analysis
    assert compact.get("timeline_px") == 3840, analysis
    assert isinstance(compact.get("nodes"), list), analysis

    execution = retry_json("GET", "/api/query/execution", params={"host_id": "local", "query_id": qid})
    assert execution["query_id"] == qid
    assert execution["terminal_status"] == "finished"

    deep = retry_json("POST", "/api/query/deep-analysis", json={"host_id": "local", "query_id": qid})
    assert deep.get("query_id") == qid



def test_normal_query_cannot_be_analyzed_or_deep_analyzed():
    handshake, _ = run_sql("SELECT 7 AS normal_mode_probe")
    assert handshake["run_mode"] == "normal"
    assert handshake["analysis_available"] is False
    qid = handshake["query_id"]

    for path in ["/api/query/analysis", "/api/query/deep-analysis"]:
        response = post(path, json={"host_id": "local", "query_id": qid})
        assert response.status_code == 409, (path, response.text)
        payload = response.json()
        assert payload.get("error_code") == "analysis_not_enabled"


def test_cancel_route_rejects_invalid_capability_without_touching_other_queries():
    response = post("/api/query/cancel", json={"cancel_token": "not-a-valid-token"})
    assert response.status_code in {400, 401, 403, 404}
    payload = response.json()
    assert isinstance(payload.get("error_code"), str)



def test_nested_explorer_routes_serve_the_same_application_shell():
    for path in [
        "/explorer/chdash_ui",
        "/explorer/chdash_ui/weather_observations/overview",
        "/explorer/chdash_ui/weather_observations/schema",
        "/explorer/chdash_ui/weather_observations/data",
        "/explorer/chdash_ui/weather_observations/lineage",
        "/explorer/chdash_ui/weather_observations/storage",
        "/explorer/chdash_ui/weather_observations/operations",
        "/explorer/functions",
        "/explorer/functions/arrayMap",
        "/explorer/databases",
    ]:
        response = get(path)
        assert response.status_code == 200, (path, response.text[:500])
        assert "text/html" in response.headers.get("Content-Type", ""), (path, response.headers)
        assert 'id="explorerWorkspace"' in response.text, path


def test_explorer_routes_cover_catalog_table_data_graph_activity_and_functions():
    catalog = get("/api/explorer/catalog", params={"host_id": "local", "database": "chdash_ui"})
    assert catalog.status_code == 200, catalog.text
    catalog_payload = catalog.json()
    fixture_tables = {
        row.get("name"): row
        for row in catalog_payload.get("tables", [])
        if row.get("database") == "chdash_ui"
    }
    for expected in ["weather_observations", "valid_weather_observations", "mild_weather_observations", "weather_observation_quality_join", "weather_daily_summary_mv", "weather_daily_summary", "wide_types", "memory_weather", "weather_buffer", "weather_city_ingest_target", "station_dictionary_source"]:
        assert expected in fixture_tables, (expected, fixture_tables.keys())
    assert fixture_tables["weather_observations"].get("engine") == "MergeTree"
    assert fixture_tables["memory_weather"].get("engine") == "Memory"
    assert fixture_tables["weather_buffer"].get("engine") == "Buffer"
    assert fixture_tables["station_dictionary_source"].get("engine") == "TinyLog"
    assert int(fixture_tables["memory_weather"].get("rows") or 0) == 3
    assert int(fixture_tables["weather_observations"].get("rows") or 0) > 0
    # The database detail object table reads the same per-database parts
    # aggregation: compressed / uncompressed data bytes, active parts and the
    # newest part time (MergeTree only; null for views and RAM engines).
    weather = fixture_tables["weather_observations"]
    assert int(weather.get("compressed_bytes") or 0) > 0, weather
    assert int(weather.get("uncompressed_bytes") or 0) >= int(weather["compressed_bytes"]), weather
    assert int(weather.get("active_parts") or 0) >= 1, weather
    assert re.match(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$", weather.get("last_part_time") or ""), weather
    assert fixture_tables["valid_weather_observations"].get("compressed_bytes") is None
    assert fixture_tables["memory_weather"].get("uncompressed_bytes") is None

    # The sidebar catalog is deliberately lightweight (names, engine, rows,
    # bytes and the parts aggregation above). Rich per-table storage metrics
    # are loaded lazily by the table detail route, so they are asserted
    # against /api/explorer/table below.
    database = next((item for item in catalog_payload.get("database_summaries", []) if item.get("name") == "chdash_ui"), None)
    if database is None:
        root = get("/api/explorer/catalog", params={"host_id": "local"})
        assert root.status_code == 200, root.text
        database = next((item for item in root.json().get("database_summaries", []) if item.get("name") == "chdash_ui"), None)
    assert database is not None, catalog_payload
    assert int(database.get("tables") or 0) >= 6, database
    assert int(database.get("rows") or 0) > 0, database
    assert int(database.get("bytes") or 0) > 0, database

    # refresh=1: the session fixture just recreated these tables, so a detail
    # cached by a concurrent client during the reset must not be served.
    table = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": "weather_observations", "refresh": "1"})
    assert table.status_code == 200, table.text
    table_payload = table.json()
    assert table_payload.get("summary", {}).get("engine") == "MergeTree"
    summary = table_payload.get("summary", {})
    # The fixture writes three active parts, but every observation_date is in
    # the same YYYYMM partition. Parts and partitions are distinct metrics.
    assert int(summary.get("partitions") or 0) == 1, summary
    assert int(summary.get("active_parts") or 0) >= 3, summary
    assert "rows_total_1h" in summary.get("client_ingress", {}), summary
    assert "bytes_total_1h" in summary.get("client_ingress", {}), summary
    assert "rows_total_1h" in summary.get("physical_ingress", {}), summary
    assert table_payload.get("storage"), table_payload
    for disk in table_payload["storage"]:
        assert isinstance(disk.get("disk"), str) and disk.get("disk"), disk
        assert disk.get("free_space") is None or int(disk["free_space"]) >= 0, disk
        assert disk.get("total_space") is None or int(disk["total_space"]) > 0, disk
    assert {column.get("name") for column in table_payload.get("columns", [])} >= {"observed_at", "id", "city", "temperature_c"}
    assert all("codec" in column for column in table_payload.get("columns", [])), table_payload
    assert table_payload.get("indexes_and_projections"), table_payload
    assert table_payload.get("parts"), table_payload
    assert table_payload.get("partitions"), table_payload
    downstream = {(item.get("database"), item.get("table")) for item in table_payload.get("dependencies", []) if item.get("relation") == "downstream"}
    upstream = {(item.get("database"), item.get("table")) for item in table_payload.get("dependencies", []) if item.get("relation") == "upstream"}
    assert ("chdash_ui", "valid_weather_observations") in downstream, table_payload
    assert ("chdash_ui", "weather_daily_summary_mv") in downstream, table_payload
    assert ("chdash_ui", "weather_buffer") in upstream, table_payload
    # Fixture TTL: 30d RECOMPRESS, 60d TO VOLUME 'warm', 365d DELETE.
    ddl = table_payload.get("ddl", "")
    assert re.search(r"TTL\s+observed_at\s+\+\s+(?:INTERVAL\s+30\s+DAY|toIntervalDay\(30\))\s+RECOMPRESS", ddl, re.I), ddl
    assert re.search(r"observed_at\s+\+\s+(?:INTERVAL\s+60\s+DAY|toIntervalDay\(60\))\s+TO\s+VOLUME\s+'warm'", ddl, re.I), ddl
    assert re.search(r"observed_at\s+\+\s+(?:INTERVAL\s+365\s+DAY|toIntervalDay\(365\))", ddl, re.I), ddl

    mv_detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": "weather_daily_summary_mv"})
    assert mv_detail.status_code == 200, mv_detail.text
    mv_dependencies = mv_detail.json().get("dependencies", [])
    mv_upstream = {(item.get("database"), item.get("table")) for item in mv_dependencies if item.get("relation") == "upstream"}
    mv_downstream = {(item.get("database"), item.get("table")) for item in mv_dependencies if item.get("relation") == "downstream"}
    assert ("chdash_ui", "weather_observations") in mv_upstream, mv_detail.text
    assert ("chdash_ui", "weather_daily_summary") in mv_downstream, mv_detail.text

    for object_name, expected_engine in [("memory_weather", "Memory"), ("weather_buffer", "Buffer"), ("station_dictionary_source", "TinyLog"), ("station_dictionary", "Dictionary")]:
        engine_detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": object_name})
        assert engine_detail.status_code == 200, (object_name, engine_detail.text)
        assert engine_detail.json().get("summary", {}).get("engine") == expected_engine, engine_detail.text

    view_detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": "valid_weather_observations"})
    assert view_detail.status_code == 200, view_detail.text
    view_dependencies = view_detail.json().get("dependencies", [])
    upstream = {(item.get("database"), item.get("table")) for item in view_dependencies if item.get("relation") == "upstream"}
    assert ("chdash_ui", "weather_observations") in upstream, view_detail.text
    assert all(str(item.get("table") or "").lower() not in {"row", "_row"} for item in view_dependencies), view_detail.text

    join_view_detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": "weather_observation_quality_join"})
    assert join_view_detail.status_code == 200, join_view_detail.text
    join_upstream = {
        (item.get("database"), item.get("table"))
        for item in join_view_detail.json().get("dependencies", [])
        if item.get("relation") == "upstream"
    }
    assert ("chdash_ui", "weather_observations") in join_upstream, join_view_detail.text
    assert ("chdash_ui", "valid_weather_observations") in join_upstream, join_view_detail.text

    wide_detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_ui", "table": "wide_types"})
    assert wide_detail.status_code == 200, wide_detail.text
    wide_payload = wide_detail.json()
    wide_columns = {column.get("name"): column for column in wide_payload.get("columns", [])}
    assert wide_columns.get("tuple_value.code", {}).get("is_subcolumn") is True, wide_payload
    assert wide_columns.get("tuple_value.name", {}).get("is_subcolumn") is True, wide_payload
    assert wide_columns["tuple_value.code"].get("parent_name") == "tuple_value", wide_payload
    structures = {item.get("name"): item for item in wide_payload.get("indexes_and_projections", [])}
    assert "idx_wide_types_state" in structures, wide_payload
    assert "prj_wide_types_state" in structures, wide_payload
    assert structures["idx_wide_types_state"].get("compressed_bytes") is not None, wide_payload
    assert structures["idx_wide_types_state"].get("uncompressed_bytes") is not None, wide_payload
    assert structures["prj_wide_types_state"].get("compressed_bytes") is not None, wide_payload
    assert structures["prj_wide_types_state"].get("uncompressed_bytes") is not None, wide_payload

    data = post("/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "weather_observations", "limit": 20})
    assert data.status_code == 200, data.text
    preview = data.json()
    preview_columns = [column.get("name") for column in preview.get("columns", [])]
    assert set(preview_columns) >= {"observed_at", "observation_date", "id", "station_id", "city", "quality_ok", "temperature_c", "notes", "tags", "metadata"}, preview
    assert preview.get("rows"), preview
    by_name = {name: index for index, name in enumerate(preview_columns)}
    for row in preview["rows"]:
        assert isinstance(row[by_name["station_id"]], str) and row[by_name["station_id"]].startswith("WX-"), row
        assert row[by_name["city"]] in {"Paris", "Reykjavik", "Lisbon"}, row
        assert isinstance(row[by_name["quality_ok"]], bool), row
        assert isinstance(row[by_name["temperature_c"]], (int, float)), row
        assert row[by_name["notes"]] is None or isinstance(row[by_name["notes"]], str), row
        assert isinstance(row[by_name["tags"]], list), row
        assert row[by_name["tags"]] and "synthetic-weather" in row[by_name["tags"]], row
        assert isinstance(row[by_name["metadata"]], dict), row
        assert row[by_name["metadata"]].get("fixture") == "weather", row

    aggregate_preview = post("/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "weather_daily_summary", "limit": 5})
    assert aggregate_preview.status_code == 200, aggregate_preview.text
    aggregate_payload = aggregate_preview.json()
    assert aggregate_payload.get("rows"), aggregate_payload
    aggregate_columns = [column.get("name") for column in aggregate_payload.get("columns", [])]
    assert {"observation_count", "average_temperature"}.issubset(set(aggregate_columns)), aggregate_payload

    wide_preview = post("/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "wide_types", "limit": 5})
    assert wide_preview.status_code == 200, wide_preview.text
    wide_preview_payload = wide_preview.json()
    assert wide_preview_payload.get("rows"), wide_preview_payload
    wide_preview_columns = [column.get("name") for column in wide_preview_payload.get("columns", [])]
    wide_by_name = {name: index for index, name in enumerate(wide_preview_columns)}
    first_wide_row = wide_preview_payload["rows"][0]
    assert isinstance(first_wide_row[wide_by_name["decimal_value"]], (int, float)), first_wide_row
    assert isinstance(first_wide_row[wide_by_name["tuple_value"]], list), first_wide_row
    assert isinstance(first_wide_row[wide_by_name["nested_array"]], list), first_wide_row
    assert isinstance(first_wide_row[wide_by_name["tags"]], dict), first_wide_row
    assert first_wide_row[wide_by_name["state"]] in {"new", "processed", "failed"}, first_wide_row

    tinylog_preview = post("/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "station_dictionary_source", "limit": 5})
    assert tinylog_preview.status_code == 200, tinylog_preview.text
    assert tinylog_preview.json().get("rows"), tinylog_preview.text

    graph = get("/api/explorer/graph", params={"host_id": "local", "database": "chdash_ui"})
    assert graph.status_code == 200, graph.text
    graph_payload = graph.json()
    dictionary_rows = [
        row for row in catalog_payload.get("tables", [])
        if row.get("database") == "chdash_ui" and row.get("name") == "station_dictionary"
    ]
    assert dictionary_rows, catalog.text
    assert dictionary_rows[0].get("engine") == "Dictionary", dictionary_rows[0]

    fixture_nodes = [node for node in graph_payload.get("nodes", []) if node.get("database") == "chdash_ui"]
    assert len(fixture_nodes) >= 6, graph_payload
    assert graph_payload.get("edges"), graph_payload
    assert any(edge.get("kind") in {"view", "materialized_view", "dependency"} for edge in graph_payload.get("edges", [])), graph_payload
    join_view_id = "table:chdash_ui.weather_observation_quality_join"
    join_sources = {
        edge.get("from")
        for edge in graph_payload.get("edges", [])
        if edge.get("to") == join_view_id and edge.get("kind") == "view"
    }
    assert "table:chdash_ui.weather_observations" in join_sources, graph_payload
    assert "table:chdash_ui.valid_weather_observations" in join_sources, graph_payload
    assert all(
        edge.get("can_animate") is False
        for edge in graph_payload.get("edges", [])
        if edge.get("to") == join_view_id and edge.get("kind") == "view"
    ), graph_payload
    weather_graph_node = next((node for node in fixture_nodes if node.get("name") == "weather_observations"), None)
    assert weather_graph_node is not None, graph_payload
    ttl_rules = weather_graph_node.get("ttl_rules") or []
    assert [rule.get("offset_label") for rule in ttl_rules[:3]] == ["+30d", "+60d", "+365d"], ttl_rules
    assert [rule.get("action") for rule in ttl_rules[:3]] == ["recompress", "move", "delete"], ttl_rules
    assert (ttl_rules[0].get("target") or "").upper() == "ZSTD(3)", ttl_rules
    assert ttl_rules[1].get("target_kind") == "volume" and ttl_rules[1].get("target") == "warm", ttl_rules
    assert not any(edge.get("kind") == "ttl_move" for edge in graph_payload.get("edges", [])), graph_payload

    # The standalone activity route was removed; ingress metrics are part of
    # the table summary asserted above.
    activity = get("/api/explorer/activity", params={"host_id": "local", "database": "chdash_ui"})
    assert activity.status_code == 404, activity.text

    functions = get("/api/explorer/functions", params={"host_id": "local"})
    assert functions.status_code == 200, functions.text
    functions_payload = functions.json()
    assert functions_payload.get("documentation_available") is True
    array_map = next(
        (item for item in functions_payload.get("functions", []) if item.get("name") == "arrayMap" and item.get("kind") == "Function"),
        None,
    )
    assert array_map is not None, functions_payload
    assert array_map.get("description"), array_map
    assert array_map.get("syntax"), array_map
    assert array_map.get("arguments"), array_map
    assert array_map.get("returned_value"), array_map
    assert array_map.get("examples"), array_map




def test_explorer_catalog_survives_runner_created_object_after_startup():
    database = "chdash_dynamic_catalog"
    table = "create_target"
    try:
        run_sql(f"CREATE DATABASE IF NOT EXISTS {database}")
        run_sql(f"DROP TABLE IF EXISTS {database}.{table}")
        run_sql(f"CREATE TABLE {database}.{table} (id UInt64, payload String) ENGINE = Memory")

        # refresh=1 intentionally refreshes the runner ACL boundary and catalog
        # together. A newly runner-readable object must never make the entire
        # Explorer fail merely because the technical metadata connection does
        # not return that row in the same system.tables snapshot.
        catalog = get(
            "/api/explorer/catalog",
            params={"host_id": "local", "database": database, "refresh": "1"},
        )
        assert catalog.status_code == 200, catalog.text
        rows = {
            item.get("name"): item
            for item in catalog.json().get("tables", [])
            if item.get("database") == database
        }
        assert table in rows, rows
        assert rows[table].get("engine") == "Memory", rows[table]

        detail = get(
            "/api/explorer/table",
            params={"host_id": "local", "database": database, "table": table},
        )
        assert detail.status_code == 200, detail.text
        assert detail.json().get("summary", {}).get("engine") == "Memory"
    finally:
        run_sql(f"DROP TABLE IF EXISTS {database}.{table}")
        run_sql(f"DROP DATABASE IF EXISTS {database}")
        # Do not leave stale dynamic ACL/catalog entries for later frontend tests.
        refreshed = get("/api/explorer/catalog", params={"host_id": "local", "refresh": "1"})
        assert refreshed.status_code == 200, refreshed.text


def _explorer_storage(refresh: bool = False) -> dict:
    params = {"host_id": "local"}
    if refresh:
        params["refresh"] = "1"
    response = get("/api/explorer/storage", params=params)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers.get("Cache-Control", ""), response.headers
    return response.json()


def test_explorer_storage_route_serves_runner_scoped_on_disk_distribution():
    # The session fixture reset (and concurrent reviewers) recreate chdash_ui;
    # wait until the recreated MergeTree parts are visible again.
    payload: dict = {}
    by_name: dict = {}
    for _ in range(20):
        payload = _explorer_storage(refresh=True)
        by_name = {item.get("name"): item for item in payload.get("databases", [])}
        tables = {row.get("name"): row for row in (by_name.get("chdash_ui") or {}).get("tables", [])}
        if int((tables.get("weather_observations") or {}).get("bytes") or 0) > 0:
            break
        time.sleep(0.5)

    assert payload.get("version") == 1, payload
    assert payload.get("metric_scope") == "local-replica", payload
    assert payload.get("byte_metric") == "bytes_on_disk", payload
    assert int(payload.get("table_limit_per_database") or 0) >= 100, payload
    assert {"chdash_ui", "otel", "system"} <= set(by_name), by_name.keys()
    assert not {"information_schema", "INFORMATION_SCHEMA"} & set(by_name), by_name.keys()
    assert by_name["system"].get("system") is True
    assert by_name["chdash_ui"].get("system") is False
    assert [item.get("name") for item in payload["databases"]] == sorted(by_name), payload["databases"]

    total = 0
    for database in payload["databases"]:
        tables = database.get("tables", [])
        sizes = [int(row.get("bytes") or 0) for row in tables]
        # Only storing tables are listed, largest first, and the database total
        # reconciles exactly with listed + bounded-out tables.
        assert all(size > 0 for size in sizes), database
        assert sizes == sorted(sizes, reverse=True), database
        assert int(database.get("bytes") or 0) == sum(sizes) + int(database.get("omitted_bytes") or 0), database
        assert int(database.get("storing_tables") or 0) == len(tables) + int(database.get("omitted_tables") or 0), database
        assert int(database.get("objects") or 0) >= int(database.get("storing_tables") or 0), database
        assert len(tables) <= int(payload["table_limit_per_database"]), database
        total += int(database.get("bytes") or 0)
    assert int(payload.get("total_bytes") or 0) == total, payload

    ui = {row.get("name"): row for row in by_name["chdash_ui"].get("tables", [])}
    weather = ui.get("weather_observations")
    assert weather is not None, ui.keys()
    assert weather.get("engine") == "MergeTree", weather
    assert int(weather.get("bytes") or 0) > 1_000_000, weather
    assert int(weather.get("rows") or 0) > 0, weather
    assert int(weather.get("parts") or 0) >= 1, weather
    # Resident-memory engines report RAM, never on-disk treemap area.
    for resident in ["memory_weather", "weather_buffer", "station_dictionary"]:
        assert resident not in ui, (resident, ui.keys())
    assert int(by_name["chdash_ui"].get("resident_bytes") or 0) > 0, by_name["chdash_ui"]
    # Views own no bytes and are therefore absent from the distribution.
    assert "valid_weather_observations" not in ui, ui.keys()

    # Metadata-only accounting of the ~2 billion row OTEL fixture.
    otel = {row.get("name"): row for row in by_name["otel"].get("tables", [])}
    assert int((otel.get("otel_traces") or {}).get("bytes") or 0) > 0, otel

    # Security boundary: every serialized name is an object the runner sees in
    # the lazy sidebar catalog of the same database.
    for database in ["chdash_ui", "otel"]:
        catalog = get("/api/explorer/catalog", params={"host_id": "local", "database": database})
        assert catalog.status_code == 200, catalog.text
        visible = {row.get("name") for row in catalog.json().get("tables", []) if row.get("database") == database}
        listed = {row.get("name") for row in by_name[database].get("tables", [])}
        assert listed <= visible, (database, listed - visible)

    cached = _explorer_storage()
    assert int(cached.get("generated_at_ms") or 0) >= int(payload.get("generated_at_ms") or 0), cached


def test_explorer_storage_route_validates_host_and_serves_the_system_section_shell():
    missing = get("/api/explorer/storage")
    assert missing.status_code == 400, missing.text
    assert missing.json().get("error_code") == "missing_host_id", missing.text
    unknown = get("/api/explorer/storage", params={"host_id": "does-not-exist"})
    assert unknown.status_code == 404, unknown.text
    for path in ["/explorer/_system", "/explorer/_system?level=tables", "/explorer/system"]:
        response = get(path)
        assert response.status_code == 200, (path, response.text[:300])
        assert 'id="explorerSystemPane"' in response.text, path


def test_explorer_storage_route_accounts_new_disk_and_memory_objects():
    database = "chdash_storage_map"
    try:
        run_sql(f"CREATE DATABASE IF NOT EXISTS {database}")
        run_sql(f"DROP TABLE IF EXISTS {database}.disk_rows")
        run_sql(f"DROP TABLE IF EXISTS {database}.ram_rows")
        run_sql(f"CREATE TABLE {database}.disk_rows (id UInt64, payload String) ENGINE = MergeTree ORDER BY id")
        run_sql(f"CREATE TABLE {database}.ram_rows (id UInt64) ENGINE = Memory")
        run_sql(f"INSERT INTO {database}.disk_rows SELECT number, repeat('x', 64) FROM numbers(5000)")
        run_sql(f"INSERT INTO {database}.ram_rows SELECT number FROM numbers(1000)")

        payload = _explorer_storage(refresh=True)
        entry = next((item for item in payload.get("databases", []) if item.get("name") == database), None)
        assert entry is not None, payload.get("databases")
        assert int(entry.get("objects") or 0) == 2, entry
        tables = {row.get("name"): row for row in entry.get("tables", [])}
        assert set(tables) == {"disk_rows"}, entry
        assert int(tables["disk_rows"].get("rows") or 0) == 5000, tables
        assert int(tables["disk_rows"].get("bytes") or 0) > 0, tables
        assert int(entry.get("bytes") or 0) == int(tables["disk_rows"]["bytes"]), entry
        assert int(entry.get("resident_bytes") or 0) > 0, entry
    finally:
        run_sql(f"DROP TABLE IF EXISTS {database}.disk_rows")
        run_sql(f"DROP TABLE IF EXISTS {database}.ram_rows")
        run_sql(f"DROP DATABASE IF EXISTS {database}")
        refreshed = get("/api/explorer/storage", params={"host_id": "local", "refresh": "1"})
        assert refreshed.status_code == 200, refreshed.text
        refreshed = get("/api/explorer/catalog", params={"host_id": "local", "refresh": "1"})
        assert refreshed.status_code == 200, refreshed.text


def test_aggregate_function_state_preview_is_bounded_and_serializable():
    preview = post("/api/explorer/table/data", json={"host_id": "local", "database": "chdash_ui", "table": "weather_daily_summary", "limit": 5})
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    columns = {column.get("name"): column for column in payload.get("columns", [])}
    assert str((columns.get("observation_count") or {}).get("type") or "").startswith("AggregateFunction(count"), payload
    assert str((columns.get("average_temperature") or {}).get("type") or "").startswith("AggregateFunction(avg"), payload
    assert (columns.get("observation_count") or {}).get("finalized_for_preview") is True, payload
    assert (columns.get("average_temperature") or {}).get("finalized_for_preview") is True, payload
    assert payload.get("rows"), payload
    by_name = {column.get("name"): index for index, column in enumerate(payload.get("columns", []))}
    for row in payload["rows"]:
        assert isinstance(row[by_name["observation_count"]], str), row
        assert isinstance(row[by_name["average_temperature"]], str), row


def test_system_text_log_explorer_preview_and_schema_are_fail_closed_without_fake_compact_sizes():
    catalog = get("/api/explorer/catalog", params={"host_id": "local", "database": "system"})
    assert catalog.status_code == 200, catalog.text
    names = {row.get("name") for row in catalog.json().get("tables", []) if row.get("database") == "system"}
    if "text_log" not in names:
        pytest.skip("system.text_log is not enabled by this ClickHouse fixture")

    preview = post("/api/explorer/table/data", json={"host_id": "local", "database": "system", "table": "text_log", "limit": 5})
    assert preview.status_code == 200, preview.text
    preview_payload = preview.json()
    assert preview_payload.get("columns"), preview_payload
    assert all(isinstance(column.get("name"), str) and column.get("name") for column in preview_payload["columns"]), preview_payload

    detail = get("/api/explorer/table", params={"host_id": "local", "database": "system", "table": "text_log"})
    assert detail.status_code == 200, detail.text
    payload = detail.json()
    assert payload.get("columns"), payload
    storage = payload.get("column_storage") or {}
    compact_parts = int(storage.get("compact_parts") or 0)
    wide_parts = int(storage.get("wide_parts") or 0)
    compressed = [column.get("compressed_bytes") for column in payload["columns"]]
    if compact_parts > 0:
        assert storage.get("compact_compressed_bytes") is not None, payload
        assert storage.get("compact_uncompressed_bytes") is not None, payload
    if compact_parts > 0 and wide_parts == 0:
        assert all(value is None for value in compressed), payload
        assert "column_sizes_compact_shared" in set(payload.get("unavailable_sections") or []), payload
    if wide_parts > 0:
        # Per-column counters describe only independently stored Wide parts.
        assert storage.get("wide_compressed_bytes") is not None, payload


def test_export_routes_produce_downloadable_zip():
    response = post("/api/export/run", json={"host_id": "local", "format": "json", "queries": ["SELECT 42 AS answer"]})
    assert response.status_code == 200, response.text
    payload = response.json()
    download = urljoin(BASE_URL + "/", payload["download_url"])
    archive = SESSION.get(download, timeout=60)
    assert archive.status_code == 200, archive.text
    assert zipfile.is_zipfile(io.BytesIO(archive.content))
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        assert set(zf.namelist()) == {"query.sql", "results.json", "execution.csv"}
        execution = list(csv.DictReader(io.StringIO(zf.read("execution.csv").decode("utf-8"))))
        assert len(execution) == 1, execution
        assert execution[0]["status"] == "finished", execution[0]
        assert execution[0]["collector_error"] == "", execution[0]
        assert execution[0]["logs_pending"] == "false", execution[0]


TYPED_EXPORT_SQL = (
    "SELECT toDecimal32(1.25, 2) AS d32, toDecimal64(-3.5, 6) AS d64, toDecimal128(7.125, 3) AS d128, "
    "toDate32('1960-01-02') AS date32, toDateTime64(-0.5, 1, 'UTC') AS pre_epoch, "
    "toFloat64(0.1) AS tenth"
)


def test_csv_export_serializes_narrow_decimals_date32_and_shortest_floats():
    # Decimal32/64 are stored in 4/8 bytes; reading them as Int128 used to
    # abort the whole CSV export.
    response = post("/api/export/run", json={"host_id": "local", "format": "csv", "queries": [TYPED_EXPORT_SQL]})
    assert response.status_code == 200, response.text
    archive = SESSION.get(urljoin(BASE_URL + "/", response.json()["download_url"]), timeout=60)
    assert archive.status_code == 200, archive.text
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        assert "results.csv" in zf.namelist(), zf.namelist()
        rows = list(csv.DictReader(io.StringIO(zf.read("results.csv").decode("utf-8"))))
        execution = list(csv.DictReader(io.StringIO(zf.read("execution.csv").decode("utf-8"))))
    assert execution[0]["status"] == "finished", execution[0]
    assert rows == [{
        "d32": "1.25", "d64": "-3.500000", "d128": "7.125",
        "date32": "1960-01-02", "pre_epoch": "1969-12-31T23:59:59.5Z", "tenth": "0.1",
    }], rows


def test_stream_serializes_date32_and_pre_epoch_datetime64():
    _, events = run_sql(TYPED_EXPORT_SQL)
    rows = [row for e in events if e["event"] == "result_rows" for row in e["data"]["rows"]]
    assert rows == [[1.25, -3.5, 7.125, "1960-01-02", "1969-12-31T23:59:59.5Z", 0.1]], rows


def test_session_state_does_not_leak_through_the_connection_pool():
    # USE/SET change native session state; the pooled runner connection must
    # not carry them into later, unrelated runs.
    for sql in ["USE system", "SET max_threads = 3"]:
        _, events = run_sql(sql)
    for _ in range(3):
        _, events = run_sql("SELECT currentDatabase() AS db, getSetting('max_threads') = 3 AS leaked")
        rows = [row for e in events if e["event"] == "result_rows" for row in e["data"]["rows"]]
        assert rows and rows[0][0] != "system" and rows[0][1] in (0, False), rows


def test_multiquery_export_stops_at_first_failed_statement_with_explicit_error():
    response = post(
        "/api/export/run",
        json={
            "host_id": "local",
            "format": "json",
            "queries": [
                "SELECT 1 AS first",
                "SELECT * FROM chdash_ui.__missing_export_table",
                "SELECT 3 AS must_not_run",
            ],
        },
    )
    assert response.status_code == 200, response.text
    download = urljoin(BASE_URL + "/", response.json()["download_url"])
    archive = SESSION.get(download, timeout=60)
    assert archive.status_code == 200, archive.text
    assert zipfile.is_zipfile(io.BytesIO(archive.content))

    with zipfile.ZipFile(io.BytesIO(archive.content)) as zf:
        names = set(zf.namelist())
        assert "query-001/results.json" in names
        assert "query-001/execution.csv" in names
        assert "query-001/error.txt" not in names
        assert "query-002/query.sql" in names
        assert "query-002/execution.csv" in names
        assert "query-002/error.txt" in names
        assert not any(name.startswith("query-003/") for name in names), names

        error_text = zf.read("query-002/error.txt").decode("utf-8").strip()
        assert error_text, names
        execution = list(csv.DictReader(io.StringIO(zf.read("query-002/execution.csv").decode("utf-8"))))
        assert len(execution) == 1, execution
        assert execution[0]["status"] == "error", execution[0]


def _otel_window_ms() -> tuple[int, int]:
    base = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
    auth = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
    response = requests.post(
        base + "/",
        data=b"SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts",
        auth=auth, timeout=30,
    )
    assert response.status_code == 200, response.text
    end_ms = int(response.text.strip() or 0)
    if end_ms <= 0:
        pytest.skip("OTEL fixture is empty")
    return end_ms - 3_600_000, end_ms + 1


def test_trace_search_detail_and_duration_filters_use_system_context():
    # Trace Explorer reads OTEL tables through system_uri; this also guards the
    # fixture grant, which used to be dropped by every fixture reset.
    start_ms, end_ms = _otel_window_ms()
    window = {"host_id": "local", "start_ms": start_ms, "end_ms": end_ms, "limit": 20}
    search = get("/api/traces/search", params=window)
    assert search.status_code == 200, search.text
    payload = search.json()
    assert payload.get("search_path") == "trace_index", payload
    assert payload.get("rows"), payload
    trace_id = payload["rows"][0][0]

    detail = get("/api/traces/trace", params={"host_id": "local", "trace_id": trace_id, "start_ms": start_ms, "end_ms": end_ms})
    assert detail.status_code == 200, detail.text

    durations = sorted(int(row[4]) for row in payload["rows"])
    threshold_ns = durations[len(durations) // 2]
    filtered = get("/api/traces/search", params={**window, "min_duration_ms": threshold_ns / 1_000_000})
    assert filtered.status_code == 200, filtered.text
    filtered_payload = filtered.json()
    assert filtered_payload.get("search_path") == "span_duration_two_phase", filtered_payload
    assert filtered_payload.get("rows"), filtered_payload
    assert all(int(row[4]) >= threshold_ns for row in filtered_payload["rows"]), filtered_payload
    bounded = get("/api/traces/search", params={**window, "max_duration_ms": threshold_ns / 1_000_000})
    assert bounded.status_code == 200, bounded.text
    assert all(int(row[4]) <= threshold_ns for row in bounded.json().get("rows", [])), bounded.text


def test_trace_analytics_duration_quantiles_come_from_spans():
    # The OTel trace index stores End = max(Timestamp) (last span start), so
    # quantiles must be computed from span bounds, never from the index.
    start_ms, end_ms = _otel_window_ms()
    response = get("/api/traces/analytics", params={"host_id": "local", "start_ms": start_ms, "end_ms": end_ms})
    if response.status_code == 409 or response.json().get("error_code") == "trace_analytics_disabled":
        pytest.skip("trace analytics disabled in this configuration")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload.get("analytics_path") == "span_aggregation", payload
    assert payload.get("duration_quantiles_source") == "span_bounds", payload
    assert payload.get("trace_count_chart"), payload
    assert payload.get("duration_quantiles"), payload


# A browser in UTC+1 sends its local midnight: buckets must start there
# (01:00 UTC for 3 h buckets), whatever the requested range start.
_ORIGIN_MS = 3_600_000


def _analytics(params: dict, timeout: int = 90):
    response = get("/api/traces/analytics", params={"host_id": "local", **params}, timeout=timeout)
    if response.status_code == 404 and response.json().get("error_code") == "trace_analytics_disabled":
        pytest.skip("trace analytics disabled in this configuration")
    assert response.status_code == 200, response.text
    return response.json()


def test_trace_analytics_seven_day_counts_come_from_the_index_quickly_and_match_it():
    # Seven days of spans (~1.6 B rows on the large local fixture) take ~15 s
    # to group by TraceId; the count chart reads the trace index instead.
    _, end_ms = _otel_window_ms()
    start_ms = end_ms - 7 * 86_400_000 + 1000
    started = time.monotonic()
    payload = _analytics({"start_ms": start_ms, "end_ms": end_ms, "align_buckets": "0",
                          "bucket_origin_ms": _ORIGIN_MS, "charts": "counts"}, timeout=30)
    elapsed = time.monotonic() - started
    assert payload.get("charts") == ["counts"], payload
    assert payload.get("trace_count_source") == "trace_index", payload
    assert payload.get("duration_quantiles") == [], payload
    assert elapsed < 10, f"7-day count chart took {elapsed:.1f} s"
    bucket_ms = int(payload["bucket_ms"])
    origin = int(payload["bucket_origin_ms"])
    assert origin == _ORIGIN_MS % bucket_ms, payload
    chart = {int(bucket): int(count) for bucket, count in payload["trace_count_chart"]}
    assert chart and sum(chart.values()) > 0, payload
    assert all((bucket - origin) % bucket_ms == 0 for bucket in chart), sorted(chart)
    # Ground truth: every trace of the index at its first start in the window.
    expected = {
        int(bucket): int(count)
        for bucket, count in _ch_rows(
            f"SELECT {origin} + intDiv(toUnixTimestamp64Milli(s) - {origin}, {bucket_ms}) * {bucket_ms}, count() "
            f"FROM (SELECT min(Start) AS s FROM otel.otel_traces_trace_id_ts WHERE {_index_window(start_ms, end_ms)} "
            f"GROUP BY TraceId) GROUP BY 1")
    }
    assert chart == expected


def test_trace_analytics_span_counts_match_ground_truth_per_bucket():
    # Smaller window: the span aggregation (charts=durations also returns
    # counts) buckets each trace by its first span start on the origin grid.
    _, end_ms = _otel_window_ms()
    start_ms = end_ms - 2 * 3_600_000
    payload = _analytics({"start_ms": start_ms, "end_ms": end_ms, "align_buckets": "0",
                          "bucket_origin_ms": _ORIGIN_MS, "charts": "durations"})
    assert payload.get("charts") == ["counts", "durations"], payload
    assert payload.get("trace_count_source") == "span_bounds", payload
    bucket_ms = int(payload["bucket_ms"])
    q_bucket_ms = int(payload["quantile_bucket_ms"])
    origin = int(payload["bucket_origin_ms"])
    chart = {int(bucket): int(count) for bucket, count in payload["trace_count_chart"]}
    expected = {
        int(bucket): int(count)
        for bucket, count in _ch_rows(
            f"SELECT {origin} + intDiv(toUnixTimestamp64Milli(s) - {origin}, {bucket_ms}) * {bucket_ms}, count() "
            f"FROM (SELECT min(Timestamp) AS s FROM otel.otel_traces WHERE {_span_window(start_ms, end_ms)} "
            f"GROUP BY TraceId) GROUP BY 1")
    }
    assert chart and chart == expected
    quantiles = payload["duration_quantiles"]
    assert quantiles, payload
    q_origin = _ORIGIN_MS % q_bucket_ms
    for bucket, p50, p90, p95, p99 in quantiles:
        assert (int(bucket) - q_origin) % q_bucket_ms == 0, bucket
        assert 0 <= int(p50) <= int(p90) <= int(p95) <= int(p99), (bucket, p50, p90, p95, p99)


def test_trace_analytics_seven_day_duration_percentiles_are_not_empty():
    _, end_ms = _otel_window_ms()
    start_ms = end_ms - 7 * 86_400_000 + 1000
    started = time.monotonic()
    payload = _analytics({"start_ms": start_ms, "end_ms": end_ms, "align_buckets": "1",
                          "bucket_origin_ms": _ORIGIN_MS, "charts": "durations"}, timeout=120)
    elapsed = time.monotonic() - started
    assert payload.get("charts") == ["counts", "durations"], payload
    assert payload.get("duration_quantiles"), payload
    assert sum(int(count) for _, count in payload["trace_count_chart"]) > 0, payload
    # Aligned ranges cover whole buckets of the origin grid.
    bucket_ms = int(payload["bucket_ms"])
    range_start, range_end = (int(v) for v in payload["range"])
    assert (range_start - payload["bucket_origin_ms"]) % bucket_ms == 0
    assert (range_end - payload["bucket_origin_ms"]) % bucket_ms == 0
    assert range_start <= start_ms and range_end >= end_ms
    assert elapsed < 60, f"7-day duration percentiles took {elapsed:.1f} s"


def test_trace_analytics_rejects_an_unknown_chart_list():
    start_ms, end_ms = _otel_window_ms()
    response = get("/api/traces/analytics", params={"host_id": "local", "start_ms": start_ms, "end_ms": end_ms, "charts": "nope"})
    if response.status_code == 404:
        pytest.skip("trace analytics disabled in this configuration")
    assert response.status_code == 400, response.text
    assert response.json().get("error_code") == "invalid_trace_charts"


def _ch_rows(sql: str) -> list[list[str]]:
    base = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123").rstrip("/")
    auth = (os.environ.get("CLICKHOUSE_USER", "test"), os.environ.get("CLICKHOUSE_PASSWORD", "test"))
    response = requests.post(base + "/", data=(sql + " FORMAT TSV").encode(), auth=auth, timeout=120)
    assert response.status_code == 200, response.text
    return [line.split("\t") for line in response.text.splitlines() if line]


def _span_window(start_ms: int, end_ms: int) -> str:
    return f"Timestamp >= fromUnixTimestamp64Milli({start_ms}) AND Timestamp <= fromUnixTimestamp64Milli({end_ms})"


def _index_window(start_ms: int, end_ms: int) -> str:
    return f"Start >= fromUnixTimestamp64Milli({start_ms}) AND Start <= fromUnixTimestamp64Milli({end_ms})"


def _sql_list(values) -> str:
    return "(" + ",".join("'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'" for v in values) + ")"


def _expected_trace_ids(path: str, start_ms: int, end_ms: int, limit: int, span_filter: str = "", having: str = "") -> list[str]:
    # Ground truth computed directly in ClickHouse, whole window, no slicing.
    spans = _span_window(start_ms, end_ms)
    candidates = f" AND TraceId IN (SELECT TraceId FROM otel.otel_traces WHERE {spans} AND {span_filter})" if span_filter else ""
    if path in ("trace_index", "trace_index_filtered"):
        # Newest traces by their newest index row, restricted to matching traces.
        sql = (f"SELECT TraceId FROM otel.otel_traces_trace_id_ts WHERE {_index_window(start_ms, end_ms)}{candidates}"
               f" GROUP BY TraceId ORDER BY max(Start) DESC LIMIT {limit}")
    else:
        sql = (f"SELECT TraceId FROM otel.otel_traces WHERE {spans}{candidates}"
               f" GROUP BY TraceId{having} ORDER BY min(Timestamp) DESC LIMIT {limit}")
    return [row[0] for row in _ch_rows(sql)]


def _assert_trace_summaries_match_spans(payload: dict, start_ms: int, end_ms: int) -> None:
    rows = payload.get("rows") or []
    if not rows:
        return
    services = payload["services"]
    ids = [row[0] for row in rows]
    truth = {}
    firsts = {}
    for trace_id, service, spans, errors, first_ns in _ch_rows(
            f"SELECT TraceId, ServiceName, count(), countIf(StatusCode = 'Error'), min(toUnixTimestamp64Nano(Timestamp)) FROM otel.otel_traces "
            f"WHERE {_span_window(start_ms, end_ms)} AND TraceId IN {_sql_list(ids)} GROUP BY TraceId, ServiceName"):
        truth.setdefault(trace_id, {})[service] = (int(spans), int(errors))
        firsts.setdefault(trace_id, {})[service] = int(first_ns)
    bounds = {r[0]: (int(r[1]), int(r[2])) for r in _ch_rows(
        f"SELECT TraceId, toUnixTimestamp64Milli(min(Timestamp)), "
        f"toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - toInt64(min(toUnixTimestamp64Nano(Timestamp))) "
        f"FROM otel.otel_traces WHERE {_span_window(start_ms, end_ms)} AND TraceId IN {_sql_list(ids)} GROUP BY TraceId")}
    # Parent span ids no window span of the trace carries (the "Incomplete" hint).
    missing = {r[0]: int(r[1]) for r in _ch_rows(
        f"SELECT TraceId, length(arrayFilter(parent -> NOT has(ids, parent), parents)) FROM ("
        f"SELECT TraceId, groupUniqArray(SpanId) AS ids, groupUniqArrayIf(ParentSpanId, ParentSpanId != '') AS parents "
        f"FROM otel.otel_traces WHERE {_span_window(start_ms, end_ms)} AND TraceId IN {_sql_list(ids)} GROUP BY TraceId)")}
    assert payload["columns"][-1] == "missing_parents", payload["columns"]
    for row in rows:
        trace_id, first_ms, _, _, duration_ns, span_count, error_count, stats, missing_parents = row
        assert missing_parents == missing[trace_id], row
        per_service = truth[trace_id]
        assert span_count == sum(v[0] for v in per_service.values()), row
        assert error_count == sum(v[1] for v in per_service.values()), row
        assert {services[s]: (n, e) for s, n, e, _ in stats} == {k: v for k, v in per_service.items() if k}, row
        assert [n for _, n, _, _ in stats] == sorted((n for _, n, _, _ in stats), reverse=True), row
        # Each service carries its earliest window span as an offset from the
        # trace's earliest window span (the list orders services by it).
        trace_first_ns = min(firsts[trace_id].values())
        assert {services[s]: offset for s, _, _, offset in stats} == {
            k: v - trace_first_ns for k, v in firsts[trace_id].items() if k}, row
        assert (first_ms, duration_ns) == bounds[trace_id], row
    starts = [row[1] for row in rows]
    assert starts == sorted(starts, reverse=True), starts


def test_trace_index_search_pages_match_whole_window_ground_truth():
    # The index is walked in bounded Start slices (keyset) and each page's span
    # match reads only the page's time bounds; results must equal the plain
    # whole-window definition: newest matching traces by their newest index row.
    start_ms, end_ms = _otel_window_ms()
    limit = 50
    base = {"host_id": "local", "start_ms": start_ms, "end_ms": end_ms, "limit": limit}
    pairs = get("/api/traces/prefill", params={"host_id": "local", "start_ms": start_ms, "end_ms": end_ms}).json().get("pairs") or []
    assert pairs, "OTEL fixture has no service/operation pairs"
    service, operation = pairs[0][0], pairs[0][1]
    cases = [
        ({}, ""),
        ({"service": service}, f"ServiceName = '{service}'"),
        ({"service": service, "operation": operation}, f"ServiceName = '{service}' AND SpanName = '{operation}'"),
        ({"status": "Error"}, "StatusCode = 'Error'"),
    ]
    for params, span_filter in cases:
        response = get("/api/traces/search", params={**base, **params}, timeout=120)
        assert response.status_code == 200, response.text
        payload = response.json()
        path = payload.get("search_path")
        assert path in ("trace_index", "trace_index_filtered", "span_aggregation"), payload
        assert path == ("trace_index" if not params else path), payload
        ids = [row[0] for row in payload["rows"]]
        expected = _expected_trace_ids(path, start_ms, end_ms, limit, span_filter)
        assert set(ids) == set(expected), (params, path)
        _assert_trace_summaries_match_spans(payload, start_ms, end_ms)


def test_trace_duration_search_slices_match_whole_window_ground_truth():
    # Span-based ranking scans the newest time slice first and drops traces that
    # started before the slice; it must equal one whole-window aggregation.
    # A 3 h window is wide enough for the sliced plan to be used.
    _, end_ms = _otel_window_ms()
    start_ms = end_ms - 3 * 3_600_000
    limit = 40
    base = {"host_id": "local", "start_ms": start_ms, "end_ms": end_ms, "limit": limit}
    recent_payload = get("/api/traces/search", params=base, timeout=120).json()
    recent = recent_payload["rows"]
    assert recent, "OTEL fixture is empty"
    durations = sorted(int(row[4]) for row in recent)
    threshold_ns = durations[len(durations) // 2]
    duration_expr = ("(toInt64(max(toUnixTimestamp64Nano(Timestamp) + toInt64(Duration))) - "
                     "toInt64(min(toUnixTimestamp64Nano(Timestamp))))")
    service_name = recent_payload["services"][recent[0][3]]
    cases = [
        ({"min_duration_ms": threshold_ns / 1_000_000}, "", f" HAVING {duration_expr} >= {threshold_ns}"),
        ({"max_duration_ms": threshold_ns / 1_000_000}, "", f" HAVING {duration_expr} <= {threshold_ns}"),
        ({"min_duration_ms": threshold_ns / 1_000_000, "service": service_name},
         f"ServiceName = '{service_name}'", f" HAVING {duration_expr} >= {threshold_ns}"),
    ]
    for params, span_filter, having in cases:
        response = get("/api/traces/search", params={**base, **params}, timeout=120)
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload.get("search_path") == "span_duration_two_phase", payload
        ids = [row[0] for row in payload["rows"]]
        expected = _expected_trace_ids("span", start_ms, end_ms, limit, span_filter, having)
        assert ids == expected, params
        _assert_trace_summaries_match_spans(payload, start_ms, end_ms)


def test_trace_tag_search_and_detail_match_spans():
    start_ms, end_ms = _otel_window_ms()
    window = {"host_id": "local", "start_ms": start_ms, "end_ms": end_ms, "limit": 20}
    rows = get("/api/traces/search", params=window).json()["rows"]
    assert rows, "OTEL fixture is empty"
    trace_id = rows[0][0]
    detail = get("/api/traces/trace", params={"host_id": "local", "trace_id": trace_id})
    assert detail.status_code == 200, detail.text
    spans = detail.json()["spans"]
    (count,), = _ch_rows(f"SELECT count() FROM otel.otel_traces WHERE TraceId = {_sql_list([trace_id])[1:-1]}")
    assert len(spans) == int(count)
    attributes = {}
    for span in spans:
        attributes.update(json.loads(span.get("span_attributes") or "{}"))
    if not attributes:
        pytest.skip("fixture spans carry no attributes")
    key, value = sorted(attributes.items())[0]
    # Twice: the second request is answered from the cached attribute schema.
    for _ in range(2):
        response = get("/api/traces/search", params={**window, "tag_scope": "any", "tag_key": key, "tag_value": value}, timeout=120)
        assert response.status_code == 200, response.text
        payload = response.json()
        ids = [row[0] for row in payload["rows"]]
        assert ids, payload
        tag_filter = (f"((mapContains(SpanAttributes, {_sql_list([key])[1:-1]}) AND SpanAttributes[{_sql_list([key])[1:-1]}] = {_sql_list([value])[1:-1]}) OR "
                      f"(mapContains(ResourceAttributes, {_sql_list([key])[1:-1]}) AND ResourceAttributes[{_sql_list([key])[1:-1]}] = {_sql_list([value])[1:-1]}))")
        expected = _expected_trace_ids(payload["search_path"], start_ms, end_ms, 20, tag_filter)
        assert set(ids) == set(expected)


def test_trace_prefill_is_cached_per_minute_aligned_range():
    start_ms, end_ms = _otel_window_ms()
    params = {"host_id": "local", "start_ms": start_ms, "end_ms": end_ms}
    first = get("/api/traces/prefill", params=params)
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload.get("pairs"), payload
    assert payload.get("range") == [start_ms, end_ms], payload
    # A range shifted within the same minute is served from the shared scan.
    shifted = get("/api/traces/prefill", params={**params, "start_ms": start_ms - 1, "end_ms": end_ms - 1})
    assert shifted.status_code == 200, shifted.text
    assert shifted.json().get("pairs") == payload["pairs"]
    assert all(len(pair) == 3 and pair[0] and pair[1] for pair in payload["pairs"]), payload


def test_replicated_fixture_exposes_replica_counts_badges_and_distributed_topology():
    # chdash_repl lives on chdash_cluster (clickhouse + clickhouse_replica).
    detail = get("/api/explorer/table", params={"host_id": "local", "database": "chdash_repl", "table": "replicated_events", "refresh": "1"})
    assert detail.status_code == 200, detail.text
    replication = detail.json()["summary"]["replication"]
    assert replication["available"] is True, replication
    assert replication["total_replicas"] == 2 and replication["active_replicas"] == 2, replication
    assert replication["replica_name"] == "r1", replication
    assert int(detail.json()["summary"]["rows"] or 0) == 5000

    graph = get("/api/explorer/graph", params={"host_id": "local", "database": "chdash_repl", "refresh": "1"})
    assert graph.status_code == 200, graph.text
    nodes = {n.get("name"): n for n in graph.json()["nodes"] if n.get("database") == "chdash_repl"}
    assert nodes["replicated_events"].get("topology_badge") == "2R", nodes["replicated_events"]
    assert nodes["replicated_daily"].get("topology_badge") == "2R", nodes["replicated_daily"]
    assert nodes["replicated_events_all"].get("kind") == "distributed", nodes["replicated_events_all"]
    assert nodes["replicated_events"].get("health") == "healthy", nodes["replicated_events"]
    # A second build within the replica-count TTL reuses the cached counts.
    again = get("/api/explorer/graph", params={"host_id": "local", "database": "chdash_repl", "refresh": "1"})
    assert {n.get("name"): n.get("topology_badge") for n in again.json()["nodes"] if n.get("database") == "chdash_repl"} == \
        {name: node.get("topology_badge") for name, node in nodes.items()}
