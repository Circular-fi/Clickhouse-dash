"""No local formatter, escaper, locale call or raw colour in the frontend modules that draw data (docs/ui-foundations.md).

Numbers, sizes, durations, percentages and instants come from ns.format and the data colours from ns.palette and the semantic
tokens. Why: a local formatter is a second spelling of the same value (`1.2k` here, `1,234` there) and a raw colour does not
follow the theme. The allow-lists name the few uses that are justified, each with its reason, and a stale entry fails too.
Two groups of modules are scanned: the Observability pages (first half) and the Explorer, Query, Analysis and System modules.
"""
import importlib.util
import os
import re
import sys
from pathlib import Path

import css_sources
import modules

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ============================================================ Observability pages

def observability_modules() -> list[str]:
    """The page controller and the view modules it loads, minus the shared engines."""
    names = sorted({name for view in ("trace", "traces", "logs", "metrics") for name in modules.page_modules(view)})
    own = [n for n in names if re.match(r"app_(traces|trace_[a-z]+|logs|metrics)\.js$", n)]
    return ["app_obs_page.js", *own]


OBS_MODULES = observability_modules()

# Display formatting that ns.format replaces.
FORBIDDEN_CALLS = [
    (re.compile(r"\.toLocale(?:Date|Time)?String\("), "toLocaleString(): use ns.format (en-US counts, fmt.time)"),
    (re.compile(r"new Intl\.(?:NumberFormat|DateTimeFormat)\("), "an Intl formatter: use ns.format"),
    (re.compile(r"\bfunction (?:formatDuration|formatCount|compactCount|significant|formatInstant|formatStart|formatAgo|formatBucket|formatNumber|percentText\w*)\("), "a local formatter: use ns.format"),
    (re.compile(r"\bconst pad[23] = "), "a local date padder: use fmt.time"),
    (re.compile(r'"\\u2014"'), 'a literal "\\u2014": use fmt.EMPTY'),
    (re.compile(r"\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s?(?:ns|\u00b5s|ms|s|min|h|d)\b(?![\w-])"), "a hand-built duration: use fmt.duration"),
]

# Colour copies that ns.palette replaces.
FORBIDDEN_COLOURS = [
    (re.compile(r"(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])"), "a hex colour: use a token or ns.palette"),
    (re.compile(r"\b(?:rgba?|hsla?)\("), "an rgb()/hsl() colour: use a token"),
    (re.compile(r"getComputedStyle\([^)]*\)\.getPropertyValue\(\s*[\"'`]--"), "a CSS variable read: use ns.palette.resolve"),
    (re.compile(r"trace-span-color-|--qchart-|chdash\.traces\.serviceColors|SPAN_COLOR_COUNT|QUANTILE_COLORS"), "a palette copy: use ns.palette"),
]

# A toFixed() is geometry (a CSS length or percentage, an SVG coordinate, a
# data attribute) when its text ends the interpolation there; display text
# goes through ns.format.
GEOMETRY_AFTER_TOFIXED = re.compile(r'\}(?:%["\x27;]|px|,|"|`)')
TOFIXED_ALLOWED = {
    # Waterfall ticks of a deep zoom: the decimals adjacent ticks need to differ
    # ("50.003 ms", "50.005 ms"), after fmt.duration's own text.
    ("app_trace_model.js", "`${(ns / factor).toFixed(needed)} ${match[3]}`"),
    # Metric axis ticks: one decimal count for every tick of an axis.
    ("app_metrics.js", "const text = (value / formatter.factor).toFixed(decimals);"),
}



def lines(name: str):
    for number, line in enumerate(read(name).splitlines(), 1):
        if line.strip().startswith("//"):
            continue
        yield number, line


def test_no_local_formatters_in_observability_modules():
    offenders = []
    for name in OBS_MODULES:
        for number, line in lines(name):
            for pattern, why in FORBIDDEN_CALLS:
                if pattern.search(line):
                    offenders.append(f"{name}:{number}: {why}: {line.strip()[:120]}")
    assert not offenders, "\n".join(offenders)


def test_to_fixed_is_geometry_or_allow_listed():
    offenders = []
    for name in OBS_MODULES:
        for number, line in lines(name):
            if ".toFixed(" not in line or any(name == f and snippet in line for f, snippet in TOFIXED_ALLOWED):
                continue
            for match in re.finditer(r"\.toFixed\(\w*\)", line):
                after = line[match.end():]
                geometry = GEOMETRY_AFTER_TOFIXED.match(after)
                # `${x.toFixed(3)}%` is a style value only when assigned to one.
                styled = after.startswith("}%`") and (".style." in line or "setProperty(" in line)
                if not (geometry or styled):
                    offenders.append(f"{name}:{number}: {line.strip()[:140]}")
    assert not offenders, "toFixed() text outside ns.format:\n" + "\n".join(offenders)


def test_no_raw_colours_or_palette_copies_in_observability_modules():
    offenders = []
    for name in OBS_MODULES:
        for number, line in lines(name):
            for pattern, why in FORBIDDEN_COLOURS:
                if pattern.search(line):
                    offenders.append(f"{name}:{number}: {why}: {line.strip()[:120]}")
    assert not offenders, "\n".join(offenders)


CSS_COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
# Observability-only rules allowed a raw colour (none today).
CSS_COLOUR_ALLOWED: set[str] = set()


def source_rules():
    """(file, rule) for every style rule of the sources, inside @media too."""
    sys.path.insert(0, str(ROOT / "tools"))
    import css_tree

    def walk(nodes):
        for node in nodes:
            if isinstance(node, css_tree.Rule):
                yield node
            elif isinstance(node, css_tree.AtRule) and node.children is not None:
                yield from walk(node.children)

    for path, _ in css_sources.files():
        for rule in walk(css_tree.parse(path.read_text(encoding="utf-8"))):
            yield path.name, rule


def test_observability_only_css_rules_use_tokens():
    builder = css_sources.builder()
    query = builder.page_corpus("query")
    explorer = builder.page_corpus("explorer")
    observability = [builder.page_corpus(view) for view in ("trace", "traces", "logs", "metrics")]
    offenders, checked = [], 0
    for name, rule in source_rules():
        # Token definitions (:root, html[data-theme]) are where raw values belong.
        if not re.search(r"[.#][A-Za-z_-]", re.sub(r"html\[[^\]]*\]", "", rule.prelude)):
            continue
        selectors = rule.selectors
        if not any(builder.selector_can_match(s, corpus) for s in selectors for corpus in observability):
            continue
        if any(builder.selector_can_match(s, query) or builder.selector_can_match(s, explorer) for s in selectors):
            continue
        checked += 1
        body = "; ".join(d.value for d in rule.decls)
        if CSS_COLOUR.search(body) and rule.prelude not in CSS_COLOUR_ALLOWED:
            offenders.append(f"{name}:{rule.line}: {rule.prelude[:80]}")
    assert checked > 1000, checked
    assert not offenders, "raw colours in Observability rules:\n" + "\n".join(offenders)




# ============================================================ Explorer, Query, Analysis, System

MODULES = [
    # Explorer
    "app_explorer.js", "app_explorer_detail.js", "app_explorer_storage.js", "app_explorer_treemap.js",
    "app_explorer_graph.js",
    # System
    "app_system_activity.js",
    # Query, Analysis, Tracing
    "app_run.js", "app_results.js", "app_results_values.js", "app_results_cells.js", "app_results_sort.js", "app_results_rowdetails.js", "app_results_static.js", "app_results_table.js", "app_query_chart.js", "app_query_library.js", "app_analysis.js",
    "app_analysis_data.js", "app_pipeline_viewer.js", "app_trace_viewer.js",
    # Shared
    "app_header.js", "app_query_ui.js", "app_util.js",
]

# (module, finding) pairs that stay, with why.
ALLOWED = {
    # The shared helpers themselves: util.formatInt / formatBytes delegate to
    # ns.format; formatSeconds is documented as kept until its callers move;
    # escapeHtml is the one escaper.
    ("app_util.js", "formatter formatInt"), ("app_util.js", "formatter formatSeconds"), ("app_util.js", "formatter formatBytes"),
    ("app_util.js", "escaper"), ("app_util.js", "formatter escapeHtml"),
    # Result values are rendered raw (decision 45, docs/telemetry.md "Result
    # values"): these spell a value as ClickHouse sent it (the column's decimal scale).
    ("app_results_table.js", "formatter formatCellForDisplay"), ("app_results_values.js", "formatter formatCellForDisplayWithTypes"),
    ("app_results_values.js", "formatter formatNumericWithScale"), ("app_results_values.js", "formatter formatNumericCellText"),
    # The chart Number view before the chart engine (ns.chartCore.formatValue) loads.
    ("app_query_chart.js", "formatter formatFullNumber"), ("app_query_chart.js", "locale toLocaleString"),
    # Pipeline axis ticks: seconds with the precision the zoom window needs
    # ("1.234567 s"), which ns.format.duration rounds away.
    ("app_pipeline_viewer.js", "formatter timeLabel"),
    # SQL formatting, not a value format.
    ("app_run.js", "formatter formatEditorSql"),
    # The host ping label wraps ns.format.duration ("<1 ms" below a millisecond).
    ("app_header.js", "formatter formatPingMsLabel"),
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
    css = css_sources.text()
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


