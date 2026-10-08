#!/bin/sh
# Build the server and the native tests with AddressSanitizer + UndefinedBehaviorSanitizer and run
# the tests on them. The host needs Docker only.
#
#   tests/tools/sanitize.sh native     build the native unit tests and run them
#   tests/tools/sanitize.sh server     build the sanitized server image only
#   tests/tools/sanitize.sh backend    start the sanitized server next to the test ClickHouse and run
#                                      the format and type checks of tests/api, tests/backend-functional
#                                      and tests/harness against it
#   tests/tools/sanitize.sh frontend   drive the sanitized server with a Playwright subset
#   tests/tools/sanitize.sh all        native, backend, frontend (default)
#
# The test ClickHouse stack must run (docker compose -f tests/docker-compose.yml --profile otel up -d
# clickhouse clickhouse_replica otel_fixture). A finding of a sanitizer stops the server (exit code 23 or 24),
# is written to its log, and fails this script.
#
# Environment (all optional):
#   CHDASH_SANITIZE_NETWORK   Docker network of the test stack      (chdash-tests_default)
#   CHDASH_SANITIZE_PREFIX    name of the image and the containers   (chdash-sanitize)
#   CHDASH_SANITIZE_LOGDIR    where the server log is kept           (/tmp/<prefix>-logs)
#   CHDASH_SANITIZE_PORT      host port that publishes the server    (not published)
#   CHDASH_SANITIZE_SPECS     Playwright spec list for `frontend`    (see below)
#   CHDASH_FIXTURE_RESET      auto | never | always                  (auto; use never on a busy stack)
#   CHDASH_TESTS_IMAGE        image with pytest and Playwright      (chdash-tests-all:local)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
network="${CHDASH_SANITIZE_NETWORK:-chdash-tests_default}"
prefix="${CHDASH_SANITIZE_PREFIX:-chdash-sanitize}"
tests_image="${CHDASH_TESTS_IMAGE:-chdash-tests-all:local}"
server="$prefix-server"
reset_mode="${CHDASH_FIXTURE_RESET:-auto}"
# A few specs that cover many routes: every page shell, the Explorer, the library and the traces.
specs="${CHDASH_SANITIZE_SPECS:-specs/page-per-view.spec.js specs/query-library.spec.js specs/observability.spec.js specs/system.spec.js specs/explorer-nav.spec.js}"
mode="${1:-all}"
logdir="${CHDASH_SANITIZE_LOGDIR:-${TMPDIR:-/tmp}/$prefix-logs}"
mkdir -p "$logdir"

build_target() { # <target> <tag>
  docker build -q -f "$repo/tests/Dockerfile.sanitize" --target "$1" -t "$2" "$repo" >/dev/null
}

ensure_tests_image() {
  if ! docker image inspect "$tests_image" >/dev/null 2>&1; then
    docker build -q -f "$repo/tests/Dockerfile.tests" -t "$tests_image" "$repo/tests" >/dev/null
  fi
}

sanitizer_findings() { # <log file>: print the lines of a sanitizer finding, return 0 when there is one
  grep -E "ERROR: (AddressSanitizer|LeakSanitizer)|runtime error:|SUMMARY: (Address|Undefined|Leak)Sanitizer" "$1"
}

run_native() {
  echo "== native unit tests (ASan + UBSan)"
  build_target native "$prefix-native:local"
  docker run --rm "$prefix-native:local"
}

start_server() {
  echo "== sanitized server"
  build_target sanitized "$prefix:local"
  docker rm -f "$server" >/dev/null 2>&1 || true
  publish=""
  if [ -n "${CHDASH_SANITIZE_PORT:-}" ]; then publish="-p $CHDASH_SANITIZE_PORT:8080"; fi
  # shellcheck disable=SC2086
  docker run -d --name "$server" --network "$network" $publish \
    -e CHDASH_CONFIG_FILE=/config/chdash.hcl \
    -v "$repo/tests/config/CH_HOSTS.local.hcl:/config/chdash.hcl:ro" \
    "$prefix:local" >/dev/null
  i=0
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$server")" = "healthy" ]; do
    i=$((i + 1))
    if [ "$i" -gt 90 ] || [ "$(docker inspect -f '{{.State.Running}}' "$server")" != "true" ]; then
      docker logs "$server" 2>&1 | tail -40
      echo "the sanitized server did not become healthy" >&2
      docker rm -f "$server" >/dev/null 2>&1 || true
      exit 1
    fi
    sleep 2
  done
}

# Stop the server with SIGTERM (it ends cleanly, LeakSanitizer reports), then judge its log and exit code.
stop_server() { # <test status>
  test_status="$1"
  docker stop -t 60 "$server" >/dev/null
  code="$(docker inspect -f '{{.State.ExitCode}}' "$server")"
  docker logs "$server" > "$logdir/server.log" 2>&1 || true
  docker rm -f "$server" >/dev/null 2>&1 || true
  status="$test_status"
  if sanitizer_findings "$logdir/server.log" > "$logdir/findings.log"; then
    echo "SANITIZER FINDINGS in the server log (full log: $logdir/server.log):" >&2
    head -60 "$logdir/findings.log" >&2
    status=1
  fi
  if [ "$code" != "0" ]; then
    echo "the sanitized server exited with code $code (0 expected; a sanitizer finding ends the process with 23 or 24)" >&2
    status=1
  fi
  return "$status"
}

run_backend() {
  ensure_tests_image
  start_server
  echo "== backend-functional + harness on the sanitized server"
  test_status=0
  docker run --rm --network "$network" \
    -v "$repo:/repo:ro" -w /repo/tests \
    -e "API_BASE_URL=http://$server:8080" -e API_HEALTH_PATH=/api/health \
    -e CLICKHOUSE_URL=http://clickhouse:8123 -e CLICKHOUSE_USER=test -e CLICKHOUSE_PASSWORD=test \
    -e "CHDASH_FIXTURE_RESET=$reset_mode" -e TEST_REPOSITORY_ROOT=/repo -e PYTHONDONTWRITEBYTECODE=1 \
    "$tests_image" python3 -m pytest -q -p no:cacheprovider \
      api/format/check_format.py api/query_types/check_query_types.py \
      backend-functional /repo/tests/harness || test_status=$?
  stop_server "$test_status"
}

run_frontend() {
  ensure_tests_image
  start_server
  echo "== Playwright subset on the sanitized server: $specs"
  test_status=0
  art="$logdir/playwright"
  rm -rf "$art" 2>/dev/null || true
  mkdir -p "$art"
  docker run --rm --network "$network" --ipc host --shm-size 1gb -w /work/frontend \
    -e "FRONTEND_BASE_URL=http://$server:8080" -e "API_BASE_URL=http://$server:8080" \
    -e CLICKHOUSE_URL=http://clickhouse:8123 -e CLICKHOUSE_USER=test -e CLICKHOUSE_PASSWORD=test \
    -e FRONTEND_ARTIFACTS_DIR=/artifacts/fe \
    -v "$repo/tests/frontend/specs:/work/frontend/specs:ro" \
    -v "$repo/tests/frontend/helpers:/work/frontend/helpers:ro" \
    -v "$repo/tests/frontend/model:/work/frontend/model:ro" \
    -v "$art:/artifacts" \
    "$tests_image" sh -c "npx playwright test $specs --project=desktop-1440 --reporter=line; code=\$?; chmod -R a+rwX /artifacts; exit \$code" \
    || test_status=$?
  stop_server "$test_status"
}

case "$mode" in
  native) run_native ;;
  server) build_target sanitized "$prefix:local" ;;
  backend) run_backend ;;
  frontend) run_frontend ;;
  all) run_native; run_backend; run_frontend ;;
  *) echo "usage: $0 native|server|backend|frontend|all" >&2; exit 2 ;;
esac
