from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_panel_has_no_end_user_authentication_layer() -> None:
    server_h = read("src/server.hpp")
    server_cpp = read("src/server.cpp")
    config = read("src/config.cpp")
    api = read("src/static/app_api.js")

    assert "UserContext" not in server_h
    assert "authenticate_request" not in server_h
    assert "authenticate_request" not in server_cpp
    assert 'optional_block(root, "auth"' not in config
    assert "Authorization" not in api
    assert "bearerToken" not in api


def test_internal_cancel_capability_is_hs256_purpose_bound_and_expires() -> None:
    server = read("src/server.cpp")
    jwt = read("src/jwt.cpp")
    query_api = read("src/api_query.cpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")

    assert "jwt_(random_bytes(32))" in server
    assert 'std::string(header["alg"].GetString()) != "HS256"' in jwt
    assert 'payload.AddMember("purpose", "cancel", pa)' in jwt
    assert 'payload.AddMember("iat", c.issued_at_unix, pa)' in jwt
    assert 'payload.AddMember("exp", c.expires_at_unix, pa)' in jwt
    assert 'std::string((*payload)["purpose"].GetString()) != "cancel"' in jwt
    assert "verify_cancel_token(token, now_unix_sec())" in query_api
    assert "expires_at - issued_at > 48 * 60 * 60" in jwt
    assert "48 * 60 * 60 * 1000" in read("src/server.hpp")
    assert 'int_attr(*query, "cancel_token_ttl_ms", "query")' in config
    assert "std::min(48 * 60 * 60 * 1000, cfg.cancel_token_ttl_ms)" in config
    assert "cancel_token_ttl_ms = 172800000" in example


def test_query_registry_is_host_scoped_and_has_no_user_identity() -> None:
    header = read("src/query_registry.hpp")
    registry = read("src/query_registry.cpp")
    query_api = read("src/api_query.cpp")
    session = read("src/query_session.cpp")

    assert "std::string host_id;" in header
    assert "subject" not in header
    assert "token_fingerprint" not in header
    assert "prune_locked(now);" in registry
    assert "while (records_.size() > max_entries_) evict_oldest_locked();" in registry
    assert "it->second.host_id != host_id" in registry
    assert "query_registry_->register_query(qid, host_id, run_mode, registry_sql);" in query_api
    assert "registry->add_native_query_id(qid, native_query_id);" in query_api
    assert 'native_id += "-attempt-";' in session
    assert "native_query_id_observer_(native_id);" in session


def test_user_sql_execution_is_runner_only_and_system_is_technical_only() -> None:
    run = read("src/api_query.cpp")
    session = read("src/query_session.cpp")
    deep_api = read("src/api_analysis.cpp")
    deep = read("src/deep_analysis.cpp")
    export = read("src/api_export.cpp")

    # Interactive user SQL is stored in QuerySession with runner_uri; stats_uri is separate.
    assert "host->runner_uri," in run
    assert "stats_uri," in run
    assert "runner_uri_(std::move(runner_uri))" in session
    assert "client_query_->Execute(command);" in session
    assert "client_query_->Select(q);" in session

    # Deep Analyze replays retained SQL only through runner_uri.
    assert "run_deep_analysis(*record, host->runner_uri" in deep_api
    assert "const std::string& runner_uri" in deep
    assert "system_uri" not in deep

    # Massive export executes arbitrary panel SQL only with runner_uri.
    assert "make_export_client(host_copy.runner_uri" in export
    assert "client->Execute(query);" in export
    assert "client->Select(query);" not in export
    assert "query.OnDataCancelable" in export
    assert "make_export_client(system_uri" not in export

    # system/stats connections may issue only backend-built KILL/log/metadata work.
    cancellation = session[session.index("void QuerySession::cancel_native_query_ids_best_effort"):session.index("bool QuerySession::attach_stream")]
    assert 'std::string sql = "KILL QUERY WHERE query_id IN (";' in cancellation


def test_allowed_object_set_is_discovered_with_runner_not_system_grants() -> None:
    source = read("src/allowed_objects.cpp")
    header = read("src/allowed_objects.hpp")

    assert 'runner.Select("SHOW DATABASES"' in source
    assert 'runner.Select("SHOW TABLES FROM "' in source
    assert 'runner.Select("CHECK GRANT " + expression' in source
    assert 'check_grant(runner, "SELECT ON " + target)' in source
    assert "discover_columns_recursive" in source
    assert "DESCRIBE TABLE " in source
    assert "system.grants" not in source
    assert "SHOW GRANTS" not in source
    assert "system_uri" not in source
    assert "bool allows_column" in header


def test_interactive_result_cell_and_event_limits_are_32_mib_by_default() -> None:
    header = read("src/query_session.hpp")
    session = read("src/query_session.cpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")

    assert "max_result_cell_bytes = 32 * 1024 * 1024" in header
    assert "max_result_event_bytes = 32 * 1024 * 1024" in header
    assert "result_cell_too_large" in session
    assert "result_event_too_large" in session
    assert "cell_buffer.GetSize() > options_.max_result_cell_bytes" in session
    assert "chunk.size() > options_.max_result_event_bytes" in session
    assert 'int_attr(*query, "max_result_cell_bytes", "query")' in config
    assert 'int_attr(*query, "max_result_event_bytes", "query")' in config
    assert "max_result_cell_bytes  = 33554432" in example
    assert "max_result_event_bytes = 33554432" in example


def test_rapidjson_is_pinned_to_post_fix_commit_and_result_cells_avoid_innerhtml() -> None:
    cmake = read("src/CMakeLists.txt")
    results = read("src/static/app_results.js")

    assert "GIT_TAG        24b5e7a8b27f42fa16b96fc70aade9106cf7102f" in cmake
    assert "td.innerHTML = ns.highlight.toHtml(s);" not in results
    assert "td.textContent = s;" in results or "span.textContent = s;" in results
