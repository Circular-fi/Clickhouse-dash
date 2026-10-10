// The ES modules a page fetched. A module is a request (modulepreload, import), not a <script> element, so a test reads
// the resource timing of the page: the file names, in the order they were requested.
export async function fetchedModules(page) {
  const names = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname.split('/').pop())
    .filter((name) => name.endsWith('.js')));
  // A kernel's module Worker imports its own copy of app_wasm.js and app_assets.js (a Worker is a realm of its own), and
  // the page's resource timing lists those requests too: only the first of each counts.
  const seen = new Set();
  return names.filter((name) => {
    if (name !== 'app_wasm.js' && name !== 'app_assets.js') return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// The handle of the console and of the tests, window.ChDash, is written by the entry of the page (the generated handle
// region, app_loader.js) when the page's modules have run, before the load event. This wait is for a test that cannot be
// sure that the page has loaded (a click that navigates).
export function appReady(page) {
  return page.waitForFunction(() => !!(window.ChDash && window.ChDash.header && window.ChDash.api && window.ChDash.format));
}
