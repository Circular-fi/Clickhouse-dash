(() => {
  "use strict";
  // Logs explorer (the Logs view of /observability), modelled on HyperDX's
  // search page: a search bar (time range, services, level, Body text,
  // attribute filters), a Fields sidebar (the Traces attribute facets), the volume
  // histogram stacked by severity (drag to zoom), a virtualised newest-first
  // table paged by keyset cursors, a side panel with click-to-filter actions
  // and the surrounding context, a Patterns tab and a live tail. All search
  // state lives in the URL.
  const ns = window.ChDash;
  if (!ns) return;
  const { state, api, util, ui, h } = ns;
  // Formats and colours (docs/ui-foundations.md): a service keeps the colour
  // it has on Traces and Metrics (palette.service), severities are --sev-*.
  const fmt = ns.format;
  const palette = ns.palette;

  const { byId, $, $$ } = ns.dom;
  const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
  // The Logs view's address (ns.router): /observability/logs and its search
  // parameters, written only while the view shows (the "logs" lifecycle
  // scope of app_observability.js).
  const address = ns.router.owner("logs", { path: "/observability/logs", params: () => urlParams() });

  const SEV_CLASSES = ["error", "warn", "info", "debug"];
  const SEV_LABELS = { error: "Error", warn: "Warn", info: "Info", debug: "Debug" };
  // Rows are --row-compact tall (ns.table.rowHeight); on a phone (600 px and
  // below, ns.shell) each record is a two-line card, --row-card tall: Time,
  // Level and Service, then the Body. rowMetrics() reads them at init and
  // whenever the window crosses 600 px.
  let ROW_HEIGHT = 26;
  let CARDS = false;
  const CARD_COLUMNS = ["time", "severity", "service", "body"];
  const OVERSCAN = 12;
  const MAX_ROWS = 20000;
  const LIVE_POLL_MS = 3000;
  const LIVE_HISTOGRAM_EVERY = 5;
  const DEFAULT_RANGE = { from: "now-15m", to: "now" };
  const DEFAULT_COLUMNS = ["time", "severity", "service", "body"];
  const COLUMN_DEFS = {
    time: { label: "Time", width: "176px" },
    severity: { label: "Level", width: "64px" },
    service: { label: "Service", width: "minmax(96px, 150px)" },
    host: { label: "host.name", width: "minmax(96px, 150px)" },
    trace: { label: "TraceId", width: "minmax(96px, 150px)" },
    span: { label: "SpanId", width: "minmax(80px, 128px)" },
    scope: { label: "Scope", width: "minmax(80px, 140px)" },
    body: { label: "Body", width: "minmax(0, 1fr)" },
  };
  const OPTIONAL_COLUMNS = ["time", "severity", "service", "host", "trace", "span", "scope"];

  const model = {
    meta: null,
    metaError: "",
    timeRange: { ...DEFAULT_RANGE },
    services: [],
    level: "",
    sev: [],
    q: "",
    attrs: [],
    traceId: "",
    tab: "results",
    cols: [...DEFAULT_COLUMNS],
    denoise: false,
    serviceChoices: [],
    rows: [],
    rowIds: new Set(),
    nextCursor: null,
    exhausted: true,
    searching: false,
    loadingMore: false,
    lastSearch: null,
    histogram: null,
    histogramError: "",
    histogramLoading: false,
    patterns: null,
    patternsKey: "",
    patternsError: "",
    patternsLoading: false,
    selectedId: "",
    side: { tab: "details", preset: "anything", windowMs: 300000, context: null, contextError: "", contextLoading: false },
    live: false,
    liveTimer: 0,
    livePolls: 0,
    liveGap: false,
    newIds: new Set(),
    searchMs: NaN,
    status: "",
  };

  // --- Small helpers -------------------------------------------------------

  function currentHost() { return state.selectedHostId || ""; }

  // The displayed severity: the palette's level (fatal, error, warn, info,
  // debug, trace), coloured by [data-sev] (--sev-*).
  function severityLevel(row) {
    const n = Number(row.severity_number) || 0;
    return palette.severityLevel(n > 0 ? n : row.severity_text);
  }

  function sevBadgeHtml(row, title = "") {
    return ns.badge.severityHtml(severityLevel(row), row.severity_text || "", { title });
  }

  // A log time: to the millisecond in the table, every nanosecond in the
  // detail and the tooltip (fmt.time / fmt.timeTitle, browser-local).
  function timeLabel(row) {
    return fmt.time(Number(row.ts_ms), { precision: "ms" });
  }

  function fullTimeLabel(row) {
    return fmt.time(Number(row.ts_ms), { precision: "ns", ns: row.ts_ns });
  }

  function timeTitle(row) {
    return fmt.timeTitle(Number(row.ts_ms), { precision: "ns", ns: row.ts_ns });
  }

  // The shared copy (ui.copyText): the secure-context check, the textarea
  // fallback and the one "Copied" feedback.
  function copyText(text, button) {
    return ns.ui.copyText(String(text), button);
  }

  // --- URL state -------------------------------------------------------------

  function readUrl() {
    const params = ns.router.current().params;
    model.timeRange = ns.timeRange.url.read(params) || { ...DEFAULT_RANGE };
    model.services = [...new Set(params.getAll("service").filter(Boolean))];
    model.level = /^\d+$/.test(params.get("level") || "") ? params.get("level") : "";
    model.sev = SEV_CLASSES.filter((name) => params.getAll("sev").includes(name));
    model.q = params.get("q") || "";
    model.attrs = [...new Set(params.getAll("attr").filter((value) => value.includes("=")))];
    model.traceId = /^[0-9a-fA-F]{1,64}$/.test(params.get("trace_id") || "") ? params.get("trace_id") : "";
    model.tab = params.get("tab") === "patterns" ? "patterns" : "results";
    const cols = (params.get("cols") || "").split(",").map((c) => c.trim()).filter((c) => COLUMN_DEFS[c] || /^attr:.+/.test(c));
    model.cols = cols.length ? [...new Set([...cols.filter((c) => c !== "body"), "body"])] : [...DEFAULT_COLUMNS];
    model.denoise = params.get("denoise") === "1";
  }

  // withRecord: the open record's log= too (every address write keeps it).
  function urlParams({ withRecord = true } = {}) {
    const params = ns.timeRange.url.write(new URLSearchParams(), model.timeRange);
    for (const service of model.services) params.append("service", service);
    if (model.level) params.set("level", model.level);
    for (const sev of model.sev) params.append("sev", sev);
    if (model.q) params.set("q", model.q);
    for (const attr of model.attrs) params.append("attr", attr);
    if (model.traceId) params.set("trace_id", model.traceId);
    if (model.tab !== "results") params.set("tab", model.tab);
    if (model.cols.join(",") !== DEFAULT_COLUMNS.join(",")) params.set("cols", model.cols.join(","));
    if (model.denoise) params.set("denoise", "1");
    const record = withRecord ? model.side.row?.id || pendingLogId : "";
    if (record) params.set("log", record);
    return params;
  }


  // --- Request parameters ------------------------------------------------------

  function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

  function resolvedRange() {
    const tr = ns.timeRange;
    const { startMs, endMs } = tr.resolveRange(model.timeRange, Date.now());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Select a valid time range.");
    if (endMs - startMs > maxRangeMinutes() * 60000) {
      throw new Error(`Max range is ${tr.formatMinutes(maxRangeMinutes())} (server setting logs.max_lookback_minutes).`);
    }
    return { start_ms: Math.round(startMs), end_ms: Math.round(endMs) };
  }

  function filterParams(range, { withRange = true } = {}) {
    const params = new URLSearchParams();
    if (currentHost()) params.set("host_id", currentHost());
    if (withRange) {
      params.set("start_ms", String(range.start_ms));
      params.set("end_ms", String(range.end_ms));
    }
    for (const service of model.services) params.append("service", service);
    if (model.level) params.set("severity_min", model.level);
    for (const sev of model.sev) params.append("severity", sev);
    if (model.q.trim()) params.set("q", model.q.trim());
    for (const attr of model.attrs) params.append("attr", attr);
    if (model.traceId) params.set("trace_id", model.traceId);
    return params;
  }

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // --- Pickers: ns.menu (app_ui_menu.js) on the Traces search bar look -----
  // Each picker is an ns.menu menu (motion, keys, focus, the one outside
  // click / Escape layer); a search closes them all.
  const closePickers = () => ns.menu?.closeAll();
  const pickerParts = (root) => [$(":scope > .tracePicker__button", root), $(":scope > .tracePicker__menu", root)];

  let timePicker = null;

  function initTimePicker() {
    const select = byId("logsRangeUnit");
    const root = select?.parentElement;
    if (!ns.timeRange || !root) return;
    timePicker = ns.timeRange.create(root, {
      idPrefix: "logs",
      getValue: () => model.timeRange,
      getMaxMinutes: maxRangeMinutes,
      settingName: "logs.max_lookback_minutes",
      onApply: (raw) => {
        model.timeRange = { from: String(raw?.from || ""), to: String(raw?.to || "") };
        timePicker?.close();
        timePicker?.refresh();
        void search({ push: true });
      },
    });
  }

  // --- Service multi picker ----------------------------------------------------

  function renderServiceButton() {
    const button = byId("logsServiceButton");
    if (!button) return;
    const n = model.services.length;
    button.textContent = n === 0 ? "Service · All" : n === 1 ? `Service · ${model.services[0]}` : `Service · ${n} selected`;
    button.title = n ? model.services.join(", ") : "All services";
  }

  function renderServiceMenu() {
    const menu = byId("logsServiceMenu");
    if (!menu) return;
    const names = [...new Set([...model.serviceChoices.map((s) => s.name), ...model.services])].sort();
    const counts = new Map(model.serviceChoices.map((s) => [s.name, s.count]));
    palette.registerServices(names);
    const selected = new Set(model.services);
    menu.innerHTML = `<div class="logsMultiPicker__actions"><button type="button" class="logsMiniButton" data-service-all>All services</button></div>` +
      (names.length ? names.map((name) => `
        <label class="logsMultiPicker__option" role="option" aria-selected="${selected.has(name)}">
          <input type="checkbox" value="${esc(name)}" ${selected.has(name) ? "checked" : ""} />
          ${ns.badge.swatchHtml(name)}
          <span class="logsMultiPicker__name">${esc(name)}</span>
          <span class="logsMultiPicker__count">${counts.has(name) ? fmt.compact(counts.get(name)) : ""}</span>
        </label>`).join("") : '<div class="logsMultiPicker__empty">No services in this range.</div>');
  }

  function initServicePicker() {
    const root = byId("logsServicePicker");
    if (!root) return;
    ns.menu?.multi(...pickerParts(root), { root, onOpen: renderServiceMenu });
    const menu = byId("logsServiceMenu");
    menu.addEventListener("change", (event) => {
      const input = event.target.closest("input[type=checkbox]");
      if (!input) return;
      const set = new Set(model.services);
      if (input.checked) set.add(input.value); else set.delete(input.value);
      model.services = [...set].sort();
      input.closest(".logsMultiPicker__option")?.setAttribute("aria-selected", String(input.checked));
      renderServiceButton();
      scheduleFilterSearch();
    });
    menu.addEventListener("click", (event) => {
      if (!event.target.closest("[data-service-all]")) return;
      model.services = [];
      renderServiceMenu();
      renderServiceButton();
      scheduleFilterSearch();
    });
  }

  // Picker changes (service checkboxes) search once the clicks pause: the one search delay.
  const scheduleFilterSearch = util.debounce(() => { void search({ push: true }); });

  async function loadServiceChoices(range) {
    const req = util.latest("logs.services");
    try {
      const params = new URLSearchParams();
      if (currentHost()) params.set("host_id", currentHost());
      params.set("start_ms", String(range.start_ms));
      params.set("end_ms", String(range.end_ms));
      const payload = await api.getLogs("services", params, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.serviceChoices = Array.isArray(payload.services) ? payload.services : [];
      palette.registerServices(model.serviceChoices.map((s) => s.name));
      if (byId("logsServiceMenu") && !byId("logsServiceMenu").hidden) renderServiceMenu();
    } catch (_) { /* the picker keeps the selected services */ }
  }

  // --- Filter chips ------------------------------------------------------------

  function parseAttr(raw) {
    const eq = raw.indexOf("=");
    const negate = eq > 0 && raw[eq - 1] === "!";
    const key = raw.slice(0, negate ? eq - 1 : eq);
    return { key, value: raw.slice(eq + 1), negate };
  }

  function attrLabel(key) {
    return key.replace(/^(LogAttributes|ResourceAttributes|ScopeAttributes)\./, "");
  }

  function renderChips() {
    const box = byId("logsChips");
    if (!box) return;
    const chips = [];
    if (model.traceId) chips.push({ kind: "trace", text: `TraceId = ${model.traceId}`, title: "Trace filter" });
    for (const sev of model.sev) chips.push({ kind: "sev", value: sev, text: `Level: ${SEV_LABELS[sev]}`, title: "Severity class" });
    for (const attr of model.attrs) {
      const { key, value, negate } = parseAttr(attr);
      chips.push({ kind: "attr", value: attr, text: `${attrLabel(key)} ${negate ? "\u2260" : "="} ${value}`, title: key, negate });
    }
    box.hidden = chips.length === 0;
    // The shared filter chips (ns.badge.chipHtml) and "Clear filters" link.
    box.innerHTML = chips.map((chip) => ns.badge.chipHtml({
      html: `<span class="chip__value">${esc(chip.text)}</span>`, negated: !!chip.negate, className: "logsChip", title: chip.title,
      remove: { label: `Remove filter ${chip.text}`, attrs: { "data-chip-kind": chip.kind, "data-chip-value": chip.value || "" } },
    })).join("") + (chips.length > 1 ? ns.badge.clearHtml("Clear filters", { "data-chip-clear": true }) : "");
  }

  function addFilterText(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    const eq = raw.indexOf("=");
    if (eq <= 0) {
      showError("Filters are key=value or key!=value (TraceId=<id> filters a trace).");
      return false;
    }
    const { key, value, negate } = parseAttr(raw);
    const k = key.trim();
    const v = value.trim();
    if (!k) return false;
    if (/^(trace_?id|TraceId)$/i.test(k) && !negate) {
      if (!/^[0-9a-fA-F]{1,64}$/.test(v)) { showError("TraceId must be hexadecimal."); return false; }
      model.traceId = v;
    } else if (/^(service|ServiceName)$/i.test(k) && !negate) {
      if (!model.services.includes(v)) model.services = [...model.services, v].sort();
      renderServiceButton();
    } else {
      const normalized = `${k}${negate ? "!=" : "="}${v}`;
      const opposite = `${k}${negate ? "=" : "!="}${v}`;
      model.attrs = [...model.attrs.filter((a) => a !== opposite && a !== normalized), normalized];
    }
    return true;
  }

  // --- Fields panel ------------------------------------------------------------------
  // The Traces Attributes sidebar (app_facet_panel.js) over /api/logs/facets
  // and facet_values: the attribute map keys and the record columns of the
  // matching records. Its filters are the search's: a checked value is a
  // key=value filter (the service picker for ServiceName), an excluded one
  // key!=value; several checked values of one key match any of them.

  const FIELD_MAPS = { log: "LogAttributes", resource: "ResourceAttributes", scope: "ScopeAttributes" };
  const FIELD_COLUMNS = ["ServiceName", "SeverityText", "TraceId", "SpanId", "ScopeName", "ScopeVersion"];
  let fields = null;

  // The key a field's filters are written with: LogAttributes.<key> (one map)
  // or the column name.
  const fieldFilterKey = (scope, key) => (scope === "column" ? key : `${FIELD_MAPS[scope]}.${key}`);

  // Whether a filter on `filterKey` filters the field (scope, key): a bare
  // key filters both LogAttributes and ResourceAttributes.
  function filtersField(filterKey, scope, key) {
    if (scope === "column") return filterKey === key;
    return filterKey === `${FIELD_MAPS[scope]}.${key}` || (filterKey === key && scope !== "scope" && !FIELD_COLUMNS.includes(filterKey));
  }

  function fieldFiltered(scope, key) {
    const out = { include: scope === "column" && key === "ServiceName" ? [...model.services] : [], exclude: [] };
    for (const attr of model.attrs) {
      const { key: filterKey, value, negate } = parseAttr(attr);
      if (filtersField(filterKey, scope, key)) (negate ? out.exclude : out.include).push(value);
    }
    return out;
  }

  // The attr filters on the field (scope, key) for `value`, = or !=.
  const isFieldAttr = (attr, scope, key, value, negate) => {
    const parsed = parseAttr(attr);
    return parsed.negate === negate && parsed.value === value && filtersField(parsed.key, scope, key);
  };

  function setServices(services) {
    model.services = [...new Set(services)].sort();
    renderServiceButton();
  }

  function onFieldInclude(scope, key, value, checked) {
    const service = scope === "column" && key === "ServiceName";
    model.attrs = model.attrs.filter((attr) => !isFieldAttr(attr, scope, key, value, false) && !(checked && isFieldAttr(attr, scope, key, value, true)));
    if (service) setServices(checked ? [...model.services, value] : model.services.filter((name) => name !== value));
    else if (checked) model.attrs = [...model.attrs, `${fieldFilterKey(scope, key)}=${value}`];
    void search({ push: true });
  }

  function onFieldExclude(scope, key, value) {
    const excluded = model.attrs.some((attr) => isFieldAttr(attr, scope, key, value, true));
    model.attrs = model.attrs.filter((attr) => !isFieldAttr(attr, scope, key, value, true) && !isFieldAttr(attr, scope, key, value, false));
    if (!excluded) {
      if (scope === "column" && key === "ServiceName") setServices(model.services.filter((name) => name !== value));
      model.attrs = [...model.attrs, `${fieldFilterKey(scope, key)}!=${value}`];
    }
    void search({ push: true });
  }

  // The panel's filters: the search's parameters over its range.
  function fieldFilters(range) {
    return { range, params: filterParams(range).toString() };
  }

  function fieldFilterKeyOf(filters) {
    const params = new URLSearchParams(filters.params);
    params.delete("start_ms");
    params.delete("end_ms");
    // Minute-aligned like the server's cache: a re-search within the minute does not refetch.
    return `${Math.floor(filters.range.start_ms / 60000)}|${Math.ceil(filters.range.end_ms / 60000)}|${params.toString()}`;
  }

  function initFields() {
    if (!ns.facetPanel || !byId("logsFacets")) return;
    fields = ns.facetPanel.create({
      ids: { panel: "logsFacets", toggle: "logsFacetsToggle", meta: "logsFacetsMeta", search: "logsFacetsSearch", list: "logsFacetsList" },
      collapsedClass: "chdash-logs-facets-collapsed",
      // A phone: the panel is a drawer, toggled from the top of the records.
      drawerHost: $(".logsSearchMain"),
      collapsedStoreKey: ns.storage.KEYS.logsFacetsCollapsed,
      pinStoreKey: ns.storage.KEYS.logsFacetPins,
      label: "fields",
      noun: ["log", "logs"],
      scopes: {
        column: { label: "Record", title: "A column of the log record" },
        log: { label: "Log attributes", title: "Log attribute (LogAttributes)" },
        resource: { label: "Resource attributes", title: "Resource attribute (ResourceAttributes)" },
        scope: { label: "Scope attributes", title: "Scope attribute (ScopeAttributes)" },
      },
      filterKey: fieldFilterKeyOf,
      fetchKeys: async (filters, { signal } = {}) => {
        const payload = await api.getLogs("facets", new URLSearchParams(filters.params), { signal });
        return {
          supported: payload?.supported !== false,
          keys: (Array.isArray(payload?.keys) ? payload.keys : []).map((row) => ({ scope: String(row?.[0] || ""), key: String(row?.[1] || ""), count: Number(row?.[2] || 0) })),
          estimated: payload?.estimated === true,
          timedOut: payload?.timed_out === true,
          sampled: Number(payload?.sampled_records || 0),
        };
      },
      fetchValues: async (filters, scope, key, limit, { signal } = {}) => {
        const params = new URLSearchParams(filters.params);
        params.set("scope", scope);
        params.set("key", key);
        params.set("limit", String(limit));
        const payload = await api.getLogs("facet_values", params, { signal });
        return {
          values: (Array.isArray(payload?.values) ? payload.values : []).map((row) => ({ value: String(row?.[0] ?? ""), count: Number(row?.[1] || 0) })),
          estimated: payload?.estimated === true,
          hasMore: payload?.has_more === true,
        };
      },
      filtered: fieldFiltered,
      onInclude: onFieldInclude,
      onExclude: onFieldExclude,
    });
  }

  // --- Errors and status -----------------------------------------------------------

  // A failed step's state block (ns.uiState) with Retry (onRetryClick):
  // "search", "histogram", "patterns" or "context".
  const failedHtml = (title, text, what, options = {}) => ns.uiState.errorHtml({ title, body: text, retry: { attrs: { "data-logs-retry": what } }, ...options });

  // The error strip (ns.uiState.banner): a sentence (app_observability.js
  // strips the API's error codes) and, for a step that can run again, Retry.
  function showError(message, retry = null) {
    ns.uiState.banner(byId("logsError"), { message, retry });
  }

  function onRetryClick(event) {
    const what = event.target instanceof Element ? event.target.closest("[data-logs-retry]")?.getAttribute("data-logs-retry") : "";
    if (!what) return;
    if (what === "search") void search({ push: false });
    else if (what === "histogram" && model.lastSearch) void loadHistogram(model.lastSearch);
    else if (what === "patterns") { model.patternsKey = ""; void loadPatterns(); }
    else if (what === "context") void loadContext();
  }

  // "Clear filters" of an empty result: the range, columns and tab stay.
  function clearFilters() {
    model.services = [];
    model.level = "";
    model.sev = [];
    model.q = "";
    model.attrs = [];
    model.traceId = "";
    syncControls();
    void search({ push: true });
  }

  function setStatus(text) {
    model.status = text;
    const node = byId("logsStatus");
    if (node) node.textContent = text;
  }

  function setSearching(on) {
    model.searching = on;
    ns.uiState.busy(byId("logsSearchButton"), on);
  }

  // --- Search ------------------------------------------------------------------------

  async function search({ push = false, keepLive = false } = {}) {
    closePickers();
    if (!keepLive && model.live) stopLive();
    let range;
    try {
      range = resolvedRange();
    } catch (error) {
      showError(util.errorText(error));
      return;
    }
    showError("");
    address.write(push ? "push" : "replace");
    renderChips();
    syncLegend();
    // A new search supersedes the previous one, its next page and its live poll.
    const req = util.latest("logs.search");
    util.latest.cancel("logs.more");
    util.latest.cancel("logs.live");
    model.loadingMore = false;
    model.lastSearch = range;
    model.rows = [];
    model.rowIds = new Set();
    model.newIds = new Set();
    model.nextCursor = null;
    model.exhausted = true;
    model.patternsKey = "";
    model.liveGap = false;
    setSearching(true);
    renderTable({ message: "loading" });
    setStatus("Searching\u2026");
    void loadHistogram(range);
    void loadServiceChoices(range);
    void fields?.load(fieldFilters(range));
    if (model.tab === "patterns") void loadPatterns();
    const started = performance.now();
    try {
      const params = filterParams(range);
      const payload = await api.getLogs("search", params, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.searchMs = performance.now() - started;
      appendRows(payload.rows || []);
      model.nextCursor = payload.next_cursor || null;
      model.exhausted = !model.nextCursor;
      model.lastPayload = payload;
      renderTable();
      renderStatus();
      if (model.selectedId && !model.rowIds.has(model.selectedId)) closeSidePanel({ url: pendingLogId ? "none" : "clear" });
      openPendingSidePanel();
    } catch (error) {
      if (!req.isCurrent()) return;
      model.rows = [];
      renderTable({ message: "error", error: util.errorText(error) });
      setStatus("");
      showError(util.errorText(error));
    } finally {
      if (req.isCurrent()) setSearching(false);
    }
  }

  function appendRows(rows) {
    const services = [];
    for (const row of rows) {
      if (model.rowIds.has(row.id)) continue;
      model.rowIds.add(row.id);
      model.rows.push(row);
      services.push(row.service);
    }
    palette.registerServices(services);
  }

  async function loadMore() {
    if (model.loadingMore || model.searching || !model.nextCursor || !model.lastSearch) return;
    if (model.rows.length >= MAX_ROWS) return;
    model.loadingMore = true;
    const req = util.latest("logs.more");
    renderTable();
    try {
      const params = filterParams(model.lastSearch);
      params.set("cursor", model.nextCursor);
      const payload = await api.getLogs("search", params, { signal: req.signal });
      if (!req.isCurrent()) return;
      appendRows(payload.rows || []);
      model.nextCursor = payload.next_cursor || null;
      model.exhausted = !model.nextCursor;
      model.lastPayload = payload;
    } catch (error) {
      if (req.isCurrent()) showError(util.errorText(error), () => { void loadMore(); });
    } finally {
      if (req.isCurrent()) {
        model.loadingMore = false;
        renderTable();
        renderStatus();
      }
    }
  }

  // The status line beside the tabs speaks for the tab shown: the listed
  // records on Results, the mined patterns on Patterns.
  function renderStatus() {
    if (model.tab === "patterns") {
      setStatus(patternsStatus());
      return;
    }
    const n = model.rows.length;
    const parts = [];
    if (!n) {
      setStatus(model.lastSearch ? "No matching logs" : "");
      return;
    }
    parts.push(`${fmt.count(n)} log${n === 1 ? "" : "s"} shown`);
    if (model.nextCursor && model.lastPayload?.budget_exhausted) {
      parts.push(`scan paused at ${fmt.time(model.lastPayload.scanned_from_ms)} · scroll to continue`);
    } else if (model.nextCursor) {
      parts.push(model.rows.length >= MAX_ROWS ? `display limit ${fmt.count(MAX_ROWS)} reached` : "more available · scroll to load");
    }
    else parts.push("end of range");
    if (model.live) parts.push(model.liveGap ? "live · burst: older new logs skipped" : "live");
    if (Number.isFinite(model.searchMs)) parts.push(fmt.duration.fromMs(model.searchMs));
    setStatus(parts.join(" · "));
  }

  // --- Table (virtualised) -----------------------------------------------------------

  // The columns drawn. Beside the record panel the table can be narrower
  // than its columns: the lowest-priority ones go first (attributes, scope,
  // span, trace, host, then service) so Body keeps BODY_MIN_PX; Time, Level
  // and Body always stay (the span table does the same beside its panel).
  const BODY_MIN_PX = 320;
  // The widths the columns take (their grid maximum): what Body competes with.
  const COLUMN_MIN_PX = { time: 176, severity: 64, service: 150, host: 150, trace: 150, span: 128, scope: 140 };
  const DROP_ORDER = ["scope", "span", "trace", "host", "service"];
  function shownCols() {
    if (CARDS) return CARD_COLUMNS;
    const viewport = byId("logsTableViewport");
    if (!model.side.row || !viewport) return model.cols;
    const width = viewport.clientWidth;
    if (!(width > 0)) return model.cols;
    const need = (cols) => cols.reduce((sum, col) => sum + (col === "body" ? BODY_MIN_PX : COLUMN_MIN_PX[col] || 150), 0);
    let cols = model.cols.slice();
    const drops = [...cols.filter((col) => col.startsWith("attr:")).reverse(), ...DROP_ORDER];
    for (const col of drops) {
      if (need(cols) <= width) break;
      cols = cols.filter((name) => name !== col);
    }
    return cols;
  }

  function columnTemplate(cols = shownCols()) {
    if (CARDS) return "";
    return cols.map((col) => (COLUMN_DEFS[col] ? COLUMN_DEFS[col].width : "minmax(80px, 150px)")).join(" ");
  }

  function columnLabel(col) {
    return COLUMN_DEFS[col]?.label || col.replace(/^attr:/, "");
  }

  function attrValue(row, key) {
    const log = row.log_attributes || {};
    const res = row.resource_attributes || {};
    if (Object.prototype.hasOwnProperty.call(log, key)) return log[key];
    if (Object.prototype.hasOwnProperty.call(res, key)) return res[key];
    return "";
  }

  function cellHtml(row, col) {
    switch (col) {
      case "time": return `<span class="logsCell logsCell--time" title="${esc(timeTitle(row))}">${esc(timeLabel(row))}</span>`;
      case "severity": return `<span class="logsCell logsCell--sev">${sevBadgeHtml(row, `SeverityNumber ${row.severity_number}`)}</span>`;
      case "service": return `<span class="logsCell logsCell--service" title="${esc(row.service)}">${ns.badge.swatchHtml(row.service)}${esc(row.service)}</span>`;
      case "host": return `<span class="logsCell" title="${esc(attrValue(row, "host.name"))}">${esc(attrValue(row, "host.name"))}</span>`;
      case "trace": return `<span class="logsCell logsCell--mono" title="${esc(row.trace_id)}">${esc(row.trace_id)}</span>`;
      case "span": return `<span class="logsCell logsCell--mono" title="${esc(row.span_id)}">${esc(row.span_id)}</span>`;
      case "scope": return `<span class="logsCell" title="${esc(row.scope_name)}">${esc(row.scope_name)}</span>`;
      case "body": return `<span class="logsCell logsCell--body">${esc(row.body)}</span>`;
      default: {
        const value = attrValue(row, col.replace(/^attr:/, ""));
        return `<span class="logsCell" title="${esc(value)}">${esc(value)}</span>`;
      }
    }
  }

  function renderHead() {
    const head = byId("logsTableHead");
    if (!head) return;
    const cols = shownCols();
    head.style.gridTemplateColumns = columnTemplate(cols);
    // Time is left-aligned, like its values.
    h.replace(head, cols.map((col) => h("span", { class: ["logsTable__th", `logsTable__th--${col.startsWith("attr:") ? "attr" : col}`], role: "columnheader" }, columnLabel(col))));
  }

  // No logs: where the data is (a jump to it) and no filters, the ways out.
  function emptyHtml() {
    const bounds = model.meta?.time_bounds;
    const outside = !!bounds && !!model.lastSearch && (model.lastSearch.start_ms > bounds.max_ms || model.lastSearch.end_ms < bounds.min_ms);
    const filtered = !!(model.services.length || model.level || model.sev.length || model.q || model.attrs.length || model.traceId);
    return ns.uiState.emptyHtml({
      title: `No logs match${filtered ? " these filters" : ""} in this time range`,
      body: outside ? `The table holds logs from ${fmt.time(bounds.min_ms)} to ${fmt.time(bounds.max_ms)}.` : "",
      actions: [
        outside ? { label: "Show the last hour of data", primary: true, attrs: { "data-jump-latest": "" } } : null,
        filtered ? { label: "Clear filters", attrs: { "data-logs-clear-filters": "" } } : null,
      ],
    });
  }

  function renderTable({ message = null, error = "" } = {}) {
    const viewport = byId("logsTableViewport");
    const messageBox = byId("logsTableMessage");
    const spacer = byId("logsTableSpacer");
    if (!viewport || !messageBox || !spacer) return;
    renderHead();
    if (message === "loading" && !model.rows.length) {
      messageBox.hidden = false;
      messageBox.innerHTML = ns.uiState.loadingHtml({ label: "Searching logs\u2026" });
      spacer.style.height = "0px";
      byId("logsTableRows").replaceChildren();
      return;
    }
    if (message === "error") {
      messageBox.hidden = false;
      messageBox.innerHTML = failedHtml("Search failed", error, "search");
      spacer.style.height = "0px";
      byId("logsTableRows").replaceChildren();
      return;
    }
    if (!model.rows.length) {
      messageBox.hidden = false;
      messageBox.innerHTML = model.lastSearch ? emptyHtml() : ns.uiState.emptyHtml({ body: "Search to load logs." });
      spacer.style.height = "0px";
      byId("logsTableRows").replaceChildren();
      return;
    }
    messageBox.hidden = true;
    const footer = model.nextCursor || model.loadingMore ? 1 : 0;
    spacer.style.height = `${(model.rows.length + footer) * ROW_HEIGHT}px`;
    renderWindow(true);
  }

  let renderedRange = "";
  function renderWindow(force = false) {
    const viewport = byId("logsTableViewport");
    const box = byId("logsTableRows");
    if (!viewport || !box || !model.rows.length) return;
    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil((viewport.clientHeight || 600) / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(model.rows.length, first + visible);
    const cols = shownCols();
    const key = `${first}:${last}:${model.rows.length}:${model.selectedId}:${cols.join(",")}:${model.loadingMore}:${!!model.nextCursor}`;
    if (!force && key === renderedRange) return;
    if (force) renderHead();
    renderedRange = key;
    const template = columnTemplate(cols);
    let html = "";
    for (let i = first; i < last; i += 1) {
      const row = model.rows[i];
      const classes = ["logsRow", "dataList__row"];
      if (CARDS) classes.push("logsRow--card");
      if (row.id === model.selectedId) classes.push("is-selected");
      if (model.newIds.has(row.id)) classes.push("is-new");
      html += `<div class="${classes.join(" ")}" role="row" data-sev="${severityLevel(row)}" data-row-index="${i}" data-row-id="${esc(row.id)}"${template ? ` style="grid-template-columns:${template}"` : ""}>${cols.map((col) => cellHtml(row, col)).join("")}</div>`;
    }
    if (last === model.rows.length && (model.nextCursor || model.loadingMore)) {
      html += `<div class="logsRow logsRow--more dataList__row" role="row">${model.loadingMore ? `${ns.uiState.spinnerHtml()}Loading older logs\u2026` : '<button type="button" class="logsMiniButton" data-load-more>Load older logs</button>'}</div>`;
    }
    box.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    box.innerHTML = html;
    if (last >= model.rows.length - 5 && model.nextCursor && !model.loadingMore && !model.live) void loadMore();
  }

  function rowMetrics() {
    CARDS = !!ns.shell?.isAtMost("sm");
    ROW_HEIGHT = ns.table.rowHeight(CARDS ? "card" : "compact");
    byId("logsTable")?.classList.toggle("logsTable--cards", CARDS);
  }

  function initTable() {
    rowMetrics();
    try {
      window.matchMedia(ns.shell.mediaQuery("sm")).addEventListener("change", () => {
        const top = Math.floor((byId("logsTableViewport")?.scrollTop || 0) / ROW_HEIGHT);
        rowMetrics();
        renderTable();
        const viewport = byId("logsTableViewport");
        if (viewport) viewport.scrollTop = top * ROW_HEIGHT;
      });
    } catch (_) { /* no matchMedia: the rows stay as they started */ }
    const viewport = byId("logsTableViewport");
    const box = byId("logsTableRows");
    const message = byId("logsTableMessage");
    if (!viewport || !box) return;
    viewport.addEventListener("scroll", util.rafOnce(() => renderWindow()), { passive: true });
    new ResizeObserver(() => renderWindow(true)).observe(viewport);
    box.addEventListener("click", (event) => {
      if (event.target.closest("[data-load-more]")) { void loadMore(); return; }
      const rowEl = event.target.closest(".logsRow[data-row-index]");
      if (!rowEl) return;
      const row = model.rows[Number(rowEl.dataset.rowIndex)];
      if (row) openSidePanel(row);
    });
    message?.addEventListener("click", (event) => {
      if (event.target.closest("[data-logs-clear-filters]")) { clearFilters(); return; }
      if (!event.target.closest("[data-jump-latest]")) return;
      const bounds = model.meta?.time_bounds;
      if (!bounds) return;
      const tr = ns.timeRange;
      model.timeRange = { from: tr.formatDateTime(bounds.max_ms - 3600000), to: tr.formatDateTime(bounds.max_ms + 1000) };
      timePicker?.refresh();
      void search({ push: true });
    });
    // Row keys (ns.rovingRows, index mode: the grid keeps focus): Up / Down,
    // Page Up / Down, Home / End open the record in the side panel.
    const selectedIndex = () => model.rows.findIndex((row) => row.id === model.selectedId);
    const openAt = (index) => {
      if (!model.rows[index]) return;
      openSidePanel(model.rows[index]);
      scrollRowIntoView(index);
    };
    ns.table.rovingRows(byId("logsTable"), {
      count: () => model.rows.length,
      current: selectedIndex,
      page: () => Math.max(1, Math.floor((byId("logsTableViewport")?.clientHeight || 600) / ROW_HEIGHT) - 1),
      onMove: openAt,
      onOpen: openAt,
    });
  }

  function scrollRowIntoView(index) {
    const viewport = byId("logsTableViewport");
    if (!viewport) return;
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    renderWindow(true);
  }

  // --- Columns picker -----------------------------------------------------------------

  function renderColumnsMenu() {
    const menu = byId("logsColumnsMenu");
    if (!menu) return;
    const attrCols = model.cols.filter((c) => c.startsWith("attr:"));
    const option = (col, label) => h("label", { class: "logsMultiPicker__option", role: "option", "aria-selected": model.cols.includes(col) },
      h("input", { type: "checkbox", value: col, checked: model.cols.includes(col) }),
      h("span", { class: "logsMultiPicker__name" }, label));
    h.replace(menu,
      OPTIONAL_COLUMNS.map((col) => option(col, COLUMN_DEFS[col].label)),
      attrCols.map((col) => option(col, col.slice(5))),
      h("form", { class: "logsColumnsAdd", "data-columns-add": true },
        h("input", { type: "text", placeholder: "Attribute column, e.g. http.route", "aria-label": "Add attribute column", spellcheck: "false" }),
        h("button", { type: "submit", class: "logsMiniButton" }, "Add")));
  }

  function setColumns(cols) {
    const ordered = [...OPTIONAL_COLUMNS.filter((c) => cols.includes(c)), ...cols.filter((c) => c.startsWith("attr:"))];
    model.cols = [...new Set([...ordered, "body"])];
    address.replace();
    renderTable();
  }

  function initColumnsPicker() {
    const root = byId("logsColumnsPicker");
    if (!root) return;
    ns.menu?.multi(...pickerParts(root), { root, onOpen: renderColumnsMenu });
    const menu = byId("logsColumnsMenu");
    menu.addEventListener("change", (event) => {
      const input = event.target.closest("input[type=checkbox]");
      if (!input) return;
      const set = new Set(model.cols);
      if (input.checked) set.add(input.value); else set.delete(input.value);
      setColumns([...set]);
      input.closest(".logsMultiPicker__option")?.setAttribute("aria-selected", String(input.checked));
    });
    menu.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("input", event.target);
      const key = String(input?.value || "").trim();
      if (!key) return;
      setColumns([...model.cols, `attr:${key}`]);
      renderColumnsMenu();
    });
  }

  // --- Histogram ------------------------------------------------------------------------
  // Drawn by the shared canvas engine (app_chart_core.js): bars stacked by
  // severity over the requested range, the engine's cursor and tooltip, and a
  // drag that searches the dragged time range (onZoom). Resizes and refetches
  // update the one chart instance; the severity legend above it filters.

  const SEV_STACK = ["debug", "info", "warn", "error"];
  const SEV_COLUMN = { error: 1, warn: 2, info: 3, debug: 4 };
  const SEV_COLORS = {
    error: palette.severity("error"),
    warn: palette.severity("warn"),
    info: `color-mix(in srgb, ${palette.severity("info")} 78%, transparent)`,
    debug: `color-mix(in srgb, ${palette.severity("debug")} 60%, transparent)`,
  };
  const HISTOGRAM_HEIGHT = 120;
  let histogramChart = null;

  async function loadHistogram(range) {
    const req = util.latest("logs.histogram");
    model.histogramLoading = true;
    model.histogramError = "";
    renderHistogram();
    try {
      const params = filterParams(range);
      params.set("bucket_origin_ms", String(localMidnight(range.start_ms)));
      const width = byId("logsHistogram")?.clientWidth || 1000;
      params.set("buckets", String(Math.max(20, Math.min(160, Math.round(width / 9)))));
      const payload = await api.getLogs("histogram", params, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.histogram = payload;
    } catch (error) {
      if (!req.isCurrent()) return;
      model.histogram = null;
      model.histogramError = util.errorText(error);
    } finally {
      if (req.isCurrent()) {
        model.histogramLoading = false;
        renderHistogram();
      }
    }
  }

  // A message in place of the bars (the chart keeps its instance, hidden).
  function histogramMessage(box, text, isError = false) {
    if (histogramChart) histogramChart.root.hidden = true;
    let note = $(":scope > .logsHistogram__placeholder", box);
    if (!note) {
      $(":scope > .uiState", box)?.remove();
      note = document.createElement("div");
      box.appendChild(note);
    }
    note.className = "logsHistogram__placeholder";
    note.innerHTML = isError ? failedHtml("", text, "histogram", { compact: true }) : ns.uiState.loadingHtml({ label: text, compact: true });
    note.hidden = false;
  }

  // Bucket starts -> bars centred on [start, start + bucket_ms).
  function histogramData(hist) {
    const rows = Array.isArray(hist.buckets) ? hist.buckets : [];
    const bucketMs = Number(hist.bucket_ms) || 60000;
    const xs = new Float64Array(rows.length);
    const columns = {};
    for (const sev of SEV_STACK) columns[sev] = new Float64Array(rows.length);
    rows.forEach((b, i) => {
      xs[i] = Number(b[0]) + bucketMs / 2;
      for (const sev of SEV_STACK) columns[sev][i] = Number(b[SEV_COLUMN[sev]]) || 0;
    });
    return {
      xs,
      bucketMs,
      xDomain: Array.isArray(hist.range) ? [Number(hist.range[0]), Number(hist.range[1])] : null,
      series: SEV_STACK.map((sev) => ({ id: sev, label: SEV_LABELS[sev], color: SEV_COLORS[sev], values: columns[sev], nulls: null, group: 0 })),
    };
  }

  // A drag over the bars searches that time range (whole seconds).
  function onHistogramZoom(range, fromUser) {
    if (!fromUser || !range) return;
    const startMs = Math.floor(range[0] / 1000) * 1000;
    const endMs = Math.ceil(range[1] / 1000) * 1000;
    if (endMs - startMs < 1000) return;
    const tr = ns.timeRange;
    model.timeRange = { from: tr.formatDateTime(startMs), to: tr.formatDateTime(endMs) };
    timePicker?.refresh();
    void search({ push: true });
  }

  function renderHistogram() {
    const box = byId("logsHistogram");
    const total = byId("logsTotal");
    const meta = byId("logsHistogramMeta");
    if (!box) return;
    const hist = model.histogram;
    ns.uiState.busy(box, model.histogramLoading && !!hist);
    if (model.histogramLoading && !hist) {
      histogramMessage(box, "Loading volume\u2026");
      if (total) total.textContent = fmt.EMPTY;
      return;
    }
    if (model.histogramError) {
      histogramMessage(box, model.histogramError, true);
      if (total) total.textContent = fmt.EMPTY;
      return;
    }
    if (!hist) return;
    const count = Number(hist.totals?.total || 0);
    if (total) total.textContent = `${fmt.count(count)} log${count === 1 ? "" : "s"}`;
    if (meta) meta.textContent = `${ns.timeRange.describeRange(model.timeRange).text} · ${fmt.duration.fromMs(hist.bucket_ms)} buckets${model.histogramLoading ? " · updating\u2026" : ""}`;
    // While a refetch runs, the previous bars stay (dimmed) until it answers.
    if (model.histogramLoading || !ns.chartCore) return;
    for (const note of $$(":scope > .logsHistogram__placeholder, :scope > .uiState", box)) note.hidden = true;
    const data = histogramData(hist);
    if (!histogramChart) {
      histogramChart = ns.chartCore.create(box, {
        ...data,
        xKind: "time",
        type: "bar",
        stack: true,
        height: HISTOGRAM_HEIGHT,
        xFractionDigits: 0,
        // The engine's totals legend: each severity with its count over the
        // range; a click filters by it (a server search), pressed when on.
        legend: "totals",
        legendOrder: "reverse",
        legendTotal: (s) => fmt.compact(Number(model.histogram?.totals?.[s.id] || 0)),
        legendPressed: (s) => model.sev.includes(s.id),
        legendTitle: (s, pressed) => (pressed ? `Show every severity` : `Only ${s.label} logs`),
        onLegendClick: (s) => toggleSeverity(s.id),
        barWidthRatio: 0.86,
        cursorPoints: false,
        tooltipSort: "reverse",
        bucketAlign: "center",
        formatValue: (v) => fmt.count(v),
        formatY: (v) => fmt.count(Math.max(0, v)),
        onZoom: onHistogramZoom,
      });
      histogramChart.root.setAttribute("role", "group");
      histogramChart.root.setAttribute("aria-label", "Log volume by severity");
    } else {
      histogramChart.root.hidden = false;
      histogramChart.setData({ ...data, zoom: null });
    }
  }

  function toggleSeverity(sev) {
    model.sev = model.sev.includes(sev) ? model.sev.filter((s) => s !== sev) : SEV_CLASSES.filter((s) => s === sev || model.sev.includes(s));
    void search({ push: true });
  }

  function initHistogram() {}

  // The legend's pressed severities follow the filter (a redraw rebuilds it).
  function syncLegend() {
    histogramChart?.redraw?.();
  }

  // --- Patterns -----------------------------------------------------------------------------

  function patternsKey(range) { return `${currentHost()}|${filterParams(range).toString()}`; }

  async function loadPatterns() {
    if (!model.lastSearch) return;
    const range = model.lastSearch;
    const key = patternsKey(range);
    if (key === model.patternsKey && (model.patterns || model.patternsLoading)) { renderPatterns(); return; }
    model.patternsKey = key;
    const req = util.latest("logs.patterns");
    model.patternsLoading = true;
    model.patternsError = "";
    renderPatterns();
    try {
      const payload = await api.getLogs("patterns", filterParams(range), { signal: req.signal });
      if (!req.isCurrent()) return;
      model.patterns = payload;
    } catch (error) {
      if (!req.isCurrent()) return;
      model.patterns = null;
      model.patternsError = util.errorText(error);
    } finally {
      if (req.isCurrent()) {
        model.patternsLoading = false;
        renderPatterns();
      }
    }
  }

  // The shared sparkline (ui.sparkline), in the pattern's severity colour.
  function sparklineHtml(values, sev) {
    return `<span class="logsSparkline" data-sev="${esc(sev)}">${ns.ui.sparkline.html(values, { min: 0 })}</span>`;
  }

  function patternHtml(text) {
    return esc(text).replace(/&lt;\*&gt;/g, '<span class="logsPattern__var">&lt;*&gt;</span>');
  }

  // "21 patterns in a sample of 9,472 of 6,544,139 logs · counts
  // extrapolated ×691 from the sample", the Patterns tab's status line.
  function patternsStatus() {
    const p = model.patterns;
    if (model.patternsLoading && !p) return "Mining patterns\u2026";
    if (!p || !p.total) return "";
    const all = p.patterns || [];
    const hidden = model.denoise ? all.filter((item) => item.noisy).length : 0;
    const parts = [`${fmt.countLabel(p.pattern_count, "pattern")} in ${p.sampled ? `a sample of ${fmt.count(p.sample_size)} of ${fmt.countLabel(p.total, "log")}` : fmt.countLabel(p.total, "log")}`];
    if (p.sampled) parts.push(`counts extrapolated \u00d7${fmt.compact(p.scale)} from the sample`);
    if (hidden) parts.push(`denoise hides ${fmt.countLabel(hidden, "pattern")} above 10%`);
    if (model.patternsLoading) parts.push("updating\u2026");
    return parts.join(" \u00b7 ");
  }

  function renderPatterns() {
    const box = byId("logsPatterns");
    if (!box) return;
    renderStatus();
    const toggle = byId("logsDenoiseToggle");
    if (toggle) toggle.hidden = model.tab !== "patterns";
    if (model.patternsLoading && !model.patterns) {
      box.innerHTML = ns.uiState.loadingHtml({ label: "Mining patterns from a sample\u2026" });
      return;
    }
    if (model.patternsError) {
      box.innerHTML = failedHtml("Patterns failed", model.patternsError, "patterns");
      return;
    }
    const p = model.patterns;
    if (!p) { box.innerHTML = ns.uiState.emptyHtml({ body: "Search to mine patterns." }); return; }
    const all = p.patterns || [];
    const hidden = model.denoise ? all.filter((item) => item.noisy).length : 0;
    const shown = model.denoise ? all.filter((item) => !item.noisy) : all;
    if (!all.length) {
      box.innerHTML = ns.uiState.emptyHtml({ title: "No logs to mine in this range", body: "Widen the time range or remove filters on the Results tab." });
      return;
    }
    box.innerHTML = `<div class="logsPatterns__table" role="table" aria-label="Log patterns">
        <div class="logsPatterns__head dataList__head" role="row"><span>Count</span><span>Share</span><span>Trend</span><span>Pattern</span></div>
        ${shown.map((item) => `
          <button type="button" class="logsPatternRow" role="row" data-pattern-index="${all.indexOf(item)}" title="Filter by this pattern: ${esc(item.search)}">
            <span class="logsPatternRow__count">${fmt.compact(item.count)}</span>
            <span class="logsPatternRow__share">${ns.table.shareBarHtml(Math.max(1, item.share * 100), fmt.percent(item.share))}</span>
            <span class="logsPatternRow__trend">${sparklineHtml(item.sparkline || [], item.severity)}</span>
            <span class="logsPatternRow__text">
              <span class="logsPattern">${ns.badge.severityHtml(item.severity)}${patternHtml(item.pattern)}</span>
              <span class="logsPattern__sample">${ns.badge.swatchHtml(item.service)}${esc(item.service)}${item.service_count > 1 ? ` +${item.service_count - 1}` : ""} · ${esc(item.sample)}</span>
            </span>
          </button>`).join("")}
      </div>`;
  }

  function initPatterns() {
    byId("logsPatterns")?.addEventListener("click", (event) => {
      const rowEl = event.target.closest("[data-pattern-index]");
      if (!rowEl || !model.patterns) return;
      const item = model.patterns.patterns[Number(rowEl.dataset.patternIndex)];
      if (!item) return;
      model.q = item.search;
      const input = byId("logsQuery");
      if (input) input.value = model.q;
      setTab("results", { push: false });
      void search({ push: true });
    });
    byId("logsDenoise")?.addEventListener("change", (event) => {
      model.denoise = !!event.target.checked;
      address.replace();
      renderPatterns();
    });
  }

  // The Results / Patterns in-content tabs (app_ui_tabs.js).
  let viewTabs = null;
  // The log record tabs (Details | Surrounding context), ns.tabs.bind.
  let sideTabs = null;

  function setTab(tab, { push = false } = {}) {
    model.tab = tab === "patterns" ? "patterns" : "results";
    viewTabs?.select(model.tab);
    byId("logsResultsPane").hidden = model.tab !== "results";
    byId("logsPatternsPane").hidden = model.tab !== "patterns";
    const cols = byId("logsColumnsPicker");
    if (cols) cols.hidden = model.tab !== "results";
    const denoise = byId("logsDenoiseToggle");
    if (denoise) denoise.hidden = model.tab !== "patterns";
    address.write(push ? "push" : "replace");
    if (model.tab === "patterns") void loadPatterns();
    else renderTable();
    renderStatus();
  }

  // --- Side panel --------------------------------------------------------------------------

  // The record panel: a docked ns.detailPanel. Its log= URL parameter (the
  // record's id) is pushed when it opens, replaced when another record shows
  // in it, and Back closes it. Escape (ns.layers) and the close button give
  // the focus back to the record table, whose arrow keys move through the
  // records.
  let sidePanel = null;
  const logParam = address.panel("log");
  // A log= of a reload or a link: opened when its record is listed.
  let pendingLogId = "";

  function detailPanel() {
    if (sidePanel || !byId("logsSidePanel")) return sidePanel;
    sidePanel = ns.detailPanel.create({
      el: byId("logsSidePanel"),
      layout: "docked",
      returnFocus: () => byId("logsTable"),
      onClose: () => { if (model.side.row) closeSidePanel(); },
    });
    return sidePanel;
  }

  // url: "push" | "replace" (another record in the open panel) | "none".
  function openSidePanel(row, { tab = null, url = null } = {}) {
    if (!row) return;
    const moving = !!model.side.row;
    model.selectedId = row.id;
    model.side.row = row;
    if (tab) model.side.tab = tab;
    model.side.context = null;
    model.side.contextError = "";
    detailPanel()?.open({ opener: byId("logsTable") });
    $(".logsBody")?.classList.add("has-side");
    renderSidePanel();
    renderWindow(true);
    if (model.side.tab === "context") void loadContext();
    const mode = url || (moving ? "replace" : "push");
    if (mode === "push") logParam.open(row.id);
    else if (mode === "replace") logParam.move(row.id);
  }

  // url: "clear" (drop log=, Back when the entry is the panel's own) or
  // "none" (the URL already has no log=: Back, a new search).
  function closeSidePanel({ url = "clear" } = {}) {
    const wasOpen = !!model.side.row;
    model.selectedId = "";
    model.side.row = null;
    if (sidePanel?.isOpen()) sidePanel.close("closed", { restoreFocus: true });
    $(".logsBody")?.classList.remove("has-side");
    renderWindow(true);
    if (wasOpen && url === "clear") logParam.close();
  }

  // Back / Forward: the panel follows log=.
  function syncSidePanelFromUrl(id = logParam.get()) {
    if (!id) {
      pendingLogId = "";
      if (model.side.row) closeSidePanel({ url: "none" });
      return;
    }
    if (model.side.row?.id === id) return;
    const row = model.rows.find((item) => item.id === id);
    if (row) openSidePanel(row, { url: "none" });
    else pendingLogId = id;
  }

  function openPendingSidePanel() {
    if (!pendingLogId) return;
    const row = model.rows.find((item) => item.id === pendingLogId);
    pendingLogId = "";
    if (row) openSidePanel(row, { url: "none" });
    else if (logParam.get()) logParam.close();
  }

  // Record fields: the shared key / value list (ui.kvListHtml) with the
  // include / exclude / only / copy actions (applyFieldAction).
  const FIELD_ACTIONS = ["include", "exclude", "only", "copy"];

  function fieldRow(label, key, value, { mono = false, actions = true } = {}) {
    return { key, label, value: String(value == null ? "" : value), json: false, mono, actions: actions ? FIELD_ACTIONS : [] };
  }

  function mapSectionHtml(title, column, map) {
    const entries = Object.entries(map || {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `<section class="logsFieldGroup">
      <h4>${esc(title)} <span>${entries.length}</span></h4>
      ${ns.ui.kvListHtml(entries.map(([k, v]) => fieldRow(k, `${column}.${k}`, v)), { className: "logsFields", empty: "none" })}
    </section>`;
  }

  function renderSidePanel() {
    const row = model.side.row;
    if (!row) return;
    const title = byId("logsSideTitle");
    if (title) {
      title.innerHTML = `${sevBadgeHtml(row)}
        <span class="logsSideTitle__service">${ns.badge.swatchHtml(row.service)}${esc(row.service)}</span>
        <time class="logsSideTitle__time" title="${esc(timeTitle(row))}">${esc(fullTimeLabel(row))}</time>`;
    }
    const openTrace = byId("logsOpenTrace");
    if (openTrace) {
      const traced = !!row.trace_id && ns.features.get("traces.enabled");
      openTrace.hidden = !traced;
      if (traced) openTrace.href = ns.router.url(`/observability/traces/${encodeURIComponent(row.trace_id)}${row.span_id ? `?span=${encodeURIComponent(row.span_id)}` : ""}`);
    }
    sideTabs?.select(model.side.tab);
    byId("logsSideDetails").hidden = model.side.tab !== "details";
    byId("logsSideContext").hidden = model.side.tab !== "context";
    const details = byId("logsSideDetails");
    if (details) {
      details.innerHTML = `
        <section class="logsFieldGroup logsFieldGroup--body">
          <h4>Body${row.body_truncated ? ` <span>first ${fmt.count(row.body.length)} of ${fmt.count(row.body_length)} characters</span>` : ""}</h4>
          <pre class="logsBodyText">${esc(row.body)}</pre>
        </section>
        <section class="logsFieldGroup">
          <h4>Record</h4>
          ${ns.ui.kvListHtml([
            fieldRow("Timestamp", "Timestamp", fullTimeLabel(row), { actions: false }),
            fieldRow("ServiceName", "ServiceName", row.service),
            fieldRow("SeverityText", "SeverityText", row.severity_text),
            fieldRow("SeverityNumber", "SeverityNumber", row.severity_number, { actions: false }),
            row.trace_id ? fieldRow("TraceId", "TraceId", row.trace_id, { mono: true }) : null,
            row.span_id ? fieldRow("SpanId", "SpanId", row.span_id, { mono: true }) : null,
            row.scope_name ? fieldRow("ScopeName", "ScopeName", row.scope_name) : null,
            row.scope_version ? fieldRow("ScopeVersion", "ScopeVersion", row.scope_version) : null,
          ].filter(Boolean), { className: "logsFields" })}
        </section>
        ${mapSectionHtml("Log attributes", "LogAttributes", row.log_attributes)}
        ${mapSectionHtml("Resource attributes", "ResourceAttributes", row.resource_attributes)}
        ${Object.keys(row.scope_attributes || {}).length ? mapSectionHtml("Scope attributes", "ScopeAttributes", row.scope_attributes) : ""}`;
    }
    syncContextBar();
    renderContext();
  }

  function applyFieldAction(action, key, value, button) {
    if (action === "copy") { void copyText(value, button); return; }
    if (action === "only") {
      model.services = [];
      model.level = "";
      model.sev = [];
      model.q = "";
      model.attrs = [];
      model.traceId = "";
      const q = byId("logsQuery");
      if (q) q.value = "";
      levelPicker?.set("");
    }
    const negate = action === "exclude";
    if (key === "ServiceName" && !negate) {
      if (!model.services.includes(value)) model.services = [...model.services, value].sort();
      renderServiceButton();
    } else if (key === "TraceId" && !negate) {
      model.traceId = value;
    } else {
      const normalized = `${key}${negate ? "!=" : "="}${value}`;
      const opposite = `${key}${negate ? "=" : "!="}${value}`;
      model.attrs = [...model.attrs.filter((a) => a !== opposite && a !== normalized), normalized];
    }
    void search({ push: true });
  }

  const contextScope = () => $(".logsContextScope");
  const contextWindow = () => $(".logsContextWindow");

  function syncContextBar() {
    const row = model.side.row;
    for (const button of $$("[data-context-preset]")) {
      const preset = button.dataset.contextPreset;
      button.disabled = (preset === "host" && !row?.resource_attributes?.["host.name"]) || (preset === "trace" && !row?.trace_id);
    }
    ns.segmented?.set(contextScope(), model.side.preset, "contextPreset");
    ns.segmented?.set(contextWindow(), String(model.side.windowMs), "contextWindow");
  }

  async function loadContext() {
    const row = model.side.row;
    if (!row) return;
    const [ts, tie] = String(row.id).split("-");
    if ((model.side.preset === "host" && !row.resource_attributes?.["host.name"]) || (model.side.preset === "trace" && !row.trace_id)) model.side.preset = "anything";
    const params = new URLSearchParams();
    if (currentHost()) params.set("host_id", currentHost());
    params.set("ts_ns", ts);
    if (tie) params.set("tie", tie);
    params.set("preset", model.side.preset);
    params.set("window_ms", String(model.side.windowMs));
    params.set("limit", "50");
    if (model.side.preset === "service") params.set("service", row.service);
    if (model.side.preset === "host") params.set("host", row.resource_attributes["host.name"]);
    if (model.side.preset === "trace") params.set("trace_id", row.trace_id);
    const req = util.latest("logs.context");
    model.side.contextLoading = true;
    model.side.contextError = "";
    model.side.anchorId = row.id;
    syncContextBar();
    renderContext();
    try {
      const payload = await api.getLogs("context", params, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.side.context = payload;
      palette.registerServices((payload.rows || []).map((r) => r.service));
    } catch (error) {
      if (!req.isCurrent()) return;
      model.side.context = null;
      model.side.contextError = util.errorText(error);
    } finally {
      if (req.isCurrent()) {
        model.side.contextLoading = false;
        renderContext();
        $(".is-anchor", byId("logsContextRows"))?.scrollIntoView({ block: "center" });
      }
    }
  }

  function renderContext() {
    const box = byId("logsContextRows");
    if (!box || model.side.tab !== "context") return;
    if (model.side.contextLoading && !model.side.context) { box.innerHTML = ns.uiState.loadingHtml({ label: "Loading surrounding logs\u2026", compact: true }); return; }
    if (model.side.contextError) { box.innerHTML = failedHtml("", model.side.contextError, "context", { compact: true }); return; }
    const ctx = model.side.context;
    if (!ctx) { box.replaceChildren(); return; }
    const rows = ctx.rows || [];
    const anchor = model.side.anchorId;
    box.innerHTML = `${ctx.more_after ? '<div class="logsContext__more">Newer logs continue past the window</div>' : ""}
      ${rows.map((r) => {
        return `<button type="button" class="logsContextRow${r.id === anchor ? " is-anchor" : ""}" data-context-id="${esc(r.id)}">
          <span class="logsContextRow__time" title="${esc(timeTitle(r))}">${esc(fmt.time(Number(r.ts_ms), { precision: "ms", date: "never" }))}</span>
          ${sevBadgeHtml(r)}
          <span class="logsContextRow__service">${ns.badge.swatchHtml(r.service)}${esc(r.service)}</span>
          <span class="logsContextRow__body">${esc(r.body)}</span>
        </button>`;
      }).join("") || ns.uiState.emptyHtml({ body: "No other logs in this window.", compact: true })}
      ${ctx.more_before ? '<div class="logsContext__more">Older logs continue past the window</div>' : ""}`;
  }

  function initSidePanel() {
    detailPanel();
    // Copy JSON / Copy body / Download JSON: the shared split (ui.copySplit),
    // like a trace's and a query's.
    const recordJson = () => (model.side.row ? JSON.stringify(model.side.row, null, 2) : "");
    if (byId("logsCopySplit")) {
      ns.ui.copySplit({
        root: byId("logsCopySplit"),
        getText: recordJson,
        items: [
          { el: byId("logsCopyBody"), copy: () => String(model.side.row?.body ?? "") },
          { el: byId("logsDownloadJson"), onSelect: () => { if (model.side.row) ns.ui.downloadText(`log-${String(model.side.row.ts_ns || model.side.row.ts_ms || "record")}.json`, recordJson()); } },
        ],
      });
    }
    // The record fields' actions (ui.kvBind): include is the field filter.
    ns.ui.kvBind(byId("logsSideDetails"), {
      onAction: (action, { key, text, button }) => {
        applyFieldAction(action === "include" ? "filter" : action, key, text, button);
        return true;
      },
    });
    // Details | Surrounding context: the shared tab behaviour (app_ui_tabs.js).
    sideTabs = ns.tabs?.bind($(".logsSideTabs"), {
      attr: "sideTab",
      onSelect: (tab) => {
        model.side.tab = tab;
        renderSidePanel();
        if (model.side.tab === "context" && !model.side.context) void loadContext();
      },
    }) || null;
    // Context scope and window: shared segmented controls (app_ui_segmented.js).
    ns.segmented?.bind(contextScope(), { attr: "contextPreset", onChange: (preset) => { model.side.preset = preset; void loadContext(); return false; } });
    ns.segmented?.bind(contextWindow(), { attr: "contextWindow", onChange: (ms) => { model.side.windowMs = Number(ms); void loadContext(); return false; } });
    byId("logsContextRows")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-context-id]");
      if (!item) return;
      const row = (model.side.context?.rows || []).find((r) => r.id === item.dataset.contextId);
      if (!row) return;
      // Keep the context list; show the clicked record's details.
      const context = model.side.context;
      model.selectedId = row.id;
      model.side.row = row;
      model.side.tab = "details";
      model.side.context = context;
      renderSidePanel();
      renderWindow(true);
    });
  }

  // --- Live tail -------------------------------------------------------------------------------

  function syncLiveButton() {
    const button = byId("logsLiveButton");
    if (!button) return;
    button.setAttribute("aria-pressed", String(model.live));
    button.classList.toggle("is-live", model.live);
    button.title = model.live ? "Live tail on: click to pause" : "Live tail: poll for new logs";
  }

  function stopLive() {
    model.live = false;
    clearTimeout(model.liveTimer);
    model.liveTimer = 0;
    syncLiveButton();
    renderStatus();
  }

  async function startLive() {
    model.live = true;
    model.livePolls = 0;
    syncLiveButton();
    // The tail follows now: an absolute range becomes the last 15 minutes.
    if (!ns.timeRange.isRelative(model.timeRange) || !/now$/i.test(model.timeRange.to)) {
      model.timeRange = { ...DEFAULT_RANGE };
      timePicker?.refresh();
      await search({ push: true, keepLive: true });
    }
    scheduleLive();
  }

  function scheduleLive() {
    clearTimeout(model.liveTimer);
    if (!model.live) return;
    model.liveTimer = setTimeout(() => { void pollLive(); }, LIVE_POLL_MS);
  }

  async function pollLive() {
    if (!model.live) return;
    if (document.hidden || model.searching || !address.active()) { scheduleLive(); return; }
    let range;
    try { range = resolvedRange(); } catch (_) { scheduleLive(); return; }
    const newest = model.rows[0];
    const params = filterParams(range);
    if (newest) params.set("after", newest.id);
    const req = util.latest("logs.live");
    try {
      const payload = newest ? await api.getLogs("search", params, { signal: req.signal }) : null;
      if (!model.live || !req.isCurrent()) return;
      if (!newest) {
        await search({ keepLive: true });
      } else {
        const fresh = (payload.rows || []).filter((row) => !model.rowIds.has(row.id));
        model.liveGap = !!payload.tail_gap;
        if (fresh.length) prependRows(fresh);
        model.lastSearch = range;
      }
      model.livePolls += 1;
      if (model.livePolls % LIVE_HISTOGRAM_EVERY === 0) void loadHistogram(range);
      renderStatus();
    } catch (error) {
      if (model.live && req.isCurrent()) setStatus(`Live tail paused on error: ${util.errorText(error)}`);
    } finally {
      scheduleLive();
    }
  }

  function prependRows(fresh) {
    const viewport = byId("logsTableViewport");
    const atTop = !viewport || viewport.scrollTop < ROW_HEIGHT;
    for (const row of fresh) model.rowIds.add(row.id);
    model.newIds = new Set(fresh.map((row) => row.id));
    palette.registerServices(fresh.map((row) => row.service));
    model.rows = [...fresh, ...model.rows];
    if (model.rows.length > MAX_ROWS) {
      const dropped = model.rows.splice(MAX_ROWS);
      for (const row of dropped) model.rowIds.delete(row.id);
      model.nextCursor = model.rows.length ? `${model.rows[model.rows.length - 1].id}` : null;
    }
    if (viewport && !atTop) viewport.scrollTop += fresh.length * ROW_HEIGHT;
    renderTable();
    setTimeout(() => { model.newIds = new Set(); renderWindow(true); }, 1500);
  }

  // --- Meta and boot ------------------------------------------------------------------------

  async function loadMeta() {
    const params = new URLSearchParams();
    if (currentHost()) params.set("host_id", currentHost());
    try {
      model.meta = await api.getLogs("meta", params);
      model.metaError = "";
      if (model.meta.enabled === false) model.metaError = model.meta.message || "OTel logs are disabled.";
      else if (model.meta.table_exists === false || model.meta.schema_ok === false) model.metaError = model.meta.message || "The logs table is not available.";
    } catch (error) {
      model.meta = null;
      model.metaError = util.errorText(error);
    }
    const input = byId("logsQuery");
    const mode = model.meta?.body_search?.effective || "token";
    if (input) {
      input.disabled = mode === "off";
      input.placeholder = mode === "off" ? "Body search is disabled (logs.body_search = off)"
        : mode === "substring" ? "Search Body (substring): words, \"exact phrase\", -exclude"
        : "Search Body: words, \"exact phrase\", -exclude";
      input.title = mode === "token"
        ? "Whole-token search (hasToken, served by the Body token index). Tokens are case-sensitive; punctuation separates tokens."
        : mode === "substring" ? "Case-insensitive substring search (scans Body)." : "";
    }
    timePicker?.refresh();
  }

  function syncControls() {
    const q = byId("logsQuery");
    if (q) q.value = model.q;
    levelPicker?.set(model.level);
    renderServiceButton();
    renderChips();
    syncLegend();
    const denoise = byId("logsDenoise");
    if (denoise) denoise.checked = model.denoise;
    timePicker?.refresh();
  }

  let levelPicker = null;
  let booted = false;

  async function reloadForHost() {
    await loadMeta();
    if (model.metaError) {
      showError(model.metaError, model.meta ? null : () => { void reloadForHost(); });
      renderTable();
      return;
    }
    await search({ push: false });
  }

  // Back / Forward, or the Observability page showing this view again. The
  // view shown again on the URL it left keeps its results, scroll and side
  // panel (a live tail resumes polling).
  function onLocation() {
    // log= first: the URL writes below keep the open record's log=.
    const logId = logParam.get();
    const before = urlParams({ withRecord: false }).toString();
    readUrl();
    const same = urlParams({ withRecord: false }).toString() === before && model.lastSearch && !model.metaError;
    if (same) syncSidePanelFromUrl(logId);
    else {
      pendingLogId = logId;
      if (model.side.row && model.side.row.id !== logId) closeSidePanel({ url: "none" });
    }
    syncControls();
    setTab(model.tab, { push: false });
    if (!same) void search({ push: false });
  }

  // A host change while another view is shown reloads when this one comes back.
  let reloadWhenShown = false;

  function onShow() {
    if (reloadWhenShown) {
      reloadWhenShown = false;
      void reloadForHost();
    }
  }

  function onHide() {
    closePickers();
  }

  // Shared with the other Observability views: the time range, and the
  // service when one is picked (several picked: nothing to share).
  function getContext() {
    const service = model.services.length === 1 ? model.services[0] : model.services.length ? null : "";
    return { range: { ...model.timeRange }, service };
  }

  function applyContext(params, context) {
    if (context.range) ns.timeRange.url.write(params, context.range);
    if (context.service != null) {
      params.delete("service");
      if (context.service) params.append("service", context.service);
    }
  }

  function init() {
    readUrl();
    pendingLogId = logParam.get();
    initTimePicker();
    initServicePicker();
    initColumnsPicker();
    initFields();
    const level = byId("logsLevel");
    if (level) {
      const enhanced = ns.menu?.select(level, { onChange: (value) => { model.level = value; void search({ push: true }); } });
      levelPicker = { set: (value) => { level.value = value || ""; enhanced?.refresh(); } };
    }
    initTable();
    initHistogram();
    initPatterns();
    initSidePanel();
    viewTabs = ns.tabs?.bind($(".logsTabs"), { onSelect: (tab) => { if (tab !== model.tab) setTab(tab, { push: true }); } }) || null;
    byId("logsWorkspace")?.addEventListener("click", onRetryClick);
    syncControls();
    setTab(model.tab, { push: false });

    byId("logsForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      model.q = String(byId("logsQuery")?.value || "");
      const filter = byId("logsFilterInput");
      if (filter && filter.value.trim()) {
        if (!addFilterText(filter.value)) return;
        filter.value = "";
      }
      void search({ push: true });
    });
    byId("logsFilterInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (addFilterText(event.target.value)) {
        event.target.value = "";
        model.q = String(byId("logsQuery")?.value || "");
        void search({ push: true });
      }
    });
    byId("logsChips")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-chip-clear]")) {
        model.attrs = [];
        model.traceId = "";
        model.sev = [];
        void search({ push: true });
        return;
      }
      const button = event.target.closest("[data-chip-kind]");
      if (!button) return;
      const kind = button.dataset.chipKind;
      const value = button.dataset.chipValue;
      if (kind === "trace") model.traceId = "";
      if (kind === "sev") model.sev = model.sev.filter((s) => s !== value);
      if (kind === "attr") model.attrs = model.attrs.filter((a) => a !== value);
      void search({ push: true });
    });
    byId("logsLiveButton")?.addEventListener("click", () => { if (model.live) stopLive(); else void startLive(); });
    window.addEventListener("chdash:host-changed", () => {
      if (address.active()) void reloadForHost();
      else reloadWhenShown = true;
    });
    ns.features.on((features) => {
      if (features?.logs?.enabled === false || !address.active()) return;
      if (!booted && currentHost()) { booted = true; void reloadForHost(); }
    });
    if (currentHost()) { booted = true; void reloadForHost(); }
  }

  ns.logs = { init, onLocation, onShow, onHide, getContext, applyContext, search, model };
})();
