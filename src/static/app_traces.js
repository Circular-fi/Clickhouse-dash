// This is the Traces search (traces.html, /observability/traces). The app_page_traces.js file starts this view.
// The view runs the search and applies the range. It loads the durations and the analytics.
// It also starts the modules of the search page: the results, the charts, the heatmap, the Spans mode, and the tabs.
// A trace is another page (app_trace_detail.js). The search opens it by navigation.
// The two views share the model, the address, and the helpers of app_trace_store.js.
// The functions that this view gives to the modules under it are in its `actions` (ARCH-F-155).

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

// The result list gives the Spans mode its place in the list.
// The results and the spans import each other's work. The spans go to the results from here.
parts.traceSpans = traceSpans;

function initTracePickers() {
  initTimeRangePicker();
  // The Logs and Metrics views have the same look for the search bar. This view has only its own selects.
  $$("#tracesWorkspace .traceSearchBar select, #tracesWorkspace .traceResultsSort select").forEach((select) => {
    if (select !== dom.tracesRangeUnit || !timePicker) enhanceTraceSelect(select);
  });
}

let timePicker = null;

// The Grafana-style time range panel is built by app_timerange.js.
// The panel is the dropdown of the shipped range picker. It has the same root, the same button, and the same open and close motion.
// Its zoom button joins the dom. The "zoom out" actions of the result views click this button.
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

// Meta sets the default window. It stays in use until the user picks another window.
// Meta also sets the widest window.
// An applied range that is wider than the server accepts changes to the widest quick range that fits.
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
    // Do not change the range silently. A link for 30 days that shows 7 days reads as "no traces".
    if (endMs > startMs) {
      model.rangeNotice = `The range ${fmt.range(requested.from, requested.to)} is longer than the server allows (${tr.formatMinutes(max)}, traces.max_lookback_minutes): showing ${fmt.range(model.timeRange.from, model.timeRange.to)}.`;
      showError("");
    }
  }
  refreshCustomRangeLabel();
}

// Resolve relative ranges ("now-1h") again for each request.
function selectedRange() {
  const { startMs, endMs } = timeRange.resolveBounded(model.timeRange, maxRangeMinutes(), "server setting traces.max_lookback_minutes");
  return { start_ms: Math.round(startMs), end_ms: Math.round(endMs), align_buckets: timeRange.isRelative(model.timeRange) ? "1" : "0" };
}

function replaceSelectOptions(select, values, allLabel) {
  if (!select) return;
  const previous = String(select.value || "");
  // A value that is applied from the URL, or by a filter action (app_trace_search.js), stays selectable.
  // This is true even when the discovered pairs do not list it.
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
    // These are the parent span ids that no listed span has. Older servers send 0.
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

// The Tag and Value inputs feed the filter chips (app_trace_search.js).
// The chips become the parameters tag, tag_not, tag_exists, tag_missing, service_not, operation_not, and status_not.
function searchFilters() {
  const range = selectedRange();
  const services = resolvedServiceValues();
  const operations = resolvedOperationValues();
  // A prefill with a tag filter lists only the pairs seen with those attributes.
  // An estimated or truncated list is a subset. Only a complete list can rule out a pair.
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
    // The list is gone, so it is not complete. A failed prefill must not leave "complete" behind.
    // Otherwise, a search for a service and operation pair fails with a false "does not exist".
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
      // Tag chips narrow the service and operation lists to the pairs seen with those attributes.
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

// The hidden native select shows the applied range to assistive technology. The picker writes the button label.
function refreshCustomRangeLabel() {
  const option = dom.tracesRangeUnit?.options?.[0];
  if (option) option.textContent = formatCustomRangeLabel();
  timePicker?.refresh();
}

function closeCustomRangeEditor() {
  timePicker?.close();
}

// Apply a range (form, calendar, quick or recent range, shift, or zoom). This reloads the service and operation choices.
// Then it searches that window. Shift and zoom keep the panel open, so the user can repeat them.
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
  // The charts of this search show the counts, then the durations.
  // A new search or a new host cancels both charts. The separate durations load after that.
  const req = obsView.read("traces.analytics");
  util.latest.cancel("traces.durations");
  model.analytics = null;
  model.analyticsLoading = true;
  model.analyticsError = "";
  model.durationsError = "";
  renderAnalytics();
  // The buckets start at local midnight. For 3 h buckets, they start at 00:00, 03:00, and so on, in local time.
  const analyticsFilters = { ...filters, bucket_origin_ms: String(timeRange.localMidnight(Number(filters.start_ms))) };
  delete analyticsFilters.limit;
  model.analyticsFilters = analyticsFilters;
  // The heatmap mode loads its own answer. It does not load the percentiles.
  traceHeatmap.onSearch(analyticsFilters);
  const message = (error) => util.errorText(error);
  // Load the counts first. Without filters, the server reads them from the trace index. For 7 days, this takes well under a second.
  // The duration percentiles need the span aggregation. On windows of several days, this takes seconds.
  // With filters, the first answer already has both charts.
  let countsError = "";
  try {
    const counted = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "counts" }, { signal: req.signal });
    if (!req.isCurrent()) return;
    model.analytics = unpackAnalytics(counted);
    if (!model.analytics.has_durations) renderAnalytics();
  } catch (error) {
    if (!req.isCurrent()) return;
    // The durations answer below also has the counts.
    countsError = message(error);
  }
  try {
    if (model.analytics?.has_durations || traceHeatmap.active()) {
      // The heatmap mode reads no durations. A counts chart that fails says so. It does not show an empty card.
      if (!model.analytics && countsError) model.analyticsError = countsError;
      return;
    }
    const full = await api.getTraceAnalytics(currentHost(), { ...analyticsFilters, charts: "durations" }, { signal: req.signal });
    if (!req.isCurrent()) return;
    // Span counts replace the index counts. Then both charts describe the same traces.
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

// These are the percentiles of the current search. The heatmap mode skipped them.
// Use them again when the Percentiles mode is shown.
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

// url: "push" makes a new search with its own history entry.
// url: "replace" is the search on page load.
// url: "none" is for a search restored from history. The URL is already this search.
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
    // New tag chips narrow the pickers. The current choices stay selected.
    for (const select of [dom.tracesService, dom.tracesOperation]) if (select?.value) select.dataset.wanted = select.value;
    void prefill({ force: true });
  }
  await ensurePrefillForFilters();
  // This search replaces the previous search and its charts.
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
  // Another tab (app_trace_tabs.js, for example the service map) runs its own search.
  // The result list searches again when its tab is shown again.
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
  // The charts load right after the list. Show a message, so the charts do not go blank.
  model.analytics = null;
  model.analyticsLoading = model.meta?.analytics_enabled === true;
  model.analyticsError = "";
  model.durationsError = "";
  renderAnalytics();
  try {
    if (traceSpans.active()) {
      // Each span has one row. The span table reports its own errors.
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
    // Send the search results first, on purpose.
    // Heavy graph analytics start only after the trace list is rendered. They use their own API route.
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

// The search opens a trace as the page of that trace. The search page stays in the history entry before it.
function openTrace(traceId) {
  const id = String(traceId || "").trim();
  if (!id) return;
  const pendingSpanId = model.pendingSpanId;
  model.pendingSpanId = "";
  window.location.assign(spanTraceUrl(id, pendingSpanId));
}

// The search view shows again with the search state of the entry.
// The listed results can belong to another search. This happens with a shared link, or with Back and Forward across searches.
function restoreSearch() {
  traceSearch.closeMenu();
  const key = traceSearch.searchKey() || "";
  const listed = traceSpans.active() ? traceSpans.hasResults() : model.traces.length > 0;
  if (!listed || !model.searched || key !== (model.lastSearchKey || "")) search({ url: "none" });
  else traceSpans.onShown();
}

// This is the cycle of the view with its host (app_obs_view.js).
// A change of host empties the model. It stops all work of the old host.
// The search, the spans, the services, the map, the heatmap, and the facets of the Traces page all use a slot of "traces." (ARCH-F-140).
// Then it loads the data for the new host.
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
  // A second host change starts its own reload. This reload stops at the next step.
  // It does not search for the new host a second time.
  try {
    await loadMeta();
    if (stale()) return;
    await prefill();
    if (stale()) return;
    await search({ url: "replace" });
  } catch (_) {}
}

// Use Back or Forward, or show the Observability page again. The URL is the state of the view.
// Every entry has its search state. Restore that state first.
function onLocation() {
  traceSearch.applyLocation();
  restoreSearch();
}

// The other Observability views share this state: the time range and the service.
function getContext() {
  return { range: { ...model.timeRange }, service: String(dom.tracesService?.value || "") };
}

function applyContext(params, context) {
  if (context.range) timeRange.url.write(params, context.range);
  if (context.service != null && context.service !== (params.get("service") || "")) {
    // An operation belongs to the service that was selected for it.
    params.delete("operation");
    if (context.service) params.set("service", context.service);
    else params.delete("service");
  }
}

// The modules under this view call these functions. The store carries them (app_trace_store.js, `actions`).
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
  // The result list tab is shown again. Search again if the results are stale.
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
  // Read the search state from the URL. This applies to a shared link or a reload.
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

// renderAnalytics redraws the charts from the model. scatterDots gives the scatter as drawn.
// These are test and benchmark hooks.
export const traces = { init, onLocation, getContext, applyContext, search, loadTrace: openTrace, renderAnalytics, scatterDots };
