# Source-test configuration. The second host deliberately has valid runner
# credentials and invalid system credentials so /api/meta partial responses and
# runner-based health checks are covered by integration tests.
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

  host {
    name       = "meta-partial"
    runner_uri = "clickhouse://test:test@clickhouse:9000"
    system_uri = "clickhouse://test:invalid-system-password@clickhouse:9000"
  }
}
