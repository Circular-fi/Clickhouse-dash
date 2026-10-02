import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_view_tabs_are_catalog_and_functions_and_catalog_modes_share_the_tree() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    assert 'id="explorerViewTabs" class="viewTabs" role="tablist"' in html
    for tab, view in [("explorerCatalogTab", "catalog"), ("explorerFunctionsTab", "functions"), ("explorerOpsTab", "operations")]:
        assert f'id="{tab}"' in html and f'data-view="{view}"' in html
    # Graph and Storage are modes of the Catalog, not top tabs.
    for removed in ["explorerGraphTab", "explorerStorageTab", "explorerBreadcrumb", "explorerSectionSelect",
                    "explorerTableModeTabs", "explorerTableSettingsButton", "explorerIncludeNonStoring", "explorerFunctionSettings"]:
        assert f'id="{removed}"' not in html
    # Operations stays hidden until its module is loaded.
    assert 'data-view="operations" aria-selected="false" hidden>' in html
    # One tree, then the mode bar above the card, the graph and the storage.
    catalog = html[html.index('id="explorerListView"'):html.index('id="explorerFunctionsPane"')]
    order = ["explorerListPane", "explorerCatalogMain", "explorerModeBar", "explorerModeTabs", "explorerCatalogView",
             "explorerGraphPane", "explorerSystemPane"]
    assert [catalog.index(f'id="{name}"') for name in order] == sorted(catalog.index(f'id="{name}"') for name in order)
    for mode, pane in [("browse", "explorerCatalogView"), ("graph", "explorerGraphPane"), ("storage", "explorerSystemPane")]:
        assert f'data-mode="{mode}"' in catalog and f'aria-controls="{pane}"' in catalog
    assert 'id="explorerScopeUp" class="explorerScopeUp" type="button" hidden>' in catalog
    for container in ["explorerFunctionsPane", "explorerOpsPane"]:
        assert f'id="{container}"' in html
    assert 'const MODES = ["browse", "graph", "storage"];' in ui
    assert 'const VIEWS = ["catalog", "functions", "operations"];' in ui
    # The tree selection is the scope of every mode.
    assert "function selectionScope() {" in ui
    assert "graph?.focusTable?.(scope.database, scope.table, { ensureVisible: true });" in ui
    assert "graph?.focusDatabase?.(scope.database);" in ui
    # Storage zooms move the tree selection; the System chip filters Storage.
    assert 'storageView.show(dom.explorerSystemPane, {' in ui
    assert "includeSystem: model.includeSystem," in ui
    assert "if (scope.database && scope.table) void selectTable(scope.database, scope.table);" in ui
    assert 'if (key === "system" && model.section === "tables" && model.mode === "storage") renderSystemView();' in ui
    assert "onIncludeSystemChange" not in ui and "renderBreadcrumb" not in ui
    # Operations: module hook kept, the view hidden while the module is not loaded.
    assert 'ns.explorerOps.show(dom.explorerOpsPane, { onOpenTable: (database, table) => openCard(database, table) });' in ui
    assert 'const available = { catalog: true, functions: true, operations: operationsAvailable() };' in ui
    assert 'return !!ns.explorerOps && f.enabled && f.operations.enabled;' in ui
    assert 'const OPERATIONS_ROUTE_SEGMENT = "_operations";' in ui
    assert 'init, setWorkspace, setSection, setMode, setView, currentView, storageScope,' in ui


def test_operations_view_is_hidden_by_not_loading_its_module() -> None:
    manifest = json.loads(read("src/static/modules.json"))
    explorer_css = read("src/static/style.explorer.css")
    assert "app_explorer_ops.js" not in manifest["pages"]["explorer"]["modules"]
    assert any('To bring it back, add \"app_explorer_ops.js\" to pages.explorer.modules' in line for line in manifest["//"])
    # Its rules are not shipped to the Explorer page while it is hidden.
    assert ".explorerOpsTile" not in explorer_css


def test_catalog_urls_use_one_scheme_and_keep_the_old_ones_as_aliases() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function catalogPath({ database = \"\", table = \"\", tab = DEFAULT_TAB, mode = \"browse\", graphRoute = null } = {}) {" in ui
    assert 'if (mode !== "browse") params.set("mode", mode);' in ui
    # ?view=graph, /_system?database=&table= and the card-tab paths are aliases.
    assert '(params.get("view") === "graph" ? "graph" : "browse")' in ui
    assert 'return { ...catalog, mode: "storage", database, table: database ? params.get("table") || "" : "" };' in ui
    assert '["overview", "Columns"], ["schema", "Columns"], ["data", "Preview"],' in ui
    assert 'window.history.replaceState({ workspace: "explorer" }, "", canonical);' in ui


def test_one_number_format_is_shared_with_every_explorer_module() -> None:
    ui = read("src/static/app_explorer.js")
    util = read("src/static/app_util.js")
    format = read("src/static/app_format.js")
    # Every Explorer module formats through ns.format (app_format.js), shared
    # with the whole app: no Explorer copy of the integer / byte / compact
    # helpers is left, and util.formatBytes hands its values to ns.format.
    assert 'const format = ns.format;' in ui
    for name in ("function fmtInt", "function fmtBytes", "function fmtCompactInt", "ns.explorerFormat", "const MISSING"):
        assert name not in ui, name
    assert 'return format.bytes(n);' in util
    assert 'return `${sign}${v.toFixed(1)} ${BYTE_UNITS[unit]}`;' in format
    assert 'if (v < 1024) return `${sign}${Math.round(v)} B`;' in format
    assert "v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)" not in util


def test_tree_rows_chips_and_drawer() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    tree = ui[ui.index("function renderTableList"):ui.index("function catalogContainsTable")]
    assert 'node("span", "explorerTreeObject__size explorerBar", badge.text)' in tree
    assert 'size.style.setProperty("--bar-pct", `${barPercent(badge.value, maxBytes)}%`);' in tree
    assert 'highlightedText("explorerTreeObject__name", table.name, query)' in tree
    assert 'if (query && loaded && !items.length && !databaseMatches) continue;' in tree
    assert 'setTreeDrawerOpen(false);' in tree
    assert 'function toggleTypeFilter(key)' in ui
    # The panes are ns.sidePanel shells: their drawer opens for the view's pane.
    html = read("src/static/explorer.html")
    assert '<aside id="explorerListPane" class="uiSide explorerListPane" aria-label="Objects">' in html
    assert '<aside id="explorerFunctionListPane" class="uiSide explorerListPane" aria-label="Functions">' in html
    assert 'sidePanel(id)?.setDrawerOpen(value && id === current);' in ui
    # Every Catalog mode slides the same tree in, under the mode bar.
    assert 'if (view === "catalog") return { id: "explorerListPane", label: "Objects" };' in ui
    assert "#explorerListView {\n    --side-drawer-top: calc(var(--shell-top, 0px) + var(--nav-row-h));" in css
    assert "--explorer-mode-bar-height" not in css
    # The header wraps on a phone through the one unscoped rule every shell shares.
    narrow = css[css.index("/* -- Narrow windows: the header wraps"):]
    assert "@media (max-width: 820px) {\n  .appHeader {\n    flex-wrap: wrap;" in narrow
    assert 'body[data-page="explorer"] .appHeader' not in css
    assert 'body[data-page="observability"] .appHeader' not in css


def test_shared_bar_and_typography_tokens() -> None:
    css = read("src/static/style.css")
    block = css[css.index("Explorer nav: shell"):]
    for token in ["--explorer-table-font: 13px;", "--explorer-section-title-weight: 600;", "--explorer-bar-alpha: 35%;"]:
        assert token in block
    # Monospace comes from the one global --mono token.
    assert "--explorer-mono" not in css and "--mono: ui-monospace" in css
    assert ".explorerBar {" in block and "background-size: var(--bar-pct, 0%) 100%;" in block
    # In-table bars are the shared .cellBar (app_ui_table.js), not .explorerBar.
    assert ".resultTable tbody td.explorerBar--cell" not in css and ".cellBar {" in css


def test_database_objects_table_fits_and_formats_numbers() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'const DATABASE_OBJECT_COLUMNS = ["Name", "Engine", "Rows", "Size", "Compressed", "Ratio", "% database", "Parts", "Modified"];' in ui
    block = ui[ui.index("function renderDatabaseObjects"):ui.index("function selectDatabase(")]
    assert 'setBar(td, value, maxima[ctx.columnIndex], format.count(value));' in block
    assert "ns.table.cellBar(td, barPercent(value, max));" in block
    assert "resultTable__gaugeCell" not in block
    assert '`${format.bytes(item.uncompressed)} uncompressed / ${format.bytes(item.compressed)} compressed`' in block


def test_nav_spec_runs_in_the_frontend_phase() -> None:
    runner = read("tests/test-suite/run-all-tests.py")
    assert "'specs/explorer-nav.spec.js'" in runner
    spec = read("tests/frontend/specs/explorer-nav.spec.js")
    assert "viewport: { width: 390, height: 844 }" in spec
    assert "for (const theme of ['dark', 'light'])" in spec
