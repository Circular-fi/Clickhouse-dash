#include "ch_uri.hpp"

#include <algorithm>
#include <cstddef>
#include <cctype>
#include <sstream>

namespace chdash {
namespace {

static bool is_ascii_space(char c) {
  return c == ' ' || c == '\n' || c == '\r' || c == '\t';
}

static std::string trim_ascii(std::string_view s) {
  size_t b = 0;
  while (b < s.size() && is_ascii_space(s[b])) ++b;
  size_t e = s.size();
  while (e > b && is_ascii_space(s[e - 1])) --e;
  return std::string(s.substr(b, e - b));
}

static std::string to_lower(std::string s) {
  for (auto& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static std::string url_decode(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (c == '%' && i + 2 < s.size()) {
      int a = hex_val(s[i + 1]);
      int b = hex_val(s[i + 2]);
      if (a >= 0 && b >= 0) {
        out.push_back(static_cast<char>((a << 4) | b));
        i += 2;
        continue;
      }
    }
    if (c == '+') {
      out.push_back(' ');
    } else {
      out.push_back(c);
    }
  }
  return out;
}

static void parse_query(std::string_view qs, std::unordered_map<std::string, std::string>& out) {
  size_t i = 0;
  while (i < qs.size()) {
    size_t amp = qs.find('&', i);
    if (amp == std::string_view::npos) amp = qs.size();
    std::string_view part = qs.substr(i, amp - i);
    if (!part.empty()) {
      size_t eq = part.find('=');
      if (eq == std::string_view::npos) {
        out[url_decode(part)] = "";
      } else {
        out[url_decode(part.substr(0, eq))] = url_decode(part.substr(eq + 1));
      }
    }
    i = amp + 1;
  }
}

static bool parse_host_port(std::string_view hp, std::string& host, uint16_t& port, std::string* err) {
  host.clear();
  port = 9000;
  if (hp.empty()) {
    if (err) *err = "empty host";
    return false;
  }

  // IPv6 in []
  if (hp.front() == '[') {
    size_t end = hp.find(']');
    if (end == std::string_view::npos) {
      if (err) *err = "invalid ipv6 host";
      return false;
    }
    host = std::string(hp.substr(1, end - 1));
    if (end + 1 < hp.size()) {
      if (hp[end + 1] != ':') {
        if (err) *err = "invalid host:port";
        return false;
      }
      std::string_view ps = hp.substr(end + 2);
      if (!ps.empty()) {
        try {
          int p = std::stoi(std::string(ps));
          if (p <= 0 || p > 65535) throw std::out_of_range("port");
          port = static_cast<uint16_t>(p);
        } catch (...) {
          if (err) *err = "invalid port";
          return false;
        }
      }
    }
    return true;
  }

  // host:port
  size_t colon = hp.rfind(':');
  if (colon == std::string_view::npos) {
    host = std::string(hp);
    return true;
  }
  // If there are multiple ':' without [], treat as host (unlikely)
  if (hp.find(':') != colon) {
    host = std::string(hp);
    return true;
  }
  host = std::string(hp.substr(0, colon));
  std::string_view ps = hp.substr(colon + 1);
  if (!ps.empty()) {
    try {
      int p = std::stoi(std::string(ps));
      if (p <= 0 || p > 65535) throw std::out_of_range("port");
      port = static_cast<uint16_t>(p);
    } catch (...) {
      if (err) *err = "invalid port";
      return false;
    }
  }
  return true;
}

} // namespace


std::string redact_clickhouse_uri(const std::string& uri) {
  try {
    std::string out = uri;
    const size_t scheme = out.find("://");
    if (scheme == std::string::npos) return "<redacted-uri>";

    const size_t authority_begin = scheme + 3;
    const size_t authority_end = out.find_first_of("/?#", authority_begin);
    const size_t end = authority_end == std::string::npos ? out.size() : authority_end;
    const size_t at = out.rfind('@', end);
    if (at != std::string::npos && at >= authority_begin) {
      const size_t colon = out.find(':', authority_begin);
      if (colon != std::string::npos && colon < at) {
        out.replace(colon + 1, at - colon - 1, "***");
      }
    }

    const size_t query = out.find('?', authority_begin);
    if (query == std::string::npos) return out;

    size_t pos = query + 1;
    while (pos < out.size()) {
      const size_t amp = out.find('&', pos);
      const size_t item_end = amp == std::string::npos ? out.size() : amp;
      const size_t eq = out.find('=', pos);
      if (eq != std::string::npos && eq < item_end) {
        std::string key = to_lower(url_decode(std::string_view(out).substr(pos, eq - pos)));
        const bool sensitive = key == "password" || key == "passwd" ||
            key == "token" || key == "access_token" || key == "secret" ||
            key == "api_key" || key == "apikey";
        if (sensitive) {
          const size_t old_len = item_end - eq - 1;
          out.replace(eq + 1, old_len, "***");
          const std::ptrdiff_t delta = static_cast<std::ptrdiff_t>(3) - static_cast<std::ptrdiff_t>(old_len);
          if (amp == std::string::npos) break;
          pos = static_cast<size_t>(static_cast<std::ptrdiff_t>(amp + 1) + delta);
          continue;
        }
      }
      if (amp == std::string::npos) break;
      pos = amp + 1;
    }
    return out;
  } catch (...) {
    return "<redacted-uri>";
  }
}

bool query_param_truthy(const std::unordered_map<std::string, std::string>& q, const std::string& key, bool def) {
  auto it = q.find(key);
  if (it == q.end()) return def;
  std::string v = to_lower(it->second);
  if (v.empty()) return true;
  if (v == "1" || v == "true" || v == "yes" || v == "on") return true;
  if (v == "0" || v == "false" || v == "no" || v == "off") return false;
  return def;
}

std::optional<ParsedUri> parse_clickhouse_uri(const std::string& uri, std::string* err) {
  ParsedUri p;
  std::string_view s(uri);
  const std::string_view scheme_pfx = "clickhouse://";
  if (s.rfind(scheme_pfx, 0) != 0) {
    if (err) *err = "URI must start with clickhouse://";
    return std::nullopt;
  }
  p.scheme = "clickhouse";
  s.remove_prefix(scheme_pfx.size());

  // Split query
  std::string_view authority = s;
  std::string_view qs;
  size_t qpos = s.find('?');
  if (qpos != std::string_view::npos) {
    authority = s.substr(0, qpos);
    qs = s.substr(qpos + 1);
  }
  // Strip path if any
  size_t slash = authority.find('/');
  if (slash != std::string_view::npos) {
    authority = authority.substr(0, slash);
  }

  if (!qs.empty()) {
    parse_query(qs, p.query);
  }

  // userinfo@host:port
  std::string_view hostport = authority;
  size_t at = authority.rfind('@');
  if (at != std::string_view::npos) {
    std::string_view ui = authority.substr(0, at);
    hostport = authority.substr(at + 1);
    size_t colon = ui.find(':');
    if (colon == std::string_view::npos) {
      p.user = url_decode(ui);
      p.password = "";
    } else {
      p.user = url_decode(ui.substr(0, colon));
      p.password = url_decode(ui.substr(colon + 1));
    }
  }

  if (!parse_host_port(hostport, p.host, p.port, err)) {
    return std::nullopt;
  }
  if (p.host.empty()) {
    if (err) *err = "empty host";
    return std::nullopt;
  }
  return p;
}

std::optional<clickhouse::ClientOptions> client_options_from_uri(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout,
  std::string* err
) {
  const std::string u = trim_ascii(uri);
  auto pu = parse_clickhouse_uri(u, err);
  if (!pu) return std::nullopt;

  clickhouse::ClientOptions opt;
  opt.SetHost(pu->host);
  opt.SetPort(pu->port);
  if (!pu->user.empty()) opt.SetUser(pu->user);
  if (!pu->password.empty()) opt.SetPassword(pu->password);
  // Default database is intentionally "default". Users can always query db.table.
  opt.SetDefaultDatabase("default");

  // Timeouts
  opt.SetConnectionConnectTimeout(connect_timeout);
  opt.SetConnectionRecvTimeout(recv_timeout);
  opt.SetConnectionSendTimeout(send_timeout);

  // TLS via query params
  const bool secure = query_param_truthy(pu->query, "secure", false);
  if (secure) {
    clickhouse::ClientOptions::SSLOptions ssl;

    // verify=0 => skip verification
    const bool verify = query_param_truthy(pu->query, "verify", true);
    ssl.SetSkipVerification(!verify);

    auto it_ca = pu->query.find("ca");
    if (it_ca != pu->query.end() && !it_ca->second.empty()) {
      // Use provided CA file(s).
      ssl.SetUseDefaultCALocations(false);
      ssl.SetPathToCAFiles(std::vector<std::string>{it_ca->second});
    }

    auto it_cadir = pu->query.find("ca_dir");
    if (it_cadir != pu->query.end() && !it_cadir->second.empty()) {
      ssl.SetUseDefaultCALocations(false);
      ssl.SetPathToCADirectory(it_cadir->second);
    }

    // Optional: sni=0
    const bool use_sni = query_param_truthy(pu->query, "sni", true);
    ssl.SetUseSNI(use_sni);

    try {
      opt.SetSSLOptions(ssl);
    } catch (const std::exception& e) {
      if (err) *err = std::string("TLS requested but client SSL support is unavailable: ") + e.what();
      return std::nullopt;
    }
  }

  return opt;
}

std::shared_ptr<clickhouse::Client> make_client_from_uri(
  const std::string& uri,
  std::chrono::milliseconds connect_timeout,
  std::chrono::milliseconds recv_timeout,
  std::chrono::milliseconds send_timeout,
  std::string* err
) {
  auto opt = client_options_from_uri(uri, connect_timeout, recv_timeout, send_timeout, err);
  if (!opt) return nullptr;
  try {
    return std::make_shared<clickhouse::Client>(*opt);
  } catch (const std::exception& e) {
    if (err) *err = e.what();
    return nullptr;
  }
}

} // namespace chdash
