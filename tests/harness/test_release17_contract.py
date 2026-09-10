from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_topology_controls_are_grouped_and_storage_select_can_lock() -> None:
    html = read("src/static/explorer.html")
    css = read("src/static/style.css")
    js = read("src/static/app_explorer_graph.js")

    assert 'class="explorerGraphViewportGroup"' in html
    assert 'class="explorerGraphViewportAux"' in html
    assert ".themeSelect__button--singleOption" in css
    assert 'dom.explorerGraphTypeSelectButton.dataset.singleOption = storageAllowed ? "0" : "1"' in js
    assert 'button.dataset.singleOption === "1"' in js


def test_non_storing_toggle_now_covers_buffers_and_can_reflow_around_focus() -> None:
    frontend = read("src/static/app_explorer_graph.js")
    explorer = read("src/static/app_explorer.js")

    assert '"buffer"' in frontend
    assert '"buffer"].includes(String(node?.kind || ""))' in frontend
    assert 'recomputePreservingFocusAnchorOnly' in frontend
    assert 'computeLayout();' in frontend[frontend.index('function recomputePreservingFocusAnchorOnly'):frontend.index('function logicalFocusId')]
    assert 'restoreViewportAnchor(anchor);' in frontend
    assert 'resolveBufferRepresentative' in frontend
    assert 'key === "buffer"' in explorer


def test_trace_viewer_is_borderless_and_scrolls_only_the_body() -> None:
    css = read("src/static/style.css")
    js = read("src/static/app_trace_viewer.js")

    assert ".traceViewer__scroll" in css
    assert ".traceViewer {\n  width: 100%;\n  border: 0;" in css
    assert 'scroll.className = "traceViewer__scroll"' in js
    assert 'table.appendChild(scroll);' in js


def test_explorer_overview_and_fixtures_cover_projection_index_and_complex_types() -> None:
    api = read("src/api_explorer.cpp")
    catalog_h = read("src/explorer_catalog.hpp")
    catalog_cpp = read("src/explorer_catalog.cpp")
    explorer = read("src/static/app_explorer.js")
    fixtures = read("tests/clickhouse-init/02-frontend-fixtures.sql")
    formatted = read("tests/api/format/output/092_create_table_wide_types.sql")

    assert "secondary_indices_bytes" in api
    assert "projection_bytes" in api
    assert "secondary_indices_bytes" in catalog_h
    assert "projection_bytes" in catalog_h
    assert "system.projection_parts" in catalog_cpp
    assert "secondary_indices_compressed_bytes" in catalog_cpp
    assert 'renderStorageMetricTable(container, "Indexes", "indexes"' in explorer
    assert 'renderStorageMetricTable(container, "Projections", "projections"' in explorer
    assert 'kind.startsWith("index:")' in explorer
    assert 'kind.startsWith("projection:")' in explorer
    assert 'ns.results?.createStaticResultTable?.({' in explorer
    assert "PROJECTION prj_wide_types_state" in fixtures
    assert "INDEX idx_wide_types_state" in fixtures
    assert "Tuple(" in formatted and "Array(Tuple(" in formatted and "Map(String, String)" in formatted


def test_storage_tiers_group_disks_and_render_ttl_lifecycle_where_it_happens() -> None:
    graph = read("src/static/app_explorer_graph.js")

    assert 'function rawStorageProjection()' in graph
    assert 'function storageProjection()' in graph
    assert 'kind: "storage_tier"' in graph
    assert 'tier_disks: disks' in graph
    assert 'if (node.kind === "storage_policy") continue;' in graph
    assert 'Storage policy · ${node.storage_policy}' in graph
    assert 'kind: "policy_volume"' in graph
    assert 'current.ttl_events.push(event);' in graph
    assert 'addTtlEdgeEvent(current, target, event);' in graph
    assert 'kind: "ttl_delete"' in graph
    assert '`TTL while in ${volumeName}`' in graph
    assert '`Volume · ${volumeName}`' in graph
    assert '`Disk · ${diskName}`' in graph
    assert 'function drawLifecycleEdgeLabel(' in graph
    assert 'function ttlTimingSummary(rule)' in graph
    assert 'if (base && offset) return `${base} ${offset}`;' in graph
    assert 'lines.push(ttlTimingSummary(event));' in graph
    assert '`MOVE → ${kind ? `${kind} ` : ""}${target}`' in graph
    assert 'lines.push("DELETE");' in graph
    assert 'ctx.globalAlpha = 1;' in graph[graph.index('function drawLifecycleEdgeLabel('):graph.index('function drawNode(')]
    assert 'function alignPhysicalStorageRows(' in graph
    assert 'const tierX = Math.max(logicalRight, middleRight) + columnGap;' in graph
    assert 'item.x = tierX;' in graph
    assert 'item.y = tierY;' in graph
    assert 'item.x = terminalX;' in graph
    assert 'item.y = lastTier ? lastTier.y : terminalFallbackY;' in graph
    assert 'function storageRouteGeometry(' in graph
    assert 'function drawStorageRoute(' in graph
    assert 'function drawStorageFlowMarker(' in graph
    assert 'const FLOW_SPEED_WORLD_PER_SECOND = 72;' in graph
    assert 'const FLOW_DOT_RADIUS_WORLD = 2.35;' in graph
    assert 'const FLOW_EMISSION_INTERVAL_MS = 900;' in graph
    assert 'const newestAgeMs = (now + state.phaseOffsetMs) % FLOW_EMISSION_INTERVAL_MS;' in graph
    assert 'const worldDistance = ageMs / 1000 * FLOW_SPEED_WORLD_PER_SECOND;' in graph
    assert 'ctx.arc(point.x, point.y, FLOW_DOT_RADIUS_WORLD, 0, Math.PI * 2);' in graph
    assert 'const storageTierGap = 82;' in graph
    assert 'tierY += item.height + storageTierGap;' in graph
    lifecycle = graph[graph.index('function drawLifecycleEdgeLabel('):graph.index('function drawNode(')]
    assert 'ctx.fillStyle = css("--panelBg", "#0f1623");' in lifecycle
    assert 'ctx.fillStyle = css("--tableBg", "#10141d");' not in lifecycle
    assert 'const hasStorageAnimation = model.detailMode === "physical"' in graph
    assert 'prefers-reduced-motion: reduce' in graph
    assert 'function drawTtlSummary(' in graph
    assert 'lifecycle rule' in graph


def test_storage_mode_disables_and_greys_non_storing_objects_everywhere() -> None:
    explorer = read("src/static/app_explorer.js")
    graph = read("src/static/app_explorer_graph.js")
    css = read("src/static/style.css")

    assert 'button.classList.toggle("is-storage-blocked", !!storageBlocked);' in explorer
    assert 'button.disabled = !!storageBlocked;' in explorer
    assert '.explorerTreeObject.is-storage-blocked' in css
    blocked = css[css.index('.explorerTreeObject.is-storage-blocked'):css.index('.explorerTreeObject.is-selected')]
    assert 'opacity: 0.42;' in blocked
    assert 'cursor: default;' in blocked

    assert 'storage_disabled: !canUseStorageForId(node.id)' in graph
    assert 'ctx.globalAlpha = storageDisabled ? 0.46' in graph
    assert 'ctx.fillText("No persistent storage"' in graph
    assert 'function nodeIsStorageDisabled(node)' in graph
    assert 'function nodeIsClickable(node)' in graph
    assert 'canvas.classList.toggle("is-node-clickable", !model.dragging && nodeIsClickable(node));' in graph
    assert 'canvas.classList.toggle("is-node-disabled", !model.dragging && nodeIsStorageDisabled(node));' in graph
    assert '.explorerGraphCanvas.is-node-clickable' in css
    assert '.explorerGraphCanvas.is-node-disabled' in css


def test_create_table_tuple_closers_and_index_columns_are_aligned() -> None:
    formatter = read("src/format_postprocess.cpp")
    formatted = read("tests/api/format/output/092_create_table_wide_types.sql")

    assert 'align_multiline_tuple_closers' in formatter
    assert 'align_create_index_groups' in formatter
    assert 'name String\n    ),' in formatted
    assert '`nested_array`' in formatted


def test_clickhouse_ddl_contextual_keywords_are_always_highlightable() -> None:
    api = read("src/api_meta.cpp")
    meta = read("src/static/app_meta.js")
    highlight = read("src/static/app_highlight.js")

    for keyword in ['"INDEX"', '"PROJECTION"', '"TYPE"', '"GRANULARITY"']:
        assert keyword in api
    assert 'out.source = "clickhouse+builtin";' in api
    assert 'items.map((value) => value.toLowerCase())' in meta
    assert 'kwSet.has(wLower)' in highlight
