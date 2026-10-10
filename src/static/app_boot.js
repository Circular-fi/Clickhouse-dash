// boot(start): what every page entry (app_page_<page>.js) ends with.
//
// It waits for the document to be parsed, runs the page's start and, when the start fails, shows the page's own message
// (window.__chdashFatal, written by the shell) instead of a header with nothing behind it. A module that fails to load
// or to run never gets here: the shell's script element for the entry shows the same message.
export async function boot(start) {
  try {
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    await start();
  } catch (error) {
    console.error(error);
    if (typeof window.__chdashFatal === "function") window.__chdashFatal(error);
  }
}
