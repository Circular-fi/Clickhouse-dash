// Services tab of the Traces page, after HyperDX's ServicesDashboardPage.
// It shows RED metrics (rate, errors and duration) of the entry spans of every service.
// The entry spans are SpanKind Server or Consumer spans, or root spans.
// The data comes from /api/traces/services.
//
// The view is a sortable table with sparklines.
// For each service, a detail panel shows the rate, error rate and latency charts.
// The panel also shows the release markers (first span of each service.version).
// It shows the most time-consuming endpoints, the slowest spans and the database statements (/api/traces/services/db).
// The range, pickers and chips of the search bar apply here as span filters of the entry spans.

import { api } from "./app_api.js";
import { chartCore } from "./app_chart_core.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { obsView } from "./app_obs_view.js";
import { palette } from "./app_palette.js";
import { timeRange } from "./app_timerange.js";
import { chartMessage, mountChart, unmountChart, zoomSearchRange } from "./app_trace_charts.js";
import { bucketGrid, durationAxis } from "./app_trace_model.js";
import { traceSearch } from "./app_trace_search.js";
import { actions, address, currentHost, esc, model, spanTraceUrl } from "./app_trace_store.js";
import { traceTabs } from "./app_trace_tabs.js";
import { badge } from "./app_ui_badge.js";
import { chartUi } from "./app_ui_chart.js";
import { detailPanel as detailPanelMod } from "./app_ui_panel.js";
import { segmented } from "./app_ui_segmented.js";
import { sqlBlock } from "./app_ui_sql.js";
import { stat as statMod } from "./app_ui_stat.js";
import { uiState } from "./app_ui_state.js";
import { table } from "./app_ui_table.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;

const SORT_KEYS = ["name", "rate", "errors", "p50", "p95", "p99", "time"];
const DEFAULT_SORT = { key: "time", dir: "desc" };
const DETAIL_CHART_HEIGHT = 150;

let root = null;
const fmt = format;

const view = {
  key: "",
  payload: null,
  loading: false,
  error: "",
  sort: { ...DEFAULT_SORT },
  scope: "entry",
  exact: false,
  detailName: "",
  detail: { key: "", payload: null, loading: false, error: "" },
  db: { key: "", payload: null, loading: false, error: "" },
  filters: null,
  searchKey: null,
};

// ------------------------------------------------------------ formatting

// The Retry of a failed request. The value is "list", "detail" or "db" (onClick).
// The state block of a failed step. The click listener of the view handles its Retry.
const failedHtml = (text, what) => uiState.errorHtml({ body: text, compact: true, retry: { attrs: { "data-svc-retry": what } } });
const emptyHtml = (text, options = {}) => uiState.emptyHtml({ body: text, compact: true, ...options });

// A request rate, in the largest unit where the value is 1 or more: 2.4/s, 29/min, 6/h.
const RATE_UNITS = [{ per: 1, suffix: "/s", word: "second" }, { per: 60, suffix: "/min", word: "minute" }, { per: 3600, suffix: "/h", word: "hour" }];
function rateUnit(perSecond) {
  const value = Number(perSecond);
  if (!Number.isFinite(value) || value <= 0) return RATE_UNITS[0];
  return RATE_UNITS.find((unit) => value * unit.per >= 1) || RATE_UNITS[RATE_UNITS.length - 1];
}

// The shared error-rate level of a percentage is set by ns.palette.errorLevel.
// Below 1 % the level is neutral. From 1 % to 5 % it is a warning. From 5 % it is a danger.
// The level sets the cell class and the tone of the stat tile.
const ERROR_CLASS = { neutral: "", warn: " is-errorWarn", danger: " is-errorDanger" };
const ERROR_TONE = { neutral: "", warn: "warn", danger: "error" };
const errorLevel = (pct) => palette.errorLevel((Number(pct) || 0) / 100);

function rateText(perSecond, unit = rateUnit(perSecond)) {
  const value = Number(perSecond);
  if (!Number.isFinite(value) || value <= 0) return `0${unit.suffix}`;
  return `${fmt.compact(value * unit.per)}${unit.suffix}`;
}

// Error rates and time shares are kept in percent (0-100).
const percentText = (value) => fmt.percent(Number(value || 0) / 100);

// The axis ticks of a detail chart (app_chart_core.js yAxis) are round values in [0, max].
// The table's own formatter labels each tick. The axis, the cursor readout, the tooltip and the table therefore share one unit and precision.
// Examples: "29/min" in the table, against "20/min, 40/min" on the axis. "1.21%" against "0.50%, 1%, 1.50%".
function unitAxis(yMax, label) {
  const ticks = chartCore.linearTicks(0, yMax > 0 ? yMax : 1, 4);
  const top = ticks.values[ticks.values.length - 1];
  const max = top < yMax ? yMax : top;
  return { min: 0, max, step: ticks.step, ticks: ticks.values.map((v) => ({ v, label: label(v) })) };
}

// The seconds of the window that a payload describes.
function windowSeconds(payload) {
  const range = Array.isArray(payload?.window) ? payload.window : payload?.range || [0, 1];
  return Math.max(1, (Number(range[1]) - Number(range[0])) / 1000);
}

function statsRow(row) {
  return {
    name: String(row?.[0] ?? ""),
    spans: Number(row?.[1] || 0),
    errors: Number(row?.[2] || 0),
    p50: Number(row?.[3] || 0),
    p95: Number(row?.[4] || 0),
    p99: Number(row?.[5] || 0),
    total: Number(row?.[6] || 0),
  };
}

function withRates(rows, payload) {
  const seconds = windowSeconds(payload);
  const total = rows.reduce((sum, row) => sum + row.total, 0) || 1;
  return rows.map((row) => ({ ...row, rate: row.spans / seconds, errorPct: row.spans ? (row.errors / row.spans) * 100 : 0, share: (row.total / total) * 100 }));
}

function seriesOf(payload, name) {
  const points = payload?.series?.[name];
  return (Array.isArray(points) ? points : []).map((p) => ({
    t: Number(p[0]), spans: Number(p[1] || 0), errors: Number(p[2] || 0), p50: Number(p[3] || 0), p95: Number(p[4] || 0), p99: Number(p[5] || 0),
  })).sort((a, b) => a.t - b.t);
}

function durationFilterEnabled() {
  return model.meta?.features?.duration_filter !== false;
}

// ------------------------------------------------------------ requests

function requestFilters(filters) {
  const out = { ...filters, bucket_origin_ms: String(timeRange.localMidnight(Number(filters.start_ms))), scope: view.scope };
  delete out.limit;
  if (view.exact) out.exact = "1";
  return out;
}

// Relative ranges are resolved again for every search.
// Within the same minute, the answer is reused (Back from a trace, tab switches).
function keyOf(params) {
  const { start_ms: startMs, end_ms: endMs, ...rest } = params;
  return JSON.stringify({ ...rest, minutes: timeRange.minuteKey(startMs, endMs) });
}

// force: an explicit search asks again, even within the same minute.
// An explicit search is the Search button, or a change of the scope / exact toggles.
async function run(filters, { force = false } = {}) {
  view.filters = filters;
  view.searchKey = traceSearch.searchKey() || "";
  const params = requestFilters(filters);
  const key = keyOf(params);
  if (!force && key === view.key && (view.payload || view.loading)) {
    render();
    if (view.detailName) void loadDetail();
    return;
  }
  view.key = key;
  const req = obsView.read("traces.services");
  view.loading = true;
  view.error = "";
  render();
  try {
    const payload = await api.getTraceServices(currentHost(), params, { signal: req.signal });
    if (!req.isCurrent()) return;
    view.payload = payload;
    palette.registerServices((payload?.services || []).map((row) => row[0]));
  } catch (error) {
    if (!req.isCurrent()) return;
    view.payload = null;
    view.error = util.errorText(error);
  } finally {
    if (req.isCurrent()) {
      view.loading = false;
      render();
    }
  }
  if (req.isCurrent() && view.detailName) void loadDetail();
}

async function loadDetail() {
  const name = view.detailName;
  if (!name || !view.filters) return;
  const params = { ...requestFilters(view.filters), detail: name };
  const key = keyOf(params);
  const detail = view.detail;
  if (detail.key === key && (detail.payload || detail.loading)) { renderDetail(); return; }
  detail.key = key;
  const req = obsView.read("traces.services.detail");
  detail.loading = true;
  detail.error = "";
  detail.payload = null;
  renderDetail();
  void loadDb(params);
  try {
    const payload = await api.getTraceServices(currentHost(), params, { signal: req.signal });
    if (!req.isCurrent()) return;
    detail.payload = payload;
  } catch (error) {
    if (!req.isCurrent()) return;
    detail.error = util.errorText(error);
  } finally {
    if (req.isCurrent()) {
      detail.loading = false;
      renderDetail();
    }
  }
}

async function loadDb(params) {
  const db = view.db;
  const dbParams = { ...params };
  delete dbParams.exact;
  delete dbParams.scope;
  delete dbParams.bucket_origin_ms;
  const key = keyOf(dbParams);
  if (db.key === key && (db.payload || db.loading)) return;
  db.key = key;
  const req = obsView.read("traces.services.db");
  db.loading = true;
  db.error = "";
  db.payload = null;
  try {
    const payload = await api.getTraceServicesDb(currentHost(), dbParams, { signal: req.signal });
    if (!req.isCurrent()) return;
    db.payload = payload;
  } catch (error) {
    if (!req.isCurrent()) return;
    db.error = util.errorText(error);
  } finally {
    if (req.isCurrent()) {
      db.loading = false;
      renderDetail();
    }
  }
}

// ------------------------------------------------------------- the table

function sortRows(rows) {
  const { key, dir } = view.sort;
  const value = (row) => ({ name: row.name, rate: row.rate, errors: row.errorPct, p50: row.p50, p95: row.p95, p99: row.p99, time: row.total }[key]);
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = value(a), y = value(b);
    if (key === "name") return sign * (x < y ? -1 : x > y ? 1 : 0);
    return sign * (x - y) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

// The shared sparkline (chartUi.sparkline) draws the series over the searched range.
// It draws a neutral line, with no area. A noisy series filled in grey looks like a box behind the line, in the light theme above all.
// The sparkline is bound to the data. It has no zero baseline. The range ends are gaps. A P95 of a bucket without spans is no value.
// It is labelled with its peak, because each row has its own scale.
//
// Only anomalies take a colour, and at most the three worst of a row.
// A request bucket takes a colour at the shared error-rate thresholds (palette.errorLevel: amber from 1 %, red from 5 %) with two errors or more.
// A P95 bucket takes the accent colour when it is above twice the median of the row.
const SPIKE_FACTOR = 2;
const SPARK_MARK = { neutral: null, warn: "warn", danger: "danger" };
const MIN_MARK_ERRORS = 2;
const MAX_MARKS = 3;

function sparkline(points, field, cls, peakText) {
  const range = view.payload?.range || (points.length ? [points[0].t, points[points.length - 1].t] : [0, 1]);
  const xs = [Number(range[0]), ...points.map((p) => p.t), Math.max(Number(range[0]) + 1, Number(range[1]))];
  const pad = (values) => [null, ...values, null];
  const value = (p) => (field === "spans" ? Math.max(0, p.spans) : p.spans > 0 && p[field] > 0 ? p[field] : null);
  const values = points.map(value);
  const drawn = values.filter((v) => v != null);
  const lo = drawn.length ? Math.min(...drawn) : 0;
  const hi = drawn.length ? Math.max(...drawn) : 1;
  let marks;
  if (field === "spans") {
    // Only the worst buckets get a mark. A few errors in a quiet minute are noise.
    // A bucket needs MIN_MARK_ERRORS errors. At most MAX_MARKS marks show.
    marks = points.map(() => null);
    points.map((p, i) => ({ i, rate: p.spans > 0 ? p.errors / p.spans : 0, errors: p.errors }))
      .filter((b) => b.errors >= MIN_MARK_ERRORS && palette.errorLevel(b.rate) !== "neutral")
      .sort((a, b) => b.rate - a.rate || b.errors - a.errors)
      .slice(0, MAX_MARKS)
      .forEach((b) => { marks[b.i] = SPARK_MARK[palette.errorLevel(b.rate)]; });
  } else {
    const sorted = drawn.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    marks = values.map(() => null);
    values.map((v, i) => ({ v, i }))
      .filter((b) => b.v != null && median > 0 && b.v > SPIKE_FACTOR * median)
      .sort((a, b) => b.v - a.v)
      .slice(0, MAX_MARKS)
      .forEach((b) => { marks[b.i] = "accent"; });
  }
  const svg = chartUi.sparkline.html(pad(values), { xs, min: lo, max: hi > lo ? hi : lo + 1, area: false, marks: pad(marks), className: `traceSvcSpark ${cls}` });
  const peak = drawn.length ? peakText(hi) : "";
  return `<span class="traceSvcTrend__cell"${peak ? ` title="Peak in the range: ${esc(peak)}"` : ""}>${svg}<span class="traceSvcTrend__peak">${esc(peak)}</span></span>`;
}

// A sortable header (ns.table) keeps the sort state in aria-sort.
// `tier`: "low", "mid" or "xs". A column with a tier leaves the table when the window is narrower than its breakpoint (UI-130, table.css).
function headerCell(key, label, title, numeric = true, tier = "") {
  return table.sortHeadHtml({ key, label, title, sort: view.sort, num: numeric, className: tier ? `is-${tier}` : "", attrs: { "data-svc-sort": key } });
}

function p99Cell(row, service, operation = "") {
  if (!durationFilterEnabled() || !(row.p99 > 0)) return esc(fmt.duration(row.p99));
  return `<button type="button" class="traceSvcLink traceSvcLink--p99" data-svc-p99="${esc(row.p99)}" data-svc-service="${esc(service)}" data-svc-operation="${esc(operation)}" title="Search traces${operation ? ` of ${esc(operation)}` : ""} lasting at least the P99 (${esc(fmt.duration(row.p99))})">${esc(fmt.duration(row.p99))}</button>`;
}

function tableHtml(rows) {
  const bucketSeconds = Math.max(1, Number(view.payload?.bucket_ms || 60000) / 1000);
  const body = sortRows(rows).map((row) => {
    const points = seriesOf(view.payload, row.name);
    const selected = row.name === view.detailName;
    return `<tr class="traceSvcRow${selected ? " is-selected" : ""}" data-svc-row="${esc(row.name)}" tabindex="-1" aria-selected="${selected ? "true" : "false"}" style="--trace-service-color:${palette.service(row.name)}">
        <th scope="row" class="traceSvcRow__name"><span class="traceSvcRow__cell"><i class="serviceSwatch" aria-hidden="true"></i><span class="traceSvcRow__label" title="${esc(row.name)}">${esc(row.name)}</span></span></th>
        <td class="num" data-svc-col="rate" title="${esc(`${fmt.count(row.spans)} entry spans`)}">${esc(rateText(row.rate))}</td>
        <td class="num${ERROR_CLASS[errorLevel(row.errorPct)]}" data-svc-col="errors" data-error-level="${errorLevel(row.errorPct)}" title="${esc(`${fmt.count(row.errors)} errors`)}">${esc(percentText(row.errorPct))}</td>
        <td class="num is-mid" data-svc-col="p50">${esc(fmt.duration(row.p50))}</td>
        <td class="num" data-svc-col="p95">${esc(fmt.duration(row.p95))}</td>
        <td class="num" data-svc-col="p99">${p99Cell(row, row.name)}</td>
        ${shareCell(row.share, percentText(row.share), `${fmt.duration(row.total)} in total`, ' data-svc-col="time"')}
        <td class="traceSvcTrend is-low" title="Requests over time, its own scale up to the peak shown (dots: the worst buckets, amber from 1 % errors, red from 5 %)">${sparkline(points, "spans", "traceSvcSpark--rate", (spans) => rateText(spans / bucketSeconds, rateUnit(row.rate)))}</td>
        <td class="traceSvcTrend is-low" title="P95 over time, its own scale up to the peak shown (dots: the highest buckets above twice the median)">${sparkline(points, "p95", "traceSvcSpark--p95", (value) => fmt.duration(value))}</td>
      </tr>`;
  }).join("");
  return `<table class="traceSvcTable dataTable" aria-label="Services">
      <thead><tr>${headerCell("name", "Service", "Sort by service name", false)}${headerCell("rate", "Requests", "Entry spans per second, minute or hour: the largest unit the rate reaches 1 in")}${headerCell("errors", "Errors", "Share of entry spans with StatusCode Error")}${headerCell("p50", "P50", "Median entry span duration", true, "mid")}${headerCell("p95", "P95", "95th percentile entry span duration")}${headerCell("p99", "P99", "99th percentile entry span duration; click one to search slower traces")}${headerCell("time", "Time share", "Share of the total time spent in entry spans (sum of Duration)", false)}<th scope="col" class="traceSvcTrend is-low">Requests trend</th><th scope="col" class="traceSvcTrend is-low">P95 trend</th></tr></thead>
      <tbody>${body}</tbody></table>`;
}

// The "Time share" / "Total time" cell shows the text over the shared in-cell bar.
// The bar has the colour of the service.
function shareCell(share, text, title, attrs = "") {
  const pct = Math.max(0, Math.min(100, Number(share) || 0));
  return `<td class="num cellBar traceSvcShare"${attrs} title="${esc(title)}" style="${table.cellBarStyle(pct, "var(--trace-service-color, var(--accent-fill))")}">${esc(text)}</td>`;
}

function statusHtml(payload) {
  if (!payload) return "";
  const bits = [];
  const fraction = Number(payload.sample_fraction || 1);
  if (payload.estimated) {
    bits.push(`${badge.html(`\u2248 Estimated from ${fmt.percent(fraction)} of the window`, { tone: "estimate", size: "md", className: "traceSvcBadge--estimated", title: `The window holds about ${fmt.count(Number(payload.estimated_rows || 0))} spans (over ${fmt.count(Number(payload.exact_rows_limit || 0))}): one time slice per chart bucket was read and the counts scaled up. Percentiles come from the sampled spans.` })}<button type="button" class="traceSvcAction" data-svc-exact>Compute exactly</button>`);
  }
  if (payload.partial) bits.push(badge.html("Partial: time budget reached", { tone: "estimate", size: "md", className: "traceSvcBadge--partial", title: "The query reached its time budget before reading the whole window: the numbers cover only part of it." }));
  if (view.exact && !payload.estimated) bits.push('<button type="button" class="traceSvcAction" data-svc-sampled title="Go back to the time-sampled answer on large windows">Allow sampling</button>');
  return bits.join("");
}

// Entry spans | Root spans: this is the shared segmented control (app_ui_segmented.js).
function scopeHtml() {
  return segmented.html([
    { value: "entry", label: "Entry spans", title: "Spans receiving work: SpanKind Server or Consumer, or root spans" },
    { value: "root", label: "Root spans", title: "Only root spans (no parent): cheaper on long ranges, one per trace entry" },
  ], { attr: "svcScope", value: view.scope, size: "compact", label: "Spans measured", className: "traceSvcScope" });
}

function render() {
  if (!root) return;
  const payload = view.payload;
  const rows = payload ? withRates((payload.services || []).map(statsRow), payload) : [];
  const count = rows.length;
  const bucket = payload ? fmt.duration.fromMs(Number(payload.bucket_ms || 60000)) : "";
  const timing = payload?.timing_ms?.total != null ? ` · ${fmt.duration.fromMs(Number(payload.timing_ms.total))}` : "";
  const meta = payload ? `${view.scope === "root" ? "root spans" : "entry spans"} · ${bucket} buckets${timing}` : "";
  let bodyHtml;
  if (view.error && !payload) bodyHtml = failedHtml(view.error, "list");
  else if (!payload) bodyHtml = view.loading ? uiState.loadingHtml({ label: "Loading services\u2026" }) : emptyHtml("Search to load services.");
  else if (!count) bodyHtml = emptyHtml(`No ${view.scope === "root" ? "root" : "entry"} spans match in this range.`);
  else bodyHtml = tableHtml(rows);
  releaseDetailCharts();
  // A new render (Back / Forward, or a new answer) keeps the focus on its row.
  const active = document.activeElement;
  const focusedRow = active instanceof Element && root.contains(active) && active.matches("[data-svc-row]") ? active.getAttribute("data-svc-row") : null;
  const shell = skeleton();
  shell.classList.toggle("is-loading", view.loading);
  shell.setAttribute("aria-busy", view.loading ? "true" : "false");
  $(":scope > .traceSvc__main", shell).innerHTML = `
      <div class="traceSvc__toolbar">
        <h2 id="traceSvcCount">${payload ? `${fmt.count(count)} Service${count === 1 ? "" : "s"}` : "Services"}</h2>
        <span class="traceSvc__meta" title="Entry spans: SpanKind Server / Consumer (and SPAN_KIND_* spellings) or root spans. The search filters apply to these spans.">${esc(meta)}</span>
        <span class="traceSvc__status">${statusHtml(payload)}${view.loading && payload ? badge.html("Loading\u2026", { size: "md" }) : ""}</span>
        ${scopeHtml()}
      </div>
      ${view.error && payload ? `<div class="traceSvc__error" role="alert">${esc(view.error)}</div>` : ""}
      <div class="traceSvc__table">${bodyHtml}</div>`;
  if (focusedRow != null) $(`[data-svc-row="${CSS.escape(focusedRow)}"]`, root)?.focus({ preventScroll: true });
  renderDetail();
}

// The view has the list (.traceSvc__main). Beside the list is the service detail.
// The detail is a docked ns.detailPanel. It sticks under the search bar. On narrow windows, it is a bottom sheet.
// The view is built once. Each render fills these elements.
let detailPanel = null;
// svc= is the parameter of the open detail (ns.router.panel).
const svcParam = address.panel("svc");

function skeleton() {
  let shell = $(":scope > .traceSvc", root);
  if (shell) return shell;
  root.innerHTML = '<div class="traceSvc"><div class="traceSvc__main"></div></div>';
  shell = root.firstElementChild;
  detailPanel = detailPanelMod.create({
    host: shell,
    id: "traceSvcDetail",
    className: "uiDetail--sticky traceSvcDetail",
    closeLabel: "Close service details",
    returnFocus: () => (view.detailName ? $(`[data-svc-row="${CSS.escape(view.detailName)}"]`, root) : null),
    onClose: () => { if (view.detailName) closeDetail({ fromPanel: true }); },
  });
  detailPanel.closeButton?.setAttribute("data-svc-close", "");
  return shell;
}

// ------------------------------------------------------------ the detail

// The detail charts draw on the shared canvas engine (app_chart_core.js).
// Each chart has one canvas. The engine provides the cursor and the tooltip. One crosshair spans the three charts.
// The release markers are DOM annotations. A drag searches a range.
// points: [{ t (bucket start), ... }].
//
// P50 and P99 show by default. The legend shows or hides the other series.
// The choice holds for the next service and answer.
let latencyHidden = ["p95"];
const SUCCESS_COLOR = "var(--muted)";

function detailChart(container, { start, end, bucketMs, points, series, type, axis, releases, footer, format, hidden = null, onHiddenChange = null }) {
  if (!points.length) { chartMessage(container, "No data in this range."); return; }
  const grid = bucketGrid(points.map((p) => [p.t]), bucketMs);
  const n = grid.starts.length;
  const xs = new Float64Array(n);
  for (let i = 0; i < n; i += 1) xs[i] = grid.starts[i] + bucketMs / 2;
  // Lines break at buckets without spans (NULL). Bars are empty at these buckets.
  const nulls = new Uint8Array(n).fill(1);
  points.forEach((p, k) => { nulls[grid.slot[k]] = 0; });
  const columns = series.map((s) => {
    const values = new Float64Array(n).fill(type === "bar" ? 0 : NaN);
    points.forEach((p, k) => { const v = s.value(p); if (Number.isFinite(v)) values[grid.slot[k]] = v; });
    return { id: s.id, label: s.label, color: s.color, values, nulls: type === "bar" ? null : nulls };
  });
  let yAxis;
  if (axis === "duration") {
    yAxis = (yMin, yMax) => {
      const scale = durationAxis(yMin, yMax, 5);
      return { min: scale.axisMin, max: scale.axisMax, ticks: scale.values.map((t) => ({ v: t.value, label: t.label })) };
    };
  } else {
    // "rate" (values already in the table's rate unit) and "percent".
    // The axis labels are the values that the readouts print.
    yAxis = (yMin, yMax) => unitAxis(yMax, format);
  }
  const byIndex = new Map(points.map((p, k) => [grid.slot[k], p]));
  mountChart(container, "service", {
    height: DETAIL_CHART_HEIGHT, xKind: "time", xs, xDomain: [start, end], zoom: null,
    // The engine legend shows for the charts that have several series.
    series: columns, type, stack: type === "bar", syncKey: "traces-service", tooltipNulls: false,
    yAxis, annotations: releases,
    ...(hidden ? { hidden, onHiddenChange } : {}),
    bucketMs, bucketAlign: "center",
    formatValue: (v) => format(v),
    formatY: (v) => format(Math.max(0, v)),
    tooltipFooter: footer ? (i) => { const p = byIndex.get(i); return p ? footer(p) : ""; } : null,
    onZoom: (range, fromUser) => { if (fromUser && range) zoomSearchRange(range); },
  });
}

// The charts of the detail go away with it. Their engine state is released.
function releaseDetailCharts() {
  $$("[data-svc-chart]", detailPanel?.el).forEach((el) => unmountChart(el));
}

function drawDetailCharts() {
  const panel = detailPanel?.el;
  const payload = view.detail.payload;
  if (!panel || panel.hidden || !payload) return;
  const points = seriesOf(payload, view.detailName);
  const range = payload.range || [0, 1];
  const start = Number(range[0]), end = Math.max(start + 1000, Number(range[1]));
  const bucketMs = Math.max(1000, Number(payload.bucket_ms || 60000));
  const bucketSeconds = bucketMs / 1000;
  // A release marker names its release. Example: "release 1.15.0".
  const releases = (payload.releases || []).map((r) => ({ label: `release ${r[0]}`, x: Number(r[1]), title: `Release ${r[0]}: first span ${fmt.time(Number(r[1]))}`, className: "traceSvcRelease" }));
  const spansText = (p) => `${fmt.count(p.spans)} spans${p.errors ? `, ${fmt.count(p.errors)} errors` : ""}`;
  // The rate chart uses the unit of the Requests figure of the service.
  // This figure is in the table row and in the detail header. It is 29/min there, and the axis is per minute here.
  const unit = rateUnit(detailRow(payload, view.detailName)?.rate);
  const perUnit = unit.per / bucketSeconds;
  const rate = $('[data-svc-chart="rate"]', panel);
  if (rate) detailChart(rate, {
    start, end, bucketMs, points, type: "bar", axis: "rate", releases, footer: spansText, format: (v) => rateText(v / unit.per, unit),
    series: [
      // Success uses the neutral colour. Errors use one hue, the danger colour.
      // A service colour (amber, red) would look like a warning.
      { id: "ok", label: "Successful", color: SUCCESS_COLOR, value: (p) => Math.max(0, p.spans - p.errors) * perUnit },
      { id: "errors", label: "Errors", color: "var(--danger)", value: (p) => p.errors * perUnit },
    ],
  });
  const errors = $('[data-svc-chart="errors"]', panel);
  if (errors) detailChart(errors, {
    start, end, bucketMs, points, type: "line", axis: "percent", releases, footer: spansText, format: percentText,
    series: [{ id: "error_rate", label: "Error rate", color: "var(--danger)", value: (p) => (p.spans ? (p.errors / p.spans) * 100 : 0) }],
  });
  const latency = $('[data-svc-chart="latency"]', panel);
  if (latency) detailChart(latency, {
    start, end, bucketMs, points, type: "line", axis: "duration", releases, format: fmt.duration,
    hidden: latencyHidden, onHiddenChange: (hidden) => { latencyHidden = [...hidden]; },
    series: [["p50", "P50"], ["p95", "P95"], ["p99", "P99"]].map(([id, label]) => ({ id, label, color: palette.quantile(id), value: (p) => p[id] })),
  });
}

function endpointsHtml(payload, service) {
  const rows = withRates((payload.endpoints || []).map(statsRow), payload);
  if (!rows.length) return emptyHtml("No endpoints in this range.");
  const body = rows.map((row) => `<tr data-svc-endpoint="${esc(row.name)}">
      <th scope="row"><button type="button" class="traceSvcLink" data-svc-operation-search="${esc(row.name)}" title="Search traces of ${esc(service)} / ${esc(row.name)}">${esc(row.name)}</button></th>
      <td class="num">${esc(rateText(row.rate))}</td>
      <td class="num${ERROR_CLASS[errorLevel(row.errorPct)]}" data-error-level="${errorLevel(row.errorPct)}">${esc(percentText(row.errorPct))}</td>
      <td class="num">${esc(fmt.duration(row.p95))}</td>
      <td class="num">${p99Cell(row, service, row.name)}</td>
      ${shareCell(row.share, fmt.duration(row.total), `${fmt.duration(row.total)} in total`)}
    </tr>`).join("");
  return `<table class="traceSvcTable dataTable dataTable--compact" aria-label="Most time-consuming endpoints"><thead><tr><th scope="col">Endpoint</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Errors</th><th scope="col" class="num">P95</th><th scope="col" class="num">P99</th><th scope="col" class="num">Total time</th></tr></thead><tbody>${body}</tbody></table>${payload.endpoints_truncated ? '<div class="traceSvcNote">Only the 100 most time-consuming endpoints are listed.</div>' : ""}`;
}

function slowestHtml(payload) {
  const rows = Array.isArray(payload.slowest) ? payload.slowest : [];
  if (!rows.length) return emptyHtml("No spans in this range.");
  return `<ol class="traceSvcSlowest">${rows.map((row) => {
      const [traceId, spanId, operation, startMs, durationNs, status] = row;
      const href = spanTraceUrl(String(traceId), String(spanId || ""));
      return `<li><a class="traceSvcSlowest__link" href="${esc(href)}" data-svc-trace="${esc(traceId)}" data-svc-span="${esc(spanId)}" title="Open trace ${esc(traceId)}"><b class="traceSvcSlowest__duration">${esc(fmt.duration(durationNs))}</b><span class="traceSvcSlowest__op">${esc(operation)}</span>${status === "Error" ? badge.statusHtml(status, { className: "traceSvcSlowest__error" }) : ""}<time class="traceSvcSlowest__time" title="${esc(fmt.timeTitle(Number(startMs)))}">${esc(fmt.time(Number(startMs)))}</time><code>${esc(String(traceId).slice(0, 12))}</code></a></li>`;
    }).join("")}</ol>`;
}

function releasesHtml(payload) {
  if (payload.releases_supported === false) return "";
  const rows = Array.isArray(payload.releases) ? payload.releases : [];
  const items = rows.length
    ? rows.map((r) => `<li data-release-version="${esc(r[0])}"><b>${esc(r[0])}</b><span title="${esc(fmt.timeTitle(Number(r[1])))}">${esc(fmt.time(Number(r[1])))}</span></li>`).join("")
    : `<li class="traceSvcReleases__none">${emptyHtml("No release version (service.version) on this service's spans in this range.")}</li>`;
  return `<section class="traceSvcSection"><h4>Releases${payload.releases_estimated ? ` ${badge.html("\u2248 Partial", { tone: "estimate", title: "The read cap stopped the scan: later versions may be missing." })}` : ""}</h4><ul class="traceSvcReleases">${items}</ul></section>`;
}

function dbHtml() {
  const db = view.db;
  if (db.loading && !db.payload) return uiState.loadingHtml({ label: "Loading database statements\u2026", compact: true });
  if (db.error) return failedHtml(db.error, "db");
  const payload = db.payload;
  if (!payload) return "";
  if (payload.supported === false) return emptyHtml("Database statements are unavailable: this trace table does not keep span attributes.");
  const rows = Array.isArray(payload.statements) ? payload.statements : [];
  if (!rows.length) return emptyHtml("No database calls from this service in this range.");
  const seconds = Math.max(1, (Number(payload.range?.[1]) - Number(payload.range?.[0])) / 1000);
  const total = rows.reduce((sum, r) => sum + Number(r[5] || 0), 0) || 1;
  return `<table class="traceSvcTable dataTable dataTable--compact traceSvcDb" aria-label="Database statements"><thead><tr><th scope="col">Statement</th><th scope="col">System</th><th scope="col" class="num">Count</th><th scope="col" class="num">Throughput</th><th scope="col" class="num">P95</th><th scope="col" class="num">Total time</th></tr></thead><tbody>${rows.map((r) => {
      const share = (Number(r[5] || 0) / total) * 100;
      return `<tr data-db-statement="${esc(r[1])}"><th scope="row" class="traceSvcDb__stmtCell">${sqlBlock.html({ sql: r[1], inline: true, label: "Statement" })}</th><td>${esc(r[2] || fmt.EMPTY)}</td><td class="num">${fmt.count(Number(r[3] || 0))}</td><td class="num">${esc(rateText(Number(r[3] || 0) / seconds))}</td><td class="num">${esc(fmt.duration(r[6]))}</td>${shareCell(share, fmt.duration(r[5]), `${fmt.duration(r[5])} in total`)}</tr>`;
    }).join("")}</tbody></table>${payload.estimated ? '<div class="traceSvcNote">\u2248 The read cap or time budget stopped the scan: counts are partial.</div>' : ""}`;
}

// The totals row of the selected service in a detail payload. The rates are included.
function detailRow(payload, name) {
  return payload ? withRates((payload.services || []).map(statsRow), payload).find((r) => r.name === name) || null : null;
}

function renderDetail() {
  if (!root || !detailPanel) return;
  const panel = detailPanel.el;
  const name = view.detailName;
  $(".traceSvc", root)?.classList.toggle("has-detail", !!name);
  releaseDetailCharts();
  if (!name) {
    detailPanel.close("closed", { restoreFocus: false });
    detailPanel.body.replaceChildren();
    return;
  }
  detailPanel.open();
  const detail = view.detail;
  const payload = detail.payload;
  const row = detailRow(payload, name);
  const stat = (label, valueHtml, tone = "") => statMod.html({ label, valueHtml, tone, className: "traceSvcStat" });
  const stats = row
    ? stat("Requests", esc(rateText(row.rate))) + stat("Errors", esc(percentText(row.errorPct)), ERROR_TONE[errorLevel(row.errorPct)]) + stat("P50", esc(fmt.duration(row.p50))) + stat("P95", esc(fmt.duration(row.p95))) + stat("P99", p99Cell(row, name)) + stat("Total time", esc(fmt.duration(row.total)))
    : "";
  let body;
  if (detail.error) body = failedHtml(detail.error, "detail");
  else if (!payload) body = uiState.loadingHtml({ label: "Loading the service\u2026" });
  else if (!row) body = emptyHtml("No requests to this service match in this range.");
  else {
    body = `${payload.estimated ? `<div class="traceSvcNote">\u2248 Estimated from ${esc(fmt.percent(Number(payload.sample_fraction || 1)))} of the window (one time slice per bucket). <button type="button" class="traceSvcAction" data-svc-exact>Compute exactly</button></div>` : ""}
        <div class="traceSvcCharts">
          ${chartUi.cardHtml({ title: "Requests", meta: `${view.scope === "root" ? "root" : "entry"} spans per ${rateUnit(row.rate).word}`, className: "traceAnalyticsCard", titleTag: "strong", bodyClass: "traceChart traceSvcChart", bodyAttrs: { "data-svc-chart": "rate" } })}
          ${chartUi.cardHtml({ title: "Error rate", meta: "% of entry spans with status Error", className: "traceAnalyticsCard", titleTag: "strong", bodyClass: "traceChart traceSvcChart", bodyAttrs: { "data-svc-chart": "errors" } })}
          ${chartUi.cardHtml({ title: "Latency", meta: "entry span duration", className: "traceAnalyticsCard", titleTag: "strong", bodyClass: "traceChart traceSvcChart", bodyAttrs: { "data-svc-chart": "latency" } })}
        </div>
        ${releasesHtml(payload)}
        <section class="traceSvcSection"><h4>Most time-consuming endpoints</h4>${endpointsHtml(payload, name)}</section>
        <section class="traceSvcSection"><h4>Slowest spans</h4>${slowestHtml(payload)}</section>
        <section class="traceSvcSection"><h4>Database statements</h4>${dbHtml()}</section>`;
  }
  // The head of the shell has the eyebrow, the service (with its colour dot) and the actions.
  panel.style.setProperty("--trace-service-color", palette.service(name));
  detailPanel.setHead({ eyebrow: "Service", title: `<i class="serviceSwatch" aria-hidden="true"></i>${esc(name)}`, html: true });
  detailPanel.title.setAttribute("title", name);
  detailPanel.setActions(`${detail.loading && payload ? badge.html("Loading\u2026", { size: "md" }) : ""}<button type="button" class="button button--primary button--small" data-svc-search="${esc(name)}" title="Search the traces of ${esc(name)}">Search traces</button>`);
  // The totals strip is between the head and the body. It does not scroll.
  let strip = $(":scope > .traceSvcStats", panel);
  if (stats) {
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "statTiles traceSvcStats";
      detailPanel.head.after(strip);
    }
    strip.innerHTML = stats;
  } else {
    strip?.remove();
  }
  detailPanel.body.innerHTML = body;
  drawDetailCharts();
}

// --------------------------------------------------------------- actions

// The detail adds a history entry (svc=) when it opens.
// Another service in the open detail replaces this entry.
// Back from the detail goes to the entry before it. If that entry is not the detail's own (a link, a reload), the close replaces the entry instead.
function openDetail(name, { push = true } = {}) {
  const opening = !view.detailName;
  view.detailName = name || "";
  if (push && view.detailName) {
    if (opening) svcParam.open(view.detailName);
    else svcParam.move(view.detailName);
  }
  const table = $(".traceSvcTable", root);
  $$("[data-svc-row]", table).forEach((tr) => {
    const on = tr.getAttribute("data-svc-row") === view.detailName;
    tr.classList.toggle("is-selected", on);
    tr.setAttribute("aria-selected", on ? "true" : "false");
  });
  renderDetail();
  if (view.detailName) void loadDetail();
}

// The close button, Escape (ns.layers) and a click on the row of the open service: the focus goes back to the row of the service.
function closeDetail({ fromPanel = false } = {}) {
  const name = view.detailName;
  if (!name) return;
  view.detailName = "";
  openDetail("", { push: false });
  let back = false;
  if (svcParam.get()) back = svcParam.close();
  else address.replace();
  if (fromPanel || !back) $(`[data-svc-row="${CSS.escape(name)}"]`, root)?.focus({ preventScroll: true });
}

function searchFor(spec) {
  traceSearch.applySearch(spec);
  traceTabs.select("search");
}

function onClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const sort = target.closest("[data-svc-sort]");
  if (sort) {
    const key = sort.getAttribute("data-svc-sort");
    view.sort = view.sort.key === key ? { key, dir: view.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" };
    address.replace();
    render();
    $(`[data-svc-sort="${key}"] .dataTable__sort`, root)?.focus({ preventScroll: true });
    return;
  }
  const scope = target.closest("[data-svc-scope]");
  if (scope) {
    const value = scope.getAttribute("data-svc-scope") === "root" ? "root" : "entry";
    if (value !== view.scope) { view.scope = value; void actions.search({ url: "push" }); }
    return;
  }
  const retry = target.closest("[data-svc-retry]")?.getAttribute("data-svc-retry");
  if (retry === "list" && view.filters) { void run(view.filters, { force: true }); return; }
  if (retry === "detail") { view.detail.key = ""; void loadDetail(); return; }
  if (retry === "db" && view.filters && view.detailName) {
    view.db.key = "";
    void loadDb({ ...requestFilters(view.filters), detail: view.detailName });
    renderDetail();
    return;
  }
  if (target.closest("[data-svc-exact]")) { view.exact = true; void actions.search({ url: "push" }); return; }
  if (target.closest("[data-svc-sampled]")) { view.exact = false; void actions.search({ url: "push" }); return; }
  const p99 = target.closest("[data-svc-p99]");
  if (p99) {
    event.stopPropagation();
    searchFor({ service: p99.getAttribute("data-svc-service") || "", operation: p99.getAttribute("data-svc-operation") || "", minDurationMs: Number(p99.getAttribute("data-svc-p99")) / 1e6 });
    return;
  }
  const operation = target.closest("[data-svc-operation-search]");
  if (operation) { searchFor({ service: view.detailName, operation: operation.getAttribute("data-svc-operation-search") || "" }); return; }
  const searchButton = target.closest("[data-svc-search]");
  if (searchButton) { searchFor({ service: searchButton.getAttribute("data-svc-search") || "" }); return; }
  const trace = target.closest("[data-svc-trace]");
  if (trace) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    model.pendingSpanId = trace.getAttribute("data-svc-span") || "";
    void actions.loadTrace(trace.getAttribute("data-svc-trace"), { push: true });
    return;
  }
  const row = target.closest("[data-svc-row]");
  if (row) {
    const name = row.getAttribute("data-svc-row") || "";
    if (name === view.detailName) closeDetail();
    else openDetail(name);
  }
}

// ----------------------------------------------------------- URL state

function writeParams(params) {
  if (view.scope !== "entry") params.set("svc_scope", view.scope);
  if (view.exact) params.set("svc_exact", "1");
  if (view.sort.key !== DEFAULT_SORT.key || view.sort.dir !== DEFAULT_SORT.dir) params.set("svc_sort", `${view.sort.key}:${view.sort.dir}`);
  if (view.detailName) params.set("svc", view.detailName);
}

function applyParams(params) {
  view.scope = params.get("svc_scope") === "root" ? "root" : "entry";
  view.exact = params.get("svc_exact") === "1";
  const [key, dir] = String(params.get("svc_sort") || "").split(":");
  view.sort = SORT_KEYS.includes(key) ? { key, dir: dir === "asc" ? "asc" : "desc" } : { ...DEFAULT_SORT };
  const name = params.get("svc") || "";
  const changed = name !== view.detailName;
  view.detailName = name;
  // Back / Forward within the view (sort, detail) does not run a new search.
  if (view.payload && root && !root.hidden) {
    render();
    if (changed && name) void loadDetail();
  }
}

function mount(element) {
  root = element;
  root.addEventListener("click", onClick);
  // One toggle shows or hides the inline SQL of the database statements (built as a string).
  sqlBlock.bind(root);
  // Up / Down move between services. Enter / Space open a service (ns.table.rovingRows).
  // Escape closes the detail (ns.layers).
  table.rovingRows(root, { rows: "tr.traceSvcRow", onOpen: (row) => openDetail(row.getAttribute("data-svc-row") || "") });
  render();
}

// The view is shown after a click or Back / Forward. The current search refreshes the view, unless the view already shows it.
function onShow() {
  const key = traceSearch.searchKey() || "";
  if (key !== view.searchKey || (!view.payload && !view.loading)) void actions.search({ url: "none" });
  else render();
}

traceTabs.register({
  id: "services",
  label: "Services",
  order: 10,
  panelId: "traceServicesView",
  available: (meta) => meta?.analytics_enabled === true,
  init: () => { const element = byId("traceServicesView"); if (element) mount(element); },
  onSearch: (filters, options) => run(filters, options),
  onShow,
  params: ["svc", "svc_sort"],
  writeParams,
  applyParams,
});

export const traceServices = { state: view };
