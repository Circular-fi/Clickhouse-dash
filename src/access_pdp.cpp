#include "access_pdp.hpp"

#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_trace.hpp"
#include "otlp_export.hpp"
#include "telemetry_settings.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <iterator>
#include <string_view>

namespace chdash {
namespace {

constexpr const char* kEvaluationPath = "/access/v1/evaluation";
constexpr const char* kEvaluationsPath = "/access/v1/evaluations";

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

// The context of a question: {"match": "subtree"} for the navigation, else empty (the PDP takes "node"). The question of a use has
// {"usage": {"units": 1}} (ProcurAuth 6.4) and never the match "subtree" (6.11).
void write_context(rapidjson::Writer<rapidjson::StringBuffer>& w, AccessMatch match, bool usage = false) {
  w.StartObject();
  if (match == AccessMatch::Subtree) {
    w.Key("match");
    w.String("subtree");
  }
  if (usage) {
    w.Key("usage");
    w.StartObject();
    w.Key("units");
    w.Uint(1);
    w.EndObject();
  }
  w.EndObject();
}

// One item of "evaluations": the action, the resource and, for a question of the navigation, the context.
void write_evaluation_item(rapidjson::Writer<rapidjson::StringBuffer>& w, const AccessQuestion& question) {
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

size_t evaluation_item_bytes(const AccessQuestion& question) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  write_evaluation_item(w, question);
  return sb.GetSize();
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

// context.error of an item (AuthZEN 1.0, l.866-903): {"status": number, "message": text}. It is for the logs: a form that is not this one is
// ignored, and it never makes the answer not valid. The message is cut to 200 bytes, at the end of a UTF-8 character.
void error_of(const rapidjson::Value& members, PdpAnswer* answer) {
  const auto it = members.FindMember("error");
  if (it == members.MemberEnd() || !it->value.IsObject()) return;
  if (const auto status = it->value.FindMember("status"); status != it->value.MemberEnd() && status->value.IsInt64()) answer->error_status = status->value.GetInt64();
  if (const auto message = it->value.FindMember("message"); message != it->value.MemberEnd() && message->value.IsString()) {
    std::string text(message->value.GetString(), message->value.GetStringLength());
    if (text.size() > 200) {
      text.resize(200);
      while (!text.empty() && (static_cast<unsigned char>(text.back()) & 0xC0) == 0x80) text.pop_back();
      if (!text.empty() && static_cast<unsigned char>(text.back()) >= 0xC0) text.pop_back();
    }
    answer->error_message = std::move(text);
  }
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
  error_of(members, answer);
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
  out.error_status = answer.error_status;
  out.error_message = answer.error_message;
  return out;
}

// The answer of the PDP to a question with context.usage (ProcurAuth 6.12): a true answer must carry context.usage.units. Without it,
// the answer is false, with no reason and no ceiling.
PdpAnswer use_answer_of(PdpAnswer answer) {
  if (answer.decision && !answer.usage_units) {
    answer.decision = false;
    answer.reason = PdpReason::None;
    answer.unknown_subject = false;
    answer.retry_after.reset();
    answer.limits.clear();
  }
  return answer;
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

PdpClient::PdpClient(PdpOptions options, std::unique_ptr<PdpTransport> transport, std::function<void(const PdpCall&)> on_call)
    : options_(std::move(options)), transport_(std::move(transport)), on_call_(std::move(on_call)) {
  // The default endpoints (AuthZEN 1.0, l.1382, 1388-1389) apply until the metadata says otherwise, and when the PDP has none.
  endpoints_.evaluation = options_.base_path + kEvaluationPath;
  endpoints_.evaluations = options_.base_path + kEvaluationsPath;
}

std::string PdpClient::use_request_body(const std::string& subject, const AccessQuestion& question) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("subject");
  write_entity(w, "user", subject);
  w.Key("action");
  write_action(w, question.action);
  w.Key("resource");
  write_resource(w, question.resource);
  w.Key("context");
  write_context(w, question.match, true);
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

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
    for (const AccessQuestion& question : questions) write_evaluation_item(w, question);
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

std::string PdpClient::use_cache_key(const std::string& subject, const AccessQuestion& question) const {
  // The entries of the uses have their own key space (ProcurAuth 10.1). A subject has no control character, so the field U cannot be the
  // start of the key of another answer: that key has four fields, this one has five.
  return "U\x1f" + cache_key(subject, question);
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
  // The comparison is in whole seconds first: a very large retry_after must not overflow the arithmetic of the clock.
  const auto ttl_seconds = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::seconds>(options_.cache_ttl).count());
  if (answer.retry_after && *answer.retry_after <= ttl_seconds) {
    life = std::min(life, std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                              std::chrono::seconds(static_cast<int64_t>(*answer.retry_after))));
  }
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

namespace {

constexpr const char* kMetadataPath = "/.well-known/authzen-configuration";
// The metadata is read again after this time, and a failed read is tried again after the second time.
constexpr auto kMetadataLife = std::chrono::hours(1);
constexpr auto kMetadataRetry = std::chrono::seconds(1);
// A warning about the X-Request-ID that the PDP does not echo is written at most once in this time.
constexpr int64_t kRequestIdWarnEveryMs = 60 * 1000;

int64_t steady_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

// A member of the metadata of ProcurAuth (6.9, 10.7, 10.7a): a whole number from 1. false when it has another form.
bool metadata_number(const rapidjson::Value& doc, const char* name, std::optional<uint64_t>* out, std::string* error) {
  const auto it = doc.FindMember(name);
  if (it == doc.MemberEnd()) return true;
  if (!it->value.IsUint64() || it->value.GetUint64() < 1) {
    *error = std::string(name) + " must be a whole number from 1";
    return false;
  }
  *out = it->value.GetUint64();
  return true;
}

// An endpoint of the metadata: a URL with the origin of the configured base URL (the token of ChDash goes only there) and no query.
bool metadata_endpoint(const rapidjson::Value& doc, const char* name, const PdpUrl& base, bool required, std::string* path, std::string* error) {
  const auto it = doc.FindMember(name);
  if (it == doc.MemberEnd()) {
    if (!required) return true;
    *error = std::string(name) + " is missing";
    return false;
  }
  if (!it->value.IsString()) {
    *error = std::string(name) + " must be a text";
    return false;
  }
  const std::string text(it->value.GetString(), it->value.GetStringLength());
  std::string reason;
  const auto url = parse_pdp_url(text, &reason);
  if (!url) {
    *error = std::string(name) + " " + reason + ", not \"" + text + "\"";
    return false;
  }
  std::string host = url->host;
  std::string base_host = base.host;
  std::transform(host.begin(), host.end(), host.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  std::transform(base_host.begin(), base_host.end(), base_host.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (url->https != base.https || host != base_host || url->port != base.port) {
    *error = std::string(name) + " is not at the address of access.pdp.url (the scheme, the host and the port must be the same), \"" + text + "\"";
    return false;
  }
  if (url->base_path.empty()) {
    *error = std::string(name) + " has no path, \"" + text + "\"";
    return false;
  }
  *path = url->base_path;
  return true;
}

std::string trim_slashes_end(std::string text) {
  while (!text.empty() && text.back() == '/') text.pop_back();
  return text;
}

// The first `limit` bytes of a text (a message of the PDP in a log line).
std::string cut_text(const std::string& text, size_t limit) { return text.size() <= limit ? text : text.substr(0, limit); }

} // namespace

bool PdpClient::parse_metadata(const std::string& body, const std::string& identifier, PdpEndpoints* out, std::string* error) {
  std::string scratch;
  if (!error) error = &scratch;
  rapidjson::Document doc;
  if (!parse_json_bounded(doc, body) || !doc.IsObject()) {
    *error = "the metadata is not a JSON object";
    return false;
  }
  std::string reason;
  const auto base = parse_pdp_url(identifier, &reason);
  if (!base) {
    *error = "access.pdp.url " + reason;
    return false;
  }
  const auto pdp = doc.FindMember("policy_decision_point");
  if (pdp == doc.MemberEnd() || !pdp->value.IsString()) {
    *error = "policy_decision_point is missing or is not a text";
    return false;
  }
  // AuthZEN 1.0, l.1364: the value must be identical to the identifier into which the well-known string was inserted. A slash at the end
  // is not part of the identifier.
  const std::string named = trim_slashes_end(std::string(pdp->value.GetString(), pdp->value.GetStringLength()));
  if (named != trim_slashes_end(identifier)) {
    *error = "policy_decision_point is \"" + cut_text(named, 300) + "\" and access.pdp.url is \"" + cut_text(identifier, 300) + "\"";
    return false;
  }
  PdpEndpoints endpoints;
  if (!metadata_endpoint(doc, "access_evaluation_endpoint", *base, true, &endpoints.evaluation, error)) return false;
  // ChDash sends its questions in batches: a PDP with no Access Evaluations endpoint cannot serve it (l.1290-1294, 1299).
  if (!metadata_endpoint(doc, "access_evaluations_endpoint", *base, true, &endpoints.evaluations, error)) return false;
  if (!metadata_endpoint(doc, "search_resource_endpoint", *base, false, &endpoints.search_resource, error)) return false;
  if (!metadata_number(doc, "procurauth_usage_max_seconds", &endpoints.usage_max_seconds, error)) return false;
  if (!metadata_number(doc, "procurauth_idle_max_seconds", &endpoints.idle_max_seconds, error)) return false;
  if (!metadata_number(doc, "procurauth_evaluations_max_bytes", &endpoints.evaluations_max_bytes, error)) return false;
  if (!metadata_number(doc, "procurauth_evaluations_max_items", &endpoints.evaluations_max_items, error)) return false;
  *out = std::move(endpoints);
  return true;
}

PdpEndpoints PdpClient::endpoints() {
  std::lock_guard<std::mutex> lock(meta_mu_);
  return endpoints_;
}

std::chrono::milliseconds PdpClient::usage_timeout() {
  const PdpEndpoints known = endpoints();
  if (!known.usage_max_seconds) return options_.timeout;
  // "Longer than the longest time": one second more. discover() keeps no value above options_.usage_max_seconds (at most 3600 from the
  // configuration), so the published time applies as it is: nothing lowers it.
  const auto longer = std::chrono::seconds(static_cast<int64_t>(*known.usage_max_seconds) + 1);
  return std::max(options_.timeout, std::chrono::duration_cast<std::chrono::milliseconds>(longer));
}

PdpDiscoveryResult PdpClient::discover(const PdpCallContext& context) {
  PdpDiscoveryResult result;
  // The metadata needs no token (AuthZEN 1.0, l.1327-1334): ChDash sends none, so a wrong address never gets the credential.
  const std::string identifier = options_.identifier;
  std::string reason;
  const auto base = parse_pdp_url(identifier, &reason);
  if (!base) {
    result.state = PdpDiscoveryState::Invalid;
    result.message = "access.pdp.url " + reason;
    return result;
  }
  // l.1317: the well-known string goes between the host and the path.
  const std::string path = std::string(kMetadataPath) + base->base_path;
  std::vector<std::pair<std::string, std::string>> headers = {{"Accept", "application/json"}};
  if (!context.request_id.empty()) headers.emplace_back("X-Request-ID", context.request_id);
  const auto started = std::chrono::steady_clock::now();
  const PdpHttpResult http = transport_->get(path, headers, options_.timeout);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  if (!http.error.empty()) {
    result.message = "no answer from GET " + path + ": " + http.error;
    return result;
  }
  if (elapsed > options_.timeout) {
    result.message = "the answer of GET " + path + " came after the timeout";
    return result;
  }
  if (http.status == 404) {
    PdpEndpoints defaults;
    defaults.evaluation = options_.base_path + kEvaluationPath;
    defaults.evaluations = options_.base_path + kEvaluationsPath;
    {
      std::lock_guard<std::mutex> lock(meta_mu_);
      endpoints_ = defaults;
      meta_known_ = true;
      meta_valid_until_ = std::chrono::steady_clock::now() + kMetadataLife;
    }
    result.state = PdpDiscoveryState::Absent;
    return result;
  }
  if (http.status != 200) {
    result.message = "GET " + path + " gave the status " + std::to_string(http.status);
    return result;
  }
  if (http.body.size() > options_.max_answer_bytes) {
    result.state = PdpDiscoveryState::Invalid;
    result.message = "the metadata is too large";
    return result;
  }
  PdpEndpoints endpoints;
  std::string error;
  if (!parse_metadata(http.body, identifier, &endpoints, &error)) {
    result.state = PdpDiscoveryState::Invalid;
    result.message = error;
    return result;
  }
  // ProcurAuth 6.9, 10.6: the PEP waits longer than the time that the PDP publishes. The configuration bounds this wait: a longer time is
  // not lowered to fit, the document cannot be used (owner decision of 2026-11-07).
  if (endpoints.usage_max_seconds && *endpoints.usage_max_seconds > options_.usage_max_seconds) {
    result.state = PdpDiscoveryState::Invalid;
    result.message = "procurauth_usage_max_seconds of the metadata is " + std::to_string(*endpoints.usage_max_seconds) +
                     ", above access.pdp.usage_max_seconds (" + std::to_string(options_.usage_max_seconds) +
                     "): ChDash does not wait so long for an answer to a question with context.usage. Set access.pdp.usage_max_seconds to " +
                     std::to_string(*endpoints.usage_max_seconds) + " or more (at most 3600), or lower the time that the PDP publishes";
    return result;
  }
  {
    std::lock_guard<std::mutex> lock(meta_mu_);
    endpoints_ = endpoints;
    meta_known_ = true;
    meta_valid_until_ = std::chrono::steady_clock::now() + kMetadataLife;
  }
  // ProcurAuth 10.7: the pool closes an idle connection after half of the time that the PDP keeps it, or sooner.
  if (endpoints.idle_max_seconds) {
    transport_->set_idle_close(std::chrono::milliseconds(std::min<uint64_t>(*endpoints.idle_max_seconds, 3600) * 500));
  }
  result.state = PdpDiscoveryState::Loaded;
  return result;
}

bool PdpClient::ensure_metadata(const PdpCallContext& context, PdpEndpoints* out) {
  const auto due = [&](std::chrono::steady_clock::time_point now) { return !meta_known_ || now >= meta_valid_until_; };
  {
    std::lock_guard<std::mutex> lock(meta_mu_);
    if (!due(std::chrono::steady_clock::now())) {
      *out = endpoints_;
      return true;
    }
  }
  // One thread at a time reads the metadata; the others wait for its result.
  std::lock_guard<std::mutex> attempt_lock(discovery_mu_);
  {
    std::lock_guard<std::mutex> lock(meta_mu_);
    const auto now = std::chrono::steady_clock::now();
    if (!due(now)) {
      *out = endpoints_;
      return true;
    }
    if (now < meta_next_attempt_) {
      // A read failed a moment ago. An old document stays in use; with none, the question fails now.
      if (meta_known_) *out = endpoints_;
      return meta_known_;
    }
  }
  const PdpDiscoveryResult result = discover(context);
  const auto now = std::chrono::steady_clock::now();
  std::lock_guard<std::mutex> lock(meta_mu_);
  switch (result.state) {
    case PdpDiscoveryState::Loaded:
    case PdpDiscoveryState::Absent:
      meta_known_ = true;
      meta_valid_until_ = now + kMetadataLife;
      meta_next_attempt_ = {};
      *out = endpoints_;
      return true;
    case PdpDiscoveryState::Unreachable:
    case PdpDiscoveryState::Invalid:
      meta_next_attempt_ = now + (result.state == PdpDiscoveryState::Invalid ? kMetadataRetry * 30 : kMetadataRetry);
      log_event(LogLevel::Warn, "access.pdp_metadata_failed",
                {{"request_id", context.request_id}, {"invalid", result.state == PdpDiscoveryState::Invalid}, {"error", cut_text(result.message, 500)}});
      if (result.state == PdpDiscoveryState::Invalid) {
        // A document that cannot be used must not be used (AuthZEN 1.0, l.1364), also the one that was good before.
        meta_known_ = false;
        return false;
      }
      if (meta_known_) *out = endpoints_;
      return meta_known_;
  }
  return false;
}

std::vector<std::pair<std::string, std::string>> PdpClient::request_headers(const PdpCallContext& context, PdpCall* call) const {
  call->trace_id = context.trace_id.empty() ? mcp_random_hex(16) : context.trace_id;
  call->parent_span_id = context.trace_id.empty() ? std::string() : context.parent_span_id;
  call->span_id = mcp_random_hex(8);
  call->sampled = context.sampled;
  std::vector<std::pair<std::string, std::string>> headers = {
      {"Authorization", "Bearer " + options_.token},
      {"Accept", "application/json"},
      {"traceparent", "00-" + call->trace_id + "-" + call->span_id + (call->sampled ? "-01" : "-00")},
  };
  if (!context.request_id.empty()) headers.emplace_back("X-Request-ID", context.request_id);
  return headers;
}

std::string PdpClient::check_result(const PdpHttpResult& result, std::chrono::steady_clock::duration elapsed, const PdpCallContext& context,
                                    const std::string& path, std::chrono::milliseconds timeout) {
  if (!result.error.empty()) return "no answer: " + result.error;
  if (elapsed > timeout) return "the answer came after the timeout";
  if (result.status == 401 || result.status == 403) {
    // The PDP refuses the credential of this server: an operator fault, not a denial of a person.
    log_event(LogLevel::Error, "access.pdp_credential_refused", {{"request_id", context.request_id}, {"path", path}, {"status", result.status}});
    return "status " + std::to_string(result.status);
  }
  if (result.status != 200) return "status " + std::to_string(result.status);
  if (result.body.size() > options_.max_answer_bytes) return "the answer is too large";
  // AuthZEN 1.0, l.1449-1451: the PDP echoes the X-Request-ID of the request. A missing or another value is a fault of the PDP, but the
  // answer stays valid: the id is for the logs.
  if (!context.request_id.empty() && (!result.request_id || *result.request_id != context.request_id)) {
    const int64_t now = steady_ms();
    int64_t last = request_id_warned_ms_.load();
    if ((last == 0 || now - last >= kRequestIdWarnEveryMs) && request_id_warned_ms_.compare_exchange_strong(last, now == 0 ? 1 : now)) {
      log_event(LogLevel::Warn, "access.pdp_request_id",
                {{"request_id", context.request_id}, {"path", path}, {"echoed", result.request_id ? "other" : "missing"}});
    }
  }
  return {};
}

std::vector<std::vector<size_t>> PdpClient::plan_chunks(const std::string& subject, const std::vector<AccessQuestion>& questions,
                                                        const std::vector<size_t>& ask, const PdpEndpoints& endpoints) const {
  size_t max_items = std::max<size_t>(options_.max_evaluations, 1);
  if (endpoints.evaluations_max_items) max_items = std::min<size_t>(max_items, static_cast<size_t>(std::min<uint64_t>(*endpoints.evaluations_max_items, SIZE_MAX)));
  const size_t max_bytes = endpoints.evaluations_max_bytes ? static_cast<size_t>(std::min<uint64_t>(*endpoints.evaluations_max_bytes, SIZE_MAX)) : 0;
  // The empty batch is the envelope: the subject and an empty array.
  const size_t envelope = max_bytes ? request_body(subject, {}).size() : 0;
  std::vector<std::vector<size_t>> chunks;
  size_t i = 0;
  while (i < ask.size()) {
    std::vector<size_t> chunk;
    size_t bytes = envelope;
    while (i < ask.size() && chunk.size() < max_items) {
      if (max_bytes) {
        const size_t item = evaluation_item_bytes(questions[ask[i]]) + (chunk.empty() ? 0 : 1);
        // A question that is too large alone still goes: the PDP refuses it, and the question fails.
        if (!chunk.empty() && bytes + item > max_bytes) break;
        bytes += item;
      }
      chunk.push_back(ask[i++]);
    }
    chunks.push_back(std::move(chunk));
  }
  return chunks;
}

bool PdpClient::ask_chunk(const std::string& subject, const std::vector<AccessQuestion>& questions, const std::vector<size_t>& ask,
                          const PdpEndpoints& endpoints, const PdpCallContext& context, std::chrono::milliseconds timeout,
                          std::vector<AccessDecision>* out) {
  std::vector<AccessQuestion> asked;
  asked.reserve(ask.size());
  for (const size_t i : ask) asked.push_back(questions[i]);

  PdpCall call;
  call.path = asked.size() == 1 ? endpoints.evaluation : endpoints.evaluations;
  call.evaluations = asked.size();
  const std::vector<std::pair<std::string, std::string>> headers = request_headers(context, &call);

  call.start_unix_nano = otlp_now_unix_nano();
  const auto started = std::chrono::steady_clock::now();
  PdpHttpResult result = transport_->post(call.path, request_body(subject, asked), headers, timeout);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  call.end_unix_nano = otlp_now_unix_nano();
  call.status = result.status;

  std::vector<PdpAnswer> decisions;
  call.error = check_result(result, elapsed, context, call.path, timeout);
  if (call.error.empty() && !parse_answer(result.body, asked.size(), &decisions)) call.error = "the answer is not a valid AuthZEN answer";

  const bool answered = result.error.empty();
  if (call.error.empty()) {
    const auto at = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(mu_);
    for (size_t k = 0; k < ask.size(); ++k) {
      (*out)[ask[k]] = decision_from(decisions[k], "pdp");
      cache_store(cache_key(subject, questions[ask[k]]), decisions[k], at);
    }
  } else {
    // Fail closed: every question of the call is false, and nothing is kept.
    for (const size_t i : ask) (*out)[i] = failed_decision();
    log_event(LogLevel::Warn, "access.pdp_failed",
              {{"request_id", context.request_id}, {"path", call.path}, {"status", call.status}, {"error", call.error},
               {"evaluations", static_cast<uint64_t>(call.evaluations)}});
  }
  if (on_call_) on_call_(call);
  return answered && elapsed <= timeout;
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
    PdpEndpoints known;
    if (options_.discovery) {
      if (!ensure_metadata(context, &known)) {
        // No usable metadata: no request. The log line access.pdp_metadata_failed says why.
        for (const size_t i : ask) out[i] = failed_decision();
        log_event(LogLevel::Warn, "access.pdp_failed",
                  {{"request_id", context.request_id}, {"path", ""}, {"status", 0}, {"error", "the metadata of the PDP is not available"},
                   {"evaluations", static_cast<uint64_t>(ask.size())}});
        ask.clear();
      }
    } else {
      known = endpoints();
    }
    const auto chunks = plan_chunks(subject, questions, ask, known);
    // A call of several requests (ProcurAuth 10.7a, or more than max_evaluations questions) has one deadline for all its requests
    // (access.pdp.batch_timeout). Each request keeps the timeout of one request, and no request waits past the deadline.
    const bool split = chunks.size() > 1;
    const auto deadline = std::chrono::steady_clock::now() + options_.batch_timeout;
    bool skip = false;
    bool expired = false;
    size_t skipped = 0;
    for (const auto& chunk : chunks) {
      if (skip || expired) {
        // The PDP gave no answer to the request before, or the deadline of the call passed. The next request would wait again.
        for (const size_t i : chunk) out[i] = failed_decision();
        skipped += chunk.size();
        continue;
      }
      std::chrono::milliseconds timeout = options_.timeout;
      if (split) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
        if (left.count() <= 0) {
          expired = true;
          for (const size_t i : chunk) out[i] = failed_decision();
          skipped += chunk.size();
          continue;
        }
        // The last request before the deadline gets the time that remains, not the whole timeout.
        if (left < timeout) timeout = left;
      }
      if (!ask_chunk(subject, questions, chunk, known, context, timeout, &out)) {
        skip = true;
        if (split && std::chrono::steady_clock::now() >= deadline) expired = true;
      }
    }
    if (skipped > 0) {
      log_event(LogLevel::Warn, "access.pdp_failed",
                {{"request_id", context.request_id}, {"path", ""}, {"status", 0},
                 {"error", expired ? "not sent: the call reached access.pdp.batch_timeout" : "not sent: the PDP gave no answer to a request of this call"},
                 {"evaluations", static_cast<uint64_t>(skipped)}});
    }
    if (expired) {
      // The deadline cut the call: no decision of the call is given, also the answered ones and the kept ones. The route answers 503, never
      // a part of the answers. The answers that came stay in the cache: they are valid answers of the PDP.
      for (auto& decision : out) decision = failed_decision();
      log_event(LogLevel::Warn, "access.pdp_failed",
                {{"request_id", context.request_id}, {"path", ""}, {"status", 0},
                 {"error", "the call of " + std::to_string(chunks.size()) + " requests went past access.pdp.batch_timeout (" +
                               std::to_string(options_.batch_timeout.count()) + "ms): every question of the call fails"},
                 {"evaluations", static_cast<uint64_t>(questions.size())}});
    }
  }

  for (size_t i = 0; i < questions.size(); ++i) {
    const std::string resource = access_resource_path(questions[i].resource);
    std::vector<LogField> fields = {{"request_id", context.request_id},
                                    {"subject", subject},
                                    {"action", questions[i].action},
                                    {"resource", resource},
                                    {"match", access_match_name(questions[i].match)},
                                    {"decision", out[i].allowed},
                                    {"source", out[i].source},
                                    {"reason", pdp_reason_name(out[i].reason)},
                                    {"failed", out[i].failed}};
    // The error that the PDP gives for the item (AuthZEN 1.0, l.866-903).
    if (out[i].error_status) fields.emplace_back("error_status", *out[i].error_status);
    if (!out[i].error_message.empty()) fields.emplace_back("error_message", out[i].error_message);
    log_event(LogLevel::Info, "access.decision", fields);
  }
  return out;
}

AccessDecision PdpClient::decide_use(const std::string& subject, const AccessQuestion& question, const PdpCallContext& context) {
  const auto log_use = [&](const AccessDecision& decision) {
    std::vector<LogField> fields = {{"request_id", context.request_id},
                                    {"subject", subject},
                                    {"action", question.action},
                                    {"resource", access_resource_path(question.resource)},
                                    {"match", access_match_name(question.match)},
                                    {"usage", true},
                                    {"decision", decision.allowed},
                                    {"source", decision.source},
                                    {"reason", pdp_reason_name(decision.reason)},
                                    {"failed", decision.failed},
                                    {"units", decision.usage_units.value_or(0)}};
    if (decision.retry_after) fields.emplace_back("retry_after", *decision.retry_after);
    if (decision.usage_invalid) fields.emplace_back("usage_invalid", true);
    log_event(LogLevel::Info, "access.decision", fields);
  };
  // ProcurAuth 6.11: context.usage and the match "subtree" never go together. This is a fault of the caller: fail closed, send nothing.
  if (question.match != AccessMatch::Node) {
    AccessDecision refused = failed_decision();
    log_use(refused);
    return refused;
  }

  const std::string key = use_cache_key(subject, question);
  if (options_.cache_ttl.count() > 0) {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = cache_.find(std::string_view(key));
    if (it != cache_.end() && it->second->expires > now) {
      AccessDecision kept = decision_from(it->second->answer, "cache");
      if (kept.retry_after) {
        // The kept budget_exceeded gives the time that remains, never more than the first retry_after (ProcurAuth 10.1).
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(it->second->expires - now).count();
        kept.retry_after = std::max<uint64_t>(1, std::min<uint64_t>(*kept.retry_after, static_cast<uint64_t>((left + 999) / 1000)));
      }
      log_use(kept);
      return kept;
    }
  }

  PdpEndpoints known;
  if (options_.discovery) {
    if (!ensure_metadata(context, &known)) {
      log_event(LogLevel::Warn, "access.pdp_failed",
                {{"request_id", context.request_id}, {"path", ""}, {"status", 0}, {"error", "the metadata of the PDP is not available"},
                 {"evaluations", uint64_t{1}}});
      AccessDecision failed = failed_decision();
      log_use(failed);
      return failed;
    }
  } else {
    known = endpoints();
  }

  // The wait is longer than the longest time that the PDP takes to answer a question with context.usage (6.9, 10.6).
  const std::chrono::milliseconds timeout = usage_timeout();
  PdpCall call;
  call.path = known.evaluation;
  call.evaluations = 1;
  const std::vector<std::pair<std::string, std::string>> headers = request_headers(context, &call);
  call.start_unix_nano = otlp_now_unix_nano();
  const auto started = std::chrono::steady_clock::now();
  // post_once: this request is never sent again by the transport (10.6).
  const PdpHttpResult result = transport_->post_once(call.path, use_request_body(subject, question), headers, timeout);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  call.end_unix_nano = otlp_now_unix_nano();
  call.status = result.status;

  std::vector<PdpAnswer> decisions;
  call.error = check_result(result, elapsed, context, call.path, timeout);
  if (call.error.empty() && !parse_answer(result.body, 1, &decisions)) call.error = "the answer is not a valid AuthZEN answer";

  AccessDecision out;
  if (call.error.empty()) {
    const PdpAnswer answer = use_answer_of(decisions.front());
    out = decision_from(answer, "pdp");
    out.usage_invalid = decisions.front().decision && !answer.decision;
    // ProcurAuth 10.1: a true answer with units above 0 is never kept (cache_store checks it too). Keep only the two answers that the rules
    // allow: a true answer with units 0 and a false answer with budget_exceeded.
    const bool keepable = (answer.decision && answer.usage_units && *answer.usage_units == 0) ||
                          (!answer.decision && answer.reason == PdpReason::BudgetExceeded && answer.retry_after);
    if (keepable) {
      const auto at = std::chrono::steady_clock::now();
      std::lock_guard<std::mutex> lock(mu_);
      cache_store(key, answer, at);
    }
  } else {
    // Fail closed, and never again: the PDP may have counted the use. The route answers 503 (ProcurAuth 10.6, 10.3).
    out = failed_decision();
    log_event(LogLevel::Warn, "access.pdp_failed",
              {{"request_id", context.request_id}, {"path", call.path}, {"status", call.status}, {"error", call.error}, {"evaluations", uint64_t{1}}});
  }
  if (on_call_) on_call_(call);
  log_use(out);
  return out;
}

// ---- Resource Search (AuthZEN 1.0, l.1151-1210) --------------------------------------------------------------------------------

std::string PdpClient::search_request_body(const std::string& subject, const std::string& action, const std::string& resource_type,
                                           const std::vector<AccessNode>& ancestors, const std::string& page_token, size_t limit) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("subject");
  write_entity(w, "user", subject);
  w.Key("action");
  write_action(w, action);
  // l.1166-1167: the resource has a type and no id.
  w.Key("resource");
  w.StartObject();
  w.Key("type");
  write_json_text(w, resource_type);
  if (!ancestors.empty()) {
    w.Key("properties");
    w.StartObject();
    w.Key("ancestors");
    w.StartArray();
    for (const AccessNode& node : ancestors) write_entity(w, node.type, node.id);
    w.EndArray();
    w.EndObject();
  }
  w.EndObject();
  if (!page_token.empty() || limit > 0) {
    // l.932-949: the page object, with the token of the page before and the limit.
    w.Key("page");
    w.StartObject();
    if (!page_token.empty()) {
      w.Key("token");
      write_json_text(w, page_token);
    }
    if (limit > 0) {
      w.Key("limit");
      w.Uint64(limit);
    }
    w.EndObject();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

bool PdpClient::parse_search_answer(const std::string& body, const std::string& resource_type, PdpSearchPage* page) {
  *page = PdpSearchPage{};
  rapidjson::Document doc;
  if (!parse_json_bounded(doc, body) || !doc.IsObject()) return false;
  // l.1062-1063: "results" is required, and holds only entities of the type that was searched.
  const auto results = doc.FindMember("results");
  if (results == doc.MemberEnd() || !results->value.IsArray()) return false;
  for (const auto& item : results->value.GetArray()) {
    if (!item.IsObject()) return false;
    const auto type = item.FindMember("type");
    const auto id = item.FindMember("id");
    if (type == item.MemberEnd() || !type->value.IsString() || id == item.MemberEnd() || !id->value.IsString()) return false;
    if (text_of(type->value) != resource_type) return false;
    const std::string_view value = text_of(id->value);
    // An id that cannot be the id of a node is not valid for this server.
    if (!access_valid_id(value)) return false;
    page->ids.emplace_back(value);
  }
  // l.951-960: a page object holds next_token, a text; an empty text ends the result. Without a page object, the result is whole.
  if (const auto info = doc.FindMember("page"); info != doc.MemberEnd()) {
    if (!info->value.IsObject()) return false;
    const auto token = info->value.FindMember("next_token");
    if (token == info->value.MemberEnd() || !token->value.IsString()) return false;
    page->next_token.assign(token->value.GetString(), token->value.GetStringLength());
    // A token of a size that no PDP needs is a fault: it is sent back in the next request.
    if (page->next_token.size() > 4096) return false;
  }
  page->ok = true;
  return true;
}

PdpSearchPage PdpClient::search_resources_page(const std::string& subject, const std::string& action, const std::string& resource_type,
                                               const std::vector<AccessNode>& ancestors, const std::string& page_token, size_t limit,
                                               const PdpCallContext& context) {
  PdpSearchPage page;
  PdpEndpoints known;
  if (options_.discovery) {
    if (!ensure_metadata(context, &known)) {
      page.error = "the metadata of the PDP is not available";
      return page;
    }
  } else {
    known = endpoints();
  }
  if (known.search_resource.empty()) {
    page.error = "the PDP does not announce search_resource_endpoint";
    return page;
  }
  if (subject.empty() || action.empty() || !access_valid_id(resource_type)) {
    page.error = "the subject, the action or the type is not valid";
    return page;
  }
  PdpCall call;
  call.path = known.search_resource;
  call.evaluations = 0;
  const std::vector<std::pair<std::string, std::string>> headers = request_headers(context, &call);
  call.start_unix_nano = otlp_now_unix_nano();
  const auto started = std::chrono::steady_clock::now();
  const PdpHttpResult result = transport_->post(call.path, search_request_body(subject, action, resource_type, ancestors, page_token, limit), headers, options_.timeout);
  const auto elapsed = std::chrono::steady_clock::now() - started;
  call.end_unix_nano = otlp_now_unix_nano();
  call.status = result.status;
  call.error = check_result(result, elapsed, context, call.path, options_.timeout);
  if (call.error.empty() && !parse_search_answer(result.body, resource_type, &page)) call.error = "the answer is not a valid AuthZEN search answer";
  if (!call.error.empty()) {
    page = PdpSearchPage{};
    page.error = call.error;
    log_event(LogLevel::Warn, "access.pdp_failed",
              {{"request_id", context.request_id}, {"path", call.path}, {"status", call.status}, {"error", call.error}, {"evaluations", uint64_t{0}}});
  }
  if (on_call_) on_call_(call);
  return page;
}

PdpSearchResult PdpClient::search_resources(const std::string& subject, const std::string& action, const std::string& resource_type,
                                            const std::vector<AccessNode>& ancestors, const PdpCallContext& context) {
  PdpSearchResult out;
  std::string token;
  std::set<std::string> seen_tokens;
  for (size_t pages = 0; pages < std::max<size_t>(options_.search_max_pages, 1); ++pages) {
    const size_t room = options_.search_max_items > out.ids.size() ? options_.search_max_items - out.ids.size() : 0;
    // The limit of the page is the room that is left: a PDP that keeps it sends no more than the bound.
    PdpSearchPage page = search_resources_page(subject, action, resource_type, ancestors, token, room, context);
    if (!page.ok) {
      out = PdpSearchResult{};
      out.error = page.error;
      return out;
    }
    for (std::string& id : page.ids) {
      if (out.ids.size() >= options_.search_max_items) {
        out.truncated = true;
        break;
      }
      out.ids.push_back(std::move(id));
    }
    if (page.next_token.empty()) {
      out.ok = true;
      return out;
    }
    if (out.truncated || out.ids.size() >= options_.search_max_items) {
      out.ok = true;
      out.truncated = true;
      return out;
    }
    // A token that comes again would loop for ever.
    if (!seen_tokens.insert(page.next_token).second || page.next_token == token) {
      out = PdpSearchResult{};
      out.error = "the PDP repeats a next_token";
      return out;
    }
    token = std::move(page.next_token);
  }
  out.ok = true;
  out.truncated = true;
  return out;
}

} // namespace chdash
