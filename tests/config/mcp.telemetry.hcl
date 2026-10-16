# MCP with the OTLP export of the server on (docs/server-telemetry.md): the SERVER span of each request, a child span for each
# ClickHouse statement of the call, and the call log as OTLP log records go to the fake receiver of the compose service otlp_receiver
# (tests/otel-fixture/otlp_receiver.py). The interval is short, so that a test reads the spans soon after its call.
# Used by tests/backend-functional/test_mcp_telemetry.py (TELEMETRY_BASE_URL, OTLP_RECEIVER_URL).
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

  usage {
    enabled  = false
    instance = "chdash-telemetry-test"
  }

  keys {
    mode = "static"
  }

  mcp_key "telemetry" {
    token_file = "/run/secrets/chdash-test/mcp-key-second-host"
    subject    = "telemetry-team"
    tools      = ["list_hosts", "list_databases", "run_query", "system_overview"]
    scope {
      hosts     = ["local"]
      databases = ["*"]
    }
  }
}

telemetry {
  enabled               = true
  otlp_endpoint         = "http://otlp_receiver:4318"
  service_name          = "chdash-telemetry-test"
  export_interval       = "200ms"
  export_timeout        = "5s"
  connect_timeout       = "1s"
  max_queue_size        = 4096
  max_export_batch_size = 256
  call_log              = true
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
