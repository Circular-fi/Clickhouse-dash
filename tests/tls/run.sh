#!/usr/bin/env bash
# End-to-end test of the TLS client of ChDash (secure=1 in the URI of a ClickHouse host). It uses only Docker.
# It does not change the host. Usage: tests/tls/run.sh /path/to/chdash [CLICKHOUSE_IMAGE]
#
# The script makes a CA and a certificate for the name "clickhouse-tls", starts a ClickHouse server with the native TLS port
# 9440, and starts the given chdash binary once for each case. A case gives the URI of the host and the result that the test
# expects: the host is "up", the host is "down", or the start stops with a message.
#   1. secure=1 and ca=<the CA>                       up   (the chain and the name are verified)
#   2. secure=1 with no ca                            down (the store of the system does not know the CA)
#   3. secure=1 and verify=0                          up   (and a warning at start)
#   4. secure=1, ca=<the CA>, an alias of the host    down (the name is not in the certificate)
#   5. secure=1 and ca=<another CA>                   down (the chain is not trusted)
#   6. the TLS port with no secure                    down
#   7. no TLS on the plain port                       up   (no change for a URI without TLS)
#   8. secure=ture, a TLS parameter without secure=1, a ca file that does not exist: the start stops with a message
# The binary needs the TLS client: a binary built without CHDASH_TLS fails the case 1 and the test says so.
set -euo pipefail

[[ $# -ge 1 && $# -le 2 ]] || { echo "usage: $0 /path/to/chdash [CLICKHOUSE_IMAGE]" >&2; exit 2; }
bin="$(realpath "$1")"
[[ -x "$bin" ]] || { echo "$bin is not an executable file" >&2; exit 2; }
ch_image="${2:-${CLICKHOUSE_IMAGE:-clickhouse:26.7.5.10@sha256:d0e74e9970998f92c0490c23345259a539550eff24f551dbe385d3cd29481f74}}"
runner_image="${CHDASH_TEST_IMAGE:-debian:trixie-slim}"
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required to make the test certificates" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

work="$(mktemp -d)"
network="chdash-tls-$$"
ch_name="chdash-tls-ch-$$"
failures=0
cleanup() {
  docker rm -f "$ch_name" >/dev/null 2>&1 || true
  for c in $(docker ps -aq --filter "label=chdash-tls-test=$$"); do docker rm -f "$c" >/dev/null 2>&1 || true; done
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
openssl req -newkey rsa:2048 -nodes -subj "/CN=clickhouse-tls" -keyout "$certs/server.key" -out "$certs/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:clickhouse-tls\nextendedKeyUsage=serverAuth\n' > "$certs/san.ext"
openssl x509 -req -in "$certs/server.csr" -CA "$certs/ca.crt" -CAkey "$certs/ca.key" -CAcreateserial -days 2 -extfile "$certs/san.ext" \
  -out "$certs/server.crt" >/dev/null 2>&1
chmod 0644 "$certs"/*

# --- the ClickHouse server ----------------------------------------------------------------------------------------------
cat > "$work/tls.xml" <<'XML'
<clickhouse>
  <tcp_port_secure>9440</tcp_port_secure>
  <openSSL>
    <server>
      <certificateFile>/certs/server.crt</certificateFile>
      <privateKeyFile>/certs/server.key</privateKeyFile>
      <verificationMode>none</verificationMode>
      <loadDefaultCAFile>false</loadDefaultCAFile>
      <disableProtocols>sslv2,sslv3</disableProtocols>
      <preferServerCiphers>true</preferServerCiphers>
    </server>
  </openSSL>
</clickhouse>
XML
printf 'tls-test-password' > "$work/password"
chmod 0644 "$work/tls.xml" "$work/password"
docker network create "$network" >/dev/null
docker run -d --name "$ch_name" --network "$network" --network-alias clickhouse-tls --network-alias clickhouse-alias \
  -e CLICKHOUSE_USER=chdash -e CLICKHOUSE_PASSWORD=tls-test-password -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  -v "$certs:/certs:ro" -v "$work/tls.xml:/etc/clickhouse-server/config.d/tls.xml:ro" "$ch_image" >/dev/null
for _ in $(seq 1 90); do
  if docker exec "$ch_name" clickhouse-client --user chdash --password tls-test-password -q 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "${ready:-0}" == 1 ]] || { docker logs "$ch_name" 2>&1 | tail -20 >&2; echo "ClickHouse did not start" >&2; exit 1; }

# The state of a host is the member "healthy" of GET /api/hosts: the health check opens a connection with the URI of the host.
# --- one ChDash for each case -------------------------------------------------------------------------------------------
cfg_for() { # URI -> the configuration file name
  local uri="$1" file="$work/config-$RANDOM.hcl"
  cat > "$file" <<HCL
server {
  listen_host = "0.0.0.0"
  listen_port = 8080
}
health {
  interval_ms = 1000
  timeout_ms  = 2000
}
access {
  mode = "open"
}
clickhouse {
  host {
    name                 = "tls"
    runner_uri           = "$uri"
    system_uri           = "$uri"
    runner_password_file = "/password"
    system_password_file = "/password"
  }
}
HCL
  chmod 0644 "$file"
  echo "$file"
}

run_chdash() { # CONFIG -> the container id (it starts in the background)
  docker run -d --label "chdash-tls-test=$$" --network "$network" -p 127.0.0.1::8080 \
    -v "$bin:/chdash:ro" -v "$1:/config.hcl:ro" -v "$work/password:/password:ro" -v "$certs:/certs:ro" \
    "$runner_image" /chdash --config /config.hcl
}

host_state() { # PORT -> up|down|none (the state that GET /api/hosts gives for the host "tls")
  curl -fsS -m 3 "http://127.0.0.1:$1/api/hosts" 2>/dev/null | python3 -I -c '
import json, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    print("none"); raise SystemExit
hosts = data.get("hosts", data) if isinstance(data, dict) else data
for host in hosts:
    if host.get("id", host.get("name")) == "tls":
        print("up" if host.get("healthy") is True else "down"); raise SystemExit
print("none")'
}

expect_state() { # NAME URI EXPECTED(up|down)
  local name="$1" uri="$2" expected="$3" cfg cid port state="none" deadline
  cfg="$(cfg_for "$uri")"
  cid="$(run_chdash "$cfg")"
  port=""
  for _ in $(seq 1 30); do
    port="$(docker port "$cid" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
    [[ -n "$port" ]] && break
    sleep 1
  done
  deadline=$((SECONDS + 25))
  if [[ "$expected" == up ]]; then
    while (( SECONDS < deadline )); do state="$(host_state "$port")"; [[ "$state" == up ]] && break; sleep 1; done
  else
    # A host that must stay down: wait for the first health answer, then keep watching a few seconds.
    while (( SECONDS < deadline )); do state="$(host_state "$port")"; [[ "$state" != none ]] && break; sleep 1; done
    sleep 4; [[ "$state" != up ]] && state="$(host_state "$port")"
  fi
  if [[ "$state" == "$expected" ]]; then ok "$name: the host is $state"; else
    fail "$name: the host is $state, expected $expected"
    curl -fsS -m 3 "http://127.0.0.1:$port/api/hosts" 2>&1 | cut -c1-700 >&2 || true
    docker logs "$cid" 2>&1 | tail -8 | cut -c1-300 >&2
  fi
  LAST_CID="$cid"
}

expect_start_error() { # NAME URI MESSAGE
  local name="$1" uri="$2" message="$3" cfg out code=0
  cfg="$(cfg_for "$uri")"
  out="$(docker run --rm --label "chdash-tls-test=$$" --network "$network" -v "$bin:/chdash:ro" -v "$cfg:/config.hcl:ro" \
    -v "$work/password:/password:ro" -v "$certs:/certs:ro" "$runner_image" /chdash --config /config.hcl 2>&1)" || code=$?
  if [[ "$code" != 0 && "$out" == *"$message"* ]]; then ok "$name: the start stops with \"$message\""; else
    fail "$name: expected a stop with \"$message\" (exit $code)"; printf '%s\n' "$out" | tail -4 | cut -c1-300 >&2
  fi
}

U="clickhouse://chdash@clickhouse-tls"
expect_state "1 chain and name verified" "$U?secure=1&ca=/certs/ca.crt" up
expect_state "2 CA unknown to the system" "$U?secure=1" down
expect_state "3 verify=0" "$U?secure=1&verify=0" up
if docker logs "$LAST_CID" 2>&1 | grep -q 'verify=0, so the certificate of the server is not verified'; then ok "3 the start writes a warning for verify=0"; else fail "3 no warning for verify=0"; fi
expect_state "4 name not in the certificate" "clickhouse://chdash@clickhouse-alias?secure=1&ca=/certs/ca.crt" down
expect_state "5 another CA" "$U?secure=1&ca=/certs/other-ca.crt" down
expect_state "6 the TLS port with no secure" "clickhouse://chdash@clickhouse-tls:9440" down
expect_state "7 no TLS on the plain port" "clickhouse://chdash@clickhouse-tls:9000" up
expect_start_error "8a secure=ture" "$U?secure=ture" "the parameter secure takes"
expect_start_error "8b ca with no secure" "$U?ca=/certs/ca.crt" "the parameter ca needs secure=1"
expect_start_error "8c ca file missing" "$U?secure=1&ca=/certs/missing.pem" "the parameter ca must name a readable file"
expect_start_error "8d ca_dir missing" "$U?secure=1&ca_dir=/certs/missing" "the parameter ca_dir must name a directory"

if (( failures > 0 )); then echo "FAILED: $failures case(s)" >&2; exit 1; fi
echo "OK: TLS to ClickHouse"
