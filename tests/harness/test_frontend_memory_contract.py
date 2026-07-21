from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_columns_are_not_part_of_the_eager_catalog() -> None:
    source = read("src/static/app_meta.js")
    catalog_block = source.split("const catalogTypes = [", 1)[1].split("];", 1)[0]
    assert '"columns"' not in catalog_block
    assert "ensureTableColumns" in source
    assert 'storage.removeMeta(normalizedHostId, "columns")' in source


def test_metadata_and_history_caches_are_bounded() -> None:
    metadata = read("src/static/app_meta.js")
    state = read("src/static/app_state.js")
    assert "const maxCachedHosts = 2;" in metadata
    assert "const maxColumnTablesPerHost = 32;" in metadata
    assert "const maxColumnsPerHost = 10000;" in metadata
    assert "const HISTORY_MAX_ENTRIES = 50;" in state
    assert "const HISTORY_MAX_BYTES = 2 * 1024 * 1024;" in state
    assert "const HISTORY_MAX_SQL_BYTES = 256 * 1024;" in state


def test_idle_startup_does_not_activate_or_hydrate_catalogs() -> None:
    metadata = read("src/static/app_meta.js")
    ui = read("src/static/app_ui.js")
    prepare_body = metadata.split("function prepareHost(hostId)", 1)[1].split("function activateHost", 1)[0]
    assert "hydrateFromStorage" not in prepare_body
    assert "fetchAndStore" not in prepare_body
    assert "ns.meta.prepareHost(state.selectedHostId)" in ui
    assert 'dom.queryTextArea.addEventListener("focus"' in ui
    assert "ns.meta.maybeRefreshOnUserAction()" in ui


def test_chart_backing_stores_are_bounded_and_released_when_hidden() -> None:
    run_ui = read("src/static/app_run.js")
    assert "Math.min(2, Math.max(1, Number(window.devicePixelRatio) || 1))" in run_ui
    assert "function releaseChartBuffers()" in run_ui
    assert 'document.addEventListener("visibilitychange"' in run_ui
    assert "canvas.width = 1;" in run_ui
    assert "canvas.height = 1;" in run_ui
