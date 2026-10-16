# The System Queries section's degraded states, on the test ClickHouse.
# Used by tests/backend-functional/test_system.py (SYSTEM_LIMITS_BASE_URL);
# its tests are skipped when it is not set. It also turns the Keeper off
# (system.keeper = false), Activity stays; the v2.14.0 block explorer.operations
# cannot be in the same file as a system block (tests/native/config_test.cpp).
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

system {
  keeper             = false
  query_log_max_rows = 1000
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
  host {
    name       = "nolog"
    runner_uri = "clickhouse://chdash_runner_nolog@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner_nolog"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
