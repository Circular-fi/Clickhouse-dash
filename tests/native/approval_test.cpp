// Native tests of the approval of an action by a person (ProcurAuth section 17, docs/access.md, "Approval of an action"):
//   - the effect: JCS and SHA-256 against the vectors of ProcurAuth (tests/conformance/effect-vectors.json);
//   - the client of the PDP: the question with an effect, the evaluation_id, no cache, the approval API on a fake transport;
//   - the gate of the tools (McpApprovalGate) with a scripted PDP: every branch of protocol 17.7, the mapping of the errors of 5.7a, the
//     fail-closed cases, no text of the agent to the PDP, nothing but fixed words and the listed fields in the log;
//   - the identity mode of the protocol: tools/list and tools/call with the gate.
// No network and no ClickHouse. A test binary ends with the count of its checks.

#include "native_check.hpp"

#include "access_pdp.hpp"
#include "access_resource.hpp"
#include "approval_effect.hpp"
#include "jwt.hpp"
#include "log.hpp"
#include "mcp_approval.hpp"
#include "mcp_creator_access.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"
#include "mcp_subject_access.hpp"
#include "mcp_telemetry.hpp"

#include <rapidjson/document.h>
#include <rapidjson/reader.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <unistd.h>

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <tuple>
#include <vector>

using namespace chdash;

namespace {

// ---- the vectors of the effect -----------------------------------------------------------------------------------------------------------

// A JSON value that keeps the text of each number, so that 1.0, 1e2 and -0 reach the effect as they are written.
struct Raw {
  enum class Kind { Object, Array, String, Literal } kind = Kind::Literal;
  std::string text;
  std::vector<std::pair<std::string, Raw>> members;
  std::vector<Raw> items;
};

struct RawBuilder : rapidjson::BaseReaderHandler<rapidjson::UTF8<>, RawBuilder> {
  std::vector<Raw*> stack;
  std::vector<std::string> keys;
  Raw root;
  bool have_root = false;

  Raw* place() {
    if (stack.empty()) {
      have_root = true;
      return &root;
    }
    Raw* parent = stack.back();
    if (parent->kind == Raw::Kind::Array) {
      parent->items.emplace_back();
      return &parent->items.back();
    }
    parent->members.emplace_back(keys.back(), Raw{});
    return &parent->members.back().second;
  }
  bool literal(const std::string& text) {
    Raw* at = place();
    at->kind = Raw::Kind::Literal;
    at->text = text;
    return true;
  }
  bool Null() { return literal("null"); }
  bool Bool(bool b) { return literal(b ? "true" : "false"); }
  bool RawNumber(const char* str, rapidjson::SizeType length, bool) { return literal(std::string(str, length)); }
  bool String(const char* str, rapidjson::SizeType length, bool) {
    Raw* at = place();
    at->kind = Raw::Kind::String;
    at->text.assign(str, length);
    return true;
  }
  bool StartObject() {
    Raw* at = place();
    at->kind = Raw::Kind::Object;
    stack.push_back(at);
    return true;
  }
  bool Key(const char* str, rapidjson::SizeType length, bool) {
    keys.emplace_back(str, length);
    return true;
  }
  bool EndObject(rapidjson::SizeType) {
    stack.pop_back();
    if (!keys.empty()) keys.pop_back();
    return true;
  }
  bool StartArray() {
    Raw* at = place();
    at->kind = Raw::Kind::Array;
    stack.push_back(at);
    return true;
  }
  bool EndArray(rapidjson::SizeType) {
    stack.pop_back();
    // The key of an array member was popped with the object that held it: keep the stack of keys in step.
    return true;
  }
};

std::string write_raw(const Raw& value) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  struct Walk {
    static void go(rapidjson::Writer<rapidjson::StringBuffer>& w, const Raw& v) {
      switch (v.kind) {
        case Raw::Kind::Literal: w.RawValue(v.text.data(), v.text.size(), rapidjson::kNumberType); break;
        case Raw::Kind::String: w.String(v.text.data(), static_cast<rapidjson::SizeType>(v.text.size())); break;
        case Raw::Kind::Array:
          w.StartArray();
          for (const Raw& item : v.items) go(w, item);
          w.EndArray();
          break;
        case Raw::Kind::Object:
          w.StartObject();
          for (const auto& [name, member] : v.members) {
            w.Key(name.data(), static_cast<rapidjson::SizeType>(name.size()));
            go(w, member);
          }
          w.EndObject();
          break;
      }
    }
  };
  Walk::go(w, value);
  return std::string(sb.GetString(), sb.GetSize());
}

const Raw* find(const Raw& object, const std::string& name) {
  for (const auto& [key, value] : object.members) {
    if (key == name) return &value;
  }
  return nullptr;
}

std::string read_file(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  std::stringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

void test_effect_vectors(const std::string& path) {
  const std::string text = read_file(path);
  CHECK(!text.empty());
  // A reader that gives the number as it is written: the text is valid JSON with strings that the tests of ProcurAuth escape as \u.
  RawBuilder builder;
  rapidjson::Reader reader;
  rapidjson::StringStream stream(text.c_str());
  const rapidjson::ParseResult parsed = reader.Parse<rapidjson::kParseNumbersAsStringsFlag>(stream, builder);
  CHECK(!parsed.IsError());
  const Raw* vectors = find(builder.root, "vectors");
  CHECK(vectors != nullptr);
  if (!vectors) return;
  int v01 = 0;
  int v02 = 0;
  for (const Raw& vector : vectors->items) {
    const Raw* id = find(vector, "id");
    const Raw* group = find(vector, "group");
    const Raw* input = find(vector, "input");
    CHECK(id && group && input);
    if (!id || !group || !input) continue;
    const auto text_of = [&](const char* name) { return find(*input, name)->text; };
    const std::string op = write_raw(*find(*input, "op"));
    std::string effect;
    std::string canonical;
    std::string error;
    if (group->text == "V01") {
      ++v01;
      const bool ok = approval_effect(text_of("service"), text_of("action"), text_of("resource"), op, &effect, nullptr, &error);
      CHECK(ok);
      CHECK(approval_effect_input(text_of("service"), text_of("action"), text_of("resource"), op, &canonical, &error));
      // The vector gives the canonical text and the effect: both must be the same.
      const Raw* want_text = find(vector, "canonical");
      const Raw* want_effect = find(vector, "effect");
      CHECK(want_text && want_effect);
      if (want_text) CHECK_EQ(canonical, want_text->text);
      if (want_effect) CHECK_EQ(effect, want_effect->text);
      if (!ok || (want_effect && effect != want_effect->text)) std::cerr << "vector " << id->text << " failed" << std::endl;
    } else {
      ++v02;
      const bool ok = approval_effect(text_of("service"), text_of("action"), text_of("resource"), op, &effect, nullptr, &error);
      CHECK(!ok);
      if (ok) std::cerr << "vector " << id->text << " was accepted" << std::endl;
    }
  }
  CHECK(v01 >= 12);
  CHECK(v02 >= 6);
}

void test_jcs() {
  std::string out;
  std::string error;
  CHECK(jcs_canonicalize("{\"b\":[1,{\"z\":null,\"a\":true}],\"a\":\"x\"}", &out, &error));
  CHECK_EQ(out, std::string("{\"a\":\"x\",\"b\":[1,{\"a\":true,\"z\":null}]}"));
  CHECK(!jcs_canonicalize("{\"a\":1,\"a\":2}", &out, &error));  // a name two times
  CHECK(!jcs_canonicalize("{\"a\":\"\\ud800\"}", &out, &error));  // an unpaired surrogate
  CHECK(!jcs_canonicalize("{\"a\":\"\xff\"}", &out, &error));  // bytes that are not UTF-8
  CHECK(!jcs_canonicalize("{\"a\":01}", &out, &error));
  CHECK(!jcs_canonicalize("{\"a\":1.0}", &out, &error));
  CHECK(!jcs_canonicalize("{\"a\":-0}", &out, &error));
  CHECK(!jcs_canonicalize("{\"a\":9007199254740992}", &out, &error));
  CHECK(jcs_canonicalize("{\"a\":-9007199254740991}", &out, &error));
  CHECK(!jcs_canonicalize_object("[1]", &out, &error));
  CHECK(!jcs_canonicalize("{\"a\":1} x", &out, &error));
  std::string deep;
  for (int i = 0; i < 70; ++i) deep += "[";
  for (int i = 0; i < 70; ++i) deep += "]";
  CHECK(!jcs_canonicalize(deep, &out, &error));
  CHECK_EQ(approval_resource_text("service:db/host:prod/database:a%2Fb"), std::string("host:prod/database:a%2Fb"));
  CHECK_EQ(approval_resource_text("service:db"), std::string());
}

// ---- a fake transport of the PDP -----------------------------------------------------------------------------------------------------------

struct FakeTransport : PdpTransport {
  struct Call {
    std::string method;
    std::string path;
    std::string body;
    bool once = false;
    std::map<std::string, std::string> headers;
  };
  std::vector<Call>* calls;
  // The answers by "METHOD path-prefix": the first prefix that matches.
  std::vector<std::pair<std::string, PdpHttpResult>> script;

  explicit FakeTransport(std::vector<Call>* out) : calls(out) {}

  PdpHttpResult answer(const std::string& method, const std::string& path, const std::string& body, bool once,
                       const std::vector<std::pair<std::string, std::string>>& headers) {
    Call call{method, path, body, once, {}};
    for (const auto& [name, value] : headers) call.headers[name] = value;
    calls->push_back(call);
    for (const auto& [key, result] : script) {
      if ((method + " " + path).rfind(key, 0) == 0) return result;
    }
    PdpHttpResult none;
    none.error = "no answer in the script";
    return none;
  }
  PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                     std::chrono::milliseconds) override {
    return answer("POST", path, body, false, headers);
  }
  PdpHttpResult post_once(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                          std::chrono::milliseconds) override {
    return answer("POST", path, body, true, headers);
  }
  PdpHttpResult get(const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, std::chrono::milliseconds) override {
    return answer("GET", path, std::string(), false, headers);
  }
};

PdpHttpResult http(int status, const std::string& body) {
  PdpHttpResult out;
  out.status = status;
  out.body = body;
  return out;
}

PdpClient make_client(std::vector<FakeTransport::Call>* calls, FakeTransport** transport, std::chrono::milliseconds cache = std::chrono::milliseconds(60000)) {
  PdpOptions options;
  options.token = "pdp-token-canary";
  options.cache_ttl = cache;
  options.discovery = false;
  auto fake = std::make_unique<FakeTransport>(calls);
  *transport = fake.get();
  return PdpClient(options, std::move(fake));
}

const std::string kEffect = "sha256:" + std::string(64, 'a');

AccessQuestion effect_question(const std::string& action = "query.run.write") {
  AccessQuestion q{action, access_host_resource("db", "prod")};
  q.approval_effect = kEffect;
  return q;
}

void test_client_question_and_answers() {
  // The body of a question with an effect: context.approval.effect only, never op or view (17.1, 17.9).
  const std::string body = PdpClient::approval_request_body("key:k1", effect_question(), false);
  rapidjson::Document doc;
  doc.Parse(body.c_str(), body.size());
  CHECK(doc["context"]["approval"]["effect"].GetString() == kEffect);
  CHECK(!doc["context"].HasMember("usage"));
  CHECK(!doc["context"].HasMember("op") && !doc["context"]["approval"].HasMember("op") && !doc["context"]["approval"].HasMember("view"));
  CHECK_EQ(doc["context"]["approval"].MemberCount(), rapidjson::SizeType(1));
  const std::string use = PdpClient::approval_request_body("key:k1", effect_question(), true);
  doc.Parse(use.c_str(), use.size());
  CHECK(doc["context"]["usage"]["units"].GetUint() == 1u && doc["context"]["approval"]["effect"].GetString() == kEffect);

  std::vector<FakeTransport::Call> calls;
  FakeTransport* transport = nullptr;
  PdpClient client = make_client(&calls, &transport);
  PdpCallContext context;
  context.request_id = "r1";
  // approval_required with an evaluation_id: the reason and the id are kept.
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":false,"context":{"reason":"approval_required","evaluation_id":"ev-opaque"}})")}};
  AccessDecision d = client.decide_approval("key:k1", effect_question(), false, false, context);
  CHECK(!d.allowed && !d.failed && d.reason == PdpReason::ApprovalRequired && d.evaluation_id == "ev-opaque");
  // The answer is never kept: the same question goes to the PDP again (17.7, 10.1).
  d = client.decide_approval("key:k1", effect_question(), false, false, context);
  CHECK_EQ(calls.size(), size_t(2));
  // A question without usage may go again after a lost connection; a question with usage never does.
  CHECK(!calls[0].once);
  d = client.decide_approval("key:k1", effect_question(), true, false, context);
  CHECK(calls.back().once);
  // The usage answer needs units, unless the action lists no budget.
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":true})")}};
  d = client.decide_approval("key:k1", effect_question(), true, false, context);
  CHECK(!d.allowed && d.usage_invalid);
  d = client.decide_approval("key:k1", effect_question(), true, true, context);
  CHECK(d.allowed && !d.usage_invalid);
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":true,"context":{"usage":{"units":1}}})")}};
  d = client.decide_approval("key:k1", effect_question(), true, false, context);
  CHECK(d.allowed && d.usage_units && *d.usage_units == 1);
  // The four reasons, and the others.
  for (const auto& [name, reason] : std::vector<std::pair<std::string, PdpReason>>{{"approval_pending", PdpReason::ApprovalPending},
                                                                                   {"approval_denied", PdpReason::ApprovalDenied},
                                                                                   {"approval_expired", PdpReason::ApprovalExpired}}) {
    transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":false,"context":{"reason":")" + name + R"("}})")}};
    d = client.decide_approval("key:k1", effect_question(), false, false, context);
    CHECK(d.reason == reason && !d.failed);
  }
  // The bound of the evaluation_id is 4096 bytes. A longer id is not kept: the answer stays a denial that cannot start an approval, and the
  // answers of the other questions of the batch stay valid.
  transport->script = {{"POST /access/v1/evaluation",
                        http(200, R"({"decision":false,"context":{"reason":"approval_required","evaluation_id":")" + std::string(4096, 'e') + R"("}})")}};
  d = client.decide_approval("key:k1", effect_question(), false, false, context);
  CHECK(!d.allowed && !d.failed && d.reason == PdpReason::ApprovalRequired && d.evaluation_id.size() == 4096);
  transport->script = {{"POST /access/v1/evaluation",
                        http(200, R"({"decision":false,"context":{"reason":"approval_required","evaluation_id":")" + std::string(4097, 'e') + R"("}})")}};
  d = client.decide_approval("key:k1", effect_question(), false, false, context);
  CHECK(!d.allowed && !d.failed && d.reason == PdpReason::ApprovalRequired && d.evaluation_id.empty());
  // A malformed answer fails closed: a bad evaluation_id, a bad status, no answer.
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":false,"context":{"reason":"approval_required","evaluation_id":7}})")}};
  CHECK(client.decide_approval("key:k1", effect_question(), false, false, context).failed);
  transport->script = {{"POST /access/v1/evaluation", http(500, "")}};
  CHECK(client.decide_approval("key:k1", effect_question(), false, false, context).failed);
  transport->script = {};
  CHECK(client.decide_approval("key:k1", effect_question(), true, false, context).failed);
  // A question without an effect, or with the match subtree, is a fault of the caller: nothing is sent.
  const size_t before = calls.size();
  AccessQuestion none{"query.run.write", access_host_resource("db", "prod")};
  CHECK(client.decide_approval("key:k1", none, false, false, context).failed);
  AccessQuestion subtree = effect_question();
  subtree.match = AccessMatch::Subtree;
  CHECK(client.decide_approval("key:k1", subtree, false, false, context).failed);
  CHECK_EQ(calls.size(), before);
  // decide() has no effect: a question with one is refused there, and the cache never answers it.
  CHECK(client.decide("key:k1", {effect_question()}, context).front().failed);
}

void test_client_never_keeps_an_approval_reason() {
  std::vector<FakeTransport::Call> calls;
  FakeTransport* transport = nullptr;
  PdpClient client = make_client(&calls, &transport);
  PdpCallContext context;
  // A question without an effect for an action that needs an approval gets approval_required (17.1). ChDash does not keep the answer.
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":false,"context":{"reason":"approval_required"}})")}};
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  AccessDecision d = client.decide("alice", {q}, context).front();
  CHECK(d.reason == PdpReason::ApprovalRequired && !d.allowed);
  client.decide("alice", {q}, context);
  CHECK_EQ(calls.size(), size_t(2));
  CHECK_EQ(client.cached_entries(), size_t(0));
  // The refusal of a route: HTTP 403 with a stable code and a plain sentence. It holds no text of the PDP.
  const AccessRefusal refusal = access_refusal(d, "query.run.write");
  CHECK(refusal.status == 403 && refusal.error_code == "approval_cannot_wait" && !refusal.retryable);  // ProcurAuth 17.7a
  CHECK(refusal.message.find("approval") != std::string::npos);
  // A set of answers: the reason of 17.1 wins over a plain false (the use needs an approval and the call cannot wait).
  AccessDecision plain_false;
  plain_false.source = "pdp";
  CHECK(access_refusal_of({plain_false, d}).reason == PdpReason::ApprovalRequired);
  d.reason = PdpReason::None;
  CHECK(access_refusal(d, "query.run.write").error_code == "forbidden");
}

void test_approval_api() {
  PdpApprovalRequest request;
  request.evaluation_id = "ev-opaque";
  request.effect = kEffect;
  request.op_json = R"({"host":"prod","sql":"CREATE TABLE t (x UInt8) ENGINE = Memory","tool":"run_write_query"})";
  request.view_json = mcp_op_view(*mcp_find_approval_tool("run_write_query"), nullptr, rapidjson::Value(rapidjson::kObjectType), "x").view_json;
  request.control = PdpApprovalRequest::Control::LeaseSeconds;
  request.lease_seconds = 900;
  rapidjson::Document doc;
  std::string body = PdpClient::approval_submit_body(request);
  doc.Parse(body.c_str(), body.size());
  CHECK(!doc.HasParseError());
  // Exactly the members of 17.4: no explanation, no allow_custom, no allow_ask_back, no hint.
  std::vector<std::string> names;
  for (const auto& m : doc.GetObject()) names.emplace_back(m.name.GetString());
  CHECK((names == std::vector<std::string>{"evaluation_id", "effect", "op", "view", "lease_s"}));
  CHECK(doc["lease_s"].GetUint64() == 900u);
  request.control = PdpApprovalRequest::Control::ApprovalRef;
  request.control_text = "ref_opaque_1";
  request.supersedes = "apr_old";
  body = PdpClient::approval_submit_body(request);
  doc.Parse(body.c_str(), body.size());
  CHECK(doc["approval_ref"].GetString() == std::string("ref_opaque_1") && doc["supersedes"].GetString() == std::string("apr_old") && !doc.HasMember("lease_s"));
  request.control = PdpApprovalRequest::Control::Until;
  request.control_text = "2026-11-10T10:00:00Z";
  body = PdpClient::approval_submit_body(request);
  doc.Parse(body.c_str(), body.size());
  CHECK(doc["until"].GetString() == std::string("2026-11-10T10:00:00Z") && !doc.HasMember("approval_ref"));

  // The path of a read: the subject and the id are percent-encoded; renew only when asked.
  CHECK_EQ(PdpClient::approval_verdict_path("", "apr_1", "key:ab-1", 0, true), std::string("/approval/v1/requests/apr_1?subject=key%3Aab-1&renew=true"));
  CHECK_EQ(PdpClient::approval_verdict_path("/pdp", "a b", "key:x", 5, false), std::string("/pdp/approval/v1/requests/a%20b?subject=key%3Ax&wait=5"));

  // The mapping of the answers (5.7a).
  using Status = PdpApprovalReply::Status;
  PdpApprovalReply r = PdpClient::parse_approval_reply(201, R"({"request_id":"apr_1","code":"K7QF","verdict":"pending"})", std::nullopt, true);
  CHECK(r.status == Status::Ok && r.request_id == "apr_1" && r.code == "K7QF" && r.verdict == PdpVerdict::Pending);
  r = PdpClient::parse_approval_reply(200, R"({"request_id":"apr_1","code":"K7QF","explanation":"secret","approver":"alice"})", std::nullopt, true);
  CHECK(r.status == Status::Ok);  // other members are ignored, never read
  CHECK(PdpClient::parse_approval_reply(201, R"({"request_id":"apr_1"})", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(201, R"({"request_id":"apr 1","code":"K7QF"})", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(201, "not json", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(409, R"({"error":"no_device"})", std::nullopt, true).status == Status::NoDevice);
  // The old alias is gone. The faults of the agent are tool errors, not an outage (portal approval API, 17.4).
  CHECK(PdpClient::parse_approval_reply(409, R"({"error":"no_phone"})", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(409, R"({"error":"cannot_supersede"})", std::nullopt, true).status == Status::CannotSupersede);
  CHECK(PdpClient::parse_approval_reply(422, R"({"error":"explanation_required"})", std::nullopt, true).status == Status::ExplanationRequired);
  CHECK(PdpClient::parse_approval_reply(422, R"({"error":"invalid_evaluation"})", std::nullopt, true).status == Status::InvalidEvaluation);
  // The three codes mean something only for a submission: a read maps no such answer.
  CHECK(PdpClient::parse_approval_reply(422, R"({"error":"invalid_evaluation"})", std::nullopt, false).status == Status::Unavailable);
  r = PdpClient::parse_approval_reply(429, R"({"error":"rate_limited","retry_after":42})", std::nullopt, true);
  CHECK(r.status == Status::RateLimited && r.retry_after == 42);
  CHECK(PdpClient::parse_approval_reply(429, "", std::nullopt, true).retry_after == 1);
  CHECK(PdpClient::parse_approval_reply(413, R"({"error":"command_too_large"})", std::nullopt, true).status == Status::InvalidArgument);
  for (const char* code : {"invalid_argument", "invalid_lease", "lease_required"}) {
    CHECK(PdpClient::parse_approval_reply(422, std::string(R"({"error":")") + code + "\"}", std::nullopt, true).status == Status::InvalidArgument);
  }
  CHECK(PdpClient::parse_approval_reply(422, R"({"error":"effect_mismatch"})", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(503, "", std::nullopt, true).status == Status::Unavailable);
  CHECK(PdpClient::parse_approval_reply(401, "", std::nullopt, true).status == Status::Unavailable);
  // A read: four verdicts; any other text is void.
  for (const auto& [text, verdict] : std::vector<std::pair<std::string, PdpVerdict>>{{"pending", PdpVerdict::Pending},
                                                                                     {"approved", PdpVerdict::Approved},
                                                                                     {"denied", PdpVerdict::Denied},
                                                                                     {"void", PdpVerdict::Void},
                                                                                     {"approved_by_alice", PdpVerdict::Void}}) {
    r = PdpClient::parse_approval_reply(200, R"({"verdict":")" + text + R"("})", std::nullopt, false);
    CHECK(r.status == Status::Ok && r.verdict == verdict);
  }
  CHECK(PdpClient::parse_approval_reply(404, R"({"error":"not_found"})", std::nullopt, false).status == Status::InvalidArgument);
  CHECK(PdpClient::parse_approval_reply(200, "{}", std::nullopt, false).status == Status::Unavailable);

  // On the transport: the token goes in Authorization, the read has the query, nothing else leaves.
  std::vector<FakeTransport::Call> calls;
  FakeTransport* transport = nullptr;
  PdpClient client = make_client(&calls, &transport);
  transport->script = {{"POST /approval/v1/requests", http(201, R"({"request_id":"apr_9","code":"ABCD","verdict":"pending"})")},
                       {"GET /approval/v1/requests/apr_9", http(200, R"({"verdict":"approved"})")}};
  PdpCallContext context;
  context.request_id = "req-1";
  request.control = PdpApprovalRequest::Control::LeaseSeconds;
  request.supersedes.clear();
  const PdpApprovalReply submitted = client.approval_submit(request, context);
  CHECK(submitted.status == Status::Ok && submitted.request_id == "apr_9");
  CHECK_EQ(calls[0].headers["Authorization"], std::string("Bearer pdp-token-canary"));
  const PdpApprovalReply verdict = client.approval_verdict("apr_9", "key:k1", 3, true, context);
  CHECK(verdict.status == Status::Ok && verdict.verdict == PdpVerdict::Approved);
  CHECK_EQ(calls[1].method, std::string("GET"));
  CHECK_EQ(calls[1].path, std::string("/approval/v1/requests/apr_9?subject=key%3Ak1&wait=3&renew=true"));
  // No answer: Unavailable, never a verdict.
  transport->script = {};
  CHECK(client.approval_submit(request, context).status == Status::Unavailable);
  CHECK(client.approval_verdict("apr_9", "key:k1", 0, true, context).status == Status::Unavailable);
}

// ---- the gate with a scripted PDP ----------------------------------------------------------------------------------------------------------

struct Script {
  // The answers to the questions with an effect, in order. A question after the last one repeats the last answer.
  std::vector<AccessDecision> answers;
  struct Asked {
    bool usage;
    bool units_optional;
    std::string effect;
    std::string action;
    std::string resource;
  };
  std::vector<Asked> asked;
  std::vector<std::string> subjects;  // the subject of each question with an effect, and of each submission read
  PdpApprovalReply submit_reply;
  std::vector<PdpApprovalRequest> submitted;
  PdpApprovalReply verdict_reply;
  struct Read {
    std::string id;
    std::string subject;
    uint64_t wait;
    bool renew;
  };
  std::vector<Read> reads;
  size_t next = 0;

  Script() {
    submit_reply.status = PdpApprovalReply::Status::Ok;
    submit_reply.request_id = "apr_1";
    submit_reply.code = "K7QF";
    verdict_reply.status = PdpApprovalReply::Status::Ok;
    verdict_reply.verdict = PdpVerdict::Pending;
  }

  McpApprovalPorts ports() {
    McpApprovalPorts p;
    p.ask = [this](const std::string& subject, const AccessQuestion& q, bool usage, bool units_optional) {
      subjects.push_back(subject);
      asked.push_back({usage, units_optional, q.approval_effect, q.action, access_resource_path(q.resource)});
      AccessDecision d = answers.at(std::min(next, answers.size() - 1));
      ++next;
      return d;
    };
    p.submit = [this](const PdpApprovalRequest& r) {
      submitted.push_back(r);
      return submit_reply;
    };
    p.verdict = [this](const std::string& id, const std::string& subject, uint64_t wait, bool renew) {
      subjects.push_back(subject);
      reads.push_back({id, subject, wait, renew});
      return verdict_reply;
    };
    return p;
  }
};

AccessDecision yes(uint64_t units = 1) {
  AccessDecision d;
  d.allowed = true;
  d.source = "pdp";
  d.usage_units = units;
  return d;
}
AccessDecision no(PdpReason reason, const std::string& evaluation_id = std::string()) {
  AccessDecision d;
  d.source = "pdp";
  d.reason = reason;
  d.evaluation_id = evaluation_id;
  return d;
}
AccessDecision failed() {
  AccessDecision d;
  d.failed = true;
  return d;
}

McpApprovalConfig make_config() {
  McpApprovalConfig config;
  config.service_id = "db";
  config.hosts = {McpApprovalHost{"prod", "chdash_mcp", "chdash_mcp_write"}, McpApprovalHost{"ro", "chdash_mcp", ""}};
  config.max_command_bytes = 16384;
  config.wait_cap_seconds = 15;
  return config;
}

// The question of 10.1 (no effect) that starts a call: here the PDP asks for an approval. Other answers are tested apart.
std::function<AccessDecision()> approval_first() {
  return [] { return no(PdpReason::ApprovalRequired); };
}

rapidjson::Document args_of(const std::string& json) {
  rapidjson::Document doc;
  doc.Parse(json.c_str(), json.size());
  return doc;
}

const McpToolInfo& write_tool() { return *mcp_find_approval_tool("run_write_query"); }
const McpToolInfo& list_tool() { return *mcp_find_tool("list_databases"); }

constexpr const char* kCreate = "CREATE TABLE IF NOT EXISTS default.t (x UInt8) ENGINE = Memory";

std::string code_of(const McpToolOutcome& outcome) {
  rapidjson::Document doc;
  doc.Parse(outcome.json.c_str(), outcome.json.size());
  if (!doc.IsObject() || !doc.HasMember("error")) return std::string();
  return doc["error"]["code"].GetString();
}

void test_gate_awaiting_and_pending() {
  Script script;
  script.answers = {no(PdpReason::ApprovalRequired, "ev-1")};
  McpApprovalGate gate(make_config(), script.ports());
  McpCallInfo info;
  const rapidjson::Document args = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})");
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  McpGateResult r = gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
  // The question of 10.1 came first (no effect). Then one question with the effect and no usage, and the request goes to the approval API. The
  // call is over: awaiting, not an error.
  CHECK(r.access == McpAccess::Allowed && !r.run && !r.pass && info.answered.has_value());
  CHECK_EQ(script.asked.size(), size_t(1));
  CHECK(!script.asked[0].usage && !script.asked[0].units_optional);
  CHECK_EQ(script.submitted.size(), size_t(1));
  CHECK_EQ(script.submitted[0].evaluation_id, std::string("ev-1"));
  CHECK_EQ(script.submitted[0].effect, script.asked[0].effect);
  CHECK(script.submitted[0].control == PdpApprovalRequest::Control::LeaseSeconds && script.submitted[0].lease_seconds == 900);
  const McpToolOutcome& out = *info.answered;
  CHECK(!out.is_error);
  rapidjson::Document doc = args_of(out.json);
  CHECK_EQ(std::string(doc["action"]["id"].GetString()), std::string("apr_1"));
  CHECK_EQ(std::string(doc["action"]["status"].GetString()), std::string("awaiting_approval"));
  CHECK_EQ(std::string(doc["action"]["code"].GetString()), std::string("K7QF"));
  CHECK(doc["action"]["executed"].IsBool() && !doc["action"]["executed"].GetBool());
  CHECK(out.extra_text.rfind("NOT EXECUTED", 0) == 0);
  CHECK(info.approved_sql.empty());
  CHECK_EQ(out.effect, script.asked[0].effect);
  CHECK_EQ(out.approval, std::string("awaiting"));
  // The effect is the hash of the service, the action, the host and the op {tool, host, sql, ch_user}.
  std::string want;
  std::string error;
  const std::string op = std::string(R"({"tool":"run_write_query","host":"prod","sql":")") + kCreate + R"(","ch_user":"chdash_mcp_write"})";
  CHECK(approval_effect("db", "query.run.write", "host:prod", op, &want, nullptr, &error));
  CHECK_EQ(script.asked[0].effect, want);
  // The op and the view hold the statement and the user, and no control argument. The view has only pointers into op.
  rapidjson::Document submitted_op = args_of(script.submitted[0].op_json);
  CHECK(submitted_op.HasMember("sql") && submitted_op.HasMember("ch_user") && !submitted_op.HasMember("lease_s"));
  rapidjson::Document view = args_of(script.submitted[0].view_json);
  CHECK_EQ(std::string(view["title"].GetString()), std::string("ClickHouse write"));
  CHECK_EQ(std::string(view["body"].GetString()), std::string("/sql"));
  for (const auto& field : view["fields"].GetArray()) CHECK(std::string(field[1].GetString()).rfind("/", 0) == 0);

  // approval_pending: the request goes again, and the id and the code are the same (17.4).
  script.answers = {no(PdpReason::ApprovalPending, "ev-2")};
  McpCallInfo info2;
  r = gate.call("key:k1", write_tool(), q, true, args, &info2, approval_first());
  CHECK(info2.answered && !info2.answered->is_error && info2.answered->json == out.json);
  CHECK_EQ(script.submitted.size(), size_t(2));
}

void test_gate_denied_and_expired() {
  for (const auto& [reason, code] : std::vector<std::pair<PdpReason, std::string>>{{PdpReason::ApprovalDenied, "approval_denied"},
                                                                                   {PdpReason::ApprovalExpired, "approval_expired"}}) {
    Script script;
    script.answers = {no(reason)};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})");
    const McpGateResult r = gate.call("key:k1", write_tool(), {"query.run.write", access_host_resource("db", "prod")}, true, args, &info, approval_first());
    CHECK(r.access == McpAccess::Allowed && !r.run && info.answered && info.answered->is_error);
    CHECK_EQ(code_of(*info.answered), code);
    CHECK(info.answered->json.find("\"retryable\":false") != std::string::npos);
    CHECK_EQ(script.submitted.size(), size_t(0));
    CHECK_EQ(script.asked.size(), size_t(1));
  }
}

void test_gate_run_once_and_questions() {
  // An action with a budget: after the question of 10.1 (true here, so no approval is involved) nothing more is asked.
  {
    Script script;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod"})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, true, args, &info,
                                      [] { return yes(); });
    CHECK(r.pass && !r.run && r.decision.allowed && !info.answered);
    CHECK_EQ(script.asked.size(), size_t(0));  // a call that needs no approval costs one question, the first
    CHECK(info.approved_effect.empty());
  }
  // The approval is there: the question with the effect, then the question with usage; the tool runs after the true answer. A second call
  // starts again with the question of 10.1, and the PDP asks for a new approval.
  {
    Script script;
    script.answers = {yes()};
    McpApprovalGate gate(make_config(), script.ports());
    for (int i = 0; i < 2; ++i) {
      McpCallInfo info;
      const rapidjson::Document args = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})");
      const McpGateResult r = gate.call("key:k1", write_tool(), {"query.run.write", access_host_resource("db", "prod")}, true, args, &info, approval_first());
      CHECK(r.access == McpAccess::Allowed && r.run && !info.answered);
      CHECK_EQ(info.approved_sql, std::string(kCreate));
      CHECK(!info.approved_effect.empty() && info.controls_present);
    }
    CHECK_EQ(script.asked.size(), size_t(4));  // each execution asks the PDP again: the PEP keeps no approval
    CHECK(!script.asked[0].usage && script.asked[1].usage && !script.asked[1].units_optional);
    CHECK_EQ(script.asked[0].effect, script.asked[1].effect);
  }
  // The question of 10.1 gives another answer: the caller applies it. Nothing else is asked, and no control is needed.
  for (const AccessDecision& other : {no(PdpReason::None), failed(), yes(0)}) {
    Script script;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod"})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, false, args, &info,
                                      [&] { return other; });
    CHECK(r.pass && !r.run && !info.answered && script.asked.empty());
  }
  // A call that has no control when the PDP asks for an approval: invalid_argument; no question with the effect, no submission (U116).
  {
    Script script;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod"})");
    gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, false, args, &info, approval_first());
    CHECK(info.answered && code_of(*info.answered) == "invalid_argument");
    CHECK(script.asked.empty() && script.submitted.empty());
  }
  // An action with no budget: the question without usage, then the question with usage (17.7, steps 1 and 4).
  {
    Script script;
    script.answers = {yes(0)};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","lease_s":60})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, false, args, &info, approval_first());
    CHECK(r.run && !info.answered);
    CHECK_EQ(script.asked.size(), size_t(2));
    CHECK(!script.asked[0].usage && script.asked[1].usage && script.asked[1].units_optional);
    CHECK_EQ(script.asked[0].effect, script.asked[1].effect);
    CHECK(info.controls_present);
  }
  // A false answer to the question without usage: nothing with usage follows.
  {
    Script script;
    script.answers = {no(PdpReason::None)};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","lease_s":60})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, false, args, &info, approval_first());
    CHECK(r.access == McpAccess::Denied && !r.run);
    CHECK_EQ(script.asked.size(), size_t(1));
  }
  // The approval ends between the two questions: approval_expired, nothing is sent.
  {
    Script script;
    script.answers = {yes(0), no(PdpReason::ApprovalExpired)};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","lease_s":60})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, false, args, &info, approval_first());
    CHECK(!r.run && info.answered && code_of(*info.answered) == "approval_expired");
    CHECK_EQ(script.submitted.size(), size_t(0));
  }
  // A void approval: the question without usage and with the effect gives approval_required (17.1), so the call submits a new request.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev-9")};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","lease_s":60})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, true, args, &info, approval_first());
    CHECK(!r.run && info.answered && !info.answered->is_error && info.answered->approval == "awaiting");
    CHECK_EQ(script.asked.size(), size_t(1));
    CHECK_EQ(script.submitted.size(), size_t(1));
  }
  // A budget that refuses: the unit and the approval are not taken; the tool error budget_exceeded with retry_after.
  {
    Script script;
    AccessDecision spent = no(PdpReason::BudgetExceeded);
    spent.retry_after = 12;
    script.answers = {spent};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","lease_s":60})");
    const McpGateResult r = gate.call("key:k1", list_tool(), {"explorer.read", access_host_resource("db", "prod")}, true, args, &info, approval_first());
    CHECK(r.access == McpAccess::BudgetExceeded && info.retry_after && *info.retry_after == 12);
  }
}

void test_gate_fail_closed_and_mapping() {
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  const std::string text = std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})";
  const rapidjson::Document args = args_of(text);
  // No valid answer of the PDP: Failed (HTTP 503), never a result.
  {
    Script script;
    script.answers = {failed()};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    CHECK(gate.call("key:k1", write_tool(), q, true, args, &info, approval_first()).access == McpAccess::Failed);
    CHECK(!info.answered);
  }
  // approval_required without an evaluation_id: the PEP cannot submit, it refuses.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired)};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    CHECK(gate.call("key:k1", write_tool(), q, true, args, &info, approval_first()).access == McpAccess::Denied);
    CHECK_EQ(script.submitted.size(), size_t(0));
  }
  // The approval API: 409 no_device, 429, a bad argument, and any other failure.
  using Status = PdpApprovalReply::Status;
  const struct {
    Status status;
    std::string code;
  } cases[] = {{Status::NoDevice, "approval_unavailable"}, {Status::RateLimited, "approval_rate_limited"}, {Status::InvalidArgument, "invalid_argument"}};
  for (const auto& c : cases) {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    script.submit_reply.status = c.status;
    script.submit_reply.retry_after = 33;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK(r.access == McpAccess::Allowed && info.answered && info.answered->is_error);
    CHECK_EQ(code_of(*info.answered), c.code);
    if (c.status == Status::NoDevice) CHECK(info.answered->json.find("\"retryable\":true") != std::string::npos);
    if (c.status == Status::RateLimited) CHECK(info.answered->json.find("\"retry_after\":33") != std::string::npos);
    // The message is fixed: no text of the PDP and no value of the request.
    CHECK(info.answered->json.find("CREATE") == std::string::npos);
  }
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    script.submit_reply.status = Status::Unavailable;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    CHECK(gate.call("key:k1", write_tool(), q, true, args, &info, approval_first()).access == McpAccess::Failed);
  }
  // No control argument: the PDP asked for an approval, and the call has no way to say how long it waits.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document bare = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"("})");
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, bare, &info, approval_first());
    CHECK(info.answered && code_of(*info.answered) == "invalid_argument");
    CHECK_EQ(script.submitted.size(), size_t(0));
  }
  // A bad control argument asks the PDP nothing: two of the three, a type, a size.
  for (const char* bad : {R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","lease_s":900,"until":"2026-11-10T10:00:00Z"})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","approval_ref":"r","lease_s":9})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","lease_s":"9"})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","lease_s":0})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","lease_s":1.5})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","lease_s":9,"wait_s":-1})",
                          R"({"host":"prod","sql":"CREATE TABLE a (x UInt8) ENGINE = Memory","approval_ref":""})"}) {
    Script script;
    script.answers = {yes()};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document bad_args = args_of(bad);
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, bad_args, &info, approval_first());
    CHECK(r.access == McpAccess::Allowed && !r.run && info.answered && code_of(*info.answered) == "invalid_argument");
    CHECK_EQ(script.asked.size(), size_t(0));
  }
  // op and view larger than max_command_bytes: the action is refused, nothing is hidden or cut, nothing goes to the approval API.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    McpApprovalConfig config = make_config();
    config.max_command_bytes = 1024;
    McpApprovalGate gate(config, script.ports());
    McpCallInfo info;
    std::string values;
    for (int i = 0; i < 500; ++i) values += "(1),";
    const std::string big_text = R"({"host":"prod","lease_s":9,"sql":"INSERT INTO t VALUES )" + values + "(1)\"}";
    const rapidjson::Document big = args_of(big_text);
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, big, &info, approval_first());
    CHECK(r.access == McpAccess::Allowed && info.answered && code_of(*info.answered) == "invalid_argument");
    CHECK_EQ(script.submitted.size(), size_t(0));
  }
}

void test_gate_write_statement_and_host() {
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  Script script;
  script.answers = {yes()};
  McpApprovalGate gate(make_config(), script.ports());
  const auto run = [&](const std::string& json) {
    McpCallInfo info;
    const rapidjson::Document args = args_of(json);
    McpGateResult r = gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    return std::make_pair(r, std::move(info));
  };
  // A statement that only reads needs no approval: the tool refuses it, and the PDP is not asked.
  auto [read, read_info] = run(R"({"host":"prod","sql":"SELECT 1"})");
  CHECK(!read.run && read_info.answered && code_of(*read_info.answered) == "statement_not_allowed");
  auto [with_read, with_read_info] = run(R"({"host":"prod","sql":"WITH 1 AS x SELECT x"})");
  CHECK(!with_read.run && with_read_info.answered && code_of(*with_read_info.answered) == "not_a_write");
  // Several statements, a SETTINGS clause, a function that reads files, a statement of the access control, an unknown statement.
  for (const char* sql : {"INSERT INTO t VALUES (1); DROP TABLE t", "INSERT INTO t SETTINGS async_insert = 1 VALUES (1)",
                          "INSERT INTO t SELECT * FROM file('x.csv')", "CREATE USER u", "ALTER ROLE r", "GRANT SELECT ON *.* TO u", "KILL QUERY WHERE 1",
                          "SYSTEM RELOAD CONFIG", ""}) {
    auto [r, i] = run(std::string(R"({"host":"prod","lease_s":9,"sql":")") + sql + "\"}");
    CHECK(!r.run && i.answered && i.answered->is_error);
  }
  CHECK_EQ(script.asked.size(), size_t(0));
  // A host that has no write account, or that is not known, gets the answer of a tool that does not exist (no PDP question).
  auto [ro, ro_info] = run(std::string(R"({"host":"ro","lease_s":9,"sql":")") + kCreate + "\"}");
  CHECK(ro.access == McpAccess::Denied);
  auto [unknown, unknown_info] = run(std::string(R"({"host":"nowhere","lease_s":9,"sql":")") + kCreate + "\"}");
  CHECK(unknown.access == McpAccess::Denied);
  auto [missing, missing_info] = run(std::string(R"({"lease_s":9,"sql":")") + kCreate + "\"}");
  CHECK(missing.access == McpAccess::Denied);
  CHECK_EQ(script.asked.size(), size_t(0));
  // An argument that the tool does not have.
  auto [extra, extra_info] = run(std::string(R"({"host":"prod","database":"d","sql":")") + kCreate + "\"}");
  CHECK(!extra.run && extra_info.answered && code_of(*extra_info.answered) == "invalid_argument");
  // The statement that runs is the text that the effect covers: the closing semicolon is not part of it, a comment is.
  auto [semi, semi_info] = run(std::string(R"({"host":"prod","lease_s":9,"sql":"/* a */ CREATE TABLE t (x UInt8) ENGINE = Memory;"})"));
  CHECK(semi.run);
  CHECK_EQ(semi_info.approved_sql, std::string("/* a */ CREATE TABLE t (x UInt8) ENGINE = Memory"));
  // A WITH ... INSERT is a write.
  auto [with, with_info] = run(R"({"host":"prod","lease_s":9,"sql":"WITH 1 AS x INSERT INTO t SELECT x"})");
  CHECK(with.run);
}

void test_export_tool() {
  const McpToolInfo& exporter = *mcp_find_approval_tool("export_query");
  CHECK_EQ(std::string(mcp_tool_access_action(exporter)), std::string("query.export"));
  const McpApprovalHost host{"prod", "reader", "writer"};
  const rapidjson::Document args = args_of(R"({"host":"prod","sql":"SELECT 1"})");
  const McpOpView view = mcp_op_view(exporter, &host, args, "");
  CHECK(view.ok);
  CHECK_EQ(view.op_json, std::string(R"({"tool":"export_query","host":"prod","sql":"SELECT 1","ch_user":"reader","options":"{\"format\":\"csv\"}"})"));
  const rapidjson::Document shown = args_of(view.view_json);
  CHECK_EQ(std::string(shown["title"].GetString()), std::string("ClickHouse export"));
  CHECK_EQ(std::string(shown["body"].GetString()), std::string("/sql"));
  // The tool is offered with the status tool, and a call with another format is another effect.
  Script script;
  McpApprovalGate gate(make_config(), script.ports());
  const auto names = gate.tool_names();
  CHECK(std::find(names.begin(), names.end(), std::string(kMcpExportTool)) != names.end());
  const rapidjson::Document json_args = args_of(R"({"host":"prod","sql":"SELECT 1","format":"json"})");
  CHECK(mcp_op_view(exporter, &host, json_args, "").op_json != view.op_json);
}

void test_gate_effects_follow_the_arguments() {
  Script script;
  script.answers = {yes(0)};
  McpApprovalGate gate(make_config(), script.ports());
  const AccessQuestion q{"explorer.read", access_host_resource("db", "prod")};
  const auto effect_of = [&](const std::string& json) {
    script.asked.clear();
    script.next = 0;
    McpCallInfo info;
    std::string with_lease = json;
    if (with_lease.find("lease_s") == std::string::npos && with_lease.find("approval_ref") == std::string::npos) with_lease.insert(1, "\"lease_s\":900,");
    const rapidjson::Document args = args_of(with_lease);
    gate.call("key:k1", *mcp_find_tool("query_table"), q, false, args, &info, approval_first());
    return script.asked.empty() ? std::string() : script.asked.front().effect;
  };
  const std::string base = effect_of(R"({"host":"prod","database":"d","table":"t","limit":10})");
  CHECK(!base.empty());
  // The order of the members does not change the effect; a value that decides what the tool does does.
  CHECK_EQ(effect_of(R"({"limit":10,"table":"t","database":"d","host":"prod"})"), base);
  CHECK(effect_of(R"({"host":"prod","database":"d","table":"t","limit":11})") != base);
  CHECK(effect_of(R"({"host":"prod","database":"d2","table":"t","limit":10})") != base);
  // A control argument never changes the effect (17.9a).
  CHECK_EQ(effect_of(R"({"host":"prod","database":"d","table":"t","limit":10,"lease_s":900,"wait_s":3,"supersedes":"apr_0"})"), base);
  CHECK_EQ(effect_of(R"({"host":"prod","database":"d","table":"t","limit":10,"approval_ref":"ref_1"})"), base);
  // A number that is not an integer is no problem for the effect: the arguments are one text in the op.
  CHECK(!effect_of(R"({"host":"prod","database":"d","table":"t","min_duration_ms":1.5})").empty());
  // The effect binds the action and the resource: another host is another effect.
  const std::string other = [&] {
    script.asked.clear();
    script.next = 0;
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"host":"prod","database":"d","table":"t","limit":10,"lease_s":900})");
    gate.call("key:k1", *mcp_find_tool("query_table"), {"explorer.read", access_database_resource("db", "prod", "d")}, false, args, &info, approval_first());
    return script.asked.front().effect;
  }();
  CHECK(other != base);
}

void test_gate_wait_and_status() {
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  const std::string with_wait = std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900,"wait_s":99})";
  // wait_s waits for the verdict, bounded by the configuration. The wait never renews the request. A pending verdict: the call waits no more.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(with_wait);
    gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK_EQ(script.reads.size(), size_t(1));
    CHECK(script.reads[0].wait == 15 && !script.reads[0].renew && script.reads[0].id == "apr_1" && script.reads[0].subject == "key:k1");
    CHECK(info.answered && !info.answered->is_error);
  }
  // Without wait_s the call reads nothing, and renews nothing (never a timer of ChDash).
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})");
    gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK_EQ(script.reads.size(), size_t(0));
  }
  // approved during the wait: the call asks again from the start, and the tool runs after the true answer.
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev"), yes()};
    script.verdict_reply.verdict = PdpVerdict::Approved;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(with_wait);
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK(r.run && !info.answered);
    CHECK_EQ(script.asked.size(), size_t(3));  // the question with the effect, again after the approval, then the question with usage
    CHECK_EQ(script.submitted.size(), size_t(1));
  }
  // denied or void during the wait.
  for (const auto& [verdict, code] : std::vector<std::pair<PdpVerdict, std::string>>{{PdpVerdict::Denied, "approval_denied"}, {PdpVerdict::Void, "approval_expired"}}) {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    script.verdict_reply.verdict = verdict;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(with_wait);
    gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK(info.answered && code_of(*info.answered) == code);
  }
  // A failed read during the wait leaves the call with the result "it waits".
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    script.verdict_reply.status = PdpApprovalReply::Status::Unavailable;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const rapidjson::Document args = args_of(with_wait);
    gate.call("key:k1", write_tool(), q, true, args, &info, approval_first());
    CHECK(info.answered && !info.answered->is_error);
  }

  // get_action_status: the verdict and nothing else, renew with the subject, no PDP question, no state change.
  Script script;
  script.answers = {yes()};
  McpApprovalGate gate(make_config(), script.ports());
  for (const auto& [verdict, word] : std::vector<std::pair<PdpVerdict, std::string>>{{PdpVerdict::Pending, "pending"}, {PdpVerdict::Approved, "approved"},
                                                                                     {PdpVerdict::Denied, "denied"}, {PdpVerdict::Void, "void"}}) {
    script.verdict_reply.verdict = verdict;
    McpCallInfo info;
    const rapidjson::Document args = args_of(R"({"request_id":"apr_1"})");
    CHECK(gate.status("key:k1", args, &info) == McpAccess::Allowed);
    CHECK(info.answered && !info.answered->is_error);
    CHECK_EQ(info.answered->json, std::string("{\"status\":\"") + word + "\"}");
  }
  CHECK(script.reads.back().renew && script.reads.back().wait == 0 && script.reads.back().subject == "key:k1");
  CHECK_EQ(script.asked.size(), size_t(0));
  // An unknown request is invalid_argument; a failure is HTTP 503; the id and the arguments are checked first.
  script.verdict_reply.status = PdpApprovalReply::Status::InvalidArgument;
  McpCallInfo unknown;
  const rapidjson::Document args = args_of(R"({"request_id":"apr_nope"})");
  gate.status("key:k1", args, &unknown);
  CHECK(unknown.answered && code_of(*unknown.answered) == "invalid_argument");
  script.verdict_reply.status = PdpApprovalReply::Status::Unavailable;
  McpCallInfo down;
  CHECK(gate.status("key:k1", args, &down) == McpAccess::Failed);
  const size_t reads = script.reads.size();
  for (const char* bad : {R"({})", R"({"request_id":""})", R"({"request_id":5})", R"({"request_id":"a b"})", R"({"request_id":"a","x":1})"}) {
    McpCallInfo info;
    const rapidjson::Document bad_args = args_of(bad);
    gate.status("key:k1", bad_args, &info);
    CHECK(info.answered && code_of(*info.answered) == "invalid_argument");
  }
  CHECK_EQ(script.reads.size(), reads);
}

void test_the_request_to_the_pdp_has_no_text_of_the_agent() {
  Script script;
  script.answers = {no(PdpReason::ApprovalRequired, "ev")};
  McpApprovalGate gate(make_config(), script.ports());
  McpCallInfo info;
  const rapidjson::Document args = args_of(std::string(R"({"host":"prod","sql":")") + kCreate +
                                           R"(","approval_ref":"ref_canary_opaque","explanation":"canary explanation","wait_s":0,"supersedes":"apr_old"})");
  gate.call("key:k1", write_tool(), {"query.run.write", access_host_resource("db", "prod")}, true, args, &info, approval_first());
  // The tool has no argument `explanation`: the call is refused before the PDP is asked.
  CHECK(!info.answered || code_of(*info.answered) == "invalid_argument");
  CHECK_EQ(script.submitted.size(), size_t(0));

  Script second;
  second.answers = {no(PdpReason::ApprovalRequired, "ev")};
  McpApprovalGate gate2(make_config(), second.ports());
  McpCallInfo info2;
  const rapidjson::Document ok = args_of(std::string(R"({"host":"prod","sql":")") + kCreate + R"(","approval_ref":"ref_canary_opaque","supersedes":"apr_old"})");
  gate2.call("key:k1", write_tool(), {"query.run.write", access_host_resource("db", "prod")}, true, ok, &info2, approval_first());
  CHECK_EQ(second.submitted.size(), size_t(1));
  const std::string body = PdpClient::approval_submit_body(second.submitted[0]);
  rapidjson::Document doc = args_of(body);
  std::vector<std::string> names;
  for (const auto& m : doc.GetObject()) names.emplace_back(m.name.GetString());
  CHECK((names == std::vector<std::string>{"evaluation_id", "effect", "op", "view", "approval_ref", "supersedes"}));
  CHECK(doc["approval_ref"].GetString() == std::string("ref_canary_opaque"));  // as the agent gave it
  CHECK(body.find("canary explanation") == std::string::npos);
  CHECK(!doc.HasMember("explanation") && !doc.HasMember("allow_custom") && !doc.HasMember("allow_ask_back") && !doc.HasMember("hint"));
  // The control argument is not in the op.
  CHECK(doc["op"].FindMember("approval_ref") == doc["op"].MemberEnd());
}

// ---- the log -------------------------------------------------------------------------------------------------------------------------------

// Runs `work` with the standard error in a file, and gives what was written.
std::string capture_stderr(const std::function<void()>& work) {
  char name[] = "/tmp/chdash-approval-log-XXXXXX";
  const int fd = mkstemp(name);
  fflush(stderr);
  const int saved = dup(STDERR_FILENO);
  dup2(fd, STDERR_FILENO);
  work();
  fflush(stderr);
  dup2(saved, STDERR_FILENO);
  close(saved);
  close(fd);
  const std::string text = read_file(name);
  unlink(name);
  return text;
}

void test_log_has_no_text_of_the_approval() {
  std::vector<FakeTransport::Call> calls;
  FakeTransport* transport = nullptr;
  PdpClient client = make_client(&calls, &transport);
  transport->script = {{"POST /access/v1/evaluation", http(200, R"({"decision":false,"context":{"reason":"approval_required","evaluation_id":"ev-canary-id"}})")},
                       {"POST /approval/v1/requests", http(201, R"({"request_id":"apr_log","code":"CODE","verdict":"pending","explanation":"canary-explanation","approver":"canary-approver"})")},
                       {"GET /approval/v1/requests/apr_log", http(200, R"({"verdict":"denied","comment":"canary-comment"})")}};
  PdpCallContext context;
  context.request_id = "log-req";
  PdpApprovalRequest request;
  request.evaluation_id = "ev-canary-id";
  request.effect = kEffect;
  request.op_json = R"({"sql":"canary-sql-text","tool":"run_write_query"})";
  request.view_json = R"({"title":"T"})";
  request.control = PdpApprovalRequest::Control::ApprovalRef;
  request.control_text = "canary-approval-ref";
  const std::string log = capture_stderr([&] {
    client.decide_approval("key:k1", effect_question(), false, false, context);
    client.approval_submit(request, context);
    client.approval_verdict("apr_log", "key:k1", 0, true, context);
  });
  CHECK(!log.empty());
  // No token, no text of the command, no control of the agent, no text of the portal that the PEP must not read.
  for (const char* canary : {"pdp-token-canary", "canary-sql-text", "canary-approval-ref", "canary-explanation", "canary-approver", "canary-comment", "ev-canary-id"}) {
    CHECK(log.find(canary) == std::string::npos);
  }
  // The lines have fixed words: the outcome, the route, and the verdict (one of the four).
  CHECK(log.find("\"event\":\"access.approval\"") != std::string::npos);
  CHECK(log.find("\"verdict\":\"denied\"") != std::string::npos);
  CHECK(log.find("\"approval_request\":\"apr_log\"") != std::string::npos && log.find("\"approval_code\":\"CODE\"") != std::string::npos);

  // The call log of MCP: the effect and the executed text only for a call with an effect.
  McpCallRecord record;
  CHECK(record.log_fields("ok", 1, 1).size() == 21);
  record.effect = kEffect;
  record.approval = "run";
  record.executed_sql = kCreate;
  const auto fields = record.log_fields("ok", 1, 1);
  CHECK_EQ(fields.size(), size_t(24));
  CHECK(fields[21].key() == "approval.effect" && fields[21].text() == kEffect);
  CHECK(fields[22].key() == "approval.outcome" && fields[22].text() == "run");
  CHECK(fields[23].key() == "approval.executed_sql" && fields[23].text() == kCreate);
}

// ---- the protocol --------------------------------------------------------------------------------------------------------------------------

struct InnerBackend : McpToolBackend {
  std::vector<std::string> run;
  std::vector<std::string> arguments;
  McpToolOutcome call_tool(const McpKey&, const std::string& tool, const rapidjson::Value& args, int64_t) override {
    return call_tool_for(McpKey{}, tool, args, 0, McpCallInfo{});
  }
  McpToolOutcome call_tool_for(const McpKey&, const std::string& tool, const rapidjson::Value& args, int64_t, const McpCallInfo& info) override {
    run.push_back(tool);
    rapidjson::StringBuffer sb;
    rapidjson::Writer<rapidjson::StringBuffer> w(sb);
    args.Accept(w);
    arguments.emplace_back(sb.GetString(), sb.GetSize());
    McpToolOutcome out;
    out.json = "{\"ran\":true}";
    out.effect = info.approved_effect;
    out.executed_sql = info.approved_sql;
    return out;
  }
};

std::string rpc(const std::string& method, const std::string& params_json, bool with_name = false, const std::string& name = std::string()) {
  (void)with_name;
  (void)name;
  return R"({"jsonrpc":"2.0","id":7,"method":")" + method + R"(","params":)" + params_json + "}";
}

McpRpcResult send(McpToolBackend& backend, const McpKey& key, const std::string& method, const std::string& params, const std::string& tool = std::string()) {
  McpRequestHeaders headers;
  headers.has_protocol_version = true;
  headers.protocol_version = "2026-07-28";
  headers.has_method = true;
  headers.method = method;
  if (!tool.empty()) {
    headers.has_name = true;
    headers.name = tool;
  }
  McpServerInfo info;
  return mcp_handle_message(rpc(method, params), key, backend, info, 1000, headers);
}

const char* kMeta = R"("_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"})";

void test_protocol_with_the_gate() {
  InnerBackend inner;
  Script script;
  script.answers = {no(PdpReason::ApprovalRequired, "ev")};
  McpApprovalGate gate(make_config(), script.ports());
  std::vector<std::string> list_questions;
  McpSubjectAccess access(
      "db", {"prod", "ro"}, AccessFeatures{},
      [&](const std::string&, const std::vector<AccessQuestion>& questions) {
        std::vector<AccessDecision> out;
        for (const auto& q : questions) {
          list_questions.push_back(q.action + (q.match == AccessMatch::Subtree ? "@subtree" : ""));
          out.push_back(yes(0));
        }
        return out;
      },
      [&](const std::string&, const AccessQuestion&) { return no(PdpReason::ApprovalRequired); });
  access.set_approval(&gate);
  McpSubjectTools backend(inner, access);
  const McpKey key = mcp_identity_key("key:k1");

  // tools/list: the two tools of the flow, the control arguments on each other tool, the annotations of the plan.
  McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
  rapidjson::Document doc = args_of(listed.body);
  std::map<std::string, const rapidjson::Value*> tools;
  for (const auto& tool : doc["result"]["tools"].GetArray()) tools[tool["name"].GetString()] = &tool;
  CHECK(tools.count("run_write_query") == 1 && tools.count("get_action_status") == 1);
  CHECK(tools.count("run_query") == 1 && tools.count("export_query") == 1);
  CHECK(tools["export_query"]->operator[]("annotations")["readOnlyHint"].GetBool());
  const rapidjson::Value& write = *tools["run_write_query"];
  CHECK(write["annotations"]["readOnlyHint"].GetBool() == false && write["annotations"]["destructiveHint"].GetBool() == true &&
        write["annotations"]["openWorldHint"].GetBool() == true);
  CHECK(write["inputSchema"]["properties"].HasMember("lease_s") && write["inputSchema"]["properties"].HasMember("approval_ref") &&
        write["inputSchema"]["properties"].HasMember("wait_s"));
  CHECK((*tools["get_action_status"])["annotations"]["readOnlyHint"].GetBool());
  CHECK(!(*tools["get_action_status"])["inputSchema"]["properties"].HasMember("lease_s"));
  CHECK(tools["run_query"]->operator[]("inputSchema")["properties"].HasMember("lease_s"));
  bool write_asked = false;
  for (const auto& q : list_questions) write_asked = write_asked || q == "query.run.write@subtree";
  CHECK(write_asked);

  // tools/call of the write tool: awaiting_approval, not an error, with the text NOT EXECUTED in the second item, and no tool ran.
  const std::string call = std::string(R"({"name":"run_write_query","arguments":{"host":"prod","sql":")") + kCreate + R"(","lease_s":900},)" + kMeta + "}";
  McpRpcResult called = send(backend, key, "tools/call", call, "run_write_query");
  doc = args_of(called.body);
  const rapidjson::Value& result = doc["result"];
  CHECK_EQ(std::string(result["resultType"].GetString()), std::string("complete"));
  CHECK(!result.HasMember("isError"));  // binding 5.7: no such member in the result that waits
  CHECK_EQ(std::string(result["structuredContent"]["action"]["status"].GetString()), std::string("awaiting_approval"));
  CHECK(!result["structuredContent"]["action"]["executed"].GetBool());
  CHECK_EQ(result["content"].Size(), rapidjson::SizeType(2));
  CHECK(std::string(result["content"][1]["text"].GetString()).rfind("NOT EXECUTED", 0) == 0);
  CHECK(inner.run.empty());
  CHECK(called.outcome.effect.rfind("sha256:", 0) == 0 && called.outcome.approval == "awaiting");

  // After the approval: the tool runs once with the arguments without the control arguments, and with the statement of the PDP flow.
  script.answers = {yes()};
  called = send(backend, key, "tools/call", call, "run_write_query");
  CHECK_EQ(inner.run.size(), size_t(1));
  CHECK_EQ(inner.run[0], std::string("run_write_query"));
  CHECK(inner.arguments[0].find("lease_s") == std::string::npos && inner.arguments[0].find("\"host\":\"prod\"") != std::string::npos);
  CHECK(called.outcome.executed_sql == kCreate && called.outcome.effect.rfind("sha256:", 0) == 0);

  // A tool of the identity mode with the control arguments: they never reach the tool.
  script.answers = {yes(0)};
  const std::string read = std::string(R"({"name":"list_databases","arguments":{"host":"prod","lease_s":30},)") + kMeta + "}";
  called = send(backend, key, "tools/call", read, "list_databases");
  CHECK_EQ(inner.run.size(), size_t(2));
  CHECK(inner.arguments[1].find("lease_s") == std::string::npos);

  // get_action_status: the verdict.
  script.verdict_reply.verdict = PdpVerdict::Approved;
  called = send(backend, key, "tools/call", std::string(R"({"name":"get_action_status","arguments":{"request_id":"apr_1"},)") + kMeta + "}", "get_action_status");
  doc = args_of(called.body);
  CHECK(!doc["result"].HasMember("isError"));
  CHECK_EQ(std::string(doc["result"]["structuredContent"]["status"].GetString()), std::string("approved"));
  CHECK_EQ(doc["result"]["structuredContent"].MemberCount(), rapidjson::SizeType(1));

  // A PDP that does not answer: HTTP 503 and -32603, never a result.
  script.answers = {failed()};
  called = send(backend, key, "tools/call", call, "run_write_query");
  CHECK(called.http_status == 503 && called.rpc_error == -32603);

  // A denial without an approval reason is the answer of a tool that does not exist.
  script.answers = {no(PdpReason::None)};
  called = send(backend, key, "tools/call", call, "run_write_query");
  CHECK(called.rpc_error == -32602);
}

void test_protocol_without_the_gate() {
  // Without a gate (the keys of ChDash, the tests of the older flow) the tools of the flow do not exist.
  InnerBackend inner;
  McpSubjectAccess access("db", {"prod"}, AccessFeatures{}, [](const std::string&, const std::vector<AccessQuestion>& questions) {
    std::vector<AccessDecision> out;
    for (size_t i = 0; i < questions.size(); ++i) out.push_back(yes(0));
    return out;
  });
  McpSubjectTools backend(inner, access);
  const McpKey key = mcp_identity_key("key:k1");
  McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
  CHECK(listed.body.find("run_write_query") == std::string::npos && listed.body.find("get_action_status") == std::string::npos);
  CHECK(listed.body.find("lease_s") == std::string::npos);
  McpRpcResult called = send(backend, key, "tools/call",
                             std::string(R"({"name":"run_write_query","arguments":{"host":"prod","sql":"CREATE TABLE t (x UInt8) ENGINE = Memory"},)") + kMeta + "}",
                             "run_write_query");
  CHECK(called.rpc_error == -32602);
  CHECK(inner.run.empty());
}


// ---- the keys of the page: the approval of the creator ------------------------------------------------------------------------------------

// The PDP of a key of the page: the standing answers by action (the question of 10.1 and the checks of the state), and the questions asked.
struct KeysPdp {
  std::map<std::string, AccessDecision> by_action;
  std::vector<std::string> asked;      // "action@path" of each question without usage
  std::vector<std::string> asked_use;  // the same for the questions with usage
  std::vector<std::string> subjects;
  AccessDecision answer(const AccessQuestion& q) {
    const auto it = by_action.find(q.action);
    return it == by_action.end() ? yes(0) : it->second;
  }
};

McpKey creator_key() {
  McpKey key;
  key.id = "ui_aaaaaaaaaaaa";
  key.name = "ui";
  key.source = "ui";
  key.creator = "alice";
  key.hosts = {"prod"};
  key.databases = {"*"};
  key.tools = {"list_databases", "run_query", "system_overview", "list_hosts"};
  return key;
}

struct KeysRig {
  KeysPdp pdp;
  Script script;
  InnerBackend inner;
  McpApprovalGate gate;
  McpCreatorAccess creators;
  KeysRig(bool with_gate = true)
      : gate(make_config(), script.ports()),
        creators(
            "db", std::chrono::milliseconds(0),
            [this](const std::string& subject, const std::vector<AccessQuestion>& questions) {
              std::vector<AccessDecision> out;
              for (const auto& q : questions) {
                pdp.subjects.push_back(subject);
                pdp.asked.push_back(q.action + "@" + access_resource_path(q.resource));
                out.push_back(pdp.answer(q));
              }
              return out;
            },
            [] { return int64_t(1000); },
            [this](const std::string& subject, const AccessQuestion& q) {
              pdp.subjects.push_back(subject);
              pdp.asked_use.push_back(q.action + "@" + access_resource_path(q.resource));
              return pdp.answer(q);
            },
            [](const std::string& action) { return action == "query.run.read"; }) {
    if (with_gate) creators.set_approval(&gate);
  }
};

void test_keys_mode_approval() {
  const McpKey key = creator_key();
  const auto tools_call = [&](McpToolBackend& backend, const std::string& tool, const std::string& arguments) {
    return send(backend, key, "tools/call", std::string(R"({"name":")") + tool + R"(","arguments":)" + arguments + "," + kMeta + "}", tool);
  };

  // tools/list: get_action_status and the control arguments, and neither the write tool nor the export tool (the identity mode has them).
  {
    KeysRig rig;
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
    rapidjson::Document doc = args_of(listed.body);
    std::map<std::string, const rapidjson::Value*> tools;
    for (const auto& tool : doc["result"]["tools"].GetArray()) tools[tool["name"].GetString()] = &tool;
    CHECK(tools.count("get_action_status") == 1 && tools.count("list_databases") == 1 && tools.count("run_query") == 1);
    CHECK(tools.count("run_write_query") == 0 && tools.count("export_query") == 0);
    CHECK(tools["list_databases"]->operator[]("inputSchema")["properties"].HasMember("lease_s"));
    CHECK(!(*tools["get_action_status"])["inputSchema"]["properties"].HasMember("lease_s"));
    // The key sees one host: the schema of the key keeps its text (the host stays optional).
    CHECK(std::string((*tools["list_databases"])["inputSchema"]["properties"]["host"]["description"].GetString()).find("Optional") != std::string::npos);
    // The tools of the identity mode do not exist for a key.
    CHECK(tools_call(backend, "run_write_query", R"({"host":"prod","sql":"CREATE TABLE t (x UInt8) ENGINE = Memory"})").rpc_error == -32602);
    CHECK(tools_call(backend, "export_query", R"({"host":"prod","sql":"SELECT 1"})").rpc_error == -32602);
    CHECK(rig.inner.run.empty() && rig.script.asked.empty());
  }

  // A key without the gate: no new tool, no control argument, and a reason of 17.1 is a refusal, as before.
  {
    KeysRig rig(false);
    rig.pdp.by_action["explorer.read"] = no(PdpReason::ApprovalRequired);
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
    CHECK(listed.body.find("get_action_status") == std::string::npos && listed.body.find("lease_s") == std::string::npos);
    CHECK(tools_call(backend, "list_databases", R"({"host":"prod"})").rpc_error == -32602);
    CHECK(rig.script.asked.empty() && rig.inner.run.empty());
  }

  // A call that needs no approval costs the question of 10.1 only. The control arguments are optional, and they never reach the tool.
  {
    KeysRig rig;
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    McpRpcResult called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":30})");
    CHECK(called.rpc_error == 0 && rig.inner.run.size() == 1 && rig.inner.arguments[0].find("lease_s") == std::string::npos);
    CHECK(rig.script.asked.empty() && rig.script.submitted.empty());
    // A bad control is a tool error even when no approval is needed, and the PDP is not asked.
    const size_t asked_before = rig.pdp.asked.size();
    called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":0})");
    rapidjson::Document doc = args_of(called.body);
    CHECK(doc["result"]["isError"].GetBool() && code_of(called.outcome) == "invalid_argument");
    CHECK_EQ(rig.pdp.asked.size(), asked_before);
    CHECK_EQ(rig.inner.run.size(), size_t(1));
  }

  // The PDP asks for an approval for explorer.read: the lazy flow for the creator, with the effect of the host of the call.
  {
    KeysRig rig;
    rig.pdp.by_action["explorer.read"] = no(PdpReason::ApprovalRequired);
    rig.script.answers = {no(PdpReason::ApprovalRequired, "ev-1")};
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    // The key keeps the tool of an action that the creator holds with a confirmation.
    CHECK(std::find(rig.creators.state(key).tools.begin(), rig.creators.state(key).tools.end(), "list_databases") != rig.creators.state(key).tools.end());
    // No control argument: the tool error invalid_argument, and nothing goes to the approval API.
    McpRpcResult called = tools_call(backend, "list_databases", R"({"host":"prod"})");
    CHECK_EQ(code_of(called.outcome), std::string("invalid_argument"));
    CHECK(rig.script.asked.empty() && rig.script.submitted.empty() && rig.inner.run.empty());
    // With a lease: the result "it waits", not an error, and no tool ran. The subject is the creator.
    called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})");
    rapidjson::Document doc = args_of(called.body);
    CHECK(!doc["result"].HasMember("isError"));
    CHECK_EQ(std::string(doc["result"]["structuredContent"]["action"]["status"].GetString()), std::string("awaiting_approval"));
    CHECK(!doc["result"]["structuredContent"]["action"]["executed"].GetBool());
    CHECK(std::string(doc["result"]["content"][1]["text"].GetString()).rfind("NOT EXECUTED", 0) == 0);
    CHECK(rig.inner.run.empty());
    CHECK_EQ(rig.script.submitted.size(), size_t(1));
    CHECK(rig.script.asked.size() == 1 && !rig.script.asked[0].usage && rig.script.asked[0].effect.rfind("sha256:", 0) == 0);
    CHECK_EQ(rig.script.asked[0].action, std::string("explorer.read"));
    CHECK_EQ(rig.script.asked[0].resource, std::string("service:db/host:prod"));
    for (const auto& subject : rig.script.subjects) CHECK_EQ(subject, std::string("alice"));
    const std::string effect_one = called.outcome.effect;
    CHECK(effect_one.rfind("sha256:", 0) == 0 && called.outcome.approval == "awaiting");
    // The op has the host of the call, also when the call leaves it out (the key has one host): the same call, the same effect.
    called = tools_call(backend, "list_databases", R"({"lease_s":900})");
    CHECK_EQ(called.outcome.effect, effect_one);
    CHECK(rig.script.submitted.back().op_json.find("\"host\":\"prod\"") != std::string::npos);
    // A control never enters the effect.
    called = tools_call(backend, "list_databases", R"({"host":"prod","approval_ref":"mine"})");
    CHECK_EQ(called.outcome.effect, effect_one);
    // After the approval: the PDP gives true (no usage for an action that lists no budget), and the tool runs once without the control.
    rig.script.answers = {yes(0)};
    called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})");
    CHECK_EQ(rig.inner.run.size(), size_t(1));
    CHECK(rig.inner.arguments[0].find("lease_s") == std::string::npos);
    CHECK(called.outcome.effect.rfind("sha256:", 0) == 0);
    // A ceiling in the answer of the approved use: a key applies no ceiling (7.5). The tool does not run, and the protocol answers 403.
    AccessDecision limited = yes(0);
    limited.limits["max_rows"] = 10;
    rig.script.answers = {limited};
    called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})");
    CHECK(called.http_status == 403 && called.rpc_error == -32001);
    CHECK_EQ(rig.inner.run.size(), size_t(1));
    // The refusals: denied and expired are tool errors; a PDP that fails is HTTP 503.
    rig.script.answers = {no(PdpReason::ApprovalDenied)};
    CHECK_EQ(code_of(tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})").outcome), std::string("approval_denied"));
    rig.script.answers = {no(PdpReason::ApprovalExpired)};
    CHECK_EQ(code_of(tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})").outcome), std::string("approval_expired"));
    rig.script.answers = {failed()};
    called = tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})");
    CHECK(called.http_status == 503 && called.rpc_error == -32603);
    // The submission fails (no device): approval_unavailable, retryable.
    rig.script.answers = {no(PdpReason::ApprovalRequired, "ev-2")};
    rig.script.submit_reply.status = PdpApprovalReply::Status::NoDevice;
    CHECK_EQ(code_of(tools_call(backend, "list_databases", R"({"host":"prod","lease_s":900})").outcome), std::string("approval_unavailable"));
  }

  // get_action_status: the verdict of the request of the creator, renewed, with no question to the PDP.
  {
    KeysRig rig;
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    rig.script.verdict_reply.verdict = PdpVerdict::Approved;
    const size_t before = rig.pdp.asked.size();
    McpRpcResult called = tools_call(backend, "get_action_status", R"({"request_id":"apr_1"})");
    rapidjson::Document doc = args_of(called.body);
    CHECK(!doc["result"].HasMember("isError"));
    CHECK_EQ(std::string(doc["result"]["structuredContent"]["status"].GetString()), std::string("approved"));
    CHECK(rig.script.reads.size() == 1 && rig.script.reads[0].subject == "alice" && rig.script.reads[0].renew);
    CHECK_EQ(rig.pdp.asked.size(), before);
    called = tools_call(backend, "get_action_status", R"({"request_id":"apr_1","host":"prod"})");
    CHECK_EQ(code_of(called.outcome), std::string("invalid_argument"));
    // A key with no creator never gets here: the protocol refuses it before. The gate answers Denied.
    McpKey orphan = key;
    orphan.creator.clear();
    CHECK(rig.creators.status(orphan, args_of(R"({"request_id":"apr_1"})"), nullptr) == McpAccess::Denied);
  }

  // run_query is a use with a budget: the first question has usage, and the approval flow starts on its reason of 17.1.
  {
    KeysRig rig;
    rig.pdp.by_action["query.run.read"] = no(PdpReason::ApprovalRequired);
    rig.script.answers = {no(PdpReason::ApprovalRequired, "ev-q")};
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    McpRpcResult called = tools_call(backend, "run_query", R"({"host":"prod","sql":"SELECT 1","lease_s":900})");
    rapidjson::Document doc = args_of(called.body);
    CHECK_EQ(std::string(doc["result"]["structuredContent"]["action"]["status"].GetString()), std::string("awaiting_approval"));
    CHECK(rig.pdp.asked_use.size() == 1 && rig.pdp.asked_use[0] == "query.run.read@service:db/host:prod");
    CHECK(rig.pdp.asked.empty() || rig.pdp.asked.back().rfind("query.run.read", 0) != 0);
    CHECK(rig.script.asked.size() == 1 && !rig.script.asked[0].usage);
    CHECK(rig.script.submitted.back().op_json.find("\"sql\":\"SELECT 1\"") != std::string::npos);
    CHECK(rig.script.submitted.back().op_json.find("\"ch_user\":\"chdash_mcp\"") != std::string::npos);
    // Approved: the question with usage and the effect, then the tool runs.
    rig.script.answers = {yes(0), yes(1)};
    called = tools_call(backend, "run_query", R"({"host":"prod","sql":"SELECT 1","lease_s":900})");
    CHECK_EQ(rig.inner.run.size(), size_t(1));
    CHECK(rig.script.asked.back().usage);
    // A spent budget on the approved use: the tool error of the budget, with retry_after.
    AccessDecision spent = no(PdpReason::BudgetExceeded);
    spent.retry_after = 9;
    rig.script.answers = {spent};
    called = tools_call(backend, "run_query", R"({"host":"prod","sql":"SELECT 1","lease_s":900})");
    CHECK_EQ(code_of(called.outcome), std::string("budget_exceeded"));
    CHECK_EQ(rig.inner.run.size(), size_t(1));
  }

  // A key of two hosts: the standing check of the other host does not decide the call, and the host of the call gives the resource.
  {
    KeysRig rig;
    McpKey two = key;
    two.hosts = {"prod", "ro"};
    rig.pdp.by_action["explorer.read"] = no(PdpReason::ApprovalRequired);
    rig.script.answers = {no(PdpReason::ApprovalRequired, "ev-2")};
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(two));
    McpRpcResult called = send(backend, two, "tools/call", std::string(R"({"name":"list_databases","arguments":{"host":"ro","lease_s":60},)") + kMeta + "}", "list_databases");
    CHECK_EQ(called.outcome.approval, std::string("awaiting"));
    CHECK_EQ(rig.script.asked.back().resource, std::string("service:db/host:ro"));
    // No host with two hosts: the tool runs nothing (host_required), so no approval is asked.
    const size_t submitted = rig.script.submitted.size();
    called = send(backend, two, "tools/call", std::string(R"({"name":"list_databases","arguments":{"lease_s":60},)") + kMeta + "}", "list_databases");
    CHECK_EQ(rig.script.submitted.size(), submitted);
    CHECK_EQ(rig.inner.run.size(), size_t(1));
  }

  // F02: a key that reaches two databases that each need an approval. A call that names no database has two candidates and no effect can name it:
  // the agent gets a tool error that tells what to change, never the answer for an unknown tool (-32602).
  {
    KeysRig rig;
    McpKey scoped = key;
    scoped.databases = {"a.*", "b.*"};
    scoped.tools = {"list_databases", "list_tables", "list_hosts"};
    rig.pdp.by_action["explorer.read"] = no(PdpReason::ApprovalRequired);
    rig.script.answers = {no(PdpReason::ApprovalRequired, "ev-db")};
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(scoped));
    McpRpcResult called = send(backend, scoped, "tools/call",
                               std::string(R"({"name":"list_tables","arguments":{"host":"prod","lease_s":900},)") + kMeta + "}", "list_tables");
    CHECK(called.rpc_error == 0 && called.outcome.is_error && code_of(called.outcome) == "invalid_argument");
    CHECK(called.outcome.json.find("argument database") != std::string::npos);
    CHECK(rig.script.submitted.empty() && rig.inner.run.empty());
    // The call that names one database is the operation: the approval flow runs for it.
    called = send(backend, scoped, "tools/call",
                  std::string(R"({"name":"list_tables","arguments":{"host":"prod","database":"a","lease_s":900},)") + kMeta + "}", "list_tables");
    CHECK_EQ(called.outcome.approval, std::string("awaiting"));
    CHECK_EQ(rig.script.asked.back().resource, std::string("service:db/host:prod/database:a"));
    // A tool that names no database cannot be covered by one approval: its message says so.
    called = send(backend, scoped, "tools/call", std::string(R"({"name":"list_databases","arguments":{"host":"prod","lease_s":900},)") + kMeta + "}",
                  "list_databases");
    CHECK(called.rpc_error == 0 && code_of(called.outcome) == "invalid_argument");
    CHECK(called.outcome.json.find("names no database") != std::string::npos);
  }

  // A08: the state of a key is a question for the display (the match subtree, ProcurAuth 4.4): the tool of a creator whose grant has a ceiling stays
  // listed. The call has the match node, and a key applies no ceiling: the call is refused there.
  {
    KeysRig rig;
    AccessDecision with_ceiling = yes(0);
    with_ceiling.limits["max_rows"] = 5;
    rig.pdp.by_action["explorer.read"] = with_ceiling;
    const McpCreatorState state = rig.creators.state(key);
    CHECK(std::find(state.tools.begin(), state.tools.end(), "list_databases") != state.tools.end());
    // (The server applies the rule of the ceiling in its function of decisions: the call is refused there, tests/backend-functional/test_access.py.)
  }

  // A tool that uses no action asks the PDP nothing, and takes the controls without a result of the approval.
  {
    KeysRig rig;
    McpCreatorTools backend(rig.inner, rig.creators, rig.creators.state(key));
    const size_t before = rig.pdp.asked.size();
    McpRpcResult called = tools_call(backend, "list_hosts", R"({"lease_s":10})");
    CHECK(called.rpc_error == 0 && rig.inner.run.size() == 1 && rig.inner.arguments[0].find("lease_s") == std::string::npos);
    CHECK_EQ(rig.pdp.asked.size(), before);
  }

  // The state of the key: a reason of 17.1 is a grant that needs a confirmation, not a missing grant.
  {
    KeysRig rig;
    for (const char* action : {"explorer.read", "system.read", "query.run.read"}) rig.pdp.by_action[action] = no(PdpReason::ApprovalRequired);
    const McpCreatorState state = rig.creators.state(key);
    CHECK(state.status == McpCreatorStatus::Active);
    CHECK(std::find(state.tools.begin(), state.tools.end(), "system_overview") != state.tools.end());
    CHECK(std::find(state.tools.begin(), state.tools.end(), "run_query") != state.tools.end());
    // A denial of another kind is still a missing grant.
    rig.pdp.by_action["system.read"] = no(PdpReason::None);
    const McpCreatorState refused = rig.creators.state(key);
    CHECK(std::find(refused.tools.begin(), refused.tools.end(), "system_overview") == refused.tools.end());
    CHECK(rig.creators.tool_refused_action(key, *mcp_find_tool("list_databases")).empty());
  }
}

} // namespace


// ---- the alignment of 1.5.0 --------------------------------------------------------------------------------------------------------------

// The metadata members procurauth_approval_* (ProcurAuth 17.4, 17.5): read when they are whole numbers, ignored otherwise, never needed.
void test_pdp_metadata_approval_limits() {
  const std::string base = R"({"policy_decision_point":"http://pdp.test","access_evaluation_endpoint":"http://pdp.test/access/v1/evaluation",)"
                           R"("access_evaluations_endpoint":"http://pdp.test/access/v1/evaluations")";
  PdpEndpoints none;
  std::string error;
  CHECK(PdpClient::parse_metadata(base + "}", "http://pdp.test", &none, &error));
  CHECK(!none.approval_max_command_bytes && !none.approval_lease_min_seconds && !none.approval_lease_max_seconds && !none.approval_wait_max_seconds);
  PdpEndpoints all;
  CHECK(PdpClient::parse_metadata(base + R"(,"procurauth_approval_max_command_bytes":8192,"procurauth_approval_lease_min_seconds":30,)"
                                         R"("procurauth_approval_lease_max_seconds":3600,"procurauth_approval_wait_max_seconds":25,"procurauth_approval_grace_seconds":120})",
                                  "http://pdp.test", &all, &error));
  CHECK(all.approval_max_command_bytes == 8192u && all.approval_lease_min_seconds == 30u && all.approval_lease_max_seconds == 3600u &&
        all.approval_wait_max_seconds == 25u);
  // A member of another form is ignored: the approval never stops ChDash.
  PdpEndpoints bad;
  CHECK(PdpClient::parse_metadata(base + R"(,"procurauth_approval_max_command_bytes":"big","procurauth_approval_lease_min_seconds":0,"procurauth_approval_lease_max_seconds":-1})",
                                  "http://pdp.test", &bad, &error));
  CHECK(!bad.approval_max_command_bytes && !bad.approval_lease_min_seconds && !bad.approval_lease_max_seconds);
}

McpApprovalPorts ports_with_limits(Script& script, PdpApprovalLimits limits) {
  McpApprovalPorts ports = script.ports();
  ports.limits = [limits] { return limits; };
  return ports;
}

void test_gate_published_bounds() {
  const std::string base_call = std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":)";
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  {
    // The bound of the PDP is lower than the configuration: the command that fits the configuration is refused before it goes out.
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    PdpApprovalLimits limits;
    limits.max_command_bytes = 120;
    McpApprovalGate gate(make_config(), ports_with_limits(script, limits));
    CHECK_EQ(gate.max_command_bytes(), int64_t(120));
    McpCallInfo info;
    gate.call("key:k1", write_tool(), q, true, args_of(base_call + "900}"), &info, approval_first());
    CHECK(info.answered && info.answered->is_error && code_of(*info.answered) == "invalid_argument");
    CHECK_EQ(script.submitted.size(), size_t(0));
    // The configuration is the lower one: the bound of the PDP does not raise it.
    PdpApprovalLimits high;
    high.max_command_bytes = 1048576;
    Script other;
    McpApprovalGate gate2(make_config(), ports_with_limits(other, high));
    CHECK_EQ(gate2.max_command_bytes(), int64_t(16384));
  }
  {
    // A lease outside the bounds of the PDP: a tool error that names the bounds, and nothing goes to the approval API.
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    PdpApprovalLimits limits;
    limits.lease_min_seconds = 30;
    limits.lease_max_seconds = 3600;
    limits.wait_max_seconds = 5;
    McpApprovalGate gate(make_config(), ports_with_limits(script, limits));
    const McpApprovalBounds bounds = gate.bounds();
    CHECK(bounds.lease_min_seconds == 30u && bounds.lease_max_seconds == 3600u);
    CHECK_EQ(bounds.wait_max_seconds.value_or(0), uint64_t(5));  // the lower of access.approval.wait (15) and the PDP (5)
    for (const char* lease : {"10}", "7200}"}) {
      McpCallInfo info;
      gate.call("key:k1", write_tool(), q, true, args_of(base_call + lease), &info, approval_first());
      CHECK(info.answered && info.answered->is_error && code_of(*info.answered) == "invalid_argument");
      CHECK(info.answered->json.find("30 to 3600") != std::string::npos);
    }
    CHECK_EQ(script.submitted.size(), size_t(0));
    McpCallInfo ok;
    gate.call("key:k1", write_tool(), q, true, args_of(base_call + "60}"), &ok, approval_first());
    CHECK(ok.answered && !ok.answered->is_error);
    CHECK_EQ(script.submitted.size(), size_t(1));
  }
  {
    // The schema of each tool shows the bounds to the agent.
    const std::string schema = mcp_with_approval_properties(R"({"type":"object","properties":{}})", McpApprovalBounds{30, 3600, 15});
    const rapidjson::Document doc = args_of(schema);
    CHECK(doc["properties"]["lease_s"]["minimum"].GetInt64() == 30 && doc["properties"]["lease_s"]["maximum"].GetInt64() == 3600);
    CHECK(doc["properties"]["wait_s"]["maximum"].GetInt64() == 15);
    const rapidjson::Document plain = args_of(mcp_with_approval_properties(R"({"type":"object","properties":{}})"));
    CHECK(plain["properties"]["lease_s"]["minimum"].GetInt64() == 1 && !plain["properties"]["lease_s"].HasMember("maximum"));
  }
}

void test_gate_approval_api_faults() {
  const std::string call_text = std::string(R"({"host":"prod","sql":")") + kCreate + R"(","lease_s":900})";
  const AccessQuestion q{"query.run.write", access_host_resource("db", "prod")};
  const auto run = [&](PdpApprovalReply::Status status, std::vector<AccessDecision> answers) {
    Script script;
    script.answers = std::move(answers);
    script.submit_reply.status = status;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    const McpGateResult r = gate.call("key:k1", write_tool(), q, true, args_of(call_text), &info, approval_first());
    return std::make_tuple(r.access, info.answered ? code_of(*info.answered) : std::string("-"), script.submitted.size(), script.asked.size());
  };
  // The faults of the agent are tool errors with a fixed text, never an outage (HTTP 503).
  for (const auto status : {PdpApprovalReply::Status::ExplanationRequired, PdpApprovalReply::Status::CannotSupersede}) {
    const auto [access, code, submitted, asked] = run(status, {no(PdpReason::ApprovalRequired, "ev")});
    CHECK(access == McpAccess::Allowed && code == "invalid_argument" && submitted == 1u);
    (void)asked;
  }
  {
    Script script;
    script.answers = {no(PdpReason::ApprovalRequired, "ev")};
    script.submit_reply.status = PdpApprovalReply::Status::ExplanationRequired;
    McpApprovalGate gate(make_config(), script.ports());
    McpCallInfo info;
    gate.call("key:k1", write_tool(), q, true, args_of(call_text), &info, approval_first());
    CHECK(info.answered && info.answered->json.find("approval_ref") != std::string::npos);
  }
  // A late evaluation_id: the call asks once more, and a second refusal is approval_expired (a tool error, not an outage).
  {
    const auto [access, code, submitted, asked] = run(PdpApprovalReply::Status::InvalidEvaluation, {no(PdpReason::ApprovalRequired, "ev")});
    CHECK(access == McpAccess::Allowed && code == "approval_expired");
    CHECK_EQ(submitted, size_t(2));
    CHECK_EQ(asked, size_t(2));
  }
}

void test_view_limits_and_caps() {
  const McpToolInfo& run_query = *mcp_find_tool("run_query");
  const McpApprovalHost host{"prod", "reader", "writer", true};
  // 17.3a: the caps are in the op of a tool that runs SQL, and an op with no caps has none.
  const rapidjson::Document args = args_of(R"({"host":"prod","sql":"SELECT 1"})");
  const McpOpView plain = mcp_op_view(run_query, &host, args, "");
  CHECK(plain.op_json.find("max_rows") == std::string::npos);
  const McpOpView capped = mcp_op_view(run_query, &host, args, "", McpOpCaps{1000, 1048576, 30});
  rapidjson::Document op = args_of(capped.op_json);
  CHECK(op["max_rows"].GetInt64() == 1000 && op["max_result_bytes"].GetInt64() == 1048576 && op["timeout_seconds"].GetInt64() == 30);
  // The write tool has a time limit and no row cap. A tool that runs no SQL has none of the three.
  const McpOpView written = mcp_op_view(write_tool(), &host, args_of(R"({"host":"prod","sql":"x"})"), kCreate, McpOpCaps{1000, 1048576, 30});
  op = args_of(written.op_json);
  CHECK(!op.HasMember("max_rows") && !op.HasMember("max_result_bytes") && op["timeout_seconds"].GetInt64() == 30);
  const McpOpView hosts = mcp_op_view(*mcp_find_tool("list_hosts"), nullptr, args_of("{}"), "", McpOpCaps{1000, 1048576, 30});
  CHECK(hosts.op_json.find("max_rows") == std::string::npos && hosts.op_json.find("timeout_seconds") == std::string::npos);
  const McpOpView tables = mcp_op_view(*mcp_find_tool("list_tables"), &host, args_of(R"({"host":"prod"})"), "", McpOpCaps{1000, 1048576, 30});
  op = args_of(tables.op_json);
  CHECK(op["max_rows"].GetInt64() == 1000 && op["timeout_seconds"].GetInt64() == 30);
  const McpOpView api = mcp_op_view(*mcp_find_tool("system_overview"), &host, args_of(R"({"host":"prod"})"), "", McpOpCaps{1000, 1048576, 30});
  op = args_of(api.op_json);
  CHECK(!op.HasMember("max_rows") && op["max_result_bytes"].GetInt64() == 1048576);

  // Contract 9.5: the title 128 characters, a field value 256 characters, the body 16 KiB. A part that is too large is refused, never cut.
  CHECK(mcp_view_limit_error(capped.op_json, capped.view_json).empty());
  const std::string big_sql(16 * 1024, 'x');
  const McpOpView big = mcp_op_view(run_query, &host, args_of("{\"host\":\"prod\",\"sql\":\"" + big_sql + "\"}"), "");
  CHECK(mcp_view_limit_error(big.op_json, big.view_json).empty());  // exactly 16 KiB fits
  const McpOpView over = mcp_op_view(run_query, &host, args_of("{\"host\":\"prod\",\"sql\":\"" + big_sql + "x\"}"), "");
  CHECK(mcp_view_limit_error(over.op_json, over.view_json).find("16 KiB") != std::string::npos);
  const McpOpView long_option = mcp_op_view(*mcp_find_tool("explain_query"), &host, args_of("{\"host\":\"prod\",\"sql\":\"SELECT 1\",\"type\":\"" + std::string(300, 'a') + "\"}"), "");
  CHECK(mcp_view_limit_error(long_option.op_json, long_option.view_json).find("256 characters") != std::string::npos);
  CHECK(mcp_view_limit_error(R"({"tool":"t"})", R"({"title":")" + std::string(129, 'a') + R"("})").find("128 characters") != std::string::npos);
  CHECK(mcp_view_limit_error(R"({"tool":"t"})", R"({"title":")" + std::string(128, 'a') + R"("})").empty());
  // A character is not a byte: 128 two-byte characters fit in the title.
  std::string accents;
  for (int i = 0; i < 128; ++i) accents += "\xC3\xA9";
  CHECK(mcp_view_limit_error(R"({"tool":"t"})", R"({"title":")" + accents + R"("})").empty());

  // The gate refuses a body that is above 16 KiB even when max_command_bytes is higher.
  Script script;
  script.answers = {no(PdpReason::ApprovalRequired, "ev")};
  McpApprovalConfig config = make_config();
  config.max_command_bytes = 1048576;
  config.max_sql_bytes = 1048576;
  McpApprovalGate gate(config, script.ports());
  McpCallInfo info;
  gate.call("key:k1", *mcp_find_tool("run_query"), {"query.run.read", access_host_resource("db", "prod")}, true,
            args_of("{\"host\":\"prod\",\"sql\":\"" + big_sql + "x\",\"lease_s\":900}"), &info, approval_first());
  CHECK(info.answered && info.answered->is_error && code_of(*info.answered) == "invalid_argument" && script.submitted.empty());
  CHECK(info.answered->json.find("16 KiB") != std::string::npos);
}

void test_library_write_tool() {
  const McpToolInfo* library = mcp_find_approval_tool("library_write");
  CHECK(library != nullptr);
  CHECK_EQ(std::string(mcp_tool_access_action(*library)), std::string("library.write"));
  CHECK_EQ(std::string(mcp_tool_identity_action(*library)), std::string("library.write"));
  Script script;
  McpApprovalConfig config = make_config();
  McpApprovalGate without(config, script.ports());
  const auto names = without.tool_names();
  CHECK(std::find(names.begin(), names.end(), std::string(kMcpLibraryWriteTool)) == names.end());
  config.library_writable = true;
  McpApprovalGate with(config, script.ports());
  const auto offered = with.tool_names();
  CHECK(std::find(offered.begin(), offered.end(), std::string(kMcpLibraryWriteTool)) != offered.end());
  // The approval: the op holds the whole call (the operation and the body), so the owner reads what will change.
  script.answers = {no(PdpReason::ApprovalRequired, "ev")};
  McpCallInfo info;
  with.call("key:k1", *library, {"library.write", access_service_resource("db")}, false,
            args_of(R"({"host":"prod","operation":"query_create","body":{"name":"q","sql":"SELECT 1"},"lease_s":900})"), &info, approval_first());
  CHECK(info.answered && !info.answered->is_error);
  CHECK_EQ(script.submitted.size(), size_t(1));
  const rapidjson::Document op = args_of(script.submitted[0].op_json);
  CHECK_EQ(std::string(op["tool"].GetString()), std::string("library_write"));
  CHECK(std::string(op["arguments"].GetString()).find("\"operation\":\"query_create\"") != std::string::npos);
  CHECK(std::string(op["arguments"].GetString()).find("SELECT 1") != std::string::npos && !op.HasMember("max_rows"));
  // The schema asks for the host and the operation, and the annotations are those of a tool with an effect.
  const rapidjson::Document schema = args_of(mcp_approval_tool_schema("library_write"));
  CHECK(schema["required"].Size() == 2 && schema["properties"]["operation"]["enum"].Size() == 7);
  const rapidjson::Document annotations = args_of(mcp_approval_tool_annotations(*library));
  CHECK(!annotations["readOnlyHint"].GetBool() && annotations["openWorldHint"].GetBool() && annotations["destructiveHint"].GetBool());
}

// Contract 4.4 and 4.5: the description of each tool tells the four facts, and each tool has an outputSchema with the action object of 9.4.
void test_descriptions_and_output_schemas() {
  InnerBackend inner;
  Script script;
  McpApprovalConfig config = make_config();
  config.library_writable = true;
  PdpApprovalLimits limits;
  limits.lease_min_seconds = 30;
  limits.lease_max_seconds = 600;
  McpApprovalGate gate(config, ports_with_limits(script, limits));
  McpSubjectAccess access("db", {"prod", "ro"}, AccessFeatures{}, [](const std::string&, const std::vector<AccessQuestion>& questions) {
    std::vector<AccessDecision> out;
    for (size_t i = 0; i < questions.size(); ++i) out.push_back(yes(0));
    return out;
  });
  access.set_approval(&gate);
  McpSubjectTools backend(inner, access);
  const McpKey key = mcp_identity_key("key:k1");
  const McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
  const rapidjson::Document doc = args_of(listed.body);
  size_t checked = 0;
  for (const auto& tool : doc["result"]["tools"].GetArray()) {
    const std::string name = tool["name"].GetString();
    CHECK(tool.HasMember("outputSchema"));
    const rapidjson::Value& properties = tool["outputSchema"]["properties"];
    CHECK(properties.HasMember("action") && properties["action"]["properties"]["status"]["enum"][0].GetString() == std::string("awaiting_approval"));
    CHECK(properties.HasMember("error"));
    if (name == "get_action_status") {
      CHECK(properties.HasMember("status") && properties["status"]["enum"].Size() == 4);
      continue;
    }
    const std::string description = tool["description"].GetString();
    for (const char* fact : {"can need to approve", "awaiting_approval", "executed false", "same arguments", "get_action_status"}) CHECK(description.find(fact) != std::string::npos);
    CHECK(tool["inputSchema"]["properties"]["lease_s"]["minimum"].GetInt64() == 30 && tool["inputSchema"]["properties"]["lease_s"]["maximum"].GetInt64() == 600);
    ++checked;
  }
  CHECK(checked > 20);
  // The text of the result that waits names no tool of another party.
  CHECK(mcp_approval_awaiting("apr_1", "K7QF").extra_text.find("portal") == std::string::npos);
  CHECK(listed.body.find("approval_intent") == std::string::npos);
}

// Binding 5.7b: tools/list names get_action_status only when it names at least one other tool.
void test_status_tool_needs_another_tool() {
  InnerBackend inner;
  Script script;
  McpApprovalGate gate(make_config(), script.ports());
  McpSubjectAccess access("db", {"prod"}, AccessFeatures{}, [](const std::string&, const std::vector<AccessQuestion>& questions) {
    std::vector<AccessDecision> out(questions.size());  // every answer is false
    return out;
  });
  access.set_approval(&gate);
  McpSubjectTools backend(inner, access);
  const McpKey key = mcp_identity_key("key:k1");
  const McpRpcResult listed = send(backend, key, "tools/list", std::string("{") + kMeta + "}");
  CHECK(args_of(listed.body)["result"]["tools"].Size() == 0u);
}

// export_query needs a second permission (5.5a): the arguments and the controls come first (contract 9.4, step 1 and 2), and the ceilings of
// the other permission lower the ceilings of the call.
void test_export_other_permission_order_and_ceilings() {
  Script script;
  McpApprovalGate gate(make_config(), script.ports());
  std::vector<std::string> asked;
  bool scope_marked = true;  // every question of the other permission has permission_only (5.5a)
  bool use_marked = false;   // the question of the use never has it
  AccessDecision other = yes(0);
  other.limits["max_rows_read"] = 500;
  other.limits["max_duration"] = 7;
  AccessDecision own = yes(1);
  own.limits["max_rows_read"] = 900;
  own.limits["max_rows"] = 50;
  McpSubjectAccess access(
      "db", {"prod"}, AccessFeatures{},
      [&](const std::string&, const std::vector<AccessQuestion>& questions) {
        std::vector<AccessDecision> out;
        for (const auto& q : questions) {
          asked.push_back(q.action);
          scope_marked = scope_marked && q.permission_only;
          out.push_back(q.action == "query.run.read" ? other : yes(0));
        }
        return out;
      },
      [&](const std::string&, const AccessQuestion& q) {
        asked.push_back(q.action + "+usage");
        use_marked = use_marked || q.permission_only;
        return own;
      });
  access.set_approval(&gate);
  const McpToolInfo& exporter = *mcp_find_approval_tool("export_query");
  {
    // A bad control argument asks the PDP nothing, not even the other permission.
    McpCallInfo info;
    const McpAccess access_result = access.call("alice", exporter, args_of(R"({"host":"prod","sql":"SELECT 1","lease_s":0})"), &info);
    CHECK(access_result == McpAccess::Allowed && info.answered && code_of(*info.answered) == "invalid_argument");
    CHECK(asked.empty());
  }
  {
    // A good call: the other permission first, then the use. The lowest value of each ceiling applies.
    McpCallInfo info;
    const McpAccess access_result = access.call("alice", exporter, args_of(R"({"host":"prod","sql":"SELECT 1"})"), &info);
    CHECK(access_result == McpAccess::Allowed && !info.answered);
    CHECK_EQ(asked.size(), size_t(2));
    CHECK(asked.size() == 2 && asked[0] == "query.run.read" && asked[1] == "query.export+usage");
    CHECK(info.ceilings.max_rows_read == 500 && info.ceilings.max_duration_seconds == 7 && info.ceilings.max_rows == 50);
    CHECK(scope_marked && !use_marked);
  }
  {
    // Spec question 53: the approval follows the action of the use alone. A PDP of the protocol never gives a reason of 17.1 for a question with
    // permission_only. A PDP that does (a fault) starts no approval: the call is refused with a tool error, and the PDP gets no question with an effect.
    asked.clear();
    other.limits.clear();
    other.allowed = false;
    other.reason = PdpReason::ApprovalRequired;
    McpCallInfo info;
    const McpAccess refused = access.call("alice", exporter, args_of(R"({"host":"prod","sql":"SELECT 1","lease_s":900})"), &info);
    CHECK(refused == McpAccess::Allowed && info.answered && info.answered->is_error && code_of(*info.answered) == "scope_needs_approval");
    CHECK(script.submitted.empty() && script.asked.empty());
    CHECK_EQ(asked.size(), size_t(1));  // only the question of the other permission
    // A plain false for the other permission stays the answer of a tool that does not exist.
    other.reason = PdpReason::None;
    McpCallInfo plain;
    CHECK(access.call("alice", exporter, args_of(R"({"host":"prod","sql":"SELECT 1"})"), &plain) == McpAccess::Denied && !plain.answered);
    other.allowed = true;
    other.limits["max_rows_read"] = 500;
  }
  {
    // A ceiling that the other action does not declare makes its answer false (ProcurAuth 7.5).
    asked.clear();
    other.limits["max_nothing"] = 1;
    McpCallInfo info;
    CHECK(access.call("alice", exporter, args_of(R"({"host":"prod","sql":"SELECT 1"})"), &info) == McpAccess::Denied);
  }
}

// The keys of the action document and the tools of the endpoint agree in each mode (contract 4.4 and ProcurAuth 5.2b: each published action is
// approvable, so a tool serves it). A feature, a write account or a library that the configuration does not give has no tool and no action.
void test_actions_and_tools_agree() {
  size_t configurations = 0;
  // 3 states of the library, 2 of the Explorer, 2 of the System page, 2 of the observability, 3 of the hosts, 3 of the usage.
  for (int library = 0; library < 3; ++library) {
    for (int explorer = 0; explorer < 2; ++explorer) {
      for (int system = 0; system < 2; ++system) {
        for (int observability = 0; observability < 2; ++observability) {
          for (int hosts = 0; hosts < 3; ++hosts) {  // none, a host that reads, a host that also has a write account
            for (int usage = 0; usage < 3; ++usage) {  // off, on, on with all_keys
              AccessFeatureInputs in;
              in.query_library = library > 0;
              in.query_library_writable = library == 2;
              in.explorer = explorer == 1;
              in.system = system == 1;
              in.observability = observability == 1;
              in.mcp = true;
              in.mcp_identity = true;
              in.any_mcp_host = hosts > 0;
              in.any_mcp_write_host = hosts == 2;
              in.usage = usage > 0;
              in.usage_all_keys = usage == 2;
              const AccessFeatures features = access_features_for(in);
              std::set<std::string> declared;
              for (const auto& action : access_published_actions(features)) declared.insert(action.name);

              struct Backend : InnerBackend {
                McpToolAvailability availability_value;
                McpToolAvailability availability() const override { return availability_value; }
              } available;
              available.availability_value.usage = in.usage;
              available.availability_value.all_keys = in.usage_all_keys;
              Script script;
              McpApprovalConfig config = make_config();
              config.hosts.clear();
              if (hosts > 0) config.hosts.push_back(McpApprovalHost{"prod", "reader", hosts == 2 ? "writer" : "", hosts == 2});
              config.library_writable = features.query_library_writable;
              McpApprovalGate gate(config, script.ports());
              McpSubjectAccess access(
                  "db", {"prod"}, features,
                  [](const std::string&, const std::vector<AccessQuestion>& questions) {
                    std::vector<AccessDecision> out;
                    for (size_t i = 0; i < questions.size(); ++i) out.push_back(yes(0));
                    return out;
                  });
              access.set_approval(&gate);
              McpSubjectTools backend(available, access);
              const McpRpcResult listed = send(backend, mcp_identity_key("alice"), "tools/list", std::string("{") + kMeta + "}");
              const rapidjson::Document doc = args_of(listed.body);
              std::set<std::string> served;
              for (const auto& tool : doc["result"]["tools"].GetArray()) {
                const std::string name = tool["name"].GetString();
                if (name == kMcpStatusTool) continue;
                const McpToolInfo* info = mcp_find_tool(name);
                if (!info) info = mcp_find_approval_tool(name);
                CHECK(info != nullptr);
                if (!info) continue;
                const std::string action = mcp_tool_identity_action(*info);
                // Every tool names a declared action (or mcp.session).
                CHECK(declared.count(action) == 1);
                if (declared.count(action) == 0) std::fprintf(stderr, "tool %s names the action %s that the document does not declare\n", name.c_str(), action.c_str());
                served.insert(action);
              }
              // Every declared action has a tool. The identity mode has no action without one.
              for (const auto& action : declared) {
                // mcp.session is the action of the requests that call no tool (initialize, ping, notifications): no tool serves it.
                if (action == "mcp.session") continue;
                CHECK(served.count(action) == 1);
                if (served.count(action) == 0) std::fprintf(stderr, "the action %s has no tool (library %d explorer %d system %d observability %d hosts %d usage %d)\n", action.c_str(), library, explorer, system, observability, hosts, usage);
              }
              // The actions that no tool can serve are not declared.
              CHECK((declared.count("library.write") == 1) == (library == 2));
              CHECK((declared.count("query.run.write") == 1) == (hosts == 2));
              CHECK((declared.count("query.export") == 1) == (hosts > 0));
              CHECK((declared.count("mcp.usage.read") == 1) == (usage == 2));
              CHECK(declared.count("mcp.keys.read") == 0 && declared.count("mcp.keys.write") == 0);
              // The tools that read no data of a host have an action of their own, and mcp.session is never the action of a tool.
              CHECK(declared.count("mcp.hosts.read") == 1 && declared.count("mcp.analysis.read") == 1 && served.count("mcp.session") == 0);
              ++configurations;
            }
          }
        }
      }
    }
  }
  CHECK_EQ(configurations, size_t(3 * 2 * 2 * 2 * 3 * 3));

  // The mode keys: a key of the page has the tools of the catalog and get_action_status. The actions of the page of the keys (mcp.keys.read,
  // mcp.keys.write) and the page of the usage have no tool: they are routes of the page, and a route of a page cannot wait (ProcurAuth 17.7a).
  // A write, an export and a library write are not declared: no tool of the mode serves them.
  for (int usage = 0; usage < 3; ++usage) {
    AccessFeatureInputs in;
    in.query_library = true;
    in.query_library_writable = true;
    in.mcp = true;
    in.mcp_identity = false;
    in.any_mcp_host = true;
    in.any_mcp_write_host = true;
    in.usage = usage > 0;
    in.usage_all_keys = usage == 2;
    const AccessFeatures features = access_features_for(in);
    std::set<std::string> declared;
    for (const auto& action : access_published_actions(features)) declared.insert(action.name);
    CHECK(declared.count("query.run.write") == 0 && declared.count("query.export") == 0 && declared.count("library.write") == 0 && declared.count("mcp.session") == 0);
    // The mode keys has no action for these tools (the creator of a key has no PDP question for them).
    CHECK(declared.count("mcp.hosts.read") == 0 && declared.count("mcp.analysis.read") == 0);
    McpToolAvailability availability;
    availability.usage = in.usage;
    availability.all_keys = in.usage_all_keys;
    std::set<std::string> served;
    for (const auto& name : mcp_effective_tools({"*", "mcp_analysis_all_usage"}, {"*"}, availability)) {
      if (const McpToolInfo* info = mcp_find_tool(name)) {
        const char* action = mcp_tool_access_action(*info);
        if (action) served.insert(action);
      }
    }
    const std::set<std::string> page_only = {"mcp.keys.read", "mcp.keys.write", "mcp.usage.read"};
    for (const auto& action : declared) {
      if (page_only.count(action)) continue;
      CHECK(served.count(action) == 1);
      if (served.count(action) == 0) std::fprintf(stderr, "mode keys: the action %s has no tool\n", action.c_str());
    }
    CHECK((declared.count("mcp.usage.read") == 1) == (usage > 0));
  }
  // MCP off: no tool exists, and the pages publish what they serve (they cannot wait, ProcurAuth 17.7a).
  AccessFeatureInputs off;
  off.query_library = true;
  off.query_library_writable = true;
  const AccessFeatures no_mcp = access_features_for(off);
  std::set<std::string> pages;
  for (const auto& action : access_published_actions(no_mcp)) pages.insert(action.name);
  CHECK(pages.count("query.run.write") == 1 && pages.count("query.export") == 1 && pages.count("library.write") == 1);
  CHECK(pages.count("mcp.keys.read") == 0 && pages.count("mcp.usage.read") == 0 && pages.count("mcp.session") == 0);
}

int main(int argc, char** argv) {
  const std::string vectors = argc > 1 ? argv[1] : "/work/tests/conformance/effect-vectors.json";
  test_effect_vectors(vectors);
  RUN(test_jcs);
  RUN(test_client_question_and_answers);
  RUN(test_client_never_keeps_an_approval_reason);
  RUN(test_approval_api);
  RUN(test_gate_awaiting_and_pending);
  RUN(test_gate_denied_and_expired);
  RUN(test_gate_run_once_and_questions);
  RUN(test_gate_fail_closed_and_mapping);
  RUN(test_gate_write_statement_and_host);
  RUN(test_export_tool);
  RUN(test_gate_effects_follow_the_arguments);
  RUN(test_gate_wait_and_status);
  RUN(test_the_request_to_the_pdp_has_no_text_of_the_agent);
  RUN(test_log_has_no_text_of_the_approval);
  RUN(test_protocol_with_the_gate);
  RUN(test_protocol_without_the_gate);
  RUN(test_keys_mode_approval);
  RUN(test_pdp_metadata_approval_limits);
  RUN(test_gate_published_bounds);
  RUN(test_gate_approval_api_faults);
  RUN(test_view_limits_and_caps);
  RUN(test_library_write_tool);
  RUN(test_descriptions_and_output_schemas);
  RUN(test_status_tool_needs_another_tool);
  RUN(test_export_other_permission_order_and_ceilings);
  RUN(test_actions_and_tools_agree);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
