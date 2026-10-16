import { writeJson } from './review.js';

// A request that the page code aborts on purpose is not a failure. There are two kinds of such a request.
// The first kind is a read that a newer read superseded (a range, filter, table or panel changed while it ran).
// The second kind is a read that a closed view or a host change made useless (util.latest, app_util.js).
// installObservers() watches fetch() in the page. When a signal given to a fetch aborts while the fetch still waits for its answer, the URL goes to failedRequests.voluntaryAborts.
// A failed request is excused only when it is an abort of such a URL, once per abort. Every other failed request is still a failure.
// Examples of failures are an abort from a navigation, an abort from a timeout, and an abort of a request that nobody superseded.
// An abort of the Query result stream is also a failure, because the stream is read after its answer began.
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

// Each Observability view runs one request as its search. The view runs it when the view shows,
// and again when its primary button runs.
export const IS_RUN = {
  traces: (url) => /\/api\/traces\/search/.test(url),
  logs: (url) => /\/api\/logs\/(search|histogram)/.test(url),
  metrics: (url) => /\/api\/metrics\/catalog/.test(url),
};

export function installObservers(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  // This property is not enumerable. A spec that compares failedRequests with [] does not see it.
  Object.defineProperty(failedRequests, 'voluntaryAborts', { value: [], enumerable: false });
  // The binding does nothing when the page is already closed. The binding matters only while the test runs.
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
