#pragma once

// This file defines what a request is for the code that serves it.
// It gives the caller, the route, the bounds that each ClickHouse statement of the request carries, and when to stop.
// A route handler is an adapter. It reads the parameters and writes the JSON.
// What a route handler needs to know about the caller is in this file, not in the request headers.
//
// The caller is the main point.
// A browser request has the caller Browser.
// An API tool call of MCP runs in the process, by the same handler, and has the caller Mcp.
// Only Server::call_route makes this context. No header or parameter from a client can claim it.
// The MCP identities (mcp_identity.hpp) are visible only to an Mcp context.
//
// The context is a property of the thread that serves the request.
// The RequestScope owns the context and the scope of the statements (ch_query.hpp, ChQueryScope).
// The statements of a request carry its limits for as long as the RequestScope lives.

#include "ch_query.hpp"

#include <functional>
#include <string>
#include <utility>

namespace chdash {

struct RequestContext {
  enum class Caller { Browser, Mcp };
  Caller caller = Caller::Browser;
  // The MCP key that made the call (its id). It is for the audit and for the label of the statements. It is empty for a browser.
  std::string caller_id;
  // The MCP tool that made the call. With the key, it is the query_id of the statements (mcp_cost.hpp). It is empty for a browser.
  std::string caller_tool;
  // agent.caller of the baggage of the MCP call (mcp_trace.hpp). It is already shortened for a label. It is empty when the call has none.
  std::string caller_agent;
  // The path of the route. It is the label of the statements and of the access log.
  std::string route;
  std::string request_id;
  // What each statement of the request carries. This is the label, the deadline, the memory and read bounds, and the stop.
  ChQueryLimits limits;

  bool is_mcp() const { return caller == Caller::Mcp; }
};

// The context of the request that this thread serves. Outside of every scope, it is a Browser context with no bounds.
const RequestContext& current_request_context();

// Makes `context` the context of this thread. Its limits become the limits of the statements until the scope ends. Scopes nest.
class RequestScope {
public:
  explicit RequestScope(RequestContext context);
  ~RequestScope();
  RequestScope(const RequestScope&) = delete;
  RequestScope& operator=(const RequestScope&) = delete;

  const RequestContext& context() const { return context_; }

private:
  RequestContext context_;
  RequestScope* previous_ = nullptr;
  ChQueryScope statements_;
  friend const RequestContext& current_request_context();
  static thread_local RequestScope* current_;
};

} // namespace chdash
