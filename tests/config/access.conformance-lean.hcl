# The variant "lean" of tests/config/access.conformance.hcl (docs/conformance.md): no write account, no usage, a library that no person can change, and no signal. The
# actions that no tool can serve are not declared: query.run.write, mcp.usage.read and library.write. Profile: tests/conformance/profile-lean.json.
# ChDash under test of the ProcurAuth runner `access-conformance --role pep` (docs/conformance.md, tests/conformance/run.sh).
# The runner acts as the edge, the PDP and the client. The script mounts the work directory at /conformance: it holds the public keys
# of the test edge (identity-keys.json), the credential of the PDP (pdp-token) and the password of ClickHouse (ch-password).
# The cache of the decisions is off (pdp.cache_ttl = 0s), so each request of a case makes its own question. The values of the identity
# block (issuer, audience, header, max_age, clock_skew) are the values of tests/conformance/profile.json. MCP is on in the identity mode,
# so the runner can test the MCP binding: the identity token decides each request of POST /mcp.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 2000
}

access {
  mode = "authzen"
  identity {
    header           = "X-Identity-Token"
    issuer           = "https://edge.conformance.test"
    audience         = "chdash"
    public_keys_file = "/conformance/identity-keys.json"
    max_age          = "5m"
    clock_skew       = "30s"
  }
  pdp {
    url        = "http://conformance-pdp:8181"
    # The test network is closed: the PDP is in the same Docker network, without TLS.
    insecure_link = true
    token_file = "/conformance/pdp-token"
    timeout    = "2s"
    cache_ttl  = "0s"
  }
}

# One library that the service can show: GET /api/query-library is the use of the action library.read on the service itself.
query_library {
  enabled  = true
  file     = "/tmp/chdash-conformance-library.json"
  writable = false
}

# The identity mode of MCP (docs/mcp.md, "The identity mode"). The operation mcp_call_plain of the profile is the tool list_databases on
# the host conf: the action explorer.read on that host.
mcp {
  enabled   = true
  # The tests send many requests with no valid key from one address: the limit of contract 3.9 is tested in mcp.unauth.hcl.
  unauthenticated_rate_limit_per_minute = 0
  auth_mode = "identity"
  # No usage: mcp.usage.read is not declared.
}

# One host, with the runner account. GET /api/explorer/functions?host_id=conf is the use of explorer.read on this host.
clickhouse {
  host {
    name                 = "conf"
    runner_uri           = "clickhouse://chdash@clickhouse-conformance:9000"
    runner_password_file = "/conformance/ch-password"
    system_uri           = "clickhouse://chdash@clickhouse-conformance:9000"
    system_password_file = "/conformance/ch-password"
    mcp_uri              = "clickhouse://chdash@clickhouse-conformance:9000"
    mcp_password_file    = "/conformance/ch-password"
    # No write account: query.run.write is not declared (no tool serves it).
  }
}
