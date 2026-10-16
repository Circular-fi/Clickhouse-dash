// This view shows the page of one trace (trace.html, /observability/traces/<trace id>).
// The file app_page_trace.js starts this view. The view loads the trace.
// It draws the header, the waterfall and the views. It follows Back / Forward and a host change.
// The search of the Traces page is another view (app_traces.js).
// The two views share the model, the address and the helpers of app_trace_store.js. They do not share their modules (ARCH-F-157).

import { api } from "./app_api.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { obsView } from "./app_obs_view.js";
import { palette } from "./app_palette.js";
import { traceInsights } from "./app_trace_insights.js";
import { initSpanDetailEvents } from "./app_trace_inspector.js";
import { traceLogs } from "./app_trace_logs.js";
import { markOpenedFromSearch, onUnavailableClick, returnToSearch } from "./app_trace_nav.js";
import { traceSearch } from "./app_trace_search.js";
import { actions, address, currentHost, model, parts, setView, showError, spanTraceUrl, traceIdFromPath, trackSearchBarHeight } from "./app_trace_store.js";
import { traceViews } from "./app_trace_views.js";
import { initWaterfall, renderTraceHeader, renderWaterfall } from "./app_trace_waterfall.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const fmt = format;

// The trace page gives its modules to the waterfall and the inspector.
// These modules are the views, the logs and the insights. Only the trace page has them.
// The waterfall and the inspector call these modules at the points that they extend.
Object.assign(parts, { traceViews, traceLogs, traceInsights });

async function loadMeta() {
  try {
    const meta = await api.getTracesMeta(currentHost());
    model.meta = meta;
    if (meta && meta.schema_ok === false) showError(`Trace table ${meta.database}.${meta.table} is missing one or more required OpenTelemetry columns.`);
    else showError("");
    return meta;
  } catch (error) {
    showError(error, () => { void reloadForHost(); });
    throw error;
  }
}

function renderInspector() {
  if (!dom.traceInspector) return;
  dom.traceInspector.hidden = true;
  dom.traceInspector.replaceChildren();
}

function renderTrace() {
  renderTraceHeader();
  renderWaterfall();
  renderInspector();
  traceViews.render();
}

async function loadTrace(traceId, { push = false } = {}) {
  const id = String(traceId || "").trim();
  if (!id) return;
  const pendingSpanId = model.pendingSpanId;
  model.pendingSpanId = "";
  const req = obsView.read("traces.detail");
  model.traceError = null;
  showError("");
  setView(true);
  dom.traceDetail?.classList.remove("is-unavailable");
  if (dom.traceWaterfall) uiState.loading(dom.traceWaterfall, { label: "Loading trace\u2026" });
  if (dom.traceInspector) { dom.traceInspector.hidden = true; dom.traceInspector.replaceChildren(); }
  void traceLogs.load(null);
  // The entry is pushed when the answer is in. The search stays the current
  // entry during the load. This applies whether the trace was found or not.
  const pushEntry = () => {
    if (push) address.push(null, { href: spanTraceUrl(id, pendingSpanId), state: traceViews.detailEntryState({ traceId: id }) });
  };
  try {
    const trace = await api.getTrace(currentHost(), id, { signal: req.signal });
    if (!req.isCurrent()) return;
    model.activeTrace = trace;
    model.activeSpanId = null;
    model.focusedSpanId = "";
    model.openSpanIds.clear();
    model.spanSections.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    palette.registerServices((trace?.spans || []).map((span) => span.service_name));
    pushEntry();
    renderTrace();
    traceViews.applyLocation();
    uiState.announce(`Trace loaded: ${fmt.countLabel((trace?.spans || []).length, "span")}.`);
    // Logs load after the trace is on screen, never before.
    void traceLogs.load(trace);
  } catch (error) {
    if (!req.isCurrent()) return;
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    // The detail pane says what happened (unavailableHtml), not the strip.
    model.traceError = { id, code: String(error?.code || ""), text: util.errorText(error) };
    pushEntry();
    renderTrace();
    traceViews.applyLocation();
  }
}

// The cycle of the page with its host (app_obs_view.js). The model is emptied. Then the trace of the address is read again.
const hostCycle = obsView.hostCycle({
  feature: "traces",
  loaded: () => !!model.meta,
  reset: () => { model.meta = null; },
  load: async () => {
    try {
      await loadMeta();
      const id = traceIdFromPath();
      if (id) await loadTrace(id, { push: false });
    } catch (_) {}
  },
});
const reloadForHost = () => hostCycle.reload();

// Back / Forward within the trace page. The address changes to another ?span= or ?view=.
// It can also change to a linked trace that opens in place.
function onLocation() {
  const id = traceIdFromPath();
  if (id && id === String(model.activeTrace?.trace_id || "")) traceViews.applyLocation();
  else if (id) void loadTrace(id, { push: false });
}

function init() {
  markOpenedFromSearch();
  actions.loadTrace = loadTrace;
  actions.searchContext = () => traceSearch.contextQuery();
  initWaterfall();
  initSpanDetailEvents();
  traceLogs.init();
  traceViews.init();
  traceInsights.init();
  // A filter picked on a value of the trace opens the search with it (the module's detail mode).
  traceSearch.init();
  trackSearchBarHeight();
  dom.traceBackButton?.addEventListener("click", () => returnToSearch());
  dom.traceDetail?.addEventListener("click", onUnavailableClick);
  setView(true);
  hostCycle.start();
}

export const traceDetail = { init, onLocation, loadTrace };
