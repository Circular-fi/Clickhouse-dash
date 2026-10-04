"""The Explorer card (docs/explorer.md): Storage as a card tab, the Columns tab's
sizes and size map, the keys one element per line, the expressions coloured by
the shared highlighter, the About panel that never truncates, the tree without
a reserved scrollbar gutter.

The splitting and highlighting unit checks live in explorer_card_unit.js (Node
loads app_explorer_detail.js and app_highlight.js in a bare window).
"""
import json
import re
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import css_sources

ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[2])).resolve()
STATIC = ROOT / "src" / "static"
UNIT = Path(__file__).with_name("explorer_card_unit.js")


def read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_key_splitting_and_highlighting_unit_checks() -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed (the tests image has it)")
    proc = subprocess.run([node, str(UNIT), str(ROOT)], capture_output=True, text=True, timeout=60, check=False)
    assert proc.returncode == 0, proc.stderr
    result = json.loads(proc.stdout)
    assert result["checks"] >= 30, result["checks"]
    assert not result["failures"], json.dumps(result["failures"], indent=1, ensure_ascii=False)


def test_the_object_tree_reserves_no_scrollbar_gutter() -> None:
    for selector in (".explorerListPane", ".explorerTableList"):
        assert "scrollbar-gutter" not in css_sources.decls(selector), selector
    # Nor does any rule of the Functions list, which shares the pane class.
    assert "scrollbar-gutter" not in css_sources.decls("#explorerFunctionList")


def test_storage_is_a_table_card_tab_and_part_of_the_database_page() -> None:
    ui = read("app_explorer.js")
    detail = read("app_explorer_detail.js")
    # Two Catalog modes; Storage is a tab of the table card (merging the
    # former Parts & disks tab and Storage mode) and part of the database
    # page, which has no tabs (user, 2026-10-04): its size band (Tables by
    # size) first, then the objects, then the disks (user, 2026-10-04
    # evening: the size band before the table on every size view).
    assert 'const MODES = ["browse", "graph"];' in ui
    assert 'const TABS = ["Columns", "Preview", "Storage", "Operations", "Lineage", "DDL"];' in ui
    assert "TAB_LABELS" not in detail and "Parts & disks" not in detail
    assert "DATABASE_TABS" not in ui and not re.search(r"\bdatabaseTab\b", ui + detail) and "openDatabaseTab" not in ui + detail
    page = ui[ui.index("function renderDatabaseDetail(database) {"):ui.index("const DATABASE_OBJECT_COLUMNS")]
    assert "const storage = renderDatabaseStorage(body, name, disks);\n    renderDatabaseObjects(body, name, tables);\n    body.appendChild(disks);" in page
    assert "dom.explorerDetailTabs.hidden = true;" in page
    # The partitions list keeps the former Storage mode's share column and map.
    block = detail[detail.index("function renderPartitions("):detail.index("function structureItems(")]
    assert 'label: "Share"' in block and "ns.table.shareBar(td," in block
    assert 'id: "explorerPartitionTreemap",' in block
    # The database's disks come with its catalog branch.
    api = (ROOT / "src" / "api_explorer.cpp").read_text(encoding="utf-8")
    assert "for (const auto& disk : catalog_result.value->database_disks) {" in api
    assert "model.databaseDisks.set(name, Array.isArray(payload?.disks) ? payload.disks : []);" in ui


def test_columns_show_both_sizes_and_a_size_map() -> None:
    detail = read("app_explorer_detail.js")
    columns = detail[detail.index("function renderColumnsTab("):detail.index("function structureCompressedBytes(")]
    assert 'label: "Compressed",' in columns and 'label: "Uncompressed",' in columns
    assert columns.index('label: "Compressed",') < columns.index('label: "Uncompressed",')
    assert "if (hasBytes) renderColumnSizes(container, detail, rows);" in columns
    assert 'id: "explorerColumnTreemap",' in columns
    assert '{ value: "uncompressed", label: "Uncompressed"' in columns
    # One treemap module: columns are its leaves, coloured by type family (the
    # one size map with hues, legend-backed); every other cell is the accent tint.
    treemap = read("app_explorer_treemap.js")
    assert "function columnFamily(type) {" in treemap
    assert 'return node?.kind === "column" ? columnFamily(node.type).color : "";' in treemap
    assert "hashName" not in treemap and "databaseColor" not in treemap and "ENGINE_FAMILIES" not in treemap


def test_keys_are_listed_one_element_per_line_with_their_position() -> None:
    detail = read("app_explorer_detail.js")
    assert "function keyElements(expression) {" in detail
    assert "function keysTile(summary) {" in detail
    for label in ['["ORDER BY", sorting, "order_by"', '["PRIMARY KEY",', '["PARTITION BY",', '["SAMPLE BY",']:
        assert label in detail, label
    assert 'item.append(h("span", { class: "explorerKeys__position" }, String(index)), exprEl(element, "explorerKeys__expr"));' in detail
    # The Columns tab's badges name the position too.
    assert "const positions = keyColumnPositions(expression, column.name);" in detail


def test_expressions_use_the_shared_highlighter_and_repaint_with_the_function_list() -> None:
    detail = read("app_explorer_detail.js")
    meta = read("app_meta.js")
    assert "renderHighlightedCode(code, code.dataset.sql || \"\");" in detail
    assert "ns.highlight.renderInto" not in detail
    for use in ['exprEl(expression, "explorerColumns__expr")', "td.appendChild(exprEl(item.codec));", "td.appendChild(exprEl(item.expression));",
                "line.append(exprEl(base),", "td.appendChild(exprEl(m.command || \"\"));"]:
        assert use in detail, use
    assert 'window.dispatchEvent(new CustomEvent("chdash:meta-changed"' in meta
    assert 'window.addEventListener("chdash:meta-changed", () => {' in detail
    # A returning visit (host restored from storage) still gets the list.
    ui = read("app_explorer.js")
    assert 'const missing = ["functions", "keywords"].filter((type) => !host?.[type]);' in ui
    assert "if (missing.length) void ns.meta.fetchAndStore?.(hostId, missing);" in ui
    # No colour of its own: the expressions take the .tok-* rules.
    css = css_sources.text()
    assert ".explorerExpr .tok-" not in css


def test_about_never_truncates() -> None:
    # The About rules sit in the features layer, after the stat tile's
    # nowrap + ellipsis (components layer), and override them.
    decls = css_sources.decls(".explorerAboutTile__value")
    assert decls["white-space"] == "normal" and decls["overflow-wrap"] == "anywhere" and decls["text-overflow"] == "clip"
    assert ".explorerAboutTile__value" not in (STATIC / "css" / "10-components" / "stat.css").read_text(encoding="utf-8")
    assert css_sources.decls(".explorerAbout .explorerLineageChip__name")["white-space"] == "normal"
    detail = read("app_explorer_detail.js")
    about = detail[detail.index("function aboutTile("):detail.index("function keysTile(")]
    assert ".length > 28" not in about and ".length > 36" not in about


def test_all_databases_heads_the_tree_and_the_root_draws_the_databases_as_a_treemap() -> None:
    ui = read("app_explorer.js")
    # The tree's first row: the Catalog root, current while nothing is selected.
    assert "dom.explorerTableList.appendChild(treeRootRow());" in ui
    row = ui[ui.index("function treeRootRow() {"):ui.index("function renderTableList() {")]
    assert 'class: `explorerTreeDatabase explorerTreeRoot${current ? " is-selected" : ""}`,' in row
    assert 'if (current) button.setAttribute("aria-current", "true");' in row
    assert 'ns.icon.el("stack",' in row and "openCatalogRoot();" in row
    # The root's treemap: the System Overview's component through the storage band.
    root = ui[ui.index("function renderBrowseRoot() {"):ui.index("function browseRootShown() {")]
    assert "renderDatabasesTreemap(section, rows);" in root
    assert "explorerSectionCount" not in root
    assert 'id: "explorerDatabasesTreemap",' in root and 'kind: "database",' in root
    # All databases is always a treemap (strip: "never"), as on the System Overview.
    assert 'strip: "never",' in root and "explorerDatabasesStrip" not in root
    assert 'if (target.kind === "database" && target.database) selectDatabase(target.database);' in root
    css = css_sources.text()
    assert ".explorerTreeRoot.is-selected {" in css
