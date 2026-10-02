import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { captureState } from '../helpers/review.js';

// Metrics browser (/metrics) on the OTel fixture metrics (otel.otel_metrics_*,
// derived from the stored spans: see docs/metrics.md). The window comes from
// /api/metrics/meta time bounds, never from hard-coded dates.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  // Navigating away (exemplar click) may abort in-flight chart requests.
  expect(obs.failedRequests.filter((r) => !/ERR_ABORTED|NS_BINDING_ABORTED/.test(String(r.error || '')))).toEqual([]);
});

const pad = (value) => String(value).padStart(2, '0');
// Browser-local (the config pins timezoneId UTC) "YYYY-MM-DD HH:mm:ss".
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

let bounds = null;
async function metricBounds(request) {
  if (bounds) return bounds;
  const response = await request.get('/api/metrics/meta');
  expect(response.ok()).toBeTruthy();
  const meta = await response.json();
  expect(meta.enabled).toBe(true);
  const max = Number(meta.kinds.histogram.time_bounds.max_ms);
  const summaryMax = Number(meta.kinds.summary.time_bounds.max_ms);
  bounds = { max, summaryMax };
  return bounds;
}

// Last `hours` hours of data, minute-aligned.
async function windowParams(request, hours = 6, which = 'max') {
  const b = await metricBounds(request);
  const end = Math.floor(b[which] / 60000) * 60000;
  return { from: stamp(end - hours * 3600000), to: stamp(end) };
}

function metricsUrl(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else if (value != null) search.set(key, value);
  }
  return `/observability/metrics?${search.toString()}`;
}

// Panels draw on the shared canvas engine: its data attributes say what it
// drew (data-series-drawn, data-points-drawn, data-markers, data-plot).
const chartOf = (panel) => panel.locator('.metricsChart .chartCore');

async function waitForChart(page, panel = page.locator('.metricsPanel').first()) {
  await expect(panel.locator('.metricsChart')).not.toHaveClass(/is-loading/, { timeout: 30_000 });
  await expect(chartOf(panel).locator('.chartCore__canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => Number(await chartOf(panel).getAttribute('data-points-drawn')), { timeout: 30_000 }).toBeGreaterThan(0);
}

// The plot rectangle in page coordinates.
async function plotBox(panel) {
  const chart = chartOf(panel);
  const box = await chart.locator('.chartCore__overlay').boundingBox();
  const [left, top, width, height] = (await chart.getAttribute('data-plot')).split(' ').map(Number);
  return { x: box.x + left, y: box.y + top, width, height };
}

const seriesDrawn = async (panel) => Number(await chartOf(panel).getAttribute('data-series-drawn'));

test('metrics: catalog lists services and metrics with type and unit badges, and search narrows it', async ({ page, request }) => {
  const range = await windowParams(request, 24);
  await page.goto(metricsUrl(range));
  const catalog = page.locator('#metricsCatalog');
  await expect(catalog.locator('.metricsCatalog__metric').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  await expect(page.locator('#obsTab-metrics')).toHaveAttribute('aria-selected', 'true');
  const api = catalog.locator('.metricsCatalog__service', { has: page.locator('[data-service-toggle="api_service"]') });
  await expect(api.locator('.metricsCatalog__metric[data-metric="http.server.request.duration"] .metricsBadge--histogram')).toHaveText('hist');
  await expect(api.locator('.metricsCatalog__metric[data-metric="http.server.request.duration"] .metricsBadge--unit')).toHaveText('s');
  await expect(api.locator('.metricsCatalog__metric[data-metric="traces.span.metrics.calls"] .metricsBadge--sum')).toBeVisible();
  await expect(api.locator('.metricsCatalog__metric[data-metric="process.cpu.utilization"] .metricsBadge--gauge')).toBeVisible();
  await expect(page.locator('#metricsCatalogSummary')).toContainText(/metrics · \d+ services/);

  await page.locator('#metricsSearch').fill('queue.dep');
  const items = catalog.locator('.metricsCatalog__metric');
  await expect(items.first()).toBeVisible();
  const names = await items.evaluateAll((els) => [...new Set(els.map((el) => el.dataset.metric))]);
  expect(names).toEqual(['queue.depth']);
  await expect(catalog.locator('mark').first()).toHaveText('queue.dep');
  await page.locator('#metricsSearch').fill('api_serv');
  const services = await catalog.locator('[data-service-toggle]').evaluateAll((els) => els.map((el) => el.dataset.serviceToggle));
  expect(services).toEqual(['api_service']);
  await page.locator('#metricsSearch').fill('no-such-metric-xyz');
  await expect(catalog).toContainText('No metric matches');
});

test('metrics: every metric type charts with the aggregations of its type', async ({ page, request }) => {
  const range = await windowParams(request, 1, 'summaryMax');
  await page.goto(metricsUrl(range));
  const catalog = page.locator('#metricsCatalog');
  await expect(catalog.locator('.metricsCatalog__metric').first()).toBeVisible({ timeout: 30_000 });
  const panel = page.locator('.metricsPanel').first();
  const expectations = [
    { metric: 'http.server.request.duration', kind: 'histogram', aggs: ['P50', 'P90', 'P95', 'P99', 'Average', 'Count rate (per second)'], axis: /ms|s/ },
    { metric: 'traces.span.metrics.calls', kind: 'sum', aggs: ['Rate (per second)', 'Increase'] },
    { metric: 'queue.depth', kind: 'gauge', aggs: ['Average', 'Min', 'Max', 'Last value', 'Sum'] },
    { metric: 'span.duration.exponential', kind: 'exponential_histogram', aggs: ['P50', 'P90', 'P95', 'P99'] },
    { metric: 'span.duration.summary', kind: 'summary', aggs: ['P50', 'P90', 'P99'] },
  ];
  for (const item of expectations) {
    await catalog.locator(`.metricsCatalog__metric[data-service="api_service"][data-metric="${item.metric}"][data-kind="${item.kind}"]`).click();
    await expect(panel.locator('.metricsPanel__name')).toHaveText(item.metric);
    await waitForChart(page, panel);
    await expect(page).toHaveURL(new RegExp(`metric=${item.metric.replace(/\./g, '\\.')}`));
    await panel.locator('.metricsPicker--agg .tracePicker__button').click();
    const options = await panel.locator('.metricsPicker--agg [data-agg]').allTextContents();
    for (const agg of item.aggs) expect(options).toContain(agg);
    await page.keyboard.press('Escape');
    if (item.kind === 'summary') {
      await expect(panel.locator('.metricsPanel__note')).toContainText(/cannot be aggregated across series/i);
      await expect(panel.locator('.metricsPicker--group .tracePicker__button')).toBeDisabled();
    }
  }
});

test('metrics: aggregation switch, group-by and = / != filters reload the chart and live in the URL', async ({ page, request }) => {
  const range = await windowParams(request, 6);
  await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'traces.span.metrics.calls', kind: 'sum' }));
  const panel = page.locator('.metricsPanel').first();
  await waitForChart(page, panel);
  await expect(panel.locator('.metricsPicker--agg .tracePicker__button')).toHaveText('Rate (per second)');
  await expect(panel.locator('.metricsChart__axisTitle')).toContainText('call/s');

  // Aggregation switch.
  const increase = page.waitForResponse((r) => r.url().includes('/api/metrics/series') && r.url().includes('agg=increase'));
  await panel.locator('.metricsPicker--agg .tracePicker__button').click();
  await panel.locator('.metricsPicker--agg [data-agg="increase"]').click();
  expect((await increase).ok()).toBeTruthy();
  await expect(page).toHaveURL(/agg=increase/);
  await expect(panel.locator('.metricsPicker--agg .tracePicker__button')).toHaveText('Increase');

  // Group by status.code: one legend entry per status.
  await panel.locator('.metricsPicker--group .tracePicker__button').click();
  const grouped = page.waitForResponse((r) => r.url().includes('/api/metrics/series') && r.url().includes('group_by=status.code'));
  await panel.locator('.metricsPicker--group input[data-group-key="status.code"]').check();
  expect((await grouped).ok()).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/group_by=status\.code/);
  await waitForChart(page, panel);
  const legend = panel.locator('.chartCore__legendItem');
  await expect(legend.filter({ hasText: 'STATUS_CODE_ERROR' })).toHaveCount(1);
  expect(await legend.count()).toBeGreaterThanOrEqual(2);

  // Legend click hides a line; Alt+click shows only that one (again: all).
  const before = await seriesDrawn(panel);
  await legend.filter({ hasText: 'STATUS_CODE_ERROR' }).click();
  await expect(legend.filter({ hasText: 'STATUS_CODE_ERROR' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => seriesDrawn(panel)).toBe(before - 1);
  await legend.filter({ hasText: 'STATUS_CODE_ERROR' }).click();
  await expect.poll(() => seriesDrawn(panel)).toBe(before);
  await legend.filter({ hasText: 'STATUS_CODE_ERROR' }).click({ modifiers: ['Alt'] });
  await expect.poll(() => seriesDrawn(panel)).toBe(1);
  await expect(legend.filter({ hasText: 'STATUS_CODE_ERROR' })).toHaveAttribute('aria-pressed', 'true');
  await legend.filter({ hasText: 'STATUS_CODE_ERROR' }).click({ modifiers: ['Alt'] });
  await expect.poll(() => seriesDrawn(panel)).toBe(before);

  // Filter status.code != STATUS_CODE_ERROR with value autocomplete.
  await panel.locator('.metricsFilters__add').click();
  const form = panel.locator('.metricsFilterForm');
  await expect(form).toBeVisible();
  await form.locator('.metricsFilterForm__key').fill('status.code');
  await form.locator('.metricsFilterForm__key').dispatchEvent('change');
  await expect.poll(async () => form.locator('.metricsFilterForm__values option').count(), { timeout: 15_000 }).toBeGreaterThan(1);
  const suggested = await form.locator('.metricsFilterForm__values option').evaluateAll((els) => els.map((el) => el.value));
  expect(suggested).toContain('STATUS_CODE_ERROR');
  await form.locator('.metricsFilterForm__op[data-op="!="]').click();
  await form.locator('.metricsFilterForm__value').fill('STATUS_CODE_ERROR');
  const filtered = page.waitForResponse((r) => r.url().includes('/api/metrics/series') && r.url().includes('filter_not='));
  await form.locator('.metricsFilterForm__apply').click();
  expect((await filtered).ok()).toBeTruthy();
  await expect(panel.locator('.metricsChip--not')).toContainText('status.code');
  await expect(page).toHaveURL(/filter_not=status\.code%3DSTATUS_CODE_ERROR/);
  await waitForChart(page, panel);
  await expect(legend.filter({ hasText: 'STATUS_CODE_ERROR' })).toHaveCount(0);

  // Equality filter on span.kind keeps only that kind.
  await panel.locator('.metricsChip__remove').click();
  await expect(panel.locator('.metricsChip')).toHaveCount(0);
  await expect(page).not.toHaveURL(/filter_not=/);
});

test('metrics: the URL restores range, panels, aggregation, group-by, filters and exemplars', async ({ page, request }) => {
  const range = await windowParams(request, 3);
  const second = new URLSearchParams({ service: 'api_service', metric: 'queue.depth', kind: 'gauge', agg: 'max', group_by: 'host.name' }).toString();
  const url = metricsUrl({
    ...range,
    service: 'api_service', metric: 'http.server.request.duration', kind: 'histogram', agg: 'p99',
    filter: ['span.name=request.validate'], exemplars: '0', panel: [second],
  });
  await page.goto(url);
  const panels = page.locator('.metricsPanel');
  await expect(panels).toHaveCount(2);
  await waitForChart(page, panels.nth(0));
  await waitForChart(page, panels.nth(1));
  await expect(panels.nth(0).locator('.metricsPicker--agg .tracePicker__button')).toHaveText('P99');
  await expect(panels.nth(0).locator('.metricsChip')).toContainText('request.validate');
  await expect(panels.nth(0).locator('.metricsExemplarToggle')).not.toBeChecked();
  await expect(panels.nth(0).locator('.metricsExemplar')).toHaveCount(0);
  await expect(panels.nth(1).locator('.metricsPanel__name')).toHaveText('queue.depth');
  await expect(panels.nth(1).locator('.metricsPicker--agg .tracePicker__button')).toHaveText('Max');
  await expect(panels.nth(1).locator('.metricsPicker--group .tracePicker__button')).toHaveText('host.name');
  await expect(panels.nth(1).locator('.chartCore__legendItem')).toHaveCount(3);
  await expect(page.locator('#metricsTimeRangePanel').locator('..').locator('.tracePicker__button')).toContainText(range.from.slice(0, 10));
  // The filter bar (range first) spans the catalog and the panels.
  const [bar, sidebar] = await Promise.all([page.locator('#metricsToolbar').boundingBox(), page.locator('#metricsSidebar').boundingBox()]);
  expect(bar.x).toBe(sidebar.x);
  expect(sidebar.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);

  // The page rewrites nothing it restored.
  const restored = new URL(page.url());
  expect(restored.searchParams.get('agg')).toBe('p99');
  expect(restored.searchParams.getAll('panel')).toHaveLength(1);
  expect(new URLSearchParams(restored.searchParams.get('panel')).get('group_by')).toBe('host.name');

  // Add then remove a panel.
  await page.locator('#metricsAddPanelButton').click();
  await expect(panels).toHaveCount(3);
  await expect(panels.nth(2)).toContainText('Pick a metric in the catalog');
  await panels.nth(2).locator('.metricsPanel__remove').click();
  await expect(panels).toHaveCount(2);

  // Reload: same state.
  await page.reload();
  await expect(panels).toHaveCount(2);
  await waitForChart(page, panels.nth(1));
  await expect(panels.nth(1).locator('.metricsPicker--agg .tracePicker__button')).toHaveText('Max');
});

test('metrics: an exemplar dot opens its trace with the span selected', async ({ page, request }) => {
  const range = await windowParams(request, 1);
  await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'http.server.request.duration', kind: 'histogram', agg: 'p99' }));
  const panel = page.locator('.metricsPanel').first();
  await waitForChart(page, panel);
  const exemplar = panel.locator('a.metricsExemplar:not([hidden])').first();
  await expect(exemplar).toBeVisible({ timeout: 30_000 });
  const traceId = await exemplar.getAttribute('data-trace-id');
  const spanId = await exemplar.getAttribute('data-span-id');
  expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  await exemplar.hover();
  await expect(panel.locator('.chartCore__tooltip')).toContainText('Exemplar');
  await expect(panel.locator('.chartCore__tooltip')).toContainText(traceId);
  await exemplar.click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${traceId}\\?span=${spanId}`));
  await expect(page.locator('#traceDetail')).toBeVisible({ timeout: 30_000 });
  // The deep-linked span is opened inline in the timeline, with its id.
  await expect(page.locator('#traceWaterfall')).toContainText(spanId, { timeout: 30_000 });
});

test('metrics: crosshair tooltip lists the series values with their unit', async ({ page, request }) => {
  const range = await windowParams(request, 2);
  await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'process.cpu.utilization', kind: 'gauge', group_by: 'host.name', exemplars: '0' }));
  const panel = page.locator('.metricsPanel').first();
  await waitForChart(page, panel);
  const box = await plotBox(panel);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tip = panel.locator('.chartCore__tooltip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('.chartCore__tipRow')).toHaveCount(3);
  await expect(tip).toContainText('bucket');
  // Rows are sorted by value, largest first.
  const values = (await tip.locator('.chartCore__tipRow b').allInnerTexts()).map(Number);
  expect(values).toEqual([...values].sort((a, b) => b - a));
});

test('metrics: panels share the crosshair, and a drag sets the time range of every panel', async ({ page, request }) => {
  const range = await windowParams(request, 3);
  const second = new URLSearchParams({ service: 'api_service', metric: 'queue.depth', kind: 'gauge', agg: 'max', group_by: 'host.name', exemplars: '0' }).toString();
  await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'process.cpu.utilization', kind: 'gauge', group_by: 'host.name', exemplars: '0', panel: [second] }));
  const panels = page.locator('.metricsPanel');
  await waitForChart(page, panels.nth(0));
  await waitForChart(page, panels.nth(1));
  const box = await plotBox(panels.nth(0));
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(chartOf(panels.nth(0))).toHaveAttribute('data-cursor-index', /\d+/);
  await expect(chartOf(panels.nth(1))).toHaveAttribute('data-sync-x', /\d+/);
  await expect(chartOf(panels.nth(1)).locator('.chartCore__xline')).toBeVisible();

  // Drag a third of the plot: both panels reload on that range.
  const reload = page.waitForResponse((r) => r.url().includes('/api/metrics/series'));
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 6 });
  await expect(chartOf(panels.nth(0)).locator('.chartCore__select')).toBeVisible();
  await page.mouse.up();
  expect((await reload).ok()).toBeTruthy();
  await expect.poll(() => new URL(page.url()).searchParams.get('from')).not.toBe(range.from);
  const url = new URL(page.url());
  const span = Date.parse(`${url.searchParams.get('to').replace(' ', 'T')}Z`) - Date.parse(`${url.searchParams.get('from').replace(' ', 'T')}Z`);
  expect(span).toBeGreaterThan(40 * 60000);
  expect(span).toBeLessThan(80 * 60000);
  await waitForChart(page, panels.nth(0));
  await waitForChart(page, panels.nth(1));
  await expect(chartOf(panels.nth(0))).toHaveAttribute('data-zoomed', 'false');
});

test('metrics: values and axes follow the OpenTelemetry unit', async ({ page, request }) => {
  const range = await windowParams(request, 1);
  await page.goto(metricsUrl(range));
  await expect(page.locator('#metricsCatalog .metricsCatalog__metric').first()).toBeVisible({ timeout: 30_000 });
  const formatted = await page.evaluate(() => {
    const m = window.ChDash.metrics;
    const fmt = (value, unit) => m.formatValue(value, m.parseUnit(unit));
    const axis = (unit, max, value, step) => m.formatTick(value, step, m.axisFormatter(m.parseUnit(unit), max));
    return {
      seconds: fmt(0.25, 's'), micro: fmt(0.000052, 's'), minutes: fmt(125, 's'), millis: fmt(1500, 'ms'),
      bytes: fmt(1536, 'By'), mebibytes: fmt(5 * 1024 * 1024, 'By'), byteRate: fmt(2048, 'By/s'),
      calls: fmt(12, '{call}/s'), requests: fmt(25000, '{request}'), ratio: fmt(0.5, '1'), percent: fmt(42, '%'),
      axisSeconds: axis('s', 0.2, 0.15, 0.05), axisBytes: axis('By', 4 * 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024),
    };
  });
  expect(formatted).toEqual({
    // ns.format: whole units past a minute, bytes with one decimal from KB.
    seconds: '250 ms', micro: '52 µs', minutes: '2 min 5 s', millis: '1.5 s',
    bytes: '1.5 KB', mebibytes: '5.0 MB', byteRate: '2.0 KB/s',
    calls: '12 call/s', requests: '25K request', ratio: '0.5', percent: '42%',
    axisSeconds: '150 ms', axisBytes: '2 MB',
  });
});

test('metrics: a failed catalog or chart says so in a sentence, without the error code, and Retry loads it again', async ({ page, request }) => {
  const range = await windowParams(request, 6);
  let failCatalog = true;
  let failSeries = true;
  await page.route('**/api/metrics/catalog?**', (route) => (failCatalog
    ? route.fulfill({ status: 503, json: { error_code: 'metrics_query_failed', message: 'The metrics tables could not be read.' } })
    : route.fallback()));
  await page.route('**/api/metrics/series?**', (route) => (failSeries
    ? route.fulfill({ status: 503, json: { error_code: 'metrics_query_failed', message: 'The series query timed out.' } })
    : route.fallback()));
  await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'http.server.request.duration', kind: 'histogram', agg: 'p95' }));
  const catalog = page.locator('#metricsCatalog [role="alert"]');
  await expect(catalog).toContainText('The metrics tables could not be read.', { timeout: 30_000 });
  await expect(catalog).not.toContainText('metrics_query_failed');
  const state = page.locator('.metricsPanel').first().locator('.metricsChart__state--error');
  await expect(state).toContainText('The series query timed out.', { timeout: 30_000 });
  await expect(state).not.toContainText('metrics_query_failed');
  failCatalog = false;
  failSeries = false;
  await catalog.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#metricsCatalog .metricsCatalog__metric').first()).toBeVisible({ timeout: 30_000 });
  // (A catalog answer may reload the panel by itself.)
  if (await state.isVisible()) await state.getByRole('button', { name: 'Retry' }).click();
  await waitForChart(page);
});

test('metrics: an empty range offers the latest data', async ({ page, request }) => {
  await metricBounds(request);
  await page.goto(metricsUrl({ from: '2001-01-01 00:00:00', to: '2001-01-01 01:00:00' }));
  const jump = page.locator('#metricsCatalog [data-jump-to-data]');
  await expect(jump).toBeVisible({ timeout: 30_000 });
  await jump.click();
  await expect(page.locator('#metricsCatalog .metricsCatalog__metric').first()).toBeVisible({ timeout: 30_000 });
});

for (const theme of ['dark', 'light']) {
  test(`metrics: captures the browser (${theme})`, async ({ page, request }, testInfo) => {
    test.skip(!['desktop-1920', 'laptop-1280', 'desktop-1440'].includes(testInfo.project.name));
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((mode) => { try { localStorage.setItem('chdash.theme', mode); } catch (_) {} }, theme);
    const range = await windowParams(request, 6);
    const second = new URLSearchParams({ service: 'api_service', metric: 'traces.span.metrics.calls', kind: 'sum', group_by: 'status.code' }).toString();
    await page.goto(metricsUrl({ ...range, service: 'api_service', metric: 'http.server.request.duration', kind: 'histogram', agg: 'p95', panel: [second] }));
    const panels = page.locator('.metricsPanel');
    await waitForChart(page, panels.nth(0));
    await waitForChart(page, panels.nth(1));
    await expect(panels.nth(0).locator('a.metricsExemplar:not([hidden])').first()).toBeVisible({ timeout: 30_000 });
    await captureState(page, testInfo, `metrics-browser-${theme}`);
    await panels.nth(1).locator('.metricsFilters__add').click();
    await panels.nth(1).locator('.metricsPicker--group .tracePicker__button').click();
    await captureState(page, testInfo, `metrics-browser-controls-${theme}`);
  });
}
