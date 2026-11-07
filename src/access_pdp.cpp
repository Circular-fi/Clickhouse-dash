#include "access_pdp.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_trace.hpp"
#include "otlp_export.hpp"

#include <httplib.h>
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <iterator>
#include <string_view>

namespace chdash {
namespace {

constexpr const char* kEvaluationPath = "/access/v1/evaluation";
constexpr const char* kEvaluationsPath = "/access/v1/evaluations";

class HttpPdpTransport final : public PdpTransport {
public:
  HttpPdpTransport(std::string host, int port, std::string base_path)
      : host_(std::move(host)), port_(port), base_path_(std::move(base_path)) {}

  PdpHttpResult post(const std::string& path, const std::string& body, const std::vector<std::pair<std::string, std::string>>& headers,
                     std::chrono::milliseconds timeout) override {
    PdpHttpResult out;
    httplib::Client client(host_, port_);
    client.set_connection_timeout(timeout);
    client.set_read_timeout(timeout);
    client.set_write_timeout(timeout);
    client.set_keep_alive(false);
    httplib::Headers request_headers;
    for (const auto& [name, value] : headers) request_headers.emplace(name, value);
    const auto result = client.Post(base_path_ + path, request_headers, body, "application/json");
    if (!result) {
      out.error = httplib::to_string(result.error());
      return out;
    }
    out.status = result->status;
    out.body = result->body;
    return out;
  }

private:
  const std::string host_;
  const int port_;
  const std::string base_path_;
};

void write_entity(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view type, std::string_view id) {
  w.StartObject();
  w.Key("type");
  write_json_text(w, type);
  w.Key("id");
  write_json_text(w, id);
  w.EndObject();
}

// The resource of a question: the type, the id and, below the service, "properties": {"ancestors": [...]} (contract 11.4).
void write_resource(rapidjson::Writer<rapidjson::StringBuffer>& w, const AccessResource& resource) {
  w.StartObject();
  w.Key("type");
  write_json_text(w, resource.type);
  w.Key("id");
  write_json_text(w, resource.id);
  if (!resource.ancestors.empty()) {
    w.Key("properties");
    w.StartObject();
    w.Key("ancestors");
    w.StartArray();
    for (const AccessNode& node : resource.ancestors) write_entity(w, node.type, node.id);
    w.EndArray();
    w.EndObject();
  }
  w.EndObject();
}

void write_action(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view name) {
  w.StartObject();
  w.Key("name");
  write_json_text(w, name);
  w.EndObject();
}

// The context of a question: {"match": "subtree"} for the navigation, else empty (the PDP takes "node").
void write_context(rapidjson::Writer<rapidjson::StringBuffer>& w, AccessMatch match) {
  w.StartObject();
  if (match == AccessMatch::Subtree) {
    w.Key("match");
    w.String("subtree");
  }
  w.EndObject();
}

// The reason of a false decision that tells the server that the PDP does not know the subject (contract 11.5).
constexpr const char* kUnknownSubject = "unknown_subject";

std::string_view text_of(const rapidjson::Value& value) { return std::string_view(value.GetString(), value.GetStringLength()); }

PdpReason reason_of(const rapidjson::Value& value) {
  if (!value.IsString()) return PdpReason::Other;
  const std::string_view text = text_of(value);
  if (text == kUnknownSubject) return PdpReason::UnknownSubject;
  if (text == "invalid_resource") return PdpReason::InvalidResource;
  if (text == "invalid_request") return PdpReason::InvalidRequest;
  if (text == "budget_exceeded") return PdpReason::BudgetExceeded;
  return PdpReason::Other;
}

// context.limits of a true decision (ProcurAuth 7.3): an object of whole numbers from 0, with no name two times.
bool limits_of(const rapidjson::Value& value, PdpLimits* limits) {
  if (!value.IsObject()) return false;
  for (const auto& member : value.GetObject()) {
    // IsUint64 is false for a negative number, a fraction and a number written with a decimal point or an exponent.
    if (!member.value.IsUint64()) return false;
    if (!limits->emplace(std::string(text_of(member.name)), member.value.GetUint64()).second) return false;
  }
  return true;
}

bool decision_of(const rapidjson::Value& value, PdpAnswer* answer) {
  if (!value.IsObject()) return false;
  const auto it = value.FindMember("decision");
  if (it == value.MemberEnd() || !it->value.IsBool()) return false;
  *answer = PdpAnswer{};
  answer->decision = it->value.GetBool();
  const auto context = value.FindMember("context");
  if (context == value.MemberEnd()) return true;
  if (!context->value.IsObject()) return false;
  const rapidjson::Value& members = context->value;
  if (!answer->decision) {
    // A false decision: its reason, and retry_after of budget_exceeded. ChDash ignores its limits and its usage (ProcurAuth 7.6).
    const auto reason = members.FindMember("reason");
    if (reason == members.MemberEnd()) return true;
    answer->reason = reason_of(reason->value);
    answer->unknown_subject = answer->reason == PdpReason::UnknownSubject;
    if (answer->reason == PdpReason::BudgetExceeded) {
      // ProcurAuth 11.1: retry_after is a whole number, at least 1. Without it, a 429 has no Retry-After: the answer is not valid.
      const auto retry = members.FindMember("retry_after");
      if (retry == members.MemberEnd() || !retry->value.IsUint64() || retry->value.GetUint64() < 1) return false;
      answer->retry_after = retry->value.GetUint64();
    }
    return true;
  }
  // A true decision: a reason means nothing (contract 11.5). Its ceilings and its units.
  if (const auto limits = members.FindMember("limits"); limits != members.MemberEnd()) {
    if (!limits_of(limits->value, &answer->limits)) return false;
  }
  if (const auto usage = members.FindMember("usage"); usage != members.MemberEnd()) {
    if (!usage->value.IsObject()) return false;
    if (const auto units = usage->value.FindMember("units"); units != usage->value.MemberEnd()) {
      // ProcurAuth 6.12: 0 or 1.
      if (!units->value.IsUint64() || units->value.GetUint64() > 1) return false;
      answer->usage_units = units->value.GetUint64();
    }
  }
  return true;
}

AccessDecision decision_from(const PdpAnswer& answer, const char* source) {
  AccessDecision out;
  out.allowed = answer.decision;
  out.source = source;
  out.unknown_subject = answer.unknown_subject;
  out.reason = answer.reason;
  out.retry_after = answer.retry_after;
  out.limits = answer.limits;
  out.usage_units = answer.usage_units;
  return out;
}

AccessDecision failed_decision() {
  AccessDecision out;
  out.failed = true;
  return out;
}

} // namespace

const char* access_match_name(AccessMatch match) { return match == AccessMatch::Subtree ? "subtree" : "node"; }

const char* pdp_reason_name(PdpReason reason) {
  switch (reason) {
    case PdpReason::None: return "";
    case PdpReason::UnknownSubject: return kUnknownSubject;
    case PdpReason::InvalidResource: return "invalid_resource";
    case PdpReason::InvalidRequest: return "invalid_request";
    case PdpReason::BudgetExceeded: return "budget_exceeded";
    case PdpReason::Other: return "other";
  }
  return "other";
}

AccessOutcome access_outcome(const AccessDecision& decision) {
  if (decision.failed) return AccessOutcome::Failed;
  if (decision.allowed) return AccessOutcome::Allowed;
  if (decision.reason == PdpReason::BudgetExceeded && decision.retry_after) return AccessOutcome::BudgetExceeded;
  return AccessOutcome::Denied;
}

AccessDecision access_refusal_of(const std::vector<AccessDecision>& decisions) {
  if (decisions.empty()) return failed_decision();
  const AccessDecision* budget = nullptr;
  for (const AccessDecision& decision : decisions) {
    const AccessOutcome outcome = access_outcome(decision);
    if (outcome == AccessOutcome::Failed) return decision;
    if (outcome == AccessOutcome::BudgetExceeded && (!budget || *decision.retry_after > *budget->retry_after)) budget = &decision;
  }
  return budget ? *budget : decisions.front();
}

AccessRefusal access_refusal(const AccessDecision& decision, std::string_view action) {
  AccessRefusal out;
  const std::string name(action);
  switch (access_outcome(decision)) {
    case AccessOutcome::Failed:
      out.status = 503;
      out.error_code = "pdp_unavailable";
      out.message = "The decision for the action " + name + " is not available now. Try again later.";
      out.retryable = true;
      break;
    case AccessOutcome::BudgetExceeded:
      out.status = 429;
      out.error_code = "too_many_requests";
      out.message = "The action " + name + " is not available until the time of Retry-After.";
      out.retryable = true;
      out.retry_after = decision.retry_after;
      break;
    case AccessOutcome::Allowed:
    case AccessOutcome::Denied:
      out.status = 403;
      out.error_code = "forbidden";
      out.message = "The action " + name + " is not allowed.";
      out.retryable = false;
      break;
  }
  return out;
}

bool ceilings_enforceable(const PdpLimits& limits, const std::set<std::string>& declared, std::string* refused) {
  for (const auto& [name, value] : limits) {
    (void)value;
    if (declared.count(name) != 0) continue;
    if (refused) *refused = name;
    return false;
  }
  return true;
}

std::unique_ptr<PdpTransport> make_http_pdp_transport(std::string host, int port, std::string base_path) {
  return std::make_unique<HttpPdpTransport>(std::move(host), port, std::move(base_path));
}

PdpClient::PdpClient(PdpOptions options, std::unique_ptr<PdpTransport> transport, std::function<void(const PdpCall&)> on_call)
    : options_(std::move(options)), transport_(std::move(transport)), on_call_(std::move(on_call)) {}

std::string PdpClient::request_body(const std::string& subject, const std::vector<AccessQuestion>& questions) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("subject");
  write_entity(w, "user", subject);
  if (questions.size() == 1) {
    w.Key("action");
    write_action(w, questions.front().action);
    w.Key("resource");
    write_resource(w, questions.front().resource);
    w.Key("context");
    write_context(w, questions.front().match);
  } else {
    // AuthZEN 1.0, 7.1: the subject at the top is the default of each evaluation.
    w.Key("evaluations");
    w.StartArray();
    for (const AccessQuestion& question : questions) {
      w.StartObject();
      w.Key("action");
      write_action(w, question.action);
      w.Key("resource");
      write_resource(w, question.resource);
      // AuthZEN 1.0, 7.1: the context of an item replaces the default. Only a question of the navigation has one.
      if (question.match == AccessMatch::Subtree) {
        w.Key("context");
        write_context(w, question.match);
      }
      w.EndObject();
    }
    w.EndArray();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

bool PdpClient::parse_answer(const std::string& body, size_t count, std::vector<PdpAnswer>* decisions) {
  decisions->clear();
  rapidjson::Document doc;
  if (!parse_json_bounded(doc, body) || !doc.IsObject()) return false;
  if (count == 1) {
    PdpAnswer answer;
    if (!decision_of(doc, &answer)) return false;
    decisions->push_back(answer);
    return true;
  }
  const auto it = doc.FindMember("evaluations");
  if (it == doc.MemberEnd() || !it->value.IsArray() || it->value.Size() != count) return false;
  for (const auto& item : it->value.GetArray()) {
    PdpAnswer answer;
    if (!decision_of(item, &answer)) {
      decisions->clear();
      return false;
    }
    decisions->push_back(answer);
  }
  return true;
}

std::string PdpClient::cache_key(const std::string& subject, const AccessQuestion& question) const {
  // The path holds the whole chain with encoded ids: two resources with the same type and id under two hosts never share an entry.
  const std::string path = access_resource_path(question.resource);
  std::string key;
  const char* match = access_match_name(question.match);
  key.reserve(subject.size() + question.action.size() + path.size() + 10);
  key.append(subject).push_back('\x1f');
  key.append(question.action).push_back('\x1f');
  key.append(path).push_back('\x1f');
  key.append(match);
  return key;
}

size_t PdpClient::cache_entry_bytes(const std::string& key, const PdpAnswer& answer) {
  // The fixed part is an estimate of the node of the list, the node of the map and the heap block of the key. Each ceiling adds its
  // name and a node of its map.
  constexpr size_t kEntryOverhead = 160;
  constexpr size_t kLimitOverhead = 64;
  size_t out = key.size() + kEntryOverhead;
  for (const auto& [name, value] : answer.limits) {
    (void)value;
    out += name.size() + kLimitOverhead;
  }
  return out;
}

void PdpClient::cache_erase(CacheList::iterator it) {
  cache_used_bytes_ -= it->bytes;
  cache_.erase(std::string_view(it->key));
  cache_order_.erase(it);
}

void PdpClient::cache_store(std::string key, const PdpAnswer& answer, std::chrono::steady_clock::time_point now) {
  if (options_.cache_ttl.count() <= 0) return;
  // ProcurAuth 10.1: never an answer that took units. An answer with units 0 may be kept.
  if (answer.usage_units && *answer.usage_units > 0) return;
  auto life = std::chrono::duration_cast<std::chrono::steady_clock::duration>(options_.cache_ttl);
  // A false answer with budget_exceeded is kept for the lower of retry_after and cache_ttl.
  if (answer.retry_after) life = std::min(life, std::chrono::duration_cast<std::chrono::steady_clock::duration>(std::chrono::seconds(*answer.retry_after)));
  const auto expires = now + life;
  const size_t bytes = cache_entry_bytes(key, answer);
  if (const auto known = cache_.find(std::string_view(key)); known != cache_.end()) cache_erase(known->second);
  // An entry that is larger than the whole budget is not kept.
  if (bytes > options_.cache_bytes || options_.cache_entries == 0) return;
  const auto full = [&] { return cache_.size() >= options_.cache_entries || cache_used_bytes_ + bytes > options_.cache_bytes; };
  if (full() && now >= cache_sweep_after_) {
    // Remove the expired answers, and find the next time that an answer expires.
    auto next = std::chrono::steady_clock::time_point::max();
    for (auto it = cache_order_.begin(); it != cache_order_.end();) {
      if (it->expires <= now) {
        const auto expired = it++;
        cache_erase(expired);
      } else {
        next = std::min(next, it->expires);
        ++it;
      }
    }
    cache_sweep_after_ = next;
  }
  // Then the oldest answers, until the new answer fits.
  while (full() && !cache_order_.empty()) cache_erase(cache_order_.begin());
  cache_order_.push_back(CacheEntry{std::move(key), answer, expires, bytes});
  const auto last = std::prev(cache_order_.end());
  cache_.emplace(std::string_view(last->key), last);
  cache_used_bytes_ += bytes;
  cache_sweep_after_ = std::min(cache_sweep_after_, expires);
}

size_t PdpClient::cached_entries() {
  std::lock_guard<std::mutex> lock(mu_);
  return cache_.size();
}

size_t PdpClient::cached_bytes() {
  std::lock_guard<std::mutex> lock(mu_);
  return cache_used_bytes_;
}

std::vector<AccessDecision> PdpClient::decide(const std::string& subject, const std::vector<AccessQuestion>& questions,
                                              const PdpCallContext& context) {
  std::vector<AccessDecision> out(questions.size());
  std::vector<size_t> ask;  // the questions that the cache does not answer
  const auto now = std::chrono::steady_clock::now();
  {
    std::lock_guard<std::mutex> lock(mu_);
    for (size_t i = 0; i < questions.size(); ++i) {
      if (options_.cache_ttl.count() > 0) {
        const std::string key = cache_key(subject, questions[i]);
        const auto it = cache_.find(std::string_view(key));
        if (it != cache_.end() && it->second->expires > now) {
          out[i] = decision_from(it->second->answer, "cache");
          continue;
        }
      }
      ask.push_back(i);
    }
  }

  if (!ask.empty()) {
    std::vector<AccessQuestion> asked;
    asked.reserve(ask.size());
    for (const size_t i : ask) asked.push_back(questions[i]);

    PdpCall call;
    call.path = asked.size() == 1 ? kEvaluationPath : kEvaluationsPath;
    call.evaluations = asked.size();
    call.trace_id = context.trace_id.empty() ? mcp_random_hex(16) : context.trace_id;
    call.parent_span_id = context.trace_id.empty() ? std::string() : context.parent_span_id;
    call.span_id = mcp_random_hex(8);
    call.sampled = context.sampled;
    std::vector<std::pair<std::string, std::string>> headers = {
        {"Authorization", "Bearer " + options_.token},
        {"Accept", "application/json"},
        {"traceparent", "00-" + call.trace_id + "-" + call.span_id + (call.sampled ? "-01" : "-00")},
    };
    if (!context.request_id.empty()) headers.emplace_back("X-Request-ID", context.request_id);

    call.start_unix_nano = otlp_now_unix_nano();
    const auto started = std::chrono::steady_clock::now();
    PdpHttpResult result = transport_->post(call.path, request_body(subject, asked), headers, options_.timeout);
    const auto elapsed = std::chrono::steady_clock::now() - started;
    call.end_unix_nano = otlp_now_unix_nano();
    call.status = result.status;

    std::vector<PdpAnswer> decisions;
    if (!result.error.empty()) call.error = "no answer: " + result.error;
    else if (elapsed > options_.timeout) call.error = "the answer came after the timeout";
    else if (result.status != 200) call.error = "status " + std::to_string(result.status);
    else if (result.body.size() > options_.max_answer_bytes) call.error = "the answer is too large";
    else if (!parse_answer(result.body, asked.size(), &decisions)) call.error = "the answer is not a valid AuthZEN answer";

    if (call.error.empty()) {
      const auto at = std::chrono::steady_clock::now();
      std::lock_guard<std::mutex> lock(mu_);
      for (size_t k = 0; k < ask.size(); ++k) {
        out[ask[k]] = decision_from(decisions[k], "pdp");
        cache_store(cache_key(subject, questions[ask[k]]), decisions[k], at);
      }
    } else {
      // Fail closed: every question of the call is false, and nothing is kept.
      for (const size_t i : ask) out[i] = failed_decision();
      log_event(LogLevel::Warn, "access.pdp_failed",
                {{"request_id", context.request_id}, {"path", call.path}, {"status", call.status}, {"error", call.error},
                 {"evaluations", static_cast<uint64_t>(call.evaluations)}});
    }
    if (on_call_) on_call_(call);
  }

  for (size_t i = 0; i < questions.size(); ++i) {
    const std::string resource = access_resource_path(questions[i].resource);
    log_event(LogLevel::Info, "access.decision",
              {{"request_id", context.request_id},
               {"subject", subject},
               {"action", questions[i].action},
               {"resource", resource},
               {"match", access_match_name(questions[i].match)},
               {"decision", out[i].allowed},
               {"source", out[i].source},
               {"reason", pdp_reason_name(out[i].reason)},
               {"failed", out[i].failed}});
  }
  return out;
}

} // namespace chdash
