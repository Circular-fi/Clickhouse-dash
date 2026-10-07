import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { nestedTrace, largeTrace, routeSearch, routeTrace } from '../helpers/trace-mocks.js';
import { mockTraceResults, mockTraceServices } from '../helpers/traces.js';

// The Observability pages: Traces, Logs and Metrics, each a page of its own
// (traces.html, logs.html, metrics.html, app_obs_page.js), linked by the row
// under the header. Covers the row, the shared time range and service,
// per-view filters, deep links, Back / Forward, the removed pages, what each
// page loads and the page switcher of the other shells.

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
  // The other views are other pages: their markup is not in this document.
  for (const other of VIEWS.filter((v) => v !== view)) await expect(page.locator(workspace[other])).toHaveCount(0);
  await expect(tab(page, view)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#obsTabs [aria-current="page"]')).toHaveCount(1);
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

test('observability: the view tabs are links to pages of their own, each a history entry', async ({ page, request }) => {
  await features(request);
  await page.goto('/observability');
  // /observability sends the browser to the first enabled view's page.
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
  await expectView(page, 'traces');
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  await expect(page.locator('#tracesTabs [data-trace-tab]')).not.toHaveCount(0);
  // The tabs are plain links, in the Tab order.
  await expect(page.locator('#obsTabs a[data-obs-tab]')).toHaveCount(3);
  for (const view of VIEWS) await expect(tab(page, view)).toHaveAttribute('href', new RegExp(`/observability/${view}$`));
  await page.evaluate(() => { window.__sameDocument = true; });

  await tab(page, 'logs').click();
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  // Another document: the page was left, not switched in place.
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  await tab(page, 'metrics').click();
  await expect.poll(() => pathOf(page)).toBe('/observability/metrics');
  await expectView(page, 'metrics');

  // Back / Forward walk the pages.
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  await page.goBack();
  await expect.poll(() => pathOf(page)).toBe('/observability/traces');
  await expectView(page, 'traces');
  await page.goForward();
  await expectView(page, 'logs');

  // A link tab is reached with Tab and opened with Enter.
  await tab(page, 'metrics').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => pathOf(page)).toBe('/observability/metrics');
  await expectView(page, 'metrics');
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
  // The row, in the body under the header: the nav row's underline tabs (.contentTabs--nav).
  const nav = page.locator('body > nav#obsNav');
  await expect(nav).toBeVisible();
  await expect(page.locator('#obsTabs')).toHaveClass(/\bcontentTabs\b.*\bcontentTabs--nav\b/);
  await expect(page.locator('#obsTabs')).toHaveAttribute('role', 'group');
  await expect(page.locator('#obsTabs a')).toHaveText(['Traces', 'Logs', 'Metrics']);
  for (const view of VIEWS) await expect(tab(page, view)).toHaveClass(/\bcontentTabs__tab\b/);
  await expect(tab(page, 'traces')).toHaveClass(/\bis-active\b/);
  const headerBox = await header.boundingBox();
  const navBox = await nav.boundingBox();
  expect(navBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 0.5);
  expect(navBox.y).toBeLessThanOrEqual(headerBox.y + headerBox.height + 0.5);
  // The tab look (app_ui_tabs.js, Components: tabs): the underline row, its
  // selected tab's underline on the row's bottom border.
  const style = await tab(page, 'traces').evaluate((el) => {
    const s = getComputedStyle(el);
    return { fontSize: s.fontSize, fontWeight: s.fontWeight, underline: `${s.borderBottomWidth} ${s.borderBottomStyle}`, background: s.backgroundColor };
  });
  expect(style).toEqual({ fontSize: '13px', fontWeight: '600', underline: '2px solid', background: 'rgba(0, 0, 0, 0)' });
  const tabBox = await tab(page, 'traces').boundingBox();
  expect(Math.abs(tabBox.y + tabBox.height - (navBox.y + navBox.height))).toBeLessThanOrEqual(1);

  // Traces: its sub-tabs after a separator, on the same row (no extra row height).
  const sub = page.locator('#tracesTabs');
  await expect(sub).toBeVisible();
  await expect(sub).toHaveClass(/\bcontentTabs--nav\b/);
  await expect(sub.locator('[data-trace-tab]').first()).toHaveText('Search');
  await expect(sub.locator('[data-trace-tab="search"]')).toHaveClass(/\bcontentTabs__tab\b/);
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
    await expect(page.locator('#tracesTabs')).toHaveCount(0);
    await expect(page.locator('#obsNav .obsNav__sep')).toHaveCount(0);
    const box = await nav.boundingBox();
    expect(box).toEqual(navBox);
    const top = (await page.locator(toolbar).boundingBox()).y;
    expect(top, view).toBeGreaterThanOrEqual(box.y + box.height - 0.5);
    expect(top, view).toBeLessThanOrEqual(box.y + box.height + 12);
  }
  await tab(page, 'traces').click();
  await expectView(page, 'traces');
  await expect(page.locator('#tracesTabs')).toBeVisible();

  // One trace is a page of its own: the header, but none of the Observability tabs.
  await page.goto('/observability/traces/0123456789abcdef0123456789abcdef');
  await expect(page.locator('body')).toHaveAttribute('data-page', 'trace');
  await expect(page.locator('#traceDetail')).toBeVisible();
  await expect(page.locator('.appHeader')).toBeVisible();
  for (const id of ['obsNav', 'obsTabs', 'tracesTabs', 'tracesForm', 'logsWorkspace', 'metricsWorkspace']) {
    await expect(page.locator(`#${id}`), id).toHaveCount(0);
  }
  await expect(page.locator('html')).not.toHaveAttribute('data-obs-view', /.+/);
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
  await expect.poll(() => param(page, 'from')).toEqual(['now-2h']);
  await expect.poll(() => param(page, 'service')).toEqual(['checkout']);
  await expect.poll(() => param(page, 'status')).toEqual([]);
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
  await expect.poll(() => param(page, 'from')).toEqual(['now-6h']);
  await expect(rangeButton(page, 'metrics')).toHaveText('Time range · Last 6 hours');

  // Back on Traces: the new range, its own status filter kept.
  await tab(page, 'traces').click();
  await expectView(page, 'traces');
  await expect.poll(() => param(page, 'from')).toEqual(['now-6h']);
  await expect.poll(() => param(page, 'status')).toEqual(['Error']);
  await expect.poll(() => param(page, 'service')).toEqual(['checkout']);
  await expect(rangeButton(page, 'traces')).toHaveText('Time range · Last 6 hours');
  await expect.poll(() => param(page, 'q')).toEqual([]);

  // Back on Logs: its text search survived the round trip.
  await tab(page, 'logs').click();
  await expectView(page, 'logs');
  await expect.poll(() => param(page, 'q')).toEqual(['payment']);
  await expect(page.locator('#logsQuery')).toHaveValue('payment');
});

test('observability: a service picked in Logs filters Traces and opens its Metrics catalog group', async ({ page, request }) => {
  await features(request);
  const meta = await (await request.get('/api/metrics/meta')).json();
  test.skip(!meta.time_bounds, 'no metrics');
  const end = Number(meta.time_bounds.max_ms);
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const range = `from=${encodeURIComponent(fmt(end - 3600000))}&to=${encodeURIComponent(fmt(end + 1000))}`;
  // The catalog grouped by service (the By service switch).
  await page.addInitScript(() => { try { localStorage.setItem('chdash.metricsCatalogBy.v1', 'service'); } catch (_) {} });
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
  await expect.poll(() => param(page, 'service')).toEqual([service]);
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

test('observability: every "any value" picker reads All, never ALL', async ({ page, request }) => {
  await features(request);
  const button = (select) => page.locator(`.tracePicker:has(#${select}) > .tracePicker__button`);
  await mockTraceResults(page);
  await page.goto('/observability/traces');
  await expectView(page, 'traces');
  await expect(button('tracesStatus')).toHaveText('Status · All');
  await expect(button('tracesService')).toHaveText('Service · All');
  await expect(button('tracesOperation')).toHaveText('Operation · All');
  expect(await page.locator('#tracesStatus option').first().textContent()).toBe('All');
  await page.goto('/observability/traces?mode=spans');
  await expect(button('traceSpanKind')).toHaveText('Kind · All');
  await page.goto('/observability/logs');
  await expectView(page, 'logs');
  await expect(page.locator('#logsServiceButton')).toHaveText('Service · All');
  await expect(button('logsLevel')).toHaveText('Level · All');
  // Only that word changed case: the other labels keep theirs.
  await expect(page.locator('#logsLevel option[value="5"]')).toHaveText(/DEBUG/);
  expect(await page.locator('.tracePicker__button').evaluateAll((els) => els.map((el) => el.textContent).filter((text) => /\bALL\b/.test(text)))).toEqual([]);
});

test('observability: the former pages are gone', async ({ request }) => {
  for (const path of ['/traces', '/traces/0123456789abcdef0123456789abcdef', '/logs', '/metrics', '/static/observability.html']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
  expect((await request.get('/observability/traces/0123456789abcdef0123456789abcdef')).status()).toBe(200);
});

test('observability: each page loads its own modules and its own stylesheet, once', async ({ page, request }) => {
  await features(request);
  const MODULES = (view) => Object.fromEntries(VIEWS.map((v) => [v, v === view]));
  const OTHERS = { traces: ['app_logs.js', 'app_metrics.js', 'app_query_chart.js'], logs: ['app_traces.js', 'app_metrics.js', 'app_query_chart.js'], metrics: ['app_traces.js', 'app_logs.js', 'app_query_chart.js'] };
  for (const view of VIEWS) {
    const requested = [];
    const onRequest = (r) => { if (/\/static\/[^/]+\.(js|css)(\?|$)/.test(r.url())) requested.push(r.url().split('/').pop().split('?')[0]); };
    page.on('request', onRequest);
    await page.goto(`/observability/${view}`);
    await expectView(page, view);
    const state = await loaded(page);
    expect(state.modules, view).toEqual(MODULES(view));
    for (const name of OTHERS[view]) {
      expect(state.scripts.map((s) => s.split('?')[0]), `${view}: ${name}`).not.toContain(name);
      expect(requested, `${view}: ${name}`).not.toContain(name);
    }
    // The page's own sheet alone: the others' rules never reach it.
    expect(state.sheets.map((s) => s.split('?')[0]), view).toEqual([`style.${view}.css`]);
    // The views share the canvas chart engine and the page controller, loaded once.
    for (const name of ['app_obs_page.js', 'app_chart_core.js']) {
      expect(state.scripts.map((s) => s.split('?')[0]).filter((s) => s === name), `${view}: ${name}`).toHaveLength(1);
    }
    page.off('request', onRequest);
  }
  // The Logs page is styled by its own sheet (the filter bar's flex layout).
  await page.goto('/observability/logs');
  expect(await page.locator('#logsForm').evaluate((el) => getComputedStyle(el).display)).toBe('flex');
});

test('observability: a view the server turns off has no tab and its URLs fall back', async ({ page }) => {
  await page.route('**/api/version', async (route) => {
    // A request still in flight when the page leaves (the trace page below does) is let go.
    try {
      const response = await route.fetch();
      const json = await response.json();
      json.features = { ...json.features, traces: { enabled: false } };
      await route.fulfill({ response, json });
    } catch {
      // The page is gone.
    }
  });
  await page.goto('/observability');
  await expect.poll(() => pathOf(page)).toBe('/observability/logs');
  await expectView(page, 'logs');
  await expect(tab(page, 'traces')).toBeHidden();
  await expect(tab(page, 'metrics')).toBeVisible();
  await expect(page.locator('#obsTabs a:visible')).toHaveText(['Logs', 'Metrics']);
  await expect(page.locator('#tracesTabs')).toHaveCount(0);
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
  await expect.poll(() => page.evaluate(() => window.ChDash?.features?.known?.() === true)).toBe(true);
  // Traces alone: no view tabs, no separator, its own tabs on the row.
  await expect(page.locator('#obsTabs')).toBeHidden();
  await expect(page.locator('#obsNav .obsNav__sep')).toBeHidden();
  await expect(page.locator('#tracesTabs')).toBeVisible();
  // Logs alone: nothing to show, no row.
  only = 'logs';
  await page.goto('/observability/logs');
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', 'logs');
  await expect.poll(() => page.evaluate(() => window.ChDash?.features?.known?.() === true)).toBe(true);
  await expect(page.locator('#obsNav')).toBeHidden();
  await expect(page.locator('#logsForm')).toBeVisible();
});

for (const path of ['/query', '/explorer/catalog']) {
  test(`observability: the ${path} switcher opens the Observability page`, async ({ page, request }) => {
    await features(request);
    await page.goto(path);
    await page.locator('#pageSelectButton').click();
    await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toContainText(['Observability']);
    await page.locator('#navObservabilityButton').click();
    await expect.poll(() => pathOf(page)).toBe('/observability/traces');
    await expectView(page, 'traces');
    await page.locator('#pageSelectButton').click();
    await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Query', 'Explorer', 'System']);
    await page.locator('#navExplorerButton').click();
    await expect.poll(() => pathOf(page)).toMatch(/^\/explorer\/catalog/);
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
    const clipped = await page.locator('#obsTabs a', { hasText: name }).evaluate((el) => el.scrollWidth > el.clientWidth);
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

// --- Shared formats (docs/ui-foundations.md) --------------------------------
// One 24 h time in the browser's zone with an ISO tooltip, and en-US counts,
// whatever the browser's locale: Traces showed "Sep 12, 04:29:57 PM",
// Services "9/12/2026, 1:30:00 PM", the span inspector "Sep 12, 2026,
// 04:29:57.462 PM", and counts followed the locale ("2 000").
test.describe('observability formats on a French browser in Paris', () => {
  test.use({ locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  // The year shows only when it is not the current one.
  const sep20 = (clock) => `Sep 20${new Date().getFullYear() === 2026 ? '' : ', 2026'} ${clock}`;
  const TIME = /^[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d{2}:\d{2}:\d{2}$/;

  test('observability formats: trace list, table, header and span times are 24 h local with an ISO tooltip', async ({ page }) => {
    const trace = nestedTrace();
    await routeSearch(page, [trace]);
    await routeTrace(page, trace);
    await page.goto('/observability/traces');
    const result = page.locator(`#tracesResults [data-trace-id="${trace.trace_id}"]`);
    await expect(result).toBeVisible({ timeout: 20_000 });
    // 2026-09-20 01:22:52 UTC is 03:22:52 in Paris.
    await expect(result.locator('.traceResult__when time')).toHaveText(sep20('03:22:52'));
    await expect(result.locator('.traceResult__when small')).toHaveText(/^\d+ (?:second|minute|hour|day|week|month|year)s? ago$/);
    const title = await result.locator('.traceResult__when').getAttribute('title');
    expect(title.split('\n')).toContain('2026-09-20T01:22:52.000Z');
    expect(title).toMatch(/Europe\/Paris, UTC\+02:00/);
    await expect(result.locator('.traceTag--spans')).toHaveText('13 Spans');

    await result.click();
    await expect(page.locator('#traceDetail')).toBeVisible();
    const start = page.locator('#traceDetailStats [data-trace-header-item="Trace Start"] .statTile__value');
    await expect(start).toHaveText(sep20('03:22:52.000'));
    expect(await start.locator('time').getAttribute('title')).toContain('2026-09-20T01:22:52.000Z');
    // The span inspector: the start offset, then the local time to the ms.
    await page.locator('#traceWaterfall .traceSpanRow[data-span-id="0000000000000002"]').click();
    const inspector = page.locator('[data-inspector-span="0000000000000002"]');
    await expect(inspector.locator('.traceInspectorHead__abs')).toHaveText(sep20('03:22:52.002'));
    const abs = await inspector.locator('.traceInspectorHead__abs').evaluate((el) => el.parentElement.getAttribute('title'));
    expect(abs.split('\n')[0]).toBe('2026-09-20T01:22:52.002Z');
    expect(abs).toContain('Sep 20, 2026 01:22:52.002000000 UTC');
  });

  test('observability formats: counts are grouped en-US on a French browser', async ({ page }) => {
    const trace = largeTrace(2000);
    await routeTrace(page, trace);
    await page.goto(`/observability/traces/${trace.trace_id}`);
    await expect(page.locator('#traceDetailStats [data-trace-header-item="Total Spans"] .statTile__value')).toHaveText('2,000', { timeout: 30_000 });
  });

  test('observability formats: Services releases and slowest spans print 24 h local times', async ({ page }) => {
    await mockTraceServices(page);
    await mockTraceResults(page);
    await page.goto('/observability/traces?tab=services&svc=checkout');
    const drawer = page.locator('#traceSvcDetail');
    await expect(drawer.locator('.traceSvcReleases li')).toHaveCount(2, { timeout: 30_000 });
    for (const when of await drawer.locator('.traceSvcReleases li span, .traceSvcSlowest__time').all()) {
      await expect(when).toHaveText(TIME);
      expect(await when.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n/);
    }
  });

  test('observability formats: a log reads to the ms in the table and every nanosecond in its detail', async ({ page }) => {
    // 2026-09-20 01:22:55.742983150 UTC.
    const row = {
      id: '1789867375742983150-1', ts_ns: '1789867375742983150', ts_ms: 1789867375742, service: 'fmt_service', severity_text: 'FATAL', severity_number: 21,
      body: 'format check', trace_id: '', span_id: '', trace_flags: 0, scope_name: '', scope_version: '',
      log_attributes: {}, resource_attributes: {}, scope_attributes: {},
    };
    await page.route('**/api/logs/search**', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ v: 1, rows: [row], row_count: 1, next_cursor: null, exhausted: true, truncated: false, mode: 'page', tail_gap: false, windows: [], text_search: { active: false } }),
    }));
    await page.goto('/observability/logs?from=2026-09-20%2000:00:00&to=2026-09-20%2006:00:00');
    const tableRow = page.locator('#logsTableRows .logsRow[data-row-id]').first();
    await expect(tableRow.locator('.logsCell--time')).toHaveText(sep20('03:22:55.742'), { timeout: 30_000 });
    expect(await tableRow.locator('.logsCell--time').getAttribute('title')).toContain('Sep 20, 2026 01:22:55.742983150 UTC');
    // Severity 21 is fatal: a solid chip in its own colour, not the error one.
    await expect(tableRow.locator('.badge--sev')).toHaveAttribute('data-sev', 'fatal');
    await expect(tableRow.locator('.badge--sev')).toHaveClass(/badge--solid/);
    // Polled: the virtual row may re-render (a detached badge has no style).
    await expect.poll(() => tableRow.locator('.badge--sev').evaluate((badge) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--sev-fatal)';
      document.body.appendChild(probe);
      const fill = getComputedStyle(badge).backgroundColor;
      const same = !!fill && fill === getComputedStyle(probe).color;
      probe.remove();
      return same;
    })).toBe(true);
    await tableRow.click();
    await expect(page.locator('#logsSideTitle .logsSideTitle__time')).toHaveText(sep20('03:22:55.742983150'));
  });
});

test('observability formats: a Metrics series grouped by service takes the service colour of Traces and Logs', async ({ page, request }) => {
  const meta = await (await request.get('/api/metrics/meta')).json();
  test.skip(!meta.enabled, 'metrics are disabled');
  const bounds = meta.kinds.gauge?.time_bounds || meta.kinds.histogram.time_bounds;
  const end = Math.floor(Number(bounds.max_ms) / 60000) * 60000;
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  // Real series, relabelled as two services (the panel used to colour them
  // with the chart slots, unlike Traces and Logs).
  const names = ['checkout', 'frontend'];
  await page.route('**/api/metrics/series?**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.series = (body.series || []).filter((s) => !s.other).slice(0, 2).map((s, i) => ({ ...s, key: names[i], labels: { 'service.name': names[i] } }));
    body.group_by = ['service.name'];
    body.other_series_count = 0;
    await route.fulfill({ response, json: body });
  });
  const params = new URLSearchParams({ from: stamp(end - 6 * 3600000), to: stamp(end), service: 'api_service', metric: 'process.cpu.utilization', kind: 'gauge', group_by: 'host.name', exemplars: '0' });
  await page.goto(`/observability/metrics?${params}`);
  const legend = page.locator('.metricsPanel .chartCore__legendItem');
  await expect(legend).toHaveCount(2, { timeout: 30_000 });
  for (const name of names) {
    const swatch = await legend.filter({ hasText: name }).locator('i').evaluate((el) => getComputedStyle(el).backgroundColor);
    const expected = await page.evaluate((service) => window.ChDash.palette.resolve(window.ChDash.palette.service(service, { assign: false })), name);
    expect(swatch, name).toBe(expected);
  }
});
