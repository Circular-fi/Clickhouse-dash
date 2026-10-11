// boot(start): what every page entry (app_page_<page>.js) ends with.
//
// It waits for the document to be parsed, runs the page's start and, when the start fails, shows the page's own message
// (window.__chdashFatal, written by the shell) instead of a header with nothing behind it. A module that fails to load
// or to run never gets here: the shell's script element for the entry shows the same message.
//
// An address that the server redirected because it has no page (?redirected_from=, app_route_notice.js) loses that mark before
// the page reads its address, and the page shows the notice once it started.
import { routeNotice } from "./app_route_notice.js";

export async function boot(start) {
  try {
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    const redirectedFrom = routeNotice.take();
    await start();
    routeNotice.show(redirectedFrom);
  } catch (error) {
    console.error(error);
    if (typeof window.__chdashFatal === "function") window.__chdashFatal(error);
  }
}
