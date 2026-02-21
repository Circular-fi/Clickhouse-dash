#include "json_encode.hpp"

#include <clickhouse/columns/array.h>
#include <clickhouse/columns/column.h>
#include <clickhouse/columns/decimal.h>
#include <clickhouse/columns/map.h>
#include <clickhouse/columns/nullable.h>
#include <clickhouse/columns/string.h>
#include <clickhouse/columns/tuple.h>
#include <clickhouse/columns/uuid.h>

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <sstream>

using W = rapidjson::Writer<rapidjson::StringBuffer>;

static void write_column_value(W& w, const clickhouse::ColumnRef& col, size_t row);

static void write_nullable(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto n = std::dynamic_pointer_cast<clickhouse::ColumnNullable>(col);
  if (!n) { w.Null(); return; }
  if (n->IsNull(row)) { w.Null(); return; }
  write_column_value(w, n->Nested(), row);
}

static void write_array(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto a = std::dynamic_pointer_cast<clickhouse::ColumnArray>(col);
  if (!a) { w.Null(); return; }
  w.StartArray();
  const auto& offsets = a->Offsets();
  size_t start = (row == 0) ? 0 : offsets[row-1];
  size_t end = offsets[row];
  auto nested = a->Nested();
  for (size_t i = start; i < end; i++) {
    write_column_value(w, nested, i);
  }
  w.EndArray();
}

static void write_tuple(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto t = std::dynamic_pointer_cast<clickhouse::ColumnTuple>(col);
  if (!t) { w.Null(); return; }
  w.StartArray();
  for (size_t i = 0; i < t->TupleSize(); i++) {
    write_column_value(w, t->GetColumn(i), row);
  }
  w.EndArray();
}

static void write_map(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto m = std::dynamic_pointer_cast<clickhouse::ColumnMap>(col);
  if (!m) { w.Null(); return; }

  // Map in clickhouse-cpp is represented as Array(Tuple(key,value))
  // We'll output as JSON object with stringified keys.
  w.StartObject();
  auto arr = m->AsArray();
  auto arr_col = std::dynamic_pointer_cast<clickhouse::ColumnArray>(arr);
  if (!arr_col) { w.EndObject(); return; }

  const auto& offsets = arr_col->Offsets();
  size_t start = (row == 0) ? 0 : offsets[row-1];
  size_t end = offsets[row];
  auto nested = arr_col->Nested();
  auto tup = std::dynamic_pointer_cast<clickhouse::ColumnTuple>(nested);
  if (!tup) { w.EndObject(); return; }

  auto keyCol = tup->GetColumn(0);
  auto valCol = tup->GetColumn(1);

  for (size_t i = start; i < end; i++) {
    // keys can be non-string; stringify
    std::ostringstream ks;
    // write key into stringbuffer by temporarily writing into rapidjson?
    // simplest: handle common key types
    if (auto sk = std::dynamic_pointer_cast<clickhouse::ColumnString>(keyCol)) {
      ks << sk->At(i);
    } else if (auto ku64 = std::dynamic_pointer_cast<clickhouse::ColumnUInt64>(keyCol)) {
      ks << ku64->At(i);
    } else if (auto ki64 = std::dynamic_pointer_cast<clickhouse::ColumnInt64>(keyCol)) {
      ks << ki64->At(i);
    } else {
      ks << "key";
    }
    auto kstr = ks.str();
    w.Key(kstr.c_str());
    write_column_value(w, valCol, i);
  }

  w.EndObject();
}

template <typename ColT>
static void write_numbers(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto c = std::dynamic_pointer_cast<ColT>(col);
  if (!c) { w.Null(); return; }
  // rapidjson supports up to uint64/int64 directly.
  // For >64-bit and decimals we output as RawValue number tokens.
  if constexpr (std::is_same_v<ColT, clickhouse::ColumnUInt64>) {
    w.Uint64(c->At(row));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnInt64>) {
    w.Int64(c->At(row));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnUInt32>) {
    w.Uint(c->At(row));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnInt32>) {
    w.Int(c->At(row));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnUInt16>) {
    w.Uint(static_cast<unsigned>(c->At(row)));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnInt16>) {
    w.Int(static_cast<int>(c->At(row)));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnUInt8>) {
    w.Uint(static_cast<unsigned>(c->At(row)));
  } else if constexpr (std::is_same_v<ColT, clickhouse::ColumnInt8>) {
    w.Int(static_cast<int>(c->At(row)));
  }
}

static void write_string(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto s = std::dynamic_pointer_cast<clickhouse::ColumnString>(col);
  if (!s) { w.Null(); return; }
  auto v = s->At(row);
  w.String(v.c_str());
}

static void write_uuid(W& w, const clickhouse::ColumnRef& col, size_t row) {
  auto u = std::dynamic_pointer_cast<clickhouse::ColumnUUID>(col);
  if (!u) { w.Null(); return; }
  w.String(u->At(row).ToString().c_str());
}

static void write_decimal(W& w, const clickhouse::ColumnRef& col, size_t row) {
  // Use string representation as RawValue number token (no quotes)
  auto d32 = std::dynamic_pointer_cast<clickhouse::ColumnDecimal32>(col);
  auto d64 = std::dynamic_pointer_cast<clickhouse::ColumnDecimal64>(col);
  auto d128 = std::dynamic_pointer_cast<clickhouse::ColumnDecimal128>(col);

  std::string s;
  if (d32) s = d32->AsString(row);
  else if (d64) s = d64->AsString(row);
  else if (d128) s = d128->AsString(row);
  else { w.Null(); return; }

  w.RawValue(s.c_str(), s.size(), rapidjson::kNumberType);
}

static void write_column_value(W& w, const clickhouse::ColumnRef& col, size_t row) {
  if (!col) { w.Null(); return; }

  // Nullable first
  if (col->Type()->GetCode() == clickhouse::Type::Code::Nullable) {
    return write_nullable(w, col, row);
  }

  // Arrays
  if (col->Type()->GetCode() == clickhouse::Type::Code::Array) {
    return write_array(w, col, row);
  }

  // Tuple
  if (col->Type()->GetCode() == clickhouse::Type::Code::Tuple) {
    return write_tuple(w, col, row);
  }

  // Map
  if (col->Type()->GetCode() == clickhouse::Type::Code::Map) {
    return write_map(w, col, row);
  }

  // Strings
  if (col->Type()->GetCode() == clickhouse::Type::Code::String ||
      col->Type()->GetCode() == clickhouse::Type::Code::FixedString ||
      col->Type()->GetCode() == clickhouse::Type::Code::LowCardinality) {
    // LowCardinality(String) in clickhouse-cpp materializes as ColumnString values
    return write_string(w, col, row);
  }

  // UUID
  if (col->Type()->GetCode() == clickhouse::Type::Code::UUID) {
    return write_uuid(w, col, row);
  }

  // Numbers common
  if (col->Type()->GetCode() == clickhouse::Type::Code::UInt64) return write_numbers<clickhouse::ColumnUInt64>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::Int64)  return write_numbers<clickhouse::ColumnInt64>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::UInt32) return write_numbers<clickhouse::ColumnUInt32>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::Int32)  return write_numbers<clickhouse::ColumnInt32>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::UInt16) return write_numbers<clickhouse::ColumnUInt16>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::Int16)  return write_numbers<clickhouse::ColumnInt16>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::UInt8)  return write_numbers<clickhouse::ColumnUInt8>(w, col, row);
  if (col->Type()->GetCode() == clickhouse::Type::Code::Int8)   return write_numbers<clickhouse::ColumnInt8>(w, col, row);

  // Decimals
  if (col->Type()->GetCode() == clickhouse::Type::Code::Decimal32 ||
      col->Type()->GetCode() == clickhouse::Type::Code::Decimal64 ||
      col->Type()->GetCode() == clickhouse::Type::Code::Decimal128) {
    return write_decimal(w, col, row);
  }

  // Fallback: stringify using debug output if any (as JSON string)
  // (Avoid crashing on exotic types)
  std::ostringstream os;
  os << "<" << col->Type()->GetName() << ">";
  w.String(os.str().c_str());
}

std::string block_to_result_rows_json(const clickhouse::Block& block,
                                     std::atomic<uint64_t>& rows_out,
                                     std::atomic<uint64_t>& bytes_out) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("rows");
  w.StartArray();

  const size_t rows = block.GetRowCount();
  const size_t cols = block.GetColumnCount();

  // estimate bytes a bit (rough)
  bytes_out.fetch_add(rows * cols * 8, std::memory_order_relaxed);

  for (size_t r = 0; r < rows; r++) {
    w.StartArray();
    for (size_t c = 0; c < cols; c++) {
      write_column_value(w, block[c], r);
    }
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();

  rows_out.fetch_add(rows, std::memory_order_relaxed);
  return sb.GetString();
}
