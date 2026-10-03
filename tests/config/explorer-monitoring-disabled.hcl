# Explorer with the Monitoring tab switched off (explorer.monitoring.enabled =
# false). Used by tests/backend-functional/test_explorer_monitor.py
# (MONITORING_DISABLED_BASE_URL): the Monitoring routes answer 404 and
# /api/version reports the feature off; the operations endpoints keep their
# own switch.
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
    enabled = false
  }
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
