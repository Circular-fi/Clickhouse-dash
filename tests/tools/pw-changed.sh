#!/usr/bin/env bash
# Run the Playwright specs relevant to the files changed on this branch, on one
# viewport (desktop-1440), with the shared-host settings (one worker, no
# timing-budget tests). See tests/README.md, "Running tests quickly".
#
# Usage: tests/tools/pw-changed.sh [-b BASE] [-t TARGET] [-n] [-a] [-- PLAYWRIGHT_ARGS...]
#   -b BASE    compare against the merge base with BASE (default: $PW_BASE or main);
#              uncommitted and untracked files count as changed too;
#              PW_CHANGED_FILES="a b" names the files instead of git
#   -t TARGET  ChDash container on the compose network (default: chdash_source)
#   -n         print the selected specs and exit
#   -a         all three viewports instead of desktop-1440 only
#
# The run happens in the chdash-tests-all:local image (docker compose --profile
# test build tests) with this tree's specs, helpers, snapshots and config mounted.
# Reports and failure artifacts land in $PW_OUT (default tests/artifacts/pw-changed).
# PW_LOCAL=1 runs `npx playwright test` in tests/frontend instead. Environment
# variables PW_WORKERS, PW_SHARED_HOST, PW_ARTIFACTS and CI pass through.
set -euo pipefail

base=${PW_BASE:-main}
target=chdash_source
print_only=0
all_projects=0
while getopts "b:t:na" opt; do
  case $opt in
    b) base=$OPTARG ;;
    t) target=$OPTARG ;;
    n) print_only=1 ;;
    a) all_projects=1 ;;
    *) sed -n "2,19p" "$0"; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift

root=$(git rev-parse --show-toplevel)
specs_dir=$root/tests/frontend/specs
if [ -n "${PW_CHANGED_FILES:-}" ]; then
  changed=$PW_CHANGED_FILES
else
  merge_base=$(git -C "$root" merge-base "$base" HEAD)
  changed=$( { git -C "$root" diff --name-only "$merge_base"; git -C "$root" ls-files --others --exclude-standard; } | sort -u)
fi

# Source path (shell pattern) -> specs, by spec name without .spec.js. "ALL" means
# every spec. Keep the specific patterns above the generic ones: the first match wins.
specs_for() {
  case $1 in
    tests/frontend/specs/*.spec.js) basename "$1" .spec.js ;;
    tests/frontend/helpers/*.js)
      grep -l "helpers/$(basename "$1")" "$specs_dir"/*.spec.js | xargs -r -n1 basename | sed 's/\.spec\.js$//' ;;
    tests/frontend/playwright.config.js|tests/frontend/package.json|tests/Dockerfile.tests) echo ALL ;;
    src/static/app_trace_heatmap.js) echo trace-heatmap ;;
    src/api_traces.cpp) echo trace-heatmap trace-insights trace-search-filters trace-services trace-spans trace-views functional ;;
    src/static/app_trace_insights.js) echo trace-insights ;;
    src/static/app_trace_logs.js|src/api_trace_logs.cpp) echo trace-logs ;;
    src/static/app_trace_map.js) echo trace-service-map ;;
    src/static/app_trace_search.js|src/static/app_facet_panel.js) echo trace-search-filters logs functional ;;
    src/static/app_trace_services.js) echo trace-services ;;
    src/static/app_trace_spans.js) echo trace-spans ;;
    src/static/app_trace_views.js) echo trace-views ;;
    src/static/app_trace_viewer.js|src/static/app_trace_tabs.js) echo trace-waterfall trace-views trace-insights ;;
    src/static/app_traces.js|src/otel_allowlist.hpp) echo functional trace-search-filters trace-views trace-waterfall observability ;;
    src/static/app_logs.js|src/api_logs.cpp|src/api_otel_signals.cpp) echo logs observability trace-logs ;;
    src/static/app_metrics.js|src/api_metrics.cpp) echo metrics-browser observability ;;
    src/static/app_timerange.js) echo obs-filterbar observability design ;;
    src/static/app_observability.js|src/static/observability.html|src/static/style.observability*.css)
      echo observability obs-filterbar page-chrome design accessibility ;;
    src/static/app_explorer_graph.js|src/explorer_graph.*) echo explorer-graph ;;
    src/static/app_explorer_storage.js|src/static/app_explorer_treemap.js) echo explorer-storage ;;
    src/static/app_explorer*.js|src/static/explorer.html|src/static/style.explorer.css|src/api_explorer*.cpp|src/explorer_*)
      echo explorer-nav explorer-storage explorer-graph functional design ;;
    src/static/app_query_chart.js|src/static/app_chart_core.js) echo query-chart ;;
    src/static/app_query_library.js|src/*query_library*) echo query-library ;;
    src/static/app_graph_kit.js) echo explorer-graph trace-views trace-service-map ;;
    src/static/app_ui*.js|src/static/app_dom.js|src/static/app_palette.js|src/static/app_format.js|src/static/style.css)
      echo ui-foundations ui-consistency page-chrome design accessibility functional ;;
    src/static/app_results.js|src/static/app_run.js|src/static/app_download.js|src/static/app_export.js|src/api_query*|src/query_*|src/export_*|src/api_export.cpp|src/sse_util.hpp)
      echo functional streaming query-chart ;;
    src/static/app_analysis*.js|src/static/app_pipeline_viewer.js|src/*analysis*) echo functional ;;
    src/static/*|src/*) echo functional ui-foundations page-chrome ;;
    *) ;;
  esac
}

selected=$(for file in $changed; do specs_for "$file"; done | tr ' ' '\n' | sed '/^$/d' | sort -u)
if [ -z "$selected" ]; then
  echo "pw-changed: no spec maps to the files changed since $base." >&2
  exit 0
fi
if printf '%s\n' "$selected" | grep -qx ALL; then
  spec_args=()
else
  spec_args=()
  for name in $selected; do
    [ -f "$specs_dir/$name.spec.js" ] && spec_args+=("specs/$name.spec.js")
  done
fi
echo "pw-changed: ${spec_args[*]:-all specs}" >&2
[ "$print_only" = 1 ] && exit 0

project_args=(--project=desktop-1440)
[ "$all_projects" = 1 ] && project_args=()
export PW_SHARED_HOST=${PW_SHARED_HOST:-1}

if [ "${PW_LOCAL:-0}" = 1 ]; then
  cd "$root/tests/frontend"
  exec npx playwright test "${spec_args[@]}" "${project_args[@]}" "$@"
fi
front=$root/tests/frontend
out=${PW_OUT:-$root/tests/artifacts/pw-changed}
mkdir -p "$out"
exec docker run --rm --network chdash-tests_default --ipc host --shm-size 1g \
  -e FRONTEND_BASE_URL="http://$target:8080" -e API_BASE_URL="http://$target:8080" \
  -e PW_SHARED_HOST -e PW_WORKERS -e PW_ARTIFACTS -e PW_ALL_PROJECTS -e CI \
  -e FRONTEND_ARTIFACTS_DIR=/fa -v "$out:/fa" \
  -v "$front/specs:/work/frontend/specs:ro" -v "$front/helpers:/work/frontend/helpers:ro" \
  -v "$front/snapshots:/work/frontend/snapshots:ro" \
  -v "$front/playwright.config.js:/work/frontend/playwright.config.js:ro" \
  -v "$root:/repo:ro" -w /work/frontend chdash-tests-all:local \
  npx playwright test "${spec_args[@]}" "${project_args[@]}" "$@"
