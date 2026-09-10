from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_frontend_fixture_is_deterministic_synthetic_weather_only() -> None:
    fixture = read("tests/clickhouse-init/02-frontend-fixtures.sql")
    assert "CREATE TABLE chdash_ui.weather_observations" in fixture
    assert "CREATE MATERIALIZED VIEW chdash_ui.weather_daily_summary_mv" in fixture
    assert "CREATE DICTIONARY chdash_ui.station_dictionary" in fixture
    assert "synthetic-weather" in fixture
    assert "WX-PAR-01" in fixture and "WX-REK-02" in fixture and "WX-LIS-03" in fixture
    assert "arrayElement(['Paris', 'Reykjavik', 'Lisbon', 'Oslo', 'Rome']" in fixture
    assert fixture.count("FROM numbers(40000)") == 3


def test_project_authored_sources_do_not_embed_business_fixture_names() -> None:
    def word(*parts: str) -> re.Pattern[str]:
        return re.compile(r"\b" + "".join(parts) + r"\b", re.I)

    needles = [
        word("cir", "cular"),
        word("kev", "red"),
        word("nan", "sen"),
        word("raku", "rai"),
        word("fa", "st"),
        word("pro", "vider"),
        word("tip", "share"),
        word("user", "_plans"),
        re.compile("dark" + "_tip", re.I),
        word("blocks", "_markets"),
    ]
    roots = [ROOT / "src", ROOT / "tests", ROOT / "README.md", ROOT / "CHANGELOG_AGENT.md", ROOT / "INTERMEDIATE_STATUS.md"]
    offenders = []
    for root in roots:
        paths = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
        for path in paths:
            if any(part in {"build", "node_modules", "third_party", "__pycache__"} for part in path.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for needle in needles:
                if needle.search(text):
                    offenders.append(f"{path.relative_to(ROOT)}: {needle.pattern}")
    assert offenders == []


def test_formatter_preserves_quoted_alias_boundary_before_from() -> None:
    formatter = read("src/api_format.cpp")
    live_test = read("tests/api/format/check_format.py")
    assert "while (begin < sql.size() && std::isspace" in formatter
    assert "sql[begin] == '-' && sql[begin + 1] == '-'" in formatter
    assert "sql[begin] == '/' && sql[begin + 1] == '*'" in formatter
    assert "if (sql[begin] == '`' || sql[begin] == '\"') continue;" in formatter
    assert "test_format_quoted_alias_does_not_consume_following_from_clause" in live_test
    assert "FROM system.parts" in live_test
    assert 'assert "`FROM` system.parts" not in formatted' in live_test


def test_trace_viewer_is_compact_resizable_and_uses_service_marker() -> None:
    viewer = read("src/static/app_trace_viewer.js")
    css = read("src/static/style.css")
    assert 'className = "traceViewer__toolbar"' not in viewer
    assert 'className = "traceViewer__serviceMarker"' in viewer
    assert 'className = "traceViewer__columnResize"' in viewer
    assert 'left >= 50 ? " is-before" : " is-after"' in viewer
    assert "columnResize.setPointerCapture" in viewer
    assert "columnResize.addEventListener(\"dblclick\"" in viewer
    assert "scrollbar-gutter: stable;" in css
    assert re.search(r"\.traceViewer__row\s*\{[^}]*min-height:\s*26px", css, re.S)
    assert re.search(r"\.traceViewer__bar\s*\{[^}]*height:\s*9px", css, re.S)
    identity = re.search(r"\.traceViewer__identity\s*\{([^}]*)\}", css, re.S)
    assert identity and "box-shadow" not in identity.group(1)
    row = re.search(r"\.traceViewer__row\s*\{([^}]*)\}", css, re.S)
    assert row and "border-bottom" not in row.group(1)


def test_graph_sidebar_can_reveal_offscreen_focus_without_moving_canvas_clicks() -> None:
    graph = read("src/static/app_explorer_graph.js")
    explorer = read("src/static/app_explorer.js")
    assert "function nodeIsOnScreen(" in graph
    assert "function ensureNodeVisible(" in graph
    assert "function focusTable(database, table, { ensureVisible = false } = {})" in graph
    assert "const needsFit = shouldEnsure && !nodeIsOnScreen(id);" in graph
    assert "setFocus(id, needsFit, { preserveDepth: true });" in graph
    assert "graph?.focusTable?.(database, table, { ensureVisible: !graphOrigin });" in explorer
    assert "selectTable(database, table, false, { graphOrigin: true });" in explorer


def test_graph_focus_animation_uses_one_normalized_marker_only_for_real_flow_edges() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "function isFocusedDepthOneEdge(edge)" in graph
    assert "edge.from === model.focusedId || edge.to === model.focusedId" in graph
    assert "function isInsertFlowEdge(edge)" in graph
    assert 'return kind === "buffer" || kind === "materialized_view" || kind === "materialized_view_output";' in graph
    assert "function drawNormalizedFlowMarker(" in graph
    assert 'drawNormalizedFlowMarker(ctx, edge, now, routePoints || bezierRoutePoints(a, p1, p2, b));' in graph
    assert "focusEdgeAnimationStyle" not in graph
    assert "drawFocusEdgeMarker" not in graph
    assert 'kind === "view"' not in graph[graph.index("function isInsertFlowEdge(edge)"):graph.index("function isStorageRouteEdge(edge)")]


def test_refresh_controls_use_thin_svg_glyphs() -> None:
    html = read("src/static/explorer.html")
    css = read("src/static/style.css")
    assert html.count('class="refreshGlyph"') >= 3
    assert "stroke-width: 1.2;" in css
    assert "stroke-linecap: round;" in css
    assert "stroke-linejoin: round;" in css
