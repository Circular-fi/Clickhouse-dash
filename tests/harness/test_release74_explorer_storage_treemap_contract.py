from pathlib import Path
import css_sources

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
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    block = ui[ui.index("function databaseStorageTree(database)"):ui.index("function renderDatabaseStorage(container, database)")]
    assert "if (isResidentMemorySummary(table)) {" in block
    assert "residentBytes += footprint;" in block
    # The database page draws it under its objects.
    assert "const storage = renderDatabaseStorage(body, name);" in ui


def test_the_former_storage_routes_open_the_storage_tabs_and_the_system_route_does_not_shadow_the_system_database() -> None:
    ui = read("src/static/app_explorer.js")
    html = read("src/static/explorer.html")
    # /explorer/_system[?database=&table=] (the former Storage view) and
    # ?mode=storage (the former Storage mode) open the table card's Storage
    # tab, or the database page scrolled to its storage.
    assert 'const SYSTEM_ROUTE_SEGMENT = "_system";' in ui
    assert "if (parts[0] === SYSTEM_ROUTE_SEGMENT) {" in ui
    assert 'tab: "Storage", databaseFocus: table ? "" : "storage" };' in ui
    assert 'if (focus === "storage" && storage) requestAnimationFrame(() => storage.scrollIntoView({ block: "start" }));' in ui
    for removed in ['id="explorerModeStorage"', 'data-mode="storage"', 'id="explorerStorageTab"', 'id="explorerSystemPane"']:
        assert removed not in html, removed
    assert "storageView.show(" not in ui


def test_storage_drawings_are_bounded_treemaps_with_a_strip_fallback() -> None:
    storage = read("src/static/app_explorer_storage.js")
    treemap = read("src/static/app_explorer_treemap.js")
    detail = read("src/static/app_explorer_detail.js")
    css = css_sources.text()
    assert "const TREEMAP_MIN_ITEMS = 3;" in storage
    # One size band (app_explorer_treemap.js band()): the treemap, the share
    # strip when one cell holds more than DOMINANT_SHARE or too few cells show
    # (or nothing, fallback "none"), one height, one legend and footnote.
    assert "const DOMINANT_SHARE = 0.85;" in treemap
    assert 'if (significantLeafCount(built.tree) < minItems) return fallback === "none" ? "" : "strip";' in treemap
    assert 'return dominantShare(built.tree) > DOMINANT_SHARE ? "strip" : "map";' in treemap
    assert "const band = treemap.band(container, {" in storage
    # The former Storage mode's server view, sorted list and zoom are gone.
    for removed in ["function show(", "function serverLevel(", "function renderList(", "setScope(", "getExplorerStorage", "explorerStorageList"]:
        assert removed not in storage, removed
    assert "getExplorerStorage" not in read("src/static/app_api.js")
    # The database page: a treemap, else the share strip; the disks.
    assert 'stripId: "explorerDatabaseStorageStrip",' in storage and 'fallback: "strip",' in storage
    assert 'table.id = "explorerDatabaseDisks";' in storage
    # The table tab's partitions and the Columns tab's column sizes.
    assert 'id: "explorerPartitionTreemap",' in detail
    assert 'id: "explorerColumnTreemap",' in detail
    # Partitions and columns are leaves; slivers keep a rotated label or a mark.
    assert 'const isLeaf = declaredKind === "table" || declaredKind === "partition" || declaredKind === "column";' in treemap
    assert 'label.classList.add("is-vertical");' in treemap
    assert 'node.classList.add("is-sliver");' in treemap
    assert "(drawWidth >= 80 || (drawWidth >= 36 && drawHeight >= 160))" in treemap
    # One height for every treemap (180 px, 160 px on narrow windows).
    assert "  height: var(--sizemap-h);" in css
    assert "--sizemap-h: 180px;" in css and "--sizemap-h: 160px;" in css
    assert "explorerTreemapPanel--" not in css


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
