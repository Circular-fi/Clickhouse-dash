#include "explorer_service.hpp"

#include "allowed_objects.hpp"
#include "time_util.hpp"

#include <algorithm>
#include <exception>
#include <stdexcept>
#include <utility>

namespace chdash {
namespace explorer {

namespace {

// A cache key holds the host, then the content of the entry.
// A key has NUL bytes. So a name with any other byte never merges two keys into one.
std::string key_of(const std::string& host_id, const char* kind, size_t kind_size) { return host_id + std::string(kind, kind_size); }

std::string catalog_key(const std::string& host_id) { return key_of(host_id, "\0catalog", 8); }
std::string graph_key(const std::string& host_id) { return key_of(host_id, "\0graph", 6); }
std::string functions_key(const std::string& host_id) { return key_of(host_id, "\0functions", 10); }
std::string storage_key(const std::string& host_id) { return key_of(host_id, "\0storage", 8); }
std::string list_prefix(const std::string& host_id) { return key_of(host_id, "\0catalog-list", 13); }

// The account of the system context of a host is the technical account. If there is none, it is the runner.
const std::string& system_uri_of(const HostSpec& host) { return host.system_uri.empty() ? host.runner_uri : host.system_uri; }

std::string reason_or(const std::string& reason, const char* fallback) { return reason.empty() ? std::string(fallback) : reason; }

}  // namespace

// ---------------------------------------------------------------------------
// The sidebar

Result<Cached<ExplorerCatalog>> ExplorerService::catalog(const RequestContext&, const HostSpec& host, const std::string& host_id,
                                                        const std::string& database_filter, bool refresh) const {
  using Out = Result<Cached<ExplorerCatalog>>;
  std::string list_key = list_prefix(host_id);
  list_key.push_back('\0');
  // 'A' is the list of all the databases. 'D' and a name is one database. A name that the caller chooses cannot change the tag, so no name
  // (for example "@databases") can reach the entry of the whole list, which needs a grant on the service.
  if (database_filter.empty()) {
    list_key.push_back('A');
  } else {
    list_key.push_back('D');
    list_key += database_filter;
  }
  const AclAccess access = access_of_(host);
  if (refresh) {
    // A global refresh reads the privileges of the runner again. It also reads the rich graph metadata again.
    // A scoped database refresh touches only that sidebar branch and the privileges of that database.
    // Nothing is removed. A read in progress is waited for. Every request that arrives meanwhile shares the next read.
    if (database_filter.empty()) {
      acl_.invalidate(access);
      stores_.catalog.invalidate(catalog_key(host_id));
      stores_.graph.invalidate(graph_key(host_id));
      stores_.functions.invalidate(functions_key(host_id));
      stores_.storage.invalidate(storage_key(host_id));
    } else {
      acl_.invalidate(access, database_filter);
    }
  }

  // After its TTL, the cached answer is served at once while one refresh runs. The fetch owns the data that it uses.
  auto result = stores_.list.get_revalidating(
      list_key,
      [this, host_spec = host, access, database_filter](ExplorerCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = connect_(host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }

        try {
          if (database_filter.empty()) {
            // The first paint shows only database names. Do not enumerate, DESCRIBE or permission-probe every table in every database.
            // That work is not needed to build the collapsed navigation tree.
            // A database that the discovery budget did not reach is listed too. Its name is what SHOW gives the runner. Its objects are checked when it is opened.
            const auto listed = acl_.databases(access);
            value = ExplorerCatalog{};
            value.generated_at_ms = static_cast<uint64_t>(now_ms());
            value.databases = listed->databases;
            value.databases.insert(value.databases.end(), listed->unverified.begin(), listed->unverified.end());
            std::sort(value.databases.begin(), value.databases.end());
            value.acl_truncated = listed->truncated;
            std::string summary_error;
            (void)load_explorer_database_summaries(*runner, value.databases, value.database_summaries, &summary_error);
            return true;
          }

          // The expanded branch needs only this database.
          // Its objects come from the runner ACL, from SHOW TABLES and the checks as the runner.
          // So the technical account never decides which object names reach the browser.
          // A branch is asked by its name. Its own answer decides, even when the kept database list does not name it yet (a database created since).
          const auto objects = acl_.objects(access, database_filter);
          if (objects->objects.empty()) {
            value = ExplorerCatalog{};
            value.generated_at_ms = static_cast<uint64_t>(now_ms());
            value.acl_truncated = objects->truncated;
            return true;
          }
          AllowedObjectSet scoped_allowed;
          for (const auto& object : objects->objects) scoped_allowed.add_table(object);

          auto system = connect_(system_uri_of(host_spec), &error);
          if (!system) {
            code = "system_context_unavailable";
            message = reason_or(error, "Cannot connect to the system context.");
            return false;
          }
          if (!load_explorer_catalog_index(*system, *runner, scoped_allowed, value, &error)) {
            code = "explorer_catalog_failed";
            message = reason_or(error, "Unable to load Explorer object list.");
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
          runner->invalidate();
          return false;
        }
      },
      refresh);

  if (!result.has_value || !result.value) {
    return Out::fail(make_error(503, result.error_code.empty() ? "explorer_unavailable" : result.error_code,
                                result.error_message.empty() ? "Explorer object list is unavailable." : result.error_message));
  }
  return Out::ok(Cached<ExplorerCatalog>{result.value, result.stale});
}

// ---------------------------------------------------------------------------
// The storage map

Result<Cached<ExplorerStorageMap>> ExplorerService::storage(const RequestContext&, const HostSpec& host, const std::string& host_id, bool refresh) const {
  using Out = Result<Cached<ExplorerStorageMap>>;
  const AclAccess access = access_of_(host);
  if (refresh) acl_.invalidate(access);

  auto result = stores_.storage.get_revalidating(
      storage_key(host_id),
      [this, host_spec = host, access](ExplorerStorageMap& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = connect_(host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }
        auto system = connect_(system_uri_of(host_spec), &error);
        if (!system) {
          code = "system_context_unavailable";
          message = reason_or(error, "Cannot connect to the system context.");
          return false;
        }
        try {
          AclView acl(acl_, access);
          if (!load_explorer_storage_map(*system, *runner, acl, value, &error)) {
            code = "explorer_storage_failed";
            message = reason_or(error, "Unable to load the Explorer storage distribution.");
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
          runner->invalidate();
          system->invalidate();
          return false;
        }
      },
      refresh);

  if (!result.has_value || !result.value) {
    return Out::fail(make_error(503, result.error_code.empty() ? "explorer_unavailable" : result.error_code,
                                result.error_message.empty() ? "Explorer storage distribution is unavailable." : result.error_message));
  }
  return Out::ok(Cached<ExplorerStorageMap>{result.value, result.stale});
}

// ---------------------------------------------------------------------------
// The card of a table

Result<Cached<ExplorerTableDetail>> ExplorerService::table(const RequestContext&, const HostSpec& host, const std::string& host_id,
                                                          const std::string& database, const std::string& table, bool refresh) const {
  using Out = Result<Cached<ExplorerTableDetail>>;
  std::string detail_key = key_of(host_id, "\0table-detail\0", 14);
  detail_key += database;
  detail_key.push_back('\0');
  detail_key += table;
  const AclAccess access = access_of_(host);
  if (refresh) acl_.invalidate(access, database);

  auto result = stores_.table_detail.get(
      detail_key,
      [&](ExplorerTableDetail& value, std::string& code, std::string& message) {
        std::string error;
        auto system = connect_(system_uri_of(host), &error);
        if (!system) {
          code = "system_context_unavailable";
          message = reason_or(error, "Cannot connect to the system metadata context.");
          return false;
        }
        auto runner = connect_(host.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }

        AllowedObjectSet scoped_allowed;
        try {
          auto source = access.connect(&error);
          if (!source) throw std::runtime_error(reason_or(error, "Cannot connect to the runner context."));
          auto entry = discover_allowed_table(*source, database, table);
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
        if (!load_explorer_table_summary(*system, *runner, scoped_allowed, database, table, summary, &error)) {
          code = "explorer_table_summary_failed";
          message = reason_or(error, "Unable to load Explorer table summary.");
          return false;
        }
        try {
          AclView acl(acl_, access);
          if (!load_explorer_table_detail(*system, *runner, acl, scoped_allowed, database, table, summary, value, &error)) {
            code = "explorer_table_metadata_failed";
            message = reason_or(error, "Unable to load Explorer table metadata.");
            return false;
          }
        } catch (const AclUnavailable& e) {
          code = e.code;
          message = e.what();
          return false;
        }
        value.generated_at_ms = static_cast<uint64_t>(now_ms());
        return true;
      },
      refresh);

  if (!result.has_value || !result.value) {
    const std::string code = result.error_code.empty() ? "explorer_table_metadata_failed" : result.error_code;
    return Out::fail(make_error(code == "object_not_found" ? 404 : 503, code,
                                result.error_message.empty() ? "Unable to load Explorer table metadata." : result.error_message));
  }
  return Out::ok(Cached<ExplorerTableDetail>{result.value, result.stale});
}

// ---------------------------------------------------------------------------
// The functions

Result<Cached<ExplorerFunctionsCatalog>> ExplorerService::functions(const RequestContext&, const HostSpec& host, const std::string& host_id,
                                                                    bool refresh) const {
  using Out = Result<Cached<ExplorerFunctionsCatalog>>;
  // Function discovery runs with runner_uri on purpose.
  // Unlike table observability, there is no reason to raise this metadata query through the technical metadata account.
  // The runner remains the visibility boundary of ClickHouse.
  auto result = stores_.functions.get(
      functions_key(host_id),
      [&](ExplorerFunctionsCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto runner = connect_(host.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }
        if (!load_explorer_functions(*runner, value, &error)) {
          code = "functions_unavailable";
          message = reason_or(error, "Function metadata is unavailable on this server.");
          return false;
        }
        return true;
      },
      refresh);
  if (!result.has_value || !result.value) {
    return Out::fail(make_error(503, result.error_code.empty() ? "functions_unavailable" : result.error_code,
                                result.error_message.empty() ? "Function metadata is unavailable on this server." : result.error_message));
  }
  return Out::ok(Cached<ExplorerFunctionsCatalog>{result.value, result.stale});
}

// ---------------------------------------------------------------------------
// The preview

Result<ExplorerPreview> ExplorerService::preview(const RequestContext&, const HostSpec& host, const std::string& database, const std::string& table,
                                                size_t limit) const {
  using Out = Result<ExplorerPreview>;
  std::string error;
  auto runner = connect_(host.runner_uri, &error);
  if (!runner) return Out::fail(make_error(503, "runner_unavailable", reason_or(error, "Cannot connect to the runner context.")));

  AllowedObjectSet allowed;
  try {
    auto source = access_of_(host).connect(&error);
    if (!source) throw std::runtime_error(reason_or(error, "Cannot connect to the runner context."));
    auto entry = discover_allowed_table(*source, database, table);
    if (!entry) return Out::fail(make_error(404, "object_not_found", "Object not found or has no readable columns."));
    allowed.add_table(std::move(*entry));
  } catch (const std::exception& e) {
    runner->invalidate();
    return Out::fail(make_error(503, "acl_discovery_failed", e.what()));
  }

  ExplorerPreview preview;
  if (!load_explorer_preview(*runner, allowed, database, table, limit, preview, &error)) {
    return Out::fail(make_error(503, "preview_failed", reason_or(error, "Unable to preview object data.")));
  }
  return Out::ok(std::move(preview));
}

// ---------------------------------------------------------------------------
// The graph

// The authorized graph of one host. It first runs the ACL discovery of the runner.
// Then it adds the system-context catalog and the graph data, for those objects only.
// The graph and definition routes share it. Both routes use the same AllowedObjectSet boundary.
Result<ExplorerService::Snapshot> ExplorerService::graph_snapshot(const HostSpec& host, const std::string& host_id, bool refresh) const {
  using Out = Result<Snapshot>;
  const AclAccess access = access_of_(host);
  if (refresh) {
    acl_.invalidate(access);
    // Sidebar entries are keyed "<scope>\0catalog-list\0A" (all the databases) or "<scope>\0catalog-list\0D<database>".
    stores_.list.invalidate_prefix(list_prefix(host_id));
    stores_.functions.invalidate(functions_key(host_id));
  }

  // Every object that the runner reads, at table level. The checks are CHECK GRANT and zero-row probes, run as the runner. The result is kept per identity.
  std::shared_ptr<const AclTableSet> allowed;
  try {
    allowed = acl_.table_set(access);
  } catch (const AclUnavailable& e) {
    return Out::fail(make_error(503, e.code, e.what()));
  }

  const std::string system_uri = system_uri_of(host);
  const ExplorerIdentities identities{access.key};
  // After their TTL, both cached answers are served at once while one refresh runs. The fetches own the data that they use.
  auto catalog_result = stores_.catalog.get_revalidating(
      catalog_key(host_id),
      [this, host_spec = host, system_uri, allowed, identities](ExplorerCatalog& value, std::string& code, std::string& message) {
        std::string error;
        auto system = connect_(system_uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = connect_(host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }
        if (!load_explorer_catalog(*system, *runner, caches_, identities, allowed->allowed, value, &error)) {
          code = "explorer_catalog_failed"; message = error; return false;
        }
        value.acl_truncated = allowed->truncated;
        return true;
      },
      refresh);
  if (!catalog_result.has_value || !catalog_result.value) {
    return Out::fail(make_error(503, catalog_result.error_code.empty() ? "explorer_unavailable" : catalog_result.error_code,
                                catalog_result.error_message.empty() ? "Explorer metadata is unavailable." : catalog_result.error_message));
  }

  const std::shared_ptr<const ExplorerCatalog> catalog = catalog_result.value;
  auto graph_result = stores_.graph.get_revalidating(
      graph_key(host_id),
      [this, host_spec = host, system_uri, allowed, catalog, identities](ExplorerGraph& value, std::string& code, std::string& message) {
        std::string error;
        auto system = connect_(system_uri, &error);
        if (!system) { code = "system_context_unavailable"; message = error; return false; }
        auto runner = connect_(host_spec.runner_uri, &error);
        if (!runner) {
          code = "runner_unavailable";
          message = reason_or(error, "Cannot connect to the runner context.");
          return false;
        }
        if (!load_explorer_graph(*system, *runner, caches_, identities.runner, allowed->allowed, *catalog, value, &error)) {
          code = "explorer_graph_failed"; message = error; return false;
        }
        return true;
      },
      refresh);
  if (!graph_result.has_value || !graph_result.value) {
    return Out::fail(make_error(503, graph_result.error_code.empty() ? "explorer_graph_unavailable" : graph_result.error_code,
                                graph_result.error_message.empty() ? "Explorer graph is unavailable." : graph_result.error_message));
  }

  Snapshot snapshot;
  snapshot.graph = graph_result.value;
  snapshot.stale = graph_result.stale || catalog_result.stale;
  return Out::ok(std::move(snapshot));
}

Result<GraphScopeAnswer> ExplorerService::graph(const RequestContext&, const HostSpec& host, const std::string& host_id, const GraphScopeRequest& scope,
                                               bool lineage_enabled, bool storage_enabled, bool refresh) const {
  using Out = Result<GraphScopeAnswer>;
  auto snapshot = graph_snapshot(host, host_id, refresh);
  if (!snapshot.value) return Out::fail(std::move(snapshot.error));
  GraphScopeAnswer answer;
  answer.graph = snapshot.value->graph;
  answer.stale = snapshot.value->stale;
  const ExplorerGraphIndex* index = answer.graph->index.get();
  answer.scoped = scope_graph(*answer.graph, scope, lineage_enabled, storage_enabled, index);
  answer.scope_has_more = logical_scope_has_more(*answer.graph, scope, answer.scoped, lineage_enabled, index);
  answer.storage_available = logical_storage_available_ids(*answer.graph, index);
  return Out::ok(std::move(answer));
}

// The edge or node panel explains one logical object. It shows its SELECT, its destination or source, and its Distributed routing.
// This answer uses only the cached authorized graph. An object outside AllowedObjectSet is absent (404). No SQL runs for the caller.
Result<DefinitionAnswer> ExplorerService::definition(const RequestContext&, const HostSpec& host, const std::string& host_id, const std::string& database,
                                                    const std::string& table, bool refresh) const {
  using Out = Result<DefinitionAnswer>;
  auto snapshot = graph_snapshot(host, host_id, refresh);
  if (!snapshot.value) return Out::fail(std::move(snapshot.error));
  DefinitionAnswer answer;
  answer.graph = snapshot.value->graph;
  answer.stale = snapshot.value->stale;
  // Find the node by the names of the object. Do not use an id, because two objects can share one id.
  for (const auto& candidate : answer.graph->nodes) {
    if (candidate.layer == "logical" && candidate.database == database && candidate.name == table) {
      answer.node = &candidate;
      break;
    }
  }
  if (!answer.node) return Out::fail(make_error(404, "unknown_object", "Object is not visible in the Explorer graph."));
  static const ExplorerGraphDefinition kNone;
  const auto it = answer.graph->definitions.find(answer.node->id);
  answer.definition = it == answer.graph->definitions.end() ? &kNone : &it->second;
  return Out::ok(std::move(answer));
}

}  // namespace explorer
}  // namespace chdash
