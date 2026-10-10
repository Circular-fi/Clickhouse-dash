#include "mcp_identity.hpp"

#include <cstdint>

namespace chdash {

std::string mcp_api_host(std::string_view host, McpIdentity identity) {
  std::string out(host);
  if (identity == McpIdentity::Runner) out.append(kMcpRunnerSuffix);
  return out;
}

std::string_view mcp_base_host(std::string_view host_id) {
  if (host_id.size() > kMcpRunnerSuffix.size() &&
      host_id.compare(host_id.size() - kMcpRunnerSuffix.size(), kMcpRunnerSuffix.size(), kMcpRunnerSuffix) == 0) {
    host_id.remove_suffix(kMcpRunnerSuffix.size());
  }
  return host_id;
}

std::string mcp_strip_identity(std::string body) {
  // In JSON text the control character is written \u001f or \u001F (RapidJSON), or is there as it is.
  for (const char* control : {"\\u001f", "\\u001F", "\x1f"}) {
    const std::string suffix = std::string(control) + "mcp";
    for (size_t at = body.find(suffix); at != std::string::npos; at = body.find(suffix, at)) body.erase(at, suffix.size());
  }
  return body;
}

} // namespace chdash
