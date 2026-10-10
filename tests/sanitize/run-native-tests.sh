#!/bin/sh
# Runs the native unit tests of the sanitized build (docker target `native` of tests/Dockerfile.sanitize).
# A sanitizer finding stops the test and fails this script. chdash_ch_query_test also runs its server cases
# when CHDASH_TEST_CLICKHOUSE_URI names a ClickHouse server (tests/tools/sanitize.sh sets it on the test network).
set -eu
status=0
for binary in /work/chdash_query_library_test /work/chdash_system_monitor_test /work/chdash_mcp_test /work/chdash_result_path_test /work/chdash_format_depth_test /work/chdash_ch_query_test /work/chdash_cache_acl_test /work/chdash_sql_test; do
  echo "== $binary"
  if ! "$binary"; then
    echo "FAILED: $binary" >&2
    status=1
  fi
done
exit "$status"
