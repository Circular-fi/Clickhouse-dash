#!/bin/sh
set -eu

if [ -n "${CH_HOSTS_FILE:-}" ]; then
  if [ ! -f "$CH_HOSTS_FILE" ]; then
    echo "CH_HOSTS_FILE not found: $CH_HOSTS_FILE" >&2
    exit 2
  fi
  export CH_HOSTS="$(cat "$CH_HOSTS_FILE")"
fi

if [ -z "${CH_HOSTS:-}" ]; then
  echo "CH_HOSTS is required. Mount tests/config/CH_HOSTS.hcl or pass CH_HOSTS." >&2
  exit 2
fi

if [ "${1:-}" != "--health" ]; then
  /app/chdash --version >&2 || true
fi
exec /app/chdash "$@"
