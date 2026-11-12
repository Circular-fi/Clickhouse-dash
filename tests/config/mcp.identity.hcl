# The identity mode of the MCP endpoint (docs/mcp.md, "The identity mode"): POST /mcp needs the identity token (the header of the pages),
# the subject of the token is the subject of each question to the PDP, and the keys of ChDash do not exist. The fake PDP of the compose
# service access_pdp (tests/otel-fixture/fake_pdp.py) decides each request. The cache of the decisions is short.
# Used by tests/backend-functional/test_mcp_identity.py (MCP_IDENTITY_BASE_URL, ACCESS_PDP_URL).
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
    url        = "http://access_pdp:8181"
    # The test network is closed: the PDP is in the same Docker network, without TLS.
    insecure_link = true
    token_file = "/run/secrets/chdash-test/access-pdp-token"
    timeout    = "500ms"
    cache_ttl  = "1s"
  }
}

mcp {
  enabled   = true
  # The tests send many requests with no valid key from one address: the limit of contract 3.9 is tested in mcp.unauth.hcl.
  unauthenticated_rate_limit_per_minute = 0
  auth_mode = "identity"
  usage {
    enabled = true
    dir     = "/tmp"
    instance = "identity-test"
    # all_keys is on: the tool mcp_analysis_all_usage serves mcp.usage.read, so the action is published (docs/access.md, "Actions and tools").
    all_keys = true
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
  # The settings profile of this MCP user has readonly = 1: ClickHouse takes no setting, so the ceilings of a grant are counted by ChDash itself.
  host {
    name       = "ro1"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp_ro1@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp_ro1"
  }
}
