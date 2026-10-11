import { test, expect } from '@playwright/test';
import { openApp, runQuery, waitForTerminal } from '../helpers/app.js';

// A format batch answers a status for each statement (ARCH-B-124, README.md "POST /api/format"): the statements that formatted
// replace their text in the editor, the one that did not stays as typed and is reported, and a run with Format on run goes on.

function formatReply(items) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: items.map((item, index) => (item.formatted != null
        ? { index, status: 'formatted', formatted_sql: item.formatted }
        : { index, status: item.status || 'error', error: { error_code: 'format_failed', message: item.message, retryable: false, index, clickhouse: item.clickhouse } })),
      formatted: items.filter((item) => item.formatted != null).length,
      failed: items.filter((item) => item.formatted == null).length,
      skipped: 0,
      cache: { hits: 0, misses: items.length, deduplicated: 0 },
      line_width: 80,
    }),
  };
}

test('Format puts the statements that formatted into the editor and reports the one that did not', async ({ page }) => {
  await openApp(page);
  const sent = [];
  await page.route('**/api/format', (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill(formatReply([
      { formatted: 'SELECT 1' },
      { message: 'DB::Exception: Syntax error: failed at position 8 (()', clickhouse: { position: 8, line: 1, col: 8, near: '(' } },
      { formatted: 'SELECT 3\nFROM t' },
    ]));
  });
  await page.locator('#queryTextArea').fill('select 1;\nselect (;\nselect 3 from t');
  await page.locator('#formatButton').click();
  // One request for the three statements.
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].sqls).toHaveLength(3);
  // The statements that formatted are in the editor; the one that did not stays as typed.
  await expect(page.locator('#queryTextArea')).toHaveValue(/^SELECT 1;\s*select \(;\s*SELECT 3\s+FROM t$/);
  // The failure is the one of that statement, and Format is not "done" for the whole text.
  await expect(page.locator('#errorBanner')).toBeVisible();
  await expect(page.locator('#errorBanner')).toContainText('Syntax error');
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
});

test('Format with every statement formatted leaves no error, and a statement that was skipped is reported like a failure', async ({ page }) => {
  await openApp(page);
  await page.route('**/api/format', (route) => route.fulfill(formatReply([{ formatted: 'SELECT 1' }, { formatted: 'SELECT 2' }])));
  await page.locator('#queryTextArea').fill('select 1;\nselect 2');
  await page.locator('#formatButton').click();
  await expect(page.locator('#queryTextArea')).toHaveValue(/^SELECT 1;\s*SELECT 2$/);
  await expect(page.locator('#errorBanner')).toBeHidden();
  await page.unroute('**/api/format');
  await page.route('**/api/format', (route) => route.fulfill(formatReply([{ formatted: 'SELECT 1' }, { status: 'skipped', message: 'This statement was not formatted: the time of the request ran out. Format it again.' }])));
  await page.locator('#queryTextArea').fill('select 1;\nselect 2');
  await page.locator('#formatButton').click();
  await expect(page.locator('#errorBanner')).toContainText('not formatted');
  await expect(page.locator('#queryTextArea')).toHaveValue(/^SELECT 1;\s*select 2$/);
});

test('with Format on run, a statement that does not format runs as typed and the others run formatted', async ({ page }) => {
  await openApp(page);
  await page.locator('#runSettingsButton').click();
  if ((await page.locator('#runOptAutoFormat').getAttribute('aria-checked')) !== 'true') await page.locator('#runOptAutoFormat').click();
  await page.keyboard.press('Escape');
  await page.route('**/api/format', (route) => route.fulfill(formatReply([{ message: 'DB::Exception: formatter could not read this' }])));
  await runQuery(page, 'select   7 as seven');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished/i);
  await expect(page.locator('#resultTableBody')).toContainText('7');
  await expect(page.locator('#queryTextArea')).toHaveValue('select   7 as seven');
});
