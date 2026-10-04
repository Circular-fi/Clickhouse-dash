import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal, waitForBatch } from '../helpers/app.js';
import { chartJson, xLabelCollisions, xRepeatedYears } from '../helpers/charts.js';

// Query result Table / Chart view: the chart is drawn client-side from the
// rows a result panel received, per panel (main and every multiquery panel),
// on canvas by the shared engine (app_chart_core.js). Canvas pixels are not
// read: the engine publishes what it drew on its root (data-series-stats,
// data-points-drawn, data-x-min / data-x-max, data-zoomed, data-cursor-x...).

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const EXAMPLE = 'SELECT number, now() + number, [number, 1], number - 10, number + 2 FROM numbers(200000) LIMIT 10000';
const EXAMPLE_200K = 'SELECT number, now() + number, [number, 1], number - 10, number + 2 FROM numbers(200000)';
const TIME_SERIES = 'SELECT toStartOfMinute(now() - number * 60) AS t, number % 7 AS v, number % 3 AS w FROM numbers(120)';
const GROUPED = "SELECT toStartOfMinute(now() - number * 60) AS t, number % 7 AS v, ['a', 'b', 'c'][number % 3 + 1] AS g FROM numbers(120)";
const BARS = "SELECT ['alpha', 'beta', 'gamma'][number % 3 + 1] AS k, count() AS c FROM numbers(30) GROUP BY k ORDER BY k";
const dataRows = 'tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)';
const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/query-chart`;

const mainToggle = (page) => page.locator('#resultsPanel .resultsViewToggle--main');
// A chart picker (ns.menu.select over the hidden native select): its button, then the option.
async function pickChart(chart, select, value) {
  const picker = chart.locator(`.tracePicker:has(> ${select})`);
  await picker.locator('.tracePicker__button').click();
  await picker.locator(`.tracePicker__option[data-value="${value}"]`).click();
}
const mainChart = (page) => page.locator('#resultsPanel > .queryChart');
const mainTable = (page) => page.locator('#resultsPanel > .tableWrap');
const core = (chart) => chart.locator('.chartCore');

async function showChart(scope) {
  await scope.locator('.segmented__option[data-view="chart"]').first().click();
}

async function enableMultiquery(page) {
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
}

async function seriesStats(chart) {
  await expect(core(chart)).toHaveAttribute('data-series-stats', /\{/);
  return JSON.parse(await core(chart).getAttribute('data-series-stats'));
}

// The plot area (inside the axes) in page coordinates.
async function plotBox(chart) {
  await expect(core(chart)).toHaveAttribute('data-plot', /\d/);
  const [left, top, width, height] = (await core(chart).getAttribute('data-plot')).split(' ').map(Number);
  // The mouse only reaches what the viewport shows (1280 x 800 included).
  await chart.locator('.chartCore__overlay').evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'center' });
  });
  const box = await chart.locator('.chartCore__overlay').boundingBox();
  return { x: box.x + left, y: box.y + top, width, height, left };
}

// Hover the plot at a fraction of its width; returns the snapped index, the
// exact x readout and the crosshair / pointer positions (plot css px).
async function hoverPlot(page, chart, fraction, yFraction = 0.5) {
  const box = await plotBox(chart);
  const x = box.x + box.width * fraction;
  const overlay = await chart.locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(x, box.y + box.height * yFraction);
  const tooltip = chart.locator('.chartCore__tooltip');
  await expect(tooltip).toBeVisible();
  // The cursor follows the pointer on the next frame: until the chart reports
  // this pointer position, the tooltip and readouts are the previous hover's.
  await expect.poll(async () => {
    const at = await core(chart).getAttribute('data-pointer-px');
    return at === null ? Infinity : Math.abs(Number(at) - (x - overlay.x));
  }).toBeLessThanOrEqual(1);
  return {
    index: Number(await tooltip.getAttribute('data-index')),
    readout: await core(chart).getAttribute('data-cursor-x'),
    header: await tooltip.locator('strong').textContent(),
    pointerX: x - overlay.x,
    crossX: Number(await core(chart).getAttribute('data-cursor-px')),
    box,
  };
}

async function tooltipValues(chart) {
  const rows = chart.locator('.chartCore__tooltip .chartCore__tipRow');
  const out = {};
  for (const row of await rows.all()) out[await row.locator('em').textContent()] = await row.locator('b').textContent();
  return out;
}

// Click Chart and time it until the frame after the chart has drawn every
// row (a large result is parsed over several frames).
async function timeChartClick(page, scopeSelector, rows) {
  return page.evaluate(async ({ sel, rows: total }) => {
    const panel = document.querySelector(sel);
    const host = panel.querySelector(':scope > .queryChart') || panel.querySelector('.queryChart');
    const t0 = performance.now();
    panel.querySelector('.segmented__option[data-view="chart"]').click();
    await new Promise((resolve) => {
      const check = () => (host.dataset.pointsDrawn && Number(host.dataset.rowsCharted) === total && host.querySelector('.chartCore:not([hidden])') ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    return { ms: performance.now() - t0, renderMs: Number(host.dataset.renderMs) };
  }, { sel: scopeSelector, rows });
}

// Every chart draw, per animation frame, while `run` streams a result: the
// engine's and the Query chart's work counters, and the most draws one frame saw.
async function countWork(page, run) {
  await page.evaluate(() => {
    const ns = window.ChDash;
    ns.chartCore?.resetCounters();
    ns.queryChart.resetCounters();
    const w = (window.__work = { frames: 0, maxDraws: 0, last: 0, stop: false });
    const tick = () => {
      const draws = window.ChDash.chartCore ? window.ChDash.chartCore.counters().draws : 0;
      w.frames++;
      w.maxDraws = Math.max(w.maxDraws, draws - w.last);
      w.last = draws;
      if (!w.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await run();
  return page.evaluate(() => {
    window.__work.stop = true;
    const ns = window.ChDash;
    return { frames: window.__work.frames, maxDrawsPerFrame: window.__work.maxDraws, core: ns.chartCore ? ns.chartCore.counters() : null, q: ns.queryChart.counters() };
  });
}

// The page as in a background tab: document.hidden and visibilitychange
// (a headless page never hides by itself).
async function setPageHidden(page, hidden) {
  await page.evaluate((on) => {
    if (!window.__hiddenPatched) {
      window.__hiddenPatched = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__pageHidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__pageHidden ? 'hidden' : 'visible') });
    }
    window.__pageHidden = on;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

// Lets `count` animation frames render.
const frames = (page, count = 2) => page.evaluate((n) => new Promise((resolve) => {
  const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(n);
}), count);

// About two seconds of rows, in blocks of 100.
const SLOW_STREAM = 'SELECT number AS n, number * 2 AS d FROM numbers(4000) WHERE sleepEachRow(0.0005) = 0 SETTINGS max_block_size = 100';

// Rows of the example query streamed in about 100 chunks.
const STREAMED = 'SELECT number, now() + number, [number, 1], number - 10, number + 2 FROM numbers(200000) SETTINGS max_block_size = 2000';

test('the example query charts within budget, explains the Array column and reads x exactly', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'table'));
  await runSuccessfulQuery(page, EXAMPLE);
  const timing = await timeChartClick(page, '#resultsPanel', 10000);
  console.log(`example 10k: chart painted ${Math.round(timing.ms)} ms after the click (model + draw ${timing.renderMs} ms)`);
  expect(timing.ms).toBeLessThan(300);

  const chart = mainChart(page);
  await expect(chart).toHaveAttribute('data-x-kind', 'time');
  await expect(mainTable(page)).toBeHidden();
  // Self-explanatory controls: the label inside each picker, an explicit Auto choice.
  await expect(chart.locator('.queryChart__picker .tracePicker__button')).toHaveText([/^X axis \u00b7 /, /^Y values \u00b7 /, /^Split by \u00b7 /]);
  // The three pickers share one look (ns.menu pickers).
  const looks = await chart.locator('.queryChart__picker .tracePicker__button').evaluateAll((els) => els.map((el) => {
    const cs = getComputedStyle(el);
    return [cs.appearance, cs.height, cs.borderTopColor, cs.borderRadius, cs.backgroundColor, cs.backgroundImage, cs.paddingRight];
  }));
  expect(looks[1]).toEqual(looks[0]);
  expect(looks[2]).toEqual(looks[0]);
  await expect(chart.locator('.queryChart__x')).toHaveValue('auto');
  await expect(chart.locator('.queryChart__x option').first()).toHaveText('Auto (plus(now(), number))');
  await expect(chart.locator('.queryChart__x option[value="2"]')).toContainText('Array(UInt64)');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 number, minus(number, 10), plus(number, 2)');
  await expect(chart.locator('.queryChart__note')).toContainText('10,000 rows');
  await expect(chart.locator('.queryChart__note')).toContainText('not numeric, not drawn: [number, 1]');
  await chart.locator('.queryChart__seriesButton').click();
  const arrayOpt = chart.locator('.queryChart__seriesOpt.is-unavailable');
  await expect(arrayOpt).toHaveCount(1);
  await expect(arrayOpt).toContainText('[number, 1]');
  await expect(arrayOpt).toContainText('not numeric');
  await expect(arrayOpt.locator('input')).toBeDisabled();
  await page.keyboard.press('Escape');

  const stats = await seriesStats(chart);
  expect(Object.keys(stats)).toEqual(['number', 'minus(number, 10)', 'plus(number, 2)']);
  const plotW = (await plotBox(chart)).width;
  for (const s of Object.values(stats)) {
    expect(s.runs).toBe(1);
    // 10,000 points over ~1,300 px: at most 4 vertices per device pixel column.
    expect(s.points).toBeLessThanOrEqual(Math.ceil(plotW) * 4 + 4);
    expect(s.points).toBeGreaterThan(plotW);
  }
  // now() + 10,000 s can cross midnight: the end then repeats its date.
  // The shared range label (ns.format.range), the date once unless it changes.
  await expect(chart.locator('.queryChart__rangeText')).toContainText(/plus\(now\(\), number\) [A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d{2}:\d{2}:\d{2}\.000 → ([A-Z][a-z]{2} \d{1,2}(?:, \d{4})? )?\d{2}:\d{2}:\d{2}\.000/);

  // Crosshair: the readout is the exact instant of the snapped row, with ms.
  const first = await hoverPlot(page, chart, 0);
  expect(first.index).toBe(0);
  const t0 = Date.parse(`${first.readout.replace(' ', 'T')}Z`);
  for (const fraction of [0.1234, 0.5, 0.8765, 1]) {
    const h = await hoverPlot(page, chart, fraction);
    expect(h.readout).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(h.header).toBe(h.readout);
    expect(Math.abs(h.index - Math.round(fraction * 9999))).toBeLessThanOrEqual(10);
    expect(Date.parse(`${h.readout.replace(' ', 'T')}Z`) - t0).toBe(h.index * 1000);
    expect(Math.abs(h.crossX - h.pointerX)).toBeLessThanOrEqual(1);
    const n = h.index;
    expect(await tooltipValues(chart)).toEqual({
      number: n.toLocaleString('en-US'),
      'minus(number, 10)': (n - 10).toLocaleString('en-US'),
      'plus(number, 2)': (n + 2).toLocaleString('en-US'),
    });
  }
  // Keyboard: point by point.
  await chart.locator('.chartCore__overlay').focus();
  await page.keyboard.press('Home');
  await expect(core(chart)).toHaveAttribute('data-cursor-index', '0');
  await page.keyboard.press('ArrowRight');
  await expect(core(chart)).toHaveAttribute('data-cursor-index', '1');
  expect(Date.parse(`${(await core(chart).getAttribute('data-cursor-x')).replace(' ', 'T')}Z`) - t0).toBe(1000);
  expect(await tooltipValues(chart)).toEqual({ number: '1', 'minus(number, 10)': '-9', 'plus(number, 2)': '3' });
  await page.keyboard.press('End');
  await expect(core(chart)).toHaveAttribute('data-cursor-index', '9999');
  await page.keyboard.press('Escape');
  await expect(chart.locator('.chartCore__tooltip')).toBeHidden();
  await page.mouse.move(2, 2);
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/example-10k.png` });

  // 200,000 rows: same budget order, a min/max envelope per pixel.
  await mainToggle(page).locator('[data-view="table"]').click();
  await runSuccessfulQuery(page, EXAMPLE_200K);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached/i);
  const big = await timeChartClick(page, '#resultsPanel', 200000);
  console.log(`example 200k: chart painted ${Math.round(big.ms)} ms after the click (model + draw ${big.renderMs} ms)`);
  expect(big.ms).toBeLessThan(800);
  await expect(chart.locator('.queryChart__note')).toContainText('200,000 rows');
  await expect(chart.locator('.queryChart__note')).toContainText('min/max envelope');
  for (const s of Object.values(await seriesStats(chart))) expect(s.points).toBeLessThanOrEqual(Math.ceil(plotW) * 4 + 4);
  const deep = await hoverPlot(page, chart, 0.4321);
  expect(Math.abs(deep.index - Math.round(0.4321 * 199999))).toBeLessThanOrEqual(200);
  expect((await tooltipValues(chart)).number).toBe(deep.index.toLocaleString('en-US'));
});

test('millisecond timestamps read to the millisecond; numeric x reads the exact value', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, "SELECT toDateTime64('2026-01-01 00:00:00', 3, 'UTC') + toIntervalMillisecond(number * 7) AS t, number AS v FROM numbers(50)");
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await chart.locator('.chartCore__overlay').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(core(chart)).toHaveAttribute('data-cursor-x', '2026-01-01 00:00:00.014');
  await expect(chart.locator('.chartCore__tooltip strong')).toHaveText('2026-01-01 00:00:00.014');
  // Few points: dots are drawn and the x range is in the header.
  await expect(chart.locator('.queryChart__rangeText')).toContainText(/Jan 1(?:, 2026)? 00:00:00\.000 → 00:00:00\.343/);

  await runSuccessfulQuery(page, 'SELECT number / 8 AS x, number * 3 AS y, number AS z FROM numbers(20)');
  await expect(chart).toHaveAttribute('data-x-kind', 'number');
  await chart.locator('.chartCore__overlay').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await expect(core(chart)).toHaveAttribute('data-cursor-x', '2.25');
  expect(await tooltipValues(chart)).toEqual({ y: '54', z: '18' });
});

test('drag zooms the x axis, double-click and Reset zoom restore it', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, EXAMPLE);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const root = core(chart);
  await expect(root).toHaveAttribute('data-zoomed', 'false');
  const fullMin = Number(await root.getAttribute('data-x-min'));
  const fullMax = Number(await root.getAttribute('data-x-max'));
  const fullYMax = Number(await root.getAttribute('data-y-max'));
  await expect(chart.locator('.queryChart__resetZoom')).toBeHidden();

  const zoomTo = async (from, to) => {
    const box = await plotBox(chart);
    await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * ((from + to) / 2), box.y + box.height / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect(root).toHaveAttribute('data-zoomed', 'true');
  };
  await zoomTo(0.2, 0.4);
  const zMin = Number(await root.getAttribute('data-x-min'));
  const zMax = Number(await root.getAttribute('data-x-max'));
  const span = fullMax - fullMin;
  expect(Math.abs((zMin - fullMin) / span - 0.2)).toBeLessThan(0.01);
  expect(Math.abs((zMax - fullMin) / span - 0.4)).toBeLessThan(0.01);
  // The y axis follows the visible points.
  expect(Number(await root.getAttribute('data-y-max'))).toBeLessThan(fullYMax * 0.6);
  await expect(chart.locator('.queryChart__resetZoom')).toBeVisible();
  await expect(chart.locator('.queryChart__range')).toHaveClass(/is-zoomed/);
  // The tooltip still reads full-resolution rows inside the zoomed range: the
  // middle of the plot is the row at the middle of the range the drag chose
  // (the drag lands within a pixel of 20 % / 40 %, a pixel being ~8 rows of
  // the full axis, so the nominal 30 % row is not a 5-row target).
  const inside = await hoverPlot(page, chart, 0.5);
  expect(Math.abs(inside.index - Math.round((((zMin + zMax) / 2) - fullMin) / span * 9999))).toBeLessThanOrEqual(5);
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/zoomed.png` });

  // Zooming again narrows further; double-click resets.
  await zoomTo(0.25, 0.75);
  expect(Number(await root.getAttribute('data-x-max')) - Number(await root.getAttribute('data-x-min'))).toBeLessThan((zMax - zMin) * 0.6);
  const box = await plotBox(chart);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(root).toHaveAttribute('data-zoomed', 'false');
  expect(Number(await root.getAttribute('data-x-min'))).toBe(fullMin);
  await expect(chart.locator('.queryChart__resetZoom')).toBeHidden();

  await zoomTo(0.6, 0.9);
  await chart.locator('.queryChart__resetZoom').click();
  await expect(root).toHaveAttribute('data-zoomed', 'false');
  // A short click is not a zoom.
  await page.mouse.click(box.x + box.width / 3, box.y + box.height / 2);
  await expect(root).toHaveAttribute('data-zoomed', 'false');
  // A new result starts unzoomed.
  await zoomTo(0.1, 0.3);
  await runSuccessfulQuery(page, EXAMPLE);
  await expect(root).toHaveAttribute('data-zoomed', 'false');
});

test('legend isolates on click, toggles on Ctrl+click, and lists min / max / mean / last', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, EXAMPLE);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const root = core(chart);
  const items = chart.locator('.chartCore__legendItem');
  await expect(items).toHaveText(['number', 'minus(number, 10)', 'plus(number, 2)']);
  await expect(root).toHaveAttribute('data-series-drawn', '3');

  await items.nth(0).click();
  await expect(root).toHaveAttribute('data-series-drawn', '1');
  await expect(items.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(items.nth(1)).toHaveAttribute('aria-pressed', 'false');
  expect(Object.keys(await seriesStats(chart))).toEqual(['number']);
  await hoverPlot(page, chart, 0.5);
  expect(Object.keys(await tooltipValues(chart))).toEqual(['number']);
  await page.mouse.move(2, 2);
  // Clicking the isolated series shows every series again.
  await items.nth(0).click();
  await expect(root).toHaveAttribute('data-series-drawn', '3');
  // Ctrl+click hides / shows one series.
  await items.nth(2).click({ modifiers: ['Control'] });
  await expect(root).toHaveAttribute('data-series-drawn', '2');
  await expect(items.nth(2)).toHaveAttribute('aria-pressed', 'false');
  await items.nth(2).click({ modifiers: ['Control'] });
  await expect(root).toHaveAttribute('data-series-drawn', '3');

  // Values mode: a table of calculations over the visible range.
  await chart.locator('.chartCore__legendMode').click();
  const table = chart.locator('.chartCore__legendTable');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveText(['Series', 'Min', 'Max', 'Mean', 'Last']);
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText(['0', '9,999', '4,999.5', '9,999']);
  await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['-10', '9,989', '4,989.5', '9,989']);
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('table');
  // The legend items of the table still isolate.
  await table.locator('.chartCore__legendItem').nth(1).click();
  await expect(root).toHaveAttribute('data-series-drawn', '1');
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/legend-table.png` });
  await chart.locator('.chartCore__legendMode').click();
  await expect(table).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('list');
});

test('x axis picker: Auto, row number or an explicit column', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, EXAMPLE);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const x = chart.locator('.queryChart__x');
  await expect(x).toHaveValue('auto');
  await expect(chart.locator('.queryChart__xField')).toHaveAttribute('title', /Auto: the first date \/ time column/);
  for (const btn of await chart.locator('.queryChart__types [data-type]').all()) expect(await btn.getAttribute('title')).toBeTruthy();

  await pickChart(chart, '.queryChart__x', '-1');
  await expect(chart).toHaveAttribute('data-x-kind', 'index');
  await expect(chart.locator('.queryChart__rangeText')).toContainText('Row 1 → 10,000');
  await chart.locator('.chartCore__overlay').focus();
  await page.keyboard.press('Home');
  await expect(core(chart)).toHaveAttribute('data-cursor-x', 'Row 1');

  await pickChart(chart, '.queryChart__x', '0');
  await expect(chart).toHaveAttribute('data-x-kind', 'number');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 minus(number, 10), plus(number, 2)');
  await expect(chart.locator('.queryChart__rangeText')).toContainText('number 0 → 9,999');

  // A text-like column as x: one category per value, drawn as bars.
  await pickChart(chart, '.queryChart__x', '2');
  await expect(chart).toHaveAttribute('data-x-kind', 'category');
  await expect(chart.locator('.queryChart__types [data-type="bar"]')).toHaveAttribute('aria-pressed', 'true');

  await pickChart(chart, '.queryChart__x', 'auto');
  await expect(chart).toHaveAttribute('data-x-kind', 'time');
  await expect(chart.locator('.queryChart__types [data-type="line"]')).toHaveAttribute('aria-pressed', 'true');
  // The choice is kept for the next result with the same columns.
  await pickChart(chart, '.queryChart__x', '0');
  await runSuccessfulQuery(page, EXAMPLE);
  await expect(x).toHaveValue('0');
  await expect(chart).toHaveAttribute('data-x-kind', 'number');
});

test('time series result switches between table and chart, types and series picker', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(mainToggle(page)).toBeVisible();
  await expect(mainToggle(page).locator('[data-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  // Icons, named for assistive technology and in a tooltip.
  await expect(mainToggle(page).getByRole('button', { name: 'Table view' })).toHaveAttribute('title', 'Show the rows as a table');
  await expect(mainToggle(page).getByRole('button', { name: 'Chart view' })).toHaveAttribute('title', 'Chart the received rows');
  await expect(mainToggle(page).locator('.segmented__option svg')).toHaveCount(2);
  await expect(mainToggle(page)).toHaveText('');
  await expect(mainChart(page)).toBeHidden();

  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toBeVisible();
  await expect(mainTable(page)).toBeHidden();
  await expect(chart).toHaveAttribute('data-x-kind', 'time');
  await expect(chart.locator('.queryChart__types [data-type="line"]')).toHaveAttribute('aria-pressed', 'true');
  // The chart types are icons too (the Tabler sprite through ns.icon), named
  // by aria-label, described by their title.
  const types = chart.locator('.queryChart__types');
  await expect(types).toHaveAttribute('role', 'group');
  await expect(types).toHaveAttribute('aria-label', 'Chart type');
  await expect(types).toHaveText('');
  const typeIcons = { Line: ['line', 'chart-line', 'One line per series'], Area: ['area', 'chart-area-line', 'Stacked areas: the series add up'],
    Bars: ['bar', 'chart-bar', 'Bars: split values stack, Y columns stand side by side'] };
  for (const [name, [type, icon, title]] of Object.entries(typeIcons)) {
    const option = types.getByRole('button', { name, exact: true });
    await expect(option).toHaveAttribute('data-type', type);
    await expect(option).toHaveAttribute('title', title);
    await expect(option).toHaveClass(/segmented__option--icon/);
    await expect(option.locator('svg.icon use')).toHaveAttribute('href', new RegExp(`#i-${icon}$`));
    await expect(option.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  }
  // Number needs a single-row result: disabled, its title says why.
  const number = types.getByRole('button', { name: 'Number', exact: true });
  await expect(number.locator('svg.icon use')).toHaveAttribute('href', /#i-number-123$/);
  await expect(number).toBeDisabled();
  await expect(number).toHaveAttribute('title', 'Number needs a single-row result');
  // Keyboard: Tab reaches an option, Enter picks it.
  await types.getByRole('button', { name: 'Area', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(core(chart)).toHaveAttribute('data-type', 'area');
  await types.getByRole('button', { name: 'Line', exact: true }).click();
  await expect(core(chart)).toHaveAttribute('data-type', 'line');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 v, w');
  expect(await seriesStats(chart)).toEqual({ v: { points: 120, runs: 1 }, w: { points: 120, runs: 1 } });
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(2);
  await expect(chart.locator('.queryChart__note')).toContainText('120 rows');

  // Rows are sorted by t ascending: index i is number = 119 - i.
  for (const fraction of [0.013, 0.37, 0.5, 0.81, 0.999]) {
    const { index, pointerX, crossX, box } = await hoverPlot(page, chart, fraction);
    const spacing = box.width / 119;
    expect(Math.abs(crossX - pointerX)).toBeLessThanOrEqual(spacing / 2 + 1);
    const number = 119 - index;
    expect(await tooltipValues(chart)).toEqual({ v: String(number % 7), w: String(number % 3) });
    await expect(chart.locator('.chartCore__tooltip strong')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00\.000$/);
  }
  await page.mouse.move(2, 2);
  await expect(chart.locator('.chartCore__tooltip')).toBeHidden();

  // Chart types.
  await chart.locator('.queryChart__types [data-type="area"]').click();
  await expect(core(chart)).toHaveAttribute('data-type', 'area');
  await expect(core(chart)).toHaveAttribute('data-series-drawn', '2');
  await hoverPlot(page, chart, 0.5);
  expect(Object.keys(await tooltipValues(chart))).toEqual(['v', 'w', 'Total']);
  await chart.locator('.queryChart__types [data-type="bar"]').click();
  await expect(core(chart)).toHaveAttribute('data-type', 'bar');
  expect(Object.keys(await seriesStats(chart))).toEqual(['v', 'w']);
  await expect(chart.locator('.queryChart__types [data-type="number"]')).toBeDisabled();

  // Series picker: w only.
  await chart.locator('.queryChart__seriesButton').click();
  await chart.locator('.queryChart__seriesMenu input[value="1"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 w');
  expect(Object.keys(await seriesStats(chart))).toEqual(['w']);
  // One series: no legend (the engine shows one from two series up).
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(0);

  // Back to the table: the rows are still rendered.
  await mainToggle(page).locator('[data-view="table"]').click();
  await expect(mainTable(page)).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(page.locator(`#resultTableBody ${dataRows}`)).toHaveCount(120);
});

test('split-by column draws one series per value and folds the rest into Other', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, GROUPED);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart.locator('.queryChart__group')).toHaveValue('2');
  // Long-form rows: each group has a row every third minute and its line
  // connects across the other groups' minutes.
  expect(await seriesStats(chart)).toEqual({ a: { points: 40, runs: 1 }, b: { points: 40, runs: 1 }, c: { points: 40, runs: 1 } });
  await expect(chart.locator('.chartCore__legendItem')).toHaveText(['a', 'b', 'c']);
  const { index } = await hoverPlot(page, chart, 0.5);
  const number = 119 - index;
  expect(await tooltipValues(chart)).toEqual({ [['a', 'b', 'c'][number % 3]]: String(number % 7) });

  // More groups than colour slots: the top 8 by value, the rest in Other.
  await runSuccessfulQuery(page, 'SELECT toStartOfMinute(now() - intDiv(number, 12) * 60) AS t, toString(number % 12) AS g, number % 12 + 1 AS v FROM numbers(240)');
  await expect(chart).toBeVisible();
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(9);
  const labels = await chart.locator('.chartCore__legendItem').allTextContents();
  expect(labels).toHaveLength(9);
  expect(labels[8]).toBe('Other');
  expect(labels.slice(0, 8).sort()).toEqual(['10', '11', '4', '5', '6', '7', '8', '9']);
  await expect(chart.locator('.queryChart__note')).toContainText('4 groups folded into Other');
  await pickChart(chart, '.queryChart__group', '-1');
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(0);
  await expect(chart.locator('.queryChart__note')).toContainText('summed');
});

test('string x draws bars, a single value shows a number, text-only results cannot be charted', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, BARS);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toHaveAttribute('data-x-kind', 'category');
  await expect(chart.locator('.queryChart__types [data-type="bar"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await seriesStats(chart)).toEqual({ c: { points: 3, runs: 1 } });
  await hoverPlot(page, chart, 0.5);
  await expect(chart.locator('.chartCore__tooltip strong')).toHaveText('beta');
  expect(await tooltipValues(chart)).toEqual({ c: '10' });
  await expect(chart.locator('.queryChart__rangeText')).toContainText('k 3 of 3 values');

  // The chosen view is the default for the next result.
  await runSuccessfulQuery(page, 'SELECT 1234567 AS answer');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('data-chart-type', 'number');
  await expect(chart.locator('.queryChart__numberValue')).toHaveText('1,234,567');
  await expect(chart.locator('.queryChart__numberLabel')).toHaveText('answer');
  await expect(core(chart)).toBeHidden();

  await runSuccessfulQuery(page, "SELECT 'a' AS x, 'b' AS y FROM numbers(3)");
  const chartBtn = mainToggle(page).locator('[data-view="chart"]');
  await expect(chartBtn).toBeDisabled();
  await expect(chartBtn).toHaveAttribute('title', /no numeric column/i);
  await expect(mainToggle(page)).toHaveAttribute('title', /no numeric column/i);
  await expect(mainTable(page)).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(page.locator(`#resultTableBody ${dataRows}`)).toHaveCount(3);

  // Still the default: the next numeric result opens as a chart again.
  await runSuccessfulQuery(page, BARS);
  await expect(chart).toBeVisible();
  await expect(core(chart)).toBeVisible();

  // A single row with several columns: Number tiles in the chart, the
  // vertical table in the table view.
  await runSuccessfulQuery(page, "SELECT 1 AS a, 2.5 AS b, 'x' AS s");
  await expect(chart.locator('.queryChart__number')).toHaveCount(2);
  await mainToggle(page).locator('[data-view="table"]').click();
  await expect(page.locator('#resultsPanel > .tableWrap table')).toHaveClass(/resultTable--vertical/);
});

test('view choice persists across results and reloads; clear resets the panel', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await showChart(mainToggle(page));
  await expect(mainChart(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('chdash.results.view'))).toBe('chart');
  await page.reload();
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(mainChart(page)).toBeVisible();
  await expect(core(mainChart(page))).toHaveAttribute('data-series-drawn', '2');
  await expect(mainToggle(page).locator('[data-view="chart"]')).toHaveAttribute('aria-pressed', 'true');

  // Copy JSON still copies the rows from the chart view.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
    }, true);
  });
  await page.locator('#copyJsonButton').click();
  await expect.poll(() => page.evaluate(async () => {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try { return await navigator.clipboard.readText(); } catch (_) { /* fall back */ }
    }
    return window.__chdashTestCopiedText || '';
  }).then((text) => { try { return JSON.parse(text).length; } catch (_) { return -1; } })).toBe(120);

  await page.locator('#clearResultsButton').click();
  await expect(page.locator('#resultsPanel')).toBeHidden();
  await expect(mainToggle(page)).toBeHidden();
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(mainChart(page)).toBeVisible();
  await mainToggle(page).locator('[data-view="table"]').click();
  expect(await page.evaluate(() => localStorage.getItem('chdash.results.view'))).toBe('table');
  // A hidden chart gives its canvas memory back.
  expect(await mainChart(page).locator('canvas').evaluateAll((els) => els.map((c) => c.width * c.height))).toEqual([0]);
});

test('multiquery panels chart independently, share the time crosshair and redraw on re-expand', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'table'));
  await enableMultiquery(page);
  await runQuery(page, `${TIME_SERIES}; SELECT 'only' AS label, 'text' AS other; ${BARS}; SELECT number AS id, number * 2 AS twice FROM numbers(3000); ${GROUPED};`);
  await waitForTerminal(page);
  await waitForBatch(page, 5);
  const blocks = page.locator('.resultsStack__block');
  await expect(blocks).toHaveCount(5);
  await expect(mainToggle(page)).toBeHidden();
  const panel = (i) => blocks.nth(i);
  const expand = async (i) => {
    if (await panel(i).locator('.resultsStack__body').isHidden()) await panel(i).locator('.resultsStack__toggle').click();
  };
  for (let i = 0; i < 5; i++) await expand(i);
  for (let i = 0; i < 5; i++) await expect(panel(i).locator('.resultsViewToggle [data-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(1).locator('.resultsViewToggle [data-view="chart"]')).toBeDisabled();

  await showChart(panel(0));
  await expect(panel(0).locator('.queryChart')).toBeVisible();
  await expect(core(panel(0))).toHaveAttribute('data-series-drawn', '2');
  await expect(panel(0).locator('.resultsStack__body > .tableWrap')).toBeHidden();
  await expect(panel(2).locator('.queryChart')).toBeHidden();
  await expect(panel(2).locator('.resultsStack__body > .tableWrap')).toBeVisible();

  await showChart(panel(2));
  expect(await seriesStats(panel(2))).toEqual({ c: { points: 3, runs: 1 } });
  await panel(0).locator('.resultsViewToggle [data-view="table"]').click();
  await expect(panel(0).locator('.resultsStack__body > .tableWrap')).toBeVisible();
  await expect(panel(0).locator(`tbody ${dataRows}`)).toHaveCount(120);
  await expect(panel(2).locator('.queryChart')).toBeVisible();

  // The virtualised panel charts all 3000 rows and still renders its table.
  await showChart(panel(3));
  await expect(panel(3).locator('.queryChart')).toHaveAttribute('data-x-kind', 'number');
  await expect(panel(3).locator('.queryChart__note')).toContainText('3,000 rows');
  await panel(3).locator('.resultsViewToggle [data-view="table"]').click();
  await expect(panel(3).locator('tbody tr.resultTable__spacerRow').first()).toBeAttached();
  const mounted = await panel(3).locator(`tbody ${dataRows}`).count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(3000);

  // Two time panels: hovering one draws the crosshair at the same instant
  // in the other (Grafana's shared crosshair).
  await showChart(panel(0));
  await showChart(panel(4));
  await panel(4).scrollIntoViewIfNeeded();
  const h = await hoverPlot(page, panel(4), 0.5);
  const syncX = Number(await core(panel(0)).getAttribute('data-sync-x'));
  expect(syncX).toBeGreaterThan(0);
  expect(Number.isFinite(syncX)).toBeTruthy();
  expect(h.readout).toMatch(/^\d{4}-/);
  await page.mouse.move(2, 2);
  await expect(core(panel(0))).not.toHaveAttribute('data-sync-x', /./);

  // Collapsing and re-expanding a charted panel redraws it at full width.
  await panel(2).locator('.resultsStack__toggle').click();
  await expect(panel(2).locator('.resultsStack__body')).toBeHidden();
  await panel(2).locator('.resultsStack__toggle').click();
  await expect(panel(2).locator('.chartCore canvas').first()).toBeVisible();
  await expect.poll(() => panel(2).locator('.chartCore__plot').evaluate((plot) => Math.abs(plot.clientWidth - plot.querySelector('canvas').getBoundingClientRect().width))).toBeLessThanOrEqual(1);

  // Global copy and the ZIP / JSON download stay available.
  await expect(page.locator('#copyJsonButton')).toBeEnabled();
  await page.locator('#copyMenuButton').click();
  await expect(page.locator('#downloadReceivedJsonButton')).toBeVisible();
  await expect(page.locator('#downloadReceivedJsonButton')).toBeEnabled();
});

test('a large streamed result shows a streaming placeholder, then charts once, downsampled, and stays responsive', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  await page.evaluate(() => {
    window.__qchartFrames = { max: 0, last: performance.now(), counts: [], canvasWhileStreaming: false };
    const tick = (now) => {
      const f = window.__qchartFrames;
      f.max = Math.max(f.max, now - f.last);
      f.last = now;
      const host = document.querySelector('#resultsPanel > .queryChart');
      const message = host?.querySelector('.queryChart__message');
      const streaming = !!message && !message.hidden && /^Streaming/.test(message.textContent);
      if (streaming) {
        const count = Number(message.textContent.replace(/[^\d]/g, ''));
        if (f.counts[f.counts.length - 1] !== count) f.counts.push(count);
        if (host.querySelector('.chartCore:not([hidden]) canvas')) f.canvasWhileStreaming = true;
      }
      if (!f.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // About two seconds of streaming: 40 blocks of 5000 rows.
  await runQuery(page, 'SELECT number AS n, number % 1000 AS v, intDiv(number, 7) % 500 AS u FROM numbers(200000) WHERE sleepEachRow(0.00001) = 0 SETTINGS max_block_size = 5000');
  // While the rows stream in, the chart area counts them and draws nothing.
  const chart = mainChart(page);
  await expect(chart.locator('.queryChart__message')).toHaveText(/^Streaming\u2026 [\d,]+ rows?$/, { timeout: 20_000 });
  await expect(chart.locator('.queryChart__message')).toHaveClass(/is-busy/);
  await waitForTerminal(page);
  await expect(chart.locator('.chartCore canvas').first()).toBeVisible({ timeout: 15_000 });
  await expect(chart.locator('.queryChart__message')).toBeHidden();
  await expect(chart.locator('.queryChart__note')).toContainText('200,000 rows', { timeout: 15_000 });
  await expect(chart.locator('.queryChart__note')).toContainText('min/max envelope');
  const frames = await page.evaluate(() => { window.__qchartFrames.stop = true; return window.__qchartFrames; });
  console.log(`large stream: max frame gap ${Math.round(frames.max)} ms, placeholder counts ${JSON.stringify(frames.counts)}`);
  expect(frames.canvasWhileStreaming).toBe(false);
  expect(frames.counts.length).toBeGreaterThan(2);
  expect(frames.counts.every((count, i) => i === 0 || count > frames.counts[i - 1])).toBe(true);
  expect(frames.max).toBeLessThan(1500);
  const plotW = (await plotBox(chart)).width;
  for (const s of Object.values(await seriesStats(chart))) expect(s.points).toBeLessThanOrEqual(Math.ceil(plotW) * 4 + 4);
  // The tooltip reads the full-resolution rows.
  const h = await hoverPlot(page, chart, 0.4321);
  const n = Number(h.header.replace(/,/g, ''));
  expect(Number.isInteger(n)).toBeTruthy();
  expect(h.readout).toBe(h.header);
  const values = await tooltipValues(chart);
  expect(values.v).toBe((n % 1000).toLocaleString('en-US'));
  expect(values.u).toBe((Math.floor(n / 7) % 500).toLocaleString('en-US'));
  // The editor still takes input.
  await page.locator('#queryTextArea').fill('SELECT 1');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 1');
});

test('time axes keep their labels and date lines apart at 1 h, 24 h, 7 d and 30 d, on 1440 and 390 px pages', async ({ page }) => {
  await openApp(page);
  // Every range starts at 22:30 (UTC, the browser's zone here), the first
  // label just before a midnight: "Oct 2 2026" under 23:00 and "Oct 3 2026"
  // under 00:00 ran into each other. Now 00:00 reads "Oct 3" (the year is
  // the first date's), or the first date gives way to it ("Oct 3 2026").
  const start = Date.UTC(2026, 9, 2, 22, 30) / 1000;
  const RANGES = [['1h', 60, 60], ['24h', 300, 288], ['7d', 3600, 168], ['30d', 3600, 720]];
  const chart = mainChart(page);
  const root = core(chart);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, step, count] of RANGES) {
      await runSuccessfulQuery(page, `SELECT toDateTime(${start} + number * ${step}, 'UTC') AS t, number % 7 AS v FROM numbers(${count + 1})`);
      if (!(await chart.isVisible())) await showChart(mainToggle(page));
      await expect(chart).toHaveAttribute('data-x-kind', 'time');
      // This result drawn (390 px decimates the 30 d points).
      await expect(root).toHaveAttribute('data-x-max', String((start + step * count) * 1000));
      // [label, date line, left, right, date left, date right] of each label drawn.
      const ticks = await chartJson(root, 'data-x-ticks');
      expect(ticks.length, `${name} at ${width}`).toBeGreaterThanOrEqual(3);
      expect(xLabelCollisions(ticks), `${name} at ${width}: ${JSON.stringify(ticks)}`).toEqual([]);
      expect(xRepeatedYears(ticks), `${name} at ${width}`).toEqual([]);
      const dated = ticks.filter((t) => t[1]);
      expect(dated[0][1], `${name} at ${width}`).toMatch(/\b2026$/);
      // Inside the canvas.
      const canvasWidth = await root.locator('canvas').first().evaluate((el) => el.getBoundingClientRect().width);
      for (const t of ticks) expect(Math.min(t[2], t[4] ?? t[2]) >= 0 && Math.max(t[3], t[5] ?? 0) <= canvasWidth, `${name} at ${width}: ${t}`).toBe(true);
      if (name === '24h') expect(ticks.find((t) => t[0] === '00:00')[1], JSON.stringify(ticks)).toMatch(/^Oct 3( 2026)?$/);
      if (name === '7d') expect(dated.slice(1).every((t) => /^[A-Z][a-z]{2} \d{1,2}$/.test(t[1])), JSON.stringify(dated)).toBe(true);
    }
  }
  // A redraw of the same axis measures no text: the widths are cached.
  const measured = await page.evaluate(async () => {
    const api = window.ChDash.chartCore.of(document.querySelector('#resultsPanel > .queryChart'));
    const before = window.ChDash.chartCore.counters();
    api.setData({});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = window.ChDash.chartCore.counters();
    return { draws: after.draws - before.draws, textMeasures: after.textMeasures - before.textMeasures };
  });
  expect(measured.draws).toBeGreaterThanOrEqual(1);
  expect(measured.textMeasures).toBe(0);
});

test('NULL values break lines; nullable and decimal columns chart', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS x, if(number IN (4, 5), NULL, toDecimal64(number / 4, 2)) AS d, toNullable(toFloat64(number)) AS f FROM numbers(10)');
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toHaveAttribute('data-x-kind', 'number');
  expect(await seriesStats(chart)).toEqual({ d: { points: 8, runs: 2 }, f: { points: 10, runs: 1 } });
  await hoverPlot(page, chart, 4.4 / 9);
  expect(await tooltipValues(chart)).toEqual({ d: 'NULL', f: '4' });
});

test('chart follows the theme, resizes and never overflows the page', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, GROUPED);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const swatch = () => chart.locator('.chartCore__legendItem i').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  const draws = async () => Number(await core(chart).getAttribute('data-draws'));
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await expect.poll(swatch).toBe('rgb(66, 150, 251)');
  const before = await draws();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await expect.poll(swatch).toBe('rgb(26, 115, 213)');
  // The canvas redraws with the new tokens.
  await expect.poll(draws).toBeGreaterThan(before);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => localStorage.setItem('chdash.theme', mode), theme);
    for (const width of [1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.reload();
      await openApp(page);
      await runSuccessfulQuery(page, GROUPED);
      await expect(chart.locator('canvas').first()).toBeVisible();
      const sizes = await chart.evaluate((host) => ({
        plot: host.querySelector('.chartCore__plot').clientWidth,
        canvas: host.querySelector('canvas').getBoundingClientRect().width,
        backing: host.querySelector('canvas').width,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        host: host.scrollWidth - host.clientWidth,
      }));
      expect(Math.abs(sizes.plot - sizes.canvas)).toBeLessThanOrEqual(1);
      expect(sizes.backing).toBe(Math.round(sizes.canvas));
      expect(sizes.overflow).toBeLessThanOrEqual(1);
      expect(sizes.host).toBeLessThanOrEqual(1);
      await hoverPlot(page, chart, 0.62);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/grouped-${theme}-${width}.png` });
      await chart.locator('.queryChart__types [data-type="area"]').click();
      await pickChart(chart, '.queryChart__group', '-1');
      await page.mouse.move(2, 2);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/area-${theme}-${width}.png` });
      await runSuccessfulQuery(page, BARS);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/bars-${theme}-${width}.png` });
      await runSuccessfulQuery(page, EXAMPLE);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/example-${theme}-${width}.png` });
    }
  }
  // Resizing the window redraws at the new width; a narrow (mobile) window
  // keeps the chart inside the panel.
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => chart.evaluate((host) => Math.abs(host.querySelector('.chartCore__plot').clientWidth - host.querySelector('canvas').getBoundingClientRect().width))).toBeLessThanOrEqual(1);
    expect(await chart.evaluate((host) => host.scrollWidth - host.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/example-mobile-390.png` });
  // High-density screens: the backing store follows devicePixelRatio, with no
  // resize to trigger the redraw (the chart's `resolution` media query does).
  // Chromium's emulation re-evaluates media queries only when the viewport
  // metrics change: an override that changes the scale factor alone sets
  // devicePixelRatio without any change event or resize, which no real display
  // change does. So the override also grows the viewport by 1 px in height,
  // which leaves the plot width (and the resize observer) alone.
  await page.setViewportSize({ width: 1280, height: 900 });
  const backing = () => chart.evaluate((host) => {
    const c = host.querySelector('canvas');
    const css = c.getBoundingClientRect().width;
    const plot = host.querySelector('.chartCore__plot').clientWidth;
    return { ratio: c.width / css, plot, fits: Math.abs(plot - css) <= 1, viewport: innerWidth, draws: Number(host.querySelector('.chartCore').dataset.draws) };
  });
  // The 1280 px redraw has landed before the scale factor changes.
  await expect.poll(async () => { const b = await backing(); return b.viewport === 1280 && b.fits && b.ratio === 1; }).toBe(true);
  const at1x = await backing();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 901, deviceScaleFactor: 2, mobile: false });
  await expect.poll(async () => (await backing()).ratio).toBeCloseTo(2, 1);
  const at2x = await backing();
  expect(at2x.plot).toBe(at1x.plot);
  expect(at2x.draws).toBeGreaterThan(at1x.draws);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});

test('a streamed result is drawn once, at the end: each value parsed once, one legend', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  await page.evaluate(() => window.ChDash.queryChart.loadCore());
  const chart = mainChart(page);
  // Nothing is parsed or drawn while the rows stream in.
  await page.evaluate(() => {
    const ns = window.ChDash;
    window.__beforeDone = null;
    const host = document.querySelector('#resultsPanel > .queryChart');
    const watch = () => {
      // The last frame that showed the placeholder with rows received.
      if (/^Streaming\u2026 [1-9]/.test(host.querySelector('.queryChart__message:not([hidden])')?.textContent || '')) {
        window.__beforeDone = { q: ns.queryChart.counters(), core: ns.chartCore.counters() };
      }
      if (!window.__stopWatch) requestAnimationFrame(watch);
    };
    window.__stopWatch = false;
    requestAnimationFrame(watch);
  });
  const work = await countWork(page, async () => {
    await runQuery(page, STREAMED);
    await waitForTerminal(page);
    await expect(chart).toHaveAttribute('data-rows-charted', '200000', { timeout: 20_000 });
    await expect(chart.locator('.queryChart__note')).toContainText('200,000 rows');
  });
  const before = await page.evaluate(() => { window.__stopWatch = true; return window.__beforeDone; });
  console.log(`streamed 200k: ${JSON.stringify(work)} before done: ${JSON.stringify(before)}`);
  expect(before, 'a frame saw the stream running').not.toBeNull();
  expect(before.q.rowsParsed).toBe(0);
  expect(before.q.modelBuilds).toBe(0);
  expect(before.core.draws).toBe(0);
  expect(before.q.plots).toBe(0);
  // One chart, handed its data once.
  expect(work.q.plots).toBe(1);
  expect(work.maxDrawsPerFrame).toBeLessThanOrEqual(1);
  expect(work.core.draws).toBeGreaterThan(0);
  expect(work.core.draws).toBeLessThanOrEqual(3);
  // Columns appended once each: x and the three series of 200,000 rows,
  // and the column types read once per result.
  expect(work.q.rowsParsed).toBe(4 * 200000);
  expect(work.q.typeDetections).toBe(5);
  // The series never changed: one legend, one toolbar.
  expect(work.core.legendBuilds).toBe(1);
  expect(work.q.toolbarBuilds).toBeLessThanOrEqual(1);
  // Decimation read block summaries, not every point at every draw.
  expect(work.core.tracedPoints).toBeLessThan(work.core.draws * 3 * 200000);
  expect(work.core.summarised).toBeLessThanOrEqual(3 * 200000 + 3 * 64 * work.core.setData);
});

test('a canceled or failed query charts the rows it received', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  const chart = mainChart(page);
  // Canceled mid-stream: the placeholder until then, the received rows after.
  await runQuery(page, 'SELECT number AS n, number % 13 AS v FROM numbers(100000) WHERE sleepEachRow(0.0005) = 0 SETTINGS max_block_size = 200');
  await expect(chart.locator('.queryChart__message')).toHaveText(/^Streaming… [1-9][\d,]* rows$/, { timeout: 20_000 });
  await expect(core(chart)).toHaveCount(0);
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/cancel/i);
  await expect(chart.locator('.chartCore canvas').first()).toBeVisible({ timeout: 15_000 });
  const received = await page.locator(`#resultTableBody ${dataRows}`).evaluateAll((trs) => Math.max(0, ...trs.map((tr) => Number(tr.cells[0].textContent) || 0)));
  const charted = Number(await chart.getAttribute('data-rows-charted'));
  expect(charted).toBeGreaterThan(0);
  expect(charted).toBeLessThan(100000);
  expect(charted).toBeGreaterThanOrEqual(received);
  await expect(chart.locator('.queryChart__note')).toContainText(`${charted.toLocaleString('en-US')} rows`);

  // Failed after some rows (a division by zero at row 3000): those rows.
  await runQuery(page, 'SELECT number AS n, intDiv(10, 3000 - number) AS v FROM numbers(10000) SETTINGS max_block_size = 500');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
  // The chart, or (ClickHouse failed the first block) the empty message:
  // never the placeholder once the stream has ended.
  await expect.poll(() => chart.evaluate((host) => host.dataset.rowsCharted
    || (host.dataset.stage === 'message' && !/^Streaming/.test(host.querySelector('.queryChart__message').textContent) ? 'message' : ''))).not.toBe('');
  const failedRows = Number(await chart.getAttribute('data-rows-charted')) || 0;
  if (failedRows > 0) {
    await expect(chart.locator('.chartCore canvas').first()).toBeVisible();
    expect(failedRows).toBeLessThan(10000);
    await expect(chart.locator('.queryChart__note')).toContainText(`${failedRows.toLocaleString('en-US')} rows`);
  } else {
    await expect(chart.locator('.queryChart__message')).toHaveText('No rows to chart.');
  }
});

test('a hidden chart does no work: Table view, collapsed panel, background tab; it charts when shown', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.evaluate(() => window.ChDash.queryChart.loadCore());
  const chart = mainChart(page);
  const idle = (work) => {
    expect(work.q.renders).toBe(0);
    expect(work.q.modelBuilds).toBe(0);
    expect(work.q.rowsParsed).toBe(0);
    expect(work.core.draws).toBe(0);
    expect(work.core.layoutReads).toBe(0);
  };

  // Table view while streaming: nothing parsed or drawn; the Chart view builds it.
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'table'));
  idle(await countWork(page, () => runSuccessfulQuery(page, STREAMED)));
  const shown = await countWork(page, async () => {
    await showChart(mainToggle(page));
    await expect(chart).toHaveAttribute('data-rows-charted', '200000');
  });
  expect(shown.q.rowsParsed).toBe(4 * 200000);
  expect(shown.maxDrawsPerFrame).toBeLessThanOrEqual(1);

  // A background tab: the chart waits, then charts every row in a few frames.
  await setPageHidden(page, true);
  idle(await countWork(page, () => runSuccessfulQuery(page, STREAMED)));
  const back = await countWork(page, async () => {
    await setPageHidden(page, false);
    await expect(chart).toHaveAttribute('data-rows-charted', '200000');
  });
  expect(back.core.draws).toBeGreaterThan(0);
  expect(back.maxDrawsPerFrame).toBeLessThanOrEqual(1);

  // A multiquery panel collapsed while its rows stream in (its chart only
  // counts them meanwhile): nothing until it is expanded again.
  await enableMultiquery(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  await runQuery(page, `SELECT 1 AS one, 2 AS two; ${SLOW_STREAM};`);
  const panel = page.locator('.resultsStack__block').nth(1);
  await expect(panel.locator('.queryChart__message')).toHaveText(/^Streaming\u2026 [1-9][\d,]* rows?$/, { timeout: 15_000 });
  await expect(panel.locator('.queryChart')).not.toHaveAttribute('data-rows-charted', /./);
  await panel.locator('.resultsStack__toggle').click();
  await expect(panel.locator('.resultsStack__body')).toBeHidden();
  idle(await countWork(page, async () => {
    await waitForTerminal(page);
    await frames(page, 10);
  }));
  await panel.locator('.resultsStack__toggle').click();
  await expect(panel.locator('.queryChart')).toHaveAttribute('data-rows-charted', '4000');
  await expect(core(panel)).toHaveAttribute('data-series-drawn', '1');
});

test('performance budget: 1,000,000 streamed rows of 5 numeric columns are drawn once, within budget, without long tasks', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await page.evaluate(() => window.ChDash.queryChart.loadCore());
  // The server caps a result at 200,000 rows: the rows are fed to a result
  // chart in the page, 100 chunks of 10,000 rows in separate tasks, as the
  // stream delivers them.
  const result = await page.evaluate(async () => {
    const ns = window.ChDash;
    const rows = [];
    const host = document.createElement('div');
    host.style.width = '1200px';
    document.body.prepend(host);
    const ctl = ns.queryChart.createController({ getData: () => ({ rows }) });
    host.append(ctl.toggleEl, ctl.hostEl);
    ctl.hostEl.style.display = 'block';
    ctl.setMeta(['n', 'r', 'r64', 'f', 'g'], ['UInt64', 'UInt32', 'Float64', 'Float64', 'Int64']);
    ctl.setView('chart');
    const longTasks = [];
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
    observer.observe({ type: 'longtask' });
    ns.chartCore.resetCounters();
    ns.queryChart.resetCounters();
    let maxDraws = 0, last = 0, stop = false;
    const tick = () => {
      const d = ns.chartCore.counters().draws;
      maxDraws = Math.max(maxDraws, d - last);
      last = d;
      if (!stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const t0 = performance.now();
    for (let c = 0; c < 100; c++) {
      for (let i = 0; i < 10000; i++) {
        const n = c * 10000 + i;
        rows.push([String(n), rand() % 1000, (rand() % 1000000) + 0.5, n * 1.5, String((rand() % 2000) - 1000)]);
      }
      ctl.rowsChanged();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const lastChunk = performance.now();
    // Streaming parsed and drew nothing.
    const streamed = { q: ns.queryChart.counters(), draws: ns.chartCore.counters().draws };
    ctl.done();
    await new Promise((resolve) => {
      const check = () => (Number(ctl.hostEl.dataset.rowsCharted) === rows.length ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    // The frame after the final draw has been presented.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const finalPaint = performance.now();
    stop = true;
    observer.disconnect();
    const out = { streamMs: lastChunk - t0, finalPaintMs: finalPaint - lastChunk, longTasks, maxDraws, streamed, plots: ns.queryChart.counters().plots, counters: ns.chartCore.counters(), note: ctl.hostEl.querySelector('.queryChart__note').textContent };
    ctl.destroy();
    host.remove();
    return out;
  });
  console.log(`1M rows: ${JSON.stringify(result)}`);
  expect(result.note).toContain('1,000,000 rows');
  expect(result.streamed.draws).toBe(0);
  expect(result.streamed.q.rowsParsed).toBe(0);
  // Parsed over a few frames after the end, then drawn once.
  expect(result.plots).toBe(1);
  expect(result.maxDraws).toBeLessThanOrEqual(1);
  expect(result.finalPaintMs).toBeLessThan(1500);
  expect(Math.max(0, ...result.longTasks)).toBeLessThan(200);
});
