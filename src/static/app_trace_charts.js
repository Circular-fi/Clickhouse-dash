// The charts of the Traces search on the shared canvas engine: one chart per card, kept across answers, and the message that
// takes the place of a chart (loading, empty, error with Retry).

import { chartCore } from "./app_chart_core.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { timeRange } from "./app_timerange.js";
import { actions } from "./app_trace_store.js";
import { uiState } from "./app_ui_state.js";

const { byId, $, $$ } = dom;
const fmt = format;

// --- Analytics charts on the shared canvas engine ------------------------
// app_chart_core.js loads with the traces view. One chart per card, kept
// across answers (setData) and resized by the engine itself, so a resize or
// a new answer redraws a canvas instead of rebuilding an SVG; the cursor,
// the tooltip and the drag-to-zoom are the engine's (Grafana-like), shared
// by the two charts and the heatmap (one crosshair on the same time axis).
const CHART_HEIGHT = 196;
const CHART_SYNC_KEY = "traces-analytics";
const mountedCharts = new WeakMap(); // card body -> { kind, chart }

// The chart of kind `kind` in `container` with these options: the same
// chart redrawn, or a new one replacing what the card shows.
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

// retry: "analytics" or "durations" adds a Retry button (handled by the
// search view's click listener, init).
function chartMessage(container, text, isError = false, retry = "") {
  if (!container) return;
  unmountChart(container);
  const state = uiState;
  container.innerHTML = isError
    ? state.errorHtml({ body: text, compact: true, retry: retry ? { attrs: { "data-chart-retry": retry } } : null })
    : state.emptyHtml({ body: text, compact: true });
}

export { CHART_SYNC_KEY, chartMessage, mountChart, mountedCharts, unmountChart, zoomSearchRange };
