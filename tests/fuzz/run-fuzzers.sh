#!/bin/sh
# Runs the libFuzzer targets of tests/fuzz. It runs inside the `fuzz` stage of tests/Dockerfile.sanitize
# (tests/tools/fuzz.sh starts it there).
#
#   run-fuzzers.sh <seconds> [target ...]     every target (default) or the ones named (json_parse, format, ...)
#
# Each target runs for <seconds> from its seed corpus (tests/fuzz/corpus/<target>) with its dictionary
# (tests/fuzz/<dict>.dict), several targets at a time. The corpus grows in <out>/<target>/corpus. A crash, a
# sanitizer finding, a leak, an input slower than 25 s or one that takes more than 2.5 GB is written to
# <out>/<target>/ (crash-*, leak-*, timeout-*, oom-*) with the log (fuzz.log). Exit status 1 when a target found
# something, 2 on a usage error.
#
# Environment: CHDASH_FUZZ_OUT (/out), CHDASH_FUZZ_JOBS (the number of CPUs), CHDASH_FUZZ_BIN (/work/fuzz),
# CHDASH_FUZZ_SRC (/work/tests/fuzz).
set -eu
seconds="${1:-}"
case "$seconds" in
  ''|*[!0-9]*) echo "usage: $0 <seconds> [target ...]" >&2; exit 2 ;;
esac
shift
bin="${CHDASH_FUZZ_BIN:-/work/fuzz}"
src="${CHDASH_FUZZ_SRC:-/work/tests/fuzz}"
out="${CHDASH_FUZZ_OUT:-/out}"
jobs="${CHDASH_FUZZ_JOBS:-$(nproc)}"

targets="$*"
if [ -z "$targets" ]; then
  targets="$(cd "$bin" && ls chdash_fuzz_* | sed 's/^chdash_fuzz_//')"
fi
for target in $targets; do
  if [ ! -x "$bin/chdash_fuzz_$target" ]; then
    echo "unknown fuzz target: $target (known: $(cd "$bin" && ls chdash_fuzz_* | sed 's/^chdash_fuzz_//' | tr '\n' ' '))" >&2
    exit 2
  fi
done

# The dictionary of a target: the SQL targets share one.
dictionary() {
  case "$1" in
    format|mcp_sql|user_sql_policy|wasm_highlight|wasm_sqlscan) echo "$src/sql.dict" ;;
    json_parse) echo "$src/json.dict" ;;
    hcl) echo "$src/hcl.dict" ;;
    wasm_color) echo "$src/color.dict" ;;
    *) echo "" ;;
  esac
}

run_one() {
  target="$1"
  dir="$out/$target"
  mkdir -p "$dir/corpus"
  if [ -d "$src/corpus/$target" ]; then
    cp -n "$src/corpus/$target"/* "$dir/corpus/" 2>/dev/null || true
  fi
  dict="$(dictionary "$target")"
  dict_arg=""
  if [ -n "$dict" ] && [ -f "$dict" ]; then dict_arg="-dict=$dict"; fi
  # The findings of an earlier run stay where they are: only the new ones count.
  before="$(cd "$dir" && ls crash-* leak-* timeout-* oom-* 2>/dev/null || true)"
  # shellcheck disable=SC2086
  (cd "$dir" && "$bin/chdash_fuzz_$target" -max_total_time="$seconds" -timeout=25 -rss_limit_mb=2560 \
     -print_final_stats=1 $dict_arg corpus > fuzz.log 2>&1) || true
  after="$(cd "$dir" && ls crash-* leak-* timeout-* oom-* 2>/dev/null || true)"
  findings="$(printf '%s\n' "$after" | grep -vxF -e "$before" -e '' || true)"
  if [ -z "$before" ]; then findings="$after"; fi
  runs="$(grep -E '^stat::number_of_executed_units' "$dir/fuzz.log" | awk '{print $2}' || true)"
  if [ -n "$findings" ]; then
    echo "FAIL  $target: $(echo "$findings" | tr '\n' ' ')(log: $dir/fuzz.log)"
    grep -E 'ERROR: |runtime error|SUMMARY' "$dir/fuzz.log" | head -5 | sed 's/^/      /'
    return 1
  fi
  echo "ok    $target: ${runs:-?} inputs in ${seconds} s, corpus $(ls "$dir/corpus" | wc -l) files"
}

status=0
running=0
pids=""
for target in $targets; do
  run_one "$target" > "$out/.$target.result" 2>&1 &
  pids="$pids $!"
  running=$((running + 1))
  if [ "$running" -ge "$jobs" ]; then
    for pid in $pids; do wait "$pid" || status=1; done
    pids=""
    running=0
  fi
done
for pid in $pids; do wait "$pid" || status=1; done
for target in $targets; do
  cat "$out/.$target.result"
  rm -f "$out/.$target.result"
done
exit "$status"
