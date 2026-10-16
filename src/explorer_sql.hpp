#pragma once

// Every statement of the Explorer is a pure function.
// The statements cover the catalog of the sidebar and of the graph, the card of a table, and the storage map.
// They also cover the lineage, the functions, the preview, and what the graph reads about the topology.
// The statements use no connection and no clock. The native tests compare each text with the text that the code sent before the split (tests/native/explorer_golden.hpp).
//
// A name that comes from a request or from the privileges of the runner is a query parameter. This applies to a database, a table or a cluster.
// Such a name is a parameter of the statement ({pN:String}, sql_params.hpp), never part of its text.
// A name that is an identifier of the statement goes through sql::quote_ident. This applies to the table of a SELECT or of a DESCRIBE.
// Every column is read as text (`toString(...)`). explorer_values.hpp decodes it.

#include "sql_params.hpp"

#include <string>
#include <vector>

namespace chdash {
namespace explorer {

// ---- the catalog of the graph (load_explorer_catalog) ----

// One row for each table of system.tables. A row holds the identity, the keys, the sizes and the modification time.
// The statement has no ORDER BY. The caller adds its own ORDER BY, or the filter of one table.
SqlStatement base_tables_sql();
SqlStatement base_tables_ordered_sql();
SqlStatement base_table_sql(const std::string& database, const std::string& table);
SqlStatement dictionaries_sql();
// The rows of a Log-family table. system.tables does not always know these tables.
SqlStatement table_row_count_sql(const std::string& database, const std::string& table);
SqlStatement parts_summary_sql();
SqlStatement index_bytes_sql();
SqlStatement projection_bytes_sql();
SqlStatement query_ingress_sql();
SqlStatement part_ingress_sql();
SqlStatement replicas_sql();
// The replica counts of tables. Each table costs one Keeper read. Only the tables that were asked for are read.
SqlStatement replica_counts_sql(const std::vector<std::string>& databases, const std::vector<std::string>& tables);
SqlStatement disks_with_host_sql();
SqlStatement parts_by_disk_sql();

// ---- the sidebar ----

// The tables of the allowed databases, with the least data that the sidebar shows. When there is one database, `database` narrows the list.
SqlStatement index_tables_sql(const std::vector<std::string>& databases);
SqlStatement index_tables_ordered_sql(const std::vector<std::string>& databases);
SqlStatement index_table_sql(const std::vector<std::string>& databases, const std::string& database, const std::string& table);
SqlStatement database_parts_sql(const std::string& database);
SqlStatement database_disk_bytes_sql(const std::string& database);
SqlStatement database_replicas_sql(const std::string& database);
SqlStatement database_totals_sql();

// ---- the storage map ----

SqlStatement storage_parts_sql(const std::vector<std::string>& databases);
SqlStatement storage_tables_sql(const std::vector<std::string>& databases);

// ---- the card of a table ----

SqlStatement table_summary_sql(const std::string& database, const std::string& table);
SqlStatement buffer_target_rows_sql(const std::string& database, const std::string& table);
SqlStatement dictionary_size_sql(const std::string& database, const std::string& table);
SqlStatement table_parts_sql(const std::string& database, const std::string& table);
SqlStatement table_index_bytes_sql(const std::string& database, const std::string& table);
SqlStatement table_projection_bytes_sql(const std::string& database, const std::string& table);
SqlStatement table_query_ingress_sql(const std::string& database, const std::string& table);
SqlStatement table_part_ingress_sql(const std::string& database, const std::string& table);
// The replica of the table. It has the set of its replicas when the server has the columns. Otherwise it has the base row (an older server).
SqlStatement table_replica_detail_sql(const std::string& database, const std::string& table);
SqlStatement table_replica_base_sql(const std::string& database, const std::string& table);

SqlStatement table_ddl_sql(const std::string& database, const std::string& table);
SqlStatement columns_sql(const std::string& database, const std::string& table);
SqlStatement describe_sql(const std::string& database, const std::string& table, bool with_subcolumns);
SqlStatement default_codecs_sql(const std::string& database, const std::string& table);
SqlStatement part_types_sql(const std::string& database, const std::string& table);
SqlStatement wide_column_sizes_sql(const std::string& database, const std::string& table);
SqlStatement wide_subcolumn_sizes_sql(const std::string& database, const std::string& table);
SqlStatement table_storage_sql(const std::string& database, const std::string& table);
SqlStatement disks_sql();
SqlStatement part_list_sql(const std::string& database, const std::string& table);
SqlStatement partition_list_sql(const std::string& database, const std::string& table);
SqlStatement skipping_indices_sql(const std::string& database, const std::string& table);
SqlStatement projections_sql(const std::string& database, const std::string& table);
SqlStatement projection_sizes_sql(const std::string& database, const std::string& table);
SqlStatement mutations_sql(const std::string& database, const std::string& table);
SqlStatement merges_sql(const std::string& database, const std::string& table);
SqlStatement distribution_queue_sql(const std::string& database, const std::string& table);
SqlStatement cluster_topology_sql(const std::string& cluster);
SqlStatement replication_queue_sql(const std::string& database, const std::string& table);

// ---- the lineage of a table ----

SqlStatement downstream_dependencies_sql(const std::string& database, const std::string& table);
// The objects of the server that route to a table or read it. These objects are Buffer, View, MaterializedView, LiveView and WindowView.
SqlStatement reverse_lineage_sql();
SqlStatement upstream_dependencies_sql(const std::string& database, const std::string& table);
SqlStatement dependency_engines_sql(const std::vector<std::string>& databases, const std::vector<std::string>& tables);

// ---- the functions and the preview ----

SqlStatement function_documentation_sql();
SqlStatement function_list_sql();
SqlStatement preview_columns_sql(const std::string& database, const std::string& table);
// `columns` are the names of the readable columns. The statement finalizes the columns whose declared type starts with AggregateFunction(.
// clickhouse-cpp cannot read a state. The statement then writes these columns as text.
SqlStatement preview_sql(const std::string& database, const std::string& table, const std::vector<std::string>& columns,
                         const std::vector<std::string>& types, size_t limit);

// ---- what the graph reads about the topology ----

SqlStatement graph_disks_sql();
SqlStatement graph_storage_policies_sql();
SqlStatement graph_tables_sql();
SqlStatement graph_dependencies_sql();
SqlStatement graph_dictionary_sources_sql();
SqlStatement graph_clusters_sql();
SqlStatement graph_refresh_probe_sql();

}  // namespace explorer
}  // namespace chdash
