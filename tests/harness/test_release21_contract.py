from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_router_uses_local_corridors_instead_of_graph_wide_u_detours() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "Keep routing local to the two endpoints" in graph
    assert "const localLeft = Math.min(sourceFan.x, targetFan.x) - horizontalPad;" in graph
    assert "const localRight = Math.max(sourceFan.x, targetFan.x) + horizontalPad;" in graph
    assert "const localTop = Math.min(sourceFan.y, targetFan.y) - verticalPad;" in graph
    assert "const localBottom = Math.max(sourceFan.y, targetFan.y) + verticalPad;" in graph
    assert "Preserve the source->destination vertical direction even in the" in graph
    assert "Same-row obstacle exception" in graph


def test_router_forbids_line_overlap_outside_small_port_fans() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "function sharedPortOverlapAllowed(" in graph
    assert "1_000_000_000 + conflict.overlap * 100_000" in graph
    assert "sourceFan: i === 0" in graph
    assert "targetFan: i === count - 1" in graph
    assert "i <= 1" not in graph[graph.index("function routeSegmentMeta"):graph.index("function sharedPortOverlapAllowed")]


def test_router_prefers_nested_fan_lanes_and_fewer_angles() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "Farthest destinations on the same vertical side turn first" in graph
    assert "b.distance - a.distance" in graph
    assert "function routeBendCount(" in graph
    assert "routeBendCount(routeA.points) * 180" in graph
    assert 'const bend = current.dir !== "N" && current.dir !== next.dir ? 220 : 0;' in graph
    assert "for (let pass = 0; pass < 4; pass += 1)" in graph
