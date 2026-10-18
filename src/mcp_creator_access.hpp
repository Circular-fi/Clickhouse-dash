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
//   - tools/call asks the PDP for the actions of the called tool only. The cache of the PDP client applies. A failure refuses
//     the tool (fail closed).
// Pure code: the decisions come from a function that the server gives (PdpClient::decide), and the clock is a function too.

#include "access_pdp.hpp"
#include "mcp_keys.hpp"
#include "mcp_scope.hpp"

#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
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

class McpCreatorAccess {
public:
  using Decide = std::function<std::vector<AccessDecision>(const std::string& subject, const std::vector<AccessQuestion>& questions)>;
  using Clock = std::function<int64_t()>;  // milliseconds of a monotonic clock

  // `service_id` is the id of the service resource (access.identity.audience). `period` is how long a state is kept (0: never).
  McpCreatorAccess(std::string service_id, std::chrono::milliseconds period, Decide decide, Clock clock);

  // The state of a key of the page. One batch of the PDP for each key and each period at most.
  McpCreatorState state(const McpKey& key);
  // The first action of `tool` that the PDP refuses to the creator of the key, or an empty string when the creator may call it.
  // A key with no creator gives "creator".
  std::string tool_refused_action(const McpKey& key, const McpToolInfo& tool);
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
  std::mutex mu_;
  // The key is the id of the key and its creator: an adoption changes the creator, so an old state never applies to the adopter.
  std::unordered_map<std::string, Kept> kept_;
};

} // namespace chdash
