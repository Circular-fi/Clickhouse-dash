"""Explorer graph side panel and per-node expansion contracts (live backend).

GET /api/explorer/graph/definition explains one authorized graph object (MV
SELECT, dictionary source, Distributed route) from the cached graph, and
/api/explorer/graph accepts repeated expand=up|down:<id> parameters on top of
the focused depth.
"""
from __future__ import annotations

import os

import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://chdash_source:8080").rstrip("/")
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "chdash-backend-functional/1"})


def get(path: str, **kwargs):
    return SESSION.get(f"{BASE_URL}{path}", timeout=kwargs.pop("timeout", 20), **kwargs)


def definition(database: str, table: str) -> dict:
    response = get("/api/explorer/graph/definition", params={"host_id": "local", "database": database, "table": table})
    assert response.status_code == 200, response.text
    assert response.headers.get("Cache-Control") == "private, no-store"
    return response.json()


def focused_graph(table: str, depth: int = 1, expand: list[str] | None = None, **extra) -> dict:
    params: list[tuple[str, str]] = [
        ("host_id", "local"), ("focus_database", "chdash_ui"), ("focus_table", table), ("depth", str(depth)),
    ]
    params += [("expand", item) for item in expand or []]
    params += list(extra.items())
    response = get("/api/explorer/graph", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_materialized_view_definition_has_select_and_target():
    payload = definition("chdash_ui", "weather_daily_summary_mv")
    assert payload["kind"] == "materialized_view"
    assert payload["id"] == "table:chdash_ui.weather_daily_summary_mv"
    assert "countState()" in payload["select_sql"]
    assert "FROM chdash_ui.weather_observations" in payload["select_sql"]
    assert payload["select_sql_truncated"] is False
    assert payload["target_visible"] is True
    assert payload["target"] == {"database": "chdash_ui", "table": "weather_daily_summary"}
    assert payload["dictionary"] is None and payload["distributed"] is None


def test_view_definition_has_select_without_target():
    payload = definition("chdash_ui", "valid_weather_observations")
    assert payload["kind"] == "view"
    assert "WHERE quality_ok" in payload["select_sql"]
    assert payload["target"] is None


def test_dictionary_definition_has_source_layout_and_lifetime_but_no_connection_arguments():
    payload = definition("chdash_ui", "station_dictionary")
    assert payload["kind"] == "dictionary"
    assert payload["target"] == {"database": "chdash_ui", "table": "station_dictionary_source"}
    assert payload["dictionary"] == {"source_kind": "CLICKHOUSE", "layout": "COMPLEX_KEY_HASHED", "lifetime": "MIN 0 MAX 0"}
    text = str(payload)
    for secret in ("PASSWORD", "HIDDEN", "chdash_runner", "127.0.0.1", "PORT"):
        assert secret not in text, payload


def test_buffer_definition_has_flush_destination():
    payload = definition("chdash_ui", "weather_buffer")
    assert payload["kind"] == "buffer"
    assert payload["target"] == {"database": "chdash_ui", "table": "weather_observations"}
    assert payload["select_sql"] is None


def test_distributed_definition_has_cluster_route_and_topology():
    payload = definition("chdash_repl", "replicated_events_all")
    assert payload["kind"] == "distributed"
    assert payload["target"] == {"database": "chdash_repl", "table": "replicated_events"}
    assert payload["distributed"] == {"cluster": "chdash_cluster", "sharding_key": "rand()", "shards": 1, "replicas_per_shard": 2}


def test_definition_rejects_incomplete_and_unknown_objects():
    missing = get("/api/explorer/graph/definition", params={"host_id": "local", "database": "chdash_ui"})
    assert missing.status_code == 400, missing.text
    unknown = get("/api/explorer/graph/definition", params={"host_id": "local", "database": "chdash_ui", "table": "no_such_table"})
    assert unknown.status_code == 404, unknown.text
    assert unknown.json()["error_code"] == "unknown_object"
    host = get("/api/explorer/graph/definition", params={"host_id": "nope", "database": "chdash_ui", "table": "weather_buffer"})
    assert host.status_code == 404, host.text


def test_graph_has_dictionary_source_edge_from_loading_dependencies():
    graph = focused_graph("station_dictionary")
    edges = {(edge["from"], edge["to"], edge["kind"]) for edge in graph["edges"]}
    assert ("table:chdash_ui.station_dictionary_source", "table:chdash_ui.station_dictionary", "dictionary_source") in edges
    edge = next(edge for edge in graph["edges"] if edge["kind"] == "dictionary_source")
    assert edge["can_animate"] is False


def test_focused_graph_reports_hidden_neighbours_per_direction():
    graph = focused_graph("weather_observations")
    nodes = {node["id"]: node for node in graph["nodes"]}
    buffer = nodes["table:chdash_ui.weather_buffer"]
    # weather_buffer also feeds two MVs that are two hops from the focus.
    assert buffer["hidden_downstream"] == 2, buffer
    assert buffer["hidden_upstream"] == 0, buffer
    focus = nodes["table:chdash_ui.weather_observations"]
    assert focus["hidden_upstream"] == 0 and focus["hidden_downstream"] == 0, focus
    assert all("hidden_upstream" in node for node in graph["nodes"] if node["layer"] == "logical")


def test_expand_adds_one_hop_in_one_direction_and_ignores_unknown_anchors():
    base = {node["id"] for node in focused_graph("weather_observations")["nodes"]}
    expanded = focused_graph("weather_observations", expand=["down:table:chdash_ui.weather_buffer"])
    ids = {node["id"] for node in expanded["nodes"]}
    added = ids - base
    assert added == {"table:chdash_ui.weather_buffer_alert_mv", "table:chdash_ui.weather_buffer_city_mv"}, added
    nodes = {node["id"]: node for node in expanded["nodes"]}
    assert nodes["table:chdash_ui.weather_buffer"]["hidden_downstream"] == 0
    assert nodes["table:chdash_ui.weather_buffer_alert_mv"]["hidden_downstream"] == 1
    # Upstream of the buffer is empty: nothing added, the request is valid.
    up = focused_graph("weather_observations", expand=["up:table:chdash_ui.weather_buffer"])
    assert {node["id"] for node in up["nodes"]} == base
    # Anchors outside the shown neighbourhood or unknown ids are no-ops.
    noop = focused_graph("weather_observations", expand=[
        "down:table:chdash_ui.weather_alert_buffer", "down:table:nope.nope", "sideways:table:chdash_ui.weather_buffer",
    ])
    assert {node["id"] for node in noop["nodes"]} == base
    # Chained expansions apply to a fixed point regardless of order.
    chained = focused_graph("weather_observations", expand=[
        "down:table:chdash_ui.weather_buffer_alert_mv", "down:table:chdash_ui.weather_buffer",
    ])
    assert "table:chdash_ui.weather_alert_buffer" in {node["id"] for node in chained["nodes"]}


def test_expand_with_hidden_non_storing_objects_walks_through_them():
    # With View/MV/Buffer hidden, an expansion still reaches the next storing
    # object and ships the hidden intermediates for client-side contraction.
    graph = focused_graph("weather_observations", expand=["down:table:chdash_ui.weather_buffer"], include_non_storing="0")
    ids = {node["id"] for node in graph["nodes"]}
    assert "table:chdash_ui.weather_city_ingest_target" in ids, ids
    assert "table:chdash_ui.weather_buffer_city_mv" in ids, ids
