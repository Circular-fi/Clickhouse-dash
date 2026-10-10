import { test, expect } from '@playwright/test';
import { openApp } from '../helpers/app.js';

// A run keeps its host and always ends (docs/telemetry.md, "SSE event contract"). The 2.17 page read
// the selected host again for each statement of a batch, so a host chosen during the first statement
// received the rest; and three exits of the stream never settled the run, which stayed "running"
// until a reload: a stream that ended after an "error" event, a renderer that threw on "done", and a
// stream that never sent anything.

async function enableMultiquery(page) {
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
}

async function expectRunEnded(page, timeout = 10_000) {
  await expect(page.locator('#runButton')).toHaveText('Run', { timeout });
  await expect(page.locator('#queryStatusText')).not.toHaveText(/running|canceling/i);
}

test('every statement of a batch runs on the host the run started on; the host picker is locked meanwhile', async ({ page }) => {
  await openApp(page);
  await enableMultiquery(page);
  await expect(page.locator('#hostPickerButton')).toHaveJSProperty('disabled', false);
  const hosts = [];
  await page.route('**/api/query/run', async (route) => {
    hosts.push(JSON.parse(route.request().postData() || '{}').host_id);
    await route.continue();
  });
  await page.locator('#queryTextArea').fill('SELECT sleep(1) AS a; SELECT 2 AS b; SELECT 3 AS c;');
  await page.locator('#runButton').click();
  await expect(page.locator('#runButton')).toHaveText('Cancel');
  // `disabled`, not toBeDisabled(): a picker of one host is aria-disabled anyway.
  await expect(page.locator('#hostPickerButton')).toHaveJSProperty('disabled', true);
  // The selection moves while the first statement runs (the hosts stream switches it when a host
  // disappears): the batch keeps its host.
  await expect.poll(() => hosts.length).toBe(1);
  const before = await page.evaluate(() => {
    const previous = window.ChDash.state.selectedHostId;
    window.ChDash.state.selectedHostId = 'another-host';
    return previous;
  });
  await expectRunEnded(page, 20_000);
  await page.evaluate((id) => { window.ChDash.state.selectedHostId = id; }, before);
  expect(hosts).toEqual(['local', 'local', 'local']);
  await expect(page.locator('.resultsStack__block')).toHaveCount(3);
  await expect(page.locator('#hostPickerButton')).toHaveJSProperty('disabled', false);
});

test('a stream that ends after an "error" event and before "done" ends the run with that error', async ({ page }) => {
  await openApp(page);
  await page.route('**/api/query/stream*', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    body: 'event: meta\ndata: {"status":"connected"}\n\nevent: error\ndata: {"message":"The server stopped: boom."}\n\n',
  }));
  await page.locator('#queryTextArea').fill('SELECT 1');
  await page.locator('#runButton').click();
  await expectRunEnded(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
  await expect(page.locator('#errorBanner')).toContainText('boom');
});

test('a renderer that fails on "done" does not leave the run running', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.ChDash.results.finalizeAfterDone = () => { throw new Error('render failed on purpose'); };
  });
  await page.locator('#queryTextArea').fill('SELECT 1 AS one');
  await page.locator('#runButton').click();
  await expectRunEnded(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/finished|done/i);
});

test('a stream that sends nothing for 60 seconds ends the run as an error', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  // The stream request never answers: no event, no end.
  await page.route('**/api/query/stream*', () => {});
  await page.locator('#queryTextArea').fill('SELECT 1');
  await page.locator('#runButton').click();
  await expect(page.locator('#runButton')).toHaveText('Cancel');
  await page.clock.runFor(30_000);
  await expect(page.locator('#runButton')).toHaveText('Cancel');
  await page.clock.runFor(45_000);
  await expectRunEnded(page);
  await expect(page.locator('#errorBanner')).toContainText(/No data from the server/);
});

test('text typed while the formatter answers is kept: the run uses the formatted text and the editor is not overwritten', async ({ page }) => {
  await openApp(page);
  await page.route('**/api/format', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue().catch(() => {});
  });
  const editor = page.locator('#queryTextArea');
  await editor.fill('select 1 as a');
  await page.locator('#runButton').click();
  // The formatter is still working: more text is typed at the end.
  await editor.focus();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' -- typed meanwhile');
  await expectRunEnded(page, 20_000);
  await expect(editor).toHaveValue('select 1 as a -- typed meanwhile');
});

test('the progress of a batch shows: "running (2/3)" while the second statement runs', async ({ page }) => {
  await openApp(page);
  await enableMultiquery(page);
  await page.locator('#queryTextArea').fill('SELECT 1 AS a; SELECT sleep(1.2) AS b; SELECT 3 AS c;');
  await page.locator('#runButton').click();
  await expect(page.locator('#queryStatusText')).toHaveText(/running \(2\/3\)/, { timeout: 8000 });
  await expectRunEnded(page, 20_000);
});

test('a stream that is cut says that the server cancels the query, so that an INSERT is checked before it runs again', async ({ page }) => {
  await openApp(page);
  await page.route('**/api/query/stream*', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
    body: 'event: meta\ndata: {"status":"connected"}\n\n',
  }));
  await page.locator('#queryTextArea').fill('SELECT 1');
  await page.locator('#runButton').click();
  await expectRunEnded(page);
  await expect(page.locator('#errorBanner')).toContainText('Connection lost');
  await expect(page.locator('#errorBanner')).toContainText('cancels a query');
});
