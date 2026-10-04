"""The System page (docs/system.md): the source contract.

Fixed backend SQL only: the request names the host (and a clamped range and
allowlisted enums), never SQL, a column or a limit. Every SELECT runs
read-only, with a time budget and read / result caps that throw, and the
'chdash-system' log_comment. A panel that cannot be read degrades on its own,
with the reason and, for a missing grant, the GRANT to run. The page is its
own shell (system.html) with its own controller and modules, behind
system.enabled; the Explorer's former Monitoring addresses redirect to it.
"""
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_the_page_is_gated_by_its_config_block_and_advertised():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    config = read("src/config.cpp")
    example = read("config.example.hcl")
    gate = server[server.index("  if (cfg_.system.enabled) {\n    http_.Get(\"/api/system/overview\""):]
    gate = gate[:gate.index("\n  }\n")]
    for route in ["/api/system/overview", "/api/system/series", "/api/system/disks", "/api/system/queries", "/api/system/activity", "/api/system/keeper"]:
        assert f'"{route}"' in gate, route
    assert 'http_.Get("/system", serve_system_shell);' in server and 'http_.Get(R"(/system/.*)", serve_system_shell);' in server
    assert 'w.Key("system");' in server
    assert "struct SystemSettings {" in header and "bool cluster_fanout = false;" in header
    assert "bool activity_enabled() const { return enabled && activity; }" in header
    assert '"traces", "logs", "metrics", "explorer", "system", "analysis", "export", "clickhouse", "query_library"' in config
    block = config[config.index('optional_block(root, "system", source)'):]
    for key in ["enabled", "activity", "keeper", "top_queries", "cluster_fanout", "default_lookback_minutes", "max_lookback_days",
                "query_log_max_lookback_hours", "query_log_max_rows", "disk_growth_days"]:
        assert f'"{key}"' in block[:block.index("\n  }\n")], key
        assert f"{key} " in example[example.index("\nsystem {"):], key
    # Monitoring was never released: no explorer.monitoring key is read.
    assert '"monitoring"' not in config and "monitoring_" not in header and "bool monitoring" not in header
    # The windows are clamped once, at load.
    assert "cfg.system.max_lookback_days = std::max(1, std::min(365," in config
    state = read("src/static/app_state.js")
    assert "system: {" in state and "enabled: systemEnabled," in state


def test_v2_14_operations_keys_and_routes_keep_working():
    config = read("src/config.cpp")
    server = read("src/server.cpp")
    # explorer.operations { enabled, keeper } (v2.14.0): the Activity and Keeper switches.
    assert 'validate_object(*operations, "explorer.operations", {"enabled", "keeper"}, {});' in config
    assert "cfg.system.activity = false;" in config and "cfg.system.keeper = cfg.system.keeper && *v;" in config
    # Its documented endpoints stay as aliases, and /api/version still reports them.
    assert 'http_.Get("/api/explorer/ops/activity", activity);' in server
    assert 'http_.Get("/api/explorer/ops/keeper", keeper);' in server
    assert 'w.Key("operations");' in server
    # /explorer/_operations and /explorer/_monitoring redirect, before /explorer/.*.
    assert server.index('http_.Get("/explorer/_operations"') < server.index('http_.Get(R"(/explorer/.*)", serve_explorer_shell);')
    assert 'http_.Get(R"(/explorer/_monitoring(/.*)?)"' in server
    redirect = server[server.index("void Server::redirect_to_system("):server.index("void Server::handle_api_version(")]
    assert "res.status = 302;" in redirect and 'location += req.target.substr(query);' in redirect
    assert 'location += "../";' in redirect


DISK_BUILDERS = ["monitor_disks_sql", "monitor_storage_policies_sql", "monitor_disk_usage_sql", "monitor_disk_growth_sql", "monitor_disk_written_sql"]


def builder_body(source: str, name: str) -> str:
    body = source[source.index(f"std::string {name}("):]
    return body[:body.index("\n}\n")]


def test_every_select_is_fixed_bounded_read_only_and_tagged():
    source = read("src/system_monitor.cpp")
    settings = source[source.index("std::string monitor_settings_sql("):source.index("std::string monitor_reason_of(")]
    for part in ["readonly = 2", "max_execution_time = ", "timeout_overflow_mode = 'throw'", "max_rows_to_read = ",
                 "read_overflow_mode = 'throw'", "max_result_rows = ", "result_overflow_mode = 'throw'",
                 "log_comment = 'chdash-system'"]:
        assert part in settings, part
    assert "'break'" not in source
    selects = source.count(".Select(")
    assert selects >= 8, selects
    series = source.count("monitor_settings_sql(kSeriesTimeBudgetSeconds, ")
    assert series == 3, series
    queries = source.count("monitor_settings_sql(kQueries") - source.count("monitor_settings_sql(kQueriesEstimateSeconds, ")
    assert queries == 5, queries
    disks = sum(builder_body(source, name).count("monitor_settings_sql(") for name in DISK_BUILDERS)
    assert disks == 5, disks
    builder_selects = sum(source.count(f".Select({name}(") for name in DISK_BUILDERS)
    assert builder_selects == 3, builder_selects
    assert source.count("bounded_select(") == 3
    assert source.count("monitor_settings_sql(") - 1 == selects - builder_selects + series + queries + disks, (selects, series, queries, disks, source.count("monitor_settings_sql("))
    for forbidden in ["SYSTEM ", "KILL ", "ALTER ", "INSERT ", "clusterAllReplicas", "FINAL"]:
        assert forbidden not in source, forbidden
    assert "httplib" not in source and "get_param_value" not in source
    assert "in_list(monitor_overview_async_metrics())" in source and "in_list(monitor_overview_metrics())" in source
    assert "in_list(visibility.databases())" in source


def test_the_overview_handler_reads_the_host_and_refresh_only():
    api = read("src/api_system.cpp")
    handler = api[api.index("void Server::handle_system_overview("):api.index("void Server::handle_system_series(")]
    params = set(re.findall(r'get_param_value\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
    assert params == {"host_id", "refresh"}, params
    assert 'json_error(res, 400, "missing_host_id"' in handler and 'json_error(res, 404, "unknown_host"' in handler
    assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    assert "constexpr uint64_t kMonitorCapabilitiesTtlMs = 10 * 60 * 1000;" in api
    assert "std::max(1000, std::min(cache_ttl_ms, 5000))" in api


def test_replication_counts_pass_the_runner_show_boundary():
    source = read("src/system_monitor.cpp")
    replication = source[source.index("VisibleTables visibility(runner);"):source.index("out.replication = summary;")]
    assert "if (!visibility.visible(text(block, 0, row), text(block, 1, row))) continue;" in replication
    assert "discover_visible_databases(runner)" in source and "discover_visible_objects(runner_, database)" in source
    sql = replication[:replication.index("FROM system.replicas")]
    for column in ["log_max_index", "log_pointer", "total_replicas", "active_replicas", "zookeeper_exception", "replica_is_active"]:
        assert column not in sql, column


def test_errors_map_to_per_panel_reasons_with_the_grant_hint():
    source = read("src/system_monitor.cpp")
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
    ui = read("src/static/app_system_view.js")
    assert 'not_granted: "Not granted",' in ui
    assert 'h("code", { class: "systemIssue__code" }, issue.hint)' in ui


def test_the_page_has_its_own_shell_controller_and_sections():
    manifest = json.loads(read("src/static/modules.json"))
    system = manifest["pages"]["system"]
    assert system["bootstrap"] == "app_system.js"
    assert system["modules"][-6:] == ["app_system_view.js", "app_system_activity.js", "app_system_perf.js", "app_system_overview.js", "app_system_queries.js", "app_system_disks.js"]
    for name in ["app_chart_core.js", "app_timerange.js", "app_explorer_treemap.js"]:
        assert system["modules"].index(name) < system["modules"].index("app_system_view.js"), name
    # The Explorer no longer loads any of it.
    explorer = manifest["pages"]["explorer"]
    assert "lazy" not in explorer and not any(name.startswith("app_system") for name in explorer["modules"])
    view = read("src/static/app_system_view.js")
    # Underlined section tabs (tier 2) through the shared component.
    assert 'ns.tabs.render(view.tabs, items, { attr: "section", tier: "content", selected: view.section });' in view
    assert "ns.systemView = {\n    show, hide, refresh, register," in view
    # One Auto-refresh preference; no caption line ("This server ... Updated").
    assert "ns.storage.pref(ns.storage.KEYS.systemAutoRefresh, false)" in view
    for module in ["app_system_view.js", "app_system_overview.js", "app_system_perf.js", "app_system_queries.js", "app_system_disks.js", "app_system_activity.js"]:
        text = read(f"src/static/{module}")
        assert "Bar__meta" not in text and "This server:" not in text and "Updated ${" not in text, module
    overview = read("src/static/app_system_overview.js")
    assert 'ns.systemView.register({ id: "overview", label: "Overview", order: 10,' in overview
    queries = read("src/static/app_system_queries.js")
    assert 'ns.systemView.register({\n    id: "queries",\n    label: "Queries",\n    order: 30,' in queries
    disks = read("src/static/app_system_disks.js")
    assert 'ns.systemView.register({ id: "disks", label: "Disks", order: 40,' in disks
    controller = read("src/static/app_system.js")
    assert 'const SECTIONS = ["overview", "queries", "disks"];' in controller
    assert 'router().on(ROUTE, onPopState);' in controller
    docs = read("docs/system.md")
    assert "## Overview" in docs and "/api/system/overview" in docs
    routes = read("docs/ui-foundations.md")
    assert "/system[/<section>]" in routes


def test_the_overview_merges_its_parts_in_order_without_repeating_a_figure():
    overview = read("src/static/app_system_overview.js")
    body = overview[overview.index('const body = h("div", { class: "systemOverview", id: "systemOverview" },'):]
    body = body[:body.index(";\n")]
    order = ["tilesHost", "databases.el", "cluster.el", "perf?.el", "activityPart?.el"]
    assert [body.index(part) for part in order] == sorted(body.index(part) for part in order), body
    # The treemap of the databases is the Explorer's (app_explorer_treemap.js);
    # a database opens its Explorer card.
    assert "ns.explorerTreemap.mount(treemapHost, {" in overview and "ctx.openDatabase(target.database)" in overview
    # The tiles at 5 s, the charts at 30 s for short relative ranges only.
    assert "const LIVE_REFRESH_MS = 5000;" in overview and "perf.AUTO_REFRESH_MS" in overview
    assert "if (visible()) await loadLive(false);" in overview and "if (visible()) await perf.load(false);" in overview
    # One Keeper card: the Activity has none; no current values repeated under the charts.
    activity = read("src/static/app_system_activity.js")
    assert "renderKeeper" not in activity and "getSystemKeeper" not in activity
    perf = read("src/static/app_system_perf.js")
    assert "serverTiles" not in perf and "getSystemOverview" not in perf


def test_the_series_handler_reads_allowlisted_parameters_only():
    api = read("src/api_system.cpp")
    handler = api[api.index("void Server::handle_system_series("):api.index("bool Server::system_monitor_queries_window(")]
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"};' in handler
    assert 'json_error(res, 400, "unknown_parameter"' in handler
    params = set(re.findall(r'param\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
    assert params <= {"host_id", "from_ms", "to_ms", "panel", "scope", "refresh"}, params
    assert 'if (panel != "performance" && panel != "disk_growth") {' in handler and '"invalid_panel"' in handler
    assert '"cluster_fanout_disabled"' in handler and "cfg_.system.cluster_fanout" in handler
    assert 'json_error(res, 400, "range_too_large"' in handler and 'json_error(res, 400, "invalid_range"' in handler
    assert "to_ms = std::min(to_ms, now_ms);" in handler
    assert "std::all_of(text.begin(), text.end(), [](char ch) { return ch >= '0' && ch <= '9'; })" in api
    assert "window.step_s = monitor_series_step_seconds(" in handler
    assert "window.from_s = from_ms / 1000 / window.step_s * window.step_s;" in handler
    assert "constexpr uint64_t kMonitorSeriesTtlMs = 15 * 1000;" in api
    assert "system_monitor_series_cache_.clear();" in handler
    assert 'res.set_header("Cache-Control", "private, no-store");' in handler


def test_series_sql_is_three_fixed_passes_over_allowlisted_names():
    source = read("src/system_monitor.cpp")
    source = source[:source.index("// Queries: top query shapes and one shape's drill-down")]
    assert source.count('" FROM system.metric_log WHERE "') == 1
    assert source.count("FROM system.asynchronous_metric_log WHERE metric IN ") == 1
    assert source.count('" FROM system.query_log WHERE "') == 1
    assert "in_list(monitor_series_async_metrics())" in source
    assert 'caps.has_column("metric_log", column)' in source
    assert 'constexpr const char* kMetricLogWideMarker = "ProfileEvent_Query";' in source
    assert '{"metric_log", metric_log_columns()},' in source
    sql = source[source.index("std::string monitor_series_query_log_sql("):source.index("double f64_at(")]
    for column in ["ProfileEvents", "query,", "normalized_query_hash", "exception"]:
        assert column not in sql, column
    assert "window.span_s > window.query_log_max_span_s" in source
    assert "steps{10, 30, 60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 86400}" in source
    assert "constexpr uint64_t kMonitorSeriesMaxPoints = 300;" in read("src/system_monitor.hpp")


def test_performance_draws_on_the_shared_chart_engine_and_time_range():
    perf = read("src/static/app_system_perf.js")
    assert "ns.systemPerf = { create," in perf
    assert "ns.chartCore.create(entry.plot, {" in perf and "syncKey: SYNC_KEY," in perf and "onZoom," in perf
    assert "ns.ui.chartCardHtml({" in perf
    assert "for (const entry of state.charts.values()) entry.chart?.setZoom(startMs, endMs);" in perf
    assert "ns.timeRange.create(picker.root, {" in perf
    assert "ns.timeRange.url.write(new URLSearchParams(), state.range).toString()" in perf
    assert "ns.timeRange.url.read(new URLSearchParams(" in perf
    assert "ctx.setQuery(query(), { history });" in perf
    for token in ["var(--pct-p50)", "var(--pct-p95)", "var(--pct-p99)"]:
        assert token in perf, token
    assert "const ERROR_WARN = 0.01;" in perf and "const ERROR_DANGER = 0.05;" in perf
    assert "const AUTO_REFRESH_MS = 30000;" in perf and "const AUTO_REFRESH_MAX_SPAN_MS = 6 * 3600000;" in perf
    api = read("src/static/app_api.js")
    assert "async function getSystemSeries(hostId, { fromMs, toMs }, refresh = false, { signal } = {}) {" in api


def test_the_queries_handlers_read_allowlisted_parameters_with_the_runner():
    api = read("src/api_system.cpp")
    handlers = api[api.index("bool Server::system_monitor_queries_window("):]
    listing = handlers[handlers.index("void Server::handle_system_queries("):handlers.index("void Server::handle_system_query(")]
    drill = handlers[handlers.index("void Server::handle_system_query("):]
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "sort", "kind", "hide_chdash", "refresh"};' in listing
    assert 'static const std::set<std::string> kParams{"host_id", "from_ms", "to_ms", "order", "hide_chdash", "refresh"};' in drill
    for handler in (listing, drill):
        assert 'json_error(res, 400, "unknown_parameter"' in handler
        params = set(re.findall(r'param\("([a-z_]+)"\)', handler)) | set(re.findall(r'has_param\("([a-z_]+)"\)', handler))
        assert params <= {"host_id", "from_ms", "to_ms", "sort", "kind", "order", "hide_chdash", "refresh"}, params
        assert "acquire_queries_client(client_pool_, host->runner_uri, &error)" in handler
        assert "acquire_monitor_client(" not in handler
        assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    assert '"invalid_sort"' in listing and '"invalid_kind"' in listing and '"invalid_hide_chdash"' in listing
    assert '"invalid_hash"' in drill and '"invalid_order"' in drill
    assert "if (!parse_hash(hash_text, hash))" in drill
    assert 'static const std::string kMax = "18446744073709551615";' in api
    window = handlers[:handlers.index("void Server::handle_system_queries(")]
    assert "cfg_.system.query_log_max_lookback_hours" in window and '"range_too_large"' in window
    assert "constexpr uint64_t kMonitorQueriesTtlMs = 60 * 1000;" in api
    assert "request.from_s = from_ms / 60'000 * 60;" in listing
    assert "system_monitor_queries_cache_.clear();" in listing and "system_monitor_query_cache_.clear();" in drill
    server = read("src/server.cpp")
    assert "if (cfg_.system.top_queries_enabled()) {" in server
    assert 'http_.Get(R"(/api/system/queries/([^/]+))"' in server


def test_queries_sql_is_two_phase_and_never_lists_its_own_reads():
    source = read("src/system_monitor.cpp")
    queries = source[source.index("// Queries: top query shapes and one shape's drill-down"):]
    assert "\" AND log_comment != 'chdash-system'\"" in queries
    assert 'if (r.hide_chdash && !r.system_user.empty()) sql += " AND user != " + quote_string(r.system_user);' in queries
    for sort, expression in [("total_time", "sum(query_duration_ms)"), ("calls", "count()"), ("p95", "quantileTDigest(0.95)(query_duration_ms)"),
                             ("max_memory", "max(memory_usage)"), ("read_bytes", "sum(read_bytes)"), ("errors", "countIf(type != 'QueryFinish')")]:
        assert f'{{"{sort}", "{expression}"}},' in queries, sort
    assert 'static const std::vector<std::string> names{"all", "Select", "Insert", "other"};' in queries
    top = queries[queries.index("std::string monitor_queries_top_sql("):queries.index("std::string monitor_queries_text_sql(")]
    for column in ["argMax(query", "ProfileEvents", "exception"]:
        assert column not in top, column
    assert "GROUP BY normalized_query_hash ORDER BY" in top and "LIMIT \" + std::to_string(kMonitorTopQueries)" in top
    assert "max_rows_to_group_by = 1000000, group_by_overflow_mode = 'any'" in queries
    text = queries[queries.index("std::string monitor_queries_text_sql("):queries.index("std::string monitor_query_timeline_sql(")]
    assert "PREWHERE normalized_query_hash IN (" in text and "substringUTF8(argMax(query, event_time), 1, " in text
    assert "constexpr size_t kMonitorTopQueries = 50;" in read("src/system_monitor.hpp")
    for builder in ["monitor_query_timeline_sql(", "monitor_query_runs_sql(", "monitor_query_example_sql("]:
        body = queries[queries.index(f"std::string {builder}"):]
        body = body[:body.index("\n}\n")]
        assert "PREWHERE normalized_query_hash = \" + std::to_string(r.hash)" in body, builder
    assert '{"duration", "query_duration_ms"},' in queries and '{"latest", "event_time_microseconds"},' in queries
    assert 'if (out.status == "not_granted") out.hint = monitor_grant_hint("query_log", r.runner_user);' in queries
    assert "out.suggested_span_s = monitor_queries_suggested_span(" in queries


def test_queries_section_draws_sql_as_text_and_opens_it_in_query_unrun():
    ui = read("src/static/app_system_queries.js")
    assert "ns.ui.sqlBlock({ sql: text," in ui
    assert "innerHTML" not in ui and "insertAdjacentHTML" not in ui
    for helper in ["ns.table.sortHeader(", "ns.table.cellBar(", "ns.badge.el(", "ns.ui.statTile(", "ns.ui.copyButton(",
                   "ns.timeRange.create(pickerRoot, {", "ns.chartCore.create(entry.plot, {", "kit.issueBlock("]:
        assert helper in ui, helper
    assert "const ERROR_WARN = 0.01;" in ui and "const ERROR_DANGER = 0.05;" in ui
    assert "await ctx.openSql(example, { formatted: true });" in ui
    assert "ctx.openSql(historySql(state.q, state.range, resolved), { formatted: false })" in ui
    view = read("src/static/app_system_view.js")
    assert "openSql: (sql, { formatted = true } = {}) => {" in view
    # The Query page's session draft, then the Query page: never run.
    controller = read("src/static/app_system.js")
    assert 'ns.storage.pref(ns.storage.KEYS.editorDraft, "", { session: true }).set(text);' in controller
    assert "await ns.api.formatSqls(" in controller
    api = read("src/static/app_api.js")
    assert "async function getSystemQueries(hostId, { fromMs, toMs, sort, kind, hideChdash = true }, refresh = false, { signal } = {}) {" in api
    assert "api/system/queries/${encodeURIComponent(String(hash))}?" in api


def test_the_disks_handler_reads_the_host_only_and_growth_is_a_series_panel():
    api = read("src/api_system.cpp")
    handler = api[api.index("void Server::handle_system_disks("):api.index("bool Server::system_monitor_queries_window(")]
    assert 'static const std::set<std::string> kParams{"host_id", "refresh"};' in handler
    assert 'json_error(res, 400, "unknown_parameter"' in handler
    assert 'res.set_header("Cache-Control", "private, no-store");' in handler
    assert "constexpr uint64_t kMonitorDisksTtlMs = 60 * 1000;" in api
    assert "constexpr uint64_t kMonitorGrowthTtlMs = 5 * 60 * 1000;" in api
    assert "system_monitor_growth_cache_.clear();" in api
    series = api[api.index("void Server::handle_system_series("):api.index("void Server::system_monitor_disk_growth(")]
    assert "cfg_.system.disk_growth_days" in series
    assert "if (growth) return system_monitor_disk_growth(" in series


def test_disks_sql_names_runner_visible_databases_and_both_disk_metric_forms():
    source = read("src/system_monitor.cpp")
    disks = source[source.index("// Disks: system.disks, system.storage_policies"):]
    assert "std::vector<std::string> databases = discover_visible_databases(runner);" in disks
    assert "if (!std::binary_search(databases.begin(), databases.end(), usage.database)) continue;" in disks
    assert '"FROM system.parts WHERE active AND database IN " + in_list(databases)' in disks
    assert '" AND database IN " + in_list(databases) + " AND event_type IN (\'NewPart\', \'MovePart\') GROUP BY t ORDER BY t"' in disks
    assert '{"disks", disk_columns()},' in source and '{"storage_policies", storage_policy_columns()},' in source
    assert '{"asynchronous_metric_log", {"key"}},' in source
    assert 'out.key_column = caps.has_column("asynchronous_metric_log", "key");' in disks
    assert "\" OR (metric = 'DiskUsed' AND key IN \" + in_list(disks)" in disks
    assert "if(metric = 'DiskUsed', toString(key), substring(toString(metric), 10))" in disks
    header = read("src/system_monitor.hpp")
    assert "constexpr size_t kMonitorDiskTrendMinPoints = 6;" in header
    assert "constexpr uint64_t kMonitorDiskTrendMinSpanSeconds = 6 * 3600;" in header
    assert 'out.status = "not_enough_history";' in disks and 'out.status = "not_growing";' in disks
    cmake = read("src/CMakeLists.txt")
    assert "CHDASH_BUILD_SYSTEM_TESTS" in cmake and "../tests/native/system_monitor_test.cpp" in cmake
    runner = read("tests/test-suite/run-all-tests.py")
    assert "str(ROOT / 'backend-functional' / 'test_system.py')," in runner


def test_native_monitor_unit_tests_pass_when_built():
    binary = os.environ.get("SYSTEM_MONITOR_TEST_BINARY")
    if not binary:
        pytest.skip("SYSTEM_MONITOR_TEST_BINARY is not set (build chdash_system_monitor_test)")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout


def test_disks_section_links_into_storage_and_states_its_thresholds():
    ui = read("src/static/app_system_disks.js")
    assert "innerHTML" not in ui and "insertAdjacentHTML" not in ui
    for helper in ["ns.ui.statTile(", "ns.ui.chartCardHtml({", "ns.chartCore.create(entry.plot, {", "ns.table.shareBar(",
                   "ns.badge.el(", "ns.icon.el(", "kit.issueBlock(", "ns.timeRange.create(pickerRoot, {"]:
        assert helper in ui, helper
    assert "const FILL_WARN = 0.8;" in ui and "const FILL_DANGER = 0.9;" in ui
    # No "Soonest full" tile: each disk's card says how long it lasts.
    assert "Soonest" not in ui and 'fact("until_full", "Until full",' in ui
    # A database opens its card on the Storage tab.
    assert 'ctx.openDatabase(name, { tab: "storage" });' in ui and 'ctx.databaseHref(name, { tab: "storage" })' in ui
    controller = read("src/static/app_system.js")
    assert "const path = `/explorer/${encodeURIComponent(String(database || \"\"))}${tab ? `?tab=${encodeURIComponent(tab)}` : \"\"}`;" in controller
    api = read("src/static/app_api.js")
    assert "async function getSystemDisks(hostId, refresh = false, { signal } = {}) {" in api
    assert 'panel: "disk_growth"' in api
    docs = read("docs/system.md")
    assert "## Disks" in docs and "/api/system/disks" in docs
