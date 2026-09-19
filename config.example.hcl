# Complete file configuration. Start with:
#   chdash --config /path/to/config.hcl
#
# Application configuration is HCL-only. Environment variables are not an
# application configuration interface. Omitted attributes use the defaults shown below.

server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

query {
  result_preview_row_limit = 10000
  max_sql_bytes            = 4194304

  describe_mode              = "auto"
  sample_interval_ms         = 40

  result_batch_rows = 1000
  result_batch_bytes = 262144
  sse_batch_events  = 8
  sse_batch_bytes   = 262144
  sse_queue_max_bytes     = 8388608
  max_result_cell_bytes  = 33554432
  max_result_event_bytes = 33554432

  # Signed cancel capabilities are valid for at most 48 hours. A server restart
  # rotates the internal signing secret and therefore invalidates older tokens.
  cancel_token_ttl_ms = 172800000

  describe_cache_entries = 256
  describe_cache_ttl_ms  = 60000

  session_max_count          = 256
  session_abandoned_ttl_ms   = 60000
  session_terminal_ttl_ms    = 30000
  session_reaper_interval_ms = 5000
}

client_pool {
  max_idle              = 4
  idle_ttl_ms            = 60000
  validate_after_idle_ms = 15000
  reaper_interval_ms     = 5000
}

format_cache {
  max_entries = 512
  max_bytes   = 16777216
  ttl_ms      = 600000
}

explorer {
  browse = true

  graph {
    lineage          = true
    storage_topology = true
  }

  cache_ttl_ms            = 5000
  live_refresh_ms         = 2000
  function_cache_ttl_ms   = 3600000
  function_markdown_links = false
}

traces {
  enabled                  = false
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
  # ServiceName access control. "*" allows every service. Patterns use "*"
  # as a glob wildcard, e.g. "test_*" allows every service starting test_.
  service_allowlist        = ["*"]
  default_lookback_minutes = 60
  max_lookback_minutes     = 10080
  search_limit             = 100
  max_spans_per_trace      = 10000

  features {
    service_filter      = true
    operation_filter    = true
    status_filter       = true
    duration_filter     = true
    resource_attributes = true
    span_attributes     = true
    events              = true
    links               = true
  }
}

analysis {
  registry_ttl_ms      = 3600000
  registry_max_entries = 10000
  registry_sql_max_bytes = 33554432
  log_lookup_timeout_ms = 2000
  flush_logs            = false
  allow_deep_analyze    = false
}

export {
  max_concurrent        = 1
  output_buffer_bytes   = 262144
  archive_format        = "zip"
  compression           = false
  token_ttl_ms          = 120000
  pending_max_entries   = 32
  pending_sql_max_bytes = 16777216
  max_queries           = 256
}

health {
  interval_ms = 5000
  timeout_ms  = 800
}

clickhouse {
  host {
    name       = "local"
    label      = "ClickHouse local"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"

    # Keep the runner and technical system credentials separate. The runner is
    # the authorization boundary for panel SQL; the system account is reserved
    # for backend-generated metadata/log queries and cancellation.
    runner_password_file = "/run/secrets/chdash_runner_password"
    system_password_file = "/run/secrets/chdash_system_password"
  }
}
