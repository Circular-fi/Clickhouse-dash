# Optional config if you explicitly want to benchmark against a ClickHouse server
# running on the Docker host instead of the compose-managed clickhouse service.
health {
  interval_ms = 1000
  timeout_ms  = 1000
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://test:test@host.docker.internal:9000"
    system_uri = "clickhouse://test:test@host.docker.internal:9000"
  }
}
