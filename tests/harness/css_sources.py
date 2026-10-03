"""The stylesheet sources (src/static/css/) for the contract tests.

The page stylesheets (style.<page>.css) are build outputs, not committed:
tests read the sources, in the order src/static/css/index.css imports them.
"""
from __future__ import annotations

import importlib.util
import sys
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS = ROOT / "src" / "static" / "css"


@lru_cache(maxsize=None)
def builder():
    spec = importlib.util.spec_from_file_location("build_page_css", ROOT / "tools" / "build_page_css.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("build_page_css", module)
    spec.loader.exec_module(module)
    return module


def files() -> list[tuple[Path, str]]:
    """[(path, layer)] in cascade order."""
    return [(CSS / name, layer) for name, layer in builder().read_index()]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def text() -> str:
    """Every source file, in cascade order, comments included."""
    return "\n".join(read(path) for path, _ in files())


COMPONENT_FILES = {"tabs": "tabs", "segmented": "segmented", "popover": "popover", "panels": "panels", "state": "state",
                   "search": "search", "data table": "table", "badge": "badge", "copy": "copy", "SQL block": "sql",
                   "key/value": "kv", "stat tile": "stat", "chart": "chart"}


def component(name: str) -> str:
    """A component's file, by file name or by its former style.css block name ("data table")."""
    return read(CSS / "10-components" / f"{COMPONENT_FILES.get(name, name)}.css")


def feature(name: str) -> str:
    return read(CSS / "20-features" / f"{name}.css")


def tokens() -> str:
    return read(CSS / "00-tokens.css")


@lru_cache(maxsize=None)
def _sheets() -> tuple:
    return tuple(builder().build().items())


def sheets() -> dict[str, str]:
    """The generated page stylesheets, built in memory: {file name: text}."""
    return dict(_sheets())


@lru_cache(maxsize=None)
def _parsed() -> tuple:
    sys.path.insert(0, str(ROOT / "tools"))
    import css_tree

    out = []

    def walk(nodes, ctx, name):
        for node in nodes:
            if isinstance(node, css_tree.Rule):
                out.append((name, ctx, node))
            elif isinstance(node, css_tree.AtRule) and node.children is not None:
                walk(node.children, ctx + (node.header(),), name)

    for path, _ in files():
        walk(css_tree.parse(read(path)), (), path.relative_to(CSS).as_posix())
    return tuple(out)


def rules(selector: str, context: str | None = None) -> list[tuple[str, tuple, str, dict[str, str]]]:
    """[(file, @-contexts, selector list, {property: value})] of the rules whose selector
    list includes `selector`, in cascade order; a value keeps its " !important".
    `context` keeps the rules directly under that @-rule header only ("" for the top level)."""
    out = []
    for name, ctx, node in _parsed():
        if selector in node.selectors and (context is None or (ctx[-1] if ctx else "") == context):
            found = {d.name: d.value + (" !important" if d.important else "") for d in node.decls}
            out.append((name, ctx, node.prelude, found))
    return out


def overrides() -> str:
    return read(CSS / "30-overrides.css")


def override(declaration: str) -> bool:
    """`declaration` ("prop: value") is written in the overrides layer, where it wins over
    every component and feature rule (what !important did before the layers)."""
    return f"{declaration};" in overrides()


def decls(selector: str, context: str | None = "") -> dict[str, str]:
    """Every declaration written for `selector` (top level by default), the later layers and
    rules winning, as the cascade orders the sources."""
    merged: dict[str, str] = {}
    for _, _, _, found in rules(selector, context):
        merged.update(found)
    return merged
