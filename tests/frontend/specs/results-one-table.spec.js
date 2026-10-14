import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runSuccessfulQuery, waitForBatch } from '../helpers/app.js';
import { captureCopies } from '../helpers/clipboard.js';

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
  // One value: the value alone, no column title above it (the table keeps the name for assistive technology).
  await expect(panels.nth(0).locator('thead th')).toHaveCount(0);
  await expect(panels.nth(0).locator('table')).toHaveAttribute('aria-label', /^one\b/);
  await expect(panels.nth(0).locator('tbody td:not(.dataTable__rowNum)')).toHaveText('1');
  // One row: Column | Value.
  await expect(panels.nth(1).locator('table.resultTable--vertical')).toHaveCount(1);
  await expect(panels.nth(1).locator('thead th')).toHaveText(['Column', 'Value']);
  // Two rows: a horizontal table with its row numbers.
  await expect(panels.nth(2).locator('thead th')).toHaveText(['#', 'number']);
  await expect(panels.nth(2).locator('tbody tr')).toHaveCount(2);
});

// A statement the server returns on several lines (SHOW CREATE TABLE) is shown as SQL: highlighted, with its lines.
test('SHOW CREATE TABLE shows the statement as highlighted multi-line SQL with a copy button', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SHOW CREATE TABLE chdash_ui.weather_daily_summary');
  const block = page.locator('#resultsPanel .sqlBlock');
  await expect(block).toBeVisible();
  // No "statement" title above the one value.
  await expect(page.locator('#resultsPanel thead th')).toHaveCount(0);
  const lines = (await block.locator('.sqlBlock__code').innerText()).split('\n');
  expect(lines[0]).toMatch(/^CREATE TABLE chdash_ui\.weather_daily_summary$/);
  expect(lines.length).toBeGreaterThan(5);
  expect(lines.some((line) => /^ENGINE = /.test(line))).toBe(true);
  // The highlighter's tokens, not the string colour of a plain value.
  await expect(block.locator('.tok-kw').first()).toBeVisible();
  await expect(block.locator('.sqlBlock__copy')).toBeVisible();
  // The lines are laid out one under the other (not collapsed onto one row).
  const first = await block.locator('.sqlBlock__code').boundingBox();
  expect(first.height).toBeGreaterThan(100);
});

// One value is nothing to point at: its cell does not light up under the pointer, a table of rows does.
test('a result of one value has no hover fill; a table of rows has one', async ({ page }) => {
  await openApp(page);
  const fill = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
  await runSuccessfulQuery(page, 'SELECT 42 AS answer');
  const cell = page.locator('#resultsPanel tbody td:not(.dataTable__rowNum)').first();
  await expect(cell).toHaveText('42');
  await cell.hover();
  expect(await fill(cell)).toBe('rgba(0, 0, 0, 0)');
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(3)');
  const row = page.locator('#resultsPanel tbody tr:not(.resultTable__spacerRow)').first().locator('td:not(.dataTable__rowNum)').first();
  await expect(row).toHaveText('0');
  await row.hover();
  expect(await fill(row)).not.toBe('rgba(0, 0, 0, 0)');
});

// The statement is laid out by the formatter (a short Tuple on one line, the types in one column); a button goes back to the
// text as ClickHouse returned it, and Copy copies what is shown.
test('SHOW CREATE TABLE shows the formatted statement, with a switch to the text as returned', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await runSuccessfulQuery(page, 'SHOW CREATE TABLE chdash_ui.wide_types');
  const block = page.locator('#resultsPanel .sqlBlock');
  const mode = block.locator('.sqlBlock__mode');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  const code = block.locator('.sqlBlock__code');
  await expect(code).toContainText(/`tuple_value`\s+Tuple\(code UInt16, name String\),/);
  // Names that fit are one column of types; the long one keeps one space.
  const lines = (await code.innerText()).split('\n');
  const typeColumn = (name) => lines.find((line) => line.includes(`\`${name}\``)).search(/ [A-Z]/);
  expect(typeColumn('id')).toBe(typeColumn('created_on'));
  await block.locator('.sqlBlock__copy').click();
  await expect.poll(async () => (await copied()).includes('Tuple(code UInt16, name String)')).toBe(true);
  // As returned: ClickHouse's own layout (a Tuple over lines), and Copy copies that.
  await mode.click();
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(code).toContainText(/Tuple\(\n\s+code UInt16,/);
  await block.locator('.sqlBlock__copy').click();
  await expect.poll(async () => /Tuple\(\n\s+code UInt16,/.test(await copied())).toBe(true);
  await mode.click();
  await expect(code).toContainText('Tuple(code UInt16, name String)');
});
