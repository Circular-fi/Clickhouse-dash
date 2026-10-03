import json
from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_view_tabs_are_catalog_and_functions_and_catalog_modes_share_the_tree() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    assert 'id="explorerViewTabs" class="viewTabs" role="tablist"' in html
    for tab, view in [("explorerCatalogTab", "catalog"), ("explorerFunctionsTab", "functions"), ("explorerOpsTab", "operations")]:
        assert f'id="{tab}"' in html and f'data-view="{view}"' in html
    # Graph is a mode of the Catalog, not a top tab; Storage is a card tab.
    for removed in ["explorerGraphTab", "explorerStorageTab", "explorerBreadcrumb", "explorerSectionSelect",
                    "explorerTableModeTabs", "explorerTableSettingsButton", "explorerIncludeNonStoring", "explorerFunctionSettings"]:
        assert f'id="{removed}"' not in html
    # Operations stays hidden until its module is loaded.
    assert 'data-view="operations" aria-selected="false" hidden>' in html
    # One nav row: the view tabs, then the Catalog modes (a segmented control)
    # and the way up on its right; under it one tree, the card and the graph.
    top = html[html.index('id="explorerTopBar"'):html.index('id="explorerError"')]
    assert [top.index(f'id="{name}"') for name in ["explorerViewTabs", "explorerModeBar", "explorerScopeUp", "explorerModeTabs"]] == sorted(
        top.index(f'id="{name}"') for name in ["explorerViewTabs", "explorerModeBar", "explorerScopeUp", "explorerModeTabs"])
    assert 'id="explorerModeTabs" class="segmented explorerModeTabs" role="group" aria-label="Catalog mode"' in top
    catalog = html[html.index('id="explorerListView"'):html.index('id="explorerFunctionsPane"')]
    order = ["explorerListPane", "explorerCatalogMain", "explorerCatalogView", "explorerGraphPane"]
    assert [catalog.index(f'id="{name}"') for name in order] == sorted(catalog.index(f'id="{name}"') for name in order)
    for mode, pane in [("browse", "explorerCatalogView"), ("graph", "explorerGraphPane")]:
        assert f'data-mode="{mode}"' in top and f'aria-controls="{pane}"' in top
    # The former Storage mode: no button, no pane, no wiring left.
    assert 'data-mode="storage"' not in html and "explorerSystemPane" not in html
    assert "explorerSystemPane" not in ui and "renderSystemView" not in ui
    assert 'id="explorerScopeUp" class="explorerScopeUp" type="button" hidden>' in top
    for container in ["explorerFunctionsPane", "explorerOpsPane"]:
        assert f'id="{container}"' in html
    assert 'const MODES = ["browse", "graph"];' in ui
    assert 'const VIEWS = ["catalog", "functions", "operations"];' in ui
    # The tree selection is the scope of every mode.
    assert "function selectionScope() {" in ui
    assert "graph?.focusTable?.(scope.database, scope.table, { ensureVisible: true });" in ui
    assert "graph?.focusDatabase?.(scope.database);" in ui
    # The database card has the tabs Objects | Storage; a table of its map
    # opens on its own Storage tab.
    assert 'const DATABASE_TABS = ["Objects", "Storage"];' in ui
    assert "model.databaseStorage = storageView.renderDatabase(container, {" in ui
    assert 'model.tab = "Storage";' in ui
    assert "onIncludeSystemChange" not in ui and "renderBreadcrumb" not in ui
    # Operations: module hook kept, the view hidden while the module is not loaded.
    assert 'ns.explorerOps.show(dom.explorerOpsPane, { onOpenTable: (database, table) => openCard(database, table) });' in ui
    assert 'const available = { catalog: true, functions: true, operations: operationsAvailable() };' in ui
    assert 'return !!ns.explorerOps && f.enabled && f.operations.enabled;' in ui
    assert 'const OPERATIONS_ROUTE_SEGMENT = "_operations";' in ui
    assert 'init, setWorkspace, setSection, setMode, setView, currentView,' in ui and "storageScope" not in ui


def test_operations_view_is_hidden_by_not_loading_its_module() -> None:
    manifest = json.loads(read("src/static/modules.json"))
    explorer_css = css_sources.sheets()["style.explorer.css"]
    assert "app_explorer_ops.js" not in manifest["pages"]["explorer"]["modules"]
    assert any('To bring it back, add \"app_explorer_ops.js\" to pages.explorer.modules' in line for line in manifest["//"])
    # Its rules are not shipped to the Explorer page while it is hidden.
    assert ".explorerOpsTile" not in explorer_css


def test_catalog_urls_use_one_scheme_and_keep_the_old_ones_as_aliases() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function catalogPath({ database = \"\", table = \"\", tab = DEFAULT_TAB, databaseTab = DEFAULT_DATABASE_TAB, mode = \"browse\", graphRoute = null } = {}) {" in ui
    assert 'if (mode !== "browse") params.set("mode", mode);' in ui
    # A database card names its tab too (Objects, the default, has none).
    assert 'if (mode === "browse" && database && !table && databaseTab && databaseTab !== DEFAULT_DATABASE_TAB) params.set("tab", String(databaseTab).toLowerCase());' in ui
    # ?view=graph, the card-tab paths, and the former Storage mode and view
    # (?mode=storage, /_system?database=&table=) are aliases: the latter open
    # the card's Storage tab, or the databases overview at the root.
    assert '(params.get("view") === "graph" ? "graph" : "browse")' in ui
    assert 'const storageAlias = modeParam === "storage";' in ui
    assert 'return { ...catalog, mode: "browse", database, table: database ? params.get("table") || "" : "", tab: "Storage", databaseTab: "Storage" };' in ui
    assert '["overview", "Columns"], ["schema", "Columns"], ["data", "Preview"],' in ui
    assert 'router.replace(null, { href: canonical, view: "explorer" });' in ui


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
    css = css_sources.text()
    tree = ui[ui.index("function renderTableList"):ui.index("function catalogContainsTable")]
    # Sizes are plain figures (no bar), names are cut in the middle with a title.
    assert 'button.appendChild(h("span", { class: "explorerTreeObject__size" }, badge.text));' in tree
    assert "--bar-pct" not in tree
    assert 'middleText("explorerTreeObject__name", table.name, query)' in tree
    assert 'middleText("explorerTreeDatabase__name", database, query)' in tree
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
    # The Catalog modes sit in the one nav row: the drawer opens right under it (--shell-top).
    assert "--side-drawer-top" not in css_sources.decls("#explorerListView", "@media (max-width: 820px)")
    assert "--explorer-mode-bar-height" not in css
    # The header wraps on a phone through the one unscoped rule every shell shares.
    assert css_sources.decls(".appHeader", "@media (max-width: 820px)")["flex-wrap"] == "wrap"
    assert 'body[data-page="explorer"] .appHeader' not in css
    assert 'body[data-page="observability"] .appHeader' not in css


def test_shared_bar_and_typography_tokens() -> None:
    css = css_sources.text()
    tokens = css_sources.tokens()
    for token in ["--explorer-table-font: var(--fs-md);", "--explorer-section-title-weight: var(--fw-semibold);"]:
        assert token in tokens
    # Monospace comes from the one global --font-mono token.
    assert "--explorer-mono" not in css and '--font-mono: "IBM Plex Mono", ui-monospace' in css
    # The tree keeps no bar of its own; in-table bars are the shared .cellBar
    # (app_ui_table.js).
    assert ".explorerBar" not in css
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
