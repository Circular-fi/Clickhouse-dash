#pragma once

// Native cases of the transport of the PDP and of the client above it (docs/access.md, "Transport"): the bounded batches, the metadata,
// the Resource Search, the item context.error, and the real transport against a small server on the loopback (the pool of connections, the
// deadline, the forms of an HTTP/1.1 response). access_test.cpp includes this file and runs the cases.

#include "native_check.hpp"

#include "access_pdp.hpp"
#include "access_resource.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <rapidjson/document.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace pdp_cases {

using namespace chdash;

// ---- a fake transport that records each request and answers from a script --------------------------------------------------

struct ScriptTransport : PdpTransport {
  struct Call {
    std::string method;
    std::string path;
    std::string body;
  };
  std::mutex mu;
  std::vector<Call> calls;
  // The answer of each request: the default builds "true" for each item of an evaluations body.
  std::function<PdpHttpResult(const Call&, size_t index)> script;
  std::function<PdpHttpResult(const Call&, size_t index)> get_script;
  std::chrono::milliseconds idle_set{0};

  PdpHttpResult answer(const Call& call, bool is_get) {
    size_t index;
    {
      std::lock_guard<std::mutex> lock(mu);
      calls.push_back(call);
      index = calls.size() - 1;
    }
    if (is_get) {
      if (get_script) return get_script(call, index);
      PdpHttpResult out;
      out.status = 404;
      return out;
    }
    if (script) return script(call, index);
    return all_true(call);
  }

  static PdpHttpResult all_true(const Call& call) {
    rapidjson::Document doc;
    doc.Parse(call.body.c_str(), call.body.size());
    PdpHttpResult out;
    out.status = 200;
    if (doc.HasMember("evaluations")) {
      out.body = R"({"evaluations":[)";
      for (rapidjson::SizeType i = 0; i < doc["evaluations"].Size(); ++i) out.body += std::string(i ? "," : "") + R"({"decision":true})";
      out.body += "]}";
    } else {
      out.body = R"({"decision":true})";
    }
    return out;
  }

  PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>&,
                     std::chrono::milliseconds) override {
    return answer(Call{"POST", path, body}, false);
  }
  PdpHttpResult get(const std::string& path, const std::vector<std::pair<std::string, std::string>>&, std::chrono::milliseconds) override {
    return answer(Call{"GET", path, ""}, true);
  }
  void set_idle_close(std::chrono::milliseconds idle) override { idle_set = idle; }
};

inline PdpHttpResult status_only(int status) {
  PdpHttpResult out;
  out.status = status;
  return out;
}

inline PdpHttpResult json_result(const std::string& body) {
  PdpHttpResult out;
  out.status = 200;
  out.body = body;
  return out;
}

inline std::vector<AccessQuestion> many_questions(size_t count) {
  std::vector<AccessQuestion> out;
  for (size_t i = 0; i < count; ++i) out.push_back(AccessQuestion{"explorer.read", access_database_resource("db", "prod", "d" + std::to_string(i))});
  return out;
}

inline size_t items_of(const std::string& body) {
  rapidjson::Document doc;
  doc.Parse(body.c_str(), body.size());
  return doc.HasMember("evaluations") ? doc["evaluations"].Size() : 1;
}

inline PdpOptions chunk_options() {
  PdpOptions options;
  options.token = "t";
  options.timeout = std::chrono::milliseconds(300);
  options.cache_ttl = std::chrono::milliseconds(0);
  return options;
}

// ---- E3, C10: bounded batches --------------------------------------------------------------------------------------------------

inline void test_pdp_chunks() {
  PdpCallContext context;
  context.request_id = "chunks";
  // 1000 questions: ten requests of 100, in order, and one decision for each question.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    // The decision of each item follows its index in the whole call: the database d<N> is true when N is even.
    fake->script = [](const ScriptTransport::Call& call, size_t) {
      rapidjson::Document doc;
      doc.Parse(call.body.c_str(), call.body.size());
      PdpHttpResult out;
      out.status = 200;
      out.body = R"({"evaluations":[)";
      for (rapidjson::SizeType i = 0; i < doc["evaluations"].Size(); ++i) {
        const std::string id = doc["evaluations"][i]["resource"]["id"].GetString();
        const bool even = (std::stoi(id.substr(1)) % 2) == 0;
        out.body += std::string(i ? "," : "") + (even ? R"({"decision":true})" : R"({"decision":false})");
      }
      out.body += "]}";
      return out;
    };
    PdpClient client(chunk_options(), std::move(transport));
    const auto questions = many_questions(1000);
    const auto out = client.decide("alice", questions, context);
    CHECK_EQ(out.size(), size_t(1000));
    CHECK_EQ(fake->calls.size(), size_t(10));
    for (const auto& call : fake->calls) CHECK(call.path == "/access/v1/evaluations" && items_of(call.body) == 100);
    bool order_ok = true;
    for (size_t i = 0; i < out.size(); ++i) order_ok = order_ok && !out[i].failed && out[i].allowed == (i % 2 == 0);
    CHECK(order_ok);
  }
  // 101 questions: a request of 100 and a request of one, which uses the evaluation endpoint.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    PdpClient client(chunk_options(), std::move(transport));
    const auto out = client.decide("alice", many_questions(101), context);
    CHECK(out.size() == 101 && out.back().allowed);
    CHECK_EQ(fake->calls.size(), size_t(2));
    CHECK_EQ(fake->calls[1].path, std::string("/access/v1/evaluation"));
  }
  // A failed request fails its questions only: the third request of ten gives HTTP 500.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->script = [](const ScriptTransport::Call& call, size_t index) { return index == 2 ? status_only(500) : ScriptTransport::all_true(call); };
    PdpClient client(chunk_options(), std::move(transport));
    const auto out = client.decide("alice", many_questions(1000), context);
    CHECK_EQ(fake->calls.size(), size_t(10));
    size_t failed = 0;
    bool right_ones = true;
    for (size_t i = 0; i < out.size(); ++i) {
      if (out[i].failed) {
        ++failed;
        right_ones = right_ones && i >= 200 && i < 300 && !out[i].allowed;
      } else {
        right_ones = right_ones && out[i].allowed;
      }
    }
    CHECK_EQ(failed, size_t(100));
    CHECK(right_ones);
  }
  // An answer with the wrong number of items fails its request only.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->script = [](const ScriptTransport::Call& call, size_t index) { return index == 0 ? json_result(R"({"evaluations":[{"decision":true}]})") : ScriptTransport::all_true(call); };
    PdpClient client(chunk_options(), std::move(transport));
    const auto out = client.decide("alice", many_questions(250), context);
    size_t failed = 0;
    for (const auto& d : out) failed += d.failed ? 1 : 0;
    CHECK_EQ(failed, size_t(100));
    CHECK(out[0].failed && !out[100].failed && out[249].allowed);
  }
  // A request with no answer (a timeout or a connection error): the later requests are not sent, and each question fails.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->script = [](const ScriptTransport::Call& call, size_t index) {
      if (index == 1) {
        PdpHttpResult out;
        out.error = "timeout in the read";
        return out;
      }
      return ScriptTransport::all_true(call);
    };
    PdpClient client(chunk_options(), std::move(transport));
    const auto out = client.decide("alice", many_questions(500), context);
    CHECK_EQ(fake->calls.size(), size_t(2));
    CHECK(!out[0].failed && out[100].failed && out[499].failed && !out[499].allowed);
    size_t failed = 0;
    for (const auto& d : out) failed += d.failed ? 1 : 0;
    CHECK_EQ(failed, size_t(400));
  }
  // The answers of the requests that went are kept in the cache; the failed ones are not.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->script = [](const ScriptTransport::Call& call, size_t index) { return index == 1 ? status_only(503) : ScriptTransport::all_true(call); };
    PdpOptions options = chunk_options();
    options.cache_ttl = std::chrono::milliseconds(60000);
    PdpClient client(options, std::move(transport));
    const auto questions = many_questions(200);
    client.decide("alice", questions, context);
    CHECK_EQ(client.cached_entries(), size_t(100));
    const auto again = client.decide("alice", questions, context);
    CHECK_EQ(fake->calls.size(), size_t(3));
    CHECK(std::string(again[0].source) == "cache" && !again[100].failed && std::string(again[100].source) == "pdp");
  }
  // max_evaluations is the bound of the call.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    PdpOptions options = chunk_options();
    options.max_evaluations = 7;
    PdpClient client(options, std::move(transport));
    client.decide("alice", many_questions(20), context);
    CHECK_EQ(fake->calls.size(), size_t(3));
    CHECK(items_of(fake->calls[0].body) == 7 && items_of(fake->calls[1].body) == 7 && items_of(fake->calls[2].body) == 6);
  }
}

// ---- the deadline of a split call (access.pdp.batch_timeout, owner decision of 2026-11-07) ------------------------------------------

inline void test_pdp_batch_deadline() {
  PdpCallContext context;
  context.request_id = "deadline";
  // A slow PDP answers each request in 150 ms. 500 questions go in five requests. The deadline of the call is 400 ms: two requests end in
  // time, the third one gets the 100 ms that remain and gets no answer in time. The fourth and the fifth requests are not sent, and every
  // question of the call fails, also the 200 that the PDP answered: never a part of the answers.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    std::vector<std::chrono::milliseconds> waits;
    std::mutex waits_mu;
    struct Slow : PdpTransport {
      ScriptTransport* inner;
      std::vector<std::chrono::milliseconds>* waits;
      std::mutex* mu;
      PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                         std::chrono::milliseconds timeout) override {
        {
          std::lock_guard<std::mutex> lock(*mu);
          waits->push_back(timeout);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(150));
        return inner->post(path, body, headers, timeout);
      }
    };
    auto slow = std::make_unique<Slow>();
    slow->inner = fake;
    slow->waits = &waits;
    slow->mu = &waits_mu;
    PdpOptions options = chunk_options();
    options.timeout = std::chrono::milliseconds(300);
    options.batch_timeout = std::chrono::milliseconds(400);
    options.cache_ttl = std::chrono::milliseconds(60000);
    PdpClient client(options, std::move(slow));
    const auto out = client.decide("alice", many_questions(500), context);
    CHECK_EQ(fake->calls.size(), size_t(3));
    bool all_failed = true;
    for (const auto& d : out) all_failed = all_failed && d.failed && !d.allowed;
    CHECK(all_failed);
    // Each request waits the timeout of one request at most, and the last one only the time that remains before the deadline.
    CHECK(waits.size() == 3 && waits[0].count() == 300 && waits[1].count() <= 300 && waits[2].count() <= 100 && waits[2].count() > 0);
    // The answers that came are valid answers: the cache keeps them, and the next call asks only the rest, within its own deadline.
    CHECK_EQ(client.cached_entries(), size_t(200));
    // The answers of the cache alone are not a call of several requests: the next call of the first 200 questions needs no request.
    const auto first = many_questions(500);
    const auto kept = client.decide("alice", std::vector<AccessQuestion>(first.begin(), first.begin() + 200), context);
    CHECK(kept[0].allowed && kept[199].allowed && !kept[0].failed && fake->calls.size() == 3);
  }
  // A split call that ends before the deadline gives every answer.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    PdpOptions options = chunk_options();
    options.batch_timeout = std::chrono::milliseconds(2000);
    PdpClient client(options, std::move(transport));
    const auto out = client.decide("alice", many_questions(500), context);
    CHECK_EQ(fake->calls.size(), size_t(5));
    bool all_allowed = true;
    for (const auto& d : out) all_allowed = all_allowed && d.allowed && !d.failed;
    CHECK(all_allowed);
  }
  // A call of one request has only the timeout of one request: the deadline of a split call does not apply to it.
  {
    struct Late : PdpTransport {
      PdpHttpResult post(const std::string&, const std::string& body, const std::vector<std::pair<std::string, std::string>>&,
                         std::chrono::milliseconds timeout) override {
        std::this_thread::sleep_for(std::chrono::milliseconds(80));
        PdpHttpResult out = ScriptTransport::all_true(ScriptTransport::Call{"POST", "", body});
        out.error = timeout.count() == 300 ? "" : "the wait was not the timeout";
        return out;
      }
    };
    PdpOptions options = chunk_options();
    options.batch_timeout = std::chrono::milliseconds(50);
    PdpClient client(options, std::make_unique<Late>());
    const auto out = client.decide("alice", many_questions(100), context);
    CHECK(out[0].allowed && !out[0].failed && out[99].allowed);
  }
}

// ---- E4: the metadata ----------------------------------------------------------------------------------------------------------

inline std::string metadata_doc(const std::string& pdp, const std::string& extra = "") {
  return R"({"policy_decision_point":")" + pdp + R"(","access_evaluation_endpoint":")" + pdp + R"(/access/v1/evaluation","access_evaluations_endpoint":")" + pdp +
         R"(/access/v1/evaluations")" + extra + "}";
}

inline void test_pdp_metadata() {
  const std::string pdp = "https://pdp.example:8443/tenant";
  PdpEndpoints known;
  std::string error;
  // A valid document: the endpoints, the maxima of ProcurAuth, and members that ChDash does not know (ignored: AuthZEN 1.0, l.1342).
  CHECK(PdpClient::parse_metadata(metadata_doc(pdp, R"(,"search_resource_endpoint":")" + pdp + R"(/access/v1/search/resource","procurauth_usage_max_seconds":3,)"
                                                      R"("procurauth_idle_max_seconds":20,"procurauth_evaluations_max_bytes":65536,"procurauth_evaluations_max_items":50,"other":[1])"),
                                  pdp, &known, &error));
  CHECK_EQ(known.evaluation, std::string("/tenant/access/v1/evaluation"));
  CHECK_EQ(known.evaluations, std::string("/tenant/access/v1/evaluations"));
  CHECK_EQ(known.search_resource, std::string("/tenant/access/v1/search/resource"));
  CHECK(known.usage_max_seconds == 3 && known.idle_max_seconds == 20 && known.evaluations_max_bytes == 65536 && known.evaluations_max_items == 50);
  // A slash at the end of the identifier is not part of it; the host and the scheme of an endpoint can have another case.
  CHECK(PdpClient::parse_metadata(metadata_doc(pdp + "/"), pdp, &known, &error));
  CHECK(PdpClient::parse_metadata(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"https://PDP.example:8443/e","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                                  pdp, &known, &error));
  CHECK_EQ(known.evaluation, std::string("/e"));
  CHECK(!known.search_resource.size() && !known.usage_max_seconds);
  // The port 443 of https can be written or left out.
  CHECK(PdpClient::parse_metadata(R"({"policy_decision_point":"https://pdp.example","access_evaluation_endpoint":"https://pdp.example:443/e","access_evaluations_endpoint":"https://pdp.example/es"})",
                                  "https://pdp.example", &known, &error));

  const auto rejected = [&](const std::string& body, const std::string& text) {
    PdpEndpoints scratch;
    std::string why;
    const bool ok = PdpClient::parse_metadata(body, pdp, &scratch, &why);
    if (ok || why.find(text) == std::string::npos) std::cerr << "metadata case: expected an error with \"" << text << "\", got \"" << why << "\"\n";
    return !ok && why.find(text) != std::string::npos;
  };
  CHECK(rejected("not json", "not a JSON object"));
  CHECK(rejected("[]", "not a JSON object"));
  CHECK(rejected(R"({"access_evaluation_endpoint":"https://pdp.example:8443/e"})", "policy_decision_point is missing"));
  // AuthZEN 1.0, l.1364: another identifier means the data must not be used.
  CHECK(rejected(metadata_doc("https://other.example:8443/tenant"), "policy_decision_point is \"https://other.example:8443/tenant\""));
  CHECK(rejected(metadata_doc("https://pdp.example:8443"), "policy_decision_point"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluations_endpoint":"https://pdp.example:8443/es"})", "access_evaluation_endpoint is missing"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"https://pdp.example:8443/e"})", "access_evaluations_endpoint is missing"));
  // The token goes only to the origin of access.pdp.url.
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"https://evil.example:8443/e","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "access_evaluation_endpoint is not at the address of access.pdp.url"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"http://pdp.example:8443/e","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "is not at the address"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"https://pdp.example:9/e","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "is not at the address"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"/e","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "must start with http"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":7,"access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "must be a text"));
  CHECK(rejected(R"({"policy_decision_point":"https://pdp.example:8443/tenant","access_evaluation_endpoint":"https://pdp.example:8443/e?x=1","access_evaluations_endpoint":"https://pdp.example:8443/es"})",
                 "query"));
  CHECK(rejected(metadata_doc(pdp, R"(,"procurauth_evaluations_max_items":0)"), "procurauth_evaluations_max_items must be a whole number from 1"));
  CHECK(rejected(metadata_doc(pdp, R"(,"procurauth_evaluations_max_items":"50")"), "procurauth_evaluations_max_items"));
  CHECK(rejected(metadata_doc(pdp, R"(,"procurauth_usage_max_seconds":1.5)"), "procurauth_usage_max_seconds"));
  CHECK(rejected(metadata_doc(pdp, R"(,"procurauth_idle_max_seconds":-1)"), "procurauth_idle_max_seconds"));

  // The URL of the PDP.
  std::string why;
  const auto parsed = parse_pdp_url("https://[::1]:8443/base/", &why);
  CHECK(parsed && parsed->https && parsed->host == "::1" && parsed->port == 8443 && parsed->base_path == "/base");
  CHECK(!parse_pdp_url("ftp://x", &why) && !parse_pdp_url("https://u:p@x", &why) && !parse_pdp_url("https://x?q=1", &why) && !parse_pdp_url("https://", &why));
  CHECK(pdp_host_is_loopback("localhost") && pdp_host_is_loopback("LOCALHOST") && pdp_host_is_loopback("127.0.0.1") && pdp_host_is_loopback("::1"));
  CHECK(!pdp_host_is_loopback("128.0.0.1") && !pdp_host_is_loopback("127.0.0.1.example.org") && !pdp_host_is_loopback("pdp"));

  // The client with a discovery: the document gives the endpoints and the maxima.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->get_script = [&](const ScriptTransport::Call&, size_t) {
      return json_result(metadata_doc(pdp, R"(,"procurauth_evaluations_max_items":30,"procurauth_idle_max_seconds":10,"procurauth_usage_max_seconds":4)"));
    };
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    options.discovery = true;
    options.identifier = pdp;
    PdpClient client(options, std::move(transport));
    PdpCallContext context;
    CHECK(client.discover(context).state == PdpDiscoveryState::Loaded);
    // l.1317: the well-known string goes between the host and the path.
    CHECK_EQ(fake->calls[0].path, std::string("/.well-known/authzen-configuration/tenant"));
    CHECK_EQ(fake->idle_set.count(), int64_t(5000));
    CHECK_EQ(client.usage_timeout().count(), int64_t(5000));
    const auto out = client.decide("alice", many_questions(70), context);
    CHECK(out[0].allowed && out[69].allowed);
    // 70 questions with the maximum 30: 30, 30 and 10, on the endpoint of the document.
    CHECK_EQ(fake->calls.size(), size_t(4));
    CHECK(items_of(fake->calls[1].body) == 30 && items_of(fake->calls[3].body) == 10);
    CHECK_EQ(fake->calls[1].path, std::string("/tenant/access/v1/evaluations"));
  }
  // A maximum of bytes: each body is within it, and a question that is larger alone goes alone.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(metadata_doc(pdp, R"(,"procurauth_evaluations_max_bytes":1500)")); };
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    options.discovery = true;
    options.identifier = pdp;
    PdpClient client(options, std::move(transport));
    PdpCallContext context;
    CHECK(client.discover(context).state == PdpDiscoveryState::Loaded);
    const auto out = client.decide("alice", many_questions(40), context);
    size_t items = 0;
    bool within = true;
    for (size_t i = 1; i < fake->calls.size(); ++i) {
      items += items_of(fake->calls[i].body);
      within = within && fake->calls[i].body.size() <= 1500;
    }
    CHECK_EQ(items, size_t(40));
    CHECK(within && fake->calls.size() > 3);
    CHECK(out[39].allowed);
    // 40 questions fit in 100 per request, so only the bytes split the call.
    CHECK(fake->calls.size() < 41);
  }
  // No metadata (404): the default endpoints under the path of the URL, and no search.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    options.discovery = true;
    options.identifier = pdp;
    PdpClient client(options, std::move(transport));
    PdpCallContext context;
    const PdpDiscoveryResult found = client.discover(context);
    CHECK(found.state == PdpDiscoveryState::Absent && found.message.empty());
    client.decide("alice", many_questions(2), context);
    CHECK_EQ(fake->calls[1].path, std::string("/tenant/access/v1/evaluations"));
    CHECK(client.endpoints().search_resource.empty());
  }
  // A document that cannot be used: Invalid. The start stops.
  {
    auto transport = std::make_unique<ScriptTransport>();
    transport->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(metadata_doc("https://other.example/x")); };
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    options.discovery = true;
    options.identifier = pdp;
    PdpClient client(options, std::move(transport));
    const PdpDiscoveryResult found = client.discover(PdpCallContext{});
    CHECK(found.state == PdpDiscoveryState::Invalid && found.message.find("policy_decision_point") != std::string::npos);
  }
  // A PDP that is down at the start: Unreachable (a warning). The first questions fail without a POST; one second later the client reads the
  // metadata again, and the questions go.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    std::atomic<bool> up{false};
    fake->get_script = [&](const ScriptTransport::Call&, size_t) {
      if (!up) {
        PdpHttpResult out;
        out.error = "connect: Connection refused";
        return out;
      }
      return json_result(metadata_doc(pdp));
    };
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    options.discovery = true;
    options.identifier = pdp;
    PdpClient client(options, std::move(transport));
    PdpCallContext context;
    CHECK(client.discover(context).state == PdpDiscoveryState::Unreachable);
    auto out = client.decide("alice", many_questions(3), context);
    CHECK(out[0].failed && out[2].failed);
    size_t posts = 0;
    for (const auto& call : fake->calls) posts += call.method == "POST" ? 1 : 0;
    CHECK_EQ(posts, size_t(0));
    // Inside the retry time, no new GET.
    const size_t gets = fake->calls.size();
    out = client.decide("alice", many_questions(3), context);
    CHECK(out[0].failed && fake->calls.size() == gets);
    up = true;
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));
    out = client.decide("alice", many_questions(3), context);
    CHECK(!out[0].failed && out[0].allowed && out[2].allowed);
    CHECK_EQ(fake->calls.back().path, std::string("/tenant/access/v1/evaluations"));
  }
  // A PDP of the tests without discovery keeps the default paths and the maxima of the options.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    PdpOptions options = chunk_options();
    options.base_path = "/tenant";
    PdpClient client(options, std::move(transport));
    client.decide("alice", many_questions(2), PdpCallContext{});
    CHECK_EQ(fake->calls.size(), size_t(1));
    CHECK_EQ(fake->calls[0].path, std::string("/tenant/access/v1/evaluations"));
    CHECK_EQ(client.usage_timeout().count(), int64_t(300));
  }
}

// ---- E7: the context.error of an item ----------------------------------------------------------------------------------------------

inline void test_pdp_item_error() {
  std::vector<PdpAnswer> answers;
  CHECK(PdpClient::parse_answer(R"({"evaluations":[{"decision":false,"context":{"error":{"status":404,"message":"Resource not found"}}},{"decision":true}]})", 2, &answers));
  CHECK(answers[0].error_status == 404 && answers[0].error_message == "Resource not found");
  CHECK(!answers[1].error_status && answers[1].error_message.empty());
  // The error is for the log: a form that is not an object with a status and a message never makes the answer not valid.
  CHECK(PdpClient::parse_answer(R"({"decision":false,"context":{"error":"x"}})", 1, &answers) && !answers[0].error_status && answers[0].error_message.empty());
  CHECK(PdpClient::parse_answer(R"({"decision":false,"context":{"error":{"status":"404","message":7}}})", 1, &answers) && !answers[0].error_status && answers[0].error_message.empty());
  // A true decision can carry it too.
  CHECK(PdpClient::parse_answer(R"({"decision":true,"context":{"error":{"status":500}}})", 1, &answers) && answers[0].decision && answers[0].error_status == 500);
  // The message is cut to 200 bytes, never inside a UTF-8 character.
  std::string long_message(199, 'a');
  long_message += "\xC3\xA9\xC3\xA9";
  CHECK(PdpClient::parse_answer(R"({"decision":false,"context":{"error":{"message":")" + long_message + R"("}}})", 1, &answers));
  CHECK_EQ(answers[0].error_message.size(), size_t(199));
  // The decision of the client keeps them for the log line.
  auto transport = std::make_unique<ScriptTransport>();
  transport->script = [](const ScriptTransport::Call&, size_t) { return json_result(R"({"decision":false,"context":{"error":{"status":404,"message":"gone"}}})"); };
  PdpClient client(chunk_options(), std::move(transport));
  const auto out = client.decide("alice", many_questions(1), PdpCallContext{});
  CHECK(out[0].error_status == 404 && out[0].error_message == "gone" && !out[0].failed && !out[0].allowed);
}

// ---- E5: Resource Search -----------------------------------------------------------------------------------------------------

inline void test_pdp_search() {
  PdpSearchPage page;
  // AuthZEN 1.0, l.1049-1086: results, and a page with next_token.
  CHECK(PdpClient::parse_search_answer(R"({"results":[{"type":"database","id":"a"},{"type":"database","id":"b"}]})", "database", &page));
  CHECK(page.ids == std::vector<std::string>({"a", "b"}) && page.next_token.empty());
  CHECK(PdpClient::parse_search_answer(R"({"page":{"next_token":"abc","count":1},"results":[{"type":"database","id":"a"}]})", "database", &page));
  CHECK(page.next_token == "abc" && page.ids.size() == 1);
  CHECK(PdpClient::parse_search_answer(R"({"page":{"next_token":""},"results":[]})", "database", &page) && page.next_token.empty() && page.ids.empty());
  CHECK(!PdpClient::parse_search_answer(R"({"results":[{"type":"table","id":"a"}]})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({"results":[{"type":"database"}]})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({"results":[{"type":"database","id":""}]})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({"results":{}})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({"page":{},"results":[]})", "database", &page));
  CHECK(!PdpClient::parse_search_answer(R"({"page":{"next_token":7},"results":[]})", "database", &page));
  CHECK(!PdpClient::parse_search_answer("[]", "database", &page));

  // The request: the subject, the action, the type without an id, the chain, and the page.
  const std::vector<AccessNode> chain = {{"service", "db"}, {"host", "prod"}};
  rapidjson::Document doc;
  std::string body = PdpClient::search_request_body("alice", "explorer.read", "database", chain, "tok", 50);
  doc.Parse(body.c_str(), body.size());
  CHECK(doc["subject"]["type"] == "user" && doc["subject"]["id"] == "alice" && doc["action"]["name"] == "explorer.read");
  CHECK(doc["resource"]["type"] == "database" && !doc["resource"].HasMember("id"));
  CHECK(doc["resource"]["properties"]["ancestors"].Size() == 2 && doc["resource"]["properties"]["ancestors"][1]["id"] == "prod");
  CHECK(doc["page"]["token"] == "tok" && doc["page"]["limit"].GetUint() == 50);
  body = PdpClient::search_request_body("alice", "explorer.read", "host", {{"service", "db"}}, "", 0);
  doc.Parse(body.c_str(), body.size());
  CHECK(!doc.HasMember("page"));

  const auto options_for = [](size_t pages, size_t items) {
    PdpOptions options = chunk_options();
    options.base_path = "/p";
    options.discovery = true;
    options.identifier = "http://pdp:8086/p";
    options.search_max_pages = pages;
    options.search_max_items = items;
    return options;
  };
  const std::string doc_with_search = R"({"policy_decision_point":"http://pdp:8086/p","access_evaluation_endpoint":"http://pdp:8086/p/access/v1/evaluation",)"
                                      R"("access_evaluations_endpoint":"http://pdp:8086/p/access/v1/evaluations","search_resource_endpoint":"http://pdp:8086/p/s"})";
  // The loop: three pages, the token of each is sent in the next request.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(doc_with_search); };
    fake->script = [](const ScriptTransport::Call& call, size_t) {
      rapidjson::Document request;
      request.Parse(call.body.c_str(), call.body.size());
      const std::string token = request.HasMember("page") && request["page"].HasMember("token") ? request["page"]["token"].GetString() : "";
      if (token.empty()) return json_result(R"({"page":{"next_token":"t2"},"results":[{"type":"database","id":"a"},{"type":"database","id":"b"}]})");
      if (token == "t2") return json_result(R"({"page":{"next_token":"t3"},"results":[{"type":"database","id":"c"}]})");
      return json_result(R"({"page":{"next_token":""},"results":[{"type":"database","id":"d"}]})");
    };
    PdpClient client(options_for(10, 100), std::move(transport));
    CHECK(client.discover(PdpCallContext{}).state == PdpDiscoveryState::Loaded);
    const PdpSearchResult result = client.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(result.ok && !result.truncated);
    CHECK(result.ids == std::vector<std::string>({"a", "b", "c", "d"}));
    CHECK_EQ(fake->calls.size(), size_t(4));  // the GET and three pages
    CHECK_EQ(fake->calls[1].path, std::string("/p/s"));
  }
  // The bounds: pages and items.
  {
    auto transport = std::make_unique<ScriptTransport>();
    ScriptTransport* fake = transport.get();
    fake->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(doc_with_search); };
    fake->script = [](const ScriptTransport::Call&, size_t index) {
      return json_result(R"({"page":{"next_token":"n)" + std::to_string(index) + R"("},"results":[{"type":"database","id":"x)" + std::to_string(index) + R"("},{"type":"database","id":"y)" +
                         std::to_string(index) + R"("}]})");
    };
    PdpClient pages(options_for(3, 100), std::move(transport));
    pages.discover(PdpCallContext{});
    const PdpSearchResult by_pages = pages.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(by_pages.ok && by_pages.truncated && by_pages.ids.size() == 6);

    auto transport2 = std::make_unique<ScriptTransport>();
    transport2->get_script = fake->get_script;
    transport2->script = fake->script;
    PdpClient items(options_for(10, 5), std::move(transport2));
    items.discover(PdpCallContext{});
    const PdpSearchResult by_items = items.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(by_items.ok && by_items.truncated && by_items.ids.size() == 5);
  }
  // A token that comes again, a page that is not valid, a failure, and no announced endpoint: ok is false.
  {
    auto transport = std::make_unique<ScriptTransport>();
    transport->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(doc_with_search); };
    transport->script = [](const ScriptTransport::Call&, size_t) { return json_result(R"({"page":{"next_token":"same"},"results":[]})"); };
    PdpClient client(options_for(10, 100), std::move(transport));
    client.discover(PdpCallContext{});
    const PdpSearchResult loop = client.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(!loop.ok && loop.error.find("next_token") != std::string::npos && loop.ids.empty());

    auto transport2 = std::make_unique<ScriptTransport>();
    transport2->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(doc_with_search); };
    transport2->script = [](const ScriptTransport::Call&, size_t index) {
      return index == 1 ? json_result(R"({"page":{"next_token":"a"},"results":[{"type":"database","id":"x"}]})") : json_result(R"({"results":[{"type":"table","id":"x"}]})");
    };
    PdpClient bad(options_for(10, 100), std::move(transport2));
    bad.discover(PdpCallContext{});
    const PdpSearchResult invalid = bad.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(!invalid.ok && invalid.ids.empty());

    auto transport3 = std::make_unique<ScriptTransport>();
    transport3->get_script = [&](const ScriptTransport::Call&, size_t) { return json_result(doc_with_search); };
    transport3->script = [](const ScriptTransport::Call&, size_t) { return status_only(503); };
    PdpClient down(options_for(10, 100), std::move(transport3));
    down.discover(PdpCallContext{});
    CHECK(!down.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{}).ok);

    // A PDP whose metadata has no search_resource_endpoint: nothing is sent.
    auto transport4 = std::make_unique<ScriptTransport>();
    ScriptTransport* none = transport4.get();
    PdpClient plain(options_for(10, 100), std::move(transport4));
    plain.discover(PdpCallContext{});
    const PdpSearchResult absent = plain.search_resources("alice", "explorer.read", "database", chain, PdpCallContext{});
    CHECK(!absent.ok && absent.error.find("search_resource_endpoint") != std::string::npos);
    CHECK_EQ(none->calls.size(), size_t(1));  // the GET only
  }
}

// ---- the real transport against a small server on the loopback ----------------------------------------------------------------------

struct MiniReply {
  std::string raw;            // the whole response
  bool close_after = false;   // close the connection after the response
  int delay_ms = 0;           // wait before the response
};

// A server of HTTP/1.1 for the tests: one thread for each connection; it reads a request (the head and Content-Length bytes) and writes the
// reply that `respond` gives. It counts the connections and the requests.
class MiniServer {
public:
  using Respond = std::function<MiniReply(const std::string& request, int connection, int request_on_connection)>;

  explicit MiniServer(Respond respond) : respond_(std::move(respond)) {
    listen_fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    ::setsockopt(listen_fd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0;
    ::bind(listen_fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(listen_fd_, 16);
    socklen_t len = sizeof(addr);
    ::getsockname(listen_fd_, reinterpret_cast<sockaddr*>(&addr), &len);
    port_ = ntohs(addr.sin_port);
    acceptor_ = std::thread([this] { accept_loop(); });
  }
  ~MiniServer() {
    stop_ = true;
    ::shutdown(listen_fd_, SHUT_RDWR);
    ::close(listen_fd_);
    if (acceptor_.joinable()) acceptor_.join();
    for (auto& t : workers_) t.join();
  }
  int port() const { return port_; }
  int connections() const { return connections_; }
  int requests() const { return requests_; }

private:
  void accept_loop() {
    while (!stop_) {
      const int fd = ::accept(listen_fd_, nullptr, nullptr);
      if (fd < 0) return;
      const int number = connections_++;
      workers_.emplace_back([this, fd, number] { serve(fd, number); });
    }
  }

  void serve(int fd, int number) {
    timeval tv{5, 0};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    std::string buffer;
    int index = 0;
    for (;;) {
      size_t end;
      while ((end = buffer.find("\r\n\r\n")) == std::string::npos) {
        char chunk[4096];
        const ssize_t r = ::recv(fd, chunk, sizeof(chunk), 0);
        if (r <= 0) {
          ::close(fd);
          return;
        }
        buffer.append(chunk, static_cast<size_t>(r));
      }
      size_t length = 0;
      const size_t at = buffer.find("Content-Length: ");
      if (at != std::string::npos && at < end) length = std::stoul(buffer.substr(at + 16));
      while (buffer.size() < end + 4 + length) {
        char chunk[4096];
        const ssize_t r = ::recv(fd, chunk, sizeof(chunk), 0);
        if (r <= 0) {
          ::close(fd);
          return;
        }
        buffer.append(chunk, static_cast<size_t>(r));
      }
      const std::string request = buffer.substr(0, end + 4 + length);
      buffer.erase(0, end + 4 + length);
      ++requests_;
      const MiniReply reply = respond_(request, number, index++);
      if (reply.delay_ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(reply.delay_ms));
      ::send(fd, reply.raw.data(), reply.raw.size(), MSG_NOSIGNAL);
      if (reply.close_after) {
        ::close(fd);
        return;
      }
    }
  }

  Respond respond_;
  int listen_fd_ = -1;
  int port_ = 0;
  std::atomic<bool> stop_{false};
  std::atomic<int> connections_{0};
  std::atomic<int> requests_{0};
  std::thread acceptor_;
  std::vector<std::thread> workers_;
};

inline std::string http_reply(const std::string& body, const std::string& extra_headers = "", const std::string& status = "200 OK") {
  return "HTTP/1.1 " + status + "\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\n" + extra_headers + "\r\n" + body;
}

inline std::unique_ptr<PdpTransport> real_transport(int port, const std::string& base_path = "") {
  PdpTransportOptions options;
  options.url.host = "127.0.0.1";
  options.url.port = port;
  options.url.base_path = base_path;
  std::string error;
  auto transport = make_pdp_transport(options, &error);
  if (!transport) std::cerr << "make_pdp_transport: " << error << "\n";
  return transport;
}

inline void test_pdp_transport() {
  const std::vector<std::pair<std::string, std::string>> headers = {{"Authorization", "Bearer secret"}, {"X-Request-ID", "r1"}};
  const std::chrono::milliseconds wait(2000);
  // E6: three requests use one connection; the request has the host, the path, the headers, the length and the body.
  {
    std::mutex mu;
    std::vector<std::string> seen;
    MiniServer server([&](const std::string& request, int, int) {
      std::lock_guard<std::mutex> lock(mu);
      seen.push_back(request);
      return MiniReply{http_reply(R"({"decision":true})", "X-Request-ID: r1\r\n"), false, 0};
    });
    auto transport = real_transport(server.port(), "/base");
    for (int i = 0; i < 3; ++i) {
      const PdpHttpResult r = transport->post("/base/access/v1/evaluation", R"({"a":1})", headers, wait);
      CHECK(r.error.empty() && r.status == 200 && r.body == R"({"decision":true})");
      CHECK(r.request_id && *r.request_id == "r1");
    }
    CHECK_EQ(server.connections(), 1);
    CHECK_EQ(server.requests(), 3);
    CHECK(seen[0].rfind("POST /base/access/v1/evaluation HTTP/1.1\r\n", 0) == 0);
    CHECK(seen[0].find("Host: 127.0.0.1:" + std::to_string(server.port()) + "\r\n") != std::string::npos);
    CHECK(seen[0].find("Authorization: Bearer secret\r\n") != std::string::npos && seen[0].find("X-Request-ID: r1\r\n") != std::string::npos);
    CHECK(seen[0].find("Content-Type: application/json\r\n") != std::string::npos && seen[0].find("Content-Length: 7\r\n") != std::string::npos);
    CHECK(seen[0].size() > 7 && seen[0].substr(seen[0].size() - 7) == R"({"a":1})");
    // GET has no body and no Content-Length.
    const PdpHttpResult g = transport->get("/.well-known/authzen-configuration", {{"Accept", "application/json"}}, wait);
    CHECK(g.error.empty() && g.status == 200);
    CHECK(seen.back().rfind("GET /.well-known/authzen-configuration HTTP/1.1\r\n", 0) == 0 && seen.back().find("Content-Length") == std::string::npos);
    CHECK_EQ(server.connections(), 1);
  }
  // The pool never exceeds max_idle, and parallel requests use parallel connections.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), false, 100}; });
    auto transport = real_transport(server.port());
    std::vector<std::thread> threads;
    std::atomic<int> good{0};
    for (int i = 0; i < 3; ++i) {
      threads.emplace_back([&] {
        const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
        if (r.error.empty() && r.status == 200) ++good;
      });
    }
    for (auto& t : threads) t.join();
    CHECK_EQ(good.load(), 3);
    CHECK_EQ(server.connections(), 3);
    // The three connections are idle now; the next three requests use them again.
    threads.clear();
    for (int i = 0; i < 3; ++i) threads.emplace_back([&] { transport->post("/x", "{}", headers, wait); });
    for (auto& t : threads) t.join();
    CHECK_EQ(server.connections(), 3);
  }
  // Connection: close, HTTP/1.0 and a response with no length are not kept.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}", "Connection: close\r\n"), true, 0}; });
    auto transport = real_transport(server.port());
    for (int i = 0; i < 3; ++i) CHECK(transport->post("/x", "{}", headers, wait).status == 200);
    CHECK_EQ(server.connections(), 3);
  }
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{"HTTP/1.1 200 OK\r\n\r\n{\"decision\":true}", true, 0}; });
    auto transport = real_transport(server.port());
    const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
    CHECK(r.error.empty() && r.body == R"({"decision":true})");
    CHECK(transport->post("/x", "{}", headers, wait).body == R"({"decision":true})");
    CHECK_EQ(server.connections(), 2);
  }
  // A chunked response, with an extension and a trailer.
  {
    MiniServer server([&](const std::string&, int, int) {
      return MiniReply{"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\n{\"dec\r\n9\r\nision\":tr\r\n3\r\nue}\r\n0\r\nX-Trailer: 1\r\n\r\n", false, 0};
    });
    auto transport = real_transport(server.port());
    for (int i = 0; i < 2; ++i) {
      const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
      CHECK(r.error.empty() && r.status == 200 && r.body == R"({"decision":true})");
    }
    CHECK_EQ(server.connections(), 1);
  }
  // An interim response 100 is skipped; a status other than 200 comes with its body.
  {
    MiniServer server([&](const std::string&, int, int index) {
      if (index == 0) return MiniReply{"HTTP/1.1 100 Continue\r\n\r\n" + http_reply("{}"), false, 0};
      return MiniReply{http_reply("{\"error\":1}", "", "503 Service Unavailable"), false, 0};
    });
    auto transport = real_transport(server.port());
    CHECK(transport->post("/x", "{}", headers, wait).status == 200);
    const PdpHttpResult busy = transport->post("/x", "{}", headers, wait);
    CHECK(busy.error.empty() && busy.status == 503 && busy.body == "{\"error\":1}");
  }
  // The body is bounded: a larger Content-Length is an error before the body is read.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply(std::string(5000, 'a')), false, 0}; });
    PdpTransportOptions options;
    options.url.host = "127.0.0.1";
    options.url.port = server.port();
    options.max_body_bytes = 1000;
    std::string error;
    auto transport = make_pdp_transport(options, &error);
    const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
    CHECK(r.error == "the answer is too large");
  }
  // Responses that are not valid.
  for (const std::string& raw : {std::string("garbage\r\n\r\n"), std::string("HTTP/2 200 OK\r\n\r\n"), std::string("HTTP/1.1 200 OK\r\nContent-Length: x\r\n\r\n"),
                                 std::string("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nab"),
                                 std::string("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"),
                                 std::string("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n"), std::string("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")}) {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{raw, true, 0}; });
    auto transport = real_transport(server.port());
    const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
    CHECK(!r.error.empty());
  }
  // The deadline is one for the whole request: a server that answers after it gives a timeout, near the deadline.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), false, 1500}; });
    auto transport = real_transport(server.port());
    const auto started = std::chrono::steady_clock::now();
    const PdpHttpResult r = transport->post("/x", "{}", headers, std::chrono::milliseconds(300));
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    CHECK(r.error == "timeout in the read" && r.status == 0);
    CHECK(spent >= 280 && spent < 900);
  }
  // A server that sends the head slowly, a byte at a time, is still cut at the deadline of the whole request.
  {
    MiniServer server([&](const std::string&, int, int) {
      return MiniReply{"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", false, 400};
    });
    auto transport = real_transport(server.port());
    const auto started = std::chrono::steady_clock::now();
    const PdpHttpResult r = transport->post("/x", "{}", headers, std::chrono::milliseconds(200));
    const auto spent = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
    CHECK(!r.error.empty() && spent < 700);
  }
  // A port with no server: a connection error, at once.
  {
    int port;
    {
      MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), false, 0}; });
      port = server.port();
    }
    auto transport = real_transport(port);
    const PdpHttpResult r = transport->post("/x", "{}", headers, wait);
    CHECK(!r.error.empty() && r.status == 0);
  }
  // The pool closes an idle connection after the idle time: the next request opens a new one. A server that closed a kept connection is
  // seen before the write, so a question and a question with usage both get a new connection and no error.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), false, 0}; });
    auto transport = real_transport(server.port());
    transport->set_idle_close(std::chrono::milliseconds(100));
    CHECK(transport->post("/x", "{}", headers, wait).status == 200);
    CHECK(transport->post("/x", "{}", headers, wait).status == 200);
    CHECK_EQ(server.connections(), 1);
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    CHECK(transport->post("/x", "{}", headers, wait).status == 200);
    CHECK_EQ(server.connections(), 2);
  }
  {
    MiniServer server([&](const std::string&, int, int index) { return MiniReply{http_reply("{}"), index == 0, 0}; });
    auto transport = real_transport(server.port());
    CHECK(transport->post_once("/x", "{}", headers, wait).status == 200);
    // The server closed the first connection after its answer (keep-alive was claimed): the pool finds it closed.
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    CHECK(transport->post_once("/x", "{}", headers, wait).status == 200);
    CHECK_EQ(server.connections(), 2);
  }
  // A header with a line break is refused, and nothing is sent.
  {
    MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), false, 0}; });
    auto transport = real_transport(server.port());
    const PdpHttpResult r = transport->post("/x", "{}", {{"X-Request-ID", "a\r\nX-Evil: 1"}}, wait);
    CHECK(!r.error.empty() && server.connections() == 0);
    CHECK(!transport->post("/x y", "{}", headers, wait).error.empty());
    CHECK(!transport->post("x", "{}", headers, wait).error.empty());
  }
  // https in a build without TLS cannot start; with TLS it can start (the certificate is checked at the connect).
  {
    PdpTransportOptions options;
    options.url.https = true;
    options.url.host = "127.0.0.1";
    options.url.port = 9;
    std::string error;
    auto transport = make_pdp_transport(options, &error);
    if (pdp_tls_available()) {
      CHECK(transport != nullptr);
      // A plain server that does not speak TLS: the handshake fails, with a message, and no certificate is trusted.
      MiniServer server([&](const std::string&, int, int) { return MiniReply{http_reply("{}"), true, 0}; });
      options.url.port = server.port();
      auto tls = make_pdp_transport(options, &error);
      const PdpHttpResult r = tls->post("/x", "{}", headers, wait);
      CHECK(!r.error.empty() && r.status == 0);
      // A ca_file that does not exist cannot start.
      options.ca_file = "/nonexistent/ca.pem";
      CHECK(make_pdp_transport(options, &error) == nullptr && error.find("/nonexistent/ca.pem") != std::string::npos);
    } else {
      CHECK(transport == nullptr && error.find("-DCHDASH_TLS=ON") != std::string::npos);
    }
  }
}

} // namespace pdp_cases
