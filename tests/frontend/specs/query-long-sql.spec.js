import { test, expect } from '@playwright/test';

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
