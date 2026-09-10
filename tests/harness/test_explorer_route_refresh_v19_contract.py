from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_direct_route_missing_from_cached_catalog_forces_one_fresh_acl_catalog_snapshot() -> None:
    ui = read("src/static/app_explorer.js")
    assert "function catalogContainsTable(payload, database, table)" in ui
    refresh = ui[ui.index("async function refreshCatalog(force)"):ui.index("function summaryCard", ui.index("async function refreshCatalog(force)"))]
    assert 'const routeNeedsFreshCatalog = !force' in refresh
    assert '!catalogContainsTable(payload, route.database, route.table)' in refresh
    assert 'payload = await api.getExplorerCatalog(hostId, "", true);' in refresh
    assert 'if (!exists) throw new Error(`Explorer route object is not visible: ${route.database}.${route.table}`);' in refresh


def test_popstate_route_preserves_intent_until_forced_catalog_refresh_completes() -> None:
    ui = read("src/static/app_explorer.js")
    block = ui[ui.index('if (route.database && route.table && model.catalog)'):ui.index('} else if (route.database && model.catalog)', ui.index('if (route.database && route.table && model.catalog)'))]
    assert 'if (!exists)' in block
    assert 'if (!model.loadingCatalog) await refreshCatalog(true);' in block
    assert 'return;' in block
    # Clearing the one-shot route must happen only after the object has been
    # resolved or after refreshCatalog has processed the route itself.
    assert block.index('if (!exists)') < block.index('model.routeIntent = null;')
