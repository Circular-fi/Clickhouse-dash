#pragma once

// JSON encoder for clickhouse-cpp blocks.
//
// Goals:
// - No dependency on ClickHouse SQL formats (no toJSONEachRow).
// - Encode values directly from native columns (clickhouse-cpp in-memory types).
// - Support deeply nested types: Array / Tuple / Map / Nullable / LowCardinality.
// - Keep output compact and stream-friendly (NDJSON / per-row JSON).
//
// Notes about numbers:
// - UInt64/Int64 and below are encoded as JSON numbers.
// - Int128/UInt128 and Decimal are emitted as *raw JSON numbers* (no quotes) to allow
//   a lossless number parser on the frontend. If the consumer uses JavaScript JSON.parse,
//   precision will be lost for large values.

#include <clickhouse/block.h>
#include <clickhouse/columns/array.h>
#include <clickhouse/columns/column.h>
#include <clickhouse/columns/lowcardinality.h>
#include <clickhouse/columns/map.h>
#include <clickhouse/columns/nullable.h>
#include <clickhouse/columns/tuple.h>
#include <clickhouse/types/types.h>

#include <algorithm>
#include <arpa/inet.h>
#include <cmath>
#include <cstdint>
#include <ctime>
#include <cstring>
#include <string>
#include <string_view>

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

namespace chdash {

namespace detail {

inline bool is_valid_utf8(std::string_view s) {
  size_t i = 0;
  while (i < s.size()) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c <= 0x7F) {
      ++i;
      continue;
    }
    if ((c >> 5) == 0x6) {
      if (i + 1 >= s.size()) return false;
      unsigned char c1 = static_cast<unsigned char>(s[i + 1]);
      if ((c1 & 0xC0) != 0x80 || c < 0xC2) return false;
      i += 2;
      continue;
    }
    if ((c >> 4) == 0xE) {
      if (i + 2 >= s.size()) return false;
      unsigned char c1 = static_cast<unsigned char>(s[i + 1]);
      unsigned char c2 = static_cast<unsigned char>(s[i + 2]);
      if ((c1 & 0xC0) != 0x80 || (c2 & 0xC0) != 0x80) return false;
      if (c == 0xE0 && c1 < 0xA0) return false;
      if (c == 0xED && c1 >= 0xA0) return false;
      i += 3;
      continue;
    }
    if ((c >> 3) == 0x1E) {
      if (i + 3 >= s.size()) return false;
      unsigned char c1 = static_cast<unsigned char>(s[i + 1]);
      unsigned char c2 = static_cast<unsigned char>(s[i + 2]);
      unsigned char c3 = static_cast<unsigned char>(s[i + 3]);
      if ((c1 & 0xC0) != 0x80 || (c2 & 0xC0) != 0x80 || (c3 & 0xC0) != 0x80) return false;
      if (c == 0xF0 && c1 < 0x90) return false;
      if (c > 0xF4) return false;
      if (c == 0xF4 && c1 >= 0x90) return false;
      i += 4;
      continue;
    }
    return false;
  }
  return true;
}

inline bool starts_with_ci(std::string_view s, std::string_view pfx) {
  if (s.size() < pfx.size()) return false;
  for (size_t i = 0; i < pfx.size(); ++i) {
    char a = s[i];
    char b = pfx[i];
    if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
    if (b >= 'A' && b <= 'Z') b = static_cast<char>(b - 'A' + 'a');
    if (a != b) return false;
  }
  return true;
}

inline std::string bytes_to_hex(std::string_view s) {
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.resize(s.size() * 2);
  for (size_t i = 0; i < s.size(); ++i) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    out[i * 2] = hex[(c >> 4) & 0x0F];
    out[i * 2 + 1] = hex[c & 0x0F];
  }
  return out;
}

inline bool column_is_stringish(const clickhouse::ColumnRef& col) {
  const auto code = col->Type()->GetCode();
  return code == clickhouse::Type::String || code == clickhouse::Type::FixedString;
}

inline void writer_string(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view s) {
  w.String(s.data(), static_cast<rapidjson::SizeType>(s.size()));
}

inline void writer_finite_double(rapidjson::Writer<rapidjson::StringBuffer>& writer, double value) {
  // JSON cannot represent NaN or infinity. Encode non-finite native
  // floating-point values as null so every SSE data field remains valid JSON.
  if (std::isfinite(value)) writer.Double(value);
  else writer.Null();
}

inline std::string u128_to_string(clickhouse::UInt128 v) {
  if (v == 0) return "0";
  std::string out;
  while (v != 0) {
    auto digit = static_cast<unsigned>(v % 10);
    out.push_back(static_cast<char>('0' + digit));
    v /= 10;
  }
  std::reverse(out.begin(), out.end());
  return out;
}

inline clickhouse::UInt128 i128_magnitude(clickhouse::Int128 value) {
  if (value >= 0) return static_cast<clickhouse::UInt128>(value);
  // Avoid signed overflow for the minimum Int128 value.
  return static_cast<clickhouse::UInt128>(-(value + 1)) + 1;
}

inline std::string i128_to_string(clickhouse::Int128 v) {
  if (v == 0) return "0";
  const bool neg = v < 0;
  std::string s = u128_to_string(i128_magnitude(v));
  if (neg) s.insert(s.begin(), '-');
  return s;
}

inline std::string decimal_to_string(clickhouse::Int128 raw, size_t scale) {
  // raw is an integer scaled by 10^scale.
  const bool neg = raw < 0;
  clickhouse::UInt128 u = i128_magnitude(raw);
  std::string digits = u128_to_string(u);

  if (scale == 0) {
    if (neg) digits.insert(digits.begin(), '-');
    return digits;
  }

  if (digits.size() <= scale) {
    digits.insert(digits.begin(), static_cast<size_t>(scale + 1 - digits.size()), '0');
  }
  const size_t point_pos = digits.size() - scale;
  digits.insert(digits.begin() + static_cast<long>(point_pos), '.');
  if (neg) digits.insert(digits.begin(), '-');
  return digits;
}

inline std::string uuid_to_string(std::string_view bytes16) {
  const unsigned char* b = reinterpret_cast<const unsigned char*>(bytes16.data());
  static const char* hex = "0123456789abcdef";
  char out[36];
  int p = 0;
  auto hex2 = [&](unsigned char v) {
    out[p++] = hex[(v >> 4) & 0xF];
    out[p++] = hex[v & 0xF];
  };
  for (int i = 0; i < 16; i++) {
    hex2(b[i]);
    if (i == 3 || i == 5 || i == 7 || i == 9) out[p++] = '-';
  }
  return std::string(out, out + 36);
}

inline std::string ipv4_to_string(uint32_t v) {
  struct in_addr a;
  a.s_addr = v;
  char buf[INET_ADDRSTRLEN];
  const char* r = inet_ntop(AF_INET, &a, buf, sizeof(buf));
  return r ? std::string(r) : std::string();
}

inline std::string ipv6_to_string(std::string_view bytes16) {
  struct in6_addr a;
  std::memset(&a, 0, sizeof(a));
  std::memcpy(&a, bytes16.data(), std::min<size_t>(16, bytes16.size()));
  char buf[INET6_ADDRSTRLEN];
  const char* r = inet_ntop(AF_INET6, &a, buf, sizeof(buf));
  return r ? std::string(r) : std::string();
}

inline std::string datetime_to_iso(uint32_t seconds) {
  std::time_t t = static_cast<std::time_t>(seconds);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return std::string(buf);
}

inline std::string datetime64_to_iso(int64_t scaled, size_t precision) {
  int64_t pow10 = 1;
  for (size_t i = 0; i < precision; i++) pow10 *= 10;
  int64_t sec = scaled / pow10;
  int64_t frac = scaled % pow10;
  if (frac < 0) frac = -frac;

  std::time_t t = static_cast<std::time_t>(sec);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char base[32];
  std::strftime(base, sizeof(base), "%Y-%m-%dT%H:%M:%S", &tm);

  std::string out(base);
  if (precision > 0) {
    out.push_back('.');
    std::string f = std::to_string(frac);
    if (f.size() < precision) f.insert(f.begin(), precision - f.size(), '0');
    out += f;
  }
  out += 'Z';
  return out;
}

inline void write_item(rapidjson::Writer<rapidjson::StringBuffer>& w, const clickhouse::ItemView& it, const clickhouse::Type& ty) {
  using clickhouse::Type;
  switch (it.type) {
    case Type::Void:
      w.Null();
      return;
    case Type::String:
    case Type::FixedString:
      writer_string(w, it.get<std::string_view>());
      return;

    case Type::Int8: w.Int(it.get<int8_t>()); return;
    case Type::Int16: w.Int(it.get<int16_t>()); return;
    case Type::Int32: w.Int(it.get<int32_t>()); return;
    case Type::Int64: w.Int64(it.get<int64_t>()); return;
    case Type::UInt8: w.Uint(it.get<uint8_t>()); return;
    case Type::UInt16: w.Uint(it.get<uint16_t>()); return;
    case Type::UInt32: w.Uint(it.get<uint32_t>()); return;
    case Type::UInt64: w.Uint64(it.get<uint64_t>()); return;

    case Type::Float32: writer_finite_double(w, static_cast<double>(it.get<float>())); return;
    case Type::Float64: writer_finite_double(w, it.get<double>()); return;

    case Type::DateTime:
      writer_string(w, datetime_to_iso(it.get<uint32_t>()));
      return;

    case Type::DateTime64: {
      const auto* dt64 = ty.As<clickhouse::DateTime64Type>();
      const size_t p = dt64 ? dt64->GetPrecision() : 0;
      writer_string(w, datetime64_to_iso(it.get<int64_t>(), p));
      return;
    }

    case Type::Date: {
      uint16_t days = it.get<uint16_t>();
      std::time_t t = static_cast<std::time_t>(days) * 86400;
      std::tm tm{};
      gmtime_r(&t, &tm);
      char buf[16];
      std::strftime(buf, sizeof(buf), "%Y-%m-%d", &tm);
      writer_string(w, std::string_view(buf));
      return;
    }

    case Type::UUID:
      writer_string(w, uuid_to_string(it.AsBinaryData()));
      return;

    case Type::IPv4:
      writer_string(w, ipv4_to_string(it.get<uint32_t>()));
      return;

    case Type::IPv6:
      writer_string(w, ipv6_to_string(it.AsBinaryData()));
      return;

    case Type::Int128: {
      const auto s = i128_to_string(it.get<clickhouse::Int128>());
      w.RawValue(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), rapidjson::kNumberType);
      return;
    }

    case Type::UInt128: {
      const auto s = u128_to_string(it.get<clickhouse::UInt128>());
      w.RawValue(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), rapidjson::kNumberType);
      return;
    }

    case Type::Decimal:
    case Type::Decimal32:
    case Type::Decimal64:
    case Type::Decimal128: {
      const auto* d = ty.As<clickhouse::DecimalType>();
      const size_t scale = d ? d->GetScale() : 0;
      const auto s = decimal_to_string(it.get<clickhouse::Int128>(), scale);
      w.RawValue(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), rapidjson::kNumberType);
      return;
    }

    default:
      // Unknown / rare type: encode as string of raw bytes.
      writer_string(w, it.AsBinaryData());
      return;
  }
}

inline void write_column_value(rapidjson::Writer<rapidjson::StringBuffer>& w,
                               const clickhouse::ColumnRef& col,
                               size_t row);

inline void write_array(rapidjson::Writer<rapidjson::StringBuffer>& w,
                        const clickhouse::ColumnRef& col,
                        size_t row) {
  auto a = col->As<clickhouse::ColumnArray>();
  if (!a) {
    w.Null();
    return;
  }
  auto nested = a->GetAsColumn(row);
  w.StartArray();
  for (size_t i = 0; i < nested->Size(); i++) {
    write_column_value(w, nested, i);
  }
  w.EndArray();
}

inline void write_tuple(rapidjson::Writer<rapidjson::StringBuffer>& w,
                        const clickhouse::ColumnRef& col,
                        size_t row) {
  auto t = col->As<clickhouse::ColumnTuple>();
  if (!t) {
    w.Null();
    return;
  }
  w.StartArray();
  for (size_t i = 0; i < t->TupleSize(); i++) {
    write_column_value(w, t->At(i), row);
  }
  w.EndArray();
}

inline void write_map(rapidjson::Writer<rapidjson::StringBuffer>& w,
                      const clickhouse::ColumnRef& col,
                      size_t row) {
  auto m = col->As<clickhouse::ColumnMap>();
  if (!m) {
    w.Null();
    return;
  }

  auto items = m->GetAsColumn(row);
  auto tuple_items = items->As<clickhouse::ColumnTuple>();
  if (!tuple_items || tuple_items->TupleSize() < 2) {
    w.StartObject();
    w.EndObject();
    return;
  }

  const auto* mt = col->Type()->As<clickhouse::MapType>();
  const bool key_is_string = mt && (mt->GetKeyType()->GetCode() == clickhouse::Type::String || mt->GetKeyType()->GetCode() == clickhouse::Type::FixedString);

  auto keys = tuple_items->At(0);
  auto vals = tuple_items->At(1);

  if (key_is_string) {
    w.StartObject();
    for (size_t i = 0; i < items->Size(); i++) {
      const auto key_item = keys->GetItem(i);
      std::string_view k = key_item.get<std::string_view>();
      w.Key(k.data(), static_cast<rapidjson::SizeType>(k.size()));
      write_column_value(w, vals, i);
    }
    w.EndObject();
  } else {
    w.StartArray();
    for (size_t i = 0; i < items->Size(); i++) {
      w.StartArray();
      write_column_value(w, keys, i);
      write_column_value(w, vals, i);
      w.EndArray();
    }
    w.EndArray();
  }
}

inline void write_column_value(rapidjson::Writer<rapidjson::StringBuffer>& w,
                               const clickhouse::ColumnRef& col,
                               size_t row) {
  using clickhouse::Type;
  const auto code = col->Type()->GetCode();

  // Nullable wrapper.
  if (code == Type::Nullable) {
    auto n = col->As<clickhouse::ColumnNullable>();
    if (n && n->IsNull(row)) {
      w.Null();
      return;
    }
    if (n) {
      write_column_value(w, n->Nested(), row);
      return;
    }
  }

  // LowCardinality wrapper.
  if (code == Type::LowCardinality) {
    const auto it = col->GetItem(row);
    // The nested type is stored in LowCardinalityType.
    const auto* lct = col->Type()->As<clickhouse::LowCardinalityType>();
    auto nested_ty = lct ? lct->GetNestedType() : clickhouse::Type::CreateString();
    if (nested_ty) {
      write_item(w, it, *nested_ty);
    } else {
      // Fallback (should not happen).
      write_item(w, it, *col->Type());
    }
    return;
  }

  // Nested structural types.
  switch (code) {
    case Type::Array:
      write_array(w, col, row);
      return;
    case Type::Tuple:
      write_tuple(w, col, row);
      return;
    case Type::Map:
      write_map(w, col, row);
      return;
    default:
      break;
  }

  // Scalars.
  const auto it = col->GetItem(row);
  write_item(w, it, *col->Type());
}

} // namespace detail

// Encode a single cell value (one column at one row) as JSON.
inline void write_cell_json(rapidjson::Writer<rapidjson::StringBuffer>& w, const clickhouse::ColumnRef& col, size_t row) {
  detail::write_column_value(w, col, row);
}

inline void write_cell_json_declared(rapidjson::Writer<rapidjson::StringBuffer>& w,
                                     const clickhouse::ColumnRef& col,
                                     size_t row,
                                     const std::string& declared_type) {
  if (detail::starts_with_ci(declared_type, "json") || detail::starts_with_ci(declared_type, "object('json')")) {
    if (detail::column_is_stringish(col)) {
      const auto sv = col->GetItem(row).get<std::string_view>();
      if (detail::is_valid_utf8(sv)) {
        rapidjson::Document d;
        d.Parse(sv.data(), sv.size());
        if (!d.HasParseError()) {
          d.Accept(w);
          return;
        }
      }
      detail::writer_string(w, sv);
      return;
    }
  }

  if (detail::starts_with_ci(declared_type, "aggregatefunction(")) {
    if (detail::column_is_stringish(col)) {
      const auto sv = col->GetItem(row).get<std::string_view>();
      if (detail::is_valid_utf8(sv) && sv.find('\0') == std::string_view::npos) {
        detail::writer_string(w, sv);
      } else {
        const auto hex = detail::bytes_to_hex(sv);
        detail::writer_string(w, hex);
      }
      return;
    }
  }

  write_cell_json(w, col, row);
}

// Encode one row of a block as a JSON object, with field names == ClickHouse column names.
inline std::string encode_row_object(const clickhouse::Block& block, size_t row) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  for (size_t i = 0; i < block.GetColumnCount(); i++) {
    const auto& name = block.GetColumnName(i);
    w.Key(name.c_str(), static_cast<rapidjson::SizeType>(name.size()));
    detail::write_column_value(w, block[i], row);
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace chdash
