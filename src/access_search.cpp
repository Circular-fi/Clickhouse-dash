#include "access_search.hpp"

#include "access_resource.hpp"
#include "log.hpp"

#include <algorithm>

namespace chdash {
namespace {

AccessSearchOutcome fallback(const std::string& host_id, const PdpCallContext& context, std::string reason) {
  log_event(LogLevel::Warn, "access.search_fallback", {{"request_id", context.request_id}, {"host", host_id}, {"reason", reason}});
  AccessSearchOutcome out;
  out.kind = AccessSearchKind::Fallback;
  out.reason = std::move(reason);
  return out;
}

} // namespace

AccessSearchOutcome access_search_databases(PdpClient& pdp, bool enabled, const std::string& service, const std::string& host_id,
                                            const std::string& subject, const std::vector<std::string>& actions, const PdpCallContext& context) {
  AccessSearchOutcome out;
  if (!enabled || subject.empty() || actions.empty() || host_id.empty() || !access_valid_id(host_id)) return out;
  // The search needs the endpoint of the metadata (AuthZEN 1.0, l.1296-1299: without it, the PDP is not capable of the search).
  if (pdp.endpoints().search_resource.empty()) return out;

  std::vector<std::string> names;
  for (const std::string& action : actions) {
    if (std::find(names.begin(), names.end(), action) == names.end()) names.push_back(action);
  }

  // Step 1: a grant on the host covers every database below it. A search returns only the ids that the PDP knows, so it could not show
  // this case. The questions are the same as the questions of the evaluations for the host.
  std::vector<AccessQuestion> questions;
  questions.reserve(names.size());
  for (const std::string& action : names) questions.push_back(AccessQuestion{action, access_host_resource(service, host_id), AccessMatch::Node});
  const std::vector<AccessDecision> decisions = pdp.decide(subject, questions, context);
  if (decisions.size() != questions.size()) return fallback(host_id, context, "the decisions of the host are not complete");
  for (const AccessDecision& decision : decisions) {
    if (decision.failed) return fallback(host_id, context, "a decision of the host failed");
  }
  for (const AccessDecision& decision : decisions) {
    if (decision.allowed) {
      out.kind = AccessSearchKind::Covered;
      return out;
    }
  }

  // Step 2: one search for each action. The chain is the one of a database: the service, then the host.
  const std::vector<AccessNode> chain = access_database_resource(service, host_id, "x").ancestors;
  for (const std::string& action : names) {
    const PdpSearchResult found = pdp.search_resources(subject, action, "database", chain, context);
    if (!found.ok) return fallback(host_id, context, "the search of " + action + " failed: " + found.error);
    // A cut result is the beginning of the set: a database that is not in it could still be allowed.
    if (found.truncated) return fallback(host_id, context, "the search of " + action + " is cut by a bound");
    for (const std::string& id : found.ids) out.ids.insert(id);
  }
  out.kind = AccessSearchKind::Ids;
  return out;
}

} // namespace chdash
