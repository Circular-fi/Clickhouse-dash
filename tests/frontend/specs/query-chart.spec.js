import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal, waitForBatch } from '../helpers/app.js';
import { chartJson, xLabelCollisions, xRepeatedYears } from '../helpers/charts.js';
import { captureCopies } from '../helpers/clipboard.js';

// Query result Table / Chart view: the browser draws the chart from the rows that a result panel received.
// Each panel has its own chart: the main panel and every multiquery panel. The shared engine
// (app_chart_core.js) draws the chart on canvas. The test does not read canvas pixels. The engine publishes
// what it draws on its root: data-series-stats, data-points-drawn, data-x-min / data-x-max, data-zoomed,
// data-cursor-x...

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
// The chart picker (ns.menu.select over the hidden native select) has two parts: the button, then the option.
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

// The plot area (inside the axes) uses page coordinates.
async function plotBox(chart) {
  await expect(core(chart)).toHaveAttribute('data-plot', /\d/);
  const [left, top, width, height] = (await core(chart).getAttribute('data-plot')).split(' ').map(Number);
  // The mouse reaches only the part that the viewport shows (1280 x 800 included).
  await chart.locator('.chartCore__overlay').evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'center' });
  });
  const box = await chart.locator('.chartCore__overlay').boundingBox();
  return { x: box.x + left, y: box.y + top, width, height, left };
}

// Hover the plot at a fraction of its width. The function returns the snapped index, the exact x readout and
// the crosshair / pointer positions (plot css px).
async function hoverPlot(page, chart, fraction, yFraction = 0.5) {
  const box = await plotBox(chart);
  const x = box.x + box.width * fraction;
  const overlay = await chart.locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(x, box.y + box.height * yFraction);
  const tooltip = chart.locator('.chartCore__tooltip');
  await expect(tooltip).toBeVisible();
  // The cursor follows the pointer on the next frame. Until the chart reports this pointer position, the
  // tooltip and the readouts show the previous hover.
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

// Click Chart. Measure the time until the frame after the chart draws every row. A large result takes several
// frames to parse.
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

// The test counts every chart draw per animation frame while `run` streams a result. The counters are the
// work of the engine and of the Query chart, and the most draws that one frame saw.
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

// The page is in a background tab, with document.hidden and visibilitychange. A headless page never hides by
// itself.
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

// Let `count` animation frames render.
const frames = (page, count = 2) => page.evaluate((n) => new Promise((resolve) => {
  const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
  step(n);
}), count);

// The rows cover about two seconds, in blocks of 100.
const SLOW_STREAM = 'SELECT number AS n, number * 2 AS d FROM numbers(4000) WHERE sleepEachRow(0.0005) = 0 SETTINGS max_block_size = 100';

// The rows of the example query stream in about 100 chunks.
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
  // The controls need no extra text: each picker has a label and an explicit Auto choice.
  await expect(chart.locator('.queryChart__data .tracePicker__button')).toHaveText([/^X axis \u00b7 /, /^Y values \u00b7 /, /^Split by \u00b7 /]);
  // The three pickers have the same look (ns.menu pickers).
  const looks = await chart.locator('.queryChart__data .tracePicker__button').evaluateAll((els) => els.map((el) => {
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
    // The chart has 10,000 points over ~1,300 px: at most 4 vertices per device pixel column.
    expect(s.points).toBeLessThanOrEqual(Math.ceil(plotW) * 4 + 4);
    expect(s.points).toBeGreaterThan(plotW);
  }
  // The range now() + 10,000 s can cross midnight, so the end then repeats its date. The shared range label
  // (ns.format.range) shows the date once, unless the date changes.
  await expect(chart.locator('.queryChart__rangeText')).toContainText(/plus\(now\(\), number\) [A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d{2}:\d{2}:\d{2}\.000 → ([A-Z][a-z]{2} \d{1,2}(?:, \d{4})? )?\d{2}:\d{2}:\d{2}\.000/);

  // The crosshair readout shows the exact instant of the snapped row, with ms.
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
  // The keyboard moves point by point.
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

  // The 200,000 rows use the same budget order, with a min/max envelope per pixel.
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
  // With few points, the chart draws dots. The x range is in the header.
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
  // The tooltip still reads full-resolution rows inside the zoomed range. The middle of the plot is the row
  // at the middle of the range that the drag chooses. The drag lands within a pixel of 20 % / 40 %. One pixel
  // is ~8 rows of the full axis, so the nominal 30 % row is not a 5-row target.
  const inside = await hoverPlot(page, chart, 0.5);
  expect(Math.abs(inside.index - Math.round((((zMin + zMax) / 2) - fullMin) / span * 9999))).toBeLessThanOrEqual(5);
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/zoomed.png` });

  // Zoom again to narrow the range. Double-click resets the zoom.
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

test('legend isolates on click, toggles on Ctrl+click, and lists total / min / max / mean / last', async ({ page }) => {
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
  // A click on the isolated series shows every series again.
  await items.nth(0).click();
  await expect(root).toHaveAttribute('data-series-drawn', '3');
  // Ctrl+click hides / shows one series.
  await items.nth(2).click({ modifiers: ['Control'] });
  await expect(root).toHaveAttribute('data-series-drawn', '2');
  await expect(items.nth(2)).toHaveAttribute('aria-pressed', 'false');
  await items.nth(2).click({ modifiers: ['Control'] });
  await expect(root).toHaveAttribute('data-series-drawn', '3');

  // Values mode is a table of calculations over the visible range. The button shows which one: the total, the
  // min, the max, the mean and the last.
  await expect(chart.locator('.chartCore__legendMode')).toHaveAttribute('title', 'Show total / min / max / mean / last per series');
  await chart.locator('.chartCore__legendMode').click();
  const table = chart.locator('.chartCore__legendTable');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveText(['Series', 'Total', 'Min', 'Max', 'Mean', 'Last']);
  // The total is the sum of the series over the range. The numbers 0..9,999 add up to 49,995,000.
  // minus(number, 10) is 10 less for each of the 10,000 rows (49,895,000). plus(number, 2) is 2 more for each
  // (50,015,000).
  await expect(table.locator('tbody tr').first().locator('td')).toHaveText(['49,995,000', '0', '9,999', '4,999.5', '9,999']);
  await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText(['49,895,000', '-10', '9,989', '4,989.5', '9,989']);
  await expect(table.locator('tbody tr').nth(2).locator('td').first()).toHaveText('50,015,000');
  await expect(chart.locator('.chartCore__legendMode')).toHaveAttribute('title', 'Show the legend as a list');
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('table');
  // The legend items of the table still isolate.
  await table.locator('.chartCore__legendItem').nth(1).click();
  await expect(root).toHaveAttribute('data-series-drawn', '1');
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/legend-table.png` });
  await chart.locator('.chartCore__legendMode').click();
  await expect(table).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('list');
});

// The Values table of the legend shows the figures of the range that the plot shows (docs/ui-foundations.md,
// "The legend"). Its Total, Min, Max, Mean and Last follow a zoom and return with the reset. A NULL is not a
// value. The Total adds the values that exist, and the Mean is over them.
test('the legend table reads the range that the plot shows: a zoom changes its Total, Min, Max, Mean and Last, the reset brings them back, and a NULL is no value', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, EXAMPLE);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const root = core(chart);
  await chart.locator('.chartCore__legendMode').click();
  const first = chart.locator('.chartCore__legendTable tbody tr').first().locator('td');
  const figures = async () => (await first.allTextContents()).map((text) => Number(text.replace(/,/g, '')));
  await expect(first).toHaveText(['49,995,000', '0', '9,999', '4,999.5', '9,999']);
  // A drag from 40 % to 60 % of the plot gives a zoom on the rows between them: the numbers 4,000 to 5,999. A
  // pixel is about 8 rows, so the edges are within a few pixels of them.
  const box = await plotBox(chart);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 3 });
  await page.mouse.up();
  await expect(root).toHaveAttribute('data-zoomed', 'true');
  await expect.poll(async () => (await figures())[0], { message: 'the total follows the zoom' }).toBeLessThan(15_000_000);
  const [total, min, max, mean, last] = await figures();
  expect(Math.abs(total - 9_999_000), 'about 2,000 rows of about 5,000').toBeLessThan(200_000);
  expect(Math.abs(min - 4000)).toBeLessThanOrEqual(20);
  expect(Math.abs(max - 6000)).toBeLessThanOrEqual(20);
  expect(Math.abs(mean - (min + max) / 2)).toBeLessThanOrEqual(1);
  expect(last).toBe(max);
  // The rows of the other series follow it too: minus(number, 10) is 10 below the first one.
  const second = chart.locator('.chartCore__legendTable tbody tr').nth(1).locator('td');
  expect(Number((await second.nth(1).textContent()).replace(/,/g, ''))).toBe(min - 10);
  // The reset restores the whole range.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(root).toHaveAttribute('data-zoomed', 'false');
  await expect(first).toHaveText(['49,995,000', '0', '9,999', '4,999.5', '9,999']);

  // A NULL is not a value. The z series has one value on every second row (0, 2, ... 98) and a NULL on the
  // last row. Its Total adds the 50 values that exist. Its Mean is over them (49, not 24.5). The Last is the
  // last value that exists.
  await runSuccessfulQuery(page, 'SELECT number AS x, toFloat64(number) AS y, if(number % 2 = 1, NULL, toFloat64(number)) AS z FROM numbers(100)');
  const rows = chart.locator('.chartCore__legendTable tbody tr');
  await expect(rows.first().locator('th')).toHaveText('y');
  await expect(rows.first().locator('td')).toHaveText(['4,950', '0', '99', '49.5', '99']);
  await expect(rows.nth(1).locator('th')).toHaveText('z');
  await expect(rows.nth(1).locator('td')).toHaveText(['2,450', '0', '98', '49', '98']);
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

  // A text-like column as x has one category for each value. The chart draws the categories as bars.
  await pickChart(chart, '.queryChart__x', '2');
  await expect(chart).toHaveAttribute('data-x-kind', 'category');
  await expect(chart.locator('.queryChart__types [data-type="bar"]')).toHaveAttribute('aria-pressed', 'true');

  await pickChart(chart, '.queryChart__x', 'auto');
  await expect(chart).toHaveAttribute('data-x-kind', 'time');
  await expect(chart.locator('.queryChart__types [data-type="line"]')).toHaveAttribute('aria-pressed', 'true');
  // The chart keeps this choice for the next result with the same columns.
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
  // The icons have names for assistive technology and a tooltip.
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
  // The chart types are icons too (the Tabler sprite through ns.icon). Each one has an aria-label as its name
  // and a title as its description.
  const types = chart.locator('.queryChart__types');
  await expect(types).toHaveAttribute('role', 'group');
  await expect(types).toHaveAttribute('aria-label', 'Chart type');
  await expect(types).toHaveText('');
  const typeIcons = { Line: ['line', 'chart-line', 'One line per series'], Area: ['area', 'chart-area-line', 'Areas: stacked by default, the series add up'],
    Bars: ['bar', 'chart-bar', 'Bars: split values stack, Y columns stand side by side'] };
  for (const [name, [type, icon, title]] of Object.entries(typeIcons)) {
    const option = types.getByRole('button', { name, exact: true });
    await expect(option).toHaveAttribute('data-type', type);
    await expect(option).toHaveAttribute('title', title);
    await expect(option).toHaveClass(/segmented__option--icon/);
    await expect(option.locator('svg.icon use')).toHaveAttribute('href', new RegExp(`#i-${icon}$`));
    await expect(option.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  }
  // Number needs a single-row result. The button is disabled, and its title gives the reason.
  const number = types.getByRole('button', { name: 'Number', exact: true });
  await expect(number.locator('svg.icon use')).toHaveAttribute('href', /#i-number-123$/);
  await expect(number).toBeDisabled();
  await expect(number).toHaveAttribute('title', 'Number needs a single-row result');
  // The keyboard reaches an option with Tab. Enter picks it.
  await types.getByRole('button', { name: 'Area', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(core(chart)).toHaveAttribute('data-type', 'area');
  await types.getByRole('button', { name: 'Line', exact: true }).click();
  await expect(core(chart)).toHaveAttribute('data-type', 'line');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 v, w');
  expect(await seriesStats(chart)).toEqual({ v: { points: 120, runs: 1 }, w: { points: 120, runs: 1 } });
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(2);
  await expect(chart.locator('.queryChart__note')).toContainText('120 rows');

  // The rows are sorted by t in ascending order. Index i is number = 119 - i.
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

  // The series picker covers w only.
  await chart.locator('.queryChart__seriesButton').click();
  await chart.locator('.queryChart__seriesMenu input[value="1"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('Y values \u00b7 w');
  expect(Object.keys(await seriesStats(chart))).toEqual(['w']);
  // With one series, the chart has no legend. The engine shows a legend from two series up.
  await expect(chart.locator('.chartCore__legendItem')).toHaveCount(0);

  // Return to the table. The rows are still rendered.
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
  // Long-form rows: each group has a row every third minute. Its line connects across the minutes of the
  // other groups.
  expect(await seriesStats(chart)).toEqual({ a: { points: 40, runs: 1 }, b: { points: 40, runs: 1 }, c: { points: 40, runs: 1 } });
  await expect(chart.locator('.chartCore__legendItem')).toHaveText(['a', 'b', 'c']);
  const { index } = await hoverPlot(page, chart, 0.5);
  const number = 119 - index;
  expect(await tooltipValues(chart)).toEqual({ [['a', 'b', 'c'][number % 3]]: String(number % 7) });

  // If there are more groups than colour slots, the chart shows the top 8 by value. The rest goes in Other.
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

  // The chart keeps the chosen view as the default for the next result.
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

  // The chart remains the default. The next numeric result opens as a chart.
  await runSuccessfulQuery(page, BARS);
  await expect(chart).toBeVisible();
  await expect(core(chart)).toBeVisible();

  // A single row with several columns has Number tiles in the chart. The table view shows the vertical table.
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

  // Copy JSON copies the rows from the chart view, too.
  const readCopied = await captureCopies(page, { clipboard: true });
  await page.locator('#copyJsonButton').click();
  await expect.poll(() => readCopied().then((text) => { try { return JSON.parse(text).length; } catch (_) { return -1; } })).toBe(120);

  await page.locator('#clearResultsButton').click();
  await expect(page.locator('#resultsPanel')).toBeHidden();
  await expect(mainToggle(page)).toBeHidden();
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(mainChart(page)).toBeVisible();
  await mainToggle(page).locator('[data-view="table"]').click();
  expect(await page.evaluate(() => localStorage.getItem('chdash.results.view'))).toBe('table');
  // A hidden chart releases its canvas memory.
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

  // The virtualised panel charts all 3000 rows. It also renders its table.
  await showChart(panel(3));
  await expect(panel(3).locator('.queryChart')).toHaveAttribute('data-x-kind', 'number');
  await expect(panel(3).locator('.queryChart__note')).toContainText('3,000 rows');
  await panel(3).locator('.resultsViewToggle [data-view="table"]').click();
  await expect(panel(3).locator('tbody tr.resultTable__spacerRow').first()).toBeAttached();
  const mounted = await panel(3).locator(`tbody ${dataRows}`).count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(3000);

  // Two time panels: a hover on one panel draws the crosshair at the same instant in the other (Grafana's
  // shared crosshair).
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

  // A collapse and a re-expand of a charted panel redraw it at full width.
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
  // The stream lasts about two seconds: 40 blocks of 5000 rows.
  await runQuery(page, 'SELECT number AS n, number % 1000 AS v, intDiv(number, 7) % 500 AS u FROM numbers(200000) WHERE sleepEachRow(0.00001) = 0 SETTINGS max_block_size = 5000');
  // While the rows arrive, the chart area counts them and draws nothing.
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
  // Every range starts at 22:30 (UTC, the browser's zone here). The first label is just before a midnight.
  // "Oct 2 2026" under 23:00 and "Oct 3 2026" under 00:00 collided. Now 00:00 reads "Oct 3" (the year is the
  // first date's). Or, the first date is replaced by "Oct 3 2026".
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
      // The chart draws this result at 390 px, which decimates the 30 d points.
      await expect(root).toHaveAttribute('data-x-max', String((start + step * count) * 1000));
      // Each entry has this form for a label that the chart draws: [label, date line, left, right, date left,
      // date right].
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
  // A redraw of the same axis measures no text. The widths are cached.
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
  // When the window is resized, the chart redraws at the new width. A narrow (mobile) window keeps the chart
  // inside the panel.
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => chart.evaluate((host) => Math.abs(host.querySelector('.chartCore__plot').clientWidth - host.querySelector('canvas').getBoundingClientRect().width))).toBeLessThanOrEqual(1);
    expect(await chart.evaluate((host) => host.scrollWidth - host.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/example-mobile-390.png` });
  // High-density screens: the backing store follows devicePixelRatio. No resize triggers the redraw. The
  // chart's `resolution` media query does trigger it.
  //
  // Chromium's emulation re-evaluates media queries only when the viewport metrics change. An override that
  // changes the scale factor alone sets devicePixelRatio, without any change event or resize. No real display
  // change does that. So the override also increases the viewport height by 1 px. This leaves the plot width
  // and the resize observer unchanged.
  await page.setViewportSize({ width: 1280, height: 900 });
  const backing = () => chart.evaluate((host) => {
    const c = host.querySelector('canvas');
    const css = c.getBoundingClientRect().width;
    const plot = host.querySelector('.chartCore__plot').clientWidth;
    return { ratio: c.width / css, plot, fits: Math.abs(plot - css) <= 1, viewport: innerWidth, draws: Number(host.querySelector('.chartCore').dataset.draws) };
  });
  // The 1280 px redraw completes before the scale factor changes.
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
  // The chart does not parse or draw anything while the rows arrive.
  await page.evaluate(() => {
    const ns = window.ChDash;
    window.__beforeDone = null;
    const host = document.querySelector('#resultsPanel > .queryChart');
    const watch = () => {
      // The last frame that showed the placeholder, with the rows received.
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
  // The chart receives its data once.
  expect(work.q.plots).toBe(1);
  expect(work.maxDrawsPerFrame).toBeLessThanOrEqual(1);
  expect(work.core.draws).toBeGreaterThan(0);
  expect(work.core.draws).toBeLessThanOrEqual(3);
  // Each column is appended once: x and the three series of 200,000 rows. The column types are read once for
  // each result.
  expect(work.q.rowsParsed).toBe(4 * 200000);
  expect(work.q.typeDetections).toBe(5);
  // The series never changed: one legend, one toolbar.
  expect(work.core.legendBuilds).toBe(1);
  expect(work.q.toolbarBuilds).toBeLessThanOrEqual(1);
  // Decimation reads block summaries, not every point at every draw.
  expect(work.core.tracedPoints).toBeLessThan(work.core.draws * 3 * 200000);
  expect(work.core.summarised).toBeLessThanOrEqual(3 * 200000 + 3 * 64 * work.core.setData);
});

test('a canceled or failed query charts the rows it received', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  const chart = mainChart(page);
  // The test cancels the stream mid-stream. The placeholder shows until then. The received rows show after
  // that.
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

  // The result fails after some rows (a division by zero at row 3000). The chart shows those rows.
  await runQuery(page, 'SELECT number AS n, intDiv(10, 3000 - number) AS v FROM numbers(10000) SETTINGS max_block_size = 500');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
  // The chart shows the data, or (ClickHouse failed the first block) the empty message. It never shows the
  // placeholder after the stream has ended.
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

  // During a stream in the Table view, the chart does not parse or draw anything. The Chart view builds it.
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'table'));
  idle(await countWork(page, () => runSuccessfulQuery(page, STREAMED)));
  const shown = await countWork(page, async () => {
    await showChart(mainToggle(page));
    await expect(chart).toHaveAttribute('data-rows-charted', '200000');
  });
  expect(shown.q.rowsParsed).toBe(4 * 200000);
  expect(shown.maxDrawsPerFrame).toBeLessThanOrEqual(1);

  // In a background tab, the chart waits. Then it charts every row in a few frames.
  await setPageHidden(page, true);
  idle(await countWork(page, () => runSuccessfulQuery(page, STREAMED)));
  const back = await countWork(page, async () => {
    await setPageHidden(page, false);
    await expect(chart).toHaveAttribute('data-rows-charted', '200000');
  });
  expect(back.core.draws).toBeGreaterThan(0);
  expect(back.maxDrawsPerFrame).toBeLessThanOrEqual(1);

  // A multiquery panel collapses while its rows arrive. Its chart only counts the rows in that time. The
  // chart draws nothing until the panel expands again.
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
  // The server caps a result at 200,000 rows. The test feeds these rows to a result chart in the page, in 100
  // chunks of 10,000 rows, each in a separate task, as the stream delivers them.
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
    // During the stream, the chart did not parse or draw anything.
    const streamed = { q: ns.queryChart.counters(), draws: ns.chartCore.counters().draws };
    ctl.done();
    await new Promise((resolve) => {
      const check = () => (Number(ctl.hostEl.dataset.rowsCharted) === rows.length ? resolve() : requestAnimationFrame(check));
      requestAnimationFrame(check);
    });
    // The browser presents the frame after the final draw.
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
  // The chart parses the rows over a few frames after the end. Then it draws once.
  expect(result.plots).toBe(1);
  expect(result.maxDraws).toBeLessThanOrEqual(1);
  expect(result.finalPaintMs).toBeLessThan(1500);
  expect(Math.max(0, ...result.longTasks)).toBeLessThan(200);
});

// Audit round 2: the Chart details panel is on the left of the plot. The rows note stays at the right end.
// The Number icon is as tall as the other types. When it is off, the icon is dimmed and keeps a tooltip that
// gives the reason (aria-disabled, not disabled).
test('chart details: on the left of the plot; the Number icon the size of the others, dimmed with its reason when off', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(core(chart)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  const details = await chart.locator('.queryChart__details').boundingBox();
  const plot = await core(chart).boundingBox();
  expect(details.x + details.width).toBeLessThanOrEqual(plot.x);
  expect(Math.abs(details.y - plot.y)).toBeLessThan(80);
  const types = await chart.locator('.queryChart__types').boundingBox();
  expect(types.x).toBeGreaterThanOrEqual(details.x);
  expect(types.x + types.width).toBeLessThanOrEqual(details.x + details.width);
  // The note ("120 rows") stays at the right end of the plot column.
  const note = await chart.locator('.queryChart__note').boundingBox();
  expect(note.x + note.width).toBeGreaterThan(plot.x + plot.width - 4);
  // When it is off, the button has aria-disabled. Hover and focus show the title. The button is dimmed, and a
  // click does nothing.
  const number = chart.locator('.queryChart__types [data-type="number"]');
  await expect(number).toHaveAttribute('aria-disabled', 'true');
  expect(await number.evaluate((el) => el.disabled)).toBe(false);
  await expect(number).toHaveAttribute('title', 'Number needs a single-row result');
  expect(Number(await number.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.6);
  // (force: Playwright itself will not click an aria-disabled button.)
  await number.click({ force: true });
  await expect(core(chart)).toHaveAttribute('data-type', 'line');
  await expect(number).toHaveAttribute('aria-pressed', 'false');
  // The drawings: the Number glyph is as tall as the bar chart's (the sprite's own geometry).
  const heights = await page.evaluate(async () => {
    const text = await (await fetch(window.__chdashIconSprite)).text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const box = (id) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.style.cssText = 'position:absolute;width:24px;height:24px';
      svg.innerHTML = doc.getElementById(id).innerHTML;
      document.body.appendChild(svg);
      const b = svg.getBBox();
      svg.remove();
      return b.height;
    };
    return { number: box('i-number-123'), bar: box('i-chart-bar'), line: box('i-chart-line') };
  });
  expect(heights.number).toBeGreaterThanOrEqual(heights.bar * 0.7);
});

// Chart details: fixed Y edges, and a panel that folds to a rail. The panel stays folded.
test('chart details: fixed Y edges, and a panel that folds and stays folded', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(core(chart)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  // Y max alone raises the top edge. Both edges fix the axis. The chart flags and ignores a pair that leaves
  // no range.
  await chart.locator('input[data-cfg="yMax"]').fill('50');
  await expect(core(chart)).toHaveAttribute('data-y-max', '50');
  await chart.locator('input[data-cfg="yMin"]').fill('-5');
  await expect(core(chart)).toHaveAttribute('data-y-min', '-5');
  await chart.locator('input[data-cfg="yMin"]').fill('60');
  await expect(chart.locator('.queryChart__bounds')).toHaveClass(/is-invalid/);
  await expect(core(chart)).not.toHaveAttribute('data-y-min', '60');
  await chart.locator('input[data-cfg="yMin"]').fill('');
  await chart.locator('input[data-cfg="yMax"]').fill('');
  await expect(chart.locator('.queryChart__bounds')).not.toHaveClass(/is-invalid/);
  // The edges survive the next run of the same columns.
  await chart.locator('input[data-cfg="yMax"]').fill('40');
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(chart.locator('input[data-cfg="yMax"]')).toHaveValue('40');
  // When the panel folds, it hides the fields, keeps the button, and gives the plot the full width. The chart
  // keeps the choice for the next chart.
  await expect(core(chart)).toBeVisible();
  await expect(core(chart)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/);
  const before = await core(chart).boundingBox();
  await chart.locator('.queryChart__detailsToggle').click();
  await expect(chart.locator('.queryChart__detailsBody')).toBeHidden();
  await expect(chart.locator('.queryChart__detailsToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await core(chart).boundingBox()).width).toBeGreaterThan(before.width + 100);
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.details'))).toBe('closed');
  await page.reload();
  await runSuccessfulQuery(page, TIME_SERIES);
  await showChart(mainToggle(page));
  await expect(mainChart(page).locator('.queryChart__detailsBody')).toBeHidden();
  await mainChart(page).locator('.queryChart__detailsToggle').click();
  await expect(mainChart(page).locator('.queryChart__detailsBody')).toBeVisible();
});

// Graph styles (Chart details): the settings of the panel apply to the plot.
test('chart details: stack, interpolation, fill, points and line width reach the plot', async ({ page }) => {
  await openApp(page);
  // Three groups share each minute, so a stack has three layers.
  await runSuccessfulQuery(page, "SELECT toStartOfMinute(now() - intDiv(number, 3) * 60) AS t, number % 7 AS v, ['a', 'b', 'c'][number % 3 + 1] AS g FROM numbers(120)");
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const root = core(chart);
  await expect(root).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  const num = async (name) => Number(await root.getAttribute(name));
  const field = (key) => chart.locator(`input[data-cfg="${key}"]`);

  // Stack: 100% shows values out of 100 (an area). Off draws each area on its own.
  await chart.locator('.queryChart__types [data-type="area"]').click();
  await pickChart(chart, 'select[data-cfg="stack"]', 'percent');
  await expect.poll(() => num('data-y-max')).toBeGreaterThanOrEqual(100);
  expect(await num('data-y-max')).toBeLessThan(110);
  await pickChart(chart, 'select[data-cfg="stack"]', 'off');
  await expect.poll(() => num('data-y-max')).toBeLessThan(20);
  // Interpolation and fill (a line).
  await chart.locator('.queryChart__types [data-type="line"]').click();
  await expect(root).toHaveAttribute('data-interpolation', 'linear');
  await pickChart(chart, 'select[data-cfg="interp"]', 'smooth');
  await expect(root).toHaveAttribute('data-interpolation', 'smooth');
  await pickChart(chart, 'select[data-cfg="interp"]', 'stepAfter');
  await expect(root).toHaveAttribute('data-interpolation', 'stepAfter');
  await expect(root).toHaveAttribute('data-series-washed', '0');
  await field('fill').first().fill('30');
  await expect(root).toHaveAttribute('data-series-washed', '3');
  await field('lineWidth').fill('3');
  await expect(field('lineWidth')).toHaveValue('3');
  await pickChart(chart, 'select[data-cfg="points"]', 'always');
  await field('pointSize').first().fill('8');
  // Points is a type of its own, and keeps the point size.
  await chart.locator('.queryChart__types [data-type="points"]').click();
  await expect(root).toHaveAttribute('data-type', 'points');
  await expect(field('pointSize').last()).toHaveValue('8');
  // The settings stay for the next result with the same columns.
  await chart.locator('.queryChart__types [data-type="line"]').click();
  await runSuccessfulQuery(page, "SELECT toStartOfMinute(now() - intDiv(number, 3) * 60) AS t, number % 7 AS v, ['a', 'b', 'c'][number % 3 + 1] AS g FROM numbers(120)");
  await expect(root).toHaveAttribute('data-interpolation', 'stepAfter');
});

// Missing values: a series that has no row at an x leaves a gap. Zero reads the gap as 0. Connect joins the
// points across the gap.
test('chart details: Missing values Zero gives every series a value at every x', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, GROUPED);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const root = core(chart);
  await expect(root).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  const rows = chart.locator('.chartCore__tooltip .chartCore__tipRow:not(.chartCore__tipRow--total)');
  // One row per minute, three groups in turn: at a given minute only one series has a value.
  await hoverPlot(page, chart, 0.5);
  await expect(rows).toHaveCount(1);
  await pickChart(chart, 'select[data-cfg="missing"]', 'zero');
  await hoverPlot(page, chart, 0.5);
  await expect(rows).toHaveCount(3);
  await pickChart(chart, 'select[data-cfg="missing"]', 'gap');
  await hoverPlot(page, chart, 0.5);
  await expect(rows).toHaveCount(1);
});
