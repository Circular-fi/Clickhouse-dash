#!/usr/bin/env python3
"""Find lambdas that keep a dangling reference to a local of the function that creates them.

A route handler outlives the Server constructor. A handler written `[&](...) {...}` that uses a
local variable (or a local lambda, or a constructor parameter) of that constructor reads a
destroyed object once the constructor returns. v2.16.3 shipped such a handler: it answered
/observability with 404 in the release build. No compiler warning (GCC -Wdangling-reference,
clang -Wdangling) and no clang-tidy check sees this, so this script looks for it.

Rule: inside a function body, a lambda with a reference capture (`[&]`, `[&, x]`, `[&x]`) must not
use a name that the enclosing function declares (a local or a parameter), unless the lambda captures
that name by value (`[&, x]`, `[x]`). Members (`cfg_`, ...) are fine: `this` is captured.

Usage: check_handler_captures.py [--function Server::Server] FILE...
Exit status: 0 when clean, 1 when a lambda dangles. To accept a line on purpose (the lambda runs
before the function returns), end the lambda's first line with `// handler-capture-ok: <reason>`.
"""
import re
import sys

KEYWORDS = {
    "return", "else", "delete", "new", "throw", "goto", "case", "default", "co_return", "co_yield",
    "typename", "using", "namespace", "struct", "class", "enum", "public", "private", "const",
    "static", "auto", "break", "continue", "do", "if", "for", "while", "switch", "true", "false",
    "nullptr", "this", "sizeof", "operator", "template", "unsigned", "signed", "constexpr",
}
IDENT = re.compile(r"[A-Za-z_]\w*")
# A declaration: <type> [&*] <name> followed by = { ; ( : , ) -- the type may be auto or a qualified name.
DECL = re.compile(
    r"(?<![\w.>])(?:const\s+)?(?:auto|[A-Za-z_][\w:]*(?:<[^;{}()]*?>)?)\s*(?:const\s*)?[&*]*\s*[&*]?\s+([A-Za-z_]\w*)\s*(?:=|\{|;|:|\(|,|\))"
)


def strip_noise(text):
    """Blank out comments, strings and character literals (same length, newlines kept)."""
    out = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        two = text[i:i + 2]
        if two == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif two == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", text[i:j]))
            i = j
        elif c == 'R' and text[i:i + 3] == 'R"(' or (c == 'R' and text[i:i + 2] == 'R"'):
            m = re.match(r'R"([^(\s]*)\(', text[i:])
            if m:
                end = text.find(")" + m.group(1) + '"', i)
                end = n if end < 0 else end + len(m.group(1)) + 2
                out.append(re.sub(r"[^\n]", " ", text[i:end]))
                i = end
            else:
                out.append(c)
                i += 1
        elif c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
            out.append(re.sub(r"[^\n]", " ", text[i:j]))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def match_brace(text, start):
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    return -1


def function_bodies(text, name):
    """Yield (params, body_start, body_end) of the definitions of `name`."""
    for m in re.finditer(r"(?m)^[\w:<>*&\s]*?\b" + re.escape(name) + r"\s*\(", text):
        depth, i = 0, m.end() - 1
        while i < len(text):
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        params = text[m.end():i]
        j = i + 1
        # Skip the member-initializer list: up to the `{` that is not part of an initializer.
        while j < len(text) and text[j] not in "{;":
            if text[j] == "(":
                d = 0
                while j < len(text):
                    d += text[j] == "("
                    d -= text[j] == ")"
                    j += 1
                    if d == 0:
                        break
                continue
            j += 1
        if j < len(text) and text[j] == "{":
            yield params, j, match_brace(text, j)


def declared_names(code):
    names = set()
    for m in DECL.finditer(code):
        name = m.group(1)
        if name in KEYWORDS or name.endswith("_"):
            continue
        names.add(name)
    return names


def param_names(params):
    names = set()
    for part in re.split(r",(?![^<]*>)", params):
        ids = IDENT.findall(part)
        if len(ids) >= 2 and ids[-1] not in KEYWORDS:
            names.add(ids[-1])
    return names


def lambdas(text, lo, hi):
    """Yield (capture, body_start, body_end, param_text, capture_start) of the lambdas in text[lo:hi]."""
    for m in re.finditer(r"\[([^\[\]{};]*)\]\s*(\([^(){};]*(?:\([^()]*\)[^(){};]*)*\))?\s*(?:mutable\s*)?(?:->\s*[\w:<>&*\s,]+?)?\s*\{", text[lo:hi]):
        capture = m.group(1)
        if m.start() > 0 and (text[lo + m.start() - 1].isalnum() or text[lo + m.start() - 1] in "_)]"):
            continue  # a subscript, not a lambda
        brace = lo + m.end() - 1
        end = match_brace(text, brace)
        if end > 0:
            yield capture, brace, end, m.group(2) or "", lo + m.start()


def check(path, function):
    raw = open(path, encoding="utf-8", errors="replace").read()
    code = strip_noise(raw)
    problems = []
    for params, start, end in function_bodies(code, function):
        top = []  # the lambdas written directly in the function, not inside another lambda
        for found in lambdas(code, start + 1, end):
            if not top or found[1] > top[-1][2]:
                top.append(found)
        # The names the function itself declares: its text without the bodies of its lambdas.
        own = list(code[start:end])
        for _capture, lo, hi, _params, first in top:
            for k in range(first - start, hi - start + 1):
                own[k] = " " if own[k] != "\n" else "\n"
        outer = declared_names("".join(own)) | param_names(params)
        for capture, lo, hi, lparams, _first in top:
            caps = [c.strip() for c in capture.split(",") if c.strip()]
            by_ref_default = "&" in caps
            by_ref_named = {c[1:].strip() for c in caps if c.startswith("&") and len(c) > 1}
            by_value = {c for c in caps if re.fullmatch(r"[A-Za-z_]\w*", c)}
            if not by_ref_default and not by_ref_named:
                continue
            first_line_end = raw.find("\n", lo)
            marker_line = raw[raw.rfind("\n", 0, lo) + 1:first_line_end]
            line_no = raw.count("\n", 0, lo) + 1
            if "handler-capture-ok" in marker_line:
                continue
            body = code[lo:hi + 1]
            inner = declared_names(body) | param_names(lparams.strip("()"))
            used = {n for n in IDENT.findall(body) if n not in KEYWORDS}
            for name in sorted(used & outer):
                if name in inner or name in by_value:
                    continue
                if by_ref_default or name in by_ref_named:
                    problems.append((line_no, name, capture))
    return problems


def main(argv):
    function = "Server::Server"
    files = []
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--function":
            function = args.pop(0)
        else:
            files.append(a)
    if not files:
        print(__doc__)
        return 2
    bad = 0
    for path in files:
        for line, name, capture in check(path, function):
            print(f"{path}:{line}: lambda [{capture}] keeps a reference to '{name}', a local of {function}; "
                  f"capture it by value ([&, {name}]) or call a member instead")
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
