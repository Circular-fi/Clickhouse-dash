#pragma once

// The databases that a person may see, from the Resource Search of the PDP (docs/access.md, "Resource Search"). This is an option. It
// replaces the one question for each database with one search for each action. The code has no HTTP server: it uses a PdpClient.
//
// The Resource Search API returns the resources of one type that the subject can use with one action (AuthZEN 1.0, l.1151-1153).
// The chain of the host goes in resource.properties.ancestors, as in an evaluation. This scope is an extension of ChDash. It is not in
// AuthZEN 1.0: a search request has the members subject, action, resource, context and page (l.1157-1172), and no scope. A PDP that
// ignores properties.ancestors returns the same ids for every host. So the caller keeps only the databases that the host has, and the
// search is on only when the configuration says it (access.pdp.search) and the metadata announces search_resource_endpoint
// (l.1296-1299). ProcurAuth 14 says that a scoped search is not defined by the protocol, and no metadata member announces it.

#include "access_pdp.hpp"

#include <string>
#include <unordered_set>
#include <vector>

namespace chdash {

enum class AccessSearchKind {
  // The search is off, the PDP does not announce it, or the question has no subject: the caller sends the evaluations.
  Unused,
  // A grant on the host (or on the service) covers every database of the host: the caller needs no search and no list of ids.
  Covered,
  // `ids` holds the union, over the actions, of the databases that the PDP returned. A database that is not in it stays denied.
  Ids,
  // The search failed, a bound of the search cut the result, or a decision failed: the caller sends the evaluations.
  Fallback,
};

struct AccessSearchOutcome {
  AccessSearchKind kind = AccessSearchKind::Unused;
  std::unordered_set<std::string> ids;
  // The cause of a Fallback: the text of the log event access.search_fallback. It never holds a token.
  std::string reason;
};

// Ask the PDP, for each action of `actions` (the actions whose resource types hold database):
//   1. one evaluation on the host with the match "node" (the PDP applies the chain, so a grant on the host or on the service gives true).
//      One true answer gives Covered. A failed decision gives Fallback.
//   2. else one Resource Search for the type "database", with the ancestors [service, host] (the chain that the evaluations use). The
//      search follows the pages within the bounds of the client (PdpOptions::search_max_pages and search_max_items). A failed search or a
//      result that a bound cut gives Fallback, never an empty set.
// The result is the union of the ids. The caller intersects it with the databases that exist on the host. The function writes the
// log event access.search_fallback for each Fallback. It returns Unused when `enabled` is false.
AccessSearchOutcome access_search_databases(PdpClient& pdp, bool enabled, const std::string& service, const std::string& host_id,
                                            const std::string& subject, const std::vector<std::string>& actions, const PdpCallContext& context);

} // namespace chdash
