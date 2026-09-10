from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_query_error_hides_results_table_surface() -> None:
    results = read("src/static/app_results.js")
    functional = read("tests/frontend/specs/functional.spec.js")
    assert "dom.liveResultsWrap.hidden = true;" in results
    assert "dom.liveResultsWrap.hidden = false;" in results
    assert "local.wrap.hidden = true;" in results
    assert "local.wrap.hidden = false;" in results
    assert "#liveResultsWrap" in functional and "toBeHidden()" in functional


def test_trace_fold_updates_existing_dom_instead_of_repainting_all_rows() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    render = viewer[viewer.index("function render("):]
    assert "const rowByKey = new Map();" in render
    assert "const syncSubtree = (span) =>" in render
    assert "row.hidden = rowHidden(child);" in render
    assert "toggle.setAttribute(\"aria-expanded\"" in render
    toggle_start = render.index('toggle.addEventListener(\"click\"')
    toggle = render[toggle_start:render.index("name.appendChild", toggle_start)]
    assert "paint()" not in toggle
    assert "replaceChildren" not in toggle
    assert "addTicks(timeline, model.window, false)" not in viewer


def test_analysis_has_no_tabs_and_uses_nearly_full_viewport() -> None:
    html = read("src/static/query.html")
    analysis = read("src/static/app_analysis.js")
    css = read("src/static/style.css")
    assert "analysisTabs" not in html
    assert "data-analysis-tab" not in html
    assert "activeTab" not in analysis
    assert 'width: min(1800px, calc(100vw - 12px));' in css
    assert 'height: calc(100vh - 12px);' in css
    assert '.analysisModal__content { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 6px 8px 8px; }' in css


def test_trace_is_full_width_without_horizontal_scroll_and_keeps_resizable_split() -> None:
    css = read("src/static/style.css")
    viewer = read("src/static/app_trace_viewer.js")
    block = css[css.index(".traceViewer__table"):css.index(".traceViewer__head {", css.index(".traceViewer__table"))]
    assert "width: 100%;" in block
    assert "overflow-x: hidden;" in block
    grid = css[css.index(".traceViewer__head,\n.traceViewer__row"):css.index(".traceViewer__head {", css.index(".traceViewer__head,\n.traceViewer__row"))]
    assert "minmax(0, var(--trace-name-column" in grid
    assert "minmax(0, 1fr)" in grid
    assert 'className = "traceViewer__columnResize"' in viewer
    assert "Math.max(180" in viewer


def test_graph_refresh_discards_stale_scope_and_replays_latest_request() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "refreshSerial: 0" in graph
    assert "refreshQueued: false" in graph
    assert "const serial = ++model.refreshSerial;" in graph
    assert "serial !== model.refreshSerial" in graph
    assert "requestDatabase" in graph
    assert "model.refreshQueued = true;" in graph
    assert "queueMicrotask(() => refresh(queuedForce, { reflow: queuedReflow }));" in graph


def test_legacy_schema_route_is_canonicalized_to_overview() -> None:
    explorer = read("src/static/app_explorer.js")
    functional = read("tests/frontend/specs/functional.spec.js")
    assert 'const legacySchema = requestedTab === "schema";' in explorer
    assert 'const tab = legacySchema ? "Overview"' in explorer
    assert "route.legacySchema && route.database && route.table" in explorer
    assert '/weather_observations/schema' in functional
    assert '/weather_observations\\/overview' in functional


def test_weather_fixture_stresses_merge_tree_storage_and_schema_features() -> None:
    sql = read("tests/clickhouse-init/02-frontend-fixtures.sql")
    config = read("tests/clickhouse-config/fixture-storage.xml")
    compose = read("tests/docker-compose.yml")
    assert sql.count("FROM numbers(40000)") == 3
    assert "min_rows_for_wide_part = 0" in sql
    assert "min_bytes_for_wide_part = 0" in sql
    assert "INDEX idx_temperature temperature_c TYPE minmax" in sql
    assert "INDEX idx_random_token random_token TYPE minmax" in sql
    assert "INDEX idx_city city TYPE set" in sql
    assert sql.count("PROJECTION ") >= 3
    assert "diagnostics Tuple(samples Array(Float32), flags Array(String))" in sql
    assert "RECOMPRESS CODEC(ZSTD(3))" in sql
    assert "TO VOLUME 'warm'" in sql
    assert "INTERVAL 365 DAY DELETE" in sql
    assert "fixture_tiered" in config and "<hot>" in config and "<warm>" in config
    assert "<disk>fixture_hot</disk>" in config and "<disk>fixture_warm</disk>" in config
    assert "source: ./clickhouse-config/fixture-storage.xml" in compose
    assert "target: /etc/clickhouse-server/config.d/fixture-storage.xml" in compose


def test_weather_fixture_contains_buffer_fanout_and_buffer_chain() -> None:
    sql = read("tests/clickhouse-init/02-frontend-fixtures.sql")
    assert "ENGINE = Buffer(chdash_ui, weather_observations" in sql
    assert "CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_city_mv" in sql
    assert "TO chdash_ui.weather_city_ingest_target" in sql
    assert "CREATE MATERIALIZED VIEW chdash_ui.weather_buffer_alert_mv" in sql
    assert "TO chdash_ui.weather_alert_buffer" in sql
    assert "ENGINE = Buffer(chdash_ui, weather_alert_target" in sql


def test_non_merge_tree_counts_and_graph_labels_are_engine_specific() -> None:
    catalog = read("src/explorer_catalog.cpp")
    graph_cpp = read("src/explorer_graph.cpp")
    graph_js = read("src/static/app_explorer_graph.js")
    assert "system.dictionaries" in catalog and "element_count" in catalog
    assert 'target->engine == "TinyLog"' in catalog
    assert 'target->engine == "Log"' in catalog and 'target->engine == "StripeLog"' in catalog
    assert 'if (engine == "TinyLog") return "tinylog";' in graph_cpp
    assert 'if (engine == "StripeLog") return "stripelog";' in graph_cpp
    assert 'tinylog: "Tiny Log"' in graph_js
    assert 'stripelog: "Stripe Log"' in graph_js

def test_graph_sidebar_missing_target_forces_fresh_graph_and_mode_trigger_is_single_bound() -> None:
    graph = read("src/static/app_explorer_graph.js")
    explorer = read("src/static/app_explorer.js")
    assert 'if (!exists) {' in graph
    assert 'if (model.active) refresh(true);' in graph
    needle = 'dom.explorerModeSelectButton?.addEventListener("click"'
    assert explorer.count(needle) == 1

