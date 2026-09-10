import { writeJson } from './review.js';

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
