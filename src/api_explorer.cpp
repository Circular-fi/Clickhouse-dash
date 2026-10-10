#include "server.hpp"
#include "json_parse.hpp"

#include "api_error.hpp"
#include "api_params.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"
#include "json_text.hpp"

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <utility>
#include <unordered_map>
#include <unordered_set>

namespace chdash {
namespace {

constexpr uint64_t kExplorerTableDetailCacheTtlMs = 30 * 1000;

uint64_t now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}


std::string explorer_security_key(const std::string& host_id) {
  return host_id;
}

struct ExplorerGraphRequestScope {
  std::string database;
  std::string focus_database;
  std::string focus_table;
  std::string focus_id;
  int depth = 1;
  bool physical = false;
  bool include_system = false;
  bool include_non_storing = true;
  // Per-node one-hop expansions on top of the global depth: (upstream, id).
  std::vector<std::pair<bool, std::string>> expansions;
};

constexpr size_t kMaxGraphExpansions = 64;

bool is_system_database(const std::string& database) {
  return database == "system" || database == "information_schema" || database == "INFORMATION_SCHEMA";
}

bool is_non_storing_graph_node(const ExplorerGraphNode& node) {
  return node.kind == "view" || node.kind == "materialized_view" ||
      node.kind == "refreshable_materialized_view" || node.kind == "buffer";
}


ExplorerGraphRequestScope read_graph_scope(const httplib::Request& req) {
  ExplorerGraphRequestScope scope;
  if (req.has_param("database")) scope.database = req.get_param_value("database");
  if (req.has_param("focus_database")) scope.focus_database = req.get_param_value("focus_database");
  if (req.has_param("focus_table")) scope.focus_table = req.get_param_value("focus_table");
  if (!scope.focus_database.empty() && !scope.focus_table.empty()) {
    scope.focus_id = "table:" + scope.focus_database + "." + scope.focus_table;
  }
  if (req.has_param("depth")) {
    const auto depth = parse_whole_i64(req.get_param_value("depth"));
    scope.depth = depth ? static_cast<int>(std::clamp<int64_t>(*depth, 0, 8)) : 1;
  }
  scope.physical = req.has_param("mode") && req.get_param_value("mode") == "physical";
  scope.include_system = req.has_param("include_system") && req.get_param_value("include_system") == "1";
  scope.include_non_storing = !req.has_param("include_non_storing") || req.get_param_value("include_non_storing") != "0";
  // Repeated expand=up:table:db.t / expand=down:table:db.u parameters. Ids are
  // only compared with ids of the authorized graph, so an unknown or hidden id
  // is a no-op.
  const size_t expand_count = std::min(req.get_param_value_count("expand"), kMaxGraphExpansions);
  for (size_t i = 0; i < expand_count; ++i) {
    const std::string item = req.get_param_value("expand", i);
    if (item.rfind("up:", 0) == 0 && item.size() > 3) scope.expansions.emplace_back(true, item.substr(3));
    else if (item.rfind("down:", 0) == 0 && item.size() > 5) scope.expansions.emplace_back(false, item.substr(5));
  }
  return scope;
}

std::unordered_set<std::string> logical_storage_available_ids(const ExplorerGraph& graph) {
  std::unordered_map<std::string, const ExplorerGraphNode*> by_id;
  by_id.reserve(graph.nodes.size());
  for (const auto& node : graph.nodes) by_id.emplace(node.id, &node);

  std::unordered_set<std::string> available;
  for (const auto& edge : graph.edges) {
    const auto from_it = by_id.find(edge.from);
    const auto to_it = by_id.find(edge.to);
    if (from_it == by_id.end() || to_it == by_id.end()) continue;
    if (from_it->second->layer == "logical" && to_it->second->layer == "physical") available.insert(edge.from);
  }

  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto& edge : graph.edges) {
      if (edge.kind != "buffer" || !available.count(edge.to) || available.count(edge.from)) continue;
      const auto from_it = by_id.find(edge.from);
      if (from_it == by_id.end() || from_it->second->layer != "logical" || from_it->second->kind != "buffer") continue;
      available.insert(edge.from);
      changed = true;
    }
  }
  return available;
}

// The sections that a missing grant left out: their names, and for each the user and the grant to give.
void write_unavailable(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::vector<std::string>& sections,
                       const std::vector<ExplorerUnavailableIssue>& issues) {
  w.Key("unavailable_sections"); w.StartArray();
  for (const auto& section : sections) write_json_text(w, section);
  w.EndArray();
  w.Key("unavailable"); w.StartArray();
  for (const auto& issue : issues) {
    w.StartObject();
    w.Key("section"); write_json_text(w, issue.section);
    w.Key("reason"); w.String("not_granted");
    w.Key("user"); write_json_text(w, issue.user);
    w.Key("grant"); write_json_text(w, issue.grant);
    const std::string hint = "GRANT " + issue.grant + (issue.user.empty() ? std::string() : " TO " + issue.user) + ";";
    w.Key("hint"); write_json_text(w, hint);
    w.EndObject();
  }
  w.EndArray();
}

ExplorerGraph scope_graph(
    const ExplorerGraph& graph,
    const ExplorerGraphRequestScope& scope,
    bool lineage_enabled,
    bool storage_enabled) {
  ExplorerGraph out;
  out.generated_at_ms = graph.generated_at_ms;
  out.metric_scope = graph.metric_scope;
  out.refreshable_views_available = graph.refreshable_views_available;
  out.unavailable_sections = graph.unavailable_sections;
  out.unavailable_issues = graph.unavailable_issues;

  std::unordered_map<std::string, const ExplorerGraphNode*> by_id;
  by_id.reserve(graph.nodes.size());
  for (const auto& node : graph.nodes) by_id.emplace(node.id, &node);

  auto allowed_system = [&](const ExplorerGraphNode& node) {
    return scope.include_system || !is_system_database(node.database);
  };

  // Directed logical adjacency, filled only for a focused Lineage scope.
  std::unordered_map<std::string, std::vector<std::string>> downstream;
  std::unordered_map<std::string, std::vector<std::string>> upstream;
  struct SemanticWalk { std::vector<std::string> neighbors; std::vector<std::string> intermediates; };
  // One semantic hop from `start` in one direction. When non-storing objects
  // are hidden, View/MV/Buffer nodes cost zero hops (same rule as depth) and
  // are walked through; they are reported separately as intermediates.
  auto semantic_walk = [&](const std::string& start, bool up) {
    SemanticWalk walk;
    const auto& links = up ? upstream : downstream;
    std::unordered_set<std::string> seen{start};
    std::vector<std::string> stack{start};
    while (!stack.empty()) {
      const std::string current = stack.back();
      stack.pop_back();
      const auto it = links.find(current);
      if (it == links.end()) continue;
      for (const auto& next : it->second) {
        if (!seen.insert(next).second) continue;
        const auto node_it = by_id.find(next);
        if (node_it == by_id.end()) continue;
        if (!scope.include_non_storing && is_non_storing_graph_node(*node_it->second)) {
          walk.intermediates.push_back(next);
          stack.push_back(next);
        } else {
          walk.neighbors.push_back(next);
        }
      }
    }
    return walk;
  };
  bool focused_lineage = false;

  std::unordered_set<std::string> included;
  if (!scope.focus_id.empty()) {
    const auto root_it = by_id.find(scope.focus_id);
    if (root_it != by_id.end() && root_it->second->layer == "logical" && allowed_system(*root_it->second)) {
      if (!scope.physical && lineage_enabled) {
        std::unordered_map<std::string, std::vector<std::string>> adjacency;
        for (const auto& edge : graph.edges) {
          const auto from_it = by_id.find(edge.from);
          const auto to_it = by_id.find(edge.to);
          if (from_it == by_id.end() || to_it == by_id.end()) continue;
          if (from_it->second->layer != "logical" || to_it->second->layer != "logical") continue;
          if (!allowed_system(*from_it->second) || !allowed_system(*to_it->second)) continue;
          adjacency[edge.from].push_back(edge.to);
          adjacency[edge.to].push_back(edge.from);
          downstream[edge.from].push_back(edge.to);
          upstream[edge.to].push_back(edge.from);
        }

        // Depth is a user-visible semantic hop count. When non-storing objects
        // are hidden, View/MV/Buffer intermediates cost zero hops so:
        // table -> view -> mv -> table is depth 1, not depth 3. We still ship
        // those hidden intermediates inside the scoped payload so the browser
        // can contract them into the correct typed edge.
        std::unordered_map<std::string, int> distance;
        std::deque<std::string> queue;
        distance.emplace(scope.focus_id, 0);
        queue.push_front(scope.focus_id);
        while (!queue.empty()) {
          const std::string current = queue.front();
          queue.pop_front();
          const int current_depth = distance[current];
          const auto adj_it = adjacency.find(current);
          if (adj_it == adjacency.end()) continue;
          for (const auto& next : adj_it->second) {
            const auto node_it = by_id.find(next);
            if (node_it == by_id.end()) continue;
            const int cost = (!scope.include_non_storing && is_non_storing_graph_node(*node_it->second)) ? 0 : 1;
            const int next_depth = current_depth + cost;
            if (next_depth > scope.depth) continue;
            const auto known = distance.find(next);
            if (known != distance.end() && known->second <= next_depth) continue;
            distance[next] = next_depth;
            if (cost == 0) queue.push_front(next);
            else queue.push_back(next);
          }
        }
        for (const auto& [id, _] : distance) included.insert(id);

        // Per-node expansions add one semantic hop in one direction from an
        // anchor that is itself shown. Applied to a fixed point so a chain of
        // expansions (expand A, then the node it revealed) is order-free; an
        // anchor that is no longer shown expands nothing.
        if (!scope.expansions.empty()) {
          bool grew = true;
          for (size_t pass = 0; grew && pass <= scope.expansions.size(); ++pass) {
            grew = false;
            for (const auto& [up, anchor] : scope.expansions) {
              if (!included.count(anchor)) continue;
              // Hidden intermediates on the way are shipped for contraction.
              const auto walk = semantic_walk(anchor, up);
              for (const auto& id : walk.neighbors) if (included.insert(id).second) grew = true;
              for (const auto& id : walk.intermediates) if (included.insert(id).second) grew = true;
            }
          }
        }
        focused_lineage = true;
      } else if (scope.physical && storage_enabled) {
        // Storage mode needs only the focused table, Buffer routes that feed or
        // drain it, and their physical descendants. Do not ship the unrelated
        // database-wide physical topology to the browser.
        std::unordered_set<std::string> logical_roots{scope.focus_id};
        bool changed = true;
        while (changed) {
          changed = false;
          for (const auto& edge : graph.edges) {
            if (edge.kind != "buffer") continue;
            const auto from_it = by_id.find(edge.from);
            const auto to_it = by_id.find(edge.to);
            if (from_it == by_id.end() || to_it == by_id.end()) continue;
            if (from_it->second->layer != "logical" || to_it->second->layer != "logical") continue;
            if (!allowed_system(*from_it->second) || !allowed_system(*to_it->second)) continue;
            if (logical_roots.count(edge.from) && logical_roots.insert(edge.to).second) changed = true;
            if (logical_roots.count(edge.to) && from_it->second->kind == "buffer" && logical_roots.insert(edge.from).second) changed = true;
          }
        }
        included.insert(logical_roots.begin(), logical_roots.end());
        changed = true;
        while (changed) {
          changed = false;
          for (const auto& edge : graph.edges) {
            if (!included.count(edge.from) || included.count(edge.to)) continue;
            const auto to_it = by_id.find(edge.to);
            if (to_it == by_id.end() || to_it->second->layer != "physical") continue;
            included.insert(edge.to);
            changed = true;
          }
        }
      }
    }
  } else {
    for (const auto& node : graph.nodes) {
      if (!scope.database.empty() && node.database != scope.database) continue;
      if (!allowed_system(node)) continue;
      if (scope.physical) {
        if (storage_enabled && (node.layer == "logical" || node.layer == "physical")) included.insert(node.id);
      } else if (lineage_enabled && node.layer == "logical") {
        included.insert(node.id);
      }
    }
  }

  out.nodes.reserve(included.size());
  for (const auto& node : graph.nodes) if (included.count(node.id)) out.nodes.push_back(node);
  if (focused_lineage) {
    // Lets the browser draw a per-node "+N" only where something is left to
    // expand, without shipping the next ring.
    for (auto& node : out.nodes) {
      if (node.layer != "logical") continue;
      for (const bool up : {true, false}) {
        uint64_t hidden = 0;
        for (const auto& id : semantic_walk(node.id, up).neighbors) if (!included.count(id)) ++hidden;
        (up ? node.hidden_upstream : node.hidden_downstream) = hidden;
      }
    }
  }
  out.edges.reserve(graph.edges.size());
  for (const auto& edge : graph.edges) {
    if (included.count(edge.from) && included.count(edge.to)) out.edges.push_back(edge);
  }
  return out;
}

bool logical_scope_has_more(
    const ExplorerGraph& graph,
    const ExplorerGraphRequestScope& scope,
    const ExplorerGraph& scoped,
    bool lineage_enabled) {
  if (!lineage_enabled || scope.physical || scope.focus_id.empty() || scope.depth >= 8) return false;
  ExplorerGraphRequestScope next_scope = scope;
  next_scope.depth = std::min(8, scope.depth + 1);
  const ExplorerGraph next = scope_graph(graph, next_scope, lineage_enabled, false);
  std::unordered_set<std::string> current_ids;
  current_ids.reserve(scoped.nodes.size());
  for (const auto& node : scoped.nodes) if (node.layer == "logical") current_ids.insert(node.id);
  for (const auto& node : next.nodes) {
    if (node.layer == "logical" && !current_ids.count(node.id)) return true;
  }
  return false;
}

void write_optional_u64(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::optional<uint64_t>& value) {
  if (value) w.Uint64(*value);
  else w.Null();
}

void write_optional_double(rapidjson::Writer<rapidjson::StringBuffer>& w, const std::optional<double>& value) {
  if (value) w.Double(*value);
  else w.Null();
}

void write_rate(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerRate& rate) {
  w.StartObject();
  w.Key("rows_per_second_1m"); write_optional_double(w, rate.rows_per_second_1m);
  w.Key("rows_per_second_5m"); write_optional_double(w, rate.rows_per_second_5m);
  w.Key("rows_per_second_1h"); write_optional_double(w, rate.rows_per_second_1h);
  w.Key("bytes_per_second_1m"); write_optional_double(w, rate.bytes_per_second_1m);
  w.Key("bytes_per_second_5m"); write_optional_double(w, rate.bytes_per_second_5m);
  w.Key("bytes_per_second_1h"); write_optional_double(w, rate.bytes_per_second_1h);
  w.Key("new_parts_per_minute"); write_optional_u64(w, rate.new_parts_per_minute);
  w.Key("rows_total_1h"); write_optional_u64(w, rate.rows_total_1h);
  w.Key("bytes_total_1h"); write_optional_u64(w, rate.bytes_total_1h);
  w.Key("last_event_time"); write_json_text(w, rate.last_event_time);
  w.EndObject();
}

void write_replication(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerReplication& replication) {
  w.StartObject();
  w.Key("available"); w.Bool(replication.available);
  w.Key("total_replicas"); w.Uint64(replication.total_replicas);
  w.Key("active_replicas"); w.Uint64(replication.active_replicas);
  w.Key("queue_size"); w.Uint64(replication.queue_size);
  w.Key("absolute_delay_seconds"); w.Uint64(replication.absolute_delay_seconds);
  w.Key("readonly"); w.Bool(replication.readonly);
  w.Key("session_expired"); w.Bool(replication.session_expired);
  w.Key("replica_name"); write_json_text(w, replication.replica_name);
  w.Key("zookeeper_path"); write_json_text(w, replication.zookeeper_path);
  w.Key("is_leader"); w.Bool(replication.is_leader);
  w.Key("inserts_in_queue"); w.Uint64(replication.inserts_in_queue);
  w.Key("merges_in_queue"); w.Uint64(replication.merges_in_queue);
  w.Key("log_lag"); w.Uint64(replication.log_lag);
  w.Key("last_queue_update"); write_json_text(w, replication.last_queue_update);
  w.Key("replicas"); w.StartArray();
  for (const auto& [name, active] : replication.replicas) {
    w.StartObject();
    w.Key("name"); write_json_text(w, name);
    w.Key("active"); w.Bool(active);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
}

void write_summary(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerTableSummary& table) {
  w.StartObject();
  w.Key("database"); write_json_text(w, table.database);
  w.Key("name"); write_json_text(w, table.name);
  w.Key("engine"); write_json_text(w, table.engine);
  w.Key("engine_full"); write_json_text(w, table.engine_full);
  w.Key("rows"); write_optional_u64(w, table.rows);
  w.Key("logical_bytes"); write_optional_u64(w, table.logical_bytes);
  w.Key("physical_bytes"); write_optional_u64(w, table.physical_bytes);
  w.Key("compressed_bytes"); write_optional_u64(w, table.compressed_bytes);
  w.Key("uncompressed_bytes"); write_optional_u64(w, table.uncompressed_bytes);
  w.Key("resident_bytes"); write_optional_u64(w, table.resident_bytes);
  w.Key("secondary_indices_bytes"); write_optional_u64(w, table.secondary_indices_bytes);
  w.Key("projection_bytes"); write_optional_u64(w, table.projection_bytes);
  w.Key("active_parts"); w.Uint64(table.active_parts);
  w.Key("partitions"); w.Uint64(table.partitions);
  w.Key("sorting_key"); write_json_text(w, table.sorting_key);
  w.Key("primary_key"); write_json_text(w, table.primary_key);
  w.Key("partition_key"); write_json_text(w, table.partition_key);
  w.Key("sampling_key"); write_json_text(w, table.sampling_key);
  w.Key("storage_policy"); write_json_text(w, table.storage_policy);
  w.Key("metadata_modification_time"); write_json_text(w, table.metadata_modification_time);
  w.Key("last_part_time"); write_json_text(w, table.last_part_time);
  w.Key("disks");
  w.StartArray();
  for (const auto& disk : table.disks) write_json_text(w, disk);
  w.EndArray();
  w.Key("client_ingress"); write_rate(w, table.client_ingress);
  w.Key("physical_ingress"); write_rate(w, table.physical_ingress);
  w.Key("replication"); write_replication(w, table.replication);
  w.Key("health"); write_json_text(w, table.health);
  w.Key("warnings");
  w.StartArray();
  for (const auto& warning : table.warnings) write_json_text(w, warning);
  w.EndArray();
  w.EndObject();
}

std::shared_ptr<clickhouse::Client> acquire_explorer_client(
    const std::shared_ptr<ClickHouseClientPool>& pool,
    const std::string& uri,
    std::string* error) {
  return pool ? pool->acquire(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error)
    : make_client_from_uri(
      uri,
      std::chrono::seconds(5),
      std::chrono::seconds(15),
      std::chrono::seconds(15),
      error);
}

} // namespace

void Server::handle_explorer_catalog(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string database_filter = req.has_param("database") ? req.get_param_value("database") : std::string{};
  const std::string security_key = explorer_security_key(host_id);
  std::string list_key = security_key + std::string("\0catalog-list\0", 14);
  list_key += database_filter.empty() ? std::string("@databases") : database_filter;
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  const AclAccess access = runner_access(*host);
  if (force_refresh) {
    // A global refresh reads the privileges of the runner and the rich graph metadata again too. A scoped database
    // refresh touches that sidebar branch and the privileges of that database only. Nothing is removed: a read in
    // progress is waited for, and every request that asked meanwhile shares the next one.
    if (database_filter.empty()) {
      acl_.invalidate(access);
      explorer_catalog_cache_.invalidate(catalog_key);
      explorer_graph_cache_.invalidate(graph_key);
      explorer_functions_cache_.invalidate(functions_key);
      explorer_storage_cache_.invalidate(security_key + std::string("\0storage", 8));
    } else {
      acl_.invalidate(access, database_filter);
    }
  }

  // Served at once past its TTL while one refresh runs: the fetch owns what it uses.
  const HostSpec host_spec = *host;
  auto catalog_result = explorer_catalog_list_cache_.get_revalidating(
      list_key,
      [this, host_spec, access, database_filter](ExplorerCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }

        try {
          if (database_filter.empty()) {
            // First paint is database names only. Do not enumerate, DESCRIBE or
            // permission-probe every table in every database just to build the
            // collapsed navigation tree. A database whose answer the discovery
            // budget did not reach is listed too (its name is what SHOW gives
            // the runner): its objects are checked when it is opened.
            const auto listed = acl_.databases(access);
            value = ExplorerCatalog{};
            value.generated_at_ms = now_ms();
            value.databases = listed->databases;
            value.databases.insert(value.databases.end(), listed->unverified.begin(), listed->unverified.end());
            std::sort(value.databases.begin(), value.databases.end());
            value.acl_truncated = listed->truncated;
            std::string summary_error;
            (void)load_explorer_database_summaries(
                *runner, value.databases, value.database_summaries, &summary_error);
            return true;
          }

          // The expanded branch needs only this database. Its objects come from
          // the runner's ACL (SHOW TABLES and the checks as the runner), so the
          // technical account never decides which object names are allowed to
          // reach the browser. A branch is asked by name: its own answer decides,
          // whether or not the kept database list names it yet (a database
          // created since).
          const auto objects = acl_.objects(access, database_filter);
          if (objects->objects.empty()) {
            value = ExplorerCatalog{};
            value.generated_at_ms = now_ms();
            value.acl_truncated = objects->truncated;
            return true;
          }
          AllowedObjectSet scoped_allowed;
          for (const auto& object : objects->objects) scoped_allowed.add_table(object);

          const std::string system_uri = host_spec.system_uri.empty() ? host_spec.runner_uri : host_spec.system_uri;
          auto system = acquire_explorer_client(client_pool_, system_uri, &error);
          if (!system) {
            code = "system_context_unavailable";
            message = error.empty() ? "Cannot connect to the system context." : error;
            return false;
          }
          if (!load_explorer_catalog_index(*system, *runner, scoped_allowed, value, &error)) {
            code = "explorer_catalog_failed";
            message = error.empty() ? "Unable to load Explorer object list." : error;
            return false;
          }
          value.acl_truncated = objects->truncated;
          return true;
        } catch (const AclUnavailable& e) {
          code = e.code;
          message = e.what();
          return false;
        } catch (const std::exception& e) {
          code = "explorer_catalog_failed";
          message = e.what();
          if (client_pool_) client_pool_->invalidate(runner);
          return false;
        }
      },
      force_refresh);

  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer object list is unavailable." : catalog_result.error_message);
  }

  rapidjson::StringBuffer sb(nullptr, database_filter.empty() ? 8 * 1024 : 32 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(3);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(catalog_result.value->generated_at_ms);
  w.Key("stale"); w.Bool(catalog_result.stale);
  // A bound of the privilege discovery stopped it: objects that were not checked are not listed.
  w.Key("acl_truncated"); w.Bool(catalog_result.value->acl_truncated);
  w.Key("database"); write_json_text(w, database_filter);
  w.Key("databases");
  w.StartArray();
  for (const auto& database : catalog_result.value->databases) write_json_text(w, database);
  w.EndArray();
  w.Key("database_summaries");
  w.StartArray();
  for (const auto& database : catalog_result.value->database_summaries) {
    w.StartObject();
    w.Key("name"); write_json_text(w, database.name);
    w.Key("tables"); w.Uint64(database.tables);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("bytes"); w.Uint64(database.bytes);
    w.EndObject();
  }
  w.EndArray();
  // A database branch (database=<name>) also names the local disks its
  // active parts are on (the database card's Storage tab): the database's
  // bytes on each and the disk's free / total space.
  if (!database_filter.empty()) {
    w.Key("disks");
    w.StartArray();
    for (const auto& disk : catalog_result.value->database_disks) {
      w.StartObject();
      w.Key("name"); write_json_text(w, disk.name);
      w.Key("host_name"); write_json_text(w, disk.host_name);
      w.Key("path"); write_json_text(w, disk.path);
      w.Key("type"); write_json_text(w, disk.type);
      w.Key("bytes"); w.Uint64(disk.bytes);
      w.Key("free_space"); write_optional_u64(w, disk.free_space);
      w.Key("total_space"); write_optional_u64(w, disk.total_space);
      w.EndObject();
    }
    w.EndArray();
  }
  w.Key("tables");
  w.StartArray();
  for (const auto& table : catalog_result.value->tables) {
    w.StartObject();
    w.Key("database"); write_json_text(w, table.database);
    w.Key("name"); write_json_text(w, table.name);
    w.Key("engine"); write_json_text(w, table.engine);
    w.Key("metadata_modification_time"); write_json_text(w, table.metadata_modification_time);
    w.Key("rows"); write_optional_u64(w, table.rows);
    w.Key("bytes");
    if (table.resident_bytes) w.Uint64(*table.resident_bytes);
    else write_optional_u64(w, table.logical_bytes);
    // Database detail object table: filled by the per-database parts
    // aggregation (MergeTree); null / 0 / "" for other engines.
    w.Key("compressed_bytes"); write_optional_u64(w, table.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, table.uncompressed_bytes);
    w.Key("active_parts"); w.Uint64(table.active_parts);
    w.Key("last_part_time"); write_json_text(w, table.last_part_time);
    if (table.replication.available) {
      // Local replica state only (no Keeper read): read-only / expired session
      // is an error, a long queue or delay a warning.
      w.Key("replicated"); w.Bool(true);
      w.Key("health"); write_json_text(w, table.health);
    }
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_storage(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string storage_key = explorer_security_key(host_id) + std::string("\0storage", 8);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  const AclAccess access = runner_access(*host);
  if (force_refresh) acl_.invalidate(access);

  const HostSpec host_spec = *host;
  auto result = explorer_storage_cache_.get_revalidating(
      storage_key,
      [this, host_spec, access](ExplorerStorageMap& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        const std::string system_uri = host_spec.system_uri.empty() ? host_spec.runner_uri : host_spec.system_uri;
        auto system = acquire_explorer_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system context." : error;
          return false;
        }
        try {
          AclView acl(acl_, access);
          if (!load_explorer_storage_map(*system, *runner, acl, value, &error)) {
            code = "explorer_storage_failed";
            message = error.empty() ? "Unable to load the Explorer storage distribution." : error;
            return false;
          }
          return true;
        } catch (const AclUnavailable& e) {
          code = e.code;
          message = e.what();
          return false;
        } catch (const std::exception& e) {
          code = "explorer_storage_failed";
          message = e.what();
          if (client_pool_) {
            client_pool_->invalidate(runner);
            client_pool_->invalidate(system);
          }
          return false;
        }
      },
      force_refresh);

  if (!result.has_value || !result.value) {
    return json_error(
        res, 503,
        result.error_code.empty() ? "explorer_unavailable" : result.error_code,
        result.error_message.empty() ? "Explorer storage distribution is unavailable." : result.error_message);
  }

  const ExplorerStorageMap& map = *result.value;
  uint64_t total_bytes = 0;
  uint64_t total_rows = 0;
  uint64_t total_resident = 0;
  uint64_t total_storing = 0;
  for (const auto& database : map.databases) {
    total_bytes += database.bytes;
    total_rows += database.rows;
    total_resident += database.resident_bytes;
    total_storing += database.storing_tables;
  }

  rapidjson::StringBuffer sb(nullptr, 16 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(map.generated_at_ms);
  w.Key("stale"); w.Bool(result.stale);
  w.Key("metric_scope"); write_json_text(w, map.metric_scope);
  w.Key("byte_metric"); w.String("bytes_on_disk");
  w.Key("table_limit_per_database"); w.Uint64(map.table_limit_per_database);
  w.Key("total_bytes"); w.Uint64(total_bytes);
  w.Key("total_rows"); w.Uint64(total_rows);
  w.Key("resident_bytes"); w.Uint64(total_resident);
  w.Key("storing_tables"); w.Uint64(total_storing);
  w.Key("databases");
  w.StartArray();
  for (const auto& database : map.databases) {
    w.StartObject();
    w.Key("name"); write_json_text(w, database.name);
    w.Key("system"); w.Bool(is_system_database(database.name));
    w.Key("bytes"); w.Uint64(database.bytes);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("resident_bytes"); w.Uint64(database.resident_bytes);
    w.Key("objects"); w.Uint64(database.objects);
    w.Key("storing_tables"); w.Uint64(database.storing_tables);
    w.Key("omitted_tables"); w.Uint64(database.omitted_tables);
    w.Key("omitted_bytes"); w.Uint64(database.omitted_bytes);
    w.Key("omitted_rows"); w.Uint64(database.omitted_rows);
    w.Key("tables");
    w.StartArray();
    for (const auto& table : database.tables) {
      w.StartObject();
      w.Key("name"); write_json_text(w, table.name);
      w.Key("engine"); write_json_text(w, table.engine);
      w.Key("bytes"); w.Uint64(table.bytes);
      w.Key("rows"); write_optional_u64(w, table.rows);
      w.Key("parts"); w.Uint64(table.parts);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_table(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  const std::string database = req.has_param("database") ? req.get_param_value("database") : std::string{};
  const std::string table = req.has_param("table") ? req.get_param_value("table") : std::string{};
  if (host_id.empty() || database.empty() || table.empty()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string security_key = explorer_security_key(host_id);

  std::string detail_key = security_key + std::string("\0table-detail\0", 14);
  detail_key += database;
  detail_key.push_back('\0');
  detail_key += table;
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  const AclAccess access = runner_access(*host);
  if (force_refresh) acl_.invalidate(access, database);

  const uint64_t detail_ttl = kExplorerTableDetailCacheTtlMs;
  auto detail_result = explorer_table_detail_cache_.get(
      detail_key,
      [&](ExplorerTableDetail& value, std::string& code, std::string& message) {
        const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, system_uri, &error);
        if (!system) {
          code = "system_context_unavailable";
          message = error.empty() ? "Cannot connect to the system metadata context." : error;
          return false;
        }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }

        AllowedObjectSet scoped_allowed;
        try {
          auto entry = discover_allowed_table(*runner, database, table);
          if (!entry) {
            code = "object_not_found";
            message = "Object not found or has no readable columns.";
            return false;
          }
          scoped_allowed.add_table(std::move(*entry));
        } catch (const std::exception& e) {
          code = "acl_discovery_failed";
          message = e.what();
          return false;
        }

        ExplorerTableSummary summary;
        if (!load_explorer_table_summary(
                *system, *runner, scoped_allowed, database, table, summary, &error)) {
          code = "explorer_table_summary_failed";
          message = error.empty() ? "Unable to load Explorer table summary." : error;
          return false;
        }
        try {
          AclView acl(acl_, access);
          if (!load_explorer_table_detail(
                  *system, *runner, acl, scoped_allowed, database, table, summary, value, &error)) {
            code = "explorer_table_metadata_failed";
            message = error.empty() ? "Unable to load Explorer table metadata." : error;
            return false;
          }
        } catch (const AclUnavailable& e) {
          code = e.code;
          message = e.what();
          return false;
        }
        value.generated_at_ms = now_ms();
        return true;
      },
      force_refresh);

  if (!detail_result.has_value || !detail_result.value) {
    const std::string code = detail_result.error_code.empty() ? "explorer_table_metadata_failed" : detail_result.error_code;
    return json_error(
        res, code == "object_not_found" ? 404 : 503,
        code,
        detail_result.error_message.empty() ? "Unable to load Explorer table metadata." : detail_result.error_message);
  }
  const ExplorerTableDetail& detail = *detail_result.value;

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("metric_scope"); w.String("local-replica");
  w.Key("stale"); w.Bool(detail_result.stale);
  w.Key("cache_ttl_ms"); w.Uint64(detail_ttl);
  w.Key("generated_at_ms"); w.Uint64(detail.generated_at_ms);
  w.Key("summary"); write_summary(w, detail.summary);
  w.Key("footprint_scope"); w.StartObject();
  w.Key("database_bytes"); write_optional_u64(w, detail.database_footprint_bytes);
  w.Key("clickhouse_bytes"); write_optional_u64(w, detail.clickhouse_footprint_bytes);
  w.EndObject();

  w.Key("default_compression_codecs");
  w.StartArray();
  for (const auto& codec : detail.default_compression_codecs) write_json_text(w, codec);
  w.EndArray();

  w.Key("columns"); w.StartArray();
  for (const auto& column : detail.columns) {
    w.StartObject();
    w.Key("name"); write_json_text(w, column.name);
    w.Key("type"); write_json_text(w, column.type);
    w.Key("default_kind"); write_json_text(w, column.default_kind);
    w.Key("default_expression"); write_json_text(w, column.default_expression);
    w.Key("codec"); write_json_text(w, column.codec_expression);
    w.Key("ttl_expression"); write_json_text(w, column.ttl_expression);
    w.Key("comment"); write_json_text(w, column.comment);
    w.Key("is_in_partition_key"); w.Bool(column.in_partition_key);
    w.Key("is_in_sorting_key"); w.Bool(column.in_sorting_key);
    w.Key("is_in_primary_key"); w.Bool(column.in_primary_key);
    w.Key("is_in_sampling_key"); w.Bool(column.in_sampling_key);
    w.Key("is_subcolumn"); w.Bool(column.is_subcolumn);
    w.Key("parent_name"); write_json_text(w, column.parent_name);
    w.Key("compressed_bytes"); write_optional_u64(w, column.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, column.uncompressed_bytes);
    w.Key("relative_weight"); write_optional_double(w, column.relative_weight);
    w.EndObject();
  }
  w.EndArray();

  w.Key("column_storage"); w.StartObject();
  w.Key("compact_parts"); w.Uint64(detail.column_storage.compact_parts);
  w.Key("wide_parts"); w.Uint64(detail.column_storage.wide_parts);
  w.Key("compact_on_disk_bytes"); write_optional_u64(w, detail.column_storage.compact_on_disk_bytes);
  w.Key("wide_on_disk_bytes"); write_optional_u64(w, detail.column_storage.wide_on_disk_bytes);
  w.Key("compact_compressed_bytes"); write_optional_u64(w, detail.column_storage.compact_compressed_bytes);
  w.Key("compact_uncompressed_bytes"); write_optional_u64(w, detail.column_storage.compact_uncompressed_bytes);
  w.Key("wide_compressed_bytes"); write_optional_u64(w, detail.column_storage.wide_compressed_bytes);
  w.Key("wide_uncompressed_bytes"); write_optional_u64(w, detail.column_storage.wide_uncompressed_bytes);
  w.EndObject();

  w.Key("storage"); w.StartArray();
  for (const auto& disk : detail.storage) {
    w.StartObject();
    w.Key("disk"); write_json_text(w, disk.disk);
    w.Key("path"); write_json_text(w, disk.path);
    w.Key("bytes"); write_optional_u64(w, disk.bytes);
    w.Key("rows"); write_optional_u64(w, disk.rows);
    w.Key("free_space"); write_optional_u64(w, disk.free_space);
    w.Key("total_space"); write_optional_u64(w, disk.total_space);
    w.Key("parts"); w.Uint64(disk.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("parts"); w.StartArray();
  for (const auto& part : detail.parts) {
    w.StartObject();
    w.Key("name"); write_json_text(w, part.name);
    w.Key("partition"); write_json_text(w, part.partition);
    w.Key("disk"); write_json_text(w, part.disk);
    w.Key("rows"); w.Uint64(part.rows);
    w.Key("bytes"); w.Uint64(part.bytes);
    w.Key("marks"); w.Uint64(part.marks);
    w.Key("files"); w.Uint64(part.files);
    w.Key("level"); w.Uint64(part.level);
    w.Key("age_seconds"); w.Uint64(part.age_seconds);
    w.Key("active"); w.Bool(part.active);
    w.EndObject();
  }
  w.EndArray();

  w.Key("partitions"); w.StartArray();
  for (const auto& partition : detail.partitions) {
    w.StartObject();
    w.Key("partition"); write_json_text(w, partition.partition);
    w.Key("rows"); w.Uint64(partition.rows);
    w.Key("bytes"); w.Uint64(partition.bytes);
    w.Key("parts"); w.Uint64(partition.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("indexes_and_projections"); w.StartArray();
  for (const auto& item : detail.indexes_and_projections) {
    w.StartObject();
    w.Key("name"); write_json_text(w, item.name);
    w.Key("kind"); write_json_text(w, item.kind);
    w.Key("expression"); write_json_text(w, item.expression);
    w.Key("compressed_bytes"); write_optional_u64(w, item.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, item.uncompressed_bytes);
    w.Key("on_disk_bytes"); write_optional_u64(w, item.on_disk_bytes);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations"); w.StartArray();
  for (const auto& item : detail.mutations) {
    w.StartObject();
    w.Key("mutation_id"); write_json_text(w, item.mutation_id);
    w.Key("command"); write_json_text(w, item.command);
    w.Key("create_time"); write_json_text(w, item.create_time);
    w.Key("done"); w.Bool(item.done);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("latest_failed_part"); write_json_text(w, item.latest_failed_part);
    w.Key("latest_fail_time"); write_json_text(w, item.latest_fail_time);
    w.Key("latest_fail_reason"); write_json_text(w, item.latest_fail_reason);
    w.EndObject();
  }
  w.EndArray();

  w.Key("merges"); w.StartArray();
  for (const auto& item : detail.merges) {
    w.StartObject();
    w.Key("partition"); write_json_text(w, item.partition);
    w.Key("result_part_name"); write_json_text(w, item.result_part_name);
    w.Key("elapsed_seconds"); w.Double(item.elapsed_seconds);
    w.Key("progress"); w.Double(item.progress);
    w.Key("num_parts"); w.Uint64(item.num_parts);
    w.Key("rows_read"); w.Uint64(item.rows_read);
    w.Key("bytes_read"); w.Uint64(item.bytes_read);
    w.Key("memory_usage"); w.Uint64(item.memory_usage);
    w.EndObject();
  }
  w.EndArray();

  w.Key("topology"); w.StartArray();
  for (const auto& node : detail.topology) {
    w.StartObject();
    w.Key("cluster"); write_json_text(w, node.cluster);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); write_json_text(w, node.host_name);
    w.Key("host_address"); write_json_text(w, node.host_address);
    w.Key("port"); w.Uint64(node.port);
    w.Key("is_local"); w.Bool(node.is_local);
    w.Key("errors_count"); w.Uint64(node.errors_count);
    w.Key("slowdowns_count"); w.Uint64(node.slowdowns_count);
    w.Key("estimated_recovery_time"); w.Uint64(node.estimated_recovery_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("distribution_queue"); w.StartArray();
  for (const auto& item : detail.distribution_queue) {
    w.StartObject();
    w.Key("data_path"); write_json_text(w, item.data_path);
    w.Key("blocked"); w.Bool(item.blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    w.Key("last_exception"); write_json_text(w, item.last_exception);
    w.Key("last_exception_time"); write_json_text(w, item.last_exception_time);
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue"); w.StartArray();
  for (const auto& item : detail.replication_queue) {
    w.StartObject();
    w.Key("type"); write_json_text(w, item.type);
    w.Key("create_time"); write_json_text(w, item.create_time);
    w.Key("source_replica"); write_json_text(w, item.source_replica);
    w.Key("new_part_name"); write_json_text(w, item.new_part_name);
    w.Key("num_tries"); w.Uint64(item.num_tries);
    w.Key("last_attempt_time"); write_json_text(w, item.last_attempt_time);
    w.Key("last_exception"); write_json_text(w, item.last_exception);
    w.EndObject();
  }
  w.EndArray();

  w.Key("dependencies"); w.StartArray();
  for (const auto& item : detail.dependencies) {
    w.StartObject();
    w.Key("database"); write_json_text(w, item.database);
    w.Key("table"); write_json_text(w, item.table);
    w.Key("relation"); write_json_text(w, item.relation);
    w.Key("kind"); write_json_text(w, item.kind);
    w.Key("engine"); write_json_text(w, item.engine);
    w.EndObject();
  }
  w.EndArray();

  w.Key("ddl"); write_json_text(w, detail.create_table_query);
  w.Key("table_ttl"); write_json_text(w, detail.table_ttl);
  if (!detail.distributed_cluster.empty()) {
    w.Key("distributed"); w.StartObject();
    w.Key("cluster"); write_json_text(w, detail.distributed_cluster);
    w.Key("database"); write_json_text(w, detail.distributed_database);
    w.Key("table"); write_json_text(w, detail.distributed_table);
    w.EndObject();
  }
  write_unavailable(w, detail.unavailable_sections, detail.unavailable_issues);
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_functions(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string security_key = explorer_security_key(host_id);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";

  // Function discovery is intentionally executed with runner_uri. Unlike table
  // observability, there is no reason to elevate this metadata query through
  // the technical metadata account; the runner remains ClickHouse's own visibility boundary.
  auto functions_result = explorer_functions_cache_.get(
      functions_key,
      [&](ExplorerFunctionsCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_functions(*runner, value, &error)) {
          code = "functions_unavailable";
          message = error.empty() ? "Function metadata is unavailable on this server." : error;
          return false;
        }
        return true;
      },
      force_refresh);
  if (!functions_result.has_value || !functions_result.value) {
    return json_error(
        res, 503,
        functions_result.error_code.empty() ? "functions_unavailable" : functions_result.error_code,
        functions_result.error_message.empty() ? "Function metadata is unavailable on this server." : functions_result.error_message);
  }

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("stale"); w.Bool(functions_result.stale);
  w.Key("documentation_available"); w.Bool(functions_result.value->documentation_available);
  w.Key("markdown_links_enabled"); w.Bool(cfg_.explorer.function_markdown_links);
  w.Key("functions"); w.StartArray();
  for (const auto& function : functions_result.value->functions) {
    w.StartObject();
    w.Key("name"); write_json_text(w, function.name);
    w.Key("kind"); write_json_text(w, function.kind);
    w.Key("category"); write_json_text(w, function.category);
    w.Key("description"); write_json_text(w, function.description);
    w.Key("syntax"); write_json_text(w, function.syntax);
    w.Key("arguments"); write_json_text(w, function.arguments);
    w.Key("parameters"); write_json_text(w, function.parameters);
    w.Key("returned_value"); write_json_text(w, function.returned_value);
    w.Key("examples"); write_json_text(w, function.examples);
    w.Key("introduced_in"); write_json_text(w, function.introduced_in);
    w.Key("source"); write_json_text(w, function.source);
    w.Key("origin"); write_json_text(w, function.origin);
    w.Key("alias_documents"); w.StartArray();
    for (const auto& alias : function.alias_documents) {
      w.StartObject();
      w.Key("name"); write_json_text(w, alias.name);
      w.Key("description"); write_json_text(w, alias.description);
      w.Key("syntax"); write_json_text(w, alias.syntax);
      w.Key("arguments"); write_json_text(w, alias.arguments);
      w.Key("parameters"); write_json_text(w, alias.parameters);
      w.Key("returned_value"); write_json_text(w, alias.returned_value);
      w.Key("examples"); write_json_text(w, alias.examples);
      w.Key("introduced_in"); write_json_text(w, alias.introduced_in);
      w.EndObject();
    }
    w.EndArray();
    w.Key("user_defined"); w.Bool(function.user_defined);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_table_data(const httplib::Request& req, httplib::Response& res) {
  rapidjson::Document doc;
  if (!parse_json_body(req, doc)) return json_error(res, 400, "invalid_json", "Invalid JSON request body.");
  if (!doc.HasMember("host_id") || !doc["host_id"].IsString() ||
      !doc.HasMember("database") || !doc["database"].IsString() ||
      !doc.HasMember("table") || !doc["table"].IsString()) {
    return json_error(res, 400, "missing_scope", "host_id, database and table are required.");
  }
  const std::string host_id = doc["host_id"].GetString();
  const std::string database = doc["database"].GetString();
  const std::string table = doc["table"].GetString();
  size_t limit = 100;
  if (doc.HasMember("limit") && doc["limit"].IsUint64()) limit = static_cast<size_t>(doc["limit"].GetUint64());
  limit = std::max<size_t>(1, std::min<size_t>(limit, 500));

  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  std::string error;
  auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
  if (!runner) {
    return json_error(
        res, 503, "runner_unavailable",
        error.empty() ? "Cannot connect to the runner context." : error);
  }

  AllowedObjectSet allowed;
  try {
    auto entry = discover_allowed_table(*runner, database, table);
    if (!entry) return json_error(res, 404, "object_not_found", "Object not found or has no readable columns.");
    allowed.add_table(std::move(*entry));
  } catch (const std::exception& e) {
    if (client_pool_) client_pool_->invalidate(runner);
    return json_error(res, 503, "acl_discovery_failed", e.what());
  }

  ExplorerPreview preview;
  if (!load_explorer_preview(*runner, allowed, database, table, limit, preview, &error)) {
    return json_error(
        res, 503, "preview_failed",
        error.empty() ? "Unable to preview object data." : error);
  }

  rapidjson::StringBuffer sb(nullptr, 64 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("database"); write_json_text(w, database);
  w.Key("table"); write_json_text(w, table);
  w.Key("limit"); w.Uint64(preview.limit);
  w.Key("columns"); w.StartArray();
  for (const auto& column : preview.columns) {
    w.StartObject();
    w.Key("name"); write_json_text(w, column.name);
    w.Key("type"); write_json_text(w, column.type);
    w.Key("finalized_for_preview"); w.Bool(column.finalized_for_preview);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : preview.rows) {
    w.StartArray();
    for (const auto& value_json : row) {
      rapidjson::Document value;
      parse_json_bounded(value, value_json);
      if (value.HasParseError()) {
        return json_error(res, 500, "preview_serialization_failed", "Explorer produced an invalid typed JSON cell.");
      }
      value.Accept(w);
    }
    w.EndArray();
  }
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}


void Server::handle_explorer_graph(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  std::shared_ptr<const ExplorerGraph> graph;
  bool stale = false;
  if (!explorer_graph_snapshot(req, res, host_id, graph, stale)) return;

  const ExplorerGraphRequestScope request_scope = read_graph_scope(req);
  const ExplorerGraph scoped_graph = scope_graph(
      *graph, request_scope, cfg_.explorer.lineage, cfg_.explorer.storage_topology);
  const bool scope_has_more = logical_scope_has_more(
      *graph, request_scope, scoped_graph, cfg_.explorer.lineage);
  const auto storage_available = logical_storage_available_ids(*graph);

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("generated_at_ms"); w.Uint64(scoped_graph.generated_at_ms);
  w.Key("stale"); w.Bool(stale);
  w.Key("metric_scope"); write_json_text(w, graph->metric_scope);
  w.Key("refreshable_views_available"); w.Bool(scoped_graph.refreshable_views_available);
  write_unavailable(w, scoped_graph.unavailable_sections, scoped_graph.unavailable_issues);
  w.Key("live_refresh_ms"); w.Int(cfg_.explorer.live_refresh_ms);
  w.Key("scope_mode"); w.String(request_scope.physical ? "physical" : "logical");
  w.Key("scope_database"); write_json_text(w, request_scope.database);
  w.Key("scope_focus_id"); write_json_text(w, request_scope.focus_id);
  w.Key("scope_depth"); w.Int(request_scope.depth);
  w.Key("scope_has_more"); w.Bool(scope_has_more);
  w.Key("nodes"); w.StartArray();
  for (const auto& node : scoped_graph.nodes) {
    w.StartObject();
    w.Key("id"); write_json_text(w, node.id);
    w.Key("layer"); write_json_text(w, node.layer);
    w.Key("parent_id"); write_json_text(w, node.parent_id);
    w.Key("kind"); write_json_text(w, node.kind);
    w.Key("database"); write_json_text(w, node.database);
    w.Key("name"); write_json_text(w, node.name);
    w.Key("engine"); write_json_text(w, node.engine);
    w.Key("label"); write_json_text(w, node.label);
    w.Key("health"); write_json_text(w, node.health);
    if (node.layer == "logical") {
      w.Key("storage_available"); w.Bool(storage_available.count(node.id) != 0);
      w.Key("hidden_upstream"); w.Uint64(node.hidden_upstream);
      w.Key("hidden_downstream"); w.Uint64(node.hidden_downstream);
    }
    w.Key("topology_badge"); write_json_text(w, node.topology_badge);
    w.Key("rows"); write_optional_u64(w, node.rows);
    w.Key("logical_bytes"); write_optional_u64(w, node.logical_bytes);
    w.Key("physical_bytes"); write_optional_u64(w, node.physical_bytes);
    w.Key("resident_bytes"); write_optional_u64(w, node.resident_bytes);
    w.Key("active_parts"); w.Uint64(node.active_parts);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); write_json_text(w, node.host_name);
    w.Key("disk_name"); write_json_text(w, node.disk_name);
    w.Key("disk_path"); write_json_text(w, node.disk_path);
    w.Key("disk_type"); write_json_text(w, node.disk_type);
    w.Key("storage_policy"); write_json_text(w, node.storage_policy);
    w.Key("volume_name"); write_json_text(w, node.volume_name);
    w.Key("volume_priority"); w.Uint64(node.volume_priority);
    w.Key("move_factor"); w.Double(node.move_factor);
    w.Key("disk_free_space"); write_optional_u64(w, node.disk_free_space);
    w.Key("disk_total_space"); write_optional_u64(w, node.disk_total_space);
    w.Key("buffer_layers"); w.Uint64(node.buffer_layers);
    w.Key("buffer_min_time"); write_optional_u64(w, node.buffer_min_time);
    w.Key("buffer_max_time"); write_optional_u64(w, node.buffer_max_time);
    w.Key("buffer_min_rows"); write_optional_u64(w, node.buffer_min_rows);
    w.Key("buffer_max_rows"); write_optional_u64(w, node.buffer_max_rows);
    w.Key("buffer_min_bytes"); write_optional_u64(w, node.buffer_min_bytes);
    w.Key("buffer_max_bytes"); write_optional_u64(w, node.buffer_max_bytes);
    w.Key("ttl_rules"); w.StartArray();
    for (const auto& rule : node.ttl_rules) {
      w.StartObject();
      w.Key("expression"); write_json_text(w, rule.expression);
      w.Key("base_expression"); write_json_text(w, rule.base_expression);
      w.Key("offset_label"); write_json_text(w, rule.offset_label);
      w.Key("action"); write_json_text(w, rule.action);
      w.Key("target_kind"); write_json_text(w, rule.target_kind);
      w.Key("target"); write_json_text(w, rule.target);
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : scoped_graph.edges) {
    w.StartObject();
    w.Key("id"); write_json_text(w, edge.id);
    w.Key("from"); write_json_text(w, edge.from);
    w.Key("to"); write_json_text(w, edge.to);
    w.Key("kind"); write_json_text(w, edge.kind);
    w.Key("label"); write_json_text(w, edge.label);
    w.Key("can_animate"); w.Bool(edge.can_animate);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

// The authorized graph of one host: runner ACL discovery, then system-context
// catalog and graph enrichment of only those objects. Shared by the graph and
// definition routes so both stand on the same AllowedObjectSet boundary.
bool Server::explorer_graph_snapshot(
    const httplib::Request& req,
    httplib::Response& res,
    const std::string& host_id,
    std::shared_ptr<const ExplorerGraph>& graph,
    bool& stale) {
  if (host_id.empty()) { json_error(res, 400, "missing_host_id", "Missing host_id."); return false; }
  const HostSpec* host = find_request_host(cfg_, req, host_id);
  if (!host) { json_error(res, 404, "unknown_host", "Unknown host_id."); return false; }
  if (!is_host_healthy(health_.get(), host_id)) {
    json_error(res, 503, "host_unavailable", "Selected host is down.");
    return false;
  }

  const std::string security_key = explorer_security_key(host_id);
  const std::string list_key = security_key + std::string("\0catalog-list", 13);
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  const AclAccess access = runner_access(*host);
  if (force_refresh) {
    acl_.invalidate(access);
    // Sidebar entries are keyed "<scope>\0catalog-list\0<database|@databases>".
    explorer_catalog_list_cache_.invalidate_prefix(list_key);
    explorer_functions_cache_.invalidate(functions_key);
  }

  // Every object the runner reads, at table level (CHECK GRANT and zero-row probes as the runner, kept per identity).
  std::shared_ptr<const AclTableSet> allowed;
  try {
    allowed = acl_.table_set(access);
  } catch (const AclUnavailable& e) {
    json_error(res, 503, e.code, e.what());
    return false;
  }

  const HostSpec host_spec = *host;
  const std::string system_uri = host_spec.system_uri.empty() ? host_spec.runner_uri : host_spec.system_uri;
  const ExplorerIdentities identities{acl_identity_key(system_uri), access.key};
  // Both are served at once past their TTL while one refresh runs: the fetches own what they use.
  auto catalog_result = explorer_catalog_cache_.get_revalidating(
      catalog_key,
      [this, host_spec, system_uri, allowed, identities](ExplorerCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto system = acquire_explorer_client(client_pool_, system_uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = acquire_explorer_client(client_pool_, host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, explorer_caches_, identities, allowed->allowed, value, &error)) {
          code = "explorer_catalog_failed"; message = error; return false;
        }
        value.acl_truncated = allowed->truncated;
        return true;
      },
      force_refresh);
  if (!catalog_result.has_value || !catalog_result.value) {
    json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
    return false;
  }

  const std::shared_ptr<const ExplorerCatalog> catalog = catalog_result.value;
  auto graph_result = explorer_graph_cache_.get_revalidating(
      graph_key,
      [this, system_uri, allowed, catalog, identities](ExplorerGraph& value, std::string& code, std::string& message) {
        std::string error;
        auto system = acquire_explorer_client(client_pool_, system_uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        if (!load_explorer_graph(*system, explorer_caches_, identities.system, allowed->allowed, *catalog, value, &error)) {
          code = "explorer_graph_failed"; message = error; return false;
        }
        return true;
      },
      force_refresh);
  if (!graph_result.has_value || !graph_result.value) {
    json_error(
        res, 503,
        graph_result.error_code.empty() ? "explorer_graph_unavailable" : graph_result.error_code,
        graph_result.error_message.empty() ? "Explorer graph is unavailable." : graph_result.error_message);
    return false;
  }

  graph = graph_result.value;
  stale = graph_result.stale || catalog_result.stale;
  return true;
}

// What an edge/node panel explains about one logical object: its SELECT, its
// destination or source, and Distributed routing. Served from the cached
// authorized graph only: an object outside AllowedObjectSet is simply absent
// (404), and no SQL is executed for the caller.
void Server::handle_explorer_graph_definition(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  const std::string database = req.has_param("database") ? req.get_param_value("database") : std::string{};
  const std::string table = req.has_param("table") ? req.get_param_value("table") : std::string{};
  if (database.empty() || table.empty()) return json_error(res, 400, "missing_object", "Missing database or table.");
  std::shared_ptr<const ExplorerGraph> graph;
  bool stale = false;
  if (!explorer_graph_snapshot(req, res, host_id, graph, stale)) return;

  const std::string id = "table:" + database + "." + table;
  const ExplorerGraphNode* node = nullptr;
  for (const auto& candidate : graph->nodes) {
    if (candidate.layer == "logical" && candidate.id == id && candidate.database == database && candidate.name == table) {
      node = &candidate;
      break;
    }
  }
  if (!node) return json_error(res, 404, "unknown_object", "Object is not visible in the Explorer graph.");
  const auto definition_it = graph->definitions.find(id);
  const ExplorerGraphDefinition empty_definition;
  const ExplorerGraphDefinition& definition = definition_it == graph->definitions.end() ? empty_definition : definition_it->second;

  rapidjson::StringBuffer sb;
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); write_json_text(w, host_id);
  w.Key("stale"); w.Bool(stale);
  w.Key("id"); write_json_text(w, node->id);
  w.Key("database"); write_json_text(w, node->database);
  w.Key("name"); write_json_text(w, node->name);
  w.Key("kind"); write_json_text(w, node->kind);
  w.Key("engine"); write_json_text(w, node->engine);
  w.Key("select_sql");
  if (definition.select_sql.empty()) w.Null(); else write_json_text(w, definition.select_sql);
  w.Key("select_sql_truncated"); w.Bool(definition.select_sql_truncated);
  w.Key("target_visible"); w.Bool(definition.target_visible);
  w.Key("target");
  if (definition.target_visible && !definition.target_table.empty()) {
    w.StartObject();
    w.Key("database"); write_json_text(w, definition.target_database);
    w.Key("table"); write_json_text(w, definition.target_table);
    w.EndObject();
  } else {
    w.Null();
  }
  w.Key("dictionary");
  if (node->kind == "dictionary") {
    w.StartObject();
    w.Key("source_kind"); write_json_text(w, definition.dictionary_source_kind);
    w.Key("layout"); write_json_text(w, definition.dictionary_layout);
    w.Key("lifetime"); write_json_text(w, definition.dictionary_lifetime);
    w.EndObject();
  } else {
    w.Null();
  }
  w.Key("distributed");
  if (node->kind == "distributed") {
    w.StartObject();
    w.Key("cluster"); write_json_text(w, definition.distributed_cluster);
    w.Key("sharding_key"); write_json_text(w, definition.distributed_sharding_key);
    w.Key("shards"); w.Uint64(definition.distributed_shards);
    w.Key("replicas_per_shard"); w.Uint64(definition.distributed_replicas);
    w.EndObject();
  } else {
    w.Null();
  }
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}


} // namespace chdash
