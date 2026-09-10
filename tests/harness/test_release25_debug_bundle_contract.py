from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_debug_download_runs_with_profiling_and_keeps_normal_exports_normal() -> None:
    run = read("src/static/app_run.js")
    assert 'const mode = String(kind || "") === "debug" ? "profiling" : "normal";' in run
    assert 'return handleRunMode(mode, { downloadAfter: kind });' in run
    assert 'runMode === "profiling" && statements.length !== 1 && downloadKind !== "debug"' in run
    assert 'runMode === "profiling" && !downloadKind && out?.queryId' in run


def test_debug_bundle_is_csv_first_and_contains_full_profiling() -> None:
    download = read("src/static/app_download.js")
    assert 'name: `${prefix}results.csv`' in download
    assert '`${prefix}results.json`' not in download
    assert 'name: `${prefix}execution.csv`' in download
    assert 'name: `${prefix}profiling.json`' in download
    assert 'const analysis = await api.analyzeQuery' in download
    assert 'trace_spans' in read("src/api_analysis.cpp")


def test_debug_bundle_exports_recursive_table_definitions_and_manifest() -> None:
    download = read("src/static/app_download.js")
    assert 'async function tableDefinitionFiles(entry, prefix, executionPayload)' in download
    assert 'api.getExplorerTable(hostId, current.database, current.table)' in download
    assert 'relation === "upstream"' in download
    assert 'engine === "Buffer" && relation === "downstream"' in download
    assert 'tables/${safePathPart(current.database)}/${safePathPart(current.table)}.sql' in download
    assert 'name: `${prefix}tables/manifest.csv`' in download
    assert 'const maxDefinitions = 256;' in download


def test_copy_split_no_longer_contains_debug_download() -> None:
    for page in ("src/static/index.html", "src/static/query.html"):
        html = read(page)
        copy_menu = html[html.index('id="copyMenu"'):html.index('id="copyJsonToast"')]
        assert "Download Debug" not in copy_menu
        assert 'id="downloadReceivedZipButton"' not in copy_menu
        run_menu = html[html.index('id="runMenu"'):html.index('id="queryLibrary"')]
        assert 'id="downloadDebugButton"' in run_menu
