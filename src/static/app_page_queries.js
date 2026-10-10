// The System page, Queries (queries.html, /system/queries): the top query shapes of the host.
import "./app_common.js";
import { boot } from "./app_boot.js";
import { meta } from "./app_meta.js";
import "./app_system_queries.js";
import { startSystemPage } from "./app_system.js";

boot(() => {
  meta.init();
  return startSystemPage("queries");
});
