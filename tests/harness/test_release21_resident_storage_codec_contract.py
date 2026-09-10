from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_buffer_memory_and_dictionary_are_resident_not_disk_footprints() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert 'summary.engine == "Buffer" || summary.engine == "Memory" || summary.engine == "Dictionary"' in catalog
    assert "summary.resident_bytes = total_bytes;" in catalog
    assert "summary.logical_bytes.reset();" in catalog
    assert "summary.compressed_bytes.reset();" in catalog
    assert "summary.uncompressed_bytes.reset();" in catalog
    assert "function isResidentMemorySummary(summary)" in ui
    assert "return isBufferSummary(summary) || isMemorySummary(summary) || isDictionarySummary(summary);" in ui
    overview = ui[ui.index("function renderOverview"):ui.index("function isImplementationSubcolumn")]
    assert "if (!empty && !resident && !viewLike)" in overview
    assert "renderResidentRuntime(container, detail);" not in overview
    assert "if (viewLike || resident || empty)" in overview
    assert '"Resident rows"' not in ui
    assert '"Resident memory"' not in ui


def test_buffer_flush_target_is_a_normal_downstream_dependency() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert 'if (summary.engine == "Buffer") {' in catalog
    assert 'parse_engine_arguments_local(summary.engine_full, "Buffer")' in catalog
    assert 'append_dependency(args[0], args[1], "downstream");' in catalog
    assert '"Flush target"' not in ui


def test_tinylog_log_and_stripelog_are_disk_backed_without_system_parts() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer.js")
    assert 'summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog"' in catalog
    assert "summary.physical_bytes = total_bytes;" in catalog
    assert "summary.data_paths = split_unit_separator" in catalog
    assert 'arrayStringConcat(data_paths, char(31))' in catalog
    assert 'if (key.first == name) disk_names.insert(key.second);' in catalog
    assert 'const hasStorage = isMergeTreeSummary(summary) || isDistributedSummary(summary) || isLogFamilySummary(summary);' in ui
    assert 'isLogFamilySummary(s) ? "Storage medium" : "Storage policy"' in ui
    assert 'isLogFamilySummary(s) ? "Disk"' in ui


def test_dependency_cards_are_fixed_three_per_row_and_compact() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    deps = ui[ui.index("function renderDependencies"):ui.index("function renderParts")]
    assert 'const qualified = `${dep.database || "—"}.${dep.table || "—"}`;' in deps
    assert 'explorerDependencyItem__qualified' in deps
    assert "grid-template-columns: repeat(3, minmax(0, 1fr));" in css
    assert "grid-auto-rows: 36px;" in css
    assert "grid-template-rows: auto 1fr;" in css


def test_column_default_codec_comes_from_active_parts_when_observable() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = read("src/static/app_explorer.js")
    assert "std::vector<std::string> default_compression_codecs;" in header
    assert "groupUniqArray(default_compression_codec)" in catalog
    assert 'w.Key("default_compression_codecs");' in api
    assert "detail.default_compression_codecs" in ui
    assert '`${observedDefaults[0]} (default)`' in ui
    assert '`${observedDefaults.join(" / ")} (part defaults)`' in ui
    assert ': "DEFAULT";' in ui
    assert 'server default' not in ui
