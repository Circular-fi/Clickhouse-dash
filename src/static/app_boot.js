// boot(start): what every page entry (app_page_<page>.js) ends with.
//
// It waits for the document to be parsed, hands the page's modules to window.ChDash (app_loader.js: the handle of the
// tests and the console), runs the page's start and, when the start fails, shows the page's own message
// (window.__chdashFatal, written by the shell) instead of a header with nothing behind it. A module that fails to load
// or to run never gets here: the shell's dynamic import of the entry shows the same message.
import { loader } from "./app_loader.js";

export async function boot(start) {
  try {
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    await loader.exposeAll();
    await start();
  } catch (error) {
    console.error(error);
    if (typeof window.__chdashFatal === "function") window.__chdashFatal(error);
  }
}
