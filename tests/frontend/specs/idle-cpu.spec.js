import { test, expect } from '@playwright/test';
import { SYNTHETIC_TRACES, mockTraceResults } from '../helpers/traces.js';
import { requireInstance } from '../helpers/instances.js';

// A page at rest does no work. Two things kept every page busy with no input from the user.
// Each thing used 7 to 20 % of a core in Chrome's Performance Monitor. A static page uses about 1 %.
//
//  - The endless box-shadow animation of the healthy host dot. It repainted on the main thread 60 times a second. It is now a ring that the compositor moves three times. Then the ring stays still.
//
//  - The hosts stream. Once a second, it rewrites the text of the host picker and of the Run button with the same text. Each rewrite makes a new text node, so style and layout run again, every second.
//
// The counts below are from Blink itself (CDP Performance.getMetrics). They cover a window with no input.
// The layout and style counts find work that touches the DOM.
// ScriptDuration and TaskDuration give seconds of the main thread.
// They find work that does not touch the DOM.
// Examples are an interval that computes, or a loop in a promise chain.
// A page at rest spends a few milliseconds each second.

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

// The main thread at rest, over the 5 s window: seconds of script and seconds of every task.
// The budgets are about ten times what a page spends. About 1 % of a core is 0.05 s.
// A page spends a few milliseconds. The figures print on each run.
const SCRIPT_BUDGET_S = 0.03;
const TASK_BUDGET_S = 0.3;

// A window of 5 s with no input on the page at `path`. The window starts after the page has loaded and its pulses have ended.
async function restingWindow(page, path) {
  // The page has loaded what it shows. At least one second of the hosts stream has arrived. The dot pulses from then on.
  await expect(page.locator('#versionBadge')).not.toHaveText('--', { timeout: 20_000 });
  // The three pulses of the dot (5.4 s) end. After that, nothing is animated.
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), { timeout: 20_000 }).toBe(0);
  await page.waitForTimeout(2500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  // The ping of the host picker changes from time to time. The hosts stream measures it.
  // Each change rebuilds the picker, and a rebuild costs a layout.
  // A rewrite with the same text is not a change.
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
  // Five seconds: the hosts stream ticks five times. A tick that changes nothing has no cost.
  // A new ping costs one layout and one style recalculation, for the picker and its menu.
  // One more layout and one more recalculation are allowed for the page itself.
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

// The MCP pages need a server with MCP on. Use the instance of mcp-contract.spec.js.
// The Usage tab has six charts with their legends, a filter bar and its chips. It has no table.
// No part of it runs on a timer, so it rests as the other pages do.
for (const path of ['/mcp-integration', '/mcp-integration/usage']) {
  test(`the MCP page ${path} at rest: the same`, async ({ page }) => {
    const base = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');
    requireInstance(test, 'MCP_CONTRACT_BASE_URL', base);
    await page.goto(`${base}${path}`);
    if (path.endsWith('/usage')) await expect(page.locator('.mcpOverview__tiles .statTile').first()).toBeVisible({ timeout: 20_000 });
    expectAtRest(await restingWindow(page, path), path);
  });
}

// The Usage tab with data to draw: first, make the usage.
// Use the key of the config file that reads everything (tests/config/mcp.hcl). The charts are then canvases with legends, not empty cards.
// Then, set the legends to their Values mode. Each chart then shows a table that scrolls inside its card.
// Set a filter, too. Six canvases, six tables and a chip then rest as the other pages do: no timer, no animation and no layout.
test('the MCP Usage tab at rest with its charts drawn, their legends as tables and a filter: the same', async ({ page, request }) => {
  const base = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');
  requireInstance(test, 'MCP_CONTRACT_BASE_URL', base);
  const post = (data) => request.post(`${base}/mcp`, {
    headers: { Authorization: 'Bearer a11da7a0-0000-4000-8000-000000000001', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data,
  });
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'idle-cpu', version: '1.0' } } });
  await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_hosts', arguments: {} } });
  await post({ jsonrpc: '2.0', id: 3, method: 'nothing/known' });
  await page.goto(`${base}/mcp-integration/usage`);
  const requests = page.locator('.mcpOverview__chart[data-chart="requests"]');
  await expect(requests.locator('.chartCore')).toBeVisible({ timeout: 20_000 });
  await requests.locator('.chartCore__legendMode').click();
  await expect(page.locator('.mcpOverview__chart .chartCore__legendTable').first()).toBeVisible();
  // Set a filter with the first legend entry of the table. This entry is a button that the keyboard can reach. The page then reads the data again.
  await requests.locator('.chartCore__legendTable .chartCore__legendItem').first().click();
  await expect(page.locator('.mcpOverview__chips .chip')).toHaveCount(1);
  await expect(page.locator('.mcpOverview__body')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.mcpOverview__tiles .statTile').first()).toBeVisible();
  expectAtRest(await restingWindow(page, '/mcp-integration/usage (tables, a filter)'), '/mcp-integration/usage (tables, a filter)');
});

test('a trace page at rest: the same', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto(`/observability/traces/${SYNTHETIC_TRACES[0].trace_id}`);
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
  expectAtRest(await restingWindow(page, 'a trace'), 'a trace');
});

// The page of one query shape. Open it as a person does: click the first row of the activity table.
test('a query shape page at rest: the same', async ({ page }) => {
  await page.goto('/system/queries?sort=calls');
  const rows = page.locator('#systemQueriesTable tbody tr');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await rows.first().click();
  await expect(page).toHaveURL(/\/system\/queries\/\d+/, { timeout: 20_000 });
  expectAtRest(await restingWindow(page, 'a shape'), 'a shape');
});

// The loader keeps no handler on a script that has run.
// Before this change, a page held two JS event listeners for each loaded file. That was 56 to 78 of about 200 listeners in Performance Monitor.
for (const path of ['/query', '/observability/traces', '/system']) {
  test(`${path}: the shell leaves no onload or onerror on the script it inserted`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('#versionBadge')).not.toHaveText('--', { timeout: 20_000 });
    const left = await page.evaluate(() => [...document.scripts].filter((el) => el.src && (el.onload || el.onerror)).map((el) => el.src));
    expect(left).toEqual([]);
    // One module script exists. It is the entry of the page. The modules under it are its imports.
    expect(await page.evaluate(() => [...document.scripts].filter((el) => el.src && el.type === 'module').length)).toBe(1);
  });
}
