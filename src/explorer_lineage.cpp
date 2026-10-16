// The lineage of a table, and the totals that give its size a scale.
// The lineage shows what a table reads from, and what reads it.
// It uses the structured dependencies of system.tables.
// It also uses the DDL of the views, the Buffer tables and the materialized views of the server.
// Every neighbour passes through the privileges of the runner before it is named.
#include "explorer_detail.hpp"

#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_values.hpp"
#include "sql_structure.hpp"

#include <algorithm>
#include <map>

namespace chdash {

using namespace explorer;

namespace explorer {

bool TableDetailReader::lineage_visible(const std::string& database, const std::string& table) {
  if (allowed_.allows_table(database, table)) return true;
  try {
    return acl_.readable(database, table);
  } catch (const std::exception&) {
    lineage_acl_failed_ = true;
    return false;
  }
}

void TableDetailReader::append_dependency(const std::string& database, const std::string& table, const char* relation, const char* kind) {
  // ClickHouse can expose an internal `row`/`_row` pseudo dependency for view-like objects.
  // It is implementation metadata. It is not a navigable ClickHouse object. Never show it as Lineage.
  if (is_row_pseudo_object(table)) return;
  if (!lineage_visible(database, table)) return;
  auto key = std::make_tuple(database, table, std::string(relation));
  const auto [seen, inserted] = dependency_seen_.emplace(key, out_.dependencies.size());
  if (!inserted) {
    // dependencies_* only states that a link exists. A later source that knows the kind of link (MV, View or Buffer) refines it.
    auto& existing = out_.dependencies[seen->second];
    if (existing.kind == "dependency") existing.kind = kind;
    return;
  }
  out_.dependencies.push_back({database, table, relation, kind, {}});
}

bool TableDetailReader::read_lineage() {
  // The structured lineage is filtered by security *before* it is exposed. On system.tables, dependencies_* lists the objects that depend on the
  // current object. Read both the selected row (downstream) and the reverse relation (upstream). Then a view or MV does not show an
  // empty Lineage tab by mistake.
  //
  // The per-object ACL set that this function receives contains only the selected table. It cannot decide whether a *related* object is
  // visible. Check each neighbour alone. Run CHECK GRANT, then a zero-row probe, as the runner. The AclService keeps the result.
  // Never enumerate the database of a neighbour. The check can run inside the callback of a system read, and it never throws there.
  // When the runner privileges cannot be read, the neighbour is not shown. The answer then says that the lineage is incomplete. It never shows a silent "none".

  // A MATERIALIZED VIEW ... TO db.table has an explicit sink. dependencies_* does not show this sink on every supported build.
  // Parse the bounded top-level TO clause from the server-generated DDL.
  // Then the MV detail always shows both its SELECT inputs and its target, if the runner can read them.
  if (auto target = sql::materialized_view_target(out_.create_table_query, database_)) {
    append_dependency(target->database, target->table, "downstream", "materialized_view");
  }

  // Distributed(cluster, database, table, ...) routes reads and writes to the local table on every shard.
  // The local table is the only data source of this object.
  if (!out_.distributed_database.empty() && !out_.distributed_table.empty()) {
    append_dependency(out_.distributed_database, out_.distributed_table, "downstream", "distributed_route");
  }

  // Buffer(database, table, ...) has a routing edge to its flush destination.
  // Show this relation in the same downstream model as Views, MVs and ordinary tables.
  // Do not render a one-off "Flush target" card in the browser.
  if (summary_.engine == "Buffer") {
    const auto args = sql::engine_arguments(summary_.engine_full, "Buffer");
    if (args.size() >= 2 && !args[0].empty() && !args[1].empty()) append_dependency(args[0], args[1], "downstream", "buffer");
  }

  const bool downstream_loaded = try_select(system_, downstream_dependencies_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        append_dependency(block_string_at(block, 0, row), block_string_at(block, 1, row), "downstream");
      }
    }, &section_error_);
  if (!downstream_loaded) {
    if (!degrade("downstream_lineage", section_error_)) return fail("Downstream lineage query failed: " + section_error_);
  }

  // Reverse relations need server-wide system.tables passes over three sources:
  //   * Buffer(database, table, ...) routing: ClickHouse does not always materialize Buffer destinations in dependencies_*.
  //     Reverse it here to keep the Buffer <-> target relation symmetric.
  //   * as_select of views and MVs: dependencies_* is not complete for ordinary View objects on all supported builds.
  //     The one SQL lexer (sql::relation_sources) adds the missing links. It follows subqueries and CTEs. It leaves out table functions and ARRAY JOIN.
  //   * dependencies_* rows that name the selected object (upstream).
  // system.tables can apply database, name and engine predicates *before* it materializes expensive columns (engine_full, as_select).
  // These columns format the stored DDL of every object. A single query with `OR has(dependencies_table, ...)` skips this optimization.
  // It computes the columns for the whole server (125 ms at ~2k objects). So the engine-filtered scan and the dependency lookup are two cheap queries (~30 + 15 ms).
  // Every returned name passes through the same visibility filter.
  section_error_.clear();
  const bool reverse_lineage_loaded = try_select(system_, reverse_lineage_sql(),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        const std::string object_db = block_string_at(block, 0, row);
        const std::string object_table = block_string_at(block, 1, row);
        const std::string object_engine = block_string_at(block, 2, row);
        if (object_engine == "Buffer") {
          const std::string& buffer_db = object_db;
          const std::string& buffer_table = object_table;
          const auto args = sql::engine_arguments(block_string_at(block, 3, row), "Buffer");
          if (args.size() >= 2 && args[0] == database_ && args[1] == table_) {
            append_dependency(buffer_db, buffer_table, "upstream", "buffer");
          }
        }
        const std::string as_select = block_string_at(block, 4, row);
        if (as_select.empty()) continue;
        const std::string& view_db = object_db;
        const std::string& view_table = object_table;
        const bool is_selected_view = view_db == database_ && view_table == table_;
        for (const auto& source : sql::relation_sources(as_select, view_db)) {
          const char* view_kind = object_engine == "MaterializedView" ? "materialized_view" : "view";
          if (is_selected_view) append_dependency(source.database, source.table, "upstream", view_kind);
          if (source.database == database_ && source.table == table_) append_dependency(view_db, view_table, "downstream", view_kind);
        }
      }
    }, &section_error_);
  if (!reverse_lineage_loaded) {
    if (!degrade("buffer_reverse_lineage", section_error_)) return fail("Buffer reverse-lineage query failed: " + section_error_);
  }

  section_error_.clear();
  const bool upstream_loaded = try_select(system_, upstream_dependencies_sql(database_, table_),
    [&](const clickhouse::Block& block) {
      for (size_t row = 0; row < block.GetRowCount(); ++row) {
        append_dependency(block_string_at(block, 0, row), block_string_at(block, 1, row), "upstream");
      }
    }, &section_error_);
  if (!upstream_loaded) {
    if (!degrade("upstream_lineage", section_error_)) return fail("Upstream lineage query failed: " + section_error_);
  }

  // Engines of the related objects, for their type icon.
  // Every name here already passed the runner visibility check above.
  // The lookup is one database and name filtered read of system.tables. It is best-effort.
  if (!out_.dependencies.empty()) {
    std::vector<std::string> dep_databases;
    std::vector<std::string> dep_tables;
    for (const auto& dep : out_.dependencies) {
      dep_databases.push_back(dep.database);
      dep_tables.push_back(dep.table);
    }
    std::sort(dep_databases.begin(), dep_databases.end());
    dep_databases.erase(std::unique(dep_databases.begin(), dep_databases.end()), dep_databases.end());
    std::sort(dep_tables.begin(), dep_tables.end());
    dep_tables.erase(std::unique(dep_tables.begin(), dep_tables.end()), dep_tables.end());
    std::map<std::pair<std::string, std::string>, std::string> engines;
    std::string engine_error;
    (void)try_select(system_, dependency_engines_sql(dep_databases, dep_tables),
      [&](const clickhouse::Block& block) {
        for (size_t row = 0; row < block.GetRowCount(); ++row) {
          engines[{block_string_at(block, 0, row), block_string_at(block, 1, row)}] = block_string_at(block, 2, row);
        }
      }, &engine_error);
    for (auto& dep : out_.dependencies) {
      const auto it = engines.find({dep.database, dep.table});
      if (it != engines.end()) dep.engine = it->second;
    }
  }

  if (lineage_acl_failed_) out_.unavailable_sections.push_back("lineage_visibility");
  return true;
}

void TableDetailReader::read_footprint() {
  // Scope totals must be larger than the selected table.
  // The per-table ACL object set contains only this table on purpose. If you use it here, Table / Database and Table / ClickHouse report 100%. That result is wrong.
  // Aggregate the runner-visible catalog instead. Keep only the database-level totals.
  section_error_.clear();
  try {
    const auto visible_databases = acl_.databases();
    std::vector<ExplorerDatabaseSummary> summaries;
    if (load_explorer_database_summaries(runner_, visible_databases, summaries, &section_error_)) {
      uint64_t clickhouse_bytes = 0;
      bool database_seen = false;
      for (const auto& summary_row : summaries) {
        clickhouse_bytes += summary_row.bytes;
        if (summary_row.name == database_) {
          out_.database_footprint_bytes = summary_row.bytes;
          database_seen = true;
        }
      }
      if (!summaries.empty()) out_.clickhouse_footprint_bytes = clickhouse_bytes;
      if (!database_seen) out_.database_footprint_bytes.reset();
    } else {
      out_.unavailable_sections.push_back("footprint_scope");
    }
  } catch (const std::exception&) {
    out_.unavailable_sections.push_back("footprint_scope");
  }
}

}  // namespace explorer
}  // namespace chdash
