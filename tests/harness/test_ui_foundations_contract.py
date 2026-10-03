"""Shared UI foundations: ns.format, ns.palette and the semantic colour tokens.

The unit checks live in ui_foundations_unit.js (Node runs both modules in a
bare window, no DOM) and run once per time zone below: browser-local time is
the display zone, so the date, year and DST edges move with TZ. The contracts
keep the modules first in every loader, the semantic tokens defined for every
theme block, and docs/ui-foundations.md naming every export and token.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import css_sources

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
UNIT = Path(__file__).with_name("ui_foundations_unit.js")
DOC = ROOT / "docs" / "ui-foundations.md"

ZONES = ["UTC", "Europe/Paris", "America/New_York", "Asia/Kolkata", "Australia/Lord_Howe"]

SEMANTIC_TOKENS = [
    "--danger", "--danger-bg", "--warning", "--warning-bg", "--success", "--success-bg", "--info", "--info-bg",
    "--sev-fatal", "--sev-error", "--sev-warn", "--sev-info", "--sev-debug", "--sev-trace",
    "--accent-fill", "--accent-tint", "--accent-text",
    "--kind-table", "--kind-view", "--kind-mv", "--kind-dict", "--kind-buffer", "--kind-distributed",
    "--pct-p50", "--pct-p90", "--pct-p95", "--pct-p99",
    "--json-string", "--json-number", "--json-bool", "--json-null",
]


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("zone", ZONES)
def test_format_and_palette_unit_checks(zone: str) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed (the tests image has it)")
    env = {**os.environ, "TZ": zone}
    proc = subprocess.run([node, str(UNIT), str(ROOT)], capture_output=True, text=True, env=env, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["zone"] == zone
    assert result["checks"] > 250, result["checks"]
    assert not result["failures"], json.dumps(result["failures"], indent=1, ensure_ascii=False)


def test_format_and_palette_load_first_in_every_loader() -> None:
    # One manifest for every page: its common modules load first, format and palette leading.
    manifest = json.loads(read("modules.json"))
    assert manifest["common"][:3] == ["app_format.js", "app_palette.js", "app_dom.js"]
    for page in manifest["pages"].values():
        assert not {"app_format.js", "app_palette.js", "app_dom.js"} & set(page["modules"])


def test_util_formatters_delegate_without_changing_their_output() -> None:
    util = read("app_util.js")
    assert "const format = ns.format;" in util
    assert 'if (!Number.isFinite(n)) return "-";\n    return format.count(Math.trunc(n));' in util
    assert 'if (!Number.isFinite(n)) return "-";\n    return format.bytes(n);' in util
    # formatSeconds prints "1.234s", not ns.format.duration's "1.23 s": it stays.
    assert "return `${n.toFixed(3)}s`;" in util


def test_format_sources_escape_characters_above_latin1() -> None:
    source = read("app_format.js")
    assert 'const EMPTY = "\\u2014";' in source
    assert 'const ARROW = "\\u2192";' in source
    assert 'const MICRO = "\\u00b5";' in source
    assert not re.search(r"[^\x00-\x7f]", source + read("app_palette.js"))


def theme_blocks(css: str) -> dict[str, dict[str, str]]:
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    blocks: dict[str, dict[str, str]] = {"root": {}, "light-media": {}, "dark": {}, "light": {}}
    for media, selector, body in iter_rules(css):
        key = {
            ("", ":root"): "root",
            ("@media (prefers-color-scheme: light)", ":root"): "light-media",
            ("", 'html[data-theme="dark"]'): "dark",
            ("", 'html[data-theme="light"]'): "light",
        }.get((media, selector))
        if key:
            blocks[key].update({n: " ".join(v.split()) for n, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body)})
    return blocks


def iter_rules(text: str, media: str = ""):
    i = 0
    while True:
        j = text.find("{", i)
        if j < 0:
            return
        selector = " ".join(text[i:j].split())
        depth, k = 1, j + 1
        while depth:
            depth += {"{": 1, "}": -1}.get(text[k], 0)
            k += 1
        body = text[j + 1 : k - 1]
        if selector.startswith("@media"):
            yield from iter_rules(body, selector)
        else:
            yield media, selector, body
        i = k


def test_semantic_tokens_are_defined_in_every_theme_block() -> None:
    blocks = theme_blocks(css_sources.text())
    for name, tokens in blocks.items():
        missing = [token for token in SEMANTIC_TOKENS if token not in tokens]
        assert not missing, f"{name} lacks {missing}"
    # Forced themes equal the OS themes.
    for token in SEMANTIC_TOKENS:
        assert blocks["dark"][token] == blocks["root"][token], token
        assert blocks["light"][token] == blocks["light-media"][token], token


def test_old_families_alias_the_semantic_tokens_only_where_the_value_is_the_same() -> None:
    blocks = theme_blocks(css_sources.text())
    aliases = {
        "--error-bg": "--danger-bg", "--accentText": "--accent-text", "--graph-error": "--danger",
    }
    for name, tokens in blocks.items():
        for old, new in aliases.items():
            assert tokens[old] == f"var({new})", (name, old)
    # The former --accent (a solid fill in dark, a tint in light) is gone: its callers
    # name --accent-fill or --accent-tint.
    for name, tokens in blocks.items():
        assert "--accent" not in tokens, name
    assert "var(--accent)" not in css_sources.text()


def exported(source: str, namespace: str) -> list[str]:
    block = re.search(rf"ns\.{namespace} = Object\.freeze\(\{{(.*?)\}}\);", source, re.S).group(1)
    return re.findall(r"^\s*(\w+),?$", block, re.M)


def test_ui_foundations_doc_lists_every_export_and_token() -> None:
    doc = DOC.read_text(encoding="utf-8")
    fmt = exported(read("app_format.js"), "format")
    pal = exported(read("app_palette.js"), "palette")
    assert {"duration", "count", "compact", "bytes", "bytesRate", "percent", "rate", "time", "timeTitle", "range", "ago", "emptyIfNull", "nullToken", "EMPTY"} <= set(fmt)
    assert {"categorical", "service", "quantile", "severity", "sequential", "kind", "resolve"} <= set(pal)
    adapters = re.findall(r"^\s*duration\.(\w+) = ", read("app_format.js"), re.M)
    assert sorted(adapters) == ["fromMs", "fromSeconds", "fromUs"]
    names = [f"format.{n}" for n in fmt] + [f"format.duration.{n}" for n in adapters] + [f"palette.{n}" for n in pal]
    missing = [name for name in names if f"`{name}" not in doc]
    assert not missing, f"docs/ui-foundations.md does not list {missing}"
    missing_tokens = [token for token in SEMANTIC_TOKENS if f"`{token}`" not in doc]
    assert not missing_tokens, missing_tokens
    assert "no local formatters or hex colours" in doc
