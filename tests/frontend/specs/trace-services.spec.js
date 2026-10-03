import path from 'node:path';
import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { stabilizePage } from '../helpers/review.js';
import { SYNTHETIC_TRACES, mockTraceResults, mockTraceServices, syntheticServices } from '../helpers/traces.js';

// Services tab of the Traces page (after HyperDX's ServicesDashboardPage):
// RED metrics per service, a detail drawer with charts, release markers,
// endpoints, slowest spans and database statements. The OTel fixture has no
// service.version nor db.* attributes and is dated in the past, so the
// services answers are mocked and the tests check the requests the page
// sends; tests/backend-functional checks the numbers against ClickHouse.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const rows = (page) => page.locator('.traceSvcTable:not(.traceSvcTable--compact) tbody tr');
const names = (page) => rows(page).locator('.traceSvcRow__label').allInnerTexts();
const drawer = (page) => page.locator('#traceSvcDetail');
const last = (list) => list[list.length - 1];

async function openServices(page, query = '') {
  await page.goto(`/observability/traces?tab=services${query ? `&${query}` : ''}`);
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
}

test('the Services tab lists services, sorts them and keeps the sort in the URL', async ({ page }) => {
  const seen = await mockTraceServices(page);
  await mockTraceResults(page);
  await openServices(page);
  await expect(page.locator('#tracesTabs [data-trace-tab="services"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tracesTabs [data-trace-tab="search"]')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#tracesResults')).toBeHidden();
  await expect(page.locator('#traceSvcCount')).toHaveText('4 Services');
  // Default: most time-consuming first.
  expect(await names(page)).toEqual(['checkout', 'frontend', 'orders', 'auth']);
  const request = last(seen.services);
  expect(request.get('scope')).toBe('entry');
  expect(request.get('detail')).toBeNull();
  expect(request.get('bucket_origin_ms')).not.toBeNull();
  expect(Number(request.get('end_ms')) - Number(request.get('start_ms'))).toBe(3600_000);
  // Rate, error share, time share and sparklines.
  const checkout = rows(page).nth(0);
  await expect(checkout.locator('[data-svc-col="rate"]')).toHaveText('10/s');
  await expect(checkout.locator('[data-svc-col="errors"]')).toHaveText('2%');
  await expect(checkout.locator('[data-svc-col="p99"]')).toHaveText('420 ms');
  await expect(checkout.locator('.traceSvcSpark')).toHaveCount(2);
  await expect(checkout.locator('.serviceSwatch')).toHaveCSS('background-color', /rgb/);

  await page.locator('[data-svc-sort="p99"]').click();
  expect(await names(page)).toEqual(['auth', 'checkout', 'orders', 'frontend']);
  await expect(page.locator('th[data-svc-sort="p99"]')).toHaveAttribute('aria-sort', 'descending');
  await page.locator('[data-svc-sort="p99"]').click();
  expect(await names(page)).toEqual(['frontend', 'orders', 'checkout', 'auth']);
  expect(new URL(page.url()).searchParams.get('svc_sort')).toBe('p99:asc');
  await page.locator('[data-svc-sort="name"]').click();
  expect(await names(page)).toEqual(['auth', 'checkout', 'frontend', 'orders']);

  // Reload keeps the tab and the sort; the scope toggle searches again.
  await page.reload();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  expect(await names(page)).toEqual(['auth', 'checkout', 'frontend', 'orders']);
  const before = seen.services.length;
  await page.locator('[data-svc-scope="root"]').click();
  await expect.poll(() => seen.services.length).toBeGreaterThan(before);
  expect(last(seen.services).get('scope')).toBe('root');
  expect(new URL(page.url()).searchParams.get('svc_scope')).toBe('root');
});

test('a service row opens its detail: RED charts, release markers, endpoints, slowest spans and DB statements', async ({ page }) => {
  const seen = await mockTraceServices(page);
  await mockTraceResults(page);
  await openServices(page);
  await rows(page).filter({ hasText: 'checkout' }).locator('.traceSvcRow__label').click();
  await expect(drawer(page)).toBeVisible();
  await expect(page.locator('#traceSvcDetailTitle')).toHaveText('checkout');
  expect(new URL(page.url()).searchParams.get('svc')).toBe('checkout');
  await expect.poll(() => seen.services.some((p) => p.get('detail') === 'checkout')).toBe(true);
  await expect.poll(() => seen.db.some((p) => p.get('detail') === 'checkout')).toBe(true);
  for (const chart of ['rate', 'errors', 'latency']) {
    await expect(drawer(page).locator(`[data-svc-chart="${chart}"] canvas.chartCore__canvas`)).toBeVisible();
    // Two releases in range: one marker each on every chart.
    await expect(drawer(page).locator(`[data-svc-chart="${chart}"] .chartCore__annotation.traceSvcRelease:not([hidden])`)).toHaveCount(2);
  }
  await expect(drawer(page).locator('[data-svc-chart="rate"] .traceSvcRelease').first()).toHaveAttribute('data-label', '1.4.0');
  // Rate: successful + error bars stacked; latency: P50 / P95 / P99 lines.
  await expect(drawer(page).locator('[data-svc-chart="rate"] .chartCore')).toHaveAttribute('data-type', 'bar');
  await expect(drawer(page).locator('[data-svc-chart="latency"] .chartCore')).toHaveAttribute('data-series-stats', /"P99":\{"points":[1-9]/);
  await expect(drawer(page).locator('.traceSvcReleases li')).toHaveCount(2);
  await expect(drawer(page).locator('[data-svc-endpoint]')).toHaveCount(2);
  await expect(drawer(page).locator('[data-svc-endpoint]').first()).toHaveAttribute('data-svc-endpoint', 'POST /checkout');
  await expect(drawer(page).locator('.traceSvcSlowest li')).toHaveCount(2);
  await expect(drawer(page).locator('.traceSvcDb tbody tr')).toHaveCount(2);
  await expect(drawer(page).locator('.traceSvcDb')).toContainText('SELECT * FROM carts');
  await expect(drawer(page).locator('.traceSvcDb')).toContainText('postgresql');

  // Hover on a chart shows the bucket tooltip. The latency chart is the last
  // one: below the fold of an 800 px window, where the mouse cannot reach it
  // until the drawer scrolls it into view.
  const latency = drawer(page).locator('[data-svc-chart="latency"]');
  await latency.locator('.chartCore__overlay').scrollIntoViewIfNeeded();
  const box = await latency.locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(latency.locator('.chartCore__tooltip')).toBeVisible();
  await expect(latency.locator('.chartCore__tooltip')).toContainText('P99');

  // Back closes the drawer, Forward reopens it; Escape closes it.
  await page.goBack();
  await expect(drawer(page)).toBeHidden();
  await page.goForward();
  await expect(drawer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();

  // A slowest span opens its trace; Back returns to the Services view.
  await rows(page).filter({ hasText: 'checkout' }).locator('.traceSvcRow__label').click();
  await drawer(page).locator('.traceSvcSlowest__link').first().click();
  await expect(page.locator('#traceDetail')).toBeVisible();
  // The trace URL is pushed once the trace has loaded.
  await expect.poll(() => new URL(page.url()).pathname).toContain(`/observability/traces/${SYNTHETIC_TRACES[0].trace_id}`);
  await page.goBack();
  await expect(drawer(page)).toBeVisible();
  await expect(page.locator('#tracesTabs [data-trace-tab="services"]')).toHaveAttribute('aria-selected', 'true');
});

test('an endpoint opens the search with its service and operation, a P99 with that minimum duration', async ({ page }) => {
  await mockTraceServices(page);
  const searches = await mockTraceResults(page);
  await openServices(page, 'svc=checkout');
  await expect(drawer(page).locator('[data-svc-endpoint]')).toHaveCount(2, { timeout: 30_000 });
  await drawer(page).locator('[data-svc-operation-search="GET /cart"]').click();
  await expect(page.locator('#tracesResults')).toBeVisible();
  await expect(page.locator('#tracesTabs [data-trace-tab="search"]')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => last(searches)?.operation).toBe('GET /cart');
  expect(last(searches).service).toBe('checkout');
  const url = new URL(page.url());
  expect(url.searchParams.get('tab')).toBeNull();
  expect(url.searchParams.get('service')).toBe('checkout');
  expect(url.searchParams.get('operation')).toBe('GET /cart');

  // Back to the Services tab; the P99 of a row searches slower traces.
  await page.goBack();
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await rows(page).filter({ hasText: 'auth' }).locator('[data-svc-p99]').click();
  await expect.poll(() => last(searches)?.min_duration_ms).toBe('800');
  expect(last(searches).service).toBe('auth');
  const chip = page.locator('#tracesFilterChips .traceFilterChip--duration');
  await expect(chip).toContainText('800 ms');
  expect(new URL(page.url()).searchParams.get('min_duration_ms')).toBe('800');
  // The duration chip round-trips through the URL and is removable.
  await page.reload();
  await expect(page.locator('#tracesFilterChips .traceFilterChip--duration')).toContainText('800 ms', { timeout: 30_000 });
  await expect.poll(() => last(searches)?.min_duration_ms).toBe('800');
  await page.locator('#tracesFilterChips .traceFilterChip--duration .chip__remove').click();
  await expect.poll(() => last(searches)?.min_duration_ms).toBeUndefined();
});

test('estimated answers say so and can be computed exactly; empty and unsupported states', async ({ page }) => {
  const seen = await mockTraceServices(page, { estimated: true, releases: false, statements: [] });
  await openServices(page);
  await expect(page.locator('.traceSvcBadge--estimated')).toContainText('Estimated from 10%');
  await page.locator('.traceSvc__toolbar [data-svc-exact]').click();
  await expect.poll(() => last(seen.services).get('exact')).toBe('1');
  await expect(page.locator('.traceSvcBadge--estimated')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('svc_exact')).toBe('1');
  await rows(page).filter({ hasText: 'orders' }).locator('.traceSvcRow__label').click();
  await expect(drawer(page).locator('.traceSvcDb')).toHaveCount(0);
  await expect(drawer(page)).toContainText('No database calls');
  await expect(drawer(page)).toContainText('No release version (service.version)');
  await expect(drawer(page).locator('.traceSvcRelease')).toHaveCount(0);

  // No matching service (the drawer closes first: it covers the toolbar).
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await page.route('**/api/traces/services?**', (route) => route.fulfill({ json: { v: 1, range: [0, 1], window: [0, 1], bucket_ms: 60000, services: [], series: {} } }));
  await page.locator('[data-svc-scope="root"]').click();
  await expect(page.locator('.traceSvc__table')).toContainText('No root spans match in this range.');
  // Errors are shown, not swallowed.
  await page.route('**/api/traces/services?**', (route) => route.fulfill({ status: 503, json: { error_code: 'trace_services_failed', message: 'boom from ClickHouse' } }));
  await page.locator('[data-svc-scope="entry"]').click();
  await expect(page.locator('.traceSvc [role="alert"]')).toContainText('boom from ClickHouse');
});

test('the database statements tab reports an unsupported attribute schema', async ({ page }) => {
  await mockTraceServices(page, { dbSupported: false });
  await openServices(page, 'svc=frontend');
  await expect(drawer(page)).toContainText('Database statements are unavailable', { timeout: 30_000 });
});

// Screenshots (dark / light) and no page overflow at 1280 / 1440 / 1920.
for (const theme of ['dark', 'light']) {
  test(`captures the services table and detail without overflow (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    await mockTraceServices(page);
    await mockTraceResults(page);
    await openServices(page);
    const dir = path.join(process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review', 'screenshots', testInfo.project.name);
    await fs.mkdir(dir, { recursive: true });
    const overflow = () => page.evaluate(() => {
      const width = window.innerWidth;
      const out = [];
      for (const el of document.querySelectorAll('#tracesTabs, #tracesTabs *, .traceTabView--services, .traceTabView--services *')) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        let scroller = el.parentElement;
        let inside = false;
        while (scroller && scroller !== document.body) {
          const s = getComputedStyle(scroller);
          if (['auto', 'scroll'].includes(s.overflowX) && scroller.scrollWidth > scroller.clientWidth + 1) { inside = true; break; }
          scroller = scroller.parentElement;
        }
        if (!inside && (r.right > width + 1 || r.left < -1)) out.push(`${el.tagName}.${el.className?.baseVal ?? el.className}`);
      }
      return out.slice(0, 10);
    });
    await stabilizePage(page);
    expect(await overflow()).toEqual([]);
    await page.screenshot({ path: path.join(dir, `traces-services-${theme}.png`), fullPage: false });
    await rows(page).filter({ hasText: 'checkout' }).locator('.traceSvcRow__label').click();
    await expect(drawer(page).locator('[data-svc-chart="latency"] canvas.chartCore__canvas')).toBeVisible();
    await expect(drawer(page).locator('.traceSvcDb tbody tr')).toHaveCount(2);
    await stabilizePage(page);
    expect(await overflow()).toEqual([]);
    await page.screenshot({ path: path.join(dir, `traces-services-detail-${theme}.png`), fullPage: false });
  });
}

// A quiet window: every service 120 times slower, so checkout reads 5/min.
async function mockQuietServices(page) {
  await page.route('**/api/traces/services?**', (route) => {
    const payload = syntheticServices(new URL(route.request().url()).searchParams);
    const scale = (row) => [row[0], Math.round(row[1] / 120), Math.round(row[2] / 120), ...row.slice(3)];
    payload.services = payload.services.map(scale);
    for (const name of Object.keys(payload.series)) payload.series[name] = payload.series[name].map((p) => [p[0], p[1] / 120, p[2] / 120, ...p.slice(3)]);
    if (payload.endpoints) payload.endpoints = payload.endpoints.map(scale);
    return route.fulfill({ json: payload });
  });
}

test('the detail charts read in the table\'s units: a per-minute Requests axis and readout, Error rate in the table\'s percent format', async ({ page }) => {
  await mockTraceServices(page);
  await mockTraceResults(page);
  await mockQuietServices(page);
  await openServices(page);
  const checkout = rows(page).filter({ hasText: 'checkout' });
  await expect(checkout.locator('[data-svc-col="rate"]')).toHaveText('5/min');
  await expect(checkout.locator('[data-svc-col="errors"]')).toHaveText('2%');
  await checkout.locator('.traceSvcRow__label').click();
  await expect(drawer(page).locator('.traceSvcStat', { hasText: 'Requests' }).locator('.statTile__value')).toHaveText('5/min');
  const rate = drawer(page).locator('[data-svc-chart="rate"]');
  await expect(rate.locator('.chartCore')).toHaveAttribute('data-y-ticks', /\/min/);
  // data-y-ticks: the axis labels as drawn (app_chart_core.js).
  const rateTicks = JSON.parse(await rate.locator('.chartCore').getAttribute('data-y-ticks'));
  expect(rateTicks.length).toBeGreaterThan(1);
  for (const tick of rateTicks) expect(tick).toMatch(/^\d+(\.\d{1,2})?\/min$/);
  await expect(rate.locator('xpath=..').locator('header span')).toHaveText(/entry spans per minute/);
  const errorTicks = JSON.parse(await drawer(page).locator('[data-svc-chart="errors"] .chartCore').getAttribute('data-y-ticks'));
  for (const tick of errorTicks) expect(tick).toMatch(/^(0|\d+(\.\d{1,2})?)%$/);
  // The cursor readout and the tooltip speak the same unit.
  const box = await rate.locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(rate.locator('.chartCore__tooltip')).toBeVisible();
  await expect(rate.locator('.chartCore__tooltip')).toContainText('/min');
  await expect(rate.locator('.chartCore__tooltip')).not.toContainText('/s');
});

// Error rates of 7 %, 2 % and 0.5 % (and none): one bucket of each series
// carries them, and one P95 bucket spikes to five times the others.
const RATES = { checkout: 0.07, frontend: 0.02, orders: 0.005, auth: 0 };
async function mockThresholdServices(page) {
  await page.route('**/api/traces/services?**', (route) => {
    const payload = syntheticServices(new URL(route.request().url()).searchParams);
    payload.services = payload.services.map((row) => [row[0], 100_000, Math.round(100_000 * RATES[row[0]]), ...row.slice(3)]);
    for (const name of Object.keys(payload.series)) {
      payload.series[name] = payload.series[name].map((p, i) => [p[0], 1000 + (i % 3) * 100, i === 3 ? Math.round(1000 * RATES[name]) : 0, p[3], i === 5 ? p[4] * 5 : p[4], p[5]]);
    }
    return route.fulfill({ json: payload });
  });
}

test('error rates take the shared thresholds: 0.5 % neutral, 2 % amber, 7 % red, in the table, the panel and the sparkline dots', async ({ page }) => {
  await mockTraceServices(page);
  await mockTraceResults(page);
  await mockThresholdServices(page);
  await openServices(page);
  const row = (name) => rows(page).filter({ has: page.locator(`.traceSvcRow__label[title="${name}"]`) });
  const cell = (name) => row(name).locator('[data-svc-col="errors"]');
  await expect(cell('checkout')).toHaveText('7%');
  await expect(cell('frontend')).toHaveText('2%');
  await expect(cell('orders')).toHaveText('0.5%');
  const levels = {};
  for (const name of Object.keys(RATES)) levels[name] = await cell(name).getAttribute('data-error-level');
  expect(levels).toEqual({ checkout: 'danger', frontend: 'warn', orders: 'neutral', auth: 'neutral' });
  const colorOf = (name) => cell(name).evaluate((el) => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    const resolve = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const color = getComputedStyle(el).color;
    const out = color === resolve('--danger') ? 'danger' : color === resolve('--warning') ? 'warning' : color === resolve('--text') ? 'text' : color;
    probe.remove();
    return out;
  });
  expect(await colorOf('checkout')).toBe('danger');
  expect(await colorOf('frontend')).toBe('warning');
  expect(await colorOf('orders')).toBe('text');
  // Sparklines: a neutral line and area bound to the data, the peak printed
  // beside it; a dot only where a bucket crosses a threshold (or a P95 spike).
  const rate = (name) => row(name).locator('.traceSvcSpark--rate');
  await expect(rate('checkout').locator('.sparkline__mark--danger')).toHaveCount(1);
  await expect(rate('frontend').locator('.sparkline__mark--warn')).toHaveCount(1);
  await expect(rate('orders').locator('.sparkline__mark')).toHaveCount(0);
  await expect(rate('auth').locator('.sparkline__mark')).toHaveCount(0);
  await expect(row('checkout').locator('.traceSvcSpark--p95 .sparkline__mark--accent')).toHaveCount(1);
  await expect(rate('checkout').locator('.sparkline__area')).toHaveCount(1);
  await expect(row('checkout').locator('.traceSvcTrend__peak').first()).toHaveText(/^\d+(\.\d+)?\/(s|min|h)$/);
  await expect(row('checkout').locator('.traceSvcTrend__peak').last()).toHaveText(/\d (ms|s)$/);
  const line = await rate('checkout').evaluate((svg) => {
    const ys = svg.querySelector('.sparkline__line').getAttribute('points').trim().split(/\s+/).map((p) => Number(p.split(',')[1]));
    const xs = svg.querySelector('.sparkline__line').getAttribute('points').trim().split(/\s+/).map((p) => Number(p.split(',')[0]));
    return { top: Math.min(...ys), bottom: Math.max(...ys), firstX: xs[0], stroke: getComputedStyle(svg.querySelector('.sparkline__line')).stroke };
  });
  // Bound to the data: the lowest bucket sits on the bottom, the highest on top (no zero baseline).
  expect(line.top).toBeCloseTo(1.5, 1);
  expect(line.bottom).toBeCloseTo(22.5, 1);
  expect(line.stroke).toBe(await page.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--graph-edge-muted)'; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; }));
  // The panel's Errors tile takes the same level.
  await row('frontend').locator('.traceSvcRow__label').click();
  await expect(drawer(page).locator('.traceSvcStat', { hasText: 'Errors' })).toHaveClass(/is-warn/);
  await row('checkout').locator('.traceSvcRow__label').click();
  await expect(drawer(page).locator('.traceSvcStat', { hasText: 'Errors' })).toHaveClass(/is-error/);
  await row('orders').locator('.traceSvcRow__label').click();
  await expect(drawer(page).locator('.traceSvcStat', { hasText: 'Errors' })).not.toHaveClass(/is-(warn|error)/);
});

test('the latency chart shows P50 and P99 by default; P95 is one legend click away', async ({ page }) => {
  await mockTraceServices(page);
  await mockTraceResults(page);
  await openServices(page);
  await rows(page).filter({ hasText: 'checkout' }).locator('.traceSvcRow__label').click();
  const legend = drawer(page).locator('[data-svc-chart="latency"] .chartCore__legendItem');
  await expect(legend).toHaveText(['P50', 'P95', 'P99']);
  expect(await legend.evaluateAll((items) => items.map((item) => item.getAttribute('aria-pressed')))).toEqual(['true', 'false', 'true']);
  // The percentiles are one hue: p50 the quietest step, p99 the strongest.
  const colors = await legend.evaluateAll((items) => items.map((item) => getComputedStyle(item.querySelector('i')).backgroundColor));
  expect(new Set(colors).size).toBe(3);
  await legend.nth(1).click({ modifiers: ['Control'] });
  expect(await legend.evaluateAll((items) => items.map((item) => item.getAttribute('aria-pressed')))).toEqual(['true', 'true', 'true']);
});

test('the service drawer opens under the search bar, a bottom sheet on a phone; Escape and its close button give focus back to the row', async ({ page }) => {
  await mockTraceServices(page);
  await mockTraceResults(page);
  await openServices(page);
  const checkout = rows(page).filter({ hasText: 'checkout' });
  await checkout.locator('.traceSvcRow__label').click();
  await expect(drawer(page)).toBeVisible();
  // Desktop: the drawer starts where the (sticky) search bar ends, below
  // #obsNav, and leaves both usable.
  const form = await page.locator('#tracesForm').boundingBox();
  const side = await drawer(page).boundingBox();
  expect(Math.abs(side.y - (form.y + form.height))).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expect(checkout).toBeFocused();
  // Phone: the header wraps; the drawer is a bottom sheet under it, the
  // full width (no strip of the list beside it), its close button on top.
  await page.setViewportSize({ width: 390, height: 844 });
  await checkout.locator('.traceSvcRow__label').click();
  await expect(drawer(page)).toBeVisible();
  await expect.poll(async () => Math.round((await drawer(page).boundingBox()).width)).toBe(390);
  const sheet = await drawer(page).boundingBox();
  const nav = await page.locator('#obsNav').boundingBox();
  expect(sheet.x).toBe(0);
  expect(sheet.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  const close = drawer(page).locator('[data-svc-close]');
  const c = await close.boundingBox();
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-svc-close]'), [c.x + c.width / 2, c.y + c.height / 2])).toBe(true);
  await close.click();
  await expect(drawer(page)).toBeHidden();
  await expect(checkout).toBeFocused();
});

test('a failed services request says what failed in a sentence, without the error code, and Retry loads it again', async ({ page }) => {
  await mockTraceServices(page);
  await mockTraceResults(page);
  let fail = true;
  await page.route('**/api/traces/services?**', (route) => {
    if (fail && !new URL(route.request().url()).searchParams.get('detail')) {
      return route.fulfill({ status: 503, json: { error_code: 'trace_services_failed', message: 'Timeout exceeded: elapsed 30 seconds' } });
    }
    return route.fallback();
  });
  await page.goto('/observability/traces?tab=services');
  const alert = page.locator('.traceSvc [role="alert"]').first();
  await expect(alert).toContainText('Timeout exceeded', { timeout: 30_000 });
  await expect(alert).not.toContainText('trace_services_failed');
  fail = false;
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
});
