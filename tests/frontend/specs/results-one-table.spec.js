import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runSuccessfulQuery, waitForBatch } from '../helpers/app.js';

// One live table for the result of a query and for each statement of a batch (app_results_table.js, ARCH-F-048): a statement
// sorts by what its cells show, shows a long result as a virtual window and streams like the single result. These tests
// ran against two implementations that differed; they now check that the two places behave the same.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

async function enableMultiquery(page) {
  await page.locator('#runSettingsButton').click();
  if ((await page.locator('#runOptMultiQuery').getAttribute('aria-checked')) !== 'true') await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
}

const SORT_SQL = "SELECT arrayJoin(['b', NULL, 'a', 'z']) AS v";

// The text of the first column of the rows that are mounted in a table body.
const firstColumn = (body) => body.locator('tr:not(.resultTable__spacerRow) td:nth-child(2)').allTextContents();

test('a statement of a batch sorts a text column by what its cells show, as the single result does', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, SORT_SQL);
  const single = page.locator('#resultTableHead th.is-sortable').nth(1);
  await single.click();
  const singleOrder = await firstColumn(page.locator('#resultTableBody'));
  expect(singleOrder).toHaveLength(4);
  // NULL is shown as a token: it sorts with the other texts, not before them as an empty value.
  expect(singleOrder[0]).toBe('a');

  await enableMultiquery(page);
  await page.locator('#queryTextArea').fill(`SELECT 1 AS one;\n${SORT_SQL};`);
  await page.locator('#runButton').click();
  await waitForBatch(page, 2);
  const panel = page.locator('.resultsStack__block').nth(1);
  await panel.locator('thead th.is-sortable').nth(1).click();
  const panelOrder = await firstColumn(panel.locator('tbody'));
  expect(panelOrder).toEqual(singleOrder);
});

test('a long statement of a batch mounts a window of its rows, as the single result does', async ({ page }) => {
  await openApp(page);
  await enableMultiquery(page);
  await page.locator('#queryTextArea').fill('SELECT 1 AS one;\nSELECT number AS n, toString(number) AS s FROM numbers(3000);');
  await page.locator('#runButton').click();
  await waitForBatch(page, 2);
  const panel = page.locator('.resultsStack__block').nth(1);
  await expect(panel.locator('.tableWrap--virtual')).toHaveCount(1);
  const mounted = await panel.locator('tbody tr:not(.resultTable__spacerRow)').count();
  expect(mounted).toBeGreaterThan(20);
  expect(mounted).toBeLessThan(3000);
  expect(await panel.locator('tbody tr.resultTable__spacerRow').count()).toBeGreaterThan(0);
  await expect(panel.locator('.resultsStack__meta')).toContainText('3,000 rows');
  // The numeric sort reaches the end of the list through the same window.
  const header = panel.locator('thead th.is-sortable').nth(1);
  await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(panel.locator('tbody tr:not(.resultTable__spacerRow) td:nth-child(2)').first()).toHaveText('2999');
});

test('a statement with one row and one column is a value, with several columns a column and value list, as the single result', async ({ page }) => {
  await openApp(page);
  await enableMultiquery(page);
  await page.locator('#queryTextArea').fill("SELECT 1 AS one;\nSELECT 2 AS a, 'x' AS b;\nSELECT number FROM numbers(2);");
  await page.locator('#runButton').click();
  await waitForBatch(page, 3);
  const panels = page.locator('.resultsStack__block');
  // One value: its column name, then the value.
  await expect(panels.nth(0).locator('thead th')).toHaveCount(1);
  await expect(panels.nth(0).locator('tbody td:not(.dataTable__rowNum)')).toHaveText('1');
  // One row: Column | Value.
  await expect(panels.nth(1).locator('table.resultTable--vertical')).toHaveCount(1);
  await expect(panels.nth(1).locator('thead th')).toHaveText(['Column', 'Value']);
  // Two rows: a horizontal table with its row numbers.
  await expect(panels.nth(2).locator('thead th')).toHaveText(['#', 'number']);
  await expect(panels.nth(2).locator('tbody tr')).toHaveCount(2);
});
