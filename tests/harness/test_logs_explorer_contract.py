"""Source contract of the Logs explorer (/logs page and /api/logs/* routes)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_logs_routes_are_registered_only_when_logs_are_enabled():
    server = read("src/server.cpp")
    header = read("src/server.hpp")
    block = server[server.index("  if (cfg_.logs.enabled) {\n    http_.Get(\"/api/logs/search\""):]
    block = block[:block.index("  }\n") + 4]
    for route in ("search", "histogram", "context", "patterns", "services"):
        assert f'http_.Get("/api/logs/{route}"' in block, route
        assert f"void handle_logs_{route}(const httplib::Request& req, httplib::Response& res);" in header, route
    assert 'http_.Get("/logs", serve_logs_shell);' in server
    assert 'shell_req.path = "/logs.html";' in server
    assert "api_logs.cpp" in read("src/CMakeLists.txt")


def test_service_allowlist_predicate_is_shared_by_traces_and_logs():
    header = read("src/otel_allowlist.hpp")
    traces = read("src/api_traces.cpp")
    logs = read("src/api_logs.cpp")
    assert "inline std::string service_allowlist_predicate(const TraceSettings& cfg)" in header
    assert "inline std::string service_pattern_predicate(std::string_view pattern)" in header
    for source in (traces, logs):
        assert '#include "otel_allowlist.hpp"' in source
    assert "std::string service_allowlist_predicate(const TraceSettings& cfg) {" not in traces
    assert "service_allowlist_predicate(cfg.traces)" in logs
    assert "service_allowlist_predicate(cfg_.traces)" in logs


def test_search_uses_keyset_cursors_progressive_windows_and_guards():
    logs = read("src/api_logs.cpp")
    assert " OFFSET " not in logs
    assert "constexpr int64_t kSearchWindowsSeconds[] = {15 * 60, 60 * 60, 6 * 60 * 60, 24 * 60 * 60};" in logs
    assert 'std::string out = "cityHash64(ServiceName";' in logs
    assert '" ORDER BY Timestamp DESC, " + tie + " DESC LIMIT "' in logs
    assert "std::string keyset_predicate(const std::string& tie_expr, const Cursor& c, bool older)" in logs
    assert "max_execution_time = " in logs and "max_rows_to_read = " in logs
    assert "read_overflow_mode = 'throw'" in logs
    assert '"logs_scan_limit"' in logs and '"logs_timeout"' in logs
    # Coarse TimestampTime bound (primary key) plus the exact Timestamp one.
    assert '"TimestampTime >= toDateTime("' in logs
    assert "cfg_.logs.search_limit" in logs


def test_body_search_splits_tokens_before_hastoken():
    logs = read("src/api_logs.cpp")
    assert "std::vector<std::string> split_tokens(std::string_view text)" in logs
    assert 'parts.push_back("hasToken(" + body + ", " + quote(token) + ")");' in logs
    assert '"position(Body, "' in logs
    assert '"logs_body_search_disabled"' in logs
    assert "kSubstringWindowSeconds" in logs and '"logs_substring_range"' in logs
    assert "ILIKE" in logs


def test_histogram_context_and_patterns():
    logs = read("src/api_logs.cpp")
    assert 'parse_i64(param(req, "bucket_origin_ms"), &origin);' in logs
    assert "countIf(SeverityNumber >= 17)" in logs
    for preset in ("anything", "service", "host", "trace"):
        assert f'"{preset}"' in logs, preset
    assert "ResourceAttributes['host.name'] = " in logs
    assert "cityHash64(_part, intDiv(_part_offset, 64)) % 1000000 < " in logs
    assert "class Drain {" in logs
    assert 'w.Key("noisy"); w.Bool(share > 0.10);' in logs
    assert "std::string mask_body(std::string_view body)" in logs


def test_logs_page_shell_follows_the_page_conventions():
    html = read("src/static/logs.html")
    assert '<body data-page="logs">' in html
    assert "document.write('<link rel=\"stylesheet\" href=\"' + cssHref + '\">');" in html
    assert 'localStorage.getItem("chdash.pageNav.v1")' in html
    assert 'pageNav.traces !== true && pageNav.logs !== true' in html
    assert 'aria-expanded="false">Logs</button>' in html
    assert 'data-value="logs" aria-selected="true">Logs</button>' in html
    assert 'static/app_logs_bootstrap.js' in html
    assert '<div class="themeSelect tracePicker tracePicker--range">' in html
    for page in ("query.html", "explorer.html", "traces.html"):
        shell = read(f"src/static/{page}")
        assert '<button id="navLogsButton" class="themeSelect__option" type="button" role="option" data-value="logs" aria-selected="false" hidden>Logs</button>' in shell, page
    bootstrap = read("src/static/app_logs_bootstrap.js")
    assert '"app_timerange.js", "app_logs.js"' in bootstrap


def test_logs_page_script_reuses_shared_pieces():
    js = read("src/static/app_logs.js")
    ui = read("src/static/app_ui.js")
    state = read("src/static/app_state.js")
    assert "timePicker = ns.timeRange.mountPicker(" in js
    assert 'settingName: "logs.max_lookback_minutes",' in js
    assert 'const SERVICE_COLOR_STORE_KEY = "chdash.traces.serviceColors";' in js
    assert 'params.set("bucket_origin_ms", String(localMidnight(range.start_ms)));' in js
    assert "window.history.pushState({ workspace: \"logs\" }, \"\", next);" in js
    assert 'traces/${encodeURIComponent(row.trace_id)}' in js
    assert "if (dom.navLogsButton) dom.navLogsButton.hidden = !logsEnabled;" in ui
    assert "logs: nav?.logs === true" in state
    assert "getLogs," in read("src/static/app_api.js")


def test_logs_suites_are_part_of_the_test_run():
    runner = read("tests/test-suite/run-all-tests.py")
    assert "test_logs_explorer.py" in runner
    assert "'specs/logs.spec.js'" in runner
