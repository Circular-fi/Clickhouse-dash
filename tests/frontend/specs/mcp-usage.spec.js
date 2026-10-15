import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';
import { chartJson } from '../helpers/charts.js';
import { fetchedModules } from '../helpers/modules.js';
import { CELLS, META, cell, geometry, install, newServer, oneInstance, overviewOf, setUsage } from '../helpers/mcp-fake.js';

// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"): what every key did,
// cut by key, method, client, instance, result and type. The server side is the in-memory server of helpers/mcp-fake.js, which computes the
// answers of GET /api/mcp/usage/overview from a small list of cells by the rules of the contract (the windows and their steps, the facets, the
// series with five figures and `rest`, the filters and the refusals are real), so the page is tested against behaviour and not against one
// frozen answer. mcp-contract.spec.js compares that answer with the real one.
// The cells of the fake: 1,101 requests in the last 7 days (889 tool calls, 11 errors, 3 refused), 622 of them in the last hour, four keys of
// five (one deleted), ten methods, six results, five clients, two instances (chdash-0 wrote 918 of the requests, chdash-1 183); the last
// answer is at 2026-10-14T10:00:00Z, so "2 min ago" reads the same whatever the clock. The windows are the server's: 1 h by the minute, 6 h
// by 5 minutes, 24 h by 15 minutes, 7 d by 3 hours, 30 d by 12 hours, 90 d (and 365 d) by the UTC day. The usage has the three states of the
// server: on with two instances (the default), on with one (`oneInstance`) and off (`setUsage`: the tab says "Usage is off" and asks for
// nothing but the meta).

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.consoleErrors.filter((entry) => !/Failed to load resource/.test(entry.text))).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/mcp-usage`;

// The page at its address (with its query string), against the fake server; the tiles are there when it has read the usage.
async function open(page, query = '', server = newServer()) {
  await install(page, server);
  await page.goto(`/mcp-integration/usage${query}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  return server;
}

// The page has drawn the answer of its last read: nothing is busy any more (a read sets it at once, in the handler of the click that asked it).
const settled = (page) => expect(page.locator('.mcpOverview__body')).not.toHaveAttribute('aria-busy', 'true');
// The query strings of the reads of the overview, in the order they were made.
const reads = (server) => server.calls.filter((call) => call.path === '/usage/overview').map((call) => call.query);
const chips = (page) => page.locator('.mcpOverview__chips .chip');
const chipLabels = (page) => chips(page).locator('.chip__remove').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
const tile = (page, label) => page.locator('.mcpOverview__tiles .statTile', { has: page.locator('.statTile__label', { hasText: new RegExp(`^${label}$`) }) });
// Label -> [value, sub line] of every tile.
const tiles = (page) => page.locator('.mcpOverview__tiles .statTile').evaluateAll((els) => Object.fromEntries(els.map((el) => [
  el.querySelector('.statTile__label').textContent, [el.querySelector('.statTile__value').textContent, el.querySelector('.statTile__sub')?.textContent || ''],
])));
const dataRows = (page, dimension) => page.locator(`tr[data-dimension="${dimension}"]`);
const picked = (page, dimension) => dataRows(page, dimension).evaluateAll((rows) => rows.map((row) => row.dataset.value));
const row = (page, dimension, value) => page.locator(`tr[data-dimension="${dimension}"][data-value="${value}"]`);
const block = (page, id) => page.locator(`.mcpOverview__block:has(#mcpOverviewTitle-${id})`);
// The four charts: a card for each (its title, its step), the box of its chart, its legend.
const CHARTS = ['requests', 'errors', 'time', 'bytes'];
const card = (page, id) => page.locator(`.mcpOverview__card[data-card="${id}"]`);
const chartBox = (page, id = 'requests') => page.locator(`.mcpOverview__chart[data-chart="${id}"]`);
const legend = (page, id = 'requests') => chartBox(page, id).locator('.chartCore__legendItem');
const legendIds = (page, id = 'requests') => legend(page, id).evaluateAll((items) => items.map((item) => item.dataset.series));
const entry = (page, series, id = 'requests') => chartBox(page, id).locator(`.chartCore__legendItem[data-series="${series}"]`);
const swatch = (page, series, id = 'requests') => entry(page, series, id).locator('i').evaluate((el) => getComputedStyle(el).backgroundColor);
const titles = (page) => Promise.all(CHARTS.map((id) => card(page, id).locator('.chartCard__title').textContent()));
// The height of each of the four cards: the same for all of them, whatever they hold (a chart, a legend that scrolls, an empty chart, an empty window).
const cardHeights = (page) => page.locator('.mcpOverview__card').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
// Two lists of measures (px) are the same one within half a pixel, entry by entry: the pairs that differ are in the message of the failure.
const expectNear = (actual, expected, message) => {
  expect(actual, message).toHaveLength(expected.length);
  expect(actual.map((value, i) => [value, expected[i]]).filter(([a, b]) => !(Math.abs(a - b) <= 0.5)), message).toEqual([]);
};
// Where the parts of the page stand, for the cases that say that nothing moves: the tops of the tiles, of the cards and of the tables counted from
// the head of the tab (so that the scroll of the panel does not count), their heights, and the chips row and the panel from the top of the
// window (they are out of what scrolls). `busy` says whether a read was running when the measures were taken (all are taken in one go).
const layout = (page) => page.evaluate(() => {
  const box = (el) => el.getBoundingClientRect();
  const origin = box(document.querySelector('.mcpOverview__head')).top;
  const tops = (selector) => [...document.querySelectorAll(selector)].map((el) => box(el).top - origin);
  const heights = (selector) => [...document.querySelectorAll(selector)].map((el) => box(el).height);
  const chipsRow = box(document.querySelector('.mcpOverview__filters'));
  const tables = document.querySelector('.mcpOverview__tables');
  const blocks = [...tables.querySelectorAll('.mcpOverview__block')];
  // The first table of each column never moves (the one under it follows the length of the one above): one column under 1280 px, two from there.
  const firsts = getComputedStyle(tables).gridTemplateColumns.split(' ').length === 2 ? [blocks[0], blocks[2]] : [blocks[0]];
  return {
    busy: document.querySelector('.mcpOverview__body').getAttribute('aria-busy') === 'true',
    stands: {
      'the chips row': [chipsRow.top, chipsRow.height],
      'the panel': [box(document.querySelector('#mcpPanel')).top],
      'the tiles': tops('.mcpOverview__tiles .statTile'),
      'the height of the tiles': heights('.mcpOverview__tiles .statTile'),
      'the cards': tops('.mcpOverview__card'),
      'the height of the cards': heights('.mcpOverview__card'),
      'the tables': [box(tables).top - origin, ...firsts.map((el) => box(el).top - origin)],
    },
  };
});
// What of `now` is not what `base` says, by more than half a pixel, as sentences ([] when nothing moved).
const moved = (base, now) => Object.entries(base).flatMap(([name, values]) => values
  .map((value, i) => [`${name}[${i}]`, value, now[name]?.[i]])
  .filter(([, before, after]) => !(Math.abs(before - after) <= 0.5))
  .map(([label, before, after]) => `${label}: ${before.toFixed(1)} -> ${Number(after).toFixed(1)}`));
// The bar: Group by, the four lists (key, method, client, instance), the window, Refresh.
const groupButton = (page) => page.locator('#mcpGroupButton');
const groupOption = (page, value) => page.locator(`.mcpBar__groupPicker .tracePicker__option[data-value="${value}"]`);
const pickGroup = async (page, value) => {
  await groupButton(page).click();
  await groupOption(page, value).click();
};
const pickerButton = (page, dimension) => page.locator(`#mcpPickerButton-${dimension}`);
const pickerMenu = (page, dimension) => page.locator(`#mcpPickerMenu-${dimension}`);
const openPicker = async (page, dimension) => {
  await pickerButton(page, dimension).click();
  await expect(pickerMenu(page, dimension)).toBeVisible();
  return pickerMenu(page, dimension);
};
const pressedWindow = (page) => page.locator('.mcpBar__windows [aria-pressed="true"]');
const windowButton = (page, name) => page.locator('.mcpBar__windows').getByRole('button', { name });

async function screenshot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: false });
}

// The x range that a chart drew (data-x-min, data-x-max), in ms.
const xRange = async (page, id = 'requests') => {
  const root = chartBox(page, id).locator('.chartCore');
  return [Number(await root.getAttribute('data-x-min')), Number(await root.getAttribute('data-x-max'))];
};

test('the Usage page is a page of its own, and the row of links joins it to the Keys page', async ({ page }) => {
  await open(page);
  // The same body as the keys page (the host picker stays hidden), its own shell, stylesheet, entry and modules, one heading.
  await expect(page.locator('body')).toHaveAttribute('data-page', 'mcp');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('MCP usage');
  await expect(page).toHaveTitle(/MCP usage/);
  const state = await page.evaluate(() => ({
    page: window.ChDash.loader.page.name,
    sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0]),
  }));
  state.scripts = await fetchedModules(page);
  expect(state.page).toBe('mcpusage');
  expect(state.sheets).toEqual(['style.mcpusage.css']);
  // The bar is the shared filter bar (app_ui_filterbar.js) and the charts the shared engine; the instances (the "2 instances" note and the
  // warnings, app_mcp_instances.js) are a module of the page; the pages of other families are not loaded.
  for (const name of ['app_page_mcpusage.js', 'app_mcp_overview.js', 'app_mcp_bar.js', 'app_mcp_charts.js', 'app_mcp_instances.js', 'app_mcp_view.js', 'app_ui_filterbar.js', 'app_chart_core.js', 'app_api.js']) expect(state.scripts, name).toContain(name);
  for (const name of ['app_page_mcp.js', 'app_mcp_form.js', 'app_mcp_usage.js', 'app_ui_dialog.js', 'app_logs.js', 'app_system_view.js', 'app_explorer.js']) expect(state.scripts, name).not.toContain(name);
  expect(new Set(state.scripts).size).toBe(state.scripts.length);
  await expect(page.locator('#hostPicker')).toBeHidden();
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#pageSelectButton')).toHaveText('MCP');
  // The row: Keys and Usage, links to the two pages, Usage the current one (the only one).
  const tabs = page.locator('#mcpTabs a.contentTabs__tab');
  await expect(tabs).toHaveText(['Keys', 'Usage']);
  expect(await tabs.evaluateAll((els) => els.map((el) => new URL(el.href).pathname))).toEqual(['/mcp-integration', '/mcp-integration/usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Usage');
  await expect(page.locator('#mcpTab-usage')).toHaveClass(/is-active/);
  await expect(page.locator('.mcpPage__nav')).toHaveAttribute('aria-label', 'MCP sections');
  // The row is the nav row of the page, as System's is: as tall as it, under the header; the filter bar is right under it, then the chips row
  // (always there, 35 px: with no filter it holds a hint), then the panel, which starts 35 px under the bar; the bar is not part of what a
  // drawer starts under (--shell-top).
  const stack = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      height: box('.mcpPage__nav').height,
      top: box('.mcpPage__nav').top - box('body > .appHeader').bottom,
      barTop: box('#mcpBar').top - box('.mcpPage__nav').bottom,
      // No filter, and the row is there all the same: right under the bar, 35 px high, and the panel starts under it.
      chipsTop: box('.mcpOverview__filters').top - box('#mcpBar').bottom,
      chipsHeight: box('.mcpOverview__filters').height,
      panelTop: box('#mcpPanel').top - box('#mcpBar').bottom,
      panelUnderChips: box('#mcpPanel').top - box('.mcpOverview__filters').bottom,
      // --shell-top (app_dom.js) is the bottom of the header and of the nav row: what a drawer or a panel starts under.
      shellTop: parseFloat(document.documentElement.style.getPropertyValue('--shell-top')) - box('.mcpPage__nav').bottom,
      // The bar, its chips and the panel are siblings of the row, in the page: the panel is the one scroller. The chips row was a sibling
      // already when it was hidden with no filter: the DOM has not changed, the row is shown now.
      siblings: [...document.querySelector('#mcpPage').children].filter((el) => el.tagName !== 'SCRIPT').map((el) => (el.matches('.mcpOverview__filters') ? 'chips' : el.id || el.className.split(' ')[0])),
    };
  });
  expect(Math.round(stack.height)).toBe(40);
  expect(Math.abs(stack.top)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.barTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.chipsTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.chipsHeight - 35)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.panelTop - 35)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.panelUnderChips)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(stack.shellTop)).toBeLessThanOrEqual(1);
  expect(stack.siblings).toEqual(['mcpPage__nav', 'mcpBar', 'chips', 'mcpPanel']);
  // With no filter the row says so: a hint, no chip, no "Clear filters".
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toHaveText('No filters. Pick a value in a list, a legend or a table.');
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeHidden();
  // The link of the row opens the Keys page, which has the same row with Keys current, and back.
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  await expect(page.locator('#mcpTabs a.contentTabs__tab')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Keys');
  await expect(page.locator('#mcpTab-keys')).toHaveClass(/is-active/);
  await expect(page.locator('#mcpTab-usage')).not.toHaveClass(/is-active/);
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  // The Keys page has the instances module too (the "Summed over N instances" notes and the warnings of its table), and not the charts.
  const keysModules = await fetchedModules(page);
  expect(keysModules).toContain('app_mcp_instances.js');
  expect(keysModules).not.toContain('app_mcp_overview.js');
  await page.locator('#mcpTab-usage').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
});

test('the filter bar: Group by and a list for each of key, method, client and instance at the left, the window and Refresh at the right', async ({ page }) => {
  await open(page);
  // The bar of Observability and System: its lead has the pickers, its tail the window and the action.
  const bar = page.locator('#mcpBar');
  await expect(bar).toHaveClass(/obsFilterBar/);
  // Five controls in the lead: Group by, then a list for each of the four dimensions that have one.
  expect(await bar.locator('.obsFilterBar__lead .tracePicker__button').evaluateAll((els) => els.map((el) => el.textContent))).toEqual(['Group by · Method', 'Key · All', 'Method · All', 'Client · All', 'Instance · All']);
  await expect(bar.locator('.obsFilterBar__tail .mcpBar__windows')).toBeVisible();
  await expect(bar.locator('.obsFilterBar__tail #mcpRefresh')).toBeVisible();
  await expect(page.locator('#mcpRefresh')).toHaveAttribute('aria-label', 'Refresh the usage');
  await expect(page.locator('#mcpRefresh')).toHaveAttribute('type', 'submit');
  // Left to right: Group by and the four lists, the window, Refresh; one row from 1101 px (the widths are measured in the case of the sideways scroll).
  const xs = await bar.locator('.tracePicker__button, .mcpBar__windows, #mcpRefresh').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(await bar.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBeLessThanOrEqual(52);
  // Group by is one choice among three (a list of its own, the instance is not one of them); the four others are check boxes in a dialog.
  await groupButton(page).click();
  await expect(page.locator('.mcpBar__groupPicker .tracePicker__option')).toHaveText(['Key', 'Method', 'Client']);
  await expect(groupOption(page, 'method')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.mcpBar__groupPicker [role="listbox"]')).toHaveAttribute('aria-label', 'Group by');
  await page.keyboard.press('Escape');
  for (const dimension of ['key', 'method', 'client', 'instance']) {
    await expect(pickerButton(page, dimension)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(pickerButton(page, dimension)).toHaveAttribute('aria-controls', `mcpPickerMenu-${dimension}`);
    await expect(pickerMenu(page, dimension)).toHaveAttribute('role', 'dialog');
    await expect(pickerMenu(page, dimension)).toBeHidden();
  }
  // The window is a group of toggle buttons named Window, one pressed.
  await expect(page.locator('.mcpBar__windows')).toHaveAttribute('aria-label', 'Window');
  await expect(page.locator('.mcpBar__windows [aria-pressed="true"]')).toHaveCount(1);
  await screenshot(page, 'usage-bar');
});

test('the last 7 days: the totals as tiles, the four charts over time, a table for each dimension, read once', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toEqual(['?window=7d&group=method']);
  expect(server.calls.filter((call) => call.path === '/meta')).toHaveLength(1);
  await expect(page.locator('#mcpOverviewTitle')).toHaveText('Usage of all keys');
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 7 12:00 → Oct 14 10:00');
  // The windows that the retention keeps, finest first; the default one is pressed.
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d', '30 d', '90 d']);
  await expect(pressedWindow(page)).toHaveText('7 d');
  expect(await tiles(page)).toEqual({
    Requests: ['1,101', 'in the last 7 days'],
    'Tool calls': ['889', '80.7% of the requests'],
    Errors: ['11', '1% of read requests'],
    Refused: ['3', '2 by the rate limit'],
    'Call time': ['17 ms', 'max 900 ms'],
    Returned: ['1.2 MB', '5,247 rows'],
    // Three of the five keys that exist have requests, and so has a deleted one, told apart.
    'Active keys': ['3', 'of 5 keys · 1 deleted'],
  });
  // Errors and refusals have a colour; the title of a tile says what it counts (the short line of Errors is whole in it).
  await expect(tile(page, 'Errors')).toHaveClass(/is-warn/);
  await expect(tile(page, 'Refused')).toHaveClass(/is-warn/);
  await expect(tile(page, 'Requests')).not.toHaveClass(/is-warn|is-error/);
  await expect(tile(page, 'Refused')).toHaveAttribute('title', /429: more requests than mcp\.rate_limit_per_minute/);
  await expect(tile(page, 'Errors')).toHaveAttribute('title', /^Tool calls that ended with an error code, and requests of the protocol that failed \(a JSON-RPC error\)\. 1% of the requests that were read: a request that was refused before its message was read is left out\.$/);
  // Four charts over the 56 steps of 3 hours of the window, grouped by method: the requests, the errors, the call time, the bytes returned.
  expect(await titles(page)).toEqual(['Requests by method', 'Errors by method', 'Call time by method', 'Returned by method']);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta')).toHaveText('by 3 hours');
  for (const [id, type, name] of [['requests', 'bar', 'Requests'], ['errors', 'bar', 'Errors'], ['time', 'line', 'Call time'], ['bytes', 'bar', 'Returned']]) {
    await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('data-type', type);
    await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('aria-label', `${name} by method over time`);
  }
  const { from, points, stepMs } = geometry('7d');
  expect(await xRange(page)).toEqual([from, from + points * stepMs]);
  // The same 8 biggest groups and "2 more" in the four legends, each with its own figure: the requests; the errors; the average time of the
  // calls over the window (the time of the calls over their number: a protocol method has no call, so no time); the bytes returned.
  const groups = ['method:query_table', 'method:ping', 'method:list_hosts', 'method:tools/list', 'method:run_query', 'method:describe_table', 'method:initialize', 'method:notifications/initialized', '~rest'];
  const names = ['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', '2 more'];
  for (const id of CHARTS) {
    expect(await legendIds(page, id), id).toEqual(groups);
    await expect(legend(page, id).locator('span'), id).toHaveText(names);
  }
  await expect(legend(page, 'requests').locator('b')).toHaveText(['754', '100', '75', '65', '35', '25', '23', '20', '4']);
  await expect(legend(page, 'errors').locator('b')).toHaveText(['5', '0', '0', '0', '5', '0', '0', '0', '1']);
  await expect(legend(page, 'time').locator('b')).toHaveText(['14.9 ms', '—', '4 ms', '—', '107 ms', '10 ms', '—', '—', '—']);
  await expect(legend(page, 'bytes').locator('b')).toHaveText(['732.9 KB', '3.9 KB', '43.9 KB', '312.5 KB', '90.3 KB', '48.8 KB', '9.0 KB', '0 B', '470 B']);
  // The four tables, each in the order of its default sort.
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_legacy000000', 'ui_0a1b2c3d4e5f']);
  expect(await picked(page, 'method')).toEqual(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', 'unread', 'other']);
  expect(await picked(page, 'result')).toEqual(['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', '413_payload_too_large', 'rpc_error_32601']);
  expect(await picked(page, 'client')).toEqual(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  // By key: the name and a badge on the deleted key; the figures of the key, its share of the calls, the errors with their share.
  const keys = block(page, 'keys');
  await expect(keys.locator('thead th')).toHaveText(['Key', 'Requests', 'Calls', 'Errors', '429', 'Avg time', 'Returned', 'Last used']);
  await expect(row(page, 'key', 'ui_dead00000001').locator('.badge')).toHaveText('deleted');
  await expect(row(page, 'key', 'ops-all').locator('td')).toHaveText(['1,012', '812', '7 0.69%', '0', '18 ms', '1.1 MB', '2 min ago']);
  await expect(row(page, 'key', 'ui_legacy000000').locator('td').nth(3)).toHaveText('2');
  await expect(row(page, 'key', 'ui_legacy000000').locator('td').nth(3).locator('.mcpWarn')).toHaveText('2');
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f').locator('th')).toHaveText('ci-bot');
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f').locator('td').nth(6)).toHaveText('21 h ago');
  await expect(row(page, 'key', 'ops-all').locator('.shareBar__fill')).toHaveCount(1);
  // By method: a tool in code, a method of the protocol muted with a badge, the words that stand for a group of messages explained.
  const methods = block(page, 'methods');
  await expect(methods.locator('thead th')).toHaveText(['Method', 'Requests', 'Errors', 'Avg time', 'Max', 'Returned', 'Keys']);
  await expect(row(page, 'method', 'query_table').locator('th code')).toHaveText('query_table');
  await expect(row(page, 'method', 'ping').locator('th .badge')).toHaveText('protocol');
  await expect(row(page, 'method', 'ping').locator('th code')).toHaveCount(0);
  await expect(row(page, 'method', 'unread').locator('th .badge')).toHaveText('refused');
  await expect(row(page, 'method', 'unread').locator('th .mcpOverview__name')).toHaveAttribute('title', /^unread\nRefused before the message was read: the rate limit \(429\)/);
  await expect(row(page, 'method', 'other').locator('th .mcpOverview__name')).toHaveAttribute('title', /^other\nA method that is not in the vocabulary/);
  await expect(row(page, 'method', 'query_table').locator('td')).toHaveText(['754', '5', '15 ms', '380 ms', '732.9 KB', '3']);
  // The server counts whole milliseconds: 0 is a time under a millisecond.
  await expect(row(page, 'method', 'unread').locator('td').nth(2)).toHaveText('<1 ms');
  // By result: `ok` plain, the others in the warning colour, the count with its share of all.
  await expect(row(page, 'result', 'ok').locator('th code')).not.toHaveClass(/mcpWarn/);
  await expect(row(page, 'result', 'sql_error').locator('th code')).toHaveClass(/mcpWarn/);
  await expect(row(page, 'result', 'ok').locator('td')).toHaveText(['1,087', '4']);
  // By client: its name, its versions (the latest first) muted after it, its requests, its errors with their share, its time, its keys, when
  // it was last seen; the two names that ClickHouse Dash gives (unknown, other) are muted and say what they stand for.
  const clients = block(page, 'clients');
  await expect(clients.locator('thead th')).toHaveText(['Client', 'Requests', 'Errors', 'Avg time', 'Keys', 'Last seen']);
  await expect(clients.locator('tbody th')).toHaveText(['claude-code 2.1.3, 2.0.9', 'mcp-inspector 0.14.0', 'unknown', 'python-httpx 0.27.0', 'Visual Studio Code 1.95.0']);
  await expect(row(page, 'client', 'claude-code').locator('td')).toHaveText(['894', '10 1.12%', '19 ms', '2', '16 min ago']);
  await expect(row(page, 'client', 'claude-code').locator('th strong')).toHaveText('claude-code');
  await expect(row(page, 'client', 'claude-code').locator('.mcpOverview__versions')).toHaveText('2.1.3, 2.0.9');
  await expect(row(page, 'client', 'claude-code').locator('.mcpOverview__name')).toHaveAttribute('title', 'claude-code\nVersions: 2.1.3, 2.0.9');
  await expect(row(page, 'client', 'unknown').locator('th strong')).toHaveCount(0);
  await expect(row(page, 'client', 'unknown').locator('.mcpMuted')).toHaveText('unknown');
  await expect(row(page, 'client', 'unknown').locator('td')).toHaveText(['41', '0', '15 ms', '1', '—']);
  await expect(row(page, 'client', 'unknown').locator('.mcpOverview__name')).toHaveAttribute('title', 'unknown\nThe client sent no name in initialize and no User-Agent');
  // How a client is named; the old words (counted since it was first seen, no window) are gone.
  await expect(block(page, 'clients')).toContainText('A client is named as it says in initialize (clientInfo), else by the product of its User-Agent');
  await expect(block(page, 'clients')).not.toContainText('first seen');
  await expect(page.locator('.mcpOverview__notes')).toContainText('an API tool counts no row.');
  // A row of any of the four tables is a row of the keyboard that picks its value.
  for (const dimension of ['key', 'method', 'result', 'client']) await expect(dataRows(page, dimension).first()).toHaveAttribute('tabindex', '0');
  await screenshot(page, 'usage-default');
});

// The Active keys tile counts keys of one kind: the keys that exist. The server counts a deleted key that was used with the others
// (totals.active_keys), so the page counts from the rows of the table of keys and tells the deleted ones apart ("· 1 deleted").
test('Active keys: the keys that exist and have requests, out of the keys that exist, and the deleted key that was used, told apart', async ({ page }) => {
  // Five keys exist; ops-all, ci-bot and legacy have requests in the last 7 days, and so has the deleted old-bot: the server says 4 active.
  const server = newServer();
  await open(page, '', server);
  expect(overviewOf(server, new URLSearchParams()).body.totals).toMatchObject({ active_keys: 4, keys: 5 });
  expect((await tiles(page))['Active keys']).toEqual(['3', 'of 5 keys · 1 deleted']);
  await expect(tile(page, 'Active keys')).toHaveAttribute('title', /^The keys that exist and have a request that every filter of the page keeps, out of the keys that exist\. A deleted key keeps its usage: one that had such a request is counted apart \("1 deleted"\), not in the two figures\.$/);
  // In the last 24 hours the deleted key did nothing: nothing is told apart, and the line is the plain ratio.
  await windowButton(page, '24 h').click();
  await expect(tile(page, 'Requests').locator('.statTile__sub')).toHaveText('in the last 24 hours');
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['3', 'of 5 keys']);
});

test('Active keys: a deleted key does not stand in for a key that exists, so 4 of 5 keys and 1 deleted is not "5 of 5 keys"', async ({ page }) => {
  // A fourth key that exists, reporting, has requests too: with the deleted old-bot the server counts 5 active keys, as many as exist.
  const reporting = cell('ui_111111111111', '2026-10-13T09:00', 'call', 'claude-code', 'list_hosts', 'ok', 4, 8, 3, 0, 900);
  const server = newServer({ cells: [...CELLS(), reporting] });
  await open(page, '', server);
  expect(overviewOf(server, new URLSearchParams()).body.totals).toMatchObject({ active_keys: 5, keys: 5 });
  expect((await tiles(page))['Active keys']).toEqual(['4', 'of 5 keys · 1 deleted']);
});

test('Active keys follow the filters: the key filter cuts the rows of the table of keys, and a deleted key that is picked is told apart', async ({ page }) => {
  await open(page);
  // The table of keys has every filter but the key filter, so it lists all the keys with requests; the tile counts the picked one only.
  await row(page, 'key', 'ops-all').click();
  await settled(page);
  await expect(chips(page)).toHaveCount(1);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys']);
  // The deleted key picked as well is not one of the keys that exist.
  await row(page, 'key', 'ui_dead00000001').click();
  await expect(chips(page)).toHaveCount(2);
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys · 1 deleted']);
  // It alone: no key that exists is active.
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['0', 'of 5 keys · 1 deleted']);
  // The other filters count too: of the keys that have the result `sql_error`, one exists (ops-all) and no deleted one is among them.
  await chips(page).first().locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await row(page, 'result', 'sql_error').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys']);
});

test('Active keys: when the server cut the table of keys, the rows cannot be counted: the tile says the total of the server and what it counts', async ({ page }) => {
  const cut = (server, params) => {
    const answer = overviewOf(server, params);
    answer.body.omitted.keys = 2;
    return answer;
  };
  await open(page, '', newServer({ overview: cut }));
  // The 4 of the server are the three keys that exist and the deleted one: there is no ratio and no "deleted" to say.
  expect((await tiles(page))['Active keys']).toEqual(['4', 'keys with requests']);
  await expect(tile(page, 'Active keys')).toHaveAttribute('title', /^The keys, the deleted ones too, with a request that has every filter of the page\. There are too many keys to tell the deleted ones apart\.$/);
});

// A tile is 9 rem wide at least (from 1100 px, when seven share the line), which leaves 122 px for its sub line: a line that is longer is cut
// with an ellipsis. The longest figures that come: the share of the read requests, a flood of the rate limit, a call of 12 min 30 s, millions of
// rows, twelve keys of which three are deleted.
test('the sub lines of the tiles fit the tile, down to the narrowest (seven on a line at 1100 px): none is cut with an ellipsis', async ({ page }) => {
  const longest = (server, params) => {
    const answer = overviewOf(server, params);
    const { totals, keys } = answer.body;
    Object.assign(totals, { requests: 987654, calls: 986000, errors: 120000, rate_limited: 12345, rejected: 100, duration_ms_max: 750000, rows: 12345678, keys: 12 });
    const gone = keys.find((item) => item.deleted_at);
    keys.push({ ...gone, id: 'ui_dead00000002', name: 'old-bot-2' }, { ...gone, id: 'ui_dead00000003', name: 'old-bot-3' });
    return answer;
  };
  await open(page, '', newServer({ overview: longest }));
  expect(await tiles(page)).toMatchObject({
    Requests: ['987,654', 'in the last 7 days'],
    'Tool calls': ['986,000', '99.8% of the requests'],
    Errors: ['120,000', '12.3% of read requests'],
    Refused: ['12,445', '12,345 by the rate limit'],
    'Call time': ['17 ms', 'max 12 min 30 s'],
    Returned: [expect.any(String), '12,345,678 rows'],
    'Active keys': ['3', 'of 12 keys · 3 deleted'],
  });
  await page.evaluate(() => document.fonts.ready);
  for (const width of [390, 820, 1100, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const cut = await page.locator('.mcpOverview__tiles .statTile').evaluateAll((els) => els.flatMap((el) => [...el.children]
      .filter((part) => part.scrollWidth > part.clientWidth)
      .map((part) => `${el.firstElementChild.textContent}: "${part.textContent}" needs ${part.scrollWidth} px of ${part.clientWidth}`)));
    expect(cut, `${width} px`).toEqual([]);
  }
  // Errors says the short form on the line and the sentence in its title.
  await expect(tile(page, 'Errors').locator('.statTile__sub')).toHaveText('12.3% of read requests');
  await expect(tile(page, 'Errors')).toHaveAttribute('title', /12\.3% of the requests that were read: a request that was refused before its message was read is left out\.$/);
});

test('Group by: key, method or client groups the four charts the same way, and the choice is in the address', async ({ page }) => {
  const server = await open(page);
  // The three groups that the bar offers; a pick that changes nothing reads nothing.
  await groupButton(page).click();
  await expect(page.locator('.mcpBar__groupPicker .tracePicker__option')).toHaveText(['Key', 'Method', 'Client']);
  await groupOption(page, 'method').click();
  await expect(groupButton(page)).toHaveText('Group by · Method');
  expect(reads(server)).toHaveLength(1);
  // By client: the clients, in the four charts, with their requests, errors, average time and bytes.
  await pickGroup(page, 'client');
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=client$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=client');
  expect(await titles(page)).toEqual(['Requests by client', 'Errors by client', 'Call time by client', 'Returned by client']);
  const clients = ['client:claude-code', 'client:mcp-inspector', 'client:unknown', 'client:python-httpx', 'client:Visual Studio Code'];
  for (const id of CHARTS) {
    expect(await legendIds(page, id), id).toEqual(clients);
    await expect(legend(page, id).locator('span'), id).toHaveText(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  }
  await expect(legend(page, 'requests').locator('b')).toHaveText(['894', '130', '41', '28', '8']);
  await expect(legend(page, 'errors').locator('b')).toHaveText(['10', '0', '0', '1', '0']);
  // The time of the calls over their number: 18.9 ms for claude-code (the table, which the server rounds, says 19 ms).
  await expect(legend(page, 'time').locator('b')).toHaveText(['18.9 ms', '4 ms', '15 ms', '4 ms', '—']);
  await expect(chartBox(page, 'requests').locator('.chartCore')).toHaveAttribute('aria-label', 'Requests by client over time');
  await expect(entry(page, 'client:claude-code')).toHaveAttribute('title', 'Filter by client claude-code');
  // By key: the keys by their names, not their ids; a deleted key is a group like another.
  await pickGroup(page, 'key');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=key$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=key');
  expect(await titles(page)).toEqual(['Requests by key', 'Errors by key', 'Call time by key', 'Returned by key']);
  expect(await legendIds(page)).toEqual(['key:ops-all', 'key:ui_dead00000001', 'key:ui_legacy000000', 'key:ui_0a1b2c3d4e5f']);
  await expect(legend(page).locator('span')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(legend(page).locator('b')).toHaveText(['1K', '41', '28', '20']);
  // A legend is the filter of the group: an entry picks that client, a second press lets it go (a name with spaces stays one value).
  await pickGroup(page, 'client');
  await settled(page);
  await entry(page, 'client:Visual Studio Code', 'bytes').click();
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  expect(new URL(page.url()).searchParams.getAll('client')).toEqual(['Visual Studio Code']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=client&client=Visual+Studio+Code');
  expect(await legendIds(page)).toEqual(['client:Visual Studio Code']);
  await expect(clientRow(page, 'Visual Studio Code')).toHaveClass(/is-selected/);
  // Method again is the default, which the address does not say.
  await pickGroup(page, 'method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?client=Visual\+Studio\+Code$/);
});

// A row of the table of clients, whose value can have spaces.
const clientRow = (page, name) => page.locator(`tr[data-dimension="client"][data-value="${name}"]`);

test('the legends are the filter of the group: a pressed entry dims the others in the four charts at once, then the charts keep the groups that are picked', async ({ page }) => {
  const server = newServer();
  await open(page, '', server);
  // The entries read at full strength while nothing is picked (the text colour, no strike).
  const strength = (id) => legend(page, id).evaluateAll((items) => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--text)';
    const text = getComputedStyle(probe).color;
    probe.remove();
    return Object.fromEntries(items.map((item) => [item.dataset.series, getComputedStyle(item).color === text && !item.classList.contains('is-off') ? 'full' : 'dim']));
  });
  const real = (all) => Object.entries(all).filter(([id]) => id !== '~rest');
  for (const id of CHARTS) await expect.poll(async () => real(await strength(id)).every(([, state]) => state === 'full'), { message: id }).toBe(true);
  await expect(legend(page).first()).toHaveAttribute('title', 'Filter by method query_table');
  // A click presses the entry (here in the legend of the bytes), and the others dim in every chart before the answer comes.
  server.delay['GET /usage/overview'] = 700;
  await entry(page, 'method:ping', 'bytes').click();
  for (const id of CHARTS) {
    await expect(entry(page, 'method:ping', id)).toHaveAttribute('aria-pressed', 'true');
    await expect(entry(page, 'method:ping', id)).toHaveAttribute('title', 'Stop filtering by method ping');
  }
  for (const id of CHARTS) {
    await expect.poll(async () => {
      const all = await strength(id);
      return all['method:ping'] === 'full' && real(all).filter(([name]) => name !== 'method:ping').every(([, state]) => state === 'dim');
    }, { message: id }).toBe(true);
  }
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?method=ping$/);
  await expect(chips(page)).toHaveCount(1);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method&method=ping']);
  // The answer: the groups are the values that are picked, and every figure of the page has the filter. The calls of ping are protocol
  // requests: it has no error and no call, so those two charts say so; the other two keep their group.
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:ping']);
  expect(await legendIds(page, 'bytes')).toEqual(['method:ping']);
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'true');
  expect((await strength('requests'))['method:ping']).toBe('full');
  await expect(card(page, 'errors').locator('.uiState--empty .uiState__title')).toHaveText('No errors in this window');
  await expect(card(page, 'time').locator('.uiState--empty .uiState__title')).toHaveText('No tool calls in this window');
  await expect(chartBox(page, 'errors').locator('.chartCore')).toHaveCount(0);
  expect(await tiles(page)).toMatchObject({ Requests: ['100', 'in the last 7 days'], 'Tool calls': ['0', '0% of the requests'], 'Active keys': ['1', 'of 5 keys'] });
  // The keyboard stays on the entry that was pressed, and a second press lets it go.
  await expect(entry(page, 'method:ping', 'bytes')).toBeFocused();
  server.delay['GET /usage/overview'] = 0;
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(legend(page, 'bytes')).toHaveCount(9);
  await settled(page);
  await expect(entry(page, 'method:ping', 'bytes')).toHaveAttribute('aria-pressed', 'false');
  await expect(entry(page, 'method:ping', 'bytes')).toBeFocused();
  for (const id of CHARTS) expect(Object.values(await strength(id)).filter((state) => state === 'dim'), id).toEqual([]);
});

test('"N more" holds the groups that a chart folds together, in each of the four charts, and is not a filter', async ({ page }) => {
  const server = await open(page);
  for (const id of CHARTS) {
    const more = entry(page, '~rest', id);
    await expect(more).toBeDisabled();
    await expect(more).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(more).toHaveAttribute('title', '2 more methods that the chart folds together: pick them in the table');
  }
  await expect(entry(page, '~rest')).toHaveText('2 more4');
  // The folded groups are in the table, and a row filters by them.
  await row(page, 'method', 'unread').click();
  await expect(chips(page)).toHaveCount(1);
  expect(await chipLabels(page)).toEqual(['Remove filter Method = unread']);
  // The charts with the picked groups have no "N more".
  await expect(legend(page)).toHaveCount(1);
  expect(await legendIds(page)).toEqual(['method:unread']);
  expect(reads(server)).toHaveLength(2);
  // "N more" has the neutral colour, and no two groups of a chart share one.
  await row(page, 'method', 'unread').click();
  await expect(legend(page)).toHaveCount(9);
  const colours = await legend(page).locator('i').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(colours).size).toBe(9);
  expect(colours[8]).toBe(await page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--qchart-other)';
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }));
});

test('a group keeps its colour: it comes from its name, not from its rank, in every chart, window and group, and under every filter', async ({ page }) => {
  await open(page);
  const hosts = await swatch(page, 'method:list_hosts');
  expect((await legendIds(page)).indexOf('method:list_hosts')).toBe(2);
  // The four charts draw a group in one colour.
  for (const id of CHARTS) expect(await swatch(page, 'method:list_hosts', id), id).toBe(hosts);
  // The key of the legacy client: list_hosts is the first method of the chart there, with the same colour.
  await row(page, 'key', 'ui_legacy000000').click();
  await expect(legend(page)).toHaveCount(3);
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:list_hosts', 'method:unread', 'method:other']);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another window: the same.
  await windowButton(page, '24 h').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by 15 minutes');
  await settled(page);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another group has its own groups.
  await pickGroup(page, 'client');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by client');
  await settled(page);
  await expect(legend(page).locator('span')).toHaveText(['python-httpx']);
});

test('filters are chips: a legend entry, a list of the bar, a row and a chip add them, a chip removes one, "Clear filters" all of them', async ({ page }) => {
  const server = await open(page);
  // The row is there before any filter (the page never changes its height for one): a hint, no chip and no "Clear filters".
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  // A row of a table picks its value. The chips say it, the address keeps it, and the page reads again with the filter.
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await expect(page.locator('.mcpOverview__filtersHint')).toBeHidden();
  await expect(page.locator('.mcpOverview__chips')).toBeVisible();
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await expect(chips(page).first()).toHaveText('Key=ops-all');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&key=ops-all');
  // The chips sit right under the bar, out of the panel that scrolls.
  expect(await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return [box('.mcpOverview__filters').top - box('#mcpBar').bottom, box('#mcpPanel').top - box('.mcpOverview__filters').bottom].map((gap) => Math.abs(Math.round(gap)));
  })).toEqual([0, 0]);
  // One chip has no "Clear filters": removing it is as short.
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  // The picks go key, result, client, method: a table lists what else can be picked, and a dimension that has one value left is not offered
  // (its rows are plain lines), so each pick keeps two values or more in the table of the next one: ops-all has the results ok, sql_error and
  // table_not_allowed; with ok it has two clients; with one of them it has three methods.
  await row(page, 'result', 'ok').click();
  await settled(page);
  await row(page, 'client', 'mcp-inspector').click();
  await settled(page);
  await row(page, 'method', 'list_hosts').click();
  await expect(chips(page)).toHaveCount(4);
  await settled(page);
  // The chips follow the order of the dimensions (the address's), not the order of the picks.
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = list_hosts', 'Remove filter Client = mcp-inspector', 'Remove filter Result = ok']);
  await expect(page).toHaveURL(/\?key=ops-all&method=list_hosts&client=mcp-inspector&result=ok$/);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  // Every figure follows: 50 requests (list_hosts of ops-all, by mcp-inspector, 40 and 10), one key, and the lists of the bar say it.
  expect(await tiles(page)).toMatchObject({ Requests: ['50', 'in the last 7 days'], 'Active keys': ['1', 'of 5 keys'] });
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  await expect(pickerButton(page, 'method')).toHaveText('Method · list_hosts');
  await expect(pickerButton(page, 'client')).toHaveText('Client · mcp-inspector');
  // A table keeps the filters that are not its own: the clients of ops-all that called list_hosts with the result ok.
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['mcp-inspector 0.14.0']);
  // A chip goes with its x, and the keyboard moves on to the chip that takes its place.
  await chips(page).nth(1).locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(3);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Client = mcp-inspector', 'Remove filter Result = ok']);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(2);
  await settled(page);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  // "Clear filters" takes all of them away at once: the group stays.
  await pickGroup(page, 'client');
  await settled(page);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips(page)).toHaveCount(0);
  // The row stays (35 px, the hint back in it): it does not go with the filters.
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=client$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=client');
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(pressedWindow(page)).toBeFocused();
});

// The type of a request has no list and no table: a link can carry it, and the chip names it and removes it.
test('a type that the address asks for is a chip with its name for the reader, and the chip lets it go', async ({ page }) => {
  const server = await open(page, '?type=call&type=request');
  expect(await chipLabels(page)).toEqual(['Remove filter Type = Tool calls', 'Remove filter Type = Protocol']);
  await expect(chips(page).first()).toHaveAttribute('title', 'Tool calls: A call of a tool (tools/call)');
  await expect(chips(page).last()).toHaveAttribute('title', /^Protocol: A request of the MCP protocol/);
  // Every figure has it: the tool calls and the protocol requests, not the refused ones (2 by the rate limit, 1 rejected).
  expect(await tiles(page)).toMatchObject({ Requests: ['1,098', 'in the last 7 days'], Refused: ['0', '0 by the rate limit'] });
  expect(reads(server)).toEqual(['?window=7d&group=method&type=call&type=request']);
  await chips(page).first().locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&type=request');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?type=request$/);
});

test('a table lists its alternatives: it has every filter but its own, and a value that is picked stays in it', async ({ page }) => {
  await open(page, '?key=ui_0a1b2c3d4e5f&method=query_table&result=table_not_allowed');
  // The tiles have the three filters: 3 requests (query_table of ci-bot that ended with table_not_allowed).
  expect(await tiles(page)).toMatchObject({ Requests: ['3', 'in the last 7 days'], Errors: ['3', '100% of read requests'], 'Active keys': ['1', 'of 5 keys'] });
  await expect(tile(page, 'Errors')).toHaveClass(/is-error/);
  // By key has the method and the result, not the key: every key that has them, the picked key marked.
  expect(await picked(page, 'key')).toEqual(['ui_0a1b2c3d4e5f', 'ops-all']);
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f')).toHaveClass(/is-selected/);
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'key', 'ops-all')).not.toHaveClass(/is-selected/);
  await expect(row(page, 'key', 'ops-all')).toHaveAttribute('aria-selected', 'false');
  // By method has the key and the result: the methods of ci-bot that ended with table_not_allowed.
  expect(await picked(page, 'method')).toEqual(['query_table']);
  // By result has the key and the method: ok, and what the picked result says.
  expect(await picked(page, 'result')).toEqual(['ok', 'table_not_allowed']);
  await expect(row(page, 'result', 'table_not_allowed')).toHaveClass(/is-selected/);
  // By client has the key, the method and the result, not the client: the one that made those calls.
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['claude-code 2.1.3']);
  // The lists of the bar are the same facets: the other keys that have the method and the result, the one client.
  const keyMenu = await openPicker(page, 'key');
  await expect(keyMenu.locator('.mcpPicker__name')).toHaveText(['ci-bot', 'ops-all']);
  await expect(keyMenu.locator('.mcpPicker__count')).toHaveText(['3', '2']);
  await page.keyboard.press('Escape');
  // A picked value that nothing matches (a key that was never used) is in its table at 0, marked, with the name of the key on its chip.
  await page.goto('/mcp-integration/usage?key=ui_111111111111');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  // The window has no request with this filter: the Requests card says so (the four cards stay, see "an empty window").
  await expect(card(page, 'requests').locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_legacy000000', 'ui_0a1b2c3d4e5f', 'ui_111111111111']);
  await expect(row(page, 'key', 'ui_111111111111').locator('td').first()).toHaveText('0');
  await expect(row(page, 'key', 'ui_111111111111')).toHaveClass(/is-selected/);
  await expect(chips(page).first()).toHaveText('Key=reporting');
  await expect(pickerButton(page, 'key')).toHaveText('Key · reporting');
  // A method that nobody called (a made-up name in the address) has its row, with no time; it is a tool until the server says more.
  await page.goto('/mcp-integration/usage?method=nothing');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect((await picked(page, 'method')).at(-1)).toBe('nothing');
  await expect(row(page, 'method', 'nothing')).toHaveClass(/is-selected/);
  await expect(row(page, 'method', 'nothing').locator('th code')).toHaveText('nothing');
  await expect(row(page, 'method', 'nothing').locator('td')).toHaveText(['0', '0', '—', '—', '0 B', '0']);
  // Nothing has the method: the keys say so, and the Requests card says that no request has all the filters.
  await expect(block(page, 'keys').locator('.mcpOverview__none')).toHaveText('No key sent a request in this view.');
  await expect(card(page, 'requests').locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  expect(await legendIds(page)).toEqual([]);
  // A client that nobody made is in its table at 0 too, with no version and no sight.
  await page.goto('/mcp-integration/usage?client=nobody');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(clientRow(page, 'nobody')).toHaveClass(/is-selected/);
  await expect(clientRow(page, 'nobody').locator('td')).toHaveText(['0', '0', '—', '0', '—']);
  await expect(clientRow(page, 'nobody').locator('.mcpOverview__versions')).toHaveCount(0);
  await expect(pickerButton(page, 'client')).toHaveText('Client · nobody');
});

test('a row filters by a click and by the keyboard, and the keyboard stays on the row after the page read again', async ({ page }) => {
  const server = await open(page);
  // A row of the clients, whose value is a name with spaces: Down and Enter pick it, Space lets it go, and the keyboard stays on it.
  await clientRow(page, 'claude-code').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(clientRow(page, 'Visual Studio Code')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Client = Visual Studio Code']);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&client=Visual+Studio+Code');
  await expect(clientRow(page, 'Visual Studio Code')).toHaveClass(/is-selected/);
  await expect(clientRow(page, 'Visual Studio Code')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await expect(clientRow(page, 'Visual Studio Code')).toBeFocused();
  // The same for a row of the keys.
  const first = row(page, 'key', 'ops-all');
  await expect(first).toHaveAttribute('tabindex', '0');
  await expect(row(page, 'key', 'ui_dead00000001')).toHaveAttribute('tabindex', '-1');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'key', 'ui_dead00000001')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = old-bot']);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&key=ui_dead00000001');
  // The tables are drawn again for the answer: the row has its marks, and the keyboard is on it still.
  await expect(row(page, 'key', 'ui_dead00000001')).toHaveClass(/is-selected/);
  await expect(row(page, 'key', 'ui_dead00000001')).toBeFocused();
  // Space lets the filter go.
  await page.keyboard.press('Space');
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await expect(row(page, 'key', 'ui_dead00000001')).toBeFocused();
  await expect(row(page, 'key', 'ui_dead00000001')).not.toHaveClass(/is-selected/);
  // A click on the badge or on a cell is a click on the row.
  await row(page, 'key', 'ui_dead00000001').locator('.badge').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  // The table of clients has the key filter: the one client of the deleted key. One value is nothing to choose from, so its row is a line to
  // read and not a filter (no value, no tabindex: see "a dimension that has one value is not offered").
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['unknown']);
  expect(await picked(page, 'client')).toEqual([]);
});

test('the tables sort by their headers, and the sort stays while the filters change', async ({ page }) => {
  const server = await open(page);
  const header = (id, label) => block(page, id).locator('thead th', { hasText: new RegExp(`^${label}$`) });
  // Sorted by requests, the most first, as the header says.
  await expect(header('keys', 'Requests')).toHaveAttribute('aria-sort', 'descending');
  await expect(header('keys', 'Key')).toHaveAttribute('aria-sort', 'none');
  // A word column sorts from A; the same header again reverses it.
  await header('keys', 'Key').getByRole('button').click();
  await expect(header('keys', 'Key')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header('keys', 'Requests')).toHaveAttribute('aria-sort', 'none');
  expect(await picked(page, 'key')).toEqual(['ui_0a1b2c3d4e5f', 'ui_legacy000000', 'ui_dead00000001', 'ops-all']);
  await expect(header('keys', 'Key').getByRole('button')).toBeFocused();
  await header('keys', 'Key').getByRole('button').click();
  await expect(header('keys', 'Key')).toHaveAttribute('aria-sort', 'descending');
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_legacy000000', 'ui_0a1b2c3d4e5f']);
  // A column of figures sorts from the most.
  await header('keys', 'Avg time').getByRole('button').click();
  await expect(header('keys', 'Avg time')).toHaveAttribute('aria-sort', 'descending');
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_0a1b2c3d4e5f', 'ui_legacy000000']);
  await header('keys', 'Avg time').getByRole('button').click();
  await expect(header('keys', 'Avg time')).toHaveAttribute('aria-sort', 'ascending');
  expect(await picked(page, 'key')).toEqual(['ui_legacy000000', 'ui_0a1b2c3d4e5f', 'ui_dead00000001', 'ops-all']);
  // The other tables sort on their own.
  await header('methods', 'Keys').getByRole('button').click();
  expect((await picked(page, 'method')).slice(0, 2)).toEqual(['query_table', 'list_hosts']);
  await header('results', 'Result').getByRole('button').click();
  expect(await picked(page, 'result')).toEqual(['413_payload_too_large', '429_rate_limited', 'ok', 'rpc_error_32601', 'sql_error', 'table_not_allowed']);
  // The clients start by requests; a name sorts without its case, a time from the slowest, the last sight from the latest.
  await expect(header('clients', 'Requests')).toHaveAttribute('aria-sort', 'descending');
  await header('clients', 'Client').getByRole('button').click();
  expect(await picked(page, 'client')).toEqual(['claude-code', 'mcp-inspector', 'python-httpx', 'unknown', 'Visual Studio Code']);
  await header('clients', 'Avg time').getByRole('button').click();
  expect(await picked(page, 'client')).toEqual(['claude-code', 'unknown', 'mcp-inspector', 'python-httpx', 'Visual Studio Code']);
  await header('clients', 'Last seen').getByRole('button').click();
  expect(await picked(page, 'client')).toEqual(['mcp-inspector', 'claude-code', 'python-httpx', 'Visual Studio Code', 'unknown']);
  // Sorting is not a read, and not an address: it stays for the visit, whatever the filters do.
  expect(reads(server)).toHaveLength(1);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await row(page, 'result', 'ok').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  // The keys that have the result, by their time as the sort says: a tie keeps the order of the answer.
  expect(await picked(page, 'key')).toEqual(['ui_legacy000000', 'ui_dead00000001', 'ui_0a1b2c3d4e5f', 'ops-all']);
  await expect(header('keys', 'Avg time')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header('clients', 'Last seen')).toHaveAttribute('aria-sort', 'descending');
});

test('a long table is a box of its own: the rows scroll under the head, and the page stays short', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 60; i += 1) server.cells.push(cell(`bulk-${String(i).padStart(2, '0')}`, '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100));
  await open(page, '', server);
  await expect(dataRows(page, 'key')).toHaveCount(64);
  await expect(block(page, 'keys').locator('.pagePart__count')).toHaveText('64');
  const wrap = block(page, 'keys').locator('.dataTableWrap');
  const box = await wrap.evaluate((el) => ({ shown: el.clientHeight, content: el.scrollHeight, most: parseFloat(getComputedStyle(el).maxHeight) }));
  expect(box.most).toBeGreaterThan(300);
  expect(box.shown).toBeLessThanOrEqual(box.most + 2);
  expect(box.content).toBeGreaterThan(box.shown * 2);
  // The head stays over the rows while they scroll.
  await wrap.evaluate((el) => { el.scrollTop = 400; });
  const head = await wrap.evaluate((el) => el.querySelector('thead th').getBoundingClientRect().top - el.getBoundingClientRect().top);
  expect(Math.abs(head)).toBeLessThanOrEqual(2);
  // The keyboard reaches a row that is far down, and the box brings it into view.
  await dataRows(page, 'key').last().focus();
  const inside = await wrap.evaluate((el) => {
    const last = el.querySelector('tbody tr:last-child').getBoundingClientRect();
    const frame = el.getBoundingClientRect();
    return last.top >= frame.top - 1 && last.bottom <= frame.bottom + 1;
  });
  expect(inside).toBe(true);
  // Another table of the page is not pushed out of reach: the methods are on the first screens (four charts of 300 px stand above them).
  const reach = await block(page, 'methods').evaluate((el) => el.getBoundingClientRect().top);
  expect(reach).toBeLessThan(2200);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, 'usage-long');
});

// A table keeps 200 rows; a value that is picked is never cut, and the line under the table says how many rows it left out.
test('a facet of more than 200 values is cut by the server: the line under its table says so, and a picked value stays', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 210; i += 1) server.cells.push(cell(`bulk-${String(i).padStart(3, '0')}`, '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100));
  await open(page, '', server);
  // 214 keys have requests; the 200 with the most are listed, and the line says that 14 are not.
  await expect(dataRows(page, 'key')).toHaveCount(200);
  await expect(block(page, 'keys').locator('.mcpNote--fine').first()).toHaveText('14 more keys not shown.');
  await expect(block(page, 'keys').locator('.pagePart__count')).toHaveText('200');
  // The smallest of them is picked in the address: it is listed as a 201st row, and the 13 others that were cut stay cut.
  await page.goto('/mcp-integration/usage?key=bulk-000');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(dataRows(page, 'key')).toHaveCount(201);
  await expect(row(page, 'key', 'bulk-000')).toHaveClass(/is-selected/);
  await expect(block(page, 'keys').locator('.mcpNote--fine').first()).toHaveText('13 more keys not shown.');
  // The list of the bar is cut as the table is, and its field narrows what is there.
  const menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(201);
  await expect(menu.locator('.mcpPicker__search')).toBeVisible();
});

test('the address is the state: window, group and filters are read on load and written by every change', async ({ page }) => {
  const server = await open(page, '?window=30d&group=key&key=ops-all&method=query_table&client=claude-code');
  // Read once, as the address says.
  expect(reads(server)).toEqual(['?window=30d&group=key&key=ops-all&method=query_table&client=claude-code']);
  await expect(pressedWindow(page)).toHaveText('30 d');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = query_table', 'Remove filter Client = claude-code']);
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  await expect(pickerButton(page, 'method')).toHaveText('Method · query_table');
  await expect(pickerButton(page, 'client')).toHaveText('Client · claude-code');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by key');
  await expect(row(page, 'key', 'ops-all')).toHaveClass(/is-selected/);
  await expect(row(page, 'method', 'query_table')).toHaveClass(/is-selected/);
  await expect(row(page, 'client', 'claude-code')).toHaveClass(/is-selected/);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  // Counted since the first start with the file: a window older than that says so.
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  // A reload keeps all of it.
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(reads(server).at(-1)).toBe('?window=30d&group=key&key=ops-all&method=query_table&client=claude-code');
  await expect(pressedWindow(page)).toHaveText('30 d');
  expect(await chipLabels(page)).toHaveLength(3);
  // A change writes the address (the defaults stay out of it).
  await windowButton(page, '7 d').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=key&key=ops-all&method=query_table&client=claude-code$/);
  await settled(page);
  await pickGroup(page, 'method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all&method=query_table&client=claude-code$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&key=ops-all&method=query_table&client=claude-code');
});

test('Back and Forward walk through the filters, the window and the group', async ({ page }) => {
  const server = await open(page);
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  await pickGroup(page, 'client');
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await settled(page);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&group=client&key=ops-all$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all$/);
  await expect(groupButton(page)).toHaveText('Group by · Method');
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&group=method&key=ops-all');
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by 15 minutes');
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(chips(page)).toHaveCount(0);
  await expect(pickerButton(page, 'key')).toHaveText('Key · All');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method');
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  // Forward comes back to each.
  await page.goForward();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&group=client&key=ops-all$/);
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by client');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&group=client&key=ops-all');
});

test('an address that the page cannot use is fixed at load: no window it does not keep, no group it does not offer, no value the server refuses', async ({ page }) => {
  // key=ui_zzzzzzzzzzzz has the shape of the id of a key made on the page, but its digits are not hexadecimal: the server answers 400 for it.
  // A client has no space at either end; `group=result` is a group of the API that the bar does not offer; `split` is the old name of the group.
  const server = await open(page, '?window=48h&split=nope&group=result&key=BAD!&key=ui_zzzzzzzzzzzz&key=ui_0a1b&method=a%20b&client=%20padded&client=ok-client&type=call&type=call&result=ok&unknown=1');
  // The values that are fine stay; the address is replaced, not pushed, and the page reads once, for the fixed state.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?client=ok-client&result=ok&type=call$/);
  expect(reads(server)).toEqual(['?window=7d&group=method&client=ok-client&result=ok&type=call']);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(groupButton(page)).toHaveText('Group by · Method');
  expect(await chipLabels(page)).toEqual(['Remove filter Client = ok-client', 'Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  // The entry was replaced, not pushed: the page has one entry of the history.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  // An address of the old page, with its split alone, is the page with no group: the split goes, nothing else is asked.
  const old = await open(page, '?split=result', newServer());
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  expect(reads(old)).toEqual(['?window=7d&group=method']);
  expect(old.calls.filter((call) => call.path === '/usage/overview').every((call) => !call.query.includes('split'))).toBe(true);
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by method');
  // A client may have spaces inside, a method may not.
  await page.goto('/mcp-integration/usage?client=Visual%20Studio%20Code&group=client');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await expect(groupButton(page)).toHaveText('Group by · Client');
  // An address that has nothing to fix is left as it was written.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?client=Visual%20Studio%20Code&group=client$/);
  // A kind of filter takes 20 values: the 20 first stay.
  const many = Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const other = newServer();
  await install(page, other);
  await page.goto(`/mcp-integration/usage?${many.map((name) => `method=${name}`).join('&')}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.getAll('method')).toEqual(many.slice(0, 20));
  expect(reads(other)).toEqual([`?window=7d&group=method&${many.slice(0, 20).map((name) => `method=${name}`).join('&')}`]);
  // A window that the retention does not keep is the default one (the meta lists the windows that it keeps).
  const short = newServer({ meta: { usage: { ...META.usage, retention_days: 7, windows: ['1h', '6h', '24h', '7d'], default_window: '24h' } } });
  await open(page, '?window=90d', short);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d']);
  await expect(pressedWindow(page)).toHaveText('24 h');
  expect(reads(short)).toEqual(['?window=24h&group=method']);
});

// The windows and their steps are the server's (mcp_usage.hpp): each is cut in steps of its own, and every chart has the same x axis.
const WINDOW_CASES = [
  ['1 h', '1h', 'in the last hour', 'by the minute', 'Oct 14 09:01 → 10:00', '622'],
  ['6 h', '6h', 'in the last 6 hours', 'by 5 minutes', 'Oct 14 04:05 → 10:00', '685'],
  ['24 h', '24h', 'in the last 24 hours', 'by 15 minutes', 'Oct 13 10:15 → Oct 14 10:00', '750'],
  ['7 d', '7d', 'in the last 7 days', 'by 3 hours', 'Oct 7 12:00 → Oct 14 10:00', '1,101'],
  ['30 d', '30d', 'in the last 30 days', 'by 12 hours', 'Oct 1 08:00 → Oct 14 10:00', '1,207'],
  ['90 d', '90d', 'in the last 90 days', 'by the UTC day', 'Oct 1 08:00 → Oct 14 10:00', '1,207'],
];

test('each window reads again, with its own step: 1 h by the minute, 6 h by 5 minutes, 24 h by 15 minutes, 7 d by 3 hours, 30 d by 12 hours, 90 d by the day', async ({ page }) => {
  const server = await open(page);
  for (const [label, window, sub, step, range, requests] of WINDOW_CASES) {
    await windowButton(page, label).click();
    await expect(pressedWindow(page)).toHaveText(label);
    await settled(page);
    expect(reads(server).at(-1), window).toBe(`?window=${window}&group=method`);
    await expect(page.locator('.mcpOverview__range'), window).toHaveText(range);
    expect((await tiles(page)).Requests, window).toEqual([requests, sub]);
    // The four charts say the step, and draw the window: as many steps as the server says, from its first to the end of its last.
    for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta'), `${window} ${id}`).toHaveText(step);
    const { from, points, stepMs } = geometry(window);
    for (const id of CHARTS) expect(await xRange(page, id), `${window} ${id}`).toEqual([from, from + points * stepMs]);
    expect(overviewOf(server, new URLSearchParams({ window })).body.series.t).toHaveLength(points);
    // The default window is not in the address.
    if (window === '7d') await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
    else await expect(page).toHaveURL(new RegExp(`/mcp-integration/usage\\?window=${window}$`));
  }
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  await screenshot(page, 'usage-90d');
});

test('365 d is a window when the retention keeps a year, by the day as 90 d is', async ({ page }) => {
  const meta = { usage: { ...META.usage, retention_days: 365, windows: ['1h', '6h', '24h', '7d', '30d', '90d', '365d'] } };
  const server = await open(page, '', newServer({ meta }));
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d', '30 d', '90 d', '365 d']);
  await windowButton(page, '365 d').click();
  await expect(pressedWindow(page)).toHaveText('365 d');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=365d&group=method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=365d$/);
  expect((await tiles(page)).Requests).toEqual(['1,207', 'in the last 365 days']);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta'), id).toHaveText('by the UTC day');
  const { from, points, stepMs } = geometry('365d');
  expect(points).toBe(365);
  expect(await xRange(page)).toEqual([from, from + points * stepMs]);
  // The 12 months of bars fit the plot (the engine keeps the tallest of the bars that share a few pixels).
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('hovering a bar reads its bucket: its range, the groups that have requests and the total; a day is its UTC date', async ({ page }) => {
  await open(page);
  const hover = async (ms, id = 'requests') => {
    const at = await page.evaluate(([t, chart]) => window.ChDash.chartCore.of(document.querySelector(`.mcpOverview__chart[data-chart="${chart}"]`)).toClient(t, 0), [ms, id]);
    // The middle of the plot, whatever the scale of the chart.
    const [, top, , height] = String(await chartBox(page, id).locator('.chartCore').getAttribute('data-plot')).split(' ').map(Number);
    const box = await chartBox(page, id).locator('.chartCore__overlay').boundingBox();
    await page.mouse.move(at.x, box.y + top + height / 2);
  };
  const tip = (id = 'requests') => chartBox(page, id).locator('.chartCore__tooltip');
  const rows = (id = 'requests') => tip(id).locator('.chartCore__tipRow:not(.chartCore__tipRow--total) em');
  const values = (id = 'requests') => tip(id).locator('.chartCore__tipRow:not(.chartCore__tipRow--total) b');
  // The last bucket of 3 hours (the last hour is in it): the groups with a request, the biggest first, then the total (the sum of the groups).
  await hover(Date.UTC(2026, 9, 14, 10, 30));
  await expect(tip()).toBeVisible();
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:00 → 12:00');
  await expect(rows()).toHaveText(['query_table', 'ping', 'tools/list', 'list_hosts', 'initialize']);
  await expect(values()).toHaveText(['402', '100', '60', '40', '20']);
  await expect(tip().locator('.chartCore__tipRow--total b')).toHaveText('622');
  // The bucket before: two groups and what the chart folds, "2 more".
  await hover(Date.UTC(2026, 9, 14, 7, 30));
  await expect(tip().locator('strong')).toHaveText('Oct 14 06:00 → 09:00');
  await expect(rows()).toHaveText(['run_query', 'list_hosts', '2 more']);
  await expect(values()).toHaveText(['35', '25', '3']);
  await expect(tip().locator('.chartCore__tipRow--total b')).toHaveText('63');
  // A bucket with nothing says so.
  await hover(Date.UTC(2026, 9, 10, 13, 30));
  await expect(tip().locator('.chartCore__tipRow em')).toHaveText(['No value']);
  // The other charts read the same bucket with their own figure: the errors, the average time of the calls (no row for a group that made no call),
  // the bytes.
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'errors');
  await expect(tip('errors').locator('strong')).toHaveText('Oct 14 09:00 → 12:00');
  await expect(rows('errors')).toHaveText(['query_table']);
  await expect(values('errors')).toHaveText(['2']);
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'time');
  await expect(rows('time')).toHaveText(['query_table', 'list_hosts']);
  await expect(values('time')).toHaveText(['14.9 ms', '4 ms']);
  await expect(tip('time').locator('.chartCore__tipRow--total')).toHaveCount(0);
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'bytes');
  await expect(rows('bytes')).toHaveText(['query_table', 'tools/list', 'list_hosts', 'initialize', 'ping']);
  await expect(values('bytes')).toHaveText(['391.2 KB', '293.0 KB', '23.4 KB', '7.8 KB', '3.9 KB']);
  // By the minute: the range of the minute, and nothing before the calls of the 31st.
  await windowButton(page, '1 h').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by the minute');
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 31, 30));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:31 → 09:32');
  await expect(rows()).toHaveText(['query_table']);
  await expect(values()).toHaveText(['402']);
  // By 5 minutes and by 15 minutes: the range of the step.
  await windowButton(page, '6 h').click();
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 32));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:30 → 09:35');
  await windowButton(page, '24 h').click();
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 40));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:30 → 09:45');
  // By the day: the UTC date, not the hours that the day starts at. The groups of the 90 days are not those of the week: "3 more".
  await windowButton(page, '90 d').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by the UTC day');
  await settled(page);
  await hover(Date.UTC(2026, 9, 12, 12));
  await expect(tip().locator('strong')).toHaveText('2026-10-12 (UTC)');
  await expect(rows()).toHaveText(['query_table', '3 more']);
  await expect(values()).toHaveText(['340', '1']);
  await screenshot(page, 'usage-hover');
});

// The axis of the shared engine puts a tick where its labels keep apart. A bar is a day from 90 d, so its labels are the dates (the option
// xDateOnly of the engine: one line, no date under them), the windows of 12 hours and 3 hours have ticks of days (the date, and the year under
// the first), and the windows of 15 minutes, 5 minutes and a minute keep their hours, with the date under the first label and under midnight.
test('a chart by the UTC day is labelled by its dates, never by hours; the charts of the finer steps are labelled by their days or their hours', async ({ page }) => {
  await open(page, '?window=90d');
  const root = chartBox(page).locator('.chartCore');
  // [label, date line] of each label drawn (data-x-ticks).
  const axis = async (id = 'requests') => (await chartJson(chartBox(page, id).locator('.chartCore'), 'data-x-ticks')).map(([label, context]) => [label, context]);
  const DATE = /^[A-Z][a-z]{2} \d{1,2}$/;
  const HOUR = /^\d\d:\d\d$/;
  // 90 days: dates, a week or a month apart where the days do not fit, and no hour; at every width and in every chart.
  for (const width of [1920, 1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of CHARTS) {
      await expect.poll(async () => (await axis(id)).length, { message: `${width} px ${id}` }).toBeGreaterThanOrEqual(3);
      expect((await axis(id)).filter(([label, context]) => !DATE.test(label) || context), `${width} px ${id}`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(root).toHaveAttribute('data-type', 'bar');
  // 12 hours and 3 hours: a tick for each day or each week, labelled by its date, the year under the first.
  for (const name of ['30 d', '7 d']) {
    await windowButton(page, name).click();
    await expect(pressedWindow(page)).toHaveText(name);
    await settled(page);
    await expect.poll(async () => (await axis()).length, { message: name }).toBeGreaterThanOrEqual(4);
    const ticks = await axis();
    expect(ticks.filter(([label]) => !DATE.test(label)), name).toEqual([]);
    expect(ticks.map(([, context]) => context).filter(Boolean), name).toEqual(['2026']);
  }
  // 15 minutes: hours, and the date under the first label and under midnight.
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  await expect.poll(async () => (await axis()).length, { message: '24 h' }).toBeGreaterThanOrEqual(6);
  let ticks = await axis();
  expect(ticks.filter(([label]) => !HOUR.test(label)), '24 h').toEqual([]);
  expect(ticks.map(([, context]) => context).filter(Boolean).map((context) => context.replace(/ \d{4}$/, '')), '24 h: the dates under the hours').toEqual(['Oct 13', 'Oct 14']);
  // 5 minutes and a minute: hours (and minutes) of the day, the date under the first label.
  for (const name of ['6 h', '1 h']) {
    await windowButton(page, name).click();
    await expect(pressedWindow(page)).toHaveText(name);
    await settled(page);
    await expect.poll(async () => (await axis()).length, { message: name }).toBeGreaterThanOrEqual(4);
    ticks = await axis();
    expect(ticks.filter(([label]) => !HOUR.test(label)), name).toEqual([]);
    expect(ticks.map(([, context]) => context).filter(Boolean).map((context) => context.replace(/ \d{4}$/, '')), `${name}: the date under the hours`).toEqual(['Oct 14']);
  }
});

test('an empty window keeps the four cards at the height they have with data: the Requests card says why, with "Clear filters" when filters are on, and the lists that have nothing say none', async ({ page }) => {
  // The height of the four cards with data: the reference of every state below.
  await open(page);
  const withData = await cardHeights(page);
  expect(withData).toHaveLength(4);
  expect(withData[0]).toBeGreaterThan(250);
  expectNear(withData, Array(4).fill(withData[0]), 'with data, the four cards');

  const server = newServer();
  server.cells = [];
  await open(page, '', server);
  // Nothing counted: the tiles say 0, and the four cards are still there, as tall as with data. The Requests card has the sentence, the three
  // others say what they count; the tables say what they list.
  expect(await tiles(page)).toMatchObject({ Requests: ['0', 'in the last 7 days'], 'Tool calls': ['0', ''], 'Call time': ['—', ''], Returned: ['0 B', ''], 'Active keys': ['0', 'of 5 keys'] });
  await expect(page.locator('.mcpOverview__charts')).toBeVisible();
  await expect(page.locator('.mcpOverview__card')).toHaveCount(4);
  expectNear(await cardHeights(page), withData, 'an empty window, the four cards');
  const requests = card(page, 'requests');
  await expect(requests.locator('.uiState--empty .uiState__title')).toHaveText('No request in the last 7 days');
  await expect(requests.locator('.uiState--empty .uiState__body')).toHaveText('Nothing was counted in this window.');
  await expect(requests.locator('.uiState button')).toHaveCount(0);
  await expect(card(page, 'errors').locator('.uiState--empty .uiState__title')).toHaveText('No errors in this window');
  await expect(card(page, 'time').locator('.uiState--empty .uiState__title')).toHaveText('No tool calls in this window');
  await expect(card(page, 'bytes').locator('.uiState--empty .uiState__title')).toHaveText('Nothing was returned in this window');
  await expect(page.locator('.mcpOverview__card .uiState--empty')).toHaveCount(4);
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(0);
  // The cards keep their title and their step: they say what is not there. The sentence is not above the cards (the old one-for-all box).
  expect(await titles(page)).toEqual(['Requests by method', 'Errors by method', 'Call time by method', 'Returned by method']);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta')).toHaveText('by 3 hours');
  await expect(page.locator('.mcpOverview__empty')).toHaveCount(0);
  await expect(block(page, 'keys').locator('.mcpOverview__none')).toHaveText('No key sent a request in this view.');
  await expect(block(page, 'methods').locator('.mcpOverview__none')).toHaveText('No method was called in this view.');
  await expect(block(page, 'results').locator('.mcpOverview__none')).toHaveText('No result in this view.');
  await expect(block(page, 'clients').locator('.mcpOverview__none')).toHaveText('No client sent a request in this view.');
  await expect(block(page, 'keys').locator('.pagePart__count')).toHaveText('');
  // The lists of the bar that have nothing to offer are off, and say none (and why in their title). The instances are every instance that the
  // server knows: the list has the two of them, with no request, so it is still a list to open.
  for (const [dimension, label, one] of [['key', 'Key', 'key'], ['method', 'Method', 'method'], ['client', 'Client', 'client']]) {
    await expect(pickerButton(page, dimension)).toHaveText(`${label} · none`);
    await expect(pickerButton(page, dimension)).toBeDisabled();
    await expect(pickerButton(page, dimension)).toHaveAttribute('title', `No ${one} in this view`);
  }
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All');
  await expect(pickerButton(page, 'instance')).toBeEnabled();
  const instances = await openPicker(page, 'instance');
  await expect(instances.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(instances.locator('.mcpPicker__count')).toHaveText(['0', '0']);
  await page.keyboard.press('Escape');

  // With a filter: the same sentence says that no request has all of them, "Clear filters" is in the card, and the card is as tall as ever.
  await page.goto('/mcp-integration/usage?method=run_query&window=24h');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(requests.locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  await expect(requests.locator('.uiState--empty .uiState__body')).toHaveText('Nothing in the last 24 hours matches them.');
  await expect(requests.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  expectNear(await cardHeights(page), withData, 'an empty window with a filter, the four cards');
  // The list of the dimension that has a filter stays a list (so that it can be taken off), the others say none.
  await expect(pickerButton(page, 'method')).toHaveText('Method · run_query');
  await expect(pickerButton(page, 'method')).toBeEnabled();
  await expect(pickerButton(page, 'key')).toHaveText('Key · none');
  server.cells = CELLS();
  await requests.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h$/);
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(4);
  await expect(page.locator('.mcpOverview__card .uiState--empty')).toHaveCount(0);
  await expect(pressedWindow(page)).toBeFocused();
  await settled(page);
  expectNear(await cardHeights(page), withData, 'with data again, the four cards');
  await screenshot(page, 'usage-empty');
});

test('a chart that has nothing to draw says so in its card: no errors, no tool call, nothing returned; the others keep drawing', async ({ page }) => {
  // The protocol method ping: 100 requests of 40 bytes, and neither error nor call.
  await open(page, '?method=ping');
  expect(await tiles(page)).toMatchObject({ Requests: ['100', 'in the last 7 days'], Errors: ['0', '0% of read requests'], 'Call time': ['—', ''] });
  await expect(chartBox(page, 'requests').locator('.chartCore')).toHaveCount(1);
  await expect(chartBox(page, 'bytes').locator('.chartCore')).toHaveCount(1);
  await expect(card(page, 'errors').locator('.uiState--empty .uiState__title')).toHaveText('No errors in this window');
  await expect(card(page, 'time').locator('.uiState--empty .uiState__title')).toHaveText('No tool calls in this window');
  // The card keeps its title and its step: they say what is not there.
  await expect(card(page, 'errors').locator('.chartCard__title')).toHaveText('Errors by method');
  await expect(card(page, 'time').locator('.chartCard__meta')).toHaveText('by 3 hours');
  // Nothing returned: a request that is counted with no byte.
  const silent = newServer();
  silent.cells = [cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'notifications/initialized', 'ok', 5)];
  await open(page, '', silent);
  await expect(card(page, 'bytes').locator('.uiState--empty .uiState__title')).toHaveText('Nothing was returned in this window');
  await expect(chartBox(page, 'requests').locator('.chartCore')).toHaveCount(1);
});

// ---- a filter never moves the page ----------------------------------------------------------------------------------------------------
// The chips row is one line that is always there, the four cards have one height, a tile keeps the room of its sub line: adding or removing a
// filter, and the answer that follows, change what the figures say and nothing of where they stand.

// A walk through the five ways to change a filter, one after the other: a list of the bar (key ops-all), a row of a table (result ok), a
// legend entry (method ping: two charts have nothing to draw then), the x of a chip and "Clear filters". The picks go in this order because a
// table lists what else can be picked and a dimension with one value left is not offered: each one leaves two values or more in what the next
// uses. For each, the read is slowed down (1.2 s): the page is measured while it runs (the chips are the new ones, the figures the old ones,
// dimmed) and once it is drawn, and `base` is where everything stood before: nothing may be elsewhere. `after()` is a check of the case
// that runs when the step is drawn.
async function walkFilters(page, server, base, after = async () => {}) {
  const steps = [
    ['a list of the bar', 1, async () => {
      const menu = await openPicker(page, 'key');
      await menu.getByRole('checkbox', { name: /^ops-all/ }).check();
      await page.keyboard.press('Escape');
    }],
    ['a row of a table', 2, () => row(page, 'result', 'ok').click()],
    ['a legend entry', 3, () => entry(page, 'method:ping').click()],
    ['the x of a chip', 2, () => page.getByRole('button', { name: 'Remove filter Result = ok' }).click()],
    ['"Clear filters"', 0, () => page.getByRole('button', { name: 'Clear filters' }).click()],
  ];
  const before = reads(server).length;
  server.delay['GET /usage/overview'] = 1200;
  for (const [name, count, act] of steps) {
    await act();
    await expect(chips(page), name).toHaveCount(count);
    let reading;
    await expect.poll(async () => { reading = await layout(page); return reading.busy; }, { intervals: [50, 100], message: `${name}: the read runs` }).toBe(true);
    expect(moved(base.stands, reading.stands), `${name}, while it reads`).toEqual([]);
    await settled(page);
    const drawn = await layout(page);
    expect(drawn.busy).toBe(false);
    expect(moved(base.stands, drawn.stands), `${name}, once it is drawn`).toEqual([]);
    await after(name);
  }
  server.delay['GET /usage/overview'] = 0;
  // One read for each step: nothing else read, and back to no filter the row has its hint again, as at the start.
  expect(reads(server)).toHaveLength(before + steps.length);
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
}

for (const width of [1440, 1100, 820, 390]) {
  test(`nothing moves when a filter is added or removed, from a list, a row, a legend, a chip or Clear filters, while the read runs and once it is drawn (${width} px)`, async ({ page }) => {
    // A phone folds its bar when the page opens, so the window has its size before the page loads, and the bar is unfolded to reach its lists.
    await page.setViewportSize({ width, height: 900 });
    const server = await open(page);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    const base = await layout(page);
    expect(base.busy).toBe(false);
    // With no filter the row is its 35 px, and the tiles, the cards and the tables stand where the others will find them.
    expect(base.stands['the chips row'][1]).toBeCloseTo(35, 0);
    expect(base.stands['the tiles']).toHaveLength(7);
    expect(base.stands['the cards']).toHaveLength(4);
    await walkFilters(page, server, base);
  });
}

test('the four cards have one height in every state: with data, filtered, with a chart that has nothing to draw, and for an empty window', async ({ page }) => {
  const nothing = (server) => { server.cells = []; return server; };
  // [state, address, server, how many cards say that they have nothing to draw]
  const states = [
    ['with data', '', newServer(), 0],
    ['filtered, a legend of three', '?key=ui_0a1b2c3d4e5f', newServer(), 0],
    ['two charts with nothing to draw (ping has no error and no call)', '?method=ping', newServer(), 2],
    ['a filter that matches nothing', '?method=run_query', nothing(newServer()), 4],
    ['an empty window', '', nothing(newServer()), 4],
  ];
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    let reference = null;
    for (const [state, query, server, empty] of states) {
      await open(page, query, server);
      await settled(page);
      await expect(page.locator('.mcpOverview__card .uiState--empty'), `${width} px, ${state}`).toHaveCount(empty);
      const heights = await cardHeights(page);
      // The card of the first state is the one that the others have: tall enough for a plot of 200 px and a legend of three lines (four on a phone).
      reference ??= heights[0];
      expect(reference, `${width} px`).toBeGreaterThan(280);
      expectNear(heights, Array(4).fill(reference), `${width} px, ${state}`);
    }
  }
});

test('a legend of more than three lines scrolls inside its card, which does not grow (four lines on a phone)', async ({ page }) => {
  // Twelve tools with long names: the eight biggest are entries of a line each (and "4 more"), far past the room of three lines.
  const long = newServer();
  long.cells = Array.from({ length: 12 }, (_, i) => cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', `a_very_long_tool_name_for_the_legend_of_the_chart_${String(i).padStart(2, '0')}`, 'ok', 50 - i, 100, 20, 1, 1000 + i));
  for (const [width, lines] of [[1440, 3], [390, 4]]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const reference = await cardHeights(page);
    await open(page, '', long);
    await settled(page);
    // The room of the lines: 20 px an entry, 2 px between two, 2 px of margin above and below.
    const room = lines * 20 + (lines - 1) * 2 + 4;
    const boxes = await page.locator('.mcpOverview__card .chartCore__legendList').evaluateAll((els) => els.map((el) => ({
      card: el.closest('.mcpOverview__card').dataset.card, shown: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY, entries: el.children.length,
    })));
    // The errors of the calls: none, the card says so; the three others have the eight biggest tools and "4 more".
    expect(boxes.map((box) => box.card), `${width} px`).toEqual(['requests', 'time', 'bytes']);
    for (const box of boxes) {
      expect(box.entries, `${width} px, ${box.card}`).toBe(9);
      expect(Math.abs(box.shown - room), `${width} px, ${box.card}: the room of ${lines} lines`).toBeLessThanOrEqual(1);
      expect(box.content, `${width} px, ${box.card}: more than the room`).toBeGreaterThan(box.shown + 40);
      expect(box.overflow, `${width} px, ${box.card}`).toBe('auto');
    }
    // The card is the height of the others: the legend scrolls in it. The entries are buttons, and the keyboard reaches one that is below the
    // room: the legend scrolls to it (and the card stays as it is).
    expectNear(await cardHeights(page), reference, `${width} px, long legends`);
    const last = entry(page, 'method:a_very_long_tool_name_for_the_legend_of_the_chart_07');
    await expect(last).toBeEnabled();
    const before = await page.locator('.mcpOverview__chart[data-chart="requests"] .chartCore__legendList').evaluate((el) => el.scrollTop);
    expect(before).toBe(0);
    await last.focus();
    await expect(last).toBeFocused();
    expect(await page.locator('.mcpOverview__chart[data-chart="requests"] .chartCore__legendList').evaluate((el) => el.scrollTop), `${width} px: the legend scrolled to the entry`).toBeGreaterThan(0);
    expectNear(await cardHeights(page), reference, `${width} px, a legend scrolled`);
    // The entry is still a filter: Enter picks it, from the part of the legend that was hidden.
    await page.keyboard.press('Enter');
    await expect(chips(page)).toHaveText(['Method=a_very_long_tool_name_for_the_legend_of_the_chart_07']);
    await settled(page);
    expectNear(await cardHeights(page), reference, `${width} px, filtered`);
  }
});

test('twenty chips are one line of the same 35 px: the list scrolls sideways, fading where it hides some, and "Clear filters" stays in view', async ({ page }) => {
  const many = Array.from({ length: 20 }, (_, i) => `search_traces_${String(i).padStart(2, '0')}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    const none = await layout(page);
    expect(none.stands['the chips row'][1]).toBeCloseTo(35, 0);
    // The most that a kind of filter takes, by the address: the 20 chips come with it. The method is a value that nobody called: nothing is
    // counted, and the layout is the one of an empty window.
    await page.goto(`/mcp-integration/usage?${many.map((name) => `method=${name}`).join('&')}`);
    await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
    await expect(chips(page)).toHaveCount(20);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    await settled(page);
    const list = page.locator('.mcpOverview__chips');
    // The one of the row (the empty card of the Requests has a button of the same name).
    const clear = page.locator('.mcpOverview__filters').getByRole('button', { name: 'Clear filters' });
    const m = await page.evaluate(() => {
      const row = document.querySelector('.mcpOverview__filters');
      const chipsList = row.querySelector('.mcpOverview__chips');
      const box = (el) => el.getBoundingClientRect();
      return {
        row: box(row), list: box(chipsList), clear: box(row.querySelector('.chips__clear')),
        hidden: chipsList.scrollWidth - chipsList.clientWidth, overflow: getComputedStyle(chipsList).overflowX,
        // Every chip is on the same line: none wraps under the others.
        lines: new Set([...chipsList.children].map((el) => Math.round(box(el).top))).size,
      };
    });
    // One line of 35 px that scrolls: the chips are much wider than the window, none is on a second line, the box of the list is as tall as the row.
    expect(m.row.height, `${width} px: the row`).toBeCloseTo(35, 0);
    expect(m.lines, `${width} px: one line of chips`).toBe(1);
    expect(m.hidden, `${width} px: what the list hides`).toBeGreaterThan(m.list.width);
    expect(m.overflow).toBe('auto');
    await expect(list).toHaveClass(/has-edge-end/);
    await expect(list).not.toHaveClass(/has-edge-start/);
    // "Clear filters" is beside the list, in the row, in view (it does not scroll with the chips).
    await expect(clear).toBeVisible();
    await expect(clear).toBeInViewport({ ratio: 0.99 });
    expect(m.clear.left, `${width} px: Clear filters is after the list`).toBeGreaterThanOrEqual(m.list.right - 1);
    expect(m.clear.right, `${width} px: Clear filters is in the row`).toBeLessThanOrEqual(m.row.right);
    expect(await horizontalOverflow(page), `${width} px: the page`).toBeLessThanOrEqual(0);
    // The page stands as it stood with no filter (the cards of the empty window are as tall as the ones with data).
    expect(moved(none.stands, (await layout(page)).stands), `${width} px: with 20 chips`).toEqual([]);
    // The list scrolls to its end: the fade changes sides, "Clear filters" has not moved.
    await list.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(list).toHaveClass(/has-edge-start/);
    await expect(list).not.toHaveClass(/has-edge-end/);
    await expect(chips(page).last()).toBeInViewport({ ratio: 0.99 });
    await expect(clear).toBeInViewport({ ratio: 0.99 });
    const after = await clear.boundingBox();
    expect(Math.abs(after.x - m.clear.left), `${width} px: Clear filters after the scroll`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - m.clear.top), `${width} px: Clear filters after the scroll`).toBeLessThanOrEqual(0.5);
  }
});

test('a tile that has no sub line keeps the height and the place of the tiles that have one, with one tile or several to a line', async ({ page }) => {
  const nothing = newServer();
  nothing.cells = [];
  // [state, address, server, the tiles that have no sub line]: ping has no call and no row; an empty window has no call, no error and no byte.
  const states = [
    ['no call and no row', '?method=ping', newServer(), ['Call time', 'Returned']],
    ['an empty window', '', nothing, ['Tool calls', 'Errors', 'Call time', 'Returned']],
  ];
  const sizes = ['the tiles', 'the height of the tiles'];
  const only = (stands) => Object.fromEntries(sizes.map((name) => [name, stands[name]]));
  for (const width of [1440, 1100, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const full = only((await layout(page)).stands);
    expect(await tiles(page), `${width} px`).toMatchObject({ 'Tool calls': [expect.any(String), '80.7% of the requests'], 'Call time': [expect.any(String), 'max 900 ms'], Returned: [expect.any(String), '5,247 rows'] });
    for (const [state, query, server, quiet] of states) {
      await open(page, query, server);
      await settled(page);
      // The premise: the tiles that say nothing under their figure are those, and the other tiles still have their line.
      const bare = await page.locator('.mcpOverview__tiles .statTile').evaluateAll((els) => els.filter((el) => !el.querySelector('.statTile__sub')).map((el) => el.querySelector('.statTile__label').textContent));
      expect(bare, `${width} px, ${state}`).toEqual(quiet);
      // Each tile has the height of its tile with data, and stands where it stood (a row of tiles that all lack their line is as tall as the others).
      expect(moved(full, only((await layout(page)).stands)), `${width} px, ${state}`).toEqual([]);
    }
  }
});

test('the time of a call is an average that the legend gives over the window, not a sum of the averages of the steps', async ({ page }) => {
  const server = await open(page);
  // The legend of Call time says, for each group, the time of its calls over their number in the window: query_table 11,249 ms over 754 calls.
  const body = overviewOf(server, new URLSearchParams({ window: '7d' })).body;
  const sums = (group) => [group.duration_ms_sum.reduce((a, b) => a + b, 0), group.calls.reduce((a, b) => a + b, 0)];
  const [ms, calls] = sums(body.series.groups.find((group) => group.id === 'query_table'));
  expect([ms, calls]).toEqual([11249, 754]);
  await expect(entry(page, 'method:query_table', 'time').locator('b')).toHaveText('14.9 ms');
  // A step in which the group made no call is a gap of the line, not a zero: the points are the steps that have calls, and each one is a run
  // of its own when the steps between them have none (a protocol method has no point at all).
  const { points } = geometry('7d');
  const withCalls = body.series.groups.find((group) => group.id === 'query_table').calls.filter((value) => value > 0).length;
  expect(withCalls).toBe(4);
  expect(withCalls).toBeLessThan(points);
  const stats = JSON.parse(await chartBox(page, 'time').locator('.chartCore').getAttribute('data-series-stats'));
  expect(stats.query_table).toEqual({ points: 4, runs: 4 });
  expect(stats.ping).toEqual({ points: 0, runs: 0 });
  // The axis is in milliseconds, then seconds; the bytes in the unit of 1024.
  const ticks = async (id) => (await chartJson(chartBox(page, id).locator('.chartCore'), 'data-y-ticks')).filter((label) => label !== '0');
  expect((await ticks('time')).every((label) => /^\d+(\.\d+)? ms$/.test(label))).toBe(true);
  expect((await ticks('bytes')).every((label) => /^\d+(\.\d+)? KB$/.test(label))).toBe(true);
  expect((await ticks('requests')).every((label) => /^[\d.]+K?$/.test(label))).toBe(true);
  // A long call moves the axis to seconds.
  const slow = newServer();
  slow.cells = [cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'run_query', 'ok', 2, 9000, 5000, 0, 3 * 1024 * 1024)];
  await open(page, '', slow);
  expect((await ticks('time')).every((label) => /^\d+(\.\d+)? s$/.test(label))).toBe(true);
  expect((await ticks('bytes')).every((label) => /^\d+(\.\d+)? MB$/.test(label))).toBe(true);
});

test('the cursor and the zoom go from one chart to the others: they share their axis', async ({ page }) => {
  await open(page);
  const range = (id) => chartBox(page, id).locator('.chartCore').evaluate((el) => window.ChDash.chartCore.of(el).layout());
  const at = await page.evaluate((t) => window.ChDash.chartCore.of(document.querySelector('.mcpOverview__chart[data-chart="requests"]')).toClient(t, 10), Date.UTC(2026, 9, 14, 10, 30));
  await page.mouse.move(at.x, at.y);
  // The others show the same instant (a crosshair), only the chart that is hovered has the tooltip.
  for (const id of ['errors', 'time', 'bytes']) await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('data-sync-x', /\d/);
  await expect(chartBox(page, 'requests').locator('.chartCore__tooltip')).toBeVisible();
  await expect(chartBox(page, 'errors').locator('.chartCore__tooltip')).toBeHidden();
  // A drag over one chart zooms the four.
  const plot = await chartBox(page, 'requests').locator('.chartCore').getAttribute('data-plot');
  const [left, top, width, height] = plot.split(' ').map(Number);
  const box = await chartBox(page, 'requests').locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + left + width * 0.7, box.y + top + height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + left + width * 0.95, box.y + top + height / 2, { steps: 4 });
  await page.mouse.up();
  for (const id of CHARTS) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-zoomed', 'true');
  const zoomed = await Promise.all(CHARTS.map(async (id) => (await xRange(page, id))));
  expect(new Set(zoomed.map((pair) => pair.join())).size).toBe(1);
  expect(await range('requests')).toBeTruthy();
  // A double click resets the four.
  await page.mouse.dblclick(box.x + left + width / 2, box.y + top + height / 2);
  for (const id of CHARTS) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-zoomed', 'false');
});

test('an answer that fails says so with Try again, and the bar and the window can still change', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage/overview'] = { status: 503, body: { error_code: 'server_busy', message: 'Too many heavy requests.', retryable: true } };
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  const failed = page.locator('.mcpOverview__state .uiState--error');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.uiState__title')).toHaveText('The usage cannot be read');
  await expect(failed.locator('.uiState__body')).toHaveText('Too many heavy requests.');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
  // The row, the bar and the window are there: the person can pick another window or another filter.
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpBar')).toBeVisible();
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(groupButton(page)).toHaveText('Group by · Method');
  // Try again reads again (the next answer is fine).
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(failed).toHaveCount(0);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method']);
  // A failure after a success: the figures go, the error shows, and another window reads again.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('.mcpOverview__state .uiState--error .uiState__body')).toHaveText('The usage could not be read.');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
  await expect(page.locator('#mcpBar')).toBeVisible();
  await windowButton(page, '30 d').click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpOverview__state')).toBeHidden();
  // A server that refuses a value says which one: the message is the page's, and the chip can go.
  server.errors['GET /usage/overview'] = { status: 400, body: { error_code: 'validation', message: 'key is not valid.', retryable: false, field: 'key', reason: 'invalid' } };
  await row(page, 'key', 'ops-all').click();
  await expect(page.locator('.mcpOverview__state .uiState--error .uiState__body')).toHaveText('key is not valid.');
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await page.getByRole('button', { name: 'Remove filter Key = ops-all' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  // The lists of the bar still open on the values that the address names, whatever the answer.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await pickGroup(page, 'client');
  await expect(page.locator('.mcpOverview__state .uiState--error')).toBeVisible();
  await expect(groupButton(page)).toHaveText('Group by · Client');
});

test('MCP off: both tabs show how to turn it on, and nothing reads the usage', async ({ page }) => {
  const server = newServer({ version: { mcp: { enabled: false } }, meta: { enabled: false } });
  server.meta = { enabled: false };
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  await expect(page.locator('.mcpOff')).toBeVisible();
  await expect(page.locator('.mcpOff')).toContainText('MCP is off');
  await expect(page.locator('.mcpOff .mcpCode__pre')).toContainText('mcp {');
  await expect(page.locator('#mcpOverview')).toBeHidden();
  // No bar and no chips: the page has nothing to filter.
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__filters')).toHaveCount(0);
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTab-usage')).toHaveAttribute('aria-current', 'page');
  expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /meta']);
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('.mcpOff')).toBeVisible();
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  // The state of the meta fails: Retry reads it again, and the usage follows.
  const failing = newServer();
  failing.errors['GET /meta'] = { status: 503, body: { error_code: 'server_busy', message: 'Too many heavy requests.', retryable: true } };
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await install(page, failing);
  await page.goto('/mcp-integration/usage');
  await expect(page.locator('#mcpState .uiState--error .uiState__title')).toHaveText('Could not load the MCP state');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await page.locator('#mcpState').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('#mcpState')).toBeHidden();
  await expect(page.locator('#mcpBar')).toBeVisible();
});

test('usage off: the tab says "Usage is off" and shows the block that turns it on; no bar, no tiles, and the page asks for nothing but the meta', async ({ page }) => {
  const server = newServer();
  setUsage(server, { enabled: false });
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  const off = page.locator('#mcpUsageOff');
  await expect(off).toBeVisible();
  await expect(off.locator('.uiState--empty .uiState__title')).toHaveText('Usage is off');
  await expect(off.locator('.uiState__body')).toContainText('ClickHouse Dash does not count what the keys do, so there is nothing to show here.');
  await expect(off.locator('.uiState__body')).toContainText('by key, method, client and instance');
  // What to do: the block of the config file that turns it on, with its copy button, and what the directory needs.
  await expect(off.locator('.mcpNote').first()).toHaveText('Add this to the config file, then restart ClickHouse Dash:');
  expect(await off.locator('.mcpCode__pre').textContent()).toBe('mcp {\n  usage {\n    enabled = true\n    dir     = "/var/lib/chdash/mcp-usage"\n  }\n}');
  await expect(off.getByRole('button', { name: 'Copy the HCL block' })).toBeVisible();
  await expect(off.locator('.mcpNote').last()).toContainText('The directory must exist and be writable.');
  await expect(off.locator('.mcpNote').last()).toContainText('retention_days (90 by default)');
  // The row of the two pages stays; nothing else of the tab is there: no bar, no chips, no tiles, no charts, no tables.
  await expect(page.locator('h1')).toHaveText('MCP usage');
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTab-usage')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__filters')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__tiles')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__card')).toHaveCount(0);
  await expect(page.locator('#mcpOverview')).toBeHidden();
  // The page does not ask for what is off: the meta is the only request, and nothing reads later either.
  await page.waitForTimeout(600);
  expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /meta']);
  await screenshot(page, 'usage-off');
});

test('a read that answers "not_enabled" (the usage was turned off after the meta was read) ends in the same "Usage is off" state', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage/overview'] = { status: 404, body: { error_code: 'not_enabled', message: 'The usage of the keys is off (mcp.usage.enabled is false).', retryable: false } };
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  // The meta said that the usage is on, so the page asked for it, and the answer ended the tab in the state of a usage that is off: not an error.
  const off = page.locator('#mcpUsageOff');
  await expect(off).toBeVisible();
  await expect(off.locator('.uiState--empty .uiState__title')).toHaveText('Usage is off');
  expect(await off.locator('.mcpCode__pre').textContent()).toBe('mcp {\n  usage {\n    enabled = true\n    dir     = "/var/lib/chdash/mcp-usage"\n  }\n}');
  await expect(page.locator('.uiState--error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // The bar and the chips were drawn before the answer: they are hidden with the tab, and so are the figures.
  await expect(page.locator('#mcpBar')).toBeHidden();
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await expect(page.locator('#mcpOverview')).toBeHidden();
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await page.waitForTimeout(600);
  expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /meta', 'GET /usage/overview']);
});

test('the counting says since when, for a window that starts before it, and the tables say what an answer left out', async ({ page }) => {
  // The counting began on Oct 1 08:00 (the default meta): the last 7 days start after it and say nothing, the last 30 days start before it.
  await open(page);
  const notes = page.locator('.mcpOverview__notes p');
  await expect(notes).toHaveText(['The rows are those of the tools that build their own SQL: an API tool counts no row.']);
  await windowButton(page, '30 d').click();
  await expect(pressedWindow(page)).toHaveText('30 d');
  await settled(page);
  await expect(notes).toHaveText(['Counted since Oct 1 08:00.', 'The rows are those of the tools that build their own SQL: an API tool counts no row.']);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 1 08:00 → Oct 14 10:00');

  // The counting began at 08:00 today: the last 7 days, 24 hours and 6 hours start before it; the last hour starts at 09:01, after it. The
  // note is the same whether the usage is kept in files or not: it says when the counting began and nothing about a restart or the memory.
  const server = newServer();
  server.meta.usage = { ...server.meta.usage, since: '2026-10-14T08:00:00Z' };
  // The tables that the server cut, as the contract has them (one count for each list, the instances included).
  server.overview = (srv, params) => {
    const answer = overviewOf(srv, params);
    if (answer.status === 200) answer.body.omitted = { keys: 0, methods: 12, results: 0, clients: 3, instances: 0 };
    return answer;
  };
  await open(page, '', server);
  await expect(notes).toHaveText(['Counted since Oct 14 08:00.', 'The rows are those of the tools that build their own SQL: an API tool counts no row.']);
  await expect(page.locator('.mcpOverview__notes')).not.toContainText(/memory|restart|persist/i);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 14 08:00 → 10:00');
  // The rows that the server cut: "N more methods not shown" under the table, nothing under the others.
  await expect(block(page, 'methods').locator('.mcpNote--fine').first()).toHaveText('12 more methods not shown.');
  await expect(block(page, 'clients').locator('.mcpNote--fine').first()).toHaveText('3 more clients not shown.');
  await expect(block(page, 'keys').locator('.mcpNote--fine')).toBeHidden();
  await expect(block(page, 'results').locator('.mcpNote--fine')).toBeHidden();
  for (const [label, range] of [['24 h', 'Oct 14 08:00 → 10:00'], ['6 h', 'Oct 14 08:00 → 10:00']]) {
    await windowButton(page, label).click();
    await expect(pressedWindow(page)).toHaveText(label);
    await settled(page);
    await expect(notes.first(), label).toHaveText('Counted since Oct 14 08:00.');
    await expect(page.locator('.mcpOverview__range'), label).toHaveText(range);
  }
  await windowButton(page, '1 h').click();
  await expect(pressedWindow(page)).toHaveText('1 h');
  await settled(page);
  await expect(notes).toHaveText(['The rows are those of the tools that build their own SQL: an API tool counts no row.']);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 14 09:01 → 10:00');
});

test('Refresh reads again, nothing else does: no timer, and the figures stay (dimmed) while it runs', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toHaveLength(1);
  // At rest nothing is read: no refresh on a timer.
  await page.waitForTimeout(2500);
  expect(reads(server)).toHaveLength(1);
  expect(server.calls.filter((call) => call.path === '/meta')).toHaveLength(1);
  server.delay['GET /usage/overview'] = 600;
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('#mcpRefresh')).toBeDisabled();
  await expect(page.locator('.mcpOverview__body')).toHaveAttribute('aria-busy', 'true');
  await expect(tile(page, 'Requests')).toBeVisible();
  await settled(page);
  await expect(page.locator('#mcpRefresh')).toBeEnabled();
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method']);
  // From the keyboard: the button is off while the read runs, which takes the focus from it, and the focus comes back to it.
  await page.locator('#mcpRefresh').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mcpRefresh')).toBeDisabled();
  await settled(page);
  await expect(page.locator('#mcpRefresh')).toBeFocused();
  expect(reads(server)).toHaveLength(3);
  // A change while a read runs cancels it: only the last answer is drawn.
  server.delay['GET /usage/overview'] = 500;
  await row(page, 'key', 'ops-all').click();
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 13 10:15 → Oct 14 10:00');
  expect((await tiles(page)).Requests).toEqual(['702', 'in the last 24 hours']);
  expect(reads(server).at(-1)).toBe('?window=24h&group=method&key=ops-all');
  // The page has no timer of its own: a few seconds later, nothing was read and no chart was drawn again.
  const draws = await chartBox(page).locator('.chartCore').getAttribute('data-draws');
  const count = reads(server).length;
  await page.waitForTimeout(1500);
  expect(reads(server)).toHaveLength(count);
  expect(await chartBox(page).locator('.chartCore').getAttribute('data-draws')).toBe(draws);
});

test('a page restored from the back/forward cache reads again', async ({ page }) => {
  const server = await open(page);
  const before = reads(server).length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => reads(server).length).toBeGreaterThan(before);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(await chipLabels(page)).toEqual([]);
  // The bar is shown again with the tab, not twice.
  await expect(page.locator('#mcpBar')).toHaveCount(1);
  await expect(page.locator('#mcpBar')).toBeVisible();
});

test('desktop and phone: the page has no sideways scroll at 1920, 1440, 1280, 1101, 1100, 820 and 390 px, the bar wraps and the charts take one column or two', async ({ page }) => {
  await open(page, '?key=ops-all');
  for (const [width, height] of [[1920, 1000], [1440, 900], [1280, 800], [1101, 800], [1100, 800], [820, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await expect(chartBox(page).locator('.chartCore')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await horizontalOverflow(page), `${width}: the page`).toBeLessThanOrEqual(0);
    const m = await page.evaluate(() => {
      const panel = document.querySelector('#mcpPanel');
      const bar = document.querySelector('#mcpBar');
      return {
        panel: panel.scrollWidth - panel.clientWidth,
        bar: bar.scrollWidth - bar.clientWidth,
        barHeight: Math.round(bar.getBoundingClientRect().height),
        // The seven controls of the bar: Group by and the four lists (the lead), the window and Refresh (the tail), left to right, with the
        // middle of each and its right edge.
        controls: [...bar.querySelectorAll('.tracePicker__button, .mcpBar__windows, #mcpRefresh')].map((el) => {
          const box = el.getBoundingClientRect();
          return { middle: box.top + box.height / 2, right: box.right, width: box.width };
        }),
        // A table that is wider than its box scrolls inside it: the four fit from 820 px, in one column and in two (from 1280 px).
        wraps: [...document.querySelectorAll('.mcpOverview__wrap')].map((el) => el.scrollWidth - el.clientWidth),
        columns: getComputedStyle(document.querySelector('.mcpOverview__tables')).gridTemplateColumns.split(' ').length,
        chartColumns: getComputedStyle(document.querySelector('.mcpOverview__charts')).gridTemplateColumns.split(' ').length,
        tiles: new Set([...document.querySelectorAll('.mcpOverview__tiles .statTile')].map((el) => Math.round(el.getBoundingClientRect().top))).size,
        charts: [...document.querySelectorAll('.mcpOverview__chart')].map((el) => Math.round(el.getBoundingClientRect().width)),
        chips: Math.round(document.querySelector('.mcpOverview__filters').getBoundingClientRect().width),
      };
    });
    expect(m.panel, `${width}: the panel`).toBeLessThanOrEqual(0);
    expect(m.bar, `${width}: the bar`).toBeLessThanOrEqual(0);
    if (width >= 820) expect(m.wraps, `${width}: the tables in their boxes`).toEqual([0, 0, 0, 0]);
    // Two columns of tables on a wide window (from 1280 px), one under it; two columns of charts above 1100 px; seven tiles on one line from 1100 px.
    expect(m.columns, `${width}: the columns of the tables`).toBe(width >= 1280 ? 2 : 1);
    expect(m.chartColumns, `${width}: the columns of the charts`).toBe(width > 1100 ? 2 : 1);
    if (width >= 1100) expect(m.tiles, `${width}: the tiles`).toBe(1);
    // The four charts have the width of a column, and the same one.
    expect(new Set(m.charts).size, `${width}: the charts`).toBe(1);
    expect(m.charts[0], `${width}: a chart`).toBeGreaterThan(width > 1100 ? width / 2 - 60 : width - 64);
    // One row of the bar from 1101 px (48 px high: Group by, the four lists, the window and Refresh, all seven on one line, each list at least
    // 120 px wide); from 1100 px down, two (the lead with the five lists, then the tail with the window and Refresh; 87 px), as the bars of
    // System. The chips are as wide as the bar, and nothing of the bar is past the window.
    expect(m.controls, `${width}: the controls of the bar`).toHaveLength(7);
    expect(Math.max(...m.controls.map((control) => control.right)), `${width}: the right end of the bar`).toBeLessThanOrEqual(width);
    const rows = new Set(m.controls.map((control) => Math.round(control.middle / 4)));
    if (width > 1100) {
      expect(m.barHeight, `${width}: the bar`).toBeLessThanOrEqual(52);
      expect(Math.max(...m.controls.map((control) => control.middle)) - Math.min(...m.controls.map((control) => control.middle)), `${width}: one row`).toBeLessThanOrEqual(2);
      expect(Math.min(...m.controls.slice(0, 5).map((control) => control.width)), `${width}: the narrowest list`).toBeGreaterThanOrEqual(119);
    } else {
      expect(m.barHeight, `${width}: the bar`).toBeGreaterThan(70);
      // The five of the lead share a row down to 761 px, the tail is under them; the lists wrap two to a row only from 760 px down.
      if (width >= 761) expect(m.controls.slice(0, 5).map((control) => Math.round(control.middle)), `${width}: the lead is one row`).toEqual(Array(5).fill(Math.round(m.controls[0].middle)));
      expect(m.controls[5].middle, `${width}: the window is under the lists`).toBeGreaterThan(m.controls[0].middle + 20);
      expect(rows.size, `${width}: two rows or more`).toBeGreaterThanOrEqual(2);
    }
    expect(m.chips, `${width}: the chips`).toBeGreaterThan(width - 4);
  }
  // On a phone a table that is wider than its box scrolls in it, and the box says so (the faded edge).
  await expect(block(page, 'keys').locator('.dataTableWrap')).toHaveClass(/has-edge-end/);
  await screenshot(page, 'usage-phone');
});

test('a phone folds the bar into one line, the window and the group and how many filters; it unfolds to the lists and folds again with Refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await open(page, '?key=ops-all&client=claude-code');
  const summary = page.locator('#mcpBar .obsFilterSummary');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  // The group is an order, not a filter: the line counts the two chips, and names the window and the group where a time range would be.
  await expect(summary).toHaveText('Last 7 days · by method · 2 filters');
  await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeHidden();
  await expect(page.locator('#mcpBar .obsFilterBar__tail')).toBeHidden();
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await screenshot(page, 'usage-phone-folded');
  // It unfolds to the bar, and the chips come with it.
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toHaveText('Hide the filters');
  for (const button of [groupButton(page), pickerButton(page, 'key'), pickerButton(page, 'method'), pickerButton(page, 'client'), pickerButton(page, 'instance'), windowButton(page, '24 h'), page.locator('#mcpRefresh')]) await expect(button).toBeVisible();
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // A list opens inside the window, whatever the width of the field that it hangs from (the Method list is at the left, the Instance list is
  // alone on the last row of the lead).
  for (const dimension of ['method', 'instance']) {
    const menu = await openPicker(page, dimension);
    const inside = await menu.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; });
    expect(inside, `the ${dimension} list`).toBe(true);
    await page.keyboard.press('Escape');
  }
  await screenshot(page, 'usage-phone-bar');
  // The line follows a change of the window; Refresh (the action of the bar) folds it again.
  await windowButton(page, '24 h').click();
  await settled(page);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toHaveText('Last 24 hours · by method · 2 filters');
  await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeHidden();
  expect(reads(server).at(-1)).toBe('?window=24h&group=method&key=ops-all&client=claude-code');
});

test('the phone line counts the instance chip like the other filters, and the Instance list is in the unfolded bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await open(page, '?instance=chdash-1');
  const summary = page.locator('#mcpBar .obsFilterSummary');
  // One chip, one filter (the singular): the line says "1 filter", the group and the window are not filters.
  await expect(summary).toHaveText('Last 7 days · by method · 1 filter');
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await summary.click();
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  expect(await chipLabels(page)).toEqual(['Remove filter Instance = chdash-1']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  // The list is a filter and a chip is one: a second filter from the bar makes two, and Refresh folds the bar over the new line.
  const keys = await openPicker(page, 'key');
  await keys.getByRole('checkbox', { name: /^ops-all/ }).check();
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Instance=chdash-1']);
  await page.keyboard.press('Escape');
  await settled(page);
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&key=ops-all&instance=chdash-1');
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toHaveText('Last 7 days · by method · 2 filters');
  // An instance that is not a filter is not counted: the chip goes (its x), the line follows.
  await summary.click();
  await page.getByRole('button', { name: 'Remove filter Instance = chdash-1' }).click();
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await settled(page);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveText('Last 7 days · by method · 1 filter');
});

test('both themes: the bar, the lists, the charts, the tiles and the tables read in the light theme and in the dark one', async ({ page }) => {
  await open(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, theme);
    await page.evaluate(() => document.querySelectorAll('.mcpOverview__chart').forEach((el) => window.ChDash.chartCore.of(el)?.themeChanged()));
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const colours = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return {
        page: css('.mcpWorkspace', 'backgroundColor'), value: css('.statTile__value', 'color'), row: css('tr[data-dimension="key"] th', 'color'),
        legend: css('.chartCore__legendItem', 'color'), picker: css('#mcpPickerButton-key', 'color'), pickerFill: css('#mcpPickerButton-key', 'backgroundColor'),
        windowOn: css('.mcpBar__windows [aria-pressed="true"]', 'backgroundColor'), windowOff: css('.mcpBar__windows [aria-pressed="false"]', 'backgroundColor'),
      };
    });
    expect(colours.value).not.toBe(colours.page);
    expect(colours.row).not.toBe(colours.page);
    expect(colours.legend).not.toBe(colours.page);
    expect(colours.picker).not.toBe(colours.pickerFill);
    // The pressed window has the selected look, the others none.
    expect(colours.windowOn).not.toBe(colours.windowOff);
    await screenshot(page, `usage-${theme}`);
    const menu = await openPicker(page, 'client');
    await expect(menu.locator('.mcpPicker__option')).toHaveCount(5);
    const open = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { menu: css('#mcpPickerMenu-client', 'backgroundColor'), name: css('#mcpPickerMenu-client .mcpPicker__name', 'color'), count: css('#mcpPickerMenu-client .mcpPicker__count', 'color') };
    });
    expect(open.name).not.toBe(open.menu);
    expect(open.count).not.toBe(open.menu);
    await screenshot(page, `usage-${theme}-picker`);
    await page.keyboard.press('Escape');
  }
});

// The shared checks of the accessibility contract (axe) on the fake server, which any instance can run: the bar, its lists open (the Instance
// list and the popover of the instances too), the chips, the legends and the tables, a view with lists that are off, the warnings about the
// instances and the "Usage is off" state, in both themes. a11y-contract.spec.js runs the same on the real server.
const axeViolations = (page) => new AxeBuilder({ page }).analyze().then((result) => result.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));

for (const theme of ['dark', 'light']) {
  test(`axe (${theme}): the bar, its lists open, the instances, the chips, the four charts and the tables have no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    await open(page, '?key=ops-all&client=claude-code');
    await page.waitForTimeout(1200);
    expect(await axeViolations(page)).toEqual([]);
    for (const dimension of ['key', 'method', 'client', 'instance']) {
      await openPicker(page, dimension);
      await page.waitForTimeout(300);
      expect(await axeViolations(page), `the ${dimension} list`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(pickerMenu(page, dimension)).toBeHidden();
    }
    await groupButton(page).click();
    await expect(groupOption(page, 'client')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await axeViolations(page), 'Group by').toEqual([]);
    await page.keyboard.press('Escape');
    // "2 instances" in the head opens the list of the instances in a popover.
    await page.locator('.mcpInstances__button').click();
    await expect(page.locator('.mcpInstancesPopover')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await axeViolations(page), 'the instances popover').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.mcpInstancesPopover')).toHaveCount(0);
  });

  test(`axe (${theme}): a view with lists that are off, and locked legend entries, has no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    // ping has one key and one client (their lists are off, dimmed, with a title that says why) and, grouped by client, one locked legend entry.
    await open(page, '?method=ping&group=client');
    await expect(pickerButton(page, 'key')).toBeDisabled();
    await expect(pickerButton(page, 'client')).toBeDisabled();
    await expect(entry(page, 'client:claude-code')).toBeDisabled();
    await page.waitForTimeout(1200);
    expect(await axeViolations(page), 'lists that are off').toEqual([]);
    // The one that has a choice still opens: the list of the instances (both of them are known) with the check boxes.
    await openPicker(page, 'instance');
    await page.waitForTimeout(300);
    expect(await axeViolations(page), 'the list that is on, beside the ones that are off').toEqual([]);
  });

  test(`axe (${theme}): the warnings about the instances (a skipped file and a conflict) have no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    const server = newServer();
    server.instances = [
      { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'conflict', reason: 'another process writes chdash-0.jsonl.zst' },
      { instance: 'chdash-1', written_at: '2026-10-14T09:58:50Z', status: 'skipped', reason: 'invalid' },
    ];
    await open(page, '', server);
    // A conflict (its reason behind "Why") and a skipped file: two boxes above the tiles, amber, in a live region that waits its turn.
    await expect(page.locator('.mcpOverview__warnings .uiBanner--warn')).toHaveCount(2);
    await page.locator('.mcpOverview__warnings summary').click();
    await page.waitForTimeout(1200);
    expect(await axeViolations(page), 'the warnings').toEqual([]);
    // The list of the bar and the popover show the same two instances, each with a badge (skipped, conflict).
    await openPicker(page, 'instance');
    await expect(pickerMenu(page, 'instance').locator('.badge')).toHaveText(['conflict', 'skipped']);
    await page.waitForTimeout(300);
    expect(await axeViolations(page), 'the Instance list with its badges').toEqual([]);
    await page.keyboard.press('Escape');
    await page.locator('.mcpInstances__button').click();
    await expect(page.locator('.mcpInstancesPopover .badge')).toHaveText(['conflict', 'skipped']);
    await page.waitForTimeout(300);
    expect(await axeViolations(page), 'the instances popover with its badges').toEqual([]);
  });

  test(`axe (${theme}): the "Usage is off" state has no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    const server = newServer();
    setUsage(server, { enabled: false });
    await install(page, server);
    await page.goto('/mcp-integration/usage');
    await expect(page.locator('#mcpUsageOff')).toBeVisible();
    await page.waitForTimeout(1200);
    expect(await axeViolations(page)).toEqual([]);
  });
}

test('the tab is built for a screen reader: labelled regions, charts and tables, a scope on every header, one live region that says what a change found', async ({ page }) => {
  await open(page);
  await expect(page.locator('nav.mcpPage__nav')).toHaveCount(1);
  await expect(page.locator('.mcpOverview__tables table')).toHaveCount(4);
  expect(await page.locator('.mcpOverview__tables table').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Usage by key', 'Usage by method', 'Usage by result', 'Usage by client']);
  // Every column has a scope, every row a header (its first cell).
  expect(await page.locator('.mcpOverview__tables table').evaluateAll((els) => els.map((el) => [
    el.querySelectorAll('thead th[scope="col"]').length === el.querySelectorAll('thead th').length,
    [...el.querySelectorAll('tbody tr')].every((tr) => tr.firstElementChild.matches('th[scope="row"]')),
  ]))).toEqual([[true, true], [true, true], [true, true], [true, true]]);
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('role', 'list');
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('aria-label', 'Active filters');
  await expect(page.locator('.mcpOverview__tiles')).toHaveAttribute('aria-label', 'Totals');
  await expect(page.locator('.mcpBar__windows')).toHaveAttribute('aria-label', 'Window');
  // The four charts are sections named by their titles (headings under the one of the tab), each a group named for what it draws.
  await expect(page.locator('.mcpOverview__card')).toHaveCount(4);
  for (const id of CHARTS) {
    const heading = card(page, id).locator('h3.chartCard__title');
    await expect(card(page, id)).toHaveAttribute('aria-labelledby', await heading.getAttribute('id'));
    await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('role', 'group');
  }
  // Every legend entry is a button with its state; the entry of the folded groups is off.
  expect(await legend(page).evaluateAll((items) => items.map((item) => item.tagName + item.getAttribute('aria-pressed')))).toEqual(Array(8).fill('BUTTONfalse').concat(['BUTTONnull']));
  // The lists of the bar are dialogs of check boxes named by their label, the field that narrows them has a name, the count of a value is in
  // the name of its check box.
  const menu = await openPicker(page, 'method');
  await expect(menu).toHaveAttribute('aria-label', 'Method filter');
  await expect(menu.getByRole('checkbox', { name: /^query_table 754$/ })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Method' })).toBeVisible();
  await page.keyboard.press('Escape');
  // A change is said once, in the live region of the page, with what it found.
  await row(page, 'key', 'ops-all').click();
  await expect(page.locator('#uiLiveStatus')).toHaveText('1,012 requests in the last 7 days with these filters.');
  expect(await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((el) => el.id))).toEqual(['uiLiveStatus']);
});

// ---- the lists of the bar ----------------------------------------------------------------------------------------------------------

test('the Key list: the keys of the facet with their requests, a check box adds the key as a filter at once, and the page reads when the clicks pause', async ({ page }) => {
  const server = await open(page);
  const key = pickerButton(page, 'key');
  await expect(key).toHaveText('Key · All');
  await expect(key).toHaveAttribute('title', 'All keys');
  const menu = await openPicker(page, 'key');
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  // The keys that have requests, the most first, each with its requests; a deleted key has its badge; none is checked.
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['1,012', '41', '28', '20']);
  await expect(menu.locator('.mcpPicker__option', { hasText: 'old-bot' }).locator('.badge')).toHaveText('deleted');
  await expect(menu.locator('.mcpPicker__option .badge')).toHaveCount(1);
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'All keys' })).toBeVisible();
  // Four values are not a long list: the field that narrows one is not there.
  await expect(menu.locator('.mcpPicker__search')).toBeHidden();
  // A pick: the button, the chip and the checked box follow at once; the page reads when the clicks pause (a read and an entry of the history).
  const before = await page.evaluate(() => history.length);
  await menu.getByRole('checkbox', { name: /^ops-all/ }).check();
  await expect(key).toHaveText('Key · ops-all');
  await expect(key).toHaveAttribute('title', 'ops-all');
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await expect(menu).toBeVisible();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  await settled(page);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method&key=ops-all']);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  // The list stays open and keeps its values: it has every filter but its own, so the other keys can still be picked, and the check box is on.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ops-all/ })).toBeChecked();
  // Two picks that come together are one read and one entry of the history (the clicks of a person that ticks a few boxes).
  await menu.evaluate((el) => {
    for (const input of el.querySelectorAll('input[value="ui_0a1b2c3d4e5f"], input[value="ui_legacy000000"]')) input.click();
  });
  await expect(key).toHaveText('Key · 3 selected');
  // In the order of the picks (the check boxes are in the order of the list: legacy, then ci-bot).
  await expect(key).toHaveAttribute('title', 'ops-all, legacy, ci-bot');
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Key=legacy', 'Key=ci-bot']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all&key=ui_legacy000000&key=ui_0a1b2c3d4e5f$/);
  await settled(page);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method&key=ops-all', '?window=7d&group=method&key=ops-all&key=ui_legacy000000&key=ui_0a1b2c3d4e5f']);
  expect((await page.evaluate(() => history.length)) - before).toBe(2);
  // Picks that cancel out before the clicks pause leave the state as it was: no read and no entry of the history.
  await menu.evaluate((el) => { const input = el.querySelector('input[value="ui_dead00000001"]'); input.click(); input.click(); });
  await page.waitForTimeout(500);
  await expect(key).toHaveText('Key · 3 selected');
  expect(reads(server)).toHaveLength(3);
  expect((await page.evaluate(() => history.length)) - before).toBe(2);
  // Back: the address is the state, and the check boxes follow it.
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(key).toHaveText('Key · ops-all');
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&key=ops-all');
  const again = await openPicker(page, 'key');
  await expect(again.getByRole('checkbox', { name: /^ops-all/ })).toBeChecked();
  await expect(again.getByRole('checkbox', { name: /^ci-bot/ })).not.toBeChecked();
  await screenshot(page, 'usage-picker-key');
});

test('"All keys" clears the dimension, and the other lists follow what is picked: they have every filter but their own', async ({ page }) => {
  const server = await open(page, '?key=ui_0a1b2c3d4e5f');
  // The Client list has the key filter: the clients of ci-bot, with their requests in the window; the Method list the methods of ci-bot.
  const clients = await openPicker(page, 'client');
  await expect(clients.locator('.mcpPicker__name')).toHaveText(['claude-code', 'Visual Studio Code']);
  await expect(clients.locator('.mcpPicker__count')).toHaveText(['12', '8']);
  await page.keyboard.press('Escape');
  const methods = await openPicker(page, 'method');
  await expect(methods.locator('.mcpPicker__name')).toHaveText(['query_table', 'tools/list', 'initialize']);
  await page.keyboard.press('Escape');
  // The Key list has the other filters only: all the keys, the picked one checked.
  const keys = await openPicker(page, 'key');
  await expect(keys.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(keys.locator('input:checked')).toHaveCount(1);
  await expect(keyChecked(page, 'ui_0a1b2c3d4e5f')).toBeChecked();
  // "All keys" lets every key go: the button, the boxes, the chips and the address say it at once, the read follows.
  await keys.getByRole('button', { name: 'All keys' }).click();
  await expect(pickerButton(page, 'key')).toHaveText('Key · All');
  await expect(keys.locator('input:checked')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method');
  // The list stays open (the action is not a pick that closes it), and "All keys" with nothing picked reads nothing.
  await expect(keys).toBeVisible();
  const count = reads(server).length;
  await keys.getByRole('button', { name: 'All keys' }).click();
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
});

// The check box of a value in an open list.
const keyChecked = (page, value) => pickerMenu(page, 'key').locator(`input[value="${value}"]`);

test('the Method list: the tools, and the methods of the protocol muted; a pick is a filter of the methods', async ({ page }) => {
  const server = await open(page);
  const menu = await openPicker(page, 'method');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', 'unread', 'other']);
  await expect(menu.locator('.mcpPicker__count').first()).toHaveText('754');
  // A tool is read as a tool; the protocol methods, and the words that stand for a group of messages, are muted.
  expect(await menu.locator('.mcpPicker__option.is-muted .mcpPicker__name').allTextContents()).toEqual(['ping', 'tools/list', 'initialize', 'notifications/initialized', 'unread', 'other']);
  const weight = (name) => menu.locator('.mcpPicker__name', { hasText: new RegExp(`^${name}$`) }).evaluate((el) => getComputedStyle(el).color);
  expect(await weight('ping')).not.toBe(await weight('query_table'));
  await menu.getByRole('checkbox', { name: /^run_query/ }).check();
  await expect(pickerButton(page, 'method')).toHaveText('Method · run_query');
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&method=run_query');
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:run_query']);
  await expect(row(page, 'method', 'run_query')).toHaveClass(/is-selected/);
  // The chip, the check box and the row are one filter: the chip lets it go, and the box follows.
  await chips(page).first().locator('.chip__remove').click();
  await settled(page);
  await expect(pickerButton(page, 'method')).toHaveText('Method · All');
  const again = await openPicker(page, 'method');
  await expect(again.locator('input:checked')).toHaveCount(0);
});

test('the Client list: the clients with their requests, a name with spaces is one value, and the list has the filters of the other lists', async ({ page }) => {
  const server = await open(page);
  const menu = await openPicker(page, 'client');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['894', '130', '41', '28', '8']);
  await menu.getByRole('checkbox', { name: /^Visual Studio Code/ }).check();
  await expect(pickerButton(page, 'client')).toHaveText('Client · Visual Studio Code');
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&client=Visual+Studio+Code');
  await settled(page);
  expect(await tiles(page)).toMatchObject({ Requests: ['8', 'in the last 7 days'] });
  // The Key list now has the client filter: one key used this client (ci-bot), so there is nothing to choose from and the list is off (it says
  // the key, and why in its title); the table of the keys has that one line, which is not a filter. The Method list has the filter too: the
  // two methods that the client called.
  await page.keyboard.press('Escape');
  await expect(pickerButton(page, 'key')).toBeDisabled();
  await expect(pickerButton(page, 'key')).toHaveText('Key · ci-bot');
  await expect(pickerButton(page, 'key')).toHaveAttribute('title', 'Only one key in this view');
  await expect(block(page, 'keys').locator('tbody th')).toHaveText(['ci-bot']);
  await expect(block(page, 'keys').locator('tbody td').first()).toHaveText('8');
  const methods = await openPicker(page, 'method');
  await expect(methods.locator('.mcpPicker__name')).toHaveText(['tools/list', 'initialize']);
  await expect(methods.locator('.mcpPicker__count')).toHaveText(['5', '3']);
  await page.keyboard.press('Escape');
  // The check boxes of the Client list stay on, with the other clients still there to pick.
  const clients = await openPicker(page, 'client');
  await expect(clients.locator('.mcpPicker__name')).toHaveText(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  await expect(clients.locator('input:checked')).toHaveCount(1);
  // A second client: both, in the order of the picks (the first is the one of the address, the same order everywhere).
  await clients.getByRole('checkbox', { name: /^python-httpx/ }).check();
  await expect(pickerButton(page, 'client')).toHaveText('Client · 2 selected');
  await expect(pickerButton(page, 'client')).toHaveAttribute('title', 'Visual Studio Code, python-httpx');
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&client=Visual+Studio+Code&client=python-httpx');
  await settled(page);
});

test('a list of more than 12 values has a field that narrows it, and a dimension takes 20 values at most', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 30; i += 1) server.cells.push(cell(`bulk-${String(i).padStart(2, '0')}`, '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100));
  await open(page, '', server);
  const menu = await openPicker(page, 'key');
  // 34 keys have requests: the field is there, with a name and the shape of a search.
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(34);
  const search = menu.locator('.mcpPicker__search');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('aria-label', 'Filter the list of keys');
  await expect(search).toHaveAttribute('placeholder', 'Filter keys');
  // Typing narrows the list to the names that hold the text, whatever their case; a text that nothing holds says so.
  await search.fill('BULK-2');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(10);
  await expect(menu.locator('.mcpPicker__option:not([hidden]) .mcpPicker__name').first()).toHaveText('bulk-29');
  await search.fill('zzz');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('Nothing matches "zzz".');
  await search.fill('');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(34);
  await expect(menu.locator('.mcpPicker__none')).toBeHidden();
  // Enter in the field is no submit (no read of its own), and Down goes on to the first value that is shown.
  const count = reads(server).length;
  await search.fill('bulk-1');
  await search.press('Enter');
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
  await search.press('ArrowDown');
  await expect(menu.locator('.mcpPicker__option:not([hidden]) input').first()).toBeFocused();
  // 20 values at most: the 20th pick disables the boxes that are not checked, and says why; a box that is let go enables them again.
  await search.fill('');
  await menu.evaluate((el) => {
    for (const input of [...el.querySelectorAll('input[type="checkbox"]')].slice(0, 20)) input.click();
  });
  await expect(menu.locator('input:checked')).toHaveCount(20);
  await expect(menu.locator('input:disabled')).toHaveCount(14);
  await expect(menu.locator('input:checked:disabled')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__note')).toHaveText('A filter takes 20 values at most.');
  await expect(chips(page)).toHaveCount(20);
  await expect(pickerButton(page, 'key')).toHaveText('Key · 20 selected');
  await expect.poll(() => new URL(page.url()).searchParams.getAll('key').length).toBe(20);
  await settled(page);
  await menu.locator('input:checked').first().uncheck();
  await expect(menu.locator('input:disabled')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__note')).toBeHidden();
  await expect(chips(page)).toHaveCount(19);
});

test('a list opens, picks and closes from the keyboard, and the focus goes back to its button', async ({ page }) => {
  const server = await open(page);
  const key = pickerButton(page, 'key');
  await key.focus();
  // Down opens the list on its first control, "All keys"; Down again reaches the first value.
  await page.keyboard.press('ArrowDown');
  const menu = pickerMenu(page, 'key');
  await expect(menu).toBeVisible();
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'All keys' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(keyChecked(page, 'ops-all')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(keyChecked(page, 'ui_dead00000001')).toBeFocused();
  // Space ticks the box: the pick is at once (the button), the read when the clicks pause.
  await page.keyboard.press('Space');
  await expect(key).toHaveText('Key · old-bot');
  await expect(keyChecked(page, 'ui_dead00000001')).toBeChecked();
  await settled(page);
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&key=ui_dead00000001');
  await settled(page);
  // The box keeps the focus through the read that follows its pick (the list is not drawn again for it).
  await expect(keyChecked(page, 'ui_dead00000001')).toBeFocused();
  // Escape closes the list and gives the focus back to its button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(key).toHaveAttribute('aria-expanded', 'false');
  await expect(key).toBeFocused();
  // A press outside closes a list too, and one list is open at a time.
  await key.click();
  await expect(menu).toBeVisible();
  await pickerButton(page, 'method').click();
  await expect(pickerMenu(page, 'method')).toBeVisible();
  await expect(menu).toBeHidden();
  await page.locator('.mcpOverview__range').click();
  await expect(pickerMenu(page, 'method')).toBeHidden();
});

test('Group by is a list of its own like the Order by of System Queries: one choice, from the keyboard too, and it is not a filter', async ({ page }) => {
  const server = await open(page);
  await groupButton(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(groupOption(page, 'key')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  await expect(groupButton(page)).toBeFocused();
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=key');
  // It is an order: no chip, nothing in the count of filters that a phone shows.
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator('.mcpBar__groupPicker').locator('xpath=ancestor::div[contains(@class, "obsFilterBar__field")]')).toHaveAttribute('data-summary', 'off');
  // The page and its lists have no other control that groups: the chart has no switch of its own.
  await expect(page.locator('.mcpOverview__split')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Methods', exact: true })).toHaveCount(0);
});

// ---- a dimension that has nothing to choose from ----------------------------------------------------------------------------------------
// A dimension whose facet has fewer than two values, and no filter of its own, is not offered: its list in the bar is off and says the value (or
// none), the rows of its table are lines to read and the entries of a legend grouped by it are locked. A filter on the dimension keeps all of it
// offered, so that the filter can be taken off. (The legacy key has no address: its id is not `ui_` and 12 hexadecimal digits, which the page
// drops from an address as the server would refuse it, so a case that needs it picks it in a list.)

// What a list of the bar shows: its words, its title, whether it is off for the keyboard and for a screen reader.
const pickerState = (page, dimension) => pickerButton(page, dimension).evaluate((el) => ({
  text: el.textContent, title: el.title, disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), off: el.closest('.mcpPicker').classList.contains('is-disabled'),
}));
// What a row of a table says about being a filter.
const rowsOf = (page, id) => block(page, id).locator('tbody tr').evaluateAll((rows) => rows.map((tr) => ({
  pickable: tr.classList.contains('is-pickable'), tabindex: tr.getAttribute('tabindex'), dimension: tr.dataset.dimension ?? null, value: tr.dataset.value ?? null, selected: tr.getAttribute('aria-selected'),
})));
const hintHidden = (page, id) => block(page, id).locator('.mcpOverview__hint').isHidden();

test('one client is no choice: the Client list is off and says the client, its rows are lines to read, and the entries of a chart by client are locked', async ({ page }) => {
  const server = await open(page, '?group=client');
  // All the clients are offered until a key is picked: the legacy key is the one of python-httpx alone.
  expect(await pickerState(page, 'client')).toMatchObject({ text: 'Client · All', title: 'All clients', disabled: false, off: false });
  const keys = await openPicker(page, 'key');
  await keys.getByRole('checkbox', { name: /^legacy/ }).check();
  await page.keyboard.press('Escape');
  await expect(chips(page)).toHaveText(['Key=legacy']);
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=client&key=ui_legacy000000');
  await settled(page);
  // The list is off in its place: no arrow, dimmed, not in the tab order; it says the client, and its title says why.
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · python-httpx', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  await expect(pickerButton(page, 'client')).toBeDisabled();
  // The other lists have what to choose from (the key that was picked has three methods, and two instances are known).
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · legacy', disabled: false, off: false });
  expect(await pickerState(page, 'method')).toMatchObject({ text: 'Method · All', disabled: false });
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · All', disabled: false });
  // The row of the table of clients is a line to read: no class, no tab stop, no value, no mark, and its hint is gone; the other tables keep theirs.
  expect(await rowsOf(page, 'clients')).toEqual([{ pickable: false, tabindex: null, dimension: null, value: null, selected: null }]);
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['python-httpx 0.27.0']);
  expect(await hintHidden(page, 'clients')).toBe(true);
  for (const id of ['keys', 'methods', 'results']) {
    expect(await hintHidden(page, id), id).toBe(false);
    expect((await rowsOf(page, id)).every((item) => item.pickable && item.dimension), id).toBe(true);
  }
  // A click on it filters nothing: no chip beyond the key's, no read.
  const count = server.calls.length;
  await block(page, 'clients').locator('tbody tr').click();
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(1);
  expect(server.calls).toHaveLength(count);
  // The four charts are grouped by client: the one entry of each legend is locked (a button that is off, no aria-pressed, a title that says why).
  for (const id of CHARTS) {
    await expect(legend(page, id), id).toHaveCount(1);
    await expect(entry(page, 'client:python-httpx', id), id).toBeDisabled();
    await expect(entry(page, 'client:python-httpx', id), id).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(entry(page, 'client:python-httpx', id), id).toHaveAttribute('title', 'Only one client in this view');
  }
  // It cannot be pressed: not by a click either, and the address and the chips are as they were.
  await entry(page, 'client:python-httpx').click({ force: true });
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(1);
  expect(server.calls).toHaveLength(count);
  expect(new URL(page.url()).searchParams.getAll('client')).toEqual([]);
  await screenshot(page, 'usage-one-client');
});

test('a dimension that has one value only is a line in a table and a list that is off, from the address too: the key of a deleted bot has one client, unknown', async ({ page }) => {
  // The address route to a single value: the deleted key made its requests with a client that said nothing about itself.
  await open(page, '?key=ui_dead00000001');
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · unknown', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · old-bot', title: 'old-bot', disabled: false });
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['unknown']);
  expect(await rowsOf(page, 'clients')).toEqual([{ pickable: false, tabindex: null, dimension: null, value: null, selected: null }]);
  // The key was picked: its own table keeps all the keys to pick from, and a filter keeps its list a list.
  expect((await rowsOf(page, 'keys')).filter((item) => item.pickable)).toHaveLength(4);
  await expect(row(page, 'key', 'ui_dead00000001')).toHaveAttribute('aria-selected', 'true');
});

test('ping has one key and one client: their lists are off, the lists that have a choice stay, and Tab goes past the lists that are off', async ({ page }) => {
  await open(page, '?method=ping');
  // The protocol method ping was sent by ops-all, through claude-code, and ended ok: three dimensions with one value each.
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ops-all', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · claude-code', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  // The method has a filter, so its list stays a list (to take ping off); both instances are known, so that list stays too.
  expect(await pickerState(page, 'method')).toMatchObject({ text: 'Method · ping', title: 'ping', disabled: false, off: false });
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · All', title: 'All instances', disabled: false, off: false });
  // The tables follow: the keys, the results and the clients are lines to read (one each), the methods are rows to pick (the filter is on).
  for (const id of ['keys', 'results', 'clients']) {
    const rows = await rowsOf(page, id);
    expect(rows, id).toHaveLength(1);
    expect(rows[0].pickable, id).toBe(false);
    expect(await hintHidden(page, id), id).toBe(true);
  }
  expect((await rowsOf(page, 'methods')).every((item) => item.pickable), 'methods').toBe(true);
  expect(await hintHidden(page, 'methods')).toBe(false);
  await expect(block(page, 'keys').locator('tbody th')).toHaveText(['ops-all']);
  await expect(block(page, 'results').locator('tbody th')).toHaveText(['ok']);
  // From Group by the keyboard goes to the Method list, then the Instance list, and is not stopped by the two lists that are off.
  await groupButton(page).focus();
  await page.keyboard.press('Tab');
  await expect(pickerButton(page, 'method')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pickerButton(page, 'instance')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(windowButton(page, '1 h')).toBeFocused();
  // And back: Shift+Tab from the window to the Instance list, the Method list, then Group by (a list that is off is not a stop either way).
  await page.keyboard.press('Shift+Tab');
  await expect(pickerButton(page, 'instance')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pickerButton(page, 'method')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(groupButton(page)).toBeFocused();
});

test('a filter on a dimension keeps it offered, so that it can be taken off: the list, the row and the legend entry work, and go off with the filter', async ({ page }) => {
  // ci-bot made all the requests of Visual Studio Code: with the key and the client picked, the key has one value in its facet, and a filter.
  await open(page, '?group=key&key=ui_0a1b2c3d4e5f&client=Visual%20Studio%20Code');
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ci-bot', title: 'ci-bot', disabled: false, ariaDisabled: 'false', off: false });
  const menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ci-bot/ })).toBeChecked();
  await page.keyboard.press('Escape');
  // Its table has the one key as a row to pick (it is marked, and it lets the filter go), its hint is there, and the legend entry is a button that is pressed.
  expect(await rowsOf(page, 'keys')).toEqual([{ pickable: true, tabindex: '0', dimension: 'key', value: 'ui_0a1b2c3d4e5f', selected: 'true' }]);
  expect(await hintHidden(page, 'keys')).toBe(false);
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toBeEnabled();
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('aria-pressed', 'true');
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('title', 'Stop filtering by key ci-bot');
  // The chip lets the key go: the client picked still leaves one key, so the dimension is not offered any more.
  await page.getByRole('button', { name: 'Remove filter Key = ci-bot' }).click();
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await settled(page);
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ci-bot', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await rowsOf(page, 'keys')).toEqual([{ pickable: false, tabindex: null, dimension: null, value: null, selected: null }]);
  expect(await hintHidden(page, 'keys')).toBe(true);
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toBeDisabled();
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('title', 'Only one key in this view');
  // And the same dimension is offered again as soon as the answer has a second value: the client filter taken off lists all the keys.
  await page.getByRole('button', { name: 'Remove filter Client = Visual Studio Code' }).click();
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · All', title: 'All keys', disabled: false, off: false });
  expect((await rowsOf(page, 'keys')).every((item) => item.pickable)).toBe(true);
  await expect(entry(page, 'key:ops-all')).toBeEnabled();
});

test('unticking the last value of an open list keeps the list open, as it was; it is off once it closes', async ({ page }) => {
  await open(page, '?key=ui_0a1b2c3d4e5f&client=Visual%20Studio%20Code');
  const key = pickerButton(page, 'key');
  const menu = await openPicker(page, 'key');
  await menu.getByRole('checkbox', { name: /^ci-bot/ }).uncheck();
  // The filter is gone and the dimension has one value: the list does not shut under the pointer. The page reads without the key filter.
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await expect.poll(() => new URL(page.url()).searchParams.getAll('key')).toEqual([]);
  await settled(page);
  await expect(menu).toBeVisible();
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(key).toBeEnabled();
  await expect(key).toHaveText('Key · All');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ci-bot/ })).not.toBeChecked();
  // The next pick is still possible: ticking the key puts the filter back (and the list is what it was).
  await menu.getByRole('checkbox', { name: /^ci-bot/ }).check();
  await expect(chips(page)).toHaveText(['Key=ci-bot', 'Client=Visual Studio Code']);
  await settled(page);
  await expect(menu).toBeVisible();
  await expect(key).toHaveText('Key · ci-bot');
  await expect(key).toBeEnabled();
  // Unticked again, and closed: the list is off, in its place, and says the key.
  await menu.getByRole('checkbox', { name: /^ci-bot/ }).uncheck();
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await settled(page);
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ci-bot', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
});

test('a list that is open when its dimension has no value any more stays open and says so; it reads none once it closes', async ({ page }) => {
  const server = await open(page);
  const menu = await openPicker(page, 'method');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(10);
  // The next answer has no request at all. The page reads again from the code of the button (a press outside the list would close it, as it does).
  server.cells = [];
  await page.evaluate(() => document.querySelector('#mcpRefresh').click());
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('No methods in this view.');
  await expect(menu).toBeVisible();
  await expect(pickerButton(page, 'method')).toBeEnabled();
  // Closed, the list is off in its place and says none; the lists that were not open were off already.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await pickerState(page, 'method')).toEqual({ text: 'Method · none', title: 'No method in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · none', disabled: true });
});

// ---- the instances ----------------------------------------------------------------------------------------------------------------------
// ChDash instances that share the usage directory add up (docs/mcp-integration-page.md, "Instances"). The fake has two: chdash-0, this one
// (918 of the 1,101 requests of the last 7 days), and chdash-1 (183); `server.instances` is the state of each file, `oneInstance(server)` leaves one.

const instanceRows = (page) => page.locator('.mcpInstancesPopover .mcpInstancesList__row');
const popoverBadges = (page) => page.locator('.mcpInstancesPopover .badge');
const openInstances = async (page) => {
  await page.locator('.mcpInstances__button').click();
  await expect(page.locator('.mcpInstancesPopover')).toBeVisible();
  return page.locator('.mcpInstancesPopover');
};
// The state of the files of the instances: chdash-0 (this one) and the others as `others` says ([name, status, reason]).
const filesOf = (me, others) => [
  { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: me[0], reason: me[1] },
  ...others.map(([instance, status, reason], i) => ({ instance, written_at: status === 'ok' ? '2026-10-14T09:58:50Z' : `2026-10-14T0${i + 1}:00:00Z`, status, reason })),
];

test('the Instance list: every instance with its requests, the other filters cut the counts but not the instances, and a pick is a filter', async ({ page }) => {
  const server = await open(page);
  const instance = pickerButton(page, 'instance');
  await expect(instance).toHaveText('Instance · All');
  await expect(instance).toHaveAttribute('title', 'All instances');
  const menu = await openPicker(page, 'instance');
  // The two instances that the server knows, the one with the most requests first, each with its requests in the window; none is checked, and
  // two values are not a long list (no field to narrow it).
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183']);
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(menu.locator('.badge')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'All instances' })).toBeVisible();
  await expect(menu.locator('.mcpPicker__search')).toBeHidden();
  await expect(menu).toHaveAttribute('aria-label', 'Instance filter');
  await expect(menu.getByRole('group', { name: 'Instance' })).toBeVisible();
  await expect(menu.getByRole('checkbox', { name: /^chdash-1 183$/ })).toBeVisible();
  // A pick: the button, the chip and the address follow at once, the page reads when the clicks pause, and every figure has the filter.
  await menu.getByRole('checkbox', { name: /^chdash-1/ }).check();
  await expect(instance).toHaveText('Instance · chdash-1');
  await expect(instance).toHaveAttribute('title', 'chdash-1');
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await settled(page);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method&instance=chdash-1']);
  expect(await tiles(page)).toMatchObject({ Requests: ['183', 'in the last 7 days'], 'Active keys': ['2', 'of 5 keys'] });
  // The list has every filter but its own: the instance that is picked does not cut it, both are still there to pick, with their counts.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183']);
  await expect(menu.getByRole('checkbox', { name: /^chdash-1/ })).toBeChecked();
  // The other lists have the filter of the instance: the keys that wrote to chdash-1 (ops-all and legacy), the clients and the methods too.
  await page.keyboard.press('Escape');
  const keys = await openPicker(page, 'key');
  await expect(keys.locator('.mcpPicker__name')).toHaveText(['ops-all', 'legacy']);
  await expect(keys.locator('.mcpPicker__count')).toHaveText(['155', '28']);
  await page.keyboard.press('Escape');
  // And the other way round: a key cuts the counts of the instances, not the instances. ops-all has 857 requests in chdash-0 and 155 in chdash-1.
  await chips(page).first().locator('.chip__remove').click();
  await settled(page);
  await row(page, 'key', 'ops-all').click();
  await settled(page);
  const again = await openPicker(page, 'instance');
  await expect(again.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(again.locator('.mcpPicker__count')).toHaveText(['857', '155']);
  // A key that never wrote to an instance leaves it listed, with 0 (the server lists every instance that it knows): the legacy key wrote to
  // chdash-1 only (28 requests), so chdash-0 is last.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove filter Key = ops-all' }).click();
  await settled(page);
  await row(page, 'key', 'ui_legacy000000').click();
  await expect(chips(page)).toHaveText(['Key=legacy']);
  await settled(page);
  const none = await openPicker(page, 'instance');
  await expect(none.locator('.mcpPicker__name')).toHaveText(['chdash-1', 'chdash-0']);
  await expect(none.locator('.mcpPicker__count')).toHaveText(['28', '0']);
  await screenshot(page, 'usage-picker-instance');
});

test('"All instances" clears the filter, and an instance whose file is not read has its badge in the list, with the reason in its title', async ({ page }) => {
  const server = newServer();
  server.instances = filesOf(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'too_large']]);
  await open(page, '?instance=chdash-1', server);
  const menu = await openPicker(page, 'instance');
  // The two files are not read the same way: the one of this instance is in conflict (another ChDash writes under its name), the other is skipped.
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveText('conflict');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveText('skipped');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveAttribute('title', 'Another ChDash writes as chdash-0: this instance does not save its counts.');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveAttribute('title', 'chdash-1: its file was skipped (too large), so its counts are not in these figures.');
  // "All instances" lets the filter go: the button, the box, the chip and the address say it at once, the read follows.
  await expect(menu.getByRole('checkbox', { name: /^chdash-1/ })).toBeChecked();
  await menu.getByRole('button', { name: 'All instances' }).click();
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All');
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method');
  await expect(menu).toBeVisible();
});

test('a crowd of instances: the list has a field that narrows it past 12, and takes 20 values at most', async ({ page }) => {
  // 25 instances share the directory, each with requests of its own (chdash-24 has the most).
  const server = newServer();
  server.instances = Array.from({ length: 25 }, (_, i) => ({ instance: `chdash-${i}`, written_at: '2026-10-14T09:59:00Z', status: 'ok', reason: '' }));
  server.cells = server.instances.map(({ instance }, i) => cell('ops-all', '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100, instance));
  await open(page, '', server);
  await expect(page.locator('.mcpInstances__button')).toHaveText('25 instances');
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(25);
  await expect(menu.locator('.mcpPicker__name').first()).toHaveText('chdash-24');
  await expect(menu.locator('.mcpPicker__count').first()).toHaveText('25');
  const search = menu.locator('.mcpPicker__search');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('aria-label', 'Filter the list of instances');
  await expect(search).toHaveAttribute('placeholder', 'Filter instances');
  // Typing narrows the list to the names that hold the text, whatever the case; a text that nothing holds says so.
  await search.fill('CHDASH-2');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(6);
  await expect(menu.locator('.mcpPicker__option:not([hidden]) .mcpPicker__name')).toHaveText(['chdash-24', 'chdash-23', 'chdash-22', 'chdash-21', 'chdash-20', 'chdash-2']);
  await search.fill('zzz');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('Nothing matches "zzz".');
  await search.fill('');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(25);
  // Enter in the field is no submit, and Down goes on to the first value that is shown.
  const count = reads(server).length;
  await search.fill('chdash-1');
  await search.press('Enter');
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
  await search.press('ArrowDown');
  await expect(menu.locator('.mcpPicker__option:not([hidden]) input').first()).toBeFocused();
  // 20 values at most: the 20th pick disables the boxes that are not checked, and says why; a box that is let go enables them again.
  await search.fill('');
  await menu.evaluate((el) => {
    for (const input of [...el.querySelectorAll('input[type="checkbox"]')].slice(0, 20)) input.click();
  });
  await expect(menu.locator('input:checked')).toHaveCount(20);
  await expect(menu.locator('input:disabled')).toHaveCount(5);
  await expect(menu.locator('input:checked:disabled')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__note')).toHaveText('A filter takes 20 values at most.');
  await expect(chips(page)).toHaveCount(20);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · 20 selected');
  await expect.poll(() => new URL(page.url()).searchParams.getAll('instance').length).toBe(20);
  await settled(page);
  expect(reads(server).at(-1).split('&').filter((part) => part.startsWith('instance=')).length).toBe(20);
  await menu.locator('input:checked').first().uncheck();
  await expect(menu.locator('input:disabled')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__note')).toBeHidden();
  await expect(chips(page)).toHaveCount(19);
  // The note of the head says how many instances there are, and the popover has each of them.
  await page.keyboard.press('Escape');
  await openInstances(page);
  await expect(instanceRows(page)).toHaveCount(25);
  await expect(instanceRows(page).first()).toHaveAttribute('data-instance', 'chdash-0');
});

test('the Instance list picks like the others: ticks that come together are one read and one entry of the history, ticks that cancel out are none, and the keyboard opens it, picks and closes it', async ({ page }) => {
  const server = await open(page);
  const instance = pickerButton(page, 'instance');
  const box = (value) => pickerMenu(page, 'instance').locator(`input[value="${value}"]`);
  const before = await page.evaluate(() => history.length);
  const menu = await openPicker(page, 'instance');
  // Two ticks that come together (a person ticking a few boxes) are one read and one entry of the history.
  await menu.evaluate((el) => { for (const input of el.querySelectorAll('input[type="checkbox"]')) input.click(); });
  await expect(instance).toHaveText('Instance · 2 selected');
  await expect(instance).toHaveAttribute('title', 'chdash-0, chdash-1');
  await expect(chips(page)).toHaveText(['Instance=chdash-0', 'Instance=chdash-1']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-0&instance=chdash-1$/);
  await settled(page);
  expect(reads(server)).toEqual(['?window=7d&group=method', '?window=7d&group=method&instance=chdash-0&instance=chdash-1']);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  // A box ticked and cleared before the clicks pause leaves the state as it was: no read and no entry of the history.
  await menu.evaluate((el) => { const input = el.querySelector('input[value="chdash-1"]'); input.click(); input.click(); });
  await page.waitForTimeout(500);
  await expect(instance).toHaveText('Instance · 2 selected');
  expect(reads(server)).toHaveLength(2);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  await page.keyboard.press('Escape');
  // From the keyboard: Down opens the list on its first control, "All instances", and Down again reaches the first value, which Space ticks.
  await page.goto('/mcp-integration/usage');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await instance.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeVisible();
  await expect(instance).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'All instances' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(box('chdash-0')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(box('chdash-1')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(instance).toHaveText('Instance · chdash-1');
  await expect(box('chdash-1')).toBeChecked();
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&instance=chdash-1');
  await settled(page);
  // The box keeps the focus through the read that follows its pick, and Escape gives the focus back to the button.
  await expect(box('chdash-1')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(instance).toHaveAttribute('aria-expanded', 'false');
  await expect(instance).toBeFocused();
});

test('one instance is no choice: the Instance list is off and says it, nothing says "instances", and a conflict is still a warning', async ({ page }) => {
  const server = oneInstance(newServer());
  await open(page, '', server);
  // Everything is that one instance's: the figures are the same, the list is off in its place (no arrow, dimmed, not a stop of the keyboard).
  expect(await pickerState(page, 'instance')).toEqual({ text: 'Instance · chdash-0', title: 'Only one instance in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  await expect(pickerButton(page, 'key')).toBeEnabled();
  // Fewer than two instances: nothing is summed, so the head has no "N instances" and no warning is shown.
  await expect(page.locator('.mcpInstances')).toBeHidden();
  await expect(page.locator('.mcpInstances__button')).toBeHidden();
  await expect(page.locator('.mcpOverview__head')).not.toContainText('instances');
  await expect(page.locator('.mcpOverview__warnings')).toBeHidden();
  await expect(page.locator('.mcpOverview__warnings .uiBanner')).toHaveCount(0);
  // The keyboard goes past the list that is off, from the Client list to the window.
  await pickerButton(page, 'client').focus();
  await page.keyboard.press('Tab');
  await expect(windowButton(page, '1 h')).toBeFocused();
  // A conflict is about this instance: another ChDash writes under its name, so its counts are not saved. It shows even with one instance.
  const conflict = oneInstance(newServer());
  conflict.instances[0] = { ...conflict.instances[0], status: 'conflict', reason: 'another process writes chdash-0.jsonl.zst' };
  await open(page, '', conflict);
  await expect(page.locator('.mcpOverview__warnings .uiBanner--warn .uiBanner__text')).toHaveText('Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).');
  await expect(page.locator('.mcpOverview__warnings .uiBanner__summary')).toHaveText('Why');
  await expect(page.locator('.mcpInstances')).toBeHidden();
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · chdash-0', disabled: true });
});

test('the instance is in the address: read on load, in the order of the dimensions, written by a change, taken off by its chip, walked by Back and Forward', async ({ page }) => {
  // The address names the instance after the key and before the result; the chips and the reads have the order of the dimensions.
  const server = await open(page, '?result=ok&instance=chdash-1&key=ops-all');
  expect(reads(server)).toEqual(['?window=7d&group=method&key=ops-all&instance=chdash-1&result=ok']);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Instance = chdash-1', 'Remove filter Result = ok']);
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Instance=chdash-1', 'Result=ok']);
  await expect(chips(page).nth(1)).toHaveAttribute('title', 'Instance = chdash-1');
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  // ops-all in chdash-1 that ended ok: 150 requests (155 less the 5 of run_query that ended in sql_error).
  expect(await tiles(page)).toMatchObject({ Requests: ['150', 'in the last 7 days'] });
  // An address that has nothing to fix is left as it was written; a change writes it in the order of the dimensions.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?result=ok&instance=chdash-1&key=ops-all$/);
  await windowButton(page, '24 h').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all&instance=chdash-1&result=ok$/);
  await settled(page);
  // The chip lets the instance go: the address and the list follow.
  await page.getByRole('button', { name: 'Remove filter Instance = chdash-1' }).click();
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Result=ok']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all&result=ok$/);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&group=method&key=ops-all&result=ok');
  // All six dimensions in an address, in no order: the chips, and the reads that the page makes, have the order of the dimensions, the instance
  // between the client and the result.
  await page.goto('/mcp-integration/usage?type=call&result=ok&instance=chdash-1&client=claude-code&method=query_table&key=ops-all');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = query_table', 'Remove filter Client = claude-code', 'Remove filter Instance = chdash-1', 'Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&key=ops-all&method=query_table&client=claude-code&instance=chdash-1&result=ok&type=call');
  // A fresh load of an address with the instance reads it.
  await page.goto('/mcp-integration/usage?instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  // Back and Forward walk through it: a pick in the list is an entry of the history.
  const menu = await openPicker(page, 'instance');
  await menu.getByRole('checkbox', { name: /^chdash-0/ }).check();
  await expect(chips(page)).toHaveText(['Instance=chdash-1', 'Instance=chdash-0']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1&instance=chdash-0$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&instance=chdash-1&instance=chdash-0');
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&instance=chdash-1');
  expect(await tiles(page)).toMatchObject({ Requests: ['183', 'in the last 7 days'] });
  await page.goForward();
  await expect(chips(page)).toHaveText(['Instance=chdash-1', 'Instance=chdash-0']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · 2 selected');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&instance=chdash-1&instance=chdash-0');
});

test('an instance that the page cannot use is dropped from the address at load: its characters, its length, a repeat, and more than 20 of them', async ({ page }) => {
  // An instance is 1 to 64 characters of letters, digits, dot, hyphen and underscore (the name of its file): a space, a slash, a name of 65.
  const server = await open(page, `?instance=bad%20name&instance=chdash-1&instance=a%2Fb&instance=chdash-1&instance=${'x'.repeat(65)}&instance=old_node.2-a&instance=${'y'.repeat(64)}`);
  // The valid ones stay, once each, in the order that the address gave; the address is replaced, not pushed, and the page reads once, for them.
  await expect(page).toHaveURL(new RegExp(`/mcp-integration/usage\\?instance=chdash-1&instance=old_node\\.2-a&instance=${'y'.repeat(64)}$`));
  expect(reads(server)).toEqual([`?window=7d&group=method&instance=chdash-1&instance=old_node.2-a&instance=${'y'.repeat(64)}`]);
  expect(await chipLabels(page)).toEqual(['Remove filter Instance = chdash-1', 'Remove filter Instance = old_node.2-a', `Remove filter Instance = ${'y'.repeat(64)}`]);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  // A kind of filter takes 20 values: the 20 first of 25 stay.
  const many = Array.from({ length: 25 }, (_, i) => `node-${String(i).padStart(2, '0')}`);
  const other = newServer();
  await install(page, other);
  await page.goto(`/mcp-integration/usage?${many.map((name) => `instance=${name}`).join('&')}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.getAll('instance')).toEqual(many.slice(0, 20));
  expect(reads(other)).toEqual([`?window=7d&group=method&${many.slice(0, 20).map((name) => `instance=${name}`).join('&')}`]);
  // The instance is a filter and not a group of the charts (the bar groups by key, method or client): `group=instance` is a group that the bar does
  // not offer, so it is dropped, and the filter stays.
  await page.goto('/mcp-integration/usage?group=instance&instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await expect(groupButton(page)).toHaveText('Group by · Method');
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  expect(reads(other).at(-1)).toBe('?window=7d&group=method&instance=chdash-1');
  // An address with nothing to fix is left as it was written.
  await page.goto('/mcp-integration/usage?instance=chdash-0&instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-0&instance=chdash-1$/);
  await expect(chips(page)).toHaveText(['Instance=chdash-0', 'Instance=chdash-1']);
});

test('"2 instances" in the head is a button that opens the list of the instances: this one first, when each wrote and its requests in the view; Escape closes it and the focus goes back', async ({ page }) => {
  const server = await open(page, '?key=ops-all');
  const button = page.locator('.mcpInstances__button');
  // After the title and the dates, in the head of the tab: a button that opens a dialog.
  await expect(button).toHaveText('2 instances');
  await expect(button).toHaveAttribute('type', 'button');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveAttribute('title', 'The usage is summed over 2 instances. Open the list.');
  const [title, range, note] = await page.locator('#mcpOverviewTitle, .mcpOverview__range, .mcpInstances__button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  expect(title).toBeLessThan(range);
  expect(range).toBeLessThan(note);
  const popover = await openInstances(page);
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expect(popover).toHaveAttribute('aria-label', 'Instances of the usage');
  await expect(popover).toBeFocused();
  await expect(popover.locator('.mcpInstancesList__lead')).toHaveText('The usage is summed over 2 instances: each one saves the file of its own in the usage directory and reads the files of the others.');
  await expect(popover.getByRole('list', { name: 'Instances' })).toBeVisible();
  const rows = instanceRows(page);
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll((els) => els.map((el) => [el.dataset.instance, el.dataset.status]))).toEqual([['chdash-0', 'ok'], ['chdash-1', 'ok']]);
  // This one first, and marked; each says when its file was last written (from the time of the answer, with the exact time in its title) and its
  // requests in this view, which has the filter of the key: 857 in chdash-0 and 155 in chdash-1.
  await expect(rows.nth(0).locator('code')).toHaveText('chdash-0');
  await expect(rows.nth(0).locator('.mcpInstancesList__name')).toContainText('this instance');
  await expect(rows.nth(1).locator('.mcpInstancesList__name')).not.toContainText('this instance');
  await expect(rows.nth(0).locator('.mcpInstancesList__meta')).toHaveText('wrote 30 s ago · 857 requests');
  await expect(rows.nth(1).locator('.mcpInstancesList__meta')).toHaveText('wrote 1 min ago · 155 requests');
  await expect(rows.nth(0).locator('.mcpInstancesList__meta')).toHaveAttribute('title', /^2026-10-14T09:59:30\.000Z/);
  await expect(popover.locator('.badge')).toHaveCount(0);
  // Escape closes it, and the keyboard is back on the button.
  await page.keyboard.press('Escape');
  await expect(page.locator('.mcpInstancesPopover')).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  // The button opens and closes it; a press outside closes it too.
  await button.click();
  await expect(popover).toBeVisible();
  await button.click();
  await expect(popover).toHaveCount(0);
  await button.click();
  await expect(popover).toBeVisible();
  await page.locator('.mcpOverview__range').click();
  await expect(popover).toHaveCount(0);
  // A list that is open follows the next answer, and the focus stays where it was: chdash-1 has no request any more when the page reads again.
  await button.click();
  await expect(popover).toBeFocused();
  server.cells = server.cells.filter((item) => item.instance !== 'chdash-1');
  await page.evaluate(() => document.querySelector('#mcpRefresh').click());
  await expect(rows.nth(1).locator('.mcpInstancesList__meta')).toHaveText('wrote 1 min ago · 0 requests');
  await expect(rows.nth(0).locator('.mcpInstancesList__meta')).toHaveText('wrote 30 s ago · 857 requests');
  await expect(popover).toBeVisible();
  await expect(popover).toBeFocused();
});

// ---- the warnings about the files that are not read ----------------------------------------------------------------------------------------

const warnings = (page) => page.locator('.mcpOverview__warnings .uiBanner');

test('a skipped file is a warning above the tiles, a notice that waits its turn; it comes from the answer, so no filter takes it away or draws it again', async ({ page }) => {
  const server = newServer();
  server.instances = filesOf(['ok', ''], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  // One box: amber (the level warn of the banner), a status and not an alert, with the sentence and no "Why" (a skipped file has no more to say).
  await expect(warnings(page)).toHaveCount(1);
  await expect(warnings(page)).toHaveClass(/uiBanner--warn/);
  await expect(warnings(page)).toHaveAttribute('role', 'status');
  await expect(warnings(page).locator('.uiBanner__text')).toHaveText('chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  await expect(warnings(page).locator('details')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__warnings')).toBeVisible();
  // Above the tiles, under the head of the tab.
  const stack = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return { head: box('.mcpOverview__head').bottom, warning: [box('.mcpOverview__warnings').top, box('.mcpOverview__warnings').bottom], tiles: box('.mcpOverview__tiles').top };
  });
  expect(stack.warning[0]).toBeGreaterThanOrEqual(stack.head - 0.5);
  expect(stack.warning[1]).toBeLessThanOrEqual(stack.tiles + 0.5);
  // The note of the head and its list say the same: the instance has the badge, and the reason in a word.
  const popover = await openInstances(page);
  await expect(instanceRows(page).nth(1)).toHaveAttribute('data-status', 'skipped');
  await expect(instanceRows(page).nth(1).locator('.badge')).toHaveText('skipped');
  await expect(instanceRows(page).nth(1).locator('.badge')).toHaveAttribute('title', 'chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  await expect(instanceRows(page).nth(1).locator('.mcpInstancesList__name')).toContainText('invalid');
  await expect(instanceRows(page).nth(0).locator('.badge')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  // The warning is the answer's `instances`, which the filters do not cut: it is there after each change, and it is the same box (a box that was
  // drawn again would not have the mark).
  await warnings(page).evaluate((el) => { el.dataset.mark = 'first'; });
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await expect(warnings(page)).toHaveCount(1);
  await expect(warnings(page)).toHaveAttribute('data-mark', 'first');
  const menu = await openPicker(page, 'instance');
  await menu.getByRole('checkbox', { name: /^chdash-0/ }).check();
  await expect(chips(page)).toHaveCount(2);
  await settled(page);
  await expect(warnings(page)).toHaveAttribute('data-mark', 'first');
  await expect(warnings(page).locator('.uiBanner__text')).toHaveText('chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  await page.keyboard.press('Escape');
  // With the filter of the instance, the file that is left out stays listed in the list of the bar, with its badge.
  const again = await openPicker(page, 'instance');
  await expect(again.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveText('skipped');
});

test('a conflict is a warning of its own, with the reason of the server behind "Why", and its instance has the badge in the lists', async ({ page }) => {
  const server = newServer();
  server.instances = filesOf(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'ok', '']]);
  await open(page, '', server);
  await expect(warnings(page)).toHaveCount(1);
  await expect(warnings(page)).toHaveClass(/uiBanner--warn/);
  await expect(warnings(page)).toHaveAttribute('role', 'status');
  await expect(warnings(page).locator('.uiBanner__text')).toHaveText('Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).');
  // The reason is behind "Why": closed at first, the sentence of the server when it opens.
  const why = warnings(page).locator('details');
  await expect(why.locator('summary')).toHaveText('Why');
  await expect(why).not.toHaveAttribute('open', /.*/);
  await expect(why.locator('.uiBanner__more')).toBeHidden();
  await why.locator('summary').click();
  await expect(why.locator('.uiBanner__more')).toBeVisible();
  await expect(why.locator('.uiBanner__more')).toHaveText('another process writes chdash-0.jsonl.zst');
  // The popover has the badge on this instance, with the sentence in its title (the reason of a conflict is too long for a word).
  await openInstances(page);
  await expect(instanceRows(page).nth(0)).toHaveAttribute('data-status', 'conflict');
  await expect(instanceRows(page).nth(0).locator('.badge')).toHaveText('conflict');
  await expect(instanceRows(page).nth(0).locator('.badge')).toHaveAttribute('title', 'Another ChDash writes as chdash-0: this instance does not save its counts.');
  await expect(instanceRows(page).nth(0).locator('.mcpInstancesList__name')).not.toContainText('another process');
  // A filter keeps the warning, open as it was (the box is not drawn again).
  await page.keyboard.press('Escape');
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await expect(why).toHaveAttribute('open', /.*/);
  await expect(why.locator('.uiBanner__more')).toBeVisible();
});

test('several skipped files are one sentence that names the first three, a conflict is another warning above it, and the list of the instances has each file', async ({ page }) => {
  const server = newServer();
  server.instances = filesOf(['ok', ''], [
    ['chdash-1', 'ok', ''], ['chdash-2', 'skipped', 'invalid'], ['chdash-3', 'skipped', 'too_large'], ['chdash-4', 'skipped', 'invalid'],
    ['chdash-5', 'skipped', 'too_large'], ['chdash-6', 'skipped', 'invalid'],
  ]);
  await open(page, '', server);
  await expect(page.locator('.mcpInstances__button')).toHaveText('7 instances');
  await expect(warnings(page)).toHaveCount(1);
  await expect(warnings(page).locator('.uiBanner__text')).toHaveText('5 instance files were skipped, so their counts are not in these figures: chdash-2 (invalid), chdash-3 (too large), chdash-4 (invalid) and 2 more.');
  // The list has each of the seven, with the reason of a skipped file in a word.
  await openInstances(page);
  await expect(instanceRows(page)).toHaveCount(7);
  expect(await instanceRows(page).evaluateAll((els) => els.map((el) => `${el.dataset.instance} ${el.dataset.status}`))).toEqual([
    'chdash-0 ok', 'chdash-1 ok', 'chdash-2 skipped', 'chdash-3 skipped', 'chdash-4 skipped', 'chdash-5 skipped', 'chdash-6 skipped',
  ]);
  await expect(popoverBadges(page)).toHaveText(['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  await expect(instanceRows(page).nth(3).locator('.mcpInstancesList__name')).toContainText('too large');
  await page.keyboard.press('Escape');
  // Two skipped files make the plural of two, and a conflict is its own warning, first.
  const some = newServer();
  some.instances = filesOf(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'ok', ''], ['chdash-2', 'skipped', 'invalid'], ['chdash-3', 'skipped', 'too_large']]);
  await open(page, '', some);
  await expect(warnings(page)).toHaveCount(2);
  await expect(warnings(page).locator('.uiBanner__text')).toHaveText([
    'Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).',
    '2 instance files were skipped, so their counts are not in these figures: chdash-2 (invalid), chdash-3 (too large).',
  ]);
});

test('a warning moves nothing when a filter changes: the tiles, the cards and the tables stand where they stood, while the read runs and once it is drawn', async ({ page }) => {
  // A conflict and a skipped file: two boxes above the tiles, from the first answer to the last. They are in the answer's `instances`, so a
  // filter neither shows nor hides them, and the walk through the five ways to change a filter finds everything where it was.
  const server = newServer();
  server.instances = filesOf(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  await expect(warnings(page)).toHaveCount(2);
  await warnings(page).evaluateAll((els) => els.forEach((el, i) => { el.dataset.mark = String(i); }));
  const base = await layout(page);
  // The tiles stand under the two boxes: lower than they do with no warning, by their height and their gap.
  const box = await page.locator('.mcpOverview__warnings').evaluate((el) => el.getBoundingClientRect().height);
  expect(box).toBeGreaterThan(40);
  await walkFilters(page, server, base, async () => {
    // Drawn for each step, and each time the same two boxes, in the same place.
    await expect(warnings(page)).toHaveCount(2);
    await expect(warnings(page).first()).toHaveAttribute('data-mark', '0');
    await expect(warnings(page).last()).toHaveAttribute('data-mark', '1');
    expect(await page.locator('.mcpOverview__warnings').evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(box, 0);
  });
});

test('a phone: "2 instances" has a line of its own, its list opens inside the window, and the warnings fit it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = newServer();
  server.instances = filesOf(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  // The head wraps on a phone: the dot that stands before "2 instances" on a desktop is gone (it would hang at the end of a line), and the note
  // begins a line of its own, under the title and the dates.
  await expect(page.locator('.mcpInstances__sep')).toBeHidden();
  const head = await page.locator('.mcpOverview__head').evaluate((el) => {
    const box = (node) => node.getBoundingClientRect();
    return { left: box(el).left, range: box(el.querySelector('.mcpOverview__range')), note: box(el.querySelector('.mcpInstances__button')) };
  });
  expect(Math.abs(head.note.left - head.left)).toBeLessThanOrEqual(1);
  expect(head.note.top).toBeGreaterThanOrEqual(head.range.bottom - 1);
  // The list opens inside the window, and nothing of it is wider than it is.
  const popover = await openInstances(page);
  const inside = await popover.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, right: box.right, clipped: el.scrollWidth - el.clientWidth, rows: [...el.querySelectorAll('.mcpInstancesList__row')].map((item) => item.scrollWidth - item.clientWidth), width: document.documentElement.clientWidth };
  });
  expect(inside.left).toBeGreaterThanOrEqual(0);
  expect(inside.right).toBeLessThanOrEqual(inside.width);
  expect(inside.clipped).toBeLessThanOrEqual(0);
  expect(inside.rows).toEqual([0, 0]);
  await page.keyboard.press('Escape');
  // The two warnings (a conflict, a skipped file) are boxes as wide as the window at most, and the page has no sideways scroll.
  const boxes = await warnings(page).evaluateAll((els) => els.map((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, clipped: el.scrollWidth - el.clientWidth })));
  expect(boxes).toHaveLength(2);
  for (const item of boxes) {
    expect(item.left).toBeGreaterThanOrEqual(0);
    expect(item.right).toBeLessThanOrEqual(390);
    expect(item.clipped).toBeLessThanOrEqual(0);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
