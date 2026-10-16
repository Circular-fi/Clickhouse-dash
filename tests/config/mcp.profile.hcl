# MCP users whose settings profile sets readonly (users in tests/clickhouse-init/01-chdash-users.sql). Used by
# tests/backend-functional/test_mcp.py (MCP_PROFILE_BASE_URL). One host for each profile; a key reads one host.
#   ro2     readonly = 2, three databases (chdash_ui, otel, otel_alt) and a fourth that it may not read (chdash_denied); the
#           key is wide (run_query needs it), so what the user cannot read is ClickHouse's to refuse;
#   ro2cap  readonly = 2 with limits of its own (max_result_rows = 7, max_execution_time = 4): the profile wins over the
#           configuration, and a key that is stricter than the profile still lowers it;
#   ro1     readonly = 1: ClickHouse refuses every setting, so ChDash sends none.
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}

health {
  interval_ms = 1000
  timeout_ms  = 1000
}

mcp {
  enabled      = true
  storage_file = "/data/mcp_keys.json"

  max_rows              = 100
  max_result_bytes      = 20000
  query_timeout_seconds = 5
  max_sql_bytes         = 2048
  max_memory_bytes      = 536870912
  rate_limit_per_minute = 600

  mcp_key "ro2" {
    token_file = "/run/secrets/chdash-test/mcp-key-ro2"
    tools      = ["*"]
    scope {
      hosts     = ["ro2"]
      databases = ["*"]
    }
  }
  mcp_key "ro2cap" {
    token_file = "/run/secrets/chdash-test/mcp-key-ro2cap"
    tools      = ["*"]
    scope {
      hosts     = ["ro2cap"]
      databases = ["*"]
    }
  }
  mcp_key "ro2cap-low" {
    token_file = "/run/secrets/chdash-test/mcp-key-ro2cap-low"
    tools      = ["*"]
    scope {
      hosts     = ["ro2cap"]
      databases = ["*"]
    }
    limits {
      max_rows = 3
    }
  }
  mcp_key "ro1" {
    token_file = "/run/secrets/chdash-test/mcp-key-ro1"
    tools      = ["*"]
    scope {
      hosts     = ["ro1"]
      databases = ["*"]
    }
  }
}

clickhouse {
  host {
    name       = "ro2"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp_ro2@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp_ro2"
  }
  host {
    name       = "ro2cap"
    runner_uri = "clickhouse://chdash_runner@clickhouse:9000"
    runner_password_file = "/run/secrets/chdash-test/pw-chdash_runner"
    system_uri = "clickhouse://chdash_system@clickhouse:9000"
    system_password_file = "/run/secrets/chdash-test/pw-chdash_system"
    mcp_uri    = "clickhouse://chdash_mcp_ro2cap@clickhouse:9000"
    mcp_password_file = "/run/secrets/chdash-test/pw-chdash_mcp_ro2cap"
  }
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

# The access of humans (docs/access.md): no gateway in front of this server, so no check.
access {
  mode = "open"
}
