from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_view_tabs_and_containers_replace_the_section_dropdown() -> None:
    html = read("src/static/explorer.html")
    ui = read("src/static/app_explorer.js")
    assert 'id="explorerViewTabs" class="explorerViewTabs" role="tablist"' in html
    for tab, view in [("explorerCatalogTab", "catalog"), ("explorerGraphTab", "graph"), ("explorerStorageTab", "storage"),
                      ("explorerFunctionsTab", "functions"), ("explorerOpsTab", "operations")]:
        assert f'id="{tab}"' in html and f'data-view="{view}"' in html
    # Operations stays hidden until its module is loaded.
    assert 'data-view="operations" aria-selected="false" hidden>' in html
    for container in ["explorerCatalogView", "explorerGraphPane", "explorerSystemPane", "explorerFunctionsPane", "explorerOpsPane"]:
        assert f'id="{container}"' in html
    for removed in ["explorerSectionSelect", "explorerTableModeTabs", "explorerTableSettingsButton", "explorerIncludeNonStoring"]:
        assert f'id="{removed}"' not in html
    assert 'id="explorerBreadcrumb" class="explorerBreadcrumb"' in html
    # Hooks for the Storage and Operations modules.
    assert 'storageView.show(dom.explorerSystemPane, {' in ui
    assert 'onIncludeSystemChange: (value) => {' in ui and 'onScopeChange: (scope) => {' in ui
    assert 'ns.explorerOps.show(dom.explorerOpsPane, { onOpenTable: (database, table) => openStorageRoute(database, table) });' in ui
    assert 'operations: operationsAvailable(),' in ui
    assert 'return !!ns.explorerOps && f.enabled !== false && f.operations?.enabled !== false;' in ui
    assert 'if (previous === "system" && !system) ns.explorerStorage?.hide?.();' in ui
    assert 'const OPERATIONS_ROUTE_SEGMENT = "_operations";' in ui
    assert 'init, setWorkspace, setSection, setMode, setView, currentView, storageScope,' in ui


def test_one_number_format_is_shared_with_every_explorer_module() -> None:
    ui = read("src/static/app_explorer.js")
    util = read("src/static/app_util.js")
    head = ui[ui.index("function fmtInt"):ui.index("function quoteIdent")]
    assert 'return Math.trunc(n).toLocaleString("en-US");' in head
    # util.formatBytes is the single byte format of the app; the Explorer helper
    # only maps a missing value to the dash.
    assert 'return `${sign}${v.toFixed(1)} ${BYTE_UNITS[unit]}`;' in util
    assert 'if (v < 1024) return `${sign}${Math.round(v)} B`;' in util
    assert 'if (n == null) return MISSING;\n    return util.formatBytes(n);' in head
    assert 'ns.explorerFormat = { MISSING, fmtInt, fmtBytes, fmtStorageBytes, fmtCompactInt, fmtRate, fmtPercent };' in head
    assert 'const MISSING = "\\u2014";' in ui
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
    assert '.explorerShell.is-tree-open > .explorerGrid > .explorerListPane' in css
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
    assert ".resultTable tbody td.explorerBar--cell" in block


def test_database_objects_table_fits_and_formats_numbers() -> None:
    ui = read("src/static/app_explorer.js")
    assert 'const DATABASE_OBJECT_COLUMNS = ["Name", "Engine", "Rows", "Size", "Compressed", "Ratio", "% database", "Parts", "Modified"];' in ui
    block = ui[ui.index("function renderDatabaseObjects"):ui.index("function selectDatabase(")]
    assert 'setBar(td, value, maxima[ctx.columnIndex], fmtInt(value));' in block
    assert 'td.classList.add("explorerBar", "explorerBar--cell");' in block
    assert "resultTable__gaugeCell" not in block
    assert '`${fmtBytes(item.uncompressed)} uncompressed / ${fmtBytes(item.compressed)} compressed`' in block


def test_nav_spec_runs_in_the_frontend_phase() -> None:
    runner = read("tests/test-suite/run-all-tests.py")
    assert "'specs/explorer-nav.spec.js'" in runner
    spec = read("tests/frontend/specs/explorer-nav.spec.js")
    assert "viewport: { width: 390, height: 844 }" in spec
    assert "for (const theme of ['dark', 'light'])" in spec
