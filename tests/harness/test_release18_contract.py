from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_focus_expands_reverse_buffer_ingress() -> None:
    graph = read("src/static/app_explorer_graph.js")
    raw = graph[graph.index("function rawStorageProjection()"):graph.index("function storageProjection()")]
    assert "const incoming = new Map();" in raw
    assert "const addBuffersFeeding =" in raw
    assert 'if (edge.kind !== "buffer") continue;' in raw
    assert "addBufferRoute(source.id);" in raw
    assert "addBuffersFeeding(source.id, nextTrail);" in raw
    assert "addBuffersFeeding(rootId);" in raw


def test_lineage_uses_global_obstacle_and_crossing_aware_orthogonal_routing() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "lineageRouteCache: null" in graph
    assert "function orthogonalRouteForEdge(" in graph
    assert "function orthogonalSegmentConflict(" in graph
    assert "function routeConflictPenalty(" in graph
    assert "function ensureLineageRouteCache()" in graph
    assert "conflict.crossings * 28_000" in graph
    assert "1_000_000_000 + conflict.overlap * 100_000" in graph
    assert "segmentHitsItem(a, b, item, padding)" in graph
    assert "usedSegments.push" in graph
    assert "model.lineageRouteCache = null;" in graph
    assert "lineageDetourRoute" not in graph


def test_flow_marker_scales_size_and_apparent_speed_with_zoom() -> None:
    graph = read("src/static/app_explorer_graph.js")
    marker = graph[graph.index("const FLOW_SPEED_WORLD_PER_SECOND"):graph.index("function drawStorageFlowMarker")]
    assert "const FLOW_SPEED_WORLD_PER_SECOND = 72;" in marker
    assert "const FLOW_DOT_RADIUS_WORLD = 2.35;" in marker
    assert "const FLOW_EMISSION_INTERVAL_MS = 900;" in marker
    assert "const worldDistance = ageMs / 1000 * FLOW_SPEED_WORLD_PER_SECOND;" in marker
    assert "ctx.arc(point.x, point.y, FLOW_DOT_RADIUS_WORLD" in marker
    assert "/ scale" not in marker


def test_storage_sidebar_disables_virtual_system_engines_from_catalog_signals() -> None:
    explorer = read("src/static/app_explorer.js")
    assert "function storageCatalogEligible(summary)" in explorer
    eligibility = explorer[explorer.index("function storageCatalogEligible"):explorer.index("function summaryFootprintBytes")]
    assert "isBufferSummary(summary)" in eligibility
    assert "isMergeTreeSummary(summary) || isLogFamilySummary(summary)" in eligibility
    assert "summary.storage_policy" in eligibility
    assert "summary.disks" in eligibility
    assert "return false;" in eligibility
    assert "&& !storageCatalogEligible(table);" in explorer


def test_long_enums_and_nested_map_enums_are_structured_multiline() -> None:
    formatter = read("src/format_postprocess.cpp")
    expected = read("tests/api/format/output/093_create_table_long_enums.sql")
    assert "format_long_enum_type_lines" in formatter
    assert 'starts_with_ci(item, "Enum8(")' in formatter
    assert "Map(\n        Enum8(\n" in expected
    assert "`operation` Enum16(\n" in expected
    assert "'Set' = 5\n    )," in expected
    assert "'ZAUTHFAILED' = -115\n        ),\n        UInt32\n    )" in expected
