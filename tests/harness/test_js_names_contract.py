"""Every name that a module of src/static reads is declared, and every import is used (tools/check_js_names.cjs, a scope check
on the AST that Node's acorn parses). A refactor that moves or removes a function leaves the call that nobody ran."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "check_js_names.cjs"


def run(*files: Path) -> subprocess.CompletedProcess:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed (the tests image has it)")
    return subprocess.run([node, "--expose-internals", "--no-warnings", str(TOOL), *map(str, files)], capture_output=True, text=True, timeout=120, check=False)


def test_the_modules_read_only_names_that_exist_and_import_only_what_they_use():
    result = run(*sorted((ROOT / "src" / "static").glob("app_*.js")))
    assert result.returncode == 0 and not result.stdout.strip(), result.stdout + result.stderr


def test_the_check_finds_an_undefined_name_and_an_unused_import(tmp_path: Path):
    sample = tmp_path / "sample.js"
    sample.write_text('import { a, b } from "./x.js";\nconst f = () => a(c);\nexport { f };\n', encoding="utf-8")
    result = run(sample)
    assert result.returncode == 1
    assert "undefined c" in result.stdout and "unused import b" in result.stdout
    ok = tmp_path / "ok.js"
    ok.write_text('import { a } from "./x.js";\nlet total = 0;\nfor (const item of [1]) { total += a(item); }\nexport { total };\n', encoding="utf-8")
    assert run(ok).returncode == 0
