"""The System Overview's Activity and Keeper (docs/system.md "Activity"): the
v2.14.0 Server operations reads, moved from the Explorer."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_activity_routes_are_gated_by_the_system_config() -> None:
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")
    assert "if (cfg_.system.activity_enabled()) {" in server
    assert 'http_.Get("/api/system/activity", activity);' in server
    assert "if (cfg_.system.keeper_enabled()) {" in server
    assert 'http_.Get("/api/system/keeper", keeper);' in server
    assert 'w.Key("activity"); w.Bool(cfg_.system.activity_enabled());' in server
    assert "bool activity = true;" in header and "bool keeper = true;" in header
    # v2.14.0's explorer.operations block still reads.
    assert 'validate_object(*operations, "explorer.operations", {"enabled", "keeper"}, {});' in config
    block = example[example.index("\nsystem {"):]
    assert "  activity " in block and "  keeper " in block


def test_activity_rows_pass_the_runner_show_boundary_and_are_bounded() -> None:
    ops = read("src/system_activity.cpp")
    api = read("src/api_system_activity.cpp")
    activity = ops[ops.index("bool load_system_activity("):ops.index("bool load_system_keeper_status(")]
    assert "RunnerVisibility visibility(runner);" in activity
    assert "if (!visibility.visible(database, table)) continue;" in ops
    assert "discover_visible_databases(runner)" in ops
    assert "discover_visible_objects(runner_, database)" in ops
    assert 'std::string in_databases = "database IN (";' in activity
    for table in ["system.merges", "system.mutations WHERE NOT is_done", "system.replication_queue", "system.replicas", "system.distribution_queue"]:
        assert f"FROM {table}" in activity, table
    assert activity.count("+ limit,") == 5
    assert 'const std::string limit = " LIMIT " + std::to_string(out.row_limit + 1);' in activity
    assert "constexpr size_t kSystemActivityRowLimit = 200;" in api
    replicas_sql = activity[activity.index('"replicas",'):activity.index("FROM system.replicas")]
    for column in ["log_max_index", "log_pointer", "total_replicas", "active_replicas", "zookeeper_exception", "replica_is_active"]:
        assert f"toString({column})" not in replicas_sql, column
    assert "load_cached_replica_counts(system, tables, &counts_error)" in activity
    for forbidden in ["SYSTEM ", "KILL ", "ALTER ", "INSERT ", "system.zookeeper "]:
        assert forbidden not in ops, forbidden


def test_keeper_status_is_allowlisted_and_never_browses_zookeeper_paths() -> None:
    ops = read("src/system_activity.cpp")
    keeper = ops[ops.index("bool load_system_keeper_status("):]
    assert "FROM system.zookeeper_connection ORDER BY name LIMIT 16" in keeper
    assert "FROM system.metrics WHERE metric IN " in keeper
    assert "FROM system.events WHERE event IN " in keeper
    assert "FROM system.zookeeper " not in keeper and "FROM system.zookeeper\"" not in keeper


def test_activity_loads_on_the_system_page_only() -> None:
    pages = json.loads(read("src/static/modules.json"))["pages"]
    explorer = pages["explorer"]["modules"]
    assert explorer[-4:] == ["app_explorer_treemap.js", "app_explorer_storage.js", "app_explorer_detail.js", "app_explorer.js"]
    for name in ("app_graph_kit.js", "app_explorer_graph.js", "app_explorer_treemap.js", "app_explorer_storage.js", "app_explorer_detail.js", "app_system_activity.js"):
        assert name not in pages["query"]["modules"], name
    assert "app_system_activity.js" in pages["system"]["modules"]
    assert not (Path(ROOT / "src/static/app_explorer_ops.js")).exists()
    activity = read("src/static/app_system_activity.js")
    assert "ns.systemActivity = { create," in activity
    assert "ns.api.getSystemActivity(host, force)" in activity
    # The Overview polls it with its tiles, never while hidden.
    overview = read("src/static/app_system_overview.js")
    assert "activity = activityEnabled() ? ns.systemActivity.create({ openTable: ctx.openTable }) : null;" in overview
    assert "if (activity && !activity.loading()) work.push(activity.load(force));" in overview
    storage = read("src/static/app_explorer_storage.js")
    assert "ns.explorerStorage = {" in storage
