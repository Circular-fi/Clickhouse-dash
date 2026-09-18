from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_overview_is_storage_first_without_key_value_metadata_list() -> None:
    ui = read("src/static/app_explorer.js")
    overview = ui[ui.index("function renderOverview") : ui.index("function isImplementationSubcolumn")]
    assert "simpleRows(" not in overview
    assert "renderTableFootprint(container, detail);" in overview
    assert "renderTableFootprint(container, detail);" in overview
    footprint = ui[ui.index("function renderTableFootprint"):ui.index("function structureCompressedBytes")]
    assert "buildStorageComposition(detail, { embedded: true })" in footprint
    assert 'sectionTitle("Storage breakdown")' not in overview


def test_share_and_composition_percentages_are_unknown_when_not_derivable() -> None:
    ui = read("src/static/app_explorer.js")
    assert "if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;" in ui
    assert 'unknownText = "unknown"' in ui
    assert 'wrap.appendChild(node("span", "explorerPercentBar__text", unknownText));' in ui
    assert 'explorerShareList explorerShareList--footprint' in ui
    for label in ["Wide", "Compact", "Projections", "Indexes"]:
        assert f'["{label}",' in ui


def test_storage_breakdown_reuses_query_sorting_and_numeric_alignment() -> None:
    ui = read("src/static/app_explorer.js")
    results = read("src/static/app_results.js")
    css = read("src/static/style.css")
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'className: `explorerResultTable explorerStorageResultTable explorerStorageResultTable--${group}`' in ui
    assert 'th.className = "resultTable__thSortable";' in results
    assert 'display.sort((a, b) =>' in results
    assert 'explorerStoragePercentCell' in ui
    assert 'font-variant-numeric: tabular-nums;' in css


def test_buffer_rows_are_normalized_to_resident_rows() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert "void normalize_buffer_runtime_rows" in catalog
    assert 'parse_engine_arguments_local(table.engine_full, "Buffer")' in catalog
    assert "std::unordered_map<std::string, std::optional<uint64_t>> raw_rows;" in catalog
    assert "table.rows = readable_rows - target_readable_rows;" in catalog
    assert "if (readable_rows < target_readable_rows)" in catalog
    assert 'return isBufferSummary(summary) ? `${value} buffered rows` : `${value} rows`;' in ui


def test_storage_and_operations_are_combined_for_storage_backed_tables() -> None:
    ui = read("src/static/app_explorer.js")
    tabs = ui[ui.index("function availableTabs") : ui.index("function visibleFunctions")]
    assert 'if (hasStorage) tabs.push("Storage");' in tabs
    assert 'else if (!isDictionarySummary(summary)) tabs.push("Operations");' in tabs
    storage = ui[ui.index("function renderStorageCombined") : ui.index("function renderOperations")]
    assert 'sectionTitle("Ingestion activity")' in storage
    assert 'sectionTitle("Merge activity")' in storage
    assert 'renderMergeProgress(container, detail);' in storage


def test_structure_zero_is_known_only_after_successful_metadata_queries() -> None:
    catalog = read("src/explorer_catalog.cpp")
    assert "std::unordered_set<std::string> index_seen;" in catalog
    assert "if (indexes_loaded)" in catalog
    assert "table->secondary_indices_bytes = 0;" in catalog
    assert "if (projections_loaded)" in catalog
    assert "table->projection_bytes = 0;" in catalog
    assert "table->secondary_indices_bytes.has_value() && !projection_seen.count(key)" not in catalog
