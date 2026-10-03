"""Explorer Monitoring (docs/explorer.md "Monitoring"): the source contract.

Fixed backend SQL only: the request names the host (and later a clamped
range and allowlisted enums), never SQL, a column or a limit. Every SELECT
runs read-only, with a time budget and read / result caps that throw, and the
'chdash-monitoring' log_comment. A panel that cannot be read degrades on its
own, with the reason and, for a missing grant, the GRANT to run.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_monitoring_is_gated_by_its_config_block_and_advertised():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")
    assert "if (cfg_.explorer.monitoring_enabled()) {" in server
    assert 'http_.Get("/api/explorer/monitor/overview"' in server
    assert 'w.Key("monitoring");' in server
    assert "bool monitoring = true;" in header and "bool monitoring_cluster_fanout = false;" in header
    assert "bool monitoring_enabled() const { return enabled() && monitoring; }" in header
    assert '{"graph", "operations", "monitoring"}' in config
    for key in ["enabled", "top_queries", "cluster_fanout", "default_lookback_minutes", "max_lookback_days",
                "query_log_max_lookback_hours", "query_log_max_rows", "disk_growth_days"]:
        assert f'"{key}"' in config[config.index('optional_block(*explorer, "monitoring"'):], key
        assert f"{key} " in example[example.index("monitoring {"):], key
    # The windows are clamped once, at load.
    assert "cfg.explorer.monitoring_max_lookback_days = std::max(1, std::min(365," in config
    state = read("src/static/app_state.js")
    assert "monitoring: {" in state and "enabled: monitoringEnabled," in state


def test_every_select_is_fixed_bounded_read_only_and_tagged():
    source = read("src/explorer_monitor.cpp")
    settings = source[source.index("std::string monitor_settings_sql("):source.index("std::string monitor_reason_of(")]
    for part in ["readonly = 2", "max_execution_time = ", "timeout_overflow_mode = 'throw'", "max_rows_to_read = ",
                 "read_overflow_mode = 'throw'", "max_result_rows = ", "result_overflow_mode = 'throw'",
                 "log_comment = 'chdash-monitoring'"]:
        assert part in settings, part
    assert "'break'" not in source
    # Each Select carries the clause.
    selects = source.count(".Select(")
    assert selects >= 7, selects
    assert source.count("monitor_settings_sql(") - 1 == selects, (selects, source.count("monitor_settings_sql("))
    for forbidden in ["SYSTEM ", "KILL ", "ALTER ", "INSERT ", "clusterAllReplicas", "FINAL"]:
        assert forbidden not in source, forbidden
    # Names in SQL come from the allowlists or from the runner's databases,
    # quoted; the request is never read here.
    assert "httplib" not in source and "get_param_value" not in source
    assert "in_list(monitor_overview_async_metrics())" in source and "in_list(monitor_overview_metrics())" in source
    assert "in_list(visibility.databases())" in source


def test_the_overview_handler_reads_the_host_and_refresh_only():
    api = read("src/api_explorer_monitor.cpp")
    handler = api[api.index("void Server::handle_explorer_monitor_overview("):]
    params = set(re.findall(r'get_param_value\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
    assert params == {"host_id", "refresh"}, params
    assert 'json_error(res, 400, "missing_host_id"' in handler and 'json_error(res, 404, "unknown_host"' in handler
    assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    # Capabilities: 10 min per host; the snapshot: the operations TTL.
    assert "constexpr uint64_t kMonitorCapabilitiesTtlMs = 10 * 60 * 1000;" in api
    assert "std::max(1000, std::min(cache_ttl_ms, 5000))" in api


def test_replication_counts_pass_the_runner_show_boundary():
    source = read("src/explorer_monitor.cpp")
    replication = source[source.index("VisibleTables visibility(runner);"):source.index("out.replication = summary;")]
    assert "if (!visibility.visible(text(block, 0, row), text(block, 1, row))) continue;" in replication
    assert "discover_visible_databases(runner)" in source and "discover_visible_objects(runner_, database)" in source
    # In-memory columns only: no Keeper request per table.
    sql = replication[:replication.index("FROM system.replicas")]
    for column in ["log_max_index", "log_pointer", "total_replicas", "active_replicas", "zookeeper_exception", "replica_is_active"]:
        assert column not in sql, column


def test_errors_map_to_per_panel_reasons_with_the_grant_hint():
    source = read("src/explorer_monitor.cpp")
    reasons = source[source.index("std::string monitor_reason_of("):source.index("std::string monitor_grant_hint(")]
    mapping, pending = {}, []
    for line in reasons.splitlines():
        case = re.search(r"case (\d+):", line)
        if case:
            pending.append(case.group(1))
        result = re.search(r'return "([a-z_]+)";', line)
        if result and pending:
            mapping.update({code: result.group(1) for code in pending})
            pending = []
    assert mapping == {
        "60": "disabled", "81": "disabled", "497": "not_granted", "16": "unsupported", "47": "unsupported",
        "158": "window_too_large", "159": "window_too_large", "164": "readonly_account",
    }, mapping
    assert 'default:\n      return "failed";' in reasons
    assert 'return "GRANT SELECT ON system." + table + " TO " + name;' in source
    assert 'if (issue.reason == "not_granted") issue.hint = monitor_grant_hint(table, caps.system_user);' in source
    ui = read("src/static/app_explorer_monitor.js")
    assert 'not_granted: "Not granted",' in ui
    assert 'h("code", { class: "explorerMonitorIssue__code" }, issue.hint)' in ui


def test_the_view_registers_its_sections_and_mounts_activity_unchanged():
    ui = read("src/static/app_explorer_monitor.js")
    assert 'register({ id: "overview", label: "Overview", order: 10,' in ui
    assert 'register({ id: "activity", label: "Activity", order: 50,' in ui
    assert "ns.explorerMonitor = { show, hide, refresh, register," in ui
    # One Auto-refresh preference for every live section, Activity's included.
    assert "ns.storage.pref(ns.storage.KEYS.explorerOpsAutoRefresh, false)" in ui
    # Underlined section tabs (tier 2) through the shared component.
    assert 'ns.tabs.render(view.tabs, items, { attr: "section", tier: "content", selected: view.section });' in ui
    for helper in ["ui().statTile(", "ui().kvList(", "ns.badge.el(", "ns.icon.el(\"refresh\""]:
        assert helper in ui, helper
    docs = read("docs/explorer.md")
    assert "## Monitoring" in docs and "/api/explorer/monitor/overview" in docs
    routes = read("docs/ui-foundations.md")
    assert "/explorer/_monitoring[/<section>]" in routes
