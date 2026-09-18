#pragma once

#include "allowed_objects.hpp"

#include <clickhouse/client.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

struct ExplorerRate {
  std::optional<double> rows_per_second_1m;
  std::optional<double> rows_per_second_5m;
  std::optional<double> rows_per_second_1h;
  std::optional<double> bytes_per_second_1m;
  std::optional<double> bytes_per_second_5m;
  std::optional<double> bytes_per_second_1h;
  std::optional<uint64_t> new_parts_per_minute;
  std::optional<uint64_t> rows_total_1h;
  std::optional<uint64_t> bytes_total_1h;
  std::string last_event_time;
};

struct ExplorerReplication {
  bool available = false;
  uint64_t total_replicas = 0;
  uint64_t active_replicas = 0;
  uint64_t queue_size = 0;
  uint64_t absolute_delay_seconds = 0;
  bool readonly = false;
  bool session_expired = false;
  std::string replica_name;
  std::string zookeeper_path;
};

struct ExplorerTableSummary {
  std::string database;
  std::string name;
  std::string engine;
  std::string engine_full;
  std::string sorting_key;
  std::string primary_key;
  std::string partition_key;
  std::string sampling_key;
  std::string storage_policy;

  std::optional<uint64_t> rows;
  std::optional<uint64_t> logical_bytes;
  std::optional<uint64_t> physical_bytes;
  std::optional<uint64_t> compressed_bytes;
  std::optional<uint64_t> uncompressed_bytes;
  std::optional<uint64_t> resident_bytes;
  std::optional<uint64_t> secondary_indices_bytes;
  std::optional<uint64_t> projection_bytes;
  uint64_t active_parts = 0;
  uint64_t partitions = 0;
  std::vector<std::string> disks;
  // Raw storage roots reported by system.tables. These are intentionally kept
  // backend-only: they let non-MergeTree disk engines (TinyLog/Log/StripeLog)
  // resolve their storage medium without pretending they own system.parts.
  std::vector<std::string> data_paths;
  std::string last_part_time;

  ExplorerRate client_ingress;
  ExplorerRate physical_ingress;
  ExplorerReplication replication;

  std::string health = "healthy";
  std::vector<std::string> warnings;
};


struct ExplorerDatabaseDisk {
  std::string name;
  std::string host_name;
  std::string path;
  std::string type;
  uint64_t bytes = 0;
  std::optional<uint64_t> free_space;
  std::optional<uint64_t> total_space;
};

struct ExplorerDatabaseSummary {
  std::string name;
  uint64_t tables = 0;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  std::vector<ExplorerDatabaseDisk> disks;
};

struct ExplorerCatalog {
  uint64_t generated_at_ms = 0;
  std::string metric_scope = "local-replica";
  bool query_log_available = true;
  bool part_log_available = true;
  bool replication_available = true;
  std::vector<std::string> databases;
  std::vector<ExplorerDatabaseSummary> database_summaries;
  std::vector<ExplorerTableSummary> tables;
};

struct ExplorerColumnInfo {
  std::string name;
  std::string type;
  std::string default_kind;
  std::string default_expression;
  std::string codec_expression;
  std::string ttl_expression;
  bool is_subcolumn = false;
  std::string parent_name;
  std::optional<uint64_t> compressed_bytes;
  std::optional<uint64_t> uncompressed_bytes;
  std::optional<uint64_t> resident_bytes;
  std::optional<double> relative_weight;
};

struct ExplorerColumnStorageSummary {
  uint64_t compact_parts = 0;
  uint64_t wide_parts = 0;
  // Exact parent-part footprint split by on-disk part format. These counters
  // include the files owned by the parent part, so Browse can use them as the
  // allocation basis for a composition that reconciles to bytes_on_disk.
  std::optional<uint64_t> compact_on_disk_bytes;
  std::optional<uint64_t> wide_on_disk_bytes;
  std::optional<uint64_t> compact_compressed_bytes;
  std::optional<uint64_t> compact_uncompressed_bytes;
  std::optional<uint64_t> wide_compressed_bytes;
  std::optional<uint64_t> wide_uncompressed_bytes;
};

struct ExplorerStorageDisk {
  std::string disk;
  std::string path;
  std::optional<uint64_t> bytes;
  std::optional<uint64_t> rows;
  std::optional<uint64_t> free_space;
  std::optional<uint64_t> total_space;
  uint64_t parts = 0;
};

struct ExplorerPartInfo {
  std::string name;
  std::string partition;
  std::string disk;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  uint64_t marks = 0;
  uint64_t files = 0;
  uint64_t level = 0;
  uint64_t age_seconds = 0;
  bool active = true;
};

struct ExplorerPartitionInfo {
  std::string partition;
  uint64_t rows = 0;
  uint64_t bytes = 0;
  uint64_t parts = 0;
};

struct ExplorerIndexProjectionInfo {
  std::string name;
  std::string kind;
  std::string expression;
  std::optional<uint64_t> compressed_bytes;
  std::optional<uint64_t> uncompressed_bytes;
  // Available for projection parts. Skipping indexes do not expose a separate
  // bytes_on_disk counter in system.parts; their compressed bytes are accounted
  // explicitly and the parent-part residual remains with Wide/Compact.
  std::optional<uint64_t> on_disk_bytes;
};

struct ExplorerMutationInfo {
  std::string mutation_id;
  std::string command;
  std::string create_time;
  bool done = false;
  uint64_t parts_to_do = 0;
  std::string latest_failed_part;
  std::string latest_fail_time;
  std::string latest_fail_reason;
};

struct ExplorerMergeInfo {
  std::string partition;
  std::string result_part_name;
  double elapsed_seconds = 0;
  double progress = 0;
  uint64_t num_parts = 0;
  uint64_t rows_read = 0;
  uint64_t bytes_read = 0;
  uint64_t memory_usage = 0;
};

struct ExplorerDependencyInfo {
  std::string database;
  std::string table;
  std::string relation;
};

struct ExplorerTopologyNode {
  std::string cluster;
  uint64_t shard_num = 0;
  uint64_t replica_num = 0;
  std::string host_name;
  std::string host_address;
  uint64_t port = 0;
  bool is_local = false;
  uint64_t errors_count = 0;
  uint64_t slowdowns_count = 0;
  uint64_t estimated_recovery_time = 0;
};

struct ExplorerDistributionQueueItem {
  std::string data_path;
  bool blocked = false;
  uint64_t error_count = 0;
  uint64_t data_files = 0;
  uint64_t data_compressed_bytes = 0;
  uint64_t broken_data_files = 0;
  uint64_t broken_data_compressed_bytes = 0;
  std::string last_exception;
  std::string last_exception_time;
};

struct ExplorerReplicationQueueItem {
  std::string type;
  std::string create_time;
  std::string source_replica;
  std::string new_part_name;
  uint64_t num_tries = 0;
  std::string last_attempt_time;
  std::string last_exception;
};

struct ExplorerTableDetail {
  ExplorerTableSummary summary;
  // Scope totals are loaded lazily with the selected table so Browse can keep
  // Table / Database / ClickHouse percentages without bloating the list API.
  std::optional<uint64_t> database_footprint_bytes;
  std::optional<uint64_t> clickhouse_footprint_bytes;
  std::string create_table_query;
  // Actual default codecs observed on active MergeTree parts. A column with no
  // explicit CODEC() uses one of these part defaults; keeping the set avoids the
  // misleading browser label "server default" when ClickHouse can tell us what
  // was really written.
  std::vector<std::string> default_compression_codecs;
  std::vector<ExplorerColumnInfo> columns;
  ExplorerColumnStorageSummary column_storage;
  std::vector<ExplorerStorageDisk> storage;
  std::vector<ExplorerPartInfo> parts;
  std::vector<ExplorerPartitionInfo> partitions;
  std::vector<ExplorerIndexProjectionInfo> indexes_and_projections;
  std::vector<ExplorerMutationInfo> mutations;
  std::vector<ExplorerMergeInfo> merges;
  std::vector<ExplorerDependencyInfo> dependencies;
  std::vector<ExplorerTopologyNode> topology;
  std::vector<ExplorerDistributionQueueItem> distribution_queue;
  std::vector<ExplorerReplicationQueueItem> replication_queue;
  std::vector<std::string> unavailable_sections;
};

struct ExplorerFunctionAliasDocument {
  std::string name;
  std::string description;
  std::string syntax;
  std::string arguments;
  std::string parameters;
  std::string returned_value;
  std::string examples;
  std::string introduced_in;
};

struct ExplorerFunctionInfo {
  std::string name;
  std::string kind;
  std::string category;
  std::string description;
  std::string syntax;
  std::string arguments;
  std::string parameters;
  std::string returned_value;
  std::string examples;
  std::string introduced_in;
  std::string source;
  std::string origin;
  // Resolved server-side before the catalog leaves the backend. The browser
  // never follows aliases itself, which keeps recursion/cycle policy in one
  // bounded implementation.
  std::vector<ExplorerFunctionAliasDocument> alias_documents;
  bool user_defined = false;
};

struct ExplorerFunctionsCatalog {
  bool documentation_available = false;
  std::vector<ExplorerFunctionInfo> functions;
};

struct ExplorerPreviewColumn {
  std::string name;
  std::string type;
  bool finalized_for_preview = false;
};

struct ExplorerPreview {
  std::vector<ExplorerPreviewColumn> columns;
  std::vector<std::vector<std::string>> rows;
  size_t limit = 100;
};

bool load_explorer_catalog_index(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error);

bool load_explorer_database_summaries(
    clickhouse::Client& runner,
    const std::vector<std::string>& databases,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error);

bool load_explorer_table_summary(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    ExplorerTableSummary& out,
    std::string* error);

bool load_explorer_catalog(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error);

bool load_explorer_table_detail(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    const ExplorerTableSummary& summary,
    ExplorerTableDetail& out,
    std::string* error);

bool load_explorer_functions(
    clickhouse::Client& runner,
    ExplorerFunctionsCatalog& out,
    std::string* error);

bool load_explorer_preview(
    clickhouse::Client& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    size_t limit,
    ExplorerPreview& out,
    std::string* error);

} // namespace chdash
