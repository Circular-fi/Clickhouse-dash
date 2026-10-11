from pathlib import Path
import css_sources
import modules
from explorer_sources import read_api, read_catalog, read_unit

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_explorer_routes_are_runner_scoped_and_separate_from_query_stream() -> None:
    server = read("src/server.cpp")
    api = read_api()

    assert 'http_.Get("/api/explorer/catalog"' in server
    assert 'http_.Get("/api/explorer/table"' in server
    assert 'http_.Post("/api/explorer/table/data"' in server
    assert "authenticate_request" not in api
    assert "handle_explorer_catalog" not in read("src/api_query_stream.cpp")


def test_explorer_cache_is_bound_to_host_runner_context() -> None:
    api = read_api()

    # Every key of a cache starts with the host id of the request (never a token or a subject), then what the entry holds.
    assert "std::string key_of(const std::string& host_id, const char* kind, size_t kind_size) { return host_id + std::string(kind, kind_size); }" in api
    for kind in ("catalog", "graph", "functions", "storage"):
        assert f"std::string {kind}_key(const std::string& host_id) {{ return key_of(host_id, " in api
    assert "std::string detail_key = key_of(host_id, " in api
    assert "token_fingerprint" not in api
    assert "user.subject" not in api
    # The ACL of the runner identity (AclService, keyed by a digest of the runner URI) decides what is listed.
    assert "const AclAccess access = access_of_(host);" in api
    assert "acl_.databases(access)" in api and "acl_.objects(access, database_filter)" in api
    server = read("src/server.hpp")
    assert "[this](const HostSpec& host) { return runner_access(host); }" in server
    assert "AclAccess runner_access(const HostSpec& host) const { return make_acl_access(client_pool_, host.runner_uri); }" in server
    assert "cfg_.explorer.cache_ttl_ms" in server


def test_system_metadata_is_filtered_by_allowed_object_set_before_output() -> None:
    catalog = read_catalog()

    assert "allowed.allows_table(database, table)" in catalog
    assert "allowed.allows_column(database, table, name)" in catalog
    assert "system.tables" in catalog
    assert "system.columns" in catalog
    assert "system.parts" in catalog
    assert "system.replicas" in catalog
    assert "system_uri" not in catalog


def test_dependencies_are_filtered_before_they_are_exposed() -> None:
    catalog = read_catalog()

    assert "dependencies_database" in catalog
    assert "dependencies_table" in catalog
    assert "append_dependency" in catalog
    # The per-object ACL set holds only the selected table; related objects
    # are filtered by runner visibility before they are exposed.
    assert "if (!lineage_visible(database, table)) return;" in catalog
    # Each neighbour is checked alone (CHECK GRANT, then a zero-row probe): its database is never enumerated.
    assert "return acl_.readable(database, table);" in catalog
    assert '"downstream"' in catalog and '"upstream"' in catalog


def test_data_preview_uses_runner_readable_columns_limit_and_no_count() -> None:
    catalog = read_catalog()
    api = read_api()

    preview = catalog[catalog.index("bool load_explorer_preview"):]
    assert "allowed_columns_for_table" in preview
    assert "preview_sql(database, table, columns, types, limit)" in preview
    assert 'text += " FROM " + qualified_ident(database, table) + " LIMIT "' in preview
    assert "select count()" not in preview.lower()
    # The preview reads on the connection of the runner (never the technical account): the rows are the ones that the runner may read.
    service = read_unit("explorer_service.cpp")
    route = service[service.index("ExplorerService::preview("):service.index("// The graph\n")]
    assert "auto runner = connect_(host.runner_uri, &error);" in route
    assert "load_explorer_preview(*runner, allowed, database, table, limit, preview, &error)" in route
    assert "system_uri" not in route and "system_uri_of" not in route


def test_frontend_has_real_list_workspace_and_graph_mode() -> None:
    html = read("src/static/explorer.html")
    explorer = (modules.read_explorer() + modules.read_explorer_detail())

    assert 'id="navQueryLink"' in html
    assert 'id="navExplorerLink"' in html
    assert 'id="explorerWorkspace"' in html
    # Graph is a mode of the Catalog (its mode bar), no longer a top tab.
    assert 'id="explorerModeGraph"' in html and 'data-mode="graph"' in html
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
    api = read_api()
    frontend_api = read("src/static/app_api.js")
    explorer = (modules.read_explorer() + modules.read_explorer_detail())
    cache = read("src/ttl_cache.hpp")

    assert 'req.get_param_value("refresh") == "1"' in api
    # refresh=1 invalidates (never removes): a read in progress is waited for, and every request that asked meanwhile
    # shares the next read.
    service = read_unit("explorer_service.cpp")
    refresh = service[service.index("ExplorerService::catalog("):service.index("ExplorerService::storage(")]
    assert "acl_.invalidate(access);" in refresh
    assert "stores_.catalog.invalidate(catalog_key(host_id))" in refresh
    assert "stores_.graph.invalidate(graph_key(host_id))" in refresh
    assert "void invalidate(const Key& key)" in cache
    assert "void erase(" not in cache and "void clear()" not in cache
    assert 'query.set("refresh", "1")' in frontend_api
    assert 'api.getExplorerCatalog(hostId, "", !!force, { signal: req.signal })' in explorer


def test_list_detail_exposes_storage_parts_topology_and_replication_without_cross_object_leak() -> None:
    catalog = read_catalog()
    api = read_api()
    explorer = (modules.read_explorer() + modules.read_explorer_detail())

    assert "FROM system.disks" in catalog
    assert "storage_by_name.find" in catalog
    assert "toString(files)" in catalog
    assert "FROM system.clusters" in catalog
    assert "FROM system.replication_queue" in catalog
    assert 'w.Key("topology")' in api
    assert 'w.Key("replication_queue")' in api
    assert 'w.Key("files")' in api
    assert "disk.free_space" in explorer and "disk.total_space" in explorer
    assert 'className: "explorerTable--disks"' in explorer
    assert 'label: "Files"' in explorer and 'label: "Level"' in explorer


def test_table_detail_is_lazy_targeted_and_cached_per_object() -> None:
    api = read_api()
    catalog = read_catalog()
    detail = catalog[catalog.index("bool load_explorer_table_detail"):catalog.index("bool load_explorer_preview")]

    service = read_unit("explorer_service.cpp")
    table_handler = service[service.index("ExplorerService::table("):service.index("ExplorerService::functions(")]
    assert "stores_.table_detail.get(" in table_handler
    assert "kTableDetailCacheTtlMs = 30 * 1000" in read_unit("explorer_service.hpp")
    assert "explorer::kTableDetailCacheTtlMs" in read_unit("api_explorer.cpp")
    assert "load_explorer_table_summary" in table_handler
    assert "load_explorer_catalog(" not in table_handler
    assert "const ExplorerTableSummary& summary" in detail


def test_information_schema_is_excluded_at_runner_discovery_boundary() -> None:
    allowed = read("src/allowed_objects.cpp")
    catalog = read_catalog()

    assert 'database != "INFORMATION_SCHEMA" && database != "information_schema"' in allowed
    assert 'if (!explorer_schema_visible(database)) continue;' in allowed
    assert "WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema')" in catalog


def test_explorer_uses_the_sans_token_and_owns_no_document_scroll_on_desktop() -> None:
    css = css_sources.text()
    graph = (modules.read_explorer_graph() + read("src/static/app_graph_kit.js"))
    assert 'font-family: var(--font-sans);' in css
    assert '"Inter"' not in css
    assert 'const FONT = \'"IBM Plex Sans", ' in graph
    assert 'ui-sans-serif' not in graph
    assert css_sources.decls('html')['overflow-y'] == 'hidden'
    # One scroll model (css/20-features/shell.css): the document never scrolls,
    # the Query workspace is its page's one scroller, the Explorer's panes scroll.
    shell = css_sources.feature('shell')
    for selector in ('html', 'body'):
        frame = css_sources.decls(selector)
        assert frame['height'] == '100%' and frame['min-height'] == '0' and frame['overflow'] == 'hidden', selector
    body = css_sources.decls('body')
    assert body['display'] == 'flex' and body['flex-direction'] == 'column'
    layout = css_sources.decls('.layout')
    assert layout['overflow'] == 'auto' and layout['flex'] == '1 1 auto'
    workspace = css_sources.decls('.explorerWorkspace')
    assert workspace['overflow'] == 'hidden' and workspace['flex'] == '1 1 auto'
    # No narrow-window rule hands the scroll back to the document.
    assert 'calc(100vh - 62px)' not in css and 'calc(100dvh - 62px)' not in css
    assert 'html,\n  body {\n    overflow: auto;' not in css
