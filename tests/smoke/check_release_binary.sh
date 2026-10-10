#!/bin/sh
# Checks a Linux release binary before it is stripped (release.yaml and tests/smoke/Dockerfile.release):
#   - fully static: no ELF interpreter and no shared library (NEEDED);
#   - position independent (static-pie, ELF type DYN), so the kernel loads it at a random address;
#   - full RELRO (GNU_RELRO and BIND_NOW) and a stack that is not executable;
#   - built with the stack protector (__stack_chk_fail is linked in).
# Needs binutils (readelf, nm). Exit status 1 names the check that failed.
set -eu
bin="$1"
test -f "$bin" || { echo "ERROR: $bin: no such file" >&2; exit 1; }
status=0
if readelf -l "$bin" | grep -q INTERP; then
  echo "ERROR: $bin has an ELF interpreter: it is dynamically linked" >&2
  readelf -l "$bin" | sed -n '/INTERP/,+2p' >&2
  status=1
fi
if readelf -d "$bin" 2>/dev/null | grep -q '(NEEDED)'; then
  echo "ERROR: $bin needs shared libraries:" >&2
  readelf -d "$bin" | grep '(NEEDED)' >&2
  status=1
fi
if ! readelf -h "$bin" | grep -Eq 'Type:[[:space:]]+DYN'; then
  echo "ERROR: $bin is not position independent (expected ELF type DYN, static-pie):" >&2
  readelf -h "$bin" | grep 'Type:' >&2
  status=1
fi
if ! readelf -l "$bin" | grep -q GNU_RELRO || ! readelf -d "$bin" | grep -q BIND_NOW; then
  echo "ERROR: $bin has no full RELRO (GNU_RELRO segment and BIND_NOW)" >&2
  status=1
fi
if readelf -lW "$bin" | grep GNU_STACK | grep -q RWE; then
  echo "ERROR: $bin has an executable stack" >&2
  status=1
fi
if ! nm "$bin" 2>/dev/null | grep -q '__stack_chk_fail'; then
  echo "ERROR: $bin has no stack protector (__stack_chk_fail is not linked; is it stripped already?)" >&2
  status=1
fi
if [ "$status" -eq 0 ]; then
  echo "ok: $bin is static-pie with full RELRO, a stack that is not executable and the stack protector"
fi
exit "$status"
