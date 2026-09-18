from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_explorer_routes_are_runner_scoped_and_separate_from_query_stream() -> None:
    server = read("src/server.cpp")
    api = read("src/api_explorer.cpp")

    assert 'http_.Get("/api/explorer/catalog"' in server
    assert 'http_.Get("/api/explorer/table"' in server
    assert 'http_.Post("/api/explorer/table/data"' in server
    assert "authenticate_request" not in api
    assert "handle_explorer_catalog" not in read("src/api_query_stream.cpp")


def test_explorer_cache_is_bound_to_host_runner_context() -> None:
    api = read("src/api_explorer.cpp")

    assert "std::string explorer_security_key(const std::string& host_id)" in api
    assert "return host_id;" in api
    assert "token_fingerprint" not in api
    assert "user.subject" not in api
    assert "explorer_allowed_cache_.get_or_refresh" in api
    assert "cfg_.explorer.cache_ttl_ms" in api


def test_system_metadata_is_filtered_by_allowed_object_set_before_output() -> None:
    catalog = read("src/explorer_catalog.cpp")

    assert "allowed.allows_table(database, table)" in catalog
    assert "allowed.allows_column(database, table, name)" in catalog
    assert "system.tables" in catalog
    assert "system.columns" in catalog
    assert "system.parts" in catalog
    assert "system.replicas" in catalog
    assert "system_uri" not in catalog


def test_dependencies_are_filtered_before_they_are_exposed() -> None:
    catalog = read("src/explorer_catalog.cpp")

    assert "dependencies_database" in catalog
    assert "dependencies_table" in catalog
    assert "append_dependency" in catalog
    assert "if (!allowed.allows_table(dep_db, dep_table)) return;" in catalog
    assert '"downstream"' in catalog and '"upstream"' in catalog


def test_data_preview_uses_runner_readable_columns_limit_and_no_count() -> None:
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")

    preview = catalog[catalog.index("bool load_explorer_preview"):]
    assert "allowed_columns_for_table" in preview
    assert 'sql += " FROM " + qualified_ident(database, table) + " LIMIT "' in preview
    assert "select count()" not in preview.lower()
    assert "load_explorer_preview(*runner" in api
    assert "host->runner_uri" in api


def test_frontend_has_real_list_workspace_and_graph_mode() -> None:
    html = read("src/static/explorer.html")
    explorer = read("src/static/app_explorer.js")

    assert 'id="navQueryButton"' in html
    assert 'id="navExplorerButton"' in html
    assert 'id="explorerWorkspace"' in html
    assert 'id="explorerGraphModeButton"' in html
    assert 'id="explorerGraphCanvas"' in html
    assert 'id="explorerGraphLogicalButton"' in html
    assert 'id="explorerGraphPhysicalButton"' in html
    assert "Graph view is implemented in the next lot" not in html
    assert 'setMode("graph")' in explorer
    assert "api.getExplorerCatalog" in explorer
    assert "api.getExplorerTable" in explorer
    assert "api.getExplorerTableData" in explorer
    assert "No accessible tables" in explorer


def test_manual_catalog_refresh_invalidates_acl_and_metadata_caches() -> None:
    api = read("src/api_explorer.cpp")
    frontend_api = read("src/static/app_api.js")
    explorer = read("src/static/app_explorer.js")
    cache = read("src/stale_cache.hpp")

    assert 'req.get_param_value("refresh") == "1"' in api
    assert "explorer_allowed_cache_.erase(security_key)" in api
    assert "explorer_catalog_cache_.erase(catalog_key)" in api
    assert "explorer_graph_cache_.erase(graph_key)" in api
    assert "void erase(const Key& key)" in cache
    assert 'query.set("refresh", "1")' in frontend_api
    assert 'api.getExplorerCatalog(hostId, "", !!force)' in explorer


def test_list_detail_exposes_storage_parts_topology_and_replication_without_cross_object_leak() -> None:
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    explorer = read("src/static/app_explorer.js")

    assert "FROM system.disks" in catalog
    assert "storage_by_name.find" in catalog
    assert "toString(files)" in catalog
    assert "FROM system.clusters" in catalog
    assert "FROM system.replication_queue" in catalog
    assert 'w.Key("topology")' in api
    assert 'w.Key("replication_queue")' in api
    assert 'w.Key("files")' in api
    assert "disk.free_space" in explorer and "disk.total_space" in explorer
    assert 'variant: "storage"' in explorer
    assert "explorerMetricBars--${variant}" in explorer
    assert '"Files", "Level"' in explorer


def test_table_detail_is_lazy_targeted_and_cached_per_object() -> None:
    api = read("src/api_explorer.cpp")
    catalog = read("src/explorer_catalog.cpp")
    detail = catalog[catalog.index("bool load_explorer_table_detail"):catalog.index("bool load_explorer_preview")]

    table_handler = api[api.index("void Server::handle_explorer_table"):api.index("void Server::handle_explorer_functions")]
    assert "explorer_table_detail_cache_.get_or_refresh" in table_handler
    assert "kExplorerTableDetailCacheTtlMs" in table_handler
    assert "load_explorer_table_summary" in table_handler
    assert "load_explorer_catalog(" not in table_handler
    assert "const ExplorerTableSummary& summary" in detail


def test_information_schema_is_excluded_at_runner_discovery_boundary() -> None:
    allowed = read("src/allowed_objects.cpp")
    catalog = read("src/explorer_catalog.cpp")

    assert 'database != "INFORMATION_SCHEMA" && database != "information_schema"' in allowed
    assert 'if (!explorer_schema_visible(database)) continue;' in allowed
    assert "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema')" in catalog


def test_explorer_uses_arial_and_owns_no_document_scroll_on_desktop() -> None:
    css = read("src/static/style.css")
    graph = read("src/static/app_explorer_graph.js")
    assert 'font-family: Arial, Helvetica, sans-serif;' in css
    assert '"Inter"' not in css
    assert 'Arial, Helvetica, sans-serif' in graph
    assert 'ui-sans-serif' not in graph
    assert 'overflow-y: hidden;' in css[css.index('html {'):css.index('html,\nbody {')]
    assert 'body {\n  min-height: 100dvh;\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;' in css
    assert '#queryWorkspace {\n  overflow: auto;' in css
    assert '.explorerWorkspace {\n  height: auto;\n  overflow: hidden;' in css
