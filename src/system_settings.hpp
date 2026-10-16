#pragma once

#include <cstdint>

namespace chdash {

// This is the System page (docs/system.md) of the selected server. It is not a database or a table.
// The page has these parts: Overview (server tiles, databases, topology, Keeper, replication, the performance history, and the background activity), Queries (system.query_log), and Disks.
// Every read is a fixed, bounded system-table SELECT.
struct SystemSettings {
  bool enabled = true;
  // The Activity part of the Overview (merges, mutations, replication and Distributed queues: /api/system/activity).
  // The setting explorer.operations.enabled in v2.14.0 also sets it.
  bool activity = true;
  // The Keeper / ZooKeeper session (/api/system/keeper).
  // The setting explorer.operations.keeper in v2.14.0 also sets it.
  bool keeper = true;
  // The Queries section (top queries of system.query_log, runner context).
  bool top_queries = true;
  // clusterAllReplicas() views; needs GRANT REMOTE for the system account.
  bool cluster_fanout = false;
  // Time windows and caps of the history parts.
  int default_lookback_minutes = 60;
  int max_lookback_days = 30;
  int query_log_max_lookback_hours = 7 * 24;
  uint64_t query_log_max_rows = 50'000'000;
  int disk_growth_days = 7;
  bool activity_enabled() const { return enabled && activity; }
  bool keeper_enabled() const { return enabled && keeper; }
  bool top_queries_enabled() const { return enabled && top_queries; }
};


} // namespace chdash
