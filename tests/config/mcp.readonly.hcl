# MCP with manage_from_ui = false, the older form of keys.mode = "static": the page is read-only, every key write answers 403
# manage_disabled, and the keys of the file do not apply. The key block is the older form of mcp_key. ChDash reads the two older
# forms for one release, with a warning. Mount a directory at /data that holds a copy of config/mcp.seed.json as mcp_keys.json.
# Used by test_mcp.py (MCP_RO_BASE_URL).
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled        = true
  storage_file   = "/data/mcp_keys.json"
  manage_from_ui = false

  # The usage is read on an instance whose keys are read-only too: a count is not a change of the keys. all_keys is off (the default):
  # cfg-reader names mcp_analysis_all_usage and still does not have it (`not_enabled`).
  usage {
    enabled  = true
    dir      = "/data"
    instance = "chdash-mcp-ro"
  }

  key {
    name      = "cfg-reader"
    secret_file = "/run/secrets/chdash-test/mcp-key-cfg-reader"
    hosts     = ["local"]
    tools     = ["list_hosts", "list_databases", "mcp_analysis_all_usage"]
    databases = ["*"]
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
