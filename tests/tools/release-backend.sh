#!/bin/sh
# Run the backend tests against the release binary: tests/smoke/Dockerfile.release, target `runtime` (Zig,
# musl, static-pie, the hardening flags, the files embedded, in a FROM scratch container). The test image
# is a GCC build that serves its files from disk: this run tests the binary that ships. Docker only.
#
#   tests/tools/release-backend.sh
#
# The test ClickHouse stack must run (docker compose -f tests/docker-compose.yml --profile otel up -d
# clickhouse clickhouse_replica otel_fixture). The script fails when a test fails or when the server
# stopped before the end of the tests.
#
# Environment (all optional):
#   CHDASH_RELEASE_NETWORK    Docker network of the test stack      (chdash-tests_default)
#   CHDASH_RELEASE_PREFIX     name of the image and the container    (chdash-release)
#   CHDASH_RELEASE_LOGDIR     where the server log is kept           (/tmp/<prefix>-logs)
#   CHDASH_FIXTURE_RESET      auto | never | always                  (auto; use never on a busy stack)
#   CHDASH_TESTS_IMAGE        image with pytest                      (chdash-tests-all:local)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
network="${CHDASH_RELEASE_NETWORK:-chdash-tests_default}"
prefix="${CHDASH_RELEASE_PREFIX:-chdash-release}"
tests_image="${CHDASH_TESTS_IMAGE:-chdash-tests-all:local}"
logdir="${CHDASH_RELEASE_LOGDIR:-${TMPDIR:-/tmp}/$prefix-logs}"
server="$prefix-server"
mkdir -p "$logdir"

echo "== release binary (tests/smoke/Dockerfile.release, target runtime)"
docker build -q -f "$repo/tests/smoke/Dockerfile.release" --target runtime -t "$prefix:local" "$repo" >/dev/null
if ! docker image inspect "$tests_image" >/dev/null 2>&1; then
  docker build -q -f "$repo/tests/Dockerfile.tests" -t "$tests_image" "$repo/tests" >/dev/null
fi
docker rm -f "$server" >/dev/null 2>&1 || true
docker run -d --name "$server" --network "$network" \
  -v "$repo/tests/config/CH_HOSTS.local.hcl:/config/chdash.hcl:ro" "$prefix:local" >/dev/null

echo "== backend-functional and the API checks on the release binary"
status=0
docker run --rm --network "$network" -v "$repo:/repo:ro" -w /repo/tests \
  -e "API_BASE_URL=http://$server:8080" -e API_HEALTH_PATH=/api/health \
  -e CLICKHOUSE_URL=http://clickhouse:8123 -e CLICKHOUSE_USER=test -e CLICKHOUSE_PASSWORD=test \
  -e "CHDASH_FIXTURE_RESET=${CHDASH_FIXTURE_RESET:-auto}" -e TEST_REPOSITORY_ROOT=/repo -e PYTHONDONTWRITEBYTECODE=1 \
  "$tests_image" sh -c '
    python3 - "$API_BASE_URL" <<"PY" || exit 1
import sys, time, urllib.request
# The scratch image has no health check: wait (60 s at most) for the server to answer.
for _ in range(60):
    try:
        with urllib.request.urlopen(sys.argv[1] + "/api/version", timeout=2) as response:
            if response.status == 200:
                sys.exit(0)
    except OSError:
        time.sleep(1)
sys.exit("the release binary did not answer in 60 s")
PY
    python3 -m pytest -q -p no:cacheprovider api/format/check_format.py api/query_types/check_query_types.py backend-functional
  ' || status=$?

running="$(docker inspect -f '{{.State.Running}}' "$server")"
code="$(docker inspect -f '{{.State.ExitCode}}' "$server")"
docker logs "$server" > "$logdir/server.log" 2>&1 || true
docker rm -f "$server" >/dev/null 2>&1 || true
if [ "$running" != "true" ]; then
  echo "the release binary stopped during the tests with exit code $code (log: $logdir/server.log)" >&2
  status=1
fi
exit "$status"
