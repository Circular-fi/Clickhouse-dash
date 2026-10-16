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
#   badsystem  the system user does not exist (the host answers, its system reads cannot);
#   toolnone   the MCP user (mcp_uri) connects and reads nothing;
#   toolmin    the MCP user reads chdash_ui only;
#   toolbad    the MCP user (mcp_uri) does not exist: no key can read this host.
# MCP is on, with one key for each host that has an mcp_uri (a key reads one host): the access audit also reads the MCP user of these hosts.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled      = true
  storage_file = "/data/mcp_keys.json"

  # One key for each host: a key reads one host.
  mcp_key "matrix" {
    token_file = "/run/secrets/chdash-test/mcp-key-matrix"
    tools      = ["*"]
    scope {
      hosts     = ["ok"]
      databases = ["*"]
    }
  }
  mcp_key "matrix-toolnone" {
    token_file = "/run/secrets/chdash-test/mcp-key-matrix-toolnone"
    tools      = ["*"]
    scope {
      hosts     = ["toolnone"]
      databases = ["*"]
    }
  }
  mcp_key "matrix-toolmin" {
    token_file = "/run/secrets/chdash-test/mcp-key-matrix-toolmin"
    tools      = ["*"]
    scope {
      hosts     = ["toolmin"]
      databases = ["*"]
    }
  }
}

observability {
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
}

clickhouse {
  host {
    name       = "ok"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp"
  }
  host {
    name       = "runnermin"
    runner_uri = "clickhouse://chdash_runner_min@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner_min"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
  host {
    name       = "systemnone"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_sysnone_user@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_sysnone_user"
  }
  host {
    name       = "systemmin"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_sysmin_user@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_sysmin_user"
  }
  host {
    name       = "runnernone"
    runner_uri = "clickhouse://chdash_runner_none@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner_none"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
  host {
    name       = "bothnone"
    runner_uri = "clickhouse://chdash_runner_none@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner_none"
    system_uri = "clickhouse://chdash_sysnone_user@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_sysnone_user"
  }
  host {
    name       = "badauth"
    runner_uri = "clickhouse://chdash_nobody@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_nobody"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
  host {
    name       = "badsystem"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_nobody@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_nobody"
  }
  host {
    name       = "toolnone"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_tool_none@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_tool_none"
  }
  host {
    name       = "toolmin"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_tool_min@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_tool_min"
  }
  host {
    name       = "toolbad"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_nobody@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_nobody"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
