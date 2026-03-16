function(chdash_regex_replace path pattern replacement)
  file(READ "${path}" _text)
  string(REGEX REPLACE "${pattern}" "${replacement}" _patched "${_text}")
  if (_text STREQUAL _patched)
    message(FATAL_ERROR "clickhouse-cpp compat patch failed for ${path}\npattern: ${pattern}")
  endif()
  file(WRITE "${path}" "${_patched}")
endfunction()

function(chdash_append_once path marker content)
  file(READ "${path}" _text)
  string(FIND "${_text}" "${marker}" _pos)
  if (_pos EQUAL -1)
    file(APPEND "${path}" "\n${content}\n")
  endif()
endfunction()

function(chdash_apply_clickhouse_cpp_compat source_dir)
  set(_types_h "${source_dir}/clickhouse/types/types.h")
  set(_types_cpp "${source_dir}/clickhouse/types/types.cpp")
  set(_numeric_h "${source_dir}/clickhouse/columns/numeric.h")
  set(_numeric_cpp "${source_dir}/clickhouse/columns/numeric.cpp")
  set(_itemview_h "${source_dir}/clickhouse/columns/itemview.h")
  set(_itemview_cpp "${source_dir}/clickhouse/columns/itemview.cpp")
  set(_type_parser_cpp "${source_dir}/clickhouse/types/type_parser.cpp")
  set(_factory_cpp "${source_dir}/clickhouse/columns/factory.cpp")

  foreach(_f IN LISTS _types_h _types_cpp _numeric_h _numeric_cpp _itemview_h _itemview_cpp _type_parser_cpp _factory_cpp)
    if (NOT EXISTS "${_f}")
      message(FATAL_ERROR "clickhouse-cpp compat patch missing file: ${_f}")
    endif()
  endforeach()

  # types.h
  chdash_regex_replace("${_types_h}"
    "#include \"absl/numeric/int128.h\""
    "#include \"absl/numeric/int128.h\"\n#include <boost/multiprecision/cpp_int.hpp>")
  chdash_regex_replace("${_types_h}"
    "using Int128 = absl::int128;[ \t\r\n]*using UInt128 = absl::uint128;[ \t\r\n]*using Int64 = int64_t;"
    "using Int128 = absl::int128;\nusing UInt128 = absl::uint128;\nusing Int256 = boost::multiprecision::int256_t;\nusing UInt256 = boost::multiprecision::uint256_t;\nusing Int64 = int64_t;")
  chdash_regex_replace("${_types_h}"
    "UUID, IPv4, IPv6, Int128, UInt128, Decimal, Decimal32, Decimal64, Decimal128,"
    "UUID, IPv4, IPv6, Int128, UInt128, Int256, UInt256, Decimal, Decimal32, Decimal64, Decimal128,")
  chdash_append_once("${_types_h}" "Type::CreateSimple<Int256>()"
"template <>\ninline TypeRef Type::CreateSimple<Int256>() {\n    return TypeRef(new Type(Int256));\n}\n\ntemplate <>\ninline TypeRef Type::CreateSimple<UInt256>() {\n    return TypeRef(new Type(UInt256));\n}")

  # types.cpp
  chdash_regex_replace("${_types_cpp}"
    "case Type::Code::UInt128: return \"UInt128\";[ \t\r\n]*case Type::Code::Decimal:"
    "case Type::Code::UInt128: return \"UInt128\"; case Type::Code::Int256: return \"Int256\"; case Type::Code::UInt256: return \"UInt256\"; case Type::Code::Decimal:")
  chdash_regex_replace("${_types_cpp}"
    "case Void: case Int8: case Int16: case Int32: case Int64: case Int128: case UInt8:"
    "case Void: case Int8: case Int16: case Int32: case Int64: case Int128: case Int256: case UInt8:")
  chdash_regex_replace("${_types_cpp}"
    "case Void: case Int8: case Int16: case Int32: case Int64: case Int128: case UInt8: case UInt16: case UInt32: case UInt64:"
    "case Void: case Int8: case Int16: case Int32: case Int64: case Int128: case Int256: case UInt8: case UInt16: case UInt32: case UInt64: case UInt256:")

  # numeric.h / numeric.cpp
  chdash_regex_replace("${_numeric_h}"
    "#include \"absl/numeric/int128.h\""
    "#include \"absl/numeric/int128.h\"\n#include <boost/multiprecision/cpp_int.hpp>")
  chdash_regex_replace("${_numeric_h}"
    "using Int128 = absl::int128; using UInt128 = absl::uint128; using Int64 = int64_t; using ColumnUInt8 = ColumnVector<uint8_t>;"
    "using Int128 = absl::int128; using UInt128 = absl::uint128; using Int256 = boost::multiprecision::int256_t; using UInt256 = boost::multiprecision::uint256_t; using Int64 = int64_t; using ColumnUInt8 = ColumnVector<uint8_t>;")
  chdash_regex_replace("${_numeric_h}"
    "using ColumnUInt64 = ColumnVector<UInt64>; using ColumnUInt128 = ColumnVector<UInt128>; using ColumnInt8 = ColumnVector<int8_t>;"
    "using ColumnUInt64 = ColumnVector<UInt64>; using ColumnUInt128 = ColumnVector<UInt128>; using ColumnUInt256 = ColumnVector<UInt256>; using ColumnInt8 = ColumnVector<int8_t>;")
  chdash_regex_replace("${_numeric_h}"
    "using ColumnInt64 = ColumnVector<Int64>; using ColumnInt128 = ColumnVector<Int128>; using ColumnFloat32 = ColumnVector<float>;"
    "using ColumnInt64 = ColumnVector<Int64>; using ColumnInt128 = ColumnVector<Int128>; using ColumnInt256 = ColumnVector<Int256>; using ColumnFloat32 = ColumnVector<float>;")
  chdash_append_once("${_numeric_cpp}" "template class ColumnVector<Int256>;"
"\ntemplate class ColumnVector<Int256>;\ntemplate class ColumnVector<UInt256>;\n")

  # itemview.h / itemview.cpp
  chdash_regex_replace("${_itemview_h}"
    "std::is_same_v<T, Int128> \|\| std::is_same_v<T, UInt128>"
    "std::is_same_v<T, Int128> || std::is_same_v<T, UInt128> || std::is_same_v<T, Int256> || std::is_same_v<T, UInt256>")
  chdash_regex_replace("${_itemview_h}"
    "std::is_same_v<ValueType, Int128> \|\| std::is_same_v<ValueType, UInt128>"
    "std::is_same_v<ValueType, Int128> || std::is_same_v<ValueType, UInt128> || std::is_same_v<ValueType, Int256> || std::is_same_v<ValueType, UInt256>")
  chdash_regex_replace("${_itemview_cpp}"
    "case Type::Code::IPv6: case Type::Code::UUID: case Type::Code::UInt128: case Type::Code::Int128: case Type::Code::Decimal128: return AssertSize\(\{16\}\);"
    "case Type::Code::IPv6: case Type::Code::UUID: case Type::Code::UInt128: case Type::Code::Int128: case Type::Code::Decimal128: return AssertSize({16}); case Type::Code::UInt256: case Type::Code::Int256: return AssertSize({32});")

  # type parser: new terminal types.
  chdash_regex_replace("${_type_parser_cpp}"
    "\{ \"Int128\", Type::Int128 \},[ \t\r\n]*\{ \"UInt128\", Type::UInt128 \},"
    "{ \"Int128\", Type::Int128 }, { \"UInt128\", Type::UInt128 }, { \"Int256\", Type::Int256 }, { \"UInt256\", Type::UInt256 }, { \"JSON\", Type::String }, { \"AggregateFunction\", Type::String },")

  # factory: proper numeric columns for 256-bit ints.
  chdash_regex_replace("${_factory_cpp}"
    "case Type::UInt128: return std::make_shared<ColumnUInt128>\(\);"
    "case Type::UInt128: return std::make_shared<ColumnUInt128>(); case Type::UInt256: return std::make_shared<ColumnUInt256>();")
  chdash_regex_replace("${_factory_cpp}"
    "case Type::Int128: return std::make_shared<ColumnInt128>\(\);"
    "case Type::Int128: return std::make_shared<ColumnInt128>(); case Type::Int256: return std::make_shared<ColumnInt256>();")
endfunction()
