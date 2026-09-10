from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_catalog_uses_runner_as_acl_authority_and_metadata_fallback() -> None:
    catalog = read("src/explorer_catalog.cpp")

    assert "load_base_summaries(system, runner, allowed" in catalog
    assert "runner metadata fallback failed" in catalog
    assert "Fill only the missing runner-authorized objects" in catalog
    assert "Technical metadata account cannot see runner-readable object" not in catalog
    assert '" AND name = " + quote_string(entry.table) + " LIMIT 1"' in catalog


def test_table_detail_recovers_safe_per_object_metadata_through_runner() -> None:
    catalog = read("src/explorer_catalog.cpp")

    assert "load_ddl(runner" in catalog
    assert "load_columns(runner" in catalog
    assert "load_describe(runner" in catalog
    assert "block_bool_at(block, 7, row)" in catalog
    assert "ch_block_u64_at(block, column, row) != 0" in catalog


def test_graph_does_not_depend_on_version_specific_system_buffers() -> None:
    graph = read("src/explorer_graph.cpp")

    assert "system.buffers" not in graph.replace("`system.buffers`", "")
    assert "total_rows" in read("src/explorer_catalog.cpp")
    assert "total_bytes" in read("src/explorer_catalog.cpp")


def test_integration_contract_distinguishes_parts_from_partitions_and_dynamic_objects() -> None:
    routes = read("tests/backend-functional/test_routes.py")

    assert 'get("partitions") or 0) == 1' in routes
    assert 'get("active_parts") or 0) >= 3' in routes
    assert "test_explorer_catalog_survives_runner_created_object_after_startup" in routes
    assert '"refresh": "1"' in routes
