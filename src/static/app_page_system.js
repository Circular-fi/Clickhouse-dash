// The System page, Overview (system.html, /system): the activity, the performance charts and the databases of the host.
import "./app_common.js";
import { boot } from "./app_boot.js";
import "./app_system_overview.js";
import { startSystemPage } from "./app_system.js";

boot(() => startSystemPage("overview"));
