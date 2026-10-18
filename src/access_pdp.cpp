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

void write_action(rapidjson::Writer<rapidjson::StringBuffer>& w, std::string_view name) {
  w.StartObject();
  w.Key("name");
  write_json_text(w, name);
  w.EndObject();
}

// The reason of a false decision that tells the server that the PDP does not know the subject (contract 11.5).
constexpr const char* kUnknownSubject = "unknown_subject";

bool decision_of(const rapidjson::Value& value, PdpAnswer* answer) {
  if (!value.IsObject()) return false;
  const auto it = value.FindMember("decision");
  if (it == value.MemberEnd() || !it->value.IsBool()) return false;
  answer->decision = it->value.GetBool();
  answer->unknown_subject = false;
  const auto context = value.FindMember("context");
  if (context == value.MemberEnd()) return true;
  if (!context->value.IsObject()) return false;
  const auto reason = context->value.FindMember("reason");
  // Only a false decision can name an unknown subject. A reason of another value or type means nothing to the server.
  answer->unknown_subject = !answer->decision && reason != context->value.MemberEnd() && reason->value.IsString() &&
                            std::string_view(reason->value.GetString(), reason->value.GetStringLength()) == kUnknownSubject;
  return true;
}

} // namespace

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
    write_entity(w, questions.front().resource.type, questions.front().resource.id);
    w.Key("context");
    w.StartObject();
    w.EndObject();
  } else {
    // AuthZEN 1.0, 7.1: the subject at the top is the default of each evaluation.
    w.Key("evaluations");
    w.StartArray();
    for (const AccessQuestion& question : questions) {
      w.StartObject();
      w.Key("action");
      write_action(w, question.action);
      w.Key("resource");
      write_entity(w, question.resource.type, question.resource.id);
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
  std::string key;
  key.reserve(subject.size() + question.action.size() + question.resource.type.size() + question.resource.id.size() + 3);
  key.append(subject).push_back('\x1f');
  key.append(question.action).push_back('\x1f');
  key.append(question.resource.type).push_back('\x1f');
  key.append(question.resource.id);
  return key;
}

size_t PdpClient::cache_entry_bytes(const std::string& key) {
  // The fixed part is an estimate of the node of the map, the pair of the value and the heap block of the key.
  constexpr size_t kEntryOverhead = 96;
  return key.size() + kEntryOverhead;
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
        const auto it = cache_.find(cache_key(subject, questions[i]));
        if (it != cache_.end() && it->second.second > now) {
          out[i] = AccessDecision{it->second.first.decision, "cache", it->second.first.unknown_subject};
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
      const auto expires = std::chrono::steady_clock::now() + options_.cache_ttl;
      std::lock_guard<std::mutex> lock(mu_);
      for (size_t k = 0; k < ask.size(); ++k) {
        out[ask[k]] = AccessDecision{decisions[k].decision, "pdp", decisions[k].unknown_subject};
        if (options_.cache_ttl.count() <= 0) continue;
        std::string key = cache_key(subject, questions[ask[k]]);
        const size_t entry_bytes = cache_entry_bytes(key);
        // An entry that is larger than the whole budget is not kept.
        if (entry_bytes > options_.cache_bytes) continue;
        if (const auto known = cache_.find(key); known != cache_.end()) {
          known->second = {decisions[k], expires};
          continue;
        }
        if (cache_.size() >= options_.cache_entries || cache_used_bytes_ + entry_bytes > options_.cache_bytes) {
          const auto at = std::chrono::steady_clock::now();
          for (auto it = cache_.begin(); it != cache_.end();) {
            if (it->second.second <= at) {
              cache_used_bytes_ -= cache_entry_bytes(it->first);
              it = cache_.erase(it);
            } else {
              ++it;
            }
          }
          if (cache_.size() >= options_.cache_entries || cache_used_bytes_ + entry_bytes > options_.cache_bytes) {
            cache_.clear();
            cache_used_bytes_ = 0;
          }
        }
        cache_used_bytes_ += entry_bytes;
        cache_.emplace(std::move(key), std::make_pair(decisions[k], expires));
      }
    } else {
      // Fail closed: every question of the call is false, and nothing is kept.
      for (const size_t i : ask) out[i] = AccessDecision{false, "error"};
      log_event(LogLevel::Warn, "access.pdp_failed",
                {{"request_id", context.request_id}, {"path", call.path}, {"status", call.status}, {"error", call.error},
                 {"evaluations", static_cast<uint64_t>(call.evaluations)}});
    }
    if (on_call_) on_call_(call);
  }

  for (size_t i = 0; i < questions.size(); ++i) {
    const std::string resource = questions[i].resource.type + ":" + questions[i].resource.id;
    log_event(LogLevel::Info, "access.decision",
              {{"request_id", context.request_id},
               {"subject", subject},
               {"action", questions[i].action},
               {"resource", resource},
               {"decision", out[i].allowed},
               {"source", out[i].source},
               {"reason", out[i].unknown_subject ? kUnknownSubject : ""}});
  }
  return out;
}

} // namespace chdash
