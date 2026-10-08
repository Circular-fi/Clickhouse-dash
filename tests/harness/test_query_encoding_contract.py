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


def test_the_result_stream_is_read_with_fetch_not_event_source():
    api = read("src/static/app_api.js")
    run = read("src/static/app_run.js")
    # EventSource of Chrome splits and dispatches the stream line by line on the main thread: 700 ms for
    # 37 MB of rows against 350 ms for a fetch reader with the same JSON.parse.
    assert "class FetchEventStream {" in api and "function openEventStream(url) {" in api
    assert "return new EventSource(url);" in api  # the fallback of a browser that cannot stream a response body
    assert "openEventStream, analyzeQuery" in api
    assert "const es = api.openEventStream(streamUrl);" in run and "new EventSource(" not in run
    # The surface the run uses: listeners by type, onerror, close(), readyState; a failing listener does not end the stream.
    for member in ("addEventListener(type, listener) {", "close() {", "emit(type, data) {", "dispatch(block) {", "async read() {"):
        assert member in api, member
    assert "reportError(error)" in api
    # The stream is cut at the blank line; the search of the next one starts where the last one ended.
    assert 'buffer.indexOf("\\n\\n", from)' in api and "from = Math.max(0, buffer.length - 1);" in api
    # The end of the stream is an "error" without data (as EventSource), which the run ignores after "done".
    assert 'this.emit("error", undefined);' in api


def test_the_elapsed_tile_says_what_it_measures_and_does_not_hold_the_run():
    run = read("src/static/app_run.js")
    html = read("src/static/query.html")
    assert "function elapsedTitle(totals, clientMs) {" in run
    assert "Elapsed: the time ChDash needed from the start of the stream to the last row it sent." in run
    assert "ClickHouse and column decoding" in run and "JSON encoding" in run and "The browser had every row" in run
    assert 'finishRail(railTotals(out?.done, out?.agg), performance.now() - runStartedPerf);' in run
    assert "function timingMs(done, part) {" in run and "backpressureMs: timingMs(done, \"backpressure\")" in run
    # The System figure (the query log, after a flush that can take seconds) never holds the run; a late
    # answer of an earlier run is dropped.
    assert "if (out && out.queryId && state.runOptExecutionStats) void refreshClickHouseElapsed(hostId, out.queryId);" in run
    assert "await refreshClickHouseElapsed(" not in run
    assert "let elapsedLookupSeq = 0;" in run and run.count("if (seq !== elapsedLookupSeq) return;") == 2
    assert "elapsedLookupSeq += 1;" in run
    assert 'id="clickhouseElapsedWrap" class="metricCompact__systemLine" hidden title="System: the query_duration_ms of ClickHouse (system.query_log)' in html
    assert "It includes the time ClickHouse waited for ChDash to read the blocks." in html


def test_the_system_queries_page_says_what_a_duration_is():
    page = read("src/static/app_system_queries.js")
    assert 'title: "Sum of the durations (query_duration_ms of ClickHouse)"' in page
    assert "A duration is the query_duration_ms of ClickHouse: it ends when ClickHouse has sent its last block, and it includes the time ClickHouse waits for a slow client." in page
    doc = read("docs/system.md")
    assert "A duration is the `query_duration_ms` of ClickHouse." in doc and "\"What the times measure\" in `docs/telemetry.md`" in doc
    assert "## What the times measure" in read("docs/telemetry.md")
