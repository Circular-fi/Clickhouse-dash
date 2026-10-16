// The access of humans (docs/access.md, contract 11): the identity token of each request of the pages and of the API, the
// decision of the PDP for the action of each route, readonly = 1 for a run without query.run.write, and the decisions of a page.
// The MCP endpoint is not here: it has its keys (docs/mcp.md).

#include "server.hpp"

#include "access_actions.hpp"
#include "api_error.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_trace.hpp"
#include "request_context.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <string>
#include <vector>

namespace chdash {
namespace {

// What the access check of before_routing found for the request that this thread serves. httplib calls the pre-routing
// handler and the handler of the route on the same thread, one request after the other: before_routing sets it again for each
// request, so a value never passes from one request to the next.
struct AccessRequestState {
  bool enforced = false;
  std::string subject;
  bool read_only = false;
  PdpCallContext call;
};

AccessRequestState& access_state() {
  thread_local AccessRequestState state;
  return state;
}

void refuse_unauthenticated(httplib::Response& res) {
  json_error(res, 401, "unauthenticated", "A valid identity token is required.");
}

void refuse_forbidden(httplib::Response& res, const std::string& action) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error_code");
  w.String("forbidden");
  w.Key("message");
  write_json_text(w, "The action " + action + " is not allowed.");
  w.Key("retryable");
  w.Bool(false);
  w.Key("action");
  write_json_text(w, action);
  w.EndObject();
  res.status = 403;
  res.set_header("Cache-Control", "no-store");
  res.set_content(sb.GetString(), sb.GetSize(), "application/json");
}

bool is_write_method(const std::string& method) { return method == "POST" || method == "PUT" || method == "PATCH" || method == "DELETE"; }

int64_t unix_now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

} // namespace

void Server::reset_access_state() { access_state() = AccessRequestState{}; }

std::string Server::access_subject() { return access_state().subject; }

std::string Server::access_server_name() const { return cfg_.access.enforced() ? cfg_.access.audience : std::string("chdash"); }

void Server::init_access() {
  const AccessSettings& settings = cfg_.access;
  if (!settings.enforced()) return;
  IdentityVerifierOptions identity;
  identity.issuer = settings.issuer;
  identity.audience = settings.audience;
  identity.max_age_ms = settings.max_age_ms;
  identity.keys = settings.keys;
  identity_ = std::make_unique<IdentityVerifier>(std::move(identity));

  PdpOptions options;
  options.token = settings.pdp_token;
  options.timeout = std::chrono::milliseconds(settings.pdp_timeout_ms);
  options.cache_ttl = std::chrono::milliseconds(settings.pdp_cache_ttl_ms);
  const OtlpEndpoint endpoint = settings.pdp_endpoint;
  // The CLIENT span of each call to the PDP (contract 11.7), child of the span of the request when it has a traceparent.
  auto on_call = [this, endpoint](const PdpCall& call) {
    if (!telemetry_ || !call.sampled) return;
    OtlpSpan span;
    span.trace_id = call.trace_id;
    span.span_id = call.span_id;
    span.parent_span_id = call.parent_span_id;
    span.name = "POST " + call.path;
    span.kind = OtlpSpan::Kind::Client;
    span.start_unix_nano = call.start_unix_nano;
    span.end_unix_nano = call.end_unix_nano;
    span.attributes.push_back(OtlpAttribute::string("http.request.method", "POST"));
    span.attributes.push_back(OtlpAttribute::string("server.address", endpoint.host));
    span.attributes.push_back(OtlpAttribute::integer("server.port", endpoint.port));
    span.attributes.push_back(OtlpAttribute::string("url.path", endpoint.base_path + call.path));
    span.attributes.push_back(OtlpAttribute::integer("authzen.evaluations", static_cast<int64_t>(call.evaluations)));
    if (call.status > 0) span.attributes.push_back(OtlpAttribute::integer("http.response.status_code", call.status));
    if (!call.error.empty()) {
      span.error = true;
      span.status_message = call.error;
      span.attributes.push_back(OtlpAttribute::string("error.type", call.status > 0 ? std::to_string(call.status) : std::string("no_answer")));
    }
    telemetry_->add_spans({std::move(span)});
  };
  pdp_ = std::make_unique<PdpClient>(std::move(options), make_http_pdp_transport(endpoint.host, endpoint.port, endpoint.base_path),
                                     std::move(on_call));
}

std::vector<AccessDecision> Server::access_decide(const std::vector<AccessQuestion>& questions) {
  const AccessRequestState& state = access_state();
  if (!pdp_ || !state.enforced || state.subject.empty()) return std::vector<AccessDecision>(questions.size());
  return pdp_->decide(state.subject, questions, state.call);
}

bool Server::check_access(const httplib::Request& req, httplib::Response& res, const std::string& request_id) {
  AccessRequestState& state = access_state();
  state = AccessRequestState{};
  if (!cfg_.access.enforced()) return false;
  const AccessRule rule = access_rule(req.method, req.path);
  if (rule.kind == AccessRuleKind::Exempt) return false;

  state.enforced = true;
  state.call.request_id = request_id;
  const McpTraceContext trace = mcp_trace_context("", "", false, req.get_header_value("traceparent"), "");
  state.call.trace_id = trace.trace_id;
  state.call.parent_span_id = trace.parent_span_id;
  state.call.sampled = trace.sampled;
  // A server in the authzen mode always has its verifier (init_access): without it, nothing is served.
  if (!identity_) {
    refuse_unauthenticated(res);
    return true;
  }

  // The token comes from its header only: never from a cookie or a query parameter. Two copies of the header are refused: the
  // reverse proxy replaces the header that a client sends.
  const size_t copies = req.get_header_value_count(cfg_.access.header);
  const IdentityResult identity =
      copies == 1 ? identity_->verify(req.get_header_value(cfg_.access.header), unix_now_s()) : IdentityResult{false, {}, 0, copies == 0 ? "missing" : "malformed"};
  if (!identity.ok) {
    log_event(LogLevel::Info, "access.unauthenticated",
              {{"request_id", request_id}, {"method", req.method}, {"path", req.path.substr(0, 512)}, {"reason", identity.reason}});
    if (is_write_method(req.method)) res.set_header("Connection", "close");
    refuse_unauthenticated(res);
    return true;
  }
  state.subject = identity.subject;

  const AccessResource service{"service", cfg_.access.audience};
  const auto resource_of = [&](bool database_param) -> AccessResource {
    if (database_param && req.has_param("database")) {
      std::string database = req.get_param_value("database");
      if (!database.empty()) return AccessResource{"database", std::move(database)};
    }
    return AccessResource{service.type, service.id};
  };
  const auto deny = [&](const std::string& action) {
    if (is_write_method(req.method)) res.set_header("Connection", "close");
    refuse_forbidden(res, action);
    return true;
  };

  switch (rule.kind) {
    case AccessRuleKind::Exempt:
    case AccessRuleKind::Identity:
    case AccessRuleKind::Deferred:
      return false;
    case AccessRuleKind::Unknown: {
      // No route: the router answers 404. A route that the table of rules does not know: refused (fail closed).
      if (!http_.has_route(req.method == "HEAD" ? std::string("GET") : req.method, req.path)) return false;
      log_event(LogLevel::Error, "access.no_rule", {{"request_id", request_id}, {"method", req.method}, {"path", req.path.substr(0, 512)}});
      return deny("unknown");
    }
    case AccessRuleKind::Action: {
      const auto decisions = access_decide({AccessQuestion{rule.action, resource_of(rule.database_param)}});
      return decisions.front().allowed ? false : deny(rule.action);
    }
    case AccessRuleKind::Run: {
      const AccessResource resource = resource_of(rule.database_param);
      const auto decisions = access_decide({AccessQuestion{"query.run.read", resource}, AccessQuestion{"query.run.write", resource}});
      const bool read = decisions[0].allowed;
      const bool write = decisions[1].allowed;
      if (!read && !write) return deny("query.run.read");
      state.read_only = !write;
      return false;
    }
    case AccessRuleKind::Export: {
      const auto decisions = access_decide({AccessQuestion{"query.export", service}, AccessQuestion{"query.run.write", service}});
      if (!decisions[0].allowed) return deny("query.export");
      state.read_only = !decisions[1].allowed;
      return false;
    }
  }
  return deny("unknown");
}

bool Server::access_allows(httplib::Response& res, const char* action, const std::string& database) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  const AccessResource resource = database.empty() ? AccessResource{"service", cfg_.access.audience} : AccessResource{"database", database};
  if (access_decide({AccessQuestion{action, resource}}).front().allowed) return true;
  refuse_forbidden(res, action);
  return false;
}

bool Server::access_permits(const char* action) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  return access_decide({AccessQuestion{action, AccessResource{"service", cfg_.access.audience}}}).front().allowed;
}

bool Server::access_read_only() const {
  const AccessRequestState& state = access_state();
  return state.enforced && state.read_only && !current_request_context().is_mcp();
}

std::string Server::access_json() {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("mode");
  w.String(cfg_.access.enforced() ? "authzen" : "open");
  const AccessRequestState& state = access_state();
  if (cfg_.access.enforced() && state.enforced && !state.subject.empty()) {
    w.Key("subject");
    write_json_text(w, state.subject);
    // One batch for the page (contract 11.5): every action on the service. The pages hide what is false; the server still checks
    // each action on its routes.
    std::vector<AccessQuestion> questions;
    for (const AccessAction& action : access_actions()) questions.push_back(AccessQuestion{action.name, {"service", cfg_.access.audience}});
    const auto decisions = access_decide(questions);
    w.Key("actions");
    w.StartObject();
    for (size_t i = 0; i < questions.size(); ++i) {
      w.Key(questions[i].action.c_str());
      w.Bool(decisions[i].allowed);
    }
    w.EndObject();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace chdash
