// The ES modules a page fetched. A module is a request (modulepreload, import), not a <script> element, so a test reads
// the resource timing of the page: the file names, in the order they were requested.
export function fetchedModules(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname.split('/').pop())
    .filter((name) => name.endsWith('.js')));
}

// The handle of the console and of the tests, window.ChDash, is written by app_loader.js when the page's modules have
// run, a few tasks after the load event: a test that reads it right after goto() or reload() waits for it first.
export function appReady(page) {
  return page.waitForFunction(() => !!(window.ChDash && window.ChDash.header && window.ChDash.api && window.ChDash.format));
}
