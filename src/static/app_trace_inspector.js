// The span inspector of the trace page: the card of a span (its attributes, events and links as the Jaeger UI shows them), the
// sections that stay open when the waterfall is drawn again, the clicks inside it (copy, filter by a value, open a linked span).

import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { attributeEntries, linkedFromList, spanEventList, spanKindLabel, spanLinkList, traceBounds } from "./app_trace_model.js";
import { traceSearch } from "./app_trace_search.js";
import { actions, activeTraceCache, copyText, esc, model, parts, spanTraceUrl } from "./app_trace_store.js";
import { badge } from "./app_ui_badge.js";
import { copy } from "./app_ui_copy.js";
import { kv } from "./app_ui_kv.js";

const { byId, $, $$ } = dom;
const fmt = format;

// Span detail, after Jaeger's SpanDetail (AttributesTable, AccordionAttributes,
// AccordionEvents, AccordionLinks): HTML strings, with the inspector's
// buttons handled by delegation (initSpanDetailEvents).
const JSON_LOOKING = /^\s*[[{]/;
const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const OTEL_KEY_TITLE = "otel.* attribute: set by the OpenTelemetry SDK or exporter, not by the instrumented code";
const EVENTS_INITIAL_COUNT = 3;

// Attribute tables: the shared key / value list (kv.html). A string
// holding a JSON object or array is a tree (Jaeger's tryParseJson); HTTP
// header arrays a plain list; otel.* keys in italics. filterScope ("span" /
// "resource"): include / exclude actions, and a click on the value opens
// the filter menu (app_trace_search.js) for that attribute map.
function attributeRow(key, value, filterScope = "") {
  const name = String(key);
  const tree = kv.jsonValue(value);
  const headerList = Array.isArray(tree) && /^http\.(?:request|response)\.header\./.test(name);
  const otel = name.startsWith("otel.");
  return {
    key: name,
    value,
    list: headerList,
    keyClass: otel ? "is-otel" : "",
    keyTitle: otel ? OTEL_KEY_TITLE : "",
    actions: filterScope ? ["include", "exclude", "copy", "json"] : ["copy", "json"],
    attrs: filterScope ? { "data-filter-scope": filterScope } : {},
  };
}

function renderAttributeTable(raw, emptyText = "No attributes", filterScope = "") {
  const entries = attributeEntries(raw);
  if (!entries.length) return emptyText ? `<span class="traceJaegerEmpty">${esc(emptyText)}</span>` : "";
  return kv.html(entries.map(([key, value]) => attributeRow(key, value, filterScope)), { className: "traceKv" });
}

// The include / exclude / copy actions of the attribute lists: the search
// filters, and "JSON" copies { key, value }.
function attributeAction(action, { key, value, row, button }) {
  if (action === "json") {
    void copyText(JSON.stringify({ key, value }, null, 2), button);
    return true;
  }
  if (action === "include" || action === "exclude") {
    const scope = row.getAttribute("data-filter-scope") || "any";
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    traceSearch.applyFilter({ kind: "tag", scope, key }, text, action);
    return true;
  }
  if (action === "copy") {
    void copyText(typeof value === "string" ? value : attributeValueText(value), button);
    return true;
  }
  return false;
}

function attributeValueText(value) {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

// Jaeger's AttributesSummary: the k=v preview beside a collapsed section
// (hidden by CSS while the section is open).
function renderAttributePreview(raw, emptyText = "none") {
  const entries = attributeEntries(raw);
  if (!entries.length) return `<span class="traceJaegerSummaryPreview is-empty">${esc(emptyText)}</span>`;
  return `<span class="traceJaegerSummaryPreview">${entries.map(([key, value]) => `<span><b>${esc(key)}</b>=${esc(attributeValueText(value))}</span>`).join(" ")}</span>`;
}

// The Tags / Process preview while the section is closed: the first
// ATTRIBUTE_PREVIEW attributes as two-line cells (key, then value) across
// the inspector's width, and "Show all N" (the summary opens the table).
const ATTRIBUTE_PREVIEW = 8;
function renderAttributeGrid(raw) {
  const entries = attributeEntries(raw);
  if (!entries.length) return '<span class="traceJaegerSummaryPreview is-empty">none</span>';
  const cells = entries.slice(0, ATTRIBUTE_PREVIEW).map(([key, value]) => {
    const text = attributeValueText(value);
    return `<span class="traceAttrCell" title="${esc(`${key} = ${text}`)}"><b class="traceAttrCell__key">${esc(key)}</b><span class="traceAttrCell__value">${esc(text)}</span></span>`;
  }).join("");
  const more = entries.length > ATTRIBUTE_PREVIEW ? `<span class="traceAttrGrid__more">Show all ${entries.length}</span>` : "";
  return `<span class="traceJaegerSummaryPreview traceAttrGrid">${cells}${more}</span>`;
}

// Jaeger's AccordionAttributes: "Label (N)" and the preview grid while
// collapsed, the attribute table once open.
function renderJaegerAttributes(label, raw, { emptyText = "No attributes", open = false, filterScope = "" } = {}) {
  const count = attributeEntries(raw).length;
  return `<details class="traceJaegerGroup traceJaegerGroup--summary traceJaegerGroup--attrs" data-span-section="${esc(label.toLowerCase())}"${open ? " open" : ""}><summary><b>${esc(label)}</b>${count ? `<span class="traceJaegerGroup__count">${esc(fmt.count(count))}</span>` : ""}${renderAttributeGrid(raw)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(raw, emptyText, filterScope)}</div></details>`;
}

// A span or event instant: the stored UTC text ("2026-09-12 14:29:57.462123456",
// exact) or epoch ns (a double, exact to ~256 ns only). withRaw: the
// tooltip (fmt.timeTitle, to the nanosecond when the text has them), else
// the shown text (fmt.time to the millisecond).
function absoluteTimeText(ns, raw = "", { withRaw = true } = {}) {
  const text = String(raw || "");
  const parts = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  const ms = parts ? Date.parse(`${parts[1]}T${parts[2]}.${(parts[3] || "").slice(0, 3).padEnd(3, "0")}Z`) : Math.floor(Math.round(ns / 1e3) / 1e3);
  if (!Number.isFinite(ms)) return text;
  if (!withRaw) return fmt.time(ms, { precision: "ms" });
  const digits = parts ? (parts[3] || "").slice(0, 9).padEnd(9, "0") : "";
  return digits ? fmt.timeTitle(ms, { precision: "ns", ns: `${Math.floor(ms / 1000)}${digits}` }) : fmt.timeTitle(ms);
}

function sectionOpen(spanId, key) {
  return !!model.spanSections.get(String(spanId || ""))?.has(key);
}

function setSectionOpen(spanId, key, open) {
  const id = String(spanId || "");
  let keys = model.spanSections.get(id);
  if (!keys) {
    if (!open) return;
    keys = new Set();
    model.spanSections.set(id, keys);
  }
  if (open) keys.add(key); else keys.delete(key);
}

function eventItemHtml(event, traceStartNs, { hidden = false, open = false } = {}) {
  const offset = Number.isFinite(event.ns) ? fmt.duration(Math.max(0, event.ns - traceStartNs)) : fmt.EMPTY;
  const body = event.attributes && typeof event.attributes === "object" && !Array.isArray(event.attributes)
    ? renderAttributeTable(event.attributes, "No attributes")
    : (event.attributes == null ? '<span class="traceJaegerEmpty">No attributes</span>' : `<pre class="traceJaegerRaw">${esc(typeof event.attributes === "string" ? event.attributes : JSON.stringify(event.attributes, null, 2))}</pre>`);
  const preview = event.attributes && typeof event.attributes === "object" ? renderAttributePreview(event.attributes, "") : "";
  return `<details class="traceSpanEvent" data-event-index="${event.index}"${hidden ? " hidden" : ""}${open ? " open" : ""}><summary><b>${esc(event.name)}</b><time title="${esc(absoluteTimeText(event.ns, event.time))}">(${esc(offset)})</time>${preview}</summary><div class="traceSpanEvent__body">${body}</div></details>`;
}

function renderJaegerEvents(span, bounds) {
  const events = spanEventList(span);
  if (!events.length) return "";
  const id = span.span_id;
  const all = sectionOpen(id, "events-more");
  const items = events.map((event, index) => eventItemHtml(event, bounds.start, { hidden: !all && index >= EVENTS_INITIAL_COUNT, open: sectionOpen(id, `event:${event.index}`) })).join("");
  const more = events.length > EVENTS_INITIAL_COUNT
    ? `<button type="button" class="traceSpanEvents__more" data-events-more aria-expanded="${all ? "true" : "false"}">${all ? "show less" : "show more..."}</button>`
    : "";
  return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanEvents" data-span-section="events"${sectionOpen(id, "events") ? " open" : ""}><summary><b>Events</b><span class="traceJaegerGroup__count">(${events.length})</span></summary><div class="traceJaegerGroup__body"><div class="traceSpanEvents__list">${items}</div>${more}<small class="traceSpanEvents__note">Event timestamps are relative to the start time of the full trace.</small></div></details>`;
}

function referenceItemHtml(kind, ref, cache) {
  const traceId = String(cache.trace?.trace_id || "");
  const sameTrace = !ref.traceId || ref.traceId === traceId;
  const target = sameTrace ? cache.nodeById.get(ref.spanId)?.span : null;
  const label = target
    ? `<span class="traceSpanRefs__svc" style="--trace-service-color:${palette.service(target.service_name)}">${esc(target.service_name || "unknown")}</span><small class="traceSpanRefs__op">${esc(target.span_name || "span")}</small>`
    : `<span class="traceSpanRefs__svc is-external">${sameTrace ? "&lt; span not in this trace &gt;" : "&lt; span in another trace &gt;"}</span>`;
  const ids = `<small class="traceSpanRefs__ids">${sameTrace ? "" : `<span>TraceID: <code>${esc(ref.traceId)}</code></span>`}<span>SpanID: <code>${esc(ref.spanId)}</code></span></small>`;
  let action = "";
  if (target) action = `<button type="button" class="traceSpanRefs__open" data-focus-span="${esc(ref.spanId)}">Go to span</button>`;
  else if (!sameTrace) action = `<a class="traceSpanRefs__open traceJaegerLink__trace" href="${esc(spanTraceUrl(ref.traceId, ref.spanId))}" data-linked-trace="${esc(ref.traceId)}" data-linked-span="${esc(ref.spanId)}" title="Open linked trace">Open linked trace</a>`;
  const attrs = attributeEntries(ref.attributes).length ? `<div class="traceSpanRefs__attrs">${renderAttributeTable(ref.attributes, "")}</div>` : "";
  const kindClass = kind.replace(/\s+/g, "-");
  return `<li class="traceSpanRefs__item" data-ref-kind="${esc(kindClass)}">${refKindHtml(kind)}<span class="traceSpanRefs__main">${label}${ids}</span>${action}${attrs}</li>`;
}

// The kind of a reference, a pill badge: child of (neutral), follows from /
// linked from (accent).
function refKindHtml(kind) {
  const kindClass = String(kind).replace(/\s+/g, "-");
  return badge.html(kind, { tone: kindClass === "child-of" ? "neutral" : "accent", shape: "pill", className: `traceSpanRefs__kind traceSpanRefs__kind--${kindClass}` });
}

// Jaeger's references: the parent (child of) and the span's links (follows
// from), plus the spans of this trace that link here (linked from), and a
// lazily loaded group of the spans of other traces that link here.
function renderJaegerLinks(span, cache) {
  const links = spanLinkList(span);
  const from = linkedFromList(cache, span);
  const remote = parts.traceInsights?.linkedFromRemoteHtml(span, cache) || "";
  if (!links.length && !from.length && !remote) return "";
  const items = [];
  const parentId = String(span.parent_span_id || "");
  if (parentId) items.push(referenceItemHtml("child of", { traceId: "", spanId: parentId }, cache));
  for (const link of links) items.push(referenceItemHtml("follows from", link, cache));
  for (const link of from) items.push(referenceItemHtml("linked from", link, cache));
  const count = items.length ? `<span class="traceJaegerGroup__count">(${items.length})</span>` : "";
  const list = items.length ? `<ul class="traceSpanRefs__list">${items.join("")}</ul>` : "";
  return `<details class="traceJaegerGroup traceJaegerGroup--summary traceSpanRefs" data-span-section="references"${sectionOpen(span.span_id, "references") ? " open" : ""}><summary><b>References</b>${count}</summary><div class="traceJaegerGroup__body">${list}${remote}</div></details>`;
}

function idCopyHtml(label, value, field) {
  if (!value) return `<span>${esc(label)}: <code>root</code></span>`;
  return `<span>${esc(label)}: <code>${esc(value)}</code>${copy.buttonHtml({ label: `Copy ${field}`, className: "traceCopyButton traceInspectorIdentity__copy", attrs: { "data-copy-span-field": value } })}</span>`;
}

function renderSpanInspectorCard(span, spans, knownBounds = null) {
  const cache = activeTraceCache();
  const status = span.status_code || "Unset";
  const bounds = knownBounds || traceBounds(spans || []);
  const startNs = Number(span.start_ns || 0);
  const startOffset = Math.max(0, startNs - bounds.start);
  const statusClass = esc(String(status).toLowerCase());
  const statusBadge = String(status).toLowerCase() === "unset" ? "" : badge.statusHtml(status, { className: `traceStatus traceStatus--${statusClass}`, title: "Span status (click to filter)", attrs: { "data-filter-field": "status", "data-filter-value": status, tabindex: "0", role: "button", "aria-haspopup": "menu" } });
  const statusMessage = String(span.status_message || "").trim();
  const color = palette.service(span.service_name);
  const absolute = absoluteTimeText(startNs, span.timestamp);
  const id = String(span.span_id || "");
  return `<section class="traceInspector traceInspector--jaeger traceInspector--inline" style="--trace-service-color:${color}" data-inspector-span="${esc(id)}">
      <div class="traceInspectorHead traceInspectorHead--jaeger">
        <strong title="${esc(span.span_name || "span")}"><span class="traceFilterable" data-filter-field="operation" data-filter-value="${esc(span.span_name || "")}" tabindex="0" role="button" aria-haspopup="menu">${esc(span.span_name || "span")}</span></strong>
        <div class="traceInspectorHead__meta"><span>Service: <b class="traceInspectorHead__service traceFilterable" data-filter-field="service" data-filter-value="${esc(span.service_name || "")}" tabindex="0" role="button" aria-haspopup="menu">${esc(span.service_name || "unknown")}</b></span><i></i><span>Duration: <b>${esc(fmt.duration(span.duration_ns))}</b></span><i></i><span title="${esc(absolute)}">Start: <b>${esc(fmt.duration(startOffset))}</b><small class="traceInspectorHead__abs">${esc(absoluteTimeText(startNs, span.timestamp, { withRaw: false }))}</small></span><i></i><span>Kind: <b>${esc(spanKindLabel(span.span_kind))}</b></span>${statusBadge}</div>
      </div>
      ${parts.traceInsights?.exceptionSectionHtml(span, bounds) || ""}
      ${statusMessage ? `<div class="traceInspectorStatusMessage"><b>Status message</b><span>${esc(statusMessage)}</span></div>` : ""}
      <div class="traceInspectorIdentity">${idCopyHtml("SpanID", id, "Span ID")}${idCopyHtml("Parent", String(span.parent_span_id || ""), "parent Span ID")}<button type="button" class="traceInspectorIdentity__deepLink" data-copy-deep-link="${esc(id)}" title="Copy a link that opens this trace on this span">Copy deep link</button>${parts.traceInsights ? `<button type="button" class="traceInspectorIdentity__deepLink traceInspectorIdentity__context" data-span-context="${esc(id)}" title="Spans of any trace around this span's start time">Context</button>` : ""}</div>
      ${renderJaegerAttributes("Tags", span.span_attributes, { open: sectionOpen(id, "tags"), filterScope: "span" })}
      ${attributeEntries(span.resource_attributes).length ? renderJaegerAttributes("Process", span.resource_attributes, { open: sectionOpen(id, "process"), filterScope: "resource" }) : ""}
      ${renderJaegerEvents(span, bounds)}
      ${renderJaegerLinks(span, cache)}
      ${parts.traceLogs?.inspectorSectionHtml?.(span) || ""}
    </section>`;
}

function spanDeepLink(spanId) {
  const traceId = String(model.activeTrace?.trace_id || "");
  return new URL(spanTraceUrl(traceId, spanId), window.location.href).toString();
}

// The inspector sits in the waterfall, whose own click handler ignores
// clicks outside span rows; these buttons are handled here.
function spanDetailClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const linked = target.closest("[data-linked-span]");
  // The waterfall handler opens the linked trace; say which span to focus.
  if (linked) { model.pendingSpanId = String(linked.getAttribute("data-linked-span") || ""); return; }
  if (parts.traceInsights?.handleInspectorClick(event, target)) return;
  const kvButton = target.closest("[data-kv-action]");
  const kvRow = kvButton?.closest(".kvList__row");
  if (kvButton && kvRow) {
    event.preventDefault();
    event.stopPropagation();
    let value = null;
    try { value = JSON.parse(kvRow.getAttribute("data-kv-json") || "null"); } catch (_) { value = kvRow.getAttribute("data-kv-text"); }
    attributeAction(kvButton.getAttribute("data-kv-action"), { key: kvRow.getAttribute("data-kv-key") || "", value, row: kvRow, button: kvButton });
    return;
  }
  const idCopy = target.closest("[data-copy-span-field]");
  if (idCopy) { event.preventDefault(); event.stopPropagation(); copyText(idCopy.getAttribute("data-copy-span-field") || "", idCopy); return; }
  const deepLink = target.closest("[data-copy-deep-link]");
  if (deepLink) {
    event.preventDefault();
    event.stopPropagation();
    copyText(spanDeepLink(deepLink.getAttribute("data-copy-deep-link") || ""), deepLink);
    return;
  }
  const more = target.closest("[data-events-more]");
  if (more) {
    event.preventDefault();
    event.stopPropagation();
    const expanded = more.getAttribute("aria-expanded") !== "true";
    more.setAttribute("aria-expanded", expanded ? "true" : "false");
    more.textContent = expanded ? "show less" : "show more...";
    $$(".traceSpanEvents__list > .traceSpanEvent", more.parentElement).forEach((item, index) => {
      if (index >= EVENTS_INITIAL_COUNT) item.hidden = !expanded;
    });
    setSectionOpen(more.closest("[data-inspector-span]")?.getAttribute("data-inspector-span"), "events-more", expanded);
    return;
  }
  const focus = target.closest("[data-focus-span]");
  if (focus) {
    event.preventDefault();
    event.stopPropagation();
    actions.focusSpan(String(focus.getAttribute("data-focus-span") || ""), { push: true });
  }
}

// "toggle" does not bubble: listen in the capture phase.
function spanSectionToggle(event) {
  const details = event.target instanceof HTMLDetailsElement ? event.target : null;
  const spanId = details?.closest("[data-inspector-span]")?.getAttribute("data-inspector-span");
  if (!details || !spanId) return;
  const key = details.dataset.spanSection || (details.classList.contains("traceSpanEvent") ? `event:${details.dataset.eventIndex}` : "");
  if (key) setSectionOpen(spanId, key, details.open);
  if (key) parts.traceInsights?.onSectionToggle(spanId, key, details.open);
}

function initSpanDetailEvents() {
  dom.traceWaterfall?.addEventListener("click", spanDetailClick, true);
  dom.traceWaterfall?.addEventListener("toggle", spanSectionToggle, true);
}

export { absoluteTimeText, eventItemHtml, initSpanDetailEvents, renderAttributeTable, renderJaegerAttributes, renderSpanInspectorCard, sectionOpen, setSectionOpen, spanDetailClick };
