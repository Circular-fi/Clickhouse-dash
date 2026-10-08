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


def test_the_result_path_has_native_unit_tests():
    cmake = read("src/CMakeLists.txt")
    assert 'option(CHDASH_BUILD_RESULT_TESTS "Build the result path unit tests (JSON cell encoder, block encoder)" OFF)' in cmake
    assert "add_executable(chdash_result_path_test ../tests/native/result_path_test.cpp)" in cmake
    test = read("tests/native/result_path_test.cpp")
    # Every case is checked against the exact JSON text and against the generic algorithm.
    assert "reference_write(" in test and "check_column(" in test
    for case in ("test_scalars", "test_nullable_and_low_cardinality", "test_arrays_and_tuples", "test_maps", "test_many_rows_equal_the_reference", "test_map_cells_are_read_in_place",
                 "test_block_encoder_encodes_every_block_in_order", "test_block_encoder_bounds_the_queue",
                 "test_block_encoder_failure_reaches_the_receiving_thread", "test_block_encoder_cancel_stops_a_waiting_submit",
                 "test_block_encoder_destructor_drops_what_waits"):
        assert f"void {case}()" in test, case


def test_native_result_path_tests_pass_when_built():
    binary = os.environ.get("RESULT_PATH_TEST_BINARY")
    if not binary:
        pytest.skip("RESULT_PATH_TEST_BINARY is not set (build chdash_result_path_test)")
    result = subprocess.run([binary], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    assert " 0 failures" in result.stdout


def test_a_large_result_is_decoded_and_encoded_at_the_same_time():
    session = read("src/query_session.cpp")
    # A block waits for the encoder thread in a bounded queue; the first block with rows is
    # encoded in the receiving thread, so the usual one-block result starts no thread.
    encoder_header = read("src/block_encoder.hpp")
    assert "class BlockEncoder {" in encoder_header and '#include "block_encoder.hpp"' in session
    assert "constexpr size_t kEncodeQueueBlocks = 4;" in session
    assert "std::optional<BlockEncoder> encoder;" in session
    assert "encoder.emplace(encode_block, kEncodeQueueBlocks);" in session
    assert "if (block.GetRowCount() > 0) encoder->submit(block, cancel_requested_);" in session
    # What the encoder threw (cancel, cell too large, result limit) stops the next block and the end of the result.
    assert "if (error_) std::rethrow_exception(error_);" in encoder_header
    assert "if (encoder) encoder->finish();" in session
    # The thread ends before the state it encodes with: the encoder is declared after the lambda.
    assert session.index("auto encode_block = [&](const clickhouse::Block& block) {") < session.index("std::optional<BlockEncoder> encoder;")


def test_the_done_event_splits_the_elapsed_time():
    stream = read("src/api_query_stream.cpp")
    assert 'writer.Key("timing_ms");' in stream
    for part in ("receive", "encode", "backpressure"):
        assert f'writer.Key("{part}"); writer.Int64(snapshot.{part}_ms);' in stream, part
    header = read("src/query_session.hpp")
    assert "int64_t receive_ms = 0;" in header and "int64_t encode_ms = 0;" in header and "int64_t backpressure_ms = 0;" in header
    session = read("src/query_session.cpp")
    # The wait for a slow browser is the time spent in the SSE queue wait, measured where the event is queued.
    assert "backpressure_ns_ += std::chrono::duration_cast<std::chrono::nanoseconds>(" in session
    assert "receive_ns_ = std::max<int64_t>(0, select_ns - on_data_ns);" in session
    assert "encode_ns_ = std::max<int64_t>(0, encode_busy_ns - backpressure_ns_);" in session
