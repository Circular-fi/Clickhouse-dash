#include "mcp_creator_access.hpp"

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
    if (decision.allowed) any_allowed = true;
    if (decision.unknown_subject) unknown_subject = true;
  }
  const auto allowed = [&](const AccessQuestion& question) {
    for (size_t i = 0; i < questions.size(); ++i) {
      if (same_question(questions[i], question)) return decisions[i].allowed;
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
    if (!decisions[i].allowed) {
      if (ceiling) *ceiling = decisions[i].ceiling_refused;
      return questions[i].action;
    }
  }
  return {};
}

McpCreatorCall McpCreatorAccess::call(const McpKey& key, const McpToolInfo& tool, const rapidjson::Value& arguments) {
  McpCreatorCall out;
  if (key.creator.empty()) {
    out.action = "creator";
    return out;
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
  if (!questions.empty()) {
    std::vector<AccessDecision> decisions = decide_(key.creator, questions);
    decisions.resize(questions.size());
    for (size_t i = 0; i < questions.size(); ++i) {
      if (!decisions[i].failed) continue;
      out.access = McpAccess::Failed;
      out.action = questions[i].action;
      return out;
    }
    for (size_t i = 0; i < questions.size(); ++i) {
      if (decisions[i].allowed) continue;
      out.action = questions[i].action;
      out.ceiling = decisions[i].ceiling_refused;
      return out;
    }
  }
  if (!use) {
    out.access = McpAccess::Allowed;
    return out;
  }
  out.use = true;
  const AccessDecision decision = decide_use_(key.creator, *use);
  switch (access_outcome(decision)) {
    case AccessOutcome::Allowed:
      out.access = McpAccess::Allowed;
      return out;
    case AccessOutcome::Failed:
      // No valid answer: the PDP can have counted the use. The call answers 503, and nothing sends the question again (ProcurAuth 10.6).
      out.access = McpAccess::Failed;
      out.action = use->action;
      return out;
    case AccessOutcome::BudgetExceeded:
      out.access = McpAccess::BudgetExceeded;
      out.action = use->action;
      out.retry_after = decision.retry_after.value_or(1);
      return out;
    case AccessOutcome::Denied:
      // A plain false, a true answer without units (6.12), or a true answer with a ceiling that a key cannot apply (7.5). The PDP took the
      // unit of a true answer: ChDash does not ask again.
      out.access = McpAccess::Denied;
      out.action = use->action;
      out.ceiling = decision.ceiling_refused;
      return out;
  }
  out.action = use->action;
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
