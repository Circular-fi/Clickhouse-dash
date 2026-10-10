// The Logs page (logs.html, /observability/logs): the log search, its histogram and the patterns.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { logs } from "./app_logs.js";
import { startObservabilityPage } from "./app_obs_page.js";

boot(() => startObservabilityPage("logs", logs));
