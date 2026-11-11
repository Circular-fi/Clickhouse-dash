#pragma once

// The approval of an action by a person (ProcurAuth section 17, MCP binding 3.5a, 5.7, 5.7a and 5.7b; docs/access.md, "Approval of an action").
//
// The capability is on for EVERY tool of the identity mode of MCP (mcp.auth_mode = "identity"): the PDP decides, for each grant, whether a use
// needs the approval of the owner of the key (the property `confirm`). ChDash never knows in advance. It handles the reasons of ProcurAuth
// 17.1 for any action that it asks about. The code is in one place, McpApprovalGate, which McpSubjectAccess::call uses for each call of a tool.
//
// Two tools belong to the flow and are not in mcp_tool_catalog() (the page of the keys never lists them):
//   run_write_query    The action query.run.write, on the host. It runs exactly one statement that changes data, with the write account of the
//                      host (mcp_write_uri). It exists only for a host that has this account.
//   get_action_status  The verdict of a request: pending, approved, denied or void. It asks the PDP no question and it takes no unit.
//
// The flow of one call of any tool (protocol 17.7, the lazy flow). The PEP is stateless: the agent calls the tool again after the approval.
//   1. The control arguments are read (approval_ref, lease_s, until, wait_s, supersedes: all optional, at most one of the first three). A bad
//      one asks the PDP nothing.
//   2. The question of 10.1, with no effect. It is the only question of a call that needs no approval. `true` runs the tool.
//   3. Only on a reason of 17.1 (approval_required): the call needs one of the controls (else the tool error invalid_argument). ChDash builds the
//      op and the view from the arguments of the call, computes the effect (approval_effect.hpp) and asks again, with the effect and without
//      usage. After `true` (an approval that can be used), it asks with usage and the effect; only a true answer to this question runs the tool.
//   4. approval_required or approval_pending: the request goes to the approval API with the evaluation_id of the answer, and the call gives the
//      result "awaiting_approval" (not an error, executed false). approval_denied and approval_expired are tool errors; nothing is sent after
//      them. 409 no_device is approval_unavailable, 429 is approval_rate_limited; another failure of the approval API gives HTTP 503.
// The PEP learns the request id, the code and the verdict. It never reads an explanation, a comment of a refusal, the approver or the device,
// and it sends no text of the agent except the control arguments.
// Pure code: the PDP and the ClickHouse call are behind functions that the server gives, so the tests use fakes.

#include "access_actions.hpp"
#include "access_pdp.hpp"
#include "mcp_access.hpp"
#include "mcp_protocol.hpp"
#include "mcp_scope.hpp"

#include <rapidjson/document.h>

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace chdash {

inline constexpr const char* kMcpWriteTool = "run_write_query";
inline constexpr const char* kMcpStatusTool = "get_action_status";
inline constexpr const char* kMcpExportTool = "export_query";
inline constexpr const char* kMcpWriteAction = "query.run.write";

// The two tools, in the order of tools/list. A tool is found only in the identity mode, and only when the server offers the approvals.
const std::vector<McpToolInfo>& mcp_approval_tools();
const McpToolInfo* mcp_find_approval_tool(std::string_view name);
// The JSON Schema of the arguments of an approval tool, with the host as a required argument (the identity mode).
const char* mcp_approval_tool_schema(std::string_view tool);
// The annotations of tools/list for an approval tool (the title and the hints of binding 5.7b and of the plan).
std::string mcp_approval_tool_annotations(const McpToolInfo& tool);

// The control arguments of a call (binding 5.7): approval_ref, lease_s, until, wait_s and supersedes.
struct McpApprovalControls {
  bool present = false;  // at least one of approval_ref, lease_s and until
  PdpApprovalRequest::Control control = PdpApprovalRequest::Control::LeaseSeconds;
  std::string text;      // approval_ref or until
  uint64_t lease_seconds = 0;
  std::optional<uint64_t> wait_seconds;
  std::string supersedes;
};
// false when a control argument is bad: more than one of the three, a member with the wrong type, a text that is empty or longer than 512
// bytes, lease_s below 1, wait_s below 0. The tool then gives the error invalid_argument and asks the PDP nothing. A call with no control
// argument is valid: `present` is false, and the call needs one only when the PDP asks for an approval.
bool mcp_split_approval_controls(const rapidjson::Value& arguments, McpApprovalControls* out);

// The names of the control arguments: they never enter the op (ProcurAuth 17.9a).
bool mcp_is_approval_control(std::string_view name);
// The arguments of a call without the control arguments, as a JSON object. For a tool that runs the call, so that its own check of the
// arguments does not see them.
std::string mcp_arguments_without_controls(const rapidjson::Value& arguments);
// The control properties that tools/list adds to the schema of each tool of the identity mode.
std::string mcp_with_approval_properties(const std::string& schema_json);

// The op and the view of a call (ProcurAuth 17.3, 17.9). `ok` false: the arguments cannot be an op (a text that is not UTF-8). The view holds
// only JSON Pointers to values of the op and fixed texts of the service.
//   run_write_query   op {tool, host, sql, ch_user}; view title "ClickHouse write", fields Host and Runs as, body /sql labelled SQL.
//   run_query, explain_query   op {tool, host, sql, ch_user} and options (the text of the other arguments), view body /sql.
//   any other tool    op {tool, host (when the call has one), arguments}: `arguments` is the compact text of the arguments, with the members
//                     in sorted order; view body /arguments labelled Arguments.
struct McpOpView {
  bool ok = false;
  std::string op_json;
  std::string view_json;
};
struct McpApprovalHost {
  std::string id;
  std::string read_user;   // the user of mcp_uri
  std::string write_user;  // the user of mcp_write_uri; empty: the host has no write tool
};
McpOpView mcp_op_view(const McpToolInfo& tool, const McpApprovalHost* host, const rapidjson::Value& arguments_without_controls,
                      std::string_view write_sql);

// The tool errors of the approval (binding 5.7a). The message is fixed: it holds no value of the request and no text of the PDP.
McpToolOutcome mcp_approval_error(const std::string& code, uint64_t retry_after = 0);
// The result "the action waits" (binding 5.7): not an error. content[0] and structuredContent have {"action": {...}}, content[1] starts with
// NOT EXECUTED.
McpToolOutcome mcp_approval_awaiting(const std::string& request_id, const std::string& code);
// The result of get_action_status: {"status": <verdict>}.
McpToolOutcome mcp_approval_status(PdpVerdict verdict);

// The check of the statement of a write. The statement is one of INSERT, CREATE, ALTER, DROP, TRUNCATE, OPTIMIZE, RENAME, EXCHANGE,
// ATTACH, DETACH, UNDROP, DELETE, UPDATE, or WITH ... INSERT. Access control (USER, ROLE, QUOTA, ROW POLICY, SETTINGS PROFILE) and named
// collections are refused. A statement that only reads is refused too: it needs no approval, so run_query runs it.
// `ok` false: `error` is a code (empty_sql, invalid_sql, multiple_statements, statement_not_allowed, clause_not_allowed, function_not_allowed,
// not_a_write) and `message` a sentence that holds no text of the request.
struct McpWriteScan {
  bool ok = false;
  std::string error;
  std::string message;
  std::string statement;  // the statement without its closing ";": the text that will run
};
McpWriteScan mcp_scan_write_statement(std::string_view sql);

struct McpApprovalConfig {
  // The id of the service (access.identity.audience).
  std::string service_id;
  // The hosts that MCP reaches (the hosts with mcp_uri).
  std::vector<McpApprovalHost> hosts;
  // access.approval.max_command_bytes and access.approval.wait.
  int64_t max_command_bytes = 16 * 1024;
  int64_t wait_cap_seconds = 15;
  // mcp.max_sql_bytes.
  int64_t max_sql_bytes = 65536;
};

// What the PDP gives to the flow. Each function keeps the rules of PdpClient (no cache for a question with an effect, no second try of a use).
struct McpApprovalPorts {
  // PdpClient::decide_approval.
  std::function<AccessDecision(const std::string& subject, const AccessQuestion& question, bool usage, bool units_optional)> ask;
  // PdpClient::approval_submit and approval_verdict.
  std::function<PdpApprovalReply(const PdpApprovalRequest& request)> submit;
  std::function<PdpApprovalReply(const std::string& request_id, const std::string& subject, uint64_t wait_seconds, bool renew)> verdict;
};

// The result of the gate for one call.
struct McpGateResult {
  // Allowed: `decision` is the answer to the question with usage (the caller applies its ceilings) and the tool runs. Another value is the
  // result of the call at the access stage: Denied (-32602), Failed (HTTP 503), BudgetExceeded (info->retry_after), or Allowed with
  // `info->answered` (the awaiting result, the verdict, or a tool error: the call is over).
  McpAccess access = McpAccess::Denied;
  bool run = false;
  // The first question had no reason of 17.1: `decision` is its answer and the caller applies it as 10.1 and 10.3 say (it runs the tool on
  // `true`). Without an approval, a call costs this one question.
  bool pass = false;
  AccessDecision decision;
};

class McpApprovalGate {
public:
  McpApprovalGate(McpApprovalConfig config, McpApprovalPorts ports);

  // The tools of the flow that the server offers, in the order of tools/list: run_write_query when a host has a write account, then
  // get_action_status.
  std::vector<std::string> tool_names() const;
  const McpApprovalHost* host_of(std::string_view id) const;

  // One call of `tool` whose question is `question` (the match "node"). `budget`: the action lists a budget. For run_write_query the gate
  // checks the host and the statement first, and sets info->approved_sql for a call that runs.
  // `first` asks the question of 10.1 with no effect (a use of an action that lists a budget has context.usage) and gives its answer. The gate
  // calls it after the checks of the arguments and before any other question.
  McpGateResult call(const std::string& subject, const McpToolInfo& tool, const AccessQuestion& question, bool budget,
                     const rapidjson::Value& arguments, McpCallInfo* info, const std::function<AccessDecision()>& first);
  // get_action_status: GET the verdict with renew=true and the subject of the token. No PDP question.
  McpAccess status(const std::string& subject, const rapidjson::Value& arguments, McpCallInfo* info);

private:
  McpApprovalConfig config_;
  McpApprovalPorts ports_;
};

} // namespace chdash
