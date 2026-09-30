import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

// Query result Table / Chart view: the chart is drawn client-side from the
// rows a result panel received, per panel (main and every multiquery panel).

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const TIME_SERIES = 'SELECT toStartOfMinute(now() - number * 60) AS t, number % 7 AS v, number % 3 AS w FROM numbers(120)';
const GROUPED = "SELECT toStartOfMinute(now() - number * 60) AS t, number % 7 AS v, ['a', 'b', 'c'][number % 3 + 1] AS g FROM numbers(120)";
const BARS = "SELECT ['alpha', 'beta', 'gamma'][number % 3 + 1] AS k, count() AS c FROM numbers(30) GROUP BY k ORDER BY k";
const dataRows = 'tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)';
const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/query-chart`;

const mainToggle = (page) => page.locator('#resultsPanel .resultsViewToggle--main');
const mainChart = (page) => page.locator('#resultsPanel > .queryChart');
const mainTable = (page) => page.locator('#resultsPanel > .tableWrap');

async function showChart(scope) {
  await scope.locator('.resultsViewToggle__opt[data-view="chart"]').first().click();
}

async function enableMultiquery(page) {
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
}

// Hover the plot at a fraction of its width; returns the tooltip index and
// the crosshair / pointer x positions.
async function hoverPlot(page, chart, fraction) {
  const hit = chart.locator('.queryChart__hit');
  const box = await hit.boundingBox();
  const x = box.x + box.width * fraction;
  await page.mouse.move(x, box.y + box.height / 2);
  const tooltip = chart.locator('.queryChart__tooltip');
  await expect(tooltip).toBeVisible();
  const svgLeft = (await chart.locator('svg').boundingBox()).x;
  const cross = Number(await chart.locator('.queryChart__crosshair').getAttribute('x1'));
  return { index: Number(await tooltip.getAttribute('data-index')), pointerX: x - svgLeft, crossX: cross, box };
}

async function tooltipValues(chart) {
  const rows = chart.locator('.queryChart__tooltip .queryChart__tipRow');
  const out = {};
  for (const row of await rows.all()) out[await row.locator('em').textContent()] = await row.locator('b').textContent();
  return out;
}

test('time series result switches between table and chart, hover snaps to the nearest point', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, TIME_SERIES);
  await expect(mainToggle(page)).toBeVisible();
  await expect(mainToggle(page).locator('[data-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(mainChart(page)).toBeHidden();

  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toBeVisible();
  await expect(mainTable(page)).toBeHidden();
  await expect(chart).toHaveAttribute('data-x-kind', 'time');
  await expect(chart.locator('.queryChart__type[data-type="line"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('.queryChart__x')).toHaveValue('0');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('v, w');
  await expect(chart.locator('.queryChart__line')).toHaveCount(2);
  await expect(chart.locator('.queryChart__line').first()).toHaveAttribute('data-points', '120');
  // Date-aware x axis: clock labels (HH:MM) for a two-hour window.
  const ticks = await chart.locator('.queryChart__xTick').allTextContents();
  expect(ticks.length).toBeGreaterThan(3);
  for (const label of ticks) expect(label).toMatch(/^(\d{2}:\d{2}|[A-Z][a-z]{2} \d{1,2})$/);
  await expect(chart.locator('.queryChart__legendItem')).toHaveCount(2);
  await expect(chart.locator('.queryChart__note')).toContainText('120 rows');

  // Rows are sorted by t ascending: index i is number = 119 - i.
  for (const fraction of [0.013, 0.37, 0.5, 0.81, 0.999]) {
    const { index, pointerX, crossX, box } = await hoverPlot(page, chart, fraction);
    const spacing = box.width / 119;
    expect(Math.abs(crossX - pointerX)).toBeLessThanOrEqual(spacing / 2 + 1);
    const number = 119 - index;
    const values = await tooltipValues(chart);
    expect(values).toEqual({ v: String(number % 7), w: String(number % 3) });
    await expect(chart.locator('.queryChart__tooltip strong')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
  }
  await page.mouse.move(2, 2);
  await expect(chart.locator('.queryChart__tooltip')).toBeHidden();

  // Legend toggles a series off and back on.
  const legendW = chart.locator('.queryChart__legendItem', { hasText: 'w' });
  await legendW.click();
  await expect(legendW).toHaveAttribute('aria-pressed', 'false');
  await expect(chart.locator('.queryChart__line')).toHaveCount(1);
  await legendW.click();
  await expect(chart.locator('.queryChart__line')).toHaveCount(2);

  // Chart types.
  await chart.locator('.queryChart__type[data-type="area"]').click();
  await expect(chart.locator('.queryChart__area')).toHaveCount(2);
  await chart.locator('.queryChart__type[data-type="bar"]').click();
  await expect(chart.locator('.queryChart__bar')).toHaveCount(2);
  await expect(chart.locator('.queryChart__type[data-type="number"]')).toBeDisabled();

  // Series picker: w only.
  await chart.locator('.queryChart__seriesButton').click();
  await chart.locator('.queryChart__seriesMenu input[value="1"]').uncheck();
  await page.keyboard.press('Escape');
  await expect(chart.locator('.queryChart__seriesButton')).toHaveText('w');
  await expect(chart.locator('.queryChart__bar')).toHaveCount(1);
  await expect(chart.locator('.queryChart__legendItem')).toHaveCount(0);

  // Back to the table: the rows are still rendered.
  await mainToggle(page).locator('[data-view="table"]').click();
  await expect(mainTable(page)).toBeVisible();
  await expect(chart).toBeHidden();
  await expect(page.locator(`#resultTableBody ${dataRows}`)).toHaveCount(120);
});

test('group-by column draws one series per value and folds the rest into Other', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, GROUPED);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart.locator('.queryChart__group')).toHaveValue('2');
  await expect(chart.locator('.queryChart__line')).toHaveCount(3);
  expect(await chart.locator('.queryChart__legendItem').allTextContents()).toEqual(['a', 'b', 'c']);
  // Long-form rows: each group has a row every third minute and its line
  // connects across the other groups' minutes.
  for (const path of await chart.locator('.queryChart__line').all()) {
    await expect(path).toHaveAttribute('data-points', '40');
    expect((await path.getAttribute('d')).match(/M/g)).toHaveLength(1);
  }
  const { index } = await hoverPlot(page, chart, 0.5);
  const number = 119 - index;
  const values = await tooltipValues(chart);
  expect(values).toEqual({ [['a', 'b', 'c'][number % 3]]: String(number % 7) });

  // More groups than colour slots: the top 8 by value, the rest in Other.
  await runSuccessfulQuery(page, 'SELECT toStartOfMinute(now() - intDiv(number, 12) * 60) AS t, toString(number % 12) AS g, number % 12 + 1 AS v FROM numbers(240)');
  await expect(chart).toBeVisible();
  const labels = await chart.locator('.queryChart__legendItem').allTextContents();
  expect(labels).toHaveLength(9);
  expect(labels[8]).toBe('Other');
  expect(labels.slice(0, 8).sort()).toEqual(['10', '11', '4', '5', '6', '7', '8', '9']);
  await expect(chart.locator('.queryChart__note')).toContainText('4 groups folded into Other');
  await chart.locator('.queryChart__group').selectOption('-1');
  await expect(chart.locator('.queryChart__line')).toHaveCount(1);
  await expect(chart.locator('.queryChart__note')).toContainText('summed');
});

test('string x draws bars, a single value shows a number, text-only results cannot be charted', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, BARS);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toHaveAttribute('data-x-kind', 'category');
  await expect(chart.locator('.queryChart__type[data-type="bar"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('.queryChart__bar')).toHaveAttribute('data-points', '3');
  expect(await chart.locator('.queryChart__xTick').allTextContents()).toEqual(['alpha', 'beta', 'gamma']);
  await hoverPlot(page, chart, 0.5);
  await expect(chart.locator('.queryChart__tooltip strong')).toHaveText('beta');
  expect(await tooltipValues(chart)).toEqual({ c: '10' });

  // The chosen view is the default for the next result.
  await runSuccessfulQuery(page, 'SELECT 1234567 AS answer');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('data-chart-type', 'number');
  await expect(chart.locator('.queryChart__numberValue')).toHaveText('1,234,567');
  await expect(chart.locator('.queryChart__numberLabel')).toHaveText('answer');

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
});

test('multiquery panels toggle independently', async ({ page }) => {
  await openApp(page);
  await enableMultiquery(page);
  await runQuery(page, `${TIME_SERIES}; SELECT 'only' AS label, 'text' AS other; ${BARS}; SELECT number AS id, number * 2 AS twice FROM numbers(3000);`);
  await waitForTerminal(page);
  const blocks = page.locator('.resultsStack__block');
  await expect(blocks).toHaveCount(4);
  await expect(mainToggle(page)).toBeHidden();
  const panel = (i) => blocks.nth(i);
  const expand = async (i) => {
    if (await panel(i).locator('.resultsStack__body').isHidden()) await panel(i).locator('.resultsStack__toggle').click();
  };
  for (let i = 0; i < 4; i++) await expand(i);
  for (let i = 0; i < 4; i++) await expect(panel(i).locator('.resultsViewToggle [data-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(1).locator('.resultsViewToggle [data-view="chart"]')).toBeDisabled();

  await showChart(panel(0));
  await expect(panel(0).locator('.queryChart')).toBeVisible();
  await expect(panel(0).locator('.queryChart__line')).toHaveCount(2);
  await expect(panel(0).locator('.resultsStack__body > .tableWrap')).toBeHidden();
  await expect(panel(2).locator('.queryChart')).toBeHidden();
  await expect(panel(2).locator('.resultsStack__body > .tableWrap')).toBeVisible();

  await showChart(panel(2));
  await expect(panel(2).locator('.queryChart__bar')).toHaveAttribute('data-points', '3');
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

  // Collapsing and re-expanding a charted panel redraws it at full width.
  await panel(2).locator('.resultsStack__toggle').click();
  await expect(panel(2).locator('.resultsStack__body')).toBeHidden();
  await panel(2).locator('.resultsStack__toggle').click();
  await expect(panel(2).locator('.queryChart svg')).toBeVisible();
  const widths = await panel(2).locator('.queryChart__plot').evaluate((plot) => [plot.clientWidth, plot.querySelector('svg').getBoundingClientRect().width]);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThanOrEqual(1);

  // Global copy and the ZIP / JSON download stay available.
  await expect(page.locator('#copyJsonButton')).toBeEnabled();
  await page.locator('#copyMenuButton').click();
  await expect(page.locator('#downloadReceivedJsonButton')).toBeVisible();
  await expect(page.locator('#downloadReceivedJsonButton')).toBeEnabled();
});

test('a large streamed result charts incrementally, downsampled, and stays responsive', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('chdash.results.view', 'chart'));
  await page.evaluate(() => {
    window.__qchartFrames = { max: 0, last: performance.now(), updates: 0, lastPoints: '' };
    const tick = (now) => {
      const f = window.__qchartFrames;
      f.max = Math.max(f.max, now - f.last);
      f.last = now;
      const host = document.querySelector('#resultsPanel > .queryChart');
      const points = host ? host.dataset.pointsDrawn || '' : '';
      const note = host ? host.querySelector('.queryChart__note')?.textContent || '' : '';
      if (note !== f.lastPoints) { f.lastPoints = note; f.updates += 1; }
      if (!f.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // About two seconds of streaming: 40 blocks of 5000 rows.
  await runQuery(page, 'SELECT number AS n, number % 1000 AS v, intDiv(number, 7) % 500 AS u FROM numbers(200000) WHERE sleepEachRow(0.00001) = 0 SETTINGS max_block_size = 5000');
  // The chart appears while the rows are still streaming.
  await expect(mainChart(page).locator('svg')).toBeVisible({ timeout: 20_000 });
  await waitForTerminal(page);
  const chart = mainChart(page);
  await expect(chart.locator('.queryChart__note')).toContainText('200,000 rows', { timeout: 15_000 });
  await expect(chart.locator('.queryChart__note')).toContainText('min/max envelope');
  const frames = await page.evaluate(() => { window.__qchartFrames.stop = true; return window.__qchartFrames; });
  console.log(`large stream: max frame gap ${Math.round(frames.max)} ms, ${frames.updates} chart updates`);
  expect(frames.updates).toBeGreaterThan(2);
  expect(frames.max).toBeLessThan(1500);
  for (const path of await chart.locator('.queryChart__line').all()) {
    expect(Number(await path.getAttribute('data-points'))).toBeLessThanOrEqual(2000);
  }
  expect(Number(await chart.getAttribute('data-points-drawn'))).toBeLessThanOrEqual(2000);
  // The tooltip reads the full-resolution rows.
  await hoverPlot(page, chart, 0.4321);
  const header = await chart.locator('.queryChart__tooltip strong').textContent();
  const n = Number(header.replace(/,/g, ''));
  expect(Number.isInteger(n)).toBeTruthy();
  const values = await tooltipValues(chart);
  expect(values.v).toBe((n % 1000).toLocaleString('en-US'));
  expect(values.u).toBe((Math.floor(n / 7) % 500).toLocaleString('en-US'));
  // The editor still takes input.
  await page.locator('#queryTextArea').fill('SELECT 1');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 1');
});

test('NULL values break lines; nullable and decimal columns chart', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS x, if(number IN (4, 5), NULL, toDecimal64(number / 4, 2)) AS d, toNullable(toFloat64(number)) AS f FROM numbers(10)');
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  await expect(chart).toHaveAttribute('data-x-kind', 'number');
  const d = chart.locator('.queryChart__line[data-series="d"]');
  await expect(d).toHaveAttribute('data-points', '8');
  expect((await d.getAttribute('d')).match(/M/g)).toHaveLength(2);
  await hoverPlot(page, chart, 4.4 / 9);
  expect(await tooltipValues(chart)).toEqual({ d: 'NULL', f: '4' });
});

test('chart follows the theme, resizes and never overflows the page', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, GROUPED);
  await showChart(mainToggle(page));
  const chart = mainChart(page);
  const stroke = () => chart.locator('.queryChart__line').first().evaluate((el) => getComputedStyle(el).stroke);
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  expect(await stroke()).toBe('rgb(57, 135, 229)');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  expect(await stroke()).toBe('rgb(42, 120, 214)');

  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => localStorage.setItem('chdash.theme', mode), theme);
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.reload();
      await openApp(page);
      await runSuccessfulQuery(page, GROUPED);
      await expect(chart.locator('svg')).toBeVisible();
      const sizes = await chart.evaluate((host) => ({
        plot: host.querySelector('.queryChart__plot').clientWidth,
        svg: host.querySelector('svg').getBoundingClientRect().width,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(Math.abs(sizes.plot - sizes.svg)).toBeLessThanOrEqual(1);
      expect(sizes.overflow).toBeLessThanOrEqual(1);
      await hoverPlot(page, chart, 0.62);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/grouped-${theme}-${width}.png` });
      await chart.locator('.queryChart__type[data-type="area"]').click();
      await chart.locator('.queryChart__group').selectOption('-1');
      await page.mouse.move(2, 2);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/area-${theme}-${width}.png` });
      await runSuccessfulQuery(page, BARS);
      await page.locator('#resultsPanel').screenshot({ path: `${shotsDir}/bars-${theme}-${width}.png` });
    }
  }
  // Resizing the window redraws at the new width.
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(() => chart.evaluate((host) => Math.abs(host.querySelector('.queryChart__plot').clientWidth - host.querySelector('svg').getBoundingClientRect().width))).toBeLessThanOrEqual(1);
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});
