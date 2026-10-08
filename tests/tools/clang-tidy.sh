#!/bin/sh
# Run clang-tidy (config: /.clang-tidy) on src/*.cpp, in the sanitizer
# toolchain image (Debian, clang 19). The host needs Docker only.
#
#   tests/tools/clang-tidy.sh            # every file; exit 1 on any finding
#   tests/tools/clang-tidy.sh src/api_logs.cpp src/hcl.cpp   # some files
#   CHDASH_TIDY_CHECKS='-*,bugprone-*' tests/tools/clang-tidy.sh   # another check set (triage)
#
# The CMake build dir is a Docker volume (chdash-tidy-build): the dependencies are fetched once.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${CHDASH_TIDY_IMAGE:-chdash-tidy:local}"
volume="${CHDASH_TIDY_VOLUME:-chdash-tidy-build}"
jobs="${CHDASH_TIDY_JOBS:-$(nproc 2>/dev/null || echo 4)}"

docker build -q --target toolchain -f "$repo/tests/Dockerfile.sanitize" -t "$image" "$repo" >/dev/null
docker volume create "$volume" >/dev/null

docker run --rm \
  -v "$repo:/repo:ro" -v "$volume:/build" \
  -e CHDASH_TIDY_CHECKS="${CHDASH_TIDY_CHECKS:-}" -e CHDASH_TIDY_JOBS="$jobs" \
  "$image" sh -c '
    set -eu
    # The compile database: clang as the compiler, so the flags are the ones clang-tidy understands.
    cmake -S /repo/src -B /build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
      -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCHDASH_EMBED_STATIC=OFF \
      >/build/configure.log 2>&1 || { cat /build/configure.log; exit 2; }
    if [ "$#" -gt 0 ]; then files=""; for f in "$@"; do files="$files /repo/$f"; done; else files="/repo/src/.*\.cpp$"; fi
    checks_arg=""
    if [ -n "$CHDASH_TIDY_CHECKS" ]; then checks_arg="-checks=$CHDASH_TIDY_CHECKS"; fi
    # shellcheck disable=SC2086
    run-clang-tidy -quiet -p /build -j "$CHDASH_TIDY_JOBS" -config-file=/repo/.clang-tidy $checks_arg $files
  ' sh "$@"
