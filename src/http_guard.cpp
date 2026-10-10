#include "http_guard.hpp"

#include "jwt.hpp"
#include "secure_random.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>

namespace chdash {

namespace {

std::string lower_ascii(std::string_view s) {
  std::string out(s);
  for (auto& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

std::string_view trim_spaces(std::string_view s) {
  size_t b = 0;
  size_t e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t')) ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t')) --e;
  return s.substr(b, e - b);
}

// The authority (host[:port]) of an Origin header value, lower case; "" for "null" or a value without a scheme.
std::string origin_authority(std::string_view origin) {
  const auto scheme = origin.find("://");
  if (scheme == std::string_view::npos) return {};
  std::string_view authority = origin.substr(scheme + 3);
  if (const auto slash = authority.find('/'); slash != std::string_view::npos) authority = authority.substr(0, slash);
  return lower_ascii(authority);
}

size_t find_ci(std::string_view text, std::string_view needle, size_t from) {
  if (needle.empty() || text.size() < needle.size()) return std::string_view::npos;
  for (size_t at = from; at + needle.size() <= text.size(); ++at) {
    bool same = true;
    for (size_t i = 0; i < needle.size() && same; ++i) {
      same = std::tolower(static_cast<unsigned char>(text[at + i])) == std::tolower(static_cast<unsigned char>(needle[i]));
    }
    if (same) return at;
  }
  return std::string_view::npos;
}

// The value of attribute `name` of the attributes of a tag (lower case), or nullopt when the tag has none.
std::optional<std::string> tag_attribute(std::string_view attributes, std::string_view name) {
  const std::string text = lower_ascii(attributes);
  size_t at = 0;
  while ((at = text.find(name, at)) != std::string::npos) {
    const bool starts = at == 0 || std::isspace(static_cast<unsigned char>(text[at - 1]));
    size_t after = at + name.size();
    while (after < text.size() && std::isspace(static_cast<unsigned char>(text[after]))) ++after;
    const bool named = after >= text.size() || text[after] == '=' || text[after] == '/' ||
                       std::isspace(static_cast<unsigned char>(text[at + name.size()]));
    if (!starts || !named) {
      at += name.size();
      continue;
    }
    if (after >= text.size() || text[after] != '=') return std::string();
    size_t value = after + 1;
    while (value < text.size() && std::isspace(static_cast<unsigned char>(text[value]))) ++value;
    if (value < text.size() && (text[value] == '"' || text[value] == '\'')) {
      const char quote = text[value];
      const size_t end = text.find(quote, value + 1);
      return text.substr(value + 1, (end == std::string::npos ? text.size() : end) - value - 1);
    }
    size_t end = value;
    while (end < text.size() && !std::isspace(static_cast<unsigned char>(text[end])) && text[end] != '>') ++end;
    return text.substr(value, end - value);
  }
  return std::nullopt;
}

// A script element whose text the browser runs: no src, and no type or a JavaScript one (a JSON data block is not run).
bool runs_inline(std::string_view attributes) {
  if (tag_attribute(attributes, "src")) return false;
  const auto type = tag_attribute(attributes, "type");
  if (!type) return true;
  const std::string t(trim_spaces(*type));
  return t.empty() || t == "text/javascript" || t == "application/javascript" || t == "module";
}

std::string base64(const uint8_t* data, size_t n) {
  static constexpr char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((n + 2) / 3 * 4);
  for (size_t i = 0; i < n; i += 3) {
    const uint32_t chunk = (static_cast<uint32_t>(data[i]) << 16) |
                           (i + 1 < n ? static_cast<uint32_t>(data[i + 1]) << 8 : 0u) |
                           (i + 2 < n ? static_cast<uint32_t>(data[i + 2]) : 0u);
    out.push_back(kAlphabet[(chunk >> 18) & 63]);
    out.push_back(kAlphabet[(chunk >> 12) & 63]);
    out.push_back(i + 1 < n ? kAlphabet[(chunk >> 6) & 63] : '=');
    out.push_back(i + 2 < n ? kAlphabet[chunk & 63] : '=');
  }
  return out;
}

bool request_id_character(char c) {
  return std::isalnum(static_cast<unsigned char>(c)) || c == '.' || c == '_' || c == ':' || c == '-';
}

} // namespace

bool is_cross_site_request(const httplib::Request& req) {
  const std::string site = lower_ascii(trim_spaces(req.get_header_value("Sec-Fetch-Site")));
  if (!site.empty()) return site != "same-origin" && site != "none";
  // A copy: trim_spaces returns a view, and get_header_value a temporary.
  const std::string origin(trim_spaces(req.get_header_value("Origin")));
  if (origin.empty()) return false;
  const std::string authority = origin_authority(origin);
  const std::string host = lower_ascii(trim_spaces(req.get_header_value("Host")));
  std::string forwarded = req.get_header_value("X-Forwarded-Host");
  if (const auto comma = forwarded.find(','); comma != std::string::npos) forwarded.resize(comma);
  forwarded = lower_ascii(trim_spaces(forwarded));
  return authority.empty() || (authority != host && (forwarded.empty() || authority != forwarded));
}

std::string request_media_type(const httplib::Request& req) {
  std::string type = req.get_header_value("Content-Type");
  if (const auto semi = type.find(';'); semi != std::string::npos) type.resize(semi);
  return lower_ascii(trim_spaces(type));
}

bool request_has_body(const httplib::Request& req) {
  if (req.has_header("Transfer-Encoding")) return true;
  const std::string length(trim_spaces(req.get_header_value("Content-Length")));
  return !length.empty() && length.find_first_not_of('0') != std::string::npos;
}

std::optional<RequestRefusal> check_browser_write(const httplib::Request& req) {
  if (is_cross_site_request(req)) {
    return RequestRefusal{403, "cross_site_request", "ChDash accepts this request from its own pages only"};
  }
  if (request_has_body(req) && request_media_type(req) != "application/json") {
    return RequestRefusal{415, "unsupported_media_type", "the request body must be application/json"};
  }
  return std::nullopt;
}

const char* const kContentSecurityPolicy =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; "
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

httplib::Headers security_headers() {
  return {
      {"Content-Security-Policy", kContentSecurityPolicy},
      {"X-Content-Type-Options", "nosniff"},
      {"X-Frame-Options", "DENY"},
      {"Referrer-Policy", "same-origin"},
      {"Cross-Origin-Resource-Policy", "same-origin"},
  };
}

std::string page_content_security_policy(std::string_view html) {
  std::string hashes;
  size_t at = 0;
  while ((at = find_ci(html, "<script", at)) != std::string_view::npos) {
    const size_t name_end = at + 7;
    if (name_end >= html.size()) break;
    const char next = html[name_end];
    if (next != '>' && next != '/' && !std::isspace(static_cast<unsigned char>(next))) {
      at = name_end;
      continue;
    }
    const size_t tag_end = html.find('>', name_end);
    if (tag_end == std::string_view::npos) break;
    const size_t close = find_ci(html, "</script", tag_end + 1);
    if (close == std::string_view::npos) break;
    if (runs_inline(html.substr(name_end, tag_end - name_end))) {
      const std::string_view body = html.substr(tag_end + 1, close - tag_end - 1);
      const auto digest = sha256_digest(reinterpret_cast<const uint8_t*>(body.data()), body.size());
      hashes += " 'sha256-" + base64(digest.data(), digest.size()) + "'";
    }
    at = close + 8;
  }
  std::string policy = kContentSecurityPolicy;
  static const std::string marker = "'wasm-unsafe-eval'";
  policy.insert(policy.find(marker) + marker.size(), hashes);
  return policy;
}

void set_page_security_policy(httplib::Response& res, std::string_view html) {
  res.headers.erase("Content-Security-Policy");
  res.set_header("Content-Security-Policy", page_content_security_policy(html));
}

bool asset_version_matches(std::string_view version, std::string_view content_hash) {
  if (version.size() < 8 || version.size() > 64 || version.size() > content_hash.size()) return false;
  for (const char c : version) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return content_hash.compare(0, version.size(), version) == 0;
}

std::string request_id_for(const httplib::Request& req) {
  const std::string given = req.get_header_value("X-Request-Id");
  if (!given.empty() && given.size() <= 128 && std::all_of(given.begin(), given.end(), request_id_character)) return given;
  return random_hex(8);
}

} // namespace chdash
