#pragma once
#include <clickhouse/block.h>
#include <atomic>
#include <cstdint>
#include <string>

// Converts a ClickHouse block into JSON payload:
// {"rows": [[...],[...],...]}
std::string block_to_result_rows_json(const clickhouse::Block& block,
                                     std::atomic<uint64_t>& rows_out,
                                     std::atomic<uint64_t>& bytes_out);
