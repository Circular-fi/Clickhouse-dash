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

# The System page (docs/system.md): the selected server's Overview (tiles,
# databases, cluster, performance history, activity), Queries and Disks.
# explorer.operations { enabled, keeper } (v2.14.0) still sets activity and
# keeper.
system {
  enabled                      = true
  activity                     = true     # merges, mutations, replication and Distributed queues
  keeper                       = true     # the Keeper / ZooKeeper session
  top_queries                  = true     # the Queries section (runner context)
  cluster_fanout               = false    # clusterAllReplicas, needs GRANT REMOTE
  default_lookback_minutes     = 60
  max_lookback_days            = 30       # metric_log / asynchronous_metric_log
  query_log_max_lookback_hours = 168
  query_log_max_rows           = 50000000
  disk_growth_days             = 7
}

traces {
  enabled                  = false
  analytics                = false
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
  # Attributes shown as "key: value" chips in the trace header: from the root
  # span (span, then resource attributes), else the first span that has them.
  highlighted_attributes   = ["service.version", "deployment.environment.name", "deployment.environment", "http.route", "user.id"]
  # "Linked from (other traces)" scans the trace's window widened by this
  # many minutes on each side (1..1440).
  linked_from_margin_minutes = 60

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

# OpenTelemetry logs written by the OTel Collector ClickHouse exporter
# (otel_logs). Optional; disabled by default. ServiceName access control
# reuses traces.service_allowlist. See docs/logs.md.
logs {
  enabled              = false
  database             = "otel"
  table                = "otel_logs"
  max_lookback_minutes = 10080
  search_limit         = 200
  # Body search: "token" (hasToken, served by the exporter's tokenbf_v1/text
  # Body index), "substring" (case-insensitive scan) or "off".
  body_search          = "token"
  # Logs of one trace (trace detail page): at most trace_logs_limit records,
  # from the trace start - trace_margin_before_seconds to its end +
  # trace_margin_after_seconds.
  trace_logs_limit            = 1000
  trace_margin_before_seconds = 5
  trace_margin_after_seconds  = 30
}

# OpenTelemetry metrics written by the OTel Collector ClickHouse exporter
# (<table_prefix>_gauge, _sum, _histogram, _exponential_histogram, _summary).
# Optional; disabled by default. See docs/metrics.md.
metrics {
  enabled      = false
  database     = "otel"
  table_prefix = "otel_metrics"
}

# Server-side query library (folders, saved queries with descriptions), stored
# in one JSON file shared by every user. Optional; disabled by default: the
# browser then keeps saved queries in localStorage. The history of the runs is
# always the browser's, never shared. See docs/query-library.md.
query_library {
  enabled  = false
  # Required when enabled. The parent directory must exist; the file is
  # created (mode 0600) on the first write.
  file     = "/var/lib/chdash/query_library.json"
  # false: read-only library (no create/edit/move/delete/import).
  writable = false

  max_file_bytes  = 8388608 # writes beyond this answer 413
  max_query_bytes = 262144  # per saved query SQL
}

# MCP: an AI client reads ClickHouse data through ChDash, with access keys that
# have their own hosts, tools and data. Optional; disabled by default.
# Each host needs an mcp_uri (a separate, read-only ClickHouse user, never the
# runner or the system user). See docs/mcp.md.
mcp {
  enabled        = false
  # Keys made on the MCP page. The directory must exist; the file is created
  # (mode 0600) on the first write and holds hashes of secrets only.
  # storage_file = "/var/lib/chdash/mcp_keys.json"
  manage_from_ui = true  # false: the page is read-only

  # Global caps. A key can only lower max_rows and timeout_seconds.
  max_rows              = 1000
  max_result_bytes      = 1048576
  query_timeout_seconds = 30
  max_sql_bytes         = 65536
  max_memory_bytes      = 1073741824
  max_rows_to_read      = 0    # 0: no limit
  rate_limit_per_minute = 600  # per key; 0: no limit
  # Origins of browser clients (scheme://host[:port]). A request with an Origin
  # header that is not listed answers 403. A request without Origin is accepted.
  allowed_origins       = []

  # Keys of the configuration (read-only on the page). Exactly one of secret,
  # secret_file and secret_sha256; at least 24 bytes.
  # key {
  #   name            = "ci-bot"      # a-z 0-9 - _ ; the prefix ui_ is reserved
  #   description     = "Reads the logs for the CI"
  #   secret_file     = "/run/secrets/chdash-mcp-ci"
  #   hosts           = ["prod"]      # hosts that have an mcp_uri, or ["*"]
  #   tools           = ["list_databases", "list_tables", "describe_table", "query_table"]  # or ["*"]
  #   databases       = ["otel", "analytics.events"]  # db, db.table, * wildcard; ["*"] = all data
  #   max_rows        = 200           # lowers the global cap
  #   timeout_seconds = 10            # lowers the global cap
  #   expires_at      = "2027-01-01T00:00:00Z"
  #   enabled         = true
  # }
  # run_query and explain_query (free SQL) need databases = ["*"].
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

    # The MCP identity (docs/mcp.md): a separate, read-only ClickHouse user.
    # A host without mcp_uri is invisible to MCP. There is no fallback to the
    # runner or system credentials, nor to password_file; the password is in the URI.
    # mcp_uri = "clickhouse://chdash_mcp:<password>@clickhouse:9000"
  }
}
