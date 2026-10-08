// Unit tests of the path of a result to the browser: the JSON cell encoder (src/json_clickhouse.hpp)
// and the thread that encodes the blocks (src/block_encoder.hpp). The Query page rows, the exports,
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
// The Python harness (test_query_encoding_contract.py) runs it when RESULT_PATH_TEST_BINARY points at it.

#include "block_encoder.hpp"
#include "json_clickhouse.hpp"

#include <clickhouse/columns/date.h>
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
    const auto* mt = col->Type()->As<clickhouse::MapType>();
    const bool key_is_string = mt->GetKeyType()->GetCode() == Type::String || mt->GetKeyType()->GetCode() == Type::FixedString;
    if (key_is_string) {
      w.StartObject();
      for (size_t i = 0; i < items->Size(); ++i) {
        const auto key = pairs->At(0)->GetItem(i).get<std::string_view>();
        w.Key(key.data(), static_cast<rapidjson::SizeType>(key.size()));
        reference_write(w, pairs->At(1), i);
      }
      w.EndObject();
    } else {
      w.StartArray();
      for (size_t i = 0; i < items->Size(); ++i) {
        w.StartArray();
        reference_write(w, pairs->At(0), i);
        reference_write(w, pairs->At(1), i);
        w.EndArray();
      }
      w.EndArray();
    }
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
  check_column(number, {"0", "18446744073709551615"});

  auto real = make<clickhouse::ColumnFloat64>();
  real->Append(1.5);
  real->Append(std::numeric_limits<double>::quiet_NaN());
  check_column(real, {"1.5", "null"});

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
  // Map(String, String): a JSON object, the empty map included.
  auto keys = make<clickhouse::ColumnString>();
  auto values = make<clickhouse::ColumnString>();
  auto texts = std::make_shared<clickhouse::ColumnMapT<clickhouse::ColumnString, clickhouse::ColumnString>>(keys, values);
  texts->Append(std::map<std::string, std::string>{{"a", "1"}, {"b", "2"}});
  texts->Append(std::map<std::string, std::string>{});
  texts->Append(std::map<std::string, std::string>{{"k\"q", "v"}});
  check_column(texts, {"{\"a\":\"1\",\"b\":\"2\"}", "{}", "{\"k\\\"q\":\"v\"}"});

  // Map(UInt8, String): the key is not a string, so the map is an array of pairs.
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
  check_column(nested, {"{\"a\":[1,2],\"b\":[]}", "{}"});
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

int main(int argc, char** argv) {
  if (argc > 1 && std::strcmp(argv[1], "--bench") == 0) return bench();
  test_scalars();
  test_nullable_and_low_cardinality();
  test_arrays_and_tuples();
  test_maps();
  test_many_rows_equal_the_reference();
  test_map_cells_are_read_in_place();
  test_block_encoder_encodes_every_block_in_order();
  test_block_encoder_bounds_the_queue();
  test_block_encoder_failure_reaches_the_receiving_thread();
  test_block_encoder_cancel_stops_a_waiting_submit();
  test_block_encoder_destructor_drops_what_waits();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
