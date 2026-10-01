import path from 'node:path';
import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { stabilizePage } from '../helpers/review.js';
import { SYNTHETIC_TRACES, mockTraceResults, mockTraceServices } from '../helpers/traces.js';

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
  expect(obs.failedRequests).toEqual([]);
});

const rows = (page) => page.locator('.traceSvcTable:not(.traceSvcTable--compact) tbody tr');
const names = (page) => rows(page).locator('.traceSvcRow__label').allInnerTexts();
const drawer = (page) => page.locator('#traceSvcDetail');
const last = (list) => list[list.length - 1];

async function openServices(page, query = '') {
  await page.goto(`/traces?tab=services${query ? `&${query}` : ''}`);
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
  await expect(checkout.locator('.traceSvcDot')).toHaveCSS('background-color', /rgb/);

  await page.locator('[data-svc-sort="p99"]').click();
  expect(await names(page)).toEqual(['auth', 'checkout', 'orders', 'frontend']);
  await expect(page.locator('th[aria-sort="descending"] [data-svc-sort="p99"]')).toBeVisible();
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
    await expect(drawer(page).locator(`[data-svc-chart="${chart}"] svg`)).toBeVisible();
    // Two releases in range: one marker each on every chart.
    await expect(drawer(page).locator(`[data-svc-chart="${chart}"] .traceSvcRelease`)).toHaveCount(2);
  }
  await expect(drawer(page).locator('[data-svc-chart="rate"] .traceSvcRelease').first()).toHaveAttribute('data-release', '1.4.0');
  await expect(drawer(page).locator('[data-svc-chart="latency"] .traceDurationLine--p99')).toHaveCount(1);
  await expect(drawer(page).locator('.traceSvcReleases li')).toHaveCount(2);
  await expect(drawer(page).locator('[data-svc-endpoint]')).toHaveCount(2);
  await expect(drawer(page).locator('[data-svc-endpoint]').first()).toHaveAttribute('data-svc-endpoint', 'POST /checkout');
  await expect(drawer(page).locator('.traceSvcSlowest li')).toHaveCount(2);
  await expect(drawer(page).locator('.traceSvcDb tbody tr')).toHaveCount(2);
  await expect(drawer(page).locator('.traceSvcDb')).toContainText('SELECT * FROM carts');
  await expect(drawer(page).locator('.traceSvcDb')).toContainText('postgresql');

  // Hover on a chart shows the bucket tooltip.
  const latency = drawer(page).locator('[data-svc-chart="latency"]');
  const box = await latency.locator('svg').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(latency.locator('.traceChartTooltip')).toBeVisible();
  await expect(latency.locator('.traceChartTooltip')).toContainText('P99');

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
  await expect.poll(() => new URL(page.url()).pathname).toContain(`/traces/${SYNTHETIC_TRACES[0].trace_id}`);
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
  await page.locator('#tracesFilterChips .traceFilterChip--duration .traceFilterChip__remove').click();
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
  await expect(drawer(page)).toContainText('No database spans');
  await expect(drawer(page)).toContainText("No ResourceAttributes['service.version']");
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
  await expect(drawer(page)).toContainText('database statements are unavailable', { timeout: 30_000 });
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
    await expect(drawer(page).locator('[data-svc-chart="latency"] svg')).toBeVisible();
    await expect(drawer(page).locator('.traceSvcDb tbody tr')).toHaveCount(2);
    await stabilizePage(page);
    expect(await overflow()).toEqual([]);
    await page.screenshot({ path: path.join(dir, `traces-services-detail-${theme}.png`), fullPage: false });
  });
}
