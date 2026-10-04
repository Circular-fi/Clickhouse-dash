import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { mockTraceFacets, mockTraceResults } from '../helpers/traces.js';
import {
  settle, cameraIdle, contrast, tokenColors, pixel, colorDistance, expectDotGrid, expectKitChrome, expectLabelsClear, measureFrames, installFrameProbe, visibleArea, expectCentred, expectClearOfChrome, expectTouchCanvas, expectFullFit, expectFit, expectLevelOfDetail, expectOwnLanes,
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
  await expect(page.locator('#traceMapLegend')).toContainText('Synchronous call');
  await expect(page.locator('#traceMapLegend')).toContainText('Asynchronous message');
  // Sentence case: every legend line starts with a capital (or a figure).
  for (const text of await page.locator('#traceMapLegend .graphKitLegend__row > span').allTextContents()) {
    expect(text, text).toMatch(/^[A-Z<\d]/);
  }
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

test('the health dot, border and edges take the shared thresholds: 0.5 % nothing, 2 % amber, 7 % red', async ({ page }) => {
  const payload = {
    ...MAP, sampled: false, sample_factor: 1, sampling: null,
    nodes: [node('frontend', 100_000, 500, 100), node('cart', 100_000, 2_000, 40), node('checkout', 100_000, 7_000, 300)],
    edges: [edge('frontend', 'cart', 100_000, 500, 40), edge('frontend', 'checkout', 100_000, 2_000, 300), edge('checkout', 'cart', 50_000, 3_500, 30)],
  };
  await mockTraceResults(page);
  await mockMap(page, { payload });
  await openMap(page, '', 3);
  const state = await inspect(page);
  const at = Object.fromEntries(state.nodes.map((n) => [n.service, n]));
  expect([at.frontend.severity, at.frontend.health, at.frontend.status]).toEqual(['ok', false, null]);
  expect([at.cart.severity, at.cart.health, at.cart.status]).toEqual(['warn', true, 'warn']);
  expect([at.checkout.severity, at.checkout.health, at.checkout.status]).toEqual(['err', true, 'error']);
  const edgeOf = (source, target) => state.edges.find((e) => e.source === source && e.target === target);
  expect(edgeOf('frontend', 'cart').severity).toBe('ok');
  expect(edgeOf('frontend', 'checkout').severity).toBe('warn');
  expect(edgeOf('checkout', 'cart').severity).toBe('err');
  await expect(page.locator('#traceMapLegend')).toContainText('Health dot: amber 1–5% errors, red ≥ 5% with a red border');
  await expect(page.locator('#traceMapLegend .graphKitLegend__dot--warn')).toHaveCount(1);
  // The dots as drawn: amber on cart, red on checkout, none on frontend.
  const colors = await tokenColors(page, ['--graph-warn', '--graph-error']);
  const dot = (n) => pixel(page, '#traceMapCanvas', n.x + n.width - 16 * state.scale, n.y + 17 * state.scale);
  expect(colorDistance(await dot(at.cart), colors['--graph-warn'])).toBeLessThan(40);
  expect(colorDistance(await dot(at.checkout), colors['--graph-error'])).toBeLessThan(40);
  const none = await dot(at.frontend);
  expect(colorDistance(none, colors['--graph-warn'])).toBeGreaterThan(80);
  expect(colorDistance(none, colors['--graph-error'])).toBeGreaterThan(80);
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
  // Recentred in the visible canvas the panel and the chrome leave free (the
  // kit's visible area: below the toolbar, above the legend, status line and
  // minimap).
  const canvas = await page.locator('#traceMapCanvas').boundingBox();
  const panelBox = await panel.boundingBox();
  const free = await visibleArea(page, '#traceMapCanvas', '#traceMapPanel');
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

  // "Focus map" keeps the map tab with the service filter. Back on its tab,
  // the map first loads the current filters (the callee's errors): wait for
  // that load, or the card is picked on the map it replaces and "Focus map"'s
  // own request races it.
  const shown = maps.length;
  await page.locator('#tracesTab-map').click();
  await expect.poll(() => maps.length).toBeGreaterThan(shown);
  expect(maps[maps.length - 1].get('service')).toBe('payment');
  await expect(page.locator('#traceMapView')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await inspect(page)).nodes.length).toBe(MAP.nodes.length);
  await cameraIdle(page, 'ChDash.traceMap');
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
    // Fit opens readable (kit.fitView): the whole map on a wide screen, the
    // readable scale on the entry point once it is slightly too large.
    await cameraIdle(page, 'ChDash.traceMap');
    await settle(page);
    const fitted = await inspect(page);
    const opened = await expectFit(page, { canvas: '#traceMapCanvas', minimap: '#traceMapMinimap' }, fitted, 'frontend');
    if (page.viewportSize().width >= 1440) expect(opened).toBe('whole');
    expect(fitted.compact).toBe(false);
    expectOwnLanes(fitted, 12 * fitted.scale);
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
    // A click recentres on the service without zooming: still the Fit scale.
    expect(Math.abs((await inspect(page)).scale - fitted.scale)).toBeLessThan(1e-6);
    const vp = page.viewportSize();
    await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/map-${theme}-${vp.width}.png` });
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});

// Focus centring (user, 2026-10-04 evening): the selected service ends
// centred in the visible canvas once the panel has settled (beside it, or
// above the bottom sheet on a phone), and again once the panel closes.
for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`focus centring (${label}): the selected service is centred in the visible canvas once the panel settles, and again once it closes`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockTraceResults(page);
    await mockTraceFacets(page);
    await mockMap(page);
    await openMap(page);
    await cameraIdle(page, 'ChDash.traceMap');
    const free = await visibleArea(page, '#traceMapCanvas');
    const canvasBox = await page.locator('#traceMapCanvas').boundingBox();
    const middle = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    const shown = (await inspect(page)).nodes.filter((node) => node.x >= free.x && node.y >= free.y && node.x + node.width <= free.x + free.width && node.y + node.height <= free.y + free.height);
    expect(shown.length, 'a service in view').toBeGreaterThan(0);
    const target = shown.sort((a, b) => Math.hypot(b.x + b.width / 2 - middle.x, b.y + b.height / 2 - middle.y) - Math.hypot(a.x + a.width / 2 - middle.x, a.y + a.height / 2 - middle.y))[0];
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    const panel = page.locator('#traceMapPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.graphKitPanel__title')).toHaveText(target.service);
    await expectCentred(page, { hook: 'ChDash.traceMap', canvas: '#traceMapCanvas', panel: '#traceMapPanel', id: target.id, label: `${target.service} beside the panel` });
    const open = (await inspect(page)).nodes.find((node) => node.id === target.id);
    const sheet = await panel.boundingBox();
    if (label === 'phone') expect(open.y + open.height, 'above the sheet').toBeLessThanOrEqual(sheet.y + 1);
    else expect(open.x + open.width, 'left of the panel').toBeLessThanOrEqual(sheet.x + 1);
    await panel.locator('.uiDetail__close').click();
    await expect(panel).toBeHidden();
    await expectCentred(page, { hook: 'ChDash.traceMap', canvas: '#traceMapCanvas', id: target.id, label: `${target.service} once the panel closed` });
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('phones show the map canvas (no list), pan and pinch by touch and open details as a bottom sheet', async ({ page }) => {
    await mockTraceResults(page);
    await mockMap(page);
    await openMap(page);
    // T-E2: the map opens on its entry service and the services it calls at
    // 0.7 or more (full cards, labels never ~6 px), the rest a pan away, the
    // minimap giving the whole.
    await cameraIdle(page, 'ChDash.traceMap');
    await settle(page);
    const opened = await inspect(page);
    expect(await expectFit(page, { canvas: '#traceMapCanvas', minimap: '#traceMapMinimap' }, opened, 'frontend')).toBe('anchored');
    expect(opened.scale).toBeGreaterThanOrEqual(0.7 - 1e-6);
    expect(opened.compact).toBe(false);
    expect(opened.edgeLabels.length, 'edge labels on screen').toBeGreaterThan(0);
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

// Dense maps: every service calls most others, like a fresh stack's newest
// hour (12 services, 132 call paths: every ordered pair). The layered layout
// puts them in one row of columns, so every route detours around cards: the
// router took 45 s of main thread on 12 / 132 before its step budget.
function denseMap(services, paths, seed = 1) {
  let state = seed;
  const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const nodes = Array.from({ length: services }, (_, i) => node(`svc-${String(i).padStart(2, '0')}`, 100_000 * (services - i), i * 100, 10 + i));
  const pairs = [];
  for (let a = 0; a < services; a += 1) for (let b = 0; b < services; b += 1) if (a !== b) pairs.push([a, b]);
  for (let i = pairs.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  const edges = pairs.slice(0, paths).map(([a, b], i) => edge(nodes[a].service, nodes[b].service, 1_000 + i * 37, i % 9, 5 + (i % 50), i % 5 ? 'sync' : 'async'));
  return { ...MAP, nodes, edges };
}

// Opens the small map, then searches the dense one: the layout is measured
// on its own, not with the page load.
async function searchDense(page, payload) {
  let current = MAP;
  await mockTraceResults(page);
  await page.route('**/api/traces/service_map?**', (route) => route.fulfill({ json: current }));
  await openMap(page);
  current = payload;
  const frames = await measureFrames(page, async () => {
    await page.locator('#tracesSearchButton').click();
    await expect.poll(async () => (await inspect(page)).nodes.length, { timeout: 30_000 }).toBe(payload.nodes.length);
  });
  return { frames, state: await inspect(page) };
}

test('a dense map routes every call orthogonally, past the router budget, and keeps its routes for the same services and calls', async ({ page }) => {
  const payload = denseMap(12, 132);
  const { state } = await searchDense(page, payload);
  expect(state.edges).toHaveLength(132);
  for (const e of state.edges) {
    expect(e.orthogonal, e.id).toBe(true);
    expect(e.points.length, e.id).toBeGreaterThanOrEqual(2);
  }
  // The budget stopped the A* search: the other calls got cheap routes.
  expect(state.routeStats.exhausted).toBe(true);
  expect(state.routeStats.cheap).toBeGreaterThan(0);
  expect(state.routeStats.cheap).toBeLessThan(132);
  // 132 routes share eleven column gaps: most labels still find a free spot.
  expect(state.edgeLabelsDropped.length, 'labels without a free spot').toBeLessThan(132 * 0.2);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
  // The same services and calls again: same routes, from the cache.
  const before = state.edges.map((e) => [e.id, e.points.map((p) => [p.x - state.offsetX, p.y - state.offsetY])]);
  await page.locator('#tracesSearchButton').click();
  await expect.poll(async () => (await inspect(page)).layoutTiming?.ms ?? Infinity).toBeLessThan(state.layoutTiming.ms);
  const again = await inspect(page);
  expect(again.edges.map((e) => [e.id, e.points.map((p) => [p.x - again.offsetX, p.y - again.offsetY])])).toEqual(before);
});

test('performance budget: dense maps (12 / 132 and 40 / 600 call paths) lay out within budget and without long tasks', async ({ page }) => {
  test.setTimeout(120_000);
  await installFrameProbe(page);
  const twelve = await searchDense(page, denseMap(12, 132));
  expect(twelve.state.edges).toHaveLength(132);
  expect(twelve.state.layoutTiming.ms, '12 services / 132 calls: layout and routing (ms)').toBeLessThan(200);
  expect(twelve.frames.longMaxMs, '12 / 132: longest task (ms)').toBeLessThan(200);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const forty = await searchDense(page, denseMap(40, 600));
  expect(forty.state.edges).toHaveLength(600);
  for (const e of forty.state.edges) expect(e.orthogonal, e.id).toBe(true);
  expect(forty.state.layoutTiming.ms, '40 services / 600 calls: layout and routing (ms)').toBeLessThan(1000);
  expect(forty.frames.longMaxMs, '40 / 600: longest task (ms)').toBeLessThan(200);
  for (const [name, run] of [['12 / 132', twelve], ['40 / 600', forty]]) {
    console.log(`dense map ${name}: layout ${Math.round(run.state.layoutTiming.ms)} ms, longest task ${Math.round(run.frames.longMaxMs)} ms, ${run.state.routeStats.cheap} cheap routes`);
  }
});

test('service map smoke on the OTel fixture', async ({ page, request }) => {
  // 10:00-11:00 of 2026-09-18, the long-lived stack's peak bulk hour (~33 M
  // spans: time slices and trace sampling), else of the rich day 2026-09-12
  // (nine services, sync and async calls), which every stack holds.
  let day = null;
  let body = null;
  for (const candidate of ['2026-09-18', '2026-09-12']) {
    const start = Date.parse(`${candidate}T10:00:00Z`);
    const probe = await request.get(`/api/traces/service_map?start_ms=${start}&end_ms=${start + 600_000}`, { timeout: 60_000 });
    expect(probe.ok()).toBe(true);
    body = await probe.json();
    if (body.nodes?.length) { day = candidate; break; }
  }
  test.skip(!day, 'OTel fixture has no spans on 2026-09-18 nor 2026-09-12');
  // Every call has a kind: sync, or async for producer / consumer spans.
  for (const e of body.edges) expect(['sync', 'async']).toContain(e.kind);
  const hour = page.waitForResponse((r) => r.url().includes('/api/traces/service_map'), { timeout: 60_000 });
  await page.goto(`/observability/traces?tab=map&from=${day}%2010%3A00%3A00&to=${day}%2011%3A00%3A00`);
  const whole = await (await hour).json();
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0)), { timeout: 60_000 }).toBeGreaterThan(0);
  const state = await inspect(page);
  expect(state.nodes.length).toBe(whole.nodes.length);
  expect(state.edges.length).toBe(whole.edges.length);
  expect(state.nodes.length).toBeGreaterThanOrEqual(body.nodes.length);
  expectLabelsClear(state);
  // The badge says when the hour was sampled (the peak bulk hour is).
  if (whole.sampled) await expect(page.locator('#traceMapSampled')).toHaveText(/^sampled ×\d+/);
  else await expect(page.locator('#traceMapSampled')).toBeHidden();
  if (day === '2026-09-18') expect(whole.sampled).toBe(true);
  const vp = page.viewportSize();
  await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/fixture-dark-${vp.width}.png` });
});
