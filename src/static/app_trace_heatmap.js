(() => {
  "use strict";
  // Duration heatmap + box-select comparison ("why is this slow"), after
  // HyperDX's DBSearchHeatmapChart / DBDeltaChart. An alternative mode of the
  // "Trace duration" card: x = trace start (the analytics' time buckets), y =
  // log-scaled trace duration, colour = traces per cell. Dragging a box (or
  // arrow keys + Enter) compares the traces inside it with the other traces of
  // that time (GET /api/traces/deltas): per attribute, the share of each side's
  // sampled traces having a span with each value. A value click applies it as
  // a filter chip (app_trace_search.js); "Search traces in this box" sets the
  // range and the trace duration filter and searches.
  // app_traces.js calls install(ctx) with its model and chart helpers.
  const ns = window.ChDash;
  if (!ns) return;

  const MODE_KEY = "chdash.traceDurationView.v1";
  const MODES = ["percentiles", "heatmap"];
  const HEAT_LEVELS = 8;
  const byId = (id) => document.getElementById(id);

  let ctx = null;
  let geo = null;
  const hm = {
    mode: readMode(),
    seq: 0,
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
  const deltas = { seq: 0, data: null, loading: false, error: "", baseline: "outside" };

  function readMode() {
    try {
      const value = localStorage.getItem(MODE_KEY);
      return MODES.includes(value) ? value : "percentiles";
    } catch { return "percentiles"; }
  }

  function storeMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage may be unavailable */ }
  }

  const esc = (value) => ctx.esc(value);
  const fmt = (ns) => ctx.formatDuration(ns);
  const active = () => hm.mode === "heatmap";

  function filtersKey(filters) {
    return JSON.stringify(filters || {});
  }

  // ------------------------------------------------------------ mode + URL

  function syncToggle() {
    document.querySelectorAll("[data-duration-view]").forEach((button) => {
      const on = button.getAttribute("data-duration-view") === hm.mode;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const chart = ctx?.dom?.traceDurationChart;
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
    if (url && !/\/traces\/[^/]+\/?$/.test(String(window.location.pathname || ""))) ns.traceSearch?.writeUrl?.("replace");
    if (active()) {
      if (hm.filters && hm.dataKey !== filtersKey(hm.filters)) void load();
      else render();
    } else {
      renderPanel();
      ctx.loadDurations();
    }
  }

  // Search state from a URL: duration_view=heatmap, or the remembered mode on
  // a page load without it.
  function applyParams(params, { initial = false } = {}) {
    const value = params.get("duration_view");
    const mode = MODES.includes(value) ? value : initial ? readMode() : "percentiles";
    if (!ctx) { hm.mode = mode; return; }
    if (initial) { hm.mode = mode; syncToggle(); return; }
    setMode(mode, { persist: false, url: false });
  }

  function writeParams(params) {
    if (active()) params.set("duration_view", "heatmap");
  }

  // ---------------------------------------------------------------- loading

  // Every search: the new filters (the old box no longer applies).
  function onSearch(filters) {
    hm.filters = { ...(filters || {}) };
    clearSelection({ render: false });
    if (active()) void load();
    else { hm.data = null; hm.dataKey = ""; }
  }

  async function load() {
    if (!hm.filters || !ctx) return;
    const seq = ++hm.seq;
    const key = filtersKey(hm.filters);
    hm.loading = true;
    hm.error = "";
    hm.data = null;
    hm.dataKey = key;
    render();
    try {
      const data = await ctx.api.getTraceHeatmap(ctx.currentHost(), hm.filters);
      if (seq !== hm.seq) return;
      hm.data = data;
    } catch (error) {
      if (seq !== hm.seq) return;
      hm.error = error instanceof Error ? error.message : String(error);
      hm.dataKey = "";
    } finally {
      if (seq === hm.seq) {
        hm.loading = false;
        if (active()) render();
      }
    }
  }

  // ---------------------------------------------------------------- scales

  function niceLogTicks(lo, hi) {
    if (hi / lo >= 8) {
      const ticks = [];
      for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k += 1) {
        for (const m of [1, 2, 5]) {
          const value = m * 10 ** k;
          if (value >= lo && value <= hi) ticks.push(value);
        }
      }
      return ticks.length > 7 ? ticks.filter((value) => Math.abs(Math.log10(value) - Math.round(Math.log10(value))) < 1e-9) : ticks;
    }
    const axis = ctx.durationAxis(lo, hi, 4);
    return axis.values.map((tick) => tick.value).filter((value) => value >= lo && value <= hi);
  }

  function level(count, max) {
    if (!(count > 0)) return 0;
    if (max <= 1) return HEAT_LEVELS;
    return Math.max(1, Math.min(HEAT_LEVELS, Math.ceil((Math.log1p(count) / Math.log1p(max)) * HEAT_LEVELS)));
  }

  function traceCount(n) {
    return `${Number(n).toLocaleString()} trace${Number(n) === 1 ? "" : "s"}`;
  }

  function rowRangeLabel(r0, r1) {
    const lo = r0 === 0 && Number(hm.data?.below_min_count || 0) > 0 ? `≤ ${fmt(geo.edges[1])}` : null;
    if (lo && r1 === 0) return lo;
    return `${r0 === 0 && lo ? "0" : fmt(geo.edges[r0])} – ${fmt(geo.edges[r1 + 1])}`;
  }

  // ---------------------------------------------------------------- render

  function render() {
    const container = ctx?.dom?.traceDurationChart;
    if (!container || !active()) return;
    syncToggle();
    const meta = ctx.dom.traceDurationChartMeta;
    const data = hm.data;
    geo = null;
    if (hm.loading || (!data && !hm.error && hm.filters)) {
      ctx.chartMessage(container, "Loading duration heatmap…");
      if (meta) meta.textContent = "Traces per cell";
      renderPanel();
      return;
    }
    if (hm.error) {
      container.innerHTML = `<div class="tracesEmpty traceChartError" role="alert"><span>${esc(hm.error)}</span> <button type="button" class="traceMiniButton" data-heatmap-retry>Retry</button></div>`;
      container.querySelector("[data-heatmap-retry]")?.addEventListener("click", () => { void load(); });
      renderPanel();
      return;
    }
    if (!data) { ctx.chartMessage(container, "Search to load the duration heatmap."); renderPanel(); return; }
    const cells = (Array.isArray(data.cells) ? data.cells : []).map((cell) => cell.map(Number));
    const edges = (Array.isArray(data.y_edges_ns) ? data.y_edges_ns : []).map(Number);
    const rows = Math.max(0, Number(data.rows || 0));
    if (!cells.length || rows < 1 || edges.length !== rows + 1) {
      ctx.chartMessage(container, "No trace durations in this range.");
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
    const ticks = niceLogTicks(lo, hi);
    const tickLabels = ticks.map((value) => fmt(value));
    const W = ctx.chartWidth(container), H = ctx.CHART_HEIGHT, top = 10, bottom = 30, right = 12;
    const left = Math.ceil(10 + Math.max(24, ...tickLabels.map((label) => ctx.labelWidthPx(label))));
    const plotW = W - left - right, plotH = H - top - bottom;
    const logLo = Math.log(lo), logSpan = Math.max(1e-9, Math.log(hi) - logLo);
    const xOf = (ms) => Math.min(left + plotW, Math.max(left, left + ((ms - xMin) / (xMax - xMin)) * plotW));
    const yOf = (value) => top + plotH - ((Math.log(Math.max(value, lo)) - logLo) / logSpan) * plotH;
    const maxCount = Math.max(1, Number(data.max_count || 0), ...cells.map((cell) => cell[2]));
    const counts = new Map();
    geo = { W, H, top, left, plotW, plotH, xMin, xMax, bucketMs, gridStart, cols, rows, edges, xOf, yOf, logLo, logSpan, counts, maxCount };
    const colStart = (col) => gridStart + col * bucketMs;
    const cellSvg = cells.map(([bucket, row, count]) => {
      const col = Math.round((bucket - gridStart) / bucketMs);
      counts.set(`${col}:${row}`, count);
      const x1 = xOf(bucket), x2 = xOf(bucket + bucketMs);
      const y1 = yOf(edges[row + 1]), y2 = yOf(edges[row]);
      const gapX = x2 - x1 > 3 ? 1 : 0, gapY = y2 - y1 > 3 ? 1 : 0;
      return `<rect x="${x1.toFixed(2)}" y="${y1.toFixed(2)}" width="${Math.max(0.5, x2 - x1 - gapX).toFixed(2)}" height="${Math.max(0.5, y2 - y1 - gapY).toFixed(2)}" class="traceHeatCell lvl-${level(count, maxCount)}" data-heat-col="${col}" data-heat-row="${row}" data-heat-ts="${bucket}" data-count="${count}"/>`;
    }).join("");
    const yTicks = ticks.map((value, i) => {
      const y = yOf(value);
      return `<line x1="${left}" y1="${y.toFixed(1)}" x2="${W - right}" y2="${y.toFixed(1)}" class="traceChart__grid"/><text x="${left - 6}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" class="traceChart__tick" data-heat-tick="${value}">${esc(tickLabels[i])}</text>`;
    }).join("");
    const xTicks = ctx.timeAxisSvg(xMin, xMax, left, plotW, H, W);
    const ramp = Array.from({ length: HEAT_LEVELS }, (_, i) => `<i class="lvl-${i + 1}"></i>`).join("");
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="traceChart__svg traceHeatmap" data-rows="${rows}" data-cols="${cols}">${yTicks}<g class="traceHeatCells">${cellSvg}</g>${xTicks}<rect class="traceHeatSelection" hidden/><rect class="traceHeatBrush" hidden/><rect class="traceHeatCursor" hidden/><rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" class="traceChartHit traceHeatHit"/></svg>`
      + `<div class="traceChartLegend traceHeatLegend"><span class="traceHeatLegend__label">Traces per cell</span><span class="traceHeatLegend__scale"><span>1</span><span class="traceHeatLegend__ramp" aria-hidden="true">${ramp}</span><span data-heat-max>${esc(maxCount.toLocaleString())}</span></span><span class="traceHeatLegend__hint">Drag a box to compare its traces</span></div>`
      + '<div class="srOnly traceHeatLive" aria-live="polite"></div>';
    geo.colStart = colStart;
    if (meta) {
      meta.textContent = `${traceCount(Number(data.total || 0))} · ${fmt(bucketMs * 1e6)} × log duration`;
      meta.title = String(data.unit_label || "Traces with a matching span, at their first span start");
    }
    attachPointer(container);
    drawSelection();
    drawCursor();
    renderPanel();
  }

  // ------------------------------------------------------- hit testing

  function svgPoint(container, event) {
    const svg = container.querySelector("svg");
    const box = svg?.getBoundingClientRect();
    if (!box || !box.width) return null;
    return [(event.clientX - box.left) * (geo.W / box.width), (event.clientY - box.top) * (geo.H / box.height)];
  }

  function cellAt(x, y) {
    const cx = Math.min(geo.left + geo.plotW - 0.01, Math.max(geo.left, x));
    const cy = Math.min(geo.top + geo.plotH, Math.max(geo.top, y));
    const ms = geo.xMin + ((cx - geo.left) / geo.plotW) * (geo.xMax - geo.xMin);
    const col = Math.max(0, Math.min(geo.cols - 1, Math.floor((ms - geo.gridStart) / geo.bucketMs)));
    const value = Math.exp(geo.logLo + ((geo.top + geo.plotH - cy) / geo.plotH) * geo.logSpan);
    let row = 0;
    while (row < geo.rows - 1 && value >= geo.edges[row + 1]) row += 1;
    return { col, row };
  }

  function boxOf(a, b) {
    return { c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col), r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row) };
  }

  function boxRect(box) {
    const x1 = geo.xOf(geo.colStart(box.c0)), x2 = geo.xOf(geo.colStart(box.c1 + 1));
    const y1 = geo.yOf(geo.edges[box.r1 + 1]), y2 = geo.yOf(geo.edges[box.r0]);
    return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
  }

  function placeRect(rect, box) {
    if (!rect) return;
    if (!box) { rect.setAttribute("hidden", ""); return; }
    const r = boxRect(box);
    for (const [name, value] of Object.entries(r)) rect.setAttribute(name, value.toFixed(2));
    rect.removeAttribute("hidden");
  }

  function boxCount(box) {
    let sum = 0;
    for (let col = box.c0; col <= box.c1; col += 1) for (let row = box.r0; row <= box.r1; row += 1) sum += geo.counts.get(`${col}:${row}`) || 0;
    return sum;
  }

  function cellText(cell) {
    const count = geo.counts.get(`${cell.col}:${cell.row}`) || 0;
    return { when: ctx.bucketRangeLabel(geo.colStart(cell.col), geo.bucketMs), duration: rowRangeLabel(cell.row, cell.row), count };
  }

  function drawSelection() {
    const svg = ctx.dom.traceDurationChart?.querySelector("svg.traceHeatmap");
    if (!svg || !geo) return;
    const sel = hm.selection;
    placeRect(svg.querySelector(".traceHeatSelection"), sel && sel.c1 < geo.cols && sel.r1 < geo.rows ? sel : null);
    svg.classList.toggle("has-selection", !!sel);
  }

  function drawCursor() {
    const svg = ctx.dom.traceDurationChart?.querySelector("svg.traceHeatmap");
    if (!svg || !geo) return;
    const cursor = hm.cursor && hm.cursor.col < geo.cols && hm.cursor.row < geo.rows ? hm.cursor : null;
    placeRect(svg.querySelector(".traceHeatCursor"), cursor ? boxOf(cursor, cursor) : null);
    placeRect(svg.querySelector(".traceHeatBrush"), cursor && hm.anchor ? boxOf(hm.anchor, cursor) : null);
  }

  // ------------------------------------------------------- tooltip

  function tooltipEl(container) {
    let tip = container.querySelector(".traceChartTooltip");
    if (!tip) {
      tip = document.createElement("div");
      tip.className = "traceChartTooltip";
      tip.hidden = true;
      container.appendChild(tip);
    }
    return tip;
  }

  function hideTooltip() {
    const tip = ctx?.dom?.traceDurationChart?.querySelector(".traceChartTooltip");
    if (tip) tip.hidden = true;
  }

  // At client coordinates, or next to the cell's box when keyboard driven.
  function showTooltip(container, html, clientX, clientY) {
    const tip = tooltipEl(container);
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = "0px";
    tip.style.top = "0px";
    const size = tip.getBoundingClientRect();
    const rect = container.getBoundingClientRect();
    let left = clientX - rect.left + 12;
    let top = clientY - rect.top + 12;
    if (left + size.width > rect.width - 4) left = clientX - rect.left - size.width - 12;
    if (top + size.height > rect.height - 4) top = clientY - rect.top - size.height - 12;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }

  function cellTooltip(cell) {
    const text = cellText(cell);
    return `<strong>${esc(traceCount(text.count))}</strong><span>Start <b>${esc(text.when)}</b></span><span>Duration <b>${esc(text.duration)}</b></span>`;
  }

  function boxTooltip(box) {
    return `<strong>≈ ${esc(traceCount(boxCount(box)))} in the box</strong><span>Start <b>${esc(ctx.bucketRangeLabel(geo.colStart(box.c0), (box.c1 - box.c0 + 1) * geo.bucketMs))}</b></span><span>Duration <b>${esc(rowRangeLabel(box.r0, box.r1))}</b></span>`;
  }

  // ------------------------------------------------------- pointer + keys

  function attachPointer(container) {
    const surface = container.querySelector(".traceHeatHit");
    const svg = container.querySelector("svg");
    if (!surface || !svg) return;
    const brush = svg.querySelector(".traceHeatBrush");
    surface.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !geo) return;
      const at = svgPoint(container, event);
      if (!at) return;
      const cell = cellAt(at[0], at[1]);
      hm.drag = { start: cell, current: cell };
      hm.anchor = null;
      hm.cursor = null;
      drawCursor();
      try { surface.setPointerCapture(event.pointerId); } catch { /* synthetic pointers */ }
      event.preventDefault();
      placeRect(brush, boxOf(cell, cell));
      showTooltip(container, boxTooltip(boxOf(cell, cell)), event.clientX, event.clientY);
    });
    surface.addEventListener("pointermove", (event) => {
      if (!geo) return;
      const at = svgPoint(container, event);
      if (!at) return;
      const cell = cellAt(at[0], at[1]);
      if (hm.drag) {
        hm.drag.current = cell;
        const box = boxOf(hm.drag.start, cell);
        placeRect(brush, box);
        showTooltip(container, boxTooltip(box), event.clientX, event.clientY);
        return;
      }
      const inside = at[0] >= geo.left && at[0] <= geo.left + geo.plotW && at[1] >= geo.top && at[1] <= geo.top + geo.plotH;
      if (!inside) { hideTooltip(); return; }
      showTooltip(container, cellTooltip(cell), event.clientX, event.clientY);
    });
    const finish = (event, cancelled) => {
      if (!hm.drag) return;
      const { start, current } = hm.drag;
      hm.drag = null;
      placeRect(brush, null);
      try { surface.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
      hideTooltip();
      if (!cancelled) select(boxOf(start, current));
    };
    surface.addEventListener("pointerup", (event) => finish(event, false));
    surface.addEventListener("pointercancel", (event) => finish(event, true));
    surface.addEventListener("pointerleave", () => { if (!hm.drag) hideTooltip(); });
  }

  function announce(text) {
    const live = ctx.dom.traceDurationChart?.querySelector(".traceHeatLive");
    if (live) live.textContent = text;
  }

  function onKeydown(event) {
    if (!active() || !geo || event.target !== ctx.dom.traceDurationChart) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const container = ctx.dom.traceDurationChart;
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
      const svgBox = container.querySelector("svg").getBoundingClientRect();
      const r = boxRect(boxOf(hm.cursor, hm.cursor));
      const scale = svgBox.width / geo.W;
      const html = box ? boxTooltip(box) : cellTooltip(hm.cursor);
      showTooltip(container, html, svgBox.left + (r.x + r.width) * scale, svgBox.top + (r.y + r.height) * scale);
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
    ++deltas.seq;
    hm.selection = null;
    deltas.data = null;
    deltas.loading = false;
    deltas.error = "";
    if (redraw) { drawSelection(); renderPanel(); }
  }

  async function loadDeltas() {
    const sel = hm.selection;
    if (!sel || !hm.filters) return;
    const seq = ++deltas.seq;
    deltas.loading = true;
    deltas.error = "";
    deltas.data = null;
    renderPanel();
    try {
      const data = await ctx.api.getTraceDeltas(ctx.currentHost(), {
        ...hm.filters,
        t0: String(Math.round(sel.t0)), t1: String(Math.round(sel.t1)),
        d0: String(sel.d0 / 1e6), d1: String(sel.d1 / 1e6),
        baseline: deltas.baseline,
      });
      if (seq !== deltas.seq) return;
      deltas.data = data;
    } catch (error) {
      if (seq !== deltas.seq) return;
      deltas.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === deltas.seq) {
        deltas.loading = false;
        renderPanel();
      }
    }
  }

  // Three significant digits, rounded outwards (the box keeps its traces).
  function roundMs(ms, up) {
    if (!(ms > 0)) return 0;
    const scale = 10 ** (Math.floor(Math.log10(ms)) - 2);
    const value = (up ? Math.ceil(ms / scale) : Math.floor(ms / scale)) * scale;
    return Number(value.toPrecision(3));
  }

  function searchInBox() {
    const sel = hm.selection;
    if (!sel) return;
    if (ctx.model.meta?.features?.duration_filter !== false) {
      ns.traceSearch?.setDuration?.({ min: roundMs(sel.d0 / 1e6, false), max: roundMs(sel.d1 / 1e6, true) });
    }
    const format = ns.timeRange?.formatDateTime;
    if (!format) return;
    void ctx.applyRange({ from: format(Math.floor(sel.t0 / 1000) * 1000), to: format(Math.ceil(sel.t1 / 1000) * 1000) });
  }

  // ------------------------------------------------------- comparison panel

  function pct(value) {
    const n = Number(value || 0);
    if (n <= 0) return "0%";
    if (n < 1) return "<1%";
    return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : Math.round(n)}%`;
  }

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
        + `<button type="button" class="traceDeltaRow__exclude" data-delta-exclude="${index}:${j}" title="Exclude this value" aria-label="Exclude ${esc(`${label} = ${text}`)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg></button></li>`;
    }).join("");
    return `<article class="traceDeltaCard" data-delta-key="${esc(`${item.scope}:${item.key}`)}"><header><span class="traceDeltaCard__scope traceDeltaCard__scope--${esc(scope)}">${esc(scope === "column" ? "field" : scope)}</span><strong title="${esc(item.key)}">${esc(label)}</strong><span class="traceDeltaCard__score" title="Largest gap between the selection and baseline shares of one value (percentage points)">Δ ${esc(Math.round(Math.max(0, Number(item.score || 0) - (item.boosted ? 2 : 0))))} pts</span></header><ul class="traceDeltaCard__values">${values}</ul></article>`;
  }

  function panelBodyHtml() {
    if (deltas.loading) return `<div class="traceDeltaPanel__state" role="status"><span class="traceDeltaSpinner" aria-hidden="true"></span>Comparing sampled traces of the box with the baseline…</div>`;
    if (deltas.error) return `<div class="traceDeltaPanel__state traceChartError" role="alert"><span>${esc(deltas.error)}</span><button type="button" class="traceMiniButton" data-delta-retry>Retry</button></div>`;
    const data = deltas.data;
    if (!data) return "";
    if (!Number(data.selection?.sampled || 0)) return '<div class="traceDeltaPanel__state">No traces in this box: select cells that hold traces.</div>';
    const keys = Array.isArray(data.keys) ? data.keys : [];
    if (!keys.length) {
      const hidden = (data.hidden_keys || []).length;
      return `<div class="traceDeltaPanel__state">No attribute sets these traces apart from the baseline${hidden ? ` (${hidden} identifier or high-cardinality key${hidden === 1 ? "" : "s"} skipped)` : ""}.</div>`;
    }
    return `<div class="traceDeltaGrid">${keys.map(cardHtml).join("")}</div>`;
  }

  function sampleText(data) {
    if (!data) return "";
    const sel = data.selection || {}, base = data.baseline_sample || {};
    const baseline = data.baseline === "all" ? "all traces of that time" : "the other traces of that time";
    const sampled = data.window_sampled ? ` · time sampled as ${(data.sampled_windows || []).length} slices of ${fmt(Number(data.sampled_ms || 0) / Math.max(1, (data.sampled_windows || []).length) * 1e6)}` : "";
    return `${Number(sel.sampled || 0).toLocaleString()} of ${traceCount(sel.traces || 0)} in the box vs ${Number(base.sampled || 0).toLocaleString()} of ${traceCount(base.traces || 0)} (${baseline})${sampled}`;
  }

  function renderPanel() {
    const panel = byId("traceDeltaPanel");
    if (!panel || !ctx) return;
    const sel = hm.selection;
    const show = active() && !!sel && ctx.model.meta?.analytics_enabled === true;
    panel.hidden = !show;
    if (!show) { panel.innerHTML = ""; return; }
    const when = ctx.bucketRangeLabel(sel.t0, Math.max(1, sel.t1 - sel.t0));
    const duration = sel.d0 > 0 ? `${fmt(sel.d0)} – ${fmt(sel.d1)}` : `≤ ${fmt(sel.d1)}`;
    const durationFilter = ctx.model.meta?.features?.duration_filter !== false;
    panel.innerHTML = `<header class="traceDeltaPanel__head"><div class="traceDeltaPanel__title"><strong>Selection vs baseline</strong><span>Traces starting <b>${esc(when)}</b> lasting <b>${esc(duration)}</b></span></div>`
      + `<div class="traceDeltaPanel__actions"><label class="traceDeltaPanel__baseline"><span>Baseline</span><select data-delta-baseline aria-label="Baseline traces"><option value="outside"${deltas.baseline === "outside" ? " selected" : ""}>Other traces of that time</option><option value="all"${deltas.baseline === "all" ? " selected" : ""}>All traces of that time</option></select></label>`
      + `<button type="button" class="button button--small traceDeltaPanel__search" data-delta-search title="${esc(durationFilter ? "Search this time range with this trace duration range" : "Search this time range (duration filters are disabled)")}">Search traces in this box</button>`
      + '<button type="button" class="button button--small traceDeltaPanel__clear" data-delta-clear title="Clear the selection (Escape)">Clear selection</button></div></header>'
      + `<div class="traceDeltaPanel__meta"><span class="traceDeltaLegend"><span class="is-selection">Selection</span><span class="is-baseline">Baseline</span></span><span class="traceDeltaPanel__sample">${esc(deltas.data ? sampleText(deltas.data) : `≈ ${traceCount(sel.estimate)} in the box`)}</span></div>`
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
      if (filter) ns.traceSearch?.filter?.(field, hit.value.value);
      else ns.traceSearch?.exclude?.(field, hit.value.value);
    } else if (target.closest("[data-delta-search]")) {
      searchInBox();
    } else if (target.closest("[data-delta-clear]")) {
      clearSelection();
      ctx.dom.traceDurationChart?.focus?.({ preventScroll: true });
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

  function install(context) {
    ctx = context;
    document.querySelectorAll("[data-duration-view]").forEach((button) => {
      button.addEventListener("click", () => setMode(button.getAttribute("data-duration-view")));
    });
    ctx.dom.traceDurationChart?.addEventListener("keydown", onKeydown);
    ctx.dom.traceDurationChart?.addEventListener("blur", () => { if (hm.cursor && !hm.selection) { hm.cursor = null; hm.anchor = null; drawCursor(); } hideTooltip(); });
    byId("traceDeltaPanel")?.addEventListener("click", onPanelClick);
    byId("traceDeltaPanel")?.addEventListener("change", onPanelChange);
    syncToggle();
  }

  ns.traceHeatmap = {
    install,
    active,
    setMode,
    applyParams,
    writeParams,
    onSearch,
    render,
    clearSelection: () => clearSelection(),
  };
})();
