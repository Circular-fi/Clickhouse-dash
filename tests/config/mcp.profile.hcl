# MCP users whose settings profile sets readonly (users in tests/clickhouse-init/01-chdash-users.sql). Used by
# tests/backend-functional/test_mcp.py (MCP_PROFILE_BASE_URL). One host for each profile; a key reads one host.
#   ro2     readonly = 2, three databases (chdash_ui, otel, otel_alt) and a fourth that it may not read (chdash_denied); the
#           key is wide (run_query needs it), so what the user cannot read is ClickHouse's to refuse;
#   ro2cap  readonly = 2 with limits of its own (max_result_rows = 7, max_execution_time = 4): the profile wins over the
#           configuration, and a key that is stricter than the profile still lowers it;
#   ro1     readonly = 1: ClickHouse refuses every setting, so ChDash sends none.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled        = true
  storage_file   = "/data/mcp_keys.json"
  manage_from_ui = true

  max_rows              = 100
  max_result_bytes      = 20000
  query_timeout_seconds = 5
  max_sql_bytes         = 2048
  max_memory_bytes      = 536870912
  rate_limit_per_minute = 600

  key {
    name      = "ro2"
    secret    = "20a7c0de-0000-4000-8000-000000000001"
    hosts     = ["ro2"]
    tools     = ["*"]
    databases = ["*"]
  }
  key {
    name      = "ro2cap"
    secret    = "20a7c0de-0000-4000-8000-000000000002"
    hosts     = ["ro2cap"]
    tools     = ["*"]
    databases = ["*"]
  }
  key {
    name      = "ro2cap-low"
    secret    = "20a7c0de-0000-4000-8000-000000000003"
    hosts     = ["ro2cap"]
    tools     = ["*"]
    databases = ["*"]
    max_rows  = 3
  }
  key {
    name      = "ro1"
    secret    = "20a7c0de-0000-4000-8000-000000000004"
    hosts     = ["ro1"]
    tools     = ["*"]
    databases = ["*"]
  }
}

clickhouse {
  host {
    name       = "ro2"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp_ro2:mcp_ro2_test@clickhouse:9000"
  }
  host {
    name       = "ro2cap"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp_ro2cap:mcp_ro2cap_test@clickhouse:9000"
  }
  host {
    name       = "ro1"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp_ro1:mcp_ro1_test@clickhouse:9000"
  }
}
