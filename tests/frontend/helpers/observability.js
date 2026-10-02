import { writeJson } from './review.js';

// An Observability request superseded by a newer one (a range, filter or
// panel changed while it still ran) is aborted on purpose (util.latest,
// app_util.js): not a failure. Every other failed request, an abort of the
// Query result stream included, still is.
const SUPERSEDED = /\/api\/(traces|logs|metrics)\//;
export function unexpectedFailures(failedRequests) {
  return failedRequests.filter((r) => !(/net::ERR_ABORTED/.test(String(r.error || '')) && SUPERSEDED.test(String(r.url || ''))));
}

export function installObservers(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];

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
