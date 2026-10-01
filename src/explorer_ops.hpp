#pragma once

#include <clickhouse/client.h>

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// Explorer "Server operations" view: background activity of the selected
// server (merges, mutations, replication, Distributed send queues) plus the
// Keeper/ZooKeeper session state. Every row that names an object is read
// through the system context and serialized only when the runner context can
// SHOW that object (same boundary as the storage map). Every query is a
// fixed, allowlisted, bounded read of in-memory system tables.

struct ExplorerOpsMerge {
  std::string database;
  std::string table;
  double elapsed_seconds = 0;
  double progress = 0;
  uint64_t num_parts = 0;
  std::string result_part_name;
  std::string partition_id;
  bool is_mutation = false;
  std::string merge_type;
  uint64_t total_bytes_compressed = 0;
  uint64_t bytes_read_uncompressed = 0;
  uint64_t rows_read = 0;
  uint64_t memory_usage = 0;
};

struct ExplorerOpsMutation {
  std::string database;
  std::string table;
  std::string mutation_id;
  std::string command;
  std::string create_time;
  uint64_t parts_to_do = 0;
  bool is_done = false;
  bool is_killed = false;
  std::string latest_failed_part;
  std::string latest_fail_time;
  std::string latest_fail_reason;
  std::string latest_fail_error_code_name;
};

struct ExplorerOpsReplicationQueue {
  std::string database;
  std::string table;
  uint64_t entries = 0;
  uint64_t executing = 0;
  uint64_t postponed = 0;
  uint64_t max_tries = 0;
  std::string oldest_create_time;
  std::vector<std::string> types;
  std::string postpone_reason;
  std::string last_exception;
  std::string last_exception_time;
};

struct ExplorerOpsReplica {
  std::string database;
  std::string table;
  std::string replica_name;
  bool is_leader = false;
  bool is_readonly = false;
  bool is_session_expired = false;
  uint64_t queue_size = 0;
  uint64_t inserts_in_queue = 0;
  uint64_t merges_in_queue = 0;
  uint64_t absolute_delay_seconds = 0;
  std::string queue_oldest_time;
  std::string last_queue_update;
  std::string last_queue_update_exception;
  std::optional<uint64_t> total_replicas;
  std::optional<uint64_t> active_replicas;
};

struct ExplorerOpsDistributionQueue {
  std::string database;
  std::string table;
  std::string data_path;
  bool is_blocked = false;
  uint64_t error_count = 0;
  uint64_t data_files = 0;
  uint64_t data_compressed_bytes = 0;
  uint64_t broken_data_files = 0;
  uint64_t broken_data_compressed_bytes = 0;
  std::string last_exception;
  std::string last_exception_time;
};

struct ExplorerOpsActivity {
  uint64_t generated_at_ms = 0;
  size_t row_limit = 0;
  std::vector<ExplorerOpsMerge> merges;
  std::vector<ExplorerOpsMutation> mutations;
  std::vector<ExplorerOpsReplicationQueue> replication_queue;
  std::vector<ExplorerOpsReplica> replicas;
  std::vector<ExplorerOpsDistributionQueue> distribution_queue;
  // Sections whose system table could not be read (older server, missing
  // grant). The section is reported unavailable instead of empty.
  std::vector<std::string> unavailable_sections;
  // Sections whose bounded read hit the row limit.
  std::vector<std::string> truncated_sections;
};

struct ExplorerKeeperConnection {
  std::string name;
  std::string host;
  uint64_t port = 0;
  uint64_t index = 0;
  std::string connected_time;
  uint64_t session_uptime_seconds = 0;
  bool is_expired = false;
  uint64_t keeper_api_version = 0;
  std::optional<uint64_t> session_timeout_ms;
};

struct ExplorerKeeperStatus {
  uint64_t generated_at_ms = 0;
  // false when the server has no Keeper/ZooKeeper configured (no connection
  // row and no session metric).
  bool configured = false;
  std::vector<ExplorerKeeperConnection> connections;
  // Allowlisted system.metrics (current values) and system.events
  // (cumulative counters since server start), by name.
  std::map<std::string, int64_t> metrics;
  std::map<std::string, uint64_t> events;
  std::vector<std::string> unavailable_sections;
};

// Activity rows are kept only when `runner` can SHOW the object. At most
// `row_limit` rows are returned per section.
bool load_explorer_ops_activity(
    clickhouse::Client& system,
    clickhouse::Client& runner,
    size_t row_limit,
    ExplorerOpsActivity& out,
    std::string* error);

// Server-level Keeper session state; contains no object names.
bool load_explorer_keeper_status(
    clickhouse::Client& system,
    ExplorerKeeperStatus& out,
    std::string* error);

} // namespace chdash
