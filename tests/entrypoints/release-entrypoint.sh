#!/bin/sh
set -eu

select_highest_release() {
  release_dir="${1:-/releases}"
  python3 - "$release_dir" <<'PY'
import os
import re
import sys
from pathlib import Path

release_dir = Path(sys.argv[1])
extensions = (".tar.gz", ".tgz", ".tar", ".zip")

if not release_dir.is_dir():
    print(f"release directory not found: {release_dir}", file=sys.stderr)
    sys.exit(2)

candidates = [p for p in release_dir.iterdir() if p.is_file() and p.name.endswith(extensions)]
if not candidates:
    print(f"no release archive found in {release_dir}; add one or more .tar.gz/.tgz files", file=sys.stderr)
    sys.exit(2)

version_re = re.compile(r"(?<!\d)(\d+(?:[._-]\d+)+)(?!\d)")

def key(path: Path):
    name = path.name
    matches = version_re.findall(name)
    if matches:
        raw = matches[0]
        numbers = tuple(int(part) for part in re.split(r"[._-]", raw))
        return (1, numbers, name)
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0
    return (0, (int(mtime),), name)

print(str(sorted(candidates, key=key)[-1]))
PY
}

archive="${CHDASH_RELEASE_ARCHIVE:-}"
if [ -z "$archive" ]; then
  archive="$(select_highest_release "${CHDASH_RELEASE_DIR:-/releases}")"
fi

if [ ! -f "$archive" ]; then
  echo "release archive not found or not a file: $archive" >&2
  echo "Put versioned release archives in tests/releases/ or set CHDASH_RELEASE_ARCHIVE." >&2
  exit 2
fi

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

work="/tmp/chdash-release"
rm -rf "$work"
mkdir -p "$work"

echo "selected release archive: $archive" >&2
case "$archive" in
  *.tar.gz|*.tgz)
    tar -xzf "$archive" -C "$work"
    ;;
  *.tar)
    tar -xf "$archive" -C "$work"
    ;;
  *.zip)
    unzip -q "$archive" -d "$work"
    ;;
  *)
    cp "$archive" "$work/chdash"
    ;;
esac

bin=""
if [ -f "$work/chdash" ]; then
  bin="$work/chdash"
else
  bin="$(find "$work" -type f -name chdash 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$bin" ] || [ ! -f "$bin" ]; then
  echo "no chdash binary found in release archive: $archive" >&2
  find "$work" -maxdepth 3 -type f -print >&2 || true
  exit 2
fi

chmod +x "$bin"
echo "using binary: $bin" >&2
"$bin" --version >&2 || true

exec "$bin" "$@"
