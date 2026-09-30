(() => {
  "use strict";

  // Metrics browser (/metrics): a catalog of the OpenTelemetry metrics stored
  // by the ClickHouse exporter (service -> metric), and chart panels drawn from
  // the server-side aggregations of /api/metrics/series, with exemplar dots
  // linking to the trace and span that produced them. Everything the user
  // picks (range, panels, aggregation, group-by, filters) lives in the URL.
  const ns = window.ChDash;
  if (!ns) return;
  const { dom, state, api, ui } = ns;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_RANGE_MINUTES = 90 * 24 * 60;
  const PLOT_HEIGHT = 280;
  const MARGIN = { top: 14, right: 14, bottom: 28 };
  const COLOR_SLOTS = 8;
  const TOOLTIP_ROWS = 12;
  const KIND_LABEL = {
    gauge: "Gauge", sum: "Sum", histogram: "Histogram", exponential_histogram: "Exponential histogram", summary: "Summary",
  };
  const KIND_BADGE = { gauge: "gauge", sum: "sum", histogram: "hist", exponential_histogram: "exp hist", summary: "summary" };
  const AGG_LABEL = {
    avg: "Average", min: "Min", max: "Max", last: "Last value", sum: "Sum", rate: "Rate (per second)", increase: "Increase",
    count_rate: "Count rate (per second)", count: "Count",
  };
  const EXEMPLAR_KINDS = new Set(["gauge", "sum", "histogram", "exponential_histogram"]);

  const esc = (value) => String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const route = (path) => api.resolveUrl(String(path || "").replace(/^\/+/, ""));
  const pad2 = (value) => String(value).padStart(2, "0");

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

  // Up to three significant digits, trailing zeros dropped: 182, 18.2, 1.82.
  function significant(value) {
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    const fixed = value.toFixed(digits);
    return digits ? fixed.replace(/\.?0+$/, "") : fixed;
  }

  function pickStep(steps, magnitude) {
    let chosen = steps[0];
    for (const step of steps) if (magnitude >= step[0]) chosen = step;
    return chosen;
  }

  function formatNumber(value) {
    const abs = Math.abs(value);
    if (abs === 0) return "0";
    if (abs >= 1e4) {
      const unit = ns.queryChart?.compactUnitFor ? ns.queryChart.compactUnitFor(abs) : { factor: 1, suffix: "" };
      return `${significant(value / unit.factor)}${unit.suffix}`;
    }
    if (abs >= 1) return Number(value.toPrecision(4)).toLocaleString("en-US", { maximumFractionDigits: 3 });
    if (abs >= 1e-4) return Number(value.toPrecision(3)).toString();
    return value.toExponential(2);
  }

  // One value with its unit, for tooltips and the legend.
  function formatValue(value, info) {
    if (value == null || !Number.isFinite(value)) return "—";
    const rate = info.perSecond ? "/s" : "";
    if (info.kind === "duration") {
      const seconds = value * info.scale;
      if (seconds === 0) return `0 s${rate}`;
      const [factor, name] = pickStep(DURATION_STEPS, Math.abs(seconds));
      return `${significant(seconds / factor)} ${name}${rate}`;
    }
    if (info.kind === "bytes") {
      const bytes = value * info.scale;
      const [factor, name] = pickStep(BYTE_STEPS, Math.abs(bytes));
      return `${factor === 1 ? formatNumber(bytes) : significant(bytes / factor)} ${name}${rate}`;
    }
    if (info.kind === "percent") return `${formatNumber(value)}%${rate}`;
    const label = info.label ? ` ${info.label}` : "";
    return `${formatNumber(value)}${label}${rate}`;
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
    const compact = ns.queryChart?.compactUnitFor ? ns.queryChart.compactUnitFor(maxAbs) : { factor: 1, suffix: "" };
    return { factor: compact.factor, suffix: compact.suffix };
  }

  function formatTick(value, step, formatter) {
    if (value === 0) return "0";
    const scaledStep = Math.abs(step / formatter.factor);
    const decimals = scaledStep > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(scaledStep) - 1e-9))) : 0;
    const text = (value / formatter.factor).toFixed(decimals);
    return `${/^-0(?:\.0*)?$/.test(text) ? "0" : text}${formatter.suffix}`;
  }

  function niceTicks(min, max, count) {
    if (ns.queryChart?.niceTicks) return ns.queryChart.niceTicks(min, max, count);
    const step = (max - min) / Math.max(1, count) || 1;
    const values = [];
    for (let i = 0; i <= count; i++) values.push(min + i * step);
    return { min, max, step, values };
  }

  function formatInstant(ms) {
    if (!Number.isFinite(ms)) return "—";
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function formatBucket(ms) {
    const minutes = ms / 60000;
    if (minutes < 1) return `${Math.round(ms / 1000)} s`;
    if (minutes < 60) return `${Math.round(minutes)} min`;
    if (minutes < 1440) return `${Math.round(minutes / 60)} h`;
    return `${Math.round(minutes / 1440)} d`;
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
      seq: 0,
      exemplarData: null,
      exemplarError: "",
      keys: null,
      keysPromise: null,
      values: new Map(),
      hidden: new Set(),
      el: null,
      hover: null,
      filterDraft: null,
    };
  }

  const model = {
    range: { from: "now-1h", to: "now" },
    catalog: null,
    catalogError: "",
    catalogLoading: false,
    catalogSeq: 0,
    meta: null,
    search: "",
    collapsed: new Set(),
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

  function writeUrl({ push = false } = {}) {
    const params = new URLSearchParams();
    params.set("from", model.range.from);
    params.set("to", model.range.to);
    const [first, ...rest] = model.panels;
    if (first) panelParams(first, params);
    for (const panel of rest) params.append("panel", panelParams(panel, new URLSearchParams()).toString());
    if (model.active > 0) params.set("active", String(model.active));
    const url = `${route("metrics")}?${params.toString()}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    if (push) window.history.pushState({ metrics: true }, "", url);
    else window.history.replaceState({ metrics: true }, "", url);
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

  function showError(message) {
    if (!dom.metricsError) return;
    dom.metricsError.hidden = !message;
    dom.metricsError.textContent = message || "";
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
    const seq = ++model.catalogSeq;
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
      const data = await api.getJson(`api/metrics/catalog?${hostParams(range).toString()}`);
      if (seq !== model.catalogSeq) return;
      model.catalog = data;
    } catch (e) {
      if (seq !== model.catalogSeq) return;
      model.catalog = null;
      model.catalogError = e?.message || "Cannot load the metrics catalog.";
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
      root.innerHTML = `<div class="metricsEmpty metricsEmpty--loading">Loading the metrics catalog…</div>`;
      if (summary) summary.textContent = "Loading metrics…";
      return;
    }
    if (model.catalogError) {
      root.innerHTML = `<div class="metricsEmpty metricsEmpty--error">${esc(model.catalogError)}</div>`;
      if (summary) summary.textContent = "Catalog unavailable";
      return;
    }
    const services = model.catalog?.services || [];
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
        const unit = m.unit ? `<span class="metricsBadge metricsBadge--unit" title="Unit">${esc(m.unit)}</span>` : "";
        const title = `${m.name}\n${KIND_LABEL[m.kind] || m.kind}${m.unit ? ` · ${m.unit}` : ""}${temporalityLabel(m) ? ` · ${temporalityLabel(m)}` : ""}\n${Number(m.points || 0).toLocaleString("en-US")} points${m.description ? `\n${m.description}` : ""}`;
        return `<button type="button" class="metricsCatalog__metric${selected ? " is-selected" : ""}" role="treeitem" aria-selected="${selected}" data-service="${esc(svc.name)}" data-metric="${esc(m.name)}" data-kind="${esc(m.kind)}" title="${esc(title)}">
          <span class="metricsCatalog__name">${highlight(m.name, needle)}</span>
          <span class="metricsCatalog__badges"><span class="metricsBadge metricsBadge--${esc(m.kind)}">${esc(KIND_BADGE[m.kind] || m.kind)}</span>${unit}</span>
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
      root.innerHTML = `<div class="metricsEmpty">No metric points in this time range.${jumpToDataHtml()}</div>`;
    } else if (!groups.length) {
      root.innerHTML = `<div class="metricsEmpty">No metric matches “${esc(model.search.trim())}”.</div>`;
    } else {
      root.innerHTML = groups.join("");
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
  function jumpToDataHtml() {
    const bounds = model.meta?.time_bounds;
    const max = Number(bounds?.max_ms);
    if (!Number.isFinite(max) || max <= 0) return "";
    const range = model.resolved;
    if (range && max >= range.start_ms && max <= range.end_ms) return "";
    return `<button type="button" class="button metricsEmpty__jump" data-jump-to-data="${max}">Show the last 24 h with data (until ${esc(formatInstant(max))})</button>`;
  }

  function jumpToData(maxMs) {
    const tr = ns.timeRange;
    const end = Math.ceil(maxMs / 60000) * 60000;
    applyRange({ from: tr.formatDateTime(end - 24 * 3600000), to: tr.formatDateTime(end) });
  }

  function onCatalogClick(event) {
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
    writeUrl({ push: !same });
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
    writeUrl();
    renderCatalog();
  }

  function addPanel() {
    const panel = newPanel();
    model.panels.push(panel);
    model.active = model.panels.length - 1;
    writeUrl({ push: true });
    renderPanels();
    renderCatalog();
    panel.el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function removePanel(panel) {
    if (model.panels.length <= 1) return;
    const index = panelIndex(panel);
    model.panels.splice(index, 1);
    panel.el?.remove();
    panel.el = null;
    if (model.active >= model.panels.length) model.active = model.panels.length - 1;
    else if (model.active > index) model.active -= 1;
    writeUrl({ push: true });
    renderPanels();
    renderCatalog();
  }

  async function loadPanel(panel) {
    if (!panel.metric || !panel.kind || !panel.service) return;
    const seq = ++panel.seq;
    panel.loading = true;
    panel.error = "";
    renderPanel(panel);
    try {
      const query = panelQuery(panel, { agg: panel.agg, group_by: panel.groupBy.join(","), ...filterParams(panel) });
      const data = await api.getJson(`api/metrics/series?${query.toString()}`);
      if (seq !== panel.seq) return;
      panel.data = data;
      if (data?.agg && data.agg !== panel.agg) {
        panel.agg = data.agg;
        writeUrl();
      }
    } catch (e) {
      if (seq !== panel.seq) return;
      panel.data = null;
      panel.error = e?.message || "Cannot load the metric.";
    }
    panel.loading = false;
    renderPanel(panel);
    if (panel.exemplars && EXEMPLAR_KINDS.has(panel.kind) && panel.data) loadExemplars(panel, seq);
    else { panel.exemplarData = null; drawChart(panel); }
  }

  async function loadExemplars(panel, seq) {
    try {
      const query = panelQuery(panel, { step_ms: panel.data?.bucket_ms, ...filterParams(panel) });
      const data = await api.getJson(`api/metrics/exemplars?${query.toString()}`);
      if (seq !== panel.seq) return;
      panel.exemplarData = data;
      panel.exemplarError = "";
    } catch (e) {
      if (seq !== panel.seq) return;
      panel.exemplarData = null;
      panel.exemplarError = e?.message || "Cannot load exemplars.";
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
    el.className = "metricsPanel";
    el.dataset.panelId = String(panel.id);
    el.innerHTML = `
      <header class="metricsPanel__header">
        <div class="metricsPanel__titleRow">
          <h2 class="metricsPanel__name"></h2>
          <div class="metricsPanel__badges"></div>
          <button type="button" class="metricsPanel__remove" aria-label="Remove panel" title="Remove panel"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
        </div>
        <p class="metricsPanel__description"></p>
      </header>
      <div class="traceSearchBar metricsPanel__controls">
        <div class="metricsControl metricsControl--agg">
          <span class="metricsControl__label">Aggregation</span>
          <div class="themeSelect tracePicker metricsPicker metricsPicker--agg">
            <button class="button themeSelect__button tracePicker__button" type="button" aria-haspopup="listbox" aria-expanded="false">—</button>
            <div class="themeSelect__menu tracePicker__menu" role="listbox" tabindex="-1" hidden></div>
          </div>
        </div>
        <div class="metricsControl metricsControl--group">
          <span class="metricsControl__label">Group by</span>
          <div class="themeSelect tracePicker metricsPicker metricsPicker--group">
            <button class="button themeSelect__button tracePicker__button" type="button" aria-haspopup="listbox" aria-expanded="false">None</button>
            <div class="themeSelect__menu tracePicker__menu" role="listbox" aria-multiselectable="true" tabindex="-1" hidden></div>
          </div>
        </div>
        <div class="metricsControl metricsControl--filters">
          <span class="metricsControl__label">Filters</span>
          <div class="metricsFilters">
            <div class="metricsFilters__chips"></div>
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
        <div class="metricsFilterForm__ops" role="group" aria-label="Filter operator">
          <button type="button" class="metricsFilterForm__op is-active" data-op="=" aria-pressed="true">=</button>
          <button type="button" class="metricsFilterForm__op" data-op="!=" aria-pressed="false">!=</button>
        </div>
        <input class="metricsFilterForm__value" type="text" placeholder="Value" aria-label="Filter value" spellcheck="false" />
        <button type="submit" class="button button--primary metricsFilterForm__apply">Add filter</button>
        <button type="button" class="button metricsFilterForm__cancel">Cancel</button>
        <datalist class="metricsFilterForm__keys"></datalist>
        <datalist class="metricsFilterForm__values"></datalist>
      </form>
      <div class="metricsPanel__note" hidden></div>
      <div class="metricsChart">
        <div class="metricsChart__axisTitle"></div>
        <div class="metricsChart__plot">
          <div class="metricsChart__state" hidden></div>
          <div class="queryChart__tooltip metricsChart__tooltip" role="status" hidden></div>
        </div>
        <div class="queryChart__legend metricsChart__legend" role="group" aria-label="Series"></div>
      </div>
      <div class="metricsPanel__empty metricsEmpty metricsEmpty--panel">Pick a metric in the catalog to chart it.</div>`;
    const keysList = el.querySelector(".metricsFilterForm__keys");
    const valuesList = el.querySelector(".metricsFilterForm__values");
    keysList.id = `metricsFilterKeys${panel.id}`;
    valuesList.id = `metricsFilterValues${panel.id}`;
    el.querySelector(".metricsFilterForm__key").setAttribute("list", keysList.id);
    el.querySelector(".metricsFilterForm__value").setAttribute("list", valuesList.id);
    bindPanel(panel, el);
    return el;
  }

  // Pickers reuse the connected tracePicker surface and motion.
  const openPickers = new Set();
  function openPicker(root) {
    const button = root.querySelector(":scope > .tracePicker__button");
    const menu = root.querySelector(":scope > .tracePicker__menu");
    if (!button || !menu || button.disabled) return;
    closePickers(root);
    if (root._closeTimer) { clearTimeout(root._closeTimer); root._closeTimer = null; }
    root.classList.remove("themeSelect--closing");
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openPickers.add(root);
    requestAnimationFrame(() => {
      if (button.getAttribute("aria-expanded") !== "true") return;
      root.classList.add("themeSelect--open");
      menu.focus({ preventScroll: true });
    });
  }
  function closePicker(root, { immediate = false } = {}) {
    const button = root.querySelector(":scope > .tracePicker__button");
    const menu = root.querySelector(":scope > .tracePicker__menu");
    openPickers.delete(root);
    if (root._closeTimer) { clearTimeout(root._closeTimer); root._closeTimer = null; }
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
      root._closeTimer = null;
    }, 160);
  }
  function closePickers(except = null) {
    for (const root of [...openPickers]) if (root !== except) closePicker(root);
  }
  function isOpen(root) { return root.querySelector(":scope > .tracePicker__button")?.getAttribute("aria-expanded") === "true"; }

  function bindPanel(panel, el) {
    el.addEventListener("pointerdown", () => setActive(panel));
    el.addEventListener("focusin", () => setActive(panel));
    el.querySelector(".metricsPanel__remove").addEventListener("click", () => removePanel(panel));

    const aggPicker = el.querySelector(".metricsPicker--agg");
    aggPicker.querySelector(".tracePicker__button").addEventListener("click", (event) => {
      event.stopPropagation();
      if (isOpen(aggPicker)) closePicker(aggPicker); else openPicker(aggPicker);
    });
    aggPicker.querySelector(".tracePicker__menu").addEventListener("click", (event) => {
      const option = event.target.closest("[data-agg]");
      if (!option) return;
      closePicker(aggPicker);
      if (option.dataset.agg === panel.agg) return;
      panel.agg = option.dataset.agg;
      panel.hidden.clear();
      writeUrl();
      loadPanel(panel);
    });

    const groupPicker = el.querySelector(".metricsPicker--group");
    groupPicker.querySelector(".tracePicker__button").addEventListener("click", async (event) => {
      event.stopPropagation();
      if (isOpen(groupPicker)) { closePicker(groupPicker); return; }
      renderGroupMenu(panel, true);
      openPicker(groupPicker);
      await ensureKeys(panel);
      renderGroupMenu(panel, false);
    });
    groupPicker.querySelector(".tracePicker__menu").addEventListener("change", (event) => {
      const box = event.target.closest("input[data-group-key]");
      if (!box) return;
      const key = box.dataset.groupKey;
      const next = panel.groupBy.filter((k) => k !== key);
      if (box.checked) next.push(key);
      panel.groupBy = next.slice(0, 5);
      panel.hidden.clear();
      writeUrl();
      renderGroupButton(panel);
      loadPanel(panel);
    });

    for (const picker of [aggPicker, groupPicker]) {
      picker.querySelector(".tracePicker__menu").addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); closePicker(picker); picker.querySelector(".tracePicker__button")?.focus({ preventScroll: true }); }
      });
    }

    const chips = el.querySelector(".metricsFilters__chips");
    chips.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-filter]");
      if (!remove) return;
      panel.filters.splice(Number(remove.dataset.removeFilter), 1);
      writeUrl();
      renderFilters(panel);
      loadPanel(panel);
    });

    const form = el.querySelector(".metricsFilterForm");
    const addButton = el.querySelector(".metricsFilters__add");
    const keyInput = form.querySelector(".metricsFilterForm__key");
    const valueInput = form.querySelector(".metricsFilterForm__value");
    const opButtons = [...form.querySelectorAll(".metricsFilterForm__op")];
    const setOp = (op) => {
      form.dataset.op = op;
      for (const b of opButtons) { b.classList.toggle("is-active", b.dataset.op === op); b.setAttribute("aria-pressed", String(b.dataset.op === op)); }
    };
    setOp("=");
    const closeForm = () => { form.hidden = true; addButton.setAttribute("aria-expanded", "false"); };
    addButton.addEventListener("click", async () => {
      if (!form.hidden) { closeForm(); return; }
      form.hidden = false;
      addButton.setAttribute("aria-expanded", "true");
      keyInput.value = "";
      valueInput.value = "";
      setOp("=");
      keyInput.focus({ preventScroll: true });
      const keys = await ensureKeys(panel);
      form.querySelector(".metricsFilterForm__keys").innerHTML = keys.map((k) => `<option value="${esc(k)}"></option>`).join("");
    });
    for (const b of opButtons) b.addEventListener("click", () => setOp(b.dataset.op));
    const refreshValues = async () => {
      const key = keyInput.value.trim();
      const list = form.querySelector(".metricsFilterForm__values");
      if (!key || !(panel.keys || []).includes(key)) { list.innerHTML = ""; return; }
      const values = await ensureValues(panel, key);
      if (keyInput.value.trim() !== key) return;
      list.innerHTML = values.map((v) => `<option value="${esc(v.value)}">${esc(`${Number(v.points || 0).toLocaleString("en-US")} points`)}</option>`).join("");
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
      writeUrl();
      renderFilters(panel);
      loadPanel(panel);
    });
    form.querySelector(".metricsFilterForm__cancel").addEventListener("click", closeForm);
    form.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeForm(); addButton.focus(); } });

    el.querySelector(".metricsExemplarToggle").addEventListener("change", (event) => {
      panel.exemplars = !!event.target.checked;
      writeUrl();
      if (panel.exemplars && EXEMPLAR_KINDS.has(panel.kind) && panel.data) loadExemplars(panel, panel.seq);
      else { panel.exemplarData = null; renderPanelNote(panel); drawChart(panel); }
    });

    const legend = el.querySelector(".metricsChart__legend");
    legend.addEventListener("click", (event) => {
      const item = event.target.closest("[data-series-key]");
      if (!item) return;
      const key = item.dataset.seriesKey;
      const series = panel.data?.series || [];
      if (event.altKey || event.metaKey) {
        // Isolate: show only this series (again: show all).
        const others = series.filter((s) => seriesKey(s) !== key).map(seriesKey);
        const isolated = others.every((k) => panel.hidden.has(k)) && !panel.hidden.has(key);
        panel.hidden.clear();
        if (!isolated) for (const k of others) panel.hidden.add(k);
      } else if (panel.hidden.has(key)) panel.hidden.delete(key);
      else panel.hidden.add(key);
      drawChart(panel);
    });

    const plot = el.querySelector(".metricsChart__plot");
    plot.addEventListener("pointermove", (event) => onPlotPointer(panel, event));
    plot.addEventListener("pointerleave", () => hideHover(panel));
  }

  function renderPanel(panel) {
    const el = panel.el;
    if (!el) return;
    const entry = catalogEntry(panel.service, panel.metric, panel.kind);
    const data = panel.data;
    const hasMetric = !!panel.metric;
    el.classList.toggle("is-empty", !hasMetric);
    el.querySelector(".metricsPanel__remove").hidden = model.panels.length <= 1;
    el.querySelector(".metricsPanel__header").hidden = !hasMetric && model.panels.length <= 1;
    el.querySelector(".metricsPanel__controls").hidden = !hasMetric;
    el.querySelector(".metricsChart").hidden = !hasMetric;
    el.querySelector(".metricsPanel__empty").hidden = hasMetric;
    const name = el.querySelector(".metricsPanel__name");
    name.textContent = hasMetric ? panel.metric : "Empty panel";
    name.title = hasMetric ? panel.metric : "";
    const unit = data?.unit ?? entry?.unit ?? "";
    const temporality = data?.temporality ?? entry?.temporality ?? null;
    const monotonic = data?.monotonic ?? entry?.monotonic ?? null;
    const badges = [];
    if (hasMetric) {
      badges.push(`<span class="metricsBadge metricsBadge--${esc(panel.kind)}" title="Metric type">${esc(KIND_LABEL[panel.kind] || panel.kind || "?")}</span>`);
      if (unit) badges.push(`<span class="metricsBadge metricsBadge--unit" title="Unit">${esc(unit)}</span>`);
      if (temporality) badges.push(`<span class="metricsBadge" title="Aggregation temporality">${esc(temporality)}</span>`);
      if (panel.kind === "sum" && monotonic != null) badges.push(`<span class="metricsBadge" title="Monotonic">${monotonic ? "monotonic" : "non-monotonic"}</span>`);
      badges.push(`<span class="metricsPanel__service" title="Service">${esc(panel.service)}</span>`);
    }
    el.querySelector(".metricsPanel__badges").innerHTML = badges.join("");
    const description = el.querySelector(".metricsPanel__description");
    const text = data?.description || entry?.description || "";
    description.textContent = text;
    description.hidden = !text;
    if (!hasMetric) return;

    // Aggregation picker: the server lists what fits the metric type.
    const aggs = Array.isArray(data?.aggs) ? data.aggs : panel.agg ? [panel.agg] : [];
    const aggPicker = el.querySelector(".metricsPicker--agg");
    const aggButton = aggPicker.querySelector(".tracePicker__button");
    aggButton.textContent = panel.agg ? aggLabel(panel.agg) : "Default";
    aggButton.disabled = !aggs.length;
    aggPicker.querySelector(".tracePicker__menu").innerHTML = aggs.map((agg) =>
      `<button type="button" class="themeSelect__option tracePicker__option" role="option" data-agg="${esc(agg)}" aria-selected="${agg === panel.agg}">${esc(aggLabel(agg))}</button>`).join("");
    renderGroupButton(panel);
    const perSeries = !!data?.per_series;
    el.querySelector(".metricsPicker--group .tracePicker__button").disabled = perSeries;
    renderFilters(panel);
    const exemplarControl = el.querySelector(".metricsControl--exemplars");
    exemplarControl.hidden = !EXEMPLAR_KINDS.has(panel.kind);
    exemplarControl.querySelector("input").checked = panel.exemplars;
    renderPanelNote(panel);

    const stateEl = el.querySelector(".metricsChart__state");
    el.querySelector(".metricsChart").classList.toggle("is-loading", panel.loading);
    if (panel.loading && !data) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--loading";
      stateEl.textContent = "Loading…";
    } else if (panel.error) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--error";
      stateEl.textContent = panel.error;
    } else if (data && !(data.series || []).length) {
      stateEl.hidden = false;
      stateEl.className = "metricsChart__state metricsChart__state--empty";
      stateEl.textContent = "No data points for this metric, filters and time range.";
    } else {
      stateEl.hidden = true;
    }
    drawChart(panel);
  }

  function renderPanelNote(panel) {
    const note = panel.el?.querySelector(".metricsPanel__note");
    if (!note) return;
    const data = panel.data;
    const parts = [];
    if (data?.note) parts.push(esc(data.note));
    if (data?.truncated) parts.push(`Top ${esc(data.top_k)} of ${esc(data.group_count)} groups; the other ${esc(data.other_series_count)} are folded into “Other”.`);
    if (data?.truncated_rows) parts.push("Too many groups: the result was cut; narrow the filters or the group-by.");
    if (panel.exemplars && panel.exemplarError) parts.push(`Exemplars: ${esc(panel.exemplarError)}`);
    note.innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
    note.hidden = !parts.length;
  }

  function renderGroupButton(panel) {
    const button = panel.el?.querySelector(".metricsPicker--group .tracePicker__button");
    if (!button) return;
    button.textContent = panel.groupBy.length ? panel.groupBy.join(", ") : "None";
    button.title = panel.groupBy.length ? `Group by ${panel.groupBy.join(", ")}` : "No grouping: one series";
  }

  function renderGroupMenu(panel, loading) {
    const menu = panel.el?.querySelector(".metricsPicker--group .tracePicker__menu");
    if (!menu) return;
    const keys = [...new Set([...(panel.keys || []), ...panel.groupBy])];
    if (loading && !panel.keys) { menu.innerHTML = `<div class="metricsPicker__hint">Loading attributes…</div>`; return; }
    if (!keys.length) { menu.innerHTML = `<div class="metricsPicker__hint">No point attributes.</div>`; return; }
    menu.innerHTML = keys.map((key) => {
      const checked = panel.groupBy.includes(key);
      const disabled = !checked && panel.groupBy.length >= 5;
      return `<label class="metricsPicker__check"><input type="checkbox" data-group-key="${esc(key)}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} /><span>${esc(key)}</span></label>`;
    }).join("");
  }

  function renderFilters(panel) {
    const chips = panel.el?.querySelector(".metricsFilters__chips");
    if (!chips) return;
    chips.innerHTML = panel.filters.map((f, index) =>
      `<span class="metricsChip${f.op === "!=" ? " metricsChip--not" : ""}" title="${esc(`${f.key} ${f.op} ${f.value}`)}"><span class="metricsChip__key">${esc(f.key)}</span><span class="metricsChip__op">${esc(f.op)}</span><span class="metricsChip__value">${esc(f.value === "" ? "(empty)" : f.value)}</span><button type="button" class="metricsChip__remove" data-remove-filter="${index}" aria-label="Remove filter ${esc(`${f.key} ${f.op} ${f.value}`)}">×</button></span>`).join("");
  }

  // --- Chart ----------------------------------------------------------------

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

  function slotStyle(index, other) {
    if (other) return { color: "var(--qchart-other)", dash: "4 3" };
    const color = `var(--qchart-${(index % COLOR_SLOTS) + 1})`;
    const cycle = Math.floor(index / COLOR_SLOTS);
    return { color, dash: cycle === 0 ? "" : cycle === 1 ? "6 3" : "2 3" };
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
    return node;
  }

  // Exemplar values share the metric unit: they sit on the value axis when the
  // plotted aggregation has that unit (durations, gauge values), otherwise on a
  // strip along the bottom of the plot.
  function exemplarsOnAxis(data) {
    if (!data || String(data.value_unit ?? "") !== String(data.unit ?? "")) return false;
    if (data.kind === "gauge") return true;
    return !["increase", "count", "sum", "rate", "count_rate"].includes(String(data.agg || ""));
  }

  function drawChart(panel) {
    const el = panel.el;
    const data = panel.data;
    if (!el) return;
    const plot = el.querySelector(".metricsChart__plot");
    const legend = el.querySelector(".metricsChart__legend");
    const axisTitle = el.querySelector(".metricsChart__axisTitle");
    plot.querySelector("svg")?.remove();
    panel.hover = null;
    const series = Array.isArray(data?.series) ? data.series : [];
    const timestamps = Array.isArray(data?.timestamps) ? data.timestamps.map(Number) : [];
    if (!data || !series.length || !timestamps.length) {
      legend.innerHTML = "";
      axisTitle.textContent = "";
      plot.style.height = `${PLOT_HEIGHT}px`;
      return;
    }
    const valueInfo = parseUnit(data.value_unit ?? data.unit);
    const metricInfo = parseUnit(data.unit);
    axisTitle.textContent = `${aggLabel(data.agg)}${unitTitle(valueInfo, data.value_unit) ? ` · ${unitTitle(valueInfo, data.value_unit)}` : ""} · ${formatBucket(Number(data.bucket_ms || 0))} buckets`;

    const width = Math.max(240, Math.round(plot.clientWidth || 600));
    const height = PLOT_HEIGHT;
    plot.style.height = `${height}px`;
    const bucketMs = Number(data.bucket_ms) || 60000;
    const x0 = Number(data.range?.[0] ?? timestamps[0]);
    const x1 = Math.max(Number(data.range?.[1] ?? timestamps[timestamps.length - 1] + bucketMs), x0 + 1);
    const visible = series.map((s, index) => ({ s, index, key: seriesKey(s), style: slotStyle(index, !!s.other) }))
      .filter((item) => !panel.hidden.has(item.key));

    let lo = Infinity;
    let hi = -Infinity;
    for (const { s } of visible) {
      for (const v of s.values || []) {
        if (v == null || !Number.isFinite(Number(v))) continue;
        const n = Number(v);
        if (n < lo) lo = n;
        if (n > hi) hi = n;
      }
    }
    const exemplarList = panel.exemplars && Array.isArray(panel.exemplarData?.exemplars) ? panel.exemplarData.exemplars : [];
    const onAxis = exemplarsOnAxis(data);
    if (onAxis) {
      for (const ex of exemplarList) {
        const n = Number(ex.value);
        if (!Number.isFinite(n)) continue;
        if (n < lo) lo = n;
        if (n > hi) hi = n;
      }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    // A little headroom so a line at the maximum does not sit on the top tick.
    const ticks = niceTicks(lo, hi + (hi - lo) * 0.04, 5);
    const formatter = axisFormatter(valueInfo, Math.max(Math.abs(ticks.min), Math.abs(ticks.max)));
    const labels = ticks.values.map((v) => formatTick(v, ticks.step, formatter));
    const left = Math.min(96, Math.max(34, Math.max(...labels.map((l) => l.length)) * 6.2 + 12));
    const plotW = Math.max(40, width - left - MARGIN.right);
    const plotH = height - MARGIN.top - MARGIN.bottom;
    const xOf = (t) => left + ((t - x0) / (x1 - x0)) * plotW;
    const yOf = (v) => MARGIN.top + plotH - ((v - ticks.min) / (ticks.max - ticks.min || 1)) * plotH;

    const root = svg("svg", { class: "queryChart__svg metricsChart__svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${panel.metric} chart` });
    const grid = svg("g");
    ticks.values.forEach((v, i) => {
      const y = yOf(v);
      grid.appendChild(svg("line", { class: v === 0 ? "queryChart__grid queryChart__grid--zero" : "queryChart__grid", x1: left, x2: left + plotW, y1: y, y2: y }));
      const label = svg("text", { class: "queryChart__tick", x: left - 6, y: y + 3.5, "text-anchor": "end" });
      label.textContent = labels[i];
      grid.appendChild(label);
    });
    const timeTicks = ns.queryChart?.timeAxisTicks ? ns.queryChart.timeAxisTicks(x0, x1, plotW) : [];
    for (const tick of timeTicks) {
      const x = xOf(tick.t);
      if (x < left - 0.5 || x > left + plotW + 0.5) continue;
      grid.appendChild(svg("line", { class: "queryChart__tickMark", x1: x, x2: x, y1: MARGIN.top + plotH, y2: MARGIN.top + plotH + 4 }));
      const label = svg("text", { class: "queryChart__tick", x, y: MARGIN.top + plotH + 16, "text-anchor": "middle" });
      label.textContent = tick.label;
      grid.appendChild(label);
    }
    grid.appendChild(svg("line", { class: "queryChart__baseline", x1: left, x2: left + plotW, y1: MARGIN.top + plotH, y2: MARGIN.top + plotH }));
    root.appendChild(grid);

    // One path per series. A series exported less often than the bucket has
    // regular empty buckets: gaps up to twice its usual spacing are bridged,
    // longer ones (missing data) break the line; a lone point is a dot.
    const pxs = timestamps.map(xOf);
    const lines = svg("g", { class: "metricsChart__lines" });
    for (const { s, style } of [...visible].reverse()) {
      let d = "";
      let run = 0;
      const dots = [];
      const values = s.values || [];
      const present = [];
      for (let i = 0; i < timestamps.length; i++) {
        const v = values[i];
        if (v != null && Number.isFinite(Number(v))) present.push(i);
      }
      const gaps = present.slice(1).map((i, k) => i - present[k]).sort((a, b) => a - b);
      const bridge = Math.max(1, 2 * (gaps.length ? gaps[gaps.length >> 1] : 1));
      let previous = -Infinity;
      for (const i of present) {
        if (i - previous > bridge) {
          if (run === 1) dots.push(previous);
          run = 0;
        }
        d += `${run ? "L" : "M"}${pxs[i].toFixed(1)},${yOf(Number(values[i])).toFixed(1)}`;
        run += 1;
        previous = i;
      }
      if (run === 1) dots.push(previous);
      if (d) lines.appendChild(svg("path", { class: "queryChart__line metricsChart__line", d, stroke: style.color, "stroke-dasharray": style.dash || null, "data-series": seriesKey(s) }));
      for (const i of dots) lines.appendChild(svg("circle", { cx: pxs[i], cy: yOf(Number(values[i])), r: 2.5, fill: style.color }));
    }
    root.appendChild(lines);

    const hover = svg("g", { class: "queryChart__hover", hidden: "" });
    const cross = svg("line", { class: "queryChart__crosshair", y1: MARGIN.top, y2: MARGIN.top + plotH });
    const hoverDots = svg("g", { class: "queryChart__hoverDots" });
    hover.append(cross, hoverDots);
    root.appendChild(hover);
    root.appendChild(svg("rect", { class: "queryChart__hit", x: left, y: MARGIN.top, width: plotW, height: plotH }));

    // Exemplars: links to the span, drawn above the hit area.
    if (exemplarList.length) {
      const group = svg("g", { class: "metricsChart__exemplars" });
      const bottom = MARGIN.top + plotH - 5;
      // Largest values first; a dot that would overlap one already placed is
      // skipped, so every drawn dot stays clickable.
      const placed = [];
      const ordered = [...exemplarList].sort((a, b) => Number(b.value) - Number(a.value));
      for (const ex of ordered) {
        const t = Number(ex.t);
        if (!Number.isFinite(t) || t < x0 || t > x1 || !ex.trace_id) continue;
        const value = Number(ex.value);
        const cy = onAxis && Number.isFinite(value) ? yOf(value) : bottom;
        const cx = xOf(t);
        if (placed.some(([px, py]) => Math.abs(px - cx) < 9 && Math.abs(py - cy) < 9)) continue;
        placed.push([cx, cy]);
        const href = `${route(`traces/${encodeURIComponent(ex.trace_id)}`)}${ex.span_id ? `?span=${encodeURIComponent(ex.span_id)}` : ""}`;
        const link = svg("a", { class: "metricsExemplar", href, "data-trace-id": ex.trace_id, "data-span-id": ex.span_id || "", "aria-label": `Exemplar ${formatValue(value, metricInfo)} at ${formatInstant(t)}: open trace ${ex.trace_id}` });
        link.appendChild(svg("rect", { class: "metricsExemplar__mark", x: xOf(t) - 3.5, y: cy - 3.5, width: 7, height: 7, rx: 1.5, transform: `rotate(45 ${xOf(t)} ${cy})` }));
        link.addEventListener("pointerenter", (event) => showExemplarTip(panel, ex, metricInfo, event));
        link.addEventListener("pointerleave", () => hideHover(panel));
        group.appendChild(link);
      }
      root.appendChild(group);
    }
    plot.insertBefore(root, plot.firstChild);

    panel.hover = { timestamps, pxs, visible, yOf, cross, hoverDots, hoverGroup: hover, left, plotW, valueInfo, bucketMs };
    renderLegend(panel, series);
  }

  function renderLegend(panel, series) {
    const legend = panel.el.querySelector(".metricsChart__legend");
    if (series.length <= 1 && !series[0]?.other && !panel.data?.group_by?.length && !panel.data?.per_series) {
      legend.innerHTML = "";
      return;
    }
    legend.innerHTML = series.map((s, index) => {
      const key = seriesKey(s);
      const style = slotStyle(index, !!s.other);
      const shown = !panel.hidden.has(key);
      const name = seriesName(panel, s);
      return `<button type="button" class="queryChart__legendItem metricsLegend__item${style.dash ? " is-dashed" : ""}" data-series-key="${esc(key)}" aria-pressed="${shown}" title="${esc(`${name}\nClick: show / hide · Alt+click: only this one`)}"><i style="--series-color:${style.color};background:${style.color}"></i><span>${esc(name)}</span></button>`;
    }).join("");
  }

  function hideHover(panel) {
    const h = panel.hover;
    if (h) h.hoverGroup.setAttribute("hidden", "");
    const tip = panel.el?.querySelector(".metricsChart__tooltip");
    if (tip) tip.hidden = true;
  }

  function placeTooltip(panel, tip, x, y) {
    const plot = panel.el.querySelector(".metricsChart__plot");
    const width = plot.clientWidth;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > width - 4) left = Math.max(4, x - tw - 14);
    const top = Math.max(4, Math.min(PLOT_HEIGHT - th - 4, y - th / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function onPlotPointer(panel, event) {
    const h = panel.hover;
    if (!h || !h.timestamps.length) return;
    if (event.target.closest?.(".metricsExemplar")) return;
    const plot = panel.el.querySelector(".metricsChart__plot");
    const rect = plot.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < h.left - 4 || x > h.left + h.plotW + 4) { hideHover(panel); return; }
    // Nearest bucket.
    let lo = 0;
    let hi = h.pxs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (h.pxs[mid] < x) lo = mid + 1; else hi = mid;
    }
    const index = lo > 0 && Math.abs(h.pxs[lo - 1] - x) < Math.abs(h.pxs[lo] - x) ? lo - 1 : lo;
    const px = h.pxs[index];
    h.cross.setAttribute("x1", px);
    h.cross.setAttribute("x2", px);
    h.hoverDots.innerHTML = "";
    const rows = [];
    for (const { s, style } of h.visible) {
      const v = s.values?.[index];
      if (v == null || !Number.isFinite(Number(v))) continue;
      rows.push({ name: seriesName(panel, s), value: Number(v), color: style.color });
      h.hoverDots.appendChild(svg("circle", { cx: px, cy: h.yOf(Number(v)), r: 3.5, fill: style.color }));
    }
    h.hoverGroup.removeAttribute("hidden");
    rows.sort((a, b) => b.value - a.value);
    const tip = panel.el.querySelector(".metricsChart__tooltip");
    const t = h.timestamps[index];
    const shownRows = rows.slice(0, TOOLTIP_ROWS);
    tip.innerHTML = `<strong>${esc(formatInstant(t))}</strong><span class="metricsTip__bucket">${esc(formatBucket(h.bucketMs))} bucket</span>` +
      (shownRows.length
        ? shownRows.map((r) => `<div class="queryChart__tipRow"><i style="background:${r.color}"></i><em>${esc(r.name)}</em><b>${esc(formatValue(r.value, h.valueInfo))}</b></div>`).join("")
        : `<div class="metricsTip__none">No point in this bucket</div>`) +
      (rows.length > shownRows.length ? `<div class="metricsTip__more">+${rows.length - shownRows.length} more</div>` : "");
    placeTooltip(panel, tip, px, y);
  }

  function showExemplarTip(panel, ex, metricInfo, event) {
    const tip = panel.el.querySelector(".metricsChart__tooltip");
    const plot = panel.el.querySelector(".metricsChart__plot");
    const rect = plot.getBoundingClientRect();
    const attrs = ex.attributes && typeof ex.attributes === "object" ? Object.entries(ex.attributes).slice(0, 4) : [];
    tip.innerHTML = `<strong>Exemplar · ${esc(formatValue(Number(ex.value), metricInfo))}</strong>` +
      `<span class="metricsTip__bucket">${esc(formatInstant(Number(ex.t)))}</span>` +
      `<div class="metricsTip__trace">Trace <code>${esc(ex.trace_id)}</code></div>` +
      (ex.span_id ? `<div class="metricsTip__trace">Span <code>${esc(ex.span_id)}</code></div>` : "") +
      attrs.map(([k, v]) => `<div class="metricsTip__attr"><em>${esc(k)}</em> ${esc(v)}</div>`).join("") +
      `<div class="metricsTip__hint">Click to open the span</div>`;
    placeTooltip(panel, tip, event.clientX - rect.left, event.clientY - rect.top);
    if (panel.hover) panel.hover.hoverGroup.setAttribute("hidden", "");
  }

  // --- Time range -----------------------------------------------------------

  let timePicker = null;

  function initTimeRangePicker() {
    const unit = document.getElementById("metricsRangeUnit");
    const root = unit?.parentElement;
    const button = root?.querySelector(":scope > .tracePicker__button");
    const menu = root?.querySelector(":scope > .tracePicker__menu");
    if (!ns.timeRange || !root || !button || !menu) return;
    const byId = (id) => document.getElementById(id);
    timePicker = ns.timeRange.mountPicker({
      button, menu, select: unit,
      fromInput: byId("metricsRangeStart"),
      toInput: byId("metricsRangeEnd"),
      fromError: byId("metricsRangeStartError"),
      toError: byId("metricsRangeEndError"),
      rangeError: byId("metricsRangeError"),
      calendar: byId("metricsTimeCalendar"),
      hint: byId("metricsTimeCalendarHint"),
      applyButton: byId("metricsCustomRangeApply"),
      quickSearch: byId("metricsQuickRangeSearch"),
      lists: byId("metricsQuickRanges"),
      timeZone: byId("metricsTimeZone"),
      shiftBack: byId("metricsRangeShiftBack"),
      shiftForward: byId("metricsRangeShiftForward"),
      zoomOut: byId("metricsRangeZoomOut"),
    }, {
      getValue: () => model.range,
      getMaxMinutes: () => MAX_RANGE_MINUTES,
      onApply: (raw) => { closePicker(root); applyRange(raw); },
      open: () => openPicker(root),
      close: () => closePicker(root),
    });
  }

  function applyRange(raw) {
    model.range = { from: String(raw.from), to: String(raw.to) };
    timePicker?.refresh?.();
    writeUrl({ push: true });
    reloadAll();
  }

  function renderRangeInfo() {
    const info = document.getElementById("metricsRangeInfo");
    if (!info) return;
    const r = model.resolved;
    // A relative range ("Last 6 hours") shows what it resolved to; an
    // absolute one already reads as dates on the picker.
    info.textContent = r && ns.timeRange?.isRelative?.(model.range) ? `${formatInstant(r.start_ms)} → ${formatInstant(r.end_ms)}` : "";
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

  let resizeRaf = 0;
  function onResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      for (const panel of model.panels) drawChart(panel);
    });
  }

  let started = false;
  async function start() {
    if (started || !state.selectedHostId) return;
    started = true;
    await loadMeta();
    reloadAll();
  }

  function init() {
    dom.metricsCatalog = document.getElementById("metricsCatalog");
    dom.metricsCatalogSummary = document.getElementById("metricsCatalogSummary");
    dom.metricsPanels = document.getElementById("metricsPanels");
    dom.metricsError = document.getElementById("metricsError");
    dom.metricsAddPanelButton = document.getElementById("metricsAddPanelButton");
    ui?.setPageSelectorValue?.("metrics");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    dom.navTracesButton?.addEventListener("click", () => window.location.assign(route("traces")));
    dom.navMetricsButton?.addEventListener("click", () => ui?.closePageMenu?.());

    readUrl();
    initTimeRangePicker();
    writeUrl();
    renderPanels();

    dom.metricsCatalog?.addEventListener("click", onCatalogClick);
    const search = document.getElementById("metricsSearch");
    search?.addEventListener("input", () => { model.search = search.value; renderCatalog(); });
    search?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        dom.metricsCatalog?.querySelector(".metricsCatalog__metric")?.click();
      }
    });
    document.getElementById("metricsToolbar")?.addEventListener("submit", (event) => { event.preventDefault(); reloadAll(); });
    dom.metricsAddPanelButton?.addEventListener("click", addPanel);
    document.addEventListener("click", (event) => {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      for (const root of [...openPickers]) if (!root.contains(event.target) && !path.includes(root)) closePicker(root);
    });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closePickers(); });
    if (typeof ResizeObserver === "function" && dom.metricsPanels) new ResizeObserver(onResize).observe(dom.metricsPanels);
    else window.addEventListener("resize", onResize);
    window.addEventListener("popstate", () => {
      readUrl();
      timePicker?.refresh?.();
      dom.metricsPanels?.replaceChildren();
      renderPanels();
      reloadAll();
    });
    window.addEventListener("chdash:host-changed", () => {
      started = true;
      model.catalog = null;
      loadMeta().then(reloadAll);
    });
    window.addEventListener("chdash:features-changed", (event) => {
      if (event?.detail?.metrics?.enabled === false) return;
      start();
    });
    start();
  }

  ns.metrics = {
    init,
    // Exposed for tests.
    parseUnit, formatValue, axisFormatter, formatTick,
  };
})();
