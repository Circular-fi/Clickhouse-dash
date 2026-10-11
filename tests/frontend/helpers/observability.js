import { writeJson } from './review.js';

// A request that the page's own code aborts on purpose is not a failure: a read that a newer one superseded (a range,
// filter, table or panel changed while it still ran), one that a closed view or a host change made useless
// (util.latest, app_util.js). installObservers() watches fetch() in the page: when a signal given to a fetch aborts
// while the fetch is still waiting for its answer, the URL goes to failedRequests.voluntaryAborts. A failed request is
// excused only when it is an abort of such a URL, once per abort. Every other failed request is still a failure: an
// abort that came from a navigation, from a timeout, from a request that nobody superseded, and an abort of the Query
// result stream (which is read after its answer began).
export function unexpectedFailures(failedRequests) {
  const voluntary = [...(failedRequests.voluntaryAborts || [])];
  return failedRequests.filter((request) => {
    if (!/net::ERR_ABORTED/.test(String(request.error || ''))) return true;
    const at = voluntary.indexOf(request.url);
    if (at < 0) return true;
    voluntary.splice(at, 1);
    return false;
  });
}

// The request each Observability view runs as its search: its first run
// when it shows, and its primary button's.
export const IS_RUN = {
  traces: (url) => /\/api\/traces\/search/.test(url),
  logs: (url) => /\/api\/logs\/(search|histogram)/.test(url),
  metrics: (url) => /\/api\/metrics\/catalog/.test(url),
};

export function installObservers(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  failedRequests.voluntaryAborts = [];
  // Quiet when the page is already closed: the binding only matters while the test runs.
  page.exposeFunction('__chdashVoluntaryAbort', (url) => failedRequests.voluntaryAborts.push(url)).catch(() => {});
  page.addInitScript(() => {
    if (window.__chdashFetchWatched) return;
    window.__chdashFetchWatched = true;
    const original = window.fetch;
    window.fetch = function (input, init) {
      const signal = (init && init.signal) || (input && typeof input === 'object' && input.signal) || null;
      const result = original.apply(this, arguments);
      if (signal) {
        let answered = false;
        const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href).href;
        const done = () => { answered = true; };
        result.then(done, done);
        signal.addEventListener('abort', () => { if (!answered && window.__chdashVoluntaryAbort) window.__chdashVoluntaryAbort(url); }, { once: true });
      }
      return result;
    };
  }).catch(() => {});

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => pageErrors.push({ message: err.message, stack: err.stack }));
  page.on('requestfailed', (request) => failedRequests.push({
    url: request.url(), method: request.method(), error: request.failure()?.errorText,
  }));

  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    async flush(testInfo, name) {
      await writeJson('runtime', testInfo, name, { consoleErrors, pageErrors, failedRequests });
    },
  };
}
