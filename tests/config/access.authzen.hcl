# The access of humans in the authzen mode (docs/access.md, MCP server contract section 11): each request of the pages and of the
# API needs an identity token signed by one of the two test keys (secrets/access-identity-keys.pem: Ed25519 and P-256), and the
# fake PDP of the compose service access_pdp (tests/otel-fixture/fake_pdp.py) decides each action. The cache of the decisions is
# short, so that a change of the answers of the PDP applies soon. The CLIENT spans of the calls to the PDP go to a fake OTLP
# receiver of their own (access_otlp_receiver). The MCP endpoint keeps its key: no identity token.
# Used by tests/backend-functional/test_access.py (ACCESS_BASE_URL, ACCESS_PDP_URL, ACCESS_OTLP_URL).
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
    token_file = "/run/secrets/chdash-test/access-pdp-token"
    timeout    = "500ms"
    cache_ttl  = "1s"
  }
}

mcp {
  enabled = true
  # The page makes keys too: test_access.py checks that a key never has more than its creator.
  storage_file = "/tmp/chdash-access-mcp-keys.json"
  keys {
    mode = "hybrid"
  }
  mcp_key "access" {
    token_file = "/run/secrets/chdash-test/mcp-key-second-host"
    subject    = "access-team"
    tools      = ["list_hosts", "list_databases"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }
}

telemetry {
  enabled         = true
  otlp_endpoint   = "http://access_otlp_receiver:4318"
  service_name    = "chdash-access-test"
  export_interval = "200ms"
  call_log        = false
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
