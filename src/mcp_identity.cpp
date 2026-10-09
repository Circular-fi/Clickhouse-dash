#include "mcp_identity.hpp"

#include <cstdint>
#include <random>

namespace chdash {

const std::string& mcp_internal_token() {
  static const std::string token = [] {
    std::random_device device;
    static constexpr char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(32);
    for (int i = 0; i < 32; ++i) out.push_back(kHex[device() & 0xF]);
    return out;
  }();
  return token;
}

bool mcp_internal_token_matches(std::string_view text) {
  const std::string& token = mcp_internal_token();
  if (text.size() != token.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < token.size(); ++i) diff |= static_cast<unsigned char>(text[i] ^ token[i]);
  return diff == 0;
}

std::string mcp_api_host(std::string_view host, McpIdentity identity) {
  std::string out(host);
  if (identity == McpIdentity::Runner) out.append(kMcpRunnerSuffix);
  else if (identity == McpIdentity::Otel) out.append(kMcpOtelSuffix);
  return out;
}

std::string mcp_strip_identity(std::string body) {
  // In JSON text the control character is written \u001f or \u001F (RapidJSON), or is there as it is.
  for (const char* control : {"\\u001f", "\\u001F", "\x1f"}) {
    for (const char* name : {"mcp-otel", "mcp"}) {
      const std::string suffix = std::string(control) + name;
      for (size_t at = body.find(suffix); at != std::string::npos; at = body.find(suffix, at)) body.erase(at, suffix.size());
    }
  }
  return body;
}

} // namespace chdash
