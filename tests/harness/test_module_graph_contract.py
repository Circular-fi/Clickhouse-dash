"""The frontend is ES modules that import each other (ARCH-F-001).

Every src/static/app_*.js is a module; a page is its entry (src/static/modules.json) and what the entry imports. A script
that is on no page, an import that is not a sibling module, a cycle and a module that reads the window.ChDash handle
fail tools/module_graph.py, which the harness, build_page_css.py --check and the stage run.
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


def test_the_modules_import_each_other_in_a_graph_without_cycle_and_every_script_is_on_a_page():
    assert graph().problems() == []


def test_the_static_imports_of_a_module_are_read_in_order():
    mg = graph()
    text = '''// import { ignored } from "./app_comment.js";
import { a, b } from "./app_one.js";
import "./app_two.js";
export { c } from "./app_three.js";
import {
  d,
  e,
} from "./app_four.js";
const x = "import { f } from './app_five.js';";
'''
    assert mg.static_imports("app_x.js", text) == ["app_one.js", "app_two.js", "app_three.js", "app_four.js"]


def test_a_cycle_of_imports_is_found():
    mg = graph()
    assert mg.cycle_in({"a.js": ["b.js"], "b.js": ["c.js"], "c.js": ["a.js"]}) == ["a.js", "b.js", "c.js", "a.js"]
    assert mg.cycle_in({"a.js": ["b.js"], "b.js": []}) is None


def test_a_closure_lists_the_dependencies_before_the_module():
    mg = graph()
    deps = {"app_top.js": ["app_mid.js", "app_leaf.js"], "app_mid.js": ["app_leaf.js"], "app_leaf.js": []}
    assert mg.closure("app_top.js", imports=lambda name: deps[name]) == ["app_leaf.js", "app_mid.js", "app_top.js"]


def test_staging_writes_the_hash_of_an_import_into_the_specifier():
    mg = graph()
    text = 'import { a } from "./app_one.js";\nimport "./app_two.js";\nexport { b } from "./app_three.js";\nconst s = "./app_one.js";\n'
    out = mg.rewrite(text, {"app_one.js": "111", "app_two.js": "222"})
    assert 'from "./app_one.js?v=111";' in out and 'import "./app_two.js?v=222";' in out
    # A module without a version (not staged) and a string that is not an import stay as they are.
    assert 'from "./app_three.js";' in out and 'const s = "./app_one.js";' in out


def test_the_pages_import_what_they_use_and_the_page_files_are_the_closure_of_the_entry():
    mg = graph()
    data = mg.manifest()
    for page in data["pages"]:
        files = mg.page_files(page, data)
        assert files[-1] == data["pages"][page]["entry"], page
        assert "app_loader.js" in files and "app_state.js" in files, page
        assert len(files) == len(set(files)), page
