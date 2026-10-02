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
  const { state, api, util, ui } = ns;
  // Formats and colours (docs/ui-foundations.md): a service keeps the colour
  // it has on Traces and Metrics (palette.service), severities are --sev-*.
  const fmt = ns.format;
  const palette = ns.palette;

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

  function currentHost() { return state.selectedHostId || ""; }

  // The displayed severity: the palette's level (fatal, error, warn, info,
  // debug, trace), coloured by [data-sev] (--sev-*).
  function severityLevel(row) {
    const n = Number(row.severity_number) || 0;
    return palette.severityLevel(n > 0 ? n : row.severity_text);
  }

  function sevBadgeHtml(row, title = "") {
    const level = severityLevel(row);
    return `<span class="logsSevBadge" data-sev="${level}"${title ? ` title="${esc(title)}"` : ""}>${esc(row.severity_text || level.toUpperCase())}</span>`;
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

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(String(text));
      if (button) {
        button.classList.add("is-copied");
        setTimeout(() => button.classList.remove("is-copied"), 900);
        // An icon button also gets the "Copied" flash (ns.popover.flash).
        if (!button.textContent.trim()) ns.popover?.flash(button);
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

  // withRecord: the open record's log= too (writeUrl keeps it).
  function urlParams({ withRecord = true } = {}) {
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
    const record = withRecord ? model.side.row?.id || pendingLogId : "";
    if (record) params.set("log", record);
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

  // An open picker is an ns.layers layer: Escape and a press outside it
  // close it, the focus goes back to its button.
  function closePicker(root, { immediate = false } = {}) {
    if (!root) return;
    const layer = root._pickerLayer;
    root._pickerLayer = null;
    layer?.close();
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
    root._pickerLayer = ns.layers.push({ el: root, name: "logsPicker", opener: button, onDismiss: () => closePicker(root) });
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
  }

  // A native <select> shipped inside its picker root (logs.html markup).
  function enhanceSelect(select, onChange) {
    const root = select.parentElement;
    // The button is the control; the hidden native select only keeps the value.
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
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
    timePicker = ns.timeRange.create(root, {
      idPrefix: "logs",
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
    palette.registerServices(names);
    const selected = new Set(model.services);
    menu.innerHTML = `<div class="logsMultiPicker__actions"><button type="button" class="logsMiniButton" data-service-all>All services</button></div>` +
      (names.length ? names.map((name) => `
        <label class="logsMultiPicker__option" role="option" aria-selected="${selected.has(name)}">
          <input type="checkbox" value="${esc(name)}" ${selected.has(name) ? "checked" : ""} />
          <i class="logsServiceDot" style="background:${palette.service(name)}"></i>
          <span class="logsMultiPicker__name">${esc(name)}</span>
          <span class="logsMultiPicker__count">${counts.has(name) ? fmt.compact(counts.get(name)) : ""}</span>
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
      palette.registerServices(model.serviceChoices.map((s) => s.name));
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
    if (!ns.facetPanel || !$("logsFacets")) return;
    fields = ns.facetPanel.create({
      ids: { panel: "logsFacets", toggle: "logsFacetsToggle", meta: "logsFacetsMeta", search: "logsFacetsSearch", list: "logsFacetsList" },
      collapsedClass: "chdash-logs-facets-collapsed",
      // A phone: the panel is a drawer, toggled from the top of the records.
      drawerHost: document.querySelector(".logsSearchMain"),
      collapsedStoreKey: "chdash.logsFacetsCollapsed.v1",
      pinStoreKey: "chdash.logsFacetPins.v1",
      label: "fields",
      noun: ["log", "logs"],
      scopes: {
        column: { badge: "C", title: "Record column" },
        log: { badge: "L", title: "Log attribute (LogAttributes)" },
        resource: { badge: "R", title: "Resource attribute (ResourceAttributes)" },
        scope: { badge: "S", title: "Scope attribute (ScopeAttributes)" },
      },
      filterKey: fieldFilterKeyOf,
      fetchKeys: async (filters) => {
        const payload = await api.getLogs("facets", new URLSearchParams(filters.params));
        return {
          supported: payload?.supported !== false,
          keys: (Array.isArray(payload?.keys) ? payload.keys : []).map((row) => ({ scope: String(row?.[0] || ""), key: String(row?.[1] || ""), count: Number(row?.[2] || 0) })),
          estimated: payload?.estimated === true,
          timedOut: payload?.timed_out === true,
          sampled: Number(payload?.sampled_records || 0),
        };
      },
      fetchValues: async (filters, scope, key, limit) => {
        const params = new URLSearchParams(filters.params);
        params.set("scope", scope);
        params.set("key", key);
        params.set("limit", String(limit));
        const payload = await api.getLogs("facet_values", params);
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

  // A failed step's Retry (onRetryClick): "search", "more", "histogram",
  // "patterns", "context" or "meta".
  const LOGS_RETRY = (what) => `<button type="button" class="button button--small logsRetry" data-logs-retry="${what}">Retry</button>`;

  // The error strip: a sentence (app_observability.js strips the API's error
  // codes) and, for a step that can run again, Retry.
  function showError(message, retry = "") {
    const box = $("logsError");
    if (!box) return;
    box.innerHTML = message ? `<span class="tracesError__text">${esc(message)}</span>${retry ? LOGS_RETRY(retry) : ""}` : "";
    box.hidden = !message;
  }

  function onRetryClick(event) {
    const what = event.target instanceof Element ? event.target.closest("[data-logs-retry]")?.getAttribute("data-logs-retry") : "";
    if (!what) return;
    if (what === "search") void search({ push: false });
    else if (what === "more") { showError(""); void loadMore(); }
    else if (what === "histogram" && model.lastSearch) void loadHistogram(model.lastSearch);
    else if (what === "patterns") { model.patternsKey = ""; void loadPatterns(); }
    else if (what === "context") void loadContext();
    else if (what === "meta") { showError(""); void reloadForHost(); }
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
    void fields?.load(fieldFilters(range));
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
      if (model.selectedId && !model.rowIds.has(model.selectedId)) closeSidePanel({ url: pendingLogId ? "none" : "clear" });
      openPendingSidePanel();
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
    palette.registerServices(services);
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
      if (seq === model.seq.search) showError(error.message, "more");
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
      case "time": return `<span class="logsCell logsCell--time" title="${esc(timeTitle(row))}">${esc(timeLabel(row))}</span>`;
      case "severity": return `<span class="logsCell logsCell--sev">${sevBadgeHtml(row, `SeverityNumber ${row.severity_number}`)}</span>`;
      case "service": return `<span class="logsCell logsCell--service" title="${esc(row.service)}"><i class="logsServiceDot" style="background:${palette.service(row.service)}"></i>${esc(row.service)}</span>`;
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
      hint = `<p>The table holds logs from ${esc(fmt.time(bounds.min_ms))} to ${esc(fmt.time(bounds.max_ms))}.</p>
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
      messageBox.innerHTML = `<div class="logsEmpty logsEmpty--error"><strong>Search failed.</strong><p>${esc(error)}</p>${LOGS_RETRY("search")}</div>`;
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
      const classes = ["logsRow"];
      if (row.id === model.selectedId) classes.push("is-selected");
      if (model.newIds.has(row.id)) classes.push("is-new");
      html += `<div class="${classes.join(" ")}" role="row" data-sev="${severityLevel(row)}" data-row-index="${i}" data-row-id="${esc(row.id)}" style="grid-template-columns:${template}">${model.cols.map((col) => cellHtml(row, col)).join("")}</div>`;
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

  // A message in place of the bars (the chart keeps its instance, hidden).
  function histogramMessage(box, text, isError = false) {
    if (histogramChart) histogramChart.root.hidden = true;
    let note = box.querySelector(":scope > .logsHistogram__placeholder");
    if (!note) {
      box.querySelector(":scope > .tracesEmpty")?.remove();
      note = document.createElement("div");
      box.appendChild(note);
    }
    note.className = `logsHistogram__placeholder${isError ? " is-error" : ""}`;
    note.innerHTML = `${esc(text)}${isError ? ` ${LOGS_RETRY("histogram")}` : ""}`;
    note.hidden = false;
  }

  // Bucket starts -> bars centred on [start, start + bucket_ms).
  function histogramData(h) {
    const rows = Array.isArray(h.buckets) ? h.buckets : [];
    const bucketMs = Number(h.bucket_ms) || 60000;
    const xs = new Float64Array(rows.length);
    const columns = {};
    for (const sev of SEV_STACK) columns[sev] = new Float64Array(rows.length);
    rows.forEach((b, i) => {
      xs[i] = Number(b[0]) + bucketMs / 2;
      for (const sev of SEV_STACK) columns[sev][i] = Number(b[SEV_COLUMN[sev]]) || 0;
    });
    return {
      xs,
      xDomain: Array.isArray(h.range) ? [Number(h.range[0]), Number(h.range[1])] : null,
      series: SEV_STACK.map((sev) => ({ id: sev, label: SEV_LABELS[sev], color: SEV_COLORS[sev], values: columns[sev], nulls: null, group: 0 })),
    };
  }

  function bucketTitle(i) {
    const h = model.histogram;
    const bucketMs = Number(h?.bucket_ms) || 60000;
    const start = Number(h?.buckets?.[i]?.[0]);
    if (!Number.isFinite(start)) return "";
    return fmt.range(start, start + bucketMs);
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
    const box = $("logsHistogram");
    const total = $("logsTotal");
    const meta = $("logsHistogramMeta");
    if (!box) return;
    const h = model.histogram;
    for (const sev of SEV_CLASSES) {
      const node = document.querySelector(`[data-sev-count="${sev}"]`);
      if (node) node.textContent = h ? fmt.compact(h.totals?.[sev] || 0) : "";
    }
    box.classList.toggle("is-loading", model.histogramLoading && !!h);
    if (model.histogramLoading && !h) {
      histogramMessage(box, "Loading volume\u2026");
      if (total) total.textContent = fmt.EMPTY;
      return;
    }
    if (model.histogramError) {
      histogramMessage(box, model.histogramError, true);
      if (total) total.textContent = fmt.EMPTY;
      return;
    }
    if (!h) return;
    const count = Number(h.totals?.total || 0);
    if (total) total.textContent = `${fmt.count(count)} log${count === 1 ? "" : "s"}`;
    if (meta) meta.textContent = `${ns.timeRange.describeRange(model.timeRange).text} · ${fmt.duration.fromMs(h.bucket_ms)} buckets${model.histogramLoading ? " · updating\u2026" : ""}`;
    // While a refetch runs, the previous bars stay (dimmed) until it answers.
    if (model.histogramLoading || !ns.chartCore) return;
    for (const note of box.querySelectorAll(":scope > .logsHistogram__placeholder, :scope > .tracesEmpty")) note.hidden = true;
    const data = histogramData(h);
    if (!histogramChart) {
      histogramChart = ns.chartCore.create(box, {
        ...data,
        xKind: "time",
        type: "bar",
        stack: true,
        height: HISTOGRAM_HEIGHT,
        xFractionDigits: 0,
        legend: false,
        barWidthRatio: 0.86,
        cursorPoints: false,
        tooltipSort: "reverse",
        tooltipTitle: bucketTitle,
        xReadout: bucketTitle,
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

  function initHistogram() {
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
    return `<svg class="logsSparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline class="logsSparkline__line" data-sev="${esc(sev)}" points="${points}"></polyline></svg>`;
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
      box.innerHTML = `<div class="logsEmpty logsEmpty--error"><strong>Patterns failed.</strong><p>${esc(model.patternsError)}</p>${LOGS_RETRY("patterns")}</div>`;
      return;
    }
    const p = model.patterns;
    if (!p) { box.innerHTML = '<div class="tracesEmpty">Search to mine patterns.</div>'; return; }
    const all = p.patterns || [];
    const hidden = model.denoise ? all.filter((item) => item.noisy).length : 0;
    const shown = model.denoise ? all.filter((item) => !item.noisy) : all;
    const summary = p.total
      ? `${fmt.count(p.pattern_count)} pattern${p.pattern_count === 1 ? "" : "s"} in ${p.sampled ? `a sample of ${fmt.count(p.sample_size)} of ${fmt.count(p.total)} logs (counts ×${fmt.compact(p.scale)})` : `${fmt.count(p.total)} logs`}${hidden ? ` · denoise hides ${fmt.count(hidden)} pattern${hidden === 1 ? "" : "s"} above 10 %` : ""}${model.patternsLoading ? " · updating\u2026" : ""}`
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
            <span class="logsPatternRow__count">${fmt.compact(item.count)}</span>
            <span class="logsPatternRow__share"><span class="logsShareBar"><i style="width:${Math.max(1, Math.round(item.share * 100))}%"></i></span>${fmt.percent(item.share)}</span>
            <span class="logsPatternRow__trend">${sparklineSvg(item.sparkline || [], item.severity)}</span>
            <span class="logsPatternRow__text">
              <span class="logsPattern"><span class="logsSevBadge" data-sev="${esc(item.severity)}">${esc(item.severity.toUpperCase())}</span>${patternHtml(item.pattern)}</span>
              <span class="logsPattern__sample"><i class="logsServiceDot" style="background:${palette.service(item.service)}"></i>${esc(item.service)}${item.service_count > 1 ? ` +${item.service_count - 1}` : ""} · ${esc(item.sample)}</span>
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

  // The Results / Patterns in-content tabs (app_ui_tabs.js).
  let viewTabs = null;
  // The log record tabs (Details | Surrounding context), ns.tabs.bind.
  let sideTabs = null;

  function setTab(tab, { push = false } = {}) {
    model.tab = tab === "patterns" ? "patterns" : "results";
    viewTabs?.select(model.tab);
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

  // The record panel: a docked ns.detailPanel. Its log= URL parameter (the
  // record's id) is pushed when it opens, replaced when another record shows
  // in it, and Back closes it. Escape (ns.layers) and the close button give
  // the focus back to the record table, whose arrow keys move through the
  // records.
  let sidePanel = null;
  const logParam = ns.detailPanel.urlParam("log");
  // A log= of a reload or a link: opened when its record is listed.
  let pendingLogId = "";

  function detailPanel() {
    if (sidePanel || !$("logsSidePanel")) return sidePanel;
    sidePanel = ns.detailPanel.create({
      el: $("logsSidePanel"),
      layout: "docked",
      returnFocus: () => $("logsTable"),
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
    detailPanel()?.open({ opener: $("logsTable") });
    document.querySelector(".logsBody")?.classList.add("has-side");
    renderSidePanel();
    renderWindow(true);
    if (model.side.tab === "context") void loadContext();
    const mode = url || (moving ? "replace" : "push");
    if (ownsUrl() && mode === "push") logParam.open(row.id);
    else if (ownsUrl() && mode === "replace") logParam.move(row.id);
  }

  // url: "clear" (drop log=, Back when the entry is the panel's own) or
  // "none" (the URL already has no log=: Back, a new search).
  function closeSidePanel({ url = "clear" } = {}) {
    const wasOpen = !!model.side.row;
    model.selectedId = "";
    model.side.row = null;
    if (sidePanel?.isOpen()) sidePanel.close("closed", { restoreFocus: true });
    document.querySelector(".logsBody")?.classList.remove("has-side");
    renderWindow(true);
    if (wasOpen && url === "clear" && ownsUrl()) logParam.clear();
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
    else if (logParam.get()) logParam.clear();
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
    const title = $("logsSideTitle");
    if (title) {
      title.innerHTML = `${sevBadgeHtml(row)}
        <span class="logsSideTitle__service"><i class="logsServiceDot" style="background:${palette.service(row.service)}"></i>${esc(row.service)}</span>
        <time class="logsSideTitle__time" title="${esc(timeTitle(row))}">${esc(fullTimeLabel(row))}</time>`;
    }
    const openTrace = $("logsOpenTrace");
    if (openTrace) {
      const traced = !!row.trace_id && state.features?.traces?.enabled !== false;
      openTrace.hidden = !traced;
      if (traced) openTrace.href = route(`observability/traces/${encodeURIComponent(row.trace_id)}${row.span_id ? `?span=${encodeURIComponent(row.span_id)}` : ""}`);
    }
    sideTabs?.select(model.side.tab);
    $("logsSideDetails").hidden = model.side.tab !== "details";
    $("logsSideContext").hidden = model.side.tab !== "context";
    const details = $("logsSideDetails");
    if (details) {
      details.innerHTML = `
        <section class="logsFieldGroup logsFieldGroup--body">
          <h4>Body${row.body_truncated ? ` <span>first ${fmt.count(row.body.length)} of ${fmt.count(row.body_length)} characters</span>` : ""}</h4>
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
      palette.registerServices((payload.rows || []).map((r) => r.service));
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
    if (model.side.contextError) { box.innerHTML = `<div class="logsEmpty logsEmpty--error"><p>${esc(model.side.contextError)}</p>${LOGS_RETRY("context")}</div>`; return; }
    const ctx = model.side.context;
    if (!ctx) { box.innerHTML = ""; return; }
    const rows = ctx.rows || [];
    const anchor = model.side.anchorId;
    box.innerHTML = `${ctx.more_after ? '<div class="logsContext__more">Newer logs continue past the window</div>' : ""}
      ${rows.map((r) => {
        return `<button type="button" class="logsContextRow${r.id === anchor ? " is-anchor" : ""}" data-context-id="${esc(r.id)}">
          <span class="logsContextRow__time" title="${esc(timeTitle(r))}">${esc(fmt.time(Number(r.ts_ms), { precision: "ms", date: "never" }))}</span>
          ${sevBadgeHtml(r)}
          <span class="logsContextRow__service"><i class="logsServiceDot" style="background:${palette.service(r.service)}"></i>${esc(r.service)}</span>
          <span class="logsContextRow__body">${esc(r.body)}</span>
        </button>`;
      }).join("") || '<div class="logsEmpty">No other logs in this window.</div>'}
      ${ctx.more_before ? '<div class="logsContext__more">Older logs continue past the window</div>' : ""}`;
  }

  function initSidePanel() {
    detailPanel();
    $("logsCopyJson")?.addEventListener("click", (event) => {
      if (model.side.row) void copyText(JSON.stringify(model.side.row, null, 2), event.currentTarget);
    });
    $("logsSideDetails")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-field-action]");
      if (!button) return;
      applyFieldAction(button.dataset.fieldAction, button.dataset.key, button.dataset.value, button);
    });
    // Details | Surrounding context: the shared tab behaviour (app_ui_tabs.js).
    sideTabs = ns.tabs?.bind(document.querySelector(".logsSideTabs"), {
      attr: "sideTab",
      onSelect: (tab) => {
        model.side.tab = tab;
        renderSidePanel();
        if (model.side.tab === "context" && !model.side.context) void loadContext();
      },
    }) || null;
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
      showError(model.metaError, model.meta ? "" : "meta");
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
    pendingLogId = logParam.get();
    initTimePicker();
    initServicePicker();
    initColumnsPicker();
    initFields();
    const level = $("logsLevel");
    if (level) {
      const enhanced = enhanceSelect(level, (value) => { model.level = value; void search({ push: true }); });
      levelPicker = { set: (value) => { level.value = value || ""; enhanced.refresh(); } };
    }
    initTable();
    initHistogram();
    initPatterns();
    initSidePanel();
    viewTabs = ns.tabs?.bind(document.querySelector(".logsTabs"), { onSelect: (tab) => { if (tab !== model.tab) setTab(tab, { push: true }); } }) || null;
    $("logsWorkspace")?.addEventListener("click", onRetryClick);
    syncControls();
    setTab(model.tab, { push: false });

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
