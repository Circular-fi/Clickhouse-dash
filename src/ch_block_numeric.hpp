#pragma once

#include <clickhouse/block.h>
#include <clickhouse/columns/bool.h>
#include <clickhouse/columns/numeric.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

namespace chdash {

inline void validate_numeric_block_cell(
    const clickhouse::Block& block,
    size_t column,
    size_t row) {
  if (column >= block.GetColumnCount() || row >= block.GetRowCount()) {
    throw std::out_of_range(
        "ClickHouse numeric block cell is out of range (column=" +
        std::to_string(column) + ", row=" + std::to_string(row) + ").");
  }
  if (!block[column]) {
    throw std::runtime_error(
        "ClickHouse numeric block column is null at index " +
        std::to_string(column) + ".");
  }
}

// A flag of a column that is UInt8, or Bool (clickhouse-cpp reads a Bool as ColumnBool): false with *ok false when the
// column is neither.
inline bool ch_column_flag_at(const clickhouse::ColumnRef& column, size_t row, bool* ok = nullptr) {
  if (ok) *ok = true;
  if (auto values = column->As<clickhouse::ColumnUInt8>()) return values->At(row) != 0;
  if (auto values = column->As<clickhouse::ColumnBool>()) return values->At(row);
  if (ok) *ok = false;
  return false;
}

inline uint64_t ch_block_u64_at(
    const clickhouse::Block& block,
    size_t column,
    size_t row) {
  validate_numeric_block_cell(block, column, row);
  if (auto values = block[column]->As<clickhouse::ColumnUInt64>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnUInt32>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnUInt16>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnUInt8>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnBool>()) return values->At(row) ? 1 : 0;
  throw std::runtime_error(
      "Unexpected ClickHouse numeric column while decoding UInt64 at index " +
      std::to_string(column) + ".");
}

inline int64_t ch_block_i64_at(
    const clickhouse::Block& block,
    size_t column,
    size_t row) {
  validate_numeric_block_cell(block, column, row);
  if (auto values = block[column]->As<clickhouse::ColumnInt64>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnInt32>()) return values->At(row);

  const uint64_t unsigned_value = ch_block_u64_at(block, column, row);
  if (unsigned_value > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    throw std::runtime_error(
        "ClickHouse UInt64 value does not fit Int64 at column " +
        std::to_string(column) + ".");
  }
  return static_cast<int64_t>(unsigned_value);
}

inline int32_t ch_block_i32_at(
    const clickhouse::Block& block,
    size_t column,
    size_t row) {
  validate_numeric_block_cell(block, column, row);
  if (auto values = block[column]->As<clickhouse::ColumnInt32>()) return values->At(row);
  if (auto values = block[column]->As<clickhouse::ColumnInt64>()) {
    const int64_t value = values->At(row);
    if (value < std::numeric_limits<int32_t>::min() ||
        value > std::numeric_limits<int32_t>::max()) {
      throw std::runtime_error(
          "ClickHouse Int64 value does not fit Int32 at column " +
          std::to_string(column) + ".");
    }
    return static_cast<int32_t>(value);
  }

  const uint64_t unsigned_value = ch_block_u64_at(block, column, row);
  if (unsigned_value > static_cast<uint64_t>(std::numeric_limits<int32_t>::max())) {
    throw std::runtime_error(
        "ClickHouse unsigned value does not fit Int32 at column " +
        std::to_string(column) + ".");
  }
  return static_cast<int32_t>(unsigned_value);
}

} // namespace chdash
