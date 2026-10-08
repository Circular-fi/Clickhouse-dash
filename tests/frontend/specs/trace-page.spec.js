import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { SYNTHETIC_TRACES, mockTraceResults } from '../helpers/traces.js';

// One trace is a page of its own (trace.html at /observability/traces/<id>),
// not a pane of the Observability page: the page header, but none of the
// Traces / Logs / Metrics tabs and none of the search; opening a trace from
// the results and leaving it are page navigations.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const FIRST = SYNTHETIC_TRACES[0];
const spanRow = (page) => page.locator('#traceWaterfall .traceSpanRow').first();

test('a trace page has the header but no Observability tabs and no search', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-page', 'trace');
  await expect(page.locator('#traceDetail')).toBeVisible();
  for (const id of ['obsNav', 'obsTabs', 'tracesTabs', 'tracesSearchView', 'tracesForm', 'logsWorkspace', 'metricsWorkspace']) {
    await expect(page.locator(`#${id}`), id).toHaveCount(0);
  }
  await expect(page.locator('html')).not.toHaveAttribute('data-obs-view', /.+/);
  // The header stays: the host and theme pickers, and the page switcher on Observability.
  await expect(page.locator('#hostPicker')).toBeVisible();
  await expect(page.locator('#themeSelect')).toBeVisible();
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  // The back arrow is the one of a query shape's page (.pageBack).
  const arrow = page.locator('#traceBackButton');
  await expect(arrow).toHaveClass(/\bpageBack\b/);
  expect(await arrow.boundingBox()).toMatchObject({ width: 28, height: 36 });
  await expect(arrow.locator('use')).toHaveAttribute('href', /#i-arrow-left$/);
  await expect(page).toHaveTitle(new RegExp(`^${FIRST.trace_id.slice(0, 7)}`));
});

test('opening a trace navigates to its page and the back arrow returns to the same search', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await page.goto('/observability/traces?from=now-3h&to=now&status=Error&tag=http.method%3DPOST');
  await expect(page.locator('body')).toHaveAttribute('data-page', 'observability');
  await expect(page.locator('#obsNav')).toBeVisible();
  await expect(page.locator('#traceDetail')).toHaveCount(0);
  const open = page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"] .traceResult__wideTitle`);
  await expect(open).toBeVisible({ timeout: 30_000 });

  // A real navigation: the document is replaced, not hidden.
  await page.evaluate(() => { window.__sameDocument = true; });
  await Promise.all([page.waitForURL(new RegExp(`/observability/traces/${FIRST.trace_id}\\?`)), open.click()]);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'trace');
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  await expect(page.locator('#obsNav')).toHaveCount(0);
  const context = new URL(page.url()).searchParams;
  expect(context.get('status')).toBe('Error');
  expect(context.getAll('tag')).toEqual(['http.method=POST']);
  expect(context.get('from')).toBe('now-3h');
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });

  // Back: the search page again, with the search of the trace's address.
  const before = searches.length;
  await Promise.all([page.waitForURL(/\/observability\/traces\?/), page.locator('#traceBackButton').click()]);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'observability');
  await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(1);
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
  expect(searches.length).toBeGreaterThanOrEqual(before);
  expect(searches[searches.length - 1].status).toBe('Error');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['http.method=POST']);
});

test('a trace opened by its address returns to the search it carries, and Back / Forward stay inside the trace', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-2h&to=now&status=Error`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  // A span picked in the spans table is a history entry (the view tab itself replaces),
  // written next to the carried context.
  await page.evaluate(() => { window.__sameDocument = true; });
  await page.locator('#traceViewTab-spans').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('spans');
  await page.locator('#traceAltView tr[data-table-span]').first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get('span')).toBeTruthy();
  const params = new URL(page.url()).searchParams;
  expect(params.get('status')).toBe('Error');
  expect(params.get('from')).toBe('now-2h');
  // Back / Forward within the trace page keep the same document.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${FIRST.trace_id}\\?.*tab=spans`));
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('span')).toBeTruthy();
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  // No search entry before it (a direct address): the back arrow opens the search.
  await Promise.all([page.waitForURL(/\/observability\/traces\?/), page.locator('#traceBackButton').click()]);
  const back = new URL(page.url()).searchParams;
  expect(back.get('status')).toBe('Error');
  expect(back.get('from')).toBe('now-2h');
  expect(back.has('tab')).toBe(false);
  expect(back.has('span')).toBe(false);
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
  expect(searches[searches.length - 1].status).toBe('Error');
});

test('a filter picked on a trace opens the search with the filter applied', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-3h&to=now&status=Error&span=0000000000000001`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await page.locator('#traceDetailTitle [data-filter-field="service"]').click();
  const menu = page.locator('#traceFilterMenu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Exclude this value' }).click();
  await page.waitForURL(/\/observability\/traces\?/);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'observability');
  await expect.poll(() => searches[searches.length - 1]?.status).toBe('Error');
  const params = new URL(page.url()).searchParams;
  expect(params.getAll('service_not')).toEqual([FIRST.service]);
  expect(params.get('status')).toBe('Error');
  expect(params.has('span')).toBe(false);
  await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(1);
});

test('the page switcher of a trace page leads to the other pages, and the trace is not an Observability entry of it', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-1h&to=now`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await page.locator('#pageSelectButton').click();
  // The current page (Observability) is the button's label, not a menu entry.
  await expect(page.locator('#navObservabilityButton')).toBeHidden();
  await Promise.all([page.waitForURL(/\/query$/), page.locator('#navQueryButton').click()]);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'query');
});

test('a trace whose address has no time range returns to the range its tab last showed; the address wins when it has one', async ({ page }) => {
  await mockTraceResults(page);
  await page.addInitScript(() => sessionStorage.setItem('chdash.observability.context.v1', JSON.stringify({ range: { from: 'now-6h', to: 'now' } })));
  const range = () => Object.fromEntries([...new URL(page.url()).searchParams].filter(([name]) => name === 'from' || name === 'to'));
  // The address says 2 h: that is the search it returns to.
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-2h&to=now`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await Promise.all([page.waitForURL(/\/observability\/traces\?/), page.locator('#traceBackButton').click()]);
  expect(range()).toEqual({ from: 'now-2h', to: 'now' });
  // No range in the address (a link from Logs or Metrics, a trace opened by its id): the tab's.
  await page.goto(`/observability/traces/${FIRST.trace_id}`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await Promise.all([page.waitForURL(/\/observability\/traces\?/), page.locator('#traceBackButton').click()]);
  expect(range()).toEqual({ from: 'now-6h', to: 'now' });
  // A stored value that is not a range is ignored.
  await page.addInitScript(() => sessionStorage.setItem('chdash.observability.context.v1', '{"range":{"from":1}}'));
  await page.goto(`/observability/traces/${FIRST.trace_id}`);
  await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
  await Promise.all([page.waitForURL(/\/observability\/traces(\?.*)?$/), page.locator('#traceBackButton').click()]);
  expect(range()).toEqual({});
});

// A solid badge (.badge--solid: the tone as a fill, the glyph in --panel) keeps a readable ink wherever it sits. The
// rules that colour the header's spans in --muted outranked it: the error count of a service chip showed grey on light
// red (about 2:1) in the dark theme.
const luminance = ([r, g, b]) => {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = (css) => (css.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

for (const theme of ['dark', 'light']) {
  test(`every solid badge of a trace page is readable (${theme})`, async ({ page }) => {
    await page.addInitScript((mode) => { try { localStorage.setItem('chdash.theme', mode); } catch (_) {} }, theme);
    await mockTraceResults(page);
    await page.goto(`/observability/traces/${FIRST.trace_id}`);
    await expect(spanRow(page)).toBeVisible({ timeout: 30_000 });
    const solid = await page.evaluate(() => [...document.querySelectorAll('.badge--solid')].map((el) => {
      const style = getComputedStyle(el);
      return { cls: el.className, text: el.textContent.trim(), color: style.color, bg: style.backgroundColor };
    }));
    // The service chips carry the error count of the trace: there is at least one solid badge to judge.
    expect(solid.length).toBeGreaterThan(0);
    for (const badge of solid) {
      const ratio = contrast(rgb(badge.color), rgb(badge.bg));
      expect(ratio, `${badge.cls} "${badge.text}": ${badge.color} on ${badge.bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

for (const theme of ['dark', 'light']) {
  test(`every solid badge of the trace results is readable (${theme})`, async ({ page }) => {
    await page.addInitScript((mode) => { try { localStorage.setItem('chdash.theme', mode); } catch (_) {} }, theme);
    await mockTraceResults(page);
    await page.goto('/observability/traces?from=now-3h&to=now&status=Error');
    await expect(page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"]`)).toBeVisible({ timeout: 30_000 });
    const solid = await page.evaluate(() => [...document.querySelectorAll('.badge--solid')].map((el) => {
      const style = getComputedStyle(el);
      return { cls: el.className, text: el.textContent.trim(), color: style.color, bg: style.backgroundColor };
    }));
    for (const badge of solid) {
      const ratio = contrast(rgb(badge.color), rgb(badge.bg));
      expect(ratio, `${badge.cls} "${badge.text}": ${badge.color} on ${badge.bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
