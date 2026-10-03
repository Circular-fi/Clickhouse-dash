"""One DOM-building convention (docs/ui-foundations.md, "Building elements").

- ns.h (app_dom.js) builds elements; the local node() / el() / element()
  copies stay gone, and so do the local byId / $ lookups: dom.byId,
  dom.$(selector, root) and dom.$$(selector, root) are the only lookups.
- Markup goes in deliberately. A module may write innerHTML / outerHTML or
  call insertAdjacentHTML only when it is on ALLOWED below, with its reason,
  and no more often than its count says (lower the count when a site goes).
- A template literal written straight into one of those sinks interpolates
  only escaped values (util.escapeHtml or the module's esc alias), markup of
  a builder that escapes (a *Html() function, badge.html), numbers and
  constants: an API value never reaches the markup unescaped.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
DOC = ROOT / "docs" / "ui-foundations.md"

# module -> (markup writes, why they stay markup). Every value they print goes
# through util.escapeHtml (the module's esc alias) or a component that escapes.
HOT = "virtualised / per-frame string renderer, measured faster than building nodes (docs: Building elements)"
ALLOWED: dict[str, tuple[int, str]] = {
    # The element builder itself: h.html() parses trusted markup in a <template>.
    "app_dom.js": (1, "h.html(), the one explicit markup path of ns.h"),
    # Components: each *Html() builder escapes; these are its element variants.
    "app_ui_badge.js": (1, "badge.el(): the element of badge.html(), which escapes"),
    "app_ui_chart.js": (1, "sparkline.draw(): the sparkline SVG of numbers"),
    "app_ui_copy.js": (1, "the copy button's static icon"),
    "app_ui_kv.js": (1, "kvList(): the element of kvListHtml(), which escapes"),
    "app_ui_panel.js": (4, "panel heads, actions and bodies given as trusted markup (html: true) by their callers, and the drawer icon"),
    "app_ui_popover.js": (3, "tips and popovers given trusted markup (html: true) by their callers"),
    "app_ui_segmented.js": (1, "segmented.render(): the element of segmented.html(), which escapes"),
    "app_ui_sql.js": (4, "the SQL highlighter output (it escapes every token)"),
    "app_ui_stat.js": (1, "statTile(): the element of statTileHtml(), which escapes"),
    "app_ui_state.js": (3, "empty / error / loading blocks and the banner, every text escaped; the static spinner"),
    "app_util.js": (1, "highlightJsonHtml(): JSON escaped, then coloured"),
    # Editors and charts.
    "app_highlight.js": (4, "the SQL editor overlay: highlighter tokens, each escaped, " + HOT),
    "app_autocomplete.js": (2, "highlighted SQL snippets of the completion menu (the highlighter escapes)"),
    "app_chart_core.js": (5, "the chart engine: its static skeleton, legend and pointer tooltips, labels escaped; tooltips are " + HOT),
    "app_query_chart.js": (1, "the static skeleton of the chart panel"),
    "app_explorer_treemap.js": (1, "treemap tiles, up to thousands of rectangles, names escaped: " + HOT),
    "app_results.js": (2, "the NULL token template and the row Details copy action (component markup)"),
    "app_ui.js": (1, "the library dialog's loading blocks (ns.uiState)"),
    "app_timerange.js": (4, "the time range panel: static skeleton, calendar grid of numbers, quick ranges escaped"),
    "app_observability.js": (1, "re-attaches a hidden view's own markup (its outerHTML, kept when it was detached)"),
    # Observability string renderers.
    "app_traces.js": (14, "trace list, table, overview, header and the waterfall rows, every value escaped; the waterfall is " + HOT),
    "app_trace_views.js": (10, "statistics, spans table, flame graph and graph panel: escaped string renderers of up to thousands of rows"),
    "app_trace_spans.js": (6, "the span list rows, its panel and states: " + HOT),
    "app_trace_logs.js": (10, "trace log rows inline in the waterfall and the logs panel, every value escaped: " + HOT),
    "app_trace_services.js": (4, "services table, service detail and states, escaped through the components"),
    "app_trace_insights.js": (4, "highlights, linked-from list, context table and exception cards, every value escaped"),
    "app_trace_heatmap.js": (3, "the delta cards, legend and panel, every value escaped"),
    "app_trace_map.js": (3, "the service map panel and its states, every value escaped"),
    "app_trace_search.js": (1, "the filter chips (ns.badge.chipHtml escapes)"),
    "app_facet_panel.js": (5, "the facet list (values escaped) and its states (ns.uiState)"),
    "app_logs.js": (17, "the Logs grid rows (" + HOT + "), patterns, record panel, context and states, every value escaped"),
    "app_metrics.js": (8, "the metric catalog tree, panel skeleton, badges, chips and states, every value escaped"),
}

# The loader and the Observability bootstrap run before app_dom.js: the
# loader reads the module manifest, the bootstrap loads the common modules.
LOOKUP_EXEMPT = {"app_dom.js", "app_loader.js", "app_observability.js"}

SINK = re.compile(r"\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(")


def scripts():
    for path in sorted(STATIC.glob("*.js")):
        yield path.name, path.read_text(encoding="latin-1")


# ---------------------------------------------------------------- tokenizer

def code_mask(src: str) -> bytearray:
    """1 for script code, 0 for comments, strings and template text (the
    ${...} of a template literal is code)."""
    n = len(src)
    code = bytearray(n)

    def skip_string(j: int, quote: str) -> int:
        j += 1
        while j < n and src[j] != quote:
            if src[j] == "\\":
                j += 1
            j += 1
        return j + 1

    def regex_allowed(j: int) -> bool:
        k = j - 1
        while k >= 0 and src[k] in " \t\r\n":
            k -= 1
        if k < 0 or src[k] in "(,=:[!&|?{};+-*%<>~^":
            return True
        word = re.search(r"(\w+)$", src[max(0, k - 10):k + 1])
        return bool(word and word.group(1) in ("return", "typeof", "case", "of", "in", "void", "delete"))

    def skip_regex(j: int) -> int:
        j += 1
        in_class = False
        while j < n:
            c = src[j]
            if c == "\\":
                j += 2
                continue
            if c == "[":
                in_class = True
            elif c == "]":
                in_class = False
            elif c == "/" and not in_class:
                j += 1
                while j < n and src[j].isalpha():
                    j += 1
                return j
            elif c == "\n":
                return j
            j += 1
        return j

    def template(j: int) -> int:
        j += 1
        while j < n:
            c = src[j]
            if c == "\\":
                j += 2
                continue
            if c == "`":
                return j + 1
            if c == "$" and j + 1 < n and src[j + 1] == "{":
                j = block(j + 2, True)
                continue
            j += 1
        return j

    def block(j: int, in_template: bool) -> int:
        depth = 0
        while j < n:
            c = src[j]
            if c == "/" and j + 1 < n and src[j + 1] == "/":
                j = src.find("\n", j)
                if j < 0:
                    return n
                continue
            if c == "/" and j + 1 < n and src[j + 1] == "*":
                j = src.find("*/", j) + 2
                continue
            if c in "'\"":
                j = skip_string(j, c)
                continue
            if c == "`":
                j = template(j)
                continue
            if c == "/" and regex_allowed(j):
                j = skip_regex(j)
                continue
            if c == "}" and depth == 0 and in_template:
                return j + 1
            code[j] = 1
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            j += 1
        return j

    block(0, False)
    return code


def code_matches(pattern: re.Pattern, src: str, mask: bytearray):
    return [m for m in pattern.finditer(src) if mask[m.start()]]


def template_at(src: str, j: int):
    """The template literal starting at src[j] == '`': (end, [interpolations])."""
    n = len(src)
    exprs = []
    j += 1
    while j < n:
        c = src[j]
        if c == "\\":
            j += 2
            continue
        if c == "`":
            return j + 1, exprs
        if c == "$" and src[j + 1] == "{":
            k, depth, start = j + 2, 0, j + 2
            while k < n:
                d = src[k]
                if d in "'\"":
                    q = d
                    k += 1
                    while k < n and src[k] != q:
                        k += 2 if src[k] == "\\" else 1
                elif d == "`":
                    k, _ = template_at(src, k)
                    continue
                elif d == "{":
                    depth += 1
                elif d == "}":
                    if depth == 0:
                        break
                    depth -= 1
                k += 1
            exprs.append(src[start:k].strip())
            j = k + 1
            continue
        j += 1
    return n, exprs


# An interpolation is safe when it escapes (util.escapeHtml, a module's esc
# alias), calls a builder that escapes (a *Html() function, badge.html,
# format.nullToken), names markup a builder made (an *Html variable, an *Html
# array joined, a map of an *Html builder joined), formats a number, is a
# constant (an icon), a literal or a palette colour, or is plain arithmetic
# on counts and geometry. A ternary checks both branches, a || or ?? chain
# every operand and an && chain its last.
ESCAPE_CALL = re.compile(r"^(?:ns\.util\.|util\.|ctx\.)?(?:esc|escapeHtml)\(")
# ns.icon(name, opts) (app_ui_icon.js) builds escaped markup like the *Html builders.
MARKUP_BUILDER = re.compile(r"^(?:[\w.?]*(?:Html|Style|\.html|\.nullToken)\??\.?\(|ns\.icon\()")
MARKUP_VALUE = re.compile(r"^[\w.?]*Html(?:\.join\((?:\"\"|'')\))?$")
MAP_JOIN = re.compile(r"^[\w.?]+\.map\(\(?[\w, ]*\)? => [\w.?]*Html\([^()]*(?:\([^()]*\)[^()]*)*\)\)\.join\((?:\"\"|'')\)$")
MAP_TEMPLATE = re.compile(r"^[\w.?]+\.map\(\(?[\w, ]*\)? => (?:\{ return (`.*`); \}|(`.*`))\)\.join\((?:\"\"|'')\)$")
PALETTE = re.compile(r"^palette\.\w+\([^()]*(?:\([^()]*\))?[^()]*\)$")
FORMATTED = re.compile(r"^(?:fmt|format|ns\.format)\.(?:count|compact|percent|duration(?:\.from\w+)?|bytes|number|rate|bytesRate|EMPTY|nullToken)\b")
NUMERIC = re.compile(r"^[\w.\[\]() +\-*/%]+$")
NUMERIC_HINT = re.compile(
    r"\.length\b|\.toFixed\(|\.indexOf\(|\bMath\.|\bNumber\(|[+\-*/%]|^\d"
    r"|\b(?:count|index|i|j|n|width|height|left|top|offsets?|size|depth|rows?|step|total|max|min|level|x|y|w|h|px|p|idPrefix)\b(?![.(])"
)
CONSTANT = re.compile(r"^[A-Z][A-Z0-9_]*(?:\.[A-Za-z]\w*|\[[^\]]+\])?$")
STRING = re.compile(r"^(?:\"[^\"]*\"|'[^']*')$")


def top_level(expr: str):
    """Yield (index, char) of expr outside strings, templates and brackets."""
    depth, i, n = 0, 0, len(expr)
    while i < n:
        c = expr[i]
        if c in "'\"":
            j = i + 1
            while j < n and expr[j] != c:
                j += 2 if expr[j] == "\\" else 1
            i = j + 1
            continue
        if c == "`":
            i, _ = template_at(expr, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0:
            yield i, c
        i += 1


def split_operator(expr: str, op: str):
    cuts = [i for i, c in top_level(expr) if expr.startswith(op, i) and (i == 0 or expr[i - 1] != op[0])]
    if not cuts:
        return None
    parts, last = [], 0
    for cut in cuts:
        parts.append(expr[last:cut].strip())
        last = cut + len(op)
    parts.append(expr[last:].strip())
    return parts


def ternary(expr: str):
    marks = [(i, c) for i, c in top_level(expr) if c in "?:"]
    depth, q = 0, None
    for i, c in marks:
        if c == "?":
            if expr[i + 1:i + 2] in (".", "?") or expr[i - 1:i] == "?":
                continue
            if q is None:
                q = i
            else:
                depth += 1
        elif q is not None:
            if depth == 0:
                return expr[q + 1:i].strip(), expr[i + 1:].strip()
            depth -= 1
    return None


def interpolation_ok(expr: str) -> bool:
    expr = " ".join(expr.split())
    branches = ternary(expr)
    if branches:
        return all(interpolation_ok(part) for part in branches)
    for op in ("||", "??"):
        parts = split_operator(expr, op)
        if parts:
            return all(interpolation_ok(part) for part in parts)
    parts = split_operator(expr, "&&")
    if parts:
        return interpolation_ok(parts[-1])
    if expr.startswith("(") and expr.endswith(")"):
        inner = expr[1:-1]
        if sum(1 for _ in top_level(inner)) >= 0 and inner.count("(") == inner.count(")"):
            return interpolation_ok(inner)
    if expr.startswith("`"):
        return literal_ok(expr)
    mapped = MAP_TEMPLATE.match(expr)
    if mapped:
        return literal_ok(mapped.group(1) or mapped.group(2))
    if (STRING.match(expr) or ESCAPE_CALL.match(expr) or MARKUP_BUILDER.match(expr) or MARKUP_VALUE.match(expr)
            or MAP_JOIN.match(expr) or PALETTE.match(expr) or FORMATTED.match(expr) or CONSTANT.match(expr)):
        return True
    return bool(NUMERIC.match(expr) and NUMERIC_HINT.search(expr))


def literal_ok(text: str) -> bool:
    if not text.startswith("`"):
        return True
    end, exprs = template_at(text, 0)
    return end == len(text) and all(interpolation_ok(expr) for expr in exprs)


# -------------------------------------------------------------------- tests

def test_ns_h_is_the_builder_and_loads_with_app_dom():
    dom = (STATIC / "app_dom.js").read_text(encoding="latin-1")
    for needle in ("function h(tag, props, ...children)", "h.svg =", "h.frag =", "h.html =", "h.replace =", "ns.h = Object.freeze(h);",
                   "dom.byId = byId;", "dom.$ = $;", "dom.$$ = $$;", "document.createTextNode(String(child))"):
        assert needle in dom, needle
    manifest = json.loads((STATIC / "modules.json").read_text(encoding="utf-8"))
    assert manifest["common"][:3] == ["app_format.js", "app_palette.js", "app_dom.js"]
    doc = DOC.read_text(encoding="utf-8")
    assert "## Building elements" in doc
    for needle in ("ns.h(tag, props, ...children)", "h.html(trusted)", "h.replace(container", "dom.$$(selector, root)", "test_dom_builder_contract.py"):
        assert needle in doc, needle


def test_no_local_dom_builders_or_lookup_copies():
    helper = re.compile(r"\bfunction\s+(?:node|el|element)\s*\(\s*tag\b|\b(?:const|let)\s+(?:node|el|element)\s*=\s*\(\s*tag\b")
    lookup = re.compile(r"\b(?:const|let)\s+(?:byId|\$|\$\$|qs|qsa)\s*=\s*\([^)]*\)\s*=>\s*document\.")
    offenders = []
    for name, src in scripts():
        if name == "app_dom.js":
            continue
        mask = code_mask(src)
        offenders += [f"{name}: {m.group(0)}" for m in code_matches(helper, src, mask)]
        offenders += [f"{name}: {m.group(0)}" for m in code_matches(lookup, src, mask)]
    assert not offenders, offenders
    kit = (STATIC / "app_graph_kit.js").read_text(encoding="latin-1")
    assert not re.search(r"^\s+el,$", kit, flags=re.M), "ns.graphKit.el is ns.h now"


def test_lookups_go_through_dom_byid_and_the_scoped_queries():
    raw = re.compile(r"\.(?:getElementById|querySelector|querySelectorAll)\s*\(")
    offenders = []
    for name, src in scripts():
        if name in LOOKUP_EXEMPT:
            continue
        mask = code_mask(src)
        for m in code_matches(raw, src, mask):
            offenders.append(f"{name}:{src.count(chr(10), 0, m.start()) + 1}: {m.group(0)}")
    assert not offenders, offenders[:40]


def test_modules_take_the_lookups_and_the_builder_from_ns():
    # A module that calls byId / $ / $$ / h declares it from ns (a missing
    # one is a ReferenceError at run time, not at load).
    uses = {
        "byId": re.compile(r"(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))byId\("),
        "$": re.compile(r"(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))\$\("),
        "$$": re.compile(r"(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))\$\$\("),
        "h": re.compile(r"(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))h(?:\.\w+)?\("),
    }
    missing = []
    for name, src in scripts():
        if name == "app_dom.js":
            continue
        mask = code_mask(src)
        declared = set()
        for m in re.finditer(r"const \{([^}]*)\} = ns(?:\.dom)?(?: \|\| \{\})?;", src):
            declared |= {part.strip() for part in m.group(1).split(",")}
        for fn, pattern in uses.items():
            if fn in declared:
                continue
            calls = code_matches(pattern, src, mask)
            if calls:
                missing.append(f"{name}: {fn}() at line {src.count(chr(10), 0, calls[0].start()) + 1}")
    assert not missing, missing


def test_markup_writes_stay_on_the_allow_list():
    counts = {}
    for name, src in scripts():
        mask = code_mask(src)
        found = len(code_matches(SINK, src, mask))
        if found:
            counts[name] = found
    unexpected = {name: count for name, count in counts.items() if name not in ALLOWED}
    assert not unexpected, f"markup writes outside the allow-list (use ns.h, or add the module with its reason): {unexpected}"
    drift = {name: (counts.get(name, 0), allowed) for name, (allowed, _reason) in ALLOWED.items() if counts.get(name, 0) != allowed}
    assert not drift, f"allow-list counts out of date (found, listed): {drift}"
    for name, (_count, reason) in ALLOWED.items():
        assert len(reason) > 20, f"{name}: say why it stays markup"


def test_template_literals_written_as_markup_interpolate_escaped_values():
    sink_template = re.compile(r"(?:\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\([^,()]+,)\s*`")
    offenders = []
    for name, src in scripts():
        mask = code_mask(src)
        for m in code_matches(sink_template, src, mask):
            start = m.end() - 1
            _end, exprs = template_at(src, start)
            for expr in exprs:
                if not interpolation_ok(expr):
                    offenders.append(f"{name}:{src.count(chr(10), 0, start) + 1}: ${{{' '.join(expr.split())[:100]}}}")
    assert not offenders, offenders


def test_h_html_is_only_used_for_trusted_markup():
    # h.html() takes markup: a constant, a highlighter / builder result, or a
    # literal whose interpolations pass the template rule above.
    call = re.compile(r"\bh\.html\(")
    offenders = []
    for name, src in scripts():
        mask = code_mask(src)
        for m in code_matches(call, src, mask):
            j = m.end()
            while src[j] in " \n":
                j += 1
            line = src.count("\n", 0, m.start()) + 1
            if src[j] == "`":
                _end, exprs = template_at(src, j)
                bad = [expr for expr in exprs if not interpolation_ok(expr)]
                if bad:
                    offenders.append(f"{name}:{line}: {bad}")
            elif src[j] in "'\"":
                continue
            else:
                arg = src[j:src.find(")", j) + 1]
                if not (MARKUP_BUILDER.match(arg) or CONSTANT.match(arg.rstrip(")")) or re.match(r"[\w.]*(?:ICON|SVG|Html|html)\b", arg)):
                    offenders.append(f"{name}:{line}: h.html({arg}")
    assert not offenders, offenders
