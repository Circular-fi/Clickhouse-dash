// REST handlers of the server-side query library (docs/query-library.md).
//
// Routes exist only when a query_library block is enabled. Otherwise, the answer is 404. The ?library= parameter names one of the libraries.
// This file never executes SQL. It stores the saved SQL and returns it verbatim.
// A request path selects only an entity id. The filesystem path is the
// configured file of the library (query_library.file).

#include "server.hpp"

#include "api_error.hpp"
#include "query_library_read.hpp"
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

// This reads a non-negative integer parameter. The default applies when the parameter is absent, empty, or unreadable.
size_t number_param(const httplib::Request& req, const char* name, size_t fallback) {
  if (!req.has_param(name)) return fallback;
  const std::string text = req.get_param_value(name);
  if (text.empty() || text.size() > 9) return fallback;
  size_t value = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') return fallback;
    value = value * 10 + static_cast<size_t>(c - '0');
  }
  return value;
}

void send(httplib::Response& res, const QueryLibraryStore::Response& out) {
  res.status = out.status;
  res.set_header("Cache-Control", "no-store");
  res.set_content(out.body, "application/json");
}

} // namespace

void Server::handle_query_library(const httplib::Request& req, httplib::Response& res, QueryLibraryRoute route) {
  if (query_libraries_.empty()) {
    library_error(res, 404, "not_found", "the query library is disabled");
    return;
  }
    // ?library=<name> picks one of several libraries. It works on every route, and on the writes too.
    // Without it, the first library applies. This is the default.
  QueryLibraryStore* chosen = query_libraries_.front().get();
  if (req.has_param("library")) {
    const std::string wanted = req.get_param_value("library");
    chosen = nullptr;
    for (const auto& candidate : query_libraries_) {
      if (candidate->options().name == wanted) chosen = candidate.get();
    }
    if (!chosen) {
      library_error(res, 404, "unknown_library", "no query library has this name (library)");
      return;
    }
  }
  QueryLibraryStore& store = *chosen;
  const bool has_body = route == QueryLibraryRoute::FolderCreate || route == QueryLibraryRoute::FolderUpdate ||
                        route == QueryLibraryRoute::QueryCreate || route == QueryLibraryRoute::QueryUpdate ||
                        route == QueryLibraryRoute::Import;
    // The guard of the writes runs before the routing (http_guard.hpp, Server::before_routing). It applies to every write (POST, PATCH, DELETE).
    // The guard refuses a write from a page of another site. It accepts only a body of application/json.
  if (has_body && req.body.size() > store.options().max_file_bytes + 64 * 1024) {
    library_error(res, 413, "too_large", "the request body exceeds query_library.max_file_bytes");
    return;
  }

  std::string if_match_storage;
  const std::string* if_match = optional_header(req, "If-Match", if_match_storage);
  const std::string id = req.matches.size() > 1 ? std::string(req.matches[1]) : std::string();
    // The library and its folders belong to each host. A read names the host with ?host_id=.
    // A write names the host in its body.
  std::string host_storage;
  const std::string* host_id = optional_param(req, "host_id", host_storage);

  switch (route) {
    case QueryLibraryRoute::Get: {
      // ?parent_id= (a folder: its children; none: the top level), ?cursor= (the offset in a first level larger than a page), ?limit=.
      std::string parent_storage;
      const std::string* parent_id = optional_param(req, "parent_id", parent_storage);
      send(res, store.get_page(host_id, parent_id, number_param(req, "cursor", 0), number_param(req, "limit", qlib::kLibraryPageMax)));
      return;
    }
    case QueryLibraryRoute::QueryGet:
      send(res, store.get_query(host_id, id));
      return;
    case QueryLibraryRoute::Search:
      send(res, store.search(host_id, req.has_param("q") ? req.get_param_value("q") : std::string(), number_param(req, "limit", qlib::kLibrarySearchMax)));
      return;
    case QueryLibraryRoute::Export: {
      std::string folder_storage;
      send(res, store.export_library(host_id, optional_param(req, "folder_id", folder_storage)));
      return;
    }
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
