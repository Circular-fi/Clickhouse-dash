"""Source contract of the Logs explorer (the Logs view of /observability and /api/logs/* routes)."""
import json
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
    # The page is /observability/logs (logs.html); /logs is gone; a view turned off falls back.
    assert "if (cfg_.traces.enabled || cfg_.logs.enabled || cfg_.metrics.enabled) {" in server
    assert 'if (cfg_.logs.enabled) http_.Get(R"(/observability/logs/?)", serve_view_shell("logs.html"));' in server
    assert 'http_.Get("/observability", redirect_to_first_view);' in server
    assert 'http_.Get("/logs"' not in server
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


def test_logs_view_follows_the_page_conventions():
    html = read("src/static/logs.html")
    section = html
    assert '<main id="logsWorkspace" data-obs-panel="logs" class="obsView ' in section
    assert '<div class="themeSelect tracePicker tracePicker--range">' in section
    assert 'id="obsTab-logs" data-obs-tab="logs" href="/observability/logs"' in html
    assert 'pageNav.traces !== true && pageNav.logs !== true' in html
    assert not (ROOT / "src/static/app_logs_bootstrap.js").exists()
    # The Logs page loads the Logs modules, and the other views' none.
    page = json.loads(read("src/static/modules.json"))["pages"]["logs"]
    assert page["bootstrap"] == "app_obs_page.js"
    assert page["modules"][-3:] == ["app_chart_core.js", "app_facet_panel.js", "app_logs.js"]
    assert "app_traces.js" not in page["modules"] and "app_metrics.js" not in page["modules"]


def test_logs_page_script_reuses_shared_pieces():
    js = read("src/static/app_logs.js")
    ui = read("src/static/app_ui.js")
    state = read("src/static/app_state.js")
    assert "timePicker = ns.timeRange.create(root, {" in js and 'idPrefix: "logs",' in js
    assert 'settingName: "logs.max_lookback_minutes",' in js
    # Service colours and formats are the shared ones (ns.palette, ns.format).
    # (the swatch is the shared ns.badge.swatchHtml, which reads palette.service)
    assert "ns.badge.swatchHtml(row.service)" in js and "palette.registerServices(" in js
    assert "chdash.traces.serviceColors" not in js and "SERVICE_COLOR_STORE_KEY" not in js
    assert 'params.set("bucket_origin_ms", String(localMidnight(range.start_ms)));' in js
    # The whole search lives in the URL: the Logs owner of ns.router.
    assert 'const address = ns.router.owner("logs", { path: "/observability/logs", params: () => urlParams() });' in js
    assert 'address.write(push ? "push" : "replace");' in js
    assert 'observability/traces/${encodeURIComponent(row.trace_id)}' in js
    assert "if (dom.navObservabilityButton) dom.navObservabilityButton.hidden = !observabilityEnabled;" in ui
    assert "logs: nav?.logs === true" in state
    assert "getLogs," in read("src/static/app_api.js")


def test_logs_suites_are_part_of_the_test_run():
    runner = read("tests/test-suite/run-all-tests.py")
    assert "test_logs_explorer.py" in runner
    assert "'specs/logs.spec.js'" in runner
