#include "mcp_creator_access.hpp"

#include "access_resource.hpp"

#include <utility>

namespace chdash {
namespace {

// The most states that the map keeps: two for each key of the page that can exist. Past it, the expired states go, and then all.
constexpr size_t kMaxKept = 2 * kMcpMaxUiKeys;

bool same_question(const AccessQuestion& a, const AccessQuestion& b) {
  return a.action == b.action && access_resource_path(a.resource) == access_resource_path(b.resource);
}

// The index in `questions` of the question of the host of the call: the host that the argument `host` names, or the only question when the
// call names no host. -1 when no question fits: the tool then runs nothing (host_required, not_found or invalid_argument).
long call_question_index(const std::vector<AccessQuestion>& questions, const rapidjson::Value& arguments) {
  const rapidjson::Value* host = nullptr;
  if (arguments.IsObject()) {
    const auto it = arguments.FindMember("host");
    if (it != arguments.MemberEnd() && !it->value.IsNull()) host = &it->value;
  }
  if (host && !host->IsString()) return -1;
  const std::string named = host ? std::string(host->GetString(), host->GetStringLength()) : std::string();
  // An empty `host` is no host, as for the tool (resolve_host).
  if (named.empty()) return questions.size() == 1 ? 0 : -1;
  for (size_t i = 0; i < questions.size(); ++i) {
    if (questions[i].resource.type == "host" && questions[i].resource.id == named) return static_cast<long>(i);
  }
  return -1;
}

// True when the creator holds the action for a standing check: a true answer, or, with the approval flow, a reason of ProcurAuth 17.1 that
// asks for the approval of a use. The question of the operation of a call goes through the gate; this check only asks whether the key can
// ever use the action for its creator.
bool holds(const AccessDecision& decision, bool approval) {
  if (decision.allowed) return true;
  return approval && !decision.failed && (decision.reason == PdpReason::ApprovalRequired || decision.reason == PdpReason::ApprovalPending);
}

bool needs_approval(const AccessDecision& decision) {
  return !decision.allowed && !decision.failed && (decision.reason == PdpReason::ApprovalRequired || decision.reason == PdpReason::ApprovalPending);
}

McpToolOutcome approval_answer(McpToolOutcome outcome, const char* word) {
  outcome.approval = word;
  return outcome;
}

} // namespace

const char* mcp_creator_status_name(McpCreatorStatus status) {
  switch (status) {
    case McpCreatorStatus::Active: return "active";
    case McpCreatorStatus::Unknown: return "unknown";
    case McpCreatorStatus::NoCreator: return "no_creator";
    case McpCreatorStatus::CreatorGone: return "creator_gone";
  }
  return "unknown";
}

bool mcp_creator_orphan(McpCreatorStatus status) {
  return status == McpCreatorStatus::NoCreator || status == McpCreatorStatus::CreatorGone;
}

McpCreatorAccess::McpCreatorAccess(std::string service_id, std::chrono::milliseconds period, Decide decide, Clock clock, DecideUse decide_use,
                                   HasBudget has_budget)
    : service_id_(std::move(service_id)),
      period_(period),
      decide_(std::move(decide)),
      clock_(std::move(clock)),
      decide_use_(std::move(decide_use)),
      has_budget_(std::move(has_budget)) {}

McpCreatorState McpCreatorAccess::state(const McpKey& key) {
  McpCreatorState out;
  if (key.creator.empty()) {
    out.status = McpCreatorStatus::NoCreator;
    return out;
  }
  std::string kept_key = key.id;
  kept_key.push_back('\0');
  kept_key += key.creator;
  const int64_t now = clock_();
  {
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = kept_.find(kept_key);
    if (it != kept_.end() && it->second.expires_ms > now) return it->second.state;
  }

  const std::vector<std::string> tools = mcp_effective_tools(key.tools, key.databases);
  const std::vector<AccessQuestion> questions = mcp_key_access_questions(key.tools, key.hosts, key.databases, service_id_);
  std::vector<AccessDecision> decisions;
  if (!questions.empty()) decisions = decide_(key.creator, questions);
  decisions.resize(questions.size());

  bool failed = false;
  bool any_allowed = false;
  bool unknown_subject = false;
  for (const auto& decision : decisions) {
    // AccessDecision::failed: the PDP gave no valid answer (ProcurAuth 10.3). It is not a denial.
    if (decision.failed) failed = true;
    if (holds(decision, approval_ != nullptr)) any_allowed = true;
    if (decision.unknown_subject) unknown_subject = true;
  }
  const auto allowed = [&](const AccessQuestion& question) {
    for (size_t i = 0; i < questions.size(); ++i) {
      if (same_question(questions[i], question)) return holds(decisions[i], approval_ != nullptr);
    }
    return false;
  };
  // Only the reason "unknown_subject" makes an orphan (contract 11.5). A plain false is "no permission": the creator keeps the key.
  if (!failed && !any_allowed && unknown_subject) {
    out.status = McpCreatorStatus::CreatorGone;
  } else {
    out.status = failed ? McpCreatorStatus::Unknown : McpCreatorStatus::Active;
    for (const auto& name : tools) {
      const McpToolInfo* tool = mcp_find_tool(name);
      if (!tool) continue;
      bool pass = true;
      for (const auto& question : mcp_tool_access_questions(*tool, key.hosts, key.databases, service_id_)) {
        if (!allowed(question)) {
          pass = false;
          break;
        }
      }
      if (pass) out.tools.push_back(name);
    }
  }
  // A failure of the PDP is never kept: the next request asks again.
  if (failed || period_.count() <= 0) return out;
  std::lock_guard<std::mutex> lock(mu_);
  if (kept_.size() >= kMaxKept) {
    for (auto it = kept_.begin(); it != kept_.end();) it = it->second.expires_ms <= now ? kept_.erase(it) : std::next(it);
    if (kept_.size() >= kMaxKept) kept_.clear();
  }
  kept_[kept_key] = Kept{out, now + static_cast<int64_t>(period_.count())};
  return out;
}

std::string McpCreatorAccess::tool_refused_action(const McpKey& key, const McpToolInfo& tool, std::string* ceiling) {
  if (ceiling) ceiling->clear();
  if (key.creator.empty()) return "creator";
  const std::vector<AccessQuestion> questions = mcp_tool_access_questions(tool, key.hosts, key.databases, service_id_);
  if (questions.empty()) return {};
  std::vector<AccessDecision> decisions = decide_(key.creator, questions);
  decisions.resize(questions.size());
  for (size_t i = 0; i < questions.size(); ++i) {
    if (!holds(decisions[i], approval_ != nullptr)) {
      if (ceiling) *ceiling = decisions[i].ceiling_refused;
      return questions[i].action;
    }
  }
  return {};
}

McpAccess McpCreatorAccess::status(const McpKey& key, const rapidjson::Value& arguments, McpCallInfo* info) {
  // The tool of the verdict asks the PDP no question (binding 5.7b). The subject of the request is the creator of the key.
  if (!approval_ || key.creator.empty() || !info) return McpAccess::Denied;
  return approval_->status(key.creator, arguments, info);
}

McpCreatorCall McpCreatorAccess::call(const McpKey& key, const McpToolInfo& tool, const rapidjson::Value& arguments, McpCallInfo* info) {
  McpCreatorCall out;
  if (key.creator.empty()) {
    out.action = "creator";
    return out;
  }
  const bool gated = approval_ != nullptr && info != nullptr;
  if (gated) {
    // Each tool accepts the control arguments (binding 5.7). A bad one asks the PDP nothing, and a good one never reaches the tool.
    McpApprovalControls controls;
    if (!mcp_split_approval_controls(arguments, &controls)) {
      info->answered = approval_answer(mcp_approval_error("invalid_argument"), "invalid_argument");
      out.access = McpAccess::Allowed;
      return out;
    }
    if (arguments.IsObject()) {
      for (const auto& m : arguments.GetObject()) {
        info->controls_present = info->controls_present || mcp_is_approval_control(std::string_view(m.name.GetString(), m.name.GetStringLength()));
      }
    }
  }
  std::vector<AccessQuestion> questions = mcp_tool_access_questions(tool, key.hosts, key.databases, service_id_);
  if (questions.empty()) {
    out.access = McpAccess::Allowed;
    return out;
  }
  // The use: the tool runs the work of the creator on one host, and its action lists a budget (ProcurAuth 6.4). One tool asks one action.
  const char* action = mcp_tool_access_action(tool);
  std::optional<AccessQuestion> use;
  if (decide_use_ && has_budget_ && action && has_budget_(action)) {
    const long index = call_question_index(questions, arguments);
    if (index >= 0) {
      use = questions[static_cast<size_t>(index)];
      // ProcurAuth 10.1: the question of the use is the question of the operation. The same question without context.usage never goes first.
      questions.erase(questions.begin() + index);
    }
  }
  // The other permissions of the tool first, without context.usage (ProcurAuth 5.5a). A refusal stops the call: no unit is taken (10.1a).
  // A failure comes before a denial, as on the routes: a failed question can hide a true answer, and the call answers 503 (10.3).
  // With the approval flow, a reason of 17.1 is not a refusal here: the creator holds the action, and the operation asks for the approval.
  std::vector<AccessDecision> decisions;
  if (!questions.empty()) {
    decisions = decide_(key.creator, questions);
    decisions.resize(questions.size());
    for (size_t i = 0; i < questions.size(); ++i) {
      if (!decisions[i].failed) continue;
      out.access = McpAccess::Failed;
      out.action = questions[i].action;
      return out;
    }
    for (size_t i = 0; i < questions.size(); ++i) {
      if (holds(decisions[i], gated)) continue;
      out.action = questions[i].action;
      out.ceiling = decisions[i].ceiling_refused;
      return out;
    }
  }
  AccessDecision decision;
  const AccessQuestion* operation = nullptr;
  std::function<AccessDecision()> first;
  bool budget = false;
  if (use) {
    out.use = true;
    operation = &*use;
    budget = true;
    first = [&]() { return decide_use_(key.creator, *use); };
  } else if (gated) {
    // Without a budget, the questions above held the question of the operation. The standing questions that the PDP answered with a reason
    // of 17.1 are the candidates: the call names the host, and the database when the tool takes one. One candidate is the operation. None
    // means that the PDP asks no approval for this call. Several are a call that no effect can name: it fails closed.
    const std::string named_host = [&]() {
      if (arguments.IsObject()) {
        const auto it = arguments.FindMember("host");
        if (it != arguments.MemberEnd() && it->value.IsString() && it->value.GetStringLength() > 0) {
          return std::string(it->value.GetString(), it->value.GetStringLength());
        }
      }
      return key.hosts.size() == 1 ? key.hosts.front() : std::string();
    }();
    const std::string named_database = mcp_call_database(tool, arguments);
    std::vector<size_t> candidates;
    for (size_t i = 0; i < questions.size(); ++i) {
      if (!needs_approval(decisions[i])) continue;
      const std::string host = access_resource_host(questions[i].resource);
      if (!host.empty() && host != named_host) continue;
      if (questions[i].resource.type == "database" && !named_database.empty() && questions[i].resource.id != named_database) continue;
      candidates.push_back(i);
    }
    if (candidates.size() > 1) {
      // Several databases need an approval and the call names no one of them: no effect can name the operation. The agent gets a tool error that
      // tells what to change, never the answer for an unknown tool (docs/access.md, "The keys of the page").
      const std::string message =
          mcp_tool_takes_database(tool)
              ? "The key reaches several databases, and each one needs the approval of the owner. Name one database in the argument database, so that the approval covers it."
              : "The key reaches several databases, and each one needs the approval of the owner. This tool names no database, so no approval can cover it. Use a tool that names one database, for example list_tables.";
      info->answered = approval_answer(mcp_tool_error("invalid_argument", message), "invalid_argument");
      out.access = McpAccess::Allowed;
      return out;
    }
    if (candidates.size() == 1) {
      operation = &questions[candidates.front()];
      const AccessDecision answered = decisions[candidates.front()];
      first = [answered]() { return answered; };
    }
  }
  if (operation == nullptr) {
    if (!use) {
      out.access = McpAccess::Allowed;
      return out;
    }
  }
  if (operation != nullptr && gated) {
    const McpGateResult result = approval_->call(key.creator, tool, *operation, budget, arguments, info, first);
    if (!result.run && !result.pass) {
      out.access = result.access;
      out.action = operation->action;
      if (result.access == McpAccess::BudgetExceeded) out.retry_after = info->retry_after.value_or(1);
      return out;
    }
    decision = result.decision;
    // A key applies no ceiling (ProcurAuth 7.5). The gate asks the PDP directly, so the check of the ceilings is here.
    if (result.run && !decision.limits.empty()) {
      out.access = McpAccess::Denied;
      out.action = operation->action;
      out.ceiling = decision.limits.begin()->first;
      return out;
    }
  } else {
    decision = decide_use_(key.creator, *use);
  }
  switch (access_outcome(decision)) {
    case AccessOutcome::Allowed:
      out.access = McpAccess::Allowed;
      return out;
    case AccessOutcome::Failed:
      // No valid answer: the PDP can have counted the use. The call answers 503, and nothing sends the question again (ProcurAuth 10.6).
      out.access = McpAccess::Failed;
      out.action = operation->action;
      return out;
    case AccessOutcome::BudgetExceeded:
      out.access = McpAccess::BudgetExceeded;
      out.action = operation->action;
      out.retry_after = decision.retry_after.value_or(1);
      return out;
    case AccessOutcome::Denied:
      // A plain false, a true answer without units (6.12), or a true answer with a ceiling that a key cannot apply (7.5). The PDP took the
      // unit of a true answer: ChDash does not ask again.
      out.access = McpAccess::Denied;
      out.action = operation->action;
      out.ceiling = decision.ceiling_refused;
      return out;
  }
  out.action = operation->action;
  return out;
}

void McpCreatorAccess::forget(const std::string& key_id) {
  std::lock_guard<std::mutex> lock(mu_);
  std::string prefix = key_id;
  prefix.push_back('\0');
  for (auto it = kept_.begin(); it != kept_.end();) {
    it = it->first.compare(0, prefix.size(), prefix) == 0 ? kept_.erase(it) : std::next(it);
  }
}

size_t McpCreatorAccess::kept() {
  std::lock_guard<std::mutex> lock(mu_);
  return kept_.size();
}

} // namespace chdash
