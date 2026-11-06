#!/usr/bin/env bash
# Builds the static libraries of OpenSSL for the TLS client of ChDash (secure=1 in a ClickHouse URI).
#
# Usage: tools/build_openssl.sh PREFIX [TARGET]
#   PREFIX  the directory that receives include/ and lib/ (or lib64/). The build tree is a scratch directory.
#   TARGET  an OpenSSL target such as linux-x86_64, linux-aarch64, darwin64-x86_64-cc or darwin64-arm64-cc.
#           The default follows the host: uname -s and uname -m.
#
# The compiler is the one that CC names (the release builds give "zig cc -target <triple>-musl -static"). The
# archive is fetched from the release page of OpenSSL and checked against the SHA-256 below: a tag can move, a hash cannot.
# To change the version, change OPENSSL_VERSION and OPENSSL_SHA256 together (the .sha256 file of the release gives the hash).
# Then build the new version with this script and run tests/tls/run.sh.
#
# The libraries are static, without the shared libraries, the tests, the manual pages and the command line programs.
# The directory of the certificates that a build uses without the parameter ca is /etc/ssl (OPENSSL_DIR below): on Debian,
# Alpine and Red Hat systems it holds the store of the system. An image without such a store gives the parameter ca.
set -euo pipefail

OPENSSL_VERSION="3.5.9"
OPENSSL_SHA256="603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a"
OPENSSL_URL="https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
OPENSSL_DIR="${OPENSSL_DIR:-/etc/ssl}"

fail() { echo "build_openssl.sh: $*" >&2; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] || fail "usage: $0 PREFIX [TARGET]"
prefix="$1"
target="${2:-}"
if [[ -z "$target" ]]; then
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64) target="linux-x86_64" ;;
    Linux/aarch64 | Linux/arm64) target="linux-aarch64" ;;
    Darwin/x86_64) target="darwin64-x86_64-cc" ;;
    Darwin/arm64) target="darwin64-arm64-cc" ;;
    *) fail "no default OpenSSL target for $(uname -s)/$(uname -m): give TARGET" ;;
  esac
fi
for tool in curl tar perl make sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || {
    # macOS has shasum and no sha256sum.
    [[ "$tool" == sha256sum ]] && command -v shasum >/dev/null 2>&1 && continue
    fail "$tool is required"
  }
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

work="$(mktemp -d "${TMPDIR:-/tmp}/chdash-openssl.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT INT TERM
archive="$work/openssl.tar.gz"
curl -fsSL --retry 5 --retry-all-errors -o "$archive" "$OPENSSL_URL"
[[ "$(sha256_of "$archive")" == "$OPENSSL_SHA256" ]] || fail "SHA-256 mismatch for openssl-${OPENSSL_VERSION}.tar.gz"
tar -xzf "$archive" -C "$work"
cd "$work/openssl-${OPENSSL_VERSION}"

jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
# The compiler flags that ChDash wants in the release: position independent code (the binary is static-pie) and a
# fortified build. "no-asm" stays off: the assembly of the curves and the hashes keeps the TLS handshake fast.
./Configure "$target" \
  --prefix="$prefix" --openssldir="$OPENSSL_DIR" --libdir=lib \
  no-shared no-tests no-docs no-apps no-module no-engine no-dso no-legacy no-ssl3 no-comp no-afalgeng \
  -fPIC
make -j"$jobs" build_libs
make install_dev
[[ -f "$prefix/lib/libssl.a" && -f "$prefix/lib/libcrypto.a" ]] || fail "the static libraries are missing in $prefix/lib"
echo "[openssl] ${OPENSSL_VERSION} ${target} -> ${prefix}"
