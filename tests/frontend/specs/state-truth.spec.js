import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { runSuccessfulQuery } from '../helpers/app.js';
import { nestedTrace, routeTrace } from '../helpers/trace-mocks.js';
import { canvasPixel, plotBox } from '../helpers/charts.js';
import { stamp } from '../helpers/time.js';

// States and data that tell the truth (design review, Lot 1): a panel with a metric and no service asks for one, a
// click on a metric names it, the critical path does not strike a span's label, a stop of the data breaks the line,
// a shortened range is said, and a dashed series is dashed in its legend.

async function metricsWindow(request) {
  const meta = await (await request.get('/api/metrics/meta')).json();
  test.skip(!meta.enabled || !meta.kinds?.histogram?.time_bounds, 'metrics are disabled or empty');
  const end = Math.floor(Number(meta.kinds.histogram.time_bounds.max_ms) / 60000) * 60000;
  return { from: stamp(end - 6 * 3600000), to: stamp(end) };
}

const metricsUrl = (range, extra = '') => `/observability/metrics?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${extra}`;
const METRIC = 'metric=http.server.request.duration&kind=histogram';
const panelState = (page) => page.locator('.metricsPanel').first().locator('.metricsChart__state');

// --- Metrics: a metric without a service (UI-064) and the click on a metric (UI-065) ----------------------------

test('metrics: a panel with a metric and no service asks for the service, one button each, and charts the one picked', async ({ page, request }) => {
  const range = await metricsWindow(request);
  await page.goto(metricsUrl(range, `&${METRIC}`));
  const state = panelState(page);
  await expect(state).toContainText('Choose a service for http.server.request.duration', { timeout: 30_000 });
  const choices = state.locator('[data-metrics-service]');
  const count = await choices.count();
  expect(count).toBeGreaterThan(1);
  // The controls that need a service wait for it; nothing was asked of the server.
  await expect(page.locator('.metricsPanel').first().locator('.metricsPicker--agg .tracePicker__button')).toBeDisabled();
  const names = await choices.evaluateAll((els) => els.map((el) => el.dataset.metricsService));
  expect(names).toContain('api_service');
  await choices.filter({ hasText: 'api_service' }).click();
  await expect(page.locator('.metricsPanel').first().locator('.metricsPanel__service')).toContainText('api_service');
  await expect(page.locator('.metricsPanel').first().locator('.metricsChart .chartCore .chartCore__canvas')).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).searchParams.get('service')).toBe('api_service');
});

test('metrics: the panel that asks for a service has no axe violation', async ({ page, request }) => {
  const range = await metricsWindow(request);
  await page.goto(metricsUrl(range, `&${METRIC}`));
  await expect(panelState(page).locator('[data-metrics-service]').first()).toBeVisible({ timeout: 30_000 });
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

test('metrics: the name of a metric charts it and keeps its services open; the chevron folds them; Left and Right fold and unfold', async ({ page, request }) => {
  const range = await metricsWindow(request);
  await page.goto(metricsUrl(range));
  const group = page.locator('#metricsCatalog .metricsCatalog__group[data-metric-group="http.server.request.duration"]');
  const head = group.locator('[data-metric-toggle]');
  await expect(head).toBeVisible({ timeout: 30_000 });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  // The name: the panel takes the metric and asks for a service; the services of the metric are open.
  await head.locator('.metricsCatalog__metricName').click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.metricsPanel').first().locator('.metricsPanel__name')).toHaveText('http.server.request.duration');
  await expect(panelState(page)).toContainText('Choose a service');
  // Another click on the name does not fold it again.
  await head.locator('.metricsCatalog__metricName').click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  // The chevron folds.
  // (The icon takes no pointer events: click at its place, the left edge of the head.)
  await head.click({ position: { x: 14, y: 12 } });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.metricsPanel').first().locator('.metricsPanel__name')).toHaveText('http.server.request.duration');
  // The keys, as in a tree: Right unfolds, Left folds.
  await head.focus();
  await page.keyboard.press('ArrowRight');
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(head).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await expect(head).toBeFocused();
});

test('metrics: a catalog with nothing to list is a group, not a tree with a button in it', async ({ page }) => {
  await page.goto('/observability/metrics?from=2001-01-01%2000:00:00&to=2001-01-01%2001:00:00');
  await expect(page.locator('#metricsCatalog .uiState')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#metricsCatalog')).toHaveAttribute('role', 'group');
});

// --- Trace: the critical path stays on the lower edge of the bar (UI-056) -----------------------------------------

test('trace: the critical path is a strip on the lower edge of the bar, never across the middle where the label is', async ({ page }) => {
  const trace = nestedTrace();
  await routeTrace(page, trace);
  await page.goto(`/observability/traces/${trace.trace_id}`);
  const row = page.locator('#traceWaterfall .traceSpanRow', { has: page.locator('.traceSpanBar__critical') }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const geometry = await row.evaluate((el) => {
    const bar = el.querySelector('.traceSpanBar').getBoundingClientRect();
    const strip = el.querySelector('.traceSpanBar__critical').getBoundingClientRect();
    return { barTop: bar.top, barBottom: bar.bottom, stripTop: strip.top, stripBottom: strip.bottom, stripHeight: strip.height };
  });
  expect(geometry.stripHeight).toBeLessThanOrEqual(2.5);
  // Its top is in the bar's lower 2.5 px: under a label that is centred on the bar.
  expect(geometry.stripTop).toBeGreaterThanOrEqual(geometry.barBottom - 2.5);
  expect(geometry.stripTop).toBeGreaterThan((geometry.barTop + geometry.barBottom) / 2);
});

// --- Query chart: a stop of the data breaks the line (UI-023) ----------------------------------------------------------

const GAP_SQL = `SELECT toDateTime('2026-01-01 00:00:00') + INTERVAL number HOUR AS t, 10 AS v FROM numbers(24) WHERE number NOT IN (10, 11, 12) ORDER BY t`;

test('query chart: rows missing on a regular time axis break the line; "Connect gaps" joins it', async ({ page }) => {
  await page.goto('/query');
  await runSuccessfulQuery(page, GAP_SQL);
  await page.locator('.segmented__option[data-view="chart"]').first().click();
  const chart = page.locator('.queryChart .chartCore').first();
  await expect(chart.locator('canvas.chartCore__canvas')).toBeVisible({ timeout: 20_000 });
  const gaps = page.locator('.queryChart__gaps');
  await expect(gaps).toBeVisible();
  await expect(gaps).toHaveAttribute('aria-pressed', 'false');
  await expect(gaps).toHaveAttribute('title', /^1 gap: /);
  const box = await plotBox(chart);
  const [, , , plotHeight] = [0, 0, 0, box.height];
  // The values are one constant: the line is horizontal, at the middle of the plot. Hours 0..9 and 13..23 are present
  // (the plot runs from the first to the last hour), 10..12 are missing.
  const at = (hour) => box.x + (box.width * hour) / 23;
  const y = box.y + plotHeight / 2;
  // The line is drawn 1.5 px thick: look in a 5 px column for its colour (the grid is 9 % of the text colour).
  const inked = async (hour) => {
    let best = 0;
    for (let dy = -3; dy <= 3; dy += 1) best = Math.max(best, (await canvasPixel(chart, at(hour), y + dy))[3]);
    return best;
  };
  expect(await inked(4.5)).toBeGreaterThan(150);
  expect(await inked(11)).toBeLessThan(80);
  await gaps.click();
  await expect(gaps).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => inked(11)).toBeGreaterThan(150);
});

test('query chart: a series that is not on a regular step keeps its line (event times are not gaps)', async ({ page }) => {
  await page.goto('/query');
  await runSuccessfulQuery(page, `SELECT toDateTime('2026-01-01 00:00:00') + INTERVAL (number * number) MINUTE AS t, 10 AS v FROM numbers(20) ORDER BY t`);
  await page.locator('.segmented__option[data-view="chart"]').first().click();
  const chart = page.locator('.queryChart .chartCore').first();
  await expect(chart.locator('canvas.chartCore__canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.queryChart__gaps')).toBeHidden();
});

// --- Traces: a range the server shortens is said (UI-008) --------------------------------------------------------------

test('traces: a range wider than the server allows is shortened with a notice, not silently', async ({ page, request }) => {
  const meta = await (await request.get('/api/traces/meta')).json();
  test.skip(!meta.enabled, 'traces are disabled');
  const maxDays = Number(meta.max_lookback_minutes) / 1440;
  test.skip(!(maxDays > 0 && maxDays < 3650), 'the lookback has no practical limit');
  await page.goto(`/observability/traces?from=now-${Math.ceil(maxDays) + 30}d&to=now`);
  const notice = page.locator('#tracesError');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveClass(/uiBanner--info/);
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('is longer than the server allows');
  await expect(notice).toContainText('max_lookback_minutes');
  // Another range ends the notice.
  await page.locator('#tracesWorkspace .tracePicker__button', { hasText: 'Time range' }).first().click();
  await page.locator('#tracesTimeRangePanel .timeRangeList__item', { hasText: 'Last 15 minutes' }).first().click();
  await expect(notice).toBeHidden();
});

// --- Charts: a dashed series is dashed in its legend (UI-087) ---------------------------------------------------------

test('charts: the legend swatch of a dashed series is dashed', async ({ page }) => {
  // The System pages load the chart engine with the page (the Query page loads it with its chart view).
  await page.goto('/system/disks');
  await page.waitForFunction(() => !!window.ChDash?.chartCore?.create);
  const swatches = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'width:600px;height:200px;position:fixed;left:0;top:0;z-index:99999';
    document.body.appendChild(host);
    const xs = Float64Array.from([0, 1, 2, 3]);
    const values = (k) => Float64Array.from([1, 2, 3, 4].map((v) => v * k));
    const chart = window.ChDash.chartCore.create(host, {
      xKind: 'number', xs, type: 'line', height: 160,
      series: [
        { id: 'tracked', label: 'Tracked', color: 'var(--qchart-1)', values: values(1), nulls: null },
        { id: 'peak', label: 'Tracked peak', color: 'var(--qchart-2)', values: values(2), nulls: null, dash: [6, 3] },
      ],
    });
    chart.flush();
    const read = () => [...host.querySelectorAll('.chartCore__legendItem')].map((item) => ({
      label: item.textContent.trim(), dashed: item.classList.contains('is-dashed'),
      image: getComputedStyle(item.querySelector('i')).backgroundImage, color: getComputedStyle(item.querySelector('i')).backgroundColor,
    }));
    const out = read();
    chart.destroy?.();
    host.remove();
    return out;
  });
  const solid = swatches.find((s) => s.label === 'Tracked');
  const dashed = swatches.find((s) => s.label === 'Tracked peak');
  expect(solid.image).toBe('none');
  expect(dashed.dashed).toBe(true);
  expect(dashed.image).toContain('repeating-linear-gradient');
  // The swatch keeps the series colour under the dashes.
  expect(dashed.color).not.toBe('rgba(0, 0, 0, 0)');
});

// --- Disks: one line a filesystem (UI-089) --------------------------------------------------------------------------------

test('disks: the "Disk used" chart has one series for each filesystem card, named after every disk it holds', async ({ page }) => {
  await page.goto('/system/disks');
  const card = page.locator('#systemDiskChart-used');
  const cards = page.locator('#systemDiskCards .systemDisk');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  test.skip(!(await card.isVisible({ timeout: 15_000 }).catch(() => false)), 'no disk growth history (asynchronous_metric_log)');
  const series = card.locator('.chartCore__legendItem');
  await expect(series.first()).toBeVisible();
  expect(await series.count()).toBe(await cards.count());
  const labels = await series.allInnerTexts();
  for (const group of await cards.evaluateAll((els) => els.map((el) => (el.dataset.disks || '').split(' ').filter(Boolean)))) {
    if (group.length > 1) expect(labels.some((label) => group.every((name) => label.includes(name))), group.join(', ')).toBe(true);
  }
});
