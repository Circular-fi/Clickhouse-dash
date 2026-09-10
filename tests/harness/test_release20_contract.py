from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_places_buffer_above_targets_before_table_tier() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "const columnGap = 150;" in graph
    assert 'edge.kind === "buffer"' in graph
    assert "const maxSourceY = target.y - source.height - rowGap;" in graph
    assert "source.y = maxSourceY;" in graph
    assert "const tierX = Math.max(logicalRight, middleRight) + columnGap;" in graph


def test_lineage_has_single_input_output_port_and_perpendicular_fan_stubs() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "one semantic output point (right edge, at a" in graph
    assert "one semantic input point" in graph
    assert "current.a = port;" in graph
    assert "current.b = port;" in graph
    assert "current.aFan = { x: port.x + offset, y: port.y };" in graph
    assert "current.bFan = { x: port.x - offset, y: port.y };" in graph
    assert "const route = [sourcePort, sourceFan];" in graph
    assert "route.push(targetPort);" in graph


def test_crossing_router_evaluates_multiple_global_route_orders() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "function routePairConflictScore(" in graph
    assert "function lineageRouteSetScore(" in graph
    assert "function buildLineageRouteCandidate(" in graph
    assert "function improveLineageRouteCandidate(" in graph
    assert "Rip-up/reroute the most conflicted edge" in graph
    assert "const verticalFirst = edges.slice().sort" in graph
    assert "candidates.push(buildLineageRouteCandidate(verticalFirst, ports))" in graph
    assert "lineageRouteSetScore(a, edgesById) - lineageRouteSetScore(b, edgesById)" in graph
    assert "conflict.crossings * 28_000" in graph


def test_ttl_lifecycle_dash_is_documented_in_vertical_legend() -> None:
    html = read("src/static/explorer.html")
    css = read("src/static/style.css")
    graph = read("src/static/app_explorer_graph.js")
    assert "TTL lifecycle" in html
    assert "explorerLegendLine--ttl" in html
    assert 'id="explorerGraphLegendTtl"' in html
    assert 'id="explorerGraphLegendTtl"' in html and "hidden" in html
    assert ".explorerLegendLine--ttl" in css
    assert 'edge.kind === "ttl_delete" || edge.kind === "ttl_move"' in graph
    assert 'document.getElementById("explorerGraphLegendTtl")' in graph
    assert 'ttlLegend.hidden = next !== "physical"' in graph
    # The legend remains a vertical one-column grid.
    assert "grid-template-columns: 1fr;" in css
