import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { mockTraceFacets, mockTraceResults } from '../helpers/traces.js';

// Service map tab of the Traces page (after HyperDX's DBServiceMapPage):
// tab state in the URL, the search filters on /api/traces/service_map, the
// layered graph, hover / click interactions, the hand-off to the Search tab,
// the sampled badge and the loading / empty / error states. The graphs are
// mocked (the OTel fixture is one flat star); one smoke test reads the fixture.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
});

const MS = 1e6;
const node = (service, spans, errors, p95) => ({
  service, spans, errors, error_rate: spans ? errors / spans : 0, sampled_count: Math.round(spans / 12), p50_ns: p95 * MS / 3, p95_ns: p95 * MS, p99_ns: p95 * MS * 1.4,
});
const edge = (source, target, calls, errors, p95) => ({ source, target, ...node('', calls, errors, p95), service: undefined, calls });

// A chain, a fan-out, a cycle (email <-> checkout), an erroring edge and an
// isolated service.
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
    edge('checkout', 'email', 50_000, 0, 60), edge('email', 'checkout', 5_000, 0, 30),
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

const mapNode = (page, service) => page.locator(`#traceMapSvg .traceMapNode[aria-label^="${service}:"]`);
const mapEdge = (page, source, target) => page.locator(`#traceMapSvg .traceMapEdge[aria-label^="${source} calls ${target}:"]`);

async function openMap(page, query = '') {
  await page.goto(`/observability/traces?tab=map${query ? `&${query}` : ''}`);
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(MAP.nodes.length, { timeout: 30_000 });
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
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(MAP.nodes.length);
  await expect(page.locator('#traceMapSvg .traceMapEdge')).toHaveCount(MAP.edges.length);
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
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(MAP.nodes.length, { timeout: 30_000 });
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

test('the layered layout, the sampled badge and the legend', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  await openMap(page);
  const badge = page.locator('#traceMapSampled');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('sampled ×12');
  await expect(badge).toHaveAttribute('title', /1 trace in 4 and 7 time slices/);
  await expect(page.locator('#traceMapMeta')).toContainText('8 services · 8 call paths');
  await expect(page.locator('#traceMapLegend')).toContainText('Node size: spans');
  await expect(page.locator('#traceMapLegend')).toContainText('Red ring: error rate');

  // Callers left of (or above) their callees; bigger traffic, bigger node.
  const centre = async (service) => mapNode(page, service).locator('.traceMapNode__dot').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, r: box.width / 2 };
  });
  const frontend = await centre('frontend');
  const checkout = await centre('checkout');
  const payment = await centre('payment');
  const cron = await centre('cron');
  const axis = Math.abs(checkout.x - frontend.x) > Math.abs(checkout.y - frontend.y) ? 'x' : 'y';
  expect(checkout[axis]).toBeGreaterThan(frontend[axis]);
  expect(payment[axis]).toBeGreaterThan(checkout[axis]);
  expect(frontend.r).toBeGreaterThan(cron.r);
  // Everything is inside the canvas after the fit.
  const canvas = await page.locator('#traceMapCanvas').boundingBox();
  for (const service of MAP.nodes.map((n) => n.service)) {
    const box = await mapNode(page, service).boundingBox();
    expect(box.x, service).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(box.x + box.width, service).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(box.y + box.height, service).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }
  // Error colours: checkout (6 %) has a red ring and a red edge; payment's edge (2 %) is amber.
  await expect(mapNode(page, 'checkout').locator('.traceMapNode__ring')).toHaveClass(/is-err/);
  await expect(mapNode(page, 'cart').locator('.traceMapNode__ring')).toHaveCount(0);
  await expect(mapEdge(page, 'frontend', 'checkout')).toHaveClass(/is-err/);
  await expect(mapEdge(page, 'checkout', 'payment')).toHaveClass(/is-warn/);
  await expect(mapEdge(page, 'cart', 'redis')).toHaveClass(/is-ok/);
  // Thicker edges carry more calls.
  const width = (source, target) => mapEdge(page, source, target).locator('.traceMapEdge__line').evaluate((el) => parseFloat(el.style.strokeWidth));
  expect(await width('cart', 'redis')).toBeGreaterThan(await width('email', 'checkout'));

  // Zoom buttons and fit.
  const transform = () => page.locator('#traceMapSvg .traceMap__viewport').getAttribute('transform');
  const fitted = await transform();
  await page.locator('#traceMapZoomIn').click();
  expect(await transform()).not.toBe(fitted);
  await page.locator('#traceMapFit').click();
  expect(await transform()).toBe(fitted);
  // Wheel zoom and drag pan.
  await page.mouse.move(canvas.x + 60, canvas.y + 60);
  await page.mouse.wheel(0, -200);
  expect(await transform()).not.toBe(fitted);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 160, canvas.y + 120, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#traceMapPanel')).toBeHidden();
});

test('hover highlights the neighbours and an edge shows its p95 / calls', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  await openMap(page);
  await mapNode(page, 'checkout').locator('.traceMapNode__dot').hover();
  await expect(page.locator('#traceMapSvg')).toHaveClass(/is-focus/);
  for (const neighbour of ['frontend', 'payment', 'postgres', 'email', 'checkout']) {
    await expect(mapNode(page, neighbour)).toHaveClass(/is-hl/);
  }
  for (const other of ['cart', 'redis', 'cron']) await expect(mapNode(page, other)).not.toHaveClass(/is-hl/);
  await expect(mapEdge(page, 'cart', 'redis')).not.toHaveClass(/is-hl/);
  await expect(page.locator('#traceMapTip')).toBeVisible();
  await expect(page.locator('#traceMapTip')).toContainText('checkout');
  await expect(page.locator('#traceMapTip')).toContainText('6% errors');

  await mapEdge(page, 'cart', 'redis').locator('.traceMapEdge__hit').hover();
  await expect(mapEdge(page, 'cart', 'redis')).toHaveClass(/is-hl/);
  await expect(page.locator('#traceMapSvg .traceMapEdgeLabel')).toHaveCount(1);
  await expect(page.locator('#traceMapSvg .traceMapEdgeLabel')).toContainText('p95 2 ms · 900K');
  await expect(page.locator('#traceMapTip')).toContainText('cart → redis');
  await page.mouse.move(2, 2);
  await expect(page.locator('#traceMapSvg')).not.toHaveClass(/is-focus/);
});

test('a node opens its panel and "Search this service" hands off to the Search tab', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await mockTraceFacets(page);
  await mockMap(page);
  await openMap(page, 'tag=http.route%3D%2Fcheckout');
  await mapNode(page, 'checkout').locator('.traceMapNode__dot').click();
  const panel = page.locator('#traceMapPanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('h3').first()).toHaveText('checkout');
  await expect(panel).toContainText('400K');
  await expect(panel).toContainText('6%');
  await expect(panel.locator('.traceMapPanel__list').first()).toContainText('frontend');
  await expect(panel.locator('.traceMapPanel__list').nth(1).locator('.traceMapPanel__edge')).toHaveCount(3);
  await expect(mapNode(page, 'checkout')).toHaveClass(/is-selected/);
  // An outbound edge row selects that edge.
  await panel.locator('.traceMapPanel__edge', { hasText: 'payment' }).click();
  await expect(panel).toContainText('Search calls checkout → payment');
  await panel.locator('[data-map-select-node]').first().click();
  await expect(panel.locator('h3').first()).toHaveText('checkout');
  // Escape closes; Enter on a focused node opens it again.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await mapNode(page, 'checkout').focus();
  await page.keyboard.press('Enter');
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
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(MAP.nodes.length);
});

test('an edge opens its panel and "Search calls A -> B" searches the callee (errors too)', async ({ page }) => {
  const searches = await mockTraceResults(page);
  await mockTraceFacets(page);
  const maps = await mockMap(page);
  await openMap(page);
  await mapEdge(page, 'checkout', 'payment').locator('.traceMapEdge__hit').click({ force: true });
  const panel = page.locator('#traceMapPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('checkout');
  await expect(panel).toContainText('payment');
  await expect(panel).toContainText('150K');
  await expect(page.locator('#traceMapSvg .traceMapEdgeLabel')).toContainText('p95 900 ms');
  await panel.getByRole('button', { name: 'Search errors' }).click();
  await expect.poll(() => searches.length).toBeGreaterThan(0);
  const last = searches[searches.length - 1];
  expect(last.service).toBe('payment');
  expect(last.status).toBe('Error');
  await expect(page.locator('.traceSearchBody')).toBeVisible();

  // "Focus map" keeps the map tab with the service filter.
  await page.locator('#tracesTab-map').click();
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(MAP.nodes.length);
  await mapNode(page, 'cart').locator('.traceMapNode__dot').click();
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
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(1);
  await expect(page.locator('#traceMapState')).toContainText('No calls between services');
  mode = 'error';
  await page.locator('#tracesSearchButton').click();
  await expect(page.locator('#traceMapState [role="alert"]')).toContainText('Timeout exceeded');
  mode = 'nodes';
  await page.locator('#traceMapState [data-map-retry]').click();
  await expect(page.locator('#traceMapState [role="alert"]')).toHaveCount(0);
  await expect(page.locator('#traceMapSvg .traceMapNode')).toHaveCount(1);
});

test('service map: no page overflow and readable in both themes', async ({ page }) => {
  await mockTraceResults(page);
  await mockMap(page);
  for (const theme of ['dark', 'light']) {
    await page.goto('/observability/traces');
    await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
    await openMap(page);
    await mapNode(page, 'checkout').locator('.traceMapNode__dot').click();
    await expect(page.locator('#traceMapPanel')).toBeVisible();
    await mapEdge(page, 'cart', 'redis').locator('.traceMapEdge__hit').hover({ force: true });
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x, theme).toBeLessThanOrEqual(1);
    expect(overflow.y, theme).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(theme);
    // Node labels are legible: the fit keeps the text at least 9 px high.
    const size = await mapNode(page, 'frontend').locator('.traceMapNode__name').evaluate((el) => el.getBoundingClientRect().height);
    expect(size).toBeGreaterThanOrEqual(9);
    const vp = page.viewportSize();
    await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/map-${theme}-${vp.width}.png` });
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});

test('service map smoke on the OTel fixture', async ({ page, request }) => {
  const start = Date.UTC(2026, 8, 18, 10, 0, 0);
  const probe = await request.get(`/api/traces/service_map?start_ms=${start}&end_ms=${start + 600_000}`, { timeout: 60_000 });
  expect(probe.ok()).toBe(true);
  const body = await probe.json();
  test.skip(!body.nodes?.length, 'OTel fixture has no spans on 2026-09-18');
  await page.goto('/observability/traces?tab=map&from=2026-09-18%2010%3A00%3A00&to=2026-09-18%2011%3A00%3A00');
  await expect(page.locator('#traceMapSvg .traceMapNode').first()).toBeVisible({ timeout: 60_000 });
  const nodes = await page.locator('#traceMapSvg .traceMapNode').count();
  expect(nodes).toBe(body.nodes.length);
  await expect(page.locator('#traceMapSvg .traceMapEdge')).toHaveCount(body.edges.length);
  // The fixture's peak hour holds ~33 M spans: time slices and trace sampling.
  await expect(page.locator('#traceMapSampled')).toBeVisible();
  await expect(page.locator('#traceMapSampled')).toHaveText(/^sampled ×\d+/);
  const vp = page.viewportSize();
  await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/service-map/fixture-dark-${vp.width}.png` });
});
