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
#include <clickhouse/columns/string.h>
#include <clickhouse/columns/tuple.h>
#include <clickhouse/types/types.h>

#include <algorithm>
#include <arpa/inet.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

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

// Calendar formatting is done arithmetically (Howard Hinnant's
// civil_from_days, proleptic Gregorian, UTC). glibc gmtime_r takes the
// process-wide tz lock on every call, which serialized every DateTime cell of
// every concurrent query/export; strftime adds locale work on top. These
// helpers are lock-free, allocation-free and correct for pre-1970 values.
inline void civil_from_days(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) ++y;
}

inline char* put_digits(char* p, unsigned v, int width) {
  for (int i = width - 1; i >= 0; --i) {
    p[i] = static_cast<char>('0' + v % 10);
    v /= 10;
  }
  return p + width;
}

// Writes YYYY-MM-DD (years outside 0..9999 keep a sign/extra digits).
// `out` must hold at least 24 bytes. Returns the end pointer.
inline char* format_civil_date(char* out, int64_t days) {
  int64_t y = 0;
  unsigned m = 1, d = 1;
  civil_from_days(days, y, m, d);
  char* p = out;
  if (y >= 0 && y <= 9999) {
    p = put_digits(p, static_cast<unsigned>(y), 4);
  } else {
    p += std::snprintf(p, 16, "%lld", static_cast<long long>(y));
  }
  *p++ = '-';
  p = put_digits(p, m, 2);
  *p++ = '-';
  return put_digits(p, d, 2);
}

// Writes YYYY-MM-DDTHH:MM:SS. `out` must hold at least 40 bytes.
inline char* format_civil_datetime(char* out, int64_t seconds) {
  int64_t days = seconds / 86400;
  int64_t rem = seconds % 86400;
  if (rem < 0) {
    rem += 86400;
    --days;
  }
  char* p = format_civil_date(out, days);
  *p++ = 'T';
  p = put_digits(p, static_cast<unsigned>(rem / 3600), 2);
  *p++ = ':';
  p = put_digits(p, static_cast<unsigned>((rem / 60) % 60), 2);
  *p++ = ':';
  return put_digits(p, static_cast<unsigned>(rem % 60), 2);
}

inline size_t format_datetime_iso(char* out, uint32_t seconds) {
  char* p = format_civil_datetime(out, static_cast<int64_t>(seconds));
  *p++ = 'Z';
  return static_cast<size_t>(p - out);
}

// DateTime64 uses floor division so that negative (pre-epoch) values with a
// fractional part are formatted correctly: -0.5 s is 1969-12-31T23:59:59.5Z.
// `out` must hold at least 64 bytes.
inline size_t format_datetime64_iso(char* out, int64_t scaled, size_t precision) {
  if (precision > 18) precision = 18;
  int64_t pow10 = 1;
  for (size_t i = 0; i < precision; i++) pow10 *= 10;
  int64_t sec = scaled / pow10;
  int64_t frac = scaled % pow10;
  if (frac < 0) {
    frac += pow10;
    --sec;
  }
  char* p = format_civil_datetime(out, sec);
  if (precision > 0) {
    *p++ = '.';
    for (int i = static_cast<int>(precision) - 1; i >= 0; --i) {
      p[i] = static_cast<char>('0' + frac % 10);
      frac /= 10;
    }
    p += precision;
  }
  *p++ = 'Z';
  return static_cast<size_t>(p - out);
}

inline std::string datetime_to_iso(uint32_t seconds) {
  char buf[40];
  return std::string(buf, format_datetime_iso(buf, seconds));
}

inline std::string datetime64_to_iso(int64_t scaled, size_t precision) {
  char buf[64];
  return std::string(buf, format_datetime64_iso(buf, scaled, precision));
}

inline std::string date_days_to_iso(int64_t days) {
  char buf[24];
  return std::string(buf, format_civil_date(buf, days));
}

// clickhouse-cpp stores Decimal32/64 in their native 4/8-byte integer widths
// and ColumnDecimal::GetItem() reports the *logical* Decimal type code while
// carrying the bytes of its physical Int32/Int64/Int128 storage column.
// Reading every decimal as Int128 therefore triggers ItemView's strict size
// check ("Requested size: 16 stored size: 8" on Decimal(18,6)). Select the
// physical width from the precision, matching clickhouse-cpp's ColumnDecimal
// (<=9 -> Int32, <=18 -> Int64, else Int128), then widen.
inline clickhouse::Int128 decimal_raw_value(const clickhouse::ItemView& it, size_t precision) {
  using clickhouse::Type;
  if (it.type == Type::Decimal32 || (it.type == Type::Decimal && precision <= 9)) {
    return static_cast<clickhouse::Int128>(it.get<int32_t>());
  }
  if (it.type == Type::Decimal64 || (it.type == Type::Decimal && precision <= 18)) {
    return static_cast<clickhouse::Int128>(it.get<int64_t>());
  }
  return it.get<clickhouse::Int128>();
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

    case Type::Enum8: {
      const auto* e = ty.As<clickhouse::EnumType>();
      const auto value = it.get<int8_t>();
      if (e) writer_string(w, e->GetEnumName(value));
      else w.Int(value);
      return;
    }
    case Type::Enum16: {
      const auto* e = ty.As<clickhouse::EnumType>();
      const auto value = it.get<int16_t>();
      if (e) writer_string(w, e->GetEnumName(value));
      else w.Int(value);
      return;
    }

    case Type::Float32: writer_finite_double(w, static_cast<double>(it.get<float>())); return;
    case Type::Float64: writer_finite_double(w, it.get<double>()); return;

    case Type::DateTime: {
      char buf[40];
      writer_string(w, std::string_view(buf, format_datetime_iso(buf, it.get<uint32_t>())));
      return;
    }

    case Type::DateTime64: {
      const auto* dt64 = ty.As<clickhouse::DateTime64Type>();
      const size_t p = dt64 ? dt64->GetPrecision() : 0;
      char buf[64];
      writer_string(w, std::string_view(buf, format_datetime64_iso(buf, it.get<int64_t>(), p)));
      return;
    }

    case Type::Date: {
      char buf[24];
      writer_string(w, std::string_view(buf, static_cast<size_t>(format_civil_date(buf, it.get<uint16_t>()) - buf)));
      return;
    }

    case Type::Date32: {
      // Date32 is a signed day offset from 1970-01-01 (range 1900..2299).
      char buf[24];
      writer_string(w, std::string_view(buf, static_cast<size_t>(format_civil_date(buf, it.get<int32_t>()) - buf)));
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
      // clickhouse-cpp stores Decimal32/64 in their native 4/8-byte integer
      // widths. Reading every decimal as Int128 triggers ItemView's strict size
      // check (for example "Requested size: 16 stored size: 8" on
      // Decimal(18,6)). Widen only after reading the runtime-width value.
      const size_t precision = d ? d->GetPrecision() : 38;
      // ColumnDecimal::GetItem() intentionally reports the *logical* Decimal
      // type code; a Decimal(18,6) arrives as Type::Decimal with 8 stored
      // bytes. decimal_raw_value() selects the physical width.
      const clickhouse::Int128 raw = decimal_raw_value(it, precision);
      const auto s = decimal_to_string(raw, scale);
      w.RawValue(s.c_str(), static_cast<rapidjson::SizeType>(s.size()), rapidjson::kNumberType);
      return;
    }

    default:
      // Unknown / rare type: encode as string of raw bytes.
      writer_string(w, it.AsBinaryData());
      return;
  }
}

// ColumnMap keeps its Array(Tuple(K, V)) storage private and only offers
// GetAsColumn(row), which Slice()s the row out: three new columns and a copy of
// every key and value string for every single Map cell. A member pointer taken
// in an explicit instantiation (the one place the language exempts from access
// checks) reaches the storage so that a Map cell is read in place, like an
// Array cell. A change of the member in a newer clickhouse-cpp stops the build.
template <typename Tag, typename Tag::Type Member>
struct PrivateMemberAccess {
  friend typename Tag::Type private_member(Tag) { return Member; }
};

struct ColumnMapDataTag {
  using Type = std::shared_ptr<clickhouse::ColumnArray> clickhouse::ColumnMap::*;
  friend Type private_member(ColumnMapDataTag);
};

template struct PrivateMemberAccess<ColumnMapDataTag, &clickhouse::ColumnMap::data_>;

inline const clickhouse::ColumnArray* map_storage(const clickhouse::ColumnMap& map) {
  return (map.*private_member(ColumnMapDataTag{})).get();
}

// A cell encoder is built once for a column of a block, then writes any row of
// that column. Building resolves the nested structure (Nullable, LowCardinality,
// Array, Tuple, Map) to plain pointers, so a row costs no dynamic_cast, no
// shared_ptr copy and no allocation: the generic path paid all three for every
// cell of every nested column. It must not outlive the column it was built from.
class CellEncoder {
 public:
  explicit CellEncoder(const clickhouse::ColumnRef& column) { build(column.get()); }

  void write(rapidjson::Writer<rapidjson::StringBuffer>& w, size_t row) const {
    switch (kind_) {
      case Kind::Item:
        write_item(w, column_->GetItem(row), *type_);
        return;
      case Kind::Nullable:
        if (nullable_->IsNull(row)) {
          w.Null();
        } else {
          children_[0].write(w, row);
        }
        return;
      case Kind::LowCardinality:
        write_item(w, column_->GetItem(row), *type_);
        return;
      case Kind::Array: {
        if (row >= array_->Size()) {
          w.Null();
          return;
        }
        const size_t begin = array_->GetOffset(row);
        const size_t end = begin + array_->GetSize(row);
        w.StartArray();
        for (size_t i = begin; i < end; ++i) children_[0].write(w, i);
        w.EndArray();
        return;
      }
      case Kind::Tuple:
        w.StartArray();
        for (const CellEncoder& child : children_) child.write(w, row);
        w.EndArray();
        return;
      case Kind::Null:
        w.Null();
        return;
      case Kind::MapEmpty:
        w.StartObject();
        w.EndObject();
        return;
      case Kind::MapObject: {
        const size_t begin = array_->GetOffset(row);
        const size_t end = begin + array_->GetSize(row);
        w.StartObject();
        for (size_t i = begin; i < end; ++i) {
          const std::string_view key = map_key_strings_ ? map_key_strings_->At(i)
                                                        : children_[0].column_->GetItem(i).get<std::string_view>();
          w.Key(key.data(), static_cast<rapidjson::SizeType>(key.size()));
          children_[1].write(w, i);
        }
        w.EndObject();
        return;
      }
      case Kind::MapPairs: {
        const size_t begin = array_->GetOffset(row);
        const size_t end = begin + array_->GetSize(row);
        w.StartArray();
        for (size_t i = begin; i < end; ++i) {
          w.StartArray();
          children_[0].write(w, i);
          children_[1].write(w, i);
          w.EndArray();
        }
        w.EndArray();
        return;
      }
    }
  }

 private:
  enum class Kind : uint8_t { Item, Null, Nullable, LowCardinality, Array, Tuple, MapEmpty, MapObject, MapPairs };

  CellEncoder() = default;

  void build(const clickhouse::Column* column) {
    using clickhouse::Type;
    column_ = column;
    type_ = &column->GetType();
    switch (type_->GetCode()) {
      case Type::Nullable:
        if (const auto* nullable = dynamic_cast<const clickhouse::ColumnNullable*>(column)) {
          kind_ = Kind::Nullable;
          nullable_ = nullable;
          add_child(nullable->Nested().get());
          return;
        }
        break;
      case Type::LowCardinality: {
        kind_ = Kind::LowCardinality;
        const auto* lct = type_->As<clickhouse::LowCardinalityType>();
        const clickhouse::TypeRef nested = lct ? lct->GetNestedType() : nullptr;
        if (nested) {
          nested_type_ = nested;
          type_ = nested_type_.get();
        } else {
          nested_type_ = clickhouse::Type::CreateString();
          type_ = nested_type_.get();
        }
        return;
      }
      case Type::Array:
        if (const auto* array = dynamic_cast<const clickhouse::ColumnArray*>(column)) {
          kind_ = Kind::Array;
          array_ = array;
          add_child(const_cast<clickhouse::ColumnArray*>(array)->GetData().get());
          return;
        }
        break;
      case Type::Tuple:
        if (const auto* tuple = dynamic_cast<const clickhouse::ColumnTuple*>(column)) {
          kind_ = Kind::Tuple;
          children_.reserve(tuple->TupleSize());
          for (size_t i = 0; i < tuple->TupleSize(); ++i) add_child(tuple->At(i).get());
          return;
        }
        break;
      case Type::Map:
        if (const auto* map = dynamic_cast<const clickhouse::ColumnMap*>(column)) {
          build_map(*map);
          return;
        }
        break;
      default:
        break;
    }
    // A Nullable that is not a ColumnNullable reads as its scalar item. An
    // Array, Tuple or Map whose column class is not the expected one reads as
    // null, as it always did.
    const auto code = type_->GetCode();
    kind_ = (code == Type::Array || code == Type::Tuple || code == Type::Map) ? Kind::Null : Kind::Item;
  }

  void build_map(const clickhouse::ColumnMap& map) {
    const clickhouse::ColumnArray* storage = map_storage(map);
    const auto* pairs = storage ? dynamic_cast<const clickhouse::ColumnTuple*>(
                                      const_cast<clickhouse::ColumnArray*>(storage)->GetData().get())
                                : nullptr;
    if (!pairs || pairs->TupleSize() < 2) {
      kind_ = Kind::MapEmpty;
      return;
    }
    array_ = storage;
    children_.reserve(2);
    add_child(pairs->At(0).get());
    add_child(pairs->At(1).get());
    const auto* map_type = column_->GetType().As<clickhouse::MapType>();
    const bool key_is_string = map_type && (map_type->GetKeyType()->GetCode() == clickhouse::Type::String ||
                                            map_type->GetKeyType()->GetCode() == clickhouse::Type::FixedString);
    if (key_is_string) {
      kind_ = Kind::MapObject;
      map_key_strings_ = dynamic_cast<const clickhouse::ColumnString*>(children_[0].column_);
    } else {
      kind_ = Kind::MapPairs;
    }
  }

  void add_child(const clickhouse::Column* column) {
    CellEncoder child;
    child.build(column);
    children_.push_back(std::move(child));
  }

  Kind kind_ = Kind::Item;
  const clickhouse::Column* column_ = nullptr;
  const clickhouse::Type* type_ = nullptr;
  clickhouse::TypeRef nested_type_;
  const clickhouse::ColumnNullable* nullable_ = nullptr;
  const clickhouse::ColumnArray* array_ = nullptr;
  const clickhouse::ColumnString* map_key_strings_ = nullptr;
  std::vector<CellEncoder> children_;
};

inline void write_column_value(rapidjson::Writer<rapidjson::StringBuffer>& w,
                               const clickhouse::ColumnRef& col,
                               size_t row) {
  CellEncoder(col).write(w, row);
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
  // ClickHouse exposes Bool through the native UInt8 wire representation in
  // several system tables. Preserve the declared SQL type in JSON instead of
  // leaking the transport representation as 0/1.
  if (detail::starts_with_ci(declared_type, "bool")) {
    const auto code = col->Type()->GetCode();
    if (code == clickhouse::Type::UInt8) {
      w.Bool(col->GetItem(row).get<uint8_t>() != 0);
      return;
    }
  }
  if (detail::starts_with_ci(declared_type, "nullable(bool")) {
    if (col->Type()->GetCode() == clickhouse::Type::Nullable) {
      auto nullable = col->As<clickhouse::ColumnNullable>();
      if (nullable && nullable->IsNull(row)) {
        w.Null();
        return;
      }
      if (nullable && nullable->Nested()->Type()->GetCode() == clickhouse::Type::UInt8) {
        w.Bool(nullable->Nested()->GetItem(row).get<uint8_t>() != 0);
        return;
      }
    }
  }
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
