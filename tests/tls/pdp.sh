#!/usr/bin/env bash
# End-to-end test of the TLS client of ChDash for the PDP (an https access.pdp.url). It uses only Docker and the files of the repository.
# It does not change the host. Usage: tests/tls/pdp.sh /path/to/chdash [PDP_IMAGE]
#
# The script makes a CA and a certificate for the name "pdp-tls", starts the fake AuthZEN PDP of the tests (tests/otel-fixture/fake_pdp.py)
# with TLS, and starts the given chdash binary once for each case. A case sends one request with a valid identity token to GET /api/version,
# which asks the PDP, and checks the status and the logs.
#   1. https, ca_file = the CA                    200 (the chain and the name are verified, the PDP sees the token, the metadata is read)
#   2. https, ca_file = another CA                503 (the chain is not trusted)
#   3. https, the name pdp-alias                  503 (the name is not in the certificate)
#   4. https, no ca_file                          503 (the store of the system does not know the CA)
#   5. https, verify = false                      200 (and a warning at start)
#   6. http to the https port                     503 (the PDP does not answer HTTP; fail closed)
#   7. a metadata document of another PDP         the start stops with a message that names access.pdp.url
#   8. ca_file or verify with an http URL         the start stops with a message that names the two keys
#   9. the PDP is down at the start               the server starts, GET /api/version gives 503, and then 200 when the PDP starts
#  10. procurauth_usage_max_seconds above access.pdp.usage_max_seconds: the start stops with a message that names the key, the value and
#      the limit (nothing is lowered to fit); at the limit, the server starts and answers 200
# The binary needs the TLS client (CHDASH_TLS): a binary built without it fails the case 1 and the test says so.
set -euo pipefail

[[ $# -ge 1 && $# -le 2 ]] || { echo "usage: $0 /path/to/chdash [PDP_IMAGE]" >&2; exit 2; }
bin="$(realpath "$1")"
[[ -x "$bin" ]] || { echo "$bin is not an executable file" >&2; exit 2; }
pdp_image="${2:-${PDP_IMAGE:-python:3.13-alpine}}"
runner_image="${CHDASH_TEST_IMAGE:-debian:trixie-slim}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required to make the test certificates" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

work="$(mktemp -d)"
network="chdash-pdp-tls-$$"
failures=0
cleanup() {
  for c in $(docker ps -aq --filter "label=chdash-pdp-test=$$"); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
ok() { echo "ok:   $*"; }

# --- the certificates -----------------------------------------------------------------------------------------------
certs="$work/certs"; mkdir -p "$certs"
make_ca() { # NAME
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$1" -keyout "$certs/$1.key" -out "$certs/$1.crt" >/dev/null 2>&1
}
make_ca ca
make_ca other-ca
make_server() { # NAME ALTNAMES: a certificate of the CA for the alternative names (DNS:a,DNS:b)
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$1" -keyout "$certs/$1.key" -out "$certs/$1.csr" >/dev/null 2>&1
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$2" > "$certs/$1.ext"
  openssl x509 -req -in "$certs/$1.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" -CAcreateserial -days 2 -extfile "$certs/$1.ext" \
    -out "$certs/$1.crt" >/dev/null 2>&1
}
make_server pdp-tls "DNS:pdp-tls"
# The certificate of the PDP that names another PDP in its metadata also has the name that the clients use.
make_server pdp-wrongmeta "DNS:pdp-wrongmeta"
chmod 0644 "$certs"/*

# --- the identity token and the files of the configuration ------------------------------------------------------------------
cp "$repo/tests/config/secrets/access-identity-keys.pem" "$work/identity-keys.pem"
printf 'pdp-test-token' > "$work/pdp-token"
printf 'tls-test-password' > "$work/password"
chmod 0644 "$work/identity-keys.pem" "$work/pdp-token" "$work/password"
new_token() { # a token for alice, valid for 4 minutes (the longest life that the server accepts is max_age, 5 minutes)
  python3 -I - "$repo/tests/backend-functional" <<'PY'
import sys, time
sys.path.insert(0, sys.argv[1])
from identity_tokens import Ed25519Key, make_token
now = int(time.time())
key = Ed25519Key(bytes(range(1, 33)))
print(make_token(key, {"iss": "https://access.test", "sub": "alice", "aud": "db", "iat": now - 5, "exp": now + 240}))
PY
}

docker network create "$network" >/dev/null

start_pdp() { # NAME PUBLIC_URL [EXTRA ENV ...]: the fake PDP with TLS, with the network alias NAME (and pdp-alias for pdp-tls)
  local name="$1" public="$2"; shift 2
  local alias_args=(--network-alias "$name")
  [[ "$name" == pdp-tls ]] && alias_args+=(--network-alias pdp-alias)
  docker run -d --label "chdash-pdp-test=$$" --name "chdash-pdp-$$-$name" --network "$network" "${alias_args[@]}" \
    -e FAKE_PDP_PORT=8443 -e FAKE_PDP_TOKEN=pdp-test-token -e FAKE_PDP_PUBLIC_URL="$public" \
    -e FAKE_PDP_TLS_CERT="/certs/$name.crt" -e FAKE_PDP_TLS_KEY="/certs/$name.key" "$@" \
    -v "$certs:/certs:ro" -v "$repo/tests/otel-fixture/fake_pdp.py:/fixture/fake_pdp.py:ro" \
    "$pdp_image" python3 /fixture/fake_pdp.py >/dev/null
}
pdp_exec() { # NAME PYTHON-CODE: run python in the container of the PDP. The control calls are not under test: they do not verify the certificate.
  docker exec "chdash-pdp-$$-$1" python3 -c "import ssl, urllib.request
ctx = ssl._create_unverified_context()
$2"
}
wait_pdp() { # NAME
  for _ in $(seq 1 30); do
    if pdp_exec "$1" "print(urllib.request.urlopen('https://$1:8443/healthz', context=ctx, timeout=2).read().decode())" 2>/dev/null | grep -q ok; then return 0; fi
    sleep 1
  done
  docker logs "chdash-pdp-$$-$1" 2>&1 | tail -10 >&2
  echo "the fake PDP $1 did not start" >&2
  exit 1
}
start_pdp pdp-tls "https://pdp-tls:8443"
start_pdp pdp-wrongmeta "https://elsewhere.example:8443"
wait_pdp pdp-tls
wait_pdp pdp-wrongmeta

# --- one ChDash for each case -------------------------------------------------------------------------------------------
cfg_for() { # PDP_BLOCK_LINES -> the configuration file name
  local file="$work/config-$RANDOM.hcl"
  cat > "$file" <<HCL
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}
health {
  interval_ms = 1000
  timeout_ms  = 1000
}
access {
  mode = "authzen"
  identity {
    issuer           = "https://access.test"
    audience         = "db"
    public_keys_file = "/identity-keys.pem"
  }
  pdp {
    token_file = "/pdp-token"
    timeout    = "1s"
    cache_ttl  = "0s"
$1
  }
}
clickhouse {
  host {
    name                 = "local"
    runner_uri           = "clickhouse://chdash@clickhouse-none:9000"
    system_uri           = "clickhouse://chdash@clickhouse-none:9000"
    runner_password_file = "/password"
    system_password_file = "/password"
  }
}
HCL
  chmod 0644 "$file"
  echo "$file"
}

run_chdash() { # CONFIG -> the container id (it starts in the background)
  docker run -d --label "chdash-pdp-test=$$" --network "$network" -p 127.0.0.1::8080 \
    -v "$bin:/chdash:ro" -v "$1:/config.hcl:ro" -v "$work/identity-keys.pem:/identity-keys.pem:ro" -v "$work/pdp-token:/pdp-token:ro" \
    -v "$work/password:/password:ro" -v "$certs:/certs:ro" "$runner_image" /chdash --config /config.hcl
}

published_port() { # CONTAINER
  local port=""
  for _ in $(seq 1 30); do
    port="$(docker port "$1" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
    [[ -n "$port" ]] && break
    sleep 1
  done
  echo "$port"
}

version_status() { # PORT -> the HTTP status of GET /api/version with the identity token
  curl -sS -m 5 -o /dev/null -w '%{http_code}' -H "X-Identity-Token: $(new_token)" "http://127.0.0.1:$1/api/version" 2>/dev/null || echo 000
}

wait_status() { # PORT EXPECTED -> the status after at most 20 seconds (it waits for the server to start)
  local port="$1" expected="$2" status=000
  for _ in $(seq 1 20); do
    status="$(version_status "$port")"
    [[ "$status" == "$expected" ]] && break
    sleep 1
  done
  echo "$status"
}

expect_status() { # NAME PDP_BLOCK_LINES EXPECTED [LOG_TEXT]
  local name="$1" lines="$2" expected="$3" text="${4:-}" cfg cid port status logs
  cfg="$(cfg_for "$lines")"
  cid="$(run_chdash "$cfg")"
  port="$(published_port "$cid")"
  status="$(wait_status "$port" "$expected")"
  if [[ "$status" == "$expected" ]]; then ok "$name: GET /api/version gives $status"; else
    fail "$name: GET /api/version gives $status, expected $expected"
    docker logs "$cid" 2>&1 | tail -12 | cut -c1-400 >&2
  fi
  if [[ -n "$text" ]]; then
    logs="$(docker logs "$cid" 2>&1)"
    if [[ "$logs" == *"$text"* ]]; then ok "$name: the log has \"$text\""; else
      fail "$name: the log has no \"$text\""; docker logs "$cid" 2>&1 | tail -8 | cut -c1-400 >&2
    fi
  fi
  LAST_CID="$cid"
}

expect_start_error() { # NAME PDP_BLOCK_LINES MESSAGE
  local name="$1" lines="$2" message="$3" cfg out code=0
  cfg="$(cfg_for "$lines")"
  out="$(docker run --rm --label "chdash-pdp-test=$$" --network "$network" -v "$bin:/chdash:ro" -v "$cfg:/config.hcl:ro" \
    -v "$work/identity-keys.pem:/identity-keys.pem:ro" -v "$work/pdp-token:/pdp-token:ro" -v "$work/password:/password:ro" -v "$certs:/certs:ro" \
    "$runner_image" /chdash --config /config.hcl 2>&1)" || code=$?
  if [[ "$code" != 0 && "$out" == *"$message"* ]]; then ok "$name: the start stops with \"$message\""; else
    fail "$name: expected a stop with \"$message\" (exit $code)"; printf '%s\n' "$out" | tail -4 | cut -c1-400 >&2
  fi
}

pdp_received() { # -> the number of requests that the PDP pdp-tls received with the right token
  pdp_exec pdp-tls "import json
data = json.load(urllib.request.urlopen('https://pdp-tls:8443/control/received', context=ctx, timeout=3))
print(sum(1 for r in data['requests'] if r['authorization'] == 'Bearer pdp-test-token'))" 2>/dev/null || echo 0
}

expect_status "1 chain and name verified" '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/ca.crt"' 200 '"event":"access.pdp_metadata"'
if [[ "$(pdp_received)" -ge 1 ]]; then ok "1 the PDP received a question with the token over TLS"; else fail "1 the PDP received no question"; fi
expect_status "2 another CA" '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/other-ca.crt"' 503 'certificate'
expect_status "3 name not in the certificate" '    url     = "https://pdp-alias:8443"
    ca_file = "/certs/ca.crt"' 503 'certificate'
expect_status "4 CA unknown to the system" '    url = "https://pdp-tls:8443"' 503 'certificate'
expect_status "5 verify = false" '    url    = "https://pdp-tls:8443"
    verify = false' 200 'access.pdp.verify = false'
expect_status "6 http to the https port" '    url = "http://pdp-tls:8443"' 503 'clear text'
expect_start_error "7 the metadata names another PDP" '    url     = "https://pdp-wrongmeta:8443"
    ca_file = "/certs/ca.crt"' 'access.pdp.url (https://pdp-wrongmeta:8443)'
expect_start_error "8a ca_file with an http URL" '    url     = "http://pdp-tls:8443"
    ca_file = "/certs/ca.crt"' 'access.pdp.ca_file and access.pdp.url (file) contradict each other'
expect_start_error "8b verify with an http URL" '    url    = "http://pdp-tls:8443"
    verify = false' 'access.pdp.verify and access.pdp.url (file) contradict each other'
expect_start_error "8c ca_file that does not exist" '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/missing.pem"' 'access.pdp.ca_file must name a readable file'

# 9. the PDP is down at the start: the server starts; the first questions fail; when the PDP is up, the metadata is read again.
docker rm -f "chdash-pdp-$$-pdp-tls" >/dev/null
cfg="$(cfg_for '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/ca.crt"')"
cid="$(run_chdash "$cfg")"
port="$(published_port "$cid")"
if [[ "$(wait_status "$port" 503)" == 503 ]]; then ok "9 the PDP is down: GET /api/version gives 503"; else fail "9 expected 503 while the PDP is down"; fi
logs="$(docker logs "$cid" 2>&1)"
if [[ "$logs" == *'"event":"access.pdp_metadata_failed"'* ]]; then ok "9 the log has access.pdp_metadata_failed"; else fail "9 no access.pdp_metadata_failed"; fi
start_pdp pdp-tls "https://pdp-tls:8443"
wait_pdp pdp-tls
if [[ "$(wait_status "$port" 200)" == 200 ]]; then ok "9 the PDP is up again: GET /api/version gives 200"; else
  fail "9 expected 200 after the PDP came back"; docker logs "$cid" 2>&1 | tail -8 | cut -c1-400 >&2
fi

# 10. the limit of the wait of a question with context.usage (owner decision of 2026-11-07).
pdp_exec pdp-tls "import json
body = json.dumps({'default': True, 'metadata_extra': {'procurauth_usage_max_seconds': 121}}).encode()
request = urllib.request.Request('https://pdp-tls:8443/control/answer', data=body, headers={'Content-Type': 'application/json'})
urllib.request.urlopen(request, context=ctx, timeout=3).read()" >/dev/null
expect_start_error "10a the metadata publishes 121 s, the limit is 120 s" '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/ca.crt"
    usage_max_seconds = 120' 'procurauth_usage_max_seconds of the metadata is 121, above access.pdp.usage_max_seconds (120)'
expect_status "10b the metadata publishes 121 s, the limit is 121 s" '    url     = "https://pdp-tls:8443"
    ca_file = "/certs/ca.crt"
    usage_max_seconds = 121' 200 '"usage_max_seconds":121'

if (( failures > 0 )); then echo "FAILED: $failures case(s)" >&2; exit 1; fi
echo "OK: TLS to the PDP"
