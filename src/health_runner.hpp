#pragma once

#include "otel_settings.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace clickhouse { class Client; }

namespace chdash {

struct HostSpec {
  std::string id;         // stable id used by frontend (stored in localStorage)
  std::string label;      // display name
  std::string runner_uri; // clickhouse://...
  std::string system_uri; // clickhouse://...
  // The MCP identity (docs/mcp.md). An empty value makes the host invisible to MCP. It never falls back to runner or system credentials.
  std::string mcp_uri;
  // The OpenTelemetry pages, as they apply to this host. These are the settings of the `observability` block with the override of
  // the host applied (config.cpp). Read these settings, not the defaults of the configuration, to serve a request of the host.
  OtelHostOverride otel_override;
  OtelSettings otel;
};

struct HealthSettings {
  int interval_ms = 5000;
  int timeout_ms = 800;
  // Tables ("database.table") that the system user must be able to read for the features that the
  // configuration turns on (the OpenTelemetry traces, logs and metrics tables).
  std::vector<std::string> system_reads;
  // MCP is on. The audit also reads the grants of the MCP user of each host that has an mcp_uri, for these tables
  // (the OpenTelemetry tables that are on, the skipping indices, the documentation of the functions).
  bool mcp_audit = false;
  std::vector<std::string> mcp_reads;
};

// The grants of each identity of a host. CHECK GRANT gives them, and the runner never reads them from the data. The connection
// works (the health check). That is all the connection says. A user that connects but may read nothing is
// healthy for the health check and useless for the features. The audit reports this state.
struct HostAccess {
  bool checked = false;
  int64_t checked_at_ms = 0;
  std::string runner_user;
  std::string system_user;
  // Grants that a feature needs and that the identity does not have, as "SELECT ON system.parts".
  std::vector<std::string> runner_missing;
  std::vector<std::string> system_missing;
  // The runner has SELECT on no table that the Explorer could show.
  bool runner_reads_nothing = false;
  // The runner holds the privilege displaySecretsInShowAndSelect (CHECK GRANT). The Explorer serves the DDL texts as the runner. With the server
  // setting display_secrets_in_show_and_select and the setting format_display_secrets_in_show_and_select, such a user reads the secrets that
  // ClickHouse masks for the other users (docs/configuration.md, "Secrets in the DDL texts").
  bool runner_shows_secrets = false;
  // The MCP user (mcp_uri), when MCP is on and the host has one.
  std::string mcp_user;
  std::vector<std::string> mcp_missing;
  bool mcp_reads_nothing = false;
  // The MCP user holds the privilege displaySecretsInShowAndSelect. The API tools serve the DDL texts as the MCP user.
  bool mcp_shows_secrets = false;
  // The MCP user was tried. This means that the host answered, MCP is on, and the host has an mcp_uri. The result says whether the MCP user connected.
  // Not audited means unknown. The host was down at the last check, or MCP is off.
  bool mcp_audited = false;
  bool mcp_connected = false;
  std::string mcp_error;
  // The settings profile of the MCP user, read with the audit. It gives the limits that a key cannot exceed. 0 means that the profile sets no limit.
  bool mcp_profile_known = false;
  uint64_t mcp_readonly = 0;
  double mcp_max_execution_time = 0;  // seconds
  uint64_t mcp_max_result_rows = 0;
  // One sentence for each finding, for the logs and the hosts API.
  std::vector<std::string> warnings;
};

struct HostSystemTables {
  bool checked = false;
  int64_t checked_at_ms = 0;
  bool query_log = false;
  bool query_views_log = false;
  bool processors_profile_log = false;
  bool opentelemetry_span_log = false;
};

struct HostHealth {
  std::string id;
  std::string label;
  bool healthy = false;
  int64_t ping_ms = -1;
  int64_t checked_at_ms = 0;
  std::string clickhouse_version;
  // timezone() of the server, the zone of its DateTime text. The value is empty until it is known.
  std::string clickhouse_timezone;
  // max_query_size of the server: the longest SQL text that it parses. The value is 0 until it is known.
  size_t clickhouse_max_query_size = 0;
  int64_t version_checked_at_ms = 0;
  HostSystemTables system_tables;
  HostAccess access;
  // Why the host is down: the error of the last connection or ping. The value is empty when the host is up.
  std::string error;
};

struct HostsSnapshot {
  int64_t ts_ms = 0;
  int interval_ms = 5000;
  int timeout_ms = 800;
  std::vector<HostHealth> hosts;
};

// The health of the hosts (docs/configuration.md, "Host identities and the access audit"). Each host has its own
// ping thread. Each ping thread owns one runner client for its host. The client connects with the runner credentials,
// pings every health.interval_ms with health.timeout_ms, and reads version() and timezone() every 10 minutes. A slow
// or dead host never delays the ping of another host. The access audit (CHECK GRANT, the system tables) runs in one
// thread of its own, with its own connections and a time budget. The audit never delays a ping either.
class HealthRunner {
public:
  HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings);
  ~HealthRunner();

  void start();
  // Ends the threads. A wait wakes at once, and an audit stops before its next query.
  void stop();

  HostsSnapshot snapshot() const;

  // The monotonic snapshot version. It increases after each ping and each audit of a host.
  uint64_t version() const;

  // Blocks until the version changes from last_version, or until wait_ms elapses.
  // Returns true if the version changed.
  bool wait_for_update(uint64_t last_version, int wait_ms, uint64_t* new_version);

  // Strict check: true when all hosts are healthy.
  bool all_healthy() const;
  // The hosts that answered their last ping.
  size_t healthy_count() const;

  // The longest time that one audit of a host may take. When this time ends, the audit stops and reports only what it read.
  static constexpr int64_t kAuditBudgetMs = 60 * 1000;

private:
  void ping_loop(size_t index);
  void audit_loop();
  // Waits until the deadline or stop(). Returns true when the runner stops.
  bool sleep_until(std::chrono::steady_clock::time_point deadline);
  bool stopping() const { return stop_flag_.load(std::memory_order_acquire); }

  std::vector<HostSpec> hosts_;
  HealthSettings settings_;

  struct HostCtx {
    HostSpec spec;
    HostHealth last;
    std::string last_error;
    // The host answered again, or it answered for the first time. Its audit runs now, not at the next 10-minute mark.
    bool audit_due = true;
  };

  mutable std::mutex mu_;
  mutable std::condition_variable cv_;
  uint64_t version_{0};
  std::vector<HostCtx> ctx_;
  // Written under mu_, so a waiter never misses it. Read without the lock between two queries.
  bool stop_ = false;
  std::atomic<bool> stop_flag_{false};
  std::vector<std::thread> threads_;
};

} // namespace chdash
