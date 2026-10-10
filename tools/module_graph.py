"""The module graph of src/static: what each script needs, and a check that the declaration is true.

Every script of a page is an IIFE that reads the others from `window.ChDash` (`ns`). Nothing in the code
says which one it needs, so src/static/modules.json declares it:

  deps[file]   the scripts `file` needs on every page that loads it: the page lists them (and lists them
               before `file` when `file` reads one of their `ns` members at load time).
  late[file]   scripts `file` only uses when they are there: a page may not load them, or loading them
               first would close a cycle. The code reads them at run time behind a guard
               (`ns.x?.y()`, `if (ns.x)`), never at load time.

`python3 tools/module_graph.py` (also run by tools/build_page_css.py --check and by the harness) fails when

  - a script uses a member of another script that its entry does not name (the member -> script table
    is read from the `ns.<member> = ...` lines of the scripts),
  - an entry names a script that the code does not use,
  - the deps have a cycle, or a page lists a script without one of its deps,
  - a `late` entry could be a dep (the target is on every page of the source and no cycle forbids it).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "static"
MANIFEST = STATIC / "modules.json"
LOADER = "app_loader.js"
# Shipped, listed on no page: the Worker script of the WebAssembly kernels (app_wasm.js starts it by name).
UNLISTED = {"app_wasm_worker.js"}
# The members of the shared `ns.ui` object, by the script that adds them (app_ui.js adds the rest).
UI_MEMBERS = {
    "app_ui_chart.js": ("chartCardHtml", "sparkline"),
    "app_ui_copy.js": ("copyText", "copyFeedback", "copyButton", "copyButtonHtml", "copyIconHtml", "copySplit", "downloadText"),
    "app_ui_kv.js": ("kvList", "kvListHtml", "kvBind"),
    "app_ui_sql.js": ("sqlBlock", "sqlBlockHtml", "sqlBind"),
    "app_ui_stat.js": ("statTile", "statTileHtml", "statTilesHtml"),
}
# Aliases of one function under a second name (docs/ui-foundations.md): the script that owns the second name.
ALIAS_OWNERS = {"rovingRows": "app_ui_table.js", "sqlBlock": "app_ui_sql.js", "copy": "app_ui_copy.js", "kv": "app_ui_kv.js"}


def manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(^|[\s;{}()])//[^\n]*", r"\1", text)


def sources() -> dict[str, str]:
    return {path.name: strip_comments(path.read_text(encoding="utf-8")) for path in sorted(STATIC.glob("*.js"))}


def owners(texts: dict[str, str]) -> dict[str, str]:
    """{ns member: script that assigns it} (`ns.x = ...`, not `ns.x.y = ...`)."""
    out: dict[str, str] = {}
    for name, text in texts.items():
        for member in re.findall(r"^\s*ns\.([A-Za-z_]\w*)\s*=[^=]", text, flags=re.M):
            out.setdefault(member, name)
    out.pop("ui", None)
    out.update(ALIAS_OWNERS)
    return out


DESTRUCTURE = re.compile(r"\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*ns\s*;")


def uses(name: str, text: str, table: dict[str, str]) -> set[str]:
    """The scripts `name` reads through `ns`: direct members, destructured ones and the members of `ui`."""
    members = set(re.findall(r"\bns\.([A-Za-z_]\w*)", text)) | set(re.findall(r"\bChDash\??\.([A-Za-z_]\w*)", text))
    for group in DESTRUCTURE.findall(text):
        for part in group.split(","):
            key = part.split(":")[0].strip()
            if key:
                members.add(key)
    found = {table[member] for member in members if member in table}
    if "ui" in members and name != "app_ui.js":
        subs = set(re.findall(r"\bns\.ui\??\.([A-Za-z_]\w*)", text)) | set(re.findall(r"(?<![\w.])ui\??\.([A-Za-z_]\w*)", text))
        for sub in subs:
            owner = next((script for script, names in UI_MEMBERS.items() if sub in names), "app_ui.js")
            found.add(owner)
    if "loader" in members or any(re.search(r"\bloader\b", g) for g in DESTRUCTURE.findall(text)):
        found.add(LOADER)
    found.discard(name)
    return found


def page_lists(data: dict, page: str) -> list[str]:
    entry = data["pages"][page]
    return [LOADER, *data["common"], *entry["modules"], entry["bootstrap"]]


def lazy_files(data: dict, page: str) -> set[str]:
    return {name for files in (data["pages"][page].get("lazy") or {}).values() for name in files}


def cycle_in(deps: dict[str, list[str]]) -> list[str] | None:
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(name: str) -> list[str] | None:
        state[name] = 1
        stack.append(name)
        for target in deps.get(name, []):
            if state.get(target) == 1:
                return [*stack[stack.index(target) :], target]
            if target not in state and (found := visit(target)):
                return found
        stack.pop()
        state[name] = 2
        return None

    for name in deps:
        if name not in state and (found := visit(name)):
            return found
    return None


def problems() -> list[str]:
    data = manifest()
    deps: dict[str, list[str]] = data["deps"]
    late: dict[str, list[str]] = data["late"]
    texts = sources()
    table = owners(texts)
    out: list[str] = []
    listed = {LOADER}
    for page in data["pages"]:
        listed |= set(page_lists(data, page)) | lazy_files(data, page)
    for name in sorted(set(texts) - listed - UNLISTED):
        out.append(f"{name} is on no page")
    for name in sorted({*deps, *late}):
        if name not in texts:
            out.append(f"deps/late name a missing script: {name}")
    for name, text in texts.items():
        if name in UNLISTED or name == LOADER and False:
            continue
        used = uses(name, text, table)
        declared = set(deps.get(name, [])) | set(late.get(name, []))
        for missing in sorted(used - declared):
            out.append(f"{name} uses {missing}: declare it in deps or late")
        for extra in sorted(declared - used):
            out.append(f"{name} declares {extra} but does not use it")
        both = set(deps.get(name, [])) & set(late.get(name, []))
        for twice in sorted(both):
            out.append(f"{name} lists {twice} in deps and in late")
    if (cycle := cycle_in(deps)) is not None:
        out.append("deps cycle: " + " -> ".join(cycle))
    for page in data["pages"]:
        order = page_lists(data, page)
        loaded = set(order)
        for name in order:
            for dep in deps.get(name, []):
                if dep not in loaded:
                    out.append(f"{page}: {name} needs {dep}, which the page does not load")
        # A lazy script runs after the page started: what it needs is already there or lazy with it.
        for name in lazy_files(data, page):
            for dep in deps.get(name, []):
                if dep not in loaded and dep not in lazy_files(data, page):
                    out.append(f"{page}: lazy {name} needs {dep}, which the page does not load")
    # A late entry is justified by a page without the target, or by a cycle.
    pages_of = {name: [page for page in data["pages"] if name in page_lists(data, page)] for name in texts}
    for name, targets in late.items():
        for target in targets:
            absent = any(target not in page_lists(data, page) for page in pages_of.get(name, []))
            if absent:
                continue
            trial = {key: list(value) for key, value in deps.items()}
            trial.setdefault(name, []).append(target)
            if cycle_in(trial) is None:
                out.append(f"{name} lists {target} in late, but every page that loads it loads {target}: make it a dep")
    return out


def main() -> int:
    found = problems()
    for line in found:
        print(line, file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
