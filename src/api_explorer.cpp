#include "server.hpp"

#include "api_error.hpp"
#include "ch_uri.hpp"
#include "host_util.hpp"
#include "http_json.hpp"

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

uint64_t now_ms() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

constexpr uint64_t kExplorerTableDetailCacheTtlMs = 30 * 1000;

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
};

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
    try {
      scope.depth = std::clamp(std::stoi(req.get_param_value("depth")), 0, 8);
    } catch (...) {
      scope.depth = 1;
    }
  }
  scope.physical = req.has_param("mode") && req.get_param_value("mode") == "physical";
  scope.include_system = req.has_param("include_system") && req.get_param_value("include_system") == "1";
  scope.include_non_storing = !req.has_param("include_non_storing") || req.get_param_value("include_non_storing") != "0";
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

ExplorerGraph scope_graph(
    const ExplorerGraph& graph,
    const ExplorerGraphRequestScope& scope,
    bool lineage_enabled,
    bool storage_enabled) {
  ExplorerGraph out;
  out.generated_at_ms = graph.generated_at_ms;
  out.metric_scope = graph.metric_scope;
  out.refreshable_views_available = graph.refreshable_views_available;

  std::unordered_map<std::string, const ExplorerGraphNode*> by_id;
  by_id.reserve(graph.nodes.size());
  for (const auto& node : graph.nodes) by_id.emplace(node.id, &node);

  auto allowed_system = [&](const ExplorerGraphNode& node) {
    return scope.include_system || !is_system_database(node.database);
  };

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
  w.Key("last_event_time"); w.String(rate.last_event_time.c_str());
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
  w.Key("replica_name"); w.String(replication.replica_name.c_str());
  w.Key("zookeeper_path"); w.String(replication.zookeeper_path.c_str());
  w.EndObject();
}

void write_summary(rapidjson::Writer<rapidjson::StringBuffer>& w, const ExplorerTableSummary& table) {
  w.StartObject();
  w.Key("database"); w.String(table.database.c_str());
  w.Key("name"); w.String(table.name.c_str());
  w.Key("engine"); w.String(table.engine.c_str());
  w.Key("engine_full"); w.String(table.engine_full.c_str());
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
  w.Key("sorting_key"); w.String(table.sorting_key.c_str());
  w.Key("primary_key"); w.String(table.primary_key.c_str());
  w.Key("partition_key"); w.String(table.partition_key.c_str());
  w.Key("sampling_key"); w.String(table.sampling_key.c_str());
  w.Key("storage_policy"); w.String(table.storage_policy.c_str());
  w.Key("last_part_time"); w.String(table.last_part_time.c_str());
  w.Key("disks");
  w.StartArray();
  for (const auto& disk : table.disks) w.String(disk.c_str());
  w.EndArray();
  w.Key("client_ingress"); write_rate(w, table.client_ingress);
  w.Key("physical_ingress"); write_rate(w, table.physical_ingress);
  w.Key("replication"); write_replication(w, table.replication);
  w.Key("health"); w.String(table.health.c_str());
  w.Key("warnings");
  w.StartArray();
  for (const auto& warning : table.warnings) w.String(warning.c_str());
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
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const std::string database_filter = req.has_param("database") ? req.get_param_value("database") : std::string{};
  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  std::string list_key = security_key + std::string("\0catalog-list\0", 14);
  list_key += database_filter.empty() ? std::string("@databases") : database_filter;
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) {
    explorer_catalog_list_cache_.erase(list_key);
    // A global refresh also invalidates rich graph/function metadata. A scoped
    // database refresh intentionally touches only that sidebar branch.
    if (database_filter.empty()) {
      explorer_allowed_cache_.erase(security_key);
      explorer_catalog_cache_.erase(catalog_key);
      explorer_graph_cache_.erase(graph_key);
      explorer_functions_cache_.erase(functions_key);
    }
  }

  auto catalog_result = explorer_catalog_list_cache_.get_or_refresh(
      list_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }

        try {
          if (database_filter.empty()) {
            // First paint is database names only. Do not enumerate, DESCRIBE or
            // permission-probe every table in every database just to build the
            // collapsed navigation tree.
            value = ExplorerCatalog{};
            value.generated_at_ms = now_ms();
            value.databases = discover_visible_databases(*runner);
            std::string summary_error;
            (void)load_explorer_database_summaries(
                *runner, value.databases, value.database_summaries, &summary_error);
            return true;
          }

          const auto databases = discover_visible_databases(*runner);
          if (!std::binary_search(databases.begin(), databases.end(), database_filter)) {
            value = ExplorerCatalog{};
            value.generated_at_ms = now_ms();
            return true;
          }

          // The expanded branch needs only this database. SHOW runs in the
          // runner context, so the technical account never decides which
          // object names are allowed to reach the browser.
          const auto objects = discover_visible_objects(*runner, database_filter);
          AllowedObjectSet scoped_allowed;
          for (const auto& object : objects) {
            AllowedTable entry;
            entry.database = database_filter;
            entry.table = object;
            entry.all_columns = true;
            scoped_allowed.add_table(std::move(entry));
          }

          const std::string system_uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
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
          return true;
        } catch (const std::exception& e) {
          code = "explorer_catalog_failed";
          message = e.what();
          if (client_pool_) client_pool_->invalidate(runner);
          return false;
        }
      });

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
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(catalog_result.value->generated_at_ms);
  w.Key("stale"); w.Bool(catalog_result.stale);
  w.Key("database"); w.String(database_filter.c_str());
  w.Key("databases");
  w.StartArray();
  for (const auto& database : catalog_result.value->databases) w.String(database.c_str());
  w.EndArray();
  w.Key("database_summaries");
  w.StartArray();
  for (const auto& database : catalog_result.value->database_summaries) {
    w.StartObject();
    w.Key("name"); w.String(database.name.c_str());
    w.Key("tables"); w.Uint64(database.tables);
    w.Key("rows"); w.Uint64(database.rows);
    w.Key("bytes"); w.Uint64(database.bytes);
    w.EndObject();
  }
  w.EndArray();
  w.Key("tables");
  w.StartArray();
  for (const auto& table : catalog_result.value->tables) {
    w.StartObject();
    w.Key("database"); w.String(table.database.c_str());
    w.Key("name"); w.String(table.name.c_str());
    w.Key("engine"); w.String(table.engine.c_str());
    w.Key("rows"); write_optional_u64(w, table.rows);
    w.Key("bytes");
    if (table.resident_bytes) w.Uint64(*table.resident_bytes);
    else write_optional_u64(w, table.logical_bytes);
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
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

  const uint64_t ts = now_ms();
  const std::string security_key = explorer_security_key(host_id);

  std::string detail_key = security_key + std::string("\0table-detail\0", 14);
  detail_key += database;
  detail_key.push_back('\0');
  detail_key += table;
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) explorer_table_detail_cache_.erase(detail_key);

  auto detail_result = explorer_table_detail_cache_.get_or_refresh(
      detail_key, ts, kExplorerTableDetailCacheTtlMs, 250,
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
        if (!load_explorer_table_detail(
                *system, *runner, scoped_allowed, database, table, summary, value, &error)) {
          code = "explorer_table_metadata_failed";
          message = error.empty() ? "Unable to load Explorer table metadata." : error;
          return false;
        }
        return true;
      });

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
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("metric_scope"); w.String("local-replica");
  w.Key("stale"); w.Bool(detail_result.stale);
  w.Key("cache_ttl_ms"); w.Uint64(kExplorerTableDetailCacheTtlMs);
  w.Key("summary"); write_summary(w, detail.summary);
  w.Key("footprint_scope"); w.StartObject();
  w.Key("database_bytes"); write_optional_u64(w, detail.database_footprint_bytes);
  w.Key("clickhouse_bytes"); write_optional_u64(w, detail.clickhouse_footprint_bytes);
  w.EndObject();

  w.Key("default_compression_codecs");
  w.StartArray();
  for (const auto& codec : detail.default_compression_codecs) w.String(codec.c_str());
  w.EndArray();

  w.Key("columns"); w.StartArray();
  for (const auto& column : detail.columns) {
    w.StartObject();
    w.Key("name"); w.String(column.name.c_str());
    w.Key("type"); w.String(column.type.c_str());
    w.Key("default_kind"); w.String(column.default_kind.c_str());
    w.Key("default_expression"); w.String(column.default_expression.c_str());
    w.Key("codec"); w.String(column.codec_expression.c_str());
    w.Key("ttl_expression"); w.String(column.ttl_expression.c_str());
    w.Key("is_subcolumn"); w.Bool(column.is_subcolumn);
    w.Key("parent_name"); w.String(column.parent_name.c_str());
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
    w.Key("disk"); w.String(disk.disk.c_str());
    w.Key("path"); w.String(disk.path.c_str());
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
    w.Key("name"); w.String(part.name.c_str());
    w.Key("partition"); w.String(part.partition.c_str());
    w.Key("disk"); w.String(part.disk.c_str());
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
    w.Key("partition"); w.String(partition.partition.c_str());
    w.Key("rows"); w.Uint64(partition.rows);
    w.Key("bytes"); w.Uint64(partition.bytes);
    w.Key("parts"); w.Uint64(partition.parts);
    w.EndObject();
  }
  w.EndArray();

  w.Key("indexes_and_projections"); w.StartArray();
  for (const auto& item : detail.indexes_and_projections) {
    w.StartObject();
    w.Key("name"); w.String(item.name.c_str());
    w.Key("kind"); w.String(item.kind.c_str());
    w.Key("expression"); w.String(item.expression.c_str());
    w.Key("compressed_bytes"); write_optional_u64(w, item.compressed_bytes);
    w.Key("uncompressed_bytes"); write_optional_u64(w, item.uncompressed_bytes);
    w.Key("on_disk_bytes"); write_optional_u64(w, item.on_disk_bytes);
    w.EndObject();
  }
  w.EndArray();

  w.Key("mutations"); w.StartArray();
  for (const auto& item : detail.mutations) {
    w.StartObject();
    w.Key("mutation_id"); w.String(item.mutation_id.c_str());
    w.Key("command"); w.String(item.command.c_str());
    w.Key("create_time"); w.String(item.create_time.c_str());
    w.Key("done"); w.Bool(item.done);
    w.Key("parts_to_do"); w.Uint64(item.parts_to_do);
    w.Key("latest_failed_part"); w.String(item.latest_failed_part.c_str());
    w.Key("latest_fail_time"); w.String(item.latest_fail_time.c_str());
    w.Key("latest_fail_reason"); w.String(item.latest_fail_reason.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("merges"); w.StartArray();
  for (const auto& item : detail.merges) {
    w.StartObject();
    w.Key("partition"); w.String(item.partition.c_str());
    w.Key("result_part_name"); w.String(item.result_part_name.c_str());
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
    w.Key("cluster"); w.String(node.cluster.c_str());
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); w.String(node.host_name.c_str());
    w.Key("host_address"); w.String(node.host_address.c_str());
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
    w.Key("data_path"); w.String(item.data_path.c_str());
    w.Key("blocked"); w.Bool(item.blocked);
    w.Key("error_count"); w.Uint64(item.error_count);
    w.Key("data_files"); w.Uint64(item.data_files);
    w.Key("data_compressed_bytes"); w.Uint64(item.data_compressed_bytes);
    w.Key("broken_data_files"); w.Uint64(item.broken_data_files);
    w.Key("broken_data_compressed_bytes"); w.Uint64(item.broken_data_compressed_bytes);
    w.Key("last_exception"); w.String(item.last_exception.c_str());
    w.Key("last_exception_time"); w.String(item.last_exception_time.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("replication_queue"); w.StartArray();
  for (const auto& item : detail.replication_queue) {
    w.StartObject();
    w.Key("type"); w.String(item.type.c_str());
    w.Key("create_time"); w.String(item.create_time.c_str());
    w.Key("source_replica"); w.String(item.source_replica.c_str());
    w.Key("new_part_name"); w.String(item.new_part_name.c_str());
    w.Key("num_tries"); w.Uint64(item.num_tries);
    w.Key("last_attempt_time"); w.String(item.last_attempt_time.c_str());
    w.Key("last_exception"); w.String(item.last_exception.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("dependencies"); w.StartArray();
  for (const auto& item : detail.dependencies) {
    w.StartObject();
    w.Key("database"); w.String(item.database.c_str());
    w.Key("table"); w.String(item.table.c_str());
    w.Key("relation"); w.String(item.relation.c_str());
    w.EndObject();
  }
  w.EndArray();

  w.Key("ddl"); w.String(detail.create_table_query.c_str());
  w.Key("unavailable_sections"); w.StartArray();
  for (const auto& section : detail.unavailable_sections) w.String(section.c_str());
  w.EndArray();
  w.EndObject();

  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}

void Server::handle_explorer_functions(const httplib::Request& req, httplib::Response& res) {
  const std::string host_id = req.has_param("host_id") ? req.get_param_value("host_id") : std::string{};
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(1000, cfg_.explorer.function_cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) explorer_functions_cache_.erase(functions_key);

  // Function discovery is intentionally executed with runner_uri. Unlike table
  // observability, there is no reason to elevate this metadata query through
  // the technical metadata account; the runner remains ClickHouse's own visibility boundary.
  auto functions_result = explorer_functions_cache_.get_or_refresh(
      functions_key, ts, ttl, 250,
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
      });
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
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("stale"); w.Bool(functions_result.stale);
  w.Key("documentation_available"); w.Bool(functions_result.value->documentation_available);
  w.Key("markdown_links_enabled"); w.Bool(cfg_.explorer.function_markdown_links);
  w.Key("functions"); w.StartArray();
  for (const auto& function : functions_result.value->functions) {
    w.StartObject();
    w.Key("name"); w.String(function.name.c_str());
    w.Key("kind"); w.String(function.kind.c_str());
    w.Key("category"); w.String(function.category.c_str());
    w.Key("description"); w.String(function.description.c_str());
    w.Key("syntax"); w.String(function.syntax.c_str());
    w.Key("arguments"); w.String(function.arguments.c_str());
    w.Key("parameters"); w.String(function.parameters.c_str());
    w.Key("returned_value"); w.String(function.returned_value.c_str());
    w.Key("examples"); w.String(function.examples.c_str());
    w.Key("introduced_in"); w.String(function.introduced_in.c_str());
    w.Key("source"); w.String(function.source.c_str());
    w.Key("origin"); w.String(function.origin.c_str());
    w.Key("alias_documents"); w.StartArray();
    for (const auto& alias : function.alias_documents) {
      w.StartObject();
      w.Key("name"); w.String(alias.name.c_str());
      w.Key("description"); w.String(alias.description.c_str());
      w.Key("syntax"); w.String(alias.syntax.c_str());
      w.Key("arguments"); w.String(alias.arguments.c_str());
      w.Key("parameters"); w.String(alias.parameters.c_str());
      w.Key("returned_value"); w.String(alias.returned_value.c_str());
      w.Key("examples"); w.String(alias.examples.c_str());
      w.Key("introduced_in"); w.String(alias.introduced_in.c_str());
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

  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");

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
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("database"); w.String(database.c_str());
  w.Key("table"); w.String(table.c_str());
  w.Key("limit"); w.Uint64(preview.limit);
  w.Key("columns"); w.StartArray();
  for (const auto& column : preview.columns) {
    w.StartObject();
    w.Key("name"); w.String(column.name.c_str());
    w.Key("type"); w.String(column.type.c_str());
    w.Key("finalized_for_preview"); w.Bool(column.finalized_for_preview);
    w.EndObject();
  }
  w.EndArray();
  w.Key("rows"); w.StartArray();
  for (const auto& row : preview.rows) {
    w.StartArray();
    for (const auto& value_json : row) {
      rapidjson::Document value;
      value.Parse(value_json.data(), value_json.size());
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
  if (host_id.empty()) return json_error(res, 400, "missing_host_id", "Missing host_id.");
  const HostSpec* host = find_host(cfg_.hosts, host_id);
  if (!host) return json_error(res, 404, "unknown_host", "Unknown host_id.");
  if (!is_host_healthy(health_.get(), host_id)) {
    return json_error(res, 503, "host_unavailable", "Selected host is down.");
  }

  const uint64_t ts = now_ms();
  const uint64_t ttl = static_cast<uint64_t>(std::max(0, cfg_.explorer.cache_ttl_ms));
  const std::string security_key = explorer_security_key(host_id);
  const std::string list_key = security_key + std::string("\0catalog-list", 13);
  const std::string catalog_key = security_key + std::string("\0catalog", 8);
  const std::string graph_key = security_key + std::string("\0graph", 6);
  const std::string functions_key = security_key + std::string("\0functions", 10);
  const bool force_refresh = req.has_param("refresh") && req.get_param_value("refresh") == "1";
  if (force_refresh) {
    explorer_allowed_cache_.erase(security_key);
    explorer_catalog_list_cache_.erase(list_key);
    explorer_catalog_cache_.erase(catalog_key);
    explorer_graph_cache_.erase(graph_key);
    explorer_functions_cache_.erase(functions_key);
  }

  auto allowed_result = explorer_allowed_cache_.get_or_refresh(
      security_key, ts, ttl, 250,
      [&](AllowedObjectSet& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) { code = "runner_unavailable"; message = error; return false; }
        try { value = discover_allowed_objects(*runner); return true; }
        catch (const std::exception& e) { code = "acl_discovery_failed"; message = e.what(); return false; }
      });
  if (!allowed_result.has_value || !allowed_result.value) {
    return json_error(
        res, 503,
        allowed_result.error_code.empty() ? "acl_unavailable" : allowed_result.error_code,
        allowed_result.error_message.empty() ? "Unable to determine readable ClickHouse objects." : allowed_result.error_message);
  }

  auto catalog_result = explorer_catalog_cache_.get_or_refresh(
      catalog_key, ts, ttl, 250,
      [&](ExplorerCatalog& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = acquire_explorer_client(client_pool_, host->runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = error.empty() ? "Cannot connect to the runner context." : error;
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, *allowed_result.value, value, &error)) {
          code = "explorer_catalog_failed"; message = error; return false;
        }
        return true;
      });
  if (!catalog_result.has_value || !catalog_result.value) {
    return json_error(
        res, 503,
        catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
        catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message);
  }

  auto graph_result = explorer_graph_cache_.get_or_refresh(
      graph_key, ts, ttl, 250,
      [&](ExplorerGraph& value, std::string& code, std::string& message) {
        const std::string uri = host->system_uri.empty() ? host->runner_uri : host->system_uri;
        std::string error;
        auto system = acquire_explorer_client(client_pool_, uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        if (!load_explorer_graph(*system, *allowed_result.value, *catalog_result.value, value, &error)) {
          code = "explorer_graph_failed"; message = error; return false;
        }
        return true;
      });
  if (!graph_result.has_value || !graph_result.value) {
    return json_error(
        res, 503,
        graph_result.error_code.empty() ? "explorer_graph_unavailable" : graph_result.error_code,
        graph_result.error_message.empty() ? "Explorer graph is unavailable." : graph_result.error_message);
  }

  const ExplorerGraphRequestScope request_scope = read_graph_scope(req);
  const ExplorerGraph scoped_graph = scope_graph(
      *graph_result.value, request_scope, cfg_.explorer.lineage, cfg_.explorer.storage_topology);
  const bool scope_has_more = logical_scope_has_more(
      *graph_result.value, request_scope, scoped_graph, cfg_.explorer.lineage);
  const auto storage_available = logical_storage_available_ids(*graph_result.value);

  rapidjson::StringBuffer sb(nullptr, 128 * 1024);
  rapidjson::Writer<rapidjson::StringBuffer> w(sb);
  w.StartObject();
  w.Key("version"); w.Uint(1);
  w.Key("host_id"); w.String(host_id.c_str());
  w.Key("generated_at_ms"); w.Uint64(scoped_graph.generated_at_ms);
  w.Key("stale"); w.Bool(graph_result.stale || catalog_result.stale || allowed_result.stale);
  w.Key("metric_scope"); w.String(graph_result.value->metric_scope.c_str());
  w.Key("refreshable_views_available"); w.Bool(scoped_graph.refreshable_views_available);
  w.Key("live_refresh_ms"); w.Int(cfg_.explorer.live_refresh_ms);
  w.Key("scope_mode"); w.String(request_scope.physical ? "physical" : "logical");
  w.Key("scope_database"); w.String(request_scope.database.c_str());
  w.Key("scope_focus_id"); w.String(request_scope.focus_id.c_str());
  w.Key("scope_depth"); w.Int(request_scope.depth);
  w.Key("scope_has_more"); w.Bool(scope_has_more);
  w.Key("nodes"); w.StartArray();
  for (const auto& node : scoped_graph.nodes) {
    w.StartObject();
    w.Key("id"); w.String(node.id.c_str());
    w.Key("layer"); w.String(node.layer.c_str());
    w.Key("parent_id"); w.String(node.parent_id.c_str());
    w.Key("kind"); w.String(node.kind.c_str());
    w.Key("database"); w.String(node.database.c_str());
    w.Key("name"); w.String(node.name.c_str());
    w.Key("engine"); w.String(node.engine.c_str());
    w.Key("label"); w.String(node.label.c_str());
    w.Key("health"); w.String(node.health.c_str());
    if (node.layer == "logical") { w.Key("storage_available"); w.Bool(storage_available.count(node.id) != 0); }
    w.Key("topology_badge"); w.String(node.topology_badge.c_str());
    w.Key("rows"); write_optional_u64(w, node.rows);
    w.Key("logical_bytes"); write_optional_u64(w, node.logical_bytes);
    w.Key("physical_bytes"); write_optional_u64(w, node.physical_bytes);
    w.Key("resident_bytes"); write_optional_u64(w, node.resident_bytes);
    w.Key("active_parts"); w.Uint64(node.active_parts);
    w.Key("shard_num"); w.Uint64(node.shard_num);
    w.Key("replica_num"); w.Uint64(node.replica_num);
    w.Key("host_name"); w.String(node.host_name.c_str());
    w.Key("disk_name"); w.String(node.disk_name.c_str());
    w.Key("disk_path"); w.String(node.disk_path.c_str());
    w.Key("disk_type"); w.String(node.disk_type.c_str());
    w.Key("storage_policy"); w.String(node.storage_policy.c_str());
    w.Key("volume_name"); w.String(node.volume_name.c_str());
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
      w.Key("expression"); w.String(rule.expression.c_str());
      w.Key("base_expression"); w.String(rule.base_expression.c_str());
      w.Key("offset_label"); w.String(rule.offset_label.c_str());
      w.Key("action"); w.String(rule.action.c_str());
      w.Key("target_kind"); w.String(rule.target_kind.c_str());
      w.Key("target"); w.String(rule.target.c_str());
      w.EndObject();
    }
    w.EndArray();
    w.EndObject();
  }
  w.EndArray();
  w.Key("edges"); w.StartArray();
  for (const auto& edge : scoped_graph.edges) {
    w.StartObject();
    w.Key("id"); w.String(edge.id.c_str());
    w.Key("from"); w.String(edge.from.c_str());
    w.Key("to"); w.String(edge.to.c_str());
    w.Key("kind"); w.String(edge.kind.c_str());
    w.Key("label"); w.String(edge.label.c_str());
    w.Key("can_animate"); w.Bool(edge.can_animate);
    w.EndObject();
  }
  w.EndArray();
  w.EndObject();
  res.set_header("Cache-Control", "private, no-store");
  res.set_content(sb.GetString(), "application/json");
}


} // namespace chdash
