from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_functions_explorer_is_runner_scoped_and_version_matched() -> None:
    server = read("src/server.cpp")
    api = read("src/api_explorer.cpp")
    catalog = read("src/explorer_catalog.cpp")

    assert 'http_.Get("/api/explorer/functions"' in server
    assert "handle_explorer_functions" in api
    assert "host->runner_uri" in api[api.index("handle_explorer_functions"):api.index("handle_explorer_table_data")]
    assert "system_uri" not in api[api.index("handle_explorer_functions"):api.index("handle_explorer_table_data")]
    assert "FROM system.documentation" in catalog
    assert "FROM system.functions" in catalog
    assert "arrayStringConcat(categories" not in catalog
    for field in ["arguments", "parameters", "returned_value", "examples", "introduced_in"]:
        assert f"toString({field})" in catalog
        assert f'w.Key("{field}")' in api
    assert "'Table Function'" in catalog
    assert "documentation_available" in api


def test_functions_frontend_has_search_filter_and_safe_text_rendering() -> None:
    html = read("src/static/explorer.html")
    js = read("src/static/app_explorer.js")
    api = read("src/static/app_api.js")

    assert 'id="explorerFunctionsSectionButton"' in html
    assert 'id="explorerFunctionCategorySelect"' in html
    assert 'id="explorerFunctionList"' in html
    assert "getExplorerFunctions" in api
    assert "refreshFunctions" in js
    assert "renderFunctionList" in js
    assert "renderSafeMarkdown" in js
    assert "document.createTextNode" in js
    assert "safeDocHref" in js
    assert 'value.startsWith("/") && !value.startsWith("//")' in js
    assert 'value.startsWith("./")' in js
    assert 'https://clickhouse.com/docs' in js
    assert 'model.functionsCatalog?.markdown_links_enabled !== true' in js
    assert 'http:' not in js[js.index("function safeDocHref"):js.index("function appendMarkdownInline")]
    assert "item.arguments" in js and "item.returned_value" in js and "item.examples" in js
    assert "innerHTML" not in js


def test_table_operational_metadata_includes_storage_compression_weight_and_distributed_queue() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")

    assert "storage_policy" in header
    assert "compressed_bytes" in header and "uncompressed_bytes" in header
    assert "relative_weight" in header
    assert "ExplorerDistributionQueueItem" in header
    assert "system.distribution_queue" in catalog
    assert 'w.Key("storage_policy")' in api
    assert 'w.Key("relative_weight")' in api
    assert 'w.Key("distribution_queue")' in api
    assert "Distribution queue" in ui
    assert "Storage policy" in ui


def test_manual_catalog_refresh_also_invalidates_function_metadata() -> None:
    api = read("src/api_explorer.cpp")
    catalog_handler = api[api.index("handle_explorer_catalog"):api.index("handle_explorer_table")]

    assert "explorer_allowed_cache_.erase" in catalog_handler
    assert "explorer_catalog_cache_.erase" in catalog_handler
    assert "explorer_graph_cache_.erase" in catalog_handler
    assert "explorer_functions_cache_.erase" in catalog_handler


def test_runner_identity_boundary_is_explicit_and_registry_sql_memory_is_capped() -> None:
    docs = read("docs/configuration.md") + read("docs/explorer.md")
    config = read("src/config.cpp")

    assert "same ClickHouse permissions" in docs or "runner permissions" in docs
    assert "no end-user" in docs.lower() or "no application-level user authentication" in docs.lower()
    assert "panel-supplied SQL" in docs and "system_uri" in docs
    assert "512 * 1024 * 1024" in config
    assert "registry_sql_max_bytes" in config


def test_production_frontend_has_no_fixture_specific_routing_or_focus_defaults() -> None:
    frontend = "\n".join(
        read(path)
        for path in [
            "src/static/app_explorer.js",
            "src/static/app_explorer_graph.js",
            "src/static/app_analysis.js",
            "src/static/app_run.js",
        ]
    )
    assert "chdash_ui" not in frontend


def test_query_telemetry_restores_right_rail_and_analysis_has_stable_geometry() -> None:
    css = read("src/static/style.css")
    html = read("src/static/index.html")
    assert "grid-template-columns: minmax(0, 1fr) 15rem;" in css
    assert ".metricColumn" in css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in css
    assert "#queryWorkspace.layout" not in css
    for canvas_id in ["readRowsChart", "readBytesChart", "writtenRowsChart", "writtenBytesChart", "cpuChart", "memoryChart"]:
        assert f'id="{canvas_id}"' in html
    assert 'id="clickhouseElapsedText"' in html
    assert "width: min(1800px, calc(100vw - 12px));" in css
    assert "height: calc(100vh - 12px);" in css
    assert "align-items: flex-start;" in css[css.index(".analysisModalBackdrop"):css.index(".analysisModalBackdrop[hidden]")]


def test_production_source_has_no_fixture_database_coupling() -> None:
    src_root = ROOT / "src"
    matches = []
    for path in src_root.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if "chdash_ui" in text:
            matches.append(str(path.relative_to(ROOT)))
    assert not matches, f"fixture database leaked into production source: {matches}"


def test_fixture_contains_real_dictionary_without_external_service() -> None:
    fixture = read("tests/clickhouse-init/02-frontend-fixtures.sql")
    routes = read("tests/backend-functional/test_routes.py")

    assert "CREATE DICTIONARY chdash_ui.station_dictionary" in fixture
    assert "SOURCE(CLICKHOUSE(" in fixture
    assert "USER 'chdash_runner'" in fixture
    assert "PASSWORD 'runner_test'" in fixture
    assert "station_dictionary" in routes
    assert 'get("engine") == "Dictionary"' in routes



def test_docker_review_runs_repository_contract_harness() -> None:
    orchestrator = read("tests/test-suite/run-all-tests.py")
    compose = read("tests/docker-compose.yml")

    assert "backend_env['TEST_REPOSITORY_ROOT'] = '/repo'" in orchestrator
    assert "'/repo/tests/harness'" in orchestrator
    assert "source: ..\n        target: /repo\n        read_only: true" in compose


def test_frontend_review_explicitly_covers_dictionary_fixture() -> None:
    functional = read("tests/frontend/specs/functional.spec.js")
    design = read("tests/frontend/specs/design.spec.js")

    assert "station_dictionary" in functional
    assert "toContainText(/Dictionary/i)" in functional
    assert "explorer-dictionary-overview" in design



def test_design_capture_fails_on_horizontal_page_overflow() -> None:
    review = read("tests/frontend/helpers/review.js")
    assert "if (audit.horizontalOverflow || audit.outsideViewport.length > 0)" in review
    assert "Design overflow in ${state}" in review


def test_fixture_reset_converges_users_and_validates_security_boundary_before_tests() -> None:
    users = read("tests/clickhouse-init/01-chdash-users.sql")
    orchestrator = read("tests/test-suite/run-all-tests.py")
    assert "ALTER USER chdash_runner IDENTIFIED WITH plaintext_password BY 'runner_test'" in users
    assert "ALTER USER chdash_system IDENTIFIED WITH plaintext_password BY 'system_test'" in users
    assert "REVOKE ALL ON *.* FROM chdash_runner" in users
    assert "REVOKE ALL ON *.* FROM chdash_system" in users
    assert 'check_grant_as(runner_user, runner_password, "KILL QUERY ON *.*", "0")' in orchestrator
    assert 'check_grant_as(system_user, system_password, "SYSTEM FLUSH LOGS ON *.*", "1")' in orchestrator
    assert orchestrator.index("reset_clickhouse_fixtures(base_env)") < orchestrator.index("run_phase(\n        'backend-functional'")


def test_clickhouse_text_decoder_handles_lowcardinality_metadata_without_empty_string_fallback() -> None:
    helper = read("src/ch_block_value.hpp")
    for source in [
        "src/explorer_catalog.cpp",
        "src/explorer_graph.cpp",
        "src/allowed_objects.cpp",
        "src/api_meta.cpp",
        "src/query_execution.cpp",
        "src/query_analysis.cpp",
    ]:
        assert '#include "ch_block_value.hpp"' in read(source)
    assert "clickhouse::Type::LowCardinality" in helper
    assert "values->GetItem(row)" in helper
    assert "item.get<std::string_view>()" in helper
    assert "throw std::out_of_range" in helper
    assert "throw std::runtime_error" in helper
    assert "catch (...)" not in helper
    assert "ch_block_text_at(block, column, row)" in read("src/explorer_catalog.cpp")
    assert "ch_block_text_at(block, column, row)" in read("src/explorer_graph.cpp")


def test_query_database_scope_never_fails_open_to_default_database() -> None:
    session = read("src/query_session.cpp")
    run_query = session[session.index("void QuerySession::run_query()"): ]
    assert 'if (!database_.empty()) client_query_->Execute("USE " + quote_ident(database_));' in run_query
    assert "apply_database_best_effort" not in run_query
    assert "auto apply_database =" in run_query
    apply = run_query[run_query.index("auto apply_database ="):run_query.index("auto execute_select_attempt")]
    assert "catch (...)" not in apply
    assert run_query.count("apply_database();") >= 2


def test_query_log_numeric_decoding_is_fail_closed_instead_of_zero_fallback() -> None:
    helper = read("src/ch_block_numeric.hpp")
    analysis = read("src/query_analysis.cpp")
    execution = read("src/query_execution.cpp")
    assert "throw std::out_of_range" in helper
    assert "Unexpected ClickHouse numeric column" in helper
    assert "return ch_block_u64_at(block, column, row);" in analysis
    assert "return ch_block_u64_at(block, column, row);" in execution
    assert "return 0;" not in helper
    assert "catch (...)" not in helper
    assert "Invalid processor parent id returned by ClickHouse" in analysis


def test_function_aliases_are_resolved_server_side_with_cycle_and_depth_guards() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")

    assert "ExplorerFunctionAliasDocument" in header
    assert "alias_documents" in header
    assert 'const std::string marker = "Alias of `";' in catalog
    assert "kMaxAliasDepth = 8" in catalog
    assert "visited.insert" in catalog
    assert "item.alias_documents.push_back" in catalog
    assert 'w.Key("alias_documents")' in api
    assert "model.functionsCatalog?.functions" not in ui[ui.index("const aliases = Array.isArray(item.alias_documents)"):ui.index("if (!dom.explorerFunctionDescription.childElementCount)")]
    assert "Alias documentation" in ui


def test_function_markdown_links_are_disabled_by_default_and_configurable() -> None:
    config = read("src/config.cpp")
    server = read("src/server.hpp")
    example = read("config.example.hcl")
    api = read("src/api_explorer.cpp")

    assert "bool function_markdown_links = false" in server
    assert 'bool_attr(*explorer, "function_markdown_links", "explorer")' in config
    assert "function_markdown_links = false" in example
    assert 'w.Key("markdown_links_enabled")' in api


def test_elapsed_restores_metric_card_and_system_is_small_terminal_footer() -> None:
    css = read("src/static/style.css")
    html = read("src/static/index.html")
    run = read("src/static/app_run.js")

    assert 'metricCompact metricCompact--elapsed' in html
    assert '<div class="metricCompact__label">Elapsed</div>' in html
    assert 'id="clickhouseElapsedWrap" class="metricCompact__systemLine" hidden' in html
    assert '.metricCompact__systemLine' in css
    assert 'justify-content: space-between' in css[css.find('.metricCompact__systemLine'):]
    assert "dom.clickhouseElapsedWrap.hidden = true" in run
    assert "dom.clickhouseElapsedWrap.hidden = false" in run
