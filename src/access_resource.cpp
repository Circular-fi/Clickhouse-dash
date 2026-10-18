#include "access_resource.hpp"

#include "json_text.hpp"

namespace chdash {
namespace {

// The longest id of a node, in bytes (contract 11.4).
constexpr size_t kMaxIdBytes = 256;

bool unreserved(unsigned char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~';
}

} // namespace

AccessResource access_service_resource(const std::string& service_id) { return AccessResource{"service", service_id, {}}; }

AccessResource access_host_resource(const std::string& service_id, const std::string& host) {
  return AccessResource{"host", host, {AccessNode{"service", service_id}}};
}

AccessResource access_database_resource(const std::string& service_id, const std::string& host, const std::string& database) {
  return AccessResource{"database", database, {AccessNode{"service", service_id}, AccessNode{"host", host}}};
}

bool access_valid_id(std::string_view id) {
  if (id.empty() || id.size() > kMaxIdBytes) return false;
  if (!is_valid_utf8(id)) return false;
  for (size_t at = 0; at < id.size(); ++at) {
    const unsigned char c = static_cast<unsigned char>(id[at]);
    // The C0 controls and DEL. The C1 controls (U+0080 to U+009F) are the sequences C2 80 to C2 9F.
    if (c < 0x20 || c == 0x7F) return false;
    if (c == 0xC2 && at + 1 < id.size() && static_cast<unsigned char>(id[at + 1]) <= 0x9F) return false;
  }
  return true;
}

std::string access_encode_id(std::string_view id) {
  static constexpr char kHex[] = "0123456789ABCDEF";
  std::string out;
  out.reserve(id.size());
  for (const char raw : id) {
    const unsigned char c = static_cast<unsigned char>(raw);
    if (unreserved(c)) {
      out.push_back(raw);
    } else {
      out.push_back('%');
      out.push_back(kHex[c >> 4]);
      out.push_back(kHex[c & 0x0F]);
    }
  }
  return out;
}

std::string access_resource_path(const AccessResource& resource) {
  std::string out;
  for (const AccessNode& node : resource.ancestors) {
    if (!out.empty()) out.push_back('/');
    out += node.type;
    out.push_back(':');
    out += access_encode_id(node.id);
  }
  if (!out.empty()) out.push_back('/');
  out += resource.type;
  out.push_back(':');
  out += access_encode_id(resource.id);
  return out;
}

std::string access_resource_host(const AccessResource& resource) {
  if (resource.type == "host") return resource.id;
  for (const AccessNode& node : resource.ancestors) {
    if (node.type == "host") return node.id;
  }
  return {};
}

} // namespace chdash
