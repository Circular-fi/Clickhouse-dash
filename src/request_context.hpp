#pragma once

// What a request is, for the code that serves it: who asked, which route, the bounds that each ClickHouse statement of the
// request carries, and when to stop. A route handler is an adapter (it reads the parameters and writes the JSON); what it needs
// to know about the caller is here, not in the headers of the request.
//
// The caller is the point. A request of a browser is a Browser. A call of an API tool of MCP is run in the process, by the
// same handler, and is an Mcp: its context is made by that call (Server::call_route) and never by anything that a
// client sent, so no header or parameter can claim it. The identities of MCP (mcp_identity.hpp) are visible to an Mcp
// context only.
//
// The context is a property of the thread that serves the request, like the scope of the statements (ch_query.hpp,
// ChQueryScope), which it owns: the statements of a request carry its limits for as long as the RequestScope lives.

#include "ch_query.hpp"

#include <functional>
#include <string>
#include <utility>

namespace chdash {

struct RequestContext {
  enum class Caller { Browser, Mcp };
  Caller caller = Caller::Browser;
  // The key of MCP that made the call (its id), for the audit and the label of the statements; empty for a browser.
  std::string caller_id;
  // The path of the route (the label of the statements, the access log).
  std::string route;
  std::string request_id;
  // What each statement of the request carries: label, deadline, memory and read bounds, and the stop.
  ChQueryLimits limits;

  bool is_mcp() const { return caller == Caller::Mcp; }
};

// The context of the request that this thread serves; a Browser context with no bounds outside of every scope.
const RequestContext& current_request_context();

// Makes `context` the context of this thread, and its limits the limits of the statements, until the scope ends. Scopes nest.
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
