from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_remaining_review_regressions_are_locked() -> None:
    json_cpp = read("src/json_clickhouse.hpp")
    autocomplete = read("src/static/app_autocomplete.js")
    functional = read("tests/frontend/specs/functional.spec.js")
    design = read("tests/frontend/specs/design.spec.js")
    analysis = read("src/static/app_analysis.js")

    assert 'starts_with_ci(declared_type, "bool")' in json_cpp
    assert 'w.Bool(col->GetItem(row).get<uint8_t>() != 0)' in json_cpp
    assert 'const contentLeft = Math.max(0, padLeft);' in autocomplete
    assert "#explorerFunctionSearchInput" in functional
    assert "#explorerDetailContent .resultTable tbody tr" in design
    assert 'document.createElement("h3")' not in analysis


def test_create_view_formatting_regressions_have_fixtures() -> None:
    formatter = read("src/format_postprocess.cpp")
    view_in = read("tests/api/format/input/084_create_view_explicit_columns.sql")
    view_out = read("tests/api/format/output/084_create_view_explicit_columns.sql")
    mv_out = read("tests/api/format/output/085_create_materialized_view_explicit_columns.sql")

    assert "CREATE VIEW chdash_ui.mild_weather_observations" in view_in
    assert "format_create_view_head_clauses" in formatter
    assert "split_top_level(cols, ',')" in formatter
    assert "\n(\n" in view_out
    assert "`temperature_c`" in view_out and "Float64" in view_out
    assert "CREATE MATERIALIZED VIEW" in mv_out
    assert "ENGINE = SummingMergeTree" in mv_out


def test_autocomplete_surfaces_types_without_enter_stealing_newline() -> None:
    source = read("src/static/app_autocomplete.js")
    assert "let selectionArmed = false" in source
    assert "let armNextRender = false" in source
    assert "selectionArmed = armNextRender" in source
    assert "addFunctions();\n      addDataTypes();\n      addKeywords();" in source
    assert 'if (ev.key === "Enter")' in source
    assert "if (!selectionArmed)" in source
    assert "close();\n          return;" in source
    assert 'if (ev.key === "Tab")' in source


def test_page_and_run_settings_use_connected_dropdowns() -> None:
    html = read("src/static/index.html")
    ui = read("src/static/app_ui.js")
    dom = read("src/static/app_dom.js")

    assert html.index('id="hostPicker"') < html.index('id="pageSelect"') < html.index('id="themeSelect"')
    assert 'id="pageSelect" class="themeSelect pageSelect"' in html
    assert 'id="runSettings" class="themeSelect runSettings"' in html
    assert html.index('id="queryLibrary"') < html.index('id="runSettings"')
    run_menu = html[html.index('id="runMenu"'):html.index('id="queryLibrary"')]
    assert 'id="runOptAutoFormat"' not in run_menu
    assert 'id="runOptMultiQuery"' not in run_menu
    assert 'id="downloadDebugButton"' in run_menu
    assert "togglePageMenu" in ui and "toggleRunSettings" in ui
    assert 'pageSelect: byId("pageSelect")' in dom
    assert 'class="runSettings__button"' in html
    assert 'editorAutocompleteControl__gear' in html


def test_explorer_features_are_configurable_and_server_enforced() -> None:
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    server = read("src/server.cpp")
    explorer = read("src/static/app_explorer.js")
    example = read("config.example.hcl")

    assert "bool browse = true" in header
    assert "bool lineage = true" in header
    assert "bool storage_topology = true" in header
    assert "bool graph_enabled() const { return lineage || storage_topology; }" in header
    assert "bool enabled() const { return browse || graph_enabled(); }" in header
    assert 'validate_object(*explorer, "explorer", {"browse"' in config
    assert 'optional_block(*explorer, "graph", "explorer")' in config
    assert 'validate_object(*graph, "explorer.graph", {"lineage", "storage_topology"}, {})' in config
    for legacy in ['"graph_enabled"', '"lineage_enabled"', '"storage_topology_enabled"']:
        assert legacy not in config
    assert "if (cfg_.explorer.enabled())" in server
    assert "if (cfg_.explorer.graph_enabled())" in server
    assert 'w.Key("browse"); w.Bool(cfg_.explorer.browse);' in server
    assert 'w.Key("lineage"); w.Bool(cfg_.explorer.lineage);' in server
    assert 'w.Key("storage_topology"); w.Bool(cfg_.explorer.storage_topology);' in server
    api_explorer = read("src/api_explorer.cpp")
    assert '(node.layer == "logical" && cfg_.explorer.lineage)' in api_explorer
    assert '(node.layer == "physical" && cfg_.explorer.storage_topology)' in api_explorer
    assert "browse = true" in example
    assert "graph {" in example
    assert "lineage" in example and "storage_topology" in example
    assert "explicitTypeChoice = modes.length > 1" in explorer
    assert "dom.explorerTableModeTabs.hidden = !(browseEnabled && graphEnabled)" in explorer
    assert 'if (!browseEnabled && graphEnabled && model.mode !== "graph") setMode("graph")' in explorer


def test_run_menu_owns_debug_archive_and_results_copy_menu_does_not() -> None:
    html = read("src/static/index.html")
    run = read("src/static/app_run.js")
    download = read("src/static/app_download.js")
    results = read("src/static/app_results.js")

    assert html.count("Download Debug") == 1
    copy_menu = html[html.index('id="copyMenu"'):html.index('id="copyJsonToast"')]
    assert "Download Debug" not in copy_menu
    assert 'id="downloadReceivedZipButton"' not in copy_menu
    assert 'handleDownloadRun("json")' in run
    assert 'handleDownloadRun("csv")' in run
    assert 'handleDownloadRun("debug")' in run
    assert 'dom.downloadCsvButton.hidden = editorIsMulti' in run
    assert 'state.suppressResultsVisibility = !!downloadKind' in run
    assert 'if (visible && state.suppressResultsVisibility)' in results
    assert 'results.setResultsVisible(false);' in run
    assert 'downloadRunFailed = true' in run
    assert 'if (downloadKind === "debug") await performRequestedDownload(downloadKind);' in run
    assert 'results.setResultsVisible(true);' in run
    archive = download[download.index('async function buildArchiveFiles()'):download.index('function updateUi()', download.index('async function buildArchiveFiles()'))]
    assert 'results.json' not in archive
    assert 'results.csv' in archive
    assert 'executionFiles(execution, prefix)' in archive
    assert 'profilingFiles(entry, prefix)' in archive
    assert 'tables/manifest.csv' in download
    assert 'downloadDebug' in download


def test_query_visual_metrics_keep_production_geometry() -> None:
    css = read("src/static/style.css")
    run = read("src/static/app_run.js")
    assert "--radius: 0.95rem" in css
    assert "--radiusSm: 0.8rem" in css
    assert "scrollbar-gutter: stable" in css
    assert "height: 4.5rem" in css
    assert "font-weight: 950" in css
    assert "font-weight: 850" in css
    assert "util.setMetricText(dom.elapsedSecondsText" in run
