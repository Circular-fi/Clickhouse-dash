"""The Explorer and Query modules use the shared foundations (docs/ui-foundations.md).

Their numbers, sizes, durations, percentages and instants come from ns.format,
their data colours from ns.palette and the semantic tokens of style.css. This
contract fails when one of them grows a local formatter, an escaper, a
placeholder constant or a raw colour again. ALLOWED lists the few exceptions,
each with its reason.
"""
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"

MODULES = [
    # Explorer
    "app_explorer.js", "app_explorer_detail.js", "app_explorer_storage.js", "app_explorer_treemap.js",
    "app_explorer_ops.js", "app_explorer_graph.js",
    # Query, Analysis, Tracing
    "app_run.js", "app_results.js", "app_query_chart.js", "app_query_library.js", "app_analysis.js",
    "app_analysis_data.js", "app_pipeline_viewer.js", "app_trace_viewer.js",
    # Shared
    "app_ui.js", "app_util.js",
]

# (module, finding) pairs that stay, with why.
ALLOWED = {
    # The shared helpers themselves: util.formatInt / formatBytes delegate to
    # ns.format; formatSeconds is documented as kept until its callers move;
    # escapeHtml is the one escaper.
    ("app_util.js", "formatter formatInt"), ("app_util.js", "formatter formatSeconds"), ("app_util.js", "formatter formatBytes"),
    ("app_util.js", "escaper"), ("app_util.js", "formatter escapeHtml"),
    # Result values are rendered raw (decision 45): these spell a value as
    # ClickHouse sent it (JSON pretty printing, the column's decimal scale).
    ("app_results.js", "formatter formatCellForDisplay"), ("app_results.js", "formatter formatCellForDisplayWithTypes"),
    ("app_results.js", "formatter formatInline"), ("app_results.js", "formatter formatMultiline"),
    ("app_results.js", "formatter formatNumericWithScale"), ("app_results.js", "formatter formatNumericCellText"),
    # The chart Number view before the chart engine (ns.chartCore.formatValue) loads.
    ("app_query_chart.js", "formatter formatFullNumber"), ("app_query_chart.js", "locale toLocaleString"),
    # The Explorer data preview is result data too: the API's ISO value is
    # only shortened back to its ClickHouse text, never converted.
    ("app_explorer_detail.js", "formatter shortTimestamp"),
    # Pipeline axis ticks: seconds with the precision the zoom window needs
    # ("1.234567 s"), which ns.format.duration rounds away.
    ("app_pipeline_viewer.js", "formatter timeLabel"),
    # SQL formatting, not a value format.
    ("app_run.js", "formatter formatEditorSql"),
    # The host ping label wraps ns.format.duration ("<1 ms" below a millisecond).
    ("app_ui.js", "formatter formatPingMsLabel"),
    # History day headings ("Today", "Yesterday", "Mon, Sep 12"), en-US fixed.
    ("app_query_library.js", "locale toLocaleDateString"),
}

FORMATTER = re.compile(
    r"(?:\bfunction\s+|\b(?:const|let|var)\s+)("
    r"fmt[A-Z]\w*|format[A-Z]\w*|durationLabel|countLabel|plural|pad[23]|escapeHTML|escapeHtml|compactRows|ageLabel|"
    r"percentLabel|bytesLabel|timeLabel|dateLabel|shortTimestamp\w*|shortCatalogTime)\b"
)
LOCALE = re.compile(r"\.(toLocaleString|toLocaleTimeString|toLocaleDateString)\(|\bIntl\.(NumberFormat|DateTimeFormat)\b")
ESCAPER = re.compile(r"\.replace\(/&/g")
PLACEHOLDER = re.compile(r"\b(?:const|let)\s+\w+\s*=\s*\"(?:\\u2014|-)\";")
JS_COLOR = re.compile(r"(?<![&\w])#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d")
CSS_VAR_READ = re.compile(r"getPropertyValue\(\s*[\"'`]--")


def strip_js_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return re.sub(r"(^|[^:\"'`\\])//[^\n]*", r"\1", text)


def module_findings(name: str) -> list[tuple[str, int]]:
    text = strip_js_comments((STATIC / name).read_text(encoding="utf-8"))
    found = []
    for number, line in enumerate(text.split("\n"), 1):
        for match in FORMATTER.finditer(line):
            found.append((f"formatter {match.group(1)}", number))
        for match in LOCALE.finditer(line):
            found.append((f"locale {match.group(1) or 'Intl.' + match.group(2)}", number))
        if ESCAPER.search(line):
            found.append(("escaper", number))
        if PLACEHOLDER.search(line):
            found.append(("placeholder constant", number))
        if JS_COLOR.search(line):
            found.append(("raw colour", number))
        if CSS_VAR_READ.search(line):
            found.append(("computed --token read (use ns.palette.resolve)", number))
    return found


def test_explorer_and_query_modules_have_no_local_formatters_escapers_or_colours() -> None:
    offenders = []
    for name in MODULES:
        for finding, number in module_findings(name):
            if (name, finding) not in ALLOWED:
                offenders.append(f"{name}:{number}: {finding}")
    assert not offenders, "use ns.format / ns.palette / util.escapeHtml (docs/ui-foundations.md):\n" + "\n".join(offenders)


def test_allow_list_has_no_stale_entries() -> None:
    present = {(name, finding) for name in MODULES for finding, _ in module_findings(name)}
    stale = sorted(f"{name}: {finding}" for name, finding in ALLOWED if (name, finding) not in present)
    assert not stale, "remove these ALLOWED entries:\n" + "\n".join(stale)


def test_migrated_modules_read_the_shared_foundations() -> None:
    for name in ["app_explorer.js", "app_explorer_detail.js", "app_explorer_storage.js", "app_explorer_ops.js",
                 "app_explorer_graph.js", "app_run.js", "app_query_library.js", "app_analysis.js", "app_pipeline_viewer.js"]:
        assert "const format = ns.format;" in (STATIC / name).read_text(encoding="utf-8"), name
    treemap = (STATIC / "app_explorer_treemap.js").read_text(encoding="utf-8")
    assert "const { format, palette } = ns;" in treemap and "palette.categorical(" in treemap
    viewer = (STATIC / "app_trace_viewer.js").read_text(encoding="utf-8")
    assert "const { format, palette } = ns;" in viewer and "palette.categorical(span.attempt)" in viewer
    assert "ATTEMPT_COLORS" not in viewer
    chart = (STATIC / "app_query_chart.js").read_text(encoding="utf-8")
    assert "return ns.palette.categorical(slot);" in chart
    run = (STATIC / "app_run.js").read_text(encoding="utf-8")
    assert 'ns.palette.resolve("--border")' in run and 'ns.palette.resolve("--accent-fill")' in run
    # Explorer instants: the server's DateTime text in the browser's zone, the
    # server value in the tooltip (decision 48).
    ui = (STATIC / "app_ui.js").read_text(encoding="utf-8")
    assert "return ns.format.serverTime(value, { serverTz: serverTimeZone(hostId), precision });" in ui
    for name in ["app_explorer.js", "app_explorer_detail.js", "app_explorer_ops.js"]:
        assert "ui.serverTime(" in (STATIC / name).read_text(encoding="utf-8"), name
    hosts = (ROOT / "src" / "api_hosts.cpp").read_text(encoding="utf-8")
    assert 'w.Key("clickhouse_timezone");' in hosts
    assert '"SELECT version(), timezone()"' in (ROOT / "src" / "health_runner.cpp").read_text(encoding="utf-8")


# ---------------------------------------------------------------------- CSS

# Rules whose first class names one of these modules' components.
CSS_PREFIXES = re.compile(
    r"^(explorer|queryChart|queryLibrary|ql[A-Z]|qh[A-Z]|metricCompact|resultTable|tok-|analysis|pipelineViewer|"
    r"traceViewer|jsonPretty|hostDot|nullToken|statusPill|runMenu|runSettings|panel--query|panel--metrics|tableWrap)"
)
# Neutral black / white / slate shadows, scrims and text on a coloured fill
# carry no hue; every hue is a token.
NEUTRAL = re.compile(
    r"#(?:fff|ffffff|000|000000)\b|rgba?\(\s*(?:0,\s*0,\s*0|255,\s*255,\s*255|2,\s*6,\s*23|15,\s*23,\s*42)\b"
)
CSS_COLOR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d[^)]*\)")


def css_rules(text: str):
    clean = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    stack, buf, line = [], [], 1
    start_line = 1
    for ch in clean:
        if ch == "{":
            stack.append(("".join(buf).strip(), line))
            buf = []
            start_line = line
        elif ch == "}":
            body = "".join(buf)
            selector, _ = stack.pop() if stack else ("", line)
            yield selector, line - body.count("\n"), body
            buf = []
        else:
            buf.append(ch)
        if ch == "\n":
            line += 1


def test_explorer_and_query_css_names_tokens_not_hues() -> None:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    offenders = []
    for selector, first_line, body in css_rules(css):
        match = re.search(r"\.([A-Za-z][\w-]*)", selector)
        if not match or not CSS_PREFIXES.search(match.group(1)):
            continue
        for offset, decl in enumerate(body.split("\n")):
            for color in CSS_COLOR.finditer(decl):
                if NEUTRAL.match(color.group(0)):
                    continue
                offenders.append(f"style.css:{first_line + offset}: {selector.splitlines()[0][:60]} | {decl.strip()[:90]}")
    assert not offenders, "use the semantic / kind / categorical tokens (docs/ui-foundations.md):\n" + "\n".join(offenders)


def test_object_kinds_take_the_kind_tokens_in_the_tree_and_the_lineage_icons() -> None:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    # Dictionary amber and buffer teal in both views (the tree had them swapped).
    for rule in [
        ".explorerTreeObject__icon--dict { color: var(--kind-dict); }",
        ".explorerTreeObject__icon--buffer { color: var(--kind-buffer); }",
        ".explorerTreeObject__icon--view { color: var(--kind-view); }",
        ".explorerTreeObject__icon--mv { color: var(--kind-mv); }",
        ".explorerTreeObject__icon--distributed { color: var(--kind-distributed); }",
        ".explorerObjIcon--dictionary { color: var(--kind-dict); }",
        ".explorerObjIcon--buffer { color: var(--kind-buffer); }",
    ]:
        assert rule in css, rule
    badge = css[css.index(".explorerMiniHealth--healthy,"):css.index(".explorerMiniHealth--error,") + 400]
    for token in ("var(--success)", "var(--warning)", "var(--danger)"):
        assert token in badge, token
    assert ".jsonPretty .jStr { color: var(--json-string); }" in css
    assert ".jsonPretty .jNum { color: var(--json-number); }" in css
    assert ".jsonPretty .jBool { color: var(--json-bool); }" in css
