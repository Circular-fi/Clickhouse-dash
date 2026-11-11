# The approval of an action by a person (docs/access.md, "Approval of an action"), on the identity mode of the MCP endpoint. The fake PDP of the
# compose service approval_pdp plays the portal: it gates the actions that a test names and it serves the approval API. The host `local` has a
# write account (the tool run_write_query). backend-functional/test_approval.py uses it (APPROVAL_BASE_URL, APPROVAL_PDP_URL).
# POST /mcp needs the identity token; the subject of the token is the subject of each question to the PDP.
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
    url        = "http://approval_pdp:8181"
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
  enabled   = true
  auth_mode = "identity"
  usage {
    enabled = true
    dir     = "/tmp"
    instance = "approval-test"
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
    mcp_write_uri = "clickhouse://chdash_mcp_write@clickhouse:9000"
    mcp_write_password_file = "/run/secrets/chdash-test/pw-chdash_mcp_write"
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
