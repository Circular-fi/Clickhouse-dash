from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_massive_export_uses_two_phase_one_time_capability() -> None:
    server = read("src/server.cpp")
    api = read("src/api_export.cpp")
    store = read("src/export_job.cpp")
    jwt = read("src/jwt.cpp")

    assert 'Post("/api/export/run"' in server
    assert 'Get("/api/export/stream"' in server
    assert "authenticate_request" not in api
    assert "jwt_.sign_export_token(claims)" in api
    assert "jwt_.verify_export_token(token" in api
    assert "export_jobs_->consume(" in api
    assert "jobs_.erase(it)" in store
    assert 'payload.AddMember("purpose", "export", pa)' in jwt


def test_massive_export_is_streaming_zip64_store_without_result_spooling() -> None:
    zip_cpp = read("src/zip_stream.cpp")
    serializer = read("src/export_serializer.cpp")
    api = read("src/api_export.cpp")

    assert "kZip64End" in zip_cpp
    assert "kZip64Locator" in zip_cpp
    assert "write_u64(entry.size)" in zip_cpp
    assert "constexpr uint16_t kStore = 0" in zip_cpp
    assert "set_chunked_content_provider" in api
    assert "std::make_unique<ExportSerializer>" in api
    assert "output_buffer_bytes" in api
    assert "ofstream" not in api.lower()
    assert "tmpfile" not in api.lower()
    assert "mkstemp" not in api.lower()
    assert "buffer_limit_" in serializer


def test_massive_export_cancels_native_query_when_http_sink_closes() -> None:
    api = read("src/api_export.cpp")
    docs = read("docs/massive-export.md")

    assert "query.OnDataCancelable" in api
    assert "return false;" in api
    assert "sink.is_writable" in api
    assert "cancel_export_best_effort(host_copy, query_id)" in api
    assert 'res.set_header("Accept-Ranges", "none")' in api
    assert "No resume" in docs


def test_massive_export_preserves_multiquery_error_archive_contract() -> None:
    api = read("src/api_export.cpp")

    assert 'prefix + "query.sql"' in api
    assert 'prefix + "execution.csv"' in api
    assert 'prefix + "error.txt"' in api
    assert "stop_after_error = true" in api
    assert "zip.finish_archive()" in api
    assert '"results.csv" : "results.json"' in api


def test_massive_export_metadata_is_required_before_download_and_during_archive() -> None:
    api = read("src/api_export.cpp")

    # The JSON handshake must fail while the page can still display an error.
    assert "preflight_export_metadata(" in api
    assert '"export_metadata_unavailable"' in api
    first_preflight = api.index("preflight_export_metadata(", api.index("void Server::handle_export_run"))
    queue_put = api.index("export_jobs_->put(job", api.index("void Server::handle_export_run"))
    assert first_preflight < queue_put

    # The one-time stream revalidates before attachment headers/body commit.
    stream = api[api.index("void Server::handle_export_stream"):]
    assert stream.index("preflight_export_metadata(") < stream.index('res.set_header(\n      "Content-Disposition"')
    assert 'system->Execute("SYSTEM FLUSH LOGS query_log")' in api

    # A post-query metadata lookup failure can never be serialized as a
    # successful execution row and must leave an explicit archive error.
    assert "const bool metadata_failed = !stats.available;" in api
    assert 'metadata_failed ? "export_error" : "finished"' in api
    assert 'terminal_error += "Export metadata failure: " + metadata_error;' in api
    assert "if (query_failed || metadata_failed)" in api


def test_run_menu_direct_download_does_not_use_interactive_run_path() -> None:
    html = read("src/static/index.html")
    frontend = read("src/static/app_export.js")
    api = read("src/static/app_api.js")
    run = read("src/static/app_run.js")

    assert 'id="downloadCsvButton"' in html
    assert 'id="downloadJsonButton"' in html
    assert 'postJson("api/export/run"' in api
    assert "api.prepareExport" in frontend
    assert "triggerDownload(prepared.downloadUrl" in frontend
    assert "api.runSql" not in frontend
    assert "massExport.start" not in run


def test_export_hcl_limits_are_validated_and_v1_compression_is_rejected() -> None:
    config = read("src/config.cpp")
    example = read("config.example.hcl")

    for field in ("token_ttl_ms", "pending_max_entries", "pending_sql_max_bytes", "max_queries"):
        assert field in config
        assert field in example
    assert "export.compression=true is not supported" in config


def test_massive_export_allows_runner_commands_and_returns_stable_ok_result() -> None:
    api = read("src/api_export.cpp")
    docs = read("docs/massive-export.md")

    assert "make_export_client(host_copy.runner_uri" in api
    assert "client->Execute(query);" in api
    assert "client->Select(query);" not in api
    assert "query.OnDataCancelable" in api
    assert "command_result_payload" in api
    assert r'return "status\nOK\n";' in api
    assert "system_uri" in api
    assert "collect_query_execution" in api
    assert "synthetic result" in docs
