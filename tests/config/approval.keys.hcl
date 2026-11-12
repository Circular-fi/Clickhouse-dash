# The approval of an action by a person for the MCP keys of the page (docs/access.md, "Approval of an action"; docs/mcp.md, "Keys and the access of
# humans"). The mode keys: a key of the page has a creator, and the creator is the subject of the PDP. The fake PDP of the compose service
# approval_keys_pdp plays the portal. The key of the configuration has no creator and no PDP question: it stays outside the approval.
# backend-functional/test_approval_keys.py uses it (APPROVAL_KEYS_BASE_URL, APPROVAL_KEYS_PDP_URL).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

access {
  mode = "authzen"
  identity {
    issuer           = "https://access.test"
    audience         = "db"
    public_keys_file = "/run/secrets/chdash-test/access-identity-keys.pem"
    max_age          = "5m"
  }
  pdp {
    url        = "http://approval_keys_pdp:8181"
    # The test network is closed: the PDP is in the same Docker network, without TLS.
    insecure_link = true
    token_file = "/run/secrets/chdash-test/access-pdp-token"
    timeout    = "500ms"
    cache_ttl  = "1s"
  }
  approval {
    wait              = "3s"
    max_command_bytes = 4096
  }
}

mcp {
  enabled = true
  # The tests send many requests with no valid key from one address: the limit of contract 3.9 is tested in mcp.unauth.hcl.
  unauthenticated_rate_limit_per_minute = 0
  storage_file = "/tmp/chdash-approval-keys-mcp-keys.json"
  keys {
    mode = "hybrid"
  }
  mcp_key "standalone" {
    token_file = "/run/secrets/chdash-test/mcp-key-second-host"
    subject    = "standalone-team"
    tools      = ["list_hosts", "list_databases", "run_query"]
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
  host {
    name       = "other"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp"
  }
}
