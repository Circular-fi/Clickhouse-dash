// The route of the options: GET /.well-known/procurauth/resources (ProcurAuth 5.6 to 5.9, docs/access.md, "The route of the options").
// It lists the hosts (without parent) or the databases of a host (parent = host:<id>) that the human of the identity token can see.
// A child is visible when the PDP gives true, with the match "subtree", for one published action whose resource types hold the type of the
// child. The parser, the cursor and the page are in access_options.hpp: this file gives them the candidates and the decisions.
// For databases, the Resource Search of the PDP can replace the questions (access_search.hpp), when access.pdp.search is true.
#include "server.hpp"

#include "access_options.hpp"
#include "api_error.hpp"
#include "ch_block_value.hpp"
#include "explorer_graph_scope.hpp"
#include "host_util.hpp"

#include <algorithm>
#include <exception>
#include <string>
#include <vector>

namespace chdash {
namespace {

// A decision without a valid answer of the PDP (AccessDecision::failed): the route answers 503, not an empty list (ProcurAuth 10.3).
bool pdp_failed(const std::vector<AccessDecision>& decisions) {
  return std::any_of(decisions.begin(), decisions.end(), [](const AccessDecision& decision) { return access_outcome(decision) == AccessOutcome::Failed; });
}

// The action name in the 503 body of this route: the route asks several actions, so the body names the route.
constexpr const char* kOptionsAction = "resources";

// The published actions whose resource types hold `type`.
std::vector<std::string> actions_of_type(const AccessFeatures& features, const std::string& type) {
  std::vector<std::string> out;
  for (const AccessAction& action : access_published_actions(features)) {
    if ((type == "host" && action.host) || (type == "database" && action.database)) out.push_back(action.name);
  }
  return out;
}

void send_options(httplib::Response& res, const std::string& body) {
  res.status = 200;
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(body, "application/json");
}

} // namespace

void Server::handle_procurauth_resources(const httplib::Request& req, httplib::Response& res) {
  // The route belongs to a server behind the access gateway: it has no subject in the open mode.
  if (!cfg_.access.enforced()) return json_error(res, 404, "not_found", "Not found.");
  const std::string subject = access_subject();
  if (subject.empty()) return json_error(res, 401, "unauthenticated", "A valid identity token is required.");

  const size_t mark = req.target.find('?');
  const OptionsParse parsed = access_options_parse(mark == std::string::npos ? std::string_view() : std::string_view(req.target).substr(mark + 1));
  if (!parsed.ok) return json_error(res, 400, "bad_parameter", parsed.error);
  const OptionsQuery& query = parsed.query;

  const std::string& service = cfg_.access.audience;
  const std::vector<std::string> actions = actions_of_type(access_features(), query.type);
  const auto empty_answer = [&] { send_options(res, access_options_json(OptionsPage{}, false)); };
  if (actions.empty()) return empty_answer();

  // The question for a child: each action of its type, on the child, with the match "subtree".
  std::function<AccessResource(const std::string&)> resource_of;
  std::vector<OptionsCandidate> candidates;
  // true: the Resource Search (or a grant on the host) already decided: every candidate that is left is visible, and the PDP gets no more question.
  bool decided_locally = false;
  if (query.type == "host") {
    for (const HostSpec& host : cfg_.hosts) candidates.push_back(OptionsCandidate{host.id, host.label});
    resource_of = [service](const std::string& id) { return access_host_resource(service, id); };
  } else {
    // A database: its parent is the host of the path. A host that does not exist, or that the human cannot see, has no item.
    const std::string& host_id = query.parent.front().id;
    const HostSpec* host = find_host(cfg_.hosts, host_id);
    if (!host) return empty_answer();
    const std::vector<std::string> host_actions = actions_of_type(access_features(), "host");
    std::vector<AccessQuestion> questions;
    for (const std::string& action : host_actions) questions.push_back(AccessQuestion{action, access_host_resource(service, host_id), AccessMatch::Subtree});
    const auto decisions = access_decide(questions);
    if (pdp_failed(decisions)) return access_unavailable(res, kOptionsAction);
    if (std::none_of(decisions.begin(), decisions.end(), [](const AccessDecision& decision) { return decision.allowed; })) return empty_answer();

    const auto fetch = [this, host](std::vector<std::string>& out, std::string& code, std::string& message) -> bool {
      std::string error;
      const auto executor = open_explorer_executor(host->runner_uri, &error);
      if (!executor) {
        code = "clickhouse_connect";
        message = error;
        return false;
      }
      try {
        executor->select("SHOW DATABASES", [&](const clickhouse::Block& block) {
          for (size_t row = 0; row < block.GetRowCount(); ++row) {
            std::string name = ch_block_text_at(block, 0, row);
            if (!name.empty() && !explorer::is_system_database(name)) out.push_back(std::move(name));
          }
        });
      } catch (const std::exception& e) {
        executor->invalidate();
        code = "clickhouse_error";
        message = e.what();
        return false;
      }
      return true;
    };
    const auto cached = options_databases_cache_.get(host_id, fetch);
    if (!cached.has_value) return json_error(res, 503, "resources_unavailable", "The databases of the host cannot be read.");
    for (const std::string& name : *cached.value) candidates.push_back(OptionsCandidate{name, name});
    // With access.pdp.search and a PDP that announces the search (docs/access.md, "Resource Search"): one search for each action gives the
    // ids, and the candidates are the databases that exist on the host (SHOW DATABASES) and that the search returned. A grant on the host
    // makes every database visible. Unused and Fallback keep the questions of the batch below.
    const AccessSearchOutcome found = access_search_visible_databases(actions, host_id);
    if (found.kind == AccessSearchKind::Covered) {
      decided_locally = true;
    } else if (found.kind == AccessSearchKind::Ids) {
      decided_locally = true;
      candidates.erase(std::remove_if(candidates.begin(), candidates.end(), [&](const OptionsCandidate& c) { return found.ids.count(c.id) == 0; }),
                       candidates.end());
    }
    resource_of = [service, host_id](const std::string& id) { return access_database_resource(service, host_id, id); };
  }

  const OptionsDecide decide = [&](const std::vector<std::string>& ids) -> std::optional<std::vector<bool>> {
    if (decided_locally) return std::vector<bool>(ids.size(), true);
    std::vector<AccessQuestion> questions;
    questions.reserve(ids.size() * actions.size());
    for (const std::string& id : ids) {
      for (const std::string& action : actions) questions.push_back(AccessQuestion{action, resource_of(id), AccessMatch::Subtree});
    }
    const auto decisions = access_decide(questions);
    if (decisions.size() != questions.size() || pdp_failed(decisions)) return std::nullopt;
    std::vector<bool> visible(ids.size(), false);
    for (size_t i = 0; i < questions.size(); ++i) {
      if (decisions[i].allowed) visible[i / actions.size()] = true;
    }
    return visible;
  };
  const OptionsPage page = access_options_page(std::move(candidates), query, decided_locally ? 1 : actions.size(), decide);
  if (page.failed) return access_unavailable(res, kOptionsAction);
  send_options(res, access_options_json(page, query.type == "host"));
}

} // namespace chdash
