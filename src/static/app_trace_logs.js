(() => {
  "use strict";
  // OpenTelemetry logs of the open trace, after HyperDX's TraceLogsPanel and
  // the correlated logs of its DBTraceWaterfallChart: a "Logs" header item
  // toggling a logs panel (severity / service / text filters), log count
  // badges and log markers on span rows, the logs of a span listed under its
  // row, and a Logs group in the span inspector. Clicking a log opens its
  // span (?span=). Logs load after the trace has rendered, from
  // GET /api/traces/logs. app_traces.js calls install(ctx) at init, load()
  // after each trace load, and the *Html hooks while rendering.
  const ns = window.ChDash;
  if (!ns) return;
  const { state, api } = ns;
  const fmt = ns.format;
  const palette = ns.palette;

  const panelOpenPref = () => ns.storage.pref(ns.storage.KEYS.traceLogsPanelOpen, false);
  const PANEL_PAGE = 300;
  const INLINE_LIMIT = 100;
  const INLINE_LINE_PX = 22;
  const MAX_SERVICES_QUERY_CHARS = 6000;
  const SEVERITIES = ["fatal", "error", "warn", "info", "debug", "trace", "unset"];
  const SEVERITY_LABELS = { fatal: "FATAL", error: "ERROR", warn: "WARN", info: "INFO", debug: "DEBUG", trace: "TRACE", unset: "UNSET" };
  const LOG_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3"/></svg>';

  let ctx = null;
  const view = {
    trace: null,
    // idle | loading | ready | error | unavailable | disabled
    status: "idle",
    message: "",
    payload: null,
    records: [],
    // span object -> its records in time order (spans may share a SpanId).
    bySpan: new Map(),
    orphans: 0,
    panelOpen: readPanelOpen(),
    inline: new Set(),
    expanded: new Set(),
    target: -1,
    filters: { severities: new Set(), service: "", text: "" },
    shown: PANEL_PAGE,
  };

  const { byId, $, $$ } = ns.dom;
  const esc = (value) => ctx.esc(value);
  const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&"));

  function readPanelOpen() {
    return panelOpenPref().get();
  }

  function storePanelOpen(open) {
    panelOpenPref().set(!!open);
  }

  function logsFeatureEnabled() {
    // Before /api/version answers, try: the endpoint itself says disabled.
    return ns.features.get("logs.enabled", true);
  }

  // Logs of the trace on screen (none while another trace loads).
  function current() {
    const trace = ctx?.model?.activeTrace;
    return trace && view.trace === trace ? view : null;
  }

  // The palette's level of the OTel SeverityNumber, else the SeverityText;
  // "unset" when the log has neither.
  function severityOf(record) {
    const n = Number(record.severity_number || 0);
    const text = String(record.severity_text || "").trim();
    if (!(n > 0) && !text) return "unset";
    return palette.severityLevel(n > 0 ? n : text);
  }

  const severityRank = (sev) => SEVERITIES.indexOf(sev);

  // A log belongs to a span of its SpanId; when several spans share it
  // (duplicate span rows), to the one whose interval holds the log, else
  // the nearest one.
  function attach(records, spans) {
    const spansById = new Map();
    for (const span of spans) {
      const id = String(span.span_id || "");
      if (!id) continue;
      if (!spansById.has(id)) spansById.set(id, []);
      spansById.get(id).push(span);
    }
    const bySpan = new Map();
    let orphans = 0;
    for (const record of records) {
      const candidates = record.span_id ? spansById.get(record.span_id) : null;
      if (!candidates) { orphans += 1; continue; }
      let best = candidates[0];
      if (candidates.length > 1) {
        let bestDistance = Infinity;
        for (const span of candidates) {
          const start = Number(span.start_ns || 0);
          const end = start + Number(span.duration_ns || 0);
          const distance = record.ns < start ? start - record.ns : record.ns > end ? record.ns - end : 0;
          if (distance < bestDistance) { best = span; bestDistance = distance; }
        }
      }
      record.span = best;
      if (!bySpan.has(best)) bySpan.set(best, []);
      bySpan.get(best).push(record);
    }
    return { bySpan, orphans };
  }

  function prepare(payload, cache) {
    const rows = Array.isArray(payload?.logs) ? payload.logs : [];
    const records = rows.map((row, index) => ({
      ...row,
      index,
      ns: Number(row.timestamp_ns),
      sev: severityOf(row),
      span: null,
      search: "",
    }));
    const { bySpan, orphans } = attach(records, cache.spans);
    return { records, bySpan, orphans };
  }

  function traceWindow(cache) {
    const start = Number(cache.extent?.start);
    const end = Number(cache.extent?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // Exact enough: the server widens the window to whole seconds + margins.
    return { startNs: String(Math.floor(start)), endNs: String(Math.ceil(Math.max(start, end))) };
  }

  async function load(trace) {
    const req = ns.util.latest("traces.logs");
    view.trace = trace || null;
    view.payload = null;
    view.records = [];
    view.bySpan = new Map();
    view.orphans = 0;
    view.message = "";
    view.inline.clear();
    view.expanded.clear();
    view.target = -1;
    view.filters = { severities: new Set(), service: "", text: "" };
    view.shown = PANEL_PAGE;
    if (!trace?.spans?.length) { view.status = "idle"; renderPanel(); return; }
    if (!logsFeatureEnabled()) { view.status = "disabled"; renderPanel(); return; }
    const cache = ctx.activeTraceCache();
    const win = traceWindow(cache);
    if (!win) { view.status = "idle"; renderPanel(); return; }
    view.status = "loading";
    updateHeaderItem();
    renderPanel();
    // The trace's services narrow the primary key; a list too long for a URL
    // is left out (the time range and the TraceId index still bound it).
    let services = [...new Set(cache.spans.map((span) => String(span.service_name || "")).filter(Boolean))];
    const servicesChars = services.reduce((sum, name) => sum + encodeURIComponent(name).length + 9, 0);
    if (services.length > 1000 || servicesChars > MAX_SERVICES_QUERY_CHARS) services = [];
    try {
      const payload = await api.getTraceLogs(ctx.currentHost(), { traceId: trace.trace_id, startNs: win.startNs, endNs: win.endNs, services }, { signal: req.signal });
      if (!req.isCurrent()) return;
      view.payload = payload;
      if (payload?.enabled === false) {
        view.status = "disabled";
      } else if (payload?.error_code) {
        view.status = "unavailable";
        view.message = String(payload.message || payload.error_code);
      } else {
        Object.assign(view, prepare(payload, cache));
        view.status = "ready";
      }
    } catch (error) {
      if (!req.isCurrent()) return;
      view.status = "error";
      view.message = error instanceof Error ? error.message : String(error);
    }
    afterLoad();
  }

  // Badges, markers and inspector groups come with the waterfall rows.
  function afterLoad() {
    updateHeaderItem();
    renderPanel();
    if (ctx.model.activeTrace && view.status === "ready" && view.bySpan.size) rerenderWaterfall();
  }

  function rerenderWaterfall() {
    const root = byId("traceWaterfall");
    const focusedId = document.activeElement?.closest?.("#traceWaterfall [data-span-id]")?.getAttribute("data-span-id") || "";
    ctx.renderWaterfall();
    if (focusedId && root) $(`.traceSpanRow[data-span-id="${cssEscape(focusedId)}"]`, root)?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ formatting

  function offsetText(record) {
    const start = Number(ctx.activeTraceCache().bounds.start);
    const delta = record.ns - start;
    if (!Number.isFinite(delta)) return fmt.EMPTY;
    return `${delta < 0 ? "\u2212" : "+"}${fmt.duration(Math.abs(delta))}`;
  }

  function absoluteText(record) {
    return ctx.absoluteTimeText(record.ns, record.timestamp);
  }

  function severityCounts(records) {
    const counts = new Map();
    for (const record of records) counts.set(record.sev, (counts.get(record.sev) || 0) + 1);
    return counts;
  }

  function worstSeverity(records) {
    let worst = "unset";
    for (const record of records) {
      if (severityRank(record.sev) < severityRank(worst)) worst = record.sev;
    }
    return worst;
  }

  function countLabel(n) {
    return `${fmt.count(n)} log${n === 1 ? "" : "s"}`;
  }

  function parseAttributes(raw) {
    const value = ctx.parseStructuredValue(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function searchText(record) {
    if (!record.search) {
      const span = record.span;
      record.search = [
        record.body, record.severity_text, record.service_name, record.span_id, record.scope_name,
        span?.span_name || "", record.log_attributes,
      ].join("\u001f").toLowerCase();
    }
    return record.search;
  }

  function bodyDetailHtml(record) {
    const body = String(record.body || "");
    let pretty = body;
    const trimmed = body.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try { pretty = JSON.stringify(JSON.parse(trimmed), null, 2); } catch (_) { pretty = body; }
    }
    const cut = record.body_truncated ? `<small class="traceLog__cut">Body cut at ${esc(String(body.length))} of ${esc(String(record.body_bytes))} bytes.</small>` : "";
    return `<pre class="traceLog__fullBody">${esc(pretty || "(empty body)")}</pre>${cut}`;
  }

  function detailsHtml(record, mode) {
    const span = record.span;
    const logAttrs = parseAttributes(record.log_attributes);
    const resourceAttrs = parseAttributes(record.resource_attributes);
    const openSpan = span && mode !== "inspector" && mode !== "inline"
      ? `<button type="button" class="traceLog__openSpan" data-log-open-span="${esc(span.span_id)}">Open span</button>`
      : "";
    const meta = [
      `<span>Time: <b>${esc(absoluteText(record))}</b></span>`,
      `<span>Severity: <b>${esc(record.severity_text || SEVERITY_LABELS[record.sev])}${record.severity_number ? ` (${esc(String(record.severity_number))})` : ""}</b></span>`,
      `<span>Service: <b class="traceLog__metaService" style="--trace-service-color:${palette.service(record.service_name)}"><i class="serviceSwatch" aria-hidden="true"></i>${esc(record.service_name || "unknown")}</b></span>`,
      record.scope_name ? `<span>Scope: <b>${esc(record.scope_name)}</b></span>` : "",
      record.event_name ? `<span>Event: <b>${esc(record.event_name)}</b></span>` : "",
      `<span>SpanID: <code>${esc(record.span_id || "none")}</code>${record.span_id && !span ? " <small>(not in this trace)</small>" : ""}</span>`,
    ].join("");
    const resource = Object.keys(resourceAttrs).length
      ? `<details class="traceLog__resource"><summary>Resource <small>(${Object.keys(resourceAttrs).length})</small></summary>${ctx.renderAttributeTable(resourceAttrs, "No attributes")}</details>`
      : "";
    return `<div class="traceLog__details">${bodyDetailHtml(record)}<div class="traceLog__meta">${meta}${openSpan}</div><div class="traceLog__attrs"><b>Attributes</b>${ctx.renderAttributeTable(logAttrs, "No attributes")}</div>${resource}</div>`;
  }

  // The shared severity badge (ns.badge.severityHtml), as on the Logs page.
  function sevHtml(record) {
    return ns.badge.severityHtml(record.sev, SEVERITY_LABELS[record.sev], { className: "traceLog__sev", title: record.severity_text || SEVERITY_LABELS[record.sev] });
  }

  // mode: panel (every column; the row opens the span), inspector (one span:
  // no service / span columns; the row expands).
  function logItemHtml(record, mode) {
    const open = view.expanded.has(record.index);
    const span = record.span;
    const opensSpan = mode === "panel" && !!span;
    const rowAttrs = opensSpan
      ? `data-log-open-span="${esc(span.span_id)}" title="Open the span of this log"`
      : `data-log-expand aria-expanded="${open ? "true" : "false"}"`;
    const columns = mode === "panel"
      ? `<span class="traceLog__service" style="--trace-service-color:${palette.service(record.service_name)}"><i class="serviceSwatch" aria-hidden="true"></i>${esc(record.service_name || "unknown")}</span><span class="traceLog__span${span ? "" : " is-missing"}" title="${esc(span ? `${span.service_name || "unknown"}: ${span.span_name || "span"}` : (record.span_id ? "Span not in this trace" : "No span context"))}">${esc(span ? span.span_name || "span" : (record.span_id ? "span not in trace" : "no span"))}</span>`
      : "";
    return `<div class="traceLog traceLog--${mode}${open ? " is-open" : ""}${view.target === record.index ? " is-target" : ""}" data-log-index="${record.index}" data-sev="${record.sev}">
      <div class="traceLog__row" role="button" tabindex="0" ${rowAttrs}><button type="button" class="traceLog__toggle" data-log-expand aria-expanded="${open ? "true" : "false"}" aria-label="${open ? "Hide" : "Show"} log details"></button>${sevHtml(record)}<time class="traceLog__offset" title="${esc(absoluteText(record))}">${esc(offsetText(record))}</time>${columns}<code class="traceLog__body">${esc(record.body || "")}</code></div>
      ${open ? detailsHtml(record, mode) : ""}
    </div>`;
  }

  // ------------------------------------------------------------ header item

  function headerItemHtml() {
    const v = current();
    if (!v || v.status === "disabled" || v.status === "idle") return "";
    return `<i class="tracePageOverviewDivider" aria-hidden="true"></i>${headerItemInner(v)}`;
  }

  function headerItemInner(v) {
    let value = "";
    let title = "";
    let cls = "";
    let extra = "";
    if (v.status === "loading") { value = ns.uiState.spinnerHtml(); title = "Loading the logs of this trace"; cls = " is-loading"; }
    else if (v.status === "error") { value = "!"; title = `Logs could not be loaded: ${v.message}`; cls = " is-error"; }
    else if (v.status === "unavailable") { value = fmt.EMPTY; title = v.message; cls = " is-unavailable"; }
    else {
      const n = v.records.length;
      const errors = v.records.filter((r) => r.sev === "error" || r.sev === "fatal").length;
      value = `${fmt.count(n)}${v.payload?.truncated ? "+" : ""}`;
      title = `${countLabel(n)}${errors ? `, ${fmt.count(errors)} error${errors === 1 ? "" : "s"}` : ""}${v.payload?.truncated ? " (first logs only)" : ""}. ${v.panelOpen ? "Hide" : "Show"} the logs panel.`;
      if (errors) extra = `<span class="traceLogsToggle__errors" data-trace-logs-errors>${fmt.count(errors)} ERR</span>`;
    }
    // A header stat tile like the others (ns.ui.statTileHtml), its value the toggle.
    return ns.ui.statTileHtml({
      label: "Logs", className: "statTile--sm tracePageOverviewItem tracePageOverviewItem--logs", attrs: { "data-trace-header-item": "Logs" },
      valueHtml: `<button type="button" class="traceLogsToggle${cls}${v.panelOpen ? " is-open" : ""}" data-trace-logs-toggle aria-expanded="${v.panelOpen ? "true" : "false"}" aria-controls="traceLogsPanel" title="${esc(title)}" aria-label="${esc(`Logs: ${title}`)}">${LOG_ICON}<span data-trace-logs-count>${value}</span>${extra}</button>`,
    });
  }

  function updateHeaderItem() {
    const stats = byId("traceDetailStats");
    if (!stats) return;
    const item = $('[data-trace-header-item="Logs"]', stats);
    const v = current();
    const show = v && v.status !== "disabled" && v.status !== "idle";
    if (!show) {
      if (item) {
        const divider = item.previousElementSibling;
        if (divider?.classList.contains("tracePageOverviewDivider")) divider.remove();
        item.remove();
      }
      return;
    }
    if (item) { item.outerHTML = headerItemInner(v); return; }
    const html = `<i class="tracePageOverviewDivider" aria-hidden="true"></i>${headerItemInner(v)}`;
    const incomplete = $("[data-trace-incomplete]", stats);
    if (incomplete) incomplete.insertAdjacentHTML("beforebegin", html);
    else stats.insertAdjacentHTML("beforeend", html);
  }

  // ------------------------------------------------------------ panel

  function filteredRecords(v) {
    const { severities, service, text } = v.filters;
    const needle = text.trim().toLowerCase();
    return v.records.filter((record) => (!severities.size || severities.has(record.sev))
      && (!service || record.service_name === service)
      && (!needle || searchText(record).includes(needle)));
  }

  // The panel's state (ns.uiState): loading, error, unavailable, empty or filtered.
  function panelStateHtml(kind, options) {
    const ui = ns.uiState;
    const attrs = { "data-trace-logs-state": kind };
    if (kind === "loading") return ui.loadingHtml({ ...options, compact: true, attrs });
    if (kind === "error") return ui.errorHtml({ ...options, compact: true, attrs });
    return ui.emptyHtml({ ...options, compact: true, attrs });
  }

  function windowText(v) {
    const w = v.payload?.window;
    if (!w) return "";
    return `from ${fmt.duration.fromSeconds(w.margin_before_s)} before the trace to ${fmt.duration.fromSeconds(w.margin_after_s)} after it`;
  }

  // The Logs view of the Observability page on this trace and its log window
  // (app_observability.js follows the link in place).
  function logsViewUrl(v) {
    const w = v.payload?.window;
    const traceId = String(ctx?.model?.activeTrace?.trace_id || "");
    const from = Number(w?.from_s);
    const to = Number(w?.to_s);
    if (!traceId || !Number.isFinite(from) || !Number.isFinite(to) || !ns.timeRange || !ns.api) return "";
    const params = new URLSearchParams({
      from: ns.timeRange.formatDateTime(from * 1000),
      to: ns.timeRange.formatDateTime((to + 1) * 1000),
      trace_id: traceId,
    });
    return `${ns.api.resolveUrl("observability/logs")}?${params.toString()}`;
  }

  function panelToolbarHtml(v) {
    const counts = severityCounts(v.records);
    const chips = SEVERITIES.filter((sev) => counts.get(sev)).map((sev) => {
      const pressed = v.filters.severities.has(sev);
      return ns.badge.severityHtml(sev, "", {
        tag: "button", size: "md", className: "traceLogsChip", title: pressed ? "Show all severities" : `Only ${SEVERITY_LABELS[sev]} logs`,
        html: `${SEVERITY_LABELS[sev]}<b>${fmt.count(counts.get(sev))}</b>`,
        attrs: { "data-log-severity": sev, "aria-pressed": pressed ? "true" : "false" },
      });
    }).join("");
    const services = new Map();
    for (const record of v.records) services.set(record.service_name, (services.get(record.service_name) || 0) + 1);
    const options = [["", `ALL (${fmt.count(v.records.length)})`], ...[...services.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([name, n]) => [name, `${name || "unknown"} (${fmt.count(n)})`])];
    const serviceSelect = `<div class="themeSelect tracePicker traceLogsPanel__service"><select id="traceLogsService" class="tracePicker__native" tabindex="-1" aria-hidden="true" data-field-label="Service" aria-label="Filter logs by service">${options.map(([value, label]) => `<option value="${esc(value)}"${value === v.filters.service ? " selected" : ""}>${esc(label)}</option>`).join("")}</select><button class="button themeSelect__button tracePicker__button" type="button" aria-haspopup="listbox" aria-expanded="false">Service · ALL</button><div class="themeSelect__menu tracePicker__menu" role="listbox" tabindex="-1" hidden></div></div>`;
    const logsUrl = logsViewUrl(v);
    const openInLogs = logsUrl ? `<a class="traceLogsPanel__open" href="${esc(logsUrl)}" data-trace-logs-open title="Search these logs in the Logs view">Open in Logs</a>` : "";
    const elapsed = Number(v.payload?.elapsed_ms);
    const source = v.payload ? `${v.payload.database}.${v.payload.table}${Number.isFinite(elapsed) ? ` · ${fmt.duration.fromMs(elapsed)}` : ""}` : "";
    return `<div class="traceLogsPanel__bar"><strong class="traceLogsPanel__title">${LOG_ICON}Logs</strong><div class="traceLogsPanel__chips" role="group" aria-label="Filter logs by severity">${chips}</div>${serviceSelect}<input id="traceLogsFilter" class="traceLogsPanel__filter uiSearch uiSearch--compact" type="search" placeholder="Filter loaded logs" aria-label="Filter loaded logs" autocomplete="off" spellcheck="false" value="${esc(v.filters.text)}" /><span class="traceLogsPanel__source" title="${esc(`Read from ${source} ${windowText(v)}`)}">${esc(source)}</span>${openInLogs}<button type="button" class="closeCross closeCross--sm traceLogsPanel__close" data-trace-logs-toggle aria-label="Hide the logs panel" title="Hide the logs panel">×</button></div>`;
  }

  function panelListHtml(v) {
    if (!v.records.length) {
      return panelStateHtml("empty", { body: `No logs for this trace in ${v.payload?.database}.${v.payload?.table} (${windowText(v)}).` });
    }
    const rows = filteredRecords(v);
    if (!rows.length) return panelStateHtml("filtered", { body: "No loaded log matches the filters.", action: { label: "Clear filters", attrs: { "data-trace-logs-clear": "" } } });
    const shown = rows.slice(0, v.shown);
    const more = rows.length > shown.length
      ? `<button type="button" class="traceLogsPanel__more" data-trace-logs-more>Show ${fmt.count(Math.min(PANEL_PAGE, rows.length - shown.length))} more of ${fmt.count(rows.length - shown.length)}</button>`
      : "";
    return `${shown.map((record) => logItemHtml(record, "panel")).join("")}${more}`;
  }

  function panelNoticeHtml(v) {
    const notes = [];
    if (v.payload?.truncated) notes.push(`Showing the first ${fmt.count(v.records.length)} logs of this trace (logs.trace_logs_limit); filters apply to these only.`);
    if (v.payload?.window?.clamped) notes.push("The trace is longer than logs.max_lookback_minutes: logs after that window are not shown.");
    if (v.orphans) notes.push(`${fmt.count(v.orphans)} log${v.orphans === 1 ? " has" : "s have"} no span of this trace.`);
    const shown = filteredRecords(v).length;
    const filtered = shown !== v.records.length ? `<span class="traceLogsPanel__matches">${fmt.count(shown)} of ${fmt.count(v.records.length)} shown</span>` : "";
    if (!notes.length && !filtered) return "";
    return `<div class="traceLogsPanel__notice${v.payload?.truncated ? " is-truncated" : ""}" data-trace-logs-notice>${filtered}${notes.map((note) => `<span>${note}</span>`).join("")}</div>`;
  }

  function renderPanel() {
    const panel = byId("traceLogsPanel");
    if (!panel) return;
    const v = current();
    const visible = !!v && v.panelOpen && v.status !== "disabled" && v.status !== "idle";
    panel.hidden = !visible;
    if (!visible) { panel.replaceChildren(); delete panel.dataset.traceLogsState; return; }
    panel.dataset.traceLogsState = v.status;
    if (v.status === "loading") {
      panel.innerHTML = `<div class="traceLogsPanel__bar"><strong class="traceLogsPanel__title">${LOG_ICON}Logs</strong><button type="button" class="closeCross closeCross--sm traceLogsPanel__close" data-trace-logs-toggle aria-label="Hide the logs panel" title="Hide the logs panel">×</button></div>${panelStateHtml("loading", { label: "Loading the logs of this trace\u2026" })}`;
      return;
    }
    if (v.status === "error" || v.status === "unavailable") {
      const state = v.status === "error"
        ? { body: `The logs could not be loaded: ${v.message}`, retry: { attrs: { "data-trace-logs-retry": "" } } }
        : { body: v.message };
      panel.innerHTML = `<div class="traceLogsPanel__bar"><strong class="traceLogsPanel__title">${LOG_ICON}Logs</strong><button type="button" class="closeCross closeCross--sm traceLogsPanel__close" data-trace-logs-toggle aria-label="Hide the logs panel" title="Hide the logs panel">×</button></div>${panelStateHtml(v.status, state)}`;
      return;
    }
    panel.innerHTML = `${panelToolbarHtml(v)}<div data-trace-logs-notice-slot>${panelNoticeHtml(v)}</div><div class="traceLogsPanel__list" data-trace-logs-list role="list" aria-label="Trace logs">${panelListHtml(v)}</div>`;
    const select = $("#traceLogsService", panel);
    if (select) ctx.enhanceTraceSelect(select);
  }

  // Filters only redraw the list (the text box keeps its focus).
  function renderPanelList() {
    const panel = byId("traceLogsPanel");
    const v = current();
    if (!panel || !v || v.status !== "ready") return;
    const list = $("[data-trace-logs-list]", panel);
    const slot = $("[data-trace-logs-notice-slot]", panel);
    if (list) list.innerHTML = panelListHtml(v);
    if (slot) slot.innerHTML = panelNoticeHtml(v);
    for (const chip of $$("[data-log-severity]", panel)) {
      const pressed = v.filters.severities.has(chip.getAttribute("data-log-severity"));
      chip.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }

  function togglePanel(open = !view.panelOpen) {
    view.panelOpen = open;
    storePanelOpen(open);
    updateHeaderItem();
    renderPanel();
  }

  // ------------------------------------------------------------ waterfall hooks

  function spanLogs(span) {
    const v = current();
    return v && v.status === "ready" ? v.bySpan.get(span) || [] : [];
  }

  function spanBadgeHtml(span) {
    const records = spanLogs(span);
    if (!records.length) return "";
    const worst = worstSeverity(records);
    const id = String(span.span_id || "");
    const open = view.inline.has(id);
    const errors = records.filter((r) => r.sev === "error" || r.sev === "fatal").length;
    const title = `${countLabel(records.length)}${errors ? ` (${fmt.count(errors)} error${errors === 1 ? "" : "s"})` : ""}: ${open ? "hide them" : "list them under this span"}`;
    return ns.badge.severityHtml(worst, "", {
      tag: "button", className: "traceSpanLogsBadge", title,
      html: `${LOG_ICON}<span>${fmt.count(records.length)}</span>`,
      attrs: { "data-span-logs-toggle": true, "aria-expanded": open ? "true" : "false", "aria-label": title },
    });
  }

  // One marker per 0.2 % of the view, in the colour of its worst log.
  function spanMarkersHtml(span, win) {
    const records = spanLogs(span);
    if (!records.length) return "";
    const groups = new Map();
    for (const record of records) {
      if (!Number.isFinite(record.ns) || record.ns < win.start || record.ns > win.end) continue;
      const ratio = Math.round(((record.ns - win.start) / win.total) * 500) / 500;
      const group = groups.get(ratio) || { ratio, records: [] };
      group.records.push(record);
      groups.set(ratio, group);
    }
    return [...groups.values()].map((group) => {
      const first = group.records[0];
      const title = group.records.length === 1
        ? `${SEVERITY_LABELS[first.sev]} ${offsetText(first)}: ${String(first.body || "").slice(0, 160)}`
        : `${countLabel(group.records.length)} at ${offsetText(first)}`;
      return `<i class="traceSpanLogMarker" data-sev="${worstSeverity(group.records)}" data-span-logs-toggle aria-hidden="true" style="left:${(Math.max(0, Math.min(1, group.ratio)) * 100).toFixed(4)}%" title="${esc(title)}"></i>`;
    }).join("");
  }

  function inlineShown(node) {
    return view.inline.has(String(node.span.span_id || "")) && spanLogs(node.span).length > 0;
  }

  // Faint tree guides through the listed logs, like the inspector row.
  function guidesHtml(depth) {
    return `<span class="traceSpanRow__guides" aria-hidden="true">${Array.from({ length: depth + 1 }, (_, i) => `<i style="left:${13 + i * 18}px"></i>`).join("")}</span>`;
  }

  function inlineLineHtml(record, win, indentPx, guides) {
    const open = view.expanded.has(record.index);
    const inView = Number.isFinite(record.ns) && record.ns >= win.start && record.ns <= win.end;
    const ratio = inView ? ((record.ns - win.start) / win.total) * 100 : NaN;
    const marker = inView
      ? `<i class="traceLogLine__marker" style="left:${ratio.toFixed(4)}%"></i><time class="traceLogLine__offset${ratio > 80 ? " is-left" : ""}" style="left:${ratio.toFixed(4)}%" title="${esc(absoluteText(record))}">${esc(offsetText(record))}</time>`
      : `<time class="traceLogLine__offset is-outside" title="${esc(absoluteText(record))}">${esc(offsetText(record))} (outside the view)</time>`;
    return `<div class="traceLog traceLog--inline${open ? " is-open" : ""}${view.target === record.index ? " is-target" : ""}" data-log-index="${record.index}" data-sev="${record.sev}">
      <div class="traceLog__row traceLogLine" role="button" tabindex="0" data-log-expand aria-expanded="${open ? "true" : "false"}"><div class="traceLogLine__label" style="padding-left:${indentPx}px">${guides}<i class="traceLogLine__glyph" aria-hidden="true"></i>${sevHtml(record)}<code class="traceLog__body">${esc(record.body || "")}</code></div><div class="traceLogLine__timeline">${marker}</div></div>
      ${open ? detailsHtml(record, "inline") : ""}
    </div>`;
  }

  // The span's logs as child rows of the span (HyperDX's green log rows).
  function inlineRowHtml(node, win) {
    if (!inlineShown(node)) return "";
    const span = node.span;
    const records = spanLogs(span);
    const depth = Math.min(Number(node.level ?? node.depth ?? 0), 40);
    const indentPx = 13 + (depth + 1) * 18;
    const shown = records.slice(0, INLINE_LIMIT);
    const more = records.length > shown.length
      ? `<button type="button" class="traceSpanLogsRow__more" data-trace-logs-span-more="${esc(span.span_id)}">${records.length - shown.length} more: open the logs panel</button>`
      : "";
    return `<div class="traceSpanLogsRow" data-span-logs-for="${esc(span.span_id)}" style="--trace-service-color:${palette.service(span.service_name)}" role="list" aria-label="${esc(`Logs of ${span.span_name || "span"}`)}">${shown.map((record) => inlineLineHtml(record, win, indentPx, guidesHtml(depth))).join("")}${more}</div>`;
  }

  // Virtual list estimate until the row has been measured.
  function inlineHeight(node) {
    if (!inlineShown(node)) return 0;
    const records = spanLogs(node.span);
    return Math.min(records.length, INLINE_LIMIT) * INLINE_LINE_PX + (records.length > INLINE_LIMIT ? INLINE_LINE_PX : 0);
  }

  function spanRowFor(target) {
    return target.closest(".traceSpanRow[data-span-id]");
  }

  function toggleInline(row) {
    const id = String(row.getAttribute("data-span-id") || "");
    const cache = ctx.activeTraceCache();
    const opening = !view.inline.has(id);
    if (opening) view.inline.add(id); else view.inline.delete(id);
    const node = cache.nodeById.get(id);
    const virtual = !!$("[data-virtual-rows]", byId("traceWaterfall"));
    if (!node || cache.duplicateIds.has(id) || virtual) { rerenderWaterfall(); return; }
    let anchor = row;
    if (anchor.nextElementSibling?.classList.contains("traceSpanInspectorRow")) anchor = anchor.nextElementSibling;
    if (anchor.nextElementSibling?.classList.contains("traceSpanLogsRow")) anchor.nextElementSibling.remove();
    if (opening) anchor.insertAdjacentHTML("afterend", inlineRowHtml(node, ctx.waterfallWindow()));
    for (const badge of $$(".traceSpanLogsBadge", row)) badge.setAttribute("aria-expanded", opening ? "true" : "false");
  }

  // ------------------------------------------------------------ inspector hook

  function inspectorSectionHtml(span) {
    const records = spanLogs(span);
    if (!records.length) return "";
    const id = String(span.span_id || "");
    const open = !!ctx.model.spanSections.get(id)?.has("logs");
    const counts = severityCounts(records);
    const summary = SEVERITIES.filter((sev) => counts.get(sev)).map((sev) => ns.badge.severityHtml(sev, `${SEVERITY_LABELS[sev]} ${fmt.count(counts.get(sev))}`, { className: "traceSpanLogs__sev" })).join("");
    return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanLogs" data-span-section="logs"${open ? " open" : ""}><summary><b>Logs</b><span class="traceJaegerGroup__count">(${fmt.count(records.length)})</span><span class="traceSpanLogs__summary">${summary}</span></summary><div class="traceJaegerGroup__body"><div class="traceSpanLogs__list">${records.map((record) => logItemHtml(record, "inspector")).join("")}</div><small class="traceSpanEvents__note">Log timestamps are relative to the start time of the full trace.</small></div></details>`;
  }

  // ------------------------------------------------------------ events

  function recordOf(el) {
    const item = el.closest("[data-log-index]");
    const v = current();
    return item && v ? v.records[Number(item.getAttribute("data-log-index"))] || null : null;
  }

  function toggleDetails(item, record, mode) {
    const opening = !view.expanded.has(record.index);
    if (opening) view.expanded.add(record.index); else view.expanded.delete(record.index);
    item.classList.toggle("is-open", opening);
    $(":scope > .traceLog__details", item)?.remove();
    if (opening) item.insertAdjacentHTML("beforeend", detailsHtml(record, mode));
    for (const el of $$(":scope > .traceLog__row [data-log-expand], :scope > .traceLog__row[data-log-expand]", item)) {
      el.setAttribute("aria-expanded", opening ? "true" : "false");
      if (el.classList.contains("traceLog__toggle")) el.setAttribute("aria-label", `${opening ? "Hide" : "Show"} log details`);
    }
  }

  // Focus the log's span in the timeline, its inspector's Logs group open.
  function openSpan(spanId, record) {
    const id = String(spanId || "");
    if (!id) return;
    let sections = ctx.model.spanSections.get(id);
    if (!sections) { sections = new Set(); ctx.model.spanSections.set(id, sections); }
    sections.add("logs");
    view.target = record ? record.index : -1;
    ctx.focusSpanInTimeline(id, { push: true });
    if (record) {
      const target = $(`.traceSpanInspectorRow .traceLog[data-log-index="${record.index}"]`, byId("traceWaterfall"));
      target?.scrollIntoView?.({ block: "nearest" });
    }
  }

  // Clicks inside log items, wherever they are (panel, inline, inspector).
  function handleLogClick(event, mode) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return false;
    const item = target.closest("[data-log-index]");
    if (!item) return false;
    if (target.closest("[data-kv-copy], .traceLog__details")) {
      const open = target.closest("[data-log-open-span]");
      if (open && target.closest(".traceLog__details")) {
        event.preventDefault();
        event.stopPropagation();
        openSpan(open.getAttribute("data-log-open-span"), recordOf(item));
        return true;
      }
      // Attribute tables: copy buttons and JSON trees are the inspector's.
      if (mode === "panel") ctx.spanDetailClick(event);
      else event.stopPropagation();
      return true;
    }
    const record = recordOf(item);
    if (!record) return false;
    event.preventDefault();
    event.stopPropagation();
    if (target.closest("[data-log-expand]")) { toggleDetails(item, record, mode); return true; }
    const open = target.closest("[data-log-open-span]");
    if (open) { openSpan(open.getAttribute("data-log-open-span"), record); return true; }
    toggleDetails(item, record, mode);
    return true;
  }

  function modeOf(item) {
    if (item.classList.contains("traceLog--inline")) return "inline";
    if (item.classList.contains("traceLog--inspector")) return "inspector";
    return "panel";
  }

  function onWaterfallClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const toggle = target.closest("[data-span-logs-toggle]");
    if (toggle) {
      const row = spanRowFor(toggle);
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      toggleInline(row);
      return;
    }
    const more = target.closest("[data-trace-logs-span-more]");
    if (more) {
      event.preventDefault();
      event.stopPropagation();
      view.filters = { severities: new Set(), service: "", text: String(more.getAttribute("data-trace-logs-span-more") || "") };
      togglePanel(true);
      return;
    }
    const item = target.closest("[data-log-index]");
    if (item) handleLogClick(event, modeOf(item));
  }

  function onKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.classList.contains("traceLog__row") ? target : null;
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    row.click();
  }

  // The panel's × and Escape in it close it and give focus back to the
  // header's Logs button that opened it.
  function closePanelToToggle() {
    togglePanel(false);
    $("#traceDetailHeader [data-trace-logs-toggle]")?.focus({ preventScroll: true });
  }

  function onPanelKeydown(event) {
    if (event.key !== "Escape" || event.defaultPrevented || !view.panelOpen) return;
    // A filter with text: Escape clears it first (the search field's own key).
    if (event.target instanceof HTMLInputElement && event.target.type === "search" && event.target.value) return;
    event.preventDefault();
    closePanelToToggle();
  }

  function onPanelClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-trace-logs-toggle]")) { closePanelToToggle(); return; }
    if (target.closest("[data-trace-logs-retry]")) { void load(ctx.model.activeTrace); return; }
    if (target.closest("[data-trace-logs-clear]")) {
      view.filters = { severities: new Set(), service: "", text: "" };
      renderPanel();
      return;
    }
    if (target.closest("[data-trace-logs-more]")) { view.shown += PANEL_PAGE; renderPanelList(); return; }
    const chip = target.closest("[data-log-severity]");
    if (chip) {
      const sev = chip.getAttribute("data-log-severity");
      if (view.filters.severities.has(sev)) view.filters.severities.delete(sev); else view.filters.severities.add(sev);
      view.shown = PANEL_PAGE;
      renderPanelList();
      return;
    }
    handleLogClick(event, "panel");
  }

  function install(context) {
    ctx = context;
    const waterfall = byId("traceWaterfall");
    // Capture phase: before the row's own click (which toggles the inspector).
    waterfall?.addEventListener("click", onWaterfallClick, true);
    waterfall?.addEventListener("keydown", onKeydown, true);
    byId("traceLogsPanel")?.addEventListener("keydown", onPanelKeydown);
    const panel = byId("traceLogsPanel");
    panel?.addEventListener("click", onPanelClick);
    panel?.addEventListener("keydown", onKeydown, true);
    panel?.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLSelectElement) || event.target.id !== "traceLogsService") return;
      view.filters.service = event.target.value;
      view.shown = PANEL_PAGE;
      renderPanelList();
    });
    ns.search.within(panel, "#traceLogsFilter", (value) => {
      view.filters.text = value;
      view.shown = PANEL_PAGE;
      renderPanelList();
    }, { compact: true });
    byId("traceDetailStats")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-trace-logs-toggle]")) togglePanel();
    });
    ns.features.on(() => {
      const v = current();
      if (!v) return;
      if (!logsFeatureEnabled() && v.status !== "disabled") {
        ns.util.latest.cancel("traces.logs");
        view.status = "disabled";
        view.bySpan = new Map();
        updateHeaderItem();
        renderPanel();
        rerenderWaterfall();
      }
    });
  }

  ns.traceLogs = {
    install, load, headerItemHtml, spanBadgeHtml, spanMarkersHtml, inlineRowHtml, inlineHeight, inspectorSectionHtml,
    severityOf, attach,
  };
})();
