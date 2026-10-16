// The ES modules that a page fetched. A module is a request (modulepreload or import), not a script element.
// A test reads the resource timing of the page to get the file names, in the order of the requests.
export async function fetchedModules(page) {
  const names = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname.split('/').pop())
    .filter((name) => name.endsWith('.js')));
  // A kernel module Worker imports its own copy of app_wasm.js and app_assets.js. A Worker is a realm of its own.
  // The resource timing of the page lists those requests too. Only the first request of each file counts.
  const seen = new Set();
  return names.filter((name) => {
    if (name !== 'app_wasm.js' && name !== 'app_assets.js') return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

// The handle of the console and of the tests, window.ChDash, is set by the entry of the page.
// The generated handle region (app_loader.js) sets it after the page modules run, before the load event.
// Use this wait only for a test that cannot be sure that the page has loaded, such as a click that navigates.
export function appReady(page) {
  return page.waitForFunction(() => !!(window.ChDash && window.ChDash.header && window.ChDash.api && window.ChDash.format));
}
