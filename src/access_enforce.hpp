#pragma once

// ProcurAuth 7.5 for the decisions of the PDP: a true decision with a ceiling that ChDash cannot apply is false.
// The rule applies to the questions that guard an operation. It never applies to a question of the navigation (the match "subtree"):
// that question runs no operation, so a ceiling never hides a page, a host or a database.

#include "access_actions.hpp"
#include "access_pdp.hpp"

#include <functional>
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

// The use of a run of SQL (ProcurAuth 6.4, 10.1; docs/access.md, "Budgets"), as pure logic over the two functions that ask the PDP. A person
// can hold query.run.read, query.run.write or both, and one of them is enough. The class of the SQL gives the action of the use:
// query.run.read for a read, else query.run.write (a write, or an SQL that the code does not know). The other action is not a required
// permission: it gives readonly and the ceilings of the other class.
//   1. `ask_use(first)`: the action of the use, with context.usage. It takes the unit. No question without usage comes before it: the case
//      U04 of the ProcurAuth runner answers only the question with usage, and 10.1 forbids the same question without it.
//   2. When it is true: `ask(second)`, the other action without context.usage. A failure gives 503 (the unit stays counted).
//   3. When it is a plain false (no budget_exceeded, no failure, no true answer that was turned false, no true answer without units):
//      `ask_use(second)`. The PEP chooses the action of the use in its order of preference (10.1). It never asks the second action after
//      an answer that took a unit.
//   4. Any other answer refuses the run: budget_exceeded gives 429, a failure 503, a denial 403.
// `ask_use` gives *pdp_true = true when the PDP answered true (it took the unit), also when the server then turned the answer false
// because of a ceiling that it cannot apply (7.5).
struct AccessRunUse {
  bool allowed = false;
  // When not allowed: the decision that gives the status of the refusal (access_refusal_of: a failure, then budget_exceeded, then 403).
  AccessDecision refusal;
  // The action that took the unit, or the action that the refusal names.
  std::string action;
  // When allowed: the decisions of the two actions, and readonly = 1 without query.run.write.
  AccessRunCeilings ceilings;
  bool read_only = true;
};
AccessRunUse access_run_use(SqlStatementClass sql_class, const std::function<AccessDecision(const std::string& action)>& ask,
                            const std::function<AccessDecision(const std::string& action, bool* pdp_true)>& ask_use);

}  // namespace chdash
