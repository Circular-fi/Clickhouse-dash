#pragma once

// The access of humans for the MCP keys of the page in the authzen mode (docs/mcp.md, "Keys and the access of humans").
// A key of the page never has more than its creator:
//   - the state of a key comes from one batch of the PDP for its creator, with every action that the tools of the key use. The
//     state is kept for one period (pdp.cache_ttl). An answer with a failure of the PDP is never kept;
//   - a key with no creator, or whose creator the PDP does not know (a false decision with the reason "unknown_subject", contract
//     11.5), is an orphan: every request of the key gets the 401 of a key that does not exist, until a person adopts the key;
//   - a creator who exists keeps the key, also without an action of the key: each tool of a refused action is refused, and nobody
//     can adopt the key. A failure of the PDP never makes an orphan;
//   - tools/list shows only the tools whose actions the creator holds (the batch of the state);
//   - tools/call asks the PDP for the actions of the called tool only. The cache of the PDP client applies. A failure of the PDP gives
//     Failed: the request answers 503 with -32603, as the routes and the identity mode (owner decision of 2026-11-07);
//   - a call of a tool whose action lists a budget (query.run.read lists `queries`: run_query, explain_query and the API tools of the Query
//     page) is one use of the creator (call). The question of the host of the call has context.usage, and no question without
//     context.usage goes before it. A spent budget gives BudgetExceeded and a failure of this question gives Failed, as on the routes.
// Pure code: the decisions come from a function that the server gives (PdpClient::decide), and the clock is a function too.

#include "access_pdp.hpp"
#include "mcp_access.hpp"
#include "mcp_keys.hpp"
#include "mcp_scope.hpp"

#include <rapidjson/document.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace chdash {

enum class McpCreatorStatus {
  // The creator exists for the PDP: the key keeps the tools whose actions the creator holds (it can be none), or the key uses no action.
  Active,
  // The PDP did not answer for every question: the tools of a failed question are refused, and nothing is concluded.
  Unknown,
  // The key has no creator (a key of an older ChDash, or of the open mode).
  NoCreator,
  // The PDP does not know the creator: a false decision with the reason "unknown_subject", no true decision and no failure.
  CreatorGone,
};

// "active", "unknown", "no_creator" or "creator_gone".
const char* mcp_creator_status_name(McpCreatorStatus status);
// True for NoCreator and CreatorGone: the key is refused, and a person can adopt it.
bool mcp_creator_orphan(McpCreatorStatus status);

struct McpCreatorState {
  McpCreatorStatus status = McpCreatorStatus::Active;
  // The tools of the key (mcp_effective_tools, in the order of the catalog) whose questions all passed. Empty for an orphan.
  std::vector<std::string> tools;
};

// The decision of one call of a tool for the creator of a key (McpCreatorAccess::call).
struct McpCreatorCall {
  McpAccess access = McpAccess::Denied;
  // The first refused action, or "creator" for a key with no creator. Empty when the call is allowed. For the log only.
  std::string action;
  // The ceiling that made a true answer false: a key cannot apply a ceiling (ProcurAuth 7.5). Empty for any other answer.
  std::string ceiling;
  // The seconds of retry_after of BudgetExceeded (a whole number from 1).
  std::optional<uint64_t> retry_after;
  // True when the call sent the question of a use, with context.usage. The PDP can then have taken a unit of the creator.
  bool use = false;
};

class McpCreatorAccess {
public:
  using Decide = std::function<std::vector<AccessDecision>(const std::string& subject, const std::vector<AccessQuestion>& questions)>;
  using Clock = std::function<int64_t()>;  // milliseconds of a monotonic clock
  // The question of a use, with context.usage (PdpClient::decide_use). The server checks the ceilings of the answer as for a key: a true
  // answer with a ceiling is false, with AccessDecision::ceiling_refused.
  using DecideUse = std::function<AccessDecision(const std::string& subject, const AccessQuestion& question)>;
  // True when the action document lists a budget on the action (access_action_has_budget).
  using HasBudget = std::function<bool(const std::string& action)>;

  // `service_id` is the id of the service resource (access.identity.audience). `period` is how long a state is kept (0: never). Without
  // `decide_use` or `has_budget` (the tests of the state), no call sends a question with context.usage.
  McpCreatorAccess(std::string service_id, std::chrono::milliseconds period, Decide decide, Clock clock, DecideUse decide_use = {},
                   HasBudget has_budget = {});

  // The state of a key of the page. One batch of the PDP for each key and each period at most.
  McpCreatorState state(const McpKey& key);
  // The first action of `tool` that the PDP refuses to the creator of the key, or an empty string when the creator may call it.
  // A key with no creator gives "creator".
  // `*ceiling` (when not null) receives the name of the ceiling that made the refused answer false: a key cannot apply a ceiling. It is
  // empty for a plain denial.
  std::string tool_refused_action(const McpKey& key, const McpToolInfo& tool, std::string* ceiling = nullptr);
  // The decision of one tools/call of `tool` with `arguments` for the creator of the key. When the action of the tool lists a budget, the
  // call is one use of the creator (docs/access.md, "Budgets"): the question of the action on the host of the call goes alone, with
  // context.usage, after the other questions of the tool (without it). The host of the call is the argument `host`, or the only host of the
  // key. A call whose host is not one of the key runs nothing (the tool gives host_required or not_found): it asks without context.usage.
  // A failed question without context.usage gives Failed, and a refused one Denied (with the ceiling when one made it false): each stops
  // the call before the use. The answer
  // of the use gives Allowed, Denied, BudgetExceeded (with retry_after) or Failed (no valid answer). A use that the PDP took is never asked
  // again. A tool whose action lists no budget asks as tool_refused_action does.
  McpCreatorCall call(const McpKey& key, const McpToolInfo& tool, const rapidjson::Value& arguments);
  // Forget the kept state of a key (after an adoption or a delete).
  void forget(const std::string& key_id);

  // The kept states. For the tests.
  size_t kept();

private:
  struct Kept {
    McpCreatorState state;
    int64_t expires_ms = 0;
  };

  std::string service_id_;
  std::chrono::milliseconds period_;
  Decide decide_;
  Clock clock_;
  DecideUse decide_use_;
  HasBudget has_budget_;
  std::mutex mu_;
  // The key is the id of the key and its creator: an adoption changes the creator, so an old state never applies to the adopter.
  std::unordered_map<std::string, Kept> kept_;
};

} // namespace chdash
