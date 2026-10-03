"""A small, strict reader for the stylesheet sources (src/static/css/).

No regular expression ever runs over CSS code here: the text goes through one
scanner that knows comments, strings, escapes, url() and nested blocks, and
everything else (rules, declarations, selectors) is built from that scan.

    parse(text)              -> [Comment | Rule | AtRule], in source order
    Rule.selectors           -> the selector list, split at top-level commas
    selector_info(selector)  -> subject compound, names, specificity
    serialize(nodes)         -> CSS text

Supported: style rules, @media / @supports / @container / @layer blocks
(nested), @keyframes and @font-face (kept as raw blocks), statement at-rules
(@import, @layer a, b;, @charset). No CSS nesting: a style rule holds
declarations only.
"""
from __future__ import annotations

from dataclasses import dataclass, field

GROUPING = ("media", "supports", "container", "layer")
NAME_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
HEX = set("0123456789abcdefABCDEF")
# Pseudo-elements written with one colon (CSS 2).
LEGACY_PSEUDO_ELEMENTS = {"before", "after", "first-line", "first-letter"}
# Pseudo-classes whose argument is a selector list.
SELECTOR_ARG_PSEUDOS = {"is", "not", "has", "where", "matches", "-webkit-any", "host", "host-context"}
NTH_PSEUDOS = {"nth-child", "nth-last-child"}


class CssSyntaxError(ValueError):
    pass


@dataclass
class Comment:
    text: str  # without the /* */ markers
    line: int


@dataclass
class Decl:
    name: str
    value: str
    important: bool = False
    comment: str | None = None  # a comment written right before it, inside the block

    def text(self) -> str:
        return f"{self.name}: {self.value}{' !important' if self.important else ''}"


@dataclass
class Rule:
    prelude: str
    decls: list[Decl]
    line: int
    comment: str | None = None  # the comment right before the rule
    trailing: list[str] = field(default_factory=list)  # comments after the last declaration
    raw: str = ""  # the rule as written, selector to closing brace

    @property
    def selectors(self) -> list[str]:
        return split_list(self.prelude)


@dataclass
class AtRule:
    name: str  # without "@", lower case
    prelude: str  # after the name, whitespace collapsed
    line: int
    children: list | None = None  # grouping at-rules: parsed nodes
    raw: str | None = None  # @keyframes, @font-face...: the block text as written
    comment: str | None = None

    @property
    def is_statement(self) -> bool:
        return self.children is None and self.raw is None

    def header(self) -> str:
        return f"@{self.name} {self.prelude}".rstrip()


# --- scanning -----------------------------------------------------------------


def skip_comment(css: str, i: int) -> int:
    end = css.find("*/", i + 2)
    if end < 0:
        raise CssSyntaxError(f"unterminated comment at offset {i}")
    return end + 2


def skip_string(css: str, i: int) -> int:
    quote, j = css[i], i + 1
    while j < len(css):
        ch = css[j]
        if ch == "\\":
            j += 2
            continue
        if ch == quote:
            return j + 1
        if ch == "\n":
            raise CssSyntaxError(f"unterminated string at offset {i}")
        j += 1
    raise CssSyntaxError(f"unterminated string at offset {i}")


def skip_url(css: str, i: int) -> int:
    """i is at "u" of an unquoted url(; returns the index past ")"."""
    j = i + 4
    while j < len(css) and css[j] in " \t\n":
        j += 1
    if j < len(css) and css[j] in "\"'":
        return i + 4  # a quoted url() is a function: scan its string normally
    while j < len(css) and css[j] != ")":
        j += 2 if css[j] == "\\" else 1
    if j >= len(css):
        raise CssSyntaxError(f"unterminated url( at offset {i}")
    return j + 1


def is_url_start(css: str, i: int) -> bool:
    return css.startswith(("url(", "URL("), i) and (i == 0 or css[i - 1] not in NAME_CHARS)


def scan(css: str, start: int, stops: str, end: int | None = None) -> int:
    """Index of the first character of `stops` at nesting depth 0 from `start`,
    skipping comments, strings, escapes, url() and bracketed groups; `end` if none."""
    end = len(css) if end is None else end
    depth = 0
    i = start
    while i < end:
        ch = css[i]
        if ch == "/" and css.startswith("/*", i):
            i = skip_comment(css, i)
            continue
        if ch in "\"'":
            i = skip_string(css, i)
            continue
        if ch == "\\":
            i += 2
            continue
        if ch in "uU" and is_url_start(css, i):
            j = skip_url(css, i)
            if j != i + 4:
                i = j
                continue
        if depth == 0 and ch in stops:
            return i
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                raise CssSyntaxError(f"unbalanced {ch!r} at offset {i}")
            depth -= 1
        i += 1
    return end


def strip_comments(text: str) -> str:
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if ch == "/" and text.startswith("/*", i):
            i = skip_comment(text, i)
            out.append(" ")
            continue
        if ch in "\"'":
            j = skip_string(text, i)
            out.append(text[i:j])
            i = j
            continue
        if ch == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def collapse(text: str) -> str:
    """Whitespace runs outside strings become one space; trimmed."""
    out, i, space = [], 0, False
    text = text.strip()
    while i < len(text):
        ch = text[i]
        if ch in "\"'":
            j = skip_string(text, i)
            if space:
                out.append(" ")
                space = False
            out.append(text[i:j])
            i = j
            continue
        if ch in " \t\r\n\f":
            space = True
            i += 1
            continue
        if space:
            out.append(" ")
            space = False
        if ch == "\\":
            out.append(text[i : i + 2])
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def comments_in(text: str) -> list[str]:
    """The comments of a stretch of text (strings skipped)."""
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        if ch == "/" and text.startswith("/*", i):
            j = skip_comment(text, i)
            out.append(text[i + 2 : j - 2])
            i = j
        elif ch in "\"'":
            i = skip_string(text, i)
        else:
            i += 1
    return out


def line_of(css: str, offset: int, cache: dict) -> int:
    # Count newlines incrementally: offsets arrive in increasing order per parse.
    last_off, last_line = cache.get("pos", (0, 1))
    if offset < last_off:
        last_off, last_line = 0, 1
    line = last_line + css.count("\n", last_off, offset)
    cache["pos"] = (offset, line)
    return line


# --- stylesheet ---------------------------------------------------------------


def parse(css: str) -> list:
    return _parse_block(css, 0, len(css), {})


def _parse_block(css: str, start: int, end: int, lines: dict) -> list:
    nodes: list = []
    i = start
    while i < end:
        # Leading whitespace and comments: comments become nodes.
        while i < end:
            ch = css[i]
            if ch in " \t\r\n\f":
                i += 1
            elif ch == "/" and css.startswith("/*", i):
                j = skip_comment(css, i)
                nodes.append(Comment(css[i + 2 : j - 2], line_of(css, i, lines)))
                i = j
            else:
                break
        if i >= end:
            break
        stop = scan(css, i, "{;}", end)
        if stop >= end or css[stop] == "}":
            if css[i:stop].strip():
                raise CssSyntaxError(f"unexpected end of block after {css[i:stop][:60]!r} (line {line_of(css, i, lines)})")
            i = stop + 1
            continue
        line = line_of(css, i, lines)
        prelude_text = css[i:stop]
        if comments_in(prelude_text):
            raise CssSyntaxError(f"comment inside a prelude at line {line}: {prelude_text.strip()[:80]!r}")
        prelude = collapse(prelude_text)
        if css[stop] == ";":
            if not prelude.startswith("@"):
                raise CssSyntaxError(f"stray declaration outside a rule at line {line}: {prelude[:80]!r}")
            name, _, rest = prelude[1:].partition(" ")
            nodes.append(AtRule(name.lower(), rest.strip(), line))
            i = stop + 1
            continue
        close = scan(css, stop + 1, "}", end)
        if close >= end:
            raise CssSyntaxError(f"unclosed block at line {line}")
        if prelude.startswith("@"):
            name, _, rest = prelude[1:].partition(" ")
            name = name.lower()
            if name in GROUPING:
                nodes.append(AtRule(name, rest.strip(), line, children=_parse_block(css, stop + 1, close, lines)))
            else:
                nodes.append(AtRule(name, rest.strip(), line, raw=css[stop + 1 : close]))
        else:
            if not prelude:
                raise CssSyntaxError(f"rule without a selector at line {line}")
            decls, trailing = parse_declarations(css[stop + 1 : close], line)
            start_text = i + len(prelude_text) - len(prelude_text.lstrip())
            nodes.append(Rule(prelude, decls, line, trailing=trailing, raw=css[start_text : close + 1]))
        i = close + 1
    # A comment right before a rule (or block) documents it.
    for k in range(1, len(nodes)):
        if isinstance(nodes[k - 1], Comment) and isinstance(nodes[k], (Rule, AtRule)):
            nodes[k].comment = nodes[k - 1].text
    return nodes


def parse_declarations(body: str, line: int = 0) -> tuple[list[Decl], list[str]]:
    decls: list[Decl] = []
    pending: list[str] = []
    i = 0
    while i < len(body):
        # Comments between declarations attach to the next one.
        while i < len(body):
            ch = body[i]
            if ch in " \t\r\n\f;":
                i += 1
            elif ch == "/" and body.startswith("/*", i):
                j = skip_comment(body, i)
                pending.append(body[i + 2 : j - 2])
                i = j
            else:
                break
        if i >= len(body):
            break
        stop = scan(body, i, ";{}", len(body))
        if stop < len(body) and body[stop] != ";":
            raise CssSyntaxError(f"nested block inside a style rule near line {line}: {body[i:stop][:60]!r}")
        text = body[i:stop]
        colon = scan(text, 0, ":", len(text))
        if colon >= len(text):
            raise CssSyntaxError(f"declaration without a colon near line {line}: {text.strip()[:60]!r}")
        name = text[:colon].strip()
        if comments_in(name) or not name:
            raise CssSyntaxError(f"bad property name near line {line}: {name!r}")
        value_text = text[colon + 1 :]
        if comments_in(value_text):
            raise CssSyntaxError(f"comment inside a value near line {line}: {text.strip()[:80]!r}")
        # A custom property keeps its text as written (getComputedStyle reads it back
        # verbatim); every other value is whitespace-insensitive.
        value = value_text.strip() if name.startswith("--") else collapse(value_text)
        important = False
        bang = scan(value, 0, "!", len(value))  # outside strings and brackets
        if bang < len(value):
            if collapse(value[bang + 1 :]).lower() != "important":
                raise CssSyntaxError(f"stray '!' near line {line}: {text.strip()[:80]!r}")
            important = True
            value = value[:bang].rstrip()
            if not name.startswith("--"):
                value = collapse(value)
        if not name.startswith("--"):
            name = name.lower()
        decls.append(Decl(name, value, important, "\n".join(pending) if pending else None))
        pending = []
        i = stop + 1
    return decls, pending


# --- selectors ----------------------------------------------------------------


def split_list(text: str) -> list[str]:
    """Split at top-level commas (selector lists, @layer lists)."""
    parts, start = [], 0
    while True:
        comma = scan(text, start, ",", len(text))
        parts.append(collapse(text[start:comma]))
        if comma >= len(text):
            return parts
        start = comma + 1


def read_name(text: str, i: int) -> int:
    """Index past an identifier-like run (with escapes) starting at i."""
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            j = i + 1
            if j < len(text) and text[j] in HEX:
                k = j
                while k < len(text) and k - j < 6 and text[k] in HEX:
                    k += 1
                if k < len(text) and text[k] == " ":
                    k += 1
                i = k
            else:
                i = j + 1
            continue
        if ch in NAME_CHARS or ord(ch) > 127:
            i += 1
            continue
        break
    return i


def unescape_name(name: str) -> str:
    out, i = [], 0
    while i < len(name):
        ch = name[i]
        if ch == "\\" and i + 1 < len(name):
            j = i + 1
            if name[j] in HEX:
                k = j
                while k < len(name) and k - j < 6 and name[k] in HEX:
                    k += 1
                out.append(chr(int(name[j:k], 16)))
                if k < len(name) and name[k] == " ":
                    k += 1
                i = k
                continue
            out.append(name[j])
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


@dataclass
class Compound:
    tag: str | None = None  # "*" or a type, None when absent
    ids: list[str] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    attrs: list[str] = field(default_factory=list)  # "[...]" as written
    pseudo_classes: list[tuple[str, str | None]] = field(default_factory=list)  # (name, argument)
    pseudo_element: str | None = None  # "before", "-webkit-scrollbar"... (with its argument if any)
    after_pseudo_element: list[tuple[str, str | None]] = field(default_factory=list)


@dataclass
class SelectorInfo:
    text: str
    compounds: list[Compound]  # left to right
    combinators: list[str]  # between compounds: " ", ">", "+", "~"
    specificity: tuple[int, int, int]
    classes: set[str]  # every class outside functional pseudo-class arguments
    ids: set[str]
    all_classes: set[str]  # including the arguments of :not(), :is(), :has()...
    all_ids: set[str]

    @property
    def subject(self) -> Compound:
        return self.compounds[-1]

    @property
    def pseudo_element(self) -> str | None:
        return self.compounds[-1].pseudo_element


def _read_paren(text: str, i: int) -> int:
    """i is just past "("; returns the index of the matching ")"."""
    j = scan(text, i, ")", len(text))
    if j >= len(text):
        raise CssSyntaxError(f"unclosed ( in selector {text!r}")
    return j


def selector_info(selector: str) -> SelectorInfo:
    selector = collapse(selector)
    compounds: list[Compound] = [Compound()]
    combinators: list[str] = []
    spec = [0, 0, 0]
    classes: set[str] = set()
    ids: set[str] = set()
    all_classes: set[str] = set()
    all_ids: set[str] = set()
    pending_comb: str | None = None
    i = 0
    n = len(selector)

    def start_compound() -> Compound:
        nonlocal pending_comb
        if pending_comb is not None:
            compounds.append(Compound())
            combinators.append(pending_comb)
            pending_comb = None
        return compounds[-1]

    while i < n:
        ch = selector[i]
        if ch == " ":
            if pending_comb is None and compounds[-1] != Compound():
                pending_comb = " "
            i += 1
            continue
        if ch in ">+~":
            pending_comb = ch
            i += 1
            continue
        cur = start_compound()
        if ch == ".":
            j = read_name(selector, i + 1)
            name = unescape_name(selector[i + 1 : j])
            if not name:
                raise CssSyntaxError(f"empty class in {selector!r}")
            cur.classes.append(name)
            classes.add(name)
            all_classes.add(name)
            spec[1] += 1
            i = j
        elif ch == "#":
            j = read_name(selector, i + 1)
            name = unescape_name(selector[i + 1 : j])
            cur.ids.append(name)
            ids.add(name)
            all_ids.add(name)
            spec[0] += 1
            i = j
        elif ch == "[":
            j = scan(selector, i + 1, "]", n)
            if j >= n:
                raise CssSyntaxError(f"unclosed [ in {selector!r}")
            cur.attrs.append(selector[i : j + 1])
            spec[1] += 1
            i = j + 1
        elif ch == ":":
            double = selector.startswith("::", i)
            j = read_name(selector, i + (2 if double else 1))
            name = selector[i + (2 if double else 1) : j].lower()
            arg = None
            if j < n and selector[j] == "(":
                close = _read_paren(selector, j + 1)
                arg = selector[j + 1 : close].strip()
                j = close + 1
            if double or name in LEGACY_PSEUDO_ELEMENTS:
                if cur.pseudo_element is not None:
                    raise CssSyntaxError(f"two pseudo-elements in {selector!r}")
                cur.pseudo_element = name if arg is None else f"{name}({arg})"
                spec[2] += 1
                if name == "slotted" and arg:
                    sub = max_specificity(arg)
                    spec[0] += sub[0]
                    spec[1] += sub[1]
                    spec[2] += sub[2]
            else:
                target = cur.after_pseudo_element if cur.pseudo_element else cur.pseudo_classes
                target.append((name, arg))
                if name == "where":
                    pass
                elif name in SELECTOR_ARG_PSEUDOS and arg is not None:
                    sub = max_specificity(arg)
                    spec[0] += sub[0]
                    spec[1] += sub[1]
                    spec[2] += sub[2]
                elif name in NTH_PSEUDOS and arg is not None and " of " in f" {arg} ":
                    spec[1] += 1
                    sub = max_specificity(arg.split(" of ", 1)[1])
                    spec[0] += sub[0]
                    spec[1] += sub[1]
                    spec[2] += sub[2]
                else:
                    spec[1] += 1
                inner = None
                if arg is not None and name in SELECTOR_ARG_PSEUDOS:
                    inner = arg
                elif arg is not None and name in NTH_PSEUDOS and " of " in f" {arg} ":
                    inner = arg.split(" of ", 1)[1]
                if inner is not None:
                    for part in split_list(inner):
                        info = selector_info(part)
                        all_classes |= info.all_classes
                        all_ids |= info.all_ids
            i = j
        elif ch == "*":
            cur.tag = "*"
            i += 1
        elif ch in NAME_CHARS or ch == "\\" or ord(ch) > 127:
            j = read_name(selector, i)
            cur.tag = selector[i:j].lower()
            spec[2] += 1
            i = j
        elif ch == "&":
            raise CssSyntaxError(f"nesting selector in {selector!r}")
        elif ch == "|":
            raise CssSyntaxError(f"namespace in {selector!r}")
        else:
            raise CssSyntaxError(f"unexpected {ch!r} in selector {selector!r}")
    if pending_comb is not None and pending_comb != " ":
        raise CssSyntaxError(f"dangling combinator in {selector!r}")
    if compounds[-1] == Compound():
        raise CssSyntaxError(f"empty selector {selector!r}")
    return SelectorInfo(selector, compounds, combinators, tuple(spec), classes, ids, all_classes, all_ids)


def max_specificity(selector_list: str) -> tuple[int, int, int]:
    return max((selector_info(s).specificity for s in split_list(selector_list)), default=(0, 0, 0))


# --- output -------------------------------------------------------------------


def format_comment(text: str, indent: str) -> str:
    lines = text.strip("\n").split("\n")
    if len(lines) == 1:
        return f"{indent}/* {lines[0].strip()} */"
    body = [lines[0].strip()] + [line.rstrip() for line in lines[1:]]
    while body and not body[-1].strip():
        body.pop()
    return f"{indent}/* " + "\n".join(body) + " */"


def format_rule(rule: Rule, indent: str = "") -> str:
    head = ",\n".join(indent + s for s in rule.selectors)
    if not rule.decls and not rule.trailing:
        return head + " {}"
    out = [head + " {"]
    for decl in rule.decls:
        if decl.comment:
            out.append(format_comment(decl.comment, indent + "  "))
        out.append(f"{indent}  {decl.text()};")
    for text in rule.trailing:
        out.append(format_comment(text, indent + "  "))
    out.append(indent + "}")
    return "\n".join(out)


def serialize(nodes: list, indent: str = "") -> str:
    """CSS text: one blank line between top-level items."""
    parts: list[str] = []
    for k, node in enumerate(nodes):
        if isinstance(node, Comment):
            # A documenting comment is written with its node below.
            if k + 1 < len(nodes) and isinstance(nodes[k + 1], (Rule, AtRule)) and nodes[k + 1].comment == node.text:
                continue
            parts.append(format_comment(node.text, indent))
            continue
        text = format_comment(node.comment, indent) + "\n" if node.comment else ""
        if isinstance(node, Rule):
            text += format_rule(node, indent)
        elif node.is_statement:
            text += f"{indent}{node.header()};"
        elif node.children is not None:
            inner = serialize(node.children, indent + "  ")
            text += f"{indent}{node.header()} {{\n{inner}\n{indent}}}"
        else:
            text += f"{indent}{node.header()} {{{node.raw}}}"
        parts.append(text)
    return "\n\n".join(parts)
