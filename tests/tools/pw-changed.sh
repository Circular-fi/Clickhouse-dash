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
# A script of src/static that the table does not name gets the specs of the pages that load it (modules.json and the
# imports of each page entry); a module of six pages or more gets the general set.
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
    *) sed -n "2,11p" "$0"; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[ "${1:-}" = "--" ] && shift

root=$(cd "$(dirname "$0")/../.." && pwd)
specs_dir=$root/tests/frontend/specs
if [ -n "${PW_CHANGED_FILES:-}" ]; then
  changed=$PW_CHANGED_FILES
else
  merge_base=$(git -C "$root" merge-base "$base" HEAD)
  changed=$( { git -C "$root" diff --name-only "$merge_base"; git -C "$root" ls-files --others --exclude-standard; } | sort -u)
fi

# The pages (modules.json) whose modules, imports and lazy groups include the file: one name per line.
pages_of() {
  python3 - "$root/tools" "$(basename "$1")" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import module_graph
for page in module_graph.manifest()["pages"]:
    if sys.argv[2] in module_graph.page_modules(page):
        print(page)
PY
}

# The specs that cover a page.
page_specs() {
  case $1 in
    query) echo functional query-run-lifecycle streaming ;;
    explorer) echo explorer-nav explorer-storage explorer-graph ;;
    functions) echo explorer-nav ;;
    traces) echo trace-search-filters trace-views observability ;;
    trace) echo trace-page trace-waterfall ;;
    logs) echo logs observability ;;
    metrics) echo metrics-browser observability ;;
    system|queries|disks|shape) echo system ;;
    mcp) echo mcp-page ;;
  esac
}

# Source path (shell pattern) -> specs, by spec name without .spec.js. "ALL" means
# every spec. Keep the specific patterns above the generic ones: the first match wins.
specs_for() {
  case $1 in
    tests/frontend/specs/*.spec.js) basename "$1" .spec.js ;;
    tests/frontend/helpers/*.js)
      grep -l "helpers/$(basename "$1")" "$specs_dir"/*.spec.js | xargs -r -n1 basename | sed 's/\.spec\.js$//' ;;
    tests/frontend/playwright.config.js|tests/frontend/package.json|tests/Dockerfile.tests) echo ALL ;;
    # The pages without a spec family of their own in the table below, and the WebAssembly kernels with their JavaScript
    # references: the kernel specs compare each one with its reference on the page.
    src/static/app_mcp_*.js|src/static/mcp.html|src/static/app_page_mcp.js) echo mcp-page ;;
    src/static/app_page_trace.js|src/static/trace.html|src/static/app_trace_detail.js) echo trace-page trace-waterfall trace-views ;;
    src/static/app_page_shape.js|src/static/shape.html) echo system page-chrome ;;
    src/static/app_page_functions.js|src/static/functions.html) echo explorer-nav page-chrome ;;
    src/static/app_wasm_highlight.js|src/wasm/highlight.c|src/static/wasm/highlight.wasm|src/static/app_highlight.js) echo wasm-highlight wasm-autoload functional ;;
    src/static/app_wasm_sqlscan.js|src/wasm/sqlscan.c|src/static/wasm/sqlscan.wasm|src/static/app_autocomplete.js|src/static/app_sql.js|src/static/app_sql_lex.js)
      echo wasm-sql wasm-autoload functional ;;
    src/static/app_wasm_rowsort.js|src/wasm/rowsort.c|src/static/wasm/rowsort.wasm|src/static/app_results_sort.js) echo wasm-rowsort wasm-autoload functional ;;
    src/static/app_wasm_chartprep.js|src/wasm/chartprep.c|src/static/wasm/chartprep.wasm) echo wasm-chartprep query-chart ;;
    src/static/app_wasm_color.js|src/wasm/color.c|src/static/wasm/color.wasm|src/static/app_palette.js) echo wasm-color ui-foundations ;;
    src/static/app_wasm_treemap.js|src/wasm/treemap.c|src/static/wasm/treemap.wasm) echo wasm-treemap explorer-storage ;;
    src/static/app_wasm_layered.js|src/static/app_wasm_router.js|src/static/app_wasm_labels.js|src/wasm/layered.c|src/wasm/router.c|src/wasm/labels.c|src/static/wasm/layered.wasm|src/static/wasm/router.wasm|src/static/wasm/labels.wasm)
      echo wasm-layout explorer-graph ;;
    src/static/app_wasm_worker.js) echo wasm-worker wasm-highlight ;;
    src/static/app_wasm.js|src/static/app_wasm_*.js|src/wasm/*|src/static/wasm/*|tools/build_wasm.py) echo wasm-autoload wasm-worker wasm-highlight wasm-sql wasm-rowsort wasm-chartprep wasm-color wasm-treemap wasm-layout ;;
    src/static/app_ui_filterbar.js) echo obs-filterbar system observability ui-components ;;
    src/static/app_trace_heatmap.js) echo trace-heatmap ;;
    src/api_traces.cpp|src/trace_*.cpp|src/trace_*.hpp) echo trace-heatmap trace-insights trace-search-filters trace-services trace-spans trace-views functional ;;
    src/static/app_trace_insights.js) echo trace-insights ;;
    src/static/app_trace_logs.js|src/api_trace_logs.cpp) echo trace-logs ;;
    src/static/app_trace_map.js) echo trace-service-map ;;
    src/static/app_trace_search.js|src/static/app_facet_panel.js) echo trace-search-filters logs functional ;;
    src/static/app_trace_services.js) echo trace-services ;;
    src/static/app_trace_spans.js) echo trace-spans ;;
    src/static/app_trace_views.js) echo trace-views ;;
    src/static/app_trace_viewer.js|src/static/app_trace_tabs.js) echo trace-waterfall trace-views trace-insights ;;
    src/static/app_traces.js|src/otel_allowlist.hpp) echo functional trace-search-filters trace-views trace-waterfall observability ;;
    src/static/app_logs.js|src/api_logs.cpp|src/logs_*|src/api_otel_signals.cpp) echo logs observability trace-logs ;;
    src/static/app_metrics.js|src/api_metrics.cpp|src/metrics_*) echo metrics-browser observability ;;
    src/static/app_timerange.js) echo obs-filterbar observability design ;;
    src/static/app_obs_page.js|src/static/traces.html|src/static/logs.html|src/static/metrics.html|src/static/css/20-features/observability.css)
      echo observability page-per-view obs-filterbar page-chrome design accessibility ;;
    src/static/app_explorer_graph.js|src/explorer_graph*) echo explorer-graph ;;
    src/static/app_explorer_storage.js) echo explorer-storage ;;
    src/static/app_explorer_treemap.js) echo explorer-storage system ;;
    src/static/app_system*.js|src/static/system.html|src/static/queries.html|src/static/disks.html|src/static/css/20-features/system.css|src/api_system*.cpp|src/system_*)
      echo system page-chrome design explorer-nav ;;
    src/static/app_explorer*.js|src/static/explorer.html|src/static/functions.html|src/static/css/20-features/explorer.css|src/api_explorer*.cpp|src/explorer_*)
      echo explorer-nav explorer-storage explorer-graph functional design ;;
    src/static/app_query_chart.js|src/static/app_chart_core.js) echo query-chart ;;
    src/static/app_query_library.js|src/*query_library*) echo query-library ;;
    src/static/app_graph_kit.js) echo explorer-graph trace-views trace-service-map ;;
    src/static/app_ui_tabs.js|src/static/app_ui_segmented.js|src/static/app_ui_menu.js)
      echo ui-components ui-consistency ui-foundations ui-layers ;;
    src/static/app_ui_layers.js) echo ui-layers ui-popover ui-panels ui-foundations ui-consistency ;;
    src/static/app_ui_popover.js) echo ui-popover ui-layers ui-foundations ;;
    src/static/app_ui_panel.js) echo ui-panels ui-layers ui-foundations explorer-nav logs metrics-browser trace-spans ;;
    src/static/app_ui_state.js|src/static/app_ui_search.js) echo ui-infrastructure ui-foundations ui-consistency explorer-nav observability logs metrics-browser trace-search-filters query-library ;;
    src/static/app_router.js) echo ui-router ui-panels observability explorer-nav trace-views logs metrics-browser ;;
    src/static/app_loader.js|src/static/app_boot.js|src/static/app_common.js|src/static/app_assets.js|src/static/app_page_*.js|src/static/modules.json|src/shell/*|tools/page_shells.py|tools/build_page_css.py|tools/css_tree.py|tools/module_graph.py|tools/stage_static.py)
      echo ui-infrastructure ui-foundations ui-icons page-chrome design functional observability ;;
    src/static/app_state.js|src/static/app_api.js|src/static/app_util.js) echo ui-infrastructure functional ui-foundations page-chrome ;;
    src/static/app_ui_table.js|src/static/app_ui_badge.js|src/static/app_ui_copy.js|src/static/app_ui_sql.js|src/static/app_ui_kv.js|src/static/app_ui_stat.js|src/static/app_ui_chart.js)
      echo ui-data ui-foundations functional logs trace-spans trace-services explorer-nav metrics-browser query-chart ;;
    src/static/app_dom.js)
      echo dom-builder ui-foundations ui-consistency ui-components ui-layers ui-popover ui-panels page-chrome design accessibility functional ;;
    src/static/css/20-features/traces.css) echo trace-views trace-waterfall trace-search-filters trace-spans trace-services trace-service-map observability design ;;
    src/static/css/20-features/logs.css) echo logs trace-logs observability design ;;
    src/static/css/20-features/metrics.css) echo metrics-browser observability design ;;
    src/static/css/20-features/query*.css|src/static/css/20-features/analysis.css) echo functional query-chart query-library design ;;
    src/static/icons.svg|src/static/app_ui_icon.js|src/static/css/10-components/icon.css|tools/icons.py|src/static/images/*)
      echo ui-icons ui-foundations page-chrome design functional ;;
    src/static/app_ui*.js|src/static/app_palette.js|src/static/app_format.js|src/static/css/*)
      echo ui-icons ui-foundations ui-consistency ui-components ui-layers ui-popover ui-panels page-chrome design accessibility functional ;;
    src/static/app_results.js|src/static/app_run.js|src/static/app_download.js|src/static/app_export.js|src/api_query*|src/query_*|src/export_*|src/api_export.cpp|src/sse_util.hpp)
      echo functional streaming query-chart ;;
    src/static/app_analysis*.js|src/static/app_pipeline_viewer.js|src/*analysis*) echo functional ;;
    src/static/app_*.js)
      # Not named above: the specs of the pages that load the module (modules.json and its imports). A module of six pages
      # or more is a foundation: the general set.
      pages=$(pages_of "$1")
      if [ -n "$pages" ] && [ "$(printf '%s\n' "$pages" | wc -l)" -lt 6 ]; then
        for page in $pages; do page_specs "$page"; done
      else
        echo functional ui-foundations page-chrome
      fi ;;
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
    if [ -f "$specs_dir/$name.spec.js" ]; then
      spec_args+=("specs/$name.spec.js")
    else
      echo "pw-changed: no spec named $name (a stale entry of the table in $0)" >&2
    fi
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
