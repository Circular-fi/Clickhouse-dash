(() => {
  "use strict";
  // Logs explorer (the Logs view of /observability), modelled on HyperDX's
  // search page: a search bar (time range, services, level, Body text,
  // attribute filters), the volume
  // histogram stacked by severity (drag to zoom), a virtualised newest-first
  // table paged by keyset cursors, a side panel with click-to-filter actions
  // and the surrounding context, a Patterns tab and a live tail. All search
  // state lives in the URL.
  const ns = window.ChDash;
  if (!ns) return;
  const { state, api, util, ui } = ns;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
  const route = (path) => api.resolveUrl(String(path || "").replace(/^\/+/, ""));
  // The Logs view of the Observability page (app_observability.js) writes the
  // location only while it is the shown view.
  const ownsUrl = () => !ns.observability || ns.observability.isActive("logs");

  const SEV_CLASSES = ["error", "warn", "info", "debug"];
  const SEV_LABELS = { error: "Error", warn: "Warn", info: "Info", debug: "Debug" };
  const ROW_HEIGHT = 26;
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
  const SPAN_COLOR_COUNT = 18;
  const SERVICE_COLOR_STORE_KEY = "chdash.traces.serviceColors";

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
    seq: { search: 0, histogram: 0, patterns: 0, context: 0, services: 0, more: 0 },
    searchMs: NaN,
    status: "",
  };

  // --- Small helpers -------------------------------------------------------

  const pad2 = (value) => String(value).padStart(2, "0");
  const pad3 = (value) => String(value).padStart(3, "0");
  const numberFormat = new Intl.NumberFormat("en-US");
  const formatCount = (n) => numberFormat.format(Math.round(Number(n) || 0));

  function compactCount(n) {
    const value = Number(n) || 0;
    if (value >= 1e9) return `${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
    if (value >= 1e4) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`;
    return formatCount(value);
  }

  function currentHost() { return state.selectedHostId || ""; }

  function severityClass(number, text) {
    const n = Number(number) || 0;
    if (n >= 17) return "error";
    if (n >= 13) return "warn";
    if (n >= 9) return "info";
    if (n > 0) return "debug";
    const t = String(text || "").toLowerCase();
    if (/^(fatal|crit|err)/.test(t)) return "error";
    if (/^warn/.test(t)) return "warn";
    if (/^info/.test(t)) return "info";
    return "debug";
  }

  function timeLabel(row) {
    const ms = Number(row.ts_ms);
    const d = new Date(ms);
    return `${d.toLocaleDateString("en-US", { month: "short", day: "2-digit" })} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
  }

  function fullTimeLabel(row) {
    const ms = Number(row.ts_ms);
    const d = new Date(ms);
    const ns9 = String(row.ts_ns || "").slice(-9).padStart(9, "0");
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ns9}`;
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(String(text));
      if (button) {
        button.classList.add("is-copied");
        setTimeout(() => button.classList.remove("is-copied"), 900);
      }
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = String(text);
      document.body.appendChild(area);
      area.select();
      try { document.execCommand("copy"); } catch (__) { /* ignore */ }
      area.remove();
    }
  }

  // Same colour assignment as the Traces page (session-wide, Jaeger's
  // ColorGenerator): a service keeps its colour across both pages.
  const serviceColorSlots = (() => {
    const slots = new Map();
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(SERVICE_COLOR_STORE_KEY) || "null");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [service, slot] of Object.entries(saved)) {
          if (Number.isInteger(slot) && slot >= 0 && slot < SPAN_COLOR_COUNT) slots.set(service, slot);
        }
      }
    } catch (_) { /* no session storage */ }
    return slots;
  })();

  function saveServiceColors() {
    try { window.sessionStorage.setItem(SERVICE_COLOR_STORE_KEY, JSON.stringify(Object.fromEntries(serviceColorSlots))); } catch (_) { /* best effort */ }
  }

  function registerServiceColors(services) {
    const names = [...new Set((services || []).map((s) => String(s || "unknown")))].sort();
    const before = serviceColorSlots.size;
    for (const name of names) if (!serviceColorSlots.has(name)) serviceColorSlots.set(name, serviceColorSlots.size % SPAN_COLOR_COUNT);
    if (serviceColorSlots.size !== before) saveServiceColors();
  }

  function serviceColor(service) {
    const key = String(service || "unknown");
    if (!serviceColorSlots.has(key)) { serviceColorSlots.set(key, serviceColorSlots.size % SPAN_COLOR_COUNT); saveServiceColors(); }
    return `var(--trace-span-color-${serviceColorSlots.get(key) + 1})`;
  }

  // --- URL state -------------------------------------------------------------

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    const to = params.get("to");
    model.timeRange = from && to ? { from, to } : { ...DEFAULT_RANGE };
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

  function urlParams() {
    const params = new URLSearchParams();
    params.set("from", model.timeRange.from);
    params.set("to", model.timeRange.to);
    for (const service of model.services) params.append("service", service);
    if (model.level) params.set("level", model.level);
    for (const sev of model.sev) params.append("sev", sev);
    if (model.q) params.set("q", model.q);
    for (const attr of model.attrs) params.append("attr", attr);
    if (model.traceId) params.set("trace_id", model.traceId);
    if (model.tab !== "results") params.set("tab", model.tab);
    if (model.cols.join(",") !== DEFAULT_COLUMNS.join(",")) params.set("cols", model.cols.join(","));
    if (model.denoise) params.set("denoise", "1");
    return params;
  }

  function writeUrl(push) {
    if (!ownsUrl()) return;
    const next = `${route("observability/logs")}?${urlParams().toString()}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next === current) return;
    if (push) window.history.pushState({ workspace: "logs" }, "", next);
    else window.history.replaceState({ workspace: "logs" }, "", next);
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

  // --- Pickers (the Traces search bar pickers, same markup and motion) ------

  const pickers = new Set();

  function closePicker(root, { immediate = false } = {}) {
    if (!root) return;
    const button = root.querySelector(":scope > .tracePicker__button");
    const menu = root.querySelector(":scope > .tracePicker__menu");
    clearTimeout(root._closeTimer);
    button?.setAttribute("aria-expanded", "false");
    if (immediate || menu?.hidden) {
      root.classList.remove("themeSelect--open", "themeSelect--closing");
      if (menu) menu.hidden = true;
      return;
    }
    root.classList.add("themeSelect--closing");
    requestAnimationFrame(() => root.classList.remove("themeSelect--open"));
    root._closeTimer = setTimeout(() => {
      if (!root.classList.contains("themeSelect--open")) {
        if (menu) menu.hidden = true;
        root.classList.remove("themeSelect--closing");
      }
    }, 160);
  }

  function closePickers(except = null) {
    for (const root of pickers) if (root !== except) closePicker(root);
  }

  function openPicker(root) {
    const button = root?.querySelector(":scope > .tracePicker__button");
    const menu = root?.querySelector(":scope > .tracePicker__menu");
    if (!button || !menu || button.disabled) return;
    closePickers(root);
    clearTimeout(root._closeTimer);
    root.classList.remove("themeSelect--closing");
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      if (button.getAttribute("aria-expanded") !== "true") return;
      root.classList.add("themeSelect--open");
      menu.focus({ preventScroll: true });
    });
  }

  function bindPickerButton(root, onOpen) {
    pickers.add(root);
    const button = root.querySelector(":scope > .tracePicker__button");
    const menu = root.querySelector(":scope > .tracePicker__menu");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (button.getAttribute("aria-expanded") === "true") closePicker(root);
      else { onOpen?.(); openPicker(root); }
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePicker(root);
        button.focus({ preventScroll: true });
      }
    });
  }

  // A native <select> shipped inside its picker root (logs.html markup).
  function enhanceSelect(select, onChange) {
    const root = select.parentElement;
    const button = root.querySelector(":scope > .tracePicker__button");
    const menu = root.querySelector(":scope > .tracePicker__menu");
    const refresh = () => {
      const selected = select.options[select.selectedIndex] || select.options[0];
      const label = select.dataset.fieldLabel || "";
      button.textContent = label ? `${label} · ${selected?.textContent || ""}` : selected?.textContent || "";
      menu.innerHTML = "";
      for (const option of select.options) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "themeSelect__option tracePicker__option";
        item.setAttribute("role", "option");
        item.dataset.value = option.value;
        item.textContent = option.textContent;
        item.setAttribute("aria-selected", option.value === select.value ? "true" : "false");
        item.addEventListener("click", () => {
          select.value = option.value;
          refresh();
          closePicker(root);
          onChange?.(select.value);
        });
        menu.appendChild(item);
      }
    };
    bindPickerButton(root);
    refresh();
    return { refresh };
  }

  let timePicker = null;

  function initTimePicker() {
    const select = $("logsRangeUnit");
    const root = select?.parentElement;
    if (!ns.timeRange || !root) return;
    pickers.add(root);
    timePicker = ns.timeRange.mountPicker({
      button: root.querySelector(":scope > .tracePicker__button"),
      menu: root.querySelector(":scope > .tracePicker__menu"),
      select,
      fromInput: $("logsRangeStart"),
      toInput: $("logsRangeEnd"),
      fromError: $("logsRangeStartError"),
      toError: $("logsRangeEndError"),
      rangeError: $("logsRangeError"),
      calendar: $("logsTimeCalendar"),
      hint: $("logsTimeCalendarHint"),
      applyButton: $("logsCustomRangeApply"),
      quickSearch: $("logsQuickRangeSearch"),
      lists: $("logsQuickRanges"),
      timeZone: $("logsTimeZone"),
      shiftBack: $("logsRangeShiftBack"),
      shiftForward: $("logsRangeShiftForward"),
      zoomOut: $("logsRangeZoomOut"),
    }, {
      getValue: () => model.timeRange,
      getMaxMinutes: maxRangeMinutes,
      settingName: "logs.max_lookback_minutes",
      onApply: (raw) => {
        model.timeRange = { from: String(raw?.from || ""), to: String(raw?.to || "") };
        closePicker(root);
        timePicker?.refresh();
        void search({ push: true });
      },
      open: () => openPicker(root),
      close: () => closePicker(root),
    });
  }

  // --- Service multi picker ----------------------------------------------------

  function renderServiceButton() {
    const button = $("logsServiceButton");
    if (!button) return;
    const n = model.services.length;
    button.textContent = n === 0 ? "Service · ALL" : n === 1 ? `Service · ${model.services[0]}` : `Service · ${n} selected`;
    button.title = n ? model.services.join(", ") : "All services";
  }

  function renderServiceMenu() {
    const menu = $("logsServiceMenu");
    if (!menu) return;
    const names = [...new Set([...model.serviceChoices.map((s) => s.name), ...model.services])].sort();
    const counts = new Map(model.serviceChoices.map((s) => [s.name, s.count]));
    registerServiceColors(names);
    const selected = new Set(model.services);
    menu.innerHTML = `<div class="logsMultiPicker__actions"><button type="button" class="logsMiniButton" data-service-all>All services</button></div>` +
      (names.length ? names.map((name) => `
        <label class="logsMultiPicker__option" role="option" aria-selected="${selected.has(name)}">
          <input type="checkbox" value="${esc(name)}" ${selected.has(name) ? "checked" : ""} />
          <i class="logsServiceDot" style="background:${serviceColor(name)}"></i>
          <span class="logsMultiPicker__name">${esc(name)}</span>
          <span class="logsMultiPicker__count">${counts.has(name) ? compactCount(counts.get(name)) : ""}</span>
        </label>`).join("") : '<div class="logsMultiPicker__empty">No services in this range.</div>');
  }

  function initServicePicker() {
    const root = $("logsServicePicker");
    if (!root) return;
    bindPickerButton(root, renderServiceMenu);
    const menu = $("logsServiceMenu");
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

  let filterSearchTimer = 0;
  function scheduleFilterSearch() {
    clearTimeout(filterSearchTimer);
    filterSearchTimer = setTimeout(() => { void search({ push: true }); }, 350);
  }

  async function loadServiceChoices(range) {
    const seq = ++model.seq.services;
    try {
      const params = new URLSearchParams();
      if (currentHost()) params.set("host_id", currentHost());
      params.set("start_ms", String(range.start_ms));
      params.set("end_ms", String(range.end_ms));
      const payload = await api.getLogs("services", params);
      if (seq !== model.seq.services) return;
      model.serviceChoices = Array.isArray(payload.services) ? payload.services : [];
      registerServiceColors(model.serviceChoices.map((s) => s.name));
      if ($("logsServiceMenu") && !$("logsServiceMenu").hidden) renderServiceMenu();
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
    const box = $("logsChips");
    if (!box) return;
    const chips = [];
    if (model.traceId) chips.push({ kind: "trace", text: `TraceId = ${model.traceId}`, title: "Trace filter" });
    for (const sev of model.sev) chips.push({ kind: "sev", value: sev, text: `Level: ${SEV_LABELS[sev]}`, title: "Severity class" });
    for (const attr of model.attrs) {
      const { key, value, negate } = parseAttr(attr);
      chips.push({ kind: "attr", value: attr, text: `${attrLabel(key)} ${negate ? "\u2260" : "="} ${value}`, title: key, negate });
    }
    box.hidden = chips.length === 0;
    box.innerHTML = chips.map((chip) => `
      <span class="logsChip${chip.negate ? " is-negated" : ""}" title="${esc(chip.title)}">
        <span class="logsChip__text">${esc(chip.text)}</span>
        <button type="button" class="logsChip__remove" data-chip-kind="${chip.kind}" data-chip-value="${esc(chip.value || "")}" aria-label="Remove filter ${esc(chip.text)}">×</button>
      </span>`).join("") + (chips.length > 1 ? '<button type="button" class="logsMiniButton" data-chip-clear>Clear filters</button>' : "");
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

  // --- Errors and status -----------------------------------------------------------

  function showError(message) {
    const box = $("logsError");
    if (!box) return;
    box.textContent = message || "";
    box.hidden = !message;
  }

  function setStatus(text) {
    model.status = text;
    const node = $("logsStatus");
    if (node) node.textContent = text;
  }

  function setSearching(on) {
    model.searching = on;
    const button = $("logsSearchButton");
    if (button) { button.classList.toggle("is-loading", on); button.disabled = on; }
  }

  // --- Search ------------------------------------------------------------------------

  async function search({ push = false, keepLive = false } = {}) {
    closePickers();
    if (!keepLive && model.live) stopLive();
    let range;
    try {
      range = resolvedRange();
    } catch (error) {
      showError(error.message);
      return;
    }
    showError("");
    writeUrl(push);
    renderChips();
    syncLegend();
    const seq = ++model.seq.search;
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
    if (model.tab === "patterns") void loadPatterns();
    const started = performance.now();
    try {
      const params = filterParams(range);
      const payload = await api.getLogs("search", params);
      if (seq !== model.seq.search) return;
      model.searchMs = performance.now() - started;
      appendRows(payload.rows || []);
      model.nextCursor = payload.next_cursor || null;
      model.exhausted = !model.nextCursor;
      model.lastPayload = payload;
      renderTable();
      renderStatus();
      if (model.selectedId && !model.rowIds.has(model.selectedId)) closeSidePanel();
    } catch (error) {
      if (seq !== model.seq.search) return;
      model.rows = [];
      renderTable({ message: "error", error: error.message });
      setStatus("");
      showError(error.message);
    } finally {
      if (seq === model.seq.search) setSearching(false);
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
    registerServiceColors(services);
  }

  async function loadMore() {
    if (model.loadingMore || model.searching || !model.nextCursor || !model.lastSearch) return;
    if (model.rows.length >= MAX_ROWS) return;
    model.loadingMore = true;
    const seq = model.seq.search;
    renderTable();
    try {
      const params = filterParams(model.lastSearch);
      params.set("cursor", model.nextCursor);
      const payload = await api.getLogs("search", params);
      if (seq !== model.seq.search) return;
      appendRows(payload.rows || []);
      model.nextCursor = payload.next_cursor || null;
      model.exhausted = !model.nextCursor;
      model.lastPayload = payload;
    } catch (error) {
      if (seq === model.seq.search) showError(error.message);
    } finally {
      if (seq === model.seq.search) {
        model.loadingMore = false;
        renderTable();
        renderStatus();
      }
    }
  }

  function renderStatus() {
    const n = model.rows.length;
    const parts = [];
    if (!n) {
      setStatus(model.lastSearch ? "No matching logs" : "");
      return;
    }
    parts.push(`${formatCount(n)} log${n === 1 ? "" : "s"} shown`);
    if (model.nextCursor && model.lastPayload?.budget_exhausted) {
      parts.push(`scan paused at ${ns.timeRange.formatDateTime(model.lastPayload.scanned_from_ms)} · scroll to continue`);
    } else if (model.nextCursor) {
      parts.push(model.rows.length >= MAX_ROWS ? `display limit ${formatCount(MAX_ROWS)} reached` : "more available · scroll to load");
    }
    else parts.push("end of range");
    if (model.live) parts.push(model.liveGap ? "live · burst: older new logs skipped" : "live");
    if (Number.isFinite(model.searchMs)) parts.push(`${Math.round(model.searchMs)} ms`);
    setStatus(parts.join(" · "));
  }

  // --- Table (virtualised) -----------------------------------------------------------

  function columnTemplate() {
    return model.cols.map((col) => (COLUMN_DEFS[col] ? COLUMN_DEFS[col].width : "minmax(80px, 150px)")).join(" ");
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
      case "time": return `<span class="logsCell logsCell--time" title="${esc(fullTimeLabel(row))}">${esc(timeLabel(row))}</span>`;
      case "severity": {
        const sev = severityClass(row.severity_number, row.severity_text);
        return `<span class="logsCell logsCell--sev"><span class="logsSevBadge logsSev--${sev}" title="SeverityNumber ${esc(row.severity_number)}">${esc(row.severity_text || sev.toUpperCase())}</span></span>`;
      }
      case "service": return `<span class="logsCell logsCell--service" title="${esc(row.service)}"><i class="logsServiceDot" style="background:${serviceColor(row.service)}"></i>${esc(row.service)}</span>`;
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
    const head = $("logsTableHead");
    if (!head) return;
    head.style.gridTemplateColumns = columnTemplate();
    head.innerHTML = model.cols.map((col) => `<span class="logsTable__th" role="columnheader">${esc(columnLabel(col))}</span>`).join("");
  }

  function emptyHtml() {
    const bounds = model.meta?.time_bounds;
    let hint = "";
    if (bounds && model.lastSearch && (model.lastSearch.start_ms > bounds.max_ms || model.lastSearch.end_ms < bounds.min_ms)) {
      hint = `<p>The table holds logs from ${esc(ns.timeRange.formatDateTime(bounds.min_ms))} to ${esc(ns.timeRange.formatDateTime(bounds.max_ms))}.</p>
        <button type="button" class="button button--small" data-jump-latest>Show the last hour of data</button>`;
    }
    const filtered = model.services.length || model.level || model.sev.length || model.q || model.attrs.length || model.traceId;
    return `<div class="logsEmpty"><strong>No logs match${filtered ? " these filters" : ""} in this time range.</strong>${hint}</div>`;
  }

  function renderTable({ message = null, error = "" } = {}) {
    const viewport = $("logsTableViewport");
    const messageBox = $("logsTableMessage");
    const spacer = $("logsTableSpacer");
    if (!viewport || !messageBox || !spacer) return;
    renderHead();
    if (message === "loading" && !model.rows.length) {
      messageBox.hidden = false;
      messageBox.innerHTML = '<div class="logsEmpty logsEmpty--loading"><span class="traceButtonSpinner is-visible" aria-hidden="true"></span>Searching logs\u2026</div>';
      spacer.style.height = "0px";
      $("logsTableRows").innerHTML = "";
      return;
    }
    if (message === "error") {
      messageBox.hidden = false;
      messageBox.innerHTML = `<div class="logsEmpty logsEmpty--error"><strong>Search failed.</strong><p>${esc(error)}</p></div>`;
      spacer.style.height = "0px";
      $("logsTableRows").innerHTML = "";
      return;
    }
    if (!model.rows.length) {
      messageBox.hidden = false;
      messageBox.innerHTML = model.lastSearch ? emptyHtml() : '<div class="tracesEmpty">Search to load logs.</div>';
      spacer.style.height = "0px";
      $("logsTableRows").innerHTML = "";
      return;
    }
    messageBox.hidden = true;
    const footer = model.nextCursor || model.loadingMore ? 1 : 0;
    spacer.style.height = `${(model.rows.length + footer) * ROW_HEIGHT}px`;
    renderWindow(true);
  }

  let renderedRange = "";
  function renderWindow(force = false) {
    const viewport = $("logsTableViewport");
    const box = $("logsTableRows");
    if (!viewport || !box || !model.rows.length) return;
    const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const visible = Math.ceil((viewport.clientHeight || 600) / ROW_HEIGHT) + OVERSCAN * 2;
    const last = Math.min(model.rows.length, first + visible);
    const key = `${first}:${last}:${model.rows.length}:${model.selectedId}:${model.cols.join(",")}:${model.loadingMore}:${!!model.nextCursor}`;
    if (!force && key === renderedRange) return;
    renderedRange = key;
    const template = columnTemplate();
    let html = "";
    for (let i = first; i < last; i += 1) {
      const row = model.rows[i];
      const sev = severityClass(row.severity_number, row.severity_text);
      const classes = ["logsRow", `logsRow--${sev}`];
      if (row.id === model.selectedId) classes.push("is-selected");
      if (model.newIds.has(row.id)) classes.push("is-new");
      html += `<div class="${classes.join(" ")}" role="row" data-row-index="${i}" data-row-id="${esc(row.id)}" style="grid-template-columns:${template}">${model.cols.map((col) => cellHtml(row, col)).join("")}</div>`;
    }
    if (last === model.rows.length && (model.nextCursor || model.loadingMore)) {
      html += `<div class="logsRow logsRow--more" role="row">${model.loadingMore ? '<span class="traceButtonSpinner is-visible" aria-hidden="true"></span>Loading older logs\u2026' : '<button type="button" class="logsMiniButton" data-load-more>Load older logs</button>'}</div>`;
    }
    box.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
    box.innerHTML = html;
    if (last >= model.rows.length - 5 && model.nextCursor && !model.loadingMore && !model.live) void loadMore();
  }

  function initTable() {
    const viewport = $("logsTableViewport");
    const box = $("logsTableRows");
    const message = $("logsTableMessage");
    if (!viewport || !box) return;
    let frame = 0;
    viewport.addEventListener("scroll", () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; renderWindow(); });
    }, { passive: true });
    new ResizeObserver(() => renderWindow(true)).observe(viewport);
    box.addEventListener("click", (event) => {
      if (event.target.closest("[data-load-more]")) { void loadMore(); return; }
      const rowEl = event.target.closest(".logsRow[data-row-index]");
      if (!rowEl) return;
      const row = model.rows[Number(rowEl.dataset.rowIndex)];
      if (row) openSidePanel(row);
    });
    message?.addEventListener("click", (event) => {
      if (!event.target.closest("[data-jump-latest]")) return;
      const bounds = model.meta?.time_bounds;
      if (!bounds) return;
      const tr = ns.timeRange;
      model.timeRange = { from: tr.formatDateTime(bounds.max_ms - 3600000), to: tr.formatDateTime(bounds.max_ms + 1000) };
      timePicker?.refresh();
      void search({ push: true });
    });
    $("logsTable")?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!model.rows.length) return;
      event.preventDefault();
      const index = model.rows.findIndex((row) => row.id === model.selectedId);
      const next = Math.max(0, Math.min(model.rows.length - 1, index < 0 ? 0 : index + (event.key === "ArrowDown" ? 1 : -1)));
      openSidePanel(model.rows[next]);
      scrollRowIntoView(next);
    });
  }

  function scrollRowIntoView(index) {
    const viewport = $("logsTableViewport");
    if (!viewport) return;
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    renderWindow(true);
  }

  // --- Columns picker -----------------------------------------------------------------

  function renderColumnsMenu() {
    const menu = $("logsColumnsMenu");
    if (!menu) return;
    const attrCols = model.cols.filter((c) => c.startsWith("attr:"));
    const option = (col, label) => `
      <label class="logsMultiPicker__option" role="option" aria-selected="${model.cols.includes(col)}">
        <input type="checkbox" value="${esc(col)}" ${model.cols.includes(col) ? "checked" : ""} />
        <span class="logsMultiPicker__name">${esc(label)}</span>
      </label>`;
    menu.innerHTML = OPTIONAL_COLUMNS.map((col) => option(col, COLUMN_DEFS[col].label)).join("") +
      attrCols.map((col) => option(col, col.slice(5))).join("") +
      `<form class="logsColumnsAdd" data-columns-add><input type="text" placeholder="Attribute column, e.g. http.route" aria-label="Add attribute column" spellcheck="false" /><button type="submit" class="logsMiniButton">Add</button></form>`;
  }

  function setColumns(cols) {
    const ordered = [...OPTIONAL_COLUMNS.filter((c) => cols.includes(c)), ...cols.filter((c) => c.startsWith("attr:"))];
    model.cols = [...new Set([...ordered, "body"])];
    writeUrl(false);
    renderTable();
  }

  function initColumnsPicker() {
    const root = $("logsColumnsPicker");
    if (!root) return;
    bindPickerButton(root, renderColumnsMenu);
    const menu = $("logsColumnsMenu");
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
      const input = event.target.querySelector("input");
      const key = String(input?.value || "").trim();
      if (!key) return;
      setColumns([...model.cols, `attr:${key}`]);
      renderColumnsMenu();
    });
  }

  // --- Histogram ------------------------------------------------------------------------

  const TIME_STEPS = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5];

  function tickLabel(ms, step, multiDay) {
    const d = new Date(ms);
    const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}${step < 60000 ? `:${pad2(d.getSeconds())}` : ""}`;
    const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (step >= 864e5 || (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0)) return day;
    return multiDay ? `${day} ${clock}` : clock;
  }

  function axisTicks(startMs, endMs, width) {
    const span = Math.max(1, endMs - startMs);
    const multiDay = span > 864e5;
    const sample = multiDay ? "Sep 30 12:00" : "00:00:00";
    let step = TIME_STEPS[TIME_STEPS.length - 1];
    for (const candidate of TIME_STEPS) {
      if (span / candidate > 40) continue;
      if (width * candidate / span >= sample.length * 6 + 22) { step = candidate; break; }
    }
    const ticks = [];
    // Local wall-clock ticks: grid anchored at the local midnight.
    const origin = localMidnight(startMs);
    let t = origin + Math.ceil((startMs - origin) / step) * step;
    for (let guard = 0; t <= endMs && guard < 200; guard += 1, t += step) ticks.push({ t, label: tickLabel(t, step, multiDay) });
    return ticks;
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const exp = Math.pow(10, Math.floor(Math.log10(value)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= value) return m * exp;
    return 10 * exp;
  }

  async function loadHistogram(range) {
    const seq = ++model.seq.histogram;
    model.histogramLoading = true;
    model.histogramError = "";
    renderHistogram();
    try {
      const params = filterParams(range);
      params.set("bucket_origin_ms", String(localMidnight(range.start_ms)));
      const width = $("logsHistogram")?.clientWidth || 1000;
      params.set("buckets", String(Math.max(20, Math.min(160, Math.round(width / 9)))));
      const payload = await api.getLogs("histogram", params);
      if (seq !== model.seq.histogram) return;
      model.histogram = payload;
    } catch (error) {
      if (seq !== model.seq.histogram) return;
      model.histogram = null;
      model.histogramError = error.message;
    } finally {
      if (seq === model.seq.histogram) {
        model.histogramLoading = false;
        renderHistogram();
      }
    }
  }

  function renderHistogram() {
    const box = $("logsHistogram");
    const total = $("logsTotal");
    const meta = $("logsHistogramMeta");
    if (!box) return;
    const h = model.histogram;
    for (const sev of SEV_CLASSES) {
      const node = document.querySelector(`[data-sev-count="${sev}"]`);
      if (node) node.textContent = h ? compactCount(h.totals?.[sev] || 0) : "";
    }
    if (model.histogramLoading && !h) {
      box.innerHTML = '<div class="logsHistogram__placeholder">Loading volume\u2026</div>';
      if (total) total.textContent = "\u2013";
      return;
    }
    if (model.histogramError) {
      box.innerHTML = `<div class="logsHistogram__placeholder is-error">${esc(model.histogramError)}</div>`;
      if (total) total.textContent = "\u2013";
      return;
    }
    if (!h) return;
    const count = Number(h.totals?.total || 0);
    if (total) total.textContent = `${formatCount(count)} log${count === 1 ? "" : "s"}`;
    if (meta) meta.textContent = `${ns.timeRange.describeRange(model.timeRange).text} · ${Math.round(h.bucket_ms / 1000) >= 60 ? `${Math.round(h.bucket_ms / 60000)} min` : `${Math.round(h.bucket_ms / 1000)} s`} buckets${model.histogramLoading ? " · updating\u2026" : ""}`;
    const width = Math.max(200, box.clientWidth || 800);
    const height = 116;
    const left = 44, right = 8, top = 8, bottom = 20;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const [startMs, endMs] = h.range;
    const x = (t) => left + ((t - startMs) / Math.max(1, endMs - startMs)) * plotW;
    const buckets = (h.buckets || []).map((b) => ({ t: b[0], error: b[1], warn: b[2], info: b[3], debug: b[4], sum: b[1] + b[2] + b[3] + b[4] }));
    const maxValue = niceMax(Math.max(1, ...buckets.map((b) => b.sum)));
    const y = (v) => top + plotH - (v / maxValue) * plotH;
    let bars = "";
    for (const b of buckets) {
      const x0 = Math.max(left, x(b.t));
      const x1 = Math.min(left + plotW, x(b.t + h.bucket_ms));
      const w = Math.max(1, x1 - x0 - (x1 - x0 > 4 ? 1 : 0));
      if (x1 <= left || x0 >= left + plotW) continue;
      let acc = 0;
      for (const sev of ["debug", "info", "warn", "error"]) {
        const v = b[sev];
        if (!v) continue;
        const y0 = y(acc + v);
        const y1 = y(acc);
        bars += `<rect class="logsBar logsSevFill--${sev}" x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0.5, y1 - y0).toFixed(1)}"></rect>`;
        acc += v;
      }
    }
    const grid = [0.5, 1].map((f) => `<line class="logsHistogram__grid" x1="${left}" x2="${left + plotW}" y1="${y(maxValue * f).toFixed(1)}" y2="${y(maxValue * f).toFixed(1)}"></line><text class="logsHistogram__yLabel" x="${left - 6}" y="${(y(maxValue * f) + 3).toFixed(1)}" text-anchor="end">${esc(compactCount(maxValue * f))}</text>`).join("");
    const ticks = axisTicks(startMs, endMs, plotW).map((tick) => `<line class="logsHistogram__tick" x1="${x(tick.t).toFixed(1)}" x2="${x(tick.t).toFixed(1)}" y1="${top + plotH}" y2="${top + plotH + 3}"></line><text class="logsHistogram__xLabel" x="${x(tick.t).toFixed(1)}" y="${height - 5}" text-anchor="middle">${esc(tick.label)}</text>`).join("");
    box.innerHTML = `<svg class="logsHistogram__svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Log volume by severity">
      ${grid}<line class="logsHistogram__axis" x1="${left}" x2="${left + plotW}" y1="${top + plotH}" y2="${top + plotH}"></line>${bars}${ticks}
      <rect class="logsHistogram__hit" x="${left}" y="${top}" width="${plotW}" height="${plotH}"></rect>
      <rect class="logsHistogram__brush" x="0" y="${top}" width="0" height="${plotH}" hidden></rect>
    </svg><div class="logsHistogram__tooltip" hidden></div>`;
    box._geometry = { left, plotW, top, plotH, startMs, endMs, buckets, bucketMs: h.bucket_ms };
  }

  function initHistogram() {
    const box = $("logsHistogram");
    if (!box) return;
    let drag = null;
    const toMs = (clientX) => {
      const g = box._geometry;
      const rect = box.querySelector("svg")?.getBoundingClientRect();
      if (!g || !rect) return NaN;
      const px = Math.max(g.left, Math.min(g.left + g.plotW, clientX - rect.left));
      return g.startMs + ((px - g.left) / g.plotW) * (g.endMs - g.startMs);
    };
    const pxOf = (clientX) => {
      const g = box._geometry;
      const rect = box.querySelector("svg")?.getBoundingClientRect();
      return Math.max(g.left, Math.min(g.left + g.plotW, clientX - rect.left));
    };
    box.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".logsHistogram__hit") || !box._geometry) return;
      event.preventDefault();
      drag = { x0: pxOf(event.clientX), ms0: toMs(event.clientX) };
      box.setPointerCapture?.(event.pointerId);
    });
    box.addEventListener("pointermove", (event) => {
      const g = box._geometry;
      if (!g) return;
      const tooltip = box.querySelector(".logsHistogram__tooltip");
      if (drag) {
        const brush = box.querySelector(".logsHistogram__brush");
        const x1 = pxOf(event.clientX);
        brush.removeAttribute("hidden");
        brush.setAttribute("x", String(Math.min(drag.x0, x1)));
        brush.setAttribute("width", String(Math.abs(x1 - drag.x0)));
        if (tooltip) tooltip.hidden = true;
        return;
      }
      if (!event.target.closest(".logsHistogram__hit")) { if (tooltip) tooltip.hidden = true; return; }
      const ms = toMs(event.clientX);
      const bucket = g.buckets.find((b) => ms >= b.t && ms < b.t + g.bucketMs);
      if (!tooltip) return;
      if (!bucket) { tooltip.hidden = true; return; }
      const tr = ns.timeRange;
      tooltip.innerHTML = `<strong>${esc(tr.formatDateTime(bucket.t))} \u2192 ${esc(tr.formatDateTime(bucket.t + g.bucketMs).slice(11))}</strong>` +
        ["error", "warn", "info", "debug"].map((sev) => `<span><i class="logsSevSwatch logsSev--${sev}"></i>${SEV_LABELS[sev]}<b>${formatCount(bucket[sev])}</b></span>`).join("") +
        `<span class="logsHistogram__tooltipTotal">Total<b>${formatCount(bucket.sum)}</b></span>`;
      tooltip.hidden = false;
      const rect = box.getBoundingClientRect();
      const px = event.clientX - rect.left;
      tooltip.style.left = `${Math.min(rect.width - 180, Math.max(0, px + 12))}px`;
    });
    const finish = (event) => {
      if (!drag) return;
      const g = box._geometry;
      const x1 = pxOf(event.clientX);
      const ms1 = toMs(event.clientX);
      const d = drag;
      drag = null;
      box.querySelector(".logsHistogram__brush")?.setAttribute("hidden", "");
      if (!g || Math.abs(x1 - d.x0) < 4) return;
      const startMs = Math.floor(Math.min(d.ms0, ms1) / 1000) * 1000;
      const endMs = Math.ceil(Math.max(d.ms0, ms1) / 1000) * 1000;
      if (endMs - startMs < 1000) return;
      const tr = ns.timeRange;
      model.timeRange = { from: tr.formatDateTime(startMs), to: tr.formatDateTime(endMs) };
      timePicker?.refresh();
      void search({ push: true });
    };
    box.addEventListener("pointerup", finish);
    box.addEventListener("pointercancel", () => { drag = null; box.querySelector(".logsHistogram__brush")?.setAttribute("hidden", ""); });
    box.addEventListener("pointerleave", () => { const t = box.querySelector(".logsHistogram__tooltip"); if (t && !drag) t.hidden = true; });
    let lastWidth = 0;
    new ResizeObserver(() => {
      const w = box.clientWidth;
      if (Math.abs(w - lastWidth) > 2) { lastWidth = w; renderHistogram(); }
    }).observe(box);
    document.getElementById("logsLegend")?.addEventListener("click", (event) => {
      const item = event.target.closest("[data-sev]");
      if (!item) return;
      const sev = item.dataset.sev;
      model.sev = model.sev.includes(sev) ? model.sev.filter((s) => s !== sev) : SEV_CLASSES.filter((s) => s === sev || model.sev.includes(s));
      void search({ push: true });
    });
  }

  function syncLegend() {
    for (const item of document.querySelectorAll("#logsLegend [data-sev]")) {
      const on = model.sev.includes(item.dataset.sev);
      item.setAttribute("aria-pressed", String(on));
      item.classList.toggle("is-dimmed", model.sev.length > 0 && !on);
    }
  }

  // --- Patterns -----------------------------------------------------------------------------

  function patternsKey(range) { return `${currentHost()}|${filterParams(range).toString()}`; }

  async function loadPatterns() {
    if (!model.lastSearch) return;
    const range = model.lastSearch;
    const key = patternsKey(range);
    if (key === model.patternsKey && (model.patterns || model.patternsLoading)) { renderPatterns(); return; }
    model.patternsKey = key;
    const seq = ++model.seq.patterns;
    model.patternsLoading = true;
    model.patternsError = "";
    renderPatterns();
    try {
      const payload = await api.getLogs("patterns", filterParams(range));
      if (seq !== model.seq.patterns) return;
      model.patterns = payload;
    } catch (error) {
      if (seq !== model.seq.patterns) return;
      model.patterns = null;
      model.patternsError = error.message;
    } finally {
      if (seq === model.seq.patterns) {
        model.patternsLoading = false;
        renderPatterns();
      }
    }
  }

  function sparklineSvg(values, sev) {
    const w = 120, h = 24;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? w / (values.length - 1) : w;
    const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg class="logsSparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline class="logsSparkline__line logsSevStroke--${sev}" points="${points}"></polyline></svg>`;
  }

  function patternHtml(text) {
    return esc(text).replace(/&lt;\*&gt;/g, '<span class="logsPattern__var">&lt;*&gt;</span>');
  }

  function renderPatterns() {
    const box = $("logsPatterns");
    if (!box) return;
    const toggle = $("logsDenoiseToggle");
    if (toggle) toggle.hidden = model.tab !== "patterns";
    if (model.patternsLoading && !model.patterns) {
      box.innerHTML = '<div class="logsEmpty logsEmpty--loading"><span class="traceButtonSpinner is-visible" aria-hidden="true"></span>Mining patterns from a sample\u2026</div>';
      return;
    }
    if (model.patternsError) {
      box.innerHTML = `<div class="logsEmpty logsEmpty--error"><strong>Patterns failed.</strong><p>${esc(model.patternsError)}</p></div>`;
      return;
    }
    const p = model.patterns;
    if (!p) { box.innerHTML = '<div class="tracesEmpty">Search to mine patterns.</div>'; return; }
    const all = p.patterns || [];
    const hidden = model.denoise ? all.filter((item) => item.noisy).length : 0;
    const shown = model.denoise ? all.filter((item) => !item.noisy) : all;
    const summary = p.total
      ? `${formatCount(p.pattern_count)} pattern${p.pattern_count === 1 ? "" : "s"} in ${p.sampled ? `a sample of ${formatCount(p.sample_size)} of ${formatCount(p.total)} logs (counts ×${p.scale >= 10 ? Math.round(p.scale) : p.scale.toFixed(1)})` : `${formatCount(p.total)} logs`}${hidden ? ` · denoise hides ${hidden} pattern${hidden === 1 ? "" : "s"} above 10 %` : ""}${model.patternsLoading ? " · updating\u2026" : ""}`
      : "";
    if (!all.length) {
      box.innerHTML = `<div class="logsEmpty"><strong>No logs to mine in this range.</strong></div>`;
      return;
    }
    box.innerHTML = `<div class="logsPatterns__summary">${esc(summary)}</div>
      <div class="logsPatterns__table" role="table" aria-label="Log patterns">
        <div class="logsPatterns__head" role="row"><span>Count</span><span>Share</span><span>Trend</span><span>Pattern</span></div>
        ${shown.map((item) => `
          <button type="button" class="logsPatternRow" role="row" data-pattern-index="${all.indexOf(item)}" title="Filter by this pattern: ${esc(item.search)}">
            <span class="logsPatternRow__count">${compactCount(item.count)}</span>
            <span class="logsPatternRow__share"><span class="logsShareBar"><i style="width:${Math.max(1, Math.round(item.share * 100))}%"></i></span>${(item.share * 100).toFixed(item.share >= 0.1 ? 0 : 1)}%</span>
            <span class="logsPatternRow__trend">${sparklineSvg(item.sparkline || [], item.severity)}</span>
            <span class="logsPatternRow__text">
              <span class="logsPattern"><span class="logsSevBadge logsSev--${item.severity}">${esc(item.severity.toUpperCase())}</span>${patternHtml(item.pattern)}</span>
              <span class="logsPattern__sample"><i class="logsServiceDot" style="background:${serviceColor(item.service)}"></i>${esc(item.service)}${item.service_count > 1 ? ` +${item.service_count - 1}` : ""} · ${esc(item.sample)}</span>
            </span>
          </button>`).join("")}
      </div>`;
  }

  function initPatterns() {
    $("logsPatterns")?.addEventListener("click", (event) => {
      const rowEl = event.target.closest("[data-pattern-index]");
      if (!rowEl || !model.patterns) return;
      const item = model.patterns.patterns[Number(rowEl.dataset.patternIndex)];
      if (!item) return;
      model.q = item.search;
      const input = $("logsQuery");
      if (input) input.value = model.q;
      setTab("results", { push: false });
      void search({ push: true });
    });
    $("logsDenoise")?.addEventListener("change", (event) => {
      model.denoise = !!event.target.checked;
      writeUrl(false);
      renderPatterns();
    });
  }

  function setTab(tab, { push = false } = {}) {
    model.tab = tab === "patterns" ? "patterns" : "results";
    for (const button of document.querySelectorAll(".logsTabs [data-tab]")) {
      const on = button.dataset.tab === model.tab;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
    }
    $("logsResultsPane").hidden = model.tab !== "results";
    $("logsPatternsPane").hidden = model.tab !== "patterns";
    const cols = $("logsColumnsPicker");
    if (cols) cols.hidden = model.tab !== "results";
    const denoise = $("logsDenoiseToggle");
    if (denoise) denoise.hidden = model.tab !== "patterns";
    writeUrl(push);
    if (model.tab === "patterns") void loadPatterns();
    else renderTable();
  }

  // --- Side panel --------------------------------------------------------------------------

  function openSidePanel(row, { tab = null } = {}) {
    if (!row) return;
    model.selectedId = row.id;
    model.side.row = row;
    if (tab) model.side.tab = tab;
    model.side.context = null;
    model.side.contextError = "";
    const panel = $("logsSidePanel");
    if (panel) panel.hidden = false;
    document.querySelector(".logsBody")?.classList.add("has-side");
    renderSidePanel();
    renderWindow(true);
    if (model.side.tab === "context") void loadContext();
  }

  function closeSidePanel() {
    model.selectedId = "";
    model.side.row = null;
    const panel = $("logsSidePanel");
    if (panel) panel.hidden = true;
    document.querySelector(".logsBody")?.classList.remove("has-side");
    renderWindow(true);
  }

  const ACTION_ICONS = {
    filter: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v5M5.5 8h5"/></svg>',
    exclude: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/></svg>',
    only: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13.5 13.5"/></svg>',
    copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5"/></svg>',
  };

  function fieldActions(key, value) {
    const k = esc(key), v = esc(value);
    return `<span class="logsField__actions">
      <button type="button" class="logsFieldAction" data-field-action="filter" data-key="${k}" data-value="${v}" title="Filter for value" aria-label="Filter for ${k} = value">${ACTION_ICONS.filter}</button>
      <button type="button" class="logsFieldAction" data-field-action="exclude" data-key="${k}" data-value="${v}" title="Exclude value" aria-label="Exclude ${k} = value">${ACTION_ICONS.exclude}</button>
      <button type="button" class="logsFieldAction" data-field-action="only" data-key="${k}" data-value="${v}" title="Search only this" aria-label="Search only ${k} = value">${ACTION_ICONS.only}</button>
      <button type="button" class="logsFieldAction" data-field-action="copy" data-key="${k}" data-value="${v}" title="Copy value" aria-label="Copy ${k} value">${ACTION_ICONS.copy}</button>
    </span>`;
  }

  function fieldRow(label, key, value, { mono = false, actions = true } = {}) {
    const text = String(value == null ? "" : value);
    return `<div class="logsField">
      <span class="logsField__key" title="${esc(key)}">${esc(label)}</span>
      <span class="logsField__value${mono ? " logsField__value--mono" : ""}">${esc(text)}</span>
      ${actions ? fieldActions(key, text) : ""}
    </div>`;
  }

  function mapSection(title, column, map) {
    const entries = Object.entries(map || {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `<section class="logsFieldGroup">
      <h4>${esc(title)} <span>${entries.length}</span></h4>
      ${entries.length ? entries.map(([k, v]) => fieldRow(k, `${column}.${k}`, v)).join("") : '<div class="logsField logsField--empty">none</div>'}
    </section>`;
  }

  function renderSidePanel() {
    const row = model.side.row;
    if (!row) return;
    const sev = severityClass(row.severity_number, row.severity_text);
    const title = $("logsSideTitle");
    if (title) {
      title.innerHTML = `<span class="logsSevBadge logsSev--${sev}">${esc(row.severity_text || sev.toUpperCase())}</span>
        <span class="logsSideTitle__service"><i class="logsServiceDot" style="background:${serviceColor(row.service)}"></i>${esc(row.service)}</span>
        <span class="logsSideTitle__time">${esc(fullTimeLabel(row))}</span>`;
    }
    const openTrace = $("logsOpenTrace");
    if (openTrace) {
      const traced = !!row.trace_id && state.features?.traces?.enabled !== false;
      openTrace.hidden = !traced;
      if (traced) openTrace.href = route(`observability/traces/${encodeURIComponent(row.trace_id)}${row.span_id ? `?span=${encodeURIComponent(row.span_id)}` : ""}`);
    }
    for (const button of document.querySelectorAll(".logsSideTabs [data-side-tab]")) {
      const on = button.dataset.sideTab === model.side.tab;
      button.classList.toggle("is-active", on);
      button.setAttribute("aria-selected", String(on));
    }
    $("logsSideDetails").hidden = model.side.tab !== "details";
    $("logsSideContext").hidden = model.side.tab !== "context";
    const details = $("logsSideDetails");
    if (details) {
      details.innerHTML = `
        <section class="logsFieldGroup logsFieldGroup--body">
          <h4>Body${row.body_truncated ? ` <span>first ${formatCount(row.body.length)} of ${formatCount(row.body_length)} characters</span>` : ""}</h4>
          <pre class="logsBodyText">${esc(row.body)}</pre>
        </section>
        <section class="logsFieldGroup">
          <h4>Record</h4>
          ${fieldRow("Timestamp", "Timestamp", fullTimeLabel(row), { actions: false })}
          ${fieldRow("ServiceName", "ServiceName", row.service)}
          ${fieldRow("SeverityText", "SeverityText", row.severity_text)}
          ${fieldRow("SeverityNumber", "SeverityNumber", row.severity_number, { actions: false })}
          ${row.trace_id ? fieldRow("TraceId", "TraceId", row.trace_id, { mono: true }) : ""}
          ${row.span_id ? fieldRow("SpanId", "SpanId", row.span_id, { mono: true }) : ""}
          ${row.scope_name ? fieldRow("ScopeName", "ScopeName", row.scope_name) : ""}
          ${row.scope_version ? fieldRow("ScopeVersion", "ScopeVersion", row.scope_version) : ""}
        </section>
        ${mapSection("Log attributes", "LogAttributes", row.log_attributes)}
        ${mapSection("Resource attributes", "ResourceAttributes", row.resource_attributes)}
        ${Object.keys(row.scope_attributes || {}).length ? mapSection("Scope attributes", "ScopeAttributes", row.scope_attributes) : ""}`;
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
      const q = $("logsQuery");
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

  function syncContextBar() {
    const row = model.side.row;
    for (const button of document.querySelectorAll("[data-context-preset]")) {
      const preset = button.dataset.contextPreset;
      button.setAttribute("aria-pressed", String(preset === model.side.preset));
      button.disabled = (preset === "host" && !row?.resource_attributes?.["host.name"]) || (preset === "trace" && !row?.trace_id);
    }
    for (const button of document.querySelectorAll("[data-context-window]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.contextWindow) === model.side.windowMs));
    }
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
    const seq = ++model.seq.context;
    model.side.contextLoading = true;
    model.side.contextError = "";
    model.side.anchorId = row.id;
    syncContextBar();
    renderContext();
    try {
      const payload = await api.getLogs("context", params);
      if (seq !== model.seq.context) return;
      model.side.context = payload;
      registerServiceColors((payload.rows || []).map((r) => r.service));
    } catch (error) {
      if (seq !== model.seq.context) return;
      model.side.context = null;
      model.side.contextError = error.message;
    } finally {
      if (seq === model.seq.context) {
        model.side.contextLoading = false;
        renderContext();
        $("logsContextRows")?.querySelector(".is-anchor")?.scrollIntoView({ block: "center" });
      }
    }
  }

  function renderContext() {
    const box = $("logsContextRows");
    if (!box || model.side.tab !== "context") return;
    if (model.side.contextLoading && !model.side.context) { box.innerHTML = '<div class="logsEmpty logsEmpty--loading"><span class="traceButtonSpinner is-visible" aria-hidden="true"></span>Loading surrounding logs\u2026</div>'; return; }
    if (model.side.contextError) { box.innerHTML = `<div class="logsEmpty logsEmpty--error">${esc(model.side.contextError)}</div>`; return; }
    const ctx = model.side.context;
    if (!ctx) { box.innerHTML = ""; return; }
    const rows = ctx.rows || [];
    const anchor = model.side.anchorId;
    box.innerHTML = `${ctx.more_after ? '<div class="logsContext__more">Newer logs continue past the window</div>' : ""}
      ${rows.map((r) => {
        const sev = severityClass(r.severity_number, r.severity_text);
        return `<button type="button" class="logsContextRow${r.id === anchor ? " is-anchor" : ""}" data-context-id="${esc(r.id)}">
          <span class="logsContextRow__time">${esc(timeLabel(r).slice(7))}</span>
          <span class="logsSevBadge logsSev--${sev}">${esc(r.severity_text || sev.toUpperCase())}</span>
          <span class="logsContextRow__service"><i class="logsServiceDot" style="background:${serviceColor(r.service)}"></i>${esc(r.service)}</span>
          <span class="logsContextRow__body">${esc(r.body)}</span>
        </button>`;
      }).join("") || '<div class="logsEmpty">No other logs in this window.</div>'}
      ${ctx.more_before ? '<div class="logsContext__more">Older logs continue past the window</div>' : ""}`;
  }

  function initSidePanel() {
    $("logsSideClose")?.addEventListener("click", closeSidePanel);
    $("logsCopyJson")?.addEventListener("click", (event) => {
      if (model.side.row) void copyText(JSON.stringify(model.side.row, null, 2), event.currentTarget);
    });
    $("logsSideDetails")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-field-action]");
      if (!button) return;
      applyFieldAction(button.dataset.fieldAction, button.dataset.key, button.dataset.value, button);
    });
    for (const button of document.querySelectorAll(".logsSideTabs [data-side-tab]")) {
      button.addEventListener("click", () => {
        model.side.tab = button.dataset.sideTab;
        renderSidePanel();
        if (model.side.tab === "context" && !model.side.context) void loadContext();
      });
    }
    for (const button of document.querySelectorAll("[data-context-preset]")) {
      button.addEventListener("click", () => { model.side.preset = button.dataset.contextPreset; void loadContext(); });
    }
    for (const button of document.querySelectorAll("[data-context-window]")) {
      button.addEventListener("click", () => { model.side.windowMs = Number(button.dataset.contextWindow); void loadContext(); });
    }
    $("logsContextRows")?.addEventListener("click", (event) => {
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
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("logsSidePanel")?.hidden && !document.querySelector(".tracePicker.themeSelect--open")) closeSidePanel();
    });
  }

  // --- Live tail -------------------------------------------------------------------------------

  function syncLiveButton() {
    const button = $("logsLiveButton");
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
    if (document.hidden || model.searching || !ownsUrl()) { scheduleLive(); return; }
    let range;
    try { range = resolvedRange(); } catch (_) { scheduleLive(); return; }
    const newest = model.rows[0];
    const params = filterParams(range);
    if (newest) params.set("after", newest.id);
    const seq = model.seq.search;
    try {
      const payload = newest ? await api.getLogs("search", params) : null;
      if (!model.live || seq !== model.seq.search) return;
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
      if (model.live) setStatus(`Live tail paused on error: ${error.message}`);
    } finally {
      scheduleLive();
    }
  }

  function prependRows(fresh) {
    const viewport = $("logsTableViewport");
    const atTop = !viewport || viewport.scrollTop < ROW_HEIGHT;
    for (const row of fresh) model.rowIds.add(row.id);
    model.newIds = new Set(fresh.map((row) => row.id));
    registerServiceColors(fresh.map((row) => row.service));
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
      model.metaError = error.message;
    }
    const input = $("logsQuery");
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
    const q = $("logsQuery");
    if (q) q.value = model.q;
    levelPicker?.set(model.level);
    renderServiceButton();
    renderChips();
    syncLegend();
    const denoise = $("logsDenoise");
    if (denoise) denoise.checked = model.denoise;
    timePicker?.refresh();
  }

  let levelPicker = null;
  let booted = false;

  async function reloadForHost() {
    await loadMeta();
    if (model.metaError) {
      showError(model.metaError);
      renderTable();
      return;
    }
    await search({ push: false });
  }

  // Back / Forward, or the Observability page showing this view again. The
  // view shown again on the URL it left keeps its results, scroll and side
  // panel (a live tail resumes polling).
  function onLocation() {
    const before = urlParams().toString();
    readUrl();
    syncControls();
    setTab(model.tab, { push: false });
    if (urlParams().toString() === before && model.lastSearch && !model.metaError) return;
    void search({ push: false });
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
    if (context.range) {
      params.set("from", context.range.from);
      params.set("to", context.range.to);
    }
    if (context.service != null) {
      params.delete("service");
      if (context.service) params.append("service", context.service);
    }
  }

  function init() {
    readUrl();
    initTimePicker();
    initServicePicker();
    initColumnsPicker();
    const level = $("logsLevel");
    if (level) {
      const enhanced = enhanceSelect(level, (value) => { model.level = value; void search({ push: true }); });
      levelPicker = { set: (value) => { level.value = value || ""; enhanced.refresh(); } };
    }
    initTable();
    initHistogram();
    initPatterns();
    initSidePanel();
    syncControls();
    setTab(model.tab, { push: false });

    document.addEventListener("click", (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (![...pickers].some((root) => root.contains(event.target) || path.includes(root))) closePickers();
    });

    $("logsForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      model.q = String($("logsQuery")?.value || "");
      const filter = $("logsFilterInput");
      if (filter && filter.value.trim()) {
        if (!addFilterText(filter.value)) return;
        filter.value = "";
      }
      void search({ push: true });
    });
    $("logsFilterInput")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (addFilterText(event.target.value)) {
        event.target.value = "";
        model.q = String($("logsQuery")?.value || "");
        void search({ push: true });
      }
    });
    $("logsChips")?.addEventListener("click", (event) => {
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
    for (const button of document.querySelectorAll(".logsTabs [data-tab]")) {
      button.addEventListener("click", () => setTab(button.dataset.tab, { push: true }));
    }
    $("logsLiveButton")?.addEventListener("click", () => { if (model.live) stopLive(); else void startLive(); });
    window.addEventListener("chdash:host-changed", () => {
      if (ownsUrl()) void reloadForHost();
      else reloadWhenShown = true;
    });
    window.addEventListener("chdash:features-changed", (event) => {
      if (event?.detail?.logs?.enabled === false || !ownsUrl()) return;
      if (!booted && currentHost()) { booted = true; void reloadForHost(); }
    });
    if (currentHost()) { booted = true; void reloadForHost(); }
  }

  ns.logs = { init, onLocation, onShow, onHide, getContext, applyContext, search, model };
})();
