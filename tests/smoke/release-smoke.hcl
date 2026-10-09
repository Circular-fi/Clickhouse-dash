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

  key {
    name      = "smoke"
    secret    = "smoke-secret-0123456789abcdef0123"
    hosts     = ["unreachable"]
    tools     = ["list_hosts"]
    databases = ["*"]
  }
}

clickhouse {
  host {
    name       = "unreachable"
    label      = "Unreachable ClickHouse"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse.invalid:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse.invalid:9000"
    mcp_uri    = "clickhouse://chdash_mcp:mcp_test@clickhouse.invalid:9000"
  }
}
