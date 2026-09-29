from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_treemap_keeps_the_s3_browser_grouping_and_layout_contract() -> None:
    js = read("src/static/app_explorer_treemap.js")
    # Ceil(1%) threshold, applied with the same absolute value at every level.
    assert "return Math.floor((total + 99) / 100);" in js
    assert "if (threshold === 0 || nodeBytes(child) >= threshold) {" in js
    # Parent aggregates are exact: unlisted bytes land in Others.
    assert "let otherBytes = Math.max(0, nodeBytes(result) - listedBytes);" in js
    # Single-child contraction and sole-Others suppression.
    assert "while (visible.length === 1) {" in js
    assert "visible.length = 0;" in js
    for constant in [
        "const treemapMaximumRectangles = 1000;",
        "const treemapMaximumDepth = 5;",
        "const treemapGapPixels = 2;",
        "const treemapOtherInlineMinimumHeightPixels = 26;",
        "const treemapOtherStackedMinimumHeightPixels = 34;",
        "const treemapOtherInlineMinimumWidthPixels = 180;",
        "const treemapMinimumRegularPixels = 30;",
        "const treemapFolderHeaderPixels = 26;",
        "const treemapBranchInsetPixels = 2;",
    ]:
        assert constant in js, constant
    assert "function squarifyTreemapNodes(nodes, x, y, width, height)" in js
    assert "function treemapWorstAspectRatio(row, side)" in js
    assert "const readableMinimum = Math.min(treemapOtherReadableHeight(width), maximumHeight);" in js
    assert "function fitTreemapLabels(map)" in js
    assert 'tooltip.setAttribute("data-treemap-tooltip", "");' in js
    assert 'map.className = "explorerTreemap is-layout-pending";' in js
    assert "new ResizeObserver(scheduleRender)" in js


def test_database_treemap_excludes_resident_memory_from_disk_area() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index("function databaseStorageTree(database)"):ui.index("function renderDatabaseStorage(container, database)")]
    assert "if (isResidentMemorySummary(table)) {" in block
    assert "residentBytes += footprint;" in block
    assert "renderDatabaseStorage(dom.explorerDetailContent, name);" in ui


def test_system_section_has_its_own_route_that_does_not_shadow_the_system_database() -> None:
    ui = read("src/static/app_explorer.js")
    html = read("src/static/explorer.html")
    assert 'const SYSTEM_ROUTE_SEGMENT = "_system";' in ui
    assert "if (parts[0] === SYSTEM_ROUTE_SEGMENT) {" in ui
    assert 'id="explorerSystemSectionButton"' in html
    assert 'id="explorerSystemPane"' in html
    assert "api.getExplorerStorage(hostId, !!force)" in ui


def test_storage_endpoint_names_come_from_the_runner_boundary() -> None:
    server = read("src/server.cpp")
    api = read("src/api_explorer.cpp")
    catalog = read("src/explorer_catalog.cpp")
    assert 'http_.Get("/api/explorer/storage"' in server
    assert "explorer_storage_cache_.get_or_refresh(" in api
    assert "explorer_storage_cache_.erase(storage_key);" in api
    block = catalog[catalog.index("bool load_explorer_storage_map("):catalog.index("bool load_explorer_table_summary(")]
    assert "discover_visible_databases(runner)" in block
    assert "discover_visible_objects(runner, database)" in block
    assert "if (!is_visible(database, table)) continue;" in block
    assert "FROM system.parts WHERE active AND " in block
    assert "GROUP BY database, `table`" in block
    assert "SYSTEM FLUSH" not in block
