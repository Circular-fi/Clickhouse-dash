import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';

// The failure filter that most specs end with (helpers/observability.js): an aborted request is excused only when the
// page's own code aborted it on purpose (a signal given to fetch() fired while the fetch waited for its answer), once
// per abort. An abort that came from anything else stays a failure, so a request cut in another way shows up instead
// of passing as "superseded".

const SLOW = '**/api/version?slow=*';
const slow = (page) => page.route(SLOW, async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await route.continue().catch(() => {});
});

async function started(page, count) {
  await expect.poll(() => page.evaluate(() => window.__started || 0)).toBe(count);
}

test('a read that util.latest superseded is excused, once per abort', async ({ page }) => {
  const obs = installObservers(page);
  await slow(page);
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.evaluate(() => {
    window.__started = 0;
    const read = (n) => {
      const token = window.ChDash.util.latest('probe');
      window.__started += 1;
      return fetch(`/api/version?slow=${n}`, { signal: token.signal }).catch(() => null);
    };
    window.__probe = [read(1), read(2)];
  });
  await started(page, 2);
  await page.evaluate(() => Promise.all(window.__probe));
  await expect.poll(() => obs.failedRequests.length).toBe(1);
  expect(obs.failedRequests[0].url).toContain('slow=1');
  expect(obs.failedRequests.voluntaryAborts).toHaveLength(1);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
  // One abort excuses one failure: a second failure of the same URL is not covered.
  expect(unexpectedFailures(Object.assign([...obs.failedRequests, ...obs.failedRequests], { voluntaryAborts: obs.failedRequests.voluntaryAborts })))
    .toHaveLength(1);
});

test('an abort that no signal asked for is a failure, and a signal that fires after the answer is not an abort of a request', async ({ page }) => {
  const obs = installObservers(page);
  await slow(page);
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeEnabled();
  // A request cut in some other way than a signal given to fetch (here the close of an event stream, the way the
  // page's own stream stops) is not one of the page's superseded reads.
  await page.evaluate(async () => {
    const stream = new EventSource('/api/hosts/stream?cut=1');
    await new Promise((resolve) => { stream.onopen = resolve; stream.onerror = resolve; });
    stream.close();
  });
  await expect.poll(() => obs.failedRequests.filter((r) => r.url.includes('cut=1')).length).toBe(1);
  expect(obs.failedRequests.voluntaryAborts).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests).filter((r) => r.url.includes('cut=1'))).toHaveLength(1);

  // A signal that fires once the answer is in cancels nothing: it is not recorded as a voluntary abort of a request.
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.evaluate(async () => {
    const controller = new AbortController();
    await (await fetch('/api/version', { signal: controller.signal })).text();
    controller.abort();
  });
  expect(obs.failedRequests.voluntaryAborts).toEqual([]);
});

test('a failure that is not an abort is never excused', async () => {
  const failures = Object.assign([{ url: 'http://x/api/traces/search', error: 'net::ERR_CONNECTION_RESET' }], { voluntaryAborts: ['http://x/api/traces/search'] });
  expect(unexpectedFailures(failures)).toHaveLength(1);
});
