// Two charts are above the result list.
// The first chart shows the traces per bucket by service. The second chart shows the duration of the traces.
// The second chart is a scatter with its percentiles, or the heatmap.

import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { storage } from "./app_state.js";
import { CHART_SYNC_KEY, chartMessage, mountChart, mountedCharts, zoomSearchRange } from "./app_trace_charts.js";
import { bucketGrid, durationAxis, parseStartMs, traceName } from "./app_trace_model.js";
import { traceHeatmap } from "./app_trace_heatmap.js";
import { actions, model } from "./app_trace_store.js";
import { uiState } from "./app_ui_state.js";

const { byId, $, $$ } = dom;
const fmt = format;

function renderServiceChart() {
  const container = dom.traceServiceChart;
  if (!container) return;
  const a = model.analytics;
  const points = a?.trace_count_chart || [];
  const range = a?.range || [0, 1];
  const bucketMs = Math.max(1000, Number(a?.bucket_ms || 60000));
  const start = Number(range[0] || 0), end = Math.max(start + 1000, Number(range[1] || start + bucketMs));
  // Each bucket has a key that is its start on the server grid. The grid is anchored at the local midnight sent as bucket_origin_ms.
  // The buckets are placed by time. A range that does not start on the grid still shows every bucket.
  const buckets = points
    .map((point) => [Number(point?.[0] || 0), Number(point?.[1] || 0)])
    .filter(([bucket, count]) => count > 0 && bucket + bucketMs > start && bucket <= end)
    .sort((x, y) => x[0] - y[0]);
  if (!buckets.length) { chartMessage(container, "No matching traces in this range."); return; }
  const grid = bucketGrid(buckets, bucketMs);
  const xs = new Float64Array(grid.starts.length);
  const values = new Float64Array(grid.starts.length);
  for (let i = 0; i < xs.length; i += 1) xs[i] = grid.starts[i] + bucketMs / 2;
  buckets.forEach(([, count], k) => { values[grid.slot[k]] += count; });
  mountChart(container, "counts", {
    xKind: "time", xs, xDomain: [start, end], zoom: null,
    series: [{ id: "traces", label: "Matching traces", color: "var(--accent-fill)", values, nulls: null }],
    type: "bar", legend: false, syncKey: CHART_SYNC_KEY,
    bucketMs, bucketAlign: "center",
    formatValue: (value) => fmt.count(value),
    formatY: (value) => fmt.count(Math.max(0, value)),
    onZoom: (zoomed, fromUser) => { if (fromUser && zoomed) zoomSearchRange(zoomed); },
  });
  if (dom.traceServiceChartMeta) {
    const fromIndex = a.trace_count_source === "trace_index";
    dom.traceServiceChartMeta.textContent = `${fmt.duration.fromMs(bucketMs)} buckets · ${fromIndex ? "trace index" : "spans"}`;
    dom.traceServiceChartMeta.title = fromIndex
      ? "Counted from the trace index (each trace at its first span start). Exact span counts replace it once the duration percentiles are computed."
      : "Traces with at least one matching span in the range, each counted at its first span start.";
  }
}

// The legend choices (shown or hidden percentiles) are kept across new answers.
// P50 and P99 show by default. P90 and P95 are one legend click away.
let durationHidden = ["p90", "p95"];
// The listed traces of the scatter are in the order of its x column (start).
let scatterTraces = [];

function renderDurationChart() {
  const container = dom.traceDurationChart;
  if (!container) return;
  // Heatmap mode (app_trace_heatmap.js) draws the card itself.
  if (traceHeatmap.active()) { traceHeatmap.render(); return; }
  const a = model.analytics;
  if (a && !a.has_durations) {
    if (model.durationsError) chartMessage(container, model.durationsError, true, "durations");
    else chartMessage(container, "Computing duration percentiles\u2026");
    if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = "P50 / P90 / P95 / P99";
    return;
  }
  const qs = (a?.duration_quantiles || []).map((q) => q.map(Number)).sort((x, y) => x[0] - y[0]);
  if (!qs.length) { chartMessage(container, "No trace durations in this range."); return; }
  const range = a?.range || [qs[0][0], qs[qs.length - 1][0]];
  const xMin = Number(range[0] || 0), xMax = Math.max(xMin + 1000, Number(range[1] || xMin + 1000));
  const qBucketMs = Math.max(1000, Number(a.quantile_bucket_ms || a.bucket_ms || 60000));
  // The percentiles use the bucket grid. Lines break over buckets without traces (NULL).
  // A lone bucket shows as a dot.
  const grid = bucketGrid(qs, qBucketMs);
  const n = grid.starts.length;
  const xs = new Float64Array(n);
  const nulls = new Uint8Array(n).fill(1);
  const columns = [1, 2, 3, 4].map(() => new Float64Array(n).fill(NaN));
  for (let i = 0; i < n; i += 1) xs[i] = grid.starts[i] + qBucketMs / 2;
  qs.forEach((q, k) => {
    const i = grid.slot[k];
    nulls[i] = 0;
    for (let c = 0; c < 4; c += 1) columns[c][i] = Number.isFinite(q[c + 1]) ? q[c + 1] : NaN;
  });
  // This follows Jaeger's scatter plot. It draws one dot per listed trace.
  // The x value is the start, and the y value is the duration. The radius depends on the span count. Errors make the dot red.
  // The dots are drawn over the percentiles.
  scatterTraces = (model.traces || [])
    .filter((trace) => Number(trace.start_ms) > 0 && Number.isFinite(Number(trace.duration_ns)))
    .sort((p, q) => Number(p.start_ms) - Number(q.start_ms));
  const dotXs = new Float64Array(scatterTraces.map((trace) => Number(trace.start_ms)));
  const dotYs = new Float64Array(scatterTraces.map((trace) => Number(trace.duration_ns)));
  const spanCounts = scatterTraces.map((trace) => Number(trace.span_count || 0));
  const spanMin = Math.min(...spanCounts), spanMax = Math.max(...spanCounts);
  const radius = new Float64Array(spanCounts.map((spans) => (spanMax > spanMin ? 2.5 + 6.5 * ((spans - spanMin) / (spanMax - spanMin)) : 3.5)));
  const series = [["p50", "P50"], ["p90", "P90"], ["p95", "P95"], ["p99", "P99"]].map(([id, label], c) => ({ id, label, color: palette.quantile(id), values: columns[c], nulls }));
  if (scatterTraces.length) {
    series.unshift({
      id: "traces", label: "Listed traces", type: "points", xs: dotXs, values: dotYs, radius, color: "var(--trace-dot)", pickable: true,
      pointColor: (i) => (Number(scatterTraces[i].error_count || 0) > 0 ? "var(--danger)" : null),
    });
  }
  const traceAt = (hit) => (hit?.seriesId === "traces" ? scatterTraces[hit.index] : null);
  mountChart(container, "percentiles", {
    xKind: "time", xs, xDomain: [xMin, xMax], zoom: null, series, type: "line", fill: false,
    hidden: durationHidden, onHiddenChange: (hidden) => { durationHidden = [...hidden]; },
    legend: true, syncKey: CHART_SYNC_KEY, tooltipNulls: false,
    // This code uses Jaeger's ['auto', 'auto'] domain with whole duration steps.
    yAxis: (yMin, yMax) => {
      const durationScaleAxis = durationAxis(yMin, yMax, 7);
      return { min: durationScaleAxis.axisMin, max: durationScaleAxis.axisMax, ticks: durationScaleAxis.values.map((tick) => ({ v: tick.value, label: tick.label })) };
    },
    bucketMs: qBucketMs, bucketAlign: "center",
    formatValue: (value) => fmt.duration(value),
    formatY: (value) => fmt.duration(Math.max(0, value)),
    pickTooltip: (hit) => {
      const trace = traceAt(hit);
      if (!trace) return null;
      const ms = parseStartMs(trace.start_ms);
      const errors = Number(trace.error_count || 0);
      const rows = [
        { label: "Spans", value: fmt.count(Number(trace.span_count || 0)) },
        { label: "Services", value: fmt.count((trace.service_stats || []).length) },
      ];
      if (errors) rows.push({ label: "Errors", value: fmt.count(errors), className: "is-error", color: "var(--danger)" });
      rows.push({ label: "Duration", value: fmt.duration(trace.duration_ns) });
      rows.push({ label: "Start", value: fmt.time(ms) });
      return { title: traceName(trace), rows, footer: "Click to open the trace" };
    },
    onPick: (hit) => { const trace = traceAt(hit); if (trace) actions.loadTrace(trace.trace_id, { push: true }); },
    onZoom: (zoomed, fromUser) => { if (fromUser && zoomed) zoomSearchRange(zoomed); },
  });
  if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = `${scatterTraces.length ? `${fmt.count(scatterTraces.length)} listed trace${scatterTraces.length === 1 ? "" : "s"} + ` : ""}P50 / P90 / P95 / P99 · ${fmt.duration.fromMs(qBucketMs)} buckets`;
}

// This hook gives the scatter dots as drawn, in client coordinates. Tests and debugging use it.
function scatterDots() {
  const held = dom.traceDurationChart && mountedCharts.get(dom.traceDurationChart);
  if (!held || held.kind !== "percentiles") return [];
  const box = $(".chartCore__plot", held.chart.root).getBoundingClientRect();
  return held.chart.points("traces").map((dot) => {
    const trace = scatterTraces[dot.index];
    return { trace_id: trace.trace_id, error: Number(trace.error_count || 0) > 0, spans: Number(trace.span_count || 0), x: box.left + dot.x, y: box.top + dot.y, r: dot.r };
  });
}

// This code remembers whether meta enables analytics for the head script of the next page load (see observability.html).
// It drops the early class when meta is known.
function rememberAnalyticsEnabled(enabled) {
  storage.pref(storage.KEYS.traceAnalytics, false).set(enabled);
  document.documentElement.classList.remove("chdash-trace-analytics");
}

function renderAnalytics() {
  const enabled = model.meta?.analytics_enabled === true;
  if (model.meta) rememberAnalyticsEnabled(enabled);
  if (dom.traceAnalyticsGrid) dom.traceAnalyticsGrid.hidden = !enabled;
  // The state is busy from the first chart request of the search to its last answer.
  uiState.busy(dom.traceAnalyticsGrid, enabled && model.analyticsLoading);
  if (!enabled) return;
  // The heatmap loads on its own. The states of the count chart do not apply to it.
  const heatmap = traceHeatmap.active() === true;
  if (model.analyticsLoading && !model.analytics) {
    chartMessage(dom.traceServiceChart, "Loading trace activity\u2026");
    if (heatmap) renderDurationChart(); else chartMessage(dom.traceDurationChart, "Loading duration distribution\u2026");
    return;
  }
  if (model.analyticsError && !model.analytics) {
    chartMessage(dom.traceServiceChart, model.analyticsError, true, "analytics");
    if (heatmap) renderDurationChart(); else chartMessage(dom.traceDurationChart, model.analyticsError, true, "analytics");
    return;
  }
  if (!model.analytics) {
    chartMessage(dom.traceServiceChart, "Search to load matching trace activity.");
    if (heatmap) renderDurationChart(); else chartMessage(dom.traceDurationChart, "Search to load duration distribution.");
    return;
  }
  renderServiceChart();
  renderDurationChart();
}

export { renderAnalytics, renderDurationChart, scatterDots };
