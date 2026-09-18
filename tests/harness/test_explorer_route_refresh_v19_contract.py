from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")

def test_direct_route_loads_only_target_database_branch_then_retries_that_branch() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function catalogContainsTable(payload, database, table)" in ui
    refresh = ui[ui.index("async function refreshCatalog(force)"):ui.index("function summaryCard", ui.index("async function refreshCatalog(force)"))]
    assert "await loadDatabaseTables(route.database, !!force);" in refresh
    assert "await loadDatabaseTables(route.database, true);" in refresh
    assert 'api.getExplorerCatalog(hostId, "", true)' not in refresh

def test_popstate_route_resolves_target_database_without_global_catalog_refresh() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index('if (route.database && route.table && model.catalog)'):ui.index('} else if (route.database && model.catalog)', ui.index('if (route.database && route.table && model.catalog)'))]
    assert "await loadDatabaseTables(route.database, false);" in block
    assert "await loadDatabaseTables(route.database, true);" in block
    assert "refreshCatalog(true)" not in block
    assert block.index("await loadDatabaseTables(route.database, false);") < block.index("model.routeIntent = null;")
