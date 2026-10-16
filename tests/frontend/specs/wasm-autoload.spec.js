import { test, expect } from '@playwright/test';
import { runSuccessfulQuery } from '../helpers/app.js';

// The WebAssembly kernels load on their own (docs/wasm.md, "When a kernel loads").
// The other wasm-*.spec.js files call loadGroup() themselves. So they cannot see
// a page that never asks for its kernel. The v2.17.0 candidate asked only after
// `ns.wasm` existed. The object `ns.wasm` comes with the first kernel group. So
// the Query page never fetched a kernel. These tests use only the page, as a
// person does, and watch the network.

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
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const blocked = [];
  await page.route(/\.wasm(\?|$)/, (route) => {
    blocked.push(/\/([a-z]+)\.wasm/.exec(route.request().url())?.[1]);
    return route.abort();
  });
  await page.goto('/query');
  const editor = page.locator('#queryTextArea');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(longSql());
  // The page asked for the highlight kernel because the text is long. The request was refused.
  // The JavaScript lexer coloured the text. Keywords and numbers carry their token classes.
  await expect.poll(() => blocked, { timeout: 8000 }).toContain('highlight');
  const overlay = page.locator('.editorHighlight');
  await expect(overlay.locator('.tok-kw').first()).toHaveText('SELECT');
  await expect(overlay.locator('.tok-num').first()).toBeVisible();
  await expect(editor).toHaveValue(/SELECT col0 \+ 1 AS c0/);
  // A numeric result of 6000 rows sorts on the JavaScript path. The largest value comes first.
  await runSuccessfulQuery(page, 'SELECT number AS n FROM numbers(6000)');
  await expect.poll(() => blocked, { timeout: 8000 }).toContain('rowsort');
  const header = page.locator('#resultTableHead th[data-sort-key="0"]');
  await header.locator('.dataTable__sort').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('#resultTableBody tr[data-row-key]').first().locator('td').nth(1)).toHaveText('5999');
  await header.locator('.dataTable__sort').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('#resultTableBody tr[data-row-key]').first().locator('td').nth(1)).toHaveText('0');
  expect(pageErrors).toEqual([]);
});
