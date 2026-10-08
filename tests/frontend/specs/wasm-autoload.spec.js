import { test, expect } from '@playwright/test';

// The WebAssembly kernels load on their own (docs/wasm.md, "When a kernel loads"). The other wasm-*.spec.js
// files call loadGroup() themselves, so they cannot see a page that never asks for its kernel: the v2.17.0
// candidate asked only after `ns.wasm` existed, and `ns.wasm` comes with the first kernel group, so the Query
// page never fetched one. These tests only use the page, the way a person does, and watch the network.

const wasmRequests = (page) => {
  const seen = [];
  page.on('request', (request) => {
    const match = /\/([a-z]+)\.wasm(\?|$)/.exec(request.url());
    if (match) seen.push(match[1]);
  });
  return seen;
};

const longSql = () => `SELECT ${Array.from({ length: 400 }, (_, i) => `col${i} + 1 AS c${i}`).join(', ')} FROM system.one`;

test('Query: a long SQL text loads the highlight kernel without any help from the test', async ({ page }) => {
  const seen = wasmRequests(page);
  await page.goto('/query');
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(longSql());
  await expect.poll(() => seen, { timeout: 8000 }).toContain('highlight');
});

test('Query: the editor diagnostics load the sqlscan kernel while a person types', async ({ page }) => {
  const seen = wasmRequests(page);
  await page.goto('/query');
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.type('SELECT 1, name FROM system.tables LIMIT 5');
  await expect.poll(() => seen, { timeout: 8000 }).toContain('sqlscan');
});

test('Query: sorting a numeric result of 6000 rows loads the rowsort kernel', async ({ page }) => {
  const seen = wasmRequests(page);
  await page.goto('/query');
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('SELECT number AS n FROM numbers(6000)');
  await page.keyboard.press('Control+Enter');
  const header = page.locator('th.is-sortable').first();
  await expect(header).toBeVisible({ timeout: 15000 });
  await header.click();
  await expect.poll(() => seen, { timeout: 8000 }).toContain('rowsort');
});

test('the Explorer graph loads the router, layered and labels kernels', async ({ page }) => {
  const seen = wasmRequests(page);
  await page.goto('/explorer/catalog');
  await expect.poll(() => seen, { timeout: 15000 }).toEqual(expect.arrayContaining(['layered', 'router', 'labels']));
});

test('a blocked kernel never breaks the page: the Query page still highlights and sorts', async ({ page }) => {
  await page.route(/\.wasm(\?|$)/, (route) => route.abort());
  await page.goto('/query');
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(longSql());
  await page.waitForTimeout(800);
  await expect(editor).toHaveValue(/SELECT col0 \+ 1 AS c0/);
  await expect(page.locator('body')).toBeVisible();
});
