# The access of humans with the Resource Search of the PDP (docs/access.md, "Resource Search"): access.pdp.search = true, and a fake PDP
# whose metadata announces search_resource_endpoint (the compose service access_pdp_search). The databases that a person may see come from
# one search for each action, and not from one evaluation for each database. Two hosts on the same ClickHouse (local and other).
# Used by tests/backend-functional/test_access_search.py (ACCESS_SEARCH_BASE_URL, ACCESS_SEARCH_PDP_URL).
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
    url        = "http://access_pdp_search:8181"
    # The test network is closed: the PDP is in the same Docker network, without TLS.
    insecure_link = true
    token_file = "/run/secrets/chdash-test/access-pdp-token"
    timeout    = "500ms"
    cache_ttl  = "1s"
    search     = true
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
