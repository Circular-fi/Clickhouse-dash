# Kept for compatibility with older commands. The default CH_HOSTS.hcl now already uses
# the compose-managed ClickHouse service at clickhouse:9000.
health {
  interval_ms = 1000
  timeout_ms  = 1000
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
