// The waterfall of the trace page (the Jaeger UI's timeline): the tree of the spans with their bars, the critical path, the overview
// and its brush, the header and the service filters, the virtual window of a long trace, the keys, and the focus on a span.

import { dom, h, shell } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { renderSpanInspectorCard } from "./app_trace_inspector.js";
import { criticalSectionsFor, durationTicks, isErrorSpan, parentSpanId, parseStructuredValue, spanKey, timestampToNs, traceJsonText, wallClockLabel } from "./app_trace_model.js";
import { unavailableHtml } from "./app_trace_nav.js";
import { TRACES_PAGE_TITLE, actions, activeTraceCache, address, copyText, esc, model, parts, serviceEnabled, spanTraceUrl } from "./app_trace_store.js";
import { badge } from "./app_ui_badge.js";
import { copy } from "./app_ui_copy.js";
import { icon } from "./app_ui_icon.js";
import { lifecycle } from "./app_ui_layers.js";
import { stat } from "./app_ui_stat.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;
const fmt = format;

// The Service & Operation column, in percent of the waterfall's width: the bounds are the separator's
// aria-valuemin / aria-valuemax, its arrow keys step it by 2.
const WATERFALL_LABEL_MIN_PCT = 18;
const WATERFALL_LABEL_MAX_PCT = 60;

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
  db: icon("database", { size: "sm" }),
  http: icon("world", { size: "sm" }),
  messaging: icon("message", { size: "sm" }),
  rpc: icon("arrows-exchange", { size: "sm" }),
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
      if (pill.tone) return badge.html(pill.value, { tone: pill.tone, className: `traceSpanPill is-${pill.tone}`, title: `${pill.label}: ${pill.value}`, attrs });
      return `<span class="traceSpanPill traceSpanPill--text" title="${esc(`${pill.label}: ${pill.value}`)}" data-span-pill="${esc(pill.label)}" aria-label="${esc(attrs["aria-label"])}">${esc(pill.value)}</span>`;
    }).join(""),
  };
  cache.decorations.set(span, found);
  return found;
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

// The services panel is folded; its toggle (a tool of the Timeline, in the view bar) says how many
// services the trace has, and how many of them show once some are deselected.
function updateServicesToggle(total, shown) {
  const button = dom.byId("traceServicesToggle");
  if (!button) return;
  button.disabled = !total;
  const count = dom.byId("traceServicesCount");
  if (count) count.textContent = !total ? "" : shown === total ? String(total) : `${shown}/${total}`;
  if (!total) setServicesOpen(false);
}

function setServicesOpen(open) {
  const button = dom.byId("traceServicesToggle");
  if (dom.traceServiceFilters) dom.traceServiceFilters.hidden = !open;
  if (!button) return;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  button.title = open ? "Hide the services of the trace" : "Show the services of the trace";
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
  updateServicesToggle(services.length, services.filter((service) => !model.disabledServices.has(service)).length);
  // Service toggles: the shared chip badge with the service bar; the error
  // count is a solid error badge. "Select all" is the chips' clear link.
  dom.traceServiceFilters.innerHTML = badge.clearHtml(toggleLabel, { "data-trace-toggle-all": true, title: `${toggleLabel} services` }, "traceServiceFilterReset") + services.map((service) => {
    const row = stats.get(service);
    const disabled = model.disabledServices.has(service);
    const errors = row.errors ? badge.html(fmt.count(row.errors), { tone: "error", solid: true, className: "badge--count traceServiceFilter__errors", title: `${fmt.count(row.errors)} error${row.errors === 1 ? "" : "s"}` }) : "";
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

const WARNING_ICON = icon("alert-triangle", { size: "sm" });

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
    updateServicesToggle(0, 0);
    if (dom.traceOverview) dom.traceOverview.replaceChildren();
    parts.traceInsights?.renderHighlights(null);
    document.title = TRACES_PAGE_TITLE;
    return;
  }
  const cache = activeTraceCache();
  const bounds = cache.bounds;
  const root = spans.find((s) => !parentSpanId(s)) || spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0))[0];
  document.title = `${String(trace.trace_id || "").slice(0, 7)}: ${root?.service_name || "trace"} ${root?.span_name || ""}`.trim();
  if (dom.traceDetailTitle) {
    const filterableHtml = (field, value, text) => (value
      ? `<span class="traceFilterable" data-filter-field="${field}" data-filter-value="${esc(value)}" tabindex="0" role="button" aria-haspopup="menu" title="Filter traces by this ${field}">${text}</span>`
      : text);
    dom.traceDetailTitle.innerHTML = `<strong><span>${filterableHtml("service", root?.service_name, esc(root?.service_name || "trace"))}:</span> ${filterableHtml("operation", root?.span_name, esc(root?.span_name || "trace"))}</strong><span class="tracePageHeader__traceId"><code title="${esc(trace.trace_id)}">${esc(trace.trace_id)}</code>${copy.buttonHtml({ label: "Copy full Trace ID", className: "traceCopyButton traceCopyButton--header", attrs: { "data-copy-active-trace": trace.trace_id } })}</span>`;
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
    const itemsHtml = items.map(([label, value, cls]) => stat.html({ label, valueHtml: typeof value === "object" ? value.html : esc(value), tone: cls === "is-error" ? "error" : "", className: `statTile--sm tracePageOverviewItem${cls ? ` ${cls}` : ""}`, attrs: { "data-trace-header-item": label } })).join('<i class="tracePageOverviewDivider" aria-hidden="true"></i>');
    const orphans = cache.orphanCount;
    const incomplete = orphans
      ? badge.html("", { tone: "warn", size: "md", className: "tracePageHeader__incomplete", title: `${orphans} span${orphans === 1 ? "" : "s"} reference${orphans === 1 ? "s" : ""} a parent span missing from this trace: the trace is incomplete.`, attrs: { "data-trace-incomplete": true }, html: `${WARNING_ICON}Incomplete` })
      : "";
    dom.traceDetailStats.innerHTML = itemsHtml + (parts.traceLogs?.headerItemHtml?.() || "") + incomplete + (parts.traceInsights?.traceExceptionTagHtml(cache) || "");
  }
  parts.traceInsights?.renderHighlights(cache);
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
  expandOne: icon("chevron-down"),
  collapseOne: icon("chevron-right"),
  expandAll: icon("chevrons-down"),
  collapseAll: icon("chevrons-right"),
  criticalPath: icon("route"),
  resetZoom: icon("zoom-out"),
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
  return `<div class="traceWaterfallHead"><div class="traceWaterfallHead__operation"><span class="traceWaterfallHead__title">Service &amp; Operation</span><span class="traceWaterfallHead__controls">${controls}</span></div><div class="traceWaterfallHead__timeline" data-trace-timeline-header aria-label="Timeline: drag to zoom, a / d or arrows to pan and zoom">${tickLabels}<div class="traceTimelineCursor" data-trace-timeline-cursor hidden></div><div class="traceTimelineDrag" data-trace-timeline-drag hidden></div></div><div class="traceWaterfallResizer" data-trace-waterfall-resizer role="separator" aria-orientation="vertical" aria-label="Resize Service & Operation column" aria-valuemin="${WATERFALL_LABEL_MIN_PCT}" aria-valuemax="${WATERFALL_LABEL_MAX_PCT}" aria-valuenow="${model.waterfallLabelPct}" aria-valuetext="${model.waterfallLabelPct}% of the width" tabindex="0"></div></div>`;
}

function renderWaterfall() {
  if (!dom.traceWaterfall) return;
  const cache = activeTraceCache();
  const spans = cache.spans;
  if (!spans.length) { dom.traceWaterfall.innerHTML = model.traceError ? unavailableHtml(model.traceError) : uiState.emptyHtml({ body: "This trace has no spans." }); return; }
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
  const logsEstimate = parts.traceLogs?.inlineHeight?.(node) || 0;
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

// A bar ending past BAR_LABEL_EDGE % has no room for its label after it:
// the label goes before it when the bar starts at BAR_LABEL_ROOM % or later,
// else inside it.
const BAR_LABEL_EDGE = 88;
const BAR_LABEL_ROOM = 40;

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
  // The bar's label: after the bar, before it from the right half on, and
  // when the bar reaches the right edge (past BAR_LABEL_EDGE %: a root, a
  // long child) before it if there is room there, else inside it in the
  // bar's readable text colour: never cut by the edge ("3!"), never missing.
  const barEnd = left + width;
  const labelInside = barEnd > BAR_LABEL_EDGE && left < BAR_LABEL_ROOM;
  const labelLeft = !labelInside && (barEnd > BAR_LABEL_EDGE || left + (width / 2) >= 62);
  const spanRef = `${span.service_name || "unknown"}::${span.span_name || "span"}`;
  const durationText = fmt.duration(span.duration_ns);
  // The row is a group (its toggle and badges are buttons: a button role would nest them) named by what it
  // shows; Enter opens its details, the toggle folds its children.
  const rowLabel = `${span.service_name || "unknown"}: ${span.span_name || "span"}, ${durationText}${node.children.length ? `, ${fmt.countLabel(node.children.length, "child")}${collapsed ? " (folded)" : ""}` : ""}`;
  const barLabel = labelLeft
    ? `<span class="traceSpanBar__label"><i class="traceSpanBar__ref">${esc(spanRef)}</i><span class="traceSpanBar__sep">|</span><b>${esc(durationText)}</b></span>`
    : `<span class="traceSpanBar__label"${labelInside ? ` style="color:${palette.readableText(color)}"` : ""}><b>${esc(durationText)}</b><span class="traceSpanBar__sep">|</span><i class="traceSpanBar__ref">${esc(spanRef)}</i></span>`;
  const eventMarkers = spanEventMarkers(cache, span).map((event) => {
    const eventNs = event.ns;
    if (!Number.isFinite(eventNs) || eventNs < clippedStart || eventNs > clippedEnd) return "";
    const eventLeft = Math.max(0, Math.min(100, ((eventNs - start) / total) * 100));
    return `<i class="traceSpanEventMarker" style="left:${eventLeft.toFixed(4)}%" title="${esc(event.name)}"></i>`;
  }).join("");
  const bar = inView ? `<i class="traceSpanBar${error ? " traceSpanBar--error" : ""}${labelLeft ? " traceSpanBar--labelLeft" : ""}${labelInside ? " traceSpanBar--labelInside" : ""}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;--trace-service-color:${color}">${barLabel}</i>` : "";
  const critical = inView ? criticalPathHtml(cache, node, collapsed, ctx) : "";
  const decorations = spanDecorations(cache, span);
  const errorIcon = (error
    ? badge.html("!", { tone: "error", solid: true, className: "badge--count traceSpanRow__errorBadge", title: "Span status: Error", attrs: { "aria-label": "Error span" } })
    : childError ? badge.html("!", { tone: "error", className: "badge--count traceSpanRow__errorBadge traceSpanRow__errorBadge--hollow", title: "An error span is inside this collapsed branch", attrs: { "aria-label": "Error span in this collapsed branch" } }) : "")
    + (parts.traceInsights?.exceptionBadgeHtml(span) || "");
  // Log count badge and log markers (app_trace_logs.js).
  const logs = parts.traceLogs;
  return `<div class="${spanRowClass(active, error, inView && spanStart < start, inView && spanEnd > end)}" data-span-id="${esc(id)}" role="group" tabindex="0" data-label="${esc(rowLabel)}" aria-label="${esc(`${rowLabel}${active ? ", details open" : ""}`)}">
        <div class="traceSpanRow__label" style="--trace-service-color:${color}"><div class="traceSpanRow__labelContent">${treeOffsetHtml(node, cache)}<span class="traceSpanRow__serviceDot"></span>${decorations.iconHtml}${errorIcon}<span class="traceSpanRow__service${collapsed ? " is-children-collapsed" : ""}">${esc(span.service_name || "unknown")}</span><span class="traceSpanRow__name">${esc(span.span_name || "span")}</span>${decorations.pillsHtml}${logs?.spanBadgeHtml?.(span) || ""}</div></div>
        <div class="traceSpanRow__timeline">${bar}${critical}${eventMarkers}${logs?.spanMarkersHtml?.(span, ctx) || ""}</div>
      </div>`;
}

function waterfallRowHtml(node, ctx) {
  const rowHtml = spanRowHtml(node, ctx);
  const inspector = model.openSpanIds.has(String(node.span.span_id || "")) ? spanInspectorRowHtml(node, ctx.cache) : "";
  // The span's logs listed under it (app_trace_logs.js), after its inspector.
  return rowHtml + inspector + (parts.traceLogs?.inlineRowHtml?.(node, ctx) || "");
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
  row.setAttribute("aria-label", `${row.dataset.label || ""}${opening ? ", details open" : ""}`);
  const next = row.nextElementSibling;
  if (next?.classList.contains("traceSpanInspectorRow")) next.remove();
  if (opening) row.insertAdjacentHTML("afterend", spanInspectorRowHtml(node, cache));
  parts.traceViews?.onSpanToggled?.(id, opening);
}

function setWaterfallLabelWidth(pct) {
  model.waterfallLabelPct = Math.max(WATERFALL_LABEL_MIN_PCT, Math.min(WATERFALL_LABEL_MAX_PCT, pct));
  dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
  const resizer = $("[data-trace-waterfall-resizer]", dom.traceWaterfall);
  resizer?.setAttribute("aria-valuenow", String(model.waterfallLabelPct));
  resizer?.setAttribute("aria-valuetext", `${model.waterfallLabelPct}% of the width`);
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
  if (!model.activeTrace || dom.traceDetail?.hidden) return;
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
      if (traceId) actions.loadTrace(traceId, { push: true });
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

// Copy JSON / Download JSON: the shared split control (copy.split), the
// same as a query's results.
function copyTraceJsonText() {
  const trace = model.activeTrace;
  return trace?.spans?.length ? traceJsonText(trace) : "";
}

function downloadTraceJson() {
  const trace = model.activeTrace;
  if (!trace?.spans?.length) return;
  copy.download(`trace-${String(trace.trace_id || "trace").replace(/[^0-9A-Za-z_-]/g, "")}.json`, traceJsonText(trace));
}

let traceCopySplit = null;

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
  parts.traceViews?.showTimeline?.();
  renderWaterfall();
  parts.traceViews?.markFocusedSpan?.();
  if (push || replace) {
    const href = spanTraceUrl(String(model.activeTrace?.trace_id || ""), id);
    if (push) address.push(null, { href, state: parts.traceViews.detailEntryState({ traceId: model.activeTrace?.trace_id, spanId: id }) });
    else address.replace(null, { href });
  }
  if (scroll) {
    const row = [...($$(".traceSpanRow[data-span-id]", dom.traceWaterfall) || [])].find((el) => el.getAttribute("data-span-id") === id);
    row?.scrollIntoView?.({ block: "center" });
    row?.focus?.({ preventScroll: true });
  }
  return true;
}

// The inspector (and the modules of the views) scroll to a span through the store: the waterfall owns it.
actions.focusSpan = focusSpanInTimeline;

// The waterfall and its header on the trace page: the events of the rows and the brush, the Copy / Download split of the
// trace JSON, the fold of the services, the keys while Traces shows, and the redraw of the overview for a new theme.
function initWaterfall() {
  initWaterfallEvents();
  // On a phone the trace header's stats, highlights and service filters are rows that scroll sideways (traces.css): fade the side they hide.
  for (const row of [dom.traceDetailStats, dom.byId("traceHighlights"), dom.traceServiceFilters]) shell?.edgeCues?.(row);
  dom.byId("traceServicesToggle")?.addEventListener("click", (event) => {
    setServicesOpen(event.currentTarget.getAttribute("aria-expanded") !== "true");
  });
  if (dom.traceCopySplit) {
    traceCopySplit = copy.split({
      root: dom.traceCopySplit,
      getText: copyTraceJsonText,
      items: [{ el: dom.traceDownloadJsonButton, onSelect: downloadTraceJson }],
    });
  }
  // The trace page's keys ([ ] o p, a / d, arrows) while Traces shows.
  lifecycle.bind("traces", (scope) => scope.listen(document, "keydown", onTraceKeydown));
  // The canvas overview holds resolved colours: redraw it for a new theme.
  const redrawOverview = () => {
    const graph = $('[data-overview-mode="canvas"]', dom.traceOverview);
    if (graph && model.activeTrace) renderTraceOverview(activeTraceCache().spans, activeTraceCache().bounds);
  };
  new MutationObserver(redrawOverview).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", redrawOverview);
}

export { copyTraceJsonText, downloadTraceJson, focusSpanInTimeline, initWaterfall, renderTraceHeader, renderTraceOverview, renderWaterfall, setServicesOpen, traceCopySplit, waterfallContext };
