// The result list of the Traces search: the traces as cards or as a table, their service pills, the sort and the display of the
// start, the empty and the no-result states, the count.

import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { palette } from "./app_palette.js";
import { storage } from "./app_state.js";
import { renderAnalytics } from "./app_trace_analytics.js";
import { LIST_SORTS, TABLE_COLUMNS, parseStartMs, sortTraces, traceName } from "./app_trace_model.js";
import { traceSearch } from "./app_trace_search.js";
import { actions, address, copyText, esc, model, parts, spanTraceUrl, traceIdFromPath } from "./app_trace_store.js";
import { badge } from "./app_ui_badge.js";
import { copy } from "./app_ui_copy.js";
import { icon } from "./app_ui_icon.js";
import { popover } from "./app_ui_popover.js";
import { segmented } from "./app_ui_segmented.js";
import { uiState } from "./app_ui_state.js";
import { table } from "./app_ui_table.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;
const fmt = format;

// --- Search results: Jaeger-style list and sortable table ---------------
const RESULTS_VIEW_KEY = storage.KEYS.traceResultsView;
const START_DISPLAY_KEY = storage.KEYS.traceStartDisplay;

function readStored(key, allowed, fallback) {
  return storage.pref(key, fallback, { allowed }).get();
}

function writeStored(key, value) {
  storage.pref(key, "").set(value);
}

function listSort() {
  return LIST_SORTS[String(dom.tracesSort?.value || "recent")] || LIST_SORTS.recent;
}

function sortedResults() {
  const rows = [...(model.traces || [])];
  return sortTraces(rows, model.resultsView === "table" ? (model.tableSort || listSort()) : listSort());
}

function incompleteTooltip(count) {
  const noun = count === 1 ? "span" : "spans";
  return `This trace may be incomplete: its spans reference ${count} parent ${noun} missing from the searched range. `
    + "This happens when the trace crosses the range, when a parent span belongs to a service you cannot see, "
    + "or while the trace is still being collected.";
}

function errorTagHtml(errors) {
  const label = `${fmt.count(errors)} Error${errors === 1 ? "" : "s"}`;
  const title = `${fmt.count(errors)} error span${errors === 1 ? "" : "s"}`;
  return badge.html(label, { tone: "error", className: "traceTag traceTag--error traceErrorCount--title", title, attrs: { "aria-label": title } });
}

function incompleteTagHtml(missing) {
  return badge.html("", { tone: "warn", className: "traceTag traceTag--incomplete", title: incompleteTooltip(missing), attrs: { "data-missing-parents": missing }, html: `${icon("alert-triangle", { size: "sm" })}Incomplete` });
}

function servicePillHtml(stat, minor = false) {
  const errors = Number(stat.errors || 0);
  const errorTitle = errors ? ` · ${fmt.count(errors)} error span${errors === 1 ? "" : "s"}` : "";
  // A service chip: the shared badge with the service's left bar.
  return `<span class="badge badge--md badge--neutral traceSvcPill${errors ? " has-errors" : ""}${minor ? " is-minor" : ""}" data-service="${esc(stat.service)}" data-spans="${esc(stat.spans)}" data-errors="${errors}" style="--trace-service-color:${palette.service(stat.service)}" title="${esc(stat.service)} \u00b7 ${fmt.count(stat.spans)} span${stat.spans === 1 ? "" : "s"}${errorTitle}"><i class="serviceSwatch serviceSwatch--bar" aria-hidden="true"></i>${errors ? badge.html("!", { tone: "error", solid: true, className: "badge--count traceSvcPill__error", attrs: { "aria-label": "has errors" } }) : ""}<b>${esc(stat.service)}</b> <span class="traceSvcPill__count">(${fmt.count(stat.spans)})</span></span>`;
}

// A row names its three most costly services (still in the order of their first span), the others are behind a "+N"
// chip, in the list and in the table at any width: a wall of chips repeated down the page says nothing. Costly: the
// services with errors first, then the most spans.
const SERVICE_PILLS_SHOWN = 3;

// One line of service pills; layoutServicePills hides the ones that do not fit, and the minor ones always, and shows them
// behind a "+N" chip.
function servicePillsHtml(stats) {
  if (!stats.length) return `<div class="traceSvcPills is-empty">${fmt.EMPTY}</div>`;
  const costly = [...stats].sort((a, b) => (Number(b.errors || 0) > 0) - (Number(a.errors || 0) > 0) || Number(b.spans || 0) - Number(a.spans || 0) || String(a.service).localeCompare(String(b.service)));
  const major = new Set(costly.slice(0, SERVICE_PILLS_SHOWN).map((stat) => stat.service));
  return `<div class="traceSvcPills">${stats.map((stat) => servicePillHtml(stat, !major.has(stat.service))).join("")}<button type="button" class="badge badge--md badge--neutral traceSvcMore" hidden>+0</button></div>`;
}

function layoutServicePills(scope) {
  const groups = [...($$(".traceSvcPills:not(.is-empty)", scope) || [])];
  if (!groups.length) return;
  // Write, read, then write again: one layout pass for the whole list. The minor pills (past the three most costly
  // services) are never shown: only the major ones are measured and fitted.
  const prepared = groups.map((group) => {
    const pills = [...$$(":scope > .traceSvcPill", group)];
    const more = $(":scope > .traceSvcMore", group);
    for (const pill of pills) pill.hidden = pill.classList.contains("is-minor");
    if (more) { more.hidden = false; more.textContent = `+${pills.length}`; }
    // Natural widths: no pill shrinks while measuring.
    group.classList.add("is-measuring");
    return { group, pills, major: pills.filter((pill) => !pill.hidden), more };
  });
  const gap = parseFloat(getComputedStyle(groups[0]).columnGap) || 4;
  const measured = prepared.map((item) => ({
    ...item,
    width: item.group.clientWidth,
    widths: item.major.map((pill) => pill.offsetWidth),
    moreWidth: item.more ? item.more.offsetWidth : 0,
  }));
  for (const { group, pills, major, more, width, widths, moreWidth } of measured) {
    group.classList.remove("is-measuring");
    if (!width) { if (more) more.hidden = true; continue; }
    let used = 0;
    let shown = 0;
    const minors = pills.length - major.length;
    const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, widths.length - 1);
    if (total + (minors ? gap + moreWidth : 0) <= width + 0.5) shown = major.length;
    else {
      for (let i = 0; i < widths.length; i += 1) {
        const next = used + (i ? gap : 0) + widths[i];
        if (next + gap + moreWidth > width + 0.5) break;
        used = next;
        shown = i + 1;
      }
      // The first pill always shows (ellipsized when it alone is too wide).
      shown = Math.max(1, shown);
    }
    major.forEach((pill, index) => { pill.hidden = index >= shown; });
    if (more) {
      const rest = pills.length - shown;
      more.hidden = rest <= 0;
      more.textContent = `+${rest}`;
      more.setAttribute("aria-label", `${rest} more service${rest === 1 ? "" : "s"}`);
    }
    group.classList.toggle("is-overflowing", shown < pills.length);
  }
}

// The hidden pills of a row, in a tooltip under its "+N" chip (hover,
// focus or a click: ns.popover.tip).
let serviceTip = null;
function hiddenPills(more) {
  if (!more || more.hidden) return null;
  const hidden = [...$$(":scope > .traceSvcPill[hidden]", more.parentElement)];
  if (!hidden.length) return null;
  const list = document.createDocumentFragment();
  for (const pill of hidden) { const copy = pill.cloneNode(true); copy.hidden = false; list.appendChild(copy); }
  return list;
}
function hideServicePopover() {
  serviceTip?.hide();
}

// A trace start: the shown time, how long ago, and the tooltip of both
// (fmt.timeTitle: ISO, local and UTC).
function startTexts(trace) {
  const ms = parseStartMs(trace.start_ms);
  if (!Number.isFinite(ms)) return { absolute: String(trace.start_ms || fmt.EMPTY), ago: "", title: "", timeTitle: "" };
  const timeTitle = fmt.timeTitle(ms);
  return { absolute: fmt.time(ms), ago: fmt.ago(ms), title: `${fmt.ago(ms)}\n${timeTitle}`, timeTitle };
}

function resultItemHtml(trace, maxDurationNs) {
  const errors = Number(trace.error_count || 0);
  const missing = Number(trace.missing_parents || 0);
  const title = traceName(trace);
  const spans = Number(trace.span_count || 0);
  const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
  const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
  const start = startTexts(trace);
  // The trace is a link (its page, the search context in the address): the only stop of the row besides its own buttons.
  return `<li class="traceResult traceResult--wide traceResultItem" data-trace-id="${esc(trace.trace_id)}">
        <div class="traceResult__line traceResult__line--main traceResultItem__title">
          <span class="traceResultItem__durationBar" style="width:${percent.toFixed(2)}%" data-duration-percent="${percent.toFixed(2)}" aria-hidden="true"></span>
          <a title="${esc(title)}" class="traceResult__wideTitle" href="${esc(spanTraceUrl(trace.trace_id))}">${esc(title)}</a>${errors ? errorTagHtml(errors) : ""}${missing ? incompleteTagHtml(missing) : ""}
          <code class="traceResult__fullId">${esc(trace.trace_id)}</code>
          ${copy.buttonHtml({ label: "Copy trace ID", className: "traceCopyButton", attrs: { "data-copy-trace": trace.trace_id } })}
          <span class="traceResult__right"><b>${esc(fmt.duration(trace.duration_ns))}</b></span>
        </div>
        <div class="traceResult__line traceResult__line--stats">
          ${badge.html(`${fmt.count(spans)} Span${spans === 1 ? "" : "s"}`, { className: "traceTag traceTag--spans" })}
          ${servicePillsHtml(services)}
          <span class="traceResult__when" title="${esc(start.title)}"><time>${esc(start.absolute)}</time><small>${esc(start.ago)}</small></span>
        </div>
      </li>`;
}

function resultTableHtml(rows, maxDurationNs) {
  const sort = model.tableSort || listSort();
  const relative = model.startDisplay === "relative";
  const head = TABLE_COLUMNS.map((column) => {
    const active = sort.key === column.key;
    const aria = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
    const toggle = column.key === "start"
      ? `<button type="button" class="traceTable__startToggle" data-start-toggle title="${relative ? "Show absolute time" : "Show relative time"}" aria-label="Toggle start time format">${icon("arrows-exchange", { size: "sm" })}</button>`
      : "";
    const num = column.numeric && column.key !== "services" ? " num" : "";
    return `<th class="is-sortable traceTable__th traceTable__th--${column.key}${num}" data-table-sort="${column.key}" data-sort-key="${column.key}" aria-sort="${aria}" scope="col"><button type="button" class="dataTable__sort">${column.label}</button>${toggle}</th>`;
  }).join("");
  const body = rows.map((trace) => {
    const errors = Number(trace.error_count || 0);
    const missing = Number(trace.missing_parents || 0);
    const name = traceName(trace);
    const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
    const percent = maxDurationNs > 0 ? Math.max(0, Math.min(100, (Number(trace.duration_ns || 0) / maxDurationNs) * 100)) : 0;
    const { absolute, ago, title: startTitle, timeTitle: startTimeTitle } = startTexts(trace);
    return `<tr class="traceTable__row" data-trace-id="${esc(trace.trace_id)}" tabindex="-1">
        <td class="traceTable__name has-copy" data-cell="name"><span class="traceTable__nameText" title="${esc(name)}"><b>${esc(trace.root_service || "unknown")}:</b> ${esc(trace.root_operation || "trace")}</span>${missing ? incompleteTagHtml(missing) : ""}${table.copyCellHtml(trace.trace_id, "Copy trace ID")}</td>
        <td class="traceTable__services" data-cell="services">${servicePillsHtml(services)}</td>
        <td class="num" data-cell="spans">${fmt.count(Number(trace.span_count || 0))}</td>
        <td class="num" data-cell="errors">${errors ? badge.html(fmt.count(errors), { tone: "error", className: "badge--count traceErrorBadge", title: `${fmt.count(errors)} error span${errors === 1 ? "" : "s"}` }) : "0"}</td>
        <td class="num traceTable__duration cellBar" data-cell="duration" data-duration-percent="${percent.toFixed(2)}" style="${table.cellBarStyle(percent)}" title="${esc(fmt.duration(trace.duration_ns))}">${esc(fmt.duration(trace.duration_ns))}</td>
        <td class="num traceTable__start" data-cell="start" title="${esc(relative ? startTimeTitle : startTitle)}">${esc(relative ? ago : absolute)}</td>
      </tr>`;
  }).join("");
  return `<div class="tableWrap traceTableWrap"><table class="dataTable traceTable" aria-label="Traces"><colgroup><col class="traceTable__col--name"><col class="traceTable__col--services"><col class="traceTable__col--spans"><col class="traceTable__col--errors"><col class="traceTable__col--duration"><col class="traceTable__col--start"></colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function syncResultsViewControls() {
  const table = model.resultsView === "table";
  segmented?.set($(".traceResultsViewToggle"), model.resultsView, "resultsView");
  // Like Jaeger, the sort picker drives the list; the table sorts by its headers.
  const sortLabel = $(".traceResultsSort");
  if (sortLabel) sortLabel.hidden = table;
  dom.tracesResults?.classList.toggle("tracesResults--table", table);
}

// persist: false for a view restored from the URL (the stored preference
// is the user's own last choice).
function setResultsView(view, { persist = true } = {}) {
  const next = view === "table" ? "table" : "list";
  if (next === model.resultsView) return;
  model.resultsView = next;
  if (persist) writeStored(RESULTS_VIEW_KEY, next);
  if (next === "table") model.tableSort = { ...listSort() };
  renderResults();
  if (persist && !traceIdFromPath()) address.replace();
}

function sortTableBy(key) {
  const column = TABLE_COLUMNS.find((item) => item.key === key);
  if (!column) return;
  const current = model.tableSort || listSort();
  model.tableSort = current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: column.numeric ? "desc" : "asc" };
  renderResults();
  $(`[data-table-sort="${key}"] .dataTable__sort`, dom.tracesResults)?.focus({ preventScroll: true });
}

// "No traces / spans found" (the result list and the span table): the
// range searched and the ways out, a wider range and no filters.
function noResultsHtml(noun, range, attrs = {}) {
  const when = range ? `between ${fmt.time(range.start)} and ${fmt.time(range.end)}` : "in this range";
  const zoom = dom.tracesRangeZoomOut;
  const filtered = !!traceSearch.hasFilters();
  return uiState.emptyHtml({
    title: `No ${noun} found`,
    body: `No ${noun} match these filters ${when}.`,
    attrs: { "data-empty-results": "", ...attrs },
    actions: [
      zoom && !zoom.disabled ? { label: "Zoom out", icon: "zoomOut", attrs: { "data-results-zoom-out": "" } } : null,
      filtered ? { label: "Clear filters", attrs: { "data-results-clear-filters": "" } } : null,
    ],
  });
}

function emptyResultsHtml() {
  if (!model.searched) return uiState.emptyHtml({ body: "Search to load traces." });
  const range = model.lastSearchRange;
  return noResultsHtml("traces", range ? { start: range.start_ms, end: range.end_ms } : null);
}

function renderResultCount(rows) {
  const count = byId("tracesResultCount");
  if (!count) return;
  const withErrors = rows.filter((trace) => Number(trace.error_count || 0) > 0).length;
  const longest = Math.max(0, ...rows.map((trace) => Number(trace.duration_ns || 0)));
  const latency = model.searched && Number.isFinite(model.searchLatencyMs)
    && [" ", h("span", { class: "tracesResultCount__latency", title: "Search request time, measured in the browser" }, `(in ${fmt.duration.fromMs(model.searchLatencyMs)})`)];
  h.replace(count, `${fmt.count(rows.length)} Trace${rows.length === 1 ? "" : "s"}`, latency,
    withErrors > 0 && [" ", h("span", { class: "tracesResultCount__errors", title: `${fmt.count(withErrors)} of the listed traces have error spans` }, `· ${fmt.count(withErrors)} with error${withErrors === 1 ? "" : "s"}`)],
    model.resultsView !== "table" && longest > 0 && [" ", h("span", { class: "tracesResultCount__scale", title: "The bar under each trace is its duration against the longest trace listed, from 0" }, `· bars up to ${fmt.duration(longest)}`)]);
}

let resultsResizeObserver = null;
const resultsResizeFrame = util.rafOnce(() => {
  hideServicePopover();
  layoutServicePills(dom.tracesResults);
});
function watchResultsWidth() {
  if (resultsResizeObserver || typeof ResizeObserver !== "function" || !dom.tracesResults) return;
  let lastWidth = -1;
  resultsResizeObserver = new ResizeObserver((entries) => {
    const width = Math.round(entries[entries.length - 1]?.contentRect?.width || 0);
    if (width === lastWidth || resultsResizeFrame.pending()) return;
    lastWidth = width;
    resultsResizeFrame();
  });
  resultsResizeObserver.observe(dom.tracesResults);
}

let resultEventsBound = false;
function bindResultEvents() {
  const root = dom.tracesResults;
  if (resultEventsBound || !root) return;
  resultEventsBound = true;
  const openRow = (row) => {
    // A list card: its link (the address was built with the search); a table row has none.
    const link = $("a.traceResult__wideTitle", row);
    if (link) { link.click(); return; }
    const id = row?.getAttribute("data-trace-id");
    if (id) actions.loadTrace(id, { push: true });
  };
  root.addEventListener("click", (event) => {
    const target = event.target;
    const copy = target.closest("[data-copy-trace]");
    if (copy) { event.stopPropagation(); copyText(copy.getAttribute("data-copy-trace") || "", copy); return; }
    const more = target.closest(".traceSvcMore");
    if (more) {
      event.stopPropagation();
      serviceTip?.show(more);
      return;
    }
    if (target.closest("[data-results-zoom-out]")) { dom.tracesRangeZoomOut?.click(); return; }
    if (target.closest("[data-results-clear-filters]")) { traceSearch.clearFilters(); void actions.search(); return; }
    if (target.closest("[data-start-toggle]")) {
      event.stopPropagation();
      model.startDisplay = model.startDisplay === "relative" ? "absolute" : "relative";
      writeStored(START_DISPLAY_KEY, model.startDisplay);
      renderResults();
      $("[data-start-toggle]", dom.tracesResults)?.focus({ preventScroll: true });
      return;
    }
    const th = target.closest("[data-table-sort]");
    // Anywhere on a header sorts (the start toggle returned above).
    if (th) { sortTableBy(th.getAttribute("data-table-sort")); return; }
    // The title link navigates by itself; a click elsewhere on a card or a row opens the trace too.
    if (target.closest("a[href]")) return;
    const row = target.closest("[data-trace-id]");
    if (row && root.contains(row)) openRow(row);
  });
  // The table rows rove (ns.table.rovingRows); a list card is its title link, so it needs no key handler.
  serviceTip = popover.tip(root, hiddenPills, { selector: ".traceSvcMore", side: "bottom", className: "traceSvcPopover" });
  table.rovingRows(root, { rows: "tr.traceTable__row", onOpen: (row) => openRow(row) });
  table.bindCopy(root);
  // List | Table: the shared segmented control (app_ui_segmented.js).
  segmented?.bind($(".traceResultsViewToggle"), { attr: "resultsView", onChange: (view) => { setResultsView(view); return false; } });
}

function renderResults() {
  if (!dom.tracesResults) return;
  bindResultEvents();
  watchResultsWidth();
  hideServicePopover();
  syncResultsViewControls();
  // Spans mode draws its own span table (app_trace_spans.js).
  if (parts.traceSpans?.active?.()) {
    renderAnalytics();
    parts.traceSpans?.render();
    return;
  }
  parts.traceSpans?.leave?.();
  const rows = sortedResults();
  renderResultCount(rows);
  renderAnalytics();
  if (!rows.length) {
    dom.tracesResults.innerHTML = emptyResultsHtml();
    return;
  }
  const maxDurationNs = Math.max(0, ...rows.map((trace) => Number(trace.duration_ns || 0)));
  dom.tracesResults.innerHTML = model.resultsView === "table"
    ? resultTableHtml(rows, maxDurationNs)
    : `<ul class="traceResultList" aria-label="Traces">${rows.map((trace) => resultItemHtml(trace, maxDurationNs)).join("")}</ul>`;
  layoutServicePills(dom.tracesResults);
}

export { RESULTS_VIEW_KEY, START_DISPLAY_KEY, noResultsHtml, readStored, renderResults, setResultsView };
