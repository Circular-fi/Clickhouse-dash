from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_browse_uses_flat_storage_breakdown_and_share_bars() -> None:
    ui = read("src/static/app_explorer.js")
    css = read("src/static/style.css")
    assert "explorerKvGrid" not in ui
    assert "explorerSchemaList" not in ui
    assert "explorerKvGrid" not in css
    assert "explorerSchemaList" not in css
    assert 'ns.results?.createStaticResultTable?.({' in ui
    assert 'options.subcolumn || item.is_subcolumn ? `<${item.name}>`' in ui
    assert 'renderStorageMetricTable(container, "Indexes", "indexes"' in ui
    assert 'renderStorageMetricTable(container, "Projections", "projections"' in ui
    assert 'renderTableFootprint(container, detail);' in ui
    assert 'Table / ${scope}' in ui
    assert 'className = "explorerPercentBar"' not in ui  # built through the shared node() helper
    assert 'explorerPercentBar explorerPercentBar--${variant}' in ui
    assert '.explorerPercentBar__fill' in css


def test_tuple_subcolumns_and_structure_sizes_are_loaded_from_clickhouse_metadata() -> None:
    header = read("src/explorer_catalog.hpp")
    catalog = read("src/explorer_catalog.cpp")
    api = read("src/api_explorer.cpp")
    assert "bool is_subcolumn = false;" in header
    assert "std::string parent_name;" in header
    assert "describe_include_subcolumns = 1" in catalog
    assert "subcolumns.names" in catalog
    assert "subcolumns.data_compressed_bytes" in catalog
    assert "subcolumns.data_uncompressed_bytes" in catalog
    assert "system.data_skipping_indices" in catalog
    assert "toString(data_compressed_bytes)" in catalog
    assert "system.projection_parts" in catalog
    assert "sum(data_compressed_bytes)" in catalog
    assert 'w.Key("is_subcolumn")' in api
    assert 'w.Key("parent_name")' in api
    assert 'w.Key("compressed_bytes")' in api
    assert 'w.Key("uncompressed_bytes")' in api


def test_create_statement_contextual_ddl_keywords_are_highlighted() -> None:
    ui = read("src/static/app_explorer.js")
    highlighter = read("src/static/app_highlight.js")
    assert 'ns.highlight.renderInto(codeEl, text);' in ui
    for keyword in ["index", "projection", "type", "granularity", "ttl", "codec"]:
        assert f'"{keyword}"' in highlighter
    assert 'const isKw = isCommon || (kwSet && kwSet.has(wLower));' in highlighter
    assert 'if (isFnName(fnMeta, word)) isFn = true;' in highlighter
    assert 'ns.highlight = { attach, toHtml, renderInto };' in highlighter


def test_wide_types_preview_reads_decimal_at_its_physical_width_and_open_query_crosses_documents() -> None:
    encoder = read("src/json_clickhouse.hpp")
    ui = read("src/static/app_explorer.js")
    assert "const size_t precision = d ? d->GetPrecision() : 38;" in encoder
    assert "precision <= 9" in encoder and "it.get<int32_t>()" in encoder
    assert "precision <= 18" in encoder and "it.get<int64_t>()" in encoder
    assert "it.get<clickhouse::Int128>()" in encoder
    assert 'sessionStorage.setItem("chdash.editor.draft.v2", text);' in ui
    assert 'window.location.assign(appRoute("/query"));' in ui
    assert 'filter((column) => column?.is_subcolumn !== true)' in ui


def test_lineage_layout_allocates_global_rows_and_interrow_routing_lanes() -> None:
    graph = read("src/static/app_explorer_graph.js")
    assert "const lineageRows = new Map();" in graph
    assert "const assignRows = (group) =>" in graph
    assert "for (let sweep = 0; sweep < 6; sweep += 1)" in graph
    assert "const betweenRowYs = [];" in graph
    assert "const preferredHorizontalYs = isLogicalDependencyEdge(edge)" in graph
    assert "horizontalLanePenalty(nextPoint.y)" in graph
