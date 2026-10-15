# MCP with manage_from_ui = false: the page is read-only, every key write answers 403
# manage_disabled, the file is still read. Mount a directory at /data that holds a copy of
# config/mcp.seed.json as mcp_keys.json. Used by test_mcp.py (MCP_RO_BASE_URL).
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
    secret    = "cf9eead0-0000-4000-8000-00000000000a"
    hosts     = ["local"]
    tools     = ["list_hosts", "list_databases", "mcp_analysis_all_usage"]
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
