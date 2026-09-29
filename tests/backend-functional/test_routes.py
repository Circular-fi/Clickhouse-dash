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

    # The sidebar catalog is deliberately lightweight (names, engine, rows and
    # bytes). Rich per-table storage metrics are loaded lazily by the table
    # detail route, so they are asserted against /api/explorer/table below.
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
