import { test, expect } from '@playwright/test';
import { fuzzScripts } from '../helpers/wasm-sql.js';

// A long query must not freeze the Query editor. The v2.17.0 candidate spent 1 s on a 500-line query and 14 s on a
// 2000-line one in topLevelDepthAt (app_autocomplete.js), which counted the parentheses from the start of the text
// for every character: O(n^2). The depth is now one prefix table per text. These tests paste long texts into the
// editor and read the longest main-thread task (PerformanceObserver "longtask", a task over 50 ms).

const LINES = (n) => `SELECT\n${Array.from({ length: n }, (_, i) => `  col_${i} + ${i} AS c_${i},`).join('\n')}\n  1 AS last\nFROM system.one`;
const ARRAY = (n) => `SELECT [${Array.from({ length: n }, (_, i) => `'str_${i}_${(i * 7919).toString(36)}'`).join(', ')}] AS a`;

// The longest task, in milliseconds, after the text is inserted and again after one more keystroke.
async function longestTask(page, text) {
  return page.evaluate(async (value) => {
    const longest = [];
    const observer = new PerformanceObserver((list) => list.getEntries().forEach((entry) => longest.push(entry.duration)));
    observer.observe({ entryTypes: ['longtask'] });
    const editor = document.querySelector('textarea');
    editor.focus();
    editor.value = value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    editor.value += ' ';
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    observer.disconnect();
    return Math.round(Math.max(0, ...longest));
  }, text);
}

const BUDGET_MS = 700;

for (const [label, text] of [
  ['a 1000-line query', LINES(1000)],
  ['an array of 1000 different strings on one line', ARRAY(1000)],
]) {
  test(`Query: ${label} does not freeze the editor`, async ({ page }) => {
    test.setTimeout(60000);
    await page.goto('/query');
    await expect(page.locator('textarea').first()).toBeVisible();
    await page.waitForTimeout(1000);
    const cold = await longestTask(page, text);
    expect(cold, `longest task on the first paste: ${cold} ms`).toBeLessThan(BUDGET_MS);
    const warm = await longestTask(page, text.replace('SELECT', 'SELECT '));
    expect(warm, `longest task on the second paste: ${warm} ms`).toBeLessThan(BUDGET_MS);
  });
}

// The token at the cursor was read with /[A-Za-z0-9_.$`"]+$/ on all the text before the cursor: the
// engine tried every start, so a long literal before the cursor (a 40 KB unhex('...')) cost seconds
// on each key, click or arrow (ARCH-F-069). It is read backward from the cursor now.
test('Query: the token at the cursor costs its own length, not the length of the text before it', async ({ page }) => {
  await page.goto('/query');
  await expect(page.locator('textarea').first()).toBeVisible();
  const out = await page.evaluate(() => {
    const ac = window.ChDash.autocomplete;
    const long = `SELECT unhex('${'ab'.repeat(100000)}') `;
    const t0 = performance.now();
    const token = ac.tokenAtCursor({ value: long, selectionStart: long.length });
    const ms = performance.now() - t0;
    const inside = ac.tokenAtCursor({ value: long, selectionStart: long.length - 3 });
    const qualified = ac.tokenAtCursor({ value: 'SELECT db.tab', selectionStart: 13 });
    const middle = ac.tokenAtCursor({ value: 'SELECT abc', selectionStart: 8 });
    const quoted = ac.tokenAtCursor({ value: 'SELECT `my col`.x', selectionStart: 17 });
    return {
      ms,
      raw: token.raw,
      inside: inside.raw.length,
      qualified: [qualified.raw, qualified.qualifier, qualified.prefix, qualified.start, qualified.replaceStart],
      middle: middle.inMiddleOfIdentifier,
      quoted: [quoted.raw, quoted.start],
    };
  });
  expect(out.raw).toBe('');
  expect(out.inside).toBe(200000);
  expect(out.qualified).toEqual(['db.tab', 'db', 'tab', 7, 10]);
  expect(out.middle).toBe(true);
  expect(out.quoted).toEqual(['col`.x', 11]);
  expect(out.ms).toBeLessThan(50);
});

// The diagnostics of the JavaScript reference are quadratic (docs/wasm.md). A long script restored in
// the editor was checked first by the reference, before the kernel came (ARCH-F-233): the page froze
// when it opened, and on each key when the kernel was blocked. The kernel loads with the editor now, a
// long script waits for it, and without the kernel a long script gets no marks.
const LONG_SCRIPT = fuzzScripts(9, 4000, 2, 0, { clean: true }).join(';\n').slice(0, 30000);

// Opens /query with `text` restored in the editor; records when the editor first reads "checked".
async function openWithDraft(page, text) {
  await page.addInitScript((value) => {
    try { sessionStorage.setItem('chdash.editor.draft.v2', value); } catch (_) { /* private mode */ }
    window.__firstCheckedAt = 0;
    new MutationObserver(() => {
      const editor = document.querySelector('#queryTextArea');
      if (!window.__firstCheckedAt && editor && editor.dataset.diagnostics === 'checked') window.__firstCheckedAt = Date.now();
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-diagnostics'] });
  }, text);
  await page.goto('/query');
  await expect(page.locator('textarea').first()).toBeVisible();
}

test('Query: a long script restored in the editor is checked by the kernel, never first by the quadratic reference', async ({ page }) => {
  test.setTimeout(60000);
  expect(LONG_SCRIPT.length).toBe(30000);
  // The kernel arrives two seconds late: the long script must wait for it.
  let servedAt = 0;
  await page.route('**/wasm/sqlscan.wasm*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    servedAt = Date.now();
    await route.continue();
  });
  await openWithDraft(page, LONG_SCRIPT);
  const editor = page.locator('#queryTextArea');
  await expect(editor).toHaveValue(LONG_SCRIPT);
  await expect(editor).toHaveAttribute('data-diagnostics', 'checked', { timeout: 20000 });
  const checkedAt = await page.evaluate(() => window.__firstCheckedAt);
  expect(servedAt).toBeGreaterThan(0);
  expect(checkedAt, 'the first marks came before the kernel: the reference checked the long script').toBeGreaterThanOrEqual(servedAt);
});

test('Query: without the kernel a long script gets no marks instead of seconds of the reference', async ({ page }) => {
  test.setTimeout(60000);
  await page.route('**/wasm/sqlscan.wasm*', (route) => route.abort());
  await openWithDraft(page, LONG_SCRIPT);
  const editor = page.locator('#queryTextArea');
  await expect(editor).toHaveAttribute('data-diagnostics', 'unavailable', { timeout: 20000 });
  expect(await page.evaluate(() => window.__firstCheckedAt)).toBe(0);
  // A short script still gets the marks of the reference.
  await editor.fill('SELECT nofn(1) FROM system.one');
  await expect(editor).toHaveAttribute('data-diagnostics', 'checked', { timeout: 10000 });
});
