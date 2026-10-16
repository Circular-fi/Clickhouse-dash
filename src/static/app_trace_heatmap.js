// This file draws the duration heatmap and the box-select comparison ("why is this slow").
// It follows HyperDX's DBSearchHeatmapChart and DBDeltaChart. The heatmap is an alternative mode of the "Trace duration" card.
// The x axis is the trace start (the time buckets of the analytics). The y axis is the log-scaled trace duration.
// The colour shows the traces per cell.
//
// To compare traces, drag a box or use the arrow keys with Enter.
// The comparison shows the traces inside the box against the other traces of that time (GET /api/traces/deltas).
// For each attribute, it shows the share of each side's sampled traces that have a span with each value.
// A value click adds a filter chip (app_trace_search.js).
// The "Search traces in this box" button sets the range and the trace duration filter, and then searches.
//
// The file app_traces.js calls init() once.

import { api } from "./app_api.js";
import { chartCore } from "./app_chart_core.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { obsView } from "./app_obs_view.js";
import { palette } from "./app_palette.js";
import { storage } from "./app_state.js";
import { timeRange } from "./app_timerange.js";
import { CHART_SYNC_KEY, chartMessage, mountChart, unmountChart } from "./app_trace_charts.js";
import { durationAxis } from "./app_trace_model.js";
import { traceSearch } from "./app_trace_search.js";
import { actions, address, currentHost, esc, model } from "./app_trace_store.js";
import { icon } from "./app_ui_icon.js";
import { segmented } from "./app_ui_segmented.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const modePref = () => storage.pref(storage.KEYS.traceDurationView, "percentiles", { allowed: MODES });
const MODES = ["percentiles", "heatmap"];
const HEAT_LEVELS = 8;
const { byId, $ } = dom;

let geo = null;
let chart = null;
const hm = {
  mode: readMode(),
  filters: null,
  data: null,
  dataKey: "",
  loading: false,
  error: "",
  // { c0, c1, r0, r1, t0, t1, d0, d1 (ns), estimate }
  selection: null,
  cursor: null,
  anchor: null,
  drag: null,
};
const deltas = { data: null, loading: false, error: "", baseline: "outside" };

function readMode() {
  return modePref().get();
}

function storeMode(mode) {
  modePref().set(mode);
}

const fmt = format;
const active = () => hm.mode === "heatmap";

function filtersKey(filters) {
  return JSON.stringify(filters || {});
}

// ------------------------------------------------------------ mode + URL

function syncToggle() {
  segmented?.set($(".traceDurationViews"), hm.mode, "durationView");
  const chart = dom.traceDurationChart;
  if (!chart) return;
  if (active()) {
    chart.setAttribute("tabindex", "0");
    chart.setAttribute("role", "application");
    chart.setAttribute("aria-roledescription", "heatmap");
    chart.setAttribute("aria-label", "Trace duration heatmap. Arrow keys move between cells, Shift with arrow keys extends a box, Enter compares the box, Escape clears it.");
    chart.classList.add("traceChart--heatmap");
  } else {
    for (const name of ["tabindex", "role", "aria-roledescription", "aria-label"]) chart.removeAttribute(name);
    chart.classList.remove("traceChart--heatmap");
  }
}

function setMode(mode, { persist = true, url = true } = {}) {
  const next = MODES.includes(mode) ? mode : "percentiles";
  if (persist) storeMode(next);
  if (next === hm.mode) { syncToggle(); return; }
  hm.mode = next;
  syncToggle();
  hideTooltip();
  if (url && !/\/observability\/traces\/[^/]+\/?$/.test(String(window.location.pathname || ""))) address.replace();
  if (active()) {
    if (hm.filters && hm.dataKey !== filtersKey(hm.filters)) void load();
    else render();
  } else {
    renderPanel();
    actions.loadDurations();
  }
}

// This code reads the search state from a URL. The URL can contain duration_view=heatmap.
// Without that parameter, a page load uses the remembered mode.
function applyParams(params, { initial = false } = {}) {
  const value = params.get("duration_view");
  const mode = MODES.includes(value) ? value : initial ? readMode() : "percentiles";
  if (initial) { hm.mode = mode; syncToggle(); return; }
  setMode(mode, { persist: false, url: false });
}

function writeParams(params) {
  if (active()) params.set("duration_view", "heatmap");
}

// ---------------------------------------------------------------- loading

// Every search uses the new filters. The old box no longer applies.
function onSearch(filters) {
  hm.filters = { ...(filters || {}) };
  clearSelection({ render: false });
  if (active()) void load();
  else { hm.data = null; hm.dataKey = ""; }
}

async function load() {
  if (!hm.filters) return;
  const req = obsView.read("traces.heatmap");
  const key = filtersKey(hm.filters);
  hm.loading = true;
  hm.error = "";
  hm.data = null;
  hm.dataKey = key;
  render();
  try {
    const data = await api.getTraceHeatmap(currentHost(), hm.filters, { signal: req.signal });
    if (!req.isCurrent()) return;
    hm.data = data;
  } catch (error) {
    if (!req.isCurrent()) return;
    hm.error = util.errorText(error);
    hm.dataKey = "";
  } finally {
    if (req.isCurrent()) {
      hm.loading = false;
      if (active()) render();
    }
  }
}

// ---------------------------------------------------------------- scales

function niceLogTicks(lo, hi) {
  if (hi / lo >= 8) return chartCore.logTicks(lo, hi);
  const axis = durationAxis(lo, hi, 4);
  return axis.values.map((tick) => tick.value).filter((value) => value >= lo && value <= hi);
}

function level(count, max) {
  if (!(count > 0)) return 0;
  if (max <= 1) return HEAT_LEVELS;
  return Math.max(1, Math.min(HEAT_LEVELS, Math.ceil((Math.log1p(count) / Math.log1p(max)) * HEAT_LEVELS)));
}

function traceCount(n) {
  return `${fmt.count(n)} trace${Number(n) === 1 ? "" : "s"}`;
}

function rowRangeLabel(r0, r1) {
  const lo = r0 === 0 && Number(hm.data?.below_min_count || 0) > 0 ? `\u2264 ${fmt.duration(geo.edges[1])}` : null;
  if (lo && r1 === 0) return lo;
  return `${r0 === 0 && lo ? "0" : fmt.duration(geo.edges[r0])} \u2013 ${fmt.duration(geo.edges[r1 + 1])}`;
}

// ---------------------------------------------------------------- render

// The one-hue ramp comes from ns.palette. It has one step per level.
const PALETTE = Array.from({ length: HEAT_LEVELS }, (_, i) => palette.sequential(i / (HEAT_LEVELS - 1)));

// The heatmap draws on the shared canvas engine (app_chart_core.js).
// Each cell is one canvas rect. The log duration axis uses the uneven bin edges of the server.
// The engine's 2-D brush draws the box. DOM regions show the selection and the keyboard cursor.
// These regions move without a redraw.
function render() {
  const container = dom.traceDurationChart;
  if (!container || !active()) return;
  syncToggle();
  const meta = dom.traceDurationChartMeta;
  const data = hm.data;
  geo = null;
  chart = null;
  if (hm.loading || (!data && !hm.error && hm.filters)) {
    chartMessage(container, "Loading duration heatmap\u2026");
    if (meta) meta.textContent = "Traces per cell";
    renderPanel();
    return;
  }
  if (hm.error) {
    unmountChart(container);
    container.innerHTML = uiState.errorHtml({ body: hm.error, compact: true, retry: { attrs: { "data-heatmap-retry": "" } } });
    $("[data-heatmap-retry]", container)?.addEventListener("click", () => { void load(); });
    renderPanel();
    return;
  }
  if (!data) { chartMessage(container, "Search to load the duration heatmap."); renderPanel(); return; }
  const cells = (Array.isArray(data.cells) ? data.cells : []).map((cell) => cell.map(Number));
  const edges = (Array.isArray(data.y_edges_ns) ? data.y_edges_ns : []).map(Number);
  const rows = Math.max(0, Number(data.rows || 0));
  if (!cells.length || rows < 1 || edges.length !== rows + 1) {
    chartMessage(container, "No trace durations in this range.");
    if (meta) meta.textContent = "Traces per cell";
    renderPanel();
    return;
  }
  const range = Array.isArray(data.range) ? data.range.map(Number) : [0, 1];
  const xMin = range[0], xMax = Math.max(range[0] + 1000, range[1]);
  const bucketMs = Math.max(1000, Number(data.bucket_ms || 60000));
  const origin = Number(data.bucket_origin_ms || 0);
  const gridStart = origin + Math.floor((xMin - origin) / bucketMs) * bucketMs;
  const cols = Math.max(1, Math.ceil((xMax - gridStart) / bucketMs));
  const lo = edges[0], hi = edges[rows];
  const maxCount = Math.max(1, Number(data.max_count || 0), ...cells.map((cell) => cell[2]));
  const counts = new Map();
  const colStart = (col) => gridStart + col * bucketMs;
  geo = { xMin, xMax, bucketMs, gridStart, cols, rows, edges, counts, maxCount, colStart };
  const n = cells.length;
  const box = { x0: new Float64Array(n), x1: new Float64Array(n), y0: new Float64Array(n), y1: new Float64Array(n), level: new Uint8Array(n), palette: PALETTE };
  cells.forEach(([bucket, row, count], k) => {
    const col = Math.round((bucket - gridStart) / bucketMs);
    counts.set(`${col}:${row}`, count);
    box.x0[k] = bucket;
    box.x1[k] = bucket + bucketMs;
    box.y0[k] = edges[row];
    box.y1[k] = edges[row + 1];
    box.level[k] = level(count, maxCount);
  });
  // Use one x value per column. The cursor snaps to columns.
  // The crosshair is shared with the count chart.
  const xs = new Float64Array(cols);
  for (let col = 0; col < cols; col += 1) xs[col] = colStart(col) + bucketMs / 2;
  const ticks = niceLogTicks(lo, hi).map((value) => ({ v: value, label: fmt.duration(value) }));
  chart = mountChart(container, "heatmap", {
    xKind: "time", xs, xDomain: [xMin, xMax], zoom: null, series: [], type: "line", legend: false,
    syncKey: CHART_SYNC_KEY, keyboard: false, zoomable: false,
    yScale: "log", yAxis: () => ({ min: lo, max: hi, ticks }),
    cells: box,
    bucketMs, bucketAlign: "center",
    formatY: (value) => fmt.duration(value),
    pick: (pt) => { const cell = cellAt(pt.x, pt.y); return { key: `${cell.col}:${cell.row}`, cell, x: colStart(cell.col) + bucketMs / 2 }; },
    pickTooltip: (hit) => cellTooltip(hit.cell),
    brush: "xy", brushClass: "traceHeatDrag",
    brushSnap: (r) => boxRange(boxOf(cellAt(r.x0, r.y0), cellAt(r.x1, r.y1))),
    brushTooltip: (r) => boxTooltip(r.box),
    onBrush: (r) => { hm.anchor = null; hm.cursor = null; select(r.box); },
    regions: regions(),
  });
  let legend = $(":scope > .traceHeatLegend", container);
  if (!legend) {
    legend = document.createElement("div");
    legend.className = "traceChartLegend traceHeatLegend";
    container.append(legend);
  }
  const rampHtml = Array.from({ length: HEAT_LEVELS }, (_, i) => `<i class="lvl-${i + 1}" style="background:${PALETTE[i]}"></i>`).join("");
  legend.innerHTML = `<span class="traceHeatLegend__label">Traces per cell</span><span class="traceHeatLegend__scale"><span>1</span><span class="traceHeatLegend__ramp" aria-hidden="true">${rampHtml}</span><span data-heat-max>${esc(fmt.count(maxCount))}</span></span><span class="traceHeatLegend__hint">Drag a box to compare its traces</span>`;
  container.dataset.heatRows = String(rows);
  container.dataset.heatCols = String(cols);
  if (meta) {
    meta.textContent = `${traceCount(Number(data.total || 0))} · ${fmt.duration.fromMs(bucketMs)} × log duration`;
    meta.title = String(data.unit_label || "Traces with a matching span, at their first span start");
  }
  renderPanel();
}

// ------------------------------------------------------- hit testing

// Find the cell at a time (ms) and a duration (ns). The result is clamped to the grid.
function cellAt(ms, value) {
  const col = Math.max(0, Math.min(geo.cols - 1, Math.floor((Math.min(ms, geo.xMax - 1e-6) - geo.gridStart) / geo.bucketMs)));
  let row = 0;
  while (row < geo.rows - 1 && value >= geo.edges[row + 1]) row += 1;
  return { col, row };
}

function boxOf(a, b) {
  return { c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col), r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row) };
}

// This describes a box of cells in data units. It uses the engine's regions and brush.
function boxRange(box) {
  return { x0: geo.colStart(box.c0), x1: geo.colStart(box.c1 + 1), y0: geo.edges[box.r0], y1: geo.edges[box.r1 + 1], box };
}

function boxCount(box) {
  let sum = 0;
  for (let col = box.c0; col <= box.c1; col += 1) for (let row = box.r0; row <= box.r1; row += 1) sum += geo.counts.get(`${col}:${row}`) || 0;
  return sum;
}

function cellText(cell) {
  const count = geo.counts.get(`${cell.col}:${cell.row}`) || 0;
  return { when: fmt.range(geo.colStart(cell.col), geo.colStart(cell.col) + geo.bucketMs), duration: rowRangeLabel(cell.row, cell.row), count };
}

// This section handles the selection, the keyboard cursor and the keyboard box.
function regions() {
  if (!geo) return [];
  const inGrid = (box) => box && box.c1 < geo.cols && box.r1 < geo.rows;
  const sel = inGrid(hm.selection) ? hm.selection : null;
  const cursor = hm.cursor && hm.cursor.col < geo.cols && hm.cursor.row < geo.rows ? boxOf(hm.cursor, hm.cursor) : null;
  const brush = cursor && hm.anchor ? boxOf(hm.anchor, hm.cursor) : null;
  const region = (id, className, box) => (box ? { id, className, ...boxRange(box) } : { id, className, hidden: true });
  return [region("selection", "traceHeatSelection", sel), region("brush", "traceHeatBrush", brush), region("cursor", "traceHeatCursor", cursor)];
}

function drawSelection() {
  if (!chart || !geo) return;
  chart.setRegions(regions());
  dom.traceDurationChart?.classList.toggle("has-selection", !!hm.selection);
}

const drawCursor = drawSelection;

// ------------------------------------------------------- tooltip

function hideTooltip() {
  chart?.hideTooltip();
}

function cellTooltip(cell) {
  const text = cellText(cell);
  return { title: traceCount(text.count), rows: [{ label: "Start", value: text.when }, { label: "Duration", value: text.duration }] };
}

function boxTooltip(box) {
  return {
    title: `\u2248 ${traceCount(boxCount(box))} in the box`,
    rows: [
      { label: "Start", value: fmt.range(geo.colStart(box.c0), geo.colStart(box.c0) + (box.c1 - box.c0 + 1) * geo.bucketMs) },
      { label: "Duration", value: rowRangeLabel(box.r0, box.r1) },
    ],
  };
}

// ------------------------------------------------------- keys

// The keyboard can reach a cell or a box. The page announces it through the one live region.
function announce(text) {
  uiState.announce(text);
}

function onKeydown(event) {
  if (!active() || !geo || !chart || event.target !== dom.traceDurationChart) return;
  const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  if (moves[event.key]) {
    event.preventDefault();
    const [dc, dr] = moves[event.key];
    const from = hm.cursor || { col: geo.cols - 1, row: Math.floor(geo.rows / 2) };
    if (event.shiftKey && !hm.anchor) hm.anchor = { ...from };
    if (!event.shiftKey) hm.anchor = null;
    hm.cursor = hm.cursor
      ? { col: Math.max(0, Math.min(geo.cols - 1, from.col + dc)), row: Math.max(0, Math.min(geo.rows - 1, from.row + dr)) }
      : from;
    drawCursor();
    const box = hm.anchor ? boxOf(hm.anchor, hm.cursor) : null;
    // Place the tooltip next to the lower right corner of the cell.
    const L = chart.layout();
    if (L) chart.showTooltip(box ? boxTooltip(box) : cellTooltip(hm.cursor), L.xOf(geo.colStart(hm.cursor.col + 1)), L.yOf(geo.edges[hm.cursor.row]));
    const text = cellText(hm.cursor);
    announce(box ? `Box of ${traceCount(boxCount(box))}` : `${text.when}, ${text.duration}: ${traceCount(text.count)}`);
  } else if ((event.key === "Enter" || event.key === " ") && hm.cursor) {
    event.preventDefault();
    const box = boxOf(hm.anchor || hm.cursor, hm.cursor);
    hm.anchor = null;
    hideTooltip();
    select(box);
    drawCursor();
  } else if (event.key === "Escape") {
    if (!hm.selection && !hm.cursor) return;
    event.preventDefault();
    hm.anchor = null;
    hm.cursor = null;
    hideTooltip();
    drawCursor();
    clearSelection();
  }
}

// This hook gives the grid as drawn, with the cells in client coordinates.
// The cells are clipped to the plot, as their canvas rects are.
function inspect() {
  if (!chart || !geo || !chart.layout()) return null;
  const cells = [];
  const lo = chart.toClient(geo.xMin, geo.edges[0]).x, hi = chart.toClient(geo.xMax, geo.edges[0]).x;
  for (const [key, count] of geo.counts) {
    const [col, row] = key.split(":").map(Number);
    const a = chart.toClient(geo.colStart(col), geo.edges[row + 1]);
    const b = chart.toClient(geo.colStart(col + 1), geo.edges[row]);
    const x0 = Math.max(lo, a.x), x1 = Math.min(hi, b.x);
    if (x1 > x0) cells.push({ col, row, count, level: level(count, geo.maxCount), x: x0, y: a.y, width: x1 - x0, height: b.y - a.y });
  }
  // The state is settled. The cells are where the canvas shows them now, and no redraw is due.
  return { rows: geo.rows, cols: geo.cols, maxCount: geo.maxCount, ticks: JSON.parse(chart.root.dataset.yTicks || "[]"), cells, settled: !chart.drawPending() };
}

// ------------------------------------------------------- selection

function select(box) {
  if (!geo) return;
  const t0 = Math.max(geo.xMin, geo.colStart(box.c0));
  const t1 = Math.min(geo.xMax, geo.colStart(box.c1 + 1));
  // The lowest row also holds the traces faster than its lower edge.
  const d0 = box.r0 === 0 ? 0 : geo.edges[box.r0];
  const d1 = geo.edges[box.r1 + 1];
  hm.selection = { ...box, t0, t1, d0, d1, estimate: boxCount(box) };
  drawSelection();
  announce(`Selected ${traceCount(hm.selection.estimate)}; comparison below the charts.`);
  void loadDeltas();
}

function clearSelection({ render: redraw = true } = {}) {
  util.latest.cancel("traces.deltas");
  hm.selection = null;
  deltas.data = null;
  deltas.loading = false;
  deltas.error = "";
  if (redraw) { drawSelection(); renderPanel(); }
}

async function loadDeltas() {
  const sel = hm.selection;
  if (!sel || !hm.filters) return;
  const req = obsView.read("traces.deltas");
  deltas.loading = true;
  deltas.error = "";
  deltas.data = null;
  renderPanel();
  try {
    const data = await api.getTraceDeltas(currentHost(), {
      ...hm.filters,
      t0: String(Math.round(sel.t0)), t1: String(Math.round(sel.t1)),
      d0: String(sel.d0 / 1e6), d1: String(sel.d1 / 1e6),
      baseline: deltas.baseline,
    }, { signal: req.signal });
    if (!req.isCurrent()) return;
    deltas.data = data;
  } catch (error) {
    if (!req.isCurrent()) return;
    deltas.error = util.errorText(error);
  } finally {
    if (req.isCurrent()) {
      deltas.loading = false;
      renderPanel();
    }
  }
}

// Show three significant digits. Round outwards, so that the box keeps its traces.
function roundMs(ms, up) {
  if (!(ms > 0)) return 0;
  const scale = 10 ** (Math.floor(Math.log10(ms)) - 2);
  const value = (up ? Math.ceil(ms / scale) : Math.floor(ms / scale)) * scale;
  return Number(value.toPrecision(3));
}

function searchInBox() {
  const sel = hm.selection;
  if (!sel) return;
  if (model.meta?.features?.duration_filter !== false) {
    traceSearch.setDuration({ min: roundMs(sel.d0 / 1e6, false), max: roundMs(sel.d1 / 1e6, true) });
  }
  const format = timeRange?.formatDateTime;
  if (!format) return;
  void actions.applyRange({ from: format(Math.floor(sel.t0 / 1000) * 1000), to: format(Math.ceil(sel.t1 / 1000) * 1000) }, "heatmap");
}

// ------------------------------------------------------- comparison panel

// The shares of the selection and the baseline are in percent (0-100).
const pct = (value) => fmt.percent(Math.max(0, Number(value || 0)) / 100);

const COLUMN_LABELS = { ServiceName: "service", SpanName: "operation", StatusCode: "status" };

function keyLabel(item) {
  return item.scope === "column" ? COLUMN_LABELS[item.key] || item.key : item.key;
}

function fieldOf(item) {
  if (item.field === "tag") return { kind: "tag", scope: item.scope === "resource" ? "resource" : "span", key: item.key };
  return { kind: item.field };
}

function cardHtml(item, index) {
  const label = keyLabel(item);
  const scope = item.scope === "column" ? "column" : item.scope;
  const values = (item.values || []).map((v, j) => {
    const text = v.value === "" ? '""' : v.value;
    const desc = `${label} = ${text}: ${pct(v.selection_pct)} of the selection, ${pct(v.baseline_pct)} of the baseline`;
    return `<li class="traceDeltaRow"><button type="button" class="traceDeltaRow__value" data-delta-filter="${index}:${j}" title="Filter for ${esc(`${label} = ${text}`)}" aria-label="Filter for ${esc(desc)}">${esc(text)}</button>`
      + `<span class="traceDeltaRow__bars" aria-hidden="true"><i class="is-selection" style="width:${Math.max(0, Math.min(100, Number(v.selection_pct || 0))).toFixed(1)}%"></i><i class="is-baseline" style="width:${Math.max(0, Math.min(100, Number(v.baseline_pct || 0))).toFixed(1)}%"></i></span>`
      + `<span class="traceDeltaRow__pct" aria-hidden="true"><b>${esc(pct(v.selection_pct))}</b><span>${esc(pct(v.baseline_pct))}</span></span>`
      + `<button type="button" class="traceDeltaRow__exclude" data-delta-exclude="${index}:${j}" title="Exclude this value" aria-label="Exclude ${esc(`${label} = ${text}`)}">${icon("ban", { size: "sm" })}</button></li>`;
  }).join("");
  return `<article class="traceDeltaCard" data-delta-key="${esc(`${item.scope}:${item.key}`)}"><header><span class="traceDeltaCard__scope traceDeltaCard__scope--${esc(scope)}">${esc(scope === "column" ? "field" : scope)}</span><strong title="${esc(item.key)}">${esc(label)}</strong><span class="traceDeltaCard__score" title="Largest gap between the selection and baseline shares of one value (percentage points)">\u0394 ${esc(Math.round(Math.max(0, Number(item.score || 0) - (item.boosted ? 2 : 0))))} pts</span></header><ul class="traceDeltaCard__values">${values}</ul></article>`;
}

function panelBodyHtml() {
  const ui = uiState;
  if (deltas.loading) return ui.loadingHtml({ label: "Comparing sampled traces of the box with the baseline\u2026", compact: true });
  if (deltas.error) return ui.errorHtml({ body: deltas.error, compact: true, retry: { attrs: { "data-delta-retry": "" } } });
  const data = deltas.data;
  if (!data) return "";
  if (!Number(data.selection?.sampled || 0)) return ui.emptyHtml({ body: "No traces in this box: select cells that hold traces.", compact: true });
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (!keys.length) {
    const hidden = (data.hidden_keys || []).length;
    return ui.emptyHtml({ body: `No attribute sets these traces apart from the baseline${hidden ? ` (${hidden} identifier or high-cardinality key${hidden === 1 ? "" : "s"} skipped)` : ""}.`, compact: true });
  }
  return `<div class="traceDeltaGrid">${keys.map(cardHtml).join("")}</div>`;
}

function sampleText(data) {
  if (!data) return "";
  const sel = data.selection || {}, base = data.baseline_sample || {};
  const baseline = data.baseline === "all" ? "all traces of that time" : "the other traces of that time";
  const sampled = data.window_sampled ? ` · time sampled as ${(data.sampled_windows || []).length} slices of ${fmt.duration.fromMs(Number(data.sampled_ms || 0) / Math.max(1, (data.sampled_windows || []).length))}` : "";
  return `${fmt.count(Number(sel.sampled || 0))} of ${traceCount(sel.traces || 0)} in the box vs ${fmt.count(Number(base.sampled || 0))} of ${traceCount(base.traces || 0)} (${baseline})${sampled}`;
}

function renderPanel() {
  const panel = byId("traceDeltaPanel");
  if (!panel) return;
  const sel = hm.selection;
  const show = active() && !!sel && model.meta?.analytics_enabled === true;
  panel.hidden = !show;
  if (!show) { panel.replaceChildren(); return; }
  const when = fmt.range(sel.t0, sel.t0 + Math.max(1, sel.t1 - sel.t0));
  const duration = sel.d0 > 0 ? `${fmt.duration(sel.d0)} \u2013 ${fmt.duration(sel.d1)}` : `\u2264 ${fmt.duration(sel.d1)}`;
  const durationFilter = model.meta?.features?.duration_filter !== false;
  panel.innerHTML = `<header class="traceDeltaPanel__head"><div class="traceDeltaPanel__title"><strong>Selection vs baseline</strong><span>Traces starting <b>${esc(when)}</b> lasting <b>${esc(duration)}</b></span></div>`
    + `<div class="traceDeltaPanel__actions"><label class="traceDeltaPanel__baseline"><span>Baseline</span><select data-delta-baseline aria-label="Baseline traces"><option value="outside"${deltas.baseline === "outside" ? " selected" : ""}>Other traces of that time</option><option value="all"${deltas.baseline === "all" ? " selected" : ""}>All traces of that time</option></select></label>`
    + `<button type="button" class="button button--small traceDeltaPanel__search" data-delta-search title="${esc(durationFilter ? "Search this time range with this trace duration range" : "Search this time range (duration filters are disabled)")}">Search traces in this box</button>`
    + '<button type="button" class="button button--small traceDeltaPanel__clear" data-delta-clear title="Clear the selection (Escape)">Clear selection</button></div></header>'
    + `<div class="traceDeltaPanel__meta"><span class="traceDeltaLegend"><span class="is-selection">Selection</span><span class="is-baseline">Baseline</span></span><span class="traceDeltaPanel__sample">${esc(deltas.data ? sampleText(deltas.data) : `\u2248 ${traceCount(sel.estimate)} in the box`)}</span></div>`
    + `<div class="traceDeltaPanel__body">${panelBodyHtml()}</div>`;
}

function valueAt(ref) {
  const [i, j] = String(ref || "").split(":").map(Number);
  const item = deltas.data?.keys?.[i];
  const value = item?.values?.[j];
  return item && value ? { item, value } : null;
}

function onPanelClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const filter = target.closest("[data-delta-filter]");
  const exclude = target.closest("[data-delta-exclude]");
  if (filter || exclude) {
    const hit = valueAt((filter || exclude).getAttribute(filter ? "data-delta-filter" : "data-delta-exclude"));
    if (!hit) return;
    const field = fieldOf(hit.item);
    if (filter) traceSearch.filter(field, hit.value.value);
    else traceSearch.exclude(field, hit.value.value);
  } else if (target.closest("[data-delta-search]")) {
    searchInBox();
  } else if (target.closest("[data-delta-clear]")) {
    clearSelection();
    dom.traceDurationChart?.focus?.({ preventScroll: true });
  } else if (target.closest("[data-delta-retry]")) {
    void loadDeltas();
  }
}

function onPanelChange(event) {
  const select = event.target instanceof Element ? event.target.closest("[data-delta-baseline]") : null;
  if (!select) return;
  deltas.baseline = select.value === "all" ? "all" : "outside";
  void loadDeltas();
}

// ---------------------------------------------------------------- wiring

function init() {
  // Percentiles | Heatmap is the shared segmented control (app_ui_segmented.js).
  segmented?.bind($(".traceDurationViews"), { attr: "durationView", onChange: (mode) => { setMode(mode); return false; } });
  dom.traceDurationChart?.addEventListener("keydown", onKeydown);
  // The canvas keeps the pointer. A press focuses the card for the keys.
  dom.traceDurationChart?.addEventListener("pointerdown", () => { if (active()) dom.traceDurationChart.focus({ preventScroll: true }); });
  dom.traceDurationChart?.addEventListener("blur", () => { if (hm.cursor && !hm.selection) { hm.cursor = null; hm.anchor = null; drawCursor(); } hideTooltip(); });
  byId("traceDeltaPanel")?.addEventListener("click", onPanelClick);
  byId("traceDeltaPanel")?.addEventListener("change", onPanelChange);
  syncToggle();
}

export const traceHeatmap = {
  init,
  active,
  setMode,
  applyParams,
  writeParams,
  onSearch,
  render,
  inspect,
  clearSelection: () => clearSelection(),
};
