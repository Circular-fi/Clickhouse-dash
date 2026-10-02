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
  const fmt = ns.format;
  const palette = ns.palette;

  const PAGE_SIZE = 100;
  const ROW_HEIGHT = 30;
  const OVERSCAN = 12;
  const MAX_ROWS = 10000;
  const MAX_COLUMNS = 20;
  // Pages a sparse filter may answer empty (a time budget stop) before the
  // table asks instead of searching further on its own.
  const AUTO_EMPTY_PAGES = 3;
  const columnsPref = () => ns.storage.pref(ns.storage.KEYS.traceSpanColumns, []);
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
    // The first page's request (util.latest): later pages share it, so a new search drops them all.
    req: null,
    searched: false,
    latencyMs: NaN,
    emptyPages: 0,
    maxDurationNs: 0,
    selected: -1,
    panelOpen: false,
    // span= of a link or a reload, opened once its row is listed.
    pendingSpan: "",
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
    const saved = columnsPref().get();
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((item) => item && typeof item.key === "string" && item.key && ["span", "resource", "any"].includes(item.scope))
      .slice(0, MAX_COLUMNS)
      .map((item) => ({ scope: item.scope, key: item.key }));
  }

  function saveColumns() {
    columnsPref().set(state.columns);
  }

  // ---------------------------------------------------------- URL state

  function active() { return state.mode === "spans"; }

  // Spans mode and its own filters as search URL parameters.
  function urlParams(params) {
    if (!active()) return;
    params.set("mode", "spans");
    if (state.kind) params.set("kind", state.kind);
    // span_* in the URL: min/max_duration_ms there are trace durations.
    if (state.minMs) params.set("span_min_duration_ms", state.minMs);
    if (state.maxMs) params.set("span_max_duration_ms", state.maxMs);
    // The span in the side panel (ns.detailPanel): span=<span id>.
    const open = state.panelOpen ? state.rows[state.selected] : null;
    const span = open ? String(open.span_id || "") : state.pendingSpan;
    if (span) params.set("span", span);
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
    state.minMs = cleanMs(params.get("span_min_duration_ms"));
    state.maxMs = cleanMs(params.get("span_max_duration_ms"));
    if (mode !== state.mode) {
      state.mode = mode;
      if (!active()) closePanel({ focus: false, url: "none" });
    }
    syncControls();
    // On a trace URL span= is the trace's span, not this panel's.
    if (!onTracePath()) syncPanelFromUrl(mode === "spans" ? params.get("span") || "" : "");
  }

  function onTracePath() {
    return /\/observability\/traces\/[^/]+/.test(window.location.pathname);
  }

  // span= of the URL (Back / Forward, a link, a reload): the panel shows
  // that span when it is listed and closes when there is none.
  function syncPanelFromUrl(span) {
    if (!span) {
      state.pendingSpan = "";
      if (state.panelOpen) closePanel({ focus: false, url: "none" });
      return;
    }
    const open = state.panelOpen ? state.rows[state.selected] : null;
    if (open && String(open.span_id) === span) return;
    const index = state.rows.findIndex((row) => String(row.span_id) === span);
    if (index >= 0) {
      state.pendingSpan = "";
      select(index, { open: true, url: "none" });
    } else {
      state.pendingSpan = span;
    }
  }

  function syncControls() {
    const spans = active();
    ns.segmented?.set(document.querySelector(".traceModeToggle"), state.mode, "resultsMode");
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
    closePanel({ focus: false, url: "none" });
    if (ctx.dom.tracesSearchView) ctx.dom.tracesSearchView.scrollTop = 0;
    await loadPage({ first: true });
  }

  async function loadPage({ first = false } = {}) {
    if (!state.base) return;
    if (!first && (state.loading || !state.cursor || !state.req)) return;
    const req = first ? ns.util.latest("traces.spans") : state.req;
    state.req = req;
    state.loading = true;
    state.error = "";
    render();
    const started = performance.now();
    let payload = null;
    try {
      payload = await ctx.api.getJson(`api/traces/spans?${requestQuery(state.base, first ? "" : state.cursor).toString()}`, { signal: req.signal });
    } catch (error) {
      if (!req.isCurrent()) return;
      state.loading = false;
      state.error = message(error);
      render();
      return;
    }
    if (!req.isCurrent()) return;
    if (first) state.latencyMs = performance.now() - started;
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    palette.registerServices(rows.map((row) => row.service_name));
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
    if (first && state.pendingSpan) {
      const span = state.pendingSpan;
      const index = state.rows.findIndex((row) => String(row.span_id) === span);
      state.pendingSpan = "";
      if (index >= 0) select(index, { open: true, url: "none" });
      else ns.traceSearch?.writeUrl?.("replace");
    }
  }

  // ----------------------------------------------------------- rendering

  // "Sep 19 12:59:59.999" in local time from the exact UTC text, and its
  // tooltip (fmt.timeTitle, to the nanosecond): computed once per row.
  function localTime(row) {
    if (row._time == null) row._time = ctx.absoluteTimeText(Number(row.start_ns), row.timestamp, { withRaw: false });
    return row._time;
  }

  function timeTitle(row) {
    if (row._timeTitle == null) row._timeTitle = ctx.absoluteTimeText(Number(row.start_ns), row.timestamp);
    return row._timeTitle;
  }

  function nsDate(nsText) {
    const ns = Number(nsText);
    return Number.isFinite(ns) && ns > 0 ? new Date(Math.floor(ns / 1e6)) : null;
  }

  function gridTemplate(count) {
    return ["minmax(158px, 0.9fr)", "minmax(96px, 0.85fr)", "minmax(120px, 1.5fr)", "minmax(112px, 1fr)", "62px", "84px"]
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
    const duration = fmt.duration(row.duration_ns);
    const attrs = state.loadedColumns.map((column, i) => {
      const value = Array.isArray(row.attributes) ? row.attributes[i] : null;
      if (value == null) return `<span class="traceSpanListRow__cell traceSpanListRow__cell--attr is-missing" role="gridcell">${fmt.EMPTY}</span>`;
      const scope = column.scope === "any" ? "any" : column.scope;
      return `<span class="traceSpanListRow__cell traceSpanListRow__cell--attr" role="gridcell">${filterValueHtml("tag", value, value === "" ? '""' : value, ` data-filter-scope="${esc(scope)}" data-filter-key="${esc(column.key)}"`)}</span>`;
    }).join("");
    return `<div class="traceSpanListRow${selected ? " is-selected" : ""}${error ? " is-error" : ""}" role="row" id="traceSpanListRow-${index}" data-span-index="${index}" aria-rowindex="${index + 2}" aria-selected="${selected ? "true" : "false"}" style="top:${index * ROW_HEIGHT}px;--trace-service-color:${palette.service(row.service_name)}">`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--time" role="gridcell" title="${esc(timeTitle(row))}">${esc(localTime(row))}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--service" role="gridcell"><i class="traceSpanListRow__dot" aria-hidden="true"></i>${filterValueHtml("service", row.service_name || "", row.service_name || "unknown")}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--operation" role="gridcell">${filterValueHtml("operation", row.span_name || "", row.span_name || "span")}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--duration" role="gridcell" title="${esc(duration)}"><span class="traceSpanListRow__bar" aria-hidden="true"><i style="width:${percent.toFixed(2)}%"></i></span><span class="traceSpanListRow__durationText">${esc(duration)}</span></span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--status" role="gridcell">${statusHtml(row.status_code)}</span>`
      + `<span class="traceSpanListRow__cell traceSpanListRow__cell--kind" role="gridcell">${esc(ctx.spanKindLabel(row.span_kind))}</span>`
      + attrs
      + "</div>";
  }

  function footHtml() {
    const searchedTo = nsDate(state.searchedToNs);
    const when = searchedTo ? fmt.time(searchedTo.getTime()) : "";
    if (state.error) {
      return `<div class="traceSpanTable__foot is-error" role="alert"><span>${esc(state.error)}</span><button type="button" class="button button--small" data-span-retry>Retry</button></div>`;
    }
    if (state.loading) {
      return `<div class="traceSpanTable__foot" role="status">${ns.uiState.spinnerHtml()}<span>${state.rows.length ? "Loading more spans\u2026" : "Searching spans\u2026"}</span></div>`;
    }
    if (state.hasMore) {
      const asked = state.emptyPages >= AUTO_EMPTY_PAGES;
      const note = state.incomplete && when ? `Searched back to ${esc(when)}.` : "More spans available.";
      return `<div class="traceSpanTable__foot" data-span-more-available><span>${note}</span><button type="button" class="button button--small" data-span-load-more>${asked || state.incomplete ? "Keep searching" : "Load more"}</button></div>`;
    }
    if (!state.rows.length) return "";
    const capped = state.rows.length >= MAX_ROWS ? ` The table keeps the newest ${fmt.count(MAX_ROWS)} spans: narrow the range or filters for older ones.` : "";
    return `<div class="traceSpanTable__foot is-end" data-span-end>End of results · ${fmt.count(state.rows.length)} span${state.rows.length === 1 ? "" : "s"}.${esc(capped)}</div>`;
  }

  // The result list's "nothing found" (app_traces.js noResultsHtml).
  function emptyHtml() {
    const range = state.base ? { start: Number(state.base.start_ms), end: Number(state.base.end_ms) } : null;
    return ctx.noResultsHtml("spans", range, { "data-span-empty": "" });
  }

  function renderCount() {
    const count = byId("tracesResultCount");
    if (!count) return;
    if (!state.searched) { count.textContent = "0 Spans"; return; }
    const n = state.rows.length;
    const latency = Number.isFinite(state.latencyMs)
      ? ` <span class="tracesResultCount__latency" title="First page request time, measured in the browser">(in ${esc(fmt.duration.fromMs(state.latencyMs))})</span>`
      : "";
    const more = state.hasMore ? ' <span class="tracesResultCount__more" title="Scroll to load older spans">· more available</span>' : "";
    count.innerHTML = `${fmt.count(n)}${state.hasMore ? "+" : ""} Span${n === 1 ? "" : "s"}${latency}${more}`;
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
      root.innerHTML = ns.uiState.emptyHtml({ body: "Search to load spans." });
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

  const scrollFrame = ns.util.rafOnce(() => updateWindow());
  function onScroll() {
    if (active()) scrollFrame();
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

  // url: how span= follows the panel: "push" when it opens, "replace" when
  // it moves to another span (the defaults), "none" (from the URL).
  function select(index, { open = false, url = null } = {}) {
    if (!state.rows.length) return;
    const next = Math.max(0, Math.min(state.rows.length - 1, index));
    state.selected = next;
    ensureVisible(next);
    updateWindow(true);
    if (!open && !state.panelOpen) return;
    const moving = state.panelOpen;
    openPanel(next);
    const mode = url || (moving ? "replace" : "push");
    if (mode !== "none") ns.traceSearch?.writeUrl?.(mode, mode === "push" ? { detail: PANEL_ENTRY } : null);
  }

  function onTableClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-span-retry]")) {
      state.error = "";
      // A failed later page resumes from its cursor; a failed first page reruns.
      if (state.cursor) void loadPage(); else void loadPage({ first: true });
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
    }
  }

  // ----------------------------------------------------------- side panel

  // The side panel: a docked ns.detailPanel beside the results, sticky under
  // the search bar (a bottom sheet on narrow windows). Escape (ns.layers) and
  // its close button give the focus back to the table. Its span= is pushed
  // when it opens (PANEL_ENTRY marks that history entry), replaced when it
  // moves, and Back closes it.
  const PANEL_ENTRY = "detail:span";
  let detail = null;

  function panelApi() {
    if (detail) return detail;
    detail = ns.detailPanel.create({
      // Inside the Search tab's panel: another Traces tab hides it with it.
      host: document.querySelector(".traceSearchBody") || ctx.dom.tracesSearchView || document.body,
      id: "traceSpanPanel",
      className: "uiDetail--sticky traceSpanPanel",
      closeLabel: "Close span details",
      returnFocus: () => byId("traceSpanTable"),
      onClose: () => { if (state.panelOpen) closePanel({ focus: false }); },
    });
    detail.title?.closest(".uiDetail__titles")?.classList.add("traceSpanPanel__title");
    detail.closeButton?.classList.add("traceSpanPanel__close");
    detail.el.addEventListener("click", onPanelClick);
    return detail;
  }

  function panelEl() {
    return panelApi().el;
  }

  function detailKey(row) {
    return `${row.start_ns}\x1f${row.trace_id}\x1f${row.span_id}`;
  }

  function openPanel(index) {
    const row = state.rows[index];
    if (!row) return;
    state.panelOpen = true;
    const panel = panelEl();
    // Its place is CSS: sticky under the search bar (--trace-bar-h), a
    // bottom sheet on narrow windows.
    panelApi().open({ opener: byId("traceSpanTable") });
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

  // url: "clear" drops span= (Back when the entry is the panel's own),
  // "none" when the URL already has none (Back, a new search).
  function closePanel({ focus = true, url = "clear" } = {}) {
    const wasOpen = state.panelOpen;
    state.panelOpen = false;
    ++state.detailSeq;
    if (detail?.isOpen()) detail.close("closed", { restoreFocus: false });
    if (focus && wasOpen) byId("traceSpanTable")?.focus({ preventScroll: true });
    if (!wasOpen || url !== "clear" || !active()) return;
    if (window.history.state?.detail === PANEL_ENTRY && new URLSearchParams(window.location.search).has("span")) window.history.back();
    else ns.traceSearch?.writeUrl?.("replace");
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
      ["Start", `<time title="${esc(timeTitle(row))}">${esc(localTime(row))}</time>`],
      ["Duration", `<b>${esc(fmt.duration(span.duration_ns))}</b>`],
      ["Kind", esc(ctx.spanKindLabel(span.span_kind))],
      ["Status", statusHtml(status)],
      ["Trace ID", `<code>${esc(row.trace_id)}</code>${copyButton(row.trace_id, "Trace ID")}`],
      ["Span ID", `<code>${esc(row.span_id)}</code>${copyButton(row.span_id, "Span ID")}`],
      ["Parent", row.parent_span_id ? `<code>${esc(row.parent_span_id)}</code>` : "<code>root</code>"],
    ].map(([label, value]) => `<div class="traceSpanPanel__fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>`).join("");
    let details = "";
    if (!entry || entry.status === "loading") {
      details = '<div class="traceSpanPanel__status" role="status">Loading span details\u2026</div>';
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
    const api = panelApi();
    panel.style.setProperty("--trace-service-color", palette.service(row.service_name));
    // Eyebrow: the service; title: the operation (both click-to-filter).
    api.setHead({
      eyebrow: `<i class="traceSpanListRow__dot" aria-hidden="true"></i>${filterValueHtml("service", row.service_name || "", row.service_name || "unknown")}`,
      title: filterValueHtml("operation", row.span_name || "", row.span_name || "span"),
      html: true,
    });
    api.setActions(`<span class="uiDetail__position traceSpanPanel__position">${index + 1} / ${fmt.count(state.rows.length)}${state.hasMore ? "+" : ""}</span>
          <button type="button" class="uiDetail__nav traceSpanPanel__nav" data-span-panel-nav="prev" aria-label="Previous span" title="Previous span (\u2191)"${index <= 0 ? " disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10 8 5.5l4.5 4.5"/></svg></button>
          <button type="button" class="uiDetail__nav traceSpanPanel__nav" data-span-panel-nav="next" aria-label="Next span" title="Next span (\u2193)"${index >= state.rows.length - 1 ? " disabled" : ""}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6 8 10.5 12.5 6"/></svg></button>
          <a class="button button--primary button--small traceSpanPanel__open" href="${esc(href)}" data-span-open-trace>Open in trace</a>`);
    api.body.innerHTML = panelBodyHtml(row, entry);
    if (focusedNav) {
      const nav = panel.querySelector(`[data-span-panel-nav="${focusedNav}"]`);
      (nav && !nav.disabled ? nav : api.closeButton)?.focus({ preventScroll: true });
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

  // The open panel when it is on screen (not under a hidden tab or view).
  function shownPanel() {
    const panel = byId("traceSpanPanel");
    return panel && !panel.hidden && !panel.parentElement?.closest("[hidden]") ? panel : null;
  }

  function editable(element) {
    return !!element?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role=menu], [role=listbox], [role=dialog]:not(#traceSpanPanel)");
  }

  // Up / Down walk the rows while the panel is open (focus in the panel or
  // on the page, not in a field or a menu).
  function onDocumentKeydown(event) {
    if (!active() || !state.panelOpen || ctx.dom.tracesSearchView?.hidden || shownPanel() === null) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === byId("traceSpanTable") || editable(target)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = Number(panelEl().dataset.spanIndex);
      select(index + (event.key === "ArrowDown" ? 1 : -1), { open: true });
    }
  }

  // ------------------------------------------------------- column picker

  // A popover of the columns button: an ns.menu menu (app_ui_menu.js) in
  // a portal, right-aligned with the button; it opens on the key field.
  let columnsMenu = null;
  let columnsPopover = null;

  function closeColumns() {
    columnsPopover?.close({ immediate: true, focus: false });
  }

  function columnSuggestions() {
    const keys = ns.traceSearch?.facetKeys?.() || [];
    const taken = new Set(state.columns.map(columnLabel));
    return keys.map((item) => columnLabel({ scope: item.scope, key: item.key })).filter((label) => !taken.has(label)).slice(0, 200);
  }

  function renderColumns() {
    if (!columnsMenu) return;
    const list = state.columns.length
      ? state.columns.map((column, index) => `<li class="traceSpanColumns__item"><span class="traceSpanColumns__scope">${esc(column.scope === "any" ? "any" : column.scope)}</span><span class="traceSpanColumns__key" title="${esc(column.key)}">${esc(column.key)}</span><button type="button" class="traceSpanColumns__move" data-column-move="${index}" data-dir="-1" aria-label="Move ${esc(column.key)} left" title="Move left"${index === 0 ? " disabled" : ""}>\u2190</button><button type="button" class="traceSpanColumns__move" data-column-move="${index}" data-dir="1" aria-label="Move ${esc(column.key)} right" title="Move right"${index === state.columns.length - 1 ? " disabled" : ""}>\u2192</button><button type="button" class="traceSpanColumns__remove" data-column-remove="${index}" aria-label="Remove column ${esc(column.key)}" title="Remove column">×</button></li>`).join("")
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

  function initColumns() {
    const button = byId("traceSpanColumnsButton");
    if (!button || columnsMenu) return;
    columnsMenu = document.createElement("div");
    columnsMenu.id = "traceSpanColumnsMenu";
    columnsMenu.className = "traceSpanColumns";
    columnsMenu.setAttribute("role", "dialog");
    columnsMenu.setAttribute("aria-label", "Span table columns");
    columnsMenu.hidden = true;
    columnsMenu.addEventListener("click", onColumnsClick);
    columnsMenu.addEventListener("submit", onColumnsSubmit);
    document.body.appendChild(columnsMenu);
    columnsPopover = ns.menu?.bind(button, columnsMenu, {
      root: null,
      portal: true,
      portalAlign: "end",
      onOpen: renderColumns,
      focus: () => byId("traceSpanColumnInput"),
    }) || null;
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
    // Traces | Spans: the shared segmented control (app_ui_segmented.js).
    ns.segmented?.bind(document.querySelector(".traceModeToggle"), { attr: "resultsMode", onChange: (mode) => { setMode(mode); return false; } });
    const root = ctx.dom.tracesResults;
    root?.addEventListener("click", (event) => { if (active()) onTableClick(event); });
    root?.addEventListener("keydown", (event) => { if (active()) onTableKeydown(event); });
    ctx.dom.tracesSearchView?.addEventListener("scroll", onScroll, { passive: true });
    // While Traces shows (ns.lifecycle): the window resize and the panel's
    // Up / Down keys.
    ns.lifecycle.bind("traces", (scope) => {
      scope.listen(window, "resize", onScroll, { passive: true });
      scope.listen(document, "keydown", onDocumentKeydown);
    });
    const tools = byId("traceSpanTools");
    const kind = byId("traceSpanKind");
    if (kind) ctx.enhanceTraceSelect(kind);
    tools?.addEventListener("change", onToolsChange);
    for (const input of [byId("traceSpanMinDuration"), byId("traceSpanMaxDuration")]) {
      input?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commitDuration(input); } });
      input?.addEventListener("blur", () => commitDuration(input));
    }
    initColumns();
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
    // The Search tab is shown again (app_trace_tabs.js): redraw the rows in view.
    onTabShown: () => { if (active()) render(); else closeColumns(); },
    onTabHidden: () => closeColumns(),
    hasResults: () => state.searched && !!state.base,
    leave: () => { ctx?.dom?.tracesResults?.classList.remove("tracesResults--spans"); closeColumns(); },
  };
})();
