// The page of one trace (trace.html, /observability/traces/<trace id>): a
// page of its own, not a pane of the Observability page. It has the page
// header, but not the Observability view tabs (#obsNav: Traces, Logs,
// Metrics) nor the trace search.
//
//   /observability/traces/<traceId>[?span=&view=&<search context>]
//
// The search parameters of the address (time range, filters, search tab)
// are the context the trace was opened from: "back to search" returns to
// /observability/traces with them, and a filter picked on a value of the
// trace opens that search with the filter applied (app_trace_search.js,
// detail mode). The Traces view's modules run here in detail mode
// (traces, app_traces.js), without the parts of the search page (the charts, the
// duration heatmap, the Spans mode and the Services / Service map tabs: this page
// never hands them to traces.use()); this entry starts the view as app_obs_page.js
// starts one: header, then the view's lifecycle scope and init().
import "./app_common.js";
import { api } from "./app_api.js";
import { boot } from "./app_boot.js";
import { header } from "./app_header.js";
import { router } from "./app_router.js";
import { traces } from "./app_traces.js";
import { lifecycle } from "./app_ui_layers.js";

async function start() {
  api.humanizeErrors();
  header.setPageSelectorValue("observability");
  header.init();
  const scope = lifecycle.enter("traces");
  traces.init();
  traces.onShow?.(scope);
  // Back / Forward within the trace page: another ?span= / ?view= / ?tab=,
  // or a linked trace opened in place. Leaving the page is the browser's.
  router.on("/observability", () => traces.onLocation());
}

boot(start);
