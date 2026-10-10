"""The modules of src/static say what they need (ARCH-F-001).

src/static/modules.json holds, for every script, the scripts it needs (`deps`: listed on the page before it) and
the ones it only uses when they are there (`late`). tools/module_graph.py reads the code and fails when the
declaration is not true; the page lists are in dependency order.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def graph():
    spec = importlib.util.spec_from_file_location("module_graph", ROOT / "tools" / "module_graph.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_declared_dependencies_are_the_ones_the_code_uses():
    assert graph().problems() == []


def test_a_cycle_of_deps_is_found():
    mg = graph()
    assert mg.cycle_in({"a.js": ["b.js"], "b.js": ["c.js"], "c.js": ["a.js"]}) == ["a.js", "b.js", "c.js", "a.js"]
    assert mg.cycle_in({"a.js": ["b.js"], "b.js": []}) is None


def test_a_member_read_through_ns_is_attributed_to_its_script():
    mg = graph()
    table = {"format": "app_format.js", "util": "app_util.js", "dialog": "app_ui_dialog.js"}
    text = "const { format } = ns; const x = ns.util.escapeHtml(1); // ns.dialog is only in a comment\n"
    assert mg.uses("app_x.js", mg.strip_comments(text), table) == {"app_format.js", "app_util.js"}
    assert mg.uses("app_util.js", mg.strip_comments(text), table) == {"app_format.js"}
