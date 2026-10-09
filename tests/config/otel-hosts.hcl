# The OpenTelemetry tables per host: two hosts of the same ClickHouse server, the second with other tables (empty copies of
# tests/clickhouse-init/02-frontend-fixtures.sql, database otel_alt), no traces, a third without logs, and a fourth whose logs are in a database that the system user may not read. Used by
# tests/backend-functional/test_otel_hosts.py (OTEL_HOSTS_BASE_URL); its tests are skipped without it.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

observability {
  service_allowlist = ["*"]

  traces {
    enabled              = true
    max_lookback_minutes = 100000
  }
  logs {
    enabled              = true
    max_lookback_minutes = 100000
  }
  metrics {
    enabled = true
  }
}

clickhouse {
  host {
    name       = "main"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  host {
    name       = "alt"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    observability {
      traces  { enabled = false }
      logs    { database = "otel_alt"  table = "logs_copy" }
      metrics { database = "otel_alt"  table_prefix = "metrics" }
    }
  }
  host {
    name       = "nologs"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    observability {
      logs { enabled = false }
    }
  }
  host {
    name       = "denied"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    observability {
      traces { enabled = false }
      logs   { database = "not_granted_db"  table = "logs" }
      metrics { enabled = false }
    }
  }
}
