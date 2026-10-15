import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';
import { chartJson } from '../helpers/charts.js';
import { fetchedModules } from '../helpers/modules.js';
import { CELLS, install, newServer, overviewOf } from '../helpers/mcp-fake.js';

// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab"): what every key did,
// cut by key, method, result and type. The server side is the in-memory server of helpers/mcp-fake.js, which computes the answers of
// GET /api/mcp/usage/overview from a small list of cells by the rules of the contract (the tables, the series, `rest` and the filters are
// real), so the page is tested against behaviour and not against one frozen answer. mcp-contract.spec.js compares that answer with the real one.
// The cells of the fake: 1,101 requests in the last 7 days (889 tool calls, 11 errors, 3 refused), four keys of five (one deleted), ten methods,
// six results, three clients; the last answer is at 2026-10-14T10:00:00Z, so "1 h ago" reads the same whatever the clock.

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
const legend = (page) => page.locator('.mcpOverview__chart .chartCore__legendItem');
const legendIds = (page) => legend(page).evaluateAll((items) => items.map((item) => item.dataset.series));
const entry = (page, id) => page.locator(`.mcpOverview__chart .chartCore__legendItem[data-series="${id}"]`);
const pressedWindow = (page) => page.locator('.mcpOverview__windows [aria-pressed="true"]');
const pressedSplit = (page) => page.locator('.mcpOverview__split [aria-pressed="true"]');
const splitButton = (page, name) => page.locator('.mcpOverview__split').getByRole('button', { name });
const windowButton = (page, name) => page.locator('.mcpOverview__windows').getByRole('button', { name });
const block = (page, id) => page.locator(`.mcpOverview__block:has(#mcpOverviewTitle-${id})`);
const swatch = (page, id) => entry(page, id).locator('i').evaluate((el) => getComputedStyle(el).backgroundColor);

async function screenshot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: false });
}

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
  for (const name of ['app_page_mcpusage.js', 'app_mcp_overview.js', 'app_mcp_view.js', 'app_chart_core.js', 'app_api.js']) expect(state.scripts, name).toContain(name);
  for (const name of ['app_page_mcp.js', 'app_mcp_form.js', 'app_mcp_usage.js', 'app_ui_dialog.js', 'app_logs.js', 'app_system_view.js', 'app_explorer.js', 'app_ui_filterbar.js']) expect(state.scripts, name).not.toContain(name);
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
  // The row is the nav row of the page, as System's is: as tall as it, under the header, the content under it.
  const nav = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      height: box('.mcpPage__nav').height,
      top: box('.mcpPage__nav').top - box('body > .appHeader').bottom,
      panelTop: box('#mcpPanel').top - box('.mcpPage__nav').bottom,
      // --shell-top (app_dom.js) is the bottom of the header and of the nav row: what a drawer or a panel starts under.
      shellTop: parseFloat(document.documentElement.style.getPropertyValue('--shell-top')) - box('.mcpPage__nav').bottom,
    };
  });
  expect(Math.round(nav.height)).toBe(40);
  expect(Math.abs(nav.top)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(nav.panelTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(nav.shellTop)).toBeLessThanOrEqual(1);
  // The link of the row opens the Keys page, which has the same row with Keys current, and back.
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  await expect(page.locator('#mcpTabs a.contentTabs__tab')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Keys');
  await expect(page.locator('#mcpTab-keys')).toHaveClass(/is-active/);
  await expect(page.locator('#mcpTab-usage')).not.toHaveClass(/is-active/);
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await page.locator('#mcpTab-usage').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
});

test('the last 7 days: the totals as tiles, the requests over time, a table for each dimension, read once', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toEqual(['?window=7d&split=method']);
  expect(server.calls.filter((call) => call.path === '/meta')).toHaveLength(1);
  await expect(page.locator('#mcpOverviewTitle')).toHaveText('Usage of all keys');
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 8 00:00 → Oct 14 10:00');
  await expect(page.locator('.mcpOverview__windows [data-window]')).toHaveText(['24 h', '7 d', '30 d', '90 d']);
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
  // The chart: the requests by method over the 7 UTC days, the 8 biggest methods and the others as "2 more".
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by method');
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the UTC day');
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveAttribute('data-type', 'bar');
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveAttribute('aria-label', 'Requests by method over time');
  expect(await legendIds(page)).toEqual(['method:query_table', 'method:ping', 'method:list_hosts', 'method:tools/list', 'method:run_query', 'method:describe_table', 'method:initialize', 'method:notifications/initialized', '~rest']);
  await expect(legend(page).locator('span')).toHaveText(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', '2 more']);
  await expect(legend(page).locator('b')).toHaveText(['754', '100', '75', '65', '35', '25', '23', '20', '4']);
  // The four tables, each in the order of its default sort.
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_legacy000000', 'ui_0a1b2c3d4e5f']);
  expect(await picked(page, 'method')).toEqual(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', 'unread', 'other']);
  expect(await picked(page, 'result')).toEqual(['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', '413_payload_too_large', 'rpc_error_32601']);
  const clients = block(page, 'clients').locator('tbody tr');
  await expect(clients.locator('th')).toHaveText(['claude-code 2.1.3', 'python-httpx/0.27.0', 'mcp-inspector 0.14.0']);
  // By key: the name and a badge on the deleted key; the figures of the key, its share of the calls, the errors with their share.
  const keys = block(page, 'keys');
  await expect(keys.locator('thead th')).toHaveText(['Key', 'Requests', 'Calls', 'Errors', '429', 'Avg time', 'Returned', 'Last used']);
  await expect(row(page, 'key', 'ui_dead00000001').locator('.badge')).toHaveText('deleted');
  await expect(row(page, 'key', 'ops-all').locator('td')).toHaveText(['1,012', '812', '7 0.69%', '0', '18 ms', '1.1 MB', '1 h ago']);
  await expect(row(page, 'key', 'ui_legacy000000').locator('td').nth(3)).toHaveText('2');
  await expect(row(page, 'key', 'ui_legacy000000').locator('td').nth(3).locator('.mcpWarn')).toHaveText('2');
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f').locator('th')).toHaveText('ci-bot');
  await expect(row(page, 'key', 'ui_0a1b2c3d4e5f').locator('td').nth(6)).toHaveText('22 h ago');
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
  // The clients: the name and version, or the User-Agent of a client that has none; keys, requests, first and last seen.
  await expect(clients.nth(0).locator('td')).toHaveText(['2', '920', 'Oct 1 09:00', '2 min ago']);
  await expect(clients.nth(1).locator('th code')).toHaveAttribute('title', 'python-httpx/0.27.0');
  await expect(block(page, 'clients')).toContainText('A client is counted since it was first seen');
  await expect(page.locator('.mcpOverview__notes')).toContainText('an API tool counts no row.');
  // A row that a click can filter is a row of the keyboard; the clients are not.
  await expect(dataRows(page, 'key').first()).toHaveAttribute('tabindex', '0');
  await expect(clients.first()).not.toHaveAttribute('tabindex', /.*/);
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
  const reporting = { key: 'ui_111111111111', at: Date.parse('2026-10-13T09:00:00Z'), kind: 'call', method: 'list_hosts', result: 'ok', count: 4, ms: 8, max: 3, rows: 0, bytes: 900 };
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
    const gone = keys.find((row) => row.deleted_at);
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

test('the legend is the filter of the split: a pressed entry dims the others at once, then the chart keeps the groups that are picked', async ({ page }) => {
  const server = newServer();
  await open(page, '', server);
  // The entries read at full strength while nothing is picked (the text colour, no strike).
  const strength = () => legend(page).evaluateAll((items) => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--text)';
    const text = getComputedStyle(probe).color;
    probe.remove();
    return Object.fromEntries(items.map((item) => [item.dataset.series, getComputedStyle(item).color === text && !item.classList.contains('is-off') ? 'full' : 'dim']));
  });
  const real = (all) => Object.entries(all).filter(([id]) => id !== '~rest');
  await expect.poll(async () => real(await strength()).every(([, state]) => state === 'full')).toBe(true);
  await expect(legend(page).first()).toHaveAttribute('title', /^Filter by method query_table$/);
  // A click presses the entry, and the others dim before the answer comes.
  server.delay['GET /usage/overview'] = 700;
  await entry(page, 'method:ping').click();
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'true');
  await expect(entry(page, 'method:ping')).toHaveAttribute('title', /^Stop filtering by method ping$/);
  await expect.poll(async () => {
    const all = await strength();
    return all['method:ping'] === 'full' && real(all).filter(([id]) => id !== 'method:ping').every(([, state]) => state === 'dim');
  }).toBe(true);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?method=ping$/);
  await expect(chips(page)).toHaveCount(1);
  expect(reads(server)).toEqual(['?window=7d&split=method', '?window=7d&split=method&method=ping']);
  // The answer: the groups are the values that are picked, and every figure of the page has the filter.
  await expect(legend(page)).toHaveCount(1);
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:ping']);
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'true');
  expect((await strength())['method:ping']).toBe('full');
  expect(await tiles(page)).toMatchObject({ Requests: ['100', 'in the last 7 days'], 'Tool calls': ['0', '0% of the requests'], 'Active keys': ['1', 'of 5 keys'] });
  // The keyboard stays on the entry that was pressed, and a second press lets it go.
  await expect(entry(page, 'method:ping')).toBeFocused();
  server.delay['GET /usage/overview'] = 0;
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(legend(page)).toHaveCount(9);
  await settled(page);
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'false');
  await expect(entry(page, 'method:ping')).toBeFocused();
  expect(Object.values(await strength()).filter((state) => state === 'dim')).toEqual([]);
});

test('"N more" holds the groups that the chart folds together, and is not a filter', async ({ page }) => {
  const server = await open(page);
  const more = entry(page, '~rest');
  await expect(more).toHaveText('2 more4');
  await expect(more).toBeDisabled();
  await expect(more).not.toHaveAttribute('aria-pressed', /.*/);
  await expect(more).toHaveAttribute('title', '2 more methods that the chart folds together: pick them in the table');
  // The folded groups are in the table, and a row filters by them.
  await row(page, 'method', 'unread').click();
  await expect(chips(page)).toHaveCount(1);
  expect(await chipLabels(page)).toEqual(['Remove filter Method = unread']);
  // The chart with the picked groups has no "N more".
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

test('a group keeps its colour: it comes from its name, not from its rank, in every window and under every filter', async ({ page }) => {
  await open(page);
  const hosts = await swatch(page, 'method:list_hosts');
  expect((await legendIds(page)).indexOf('method:list_hosts')).toBe(2);
  // The key of the legacy client: list_hosts is the first method of the chart there, with the same colour.
  await row(page, 'key', 'ui_legacy000000').click();
  await expect(legend(page)).toHaveCount(3);
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:list_hosts', 'method:unread', 'method:other']);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another window: the same.
  await windowButton(page, '24 h').click();
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the hour');
  await settled(page);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another split has its own groups.
  await splitButton(page, 'Results').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by result');
  await expect(legend(page).locator('span')).toHaveText(['ok', '429_rate_limited', 'rpc_error_32601']);
});

test('filters are chips: a legend entry, a row and a chip add them, a chip removes one, "Clear filters" all of them', async ({ page }) => {
  const server = await open(page);
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  // A row of a table picks its value. The chips say it, the address keeps it, and the page reads again with the filter.
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await expect(chips(page).first()).toHaveText('Key=ops-all');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  expect(reads(server).at(-1)).toBe('?window=7d&split=method&key=ops-all');
  // One chip has no "Clear filters": removing it is as short.
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await row(page, 'method', 'list_hosts').click();
  await settled(page);
  await row(page, 'result', 'ok').click();
  await expect(chips(page)).toHaveCount(3);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = list_hosts', 'Remove filter Result = ok']);
  await expect(page).toHaveURL(/\?key=ops-all&method=list_hosts&result=ok$/);
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  // Every figure follows: 50 requests (list_hosts of ops-all, 40 and 10), one key, the clients of the key.
  expect(await tiles(page)).toMatchObject({ Requests: ['50', 'in the last 7 days'], 'Active keys': ['1', 'of 5 keys'] });
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['claude-code 2.1.3', 'mcp-inspector 0.14.0']);
  // A type is a chip too, with its name for the reader.
  await splitButton(page, 'Type').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by type');
  await expect(legend(page).locator('span')).toHaveText(['Tool calls']);
  await entry(page, 'type:call').click();
  await expect(chips(page)).toHaveCount(4);
  await settled(page);
  expect((await chipLabels(page)).at(-1)).toBe('Remove filter Type = Tool calls');
  await expect(chips(page).last()).toHaveAttribute('title', 'Tool calls: A call of a tool (tools/call)');
  await expect(page).toHaveURL(/\?split=type&key=ops-all&method=list_hosts&result=ok&type=call$/);
  // A chip goes with its x, and the keyboard moves on to the chip that takes its place.
  await chips(page).nth(1).locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(3);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(2);
  await settled(page);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  // "Clear filters" takes all of them away at once: the split stays.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?split=type$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&split=type');
  await expect(pressedSplit(page)).toHaveText('Type');
  await expect(pressedWindow(page)).toBeFocused();
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
  // The clients have the key and nothing else.
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['claude-code 2.1.3']);
  // A picked value that nothing matches (a key that was never used) is in its table at 0, marked, with the name of the key on its chip.
  await page.goto('/mcp-integration/usage?key=ui_111111111111');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  expect(await picked(page, 'key')).toEqual(['ops-all', 'ui_dead00000001', 'ui_legacy000000', 'ui_0a1b2c3d4e5f', 'ui_111111111111']);
  await expect(row(page, 'key', 'ui_111111111111').locator('td').first()).toHaveText('0');
  await expect(row(page, 'key', 'ui_111111111111')).toHaveClass(/is-selected/);
  await expect(chips(page).first()).toHaveText('Key=reporting');
  // A method that nobody called (a made-up name in the address) has its row, with no time; it is a tool until the server says more.
  await page.goto('/mcp-integration/usage?method=nothing');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect((await picked(page, 'method')).at(-1)).toBe('nothing');
  await expect(row(page, 'method', 'nothing')).toHaveClass(/is-selected/);
  await expect(row(page, 'method', 'nothing').locator('th code')).toHaveText('nothing');
  await expect(row(page, 'method', 'nothing').locator('td')).toHaveText(['0', '0', '—', '—', '0 B', '0']);
  // Nothing has the method: the keys say so, and the chart says that no request has all the filters.
  await expect(block(page, 'keys').locator('.mcpOverview__none')).toHaveText('No key sent a request in this view.');
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  expect(await legendIds(page)).toEqual([]);
});

test('a row filters by a click and by the keyboard, and the keyboard stays on the row after the page read again', async ({ page }) => {
  const server = await open(page);
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
  expect(reads(server).at(-1)).toBe('?window=7d&split=method&key=ui_dead00000001');
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
  await header('clients', 'Requests').getByRole('button').click();
  await expect(block(page, 'clients').locator('tbody th')).toHaveText(['claude-code 2.1.3', 'mcp-inspector 0.14.0', 'python-httpx/0.27.0']);
  // Sorting is not a read, and not an address: it stays for the visit, whatever the filters do.
  expect(reads(server)).toHaveLength(1);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await row(page, 'result', 'ok').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  // The keys that have the result, by their time as the sort says: a tie keeps the order of the answer.
  expect(await picked(page, 'key')).toEqual(['ui_legacy000000', 'ui_dead00000001', 'ui_0a1b2c3d4e5f', 'ops-all']);
  await expect(header('keys', 'Avg time')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header('clients', 'Requests')).toHaveAttribute('aria-sort', 'descending');
});

test('a long table is a box of its own: the rows scroll under the head, and the page stays short', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 60; i += 1) {
    server.cells.push({ key: `bulk-${String(i).padStart(2, '0')}`, at: Date.parse('2026-10-14T08:00:00Z'), kind: 'call', method: 'query_table', result: 'ok', count: 1 + i, ms: 5, max: 5, rows: 1, bytes: 100 });
  }
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
    const row = el.querySelector('tbody tr:last-child').getBoundingClientRect();
    const frame = el.getBoundingClientRect();
    return row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1;
  });
  expect(inside).toBe(true);
  // Another table of the page is not pushed out of reach: the methods are on the first screens.
  const reach = await block(page, 'methods').evaluate((el) => el.getBoundingClientRect().top);
  expect(reach).toBeLessThan(1400);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, 'usage-long');
});

test('the address is the state: window, split and filters are read on load and written by every change', async ({ page }) => {
  const server = await open(page, '?window=30d&split=key&key=ops-all&method=query_table');
  // Read once, as the address says.
  expect(reads(server)).toEqual(['?window=30d&split=key&key=ops-all&method=query_table']);
  await expect(pressedWindow(page)).toHaveText('30 d');
  await expect(pressedSplit(page)).toHaveText('Keys');
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = query_table']);
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by key');
  await expect(row(page, 'key', 'ops-all')).toHaveClass(/is-selected/);
  await expect(row(page, 'method', 'query_table')).toHaveClass(/is-selected/);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  // Counted since the first start with the file: a window older than that says so.
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  // A reload keeps all of it.
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(reads(server).at(-1)).toBe('?window=30d&split=key&key=ops-all&method=query_table');
  await expect(pressedWindow(page)).toHaveText('30 d');
  expect(await chipLabels(page)).toHaveLength(2);
  // A change writes the address (the defaults stay out of it).
  await windowButton(page, '7 d').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?split=key&key=ops-all&method=query_table$/);
  await settled(page);
  await splitButton(page, 'Methods').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all&method=query_table$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&split=method&key=ops-all&method=query_table');
});

test('Back and Forward walk through the filters, the window and the split', async ({ page }) => {
  const server = await open(page);
  await row(page, 'key', 'ops-all').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  await splitButton(page, 'Results').click();
  await expect(pressedSplit(page)).toHaveText('Results');
  await settled(page);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&split=result&key=ops-all$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all$/);
  await expect(pressedSplit(page)).toHaveText('Methods');
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&split=method&key=ops-all');
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the hour');
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&split=method');
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  // Forward comes back to each.
  await page.goForward();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&split=result&key=ops-all$/);
  await expect(pressedSplit(page)).toHaveText('Results');
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by result');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&split=result&key=ops-all');
});

test('an address that the page cannot use is fixed at load: no window it does not keep, no split it does not know, no value the server refuses', async ({ page }) => {
  // key=ui_zzzzzzzzzzzz has the shape of the id of a key made on the page, but its digits are not hexadecimal: the server answers 400 for it.
  const server = await open(page, '?window=48h&split=nope&key=BAD!&key=ui_zzzzzzzzzzzz&key=ui_0a1b&method=a%20b&type=call&type=call&result=ok&unknown=1');
  // The values that are fine stay; the address is replaced, not pushed, and the page reads once, for the fixed state.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?result=ok&type=call$/);
  expect(reads(server)).toEqual(['?window=7d&split=method&result=ok&type=call']);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(pressedSplit(page)).toHaveText('Methods');
  expect(await chipLabels(page)).toEqual(['Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  // The entry was replaced, not pushed: the page has one entry of the history.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  // A kind of filter takes 20 values: the 20 first stay.
  const many = Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const other = newServer();
  await install(page, other);
  await page.goto(`/mcp-integration/usage?${many.map((name) => `method=${name}`).join('&')}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.getAll('method')).toEqual(many.slice(0, 20));
  expect(reads(other)).toEqual([`?window=7d&split=method&${many.slice(0, 20).map((name) => `method=${name}`).join('&')}`]);
  // A window that the retention does not keep is the default one (the meta lists the windows that it keeps).
  const short = newServer({ meta: { usage: { persisted: true, retention_days: 7, windows: ['24h', '7d'], default_window: '24h', since: '2026-10-01T08:00:00Z', cost_windows: ['24h', '7d'] } } });
  await open(page, '?window=90d', short);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpOverview__windows [data-window]')).toHaveText(['24 h', '7 d']);
  await expect(pressedWindow(page)).toHaveText('24 h');
  expect(reads(short)).toEqual(['?window=24h&split=method']);
});

test('the window and the split: another window reads again by the hour or the day, the split names its own groups', async ({ page }) => {
  const server = await open(page);
  await windowButton(page, '30 d').click();
  await expect(pressedWindow(page)).toHaveText('30 d');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=30d&split=method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=30d$/);
  expect((await tiles(page)).Requests).toEqual(['1,207', 'in the last 30 days']);
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the UTC day');
  await windowButton(page, '24 h').click();
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the hour');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&split=method');
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 13 11:00 → Oct 14 10:00');
  expect((await tiles(page)).Requests).toEqual(['750', 'in the last 24 hours']);
  // The split by key names the keys (not their ids); by type, the kinds of request in words; by result, the codes.
  await expect(page.locator('.mcpOverview__split button')).toHaveText(['Keys', 'Methods', 'Results', 'Type']);
  await splitButton(page, 'Keys').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by key');
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=24h&split=key');
  expect(await legendIds(page)).toEqual(['key:ops-all', 'key:ui_legacy000000', 'key:ui_0a1b2c3d4e5f']);
  await expect(legend(page).locator('span')).toHaveText(['ops-all', 'legacy', 'ci-bot']);
  await splitButton(page, 'Type').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by type');
  await expect(legend(page).locator('span')).toHaveText(['Tool calls', 'Protocol', 'Rate limited']);
  await expect(legend(page).locator('b')).toHaveText(['539', '209', '2']);
  await expect(entry(page, 'type:request')).toHaveAttribute('title', /^Filter by type Protocol\nA request of the MCP protocol/);
  await splitButton(page, 'Results').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by result');
  await expect(legend(page).locator('span')).toHaveText(['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', 'rpc_error_32601']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&split=result$/);
  // The Type split gives the type that is picked its name in the chip.
  await splitButton(page, 'Type').click();
  await expect(page.locator('.mcpOverview__card .chartCard__title')).toHaveText('Requests by type');
  await entry(page, 'type:limited').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Type = Rate limited']);
  expect(await tiles(page)).toMatchObject({ Requests: ['2', 'in the last 24 hours'], Refused: ['2', '2 by the rate limit'] });
  await screenshot(page, 'usage-type');
});

test('hovering a bar reads its bucket: the UTC day, or the hour, with the groups that have requests and the total', async ({ page }) => {
  await open(page);
  const hover = async (ms) => {
    const at = await page.evaluate((t) => window.ChDash.chartCore.of(document.querySelector('.mcpOverview__chart')).toClient(t, 10), ms);
    await page.mouse.move(at.x, at.y);
  };
  const tip = page.locator('.mcpOverview__chart .chartCore__tooltip');
  // The last day: the groups with a request, the biggest first, then "2 more", then the total (the sum of the groups).
  await hover(Date.UTC(2026, 9, 14, 12));
  await expect(tip).toBeVisible();
  await expect(tip.locator('strong')).toHaveText('2026-10-14 (UTC)');
  await expect(tip.locator('.chartCore__tipRow:not(.chartCore__tipRow--total) em')).toHaveText(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'initialize', '2 more']);
  await expect(tip.locator('.chartCore__tipRow:not(.chartCore__tipRow--total) b')).toHaveText(['402', '100', '65', '60', '35', '20', '3']);
  await expect(tip.locator('.chartCore__tipRow--total b')).toHaveText('685');
  // A day with one group shows that group; a day with nothing says so.
  await hover(Date.UTC(2026, 9, 9, 12));
  await expect(tip.locator('strong')).toHaveText('2026-10-09 (UTC)');
  await expect(tip.locator('.chartCore__tipRow em')).toHaveText(['list_hosts']);
  await hover(Date.UTC(2026, 9, 10, 12));
  await expect(tip.locator('.chartCore__tipRow em')).toHaveText(['No value']);
  // Hours: the range of the hour, in the local time of the browser (UTC here).
  await windowButton(page, '24 h').click();
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the hour');
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 30));
  await expect(tip.locator('strong')).toHaveText('Oct 14 09:00 → 10:00');
  await expect(tip.locator('.chartCore__tipRow--total b')).toHaveText('622');
  await screenshot(page, 'usage-hover');
});

// The axis of the shared engine puts a tick where its labels keep apart: on a wide screen a chart of seven days has a tick every 6 h. A bar is
// a day, so its labels are the dates (the option xDateOnly of the engine: one line, a date for each tick of a midnight), and the chart by the
// hour keeps its hours, with the date under the first of a day.
test('a chart by the UTC day is labelled by its dates, never by hours; the chart by the hour keeps its hours', async ({ page }) => {
  await open(page);
  const root = page.locator('.mcpOverview__chart .chartCore');
  // [label, date line] of each label drawn (data-x-ticks).
  const axis = async () => (await chartJson(root, 'data-x-ticks')).map(([label, context]) => [label, context]);
  const DATE = /^[A-Z][a-z]{2} \d{1,2}$/;
  const HOUR = /^\d\d:\d\d$/;
  // Seven days from Oct 8: a label for each day at 1920 and 1440 px (a tick every 6 h and every 12 h before) and at 820, and none under it.
  const days = ['Oct 8', 'Oct 9', 'Oct 10', 'Oct 11', 'Oct 12', 'Oct 13', 'Oct 14', 'Oct 15'];
  for (const width of [1920, 1440, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await axis()).map(([label]) => label), { message: `${width} px` }).toEqual(days);
    expect((await axis()).filter(([, context]) => context), `${width} px: a date line`).toEqual([]);
  }
  // A phone has room for fewer: some of the days, all of them dates.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await axis()).length, { message: '390 px' }).toBeGreaterThanOrEqual(3);
  expect((await axis()).filter(([label, context]) => !DATE.test(label) || context), '390 px').toEqual([]);
  // The longer windows are by the day too: dates (a week or a month apart where the days do not fit), and no hour.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ['30 d', '90 d']) {
    await windowButton(page, name).click();
    await expect(pressedWindow(page)).toHaveText(name);
    await settled(page);
    await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the UTC day');
    await expect.poll(async () => (await axis()).length, { message: name }).toBeGreaterThanOrEqual(4);
    expect((await axis()).filter(([label, context]) => !DATE.test(label) || context), name).toEqual([]);
  }
  // By the hour: the hours, and the date under the first label and under midnight.
  await windowButton(page, '24 h').click();
  await expect(page.locator('.mcpOverview__card .chartCard__meta')).toHaveText('by the hour');
  await settled(page);
  await expect.poll(async () => (await axis()).length, { message: '24 h' }).toBeGreaterThanOrEqual(8);
  const hours = await axis();
  expect(hours.filter(([label]) => !HOUR.test(label)), '24 h').toEqual([]);
  expect(hours.map(([, context]) => context).filter(Boolean).map((context) => context.replace(/ \d{4}$/, '')), '24 h: the dates under the hours').toEqual(['Oct 13', 'Oct 14']);
});

test('an empty window says so, and a filter that matches nothing offers to clear them', async ({ page }) => {
  const server = newServer();
  server.cells = [];
  await open(page, '', server);
  // Nothing counted: the tiles say 0 and the chart says why; the tables say what they list; the clients are not of the window.
  expect(await tiles(page)).toMatchObject({ Requests: ['0', 'in the last 7 days'], 'Tool calls': ['0', ''], 'Call time': ['—', ''], Returned: ['0 B', ''], 'Active keys': ['0', 'of 5 keys'] });
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__title')).toHaveText('No request in the last 7 days');
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__body')).toHaveText('Nothing was counted in this window.');
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__chart .uiState button')).toHaveCount(0);
  await expect(block(page, 'keys').locator('.mcpOverview__none')).toHaveText('No key sent a request in this view.');
  await expect(block(page, 'methods').locator('.mcpOverview__none')).toHaveText('No method was called in this view.');
  await expect(block(page, 'results').locator('.mcpOverview__none')).toHaveText('No result in this view.');
  await expect(block(page, 'clients').locator('tbody tr')).toHaveCount(3);
  await expect(block(page, 'keys').locator('.pagePart__count')).toHaveText('');
  // With a filter: the same, and "Clear filters" takes it away.
  await page.goto('/mcp-integration/usage?method=run_query&window=24h');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  await expect(page.locator('.mcpOverview__chart .uiState--empty .uiState__body')).toHaveText('Nothing in the last 24 hours matches them.');
  server.cells = CELLS();
  await page.locator('.mcpOverview__chart .uiState button').click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h$/);
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(1);
  await expect(pressedWindow(page)).toBeFocused();
  await screenshot(page, 'usage-empty');
});

test('an answer that fails says so with Try again, and the window can still change', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage/overview'] = { status: 503, body: { error_code: 'server_busy', message: 'Too many heavy requests.', retryable: true } };
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  const failed = page.locator('.mcpOverview__state .uiState--error');
  await expect(failed).toBeVisible();
  await expect(failed.locator('.uiState__title')).toHaveText('The usage cannot be read');
  await expect(failed.locator('.uiState__body')).toHaveText('Too many heavy requests.');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
  // The row, the title and the window are there: the person can pick another window.
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(pressedWindow(page)).toHaveText('7 d');
  // Try again reads again (the next answer is fine).
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(failed).toHaveCount(0);
  expect(reads(server)).toEqual(['?window=7d&split=method', '?window=7d&split=method']);
  // A failure after a success: the figures go, the error shows, and another window reads again.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('.mcpOverview__state .uiState--error .uiState__body')).toHaveText('The usage could not be read.');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
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
  await page.locator('#mcpState').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('#mcpState')).toBeHidden();
});

test('the counting says since when: in memory since the start of ClickHouse Dash, and what an answer left out of its tables', async ({ page }) => {
  const server = newServer();
  server.meta.usage = { ...server.meta.usage, persisted: false, since: '2026-10-14T08:00:00Z' };
  server.overview = (srv, params) => {
    const answer = overviewOf(srv, params);
    if (answer.status === 200) answer.body.omitted = { keys: 0, methods: 12, results: 0, clients: 3 };
    return answer;
  };
  await open(page, '', server);
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted in memory since Oct 14 08:00, when ClickHouse Dash started: a restart clears it.');
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 14 08:00 → 10:00');
  // The rows that the server cut: "N more not shown" under the table, nothing under the others.
  await expect(block(page, 'methods').locator('.mcpNote--fine').first()).toHaveText('12 more methods not shown.');
  await expect(block(page, 'clients').locator('.mcpNote--fine').first()).toHaveText('3 more clients not shown.');
  await expect(block(page, 'keys').locator('.mcpNote--fine')).toBeHidden();
  await expect(block(page, 'results').locator('.mcpNote--fine')).toBeHidden();
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
  expect(reads(server)).toEqual(['?window=7d&split=method', '?window=7d&split=method']);
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
  await expect(page.locator('.mcpOverview__range')).toHaveText('Oct 13 11:00 → Oct 14 10:00');
  expect((await tiles(page)).Requests).toEqual(['702', 'in the last 24 hours']);
  expect(reads(server).at(-1)).toBe('?window=24h&split=method&key=ops-all');
});

test('a page restored from the back/forward cache reads again', async ({ page }) => {
  const server = await open(page);
  const before = reads(server).length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => reads(server).length).toBeGreaterThan(before);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(await chipLabels(page)).toEqual([]);
});

test('desktop and phone: the page has no sideways scroll at 1920, 1440, 1280, 1100 and 390 px, and the tables fit their boxes where there is room', async ({ page }) => {
  await open(page, '?key=ops-all');
  for (const [width, height] of [[1920, 1000], [1440, 900], [1280, 800], [1100, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.mcpOverview__chart .chartCore')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await horizontalOverflow(page), `${width}: the page`).toBeLessThanOrEqual(0);
    const m = await page.evaluate(() => {
      const panel = document.querySelector('#mcpPanel');
      return {
        panel: panel.scrollWidth - panel.clientWidth,
        // A table that is wider than its box scrolls inside it: from 1100 px the four fit.
        wraps: [...document.querySelectorAll('.mcpOverview__wrap')].map((el) => el.scrollWidth - el.clientWidth),
        columns: getComputedStyle(document.querySelector('.mcpOverview__tables')).gridTemplateColumns.split(' ').length,
        tiles: new Set([...document.querySelectorAll('.mcpOverview__tiles .statTile')].map((el) => Math.round(el.getBoundingClientRect().top))).size,
        chart: document.querySelector('.mcpOverview__chart').getBoundingClientRect().width,
      };
    });
    expect(m.panel, `${width}: the panel`).toBeLessThanOrEqual(0);
    if (width >= 1100) expect(m.wraps, `${width}: the tables in their boxes`).toEqual([0, 0, 0, 0]);
    // Two columns of tables on a wide window (from 1280 px), one under 1280 px; seven tiles on one line from 1100 px.
    expect(m.columns, `${width}: the columns of the tables`).toBe(width >= 1280 ? 2 : 1);
    if (width >= 1100) expect(m.tiles, `${width}: the tiles`).toBe(1);
    expect(m.chart, `${width}: the chart`).toBeGreaterThan(width - 80);
  }
  // On a phone a table that is wider than its box scrolls in it, and the box says so (the faded edge).
  await expect(block(page, 'keys').locator('.dataTableWrap')).toHaveClass(/has-edge-end/);
  await screenshot(page, 'usage-phone');
});

test('both themes: the chart, the tiles and the tables read in the light theme and in the dark one', async ({ page }) => {
  await open(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, theme);
    await page.evaluate(() => window.ChDash.chartCore.of(document.querySelector('.mcpOverview__chart')).themeChanged());
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const colours = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { page: css('.mcpWorkspace', 'backgroundColor'), value: css('.statTile__value', 'color'), row: css('tr[data-dimension="key"] th', 'color'), legend: css('.chartCore__legendItem', 'color') };
    });
    expect(colours.value).not.toBe(colours.page);
    expect(colours.row).not.toBe(colours.page);
    expect(colours.legend).not.toBe(colours.page);
    await screenshot(page, `usage-${theme}`);
  }
});

test('the tab is built for a screen reader: labelled regions and tables, a scope on every header, one live region that says what a change found', async ({ page }) => {
  await open(page);
  await expect(page.locator('nav.mcpPage__nav')).toHaveCount(1);
  await expect(page.locator('.mcpOverview__tables table')).toHaveCount(4);
  expect(await page.locator('.mcpOverview__tables table').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Usage by key', 'Usage by method', 'Usage by result', 'Clients of the keys']);
  // Every column has a scope, every row a header (its first cell).
  expect(await page.locator('.mcpOverview__tables table').evaluateAll((els) => els.map((el) => [
    el.querySelectorAll('thead th[scope="col"]').length === el.querySelectorAll('thead th').length,
    [...el.querySelectorAll('tbody tr')].every((tr) => tr.firstElementChild.matches('th[scope="row"]')),
  ]))).toEqual([[true, true], [true, true], [true, true], [true, true]]);
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('role', 'list');
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('aria-label', 'Active filters');
  await expect(page.locator('.mcpOverview__tiles')).toHaveAttribute('aria-label', 'Totals');
  await expect(page.locator('.mcpOverview__split')).toHaveAttribute('aria-label', 'Split the chart by');
  await expect(page.locator('.mcpOverview__windows')).toHaveAttribute('aria-label', 'Window');
  // A change is said once, in the live region of the page, with what it found.
  await row(page, 'key', 'ops-all').click();
  await expect(page.locator('#uiLiveStatus')).toHaveText('1,012 requests in the last 7 days with these filters.');
  expect(await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((el) => el.id))).toEqual(['uiLiveStatus']);
});
