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
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
