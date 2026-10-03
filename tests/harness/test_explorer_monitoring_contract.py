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
    assert selects >= 8, selects
    # The Performance series: three builders, run by one bounded_select (its
    # rows read and time are reported).
    series = source.count("monitor_settings_sql(kSeriesTimeBudgetSeconds, ")
    assert series == 3, series
    assert source.count("bounded_select(") == 1
    assert source.count("monitor_settings_sql(") - 1 == selects + series, (selects, series, source.count("monitor_settings_sql("))
    for forbidden in ["SYSTEM ", "KILL ", "ALTER ", "INSERT ", "clusterAllReplicas", "FINAL"]:
        assert forbidden not in source, forbidden
    # Names in SQL come from the allowlists or from the runner's databases,
    # quoted; the request is never read here.
    assert "httplib" not in source and "get_param_value" not in source
    assert "in_list(monitor_overview_async_metrics())" in source and "in_list(monitor_overview_metrics())" in source
    assert "in_list(visibility.databases())" in source


def test_the_overview_handler_reads_the_host_and_refresh_only():
    api = read("src/api_explorer_monitor.cpp")
    handler = api[api.index("void Server::handle_explorer_monitor_overview("):api.index("void Server::handle_explorer_monitor_series(")]
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
    assert "ns.explorerMonitor = {\n    show, hide, refresh, register," in ui
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


def test_the_series_handler_reads_allowlisted_parameters_only():
    api = read("src/api_explorer_monitor.cpp")
    handler = api[api.index("void Server::handle_explorer_monitor_series("):]
    # Every parameter is on the list, and anything else is refused before the host.
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"};' in handler
    assert 'json_error(res, 400, "unknown_parameter"' in handler
    params = set(re.findall(r'param\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
    assert params <= {"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"}, params
    # Enumerations and the window: validated, clamped, never copied into SQL.
    assert 'if (panel != "performance") return json_error(res, 400, "invalid_panel"' in handler
    assert '"cluster_fanout_disabled"' in handler and "cfg_.explorer.monitoring_cluster_fanout" in handler
    assert 'json_error(res, 400, "range_too_large"' in handler and 'json_error(res, 400, "invalid_range"' in handler
    assert "to_ms = std::min(to_ms, now_ms);" in handler
    assert "std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })" in api
    # The window the SQL sees: integers aligned to the server-picked step.
    assert "window.step_s = monitor_series_step_seconds(" in handler
    assert "window.from_s = from_ms / 1000 / window.step_s * window.step_s;" in handler
    # 15 s per aligned window, the map bounded.
    assert "constexpr uint64_t kMonitorSeriesTtlMs = 15 * 1000;" in api
    assert "explorer_monitor_series_cache_.clear();" in handler
    assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    server = read("src/server.cpp")
    assert 'http_.Get("/api/explorer/monitor/series"' in server


def test_series_sql_is_three_fixed_passes_over_allowlisted_names():
    source = read("src/explorer_monitor.cpp")
    # One pass per log; metric IN (...) first on asynchronous_metric_log (its key).
    assert source.count('" FROM system.metric_log WHERE "') == 1
    assert source.count("FROM system.asynchronous_metric_log WHERE metric IN ") == 1
    assert source.count('" FROM system.query_log WHERE "') == 1
    assert "in_list(monitor_series_async_metrics())" in source
    # metric_log: the allowlisted expressions intersected with the detected
    # columns; the transposed layout reads as no metric_log.
    assert 'caps.has_column("metric_log", column)' in source
    assert 'constexpr const char* kMetricLogWideMarker = "ProfileEvent_Query";' in source
    assert '{"metric_log", metric_log_columns()},' in source
    # query_log: narrow columns only, within its lookback.
    sql = source[source.index("std::string monitor_series_query_log_sql("):source.index("double f64_at(")]
    for column in ["ProfileEvents", "query,", "normalized_query_hash", "exception"]:
        assert column not in sql, column
    assert "window.span_s > window.query_log_max_span_s" in source
    # The step table: at most 300 buckets, 10 s minimum.
    assert "steps{10, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86400}" in source
    assert "constexpr uint64_t kMonitorSeriesMaxPoints = 300;" in read("src/explorer_monitor.hpp")


def test_performance_registers_on_the_shared_chart_engine_and_time_range():
    perf = read("src/static/app_explorer_monitor_perf.js")
    assert 'ns.explorerMonitor.register({ id: "performance", label: "Performance", order: 20,' in perf
    # One chart engine, one card component, one crosshair, a drag zooms all.
    assert "ns.chartCore.create(entry.plot, {" in perf and "syncKey: SYNC_KEY," in perf and "onZoom," in perf
    assert "ns.ui.chartCardHtml({" in perf
    assert "for (const entry of state.charts.values()) entry.chart?.setZoom(startMs, endMs);" in perf
    # The Observability picker and its address format.
    assert "ns.timeRange.create(pickerRoot, {" in perf
    assert "ns.timeRange.url.write(new URLSearchParams(), state.range).toString()" in perf
    assert "ns.timeRange.url.read(new URLSearchParams(" in perf
    assert "ctx.setQuery(query(), { history });" in perf
    # Percentiles: one hue; errors: neutral under 1 %, warning to 5 %, danger past it.
    for token in ["var(--pct-p50)", "var(--pct-p95)", "var(--pct-p99)"]:
        assert token in perf, token
    assert "const ERROR_WARN = 0.01;" in perf and "const ERROR_DANGER = 0.05;" in perf
    # The timer never polls a hidden section or tab, and only relative ranges of 6 h or less.
    assert "if (visible()) await load(false);" in perf
    assert "const AUTO_REFRESH_MAX_SPAN_MS = 6 * 3600000;" in perf
    api = read("src/static/app_api.js")
    assert "async function getExplorerMonitorSeries(hostId, { fromMs, toMs }, refresh = false, { signal } = {}) {" in api
