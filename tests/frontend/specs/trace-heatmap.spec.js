import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { mockTraceFacets, mockTraceResults, syntheticAnalytics } from '../helpers/traces.js';

// Duration heatmap + box-select comparison (app_trace_heatmap.js) after
// HyperDX's DBSearchHeatmapChart / DBDeltaChart: the Percentiles / Heatmap
// toggle (remembered, in the URL), cells / colours / tooltip, dragging a box
// (or the keyboard) opens the comparison panel, a value click becomes a
// filter chip and "Search traces in this box" sets the range and the trace
// duration filter. The OTel fixture has almost no attributes, so the
// heatmap and deltas answers are mocked and the requests are checked.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
});

const BUCKET = 300_000;
const ROWS = 20;
// 1 ms .. 10 s, 20 log rows (5 per decade).
const EDGES = Array.from({ length: ROWS + 1 }, (_, i) => 1e6 * 10 ** (i * 0.2));

// A quick band (rows 5..8) everywhere and a slow cluster (rows 15..17) in the
// last three buckets.
function syntheticHeatmap(startMs, endMs) {
  const first = Math.floor(startMs / BUCKET) * BUCKET;
  const cells = [];
  const buckets = [];
  for (let t = first; t < endMs; t += BUCKET) buckets.push(t);
  buckets.forEach((t, i) => {
    for (let row = 5; row <= 8; row += 1) cells.push([t, row, 40 + ((i * 7 + row * 13) % 160)]);
    if (i >= buckets.length - 3) for (let row = 15; row <= 17; row += 1) cells.push([t, row, 3 + ((i + row) % 5)]);
  });
  cells[0][2] = 1;
  cells[1][2] = 400;
  const total = cells.reduce((sum, cell) => sum + cell[2], 0);
  return {
    v: 1, unit: 'traces', unit_label: 'Traces with a matching span, at their first span start, by span-bounds duration',
    range: [startMs, endMs], bucket_ms: BUCKET, bucket_origin_ms: 0, bins_per_octave: 32, rows: ROWS, y_edges_ns: EDGES,
    total, below_min_count: 12, max_count: 400, cells, timing_ms: { heatmap: 5, total: 6 },
  };
}

const DELTA_KEYS = [
  { scope: 'span', key: 'http.route', field: 'tag', score: 86, boosted: true, distinct_values: 4,
    values: [
      { value: '/checkout', selection_pct: 92, baseline_pct: 8, selection_count: 920, baseline_count: 80 },
      { value: '/home', selection_pct: 5, baseline_pct: 70, selection_count: 50, baseline_count: 700 },
    ] },
  { scope: 'column', key: 'ServiceName', field: 'service', score: 62, boosted: true, distinct_values: 3,
    values: [{ value: 'checkout', selection_pct: 100, baseline_pct: 40, selection_count: 1000, baseline_count: 400 }] },
  { scope: 'column', key: 'StatusCode', field: 'status', score: 31, boosted: true, distinct_values: 2,
    values: [{ value: 'Error', selection_pct: 30, baseline_pct: 1, selection_count: 300, baseline_count: 10 }] },
  { scope: 'resource', key: 'k8s.pod.name', field: 'tag', score: 20, boosted: true, distinct_values: 6,
    values: [{ value: 'checkout-7d9f-abcde', selection_pct: 25, baseline_pct: 5, selection_count: 250, baseline_count: 50 }] },
];

function syntheticDeltas(params, keys = DELTA_KEYS) {
  return {
    v: 1, unit: 'traces',
    box: { t0: Number(params.get('t0')), t1: Number(params.get('t1')), d0: Number(params.get('d0')), d1: Number(params.get('d1')) },
    baseline: params.get('baseline') || 'outside', sample_limit: 1000, sampled_windows: [[Number(params.get('t0')), Number(params.get('t1'))]],
    sampled_ms: Number(params.get('t1')) - Number(params.get('t0')), window_sampled: false, read_margin_ms: 1000,
    selection: { sampled: 1000, traces: 3210 }, baseline_sample: { sampled: 1000, traces: 90412 },
    ranked_keys: keys.length, keys, hidden_keys: [{ scope: 'span', key: 'request_id', reason: 'id_like' }],
    timing_ms: { sample: 5, attributes: 5, total: 10 },
  };
}

// Serves heatmap + deltas (deltas answer overridable); returns the requests.
async function mockHeatmap(page, { deltas = (params) => ({ json: syntheticDeltas(params) }) } = {}) {
  const seen = { heatmap: [], deltas: [], searches: [], analytics: [] };
  await mockTraceFacets(page);
  await mockTraceResults(page);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/traces/search')) seen.searches.push(url.searchParams);
    if (url.pathname.endsWith('/api/traces/analytics')) seen.analytics.push(url.searchParams);
  });
  await page.route('**/api/traces/heatmap?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.heatmap.push(params);
    return route.fulfill({ json: syntheticHeatmap(Number(params.get('start_ms')), Number(params.get('end_ms'))) });
  });
  await page.route('**/api/traces/deltas?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.deltas.push(params);
    return route.fulfill(deltas(params));
  });
  return seen;
}

const heatCells = (page) => page.locator('#traceDurationChart .traceHeatCell');
const panel = (page) => page.locator('#traceDeltaPanel');
const chips = (page) => page.locator('#tracesFilterChips .traceFilterChip');
const last = (list) => list[list.length - 1];

async function openHeatmap(page, query = 'duration_view=heatmap') {
  await page.goto(`/observability/traces?${query}`);
  await expect(heatCells(page).first()).toBeVisible({ timeout: 30_000 });
}

async function cellCenter(page, col, row) {
  const box = await page.locator(`#traceDurationChart .traceHeatCell[data-heat-col="${col}"][data-heat-row="${row}"]`).boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragBox(page, from, to) {
  const a = await cellCenter(page, from[0], from[1]);
  const b = await cellCenter(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function lastCol(page) {
  return Number(await page.locator('#traceDurationChart svg.traceHeatmap').getAttribute('data-cols')) - 1;
}

test('the Percentiles / Heatmap toggle lives in the URL and is remembered', async ({ page }) => {
  const seen = await mockHeatmap(page);
  // Unfiltered counts come first (charts=counts, index counts), the
  // percentiles in a second request, as on the server.
  await page.route('**/api/traces/analytics?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const json = syntheticAnalytics(Number(params.get('start_ms')), Number(params.get('end_ms')));
    return route.fulfill({ json: params.get('charts') === 'counts' ? { ...json, charts: ['counts'], duration_quantiles: [] } : json });
  });
  await page.goto('/observability/traces');
  await expect(page.locator('#traceDurationChart .traceChartLegend--quantiles')).toBeVisible({ timeout: 30_000 });
  const toggle = page.locator('[data-duration-view="heatmap"]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const searchesBefore = seen.searches.length;
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(heatCells(page).first()).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('duration_view')).toBe('heatmap');
  // A view toggle is not a new search: the heatmap loads for the same filters.
  expect(seen.searches.length).toBe(searchesBefore);
  expect(seen.heatmap.length).toBe(1);
  expect(Number(last(seen.heatmap).get('bucket_origin_ms'))).toBeGreaterThanOrEqual(0);
  await expect(page.locator('#traceDurationChartMeta')).toContainText('× log duration');

  // Reload keeps it; a plain /traces opens the remembered mode.
  const durations = () => seen.analytics.filter((params) => params.get('charts') === 'durations').length;
  const durationsBefore = durations();
  expect(durationsBefore).toBe(1);
  await page.reload();
  await expect(heatCells(page).first()).toBeVisible({ timeout: 30_000 });
  await page.goto('/observability/traces');
  await expect(heatCells(page).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get('duration_view')).toBe('heatmap');
  // The heatmap mode skips the percentiles request.
  expect(seen.heatmap.length).toBe(3);
  expect(durations()).toBe(durationsBefore);

  // Back to the percentiles: requested again, URL parameter dropped.
  await page.locator('[data-duration-view="percentiles"]').click();
  await expect(page.locator('#traceDurationChart .traceChartLegend--quantiles')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.has('duration_view')).toBe(false);
  expect(durations()).toBe(durationsBefore + 1);
  // An explicit URL wins over the remembered mode.
  await openHeatmap(page);
  await page.goto('/observability/traces?duration_view=percentiles');
  await expect(page.locator('[data-duration-view="percentiles"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => localStorage.removeItem('chdash.traceDurationView.v1'));
});

test('heatmap cells: log rows, count colours, axes and tooltip', async ({ page }) => {
  await mockHeatmap(page);
  await openHeatmap(page);
  const svg = page.locator('#traceDurationChart svg.traceHeatmap');
  await expect(svg).toHaveAttribute('data-rows', String(ROWS));
  const count = await heatCells(page).count();
  expect(count).toBeGreaterThan(40);
  // Colours: the busiest cell is the darkest step (dark theme: lightest), a
  // single trace the faintest; both differ.
  const busiest = page.locator('.traceHeatCell[data-count="400"]');
  const single = page.locator('.traceHeatCell[data-count="1"]');
  await expect(busiest).toHaveClass(/lvl-8/);
  await expect(single).toHaveClass(/lvl-1/);
  const fills = await Promise.all([busiest, single].map((cell) => cell.evaluate((el) => getComputedStyle(el).fill)));
  expect(fills[0]).not.toBe(fills[1]);
  await expect(page.locator('.traceHeatLegend [data-heat-max]')).toHaveText('400');
  // Log scale: equal row heights, slow rows above quick ones, 1-2-5 ticks.
  const heights = await page.locator('.traceHeatCell[data-heat-col="0"]').evaluateAll((els) => els.map((el) => [Number(el.dataset.heatRow), Number(el.getAttribute('y')), Number(el.getAttribute('height'))]));
  heights.sort((a, b) => a[0] - b[0]);
  expect(heights[0][1]).toBeGreaterThan(heights[heights.length - 1][1]);
  expect(Math.abs(heights[1][2] - heights[2][2])).toBeLessThan(0.5);
  const ticks = await page.locator('#traceDurationChart [data-heat-tick]').allTextContents();
  expect(ticks).toContain('10 ms');
  expect(ticks).toContain('1 s');
  // Tooltip on hover: count, start bucket and the row's duration range.
  const at = await cellCenter(page, 0, 6);
  await page.mouse.move(at.x, at.y);
  const tip = page.locator('#traceDurationChart .traceChartTooltip');
  await expect(tip).toBeVisible();
  const text = await tip.textContent();
  const cellCount = await page.locator('.traceHeatCell[data-heat-col="0"][data-heat-row="6"]').getAttribute('data-count');
  expect(text).toContain(`${Number(cellCount).toLocaleString('en-US')} traces`);
  expect(text).toMatch(/Duration.*15\.8 ms – 25(\.1)? ms/);
});

test('dragging a box opens the comparison panel with paired bars', async ({ page }) => {
  const seen = await mockHeatmap(page);
  await openHeatmap(page);
  const col = await lastCol(page);
  await dragBox(page, [col - 2, 15], [col, 17]);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
  const params = last(seen.deltas);
  const heat = last(seen.heatmap);
  const first = Math.floor(Number(heat.get('start_ms')) / BUCKET) * BUCKET;
  expect(Number(params.get('t0'))).toBe(first + (col - 2) * BUCKET);
  expect(Number(params.get('t1'))).toBe(Math.min(Number(heat.get('end_ms')), first + (col + 1) * BUCKET));
  expect(Number(params.get('d0'))).toBeCloseTo(EDGES[15] / 1e6, 6);
  expect(Number(params.get('d1'))).toBeCloseTo(EDGES[18] / 1e6, 6);
  expect(params.get('baseline')).toBe('outside');
  expect(params.get('start_ms')).toBe(heat.get('start_ms'));
  // The selection is drawn and summarised.
  await expect(page.locator('#traceDurationChart .traceHeatSelection')).not.toHaveAttribute('hidden', '');
  await expect(panel(page)).toContainText('1,000 of 3,210 traces in the box');
  await expect(panel(page)).toContainText('1,000 of 90,412 traces');
  // Paired bars: selection and baseline widths follow the percentages.
  const route = panel(page).locator('.traceDeltaCard').first();
  await expect(route.locator('header strong')).toHaveText('http.route');
  const row = route.locator('.traceDeltaRow').first();
  await expect(row.locator('.traceDeltaRow__value')).toHaveText('/checkout');
  await expect(row.locator('.traceDeltaRow__pct')).toContainText('92%');
  const widths = await row.locator('.traceDeltaRow__bars i').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
  expect(widths[0] / widths[1]).toBeGreaterThan(8);
  await expect(panel(page).locator('.traceDeltaCard').nth(1).locator('header strong')).toHaveText('service');
  // The baseline picker asks again with baseline=all.
  await panel(page).locator('[data-delta-baseline]').selectOption('all');
  await expect.poll(() => last(seen.deltas).get('baseline')).toBe('all');
  // Clear removes the panel and the drawn box.
  await panel(page).getByRole('button', { name: 'Clear selection' }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#traceDurationChart .traceHeatSelection')).toHaveAttribute('hidden', '');
});

test('a compared value becomes a filter chip (include and exclude)', async ({ page }) => {
  const seen = await mockHeatmap(page);
  await openHeatmap(page);
  const col = await lastCol(page);
  await dragBox(page, [col - 1, 15], [col, 16]);
  await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
  const before = seen.searches.length;
  await panel(page).getByRole('button', { name: /^Filter for http\.route = \/checkout/ }).click();
  await expect.poll(() => seen.searches.length).toBeGreaterThan(before);
  expect(last(seen.searches).getAll('tag')).toEqual(['span:http.route=/checkout']);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('title', 'span:http.route = /checkout');
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['span:http.route=/checkout']);
  // A new search reloads the heatmap with the filter and drops the box.
  await expect.poll(() => last(seen.heatmap).getAll('tag')).toEqual(['span:http.route=/checkout']);
  await expect(panel(page)).toBeHidden();

  await dragBox(page, [col - 1, 15], [col, 16]);
  await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
  await panel(page).getByRole('button', { name: 'Exclude k8s.pod.name = checkout-7d9f-abcde' }).click();
  await expect.poll(() => last(seen.searches).getAll('tag_not')).toEqual(['resource:k8s.pod.name=checkout-7d9f-abcde']);
  await dragBox(page, [col - 1, 15], [col, 16]);
  await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
  await panel(page).getByRole('button', { name: /^Filter for service = checkout/ }).click();
  await expect.poll(() => last(seen.searches).getAll('service')).toEqual(['checkout']);
  await dragBox(page, [col - 1, 15], [col, 16]);
  await panel(page).getByRole('button', { name: 'Exclude status = Error' }).click();
  await expect.poll(() => last(seen.searches).getAll('status_not')).toEqual(['Error']);
});

test('"Search traces in this box" sets the range and the duration filter', async ({ page }) => {
  const seen = await mockHeatmap(page);
  await openHeatmap(page);
  const col = await lastCol(page);
  await dragBox(page, [col - 2, 15], [col - 1, 17]);
  await expect(panel(page).locator('.traceDeltaCard').first()).toBeVisible();
  const box = last(seen.deltas);
  const before = seen.searches.length;
  await panel(page).getByRole('button', { name: 'Search traces in this box' }).click();
  await expect.poll(() => seen.searches.length).toBeGreaterThan(before);
  const search = last(seen.searches);
  expect(Number(search.get('start_ms'))).toBe(Math.floor(Number(box.get('t0')) / 1000) * 1000);
  expect(Number(search.get('end_ms'))).toBe(Math.ceil(Number(box.get('t1')) / 1000) * 1000);
  // Three significant digits, rounded outwards: 1000 * 10^(15*0.2) ms.. 10^(18*0.2).
  expect(Number(search.get('min_duration_ms'))).toBe(1000);
  expect(Number(search.get('max_duration_ms'))).toBe(3990);
  const chip = page.locator('#tracesFilterChips .traceFilterChip--duration');
  await expect(chip).toContainText('duration');
  await expect(chip).toContainText('1 s – 3.99 s');
  const url = new URL(page.url()).searchParams;
  expect(url.get('min_duration_ms')).toBe('1000');
  expect(url.get('max_duration_ms')).toBe('3990');
  expect(url.get('from')).toBeTruthy();
  // The analytics and the heatmap follow the new filter.
  await expect.poll(() => last(seen.heatmap).get('min_duration_ms')).toBe('1000');
  // Removing the chip searches without it.
  const count = seen.searches.length;
  await chip.locator('.traceFilterChip__remove').click();
  await expect.poll(() => seen.searches.length).toBeGreaterThan(count);
  expect(last(seen.searches).has('min_duration_ms')).toBe(false);
  // A reload restores the duration filter from the URL.
  await page.goto(`/observability/traces?duration_view=heatmap&min_duration_ms=250&max_duration_ms=900`);
  await expect(page.locator('#tracesFilterChips .traceFilterChip--duration')).toContainText('250 ms – 900 ms');
  await expect.poll(() => last(seen.searches).get('max_duration_ms')).toBe('900');
});

test('keyboard: arrows move, Shift extends, Enter compares, Escape clears', async ({ page }) => {
  const seen = await mockHeatmap(page);
  await openHeatmap(page);
  const chart = page.locator('#traceDurationChart');
  await expect(chart).toHaveAttribute('tabindex', '0');
  await expect(chart).toHaveAttribute('role', 'application');
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(chart.locator('.traceHeatCursor')).not.toHaveAttribute('hidden', '');
  await expect(chart.locator('.traceChartTooltip')).toBeVisible();
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(chart.locator('.traceHeatBrush')).not.toHaveAttribute('hidden', '');
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  const params = last(seen.deltas);
  expect(Number(params.get('t1')) - Number(params.get('t0'))).toBeGreaterThanOrEqual(BUCKET);
  expect(Number(params.get('d1'))).toBeGreaterThan(Number(params.get('d0')));
  await expect(panel(page).locator('.traceDeltaRow__value').first()).toBeVisible();
  // Value buttons are reachable with Tab.
  await panel(page).locator('.traceDeltaRow__value').first().focus();
  await expect(panel(page).locator('.traceDeltaRow__value').first()).toBeFocused();
  await chart.focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
});

test('comparison states: loading, error with retry, nothing to compare', async ({ page }) => {
  let mode = 'error';
  let release = null;
  const seen = await mockHeatmap(page, {
    deltas: (params) => {
      if (mode === 'error') return { status: 503, json: { error_code: 'trace_deltas_failed', message: 'Timeout exceeded: elapsed 30 s' } };
      if (mode === 'empty') return { json: syntheticDeltas(params, []) };
      if (mode === 'nothing') return { json: { ...syntheticDeltas(params, []), selection: { sampled: 0, traces: 0 } } };
      return { json: syntheticDeltas(params) };
    },
  });
  await openHeatmap(page);
  const col = await lastCol(page);
  await dragBox(page, [col, 15], [col, 15]);
  await expect(panel(page).locator('[role="alert"]')).toContainText('Timeout exceeded');
  mode = 'ok';
  // Loading state while the retry is pending.
  await page.route('**/api/traces/deltas?**', async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.fulfill({ json: syntheticDeltas(new URL(route.request().url()).searchParams) });
  });
  await panel(page).getByRole('button', { name: 'Retry' }).click();
  await expect(panel(page).locator('[role="status"]')).toContainText('Comparing sampled traces');
  await expect.poll(() => typeof release).toBe('function');
  release();
  await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
  await page.unroute('**/api/traces/deltas?**');
  await page.route('**/api/traces/deltas?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.deltas.push(params);
    return route.fulfill(mode === 'empty' ? { json: syntheticDeltas(params, []) } : { json: { ...syntheticDeltas(params, []), selection: { sampled: 0, traces: 0 } } });
  });
  mode = 'empty';
  await dragBox(page, [col - 1, 6], [col, 7]);
  await expect(panel(page)).toContainText('No attribute sets these traces apart from the baseline (1 identifier or high-cardinality key skipped)');
  mode = 'nothing';
  await dragBox(page, [col - 1, 6], [col, 6]);
  await expect(panel(page)).toContainText('No traces in this box');
  // Heatmap errors offer a retry too.
  let failHeatmap = true;
  await page.unroute('**/api/traces/heatmap?**');
  await page.route('**/api/traces/heatmap?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (failHeatmap) return route.fulfill({ status: 503, json: { error_code: 'trace_heatmap_failed', message: 'heatmap failed' } });
    return route.fulfill({ json: syntheticHeatmap(Number(params.get('start_ms')), Number(params.get('end_ms'))) });
  });
  await page.locator('#tracesSearchButton').click();
  await expect(page.locator('#traceDurationChart [role="alert"]')).toContainText('heatmap failed');
  failHeatmap = false;
  await page.locator('#traceDurationChart [data-heatmap-retry]').click();
  await expect(heatCells(page).first()).toBeVisible();
});

test('heatmap + comparison: screenshots in both themes, no page overflow', async ({ page }) => {
  await mockHeatmap(page);
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
      await page.goto('/observability/traces');
      await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
      await openHeatmap(page);
      expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(theme);
      const col = await lastCol(page);
      await dragBox(page, [col - 2, 15], [col, 17]);
      await expect(panel(page).locator('.traceDeltaCard')).toHaveCount(DELTA_KEYS.length);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      const at = await cellCenter(page, 3, 6);
      await page.mouse.move(at.x, at.y);
      await expect(page.locator('#traceDurationChart .traceChartTooltip')).toBeVisible();
      const dir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/trace-heatmap`;
      await page.screenshot({ path: `${dir}/heatmap-${theme}-${width}.png` });
      await page.locator('#traceAnalyticsGrid').screenshot({ path: `${dir}/heatmap-chart-${theme}-${width}.png` });
      await panel(page).screenshot({ path: `${dir}/deltas-${theme}-${width}.png` });
    }
  }
  await page.evaluate(() => { localStorage.removeItem('chdash.theme'); localStorage.removeItem('chdash.traceDurationView.v1'); });
});
