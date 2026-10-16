// These are unit tests of the Logs page below its routes.
// The tests cover the text search and the patterns (src/logs_text.cpp, src/logs_drain.cpp, src/logs_patterns.cpp).
// They also cover the parsing of a request (src/logs_request.cpp), the filters (src/logs_filters.cpp), and the statements (src/logs_sql.cpp).
// They cover the service on a fake executor with its JSON (src/logs_service.cpp, src/logs_json.cpp).
// The tests do not use a ClickHouse server.
//
// The tests compare the statements with the statements that the code before the split of src/api_logs.cpp sent.
// That code sent them for the requests of a differential battery (logs_golden.hpp, the text with each query parameter written in place).
// A statement that changes its text fails here.
// Make sure that a change on purpose also changes the expected text in the same commit.
// The first tests were checked against the code of api_logs.cpp before the text search and the patterns were separated into other files.
// A differential run on 20,000 generated messages gave the same tokens, terms, SQL, masks, templates and cluster ids.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_LOGS_TESTS=ON
//        cmake --build build --target chdash_logs_test
// Run:   ./build/chdash_logs_test   (exit code 0 = every check passed)
#include "api_error.hpp"
#include "ch_error.hpp"
#include "fake_executor.hpp"
#include "logs_drain.hpp"
#include "logs_filters.hpp"
#include "logs_golden.hpp"
#include "logs_json.hpp"
#include "logs_patterns.hpp"
#include "logs_request.hpp"
#include "logs_service.hpp"
#include "logs_sql.hpp"
#include "logs_text.hpp"
#include "native_check.hpp"

#include <httplib.h>
#include <rapidjson/document.h>

#include <algorithm>
#include <functional>
#include <iostream>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using namespace chdash;
using namespace chdash::logs;
using namespace nt;

namespace {

using Strings = std::vector<std::string>;

std::string join(const Strings& parts) {
  std::string out;
  for (const auto& p : parts) out += (out.empty() ? "" : "|") + p;
  return out;
}

void test_tokens() {
  CHECK_EQ(join(split_tokens("analytics.events_buffer")), "analytics|events|buffer");
  CHECK_EQ(join(split_tokens("key=user:12")), "key|user|12");
  CHECK_EQ(join(split_tokens("  ")), "");
  CHECK_EQ(join(split_tokens("")), "");
  // Bytes of UTF-8 belong to tokens, as in the tokenbf_v1 index.
  CHECK_EQ(join(split_tokens("caf\xC3\xA9 ok")), "caf\xC3\xA9|ok");
  CHECK(token_byte('a') && token_byte('Z') && token_byte('7') && token_byte(0x80));
  CHECK(!token_byte('_') && !token_byte('-') && !token_byte(' ') && !token_byte('.'));
  CHECK_EQ(to_lower_ascii("AbC-\xC3\x89"), "abc-\xC3\x89");
}

std::string terms_text(const std::string& q) {
  std::string out;
  for (const auto& t : parse_terms(q)) out += std::string(out.empty() ? "" : " ") + (t.negate ? "!" : "") + "[" + t.text + "]";
  return out;
}

void test_terms() {
  CHECK_EQ(terms_text("error timeout"), "[error] [timeout]");
  CHECK_EQ(terms_text("  error   timeout  "), "[error] [timeout]");
  CHECK_EQ(terms_text("\"connection reset\" peer"), "[connection reset] [peer]");
  CHECK_EQ(terms_text("-debug error"), "![debug] [error]");
  CHECK_EQ(terms_text("-\"a b\""), "![a b]");
  // A dash alone, or before a space, is a term of its own text.
  CHECK_EQ(terms_text("- x"), "[-] [x]");
  // A phrase without its closing quote runs to the end.
  CHECK_EQ(terms_text("\"open phrase"), "[open phrase]");
  CHECK_EQ(terms_text("\"\""), "");
  CHECK_EQ(terms_text(""), "");
}

void test_term_sql() {
  {
    SqlParams p;
    const std::string sql = token_term_sql({"timeout", false}, false, p);
    CHECK_EQ(sql, "(hasToken(Body, {p1:String}))");
    CHECK_EQ(p.list().size(), size_t(1));
    CHECK_EQ(p.list()[0].second, "timeout");
  }
  {
    // A term with separators must also appear verbatim.
    SqlParams p;
    const std::string sql = token_term_sql({"analytics.events_buffer", false}, false, p);
    CHECK_EQ(sql, "(hasToken(Body, {p1:String}) AND hasToken(Body, {p2:String}) AND hasToken(Body, {p3:String}) AND position(Body, {p4:String}) > 0)");
    CHECK_EQ(p.list()[3].second, "analytics.events_buffer");
  }
  {
    // A negated term, on a lowercased index: the tokens are lowercased and the verbatim check ignores case.
    SqlParams p;
    const std::string sql = token_term_sql({"Key=User", true}, true, p);
    CHECK_EQ(sql, "NOT (hasToken(lower(Body), {p1:String}) AND hasToken(lower(Body), {p2:String}) AND positionCaseInsensitive(Body, {p3:String}) > 0)");
    CHECK_EQ(p.list()[0].second, "key");
    CHECK_EQ(p.list()[1].second, "user");
    CHECK_EQ(p.list()[2].second, "Key=User");
  }
  {
    // The text of a user never reaches the statement.
    SqlParams p;
    const std::string sql = token_term_sql({"x') OR 1=1 --", false}, false, p);
    CHECK(sql.find("OR 1=1") == std::string::npos);
  }
  {
    SqlParams p;
    CHECK_EQ(substring_term_sql({"100%_ok", false}, p), "Body ILIKE {p1:String}");
    CHECK_EQ(p.list()[0].second, "%100\\%\\_ok%");
    SqlParams q;
    CHECK_EQ(substring_term_sql({"x", true}, q), "Body NOT ILIKE {p1:String}");
  }
}

void test_mask() {
  CHECK_EQ(mask_body("user 12345 logged in"), "user <*> logged in");
  CHECK_EQ(mask_body("v1 stays and 2 goes"), "v1 stays and <*> goes");
  CHECK_EQ(mask_body("took 12.5ms"), "took 12.5ms");
  CHECK_EQ(mask_body("took 12.5 ms"), "took <*> ms");
  CHECK_EQ(mask_body("from 10.0.0.12 port 80"), "from <*> port <*>");
  CHECK_EQ(mask_body("id 123e4567-e89b-12d3-a456-426614174000 done"), "id <*> done");
  CHECK_EQ(mask_body("trace 0af7651916cd43dd8448eb211c80319c end"), "trace <*> end");
  CHECK_EQ(mask_body("name \"alice\" and 'bob'"), "name <*> and <*>");
  // A quote glued to a word is not a string.
  CHECK_EQ(mask_body("don't panic"), "don't panic");
  // Two parameters next to each other become one.
  CHECK_EQ(mask_body("1 2 3"), "<*> <*> <*>");
  CHECK_EQ(mask_body("\"a\"\"b\""), "<*>");
  // The text is cut at 2,048 bytes.
  CHECK_EQ(mask_body(std::string(5000, 'x')).size(), size_t(2048));
  CHECK_EQ(mask_body(""), "");
}

void test_tokens_of_a_message() {
  CHECK_EQ(join(whitespace_tokens("a  b\tc\nd")), "a|b|c|d");
  CHECK_EQ(whitespace_tokens(std::string(500, 'x') + " y").size(), size_t(2));
  std::string many;
  for (int i = 0; i < 100; ++i) many += "w" + std::to_string(i) + " ";
  CHECK_EQ(whitespace_tokens(many).size(), size_t(64));
}

void test_pattern_search_text() {
  CHECK_EQ(pattern_search_text({"user", kParam, "logged", "in"}), "user logged in");
  CHECK_EQ(pattern_search_text({"key=user:<*>"}), "key=user:");
  CHECK_EQ(pattern_search_text({kParam, kParam}), "");
  CHECK_EQ(pattern_search_text({"a<*>b"}), "a b");
  // A piece that starts with a dash is read as a negation, so it is quoted.
  CHECK_EQ(pattern_search_text({"-flag"}), "\"-flag\"");
  Strings many;
  for (int i = 0; i < 40; ++i) many.push_back("w" + std::to_string(i));
  size_t spaces = 0;
  for (char c : pattern_search_text(many)) spaces += c == ' ';
  CHECK_EQ(spaces, kMaxTextTerms - 1);
}

void test_drain() {
  Drain drain;
  const auto add = [&](const std::string& message) { return drain.add(whitespace_tokens(mask_body(message))); };
  const size_t a = add("user 1 logged in from host-a");
  const size_t b = add("user 2 logged in from host-b");
  CHECK_EQ(a, b);
  CHECK_EQ(drain.clusters().size(), size_t(1));
  CHECK_EQ(join(drain.clusters()[a].tokens), "user|<*>|logged|in|from|<*>");
  CHECK_EQ(drain.clusters()[a].size, size_t(2));
  // A message with another length belongs to another cluster.
  // So does a message with other words.
  const size_t c = add("disk full");
  CHECK(c != a);
  const size_t d = add("completely different words here and there");
  CHECK(d != a && d != c);
  CHECK_EQ(drain.clusters().size(), size_t(3));
  // The same message joins its cluster again.
  CHECK_EQ(add("disk full"), c);
  CHECK_EQ(drain.clusters()[c].size, size_t(2));
}

void test_drain_bounds() {
  // Messages of one length that start alike share a leaf.
  // Past 50 clusters, a message joins the nearest one.
  Drain drain;
  for (int i = 0; i < 400; ++i) {
    Strings tokens = {"same", "start"};
    for (int k = 0; k < 6; ++k) tokens.push_back("w" + std::to_string((i * 7 + k * 13) % 97) + "x");
    drain.add(tokens);
  }
  CHECK(drain.clusters().size() <= 400);
  size_t total = 0;
  for (const auto& c : drain.clusters()) total += c.size;
  CHECK_EQ(total, size_t(400));
  // A node keeps at most 100 children, even when there are many different first words.
  // The other words go to the wildcard child.
  Drain wide;
  for (int i = 0; i < 300; ++i) wide.add({"first" + std::string(1, static_cast<char>('a' + i % 26)) + std::to_string(i / 26), "second", "third", "fourth"});
  size_t sum = 0;
  for (const auto& c : wide.clusters()) sum += c.size;
  CHECK_EQ(sum, size_t(300));
}

void test_severity() {
  CHECK_EQ(severity_index(0), 3);
  CHECK_EQ(severity_index(8), 3);
  CHECK_EQ(severity_index(9), 2);
  CHECK_EQ(severity_index(12), 2);
  CHECK_EQ(severity_index(13), 1);
  CHECK_EQ(severity_index(16), 1);
  CHECK_EQ(severity_index(17), 0);
  CHECK_EQ(severity_index(24), 0);
}

// ---- the request, the filters and the statements ----

using Params = std::initializer_list<std::pair<const char*, const char*>>;

httplib::Request request(Params params) {
  httplib::Request req;
  req.method = "GET";
  for (const auto& [name, value] : params) req.params.emplace(name, value);
  return req;
}

// The window of the battery of the differential check is the newest day of the fixture.
constexpr int64_t kEnd = 1789867360999LL;
constexpr int64_t kMinute = 60000LL;
constexpr int64_t kHour = 3600000LL;
const std::string kEndText = std::to_string(kEnd);
const std::string kStart5m = std::to_string(kEnd - 5 * kMinute), kStart15m = std::to_string(kEnd - 15 * kMinute);
const std::string kStart2h = std::to_string(kEnd - 2 * kHour), kStart24h = std::to_string(kEnd - 24 * kHour);
constexpr int64_t kAnchorTs = 1789867360999943310LL;
constexpr uint64_t kAnchorTie = 7456462416301115329ULL;
const std::string kTrace = "000000000000000000000000017d7650";

// A statement with every {pN:String} written in place as a quoted text.
// The numbering of the parameters is not part of the text.
std::string inlined(const SqlStatement& statement) {
  std::string out = statement.sql;
  for (const auto& [name, value] : statement.params.list()) {
    std::string quoted = "'";
    for (const char c : value) {
      if (c == '\\' || c == '\'') quoted.push_back('\\');
      quoted.push_back(c);
    }
    quoted += "'";
    const std::string mark = "{" + name + ":String}";
    for (size_t at = out.find(mark); at != std::string::npos; at = out.find(mark, at + quoted.size())) out.replace(at, mark.size(), quoted);
  }
  return out;
}

// The table of the fixture has every optional column, the three attribute maps, and a tokenbf_v1 index on Body.
LogsSchema fixture_schema() {
  LogsSchema schema;
  schema.exists = schema.timestamp_time = schema.trace_id = schema.span_id = schema.trace_flags = true;
  schema.scope_name = schema.scope_version = true;
  schema.log_attributes = schema.resource_attributes = schema.scope_attributes = true;
  schema.log_attributes_map = schema.resource_attributes_map = schema.scope_attributes_map = true;
  schema.body_token_index = true;
  return schema;
}

OtelSettings otel_settings() {
  OtelSettings otel;
  otel.logs.enabled = true;
  return otel;
}

const std::string kTable = "`otel`.`otel_logs`";

LogsQuery query_from(const httplib::Request& req, bool need_range = true, int64_t now = 1791701739757LL) {
  LogsQuery query;
  ApiError error;
  CHECK(build_filters(otel_settings(), fixture_schema(), parse_filter_input(req), now, need_range, &query, &error));
  return query;
}

LogsQuery query_of(Params params, bool need_range = true, int64_t now = 1791701739757LL) { return query_from(request(params), need_range, now); }

// The range of the battery has other parameters.
// The tests build this request from strings that outlive it.
httplib::Request ranged(const std::string& start, std::vector<std::pair<std::string, std::string>> extra = {}) {
  httplib::Request req;
  req.method = "GET";
  req.params.emplace("start_ms", start);
  req.params.emplace("end_ms", kEndText);
  for (const auto& [name, value] : extra) req.params.emplace(name, value);
  return req;
}

ApiError filter_error(Params params, bool need_range = true, const LogsSchema& schema = fixture_schema(), const OtelSettings& otel = otel_settings()) {
  LogsQuery query;
  ApiError error;
  CHECK(!build_filters(otel, schema, parse_filter_input(request(params)), 1791701739757LL, need_range, &query, &error));
  return error;
}

// The service asks for this first window of a search: the newest 15 minutes of the range.
// The window starts after the cursor when there is one.
SqlStatement first_window(const LogsQuery& q, size_t limit, const std::string& cursor_value = "") {
  const int64_t range_lo = q.start_ms * 1000000, range_hi = q.end_ms * 1000000 + 999999;
  Cursor cursor;
  const bool has = !cursor_value.empty() && parse_cursor(cursor_value, &cursor);
  const int64_t hi = has ? std::min(range_hi, cursor.ts_ns) : range_hi;
  const int64_t lo = std::max<int64_t>(range_lo, hi - kSearchWindowsSeconds[0] * int64_t{1000000000} + 1);
  return search_statement(fixture_schema(), kTable, q, lo, hi, has ? std::optional<Cursor>(cursor) : std::nullopt, limit, kMaxExecutionSeconds);
}

void test_the_filters_of_a_request() {
  const FilterInput input = parse_filter_input(request({{"start_ms", "10"}, {"end_ms", "20"}, {"lookback_minutes", "x"}, {"service", "b"},
                                                         {"service", "a"}, {"service", "b"}, {"service", ""}, {"severity_min", "13"},
                                                         {"severity", "warn"}, {"trace_id", "ab"}, {"attr", "k=v"}, {"attr", "j!=w"}, {"q", "slow op"}}));
  CHECK(input.start_ms && *input.start_ms == 10);
  CHECK(input.end_ms && *input.end_ms == 20);
  CHECK(!input.lookback_minutes);
  // The repeated parameters are sorted.
  // Duplicates and empty values are removed.
  CHECK_EQ(join(input.services), "a|b");
  CHECK_EQ(join(input.attrs), "j!=w|k=v");
  CHECK_EQ(input.severity_min, "13");
  CHECK_EQ(join(input.severities), "warn");
  CHECK_EQ(input.trace_id, "ab");
  CHECK_EQ(input.q, "slow op");
  // A number is the whole text of its parameter.
  CHECK(!parse_filter_input(request({{"start_ms", "10abc"}})).start_ms);
  CHECK(!parse_filter_input(request({{"start_ms", " 10"}})).start_ms);
  CHECK_EQ(clamp_or(std::nullopt, 7, 1, 9), 7);
  CHECK_EQ(clamp_or(int64_t{100}, 7, 1, 9), 9);
  CHECK_EQ(clamp_or(int64_t{-4}, 7, 1, 9), 1);
  CHECK_EQ(clamp_or(int64_t{5}, 7, 1, 9), 5);

  // The picker of the services reads the range only.
  const ServicesRequest services = parse_services(request({{"start_ms", "1"}, {"end_ms", "2"}, {"service", "x"}, {"q", "y"}, {"severity_min", "5"}}));
  CHECK(services.filter.start_ms && services.filter.services.empty() && services.filter.q.empty() && services.filter.severity_min.empty());

  const SearchRequest search = parse_search(request({{"limit", "50"}, {"cursor", "5-6"}}));
  CHECK(search.limit && *search.limit == 50);
  CHECK_EQ(search.cursor, "5-6");
  const ContextRequest context = parse_context(request({{"ts_ns", "9"}, {"tie", "8"}, {"preset", "host"}, {"host", "h"}, {"window_ms", "1000"}}));
  CHECK_EQ(context.ts_ns, "9");
  CHECK_EQ(context.preset, "host");
  CHECK(context.window_ms && !context.limit);
}

void test_the_filters_of_a_field_leave_out_the_field_itself() {
  ApiError error;
  FacetValuesRequest out;
  // A bare key is the filter of either map.
  // A prefixed key is the filter of its own map only.
  CHECK(parse_facet_values(request({{"scope", "log"}, {"key", "http.route"}, {"attr", "http.route=/a"}, {"attr", "host.name=h"},
                                    {"attr", "LogAttributes.http.route!=/b"}, {"attr", "ResourceAttributes.http.route=/c"}}), &out, &error));
  CHECK_EQ(join(out.filter.attrs), "ResourceAttributes.http.route=/c|host.name=h");
  CHECK(parse_facet_values(request({{"scope", "scope"}, {"key", "x"}, {"attr", "x=1"}, {"attr", "ScopeAttributes.x=2"}}), &out, &error));
  CHECK_EQ(join(out.filter.attrs), "x=1");
  CHECK(parse_facet_values(request({{"scope", "resource"}, {"key", "host.name"}, {"attr", "host.name=h"}, {"attr", "ResourceAttributes.host.name=i"}}), &out, &error));
  CHECK(out.filter.attrs.empty());
  // A column has its own filter.
  // ServiceName also has the service filter.
  CHECK(parse_facet_values(request({{"scope", "column"}, {"key", "ServiceName"}, {"service", "a"}, {"attr", "ServiceName=b"}, {"attr", "ScopeName=c"}}), &out, &error));
  CHECK(out.filter.services.empty());
  CHECK_EQ(join(out.filter.attrs), "ScopeName=c");
  CHECK(parse_facet_values(request({{"scope", "column"}, {"key", "SeverityText"}, {"service", "a"}}), &out, &error));
  CHECK_EQ(join(out.filter.services), "a");

  CHECK(!parse_facet_values(request({{"scope", "bogus"}, {"key", "x"}}), &out, &error));
  CHECK_EQ(error.status, 400);
  CHECK_EQ(error.code, std::string("invalid_logs_facet"));
  CHECK_EQ(error.message, std::string("scope must be log, resource, scope or column."));
  CHECK(!parse_facet_values(request({{"scope", "log"}}), &out, &error));
  CHECK_EQ(error.message, std::string("key must be 1 to 512 bytes."));
  const std::string long_key(513, 'k');
  CHECK(!parse_facet_values(request({{"scope", "log"}, {"key", long_key.c_str()}}), &out, &error));
  CHECK(!parse_facet_values(request({{"scope", "column"}, {"key", "Body"}}), &out, &error));
  CHECK_EQ(error.message, std::string("column must be ServiceName, SeverityText, ScopeName or ScopeVersion."));
}

void test_a_request_that_the_schema_or_the_limits_refuse() {
  ApiError error = filter_error({{"start_ms", "1000"}});
  CHECK_EQ(error.status, 400);
  CHECK_EQ(error.code, std::string("invalid_logs_range"));
  CHECK_EQ(error.message, std::string("start_ms and end_ms must be provided together."));
  CHECK_EQ(filter_error({{"start_ms", "5"}, {"end_ms", "3"}}).message, std::string("Invalid logs time range."));
  CHECK_EQ(filter_error({{"start_ms", "-5"}, {"end_ms", "10"}}).message, std::string("Invalid logs time range."));
  CHECK_EQ(filter_error({{"start_ms", "5"}, {"end_ms", "5"}}).message, std::string("Invalid logs time range."));
  CHECK_EQ(filter_error({{"start_ms", "5"}, {"end_ms", "9223372036854775"}}).message, std::string("Invalid logs time range."));
  const std::string wide = std::to_string(kEnd - 30 * 24 * kHour);
  CHECK_EQ(filter_error({{"start_ms", wide.c_str()}, {"end_ms", kEndText.c_str()}}).message,
           std::string("Logs time range exceeds logs.max_lookback_minutes."));
  CHECK_EQ(filter_error({{"severity_min", "99"}}).code, std::string("invalid_logs_filter"));
  CHECK_EQ(filter_error({{"severity_min", "abc"}}).message, std::string("severity_min must be a SeverityNumber between 0 and 24."));
  CHECK_EQ(filter_error({{"severity", "loud"}}).message, std::string("severity must be error, warn, info or debug."));
  CHECK_EQ(filter_error({{"trace_id", "xyz"}}).message, std::string("trace_id must be a hexadecimal trace id."));
  const std::string long_id(65, 'a');
  CHECK_EQ(filter_error({{"trace_id", long_id.c_str()}}).message, std::string("trace_id must be a hexadecimal trace id."));
  CHECK_EQ(filter_error({{"span_id", "g"}}).message, std::string("span_id must be a hexadecimal span id."));
  CHECK_EQ(filter_error({{"attr", "novalue"}}).message, std::string("attr filters are key=value or key!=value."));
  CHECK_EQ(filter_error({{"attr", "=v"}}).message, std::string("attr filters are key=value or key!=value."));
  CHECK_EQ(filter_error({{"attr", "!=v"}}).message, std::string("attr filters need a key."));
  CHECK_EQ(filter_error({{"attr", "LogAttributes.=v"}}).message, std::string("Attribute maps are not available for LogAttributes.."));
  httplib::Request req;
  for (int i = 0; i < 17; ++i) req.params.emplace("attr", "k" + std::to_string(i) + "=v");
  LogsQuery query;
  CHECK(!build_filters(otel_settings(), fixture_schema(), parse_filter_input(req), 1, false, &query, &error));
  CHECK_EQ(error.message, std::string("Too many attribute filters."));

  // The schema decides what a table can be asked.
  LogsSchema bare = fixture_schema();
  bare.trace_id = false;
  bare.scope_name = false;
  bare.log_attributes = bare.resource_attributes = bare.scope_attributes = false;
  CHECK_EQ(filter_error({{"trace_id", "ab"}}, false, bare).message, std::string("trace_id must be a hexadecimal trace id."));
  CHECK_EQ(filter_error({{"attr", "TraceId=ab"}}, false, bare).message, std::string("Column TraceId is not in the logs table."));
  CHECK_EQ(filter_error({{"attr", "ScopeName=ab"}}, false, bare).message, std::string("Column ScopeName is not in the logs table."));
  CHECK_EQ(filter_error({{"attr", "k=v"}}, false, bare).message, std::string("Attribute maps are not available for k."));
  // A search of the text can be off.
  OtelSettings off = otel_settings();
  off.logs.body_search = "off";
  const ApiError disabled = filter_error({{"q", "slow"}}, false, fixture_schema(), off);
  CHECK_EQ(disabled.code, std::string("logs_body_search_disabled"));
  // No range is needed by the context.
  CHECK(!query_of({}, false).text_search);
}

void test_the_lookback_is_the_range_when_there_is_no_range() {
  const int64_t now = 1791701739757LL;
  LogsQuery q = query_of({{"lookback_minutes", "5"}}, true, now);
  CHECK_EQ(q.end_ms, now);
  CHECK_EQ(q.start_ms, now - 5 * kMinute);
  q = query_of({}, true, now);
  CHECK_EQ(q.start_ms, now - 15 * kMinute);
  // A lookback stays within logs.max_lookback_minutes.
  q = query_of({{"lookback_minutes", "100000000"}}, true, now);
  CHECK_EQ(q.start_ms, now - int64_t{7 * 24 * 60} * kMinute);
  q = query_of({{"lookback_minutes", "0"}}, true, now);
  CHECK_EQ(q.start_ms, now - kMinute);
}

void test_the_schema_of_the_table() {
  std::map<std::string, std::string> columns = {{"Timestamp", "DateTime64(9)"}, {"ServiceName", "LowCardinality(String)"}, {"Body", "String"},
                                                {"SeverityNumber", "UInt8"}, {"SeverityText", "LowCardinality(String)"}};
  LogsSchema schema = schema_from_columns(columns);
  CHECK(schema.exists && !schema.timestamp_time && !schema.trace_id && !schema.log_attributes);
  columns["TimestampTime"] = "DateTime";
  columns["TraceId"] = "String";
  columns["LogAttributes"] = "Map(LowCardinality(String), String)";
  columns["ResourceAttributes"] = "JSON";
  columns["ScopeAttributes"] = "String";
  schema = schema_from_columns(columns);
  CHECK(schema.timestamp_time && schema.trace_id && !schema.span_id);
  // A JSON column can filter, but it is not faceted.
  // A String is neither.
  CHECK(schema.log_attributes && schema.log_attributes_map);
  CHECK(schema.resource_attributes && !schema.resource_attributes_map);
  CHECK(!schema.scope_attributes && !schema.scope_attributes_map);
  columns.erase("Body");
  CHECK(!schema_from_columns(columns).exists);
  CHECK(!schema_from_columns({}).exists);

  LogsSchema indexed;
  apply_skipping_indexes(&indexed, {{"minmax", "Body"}, {"bloom_filter", "Body"}});
  CHECK(!indexed.body_token_index && !indexed.body_lower_index);
  apply_skipping_indexes(&indexed, {{"tokenbf_v1", "lower(`Body`)"}});
  CHECK(!indexed.body_token_index && indexed.body_lower_index);
  // A lower(Body) index is preferred only when there is no exact-case index.
  apply_skipping_indexes(&indexed, {{"tokenbf_v1", "lower(Body)"}, {"text", "`Body`"}});
  CHECK(indexed.body_token_index && !indexed.body_lower_index);
}

void test_the_search_statements_are_unchanged() {
  CHECK_EQ(inlined(schema_columns_statement(otel_settings().logs)), std::string(golden::kSchemaColumns));
  CHECK_EQ(inlined(schema_indexes_statement(otel_settings().logs)), std::string(golden::kSchemaIndexes));
  CHECK_EQ(table_name(otel_settings().logs), kTable);
  CHECK_EQ(inlined(first_window(query_from(ranged(kStart5m)), 20)), std::string(golden::kSearchBasic));

  const auto sql_of = [&](std::vector<std::pair<std::string, std::string>> extra, size_t limit) {
    return inlined(first_window(query_from(ranged(kStart5m, std::move(extra))), limit));
  };
  CHECK_EQ(sql_of({{"service", "edge_gateway"}}, 20), std::string(golden::kSearchService));
  CHECK_EQ(sql_of({{"service", "edge_gateway"}, {"service", "api_service"}, {"service", "x'y"}}, 20), std::string(golden::kSearchServices));
  CHECK_EQ(sql_of({{"severity", "warn"}, {"severity", "error"}, {"severity", "fatal"}, {"severity", "warning"}}, 20),
           std::string(golden::kSearchSeverityClasses));
  CHECK_EQ(sql_of({{"severity", "trace"}, {"severity", "debug"}, {"severity", "info"}}, 20), std::string(golden::kSearchSeverityDebug));
  CHECK_EQ(sql_of({{"severity_min", "13"}}, 20), std::string(golden::kSearchSeverityMin));
  CHECK_EQ(sql_of({{"q", "-slow POST"}}, 20), std::string(golden::kSearchNegated));
  CHECK_EQ(sql_of({{"q", "it's a\\b"}}, 20), std::string(golden::kSearchQuote));
  CHECK_EQ(sql_of({{"q", "/v1/events 200"}}, 20), std::string(golden::kSearchPunct));
  CHECK_EQ(sql_of({{"attr", "http.route=/v1/events"}}, 20), std::string(golden::kSearchAttrBare));
  CHECK_EQ(sql_of({{"attr", "http.route!=/v1/events"}}, 20), std::string(golden::kSearchAttrNegated));
  CHECK_EQ(sql_of({{"attr", "LogAttributes.http.request.method=POST"}}, 20), std::string(golden::kSearchAttrLog));
  CHECK_EQ(sql_of({{"attr", "ResourceAttributes.host.name=edge-gateway-0"}}, 20), std::string(golden::kSearchAttrResource));
  CHECK_EQ(sql_of({{"attr", "ScopeAttributes.x=y"}}, 20), std::string(golden::kSearchAttrScope));
  CHECK_EQ(sql_of({{"attr", "ScopeName=edge_gateway"}}, 20), std::string(golden::kSearchAttrColumn));
  CHECK_EQ(sql_of({{"attr", "http.route=/v1/events"}, {"attr", "http.route=/v1/query"}, {"attr", "host.name!=x'y"}, {"attr", "ServiceName=api_service"}}, 20),
           std::string(golden::kSearchAttrMulti));
  CHECK_EQ(sql_of({{"attr", "k'e\\y=v'a\\l"}}, 20), std::string(golden::kSearchAttrQuote));

  // The first window is the newest slice of 15 minutes.
  // The other windows are wider and cover the same range.
  CHECK_EQ(inlined(first_window(query_from(ranged(kStart15m, {{"trace_id", kTrace}})), 50)), std::string(golden::kSearchTrace));
  CHECK_EQ(inlined(first_window(query_from(ranged(kStart15m, {{"span_id", "00000000bebb281c"}})), 50)), std::string(golden::kSearchSpan));
  const LogsQuery plain15 = query_from(ranged(kStart15m));
  const std::string tie_cursor = std::to_string(kAnchorTs) + "-" + std::to_string(kAnchorTie);
  CHECK_EQ(inlined(first_window(plain15, 10, tie_cursor)), std::string(golden::kSearchCursorTie));
  CHECK_EQ(inlined(first_window(plain15, 10, "1789867000000000000-0")), std::string(golden::kSearchCursorZero));
  CHECK_EQ(inlined(first_window(query_from(ranged(kStart2h, {{"q", "\"slow operation\" cache"}})), 20)), std::string(golden::kSearchPhrase));

  // The next windows get the budget that is left.
  // They also get the rows that the first window filled.
  const LogsQuery all = query_from(ranged(kStart2h, {{"q", "slow"}, {"severity_min", "9"}, {"service", "cache_service"}, {"trace_id", kTrace}, {"attr", "log.origin=span"}}));
  CHECK_EQ(inlined(first_window(all, 30)), std::string(golden::kSearchAllFirst));
  CHECK_EQ(inlined(search_statement(fixture_schema(), kTable, all, 1789862861000000000LL, 1789866460999999999LL, std::nullopt, 29, 12)),
           std::string(golden::kSearchAllSecond));
  CHECK_EQ(inlined(search_statement(fixture_schema(), kTable, all, 1789860160999000000LL, 1789862860999999999LL, std::nullopt, 29, 12)),
           std::string(golden::kSearchAllThird));
}

void test_the_cursor_and_the_keyset() {
  Cursor cursor;
  CHECK(parse_cursor("1789867360999943310-7456462416301115329", &cursor));
  CHECK_EQ(cursor.ts_ns, kAnchorTs);
  CHECK(cursor.tie == kAnchorTie);
  CHECK_EQ(cursor_text(cursor), std::string("1789867360999943310-7456462416301115329"));
  CHECK(!parse_cursor("abc", &cursor));
  CHECK(!parse_cursor("-5-3", &cursor));
  CHECK(!parse_cursor("5-x", &cursor));
  CHECK(!parse_cursor("5--3", &cursor));
  CHECK(!parse_cursor("5-", &cursor));
  CHECK(!parse_cursor("5 -3", &cursor));
  CHECK(parse_cursor("0-0", &cursor));
  uint64_t value = 0;
  CHECK(parse_u64("18446744073709551615", &value) && value == 18446744073709551615ULL);
  CHECK(!parse_u64("18446744073709551616", &value));
  CHECK(!parse_u64("-1", &value));
  CHECK(!parse_u64("", &value));
  CHECK_EQ(keyset_predicate("T", Cursor{5, 7}, true),
           std::string("(Timestamp < fromUnixTimestamp64Nano(toInt64(5)) OR (Timestamp = fromUnixTimestamp64Nano(toInt64(5)) AND T < 7))"));
  CHECK_EQ(keyset_predicate("T", Cursor{5, 7}, false),
           std::string("(Timestamp > fromUnixTimestamp64Nano(toInt64(5)) OR (Timestamp = fromUnixTimestamp64Nano(toInt64(5)) AND T > 7))"));
  // A table without TraceId and SpanId decides ties with the columns that it has.
  LogsSchema old = fixture_schema();
  old.trace_id = old.span_id = false;
  CHECK_EQ(tiebreak_expr(old), std::string("cityHash64(ServiceName, SeverityNumber, Body)"));
  CHECK(row_columns(old).find("'', '', toString(TraceFlags)") != std::string::npos);
  old.timestamp_time = false;
  CHECK(time_predicate(old, 1, 2).find("TimestampTime") == std::string::npos);
}

void test_the_histogram_statements_are_unchanged() {
  const auto bucket = [](const LogsQuery& q, int target, int64_t origin_raw) {
    const int64_t size = choose_bucket_ms(q.end_ms - q.start_ms, target);
    return std::make_pair(size, ((origin_raw % size) + size) % size);
  };
  const auto statement = [&](const LogsQuery& q, int target, int64_t origin_raw) {
    const auto [size, origin] = bucket(q, target, origin_raw);
    return inlined(histogram_statement(fixture_schema(), kTable, q, size, origin));
  };
  const LogsQuery h2 = query_from(ranged(kStart2h));
  CHECK_EQ(statement(h2, 80, 0), std::string(golden::kHistogramBasic));
  CHECK_EQ(statement(query_from(ranged(kStart24h)), 80, 0), std::string(golden::kHistogramW24));
  CHECK_EQ(statement(h2, 80, 1234567), std::string(golden::kHistogramOrigin));
  CHECK_EQ(statement(h2, 24, 3600000), std::string(golden::kHistogramAligned));
  CHECK_EQ(statement(query_from(ranged(kStart2h, {{"q", "slow"}})), 80, 0), std::string(golden::kHistogramText));
  CHECK_EQ(statement(query_from(ranged(kStart2h, {{"service", "api_service"}, {"severity", "error"}})), 80, 0), std::string(golden::kHistogramFilters));
  // A negative origin is brought into [0, size).
  CHECK_EQ(bucket(h2, 80, -1234567).second, int64_t{85433});

  // The sizes are: at least 1 s, the first candidate that is not smaller than the range over the target, and the grid.
  CHECK_EQ(choose_bucket_ms(1000, 80), int64_t{1000});
  CHECK_EQ(choose_bucket_ms(2 * kHour, 80), int64_t{120000});
  CHECK_EQ(choose_bucket_ms(kHour, 1), int64_t{3600000});
  CHECK_EQ(choose_bucket_ms(int64_t{4000} * 86400000, 10), int64_t{604800000});
  CHECK_EQ(grid_floor(1000, 300, 0), int64_t{900});
  CHECK_EQ(grid_floor(-1, 300, 0), int64_t{-300});
  CHECK_EQ(grid_floor(1000, 300, 50), int64_t{950});
  // A grid on whole seconds buckets TimestampTime.
  // Another grid buckets the precise column.
  CHECK(bucket_sql(fixture_schema(), 60000, 0).find("TimestampTime") != std::string::npos);
  CHECK(bucket_sql(fixture_schema(), 60000, 500).find("toUnixTimestamp64Milli(Timestamp)") != std::string::npos);
  CHECK(bucket_sql(fixture_schema(), 1500, 0).find("toUnixTimestamp64Milli(Timestamp)") != std::string::npos);
}

void test_the_context_statements_are_unchanged() {
  const LogsSchema schema = fixture_schema();
  const OtelSettings otel = otel_settings();
  const auto filter_of = [&](const ContextRequest& request_in, const std::string& preset, SqlParams* params) {
    std::string where;
    ApiError error;
    CHECK(build_context_filter(otel, schema, request_in, preset, &where, params, &error));
    return where;
  };
  const int64_t delta = 5 * kMinute * 1000000;
  const auto statements = [&](const ContextRequest& request_in, const std::string& preset, int64_t ts, std::optional<uint64_t> tie, int64_t delta_ns, size_t limit) {
    SqlParams params;
    const std::string where = filter_of(request_in, preset, &params);
    return std::make_pair(inlined(context_older_statement(schema, kTable, where, params, ts, tie, delta_ns, limit)),
                          inlined(context_newer_statement(schema, kTable, where, params, ts, tie, delta_ns, limit)));
  };
  ContextRequest anything;
  const auto basic = statements(anything, "anything", kAnchorTs, kAnchorTie, delta, 5);
  CHECK_EQ(basic.first, std::string(golden::kContextOlder));
  CHECK_EQ(basic.second, std::string(golden::kContextNewer));
  const auto no_tie = statements(anything, "anything", kAnchorTs, std::nullopt, delta, 5);
  CHECK_EQ(no_tie.first, std::string(golden::kContextNoTieOlder));
  CHECK_EQ(no_tie.second, std::string(golden::kContextNoTieNewer));
  ContextRequest service;
  service.service = "edge_gateway";
  CHECK_EQ(statements(service, "service", kAnchorTs, kAnchorTie, delta, 5).first, std::string(golden::kContextServiceOlder));
  ContextRequest host;
  host.host = "edge-gateway-0";
  CHECK_EQ(statements(host, "host", kAnchorTs, kAnchorTie, delta, 5).second, std::string(golden::kContextHostNewer));
  ContextRequest trace;
  trace.trace_id = kTrace;
  CHECK_EQ(statements(trace, "trace", kAnchorTs, kAnchorTie, delta, 5).first, std::string(golden::kContextTraceOlder));
  CHECK_EQ(statements(anything, "anything", kAnchorTs, kAnchorTie, int64_t{3600000} * 1000000, 200).first, std::string(golden::kContextWindowOlder));
  ContextRequest quoted;
  quoted.service = "a'b\\c";
  CHECK_EQ(statements(quoted, "service", kAnchorTs, std::nullopt, delta, 50).second, std::string(golden::kContextQuoteNewer));
  CHECK_EQ(statements(anything, "anything", 1000000000, uint64_t{1}, delta, 3).first, std::string(golden::kContextEarlyOlder));

  // What a preset needs.
  ApiError error;
  SqlParams params;
  std::string where;
  CHECK(!build_context_filter(otel, schema, anything, "service", &where, &params, &error));
  CHECK_EQ(error.status, 400);
  CHECK_EQ(error.code, std::string("invalid_logs_context"));
  CHECK_EQ(error.message, std::string("preset=service needs service."));
  CHECK(!build_context_filter(otel, schema, anything, "host", &where, &params, &error));
  CHECK_EQ(error.message, std::string("preset=host needs host (ResourceAttributes host.name)."));
  LogsSchema no_resource = schema;
  no_resource.resource_attributes = false;
  CHECK(!build_context_filter(otel, no_resource, host, "host", &where, &params, &error));
  CHECK(!build_context_filter(otel, schema, anything, "trace", &where, &params, &error));
  CHECK_EQ(error.message, std::string("preset=trace needs a hexadecimal trace_id."));
  ContextRequest bad_trace;
  bad_trace.trace_id = "zz";
  CHECK(!build_context_filter(otel, schema, bad_trace, "trace", &where, &params, &error));
  CHECK(!build_context_filter(otel, schema, anything, "bogus", &where, &params, &error));
  CHECK_EQ(error.message, std::string("preset must be anything, service, host or trace."));
  // The allowlist narrows every preset.
  OtelSettings listed = otel;
  listed.traces.service_allowlist = {"api*"};
  CHECK(build_context_filter(listed, schema, anything, "anything", &where, &params, &error));
  CHECK_EQ(where, std::string(" AND (startsWith(ServiceName, 'api'))"));
}

void test_the_other_statements_are_unchanged() {
  const LogsSchema schema = fixture_schema();
  const LogsQuery w15 = query_from(ranged(kStart15m));
  CHECK_EQ(inlined(patterns_count_statement(schema, kTable, w15)), std::string(golden::kPatternsCount));
  CHECK_EQ(inlined(patterns_sample_statement(schema, kTable, w15, 6876, 20000)), std::string(golden::kPatternsSampleAll));
  const LogsQuery w24 = query_from(ranged(kStart24h));
  CHECK_EQ(inlined(patterns_count_statement(schema, kTable, w24)), std::string(golden::kPatternsCountBig));
  CHECK_EQ(inlined(patterns_sample_statement(schema, kTable, w24, 1173, 40000)), std::string(golden::kPatternsSampleBlocks));
  CHECK_EQ(inlined(patterns_sample_statement(schema, kTable, query_from(ranged(kStart2h, {{"q", "slow"}})), 48603, 20000)),
           std::string(golden::kPatternsSampleText));
  // A read of every record has no block sample.
  CHECK(patterns_sample_statement(schema, kTable, w15, 0, 100).sql.find("_part") == std::string::npos);
  CHECK_EQ(sample_rate_ppm(17000000, 20000), uint64_t{1177});
  CHECK_EQ(sample_rate_ppm(1000000000000ULL, 100), uint64_t{1});
  CHECK_EQ(sample_rate_ppm(10001, 10000), uint64_t{999901});

  const LogsQuery w2 = query_from(ranged(kStart2h));
  CHECK_EQ(inlined(services_statement(schema, kTable, w2)), std::string(golden::kServicesBasic));
  // The picker of the services ignores the filters of the page.
  const ServicesRequest ignored = parse_services(ranged(kStart5m, {{"q", "slow"}, {"service", "api_service"}}));
  LogsQuery picker;
  ApiError error;
  CHECK(build_filters(otel_settings(), schema, ignored.filter, 0, true, &picker, &error));
  CHECK_EQ(inlined(services_statement(schema, kTable, picker)), std::string(golden::kServicesIgnoresFilters));

  // The facets are the keys of a window aligned to the minute, and the values of one field.
  const std::vector<std::string> scopes = {"log", "resource", "scope"};
  const std::vector<std::string> columns = {"ServiceName", "SeverityText", "ScopeName", "ScopeVersion"};
  const auto keys = [&](const LogsQuery& q) { return inlined(facet_keys_statement(schema, kTable, q, facet_window(q), scopes, columns)); };
  CHECK_EQ(keys(w15), std::string(golden::kFacetKeysBasic));
  CHECK_EQ(keys(query_from(ranged(kStart15m, {{"attr", "http.route=/v1/events"}}))), std::string(golden::kFacetKeysFilters));
  CHECK_EQ(keys(query_from(ranged(kStart15m, {{"q", "slow"}}))), std::string(golden::kFacetKeysText));
  const auto values = [&](std::vector<std::pair<std::string, std::string>> extra, const char* scope, const char* key) {
    FacetValuesRequest request_out;
    ApiError e;
    httplib::Request req = ranged(kStart15m, std::move(extra));
    req.params.emplace("scope", scope);
    req.params.emplace("key", key);
    CHECK(parse_facet_values(req, &request_out, &e));
    LogsQuery q;
    CHECK(build_filters(otel_settings(), schema, request_out.filter, 0, true, &q, &e));
    return inlined(facet_values_statement(schema, kTable, q, facet_window(q), scope, key, 10));
  };
  CHECK_EQ(values({}, "column", "ServiceName"), std::string(golden::kFacetValuesColumn));
  CHECK_EQ(values({}, "log", "http.route"), std::string(golden::kFacetValuesLog));
  CHECK_EQ(values({}, "resource", "host.name"), std::string(golden::kFacetValuesResource));
  CHECK_EQ(values({}, "log", "it's"), std::string(golden::kFacetValuesQuote));
  CHECK_EQ(values({{"attr", "LogAttributes.http.route=/v1/events"}, {"attr", "ResourceAttributes.host.name=edge-gateway-0"}}, "log", "http.route"),
           std::string(golden::kFacetValuesOwnPrefixed));
  CHECK_EQ(values({{"attr", "ScopeName=edge_gateway"}, {"attr", "ServiceName=edge_gateway"}}, "column", "ScopeName"),
           std::string(golden::kFacetValuesOwnColumn));
  CHECK_EQ(values({{"service", "api_service"}}, "column", "SeverityText"), std::string(golden::kFacetValuesOtherService));

  // The window of a facet is aligned to the minute, outward.
  const FacetWindow window = facet_window(query_of({{"start_ms", "61001"}, {"end_ms", "120000"}}));
  CHECK_EQ(window.start_ms, int64_t{60000});
  CHECK_EQ(window.end_ms, int64_t{120000});
  CHECK_EQ(facet_window(query_of({{"start_ms", "60000"}, {"end_ms", "120001"}})).end_ms, int64_t{180000});
  CHECK(facet_column_known("ScopeVersion") && !facet_column_known("Body"));
  LogsSchema thin = fixture_schema();
  thin.scope_name = false;
  CHECK(!facet_column_present(thin, "ScopeName") && facet_column_present(thin, "ServiceName"));
  thin.log_attributes_map = false;
  CHECK(!facet_map_present(thin, "log") && facet_map_present(thin, "resource") && !facet_map_present(thin, "column"));
  CHECK(facet_map_column("column") == nullptr);
  CHECK(facet_scope_rank("column") < facet_scope_rank("log") && facet_scope_rank("log") < facet_scope_rank("resource") &&
        facet_scope_rank("resource") < facet_scope_rank("scope"));
}

void test_the_severity_classes() {
  CHECK(severity_class("fatal") == severity_class("error"));
  CHECK(severity_class("warning") == severity_class("warn"));
  CHECK(severity_class("trace") == severity_class("debug"));
  CHECK(severity_class("loud") == nullptr);
  CHECK_EQ(std::string(severity_class("info")->name), std::string("info"));
  CHECK(valid_hex_id("abcDEF09", 32));
  CHECK(!valid_hex_id("", 32) && !valid_hex_id("g", 32) && !valid_hex_id(std::string(33, 'a'), 32));
}

// ---- the patterns of a sample ----

void test_the_patterns_of_a_sample() {
  std::vector<SampleRow> sample;
  for (int i = 0; i < 6; ++i) sample.push_back({1000 + i * 100, 9, i % 2 ? "api" : "web", "user " + std::to_string(i + 10) + " logged in"});
  for (int i = 0; i < 3; ++i) sample.push_back({1000 + i * 300, 17, "api", "disk full on /dev/sda" + std::to_string(i)});
  sample.push_back({2500, 13, "web", "cache slow"});
  const MinedPatterns mined = mine_patterns(sample, 1000, 1000, 4, 10, 1000, [] { return false; });
  CHECK(!mined.partial);
  CHECK_EQ(mined.mined, size_t(10));
  CHECK_EQ(mined.pattern_count, size_t(3));
  CHECK_EQ(mined.patterns.size(), size_t(3));
  CHECK_EQ(mined.scale, 100.0);
  // Largest first.
  const Pattern& first = mined.patterns[0];
  CHECK_EQ(first.text, std::string("user <*> logged in"));
  CHECK_EQ(first.sample_count, uint64_t(6));
  CHECK_EQ(first.count, uint64_t(600));
  CHECK_EQ(first.share, 0.6);
  CHECK(first.noisy);
  CHECK_EQ(first.sample, std::string("user 10 logged in"));
  CHECK_EQ(first.search, std::string("user logged in"));
  CHECK_EQ(first.service_count, uint64_t(2));
  CHECK_EQ(first.service, std::string("api"));
  CHECK_EQ(first.severity, std::string("info"));
  CHECK_EQ(first.sparkline.size(), size_t(4));
  uint64_t spark = 0;
  for (uint64_t n : first.sparkline) spark += n;
  CHECK_EQ(spark, uint64_t(600));
  CHECK_EQ(mined.patterns[1].severity, std::string("error"));
  CHECK_EQ(mined.patterns[2].severity, std::string("warn"));
  CHECK(!mined.patterns[2].noisy);

  // The patterns are cut at the maximum.
  // The count shows what was cut.
  const MinedPatterns cut = mine_patterns(sample, 1000, 1000, 4, 1, 10, [] { return false; });
  CHECK_EQ(cut.patterns.size(), size_t(1));
  CHECK_EQ(cut.pattern_count, size_t(3));
  // The time can run out.
  // The mining stops at the next check, every 256 messages, and reports it.
  std::vector<SampleRow> many;
  for (int i = 0; i < 600; ++i) many.push_back({1000, 9, "api", "request " + std::to_string(i) + " done"});
  const MinedPatterns partial = mine_patterns(many, 1000, 1000, 4, 10, 600, [] { return true; });
  CHECK(partial.partial);
  CHECK_EQ(partial.mined, size_t(256));
  CHECK_EQ(partial.scale, 600.0 / 256.0);
  // A message outside the range lands in the first or the last bucket.
  const MinedPatterns edges = mine_patterns({{0, 9, "a", "x"}, {99999, 9, "a", "x"}}, 1000, 1000, 4, 10, 2, [] { return false; });
  CHECK_EQ(edges.patterns.size(), size_t(1));
  CHECK_EQ(edges.patterns[0].sparkline.front(), uint64_t(1));
  CHECK_EQ(edges.patterns[0].sparkline.back(), uint64_t(1));
  // Nothing to mine is no pattern and no scale.
  const MinedPatterns none = mine_patterns({}, 0, 1000, 4, 10, 0, [] { return false; });
  CHECK(none.patterns.empty() && none.scale == 0.0 && none.mined == 0);
}

// ---- the service ----

HostSpec logs_host() {
  HostSpec host;
  host.id = "local";
  host.system_uri = "clickhouse://system@clickhouse:9000";
  host.otel.logs = otel_settings().logs;
  return host;
}

struct TestCaches {
  LogsSchemaCache schema{LogsSchemaCache::Options{}};
  FacetKeysCache keys{FacetKeysCache::Options{}};
  FacetValuesCache values{FacetValuesCache::Options{}};
  LogsCaches refs() { return LogsCaches{schema, keys, values}; }
};

// A clock that a test sets.
// The budgets of a search are read from this clock.
struct TestClock {
  int64_t steady = 0;
  int64_t wall = 1791701739757LL;
  LogsClock clock() {
    LogsClock c;
    c.steady_ms = [this] { return steady; };
    c.wall_ms = [this] { return wall; };
    return c;
  }
};

LogsService service_over(FakeDb& db, TestCaches& caches, LogsClock clock = LogsClock::real()) {
  return LogsService([&db](const HostSpec&, std::string*) { return std::unique_ptr<ChExecutor>(new ForwardDb(db)); }, caches.refs(), std::move(clock));
}

// The columns of the fixture table, as system.columns reports them.
const Rows kColumns = {{"Timestamp", "DateTime64(9)"}, {"TimestampTime", "DateTime"}, {"ServiceName", "LowCardinality(String)"}, {"Body", "String"},
                       {"SeverityNumber", "UInt8"}, {"SeverityText", "LowCardinality(String)"}, {"TraceId", "String"}, {"SpanId", "String"},
                       {"TraceFlags", "UInt32"}, {"ScopeName", "String"}, {"ScopeVersion", "String"},
                       {"LogAttributes", "Map(LowCardinality(String), String)"}, {"ResourceAttributes", "Map(LowCardinality(String), String)"},
                       {"ScopeAttributes", "Map(LowCardinality(String), String)"}};

void with_table(FakeDb& db) {
  db.on("FROM system.columns WHERE database", kColumns);
  db.on("FROM system.data_skipping_indices WHERE database", {{"tokenbf_v1", "Body"}});
}

// A row is what the statements of a record return (row_columns).
// The columns are: timestamp, tiebreak, service, severity text and number, body, length, trace,
// span, flags, scope name and version, and the three attribute objects.
Row log_row(int64_t ts_ns, uint64_t tie, const std::string& body, const std::string& service = "api") {
  return {std::to_string(ts_ns), std::to_string(tie), service, "INFO", "9", body, std::to_string(body.size()), "ab", "cd", "1", "scope", "1.0", "{\"k\":\"v\"}", "{}", "{}"};
}

rapidjson::Document parse(const std::string& text) {
  rapidjson::Document doc;
  doc.Parse(text.c_str());
  CHECK(!doc.HasParseError());
  return doc;
}

void test_the_service_cannot_connect() {
  TestCaches caches;
  LogsService service([](const HostSpec&, std::string* error) -> std::unique_ptr<ChExecutor> {
    if (error) *error = "OTel logs: system credentials are required for the selected host.";
    return nullptr;
  }, caches.refs());
  RequestContext context;
  const auto answer = service.search(context, logs_host(), "local", parse_search(request({{"start_ms", "1000"}, {"end_ms", "2000"}})));
  CHECK(!answer);
  CHECK_EQ(answer.error.status, 503);
  CHECK_EQ(answer.error.code, std::string("logs_source_unavailable"));
  CHECK_EQ(answer.error.message, std::string("OTel logs: system credentials are required for the selected host."));
  CHECK_EQ(service.facets(context, logs_host(), "local", parse_facets(request({}))).error.code, std::string("logs_source_unavailable"));
  // No reason: a message of its own.
  LogsService silent([](const HostSpec&, std::string*) -> std::unique_ptr<ChExecutor> { return nullptr; }, caches.refs());
  CHECK_EQ(silent.services(context, logs_host(), "local", parse_services(request({}))).error.message,
           std::string("Cannot connect to the logs ClickHouse source."));
}

void test_the_schema_is_read_once_and_a_missing_table_is_said() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("FROM `otel`.`otel_logs`", {});
  RequestContext context;
  const auto service = service_over(db, caches);
  const SearchRequest request_in = parse_search(request({{"start_ms", "1000000"}, {"end_ms", "1060000"}}));
  CHECK(service.search(context, logs_host(), "local", request_in));
  CHECK(service.search(context, logs_host(), "local", request_in));
  // Two reads of the system tables, whatever the number of requests.
  CHECK_EQ(db.count("FROM system.columns WHERE database"), size_t(1));
  CHECK_EQ(db.count("FROM system.data_skipping_indices WHERE database"), size_t(1));
  CHECK_EQ(db.params[0].size(), size_t(2));
  CHECK_EQ(db.params[0][0].second, std::string("otel"));
  CHECK_EQ(db.params[0][1].second, std::string("otel_logs"));

  // A table that the user can read, but that does not have the columns, is missing.
  FakeDb missing;
  TestCaches missing_caches;
  missing.on("FROM system.columns WHERE database", {{"x", "String"}});
  missing.on("CHECK GRANT", {{"1"}});
  const auto absent = service_over(missing, missing_caches).search(context, logs_host(), "local", request_in);
  CHECK_EQ(absent.error.status, 404);
  CHECK_EQ(absent.error.code, std::string("logs_table_missing"));
  CHECK_EQ(absent.error.message, std::string("Table otel.otel_logs is missing or is not an OpenTelemetry exporter logs table."));
  // The indexes are not read for a table that is not one.
  CHECK_EQ(missing.count("data_skipping_indices"), size_t(0));

  // A table that the user cannot read is absent from system.columns.
  // The error gives the reason.
  FakeDb denied;
  TestCaches denied_caches;
  denied.on("FROM system.columns WHERE database", {});
  denied.on("CHECK GRANT SELECT ON `otel`.`otel_logs`", {{"0"}});
  const auto refused = service_over(denied, denied_caches).search(context, logs_host(), "local", request_in);
  CHECK_EQ(refused.error.status, 503);
  CHECK_EQ(refused.error.code, std::string("logs_table_not_granted"));
  CHECK(refused.error.message.find("Table otel.otel_logs is not readable by the system user") == 0);
  CHECK(refused.error.message.find("system: Not enough privileges") != std::string::npos);
  CHECK(refused.error.message.find("SELECT ON otel.otel_logs") != std::string::npos);

  // A failure of the probe is the error of the route.
  // The connection is not lent again.
  FakeDb broken;
  TestCaches broken_caches;
  broken.fail_on("FROM system.columns WHERE database", [] { throw server_error(159, "Timeout exceeded"); });
  const auto timeout = service_over(broken, broken_caches).search(context, logs_host(), "local", request_in);
  CHECK_EQ(timeout.error.status, 504);
  CHECK_EQ(timeout.error.code, std::string("logs_timeout"));
  CHECK_EQ(broken.invalidated, 1);
}

void test_a_search_widens_its_windows_until_the_limit_is_filled() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  int call = 0;
  // The newest slice holds 2 rows, the next one 1, and the others none.
  db.on_fn("FROM `otel`.`otel_logs`", [&](const std::string&) -> Rows {
    ++call;
    if (call == 1) return {log_row(1789867000000000100LL, 5, "newest"), log_row(1789867000000000050LL, 6, "second")};
    if (call == 2) return {log_row(1789865000000000000LL, 7, "older")};
    return {};
  });
  RequestContext context;
  const auto answer = service_over(db, caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "5"}})));
  CHECK(answer);
  const SearchAnswer& a = *answer.value;
  CHECK_EQ(a.rows.size(), size_t(3));
  CHECK_EQ(a.rows[0].body, std::string("newest"));
  CHECK_EQ(a.windows.size(), size_t(3));
  // The windows are contiguous and newest first.
  // They widen: 15 minutes, 1 hour, then the rest of the range.
  CHECK_EQ(a.windows[0].hi_ns / 1000000, kEnd);
  CHECK_EQ((a.windows[0].hi_ns - a.windows[0].lo_ns + 1) / 1000000000, int64_t{900});
  CHECK_EQ(a.windows[1].hi_ns, a.windows[0].lo_ns - 1);
  CHECK_EQ((a.windows[1].hi_ns - a.windows[1].lo_ns + 1) / 1000000000, int64_t{3600});
  CHECK_EQ(a.windows[0].rows, size_t(2));
  CHECK_EQ(a.windows[1].rows, size_t(1));
  CHECK(a.exhausted);
  CHECK(a.next_cursor.empty());
  CHECK(!a.budget_exhausted);
  CHECK_EQ(a.scanned_from_ms, kEnd - 2 * kHour);
  CHECK_EQ(a.limit, size_t(5));
  // Each window asks for what is still needed.
  CHECK(db.sqls[2].find("LIMIT 5 SETTINGS max_execution_time = 30") != std::string::npos);
  CHECK(db.sqls[3].find("LIMIT 3 SETTINGS") != std::string::npos);
  CHECK(db.sqls[4].find("LIMIT 2 SETTINGS") != std::string::npos);

  // The JSON of the answer.
  const std::string json = search_json(a);
  const rapidjson::Document doc = parse(json);
  CHECK(doc["rows"].IsArray() && doc["rows"].Size() == 3);
  CHECK_EQ(std::string(doc["rows"][0]["id"].GetString()), std::string("1789867000000000100-5"));
  CHECK_EQ(std::string(doc["rows"][0]["body"].GetString()), std::string("newest"));
  CHECK(doc["rows"][0]["log_attributes"].IsObject() && std::string(doc["rows"][0]["log_attributes"]["k"].GetString()) == "v");
  CHECK_EQ(doc["row_count"].GetInt(), 3);
  CHECK(doc["next_cursor"].IsNull() && doc["exhausted"].GetBool() && !doc["truncated"].GetBool());
  CHECK_EQ(std::string(doc["mode"].GetString()), std::string("page"));
  CHECK_EQ(doc["windows"].Size(), 3u);
  CHECK(!doc["text_search"]["active"].GetBool());
  CHECK_EQ(std::string(doc["text_search"]["mode"].GetString()), std::string("token"));
}

void test_a_full_page_has_a_cursor_after_its_last_row() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("FROM `otel`.`otel_logs`", {log_row(1789867000000000100LL, 5, "a"), log_row(1789867000000000050LL, 6, "b")});
  RequestContext context;
  const auto answer = service_over(db, caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "2"}})));
  CHECK(answer);
  CHECK(!answer.value->exhausted);
  CHECK_EQ(answer.value->next_cursor, std::string("1789867000000000050-6"));
  const rapidjson::Document doc = parse(search_json(*answer.value));
  CHECK(doc["truncated"].GetBool());
  CHECK_EQ(std::string(doc["next_cursor"].GetString()), std::string("1789867000000000050-6"));
  // The cursor continues from there.
  FakeDb next;
  TestCaches next_caches;
  with_table(next);
  next.on("FROM `otel`.`otel_logs`", {});
  const auto resumed = service_over(next, next_caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"cursor", "1789867000000000050-6"}})));
  CHECK(resumed);
  CHECK(next.sqls[2].find("AND (Timestamp < fromUnixTimestamp64Nano(toInt64(1789867000000000050)) OR (Timestamp = fromUnixTimestamp64Nano(toInt64(1789867000000000050)) AND cityHash64(") != std::string::npos);
  // The keyset applies to the first window only.
  CHECK_EQ(next.count("Timestamp < fromUnixTimestamp64Nano(toInt64(1789867000000000050))"), size_t(1));
}

void test_a_search_stops_at_its_budget_and_says_so() {
  FakeDb db;
  TestCaches caches;
  TestClock clock;
  with_table(db);
  int call = 0;
  db.on_fn("FROM `otel`.`otel_logs`", [&](const std::string&) -> Rows {
    ++call;
    clock.steady += 13000;  // the first window used all of the budget
    if (call == 1) return {log_row(1789867000000000100LL, 5, "a")};
    return {};
  });
  RequestContext context;
  const auto answer = service_over(db, caches, clock.clock()).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "5"}})));
  CHECK(answer);
  CHECK_EQ(call, 1);
  CHECK(answer.value->budget_exhausted);
  CHECK(!answer.value->exhausted);
  // A cursor continues from where the windows stopped.
  CHECK_EQ(answer.value->next_cursor, cursor_text(Cursor{answer.value->windows[0].lo_ns, 0}));
  CHECK_EQ(answer.value->scanned_from_ms, answer.value->windows[0].lo_ns / 1000000);
  CHECK(parse(search_json(*answer.value))["budget_exhausted"].GetBool());

  // A window after the first one gets what is left of the budget, at least a second.
  FakeDb second;
  TestCaches second_caches;
  TestClock second_clock;
  with_table(second);
  int second_call = 0;
  second.on_fn("FROM `otel`.`otel_logs`", [&](const std::string&) -> Rows {
    ++second_call;
    second_clock.steady += second_call == 1 ? 8500 : 3000;
    if (second_call == 1) return {log_row(1789867000000000100LL, 5, "a")};
    return {};
  });
  const auto narrowed = service_over(second, second_caches, second_clock.clock()).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "5"}})));
  CHECK(narrowed);
  CHECK(second.sqls[2].find("max_execution_time = 30") != std::string::npos);
  CHECK(second.sqls[3].find("max_execution_time = 4,") != std::string::npos);
}

void test_a_window_that_times_out_ends_the_search_with_its_rows() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  int call = 0;
  db.on_fn("FROM `otel`.`otel_logs`", [&](const std::string&) -> Rows {
    ++call;
    if (call == 2) throw server_error(159, "Timeout exceeded");
    return {log_row(1789867000000000100LL, 5, "a")};
  });
  RequestContext context;
  const auto answer = service_over(db, caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "5"}})));
  CHECK(answer);
  CHECK(answer.value->budget_exhausted);
  CHECK_EQ(answer.value->rows.size(), size_t(1));
  CHECK_EQ(answer.value->windows.size(), size_t(1));
  CHECK(!answer.value->next_cursor.empty());

  // The first window has no rows to keep.
  // Its timeout is the error of the route.
  FakeDb first;
  TestCaches first_caches;
  with_table(first);
  first.fail_on("FROM `otel`.`otel_logs`", [] { throw server_error(159, "Timeout exceeded"); });
  const auto failed = service_over(first, first_caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h)));
  CHECK(!failed);
  CHECK_EQ(failed.error.status, 504);
  CHECK_EQ(failed.error.code, std::string("logs_timeout"));
  CHECK_EQ(first.invalidated, 1);
  // Another failure is not a budget.
  FakeDb other;
  TestCaches other_caches;
  with_table(other);
  int other_call = 0;
  other.on_fn("FROM `otel`.`otel_logs`", [&](const std::string&) -> Rows {
    if (++other_call == 2) throw server_error(60, "Table does not exist");
    return {log_row(1789867000000000100LL, 5, "a")};
  });
  const auto error = service_over(other, other_caches).search(context, logs_host(), "local", parse_search(ranged(kStart2h, {{"limit", "5"}})));
  CHECK_EQ(error.error.status, 503);
  CHECK_EQ(error.error.code, std::string("logs_search_failed"));
}

void test_a_search_refuses_what_it_cannot_run() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  RequestContext context;
  const auto service = service_over(db, caches);
  const auto cursor = service.search(context, logs_host(), "local", parse_search(request({{"start_ms", "1000"}, {"end_ms", "2000"}, {"cursor", "abc"}})));
  CHECK_EQ(cursor.error.status, 400);
  CHECK_EQ(cursor.error.code, std::string("invalid_logs_cursor"));
  CHECK_EQ(cursor.error.message, std::string("cursor must be <timestamp_ns>-<tiebreak>."));
  const auto range = service.search(context, logs_host(), "local", parse_search(request({{"start_ms", "1000"}})));
  CHECK_EQ(range.error.code, std::string("invalid_logs_range"));
  // The schema is read before the request is judged.
  CHECK_EQ(db.count("FROM system.columns"), size_t(1));
  // Nothing was asked of the table.
  CHECK_EQ(db.count("FROM `otel`.`otel_logs`"), size_t(0));
  // The limit of a search stays within logs.search_limit.
  FakeDb limited;
  TestCaches limited_caches;
  with_table(limited);
  limited.on("FROM `otel`.`otel_logs`", {});
  CHECK(service_over(limited, limited_caches).search(context, logs_host(), "local", parse_search(request({{"start_ms", "1000000"}, {"end_ms", "1060000"}, {"limit", "100000"}}))));
  CHECK(limited.sqls[2].find("LIMIT 200 SETTINGS") != std::string::npos);
}

void test_the_histogram_and_its_json() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("GROUP BY b ORDER BY toInt64(b)", {{"1789860000000", "1", "2", "3", "4"}, {"1789860120000", "0", "0", "5", "6"}});
  RequestContext context;
  const auto answer = service_over(db, caches).histogram(context, logs_host(), "local", parse_histogram(ranged(kStart2h, {{"bucket_origin_ms", "1234567"}})));
  CHECK(answer);
  const HistogramAnswer& a = *answer.value;
  CHECK_EQ(a.bucket_ms, int64_t{120000});
  CHECK_EQ(a.bucket_origin_ms, int64_t{34567});
  CHECK_EQ(a.grid_start_ms, grid_floor(kEnd - 2 * kHour, 120000, 34567));
  CHECK_EQ(a.buckets.size(), size_t(2));
  CHECK_EQ(a.totals[0], uint64_t(1));
  CHECK_EQ(a.totals[2], uint64_t(8));
  CHECK_EQ(a.totals[3], uint64_t(10));
  const rapidjson::Document doc = parse(histogram_json(a));
  CHECK_EQ(doc["bucket_ms"].GetInt64(), int64_t{120000});
  CHECK_EQ(doc["classes"].Size(), 4u);
  CHECK_EQ(std::string(doc["classes"][0].GetString()), std::string("error"));
  CHECK_EQ(doc["buckets"][1][3].GetUint64(), uint64_t(5));
  CHECK_EQ(doc["totals"]["total"].GetUint64(), uint64_t(21));
  CHECK_EQ(doc["totals"]["debug"].GetUint64(), uint64_t(10));
  // The buckets are 80 when the request says nothing.
  // They stay within 10 and 300.
  FakeDb few;
  TestCaches few_caches;
  with_table(few);
  few.on("GROUP BY b", {});
  CHECK_EQ(service_over(few, few_caches).histogram(context, logs_host(), "local", parse_histogram(ranged(kStart2h, {{"buckets", "1"}}))).value->bucket_ms,
           choose_bucket_ms(2 * kHour, 10));
  CHECK_EQ(service_over(few, few_caches).histogram(context, logs_host(), "local", parse_histogram(ranged(kStart2h, {{"buckets", "5000"}}))).value->bucket_ms,
           choose_bucket_ms(2 * kHour, 300));
  // A failed statement is the error of the route.
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("GROUP BY b", [] { throw server_error(241, "Memory limit exceeded"); });
  const auto error = service_over(failed, failed_caches).histogram(context, logs_host(), "local", parse_histogram(request({{"start_ms", "1000000"}, {"end_ms", "1060000"}})));
  CHECK(!error);
  CHECK_EQ(error.error.status, 422);
  CHECK_EQ(failed.invalidated, 1);
}

void test_a_substring_search_refuses_a_wide_range() {
  HostSpec host = logs_host();
  host.otel.logs.body_search = "substring";
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("GROUP BY", {});
  RequestContext context;
  const auto service = service_over(db, caches);
  const auto wide = service.histogram(context, host, "local", parse_histogram(ranged(kStart24h, {{"q", "slow"}})));
  CHECK_EQ(wide.error.status, 400);
  CHECK_EQ(wide.error.code, std::string("logs_substring_range"));
  CHECK_EQ(wide.error.message, std::string("Substring Body search is limited to 6 hours for histograms and patterns (logs.body_search = \"substring\")."));
  CHECK_EQ(service.patterns(context, host, "local", parse_patterns(ranged(kStart24h, {{"q", "slow"}}))).error.code, std::string("logs_substring_range"));
  CHECK_EQ(service.facets(context, host, "local", parse_facets(ranged(kStart24h, {{"q", "slow"}}))).error.code, std::string("logs_substring_range"));
  // Without a text there is no limit.
  // A short range is allowed.
  CHECK(service.histogram(context, host, "local", parse_histogram(ranged(kStart24h))));
  const auto narrow = service.histogram(context, host, "local", parse_histogram(ranged(kStart2h, {{"q", "slow"}})));
  CHECK(narrow);
  const rapidjson::Document doc = parse(histogram_json(*narrow.value));
  CHECK_EQ(std::string(doc["text_search"]["mode"].GetString()), std::string("substring"));
  CHECK(doc["text_search"]["active"].GetBool() && !doc["text_search"]["index_backed"].GetBool());
  // A search of a substring reads windows of 15 minutes.
  // There are 96 of them, and the millisecond that the range ends with.
  FakeDb search;
  TestCaches search_caches;
  with_table(search);
  search.on("FROM `otel`.`otel_logs`", {});
  CHECK(service_over(search, search_caches).search(context, host, "local", parse_search(ranged(kStart24h, {{"q", "slow"}}))));
  CHECK_EQ(search.count("FROM `otel`.`otel_logs`"), size_t(97));
}

void test_the_context_of_a_record_and_its_json() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  // The older records come newest first: 3 of the 2 asked for.
  // One more record shows that there are more.
  // The newer records come oldest first, from the anchor.
  db.on("ORDER BY Timestamp DESC", {log_row(1789867000000000090LL, 1, "o1"), log_row(1789867000000000080LL, 2, "o2"), log_row(1789867000000000070LL, 3, "o3")});
  db.on("ORDER BY Timestamp ASC", {log_row(1789867000000000100LL, 9, "anchor"), log_row(1789867000000000110LL, 4, "n1"), log_row(1789867000000000120LL, 5, "n2")});
  RequestContext context;
  const auto answer = service_over(db, caches).context(
      context, logs_host(), "local", parse_context(request({{"ts_ns", "1789867000000000100"}, {"tie", "9"}, {"limit", "2"}, {"window_ms", "1000"}})));
  CHECK(answer);
  const ContextAnswer& a = *answer.value;
  CHECK(a.anchor_found && a.has_anchor);
  CHECK_EQ(a.anchor_id, std::string("1789867000000000100-9"));
  CHECK(a.more_before);
  CHECK(!a.more_after);
  CHECK_EQ(a.before_count, size_t(2));
  CHECK_EQ(a.after_count, size_t(2));
  // Newer records come first, the newest on top.
  // The anchor comes next, then the older records.
  CHECK_EQ(a.rows.size(), size_t(5));
  CHECK_EQ(a.rows[0].body, std::string("n2"));
  CHECK_EQ(a.rows[2].body, std::string("anchor"));
  CHECK_EQ(a.rows[4].body, std::string("o2"));
  CHECK_EQ(a.preset, std::string("anything"));
  CHECK_EQ(a.window_ms, int64_t{1000});
  CHECK_EQ(a.range_start_ms, (1789867000000000100LL - 1000LL * 1000000) / 1000000);
  CHECK(db.sqls[2].find("LIMIT 3 ") != std::string::npos && db.sqls[3].find("LIMIT 4 ") != std::string::npos);
  const rapidjson::Document doc = parse(context_json(a));
  CHECK_EQ(std::string(doc["anchor_id"].GetString()), std::string("1789867000000000100-9"));
  CHECK(doc["anchor_found"].GetBool() && doc["more_before"].GetBool() && !doc["more_after"].GetBool());
  CHECK_EQ(doc["rows"].Size(), 5u);
  CHECK_EQ(doc["after_count"].GetUint64(), uint64_t(2));

  // No tie: no anchor.
  FakeDb loose;
  TestCaches loose_caches;
  with_table(loose);
  loose.on("ORDER BY Timestamp", {});
  const auto no_tie = service_over(loose, loose_caches).context(context, logs_host(), "local", parse_context(request({{"ts_ns", "1789867000000000100"}})));
  CHECK(no_tie && !no_tie.value->has_anchor && !no_tie.value->anchor_found);
  CHECK(parse(context_json(*no_tie.value))["anchor_id"].IsNull());
  CHECK_EQ(no_tie.value->window_ms, int64_t{300000});

  // What a request must have.
  const auto missing = service_over(loose, loose_caches).context(context, logs_host(), "local", parse_context(request({{"tie", "1"}})));
  CHECK_EQ(missing.error.status, 400);
  CHECK_EQ(missing.error.code, std::string("invalid_logs_context"));
  CHECK_EQ(missing.error.message, std::string("ts_ns (record timestamp in nanoseconds) is required."));
  CHECK(!service_over(loose, loose_caches).context(context, logs_host(), "local", parse_context(request({{"ts_ns", "0"}}))));
  CHECK(!service_over(loose, loose_caches).context(context, logs_host(), "local", parse_context(request({{"ts_ns", "x"}}))));
  CHECK_EQ(service_over(loose, loose_caches).context(context, logs_host(), "local", parse_context(request({{"ts_ns", "5"}, {"preset", "service"}}))).error.message,
           std::string("preset=service needs service."));
  // A failure is the error of the route.
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("ORDER BY Timestamp ASC", [] { throw server_error(60, "gone"); });
  failed.on("ORDER BY Timestamp DESC", {});
  const auto error = service_over(failed, failed_caches).context(context, logs_host(), "local", parse_context(request({{"ts_ns", "5"}})));
  CHECK_EQ(error.error.code, std::string("logs_context_failed"));
  CHECK_EQ(failed.invalidated, 1);
}

void test_the_patterns_and_their_json() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("SELECT toString(count())", {{"3"}});
  db.on("substringUTF8(Body, 1, 2048)", {{"1789866000000", "9", "api", "user 1 logged in"}, {"1789866100000", "9", "api", "user 2 logged in"}, {"1789866200000", "17", "web", "disk full"}});
  RequestContext context;
  const auto answer = service_over(db, caches).patterns(context, logs_host(), "local", parse_patterns(ranged(kStart2h, {{"buckets", "4"}})));
  CHECK(answer);
  const PatternsAnswer& a = *answer.value;
  CHECK_EQ(a.total, uint64_t(3));
  CHECK_EQ(a.sample_size, size_t(3));
  CHECK_EQ(a.sample_target, size_t(10000));
  CHECK_EQ(a.sample_method, std::string("all"));
  CHECK_EQ(a.sample_rate_ppm, uint64_t(1000000));
  CHECK_EQ(a.mined.pattern_count, size_t(2));
  CHECK_EQ(a.mined.scale, 1.0);
  CHECK_EQ(a.sparkline_buckets, 4);
  // A total that fits the target is read whole.
  // The statement has no block sample.
  CHECK(db.sqls[3].find("_part") == std::string::npos);
  const rapidjson::Document doc = parse(patterns_json(a));
  CHECK(!doc["sampled"].GetBool());
  CHECK_EQ(doc["patterns"].Size(), 2u);
  CHECK_EQ(std::string(doc["patterns"][0]["pattern"].GetString()), std::string("user <*> logged in"));
  CHECK_EQ(doc["patterns"][0]["count"].GetUint64(), uint64_t(2));
  CHECK_EQ(std::string(doc["patterns"][0]["severity"].GetString()), std::string("info"));
  CHECK_EQ(doc["patterns"][0]["sparkline"].Size(), 4u);
  CHECK_EQ(doc["sparkline_bucket_ms"].GetDouble(), double(2 * kHour) / 4);
  CHECK(doc["timing_ms"].HasMember("mine") && doc["timing_ms"].HasMember("count"));
  CHECK(!doc["mining_partial"].GetBool());

  // A range with more records than the sample is read as a block sample.
  // The sample is thinned to the target.
  FakeDb big;
  TestCaches big_caches;
  with_table(big);
  big.on("SELECT toString(count())", {{"1000000"}});
  Rows rows;
  for (int i = 0; i < 250; ++i) rows.push_back({"1789866000000", "9", "api", "request " + std::to_string(i) + " done"});
  big.on("substringUTF8(Body, 1, 2048)", rows);
  const auto sampled = service_over(big, big_caches).patterns(context, logs_host(), "local", parse_patterns(ranged(kStart2h, {{"sample", "100"}})));
  CHECK(sampled);
  CHECK_EQ(sampled.value->sample_method, std::string("block_hash"));
  CHECK_EQ(sampled.value->sample_rate_ppm, uint64_t(100));
  CHECK(big.sqls[3].find("% 1000000 < 100 LIMIT 200 ") != std::string::npos);
  CHECK_EQ(sampled.value->sample_size, size_t(100));
  CHECK_EQ(sampled.value->mined.scale, 10000.0);
  CHECK(parse(patterns_json(*sampled.value))["sampled"].GetBool());

  // The mining has a budget of its own.
  // The clock advances at each reading.
  // The mining finds its budget spent at the first check.
  FakeDb slow;
  TestCaches slow_caches;
  with_table(slow);
  slow.on("SELECT toString(count())", {{"600"}});
  Rows many;
  for (int i = 0; i < 600; ++i) many.push_back({"1789866000000", "9", "api", "request " + std::to_string(i) + " done"});
  slow.on("substringUTF8(Body, 1, 2048)", many);
  int reads = 0;
  LogsClock ticking;
  ticking.steady_ms = [&] { return int64_t{++reads} * 10000; };
  ticking.wall_ms = [] { return int64_t{1791701739757LL}; };
  const auto partial = service_over(slow, slow_caches, ticking).patterns(context, logs_host(), "local", parse_patterns(ranged(kStart2h)));
  CHECK(partial);
  CHECK(partial.value->mined.partial);
  CHECK(parse(patterns_json(*partial.value))["mining_partial"].GetBool());
  // Failures.
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("SELECT toString(count())", [] { throw server_error(60, "gone"); });
  const auto error = service_over(failed, failed_caches).patterns(context, logs_host(), "local", parse_patterns(request({{"start_ms", "1000000"}, {"end_ms", "1060000"}})));
  CHECK_EQ(error.error.code, std::string("logs_patterns_failed"));
  CHECK_EQ(failed.invalidated, 1);
}

void test_the_services_and_their_json() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("GROUP BY ServiceName ORDER BY ServiceName LIMIT 1000", {{"api", "12"}, {"web", "3"}});
  RequestContext context;
  const auto answer = service_over(db, caches).services(context, logs_host(), "local", parse_services(ranged(kStart2h, {{"q", "ignored"}})));
  CHECK(answer);
  CHECK_EQ(answer.value->services.size(), size_t(2));
  // The text of the page does not narrow the picker.
  CHECK(db.sqls[2].find("hasToken") == std::string::npos);
  const rapidjson::Document doc = parse(services_json(*answer.value));
  CHECK_EQ(std::string(doc["services"][1]["name"].GetString()), std::string("web"));
  CHECK_EQ(doc["services"][0]["count"].GetUint64(), uint64_t(12));
  CHECK_EQ(doc["range"][1].GetInt64(), kEnd);
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("GROUP BY ServiceName", [] { throw server_error(60, "gone"); });
  CHECK_EQ(service_over(failed, failed_caches).services(context, logs_host(), "local", parse_services(request({{"start_ms", "1000000"}, {"end_ms", "1060000"}}))).error.code,
           std::string("logs_services_failed"));
}

void test_the_facets_are_cached_and_capped() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  // sampled, scope, key, count
  db.on("LEFT ARRAY JOIN arrayConcat", {{"100", "column", "ServiceName", "100"}, {"100", "log", "http.route", "90"}, {"100", "column", "ScopeVersion", "0"}, {"100", "", "x", "5"}});
  RequestContext context;
  const auto service = service_over(db, caches);
  const FacetsRequest request_in = parse_facets(ranged(kStart15m, {{"q", "slow"}}));
  const auto first = service.facets(context, logs_host(), "local", request_in);
  CHECK(first);
  CHECK(!first.value->common.cached);
  CHECK_EQ(first.value->scopes.size(), size_t(3));
  CHECK_EQ(first.value->columns.size(), size_t(4));
  // A column that is empty on every record is not a field.
  // A key with no scope is not a key.
  CHECK_EQ(first.value->value->keys.size(), size_t(2));
  CHECK_EQ(first.value->value->keys[0].key, std::string("ServiceName"));
  CHECK_EQ(first.value->value->keys[1].key, std::string("http.route"));
  CHECK_EQ(first.value->value->sampled, uint64_t(100));
  // The same minute: one scan.
  const auto second = service.facets(context, logs_host(), "local", request_in);
  CHECK(second && second.value->common.cached);
  CHECK_EQ(db.count("LEFT ARRAY JOIN arrayConcat"), size_t(1));
  // Another filter text is another scan.
  CHECK(service.facets(context, logs_host(), "local", parse_facets(ranged(kStart15m, {{"q", "other"}}))));
  CHECK_EQ(db.count("LEFT ARRAY JOIN arrayConcat"), size_t(2));
  const rapidjson::Document doc = parse(facets_json(*first.value));
  CHECK(doc["supported"].GetBool());
  CHECK_EQ(doc["scopes"].Size(), 4u);
  CHECK_EQ(std::string(doc["scopes"][3].GetString()), std::string("column"));
  CHECK_EQ(doc["columns"].Size(), 4u);
  CHECK_EQ(doc["sampled_records"].GetUint64(), uint64_t(100));
  CHECK(!doc["truncated"].GetBool());
  CHECK_EQ(std::string(doc["keys"][1][1].GetString()), std::string("http.route"));
  CHECK_EQ(doc["keys"][0][2].GetUint64(), uint64_t(100));
  CHECK(!doc["cached"].GetBool());
  CHECK_EQ(doc["scanned_range"][0].GetInt64() % 60000, int64_t{0});
  CHECK_EQ(doc["sample_limit"].GetUint64(), kFacetSampleRows);
  CHECK(doc["text_search"]["active"].GetBool());
  CHECK(parse(facets_json(*second.value))["cached"].GetBool());

  // A table with fewer columns reads fewer fields.
  FakeDb thin;
  TestCaches thin_caches;
  thin.on("FROM system.columns WHERE database", {{"Timestamp", "DateTime64(9)"}, {"ServiceName", "String"}, {"Body", "String"}, {"SeverityNumber", "UInt8"},
                                                  {"SeverityText", "String"}, {"LogAttributes", "JSON"}});
  thin.on("FROM system.data_skipping_indices WHERE database", {});
  thin.on("LEFT ARRAY JOIN", {{"10", "column", "ServiceName", "10"}});
  const auto fewer = service_over(thin, thin_caches).facets(context, logs_host(), "local", parse_facets(ranged(kStart15m)));
  CHECK(fewer);
  CHECK(fewer.value->scopes.empty());
  CHECK_EQ(fewer.value->columns.size(), size_t(2));

  // The keys are cut at the maximum, and the answer reports it.
  FakeDb wide;
  TestCaches wide_caches;
  with_table(wide);
  Rows keys;
  for (size_t i = 0; i < kFacetMaxKeys + 1; ++i) keys.push_back({"100", "log", "k" + std::to_string(1000 + i), std::to_string(500 - i % 400)});
  wide.on("LEFT ARRAY JOIN arrayConcat", keys);
  const auto cut = service_over(wide, wide_caches).facets(context, logs_host(), "local", parse_facets(ranged(kStart15m)));
  CHECK(cut);
  CHECK_EQ(cut.value->value->keys.size(), kFacetMaxKeys + 1);
  const rapidjson::Document wide_doc = parse(facets_json(*cut.value));
  CHECK(wide_doc["truncated"].GetBool());
  CHECK_EQ(wide_doc["keys"].Size(), static_cast<unsigned>(kFacetMaxKeys));
  // A sample that reached its limit is an estimate.
  FakeDb limited;
  TestCaches limited_caches;
  with_table(limited);
  limited.on("LEFT ARRAY JOIN arrayConcat", {{std::to_string(kFacetSampleRows), "column", "ServiceName", "5"}});
  CHECK(service_over(limited, limited_caches).facets(context, logs_host(), "local", parse_facets(ranged(kStart15m))).value->value->estimated);
  // A read that was cut by its cap is one too.
  FakeDb capped;
  TestCaches capped_caches;
  with_table(capped);
  capped.bounded_result.read_rows = kFacetReadRowsCap;
  capped.on("LEFT ARRAY JOIN arrayConcat", {{"5", "column", "ServiceName", "5"}});
  CHECK(service_over(capped, capped_caches).facets(context, logs_host(), "local", parse_facets(ranged(kStart15m))).value->value->estimated);

  // A failure is a 503 with the message of the server.
  // The failure is not kept.
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("LEFT ARRAY JOIN", [] { throw server_error(60, "gone"); });
  const auto error = service_over(failed, failed_caches).facets(context, logs_host(), "local", parse_facets(ranged(kStart15m)));
  CHECK(!error);
  CHECK_EQ(error.error.status, 503);
  CHECK_EQ(error.error.code, std::string("logs_facets_failed"));
  CHECK(error.error.message.find("gone") != std::string::npos);
  CHECK_EQ(failed.invalidated, 1);
}

void test_the_values_of_a_field() {
  FakeDb db;
  TestCaches caches;
  with_table(db);
  // value, count, records with the key, distinct values
  db.on("SELECT toString(v)", {{"/v1/events", "70", "100", "3"}, {"/v1/query", "30", "100", "3"}});
  RequestContext context;
  const auto service = service_over(db, caches);
  FacetValuesRequest values_in;
  ApiError error;
  CHECK(parse_facet_values(ranged(kStart15m, {{"scope", "log"}, {"key", "http.route"}, {"limit", "2"}}), &values_in, &error));
  const auto answer = service.facet_values(context, logs_host(), "local", values_in);
  CHECK(answer);
  CHECK_EQ(answer.value->limit, 2);
  CHECK_EQ(answer.value->value->values.size(), size_t(2));
  CHECK_EQ(answer.value->value->with_key, uint64_t(100));
  CHECK_EQ(answer.value->value->distinct_values, uint64_t(3));
  const rapidjson::Document doc = parse(facet_values_json(*answer.value));
  CHECK_EQ(std::string(doc["scope"].GetString()), std::string("log"));
  CHECK_EQ(std::string(doc["key"].GetString()), std::string("http.route"));
  CHECK_EQ(doc["records_with_key"].GetUint64(), uint64_t(100));
  CHECK(doc["has_more"].GetBool());
  CHECK_EQ(std::string(doc["values"][0][0].GetString()), std::string("/v1/events"));
  CHECK_EQ(doc["values"][1][1].GetUint64(), uint64_t(30));
  CHECK_EQ(doc["limit"].GetInt(), 2);
  // The key travels as a parameter.
  CHECK_EQ(db.params[2].back().second, std::string("http.route"));
  // Cached: one scan for the same field, another for another key.
  CHECK(service.facet_values(context, logs_host(), "local", values_in).value->common.cached);
  CHECK_EQ(db.count("SELECT toString(v)"), size_t(1));
  values_in.key = "other";
  CHECK(service.facet_values(context, logs_host(), "local", values_in));
  CHECK_EQ(db.count("SELECT toString(v)"), size_t(2));

  // A column of the record is not a map.
  // A map that the table does not have is not a map either.
  FacetValuesRequest column;
  column.scope = "column";
  column.key = "ScopeName";
  column.filter.start_ms = kEnd - 15 * kMinute;
  column.filter.end_ms = kEnd;
  FakeDb thin_db;
  TestCaches thin_caches;
  thin_db.on("FROM system.columns WHERE database", {{"Timestamp", "DateTime64(9)"}, {"ServiceName", "String"}, {"Body", "String"}, {"SeverityNumber", "UInt8"},
                                                    {"SeverityText", "String"}, {"LogAttributes", "JSON"}});
  thin_db.on("FROM system.data_skipping_indices", {});
  const auto absent = service_over(thin_db, thin_caches).facet_values(context, logs_host(), "local", column);
  CHECK_EQ(absent.error.status, 400);
  CHECK_EQ(absent.error.code, std::string("logs_facet_unsupported"));
  CHECK_EQ(absent.error.message, std::string("Column ScopeName is not in the logs table."));
  FacetValuesRequest not_map = column;
  not_map.scope = "log";
  not_map.key = "x";
  CHECK_EQ(service_over(thin_db, thin_caches).facet_values(context, logs_host(), "local", not_map).error.message, std::string("LogAttributes is not stored as a Map column."));

  // A failure is a 503 with the message of the server.
  FakeDb failed;
  TestCaches failed_caches;
  with_table(failed);
  failed.fail_on("SELECT toString(v)", [] { throw server_error(60, "gone"); });
  const auto error_answer = service_over(failed, failed_caches).facet_values(context, logs_host(), "local", values_in);
  CHECK_EQ(error_answer.error.status, 503);
  CHECK_EQ(error_answer.error.code, std::string("logs_facet_values_failed"));
  CHECK_EQ(failed.invalidated, 1);
  // The estimate is used when the group limit of the scan is reached.
  FakeDb grouped;
  TestCaches grouped_caches;
  with_table(grouped);
  grouped.on("SELECT toString(v)", {{"a", "1", "5", std::to_string(kFacetGroupByCap)}});
  CHECK(service_over(grouped, grouped_caches).facet_values(context, logs_host(), "local", values_in).value->value->estimated);
}

void test_the_allowlist_is_in_every_statement() {
  HostSpec host = logs_host();
  host.otel.traces.service_allowlist = {"api*", "web"};
  FakeDb db;
  TestCaches caches;
  with_table(db);
  db.on("FROM `otel`.`otel_logs`", {});
  db.on("GROUP BY", {});
  db.on("SELECT toString(count())", {});
  db.on("ORDER BY Timestamp", {});
  db.on("LEFT ARRAY JOIN", {});
  db.on("SELECT toString(v)", {});
  RequestContext context;
  const auto service = service_over(db, caches);
  service.search(context, host, "local", parse_search(ranged(kStart15m)));
  service.histogram(context, host, "local", parse_histogram(ranged(kStart15m)));
  service.context(context, host, "local", parse_context(request({{"ts_ns", "1789867000000000100"}})));
  service.patterns(context, host, "local", parse_patterns(ranged(kStart15m)));
  service.services(context, host, "local", parse_services(ranged(kStart15m)));
  service.facets(context, host, "local", parse_facets(ranged(kStart15m)));
  FacetValuesRequest values_in;
  ApiError error;
  CHECK(parse_facet_values(ranged(kStart15m, {{"scope", "column"}, {"key", "ServiceName"}}), &values_in, &error));
  service.facet_values(context, host, "local", values_in);
  size_t checked = 0;
  for (const auto& sql : db.sqls) {
    if (sql.find("system.") != std::string::npos) continue;
    ++checked;
    CHECK(sql.find("(startsWith(ServiceName, 'api') OR ServiceName = 'web')") != std::string::npos);
  }
  CHECK(checked >= 8);
}

void test_the_logs_clock_is_the_wall_clock_for_a_lookback() {
  FakeDb db;
  TestCaches caches;
  TestClock clock;
  clock.wall = 1789867360999LL;
  with_table(db);
  db.on("FROM `otel`.`otel_logs`", {});
  RequestContext context;
  const auto answer = service_over(db, caches, clock.clock()).search(context, logs_host(), "local", parse_search(request({{"lookback_minutes", "5"}})));
  CHECK(answer);
  CHECK_EQ(answer.value->end_ms, kEnd);
  CHECK_EQ(answer.value->start_ms, kEnd - 5 * kMinute);
  const LogsClock real = LogsClock::real();
  CHECK(real.wall_ms() > 1700000000000LL);
  CHECK(real.steady_ms() >= 0);
}

}  // namespace

int main() {
  RUN(test_tokens);
  RUN(test_terms);
  RUN(test_term_sql);
  RUN(test_mask);
  RUN(test_tokens_of_a_message);
  RUN(test_pattern_search_text);
  RUN(test_drain);
  RUN(test_drain_bounds);
  RUN(test_severity);
  RUN(test_the_filters_of_a_request);
  RUN(test_the_filters_of_a_field_leave_out_the_field_itself);
  RUN(test_a_request_that_the_schema_or_the_limits_refuse);
  RUN(test_the_lookback_is_the_range_when_there_is_no_range);
  RUN(test_the_schema_of_the_table);
  RUN(test_the_search_statements_are_unchanged);
  RUN(test_the_cursor_and_the_keyset);
  RUN(test_the_histogram_statements_are_unchanged);
  RUN(test_the_context_statements_are_unchanged);
  RUN(test_the_other_statements_are_unchanged);
  RUN(test_the_severity_classes);
  RUN(test_the_patterns_of_a_sample);
  RUN(test_the_service_cannot_connect);
  RUN(test_the_schema_is_read_once_and_a_missing_table_is_said);
  RUN(test_a_search_widens_its_windows_until_the_limit_is_filled);
  RUN(test_a_full_page_has_a_cursor_after_its_last_row);
  RUN(test_a_search_stops_at_its_budget_and_says_so);
  RUN(test_a_window_that_times_out_ends_the_search_with_its_rows);
  RUN(test_a_search_refuses_what_it_cannot_run);
  RUN(test_the_histogram_and_its_json);
  RUN(test_a_substring_search_refuses_a_wide_range);
  RUN(test_the_context_of_a_record_and_its_json);
  RUN(test_the_patterns_and_their_json);
  RUN(test_the_services_and_their_json);
  RUN(test_the_facets_are_cached_and_capped);
  RUN(test_the_values_of_a_field);
  RUN(test_the_allowlist_is_in_every_statement);
  RUN(test_the_logs_clock_is_the_wall_clock_for_a_lookback);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
