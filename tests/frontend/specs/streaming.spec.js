import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

test('large streamed results stay virtualized and reach the last row', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'row-\', toString(number)) AS label FROM numbers(20000)');
  const body = page.locator('#resultTableBody');
  await expect(body.locator('tr.resultTable__spacerRow').first()).toBeAttached();
  const mounted = await body.locator('tr:not(.resultTable__spacerRow)').count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(2000);
  // Streaming appends grow the bottom spacer; once the last render frame has
  // run, mounted rows + spacers must account for the full result height.
  await expect.poll(async () => page.evaluate(() => {
    const tbody = document.getElementById('resultTableBody');
    let spacer = 0;
    for (const tr of tbody.querySelectorAll('tr.resultTable__spacerRow')) spacer += tr.getBoundingClientRect().height;
    const rows = tbody.querySelectorAll('tr:not(.resultTable__spacerRow)');
    const rowH = rows.length ? rows[0].getBoundingClientRect().height : 0;
    return rowH > 0 ? (spacer / rowH + rows.length) / 20000 : 0;
  }), { timeout: 10_000 }).toBeGreaterThan(0.95);
  await page.evaluate(() => {
    const tbody = document.getElementById('resultTableBody');
    tbody.lastElementChild.scrollIntoView({ block: 'end' });
  });
  await expect(body).toContainText('row-19999', { timeout: 10_000 });
});

test('tuple columns are flattened into leaf columns', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, `SELECT CAST((number, concat('n', toString(number))), 'Tuple(code UInt64, name String)') AS t,
    [CAST((1, 'a'), 'Tuple(k UInt8, v String)'), CAST((2, 'b'), 'Tuple(k UInt8, v String)')] AS arr
  FROM numbers(3) ORDER BY number`);
  const head = page.locator('#resultTableHead');
  await expect(head).toContainText('t.code');
  await expect(head).toContainText('t.name');
  await expect(head).toContainText('arr.k');
  await expect(head).toContainText('arr.v');
  await expect(page.locator('#resultTableBody')).toContainText('n2');
});
