// This module holds what the modules of the Traces search and of the trace page share (ARCH-F-155).
// It holds the model, the address, the host, the strip of errors and the cache of a trace.
// It holds no view.
//
// The view of the page gives functions to the modules under it.
// These functions are search, open a trace and the range. They are in `actions`.
// The modules cannot import the view. The view imports the modules.

import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { obsView } from "./app_obs_view.js";
import { router } from "./app_router.js";
import { createTraceCache } from "./app_trace_model.js";
import { copy } from "./app_ui_copy.js";
import { menu } from "./app_ui_menu.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;
const fmt = format;

// A trace has a page of its own (trace.html, app_page_trace.js).
// The Traces view of observability.html is the search.
// Both use this module.
// The search opens a trace by navigation to its page. The trace page returns to the search with a Back navigation (returnToSearch).
const DETAIL_PAGE = document.body?.dataset?.page === "trace";
const TRACES_PAGE_TITLE = DETAIL_PAGE ? "ClickHouse Dash \u00b7 Trace" : "ClickHouse Dash \u00b7 Traces";

const model = {
  meta: null,
  traces: [],
  analytics: null,
  analyticsLoading: false,
  analyticsError: "",
  durationsError: "",
  prefillPairs: [],
  prefillPromise: null,
  activeTrace: null,
  activeSpanId: null,
  // Deep link (?span=): the span to focus after its trace loads.
  // This is also the highlighted span.
  pendingSpanId: "",
  // The open trace did not load. The value has the form { id, code, text } (unavailableHtml).
  traceError: null,
  focusedSpanId: "",
  openSpanIds: new Set(),
  // The inspector sections that a span has open (Jaeger's DetailState).
  // A waterfall re-render keeps these sections open: span id -> Set of section keys.
  spanSections: new Map(),
  waterfallLabelPct: 34,
  // Shown in the error banner when there is no error. The applied range was shortened to the server's maximum.
  rangeNotice: "",
  traceViewRange: [0, 1],
  disabledServices: new Set(),
  collapsed: new Set(),
  criticalPathShown: true,
  timeRange: { from: "now-1h", to: "now" },
  timeRangeTouched: false,
  searched: false,
  searchLatencyMs: NaN,
  lastSearchRange: null,
  resultsView: "list",
  tableSort: null,
  startDisplay: "absolute",
};

const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
const route = (path) => router.url(String(path || ""));
// The Traces view of the Observability page (app_obs_page.js) and the
// trace page (app_page_trace.js) both use the addresses of ns.router.
// /observability/traces is the search. /observability/traces/<traceId> is a trace.
// The Traces owner of ns.router writes these addresses, and only while the view shows.
// The address of the search page belongs to app_trace_search.js.
// A write of a trace passes the href of that trace.
const SEARCH_ROUTE = "/observability/traces";
const address = router.owner("traces");

function serviceEnabled(service) {
  return !model.disabledServices.has(String(service || "unknown"));
}

const currentHost = obsView.currentHost;

// The error strip above the view (ns.uiState.banner) shows a sentence.
// app_obs_page.js removes the error codes of the API from this sentence.
// If the failed step can run again, the strip shows Retry.
//
// The banner holds an error. If there is no error, the banner shows the notice that the range was shortened (model.rangeNotice).
// This notice is an info banner. It stays until another range is applied.
function showError(message, retry = null) {
  if (!message && model.rangeNotice) uiState.banner(dom.tracesError, { message: model.rangeNotice, level: "info" });
  else uiState.banner(dom.tracesError, { message, retry });
}

// The height of the search bar is set as --trace-search-h on the root element, in px.
// On narrow windows, the search bar wraps to two or more rows.
// The drawers of the Search and Services tabs open under the search bar.
// The facets sidebar sticks under the search bar, below --shell-top (app_dom.js).
function trackSearchBarHeight() {
  const bar = dom.tracesForm;
  if (!bar) return;
  const root = document.documentElement;
  const update = () => {
    // A hidden bar (the trace detail) keeps its last height.
    const height = bar.offsetHeight;
    if (height > 0) root.style.setProperty("--trace-search-h", `${height}px`);
  };
  update();
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(bar);
}

function traceIdFromPath() {
  const pathname = decodeURIComponent(String(window.location.pathname || ""));
  const match = pathname.match(/\/observability\/traces\/([^/]+)\/?$/);
  return match ? match[1] : "";
}

function setView(detail) {
  if (dom.tracesSearchView) dom.tracesSearchView.hidden = !!detail;
  if (dom.traceDetail) dom.traceDetail.hidden = !detail;
  document.body.classList.toggle("is-trace-detail", !!detail);
  // An open trace sets the name of the tab (renderTraceHeader).
  if (!detail) document.title = TRACES_PAGE_TITLE;
}

// The search bar, the results and the view pickers are ns.menu.select pickers (app_ui_menu.js).
// A hidden native <select> holds the value. The button reads "<label> · <option>".
function enhanceTraceSelect(select) {
  return menu?.select(select) || null;
}

function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

// The shared copy function is copy.text. It uses the clipboard.
// On plain http, it copies through a textarea.
// The control shows one "Copied" feedback.
function copyText(text, button) {
  return copy.text(text, button);
}

// The module computes once per trace all data that comes from the loaded trace only.
// This data is the tree, the tree order, the bounds, the stats per service, the parsed event markers, the attribute decorations and the critical path.
//
// The waterfall renders again on every toggle, service filter and range change.
// Each render rebuilt the tree and read the JSON of each span. This was the main cost of these actions.
let traceCache = null;

// The cache of the open trace. The cache is built when another trace opens.
function activeTraceCache() {
  const trace = model.activeTrace;
  if (traceCache && traceCache.trace === trace) return traceCache;
  traceCache = createTraceCache(trace);
  return traceCache;
}

// Trace URLs carry the search context (range, filters and view) after the span.
// The "back to search" link and shared links return to the same search.
function spanTraceUrl(traceId, spanId = "") {
  const params = new URLSearchParams(actions.searchContext?.() || "");
  const query = `${spanId ? `span=${encodeURIComponent(spanId)}` : ""}${spanId && params.toString() ? "&" : ""}${params.toString()}`;
  return `${route(`${SEARCH_ROUTE}/${encodeURIComponent(traceId)}`)}${query ? `?${query}` : ""}`;
}

// The view of the page gives these functions to the modules under it. The modules cannot import the view. The view imports the modules.
// Each function is set once, when the module that owns it loads. A call before that is a bug. It shows at once as a TypeError, not as a silent no-op.
//   search(options)            run the search                    loadTrace(id, options)  open a trace (the search page navigates)
//   applyRange(raw, source)    apply a time range                loadDurations()         read the durations chart again
//   syncRange()                the range controls show the model refreshOptions()        the service / operation menus show the model
//   syncServiceOperationPair(which)  keep the pair consistent    setResultsView(view, options)  list or table
//   searchContext()            the search state as a query string (a trace's address carries it)
//   focusSpan(id, options)     scroll to a span of the waterfall and select it
//   currentTag()               the tag key and value typed in the search bar   showSearch()  the result list tab is shown again
const actions = {
  search: null, loadTrace: null, applyRange: null, loadDurations: null, syncRange: null, refreshOptions: null,
  syncServiceOperationPair: null, setResultsView: null, searchContext: null, focusSpan: null, currentTag: null, showSearch: null,
};

// Some pages have collaborators that the other pages do not have. The view of the page hands them over (the module rule: use()).
// The search page has the spans, the heatmap and the tabs.
// The trace page has its views, its logs and its insights.
const parts = { traceSpans: null, traceHeatmap: null, traceTabs: null, traceViews: null, traceLogs: null, traceInsights: null };

export { DETAIL_PAGE, SEARCH_ROUTE, TRACES_PAGE_TITLE, actions, activeTraceCache, address, copyText, currentHost, enhanceTraceSelect, esc, maxRangeMinutes, model, parts, route, serviceEnabled, setView, showError, spanTraceUrl, traceIdFromPath, trackSearchBarHeight };
