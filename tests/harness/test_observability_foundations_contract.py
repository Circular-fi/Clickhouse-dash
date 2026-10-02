"""Observability formats and colours come from the shared foundations.

Every Observability module (Traces and its submodules, Logs, Metrics, the
page controller) prints numbers, sizes, durations and instants through
ns.format and picks data colours through ns.palette and the semantic tokens
(docs/ui-foundations.md). These checks fail on a new local formatter or a raw
colour in those modules and in the Observability-only rules of style.css; the
allow-lists name the few uses that are justified.
"""
import importlib.util
import re
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATIC = ROOT / "src" / "static"


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def observability_modules() -> list[str]:
    """The page controller and the view modules it loads, minus the shared engines."""
    views = json.loads(read("modules.json"))["pages"]["observability"]["views"]
    names = sorted({name for files in views.values() for name in files})
    own = [n for n in names if re.match(r"app_(traces|trace_[a-z]+|logs|metrics)\.js$", n)]
    return ["app_observability.js", *own]


MODULES = observability_modules()

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
    ("app_traces.js", "`${(ns / factor).toFixed(needed)} ${match[3]}`"),
    # Metric axis ticks: one decimal count for every tick of an axis.
    ("app_metrics.js", "const text = (value / formatter.factor).toFixed(decimals);"),
}


def lines(name: str):
    for number, line in enumerate(read(name).splitlines(), 1):
        if line.strip().startswith("//"):
            continue
        yield number, line


def test_observability_modules_are_listed():
    assert {"app_traces.js", "app_trace_search.js", "app_trace_spans.js", "app_trace_services.js", "app_trace_insights.js",
            "app_trace_logs.js", "app_trace_heatmap.js", "app_trace_views.js", "app_trace_map.js", "app_trace_tabs.js",
            "app_logs.js", "app_metrics.js", "app_observability.js"} <= set(MODULES)


def test_no_local_formatters_in_observability_modules():
    offenders = []
    for name in MODULES:
        for number, line in lines(name):
            for pattern, why in FORBIDDEN_CALLS:
                if pattern.search(line):
                    offenders.append(f"{name}:{number}: {why}: {line.strip()[:120]}")
    assert not offenders, "\n".join(offenders)


def test_to_fixed_is_geometry_or_allow_listed():
    offenders = []
    for name in MODULES:
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
    for name in MODULES:
        for number, line in lines(name):
            for pattern, why in FORBIDDEN_COLOURS:
                if pattern.search(line):
                    offenders.append(f"{name}:{number}: {why}: {line.strip()[:120]}")
    assert not offenders, "\n".join(offenders)


def test_trace_helpers_no_longer_share_formats_and_colours_through_ctx():
    traces = read("app_traces.js")
    init = traces[traces.index("  function init() {"):]
    for name in ("formatDuration", "serviceColor", "registerServiceColors", "bucketRangeLabel", "dayLabel", "clockLabel"):
        assert not re.search(rf"\b{name}\b", init), name
    for name in MODULES:
        assert not re.search(r"ctx\??\.(?:formatDuration|serviceColor|registerServiceColors|bucketRangeLabel)\b", read(name)), name
    for name in ("app_traces.js", "app_logs.js", "app_metrics.js"):
        source = read(name)
        assert "const fmt = ns.format;" in source and "const palette = ns.palette;" in source, name


def load_builder():
    spec = importlib.util.spec_from_file_location("build_page_css", ROOT / "tools" / "build_page_css.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def css_rules(builder, css: str, start: int = 0, end: int | None = None):
    """(prelude, body start, body end) of every style rule, inside @media too."""
    end = len(css) if end is None else end
    i, prelude_start = start, start
    while i < end:
        j = builder.skip_comment_or_string(css, i)
        if j != i:
            i = j
            continue
        if css[i] == ";":
            i += 1
            prelude_start = i
        elif css[i] == "{":
            prelude = builder.strip_comments(css[prelude_start:i]).strip()
            close = builder.read_block(css, i + 1)
            if prelude.startswith(("@media", "@supports", "@layer", "@container")):
                yield from css_rules(builder, css, i + 1, close - 1)
            elif not prelude.startswith("@"):
                yield prelude, i + 1, close - 1
            i = close
            prelude_start = i
        else:
            i += 1


CSS_COLOUR = re.compile(r"#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(")
# Observability-only rules allowed a raw colour (none today).
CSS_COLOUR_ALLOWED: set[str] = set()


def test_observability_only_css_rules_use_tokens():
    builder = load_builder()
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    query = builder.Corpus(builder.page_corpus("query"))
    explorer = builder.Corpus(builder.page_corpus("explorer"))
    observability = builder.Corpus(builder.observability_corpus(None))
    offenders, checked = [], 0
    for prelude, start, end in css_rules(builder, css):
        # Token definitions (:root, html[data-theme]) are where raw values belong.
        if not re.search(r"[.#][A-Za-z_-]", re.sub(r"html\[[^\]]*\]", "", prelude)):
            continue
        selectors = builder.split_selector_list(prelude)
        if not any(builder.selector_can_match(s, observability) for s in selectors):
            continue
        if any(builder.selector_can_match(s, query) or builder.selector_can_match(s, explorer) for s in selectors):
            continue
        checked += 1
        body = builder.strip_comments(css[start:end])
        if CSS_COLOUR.search(body) and prelude not in CSS_COLOUR_ALLOWED:
            line = css.count("\n", 0, start) + 1
            offenders.append(f"style.css:{line}: {prelude[:80]}")
    assert checked > 1000, checked
    assert not offenders, "raw colours in Observability rules:\n" + "\n".join(offenders)


def test_old_observability_colour_families_are_gone():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    for family in ("--log-sev-", "--trace-log-", "--traceError", "--traceWarn", "--trace-error", "--trace-warning", "--traceKv"):
        assert family not in css, family
    # One severity mapping: [data-sev] -> --sev-color from the --sev-* tokens.
    for level in ("fatal", "error", "warn", "info", "debug"):
        assert f'[data-sev="{level}"] {{ --sev-color: var(--sev-{level}); }}' in css
