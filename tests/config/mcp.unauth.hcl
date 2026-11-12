# MCP with one config key and a small limit for the requests that have no valid key (contract 3.9): 3 each minute for one client address.
# Used by backend-functional/test_mcp_unauth.py (MCP_UNAUTH_BASE_URL).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled = true
  unauthenticated_rate_limit_per_minute = 3
  keys {
    mode = "static"
  }

  mcp_key "only-key" {
    token_file = "/run/secrets/chdash-test/mcp-key-only-key"
    tools      = ["list_hosts"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }
}
