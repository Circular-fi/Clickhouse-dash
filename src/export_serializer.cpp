#include "export_serializer.hpp"

#include "json_clickhouse.hpp"
#include "zip_stream.hpp"

#include <clickhouse/columns/lowcardinality.h>
#include <clickhouse/columns/nullable.h>
#include <clickhouse/types/types.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <ctime>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string_view>

namespace chdash {
namespace {

std::string scalar_text(const clickhouse::ItemView& item, const clickhouse::Type& type) {
  using clickhouse::Type;
  switch (item.type) {
    case Type::Void: return "\\N";
    case Type::String:
    case Type::FixedString: {
      const auto value = item.get<std::string_view>();
      return std::string(value.data(), value.size());
    }
    case Type::Int8: return std::to_string(item.get<int8_t>());
    case Type::Int16: return std::to_string(item.get<int16_t>());
    case Type::Int32: return std::to_string(item.get<int32_t>());
    case Type::Int64: return std::to_string(item.get<int64_t>());
    case Type::UInt8: return std::to_string(item.get<uint8_t>());
    case Type::UInt16: return std::to_string(item.get<uint16_t>());
    case Type::UInt32: return std::to_string(item.get<uint32_t>());
    case Type::UInt64: return std::to_string(item.get<uint64_t>());
    case Type::Float32:
    case Type::Float64: {
      const double value = item.type == Type::Float32
          ? static_cast<double>(item.get<float>())
          : item.get<double>();
      if (std::isnan(value)) return "nan";
      if (std::isinf(value)) return value < 0 ? "-inf" : "inf";
      // Shortest round-trip representation (0.1 stays "0.1"), without the
      // locale and allocation overhead of an ostringstream per cell.
      char buf[32];
      const auto res = std::to_chars(buf, buf + sizeof(buf), value);
      return std::string(buf, res.ptr);
    }
    case Type::DateTime: return detail::datetime_to_iso(item.get<uint32_t>());
    case Type::DateTime64: {
      const auto* dt64 = type.As<clickhouse::DateTime64Type>();
      return detail::datetime64_to_iso(item.get<int64_t>(), dt64 ? dt64->GetPrecision() : 0);
    }
    case Type::Date: return detail::date_days_to_iso(item.get<uint16_t>());
    case Type::Date32: return detail::date_days_to_iso(item.get<int32_t>());
    case Type::UUID: return detail::uuid_to_string(item.AsBinaryData());
    case Type::IPv4: return detail::ipv4_to_string(item.get<uint32_t>());
    case Type::IPv6: return detail::ipv6_to_string(item.AsBinaryData());
    case Type::Int128: return detail::i128_to_string(item.get<clickhouse::Int128>());
    case Type::UInt128: return detail::u128_to_string(item.get<clickhouse::UInt128>());
    case Type::Decimal:
    case Type::Decimal32:
    case Type::Decimal64:
    case Type::Decimal128: {
      // Decimal32/64 are stored in 4/8 bytes: reading them as Int128 threw
      // and aborted every CSV export containing e.g. a Decimal(18,6) column.
      const auto* decimal = type.As<clickhouse::DecimalType>();
      return detail::decimal_to_string(
          detail::decimal_raw_value(item, decimal ? decimal->GetPrecision() : 38),
          decimal ? decimal->GetScale() : 0);
    }
    default:
      break;
  }

  // Structural/less common types are represented as compact JSON in a CSV
  // cell. This stays lossless and avoids inventing an ad-hoc delimiter grammar.
  return {};
}

bool simple_scalar_type(clickhouse::Type::Code code) {
  using clickhouse::Type;
  switch (code) {
    case Type::Void:
    case Type::String:
    case Type::FixedString:
    case Type::Int8:
    case Type::Int16:
    case Type::Int32:
    case Type::Int64:
    case Type::UInt8:
    case Type::UInt16:
    case Type::UInt32:
    case Type::UInt64:
    case Type::Float32:
    case Type::Float64:
    case Type::DateTime:
    case Type::DateTime64:
    case Type::Date:
    case Type::Date32:
    case Type::UUID:
    case Type::IPv4:
    case Type::IPv6:
    case Type::Int128:
    case Type::UInt128:
    case Type::Decimal:
    case Type::Decimal32:
    case Type::Decimal64:
    case Type::Decimal128:
      return true;
    default:
      return false;
  }
}

std::string cell_json(const clickhouse::ColumnRef& column, size_t row) {
  rapidjson::StringBuffer buffer;
  rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
  write_cell_json(writer, column, row);
  return std::string(buffer.GetString(), buffer.GetSize());
}

} // namespace

ExportSerializer::ExportSerializer(
    Zip64StreamWriter& zip,
    ExportFormat format,
    size_t buffer_bytes)
    : zip_(zip),
      format_(format),
      buffer_limit_(std::max<size_t>(16 * 1024, buffer_bytes)) {
  buffer_.reserve(std::min<size_t>(buffer_limit_, 1024 * 1024));
}

ExportSerializer::~ExportSerializer() = default;

void ExportSerializer::fail(std::string message) {
  ok_ = false;
  if (error_.empty()) error_ = std::move(message);
}

bool ExportSerializer::flush() {
  if (!ok_) return false;
  if (buffer_.empty()) return true;
  if (!zip_.write_data(buffer_)) {
    fail(zip_.error().empty() ? "ZIP stream write failed" : zip_.error());
    return false;
  }
  buffer_.clear();
  return true;
}

bool ExportSerializer::append(std::string_view value) {
  if (!ok_) return false;
  if (value.empty()) return true;
  if (value.size() >= buffer_limit_) {
    if (!flush()) return false;
    if (!zip_.write_data(value.data(), value.size())) {
      fail(zip_.error().empty() ? "ZIP stream write failed" : zip_.error());
      return false;
    }
    return true;
  }
  if (buffer_.size() + value.size() > buffer_limit_ && !flush()) return false;
  buffer_.append(value.data(), value.size());
  return true;
}

bool ExportSerializer::append_char(char value) {
  if (!ok_) return false;
  if (buffer_.size() + 1 > buffer_limit_ && !flush()) return false;
  buffer_.push_back(value);
  return true;
}

bool ExportSerializer::write_csv_field(std::string_view value) {
  if (!append_char('"')) return false;
  size_t begin = 0;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] != '"') continue;
    if (i > begin && !append(value.substr(begin, i - begin))) return false;
    if (!append("\"\"")) return false;
    begin = i + 1;
  }
  if (begin < value.size() && !append(value.substr(begin))) return false;
  return append_char('"');
}

bool ExportSerializer::write_csv_header(const clickhouse::Block& block) {
  for (size_t column = 0; column < block.GetColumnCount(); ++column) {
    if (column && !append_char(',')) return false;
    if (!write_csv_field(block.GetColumnName(column))) return false;
  }
  return append("\n");
}

bool ExportSerializer::write_csv_cell(const clickhouse::ColumnRef& column, size_t row) {
  using clickhouse::Type;
  const auto code = column->GetType().GetCode();
  if (code == Type::Nullable) {
    const auto nullable = column->As<clickhouse::ColumnNullable>();
    if (nullable && nullable->IsNull(row)) return write_csv_field("\\N");
    if (nullable) return write_csv_cell(nullable->Nested(), row);
  }
  if (code == Type::LowCardinality) {
    const auto* low_type = column->Type()->As<clickhouse::LowCardinalityType>();
    const auto nested = low_type ? low_type->GetNestedType() : nullptr;
    if (nested && simple_scalar_type(nested->GetCode())) {
      const std::string text = scalar_text(column->GetItem(row), *nested);
      return write_csv_field(text);
    }
  }
  if (simple_scalar_type(code)) {
    const auto item = column->GetItem(row);
    if ((code == Type::String || code == Type::FixedString) && item.type != Type::Void) {
      const auto value = item.get<std::string_view>();
      return write_csv_field(value);
    }
    return write_csv_field(scalar_text(item, *column->Type()));
  }
  return write_csv_field(cell_json(column, row));
}

bool ExportSerializer::write_csv_row(size_t row) {
  for (size_t column = 0; column < columns_.size(); ++column) {
    if (column && !append_char(',')) return false;
    if (!write_csv_cell(columns_[column], row)) return false;
  }
  return append_char('\n');
}

bool ExportSerializer::write_json_row(size_t row) {
  // Same output as encode_row_object(), serialized into a reused buffer.
  json_row_.Clear();
  rapidjson::Writer<rapidjson::StringBuffer> w(json_row_);
  w.StartObject();
  for (size_t i = 0; i < columns_.size(); ++i) {
    const auto& name = column_names_[i];
    w.Key(name.c_str(), static_cast<rapidjson::SizeType>(name.size()));
    encoders_[i].write(w, row);
  }
  w.EndObject();
  return append(std::string_view(json_row_.GetString(), json_row_.GetSize())) && append_char('\n');
}

bool ExportSerializer::write_block(const clickhouse::Block& block) {
  if (!ok_) return false;
  if (!header_written_) {
    header_written_ = true;
    if (format_ == ExportFormat::Csv && block.GetColumnCount() > 0 && !write_csv_header(block)) {
      return false;
    }
  }
  columns_.clear();
  column_names_.clear();
  columns_.reserve(block.GetColumnCount());
  column_names_.reserve(block.GetColumnCount());
  encoders_.clear();
  for (size_t column = 0; column < block.GetColumnCount(); ++column) {
    columns_.push_back(block[column]);
    column_names_.push_back(block.GetColumnName(column));
    if (format_ != ExportFormat::Csv) encoders_.emplace_back(columns_.back());
  }
  for (size_t row = 0; row < block.GetRowCount(); ++row) {
    const bool written = format_ == ExportFormat::Csv
        ? write_csv_row(row)
        : write_json_row(row);
    if (!written) {
      encoders_.clear();
      columns_.clear();
      return false;
    }
    ++rows_written_;
  }
  // Release the block's column references; capacity is kept for the next one.
  encoders_.clear();
  columns_.clear();
  return true;
}

bool ExportSerializer::finish() {
  return flush();
}

} // namespace chdash
