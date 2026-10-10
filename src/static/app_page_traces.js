// The Traces page (traces.html, /observability/traces): the trace search with its Services and Service map tabs, the
// duration heatmap and the Spans mode. The trace page (app_page_trace.js) runs the same search module in detail mode,
// without these parts.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { chartCore } from "./app_chart_core.js";
import { facetPanel } from "./app_facet_panel.js";
import { startObservabilityPage } from "./app_obs_page.js";
import { traceHeatmap } from "./app_trace_heatmap.js";
import "./app_trace_map.js";
import { traceSearch } from "./app_trace_search.js";
import "./app_trace_services.js";
import { traceSpans } from "./app_trace_spans.js";
import { traceTabs } from "./app_trace_tabs.js";
import { traces } from "./app_traces.js";

boot(() => {
  traceSearch.use({ facetPanel, traceHeatmap, traceSpans, traceTabs });
  traces.use({ chartCore, traceHeatmap, traceSpans, traceTabs });
  return startObservabilityPage("traces", traces);
});
