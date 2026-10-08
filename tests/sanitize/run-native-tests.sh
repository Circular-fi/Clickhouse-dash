#!/bin/sh
# Runs the native unit tests of the sanitized build (docker target `native` of tests/Dockerfile.sanitize).
# A sanitizer finding stops the test and fails this script.
set -eu
status=0
for binary in /work/chdash_query_library_test /work/chdash_system_monitor_test; do
  echo "== $binary"
  if ! "$binary"; then
    echo "FAILED: $binary" >&2
    status=1
  fi
done
exit "$status"
