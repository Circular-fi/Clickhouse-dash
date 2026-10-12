#!/bin/bash
# The ClickHouse users of the demo server: scratch users on the test stack (chdash-tests-clickhouse), limited to the
# databases that the video shows (chdash_ui: weather data; otel: traces, logs, metrics; system). `up` creates them,
# `down` drops them. No database is created.
CH="docker exec chdash-tests-clickhouse clickhouse-client -u test --password test"
case "$1" in
up)
  $CH -mn -q "
  CREATE USER IF NOT EXISTS dash_runner IDENTIFIED WITH plaintext_password BY 'video_runner_pw';
  CREATE USER IF NOT EXISTS dash_system IDENTIFIED WITH plaintext_password BY 'video_system_pw';
  CREATE USER IF NOT EXISTS dash_mcp IDENTIFIED WITH plaintext_password BY 'video_mcp_pw';
  GRANT SHOW, SELECT ON chdash_ui.* TO dash_runner;
  GRANT SHOW, SELECT ON otel.* TO dash_runner;
  GRANT SHOW, SELECT ON system.* TO dash_runner;
  GRANT SHOW, KILL QUERY, SYSTEM FLUSH LOGS ON *.* TO dash_system;
  GRANT SELECT ON otel.* TO dash_system;
  GRANT SELECT ON system.* TO dash_system;
  GRANT SELECT ON chdash_ui.* TO dash_mcp;
  GRANT SELECT ON otel.* TO dash_mcp;
  GRANT SELECT ON system.columns TO dash_mcp;
  GRANT SELECT ON system.databases TO dash_mcp;
  GRANT SELECT ON system.functions TO dash_mcp;
  GRANT SELECT ON system.numbers TO dash_mcp;
  GRANT SELECT ON system.one TO dash_mcp;
  GRANT SELECT ON system.parts TO dash_mcp;
  GRANT SELECT ON system.tables TO dash_mcp;
  GRANT SELECT ON system.data_skipping_indices TO dash_mcp;
  GRANT SELECT ON system.documentation TO dash_mcp;" && echo "users created";;
down)
  $CH -q "DROP USER IF EXISTS dash_runner, dash_system, dash_mcp" && echo "users dropped";;
*) echo "usage: $0 up|down"; exit 1;;
esac
