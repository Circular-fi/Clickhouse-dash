#pragma once

// The identity mode of the MCP endpoint (docs/mcp.md, "The identity mode"; ProcurAuth MCP binding 3 to 5): the subject of each request
// comes from the identity token, and the PDP decides each request for this subject. The service has no key of its own then.
//   - A request with no tool asks mcp.session on the service (binding 3.6a).
//   - tools/list asks one question for each action of the tools, on the service, with the match "subtree" (binding 4.1).
//   - tools/call asks the action of the tool on the resource that the arguments name: the host, or the database of the host (binding 3.2).
// The subject is opaque: it can be a person or a key of the portal ("key:..."). The code reads no meaning from it.
// Pure code: the decisions come from a function that the server gives (PdpClient::decide), so the tests use fakes.

#include "access_actions.hpp"
#include "access_pdp.hpp"
#include "mcp_protocol.hpp"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// The virtual key of the request of a subject. It is not in the store of the keys. Its id is "sub_" and 24 hexadecimal digits of the
// SHA-256 of the subject, so the usage, the rate limit and the log label of a subject are safe text. Its name is the subject, cut and
// cleaned. It holds every tool that the catalog allows to a key (the PDP decides), every host and the whole data scope: the identity
// mode has no scope of its own (a pattern of a table, a wildcard and a list of tools exist only in the keys of ChDash).
McpKey mcp_identity_key(const std::string& subject);

// The action that a tool asks in the identity mode. It is the action of the access of humans (mcp_tool_access_action). The tools
// that have no such action, list_hosts and the analysis of the key itself, ask mcp.session. "unknown" for a route without a rule.
const char* mcp_tool_identity_action(const McpToolInfo& tool);

class McpSubjectAccess {
public:
  using Decide = std::function<std::vector<AccessDecision>(const std::string& subject, const std::vector<AccessQuestion>& questions)>;

  // `service_id` is the id of the service resource (access.identity.audience). `hosts` are the hosts that MCP reaches (the hosts with
  // mcp_uri): a host that is not in this list is never sent to the PDP as a host. `features` give the published actions.
  McpSubjectAccess(std::string service_id, std::vector<std::string> hosts, AccessFeatures features, Decide decide);

  // mcp.session on the service. One question.
  McpAccess session(const std::string& subject);
  // The tools of `tools` whose action is published and true. One batch: one item for each action, on the service, match "subtree".
  // nullopt when one decision failed.
  std::optional<std::vector<std::string>> list(const std::string& subject, std::vector<std::string> tools);
  // The question of a call, or nullopt when the action of the tool is not published. The host and the database come from the
  // arguments; a host that is missing or unknown sends the question to the service (a missing host asks "subtree": the tool then
  // gives host_required without a read).
  std::optional<AccessQuestion> call_question(const McpToolInfo& tool, const rapidjson::Value& arguments) const;
  // The decision of a call. For Allowed, `call` receives the ceilings (the lowest of the actions of the tool) and, for list_hosts, the
  // hosts that the person can see. A true answer with a ceiling that MCP cannot apply is Denied (ProcurAuth 7.5).
  McpAccess call(const std::string& subject, const McpToolInfo& tool, const rapidjson::Value& arguments, McpCallInfo* call);

private:
  // The hosts that the decisions of the navigation show.
  std::optional<std::vector<std::string>> visible_hosts(const std::string& subject);

  std::string service_id_;
  std::vector<std::string> hosts_;
  AccessFeatures features_;
  Decide decide_;
};

// The backend of one request in the identity mode: the checks of McpSubjectAccess for the subject of the request, and the tools of `inner`.
class McpSubjectTools final : public McpToolBackend {
public:
  McpSubjectTools(McpToolBackend& inner, McpSubjectAccess& access) : inner_(inner), access_(access) {}

  McpToolAvailability availability() const override { return inner_.availability(); }
  McpToolOutcome call_tool(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments, int64_t now) override {
    return inner_.call_tool(key, tool, arguments, now);
  }
  McpToolOutcome call_tool_for(const McpKey& key, const std::string& tool, const rapidjson::Value& arguments, int64_t now,
                               const McpCallInfo& info) override {
    return inner_.call_tool_for(key, tool, arguments, now, info);
  }
  std::optional<std::vector<std::string>> permitted_tools(const McpKey& key, std::vector<std::string> tools) override {
    return access_.list(key.subject, inner_.permitted_tools(key, std::move(tools)).value_or(std::vector<std::string>()));
  }
  McpAccess tool_permitted(const McpKey& key, const McpToolInfo& tool, const rapidjson::Value& arguments, McpCallInfo* call) override {
    return access_.call(key.subject, tool, arguments, call);
  }
  McpAccess session_permitted(const McpKey& key) override { return access_.session(key.subject); }

private:
  McpToolBackend& inner_;
  McpSubjectAccess& access_;
};

} // namespace chdash
