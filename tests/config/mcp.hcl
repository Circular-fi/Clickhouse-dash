# MCP, editable: config keys of every shape, the UI key file in /data (a writable, empty
# directory), and small limits so the cap tests need few rows. Used by
# tests/backend-functional/test_mcp.py (MCP_BASE_URL). Hosts: "local" and "second" have the MCP
# identity (the same ClickHouse); "plain" has none, so MCP never sees it.
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
  max_rows_to_read      = 5000000
  rate_limit_per_minute = 120
  allowed_origins       = ["https://inspector.example.com"]

  key {
    name        = "all-data"
    secret      = "all-data-secret-0123456789abcdef"
    hosts       = ["*"]
    tools       = ["*"]
    databases   = ["*"]
  }

  key {
    name        = "weather-only"
    secret      = "weather-secret-0123456789abcdef"
    hosts       = ["local"]
    tools       = ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    databases   = ["chdash_ui.weather_*"]
  }

  key {
    name        = "otel-reader"
    secret      = "otel-reader-secret-0123456789ab"
    hosts       = ["local"]
    tools       = ["*"]
    databases   = ["otel"]
    max_rows    = 10
  }

  key {
    name            = "limited"
    secret          = "limited-secret-0123456789abcdef"
    hosts           = ["local"]
    tools           = ["*"]
    databases       = ["*"]
    max_rows        = 5
    timeout_seconds = 1
  }

  key {
    name      = "two-hosts"
    secret    = "two-hosts-secret-0123456789abcd"
    hosts     = ["local", "second"]
    tools     = ["*"]
    databases = ["*"]
  }

  key {
    name      = "hosts-only"
    secret    = "hosts-only-secret-0123456789abc"
    hosts     = ["local"]
    tools     = ["list_hosts"]
    databases = ["*"]
  }

  key {
    name      = "no-host"
    secret    = "no-host-secret-0123456789abcdef"
    hosts     = []
    tools     = ["*"]
    databases = ["*"]
  }

  key {
    name      = "switched-off"
    secret    = "switched-off-secret-0123456789ab"
    hosts     = ["local"]
    tools     = ["*"]
    databases = ["*"]
    enabled   = false
  }

  key {
    name          = "hashed"
    secret_sha256 = "c240b3bd963d923a1c1a87310384bbcf17909162847c49faf94c43695b2b2564"
    hosts         = ["local"]
    tools         = ["list_hosts"]
    databases     = ["*"]
  }

  key {
    name      = "rate-test"
    secret    = "rate-test-secret-0123456789abcde"
    hosts     = ["local"]
    tools     = ["list_hosts"]
    databases = ["*"]
  }
}

clickhouse {
  host {
    name       = "local"
    label      = "Local ClickHouse"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp:mcp_test@clickhouse:9000"
  }
  host {
    name       = "second"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp:mcp_test@clickhouse:9000"
  }
  host {
    name       = "plain"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
