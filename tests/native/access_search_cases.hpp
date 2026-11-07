#pragma once

// Native cases of the Resource Search that lists databases (docs/access.md, "Resource Search"): the search is not used, it is used,
// a grant on the host covers every database, a failure and a cut result fall back to the evaluations, the union over the actions, the
// intersection with SHOW DATABASES, and the stable pages. access_test.cpp includes this file and runs the cases.

#include "native_check.hpp"

#include "access_options.hpp"
#include "access_pdp.hpp"
#include "access_resource.hpp"
#include "access_search.hpp"
#include "pdp_transport_cases.hpp"

#include <rapidjson/document.h>

#include <algorithm>
#include <memory>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

namespace search_cases {

using namespace chdash;
using pdp_cases::json_result;
using pdp_cases::ScriptTransport;
using pdp_cases::status_only;

inline PdpOptions search_options(size_t pages = 10, size_t items = 1000) {
  PdpOptions options = pdp_cases::chunk_options();
  options.base_path = "/p";
  options.discovery = true;
  options.identifier = "http://pdp:8086/p";
  options.search_max_pages = pages;
  options.search_max_items = items;
  return options;
}

inline std::string metadata(bool with_search) {
  std::string out = R"({"policy_decision_point":"http://pdp:8086/p","access_evaluation_endpoint":"http://pdp:8086/p/access/v1/evaluation",)"
                    R"("access_evaluations_endpoint":"http://pdp:8086/p/access/v1/evaluations")";
  if (with_search) out += R"(,"search_resource_endpoint":"http://pdp:8086/p/s")";
  return out + "}";
}

inline bool is_search(const ScriptTransport::Call& call) { return call.path == "/p/s"; }

inline std::string action_of(const ScriptTransport::Call& call) {
  rapidjson::Document doc;
  doc.Parse(call.body.c_str(), call.body.size());
  return doc.HasMember("action") ? doc["action"]["name"].GetString() : "";
}

// The evaluations of the host: every item false (or true), by the flag.
inline PdpHttpResult evaluations(const ScriptTransport::Call& call, bool value) {
  rapidjson::Document doc;
  doc.Parse(call.body.c_str(), call.body.size());
  std::string body = doc.HasMember("evaluations") ? R"({"evaluations":[)" : "";
  const size_t count = doc.HasMember("evaluations") ? doc["evaluations"].Size() : 1;
  for (size_t i = 0; i < count; ++i) body += std::string(i ? "," : "") + (value ? R"({"decision":true})" : R"({"decision":false})");
  return json_result(doc.HasMember("evaluations") ? body + "]}" : body);
}

struct Rig {
  ScriptTransport* fake = nullptr;
  std::unique_ptr<PdpClient> client;
};

inline Rig make_rig(bool announce, std::function<PdpHttpResult(const ScriptTransport::Call&, size_t)> script, PdpOptions options = search_options()) {
  auto transport = std::make_unique<ScriptTransport>();
  Rig rig;
  rig.fake = transport.get();
  const std::string document = metadata(announce);
  transport->get_script = [document](const ScriptTransport::Call&, size_t) { return json_result(document); };
  transport->script = std::move(script);
  rig.client = std::make_unique<PdpClient>(options, std::move(transport));
  rig.client->discover(PdpCallContext{});
  return rig;
}

inline size_t searches_of(const ScriptTransport& fake) {
  size_t count = 0;
  for (const auto& call : fake.calls) count += call.method == "POST" && is_search(call) ? 1 : 0;
  return count;
}

inline std::set<std::string> sorted(const std::unordered_set<std::string>& ids) { return std::set<std::string>(ids.begin(), ids.end()); }

inline void test_search_not_used() {
  const std::vector<std::string> actions = {"explorer.read"};
  const auto script = [](const ScriptTransport::Call& call, size_t) { return is_search(call) ? json_result(R"({"results":[]})") : evaluations(call, false); };
  // The configuration is off: nothing is sent, even with the endpoint announced.
  Rig off = make_rig(true, script);
  const size_t before = off.fake->calls.size();
  CHECK(access_search_databases(*off.client, false, "db", "prod", "alice", actions, PdpCallContext{}).kind == AccessSearchKind::Unused);
  CHECK_EQ(off.fake->calls.size(), before);
  // The metadata does not announce the endpoint: nothing is sent.
  Rig absent = make_rig(false, script);
  const size_t absent_before = absent.fake->calls.size();
  CHECK(access_search_databases(*absent.client, true, "db", "prod", "alice", actions, PdpCallContext{}).kind == AccessSearchKind::Unused);
  CHECK_EQ(absent.fake->calls.size(), absent_before);
  // No subject, no action, no host: nothing is sent.
  CHECK(access_search_databases(*off.client, true, "db", "prod", "", actions, PdpCallContext{}).kind == AccessSearchKind::Unused);
  CHECK(access_search_databases(*off.client, true, "db", "prod", "alice", {}, PdpCallContext{}).kind == AccessSearchKind::Unused);
  CHECK(access_search_databases(*off.client, true, "db", "", "alice", actions, PdpCallContext{}).kind == AccessSearchKind::Unused);
  CHECK_EQ(off.fake->calls.size(), before);
}

inline void test_search_union_and_request() {
  // Two actions: explorer.read gives a, b, x on two pages; query.run.read gives b and c. The union is a, b, c, x.
  const auto script = [](const ScriptTransport::Call& call, size_t) {
    if (!is_search(call)) return evaluations(call, false);
    rapidjson::Document request;
    request.Parse(call.body.c_str(), call.body.size());
    const std::string action = request["action"]["name"].GetString();
    const bool second = request.HasMember("page") && request["page"].HasMember("token");
    if (action == "explorer.read" && !second) return json_result(R"({"page":{"next_token":"t2"},"results":[{"type":"database","id":"a"},{"type":"database","id":"b"}]})");
    if (action == "explorer.read") return json_result(R"({"results":[{"type":"database","id":"x"}]})");
    return json_result(R"({"results":[{"type":"database","id":"b"},{"type":"database","id":"c"}]})");
  };
  Rig rig = make_rig(true, script);
  PdpCallContext context;
  context.request_id = "r1";
  const AccessSearchOutcome found = access_search_databases(*rig.client, true, "db", "prod", "alice", {"explorer.read", "query.run.read", "explorer.read"}, context);
  CHECK(found.kind == AccessSearchKind::Ids);
  CHECK(sorted(found.ids) == (std::set<std::string>{"a", "b", "c", "x"}));
  // The calls: the GET of the metadata, one batch for the host (a duplicate action is asked once), then 2 searches of one action and 1 of the other.
  CHECK_EQ(searches_of(*rig.fake), size_t(3));
  size_t batches = 0;
  for (const auto& call : rig.fake->calls) {
    if (call.method == "POST" && !is_search(call)) {
      ++batches;
      rapidjson::Document doc;
      doc.Parse(call.body.c_str(), call.body.size());
      // The questions of the host: the host resource with the default match "node", one for each action.
      CHECK(doc["evaluations"].Size() == 2);
      CHECK(doc["evaluations"][0]["resource"]["type"] == "host" && doc["evaluations"][0]["resource"]["id"] == "prod");
      CHECK(!doc["evaluations"][0].HasMember("context"));
    }
    if (call.method == "POST" && is_search(call)) {
      rapidjson::Document doc;
      doc.Parse(call.body.c_str(), call.body.size());
      // The subject is the sub; the type is database without an id; the ancestors are the service and the host.
      CHECK(doc["subject"]["id"] == "alice" && doc["resource"]["type"] == "database" && !doc["resource"].HasMember("id"));
      const auto& ancestors = doc["resource"]["properties"]["ancestors"];
      CHECK(ancestors.Size() == 2 && ancestors[0]["type"] == "service" && ancestors[0]["id"] == "db");
      CHECK(ancestors[1]["type"] == "host" && ancestors[1]["id"] == "prod");
    }
  }
  CHECK_EQ(batches, size_t(1));
}

inline void test_search_covered_by_the_host() {
  // A grant on the host (or on the service) gives true on the host: no search runs, the caller keeps every database.
  Rig rig = make_rig(true, [](const ScriptTransport::Call& call, size_t) {
    if (is_search(call)) return json_result(R"({"results":[]})");
    return evaluations(call, true);
  });
  const AccessSearchOutcome found = access_search_databases(*rig.client, true, "db", "prod", "alice", {"explorer.read"}, PdpCallContext{});
  CHECK(found.kind == AccessSearchKind::Covered && found.ids.empty());
  CHECK_EQ(searches_of(*rig.fake), size_t(0));
}

inline void test_search_fallbacks() {
  const std::vector<std::string> actions = {"explorer.read", "query.run.read"};
  const auto fallback_with = [&](std::function<PdpHttpResult(const ScriptTransport::Call&, size_t)> script, PdpOptions options, const std::string& reason_part) {
    Rig rig = make_rig(true, std::move(script), options);
    const AccessSearchOutcome found = access_search_databases(*rig.client, true, "db", "prod", "alice", actions, PdpCallContext{});
    CHECK(found.kind == AccessSearchKind::Fallback);
    CHECK(found.ids.empty());
    CHECK(found.reason.find(reason_part) != std::string::npos);
  };
  // The search fails (HTTP 500): the caller falls back, it never gets an empty set.
  fallback_with([](const ScriptTransport::Call& call, size_t) { return is_search(call) ? status_only(500) : evaluations(call, false); }, search_options(),
                "the search of explorer.read failed");
  // The second action fails after the first one worked: the whole result is dropped.
  fallback_with(
      [](const ScriptTransport::Call& call, size_t) {
        if (!is_search(call)) return evaluations(call, false);
        return action_of(call) == "explorer.read" ? json_result(R"({"results":[{"type":"database","id":"a"}]})") : status_only(503);
      },
      search_options(), "the search of query.run.read failed");
  // A result that is not valid (a resource of another type).
  fallback_with([](const ScriptTransport::Call& call, size_t) { return is_search(call) ? json_result(R"({"results":[{"type":"table","id":"a"}]})") : evaluations(call, false); },
                search_options(), "failed");
  // A result that the bound of the pages cuts: the beginning of the set is not the set.
  fallback_with(
      [](const ScriptTransport::Call& call, size_t index) {
        if (!is_search(call)) return evaluations(call, false);
        return json_result(R"({"page":{"next_token":"n)" + std::to_string(index) + R"("},"results":[{"type":"database","id":"d)" + std::to_string(index) + R"("}]})");
      },
      search_options(3, 1000), "cut by a bound");
  // A result that the bound of the ids cuts.
  fallback_with(
      [](const ScriptTransport::Call& call, size_t) {
        if (!is_search(call)) return evaluations(call, false);
        return json_result(R"({"results":[{"type":"database","id":"a"},{"type":"database","id":"b"},{"type":"database","id":"c"}]})");
      },
      search_options(10, 2), "cut by a bound");
  // The question of the host fails: the caller falls back (the evaluations then give the 503).
  Rig failed = make_rig(true, [](const ScriptTransport::Call& call, size_t) { return is_search(call) ? json_result(R"({"results":[]})") : status_only(500); });
  CHECK(access_search_databases(*failed.client, true, "db", "prod", "alice", actions, PdpCallContext{}).kind == AccessSearchKind::Fallback);
  CHECK_EQ(searches_of(*failed.fake), size_t(0));
}

// The route keeps the databases of SHOW DATABASES that the search returned, then pages them. A page cannot repeat or skip an id.
inline void test_search_intersection_and_pages() {
  Rig rig = make_rig(true, [](const ScriptTransport::Call& call, size_t) {
    if (!is_search(call)) return evaluations(call, false);
    // The PDP ignores the chain of the host: it returns the ids of every host, "other" and "zz" included.
    if (action_of(call) == "explorer.read") return json_result(R"({"results":[{"type":"database","id":"e"},{"type":"database","id":"B"},{"type":"database","id":"zz"}]})");
    return json_result(R"({"results":[{"type":"database","id":"a"},{"type":"database","id":"c"},{"type":"database","id":"other"},{"type":"database","id":"d"}]})");
  });
  const AccessSearchOutcome found = access_search_databases(*rig.client, true, "db", "prod", "alice", {"explorer.read", "query.run.read"}, PdpCallContext{});
  CHECK(found.kind == AccessSearchKind::Ids);
  // SHOW DATABASES of the host. "f" exists but no action allows it. "zz" and "other" do not exist on this host.
  const std::vector<std::string> shown = {"f", "e", "d", "c", "B", "a"};
  const auto page_of = [&](const std::string& after, size_t limit) {
    std::vector<OptionsCandidate> candidates;
    for (const std::string& name : shown) {
      if (found.ids.count(name) != 0) candidates.push_back(OptionsCandidate{name, name});
    }
    OptionsQuery query;
    query.type = "database";
    query.limit = limit;
    if (!after.empty()) {
      std::string id;
      CHECK(access_options_cursor_decode(after, &id));
      query.after = id;
    }
    const OptionsDecide all_true = [](const std::vector<std::string>& ids) -> std::optional<std::vector<bool>> { return std::vector<bool>(ids.size(), true); };
    return access_options_page(std::move(candidates), query, 1, all_true);
  };
  // The order is case-insensitive: a, B, c, d, e. Pages of 2: a B | c d | e.
  std::vector<std::string> seen;
  std::string after;
  size_t pages = 0;
  while (true) {
    const OptionsPage page = page_of(after, 2);
    CHECK(!page.failed);
    for (const auto& item : page.items) seen.push_back(item.id);
    ++pages;
    if (page.next.empty() || pages > 10) break;
    after = page.next;
  }
  CHECK(seen == (std::vector<std::string>{"a", "B", "c", "d", "e"}));
  CHECK_EQ(pages, size_t(3));
  // The same request gives the same page: the search result is a set, and the order does not depend on the PDP.
  const OptionsPage first = page_of("", 2);
  const OptionsPage again = page_of("", 2);
  CHECK(first.items.size() == 2 && first.items[0].id == again.items[0].id && first.next == again.next);
}

} // namespace search_cases
