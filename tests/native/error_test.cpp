// This file has unit tests of the one error answer of the API (src/error_envelope.cpp, src/ch_error.cpp, src/api_error.cpp). The tests check the JSON
// envelope. They check the classification of a ClickHouse failure by its code, and the answer that each kind of failure gets.
// No ClickHouse is needed.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_ERROR_TESTS=ON
//        cmake --build build --target chdash_error_test
// Run:   ./build/chdash_error_test   (exit code 0 = every check passed)

#include "api_error.hpp"
#include "api_params.hpp"
#include "ch_error.hpp"
#include "ch_query.hpp"
#include "error_envelope.hpp"

#include <rapidjson/document.h>

#include <clickhouse/exceptions.h>

#include <cerrno>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <system_error>

using namespace chdash;

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

clickhouse::ServerException server_error(int code, const std::string& text) {
  auto exception = std::make_shared<clickhouse::Exception>();
  exception->code = code;
  exception->name = "DB::Exception";
  exception->display_text = text;
  return clickhouse::ServerException(exception);
}

rapidjson::Document parse(const std::string& json) {
  rapidjson::Document doc;
  doc.Parse(json.c_str(), json.size());
  CHECK(!doc.HasParseError() && doc.IsObject());
  return doc;
}

std::string str(const rapidjson::Document& doc, const char* key) {
  const auto it = doc.FindMember(key);
  return it != doc.MemberEnd() && it->value.IsString() ? std::string(it->value.GetString(), it->value.GetStringLength()) : "<none>";
}

void test_the_envelope() {
  ApiError error;
  error.status = 404;
  error.code = "trace_not_found";
  error.message = "No such trace: \"x\"\n";
  auto doc = parse(error_json(error));
  CHECK_EQ(str(doc, "error_code"), std::string("trace_not_found"));
  CHECK_EQ(str(doc, "message"), std::string("No such trace: \"x\"\n"));
  CHECK(doc["retryable"].IsBool() && !doc["retryable"].GetBool());
  // The code has one name. No second key uses it.
  CHECK(!doc.HasMember("error"));

  // The advice follows the status, unless the advice is set.
  for (const int status : {429, 503, 504}) {
    ApiError retry;
    retry.status = status;
    retry.code = "c";
    CHECK(parse(error_json(retry))["retryable"].GetBool());
  }
  for (const int status : {400, 403, 404, 409, 413, 422, 500, 502}) {
    ApiError no;
    no.status = status;
    no.code = "c";
    CHECK(!parse(error_json(no))["retryable"].GetBool());
  }
  ApiError set;
  set.status = 503;
  set.code = "c";
  set.retryable = false;
  CHECK(!parse(error_json(set))["retryable"].GetBool());

  // This is what each case adds.
  ApiError rich;
  rich.status = 400;
  rich.code = "validation";
  rich.message = "bad";
  rich.text = {{"field", "name"}, {"reason", "too_long"}};
  rich.numbers = {{"revision", 7}};
  rich.query_id = "q-1";
  rich.index = 2;
  ClickHouseErrorLocation location;
  location.has_code = true;
  location.code = 62;
  location.has_position = true;
  location.position = 10;
  location.has_line_col = true;
  location.line = 1;
  location.col = 11;
  location.has_near = true;
  location.near = "FROM";
  rich.clickhouse = location;
  doc = parse(error_json(rich));
  CHECK_EQ(str(doc, "field"), std::string("name"));
  CHECK_EQ(str(doc, "reason"), std::string("too_long"));
  CHECK_EQ(doc["revision"].GetInt64(), int64_t(7));
  CHECK_EQ(str(doc, "query_id"), std::string("q-1"));
  CHECK_EQ(doc["index"].GetInt(), 2);
  CHECK_EQ(doc["clickhouse"]["code"].GetInt(), 62);
  CHECK_EQ(doc["clickhouse"]["col"].GetInt(), 11);
  CHECK_EQ(str(doc, "error_code"), std::string("validation"));

  // A text that holds a NUL byte or invalid UTF-8 stays valid JSON. The text stays whole.
  ApiError raw;
  raw.status = 500;
  raw.code = "c";
  raw.message = std::string("a\0b\xff", 4);
  doc = parse(error_json(raw));
  CHECK_EQ(std::string(doc["message"].GetString(), doc["message"].GetStringLength()), std::string("a\0b\xEF\xBF\xBD", 6));

  // A ClickHouse refusal for lack of a grant states this in members of its own.
  ApiError denied;
  denied.status = 403;
  denied.code = "logs_not_granted";
  denied.message = "DB::Exception: chdash_system: Not enough privileges. To execute this query, it's necessary to have the grant SELECT ON otel.otel_logs. (ACCESS_DENIED)";
  doc = parse(error_json(denied));
  CHECK_EQ(str(doc, "reason"), std::string("not_granted"));
  CHECK_EQ(str(doc, "user"), std::string("chdash_system"));
  CHECK_EQ(str(doc, "grant"), std::string("SELECT ON otel.otel_logs"));
  CHECK(str(doc, "hint").find("GRANT SELECT ON otel.otel_logs TO chdash_system") != std::string::npos);
}

void test_the_classification_is_by_code() {
  const auto kind = [](int code) { return classify_clickhouse_error(server_error(code, "x")).kind; };
  CHECK(kind(159) == ChErrorKind::Timeout);
  CHECK(kind(158) == ChErrorKind::ScanLimit);
  CHECK(kind(307) == ChErrorKind::ScanLimit);
  CHECK(kind(396) == ChErrorKind::ScanLimit);
  CHECK(kind(241) == ChErrorKind::MemoryLimit);
  CHECK(kind(497) == ChErrorKind::AccessDenied);
  CHECK(kind(164) == ChErrorKind::ReadOnly);
  CHECK(kind(394) == ChErrorKind::Canceled);
  CHECK(kind(735) == ChErrorKind::Canceled);
  CHECK(kind(202) == ChErrorKind::Unavailable);
  CHECK(kind(60) == ChErrorKind::NotFound);
  CHECK(kind(47) == ChErrorKind::NotFound);
  CHECK(kind(62) == ChErrorKind::BadQuery);
  CHECK(kind(1) == ChErrorKind::Other);
  // The words of the message decide nothing. A text that says TIMEOUT_EXCEEDED under another code is another code.
  CHECK(classify_clickhouse_error(server_error(1, "Code: 159. TIMEOUT_EXCEEDED: Timeout exceeded")).kind == ChErrorKind::Other);
  CHECK(classify_clickhouse_error(server_error(159, "nothing to see")).kind == ChErrorKind::Timeout);
  // These failures did not come from the server.
  CHECK(classify_clickhouse_error(ChQueryCanceled()).kind == ChErrorKind::Canceled);
  CHECK(classify_clickhouse_error(std::system_error(ETIMEDOUT, std::system_category(), "recv")).kind == ChErrorKind::Timeout);
  CHECK(classify_clickhouse_error(std::system_error(EAGAIN, std::system_category(), "recv")).kind == ChErrorKind::Timeout);
  CHECK(classify_clickhouse_error(std::system_error(ECONNRESET, std::system_category(), "recv")).kind == ChErrorKind::Unavailable);
  CHECK(classify_clickhouse_error(clickhouse::ProtocolError("fail to receive data packet")).kind == ChErrorKind::Unavailable);
  CHECK(classify_clickhouse_error(std::runtime_error("a bug")).kind == ChErrorKind::Other);
  CHECK_EQ(classify_clickhouse_error(server_error(159, "x")).code, 159);
}

void test_the_answer_of_each_failure() {
  const auto answer = [](const std::exception& e) { return error_from_clickhouse(e, "logs", "logs_search_failed"); };
  auto timeout = answer(server_error(159, "Timeout exceeded: elapsed 30 s"));
  CHECK_EQ(timeout.status, 504);
  CHECK_EQ(timeout.code, std::string("logs_timeout"));
  CHECK(error_json(timeout).find("\"retryable\":true") != std::string::npos);
  auto limit = answer(server_error(158, "Limit for rows"));
  CHECK_EQ(limit.status, 422);
  CHECK_EQ(limit.code, std::string("logs_scan_limit"));
  CHECK_EQ(answer(server_error(307, "Limit for bytes")).code, std::string("logs_scan_limit"));
  CHECK_EQ(answer(server_error(241, "Memory limit")).code, std::string("logs_memory_limit"));
  CHECK_EQ(answer(server_error(241, "Memory limit")).status, 422);
  auto denied = answer(server_error(497, "DB::Exception: u: Not enough privileges. To execute this query, it's necessary to have the grant SELECT ON a.b. (ACCESS_DENIED)"));
  CHECK_EQ(denied.status, 503);
  CHECK_EQ(denied.code, std::string("logs_not_granted"));
  auto canceled = answer(ChQueryCanceled());
  CHECK_EQ(canceled.status, 499);
  CHECK_EQ(canceled.code, std::string("canceled"));
  auto down = answer(std::system_error(ECONNREFUSED, std::system_category(), "connect"));
  CHECK_EQ(down.status, 503);
  CHECK_EQ(down.code, std::string("host_unavailable"));
  CHECK(error_json(down).find("\"retryable\":true") != std::string::npos);
  // Anything else keeps the code of the route. 503 is for a refusal of ClickHouse, and 500 is for a fault of ChDash.
  auto other = answer(server_error(1, "something else"));
  CHECK_EQ(other.status, 503);
  CHECK_EQ(other.code, std::string("logs_search_failed"));
  CHECK(error_json(other).find("\"retryable\":false") != std::string::npos);
  auto bug = answer(std::runtime_error("bad cast"));
  CHECK_EQ(bug.status, 500);
  CHECK_EQ(bug.code, std::string("logs_search_failed"));
  // The area names the page in the code.
  CHECK_EQ(error_from_clickhouse(server_error(159, "x"), "trace", "x").code, std::string("trace_timeout"));
  CHECK_EQ(error_from_clickhouse(server_error(159, "x"), "metrics", "x").code, std::string("metrics_timeout"));

  // The same failure gets the same status and code on every page.
  for (const char* area : {"logs", "trace", "metrics", "signal"}) {
    CHECK_EQ(error_from_clickhouse(server_error(159, "x"), area, "f").status, 504);
    CHECK_EQ(error_from_clickhouse(server_error(158, "x"), area, "f").status, 422);
  }

  // The answer on the wire.
  httplib::Response res;
  send_error(res, timeout);
  CHECK_EQ(res.status, 504);
  CHECK_EQ(res.get_header_value("Cache-Control"), std::string("no-store"));
  CHECK_EQ(res.get_header_value("Content-Type"), std::string("application/json"));
  httplib::Response plain;
  json_error(plain, 404, "unknown_host", "no such host");
  CHECK_EQ(std::string(parse(plain.body)["error_code"].GetString()), std::string("unknown_host"));
}

void test_the_parameters_of_a_route() {
  // A number is the whole text.
  CHECK(parse_whole_i64("123") == std::optional<int64_t>(123));
  CHECK(parse_whole_i64("-5") == std::optional<int64_t>(-5));
  CHECK(parse_whole_i64("+7") == std::optional<int64_t>(7));
  for (const char* text : {"", "-", "+", "123abc", " 12", "12 ", "1.5", "1e3", "0x10", "99999999999999999999", "--1"}) CHECK(!parse_whole_i64(text));
  CHECK(parse_whole_i64("9223372036854775807") == std::optional<int64_t>(INT64_MAX));
  CHECK(!parse_whole_i64("9223372036854775808"));
  CHECK(parse_whole_double("1.5") == std::optional<double>(1.5));
  CHECK(parse_whole_double("-2e3") == std::optional<double>(-2000.0));
  CHECK(parse_whole_double(".5") == std::optional<double>(0.5));
  for (const char* text : {"", "abc", "1.5x", " 1", "inf", "nan", "0x1p3", "1e999", "-"}) CHECK(!parse_whole_double(text));

  // A name that the route does not read gets a 400 status.
  httplib::Request req;
  req.params.emplace("host_id", "local");
  req.params.emplace("refresh", "1");
  httplib::Response ok;
  CHECK(!refuse_unknown_params(req, ok, {"host_id", "refresh"}));
  CHECK_EQ(ok.status, -1);
  req.params.emplace("bogus", "1");
  httplib::Response refused;
  CHECK(refuse_unknown_params(req, refused, {"host_id", "refresh"}));
  CHECK_EQ(refused.status, 400);
  CHECK_EQ(std::string(parse(refused.body)["error_code"].GetString()), std::string("unknown_parameter"));
  CHECK(std::string(parse(refused.body)["message"].GetString()).find("bogus") != std::string::npos);
}

} // namespace

int main() {
  test_the_envelope();
  test_the_classification_is_by_code();
  test_the_answer_of_each_failure();
  test_the_parameters_of_a_route();
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
