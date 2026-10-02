import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { mockTraceFacets, mockTraceResults } from '../helpers/traces.js';
import {
  settle, cameraIdle, contrast, tokenColors, pixel, colorDistance, expectDotGrid, expectKitChrome, expectLabelsClear, measureFrames, installFrameProbe, freeArea, expectClearOfChrome, expectTouchCanvas,
} from '../helpers/graph-kit.js';

// Service map tab of the Traces page (after HyperDX's DBServiceMapPage), drawn
// with the shared canvas graph kit like the Explorer graph: tab state in the
// URL, the search filters on /api/traces/service_map, the layered layout with
// orthogonal edges, cards (service colour strip, spans · errors, p95, health),
// edges (dash = call kind, colour = errors, width = calls) and their always
// visible "calls · p95" labels, hover halo, click = recentre + select, the
// hand-off to the Search tab, keyboard access, the phone layout (the canvas
// with touch pan / pinch and a bottom-sheet panel: there is no List view),
// both themes and performance budgets.
// The graphs are mocked (the OTel fixture is one flat star); one smoke test
// reads the fixture. ChDash.traceMap.inspect() reports the drawn frame in
// client coordinates.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const MS = 1e6;
const node = (service, spans, errors, p95) => ({
  service, spans, errors, error_rate: spans ? errors / spans : 0, sampled_count: Math.round(spans / 12), p50_ns: p95 * MS / 3, p95_ns: p95 * MS, p99_ns: p95 * MS * 1.4,
});
const edge = (source, target, calls, errors, p95, kind = 'sync') => ({ source, target, kind, ...node('', calls, errors, p95), service: undefined, calls });

// A chain, a fan-out, a cycle (email <-> checkout), an erroring edge, an
// asynchronous (producer -> consumer) call and an isolated service.
export const MAP = {
  v: 1, source_host_id: 'local', range: [0, 3600_000], edge_rule: 'parent_child_cross_service',
  sampled: true, sample_factor: 12, truncated: false,
  sampling: { trace_factor: 4, time_coverage: 1 / 3, slices: 7, estimated_spans: 36_000_000, estimate_source: 'explain' },
  timing_ms: { estimate: 3, query: 280, total: 290 },
  nodes: [
    node('frontend', 1_200_000, 2_400, 180), node('cart', 600_000, 0, 40), node('redis', 900_000, 0, 2),
    node('checkout', 400_000, 24_000, 320), node('payment', 150_000, 3_000, 900), node('postgres', 300_000, 30, 12),
    node('email', 50_000, 0, 60), node('cron', 1_000, 0, 5),
  ],
  edges: [
    edge('frontend', 'checkout', 400_000, 24_000, 320), edge('frontend', 'cart', 600_000, 0, 40),
    edge('cart', 'redis', 900_000, 0, 2), edge('checkout', 'payment', 150_000, 3_000, 900),
    edge('checkout', 'postgres', 200_000, 20, 12), edge('payment', 'postgres', 100_000, 10, 14),
    edge('checkout', 'email', 50_000, 0, 60, 'async'), edge('email', 'checkout', 5_000, 0, 30),
  ],
};

async function mockMap(page, { payload = MAP, status = 200, delayMs = 0 } = {}) {
  const requests = [];
  await page.route('**/api/traces/service_map?**', async (route) => {
    requests.push(new URL(route.request().url()).searchParams);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (status !== 200) return route.fulfill({ status, json: { error_code: 'trace_service_map_failed', message: 'Timeout exceeded: elapsed 30 seconds' } });
    return route.fulfill({ json: payload });
  });
  return requests;
}

const inspect = (page) => page.evaluate(() => window.ChDash.traceMap.inspect());
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

async function service(page, name) {
  const state = await inspect(page);
  const found = state.nodes.find((candidate) => candidate.service === name);
  expect(found, `${name} is drawn`).toBeTruthy();
  return found;
}

async function label(page, source, target) {
  const state = await inspect(page);
  const found = state.edgeLabels.find((candidate) => candidate.id === `${source}\x1f${target}`);
  expect(found, `${source} -> ${target} label is drawn`).toBeTruthy();
  return found;
}

async function openMap(page, query = '', count = MAP.nodes.length) {
  await page.goto(`/observability/traces?tab=map${query ? `&${query}` : ''}`);
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0)), { timeout: 30_000 }).toBe(count);
  await settle(page);
}

test('the Service map tab lives in the URL and sends the search filters', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await mockTraceFacets(page);
  const maps = await mockMap(page);
  await page.goto('/observability/traces?from=now-2h&to=now&status=Error&tag=span%3Ahttp.method%3DGET&service_not=cron');
  await expect(page.locator('#tracesResults .traceResultItem').first()).toBeVisible({ timeout: 30_000 });
  const tab = page.locator('#tracesTab-map');
  await expect(tab).toHaveAttribute('aria-selected', 'false');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#traceMapView')).toBeVisible();
  await expect(page.locator('.traceSearchBody')).toBeHidden();
  await expect.poll(() => new URL(page.url()).searchParams.get('tab')).toBe('map');
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(MAP.nodes.length);
  expect((await inspect(page)).edges).toHaveLength(MAP.edges.length);
  const sent = maps[maps.length - 1];
  expect(sent.get('status')).toBe('Error');
  expect(sent.getAll('tag')).toEqual(['span:http.method=GET']);
  expect(sent.getAll('service_not')).toEqual(['cron']);
  expect(Number(sent.get('end_ms')) - Number(sent.get('start_ms'))).toBe(2 * 3600_000);
  // The search bar and chips stay: they filter the map too.
  await expect(page.locator('#tracesForm')).toBeVisible();
  await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(2);

  // Search on the map tab refreshes the map, not the result list.
  const listBefore = searches.length;
  const mapBefore = maps.length;
  await page.locator('#tracesSearchButton').click();
  await expect.poll(() => maps.length).toBeGreaterThan(mapBefore);
  expect(searches.length).toBe(listBefore);

  // Reload keeps the tab; Back returns to the Search tab.
  await page.reload();
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0)), { timeout: 30_000 }).toBe(MAP.nodes.length);
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page.locator('#tracesTab-search')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.traceSearchBody')).toBeVisible();
  await expect(page.locator('#traceMapView')).toBeHidden();
  await page.goForward();
  await expect(page.locator('#traceMapView')).toBeVisible();
  // Keyboard: arrows move between tabs (Search | Services | Service map).
  await tab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#tracesTab-services')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#tracesTab-search')).toHaveAttribute('aria-selected', 'true');
});

test('cards, orthogonal edges, dash by call kind, labels on every edge, the legend and the sampled badge in the status line', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  await openMap(page);
  const state = await inspect(page);
  expect(state.kit).toBe(true);
  // The kit chrome: icon toolbar, legend and status line bottom-left, dot grid.
  await expectKitChrome(page, {
    pane: '#traceMapPane', zoomOut: '#traceMapZoomOut', fit: '#traceMapFit', zoomIn: '#traceMapZoomIn',
    legend: '#traceMapLegend', status: '#traceMapPane .graphKitStatus',
  });
  const colors = await tokenColors(page, ['--graph-bg', '--bg', '--graph-error', '--graph-warn', '--graph-edge-muted']);
  expect(colors['--graph-bg']).toEqual(colors['--bg']);
  await expectDotGrid(page, '#traceMapCanvas', state, colors['--graph-bg']);
  const badge = page.locator('#traceMapSampled');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('sampled ×12');
  await expect(badge).toHaveAttribute('title', /1 trace in 4 and 7 time slices/);
  await expect(page.locator('#traceMapPane .graphKitStatus')).toContainText('8 services · 8 call paths');
  await expect(page.locator('#traceMapLegend')).toContainText('synchronous call');
  await expect(page.locator('#traceMapLegend')).toContainText('asynchronous message');
  await expect(page.locator('#traceMapLegend')).toContainText('Health dot');
  // The fit leaves the toolbar, legend and status line free of cards and labels.
  await expectClearOfChrome(page, '#traceMapPane', state);

  // Callers left of their callees: one column per call depth.
  const at = Object.fromEntries(state.nodes.map((n) => [n.service, n]));
  expect(at.checkout.x).toBeGreaterThan(at.frontend.x);
  expect(at.payment.x).toBeGreaterThan(at.checkout.x);
  expect(at.postgres.x).toBeGreaterThan(at.payment.x);
  // Rectangular cards of one size; the strip is the Traces service colour.
  const sizes = new Set(state.nodes.map((n) => `${Math.round(n.width)}x${Math.round(n.height)}`));
  expect(sizes.size).toBe(1);
  // The strip pixel is the service colour the Traces list uses (--trace-span-color-N).
  const strip = await pixel(page, '#traceMapCanvas', at.checkout.x + 2, at.checkout.y + at.checkout.height / 2);
  const serviceRgb = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.append(probe);
    probe.style.color = window.ChDash.palette.service('checkout');
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
    probe.remove();
    return rgb;
  });
  expect(await page.evaluate(() => window.ChDash.palette.service('checkout'))).toMatch(/^var\(--trace-span-color-\d+\)$/);
  expect(colorDistance(strip, serviceRgb)).toBeLessThan(12);
  // Health: checkout (6 %) and payment (2 %) carry the dot, cart (0 %) not.
  expect(at.checkout.health).toBe(true);
  expect(at.checkout.severity).toBe('err');
  expect(at.payment.severity).toBe('warn');
  expect(at.cart.health).toBe(false);
  // Everything is inside the canvas after the fit.
  const canvas = await page.locator('#traceMapCanvas').boundingBox();
  for (const n of state.nodes) {
    expect(n.x, n.service).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(n.x + n.width, n.service).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(n.y + n.height, n.service).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }
  // Orthogonal edges; dash pattern = call kind; colour = error severity;
  // width grows mildly with the calls; the cycle's back call is routed too.
  const edgeOf = (source, target) => state.edges.find((e) => e.source === source && e.target === target);
  for (const e of state.edges) expect(e.orthogonal, e.id).toBe(true);
  expect(edgeOf('frontend', 'checkout').severity).toBe('err');
  expect(edgeOf('checkout', 'payment').severity).toBe('warn');
  expect(edgeOf('cart', 'redis').severity).toBe('ok');
  expect(edgeOf('checkout', 'email').kind).toBe('async');
  expect(edgeOf('checkout', 'email').dash.length).toBeGreaterThan(0);
  expect(edgeOf('frontend', 'cart').dash).toEqual([]);
  expect(edgeOf('email', 'checkout').back).toBe(true);
  expect(edgeOf('cart', 'redis').width).toBeGreaterThan(edgeOf('email', 'checkout').width);
  expect(edgeOf('cart', 'redis').width).toBeLessThanOrEqual(3.6);
  // Every edge carries its "calls · p95" label, none on another label or a card.
  expect(state.edgeLabels).toHaveLength(MAP.edges.length);
  expect(state.edgeLabels.find((l) => l.id === 'cart\x1fredis').text).toBe('900K · p95 2 ms');
  expectLabelsClear(state);
  // No minimap while everything is visible.
  expect(state.minimapVisible).toBe(false);
});

test('zoom tools, + - 0 keys, wheel and drag pan, and the minimap once a card is clipped', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  await openMap(page);
  const fitted = await inspect(page);
  await page.locator('#traceMapZoomIn').click();
  await page.locator('#traceMapZoomIn').click();
  // The fit leaves room for the chrome: a wide screen may need a third step.
  if (!(await inspect(page)).minimapVisible) await page.locator('#traceMapZoomIn').click();
  let state = await inspect(page);
  expect(state.scale).toBeGreaterThan(fitted.scale);
  expect(state.minimapVisible).toBe(true);
  await expect(page.locator('#traceMapMinimap')).toBeVisible();
  await page.locator('#traceMapFit').click();
  state = await inspect(page);
  expect(state.scale).toBeCloseTo(fitted.scale, 6);
  expect(state.offsetX).toBeCloseTo(fitted.offsetX, 3);
  const canvas = page.locator('#traceMapCanvas');
  await canvas.focus();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  const zoomed = (await inspect(page)).scale;
  expect(zoomed).toBeGreaterThan(fitted.scale);
  await page.keyboard.press('-');
  expect((await inspect(page)).scale).toBeLessThan(zoomed);
  // Zooming out stops at the whole-map overview (the Fit when it all fits).
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('-');
  const floor = (await inspect(page)).scale;
  expect(floor).toBeLessThanOrEqual(fitted.scale + 1e-6);
  await page.keyboard.press('-');
  expect((await inspect(page)).scale).toBeCloseTo(floor, 6);
  await page.keyboard.press('+');
  await page.keyboard.press('0');
  expect((await inspect(page)).scale).toBeCloseTo(fitted.scale, 6);
  // Wheel zoom and drag pan.
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.wheel(0, -200);
  expect((await inspect(page)).scale).not.toBeCloseTo(fitted.scale, 3);
  const before = await inspect(page);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 180, { steps: 5 });
  await page.mouse.up();
  const after = await inspect(page);
  expect(after.offsetX).not.toBeCloseTo(before.offsetX, 0);
  await expect(page.locator('#traceMapPanel')).toBeHidden();
});

test('hover outlines the service and its calls, with no dimming and no tooltip', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  await openMap(page);
  const checkout = await service(page, 'checkout');
  const cart = await service(page, 'cart');
  const halo = (await tokenColors(page, ['--graph-halo']))['--graph-halo'];
  const top = (n) => pixel(page, '#traceMapCanvas', n.x + n.width / 2, n.y + 0.5);
  const beforeCheckout = await top(checkout);
  const beforeCart = await top(cart);
  await page.mouse.move(checkout.x + checkout.width / 2, checkout.y + checkout.height / 2);
  await settle(page);
  const state = await inspect(page);
  expect(state.hovered).toEqual({ type: 'node', id: 'checkout' });
  await expect(page.locator('#traceMapCanvas')).toHaveClass(/is-clickable/);
  expect(colorDistance(await top(checkout), halo)).toBeLessThan(colorDistance(beforeCheckout, halo));
  expect(colorDistance(await top(cart), beforeCart)).toBeLessThan(2);
  await expect(page.locator('#traceMapView [role="tooltip"]')).toHaveCount(0);
  // An edge (its label) is hoverable too.
  const cartRedis = await label(page, 'cart', 'redis');
  await page.mouse.move(cartRedis.x + cartRedis.width / 2, cartRedis.y + cartRedis.height / 2);
  await settle(page);
  expect((await inspect(page)).hovered).toEqual({ type: 'edge', id: 'cart\x1fredis' });
  await page.mouse.move(2, 2);
  await settle(page);
  expect((await inspect(page)).hovered).toBe(null);
});

test('a click recentres on the service and opens its panel; "Search this service" hands off to the Search tab', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await mockTraceFacets(page);
  await mockMap(page);
  await openMap(page, 'tag=http.route%3D%2Fcheckout');
  const checkout = await service(page, 'checkout');
  await page.mouse.click(checkout.x + checkout.width / 2, checkout.y + checkout.height / 2);
  const panel = page.locator('#traceMapPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/graphKitPanel/);
  await expect(panel.locator('.graphKitPanel__eyebrow')).toHaveText('Service');
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('checkout');
  await expect(panel).toContainText('400K');
  await expect(panel).toContainText('6%');
  await expect(panel.locator('.traceMapPanel__list').first()).toContainText('frontend');
  await expect(panel.locator('.traceMapPanel__list').nth(1).locator('.traceMapPanel__edge')).toHaveCount(3);
  await cameraIdle(page, 'ChDash.traceMap');
  let state = await inspect(page);
  expect(state.selected).toEqual({ kind: 'node', id: 'checkout' });
  // Recentred in the area the panel and the chrome leave free (the kit's
  // safe area: below the toolbar, above the legend and status line).
  const canvas = await page.locator('#traceMapCanvas').boundingBox();
  const panelBox = await panel.boundingBox();
  const free = await freeArea(page, '#traceMapCanvas', '#traceMapPanel');
  const moved = state.nodes.find((n) => n.service === 'checkout');
  expect(Math.abs(center(moved).x - (canvas.x + (panelBox.x - canvas.x) / 2))).toBeLessThan(3);
  expect(Math.abs(center(moved).y - (free.y + free.height / 2))).toBeLessThan(3);
  // An outbound edge row selects that edge.
  await panel.locator('.traceMapPanel__edge', { hasText: 'payment' }).click();
  await expect(panel).toContainText('Search calls checkout → payment');
  await panel.locator('[data-map-select-node]').first().click();
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('checkout');
  // Escape closes; the keyboard reopens it (Enter on the focused service).
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.locator('#traceMapCanvas').focus();
  await page.keyboard.press('ArrowRight');
  state = await inspect(page);
  expect(state.keyboardId).toBeTruthy();
  const chosen = state.keyboardId;
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.graphKitPanel__title')).toHaveText(chosen);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await cameraIdle(page, 'ChDash.traceMap');
  const again = await service(page, 'checkout');
  await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
  await expect(panel).toBeVisible();

  const before = searches.length;
  await panel.getByRole('button', { name: 'Search this service' }).click();
  await expect.poll(() => searches.length).toBeGreaterThan(before);
  const last = searches[searches.length - 1];
  expect(last.service).toBe('checkout');
  expect(last.tag).toBe('http.route=/checkout');
  await expect(page.locator('#tracesTab-search')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.traceSearchBody')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('service')).toBe('checkout');
  expect(new URL(page.url()).searchParams.has('tab')).toBe(false);
  // Back: the map again, as it was.
  await page.goBack();
  await expect(page.locator('#traceMapView')).toBeVisible();
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(MAP.nodes.length);
});

test('an edge label opens the call panel and "Search errors" searches the callee; Focus map keeps the map', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await mockTraceFacets(page);
  const maps = await mockMap(page);
  await openMap(page);
  const call = await label(page, 'checkout', 'payment');
  expect(call.text).toBe('150K · p95 900 ms');
  await page.mouse.click(call.x + call.width / 2, call.y + call.height / 2);
  const panel = page.locator('#traceMapPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-panel-type', 'edge');
  await expect(panel.locator('.graphKitPanel__eyebrow')).toHaveText('Synchronous calls');
  await expect(panel).toContainText('checkout');
  await expect(panel).toContainText('payment');
  await expect(panel).toContainText('150K');
  expect((await inspect(page)).selected).toEqual({ kind: 'edge', id: 'checkout\x1fpayment' });
  await panel.getByRole('button', { name: 'Search errors' }).click();
  await expect.poll(() => searches.length).toBeGreaterThan(0);
  const last = searches[searches.length - 1];
  expect(last.service).toBe('payment');
  expect(last.status).toBe('Error');
  await expect(page.locator('.traceSearchBody')).toBeVisible();

  // "Focus map" keeps the map tab with the service filter.
  await page.locator('#tracesTab-map').click();
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(MAP.nodes.length);
  const cart = await service(page, 'cart');
  await page.mouse.click(cart.x + cart.width / 2, cart.y + cart.height / 2);
  const before = maps.length;
  await panel.getByRole('button', { name: 'Focus map' }).click();
  await expect.poll(() => maps.length).toBeGreaterThan(before);
  expect(maps[maps.length - 1].get('service')).toBe('cart');
  await expect(page.locator('#traceMapView')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('tab')).toBe('map');
});

test('loading, empty, services-only and error states', async ({ page }) => {
  await mockTraceResults(page);
  let mode = 'slow';
  await page.route('**/api/traces/service_map?**', async (route) => {
    if (mode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return route.fulfill({ json: { ...MAP, nodes: [], edges: [], sampled: false, sample_factor: 1 } });
    }
    if (mode === 'nodes') return route.fulfill({ json: { ...MAP, nodes: [node('solo', 10, 0, 3)], edges: [], sampled: false, sample_factor: 1 } });
    return route.fulfill({ status: 503, json: { error_code: 'trace_service_map_failed', message: 'Timeout exceeded: elapsed 30 seconds' } });
  });
  await page.goto('/observability/traces?tab=map');
  await expect(page.locator('#traceMapState')).toContainText('Loading service map', { timeout: 30_000 });
  await expect(page.locator('#traceMapView')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#traceMapState')).toContainText('No services in this time range', { timeout: 10_000 });
  await expect(page.locator('#traceMapSampled')).toBeHidden();
  mode = 'nodes';
  await page.locator('#tracesSearchButton').click();
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(1);
  await expect(page.locator('#traceMapState')).toContainText('No calls between services');
  mode = 'error';
  await page.locator('#tracesSearchButton').click();
  await expect(page.locator('#traceMapState [role="alert"]')).toContainText('Timeout exceeded');
  mode = 'nodes';
  await page.locator('#traceMapState [data-map-retry]').click();
  await expect(page.locator('#traceMapState [role="alert"]')).toHaveCount(0);
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(1);
});

test('service map: no page overflow and readable tokens in both themes', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  for (const theme of ['dark', 'light']) {
    await page.goto('/observability/traces');
    await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
    await openMap(page);
    const checkout = await service(page, 'checkout');
    await page.mouse.click(checkout.x + checkout.width / 2, checkout.y + checkout.height / 2);
    await expect(page.locator('#traceMapPanel')).toBeVisible();
    await cameraIdle(page, 'ChDash.traceMap');
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x, theme).toBeLessThanOrEqual(1);
    expect(overflow.y, theme).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(theme);
    const tokens = await tokenColors(page, ['--graph-text', '--graph-muted', '--graph-warn', '--graph-error', '--graph-halo', '--graph-node-bg', '--graph-label-bg', '--graph-edge-muted']);
    for (const name of ['--graph-text', '--graph-muted', '--graph-warn', '--graph-error']) {
      expect(contrast(tokens[name], tokens['--graph-node-bg']), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens[name], tokens['--graph-label-bg']), `${theme} ${name} on labels`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens['--graph-halo'], tokens['--graph-node-bg'])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens['--graph-edge-muted'], tokens['--graph-node-bg'])).toBeGreaterThanOrEqual(3);
    // Text stays at least 11 px on screen at Fit (12 px fonts).
    const state = await inspect(page);
    expect(state.scale * 12).toBeGreaterThanOrEqual(11 - 1e-6);
    const vp = page.viewportSize();
    await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/map-${theme}-${vp.width}.png` });
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('phones show the map canvas (no list), pan and pinch by touch and open details as a bottom sheet', async ({ page }) => {
    await mockTraceResults(page);
    await mockMap(page);
    await openMap(page);
    await expect(page.locator('#traceMapList, #traceMapListViewButton, #traceMapCanvasViewButton')).toHaveCount(0);
    await expectTouchCanvas(page, { pane: '#traceMapPane', canvas: '#traceMapCanvas', zoomIn: '#traceMapZoomIn', inspect: () => inspect(page) });
    // Fit from the icon toolbar, then a tap on a card on screen opens its sheet.
    await page.locator('#traceMapFit').tap();
    await settle(page);
    const canvas = await page.locator('#traceMapCanvas').boundingBox();
    const dock = await page.locator('#traceMapPane .graphKitDock').boundingBox();
    const state = await inspect(page);
    const target = state.nodes.find((n) => n.x >= canvas.x && n.x + n.width <= canvas.x + canvas.width && n.y > canvas.y + 60 && n.y + n.height < dock.y);
    expect(target, 'a service fully on screen').toBeTruthy();
    await page.touchscreen.tap(target.x + target.width / 2, target.y + target.height / 2);
    const panel = page.locator('#traceMapPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.graphKitPanel__title')).toHaveText(target.service);
    const pane = await page.locator('#traceMapPane').boundingBox();
    const sheet = await panel.boundingBox();
    expect(sheet.width).toBeGreaterThan(390 - 40);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    // Recentred above the sheet.
    await cameraIdle(page, 'ChDash.traceMap');
    const moved = (await inspect(page)).nodes.find((n) => n.service === target.service);
    expect(moved.y + moved.height / 2).toBeLessThan(sheet.y);
    expect((await inspect(page)).selected).toEqual({ kind: 'node', id: target.service });
    await panel.locator('.graphKitPanel__close').tap();
    await expect(panel).toBeHidden();
  });
});

test('performance budget: a 120-service map lays out, routes and redraws within budget', async ({ page }) => {
  test.setTimeout(120_000);
  // 120 services in 6 tiers, each calling 2-3 services of the next tier.
  const nodes = [];
  const edges = [];
  for (let tier = 0; tier < 6; tier += 1) {
    for (let i = 0; i < 20; i += 1) nodes.push(node(`svc-${tier}-${i}`, 100_000 - tier * 1000 - i, (i % 7) * 100, 10 + i));
  }
  for (let tier = 0; tier < 5; tier += 1) {
    for (let i = 0; i < 20; i += 1) {
      for (const step of [0, 3, 11].slice(0, 2 + (i % 2))) edges.push(edge(`svc-${tier}-${i}`, `svc-${tier + 1}-${(i + step) % 20}`, 5_000 + i * 10, i % 5, 20 + i, i % 4 ? 'sync' : 'async'));
    }
  }
  await mockTraceResults(page);
  await mockMap(page, { payload: { ...MAP, nodes, edges } });
  await installFrameProbe(page);
  const load = await measureFrames(page, () => openMap(page, '', nodes.length), { reset: false });
  expect(load.longMs, 'long tasks while loading the map (ms)').toBeLessThan(4000);
  const state = await inspect(page);
  expect(state.edges.length).toBe(edges.length);
  for (const e of state.edges) expect(e.orthogonal, e.id).toBe(true);
  // 50 routes share each column gap here: most labels still find a free spot.
  expect(state.edgeLabelsDropped.length, 'labels without a free spot').toBeLessThan(edges.length * 0.15);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
  const box = await page.locator('#traceMapCanvas').boundingBox();
  const pan = await measureFrames(page, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 20; i += 1) { await page.mouse.move(box.x + box.width / 2 - i * 9, box.y + box.height / 2 - i * 4); await settle(page); }
    await page.mouse.up();
  });
  expect(pan.p95, 'pan frame p95 (ms)').toBeLessThan(25);
});

test('service map smoke on the OTel fixture', async ({ page, request }) => {
  const start = Date.UTC(2026, 8, 18, 10, 0, 0);
  const probe = await request.get(`/api/traces/service_map?start_ms=${start}&end_ms=${start + 600_000}`, { timeout: 60_000 });
  expect(probe.ok()).toBe(true);
  const body = await probe.json();
  test.skip(!body.nodes?.length, 'OTel fixture has no spans on 2026-09-18');
  // Every call has a kind: sync, or async for producer / consumer spans.
  for (const e of body.edges) expect(['sync', 'async']).toContain(e.kind);
  await page.goto('/observability/traces?tab=map&from=2026-09-18%2010%3A00%3A00&to=2026-09-18%2011%3A00%3A00');
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0)), { timeout: 60_000 }).toBeGreaterThan(0);
  const state = await inspect(page);
  expect(state.nodes.length).toBe(body.nodes.length);
  expect(state.edges.length).toBe(body.edges.length);
  expectLabelsClear(state);
  // The fixture's peak hour holds ~33 M spans: time slices and trace sampling.
  await expect(page.locator('#traceMapSampled')).toBeVisible();
  await expect(page.locator('#traceMapSampled')).toHaveText(/^sampled ×\d+/);
  const vp = page.viewportSize();
  await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/fixture-dark-${vp.width}.png` });
});
