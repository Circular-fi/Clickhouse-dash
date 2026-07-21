# Default benchmark config: ClickHouse is launched by docker-compose.yml.
# From the dashboard containers, the internal TCP endpoint is clickhouse:9000.
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

  # Optional: add a remote active instance here, then launch with:
  # BENCH_HOST_IDS="local,active" docker compose up -d --build
  # host {
  #   name       = "active"
  #   runner_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
  #   system_uri = "clickhouse://user:password@clickhouse-active.example.com:9000"
  # }
}
