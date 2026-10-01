from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_ops_routes_are_gated_by_the_explorer_operations_config() -> None:
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")
    assert "if (cfg_.explorer.operations_enabled()) {" in server
    assert 'http_.Get("/api/explorer/ops/activity"' in server
    assert "if (cfg_.explorer.operations_keeper) {" in server
    assert 'http_.Get("/api/explorer/ops/keeper"' in server
    assert 'w.Key("operations");' in server
    assert "bool operations = true;" in header and "bool operations_keeper = true;" in header
    assert 'validate_object(*operations, "explorer.operations", {"enabled", "keeper"}, {});' in config
    assert "operations {\n    enabled = true\n    keeper  = true\n  }" in example


def test_ops_activity_rows_pass_the_runner_show_boundary_and_are_bounded() -> None:
    ops = read("src/explorer_ops.cpp")
    api = read("src/api_explorer_ops.cpp")
    activity = ops[ops.index("bool load_explorer_ops_activity("):ops.index("bool load_explorer_keeper_status(")]
    # Names come from the runner context; the system context only reads rows.
    assert "RunnerVisibility visibility(runner);" in activity
    assert "if (!visibility.visible(database, table)) continue;" in ops
    assert "discover_visible_databases(runner)" in ops
    assert "discover_visible_objects(runner_, database)" in ops
    assert 'std::string in_databases = "database IN (";' in activity
    # Fixed, allowlisted and bounded system-table reads only.
    for table in ["system.merges", "system.mutations WHERE NOT is_done", "system.replication_queue", "system.replicas", "system.distribution_queue"]:
        assert f"FROM {table}" in activity, table
    assert activity.count("+ limit,") == 5
    assert 'const std::string limit = " LIMIT " + std::to_string(out.row_limit + 1);' in activity
    assert "constexpr size_t kExplorerOpsRowLimit = 200;" in api
    # Keeper-backed replica columns are never selected per request.
    replicas_sql = activity[activity.index('"replicas",'):activity.index("FROM system.replicas")]
    for column in ["log_max_index", "log_pointer", "total_replicas", "active_replicas", "zookeeper_exception", "replica_is_active"]:
        assert f"toString({column})" not in replicas_sql, column
    assert "load_cached_replica_counts(system, tables, &counts_error)" in activity
    for forbidden in ["SYSTEM ", "KILL ", "ALTER ", "INSERT ", "system.zookeeper "]:
        assert forbidden not in ops, forbidden


def test_ops_keeper_status_is_allowlisted_and_never_browses_zookeeper_paths() -> None:
    ops = read("src/explorer_ops.cpp")
    keeper = ops[ops.index("bool load_explorer_keeper_status("):]
    assert "FROM system.zookeeper_connection ORDER BY name LIMIT 16" in keeper
    assert "FROM system.metrics WHERE metric IN " in keeper
    assert "FROM system.events WHERE event IN " in keeper
    assert "FROM system.zookeeper " not in keeper and "FROM system.zookeeper\"" not in keeper


def test_ops_and_storage_modules_load_on_explorer_only() -> None:
    app = read("src/static/app.js")
    assert '"app_explorer_treemap.js",\n      "app_explorer_storage.js",\n      "app_explorer_ops.js",\n      "app_explorer_detail.js",\n      "app_explorer.js",' in app
    assert 'query: ["app_graph_kit.js", "app_explorer_graph.js", "app_explorer_treemap.js", "app_explorer_storage.js", "app_explorer_ops.js", "app_explorer_detail.js"],' in app
    assert 'explorerDetail: "app_explorer_detail.js", explorer: "app_explorer.js",' in app
    assert 'explorerStorage: "app_explorer_storage.js", explorerOps: "app_explorer_ops.js",' in app
    ops = read("src/static/app_explorer_ops.js")
    assert "ns.explorerOps = { show, hide," in ops
    assert "ns.api.getExplorerOpsActivity(host, force)" in ops
    assert "const AUTO_REFRESH_MS = 5000;" in ops
    # The timer never polls a hidden section or tab.
    assert "if (visible()) await load(false);" in ops
    storage = read("src/static/app_explorer_storage.js")
    assert "ns.explorerStorage = {" in storage
