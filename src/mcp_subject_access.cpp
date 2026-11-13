#include "mcp_subject_access.hpp"

#include "access_ceilings.hpp"
#include "access_pages.hpp"
#include "log.hpp"
#include "mcp_api_tools.hpp"
#include "mcp_scope.hpp"
#include "mcp_usage.hpp"

#include <algorithm>
#include <set>
#include <utility>

namespace chdash {
namespace {

bool contains(const std::vector<std::string>& list, const std::string& value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

// The text of a member of an object, or empty when the member is absent or is not text.
std::string text_member(const rapidjson::Value& object, const char* name) {
  if (!object.IsObject()) return {};
  const auto it = object.FindMember(name);
  if (it == object.MemberEnd() || !it->value.IsString()) return {};
  return std::string(it->value.GetString(), it->value.GetStringLength());
}

} // namespace

McpKey mcp_identity_key(const std::string& subject) {
  McpKey key;
  const McpHash hash = mcp_hash_secret(subject);
  key.id = "sub_" + mcp_hash_hex(hash).substr(0, 24);
  key.name = mcp_usage_clean(subject, kMcpNameMaxBytes);
  if (key.name.empty()) key.name = key.id;
  key.source = kMcpSourceIdentity;
  key.subject = subject;
  key.hosts = {"*"};
  key.databases = {"*"};
  // "*" does not give the tools that need a name (explicit_only): the key names them. The PDP and the configuration decide the rest.
  key.tools = {"*"};
  for (const auto& tool : mcp_tool_catalog()) {
    if (tool.explicit_only) key.tools.emplace_back(tool.name);
  }
  return key;
}

const char* mcp_tool_identity_action(const McpToolInfo& tool) {
  if (const char* action = mcp_tool_access_action(tool)) return action;
  // list_hosts and the analysis of the caller read no data of a host: each has an action of its own. mcp.session is never the action of a tool.
  if (std::string_view(tool.name) == "list_hosts") return "mcp.hosts.read";
  if (std::string_view(tool.name) == "mcp_analysis_my_limits" || std::string_view(tool.name) == "mcp_analysis_my_usage") return "mcp.analysis.read";
  return "unknown";
}

McpSubjectAccess::McpSubjectAccess(std::string service_id, std::vector<std::string> hosts, AccessFeatures features, Decide decide,
                                   DecideUse decide_use)
    : service_id_(std::move(service_id)),
      hosts_(std::move(hosts)),
      features_(features),
      decide_(std::move(decide)),
      decide_use_(std::move(decide_use)) {}

McpAccess McpSubjectAccess::session(const std::string& subject, uint64_t* retry_after) {
  const AccessQuestion question{"mcp.session", access_service_resource(service_id_)};
  // The request is one use of mcp.session (binding 3.6a): with the budget `requests` in the document, the question has context.usage.
  AccessDecision decision;
  if (decide_use_ && access_action_has_budget(question.action, features_)) {
    decision = decide_use_(subject, question);
  } else {
    std::vector<AccessDecision> decisions = decide_(subject, {question});
    decisions.resize(1);
    decision = decisions.front();
  }
  switch (access_outcome(decision)) {
    case AccessOutcome::Allowed: return McpAccess::Allowed;
    case AccessOutcome::Failed: return McpAccess::Failed;
    case AccessOutcome::BudgetExceeded:
      if (retry_after) *retry_after = decision.retry_after.value_or(1);
      return McpAccess::BudgetExceeded;
    case AccessOutcome::Denied: return McpAccess::Denied;
  }
  return McpAccess::Denied;
}

std::optional<std::vector<std::string>> McpSubjectAccess::list(const std::string& subject, std::vector<std::string> tools) {
  // One item for each action, not for each tool (binding 4.1). A tool whose action is not published is not listed.
  std::vector<std::string> actions;
  std::vector<std::string> action_of(tools.size());
  std::vector<bool> always(tools.size(), false);
  for (size_t i = 0; i < tools.size(); ++i) {
    // get_action_status has no action: tools/list names it with the tools that can need an approval, that is with each tool (binding 4.1).
    if (approval_ && tools[i] == kMcpStatusTool) {
      always[i] = true;
      continue;
    }
    const McpToolInfo* info = mcp_find_tool(tools[i]);
    if (!info && approval_) info = mcp_find_approval_tool(tools[i]);
    if (!info) continue;
    const std::string name = mcp_tool_identity_action(*info);
    const AccessAction* action = access_action(name);
    if (!action || !access_action_published(*action, features_)) continue;
    action_of[i] = name;
    if (!contains(actions, name)) actions.push_back(name);
  }
  std::vector<std::string> out;
  std::set<std::string> allowed;
  if (!actions.empty()) {
    std::vector<AccessQuestion> questions;
    for (const auto& name : actions) questions.push_back(AccessQuestion{name, access_service_resource(service_id_), AccessMatch::Subtree});
    std::vector<AccessDecision> decisions = decide_(subject, questions);
    decisions.resize(questions.size());
    for (size_t i = 0; i < questions.size(); ++i) {
      if (decisions[i].failed) return std::nullopt;
      if (decisions[i].allowed) allowed.insert(questions[i].action);
    }
  }
  for (size_t i = 0; i < tools.size(); ++i) {
    if (always[i] || (!action_of[i].empty() && allowed.count(action_of[i]))) out.push_back(tools[i]);
  }
  // Binding 5.7b: tools/list names get_action_status when it names at least one other tool.
  if (out.size() == 1 && out.front() == kMcpStatusTool) out.clear();
  return out;
}

std::optional<AccessQuestion> McpSubjectAccess::call_question(const McpToolInfo& tool, const rapidjson::Value& arguments) const {
  const std::string name = mcp_tool_identity_action(tool);
  const AccessAction* action = access_action(name);
  if (!action || !access_action_published(*action, features_)) return std::nullopt;
  if (!action->host) return AccessQuestion{name, access_service_resource(service_id_)};
  const std::string host = text_member(arguments, "host");
  // No host (or a value that is not text): the tool gives host_required, and it reads nothing. The question asks only whether the
  // person can use the tool somewhere (the match "subtree"), as tools/list does.
  if (host.empty()) return AccessQuestion{name, access_service_resource(service_id_), AccessMatch::Subtree};
  // A host that MCP does not reach: the question goes to the service. A host that the person cannot see and a host that does not
  // exist get the same answer, and the PDP never receives an id that the client chose for a host.
  if (!contains(hosts_, host)) return AccessQuestion{name, access_service_resource(service_id_)};
  const std::string database = action->database ? mcp_call_database(tool, arguments) : std::string();
  if (database.empty() || !access_valid_id(database)) return AccessQuestion{name, access_host_resource(service_id_, host)};
  return AccessQuestion{name, access_database_resource(service_id_, host, database)};
}

std::optional<std::vector<std::string>> McpSubjectAccess::visible_hosts(const std::string& subject) {
  const std::vector<AccessQuestion> questions = access_navigation_questions(service_id_, hosts_, std::string(), features_);
  std::vector<AccessDecision> decisions = decide_(subject, questions);
  decisions.resize(questions.size());
  for (const auto& decision : decisions) {
    if (decision.failed) return std::nullopt;
  }
  const std::set<std::string> visible = access_visible_hosts(questions, decisions);
  std::vector<std::string> out;
  for (const auto& host : hosts_) {
    if (visible.count(host)) out.push_back(host);
  }
  return out;
}

McpAccess McpSubjectAccess::call(const std::string& subject, const McpToolInfo& tool, const rapidjson::Value& arguments, McpCallInfo* info) {
  // The tool of the verdict asks the PDP no question (binding 5.7b).
  if (approval_ && std::string_view(tool.name) == kMcpStatusTool) return approval_->status(subject, arguments, info);
  const std::optional<AccessQuestion> question = call_question(tool, arguments);
  if (!question) return McpAccess::Denied;
  // The call is one use (binding 3.4) when the document lists a budget on the action of the tool and the question names a node (a call with
  // no host runs nothing). The tools of query.run.read (run_query, explain_query, format_sql, explorer_names, query_execution) take one unit
  // of `queries` for each call, as in the mode keys (owner decision of 2026-11-07); the tools of mcp.session take one unit of `requests`.
  // Then the question has context.usage and no question without it comes first (protocol 10.1). An API tool calls its route in the process,
  // and the route asks the PDP nothing: a call takes one unit at most.
  const bool use = decide_use_ && question->match == AccessMatch::Node && access_action_has_budget(question->action, features_);
  // export_query needs two permissions (ProcurAuth 5.5a, 10.1a): the export and the run of the statement. The other permission is asked first,
  // without usage and without effect, and only after the check of the arguments and of the control arguments (contract 9.4, step 1 and 2: a
  // call with a bad argument asks the PDP nothing). A `false` answer, also with a reason of 17.1, refuses the call before the use takes a unit (17.7).
  // The ceilings of that permission lower the ceilings of the call, as the ceilings of its own action do (ProcurAuth 5.5a).
  const bool needs_other = std::string_view(tool.name) == kMcpExportTool && question->match == AccessMatch::Node;
  PdpLimits other_limits;
  bool scope_needs_approval = false;
  const auto other_stop = [&]() -> std::optional<AccessDecision> {
    if (!needs_other) return std::nullopt;
    AccessQuestion scope{"query.run.read", question->resource};
    scope.permission_only = true;  // 5.5a: the PDP ignores `confirm` for it and answers a plain decision
    std::vector<AccessDecision> other = decide_(subject, {scope});
    other.resize(1);
    if (other.front().failed) return other.front();
    if (!other.front().allowed) {
      // ProcurAuth 5.5a (spec question 53): the approval follows the action of the use alone (query.export). The question carries
      // context.permission_only, so a PDP of the protocol never gives a reason of 17.1 for it. A PDP that does is not valid (10.3): the call is
      // refused with a tool error that says so, and never starts an approval.
      scope_needs_approval = pdp_reason_is_approval(other.front().reason);
      AccessDecision denied;
      denied.source = "pdp";
      return denied;
    }
    other_limits = other.front().limits;
    return std::nullopt;
  };
  AccessDecision decision;
  if (approval_ && question->match == AccessMatch::Node) {
    // The approval of a person for any action (ProcurAuth 17.7). The question of 10.1 comes first, with no effect: the PDP decides which grant
    // needs an approval. Only a reason of 17.1 starts the flow of the gate.
    const auto first = [&]() {
      if (const auto stop = other_stop()) return *stop;
      if (use) return decide_use_(subject, *question);
      std::vector<AccessDecision> decisions = decide_(subject, {*question});
      decisions.resize(1);
      return decisions.front();
    };
    const McpGateResult gated = approval_->call(subject, tool, *question, use, arguments, info, first);
    if (!gated.run && !gated.pass) return gated.access;
    decision = gated.decision;
  } else if (const auto stop = other_stop()) {
    decision = *stop;
  } else if (use) {
    decision = decide_use_(subject, *question);
  } else {
    std::vector<AccessDecision> decisions = decide_(subject, {*question});
    decisions.resize(1);
    decision = decisions.front();
  }
  if (scope_needs_approval && info) {
    info->answered = mcp_tool_error("scope_needs_approval",
                                    "The grant for the scope of this call (query.run.read) asks for an approval. An approval covers only the action of the tool "
                                    "(query.export), so the call is refused. Ask the owner for a grant of query.run.read without confirm.");
    return McpAccess::Allowed;
  }
  switch (access_outcome(decision)) {
    case AccessOutcome::Allowed: break;
    case AccessOutcome::Failed: return McpAccess::Failed;
    case AccessOutcome::BudgetExceeded:
      if (info) info->retry_after = decision.retry_after.value_or(1);
      return McpAccess::BudgetExceeded;
    case AccessOutcome::Denied: return McpAccess::Denied;
  }
  // A true answer with a ceiling that MCP cannot apply is false (ProcurAuth 7.5). MCP applies the ceilings that the document declares for
  // the action of the tool, as the pages do. The server already checks this for a question on a node; a question with the match "subtree"
  // (a call without a host) gets the same check here.
  McpCeilings ceilings;
  std::string refused;
  if (!access_ceilings_enforceable(decision.limits, question->action, features_, &refused) ||
      !mcp_ceilings_of(decision.limits, &ceilings, &refused)) {
    log_event(LogLevel::Warn, "access.ceiling_unenforceable",
              {{"action", question->action}, {"resource", access_resource_path(question->resource)}, {"ceiling", refused.substr(0, 128)}});
    return McpAccess::Denied;
  }
  if (tool.name == std::string_view("list_hosts")) {
    const auto visible = visible_hosts(subject);
    if (!visible) return McpAccess::Failed;
    if (info) info->visible_hosts = *visible;
  }
  // The ceilings of the other permission (export_query: query.run.read) apply too, and the lowest value wins. A ceiling that its action does not
  // declare, or that MCP cannot apply, makes the answer false (ProcurAuth 7.5).
  if (!other_limits.empty()) {
    McpCeilings other_ceilings;
    std::string other_refused;
    if (!access_ceilings_enforceable(other_limits, "query.run.read", features_, &other_refused) ||
        !mcp_ceilings_of(other_limits, &other_ceilings, &other_refused)) {
      log_event(LogLevel::Warn, "access.ceiling_unenforceable",
                {{"action", "query.run.read"}, {"resource", access_resource_path(question->resource)}, {"ceiling", other_refused.substr(0, 128)}});
      return McpAccess::Denied;
    }
    ceilings.lower(other_ceilings);
  }
  if (info) info->ceilings.lower(ceilings);
  return McpAccess::Allowed;
}

} // namespace chdash
