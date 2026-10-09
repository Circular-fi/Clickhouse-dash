# The privilege matrix: one host for each way that the identities of a host can be narrowly or wrongly
# set up, on the test ClickHouse (users in tests/clickhouse-init/01-chdash-users.sql). Used by
# tests/backend-functional/test_privileges.py (PRIVILEGES_BASE_URL); its tests are skipped without it.
#   ok         the normal pair: the control of every test;
#   runnermin  a runner limited to two databases (chdash_ui, chdash_repl), no grant on system.*;
#   systemnone a system user that may read no system table, with a normal runner;
#   systemmin  a system user that reads only system.databases, tables and columns;
#   runnernone a runner that may read nothing, with a normal system user;
#   bothnone   both identities connect and may read nothing;
#   badauth    the runner is a user that does not exist (the host is down);
#   badsystem  the system user does not exist (the host answers, its system reads cannot).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

traces {
  enabled              = true
  database             = "otel"
  table                = "otel_traces"
  trace_index_table    = "otel_traces_trace_id_ts"
  max_lookback_minutes = 100000
}

logs {
  enabled              = true
  database             = "otel"
  table                = "otel_logs"
  max_lookback_minutes = 100000
}

metrics {
  enabled      = true
  database     = "otel"
  table_prefix = "otel_metrics"
}

clickhouse {
  host {
    name       = "ok"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "runnermin"
    runner_uri = "clickhouse://chdash_runner_min:runner_min_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "systemnone"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system_none:system_none_test@clickhouse:9000"
  }
  host {
    name       = "systemmin"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system_min:system_min_test@clickhouse:9000"
  }
  host {
    name       = "runnernone"
    runner_uri = "clickhouse://chdash_runner_none:runner_none_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "bothnone"
    runner_uri = "clickhouse://chdash_runner_none:runner_none_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system_none:system_none_test@clickhouse:9000"
  }
  host {
    name       = "badauth"
    runner_uri = "clickhouse://chdash_nobody:nobody@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "badsystem"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_nobody:nobody@clickhouse:9000"
  }
}
