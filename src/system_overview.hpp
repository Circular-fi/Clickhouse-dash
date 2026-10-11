#pragma once

#include "system_monitor.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace chdash {

// The Overview of the System page (docs/system.md): the server's identity, its tiles, the topology and the replication summary.

class AclView;
class ChExecutor;

struct MonitorClusterNode {
  std::string cluster;
  uint64_t shard_num = 0;
  uint64_t shard_weight = 0;
  uint64_t replica_num = 0;
  std::string host_name;
  std::string host_address;
  uint64_t port = 0;
  bool is_local = false;
  // Absent on servers without these columns.
  std::optional<uint64_t> errors_count;
  std::optional<uint64_t> slowdowns_count;
  std::optional<uint64_t> estimated_recovery_time;
};

// Replicated tables the runner can see, summarised (in-memory columns of
// system.replicas only; the thresholds are Altinity's replica alerts).
struct MonitorReplicationSummary {
  uint64_t tables = 0;
  uint64_t readonly = 0;
  uint64_t session_expired = 0;
  uint64_t max_delay_seconds = 0;
  uint64_t queue_size = 0;
  uint64_t inserts_in_queue = 0;
  uint64_t merges_in_queue = 0;
  uint64_t future_parts_over = 0;    // future_parts > 20
  uint64_t parts_to_check_over = 0;  // parts_to_check > 10
  uint64_t queue_over = 0;           // queue_size > 20
  uint64_t inserts_over = 0;         // inserts_in_queue > 10
  bool truncated = false;
};

struct SystemMonitorOverview {
  uint64_t generated_at_ms = 0;
  std::string hostname;
  std::string version;
  std::string timezone;
  std::optional<uint64_t> uptime_seconds;
  // Allowlisted system.asynchronous_metrics and system.metrics values, by name.
  std::map<std::string, double> metrics;
  std::vector<MonitorClusterNode> topology;
  bool topology_truncated = false;
  std::optional<MonitorReplicationSummary> replication;
  // Optional system logs, as detected (the Performance, Queries and Disks
  // sections read them).
  std::map<std::string, bool> logs;
  std::vector<MonitorPanelIssue> unavailable_panels;
};

// Rows of system.clusters kept per response.
constexpr size_t kMonitorTopologyRowLimit = 1000;
// Replicated tables read for the replication summary.
constexpr size_t kMonitorReplicaRowLimit = 10000;

// Server tiles, topology and the replication summary of the runner-visible
// replicated tables. Returns false only when nothing at all could be read.
bool load_system_monitor_overview(
    ChExecutor& system,
    AclView& runner_acl,
    const MonitorCapabilities& caps,
    SystemMonitorOverview& out,
    std::string* error);

// The allowlists, exposed for the contract tests and the docs.
const std::vector<std::string>& monitor_overview_async_metrics();
const std::vector<std::string>& monitor_overview_metrics();

} // namespace chdash
