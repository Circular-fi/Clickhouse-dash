#!/bin/sh
set -eu

config_file="${CHDASH_CONFIG_FILE:-/config/chdash.hcl}"
if [ ! -f "$config_file" ]; then
  echo "ClickHouse Dash HCL config not found: $config_file" >&2
  exit 2
fi

if [ "${1:-}" != "--health" ]; then
  /app/chdash --version >&2 || true
fi
exec /app/chdash --config "$config_file" "$@"
