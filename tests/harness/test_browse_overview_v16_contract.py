from pathlib import Path
import css_sources

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_storage_tab_starts_with_the_composition_card_without_key_value_lists() -> None:
    ui = read("src/static/app_explorer_detail.js")
    storage = ui[ui.index("function renderStorageTab") : ui.index("function ingestionState")]
    assert "simpleRows(" not in ui
    assert "renderStorageCompositionCard(container, detail);" in storage
    card = ui[ui.index("function renderStorageCompositionCard") : ui.index("function renderDisks")]
    assert "buildStorageComposition(detail, { embedded: true })" in card
    assert 'sectionTitle("Storage breakdown")' not in ui


def test_share_and_composition_percentages_are_unknown_when_not_derivable() -> None:
    ui = read("src/static/app_explorer_detail.js")
    assert "if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;" in ui
    assert 'bar.appendChild(h("span", { class: "explorerStorageStackedBar__unknown" }, "unknown"));' in ui
    # The Share tile exists only when both byte totals are known and non-zero.
    assert "footprint > 0 && dbBytes != null && dbBytes > 0" in ui
    for label in ["Wide", "Compact", "Projections", "Indexes"]:
        assert f'["{label}",' in ui


def test_storage_breakdown_reuses_query_sorting_and_numeric_alignment() -> None:
    ui = read("src/static/app_explorer_detail.js")
    results = read("src/static/app_results.js")
    css = css_sources.text()
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'className: `explorerTable ${className}`' in ui
    assert 'className: `explorerStorageResultTable--${kind}`' in ui
    assert "ns.table.sortHeader(th, {" in results
    assert 'display.sort((a, b) =>' in results
    assert 'explorerStoragePercentCell' in ui
    assert 'font-variant-numeric: tabular-nums;' in css


def test_buffer_rows_are_normalized_to_resident_rows() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert "void normalize_buffer_runtime_rows" in catalog
    assert 'parse_engine_arguments_local(table.engine_full, "Buffer")' in catalog
    assert "std::unordered_map<std::string, std::optional<uint64_t>> raw_rows;" in catalog
    assert "table.rows = readable_rows - target_readable_rows;" in catalog
    assert "if (readable_rows < target_readable_rows)" in catalog
    assert 'return isBufferSummary(summary) ? `${value} buffered rows` : `${value} rows`;' in ui


def test_storage_and_operations_are_separate_tabs_of_collapsible_sections() -> None:
    ui = read("src/static/app_explorer_detail.js")
    tabs = ui[ui.index("function availableTabs") : ui.index("function openTab")]
    assert 'if (!empty && (isMergeTreeSummary(summary) || isLogFamilySummary(summary))) tabs.push("Storage");' in tabs
    assert 'if (!empty && hasOperations(detail)) tabs.push("Operations");' in tabs
    storage = ui[ui.index("function renderStorageTab") : ui.index("function ingestionState")]
    for section in ["disks", "parts", "partitions", "indexes", "projections"]:
        assert f'id: "{section}"' in storage
    assert "renderMerges" not in storage
    operations = ui[ui.index("function operationSections") : ui.index("function renderLineageTab")]
    for section in ["replication", "replication_queue", "merges", "mutations", "ingestion", "distribution_queue", "cluster"]:
        assert f'id: "{section}"' in operations
    # Sections with data first, then one muted line naming the empty ones.
    render = ui[ui.index("function renderSections") : ui.index("function objectType")]
    assert "const shown = sections.filter((item) => item && item.hasData);" in render
    assert 'h("div", { class: "explorerIdleLine" }' in render


def test_structure_zero_is_known_only_after_successful_metadata_queries() -> None:
    catalog = read("src/explorer_catalog.cpp")
    assert "std::unordered_set<std::string> index_seen;" in catalog
    assert "if (indexes_loaded)" in catalog
    assert "table->secondary_indices_bytes = 0;" in catalog
    assert "if (projections_loaded)" in catalog
    assert "table->projection_bytes = 0;" in catalog
    assert "table->secondary_indices_bytes.has_value() && !projection_seen.count(key)" not in catalog
