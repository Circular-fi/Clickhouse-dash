(() => {
  "use strict";
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
  // (ns.traces, app_traces.js); this controller starts them as
  // app_obs_page.js starts a view: modules, header, then the view's
  // lifecycle scope and init().
  window.ChDash = window.ChDash || {};

  async function start() {
    const ns = window.ChDash;
    await ns.loader.startModules();
    ns.api.humanizeErrors();
    const dom = ns.dom || {};
    const route = (path) => ns.api.resolveUrl(path);
    ns.ui?.setPageSelectorValue?.("observability");
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer/catalog")));
    ns.ui?.init?.();
    const scope = ns.lifecycle.enter("traces");
    ns.traces.init();
    ns.traces.onShow?.(scope);
    // Back / Forward within the trace page: another ?span= / ?view= / ?tab=,
    // or a linked trace opened in place. Leaving the page is the browser's.
    ns.router.on("/observability", () => ns.traces.onLocation());
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => start().catch(console.error), { once: true });
  else start().catch(console.error);
})();
