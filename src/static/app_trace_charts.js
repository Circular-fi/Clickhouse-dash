// The charts of the Traces search use the shared canvas engine.
// Each card shows one chart. The charts are kept across answers.
// A card can show a message in place of its chart: loading, empty, or error with a Retry button.

import { chartCore } from "./app_chart_core.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { timeRange } from "./app_timerange.js";
import { actions } from "./app_trace_store.js";
import { uiState } from "./app_ui_state.js";

const { byId, $, $$ } = dom;
const fmt = format;

// --- Analytics charts on the shared canvas engine ------------------------
// The file app_chart_core.js loads with the traces view.
// Each card keeps one chart across answers (setData). The engine resizes the chart.
// A resize or a new answer redraws a canvas. The engine does not rebuild an SVG.
//
// The engine owns the cursor, the tooltip and the drag-to-zoom (Grafana-like).
// The two charts and the heatmap share one crosshair on the same time axis.
const CHART_HEIGHT = 196;
const CHART_SYNC_KEY = "traces-analytics";
const mountedCharts = new WeakMap(); // card body -> { kind, chart }

// Use these options for the chart of kind `kind` in `container`.
// The chart is redrawn, or a new chart replaces the one that the card shows.
function mountChart(container, kind, options) {
  if (!container || !chartCore) return null;
  const held = mountedCharts.get(container);
  if (held && held.kind === kind && container.contains(held.chart.root)) {
    held.chart.setData(options);
    return held.chart;
  }
  if (held) held.chart.destroy();
  container.textContent = "";
  const chart = chartCore.create(container, { height: CHART_HEIGHT, ...options });
  mountedCharts.set(container, { kind, chart });
  return chart;
}

function unmountChart(container) {
  const held = container && mountedCharts.get(container);
  if (!held) return;
  held.chart.destroy();
  mountedCharts.delete(container);
}

// A drag on a time chart searches that range (Grafana's time zoom).
function zoomSearchRange(range) {
  const format = timeRange?.formatDateTime;
  if (!range || !format) return;
  const from = Math.floor(range[0] / 1000) * 1000;
  const to = Math.max(from + 1000, Math.ceil(range[1] / 1000) * 1000);
  void actions.applyRange({ from: format(from), to: format(to) }, "chart");
}

// retry: "analytics" or "durations" adds a Retry button.
// The click listener of the search view handles this button (init).
function chartMessage(container, text, isError = false, retry = "") {
  if (!container) return;
  unmountChart(container);
  const state = uiState;
  container.innerHTML = isError
    ? state.errorHtml({ body: text, compact: true, retry: retry ? { attrs: { "data-chart-retry": retry } } : null })
    : state.emptyHtml({ body: text, compact: true });
}

export { CHART_SYNC_KEY, chartMessage, mountChart, mountedCharts, unmountChart, zoomSearchRange };
