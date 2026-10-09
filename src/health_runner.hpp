#pragma once

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

int normalize_health_interval_ms(int interval_ms);

struct HostSpec {
  std::string id;         // stable id used by frontend (stored in localStorage)
  std::string label;      // display name
  std::string runner_uri; // clickhouse://...
  std::string system_uri; // clickhouse://...
  // The MCP identity (docs/mcp.md): empty = the host is invisible to MCP. Never falls back to runner/system.
  std::string mcp_uri;
};

struct HealthSettings {
  int interval_ms = 5000;
  int timeout_ms = 800;
  // Tables ("database.table") that the system user must be able to read for the features that the
  // configuration turns on (the OpenTelemetry traces, logs and metrics tables).
  std::vector<std::string> system_reads;
  // MCP is on: the audit also reads the grants of the MCP user of each host that has an mcp_uri, for these tables
  // (the OpenTelemetry tables that are on, the skipping indices, the documentation of the functions).
  bool mcp_audit = false;
  std::vector<std::string> mcp_reads;
};

// What each identity of a host may do, read from CHECK GRANT (never from the data): the connection
// works (the health check), and that is all it says. A user that connects but may read nothing is
// healthy for the health check and useless for the features, so the audit says it.
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
  // The MCP user (mcp_uri), when MCP is on and the host has one.
  std::string mcp_user;
  std::vector<std::string> mcp_missing;
  bool mcp_reads_nothing = false;
  // The MCP user was tried (the host answered, MCP is on and the host has an mcp_uri), and whether it connected.
  // Not audited means unknown: the host was down at the last check, or MCP is off.
  bool mcp_audited = false;
  bool mcp_connected = false;
  std::string mcp_error;
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
  // timezone() of the server, the zone of its DateTime text ("" until known).
  std::string clickhouse_timezone;
  int64_t version_checked_at_ms = 0;
  HostSystemTables system_tables;
  HostAccess access;
  // Why the host is down (the last connection or ping error); empty when it is up.
  std::string error;
};

struct HostsSnapshot {
  int64_t ts_ms = 0;
  int interval_ms = 5000;
  int timeout_ms = 800;
  std::vector<HostHealth> hosts;
};

class HealthRunner {
public:
  HealthRunner(std::vector<HostSpec> hosts, HealthSettings settings);
  ~HealthRunner();

  void start();
  void stop();

  HostsSnapshot snapshot() const;

  // Monotonic snapshot version that increments after each health check cycle.
  uint64_t version() const;

  // Blocks until version changes from last_version or wait_ms elapses.
  // Returns true if version changed.
  bool wait_for_update(uint64_t last_version, int wait_ms, uint64_t* new_version);

  // Strict: all hosts healthy.
  bool all_healthy() const;

private:
  void loop();

  std::vector<HostSpec> hosts_;
  HealthSettings settings_;

  // One runner client per host, owned by the health thread. Query
  // availability must be measured with the same credentials used for user
  // queries; the system account is probed separately for diagnostics.
  struct HostCtx {
    HostSpec spec;
    std::shared_ptr<clickhouse::Client> client;
    HostHealth last;
    std::string last_error;
  };

  mutable std::mutex mu_;
  mutable std::condition_variable cv_;
  uint64_t version_{0};
  std::vector<HostCtx> ctx_;
  std::atomic<bool> stop_{false};
  std::thread th_;
};

} // namespace chdash
