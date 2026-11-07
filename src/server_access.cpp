// The access of humans (docs/access.md, contract 11): the identity token of each request of the pages and of the API, the
// decision of the PDP for the action of each route, readonly = 1 for a run without query.run.write, and the decisions of a page.
// The MCP endpoint checks its caller in api_mcp.cpp: its keys, or the identity token in the identity mode (docs/mcp.md).

#include "server.hpp"

#include <algorithm>

#include "access_actions.hpp"
#include "access_enforce.hpp"
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
  // The ceilings of the decisions that guard this request (access_ceilings.hpp) and the class of its SQL. The route fills the first
  // at check_rule. The handler that runs SQL sets the class (access_classify_sql).
  AccessRunCeilings ceilings;
  SqlStatementClass sql_class = SqlStatementClass::Unsure;
  // A route that runs SQL and takes a unit of a budget (AccessRule::spend): the handler has not yet called access_use_run. Until it does,
  // the statements run with readonly = 1 and with the lowest value of each ceiling: a handler that forgets the call runs nothing useful.
  bool use_pending = false;
};

AccessRequestState& access_state() {
  thread_local AccessRequestState state;
  return state;
}

void refuse_unauthenticated(httplib::Response& res) {
  json_error(res, 401, "unauthenticated", "A valid identity token is required.");
}

// The answer of a refused decision (ProcurAuth 10.3, access_refusal): 403 for a denial, 429 with Retry-After for budget_exceeded,
// 503 (retryable) when the PDP gave no valid answer. The body never holds the reason of the PDP.
void refuse_decision(httplib::Response& res, const AccessDecision& decision, const std::string& action) {
  const AccessRefusal refusal = access_refusal(decision, action);
  ApiError error;
  error.status = refusal.status;
  error.code = refusal.error_code;
  error.message = refusal.message;
  error.retryable = refusal.retryable;
  error.text.emplace_back("action", action);
  if (refusal.retry_after) res.set_header("Retry-After", std::to_string(*refusal.retry_after));
  send_error(res, error);
}

void refuse_forbidden(httplib::Response& res, const std::string& action) {
  AccessDecision denied;
  denied.source = "pdp";
  refuse_decision(res, denied, action);
}

// The decisions of `decisions` whose questions have the action `action`.
std::vector<AccessDecision> decisions_of(const std::vector<AccessQuestion>& questions, const std::vector<AccessDecision>& decisions,
                                         std::string_view action) {
  std::vector<AccessDecision> out;
  for (size_t i = 0; i < questions.size() && i < decisions.size(); ++i) {
    if (questions[i].action == action) out.push_back(decisions[i]);
  }
  return out;
}

bool any_failed(const std::vector<AccessDecision>& decisions) {
  return std::any_of(decisions.begin(), decisions.end(), [](const AccessDecision& decision) { return decision.failed; });
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

// The refusal of the decisions of an export (query.export, query.run.read, query.run.write on one resource). Return true after the
// function writes it (`close`: the body is not read, so the connection closes).
bool refuse_export(httplib::Response& res, const std::vector<AccessDecision>& decisions, bool close) {
  const auto deny = [&](const std::string& action, const std::vector<AccessDecision>& refused) {
    if (close) res.set_header("Connection", "close");
    refuse_decision(res, access_refusal_of(refused), action);
    return true;
  };
  if (!decisions[0].allowed) return deny("query.export", {decisions[0]});
  if (!decisions[1].allowed && !decisions[2].allowed) return deny("query.run.read", {decisions[1], decisions[2]});
  return false;
}

// The ceilings of an export: query.export always applies, and the ceilings of query.run.* follow the class of the SQL.
AccessRunCeilings export_ceilings(const std::vector<AccessDecision>& decisions) {
  AccessRunCeilings out;
  out.base = access_ceilings_of(decisions[0].limits);
  out.has_read = decisions[1].allowed;
  out.has_write = decisions[2].allowed;
  if (out.has_read) out.read = access_ceilings_of(decisions[1].limits);
  if (out.has_write) out.write = access_ceilings_of(decisions[2].limits);
  return out;
}

} // namespace

void Server::reset_access_state() { access_state() = AccessRequestState{}; }

std::string Server::access_subject() { return access_state().subject; }

AccessFeatures Server::access_features() const {
  AccessFeatures features;
  features.query_library = !cfg_.query_libraries.empty();
  features.query_library_writable =
      std::any_of(cfg_.query_libraries.begin(), cfg_.query_libraries.end(), [](const QueryLibrarySettings& library) { return library.writable; });
  features.explorer = cfg_.explorer.enabled();
  features.system = cfg_.system.enabled;
  features.observability = cfg_.traces_on() || cfg_.logs_on() || cfg_.metrics_on();
  features.mcp = cfg_.mcp.enabled;
  features.mcp_keys_write = cfg_.mcp.enabled && cfg_.mcp.keys_mode != McpKeysMode::Static;
  features.mcp_session = cfg_.mcp.enabled && cfg_.mcp.identity_auth();
  return features;
}

std::string Server::access_server_name() const { return cfg_.access.enforced() ? cfg_.access.audience : std::string("chdash"); }

void Server::init_access() {
  const AccessSettings& settings = cfg_.access;
  if (!settings.enforced()) return;
  IdentityVerifierOptions identity;
  identity.issuer = settings.issuer;
  identity.audience = settings.audience;
  identity.max_age_ms = settings.max_age_ms;
  identity.clock_skew_s = settings.clock_skew_ms / 1000;
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
    // call.path is the whole path: the path of the base URL and then the path of the endpoint.
    span.attributes.push_back(OtlpAttribute::string("url.path", call.path));
    span.attributes.push_back(OtlpAttribute::integer("authzen.evaluations", static_cast<int64_t>(call.evaluations)));
    if (call.status > 0) span.attributes.push_back(OtlpAttribute::integer("http.response.status_code", call.status));
    if (!call.error.empty()) {
      span.error = true;
      span.status_message = call.error;
      span.attributes.push_back(OtlpAttribute::string("error.type", call.status > 0 ? std::to_string(call.status) : std::string("no_answer")));
    }
    telemetry_->add_spans({std::move(span)});
  };
  options.base_path = endpoint.base_path;
  options.discovery = true;
  options.identifier = settings.pdp_url;
  PdpTransportOptions transport_options;
  transport_options.url.https = settings.pdp_https;
  transport_options.url.host = endpoint.host;
  transport_options.url.port = endpoint.port;
  transport_options.url.base_path = endpoint.base_path;
  transport_options.ca_file = settings.pdp_ca_file;
  transport_options.verify = settings.pdp_verify;
  std::string transport_error;
  std::unique_ptr<PdpTransport> transport = make_pdp_transport(transport_options, &transport_error);
  if (!transport) throw std::runtime_error("access.pdp.url: " + transport_error);
  pdp_ = std::make_unique<PdpClient>(std::move(options), std::move(transport), std::move(on_call));
  // The metadata of the PDP (ProcurAuth 10.7, 10.7a). A document that cannot be used stops the start. A PDP that does not answer does not:
  // the portal can restart after this server, so the client reads the metadata again at its first question.
  {
    PdpCallContext start;
    start.request_id = "start";
    const PdpDiscoveryResult found = pdp_->discover(start);
    switch (found.state) {
      case PdpDiscoveryState::Invalid:
        throw std::runtime_error("access.pdp.url (" + settings.pdp_url + "): the metadata of the PDP cannot be used: " + found.message);
      case PdpDiscoveryState::Unreachable:
        log_event(LogLevel::Warn, "access.pdp_metadata_failed", {{"request_id", start.request_id}, {"invalid", false}, {"error", found.message}});
        break;
      case PdpDiscoveryState::Absent:
        log_event(LogLevel::Info, "access.pdp_metadata", {{"source", "default"}});
        break;
      case PdpDiscoveryState::Loaded: {
        const PdpEndpoints known = pdp_->endpoints();
        log_event(LogLevel::Info, "access.pdp_metadata",
                  {{"source", "document"},
                   {"evaluation", known.evaluation},
                   {"evaluations", known.evaluations},
                   {"search_resource", known.search_resource},
                   {"evaluations_max_items", known.evaluations_max_items.value_or(0)},
                   {"evaluations_max_bytes", known.evaluations_max_bytes.value_or(0)},
                   {"usage_max_seconds", known.usage_max_seconds.value_or(0)},
                   {"idle_max_seconds", known.idle_max_seconds.value_or(0)}});
        break;
      }
    }
  }
  // access.pdp.search = true needs the announced endpoint too (docs/access.md, "Resource Search"). The log tells which way the lists take.
  if (settings.pdp_search) {
    log_event(LogLevel::Info, "access.search_mode", {{"configured", true}, {"announced", !pdp_->endpoints().search_resource.empty()}});
  }
  // The decisions of a subject that is not the subject of the request: the creator of an MCP key of the page, and the subject of an MCP
  // request in the identity mode. Each decision keeps AccessDecision::failed: a failure of the PDP is not a denial (ProcurAuth 10.3).
  // `can_apply` false: the path applies no ceiling, so a true answer with a ceiling is false (ProcurAuth 7.5).
  const auto decide_for = [this](bool can_apply) {
    return [this, can_apply](const std::string& subject, const std::vector<AccessQuestion>& questions) {
      PdpCallContext context;
      context.request_id = current_request_context().request_id;
      std::vector<AccessDecision> decisions = pdp_->decide(subject, questions, context);
      access_enforce_ceilings(context.request_id, questions, &decisions, access_features(), can_apply);
      return decisions;
    };
  };
  // The MCP keys of the page never have more than their creator (docs/mcp.md, "Keys and the access of humans"). The state of a key is
  // kept for pdp.cache_ttl, as the answers of the PDP are.
  if (mcp_keys_) {
    mcp_creator_ = std::make_unique<McpCreatorAccess>(
        // The MCP keys of the page apply no ceiling: a true answer with a ceiling is false (ProcurAuth 7.5).
        settings.audience, std::chrono::milliseconds(settings.pdp_cache_ttl_ms), decide_for(false),
        [] {
          return static_cast<int64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count());
        });
  }
  // The identity mode of POST /mcp: the PDP decides each request for the subject of the identity token.
  if (mcp_keys_ && cfg_.mcp.identity_auth()) {
    std::vector<std::string> hosts;
    for (const auto& host : cfg_.hosts) {
      if (!host.mcp_uri.empty()) hosts.push_back(host.id);
    }
    // The tools of the identity mode apply the ceilings that the document declares for their actions (mcp_host_limits).
    // A use of an action that lists a budget (the tool run_query, mcp.session) asks with context.usage: PdpClient::decide_use never sends it
    // again after a timeout (ProcurAuth 10.6).
    const auto use_for = [this](const std::string& subject, const AccessQuestion& question) {
      PdpCallContext context;
      context.request_id = current_request_context().request_id;
      AccessDecision decision = pdp_->decide_use(subject, question, context);
      std::vector<AccessQuestion> questions = {question};
      std::vector<AccessDecision> decisions = {decision};
      access_enforce_ceilings(context.request_id, questions, &decisions, access_features(), true);
      return decisions.front();
    };
    mcp_subject_ = std::make_unique<McpSubjectAccess>(settings.audience, std::move(hosts), access_features(), decide_for(true), use_for);
  }
}

std::vector<AccessDecision> Server::access_decide(const std::vector<AccessQuestion>& questions, bool operation) {
  const AccessRequestState& state = access_state();
  // Without a PDP or a subject, no decision is valid: each one fails (fail closed).
  if (!pdp_ || !state.enforced || state.subject.empty()) return std::vector<AccessDecision>(questions.size(), access_refusal_of({}));
  std::vector<AccessDecision> decisions = pdp_->decide(state.subject, questions, state.call);
  if (operation) access_enforce_ceilings(state.call.request_id, questions, &decisions, access_features(), true);
  return decisions;
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
  // Refuse the operation with the refusal of `refused` (access_refusal_of): 503, 429 or 403.
  const auto deny = [&](const std::string& action, const std::vector<AccessDecision>& refused) {
    if (!body_read && is_write_method(req.method)) res.set_header("Connection", "close");
    refuse_decision(res, access_refusal_of(refused), action);
    return true;
  };
  if (rule.kind != AccessRuleKind::Action && rule.kind != AccessRuleKind::Run && rule.kind != AccessRuleKind::Export) return false;

  if (rule.kind == AccessRuleKind::Run && rule.spend) {
    // A run of SQL is a use of query.run.read or query.run.write, and these actions list the budget `queries`. ProcurAuth 10.1: the PEP
    // never sends the question of a use without context.usage before the question with it. So this check asks nothing: the handler calls
    // access_use_run when it has the SQL (the class of the SQL gives the action of the use). Fail closed until then.
    state.use_pending = true;
    state.read_only = true;
    state.ceilings = AccessRunCeilings{};
    return false;
  }

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
      if (!export_somewhere) return deny("query.export", decisions_of(questions, decisions, "query.export"));
      if (!run_somewhere) {
        std::vector<AccessDecision> run = decisions_of(questions, decisions, "query.run.read");
        for (auto& decision : decisions_of(questions, decisions, "query.run.write")) run.push_back(std::move(decision));
        return deny("query.run.read", run);
      }
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
      // A listing of the databases of a host that names no database: any grant on the host or below it lets the route run, and the route
      // keeps the databases that the human may read (access_readable_databases). It never runs for a host that the human cannot see.
      const AccessMatch match = rule.list_filter && resource.type == "host" ? AccessMatch::Subtree : AccessMatch::Node;
      auto decisions = access_decide({AccessQuestion{rule.action, resource, match}});
      if (!decisions.front().allowed) return deny(rule.action, decisions);
      if (match == AccessMatch::Subtree && !decisions.front().limits.empty()) {
        // The route runs data statements with the ceilings of this answer, so a ceiling that ChDash cannot apply makes it false
        // (ProcurAuth 7.5). access_decide checks only the questions with the match "node".
        access_enforce_ceilings(state.call.request_id, {AccessQuestion{rule.action, resource}}, &decisions, access_features(), true);
        if (!decisions.front().allowed) return deny(rule.action, decisions);
      }
      // The ceilings of the action apply to each query that the route sends (ProcurAuth 7.4).
      state.ceilings = AccessRunCeilings{};
      state.ceilings.base = access_ceilings_of(decisions.front().limits);
      return false;
    }
    case AccessRuleKind::Run: {
      const auto decisions = access_decide({AccessQuestion{"query.run.read", resource}, AccessQuestion{"query.run.write", resource}});
      const bool read = decisions[0].allowed;
      const bool write = decisions[1].allowed;
      if (!read && !write) return deny("query.run.read", decisions);
      // readonly = 1 without query.run.write on this host (or on this database of the host).
      state.read_only = !write;
      // A person with both actions gets the ceilings of the one that fits the SQL (access_classify_sql). Until the class is known, the
      // lower value of each ceiling applies.
      state.ceilings = AccessRunCeilings{};
      state.ceilings.has_read = read;
      state.ceilings.has_write = write;
      if (read) state.ceilings.read = access_ceilings_of(decisions[0].limits);
      if (write) state.ceilings.write = access_ceilings_of(decisions[1].limits);
      return false;
    }
    case AccessRuleKind::Export: {
      // An export runs SQL: it needs query.export and, as a run, query.run.read or query.run.write, all on the host of the export.
      const auto decisions = access_decide({AccessQuestion{"query.export", resource}, AccessQuestion{"query.run.read", resource},
                                            AccessQuestion{"query.run.write", resource}});
      if (refuse_export(res, decisions, !body_read && is_write_method(req.method))) return true;
      state.read_only = !decisions[2].allowed;
      state.ceilings = export_ceilings(decisions);
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
  const auto decisions = access_decide({AccessQuestion{action, access_resource_of(host_id, database)}});
  if (!decisions.front().allowed) {
    refuse_decision(res, decisions.front(), action);
    return false;
  }
  // A ceiling of another node of the same action applies to this request too (ProcurAuth 5.5a): the lower value wins.
  AccessRequestState& writable = access_state();
  writable.ceilings.base = access_ceilings_lowest(writable.ceilings.base, access_ceilings_of(decisions.front().limits));
  return true;
}

void Server::access_forbidden(httplib::Response& res, const std::string& action) { refuse_forbidden(res, action); }

void Server::access_unavailable(httplib::Response& res, const std::string& action) { refuse_decision(res, access_refusal_of({}), action); }

bool Server::access_allows_all(httplib::Response& res, const std::vector<AccessQuestion>& questions, bool for_key) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp() || questions.empty()) return true;
  const auto decisions = access_decide(questions);
  // A failure answers 503 before a denial: the failed question can be the only one that a working PDP refuses.
  for (size_t i = 0; i < questions.size(); ++i) {
    if (!decisions[i].failed) continue;
    refuse_decision(res, decisions[i], questions[i].action);
    return false;
  }
  for (size_t i = 0; i < questions.size(); ++i) {
    if (decisions[i].allowed) continue;
    refuse_decision(res, decisions[i], questions[i].action);
    return false;
  }
  if (for_key) {
    // A key never has more than its creator (docs/mcp.md), and it applies no ceiling: a grant with a ceiling cannot give a key.
    for (size_t i = 0; i < questions.size(); ++i) {
      if (decisions[i].limits.empty()) continue;
      log_event(LogLevel::Warn, "access.ceiling_unenforceable",
                {{"request_id", state.call.request_id}, {"action", questions[i].action},
                 {"resource", access_resource_path(questions[i].resource)}, {"ceiling", decisions[i].limits.begin()->first.substr(0, 128)}});
      ApiError error;
      error.status = 403;
      error.code = "key_ceiling_unsupported";
      error.message = "The grant of your account for the action " + questions[i].action +
                      " has a limit. A key of ChDash cannot apply a limit, so it cannot get this action. Ask for a grant without a limit, or use the identity mode of MCP.";
      error.retryable = false;
      error.text.emplace_back("action", questions[i].action);
      send_error(res, error);
      return false;
    }
  }
  AccessRequestState& writable = access_state();
  for (const auto& decision : decisions) {
    writable.ceilings.base = access_ceilings_lowest(writable.ceilings.base, access_ceilings_of(decision.limits));
  }
  return true;
}

std::optional<std::unordered_set<std::string>> Server::access_readable_databases(const std::vector<const char*>& actions,
                                                                                const std::string& host_id,
                                                                                const std::vector<std::string>& databases, bool* failed,
                                                                                bool use_search) {
  if (failed) *failed = false;
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return std::nullopt;
  std::vector<std::string> names;
  std::unordered_set<std::string> seen;
  for (const auto& database : databases) {
    if (seen.insert(database).second) names.push_back(database);
  }
  if (use_search) {
    std::vector<std::string> search_actions;
    for (const char* action : actions) search_actions.emplace_back(action);
    const AccessSearchOutcome found = access_search_visible_databases(search_actions, host_id);
    if (found.kind == AccessSearchKind::Covered) return std::nullopt;
    if (found.kind == AccessSearchKind::Ids) {
      // The ids of the PDP, and only the databases that exist on the host (the PDP can return the ids of another host).
      std::unordered_set<std::string> out;
      for (const auto& name : names) {
        if (found.ids.count(name) != 0) out.insert(name);
      }
      return out;
    }
  }
  // One batch: each action on the host (a grant on the service covers it), then each action on each database of the host.
  const AccessResource host = access_resource_of(host_id, std::string());
  std::vector<AccessQuestion> questions;
  questions.reserve(actions.size() * (names.size() + 1));
  for (const char* action : actions) questions.push_back(AccessQuestion{action, host});
  for (const auto& name : names) {
    for (const char* action : actions) questions.push_back(AccessQuestion{action, access_resource_of(host_id, name)});
  }
  // These questions show or hide databases: they run no operation, so a ceiling never turns them false.
  const auto decisions = access_decide(questions, false);
  if (failed) *failed = any_failed(decisions);
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

AccessSearchOutcome Server::access_search_visible_databases(const std::vector<std::string>& actions, const std::string& host_id) {
  const AccessRequestState& state = access_state();
  if (!pdp_ || !state.enforced || state.subject.empty() || current_request_context().is_mcp()) return AccessSearchOutcome{};
  return access_search_databases(*pdp_, cfg_.access.pdp_search, cfg_.access.audience, host_id, state.subject, actions, state.call);
}

std::vector<AccessDecision> Server::access_host_decisions(std::vector<AccessQuestion>* questions, const std::string& database) {
  *questions = access_navigation_questions(cfg_.access.audience, access_host_ids(), database, access_features());
  // The navigation shows or hides pages and hosts: it runs no operation, so a ceiling never turns a decision false.
  return access_decide(*questions, false);
}

std::optional<std::set<std::string>> Server::access_visible_hosts(bool* failed) {
  if (failed) *failed = false;
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return std::nullopt;
  std::vector<AccessQuestion> questions;
  const auto decisions = access_host_decisions(&questions, std::string());
  if (failed) *failed = any_failed(decisions);
  return chdash::access_visible_hosts(questions, decisions);
}

std::set<std::string> Server::navigation_pages(const std::string& database, bool* database_allowed, bool* failed) {
  if (database_allowed) *database_allowed = true;
  if (failed) *failed = false;
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
  if (failed) *failed = any_failed(decisions);
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
  return access_decide({AccessQuestion{action, access_service_resource(cfg_.access.audience)}}, false).front().allowed;
}

bool Server::access_read_only() const {
  const AccessRequestState& state = access_state();
  return state.enforced && state.read_only && !current_request_context().is_mcp();
}

AccessCeilings Server::access_ceilings() const {
  const AccessRequestState& state = access_state();
  // A route that an MCP tool calls applies the ceilings of the call (identity mode); a key of ChDash has none.
  if (current_request_context().is_mcp()) return current_request_context().mcp_ceilings;
  if (!state.enforced) return AccessCeilings{};
  if (state.use_pending) {
    // The handler did not call access_use_run (a fault of the code, never a request): the lowest value of each ceiling applies.
    AccessCeilings lowest;
    for (const AccessCeilingInfo& info : access_ceiling_table()) lowest.set(info.name, 1);
    return lowest;
  }
  return state.ceilings.resolve(state.sql_class);
}

SqlStatementClass Server::access_classify_sql(const std::vector<std::string>& texts) {
  AccessRequestState& state = access_state();
  state.sql_class = sql_statements_class(texts);
  return state.sql_class;
}

SqlStatementClass Server::access_sql_class() const { return access_state().sql_class; }

void Server::apply_ceilings(ChQueryLimits& limits) const { chdash::apply_ceilings(access_ceilings(), limits); }

AccessCeilings Server::access_ceiling_bounds() const {
  // The bound of each setting that carries a ceiling: the key of the query block, the key of generated_queries (the pages), and the field of
  // the export. A bound of 0 stands for the schema max of the key (access_declared_max). A ceiling that no key bounds has no entry.
  const auto seconds = [](int64_t value) { return value > 0 ? static_cast<uint64_t>(value) : uint64_t{0}; };
  AccessCeilings out;
  for (const AccessCeilingInfo& info : access_ceiling_table()) {
    const std::string name = info.name;
    std::vector<uint64_t> bounds;
    if (name == "max_rows_read") {
      bounds = {cfg_.query_options.max_rows_to_read, cfg_.generated_queries.max_rows_to_read};
    } else if (name == "max_read_size") {
      bounds = {cfg_.query_options.max_bytes_to_read, cfg_.generated_queries.max_bytes_to_read};
    } else if (name == "max_duration") {
      // The request of a page ends after generated_queries.timeout_ms: round up to whole seconds.
      bounds = {seconds(cfg_.query_options.max_execution_time_s), seconds(cfg_.export_settings.max_execution_time_s),
                static_cast<uint64_t>((cfg_.generated_queries.timeout_ms + 999) / 1000)};
    } else if (name == "max_memory") {
      bounds = {cfg_.query_options.max_memory_usage, cfg_.generated_queries.max_memory_usage, cfg_.export_settings.max_memory_usage};
    }
    out.set(name, access_declared_max(bounds, info.schema_max));
  }
  return out;
}

bool Server::access_check_export_stream(httplib::Response& res, const std::string& host_id, const ExportJobAccess& stored) {
  AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  // The permissions of the run, on the host of the job: the stream body holds the token only, so no host is in the request. They are the
  // other permissions of the use (ProcurAuth 5.5a): they are asked without context.usage. The action of the use, query.export, is asked
  // later with context.usage (access_use_export), when the download starts.
  const AccessResource resource = access_resource_of(host_id, std::string());
  const auto decisions = access_decide({AccessQuestion{"query.run.read", resource}, AccessQuestion{"query.run.write", resource}});
  if (!decisions[0].allowed && !decisions[1].allowed) {
    refuse_decision(res, access_refusal_of(decisions), "query.run.read");
    return false;
  }
  state.ceilings = AccessRunCeilings{};
  state.ceilings.has_read = decisions[0].allowed;
  state.ceilings.has_write = decisions[1].allowed;
  if (decisions[0].allowed) state.ceilings.read = access_ceilings_of(decisions[0].limits);
  if (decisions[1].allowed) state.ceilings.write = access_ceilings_of(decisions[1].limits);
  // The run decided too: the stream is never looser than the run was.
  state.ceilings.base = stored.ceilings;
  state.sql_class = stored.sql_class;
  state.read_only = !decisions[1].allowed || stored.read_only;
  return true;
}

AccessDecision Server::access_decide_use(const AccessQuestion& question, bool* pdp_true) {
  const AccessRequestState& state = access_state();
  if (pdp_true) *pdp_true = false;
  if (!pdp_ || !state.enforced || state.subject.empty()) return access_refusal_of({});
  // An action that the document lists with no budget has no question with context.usage (ProcurAuth 6.4).
  if (!access_action_has_budget(question.action, access_features())) {
    AccessDecision decision = access_decide({question}).front();
    if (pdp_true) *pdp_true = decision.allowed;
    return decision;
  }
  AccessDecision decision = pdp_->decide_use(state.subject, question, state.call);
  if (pdp_true) *pdp_true = decision.allowed;
  // A true answer with a ceiling that ChDash cannot apply is false (ProcurAuth 7.5). The PDP took the unit already: the caller never asks
  // another action for this use after a true answer (pdp_true).
  std::vector<AccessQuestion> questions = {question};
  std::vector<AccessDecision> decisions = {decision};
  access_enforce_ceilings(state.call.request_id, questions, &decisions, access_features(), true);
  return decisions.front();
}

bool Server::access_use_run(httplib::Response& res, const std::string& host_id, const std::vector<std::string>& sql_texts) {
  AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  const SqlStatementClass sql_class = access_classify_sql(sql_texts);
  const AccessResource resource = access_resource_of(host_id, std::string());
  const AccessRunUse use = access_run_use(
      sql_class, [&](const std::string& action) { return access_decide({AccessQuestion{action, resource}}).front(); },
      [&](const std::string& action, bool* pdp_true) { return access_decide_use(AccessQuestion{action, resource}, pdp_true); });
  if (!use.allowed) {
    refuse_decision(res, use.refusal, use.action);
    return false;
  }
  state.ceilings = use.ceilings;
  // readonly = 1 without query.run.write on this host.
  state.read_only = use.read_only;
  state.use_pending = false;
  return true;
}

bool Server::access_run_permitted(httplib::Response& res, const std::string& host_id) {
  const AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  const AccessResource resource = access_resource_of(host_id, std::string());
  const auto decisions = access_decide({AccessQuestion{"query.run.read", resource}, AccessQuestion{"query.run.write", resource}});
  if (decisions.size() == 2 && (decisions[0].allowed || decisions[1].allowed)) return true;
  refuse_decision(res, access_refusal_of(decisions), "query.run.read");
  return false;
}

bool Server::access_use_export(httplib::Response& res, const std::string& host_id) {
  AccessRequestState& state = access_state();
  if (!state.enforced || current_request_context().is_mcp()) return true;
  const AccessResource resource = access_resource_of(host_id, std::string());
  const AccessDecision used = access_decide_use(AccessQuestion{"query.export", resource}, nullptr);
  if (!used.allowed) {
    refuse_decision(res, used, "query.export");
    return false;
  }
  // The ceilings of query.export come from the answer of the use (ProcurAuth 10, step 6). The lower value of the run and of the stream applies.
  state.ceilings.base = access_ceilings_lowest(state.ceilings.base, access_ceilings_of(used.limits));
  return true;
}

std::string Server::access_json(bool* failed) {
  if (failed) *failed = false;
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
    if (failed) *failed = any_failed(decisions);
    // An action is true when the human may use it somewhere: on the service or on one host.
    w.Key("actions");
    w.StartObject();
    for (const auto& [name, allowed] : access_action_summary(questions, decisions, access_features())) {
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
