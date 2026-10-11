// The Traces search (traces.html, /observability/traces): the view that app_page_traces.js starts. It runs the search, applies the
// range, loads the durations and the analytics, and starts the modules of the search page (the results, the charts, the heatmap, the
// Spans mode, the tabs). A trace is another page (app_trace_detail.js): the search opens it by navigating. The two views share the
// model, the address and the helpers of app_trace_store.js, and the functions that this view provides to the modules under it are
// in its `actions` (ARCH-F-155).

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { obsView } from "./app_obs_view.js";
import { palette } from "./app_palette.js";
import { timeRange } from "./app_timerange.js";
import { renderAnalytics, scatterDots } from "./app_trace_analytics.js";
import { orderByFirstSpan, unpackAnalytics } from "./app_trace_model.js";
import { RESULTS_VIEW_KEY, START_DISPLAY_KEY, readStored, renderResults, setResultsView } from "./app_trace_results.js";
import { traceHeatmap } from "./app_trace_heatmap.js";
import { traceSearch } from "./app_trace_search.js";
import { traceSpans } from "./app_trace_spans.js";
import { traceTabs } from "./app_trace_tabs.js";
import { actions, address, currentHost, enhanceTraceSelect, maxRangeMinutes, model, parts, setView, showError, spanTraceUrl, traceIdFromPath, trackSearchBarHeight } from "./app_trace_store.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;
const fmt = format;

// The result list hands the Spans mode its place in the list (results and spans import each other's work: the spans are
// handed to the results from here).
parts.traceSpans = traceSpans;

function initTracePickers() {
  initTimeRangePicker();
  // The Logs and Metrics views share the search bar look: only this view's selects.
  $$("#tracesWorkspace .traceSearchBar select, #tracesWorkspace .traceResultsSort select").forEach((select) => {
    if (select !== dom.tracesRangeUnit || !timePicker) enhanceTraceSelect(select);
  });
}

let timePicker = null;

// The Grafana-style time range panel (built by app_timerange.js) is the
// dropdown of the shipped range picker (same root and button, same
// open/close motion). Its zoom button joins dom: the result views' "zoom
// out" actions click it.
function initTimeRangePicker() {
  const select = dom.tracesRangeUnit;
  const root = select?.parentElement;
  if (!timeRange || !$(":scope > .tracePicker__button", root)) return;
  select.dataset.tracePickerReady = "1";
  timePicker = timeRange.create(root, {
    idPrefix: "traces",
    getValue: () => model.timeRange,
    getMaxMinutes: maxRangeMinutes,
    onApply: (raw, source) => { void applyCustomRange(raw, source); },
  });
  dom.tracesRangeZoomOut = timePicker.el.zoomOut;
}

// Meta decides the default window (until the user picks one) and the widest
// one: an applied range wider than the server accepts falls back to the
// widest quick range that fits.
function syncRangeControls() {
  const tr = timeRange;
  if (!tr) return;
  const max = maxRangeMinutes();
  const fallbackMinutes = Math.min(max, Math.max(1, Number(model.meta?.default_lookback_minutes || 60)));
  if (!model.timeRangeTouched && model.meta) model.timeRange = { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
  const now = Date.now();
  const { startMs, endMs } = tr.resolveRange(model.timeRange, now);
  if (!(endMs > startMs) || endMs - startMs > max * 60000) {
    const requested = model.timeRange;
    const fitting = tr.QUICK_RANGES.filter((option) => option.to === "now" && /^now-\d+[smhdwMy]$/.test(option.from))
      .filter((option) => { const r = tr.resolveRange(option, now); return r.endMs - r.startMs <= max * 60000; });
    model.timeRange = fitting.length ? { from: fitting[fitting.length - 1].from, to: "now" } : { from: `now-${tr.minutesToSpan(fallbackMinutes)}`, to: "now" };
    // Never silently: a link for 30 days that shows 7 would read as "no traces".
    if (endMs > startMs) {
      model.rangeNotice = `The range ${fmt.range(requested.from, requested.to)} is longer than the server allows (${tr.formatMinutes(max)}, traces.max_lookback_minutes): showing ${fmt.range(model.timeRange.from, model.timeRange.to)}.`;
      showError("");
    }
  }
  refreshCustomRangeLabel();
}

// Relative ranges ("now-1h") are resolved again for every request.
function selectedRange() {
  const { startMs, endMs } = timeRange.resolveBounded(model.timeRange, maxRangeMinutes(), "server setting traces.max_lookback_minutes");
  return { start_ms: Math.round(startMs), end_ms: Math.round(endMs), align_buckets: timeRange.isRelative(model.timeRange) ? "1" : "0" };
}

function replaceSelectOptions(select, values, allLabel) {
  if (!select) return;
  const previous = String(select.value || "");
  // A value applied from the URL or a filter action (app_trace_search.js)
  // stays selectable even when the discovered pairs do not list it.
  const wanted = String(select.dataset.wanted || "");
  const unique = [...new Set([...(values || []), wanted].map((value) => String(value || "")).filter(Boolean))].sort();
  h.replace(select, h("option", { value: "" }, allLabel || "All"), unique.map((value) => h("option", { value }, value)));
  select.value = wanted || (unique.includes(previous) ? previous : "");
  select.dispatchEvent(new Event("tracepicker-refresh"));
}

function updateServiceOptions() {
  const operation = String(dom.tracesOperation?.value || "").trim();
  const services = model.prefillPairs
    .filter((pair) => !operation || String(pair?.[1] || "") === operation)
    .map((pair) => pair?.[0]);
  replaceSelectOptions(dom.tracesService, services, "All");
}

function updateOperationOptions() {
  const service = String(dom.tracesService?.value || "").trim();
  const operations = model.prefillPairs
    .filter((pair) => !service || String(pair?.[0] || "") === service)
    .map((pair) => pair?.[1]);
  replaceSelectOptions(dom.tracesOperation, operations, "All");
}

function serviceOperationPairExists(service, operation) {
  if (!service || !operation) return true;
  return model.prefillPairs.some((pair) => String(pair?.[0] || "") === service && String(pair?.[1] || "") === operation);
}

function syncServiceOperationPair(preferred = "service") {
  let service = String(dom.tracesService?.value || "").trim();
  let operation = String(dom.tracesOperation?.value || "").trim();
  if (service && operation && !serviceOperationPairExists(service, operation)) {
    if (preferred === "operation") {
      dom.tracesService.value = "";
      service = "";
    } else {
      dom.tracesOperation.value = "";
      operation = "";
    }
  }
  updateServiceOptions();
  updateOperationOptions();
}

function resolvedServiceValues() {
  const value = String(dom.tracesService?.value || "").trim();
  return value ? [value] : [];
}

function resolvedOperationValues() {
  const value = String(dom.tracesOperation?.value || "").trim();
  return value ? [value] : [];
}

function syncFilterFeatures() {
  const f = model.meta?.features || {};
  const bindings = [[dom.tracesService, f.service_filter !== false], [dom.tracesOperation, f.operation_filter !== false], [dom.tracesStatus, f.status_filter !== false]];
  for (const [input, enabled] of bindings) {
    const field = input?.closest?.(".traceSearchField") || input?.closest?.("label");
    if (field) field.hidden = !enabled;
    if (input) input.disabled = !enabled;
  }
  syncRangeControls();
  if (dom.tracesLimit && model.meta) {
    const max = Math.max(1, Number(model.meta.search_limit || 100));
    for (const option of dom.tracesLimit.options) {
      const unavailable = Number(option.value) > max;
      option.disabled = unavailable;
      option.hidden = unavailable;
    }
    const enabled = Array.from(dom.tracesLimit.options).filter((option) => !option.disabled && !option.hidden);
    if (!enabled.some((option) => option.value === dom.tracesLimit.value) && enabled.length) {
      dom.tracesLimit.value = enabled[enabled.length - 1].value;
    }
    dom.tracesLimit.dispatchEvent(new Event("tracepicker-refresh"));
  }
  const tagEnabled = model.meta?.tag_search_supported !== false;
  if (dom.tracesTagKey) dom.tracesTagKey.disabled = !tagEnabled;
  if (dom.tracesTagValue) dom.tracesTagValue.disabled = !tagEnabled;
  const tagOp = byId("tracesTagOp");
  if (tagOp) tagOp.disabled = !tagEnabled;
  renderAnalytics();
}

function unpackSearch(payload) {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  palette.registerServices(services);
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  model.traces = rows.map((row) => ({
    trace_id: String(row?.[0] || ""),
    start_ms: Number(row?.[1] || 0),
    root_operation: String(row?.[2] || ""),
    root_service: services[Number(row?.[3] || 0)] || "unknown",
    duration_ns: Number(row?.[4] || 0),
    span_count: Number(row?.[5] || 0),
    error_count: Number(row?.[6] || 0),
    service_stats: orderByFirstSpan((Array.isArray(row?.[7]) ? row[7] : []).map((stat) => ({ service: services[Number(stat?.[0] || 0)] || "unknown", spans: Number(stat?.[1] || 0), errors: Number(stat?.[2] || 0), first_span_ns: Number(stat?.[3] || 0) }))),
    // Parent span ids no listed span carries (0 from older servers).
    missing_parents: Number(row?.[8] || 0),
  }));
}

async function loadMeta() {
  try {
    const meta = await api.getTracesMeta(currentHost());
    model.meta = meta;
    traceTabs.onMeta(meta);
    if (meta && meta.schema_ok === false) showError(`Trace table ${meta.database}.${meta.table} is missing one or more required OpenTelemetry columns.`);
    else showError("");
    syncFilterFeatures();
    return meta;
  } catch (error) {
    showError(error, () => { void reloadForHost(); });
    throw error;
  }
}

function currentTag() {
  const key = String(dom.tracesTagKey?.value || "").trim();
  const value = String(dom.tracesTagValue?.value || "");
  return { scope: key ? "any" : "", key, value };
}

// The Tag / Value inputs feed the filter chips (app_trace_search.js); the
// chips become tag / tag_not / tag_exists / tag_missing and
// service_not / operation_not / status_not parameters.
function searchFilters() {
  const range = selectedRange();
  const services = resolvedServiceValues();
  const operations = resolvedOperationValues();
  // A tag-filtered prefill lists only the pairs seen with those attributes,
  // and an estimated or truncated one is a subset: only a complete list
  // can rule a pair out.
  if (services.length && operations.length && model.prefillComplete && !serviceOperationPairExists(services[0], operations[0])) {
    throw new Error("Selected service / operation combination does not exist in this time range.");
  }
  return {
    ...range,
    service: services,
    operation: operations,
    status: String(dom.tracesStatus?.value || ""),
    limit: String(dom.tracesLimit?.value || Math.min(50, Number(model.meta?.search_limit || 50))),
    ...(traceSearch.chipParams() || {}),
  };
}

function invalidateDiscovery({ pairs = true } = {}) {
  if (pairs) {
    model.prefillPairs = [];
    // The list is gone, so it is not complete any more: a failed prefill must not leave "complete" behind and make a
    // search for a service / operation pair fail with a false "does not exist".
    model.prefillComplete = false;
    replaceSelectOptions(dom.tracesService, [], "All");
    replaceSelectOptions(dom.tracesOperation, [], "All");
  }
}

async function prefill({ force = false } = {}) {
  if (!model.meta) await loadMeta().catch(() => null);
  if (!force && model.prefillPromise) return model.prefillPromise;
  const req = obsView.read("traces.prefill");
  const run = (async () => {
    showError("");
    try {
      const range = selectedRange();
      // Tag chips narrow the service / operation lists to the pairs seen
      // with those attributes.
      const tags = traceSearch.prefillTagParams() || {};
      traceSearch.notePrefillTags(tags);
      const payload = await api.prefillTraces(currentHost(), { ...range, ...tags }, { signal: req.signal });
      if (!req.isCurrent()) return;
      model.prefillComplete = payload?.tag_filtered !== true && payload?.estimated !== true && payload?.truncated !== true;
      model.prefillPairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
      updateServiceOptions();
      updateOperationOptions();
      if (payload?.truncated) showError("Service / operation prefill reached its 20,000-combination safety limit. Use a narrower service / operation filter if the desired value is outside the discovered combinations.");
    } catch (error) {
      if (req.isCurrent()) showError(error, () => { void prefill({ force: true }); });
    }
  })();
  model.prefillPromise = run;
  try {
    await run;
  } finally {
    if (model.prefillPromise === run) model.prefillPromise = null;
  }
}

async function prefillForSelectedRange() {
  invalidateDiscovery();
  try { selectedRange(); } catch (_) { return; }
  await prefill({ force: true });
}

async function ensurePrefillForFilters() {
  if (!model.prefillPairs.length) await prefill();
}

function formatCustomRangeLabel() {
  return timeRange ? timeRange.describeRange(model.timeRange).text : "Last 1 hour";
}

// The hidden native select mirrors the applied range for assistive tech;
// the picker writes the button label.
function refreshCustomRangeLabel() {
  const option = dom.tracesRangeUnit?.options?.[0];
  if (option) option.textContent = formatCustomRangeLabel();
  timePicker?.refresh();
}

function closeCustomRangeEditor() {
  timePicker?.close();
}

// Applying a range (form, calendar, quick or recent range, shift / zoom)
// reloads the service / operation choices, then searches that window.
// Shift and zoom keep the panel open so they can be repeated.
async function applyCustomRange(raw, source = "form") {
  model.rangeNotice = "";
  showError("");
  model.timeRange = { from: String(raw?.from || ""), to: String(raw?.to || "") };
  model.timeRangeTouched = true;
  refreshCustomRangeLabel();
  if (source !== "shift" && source !== "zoom") closeCustomRangeEditor();
  try {
    await prefillForSelectedRange();
    await search();
  } catch (error) {
    showError(util.errorText(error));
  }
}

async function loadAnalytics(filters) {
  if (model.meta?.analytics_enabled !== true) {
    model.analytics = null;
    model.analyticsLoading = false;
    model.analyticsError = "";
    model.durationsError = "";
    renderAnalytics();
    return;
  }
  // The charts of this search: its counts, then its durations (a new
  // search or host cancels both, and the separate durations load).
  const req = obsView.read("traces.analytics");
  util.latest.cancel("traces.durations");
  model.analytics = null;
  model.analyticsLoading = true;
  model.analyticsError = "";
  model.durationsError = "";
  renderAnalytics();
  // Buckets start at local midnight (3 h buckets at 00:00, 03:00... local).
  const analyticsFilters = { ...filters, bucket_origin_ms: String(timeRange.localMidnight(Number(filters.start_ms))) };
  delete analyticsFilters.limit;
  model.analyticsFilters = analyticsFilters;
  // The heatmap mode loads its own answer instead of the percentiles.
  traceHeatmap.onSearch(analyticsFilters);
  const message = (error) => util.errorText(error);
  // Counts first: without filters the server reads them from the trace
  // index (well under a second for 7 days), while the duration percentiles
  // need the span aggregation, which takes seconds on multi-day windows.
  // With filters the first answer already carries both charts.
  let countsError = "";
  try {
    const counted = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "counts" }, { signal: req.signal });
    if (!req.isCurrent()) return;
    model.analytics = unpackAnalytics(counted);
    if (!model.analytics.has_durations) renderAnalytics();
  } catch (error) {
    if (!req.isCurrent()) return;
    // The durations answer below carries the counts too.
    countsError = message(error);
  }
  try {
    if (model.analytics?.has_durations || traceHeatmap.active()) {
      // The heatmap mode reads no durations: a counts chart that failed says so instead of an empty card.
      if (!model.analytics && countsError) model.analyticsError = countsError;
      return;
    }
    const full = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "durations" }, { signal: req.signal });
    if (!req.isCurrent()) return;
    // Span counts replace the index counts: both charts then describe
    // exactly the same traces.
    model.analytics = unpackAnalytics(full, model.analytics);
  } catch (error) {
    if (!req.isCurrent()) return;
    if (model.analytics) model.durationsError = message(error);
    else model.analyticsError = countsError || message(error);
  } finally {
    if (req.isCurrent()) {
      model.analyticsLoading = false;
      renderAnalytics();
    }
  }
}

// The percentiles of the current search, when the heatmap mode skipped
// them and the Percentiles mode is shown again.
async function loadDurations() {
  const filters = model.analyticsFilters;
  if (!filters || model.analytics?.has_durations || model.meta?.analytics_enabled !== true) { renderAnalytics(); return; }
  const req = obsView.read("traces.durations");
  model.durationsError = "";
  renderAnalytics();
  try {
    const full = await api.getTraceAnalytics(currentHost(), { ...filters, charts: "durations" }, { signal: req.signal });
    if (!req.isCurrent()) return;
    model.analytics = unpackAnalytics(full, model.analytics);
  } catch (error) {
    if (!req.isCurrent()) return;
    model.durationsError = util.errorText(error);
  }
  renderAnalytics();
}

// url: "push" (a new search: its own history entry), "replace" (the
// page-load search) or "none" (restored from history, the URL is already
// this search).
async function search({ url = "push" } = {}) {
  if (!model.meta) await loadMeta().catch(() => null);
  const searchState = traceSearch;
  try {
    searchState?.commitPendingTag?.();
  } catch (error) {
    showError(util.errorText(error));
    return;
  }
  if (searchState?.prefillTagsChanged?.() && model.prefillPairs.length) {
    // New tag chips narrow the pickers; the current choices stay selected.
    for (const select of [dom.tracesService, dom.tracesOperation]) if (select?.value) select.dataset.wanted = select.value;
    void prefill({ force: true });
  }
  await ensurePrefillForFilters();
  // This search supersedes the previous one and its charts.
  const req = obsView.read("traces.search");
  util.latest.cancel("traces.analytics");
  util.latest.cancel("traces.durations");
  let filters;
  try {
    filters = searchFilters();
  } catch (error) {
    showError(util.errorText(error));
    return;
  }
  address.write(url);
  // Another tab (app_trace_tabs.js, e.g. the service map) runs its own
  // search; the result list searches again when its tab comes back.
  const tabSearch = traceTabs.activeSearch();
  if (tabSearch) {
    model.lastSearchKey = "";
    setView(false);
    uiState.busy(dom.tracesSearchButton, false);
    showError("");
    tabSearch(filters, { force: url === "push" });
    return;
  }
  model.lastSearchKey = searchState?.searchKey?.() || "";
  setView(false);
  uiState.busy(dom.tracesSearchButton, true);
  showError("");
  // The charts load right after the list: say so instead of going blank.
  model.analytics = null;
  model.analyticsLoading = model.meta?.analytics_enabled === true;
  model.analyticsError = "";
  model.durationsError = "";
  renderAnalytics();
  try {
    if (traceSpans.active()) {
      // One row per span; the span table reports its own errors.
      await traceSpans.search(filters);
      if (!req.isCurrent()) return;
      model.searched = true;
      model.lastSearchRange = { start_ms: Number(filters.start_ms), end_ms: Number(filters.end_ms) };
      void loadAnalytics(filters);
      searchState?.onSearched?.(filters);
      return;
    }
    const requested = performance.now();
    const payload = await api.searchTraces(currentHost(), filters, { signal: req.signal });
    if (!req.isCurrent()) return;
    model.searchLatencyMs = performance.now() - requested;
    model.searched = true;
    model.lastSearchRange = { start_ms: Number(filters.start_ms), end_ms: Number(filters.end_ms) };
    unpackSearch(payload);
    renderResults();
    // Search results are intentionally delivered first. Heavy graph analytics
    // starts only after the trace list has rendered, on its own API route.
    void loadAnalytics(filters);
    searchState?.onSearched?.(filters);
  } catch (error) {
    if (!req.isCurrent()) return;
    model.traces = [];
    model.searched = false;
    model.analytics = null;
    model.analyticsLoading = false;
    renderResults();
    showError(error, () => { void search({ url: "none" }); });
  } finally {
    if (req.isCurrent()) uiState.busy(dom.tracesSearchButton, false);
  }
}

// The search opens a trace as the page of that trace; the search page stays in the history entry before it.
function openTrace(traceId) {
  const id = String(traceId || "").trim();
  if (!id) return;
  const pendingSpanId = model.pendingSpanId;
  model.pendingSpanId = "";
  window.location.assign(spanTraceUrl(id, pendingSpanId));
}

// The search view shows again with the entry's own search state: the
// listed results may belong to another search (a shared link, or Back /
// Forward across searches).
function restoreSearch() {
  traceSearch.closeMenu();
  const key = traceSearch.searchKey() || "";
  const listed = traceSpans.active() ? traceSpans.hasResults() : model.traces.length > 0;
  if (!listed || !model.searched || key !== (model.lastSearchKey || "")) search({ url: "none" });
  else traceSpans.onShown();
}

// The cycle of the view with its host (app_obs_view.js): a change of host empties the model and stops everything of the old host
// (the search, the spans, the services, the map, the heatmap and the facets of the Traces page all use a slot of "traces.":
// ARCH-F-140), then loads for the new host.
const hostCycle = obsView.hostCycle({
  feature: "traces",
  cancel: ["traces.", "facets."],
  loaded: () => !!model.meta,
  reset: resetForHost,
  load: loadForHost,
});
const reloadForHost = () => hostCycle.reload();

function resetForHost() {
  model.meta = null;
  model.traces = [];
  model.searched = false;
  model.analytics = null;
  model.analyticsLoading = false;
  model.analyticsError = "";
  model.prefillPairs = [];
  model.prefillPromise = null;
  model.prefillComplete = false;
  model.activeTrace = null;
  model.activeSpanId = null;
  traceSearch.resetFacets();
  renderResults();
}

async function loadForHost(stale) {
  // A second host change starts its own reload: this one stops at the next step instead of searching for the new host
  // a second time.
  try {
    await loadMeta();
    if (stale()) return;
    await prefill();
    if (stale()) return;
    await search({ url: "replace" });
  } catch (_) {}
}

// Back / Forward, or the Observability page showing this view again: the URL is the state. Every entry carries its search state:
// restore it first.
function onLocation() {
  traceSearch.applyLocation();
  restoreSearch();
}

// Shared with the other Observability views: the time range and the service.
function getContext() {
  return { range: { ...model.timeRange }, service: String(dom.tracesService?.value || "") };
}

function applyContext(params, context) {
  if (context.range) timeRange.url.write(params, context.range);
  if (context.service != null && context.service !== (params.get("service") || "")) {
    // An operation belongs to the service it was picked for.
    params.delete("operation");
    if (context.service) params.set("service", context.service);
    else params.delete("service");
  }
}

// The functions that the modules under this view call: the store carries them (app_trace_store.js, `actions`).
Object.assign(actions, {
  search: (options) => search(options),
  loadTrace: (id) => openTrace(id),
  applyRange: (raw, source) => applyCustomRange(raw, source),
  loadDurations: () => loadDurations(),
  syncRange: () => syncRangeControls(),
  refreshOptions: () => { updateServiceOptions(); updateOperationOptions(); },
  syncServiceOperationPair: (which) => syncServiceOperationPair(which),
  setResultsView: (view, options) => setResultsView(view, options),
  searchContext: () => traceSearch.contextQuery(),
  currentTag: () => currentTag(),
  // The result list tab is shown again: search when it is stale.
  showSearch: () => {
    const key = traceSearch.searchKey() || "";
    if (!model.searched || key !== (model.lastSearchKey || "")) search({ url: "none" });
    else traceSpans.onTabShown();
  },
});

function init() {
  model.resultsView = readStored(RESULTS_VIEW_KEY, ["list", "table"], "list");
  model.startDisplay = readStored(START_DISPLAY_KEY, ["absolute", "relative"], "absolute");
  initTracePickers();
  traceSpans.init();
  traceSearch.init();
  traceHeatmap.init();
  traceTabs.init();
  // Search state from the URL (a shared link, a reload).
  traceSearch.applyLocation({ initial: true });
  dom.tracesForm?.addEventListener("submit", (event) => { event.preventDefault(); search(); });
  trackSearchBarHeight();
  dom.tracesSort?.addEventListener("change", () => {
    renderResults();
    if (!traceIdFromPath()) address.replace();
  });
  dom.tracesService?.addEventListener("change", () => { syncServiceOperationPair("service"); });
  dom.tracesOperation?.addEventListener("change", () => { syncServiceOperationPair("operation"); });
  dom.tracesSearchView?.addEventListener("click", (event) => {
    const retry = event.target instanceof Element ? event.target.closest("[data-chart-retry]")?.getAttribute("data-chart-retry") : "";
    if (retry === "durations") void loadDurations();
    else if (retry === "analytics" && model.analyticsFilters) void loadAnalytics(model.analyticsFilters);
  });
  setView(false);
  hostCycle.start();
}

// renderAnalytics (redraw the charts from the model) and scatterDots (the scatter as drawn) are test and benchmark hooks.
export const traces = { init, onLocation, getContext, applyContext, search, loadTrace: openTrace, renderAnalytics, scatterDots };
