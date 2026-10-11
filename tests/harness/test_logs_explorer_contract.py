"""Source contract of the Logs explorer (the Logs view of /observability and /api/logs/* routes)."""
import modules
import json
from pathlib import Path
from logs_sources import read_logs, read_unit
from trace_sources import read_traces

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_logs_routes_are_registered_only_when_logs_are_enabled():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    block = server[server.index("  if (cfg_.logs_on()) {\n    http_.Get(\"/api/logs/search\""):]
    block = block[:block.index("  }\n") + 4]
    for route in ("search", "histogram", "context", "patterns", "services"):
        assert f'http_.Get("/api/logs/{route}"' in block, route
        assert f"void handle_logs_{route}(const httplib::Request& req, httplib::Response& res);" in header, route
    # The page is /observability/logs (logs.html); /logs is gone; a view turned off falls back.
    assert "if (cfg_.traces_on() || cfg_.logs_on() || cfg_.metrics_on()) {" in server
    assert 'if (cfg_.logs_on()) http_.Get(R"(/observability/logs/?)", serve_view_shell("logs.html"));' in server
    assert 'http_.Get("/observability", redirect_to_first_view);' in server
    assert 'http_.Get("/logs"' not in server
    assert "api_logs.cpp" in read("src/CMakeLists.txt")


def test_service_allowlist_predicate_is_shared_by_traces_and_logs():
    header = read("src/otel_allowlist.hpp")
    traces = read_traces()
    filters = read_unit("logs_filters.cpp")
    assert "inline std::string service_allowlist_predicate(const TraceSettings& cfg)" in header
    assert "inline std::string service_pattern_predicate(std::string_view pattern)" in header
    for source in (traces, filters):
        assert '#include "otel_allowlist.hpp"' in source
    assert "std::string service_allowlist_predicate(const TraceSettings& cfg) {" not in traces
    # The filters of every route but the context, and the preset of the context.
    assert filters.count("otel::service_allowlist_predicate(otel.traces)") == 2


def test_search_uses_keyset_cursors_progressive_windows_and_guards():
    service = read_unit("logs_service.hpp")
    sql = read_unit("logs_sql.cpp")
    logs = read_logs()
    assert " OFFSET " not in logs
    assert "constexpr int64_t kSearchWindowsSeconds[] = {15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60};" in service
    assert 'std::string out = "cityHash64(ServiceName";' in sql
    assert '" ORDER BY Timestamp DESC, " + tie' in sql and '" DESC LIMIT "' in sql
    assert "std::string keyset_predicate(const std::string& tie_expr, const Cursor& cursor, bool older)" in sql
    assert "max_execution_time = " in sql and "max_rows_to_read = " in sql
    assert "read_overflow_mode = 'throw'" in sql
    # A failure is an answer by its ClickHouse code (error_from_clickhouse, api_error.cpp): <area>_scan_limit and <area>_timeout.
    error = read("src/api_error.cpp")
    assert 'name + "_scan_limit"' in error and 'name + "_timeout"' in error
    assert 'error_from_clickhouse(e, "logs", "logs_search_failed")' in read_unit("logs_service.cpp")
    # Coarse TimestampTime bound (primary key) plus the exact Timestamp one.
    assert '"TimestampTime >= toDateTime("' in sql
    assert "host.otel.logs.search_limit" in read_unit("logs_service.cpp")


def test_body_search_splits_tokens_before_hastoken():
    filters = read_unit("logs_filters.cpp")
    text = read("src/logs_text.cpp")  # the text search: pure functions (tests/native/logs_test.cpp)
    service = read_unit("logs_service.cpp")
    logs = read_logs()
    assert "std::vector<std::string> split_tokens(std::string_view text)" in text
    assert 'parts.push_back("hasToken(" + body + ", " + params.text(token) + ")");' in text
    # What the user wrote reaches ClickHouse as a query parameter ({pN:String}), never inside the SQL text.
    for written in ('" AND ServiceName IN (" + params.texts(input.services) + ")"', '" AND TraceId = " + params.text(input.trace_id)',
                    '" = " + params.text(value)'):
        assert written in filters, written
    assert 'params.text("%" + like_escape(term.text) + "%")' in text
    assert "quote(services" not in logs and "quote(value)" not in logs and "quote(term.text)" not in logs + text
    # Every statement sends the values of its filters, and the key of a cache holds them.
    assert logs.count("statement.params = query.params;") >= 7 and "statement.params.list()" in service
    assert "q.params.key()" in service
    assert '"position(Body, "' in text
    assert '"logs_body_search_disabled"' in filters
    assert "kSubstringWindowSeconds" in service and '"logs_substring_range"' in service
    assert "ILIKE" in text


def test_histogram_context_and_patterns():
    sql = read_unit("logs_sql.cpp")
    request = read_unit("logs_request.cpp")
    assert 'out.bucket_origin_ms = int_param(req, "bucket_origin_ms");' in request
    assert "countIf(SeverityNumber >= 17)" in sql
    context = read_unit("logs_filters.cpp")
    for preset in ("anything", "service", "host", "trace"):
        assert f'"{preset}"' in context, preset
    assert "ResourceAttributes['host.name'] = " in context
    assert "cityHash64(_part, intDiv(_part_offset, " in sql and "% 1000000 < " in sql
    assert "class Drain {" in read("src/logs_drain.hpp")
    assert "pattern.noisy = pattern.share > 0.10;" in read_unit("logs_patterns.cpp")
    assert "std::string mask_body(std::string_view body)" in read("src/logs_drain.cpp")


def test_logs_routes_are_adapters_over_the_service():
    routes = read("src/api_logs.cpp")
    for route, call in (("search", "search"), ("histogram", "histogram"), ("context", "context"), ("patterns", "patterns"),
                        ("services", "services"), ("facets", "facets"), ("facet_values", "facet_values")):
        body = routes[routes.index(f"void Server::handle_logs_{route}("):]
        body = body[:body.index("\n}\n")]
        assert f"logs_service_.{call}(current_request_context()" in body, route
        assert "ch_select" not in body and "SELECT" not in body, route
    # No ClickHouse client and no SQL in the adapters.
    assert "clickhouse::Client" not in routes and "ch_select" not in routes and "SELECT" not in routes
    # The service has no HTTP in it.
    for name in ("logs_service.cpp", "logs_service.hpp", "logs_sql.cpp", "logs_filters.cpp", "logs_patterns.cpp"):
        assert "httplib::Response" not in read_unit(name), name
    assert "logs_service.cpp" in read("src/CMakeLists.txt") and "logs_json.cpp" in read("src/CMakeLists.txt")


def test_logs_view_follows_the_page_conventions():
    html = read("src/static/logs.html")
    section = html
    assert '<main id="logsWorkspace" data-obs-panel="logs" class="obsView ' in section
    assert '<div class="themeSelect tracePicker tracePicker--range">' in section
    assert 'id="obsTab-logs" data-obs-tab="logs" href="/observability/logs"' in html
    assert 'pageNav.traces !== true && pageNav.logs !== true' in html
    assert not (ROOT / "src/static/app_logs_bootstrap.js").exists()
    # The Logs page loads the Logs modules, and the other views' none.
    files = modules.page_files("logs")
    assert files[-1] == "app_page_logs.js" and "app_obs_page.js" in files
    assert {"app_chart_core.js", "app_facet_panel.js", "app_logs.js"} <= set(files)
    assert "app_traces.js" not in files and "app_metrics.js" not in files


def test_logs_page_script_reuses_shared_pieces():
    js = read("src/static/app_logs.js")
    ui = read("src/static/app_header.js") + read("src/static/app_query_ui.js")
    state = read("src/static/app_state.js")
    assert "timePicker = timeRange.create(root, {" in js and 'idPrefix: "logs",' in js
    assert 'settingName: "logs.max_lookback_minutes",' in js
    # Service colours and formats are the shared ones (ns.palette, ns.format).
    # (the swatch is the shared ns.badge.swatchHtml, which reads palette.service)
    assert "badge.swatchHtml(row.service)" in js and "palette.registerServices(" in js
    assert "chdash.traces.serviceColors" not in js and "SERVICE_COLOR_STORE_KEY" not in js
    assert 'params.set("bucket_origin_ms", String(timeRange.localMidnight(range.start_ms)));' in js
    # The whole search lives in the URL: the Logs owner of ns.router.
    assert 'const address = router.owner("logs", { path: "/observability/logs", params: () => urlParams() });' in js
    assert 'address.write(push ? "push" : "replace");' in js
    assert 'observability/traces/${encodeURIComponent(row.trace_id)}' in js
    assert "if (dom.navObservabilityLink) dom.navObservabilityLink.hidden = !observabilityEnabled;" in ui
    assert "logs: nav?.logs === true" in state
    assert "getLogs," in read("src/static/app_api.js")


def test_logs_suites_are_part_of_the_test_run():
    runner = read("tests/test-suite/run-all-tests.py")
    assert "test_logs_explorer.py" in runner
    assert "'specs/logs.spec.js'" in runner
