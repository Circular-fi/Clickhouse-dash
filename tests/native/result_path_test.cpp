// Unit tests of the path of a result to the browser: the JSON cell encoder (src/json_clickhouse.hpp),
// the thread that encodes the blocks (src/block_encoder.hpp), and what a run builds on them: the plan of
// the columns and the SQL that wraps a statement (src/query_result_plan.cpp), the events of a result
// (src/query_result_events.cpp) and the cost that the ProfileEvents packets report (src/query_run_profile.cpp). The Query page rows, the exports,
// the MCP rows and the Explorer preview all write their cells with the cell encoder, which resolves the
// nested structure of a column once, so a row costs no dynamic_cast, no shared_ptr copy and no
// allocation. Each case checks the exact JSON text, and the same text from a reference encoder that
// keeps the generic algorithm (it slices a Map or Array cell out of its column, as the code did
// before the cell encoder). No ClickHouse needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_RESULT_TESTS=ON
//        cmake --build build --target chdash_result_path_test
// Run:   ./build/chdash_result_path_test   (exit code 0 = every check passed)
//        ./build/chdash_result_path_test --bench   (prints the time of 100000 map cells)
// The Python harness (test_native_unit_tests.py) runs it when RESULT_PATH_TEST_BINARY points at it.

#include "block_encoder.hpp"
#include "json_clickhouse.hpp"
#include "query_result_events.hpp"
#include "query_result_plan.hpp"
#include "query_run_profile.hpp"

#include <clickhouse/columns/bool.h>
#include <clickhouse/columns/date.h>
#include <clickhouse/columns/decimal.h>
#include <clickhouse/columns/enum.h>
#include <clickhouse/columns/string.h>
#include <clickhouse/columns/factory.h>
#include <clickhouse/columns/ip4.h>
#include <clickhouse/columns/uuid.h>
#include <clickhouse/columns/nullable.h>
#include <clickhouse/columns/numeric.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <limits>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <tuple>
#include <vector>

using namespace chdash;
using clickhouse::ColumnRef;

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                                        \
  do {                                                                                     \
    ++g_checks;                                                                            \
    if (!(cond)) {                                                                         \
      ++g_failures;                                                                        \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK failed: " #cond << std::endl;   \
    }                                                                                      \
  } while (0)

#define CHECK_EQ(a, b)                                                                                   \
  do {                                                                                                   \
    ++g_checks;                                                                                          \
    const auto va = (a);                                                                                 \
    const auto vb = (b);                                                                                 \
    if (!(va == vb)) {                                                                                   \
      ++g_failures;                                                                                      \
      std::cerr << __FILE__ << ":" << __LINE__ << ": CHECK_EQ failed: " #a " == " #b << "\n  left : " << va \
                << "\n  right: " << vb << std::endl;                                                     \
    }                                                                                                    \
  } while (0)

using Writer = rapidjson::Writer<rapidjson::StringBuffer>;

// The generic algorithm: one switch on the type code for every cell, a slice for every Map cell.
void reference_write(Writer& w, const ColumnRef& col, size_t row) {
  using clickhouse::Type;
  const auto code = col->GetType().GetCode();
  if (code == Type::Nullable) {
    auto n = col->As<clickhouse::ColumnNullable>();
    if (n->IsNull(row)) {
      w.Null();
      return;
    }
    reference_write(w, n->Nested(), row);
    return;
  }
  if (code == Type::LowCardinality) {
    const auto* lct = col->Type()->As<clickhouse::LowCardinalityType>();
    detail::write_item(w, col->GetItem(row), *lct->GetNestedType());
    return;
  }
  if (code == Type::Array) {
    auto a = col->As<clickhouse::ColumnArray>();
    const ColumnRef cell = a->GetAsColumn(row);
    w.StartArray();
    for (size_t i = 0; i < cell->Size(); ++i) reference_write(w, cell, i);
    w.EndArray();
    return;
  }
  if (code == Type::Tuple) {
    auto t = col->As<clickhouse::ColumnTuple>();
    w.StartArray();
    for (size_t i = 0; i < t->TupleSize(); ++i) reference_write(w, t->At(i), row);
    w.EndArray();
    return;
  }
  if (code == Type::Map) {
    auto m = col->As<clickhouse::ColumnMap>();
    const ColumnRef items = m->GetAsColumn(row);
    auto pairs = items->As<clickhouse::ColumnTuple>();
    w.StartArray();
    for (size_t i = 0; i < items->Size(); ++i) {
      w.StartArray();
      reference_write(w, pairs->At(0), i);
      reference_write(w, pairs->At(1), i);
      w.EndArray();
    }
    w.EndArray();
    return;
  }
  detail::write_item(w, col->GetItem(row), col->GetType());
}

std::string encoded(const ColumnRef& col, size_t row) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  detail::CellEncoder(col).write(w, row);
  return std::string(sb.GetString(), sb.GetSize());
}

std::string reference(const ColumnRef& col, size_t row) {
  rapidjson::StringBuffer sb;
  Writer w(sb);
  reference_write(w, col, row);
  return std::string(sb.GetString(), sb.GetSize());
}

// The cell encoder and the reference agree on every row, and the first row has the stated JSON.
void check_column(const ColumnRef& col, const std::vector<std::string>& expected) {
  CHECK_EQ(col->Size(), expected.size());
  for (size_t row = 0; row < expected.size(); ++row) {
    CHECK_EQ(encoded(col, row), expected[row]);
    CHECK_EQ(reference(col, row), expected[row]);
  }
}

template <typename T>
std::shared_ptr<T> make() { return std::make_shared<T>(); }

void test_scalars() {
  auto text = make<clickhouse::ColumnString>();
  text->Append("a\"b");
  text->Append("");
  check_column(text, {"\"a\\\"b\"", "\"\""});

  auto number = make<clickhouse::ColumnUInt64>();
  number->Append(0);
  number->Append(18446744073709551615ULL);
  check_column(number, {"\"0\"", "\"18446744073709551615\""});

  auto real = make<clickhouse::ColumnFloat64>();
  real->Append(1.5);
  real->Append(std::numeric_limits<double>::quiet_NaN());
  check_column(real, {"1.5", "\"nan\""});

  auto stamp = std::make_shared<clickhouse::ColumnDateTime64>(3);
  stamp->Append(1700000000123LL);
  check_column(stamp, {"\"2023-11-14T22:13:20.123Z\""});
}

void test_nullable_and_low_cardinality() {
  auto nested = make<clickhouse::ColumnString>();
  nested->Append("x");
  nested->Append("ignored");
  nested->Append("z");
  auto nulls = make<clickhouse::ColumnUInt8>();
  nulls->Append(0);
  nulls->Append(1);
  nulls->Append(0);
  check_column(std::make_shared<clickhouse::ColumnNullable>(nested, nulls), {"\"x\"", "null", "\"z\""});

  auto low = std::make_shared<clickhouse::ColumnLowCardinalityT<clickhouse::ColumnString>>();
  low->Append("north");
  low->Append("south");
  low->Append("north");
  check_column(low, {"\"north\"", "\"south\"", "\"north\""});
}

void test_arrays_and_tuples() {
  auto array = std::make_shared<clickhouse::ColumnArrayT<clickhouse::ColumnUInt8>>();
  array->Append(std::vector<uint8_t>{1, 2, 3});
  array->Append(std::vector<uint8_t>{});
  array->Append(std::vector<uint8_t>{9});
  check_column(array, {"[1,2,3]", "[]", "[9]"});

  auto number = make<clickhouse::ColumnUInt8>();
  number->Append(7);
  number->Append(8);
  auto text = make<clickhouse::ColumnString>();
  text->Append("a");
  text->Append("b");
  check_column(std::make_shared<clickhouse::ColumnTuple>(std::vector<ColumnRef>{number, text}), {"[7,\"a\"]", "[8,\"b\"]"});

  // Array(Tuple(UInt8, String)): a tuple inside an array, the elements of two rows in one backing column.
  auto element_number = make<clickhouse::ColumnUInt8>();
  auto element_text = make<clickhouse::ColumnString>();
  for (int i = 0; i < 3; ++i) {
    element_number->Append(static_cast<uint8_t>(i));
    element_text->Append(std::string(1, static_cast<char>('p' + i)));
  }
  auto offsets = make<clickhouse::ColumnUInt64>();
  offsets->Append(1);
  offsets->Append(3);
  auto elements = std::make_shared<clickhouse::ColumnTuple>(std::vector<ColumnRef>{element_number, element_text});
  check_column(std::make_shared<clickhouse::ColumnArray>(elements, offsets), {"[[0,\"p\"]]", "[[1,\"q\"],[2,\"r\"]]"});
}

void test_maps() {
  // Map(String, String): an array of [key, value] pairs in the stored order, the empty map included.
  auto keys = make<clickhouse::ColumnString>();
  auto values = make<clickhouse::ColumnString>();
  auto texts = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnString, clickhouse::ColumnString>>(keys, values);
  texts->Append(std::map<std::string, std::string>{{"a", "1"}, {"b", "2"}});
  texts->Append(std::map<std::string, std::string>{});
  texts->Append(std::map<std::string, std::string>{{"k\"q", "v"}});
  check_column(texts, {"[[\"a\",\"1\"],[\"b\",\"2\"]]", "[]", "[[\"k\\\"q\",\"v\"]]"});

  // Map(UInt8, String): the same shape whatever the key type.
  auto number_keys = make<clickhouse::ColumnUInt8>();
  auto number_values = make<clickhouse::ColumnString>();
  auto pairs = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnUInt8, clickhouse::ColumnString>>(number_keys, number_values);
  pairs->Append(std::map<uint8_t, std::string>{{1, "x"}, {2, "y"}});
  pairs->Append(std::map<uint8_t, std::string>{});
  check_column(pairs, {"[[1,\"x\"],[2,\"y\"]]", "[]"});

  // Map(String, Array(UInt8)): a value that is itself nested.
  auto array_keys = make<clickhouse::ColumnString>();
  auto array_values = std::make_shared<clickhouse::ColumnArrayT<clickhouse::ColumnUInt8>>();
  auto nested = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnString, clickhouse::ColumnArrayT<clickhouse::ColumnUInt8>>>(array_keys, array_values);
  nested->Append(std::map<std::string, std::vector<uint8_t>>{{"a", {1, 2}}, {"b", {}}});
  nested->Append(std::map<std::string, std::vector<uint8_t>>{});
  check_column(nested, {"[[\"a\",[1,2]],[\"b\",[]]]", "[]"});

  // Map(LowCardinality(String), UInt64): the OpenTelemetry attribute shape is the same as Map(String, ...).
  auto low_keys = std::make_shared<clickhouse::ColumnLowCardinalityT<clickhouse::ColumnString>>();
  auto big_values = make<clickhouse::ColumnUInt64>();
  low_keys->Append("10");
  big_values->Append(18446744073709551615ULL);
  low_keys->Append("2");
  big_values->Append(0);
  auto map_offsets = make<clickhouse::ColumnUInt64>();
  map_offsets->Append(2);
  auto storage = std::make_shared<clickhouse::ColumnArray>(
      std::make_shared<clickhouse::ColumnTuple>(std::vector<ColumnRef>{low_keys, big_values}), map_offsets);
  check_column(std::make_shared<clickhouse::ColumnMap>(storage), {"[[\"10\",\"18446744073709551615\"],[\"2\",\"0\"]]"});
}

// The value contract of docs/telemetry.md ("Result values"): every value as ClickHouse stores it, in a
// form that JSON.parse in a browser does not change.
void test_value_contract() {
  auto int64 = make<clickhouse::ColumnInt64>();
  int64->Append(std::numeric_limits<int64_t>::min());
  int64->Append(-1);
  check_column(int64, {"\"-9223372036854775808\"", "\"-1\""});

  auto uint128 = make<clickhouse::ColumnUInt128>();
  uint128->Append(~clickhouse::UInt128(0));
  check_column(uint128, {"\"340282366920938463463374607431768211455\""});

  auto int128 = make<clickhouse::ColumnInt128>();
  int128->Append(clickhouse::Int128(-5));
  check_column(int128, {"\"-5\""});

  // Decimal(38, 9) and Decimal(18, 3): strings at the scale of the type.
  auto wide = std::make_shared<clickhouse::ColumnDecimal>(38, 9);
  wide->Append(std::string("12345678901234567890.123456789"));
  wide->Append(std::string("-0.000000001"));
  check_column(wide, {"\"12345678901234567890.123456789\"", "\"-0.000000001\""});
  auto narrow = std::make_shared<clickhouse::ColumnDecimal>(18, 3);
  narrow->Append(std::string("1.5"));
  check_column(narrow, {"\"1.500\""});

  // Float32 is written as a float (0.1, not 0.10000000149011612); NaN and infinities as ClickHouse prints them.
  auto float32 = make<clickhouse::ColumnFloat32>();
  float32->Append(0.1f);
  float32->Append(std::numeric_limits<float>::infinity());
  float32->Append(-std::numeric_limits<float>::infinity());
  check_column(float32, {"0.1", "\"inf\"", "\"-inf\""});

  // UUID: the text of toUUID('00000000-0000-0000-0000-000000000001'), not its bytes in memory order.
  auto uuid = make<clickhouse::ColumnUUID>();
  uuid->Append(clickhouse::UUID(0, 1));
  uuid->Append(clickhouse::UUID(0x0123456789abcdefULL, 0xfedcba9876543210ULL));
  check_column(uuid, {"\"00000000-0000-0000-0000-000000000001\"", "\"01234567-89ab-cdef-fedc-ba9876543210\""});

  // IPv4 1.2.3.4, not 4.3.2.1.
  auto ip = make<clickhouse::ColumnIPv4>();
  ip->Append("1.2.3.4");
  check_column(ip, {"\"1.2.3.4\""});

  // A NUL byte stays in the text; a byte that is not UTF-8 becomes U+FFFD.
  auto text = make<clickhouse::ColumnString>();
  text->Append(std::string("a\0b", 3));
  text->Append(std::string("\xff\x00z", 3));
  text->Append(std::string("caf\xc3\xa9"));
  check_column(text, {"\"a\\u0000b\"", "\"\xEF\xBF\xBD\\u0000z\"", "\"caf\xc3\xa9\""});
}

// clickhouse-cpp reads a Bool as a ColumnBool (CH_MAP_BOOL_TO_UINT8 is off): true or false, also inside a Nullable
// and an Array. A UInt8 whose declared type is Bool (a DESCRIBE plan of an older projection) is true or false too.
void test_bool_is_true_or_false() {
  auto flags = make<clickhouse::ColumnBool>();
  flags->Append(true);
  flags->Append(false);
  check_column(flags, {"true", "false"});
  auto values = make<clickhouse::ColumnBool>();
  values->Append(true);
  values->Append(false);
  auto nulls = make<clickhouse::ColumnUInt8>();
  nulls->Append(0);
  nulls->Append(1);
  check_column(std::make_shared<clickhouse::ColumnNullable>(values, nulls), {"true", "null"});
}

void test_declared_bool_is_true_or_false() {
  auto flags = make<clickhouse::ColumnUInt8>();
  flags->Append(1);
  flags->Append(0);
  const auto declared = [&](const ColumnRef& col, size_t row, const std::string& type) {
    rapidjson::StringBuffer sb;
    Writer w(sb);
    write_cell_json_declared(w, col, row, type);
    return std::string(sb.GetString(), sb.GetSize());
  };
  CHECK_EQ(declared(flags, 0, "Bool"), std::string("true"));
  CHECK_EQ(declared(flags, 1, "Bool"), std::string("false"));
  CHECK_EQ(declared(flags, 0, "UInt8"), std::string("1"));
  // A JSON value that arrives as text stays that text: no number is rounded, no zero dropped.
  auto json = make<clickhouse::ColumnString>();
  json->Append("{\"id\":12345678901234567890,\"a\":1.0}");
  CHECK_EQ(declared(json, 0, "JSON"), std::string("\"{\\\"id\\\":12345678901234567890,\\\"a\\\":1.0}\""));
}

void test_utf8_helpers() {
  CHECK(is_valid_utf8("caf\xc3\xa9"));
  CHECK(!is_valid_utf8("\xc3"));
  CHECK(!is_valid_utf8("\xed\xa0\x80"));  // a surrogate
  CHECK_EQ(utf8_with_replacement("a\xff" "b"), std::string("a\xEF\xBF\xBD" "b"));
  // A cut by bytes never leaves half a character.
  CHECK_EQ(std::string(utf8_prefix("caf\xc3\xa9", 4)), std::string("caf"));
  CHECK_EQ(std::string(utf8_prefix("caf\xc3\xa9", 5)), std::string("caf\xc3\xa9"));
  CHECK_EQ(std::string(utf8_without_cut_tail("ab\xe2\x82")), std::string("ab"));
  CHECK_EQ(std::string(utf8_without_cut_tail("ab\xe2\x82\xac")), std::string("ab\xe2\x82\xac"));
}

// A nested column over many rows: every row of the encoder equals the reference.
void test_many_rows_equal_the_reference() {
  auto keys = make<clickhouse::ColumnString>();
  auto values = make<clickhouse::ColumnString>();
  auto map = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnString, clickhouse::ColumnString>>(keys, values);
  for (int row = 0; row < 500; ++row) {
    std::map<std::string, std::string> cell;
    for (int i = 0; i < row % 5; ++i) cell["key" + std::to_string(i)] = "value-" + std::to_string(row * 7 + i);
    map->Append(cell);
  }
  for (size_t row = 0; row < map->Size(); ++row) CHECK_EQ(encoded(map, row), reference(map, row));
}

// Milliseconds to write `rows` Map cells: the cell encoder, or the reference that slices each cell out.
double map_cells_ms(const ColumnRef& map, bool use_encoder) {
  const auto start = std::chrono::steady_clock::now();
  size_t bytes = 0;
  rapidjson::StringBuffer sb;
  if (use_encoder) {
    detail::CellEncoder encoder(map);
    for (size_t row = 0; row < map->Size(); ++row) {
      sb.Clear();
      Writer w(sb);
      encoder.write(w, row);
      bytes += sb.GetSize();
    }
  } else {
    for (size_t row = 0; row < map->Size(); ++row) {
      sb.Clear();
      Writer w(sb);
      reference_write(w, map, row);
      bytes += sb.GetSize();
    }
  }
  if (bytes == 0) std::abort();
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
}

ColumnRef make_map_column(int rows) {
  auto keys = make<clickhouse::ColumnString>();
  auto values = make<clickhouse::ColumnString>();
  auto map = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnString, clickhouse::ColumnString>>(keys, values);
  for (int row = 0; row < rows; ++row) {
    map->Append(std::map<std::string, std::string>{{"region", "north-" + std::to_string(row % 9)}, {"rack", "r" + std::to_string(row % 40)}, {"slot", std::to_string(row)}});
  }
  return map;
}

// A budget as a ratio, so a loaded machine does not break it: reading a Map cell in place stays far
// cheaper than slicing it out of its column (15 times on the development machine, 4 times is the floor).
void test_map_cells_are_read_in_place() {
  const ColumnRef map = make_map_column(20000);
  double encoder_ms = 1e18;
  double reference_ms = 1e18;
  for (int pass = 0; pass < 3; ++pass) {
    encoder_ms = std::min(encoder_ms, map_cells_ms(map, true));
    reference_ms = std::min(reference_ms, map_cells_ms(map, false));
  }
  ++g_checks;
  if (!(encoder_ms * 4 < reference_ms)) {
    ++g_failures;
    std::cerr << "Map cells: encoder " << encoder_ms << " ms, reference " << reference_ms << " ms (ratio under 4)" << std::endl;
  }
}


// ---- The block encoder -------------------------------------------------------------------------

clickhouse::Block block_of(uint64_t rows) {
  auto column = make<clickhouse::ColumnUInt64>();
  for (uint64_t i = 0; i < rows; ++i) column->Append(i);
  clickhouse::Block block;
  block.AppendColumn("n", column);
  return block;
}

std::string thrown_by(const std::function<void()>& action) {
  try {
    action();
  } catch (const std::exception& e) {
    return e.what();
  }
  return "";
}

void test_block_encoder_encodes_every_block_in_order() {
  std::vector<size_t> seen;
  std::atomic<bool> canceled{false};
  {
    BlockEncoder encoder([&](const clickhouse::Block& block) { seen.push_back(block.GetRowCount()); }, 4);
    for (size_t i = 1; i <= 300; ++i) encoder.submit(block_of(i % 7 + 1), canceled);
    encoder.finish();
  }
  CHECK_EQ(seen.size(), static_cast<size_t>(300));
  bool ordered = true;
  for (size_t i = 1; i <= 300; ++i) ordered = ordered && seen[i - 1] == i % 7 + 1;
  CHECK_EQ(ordered, true);
}

// At most `depth` blocks wait: the next submit blocks until the encoder takes one.
void test_block_encoder_bounds_the_queue() {
  std::mutex mu;
  std::condition_variable cv;
  bool release = false;
  std::atomic<int> encoded{0};
  std::atomic<bool> canceled{false};
  BlockEncoder encoder([&](const clickhouse::Block&) {
    std::unique_lock<std::mutex> lk(mu);
    cv.wait(lk, [&] { return release; });
    ++encoded;
  }, 2);
  // One block is in the encoder (blocked in its callback), two wait: the fourth must block.
  encoder.submit(block_of(1), canceled);
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  encoder.submit(block_of(1), canceled);
  encoder.submit(block_of(1), canceled);
  std::atomic<bool> fourth_returned{false};
  std::thread fourth([&] {
    encoder.submit(block_of(1), canceled);
    fourth_returned = true;
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(150));
  CHECK_EQ(fourth_returned.load(), false);
  {
    std::lock_guard<std::mutex> lk(mu);
    release = true;
  }
  cv.notify_all();
  fourth.join();
  encoder.finish();
  CHECK_EQ(encoded.load(), 4);
}

// The encoder's failure (a cell too large, the result limit) stops the next submit and the end.
void test_block_encoder_failure_reaches_the_receiving_thread() {
  std::atomic<bool> canceled{false};
  int calls = 0;
  BlockEncoder encoder([&](const clickhouse::Block&) {
    if (++calls == 3) throw std::runtime_error("result_cell_too_large");
  }, 2);
  std::string message;
  for (int i = 0; i < 100 && message.empty(); ++i) {
    message = thrown_by([&] { encoder.submit(block_of(1), canceled); });
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  CHECK_EQ(message, std::string("result_cell_too_large"));
  CHECK_EQ(thrown_by([&] { encoder.finish(); }), std::string("result_cell_too_large"));
  CHECK_EQ(calls, 3);  // nothing is encoded after the failure
}

void test_block_encoder_cancel_stops_a_waiting_submit() {
  std::mutex mu;
  std::condition_variable cv;
  bool release = false;
  std::atomic<bool> canceled{false};
  BlockEncoder encoder([&](const clickhouse::Block&) {
    std::unique_lock<std::mutex> lk(mu);
    cv.wait(lk, [&] { return release; });
  }, 1);
  encoder.submit(block_of(1), canceled);
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  encoder.submit(block_of(1), canceled);
  std::string message;
  std::thread waiting([&] { message = thrown_by([&] { encoder.submit(block_of(1), canceled); }); });
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  canceled = true;
  {
    // The receiving side wakes a waiting submit through the encoder's own signal, as a cancel does in the session.
    std::lock_guard<std::mutex> lk(mu);
    release = true;
  }
  cv.notify_all();
  waiting.join();
  // The encoder took a block meanwhile, so the third submit either got in or saw the cancel.
  CHECK(message.empty() || message == "canceled");
  encoder.finish();
}

// Leaving the scope with blocks waiting (an error in the client) joins the thread without encoding them.
void test_block_encoder_destructor_drops_what_waits() {
  std::atomic<bool> canceled{false};
  std::atomic<int> encoded{0};
  {
    BlockEncoder encoder([&](const clickhouse::Block&) {
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
      ++encoded;
    }, 4);
    for (int i = 0; i < 4; ++i) encoder.submit(block_of(1), canceled);
  }
  CHECK(encoded.load() < 4);
}

int bench() {
  const ColumnRef map = make_map_column(100000);
  std::cout << "cell encoder: " << map_cells_ms(map, true) << " ms for 100000 map cells" << std::endl;
  std::cout << "reference   : " << map_cells_ms(map, false) << " ms for 100000 map cells" << std::endl;
  return 0;
}

} // namespace

// ---- the plan of the columns ----

void test_the_transport_of_a_type() {
  CHECK(classify_result_transport("UInt64") == ResultTransportMode::Passthrough);
  CHECK(classify_result_transport("Array(String)") == ResultTransportMode::Passthrough);
  CHECK(classify_result_transport("UInt256") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("Array(Int256)") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("JSON") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("Nullable(Dynamic)") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("Decimal(76, 5)") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("Decimal(38, 5)") == ResultTransportMode::Passthrough);
  CHECK(classify_result_transport("Decimal256(3)") == ResultTransportMode::Stringify);
  CHECK(classify_result_transport("AggregateFunction(sum, UInt64)") == ResultTransportMode::Opaque);
  CHECK_EQ(std::string(transport_mode_name(ResultTransportMode::Opaque)), std::string("opaque"));

  std::string_view inner;
  CHECK(unwrap_outer_type("Nullable(Array(Int8))", "Nullable", &inner) && inner == "Array(Int8)");
  CHECK(!unwrap_outer_type("Nullable(Int8) ", "Nullable", &inner));
  CHECK(!unwrap_outer_type("Tuple(Nullable(Int8), Int8)", "Nullable", &inner));
  CHECK(is_top_level_nullable_type("nullable(String)") && !is_top_level_nullable_type("Array(Nullable(String))"));
  CHECK(is_structured_type("Array(UInt8)") && is_structured_type("LowCardinality(Nullable(JSON))") && is_structured_type("Map(String, Int8)"));
  CHECK(!is_structured_type("Nullable(Decimal(76, 2))") && !is_structured_type("String"));
  CHECK(is_bool_type_name("Bool") && is_bool_type_name("Nullable(Bool)") && !is_bool_type_name("Array(Bool)"));

  // DESCRIBE may print a type over several lines.
  CHECK_EQ(normalize_type_string("Tuple(\n    a Int8,\n    b  String\n)"), std::string("Tuple(a Int8, b String)"));
  CHECK_EQ(normalize_type_string("Enum8('a b' = 1,\n 'c' = 2)"), std::string("Enum8('a b' = 1, 'c' = 2)"));
  CHECK(icontains("Unsupported Column Type x", "column type") && !icontains("abc", "abd") && icontains("abc", ""));
  CHECK(iequals_ascii("JsOn", "jSoN") && !iequals_ascii("a", "ab"));
  CHECK_EQ(strip_trailing_semicolon_copy("  SELECT 1 ;\n"), std::string("SELECT 1"));
  // What makes a run try again with DESCRIBE.
  CHECK(should_retry_with_describe_after_direct_path_error("Code: 48. Unsupported column type: Variant"));
  CHECK(should_retry_with_describe_after_direct_path_error("Cannot parse type Foo"));
  CHECK(!should_retry_with_describe_after_direct_path_error("Table x does not exist"));
}

ResultColumnPlan plan_of(const std::string& type) {
  ResultColumnPlan plan;
  plan.original_type = type;
  plan.mode = classify_result_transport(type);
  plan.transport_type = plan.mode == ResultTransportMode::Passthrough ? type : (is_top_level_nullable_type(type) ? "Nullable(String)" : "String");
  return plan;
}

void test_the_wrapper_of_a_statement() {
  const std::vector<std::pair<std::string, ResultColumnPlan>> plain = {{"a", plan_of("UInt8")}, {"b", plan_of("String")}};
  bool used = true;
  CHECK_EQ(build_transport_wrapper_sql("SELECT 1;", plain, &used), std::string("SELECT 1;"));
  CHECK(!used);
  const std::vector<std::pair<std::string, ResultColumnPlan>> mixed = {
      {"a", plan_of("UInt8")}, {"w", plan_of("UInt256")}, {"n", plan_of("Nullable(Decimal(76, 2))")}, {"j", plan_of("Array(Int256)")},
      {"s", plan_of("AggregateFunction(sum, UInt64)")}, {"we`ird", plan_of("JSON")}};
  CHECK_EQ(build_transport_wrapper_sql("SELECT x FROM t ;", mixed, &used),
           std::string("SELECT\n"
                       "    _q.`a` AS `a`,\n"
                       "    toString(_q.`w`) AS `w`,\n"
                       "    if(isNull(_q.`n`), CAST(NULL AS Nullable(String)), toString(_q.`n`)) AS `n`,\n"
                       "    toJSONString(_q.`j`) AS `j`,\n"
                       "    toString(_q.`s`) AS `s`,\n"
                       "    toJSONString(_q.`we\\`ird`) AS `we\\`ird`\n"
                       "FROM\n(\nSELECT x FROM t\n) AS _q"));
  CHECK(used);
  CHECK_EQ(build_transport_wrapper_sql("SELECT 1", {}, &used), std::string("SELECT 1"));
  CHECK(!used);
}

clickhouse::Block block_of(const std::vector<std::pair<std::string, ColumnRef>>& columns) {
  clickhouse::Block block;
  for (const auto& [name, column] : columns) block.AppendColumn(name, column);
  return block;
}

std::shared_ptr<clickhouse::ColumnString> strings(const std::vector<std::string>& values) {
  auto column = std::make_shared<clickhouse::ColumnString>();
  for (const auto& v : values) column->Append(v);
  return column;
}

void test_the_answer_of_describe_is_a_plan() {
  ResultPlan plan;
  add_described_columns(block_of({{"name", strings({"id", "big", "doc"})}, {"type", strings({"UInt8", "UInt256", "Nullable(JSON)"})}, {"default_type", strings({"", "", ""})}}), &plan);
  CHECK_EQ(plan.size(), size_t(3));
  CHECK_EQ(plan[1].first, std::string("big"));
  CHECK(plan[1].second.mode == ResultTransportMode::Stringify && plan[1].second.transport_type == "String");
  CHECK(plan[2].second.transport_type == "Nullable(String)" && plan[2].second.original_type == "Nullable(JSON)");
  // The columns are found by their names, then by their places; a block with fewer than two columns says nothing.
  ResultPlan swapped;
  add_described_columns(block_of({{"type", strings({"UInt8"})}, {"name", strings({"x"})}}), &swapped);
  CHECK(swapped.size() == 1 && swapped[0].first == "x" && swapped[0].second.original_type == "UInt8");
  ResultPlan none;
  add_described_columns(block_of({{"name", strings({"x"})}}), &none);
  add_described_columns(block_of({{"name", strings({})}, {"type", strings({})}}), &none);
  CHECK(none.empty());

  // The plan of the columns of a result: by position when the counts agree, else by name.
  const auto result = block_of({{"id", std::make_shared<clickhouse::ColumnUInt8>()}, {"big", strings({})}, {"doc", strings({})}});
  auto by_position = resolve_column_plans(result, plan);
  CHECK(by_position.size() == 3 && by_position[1] == &plan[1].second);
  const auto fewer = block_of({{"doc", strings({})}, {"nope", strings({})}});
  auto by_name = resolve_column_plans(fewer, plan);
  CHECK(by_name[0] == &plan[2].second && by_name[1] == nullptr);
  CHECK(resolve_column_plans(result, ResultPlan{})[0] == nullptr);
}

void test_recent_plans_are_kept_for_a_while() {
  DescribePlanCache cache;
  ResultPlan plan = {{"a", plan_of("UInt256")}};
  const std::string key = describe_cache_key("host", "db", "SELECT 1");
  CHECK(key != describe_cache_key("host", "db", "SELECT 2") && key != describe_cache_key("host", "other", "SELECT 1") && key != describe_cache_key("host2", "db", "SELECT 1"));
  CHECK(!get_cached_describe_plan(&cache, key, 4, 1000).has_value());
  put_cached_describe_plan(&cache, key, plan, 4, 1000);
  const auto got = get_cached_describe_plan(&cache, key, 4, 1000);
  CHECK(got && got->size() == 1 && (*got)[0].second.mode == ResultTransportMode::Stringify);
  // No cache, no room, no time, or an empty plan: nothing is kept.
  CHECK(!get_cached_describe_plan(nullptr, key, 4, 1000).has_value());
  CHECK(!get_cached_describe_plan(&cache, key, 0, 1000).has_value());
  CHECK(!get_cached_describe_plan(&cache, key, 4, 0).has_value());
  DescribePlanCache other;
  put_cached_describe_plan(&other, key, ResultPlan{}, 4, 1000);
  put_cached_describe_plan(&other, "", plan, 4, 1000);
  put_cached_describe_plan(&other, key, plan, 0, 1000);
  CHECK(!get_cached_describe_plan(&other, key, 4, 1000).has_value());
  // The oldest use leaves first.
  DescribePlanCache small;
  put_cached_describe_plan(&small, "a", plan, 2, 1000);
  put_cached_describe_plan(&small, "b", plan, 2, 1000);
  CHECK(get_cached_describe_plan(&small, "a", 2, 1000).has_value());
  put_cached_describe_plan(&small, "c", plan, 2, 1000);
  CHECK(get_cached_describe_plan(&small, "a", 2, 1000).has_value());
  CHECK(!get_cached_describe_plan(&small, "b", 2, 1000).has_value());
  invalidate_cached_describe_plan(&small, "a");
  CHECK(!get_cached_describe_plan(&small, "a", 2, 1000).has_value());
  invalidate_cached_describe_plan(&small, "");
  invalidate_cached_describe_plan(nullptr, "a");
  // A plan expires.
  DescribePlanCache expiring;
  put_cached_describe_plan(&expiring, "k", plan, 4, 1);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(!get_cached_describe_plan(&expiring, "k", 4, 1).has_value());
}

// ---- the events of a result ----

struct Events {
  std::vector<std::pair<std::string, std::string>> list;
  size_t rows = 0, bytes = 0;
  ResultEventWriter writer;
  Events(ResultEventLimits limits)
      : writer("q1", limits, [this](std::string_view e, std::string_view j) { list.emplace_back(std::string(e), std::string(j)); },
               [this](size_t r, size_t b) { rows += r; bytes += b; }) {}
};

void test_a_result_is_meta_then_rows() {
  ResultEventLimits limits;
  limits.max_rows_per_event = 2;
  Events out(limits);
  const ResultPlan plan = {{"n", plan_of("UInt8")}, {"big", plan_of("UInt256")}};
  out.writer.begin_attempt(&plan, true, true, false);
  auto numbers = std::make_shared<clickhouse::ColumnUInt8>();
  for (int i = 0; i < 5; ++i) numbers->Append(static_cast<uint8_t>(i));
  auto texts = strings({"0", "1", "2", "3", "4"});
  out.writer.write(block_of({{"n", numbers}, {"big", texts}}));
  CHECK_EQ(out.list.size(), size_t(4));
  CHECK_EQ(out.list[0].first, std::string("result_meta"));
  CHECK_EQ(out.list[0].second,
           std::string("{\"query_id\":\"q1\",\"columns\":[\"n\",\"big\"],\"types\":[\"UInt8\",\"String\"],\"original_types\":[\"UInt8\",\"UInt256\"],"
                       "\"transport_modes\":[\"passthrough\",\"stringify\"],\"used_transport_wrapper\":true,\"describe_mode\":\"described\",\"describe_cache_hit\":false}"));
  CHECK_EQ(out.list[1].first, std::string("result_rows"));
  CHECK_EQ(out.list[1].second, std::string("{\"query_id\":\"q1\",\"rows\":[[0,\"0\"],[1,\"1\"]]}"));
  CHECK_EQ(out.list[3].second, std::string("{\"query_id\":\"q1\",\"rows\":[[4,\"4\"]]}"));
  CHECK_EQ(out.rows, size_t(5));
  CHECK_EQ(out.writer.rows_returned(), uint64_t(5));
  size_t total_bytes = 0;
  for (size_t i = 1; i < out.list.size(); ++i) total_bytes += out.list[i].second.size();
  CHECK_EQ(out.bytes, total_bytes);
  // The meta event is sent once; a block with no rows sends none; the next block of rows goes on.
  out.writer.write(block_of({{"n", std::make_shared<clickhouse::ColumnUInt8>()}, {"big", strings({})}}));
  CHECK_EQ(out.list.size(), size_t(4));
  // After a restart (the run goes again with another plan) the meta event is sent again, and the count starts from 0.
  out.writer.restart();
  CHECK_EQ(out.writer.rows_returned(), uint64_t(0));
  out.writer.begin_attempt(nullptr, false, false, true);
  auto one = std::make_shared<clickhouse::ColumnUInt8>();
  one->Append(7);
  out.writer.write(block_of({{"n", one}}));
  CHECK_EQ(out.list.size(), size_t(6));
  CHECK(out.list[4].second.find("\"describe_mode\":\"direct\",\"describe_cache_hit\":true") != std::string::npos);
  CHECK(out.list[4].second.find("\"types\":[\"UInt8\"]") != std::string::npos);
}

void test_a_result_stops_at_its_row_limit_and_its_cell_limit() {
  ResultEventLimits limits;
  limits.row_limit = 3;
  Events out(limits);
  out.writer.begin_attempt(nullptr, false, false, false);
  auto numbers = std::make_shared<clickhouse::ColumnUInt16>();
  for (int i = 0; i < 10; ++i) numbers->Append(static_cast<uint16_t>(i));
  out.writer.write(block_of({{"n", numbers}}));
  CHECK_EQ(out.rows, size_t(3));
  CHECK_EQ(out.list.back().second, std::string("{\"query_id\":\"q1\",\"rows\":[[0],[1],[2]]}"));
  // Rows that have more bytes than a cell may hold fail the run, with the name of the setting.
  ResultEventLimits tight;
  tight.max_result_cell_bytes = 4;
  Events small(tight);
  small.writer.begin_attempt(nullptr, false, false, false);
  std::string message;
  try {
    small.writer.write(block_of({{"s", strings({"a longer text"})}}));
  } catch (const std::runtime_error& e) {
    message = e.what();
  }
  CHECK(message.find("result_cell_too_large") == 0 && message.find("query.max_result_cell_bytes (4 bytes)") != std::string::npos);
  // A Bool that clickhouse-cpp reads as UInt8, or an opaque state, is written as its plan declares it.
  Events declared(ResultEventLimits{});
  const ResultPlan plan = {{"b", plan_of("Bool")}};
  declared.writer.begin_attempt(&plan, false, true, false);
  auto flags = std::make_shared<clickhouse::ColumnUInt8>();
  flags->Append(1);
  flags->Append(0);
  declared.writer.write(block_of({{"b", flags}}));
  CHECK_EQ(declared.list.back().second, std::string("{\"query_id\":\"q1\",\"rows\":[[true],[false]]}"));
}

// ---- the cost that a run reports ----

clickhouse::Block profile_block(const std::vector<std::string>& hosts, const std::vector<uint64_t>& threads, const std::vector<std::string>& types,
                                const std::vector<std::string>& names, const std::vector<int64_t>& values) {
  auto type_column = std::make_shared<clickhouse::ColumnEnum8>(clickhouse::Type::CreateEnum8({{"increment", 1}, {"gauge", 2}}));
  for (const auto& t : types) type_column->Append(t);
  auto thread_column = std::make_shared<clickhouse::ColumnUInt64>();
  for (const auto t : threads) thread_column->Append(t);
  auto value_column = std::make_shared<clickhouse::ColumnInt64>();
  for (const auto v : values) value_column->Append(v);
  return block_of({{"host_name", strings(hosts)}, {"current_time", strings(hosts)}, {"thread_id", thread_column}, {"type", type_column}, {"name", strings(names)}, {"value", value_column}});
}

void test_the_profile_events_of_a_run() {
  RunProfile profile;
  CHECK(!profile.cpu_time_available && profile.current_mem_bytes == -1 && profile.peak_mem_bytes == -1);
  // Only the aggregate of the query group (thread 0) counts: increments add up, gauges are the last value of a host.
  CHECK(profile.apply(profile_block({"a", "a", "a", "a", "b"}, {0, 0, 5, 0, 0}, {"increment", "increment", "increment", "gauge", "gauge"},
                                    {"UserTimeMicroseconds", "SystemTimeMicroseconds", "UserTimeMicroseconds", "MemoryTrackerUsage", "MemoryTrackerUsage"},
                                    {100, 30, 9999, 1000, 500})));
  CHECK(profile.cpu_time_available);
  CHECK_EQ(profile.user_time_us_total, int64_t{100});
  CHECK_EQ(profile.system_time_us_total, int64_t{30});
  CHECK_EQ(profile.current_mem_bytes, int64_t{1500});
  CHECK_EQ(profile.peak_mem_bytes, int64_t{-1});
  CHECK(profile.apply(profile_block({"a", "b", "a"}, {0, 0, 0}, {"gauge", "gauge", "increment"}, {"MemoryTrackerUsage", "MemoryTrackerPeakUsage", "UserTimeMicroseconds"}, {700, 4000, 50})));
  CHECK_EQ(profile.current_mem_bytes, int64_t{1200});  // a: 700 (replaced), b: 500
  CHECK_EQ(profile.peak_mem_bytes, int64_t{4000});
  CHECK_EQ(profile.user_time_us_total, int64_t{150});
  // A negative gauge is 0, a negative increment adds nothing, an increment saturates, another event is ignored.
  CHECK(profile.apply(profile_block({"a", "a", "a"}, {0, 0, 0}, {"gauge", "increment", "increment"}, {"MemoryTrackerUsage", "UserTimeMicroseconds", "Other"}, {-5, -7, 1})));
  CHECK_EQ(profile.current_mem_bytes, int64_t{500});
  CHECK_EQ(profile.user_time_us_total, int64_t{150});
  CHECK(profile.apply(profile_block({"a"}, {0}, {"increment"}, {"UserTimeMicroseconds"}, {std::numeric_limits<int64_t>::max()})));
  CHECK_EQ(profile.user_time_us_total, std::numeric_limits<int64_t>::max());
  // A block without rows, or without the columns of the packet, is not read.
  CHECK(!profile.apply(profile_block({}, {}, {}, {}, {})));
  CHECK(!profile.apply(block_of({{"x", strings({"y"})}})));
  profile.reset();
  CHECK(!profile.cpu_time_available && profile.user_time_us_total == 0 && profile.current_mem_bytes == -1 && profile.memory_usage_by_host.empty());
}

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "--bench") == 0) return bench();
  test_scalars();
  test_nullable_and_low_cardinality();
  test_arrays_and_tuples();
  test_maps();
  test_value_contract();
  test_bool_is_true_or_false();
  test_declared_bool_is_true_or_false();
  test_utf8_helpers();
  test_many_rows_equal_the_reference();
  test_map_cells_are_read_in_place();
  test_block_encoder_encodes_every_block_in_order();
  test_block_encoder_bounds_the_queue();
  test_block_encoder_failure_reaches_the_receiving_thread();
  test_block_encoder_cancel_stops_a_waiting_submit();
  test_block_encoder_destructor_drops_what_waits();
  test_the_transport_of_a_type();
  test_the_wrapper_of_a_statement();
  test_the_answer_of_describe_is_a_plan();
  test_recent_plans_are_kept_for_a_while();
  test_a_result_is_meta_then_rows();
  test_a_result_stops_at_its_row_limit_and_its_cell_limit();
  test_the_profile_events_of_a_run();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
