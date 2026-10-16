# Production-like configuration of the release smoke test (tests/smoke/release_smoke.py).
# Every page is on: Explorer, System, Traces, Logs, Metrics, the query library and MCP. The ClickHouse
# host cannot be reached (the .invalid name never resolves): every route of a page shell and every
# redirect must answer without a database. The library file path is replaced by the script.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 500
}

explorer {
  browse = true

  graph {
    lineage          = true
    storage_topology = true
  }
}

system {
  enabled                      = true
  activity                     = true
  keeper                       = true
  top_queries                  = true
  cluster_fanout               = false
}

traces {
  enabled           = true
  analytics         = true
  database          = "otel"
  table             = "otel_traces"
  trace_index_table = "otel_traces_trace_id_ts"
  service_allowlist = ["*"]
}

logs {
  enabled     = true
  database    = "otel"
  table       = "otel_logs"
  body_search = "token"
}

metrics {
  enabled      = true
  database     = "otel"
  table_prefix = "otel_metrics"
}

query_library {
  enabled  = true
  file     = "/data/query_library.json"
  writable = true
}

mcp {
  enabled = true

  mcp_key "smoke" {
    token_env  = "CHDASH_SMOKE_KEY"
    tools      = ["list_hosts"]
    scope {
      hosts     = ["unreachable"]
      databases = ["*"]
    }
  }
}

clickhouse {
  host {
    name       = "unreachable"
    label      = "Unreachable ClickHouse"
    runner_uri = "clickhouse://chdash_runner@clickhouse.invalid:9000"
    system_uri = "clickhouse://chdash_system@clickhouse.invalid:9000"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse.invalid:9000"
    # The secrets come from the environment: the smoke test sets these variables (SMOKE_ENV of release_smoke.py).
    runner_password_env = "CHDASH_SMOKE_RUNNER_PASSWORD"
    system_password_env = "CHDASH_SMOKE_SYSTEM_PASSWORD"
    mcp_password_env    = "CHDASH_SMOKE_MCP_PASSWORD"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
