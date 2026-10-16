// This module handles the moves between the search and a trace.
// The moves cover the trace page that the search opens, the way back and a search of a wider range.
// It also gives the pane for a trace that could not be loaded.

import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { router } from "./app_router.js";
import { storage } from "./app_state.js";
import { timeRange } from "./app_timerange.js";
import { traceSearch } from "./app_trace_search.js";
import { DETAIL_PAGE, SEARCH_ROUTE, actions, maxRangeMinutes, model, route } from "./app_trace_store.js";
import { uiState } from "./app_ui_state.js";

const { byId, $, $$ } = dom;
const fmt = format;

// The detail pane for a trace that could not be loaded.
// It states what happened in one sentence and what to do next.
// It replaces an empty trace header.
function unavailableHtml(failed) {
  const missing = failed.code === "trace_not_found";
  const invalid = failed.code === "invalid_trace_id" || failed.code === "missing_trace_id";
  // The trace page has no time range picker. It widens the search it came from.
  const canWiden = DETAIL_PAGE ? !!widerRange() : !!dom.tracesRangeZoomOut && !dom.tracesRangeZoomOut.disabled;
  const options = {
    title: missing ? "Trace not found" : invalid ? "Not a trace ID" : "The trace could not be loaded",
    body: missing
      ? "No span with this trace ID is stored. The trace may be older than the data kept, not ingested yet, or recorded on another host."
      : invalid ? "A trace ID is 32 hexadecimal characters (16 bytes)." : failed.text,
    attrs: { "data-trace-unavailable-state": failed.code || "error" },
    actions: [
      { label: "Back to search", primary: true, attrs: { "data-trace-unavailable": "back" } },
      missing && canWiden ? { label: "Search a wider time range", attrs: { "data-trace-unavailable": "wider" } } : null,
      !missing && !invalid ? { label: "Retry", attrs: { "data-trace-unavailable": "retry" } } : null,
    ],
  };
  // A missing or malformed ID is a data state (status). A failed load is an error (alert).
  return missing || invalid ? uiState.emptyHtml({ ...options, role: "status" }) : uiState.errorHtml(options);
}

function onUnavailableClick(event) {
  const action = event.target instanceof Element ? event.target.closest("[data-trace-unavailable]")?.getAttribute("data-trace-unavailable") : "";
  if (!action || !model.traceError) return;
  const id = model.traceError.id;
  if (action === "back") returnToSearch();
  else if (action === "retry") void actions.loadTrace(id, { push: false });
  else if (action === "wider") {
    // The search of this trace context, with its range zoomed out. This is a new entry.
    const range = widerRange();
    if (range) window.location.assign(searchHref(range));
  }
}

// The trace page was opened from the search page of this app. That page is the entry right before this one.
// The mark sits on the entry itself, so a reload keeps it.
// The referrer and the entry state both survive one reload.
function markOpenedFromSearch() {
  if (Number(router.state().searchBack) > 0 || !document.referrer) return;
  let from;
  try { from = new URL(document.referrer); } catch (_) { return; }
  if (from.origin !== window.location.origin) return;
  if (router.path(from.pathname).replace(/\/+$/, "") !== SEARCH_ROUTE) return;
  router.replace(null, { href: router.href(), state: { searchBack: 1 } });
}

// The back arrow (#traceBackButton) and "Back to search" go back to the search entry that the trace came from.
// The browser restores that page as it was left, from its cache when the cache keeps it.
// So Back and Forward stay one list of pages.
// If that entry is not present, the code makes a new entry for the trace search context.
function returnToSearch() {
  const steps = Number(router.state().searchBack) || 0;
  if (steps > 0) {
    router.back(steps);
    return;
  }
  backToSearch();
}

// This function builds the search that the trace was opened from.
// It takes the search context from the address of the trace: range, filters and tab.
// The value of `range` replaces the time range of that search.
function searchHref(range = null) {
  const params = new URLSearchParams(traceSearch.contextQuery() || "");
  if (range) timeRange.url.write(params, range);
  const query = params.toString();
  return `${route(SEARCH_ROUTE)}${query ? `?${query}` : ""}`;
}

function backToSearch() {
  window.location.assign(searchHref());
}

// This function gives the time range of the trace search context, twice as wide around the same centre.
// It does what the zoom-out button of the search does.
// It returns null when the range cannot widen, because the range is already the longest range that the server allows.
function widerRange() {
  const tr = timeRange;
  if (!tr) return null;
  const raw = tr.url.read() || storage.observabilityContext.get().range || { from: `now-${tr.minutesToSpan(Math.max(1, Number(model.meta?.default_lookback_minutes || 60)))}`, to: "now" };
  const { startMs, endMs } = tr.resolveRange(raw, Date.now());
  const maxMs = maxRangeMinutes() * 60000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs >= maxMs) return null;
  const span = Math.min(maxMs, Math.max(60000, (endMs - startMs) * 2));
  let start = Math.round((startMs + endMs) / 2 - span / 2);
  let end = start + span;
  const now = Date.now();
  if (end > now && endMs <= now + 1000) { end = Math.max(now, endMs); start = end - span; }
  return { from: tr.formatDateTime(start), to: tr.formatDateTime(end) };
}

export { markOpenedFromSearch, onUnavailableClick, returnToSearch, unavailableHtml };
