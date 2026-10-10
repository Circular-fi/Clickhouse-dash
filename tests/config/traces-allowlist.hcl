# The Trace Explorer with a restricted service_allowlist: of the services of the rich dataset (2026-09-12), only
# "inventory" and "auth" are shown. Their parents ("frontend", "checkout") and the spans that "inventory" links to
# ("checkout") are hidden. Used by tests/backend-functional/test_trace_hidden_parents.py (TRACES_ALLOWLIST_BASE_URL);
# its tests are skipped without it.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

traces {
  enabled                  = true
  database                 = "otel"
  table                    = "otel_traces"
  trace_index_table        = "otel_traces_trace_id_ts"
  service_allowlist        = ["inventory", "auth"]
  max_lookback_minutes     = 525600
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
