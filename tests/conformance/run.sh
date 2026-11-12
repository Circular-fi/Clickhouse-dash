#!/usr/bin/env bash
# The conformance runner of ProcurAuth against ChDash, with the role pep. It uses only Docker. It does not change the host.
# Usage: tests/conformance/run.sh /path/to/chdash [CLICKHOUSE_IMAGE]
#
# The script starts a ClickHouse server and the given chdash binary (tests/config/access.conformance.hcl) in a Docker network. Then it
# runs the program `access-conformance` of the ProcurAuth repository in the same network. The runner acts as the edge (it signs the
# identity tokens), as the PDP (it listens on conformance-pdp:8181) and as the client. It prints one line for each case.
#
# The exit code is 0 when each failed case is in tests/conformance/expected.txt. A case with the result fail that is not in the list
# gives the exit code 1. A case of the list that passes is reported, but it does not change the code (set CONFORMANCE_STRICT=1 to
# make it an error). The exit code 2 means a problem of the set-up: a missing tool, a start that failed, a runner that did not run.
#
# Environment (each variable is optional):
#   PROCURAUTH_DIR       the ProcurAuth repository (default: ../procurauth next to this repository). The script reads it only.
#   CONFORMANCE_RUNNER   a built access-conformance binary: the script then does not build one.
#   CONFORMANCE_EXPECTED the list of expected failures (default: tests/conformance/expected.txt).
#   CONFORMANCE_KEEP     1 to keep the containers and the work directory after the run (for a look at the logs).
#   CHDASH_APP_IMAGE     the image that runs the chdash binary (default: CHDASH_TEST_IMAGE, debian:trixie-slim).
#   CONFORMANCE_CONFIG   the configuration of chdash (default: tests/config/access.conformance.hcl). The variants "full" and "lean" are
#                        access.conformance-full.hcl and access.conformance-lean.hcl.
#   CONFORMANCE_PROFILE  the profile of the runner (default: tests/conformance/profile.json). It must match the configuration: its
#                        approval_calls name each action that the document declares: profile-full.json and profile-lean.json.
set -euo pipefail

[[ $# -ge 1 && $# -le 2 ]] || { echo "usage: $0 /path/to/chdash [CLICKHOUSE_IMAGE]" >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bin="$(realpath "$1")"
[[ -x "$bin" ]] || { echo "$bin is not an executable file" >&2; exit 2; }
ch_image="${2:-${CLICKHOUSE_IMAGE:-clickhouse:26.7.5.10@sha256:d0e74e9970998f92c0490c23345259a539550eff24f551dbe385d3cd29481f74}}"
image="${CHDASH_TEST_IMAGE:-debian:trixie-slim}"
# The image that runs the chdash binary. The default is the image of the runner. A binary that the Alpine test image builds needs an Alpine image.
app_image="${CHDASH_APP_IMAGE:-$image}"
pa_dir="$(realpath "${PROCURAUTH_DIR:-$repo/../procurauth}" 2>/dev/null || true)"
expected_file="${CONFORMANCE_EXPECTED:-$here/expected.txt}"
for tool in docker openssl curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 2; }
done
[[ -f "$expected_file" ]] || { echo "the list of expected failures is missing: $expected_file" >&2; exit 2; }

work="$(mktemp -d)"
tag="$$"
network="chdash-conformance-$tag"
ch_name="chdash-conformance-ch-$tag"
app_name="chdash-conformance-app-$tag"
cleanup() {
  if [[ "${CONFORMANCE_KEEP:-0}" == 1 ]]; then echo "kept: containers $ch_name $app_name, directory $work" >&2; return; fi
  docker rm -f "$ch_name" "$app_name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
die() { echo "ERROR: $*" >&2; exit 2; }

# --- the runner -----------------------------------------------------------------------------------------------------------
# The tool is built with the script of the ProcurAuth repository (Docker). The program stays in a Docker volume: the script copies it.
if [[ -n "${CONFORMANCE_RUNNER:-}" ]]; then
  cp "$CONFORMANCE_RUNNER" "$work/access-conformance"
else
  [[ -n "$pa_dir" && -f "$pa_dir/scripts/cargo.sh" ]] || die "PROCURAUTH_DIR does not name the ProcurAuth repository"
  echo "== build the runner (ProcurAuth, scripts/cargo.sh)" >&2
  bash "$pa_dir/scripts/cargo.sh" build --release -p access-conformance >&2
  # docker-env.sh gives the name of the target volume of that checkout.
  target_volume="$(source "$pa_dir/scripts/docker-env.sh"; printf %s "$target_volume")"
  docker run --rm --user "$(id -u):$(id -g)" -v "$target_volume:/t:ro" -v "$work:/out" "$image" \
    cp /t/release/access-conformance /out/access-conformance || die "the runner binary is not in the volume $target_volume"
fi
chmod 0755 "$work/access-conformance"
[[ -n "$pa_dir" && -d "$pa_dir/crates/access-conformance/examples" ]] || die "PROCURAUTH_DIR does not hold the examples of the runner"

# --- the files of the run -------------------------------------------------------------------------------------------------------
# The private keys of the test edge come from the ProcurAuth repository. ChDash gets their public keys as a JWK Set with the kid of the
# profile. The committed file identity-keys.json must be this set: a difference means that the keys of ProcurAuth changed.
for name in ed25519 es256; do cp "$pa_dir/crates/access-conformance/examples/test-edge-$name.pem" "$work/test-edge-$name.pem"; done
python3 -I - "$work" > "$work/identity-keys.json" <<'PY'
import base64, json, subprocess, sys
work = sys.argv[1]
def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
def spki(name):
    return subprocess.run(["openssl", "pkey", "-in", f"{work}/test-edge-{name}.pem", "-pubout", "-outform", "DER"],
                          check=True, capture_output=True).stdout
ed = spki("ed25519")[-32:]
ec = spki("es256")[-65:]
assert ec[0] == 4
keys = [
    {"kty": "OKP", "crv": "Ed25519", "kid": "edge-ed25519", "x": b64(ed)},
    {"kty": "EC", "crv": "P-256", "kid": "edge-es256", "x": b64(ec[1:33]), "y": b64(ec[33:])},
]
print(json.dumps({"keys": keys}, indent=2))
PY
cmp -s "$work/identity-keys.json" "$here/identity-keys.json" ||
  die "tests/conformance/identity-keys.json is not the public set of the test keys of ProcurAuth: copy $work/identity-keys.json (CONFORMANCE_KEEP=1)"
# The effect vectors of protocol 17.3 are a copy. A difference is a warning: the native test uses the copy.
if [[ -f "$pa_dir/conformance/vectors/effect.json" ]] && ! cmp -s "$pa_dir/conformance/vectors/effect.json" "$here/effect-vectors.json"; then
  echo "WARNING: tests/conformance/effect-vectors.json differs from conformance/vectors/effect.json of the ProcurAuth repository" >&2
fi
cp "${CONFORMANCE_PROFILE:-$here/profile.json}" "$work/profile.json"
tr -d '\n' < "$repo/tests/config/secrets/access-pdp-token" > "$work/pdp-token"
printf 'conformance-test-password' > "$work/ch-password"
printf 'conformance-write-password' > "$work/ch-write-password"
cp "${CONFORMANCE_CONFIG:-$repo/tests/config/access.conformance.hcl}" "$work/config.hcl"
chmod 0644 "$work"/*
chmod 0755 "$work" "$work/access-conformance"

# --- ClickHouse and ChDash ------------------------------------------------------------------------------------------------------
command -v docker >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$ch_name" --network "$network" --network-alias clickhouse-conformance \
  -e CLICKHOUSE_USER=chdash -e CLICKHOUSE_PASSWORD=conformance-test-password -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 "$ch_image" >/dev/null
ready=0
for _ in $(seq 1 90); do
  if docker exec "$ch_name" clickhouse-client --user chdash --password conformance-test-password -q 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$ch_name" 2>&1 | tail -20 >&2; die "ClickHouse did not start"; }
# The tables of the traces: the variant "full" turns the traces on (observability.read), and the tool list_services reads them.
# The GRANT lines of the file name the users of the test stack: this ClickHouse has only the user chdash.
grep -v '^GRANT' "$repo/tests/clickhouse-init/03-otel-traces.sql" | docker exec -i "$ch_name" clickhouse-client --user chdash --password conformance-test-password --multiquery \
  >/dev/null || die "the tables of the traces could not be made"
# The write account of the tool run_write_query: another user than the user of the other accounts (tests/config/access.conformance.hcl).
docker exec "$ch_name" clickhouse-client --user chdash --password conformance-test-password --multiquery -q \
  "CREATE USER chdash_write IDENTIFIED WITH plaintext_password BY 'conformance-write-password'; GRANT CREATE TABLE, SELECT ON default.* TO chdash_write" \
  >/dev/null || die "the write account of ClickHouse could not be made"

docker run -d --name "$app_name" --network "$network" --network-alias chdash-conformance -p 127.0.0.1::8080 \
  -v "$bin:/chdash:ro" -v "$work:/conformance:ro" "$app_image" /chdash --config /conformance/config.hcl >/dev/null
port=""
for _ in $(seq 1 30); do
  port="$(docker port "$app_name" 8080/tcp 2>/dev/null | head -n1 | sed 's/.*://')"
  [[ -n "$port" ]] && break
  sleep 1
done
ready=0
for _ in $(seq 1 60); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$app_name")" != true ]]; then break; fi
  if curl -fsS -m 3 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { docker logs "$app_name" 2>&1 | tail -20 | cut -c1-300 >&2; die "ChDash did not become ready"; }

# --- the run --------------------------------------------------------------------------------------------------------------------
echo "== access-conformance --role pep" >&2
code=0
docker run --rm --network "$network" --network-alias conformance-pdp -v "$work:/work:ro" -w /work "$image" \
  /work/access-conformance --role pep --profile /work/profile.json --url http://chdash-conformance:8080 > "$work/result.txt" 2> "$work/runner.err" || code=$?
cat "$work/result.txt"
if [[ "$code" -ge 2 ]]; then cat "$work/runner.err" >&2; die "the runner stopped with the code $code"; fi
if ! grep -qE '^[0-9]+ cases:' "$work/result.txt"; then cat "$work/runner.err" >&2; die "the runner gave no summary"; fi

# --- the verdict: only the unexpected results count ------------------------------------------------------------------------
python3 -I - "$expected_file" "$work/result.txt" "${CONFORMANCE_STRICT:-0}" <<'PY'
import re, sys
expected_file, result_file, strict = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
def stop(message):
    print(message, file=sys.stderr)
    sys.exit(2)


expected = {}
for number, line in enumerate(open(expected_file, encoding="utf-8"), 1):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    case, _, reason = line.partition("#")
    case = case.strip()
    if not re.fullmatch(r"[UDE][0-9]{2,3}", case) or not reason.strip():
        stop(f"ERROR: {expected_file}:{number}: write one case id, then # and the reason")
    if case in expected:
        stop(f"ERROR: {expected_file}:{number}: the case {case} occurs two times")
    expected[case] = reason.strip()
results = {}
for line in open(result_file, encoding="utf-8"):
    match = re.match(r"^([UDE][0-9]{2,3})\s+(pass|fail|warn|skip)\b", line)
    if match:
        results[match.group(1)] = match.group(2)
failed = sorted(c for c, r in results.items() if r == "fail")
unexpected = [c for c in failed if c not in expected]
fixed = sorted(c for c in expected if results.get(c) in ("pass", "warn", "skip"))
unknown = sorted(c for c in expected if c not in results)
print()
print(f"failed: {len(failed)}, expected: {len(failed) - len(unexpected)}, unexpected: {len(unexpected)}")
for case in unexpected:
    print(f"UNEXPECTED FAILURE {case}")
for case in fixed:
    print(f"NOW {results[case].upper()} {case}: remove it from {expected_file} ({expected[case]})")
for case in unknown:
    print(f"NOT RUN {case}: the runner has no such case")
bad = bool(unexpected) or (strict and (fixed or unknown))
sys.exit(1 if bad else 0)
PY
