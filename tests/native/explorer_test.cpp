// Unit tests of the Explorer, below its routes.
// The tests cover these parts: the statements (src/explorer_sql.cpp), the rules for the rows that were read (src/explorer_rules.cpp),
// the readers of the catalog, the sidebar, the storage map, the card of a table, the functions and the preview.
// These parts run on a fake executor. There is no ClickHouse server.
// The tests also cover the TTL of a table (src/explorer_ttl.cpp), and the graph (src/explorer_graph_build.cpp,
// src/explorer_graph_scope.cpp) with its JSON.
//
// The statements are compared with the ones that the code sent before the split of explorer_catalog.cpp, explorer_graph.cpp and api_explorer.cpp
// for the same requests (explorer_golden.hpp, the text with each query parameter written in place). A statement that changes its text fails here.
// A change on purpose must change the expected text in the same commit.
//
// Build: cmake -S src -B build -DCHDASH_BUILD_APP=OFF -DCHDASH_EMBED_STATIC=OFF -DCHDASH_BUILD_EXPLORER_TESTS=ON
//        cmake --build build --target chdash_explorer_test
// Run:   ./build/chdash_explorer_test   (exit code 0 means that every check passed)

#include "acl_service.hpp"
#include "explorer_catalog.hpp"
#include "explorer_golden.hpp"
#include "explorer_graph.hpp"
#include "explorer_graph_build.hpp"
#include "explorer_graph_scope.hpp"
#include "explorer_json.hpp"
#include "explorer_service.hpp"
#include "explorer_scope_reference.hpp"
#include "explorer_rules.hpp"
#include "explorer_sql.hpp"
#include "explorer_ttl.hpp"
#include "explorer_values.hpp"
#include "fake_executor.hpp"
#include "native_check.hpp"
#include "sql_structure.hpp"

#include <rapidjson/document.h>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <random>
#include <set>
#include <string>
#include <utility>
#include <vector>

using namespace chdash;
using namespace chdash::explorer;
using namespace nt;

namespace {

// A statement with every {pN:String} written in place as a quoted text. The numbering of the parameters is not part of the text.
std::string inlined(const SqlStatement& statement) {
  std::string out = statement.sql;
  for (const auto& [name, value] : statement.params.list()) {
    std::string quoted = "'";
    for (const char c : value) {
      if (c == '\\' || c == '\'') quoted.push_back('\\');
      quoted.push_back(c);
    }
    quoted += "'";
    const std::string mark = "{" + name + ":String}";
    for (size_t at = out.find(mark); at != std::string::npos; at = out.find(mark, at + quoted.size())) out.replace(at, mark.size(), quoted);
  }
  return out;
}

// The golden text, with its @LIST@ written as the quoted names of a test.
std::string with_list(std::string golden, const std::vector<std::string>& names) {
  std::string list;
  for (const auto& name : names) list += (list.empty() ? "" : ", ") + std::string("'") + name + "'";
  const size_t at = golden.find("@LIST@");
  if (at != std::string::npos) golden.replace(at, 6, list);
  return golden;
}

const std::string UI = "chdash_ui";
const std::string OBS = "weather_observations";

// ---- the statements, against the text that the code before the split sent ----

void test_catalog_statements_are_unchanged() {
  CHECK_EQ(inlined(base_tables_ordered_sql()), std::string(golden::kBaseTablesOrdered));
  CHECK_EQ(inlined(dictionaries_sql()), std::string(golden::kDictionaries));
  CHECK_EQ(inlined(table_row_count_sql(UI, "station_dictionary_source")), std::string(golden::kTableRowCount));
  CHECK_EQ(inlined(parts_summary_sql()), std::string(golden::kPartsSummary));
  CHECK_EQ(inlined(projection_bytes_sql()), std::string(golden::kProjectionBytes));
  CHECK_EQ(inlined(query_ingress_sql()), std::string(golden::kQueryIngress));
  CHECK_EQ(inlined(part_ingress_sql()), std::string(golden::kPartIngress));
  CHECK_EQ(inlined(replicas_sql()), std::string(golden::kReplicas));
  CHECK_EQ(inlined(parts_by_disk_sql()), std::string(golden::kPartsByDisk));
  CHECK_EQ(inlined(disks_with_host_sql()), std::string(golden::kDisksWithHost));
  // Only an older server, or a server that fails, asks some statements. These statements have no capture. Their shape is like the shape of their neighbours.
  CHECK_EQ(inlined(base_table_sql("a'b", "c")), std::string(golden::kBaseTablesOrdered).substr(0, std::string(golden::kBaseTablesOrdered).size() - 23) +
                                                   "AND database = 'a\\'b' AND name = 'c' LIMIT 1");
  CHECK(index_bytes_sql().sql.find("secondary_indices_compressed_bytes") != std::string::npos);
  CHECK_EQ(inlined(replica_counts_sql({"a", "b"}, {"t1", "t2"})),
           std::string("SELECT toString(database), toString(`table`), toString(total_replicas), toString(active_replicas) FROM system.replicas WHERE "
                       "database IN ('a', 'b') AND `table` IN ('t1', 't2')"));
}

void test_sidebar_statements_are_unchanged() {
  CHECK_EQ(inlined(index_tables_ordered_sql({"chdash_perf"})), std::string(golden::kIndexTablesDb));
  CHECK_EQ(inlined(database_parts_sql("chdash_perf")), std::string(golden::kDatabaseParts));
  CHECK_EQ(inlined(database_disk_bytes_sql("chdash_perf")), std::string(golden::kDatabaseDiskBytes));
  CHECK_EQ(inlined(database_replicas_sql("chdash_perf")), std::string(golden::kDatabaseReplicas));
  CHECK_EQ(inlined(database_totals_sql()), std::string(golden::kDatabaseTotals));
  // With several databases, the statement has no database filter. One object is asked by name.
  CHECK(index_tables_sql({"a", "b"}).sql.find("AND database =") == std::string::npos);
  CHECK(index_tables_sql({"a"}).sql.find("AND database = {p1:String}") != std::string::npos);
  CHECK_EQ(inlined(index_table_sql({"a"}, "a", "t")).substr(inlined(index_table_sql({"a"}, "a", "t")).find("AND database = 'a' AND name")),
           std::string("AND database = 'a' AND name = 't' LIMIT 1"));
}

void test_storage_statements_are_unchanged() {
  const std::vector<std::string> databases = {"alpha", "beta"};
  CHECK_EQ(inlined(storage_parts_sql(databases)), with_list(golden::kStorageParts, databases));
  CHECK_EQ(inlined(storage_tables_sql(databases)), with_list(golden::kStorageTables, databases));
}

void test_table_card_statements_are_unchanged() {
  CHECK_EQ(inlined(table_summary_sql(UI, OBS)), std::string(golden::kTableSummary));
  CHECK_EQ(inlined(buffer_target_rows_sql(UI, "weather_alert_target")), std::string(golden::kBufferTargetRows));
  CHECK_EQ(inlined(dictionary_size_sql(UI, "station_dictionary")), std::string(golden::kDictionarySize));
  CHECK_EQ(inlined(table_parts_sql(UI, OBS)), std::string(golden::kTableParts));
  CHECK_EQ(inlined(table_index_bytes_sql(UI, OBS)), std::string(golden::kTableIndexBytes));
  CHECK_EQ(inlined(table_projection_bytes_sql(UI, OBS)), std::string(golden::kTableProjectionBytes));
  CHECK_EQ(inlined(table_query_ingress_sql(UI, OBS)), std::string(golden::kTableQueryIngress));
  CHECK_EQ(inlined(table_part_ingress_sql(UI, OBS)), std::string(golden::kTablePartIngress));
  CHECK_EQ(inlined(table_replica_detail_sql("chdash_repl", "replicated_events")), std::string(golden::kTableReplicaDetail));
  // The base form of the replica row. A server without the extra columns uses this form.
  CHECK_EQ(inlined(table_replica_base_sql("chdash_repl", "replicated_events")),
           std::string("SELECT toString(total_replicas), toString(active_replicas), toString(queue_size), toString(absolute_delay), toString(is_readonly), "
                       "toString(is_session_expired), toString(replica_name), toString(zookeeper_path) FROM system.replicas WHERE database = 'chdash_repl' "
                       "AND `table` = 'replicated_events' LIMIT 1"));
  CHECK_EQ(inlined(table_ddl_sql(UI, OBS)), std::string(golden::kTableDdl));
  CHECK_EQ(inlined(columns_sql(UI, OBS)), std::string(golden::kColumns));
  CHECK_EQ(inlined(describe_sql(UI, OBS, true)), std::string(golden::kDescribeSubcolumns));
  CHECK_EQ(inlined(describe_sql(UI, OBS, false)), std::string(golden::kDescribe));
  CHECK_EQ(inlined(default_codecs_sql(UI, OBS)), std::string(golden::kDefaultCodecs));
  CHECK_EQ(inlined(part_types_sql(UI, OBS)), std::string(golden::kPartTypes));
  CHECK_EQ(inlined(wide_column_sizes_sql(UI, OBS)), std::string(golden::kWideColumnSizes));
  CHECK_EQ(inlined(wide_subcolumn_sizes_sql(UI, OBS)), std::string(golden::kWideSubcolumnSizes));
  CHECK_EQ(inlined(table_storage_sql(UI, OBS)), std::string(golden::kTableStorage));
  CHECK_EQ(inlined(disks_sql()), std::string(golden::kDisks));
  CHECK_EQ(inlined(part_list_sql(UI, OBS)), std::string(golden::kPartList));
  CHECK_EQ(inlined(partition_list_sql(UI, OBS)), std::string(golden::kPartitionList));
  CHECK_EQ(inlined(skipping_indices_sql(UI, OBS)), std::string(golden::kSkippingIndices));
  CHECK_EQ(inlined(projections_sql(UI, OBS)), std::string(golden::kProjections));
  CHECK_EQ(inlined(projection_sizes_sql(UI, OBS)), std::string(golden::kProjectionSizes));
  CHECK_EQ(inlined(mutations_sql(UI, OBS)), std::string(golden::kMutations));
  CHECK_EQ(inlined(merges_sql(UI, OBS)), std::string(golden::kMerges));
  CHECK_EQ(inlined(distribution_queue_sql("chdash_repl", "replicated_events_all")), std::string(golden::kDistributionQueue));
  CHECK_EQ(inlined(cluster_topology_sql("chdash_cluster")), std::string(golden::kClusterTopology));
  CHECK_EQ(inlined(replication_queue_sql("chdash_repl", "replicated_daily")), std::string(golden::kReplicationQueue));
}

void test_lineage_functions_and_preview_statements_are_unchanged() {
  CHECK_EQ(inlined(downstream_dependencies_sql(UI, OBS)), std::string(golden::kDownstream));
  CHECK_EQ(inlined(reverse_lineage_sql()), std::string(golden::kReverseLineage));
  CHECK_EQ(inlined(upstream_dependencies_sql(UI, OBS)), std::string(golden::kUpstream));
  CHECK_EQ(inlined(dependency_engines_sql({UI}, {"a", "b"})), with_list(golden::kDependencyEngines, {"a", "b"}));
  CHECK_EQ(inlined(function_documentation_sql()), std::string(golden::kFunctionDocumentation));
  CHECK_EQ(inlined(function_list_sql()), std::string(golden::kFunctionList));
  CHECK_EQ(inlined(preview_columns_sql(UI, OBS)), std::string(golden::kDescribe));
  CHECK_EQ(inlined(preview_sql(UI, "memory_weather", {"id", "station_id"}, {"UInt64", "String"}, 7)), std::string(golden::kPreviewMemory));
  CHECK_EQ(inlined(preview_sql(UI, "weather_daily_summary", {"observation_date", "city", "observation_count", "average_temperature"},
                               {"Date", "String", "AggregateFunction(count)", "AggregateFunction(avg, Float64)"}, 7)),
           std::string(golden::kPreviewAggregate));
  // A name with a back quote is an identifier of the statement, quoted. It never ends the quote.
  const std::string tricky = preview_sql("d`b", "t`x", {"c`1"}, {"String"}, 3).sql;
  CHECK_EQ(tricky, std::string("SELECT `c\\`1` FROM `d\\`b`.`t\\`x` LIMIT 3"));
}

void test_graph_statements_are_unchanged() {
  CHECK_EQ(inlined(graph_disks_sql()), std::string(golden::kGraphDisks));
  CHECK_EQ(inlined(graph_storage_policies_sql()), std::string(golden::kGraphStoragePolicies));
  CHECK_EQ(inlined(graph_tables_sql()), std::string(golden::kGraphTables));
  CHECK_EQ(inlined(graph_dependencies_sql()), std::string(golden::kGraphDependencies));
  CHECK_EQ(inlined(graph_dictionary_sources_sql()), std::string(golden::kGraphDictionarySources));
  CHECK_EQ(inlined(graph_clusters_sql()), std::string(golden::kGraphClusters));
  CHECK_EQ(inlined(graph_refresh_probe_sql()), std::string(golden::kGraphRefreshProbe));
}

void test_a_name_is_a_parameter_of_a_statement() {
  // A request, or the privileges of the runner name, never reaches the text of a statement.
  const std::string evil = "x' OR 1=1 --\\";
  for (const SqlStatement& statement :
       {table_summary_sql(evil, evil), table_ddl_sql(evil, evil), columns_sql(evil, evil), part_list_sql(evil, evil), mutations_sql(evil, evil),
        table_query_ingress_sql(evil, evil), cluster_topology_sql(evil), downstream_dependencies_sql(evil, evil), upstream_dependencies_sql(evil, evil),
        dependency_engines_sql({evil}, {evil}), storage_parts_sql({evil}), database_parts_sql(evil), index_table_sql({evil}, evil, evil),
        buffer_target_rows_sql(evil, evil), table_replica_detail_sql(evil, evil)}) {
    CHECK(statement.sql.find("OR 1=1") == std::string::npos);
    CHECK(statement.sql.find(evil) == std::string::npos);
    CHECK(!statement.params.list().empty());
    for (const auto& [name, value] : statement.params.list()) CHECK(value == evil || value == evil + "." + evil);
  }
  // An identifier of a statement is quoted.
  CHECK_EQ(table_row_count_sql("d`b", "t").sql, std::string("SELECT toString(count()) FROM `d\\`b`.`t`"));
  CHECK_EQ(describe_sql("a", "b`c", true).sql, std::string("DESCRIBE TABLE `a`.`b\\`c` SETTINGS describe_include_subcolumns = 1"));
}


// ---- the rules on the rows that were read ----

ExplorerTableSummary table_summary(const std::string& database, const std::string& name, const std::string& engine) {
  ExplorerTableSummary summary;
  summary.database = database;
  summary.name = name;
  summary.engine = engine;
  return summary;
}

void test_the_health_of_a_table() {
  ExplorerTableSummary table = table_summary("db", "t", "MergeTree");
  classify_health(table);
  CHECK_EQ(table.health, std::string("healthy"));
  CHECK(table.warnings.empty());
  table.active_parts = 5001;
  classify_health(table);
  CHECK_EQ(table.health, std::string("warning"));
  CHECK_EQ(table.warnings.size(), size_t(1));
  // A replica that is read-only, or whose session expired, is an error. A large number of parts adds a warning.
  table.replication.available = true;
  table.replication.readonly = true;
  classify_health(table);
  CHECK_EQ(table.health, std::string("error"));
  CHECK_EQ(table.warnings.size(), size_t(2));
  table.replication.readonly = false;
  table.replication.session_expired = true;
  table.active_parts = 0;
  classify_health(table);
  CHECK_EQ(table.health, std::string("error"));
  // A long queue or delay, or a replica that is not active, gives a warning. The state is read again each time. A stale warning is not kept.
  table.replication.session_expired = false;
  table.replication.absolute_delay_seconds = 61;
  classify_health(table);
  CHECK_EQ(table.health, std::string("warning"));
  CHECK_EQ(table.warnings.size(), size_t(1));
  table.replication.absolute_delay_seconds = 0;
  table.replication.total_replicas = 3;
  table.replication.active_replicas = 2;
  classify_health(table);
  CHECK_EQ(table.health, std::string("warning"));
  table.replication.active_replicas = 3;
  classify_health(table);
  CHECK_EQ(table.health, std::string("healthy"));
  CHECK(table.warnings.empty());
  // A queue of 1000 is not elevated. A queue of 1001 is.
  table.replication.queue_size = 1000;
  classify_health(table);
  CHECK_EQ(table.health, std::string("healthy"));
  table.replication.queue_size = 1001;
  classify_health(table);
  CHECK_EQ(table.health, std::string("warning"));
}

void test_the_resident_rows_of_a_buffer() {
  const auto buffer = [](const std::string& name, const std::string& target, uint64_t rows) {
    ExplorerTableSummary table = table_summary("db", name, "Buffer");
    table.engine_full = "Buffer(" + target + ", 16, 10, 100, 10000, 1000000, 10000000, 100000000)";
    table.rows = rows;
    return table;
  };
  const auto with_rows = [](const std::string& name, uint64_t rows) {
    ExplorerTableSummary table = table_summary("db", name, "MergeTree");
    table.rows = rows;
    return table;
  };
  // The readable rows of a Buffer are its resident rows plus the rows of its destination.
  std::vector<ExplorerTableSummary> tables = {buffer("buf", "db, dst", 130), with_rows("dst", 100)};
  normalize_buffer_runtime_rows(tables);
  CHECK(tables[0].rows && *tables[0].rows == 30);
  CHECK(tables[1].rows && *tables[1].rows == 100);
  // The database of the destination may be currentDatabase(). This name is valid in any case and with any spacing.
  tables = {buffer("buf", "currentDatabase( ), dst", 105), with_rows("dst", 100)};
  normalize_buffer_runtime_rows(tables);
  CHECK(tables[0].rows && *tables[0].rows == 5);
  CHECK_EQ(resolve_buffer_database_arg("CURRENTDATABASE()", "mydb"), std::string("mydb"));
  CHECK_EQ(resolve_buffer_database_arg("other", "mydb"), std::string("other"));
  // Figures that cannot be reconciled are unknown. They are never zero. Examples are: a destination that is hidden or has no count;
  // a destination with more rows than the buffer reads; an empty buffer; and a destination that is not named.
  tables = {buffer("buf", "db, hidden", 130)};
  normalize_buffer_runtime_rows(tables);
  CHECK(!tables[0].rows);
  tables = {buffer("buf", "db, dst", 50), with_rows("dst", 100)};
  normalize_buffer_runtime_rows(tables);
  CHECK(!tables[0].rows);
  tables = {buffer("buf", "db, dst", 0), with_rows("dst", 100)};
  normalize_buffer_runtime_rows(tables);
  CHECK(!tables[0].rows);
  tables = {buffer("buf", "db", 10), with_rows("dst", 100)};
  tables[0].engine_full = "Buffer(db)";
  normalize_buffer_runtime_rows(tables);
  CHECK(!tables[0].rows);
  // A chain of Buffers reads the snapshot of each Buffer. It does not read the figures that the pass already changed.
  tables = {buffer("b1", "db, b2", 300), buffer("b2", "db, dst", 200), with_rows("dst", 100)};
  normalize_buffer_runtime_rows(tables);
  CHECK(tables[0].rows && *tables[0].rows == 100);
  CHECK(tables[1].rows && *tables[1].rows == 100);
}

void test_the_disk_of_a_data_path() {
  const std::vector<std::pair<std::string, std::string>> disks = {{"default", "/var/lib/clickhouse/"}, {"cold", "/var/lib/clickhouse/cold/"},
                                                                    {"empty", ""}, {"other", "/mnt/other/"}};
  const auto of = [&](const std::string& path) {
    return disk_of_path(path, [&](auto&& visit) {
      for (const auto& [name, disk_path] : disks) visit(name, disk_path);
    });
  };
  // The disk is the one whose path is the longest prefix of the data path.
  CHECK_EQ(of("/var/lib/clickhouse/data/db/t/"), std::string("default"));
  CHECK_EQ(of("/var/lib/clickhouse/cold/data/db/t/"), std::string("cold"));
  CHECK_EQ(of("/mnt/other/x"), std::string("other"));
  CHECK_EQ(of("/somewhere/else"), std::string());
  CHECK_EQ(of(""), std::string());
}

void test_the_storage_of_a_database() {
  std::unordered_map<std::string, StoragePartTotals> parts;
  std::unordered_map<std::string, StorageTableMeta> meta;
  const auto key = [](const std::string& t) { return table_key("db", t); };
  parts[key("big")] = {100, 5000, 3};
  parts[key("small")] = {10, 50, 1};
  meta[key("big")] = {"MergeTree", 100, 5000};
  meta[key("small")] = {"MergeTree", 10, 50};
  meta[key("log")] = {"Log", 7, 700};
  meta[key("mem")] = {"Memory", 3, 4096};
  meta[key("dict")] = {"Dictionary", 3, 100};
  meta[key("empty")] = {"MergeTree", 0, 0};
  const auto database = storage_of_database("db", {"big", "small", "log", "mem", "dict", "empty", "unlisted_by_system"}, parts, meta);
  CHECK_EQ(database.name, std::string("db"));
  CHECK_EQ(database.objects, uint64_t(7));
  // The tables that store bytes are listed, largest first. The Log table takes the size that system.tables reports.
  // A table with no bytes is not listed. A table that system.tables does not know is not listed either.
  CHECK_EQ(database.storing_tables, uint64_t(3));
  CHECK_EQ(database.tables.size(), size_t(3));
  CHECK_EQ(database.tables[0].name, std::string("big"));
  CHECK_EQ(database.tables[0].parts, uint64_t(3));
  CHECK_EQ(database.tables[1].name, std::string("log"));
  CHECK_EQ(database.tables[1].bytes, uint64_t(700));
  CHECK(database.tables[1].rows && *database.tables[1].rows == 7);
  CHECK_EQ(database.tables[2].name, std::string("small"));
  CHECK_EQ(database.bytes, uint64_t(5750));
  CHECK_EQ(database.rows, uint64_t(117));
  // RAM is reported apart. It is never drawn as disk.
  CHECK_EQ(database.resident_bytes, uint64_t(4196));
  CHECK_EQ(database.omitted_tables, uint64_t(0));
  // More than 128 tables that store bytes: the largest 128 are listed. The rest are counted, so the totals add up.
  std::vector<std::string> names;
  std::unordered_map<std::string, StoragePartTotals> many_parts;
  uint64_t total_bytes = 0;
  for (int i = 0; i < 200; ++i) {
    names.push_back("t" + std::to_string(1000 + i));
    many_parts[table_key("db", names.back())] = {1, static_cast<uint64_t>(10 + i), 1};
    total_bytes += 10 + i;
  }
  const auto big = storage_of_database("db", names, many_parts, {});
  CHECK_EQ(big.tables.size(), kStorageTablesPerDatabase);
  CHECK_EQ(big.storing_tables, uint64_t(200));
  CHECK_EQ(big.omitted_tables, uint64_t(72));
  uint64_t listed = 0;
  for (const auto& table : big.tables) listed += table.bytes;
  CHECK_EQ(listed + big.omitted_bytes, total_bytes);
  CHECK_EQ(big.bytes, total_bytes);
  CHECK_EQ(big.tables.front().bytes, uint64_t(209));
}

void test_the_sizes_of_the_databases_and_their_disks() {
  std::vector<ExplorerTableSummary> tables;
  auto merge = table_summary("a", "m", "MergeTree");
  merge.rows = 10;
  merge.logical_bytes = 1000;
  merge.disks = {"default"};
  auto log = table_summary("a", "l", "Log");
  log.rows = 5;
  log.logical_bytes = 300;
  log.data_paths = {"/mnt/ssd/data/a/l/"};
  auto memory = table_summary("b", "mem", "Memory");
  memory.rows = 9;
  memory.resident_bytes = 4096;
  auto spread = table_summary("b", "spread", "Log");
  spread.logical_bytes = 50;
  spread.data_paths = {"/mnt/ssd/x/", "/var/lib/clickhouse/y/"};
  tables = {merge, log, memory, spread};
  std::map<std::string, DiskCapacity> capacity;
  capacity["default"] = {"host1", "/var/lib/clickhouse/", "local", 500, 1000};
  capacity["ssd"] = {"host1", "/mnt/ssd/", "local", 100, 200};
  std::map<std::pair<std::string, std::string>, uint64_t> bytes_by_disk;
  bytes_by_disk[{"a", "default"}] = 1000;
  const auto out = database_summaries_of(tables, capacity, bytes_by_disk);
  CHECK_EQ(out.size(), size_t(2));
  CHECK_EQ(out[0].name, std::string("a"));
  CHECK_EQ(out[0].tables, uint64_t(2));
  CHECK_EQ(out[0].rows, uint64_t(15));
  CHECK_EQ(out[0].bytes, uint64_t(1300));
  // The Log table has no parts. Its bytes go to the disk that holds its path. The disk is listed with its capacity.
  CHECK_EQ(out[0].disks.size(), size_t(2));
  CHECK_EQ(out[0].disks[0].name, std::string("default"));
  CHECK_EQ(out[0].disks[0].bytes, uint64_t(1000));
  CHECK_EQ(out[0].disks[0].host_name, std::string("host1"));
  CHECK(out[0].disks[0].free_space && *out[0].disks[0].free_space == 500);
  CHECK_EQ(out[0].disks[1].name, std::string("ssd"));
  CHECK_EQ(out[0].disks[1].bytes, uint64_t(300));
  // Resident bytes are not in the footprint. A table that spans two disks has no single disk to take its bytes.
  CHECK_EQ(out[1].name, std::string("b"));
  CHECK_EQ(out[1].bytes, uint64_t(50));
  CHECK_EQ(out[1].rows, uint64_t(9));
  CHECK(out[1].disks.empty());
}

ExplorerFunctionInfo function_info(const std::string& name, const std::string& kind, const std::string& description) {
  ExplorerFunctionInfo info;
  info.name = name;
  info.kind = kind;
  info.description = description;
  info.syntax = name + "(x)";
  return info;
}

void test_the_aliases_of_the_functions() {
  ExplorerFunctionsCatalog catalog;
  catalog.functions = {
      function_info("zeta", "Function", "Alias of `Beta`."),
      function_info("beta", "Function", "Alias of `alpha`."),
      function_info("alpha", "Function", "The real one."),
      function_info("loop_a", "Function", "Alias of `loop_b`."),
      function_info("loop_b", "Function", "Alias of `loop_a`."),
      function_info("gone", "Function", "Alias of `nothing`."),
      function_info("table_like", "Table Function", "Alias of `alpha`."),
      function_info("urls", "Aggregate Function", "Alias of `Alpha`. More."),
      function_info("broken", "Function", "Alias of `unterminated"),
  };
  resolve_function_aliases(catalog);
  const auto by_name = [&](const std::string& name) -> const ExplorerFunctionInfo& {
    for (const auto& item : catalog.functions) if (item.name == name) return item;
    throw std::runtime_error("no " + name);
  };
  // An alias is followed along its chain. The name is read in any case. The first target is the first document.
  CHECK_EQ(by_name("zeta").alias_documents.size(), size_t(2));
  CHECK_EQ(by_name("zeta").alias_documents[0].name, std::string("beta"));
  CHECK_EQ(by_name("zeta").alias_documents[1].name, std::string("alpha"));
  CHECK_EQ(by_name("zeta").alias_documents[1].description, std::string("The real one."));
  CHECK_EQ(by_name("zeta").alias_documents[1].syntax, std::string("alpha(x)"));
  CHECK_EQ(by_name("beta").alias_documents.size(), size_t(1));
  CHECK(by_name("alpha").alias_documents.empty());
  // A cycle ends at the first name that was seen. A target that does not exist is not an alias. A note that is not closed is not an alias either.
  CHECK_EQ(by_name("loop_a").alias_documents.size(), size_t(1));
  CHECK_EQ(by_name("loop_a").alias_documents[0].name, std::string("loop_b"));
  CHECK(by_name("gone").alias_documents.empty());
  CHECK(by_name("broken").alias_documents.empty());
  CHECK_EQ(by_name("urls").alias_documents.size(), size_t(1));
  CHECK_EQ(by_name("table_like").alias_documents.size(), size_t(1));
  // Sorted by kind, then name.
  CHECK_EQ(catalog.functions.front().kind, std::string("Aggregate Function"));
  CHECK_EQ(catalog.functions.back().kind, std::string("Table Function"));
  for (size_t i = 1; i < catalog.functions.size(); ++i) {
    const auto& a = catalog.functions[i - 1];
    const auto& b = catalog.functions[i];
    CHECK(a.kind < b.kind || (a.kind == b.kind && a.name < b.name));
  }
  // A chain longer than 8 stops at 8.
  ExplorerFunctionsCatalog chain;
  for (int i = 0; i < 12; ++i) chain.functions.push_back(function_info("f" + std::to_string(100 + i), "Function", "Alias of `f" + std::to_string(101 + i) + "`."));
  resolve_function_aliases(chain);
  CHECK_EQ(chain.functions.front().alias_documents.size(), size_t(8));
}

void test_the_ttl_rules_of_a_table() {
  const auto rules = parse_table_ttl_rules(
      "CREATE TABLE db.t (`ts` DateTime TTL ts + INTERVAL 1 DAY, `v` String) ENGINE = MergeTree ORDER BY ts "
      "TTL ts + INTERVAL 30 DAY DELETE, ts + toIntervalHour(6) TO VOLUME 'cold', ts + INTERVAL 1 DAY RECOMPRESS CODEC(ZSTD(9)), "
      "ts + toIntervalMonth(1) GROUP BY v SET ts = max(ts), toStartOfDay(ts) + INTERVAL 2 WEEK TO DISK `archive` SETTINGS index_granularity = 8192");
  CHECK_EQ(rules.size(), size_t(5));
  CHECK_EQ(rules[0].action, std::string("delete"));
  CHECK_EQ(rules[0].expression, std::string("ts + INTERVAL 30 DAY"));
  CHECK_EQ(rules[0].base_expression, std::string("ts"));
  CHECK_EQ(rules[0].offset_label, std::string("+30d"));
  CHECK_EQ(rules[1].action, std::string("move"));
  CHECK_EQ(rules[1].target_kind, std::string("volume"));
  CHECK_EQ(rules[1].target, std::string("cold"));
  CHECK_EQ(rules[1].offset_label, std::string("+6h"));
  CHECK_EQ(rules[2].action, std::string("recompress"));
  CHECK_EQ(rules[2].target_kind, std::string("codec"));
  CHECK_EQ(rules[2].target, std::string("ZSTD(9)"));
  CHECK_EQ(rules[3].action, std::string("group_by"));
  CHECK_EQ(rules[3].target_kind, std::string("expression"));
  CHECK_EQ(rules[3].target, std::string("v SET ts = max(ts)"));
  CHECK_EQ(rules[3].offset_label, std::string("+1mo"));
  CHECK_EQ(rules[4].action, std::string("move"));
  CHECK_EQ(rules[4].target_kind, std::string("disk"));
  CHECK_EQ(rules[4].target, std::string("archive"));
  CHECK_EQ(rules[4].base_expression, std::string("toStartOfDay(ts)"));
  CHECK_EQ(rules[4].offset_label, std::string("+2w"));
  // The TTL of a column is not the TTL of the table. A TTL in a comment or in a text is not a TTL. A table without a TTL has none.
  CHECK(parse_table_ttl_rules("CREATE TABLE t (`a` DateTime TTL a + INTERVAL 1 DAY) ENGINE = MergeTree ORDER BY a").empty());
  CHECK(parse_table_ttl_rules("CREATE TABLE t (a Int8) ENGINE = MergeTree ORDER BY a COMMENT 'TTL a + INTERVAL 1 DAY'").empty());
  CHECK(parse_table_ttl_rules("CREATE TABLE t (a Int8) ENGINE = MergeTree ORDER BY a /* TTL a + INTERVAL 1 DAY */").empty());
  CHECK(parse_table_ttl_rules("").empty());
  // A long expression is cut on a character boundary.
  const std::string long_expression = "toStartOfInterval(ts, INTERVAL 1 HOUR) + INTERVAL 1 DAY + '" + std::string(200, '\xC3') + "'";
  const auto cut = parse_table_ttl_rules("CREATE TABLE t (ts DateTime) ENGINE = MergeTree ORDER BY ts TTL " + long_expression);
  CHECK_EQ(cut.size(), size_t(1));
  CHECK(cut[0].expression.size() <= 183);
  CHECK(cut[0].expression.size() >= 177);
}


// ---- the graph ----

AllowedObjectSet allowed_of(std::initializer_list<std::pair<const char*, const char*>> tables) {
  AllowedObjectSet allowed;
  for (const auto& [database, table] : tables) {
    AllowedTable entry;
    entry.database = database;
    entry.table = table;
    entry.all_columns = true;
    allowed.add_table(std::move(entry));
  }
  return allowed;
}

GraphTable graph_table(const std::string& database, const std::string& name, const std::string& engine, const std::string& engine_full = "",
                       const std::string& ddl = "", const std::string& as_select = "") {
  GraphTable table;
  table.database = database;
  table.name = name;
  table.engine = engine;
  table.engine_full = engine_full;
  table.ddl = ddl;
  table.as_select = as_select;
  return table;
}

const ExplorerGraphNode* find_node(const ExplorerGraph& graph, const std::string& id) {
  for (const auto& node : graph.nodes) if (node.id == id) return &node;
  return nullptr;
}

const ExplorerGraphEdge* find_edge(const ExplorerGraph& graph, const std::string& from, const std::string& to, const std::string& kind) {
  for (const auto& edge : graph.edges) if (edge.from == from && edge.to == to && edge.kind == kind) return &edge;
  return nullptr;
}

void test_the_kind_of_a_node() {
  CHECK_EQ(classify_node("MaterializedView", "CREATE MATERIALIZED VIEW v REFRESH EVERY 1 HOUR AS SELECT 1"), std::string("refreshable_materialized_view"));
  CHECK_EQ(classify_node("MaterializedView", "CREATE MATERIALIZED VIEW v refresh after 1 hour AS SELECT 1"), std::string("refreshable_materialized_view"));
  CHECK_EQ(classify_node("MaterializedView", "CREATE MATERIALIZED VIEW v TO t AS SELECT 1"), std::string("materialized_view"));
  CHECK_EQ(classify_node("View", ""), std::string("view"));
  CHECK_EQ(classify_node("ParameterizedView", ""), std::string("view"));
  CHECK_EQ(classify_node("ReplicatedReplacingMergeTree", ""), std::string("mergetree"));
  CHECK_EQ(classify_node("Distributed", ""), std::string("distributed"));
  CHECK_EQ(classify_node("Buffer", ""), std::string("buffer"));
  CHECK_EQ(classify_node("Kafka", ""), std::string("stream_engine"));
  CHECK_EQ(classify_node("Dictionary", ""), std::string("dictionary"));
  CHECK_EQ(classify_node("RemoteSecure", ""), std::string("external"));
  CHECK_EQ(classify_node("TinyLog", ""), std::string("tinylog"));
  CHECK_EQ(classify_node("StripeLog", ""), std::string("stripelog"));
  CHECK_EQ(classify_node("Log", ""), std::string("log"));
  CHECK_EQ(classify_node("Memory", ""), std::string("memory"));
  CHECK_EQ(classify_node("Join", ""), std::string("table"));
}

ExplorerGraphInputs pipeline_inputs() {
  ExplorerGraphInputs inputs;
  inputs.tables = {
      graph_table("db", "src", "MergeTree", "MergeTree ORDER BY ts", "CREATE TABLE db.src (ts DateTime) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 7 DAY DELETE"),
      graph_table("db", "buf", "Buffer", "Buffer(db, dst, 16, 10, 100, 10000, 1000000, 10000000, 100000000)"),
      graph_table("db", "dst", "MergeTree", "MergeTree ORDER BY ts"),
      graph_table("db", "mv", "MaterializedView", "", "CREATE MATERIALIZED VIEW db.mv TO db.dst AS SELECT * FROM db.src", "SELECT * FROM db.src"),
      graph_table("db", "vw", "View", "", "CREATE VIEW db.vw AS SELECT 1",
                  "WITH c AS (SELECT a FROM db.src) SELECT * FROM c JOIN (SELECT * FROM db.dst) AS d USING a, numbers(10) ARRAY JOIN arr"),
      graph_table("db", "dist", "Distributed", "Distributed(c1, db, dst, rand())"),
      graph_table("db", "hidden_target", "MaterializedView", "", "CREATE MATERIALIZED VIEW db.hidden_target TO secret.sink AS SELECT 1", "SELECT 1"),
      graph_table("db", "dict", "Dictionary", "", "CREATE DICTIONARY db.dict (k UInt64) PRIMARY KEY k SOURCE(CLICKHOUSE(HOST 'h' PASSWORD 'p' TABLE 'src')) "
                                                    "LAYOUT(HASHED()) LIFETIME(MIN 0 MAX 300)"),
      graph_table("db", "w", "MergeTree", "", ""),
  };
  inputs.dependencies = {{"db", "src", "db", "mv"}, {"db", "src", "db", "row"}, {"db", "src", "secret", "x"}, {"db", "dst", "db", "vw"}};
  inputs.dictionary_sources = {{"db", "dict", "db", "src"}};
  inputs.clusters = {{"c1", 1, 1, "h11"}, {"c1", 1, 2, "h12"}, {"c1", 2, 1, "h21"}, {"c1", 2, 2, ""}, {"other", 1, 1, "z"}};
  inputs.refreshable_views_available = true;
  return inputs;
}

const AllowedObjectSet kPipelineAllowed = allowed_of({{"db", "src"}, {"db", "buf"}, {"db", "dst"}, {"db", "mv"}, {"db", "vw"}, {"db", "dist"},
                                                      {"db", "hidden_target"}, {"db", "dict"}, {"db", "w"}});

void test_the_logical_graph_of_a_pipeline() {
  ExplorerGraph graph;
  build_explorer_graph(pipeline_inputs(), kPipelineAllowed, ExplorerCatalog{}, graph);
  const auto id = [](const std::string& table) { return "table:db." + table; };
  // A node for every table that the runner reads. Each node has its kind and the TTL of the table.
  CHECK(find_node(graph, id("src")) && find_node(graph, id("src"))->kind == "mergetree");
  CHECK_EQ(find_node(graph, id("src"))->ttl_rules.size(), size_t(1));
  CHECK_EQ(find_node(graph, id("src"))->ttl_rules[0].offset_label, std::string("+7d"));
  CHECK_EQ(find_node(graph, id("mv"))->kind, std::string("materialized_view"));
  CHECK_EQ(find_node(graph, id("buf"))->kind, std::string("buffer"));
  CHECK_EQ(find_node(graph, id("dict"))->kind, std::string("dictionary"));
  // The edges: a dependency of a materialized view is animated. A pseudo "row" dependency is not an edge. A hidden object is not an edge either.
  const auto* trigger = find_edge(graph, id("src"), id("mv"), "materialized_view");
  CHECK(trigger && trigger->can_animate && trigger->label == "Materialized View trigger");
  CHECK(find_edge(graph, id("mv"), id("dst"), "materialized_view_output") != nullptr);
  CHECK(find_edge(graph, id("buf"), id("dst"), "buffer") && find_edge(graph, id("buf"), id("dst"), "buffer")->can_animate);
  CHECK(find_edge(graph, id("dist"), id("dst"), "distributed_route") != nullptr);
  CHECK(find_edge(graph, id("src"), id("dict"), "dictionary_source") != nullptr);
  CHECK(find_edge(graph, id("dst"), id("vw"), "dependency") != nullptr || find_edge(graph, id("dst"), id("vw"), "view") != nullptr);
  size_t hidden = 0, pseudo = 0;
  for (const auto& edge : graph.edges) {
    hidden += edge.from.find("secret") != std::string::npos || edge.to.find("secret") != std::string::npos;
    pseudo += edge.to == id("row") || edge.from == id("row");
  }
  CHECK_EQ(hidden, size_t(0));
  CHECK_EQ(pseudo, size_t(0));
  // A view reads what its SELECT reads, at every depth: the CTE and the subquery. A table function and an ARRAY JOIN are not tables.
  const auto* from_src = find_edge(graph, id("src"), id("vw"), "view");
  const auto* from_dst = find_edge(graph, id("dst"), id("vw"), "view");
  CHECK(from_src != nullptr);
  CHECK(from_dst != nullptr);
  size_t view_edges = 0;
  for (const auto& edge : graph.edges) view_edges += edge.to == id("vw") && edge.kind == "view";
  CHECK_EQ(view_edges, size_t(2));
  // The ids of the edges are numbered in the order that they were made. Each edge is numbered once.
  std::set<std::string> ids_seen, pairs;
  for (const auto& edge : graph.edges) {
    CHECK(ids_seen.insert(edge.id).second);
    CHECK(pairs.insert(edge.from + "|" + edge.to + "|" + edge.kind).second);
  }
  CHECK_EQ(graph.edges.front().id, std::string("edge:1"));
  CHECK(graph.refreshable_views_available);
  CHECK(!graph.truncated);
}

void test_what_a_definition_says_and_never_names() {
  ExplorerGraph graph;
  build_explorer_graph(pipeline_inputs(), kPipelineAllowed, ExplorerCatalog{}, graph);
  const auto& defs = graph.definitions;
  // A view: its SELECT, as written.
  CHECK(defs.at("table:db.vw").select_sql.find("WITH c AS") == 0);
  CHECK(!defs.at("table:db.vw").select_sql_truncated);
  // A materialized view whose target the runner reads names the target. A target that the runner may not read is "not visible", with no name.
  CHECK(defs.at("table:db.mv").target_visible);
  CHECK_EQ(defs.at("table:db.mv").target_database, std::string("db"));
  CHECK_EQ(defs.at("table:db.mv").target_table, std::string("dst"));
  CHECK(!defs.at("table:db.hidden_target").target_visible);
  CHECK(defs.at("table:db.hidden_target").target_database.empty() && defs.at("table:db.hidden_target").target_table.empty());
  // A Buffer shows its destination. A Distributed table shows the cluster, the sharding key, the shards and replicas, and its destination.
  CHECK_EQ(defs.at("table:db.buf").target_table, std::string("dst"));
  CHECK_EQ(defs.at("table:db.dist").distributed_cluster, std::string("c1"));
  CHECK_EQ(defs.at("table:db.dist").distributed_sharding_key, std::string("rand()"));
  CHECK_EQ(defs.at("table:db.dist").distributed_shards, uint64_t(2));
  CHECK_EQ(defs.at("table:db.dist").distributed_replicas, uint64_t(2));
  CHECK_EQ(defs.at("table:db.dist").target_table, std::string("dst"));
  // A dictionary shows the kind of its source. It never shows the connection arguments. It also shows its layout, its lifetime, and the table that it reads.
  CHECK_EQ(defs.at("table:db.dict").dictionary_source_kind, std::string("CLICKHOUSE"));
  CHECK_EQ(defs.at("table:db.dict").dictionary_layout, std::string("HASHED"));
  CHECK_EQ(defs.at("table:db.dict").dictionary_lifetime, std::string("MIN 0 MAX 300"));
  CHECK(defs.at("table:db.dict").target_visible);
  CHECK_EQ(defs.at("table:db.dict").target_table, std::string("src"));
  // A plain table has none.
  CHECK(defs.count("table:db.w") == 0);
  // A SELECT of more than 32 KiB is cut. The output says so.
  ExplorerGraphInputs big = pipeline_inputs();
  for (auto& table : big.tables) if (table.name == "vw") table.as_select = "SELECT '" + std::string(40000, 'x') + "' FROM db.src";
  ExplorerGraph cut;
  build_explorer_graph(big, kPipelineAllowed, ExplorerCatalog{}, cut);
  CHECK(cut.definitions.at("table:db.vw").select_sql_truncated);
  CHECK_EQ(cut.definitions.at("table:db.vw").select_sql.size(), size_t(32 * 1024));
}

void test_a_dictionary_whose_source_is_hidden_does_not_name_it() {
  ExplorerGraphInputs inputs = pipeline_inputs();
  inputs.dictionary_sources = {{"db", "dict", "secret", "src"}};
  ExplorerGraph graph;
  build_explorer_graph(inputs, kPipelineAllowed, ExplorerCatalog{}, graph);
  CHECK(!graph.definitions.at("table:db.dict").target_visible);
  CHECK(graph.definitions.at("table:db.dict").target_table.empty());
  for (const auto& edge : graph.edges) CHECK(edge.kind != "dictionary_source");
}

void test_the_physical_topology_of_a_graph() {
  ExplorerGraphInputs inputs;
  inputs.tables = {graph_table("db", "t", "MergeTree"), graph_table("db", "r", "ReplicatedMergeTree"), graph_table("db", "log", "Log"),
                   graph_table("db", "mem", "Memory"), graph_table("db", "dist", "Distributed", "Distributed(c1, db, t, rand())")};
  inputs.tables[2].data_paths = {"/var/lib/clickhouse/data/db/log/"};
  inputs.disks["default"] = ExplorerDatabaseDisk{"default", "host1", "/var/lib/clickhouse/", "local", 0, 10, 100};
  inputs.disks["cold"] = ExplorerDatabaseDisk{"cold", "host1", "/mnt/cold/", "s3", 0, 5, 50};
  inputs.storage_policies["tiered"] = {GraphStorageVolume{"tiered", "hot", 1, {"default"}, "JBOD", 0, 0.2}, GraphStorageVolume{"tiered", "cold", 2, {"cold", ""}, "JBOD", 0, 0.0}};
  inputs.clusters = {{"c1", 1, 1, "h1"}, {"c1", 2, 1, "h2"}};
  ExplorerCatalog catalog;
  auto t = table_summary("db", "t", "MergeTree");
  t.storage_policy = "tiered";
  auto r = table_summary("db", "r", "ReplicatedMergeTree");
  r.disks = {"default"};
  r.replication.available = true;
  r.replication.replica_name = "replica-1";
  r.replication.total_replicas = 3;
  auto l = table_summary("db", "log", "Log");
  auto m = table_summary("db", "mem", "Memory");
  auto d = table_summary("db", "dist", "Distributed");
  catalog.tables = {t, r, l, m, d};
  ExplorerGraph graph;
  build_explorer_graph(inputs, allowed_of({{"db", "t"}, {"db", "r"}, {"db", "log"}, {"db", "mem"}, {"db", "dist"}}), catalog, graph);
  // A storage policy is a chain. The chain has the table, the policy, the first volume, then each colder volume from the one before it, then the disks.
  const auto policy = "physical:database:db:policy:tiered";
  CHECK(find_node(graph, policy) && find_node(graph, policy)->kind == "storage_policy");
  CHECK(find_edge(graph, "table:db.t", policy, "storage_policy") != nullptr);
  const auto hot = std::string(policy) + ":volume:1:hot";
  const auto cold = std::string(policy) + ":volume:2:cold";
  CHECK(find_edge(graph, policy, hot, "policy_volume") != nullptr);
  CHECK(find_edge(graph, hot, cold, "volume_tier") != nullptr);
  CHECK(find_edge(graph, hot, "physical:database:db:disk:default", "volume_disk") != nullptr);
  CHECK(find_edge(graph, cold, "physical:database:db:disk:cold", "volume_disk") != nullptr);
  CHECK(find_node(graph, hot) && find_node(graph, hot)->move_factor == 0.2);
  CHECK(find_edge(graph, policy, hot, "policy_volume")->label.find("priority 1") == 0);
  CHECK(find_edge(graph, policy, hot, "policy_volume")->label.find("move 0.2") != std::string::npos);
  // The disk node has its host, type and capacity.
  const auto* cold_disk = find_node(graph, "physical:database:db:disk:cold");
  CHECK(cold_disk && cold_disk->disk_type == "s3" && cold_disk->disk_total_space && *cold_disk->disk_total_space == 50);
  // A replicated table has a local replica node and a badge with the number of replicas. The disks of its parts hang from the replica.
  CHECK(find_node(graph, "physical:table:db.r:replica:local") != nullptr);
  CHECK_EQ(find_node(graph, "table:db.r")->topology_badge, std::string("3R"));
  CHECK(find_edge(graph, "physical:table:db.r:replica:local", "physical:database:db:disk:default", "contains") != nullptr);
  // A Log table is on the disk that holds its path. A Memory table has no placement.
  CHECK(find_edge(graph, "table:db.log", "physical:database:db:disk:default", "contains") != nullptr);
  CHECK(find_edge(graph, "table:db.mem", "physical:database:db:disk:default", "contains") == nullptr);
  size_t mem_children = 0;
  for (const auto& edge : graph.edges) mem_children += edge.from == "table:db.mem";
  CHECK_EQ(mem_children, size_t(0));
  // The cluster has a shard node and a replica node for each of its rows. The Distributed tables that name the cluster share these nodes.
  // The table has an edge to each shard, and the badge "2S × 1R".
  CHECK(find_node(graph, "physical:cluster:c1:shard:1") != nullptr);
  CHECK(find_node(graph, "physical:cluster:c1:shard:2:replica:1") != nullptr);
  CHECK(find_edge(graph, "table:db.dist", "physical:cluster:c1:shard:1", "contains") != nullptr);
  CHECK(find_edge(graph, "physical:cluster:c1:shard:2", "physical:cluster:c1:shard:2:replica:1", "contains") != nullptr);
  CHECK_EQ(find_node(graph, "table:db.dist")->topology_badge, std::string("2S × 1R"));
  CHECK_EQ(graph.definitions.at("table:db.dist").distributed_shards, uint64_t(2));
}

void test_the_cluster_topology_is_shared_by_its_distributed_tables() {
  // Two Distributed tables of two databases name one cluster of 2 shards with 2 replicas. The shards and the replicas are made once.
  // Each table has an edge to each shard.
  ExplorerGraphInputs inputs;
  inputs.tables = {graph_table("a", "d1", "Distributed", "Distributed(c1, a, t, rand())"), graph_table("b", "d2", "Distributed", "Distributed(c1, b, t, rand())")};
  inputs.clusters = {{"c1", 1, 1, "h11"}, {"c1", 1, 2, "h12"}, {"c1", 2, 1, "h21"}, {"c1", 2, 2, "h22"}};
  ExplorerCatalog catalog;
  catalog.tables = {table_summary("a", "d1", "Distributed"), table_summary("b", "d2", "Distributed")};
  ExplorerGraph graph;
  build_explorer_graph(inputs, allowed_of({{"a", "d1"}, {"b", "d2"}}), catalog, graph);
  size_t shards = 0, replicas = 0;
  for (const auto& node : graph.nodes) {
    shards += node.kind == "shard";
    replicas += node.kind == "replica";
  }
  CHECK_EQ(shards, size_t(2));
  CHECK_EQ(replicas, size_t(4));
  for (const char* table : {"table:a.d1", "table:b.d2"}) {
    CHECK(find_edge(graph, table, "physical:cluster:c1:shard:1", "contains") != nullptr);
    CHECK(find_edge(graph, table, "physical:cluster:c1:shard:2", "contains") != nullptr);
  }
  CHECK_EQ(find_node(graph, "table:a.d1")->topology_badge, std::string("2S × 2R"));
  CHECK_EQ(find_node(graph, "physical:cluster:c1:shard:1:replica:2")->host_name, std::string("h12"));
  // The Storage mode of a database shows the shared nodes below its own tables. The focus on a table shows them too.
  GraphScopeRequest scope;
  scope.physical = true;
  scope.database = "a";
  size_t scoped_shards = 0;
  for (const auto& node : scope_graph(graph, scope, true, true).nodes) scoped_shards += node.kind == "shard";
  CHECK_EQ(scoped_shards, size_t(2));
  scope.database.clear();
  scope.focus_id = "table:b.d2";
  CHECK_EQ(scope_graph(graph, scope, true, true).nodes.size(), size_t(1 + 2 + 4));
}

void test_the_cluster_topology_of_a_graph_is_bounded() {
  // 1,100 Distributed tables on a cluster of 40 shards with 3 replicas. An edge from each table to each shard makes 44,000 edges,
  // which is over the 40,000 of the graph. The nodes of the cluster are made once (160), whatever the number of tables.
  ExplorerGraphInputs inputs;
  std::vector<std::string> keep;
  ExplorerCatalog catalog;
  for (int i = 0; i < 1100; ++i) {
    keep.push_back("d" + std::to_string(1000 + i));
    inputs.tables.push_back(graph_table("db", keep.back(), "Distributed", "Distributed(big, db, t, rand())"));
    catalog.tables.push_back(table_summary("db", keep.back(), "Distributed"));
  }
  for (uint64_t shard = 1; shard <= 40; ++shard) {
    for (uint64_t replica = 1; replica <= 3; ++replica) inputs.clusters.push_back({"big", shard, replica, "h" + std::to_string(shard) + "-" + std::to_string(replica)});
  }
  AllowedObjectSet allowed;
  for (const auto& name : keep) {
    AllowedTable entry;
    entry.database = "db";
    entry.table = name;
    entry.all_columns = true;
    allowed.add_table(std::move(entry));
  }
  ExplorerGraph graph;
  build_explorer_graph(inputs, allowed, catalog, graph);
  CHECK(graph.truncated);
  CHECK(graph.nodes.size() <= kMaxGraphNodes);
  CHECK(graph.edges.size() <= kMaxGraphEdges);
  // The logical graph is whole. Every table has its node and its definition (with the size of the cluster).
  // Only the shard edges below some are left out.
  size_t logical = 0, shards = 0, replicas = 0, tables_with_shards = 0;
  for (const auto& node : graph.nodes) {
    logical += node.layer == "logical";
    shards += node.kind == "shard";
    replicas += node.kind == "replica";
  }
  for (const auto& edge : graph.edges) tables_with_shards += edge.kind == "contains" && edge.label == "shard";
  CHECK_EQ(logical, size_t(1100));
  CHECK_EQ(shards, size_t(40));
  CHECK_EQ(replicas, size_t(120));
  CHECK(tables_with_shards > 0 && tables_with_shards < 1100 * 40);
  CHECK_EQ(graph.definitions.at("table:db.d1000").distributed_shards, uint64_t(40));
  // A small cluster is not cut.
  ExplorerGraph small;
  build_explorer_graph(pipeline_inputs(), kPipelineAllowed, ExplorerCatalog{}, small);
  CHECK(!small.truncated);
}

void test_two_tables_do_not_share_a_node_id() {
  // `a.b` + `c` and `a` + `b.c` make the same text "table:a.b.c".
  // The second table has its own id, and its edges go to it.
  ExplorerGraphInputs inputs;
  inputs.tables = {graph_table("a.b", "c", "MergeTree"), graph_table("a", "b.c", "MergeTree"), graph_table("a", "v", "View", "", "", "SELECT * FROM a.b.c")};
  inputs.dependencies = {{"a", "b.c", "a", "v"}};
  AllowedObjectSet allowed = allowed_of({{"a.b", "c"}, {"a", "b.c"}, {"a", "v"}});
  ExplorerGraph graph;
  build_explorer_graph(inputs, allowed, ExplorerCatalog{}, graph);
  std::set<std::string> ids;
  for (const auto& node : graph.nodes) CHECK(ids.insert(node.id).second);
  CHECK_EQ(graph.nodes.size(), size_t(3));
  CHECK_EQ(graph.nodes[0].id, std::string("table:a.b.c"));
  CHECK(graph.nodes[1].id != graph.nodes[0].id);
  CHECK_EQ(graph.nodes[1].database, std::string("a"));
  CHECK_EQ(graph.nodes[1].name, std::string("b.c"));
  // The edge of the dependency is on the node of the table that it names.
  CHECK(find_edge(graph, graph.nodes[1].id, "table:a.v", "dependency") != nullptr || find_edge(graph, graph.nodes[1].id, "table:a.v", "view") != nullptr);
  CHECK(find_edge(graph, graph.nodes[0].id, "table:a.v", "dependency") == nullptr);
}

void test_a_hidden_table_is_not_in_the_graph() {
  ExplorerGraph graph;
  AllowedObjectSet allowed = allowed_of({{"db", "src"}, {"db", "dst"}});
  build_explorer_graph(pipeline_inputs(), allowed, ExplorerCatalog{}, graph);
  CHECK_EQ(graph.nodes.size(), size_t(2));
  for (const auto& node : graph.nodes) CHECK(node.name == "src" || node.name == "dst");
  // No definition is made for a hidden object either.
  for (const auto& [id, definition] : graph.definitions) CHECK(id == "table:db.src" || id == "table:db.dst");
  CHECK(graph.edges.empty());
  CHECK(referenced_clusters(pipeline_inputs().tables) == std::vector<std::string>{"c1"});
}


// ---- the readers, on a fake ClickHouse ----

// ClickHouse answers "your privileges are not enough". The answer gives the grant to give, and the user that receives it.
std::function<void()> denied(const std::string& grant) {
  return [grant] {
    throw server_error(497, "DB::Exception: system_user: Not enough privileges. To execute this query, it's necessary to have the grant " + grant +
                                " (ACCESS_DENIED)");
  };
}

// A row of the statement of the base catalog has 15 columns: database, name, engine, '', sorting, primary, partition, sampling, policy, rows, bytes,
// uncompressed bytes, data paths, modification time, and a flag that says the table was modified in the last seconds.
Row base_row(const std::string& database, const std::string& name, const std::string& engine, const std::string& rows = "",
             const std::string& bytes = "", const std::string& policy = "") {
  return {database, name, engine, "", "ts", "ts", "toDate(ts)", "", policy, rows, bytes, bytes, "", "2026-10-11 01:02:03", "0"};
}

void test_the_catalog_index_reads_the_names_of_one_database() {
  FakeDb system, runner;
  system.on("FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema') AND database = {p1:String} ORDER BY",
            {{"db", "events", "MergeTree", "5", "500", "2026-10-11 00:00:00"}, {"db", "mem", "Memory", "1", "4096", "2026-10-11 00:00:00"},
             {"db", "denied", "MergeTree", "1", "1", "2026-10-11 00:00:00"}});
  // rows, bytes, bytes on disk, compressed, uncompressed, parts, last part (by table)
  system.on("FROM system.parts WHERE active AND database = {p1:String} GROUP BY `table`", {{"events", "90", "900", "400", "800", "3", "2026-10-11 05:00:00"}});
  system.on("FROM system.parts WHERE active AND database = {p1:String} GROUP BY disk_name", {{"default", "900"}});
  system.on("FROM system.disks", {{"host1", "default", "/var/lib/clickhouse/", "local", "100", "1000"}});
  system.on("FROM system.replicas WHERE database = {p1:String}", {{"events", "0", "0", "5", "70"}});
  const auto allowed = allowed_of({{"db", "events"}, {"db", "mem"}});
  ExplorerCatalog catalog;
  std::string error;
  CHECK(load_explorer_catalog_index(system, runner, allowed, catalog, &error));
  CHECK((catalog.databases == std::vector<std::string>{"db"}));
  // Only the objects that the runner reads are listed. The table that the runner does not read is not listed.
  CHECK_EQ(catalog.tables.size(), size_t(2));
  CHECK_EQ(catalog.tables[0].name, std::string("events"));
  // One parts read gives the exact sizes of the MergeTree table, and its newest part. A Memory table is resident.
  CHECK(catalog.tables[0].rows && *catalog.tables[0].rows == 90);
  CHECK(catalog.tables[0].logical_bytes && *catalog.tables[0].logical_bytes == 900);
  CHECK(catalog.tables[0].compressed_bytes && *catalog.tables[0].compressed_bytes == 400);
  CHECK_EQ(catalog.tables[0].active_parts, uint64_t(3));
  CHECK_EQ(catalog.tables[0].last_part_time, std::string("2026-10-11 05:00:00"));
  CHECK(catalog.tables[1].resident_bytes && *catalog.tables[1].resident_bytes == 4096 && !catalog.tables[1].logical_bytes);
  // The disks of the database are shown with their capacity. The replica state gives the dot of the tree.
  // A replica 70 s behind is a warning.
  CHECK_EQ(catalog.database_disks.size(), size_t(1));
  CHECK_EQ(catalog.database_disks[0].name, std::string("default"));
  CHECK_EQ(catalog.database_disks[0].host_name, std::string("host1"));
  CHECK(catalog.database_disks[0].free_space && *catalog.database_disks[0].free_space == 100);
  CHECK(catalog.tables[0].replication.available);
  CHECK_EQ(catalog.tables[0].health, std::string("warning"));
  // The system account is asked. The runner is not needed.
  CHECK(runner.sqls.empty());
  CHECK_EQ(system.params[0].size(), size_t(1));
  CHECK_EQ(system.params[0][0].second, std::string("db"));
}

void test_the_catalog_index_falls_back_on_the_runner_and_fills_what_lags() {
  FakeDb system, runner;
  system.fail_on("ORDER BY database, name", [] { throw server_error(60, "system.tables is not readable"); });
  runner.on("ORDER BY database, name", {{"a", "t1", "MergeTree", "1", "10", "2026-10-11 00:00:00"}});
  // The runner asks for an object that system.tables does not show yet. It asks by name.
  runner.on(" LIMIT 1", {{"a", "new_table", "Log", "2", "20", "2026-10-11 00:00:01"}});
  const auto allowed = allowed_of({{"a", "t1"}, {"a", "new_table"}});
  ExplorerCatalog catalog;
  std::string error;
  CHECK(load_explorer_catalog_index(system, runner, allowed, catalog, &error));
  CHECK_EQ(catalog.tables.size(), size_t(2));
  CHECK_EQ(catalog.tables[0].name, std::string("new_table"));
  CHECK_EQ(catalog.tables[1].name, std::string("t1"));
  // When both accounts fail, the answer is an error. The error has the two reasons.
  FakeDb bad_system, bad_runner;
  bad_system.fail_on("ORDER BY database, name", [] { throw server_error(60, "system broke"); });
  bad_runner.fail_on("ORDER BY database, name", [] { throw server_error(60, "runner broke"); });
  CHECK(!load_explorer_catalog_index(bad_system, bad_runner, allowed, catalog, &error));
  CHECK(error.find("system broke") != std::string::npos && error.find("runner broke") != std::string::npos);
}

void test_the_totals_of_the_databases() {
  FakeDb runner;
  runner.on("GROUP BY database ORDER BY database", {{"zeta", "3", "30", "300"}, {"alpha", "2", "20", "200"}, {"hidden", "9", "9", "9"}});
  std::vector<ExplorerDatabaseSummary> out;
  std::string error;
  CHECK(load_explorer_database_summaries(runner, {"zeta", "alpha"}, out, &error));
  // The databases of the list are sorted. A database that the runner does not list is not in the list.
  CHECK_EQ(out.size(), size_t(2));
  CHECK_EQ(out[0].name, std::string("alpha"));
  CHECK_EQ(out[0].tables, uint64_t(2));
  CHECK_EQ(out[1].bytes, uint64_t(300));
  CHECK(load_explorer_database_summaries(runner, {}, out, &error) && out.empty());
  FakeDb broken;
  broken.fail_on("GROUP BY database", [] { throw server_error(60, "broken"); });
  CHECK(!load_explorer_database_summaries(broken, {"a"}, out, &error));
  CHECK(out.empty());
  CHECK(error.find("broken") != std::string::npos);
}

ExplorerIdentities identities() { return ExplorerIdentities{"runner-key"}; }

void test_the_catalog_of_the_graph() {
  FakeDb system, runner;
  system.on("ORDER BY database, name", {base_row("db", "events", "MergeTree", "5", "500"), base_row("db", "buf", "Buffer", "130", "100"),
                                         base_row("db", "dst", "MergeTree", "100", "800"), base_row("db", "mem", "Memory", "1", "4096"),
                                         base_row("db", "notes", "Log", "0", "300"), base_row("db", "dict", "Dictionary", "1", "50"),
                                         base_row("db", "repl", "ReplicatedMergeTree", "10", "100"), base_row("db", "hidden", "MergeTree", "1", "1")});
  // The texts of the DDL come from their own statement (engine_full, the DDL and the SELECT). The runner reads them: ClickHouse masks their secrets for each user.
  runner.on("toString(engine_full), toString(create_table_query), toString(as_select) FROM system.tables WHERE database = {p1:String}",
            {{"db", "buf", "Buffer(db, dst, 16, 10, 100, 10000, 1000000, 10000000, 100000000)", "", ""}});
  system.on("FROM system.dictionaries", {{"db", "dict", "7", "2048"}});
  system.on("SELECT toString(database), toString(`table`), toString(sum(rows))", {{"db", "events", "50", "5000", "2000", "4000", "6", "2", "default,cold", "2026-10-11 06:00:00", "123"},
                                                                                     {"db", "dst", "70", "700", "300", "600", "2", "1", "default", "2026-10-11 05:00:00", "0"},
                                                                                     {"db", "repl", "9", "90", "40", "80", "9000", "1", "default", "2026-10-11 05:00:00", "0"},
                                                                                     {"db", "hidden", "9", "9", "9", "9", "1", "1", "default", "2026-10-11 05:00:00", "0"}});
  system.on("FROM system.projection_parts WHERE active GROUP BY database", {{"db", "events", "77"}});
  // object, rates (6), rows, bytes, last event
  system.on("FROM system.query_log", {{"db.events", "1.5", "2.5", "3.5", "10", "20", "30", "100", "1000", "2026-10-11 06:00:00"}, {"other.x", "1", "1", "1", "1", "1", "1", "1", "1", "x"}});
  system.on("FROM system.part_log", {{"db", "events", "1", "2", "3", "4", "5", "6", "7", "8", "9", "2026-10-11 06:00:01"}});
  // database, table, queue size, delay, read-only, expired, replica name, path
  system.on("FROM system.replicas WHERE database IN", {{"db", "repl", "3", "2"}});
  system.on("FROM system.replicas", {{"db", "repl", "5", "7", "0", "0", "r1", "/zk/repl"}});
  system.on("FROM system.disks", {{"host1", "default", "/var/lib/clickhouse/", "local", "100", "1000"}, {"host1", "cold", "/mnt/cold/", "s3", "50", "500"}});
  system.on("GROUP BY database, disk_name", {{"db", "default", "1700"}, {"db", "cold", "300"}});
  runner.on("SELECT toString(count()) FROM `db`.`notes`", {{"12"}});
  const auto allowed = allowed_of({{"db", "events"}, {"db", "buf"}, {"db", "dst"}, {"db", "mem"}, {"db", "notes"}, {"db", "dict"}, {"db", "repl"}});
  ExplorerCaches caches;
  ExplorerCatalog catalog;
  std::string error;
  CHECK(load_explorer_catalog(system, runner, caches, identities(), allowed, catalog, &error));
  CHECK_EQ(catalog.tables.size(), size_t(7));
  const auto table = [&](const std::string& name) -> const ExplorerTableSummary& {
    for (const auto& item : catalog.tables) if (item.name == name) return item;
    throw std::runtime_error("no " + name);
  };
  // The table that the runner does not read is not in the answer. The rest is sorted.
  CHECK_EQ(catalog.tables.front().name, std::string("buf"));
  // A MergeTree table takes its sizes from its active parts. It also takes its disks, its index and projection bytes, and the rates of its ingress.
  CHECK(table("events").rows && *table("events").rows == 50);
  CHECK(table("events").logical_bytes && *table("events").logical_bytes == 5000);
  CHECK(table("events").physical_bytes && *table("events").physical_bytes == 5000);
  CHECK_EQ(table("events").active_parts, uint64_t(6));
  CHECK_EQ(table("events").partitions, uint64_t(2));
  CHECK((table("events").disks == std::vector<std::string>{"default", "cold"}));
  CHECK(table("events").secondary_indices_bytes && *table("events").secondary_indices_bytes == 123);
  CHECK(table("events").projection_bytes && *table("events").projection_bytes == 77);
  CHECK(table("dst").projection_bytes && *table("dst").projection_bytes == 0);
  CHECK(table("events").client_ingress.rows_per_second_1m && *table("events").client_ingress.rows_per_second_1m == 1.5);
  CHECK(table("events").client_ingress.rows_total_1h && *table("events").client_ingress.rows_total_1h == 100);
  CHECK(table("events").physical_ingress.new_parts_per_minute && *table("events").physical_ingress.new_parts_per_minute == 9);
  // A Buffer is resident. Its rows are what it holds apart from its destination (130 - 100). Its bytes are never disk.
  CHECK(table("buf").rows && *table("buf").rows == 30);
  CHECK(table("buf").resident_bytes && !table("buf").logical_bytes);
  CHECK_EQ(table("buf").engine_full.find("Buffer(db, dst"), size_t(0));
  // A dictionary has the rows and the allocation that system.dictionaries reports. A Log table with no rows is counted by the runner.
  CHECK(table("dict").rows && *table("dict").rows == 7);
  CHECK(table("dict").resident_bytes && *table("dict").resident_bytes == 2048 && !table("dict").logical_bytes);
  CHECK(table("notes").rows && *table("notes").rows == 12);
  CHECK(table("notes").physical_bytes && *table("notes").physical_bytes == 300);
  // A replicated table has its replica and its counts (from the cache of the server). The health is taken from these counts: 3 replicas, 2 active.
  CHECK(table("repl").replication.available);
  CHECK_EQ(table("repl").replication.replica_name, std::string("r1"));
  CHECK_EQ(table("repl").replication.total_replicas, uint64_t(3));
  CHECK_EQ(table("repl").replication.active_replicas, uint64_t(2));
  CHECK_EQ(table("repl").health, std::string("warning"));
  CHECK_EQ(table("events").health, std::string("healthy"));
  CHECK(table("repl").physical_bytes == std::optional<uint64_t>());
  // The sizes of the databases and the disks of each.
  CHECK_EQ(catalog.database_summaries.size(), size_t(1));
  CHECK_EQ(catalog.database_summaries[0].tables, uint64_t(7));
  CHECK_EQ(catalog.database_summaries[0].disks.size(), size_t(2));
  CHECK(catalog.query_log_available && catalog.part_log_available && catalog.replication_available);
  CHECK(catalog.unavailable_sections.empty());
  // The replica counts are read once. The second catalog reads them from the cache of the server.
  const size_t count_reads = system.count("total_replicas");
  CHECK(load_explorer_catalog(system, runner, caches, identities(), allowed, catalog, &error));
  CHECK_EQ(system.count("total_replicas"), count_reads);
}

void test_a_section_that_the_system_account_may_not_read_degrades_the_catalog() {
  FakeDb system, runner;
  system.on("ORDER BY database, name", {base_row("db", "events", "MergeTree", "5", "500")});
  system.fail_on("FROM system.query_log", denied("SELECT ON system.query_log"));
  system.fail_on("FROM system.part_log", denied("SELECT ON system.part_log"));
  system.on("FROM system.disks", {{"host1", "default", "/var/lib/clickhouse/", "local", "100", "1000"}});
  const auto allowed = allowed_of({{"db", "events"}});
  ExplorerCaches caches;
  ExplorerCatalog catalog;
  std::string error;
  CHECK(load_explorer_catalog(system, runner, caches, identities(), allowed, catalog, &error));
  // The answer is there, without the ingress. It says which grant to give, and to whom.
  CHECK(!catalog.query_log_available);
  CHECK(!catalog.part_log_available);
  CHECK(catalog.replication_available);
  CHECK((catalog.unavailable_sections == std::vector<std::string>{"query_ingress", "part_ingress"}));
  CHECK_EQ(catalog.unavailable_issues.size(), size_t(2));
  CHECK_EQ(catalog.unavailable_issues[0].user, std::string("system_user"));
  CHECK_EQ(catalog.unavailable_issues[0].grant, std::string("SELECT ON system.query_log"));
  CHECK(!catalog.tables[0].client_ingress.rows_per_second_1m);
  // Any other error of a section is the error of the answer.
  FakeDb other;
  other.on("ORDER BY database, name", {base_row("db", "events", "MergeTree", "5", "500")});
  other.fail_on("FROM system.query_log", [] { throw server_error(60, "log table is gone"); });
  CHECK(!load_explorer_catalog(other, runner, caches, identities(), allowed, catalog, &error));
  CHECK(error.find("Query ingress query failed") == 0 && error.find("log table is gone") != std::string::npos);
  // When a system account fails on the base table, the runner is the fallback. The objects that lag are asked by name.
  FakeDb broken, fallback;
  broken.fail_on("ORDER BY database, name", [] { throw server_error(60, "no"); });
  fallback.on("ORDER BY database, name", {base_row("db", "events", "MergeTree", "5", "500")});
  broken.on("FROM system.disks", {{"h", "default", "/p/", "local", "1", "2"}});
  CHECK(load_explorer_catalog(broken, fallback, caches, identities(), allowed, catalog, &error));
  CHECK_EQ(catalog.tables.size(), size_t(1));
}

// A fake identity of the runner. Every database and table that the identity lists is readable.
struct ReadableSource : AclSource {
  std::map<std::string, std::vector<std::string>> tables;
  std::vector<std::string> show_databases() override {
    std::vector<std::string> out;
    for (const auto& item : tables) out.push_back(item.first);
    return out;
  }
  std::vector<std::string> show_objects(const std::string& database) override {
    const auto it = tables.find(database);
    return it == tables.end() ? std::vector<std::string>{} : it->second;
  }
  // "SELECT ON `db`.`t`" or "SELECT ON `db`.*" is granted when the database (and the table) is in the list of the identity.
  std::optional<bool> check_grant(const std::string& expression) override {
    const auto names = quoted_names(expression);
    if (names.size() < 2 && expression.find(".*") == std::string::npos) return false;
    const auto it = tables.find(names.empty() ? std::string() : names[0]);
    if (it == tables.end()) return false;
    if (expression.find(".*") != std::string::npos) return true;
    return std::find(it->second.begin(), it->second.end(), names[1]) != it->second.end();
  }
  void probe(const std::string&) override { throw AclDenied("Not enough privileges"); }
  std::vector<std::string> describe_columns(const std::string&, const std::string&) override { return {"a"}; }

 private:
  static std::vector<std::string> quoted_names(const std::string& text) {
    std::vector<std::string> out;
    for (size_t at = text.find('`'); at != std::string::npos; at = text.find('`', at + 1)) {
      const size_t end = text.find('`', at + 1);
      if (end == std::string::npos) break;
      out.push_back(text.substr(at + 1, end - at - 1));
      at = end;
    }
    return out;
  }
};

AclAccess readable_access(const std::map<std::string, std::vector<std::string>>& tables) {
  static int identities_made = 0;
  AclAccess access;
  access.key = "test-identity-" + std::to_string(++identities_made);
  access.connect = [tables](std::string*) -> std::unique_ptr<AclSource> {
    auto source = std::make_unique<ReadableSource>();
    source->tables = tables;
    return source;
  };
  return access;
}

void test_the_storage_map_names_only_what_the_runner_reads() {
  AclService acl(AclService::Options{});
  AclView view(acl, readable_access({{"db", {"big", "log", "mem"}}, {"other", {"x"}}}));
  FakeDb system, runner;
  // database, table, rows, bytes, parts
  system.on("FROM system.parts WHERE active AND database IN", {{"db", "big", "100", "5000", "3"}, {"db", "secret", "1", "999999", "1"}, {"other", "x", "1", "10", "1"}});
  system.on("FROM system.tables WHERE database IN", {{"db", "big", "MergeTree", "100", "5000"}, {"db", "log", "Log", "7", "700"}, {"db", "mem", "Memory", "3", "4096"},
                                                      {"db", "secret", "MergeTree", "1", "999999"}, {"other", "x", "MergeTree", "1", "10"}});
  ExplorerStorageMap map;
  std::string error;
  CHECK(load_explorer_storage_map(system, runner, view, map, &error));
  CHECK_EQ(map.table_limit_per_database, kStorageTablesPerDatabase);
  CHECK_EQ(map.databases.size(), size_t(2));
  CHECK_EQ(map.databases[0].name, std::string("db"));
  // The names are the runner's. "secret" is not there, and its bytes are not in the totals.
  CHECK_EQ(map.databases[0].objects, uint64_t(3));
  CHECK_EQ(map.databases[0].bytes, uint64_t(5700));
  CHECK_EQ(map.databases[0].tables.size(), size_t(2));
  CHECK_EQ(map.databases[0].tables[0].name, std::string("big"));
  CHECK_EQ(map.databases[0].tables[1].name, std::string("log"));
  CHECK_EQ(map.databases[0].resident_bytes, uint64_t(4096));
  CHECK_EQ(map.databases[1].bytes, uint64_t(10));
  // The databases are asked with one statement each. The names are bound.
  CHECK_EQ(system.params[0].size(), size_t(2));
  // When a system account fails on the parts, the runner answers.
  FakeDb failing, backup;
  AclView second(acl, readable_access({{"db", {"big"}}}));
  failing.fail_on("FROM system.parts", [] { throw server_error(60, "no parts for you"); });
  failing.on("FROM system.tables WHERE database IN", {{"db", "big", "MergeTree", "100", "5000"}});
  backup.on("FROM system.parts", {{"db", "big", "100", "6000", "3"}});
  CHECK(load_explorer_storage_map(failing, backup, second, map, &error));
  CHECK_EQ(map.databases[0].bytes, uint64_t(6000));
  // When both fail, the error says both.
  FakeDb bad, bad_runner;
  bad.fail_on("FROM system.parts", [] { throw server_error(60, "system parts broke"); });
  bad_runner.fail_on("FROM system.parts", [] { throw server_error(60, "runner parts broke"); });
  AclView third(acl, readable_access({{"db", {"big"}}}));
  CHECK(!load_explorer_storage_map(bad, bad_runner, third, map, &error));
  CHECK(error.find("system parts broke") != std::string::npos && error.find("runner parts broke") != std::string::npos);
  // No database is read by the runner. The result is an empty map, and nothing is asked.
  AclView none(acl, readable_access({}));
  FakeDb idle, idle_runner;
  CHECK(load_explorer_storage_map(idle, idle_runner, none, map, &error));
  CHECK(map.databases.empty());
  CHECK(idle.sqls.empty());
}

void test_the_summary_of_a_table() {
  FakeDb system, runner;
  const auto summary_row = [](const std::string& engine, const std::string& full, const std::string& rows, const std::string& bytes) {
    return Row{"db", "t", engine, full, "ts", "ts", "toDate(ts)", "", "tiered", rows, bytes, "9000", "/var/lib/clickhouse/data/db/t/", "2026-10-11 01:02:03"};
  };
  system.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1", {summary_row("MergeTree", "MergeTree ORDER BY ts /* the text of the system account */", "1", "2")});
  // engine_full is the text of the runner: ClickHouse masks its secrets for each user.
  runner.on("SELECT toString(engine_full) FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1", {{"MergeTree ORDER BY ts"}});
  system.on("secondary_indices_compressed_bytes)) FROM system.parts", {{"88"}});
  system.on("FROM system.parts WHERE active AND database = {p1:String} AND `table` = {p2:String}", {{"40", "4000", "1500", "3000", "5", "2", "default,cold", "2026-10-11 05:00:00"}});
  system.on("FROM system.projection_parts", {{"66"}});
  system.on("FROM system.query_log", {{"1", "2", "3", "4", "5", "6", "100", "1000", "2026-10-11 06:00:00"}});
  system.on("FROM system.part_log", {{"1", "2", "3", "4", "5", "6", "100", "1000", "7", "2026-10-11 06:00:01"}});
  system.on("toString(is_leader)", {{"3", "3", "0", "0", "0", "0", "r1", "/zk/t", "1", "2", "3", "4", "2026-10-11 06:00:02", "1r1\x1f" "0r2"}});
  ExplorerTableSummary out;
  std::string error;
  const auto allowed = allowed_of({{"db", "t"}});
  CHECK(load_explorer_table_summary(system, runner, allowed, "db", "t", out, &error));
  CHECK_EQ(out.engine, std::string("MergeTree"));
  CHECK_EQ(out.storage_policy, std::string("tiered"));
  CHECK((out.data_paths == std::vector<std::string>{"/var/lib/clickhouse/data/db/t/"}));
  // The active parts replace what system.tables says.
  CHECK(out.rows && *out.rows == 40);
  CHECK(out.logical_bytes && *out.logical_bytes == 4000);
  CHECK(out.uncompressed_bytes && *out.uncompressed_bytes == 3000);
  CHECK_EQ(out.active_parts, uint64_t(5));
  CHECK_EQ(out.partitions, uint64_t(2));
  CHECK((out.disks == std::vector<std::string>{"default", "cold"}));
  CHECK(out.secondary_indices_bytes && *out.secondary_indices_bytes == 88);
  CHECK(out.projection_bytes && *out.projection_bytes == 66);
  CHECK(out.client_ingress.bytes_total_1h && *out.client_ingress.bytes_total_1h == 1000);
  CHECK(out.physical_ingress.new_parts_per_minute && *out.physical_ingress.new_parts_per_minute == 7);
  // The replica set lists who is registered and who is active, sorted by name.
  CHECK(out.replication.available);
  CHECK_EQ(out.replication.replica_name, std::string("r1"));
  CHECK(out.replication.is_leader);
  CHECK_EQ(out.replication.replicas.size(), size_t(2));
  CHECK(out.replication.replicas[0].first == "r1" && out.replication.replicas[0].second);
  CHECK(out.replication.replicas[1].first == "r2" && !out.replication.replicas[1].second);
  CHECK_EQ(out.health, std::string("healthy"));   // 3 replicas of 3 are active, nothing is queued
  // The runner is asked for engine_full alone. The text of the system account is never kept.
  CHECK_EQ(out.engine_full, std::string("MergeTree ORDER BY ts"));
  CHECK_EQ(runner.sqls.size(), size_t(1));
  CHECK(runner.sqls[0].find("SELECT toString(engine_full) FROM system.tables") == 0);
  // The runner gives the same table when the system account has nothing. A table that nobody lists is not found.
  FakeDb empty, fallback;
  fallback.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1", {summary_row("Log", "Log", "0", "300")});
  fallback.on("SELECT toString(count()) FROM `db`.`t`", {{"12"}});
  CHECK(load_explorer_table_summary(empty, fallback, allowed, "db", "t", out, &error));
  CHECK_EQ(out.engine, std::string("Log"));
  CHECK(out.rows && *out.rows == 12);
  CHECK(!load_explorer_table_summary(empty, empty, allowed, "db", "t", out, &error));
  CHECK(error.find("Table summary metadata failed for db.t") == 0);
  CHECK(!load_explorer_table_summary(empty, empty, allowed, "db", "other", out, &error));
  CHECK_EQ(error, std::string("object not found"));
}

void test_the_summary_of_a_buffer_a_dictionary_and_a_log_table() {
  const auto allowed = allowed_of({{"db", "t"}});
  std::string error;
  ExplorerTableSummary out;
  // A Buffer: its rows are what it holds apart from its destination. The runner asks for the figure of the destination when the system account has none.
  FakeDb system, runner;
  system.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1",
            {{"db", "t", "Buffer", "Buffer(currentDatabase(), dst, 16, 10, 100, 10000, 1000000, 10000000, 100000000)", "", "", "", "", "", "130", "100", "", "", "2026-10-11 00:00:00"}});
  system.on("SELECT toString(total_rows) FROM system.tables", {});
  runner.on("SELECT toString(engine_full) FROM system.tables", {{"Buffer(currentDatabase(), dst, 16, 10, 100, 10000, 1000000, 10000000, 100000000)"}});
  runner.on("SELECT toString(total_rows) FROM system.tables", {{"100"}});
  CHECK(load_explorer_table_summary(system, runner, allowed, "db", "t", out, &error));
  CHECK(out.rows && *out.rows == 30);
  CHECK(out.resident_bytes && !out.logical_bytes);
  // The first statement of the runner reads engine_full. The second asks for the figure of the destination.
  CHECK(runner.sqls.size() >= 2 && runner.sqls[1].find("SELECT toString(total_rows) FROM system.tables") == 0);
  CHECK_EQ(runner.params[1][0].second, std::string("db"));
  CHECK_EQ(runner.params[1][1].second, std::string("dst"));
  // A dictionary has the rows and the allocation of system.dictionaries.
  FakeDb dict, none;
  dict.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1", {{"db", "t", "Dictionary", "", "", "", "", "", "", "", "", "", "", "2026-10-11 00:00:00"}});
  dict.on("FROM system.dictionaries", {{"9", "1024"}});
  CHECK(load_explorer_table_summary(dict, none, allowed, "db", "t", out, &error));
  CHECK(out.rows && *out.rows == 9);
  CHECK(out.resident_bytes && *out.resident_bytes == 1024);
}

void test_the_card_of_a_table() {
  FakeDb system, runner;
  AclService acl(AclService::Options{});
  AclView view(acl, readable_access({{"db", {"t", "v", "view2"}}, {"other", {"x"}}}));
  ExplorerTableSummary summary = table_summary("db", "t", "MergeTree");
  summary.engine_full = "MergeTree ORDER BY ts";
  summary.rows = 10;
  summary.logical_bytes = 1000;
  runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.t (`ts` DateTime, `s` String) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 7 DAY DELETE"}});
  // name, type, default kind, default, codec, compressed, uncompressed, comment, partition key, sorting key, primary key, sampling key
  system.on("FROM system.columns WHERE", {{"ts", "DateTime", "", "", "CODEC(Delta, ZSTD)", "100", "400", "when", "1", "1", "1", "0"}, {"s", "String", "", "", "", "300", "900", "", "0", "0", "0", "0"},
                                           {"hidden", "String", "", "", "", "1", "1", "", "0", "0", "0", "0"}});
  system.on("default_compression_codec", {{"LZ4\x1f" "ZSTD(1)"}});
  system.on("DESCRIBE TABLE", {});
  system.on("toString(countIf(part_type = 'Compact'))", {{"1", "2", "50", "5000", "10", "40", "200", "4000"}});
  system.on("FROM system.parts_columns", {{"ts", "150", "300"}, {"s", "350", "700"}});
  system.on("GROUP BY disk_name ORDER BY disk_name", {{"default", "2500", "30", "3"}});
  system.on("FROM system.disks", {{"default", "/var/lib/clickhouse/", "100", "1000"}, {"cold", "/mnt/cold/", "1", "2"}});
  system.on("ORDER BY active DESC, modification_time DESC LIMIT 1000", {{"all_1_1_0", "20261011", "default", "10", "1000", "2", "3", "0", "17", "1"}});
  system.on("GROUP BY partition ORDER BY max(modification_time) DESC LIMIT 1000", {{"20261011", "10", "1000", "1"}});
  system.on("FROM system.data_skipping_indices", {{"idx_s", "bloom_filter", "s", "55", "110"}});
  system.on("FROM system.projections", {{"prj", "Normal", "ts"}});
  system.on("FROM system.projection_parts", {{"prj", "21", "42", "63"}});
  system.on("FROM system.mutations", {{"m1", "DELETE WHERE 1", "2026-10-11 00:00:00", "0", "2", "", "", ""}});
  system.on("FROM system.merges", {{"20261011", "all_1_2_1", "1.5", "0.5", "2", "100", "200", "300"}});
  system.on("toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) FROM (SELECT arrayJoin(arrayZip(dependencies_database", {{"db", "v"}});
  system.on("if(engine = 'Buffer'", {{"db", "view2", "View", "", "WITH x AS (SELECT * FROM db.t) SELECT * FROM x"}});
  system.on("has(dependencies_table", {});
  system.on("toString(database), toString(name), toString(engine) FROM system.tables WHERE database IN", {{"db", "v", "View"}, {"db", "view2", "View"}});
  runner.on("GROUP BY database ORDER BY database", {{"db", "3", "30", "3000"}, {"other", "1", "1", "500"}});
  ExplorerTableDetail detail;
  std::string error;
  // The runner reads two columns of the table. The third column that system.columns lists is not in the card.
  AllowedObjectSet allowed;
  AllowedTable entry;
  entry.database = "db";
  entry.table = "t";
  entry.partial = true;
  entry.columns = {"ts", "s"};
  allowed.add_table(entry);
  CHECK(load_explorer_table_detail(system, runner, view, allowed, "db", "t", summary, detail, &error));
  // The DDL, its table TTL (the TTL of a column is not the table TTL), and the columns that the runner may read, in the order of the table.
  CHECK(detail.create_table_query.find("CREATE TABLE db.t") == 0);
  CHECK_EQ(detail.table_ttl, std::string("ts + INTERVAL 7 DAY DELETE"));
  CHECK_EQ(detail.columns.size(), size_t(2));
  CHECK_EQ(detail.columns[0].name, std::string("ts"));
  CHECK(detail.columns[0].in_sorting_key && detail.columns[0].in_partition_key && !detail.columns[1].in_sorting_key);
  CHECK_EQ(detail.default_compression_codecs.size(), size_t(2));
  // The card has parts of two formats. The sizes are of the Wide parts. The share is against their total.
  // The card says that the compact bytes are shared.
  CHECK_EQ(detail.column_storage.compact_parts, uint64_t(1));
  CHECK_EQ(detail.column_storage.wide_parts, uint64_t(2));
  CHECK(detail.column_storage.wide_compressed_bytes && *detail.column_storage.wide_compressed_bytes == 200);
  CHECK(detail.columns[0].compressed_bytes && *detail.columns[0].compressed_bytes == 150);
  CHECK(detail.columns[1].relative_weight && *detail.columns[1].relative_weight == 350.0 / 200.0);
  CHECK(std::find(detail.unavailable_sections.begin(), detail.unavailable_sections.end(), "column_sizes_mixed_shared") != detail.unavailable_sections.end());
  // The disks of the table are shown with their capacity. Only the disks of the table are shown. The card also shows its parts and partitions,
  // its indexes and projections (with the size of the projection), and its mutations and merges.
  CHECK_EQ(detail.storage.size(), size_t(1));
  CHECK_EQ(detail.storage[0].path, std::string("/var/lib/clickhouse/"));
  CHECK(detail.storage[0].free_space && *detail.storage[0].free_space == 100);
  CHECK_EQ(detail.parts.size(), size_t(1));
  CHECK(detail.parts[0].active);
  CHECK_EQ(detail.partitions.size(), size_t(1));
  CHECK_EQ(detail.indexes_and_projections.size(), size_t(2));
  CHECK_EQ(detail.indexes_and_projections[0].kind, std::string("index:bloom_filter"));
  CHECK_EQ(detail.indexes_and_projections[1].kind, std::string("projection:Normal"));
  CHECK(detail.indexes_and_projections[1].on_disk_bytes && *detail.indexes_and_projections[1].on_disk_bytes == 63);
  CHECK_EQ(detail.mutations.size(), size_t(1));
  CHECK_EQ(detail.merges.size(), size_t(1));
  CHECK_EQ(detail.merges[0].elapsed_seconds, 1.5);
  // The lineage shows the view of the dependencies. It also shows the view whose SELECT reads the table through a CTE. Each view has its engine.
  CHECK_EQ(detail.dependencies.size(), size_t(2));
  CHECK_EQ(detail.dependencies[0].table, std::string("v"));
  CHECK_EQ(detail.dependencies[0].relation, std::string("downstream"));
  CHECK_EQ(detail.dependencies[1].table, std::string("view2"));
  CHECK_EQ(detail.dependencies[1].kind, std::string("view"));
  CHECK_EQ(detail.dependencies[0].engine, std::string("View"));
  // The footprint of the database and of the server is used for the shares of the card.
  CHECK(detail.database_footprint_bytes && *detail.database_footprint_bytes == 3000);
  CHECK(detail.clickhouse_footprint_bytes && *detail.clickhouse_footprint_bytes == 3500);
  // The card of a table that the set does not hold is not made.
  CHECK(!load_explorer_table_detail(system, runner, view, allowed, "db", "x", summary, detail, &error));
  CHECK_EQ(error, std::string("object not found"));
}

void test_a_neighbour_in_the_lineage_is_named_only_when_the_runner_reads_it() {
  FakeDb system, runner;
  AclService acl(AclService::Options{});
  // The runner reads `t` and `v` of db. `secret` is not in the list. So CHECK GRANT is never asked for it as readable.
  AclView view(acl, readable_access({{"db", {"t", "v"}}}));
  ExplorerTableSummary summary = table_summary("db", "t", "MergeTree");
  runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.t (`ts` DateTime) ENGINE = MergeTree ORDER BY ts"}});
  system.on("FROM system.columns WHERE", {{"ts", "DateTime", "", "", "", "1", "1", "", "0", "0", "0", "0"}});
  system.on("toString(tupleElement(dep, 1)), toString(tupleElement(dep, 2)) FROM (SELECT arrayJoin(arrayZip(dependencies_database", {{"db", "v"}, {"db", "row"}, {"secret", "x"}, {"db", "_row"}});
  system.on("has(dependencies_table", {{"db", "v"}});
  ExplorerTableDetail detail;
  std::string error;
  CHECK(load_explorer_table_detail(system, runner, view, allowed_of({{"db", "t"}}), "db", "t", summary, detail, &error));
  // The runner cannot name the neighbour, so the neighbour is not listed. The pseudo-object `row` is not an object.
  // The view appears once for each relation.
  CHECK_EQ(detail.dependencies.size(), size_t(2));
  CHECK_EQ(detail.dependencies[0].table, std::string("v"));
  CHECK_EQ(detail.dependencies[0].relation, std::string("downstream"));
  CHECK_EQ(detail.dependencies[1].relation, std::string("upstream"));
  CHECK(std::find(detail.unavailable_sections.begin(), detail.unavailable_sections.end(), "lineage_visibility") == detail.unavailable_sections.end());
}

void test_a_section_that_cannot_be_read_degrades_the_card_and_a_view_without_schema_is_browsable() {
  FakeDb system, runner;
  AclService acl(AclService::Options{});
  AclView view(acl, readable_access({{"db", {"v"}}}));
  ExplorerTableSummary summary = table_summary("db", "v", "View");
  runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE VIEW db.v AS SELECT 1 AS a WHERE {x:UInt8} = 1"}});
  // A parameterized view has no row in system.columns. DESCRIBE refuses it.
  system.fail_on("DESCRIBE TABLE", [] { throw server_error(36, "Query parameter x was not set"); });
  runner.fail_on("DESCRIBE TABLE", [] { throw server_error(36, "Query parameter x was not set"); });
  system.fail_on("FROM system.mutations", denied("SELECT ON system.mutations"));
  ExplorerTableDetail detail;
  std::string error;
  CHECK(load_explorer_table_detail(system, runner, view, allowed_of({{"db", "v"}}), "db", "v", summary, detail, &error));
  CHECK(detail.columns.empty());
  CHECK(std::find(detail.unavailable_sections.begin(), detail.unavailable_sections.end(), "columns") != detail.unavailable_sections.end());
  CHECK(std::find(detail.unavailable_sections.begin(), detail.unavailable_sections.end(), "mutation") != detail.unavailable_sections.end());
  CHECK_EQ(detail.unavailable_issues.size(), size_t(1));
  CHECK_EQ(detail.unavailable_issues[0].grant, std::string("SELECT ON system.mutations"));
  // A table (not a view) with no readable column is an error.
  FakeDb table_system, table_runner;
  ExplorerTableSummary plain = table_summary("db", "v", "MergeTree");
  table_runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.v (a Int8) ENGINE = MergeTree ORDER BY a"}});
  CHECK(!load_explorer_table_detail(table_system, table_runner, view, allowed_of({{"db", "v"}}), "db", "v", plain, detail, &error));
  CHECK_EQ(error, std::string("Column metadata query returned no readable columns for db.v"));
  // The DDL that nobody can read is the error of the card.
  FakeDb mute;
  CHECK(!load_explorer_table_detail(mute, mute, view, allowed_of({{"db", "v"}}), "db", "v", plain, detail, &error));
  CHECK(error.find("DDL metadata query failed for db.v") == 0);
  // Any other error of a section is the error of the card.
  FakeDb broken;
  broken.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.v (a Int8) ENGINE = MergeTree ORDER BY a"}});
  broken.on("FROM system.columns WHERE", {{"a", "Int8", "", "", "", "1", "1", "", "0", "0", "0", "0"}});
  broken.fail_on("FROM system.parts WHERE database", [] { throw server_error(60, "parts table is gone"); });
  CHECK(!load_explorer_table_detail(broken, broken, view, allowed_of({{"db", "v"}}), "db", "v", plain, detail, &error));
  CHECK(error.find("Parts metadata query failed") == 0);
}

void test_the_distributed_table_and_its_queue() {
  FakeDb system, runner;
  AclService acl(AclService::Options{});
  AclView view(acl, readable_access({{"db", {"d", "local"}}}));
  ExplorerTableSummary summary = table_summary("db", "d", "Distributed");
  summary.engine_full = "Distributed('c1', db, local, rand())";
  runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.d (a Int8) ENGINE = Distributed('c1', db, local, rand())"}});
  system.on("FROM system.columns WHERE", {{"a", "Int8", "", "", "", "", "", "", "0", "0", "0", "0"}});
  system.on("FROM system.distribution_queue", {{"/path/", "1", "2", "3", "4", "5", "6", "boom", "2026-10-11 00:00:00"}});
  system.on("FROM system.clusters WHERE cluster = {p1:String}", {{"c1", "1", "1", "h1", "10.0.0.1", "9000", "1", "0", "0", "0"}});
  ExplorerTableDetail detail;
  std::string error;
  CHECK(load_explorer_table_detail(system, runner, view, allowed_of({{"db", "d"}}), "db", "d", summary, detail, &error));
  CHECK_EQ(detail.distributed_cluster, std::string("c1"));
  CHECK_EQ(detail.distributed_database, std::string("db"));
  CHECK_EQ(detail.distributed_table, std::string("local"));
  CHECK_EQ(detail.distribution_queue.size(), size_t(1));
  CHECK(detail.distribution_queue[0].blocked);
  CHECK_EQ(detail.topology.size(), size_t(1));
  CHECK_EQ(detail.topology[0].host_name, std::string("h1"));
  // The destination is a neighbour that the runner reads. It is in the lineage as the route of the table.
  CHECK_EQ(detail.dependencies.size(), size_t(1));
  CHECK_EQ(detail.dependencies[0].kind, std::string("distributed_route"));
  // The cluster is a parameter of its statement.
  bool bound = false;
  for (size_t i = 0; i < system.sqls.size(); ++i) {
    if (system.sqls[i].find("FROM system.clusters") == std::string::npos) continue;
    bound = system.params[i].size() == 1 && system.params[i][0].second == "c1";
  }
  CHECK(bound);
}

void test_the_functions_of_the_runner() {
  FakeDb runner;
  runner.on("FROM system.documentation", {{"plus", "Function", "Adds numbers.", "src/plus.cpp"}, {"sum", "Aggregate Function", "Sums.", ""}, {"add", "Function", "Alias of `plus`.", ""},
                                           {"", "Function", "no name", ""}});
  // name, is aggregate, origin, create query, description, syntax, arguments, parameters, returned value, examples, introduced in, categories
  runner.on("FROM system.functions", {{"plus", "0", "System", "", "", "plus(a, b)", "a, b", "", "a number", "SELECT plus(1, 2)", "1.1", "Arithmetic"},
                                       {"my_udf", "0", "SQLUserDefined", "CREATE FUNCTION my_udf AS x -> x + 1", "adds one", "", "", "", "", "", "", ""},
                                       {"sum", "1", "System", "", "", "", "", "", "", "", "", "Aggregate"}});
  ExplorerFunctionsCatalog out;
  std::string error;
  CHECK(load_explorer_functions(runner, out, &error));
  CHECK(out.documentation_available);
  const auto by_name = [&](const std::string& name) -> const ExplorerFunctionInfo& {
    for (const auto& item : out.functions) if (item.name == name) return item;
    throw std::runtime_error("no " + name);
  };
  // The documentation keeps its text. The structured fields complete it. A user-defined function has its CREATE as its syntax, and its own description.
  CHECK_EQ(by_name("plus").description, std::string("Adds numbers."));
  CHECK_EQ(by_name("plus").syntax, std::string("plus(a, b)"));
  CHECK_EQ(by_name("plus").introduced_in, std::string("1.1"));
  CHECK_EQ(by_name("plus").category, std::string("Arithmetic"));
  CHECK(!by_name("plus").user_defined);
  CHECK(by_name("my_udf").user_defined);
  CHECK_EQ(by_name("my_udf").syntax, std::string("CREATE FUNCTION my_udf AS x -> x + 1"));
  CHECK_EQ(by_name("my_udf").description, std::string("adds one"));
  CHECK_EQ(by_name("my_udf").category, std::string("Function"));
  CHECK_EQ(by_name("sum").kind, std::string("Aggregate Function"));
  // An alias is resolved here, once.
  CHECK_EQ(by_name("add").alias_documents.size(), size_t(1));
  CHECK_EQ(by_name("add").alias_documents[0].name, std::string("plus"));
  CHECK_EQ(out.functions.size(), size_t(4));
  CHECK(error.empty());
  // No documentation table: the error says it, and no answer is made.
  FakeDb none;
  none.fail_on("FROM system.documentation", [] { throw server_error(60, "no documentation"); });
  CHECK(!load_explorer_functions(none, out, &error));
  CHECK(error.find("Function documentation query failed: ") == 0);
  FakeDb half;
  half.on("FROM system.documentation", {{"plus", "Function", "Adds numbers.", ""}});
  half.fail_on("FROM system.functions", [] { throw server_error(47, "no is_aggregate"); });
  CHECK(!load_explorer_functions(half, out, &error));
  CHECK(error.find("Function metadata query failed: ") == 0);
}

void test_the_preview_of_a_table() {
  FakeDb runner;
  runner.on("DESCRIBE TABLE", {{"id", "UInt64"}, {"secret", "String"}, {"agg", "AggregateFunction(count)"}});
  clickhouse::Block rows;
  {
    auto id = std::make_shared<clickhouse::ColumnUInt64>();
    id->Append(1);
    id->Append(2);
    auto agg = std::make_shared<clickhouse::ColumnString>();
    agg->Append("10");
    agg->Append("20");
    rows.AppendColumn("id", id);
    rows.AppendColumn("agg", agg);
  }
  runner.on_block("SELECT `id`, toString(finalizeAggregation(`agg`)) AS `agg` FROM `db`.`t` LIMIT 5", [rows](const std::string&) { return rows; });
  // The runner reads `id` and `agg`. `secret` is not asked for.
  AllowedObjectSet allowed;
  AllowedTable entry;
  entry.database = "db";
  entry.table = "t";
  entry.partial = true;
  entry.columns = {"id", "agg"};
  allowed.add_table(entry);
  ExplorerPreview preview;
  std::string error;
  CHECK(load_explorer_preview(runner, allowed, "db", "t", 5, preview, &error));
  CHECK_EQ(preview.columns.size(), size_t(2));
  CHECK_EQ(preview.columns[0].name, std::string("id"));
  CHECK(!preview.columns[0].finalized_for_preview && preview.columns[1].finalized_for_preview);
  CHECK_EQ(preview.columns[1].type, std::string("AggregateFunction(count)"));
  CHECK_EQ(preview.rows.size(), size_t(2));
  CHECK_EQ(preview.rows[0][0], std::string("\"1\""));   // a UInt64 is a JSON string
  CHECK_EQ(preview.rows[1][1], std::string("\"20\""));
  CHECK_EQ(preview.limit, size_t(5));
  // The limit is at least 1 and at most 500. A table that the set does not hold is not previewed. A table with no readable column is an error.
  FakeDb capped;
  capped.on("DESCRIBE TABLE", {{"id", "UInt64"}});
  AllowedObjectSet all;
  AllowedTable full;
  full.database = "db";
  full.table = "t";
  full.all_columns = true;
  all.add_table(full);
  CHECK(load_explorer_preview(capped, all, "db", "t", 100000, preview, &error));
  CHECK_EQ(preview.limit, size_t(500));
  CHECK(capped.sqls.back().find("LIMIT 500") != std::string::npos);
  CHECK(load_explorer_preview(capped, all, "db", "t", 0, preview, &error) && preview.limit == 1);
  CHECK(!load_explorer_preview(capped, all, "db", "other", 5, preview, &error));
  CHECK_EQ(error, std::string("object not found"));
  FakeDb nothing;
  error.clear();
  CHECK(!load_explorer_preview(nothing, all, "db", "t", 5, preview, &error));
  CHECK_EQ(error, std::string("no readable columns"));
  // A block with the wrong number of columns is an error of the preview. It is not a silent cut.
  FakeDb wrong;
  wrong.on("DESCRIBE TABLE", {{"id", "UInt64"}, {"b", "String"}});
  wrong.on("SELECT `id`, `b` FROM", {{"1"}});
  CHECK(!load_explorer_preview(wrong, all, "db", "t", 5, preview, &error));
  CHECK(error.find("Explorer preview returned 1 columns; expected 2.") == 0);
}

void test_the_graph_is_read_as_the_system_account_and_built() {
  // The system account gives the structure and the numbers. The runner gives the DDL texts, which ClickHouse masks for each user.
  FakeDb system, runner;
  system.on("FROM system.disks ORDER BY name", {{"host1", "default", "/var/lib/clickhouse/", "local", "10", "100"}});
  system.on("FROM system.storage_policies", {{"tiered", "hot", "1", "default", "JBOD", "0", "0.1"}});
  // database, name, engine, data paths, modification time, recently modified
  system.on("arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8", {
      {"db", "src", "MergeTree", "", "2026-10-11 00:00:00", "0"}, {"db", "mv", "MaterializedView", "", "2026-10-11 00:00:00", "0"}, {"db", "dst", "MergeTree", "", "2026-10-11 00:00:00", "0"},
      {"db", "dist", "Distributed", "", "2026-10-11 00:00:00", "0"}, {"secret", "hidden", "MergeTree", "", "2026-10-11 00:00:00", "0"}});
  runner.on_fn("toString(engine_full), toString(create_table_query), toString(as_select) FROM system.tables WHERE database = {p1:String}", [](const std::string&) -> Rows {
    return {{"db", "src", "MergeTree ORDER BY ts", "", ""}, {"db", "dst", "MergeTree ORDER BY ts", "", ""},
            {"db", "mv", "", "CREATE MATERIALIZED VIEW db.mv TO db.dst AS SELECT * FROM db.src", "SELECT * FROM db.src"},
            {"db", "dist", "Distributed(c1, db, dst, rand())", "", ""}};
  });
  system.on("FROM (SELECT toString(database) AS database", {{"db", "src", "db", "mv"}, {"secret", "hidden", "db", "src"}});
  system.on("loading_dependencies_database", {});
  system.on("FROM system.clusters ORDER BY cluster, shard_num, replica_num", {{"c1", "1", "1", "h1"}, {"c1", "2", "1", "h2"}, {"other", "1", "1", "z"}});
  system.on("view_refreshes", {{"1"}});
  ExplorerCatalog catalog;
  catalog.metric_scope = "local-replica";
  auto src = table_summary("db", "src", "MergeTree");
  src.storage_policy = "tiered";
  catalog.tables = {src, table_summary("db", "mv", "MaterializedView"), table_summary("db", "dst", "MergeTree"), table_summary("db", "dist", "Distributed")};
  catalog.unavailable_sections = {"part_ingress"};
  const auto allowed = allowed_of({{"db", "src"}, {"db", "mv"}, {"db", "dst"}, {"db", "dist"}});
  ExplorerCaches caches;
  ExplorerGraph graph;
  std::string error;
  CHECK(load_explorer_graph(system, runner, caches, "runner-key", allowed, catalog, graph, &error));
  CHECK_EQ(graph.metric_scope, std::string("local-replica"));
  CHECK((graph.unavailable_sections == std::vector<std::string>{"part_ingress"}));
  CHECK(graph.refreshable_views_available);
  CHECK(find_edge(graph, "table:db.src", "table:db.mv", "materialized_view") != nullptr);
  CHECK(find_edge(graph, "table:db.mv", "table:db.dst", "materialized_view_output") != nullptr);
  CHECK(find_edge(graph, "table:db.dist", "table:db.dst", "distributed_route") != nullptr);
  CHECK(find_node(graph, "physical:cluster:c1:shard:2:replica:1") != nullptr);
  CHECK(find_node(graph, "physical:database:db:policy:tiered") != nullptr);
  // The object that the runner does not read is not a node. No edge names it.
  for (const auto& node : graph.nodes) CHECK(node.database != "secret");
  // The storage policies are read when a table names one. The clusters are read when a Distributed table names one, and only the clusters that it names.
  CHECK_EQ(system.count("FROM system.storage_policies"), size_t(1));
  CHECK_EQ(system.count("FROM system.clusters"), size_t(1));
  // The DDL texts come from the cache of the server. The second graph asks nothing new for them.
  const size_t ddl_reads = runner.count("toString(create_table_query)");
  CHECK(ddl_reads > 0);
  CHECK_EQ(system.count("toString(create_table_query)"), size_t(0));
  CHECK(load_explorer_graph(system, runner, caches, "runner-key", allowed, catalog, graph, &error));
  CHECK_EQ(runner.count("toString(create_table_query)"), ddl_reads);
  // A system account that may not read system.disks degrades the graph. The answer names the grant.
  FakeDb limited;
  limited.fail_on("FROM system.disks ORDER BY name", denied("SELECT ON system.disks"));
  limited.on("arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8", {{"db", "src", "MergeTree", "", "2026-10-11 00:00:00", "0"}});
  limited.on("FROM (SELECT toString(database) AS database", {});
  limited.on("view_refreshes", {{"0"}});
  ExplorerCatalog bare;
  CHECK(load_explorer_graph(limited, runner, caches, "other-key", allowed, bare, graph, &error));
  CHECK((graph.unavailable_sections == std::vector<std::string>{"disk"}));
  CHECK_EQ(graph.unavailable_issues[0].grant, std::string("SELECT ON system.disks"));
  CHECK(!graph.refreshable_views_available);
  // The dependencies are required. Without them, there is no graph.
  FakeDb broken;
  broken.on("arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8", {{"db", "src", "MergeTree", "", "2026-10-11 00:00:00", "0"}});
  broken.fail_on("FROM (SELECT toString(database) AS database", [] { throw server_error(60, "dependencies are gone"); });
  CHECK(!load_explorer_graph(broken, runner, caches, "third-key", allowed, bare, graph, &error));
  CHECK(error.find("Graph dependency metadata query failed") == 0);
}


// ---- the scope of the graph ----

httplib::Request graph_request(std::initializer_list<std::pair<const char*, const char*>> params) {
  httplib::Request req;
  req.method = "GET";
  for (const auto& [name, value] : params) req.params.emplace(name, value);
  return req;
}

void test_the_scope_of_a_request() {
  const auto none = read_graph_scope(graph_request({}));
  CHECK(none.database.empty() && none.focus_id.empty());
  CHECK_EQ(none.depth, 1);
  CHECK(!none.physical && !none.include_system && none.include_non_storing && none.expansions.empty());
  const auto focus = read_graph_scope(graph_request({{"focus_database", "db"}, {"focus_table", "t"}, {"depth", "3"}, {"mode", "physical"}, {"include_system", "1"},
                                                     {"include_non_storing", "0"}, {"database", "db"}}));
  CHECK_EQ(focus.focus_id, std::string("table:db.t"));
  CHECK_EQ(focus.depth, 3);
  CHECK(focus.physical && focus.include_system && !focus.include_non_storing);
  CHECK_EQ(focus.database, std::string("db"));
  // A focus needs both names. A depth is clamped to 0..8. A value that is not a number is the default.
  CHECK(read_graph_scope(graph_request({{"focus_database", "db"}})).focus_id.empty());
  CHECK_EQ(read_graph_scope(graph_request({{"depth", "99"}})).depth, 8);
  CHECK_EQ(read_graph_scope(graph_request({{"depth", "-4"}})).depth, 0);
  CHECK_EQ(read_graph_scope(graph_request({{"depth", "x"}})).depth, 1);
  CHECK(!read_graph_scope(graph_request({{"mode", "logical"}})).physical);
  CHECK(!read_graph_scope(graph_request({{"include_system", "0"}})).include_system);
  CHECK(read_graph_scope(graph_request({{"include_non_storing", "1"}})).include_non_storing);
  // The expansions are "up:<id>" and "down:<id>". Anything else is nothing. At most 64 expansions are used.
  const auto expand = read_graph_scope(graph_request({{"expand", "up:table:db.a"}, {"expand", "down:table:db.b"}, {"expand", "up:"}, {"expand", "sideways:x"}, {"expand", "down:"}}));
  CHECK_EQ(expand.expansions.size(), size_t(2));
  CHECK(expand.expansions[0].first && expand.expansions[0].second == "table:db.a");
  CHECK(!expand.expansions[1].first && expand.expansions[1].second == "table:db.b");
  httplib::Request many;
  for (int i = 0; i < 100; ++i) many.params.emplace("expand", "up:table:db.t" + std::to_string(i));
  CHECK_EQ(read_graph_scope(many).expansions.size(), kMaxGraphExpansions);
  CHECK(is_system_database("system") && is_system_database("INFORMATION_SCHEMA") && is_system_database("information_schema") && !is_system_database("db"));
}

ExplorerGraphNode logical_node(const std::string& database, const std::string& name, const std::string& kind) {
  ExplorerGraphNode node;
  node.id = "table:" + database + "." + name;
  node.layer = "logical";
  node.kind = kind;
  node.database = database;
  node.name = name;
  return node;
}

ExplorerGraphNode physical_node(const std::string& id, const std::string& kind, const std::string& database = "db") {
  ExplorerGraphNode node;
  node.id = id;
  node.layer = "physical";
  node.kind = kind;
  node.database = database;
  return node;
}

void add_edge(ExplorerGraph& graph, const std::string& from, const std::string& to, const std::string& kind) {
  ExplorerGraphEdge edge;
  edge.id = "edge:" + std::to_string(graph.edges.size() + 1);
  edge.from = from;
  edge.to = to;
  edge.kind = kind;
  graph.edges.push_back(std::move(edge));
}

std::vector<std::string> node_ids(const ExplorerGraph& graph) {
  std::vector<std::string> out;
  for (const auto& node : graph.nodes) out.push_back(node.id);
  return out;
}

// The graph is: src -> raw (view) -> mv -> dst, dst -> report (view). The system table that src reads is also in the graph.
ExplorerGraph lineage_graph() {
  ExplorerGraph graph;
  graph.nodes = {logical_node("db", "src", "mergetree"), logical_node("db", "raw", "view"), logical_node("db", "mv", "materialized_view"),
                 logical_node("db", "dst", "mergetree"), logical_node("db", "report", "view"), logical_node("system", "numbers", "table"),
                 logical_node("db", "far", "mergetree")};
  add_edge(graph, "table:db.src", "table:db.raw", "view");
  add_edge(graph, "table:db.raw", "table:db.mv", "dependency");
  add_edge(graph, "table:db.mv", "table:db.dst", "materialized_view_output");
  add_edge(graph, "table:db.dst", "table:db.report", "view");
  add_edge(graph, "table:system.numbers", "table:db.src", "dependency");
  add_edge(graph, "table:db.report", "table:db.far", "dependency");
  return graph;
}

void test_the_lineage_around_a_table() {
  const ExplorerGraph graph = lineage_graph();
  GraphScopeRequest scope;
  scope.focus_id = "table:db.src";
  scope.depth = 1;
  // One hop from src reaches its neighbour on each side. The system table is not shown.
  auto out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw"}));
  CHECK_EQ(out.edges.size(), size_t(1));
  // The hidden counts show where something is left to expand. raw has one more hop downstream (mv).
  // src has the system table upstream, which is hidden.
  CHECK_EQ(out.nodes[1].hidden_downstream, uint64_t(1));
  CHECK_EQ(out.nodes[1].hidden_upstream, uint64_t(0));
  CHECK_EQ(out.nodes[0].hidden_upstream, uint64_t(0));
  CHECK(logical_scope_has_more(graph, scope, out, true));
  // Depth 3 reaches dst. There is more (report).
  scope.depth = 3;
  out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw", "table:db.mv", "table:db.dst"}));
  CHECK(logical_scope_has_more(graph, scope, out, true));
  scope.depth = 8;
  out = scope_graph(graph, scope, true, true);
  CHECK_EQ(out.nodes.size(), size_t(6));
  CHECK(!logical_scope_has_more(graph, scope, out, true));   // depth 8 is the end
  // With the system objects, the table that src reads is one hop upstream.
  scope.depth = 1;
  scope.include_system = true;
  out = scope_graph(graph, scope, true, true);
  CHECK_EQ(out.nodes.size(), size_t(3));
  CHECK_EQ(out.nodes[0].hidden_downstream, uint64_t(0));
  scope.include_system = false;
  // When the objects that do not store data are hidden, a view and a materialized view do not cost a hop. So depth 1 reaches dst.
  // The views between them are sent to the page, so that the page can contract them.
  scope.include_non_storing = false;
  out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw", "table:db.mv", "table:db.dst", "table:db.report"}));
  // An expansion adds one hop from a node that is shown, in one direction. An unknown or hidden anchor expands nothing.
  scope.include_non_storing = true;
  scope.expansions = {{false, "table:db.raw"}};
  out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw", "table:db.mv"}));
  scope.expansions = {{false, "table:db.raw"}, {false, "table:db.mv"}};
  out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw", "table:db.mv", "table:db.dst"}));
  scope.expansions = {{false, "table:db.mv"}, {true, "table:db.nope"}, {false, "table:db.dst"}};
  out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.src", "table:db.raw"}));
  // A focus that the graph does not know, or that is hidden, gives nothing. Lineage turned off gives nothing.
  scope.expansions.clear();
  scope.focus_id = "table:db.nope";
  CHECK(scope_graph(graph, scope, true, true).nodes.empty());
  scope.focus_id = "table:system.numbers";
  CHECK(scope_graph(graph, scope, true, true).nodes.empty());
  scope.focus_id = "table:db.src";
  CHECK(scope_graph(graph, scope, false, true).nodes.empty());
  // No focus: the logical nodes of a database (or of all) are shown, without the system database.
  scope.focus_id.clear();
  scope.database = "db";
  CHECK_EQ(scope_graph(graph, scope, true, true).nodes.size(), size_t(6));
  scope.database = "system";
  CHECK(scope_graph(graph, scope, true, true).nodes.empty());
  scope.database.clear();
  CHECK_EQ(scope_graph(graph, scope, true, true).nodes.size(), size_t(6));
  scope.include_system = true;
  CHECK_EQ(scope_graph(graph, scope, true, true).nodes.size(), size_t(7));
}

void test_the_physical_scope_of_a_table() {
  ExplorerGraph graph;
  graph.nodes = {logical_node("db", "events", "mergetree"), logical_node("db", "buf", "buffer"), logical_node("db", "sink", "mergetree"),
                 logical_node("db", "other", "mergetree"), physical_node("p:policy", "storage_policy"), physical_node("p:volume", "volume"),
                 physical_node("p:disk", "disk"), physical_node("p:other_disk", "disk")};
  add_edge(graph, "table:db.buf", "table:db.sink", "buffer");
  add_edge(graph, "table:db.sink", "p:policy", "storage_policy");
  add_edge(graph, "p:policy", "p:volume", "policy_volume");
  add_edge(graph, "p:volume", "p:disk", "volume_disk");
  add_edge(graph, "table:db.other", "p:other_disk", "contains");
  GraphScopeRequest scope;
  scope.focus_id = "table:db.sink";
  scope.physical = true;
  // The focused table, the Buffer that feeds it, and the physical nodes below them are shown. The placement of another table is not shown.
  auto out = scope_graph(graph, scope, true, true);
  CHECK((node_ids(out) == std::vector<std::string>{"table:db.buf", "table:db.sink", "p:policy", "p:volume", "p:disk"}));
  CHECK_EQ(out.edges.size(), size_t(4));
  CHECK(scope_graph(graph, scope, true, false).nodes.empty());
  // The storage mode of a database shows every logical and physical node of it.
  scope.focus_id.clear();
  scope.database = "db";
  CHECK_EQ(scope_graph(graph, scope, true, true).nodes.size(), size_t(8));
  // Tables that own a placement are these: the one with a policy, and the other with a disk.
  // The Buffer that routes to a table that has one is also listed.
  const auto available = logical_storage_available_ids(graph);
  CHECK(available.count("table:db.sink") && available.count("table:db.other") && available.count("table:db.buf"));
  CHECK(!available.count("table:db.events"));
}

// A graph of random nodes and edges, with the kinds of an Explorer graph.
ExplorerGraph random_graph(std::mt19937& rng) {
  static const char* kinds[] = {"mergetree", "view", "materialized_view", "refreshable_materialized_view", "buffer", "dictionary", "distributed", "table", "memory"};
  static const char* databases[] = {"a", "b", "system"};
  ExplorerGraph graph;
  const size_t logical = 6 + rng() % 30;
  for (size_t i = 0; i < logical; ++i) {
    graph.nodes.push_back(logical_node(databases[rng() % 3], "t" + std::to_string(i), kinds[rng() % 9]));
  }
  const size_t physical = rng() % 8;
  for (size_t i = 0; i < physical; ++i) graph.nodes.push_back(physical_node("p" + std::to_string(i), i % 3 == 0 ? "disk" : "volume", databases[rng() % 3]));
  const size_t edges = logical + rng() % (2 * logical);
  for (size_t i = 0; i < edges; ++i) {
    const size_t from = rng() % graph.nodes.size();
    const size_t to = rng() % graph.nodes.size();
    if (from == to) continue;
    const bool from_buffer = graph.nodes[from].kind == "buffer";
    const char* edge_kinds[] = {"dependency", "view", "materialized_view", "buffer", "contains"};
    add_edge(graph, graph.nodes[from].id, graph.nodes[to].id, from_buffer && rng() % 2 ? "buffer" : edge_kinds[rng() % 5]);
  }
  // An edge to a node that is not in the graph is ignored. A duplicate is ignored in the same way.
  add_edge(graph, graph.nodes[0].id, "table:nowhere.x", "dependency");
  return graph;
}

reference::ExplorerGraphRequestScope reference_of(const GraphScopeRequest& scope) {
  reference::ExplorerGraphRequestScope out;
  out.database = scope.database;
  out.focus_database = scope.focus_database;
  out.focus_table = scope.focus_table;
  out.focus_id = scope.focus_id;
  out.depth = scope.depth;
  out.physical = scope.physical;
  out.include_system = scope.include_system;
  out.include_non_storing = scope.include_non_storing;
  out.expansions = scope.expansions;
  return out;
}

void test_the_scope_is_what_the_old_code_made_of_it() {
  std::mt19937 rng(20261011);
  size_t compared = 0, nonempty = 0, with_more = 0;
  for (int round = 0; round < 60; ++round) {
    ExplorerGraph graph = random_graph(rng);
    const auto index = index_graph(graph);
    // Every graph is asked with and without its index, for many scopes.
    for (int ask = 0; ask < 40; ++ask) {
      GraphScopeRequest scope;
      scope.depth = static_cast<int>(rng() % 5);
      scope.physical = rng() % 4 == 0;
      scope.include_system = rng() % 3 == 0;
      scope.include_non_storing = rng() % 2 == 0;
      if (rng() % 3 == 0) scope.database = rng() % 2 ? "a" : "b";
      if (rng() % 4 != 0) {
        const auto& focus = graph.nodes[rng() % graph.nodes.size()];
        scope.focus_id = focus.id;
        if (rng() % 10 == 0) scope.focus_id = "table:x.y";
      }
      const size_t expansions = rng() % 4;
      for (size_t i = 0; i < expansions; ++i) scope.expansions.emplace_back(rng() % 2 == 0, graph.nodes[rng() % graph.nodes.size()].id);
      const bool lineage = rng() % 8 != 0;
      const bool storage = rng() % 8 != 0;
      const auto reference_scope = reference_of(scope);
      const ExplorerGraph expected = reference::scope_graph(graph, reference_scope, lineage, storage);
      const ExplorerGraph actual = scope_graph(graph, scope, lineage, storage, index.get());
      const ExplorerGraph without_index = scope_graph(graph, scope, lineage, storage);
      CHECK(node_ids(actual) == node_ids(expected));
      CHECK(node_ids(without_index) == node_ids(expected));
      bool same_counts = actual.nodes.size() == expected.nodes.size();
      for (size_t i = 0; same_counts && i < expected.nodes.size(); ++i) {
        same_counts = actual.nodes[i].hidden_upstream == expected.nodes[i].hidden_upstream &&
                      actual.nodes[i].hidden_downstream == expected.nodes[i].hidden_downstream;
      }
      CHECK(same_counts);
      bool same_edges = actual.edges.size() == expected.edges.size();
      for (size_t i = 0; same_edges && i < expected.edges.size(); ++i) same_edges = actual.edges[i].id == expected.edges[i].id;
      CHECK(same_edges);
      const bool more_expected = reference::logical_scope_has_more(graph, reference_scope, expected, lineage);
      CHECK_EQ(logical_scope_has_more(graph, scope, actual, lineage, index.get()), more_expected);
      ++compared;
      nonempty += !expected.nodes.empty();
      with_more += more_expected;
    }
    CHECK(logical_storage_available_ids(graph, index.get()) == reference::logical_storage_available_ids(graph));
    CHECK(logical_storage_available_ids(graph) == reference::logical_storage_available_ids(graph));
  }
  // The scopes were not all empty. Some scopes had more to show.
  CHECK(compared == 2400 && nonempty > 800 && with_more > 100);
}


// ---- the JSON of the answers ----

rapidjson::Document parse_json(const std::string& text) {
  rapidjson::Document doc;
  doc.Parse(text.c_str());
  CHECK(!doc.HasParseError());
  return doc;
}

void test_the_json_of_the_sidebar_and_the_storage_map() {
  ExplorerCatalog catalog;
  catalog.generated_at_ms = 1789000000000ULL;
  catalog.databases = {"a", "b"};
  catalog.acl_truncated = true;
  catalog.database_summaries = {ExplorerDatabaseSummary{"a", 2, 20, 200, {}}};
  const auto doc = parse_json(catalog_json("local", "", catalog, true));
  CHECK_EQ(doc["version"].GetInt(), 3);
  CHECK_EQ(std::string(doc["host_id"].GetString()), std::string("local"));
  CHECK(doc["stale"].GetBool() && doc["acl_truncated"].GetBool());
  CHECK_EQ(doc["databases"].Size(), 2u);
  CHECK_EQ(doc["database_summaries"][0]["bytes"].GetUint64(), uint64_t(200));
  CHECK(!doc.HasMember("disks"));
  CHECK_EQ(doc["tables"].Size(), 0u);
  // One database: its tables with the figures of the list, its disks, and the health of a replicated table.
  ExplorerCatalog one;
  one.databases = {"a"};
  auto t = table_summary("a", "events", "ReplicatedMergeTree");
  t.rows = 5;
  t.resident_bytes = 77;
  t.logical_bytes = 99;
  t.replication.available = true;
  t.health = "warning";
  auto plain = table_summary("a", "plain", "MergeTree");
  plain.logical_bytes = 11;
  one.tables = {t, plain};
  one.database_disks = {ExplorerDatabaseDisk{"default", "h1", "/p/", "local", 10, std::nullopt, 100}};
  const auto db_doc = parse_json(catalog_json("local", "a", one, false));
  CHECK_EQ(std::string(db_doc["database"].GetString()), std::string("a"));
  CHECK_EQ(db_doc["tables"].Size(), 2u);
  CHECK_EQ(db_doc["tables"][0]["bytes"].GetUint64(), uint64_t(77));   // a resident table shows its resident bytes
  CHECK_EQ(db_doc["tables"][1]["bytes"].GetUint64(), uint64_t(11));
  CHECK(db_doc["tables"][0]["replicated"].GetBool());
  CHECK_EQ(std::string(db_doc["tables"][0]["health"].GetString()), std::string("warning"));
  CHECK(!db_doc["tables"][1].HasMember("replicated"));
  CHECK_EQ(db_doc["disks"].Size(), 1u);
  CHECK(db_doc["disks"][0]["free_space"].IsNull());
  CHECK_EQ(db_doc["disks"][0]["total_space"].GetUint64(), uint64_t(100));
  // The storage map: the totals are the sums of the databases. A system database says so.
  ExplorerStorageMap map;
  map.table_limit_per_database = 128;
  ExplorerStorageDatabase user;
  user.name = "a";
  user.bytes = 100;
  user.rows = 10;
  user.storing_tables = 1;
  user.tables = {ExplorerStorageTable{"events", "MergeTree", 100, 10, 2}};
  ExplorerStorageDatabase sys;
  sys.name = "system";
  sys.bytes = 5;
  sys.resident_bytes = 7;
  map.databases = {user, sys};
  const auto map_doc = parse_json(storage_json("local", map, false));
  CHECK_EQ(map_doc["total_bytes"].GetUint64(), uint64_t(105));
  CHECK_EQ(map_doc["resident_bytes"].GetUint64(), uint64_t(7));
  CHECK_EQ(map_doc["storing_tables"].GetUint64(), uint64_t(1));
  CHECK(!map_doc["databases"][0]["system"].GetBool() && map_doc["databases"][1]["system"].GetBool());
  CHECK_EQ(std::string(map_doc["byte_metric"].GetString()), std::string("bytes_on_disk"));
  CHECK_EQ(std::string(map_doc["databases"][0]["tables"][0]["name"].GetString()), std::string("events"));
}

void test_the_json_of_a_table_a_function_and_a_preview() {
  ExplorerTableDetail detail;
  detail.generated_at_ms = 5;
  detail.summary = table_summary("db", "t", "MergeTree");
  detail.summary.disks = {"default"};
  detail.summary.replication.available = true;
  detail.summary.replication.replicas = {{"r1", true}};
  detail.create_table_query = "CREATE TABLE db.t (a Int8) ENGINE = MergeTree ORDER BY a";
  detail.table_ttl = "a + INTERVAL 1 DAY";
  ExplorerColumnInfo column;
  column.name = "a";
  column.type = "Int8";
  column.compressed_bytes = 12;
  column.relative_weight = 0.5;
  detail.columns = {column};
  detail.storage = {ExplorerStorageDisk{"default", "/p/", 10, std::nullopt, std::nullopt, 100, 1}};
  detail.dependencies = {ExplorerDependencyInfo{"db", "v", "downstream", "view", "View"}};
  detail.distributed_cluster = "c1";
  detail.unavailable_sections = {"mutation"};
  detail.unavailable_issues = {ExplorerUnavailableIssue{"mutation", "sys", "SELECT ON system.mutations"}};
  detail.database_footprint_bytes = 1000;
  const auto doc = parse_json(table_json("local", detail, false, 30000));
  CHECK_EQ(doc["cache_ttl_ms"].GetUint64(), uint64_t(30000));
  CHECK_EQ(std::string(doc["metric_scope"].GetString()), std::string("local-replica"));
  CHECK_EQ(std::string(doc["summary"]["name"].GetString()), std::string("t"));
  CHECK_EQ(std::string(doc["summary"]["replication"]["replicas"][0]["name"].GetString()), std::string("r1"));
  CHECK_EQ(doc["footprint_scope"]["database_bytes"].GetUint64(), uint64_t(1000));
  CHECK(doc["footprint_scope"]["clickhouse_bytes"].IsNull());
  CHECK_EQ(std::string(doc["columns"][0]["name"].GetString()), std::string("a"));
  CHECK_EQ(doc["columns"][0]["relative_weight"].GetDouble(), 0.5);
  CHECK(doc["storage"][0]["free_space"].IsNull());
  CHECK_EQ(std::string(doc["ddl"].GetString()), detail.create_table_query);
  CHECK_EQ(std::string(doc["table_ttl"].GetString()), std::string("a + INTERVAL 1 DAY"));
  CHECK_EQ(std::string(doc["distributed"]["cluster"].GetString()), std::string("c1"));
  CHECK_EQ(std::string(doc["dependencies"][0]["engine"].GetString()), std::string("View"));
  CHECK_EQ(std::string(doc["unavailable_sections"][0].GetString()), std::string("mutation"));
  CHECK_EQ(std::string(doc["unavailable"][0]["hint"].GetString()), std::string("GRANT SELECT ON system.mutations TO sys;"));
  CHECK_EQ(std::string(doc["unavailable"][0]["reason"].GetString()), std::string("not_granted"));
  // A table that is not Distributed has no such member.
  detail.distributed_cluster.clear();
  CHECK(!parse_json(table_json("local", detail, false, 30000)).HasMember("distributed"));
  // A name with a NUL byte, or bytes that are not UTF-8, is still valid JSON.
  detail.create_table_query = std::string("a\0b\xff", 4);
  const std::string text = table_json("local", detail, false, 30000);
  CHECK(!parse_json(text).HasParseError());
  // The functions.
  ExplorerFunctionsCatalog functions;
  functions.documentation_available = true;
  ExplorerFunctionInfo info = function_info("plus", "Function", "Adds.");
  ExplorerFunctionAliasDocument alias;
  alias.name = "add";
  info.alias_documents = {alias};
  functions.functions = {info};
  const auto fdoc = parse_json(functions_json("local", functions, true, true));
  CHECK(fdoc["stale"].GetBool() && fdoc["documentation_available"].GetBool() && fdoc["markdown_links_enabled"].GetBool());
  CHECK_EQ(std::string(fdoc["functions"][0]["alias_documents"][0]["name"].GetString()), std::string("add"));
  CHECK(!fdoc["functions"][0]["user_defined"].GetBool());
  // The preview: the cells are JSON that the encoder wrote. A cell that is not JSON is an error.
  ExplorerPreview preview;
  preview.limit = 3;
  preview.columns = {ExplorerPreviewColumn{"id", "UInt64", false}};
  preview.rows = {{"\"1\""}, {"{\"a\":[1,2]}"}};
  const auto pdoc = parse_json(*preview_json("local", "db", "t", preview));
  CHECK_EQ(std::string(pdoc["table"].GetString()), std::string("t"));
  CHECK_EQ(pdoc["rows"][1][0]["a"][1].GetInt(), 2);
  preview.rows = {{"not json"}};
  CHECK(!preview_json("local", "db", "t", preview).has_value());
}

void test_the_json_of_the_graph() {
  ExplorerGraph graph;
  graph.generated_at_ms = 9;
  graph.metric_scope = "local-replica";
  graph.nodes = {logical_node("db", "src", "mergetree"), logical_node("db", "mv", "materialized_view"), physical_node("p:disk", "disk")};
  graph.nodes[0].rows = 5;
  graph.nodes[0].hidden_downstream = 2;
  ExplorerGraphTtlRule rule;
  rule.action = "delete";
  rule.expression = "ts + INTERVAL 1 DAY";
  graph.nodes[0].ttl_rules = {rule};
  add_edge(graph, "table:db.src", "table:db.mv", "materialized_view");
  graph.edges[0].can_animate = true;
  graph.unavailable_sections = {"part_ingress"};
  graph.unavailable_issues = {ExplorerUnavailableIssue{"part_ingress", "sys", "SELECT ON system.part_log"}};
  GraphScopeRequest scope;
  scope.database = "db";
  scope.focus_id = "table:db.src";
  scope.depth = 2;
  const auto doc = parse_json(graph_json("local", graph, graph, scope, true, {"table:db.src"}, true, 2000));
  CHECK(doc["stale"].GetBool() && doc["scope_has_more"].GetBool());
  CHECK(!doc["truncated"].GetBool());
  graph.truncated = true;
  CHECK(parse_json(graph_json("local", graph, graph, scope, false, {}, false, 2000))["truncated"].GetBool());
  graph.truncated = false;
  CHECK_EQ(std::string(doc["scope_mode"].GetString()), std::string("logical"));
  CHECK_EQ(std::string(doc["scope_database"].GetString()), std::string("db"));
  CHECK_EQ(std::string(doc["scope_focus_id"].GetString()), std::string("table:db.src"));
  CHECK_EQ(doc["scope_depth"].GetInt(), 2);
  CHECK_EQ(doc["live_refresh_ms"].GetInt(), 2000);
  CHECK_EQ(doc["nodes"].Size(), 3u);
  // A logical node says whether it has a placement, and what is left beyond the scope. A physical node says neither.
  CHECK(doc["nodes"][0]["storage_available"].GetBool());
  CHECK_EQ(doc["nodes"][0]["hidden_downstream"].GetUint64(), uint64_t(2));
  CHECK(!doc["nodes"][1]["storage_available"].GetBool());
  CHECK(!doc["nodes"][2].HasMember("storage_available"));
  CHECK_EQ(doc["nodes"][0]["rows"].GetUint64(), uint64_t(5));
  CHECK(doc["nodes"][0]["logical_bytes"].IsNull());
  CHECK_EQ(std::string(doc["nodes"][0]["ttl_rules"][0]["action"].GetString()), std::string("delete"));
  CHECK(doc["edges"][0]["can_animate"].GetBool());
  CHECK_EQ(std::string(doc["unavailable"][0]["grant"].GetString()), std::string("SELECT ON system.part_log"));
  scope.physical = true;
  CHECK_EQ(std::string(parse_json(graph_json("local", graph, graph, scope, false, {}, false, 2000))["scope_mode"].GetString()), std::string("physical"));
  // The definition of an object has its SELECT. The destination is only shown when it is visible. The dictionary and the Distributed members are only shown for those kinds.
  ExplorerGraphDefinition definition;
  definition.select_sql = "SELECT 1";
  definition.target_visible = true;
  definition.target_database = "db";
  definition.target_table = "dst";
  const auto def_doc = parse_json(definition_json("local", graph.nodes[1], definition, false));
  CHECK_EQ(std::string(def_doc["select_sql"].GetString()), std::string("SELECT 1"));
  CHECK_EQ(std::string(def_doc["target"]["table"].GetString()), std::string("dst"));
  CHECK(def_doc["dictionary"].IsNull() && def_doc["distributed"].IsNull());
  ExplorerGraphDefinition hidden;
  const auto hidden_doc = parse_json(definition_json("local", graph.nodes[1], hidden, false));
  CHECK(hidden_doc["select_sql"].IsNull() && hidden_doc["target"].IsNull() && !hidden_doc["target_visible"].GetBool());
  ExplorerGraphNode dictionary = logical_node("db", "dict", "dictionary");
  ExplorerGraphDefinition dict_definition;
  dict_definition.dictionary_source_kind = "CLICKHOUSE";
  CHECK_EQ(std::string(parse_json(definition_json("local", dictionary, dict_definition, false))["dictionary"]["source_kind"].GetString()), std::string("CLICKHOUSE"));
  ExplorerGraphNode distributed = logical_node("db", "dist", "distributed");
  ExplorerGraphDefinition dist_definition;
  dist_definition.distributed_shards = 3;
  CHECK_EQ(parse_json(definition_json("local", distributed, dist_definition, false))["distributed"]["shards"].GetUint64(), uint64_t(3));
}

// ---- the service ----

HostSpec explorer_host() {
  HostSpec host;
  host.id = "local";
  host.runner_uri = "clickhouse://runner@clickhouse:9000";
  host.system_uri = "clickhouse://system@clickhouse:9000";
  return host;
}

// The connections of a service in a test are: a fake ClickHouse for each account, the privileges of the runner, and caches of its own.
struct ServiceRig {
  FakeDb system, runner;
  std::map<std::string, std::vector<std::string>> readable;
  bool runner_down = false, system_down = false, acl_down = false;
  AclService acl{AclService::Options{}};
  ExplorerCaches caches;
  CatalogCache list{CatalogCache::Options{}}, catalog{CatalogCache::Options{}};
  TableDetailCache table_detail{TableDetailCache::Options{}};
  GraphCache graph{GraphCache::Options{}};
  FunctionsCache functions{FunctionsCache::Options{}};
  StorageCache storage{StorageCache::Options{}};
  AclAccess access;
  std::unique_ptr<ExplorerService> service;

  ServiceRig() {
    readable = {{"db", {"t", "v"}}, {"other", {"x"}}};
    access.key = "rig-identity";
    access.connect = [this](std::string* error) -> std::unique_ptr<AclSource> {
      if (acl_down) {
        if (error) *error = "the runner is gone";
        return nullptr;
      }
      auto source = std::make_unique<ReadableSource>();
      source->tables = readable;
      return source;
    };
    service = std::make_unique<ExplorerService>(
        [this](const std::string& uri, std::string* error) -> std::unique_ptr<ChExecutor> {
          const bool is_system = uri.find("system@") != std::string::npos;
          if (is_system ? system_down : runner_down) {
            if (error) *error = is_system ? "system is down" : "runner is down";
            return nullptr;
          }
          return std::unique_ptr<ChExecutor>(new ForwardDb(is_system ? system : runner));
        },
        [this](const HostSpec&) { return access; }, acl, caches, ExplorerStores{list, catalog, table_detail, graph, functions, storage});
  }
};

void test_the_service_lists_what_the_runner_reads() {
  ServiceRig rig;
  rig.runner.on("GROUP BY database ORDER BY database", {{"db", "2", "20", "200"}, {"other", "1", "1", "5"}, {"hidden", "9", "9", "9"}});
  RequestContext context;
  const auto first = rig.service->catalog(context, explorer_host(), "local", "", false);
  CHECK(first);
  CHECK(!first.value->stale);
  CHECK((first.value->value->databases == std::vector<std::string>{"db", "other"}));
  CHECK_EQ(first.value->value->database_summaries.size(), size_t(2));
  // The second request reads the cache. It sends no statement for the totals.
  const size_t reads = rig.runner.count("GROUP BY database ORDER BY database");
  CHECK(rig.service->catalog(context, explorer_host(), "local", "", false));
  CHECK_EQ(rig.runner.count("GROUP BY database ORDER BY database"), reads);
  // refresh=1 reads again. The privileges of the runner are read again too.
  CHECK(rig.service->catalog(context, explorer_host(), "local", "", true));
  CHECK_EQ(rig.runner.count("GROUP BY database ORDER BY database"), reads + 1);
  // One database: the objects that the runner reads are shown, with the figures of the sidebar. The system account gives them.
  rig.system.on("ORDER BY database, name", {{"db", "t", "MergeTree", "5", "50", "2026-10-11 00:00:00"}, {"db", "v", "View", "", "", "2026-10-11 00:00:00"},
                                             {"db", "secret", "MergeTree", "1", "1", "2026-10-11 00:00:00"}});
  const auto db = rig.service->catalog(context, explorer_host(), "local", "db", false);
  CHECK(db);
  CHECK_EQ(db.value->value->tables.size(), size_t(2));
  // A database that the runner does not read has no object. The answer is empty, and the system account is not asked.
  const size_t system_reads = rig.system.sqls.size();
  const auto none = rig.service->catalog(context, explorer_host(), "local", "nothing", false);
  CHECK(none && none.value->value->tables.empty());
  CHECK_EQ(rig.system.sqls.size(), system_reads);
}

void test_the_errors_of_the_service() {
  RequestContext context;
  {
    ServiceRig rig;
    rig.runner_down = true;
    const auto answer = rig.service->catalog(context, explorer_host(), "local", "", false);
    CHECK(!answer);
    CHECK_EQ(answer.error.status, 503);
    CHECK_EQ(answer.error.code, std::string("runner_unavailable"));
    CHECK_EQ(answer.error.message, std::string("runner is down"));
  }
  {
    ServiceRig rig;
    rig.system_down = true;
    const auto answer = rig.service->catalog(context, explorer_host(), "local", "db", false);
    CHECK_EQ(answer.error.code, std::string("system_context_unavailable"));
    const auto storage = rig.service->storage(context, explorer_host(), "local", false);
    CHECK_EQ(storage.error.code, std::string("system_context_unavailable"));
    const auto table = rig.service->table(context, explorer_host(), "local", "db", "t", false);
    CHECK_EQ(table.error.code, std::string("system_context_unavailable"));
    CHECK_EQ(table.error.message, std::string("system is down"));
  }
  {
    // A failure of a read gives the error of the route, with the message of ClickHouse. The connection is not lent again.
    ServiceRig rig;
    rig.runner.on("GROUP BY database", {});
    rig.system.fail_on("ORDER BY database, name", [] { throw server_error(60, "tables are gone"); });
    rig.runner.fail_on("ORDER BY database, name", [] { throw server_error(60, "tables are gone"); });
    const auto answer = rig.service->catalog(context, explorer_host(), "local", "db", false);
    CHECK_EQ(answer.error.status, 503);
    CHECK_EQ(answer.error.code, std::string("explorer_catalog_failed"));
    CHECK(answer.error.message.find("tables are gone") != std::string::npos);
  }
  {
    // The privileges of the runner cannot be read. The code of the ACL is 503.
    ServiceRig rig;
    rig.acl_down = true;
    const auto answer = rig.service->catalog(context, explorer_host(), "local", "db", false);
    CHECK(!answer);
    CHECK_EQ(answer.error.status, 503);
  }
  {
    // A table that does not exist, and a table that is not listed, give 404 object_not_found. Another failure gives 503.
    ServiceRig rig;
    const auto missing = rig.service->table(context, explorer_host(), "local", "db", "nope", false);
    CHECK_EQ(missing.error.status, 404);
    CHECK_EQ(missing.error.code, std::string("object_not_found"));
    CHECK_EQ(missing.error.message, std::string("Object not found or has no readable columns."));
    rig.acl_down = true;
    const auto down = rig.service->table(context, explorer_host(), "local", "db", "t", true);
    CHECK_EQ(down.error.status, 503);
    CHECK_EQ(down.error.code, std::string("acl_discovery_failed"));
    CHECK_EQ(down.error.message, std::string("the runner is gone"));
  }
}

void test_the_service_keeps_the_card_of_a_table() {
  ServiceRig rig;
  rig.system.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1",
                {{"db", "t", "MergeTree", "MergeTree ORDER BY a", "a", "a", "", "", "", "1", "2", "3", "", "2026-10-11 00:00:00"}});
  rig.runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.t (a Int8) ENGINE = MergeTree ORDER BY a"}});
  rig.system.on("FROM system.columns WHERE", {{"a", "Int8", "", "", "", "1", "1", "", "1", "1", "1", "0"}});
  rig.runner.on("GROUP BY database ORDER BY database", {{"db", "2", "20", "200"}});
  RequestContext context;
  const auto first = rig.service->table(context, explorer_host(), "local", "db", "t", false);
  CHECK(first);
  CHECK_EQ(first.value->value->columns.size(), size_t(1));
  CHECK(first.value->value->generated_at_ms > 0);
  const size_t reads = rig.system.sqls.size();
  CHECK(rig.service->table(context, explorer_host(), "local", "db", "t", false));
  CHECK_EQ(rig.system.sqls.size(), reads);
  CHECK(rig.service->table(context, explorer_host(), "local", "db", "t", true));
  CHECK(rig.system.sqls.size() > reads);
  // The card of another table is another entry.
  const auto other = rig.service->table(context, explorer_host(), "local", "db", "v", false);
  CHECK(!other || other.value->value->summary.name != "t");
}

void test_the_service_answers_storage_functions_and_preview() {
  ServiceRig rig;
  RequestContext context;
  rig.system.on("FROM system.parts WHERE active AND database IN", {{"db", "t", "10", "1000", "2"}});
  rig.system.on("FROM system.tables WHERE database IN", {{"db", "t", "MergeTree", "10", "1000"}});
  const auto storage = rig.service->storage(context, explorer_host(), "local", false);
  CHECK(storage);
  CHECK_EQ(storage.value->value->databases[0].bytes, uint64_t(1000));
  // The functions: a failure says so with the code of the route.
  rig.runner.on("FROM system.documentation", {{"plus", "Function", "Adds.", ""}});
  rig.runner.on("FROM system.functions", {{"plus", "0", "System", "", "", "plus(a)", "", "", "", "", "", "Arithmetic"}});
  const auto functions = rig.service->functions(context, explorer_host(), "local", false);
  CHECK(functions && functions.value->value->functions.size() == 1);
  ServiceRig broken;
  broken.runner.fail_on("FROM system.documentation", [] { throw server_error(60, "no documentation"); });
  const auto failed = broken.service->functions(context, explorer_host(), "local", false);
  CHECK(!failed);
  CHECK_EQ(failed.error.status, 503);
  CHECK_EQ(failed.error.code, std::string("functions_unavailable"));
  CHECK(failed.error.message.find("Function documentation query failed") == 0);
  // The preview: 404 for an object that the runner does not read. 503 with a code for a failure.
  rig.runner.on("DESCRIBE TABLE", {{"a", "UInt64"}});
  clickhouse::Block rows;
  auto column = std::make_shared<clickhouse::ColumnUInt64>();
  column->Append(7);
  rows.AppendColumn("a", column);
  rig.runner.on_block("SELECT `a` FROM `db`.`t` LIMIT 3", [rows](const std::string&) { return rows; });
  const auto preview = rig.service->preview(context, explorer_host(), "db", "t", 3);
  CHECK(preview);
  CHECK_EQ(preview.value->rows.size(), size_t(1));
  CHECK_EQ(preview.value->rows[0][0], std::string("\"7\""));
  // The functions and the rows of a table are read on the connection of the runner. What the runner cannot call or read is not shown.
  // The system account is never asked for them.
  CHECK(rig.runner.count("FROM system.documentation") >= 1 && rig.runner.count("SELECT `a` FROM `db`.`t` LIMIT 3") == 1);
  CHECK_EQ(rig.system.count("FROM system.documentation"), size_t(0));
  CHECK_EQ(rig.system.count("FROM system.functions"), size_t(0));
  CHECK_EQ(rig.system.count("SELECT `a` FROM `db`.`t`"), size_t(0));
  const auto missing = rig.service->preview(context, explorer_host(), "db", "nope", 3);
  CHECK_EQ(missing.error.status, 404);
  CHECK_EQ(missing.error.code, std::string("object_not_found"));
  rig.runner.fail_on("SELECT `a` FROM `db`.`t` LIMIT 4", [] { throw server_error(60, "the table is gone"); });
  const auto gone = rig.service->preview(context, explorer_host(), "db", "t", 4);
  CHECK_EQ(gone.error.code, std::string("preview_failed"));
  CHECK(gone.error.message.find("the table is gone") != std::string::npos);
  rig.runner_down = true;
  CHECK_EQ(rig.service->preview(context, explorer_host(), "db", "t", 3).error.code, std::string("runner_unavailable"));
}

void test_a_manual_refresh_of_the_catalog_reads_the_functions_again() {
  // refresh=1 on the catalog drops what the server kept of the functions too. The next read goes to ClickHouse. A read without it does not.
  ServiceRig rig;
  RequestContext context;
  rig.runner.on("GROUP BY database ORDER BY database", {{"db", "2", "20", "200"}});
  rig.runner.on("FROM system.documentation", {{"plus", "Function", "Adds.", ""}});
  rig.runner.on("FROM system.functions", {{"plus", "0", "System", "", "", "plus(a)", "", "", "", "", "", "Arithmetic"}});
  CHECK(rig.service->functions(context, explorer_host(), "local", false));
  const size_t reads = rig.runner.count("FROM system.documentation");
  CHECK(rig.service->functions(context, explorer_host(), "local", false));
  CHECK_EQ(rig.runner.count("FROM system.documentation"), reads);
  CHECK(rig.service->catalog(context, explorer_host(), "local", "", true));
  CHECK(rig.service->functions(context, explorer_host(), "local", false));
  CHECK_EQ(rig.runner.count("FROM system.documentation"), reads + 1);
}

void test_the_service_scopes_the_graph_and_answers_definitions() {
  ServiceRig rig;
  rig.readable = {{"db", {"src", "mv", "dst"}}};
  RequestContext context;
  rig.system.on("ORDER BY database, name", {base_row("db", "src", "MergeTree", "5", "500"), base_row("db", "mv", "MaterializedView", "", ""), base_row("db", "dst", "MergeTree", "1", "10")});
  rig.system.on("arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8", {
      {"db", "src", "MergeTree", "", "2026-10-11 00:00:00", "0"}, {"db", "mv", "MaterializedView", "", "2026-10-11 00:00:00", "0"}, {"db", "dst", "MergeTree", "", "2026-10-11 00:00:00", "0"}});
  rig.runner.on_fn("toString(engine_full), toString(create_table_query), toString(as_select) FROM system.tables WHERE database = {p1:String}", [](const std::string&) -> Rows {
    return {{"db", "src", "MergeTree", "", ""}, {"db", "dst", "MergeTree", "", ""},
            {"db", "mv", "", "CREATE MATERIALIZED VIEW db.mv TO db.dst AS SELECT * FROM db.src", "SELECT * FROM db.src"}};
  });
  rig.system.on("FROM (SELECT toString(database) AS database", {{"db", "src", "db", "mv"}});
  rig.system.on("view_refreshes", {{"0"}});
  GraphScopeRequest scope;
  scope.focus_id = "table:db.src";
  scope.depth = 1;
  const auto answer = rig.service->graph(context, explorer_host(), "local", scope, true, true, false);
  CHECK(answer);
  CHECK((node_ids(answer.value->scoped) == std::vector<std::string>{"table:db.src", "table:db.mv"}));
  CHECK(answer.value->scope_has_more);
  CHECK(!answer.value->storage_available.count("table:db.src"));
  CHECK(answer.value->graph->index != nullptr);
  // The graph is kept. A second scope reads nothing.
  const size_t reads = rig.system.sqls.size();
  scope.depth = 2;
  const auto deeper = rig.service->graph(context, explorer_host(), "local", scope, true, true, false);
  CHECK(deeper);
  CHECK_EQ(deeper.value->scoped.nodes.size(), size_t(3));
  CHECK(!deeper.value->scope_has_more);
  CHECK_EQ(rig.system.sqls.size(), reads);
  // A definition comes from the kept graph: the SELECT of the view and its target. A hidden object is not found.
  const auto definition = rig.service->definition(context, explorer_host(), "local", "db", "mv", false);
  CHECK(definition);
  CHECK_EQ(definition.value->node->kind, std::string("materialized_view"));
  CHECK_EQ(definition.value->definition->select_sql, std::string("SELECT * FROM db.src"));
  CHECK(definition.value->definition->target_visible);
  CHECK_EQ(rig.system.sqls.size(), reads);
  const auto unknown = rig.service->definition(context, explorer_host(), "local", "db", "secret", false);
  CHECK_EQ(unknown.error.status, 404);
  CHECK_EQ(unknown.error.code, std::string("unknown_object"));
  CHECK_EQ(unknown.error.message, std::string("Object is not visible in the Explorer graph."));
  // A plain table has no definition. The answer is an empty one, not an error.
  const auto plain = rig.service->definition(context, explorer_host(), "local", "db", "src", false);
  CHECK(plain && plain.value->definition->select_sql.empty());
  // The errors of the graph: the privileges that cannot be read, and a system account that is down.
  ServiceRig down;
  down.acl_down = true;
  CHECK_EQ(down.service->graph(context, explorer_host(), "local", scope, true, true, false).error.status, 503);
  ServiceRig no_system;
  no_system.system_down = true;
  const auto no_catalog = no_system.service->graph(context, explorer_host(), "local", scope, true, true, false);
  CHECK_EQ(no_catalog.error.code, std::string("system_context_unavailable"));
}


void test_the_neighbours_of_a_view_are_read_by_the_one_lexer() {
  // ARCH-B-040: the sources of a SELECT are the names after FROM and JOIN at every depth. A table function, ARRAY JOIN, a CTE name, a FROM inside a
  // function, and a name in a text or a comment are not tables.
  const auto names = [](const std::string& select) {
    std::vector<std::string> out;
    for (const auto& source : sql::relation_sources(select, "db")) out.push_back(source.database + "." + source.table);
    return out;
  };
  CHECK((names("SELECT * FROM a JOIN b.c ON a.x = c.x") == std::vector<std::string>{"db.a", "b.c"}));
  CHECK((names("WITH x AS (SELECT * FROM src) SELECT * FROM x, (SELECT * FROM other.inner WHERE y IN (SELECT y FROM deep)) AS z") ==
         std::vector<std::string>{"db.src", "other.inner", "db.deep"}));
  CHECK((names("SELECT * FROM numbers(10) ARRAY JOIN arr").empty()));
  CHECK((names("SELECT extract(YEAR FROM ts), substring(s FROM 2) FROM t") == std::vector<std::string>{"db.t"}));
  CHECK((names("SELECT 'FROM fake', `FROM` FROM real -- FROM comment\n /* FROM block */") == std::vector<std::string>{"db.real"}));
  CHECK((names("SELECT * FROM t LEFT ARRAY JOIN a JOIN u USING id") == std::vector<std::string>{"db.t", "db.u"}));
  // The target of a materialized view is the TO between its name and AS SELECT. A TO VOLUME of its TTL, or a WITH FILL ... TO, is not one.
  const auto target = [](const std::string& ddl) {
    const auto found = sql::materialized_view_target(ddl, "db");
    return found ? found->database + "." + found->table : std::string("-");
  };
  CHECK_EQ(target("CREATE MATERIALIZED VIEW v TO t AS SELECT 1"), std::string("db.t"));
  CHECK_EQ(target("CREATE MATERIALIZED VIEW v TO other.`t.x` AS SELECT 1"), std::string("other.t.x"));
  CHECK_EQ(target("CREATE MATERIALIZED VIEW v ENGINE = MergeTree ORDER BY a TTL ts + INTERVAL 1 DAY TO VOLUME 'cold' AS SELECT 1"), std::string("-"));
  CHECK_EQ(target("CREATE MATERIALIZED VIEW v ENGINE = MergeTree ORDER BY a AS SELECT a FROM t ORDER BY a WITH FILL FROM 1 TO 10"), std::string("-"));
  CHECK_EQ(target("CREATE MATERIALIZED VIEW v REFRESH EVERY 1 HOUR TO t AS SELECT 1"), std::string("db.t"));
}


// A grant on some databases (docs/access.md): the graph and the storage map keep only the databases that the subject may read.
// A lineage that crosses into another database loses that part. A shard or a replica of a cluster stays while it links to a node
// that stays.
// The texts that ClickHouse masks for each user (create_table_query, engine_full, as_select) are the view of the runner, the identity that
// bounds the caller. The system account may see more of them (the privilege displaySecretsInShowAndSelect), so it never reads them.
void test_the_masked_ddl_texts_are_read_as_the_runner() {
  const std::string secret = "TOPSECRET789";
  const std::string masked = "[HIDDEN]";
  RequestContext context;
  {
    // The card of a table: the DDL and engine_full.
    ServiceRig rig;
    rig.system.on("FROM system.tables WHERE database = {p1:String} AND name = {p2:String} LIMIT 1",
                  {{"db", "t", "S3", "S3('http://h/b', 'KEY', '" + secret + "', 'CSV')", "", "", "", "", "", "1", "2", "3", "", "2026-10-11 00:00:00"}});
    rig.system.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.t (a Int8) ENGINE = S3('http://h/b', 'KEY', '" + secret + "', 'CSV')"}});
    rig.system.on("FROM system.columns WHERE", {{"a", "Int8", "", "", "", "1", "1", "", "1", "1", "1", "0"}});
    rig.runner.on("SELECT toString(engine_full) FROM system.tables", {{"S3('http://h/b', 'KEY', '" + masked + "', 'CSV')"}});
    rig.runner.on("toString(create_table_query) FROM system.tables WHERE", {{"CREATE TABLE db.t (a Int8) ENGINE = S3('http://h/b', 'KEY', '" + masked + "', 'CSV')"}});
    const auto card = rig.service->table(context, explorer_host(), "local", "db", "t", false);
    CHECK(card);
    CHECK(card.value->value->create_table_query.find(masked) != std::string::npos);
    CHECK(card.value->value->create_table_query.find(secret) == std::string::npos);
    CHECK(card.value->value->summary.engine_full.find(masked) != std::string::npos);
    CHECK(card.value->value->summary.engine_full.find(secret) == std::string::npos);
    CHECK_EQ(rig.system.count("create_table_query"), size_t(0));
  }
  {
    // The graph and the definition of a view.
    ServiceRig rig;
    rig.readable = {{"db", {"src", "mv", "dst"}}};
    rig.system.on("ORDER BY database, name", {base_row("db", "src", "MergeTree", "5", "500"), base_row("db", "mv", "MaterializedView", "", ""), base_row("db", "dst", "MergeTree", "1", "10")});
    rig.system.on("arrayStringConcat(data_paths, char(31)), toString(metadata_modification_time), toString(toUInt8", {
        {"db", "src", "MergeTree", "", "2026-10-11 00:00:00", "0"}, {"db", "mv", "MaterializedView", "", "2026-10-11 00:00:00", "0"}, {"db", "dst", "MergeTree", "", "2026-10-11 00:00:00", "0"}});
    const auto texts = [](const std::string& word) {
      return [word](const std::string&) -> Rows {
        return {{"db", "src", "MergeTree", "", ""}, {"db", "dst", "MergeTree", "", ""},
                {"db", "mv", "", "CREATE MATERIALIZED VIEW db.mv TO db.dst AS SELECT * FROM db.src WHERE k = '" + word + "'", "SELECT * FROM db.src WHERE k = '" + word + "'"}};
      };
    };
    const std::string statement = "toString(engine_full), toString(create_table_query), toString(as_select) FROM system.tables WHERE database = {p1:String}";
    rig.system.on_fn(statement, texts(secret));
    rig.runner.on_fn(statement, texts(masked));
    rig.system.on("FROM (SELECT toString(database) AS database", {{"db", "src", "db", "mv"}});
    rig.system.on("view_refreshes", {{"0"}});
    const auto definition = rig.service->definition(context, explorer_host(), "local", "db", "mv", false);
    CHECK(definition);
    CHECK_EQ(definition.value->definition->select_sql, std::string("SELECT * FROM db.src WHERE k = '[HIDDEN]'"));
    CHECK_EQ(rig.system.count("toString(create_table_query)"), size_t(0));
  }
}

// The key of the list of the catalog holds a database name that the caller chooses. The key of the whole catalog is never a name.
void test_the_catalog_key_of_a_database_filter_never_aliases_the_whole_catalog() {
  RequestContext context;
  {
    ServiceRig rig;
    rig.runner.on("GROUP BY database ORDER BY database", {{"db", "2", "20", "200"}, {"other", "1", "1", "5"}});
    const auto all = rig.service->catalog(context, explorer_host(), "local", "", false);
    CHECK(all && all.value->value->databases.size() == 2);
    // A database named "@databases" has no object that the runner reads. Its answer is empty. It is not the whole catalog.
    const auto alias = rig.service->catalog(context, explorer_host(), "local", "@databases", false);
    CHECK(alias);
    CHECK(alias.value->value->databases.empty() && alias.value->value->tables.empty());
  }
  {
    ServiceRig rig;
    rig.runner.on("GROUP BY database ORDER BY database", {{"db", "2", "20", "200"}, {"other", "1", "1", "5"}});
    const auto alias = rig.service->catalog(context, explorer_host(), "local", "@databases", false);
    CHECK(alias && alias.value->value->databases.empty());
    // The empty answer of the filter never answers the request of the whole catalog.
    const auto all = rig.service->catalog(context, explorer_host(), "local", "", false);
    CHECK(all && all.value->value->databases.size() == 2);
  }
}

void test_a_grant_on_some_databases_cuts_the_graph_and_the_storage_map() {
  const auto node = [](const std::string& id, const std::string& database, const std::string& layer = "logical") {
    ExplorerGraphNode n;
    n.id = id;
    n.database = database;
    n.layer = layer;
    n.name = id;
    return n;
  };
  const auto edge = [](const std::string& from, const std::string& to) {
    ExplorerGraphEdge e;
    e.id = from + "->" + to;
    e.from = from;
    e.to = to;
    e.kind = "contains";
    return e;
  };
  ExplorerGraph graph;
  graph.nodes = {node("table:tenant_a.visible", "tenant_a"), node("table:tenant_z.hidden_ledger", "tenant_z"),
                 node("table:tenant_z.ledger_mv", "tenant_z"), node("table:tenant_a.dist", "tenant_a"),
                 node("physical:cluster:c:shard:1", "", "physical"), node("physical:cluster:c:shard:1:replica:1", "", "physical"),
                 node("physical:cluster:d:shard:1", "", "physical")};
  graph.edges = {edge("table:tenant_a.visible", "table:tenant_z.hidden_ledger"), edge("table:tenant_z.hidden_ledger", "table:tenant_z.ledger_mv"),
                 edge("table:tenant_a.dist", "physical:cluster:c:shard:1"),
                 edge("physical:cluster:c:shard:1", "physical:cluster:c:shard:1:replica:1"),
                 edge("table:tenant_z.ledger_mv", "physical:cluster:d:shard:1")};
  CHECK(graph_databases(graph) == (std::vector<std::string>{"tenant_a", "tenant_z"}));
  const ExplorerGraph cut = keep_graph_databases(graph, {"tenant_a"});
  std::vector<std::string> ids;
  for (const auto& n : cut.nodes) ids.push_back(n.id);
  CHECK(ids == (std::vector<std::string>{"table:tenant_a.visible", "table:tenant_a.dist", "physical:cluster:c:shard:1",
                                       "physical:cluster:c:shard:1:replica:1"}));
  CHECK_EQ(cut.edges.size(), size_t(2));
  for (const auto& e : cut.edges) CHECK(e.from.find("tenant_z") == std::string::npos && e.to.find("tenant_z") == std::string::npos);
  const std::string json = graph_json("local", graph, cut, GraphScopeRequest{}, false, {}, false, 0);
  CHECK(json.find("tenant_z") == std::string::npos);
  CHECK(json.find("hidden_ledger") == std::string::npos);
  CHECK(keep_graph_databases(graph, {}).nodes.empty());

  ExplorerStorageMap map;
  map.table_limit_per_database = 5;
  ExplorerStorageDatabase a;
  a.name = "tenant_a";
  a.bytes = 10;
  a.rows = 1;
  ExplorerStorageDatabase z;
  z.name = "tenant_z";
  z.bytes = 1577;
  z.rows = 18;
  map.databases = {a, z};
  const ExplorerStorageMap kept = keep_storage_databases(map, {"tenant_a"});
  CHECK_EQ(kept.databases.size(), size_t(1));
  CHECK_EQ(kept.databases[0].name, std::string("tenant_a"));
  CHECK_EQ(kept.table_limit_per_database, size_t(5));
  const std::string storage = storage_json("local", kept, false);
  CHECK(storage.find("tenant_z") == std::string::npos);
  CHECK(storage.find("\"total_bytes\":10,") != std::string::npos);
}

// The card of a table and the definition of a graph object name other databases: the related objects, the target of a Distributed
// table, the target of an MV, a Buffer or a Distributed table. A grant on some databases keeps only those (docs/access.md).
void test_a_grant_on_some_databases_cuts_the_table_card_and_the_definition() {
  ExplorerTableDetail detail;
  detail.summary.database = "tenant_a";
  detail.summary.name = "dist";
  detail.distributed_cluster = "c";
  detail.distributed_database = "tenant_z";
  detail.distributed_table = "hidden_ledger";
  ExplorerDependencyInfo own;
  own.database = "tenant_a";
  own.table = "visible";
  own.relation = "upstream";
  ExplorerDependencyInfo other;
  other.database = "tenant_z";
  other.table = "ledger_mv";
  other.relation = "downstream";
  detail.dependencies = {own, other};
  // The DDL text and engine_full name the target database too (user decision 2026-10-18): they mask it.
  detail.summary.engine_full = "Distributed(c, tenant_z, hidden_ledger, rand())";
  detail.create_table_query =
      "CREATE TABLE tenant_a.dist (`k` UInt64, `r` Float64 DEFAULT dictGet('tenant_y.rates', 'r', k)) "
      "ENGINE = Distributed(c, tenant_z, hidden_ledger, rand())";
  ExplorerColumnInfo column;
  column.name = "r";
  column.default_expression = "dictGet('tenant_y.rates', 'r', k)";
  detail.columns = {column};
  CHECK(table_detail_databases(detail) == (std::vector<std::string>{"tenant_a", "tenant_z", "tenant_y"}));

  const ExplorerTableDetail cut = keep_table_detail_databases(detail, {"tenant_a"});
  CHECK_EQ(cut.dependencies.size(), size_t(1));
  CHECK_EQ(cut.dependencies[0].table, std::string("visible"));
  CHECK(cut.distributed_database.empty() && cut.distributed_table.empty());
  CHECK_EQ(cut.distributed_cluster, std::string("c"));
  const std::string json = table_json("local", cut, false, 0);
  CHECK(json.find("tenant_z") == std::string::npos);
  CHECK(json.find("hidden_ledger") == std::string::npos);
  CHECK(json.find("ledger_mv") == std::string::npos);
  CHECK(json.find("tenant_y") == std::string::npos);
  CHECK_EQ(cut.summary.engine_full, std::string("Distributed(c, `[HIDDEN]`, `[HIDDEN]`, rand())"));
  CHECK(cut.create_table_query.find("ENGINE = Distributed(c, `[HIDDEN]`, `[HIDDEN]`, rand())") != std::string::npos);
  CHECK(cut.create_table_query.find("CREATE TABLE tenant_a.dist") == 0);
  CHECK_EQ(cut.columns[0].default_expression, std::string("dictGet('[HIDDEN]', 'r', k)"));
  // The database of the table is readable without a decision: a card with no grant on another database keeps its own names.
  const ExplorerTableDetail own_only = keep_table_detail_databases(detail, {});
  CHECK(own_only.create_table_query.find("CREATE TABLE tenant_a.dist") == 0);
  CHECK_EQ(own_only.dependencies.size(), size_t(1));
  // A grant on both databases keeps the card as it is.
  const ExplorerTableDetail whole = keep_table_detail_databases(detail, {"tenant_a", "tenant_z", "tenant_y"});
  CHECK_EQ(whole.dependencies.size(), size_t(2));
  CHECK_EQ(whole.distributed_table, std::string("hidden_ledger"));
  CHECK_EQ(whole.create_table_query, detail.create_table_query);
  CHECK_EQ(whole.summary.engine_full, detail.summary.engine_full);

  ExplorerGraphNode node;
  node.id = "table:tenant_a.dist";
  node.database = "tenant_a";
  node.name = "dist";
  node.kind = "distributed";
  ExplorerGraphDefinition definition;
  definition.target_database = "tenant_z";
  definition.target_table = "hidden_ledger";
  definition.target_visible = true;
  definition.distributed_cluster = "c";
  definition.select_sql = "SELECT k FROM tenant_a.src JOIN tenant_z.dim AS d ON d.k = src.k";
  CHECK(definition_databases(definition) == (std::vector<std::string>{"tenant_z", "tenant_a"}));
  const ExplorerGraphDefinition hidden = keep_definition_databases(definition, {"tenant_a"}, "tenant_a");
  CHECK(!hidden.target_visible && hidden.target_database.empty() && hidden.target_table.empty());
  CHECK_EQ(hidden.distributed_cluster, std::string("c"));
  const std::string text = definition_json("local", node, hidden, false);
  CHECK(text.find("tenant_z") == std::string::npos);
  CHECK(text.find("hidden_ledger") == std::string::npos);
  CHECK(text.find("\"target\":null") != std::string::npos);
  CHECK_EQ(hidden.select_sql, std::string("SELECT k FROM tenant_a.src JOIN `[HIDDEN]`.`[HIDDEN]` AS d ON d.k = src.k"));
  const ExplorerGraphDefinition kept = keep_definition_databases(definition, {"tenant_z"}, "tenant_a");
  CHECK(kept.target_visible && kept.target_table == "hidden_ledger");
  CHECK_EQ(kept.select_sql, definition.select_sql);
}

}  // namespace

int main() {
  RUN(test_catalog_statements_are_unchanged);
  RUN(test_sidebar_statements_are_unchanged);
  RUN(test_storage_statements_are_unchanged);
  RUN(test_table_card_statements_are_unchanged);
  RUN(test_lineage_functions_and_preview_statements_are_unchanged);
  RUN(test_graph_statements_are_unchanged);
  RUN(test_a_name_is_a_parameter_of_a_statement);
  RUN(test_the_health_of_a_table);
  RUN(test_the_resident_rows_of_a_buffer);
  RUN(test_the_disk_of_a_data_path);
  RUN(test_the_storage_of_a_database);
  RUN(test_the_sizes_of_the_databases_and_their_disks);
  RUN(test_the_aliases_of_the_functions);
  RUN(test_the_ttl_rules_of_a_table);
  RUN(test_the_kind_of_a_node);
  RUN(test_the_neighbours_of_a_view_are_read_by_the_one_lexer);
  RUN(test_the_logical_graph_of_a_pipeline);
  RUN(test_what_a_definition_says_and_never_names);
  RUN(test_a_dictionary_whose_source_is_hidden_does_not_name_it);
  RUN(test_the_physical_topology_of_a_graph);
  RUN(test_the_cluster_topology_is_shared_by_its_distributed_tables);
  RUN(test_the_cluster_topology_of_a_graph_is_bounded);
  RUN(test_two_tables_do_not_share_a_node_id);
  RUN(test_a_hidden_table_is_not_in_the_graph);
  RUN(test_the_catalog_index_reads_the_names_of_one_database);
  RUN(test_the_catalog_index_falls_back_on_the_runner_and_fills_what_lags);
  RUN(test_the_totals_of_the_databases);
  RUN(test_the_catalog_of_the_graph);
  RUN(test_a_section_that_the_system_account_may_not_read_degrades_the_catalog);
  RUN(test_the_storage_map_names_only_what_the_runner_reads);
  RUN(test_the_summary_of_a_table);
  RUN(test_the_summary_of_a_buffer_a_dictionary_and_a_log_table);
  RUN(test_the_card_of_a_table);
  RUN(test_a_neighbour_in_the_lineage_is_named_only_when_the_runner_reads_it);
  RUN(test_a_section_that_cannot_be_read_degrades_the_card_and_a_view_without_schema_is_browsable);
  RUN(test_the_distributed_table_and_its_queue);
  RUN(test_the_functions_of_the_runner);
  RUN(test_the_preview_of_a_table);
  RUN(test_the_graph_is_read_as_the_system_account_and_built);
  RUN(test_the_scope_of_a_request);
  RUN(test_the_lineage_around_a_table);
  RUN(test_the_physical_scope_of_a_table);
  RUN(test_the_scope_is_what_the_old_code_made_of_it);
  RUN(test_the_json_of_the_sidebar_and_the_storage_map);
  RUN(test_the_json_of_a_table_a_function_and_a_preview);
  RUN(test_the_json_of_the_graph);
  RUN(test_the_service_lists_what_the_runner_reads);
  RUN(test_the_errors_of_the_service);
  RUN(test_the_service_keeps_the_card_of_a_table);
  RUN(test_the_service_answers_storage_functions_and_preview);
  RUN(test_a_manual_refresh_of_the_catalog_reads_the_functions_again);
  RUN(test_the_service_scopes_the_graph_and_answers_definitions);
  RUN(test_the_masked_ddl_texts_are_read_as_the_runner);
  RUN(test_the_catalog_key_of_a_database_filter_never_aliases_the_whole_catalog);
  RUN(test_a_grant_on_some_databases_cuts_the_graph_and_the_storage_map);
  RUN(test_a_grant_on_some_databases_cuts_the_table_card_and_the_definition);
  std::cout << g_checks << " checks, " << g_failures << " failures" << std::endl;
  return g_failures == 0 ? 0 : 1;
}
