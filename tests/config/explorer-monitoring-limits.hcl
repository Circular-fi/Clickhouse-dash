# The Monitoring Queries section's degraded states, on the test ClickHouse.
# Used by tests/backend-functional/test_explorer_monitor.py
# (MONITORING_LIMITS_BASE_URL); its tests are skipped when it is not set.
#   local  query_log_max_rows = 1000: every Queries read stops at the cap
#          (window_too_large, with a suggested narrower window);
#   nolog  chdash_runner_nolog, which may read everything but
#          system.query_log (not_granted, with the GRANT to run).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

explorer {
  monitoring {
    query_log_max_rows = 1000
  }
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "nolog"
    runner_uri = "clickhouse://chdash_runner_nolog:runner_nolog_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
