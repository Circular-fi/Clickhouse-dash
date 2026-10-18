#pragma once

// The pages of ChDash for the access of humans (docs/access.md, "Navigation"): the actions that each page needs, the pages that
// one render of a page lets the human use, the links of a shell to the pages that the human cannot use, and the 403 page of a page
// that the human opens by its address without the action.
// Pure code: no HTTP server and no PDP. server.cpp serves the shells with it.

#include "access_pdp.hpp"

#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace chdash {

struct AccessPage {
  const char* name;   // query, explorer, observability, system, mcp-keys, mcp-usage
  const char* label;  // the name that a link shows
  const char* path;   // the address of the page under the root of ChDash, with no leading slash
  // The page is allowed when one of these actions is true on the service or on one host. The first one names the page in a 403.
  std::vector<const char*> actions;
};

// The pages, in the order of the navigation.
const std::vector<AccessPage>& access_pages();
// The page of a name, or null.
const AccessPage* access_page(std::string_view name);
// The page of a shell file ("traces.html" is observability), or null for a file that is not a shell of a page.
const AccessPage* access_page_of_shell(std::string_view shell);

// The questions of one render, in one batch (docs/access.md, "Hidden hosts"): each action that takes no host on the service, each action
// that takes a host on each host of `hosts`, then explorer.read on the database `database` of each host when `database` is not empty
// (an address of the Explorer that names a database). The questions on the service and on the hosts have the match "subtree": a grant
// below a host shows the host and the page. They only show or hide the navigation; each route asks again with "node". GET /api/version
// and GET /api/hosts ask the same questions without the database, so the cache of the PDP serves them all.
std::vector<AccessQuestion> access_navigation_questions(const std::string& service_id, const std::vector<std::string>& hosts,
                                                        const std::string& database);
// The pages that the decisions of access_navigation_questions() allow: a page whose actions are true on the service or on one host. The
// decision on a database never adds a page: it lets the human open an address of the Explorer in that database only.
std::set<std::string> access_navigation_pages(const std::vector<AccessQuestion>& questions, const std::vector<AccessDecision>& decisions);
// The hosts that the decisions of access_navigation_questions() show: a host with one true decision on the host itself (with the match
// "subtree", a grant on a database of the host gives true). An action that takes no host shows no host.
std::set<std::string> access_visible_hosts(const std::vector<AccessQuestion>& questions, const std::vector<AccessDecision>& decisions);
// For each action, true when one decision of the action is true on the service or on a host (the "actions" of GET /api/version).
std::vector<std::pair<std::string, bool>> access_action_summary(const std::vector<AccessQuestion>& questions,
                                                               const std::vector<AccessDecision>& decisions);

// The shell of a page for one human. Each element with data-nav-page="<name>" of a page that the human cannot use gets the attributes
// hidden and data-denied (data-nav-page="mcp" is the MCP entry of the header: it stays while the keys or the usage are allowed, and it
// leads to the usage when only the usage is allowed). A meta element chdash-pages after <head> lists the allowed pages for the
// scripts of the page.
std::string access_mark_navigation(std::string_view html, const std::set<std::string>& pages);

// The 403 page of `page`: no script and no data, the action that it needs, and a link to each page of `pages`. `root` leads from the
// address of the request to the root of ChDash (access_root_of), so a prefix of a reverse proxy stays.
std::string access_denied_page(const AccessPage& page, const std::set<std::string>& pages, const std::string& root);
// The page to open at the root of ChDash: the first page of `pages` in the order of the navigation, or null when there is none.
const AccessPage* access_first_page(const std::set<std::string>& pages);
// "../" for each directory level of `path` below the root ("/query" gives "", "/explorer/catalog/db" gives "../../").
std::string access_root_of(std::string_view path);

} // namespace chdash
