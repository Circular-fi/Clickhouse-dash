(() => {
  "use strict";

  // Metrics browser (the Metrics view of /observability): a catalog of the OpenTelemetry metrics stored
  // by the ClickHouse exporter (service -> metric), and chart panels drawn from
  // the server-side aggregations of /api/metrics/series, with exemplar dots
  // linking to the trace and span that produced them. Everything the user
  // picks (range, panels, aggregation, group-by, filters) lives in the URL.
  const ns = window.ChDash;
  if (!ns) return;
  const { byId, $ } = ns.dom;
  const { dom, state, api, ui, util, h } = ns;

  const MAX_RANGE_MINUTES = 90 * 24 * 60;
  const PLOT_HEIGHT = 280;
  const MARGIN = { top: 14, right: 14, bottom: 28 };
  const COLOR_SLOTS = 8;
  const TOOLTIP_ROWS = 12;
  const KIND_LABEL = {
    gauge: "Gauge", sum: "Sum", histogram: "Histogram", exponential_histogram: "Exponential histogram", summary: "Summary",
  };
  const KIND_BADGE = { gauge: "gauge", sum: "sum", histogram: "hist", exponential_histogram: "exp hist", summary: "summary" };
  // Kind badges are categories (ns.badge): one hue per metric type, none of
  // them a status colour (a histogram is not an error).
  const KIND_COLOR = {
    gauge: ns.palette.categorical(2), sum: ns.palette.categorical(0), histogram: ns.palette.categorical(6),
    exponential_histogram: ns.palette.categorical(6), summary: ns.palette.kind("view"),
  };
  const kindBadge = (kind, text, title = "") => ns.badge.html(text, { tone: KIND_COLOR[kind] ? "category" : "neutral", color: KIND_COLOR[kind] || "", title, className: `metricsBadge metricsBadge--${kind}` });
  const AGG_LABEL = {
    avg: "Average", min: "Min", max: "Max", last: "Last value", sum: "Sum", rate: "Rate (per second)", increase: "Increase",
    count_rate: "Count rate (per second)", count: "Count",
  };
  const EXEMPLAR_KINDS = new Set(["gauge", "sum", "histogram", "exponential_histogram"]);

  // util.escapeHtml is the one escaper; null prints as "".
  const esc = (value) => ns.util.escapeHtml(value == null ? "" : value);
  // The Metrics view's address (ns.router): /observability/metrics and its
  // panels, written only while the view shows (the "metrics" lifecycle scope).
  const address = ns.router.owner("metrics", { path: "/observability/metrics", params: () => urlQuery() });
  // Formats and colours (docs/ui-foundations.md): a series grouped by
  // service keeps the service's colour of Traces and Logs.
  const fmt = ns.format;
  const palette = ns.palette;

  function localMidnight(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function aggLabel(agg) {
    if (AGG_LABEL[agg]) return AGG_LABEL[agg];
    const q = /^p(\d+(?:\.\d+)?)$/.exec(String(agg || ""));
    if (q) return q[1] === "0" ? "P0 (min)" : q[1] === "100" ? "P100 (max)" : `P${q[1]}`;
    return String(agg || "");
  }

  // --- Units ----------------------------------------------------------------
  // OpenTelemetry (UCUM) units: s/ms/us/ns durations, By bytes, {thing}
  // annotations for counts, "1" dimensionless. A trailing "/s" is a rate.

  const DURATION_SCALE = { ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600, d: 86400 };
  const BYTE_SCALE = { By: 1, B: 1, bit: 1 / 8, kBy: 1e3, KBy: 1e3, MBy: 1e6, GBy: 1e9, TBy: 1e12, KiBy: 1024, MiBy: 1024 ** 2, GiBy: 1024 ** 3, TiBy: 1024 ** 4 };
  const DURATION_STEPS = [[1e-9, "ns"], [1e-6, "µs"], [1e-3, "ms"], [1, "s"], [60, "min"], [3600, "h"], [86400, "d"]];
  const BYTE_STEPS = [[1, "B"], [1024, "KB"], [1024 ** 2, "MB"], [1024 ** 3, "GB"], [1024 ** 4, "TB"]];
  // Group keys that name the service: such a series takes palette.service.
  const SERVICE_KEYS = new Set(["service.name", "ServiceName", "service_name"]);

  function parseUnit(unitText) {
    let text = String(unitText == null ? "" : unitText).trim();
    let perSecond = false;
    if (/\/s$/.test(text)) { perSecond = true; text = text.slice(0, -2).trim(); }
    if (Object.prototype.hasOwnProperty.call(DURATION_SCALE, text)) return { kind: "duration", scale: DURATION_SCALE[text], perSecond, label: "" };
    if (Object.prototype.hasOwnProperty.call(BYTE_SCALE, text)) return { kind: "bytes", scale: BYTE_SCALE[text], perSecond, label: "" };
    if (text === "%") return { kind: "percent", scale: 1, perSecond, label: "" };
    if (text === "" || text === "1") return { kind: "number", scale: 1, perSecond, label: "" };
    const annotation = /^\{(.+)\}$/.exec(text);
    return { kind: "number", scale: 1, perSecond, label: annotation ? annotation[1] : text };
  }

  function unitTitle(info, rawUnit) {
    const rate = info.perSecond ? "/s" : "";
    if (info.kind === "duration") return `duration${rate ? " per second" : ""}`;
    if (info.kind === "bytes") return `bytes${rate}`;
    if (info.kind === "percent") return `percent${rate}`;
    if (info.label) return `${info.label}${rate}`;
    return rawUnit ? String(rawUnit) : rate ? "per second" : "";
  }

  function pickStep(steps, magnitude) {
    let chosen = steps[0];
    for (const step of steps) if (magnitude >= step[0]) chosen = step;
    return chosen;
  }

  // One value with its unit, for tooltips and the legend (ns.format).
  function formatValue(value, info) {
    if (value == null || !Number.isFinite(value)) return fmt.EMPTY;
    const rate = info.perSecond ? "/s" : "";
    if (info.kind === "duration") {
      const seconds = value * info.scale;
      if (seconds === 0) return `0 s${rate}`;
      return `${seconds < 0 ? "-" : ""}${fmt.duration.fromSeconds(Math.abs(seconds))}${rate}`;
    }
    if (info.kind === "bytes") return `${fmt.bytes(value * info.scale)}${rate}`;
    if (info.kind === "percent") return `${fmt.number(value)}%${rate}`;
    const label = info.label ? ` ${info.label}` : "";
    return `${fmt.number(value)}${label}${rate}`;
  }

  // Axis scale: every tick shares one display unit and one decimal count.
  function axisFormatter(info, maxAbs) {
    const rate = info.perSecond ? "/s" : "";
    if (info.kind === "duration") {
      const [factor, name] = pickStep(DURATION_STEPS, Math.abs(maxAbs * info.scale) || 1);
      return { factor: factor / info.scale, suffix: ` ${name}${rate}` };
    }
    if (info.kind === "bytes") {
      const [factor, name] = pickStep(BYTE_STEPS, Math.abs(maxAbs * info.scale) || 1);
      return { factor: factor / info.scale, suffix: ` ${name}${rate}` };
    }
    if (info.kind === "percent") return { factor: 1, suffix: "%" };
    const compact = ns.chartCore ? ns.chartCore.compactUnitFor(maxAbs) : { factor: 1, suffix: "" };
    return { factor: compact.factor, suffix: compact.suffix };
  }

  function formatTick(value, step, formatter) {
    if (value === 0) return "0";
    const scaledStep = Math.abs(step / formatter.factor);
    const decimals = scaledStep > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(scaledStep) - 1e-9))) : 0;
    const text = (value / formatter.factor).toFixed(decimals);
    return `${/^-0(?:\.0*)?$/.test(text) ? "0" : text}${formatter.suffix}`;
  }


  // --- State ----------------------------------------------------------------

  let panelSeq = 0;
  function newPanel(fields = {}) {
    return {
      id: ++panelSeq,
      service: String(fields.service || ""),
      metric: String(fields.metric || ""),
      kind: String(fields.kind || ""),
      agg: String(fields.agg || ""),
      groupBy: Array.isArray(fields.groupBy) ? fields.groupBy.filter(Boolean).slice(0, 5) : [],
      filters: Array.isArray(fields.filters) ? fields.filters.filter((f) => f && f.key) : [],
      exemplars: fields.exemplars !== false,
      data: null,
      error: "",
      loading: false,
      exemplarData: null,
      exemplarError: "",
      keys: null,
      keysPromise: null,
      values: new Map(),
      hidden: new Set(),
      el: null,
      chart: null,
      filterDraft: null,
    };
  }

  const model = {
    range: { from: "now-1h", to: "now" },
    catalog: null,
    catalogError: "",
    catalogLoading: false,
    meta: null,
    search: "",
    collapsed: new Set(),
    focusService: "",
    panels: [newPanel()],
    active: 0,
    resolved: null,
  };

  // --- URL ------------------------------------------------------------------

  function panelParams(panel, params) {
    if (panel.service) params.set("service", panel.service);
    if (panel.metric) params.set("metric", panel.metric);
    if (panel.kind) params.set("kind", panel.kind);
    if (panel.agg) params.set("agg", panel.agg);
    if (panel.groupBy.length) params.set("group_by", panel.groupBy.join(","));
    for (const f of panel.filters) params.append(f.op === "!=" ? "filter_not" : "filter", `${f.key}=${f.value}`);
    if (!panel.exemplars) params.set("exemplars", "0");
    return params;
  }

  function panelFromParams(params) {
    const filters = [];
    for (const [name, op] of [["filter", "="], ["filter_not", "!="]]) {
      for (const raw of params.getAll(name)) {
        const at = raw.indexOf("=");
        if (at <= 0) continue;
        filters.push({ key: raw.slice(0, at), op, value: raw.slice(at + 1) });
      }
    }
    return newPanel({
      service: params.get("service") || "",
      metric: params.get("metric") || "",
      kind: params.get("kind") || "",
      agg: params.get("agg") || "",
      groupBy: String(params.get("group_by") || "").split(",").map((s) => s.trim()).filter(Boolean),
      filters,
      exemplars: params.get("exemplars") !== "0",
    });
  }

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get("from");
    const to = params.get("to");
    if (from && to) model.range = { from, to };
    const panels = [panelFromParams(params)];
    for (const encoded of params.getAll("panel")) panels.push(panelFromParams(new URLSearchParams(encoded)));
    model.panels = panels;
    const active = Number(params.get("active"));
    model.active = Number.isInteger(active) && active >= 0 && active < panels.length ? active : 0;
  }

  function urlQuery() {
    const params = new URLSearchParams();
    params.set("from", model.range.from);
    params.set("to", model.range.to);
    const [first, ...rest] = model.panels;
    if (first) panelParams(first, params);
    for (const panel of rest) params.append("panel", panelParams(panel, new URLSearchParams()).toString());
    if (model.active > 0) params.set("active", String(model.active));
    return params.toString();
  }


  // --- Requests -------------------------------------------------------------

  function hostParams(extra = {}) {
    const params = new URLSearchParams();
    if (state.selectedHostId) params.set("host_id", String(state.selectedHostId));
    for (const [key, value] of Object.entries(extra)) {
      if (Array.isArray(value)) { for (const item of value) params.append(key, String(item)); }
      else if (value != null && String(value) !== "") params.set(key, String(value));
    }
    return params;
  }

  // Relative ranges ("now-1h") are resolved once per load, so the catalog and
  // every panel describe the same window.
  function resolveRange() {
    const tr = ns.timeRange;
    const { startMs, endMs } = tr.resolveRange(model.range, Date.now());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Select a valid time range.");
    if (endMs - startMs > MAX_RANGE_MINUTES * 60000) throw new Error(`Max range is ${tr.formatMinutes(MAX_RANGE_MINUTES)}.`);
    model.resolved = { start_ms: Math.round(startMs), end_ms: Math.round(endMs) };
    return model.resolved;
  }

  function currentRange() {
    return model.resolved || resolveRange();
  }

  function panelQuery(panel, extra = {}) {
    const range = currentRange();
    return hostParams({
      kind: panel.kind, service: panel.service, metric: panel.metric,
      start_ms: range.start_ms, end_ms: range.end_ms,
      bucket_origin_ms: localMidnight(range.start_ms),
      ...extra,
    });
  }

  function filterParams(panel) {
    return {
      filter: panel.filters.filter((f) => f.op !== "!=").map((f) => `${f.key}=${f.value}`),
      filter_not: panel.filters.filter((f) => f.op === "!=").map((f) => `${f.key}=${f.value}`),
    };
  }

  // --- Errors ---------------------------------------------------------------

  // The error strip above the view (ns.uiState.banner).
  function showError(message, retry = null) {
    ns.uiState.banner(dom.metricsError, { message, retry });
  }

  // --- Catalog --------------------------------------------------------------

  async function loadMeta() {
    try {
      model.meta = await api.getJson?.(`api/metrics/meta?${hostParams().toString()}`) || null;
    } catch {
      model.meta = null;
    }
  }

  async function loadCatalog() {
    const req = util.latest("metrics.catalog");
    model.catalogLoading = true;
    model.catalogError = "";
    renderCatalog();
    let range;
    try {
      range = resolveRange();
    } catch (e) {
      model.catalogLoading = false;
      model.catalogError = e.message;
      renderCatalog();
      return;
    }
    try {
      const data = await api.getJson(`api/metrics/catalog?${hostParams(range).toString()}`, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.catalog = data;
    } catch (e) {
      if (!req.isCurrent()) return;
      model.catalog = null;
      model.catalogError = util.errorText(e, "Cannot load the metrics catalog.");
    }
    model.catalogLoading = false;
    // Panels opened from the URL may omit the kind: take it from the catalog.
    for (const panel of model.panels) {
      if (panel.metric && !panel.kind) {
        const entry = catalogEntry(panel.service, panel.metric, "");
        if (entry) panel.kind = entry.kind;
      }
    }
    renderCatalog();
    renderPanels();
  }

  function catalogEntry(service, metric, kind) {
    const svc = (model.catalog?.services || []).find((s) => s.name === service);
    return svc?.metrics?.find((m) => m.name === metric && (!kind || m.kind === kind)) || null;
  }

  function highlight(text, needle) {
    const value = String(text || "");
    if (!needle) return esc(value);
    const index = value.toLowerCase().indexOf(needle);
    if (index < 0) return esc(value);
    return `${esc(value.slice(0, index))}<mark>${esc(value.slice(index, index + needle.length))}</mark>${esc(value.slice(index + needle.length))}`;
  }

  function temporalityLabel(entry) {
    if (!entry) return "";
    const parts = [];
    if (entry.temporality) parts.push(entry.temporality);
    if (entry.kind === "sum" && entry.monotonic != null) parts.push(entry.monotonic ? "monotonic" : "non-monotonic");
    return parts.join(" · ");
  }

  function renderCatalog() {
    const root = dom.metricsCatalog;
    if (!root) return;
    const summary = dom.metricsCatalogSummary;
    if (model.catalogLoading && !model.catalog) {
      root.innerHTML = ns.uiState.loadingHtml({ label: "Loading the metrics catalog\u2026", compact: true });
      if (summary) summary.textContent = "Loading metrics\u2026";
      return;
    }
    if (model.catalogError) {
      root.innerHTML = ns.uiState.errorHtml({ body: model.catalogError, compact: true, retry: { attrs: { "data-metrics-retry": "catalog" } } });
      if (summary) summary.textContent = "Catalog unavailable";
      return;
    }
    const services = model.catalog?.services || [];
    // A service picked in another Observability view (applyContext): its
    // group opens and scrolls into view, the others fold.
    const focus = model.catalog && services.some((svc) => svc.name === model.focusService) ? model.focusService : "";
    if (model.catalog) model.focusService = "";
    if (focus) model.collapsed = new Set(services.map((svc) => svc.name).filter((name) => name !== focus));
    const needle = model.search.trim().toLowerCase();
    const active = model.panels[model.active] || null;
    let shown = 0;
    const groups = [];
    for (const svc of services) {
      const serviceMatch = needle && String(svc.name).toLowerCase().includes(needle);
      const metrics = (svc.metrics || []).filter((m) => !needle || serviceMatch || String(m.name).toLowerCase().includes(needle));
      if (!metrics.length) continue;
      shown += metrics.length;
      const collapsed = !needle && model.collapsed.has(svc.name);
      const items = collapsed ? "" : metrics.map((m) => {
        const selected = !!active && active.service === svc.name && active.metric === m.name && active.kind === m.kind;
        const unit = m.unit ? ns.badge.html(m.unit, { className: "metricsBadge metricsBadge--unit", title: "Unit" }) : "";
        const title = `${m.name}\n${KIND_LABEL[m.kind] || m.kind}${m.unit ? ` · ${m.unit}` : ""}${temporalityLabel(m) ? ` · ${temporalityLabel(m)}` : ""}\n${fmt.count(Number(m.points || 0))} points${m.description ? `\n${m.description}` : ""}`;
        return `<button type="button" class="metricsCatalog__metric${selected ? " is-selected" : ""}" role="treeitem" aria-selected="${selected}" data-service="${esc(svc.name)}" data-metric="${esc(m.name)}" data-kind="${esc(m.kind)}" title="${esc(title)}">
          <span class="metricsCatalog__name">${highlight(m.name, needle)}</span>
          <span class="metricsCatalog__badges">${kindBadge(m.kind, KIND_BADGE[m.kind] || m.kind)}${unit}</span>
        </button>`;
      }).join("");
      groups.push(`<div class="metricsCatalog__service${collapsed ? " is-collapsed" : ""}" role="group">
        <button type="button" class="metricsCatalog__serviceHead" role="treeitem" aria-expanded="${!collapsed}" data-service-toggle="${esc(svc.name)}">
          <span class="metricsCatalog__chevron" aria-hidden="true"></span>
          <span class="metricsCatalog__serviceName">${highlight(svc.name, needle)}</span>
          <span class="metricsCatalog__count">${metrics.length}</span>
        </button>
        ${items ? `<div class="metricsCatalog__metrics">${items}</div>` : ""}
      </div>`);
    }
    if (!services.length) {
      root.innerHTML = ns.uiState.emptyHtml({ title: "No metric points in this time range", compact: true, action: jumpToDataAction() });
    } else if (!groups.length) {
      root.innerHTML = ns.uiState.emptyHtml({
        body: `No metric matches \u201c${model.search.trim()}\u201d.`,
        compact: true,
        action: { label: "Clear the search", attrs: { "data-metrics-clear-search": "" } },
      });
    } else {
      root.innerHTML = groups.join("");
      if (focus) $(`[data-service-toggle="${CSS.escape(focus)}"]`, root)?.scrollIntoView?.({ block: "nearest" });
    }
    if (summary) {
      const total = Number(model.catalog?.metric_count || 0);
      const serviceCount = Number(model.catalog?.service_count || services.length);
      const truncated = model.catalog?.truncated ? " (truncated)" : "";
      summary.textContent = needle
        ? `${shown} of ${total} metrics`
        : `${total} metric${total === 1 ? "" : "s"} · ${serviceCount} service${serviceCount === 1 ? "" : "s"}${truncated}`;
    }
  }

  // When the range holds no point but the tables do, offer their latest day.
  function jumpToDataAction() {
    const bounds = model.meta?.time_bounds;
    const max = Number(bounds?.max_ms);
    if (!Number.isFinite(max) || max <= 0) return null;
    const range = model.resolved;
    if (range && max >= range.start_ms && max <= range.end_ms) return null;
    return { label: `Show the last 24 h with data (until ${fmt.time(max)})`, primary: true, attrs: { "data-jump-to-data": max } };
  }

  function jumpToData(maxMs) {
    const tr = ns.timeRange;
    const end = Math.ceil(maxMs / 60000) * 60000;
    applyRange({ from: tr.formatDateTime(end - 24 * 3600000), to: tr.formatDateTime(end) });
  }

  function onCatalogClick(event) {
    if (event.target.closest("[data-metrics-retry=\"catalog\"]")) { void loadCatalog(); return; }
    if (event.target.closest("[data-metrics-clear-search]")) {
      const input = byId("metricsSearch");
      if (input) { input.value = ""; input.focus(); }
      model.search = "";
      renderCatalog();
      return;
    }
    const jump = event.target.closest("[data-jump-to-data]");
    if (jump) { jumpToData(Number(jump.dataset.jumpToData)); return; }
    const toggle = event.target.closest("[data-service-toggle]");
    if (toggle) {
      const name = toggle.dataset.serviceToggle;
      if (model.collapsed.has(name)) model.collapsed.delete(name);
      else model.collapsed.add(name);
      renderCatalog();
      return;
    }
    const item = event.target.closest(".metricsCatalog__metric");
    if (!item) return;
    selectMetric(item.dataset.service, item.dataset.metric, item.dataset.kind);
  }

  function selectMetric(service, metric, kind) {
    let panel = model.panels[model.active];
    if (!panel) { panel = newPanel(); model.panels.push(panel); model.active = model.panels.length - 1; }
    const same = panel.service === service && panel.metric === metric && panel.kind === kind;
    if (!same) {
      Object.assign(panel, { service, metric, kind, agg: "", groupBy: [], filters: [], data: null, error: "", exemplarData: null, keys: null, keysPromise: null });
      panel.values = new Map();
      panel.hidden.clear();
      panel.filterDraft = null;
    }
    address.write(same ? "replace" : "push");
    renderCatalog();
    renderPanels();
    if (!same) loadPanel(panel);
  }

  // --- Panels ---------------------------------------------------------------

  function panelIndex(panel) { return model.panels.indexOf(panel); }

  function setActive(panel) {
    const index = panelIndex(panel);
    if (index < 0 || index === model.active) return;
    model.active = index;
    for (const p of model.panels) p.el?.classList.toggle("is-active", p === panel);
    address.replace();
    renderCatalog();
  }

  function addPanel() {
    const panel = newPanel();
    model.panels.push(panel);
    model.active = model.panels.length - 1;
    address.push();
    renderPanels();
    renderCatalog();
    panel.el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function removePanel(panel) {
    if (model.panels.length <= 1) return;
    const index = panelIndex(panel);
    model.panels.splice(index, 1);
    destroyChart(panel);
    panel.el?.remove();
    panel.el = null;
    if (model.active >= model.panels.length) model.active = model.panels.length - 1;
    else if (model.active > index) model.active -= 1;
    address.push();
    renderPanels();
    renderCatalog();
  }

  async function loadPanel(panel) {
    if (!panel.metric || !panel.kind || !panel.service) return;
    // A new load supersedes the panel's series and exemplar requests.
    const req = util.latest(`metrics.panel.${panel.id}`);
    util.latest.cancel(`metrics.exemplars.${panel.id}`);
    panel.loading = true;
    panel.error = "";
    renderPanel(panel);
    try {
      const query = panelQuery(panel, { agg: panel.agg, group_by: panel.groupBy.join(","), ...filterParams(panel) });
      const data = await api.getJson(`api/metrics/series?${query.toString()}`, { signal: req.signal });
      if (!req.isCurrent()) return;
      panel.data = data;
      if (data?.agg && data.agg !== panel.agg) {
        panel.agg = data.agg;
        address.replace();
      }
    } catch (e) {
      if (!req.isCurrent()) return;
      panel.data = null;
      panel.error = util.errorText(e, "Cannot load the metric.");
    }
    panel.loading = false;
    renderPanel(panel);
    if (panel.exemplars && EXEMPLAR_KINDS.has(panel.kind) && panel.data) loadExemplars(panel);
    else { panel.exemplarData = null; drawChart(panel); }
  }

  // The exemplars of the panel's current series (a new series load cancels them).
  async function loadExemplars(panel) {
    const req = util.latest(`metrics.exemplars.${panel.id}`);
    try {
      const query = panelQuery(panel, { step_ms: panel.data?.bucket_ms, ...filterParams(panel) });
      const data = await api.getJson(`api/metrics/exemplars?${query.toString()}`, { signal: req.signal });
      if (!req.isCurrent()) return;
      panel.exemplarData = data;
      panel.exemplarError = "";
    } catch (e) {
      if (!req.isCurrent()) return;
      panel.exemplarData = null;
      panel.exemplarError = util.errorText(e, "Cannot load exemplars.");
    }
    renderPanelNote(panel);
    drawChart(panel);
  }

  async function ensureKeys(panel) {
    if (panel.keys) return panel.keys;
    if (!panel.keysPromise) {
      panel.keysPromise = api.getJson(`api/metrics/attributes?${panelQuery(panel).toString()}`)
        .then((data) => { panel.keys = Array.isArray(data?.keys) ? data.keys : []; return panel.keys; })
        .catch(() => { panel.keys = []; return panel.keys; })
        .finally(() => { panel.keysPromise = null; });
    }
    return panel.keysPromise;
  }

  async function ensureValues(panel, key) {
    if (!key) return [];
    if (panel.values.has(key)) return panel.values.get(key);
    try {
      const data = await api.getJson(`api/metrics/attributes?${panelQuery(panel, { key }).toString()}`);
      const values = Array.isArray(data?.values) ? data.values : [];
      panel.values.set(key, values);
      return values;
    } catch {
      return [];
    }
  }

  function renderPanels() {
    const root = dom.metricsPanels;
    if (!root) return;
    // The shipped placeholder is replaced by real panels.
    for (const child of [...root.children]) if (!model.panels.some((p) => p.el === child)) child.remove();
    model.panels.forEach((panel, index) => {
      if (!panel.el) panel.el = buildPanel(panel);
      if (root.children[index] !== panel.el) root.insertBefore(panel.el, root.children[index] || null);
      panel.el.classList.toggle("is-active", index === model.active);
      renderPanel(panel);
    });
    if (dom.metricsAddPanelButton) dom.metricsAddPanelButton.disabled = model.panels.length >= 6;
  }

  function buildPanel(panel) {
    const el = document.createElement("article");
    el.className = "metricsPanel chartCard";
    el.dataset.panelId = String(panel.id);
    el.innerHTML = `
      <header class="metricsPanel__header">
        <div class="metricsPanel__titleRow chartCard__head">
          <h2 class="metricsPanel__name chartCard__title"></h2>
          <div class="metricsPanel__badges chartCard__meta"></div>
          <button type="button" class="metricsPanel__remove chartCard__actions" aria-label="Remove panel" title="Remove panel"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </div>
        <p class="metricsPanel__description"></p>
      </header>
      <div class="traceSearchBar metricsPanel__controls">
        <div class="metricsControl metricsControl--agg">
          <div class="themeSelect tracePicker metricsPicker metricsPicker--agg">
            <button class="button themeSelect__button tracePicker__button" type="button" aria-haspopup="listbox" aria-expanded="false">Aggregation \u00b7 ${fmt.EMPTY}</button>
            <div class="themeSelect__menu tracePicker__menu" role="listbox" tabindex="-1" hidden></div>
          </div>
        </div>
        <div class="metricsControl metricsControl--group">
          <div class="themeSelect tracePicker metricsPicker metricsPicker--group">
            <button class="button themeSelect__button tracePicker__button" type="button" aria-haspopup="listbox" aria-expanded="false">Group by \u00b7 None</button>
            <div class="themeSelect__menu tracePicker__menu" role="listbox" aria-multiselectable="true" tabindex="-1" hidden></div>
          </div>
        </div>
        <div class="metricsControl metricsControl--filters">
          <div class="metricsFilters">
            <div class="metricsFilters__chips" role="list" aria-label="Filters"></div>
            <button type="button" class="button metricsFilters__add" aria-expanded="false">+ Filter</button>
          </div>
        </div>
        <label class="metricsControl metricsControl--exemplars" title="Exemplars: sample measurements linked to the trace and span that produced them">
          <input type="checkbox" class="metricsExemplarToggle" />
          <span>Exemplars</span>
        </label>
      </div>
      <form class="metricsFilterForm" autocomplete="off" hidden>
        <input class="metricsFilterForm__key" type="text" placeholder="Attribute" aria-label="Filter attribute" spellcheck="false" />
        <div class="segmented metricsFilterForm__ops" role="group" aria-label="Filter operator">
          <button type="button" class="segmented__option" data-op="=" aria-pressed="true">=</button>
          <button type="button" class="segmented__option" data-op="!=" aria-pressed="false">!=</button>
        </div>
        <input class="metricsFilterForm__value" type="text" placeholder="Value" aria-label="Filter value" spellcheck="false" />
        <button type="submit" class="button button--primary metricsFilterForm__apply">Add filter</button>
        <button type="button" class="button metricsFilterForm__cancel">Cancel</button>
        <datalist class="metricsFilterForm__keys"></datalist>
        <datalist class="metricsFilterForm__values"></datalist>
      </form>
      <div class="metricsPanel__note" hidden></div>
      <div class="metricsChart chartCard__body">
        <div class="metricsChart__axisTitle"></div>
        <div class="metricsChart__plot">
          <div class="metricsChart__state" hidden></div>
        </div>
      </div>
      <div class="metricsPanel__empty">${ns.uiState.emptyHtml({ body: "Pick a metric in the catalog to chart it." })}</div>`;
    const keysList = $(".metricsFilterForm__keys", el);
    const valuesList = $(".metricsFilterForm__values", el);
    keysList.id = `metricsFilterKeys${panel.id}`;
    valuesList.id = `metricsFilterValues${panel.id}`;
    $(".metricsFilterForm__key", el).setAttribute("list", keysList.id);
    $(".metricsFilterForm__value", el).setAttribute("list", valuesList.id);
    bindPanel(panel, el);
    return el;
  }

  // Pickers reuse the connected tracePicker surface; ns.menu (app_ui_menu.js)
  // owns their motion, keys, focus and the outside click / Escape layer.
  const closePickers = () => ns.menu?.closeAll();
  const pickerParts = (root) => [$(":scope > .tracePicker__button", root), $(":scope > .tracePicker__menu", root)];

  function bindPanel(panel, el) {
    el.addEventListener("pointerdown", () => setActive(panel));
    el.addEventListener("focusin", () => setActive(panel));
    $(".metricsPanel__remove", el).addEventListener("click", () => removePanel(panel));
    el.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-metrics-retry=\"panel\"]")) void loadPanel(panel);
    });

    const aggPicker = $(".metricsPicker--agg", el);
    ns.menu?.bind(...pickerParts(aggPicker), { root: aggPicker });
    $(".tracePicker__menu", aggPicker).addEventListener("click", (event) => {
      const option = event.target.closest("[data-agg]");
      if (!option) return;
      if (option.dataset.agg === panel.agg) return;
      panel.agg = option.dataset.agg;
      panel.hidden.clear();
      address.replace();
      loadPanel(panel);
    });

    const groupPicker = $(".metricsPicker--group", el);
    ns.menu?.multi(...pickerParts(groupPicker), {
      root: groupPicker,
      onOpen: () => renderGroupMenu(panel, true),
      onOpened: async () => {
        await ensureKeys(panel);
        renderGroupMenu(panel, false);
      },
    });
    $(".tracePicker__menu", groupPicker).addEventListener("change", (event) => {
      const box = event.target.closest("input[data-group-key]");
      if (!box) return;
      const key = box.dataset.groupKey;
      const next = panel.groupBy.filter((k) => k !== key);
      if (box.checked) next.push(key);
      panel.groupBy = next.slice(0, 5);
      panel.hidden.clear();
      address.replace();
      renderGroupButton(panel);
      loadPanel(panel);
    });


    const chips = $(".metricsFilters__chips", el);
    chips.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-filter]");
      if (!remove) return;
      panel.filters.splice(Number(remove.dataset.removeFilter), 1);
      address.replace();
      renderFilters(panel);
      loadPanel(panel);
    });

    const form = $(".metricsFilterForm", el);
    const addButton = $(".metricsFilters__add", el);
    const keyInput = $(".metricsFilterForm__key", form);
    const valueInput = $(".metricsFilterForm__value", form);
    // = | !=: the shared segmented control (app_ui_segmented.js).
    const ops = ns.segmented?.bind($(".metricsFilterForm__ops", form), { attr: "op", onChange: (op) => { form.dataset.op = op; } });
    const setOp = (op) => {
      form.dataset.op = op;
      ops?.set(op);
    };
    setOp("=");
    // The open form is an ns.layers layer: Escape closes it, the focus goes
    // back to the add button.
    let formLayer = null;
    const closeForm = () => {
      form.hidden = true;
      addButton.setAttribute("aria-expanded", "false");
      const layer = formLayer;
      formLayer = null;
      layer?.close();
    };
    addButton.addEventListener("click", async () => {
      if (!form.hidden) { closeForm(); return; }
      form.hidden = false;
      addButton.setAttribute("aria-expanded", "true");
      formLayer = ns.layers.push({ el: form, name: "metricsFilterForm", opener: addButton, docked: true, onDismiss: () => closeForm() });
      keyInput.value = "";
      valueInput.value = "";
      setOp("=");
      keyInput.focus({ preventScroll: true });
      const keys = await ensureKeys(panel);
      h.replace($(".metricsFilterForm__keys", form), keys.map((k) => h("option", { value: k })));
    });
    const refreshValues = async () => {
      const key = keyInput.value.trim();
      const list = $(".metricsFilterForm__values", form);
      if (!key || !(panel.keys || []).includes(key)) { list.replaceChildren(); return; }
      const values = await ensureValues(panel, key);
      if (keyInput.value.trim() !== key) return;
      h.replace(list, values.map((v) => h("option", { value: v.value ?? "" }, `${fmt.count(Number(v.points || 0))} points`)));
    };
    keyInput.addEventListener("change", refreshValues);
    keyInput.addEventListener("input", () => { if ((panel.keys || []).includes(keyInput.value.trim())) refreshValues(); });
    valueInput.addEventListener("focus", refreshValues);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const key = keyInput.value.trim();
      if (!key) { keyInput.focus(); return; }
      const op = form.dataset.op === "!=" ? "!=" : "=";
      const value = valueInput.value;
      if (!panel.filters.some((f) => f.key === key && f.op === op && f.value === value)) panel.filters.push({ key, op, value });
      closeForm();
      address.replace();
      renderFilters(panel);
      loadPanel(panel);
    });
    $(".metricsFilterForm__cancel", form).addEventListener("click", closeForm);

    $(".metricsExemplarToggle", el).addEventListener("change", (event) => {
      panel.exemplars = !!event.target.checked;
      address.replace();
      if (panel.exemplars && EXEMPLAR_KINDS.has(panel.kind) && panel.data) loadExemplars(panel);
      else { panel.exemplarData = null; renderPanelNote(panel); drawChart(panel); }
    });
  }

  function renderPanel(panel) {
    const el = panel.el;
    if (!el) return;
    const entry = catalogEntry(panel.service, panel.metric, panel.kind);
    const data = panel.data;
    const hasMetric = !!panel.metric;
    el.classList.toggle("is-empty", !hasMetric);
    $(".metricsPanel__remove", el).hidden = model.panels.length <= 1;
    $(".metricsPanel__header", el).hidden = !hasMetric && model.panels.length <= 1;
    $(".metricsPanel__controls", el).hidden = !hasMetric;
    $(".metricsChart", el).hidden = !hasMetric;
    $(".metricsPanel__empty", el).hidden = hasMetric;
    const name = $(".metricsPanel__name", el);
    name.textContent = hasMetric ? panel.metric : "Empty panel";
    name.title = hasMetric ? panel.metric : "";
    const unit = data?.unit ?? entry?.unit ?? "";
    const temporality = data?.temporality ?? entry?.temporality ?? null;
    const monotonic = data?.monotonic ?? entry?.monotonic ?? null;
    const badges = [];
    if (hasMetric) {
      badges.push(kindBadge(panel.kind, KIND_LABEL[panel.kind] || panel.kind || "?", "Metric type"));
      if (unit) badges.push(ns.badge.html(unit, { className: "metricsBadge metricsBadge--unit", title: "Unit" }));
      if (temporality) badges.push(ns.badge.html(temporality, { className: "metricsBadge", title: "Aggregation temporality" }));
      if (panel.kind === "sum" && monotonic != null) badges.push(ns.badge.html(monotonic ? "monotonic" : "non-monotonic", { className: "metricsBadge", title: "Monotonic" }));
      badges.push(`<span class="metricsPanel__service" title="Service">${ns.badge.swatchHtml(panel.service)}${esc(panel.service)}</span>`);
    }
    $(".metricsPanel__badges", el).innerHTML = badges.join("");
    const description = $(".metricsPanel__description", el);
    const text = data?.description || entry?.description || "";
    description.textContent = text;
    description.hidden = !text;
    if (!hasMetric) return;

    // Aggregation picker: the server lists what fits the metric type.
    const aggs = Array.isArray(data?.aggs) ? data.aggs : panel.agg ? [panel.agg] : [];
    const aggPicker = $(".metricsPicker--agg", el);
    const aggButton = $(".tracePicker__button", aggPicker);
    aggButton.textContent = `Aggregation \u00b7 ${panel.agg ? aggLabel(panel.agg) : "Default"}`;
    aggButton.disabled = !aggs.length;
    h.replace($(".tracePicker__menu", aggPicker), aggs.map((agg) => h("button", {
      type: "button", class: "themeSelect__option tracePicker__option", role: "option", "data-agg": agg, "aria-selected": agg === panel.agg,
    }, aggLabel(agg))));
    renderGroupButton(panel);
    const perSeries = !!data?.per_series;
    $(".metricsPicker--group .tracePicker__button", el).disabled = perSeries;
    renderFilters(panel);
    const exemplarControl = $(".metricsControl--exemplars", el);
    exemplarControl.hidden = !EXEMPLAR_KINDS.has(panel.kind);
    $("input", exemplarControl).checked = panel.exemplars;
    renderPanelNote(panel);

    const stateEl = $(".metricsChart__state", el);
    ns.uiState.busy($(".metricsChart", el), panel.loading);
    const ui = ns.uiState;
    if (panel.loading && !data) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--loading";
      ui.loading(stateEl, { label: "Loading the chart\u2026", compact: true });
    } else if (panel.error) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--error";
      ui.error(stateEl, { body: panel.error, compact: true, retry: { attrs: { "data-metrics-retry": "panel" } } });
    } else if (data && !(data.series || []).length) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--empty";
      ui.empty(stateEl, { body: "No data points for this metric, filters and time range.", compact: true });
    } else {
      stateEl.hidden = true;
      stateEl.removeAttribute("aria-busy");
    }
    drawChart(panel);
  }

  function renderPanelNote(panel) {
    const note = $(".metricsPanel__note", panel.el);
    if (!note) return;
    const data = panel.data;
    const parts = [];
    const text = (value) => (value == null ? "" : String(value));
    if (data?.note) parts.push(text(data.note));
    if (data?.truncated) parts.push(`Top ${text(data.top_k)} of ${text(data.group_count)} groups; the other ${text(data.other_series_count)} are folded into \u201cOther\u201d.`);
    if (data?.truncated_rows) parts.push("Too many groups: the result was cut; narrow the filters or the group-by.");
    if (panel.exemplars && panel.exemplarError) parts.push(`Exemplars: ${text(panel.exemplarError)}`);
    h.replace(note, parts.map((part) => h("span", null, part)));
    note.hidden = !parts.length;
  }

  function renderGroupButton(panel) {
    const button = $(".metricsPicker--group .tracePicker__button", panel.el);
    if (!button) return;
    button.textContent = `Group by \u00b7 ${panel.groupBy.length ? panel.groupBy.join(", ") : "None"}`;
    button.title = panel.groupBy.length ? `Group by ${panel.groupBy.join(", ")}` : "No grouping: one series";
  }

  function renderGroupMenu(panel, loading) {
    const menu = $(".metricsPicker--group .tracePicker__menu", panel.el);
    if (!menu) return;
    const keys = [...new Set([...(panel.keys || []), ...panel.groupBy])];
    if (loading && !panel.keys) { h.replace(menu, h("div", { class: "metricsPicker__hint" }, "Loading attributes\u2026")); return; }
    if (!keys.length) { h.replace(menu, h("div", { class: "metricsPicker__hint" }, "No point attributes.")); return; }
    h.replace(menu, keys.map((key) => {
      const checked = panel.groupBy.includes(key);
      const disabled = !checked && panel.groupBy.length >= 5;
      return h("label", { class: "metricsPicker__check" }, h("input", { type: "checkbox", "data-group-key": key, checked, disabled }), h("span", null, key));
    }));
  }

  function renderFilters(panel) {
    const chips = $(".metricsFilters__chips", panel.el);
    if (!chips) return;
    // The shared filter chips (ns.badge.chipHtml).
    chips.innerHTML = panel.filters.map((f, index) => ns.badge.chipHtml({
      key: f.key, op: f.op, value: f.value === "" ? "(empty)" : f.value, negated: f.op === "!=", className: "metricsChip",
      title: `${f.key} ${f.op} ${f.value}`,
      remove: { label: `Remove filter ${f.key} ${f.op} ${f.value}`, attrs: { "data-remove-filter": index } },
    })).join("");
  }

  // --- Chart ----------------------------------------------------------------
  // One canvas chart per panel (app_chart_core.js): lines with the slot
  // colours and dashes, the shared crosshair across panels, the engine's
  // tooltip and legend (click shows / hides, Alt+click isolates), exemplars as
  // links over the plot, and a drag that sets the time range of every panel.

  const SYNC_KEY = "metrics-panels";

  function seriesKey(series) {
    return series.other ? "\u0000other" : String(series.key ?? "");
  }

  function seriesName(panel, series) {
    if (series.other) return `Other (${Number(panel.data?.other_series_count || 0)} groups)`;
    const labels = series.labels && typeof series.labels === "object" ? Object.entries(series.labels) : [];
    if (!labels.length) return panel.data?.per_series ? "(no attributes)" : panel.metric;
    if (labels.length === 1 && !panel.data?.per_series) return labels[0][1] === "" ? "(none)" : labels[0][1];
    return labels.map(([k, v]) => `${k}=${v === "" ? "(none)" : v}`).join(", ");
  }

  // The service a series stands for: its only label is the service name.
  function seriesService(series) {
    const labels = series.labels && typeof series.labels === "object" ? Object.entries(series.labels) : [];
    return labels.length === 1 && SERVICE_KEYS.has(labels[0][0]) && labels[0][1] !== "" ? String(labels[0][1]) : null;
  }

  // A service series takes the service's colour (Traces, Logs); the others
  // the chart slots, dashed past the eighth.
  function slotStyle(index, other, service = null) {
    if (other) return { color: palette.categorical(-1), dash: [4, 3] };
    if (service) return { color: palette.service(service), dash: null };
    const cycle = Math.floor(index / COLOR_SLOTS);
    return { color: palette.categorical(index), dash: cycle === 0 ? null : cycle === 1 ? [6, 3] : [2, 3] };
  }

  // Exemplar values share the metric unit: they sit on the value axis when the
  // plotted aggregation has that unit (durations, gauge values), otherwise on a
  // strip along the bottom of the plot.
  function exemplarsOnAxis(data) {
    if (!data || String(data.value_unit ?? "") !== String(data.unit ?? "")) return false;
    if (data.kind === "gauge") return true;
    return !["increase", "count", "sum", "rate", "count_rate"].includes(String(data.agg || ""));
  }

  function exemplarTip(ex, metricInfo) {
    const attrs = ex.attributes && typeof ex.attributes === "object" ? Object.entries(ex.attributes).slice(0, 4) : [];
    return `<strong>Exemplar · ${esc(formatValue(Number(ex.value), metricInfo))}</strong>` +
      `<span class="metricsTip__bucket">${esc(fmt.time(Number(ex.t)))}</span>` +
      `<div class="metricsTip__trace">Trace <code>${esc(ex.trace_id)}</code></div>` +
      (ex.span_id ? `<div class="metricsTip__trace">Span <code>${esc(ex.span_id)}</code></div>` : "") +
      attrs.map(([k, v]) => `<div class="metricsTip__attr"><em>${esc(k)}</em> ${esc(v)}</div>`).join("") +
      `<div class="metricsTip__hint">Click to open the span</div>`;
  }

  // Exemplar links, largest values first (the engine skips a dot that would
  // overlap one already placed, so every drawn dot stays clickable).
  function exemplarMarkers(panel, data, x0, x1) {
    const list = panel.exemplars && Array.isArray(panel.exemplarData?.exemplars) ? panel.exemplarData.exemplars : [];
    const onAxis = exemplarsOnAxis(data);
    const metricInfo = parseUnit(data.unit);
    const markers = [];
    for (const ex of [...list].sort((a, b) => Number(b.value) - Number(a.value))) {
      const t = Number(ex.t);
      if (!Number.isFinite(t) || t < x0 || t > x1 || !ex.trace_id) continue;
      const value = Number(ex.value);
      const href = `${ns.router.url(`/observability/traces/${encodeURIComponent(ex.trace_id)}`)}${ex.span_id ? `?span=${encodeURIComponent(ex.span_id)}` : ""}`;
      markers.push({
        x: t,
        y: onAxis && Number.isFinite(value) ? value : null,
        href,
        className: "metricsExemplar",
        label: `Exemplar ${formatValue(value, metricInfo)} at ${fmt.time(t)}: open trace ${ex.trace_id}`,
        attrs: { "data-trace-id": ex.trace_id, "data-span-id": ex.span_id || "" },
        tooltip: () => exemplarTip(ex, metricInfo),
      });
    }
    return { markers, values: onAxis ? markers.map((m) => m.y).filter((v) => v != null) : [] };
  }

  // A drag over a panel sets the time range of every panel (whole seconds).
  function onChartZoom(range, fromUser) {
    if (!fromUser || !range) return;
    const startMs = Math.floor(range[0] / 1000) * 1000;
    const endMs = Math.ceil(range[1] / 1000) * 1000;
    if (endMs - startMs < 1000) return;
    applyRange({ from: ns.timeRange.formatDateTime(startMs), to: ns.timeRange.formatDateTime(endMs) });
  }

  function drawChart(panel) {
    const el = panel.el;
    const data = panel.data;
    if (!el) return;
    const plot = $(".metricsChart__plot", el);
    const axisTitle = $(".metricsChart__axisTitle", el);
    const series = Array.isArray(data?.series) ? data.series : [];
    const timestamps = Array.isArray(data?.timestamps) ? data.timestamps : [];
    const core = ns.chartCore;
    if (!data || !series.length || !timestamps.length || !core) {
      axisTitle.textContent = "";
      if (panel.chart) panel.chart.root.hidden = true;
      return;
    }
    const valueInfo = parseUnit(data.value_unit ?? data.unit);
    axisTitle.textContent = `${aggLabel(data.agg)}${unitTitle(valueInfo, data.value_unit) ? ` · ${unitTitle(valueInfo, data.value_unit)}` : ""} · ${fmt.duration.fromMs(Number(data.bucket_ms || 0))} buckets`;

    const n = timestamps.length;
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) xs[i] = Number(timestamps[i]);
    const bucketMs = Number(data.bucket_ms) || 60000;
    const x0 = Number(data.range?.[0] ?? xs[0]);
    const x1 = Math.max(Number(data.range?.[1] ?? xs[n - 1] + bucketMs), x0 + 1);
    // A series exported less often than the bucket has regular empty buckets:
    // bridgeGaps joins those, longer gaps break the line, a lone point is a dot.
    palette.registerServices(series.map(seriesService).filter(Boolean));
    const lines = series.map((s, index) => {
      const style = slotStyle(index, !!s.other, s.other ? null : seriesService(s));
      const values = new Float64Array(n);
      const raw = Array.isArray(s.values) ? s.values : [];
      for (let i = 0; i < n; i++) {
        const v = raw[i];
        values[i] = v == null || v === "" ? NaN : Number(v);
      }
      return { id: seriesKey(s), label: seriesName(panel, s), color: style.color, dash: style.dash, values, nulls: core.bridgeGaps(values) };
    });
    const { markers, values: exemplarValues } = exemplarMarkers(panel, data, x0, x1);
    const showLegend = !(series.length <= 1 && !series[0]?.other && !data.group_by?.length && !data.per_series);
    const options = {
      xs,
      xDomain: [x0, x1],
      series: lines,
      hidden: [...panel.hidden],
      legend: showLegend,
      markers,
      yInclude: [0, ...exemplarValues],
      yUnit: (maxAbs) => axisFormatter(valueInfo, maxAbs),
      formatValue: (v) => formatValue(v, valueInfo),
      formatY: (v) => formatValue(v, valueInfo),
      // The bucket a cursor position stands for, like the Traces charts.
      bucketMs,
      tooltipFooter: () => `${fmt.duration.fromMs(bucketMs)} bucket`,
    };
    if (!panel.chart) {
      panel.chart = core.create(plot, {
        ...options,
        xKind: "time",
        type: "line",
        height: PLOT_HEIGHT,
        xFractionDigits: 0,
        syncKey: SYNC_KEY,
        legendClick: "toggle",
        tooltipSort: "desc",
        tooltipMaxRows: TOOLTIP_ROWS,
        tooltipNulls: false,
        onZoom: onChartZoom,
        onHiddenChange: (next) => { panel.hidden = next; },
      });
      panel.chart.root.setAttribute("role", "group");
    } else {
      panel.chart.root.hidden = false;
      panel.chart.setData({ ...options, zoom: null });
    }
    panel.chart.root.setAttribute("aria-label", `${panel.metric} chart`);
  }

  function destroyChart(panel) {
    if (!panel.chart) return;
    panel.chart.destroy();
    panel.chart = null;
  }

  // --- Time range -----------------------------------------------------------

  let timePicker = null;

  function initTimeRangePicker() {
    const unit = byId("metricsRangeUnit");
    const root = unit?.parentElement;
    if (!ns.timeRange || !$(":scope > .tracePicker__button", root)) return;
    timePicker = ns.timeRange.create(root, {
      idPrefix: "metrics",
      getValue: () => model.range,
      getMaxMinutes: () => MAX_RANGE_MINUTES,
      onApply: (raw) => { timePicker?.close(); applyRange(raw); },
    });
  }

  function applyRange(raw) {
    model.range = { from: String(raw.from), to: String(raw.to) };
    timePicker?.refresh?.();
    address.push();
    reloadAll();
  }

  function renderRangeInfo() {
    const info = byId("metricsRangeInfo");
    if (!info) return;
    const r = model.resolved;
    // A relative range ("Last 6 hours") shows what it resolved to; an
    // absolute one already reads as dates on the picker.
    info.textContent = r && ns.timeRange?.isRelative?.(model.range) ? fmt.range(r.start_ms, r.end_ms) : "";
  }

  // --- Lifecycle ------------------------------------------------------------

  function reloadAll() {
    try {
      resolveRange();
      showError("");
    } catch (e) {
      showError(e.message);
      return;
    }
    renderRangeInfo();
    for (const panel of model.panels) {
      panel.keys = null;
      panel.values = new Map();
    }
    loadCatalog();
    for (const panel of model.panels) loadPanel(panel);
  }

  let started = false;
  async function start() {
    if (started || !state.selectedHostId) return;
    started = true;
    await loadMeta();
    reloadAll();
  }

  // Back / Forward, or the Observability page showing this view again: a URL
  // that changed while the view was away (or another entry) reloads.
  function onLocation() {
    const before = urlQuery();
    const previous = model.panels;
    readUrl();
    timePicker?.refresh?.();
    if (urlQuery() === before && model.catalog) {
      // Same state: the panels (and their charts) stay.
      model.panels = previous;
      if (model.focusService) renderCatalog();
      return;
    }
    for (const panel of previous) destroyChart(panel);
    dom.metricsPanels?.replaceChildren();
    renderPanels();
    reloadAll();
  }

  // A host change while another view is shown reloads when this one comes back.
  let reloadWhenShown = false;

  function onShow() {
    if (reloadWhenShown) {
      reloadWhenShown = false;
      model.catalog = null;
      loadMeta().then(reloadAll);
    }
  }

  function onHide() {
    closePickers();
  }

  // Shared with the other Observability views: the time range, and the
  // service of the active panel.
  function getContext() {
    const service = model.panels[model.active]?.service || "";
    return { range: { ...model.range }, service: service || null };
  }

  // The range goes to the URL; a service opens its group of the catalog.
  function applyContext(params, context) {
    if (context.range) {
      params.set("from", context.range.from);
      params.set("to", context.range.to);
    }
    if (context.service) model.focusService = context.service;
  }

  function init() {
    dom.metricsCatalog = byId("metricsCatalog");
    dom.metricsCatalogSummary = byId("metricsCatalogSummary");
    dom.metricsPanels = byId("metricsPanels");
    dom.metricsError = byId("metricsError");
    dom.metricsAddPanelButton = byId("metricsAddPanelButton");

    readUrl();
    initTimeRangePicker();
    address.replace();
    renderPanels();

    // The catalog's shell (ns.sidePanel): folded to a 32 px rail on wide
    // windows (remembered), a drawer on phones opened from the charts' top.
    ns.sidePanel.mount(byId("metricsSidebar"), {
      label: "Metrics",
      collapse: { button: byId("metricsSidebarToggle"), storeKey: ns.storage.KEYS.metricsCatalogCollapsed, rootClass: "chdash-metrics-catalog-collapsed" },
      drawer: { host: $(".metricsMain") },
    });
    dom.metricsCatalog?.addEventListener("click", onCatalogClick);
    const search = byId("metricsSearch");
    // ns.search flushes on Enter first: the catalog is filtered when the handler below opens its first metric.
    ns.search.bind(search, (value) => { model.search = value; renderCatalog(); });
    search?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        $(".metricsCatalog__metric", dom.metricsCatalog)?.click();
      }
    });
    byId("metricsToolbar")?.addEventListener("submit", (event) => { event.preventDefault(); reloadAll(); });
    dom.metricsAddPanelButton?.addEventListener("click", addPanel);
    window.addEventListener("chdash:host-changed", () => {
      started = true;
      if (!address.active()) { reloadWhenShown = true; return; }
      model.catalog = null;
      loadMeta().then(reloadAll);
    });
    ns.features.on((features) => {
      if (features?.metrics?.enabled === false || !address.active()) return;
      start();
    });
    start();
  }

  ns.metrics = {
    init, onLocation, onShow, onHide, getContext, applyContext,
    // Exposed for tests.
    parseUnit, formatValue, axisFormatter, formatTick,
  };
})();
