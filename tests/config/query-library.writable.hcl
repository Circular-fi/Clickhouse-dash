# Query library, editable, history on the server. Used by
# tests/backend-functional/test_query_library.py (QUERY_LIBRARY_BASE_URL).
# Mount a writable, empty directory at /data; the limits are deliberately
# small so the size and history-cap tests need few requests.
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
  writable = true

  history {
    store       = "server"
    max_entries = 25
  }

  max_file_bytes  = 131072
  max_query_bytes = 16384
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
  }
}
