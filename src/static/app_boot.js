// boot(start) is the last call of every page entry (app_page_<page>.js).
//
// The function waits for the document to be parsed. Then it runs the start function of the page.
// If the start fails, it shows the page's own message, written to window.__chdashFatal by the shell.
// This prevents a header with nothing behind it.
//
// A module that fails to load or to run never reaches this function.
// In that case, the shell's script element for the entry shows the same message.
//
// An address that the server redirected because it has no page carries the mark ?redirected_from= (app_route_notice.js).
// That mark is removed before the page reads its address.
// The page shows the notice after it starts.

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
