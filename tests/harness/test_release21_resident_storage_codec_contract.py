from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_buffer_memory_and_dictionary_are_resident_not_disk_footprints() -> None:
    catalog = read("src/explorer_catalog.cpp")
    shell = read("src/static/app_explorer.js")
    assert 'summary.engine == "Buffer" || summary.engine == "Memory" || summary.engine == "Dictionary"' in catalog
    assert "summary.resident_bytes = total_bytes;" in catalog
    assert "summary.logical_bytes.reset();" in catalog
    assert "summary.compressed_bytes.reset();" in catalog
    assert "summary.uncompressed_bytes.reset();" in catalog
    assert "function isResidentMemorySummary(summary)" in shell
    assert "return isBufferSummary(summary) || isMemorySummary(summary) || isDictionarySummary(summary);" in shell
    ui = read("src/static/app_explorer_detail.js")
    assert "renderResidentRuntime" not in ui
    assert '"Resident rows"' not in ui
    assert '"Resident memory"' not in ui
    # One size label: RAM for resident engines, disk otherwise; 0 B is hidden.
    assert '`${fmtBytes(footprint)} ${resident ? "RAM" : "on disk"}`' in ui
    assert 'if (!viewLike && footprint != null && footprint > 0) {' in ui


def test_buffer_flush_target_is_a_normal_downstream_dependency() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert 'if (summary.engine == "Buffer") {' in catalog
    assert 'parse_engine_arguments_local(summary.engine_full, "Buffer")' in catalog
    assert 'append_dependency(args[0], args[1], "downstream", "buffer");' in catalog
    assert '"Flush target"' not in ui
    # About shows where a Buffer flushes (or an MV writes) as lineage chips.
    assert 'routeKind === "buffer" ? "Flushes to" : "Writes to"' in ui


def test_tinylog_log_and_stripelog_are_disk_backed_without_system_parts() -> None:
    catalog = read("src/explorer_catalog.cpp")
    ui = read("src/static/app_explorer_detail.js")
    assert 'summary.engine == "TinyLog" || summary.engine == "Log" || summary.engine == "StripeLog"' in catalog
    assert "summary.physical_bytes = total_bytes;" in catalog
    assert "summary.data_paths = split_unit_separator" in catalog
    assert 'arrayStringConcat(data_paths, char(31))' in catalog
    assert 'if (key.first == name) disk_names.insert(key.second);' in catalog
    assert 'if (!empty && (isMergeTreeSummary(summary) || isLogFamilySummary(summary))) tabs.push("Storage");' in ui
    assert 'isLogFamilySummary(s) ? "Disks (storage medium)" : "Disks"' in ui
    # Log-family engines own no parts: no Parts column in their disk table.
    assert 'parts && { label: "Parts"' in ui


def test_lineage_chips_wrap_with_type_icon_and_short_in_database_names() -> None:
    ui = read("src/static/app_explorer_detail.js")
    css = read("src/static/style.css")
    chip = ui[ui.index("function dependencyChip"):ui.index("// ---- tabs")]
    assert 'const qualified = `${dep.database || DASH}.${dep.table || DASH}`;' in chip
    assert "button.appendChild(objectIcon(dep.engine));" in chip
    assert '"explorerLineageChip__name", shortName(dep.database, dep.table, contextDatabase)' in chip
    assert 'dep.kind === "distributed_route" && cluster' in chip
    assert ".explorerLineage__list {" in css
    assert "flex-wrap: wrap;" in css


def test_column_default_codec_comes_from_active_parts_when_observable() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    ui = (read("src/static/app_explorer.js") + read("src/static/app_explorer_detail.js"))
    assert "std::vector<std::string> default_compression_codecs;" in header
    assert "groupUniqArray(default_compression_codec)" in catalog
    assert 'w.Key("default_compression_codecs");' in api
    assert "detail.default_compression_codecs" in ui
    assert '`${observedDefaults[0]} (default)`' in ui
    assert '`${observedDefaults.join(" / ")} (part defaults)`' in ui
    assert ': "DEFAULT";' in ui
    assert 'server default' not in ui
