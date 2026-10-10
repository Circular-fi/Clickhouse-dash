#!/bin/sh
# Build the libFuzzer targets of tests/fuzz (clang, ASan + UBSan; tests/Dockerfile.sanitize, stage `fuzz`) and run
# each one for a given time. The host needs Docker only.
#
#   tests/tools/fuzz.sh                    every target, 60 s each
#   tests/tools/fuzz.sh 300                every target, 300 s each
#   tests/tools/fuzz.sh 600 format hcl     two targets, 600 s each
#   tests/tools/fuzz.sh list               the names of the targets
#
# Several targets run at the same time (CHDASH_FUZZ_JOBS, default: the CPUs of the container). The corpus of each
# target and its findings (crash-*, leak-*, timeout-*, oom-*, with fuzz.log) are kept in CHDASH_FUZZ_OUT
# (default /tmp/chdash-fuzz/<target>); a second run starts from the corpus of the first. Exit status 1 when a
# target found something.
#
# Reproduce a finding:  docker run --rm -v "$PWD/tests/fuzz:/in:ro" --entrypoint /work/fuzz/chdash_fuzz_<target> \
#                         chdash-fuzz:local /in/<file>
#   (copy the crash-* file into a directory you mount; the binary runs one input and prints the report).
#
# Environment (all optional): CHDASH_FUZZ_OUT, CHDASH_FUZZ_JOBS, CHDASH_FUZZ_IMAGE (chdash-fuzz:local).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${CHDASH_FUZZ_IMAGE:-chdash-fuzz:local}"
out="${CHDASH_FUZZ_OUT:-${TMPDIR:-/tmp}/chdash-fuzz}"

docker build -q -f "$repo/tests/Dockerfile.sanitize" --target fuzz -t "$image" "$repo" >/dev/null

if [ "${1:-}" = "list" ]; then
  docker run --rm --entrypoint sh "$image" -c 'ls /work/fuzz | sed "s/^chdash_fuzz_//"'
  exit 0
fi
seconds="${1:-60}"
[ "$#" -gt 0 ] && shift
mkdir -p "$out"
chmod a+rwx "$out" 2>/dev/null || true
jobs_env=""
if [ -n "${CHDASH_FUZZ_JOBS:-}" ]; then jobs_env="-e CHDASH_FUZZ_JOBS=$CHDASH_FUZZ_JOBS"; fi
# shellcheck disable=SC2086
docker run --rm --user "$(id -u):$(id -g)" -v "$out:/out" $jobs_env "$image" "$seconds" "$@"
