#pragma once

// ProcurAuth 7.5 for the decisions of the PDP: a true decision with a ceiling that ChDash cannot apply is false.
// The rule applies to the questions that guard an operation. It never applies to a question of the navigation (the match "subtree"):
// that question runs no operation, so a ceiling never hides a page, a host or a database.

#include "access_actions.hpp"
#include "access_pdp.hpp"

#include <string>
#include <vector>

namespace chdash {

// Change in `decisions` each true decision of an operation whose ceilings ChDash cannot apply: it becomes a false decision with no reason,
// no ceiling and no units (a denial). The log has the line access.ceiling_unenforceable with the action, the resource and the ceiling.
// ChDash applies the ceilings that the document declares for the action of the question (access_ceilings_enforceable). With `can_apply`
// false (a path that applies no ceiling, the MCP keys of the page) every ceiling is refused. A question with the match "subtree" is not
// changed. `decisions` and `questions` have the same order.
void access_enforce_ceilings(const std::string& request_id, const std::vector<AccessQuestion>& questions,
                             std::vector<AccessDecision>* decisions, const AccessFeatures& features, bool can_apply);

}  // namespace chdash
