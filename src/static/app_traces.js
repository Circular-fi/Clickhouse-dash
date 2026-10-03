(() => {
  "use strict";
  const ns = window.ChDash;
  if (!ns) return;
  const { byId, $, $$ } = ns.dom;
  const { dom, state, api, util, ui, h } = ns;
  // Formats and colours (docs/ui-foundations.md): durations, counts and
  // instants through ns.format; service, percentile and status colours
  // through ns.palette (a service keeps one colour across Traces, Logs and
  // Metrics) and the semantic tokens.
  const fmt = ns.format;
  const palette = ns.palette;
  const TRACES_PAGE_TITLE = "ClickHouse Dash \u00b7 Traces";

  const model = {
    meta: null,
    traces: [],
    analytics: null,
    analyticsLoading: false,
    analyticsError: "",
    durationsError: "",
    prefillPairs: [],
    prefillPromise: null,
    activeTrace: null,
    activeSpanId: null,
    // Deep link (?span=): the span to focus once its trace is loaded, and the
    // highlighted span.
    pendingSpanId: "",
    // The open trace could not be loaded: { id, code, text } (unavailableHtml).
    traceError: null,
    focusedSpanId: "",
    openSpanIds: new Set(),
    // Inspector sections a span has open (Jaeger's DetailState), so that a
    // waterfall re-render keeps them: span id -> Set of section keys.
    spanSections: new Map(),
    waterfallLabelPct: 34,
    traceViewRange: [0, 1],
    disabledServices: new Set(),
    collapsed: new Set(),
    criticalPathShown: true,
    timeRange: { from: "now-1h", to: "now" },
    timeRangeTouched: false,
    searched: false,
    searchLatencyMs: NaN,
    lastSearchRange: null,
    resultsView: "list",
    tableSort: null,
    startDisplay: "absolute",
  };

  const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
  const route = (path) => ns.router.url(String(path || ""));
  // The Traces view of the Observability page (app_observability.js): its
  // URLs are /observability/traces[/<traceId>], written through the Traces
  // owner of ns.router (the search page's address is app_trace_search.js's;
  // a trace's own writes pass its href), only while the view shows.
  const SEARCH_ROUTE = "/observability/traces";
  const address = ns.router.owner("traces");


  // Duration axis steps: 1-2-5 below a second, then clock-friendly steps
  // (seconds, minutes, hours, days), so minute axes read 2 min, 5 min, 15 min.
  const DURATION_AXIS_STEPS_NS = (() => {
    const steps = [];
    for (let decade = 1; decade < 1e9; decade *= 10) for (const m of [1, 2, 5]) steps.push(m * decade);
    for (const s of [1, 2, 5, 10, 15, 30]) steps.push(s * 1e9);
    for (const m of [1, 2, 5, 10, 15, 30]) steps.push(m * 60e9);
    for (const h of [1, 2, 3, 6, 12]) steps.push(h * 3600e9);
    for (const d of [1, 2, 5, 10, 30]) steps.push(d * 86400e9);
    return steps;
  })();

  // Jaeger's ['auto', 'auto'] duration domain: the data range padded by 5 %
  // on each side (a flat series by 10 % of its value), snapped to whole
  // steps, so close percentiles do not flatten against a zero baseline. The
  // step is the finest one whose labels all differ.
  function durationAxis(minNsValue, maxNsValue, targetIntervals = 7) {
    let lo = Math.max(0, Number(minNsValue) || 0);
    let hi = Math.max(lo, Number(maxNsValue) || 0);
    if (!(hi > 0)) hi = 1;
    const pad = hi > lo ? (hi - lo) * 0.05 : Math.max(1, hi * 0.1);
    lo = Math.max(0, lo - pad);
    hi += pad;
    const last = DURATION_AXIS_STEPS_NS[DURATION_AXIS_STEPS_NS.length - 1];
    const first = DURATION_AXIS_STEPS_NS.findIndex((candidate) => (hi - lo) / candidate <= targetIntervals);
    for (let index = first < 0 ? DURATION_AXIS_STEPS_NS.length - 1 : first; index < DURATION_AXIS_STEPS_NS.length; index += 1) {
      const step = DURATION_AXIS_STEPS_NS[index];
      const axisMin = Math.floor(lo / step) * step;
      const axisMax = Math.max(axisMin + step, Math.ceil(hi / step) * step);
      const values = [];
      for (let i = 0; axisMin + i * step <= axisMax + step * 1e-6; i += 1) {
        const value = axisMin + i * step;
        values.push({ value, label: value ? fmt.duration(value) : "0" });
      }
      const distinct = new Set(values.map((tick) => tick.label)).size === values.length;
      if (distinct || step === last) return { axisMin, axisMax, values };
    }
    return { axisMin: 0, axisMax: last, values: [{ value: 0, label: "0" }, { value: last, label: fmt.duration(last) }] };
  }

  // Evenly spaced ticks over a window of `durationNs` that starts `offsetNs`
  // after the trace start (a zoomed waterfall): labels are offsets from the
  // trace start, like Jaeger's, never restarting at 0.
  function durationTicks(durationNs, count = 5, offsetNs = 0) {
    const duration = Math.max(1, Number(durationNs || 0));
    const offset = Math.max(0, Number(offsetNs || 0));
    const n = Math.max(2, Number(count || 5));
    const step = duration / (n - 1);
    return Array.from({ length: n }, (_, index) => {
      const ratio = index / (n - 1);
      const ns = offset + duration * ratio;
      return { ratio, ns, label: offset ? tickDurationLabel(ns, step) : fmt.duration(ns) };
    });
  }

  // fmt.duration, with the extra decimals a deep zoom needs so adjacent
  // ticks never read the same ("50.003 ms", "50.005 ms").
  function tickDurationLabel(ns, stepNs) {
    const text = fmt.duration(ns);
    const match = /^(\d+(?:\.(\d+))?) (µs|ms|s)$/.exec(text);
    if (!match || !(stepNs > 0)) return text;
    const factor = match[3] === "s" ? 1e9 : match[3] === "ms" ? 1e6 : 1e3;
    // One decimal below the step's leading digit: a 0.25 ms step reads 74.75.
    const needed = Math.min(6, Math.max(0, Math.ceil(-Math.log10(stepNs / factor)) + 1));
    return needed > (match[2] || "").length ? `${(ns / factor).toFixed(needed)} ${match[3]}` : text;
  }

  // Wall-clock time `offsetNs` after the epoch-ns instant `startNs`,
  // browser-local: 10:59:59.312, with microseconds when the tick step is
  // below a millisecond. The offset is added to the start's sub-millisecond
  // remainder, not to the epoch value, which a double only holds to ~256 ns.
  function wallClockLabel(startNs, offsetNs = 0, stepNs = Infinity) {
    if (!Number.isFinite(startNs) || !Number.isFinite(offsetNs)) return "";
    const startMs = Math.floor(startNs / 1e6);
    // Whole nanoseconds: a view fraction like 0.49999999999999994 must not
    // read one millisecond early.
    const withinNs = Math.round(Math.max(0, startNs - startMs * 1e6) + offsetNs);
    const ms = startMs + Math.floor(withinNs / 1e6);
    const base = fmt.time(ms, { precision: "ms", date: "never" });
    if (!(stepNs < 1e6)) return base;
    const micros = Math.max(0, Math.min(999, Math.floor((withinNs % 1e6) / 1e3)));
    return `${base}${String(micros).padStart(3, "0")}`;
  }


  // Start of the local day of `ms`: the server's bucket grid origin.
  function localMidnight(ms) {
    const d = new Date(Number(ms));
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function timestampToNs(value) {
    if (value == null || value === "") return NaN;
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      const abs = Math.abs(direct);
      if (abs >= 1e17) return direct;
      if (abs >= 1e14) return direct * 1e3;
      if (abs >= 1e11) return direct * 1e6;
      if (abs >= 1e9) return direct * 1e9;
    }
    const raw = String(value).trim();
    if (!raw) return NaN;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d\d(?::?\d\d)?)?$/);
    if (match) {
      const fraction = (match[3] || "").slice(0, 9).padEnd(9, "0");
      const parsed = Date.parse(`${match[1]}T${match[2]}.${fraction.slice(0, 3)}Z`);
      if (Number.isFinite(parsed)) return parsed * 1e6 + Number(fraction.slice(3));
    }
    const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    return Number.isFinite(parsed) ? parsed * 1e6 : NaN;
  }

  function serviceEnabled(service) {
    return !model.disabledServices.has(String(service || "unknown"));
  }

  function shortId(value, size = 7) {
    const s = String(value || "");
    return s.length <= size * 2 + 1 ? s : `${s.slice(0, size)}\u2026${s.slice(-size)}`;
  }

  function parseStartMs(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 10000000000) return direct;
    const raw = String(value || "").trim();
    if (!raw) return NaN;
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const withZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : NaN;
  }


  function currentHost() { return state.selectedHostId || ""; }

  // The error strip above the view (ns.uiState.banner): a sentence
  // (app_observability.js strips the API's error codes) and, when the failed
  // step can run again, Retry.
  function showError(message, retry = null) {
    ns.uiState.banner(dom.tracesError, { message, retry });
  }

  // The search bar's height as --trace-search-h on the root element, in px (it
  // wraps to 2 or more rows on narrower windows): the drawers of the Search
  // and Services tabs open under it and the facets sidebar sticks under it,
  // below --shell-top (app_dom.js).
  function trackSearchBarHeight() {
    const bar = dom.tracesForm;
    if (!bar) return;
    const root = document.documentElement;
    const update = () => {
      // A hidden bar (the trace detail) keeps the last height.
      const height = bar.offsetHeight;
      if (height > 0) root.style.setProperty("--trace-search-h", `${height}px`);
    };
    update();
    if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(bar);
  }

  function traceIdFromPath() {
    const pathname = decodeURIComponent(String(window.location.pathname || ""));
    const match = pathname.match(/\/observability\/traces\/([^/]+)\/?$/);
    return match ? match[1] : "";
  }

  function setView(detail) {
    if (dom.tracesSearchView) dom.tracesSearchView.hidden = !!detail;
    if (dom.traceDetail) dom.traceDetail.hidden = !detail;
    document.body.classList.toggle("is-trace-detail", !!detail);
    // An open trace names the tab after itself (renderTraceHeader).
    if (!detail && address.active()) document.title = TRACES_PAGE_TITLE;
  }


  // The search bar, results and view pickers are ns.menu.select pickers
  // (app_ui_menu.js): a hidden native <select> holds the value, the button
  // reads "<label> \u00b7 <option>".
  function enhanceTraceSelect(select) {
    return ns.menu?.select(select) || null;
  }

  function initTracePickers() {
    initTimeRangePicker();
    // The Logs and Metrics views share the search bar look: only this view's selects.
    $$("#tracesWorkspace .traceSearchBar select, #tracesWorkspace .traceResultsSort select").forEach((select) => {
      if (select !== dom.tracesRangeUnit || !timePicker) enhanceTraceSelect(select);
    });
  }

  function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

  let timePicker = null;

  // The Grafana-style time range panel (built by app_timerange.js) is the
  // dropdown of the shipped range picker (same root and button, same
  // open/close motion). Its zoom button joins dom: the result views' "zoom
  // out" actions click it.
  function initTimeRangePicker() {
    const select = dom.tracesRangeUnit;
    const root = select?.parentElement;
    if (!ns.timeRange || !$(":scope > .tracePicker__button", root)) return;
    select.dataset.tracePickerReady = "1";
    timePicker = ns.timeRange.create(root, {
      idPrefix: "traces",
      getValue: () => model.timeRange,
      getMaxMinutes: maxRangeMinutes,
      onApply: (raw, source) => { void applyCustomRange(raw, source); },
    });
    dom.tracesRangeZoomOut = timePicker.el.zoomOut;
  }

  // Meta decides the default window (until the user picks one) and the widest
  // one: an applied range wider than the server accepts falls back to the
  // widest quick range that fits.
  function syncRangeControls() {
    const tr = ns.timeRange;
    if (!tr) return;
    const max = maxRangeMinutes();
    const fallbackMinutes = Math.min(max, Math.max(1, Number(model.meta?.default_lookback_minutes || 60)));
    if (!model.timeRangeTouched && model.meta) model.timeRange = { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
    const now = Date.now();
    const { startMs, endMs } = tr.resolveRange(model.timeRange, now);
    if (!(endMs > startMs) || endMs - startMs > max * 60000) {
      const fitting = tr.QUICK_RANGES.filter((option) => option.to === "now" && /^now-\d+[smhdwMy]$/.test(option.from))
        .filter((option) => { const r = tr.resolveRange(option, now); return r.endMs - r.startMs <= max * 60000; });
      model.timeRange = fitting.length ? { from: fitting[fitting.length - 1].from, to: "now" } : { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
    }
    refreshCustomRangeLabel();
  }

  // Relative ranges ("now-1h") are resolved again for every request.
  function selectedRange() {
    const tr = ns.timeRange;
    const { startMs, endMs } = tr.resolveRange(model.timeRange, Date.now());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Select a valid time range.");
    if (endMs - startMs > maxRangeMinutes() * 60000) throw new Error(`Max range is ${tr.formatMinutes(maxRangeMinutes())} (server setting traces.max_lookback_minutes).`);
    return { start_ms: Math.round(startMs), end_ms: Math.round(endMs), align_buckets: tr.isRelative(model.timeRange) ? "1" : "0" };
  }

  function replaceSelectOptions(select, values, allLabel) {
    if (!select) return;
    const previous = String(select.value || "");
    // A value applied from the URL or a filter action (app_trace_search.js)
    // stays selectable even when the discovered pairs do not list it.
    const wanted = String(select.dataset.wanted || "");
    const unique = [...new Set([...(values || []), wanted].map((value) => String(value || "")).filter(Boolean))].sort();
    h.replace(select, h("option", { value: "" }, allLabel || "All"), unique.map((value) => h("option", { value }, value)));
    select.value = wanted || (unique.includes(previous) ? previous : "");
    select.dispatchEvent(new Event("tracepicker-refresh"));
  }

  function updateServiceOptions() {
    const operation = String(dom.tracesOperation?.value || "").trim();
    const services = model.prefillPairs
      .filter((pair) => !operation || String(pair?.[1] || "") === operation)
      .map((pair) => pair?.[0]);
    replaceSelectOptions(dom.tracesService, services, "All");
  }

  function updateOperationOptions() {
    const service = String(dom.tracesService?.value || "").trim();
    const operations = model.prefillPairs
      .filter((pair) => !service || String(pair?.[0] || "") === service)
      .map((pair) => pair?.[1]);
    replaceSelectOptions(dom.tracesOperation, operations, "All");
  }

  function serviceOperationPairExists(service, operation) {
    if (!service || !operation) return true;
    return model.prefillPairs.some((pair) => String(pair?.[0] || "") === service && String(pair?.[1] || "") === operation);
  }

  function syncServiceOperationPair(preferred = "service") {
    let service = String(dom.tracesService?.value || "").trim();
    let operation = String(dom.tracesOperation?.value || "").trim();
    if (service && operation && !serviceOperationPairExists(service, operation)) {
      if (preferred === "operation") {
        dom.tracesService.value = "";
        service = "";
      } else {
        dom.tracesOperation.value = "";
        operation = "";
      }
    }
    updateServiceOptions();
    updateOperationOptions();
  }

  function resolvedServiceValues() {
    const value = String(dom.tracesService?.value || "").trim();
    return value ? [value] : [];
  }

  function resolvedOperationValues() {
    const value = String(dom.tracesOperation?.value || "").trim();
    return value ? [value] : [];
  }

  function syncFilterFeatures() {
    const f = model.meta?.features || {};
    const bindings = [[dom.tracesService, f.service_filter !== false], [dom.tracesOperation, f.operation_filter !== false], [dom.tracesStatus, f.status_filter !== false]];
    for (const [input, enabled] of bindings) {
      const field = input?.closest?.(".traceSearchField") || input?.closest?.("label");
      if (field) field.hidden = !enabled;
      if (input) input.disabled = !enabled;
    }
    syncRangeControls();
    if (dom.tracesLimit && model.meta) {
      const max = Math.max(1, Number(model.meta.search_limit || 100));
      for (const option of dom.tracesLimit.options) {
        const unavailable = Number(option.value) > max;
        option.disabled = unavailable;
        option.hidden = unavailable;
      }
      const enabled = Array.from(dom.tracesLimit.options).filter((option) => !option.disabled && !option.hidden);
      if (!enabled.some((option) => option.value === dom.tracesLimit.value) && enabled.length) {
        dom.tracesLimit.value = enabled[enabled.length - 1].value;
      }
      dom.tracesLimit.dispatchEvent(new Event("tracepicker-refresh"));
    }
    const tagEnabled = model.meta?.tag_search_supported !== false;
    if (dom.tracesTagKey) dom.tracesTagKey.disabled = !tagEnabled;
    if (dom.tracesTagValue) dom.tracesTagValue.disabled = !tagEnabled;
    const tagOp = byId("tracesTagOp");
    if (tagOp) tagOp.disabled = !tagEnabled;
    renderAnalytics();
  }

  function renderSource() {}

  function unpackSearch(payload) {
    const services = Array.isArray(payload?.services) ? payload.services : [];
    palette.registerServices(services);
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    model.traces = rows.map((row) => ({
      trace_id: String(row?.[0] || ""),
      start_ms: Number(row?.[1] || 0),
      root_operation: String(row?.[2] || ""),
      root_service: services[Number(row?.[3] || 0)] || "unknown",
      duration_ns: Number(row?.[4] || 0),
      span_count: Number(row?.[5] || 0),
      error_count: Number(row?.[6] || 0),
      service_stats: orderByFirstSpan((Array.isArray(row?.[7]) ? row[7] : []).map((stat) => ({ service: services[Number(stat?.[0] || 0)] || "unknown", spans: Number(stat?.[1] || 0), errors: Number(stat?.[2] || 0), first_span_ns: Number(stat?.[3] || 0) }))),
      // Parent span ids no listed span carries (0 from older servers).
      missing_parents: Number(row?.[8] || 0),
    }));
  }

  // A trace's services read in the order they joined it: by their earliest
  // span start (offset from the trace start), then by name.
  function orderByFirstSpan(stats) {
    return stats.sort((a, b) => (a.first_span_ns - b.first_span_ns) || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
  }

  function unpackAnalytics(payload, previous = null) {
    const charts = Array.isArray(payload?.charts) ? payload.charts.map(String) : ["counts", "durations"];
    const hasDurations = charts.includes("durations");
    return {
      range: Array.isArray(payload?.range) ? payload.range.map(Number) : [0, 1],
      bucket_ms: Number(payload?.bucket_ms || 60000),
      quantile_bucket_ms: Number(payload?.quantile_bucket_ms || payload?.bucket_ms || 60000),
      trace_count_chart: Array.isArray(payload?.trace_count_chart) ? payload.trace_count_chart : [],
      trace_count_source: String(payload?.trace_count_source || "span_bounds"),
      has_durations: hasDurations,
      duration_quantiles: hasDurations
        ? (Array.isArray(payload?.duration_quantiles) ? payload.duration_quantiles : [])
        : (previous?.duration_quantiles || []),
    };
  }

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
    if (!container || !ns.chartCore) return null;
    const held = mountedCharts.get(container);
    if (held && held.kind === kind && container.contains(held.chart.root)) {
      held.chart.setData(options);
      return held.chart;
    }
    if (held) held.chart.destroy();
    container.textContent = "";
    const chart = ns.chartCore.create(container, { height: CHART_HEIGHT, ...options });
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
    const format = ns.timeRange?.formatDateTime;
    if (!range || !format) return;
    const from = Math.floor(range[0] / 1000) * 1000;
    const to = Math.max(from + 1000, Math.ceil(range[1] / 1000) * 1000);
    void applyCustomRange({ from: format(from), to: format(to) }, "chart");
  }

  // retry: "analytics" or "durations" adds a Retry button (handled by the
  // search view's click listener, init).
  function chartMessage(container, text, isError = false, retry = "") {
    if (!container) return;
    unmountChart(container);
    const state = ns.uiState;
    container.innerHTML = isError
      ? state.errorHtml({ body: text, compact: true, retry: retry ? { attrs: { "data-chart-retry": retry } } : null })
      : state.emptyHtml({ body: text, compact: true });
  }

  // Bucket starts on a regular grid from the first to the last bucket, the
  // value of each (0 / NaN where the answer has none).
  function bucketGrid(buckets, bucketMs, empty) {
    const first = buckets[0][0];
    const count = Math.max(1, Math.min(20000, Math.round((buckets[buckets.length - 1][0] - first) / bucketMs) + 1));
    const starts = new Float64Array(count);
    for (let i = 0; i < count; i += 1) starts[i] = first + i * bucketMs;
    const slot = new Int32Array(buckets.length);
    buckets.forEach(([bucket], k) => { slot[k] = Math.max(0, Math.min(count - 1, Math.round((bucket - first) / bucketMs))); });
    return { starts, slot, empty };
  }

  function renderServiceChart() {
    const container = dom.traceServiceChart;
    if (!container) return;
    const a = model.analytics;
    const points = a?.trace_count_chart || [];
    const range = a?.range || [0, 1];
    const bucketMs = Math.max(1000, Number(a?.bucket_ms || 60000));
    const start = Number(range[0] || 0), end = Math.max(start + 1000, Number(range[1] || start + bucketMs));
    // Buckets are keyed by their start on the server's grid (anchored at the
    // local midnight sent as bucket_origin_ms) and placed by time, so a range
    // that does not start on the grid still shows every bucket.
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

  // Legend choices (shown / hidden percentiles) survive new answers: P50
  // and P99 show by default, P90 and P95 one legend click away.
  let durationHidden = ["p90", "p95"];
  // The listed traces of the scatter, in the order of its x column (start).
  let scatterTraces = [];

  function renderDurationChart() {
    const container = dom.traceDurationChart;
    if (!container) return;
    // Heatmap mode (app_trace_heatmap.js) draws the card itself.
    if (ns.traceHeatmap?.active?.()) { ns.traceHeatmap.render(); return; }
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
    // Percentiles on the bucket grid: lines break over buckets without
    // traces (NULL), and a lone bucket shows as a dot.
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
    // Jaeger's scatter plot: one dot per listed trace (x = start, y =
    // duration, radius by span count, red with errors), over the percentiles.
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
        id: "traces", label: "Listed traces", type: "points", xs: dotXs, values: dotYs, radius, color: "var(--traceDot)", pickable: true,
        pointColor: (i) => (Number(scatterTraces[i].error_count || 0) > 0 ? "var(--danger)" : null),
      });
    }
    const traceAt = (hit) => (hit?.seriesId === "traces" ? scatterTraces[hit.index] : null);
    mountChart(container, "percentiles", {
      xKind: "time", xs, xDomain: [xMin, xMax], zoom: null, series, type: "line", fill: false,
      hidden: durationHidden, onHiddenChange: (hidden) => { durationHidden = [...hidden]; },
      legend: true, syncKey: CHART_SYNC_KEY, tooltipNulls: false,
      // Jaeger's ['auto', 'auto'] domain, whole duration steps.
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
      onPick: (hit) => { const trace = traceAt(hit); if (trace) loadTrace(trace.trace_id, { push: true }); },
      onZoom: (zoomed, fromUser) => { if (fromUser && zoomed) zoomSearchRange(zoomed); },
    });
    if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = `${scatterTraces.length ? `${fmt.count(scatterTraces.length)} listed trace${scatterTraces.length === 1 ? "" : "s"} + ` : ""}P50 / P90 / P95 / P99 · ${fmt.duration.fromMs(qBucketMs)} buckets`;
  }

  // The scatter dots as drawn (test and debugging hook): client coordinates.
  function scatterDots() {
    const held = dom.traceDurationChart && mountedCharts.get(dom.traceDurationChart);
    if (!held || held.kind !== "percentiles") return [];
    const box = $(".chartCore__plot", held.chart.root).getBoundingClientRect();
    return held.chart.points("traces").map((dot) => {
      const trace = scatterTraces[dot.index];
      return { trace_id: trace.trace_id, error: Number(trace.error_count || 0) > 0, spans: Number(trace.span_count || 0), x: box.left + dot.x, y: box.top + dot.y, r: dot.r };
    });
  }

  // Remembers whether meta enables analytics for the head script of the next
  // page load (see observability.html), and drops the early class once meta is known.
  function rememberAnalyticsEnabled(enabled) {
    ns.storage.pref(ns.storage.KEYS.traceAnalytics, false).set(enabled);
    document.documentElement.classList.remove("chdash-trace-analytics");
  }

  function renderAnalytics() {
    const enabled = model.meta?.analytics_enabled === true;
    if (model.meta) rememberAnalyticsEnabled(enabled);
    if (dom.traceAnalyticsGrid) dom.traceAnalyticsGrid.hidden = !enabled;
    // Busy from the search's first chart request to its last answer.
    ns.uiState.busy(dom.traceAnalyticsGrid, enabled && model.analyticsLoading);
    if (!enabled) return;
    // The heatmap loads on its own: the count chart states do not apply to it.
    const heatmap = ns.traceHeatmap?.active?.() === true;
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

  // The shared copy (ui.copyText): the clipboard (a textarea copy on plain
  // http) and the one "Copied" feedback on the control.
  function copyText(text, button) {
    return ns.ui.copyText(text, button);
  }

  // --- Search results: Jaeger-style list and sortable table ---------------
  const RESULTS_VIEW_KEY = ns.storage.KEYS.traceResultsView;
  const START_DISPLAY_KEY = ns.storage.KEYS.traceStartDisplay;

  function readStored(key, allowed, fallback) {
    return ns.storage.pref(key, fallback, { allowed }).get();
  }

  function writeStored(key, value) {
    ns.storage.pref(key, "").set(value);
  }

  // The list follows the sort picker; the table sorts by its column headers
  // (both directions), starting from the picker's order.
  const LIST_SORTS = {
    recent: { key: "start", dir: "desc" },
    longest: { key: "duration", dir: "desc" },
    shortest: { key: "duration", dir: "asc" },
    spans: { key: "spans", dir: "desc" },
  };
  const TABLE_COLUMNS = [
    { key: "name", label: "Name", numeric: false },
    { key: "services", label: "Services", numeric: true },
    { key: "spans", label: "Spans", numeric: true },
    { key: "errors", label: "Errors", numeric: true },
    { key: "duration", label: "Duration", numeric: true },
    { key: "start", label: "Start", numeric: true },
  ];

  function traceName(trace) {
    return `${trace.root_service || "unknown"}: ${trace.root_operation || "trace"}`;
  }

  function compareText(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function traceSortValue(trace, key) {
    if (key === "name") return traceName(trace).toLowerCase();
    if (key === "services") return (trace.service_stats || []).length;
    if (key === "spans") return Number(trace.span_count || 0);
    if (key === "errors") return Number(trace.error_count || 0);
    if (key === "duration") return Number(trace.duration_ns || 0);
    return Number(trace.start_ms || 0);
  }

  function sortTraces(rows, { key, dir }) {
    const sign = dir === "asc" ? 1 : -1;
    // Ties keep the newest trace first, then the trace id, in both directions.
    return rows.sort((a, b) => {
      const av = traceSortValue(a, key), bv = traceSortValue(b, key);
      const cmp = typeof av === "string" ? compareText(av, bv) : av - bv;
      return (cmp * sign) || (Number(b.start_ms || 0) - Number(a.start_ms || 0)) || compareText(a.trace_id, b.trace_id);
    });
  }

  function listSort() {
    return LIST_SORTS[String(dom.tracesSort?.value || "recent")] || LIST_SORTS.recent;
  }

  function sortedResults() {
    const rows = [...(model.traces || [])];
    return sortTraces(rows, model.resultsView === "table" ? (model.tableSort || listSort()) : listSort());
  }

  function incompleteTooltip(count) {
    const noun = count === 1 ? "span" : "spans";
    return `This trace may be incomplete: its spans reference ${count} parent ${noun} missing from the searched range. `
      + "This happens when the trace crosses the range, when a parent span belongs to a service you cannot see, "
      + "or while the trace is still being collected.";
  }

  function errorTagHtml(errors) {
    const label = `${fmt.count(errors)} Error${errors === 1 ? "" : "s"}`;
    const title = `${fmt.count(errors)} error span${errors === 1 ? "" : "s"}`;
    return ns.badge.html(label, { tone: "error", className: "traceTag traceTag--error traceErrorCount--title", title, attrs: { "aria-label": title } });
  }

  function incompleteTagHtml(missing) {
    return ns.badge.html("", { tone: "warn", className: "traceTag traceTag--incomplete", title: incompleteTooltip(missing), attrs: { "data-missing-parents": missing }, html: `${ns.icon("alert-triangle", { size: "sm" })}Incomplete` });
  }

  function servicePillHtml(stat) {
    const errors = Number(stat.errors || 0);
    const errorTitle = errors ? ` · ${fmt.count(errors)} error span${errors === 1 ? "" : "s"}` : "";
    // A service chip: the shared badge with the service's left bar.
    return `<span class="badge badge--md badge--neutral traceSvcPill${errors ? " has-errors" : ""}" data-service="${esc(stat.service)}" data-spans="${esc(stat.spans)}" data-errors="${errors}" style="--trace-service-color:${palette.service(stat.service)}" title="${esc(stat.service)} \u00b7 ${fmt.count(stat.spans)} span${stat.spans === 1 ? "" : "s"}${errorTitle}"><i class="serviceSwatch serviceSwatch--bar" aria-hidden="true"></i>${errors ? ns.badge.html("!", { tone: "error", solid: true, className: "badge--count traceSvcPill__error", attrs: { "aria-label": "has errors" } }) : ""}<b>${esc(stat.service)}</b> <span class="traceSvcPill__count">(${fmt.count(stat.spans)})</span></span>`;
  }

  // One line of service pills; layoutServicePills hides the ones that do not
  // fit and shows them behind a "+N" chip.
  function servicePillsHtml(stats) {
    if (!stats.length) return `<div class="traceSvcPills is-empty">${fmt.EMPTY}</div>`;
    return `<div class="traceSvcPills">${stats.map(servicePillHtml).join("")}<button type="button" class="badge badge--md badge--neutral traceSvcMore" hidden>+0</button></div>`;
  }

  function layoutServicePills(scope) {
    const groups = [...($$(".traceSvcPills:not(.is-empty)", scope) || [])];
    if (!groups.length) return;
    // Write, read, then write again: one layout pass for the whole list.
    const prepared = groups.map((group) => {
      const pills = [...$$(":scope > .traceSvcPill", group)];
      const more = $(":scope > .traceSvcMore", group);
      for (const pill of pills) pill.hidden = false;
      if (more) { more.hidden = false; more.textContent = `+${pills.length}`; }
      // Natural widths: no pill shrinks while measuring.
      group.classList.add("is-measuring");
      return { group, pills, more };
    });
    const gap = parseFloat(getComputedStyle(groups[0]).columnGap) || 4;
    const measured = prepared.map((item) => ({
      ...item,
      width: item.group.clientWidth,
      widths: item.pills.map((pill) => pill.offsetWidth),
      moreWidth: item.more ? item.more.offsetWidth : 0,
    }));
    for (const { group, pills, more, width, widths, moreWidth } of measured) {
      group.classList.remove("is-measuring");
      if (!width) { if (more) more.hidden = true; continue; }
      let used = 0;
      let shown = 0;
      const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
      if (total <= width + 0.5) shown = pills.length;
      else {
        for (let i = 0; i < widths.length; i += 1) {
          const next = used + (i ? gap : 0) + widths[i];
          if (next + gap + moreWidth > width + 0.5) break;
          used = next;
          shown = i + 1;
        }
        // The first pill always shows (ellipsized when it alone is too wide).
        shown = Math.max(1, shown);
      }
      pills.forEach((pill, index) => { pill.hidden = index >= shown; });
      if (more) {
        const rest = pills.length - shown;
        more.hidden = rest <= 0;
        more.textContent = `+${rest}`;
        more.setAttribute("aria-label", `${rest} more service${rest === 1 ? "" : "s"}`);
      }
      group.classList.toggle("is-overflowing", shown < pills.length);
    }
  }

  // The hidden pills of a row, in a tooltip under its "+N" chip (hover,
  // focus or a click: ns.popover.tip).
  let serviceTip = null;
  function hiddenPills(more) {
    if (!more || more.hidden) return null;
    const hidden = [...$$(":scope > .traceSvcPill[hidden]", more.parentElement)];
    if (!hidden.length) return null;
    const list = document.createDocumentFragment();
    for (const pill of hidden) { const copy = pill.cloneNode(true); copy.hidden = false; list.appendChild(copy); }
    return list;
  }
  function hideServicePopover() {
    serviceTip?.hide();
  }

  // A trace start: the shown time, how long ago, and the tooltip of both
  // (fmt.timeTitle: ISO, local and UTC).
  function startTexts(trace) {
    const ms = parseStartMs(trace.start_ms);
    if (!Number.isFinite(ms)) return { absolute: String(trace.start_ms || fmt.EMPTY), ago: "", title: "", timeTitle: "" };
    const timeTitle = fmt.timeTitle(ms);
    return { absolute: fmt.time(ms), ago: fmt.ago(ms), title: `${fmt.ago(ms)}\n${timeTitle}`, timeTitle };
  }

  function resultItemHtml(trace, maxDurationNs) {
    const errors = Number(trace.error_count || 0);
    const missing = Number(trace.missing_parents || 0);
    const title = traceName(trace);
    const spans = Number(trace.span_count || 0);
    const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
    const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
    const start = startTexts(trace);
    return `<div class="traceResult traceResult--wide traceResultItem" data-trace-id="${esc(trace.trace_id)}" role="button" tabindex="0">
        <div class="traceResult__line traceResult__line--main traceResultItem__title">
          <span class="traceResultItem__durationBar" style="width:${percent.toFixed(2)}%" data-duration-percent="${percent.toFixed(2)}" aria-hidden="true"></span>
          <strong title="${esc(title)}" class="traceResult__wideTitle">${esc(title)}</strong>${errors ? errorTagHtml(errors) : ""}${missing ? incompleteTagHtml(missing) : ""}
          <code class="traceResult__fullId">${esc(trace.trace_id)}</code>
          ${ns.ui.copyButtonHtml({ label: "Copy Trace ID", className: "traceCopyButton", attrs: { "data-copy-trace": trace.trace_id } })}
          <span class="traceResult__right"><b>${esc(fmt.duration(trace.duration_ns))}</b></span>
        </div>
        <div class="traceResult__line traceResult__line--stats">
          ${ns.badge.html(`${fmt.count(spans)} Span${spans === 1 ? "" : "s"}`, { className: "traceTag traceTag--spans" })}
          ${servicePillsHtml(services)}
          <span class="traceResult__when" title="${esc(start.title)}"><time>${esc(start.absolute)}</time><small>${esc(start.ago)}</small></span>
        </div>
      </div>`;
  }

  function resultTableHtml(rows, maxDurationNs) {
    const sort = model.tableSort || listSort();
    const relative = model.startDisplay === "relative";
    const head = TABLE_COLUMNS.map((column) => {
      const active = sort.key === column.key;
      const aria = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
      const toggle = column.key === "start"
        ? `<button type="button" class="traceTable__startToggle" data-start-toggle title="${relative ? "Show absolute time" : "Show relative time"}" aria-label="Toggle start time format">${ns.icon("arrows-exchange", { size: "sm" })}</button>`
        : "";
      const num = column.numeric && column.key !== "services" ? " num" : "";
      return `<th class="is-sortable traceTable__th traceTable__th--${column.key}${num}" data-table-sort="${column.key}" data-sort-key="${column.key}" aria-sort="${aria}" scope="col"><button type="button" class="dataTable__sort">${column.label}</button>${toggle}</th>`;
    }).join("");
    const body = rows.map((trace) => {
      const errors = Number(trace.error_count || 0);
      const missing = Number(trace.missing_parents || 0);
      const name = traceName(trace);
      const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
      const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
      const { absolute, ago, title: startTitle, timeTitle: startTimeTitle } = startTexts(trace);
      return `<tr class="traceTable__row" data-trace-id="${esc(trace.trace_id)}" tabindex="-1">
        <td class="traceTable__name has-copy" data-cell="name"><span class="traceTable__nameText" title="${esc(name)}"><b>${esc(trace.root_service || "unknown")}:</b> ${esc(trace.root_operation || "trace")}</span>${missing ? incompleteTagHtml(missing) : ""}${ns.table.copyCellHtml(trace.trace_id, "Copy Trace ID")}</td>
        <td class="traceTable__services" data-cell="services">${servicePillsHtml(services)}</td>
        <td class="num" data-cell="spans">${fmt.count(Number(trace.span_count || 0))}</td>
        <td class="num" data-cell="errors">${errors ? ns.badge.html(fmt.count(errors), { tone: "error", className: "badge--count traceErrorBadge", title: `${fmt.count(errors)} error span${errors === 1 ? "" : "s"}` }) : "0"}</td>
        <td class="num traceTable__duration cellBar" data-cell="duration" data-duration-percent="${percent.toFixed(2)}" style="${ns.table.cellBarStyle(percent)}" title="${esc(fmt.duration(trace.duration_ns))}">${esc(fmt.duration(trace.duration_ns))}</td>
        <td class="num traceTable__start" data-cell="start" title="${esc(relative ? startTimeTitle : startTitle)}">${esc(relative ? ago : absolute)}</td>
      </tr>`;
    }).join("");
    return `<div class="tableWrap traceTableWrap"><table class="dataTable traceTable" aria-label="Traces"><colgroup><col class="traceTable__col--name"><col class="traceTable__col--services"><col class="traceTable__col--spans"><col class="traceTable__col--errors"><col class="traceTable__col--duration"><col class="traceTable__col--start"></colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function syncResultsViewControls() {
    const table = model.resultsView === "table";
    ns.segmented?.set($(".traceResultsViewToggle"), model.resultsView, "resultsView");
    // Like Jaeger, the sort picker drives the list; the table sorts by its headers.
    const sortLabel = $(".traceResultsSort");
    if (sortLabel) sortLabel.hidden = table;
    dom.tracesResults?.classList.toggle("tracesResults--table", table);
  }

  // persist: false for a view restored from the URL (the stored preference
  // is the user's own last choice).
  function setResultsView(view, { persist = true } = {}) {
    const next = view === "table" ? "table" : "list";
    if (next === model.resultsView) return;
    model.resultsView = next;
    if (persist) writeStored(RESULTS_VIEW_KEY, next);
    if (next === "table") model.tableSort = { ...listSort() };
    renderResults();
    if (persist && !traceIdFromPath()) address.replace();
  }

  function sortTableBy(key) {
    const column = TABLE_COLUMNS.find((item) => item.key === key);
    if (!column) return;
    const current = model.tableSort || listSort();
    model.tableSort = current.key === key
      ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
      : { key, dir: column.numeric ? "desc" : "asc" };
    renderResults();
    $(`[data-table-sort="${key}"] .dataTable__sort`, dom.tracesResults)?.focus({ preventScroll: true });
  }

  // "No traces / spans found" (the result list and the span table): the
  // range searched and the ways out, a wider range and no filters.
  function noResultsHtml(noun, range, attrs = {}) {
    const when = range ? `between ${fmt.time(range.start)} and ${fmt.time(range.end)}` : "in this range";
    const zoom = dom.tracesRangeZoomOut;
    const filtered = !!ns.traceSearch?.hasFilters?.();
    return ns.uiState.emptyHtml({
      title: `No ${noun} found`,
      body: `No ${noun} match these filters ${when}.`,
      attrs: { "data-empty-results": "", ...attrs },
      actions: [
        zoom && !zoom.disabled ? { label: "Zoom out", icon: "zoomOut", attrs: { "data-results-zoom-out": "" } } : null,
        filtered ? { label: "Clear filters", attrs: { "data-results-clear-filters": "" } } : null,
      ],
    });
  }

  function emptyResultsHtml() {
    if (!model.searched) return ns.uiState.emptyHtml({ body: "Search to load traces." });
    const range = model.lastSearchRange;
    return noResultsHtml("traces", range ? { start: range.start_ms, end: range.end_ms } : null);
  }

  function renderResultCount(rows) {
    const count = byId("tracesResultCount");
    if (!count) return;
    const withErrors = rows.filter((trace) => Number(trace.error_count || 0) > 0).length;
    const latency = model.searched && Number.isFinite(model.searchLatencyMs)
      && [" ", h("span", { class: "tracesResultCount__latency", title: "Search request time, measured in the browser" }, `(in ${fmt.duration.fromMs(model.searchLatencyMs)})`)];
    h.replace(count, `${fmt.count(rows.length)} Trace${rows.length === 1 ? "" : "s"}`, latency,
      withErrors > 0 && [" ", h("span", { class: "tracesResultCount__errors", title: `${fmt.count(withErrors)} of the listed traces have error spans` }, `· ${fmt.count(withErrors)} with error${withErrors === 1 ? "" : "s"}`)]);
  }

  let resultsResizeObserver = null;
  const resultsResizeFrame = util.rafOnce(() => {
    hideServicePopover();
    layoutServicePills(dom.tracesResults);
  });
  function watchResultsWidth() {
    if (resultsResizeObserver || typeof ResizeObserver !== "function" || !dom.tracesResults) return;
    let lastWidth = -1;
    resultsResizeObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1]?.contentRect?.width || 0);
      if (width === lastWidth || resultsResizeFrame.pending()) return;
      lastWidth = width;
      resultsResizeFrame();
    });
    resultsResizeObserver.observe(dom.tracesResults);
  }

  let resultEventsBound = false;
  function bindResultEvents() {
    const root = dom.tracesResults;
    if (resultEventsBound || !root) return;
    resultEventsBound = true;
    const openRow = (row) => { const id = row?.getAttribute("data-trace-id"); if (id) loadTrace(id, { push: true }); };
    root.addEventListener("click", (event) => {
      const target = event.target;
      const copy = target.closest("[data-copy-trace]");
      if (copy) { event.stopPropagation(); copyText(copy.getAttribute("data-copy-trace") || "", copy); return; }
      const more = target.closest(".traceSvcMore");
      if (more) {
        event.stopPropagation();
        serviceTip?.show(more);
        return;
      }
      if (target.closest("[data-results-zoom-out]")) { dom.tracesRangeZoomOut?.click(); return; }
      if (target.closest("[data-results-clear-filters]")) { ns.traceSearch?.clearFilters?.(); void search(); return; }
      if (target.closest("[data-start-toggle]")) {
        event.stopPropagation();
        model.startDisplay = model.startDisplay === "relative" ? "absolute" : "relative";
        writeStored(START_DISPLAY_KEY, model.startDisplay);
        renderResults();
        $("[data-start-toggle]", dom.tracesResults)?.focus({ preventScroll: true });
        return;
      }
      const th = target.closest("[data-table-sort]");
      // Anywhere on a header sorts (the start toggle returned above).
      if (th) { sortTableBy(th.getAttribute("data-table-sort")); return; }
      const row = target.closest("[data-trace-id]");
      if (row && root.contains(row)) openRow(row);
    });
    // The list cards are buttons; the table rows rove (ns.rovingRows).
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (target.closest("button") || !target.matches(".traceResultItem")) return;
      event.preventDefault();
      openRow(target);
    });
    serviceTip = ns.popover.tip(root, hiddenPills, { selector: ".traceSvcMore", side: "bottom", className: "traceSvcPopover" });
    ns.table.rovingRows(root, { rows: "tr.traceTable__row", onOpen: (row) => openRow(row) });
    ns.table.bindCopy(root);
    // List | Table: the shared segmented control (app_ui_segmented.js).
    ns.segmented?.bind($(".traceResultsViewToggle"), { attr: "resultsView", onChange: (view) => { setResultsView(view); return false; } });
  }

  function renderResults() {
    if (!dom.tracesResults) return;
    bindResultEvents();
    watchResultsWidth();
    hideServicePopover();
    syncResultsViewControls();
    // Spans mode draws its own span table (app_trace_spans.js).
    if (ns.traceSpans?.active?.()) {
      renderAnalytics();
      ns.traceSpans.render();
      return;
    }
    ns.traceSpans?.leave?.();
    const rows = sortedResults();
    renderResultCount(rows);
    renderAnalytics();
    if (!rows.length) {
      dom.tracesResults.innerHTML = emptyResultsHtml();
      return;
    }
    const maxDurationNs = Math.max(0, ...rows.map((trace) => Number(trace.duration_ns || 0)));
    dom.tracesResults.innerHTML = model.resultsView === "table"
      ? resultTableHtml(rows, maxDurationNs)
      : rows.map((trace) => resultItemHtml(trace, maxDurationNs)).join("");
    layoutServicePills(dom.tracesResults);
  }

  // An all-zero parent id is how some exporters write "no parent".
  function parentSpanId(span) {
    const id = String(span?.parent_span_id || "");
    return /^0*$/.test(id) ? "" : id;
  }

  function buildTree(spans) {
    const nodes = (Array.isArray(spans) ? spans : []).map((span) => ({ span, children: [], depth: 0 }));
    const itemById = new Map(nodes.map((node) => [String(node.span.span_id || ""), node]));
    const roots = [];
    for (const node of nodes) {
      const parentId = parentSpanId(node.span);
      const parent = parentId ? itemById.get(parentId) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const cmp = (a, b) => Number(a.span.start_ns || 0) - Number(b.span.start_ns || 0) || String(a.span.span_id || "").localeCompare(String(b.span.span_id || ""));
    // Iterative: a long parent chain must not exhaust the call stack.
    roots.sort(cmp);
    const stack = roots.map((root) => [root, 0]);
    while (stack.length) {
      const [node, depth] = stack.pop();
      node.depth = Math.min(32, depth);
      node.children.sort(cmp);
      for (const child of node.children) stack.push([child, depth + 1]);
    }
    return { nodes, roots };
  }

  // Tree order, without the descendants of collapsed spans.
  function visibleNodes(cache) {
    const rows = [];
    let hiddenBelow = -1;
    for (const node of cache.order) {
      if (hiddenBelow >= 0) {
        if (node.level > hiddenBelow) continue;
        hiddenBelow = -1;
      }
      rows.push(node);
      if (node.children.length && model.collapsed.has(spanKey(node))) hiddenBelow = node.level;
    }
    return rows;
  }

  // Single pass, no argument spreading: Math.min(...list) throws RangeError
  // once a trace approaches ~100k spans and allocates two temporary arrays.
  function spanExtent(spans) {
    let start = Infinity;
    let end = -Infinity;
    for (const s of spans) {
      const spanStart = Number(s.start_ns || 0);
      const spanEnd = spanStart + Number(s.duration_ns || 0);
      if (Number.isFinite(spanStart) && spanStart < start) start = spanStart;
      if (spanEnd > end) end = spanEnd;
    }
    return { start, end };
  }

  function traceBounds(spans) {
    const { start, end } = spanExtent(spans);
    if (!Number.isFinite(start)) return { start: 0, end: 1, duration: 1 };
    return { start, end, duration: Math.max(1, end - start) };
  }

  function isErrorSpan(span) {
    return String(span?.status_code || "").toLowerCase() === "error";
  }

  function spanKey(node) {
    return String(node?.span?.span_id || "");
  }

  // Everything derived from the loaded trace alone (tree, tree order, bounds,
  // per-service stats, parsed event markers and attribute decorations, the
  // critical path) is computed once per trace. The waterfall re-renders on
  // every toggle, service filter and range change; rebuilding the tree and
  // re-parsing each span's JSON on every render dominated those interactions.
  let traceCache = null;

  function activeTraceCache() {
    const trace = model.activeTrace;
    if (traceCache && traceCache.trace === trace) return traceCache;
    const spans = trace?.spans || [];
    const tree = buildTree(spans);
    const nodeById = new Map();
    const duplicateIds = new Set();
    const parentOf = new Map();
    for (const node of tree.nodes) {
      const id = String(node.span.span_id || "");
      if (nodeById.has(id)) duplicateIds.add(id);
      else nodeById.set(id, node);
      node.children.forEach((child, index) => {
        parentOf.set(child, node);
        child.isLast = index === node.children.length - 1;
      });
    }
    // Tree (waterfall) order with uncapped levels, like Jaeger's span list.
    const order = [];
    const stack = tree.roots.slice().reverse().map((node) => [node, 0]);
    while (stack.length) {
      const [node, level] = stack.pop();
      node.level = level;
      node.orderIndex = order.length;
      order.push(node);
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push([node.children[i], level + 1]);
    }
    // Spans with an error span somewhere below them.
    const errorBelow = new Set();
    let maxLevel = 0;
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const node = order[i];
      if (node.level > maxLevel) maxLevel = node.level;
      const parent = parentOf.get(node);
      if (parent && (isErrorSpan(node.span) || errorBelow.has(node))) errorBelow.add(parent);
    }
    traceCache = {
      trace,
      spans,
      tree,
      nodeById,
      duplicateIds,
      parentOf,
      order,
      errorBelow,
      maxLevel,
      // Spans whose parent is not in the trace (Jaeger's orphan spans).
      orphanCount: tree.roots.filter((node) => parentSpanId(node.span)).length,
      errorCount: spans.filter(isErrorSpan).length,
      serviceCount: new Set(spans.map((span) => String(span.service_name || "unknown"))).size,
      extent: spanExtent(spans),
      bounds: traceBounds(spans),
      serviceStats: null,
      events: new Map(),
      decorations: new Map(),
      criticalPath: null,
    };
    return traceCache;
  }

  // Event markers only need each event's time and label; parse the JSON arrays once.
  function spanEventMarkers(cache, span) {
    let markers = cache.events.get(span);
    if (!markers) {
      const eventTimes = parseStructuredValue(span.events_timestamp);
      const eventNames = parseStructuredValue(span.events_name);
      const events = Array.isArray(eventTimes) ? eventTimes : [];
      markers = events.map((value, index) => ({
        ns: timestampToNs(value),
        name: Array.isArray(eventNames) && eventNames[index] != null ? String(eventNames[index]) : `Event ${index + 1}`,
      }));
      cache.events.set(span, markers);
    }
    return markers;
  }

  // --- Span decorations (Jaeger's spanDecorations.ts) ------------------------
  // A namespace icon (db, http, messaging, rpc: the first attribute namespace
  // present) and the values of well-known attributes, both in the name
  // column: muted mono text (method, status, db / rpc / messaging system),
  // and a chip only for an http status of 400 or more (amber 4xx, red 5xx).
  const DECORATION_ICONS = {
    db: ns.icon("database", { size: "sm" }),
    http: ns.icon("world", { size: "sm" }),
    messaging: ns.icon("message", { size: "sm" }),
    rpc: ns.icon("arrows-exchange", { size: "sm" }),
  };
  // The chip tone of an http status: "warn" for 4xx, "error" for 5xx, none below.
  const httpStatusTone = (value) => {
    const code = Number(String(value).trim());
    return code >= 500 && code < 600 ? "error" : code >= 400 && code < 500 ? "warn" : "";
  };
  const SPAN_DECORATIONS = [
    { namespace: "db", label: "Database span", pills: [{ label: "db.system", keys: ["db.system.name", "db.system"] }] },
    {
      namespace: "http",
      label: "HTTP span",
      pills: [
        { label: "http.method", keys: ["http.method", "http.request.method"] },
        { label: "http.status_code", keys: ["http.status_code", "http.response.status_code"], tone: httpStatusTone },
      ],
    },
    { namespace: "messaging", label: "Messaging span", pills: [{ label: "messaging.system", keys: ["messaging.system"] }] },
    { namespace: "rpc", label: "RPC span", pills: [{ label: "rpc.system", keys: ["rpc.system.name", "rpc.system"] }] },
  ];

  function spanDecorations(cache, span) {
    let found = cache.decorations.get(span);
    if (found) return found;
    const parsed = parseStructuredValue(span.span_attributes);
    const attrs = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    const namespaces = new Set();
    for (const key of Object.keys(attrs)) {
      const dot = key.indexOf(".");
      if (dot > 0) namespaces.add(key.slice(0, dot));
    }
    const decoration = SPAN_DECORATIONS.find((entry) => namespaces.has(entry.namespace));
    const pills = [];
    for (const entry of SPAN_DECORATIONS) {
      for (const source of entry.pills) {
        for (const key of source.keys) {
          const raw = attrs[key];
          if (raw == null) continue;
          const value = (typeof raw === "object" ? JSON.stringify(raw) : String(raw)).trim();
          if (!value) continue;
          pills.push({ label: source.label, value, tone: source.tone?.(value) || "" });
          break;
        }
      }
    }
    found = {
      iconHtml: decoration ? `<span class="traceSpanRow__decoration" data-span-decoration="${decoration.namespace}" title="${esc(decoration.label)}">${DECORATION_ICONS[decoration.namespace]}</span>` : "",
      pillsHtml: pills.map((pill) => {
        const attrs = { "data-span-pill": pill.label, "aria-label": `${pill.label}: ${pill.value}` };
        if (pill.tone) return ns.badge.html(pill.value, { tone: pill.tone, className: `traceSpanPill is-${pill.tone}`, title: `${pill.label}: ${pill.value}`, attrs });
        return `<span class="traceSpanPill traceSpanPill--text" title="${esc(`${pill.label}: ${pill.value}`)}" data-span-pill="${esc(pill.label)}" aria-label="${esc(attrs["aria-label"])}">${esc(pill.value)}</span>`;
      }).join(""),
    };
    cache.decorations.set(span, found);
    return found;
  }

  // --- Critical path (Jaeger's CriticalPath/index.ts) ------------------------
  // From each root, follow the last finishing child; on the way back, the child
  // that finished last before the returning child started. A consumer child
  // of a producer does not block it, and children are first clipped to their
  // parent (sanitizeOverFlowingChildren). Iterative, so deep traces are safe.
  function criticalPathSections(cache) {
    if (cache.criticalPath) return cache.criticalPath;
    const byNode = new Map();
    const kind = (node) => String(node?.span?.span_kind || "").toLowerCase();
    const blocking = (child, parent) => !(kind(parent).includes("producer") && kind(child).includes("consumer"));
    const add = (node, start, end) => {
      if (start === end) return;
      const list = byNode.get(node);
      if (list) list.push({ start, end });
      else byNode.set(node, [{ start, end }]);
    };
    for (const root of cache.tree.roots) {
      // Like Jaeger, a span whose parent is missing (an orphan) and its
      // subtree get no critical path.
      if (parentSpanId(root.span)) continue;
      // Pre-order over blocking descendants: parents are clipped first.
      const list = [];
      const stack = [[root, null]];
      while (stack.length) {
        const [node, parent] = stack.pop();
        const start = Number(node.span.start_ns || 0);
        const cp = { node, parent, start, end: start + Number(node.span.duration_ns || 0), children: [], removed: false };
        if (parent) parent.children.push(cp);
        list.push(cp);
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          if (blocking(node.children[i], node)) stack.push([node.children[i], cp]);
        }
      }
      for (const cp of list) {
        const parent = cp.parent;
        if (!parent) continue;
        const drop = () => { cp.removed = true; parent.children = parent.children.filter((child) => child !== cp); };
        if (parent.removed) { cp.removed = true; continue; }
        if (cp.start >= parent.start) {
          if (cp.start >= parent.end) drop();
          else if (cp.end > parent.end) cp.end = parent.end;
        } else if (cp.end <= parent.start) {
          drop();
        } else {
          cp.start = parent.start;
          if (cp.end > parent.end) cp.end = parent.end;
        }
      }
      const lastFinishingChild = (cp, before) => {
        let best = null;
        for (const child of cp.children) {
          if (before != null && !(child.end < before)) continue;
          if (!best || child.end > best.end) best = child;
        }
        return best;
      };
      let current = list[0];
      let returning = null;
      for (let guard = list.length * 4 + 8; current && guard > 0; guard -= 1) {
        const child = lastFinishingChild(current, returning);
        const end = returning == null ? current.end : returning;
        if (child) {
          add(current.node, child.end, end);
          current = child;
          returning = null;
        } else {
          add(current.node, current.start, end);
          returning = current.start;
          current = current.parent;
        }
      }
    }
    cache.criticalPath = byNode;
    return byNode;
  }

  // A span's sections; a collapsed span shows those of its whole hidden subtree.
  function criticalSectionsFor(cache, node, collapsed) {
    const byNode = criticalPathSections(cache);
    if (!collapsed) return byNode.get(node) || [];
    const merged = [];
    const order = cache.order;
    for (let i = node.orderIndex; i < order.length && (i === node.orderIndex || order[i].level > node.level); i += 1) {
      for (const section of byNode.get(order[i]) || []) merged.push({ ...section });
    }
    merged.sort((a, b) => a.start - b.start);
    const out = [];
    for (const section of merged) {
      const last = out[out.length - 1];
      if (last && section.start <= last.end) last.end = Math.max(last.end, section.end);
      else out.push(section);
    }
    return out;
  }

  // --- Trace overview (Jaeger's SpanGraph) -----------------------------------
  // One row per span in tree order (the waterfall with every branch open),
  // Jaeger's geometry: 60..200 px high, rows H/N apart and 1..6 px tall. A
  // canvas above OVERVIEW_CANVAS_ABOVE spans, elements (with tooltips) below.
  const OVERVIEW_CANVAS_ABOVE = 1000;

  function overviewGeometry(count) {
    const n = Math.max(1, count);
    const height = count < 60 ? 60 : Math.min(count, 200);
    return { height, step: height / n, item: Math.min(6, Math.max(1, height / n)) };
  }

  function drawOverviewCanvas(canvas, nodes, bounds, geometry) {
    const width = Math.max(1, canvas.parentElement?.clientWidth || 0);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(geometry.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, geometry.height);
    ctx.globalAlpha = 0.8;
    const fills = new Map();
    nodes.forEach((node, index) => {
      const span = node.span;
      const x = ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * width;
      const w = Math.max(1.5, (Number(span.duration_ns || 0) / bounds.duration) * width);
      const service = String(span.service_name || "unknown");
      let fill = fills.get(service);
      if (!fill) { fill = palette.resolve(palette.service(service)); fills.set(service, fill); }
      ctx.fillStyle = fill;
      ctx.fillRect(x, index * geometry.step, w, geometry.item);
    });
  }

  function viewRangeOf(range = model.traceViewRange) {
    const r = Array.isArray(range) ? range : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(r[0] || 0)));
    const hi = Math.max(lo + 1e-6, Math.min(1, Number(r[1] == null ? 1 : r[1])));
    return [lo, hi];
  }

  function syncOverviewSelection() {
    const selection = $("[data-trace-overview-selection]", dom.traceOverview);
    if (!selection) return;
    const [lo, hi] = viewRangeOf();
    selection.style.left = `${(lo * 100).toFixed(3)}%`;
    selection.style.width = `${((hi - lo) * 100).toFixed(3)}%`;
  }

  // Zoom / pan of the waterfall (overview selection, timeline drag, keys).
  // One deferred waterfall render per frame (overview drags).
  const waterfallFrame = util.rafOnce(() => renderWaterfall());
  function setTraceViewRange(range, { deferred = false } = {}) {
    const [lo, hi] = viewRangeOf(range);
    model.traceViewRange = [lo, Math.min(1, hi)];
    syncOverviewSelection();
    if (!deferred) { renderWaterfall(); return; }
    waterfallFrame();
  }

  function renderTraceOverview(spans, bounds) {
    if (!dom.traceOverview) return;
    if (!spans.length) { dom.traceOverview.replaceChildren(); return; }
    const range = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(range[0] || 0)));
    const hi = Math.max(lo + 0.005, Math.min(1, Number(range[1] == null ? 1 : range[1])));
    const ticksHtml = durationTicks(bounds.duration, 5).map((tick) => `<span style="left:${tick.ratio * 100}%">${esc(tick.label)}</span>`).join("");
    const cache = activeTraceCache();
    const nodes = cache.order.filter((node) => serviceEnabled(node.span.service_name));
    const geometry = overviewGeometry(nodes.length);
    const canvasMode = nodes.length > OVERVIEW_CANVAS_ABOVE;
    const barsHtml = canvasMode
      ? '<canvas class="traceOverview__canvas" data-trace-overview-canvas aria-hidden="true"></canvas>'
      : nodes.map((node, index) => {
        const span = node.span;
        const left = Math.max(0, Math.min(100, ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * 100));
        const width = Math.max(.08, Math.min(100 - left, (Number(span.duration_ns || 0) / bounds.duration) * 100));
        const isError = isErrorSpan(span);
        return `<i class="traceOverview__span${isError ? " is-error" : ""}" data-span-id="${esc(spanKey(node))}" title="${esc(`${span.service_name || "unknown"}: ${span.span_name || "span"} · ${fmt.duration(span.duration_ns)}${isError ? " · Error" : ""}`)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:${(index * geometry.step).toFixed(2)}px;height:${geometry.item.toFixed(2)}px;--trace-service-color:${palette.service(span.service_name)}"></i>`;
      }).join("");
    dom.traceOverview.innerHTML = `<div class="traceOverview__ticks">${ticksHtml}</div><div class="traceOverview__graph" data-trace-overview-graph data-overview-rows="${nodes.length}" data-overview-mode="${canvasMode ? "canvas" : "dom"}" style="height:${geometry.height}px">${barsHtml}<div class="traceOverview__selection" data-trace-overview-selection style="left:${(lo * 100).toFixed(3)}%;width:${((hi-lo)*100).toFixed(3)}%"><button type="button" class="traceOverview__handle traceOverview__handle--start" data-overview-handle="start" aria-label="Resize trace range start"></button><button type="button" class="traceOverview__handle traceOverview__handle--end" data-overview-handle="end" aria-label="Resize trace range end"></button></div></div>`;

    const graph = $("[data-trace-overview-graph]", dom.traceOverview);
    const selection = $("[data-trace-overview-selection]", dom.traceOverview);
    if (!graph || !selection) return;
    if (canvasMode) drawOverviewCanvas($("[data-trace-overview-canvas]", graph), nodes, bounds, geometry);
    const updateSelection = (next) => {
      const a = Math.max(0, Math.min(.995, Number(next[0] || 0)));
      const b = Math.max(a + .005, Math.min(1, Number(next[1] == null ? 1 : next[1])));
      selection.style.left = `${(a*100).toFixed(3)}%`;
      selection.style.width = `${((b-a)*100).toFixed(3)}%`;
      return [a, b];
    };
    // A range change only moves the selection box; the bars are unchanged, so
    // update the box in place instead of rebuilding one element per span.
    graph.addEventListener("dblclick", (event) => {
      event.preventDefault();
      model.traceViewRange = updateSelection([0, 1]);
      renderWaterfall();
    });
    graph.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = graph.getBoundingClientRect();
      if (!rect.width) return;
      const pos = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const handle = event.target.closest?.("[data-overview-handle]")?.dataset?.overviewHandle || "range";
      const initial = [...model.traceViewRange];
      let next = initial;
      let moved = false;
      graph.setPointerCapture?.(event.pointerId);
      const apply = (clientX) => {
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        moved = true;
        if (handle === "start") next = updateSelection([Math.min(x, initial[1] - .005), initial[1]]);
        else if (handle === "end") next = updateSelection([initial[0], Math.max(x, initial[0] + .005)]);
        else next = updateSelection([Math.min(pos, x), Math.max(pos + .005, x)]);
      };
      const move = (moveEvent) => { if (graph.hasPointerCapture?.(event.pointerId)) apply(moveEvent.clientX); };
      const up = (upEvent) => {
        graph.removeEventListener("pointermove", move);
        graph.removeEventListener("pointerup", up);
        graph.removeEventListener("pointercancel", up);
        graph.releasePointerCapture?.(event.pointerId);
        if (!moved && handle === "range") {
          const half = Math.max(.025, (initial[1] - initial[0]) / 4);
          next = updateSelection([Math.max(0, pos-half), Math.min(1, pos+half)]);
        }
        model.traceViewRange = next;
        renderWaterfall();
      };
      graph.addEventListener("pointermove", move);
      graph.addEventListener("pointerup", up);
      graph.addEventListener("pointercancel", up);
      event.preventDefault();
    });
  }

  function renderTraceServiceFilters(spans) {
    if (!dom.traceServiceFilters) return;
    const cache = activeTraceCache();
    let stats = cache.spans === spans ? cache.serviceStats : null;
    if (!stats) {
      stats = new Map();
      for (const span of spans || []) {
        const service = String(span.service_name || "unknown");
        const row = stats.get(service) || { spans: 0, errors: 0 };
        row.spans += 1;
        if (String(span.status_code || "").toLowerCase() === "error") row.errors += 1;
        stats.set(service, row);
      }
      if (cache.spans === spans) cache.serviceStats = stats;
    }
    const services = [...stats.keys()].sort((a, b) => a.localeCompare(b));
    const allSelected = services.every((service) => !model.disabledServices.has(service));
    const toggleLabel = allSelected ? "Deselect all" : "Select all";
    // Service toggles: the shared chip badge with the service bar; the error
    // count is a solid error badge. "Select all" is the chips' clear link.
    dom.traceServiceFilters.innerHTML = ns.badge.clearHtml(toggleLabel, { "data-trace-toggle-all": true, title: `${toggleLabel} services` }, "traceServiceFilterReset") + services.map((service) => {
      const row = stats.get(service);
      const disabled = model.disabledServices.has(service);
      const errors = row.errors ? ns.badge.html(fmt.count(row.errors), { tone: "error", solid: true, className: "badge--count traceServiceFilter__errors", title: `${fmt.count(row.errors)} error${row.errors === 1 ? "" : "s"}` }) : "";
      return `<button type="button" class="badge badge--md badge--neutral traceServiceFilter${disabled ? " is-disabled" : ""}${row.errors ? " has-errors" : ""}" data-trace-service-filter="${esc(service)}" aria-pressed="${disabled ? "false" : "true"}" style="--trace-service-color:${palette.service(service)}" title="${esc(`${service} \u00b7 ${fmt.count(row.spans)} spans${row.errors ? ` \u00b7 ${fmt.count(row.errors)} errors` : ""}`)}"><i class="serviceSwatch serviceSwatch--bar" aria-hidden="true"></i><b>${esc(service)}</b><span>${fmt.count(row.spans)}</span>${errors}</button>`;
    }).join("");
    $("[data-trace-toggle-all]", dom.traceServiceFilters)?.addEventListener("click", () => {
      model.disabledServices = allSelected ? new Set(services) : new Set();
      renderTraceServiceFilters(spans);
      renderTraceOverview(spans, activeTraceCache().bounds);
      renderWaterfall();
    });
    for (const button of $$("[data-trace-service-filter]", dom.traceServiceFilters)) {
      button.addEventListener("click", () => {
        const service = String(button.getAttribute("data-trace-service-filter") || "");
        if (model.disabledServices.has(service)) model.disabledServices.delete(service);
        else model.disabledServices.add(service);
        renderTraceServiceFilters(spans);
        renderTraceOverview(spans, activeTraceCache().bounds);
        renderWaterfall();
      });
    }
  }

  // fmt.time to the second, then the milliseconds (set smaller), browser-local.
  function traceStartParts(ns) {
    const ms = Math.floor(Number(ns) / 1e6);
    if (!Number.isFinite(ms)) return null;
    return { main: fmt.time(ms), fraction: fmt.time(ms, { precision: "ms", date: "never" }).slice(8), title: fmt.timeTitle(ms) };
  }

  const WARNING_ICON = ns.icon("alert-triangle", { size: "sm" });

  // Jaeger's TracePageHeader items: Trace Start, Duration, Services, Depth,
  // Total Spans (plus Errors), and an Incomplete tag when spans reference a
  // parent missing from the trace.
  function renderTraceHeader() {
    const trace = model.activeTrace;
    const spans = trace?.spans || [];
    if (dom.traceCopyJsonButton) dom.traceCopyJsonButton.disabled = !spans.length;
    if (dom.traceCopyMenuButton) dom.traceCopyMenuButton.disabled = !spans.length;
    if (!spans.length) traceCopySplit?.close({ immediate: true });
    dom.traceDetail?.classList.toggle("is-unavailable", !spans.length && !!model.traceError);
    if (!spans.length) {
      const failed = model.traceError;
      if (dom.traceDetailTitle) {
        h.replace(dom.traceDetailTitle, h("strong", null, "Trace"), failed
          ? h("code", { class: "tracePageHeader__id", title: "Trace ID" }, failed.id)
          : h("span", null, "Select a trace to inspect its spans."));
      }
      if (dom.traceDetailStats) dom.traceDetailStats.replaceChildren();
      if (dom.traceServiceFilters) dom.traceServiceFilters.replaceChildren();
      if (dom.traceOverview) dom.traceOverview.replaceChildren();
      ns.traceInsights?.renderHighlights(null);
      if (address.active()) document.title = TRACES_PAGE_TITLE;
      return;
    }
    const cache = activeTraceCache();
    const bounds = cache.bounds;
    const root = spans.find((s) => !parentSpanId(s)) || spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0))[0];
    if (address.active()) document.title = `${String(trace.trace_id || "").slice(0, 7)}: ${root?.service_name || "trace"} ${root?.span_name || ""}`.trim();
    if (dom.traceDetailTitle) {
      const filterableHtml = (field, value, text) => (value
        ? `<span class="traceFilterable" data-filter-field="${field}" data-filter-value="${esc(value)}" tabindex="0" role="button" aria-haspopup="menu" title="Filter traces by this ${field}">${text}</span>`
        : text);
      dom.traceDetailTitle.innerHTML = `<strong><span>${filterableHtml("service", root?.service_name, esc(root?.service_name || "trace"))}:</span> ${filterableHtml("operation", root?.span_name, esc(root?.span_name || "trace"))}</strong><span class="tracePageHeader__traceId"><code title="${esc(trace.trace_id)}">${esc(trace.trace_id)}</code>${ns.ui.copyButtonHtml({ label: "Copy full Trace ID", className: "traceCopyButton traceCopyButton--header", attrs: { "data-copy-active-trace": trace.trace_id } })}</span>`;
      $("[data-copy-active-trace]", dom.traceDetailTitle)?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(trace.trace_id, event.currentTarget);
      });
    }
    if (dom.traceDetailStats) {
      const start = traceStartParts(bounds.start);
      const items = [
        ["Trace Start", { html: start ? `<time title="${esc(start.title)}">${esc(start.main)}<small class="tracePageOverviewItem__detail">${esc(start.fraction)}</small></time>` : fmt.EMPTY }, "is-start"],
        ["Duration", fmt.duration(bounds.duration)],
        ["Services", fmt.count(cache.serviceCount)],
        ["Depth", fmt.count(cache.maxLevel + 1)],
        ["Total Spans", fmt.count(spans.length)],
        ["Errors", fmt.count(cache.errorCount), cache.errorCount ? "is-error" : ""],
      ];
      const itemsHtml = items.map(([label, value, cls]) => ns.ui.statTileHtml({ label, valueHtml: typeof value === "object" ? value.html : esc(value), tone: cls === "is-error" ? "error" : "", className: `statTile--sm tracePageOverviewItem${cls ? ` ${cls}` : ""}`, attrs: { "data-trace-header-item": label } })).join('<i class="tracePageOverviewDivider" aria-hidden="true"></i>');
      const orphans = cache.orphanCount;
      const incomplete = orphans
        ? ns.badge.html("", { tone: "warn", size: "md", className: "tracePageHeader__incomplete", title: `${orphans} span${orphans === 1 ? "" : "s"} reference${orphans === 1 ? "s" : ""} a parent span missing from this trace: the trace is incomplete.`, attrs: { "data-trace-incomplete": true }, html: `${WARNING_ICON}Incomplete` })
        : "";
      dom.traceDetailStats.innerHTML = itemsHtml + (ns.traceLogs?.headerItemHtml?.() || "") + incomplete + (ns.traceInsights?.traceExceptionTagHtml(cache) || "");
    }
    ns.traceInsights?.renderHighlights(cache);
    renderTraceServiceFilters(spans);
    renderTraceOverview(spans, bounds);
  }

  function spanRowClass(active, error, clipLeft = false, clipRight = false) {
    return `traceSpanRow${active ? " is-active" : ""}${error ? " is-error" : ""}${clipLeft ? " clipping-left" : ""}${clipRight ? " clipping-right" : ""}`;
  }

  // Tree indentation per level (Jaeger's SpanTreeOffset); a level's guide
  // line runs through the middle of its toggle box.
  const TREE_INDENT_PX = 18;
  const TREE_LINE_X = 13;

  function spanRowGuides(depth) {
    return Array.from({ length: depth }, (_, index) => `<i style="left:${TREE_LINE_X + index * TREE_INDENT_PX}px"></i>`).join("");
  }

  function spanInspectorRowHtml(node, cache) {
    const span = node.span;
    const depth = Math.min(node.level ?? node.depth, 40);
    const serviceLineX = TREE_LINE_X - 1 + depth * TREE_INDENT_PX;
    return `<div class="traceSpanInspectorRow" style="--trace-service-color:${palette.service(span.service_name)};--trace-depth-x:${serviceLineX}px"><div class="traceSpanInspectorRow__spacer"><span class="traceSpanRow__guides" aria-hidden="true">${spanRowGuides(depth)}</span></div><div class="traceSpanInspectorRow__panel">${renderSpanInspectorCard(span, cache.spans, cache.bounds)}</div></div>`;
  }

  // Guides of every ancestor in its service colour, an elbow from the parent
  // into this span, then a toggle box with the child count (tinted when
  // collapsed) or a dot for a leaf. A guide stops after the ancestor's last
  // child. Hovering a guide or a box highlights that span's subtree guides.
  function treeOffsetHtml(node, cache) {
    const ancestors = [];
    for (let parent = cache.parentOf.get(node); parent; parent = cache.parentOf.get(parent)) ancestors.push(parent);
    ancestors.reverse();
    let html = "";
    for (let i = 0; i < ancestors.length; i += 1) {
      const ancestor = ancestors[i];
      const lastAncestor = i === ancestors.length - 1;
      const cls = lastAncestor ? (node.isLast ? " is-last" : "") : (ancestors[i + 1].isLast ? " is-terminated" : "");
      html += `<span class="traceTreeOffset__guide${cls}" data-ancestor-id="${esc(spanKey(ancestor))}" style="color:${palette.service(ancestor.span.service_name)}">${lastAncestor ? '<i class="traceTreeOffset__elbow"></i>' : ""}</span>`;
    }
    const id = spanKey(node);
    const count = node.children.length;
    if (count) {
      const collapsed = model.collapsed.has(id);
      const label = `${collapsed ? "Expand" : "Collapse"} ${count} child span${count === 1 ? "" : "s"}`;
      html += `<button type="button" class="traceTreeOffset__box${collapsed ? " is-collapsed" : ""}" data-toggle-span="${esc(id)}" data-ancestor-id="${esc(id)}" aria-expanded="${collapsed ? "false" : "true"}" aria-label="${label}" title="${label}">${count}</button>`;
    } else {
      html += '<span class="traceTreeOffset__leaf" aria-hidden="true"><i class="traceTreeOffset__dot"></i></span>';
    }
    return `<span class="traceTreeOffset${count ? " is-parent" : ""}">${html}</span>`;
  }

  // View window shared by the full render and in-place row updates.
  function waterfallContext(cache) {
    const { start: fullStart, end: fullEnd } = cache.extent;
    const fullTotal = Math.max(1, fullEnd - fullStart);
    const [viewLo, viewHi] = viewRangeOf();
    const start = fullStart + fullTotal * viewLo;
    const end = fullStart + fullTotal * viewHi;
    // Offset and width of the window straight from the fractions: differences
    // of epoch-ns doubles are only good to ~256 ns.
    return { cache, fullStart, start, end, offset: fullTotal * viewLo, total: Math.max(1, fullTotal * (viewHi - viewLo)), zoomed: viewLo > 0 || viewHi < 1 };
  }

  function waterfallRowShown(node, ctx) {
    const { start, end } = ctx;
    const spanStart = Number(node.span.start_ns || 0);
    const spanEnd = spanStart + Number(node.span.duration_ns || 0);
    return serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end;
  }

  const WATERFALL_ICONS = {
    expandOne: ns.icon("chevron-down"),
    collapseOne: ns.icon("chevron-right"),
    expandAll: ns.icon("chevrons-down"),
    collapseAll: ns.icon("chevrons-right"),
    criticalPath: ns.icon("route"),
    resetZoom: ns.icon("zoom-out"),
  };

  // Jaeger's Ticks: 5 ticks, labels at least 130 px apart (every 2nd, 4th...
  // label when narrower), the first and last always labelled. Each label is
  // the offset from the trace start with the wall-clock time below it.
  const TIMELINE_TICKS = 5;
  const MIN_TICK_LABEL_SPACING_PX = 130;

  function waterfallHeadHtml(ctx) {
    const { cache, fullStart, offset, total, zoomed } = ctx;
    const ticks = durationTicks(total, TIMELINE_TICKS, offset);
    const rootWidth = Number(dom.traceWaterfall?.clientWidth || 0);
    const timelineWidth = rootWidth * (1 - model.waterfallLabelPct / 100);
    let labelStep = 1;
    if (timelineWidth > 0) {
      const spacing = timelineWidth / (TIMELINE_TICKS - 1);
      while (spacing * labelStep < MIN_TICK_LABEL_SPACING_PX && labelStep < TIMELINE_TICKS) labelStep *= 2;
    }
    const tickStep = total / (TIMELINE_TICKS - 1);
    const tickLabels = ticks.map((tick, index) => {
      const last = index === ticks.length - 1;
      if (!(index === 0 || last || index % labelStep === 0)) return "";
      const clock = wallClockLabel(fullStart, tick.ns, tickStep);
      return `<span class="traceTick${last ? " is-end" : ""}" data-trace-tick style="left:${tick.ratio * 100}%" title="${esc(`${tick.label} after the trace start · ${clock}`)}"><i></i><b>${esc(tick.label)}</b><small>${esc(clock)}</small></span>`;
    }).join("");
    const shown = model.criticalPathShown;
    const hasParents = cache.order.some((node) => node.children.length);
    const control = (key, label, icon, extra = "") => `<button type="button" class="traceWaterfallControl" ${key} title="${esc(label)}" aria-label="${esc(label)}"${extra}>${icon}</button>`;
    const controls = [
      control("data-trace-expand-one", "Expand +1 (o)", WATERFALL_ICONS.expandOne, ` aria-keyshortcuts="o"${hasParents ? "" : " disabled"}`),
      control("data-trace-collapse-one", "Collapse +1 (p)", WATERFALL_ICONS.collapseOne, ` aria-keyshortcuts="p"${hasParents ? "" : " disabled"}`),
      control("data-trace-expand-all", "Expand all ([)", WATERFALL_ICONS.expandAll, ` aria-keyshortcuts="["${hasParents ? "" : " disabled"}`),
      control("data-trace-collapse-all", "Collapse all (])", WATERFALL_ICONS.collapseAll, ` aria-keyshortcuts="]"${hasParents ? "" : " disabled"}`),
      '<i class="traceWaterfallHead__sep" aria-hidden="true"></i>',
      control("data-trace-critical-path", shown ? "Hide the critical path" : "Show the critical path", WATERFALL_ICONS.criticalPath, ` aria-pressed="${shown ? "true" : "false"}"`),
      control("data-trace-reset-zoom", "Reset zoom", WATERFALL_ICONS.resetZoom, zoomed ? "" : " hidden"),
    ].join("");
    return `<div class="traceWaterfallHead"><div class="traceWaterfallHead__operation"><span class="traceWaterfallHead__title">Service &amp; Operation</span><span class="traceWaterfallHead__controls">${controls}</span></div><div class="traceWaterfallHead__timeline" data-trace-timeline-header aria-label="Timeline: drag to zoom, a / d or arrows to pan and zoom">${tickLabels}<div class="traceTimelineCursor" data-trace-timeline-cursor hidden></div><div class="traceTimelineDrag" data-trace-timeline-drag hidden></div></div><div class="traceWaterfallResizer" data-trace-waterfall-resizer role="separator" aria-orientation="vertical" aria-label="Resize Service & Operation column" tabindex="0"></div></div>`;
  }

  function renderWaterfall() {
    if (!dom.traceWaterfall) return;
    const cache = activeTraceCache();
    const spans = cache.spans;
    if (!spans.length) { dom.traceWaterfall.innerHTML = model.traceError ? unavailableHtml(model.traceError) : ns.uiState.emptyHtml({ body: "This trace has no spans." }); return; }
    const ctx = waterfallContext(cache);
    const rows = visibleNodes(cache).filter((node) => waterfallRowShown(node, ctx));
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    dom.traceWaterfall.classList.toggle("is-critical-path-hidden", !model.criticalPathShown);
    hoveredAncestor = null;
    if (rows.length > VIRTUAL_ROWS_ABOVE) { renderVirtualWaterfall(ctx, rows); return; }
    virtualWaterfall = null;
    const bodyHtml = rows.map((node) => waterfallRowHtml(node, ctx)).join("");
    dom.traceWaterfall.innerHTML = `${waterfallHeadHtml(ctx)}<div class="traceWaterfallBody">${bodyHtml}</div>`;
  }

  // --- Virtualised waterfall (Jaeger's ListView) -----------------------------
  // Above VIRTUAL_ROWS_ABOVE rows only the rows in and around the viewport are
  // in the DOM, between two spacers; an open span's inspector counts with its
  // measured height (an estimate until it has been drawn once).
  const VIRTUAL_ROWS_ABOVE = 1000;
  const VIRTUAL_OVERSCAN = 40;
  const SPAN_ROW_PX = 24;
  const INSPECTOR_ESTIMATE_PX = 260;
  const inspectorHeights = new Map();
  const logsRowHeights = new Map();
  let virtualWaterfall = null;
  const virtualFrame = util.rafOnce(() => updateVirtualWindow());
  let inspectorObserver = null;

  function virtualItemHeight(node) {
    const id = spanKey(node);
    const logsEstimate = ns.traceLogs?.inlineHeight?.(node) || 0;
    return SPAN_ROW_PX + (model.openSpanIds.has(id) ? (inspectorHeights.get(id) || INSPECTOR_ESTIMATE_PX) : 0)
      + (logsEstimate ? (logsRowHeights.get(id) || logsEstimate) : 0);
  }

  function virtualOffsets(nodes) {
    const offsets = new Float64Array(nodes.length + 1);
    for (let i = 0; i < nodes.length; i += 1) offsets[i + 1] = offsets[i] + virtualItemHeight(nodes[i]);
    return offsets;
  }

  // Index of the item at `y` px into the body.
  function virtualIndexAt(offsets, y) {
    let lo = 0;
    let hi = offsets.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  function renderVirtualWaterfall(ctx, nodes) {
    const root = dom.traceWaterfall;
    // Read before the body is replaced: an emptied body would clamp it.
    const scrollTop = root.scrollTop;
    const offsets = virtualOffsets(nodes);
    virtualWaterfall = { ctx, nodes, offsets, first: 0, last: 0 };
    root.innerHTML = `${waterfallHeadHtml(ctx)}<div class="traceWaterfallBody" data-virtual-rows="${nodes.length}" style="height:${offsets[nodes.length]}px"></div>`;
    root.scrollTop = scrollTop;
    updateVirtualWindow(true, scrollTop);
    const body = $(".traceWaterfallBody", root);
    if (body) body.style.height = "";
  }

  function updateVirtualWindow(force = false, knownScrollTop = null) {
    const state = virtualWaterfall;
    const root = dom.traceWaterfall;
    const body = $(".traceWaterfallBody", root);
    if (!state || !body) return;
    const { nodes, offsets, ctx } = state;
    const top = Math.max(0, (knownScrollTop ?? root.scrollTop) - body.offsetTop);
    const bottom = top + Math.max(root.clientHeight, 400);
    const visibleFirst = virtualIndexAt(offsets, top);
    const visibleLast = Math.min(nodes.length, virtualIndexAt(offsets, bottom) + 1);
    if (!force && visibleFirst >= state.first && visibleLast <= state.last) return;
    state.first = Math.max(0, visibleFirst - VIRTUAL_OVERSCAN);
    state.last = Math.min(nodes.length, visibleLast + VIRTUAL_OVERSCAN);
    const focusedId = document.activeElement?.closest?.("#traceWaterfall [data-span-id]")?.getAttribute("data-span-id");
    const rowsHtml = nodes.slice(state.first, state.last).map((node) => waterfallRowHtml(node, ctx)).join("");
    body.innerHTML = `<div class="traceWaterfallSpacer" data-virtual-before style="height:${offsets[state.first]}px"></div>${rowsHtml}<div class="traceWaterfallSpacer" data-virtual-after style="height:${offsets[nodes.length] - offsets[state.last]}px"></div>`;
    if (focusedId) $(`[data-span-id="${window.CSS?.escape ? CSS.escape(focusedId) : focusedId}"]`, body)?.focus({ preventScroll: true });
    hoveredAncestor = null;
    watchInspectorHeights(body);
  }

  // Keep the spacers true to the inspectors' drawn heights (they change when
  // a section inside is opened).
  function watchInspectorHeights(body) {
    if (typeof ResizeObserver === "undefined") return;
    if (!inspectorObserver) {
      inspectorObserver = new ResizeObserver((entries) => {
        const state = virtualWaterfall;
        if (!state) return;
        let changed = false;
        for (const entry of entries) {
          const logsFor = entry.target.getAttribute?.("data-span-logs-for");
          const id = logsFor || entry.target.previousElementSibling?.getAttribute?.("data-span-id");
          const heights = logsFor ? logsRowHeights : inspectorHeights;
          const height = entry.target.getBoundingClientRect().height;
          if (id && height && Math.abs((heights.get(id) || 0) - height) > 0.5) {
            heights.set(id, height);
            changed = true;
          }
        }
        if (!changed) return;
        state.offsets = virtualOffsets(state.nodes);
        const before = $("[data-virtual-before]", dom.traceWaterfall);
        const after = $("[data-virtual-after]", dom.traceWaterfall);
        if (before) before.style.height = `${state.offsets[state.first]}px`;
        if (after) after.style.height = `${state.offsets[state.nodes.length] - state.offsets[state.last]}px`;
      });
    }
    inspectorObserver.disconnect();
    for (const el of $$(".traceSpanInspectorRow, .traceSpanLogsRow", body)) inspectorObserver.observe(el);
  }

  function scheduleVirtualWindow() {
    if (virtualWaterfall) virtualFrame();
  }

  function criticalPathHtml(cache, node, collapsed, ctx) {
    const { start, end, total } = ctx;
    return criticalSectionsFor(cache, node, collapsed).map((section) => {
      const a = Math.max(start, section.start);
      const b = Math.min(end, section.end);
      if (!(b > a)) return "";
      const left = ((a - start) / total) * 100;
      const width = ((b - a) / total) * 100;
      return `<i class="traceSpanBar__critical" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%" title="A segment on the critical path of the trace"></i>`;
    }).join("");
  }

  function spanRowHtml(node, ctx) {
    const { cache, start, end, total } = ctx;
    const span = node.span;
    const id = String(span.span_id || "");
    const spanStart = Number(span.start_ns || 0);
    const spanEnd = spanStart + Number(span.duration_ns || 0);
    const clippedStart = Math.max(start, spanStart);
    const clippedEnd = Math.min(end, spanEnd);
    const inView = clippedEnd > clippedStart;
    const left = inView ? Math.max(0, Math.min(100, ((clippedStart - start) / total) * 100)) : 0;
    const width = inView ? Math.max(0.24, Math.min(100 - left, ((clippedEnd - clippedStart) / total) * 100)) : 0;
    const error = isErrorSpan(span);
    const collapsed = node.children.length > 0 && model.collapsed.has(id);
    // Jaeger's hasChildError: a collapsed span hiding an error span.
    const childError = !error && collapsed && cache.errorBelow.has(node);
    const active = model.openSpanIds.has(id);
    const color = palette.service(span.service_name);
    const labelLeft = left + (width / 2) >= 62;
    const spanRef = `${span.service_name || "unknown"}::${span.span_name || "span"}`;
    const durationText = fmt.duration(span.duration_ns);
    const barLabel = labelLeft
      ? `<span class="traceSpanBar__label"><i class="traceSpanBar__ref">${esc(spanRef)}</i><span class="traceSpanBar__sep">|</span><b>${esc(durationText)}</b></span>`
      : `<span class="traceSpanBar__label"><b>${esc(durationText)}</b><span class="traceSpanBar__sep">|</span><i class="traceSpanBar__ref">${esc(spanRef)}</i></span>`;
    const eventMarkers = spanEventMarkers(cache, span).map((event) => {
      const eventNs = event.ns;
      if (!Number.isFinite(eventNs) || eventNs < clippedStart || eventNs > clippedEnd) return "";
      const eventLeft = Math.max(0, Math.min(100, ((eventNs - start) / total) * 100));
      return `<i class="traceSpanEventMarker" style="left:${eventLeft.toFixed(4)}%" title="${esc(event.name)}"></i>`;
    }).join("");
    const bar = inView ? `<i class="traceSpanBar${error ? " traceSpanBar--error" : ""}${labelLeft ? " traceSpanBar--labelLeft" : ""}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;--trace-service-color:${color}">${barLabel}</i>` : "";
    const critical = inView ? criticalPathHtml(cache, node, collapsed, ctx) : "";
    const decorations = spanDecorations(cache, span);
    const errorIcon = (error
      ? ns.badge.html("!", { tone: "error", solid: true, className: "badge--count traceSpanRow__errorBadge", title: "Span status: Error", attrs: { "aria-label": "Error span" } })
      : childError ? ns.badge.html("!", { tone: "error", className: "badge--count traceSpanRow__errorBadge traceSpanRow__errorBadge--hollow", title: "An error span is inside this collapsed branch", attrs: { "aria-label": "Error span in this collapsed branch" } }) : "")
      + (ns.traceInsights?.exceptionBadgeHtml(span) || "");
    // Log count badge and log markers (app_trace_logs.js).
    const logs = ns.traceLogs;
    return `<div class="${spanRowClass(active, error, inView && spanStart < start, inView && spanEnd > end)}" data-span-id="${esc(id)}" role="button" tabindex="0" aria-expanded="${active ? "true" : "false"}">
        <div class="traceSpanRow__label" style="--trace-service-color:${color}"><div class="traceSpanRow__labelContent">${treeOffsetHtml(node, cache)}<span class="traceSpanRow__serviceDot"></span>${decorations.iconHtml}${errorIcon}<span class="traceSpanRow__service${collapsed ? " is-children-collapsed" : ""}">${esc(span.service_name || "unknown")}</span><span class="traceSpanRow__name">${esc(span.span_name || "span")}</span>${decorations.pillsHtml}${logs?.spanBadgeHtml?.(span) || ""}</div></div>
        <div class="traceSpanRow__timeline">${bar}${critical}${eventMarkers}${logs?.spanMarkersHtml?.(span, ctx) || ""}</div>
      </div>`;
  }

  function waterfallRowHtml(node, ctx) {
    const rowHtml = spanRowHtml(node, ctx);
    const inspector = model.openSpanIds.has(String(node.span.span_id || "")) ? spanInspectorRowHtml(node, ctx.cache) : "";
    // The span's logs listed under it (app_trace_logs.js), after its inspector.
    return rowHtml + inspector + (ns.traceLogs?.inlineRowHtml?.(node, ctx) || "");
  }

  // Folding or unfolding one branch only removes or inserts that branch's
  // descendant rows (contiguous after it in tree order) and redraws its own
  // row; the rest of the waterfall is unchanged, so patch the DOM instead of
  // re-rendering it.
  function toggleSpanCollapse(toggle) {
    const id = String(toggle.getAttribute("data-toggle-span") || "");
    const collapsing = !model.collapsed.has(id);
    if (collapsing) model.collapsed.add(id); else model.collapsed.delete(id);
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    const row = toggle.closest("[data-span-id]");
    const ctx = waterfallContext(cache);
    const refocus = toggle === document.activeElement;
    if (!node || cache.duplicateIds.size || !row?.isConnected || virtualWaterfall) {
      // A virtualised list redraws its window (and may leave that mode).
      renderWaterfall();
      if (refocus) $(`[data-toggle-span="${window.CSS?.escape ? CSS.escape(id) : id}"]`, dom.traceWaterfall)?.focus({ preventScroll: true });
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = spanRowHtml(node, ctx).trim();
    const fresh = template.content.firstElementChild;
    row.replaceWith(fresh);
    if (refocus) $("[data-toggle-span]", fresh)?.focus({ preventScroll: true });
    // A span row's attachments (inspector, logs) stay with it.
    const isAttachment = (el) => el?.classList.contains("traceSpanInspectorRow") || el?.classList.contains("traceSpanLogsRow");
    let own = fresh;
    while (isAttachment(own.nextElementSibling)) own = own.nextElementSibling;
    if (collapsing) {
      const isDescendant = (candidate) => {
        for (let parent = cache.parentOf.get(candidate); parent; parent = cache.parentOf.get(parent)) {
          if (parent === node) return true;
        }
        return false;
      };
      let el = own.nextElementSibling;
      while (el) {
        if (!isAttachment(el)) {
          const other = cache.nodeById.get(String(el.getAttribute("data-span-id") || ""));
          if (!other || !isDescendant(other)) break;
        }
        const next = el.nextElementSibling;
        el.remove();
        el = next;
      }
      return;
    }
    const html = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (waterfallRowShown(child, ctx)) html.push(waterfallRowHtml(child, ctx));
        if (!model.collapsed.has(String(child.span.span_id || ""))) visit(child);
      }
    };
    visit(node);
    if (html.length) own.insertAdjacentHTML("afterend", html.join(""));
  }

  // Jaeger's TimelineCollapser actions, over the spans in tree order.
  function parentNodeIds(cache) {
    return cache.order.filter((node) => node.children.length).map(spanKey);
  }

  function expandAllSpans() {
    model.collapsed.clear();
    renderWaterfall();
  }

  function collapseAllSpans() {
    model.collapsed = new Set(parentNodeIds(activeTraceCache()));
    renderWaterfall();
  }

  // Expand +1: open the shallowest collapsed span of each branch.
  function expandOneLevel() {
    if (!model.collapsed.size) return;
    const next = new Set(model.collapsed);
    let expandedLevel = -1;
    let expandNext = true;
    for (const node of activeTraceCache().order) {
      if (node.level <= expandedLevel) expandNext = true;
      const id = spanKey(node);
      if (expandNext && next.has(id)) {
        next.delete(id);
        expandNext = false;
        expandedLevel = node.level;
      }
    }
    model.collapsed = next;
    renderWaterfall();
  }

  // Collapse +1: collapse the deepest open parents of each branch.
  function collapseOneLevel() {
    const cache = activeTraceCache();
    const parents = parentNodeIds(cache);
    if (parents.every((id) => model.collapsed.has(id))) return;
    const next = new Set(model.collapsed);
    let nearest = null;
    for (const node of cache.order) {
      if (nearest && node.level <= nearest.level) {
        next.add(spanKey(nearest));
        if (node.children.length) nearest = node;
      } else if (node.children.length && !next.has(spanKey(node))) {
        nearest = node;
      }
    }
    if (nearest) next.add(spanKey(nearest));
    model.collapsed = next;
    renderWaterfall();
  }

  // Opening or closing one span's inspector only changes that row: patch it in
  // place instead of re-rendering (and re-parsing) every row of the trace.
  function toggleSpanInspector(row) {
    const id = String(row.getAttribute("data-span-id") || "");
    model.activeSpanId = id;
    const opening = !model.openSpanIds.has(id);
    if (opening) model.openSpanIds.add(id); else model.openSpanIds.delete(id);
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    if (!node || cache.duplicateIds.has(id) || !row.isConnected || virtualWaterfall) { renderWaterfall(); return; }
    row.classList.toggle("is-active", opening);
    row.setAttribute("aria-expanded", opening ? "true" : "false");
    const next = row.nextElementSibling;
    if (next?.classList.contains("traceSpanInspectorRow")) next.remove();
    if (opening) row.insertAdjacentHTML("afterend", spanInspectorRowHtml(node, cache));
    ns.traceViews?.onSpanToggled?.(id, opening);
  }

  function setWaterfallLabelWidth(pct) {
    model.waterfallLabelPct = Math.max(18, Math.min(60, pct));
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
  }

  // Jaeger's keyboard pan / zoom steps (fractions of the trace per key press).
  const VIEW_MIN_RANGE = 0.01;
  const VIEW_CHANGE_BASE = 0.005;
  const VIEW_CHANGE_LARGE = 0.05;

  function adjustedViewRange(startChange, endChange) {
    const [viewStart, viewEnd] = viewRangeOf();
    // A pan keeps the window width at the trace edges (Jaeger shrinks it).
    if (startChange === endChange) {
      const shift = Math.max(-viewStart, Math.min(1 - viewEnd, startChange));
      return [viewStart + shift, viewEnd + shift];
    }
    let start = Math.max(0, Math.min(0.99, viewStart + startChange));
    let end = Math.max(0.01, Math.min(1, viewEnd + endChange));
    if (end - start < VIEW_MIN_RANGE) {
      if ((startChange < 0 && endChange < 0) || (startChange > 0 && endChange > 0)) {
        end = start + VIEW_MIN_RANGE;
      } else {
        const center = viewStart + (viewEnd - viewStart) / 2;
        start = center - VIEW_MIN_RANGE / 2;
        end = center + VIEW_MIN_RANGE / 2;
      }
    }
    return [start, end];
  }

  // Jaeger's keyboard-mappings.ts: [ ] expand / collapse all, o / p one
  // level, a d or arrows pan, up / down zoom, shift for large steps.
  function onTraceKeydown(event) {
    if (!model.activeTrace || dom.traceDetail?.hidden || !address.active()) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"], [role="listbox"], [role="tab"], [data-trace-waterfall-resizer]')) return;
    const step = event.shiftKey ? VIEW_CHANGE_LARGE : VIEW_CHANGE_BASE;
    const key = String(event.key || "");
    const actions = {
      "[": expandAllSpans,
      "]": collapseAllSpans,
      o: expandOneLevel,
      p: collapseOneLevel,
    };
    const action = actions[key.length === 1 ? key.toLowerCase() : key];
    if (action) {
      event.preventDefault();
      action();
      return;
    }
    const changes = {
      a: [-step, -step],
      arrowleft: [-step, -step],
      d: [step, step],
      arrowright: [step, step],
      arrowup: [step, -step],
      arrowdown: [-step, step],
    };
    const change = changes[key.toLowerCase()];
    if (!change) return;
    event.preventDefault();
    setTraceViewRange(adjustedViewRange(change[0], change[1]), { deferred: true });
  }

  let hoveredAncestor = null;
  function setHoveredAncestor(id) {
    if (id === hoveredAncestor) return;
    const root = dom.traceWaterfall;
    for (const el of $$(".is-guide-hovered", root)) el.classList.remove("is-guide-hovered");
    hoveredAncestor = id;
    if (id == null) return;
    const selector = `[data-ancestor-id="${window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&")}"]`;
    for (const el of $$(selector, root)) el.classList.add("is-guide-hovered");
  }

  // Jaeger's TimelineViewingLayer: drag across the timeline header to zoom
  // into that part of the current view.
  function startTimelineDrag(header, event) {
    const rect = header.getBoundingClientRect();
    if (!rect.width) return;
    const at = (clientX) => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const from = at(event.clientX);
    let to = from;
    const overlay = $("[data-trace-timeline-drag]", header);
    header.setPointerCapture?.(event.pointerId);
    const draw = () => {
      if (!overlay) return;
      overlay.hidden = false;
      overlay.style.left = `${(Math.min(from, to) * 100).toFixed(3)}%`;
      overlay.style.width = `${(Math.abs(to - from) * 100).toFixed(3)}%`;
    };
    const finish = (commit, clientX) => {
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", up);
      header.removeEventListener("pointercancel", cancel);
      if (header.hasPointerCapture?.(event.pointerId)) header.releasePointerCapture?.(event.pointerId);
      if (overlay) overlay.hidden = true;
      if (!commit) return;
      to = at(clientX);
      if (Math.abs(to - from) * rect.width < 4) return;
      const [lo, hi] = viewRangeOf();
      const span = hi - lo;
      setTraceViewRange([lo + Math.min(from, to) * span, lo + Math.max(from, to) * span]);
    };
    const move = (moveEvent) => { to = at(moveEvent.clientX); draw(); };
    const up = (upEvent) => finish(true, upEvent.clientX);
    const cancel = () => finish(false, 0);
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", up);
    header.addEventListener("pointercancel", cancel);
  }

  // The waterfall body is rebuilt on every render, so its controls are handled
  // by delegation on the persistent container instead of re-binding listeners
  // to every row, toggle and link after each render.
  function initWaterfallEvents() {
    const root = dom.traceWaterfall;
    if (!root) return;
    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-trace-collapse-all]")) { collapseAllSpans(); return; }
      if (target.closest("[data-trace-expand-all]")) { expandAllSpans(); return; }
      if (target.closest("[data-trace-collapse-one]")) { collapseOneLevel(); return; }
      if (target.closest("[data-trace-expand-one]")) { expandOneLevel(); return; }
      if (target.closest("[data-trace-critical-path]")) {
        model.criticalPathShown = !model.criticalPathShown;
        renderWaterfall();
        return;
      }
      if (target.closest("[data-trace-reset-zoom]")) { setTraceViewRange([0, 1]); return; }
      const toggle = target.closest("[data-toggle-span]");
      if (toggle) {
        event.stopPropagation();
        toggleSpanCollapse(toggle);
        return;
      }
      const link = target.closest("[data-linked-trace]");
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        const traceId = String(link.getAttribute("data-linked-trace") || "");
        if (traceId) loadTrace(traceId, { push: true });
        return;
      }
      const row = target.closest("[data-span-id]");
      if (row && root.contains(row)) toggleSpanInspector(row);
    });
    root.addEventListener("keydown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-trace-waterfall-resizer]")) {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setWaterfallLabelWidth(model.waterfallLabelPct + (event.key === "ArrowRight" ? 2 : -2));
        return;
      }
      // Enter / Space on a toggle box is its own click.
      if (target.closest("[data-toggle-span], button, a")) return;
      const row = target.closest("[data-span-id]");
      if (row && root.contains(row) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        toggleSpanInspector(row);
      }
    });
    root.addEventListener("mouseover", (event) => {
      const guide = event.target instanceof Element ? event.target.closest("[data-ancestor-id]") : null;
      setHoveredAncestor(guide ? String(guide.getAttribute("data-ancestor-id") || "") : null);
    });
    root.addEventListener("mouseleave", () => setHoveredAncestor(null));
    root.addEventListener("scroll", scheduleVirtualWindow, { passive: true });
    root.addEventListener("pointermove", (event) => {
      const header = event.target instanceof Element ? event.target.closest("[data-trace-timeline-header]") : null;
      const cursor = $("[data-trace-timeline-cursor]", root);
      if (!cursor) return;
      if (!header) { cursor.hidden = true; return; }
      const rect = header.getBoundingClientRect();
      cursor.hidden = false;
      cursor.style.left = `${Math.max(0, Math.min(rect.width, event.clientX - rect.left)).toFixed(1)}px`;
    });
    root.addEventListener("pointerleave", () => {
      const cursor = $("[data-trace-timeline-cursor]", root);
      if (cursor) cursor.hidden = true;
    });
    const setWidthFromClient = (clientX) => {
      const rect = root.getBoundingClientRect();
      if (!rect.width) return;
      setWaterfallLabelWidth(((clientX - rect.left) / rect.width) * 100);
    };
    root.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const header = target?.closest("[data-trace-timeline-header]");
      if (header && (event.button == null || event.button === 0)) {
        event.preventDefault();
        startTimelineDrag(header, event);
        return;
      }
      const resizer = target?.closest("[data-trace-waterfall-resizer]");
      if (!resizer) return;
      event.preventDefault();
      resizer.setPointerCapture?.(event.pointerId);
      resizer.classList.add("is-dragging");
      setWidthFromClient(event.clientX);
    });
    root.addEventListener("pointermove", (event) => {
      const resizer = event.target instanceof Element ? event.target.closest("[data-trace-waterfall-resizer]") : null;
      if (!resizer?.hasPointerCapture?.(event.pointerId)) return;
      setWidthFromClient(event.clientX);
    });
    const stopResize = (event) => {
      const resizer = event.target instanceof Element ? event.target.closest("[data-trace-waterfall-resizer]") : null;
      if (!resizer) return;
      if (resizer.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture?.(event.pointerId);
      resizer.classList.remove("is-dragging");
    };
    root.addEventListener("pointerup", stopResize);
    root.addEventListener("pointercancel", stopResize);
  }

  function parseStructuredValue(raw) {
    if (raw == null) return null;
    if (typeof raw !== "string") return raw;
    const text = raw.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) {}
    return null;
  }

  // "Copy trace JSON" document: what /api/traces/trace returned for the open
  // trace, spans ordered by start time (then span id), 2-space indented:
  //   { trace_id, truncated, span_count, spans: [{ trace_id, span_id,
  //     parent_span_id, service_name, span_name, span_kind, timestamp,
  //     start_ns, duration_ns, status_code, status_message,
  //     span_attributes?, resource_attributes?,
  //     events?: [{ timestamp, name, attributes }],
  //     links?: [{ trace_id, span_id, attributes }] }] }
  // The endpoint ships attributes, events and links as JSON-encoded columns;
  // they are decoded here, events and links zipped into one object each. Keys
  // marked ? exist only when the endpoint returns them (per-feature columns).
  // start_ns keeps the endpoint's exact integer (see traceJsonExactStartNs).
  const TRACE_JSON_SPAN_KEYS = ["trace_id", "span_id", "parent_span_id", "service_name", "span_name", "span_kind",
    "timestamp", "start_ns", "duration_ns", "status_code", "status_message"];
  const TRACE_JSON_EXACT_NS = "\u0000exact-ns:";

  // start_ns is an epoch in nanoseconds, past 2^53: the parsed JSON number
  // lost its last digits. The span's `timestamp` string ends with the exact
  // nanoseconds of its second, which restore the integer the endpoint sent.
  function traceJsonExactStartNs(span) {
    const rounded = Number(span.start_ns);
    const fraction = /\.(\d{9})$/.exec(String(span.timestamp || ""));
    if (!Number.isFinite(rounded) || Number.isSafeInteger(rounded) || !fraction) return null;
    const fractionNs = Number(fraction[1]);
    const exact = BigInt(Math.round((rounded - fractionNs) / 1e9)) * 1000000000n + BigInt(fractionNs);
    return Math.abs(Number(exact) - rounded) < 1e6 ? exact.toString() : null;
  }

  function traceJsonColumns(columns) {
    const lists = Object.entries(columns).map(([key, raw]) => {
      const value = parseStructuredValue(raw);
      return [key, Array.isArray(value) ? value : []];
    });
    const count = Math.max(0, ...lists.map(([, list]) => list.length));
    return Array.from({ length: count }, (_, index) => Object.fromEntries(lists.map(([key, list]) => [key, list[index] ?? null])));
  }

  function traceJsonSpan(span) {
    const out = {};
    for (const key of TRACE_JSON_SPAN_KEYS) if (key in span) out[key] = span[key];
    const exactStart = "start_ns" in span ? traceJsonExactStartNs(span) : null;
    if (exactStart) out.start_ns = TRACE_JSON_EXACT_NS + exactStart;
    for (const key of ["span_attributes", "resource_attributes"]) {
      if (!(key in span)) continue;
      const value = parseStructuredValue(span[key]);
      out[key] = value == null ? span[key] : value;
    }
    if ("events_name" in span) {
      out.events = traceJsonColumns({ timestamp: span.events_timestamp, name: span.events_name, attributes: span.events_attributes });
    }
    if ("links_trace_id" in span) {
      out.links = traceJsonColumns({ trace_id: span.links_trace_id, span_id: span.links_span_id, attributes: span.links_attributes });
    }
    return out;
  }

  function traceJsonText(trace) {
    const text = (value) => String(value == null ? "" : value);
    const spans = (trace?.spans || []).slice().sort((a, b) => (Number(a.start_ns || 0) - Number(b.start_ns || 0))
      || text(a.timestamp).localeCompare(text(b.timestamp)) || text(a.span_id).localeCompare(text(b.span_id)));
    return JSON.stringify({
      trace_id: trace?.trace_id || "",
      truncated: trace?.truncated === true,
      span_count: spans.length,
      spans: spans.map(traceJsonSpan),
    }, null, 2).replace(/"start_ns": "\\u0000exact-ns:(\d+)"/g, '"start_ns": $1');
  }

  // Copy JSON / Download JSON: the shared split control (ui.copySplit), the
  // same as a query's results.
  function copyTraceJsonText() {
    const trace = model.activeTrace;
    return trace?.spans?.length ? traceJsonText(trace) : "";
  }

  function downloadTraceJson() {
    const trace = model.activeTrace;
    if (!trace?.spans?.length) return;
    ns.ui.downloadText(`trace-${String(trace.trace_id || "trace").replace(/[^0-9A-Za-z_-]/g, "")}.json`, traceJsonText(trace));
  }

  let traceCopySplit = null;

  // Span detail, after Jaeger's SpanDetail (AttributesTable, AccordionAttributes,
  // AccordionEvents, AccordionLinks): HTML strings, with the inspector's
  // buttons handled by delegation (initSpanDetailEvents).
  const JSON_LOOKING = /^\s*[[{]/;
  const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  const OTEL_KEY_TITLE = "otel.* attribute: set by the OpenTelemetry SDK or exporter, not by the instrumented code";
  const EVENTS_INITIAL_COUNT = 3;

  function attributeEntries(raw) {
    const value = raw && typeof raw === "object" ? raw : parseStructuredValue(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    return Object.entries(value).sort(([a], [b]) => String(a).localeCompare(String(b)));
  }

  // Attribute tables: the shared key / value list (ui.kvListHtml). A string
  // holding a JSON object or array is a tree (Jaeger's tryParseJson); HTTP
  // header arrays a plain list; otel.* keys in italics. filterScope ("span" /
  // "resource"): include / exclude actions, and a click on the value opens
  // the filter menu (app_trace_search.js) for that attribute map.
  function attributeRow(key, value, filterScope = "") {
    const name = String(key);
    const tree = ns.kv.jsonValue(value);
    const headerList = Array.isArray(tree) && /^http\.(?:request|response)\.header\./.test(name);
    const otel = name.startsWith("otel.");
    return {
      key: name,
      value,
      list: headerList,
      keyClass: otel ? "is-otel" : "",
      keyTitle: otel ? OTEL_KEY_TITLE : "",
      actions: filterScope ? ["include", "exclude", "copy", "json"] : ["copy", "json"],
      attrs: filterScope ? { "data-filter-scope": filterScope } : {},
    };
  }

  function renderAttributeTable(raw, emptyText = "No attributes", filterScope = "") {
    const entries = attributeEntries(raw);
    if (!entries.length) return emptyText ? `<span class="traceJaegerEmpty">${esc(emptyText)}</span>` : "";
    return ns.ui.kvListHtml(entries.map(([key, value]) => attributeRow(key, value, filterScope)), { className: "traceKv" });
  }

  // The include / exclude / copy actions of the attribute lists: the search
  // filters, and "JSON" copies { key, value }.
  function attributeAction(action, { key, value, row, button }) {
    if (action === "json") {
      void copyText(JSON.stringify({ key, value }, null, 2), button);
      return true;
    }
    if (action === "include" || action === "exclude") {
      const scope = row.getAttribute("data-filter-scope") || "any";
      const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
      ns.traceSearch?.applyFilter?.({ kind: "tag", scope, key }, text, action);
      return true;
    }
    if (action === "copy") {
      void copyText(typeof value === "string" ? value : attributeValueText(value), button);
      return true;
    }
    return false;
  }

  function attributeValueText(value) {
    if (value == null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  // Jaeger's AttributesSummary: the k=v preview beside a collapsed section
  // (hidden by CSS while the section is open).
  function renderAttributePreview(raw, emptyText = "none") {
    const entries = attributeEntries(raw);
    if (!entries.length) return `<span class="traceJaegerSummaryPreview is-empty">${esc(emptyText)}</span>`;
    return `<span class="traceJaegerSummaryPreview">${entries.map(([key, value]) => `<span><b>${esc(key)}</b>=${esc(attributeValueText(value))}</span>`).join(" ")}</span>`;
  }

  // The Tags / Process preview while the section is closed: the first
  // ATTRIBUTE_PREVIEW attributes as two-line cells (key, then value) across
  // the inspector's width, and "Show all N" (the summary opens the table).
  const ATTRIBUTE_PREVIEW = 8;
  function renderAttributeGrid(raw) {
    const entries = attributeEntries(raw);
    if (!entries.length) return '<span class="traceJaegerSummaryPreview is-empty">none</span>';
    const cells = entries.slice(0, ATTRIBUTE_PREVIEW).map(([key, value]) => {
      const text = attributeValueText(value);
      return `<span class="traceAttrCell" title="${esc(`${key} = ${text}`)}"><b class="traceAttrCell__key">${esc(key)}</b><span class="traceAttrCell__value">${esc(text)}</span></span>`;
    }).join("");
    const more = entries.length > ATTRIBUTE_PREVIEW ? `<span class="traceAttrGrid__more">Show all ${entries.length}</span>` : "";
    return `<span class="traceJaegerSummaryPreview traceAttrGrid">${cells}${more}</span>`;
  }

  // Jaeger's AccordionAttributes: "Label (N)" and the preview grid while
  // collapsed, the attribute table once open.
  function renderJaegerAttributes(label, raw, { emptyText = "No attributes", open = false, filterScope = "" } = {}) {
    const count = attributeEntries(raw).length;
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceJaegerGroup--attrs" data-span-section="${esc(label.toLowerCase())}"${open ? " open" : ""}><summary><b>${esc(label)}</b>${count ? `<span class="traceJaegerGroup__count">${esc(fmt.count(count))}</span>` : ""}${renderAttributeGrid(raw)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(raw, emptyText, filterScope)}</div></details>`;
  }

  function jsonList(raw) {
    const value = parseStructuredValue(raw);
    return Array.isArray(value) ? value : [];
  }

  // A span's events, ordered by time (then by position in the span).
  function spanEventList(span) {
    const times = jsonList(span.events_timestamp);
    const names = jsonList(span.events_name);
    const attrs = jsonList(span.events_attributes);
    const count = Math.max(times.length, names.length, attrs.length);
    const events = Array.from({ length: count }, (_, index) => ({
      index,
      name: names[index] == null ? `Event ${index + 1}` : String(names[index]),
      time: times[index] == null ? "" : String(times[index]),
      ns: timestampToNs(times[index]),
      attributes: attrs[index] == null ? null : attrs[index],
    }));
    const key = (event) => (Number.isFinite(event.ns) ? event.ns : Infinity);
    return events.sort((a, b) => key(a) - key(b) || a.index - b.index);
  }

  // A span or event instant: the stored UTC text ("2026-09-12 14:29:57.462123456",
  // exact) or epoch ns (a double, exact to ~256 ns only). withRaw: the
  // tooltip (fmt.timeTitle, to the nanosecond when the text has them), else
  // the shown text (fmt.time to the millisecond).
  function absoluteTimeText(ns, raw = "", { withRaw = true } = {}) {
    const text = String(raw || "");
    const parts = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    const ms = parts ? Date.parse(`${parts[1]}T${parts[2]}.${(parts[3] || "").slice(0, 3).padEnd(3, "0")}Z`) : Math.floor(Math.round(ns / 1e3) / 1e3);
    if (!Number.isFinite(ms)) return text;
    if (!withRaw) return fmt.time(ms, { precision: "ms" });
    const digits = parts ? (parts[3] || "").slice(0, 9).padEnd(9, "0") : "";
    return digits ? fmt.timeTitle(ms, { precision: "ns", ns: `${Math.floor(ms / 1000)}${digits}` }) : fmt.timeTitle(ms);
  }

  function sectionOpen(spanId, key) {
    return !!model.spanSections.get(String(spanId || ""))?.has(key);
  }

  function setSectionOpen(spanId, key, open) {
    const id = String(spanId || "");
    let keys = model.spanSections.get(id);
    if (!keys) {
      if (!open) return;
      keys = new Set();
      model.spanSections.set(id, keys);
    }
    if (open) keys.add(key); else keys.delete(key);
  }

  function eventItemHtml(event, traceStartNs, { hidden = false, open = false } = {}) {
    const offset = Number.isFinite(event.ns) ? fmt.duration(Math.max(0, event.ns - traceStartNs)) : fmt.EMPTY;
    const body = event.attributes && typeof event.attributes === "object" && !Array.isArray(event.attributes)
      ? renderAttributeTable(event.attributes, "No attributes")
      : (event.attributes == null ? '<span class="traceJaegerEmpty">No attributes</span>' : `<pre class="traceJaegerRaw">${esc(typeof event.attributes === "string" ? event.attributes : JSON.stringify(event.attributes, null, 2))}</pre>`);
    const preview = event.attributes && typeof event.attributes === "object" ? renderAttributePreview(event.attributes, "") : "";
    return `<details class="traceSpanEvent" data-event-index="${event.index}"${hidden ? " hidden" : ""}${open ? " open" : ""}><summary><b>${esc(event.name)}</b><time title="${esc(absoluteTimeText(event.ns, event.time))}">(${esc(offset)})</time>${preview}</summary><div class="traceSpanEvent__body">${body}</div></details>`;
  }

  function renderJaegerEvents(span, bounds) {
    const events = spanEventList(span);
    if (!events.length) return "";
    const id = span.span_id;
    const all = sectionOpen(id, "events-more");
    const items = events.map((event, index) => eventItemHtml(event, bounds.start, { hidden: !all && index >= EVENTS_INITIAL_COUNT, open: sectionOpen(id, `event:${event.index}`) })).join("");
    const more = events.length > EVENTS_INITIAL_COUNT
      ? `<button type="button" class="traceSpanEvents__more" data-events-more aria-expanded="${all ? "true" : "false"}">${all ? "show less" : "show more..."}</button>`
      : "";
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanEvents" data-span-section="events"${sectionOpen(id, "events") ? " open" : ""}><summary><b>Events</b><span class="traceJaegerGroup__count">(${events.length})</span></summary><div class="traceJaegerGroup__body"><div class="traceSpanEvents__list">${items}</div>${more}<small class="traceSpanEvents__note">Event timestamps are relative to the start time of the full trace.</small></div></details>`;
  }

  function spanLinkList(span) {
    const traceIds = jsonList(span.links_trace_id);
    const spanIds = jsonList(span.links_span_id);
    const attrs = jsonList(span.links_attributes);
    const count = Math.max(traceIds.length, spanIds.length, attrs.length);
    return Array.from({ length: count }, (_, index) => ({
      traceId: String(traceIds[index] || ""),
      spanId: String(spanIds[index] || ""),
      attributes: attrs[index] == null ? null : attrs[index],
    }));
  }

  // Spans of the loaded trace that link to a span ("linked from"): only what
  // the trace already holds, computed once per trace.
  function linkedFromList(cache, span) {
    if (!cache.linkedFrom) {
      cache.linkedFrom = new Map();
      const traceId = String(cache.trace?.trace_id || "");
      for (const other of cache.spans) {
        if (!other.links_span_id || other.links_span_id === "[]") continue;
        for (const link of spanLinkList(other)) {
          if (link.traceId && link.traceId !== traceId) continue;
          if (!cache.linkedFrom.has(link.spanId)) cache.linkedFrom.set(link.spanId, []);
          cache.linkedFrom.get(link.spanId).push({ traceId, spanId: String(other.span_id || ""), attributes: link.attributes });
        }
      }
    }
    return cache.linkedFrom.get(String(span.span_id || "")) || [];
  }

  // Trace URLs carry the search context (range, filters, view) after the
  // span, so "back to search" and shared links return to the same search.
  function spanTraceUrl(traceId, spanId = "") {
    const params = new URLSearchParams(ns.traceSearch?.contextQuery?.() || "");
    const query = `${spanId ? `span=${encodeURIComponent(spanId)}` : ""}${spanId && params.toString() ? "&" : ""}${params.toString()}`;
    return `${route(`${SEARCH_ROUTE}/${encodeURIComponent(traceId)}`)}${query ? `?${query}` : ""}`;
  }

  function referenceItemHtml(kind, ref, cache) {
    const traceId = String(cache.trace?.trace_id || "");
    const sameTrace = !ref.traceId || ref.traceId === traceId;
    const target = sameTrace ? cache.nodeById.get(ref.spanId)?.span : null;
    const label = target
      ? `<span class="traceSpanRefs__svc" style="--trace-service-color:${palette.service(target.service_name)}">${esc(target.service_name || "unknown")}</span><small class="traceSpanRefs__op">${esc(target.span_name || "span")}</small>`
      : `<span class="traceSpanRefs__svc is-external">${sameTrace ? "&lt; span not in this trace &gt;" : "&lt; span in another trace &gt;"}</span>`;
    const ids = `<small class="traceSpanRefs__ids">${sameTrace ? "" : `<span>TraceID: <code>${esc(ref.traceId)}</code></span>`}<span>SpanID: <code>${esc(ref.spanId)}</code></span></small>`;
    let action = "";
    if (target) action = `<button type="button" class="traceSpanRefs__open" data-focus-span="${esc(ref.spanId)}">Go to span</button>`;
    else if (!sameTrace) action = `<a class="traceSpanRefs__open traceJaegerLink__trace" href="${esc(spanTraceUrl(ref.traceId, ref.spanId))}" data-linked-trace="${esc(ref.traceId)}" data-linked-span="${esc(ref.spanId)}" title="Open linked trace">Open linked trace</a>`;
    const attrs = attributeEntries(ref.attributes).length ? `<div class="traceSpanRefs__attrs">${renderAttributeTable(ref.attributes, "")}</div>` : "";
    const kindClass = kind.replace(/\s+/g, "-");
    return `<li class="traceSpanRefs__item" data-ref-kind="${esc(kindClass)}">${refKindHtml(kind)}<span class="traceSpanRefs__main">${label}${ids}</span>${action}${attrs}</li>`;
  }

  // The kind of a reference, a pill badge: child of (neutral), follows from /
  // linked from (accent).
  function refKindHtml(kind) {
    const kindClass = String(kind).replace(/\s+/g, "-");
    return ns.badge.html(kind, { tone: kindClass === "child-of" ? "neutral" : "accent", shape: "pill", className: `traceSpanRefs__kind traceSpanRefs__kind--${kindClass}` });
  }

  // Jaeger's references: the parent (child of) and the span's links (follows
  // from), plus the spans of this trace that link here (linked from), and a
  // lazily loaded group of the spans of other traces that link here.
  function renderJaegerLinks(span, cache) {
    const links = spanLinkList(span);
    const from = linkedFromList(cache, span);
    const remote = ns.traceInsights?.linkedFromRemoteHtml(span, cache) || "";
    if (!links.length && !from.length && !remote) return "";
    const items = [];
    const parentId = String(span.parent_span_id || "");
    if (parentId) items.push(referenceItemHtml("child of", { traceId: "", spanId: parentId }, cache));
    for (const link of links) items.push(referenceItemHtml("follows from", link, cache));
    for (const link of from) items.push(referenceItemHtml("linked from", link, cache));
    const count = items.length ? `<span class="traceJaegerGroup__count">(${items.length})</span>` : "";
    const list = items.length ? `<ul class="traceSpanRefs__list">${items.join("")}</ul>` : "";
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanRefs" data-span-section="references"${sectionOpen(span.span_id, "references") ? " open" : ""}><summary><b>References</b>${count}</summary><div class="traceJaegerGroup__body">${list}${remote}</div></details>`;
  }

  function spanKindLabel(kind) {
    const text = String(kind || "").replace(/^SPAN_KIND_/i, "").trim();
    if (!text) return fmt.EMPTY;
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
  }

  function idCopyHtml(label, value, field) {
    if (!value) return `<span>${esc(label)}: <code>root</code></span>`;
    return `<span>${esc(label)}: <code>${esc(value)}</code>${ns.ui.copyButtonHtml({ label: `Copy ${field}`, className: "traceCopyButton traceInspectorIdentity__copy", attrs: { "data-copy-span-field": value } })}</span>`;
  }

  function renderSpanInspectorCard(span, spans, knownBounds = null) {
    const cache = activeTraceCache();
    const status = span.status_code || "Unset";
    const bounds = knownBounds || traceBounds(spans || []);
    const startNs = Number(span.start_ns || 0);
    const startOffset = Math.max(0, startNs - bounds.start);
    const statusClass = esc(String(status).toLowerCase());
    const statusBadge = String(status).toLowerCase() === "unset" ? "" : ns.badge.statusHtml(status, { className: `traceStatus traceStatus--${statusClass}`, title: "Span status (click to filter)", attrs: { "data-filter-field": "status", "data-filter-value": status, tabindex: "0", role: "button", "aria-haspopup": "menu" } });
    const statusMessage = String(span.status_message || "").trim();
    const color = palette.service(span.service_name);
    const absolute = absoluteTimeText(startNs, span.timestamp);
    const id = String(span.span_id || "");
    return `<section class="traceInspector traceInspector--jaeger traceInspector--inline" style="--trace-service-color:${color}" data-inspector-span="${esc(id)}">
      <div class="traceInspectorHead traceInspectorHead--jaeger">
        <strong title="${esc(span.span_name || "span")}"><span class="traceFilterable" data-filter-field="operation" data-filter-value="${esc(span.span_name || "")}" tabindex="0" role="button" aria-haspopup="menu">${esc(span.span_name || "span")}</span></strong>
        <div class="traceInspectorHead__meta"><span>Service: <b class="traceInspectorHead__service traceFilterable" data-filter-field="service" data-filter-value="${esc(span.service_name || "")}" tabindex="0" role="button" aria-haspopup="menu">${esc(span.service_name || "unknown")}</b></span><i></i><span>Duration: <b>${esc(fmt.duration(span.duration_ns))}</b></span><i></i><span title="${esc(absolute)}">Start Time: <b>${esc(fmt.duration(startOffset))}</b><small class="traceInspectorHead__abs">${esc(absoluteTimeText(startNs, span.timestamp, { withRaw: false }))}</small></span><i></i><span>Kind: <b>${esc(spanKindLabel(span.span_kind))}</b></span>${statusBadge}</div>
      </div>
      ${ns.traceInsights?.exceptionSectionHtml(span, bounds) || ""}
      ${statusMessage ? `<div class="traceInspectorStatusMessage"><b>Status message</b><span>${esc(statusMessage)}</span></div>` : ""}
      <div class="traceInspectorIdentity">${idCopyHtml("SpanID", id, "Span ID")}${idCopyHtml("Parent", String(span.parent_span_id || ""), "parent Span ID")}<button type="button" class="traceInspectorIdentity__deepLink" data-copy-deep-link="${esc(id)}" title="Copy a link that opens this trace on this span">Copy deep link</button>${ns.traceInsights ? `<button type="button" class="traceInspectorIdentity__deepLink traceInspectorIdentity__context" data-span-context="${esc(id)}" title="Spans of any trace around this span's start time">Context</button>` : ""}</div>
      ${renderJaegerAttributes("Tags", span.span_attributes, { open: sectionOpen(id, "tags"), filterScope: "span" })}
      ${attributeEntries(span.resource_attributes).length ? renderJaegerAttributes("Process", span.resource_attributes, { open: sectionOpen(id, "process"), filterScope: "resource" }) : ""}
      ${renderJaegerEvents(span, bounds)}
      ${renderJaegerLinks(span, cache)}
      ${ns.traceLogs?.inspectorSectionHtml?.(span) || ""}
    </section>`;
  }

  function spanDeepLink(spanId) {
    const traceId = String(model.activeTrace?.trace_id || "");
    return new URL(spanTraceUrl(traceId, spanId), window.location.href).toString();
  }

  // The inspector sits in the waterfall, whose own click handler ignores
  // clicks outside span rows; these buttons are handled here.
  function spanDetailClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const linked = target.closest("[data-linked-span]");
    // The waterfall handler opens the linked trace; say which span to focus.
    if (linked) { model.pendingSpanId = String(linked.getAttribute("data-linked-span") || ""); return; }
    if (ns.traceInsights?.handleInspectorClick(event, target)) return;
    const kvButton = target.closest("[data-kv-action]");
    const kvRow = kvButton?.closest(".kvList__row");
    if (kvButton && kvRow) {
      event.preventDefault();
      event.stopPropagation();
      let value = null;
      try { value = JSON.parse(kvRow.getAttribute("data-kv-json") || "null"); } catch (_) { value = kvRow.getAttribute("data-kv-text"); }
      attributeAction(kvButton.getAttribute("data-kv-action"), { key: kvRow.getAttribute("data-kv-key") || "", value, row: kvRow, button: kvButton });
      return;
    }
    const idCopy = target.closest("[data-copy-span-field]");
    if (idCopy) { event.preventDefault(); event.stopPropagation(); copyText(idCopy.getAttribute("data-copy-span-field") || "", idCopy); return; }
    const deepLink = target.closest("[data-copy-deep-link]");
    if (deepLink) {
      event.preventDefault();
      event.stopPropagation();
      copyText(spanDeepLink(deepLink.getAttribute("data-copy-deep-link") || ""), deepLink);
      return;
    }
    const more = target.closest("[data-events-more]");
    if (more) {
      event.preventDefault();
      event.stopPropagation();
      const expanded = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", expanded ? "true" : "false");
      more.textContent = expanded ? "show less" : "show more...";
      $$(".traceSpanEvents__list > .traceSpanEvent", more.parentElement).forEach((item, index) => {
        if (index >= EVENTS_INITIAL_COUNT) item.hidden = !expanded;
      });
      setSectionOpen(more.closest("[data-inspector-span]")?.getAttribute("data-inspector-span"), "events-more", expanded);
      return;
    }
    const focus = target.closest("[data-focus-span]");
    if (focus) {
      event.preventDefault();
      event.stopPropagation();
      focusSpanInTimeline(String(focus.getAttribute("data-focus-span") || ""), { push: true });
    }
  }

  // "toggle" does not bubble: listen in the capture phase.
  function spanSectionToggle(event) {
    const details = event.target instanceof HTMLDetailsElement ? event.target : null;
    const spanId = details?.closest("[data-inspector-span]")?.getAttribute("data-inspector-span");
    if (!details || !spanId) return;
    const key = details.dataset.spanSection || (details.classList.contains("traceSpanEvent") ? `event:${details.dataset.eventIndex}` : "");
    if (key) setSectionOpen(spanId, key, details.open);
    if (key) ns.traceInsights?.onSectionToggle(spanId, key, details.open);
  }

  function initSpanDetailEvents() {
    dom.traceWaterfall?.addEventListener("click", spanDetailClick, true);
    dom.traceWaterfall?.addEventListener("toggle", spanSectionToggle, true);
  }

  // Deep link target (?span=): expands the span's ancestors, shows its service
  // and time window, opens its inspector, scrolls to it and highlights it.
  function focusSpanInTimeline(spanId, { push = false, replace = true, scroll = true } = {}) {
    const id = String(spanId || "");
    const cache = activeTraceCache();
    const node = cache.nodeById.get(id);
    if (!node) return false;
    for (let parent = cache.parentOf.get(node); parent; parent = cache.parentOf.get(parent)) model.collapsed.delete(String(parent.span.span_id || ""));
    const service = String(node.span.service_name || "unknown");
    const range = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const total = Math.max(1, cache.extent.end - cache.extent.start);
    const spanStart = (Number(node.span.start_ns || 0) - cache.extent.start) / total;
    const spanEnd = spanStart + Number(node.span.duration_ns || 0) / total;
    const outside = spanEnd < Number(range[0] || 0) || spanStart > Number(range[1] == null ? 1 : range[1]);
    if (model.disabledServices.has(service) || outside) {
      model.disabledServices.delete(service);
      if (outside) model.traceViewRange = [0, 1];
      renderTraceHeader();
    }
    model.openSpanIds.add(id);
    model.activeSpanId = id;
    model.focusedSpanId = id;
    ns.traceViews?.showTimeline?.();
    renderWaterfall();
    ns.traceViews?.markFocusedSpan?.();
    if (push || replace) {
      const href = spanTraceUrl(String(model.activeTrace?.trace_id || ""), id);
      if (push) address.push(null, { href, state: detailEntryState({ traceId: model.activeTrace?.trace_id, spanId: id }) });
      else address.replace(null, { href });
    }
    if (scroll) {
      const row = [...($$(".traceSpanRow[data-span-id]", dom.traceWaterfall) || [])].find((el) => el.getAttribute("data-span-id") === id);
      row?.scrollIntoView?.({ block: "center" });
      row?.focus?.({ preventScroll: true });
    }
    return true;
  }

  function renderInspector() {
    if (!dom.traceInspector) return;
    dom.traceInspector.hidden = true;
    dom.traceInspector.replaceChildren();
  }

  function renderTrace() {
    renderTraceHeader();
    renderWaterfall();
    renderInspector();
    ns.traceViews?.render?.();
  }

  async function loadMeta() {
    try {
      const meta = await api.getTracesMeta(currentHost());
      model.meta = meta;
      ns.traceTabs?.onMeta?.(meta);
      if (meta && meta.schema_ok === false) showError(`Trace table ${meta.database}.${meta.table} is missing one or more required OpenTelemetry columns.`);
      else showError("");
      renderSource();
      syncFilterFeatures();
      return meta;
    } catch (error) {
      showError(error, () => { void reloadForHost(); });
      renderSource();
      throw error;
    }
  }

  function currentTag() {
    const key = String(dom.tracesTagKey?.value || "").trim();
    const value = String(dom.tracesTagValue?.value || "");
    return { scope: key ? "any" : "", key, value };
  }

  // The Tag / Value inputs feed the filter chips (app_trace_search.js); the
  // chips become tag / tag_not / tag_exists / tag_missing and
  // service_not / operation_not / status_not parameters.
  function searchFilters() {
    const range = selectedRange();
    const services = resolvedServiceValues();
    const operations = resolvedOperationValues();
    // A tag-filtered prefill lists only the pairs seen with those attributes,
    // and an estimated or truncated one is a subset: only a complete list
    // can rule a pair out.
    if (services.length && operations.length && model.prefillComplete && !serviceOperationPairExists(services[0], operations[0])) {
      throw new Error("Selected service / operation combination does not exist in this time range.");
    }
    return {
      ...range,
      service: services,
      operation: operations,
      status: String(dom.tracesStatus?.value || ""),
      limit: String(dom.tracesLimit?.value || Math.min(50, Number(model.meta?.search_limit || 50))),
      ...(ns.traceSearch?.chipParams?.() || {}),
    };
  }

  function invalidateDiscovery({ pairs = true } = {}) {
    if (pairs) {
      model.prefillPairs = [];
      replaceSelectOptions(dom.tracesService, [], "All");
      replaceSelectOptions(dom.tracesOperation, [], "All");
    }
  }

  async function prefill({ force = false } = {}) {
    if (!model.meta) await loadMeta().catch(() => null);
    if (!force && model.prefillPromise) return model.prefillPromise;
    const req = util.latest("traces.prefill");
    const run = (async () => {
      showError("");
      try {
        const range = selectedRange();
        // Tag chips narrow the service / operation lists to the pairs seen
        // with those attributes.
        const tags = ns.traceSearch?.prefillTagParams?.() || {};
        ns.traceSearch?.notePrefillTags?.(tags);
        const payload = await api.prefillTraces(currentHost(), { ...range, ...tags }, { signal: req.signal });
        if (!req.isCurrent()) return;
        model.prefillComplete = payload?.tag_filtered !== true && payload?.estimated !== true && payload?.truncated !== true;
        model.prefillPairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
        updateServiceOptions();
        updateOperationOptions();
        if (payload?.truncated) showError("Service / operation prefill reached its 20,000-combination safety limit. Use a narrower service / operation filter if the desired value is outside the discovered combinations.");
      } catch (error) {
        if (req.isCurrent()) showError(error, () => { void prefill({ force: true }); });
      }
    })();
    model.prefillPromise = run;
    try {
      await run;
    } finally {
      if (model.prefillPromise === run) model.prefillPromise = null;
    }
  }

  async function prefillForSelectedRange() {
    invalidateDiscovery();
    try { selectedRange(); } catch (_) { return; }
    await prefill({ force: true });
  }

  async function ensurePrefillForFilters() {
    if (!model.prefillPairs.length) await prefill();
  }

  function formatCustomRangeLabel() {
    return ns.timeRange ? ns.timeRange.describeRange(model.timeRange).text : "Last 1 hour";
  }

  // The hidden native select mirrors the applied range for assistive tech;
  // the picker writes the button label.
  function refreshCustomRangeLabel() {
    const option = dom.tracesRangeUnit?.options?.[0];
    if (option) option.textContent = formatCustomRangeLabel();
    timePicker?.refresh();
  }

  function closeCustomRangeEditor() {
    timePicker?.close();
  }

  // Applying a range (form, calendar, quick or recent range, shift / zoom)
  // reloads the service / operation choices, then searches that window.
  // Shift and zoom keep the panel open so they can be repeated.
  async function applyCustomRange(raw, source = "form") {
    model.timeRange = { from: String(raw?.from || ""), to: String(raw?.to || "") };
    model.timeRangeTouched = true;
    refreshCustomRangeLabel();
    if (source !== "shift" && source !== "zoom") closeCustomRangeEditor();
    try {
      await prefillForSelectedRange();
      await search();
    } catch (error) {
      showError(ns.util.errorText(error));
    }
  }

  async function loadAnalytics(filters) {
    if (model.meta?.analytics_enabled !== true) {
      model.analytics = null;
      model.analyticsLoading = false;
      model.analyticsError = "";
      model.durationsError = "";
      renderAnalytics();
      return;
    }
    // The charts of this search: its counts, then its durations (a new
    // search or host cancels both, and the separate durations load).
    const req = util.latest("traces.analytics");
    util.latest.cancel("traces.durations");
    model.analytics = null;
    model.analyticsLoading = true;
    model.analyticsError = "";
    model.durationsError = "";
    renderAnalytics();
    // Buckets start at local midnight (3 h buckets at 00:00, 03:00... local).
    const analyticsFilters = { ...filters, bucket_origin_ms: String(localMidnight(Number(filters.start_ms))) };
    delete analyticsFilters.limit;
    model.analyticsFilters = analyticsFilters;
    // The heatmap mode loads its own answer instead of the percentiles.
    ns.traceHeatmap?.onSearch?.(analyticsFilters);
    const message = (error) => ns.util.errorText(error);
    // Counts first: without filters the server reads them from the trace
    // index (well under a second for 7 days), while the duration percentiles
    // need the span aggregation, which takes seconds on multi-day windows.
    // With filters the first answer already carries both charts.
    let countsError = "";
    try {
      const counted = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "counts" }, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.analytics = unpackAnalytics(counted);
      if (!model.analytics.has_durations) renderAnalytics();
    } catch (error) {
      if (!req.isCurrent()) return;
      // The durations answer below carries the counts too.
      countsError = message(error);
    }
    try {
      if (model.analytics?.has_durations || ns.traceHeatmap?.active?.()) return;
      const full = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "durations" }, { signal: req.signal });
      if (!req.isCurrent()) return;
      // Span counts replace the index counts: both charts then describe
      // exactly the same traces.
      model.analytics = unpackAnalytics(full, model.analytics);
    } catch (error) {
      if (!req.isCurrent()) return;
      if (model.analytics) model.durationsError = message(error);
      else model.analyticsError = countsError || message(error);
    } finally {
      if (req.isCurrent()) {
        model.analyticsLoading = false;
        renderAnalytics();
      }
    }
  }

  // The percentiles of the current search, when the heatmap mode skipped
  // them and the Percentiles mode is shown again.
  async function loadDurations() {
    const filters = model.analyticsFilters;
    if (!filters || model.analytics?.has_durations || model.meta?.analytics_enabled !== true) { renderAnalytics(); return; }
    const req = util.latest("traces.durations");
    model.durationsError = "";
    renderAnalytics();
    try {
      const full = await api.getTraceAnalytics(currentHost(), { ...filters, charts: "durations" }, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.analytics = unpackAnalytics(full, model.analytics);
    } catch (error) {
      if (!req.isCurrent()) return;
      model.durationsError = ns.util.errorText(error);
    }
    renderAnalytics();
  }

  // url: "push" (a new search: its own history entry), "replace" (the
  // page-load search) or "none" (restored from history, the URL is already
  // this search).
  async function search({ url = "push" } = {}) {
    if (!model.meta) await loadMeta().catch(() => null);
    const searchState = ns.traceSearch;
    try {
      searchState?.commitPendingTag?.();
    } catch (error) {
      showError(ns.util.errorText(error));
      return;
    }
    if (searchState?.prefillTagsChanged?.() && model.prefillPairs.length) {
      // New tag chips narrow the pickers; the current choices stay selected.
      for (const select of [dom.tracesService, dom.tracesOperation]) if (select?.value) select.dataset.wanted = select.value;
      void prefill({ force: true });
    }
    await ensurePrefillForFilters();
    // This search supersedes the previous one and its charts.
    const req = util.latest("traces.search");
    util.latest.cancel("traces.analytics");
    util.latest.cancel("traces.durations");
    let filters;
    try {
      filters = searchFilters();
    } catch (error) {
      showError(ns.util.errorText(error));
      return;
    }
    address.write(url);
    // Another tab (app_trace_tabs.js, e.g. the service map) runs its own
    // search; the result list searches again when its tab comes back.
    const tabSearch = ns.traceTabs?.activeSearch?.();
    if (tabSearch) {
      model.lastSearchKey = "";
      setView(false);
      ns.uiState.busy(dom.tracesSearchButton, false);
      showError("");
      tabSearch(filters, { force: url === "push" });
      return;
    }
    model.lastSearchKey = searchState?.searchKey?.() || "";
    setView(false);
    ns.uiState.busy(dom.tracesSearchButton, true);
    showError("");
    // The charts load right after the list: say so instead of going blank.
    model.analytics = null;
    model.analyticsLoading = model.meta?.analytics_enabled === true;
    model.analyticsError = "";
    model.durationsError = "";
    renderAnalytics();
    try {
      if (ns.traceSpans?.active?.()) {
        // One row per span; the span table reports its own errors.
        await ns.traceSpans.search(filters);
        if (!req.isCurrent()) return;
        model.searched = true;
        model.lastSearchRange = { start_ms: Number(filters.start_ms), end_ms: Number(filters.end_ms) };
        void loadAnalytics(filters);
        searchState?.onSearched?.(filters);
        return;
      }
      const requested = performance.now();
      const payload = await api.searchTraces(currentHost(), filters, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.searchLatencyMs = performance.now() - requested;
      model.searched = true;
      model.lastSearchRange = { start_ms: Number(filters.start_ms), end_ms: Number(filters.end_ms) };
      unpackSearch(payload);
      renderResults();
      // Search results are intentionally delivered first. Heavy graph analytics
      // starts only after the trace list has rendered, on its own API route.
      void loadAnalytics(filters);
      searchState?.onSearched?.(filters);
    } catch (error) {
      if (!req.isCurrent()) return;
      model.traces = [];
      model.searched = false;
      model.analytics = null;
      model.analyticsLoading = false;
      renderResults();
      showError(error, () => { void search({ url: "none" }); });
    } finally {
      if (req.isCurrent()) ns.uiState.busy(dom.tracesSearchButton, false);
    }
  }

  async function loadTrace(traceId, { push = false } = {}) {
    const id = String(traceId || "").trim();
    if (!id) return;
    const req = util.latest("traces.detail");
    const pendingSpanId = model.pendingSpanId;
    model.pendingSpanId = "";
    model.traceError = null;
    showError("");
    setView(true);
    dom.traceDetail?.classList.remove("is-unavailable");
    if (dom.traceWaterfall) ns.uiState.loading(dom.traceWaterfall, { label: "Loading trace\u2026" });
    if (dom.traceInspector) { dom.traceInspector.hidden = true; dom.traceInspector.replaceChildren(); }
    void ns.traceLogs?.load?.(null);
    // The entry is pushed once the answer is in (the search stays the current
    // entry while it loads), whether the trace was found or not.
    const pushEntry = () => {
      if (push) address.push(null, { href: spanTraceUrl(id, pendingSpanId), state: detailEntryState({ traceId: id }) });
    };
    try {
      const trace = await api.getTrace(currentHost(), id, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.activeTrace = trace;
      model.activeSpanId = null;
      model.focusedSpanId = "";
      model.openSpanIds.clear();
      model.spanSections.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      palette.registerServices((trace?.spans || []).map((span) => span.service_name));
      pushEntry();
      renderTrace();
      ns.traceViews?.applyLocation?.();
      ns.uiState.announce(`Trace loaded: ${fmt.countLabel((trace?.spans || []).length, "span")}.`);
      // Logs load after the trace is on screen, never before.
      void ns.traceLogs?.load?.(trace);
    } catch (error) {
      if (!req.isCurrent()) return;
      model.activeTrace = null;
      model.activeSpanId = null;
      model.openSpanIds.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      // The detail pane says what happened (unavailableHtml), not the strip.
      model.traceError = { id, code: String(error?.code || ""), text: ns.util.errorText(error) };
      pushEntry();
      renderTrace();
      ns.traceViews?.applyLocation?.();
    }
  }

  // The detail pane of a trace that could not be loaded: what happened in a
  // sentence and what to do next, instead of an empty trace header.
  function unavailableHtml(failed) {
    const missing = failed.code === "trace_not_found";
    const invalid = failed.code === "invalid_trace_id" || failed.code === "missing_trace_id";
    const zoom = dom.tracesRangeZoomOut;
    const options = {
      title: missing ? "Trace not found" : invalid ? "Not a trace ID" : "The trace could not be loaded",
      body: missing
        ? "No span with this trace ID is stored. The trace may be older than the data kept, not ingested yet, or recorded on another host."
        : invalid ? "A trace ID is 32 hexadecimal characters (16 bytes)." : failed.text,
      attrs: { "data-trace-unavailable-state": failed.code || "error" },
      actions: [
        { label: "Back to search", primary: true, attrs: { "data-trace-unavailable": "back" } },
        missing && zoom && !zoom.disabled ? { label: "Search a wider time range", attrs: { "data-trace-unavailable": "wider" } } : null,
        !missing && !invalid ? { label: "Retry", attrs: { "data-trace-unavailable": "retry" } } : null,
      ],
    };
    // A missing or malformed ID is a state of the data (status); a failed load is an error (alert).
    return missing || invalid ? ns.uiState.emptyHtml({ ...options, role: "status" }) : ns.uiState.errorHtml(options);
  }

  function onUnavailableClick(event) {
    const action = event.target instanceof Element ? event.target.closest("[data-trace-unavailable]")?.getAttribute("data-trace-unavailable") : "";
    if (!action || !model.traceError) return;
    const id = model.traceError.id;
    if (action === "back") returnToSearch();
    else if (action === "retry") void loadTrace(id, { push: false });
    else if (action === "wider") {
      // The search of this trace's context, its range zoomed out (a new entry).
      model.traceError = null;
      dom.traceDetail?.classList.remove("is-unavailable");
      dom.tracesRangeZoomOut?.click();
    }
  }

  // History entries of an open trace count the steps back to the search entry
  // it was opened from (state.searchBack): a trace opened from the results is
  // 1 step away, a span or view picked in it (a pushed entry) one more, a
  // linked trace opened from it one more again. A direct link or a new tab
  // has no such entry (no searchBack).
  function detailEntryState(state) {
    const steps = traceIdFromPath() ? Number(ns.router.state().searchBack) || 0 : 1;
    const next = { ...(state || {}) };
    delete next.searchBack;
    if (steps > 0 && address.active()) next.searchBack = traceIdFromPath() ? steps + 1 : 1;
    return next;
  }

  // The back arrow (#traceBackButton) and "Back to search": back to the very
  // search entry the trace came from, so Back / Forward stay one list of
  // pages, else a new entry for the trace's search context.
  function returnToSearch() {
    const steps = Number(ns.router.state().searchBack) || 0;
    if (steps > 0 && address.active() && traceIdFromPath()) {
      ns.router.back(steps);
      return;
    }
    backToSearch({ push: true });
  }

  function backToSearch({ push = true } = {}) {
    model.traceError = null;
    dom.traceDetail?.classList.remove("is-unavailable");
    model.activeTrace = null;
    model.activeSpanId = null;
    model.focusedSpanId = "";
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    ns.traceSearch?.closeMenu?.();
    if (push) address.push();
    ns.traceInsights?.onTraceChanged(null);
    setView(false);
    // The trace's search context may differ from the listed results (a
    // shared link, or Back / Forward across searches).
    const key = ns.traceSearch?.searchKey?.() || "";
    const listed = ns.traceSpans?.active?.() ? ns.traceSpans.hasResults() : model.traces.length > 0;
    if (!listed || !model.searched || key !== (model.lastSearchKey || "")) search({ url: "none" });
    else ns.traceSpans?.onShown?.();
  }

  // The host and the feature flags often arrive together (the first load):
  // both ask for a reload, which runs once per host.
  let hostReload = null;
  function reloadForHost() {
    const host = currentHost();
    if (hostReload && hostReload.host === host) return hostReload.promise;
    const promise = reloadForHostNow().finally(() => { if (hostReload?.promise === promise) hostReload = null; });
    hostReload = { host, promise };
    return promise;
  }

  async function reloadForHostNow() {
    model.meta = null;
    model.traces = [];
    model.searched = false;
    model.analytics = null;
    model.analyticsLoading = false;
    model.analyticsError = "";
    model.prefillPairs = [];
    model.prefillPromise = null;
    for (const key of ["traces.prefill", "traces.analytics", "traces.durations"]) util.latest.cancel(key);
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    ns.traceSearch?.resetFacets?.();
    renderResults();
    renderSource();
    try {
      await loadMeta();
      const id = traceIdFromPath();
      if (id) await loadTrace(id, { push: false });
      else {
        await prefill();
        await search({ url: "replace" });
      }
    } catch (_) {}
  }

  // Back / Forward, or the Observability page showing this view again: the
  // URL is the state. Same trace, other ?span= / ?view=: no reload. Every
  // entry carries its search state: restore it first.
  function onLocation() {
    const id = traceIdFromPath();
    ns.traceSearch?.applyLocation?.();
    if (id && id === String(model.activeTrace?.trace_id || "")) ns.traceViews?.applyLocation?.();
    else if (id) loadTrace(id, { push: false });
    else backToSearch({ push: false });
  }

  // A host change while another view is shown reloads when this one comes back.
  let reloadWhenShown = false;

  function onShow() {
    if (model.activeTrace && !dom.traceDetail?.hidden) renderTraceHeader();
    if (reloadWhenShown) {
      reloadWhenShown = false;
      reloadForHost();
    }
  }

  function onHide() {
    ns.traceSearch?.closeMenu?.();
    ns.menu?.closeAll();
  }

  // Shared with the other Observability views: the time range and the service.
  function getContext() {
    return { range: { ...model.timeRange }, service: String(dom.tracesService?.value || "") };
  }

  function applyContext(params, context) {
    if (context.range) ns.timeRange.url.write(params, context.range);
    if (context.service != null && context.service !== (params.get("service") || "")) {
      // An operation belongs to the service it was picked for.
      params.delete("operation");
      if (context.service) params.set("service", context.service);
      else params.delete("service");
    }
  }

  function init() {
    model.resultsView = readStored(RESULTS_VIEW_KEY, ["list", "table"], "list");
    model.startDisplay = readStored(START_DISPLAY_KEY, ["absolute", "relative"], "absolute");
    initTracePickers();
    initWaterfallEvents();
    initSpanDetailEvents();
    ns.traceLogs?.install?.({
      model, activeTraceCache, renderWaterfall, focusSpanInTimeline, enhanceTraceSelect, esc,
      parseStructuredValue, renderAttributeTable, absoluteTimeText, spanDetailClick, currentHost,
      waterfallWindow: () => waterfallContext(activeTraceCache()),
    });
    ns.traceViews?.install?.({
      model, activeTraceCache, renderWaterfall, focusSpanInTimeline, spanTraceUrl, enhanceTraceSelect,
      esc, copyText, spanEventList, eventItemHtml, parseStructuredValue, spanDetailClick,
      attributeEntries, spanKindLabel,
    });
    ns.traceInsights?.install?.({
      model, activeTraceCache, focusSpanInTimeline, loadTrace, spanTraceUrl, esc, copyText,
      spanEventList, parseStructuredValue, attributeEntries, renderAttributeTable, sectionOpen, setSectionOpen, currentHost,
      exactStartNs: (span) => traceJsonExactStartNs(span) || String(Math.round(Number(span.start_ns || 0))),
    });
    ns.traceSpans?.install?.({
      model, dom, api, esc, route, copyText, currentHost, loadTrace, spanTraceUrl, noResultsHtml,
      spanKindLabel, absoluteTimeText, renderJaegerAttributes, renderAttributeTable, attributeEntries,
      spanEventList, eventItemHtml, spanLinkList, spanDetailClick, enhanceTraceSelect,
      runSearch: (options) => search(options),
    });
    ns.traceSearch?.install?.({
      model, dom, api, esc, route, copyText, currentHost, currentTag,
      runSearch: (options) => search(options),
      syncRange: () => syncRangeControls(),
      refreshServiceOperationOptions: () => { updateServiceOptions(); updateOperationOptions(); },
      syncServiceOperationPair,
      setResultsView: (view, options) => setResultsView(view, options),
    });
    ns.traceHeatmap?.install?.({
      model, dom, api, esc, currentHost, durationAxis, chartMessage, mountChart, unmountChart,
      CHART_SYNC_KEY,
      renderDurationChart: () => renderDurationChart(),
      loadDurations: () => loadDurations(),
      applyRange: (raw) => applyCustomRange(raw, "heatmap"),
    });
    ns.traceTabs?.install?.({
      model, dom, api, esc, route, currentHost, showError,
      copyText, loadTrace, spanTraceUrl, localMidnight,
      // Chart helpers of the result list charts (the Services view's RED charts).
      chart: { mountChart, unmountChart, chartMessage, durationAxis, bucketGrid, zoomSearchRange },
      runSearch: (options) => search(options),
      // The result list tab is shown again: search when it is stale.
      showSearch: () => {
        const key = ns.traceSearch?.searchKey?.() || "";
        if (!model.searched || key !== (model.lastSearchKey || "")) search({ url: "none" });
        else ns.traceSpans?.onTabShown?.();
      },
    });
    // Search state from the URL (a shared link, a reload, a trace detail URL
    // carrying its search context).
    ns.traceSearch?.applyLocation?.({ initial: true });
    dom.tracesForm?.addEventListener("submit", (event) => { event.preventDefault(); search(); });
    trackSearchBarHeight();
    // On a phone the trace header's stats, highlights and service filters
    // are rows that scroll sideways (traces.css): fade the side they hide.
    for (const row of [dom.traceDetailStats, ns.dom.byId("traceHighlights"), dom.traceServiceFilters]) ns.shell?.edgeCues?.(row);
    dom.tracesSort?.addEventListener("change", () => {
      renderResults();
      if (!traceIdFromPath()) address.replace();
    });
    dom.tracesService?.addEventListener("change", () => { syncServiceOperationPair("service"); });
    dom.tracesOperation?.addEventListener("change", () => { syncServiceOperationPair("operation"); });
    dom.traceBackButton?.addEventListener("click", () => returnToSearch());
    dom.tracesSearchView?.addEventListener("click", (event) => {
      const retry = event.target instanceof Element ? event.target.closest("[data-chart-retry]")?.getAttribute("data-chart-retry") : "";
      if (retry === "durations") void loadDurations();
      else if (retry === "analytics" && model.analyticsFilters) void loadAnalytics(model.analyticsFilters);
    });
    dom.traceDetail?.addEventListener("click", onUnavailableClick);
    if (dom.traceCopySplit) {
      traceCopySplit = ns.ui.copySplit({
        root: dom.traceCopySplit,
        getText: copyTraceJsonText,
        items: [{ el: dom.traceDownloadJsonButton, onSelect: downloadTraceJson }],
      });
    }
    // The trace page's keys ([ ] o p, a / d, arrows) while Traces shows.
    ns.lifecycle.bind("traces", (scope) => scope.listen(document, "keydown", onTraceKeydown));
    // The canvas overview holds resolved colours: redraw it for a new theme.
    const redrawOverview = () => {
      const graph = $('[data-overview-mode="canvas"]', dom.traceOverview);
      if (graph && model.activeTrace) renderTraceOverview(activeTraceCache().spans, activeTraceCache().bounds);
    };
    new MutationObserver(redrawOverview).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", redrawOverview);
    window.addEventListener("chdash:host-changed", () => {
      if (address.active()) reloadForHost();
      else reloadWhenShown = true;
    });
    ns.features.on((features) => {
      if (features?.traces?.enabled === false || !address.active()) return;
      if (!model.meta && currentHost()) reloadForHost();
    });
    const id = traceIdFromPath();
    setView(!!id);
    if (currentHost()) reloadForHost();
  }

  // renderAnalytics (redraw the charts from the model) and scatterDots (the
  // scatter as drawn) are test and benchmark hooks.
  ns.traces = { init, onLocation, onShow, onHide, getContext, applyContext, search, loadTrace, returnToSearch, detailEntryState, renderAnalytics, scatterDots };
})();
