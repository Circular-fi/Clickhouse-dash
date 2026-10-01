import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// The Observability page: Traces, Logs and Metrics as views of /observability
// (app_observability.js). Covers the view tabs, the shared time range and
// service, per-view filters, deep links, Back / Forward, the removed pages,
// lazy loading and the page switcher of the other shells.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const VIEWS = ['traces', 'logs', 'metrics'];
const tab = (page, view) => page.locator(`#obsTab-${view}`);
const workspace = { traces: '#tracesWorkspace', logs: '#logsWorkspace', metrics: '#metricsWorkspace' };
const rangeButton = (page, view) => page.locator(`${workspace[view]} .tracePicker--range > .tracePicker__button`);
const param = (page, name) => new URL(page.url()).searchParams.getAll(name);
const pathOf = (page) => new URL(page.url()).pathname;

async function features(request) {
  const version = await (await request.get('/api/version')).json();
  const on = Object.fromEntries(VIEWS.map((view) => [view, version.features?.[view]?.enabled === true]));
  test.skip(!VIEWS.every((view) => on[view]), 'needs traces, logs and metrics enabled');
  return on;
}

async function expectView(page, view) {
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', view);
  await expect(page.locator(workspace[view])).toBeVisible();
  for (const other of VIEWS.filter((v) => v !== view)) await expect(page.locator(workspace[other])).toBeHidden();
  await expect(tab(page, view)).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveTitle(`ClickHouse Dash · ${view[0].toUpperCase()}${view.slice(1)}`);
}

// Scripts and stylesheets the document holds.
function loaded(page) {
  return page.evaluate(() => ({
    scripts: [...document.scripts].map((s) => (s.getAttribute('src') || '').split('/').pop()).filter(Boolean),
    sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop()),
    modules: { traces: !!window.ChDash?.traces, logs: !!window.ChDash?.logs, metrics: !!window.ChDash?.metrics },
  }));
}

test('observability: the view tabs switch views in place, each a history entry', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability');
  // /observability opens the first enabled view on its canonical URL.
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
  await expectView(page, 'traces');
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  await expect(page.locator('#tracesTabs [data-trace-tab]')).not.toHaveCount(0);
  await page.evaluate(() => { window.__sameDocument = true; });

  await tab(page, 'logs').click();
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  await tab(page, 'metrics').click();
  await expect.poll(() => pathOf(page)).toBe('/observability/metrics');
  await expectView(page, 'metrics');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

  // Back / Forward walk the views.
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
  await expectView(page, 'traces');
  await page.goForward();
  await expectView(page, 'logs');
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);

  // Arrow keys move between the tabs.
  await tab(page, 'logs').focus();
  await page.keyboard.press('ArrowRight');
  await expectView(page, 'metrics');
  await expect(tab(page, 'metrics')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expectView(page, 'logs');
});

test('observability: the time range and the service follow across views, other filters stay with their view', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability/traces?from=now-2h&to=now&service=checkout&status=Error');
  await expectView(page, 'traces');
  await expect(rangeButton(page, 'traces')).toHaveText('Time range · Last 2 hours');

  // Traces -> Logs: range and service carried, the trace status filter is not.
  await tab(page, 'logs').click();
  await expectView(page, 'logs');
  expect(param(page, 'from')).toEqual(['now-2h']);
  expect(param(page, 'service')).toEqual(['checkout']);
  expect(param(page, 'status')).toEqual([]);
  await expect(rangeButton(page, 'logs')).toHaveText('Time range · Last 2 hours');
  await expect(page.locator('#logsServiceButton')).toHaveText('Service · checkout');

  // A Logs-only filter and a new range.
  await page.locator('#logsQuery').fill('payment');
  await page.locator('#logsSearchButton').click();
  await expect.poll(() => param(page, 'q')).toEqual(['payment']);
  await rangeButton(page, 'logs').click();
  await page.locator('#logsQuickRanges .timeRangeList__item[data-from="now-6h"]').click();
  await expect.poll(() => param(page, 'from')).toEqual(['now-6h']);

  // Metrics adopts the range.
  await tab(page, 'metrics').click();
  await expectView(page, 'metrics');
  expect(param(page, 'from')).toEqual(['now-6h']);
  await expect(rangeButton(page, 'metrics')).toHaveText('Time range · Last 6 hours');

  // Back on Traces: the new range, its own status filter kept.
  await tab(page, 'traces').click();
  await expectView(page, 'traces');
  expect(param(page, 'from')).toEqual(['now-6h']);
  expect(param(page, 'status')).toEqual(['Error']);
  expect(param(page, 'service')).toEqual(['checkout']);
  await expect(rangeButton(page, 'traces')).toHaveText('Time range · Last 6 hours');
  expect(param(page, 'q')).toEqual([]);

  // Back on Logs: its text search survived the round trip.
  await tab(page, 'logs').click();
  await expectView(page, 'logs');
  expect(param(page, 'q')).toEqual(['payment']);
  await expect(page.locator('#logsQuery')).toHaveValue('payment');
});

test('observability: a service picked in Logs filters Traces and opens its Metrics catalog group', async ({ page, request }) => {
  await features(request);
  const meta = await (await request.get('/api/metrics/meta')).json();
  test.skip(!meta.time_bounds, 'no metrics');
  const end = Number(meta.time_bounds.max_ms);
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const range = `from=${encodeURIComponent(fmt(end - 3600000))}&to=${encodeURIComponent(fmt(end + 1000))}`;
  await page.goto(`/observability/metrics?${range}`);
  await expectView(page, 'metrics');
  const services = page.locator('#metricsCatalog [data-service-toggle]');
  await expect(services.first()).toBeVisible({ timeout: 30_000 });
  test.skip(await services.count() < 2, 'needs two services with metrics');
  const service = await services.nth(1).getAttribute('data-service-toggle');

  await page.goto(`/observability/logs?${range}&service=${encodeURIComponent(service)}`);
  await expectView(page, 'logs');
  await tab(page, 'traces').click();
  await expectView(page, 'traces');
  expect(param(page, 'service')).toEqual([service]);
  await tab(page, 'metrics').click();
  await expectView(page, 'metrics');
  // The service's group is open, every other one folded.
  const group = page.locator(`#metricsCatalog [data-service-toggle="${service}"]`);
  await expect(group).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 });
  await expect(page.locator('#metricsCatalog [data-service-toggle][aria-expanded="true"]')).toHaveCount(1);
});

test('observability: deep links open each view and Traces sub-tab', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability/traces?tab=services');
  await expectView(page, 'traces');
  await expect(page.locator('#traceServicesView')).toBeVisible();
  await expect(page.locator('#tracesTab-services')).toHaveAttribute('aria-selected', 'true');

  await page.goto('/observability/traces?tab=map&from=now-30m&to=now');
  await expectView(page, 'traces');
  await expect(page.locator('#traceMapView')).toBeVisible();
  await expect(rangeButton(page, 'traces')).toHaveText('Time range · Last 30 minutes');

  await page.goto('/observability/logs?from=now-1h&to=now&tab=patterns');
  await expectView(page, 'logs');
  await expect(page.locator('#logsPatternsPane')).toBeVisible();
  await expect(page.locator('#logsTabPatterns')).toHaveAttribute('aria-selected', 'true');

  await page.goto('/observability/metrics?from=now-3h&to=now');
  await expectView(page, 'metrics');
  await expect(rangeButton(page, 'metrics')).toHaveText('Time range · Last 3 hours');

  // A sub-tab switch inside Traces, then Logs, then Back to that sub-tab.
  await page.goto('/observability/traces');
  await page.locator('#tracesTab-map').click();
  await expect.poll(() => param(page, 'tab')).toEqual(['map']);
  await tab(page, 'logs').click();
  await expectView(page, 'logs');
  await page.goBack();
  await expectView(page, 'traces');
  await expect(page.locator('#traceMapView')).toBeVisible();
  await page.goBack();
  await expectView(page, 'traces');
  await expect(page.locator('#traceMapView')).toBeHidden();

  // /observability keeps its parameters for the first view; an unknown view falls back.
  await page.goto('/observability?from=now-12h&to=now');
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
  expect(param(page, 'from')).toEqual(['now-12h']);
  await page.goto('/observability/nope');
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
});

test('observability: the former pages are gone', async ({ request }) => {
  for (const path of ['/traces', '/traces/0123456789abcdef0123456789abcdef', '/logs', '/metrics', '/static/traces.html', '/static/logs.html', '/static/metrics.html']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect((await request.get('/observability/traces/0123456789abcdef0123456789abcdef')).status()).toBe(200);
});

test('observability: logs and metrics modules and rules load on their first show, once', async ({ page, request }) => {
  await features(request);
  const requested = [];
  page.on('request', (r) => { if (/\/static\/[^/]+\.(js|css)(\?|$)/.test(r.url())) requested.push(r.url().split('/').pop()); });
  await page.goto('/observability/traces');
  await expectView(page, 'traces');
  let state = await loaded(page);
  expect(state.modules).toEqual({ traces: true, logs: false, metrics: false });
  for (const name of ['app_logs.js', 'app_metrics.js', 'app_query_chart.js']) expect(state.scripts).not.toContain(name);
  expect(state.sheets).toEqual(['style.observability.traces.css']);
  expect(requested.filter((n) => /^app_(logs|metrics|query_chart)\.js$/.test(n))).toEqual([]);
  // The other views' markup is not in the document until they are shown.
  await expect(page.locator('#logsWorkspace')).toHaveCount(0);
  await expect(page.locator('#metricsWorkspace')).toHaveCount(0);
  await expect(tab(page, 'logs')).not.toHaveAttribute('aria-controls', /./);

  await tab(page, 'logs').click();
  await expectView(page, 'logs');
  await expect(page.locator('#logsWorkspace')).toHaveCount(1);
  await expect(tab(page, 'logs')).toHaveAttribute('aria-controls', 'logsWorkspace');
  await expect(page.locator('#metricsWorkspace')).toHaveCount(0);
  state = await loaded(page);
  expect(state.modules).toEqual({ traces: true, logs: true, metrics: false });
  // Two views shown: one sheet with every view's rules replaces the first.
  await expect.poll(async () => (await loaded(page)).sheets).toEqual(['style.observability.css']);

  await tab(page, 'metrics').click();
  await expectView(page, 'metrics');
  for (const view of ['traces', 'logs', 'metrics', 'logs', 'traces']) {
    await tab(page, view).click();
    await expectView(page, view);
  }
  state = await loaded(page);
  expect(state.modules).toEqual({ traces: true, logs: true, metrics: true });
  // The views share the canvas chart engine, loaded once; the Query chart
  // module is never part of this page.
  for (const name of ['app_logs.js', 'app_metrics.js', 'app_chart_core.js', 'app_traces.js']) {
    expect(state.scripts.filter((s) => s === name), name).toHaveLength(1);
    expect(requested.filter((s) => s === name), name).toHaveLength(1);
  }
  expect(state.scripts).not.toContain('app_query_chart.js');
  expect(requested).not.toContain('app_query_chart.js');
  expect(state.sheets).toEqual(['style.observability.css']);

  // A page opened on Logs starts on the Logs sheet and modules only.
  await page.goto('/observability/logs');
  await expectView(page, 'logs');
  state = await loaded(page);
  expect(state.modules).toEqual({ traces: false, logs: true, metrics: false });
  expect(state.sheets).toEqual(['style.observability.logs.css']);
  // The Logs view is styled by its own sheet.
  expect(await page.locator('#logsForm').evaluate((el) => getComputedStyle(el).display)).toBe('grid');
});

test('observability: a view the server turns off has no tab and its URLs fall back', async ({ page }) => {
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.features = { ...json.features, traces: { enabled: false } };
    await route.fulfill({ response, json });
  });
  await page.goto('/observability');
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  await expect(tab(page, 'traces')).toBeHidden();
  await expect(tab(page, 'metrics')).toBeVisible();
  // The cached availability settles the next first paint.
  await page.goto('/observability/traces/0123456789abcdef0123456789abcdef');
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expect(tab(page, 'traces')).toBeHidden();
  const nav = await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.pageNav.v1')));
  expect(nav.traces).toBe(false);
});

for (const path of ['/query', '/explorer']) {
  test(`observability: the ${path} switcher opens the Observability page`, async ({ page, request }) => {
    await features(request);
    await page.goto(path);
    await page.locator('#pageSelectButton').click();
    await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toContainText(['Observability']);
    await page.locator('#navObservabilityButton').click();
    await expect.poll(() => pathOf(page)).toBe('/observability/traces');
    await expectView(page, 'traces');
    await page.locator('#pageSelectButton').click();
    await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Query', 'Explorer']);
    await page.locator('#navExplorerButton').click();
    await expect.poll(() => pathOf(page)).toMatch(/^\/explorer/);
  });
}

test('observability: no horizontal page overflow on any view, narrow windows included', async ({ page, request }) => {
  await features(request);
  for (const width of [1280, 1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/observability/traces');
    for (const view of VIEWS) {
      await tab(page, view).click();
      await expectView(page, view);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${view} @ ${width}`).toBeLessThanOrEqual(0);
      // The tabs and the switcher stay inside the window.
      for (const selector of ['#obsTabs', '#pageSelect', '#themeSelect']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.x + box.width, `${selector} @ ${width}`).toBeLessThanOrEqual(width + 0.5);
      }
    }
  }
});
