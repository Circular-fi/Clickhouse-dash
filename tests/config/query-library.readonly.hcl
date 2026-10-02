# Query library, read-only (writable = false), history on the server. Used by
# tests/backend-functional/test_query_library.py (QUERY_LIBRARY_RO_BASE_URL).
# Mount a writable directory at /data (history appends are still recorded);
# it may hold a library file, e.g. a copy of query-library.seed.json.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

query_library {
  enabled  = true
  file     = "/data/query_library.json"
  writable = false

  history {
    store       = "server"
    max_entries = 25
  }
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
  # A second host on the same server: the library is per host.
  host {
    name       = "other"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
