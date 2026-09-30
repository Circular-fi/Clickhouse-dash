# Optional config if you explicitly want to benchmark against a ClickHouse server
# running on the Docker host instead of the compose-managed clickhouse service.
health {
  interval_ms = 1000
  timeout_ms  = 1000
}

traces {
  enabled                  = true
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
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

logs {
  enabled              = true
  database             = "otel"
  table                = "otel_logs"
  max_lookback_minutes = 10080
  search_limit         = 200
  # token: hasToken() on Body (index-backed by the exporter's tokenbf_v1
  # idx_body); substring: case-insensitive scan; off: no Body search.
  body_search          = "token"
}

metrics {
  enabled      = true
  database     = "otel"
  table_prefix = "otel_metrics"
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@host.docker.internal:9000"
    system_uri = "clickhouse://chdash_system:system_test@host.docker.internal:9000"
  }
}
