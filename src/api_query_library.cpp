// REST handlers of the server-side query library (docs/query-library.md).
//
// Routes exist only when query_library.enabled = true (404 otherwise), and the
// history routes only when query_library.history.store = "server". This file
// never executes SQL: saved and historical SQL is stored and returned verbatim.
// Request paths only select an entity id; the filesystem path is the
// configured query_library.file.

#include "server.hpp"

#include "api_error.hpp"

#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <string>
#include <string_view>

namespace chdash {
namespace {

std::string lower_ascii(std::string s) {
  for (auto& c : s) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return s;
}

std::string trim_spaces(std::string_view s) {
  size_t b = 0;
  size_t e = s.size();
  while (b < e && (s[b] == ' ' || s[b] == '\t')) ++b;
  while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t')) --e;
  return std::string(s.substr(b, e - b));
}

void library_error(httplib::Response& res, int status, const char* code, const std::string& message) {
  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("error"); w.String(code);
  w.Key("error_code"); w.String(code);
  w.Key("message"); w.String(message.c_str(), static_cast<rapidjson::SizeType>(message.size()));
  w.EndObject();
  res.status = status;
  res.set_header("Cache-Control", "no-store");
  res.set_content(sb.GetString(), "application/json");
}

// The authority (host[:port]) of an Origin header value, lower-cased.
std::string origin_authority(const std::string& origin) {
  const auto scheme = origin.find("://");
  if (scheme == std::string::npos) return {};
  std::string authority = origin.substr(scheme + 3);
  const auto slash = authority.find('/');
  if (slash != std::string::npos) authority.resize(slash);
  return lower_ascii(authority);
}

// Cross-site request guard for every mutating library route. ChDash has no
// end-user authentication (README "Authorization model"), so the only thing a
// library write needs protecting from is a third-party page driving the
// user's browser:
// - Sec-Fetch-Site (set by the browser, not by page script) must be absent,
//   "same-origin" or "none";
// - without Sec-Fetch-Site, an Origin header must name this server (Host or
//   X-Forwarded-Host);
// - a request body must be application/json, which a cross-origin page can
//   only send after a CORS preflight that ChDash never grants.
bool allow_mutation(const httplib::Request& req, httplib::Response& res, bool has_body) {
  const std::string site = lower_ascii(trim_spaces(req.get_header_value("Sec-Fetch-Site")));
  if (!site.empty() && site != "same-origin" && site != "none") {
    library_error(res, 403, "cross_site_request", "query library changes are accepted from the ChDash page only");
    return false;
  }
  const std::string origin = trim_spaces(req.get_header_value("Origin"));
  if (site.empty() && !origin.empty()) {
    const std::string authority = origin_authority(origin);
    const std::string host = lower_ascii(trim_spaces(req.get_header_value("Host")));
    std::string forwarded = req.get_header_value("X-Forwarded-Host");
    if (const auto comma = forwarded.find(','); comma != std::string::npos) forwarded.resize(comma);
    forwarded = lower_ascii(trim_spaces(forwarded));
    if (authority.empty() || (authority != host && authority != forwarded)) {
      library_error(res, 403, "cross_site_request", "query library changes are accepted from the ChDash page only");
      return false;
    }
  }
  if (has_body) {
    std::string type = req.get_header_value("Content-Type");
    if (const auto semi = type.find(';'); semi != std::string::npos) type.resize(semi);
    if (lower_ascii(trim_spaces(type)) != "application/json") {
      library_error(res, 415, "unsupported_media_type", "the request body must be application/json");
      return false;
    }
  }
  return true;
}

const std::string* optional_header(const httplib::Request& req, const char* name, std::string& storage) {
  if (!req.has_header(name)) return nullptr;
  storage = req.get_header_value(name);
  return &storage;
}

const std::string* optional_param(const httplib::Request& req, const char* name, std::string& storage) {
  if (!req.has_param(name)) return nullptr;
  storage = req.get_param_value(name);
  return &storage;
}

void send(httplib::Response& res, const QueryLibraryStore::Response& out) {
  res.status = out.status;
  res.set_header("Cache-Control", "no-store");
  res.set_content(out.body, "application/json");
}

} // namespace

void Server::handle_query_library(const httplib::Request& req, httplib::Response& res, QueryLibraryRoute route) {
  if (!query_library_) {
    library_error(res, 404, "not_found", "the query library is disabled");
    return;
  }
  QueryLibraryStore& store = *query_library_;
  const bool has_body = route == QueryLibraryRoute::HistoryAppend || route == QueryLibraryRoute::FolderCreate ||
                        route == QueryLibraryRoute::FolderUpdate || route == QueryLibraryRoute::QueryCreate ||
                        route == QueryLibraryRoute::QueryUpdate || route == QueryLibraryRoute::Import;
  const bool mutating = route != QueryLibraryRoute::Get && route != QueryLibraryRoute::HistoryList;
  if (mutating && !allow_mutation(req, res, has_body)) return;
  if (has_body && req.body.size() > store.options().max_file_bytes + 64 * 1024) {
    library_error(res, 413, "too_large", "the request body exceeds query_library.max_file_bytes");
    return;
  }

  std::string if_match_storage;
  const std::string* if_match = optional_header(req, "If-Match", if_match_storage);
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  // The library, its folders and its history are per host: the reads and the
  // history clear name it (?host_id=), the other writes in their body.
  std::string host_storage;
  const std::string* host_id = optional_param(req, "host_id", host_storage);

  switch (route) {
    case QueryLibraryRoute::Get:
      send(res, store.get_library(host_id));
      return;
    case QueryLibraryRoute::HistoryList: {
      std::string limit, before_ms, before_id, q;
      send(res, store.list_history(host_id, optional_param(req, "limit", limit), optional_param(req, "before_ms", before_ms),
                                   optional_param(req, "before_id", before_id), optional_param(req, "q", q)));
      return;
    }
    case QueryLibraryRoute::HistoryAppend:
      send(res, store.append_history(req.body, if_match));
      return;
    case QueryLibraryRoute::HistoryClear:
      send(res, store.clear_history(host_id, if_match));
      return;
    case QueryLibraryRoute::HistoryDelete:
      send(res, store.delete_history_entry(id, if_match));
      return;
    case QueryLibraryRoute::FolderCreate:
      send(res, store.create_folder(req.body, if_match));
      return;
    case QueryLibraryRoute::FolderUpdate:
      send(res, store.update_folder(id, req.body, if_match));
      return;
    case QueryLibraryRoute::FolderDelete: {
      const std::string recursive = req.has_param("recursive") ? lower_ascii(req.get_param_value("recursive")) : "";
      send(res, store.delete_folder(id, recursive == "1" || recursive == "true", if_match));
      return;
    }
    case QueryLibraryRoute::QueryCreate:
      send(res, store.create_query(req.body, if_match));
      return;
    case QueryLibraryRoute::QueryUpdate:
      send(res, store.update_query(id, req.body, if_match));
      return;
    case QueryLibraryRoute::QueryDelete:
      send(res, store.delete_query(id, if_match));
      return;
    case QueryLibraryRoute::Import:
      send(res, store.import_library(req.body, if_match));
      return;
  }
  library_error(res, 404, "not_found", "unknown query library route");
}

} // namespace chdash
