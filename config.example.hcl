# Complete file configuration. Start with:
#   chdash --config /path/to/config.hcl
#
# When --config is present, none of the application environment variables are
# read. Omitted attributes use the defaults shown below.

server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

query {
  result_preview_row_limit = 10000
  max_sql_bytes            = 4194304

  describe_mode              = "auto"
  final_stats_from_query_log = false
  final_stats_flush_logs     = false
  sample_interval_ms         = 40

  result_batch_rows = 1000
  result_batch_bytes = 262144
  sse_batch_events  = 8
  sse_batch_bytes   = 262144
  sse_queue_max_bytes = 8388608

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

health {
  interval_ms = 5000
  timeout_ms  = 800
}

clickhouse {
  host {
    name       = "local"
    label      = "ClickHouse local"
    runner_uri = "clickhouse://internalsvc@clickhouse:9000"
    system_uri = "clickhouse://internalsvc@clickhouse:9000"

    # Used for both URIs. The password is read by chdash and never copied into
    # the HCL or the process environment. Per-role overrides are also accepted:
    # runner_password_file and system_password_file.
    password_file = "/run/secrets/clickhouse_password"
  }
}
