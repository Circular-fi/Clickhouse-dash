// The access of humans (docs/access.md, contract 11): the identity token of each request of the pages and of the API, the
// decision of the PDP for the action of each route, readonly = 1 for a run without query.run.write, and the decisions of a page.
// The MCP endpoint is not here: it has its keys (docs/mcp.md).

#include "server.hpp"

#include "access_actions.hpp"
#include "access_pages.hpp"
#include "api_error.hpp"
#include "host_util.hpp"
#include "json_parse.hpp"
#include "json_text.hpp"
#include "log.hpp"
#include "mcp_scope.hpp"
#include "mcp_trace.hpp"
#include "request_context.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <chrono>
#include <optional>
#include <set>
#include <string>
#include <unordered_set>
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
  // The rule of a route whose host is in the JSON body: check_access_body applies it once the body is read.
  bool pending = false;
  AccessRule pending_rule;
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

// The members host_id and database of a JSON body, when they are text. Other members and a body that is not JSON give nothing.
void body_names(const std::string& body, std::string* host_id, std::string* database) {
  rapidjson::Document doc;
  if (body.empty() || !parse_json_bounded(doc, body) || !doc.IsObject()) return;
  const auto text = [&](const char* name, std::string* out) {
    const auto it = doc.FindMember(name);
    if (it != doc.MemberEnd() && it->value.IsString()) out->assign(it->value.GetString(), it->value.GetStringLength());
  };
  text("host_id", host_id);
  text("database", database);
}

std::string param_value(const httplib::Request& req, const char* name) { return req.has_param(name) ? req.get_param_value(name) : std::string(); }

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
  // The MCP keys of the page never have more than their creator (docs/mcp.md, "Keys and the access of humans"). The state of a key is
  // kept for pdp.cache_ttl, as the answers of the PDP are.
  if (mcp_keys_) {
    mcp_creator_ = std::make_unique<McpCreatorAccess>(
        settings.audience, std::chrono::milliseconds(settings.pdp_cache_ttl_ms),
        [this](const std::string& subject, const std::vector<AccessQuestion>& questions) {
          PdpCallContext context;
          context.request_id = current_request_context().request_id;
          return pdp_->decide(subject, questions, context);
        },
        [] {
          return static_cast<int64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
        });
  }
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

  switch (rule.kind) {
    case AccessRuleKind::Exempt:
    case AccessRuleKind::Identity:
      return false;
    case AccessRuleKind::Unknown: {
      // No route: the router answers 404. A route that the table of rules does not know: refused (fail closed).
      if (!http_.has_route(req.method == "HEAD" ? std::string("GET") : req.method, req.path)) return false;
      log_event(LogLevel::Error, "access.no_rule", {{"request_id", request_id}, {"method", req.method}, {"path", req.path.substr(0, 512)}});
      if (is_write_method(req.method)) res.set_header("Connection", "close");
      refuse_forbidden(res, "unknown");
      return true;
    }
    case AccessRuleKind::Action:
    case AccessRuleKind::Run:
    case AccessRuleKind::Export:
      return check_rule(rule, req, res, false);
  }
  refuse_forbidden(res, "unknown");
  return true;
}

std::vector<std::string> Server::access_host_ids() const {
  std::vector<std::string> out;
  out.reserve(cfg_.hosts.size());
  for (const auto& host : cfg_.hosts) out.push_back(host.id);
  return out;
}

AccessResource Server::access_resource_of(const std::string& host_id, const std::string& database) const {
  // A request that names no host reaches the only host of a configuration that has one, as the routes do.
  const std::string host = host_id.empty() && cfg_.hosts.size() == 1 ? cfg_.hosts.front().id : host_id;
  // A host that the configuration does not have: the question goes to the service. Thus a host that the human cannot see and a host
  // that does not exist get the same answer, and the PDP never receives an id that the client chose for a host.
  if (host.empty() || !find_host(cfg_.hosts, host)) return access_service_resource(cfg_.access.audience);
  // A database id that no grant can name (contract 11.4: 1 to 256 bytes of UTF-8, no control character): only a grant on its host or
  // on the service covers it, so the question goes to the host.
  if (database.empty() || !access_valid_id(database)) return access_host_resource(cfg_.access.audience, host);
  return access_database_resource(cfg_.access.audience, host, database);
}

bool Server::check_rule(const AccessRule& rule, const httplib::Request& req, httplib::Response& res, bool body_read) {
  AccessRequestState& state = access_state();
  const auto deny = [&](const std::string& action) {
    if (!body_read && is_write_method(req.method)) res.set_header("Connection", "close");
    refuse_forbidden(res, action);
    return true;
  };
  if (rule.kind != AccessRuleKind::Action && rule.kind != AccessRuleKind::Run && rule.kind != AccessRuleKind::Export) return false;

  if (rule.body && !body_read) {
    // The body is not read yet. A run or an export first needs its actions on one host at least (or on the service): a human without
    // them gets the 403 before the server reads a body. These questions have the match "node": a grant below a host lets no run.
    if (rule.kind != AccessRuleKind::Action) {
      std::vector<const char*> actions;
      if (rule.kind == AccessRuleKind::Export) actions.push_back("query.export");
      actions.push_back("query.run.read");
      actions.push_back("query.run.write");
      std::vector<AccessQuestion> questions;
      for (const auto& host : access_host_ids()) {
        for (const char* action : actions) questions.push_back(AccessQuestion{action, access_host_resource(cfg_.access.audience, host)});
      }
      const auto decisions = access_decide(questions);
      bool export_somewhere = rule.kind != AccessRuleKind::Export;
      bool run_somewhere = false;
      for (size_t i = 0; i < questions.size(); ++i) {
        if (!decisions[i].allowed) continue;
        if (questions[i].action == "query.export") export_somewhere = true;
        else run_somewhere = true;
      }
      if (!export_somewhere) return deny("query.export");
      if (!run_somewhere) return deny("query.run.read");
    }
    state.pending = true;
    state.pending_rule = rule;
    // Fail closed until the body check: the statements of the request run with readonly = 1.
    state.read_only = true;
    return false;
  }

  AccessResource resource = access_service_resource(cfg_.access.audience);
  if (rule.host) {
    std::string host_id;
    std::string database;
    if (rule.body) {
      body_names(req.body, &host_id, &database);
    } else {
      host_id = param_value(req, "host_id");
      database = param_value(req, "database");
    }
    resource = access_resource_of(host_id, rule.database_param ? database : std::string());
  }

  switch (rule.kind) {
    case AccessRuleKind::Action: {
      const auto decisions = access_decide({AccessQuestion{rule.action, resource}});
      return decisions.front().allowed ? false : deny(rule.action);
    }
    case AccessRuleKind::Run: {
      const auto decisions = access_decide({AccessQuestion{"query.run.read", resource}, AccessQuestion{"query.run.write", resource}});
      const bool read = decisions[0].allowed;
      const bool write = decisions[1].allowed;
      if (!read && !write) return deny("query.run.read");
      // readonly = 1 without query.run.write on this host (or on this database of the host).
      state.read_only = !write;
      return false;
    }
    case AccessRuleKind::Export: {
      // An export runs SQL: it needs query.export and, as a run, query.run.read or query.run.write, all on the host of the export.
      const auto decisions = access_decide({AccessQuestion{"query.export", resource}, AccessQuestion{"query.run.read", resource},
                                            AccessQuestion{"query.run.write", resource}});
      if (!decisions[0].allowed) return deny("query.export");
      if (!decisions[1].allowed && !decisions[2].allowed) return deny("query.run.read");
      state.read_only = !decisions[2].allowed;
      return false;
    }
    default:
      return false;
  }
}

bool Server::check_access_body(const httplib::Request& req, httplib::Response& res) {
  AccessRequestState& state = access_state();
  // A call of an API tool of MCP runs the routes in the process: its key and its scope limit it (docs/mcp.md).
  if (!state.pending || current_request_context().is_mcp()) return false;
  state.pending = false;
  const AccessRule rule = state.pending_rule;
  return check_rule(rule, req, res, true);
}

bool Server::access_allows(httplib::Response& res, const char* action, const std::string& host_id, const std::string& database) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  if (access_decide({AccessQuestion{action, access_resource_of(host_id, database)}}).front().allowed) return true;
  refuse_forbidden(res, action);
  return false;
}

void Server::access_forbidden(httplib::Response& res, const std::string& action) { refuse_forbidden(res, action); }

bool Server::access_allows_all(httplib::Response& res, const std::vector<AccessQuestion>& questions) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp() || questions.empty()) return true;
  const auto decisions = access_decide(questions);
  for (size_t i = 0; i < questions.size(); ++i) {
    if (decisions[i].allowed) continue;
    refuse_forbidden(res, questions[i].action);
    return false;
  }
  return true;
}

std::optional<std::unordered_set<std::string>> Server::access_readable_databases(const std::vector<const char*>& actions,
                                                                                const std::string& host_id,
                                                                                const std::vector<std::string>& databases) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return std::nullopt;
  std::vector<std::string> names;
  std::unordered_set<std::string> seen;
  for (const auto& database : databases) {
    if (seen.insert(database).second) names.push_back(database);
  }
  // One batch: each action on the host (a grant on the service covers it), then each action on each database of the host.
  const AccessResource host = access_resource_of(host_id, std::string());
  std::vector<AccessQuestion> questions;
  questions.reserve(actions.size() * (names.size() + 1));
  for (const char* action : actions) questions.push_back(AccessQuestion{action, host});
  for (const auto& name : names) {
    for (const char* action : actions) questions.push_back(AccessQuestion{action, access_resource_of(host_id, name)});
  }
  const auto decisions = access_decide(questions);
  for (size_t i = 0; i < actions.size(); ++i) {
    if (decisions[i].allowed) return std::nullopt;
  }
  std::unordered_set<std::string> out;
  for (size_t n = 0; n < names.size(); ++n) {
    for (size_t a = 0; a < actions.size(); ++a) {
      if (decisions[actions.size() * (n + 1) + a].allowed) {
        out.insert(names[n]);
        break;
      }
    }
  }
  return out;
}

std::vector<AccessDecision> Server::access_host_decisions(std::vector<AccessQuestion>* questions, const std::string& database) {
  *questions = access_navigation_questions(cfg_.access.audience, access_host_ids(), database);
  return access_decide(*questions);
}

std::optional<std::set<std::string>> Server::access_visible_hosts() {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return std::nullopt;
  std::vector<AccessQuestion> questions;
  const auto decisions = access_host_decisions(&questions, std::string());
  return chdash::access_visible_hosts(questions, decisions);
}

std::set<std::string> Server::navigation_pages(const std::string& database, bool* database_allowed) {
  if (database_allowed) *database_allowed = true;
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) {
    std::set<std::string> all;
    for (const auto& page : access_pages()) all.insert(page.name);
    return all;
  }
  // One batch: the questions of GET /api/version and GET /api/hosts, so the cache of the PDP answers them all, and the database of the
  // address on each host.
  std::vector<AccessQuestion> questions;
  const auto decisions = access_host_decisions(&questions, database);
  if (database_allowed) {
    *database_allowed = false;
    for (size_t i = 0; i < questions.size() && !database.empty(); ++i) {
      if (questions[i].resource.type == "database" && decisions[i].allowed) *database_allowed = true;
    }
  }
  std::set<std::string> pages = access_navigation_pages(questions, decisions);
  // A page that the configuration turns off is not a page of the navigation. The MCP pages are always served: they say how to turn MCP on.
  if (!cfg_.explorer.enabled()) pages.erase("explorer");
  if (!cfg_.traces_on() && !cfg_.logs_on() && !cfg_.metrics_on()) pages.erase("observability");
  if (!cfg_.system.enabled) pages.erase("system");
  return pages;
}

bool Server::access_permits(const char* action) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  return access_decide({AccessQuestion{action, access_service_resource(cfg_.access.audience)}}).front().allowed;
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
    // One batch for the page (contract 11.5): each action that takes no host on the service, each other action on each host. The
    // pages hide what is false; the server still checks each action on its routes.
    std::vector<AccessQuestion> questions;
    const auto decisions = access_host_decisions(&questions, std::string());
    // An action is true when the human may use it somewhere: on the service or on one host.
    w.Key("actions");
    w.StartObject();
    for (const auto& [name, allowed] : access_action_summary(questions, decisions)) {
      w.Key(name.c_str());
      w.Bool(allowed);
    }
    w.EndObject();
    // The decisions of each host that the human can see (GET /api/hosts lists the same hosts). A host picker reads them.
    const std::set<std::string> visible = chdash::access_visible_hosts(questions, decisions);
    w.Key("hosts");
    w.StartObject();
    for (const auto& host : access_host_ids()) {
      if (visible.count(host) == 0) continue;
      write_json_key(w, host);
      w.StartObject();
      for (size_t i = 0; i < questions.size(); ++i) {
        if (questions[i].resource.type != "host" || questions[i].resource.id != host) continue;
        w.Key(questions[i].action.c_str());
        w.Bool(decisions[i].allowed);
      }
      w.EndObject();
    }
    w.EndObject();
  }
  w.EndObject();
  return std::string(sb.GetString(), sb.GetSize());
}

} // namespace chdash
