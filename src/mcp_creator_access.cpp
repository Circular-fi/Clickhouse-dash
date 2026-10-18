#include "mcp_creator_access.hpp"

#include <cstring>
#include <utility>

namespace chdash {
namespace {

// The most states that the map keeps: two for each key of the page that can exist. Past it, the expired states go, and then all.
constexpr size_t kMaxKept = 2 * kMcpMaxUiKeys;

bool same_question(const AccessQuestion& a, const AccessQuestion& b) {
  return a.action == b.action && a.resource.type == b.resource.type && a.resource.id == b.resource.id;
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

McpCreatorAccess::McpCreatorAccess(std::string service_id, std::chrono::milliseconds period, Decide decide, Clock clock)
    : service_id_(std::move(service_id)), period_(period), decide_(std::move(decide)), clock_(std::move(clock)) {}

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
  const std::vector<AccessQuestion> questions = mcp_key_access_questions(key.tools, key.databases, service_id_);
  std::vector<AccessDecision> decisions;
  if (!questions.empty()) decisions = decide_(key.creator, questions);
  decisions.resize(questions.size());

  bool failed = false;
  bool any_allowed = false;
  for (const auto& decision : decisions) {
    if (std::strcmp(decision.source, "error") == 0) failed = true;
    if (decision.allowed) any_allowed = true;
  }
  const auto allowed = [&](const AccessQuestion& question) {
    for (size_t i = 0; i < questions.size(); ++i) {
      if (same_question(questions[i], question)) return decisions[i].allowed;
    }
    return false;
  };
  if (!questions.empty() && !failed && !any_allowed) {
    out.status = McpCreatorStatus::CreatorGone;
  } else {
    out.status = failed ? McpCreatorStatus::Unknown : McpCreatorStatus::Active;
    for (const auto& name : tools) {
      const McpToolInfo* tool = mcp_find_tool(name);
      if (!tool) continue;
      bool pass = true;
      for (const auto& question : mcp_tool_access_questions(*tool, key.databases, service_id_)) {
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

std::string McpCreatorAccess::tool_refused_action(const McpKey& key, const McpToolInfo& tool) {
  if (key.creator.empty()) return "creator";
  const std::vector<AccessQuestion> questions = mcp_tool_access_questions(tool, key.databases, service_id_);
  if (questions.empty()) return {};
  std::vector<AccessDecision> decisions = decide_(key.creator, questions);
  decisions.resize(questions.size());
  for (size_t i = 0; i < questions.size(); ++i) {
    if (!decisions[i].allowed) return questions[i].action;
  }
  return {};
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
