#include "access_pages.hpp"

#include "access_actions.hpp"

#include <string>

namespace chdash {
namespace {

bool contains(const std::set<std::string>& pages, const char* name) { return pages.count(name) != 0; }

bool mcp_entry_allowed(const std::set<std::string>& pages) { return contains(pages, "mcp-keys") || contains(pages, "mcp-usage"); }

// Each occurrence of `from` in `text` becomes `to`.
void replace_all(std::string& text, const std::string& from, const std::string& to) {
  size_t at = 0;
  while ((at = text.find(from, at)) != std::string::npos) {
    text.replace(at, from.size(), to);
    at += to.size();
  }
}

} // namespace

const std::vector<AccessPage>& access_pages() {
  static const std::vector<AccessPage> pages = {
      {"query", "Query", "query", {"query.run.read", "query.run.write"}},
      {"explorer", "Explorer", "explorer/catalog", {"explorer.read"}},
      {"observability", "Observability", "observability", {"observability.read"}},
      {"system", "System", "system", {"system.read"}},
      {"mcp-keys", "MCP integration", "mcp-integration", {"mcp.keys.read"}},
      {"mcp-usage", "MCP usage", "mcp-integration/usage", {"mcp.usage.read"}},
  };
  return pages;
}

const AccessPage* access_page(std::string_view name) {
  for (const auto& page : access_pages()) {
    if (name == page.name) return &page;
  }
  return nullptr;
}

const AccessPage* access_page_of_shell(std::string_view shell) {
  if (shell == "query.html") return access_page("query");
  if (shell == "explorer.html" || shell == "functions.html") return access_page("explorer");
  if (shell == "traces.html" || shell == "logs.html" || shell == "metrics.html" || shell == "trace.html") return access_page("observability");
  if (shell == "system.html" || shell == "queries.html" || shell == "disks.html" || shell == "shape.html") return access_page("system");
  if (shell == "mcp.html") return access_page("mcp-keys");
  if (shell == "mcpusage.html") return access_page("mcp-usage");
  return nullptr;
}

std::vector<AccessQuestion> access_navigation_questions(const std::string& service_id, const std::vector<std::string>& hosts,
                                                        const std::string& database) {
  std::vector<AccessQuestion> out;
  for (const AccessAction& action : access_actions()) {
    if (!action.host) out.push_back(AccessQuestion{action.name, access_service_resource(service_id), AccessMatch::Subtree});
  }
  for (const auto& host : hosts) {
    for (const AccessAction& action : access_actions()) {
      if (action.host) out.push_back(AccessQuestion{action.name, access_host_resource(service_id, host), AccessMatch::Subtree});
    }
  }
  if (!database.empty()) {
    for (const auto& host : hosts) out.push_back(AccessQuestion{"explorer.read", access_database_resource(service_id, host, database)});
  }
  return out;
}

namespace {

bool page_level(const AccessQuestion& question) { return question.resource.type == "service" || question.resource.type == "host"; }

} // namespace

std::set<std::string> access_navigation_pages(const std::vector<AccessQuestion>& questions, const std::vector<AccessDecision>& decisions) {
  std::set<std::string> out;
  for (const auto& page : access_pages()) {
    bool allowed = false;
    for (size_t i = 0; i < questions.size() && i < decisions.size() && !allowed; ++i) {
      if (!page_level(questions[i]) || !decisions[i].allowed) continue;
      for (const char* action : page.actions) {
        if (questions[i].action == action) allowed = true;
      }
    }
    if (allowed) out.insert(page.name);
  }
  return out;
}

std::set<std::string> access_visible_hosts(const std::vector<AccessQuestion>& questions, const std::vector<AccessDecision>& decisions) {
  std::set<std::string> out;
  for (size_t i = 0; i < questions.size() && i < decisions.size(); ++i) {
    if (questions[i].resource.type == "host" && decisions[i].allowed) out.insert(questions[i].resource.id);
  }
  return out;
}

std::vector<std::pair<std::string, bool>> access_action_summary(const std::vector<AccessQuestion>& questions,
                                                               const std::vector<AccessDecision>& decisions) {
  std::vector<std::pair<std::string, bool>> out;
  for (const AccessAction& action : access_actions()) {
    bool allowed = false;
    for (size_t i = 0; i < questions.size() && i < decisions.size() && !allowed; ++i) {
      if (page_level(questions[i]) && decisions[i].allowed && questions[i].action == action.name) allowed = true;
    }
    out.emplace_back(action.name, allowed);
  }
  return out;
}

std::string access_mark_navigation(std::string_view html, const std::set<std::string>& pages) {
  std::string out(html);
  for (const auto& page : access_pages()) {
    if (contains(pages, page.name)) continue;
    const std::string attribute = std::string("data-nav-page=\"") + page.name + "\"";
    replace_all(out, attribute, attribute + " hidden data-denied");
  }
  if (!mcp_entry_allowed(pages)) {
    replace_all(out, "data-nav-page=\"mcp\"", "data-nav-page=\"mcp\" hidden data-denied");
  } else if (!contains(pages, "mcp-keys")) {
    replace_all(out, "data-nav-page=\"mcp\" href=\"/mcp-integration\"", "data-nav-page=\"mcp\" href=\"/mcp-integration/usage\"");
  }
  std::string list;
  for (const auto& page : access_pages()) {
    if (!contains(pages, page.name)) continue;
    if (!list.empty()) list.push_back(' ');
    list += page.name;
  }
  static const std::string head = "<head>";
  const size_t at = out.find(head);
  if (at != std::string::npos) out.insert(at + head.size(), "\n  <meta id=\"chdashPages\" name=\"chdash-pages\" content=\"" + list + "\" />");
  return out;
}

std::string access_denied_page(const AccessPage& page, const std::set<std::string>& pages, const std::string& root) {
  std::string links;
  for (const auto& other : access_pages()) {
    if (!contains(pages, other.name)) continue;
    links += "      <li><a href=\"" + root + other.path + "\">" + other.label + "</a></li>\n";
  }
  std::string out =
      "<!doctype html>\n"
      "<html lang=\"en\">\n"
      "<head>\n"
      "  <meta charset=\"utf-8\" />\n"
      "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />\n"
      "  <title>ClickHouse Dash · Access denied</title>\n"
      "  <style>\n"
      "    :root { color-scheme: light dark; --bg: #ffffff; --text: #1f2328; --muted: #59636e; --line: #d1d9e0; --link: #0969da; }\n"
      "    @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --text: #e6edf3; --muted: #9198a1; --line: #3d444d; --link: #4493f8; } }\n"
      "    body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }\n"
      "    main { max-width: 36rem; margin: 12vh auto 0; padding: 0 16px; }\n"
      "    h1 { margin: 0 0 8px; font-size: 22px; font-weight: 600; }\n"
      "    p { margin: 0 0 12px; color: var(--muted); }\n"
      "    code { font: 13px ui-monospace, monospace; color: var(--text); }\n"
      "    ul { margin: 16px 0 0; padding: 12px 0 0; border-top: 1px solid var(--line); list-style: none; }\n"
      "    li { margin: 0 0 6px; }\n"
      "    a { color: var(--link); }\n"
      "  </style>\n"
      "</head>\n"
      "<body>\n"
      "  <main id=\"accessDenied\" data-denied-page=\"" + std::string(page.name) + "\" data-action=\"" + page.actions.front() + "\">\n"
      "    <h1>You cannot open " + page.label + "</h1>\n"
      "    <p>This page needs the action <code>" + page.actions.front() + "</code>. Your access does not include it.</p>\n"
      "    <p>Ask the administrator of your access to give you this action.</p>\n";
  if (links.empty()) {
    out += "    <p id=\"accessDeniedNone\">Your access includes no page of ClickHouse Dash.</p>\n";
  } else {
    out += "    <ul id=\"accessDeniedPages\" aria-label=\"The pages that you can open\">\n" + links + "    </ul>\n";
  }
  out +=
      "  </main>\n"
      "</body>\n"
      "</html>\n";
  return out;
}

const AccessPage* access_first_page(const std::set<std::string>& pages) {
  for (const auto& page : access_pages()) {
    if (contains(pages, page.name)) return &page;
  }
  return nullptr;
}

std::string access_root_of(std::string_view path) {
  std::string out;
  bool first = true;
  for (const char c : path) {
    if (c != '/') continue;
    if (first) {
      first = false;
      continue;
    }
    out += "../";
  }
  return out;
}

} // namespace chdash
