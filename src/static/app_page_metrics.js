// The Metrics page (metrics.html, /observability/metrics): the metric browser and its panels.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { metrics } from "./app_metrics.js";
import { startObservabilityPage } from "./app_obs_page.js";

boot(() => startObservabilityPage("metrics", metrics));
