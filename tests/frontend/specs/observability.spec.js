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

  // Arrow keys move between the tabs (wrapping), Home / End go to the ends.
  await tab(page, 'logs').focus();
  await page.keyboard.press('ArrowRight');
  await expectView(page, 'metrics');
  await expect(tab(page, 'metrics')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expectView(page, 'logs');
  await page.keyboard.press('Home');
  await expectView(page, 'traces');
  await expect(tab(page, 'traces')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expectView(page, 'metrics');
  await expect(tab(page, 'metrics')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expectView(page, 'traces');
  await page.keyboard.press('End');
  await expectView(page, 'metrics');
  await expect(tab(page, 'metrics')).toBeFocused();
  // Roving tab stop: only the selected tab is in the Tab order.
  await expect(page.locator('#obsTabs [data-obs-tab][tabindex="0"]')).toHaveCount(1);
  await expect(tab(page, 'metrics')).toHaveAttribute('tabindex', '0');
});

const centerY = (box) => box.y + box.height / 2;

test('observability: the view tabs are a row under the header, the Traces tabs on the same row', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability/traces');
  await expectView(page, 'traces');
  // The header is the other pages' header: brand, host, page switcher, theme.
  const header = page.locator('header.appHeader');
  await expect(header.locator('[role="tab"], [role="tablist"]')).toHaveCount(0);
  await expect(header.locator('#hostPicker, #pageSelect, #themeSelect')).toHaveCount(3);
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  // The row, in the body under the header, with the Explorer view tab component.
  const nav = page.locator('body > nav#obsNav');
  await expect(nav).toBeVisible();
  await expect(page.locator('#obsTabs')).toHaveClass(/\bexplorerViewTabs\b/);
  await expect(page.locator('#obsTabs')).toHaveAttribute('role', 'tablist');
  await expect(page.locator('#obsTabs [role="tab"]')).toHaveText(['Traces', 'Logs', 'Metrics']);
  for (const view of VIEWS) await expect(tab(page, view)).toHaveClass(/\bexplorerViewTab\b/);
  await expect(tab(page, 'traces')).toHaveClass(/\bis-active\b/);
  const headerBox = await header.boundingBox();
  const navBox = await nav.boundingBox();
  expect(navBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  expect(navBox.y).toBeLessThanOrEqual(headerBox.y + headerBox.height + 0.5);
  // The Explorer's tab look.
  const style = await tab(page, 'traces').evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontSize: s.fontSize, fontWeight: s.fontWeight, height: el.getBoundingClientRect().height };
  });
  expect(style).toEqual({ fontSize: '13px', fontWeight: '600', height: 28 });

  // Traces: its sub-tabs after a separator, on the same row (no extra row height).
  const sub = page.locator('#tracesTabs');
  await expect(sub).toBeVisible();
  await expect(sub).toHaveClass(/\bexplorerViewTabs\b/);
  await expect(sub.locator('[data-trace-tab]').first()).toHaveText('Search');
  await expect(sub.locator('[data-trace-tab="search"]')).toHaveClass(/\bexplorerViewTab\b/);
  await expect(page.locator('#obsNav .obsNav__sep')).toBeVisible();
  const mainBox = await page.locator('#obsTabs').boundingBox();
  const subBox = await sub.boundingBox();
  const sepBox = await page.locator('#obsNav .obsNav__sep').boundingBox();
  expect(Math.abs(centerY(mainBox) - centerY(subBox))).toBeLessThanOrEqual(1);
  expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(sepBox.x);
  expect(sepBox.x + sepBox.width).toBeLessThanOrEqual(subBox.x);
  // One row: the tab lists and the row padding, nothing stacked.
  expect(navBox.height).toBeLessThanOrEqual(mainBox.height + 14);
  // The search bar starts right under the row.
  const formBox = await page.locator('#tracesForm').boundingBox();
  expect(formBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 0.5);
  expect(formBox.y).toBeLessThanOrEqual(navBox.y + navBox.height + 12);

  // Logs and Metrics: no sub-tabs, their toolbar right under the same row.
  for (const [view, toolbar] of [['logs', '#logsForm'], ['metrics', '#metricsWorkspace']]) {
    await tab(page, view).click();
    await expectView(page, view);
    await expect(sub).toBeHidden();
    await expect(page.locator('#obsNav .obsNav__sep')).toBeHidden();
    const box = await nav.boundingBox();
    expect(box).toEqual(navBox);
    const top = (await page.locator(toolbar).boundingBox()).y;
    expect(top, view).toBeGreaterThanOrEqual(box.y + box.height - 0.5);
    expect(top, view).toBeLessThanOrEqual(box.y + box.height + 12);
  }
  await tab(page, 'traces').click();
  await expectView(page, 'traces');
  await expect(sub).toBeVisible();

  // One trace: the view tabs stay, the search's tabs leave with the search.
  await page.goto('/observability/traces/0123456789abcdef0123456789abcdef');
  await expectView(page, 'traces');
  await expect(page.locator('body')).toHaveClass(/\bis-trace-detail\b/);
  await expect(sub).toBeHidden();
  await expect(page.locator('#obsNav .obsNav__sep')).toBeHidden();
  await expect(page.locator('#obsTabs')).toBeVisible();
});

test('observability: the Traces tabs on the row switch with the keyboard', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability/traces');
  await expectView(page, 'traces');
  const subTabs = page.locator('#tracesTabs [data-trace-tab]');
  await expect(subTabs.first()).toHaveAttribute('aria-selected', 'true');
  const ids = await subTabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-trace-tab')));
  test.skip(ids.length < 2, 'needs a second Traces tab');
  const last = ids[ids.length - 1];
  await page.locator('#tracesTab-search').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(`#tracesTab-${ids[1]}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#tracesTab-${ids[1]}`)).toBeFocused();
  await expect.poll(() => param(page, 'tab')).toEqual([ids[1]]);
  await page.keyboard.press('End');
  await expect(page.locator(`#tracesTab-${last}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#tracesTab-${last}`)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tracesTab-search')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tracesTab-search')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await expect(page.locator('#tracesTab-search')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tracesTab-search')).toBeFocused();
  await expect.poll(() => param(page, 'tab')).toEqual([]);
  // The keys of one list never move to the other.
  await expectView(page, 'traces');
  await expect(page.locator('#tracesTabs [tabindex="0"]')).toHaveCount(1);
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
  await expect(page.locator('#obsTabs [role="tab"]:visible')).toHaveText(['Logs', 'Metrics']);
  await expect(page.locator('#tracesTabs')).toBeHidden();
  // The cached availability settles the next first paint.
  await page.goto('/observability/traces/0123456789abcdef0123456789abcdef');
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expect(tab(page, 'traces')).toBeHidden();
  const nav = await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.pageNav.v1')));
  expect(nav.traces).toBe(false);
});

test('observability: with one view the row keeps only what it has to show', async ({ page }) => {
  let only = 'traces';
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.features = { ...json.features, ...Object.fromEntries(VIEWS.map((view) => [view, { ...(json.features?.[view] || {}), enabled: view === only }])) };
    await route.fulfill({ response, json });
  });
  await page.goto('/observability/traces');
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', 'traces');
  await expect.poll(() => page.evaluate(() => window.ChDash?.observability?.featuresKnown === true)).toBe(true);
  // Traces alone: no view tabs, no separator, its own tabs on the row.
  await expect(page.locator('#obsTabs')).toBeHidden();
  await expect(page.locator('#obsNav .obsNav__sep')).toBeHidden();
  await expect(page.locator('#tracesTabs')).toBeVisible();
  // Logs alone: nothing to show, no row.
  only = 'logs';
  await page.goto('/observability/logs');
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', 'logs');
  await expect.poll(() => page.evaluate(() => window.ChDash?.observability?.featuresKnown === true)).toBe(true);
  await expect(page.locator('#obsNav')).toBeHidden();
  await expect(page.locator('#logsForm')).toBeVisible();
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
      // The tab row and the switcher stay inside the window.
      for (const selector of ['#obsNav', '#pageSelect', '#themeSelect']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.x + box.width, `${selector} @ ${width}`).toBeLessThanOrEqual(width + 0.5);
      }
    }
  }
});

test('observability: on a phone the tab row scrolls sideways and keeps one row', async ({ page, request }) => {
  await features(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/observability/traces');
  await expectView(page, 'traces');
  const nav = page.locator('#obsNav');
  const sub = page.locator('#tracesTabs');
  await expect(sub).toBeVisible();
  const metrics = await nav.evaluate((el) => ({
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: getComputedStyle(el).overflowX,
  }));
  expect(metrics.overflowX).toBe('auto');
  // View tabs and Traces tabs do not fit 390 px: the row scrolls, the page does not.
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  // Still one row: both tab lists share a centre line, each keeps its width.
  const mainBox = await page.locator('#obsTabs').boundingBox();
  const subBox = await sub.boundingBox();
  expect(Math.abs(centerY(mainBox) - centerY(subBox))).toBeLessThanOrEqual(1);
  expect((await nav.boundingBox()).height).toBeLessThanOrEqual(mainBox.height + 14);
  for (const name of ['Traces', 'Logs', 'Metrics']) {
    const clipped = await page.locator('#obsTabs [role="tab"]', { hasText: name }).evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped, name).toBe(false);
  }
  // The last Traces tab is reachable: a click scrolls it into view and selects it.
  const lastTab = sub.locator('[data-trace-tab]').last();
  await lastTab.click();
  await expect(lastTab).toHaveAttribute('aria-selected', 'true');
  const box = await lastTab.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390.5);
  expect(await nav.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  // A deep link to the last Traces tab scrolls the row to it.
  const lastId = await lastTab.getAttribute('data-trace-tab');
  await page.goto(`/observability/traces?tab=${lastId}`);
  await expect(page.locator(`#tracesTab-${lastId}`)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => {
    const b = await page.locator(`#tracesTab-${lastId}`).boundingBox();
    return b.x >= -0.5 && b.x + b.width <= 390.5;
  }).toBe(true);
  // The header holds the brand, then host / page / theme, like the Explorer.
  const brand = await page.locator('.appBrand').boundingBox();
  const host = await page.locator('#hostPicker').boundingBox();
  expect(host.y).toBeGreaterThan(brand.y + brand.height - 1);
});
