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
    # Queries: five builders (top shapes, their text, a shape's timeline,
    # runs and example), run by one bounded_select as well; the
    # window-too-large estimate is a plain Select.
    queries = source.count("monitor_settings_sql(kQueries") - source.count("monitor_settings_sql(kQueriesEstimateSeconds, ")
    assert queries == 5, queries
    assert source.count("bounded_select(") == 2
    assert source.count("monitor_settings_sql(") - 1 == selects + series + queries, (selects, series, queries, source.count("monitor_settings_sql("))
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
    handler = api[api.index("void Server::handle_explorer_monitor_series("):api.index("bool Server::explorer_monitor_queries_window(")]
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
    source = source[:source.index("// Queries: top query shapes and one shape's drill-down")]
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


def test_the_queries_handlers_read_allowlisted_parameters_with_the_runner():
    api = read("src/api_explorer_monitor.cpp")
    handlers = api[api.index("bool Server::explorer_monitor_queries_window("):]
    listing = handlers[handlers.index("void Server::handle_explorer_monitor_queries("):handlers.index("void Server::handle_explorer_monitor_query(")]
    drill = handlers[handlers.index("void Server::handle_explorer_monitor_query("):]
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "sort", "kind", "hide_chdash", "refresh"};' in listing
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "order", "hide_chdash", "refresh"};' in drill
    for handler in (listing, drill):
        assert 'json_error(res, 400, "unknown_parameter"' in handler
        params = set(re.findall(r'param\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
        assert params <= {"host_id", "from_ms", "to_ms", "sort", "kind", "order", "hide_chdash", "refresh"}, params
        # The runner context: ClickHouse grants decide (proposal Q2). The
        # system context only detects what the server has.
        assert "acquire_queries_client(client_pool_, host->runner_uri, &error)" in handler
        assert "acquire_monitor_client(" not in handler
        assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    # Enumerations from the allowlists, the hash a UInt64, the window clamped
    # to query_log_max_lookback_hours.
    assert '"invalid_sort"' in listing and '"invalid_kind"' in listing and '"invalid_hide_chdash"' in listing
    assert '"invalid_hash"' in drill and '"invalid_order"' in drill
    assert "if (!parse_hash(hash_text, hash))" in drill
    assert 'static const std::string kMax = "18446744073709551615";' in api
    window = handlers[:handlers.index("void Server::handle_explorer_monitor_queries(")]
    assert "cfg_.explorer.monitoring_query_log_max_lookback_hours" in window and '"range_too_large"' in window
    # 60 s per minute-aligned window, one read in flight per key.
    assert "constexpr uint64_t kMonitorQueriesTtlMs = 60 * 1000;" in api
    assert "request.from_s = from_ms / 60'000 * 60;" in listing
    assert "explorer_monitor_queries_cache_.clear();" in listing and "explorer_monitor_query_cache_.clear();" in drill
    server = read("src/server.cpp")
    assert "if (cfg_.explorer.monitoring_top_queries) {" in server
    assert 'http_.Get("/api/explorer/monitor/queries"' in server
    assert 'http_.Get(R"(/api/explorer/monitor/queries/([^/]+))"' in server


def test_queries_sql_is_two_phase_and_never_lists_the_monitoring_reads():
    source = read("src/explorer_monitor.cpp")
    queries = source[source.index("// Queries: top query shapes and one shape's drill-down"):]
    # Every row a shape counts excludes our own reads; hide_chdash the system user.
    assert "\" AND log_comment != 'chdash-monitoring'\"" in queries
    assert 'if (r.hide_chdash && !r.system_user.empty()) sql += " AND user != " + quote_string(r.system_user);' in queries
    # The allowlisted ORDER BY expressions; nothing else reaches the SQL.
    for sort, expression in [("total_time", "sum(query_duration_ms)"), ("calls", "count()"), ("p95", "quantileTDigest(0.95)(query_duration_ms)"),
                             ("max_memory", "max(memory_usage)"), ("read_bytes", "sum(read_bytes)"), ("errors", "countIf(type != 'QueryFinish')")]:
        assert f'{{"{sort}", "{expression}"}},' in queries, sort
    assert 'static const std::vector<std::string> names{"all", "Select", "Insert", "other"};' in queries
    # Phase 1: narrow columns, the top 50, a group-by bound; phase 2 the text
    # of those hashes only (PREWHERE on the key column), cut.
    top = queries[queries.index("std::string monitor_queries_top_sql("):queries.index("std::string monitor_queries_text_sql(")]
    for column in ["argMax(query", "ProfileEvents", "exception"]:
        assert column not in top, column
    assert "GROUP BY normalized_query_hash ORDER BY" in top and "LIMIT \" + std::to_string(kMonitorTopQueries)" in top
    assert "max_rows_to_group_by = 1000000, group_by_overflow_mode = 'any'" in queries
    text = queries[queries.index("std::string monitor_queries_text_sql("):queries.index("std::string monitor_query_timeline_sql(")]
    assert "PREWHERE normalized_query_hash IN (" in text and "substringUTF8(argMax(query, event_time), 1, " in text
    assert "constexpr size_t kMonitorTopQueries = 50;" in read("src/explorer_monitor.hpp")
    # The drill-down: one hash (an integer), 20 runs, the CPU column there only.
    for builder in ["monitor_query_timeline_sql(", "monitor_query_runs_sql(", "monitor_query_example_sql("]:
        body = queries[queries.index(f"std::string {builder}"):]
        body = body[:body.index("\n}\n")]
        assert "PREWHERE normalized_query_hash = \" + std::to_string(r.hash)" in body, builder
    assert '{"duration", "query_duration_ms"},' in queries and '{"latest", "event_time_microseconds"},' in queries
    # Reads past the cap say so (and how wide a window fits); a missing
    # grant names the runner's GRANT.
    assert 'if (out.status == "not_granted") out.hint = monitor_grant_hint("query_log", r.runner_user);' in queries
    assert "out.suggested_span_s = monitor_queries_suggested_span(" in queries


def test_queries_section_draws_sql_as_text_and_opens_it_in_query_unrun():
    ui = read("src/static/app_explorer_monitor_queries.js")
    assert 'ns.explorerMonitor.register({\n    id: "queries",\n    label: "Queries",\n    order: 30,' in ui
    # Query text through ui.sqlBlock (the highlighter escapes); no markup sink.
    assert "ns.ui.sqlBlock({ sql: text," in ui
    assert "innerHTML" not in ui and "insertAdjacentHTML" not in ui
    # The shared pieces: table, badges, tiles, picker, chart engine.
    for helper in ["ns.table.sortHeader(", "ns.table.cellBar(", "ns.badge.el(", "ns.ui.statTile(", "ns.ui.copyButton(",
                   "ns.timeRange.create(pickerRoot, {", "ns.chartCore.create(entry.plot, {", "kit.issueBlock("]:
        assert helper in ui, helper
    assert "const ERROR_WARN = 0.01;" in ui and "const ERROR_DANGER = 0.05;" in ui
    # Open in Query: the Explorer's Open in Query (the session draft), never run.
    assert "await ctx.openSql(example, { formatted: true });" in ui
    assert "ctx.openSql(historySql(state.q, state.range, resolved), { formatted: false })" in ui
    monitor = read("src/static/app_explorer_monitor.js")
    assert "openSql: (sql, { formatted = true } = {}) => {" in monitor
    explorer = read("src/static/app_explorer.js")
    assert "? detailView?.openFormattedSqlInQuery(sql)" in explorer
    detail = read("src/static/app_explorer_detail.js")
    assert 'ns.storage.pref(ns.storage.KEYS.editorDraft, "", { session: true }).set(text);' in detail
    api = read("src/static/app_api.js")
    assert "async function getExplorerMonitorQueries(hostId, { fromMs, toMs, sort, kind, hideChdash = true }, refresh = false, { signal } = {}) {" in api
    assert "api/explorer/monitor/queries/${encodeURIComponent(String(hash))}?" in api
