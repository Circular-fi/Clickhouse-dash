#pragma once

#include "api_error.hpp"

#include "allowed_objects.hpp"
#include "ddl_text_cache.hpp"

#include "ch_executor.hpp"

#include <cstdint>
#include <memory>
#include <utility>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
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
  // Table detail only (one system.replicas row of the opened table).
  bool is_leader = false;
  uint64_t inserts_in_queue = 0;
  uint64_t merges_in_queue = 0;
  uint64_t log_lag = 0;  // log_max_index - log_pointer, entries not yet fetched
  std::string last_queue_update;
  // replica_is_active: every replica registered in Keeper and whether it is up.
  std::vector<std::pair<std::string, bool>> replicas;
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
  std::string metadata_modification_time;

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
  // Raw storage roots reported by system.tables. These values stay in the backend only.
  // They let non-MergeTree disk engines (TinyLog, Log and StripeLog) find their storage medium. They do not mean that these engines own system.parts.
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

// Server-wide storage distribution, used by the Explorer "System" section.
// Byte values are local on-disk bytes. For MergeTree families, these are the `bytes_on_disk` of active parts. For other disk engines, they are `system.tables.total_bytes`.
// Memory, Buffer and Dictionary allocations are RAM and not disk. They go to resident_bytes. They do not mix into the treemap areas.
struct ExplorerStorageTable {
  std::string name;
  std::string engine;
  uint64_t bytes = 0;
  std::optional<uint64_t> rows;
  uint64_t parts = 0;
};

struct ExplorerStorageDatabase {
  std::string name;
  uint64_t bytes = 0;
  uint64_t rows = 0;
  uint64_t resident_bytes = 0;
  // Runner-visible objects, and the subset that owns on-disk bytes.
  uint64_t objects = 0;
  uint64_t storing_tables = 0;
  // The largest storing tables come first. The list is bounded. The remainder is stored in
  // exact aggregate counters, so that parent totals always reconcile.
  std::vector<ExplorerStorageTable> tables;
  uint64_t omitted_tables = 0;
  uint64_t omitted_bytes = 0;
  uint64_t omitted_rows = 0;
};

struct ExplorerStorageMap {
  uint64_t generated_at_ms = 0;
  std::string metric_scope = "local-replica";
  size_t table_limit_per_database = 0;
  std::vector<ExplorerStorageDatabase> databases;
};

// A section of the Explorer that a missing grant makes unreadable. The answer degrades. The figures of the section are absent,
// and the answer names the grant to give.
struct ExplorerUnavailableIssue {
  std::string section;
  std::string user;
  std::string grant;
};

// A section that cannot be read because of a missing grant degrades the answer. Any other error stays fatal.
// Returns true when the error is a missing grant. The section is then listed, with the grant to give.
template <typename Out>
inline bool degrade_on_denied(const std::string& section, const std::string& section_error, Out& out) {
  const auto denied = parse_access_denied(section_error);
  if (!denied) return false;
  out.unavailable_sections.push_back(section);
  out.unavailable_issues.push_back(ExplorerUnavailableIssue{section, denied->user, denied->grant});
  return true;
}

struct ExplorerCatalog {
  uint64_t generated_at_ms = 0;
  std::string metric_scope = "local-replica";
  bool query_log_available = true;
  bool part_log_available = true;
  bool replication_available = true;
  std::vector<std::string> databases;
  std::vector<ExplorerDatabaseSummary> database_summaries;
  std::vector<ExplorerTableSummary> tables;
  // One lazily expanded database: the local disks that its active parts use.
  std::vector<ExplorerDatabaseDisk> database_disks;
  // The sections that the system user cannot read because of a missing grant (storage, query ingress, replication...).
  std::vector<std::string> unavailable_sections;
  std::vector<ExplorerUnavailableIssue> unavailable_issues;
  // A bound of the privilege discovery stopped the discovery. Objects that were not checked are not listed.
  bool acl_truncated = false;
};

struct ExplorerColumnInfo {
  std::string name;
  std::string type;
  std::string default_kind;
  std::string default_expression;
  std::string codec_expression;
  std::string ttl_expression;
  std::string comment;
  bool in_partition_key = false;
  bool in_sorting_key = false;
  bool in_primary_key = false;
  bool in_sampling_key = false;
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
  // These counters give the exact footprint of the parent part, split by on-disk part format. The counters
  // include the files that the parent part owns. Browse can use them as the
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
  // Available for projection parts. Skipping indexes have no separate
  // bytes_on_disk counter in system.parts. Their compressed bytes are counted
  // explicitly, and the parent-part residual stays with Wide or Compact.
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
  // The link between the two objects: materialized_view, view, buffer,
  // distributed_route or dependency (system.tables.dependencies_*).
  std::string kind = "dependency";
  // The engine of the related object. The engine is read from system.tables after the name has
  // passed the runner visibility check. It is empty when the engine cannot be resolved.
  std::string engine;
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
  uint64_t generated_at_ms = 0;
  ExplorerTableSummary summary;
  // Scope totals load lazily with the selected table. Browse can keep
  // Table, Database and ClickHouse percentages so the list API stays small.
  std::optional<uint64_t> database_footprint_bytes;
  std::optional<uint64_t> clickhouse_footprint_bytes;
  std::string create_table_query;
  // Top-level TTL clause of create_table_query (rules separated by top-level
  // commas), without the column-level TTLs inside the column list.
  std::string table_ttl;
  // Distributed only: the engine's cluster / local database / local table.
  std::string distributed_cluster;
  std::string distributed_database;
  std::string distributed_table;
  // The actual default codecs seen on active MergeTree parts. A column without an explicit CODEC() uses one of these part defaults.
  // The set avoids the misleading browser label "server default". ClickHouse can tell the real codec that was written.
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
  std::vector<ExplorerUnavailableIssue> unavailable_issues;
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
  // The server resolves this before the catalog leaves the backend. The browser
  // never follows aliases itself. This keeps the recursion and cycle policy in one
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

class AclView;

// The identities of the two connections, given by acl_identity_key of their URIs. The caches use these identities as keys (DdlTextCache).
struct ExplorerIdentities {
  std::string system;
  std::string runner;
};

// The caches that the loaders of the catalog, of the graph and of the System activity share. The server owns one cache.
// The cached DDL texts and replica counts live as long as the server. A test creates its own cache.
class ReplicaCountCache;
struct ExplorerCaches {
  ExplorerCaches();
  ~ExplorerCaches();
  ExplorerCaches(const ExplorerCaches&) = delete;
  ExplorerCaches& operator=(const ExplorerCaches&) = delete;

  DdlTextCache ddl_texts;
  std::unique_ptr<ReplicaCountCache> replica_counts;
};

bool load_explorer_catalog_index(
    ChExecutor& system,
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error);

bool load_explorer_database_summaries(
    ChExecutor& runner,
    const std::vector<std::string>& databases,
    std::vector<ExplorerDatabaseSummary>& out,
    std::string* error);

// Builds the storage distribution of every runner-visible object. The object names come only from the runner's ACL
// (AclView: SHOW and CHECK GRANT as the runner). The system context adds only byte and row counters for names already in that boundary.
// The function runs one aggregated system.parts query and one system.tables query.
bool load_explorer_storage_map(
    ChExecutor& system,
    ChExecutor& runner,
    AclView& acl,
    ExplorerStorageMap& out,
    std::string* error);

bool load_explorer_table_summary(
    ChExecutor& system,
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    ExplorerTableSummary& out,
    std::string* error);

bool load_explorer_catalog(
    ChExecutor& system,
    ChExecutor& runner,
    ExplorerCaches& caches,
    const ExplorerIdentities& identities,
    const AllowedObjectSet& allowed,
    ExplorerCatalog& out,
    std::string* error);

bool load_explorer_table_detail(
    ChExecutor& system,
    ChExecutor& runner,
    AclView& acl,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    const ExplorerTableSummary& summary,
    ExplorerTableDetail& out,
    std::string* error);

bool load_explorer_functions(
    ChExecutor& runner,
    ExplorerFunctionsCatalog& out,
    std::string* error);

bool load_explorer_preview(
    ChExecutor& runner,
    const AllowedObjectSet& allowed,
    const std::string& database,
    const std::string& table,
    size_t limit,
    ExplorerPreview& out,
    std::string* error);

struct ExplorerReplicaCounts {
  uint64_t total = 0;
  uint64_t active = 0;
};

// total_replicas and active_replicas of the given replicated tables. These values come from the per-server 60 s cache shared with the catalog.
// Each table that is not in the cache costs one Keeper request. The key is database + '\0' + table. Tables whose lookup failed are absent.
std::unordered_map<std::string, ExplorerReplicaCounts> load_cached_replica_counts(
    ChExecutor& system,
    ExplorerCaches& caches,
    const std::vector<std::pair<std::string, std::string>>& tables,
    std::string* error);

} // namespace chdash
