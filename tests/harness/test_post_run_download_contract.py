from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_execution_endpoint_uses_registered_query_and_runner_acl() -> None:
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    api = read("src/api_query_execution.cpp")
    collector = read("src/query_execution.cpp")

    assert 'Get("/api/query/execution"' in server
    assert "handle_query_execution" in header
    assert "authenticate_request" not in api
    # The MCP identity of a host reads the records of the host (ARCH-B-069).
    assert "query_registry_->find(query_id, std::string(mcp_base_host(host_id)))" in api
    # The runner ACL of the host identity, kept by the AclService.
    assert "acl_.table_set(runner_access(*host))" in api
    assert "collect_query_execution" in api
    assert "system.query_log" in collector
    assert "system.processors_profile_log" not in collector
    assert "system.query_views_log" not in collector


def test_post_run_archive_is_built_in_browser_from_received_results() -> None:
    download = read("src/static/app_download.js")
    run = read("src/static/app_run.js")
    results = read("src/static/app_results.js")

    assert "function buildStoreZip(files)" in download
    assert "compression" not in download.lower() or "STORE" in read("docs/post-run-download.md")
    assert "new Blob([...localParts, ...centralParts, end]" in download
    assert "rowsToCsv(entry.snapshot)" in download
    assert "download.recordQuery" in run
    assert "getSnapshot: getSnapshotLocal" in results
    assert "getSnapshot," in results
    assert "results.csv" in download
    assert "query.sql" in download
    assert "execution.csv" in download


def test_multiquery_global_copy_is_json_only_and_indexed() -> None:
    download = read("src/static/app_download.js")
    results = read("src/static/app_results.js")
    run = read("src/static/app_run.js")

    assert 'const queriesText = sortedQueries().map' in download and '"queries": [' in download
    assert 'field("index", JSON.stringify(Number(entry.index ?? position) + 1))' in download
    assert 'field("query", JSON.stringify(String(entry.sql || "")))' in download
    # Every JSON and CSV output of a result has one serializer (ns.results.serialize): Copy JSON and
    # Download JSON hold the same text, Copy CSV and Download CSV too.
    assert 'field("data", data)' in download and "results.serialize.json(snapshot, indent)" in download
    assert "return results.serialize.csv(snapshot);" in download
    assert "return resultJsonText(resultColumns, resultTypeAsts, allResultRows);" in results
    assert "return resultCsvText(resultColumns, resultTypeAsts, allResultRows);" in results
    assert 'state.lastRunMode === "batch"' in run
    assert 'download.buildGlobalJson()' in run
    assert 'if (dom.copyCsvButton) dom.copyCsvButton.hidden = multi;' in results


def test_partial_preview_is_never_presented_as_full_export() -> None:
    download = read("src/static/app_download.js")
    run = read("src/static/app_run.js")

    assert '"Download Debug (partial)"' in download
    assert '"Download Debug"' in download
    assert 'partial: !!done.result_truncated' in run
    assert 'String(st).toLowerCase() === "result_limit_reached"' in run


def test_execution_csv_uses_clickhouse_stats_and_does_not_fabricate_missing_values() -> None:
    download = read("src/static/app_download.js")
    collector = read("src/query_execution.cpp")

    assert "EXECUTION_COLUMNS" in download
    assert 'if (!payload || payload.available !== true) return header;' in download
    assert 'execution-error.txt' not in download
    assert 'throw new Error(`Export metadata failed for statement' in download
    assert 'toUInt64(written_rows)' in collector
    assert 'toUInt64(result_rows)' in collector
    assert 'toUInt64(peak_threads_usage)' in collector
