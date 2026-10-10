// REST handlers of the server-side query library (docs/query-library.md).
//
// Routes exist only when query_library.enabled = true (404 otherwise). This file
// never executes SQL: saved SQL is stored and returned verbatim.
// Request paths only select an entity id; the filesystem path is the
// configured query_library.file.

#include "server.hpp"

#include "api_error.hpp"
#include "json_text.hpp"

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

void library_error(httplib::Response& res, int status, const char* code, const std::string& message) {
  json_error(res, status, code, message);
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
  const bool has_body = route == QueryLibraryRoute::FolderCreate || route == QueryLibraryRoute::FolderUpdate ||
                        route == QueryLibraryRoute::QueryCreate || route == QueryLibraryRoute::QueryUpdate ||
                        route == QueryLibraryRoute::Import;
  // Every write (POST, PATCH, DELETE) passed the guard of the writes before the routing (http_guard.hpp,
  // Server::before_routing): not from a page of another site, and a body of application/json only.
  if (has_body && req.body.size() > store.options().max_file_bytes + 64 * 1024) {
    library_error(res, 413, "too_large", "the request body exceeds query_library.max_file_bytes");
    return;
  }

  std::string if_match_storage;
  const std::string* if_match = optional_header(req, "If-Match", if_match_storage);
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
  // The library and its folders are per host: the read names it (?host_id=),
  // the writes in their body.
  std::string host_storage;
  const std::string* host_id = optional_param(req, "host_id", host_storage);

  switch (route) {
    case QueryLibraryRoute::Get:
      send(res, store.get_library(host_id));
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
