# Kept for compatibility with older commands. The default CH_HOSTS.hcl now already uses
# the compose-managed ClickHouse service at clickhouse:9000.
health {
  interval_ms = 1000
  timeout_ms  = 1000
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://test:test@clickhouse:9000"
    system_uri = "clickhouse://test:test@clickhouse:9000"
  }
}
