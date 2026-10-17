#pragma once

// The decisions of the access of humans (docs/access.md, contract 11.5): the server asks a PDP with the OpenID AuthZEN
// Authorization API 1.0. One question is one subject, one action and one resource. The client:
//   - asks POST <url>/access/v1/evaluation for one question and POST <url>/access/v1/evaluations for more (one batch);
//   - sends Authorization: Bearer <token>, X-Request-ID and a traceparent;
//   - fails closed: no answer before the timeout, a status that is not 200 or a body that is not an answer gives false;
//   - keeps an answer of the PDP for cache_ttl at most (subject, action and resource are the key), never a failure;
//   - bounds the cache by a count of entries and by a count of bytes (cache_entries and cache_bytes);
//   - writes one log line access.decision for each decision (subject, action, resource, decision, source).

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace chdash {

struct AccessResource {
  std::string type;  // "service" or "database"
  std::string id;
};

struct AccessQuestion {
  std::string action;
  AccessResource resource;
};

struct AccessDecision {
  bool allowed = false;
  // "pdp" (the PDP answered now), "cache" (an answer of the PDP that is kept), "error" (no valid answer: false).
  const char* source = "error";
};

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
  static bool parse_answer(const std::string& body, size_t count, std::vector<bool>* decisions);
  // The bytes that one entry of the cache counts: its key and a fixed part for the node of the map.
  static size_t cache_entry_bytes(const std::string& key);

  // The entries and the bytes that the cache holds now. For the tests.
  size_t cached_entries();
  size_t cached_bytes();

private:
  std::string cache_key(const std::string& subject, const AccessQuestion& question) const;

  const PdpOptions options_;
  std::unique_ptr<PdpTransport> transport_;
  std::function<void(const PdpCall&)> on_call_;
  std::mutex mu_;
  std::unordered_map<std::string, std::pair<bool, std::chrono::steady_clock::time_point>> cache_;
  size_t cache_used_bytes_ = 0;  // the sum of cache_entry_bytes of the keys of cache_
};

} // namespace chdash
