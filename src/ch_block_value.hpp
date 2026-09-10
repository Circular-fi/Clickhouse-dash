#pragma once

#include <clickhouse/client.h>
#include <clickhouse/columns/string.h>
#include <clickhouse/types/types.h>

#include <cstddef>
#include <stdexcept>
#include <string>
#include <string_view>

namespace chdash {

inline std::string ch_block_text_at(
    const clickhouse::Block& block,
    size_t column,
    size_t row) {
  if (column >= block.GetColumnCount() || row >= block.GetRowCount()) {
    throw std::out_of_range("ClickHouse metadata cell is outside the returned block.");
  }
  const auto& values = block[column];
  if (!values) {
    throw std::runtime_error("ClickHouse metadata column is null.");
  }

  if (auto strings = values->As<clickhouse::ColumnString>()) {
    const std::string_view value = strings->At(row);
    return std::string(value.data(), value.size());
  }

  // clickhouse-cpp exposes LowCardinality(String), Nullable(String) and
  // FixedString values through ItemView. This is intentionally strict: all
  // callers select textual metadata (usually via toString()), so receiving a
  // non-textual item means the metadata contract changed and must be surfaced
  // as an error rather than silently converted to an empty string.
  // In particular, clickhouse::Type::LowCardinality is not a ColumnString.
  const auto item = values->GetItem(row);
  if (item.type == clickhouse::Type::Void) return {};
  if (item.type == clickhouse::Type::String || item.type == clickhouse::Type::FixedString) {
    const auto value = item.get<std::string_view>();
    return std::string(value.data(), value.size());
  }
  throw std::runtime_error("ClickHouse metadata query returned a non-textual column.");
}

} // namespace chdash
