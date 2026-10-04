# The System page switched off (system.enabled = false). Used by
# tests/backend-functional/test_system.py (SYSTEM_DISABLED_BASE_URL): the
# page and its routes (the v2.14.0 /api/explorer/ops/... aliases included)
# answer 404, /api/version reports the feature off and the former Explorer
# addresses open the Explorer instead of redirecting.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

system {
  enabled = false
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
