"""The Query page result path: where the time of a large result goes (docs/telemetry.md).

The JSON cell encoder resolves the nested structure of a column once per block
(CellEncoder), so a row of a Tuple, Array or Map column costs no dynamic_cast, no
shared_ptr copy and no slice. The Map storage is read in place: clickhouse-cpp
only offers GetAsColumn(row), which copies every key and value of every cell.
"""
import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_the_cell_encoder_reads_nested_cells_in_place():
    header = read("src/json_clickhouse.hpp")
    assert "class CellEncoder {" in header
    # One encoder per column of a block; the row loop never resolves the type again.
    assert "explicit CellEncoder(const clickhouse::ColumnRef& column) { build(column.get()); }" in header
    assert "inline const clickhouse::ColumnArray* map_storage(const clickhouse::ColumnMap& map) {" in header
    assert "template struct PrivateMemberAccess<ColumnMapDataTag, &clickhouse::ColumnMap::data_>;" in header
    # The per-row slice of a Map cell (three new columns, every string copied) is gone.
    assert "->GetAsColumn(" not in header and ".GetAsColumn(" not in header
    # The one generic entry point keeps its signature and delegates.
    assert "CellEncoder(col).write(w, row);" in header


def test_the_hot_paths_build_one_encoder_per_column_of_a_block():
    session = read("src/query_session.cpp")
    assert "std::vector<detail::CellEncoder> encoders;" in session
    assert "for (const auto& column : columns) encoders.emplace_back(column);" in session
    assert "encoders[c].write(w, row);" in session
    assert "write_cell_json(w, columns[c], row);" not in session
    export = read("src/export_serializer.cpp")
    assert "encoders_[i].write(w, row);" in export
    assert "if (format_ != ExportFormat::Csv) encoders_.emplace_back(columns_.back());" in export
    assert "std::vector<detail::CellEncoder> encoders_;" in read("src/export_serializer.hpp")


def test_the_encoder_has_native_unit_tests():
    cmake = read("src/CMakeLists.txt")
    assert 'option(CHDASH_BUILD_JSON_TESTS "Build the JSON cell encoder unit tests" OFF)' in cmake
    assert "add_executable(chdash_json_cells_test ../tests/native/json_cells_test.cpp)" in cmake
    test = read("tests/native/json_cells_test.cpp")
    # Every case is checked against the exact JSON text and against the generic algorithm.
    assert "reference_write(" in test and "check_column(" in test
    for case in ("test_scalars", "test_nullable_and_low_cardinality", "test_arrays_and_tuples", "test_maps", "test_many_rows_equal_the_reference"):
        assert f"void {case}()" in test, case


def test_native_json_cell_tests_pass_when_built():
    binary = os.environ.get("JSON_CELLS_TEST_BINARY")
    if not binary:
        pytest.skip("JSON_CELLS_TEST_BINARY is not set (build chdash_json_cells_test)")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout
