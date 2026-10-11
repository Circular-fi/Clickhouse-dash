import { test, expect } from '@playwright/test';
import { SYNTHETIC_TRACES, mockTraceResults } from '../helpers/traces.js';

// A page at rest does no work. Two things used to keep every page busy with no one touching it
// (7 to 20 % of a core in Chrome's Performance Monitor, against about 1 % for a static page):
//  - the healthy host dot's endless box-shadow animation, repainted on the main thread 60 times a
//    second (now a ring moved by the compositor, three times, then still);
//  - the hosts stream, once a second, rewriting the host picker's and the Run button's text with
//    the very same text (a new text node each time: style and layout again, every second).
// The counts below are Blink's own (CDP Performance.getMetrics) over a window with no input. Layout and style counts
// catch work that touches the DOM; ScriptDuration and TaskDuration (seconds of the main thread) catch work that does
// not: an interval that computes, a loop in a promise chain. A page at rest spends a few milliseconds a second.

const PAGES = [
  '/query',
  '/explorer/catalog',
  '/observability/traces',
  '/observability/logs',
  '/observability/metrics',
  '/system',
  '/system/queries',
  '/system/disks',
  '/explorer/functions',
];

// The main thread at rest over the 5 s window: seconds of script and of every task. About 1 % of a core is 0.05 s; the
// budgets are about ten times what a page spends (a few milliseconds: the figures print on each run).
const SCRIPT_BUDGET_S = 0.03;
const TASK_BUDGET_S = 0.3;

// A window of 5 s with no input on the page at `path`, once the page has loaded and its pulses have ended.
async function restingWindow(page, path) {
  // The page has loaded what it shows (a second of the hosts stream at least has arrived): the dot pulses from then on.
  await expect(page.locator('#versionBadge')).not.toHaveText('--', { timeout: 20_000 });
  // The dot's three pulses (5.4 s) end; then nothing is animated.
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(2500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  // The ping of the host picker really changes from time to time (the hosts stream measures it): each change rebuilds
  // the picker, which costs a layout. A rewrite with the very same text is not a change.
  await page.evaluate(() => {
    const ping = document.getElementById('hostPickerPing');
    window.__pingChanges = 0;
    let last = ping ? ping.textContent : '';
    if (ping) new MutationObserver(() => { if (ping.textContent !== last) { last = ping.textContent; window.__pingChanges += 1; } }).observe(ping, { childList: true, characterData: true, subtree: true });
  });
  const before = await read();
  await page.waitForTimeout(5000);
  const after = await read();
  const pings = await page.evaluate(() => window.__pingChanges);
  const spent = {
    pings,
    layouts: after.LayoutCount - before.LayoutCount,
    recalcs: after.RecalcStyleCount - before.RecalcStyleCount,
    script: after.ScriptDuration - before.ScriptDuration,
    task: after.TaskDuration - before.TaskDuration,
  };
  console.log(`${path} at rest, 5 s (${spent.pings} ping changes): ${spent.layouts} layouts, ${spent.recalcs} recalcs, ${spent.script.toFixed(3)} s script, ${spent.task.toFixed(3)} s tasks`);
  return spent;
}

function expectAtRest(spent, path) {
  // Five seconds: the hosts stream ticks five times. A tick that changes nothing changes nothing; a new ping costs one
  // layout and one style recalculation (the picker and its menu), and one more is left for the page's own.
  const allowed = 1 + spent.pings;
  expect(spent.layouts, `layouts in 5 s at rest on ${path}`).toBeLessThanOrEqual(allowed);
  expect(spent.recalcs, `style recalculations in 5 s at rest on ${path}`).toBeLessThanOrEqual(allowed);
  expect(spent.script, `seconds of script in 5 s at rest on ${path}`).toBeLessThanOrEqual(SCRIPT_BUDGET_S);
  expect(spent.task, `seconds of tasks in 5 s at rest on ${path}`).toBeLessThanOrEqual(TASK_BUDGET_S);
}

for (const path of PAGES) {
  test(`${path} at rest: no running animation, no layout, no style recalculation, no script`, async ({ page }) => {
    await page.goto(path);
    expectAtRest(await restingWindow(page, path), path);
  });
}

test('the MCP page at rest: the same', async ({ page, request }) => {
  const features = (await (await request.get('/api/version')).json()).features || {};
  test.skip(!features.mcp?.enabled, 'MCP is off on this instance');
  await page.goto('/mcp-integration');
  expectAtRest(await restingWindow(page, '/mcp-integration'), '/mcp-integration');
});

test('a trace page at rest: the same', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto(`/observability/traces/${SYNTHETIC_TRACES[0].trace_id}`);
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
  expectAtRest(await restingWindow(page, 'a trace'), 'a trace');
});

// The page of one query shape, reached the way a person does: the first row of the activity table.
test('a query shape page at rest: the same', async ({ page }) => {
  await page.goto('/system/queries?sort=calls');
  const rows = page.locator('#systemQueriesTable tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await rows.first().click();
  await expect(page).toHaveURL(/\/system\/queries\/\d+/, { timeout: 20_000 });
  expectAtRest(await restingWindow(page, 'a shape'), 'a shape');
});

// The loader keeps no handler on a script that has run: a page held two JS event listeners per
// loaded file (56 to 78 of the 200 odd it showed in Performance Monitor).
for (const path of ['/query', '/observability/traces', '/system']) {
  test(`${path}: the shell leaves no onload or onerror on the script it inserted`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('#versionBadge')).not.toHaveText('--', { timeout: 20_000 });
    const left = await page.evaluate(() => [...document.scripts].filter((el) => el.src && (el.onload || el.onerror)).map((el) => el.src));
    expect(left).toEqual([]);
    // One module script, the entry of the page: the modules under it are its imports.
    expect(await page.evaluate(() => [...document.scripts].filter((el) => el.src && el.type === 'module').length)).toBe(1);
  });
}
