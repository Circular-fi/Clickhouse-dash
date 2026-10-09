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
    secret      = "a11da7a0-0000-4000-8000-000000000001"
    hosts       = ["local"]
    tools       = ["*"]
    databases   = ["*"]
  }

  key {
    name        = "weather-only"
    secret      = "3ea7be00-0000-4000-8000-000000000002"
    hosts       = ["local"]
    tools       = ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    databases   = ["chdash_ui.weather_*"]
  }

  key {
    name        = "otel-reader"
    secret      = "07e1ead0-0000-4000-8000-000000000003"
    hosts       = ["local"]
    tools       = ["*"]
    databases   = ["otel"]
    max_rows    = 10
  }

  key {
    name            = "limited"
    secret          = "11317ed0-0000-4000-8000-000000000004"
    hosts           = ["local"]
    tools           = ["*"]
    databases       = ["*"]
    max_rows        = 5
    timeout_seconds = 1
  }

  key {
    name      = "second-host"
    secret    = "5ec0d000-0000-4000-8000-000000000005"
    hosts     = ["second"]
    tools     = ["*"]
    databases = ["*"]
  }

  key {
    name      = "hosts-only"
    secret    = "4057a000-0000-4000-8000-000000000006"
    hosts     = ["local"]
    tools     = ["list_hosts"]
    databases = ["*"]
  }

  key {
    name      = "rate-test"
    secret    = "7a7e7e57-0000-4000-8000-000000000007"
    hosts     = ["local"]
    tools     = ["list_hosts"]
    databases = ["*"]
  }
}

# The OpenTelemetry tables that the tools of Observability read (docs/configuration.md, "observability"). A long lookback so
# that the fixture data is in reach.
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
