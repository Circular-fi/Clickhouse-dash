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
  enabled      = true
  storage_file = "/data/mcp_keys.json"

  # The usage of the keys: the file of this instance is /data/chdash-mcp-test.jsonl.zst (a name that the tests know: the host name of a
  # container changes). Other instances can share /data: the tests put the files of a few instances there.
  # all_keys is on: a key that names mcp_analysis_all_usage reads the usage of every key (the tests make such keys; "*" never gives it).
  usage {
    enabled  = true
    dir      = "/data"
    instance = "chdash-mcp-test"
    all_keys = true
  }

  max_rows              = 100
  max_result_bytes      = 20000
  query_timeout_seconds = 5
  max_sql_bytes         = 2048
  max_memory_bytes      = 536870912
  max_rows_to_read      = 5000000
  rate_limit_per_minute = 120
  allowed_origins       = ["https://inspector.example.com"]

  # The keys of the contract (mcp_key): the name is the label, the token comes from a file, the scope and the limits are blocks. The
  # keys all-data, weather-only, otel-reader and limited keep a token of the older form (a UUID version 4): ChDash accepts it until it is
  # replaced, with a warning at start. The other keys have an mcp_ token.
  keys {
    mode = "hybrid"
  }

  mcp_key "all-data" {
    token_file = "/run/secrets/chdash-test/mcp-key-all-data"
    tools      = ["*"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }

  mcp_key "weather-only" {
    token_file = "/run/secrets/chdash-test/mcp-key-weather-only"
    subject    = "weather-team"
    tools      = ["list_hosts", "list_databases", "list_tables", "describe_table", "query_table"]
    scope {
      hosts     = ["local"]
      databases = ["chdash_ui.weather_*"]
    }
  }

  mcp_key "otel-reader" {
    token_file = "/run/secrets/chdash-test/mcp-key-otel-reader"
    tools      = ["*"]
    scope {
      hosts     = ["local"]
      databases = ["otel"]
    }
    limits {
      max_rows = 10
    }
  }

  mcp_key "limited" {
    token_file = "/run/secrets/chdash-test/mcp-key-limited"
    tools      = ["*"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
    limits {
      max_rows        = 5
      timeout_seconds = 1
    }
  }

  mcp_key "second-host" {
    token_file = "/run/secrets/chdash-test/mcp-key-second-host"
    tools      = ["*"]
    scope {
      hosts     = ["second"]
      databases = ["*"]
    }
  }

  mcp_key "hosts-only" {
    token_file = "/run/secrets/chdash-test/mcp-key-hosts-only"
    subject    = "alice"
    tools      = ["list_hosts"]
    expires    = "2099-12-31T23:59:59Z"
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }

  # A rate limit of its own, lower than the one of mcp: the rate limit tests reach it with few calls.
  mcp_key "rate-test" {
    token_file = "/run/secrets/chdash-test/mcp-key-rate-test"
    tools      = ["list_hosts"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
    limits {
      rate_limit_per_minute = 30
    }
  }

  # A key that expired: its requests get the 401 of an unknown key.
  mcp_key "expired" {
    token_file = "/run/secrets/chdash-test/mcp-key-expired"
    tools      = ["list_hosts"]
    expires    = "2020-01-01T00:00:00Z"
    scope {
      hosts = ["local"]
    }
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
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp"
  }
  host {
    name       = "second"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp"
  }
  host {
    name       = "plain"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
