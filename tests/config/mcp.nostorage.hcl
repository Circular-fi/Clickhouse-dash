# MCP with config keys only: no storage_file, so a key cannot be made from the page
# (409 storage_not_configured). The key travels in X-ChDash-Key (mcp.auth_header), not in Authorization.
# Used by test_mcp.py (MCP_NOSTORAGE_BASE_URL).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled     = true
  auth_header = "X-ChDash-Key"

  key {
    name      = "only-key"
    secret    = "0a17e100-0000-4000-8000-000000000008"
    hosts     = ["local"]
    tools     = ["list_hosts", "list_databases"]
    databases = ["*"]
  }
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner:runner_test@clickhouse:9000"
    system_uri = "clickhouse://chdash_system:system_test@clickhouse:9000"
    mcp_uri    = "clickhouse://chdash_mcp:mcp_test@clickhouse:9000"
  }
}
