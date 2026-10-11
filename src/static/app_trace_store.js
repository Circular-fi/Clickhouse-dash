// What the modules of the Traces search and of the trace page share (ARCH-F-155): the model, the address, the host, the strip of
// errors, a trace's cache. It holds no view. The functions that the view of the page provides to the modules under it
// (search, open a trace, the range) are in `actions`: they cannot be imported, the view imports the modules.

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

// One trace is a page of its own (trace.html, app_page_trace.js); the
// Traces view of observability.html is the search. They share this module:
// the search opens a trace by navigating to its page, and the trace page
// returns by navigating back (returnToSearch).
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
  // Deep link (?span=): the span to focus once its trace is loaded, and the
  // highlighted span.
  pendingSpanId: "",
  // The open trace could not be loaded: { id, code, text } (unavailableHtml).
  traceError: null,
  focusedSpanId: "",
  openSpanIds: new Set(),
  // Inspector sections a span has open (Jaeger's DetailState), so that a
  // waterfall re-render keeps them: span id -> Set of section keys.
  spanSections: new Map(),
  waterfallLabelPct: 34,
  // Shown in the error banner while no error is: the applied range was shortened to the server's maximum.
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
// trace page (app_page_trace.js): /observability/traces is the search and
// /observability/traces/<traceId> a trace, written through the Traces owner
// of ns.router (the search page's address is app_trace_search.js's; a
// trace's own writes pass its href), only while the view shows.
const SEARCH_ROUTE = "/observability/traces";
const address = router.owner("traces");

function serviceEnabled(service) {
  return !model.disabledServices.has(String(service || "unknown"));
}

const currentHost = obsView.currentHost;

// The error strip above the view (ns.uiState.banner): a sentence
// (app_obs_page.js strips the API's error codes) and, when the failed
// step can run again, Retry.
// The banner holds an error; with none, the notice that the range was shortened (model.rangeNotice), an
// info banner that stays until another range is applied.
function showError(message, retry = null) {
  if (!message && model.rangeNotice) uiState.banner(dom.tracesError, { message: model.rangeNotice, level: "info" });
  else uiState.banner(dom.tracesError, { message, retry });
}

// The search bar's height as --trace-search-h on the root element, in px (it
// wraps to 2 or more rows on narrower windows): the drawers of the Search
// and Services tabs open under it and the facets sidebar sticks under it,
// below --shell-top (app_dom.js).
function trackSearchBarHeight() {
  const bar = dom.tracesForm;
  if (!bar) return;
  const root = document.documentElement;
  const update = () => {
    // A hidden bar (the trace detail) keeps the last height.
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
  // An open trace names the tab after itself (renderTraceHeader).
  if (!detail) document.title = TRACES_PAGE_TITLE;
}

// The search bar, results and view pickers are ns.menu.select pickers
// (app_ui_menu.js): a hidden native <select> holds the value, the button
// reads "<label> \u00b7 <option>".
function enhanceTraceSelect(select) {
  return menu?.select(select) || null;
}

function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

// The shared copy (copy.text): the clipboard (a textarea copy on plain
// http) and the one "Copied" feedback on the control.
function copyText(text, button) {
  return copy.text(text, button);
}

// Everything derived from the loaded trace alone (tree, tree order, bounds,
// per-service stats, parsed event markers and attribute decorations, the
// critical path) is computed once per trace. The waterfall re-renders on
// every toggle, service filter and range change; rebuilding the tree and
// re-parsing each span's JSON on every render dominated those interactions.
let traceCache = null;

// The cache of the open trace: built when another trace opens.
function activeTraceCache() {
  const trace = model.activeTrace;
  if (traceCache && traceCache.trace === trace) return traceCache;
  traceCache = createTraceCache(trace);
  return traceCache;
}

// Trace URLs carry the search context (range, filters, view) after the
// span, so "back to search" and shared links return to the same search.
function spanTraceUrl(traceId, spanId = "") {
  const params = new URLSearchParams(actions.searchContext?.() || "");
  const query = `${spanId ? `span=${encodeURIComponent(spanId)}` : ""}${spanId && params.toString() ? "&" : ""}${params.toString()}`;
  return `${route(`${SEARCH_ROUTE}/${encodeURIComponent(traceId)}`)}${query ? `?${query}` : ""}`;
}

// What the view of the page provides to the modules under it: they cannot import it, it imports them. Each is set once, when
// the module that owns it loads. A call before that is a bug that shows at once (a TypeError), not a silent no-op.
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

// The collaborators that only some pages have, handed over by the view of the page (the module rule: use()). The search page
// has the spans, the heatmap and the tabs; the trace page has its views, its logs and its insights.
const parts = { traceSpans: null, traceHeatmap: null, traceTabs: null, traceViews: null, traceLogs: null, traceInsights: null };

export { DETAIL_PAGE, SEARCH_ROUTE, TRACES_PAGE_TITLE, actions, activeTraceCache, address, copyText, currentHost, enhanceTraceSelect, esc, maxRangeMinutes, model, parts, route, serviceEnabled, setView, showError, spanTraceUrl, traceIdFromPath, trackSearchBarHeight };
