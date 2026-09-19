# Kept for compatibility with older commands. The default CH_HOSTS.hcl now already uses
# the compose-managed ClickHouse service at clickhouse:9000.
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

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
