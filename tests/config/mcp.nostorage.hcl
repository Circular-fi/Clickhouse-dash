# MCP with config keys only: no storage_file, so a key cannot be made from the page
# (409 storage_not_configured). The key travels in X-ChDash-Key (mcp.auth_header), not in Authorization.
# No usage block: the usage of the keys is off (nothing is counted, its routes answer 404 not_enabled, and the tools of the usage are not
# offered: only-key names mcp_analysis_all_usage, which is then `not_enabled`).
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

  mcp_key "only-key" {
    token_file = "/run/secrets/chdash-test/mcp-key-only-key"
    tools      = ["list_hosts", "list_databases", "mcp_analysis_all_usage"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }
}

clickhouse {
  host {
    name       = "local"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp"
  }
}

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
