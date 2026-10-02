from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_buffer_rows_use_one_system_tables_snapshot_before_parts_override() -> None:
    catalog = read("src/explorer_catalog.cpp")
    load = catalog[catalog.index("bool load_explorer_catalog("):]
    normalize_pos = load.index("normalize_buffer_runtime_rows(out.tables);")
    parts_pos = load.index("load_parts_summary(system, allowed, map")
    assert normalize_pos < parts_pos
    assert "raw_rows.emplace(table_key(table.database, table.name), table.rows);" in catalog
    assert "table.rows = readable_rows - target_readable_rows;" in catalog
    assert "table.rows.reset();" in catalog
    assert "readable_rows < target_readable_rows" in catalog
    assert "? visible_rows - target_rows : 0" not in catalog


def test_buffer_bytes_are_resident_memory_not_database_disk_footprint() -> None:
    catalog = read("src/explorer_catalog.cpp")
    assert 'if (summary.engine == "Buffer" || summary.engine == "Memory" || summary.engine == "Dictionary")' in catalog
    assert "summary.resident_bytes = total_bytes;" in catalog
    assert "summary.logical_bytes.reset();" in catalog
    assert "db.bytes += table.logical_bytes.value_or(0);" in catalog
    ui = read("src/static/app_explorer_detail.js")
    assert "renderResidentRuntime" not in ui
    assert '"Resident rows"' not in ui
    assert '"Resident memory"' not in ui
    # One size label: RAM for resident engines, disk otherwise; 0 B is hidden.
    assert '`${format.bytes(footprint)} ${resident ? "RAM" : "on disk"}`' in ui
    assert 'if (!viewLike && footprint != null && footprint > 0) {' in ui
    assert 'node("span", "explorerBufferRuntime__label", "Flush target")' not in ui


def test_storage_metric_unknown_values_render_as_one_dash_inside_tables() -> None:
    ui = read("src/static/app_explorer_detail.js")
    assert 'const DASH = format.EMPTY;' in ui
    assert 'item.compressed == null ? DASH : format.bytes(item.compressed)' in ui
    assert 'item.percent == null ? DASH : percentText(item.percent)' in ui
    assert 'ns.results?.createStaticResultTable?.({' in ui
    # The composition bar keeps an explicit unknown state.
    assert '"explorerStorageStackedBar__unknown", "unknown"' in ui


def test_lineage_has_one_normalized_two_direction_layout() -> None:
    ui = read("src/static/app_explorer_detail.js")
    css = read("src/static/style.css")
    deps = ui[ui.index("function renderLineageTab"):ui.index("function previewLimit")]
    assert 'const matrix = node("div", "explorerDependencyMatrix explorerLineage");' in deps
    assert 'for (const relation of ["upstream", "downstream"])' in deps
    assert 'if (!items.length) list.appendChild(emptyNote(' in deps
    assert ".explorerDependencyMatrix" in css
    assert "grid-template-columns: repeat(2, minmax(0, 1fr));" in css


def test_graph_labels_buffer_rows_and_memory_as_ram() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert 'node.kind === "buffer" ? " buffered rows" : " rows"' in graph
    assert 'node.kind === "buffer" || node.kind === "memory" || node.kind === "dictionary"' in graph
    assert 'memoryResident ? " RAM" : " logical"' in graph
