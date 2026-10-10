#pragma once

#include "health_runner.hpp"
#include "mcp_identity.hpp"
#include "request_context.hpp"

#include <httplib.h>

#include <string>
#include <vector>

namespace chdash {

inline const HostSpec* find_host(const std::vector<HostSpec>& hosts, const std::string& id) {
  for (const auto& h : hosts) {
    if (h.id == id) return &h;
  }
  return nullptr;
}

// The host that a request names. A host of the configuration is found as usual. The identities of MCP (an id
// with the suffix of mcp_identity.hpp) are found only for a call of an API tool (the context of the request says Mcp,
// request_context.hpp): for any other request they do not exist. A request that names no host of its own never gets them.
template <typename Config>
const HostSpec* find_request_host(const Config& cfg, const httplib::Request&, const std::string& id) {
  if (id.find('\x1f') != std::string::npos) {
    if (!current_request_context().is_mcp()) return nullptr;
    return find_host(cfg.mcp_hosts, id);
  }
  return find_host(cfg.hosts, id);
}

inline bool is_host_healthy(const HealthRunner* runner, const std::string& host_id) {
  if (!runner) return true;
  const HostsSnapshot snap = runner->snapshot();
  for (const auto& h : snap.hosts) {
    if (h.id == host_id) return h.healthy;
  }
  return true;
}

} // namespace chdash
