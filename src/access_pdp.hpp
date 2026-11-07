#pragma once

// The decisions of the access of humans (docs/access.md, contract 11.5): the server asks a PDP with the OpenID AuthZEN
// Authorization API 1.0. One question is one subject, one action and one resource. The client:
//   - asks POST <url>/access/v1/evaluation for one question and POST <url>/access/v1/evaluations for more (one batch);
//   - sends Authorization: Bearer <token>, X-Request-ID and a traceparent;
//   - fails closed: no answer before the timeout, a status that is not 200 or a body that is not an answer gives false, with
//     AccessDecision::failed (ProcurAuth 10.3: the route answers 503, not 403);
//   - reads the whole answer of each decision (PdpAnswer): the decision, the reason (ProcurAuth 11.1), retry_after of
//     budget_exceeded, the ceilings of context.limits (7.3) and context.usage.units (6.12). A member of this protocol with a bad
//     type or value makes the whole body not valid: every question of the call fails;
//   - sends the chain of each resource (properties.ancestors, access_resource.hpp) after the type and the id, and
//     "context": {"match": "subtree"} for a question of the navigation (AccessMatch);
//   - keeps the whole answer of the PDP for cache_ttl at most (subject, action, the path of the resource and the match are the key),
//     never a failure and never an answer with context.usage.units above 0 (ProcurAuth 10.1). A false answer with budget_exceeded is
//     kept for the lower of retry_after and cache_ttl. The key has no part for context.usage: the client sends no usage question yet;
//   - bounds the cache by a count of entries and by a count of bytes (cache_entries and cache_bytes). When the cache is full, it
//     removes the expired answers, then the oldest answers until the new answer fits;
//   - writes one log line access.decision for each decision (subject, action, the path of the resource, match, decision, source,
//     reason, failed). It never writes the token.
//
// The routes map a decision with access_outcome and access_refusal (ProcurAuth 10.3): Allowed, Denied (403), BudgetExceeded (429 with
// Retry-After) or Failed (503, retryable). A true decision with a ceiling that the server cannot apply is false (7.5): the server
// checks it with ceilings_enforceable.

#include "access_resource.hpp"

#include <chrono>
#include <cstdint>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

// How the PDP matches a grant with the resource of a question (contract 11.5, addendum 1 of the format of 2026-10-18).
enum class AccessMatch {
  // The default: a grant on the resource or on a node above it. Every operation asks with this match on its exact resource.
  Node,
  // Also a grant on a node below the resource. ChDash uses it only to show or hide an element of the navigation (a host, a page),
  // never to let an operation run.
  Subtree,
};

struct AccessQuestion {
  AccessQuestion() = default;
  AccessQuestion(std::string action_name, AccessResource on, AccessMatch how = AccessMatch::Node)
      : action(std::move(action_name)), resource(std::move(on)), match(how) {}

  std::string action;
  AccessResource resource;
  AccessMatch match = AccessMatch::Node;
};

// "node" or "subtree".
const char* access_match_name(AccessMatch match);

// The ceilings of a true answer (ProcurAuth 7.3): the name of each ceiling and its value, a whole number from 0.
using PdpLimits = std::map<std::string, uint64_t>;

// The reason of a false answer (ProcurAuth 11.1). A true answer has None. A reason that this list does not know, or a reason that is
// not text, is Other: it means nothing more than false.
enum class PdpReason {
  None,
  UnknownSubject,
  InvalidResource,
  InvalidRequest,
  BudgetExceeded,
  Other,
};

// "" for None, else the name of ProcurAuth 11.1 ("other" for Other). For the logs only: a client never gets it (10.3).
const char* pdp_reason_name(PdpReason reason);

// One decision of an answer of the PDP, with its context.
struct PdpAnswer {
  bool decision = false;
  // The false decision has the reason "unknown_subject".
  bool unknown_subject = false;
  // The reason of a false decision; None for a true decision.
  PdpReason reason = PdpReason::None;
  // The seconds of retry_after of a false decision with budget_exceeded: a whole number from 1. Empty for another answer.
  std::optional<uint64_t> retry_after;
  // context.limits of a true decision. Always empty for a false decision: ChDash ignores the limits of a false answer (7.6).
  PdpLimits limits;
  // context.usage.units of a true decision (0 or 1), when the answer has it (6.12).
  std::optional<uint64_t> usage_units;
};

struct AccessDecision {
  bool allowed = false;
  // "pdp" (the PDP answered now), "cache" (an answer of the PDP that is kept), "error" (no valid answer: false).
  const char* source = "error";
  // True when the PDP answered false with "context": {"reason": "unknown_subject"} (contract 11.5): the subject does not exist.
  // Only this reason lets the server treat a resource of the subject as an orphan. It is never true for an error or a true decision.
  bool unknown_subject = false;
  // True when there is no valid answer (no answer, a timeout, a status that is not 200, a body that is too large or not valid).
  // A failed decision is false, but it is not a denial: the route answers 503 (ProcurAuth 10.3).
  bool failed = false;
  // The reason, retry_after, the ceilings and the units of the answer (PdpAnswer). Empty for a failed decision.
  PdpReason reason = PdpReason::None;
  std::optional<uint64_t> retry_after;
  PdpLimits limits;
  std::optional<uint64_t> usage_units;
};

// How a route answers a decision (ProcurAuth 10.3).
enum class AccessOutcome {
  Allowed,         // the operation runs
  Denied,          // false with no reason, or a reason other than budget_exceeded: 403
  BudgetExceeded,  // false with budget_exceeded: 429 with Retry-After
  Failed,          // no valid answer: 503, retryable
};

// The outcome of one decision.
AccessOutcome access_outcome(const AccessDecision& decision);

// The decision that refuses an operation that none of `decisions` allows: a failed decision first (a failure can hide a true answer),
// then the budget_exceeded decision with the largest retry_after, then the first decision. An empty list gives a failed decision.
AccessDecision access_refusal_of(const std::vector<AccessDecision>& decisions);

// The answer of an HTTP route to a refused decision (ProcurAuth 10.3). It never holds the reason of the PDP.
struct AccessRefusal {
  int status = 403;                       // 403, 429 or 503
  std::string error_code;                 // "forbidden", "too_many_requests" or "pdp_unavailable"
  std::string message;
  bool retryable = false;                 // true for 429 and 503
  std::optional<uint64_t> retry_after;    // the value of the header Retry-After (429 only)
};
// The refusal of `action` for `decision`. An allowed decision gives the 403 of the action: call it only for a refused decision.
AccessRefusal access_refusal(const AccessDecision& decision, std::string_view action);

// ProcurAuth 7.5: true when the server can apply each ceiling of `limits`, that is when `declared` holds each name. Else false, and
// *refused (when it is not null) receives the first name that `declared` does not hold. A true answer that fails this check is false.
// `declared` is the set of the ceilings that the server declares for the action of the question. ChDash declares no ceiling yet.
bool ceilings_enforceable(const PdpLimits& limits, const std::set<std::string>& declared, std::string* refused = nullptr);

// What the server knows of the request that asks.
struct PdpCallContext {
  std::string request_id;
  // The trace of the request (its traceparent), when it has one: the CLIENT span of the call is its child.
  std::string trace_id;
  std::string parent_span_id;
  // The flag "sampled" of that traceparent; true when there is none.
  bool sampled = true;
};

// One call to the PDP, for the CLIENT span (docs/server-telemetry.md).
struct PdpCall {
  std::string path;  // "/access/v1/evaluation" or "/access/v1/evaluations"
  std::string trace_id;
  std::string span_id;
  std::string parent_span_id;
  bool sampled = true;
  uint64_t start_unix_nano = 0;
  uint64_t end_unix_nano = 0;
  int status = 0;     // the HTTP status; 0 when there is none
  std::string error;  // empty when the PDP gave a valid answer
  size_t evaluations = 0;
};

struct PdpHttpResult {
  int status = 0;
  std::string body;
  std::string error;  // a connection error or a timeout; empty when there is a status
};

// The HTTP part, which a test replaces.
class PdpTransport {
public:
  virtual ~PdpTransport() = default;
  virtual PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                             std::chrono::milliseconds timeout) = 0;
};

// The transport of cpp-httplib: http://host:port<base_path><path>, a new connection for each call.
std::unique_ptr<PdpTransport> make_http_pdp_transport(std::string host, int port, std::string base_path);

struct PdpOptions {
  std::string token;
  std::chrono::milliseconds timeout{500};
  // 0: no cache.
  std::chrono::milliseconds cache_ttl{30000};
  size_t cache_entries = 16384;
  // The largest sum of the bytes of the entries (cache_entry_bytes). The client chooses the resource id, so a count of entries
  // alone does not bound the memory.
  size_t cache_bytes = 8 * 1024 * 1024;
  // The largest body of an answer.
  size_t max_answer_bytes = 256 * 1024;
};

class PdpClient {
public:
  PdpClient(PdpOptions options, std::unique_ptr<PdpTransport> transport, std::function<void(const PdpCall&)> on_call = {});

  // The decisions of `subject` for `questions`, in their order. The questions that the cache does not answer go to the PDP in
  // one request.
  std::vector<AccessDecision> decide(const std::string& subject, const std::vector<AccessQuestion>& questions, const PdpCallContext& context);

  // The body of a request (evaluation for one question, evaluations for more). For the tests.
  static std::string request_body(const std::string& subject, const std::vector<AccessQuestion>& questions);
  // The decisions of an answer, in the order of the questions; false when the body is not a valid answer for `count` questions.
  // A decision can have a "context" object. A "context" that is not an object makes the answer not valid. Its members:
  //   - "reason" (text) on a false decision gives PdpReason; "unknown_subject" also sets unknown_subject. Another type means Other.
  //   - "retry_after" on a false decision with budget_exceeded: a whole number from 1, else the answer is not valid.
  //   - "limits" on a true decision: an object whose values are whole numbers from 0, with no name two times, else the answer is not
  //     valid. A false decision ignores it (ProcurAuth 7.6).
  //   - "usage" on a true decision: an object; its "units", when present, is 0 or 1, else the answer is not valid.
  // One item that is not valid makes the whole body not valid.
  static bool parse_answer(const std::string& body, size_t count, std::vector<PdpAnswer>* decisions);
  // The bytes that one entry of the cache counts: its key, the names of its ceilings and a fixed part for the nodes of the list and of
  // the map.
  static size_t cache_entry_bytes(const std::string& key, const PdpAnswer& answer);

  // The entries and the bytes that the cache holds now. For the tests.
  size_t cached_entries();
  size_t cached_bytes();

private:
  struct CacheEntry {
    std::string key;
    PdpAnswer answer;
    std::chrono::steady_clock::time_point expires;
    size_t bytes = 0;
  };
  using CacheList = std::list<CacheEntry>;

  std::string cache_key(const std::string& subject, const AccessQuestion& question) const;
  // Keep `answer` under `key` (the caller holds mu_). It does nothing for an answer that the rules do not let the cache keep.
  void cache_store(std::string key, const PdpAnswer& answer, std::chrono::steady_clock::time_point now);
  void cache_erase(CacheList::iterator it);

  const PdpOptions options_;
  std::unique_ptr<PdpTransport> transport_;
  std::function<void(const PdpCall&)> on_call_;
  std::mutex mu_;
  // The kept answers, the oldest first. The map points to the nodes of the list; its keys are views of CacheEntry::key.
  CacheList cache_order_;
  std::unordered_map<std::string_view, CacheList::iterator> cache_;
  size_t cache_used_bytes_ = 0;  // the sum of CacheEntry::bytes
  // No kept answer expires before this time: a full cache looks for the expired answers only after it.
  std::chrono::steady_clock::time_point cache_sweep_after_{};
};

} // namespace chdash
