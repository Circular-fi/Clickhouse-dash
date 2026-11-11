#pragma once

// The decisions of the access of humans (docs/access.md, contract 11.5): the server asks a PDP with the OpenID AuthZEN
// Authorization API 1.0. One question is one subject, one action and one resource. The client:
//   - reads the metadata of the PDP, GET <origin>/.well-known/authzen-configuration[<path>], at the start (AuthZEN 1.0, l.1317, 1362-1364), and
//     asks POST <evaluation endpoint> for one question and POST <evaluations endpoint> for more (one batch). The default endpoints are
//     <url>/access/v1/evaluation and <url>/access/v1/evaluations (l.1382, 1388-1389);
//   - splits a batch in requests of at most max_evaluations questions, and within the maxima that the PDP publishes (ProcurAuth 10.7a);
//     a failed request fails its questions only;
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
//     kept for the lower of retry_after and cache_ttl;
//   - sends the question of a use of an action that lists a budget with decide_use (ProcurAuth 6.4, 6.11, 10.1, 10.6): one Access Evaluation
//     with "context": {"usage": {"units": 1}}, never in a batch and never with the match "subtree". It waits for usage_timeout() and never
//     sends the request again: no pool retry, no second try after a timeout or a lost answer. A true answer without context.usage.units is
//     false (6.12). The answers of the uses have their own entries in the cache, apart from the other answers: only a true answer with units 0
//     and a false answer with budget_exceeded are kept (10.1), and a kept budget_exceeded gives the seconds that remain as retry_after;
//   - bounds the cache by a count of entries and by a count of bytes (cache_entries and cache_bytes). When the cache is full, it
//     removes the expired answers, then the oldest answers until the new answer fits;
//   - keeps a small pool of connections open (ProcurAuth 10.7), http or https, with one deadline for each request (connect, TLS, write and
//     read together);
//   - writes one log line access.decision for each decision (subject, action, the path of the resource, match, decision, source,
//     reason, failed). It never writes the token.
//
// The approval of a person for an effect (ProcurAuth section 17, docs/access.md, "Approval of a write"):
//   - a question with an effect (AccessQuestion::approval_effect) carries "context": {"approval": {"effect": ...}} and, for a use, the usage.
//     The client never keeps the answer to such a question, and never keeps an answer with a reason of 17.1 (10.1). It reads the
//     evaluation_id of a false answer and gives it back, without a read, to approval_submit;
//   - approval_submit and approval_verdict are the narrow API of 17.4 (POST /approval/v1/requests and GET /approval/v1/requests/<id>). They
//     use the token of the PDP. The client learns the id, the code and the verdict of a request, and nothing more: it reads no other member
//     of an answer and writes no text of an agent or of a person in a log.
//
// The routes map a decision with access_outcome and access_refusal (ProcurAuth 10.3): Allowed, Denied (403), BudgetExceeded (429 with
// Retry-After) or Failed (503, retryable). A true decision with a ceiling that the server cannot apply is false (7.5): the server
// checks it with ceilings_enforceable.

#include "access_resource.hpp"

#include <atomic>
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
  // ProcurAuth 17.1: the effect of the operation, "sha256:" and 64 hexadecimal digits. Only PdpClient::decide_approval sends it. Empty: the
  // question has no context.approval.
  std::string approval_effect;
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
  // The reasons of ProcurAuth 17.1: the action needs the approval of a person.
  ApprovalRequired,
  ApprovalPending,
  ApprovalDenied,
  ApprovalExpired,
  Other,
};

// True for the four reasons of the approval (ProcurAuth 17.1).
bool pdp_reason_is_approval(PdpReason reason);

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
  // context.evaluation_id of a false decision with the reason approval_required or approval_pending (ProcurAuth 17.1): a text that only the PDP
  // reads. The client gives it back in the submission and never reads it. At most 1024 bytes.
  std::string evaluation_id;
  // context.limits of a true decision. Always empty for a false decision: ChDash ignores the limits of a false answer (7.6).
  PdpLimits limits;
  // context.usage.units of a true decision (0 or 1), when the answer has it (6.12).
  std::optional<uint64_t> usage_units;
  // context.error of an item (AuthZEN 1.0, l.866-903): the status and the message that the PDP gives for this item. For the logs only.
  // A context.error that has another form is ignored. The message is cut to 200 bytes.
  std::optional<int64_t> error_status;
  std::string error_message;
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
  std::string evaluation_id;
  PdpLimits limits;
  std::optional<uint64_t> usage_units;
  // True when the PDP answered true to a question with context.usage but gave no context.usage.units. ProcurAuth 6.12 treats this answer
  // as false: `allowed` is false, with no reason and no ceiling. The flag lets a caller see that the answer is not a plain denial.
  bool usage_invalid = false;
  // context.error of the item (PdpAnswer::error_status). For the logs only: a client never gets it.
  std::optional<int64_t> error_status;
  std::string error_message;
  // The name of the first ceiling that made a true answer false because this path cannot apply it (access_enforce_ceilings, ProcurAuth 7.5).
  // It is empty for any other decision. It is for the logs and for the precise refusal of the keys of MCP. It never leaves the server.
  std::string ceiling_refused;
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
  std::string error_code;                 // "forbidden", "too_many_requests", "pdp_unavailable" or "approval_cannot_wait" (ProcurAuth 17.7a)
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
  std::string method = "POST";
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
  // The value of the response header X-Request-ID, when the response has it (AuthZEN 1.0, l.1449-1451).
  std::optional<std::string> request_id;
};

// The HTTP part, which a test replaces. A path is the whole path of the request: the path of the base URL and then the path of the endpoint.
class PdpTransport {
public:
  virtual ~PdpTransport() = default;
  // POST with a JSON body. A question can go again: when a connection that the pool kept is closed before any byte of the answer came, the
  // real transport sends the request again, one time, on a new connection, within the same timeout.
  virtual PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                             std::chrono::milliseconds timeout) = 0;
  // The same POST, but it never goes again (ProcurAuth 10.6: a question with context.usage counts units). The default calls post.
  virtual PdpHttpResult post_once(const std::string& path, const std::string& body,
                                  const std::vector<std::pair<std::string, std::string>>& headers, std::chrono::milliseconds timeout) {
    return post(path, body, headers, timeout);
  }
  // GET of the metadata. The default gives an error.
  virtual PdpHttpResult get(const std::string& path, const std::vector<std::pair<std::string, std::string>>& headers, std::chrono::milliseconds timeout) {
    (void)path;
    (void)headers;
    (void)timeout;
    PdpHttpResult out;
    out.error = "this transport has no GET";
    return out;
  }
  // The time after which the pool closes an idle connection (ProcurAuth 10.7). The default does nothing.
  virtual void set_idle_close(std::chrono::milliseconds idle) { (void)idle; }
};

// The parts of an address of the PDP: http://host[:port][/path] or https://host[:port][/path]. A path has no slash at its end. No user, no
// password, no query and no fragment.
struct PdpUrl {
  bool https = false;
  std::string host;  // without the brackets of an IPv6 address
  int port = 80;     // 443 for https, when the address has no port
  std::string base_path;  // "" or "/path"
};
// nullopt when `text` is not such an address; `error` then says what is wrong.
std::optional<PdpUrl> parse_pdp_url(std::string_view text, std::string* error);
// True for localhost, 127.0.0.0/8 and ::1: a link that does not leave the host.
bool pdp_host_is_loopback(std::string_view host);

// True in a build with the TLS client (CHDASH_HAVE_TLS, the static OpenSSL).
bool pdp_tls_available();
// "" when `path` is a readable file of PEM certificates that OpenSSL can read (at least one), else the reason. Without TLS in the build, the
// reason says it.
std::string pdp_check_ca_file(const std::string& path);

struct PdpTransportOptions {
  PdpUrl url;
  // https only. An empty ca_file is the store of the system (the directory of the build of OpenSSL, /etc/ssl): the transport never reads
  // SSL_CERT_FILE or SSL_CERT_DIR. A ca_file replaces that store.
  std::string ca_file;
  // https only. false: no check of the chain and of the name of the certificate.
  bool verify = true;
  // The largest number of idle connections that the pool keeps.
  size_t max_idle = 4;
  // The largest body of a response; a larger body is an error. It bounds the memory, whatever the PDP sends.
  size_t max_body_bytes = 1024 * 1024;
  // The time after which the pool closes an idle connection until the PDP publishes its own time (set_idle_close).
  std::chrono::milliseconds idle_close{5000};
};

// The transport of the PDP: one HTTP/1.1 client over a socket, with TLS for https (a build with CHDASH_HAVE_TLS). It keeps connections
// open and gives each request one deadline for the connect, the TLS handshake, the write and the read. It never follows a redirect.
// nullptr when the transport cannot start (https in a build without TLS, a ca_file that OpenSSL cannot read): `error` says why.
std::unique_ptr<PdpTransport> make_pdp_transport(const PdpTransportOptions& options, std::string* error);

struct PdpOptions {
  std::string token;
  // The deadline of one request to the PDP: connect, TLS, write and read together.
  std::chrono::milliseconds timeout{500};
  // 0: no cache.
  std::chrono::milliseconds cache_ttl{30000};
  size_t cache_entries = 16384;
  // The largest sum of the bytes of the entries (cache_entry_bytes). The client chooses the resource id, so a count of entries
  // alone does not bound the memory.
  size_t cache_bytes = 8 * 1024 * 1024;
  // The largest body of an answer.
  size_t max_answer_bytes = 256 * 1024;
  // The largest number of questions in one request to the PDP. A batch with more questions goes in several requests, in order. The
  // metadata of the PDP can lower it (procurauth_evaluations_max_items).
  size_t max_evaluations = 100;
  // The longest time of all the requests of one call of decide() that goes in more than one request (access.pdp.batch_timeout). Each request
  // keeps `timeout`, and no request goes past this deadline. When the deadline cuts the call, every question of the call fails: a call
  // never gives a part of its answers. A call of one request has only `timeout`.
  std::chrono::milliseconds batch_timeout{2000};
  // The highest procurauth_usage_max_seconds of the metadata that the client accepts (access.pdp.usage_max_seconds). A document with a
  // larger value cannot be used (discover gives Invalid): nothing lowers the published time.
  uint64_t usage_max_seconds = 120;
  // The path of the base URL ("" or "/path"). It starts every path that the client builds from the default endpoints.
  std::string base_path;
  // true: the client reads the metadata of the PDP (AuthZEN 1.0, l.1317) before its first question. `identifier` is the base URL as the
  // configuration spells it: the metadata must name it in policy_decision_point (l.1364), and its endpoints must have its origin.
  bool discovery = false;
  std::string identifier;
  // The bounds of the search of resources (search_resources).
  size_t search_max_pages = 10;
  size_t search_max_items = 1000;
};

// The endpoints and the maxima of the PDP: its metadata, or the defaults when the PDP has no metadata. A path is the whole path.
struct PdpEndpoints {
  std::string evaluation;
  std::string evaluations;
  // Empty when the PDP does not announce a Resource Search endpoint (AuthZEN 1.0, l.1296-1299).
  std::string search_resource;
  // The members procurauth_* of the metadata (ProcurAuth 6.9, 10.7, 10.7a). Each is a whole number from 1.
  std::optional<uint64_t> usage_max_seconds;
  std::optional<uint64_t> idle_max_seconds;
  std::optional<uint64_t> evaluations_max_bytes;
  std::optional<uint64_t> evaluations_max_items;
};

enum class PdpDiscoveryState {
  Loaded,       // a valid document: its endpoints apply
  Absent,       // HTTP 404: the PDP has no metadata; the default endpoints apply
  Unreachable,  // no answer or another status: the client tries again at a later question
  Invalid,      // a document that cannot be used: the start stops
};

struct PdpDiscoveryResult {
  PdpDiscoveryState state = PdpDiscoveryState::Unreachable;
  std::string message;  // what is wrong; empty for Loaded and Absent
};

// One page of a Resource Search (AuthZEN 1.0, l.1151-1210).
struct PdpSearchPage {
  bool ok = false;
  std::vector<std::string> ids;  // the ids of the resources of the type that the question names
  std::string next_token;        // empty: the last page
  std::string error;
};

// The result of a search through all the pages, within the bounds search_max_pages and search_max_items.
struct PdpSearchResult {
  bool ok = false;
  // true when a bound stopped the search before the last page: `ids` is the beginning of the result.
  bool truncated = false;
  std::vector<std::string> ids;
  std::string error;
};

// The verdict of a request (ProcurAuth 17.6): the only state that a PEP learns. A text that is not one of the four is Void (17.7).
enum class PdpVerdict { Pending, Approved, Denied, Void };
const char* pdp_verdict_name(PdpVerdict verdict);
// pending, approved, denied or void; any other text gives Void and *known false (when it is not null).
PdpVerdict pdp_verdict_of(std::string_view text, bool* known = nullptr);

// The body of a submission (ProcurAuth 17.4). `op_json` and `view_json` are JSON texts that the caller built (valid, compact).
struct PdpApprovalRequest {
  std::string evaluation_id;
  std::string effect;
  std::string op_json;
  std::string view_json;
  // Exactly one of the three controls of the agent (17.5, binding 5.7), as the agent gave it.
  enum class Control { ApprovalRef, LeaseSeconds, Until } control = Control::LeaseSeconds;
  std::string control_text;       // approval_ref or until
  uint64_t lease_seconds = 0;     // lease_s
  std::string supersedes;         // empty: none
};

// The answer of the approval API, mapped as the binding says (5.7a). `status` Ok: the request exists (request_id and code for a submission,
// verdict for a read). NoDevice: 409 no_device. RateLimited: 429 with retry_after. InvalidArgument: 413, 422 invalid_argument, invalid_lease
// or lease_required, and 404 for a read (an unknown request, or the request of another subject). Unavailable: any other answer, no answer, an
// answer that is not valid (fail closed).
struct PdpApprovalReply {
  enum class Status { Ok, NoDevice, RateLimited, InvalidArgument, Unavailable } status = Status::Unavailable;
  std::string request_id;
  std::string code;
  PdpVerdict verdict = PdpVerdict::Void;
  uint64_t retry_after = 1;
  int http_status = 0;
};

class PdpClient {
public:
  PdpClient(PdpOptions options, std::unique_ptr<PdpTransport> transport, std::function<void(const PdpCall&)> on_call = {});

  // The decisions of `subject` for `questions`, in their order. The questions that the cache does not answer go to the PDP in requests of
  // at most max_evaluations questions (and within the maxima of the metadata), sent in order. A request that fails gives a failed
  // decision to its questions only. After a request that got no answer (a timeout or a connection error), the later requests of the call
  // are not sent: each of their questions is failed, without a new wait. A call of several requests has one deadline, batch_timeout: a
  // request never waits past it, and when the deadline cuts the call, every decision of the call is failed (also the answered ones).
  std::vector<AccessDecision> decide(const std::string& subject, const std::vector<AccessQuestion>& questions, const PdpCallContext& context);

  // The question of one use of an action that lists a budget (ProcurAuth 6.4): ONE Access Evaluation with context.usage = {"units": 1}.
  // `question` has the match "node" (6.11: context.usage and the match "subtree" are not sent together; such a question fails). The
  // request goes by PdpTransport::post_once with usage_timeout(), so nothing sends it again after a timeout, a lost answer or a
  // connection error (10.6): the decision is failed and the units that the PDP took stay counted. The cache answers only with a kept true
  // answer with units 0 or a kept budget_exceeded (10.1). The result has these cases:
  //   - allowed, usage_units 0 or 1: the use runs; limits are the ceilings of the answer (6.4, 10 step 6);
  //   - allowed false with usage_invalid: the PDP answered true without units (6.12);
  //   - allowed false, reason BudgetExceeded and retry_after: the route answers 429 (10.3);
  //   - failed: no valid answer: the route answers 503.
  AccessDecision decide_use(const std::string& subject, const AccessQuestion& question, const PdpCallContext& context);

  // The question of an action with the member `approval` (ProcurAuth 17.1, 17.2): ONE Access Evaluation with context.approval.effect =
  // question.approval_effect (it must not be empty), and with context.usage = {"units": 1} when `usage` is true. The cache never answers it
  // and never keeps its answer. Without usage the request can go again after a lost connection. With usage it never goes again (10.6): no
  // answer gives a failed decision. A true answer to a question with usage must carry context.usage.units (6.12). The false answers with the
  // reasons of 17.1 keep the reason and the evaluation_id. `question.match` must be Node.
  // `units_optional`: a true answer to a question with usage may have no context.usage.units (the action lists no budget, so the PDP may leave
  // the member out: the use then counts 0). The call of an action that lists a budget never sets it.
  AccessDecision decide_approval(const std::string& subject, const AccessQuestion& question, bool usage, bool units_optional,
                                 const PdpCallContext& context);
  // The body of that request. For the tests.
  static std::string approval_request_body(const std::string& subject, const AccessQuestion& question, bool usage);

  // The approval API (ProcurAuth 17.4). The first one sends POST <base path>/approval/v1/requests with the token of the PDP. The second sends
  // GET <base path>/approval/v1/requests/<request_id>?subject=<subject>[&wait=<seconds>][&renew=true]. `wait_seconds` 0 sends no wait. A read
  // renews the lease only with `renew` (a call of the agent, never a timer: 17.7).
  PdpApprovalReply approval_submit(const PdpApprovalRequest& request, const PdpCallContext& context);
  PdpApprovalReply approval_verdict(const std::string& request_id, const std::string& subject, uint64_t wait_seconds, bool renew,
                                    const PdpCallContext& context);
  // The body of a submission, and the path of a read. For the tests.
  static std::string approval_submit_body(const PdpApprovalRequest& request);
  static std::string approval_verdict_path(const std::string& base_path, const std::string& request_id, const std::string& subject,
                                           uint64_t wait_seconds, bool renew);
  // The reading of an answer of the approval API for a status and a body. For the tests.
  static PdpApprovalReply parse_approval_reply(int status, const std::string& body, std::optional<uint64_t> retry_after_header, bool submission);

  // One attempt to read the metadata of the PDP (AuthZEN 1.0, l.1327-1334). Loaded and Absent set the endpoints of the client; the other
  // states keep them. The server calls it at the start: Invalid stops the start, Unreachable is a warning. With PdpOptions::discovery,
  // decide() also calls it before a question while no metadata is known (at most once each second), and again after one hour. A document
  // with procurauth_usage_max_seconds above PdpOptions::usage_max_seconds is Invalid: the message names the key, the value and the limit.
  PdpDiscoveryResult discover(const PdpCallContext& context);
  // The endpoints that apply now (the defaults before a discovery).
  PdpEndpoints endpoints();
  // The wait for a question with context.usage (ProcurAuth 6.9, 10.6): procurauth_usage_max_seconds plus one second when the PDP publishes
  // it, never shorter than the timeout. The published value is never above PdpOptions::usage_max_seconds (discover), so nothing lowers it.
  std::chrono::milliseconds usage_timeout();
  // The reading of a metadata document: false, and `error` says why, when it cannot be used. `identifier` is the base URL of the
  // configuration. An absent endpoint of evaluation or evaluations, an endpoint of another origin, a policy_decision_point that is not
  // `identifier`, a procurauth_* member that is not a whole number from 1: not valid. Other members are ignored (l.1342).
  static bool parse_metadata(const std::string& body, const std::string& identifier, PdpEndpoints* out, std::string* error);

  // A Resource Search (AuthZEN 1.0, l.1151-1210): the ids of the resources of `resource_type` below `ancestors` on which `subject` can do
  // `action`. It needs the metadata member search_resource_endpoint: without it, ok is false. The chain `ancestors` goes in
  // resource.properties.ancestors, as in a question. The call follows page.next_token (l.916-960) up to search_max_pages pages and
  // search_max_items ids. Nothing is cached. A page that is not valid, a result of another type, or a token that repeats makes ok false.
  PdpSearchResult search_resources(const std::string& subject, const std::string& action, const std::string& resource_type,
                                   const std::vector<AccessNode>& ancestors, const PdpCallContext& context);
  // One page: `page_token` is empty for the first page, else the next_token of the page before. `limit` 0 sends no limit.
  PdpSearchPage search_resources_page(const std::string& subject, const std::string& action, const std::string& resource_type,
                                      const std::vector<AccessNode>& ancestors, const std::string& page_token, size_t limit,
                                      const PdpCallContext& context);
  static std::string search_request_body(const std::string& subject, const std::string& action, const std::string& resource_type,
                                         const std::vector<AccessNode>& ancestors, const std::string& page_token, size_t limit);
  // The reading of a search answer for `resource_type`: false when it is not valid.
  static bool parse_search_answer(const std::string& body, const std::string& resource_type, PdpSearchPage* page);

  // The body of a request (evaluation for one question, evaluations for more). For the tests.
  static std::string request_body(const std::string& subject, const std::vector<AccessQuestion>& questions);
  // The body of the request of decide_use: one evaluation with "context": {"usage": {"units": 1}}. For the tests.
  static std::string use_request_body(const std::string& subject, const AccessQuestion& question);
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

  // One request of decide(): the questions `ask` (the indices into `questions`) go in one call, with the deadline `timeout`. It sets out[]
  // and the cache. It returns false when the PDP gave no answer in time (a timeout or a connection error).
  bool ask_chunk(const std::string& subject, const std::vector<AccessQuestion>& questions, const std::vector<size_t>& ask,
                 const PdpEndpoints& endpoints, const PdpCallContext& context, std::chrono::milliseconds timeout, std::vector<AccessDecision>* out);
  // The groups of questions of one call, each within the maxima.
  std::vector<std::vector<size_t>> plan_chunks(const std::string& subject, const std::vector<AccessQuestion>& questions, const std::vector<size_t>& ask,
                                               const PdpEndpoints& endpoints) const;
  // The endpoints for a question: true when the metadata is known (or not needed).
  bool ensure_metadata(const PdpCallContext& context, PdpEndpoints* out);
  // The headers of a request and the CLIENT span of a call.
  std::vector<std::pair<std::string, std::string>> request_headers(const PdpCallContext& context, PdpCall* call) const;
  // Check the status, the size and the echoed X-Request-ID of a result; the text of the fault, or "" when the result is good.
  std::string check_result(const PdpHttpResult& result, std::chrono::steady_clock::duration elapsed, const PdpCallContext& context, const std::string& path,
                           std::chrono::milliseconds timeout);
  // The key of the entry of a use (decide_use): apart from the keys of the other answers.
  std::string use_cache_key(const std::string& subject, const AccessQuestion& question) const;

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

  // The metadata. meta_mu_ guards the state and is never held during a request; discovery_mu_ lets one thread read the metadata at a time.
  std::mutex meta_mu_;
  std::mutex discovery_mu_;
  PdpEndpoints endpoints_;
  bool meta_known_ = false;  // the metadata, or its absence, was read
  std::chrono::steady_clock::time_point meta_valid_until_{};
  std::chrono::steady_clock::time_point meta_next_attempt_{};
  // The last time that the client wrote the warning of an X-Request-ID that the PDP did not echo.
  std::atomic<int64_t> request_id_warned_ms_{0};
};

} // namespace chdash
