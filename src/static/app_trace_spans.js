(() => {
  "use strict";
  // Spans mode of the trace search page, after HyperDX's row search
  // (DBSearchPage, DBRowTable, DBRowSidePanel): the same range, filters and
  // facets, one row per matching span (each span must match every filter).
  //   * /api/traces/spans pages newest-first by keyset cursor; the table is
  //     virtualised (only the rows in view are in the DOM) and loads the next
  //     page when its end scrolls into view;
  //   * attribute columns come from a column picker (remembered);
  //   * a row opens a side panel with the span (attributes with
  //     click-to-filter, events, exceptions, links) and "Open in trace";
  //   * Up / Down move through the rows, Enter opens, Escape closes.
  // app_traces.js calls install(ctx) at init and hands searches over to
  // search() while the mode is "spans".
  const ns = window.ChDash;
  if (!ns) return;

  const PAGE_SIZE = 100;
  const ROW_HEIGHT = 30;
  const OVERSCAN = 12;
  const MAX_ROWS = 10000;
  const MAX_COLUMNS = 20;
  // Pages a sparse filter may answer empty (a time budget stop) before the
  // table asks instead of searching further on its own.
  const AUTO_EMPTY_PAGES = 3;
  const COLUMNS_STORE_KEY = "chdash.traceSpanColumns.v1";
  // OTel span kinds; both spellings exporters write are sent.
  const KINDS = ["Server", "Client", "Producer", "Consumer", "Internal"];

  let ctx = null;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);

  const state = {
    mode: "traces",
    kind: "",
    minMs: "",
    maxMs: "",
    columns: readColumns(),
    base: null,
    loadedColumns: [],
    rows: [],
    cursor: null,
    hasMore: false,
    incomplete: false,
    searchedToNs: "",
    loading: false,
    error: "",
    seq: 0,
    searched: false,
    latencyMs: NaN,
    emptyPages: 0,
    maxDurationNs: 0,
    selected: -1,
    panelOpen: false,
    details: new Map(),
    detailSeq: 0,
    savedScrollTop: 0,
    window: [-1, -1],
  };

  // ------------------------------------------------------------- columns

  function splitScope(text) {
    const raw = String(text || "").trim();
    for (const scope of ["span", "resource"]) {
      if (raw.length > scope.length + 1 && raw.startsWith(`${scope}:`)) return { scope, key: raw.slice(scope.length + 1) };
    }
    return { scope: "any", key: raw };
  }

  function columnLabel(column) {
    return `${column.scope === "any" ? "" : `${column.scope}:`}${column.key}`;
  }

  function readColumns() {
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMNS_STORE_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved
        .filter((item) => item && typeof item.key === "string" && item.key && ["span", "resource", "any"].includes(item.scope))
        .slice(0, MAX_COLUMNS)
        .map((item) => ({ scope: item.scope, key: item.key }));
    } catch (_) {
      return [];
    }
  }

  function saveColumns() {
    try { localStorage.setItem(COLUMNS_STORE_KEY, JSON.stringify(state.columns)); } catch (_) { /* optional */ }
  }

  // ---------------------------------------------------------- URL state

  function active() { return state.mode === "spans"; }

  // Spans mode and its own filters as search URL parameters.
  function urlParams(params) {
    if (!active()) return;
    params.set("mode", "spans");
    if (state.kind) params.set("kind", state.kind);
    if (state.minMs) params.set("min_duration_ms", state.minMs);
    if (state.maxMs) params.set("max_duration_ms", state.maxMs);
  }

  function cleanMs(value) {
    const text = String(value == null ? "" : value).trim();
    if (!text) return "";
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? String(n) : "";
  }

  function applyParams(params) {
    const mode = params.get("mode") === "spans" || params.get("results") === "spans" ? "spans" : "traces";
    const kind = params.get("kind") || "";
    state.kind = KINDS.includes(kind) ? kind : "";
    state.minMs = cleanMs(params.get("min_duration_ms"));
    state.maxMs = cleanMs(params.get("max_duration_ms"));
    if (mode !== state.mode) {
      state.mode = mode;
      if (!active()) closePanel({ focus: false });
    }
    syncControls();
  }

  function syncControls() {
    const spans = active();
    for (const button of document.querySelectorAll("[data-results-mode]")) {
      const on = button.getAttribute("data-results-mode") === state.mode;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    document.querySelector(".traceResultsSection")?.classList.toggle("is-spanMode", spans);
    const tools = byId("traceSpanTools");
    if (tools) tools.hidden = !spans;
    const kind = byId("traceSpanKind");
    if (kind && kind.value !== state.kind) {
      kind.value = state.kind;
      kind.dispatchEvent(new Event("tracepicker-refresh"));
    }
    const duration = document.querySelector(".traceSpanTools__duration");
    if (duration) duration.hidden = ctx?.model?.meta?.features?.duration_filter === false;
    const min = byId("traceSpanMinDuration");
    const max = byId("traceSpanMaxDuration");
    if (min && document.activeElement !== min) min.value = state.minMs;
    if (max && document.activeElement !== max) max.value = state.maxMs;
    const columns = byId("traceSpanColumnsButton");
    if (columns) columns.textContent = state.columns.length ? `Columns · ${state.columns.length}` : "Columns";
  }

  function setMode(mode) {
    const next = mode === "spans" ? "spans" : "traces";
    if (next === state.mode) return;
    state.mode = next;
    if (!active()) closePanel({ focus: false });
    syncControls();
    void ctx.runSearch({ url: "push" });
  }

  // ------------------------------------------------------------ requests

  const FILTER_KEYS = ["start_ms", "end_ms", "service", "operation", "status", "service_not", "operation_not", "status_not",
    "tag", "tag_not", "tag_exists", "tag_missing"];

  function requestQuery(base, cursor) {
    const query = new URLSearchParams();
    const host = ctx.currentHost();
    if (host) query.set("host_id", host);
    for (const key of FILTER_KEYS) {
      const value = base?.[key];
      if (Array.isArray(value)) {
        for (const item of value) if (item != null && String(item) !== "") query.append(key, String(item));
      } else if (value != null && String(value) !== "") {
        query.set(key, String(value));
      }
    }
    if (state.kind) {
      query.append("kind", state.kind);
      query.append("kind", `SPAN_KIND_${state.kind.toUpperCase()}`);
    }
    if (ctx.model.meta?.features?.duration_filter !== false) {
      if (state.minMs) query.set("min_duration_ms", state.minMs);
      if (state.maxMs) query.set("max_duration_ms", state.maxMs);
    }
    query.set("limit", String(PAGE_SIZE));
    if (state.loadedColumns.length) query.set("columns", state.loadedColumns.map(columnLabel).join(","));
    if (cursor) query.set("cursor", cursor);
    return query;
  }

  function message(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // A new search (app_traces.js): the first page, replacing the rows.
  async function search(filters) {
    state.base = { ...filters };
    state.loadedColumns = state.columns.map((column) => ({ ...column }));
    state.rows = [];
    state.cursor = null;
    state.hasMore = false;
    state.incomplete = false;
    state.searchedToNs = "";
    state.error = "";
    state.emptyPages = 0;
    state.maxDurationNs = 0;
    state.selected = -1;
    state.details.clear();
    state.searched = true;
    state.latencyMs = NaN;
    closePanel({ focus: false });
    if (ctx.dom.tracesSearchView) ctx.dom.tracesSearchView.scrollTop = 0;
    await loadPage({ first: true });
  }

  async function loadPage({ first = false } = {}) {
    if (!state.base) return;
    const seq = first ? ++state.seq : state.seq;
    if (!first && (state.loading || !state.cursor)) return;
    state.loading = true;
    state.error = "";
    render();
    const started = performance.now();
    let payload = null;
    try {
      payload = await ctx.api.getJson(`api/traces/spans?${requestQuery(state.base, first ? "" : state.cursor).toString()}`);
    } catch (error) {
      if (seq !== state.seq) return;
      state.loading = false;
      state.error = message(error);
      render();
      return;
    }
    if (seq !== state.seq) return;
    if (first) state.latencyMs = performance.now() - started;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    ctx.registerServiceColors(rows.map((row) => row.service_name));
    for (const row of rows) {
      row.duration_ns = Number(row.duration_ns || 0);
      if (row.duration_ns > state.maxDurationNs) state.maxDurationNs = row.duration_ns;
      state.rows.push(row);
    }
    if (state.rows.length > MAX_ROWS) state.rows.length = MAX_ROWS;
    state.cursor = payload?.has_more && state.rows.length < MAX_ROWS ? String(payload.cursor || "") : null;
    state.hasMore = !!state.cursor;
    state.incomplete = payload?.incomplete === true;
    state.searchedToNs = String(payload?.searched_to_ns || "");
    state.emptyPages = rows.length ? 0 : state.emptyPages + 1;
    state.loading = false;
    render();
  }

  // ----------------------------------------------------------- rendering

  const timeFormat = new Intl.DateTimeFormat([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

  // "Sep 19, 12:59:59.999" in local time from the exact UTC text.
  function localTime(row) {
    if (row._time) return row._time;
    const parts = String(row.timestamp || "").match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    if (!parts) return (row._time = String(row.timestamp || ""));
    const fraction = (parts[3] || "").padEnd(9, "0");
    const ms = Date.parse(`${parts[1]}T${parts[2]}.${fraction.slice(0, 3)}Z`);
    row._time = Number.isFinite(ms) ? `${timeFormat.format(new Date(ms))}.${fraction.slice(0, 3)}` : String(row.timestamp);
    return row._time;
  }

  function nsDate(nsText) {
    const ns = Number(nsText);
    return Number.isFinite(ns) && ns > 0 ? new Date(Math.floor(ns / 1e6)) : null;
  }

  function gridTemplate(count) {
    return ["minmax(118px, 0.9fr)", "minmax(96px, 0.85fr)", "minmax(120px, 1.5fr)", "minmax(112px, 1fr)", "62px", "84px"]
      .concat(Array.from({ length: count }, () => "minmax(72px, 0.8fr)"))
      .join(" ");
  }

  function headHtml() {
    const cells = ["Time", "Service", "Operation", "Duration", "Status", "Kind"]
      .map((label, index) => `<span class="traceSpanTable__th traceSpanTable__th--${index}" role="columnheader">${label}</span>`);
    for (const column of state.loadedColumns) {
      cells.push(`<span class="traceSpanTable__th traceSpanTable__th--attr" role="columnheader" title="${esc(`${column.scope === "resource" ? "Resource" : column.scope === "span" ? "Span" : "Span or resource"} attribute ${column.key}`)}">${esc(column.key)}</span>`);
    }
    return cells.join("");
  }

  function filterValueHtml(field, value, text, extra = "") {
    return `<span class="traceFilterable traceSpanListRow__value" data-filter-field="${field}" data-filter-value="${esc(value)}"${extra} role="button" tabindex="-1" aria-haspopup="menu" title="${esc(text)} (click to filter)">${esc(text)}</span>`;
  }

  function statusHtml(status) {
    const code = String(status || "Unset");
    const lower = code.toLowerCase();
    if (lower === "error") return `<span class="traceStatus traceStatus--error traceFilterable" data-filter-field="status" data-filter-value="${esc(code)}" role="button" tabindex="-1" aria-haspopup="menu" title="Status (click to filter)">Error</span>`;
    return `<span class="traceSpanListRow__status traceSpanListRow__status--${esc(lower)} traceFilterable" data-filter-field="status" data-filter-value="${esc(code)}" role="button" tabindex="-1" aria-haspopup="menu" title="Status (click to filter)">${esc(lower === "ok" ? "OK" : code)}</span>`;
  }

  function rowHtml(row, index) {
    const selected = index === state.selected;
    const percent = state.maxDurationNs > 0 ? Math.max(0.5, Math.min(100, (row.duration_ns / state.maxDurationNs) * 100)) : 0;
    const error = String(row.status_code || "").toLowerCase() === "error";
    const duration = ctx.formatDuration(row.duration_ns);
    const attrs = state.loadedColumns.map((column, i) => {
      const value = Array.isArray(row.attributes) ? row.attributes[i] : null;
      if (value == null) return '<span class="traceSpanListRow__cell traceSpanListRow__cell--attr is-missing" role="gridcell">—</span>';
      const scope = column.scope === "any" ? "any" : column.scope;
      return `<span class="traceSpanListRow__cell traceSpanListRow__cell--attr" role="gridcell">${filterValueHtml("tag", value, value === "" ? '""' : value, ` data-filter-scope="${esc(scope)}" data-filter-key="${esc(column.key)}"`)}</span>`;
    }).join("");
    return `<div class="traceSpanListRow${selected ? " is-selected" : ""}${error ? " is-error" : ""}" role="row" id="traceSpanListRow-${index}" data-span-index="${index}" aria-rowindex="${index + 2}" aria-selected="${selected ? "true" : "false"}" style="top:${index * ROW_HEIGHT}px;--trace-service-color:${ctx.serviceColor(row.service_name)}">`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--time" role="gridcell" title="${esc(`${row.timestamp} UTC`)}">${esc(localTime(row))}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--service" role="gridcell"><i class="traceSpanListRow__dot" aria-hidden="true"></i>${filterValueHtml("service", row.service_name || "", row.service_name || "unknown")}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--operation" role="gridcell">${filterValueHtml("operation", row.span_name || "", row.span_name || "span")}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--duration" role="gridcell" title="${esc(duration)}"><span class="traceSpanListRow__bar" aria-hidden="true"><i style="width:${percent.toFixed(2)}%"></i></span><span class="traceSpanListRow__durationText">${esc(duration)}</span></span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--status" role="gridcell">${statusHtml(row.status_code)}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--kind" role="gridcell">${esc(ctx.spanKindLabel(row.span_kind))}</span>`
      + attrs
      + "</div>";
  }

  function footHtml() {
    const tr = ns.timeRange;
    const searchedTo = nsDate(state.searchedToNs);
    const when = searchedTo ? (tr ? tr.formatDateTime(searchedTo.getTime()) : searchedTo.toISOString()) : "";
    if (state.error) {
      return `<div class="traceSpanTable__foot is-error" role="alert"><span>${esc(state.error)}</span><button type="button" class="button button--small" data-span-retry>Retry</button></div>`;
    }
    if (state.loading) {
      return `<div class="traceSpanTable__foot" role="status"><span class="traceSpanTable__spinner" aria-hidden="true"></span><span>${state.rows.length ? "Loading more spans…" : "Searching spans…"}</span></div>`;
    }
    if (state.hasMore) {
      const asked = state.emptyPages >= AUTO_EMPTY_PAGES;
      const note = state.incomplete && when ? `Searched back to ${esc(when)}.` : "More spans available.";
      return `<div class="traceSpanTable__foot" data-span-more-available><span>${note}</span><button type="button" class="button button--small" data-span-load-more>${asked || state.incomplete ? "Keep searching" : "Load more"}</button></div>`;
    }
    if (!state.rows.length) return "";
    const capped = state.rows.length >= MAX_ROWS ? ` The table keeps the newest ${MAX_ROWS.toLocaleString()} spans: narrow the range or filters for older ones.` : "";
    return `<div class="traceSpanTable__foot is-end" data-span-end>End of results · ${state.rows.length.toLocaleString()} span${state.rows.length === 1 ? "" : "s"}.${esc(capped)}</div>`;
  }

  function emptyHtml() {
    const range = state.base ? { start: Number(state.base.start_ms), end: Number(state.base.end_ms) } : null;
    const tr = ns.timeRange;
    const when = range && tr ? `between ${tr.formatDateTime(range.start)} and ${tr.formatDateTime(range.end)}` : "in this range";
    const zoom = ctx.dom.tracesRangeZoomOut;
    const canZoom = !!zoom && !zoom.disabled;
    return `<div class="tracesEmpty tracesEmpty--search" data-empty-results data-span-empty>
        <strong>No spans found</strong>
        <span>No spans match these filters ${esc(when)}.</span>
        ${canZoom ? '<button type="button" class="button button--small tracesEmpty__zoom" data-results-zoom-out><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M5 7h4M10.2 10.2 13.5 13.5"/></svg><span>Zoom out</span></button>' : ""}
      </div>`;
  }

  function renderCount() {
    const count = byId("tracesResultCount");
    if (!count) return;
    if (!state.searched) { count.textContent = "0 Spans"; return; }
    const n = state.rows.length;
    const latency = Number.isFinite(state.latencyMs)
      ? ` <span class="tracesResultCount__latency" title="First page request time, measured in the browser">(in ${esc(ctx.formatDuration(state.latencyMs * 1e6))})</span>`
      : "";
    const more = state.hasMore ? ' <span class="tracesResultCount__more" title="Scroll to load older spans">· more available</span>' : "";
    count.innerHTML = `${n.toLocaleString()}${state.hasMore ? "+" : ""} Span${n === 1 ? "" : "s"}${latency}${more}`;
  }

  // The results area: the table shell (header, sized body, footer); the
  // rows in view are drawn by updateWindow().
  function render() {
    if (!active() || !ctx) return;
    syncControls();
    renderCount();
    const root = ctx.dom.tracesResults;
    if (!root) return;
    root.classList.add("tracesResults--spans");
    if (!state.searched) {
      root.innerHTML = '<div class="tracesEmpty">Search to load spans.</div>';
      return;
    }
    if (!state.rows.length && !state.loading && !state.hasMore && !state.error) {
      root.innerHTML = emptyHtml();
      return;
    }
    let table = byId("traceSpanTable");
    const columnsKey = state.loadedColumns.map(columnLabel).join("\x1f");
    if (!table || table.dataset.columns !== columnsKey || !root.contains(table)) {
      root.innerHTML = `<div id="traceSpanTable" class="traceSpanTable" role="grid" tabindex="0" aria-label="Matching spans" aria-colcount="${6 + state.loadedColumns.length}">
          <div class="traceSpanTable__head" role="row" aria-rowindex="1">${headHtml()}</div>
          <div class="traceSpanTable__body" role="rowgroup"></div>
        </div><div class="traceSpanTable__footWrap"></div>`;
      table = byId("traceSpanTable");
      table.dataset.columns = columnsKey;
      table.style.setProperty("--trace-span-grid", gridTemplate(state.loadedColumns.length));
    }
    table.setAttribute("aria-rowcount", String(state.rows.length + 1));
    table.style.setProperty("--trace-span-sticky-top", `${stickyTop()}px`);
    const body = table.querySelector(".traceSpanTable__body");
    if (body) body.style.height = `${state.rows.length * ROW_HEIGHT}px`;
    const foot = root.querySelector(".traceSpanTable__footWrap");
    if (foot) foot.innerHTML = footHtml();
    updateWindow(true);
  }

  // The sticky search bar's height: the table header sticks below it.
  function stickyTop() {
    const bar = ctx.dom.tracesForm;
    return bar ? Math.round(bar.getBoundingClientRect().height) : 0;
  }

  function updateWindow(force = false) {
    const table = byId("traceSpanTable");
    const body = table?.querySelector(".traceSpanTable__body");
    const view = ctx.dom.tracesSearchView;
    if (!body || !view || view.hidden) return;
    const offset = body.getBoundingClientRect().top - view.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-offset / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(state.rows.length, Math.ceil((view.clientHeight - offset) / ROW_HEIGHT) + OVERSCAN);
    if (!force && first === state.window[0] && last === state.window[1]) return;
    state.window = [first, last];
    let html = "";
    for (let i = first; i < last; i += 1) html += rowHtml(state.rows[i], i);
    body.innerHTML = html;
    if (state.selected >= 0) table.setAttribute("aria-activedescendant", `traceSpanListRow-${state.selected}`);
    else table.removeAttribute("aria-activedescendant");
    maybeLoadMore(last);
  }

  // Infinite scroll: the next page once the last rows are in view (a run of
  // empty, budget-stopped pages waits for "Keep searching").
  function maybeLoadMore(last) {
    if (!state.hasMore || state.loading || state.error || state.emptyPages >= AUTO_EMPTY_PAGES) return;
    if (last >= state.rows.length - Math.floor(OVERSCAN / 2)) void loadPage();
  }

  let scrollFrame = 0;
  function onScroll() {
    if (!active() || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateWindow();
    });
  }

  // --------------------------------------------------------- selection

  function rowTopInView(index) {
    const view = ctx.dom.tracesSearchView;
    const body = byId("traceSpanTable")?.querySelector(".traceSpanTable__body");
    if (!view || !body) return null;
    return body.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop + index * ROW_HEIGHT;
  }

  function ensureVisible(index) {
    const view = ctx.dom.tracesSearchView;
    const top = rowTopInView(index);
    if (!view || top == null) return;
    const head = byId("traceSpanTable")?.querySelector(".traceSpanTable__head");
    const topLimit = view.scrollTop + stickyTop() + (head ? head.getBoundingClientRect().height : 0);
    const bottomLimit = view.scrollTop + view.clientHeight;
    if (top < topLimit) view.scrollTop = Math.max(0, top - stickyTop() - (head ? head.getBoundingClientRect().height : 0) - ROW_HEIGHT);
    else if (top + ROW_HEIGHT > bottomLimit) view.scrollTop = top + ROW_HEIGHT * 2 - view.clientHeight;
  }

  function select(index, { open = false } = {}) {
    if (!state.rows.length) return;
    const next = Math.max(0, Math.min(state.rows.length - 1, index));
    state.selected = next;
    ensureVisible(next);
    updateWindow(true);
    if (open || state.panelOpen) openPanel(next);
  }

  function onTableClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-span-retry]")) {
      state.error = "";
      if (state.rows.length) void loadPage(); else void loadPage({ first: true });
      return;
    }
    if (target.closest("[data-span-load-more]")) {
      state.emptyPages = 0;
      void loadPage();
      return;
    }
    // (Zoom out: the results' own click handler in app_traces.js.)
    const row = target.closest("[data-span-index]");
    if (!row) return;
    const index = Number(row.getAttribute("data-span-index"));
    byId("traceSpanTable")?.focus({ preventScroll: true });
    select(index, { open: true });
  }

  function onTableKeydown(event) {
    const table = byId("traceSpanTable");
    if (!table || event.target !== table || !state.rows.length) return;
    const page = Math.max(1, Math.floor((ctx.dom.tracesSearchView?.clientHeight || 600) / ROW_HEIGHT) - 3);
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (event.key in moves) {
      event.preventDefault();
      select(state.selected < 0 ? 0 : state.selected + moves[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(0);
    } else if (event.key === "End") {
      event.preventDefault();
      select(state.rows.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(state.selected < 0 ? 0 : state.selected, { open: true });
    } else if (event.key === "Escape" && state.panelOpen) {
      event.preventDefault();
      closePanel();
    }
  }

  // ----------------------------------------------------------- side panel

  function panelEl() {
    let panel = byId("traceSpanPanel");
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.id = "traceSpanPanel";
    panel.className = "traceSpanPanel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel.setAttribute("aria-labelledby", "traceSpanPanelTitle");
    panel.hidden = true;
    panel.addEventListener("click", onPanelClick);
    panel.addEventListener("keydown", onPanelKeydown);
    (ctx.dom.tracesSearchView || document.body).appendChild(panel);
    return panel;
  }

  function detailKey(row) {
    return `${row.start_ns}\x1f${row.trace_id}\x1f${row.span_id}`;
  }

  function openPanel(index) {
    const row = state.rows[index];
    if (!row) return;
    state.panelOpen = true;
    const panel = panelEl();
    // Below the sticky search bar, which stays usable while the panel is open.
    const bar = ctx.dom.tracesForm || document.querySelector(".appHeader");
    panel.style.setProperty("--trace-span-panel-top", `${Math.max(0, Math.round(bar ? bar.getBoundingClientRect().bottom : 0))}px`);
    panel.hidden = false;
    panel.dataset.spanIndex = String(index);
    renderPanel(row);
    const key = detailKey(row);
    const cached = state.details.get(key);
    if (cached && cached.status !== "error") return;
    const entry = { status: "loading", span: null, error: "" };
    state.details.set(key, entry);
    const seq = ++state.detailSeq;
    const query = new URLSearchParams({ trace_id: row.trace_id, span_id: row.span_id, timestamp_ns: row.start_ns });
    const host = ctx.currentHost();
    if (host) query.set("host_id", host);
    ctx.api.getJson(`api/traces/span?${query.toString()}`).then((payload) => {
      entry.status = "ready";
      entry.span = payload?.span || null;
    }).catch((error) => {
      entry.status = "error";
      entry.error = message(error);
    }).finally(() => {
      if (seq !== state.detailSeq || !state.panelOpen) return;
      const current = state.rows[Number(panelEl().dataset.spanIndex)];
      if (current && detailKey(current) === key) renderPanel(current);
    });
  }

  function closePanel({ focus = true } = {}) {
    const panel = byId("traceSpanPanel");
    state.panelOpen = false;
    ++state.detailSeq;
    if (panel && !panel.hidden) {
      panel.hidden = true;
      if (focus) byId("traceSpanTable")?.focus({ preventScroll: true });
    }
  }

  function copyButton(value, label) {
    return `<button type="button" class="traceCopyButton" data-span-copy="${esc(value)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}"><span class="editorCopyButton__icon" aria-hidden="true"></span></button>`;
  }

  function eventsHtml(span, startNs) {
    const events = ctx.spanEventList(span);
    if (!events.length) return "";
    const items = events.map((event) => ctx.eventItemHtml(event, startNs, { open: events.length <= 3 })).join("");
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanEvents" data-span-section="events" open><summary><b>Events</b><span class="traceJaegerGroup__count">(${events.length})</span></summary><div class="traceJaegerGroup__body"><div class="traceSpanEvents__list">${items}</div><small class="traceSpanEvents__note">Event times are relative to the start of this span.</small></div></details>`;
  }

  function linksHtml(span) {
    const links = ctx.spanLinkList(span);
    if (!links.length) return "";
    const items = links.map((link) => {
      const href = ctx.spanTraceUrl(link.traceId, link.spanId);
      const attrs = ctx.attributeEntries(link.attributes).length ? `<div class="traceSpanRefs__attrs">${ctx.renderAttributeTable(link.attributes, "")}</div>` : "";
      return `<li class="traceSpanRefs__item"><span class="traceSpanRefs__kind traceSpanRefs__kind--follows-from">follows from</span><span class="traceSpanRefs__main"><small class="traceSpanRefs__ids"><span>TraceID: <code>${esc(link.traceId)}</code></span><span>SpanID: <code>${esc(link.spanId)}</code></span></small></span><a class="traceSpanRefs__open" href="${esc(href)}" data-span-open-link="${esc(link.traceId)}" data-span-open-link-span="${esc(link.spanId)}">Open linked trace</a>${attrs}</li>`;
    }).join("");
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanRefs" data-span-section="references"><summary><b>Links</b><span class="traceJaegerGroup__count">(${links.length})</span></summary><div class="traceJaegerGroup__body"><ul class="traceSpanRefs__list">${items}</ul></div></details>`;
  }

  function panelBodyHtml(row, entry) {
    const span = entry?.span ? { ...row, ...entry.span } : row;
    const startNs = Number(row.start_ns);
    const status = String(span.status_code || "Unset");
    const statusMessage = String(span.status_message || "").trim();
    const summary = [
      ["Start", `<span title="${esc(`${row.timestamp} UTC`)}">${esc(ctx.absoluteTimeText(startNs, row.timestamp, { withRaw: false }))}</span>`],
      ["Duration", `<b>${esc(ctx.formatDuration(span.duration_ns))}</b>`],
      ["Kind", esc(ctx.spanKindLabel(span.span_kind))],
      ["Status", statusHtml(status)],
      ["Trace ID", `<code>${esc(row.trace_id)}</code>${copyButton(row.trace_id, "Trace ID")}`],
      ["Span ID", `<code>${esc(row.span_id)}</code>${copyButton(row.span_id, "Span ID")}`],
      ["Parent", row.parent_span_id ? `<code>${esc(row.parent_span_id)}</code>` : "<code>root</code>"],
    ].map(([label, value]) => `<div class="traceSpanPanel__fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("");
    let details = "";
    if (!entry || entry.status === "loading") {
      details = '<div class="traceSpanPanel__status" role="status">Loading span details…</div>';
    } else if (entry.status === "error") {
      details = `<div class="traceSpanPanel__status is-error" role="alert">${esc(entry.error)} <button type="button" class="button button--small" data-span-panel-retry>Retry</button></div>`;
    } else if (!entry.span) {
      details = '<div class="traceSpanPanel__status">The span is no longer available.</div>';
    } else {
      details = `${ns.traceInsights?.exceptionSectionHtml?.(span, { start: startNs }) || ""}
        ${ctx.renderJaegerAttributes("Tags", span.span_attributes, { open: true, filterScope: "span" })}
        ${ctx.attributeEntries(span.resource_attributes).length ? ctx.renderJaegerAttributes("Process", span.resource_attributes, { open: true, filterScope: "resource" }) : ""}
        ${eventsHtml(span, startNs)}
        ${linksHtml(span)}`;
    }
    return `<dl class="traceSpanPanel__facts">${summary}</dl>
      ${statusMessage ? `<div class="traceInspectorStatusMessage"><b>Status message</b><span>${esc(statusMessage)}</span></div>` : ""}
      <div class="traceInspector traceInspector--jaeger traceSpanPanel__card" data-inspector-span="${esc(row.span_id)}">${details}</div>`;
  }

  function renderPanel(row) {
    const panel = panelEl();
    const index = Number(panel.dataset.spanIndex);
    const entry = state.details.get(detailKey(row));
    const href = ctx.spanTraceUrl(row.trace_id, row.span_id);
    // A re-render keeps the focus on the same panel control.
    const focusedNav = panel.contains(document.activeElement) ? document.activeElement?.getAttribute?.("data-span-panel-nav") : "";
    panel.style.setProperty("--trace-service-color", ctx.serviceColor(row.service_name));
    panel.innerHTML = `<header class="traceSpanPanel__head">
        <div class="traceSpanPanel__title">
          <span class="traceSpanPanel__service"><i class="traceSpanListRow__dot" aria-hidden="true"></i>${filterValueHtml("service", row.service_name || "", row.service_name || "unknown")}</span>
          <strong id="traceSpanPanelTitle">${filterValueHtml("operation", row.span_name || "", row.span_name || "span")}</strong>
        </div>
        <div class="traceSpanPanel__actions">
          <span class="traceSpanPanel__position">${index + 1} / ${state.rows.length.toLocaleString()}${state.hasMore ? "+" : ""}</span>
          <button type="button" class="traceSpanPanel__nav" data-span-panel-nav="prev" aria-label="Previous span" title="Previous span (↑)"${index <= 0 ? " disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10 8 5.5l4.5 4.5"/></svg></button>
          <button type="button" class="traceSpanPanel__nav" data-span-panel-nav="next" aria-label="Next span" title="Next span (↓)"${index >= state.rows.length - 1 ? " disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg></button>
          <a class="button button--primary button--small traceSpanPanel__open" href="${esc(href)}" data-span-open-trace>Open in trace</a>
          <button type="button" class="traceSpanPanel__close" data-span-panel-close aria-label="Close span details" title="Close (Esc)">×</button>
        </div>
      </header>
      <div class="traceSpanPanel__body">${panelBodyHtml(row, entry)}</div>`;
    if (focusedNav) {
      const nav = panel.querySelector(`[data-span-panel-nav="${focusedNav}"]`);
      (nav && !nav.disabled ? nav : panel.querySelector("[data-span-panel-close]"))?.focus({ preventScroll: true });
    }
  }

  function openInTrace(row) {
    const view = ctx.dom.tracesSearchView;
    state.savedScrollTop = view ? view.scrollTop : 0;
    ctx.model.pendingSpanId = String(row.span_id || "");
    void ctx.loadTrace(String(row.trace_id || ""), { push: true });
  }

  function onPanelClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const index = Number(panelEl().dataset.spanIndex);
    const row = state.rows[index];
    if (target.closest("[data-span-panel-close]")) { closePanel(); return; }
    const nav = target.closest("[data-span-panel-nav]");
    if (nav) { select(index + (nav.getAttribute("data-span-panel-nav") === "next" ? 1 : -1), { open: true }); return; }
    const open = target.closest("[data-span-open-trace]");
    if (open && row) {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) return;
      event.preventDefault();
      openInTrace(row);
      return;
    }
    const link = target.closest("[data-span-open-link]");
    if (link) {
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      const view = ctx.dom.tracesSearchView;
      state.savedScrollTop = view ? view.scrollTop : 0;
      ctx.model.pendingSpanId = String(link.getAttribute("data-span-open-link-span") || "");
      void ctx.loadTrace(String(link.getAttribute("data-span-open-link") || ""), { push: true });
      return;
    }
    const copy = target.closest("[data-span-copy]");
    if (copy) { event.preventDefault(); ctx.copyText(copy.getAttribute("data-span-copy") || "", copy); return; }
    if (target.closest("[data-span-panel-retry]") && row) {
      state.details.delete(detailKey(row));
      openPanel(index);
      return;
    }
    // Attribute copy buttons, "show more" events and exception stacks.
    ctx.spanDetailClick(event);
  }

  function onPanelKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  }

  function editable(element) {
    return !!element?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=menu], [role=listbox], [role=dialog]:not(#traceSpanPanel)");
  }

  // Up / Down walk the rows while the panel is open (focus in the panel or
  // on the page, not in a field or a menu).
  function onDocumentKeydown(event) {
    if (!active() || !state.panelOpen || ctx.dom.tracesSearchView?.hidden) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === byId("traceSpanTable") || editable(target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = Number(panelEl().dataset.spanIndex);
      select(index + (event.key === "ArrowDown" ? 1 : -1), { open: true });
    }
  }

  // ------------------------------------------------------- column picker

  let columnsMenu = null;

  function closeColumns() {
    if (!columnsMenu || columnsMenu.hidden) return;
    columnsMenu.hidden = true;
    byId("traceSpanColumnsButton")?.setAttribute("aria-expanded", "false");
  }

  function columnSuggestions() {
    const keys = ns.traceSearch?.facetKeys?.() || [];
    const taken = new Set(state.columns.map(columnLabel));
    return keys.map((item) => columnLabel({ scope: item.scope, key: item.key })).filter((label) => !taken.has(label)).slice(0, 200);
  }

  function renderColumns() {
    if (!columnsMenu) return;
    const list = state.columns.length
      ? state.columns.map((column, index) => `<li class="traceSpanColumns__item"><span class="traceSpanColumns__scope">${esc(column.scope === "any" ? "any" : column.scope)}</span><span class="traceSpanColumns__key" title="${esc(column.key)}">${esc(column.key)}</span><button type="button" class="traceSpanColumns__move" data-column-move="${index}" data-dir="-1" aria-label="Move ${esc(column.key)} left" title="Move left"${index === 0 ? " disabled" : ""}>←</button><button type="button" class="traceSpanColumns__move" data-column-move="${index}" data-dir="1" aria-label="Move ${esc(column.key)} right" title="Move right"${index === state.columns.length - 1 ? " disabled" : ""}>→</button><button type="button" class="traceSpanColumns__remove" data-column-remove="${index}" aria-label="Remove column ${esc(column.key)}" title="Remove column">×</button></li>`).join("")
      : '<li class="traceSpanColumns__empty">No attribute columns yet.</li>';
    const options = columnSuggestions().map((label) => `<option value="${esc(label)}"></option>`).join("");
    columnsMenu.innerHTML = `<div class="traceSpanColumns__title">Attribute columns</div>
      <ul class="traceSpanColumns__list">${list}</ul>
      <form class="traceSpanColumns__add" data-column-add>
        <input id="traceSpanColumnInput" type="text" list="traceSpanColumnKeys" placeholder="span:http.route or resource:host.name" aria-label="Attribute column to add" autocomplete="off" spellcheck="false"${state.columns.length >= MAX_COLUMNS ? " disabled" : ""}>
        <datalist id="traceSpanColumnKeys">${options}</datalist>
        <button type="submit" class="button button--small"${state.columns.length >= MAX_COLUMNS ? " disabled" : ""}>Add</button>
      </form>
      <small class="traceSpanColumns__note">Prefix span: or resource: to read one attribute map; columns are kept in this browser.</small>`;
  }

  function openColumns() {
    const button = byId("traceSpanColumnsButton");
    if (!button) return;
    if (!columnsMenu) {
      columnsMenu = document.createElement("div");
      columnsMenu.id = "traceSpanColumnsMenu";
      columnsMenu.className = "traceSpanColumns";
      columnsMenu.setAttribute("role", "dialog");
      columnsMenu.setAttribute("aria-label", "Span table columns");
      columnsMenu.hidden = true;
      columnsMenu.addEventListener("click", onColumnsClick);
      columnsMenu.addEventListener("submit", onColumnsSubmit);
      columnsMenu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closeColumns(); button.focus({ preventScroll: true }); }
      });
      document.body.appendChild(columnsMenu);
    }
    renderColumns();
    columnsMenu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const box = button.getBoundingClientRect();
    const width = columnsMenu.getBoundingClientRect().width;
    columnsMenu.style.left = `${Math.round(Math.max(8, Math.min(window.innerWidth - width - 8, box.right - width)))}px`;
    columnsMenu.style.top = `${Math.round(box.bottom + 4)}px`;
    byId("traceSpanColumnInput")?.focus({ preventScroll: true });
  }

  function columnsChanged() {
    saveColumns();
    syncControls();
    renderColumns();
    if (active() && state.base) void search(state.base);
  }

  function onColumnsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const remove = target.closest("[data-column-remove]");
    const move = target.closest("[data-column-move]");
    if (remove) {
      state.columns.splice(Number(remove.getAttribute("data-column-remove")), 1);
      columnsChanged();
    } else if (move) {
      const index = Number(move.getAttribute("data-column-move"));
      const to = index + Number(move.getAttribute("data-dir"));
      if (to < 0 || to >= state.columns.length) return;
      const [column] = state.columns.splice(index, 1);
      state.columns.splice(to, 0, column);
      columnsChanged();
    }
  }

  function onColumnsSubmit(event) {
    event.preventDefault();
    const input = byId("traceSpanColumnInput");
    const column = splitScope(input?.value || "");
    if (!column.key || state.columns.length >= MAX_COLUMNS) return;
    if (!state.columns.some((other) => other.scope === column.scope && other.key === column.key)) state.columns.push(column);
    columnsChanged();
    byId("traceSpanColumnInput")?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------- span tools

  function onToolsChange(event) {
    const target = event.target;
    if (target?.id === "traceSpanKind") {
      state.kind = KINDS.includes(target.value) ? target.value : "";
      void ctx.runSearch({ url: "push" });
    }
  }

  function commitDuration(input) {
    const value = cleanMs(input.value);
    const key = input.id === "traceSpanMinDuration" ? "minMs" : "maxMs";
    input.value = value;
    if (value === state[key]) return;
    state[key] = value;
    void ctx.runSearch({ url: "push" });
  }

  // ---------------------------------------------------------------- hooks

  // The search view is back (Back from a trace): same rows, scroll and
  // selection as when the trace was opened.
  function onShown() {
    if (!active()) return;
    const view = ctx.dom.tracesSearchView;
    requestAnimationFrame(() => {
      if (view && state.savedScrollTop) view.scrollTop = state.savedScrollTop;
      render();
      if (state.panelOpen && state.selected >= 0) panelEl().querySelector("[data-span-open-trace]")?.focus({ preventScroll: true });
      else byId("traceSpanTable")?.focus({ preventScroll: true });
    });
  }

  function install(context) {
    ctx = context;
    for (const button of document.querySelectorAll("[data-results-mode]")) {
      button.addEventListener("click", () => setMode(button.getAttribute("data-results-mode")));
    }
    const root = ctx.dom.tracesResults;
    root?.addEventListener("click", (event) => { if (active()) onTableClick(event); });
    root?.addEventListener("keydown", (event) => { if (active()) onTableKeydown(event); });
    ctx.dom.tracesSearchView?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    document.addEventListener("keydown", onDocumentKeydown);
    const tools = byId("traceSpanTools");
    const kind = byId("traceSpanKind");
    if (kind) ctx.enhanceTraceSelect(kind);
    tools?.addEventListener("change", onToolsChange);
    for (const input of [byId("traceSpanMinDuration"), byId("traceSpanMaxDuration")]) {
      input?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commitDuration(input); } });
      input?.addEventListener("blur", () => commitDuration(input));
    }
    byId("traceSpanColumnsButton")?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (columnsMenu && !columnsMenu.hidden) closeColumns(); else openColumns();
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (columnsMenu && !columnsMenu.hidden && target && !columnsMenu.contains(target) && !target.closest("#traceSpanColumnsButton")) closeColumns();
    });
    syncControls();
  }

  ns.traceSpans = {
    install,
    active,
    search,
    render,
    urlParams,
    applyParams,
    onShown,
    hasResults: () => state.searched && !!state.base,
    leave: () => { ctx?.dom?.tracesResults?.classList.remove("tracesResults--spans"); closeColumns(); },
  };
})();
