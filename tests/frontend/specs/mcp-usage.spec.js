import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';
import { chartJson } from '../helpers/charts.js';
import { fetchedModules } from '../helpers/modules.js';
import { CELLS, META, cell, geometry, install, newServer, oneInstance, overviewOf, setUsage } from '../helpers/mcp-fake.js';
import { captureCopies } from '../helpers/clipboard.js';

// The Usage tab of the MCP pages (mcpusage.html, /mcp-integration/usage, docs/mcp-integration-page.md, "The Usage tab") shows what every key did.
// The tab cuts the data by key, method, client, instance, result and type. The server side is the in-memory server of helpers/mcp-fake.js.
// This server computes the answers of GET /api/mcp/usage/overview from a small list of cells. It follows the rules of the contract. These rules are real. They cover the windows and their steps, the facets, the series with six figures, the rankings of `orders` and `rest`, the filters and the refusals.
// The page is therefore tested against behaviour, not against one frozen answer. mcp-contract.spec.js compares that answer with the real one.
//
// The cells of the fake hold 1,101 requests in the last 7 days (889 tool calls, 11 errors, 3 refused). 622 of them are in the last hour.
// The cells hold four keys of five (one deleted), ten methods, six results, five clients and two instances. chdash-0 wrote 918 of the requests and chdash-1 wrote 183.
// The last answer is at 2026-10-14T10:00:00Z. So "2 min ago" reads the same whatever the clock.
// The windows belong to the server. Each window has its own step.
// 1 h is cut by the minute. 6 h is cut by 5 minutes. 24 h is cut by 15 minutes.
// 7 d is cut by 3 hours. 30 d is cut by 12 hours. 90 d (and 365 d) is cut by the UTC day.
// The usage has three states on the server. The first state is on with two instances (the default). The second is on with one instance (`oneInstance`). The third is off (`setUsage`): the tab says "Usage is off" and asks for nothing but the meta.
//
// The tab is a filter bar. It has Group by key, method, client or result, and a list for each of key, method, client, result and instance.
// Below the bar is a row of chips with the period at its right end. Then come seven tiles and six charts (Requests, Errors, Error rate, Refused, Call time, Returned).
// Each chart has the legend of the shared engine: a list, or the Values table. There are no tables. A value is picked in a list of the bar or in a legend.

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

// The page is at its address, with its query string. It runs against the fake server. The tiles appear when the page has read the usage.
async function open(page, query = '', server = newServer()) {
  await install(page, server);
  await page.goto(`/mcp-integration/usage${query}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  return server;
}

// The page has drawn the answer of its last read. Nothing is busy any more. A read sets the busy state at once, in the handler of the click that asked for it.
const settled = (page) => expect(page.locator('.mcpOverview__body')).not.toHaveAttribute('aria-busy', 'true');
// The query strings of the overview reads, in the order that the page made them.
const reads = (server) => server.calls.filter((call) => call.path === '/usage/overview').map((call) => call.query);
// The tab asks for six rankings, besides the requests, in its one read. A page grouped by a filtered dimension asks for no ranking.
const ORDERS = '&order=requests&orders=errors&orders=refused&orders=calls&orders=bytes';
const chips = (page) => page.locator('.mcpOverview__chips .chip');
const chipLabels = (page) => chips(page).locator('.chip__remove').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
// The period that the figures cover. It is at the right end of the chips row ("Oct 7 12:00 → Oct 14 10:00").
const period = (page) => page.locator('.mcpOverview__period');
const tile = (page, label) => page.locator('.mcpOverview__tiles .statTile', { has: page.locator('.statTile__label', { hasText: new RegExp(`^${label}$`) }) });
// Label -> [value, sub line] of every tile.
const tiles = (page) => page.locator('.mcpOverview__tiles .statTile').evaluateAll((els) => Object.fromEntries(els.map((el) => [
  el.querySelector('.statTile__label').textContent, [el.querySelector('.statTile__value').textContent, el.querySelector('.statTile__sub')?.textContent || ''],
])));

// The six charts appear in this order. Each chart has a card with its title and its step, the box of the chart, and its legend.
const CHARTS = ['requests', 'errors', 'rate', 'refused', 'time', 'bytes'];
const card = (page, id) => page.locator(`.mcpOverview__card[data-card="${id}"]`);
const chartBox = (page, id = 'requests') => page.locator(`.mcpOverview__chart[data-chart="${id}"]`);
const legend = (page, id = 'requests') => chartBox(page, id).locator('.chartCore__legendItem');
const legendIds = (page, id = 'requests') => legend(page, id).evaluateAll((items) => items.map((item) => item.dataset.series));
const entry = (page, series, id = 'requests') => chartBox(page, id).locator(`.chartCore__legendItem[data-series="${series}"]`);
const swatch = (page, series, id = 'requests') => entry(page, series, id).locator('i').evaluate((el) => getComputedStyle(el).backgroundColor);
const titles = (page) => Promise.all(CHARTS.map((id) => card(page, id).locator('.chartCard__title').textContent()));
// The legend button of a chart switches between Values (the table) and List. The mode is one preference for all six charts (chdash.chart.legendMode).
const modeButton = (page, id = 'requests') => chartBox(page, id).locator('.chartCore__legendMode');
const legendTable = (page, id = 'requests') => chartBox(page, id).locator('.chartCore__legendTable');
// Each of the six cards has the same height. The height does not change with the content: a chart, a legend that scrolls, an empty chart or an empty window.
const cardHeights = (page) => page.locator('.mcpOverview__card').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
// Two lists of measures (px) match within half a pixel, entry by entry. The message of the failure shows the pairs that differ.
const expectNear = (actual, expected, message) => {
  expect(actual, message).toHaveLength(expected.length);
  expect(actual.map((value, i) => [value, expected[i]]).filter(([a, b]) => !(Math.abs(a - b) <= 0.5)), message).toEqual([]);
};
// This block gives the positions of the parts of the page. The cases use it to check that nothing moves.
// It gives the tops of the tiles and of the cards. The tops count from the top of the content of the tab, so the scroll of the panel does not count.
// It gives their heights. It gives the chips row and the panel from the top of the window, because they are out of what scrolls.
// The field `busy` says whether a read ran when the measures were taken. All measures are taken in one go.
const layout = (page) => page.evaluate(() => {
  const box = (el) => el.getBoundingClientRect();
  const origin = box(document.querySelector('.mcpOverview__content')).top;
  const tops = (selector) => [...document.querySelectorAll(selector)].map((el) => box(el).top - origin);
  const heights = (selector) => [...document.querySelectorAll(selector)].map((el) => box(el).height);
  const chipsRow = box(document.querySelector('.mcpOverview__filters'));
  return {
    busy: document.querySelector('.mcpOverview__body').getAttribute('aria-busy') === 'true',
    stands: {
      'the chips row': [chipsRow.top, chipsRow.height],
      'the panel': [box(document.querySelector('#mcpPanel')).top],
      'the tiles': tops('.mcpOverview__tiles .statTile'),
      'the height of the tiles': heights('.mcpOverview__tiles .statTile'),
      'the cards': tops('.mcpOverview__card'),
      'the height of the cards': heights('.mcpOverview__card'),
    },
  };
});
// This function lists what differs between `now` and `base` by more than half a pixel. It returns the differences as sentences. It returns [] when nothing moved.
const moved = (base, now) => Object.entries(base).flatMap(([name, values]) => values
  .map((value, i) => [`${name}[${i}]`, value, now[name]?.[i]])
  .filter(([, before, after]) => !(Math.abs(before - after) <= 0.5))
  .map(([label, before, after]) => `${label}: ${before.toFixed(1)} -> ${Number(after).toFixed(1)}`));
// The bar holds Group by, the five lists (key, method, client, result, instance), the window and Refresh.
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
// This is the check box of a value in a list, whether the list is open or not. The list keeps its picks. Escape closes the list.
const pickerBox = (page, dimension, value) => pickerMenu(page, dimension).locator(`input[value="${value}"]`);
const pressedWindow = (page) => page.locator('.mcpBar__windows [aria-pressed="true"]');
const windowButton = (page, name) => page.locator('.mcpBar__windows').getByRole('button', { name });
// This describes what a list of the bar shows. It gives its words and its title. It also says whether the list is disabled for the keyboard and for a screen reader.
const pickerState = (page, dimension) => pickerButton(page, dimension).evaluate((el) => ({
  text: el.textContent, title: el.title, disabled: el.disabled, ariaDisabled: el.getAttribute('aria-disabled'), off: el.closest('.mcpPicker').classList.contains('is-disabled'),
}));

async function screenshot(page, name) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: false });
}

// The x range that a chart drew (data-x-min, data-x-max), in ms.
const xRange = async (page, id = 'requests') => {
  const root = chartBox(page, id).locator('.chartCore');
  return [Number(await root.getAttribute('data-x-min')), Number(await root.getAttribute('data-x-max'))];
};

// The walk tests the five ways to change a filter, one after the other.
// The steps are these: a list of the bar (key ops-all), a second list (result ok), and a legend entry (method ping).
// Four charts have nothing to draw then. The other steps are the x of a chip and "Clear filters".
// The order matters. A list has every filter but its own. A dimension with one value left is not offered. So each step leaves two values or more for the next step.
// For each step, the read is slowed down by 1.2 s. The page is measured while the read runs: the chips are the new ones, and the figures are the old ones, dimmed.
// The page is measured again once it is drawn. `base` holds the positions from before the step. After the step, nothing must be elsewhere.
// `after()` is a check. The case runs it when the step is drawn.
async function walkFilters(page, server, base, after = async () => {}) {
  const tick = async (dimension, value) => {
    const menu = await openPicker(page, dimension);
    await menu.locator(`input[value="${value}"]`).check();
    await page.keyboard.press('Escape');
  };
  const steps = [
    ['a list of the bar', 1, () => tick('key', 'ops-all')],
    ['a second list of the bar', 2, () => tick('result', 'ok')],
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
  // Each step has one read. Nothing else reads. When the filters are clear again, the row shows its hint, as at the start.
  expect(reads(server)).toHaveLength(before + steps.length);
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
}

// ---- the filters: the bar, its five lists, the chips, the address ------------------------------------------------------------------------------
// A user picks a value in a list of the bar, or in the legend of a chart. There are no tables.
// Each pick makes a chip, a parameter of the address and a new read.
// The lists have every filter but their own. A dimension with nothing to choose is not offered. Nothing moves when a filter changes.

// This is the query string of a read of the tab. It holds the window, then the group.
// Next comes what the page asks for: a ranking for each metric of the charts. If the dimension of the group is filtered, the page asks for requests only.
// Its groups are the values that were picked. The filters come last.
const readFilters = (filters = '', { window = '7d', group = 'method', ranked = true } = {}) => `?window=${window}&group=${group}${ranked ? ORDERS : '&order=requests'}${filters}`;

// This ticks a value in a list of the bar. With `on: false`, it clears the value instead. It waits for the read that follows.
// A list waits for the clicks to pause before it reads. Then it closes the list.
async function tickFilters(page, server, dimension, value, { on = true, close = true } = {}) {
  const before = reads(server).length;
  const menu = await openPicker(page, dimension);
  await menu.locator(`input[value="${value}"]`).setChecked(on);
  await expect.poll(() => reads(server).length).toBeGreaterThan(before);
  await settled(page);
  if (close) {
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
}

// The web fonts are loaded. The measure of the positions is taken once the text has its final width. A font that loads late moves the items beside it.
const fontsFilters = (page) => page.evaluate(() => document.fonts.ready);

// This lists the axe violations of the page, as a failure reports them: the rule and the first nodes.
const axeFilters = (page) => new AxeBuilder({ page }).analyze().then((result) => result.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));

test('the Usage page is a page of its own, and the row of links joins it to the Keys page', async ({ page }) => {
  await open(page);
  // The body is the same as the keys page. The host picker stays hidden. The page has its own shell, stylesheet, entry and modules, and one heading.
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
  // The bar is the shared filter bar (app_ui_filterbar.js). The charts use the shared engine.
  // The instances module (app_mcp_instances.js) is a module of the page. It holds the warnings and the words for an instance that wrote. The pages of other families are not loaded.
  for (const name of ['app_page_mcpusage.js', 'app_mcp_overview.js', 'app_mcp_bar.js', 'app_mcp_charts.js', 'app_mcp_instances.js', 'app_mcp_view.js', 'app_ui_filterbar.js', 'app_chart_core.js', 'app_api.js']) expect(state.scripts, name).toContain(name);
  for (const name of ['app_page_mcp.js', 'app_mcp_form.js', 'app_mcp_usage.js', 'app_ui_dialog.js', 'app_logs.js', 'app_system_view.js', 'app_explorer.js']) expect(state.scripts, name).not.toContain(name);
  expect(new Set(state.scripts).size).toBe(state.scripts.length);
  await expect(page.locator('#hostPicker')).toBeHidden();
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#pageSelectButton')).toHaveText('MCP');
  // The row holds Keys and Usage. Both are links to the two pages. Usage is the current page, and the only one.
  const tabs = page.locator('#mcpTabs a.contentTabs__tab');
  await expect(tabs).toHaveText(['Keys', 'Usage']);
  expect(await tabs.evaluateAll((els) => els.map((el) => new URL(el.href).pathname))).toEqual(['/mcp-integration', '/mcp-integration/usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Usage');
  await expect(page.locator('#mcpTab-usage')).toHaveClass(/is-active/);
  await expect(page.locator('.mcpPage__nav')).toHaveAttribute('aria-label', 'MCP sections');
  // The row is the nav row of the page, as the row of System is. It is as tall as the row, and it sits under the header.
  // The filter bar is right under the nav row. The chips row comes next. It is always there, and it is 35 px tall. With no filter, it holds a hint.
  // The panel comes after the chips row. It starts 35 px under the bar.
  // The bar is not part of what a drawer starts under (--shell-top).
  const stack = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      height: box('.mcpPage__nav').height,
      top: box('.mcpPage__nav').top - box('body > .appHeader').bottom,
      barTop: box('#mcpBar').top - box('.mcpPage__nav').bottom,
      chipsTop: box('.mcpOverview__filters').top - box('#mcpBar').bottom,
      chipsHeight: box('.mcpOverview__filters').height,
      panelTop: box('#mcpPanel').top - box('#mcpBar').bottom,
      panelUnderChips: box('#mcpPanel').top - box('.mcpOverview__filters').bottom,
      // --shell-top (app_dom.js) is the bottom of the header and of the nav row. A drawer or a panel starts under it.
      shellTop: parseFloat(document.documentElement.style.getPropertyValue('--shell-top')) - box('.mcpPage__nav').bottom,
      // The bar, the chips and the panel are siblings of the row in the page. The panel is the only scroller.
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
  // With no filter, the row shows a hint. It shows no chip and no "Clear filters" button.
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toHaveText('No filters. Pick a value in a list or in a legend.');
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeHidden();
  // The tab has no heading row of its own. This was decided on 2026-10-16. The name of the part is a heading for screen readers only.
  // The period is in the chips row.
  await expect(page.locator('.mcpOverview__head')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__range')).toHaveCount(0);
  await expect(page.locator('.mcpInstances')).toHaveCount(0);
  await expect(page.locator('#mcpOverviewTitle')).toHaveText('Usage of all keys');
  await expect(page.locator('#mcpOverviewTitle')).toHaveClass(/srOnly/);
  await expect(page.locator('.mcpOverview__filters .mcpOverview__period')).toHaveCount(1);
  // The link of the row opens the Keys page. The Keys page has the same row, with Keys as the current page. It also has a link back.
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  await expect(page.locator('#mcpTabs a.contentTabs__tab')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Keys');
  await expect(page.locator('#mcpTab-keys')).toHaveClass(/is-active/);
  await expect(page.locator('#mcpTab-usage')).not.toHaveClass(/is-active/);
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  // The Keys page also has the instances module. It shows the "Summed over N instances" notes and the warnings of its table. It does not show the charts.
  const keysModules = await fetchedModules(page);
  expect(keysModules).toContain('app_mcp_instances.js');
  expect(keysModules).not.toContain('app_mcp_overview.js');
  await page.locator('#mcpTab-usage').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
});

test('the filter bar: Group by and a list for each of key, method, client, result and instance at the left, the window and Refresh at the right', async ({ page }) => {
  await open(page);
  // This is the bar of Observability and System. Its lead holds the pickers. Its tail holds the window and the action.
  const bar = page.locator('#mcpBar');
  await expect(bar).toHaveClass(/obsFilterBar/);
  // The lead holds six controls: Group by, then a list for each of the five dimensions that have one. Two instances are summed.
  // The Instance list shows how many instances are summed while none is picked.
  expect(await bar.locator('.obsFilterBar__lead .tracePicker__button').evaluateAll((els) => els.map((el) => el.textContent))).toEqual(
    ['Group by · Method', 'Key · All', 'Method · All', 'Client · All', 'Result · All', 'Instance · All (2)']);
  await expect(bar.locator('.obsFilterBar__tail .mcpBar__windows')).toBeVisible();
  await expect(bar.locator('.obsFilterBar__tail #mcpRefresh')).toBeVisible();
  await expect(page.locator('#mcpRefresh')).toHaveAttribute('aria-label', 'Refresh the usage');
  await expect(page.locator('#mcpRefresh')).toHaveAttribute('type', 'submit');
  // The bar is one row from 1101 px wide. The case for phone widths measures the widths.
  const xs = await bar.locator('.tracePicker__button, .mcpBar__windows, #mcpRefresh').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(xs).toHaveLength(8);
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  expect(await bar.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBeLessThanOrEqual(52);
  // Group by is one choice among four. It has a list of its own. The instance and the type are filters only. The five others are check boxes in a dialog.
  await groupButton(page).click();
  await expect(page.locator('.mcpBar__groupPicker .tracePicker__option')).toHaveText(['Key', 'Method', 'Client', 'Result']);
  await expect(groupOption(page, 'method')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.mcpBar__groupPicker [role="listbox"]')).toHaveAttribute('aria-label', 'Group by');
  await page.keyboard.press('Escape');
  for (const [dimension, label] of [['key', 'Key'], ['method', 'Method'], ['client', 'Client'], ['result', 'Result'], ['instance', 'Instance']]) {
    await expect(pickerButton(page, dimension)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(pickerButton(page, dimension)).toHaveAttribute('aria-controls', `mcpPickerMenu-${dimension}`);
    await expect(pickerMenu(page, dimension)).toHaveAttribute('role', 'dialog');
    await expect(pickerMenu(page, dimension)).toHaveAttribute('aria-label', `${label} filter`);
    await expect(pickerMenu(page, dimension)).toBeHidden();
  }
  // The Instance list shows how many instances the usage sums. Its title says what to do. The four other lists say "All".
  await expect(pickerButton(page, 'instance')).toHaveAttribute('title', 'The usage is summed over 2 instances. Pick some to see only theirs.');
  for (const [dimension, title] of [['key', 'All keys'], ['method', 'All methods'], ['client', 'All clients'], ['result', 'All results']]) await expect(pickerButton(page, dimension)).toHaveAttribute('title', title);
  // The window is a group of toggle buttons named Window. One button is pressed. The group shows only the windows that the retention keeps.
  await expect(page.locator('.mcpBar__windows')).toHaveAttribute('aria-label', 'Window');
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d', '30 d', '90 d']);
  await expect(page.locator('.mcpBar__windows [aria-pressed="true"]')).toHaveCount(1);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await screenshot(page, 'filters-bar');
});

// ---- the tiles ----------------------------------------------------------------------------------------------------------------------------

// The Active keys tile counts the keys that exist. The server counts a deleted key that was used with the others (totals.active_keys).
// So the page counts from the rows of the keys facet. It tells the deleted keys apart ("· 1 deleted").
test('Active keys: the keys that exist and have requests, out of the keys that exist, and the deleted key that was used, told apart', async ({ page }) => {
  // Five keys exist. The keys ops-all, ci-bot and legacy have requests in the last 7 days. The deleted key old-bot has requests too. The server says 4 active.
  const server = newServer();
  await open(page, '', server);
  expect(overviewOf(server, new URLSearchParams()).body.totals).toMatchObject({ active_keys: 4, keys: 5 });
  expect((await tiles(page))['Active keys']).toEqual(['3', 'of 5 keys · 1 deleted']);
  await expect(tile(page, 'Active keys')).toHaveAttribute('title', /^The keys that exist and have a request that every filter of the page keeps, out of the keys that exist\. A deleted key keeps its usage: one that had such a request is counted apart \("1 deleted"\), not in the two figures\.$/);
  // In the last 24 hours, the deleted key did nothing. Nothing is told apart, and the line shows the plain ratio.
  await windowButton(page, '24 h').click();
  await expect(tile(page, 'Requests').locator('.statTile__sub')).toHaveText('in the last 24 hours');
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['3', 'of 5 keys']);
});

test('Active keys: a deleted key does not stand in for a key that exists, so 4 of 5 keys and 1 deleted is not "5 of 5 keys"', async ({ page }) => {
  // A fourth key that exists, reporting, has requests too. With the deleted old-bot, the server counts 5 active keys. That is as many as exist.
  const reporting = cell('ui_111111111111', '2026-10-13T09:00', 'call', 'claude-code', 'list_hosts', 'ok', 4, 8, 3, 0, 900);
  const server = newServer({ cells: [...CELLS(), reporting] });
  await open(page, '', server);
  expect(overviewOf(server, new URLSearchParams()).body.totals).toMatchObject({ active_keys: 5, keys: 5 });
  expect((await tiles(page))['Active keys']).toEqual(['4', 'of 5 keys · 1 deleted']);
});

test('Active keys follow the filters: the key filter cuts the keys that are counted, and a deleted key that is picked is told apart', async ({ page }) => {
  const server = await open(page);
  // The list of the keys has every filter but the key filter. So it lists all the keys with requests. The tile counts the picked key only.
  await tickFilters(page, server, 'key', 'ops-all');
  await expect(chips(page)).toHaveCount(1);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys']);
  // A deleted key that is also picked is not one of the keys that exist.
  await tickFilters(page, server, 'key', 'ui_dead00000001');
  await expect(chips(page)).toHaveCount(2);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys · 1 deleted']);
  // The deleted key is picked alone. No key that exists is active.
  await tickFilters(page, server, 'key', 'ops-all', { on: false });
  await expect(chips(page)).toHaveCount(1);
  expect((await tiles(page))['Active keys']).toEqual(['0', 'of 5 keys · 1 deleted']);
  // The other filters count too. Of the keys that have the result `sql_error`, one key exists (ops-all). No deleted key is among them.
  await chips(page).first().locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await tickFilters(page, server, 'result', 'sql_error');
  await expect(chips(page)).toHaveCount(1);
  expect((await tiles(page))['Active keys']).toEqual(['1', 'of 5 keys']);
  // A legend is another way to set the same filter. Grouped by key, the entry of the deleted key picks it. The tile then counts it apart again.
  await chips(page).first().locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await pickGroup(page, 'key');
  await settled(page);
  await entry(page, 'key:ui_dead00000001').click();
  await expect(chips(page)).toHaveText(['Key=old-bot']);
  await settled(page);
  expect((await tiles(page))['Active keys']).toEqual(['0', 'of 5 keys · 1 deleted']);
});

test('Active keys: when the server cut the list of keys, the rows cannot be counted: the tile says the total of the server and what it counts', async ({ page }) => {
  const cut = (server, params) => {
    const answer = overviewOf(server, params);
    answer.body.omitted.keys = 2;
    return answer;
  };
  await open(page, '', newServer({ overview: cut }));
  // The 4 of the server counts the three keys that exist and the deleted one. The page shows no ratio and no "deleted" text.
  expect((await tiles(page))['Active keys']).toEqual(['4', 'keys with requests']);
  await expect(tile(page, 'Active keys')).toHaveAttribute('title', /^The keys, the deleted ones too, with a request that has every filter of the page\. There are too many keys to tell the deleted ones apart\.$/);
});

// A tile is 9 rem wide at least. From 1100 px, seven tiles share the line. That leaves 122 px for the sub line. A longer sub line is cut with an ellipsis.
// The longest figures are these: the share of the read requests, a flood of the rate limit, and a call of 12 min 30 s.
// They also include millions of rows, and twelve keys of which three are deleted.
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
  // The Errors tile shows the short form on the line. The sentence is in its title.
  await expect(tile(page, 'Errors').locator('.statTile__sub')).toHaveText('12.3% of read requests');
  await expect(tile(page, 'Errors')).toHaveAttribute('title', /12\.3% of the requests that were read: a request that was refused before its message was read is left out\.$/);
});

test('a tile that has no sub line keeps the height and the place of the tiles that have one, with one tile or several to a line', async ({ page }) => {
  const nothing = newServer();
  nothing.cells = [];
  // The states are: [state, address, server, the tiles that have no sub line]. Ping has no call and no row. An empty window has no call, no error and no byte.
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
      // The premise: the tiles that show nothing under their figure are those tiles. The other tiles still have their line.
      const bare = await page.locator('.mcpOverview__tiles .statTile').evaluateAll((els) => els.filter((el) => !el.querySelector('.statTile__sub')).map((el) => el.querySelector('.statTile__label').textContent));
      expect(bare, `${width} px, ${state}`).toEqual(quiet);
      // Each tile has the height of a tile with data. It stands where it stood before. A row of tiles that all lack their line is as tall as the others.
      expect(moved(full, only((await layout(page)).stands)), `${width} px, ${state}`).toEqual([]);
    }
  }
});

// ---- the chips and the period -------------------------------------------------------------------------------------------------------------

test('filters are chips: a list of the bar and a legend entry add them, the x of a chip removes one, "Clear filters" all of them, in the order of the dimensions', async ({ page }) => {
  const server = await open(page);
  // The row is there before any filter. The page never changes its height for one filter. The row holds a hint, no chip and no "Clear filters" button.
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await fontsFilters(page);
  const periodAt = await period(page).boundingBox();
  // A pick in a list of the bar makes a chip with the name of the key (not its id). The chip is a parameter of the address. The pick starts a read with the filter.
  await tickFilters(page, server, 'key', 'ops-all');
  await expect(chips(page)).toHaveCount(1);
  await expect(page.locator('.mcpOverview__filtersHint')).toBeHidden();
  await expect(page.locator('.mcpOverview__chips')).toBeVisible();
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await expect(chips(page).first()).toHaveText('Key=ops-all');
  await expect(chips(page).first()).toHaveAttribute('title', 'Key = ops-all');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all'));
  // The chips sit right under the bar, out of the panel that scrolls.
  expect(await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return [box('.mcpOverview__filters').top - box('#mcpBar').bottom, box('#mcpPanel').top - box('.mcpOverview__filters').bottom].map((gap) => Math.abs(Math.round(gap)));
  })).toEqual([0, 0]);
  // With one chip, there is no "Clear filters" button. Remove the chip instead, which is just as short.
  await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  // The picks go in this order: key, result and client in their lists, then the method in the legend of a chart.
  // A list has every filter but its own. A dimension that has one value left is not offered. So each pick leaves two values or more for the next pick.
  // Ops-all has the results ok, sql_error and table_not_allowed. With ok, it has two clients. With mcp-inspector, it has three methods.
  await tickFilters(page, server, 'result', 'ok');
  await tickFilters(page, server, 'client', 'mcp-inspector');
  await entry(page, 'method:list_hosts').click();
  await expect(chips(page)).toHaveCount(4);
  await settled(page);
  // The chips follow the order of the dimensions of the address. They do not follow the order of the picks.
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = list_hosts', 'Remove filter Client = mcp-inspector', 'Remove filter Result = ok']);
  await expect(page).toHaveURL(/\?key=ops-all&method=list_hosts&client=mcp-inspector&result=ok$/);
  // The method is the dimension that the charts are grouped by. It is filtered, so the page asks for no ranking.
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all&method=list_hosts&client=mcp-inspector&result=ok', { ranked: false }));
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  // The chips are a list with a name. The button stands beside the list, not in it.
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('role', 'list');
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('aria-label', 'Active filters');
  await expect(page.locator('.mcpOverview__chips').getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  await expect(page.locator('.mcpOverview__filters > .chips__clear')).toHaveCount(1);
  // Every figure follows. There are 50 requests (list_hosts of ops-all, by mcp-inspector, 40 and 10) and one key. The buttons of the lists say so.
  expect(await tiles(page)).toMatchObject({ Requests: ['50', 'in the last 7 days'], 'Active keys': ['1', 'of 5 keys'] });
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  await expect(pickerButton(page, 'method')).toHaveText('Method · list_hosts');
  await expect(pickerButton(page, 'client')).toHaveText('Client · mcp-inspector');
  await expect(pickerButton(page, 'result')).toHaveText('Result · ok');
  // A list keeps the filters that are not its own. The list shows the clients of ops-all that called list_hosts with the result ok. The picked client is checked.
  const clients = await openPicker(page, 'client');
  await expect(clients.locator('.mcpPicker__name')).toHaveText(['mcp-inspector']);
  await expect(clients.locator('input:checked')).toHaveCount(1);
  await page.keyboard.press('Escape');
  // A chip goes with its x. The keyboard then moves to the chip that takes its place.
  await chips(page).nth(1).locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(3);
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Client = mcp-inspector', 'Remove filter Result = ok']);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  await expect(pickerButton(page, 'method')).toHaveText('Method · All');
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(2);
  await settled(page);
  await expect(chips(page).nth(1).locator('.chip__remove')).toBeFocused();
  // The period at the right end of the row does not move for any of this. It is not part of what the chips push.
  const periodNow = await period(page).boundingBox();
  expect(Math.abs(periodNow.x + periodNow.width - (periodAt.x + periodAt.width))).toBeLessThanOrEqual(0.5);
  expect(Math.abs(periodNow.y - periodAt.y)).toBeLessThanOrEqual(0.5);
  // "Clear filters" removes all of them at once. The group stays.
  await pickGroup(page, 'client');
  await settled(page);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips(page)).toHaveCount(0);
  // The row stays: 35 px, with the hint back in it. It does not go with the filters.
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(page.locator('.mcpOverview__chips')).toBeHidden();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=client$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('', { group: 'client' }));
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(pressedWindow(page)).toBeFocused();
});

// The type of a request has no list and no legend. A link can carry it. The chip names the type and removes it.
test('a type that the address asks for is a chip with its name for the reader, and the chip lets it go', async ({ page }) => {
  const server = await open(page, '?type=call&type=request');
  expect(await chipLabels(page)).toEqual(['Remove filter Type = Tool calls', 'Remove filter Type = Protocol']);
  await expect(chips(page).first()).toHaveAttribute('title', 'Tool calls: A call of a tool (tools/call)');
  await expect(chips(page).last()).toHaveAttribute('title', /^Protocol: A request of the MCP protocol/);
  // Every figure has the type filter. The figures count the tool calls and the protocol requests, not the refused ones (2 by the rate limit, 1 rejected).
  expect(await tiles(page)).toMatchObject({ Requests: ['1,098', 'in the last 7 days'], Refused: ['0', '0 by the rate limit'] });
  expect(reads(server)).toEqual([readFilters('&type=call&type=request')]);
  // The bar has no list of the type. The six controls of its lead are Group by and the five lists.
  await expect(page.locator('#mcpBar .obsFilterBar__lead .tracePicker__button')).toHaveCount(6);
  await chips(page).first().locator('.chip__remove').click();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&type=request'));
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?type=request$/);
});

test('the period that the figures cover is at the right end of the chips row, muted, on one line: empty before the first answer, then the dates of the window, or of the counting when that is later', async ({ page }) => {
  const server = newServer();
  server.delay['GET /usage/overview'] = 1000;
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  // Before the first answer, the row is there with its hint. The period has nothing to say yet. It has its title.
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(period(page)).toHaveText('');
  await expect(period(page)).toHaveAttribute('title', 'The period that the figures cover');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  server.delay['GET /usage/overview'] = 0;
  // The span of the answer on screen uses the local time of the browser (UTC here). It runs from the start of the window to the time of the answer.
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
  // The last child of the row is at its right end. It is muted, and it stays on one line that does not wrap.
  await fontsFilters(page);
  const row = await page.evaluate(() => {
    const el = document.querySelector('.mcpOverview__period');
    const rowEl = document.querySelector('.mcpOverview__filters');
    const box = el.getBoundingClientRect();
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--muted)';
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(el);
    return {
      last: rowEl.lastElementChild === el, rightGap: rowEl.getBoundingClientRect().right - box.right - parseFloat(getComputedStyle(rowEl).paddingRight),
      color: style.color === muted, nowrap: style.whiteSpace, oneLine: box.height < parseFloat(style.fontSize) * 1.6, shrinks: style.flexShrink,
    };
  });
  expect(row.last).toBe(true);
  expect(Math.abs(row.rightGap)).toBeLessThanOrEqual(1);
  expect(row.color).toBe(true);
  expect(row.nowrap).toBe('nowrap');
  expect(row.oneLine).toBe(true);
  expect(row.shrinks).toBe('0');
  // A shorter window has its own dates. A window that starts before the counting began starts at the first start with the file.
  // The page says so under the charts ("Counted since ...").
  await windowButton(page, '24 h').click();
  await expect(period(page)).toHaveText('Oct 13 10:15 → Oct 14 10:00');
  await settled(page);
  await windowButton(page, '30 d').click();
  await expect(period(page)).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  await settled(page);
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  // Filters do not change the dates. The figures cover the same span, whatever the filters are.
  await tickFilters(page, server, 'key', 'ops-all');
  await expect(period(page)).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  // The counting began at 08:00 today. The last 24 hours start before it. The last hour starts after it.
  const late = newServer();
  late.meta.usage = { ...late.meta.usage, since: '2026-10-14T08:00:00Z' };
  await open(page, '?window=24h', late);
  await expect(period(page)).toHaveText('Oct 14 08:00 → 10:00');
  await windowButton(page, '1 h').click();
  await expect(period(page)).toHaveText('Oct 14 09:01 → 10:00');
});

test('twenty chips are one line of the same 35 px: the list scrolls sideways, fading where it hides some, and "Clear filters" and the period stay in view', async ({ page }) => {
  const many = Array.from({ length: 20 }, (_, i) => `search_traces_${String(i).padStart(2, '0')}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    const none = await layout(page);
    expect(none.stands['the chips row'][1]).toBeCloseTo(35, 0);
    // The address sets the most that a kind of filter takes: 20 chips.
    // The method is a value that nobody called. Nothing is counted, and the layout is the one of an empty window.
    await page.goto(`/mcp-integration/usage?${many.map((name) => `method=${name}`).join('&')}`);
    await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
    await expect(chips(page)).toHaveCount(20);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    await settled(page);
    await fontsFilters(page);
    const list = page.locator('.mcpOverview__chips');
    // This is the button of the row. The empty card of the Requests has a button with the same name.
    const clear = page.locator('.mcpOverview__filters').getByRole('button', { name: 'Clear filters' });
    const m = await page.evaluate(() => {
      const row = document.querySelector('.mcpOverview__filters');
      const chipsList = row.querySelector('.mcpOverview__chips');
      const box = (el) => el.getBoundingClientRect();
      return {
        row: box(row), list: box(chipsList), clear: box(row.querySelector('.chips__clear')), period: box(row.querySelector('.mcpOverview__period')),
        hidden: chipsList.scrollWidth - chipsList.clientWidth, overflow: getComputedStyle(chipsList).overflowX,
        // Every chip is on the same line. None wraps under the others.
        lines: new Set([...chipsList.children].map((el) => Math.round(box(el).top))).size,
      };
    });
    // One line of 35 px scrolls. The chips are much wider than the window. None is on a second line. The box of the list is as tall as the row.
    expect(m.row.height, `${width} px: the row`).toBeCloseTo(35, 0);
    expect(m.lines, `${width} px: one line of chips`).toBe(1);
    expect(m.hidden, `${width} px: what the list hides`).toBeGreaterThan(m.list.width);
    expect(m.overflow).toBe('auto');
    await expect(list).toHaveClass(/has-edge-end/);
    await expect(list).not.toHaveClass(/has-edge-start/);
    // "Clear filters" is beside the list, in the row, and in view. It does not scroll with the chips.
    // The period is at the right end, after it, on one line. The chips give way to both. Never the other way round.
    await expect(clear).toBeVisible();
    await expect(clear).toBeInViewport({ ratio: 0.99 });
    await expect(period(page)).toBeInViewport({ ratio: 0.99 });
    expect(m.clear.left, `${width} px: Clear filters is after the list`).toBeGreaterThanOrEqual(m.list.right - 1);
    expect(m.period.left, `${width} px: the period is after Clear filters`).toBeGreaterThanOrEqual(m.clear.right - 1);
    expect(m.clear.right, `${width} px: Clear filters is in the row`).toBeLessThanOrEqual(m.row.right);
    expect(m.period.right, `${width} px: the period is in the row`).toBeLessThanOrEqual(m.row.right);
    expect(m.period.height, `${width} px: the period is one line`).toBeLessThan(24);
    expect(await horizontalOverflow(page), `${width} px: the page`).toBeLessThanOrEqual(0);
    // The page stands as it stood with no filter. The cards of the empty window are as tall as the cards with data.
    expect(moved(none.stands, (await layout(page)).stands), `${width} px: with 20 chips`).toEqual([]);
    // The list scrolls to its end. The fade changes sides. "Clear filters" has not moved.
    await list.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(list).toHaveClass(/has-edge-start/);
    await expect(list).not.toHaveClass(/has-edge-end/);
    // The last chip ends where the list ends. On a phone, the list is narrower than a chip.
    // What is left of the row is about 140 px, once the period and the button have their parts. So the chip is seen in part, and its end shows.
    const end = await page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect();
      const chipsList = document.querySelector('.mcpOverview__chips');
      return box(chipsList).right - box(chipsList.lastElementChild).right;
    });
    expect(Math.abs(end), `${width} px: the last chip at the end of the list`).toBeLessThanOrEqual(1);
    await expect(clear).toBeInViewport({ ratio: 0.99 });
    const after = await clear.boundingBox();
    expect(Math.abs(after.x - m.clear.left), `${width} px: Clear filters after the scroll`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(after.y - m.clear.top), `${width} px: Clear filters after the scroll`).toBeLessThanOrEqual(0.5);
    const periodAfter = await period(page).boundingBox();
    expect(Math.abs(periodAfter.x - m.period.left), `${width} px: the period after the scroll`).toBeLessThanOrEqual(0.5);
  }
});

// ---- the lists of the bar ------------------------------------------------------------------------------------------------------------------

test('a list has every filter but its own: it shows what else can be picked, and a value that is picked stays in it, at 0 when nothing matches', async ({ page }) => {
  await open(page, '?key=ui_0a1b2c3d4e5f&method=query_table&result=table_not_allowed');
  // The tiles have the three filters. There are 3 requests (query_table of ci-bot that ended with table_not_allowed).
  expect(await tiles(page)).toMatchObject({ Requests: ['3', 'in the last 7 days'], Errors: ['3', '100% of read requests'], 'Active keys': ['1', 'of 5 keys'] });
  await expect(tile(page, 'Errors')).toHaveClass(/is-error/);
  // The Key list has the method and the result, not the key. It lists every key that has them. The picked key is checked.
  let menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ci-bot', 'ops-all']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['3', '2']);
  await expect(pickerBox(page, 'key', 'ui_0a1b2c3d4e5f')).toBeChecked();
  await expect(pickerBox(page, 'key', 'ops-all')).not.toBeChecked();
  await page.keyboard.press('Escape');
  // The Method list has the key and the result. It lists the methods of ci-bot that ended with table_not_allowed. The picked method stays in the list, because a filter keeps the list.
  menu = await openPicker(page, 'method');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['query_table']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['3']);
  await expect(pickerBox(page, 'method', 'query_table')).toBeChecked();
  await page.keyboard.press('Escape');
  // The Result list has the key and the method. It lists what the calls of ci-bot to query_table ended with, including the successful ones.
  menu = await openPicker(page, 'result');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ok', 'table_not_allowed']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['9', '3']);
  await expect(pickerBox(page, 'result', 'table_not_allowed')).toBeChecked();
  await expect(pickerBox(page, 'result', 'ok')).not.toBeChecked();
  await page.keyboard.press('Escape');
  // The Client list has the key, the method and the result, not the client. The one client that made those calls is the only value. So the list is disabled.
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · claude-code', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  // The Instance list has all the filters but its own. It lists every instance that the server knows, with zeros. The three requests are chdash-0's.
  menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['3', '0']);
  await page.keyboard.press('Escape');
  // A picked value that nothing matches (a key that was never used) is in its list at 0 and checked. The name of the key is on its chip.
  await page.goto('/mcp-integration/usage?key=ui_111111111111');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  // The window has no request with this filter. The Requests card says so. The six cards stay.
  await expect(card(page, 'requests').locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot', 'reporting']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['1,012', '41', '28', '20', '0']);
  await expect(pickerBox(page, 'key', 'ui_111111111111')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(chips(page).first()).toHaveText('Key=reporting');
  await expect(pickerButton(page, 'key')).toHaveText('Key · reporting');
  // A method that nobody called (a made-up name in the address) is in its list too. The other lists have nothing to choose from.
  await page.goto('/mcp-integration/usage?method=nothing');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  menu = await openPicker(page, 'method');
  await expect(menu.locator('.mcpPicker__name').last()).toHaveText('nothing');
  await expect(menu.locator('.mcpPicker__count').last()).toHaveText('0');
  await expect(pickerBox(page, 'method', 'nothing')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(pickerButton(page, 'method')).toHaveText('Method · nothing');
  await expect(card(page, 'requests').locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  for (const [dimension, label] of [['key', 'Key'], ['client', 'Client'], ['result', 'Result']]) {
    expect(await pickerState(page, dimension), dimension).toMatchObject({ text: `${label} · none`, disabled: true, off: true });
  }
  // A client that nobody made is in its list at 0, with its chip.
  await page.goto('/mcp-integration/usage?client=nobody');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  menu = await openPicker(page, 'client');
  await expect(menu.locator('.mcpPicker__name').last()).toHaveText('nobody');
  await expect(menu.locator('.mcpPicker__count').last()).toHaveText('0');
  await expect(pickerBox(page, 'client', 'nobody')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(pickerButton(page, 'client')).toHaveText('Client · nobody');
  await expect(chips(page)).toHaveText(['Client=nobody']);
});

test('the Key list: the keys of the facet with their requests, a check box adds the key as a filter at once, and the page reads when the clicks pause', async ({ page }) => {
  const server = await open(page);
  const key = pickerButton(page, 'key');
  await expect(key).toHaveText('Key · All');
  await expect(key).toHaveAttribute('title', 'All keys');
  const menu = await openPicker(page, 'key');
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  // The list shows the keys that have requests, the most first. Each key has its requests. A deleted key has its badge. None is checked.
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['1,012', '41', '28', '20']);
  await expect(menu.locator('.mcpPicker__option', { hasText: 'old-bot' }).locator('.badge')).toHaveText('deleted');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'old-bot' }).locator('.badge')).toHaveAttribute('title', 'The key was deleted: its usage stays until the retention ends');
  await expect(menu.locator('.mcpPicker__option .badge')).toHaveCount(1);
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'All keys' })).toBeVisible();
  // A key that has a name shows the name in its title, with its id. A key whose name is its id shows the name only.
  await expect(menu.locator('.mcpPicker__option', { hasText: 'ci-bot' })).toHaveAttribute('title', 'ci-bot\nui_0a1b2c3d4e5f');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'ops-all' })).toHaveAttribute('title', 'ops-all');
  // Four values are not a long list. So the field that narrows the list is not there.
  await expect(menu.locator('.mcpPicker__search')).toBeHidden();
  // A pick sets the button, the chip and the checked box at once. The page reads when the clicks pause. The read makes one entry of the history.
  const before = await page.evaluate(() => history.length);
  await menu.getByRole('checkbox', { name: /^ops-all/ }).check();
  await expect(key).toHaveText('Key · ops-all');
  await expect(key).toHaveAttribute('title', 'ops-all');
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await expect(menu).toBeVisible();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all$/);
  await settled(page);
  expect(reads(server)).toEqual([readFilters(), readFilters('&key=ops-all')]);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  // The list stays open and keeps its values. It has every filter but its own, so the other keys can still be picked. The check box is on.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ops-all/ })).toBeChecked();
  // Two picks that come together make one read and one entry of the history. This is the case of a person that ticks a few boxes.
  await menu.evaluate((el) => {
    for (const input of el.querySelectorAll('input[value="ui_0a1b2c3d4e5f"], input[value="ui_legacy000000"]')) input.click();
  });
  await expect(key).toHaveText('Key · 3 selected');
  // The picks go in the order that they were made. The check boxes are in the order of the list: legacy, then ci-bot.
  await expect(key).toHaveAttribute('title', 'ops-all, legacy, ci-bot');
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Key=legacy', 'Key=ci-bot']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all&key=ui_legacy000000&key=ui_0a1b2c3d4e5f$/);
  await settled(page);
  expect(reads(server)).toEqual([readFilters(), readFilters('&key=ops-all'), readFilters('&key=ops-all&key=ui_legacy000000&key=ui_0a1b2c3d4e5f')]);
  expect((await page.evaluate(() => history.length)) - before).toBe(2);
  // Picks that cancel out before the clicks pause leave the state as it was. There is no read and no entry of the history.
  await menu.evaluate((el) => { const input = el.querySelector('input[value="ui_dead00000001"]'); input.click(); input.click(); });
  await page.waitForTimeout(500);
  await expect(key).toHaveText('Key · 3 selected');
  expect(reads(server)).toHaveLength(3);
  expect((await page.evaluate(() => history.length)) - before).toBe(2);
  // Back: the address is the state. The check boxes follow the address.
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(key).toHaveText('Key · ops-all');
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all'));
  const again = await openPicker(page, 'key');
  await expect(again.getByRole('checkbox', { name: /^ops-all/ })).toBeChecked();
  await expect(again.getByRole('checkbox', { name: /^ci-bot/ })).not.toBeChecked();
  await screenshot(page, 'filters-picker-key');
});

test('"All keys" clears the dimension, and the other lists follow what is picked: they have every filter but their own', async ({ page }) => {
  const server = await open(page, '?key=ui_0a1b2c3d4e5f');
  // The Client list has the key filter. It lists the clients of ci-bot, with their requests in the window. The Method list lists the methods of ci-bot.
  const clients = await openPicker(page, 'client');
  await expect(clients.locator('.mcpPicker__name')).toHaveText(['claude-code', 'Visual Studio Code']);
  await expect(clients.locator('.mcpPicker__count')).toHaveText(['12', '8']);
  await page.keyboard.press('Escape');
  const methods = await openPicker(page, 'method');
  await expect(methods.locator('.mcpPicker__name')).toHaveText(['query_table', 'tools/list', 'initialize']);
  await page.keyboard.press('Escape');
  // The Result list too. It shows the results of the calls of ci-bot: ok or table_not_allowed.
  const results = await openPicker(page, 'result');
  await expect(results.locator('.mcpPicker__name')).toHaveText(['ok', 'table_not_allowed']);
  await expect(results.locator('.mcpPicker__count')).toHaveText(['17', '3']);
  await page.keyboard.press('Escape');
  // The Key list has the other filters only. It lists all the keys, and the picked one is checked.
  const keys = await openPicker(page, 'key');
  await expect(keys.locator('.mcpPicker__name')).toHaveText(['ops-all', 'old-bot', 'legacy', 'ci-bot']);
  await expect(keys.locator('input:checked')).toHaveCount(1);
  await expect(pickerBox(page, 'key', 'ui_0a1b2c3d4e5f')).toBeChecked();
  // "All keys" clears every key. The button, the boxes, the chips and the address show this at once. Then the read follows.
  await keys.getByRole('button', { name: 'All keys' }).click();
  await expect(pickerButton(page, 'key')).toHaveText('Key · All');
  await expect(keys.locator('input:checked')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters());
  // The list stays open. The action is not a pick that closes it. "All keys" with nothing picked reads nothing.
  await expect(keys).toBeVisible();
  const count = reads(server).length;
  await keys.getByRole('button', { name: 'All keys' }).click();
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
});

test('the Method list: the tools, and the methods of the protocol muted; a pick is a filter of the methods and of the charts', async ({ page }) => {
  const server = await open(page);
  const menu = await openPicker(page, 'method');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', 'unread', 'other']);
  await expect(menu.locator('.mcpPicker__count').first()).toHaveText('754');
  // A tool is read as a tool. The protocol methods are muted. So are the words that stand for a group of messages.
  expect(await menu.locator('.mcpPicker__option.is-muted .mcpPicker__name').allTextContents()).toEqual(['ping', 'tools/list', 'initialize', 'notifications/initialized', 'unread', 'other']);
  const weight = (name) => menu.locator('.mcpPicker__name', { hasText: new RegExp(`^${name}$`) }).evaluate((el) => getComputedStyle(el).color);
  expect(await weight('ping')).not.toBe(await weight('query_table'));
  // The name of a check box is the method and its requests.
  await expect(menu.getByRole('checkbox', { name: /^query_table 754$/ })).toBeVisible();
  await expect(menu.getByRole('checkbox', { name: /^notifications\/initialized 20$/ })).toBeVisible();
  // The dimension of the group is filtered by a pick. The page asks for no ranking. The charts draw the values that were picked.
  await menu.getByRole('checkbox', { name: /^run_query/ }).check();
  await expect(pickerButton(page, 'method')).toHaveText('Method · run_query');
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&method=run_query', { ranked: false }));
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:run_query']);
  await expect(entry(page, 'method:run_query')).toHaveAttribute('aria-pressed', 'true');
  // The chip, the check box and the legend entry are one filter. The chip removes it, and the box follows.
  await chips(page).first().locator('.chip__remove').click();
  await settled(page);
  await expect(pickerButton(page, 'method')).toHaveText('Method · All');
  const again = await openPicker(page, 'method');
  await expect(again.locator('input:checked')).toHaveCount(0);
  expect(reads(server).at(-1)).toBe(readFilters());
});

test('the Client list: the clients with their requests, a name with spaces is one value, and the list has the filters of the other lists', async ({ page }) => {
  const server = await open(page);
  const menu = await openPicker(page, 'client');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['894', '130', '41', '28', '8']);
  await menu.getByRole('checkbox', { name: /^Visual Studio Code/ }).check();
  await expect(pickerButton(page, 'client')).toHaveText('Client · Visual Studio Code');
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&client=Visual+Studio+Code'));
  await settled(page);
  expect(await tiles(page)).toMatchObject({ Requests: ['8', 'in the last 7 days'] });
  // The Key list now has the client filter. One key used this client (ci-bot). So there is nothing to choose from, and the list is disabled. It says the key, and why, in its title.
  // The Method list has the filter too. It lists the two methods that the client called.
  await page.keyboard.press('Escape');
  await expect(pickerButton(page, 'key')).toBeDisabled();
  await expect(pickerButton(page, 'key')).toHaveText('Key · ci-bot');
  await expect(pickerButton(page, 'key')).toHaveAttribute('title', 'Only one key in this view');
  const methods = await openPicker(page, 'method');
  await expect(methods.locator('.mcpPicker__name')).toHaveText(['tools/list', 'initialize']);
  await expect(methods.locator('.mcpPicker__count')).toHaveText(['5', '3']);
  await page.keyboard.press('Escape');
  // The check boxes of the Client list stay on. The other clients are still there to pick.
  const clients = await openPicker(page, 'client');
  await expect(clients.locator('.mcpPicker__name')).toHaveText(['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code']);
  await expect(clients.locator('input:checked')).toHaveCount(1);
  // A second client makes two picks. The order is the order of the picks. The first is the one of the address. The same order applies everywhere.
  await clients.getByRole('checkbox', { name: /^python-httpx/ }).check();
  await expect(pickerButton(page, 'client')).toHaveText('Client · 2 selected');
  await expect(pickerButton(page, 'client')).toHaveAttribute('title', 'Visual Studio Code, python-httpx');
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&client=Visual+Studio+Code&client=python-httpx'));
  await settled(page);
});

test('the Result list: the results of the requests with their counts, a pick is a chip and a parameter of the address, and the list has every filter but its own', async ({ page }) => {
  const server = await open(page);
  const result = pickerButton(page, 'result');
  await expect(result).toHaveText('Result · All');
  await expect(result).toHaveAttribute('title', 'All results');
  const menu = await openPicker(page, 'result');
  // The results of the window are sorted by the most requests first, then by name. They are: `ok`, the codes of the errors of the tools and of the protocol (`rpc_error_32601`), and the refusals (`429_rate_limited`).
  // Each result has the requests that ended with it, the successful ones too. Together they add up to the 1,101 requests of the window.
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', '413_payload_too_large', 'rpc_error_32601']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['1,087', '5', '5', '2', '1', '1']);
  await expect(menu).toHaveAttribute('aria-label', 'Result filter');
  await expect(menu.getByRole('group', { name: 'Result' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'All results' })).toBeVisible();
  await expect(menu.getByRole('checkbox', { name: /^sql_error 5$/ })).toBeVisible();
  await expect(menu.locator('.mcpPicker__option', { hasText: 'rpc_error_32601' })).toHaveAttribute('title', 'rpc_error_32601');
  await expect(menu.locator('.mcpPicker__option .badge')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__option.is-muted')).toHaveCount(0);
  // Six values are not a long list. So there is no field that narrows it.
  await expect(menu.locator('.mcpPicker__search')).toBeHidden();
  await expect(menu.locator('input:checked')).toHaveCount(0);
  // A pick sets the button, the chip and the address at once. The page reads when the clicks pause. Every figure has the filter.
  await menu.getByRole('checkbox', { name: /^sql_error/ }).check();
  await expect(result).toHaveText('Result · sql_error');
  await expect(result).toHaveAttribute('title', 'sql_error');
  await expect(chips(page)).toHaveText(['Result=sql_error']);
  expect(await chipLabels(page)).toEqual(['Remove filter Result = sql_error']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?result=sql_error$/);
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&result=sql_error'));
  await settled(page);
  expect(await tiles(page)).toMatchObject({ Requests: ['5', 'in the last 7 days'], Errors: ['5', '100% of read requests'] });
  // The list has every filter but its own. Every result is still there with its count. The picked result is checked, and the list stays open.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', '413_payload_too_large', 'rpc_error_32601']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['1,087', '5', '5', '2', '1', '1']);
  await expect(menu.getByRole('checkbox', { name: /^sql_error/ })).toBeChecked();
  // The other lists have the filter of the result. Only ops-all ran a query that failed, and it ran with claude-code. So those three lists are disabled, and they say so.
  // The Instance list has both instances. The failure is chdash-1's.
  await page.keyboard.press('Escape');
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ops-all', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'method')).toEqual({ text: 'Method · run_query', title: 'Only one method in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'client')).toMatchObject({ text: 'Client · claude-code', disabled: true });
  const instances = await openPicker(page, 'instance');
  await expect(instances.locator('.mcpPicker__name')).toHaveText(['chdash-1', 'chdash-0']);
  await expect(instances.locator('.mcpPicker__count')).toHaveText(['5', '0']);
  await page.keyboard.press('Escape');
  // A value that is picked stays in the list at 0 when another filter leaves nothing of it. The key ci-bot never had a query that failed.
  // The address says both. The Key list has nothing to pick but ops-all, once the result is picked.
  await page.goto('/mcp-integration/usage?key=ui_0a1b2c3d4e5f&result=sql_error');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveText(['Key=ci-bot', 'Result=sql_error']);
  await expect(card(page, 'requests').locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  const kept = await openPicker(page, 'result');
  await expect(kept.locator('.mcpPicker__name')).toHaveText(['ok', 'table_not_allowed', 'sql_error']);
  await expect(kept.locator('.mcpPicker__count')).toHaveText(['17', '3', '0']);
  await expect(kept.getByRole('checkbox', { name: /^sql_error/ })).toBeChecked();
  // "All results" lets the filter go. It leaves the key.
  await kept.getByRole('button', { name: 'All results' }).click();
  await expect(result).toHaveText('Result · All');
  await expect(chips(page)).toHaveText(['Key=ci-bot']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ui_0a1b2c3d4e5f$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ui_0a1b2c3d4e5f'));
  await screenshot(page, 'filters-picker-result');
});

test('a list of more than 12 values has a field that narrows it, and a dimension takes 20 values at most', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 30; i += 1) server.cells.push(cell(`bulk-${String(i).padStart(2, '0')}`, '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100));
  await open(page, '', server);
  const menu = await openPicker(page, 'key');
  // 34 keys have requests. The field is there, with a name and the shape of a search.
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(34);
  const search = menu.locator('.mcpPicker__search');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('aria-label', 'Filter the list of keys');
  await expect(search).toHaveAttribute('placeholder', 'Filter keys');
  // Text that is typed narrows the list to the names that hold the text, whatever their case. A text that no name holds gets a message that says so.
  await search.fill('BULK-2');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(10);
  await expect(menu.locator('.mcpPicker__option:not([hidden]) .mcpPicker__name').first()).toHaveText('bulk-29');
  await search.fill('zzz');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('Nothing matches "zzz".');
  await search.fill('');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(34);
  await expect(menu.locator('.mcpPicker__none')).toBeHidden();
  // Enter in the field does not submit. It starts no read of its own. Down moves to the first value that is shown.
  const count = reads(server).length;
  await search.fill('bulk-1');
  await search.press('Enter');
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
  await search.press('ArrowDown');
  await expect(menu.locator('.mcpPicker__option:not([hidden]) input').first()).toBeFocused();
  // The list shows 20 values at most. The 20th pick disables the boxes that are not checked, and says why. A box that is cleared enables them again.
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

// The page has 25 values of each dimension, with a cell for each.
// The key is bulk-NN, the client is client-NN, the method is method_NN, the result is result_NN, and the instance is node-NN.
// The higher the number, the more requests a value has. So a list begins with the last values. The instances that the server knows (chdash-0 and chdash-1) add up to 27 values.
const crowdFilters = (count = 25) => {
  const server = newServer();
  server.cells = Array.from({ length: count }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return cell(`bulk-${n}`, '2026-10-14T08:00', 'call', `client-${n}`, `method_${n}`, `result_${n}`, 1 + i, 5, 5, 1, 100, `node-${n}`);
  });
  return server;
};

test('every list takes 20 values at most: the 21st box is off with a note that says why, the field narrows a long list, and a box that is let go frees the others', async ({ page }) => {
  for (const [dimension, label, noun] of [['key', 'Key', 'keys'], ['method', 'Method', 'methods'], ['client', 'Client', 'clients'], ['result', 'Result', 'results'], ['instance', 'Instance', 'instances']]) {
    const server = await open(page, '', crowdFilters());
    const menu = await openPicker(page, dimension);
    const boxes = menu.locator('input[type="checkbox"]');
    const total = await boxes.count();
    expect(total, dimension).toBeGreaterThanOrEqual(25);
    // More than 12 values: the field that narrows the list shows the name of what it narrows.
    const search = menu.locator('.mcpPicker__search');
    await expect(search, dimension).toBeVisible();
    await expect(search, dimension).toHaveAttribute('aria-label', `Filter the list of ${noun}`);
    await expect(search, dimension).toHaveAttribute('placeholder', `Filter ${noun}`);
    // The 20th pick disables the boxes that are not checked, and says why.
    await menu.evaluate((el) => {
      for (const input of [...el.querySelectorAll('input[type="checkbox"]')].slice(0, 20)) input.click();
    });
    await expect(menu.locator('input:checked'), dimension).toHaveCount(20);
    await expect(menu.locator('input:disabled'), dimension).toHaveCount(total - 20);
    await expect(menu.locator('input:checked:disabled'), dimension).toHaveCount(0);
    await expect(menu.locator('.mcpPicker__note'), dimension).toHaveText('A filter takes 20 values at most.');
    await expect(chips(page), dimension).toHaveCount(20);
    await expect(pickerButton(page, dimension), dimension).toHaveText(`${label} · 20 selected`);
    // The twenty picks are in the address, one parameter for each. The page reads once for all of them.
    await expect.poll(() => new URL(page.url()).searchParams.getAll(dimension).length, { message: dimension }).toBe(20);
    await expect.poll(() => reads(server).length, { message: dimension }).toBe(2);
    await settled(page);
    expect(reads(server).at(-1).split('&').filter((part) => part.startsWith(`${dimension}=`)), dimension).toHaveLength(20);
    // A cleared box frees the others, and the note goes away.
    await menu.locator('input:checked').first().uncheck();
    await expect(menu.locator('input:disabled'), dimension).toHaveCount(0);
    await expect(menu.locator('.mcpPicker__note'), dimension).toBeHidden();
    await expect(chips(page), dimension).toHaveCount(19);
    await expect(pickerButton(page, dimension), dimension).toHaveText(`${label} · 19 selected`);
  }
});

// A list keeps 200 rows of its facet. The server cuts the list. The rows that a filter picks are never cut. The bar does not say that the list was cut.
// The field narrows what is there. The tile of the keys cannot tell the deleted keys apart in a list that is cut. The tile says so.
test('a list is cut at 200 values by the server: a value that is picked stays in it, the field narrows what is there, and the tile of the keys counts what the server says', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 210; i += 1) server.cells.push(cell(`bulk-${String(i).padStart(3, '0')}`, '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100));
  await open(page, '', server);
  // 214 keys have requests. The 200 with the most requests are listed. The tile counts the keys that have requests, as the server says.
  expect((await tiles(page))['Active keys']).toEqual(['214', 'keys with requests']);
  const menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(200);
  await expect(menu.locator('.mcpPicker__search')).toBeVisible();
  // bulk-000 has one request. It is one of the 14 that were cut, so the field has nothing of it.
  await menu.locator('.mcpPicker__search').fill('bulk-000');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('Nothing matches "bulk-000".');
  await page.keyboard.press('Escape');
  // The key is picked in the address. It is listed as a 201st row, checked. The 13 others that were cut stay cut.
  await page.goto('/mcp-integration/usage?key=bulk-000');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  const again = await openPicker(page, 'key');
  await expect(again.locator('.mcpPicker__option')).toHaveCount(201);
  await expect(pickerBox(page, 'key', 'bulk-000')).toBeChecked();
  await expect(again.locator('.mcpPicker__name').last()).toHaveText('bulk-000');
  await expect(again.locator('.mcpPicker__count').last()).toHaveText('1');
  await again.locator('.mcpPicker__search').fill('bulk-000');
  await expect(again.locator('.mcpPicker__option:not([hidden])')).toHaveCount(1);
  await expect(chips(page)).toHaveText(['Key=bulk-000']);
});

test('a list opens, picks and closes from the keyboard, and the focus goes back to its button', async ({ page }) => {
  const server = await open(page);
  const key = pickerButton(page, 'key');
  await key.focus();
  // Down opens the list on its first control, "All keys". Down again reaches the first value.
  await page.keyboard.press('ArrowDown');
  const menu = pickerMenu(page, 'key');
  await expect(menu).toBeVisible();
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'All keys' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(pickerBox(page, 'key', 'ops-all')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(pickerBox(page, 'key', 'ui_dead00000001')).toBeFocused();
  // Space ticks the box. The pick is at once (the button). The read starts when the clicks pause.
  await page.keyboard.press('Space');
  await expect(key).toHaveText('Key · old-bot');
  await expect(pickerBox(page, 'key', 'ui_dead00000001')).toBeChecked();
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&key=ui_dead00000001'));
  await settled(page);
  // The box keeps the focus through the read that follows its pick. The list is not drawn again for it.
  await expect(pickerBox(page, 'key', 'ui_dead00000001')).toBeFocused();
  // Escape closes the list and gives the focus back to its button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(key).toHaveAttribute('aria-expanded', 'false');
  await expect(key).toBeFocused();
  // A press outside closes a list too. Only one list is open at a time.
  await key.click();
  await expect(menu).toBeVisible();
  await pickerButton(page, 'method').click();
  await expect(pickerMenu(page, 'method')).toBeVisible();
  await expect(menu).toBeHidden();
  await period(page).click();
  await expect(pickerMenu(page, 'method')).toBeHidden();
});

test('Group by is a list of its own like the Order by of System Queries: one choice among key, method, client and result, from the keyboard too, and it is not a filter', async ({ page }) => {
  const server = await open(page);
  await groupButton(page).focus();
  await page.keyboard.press('ArrowDown');
  await expect(groupOption(page, 'key')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  await expect(groupButton(page)).toBeFocused();
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('', { group: 'key' }));
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=key$/);
  // It is an order. There is no chip, and nothing is in the count of filters that a phone shows.
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator('.mcpBar__groupPicker').locator('xpath=ancestor::div[contains(@class, "obsFilterBar__field")]')).toHaveAttribute('data-summary', 'off');
  // The fourth choice is the result. It works from the keyboard too: three Downs from the first one. It is in the address and in the read.
  // The Result list is still a filter. So the groups of the charts are the values that are picked, and the read asks for no ranking.
  await groupButton(page).focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(groupOption(page, 'result')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groupButton(page)).toHaveText('Group by · Result');
  await settled(page);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result$/);
  expect(reads(server).at(-1)).toBe(readFilters('', { group: 'result' }));
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by result');
  await tickFilters(page, server, 'result', 'ok');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result&result=ok$/);
  expect(reads(server).at(-1)).toBe(readFilters('&result=ok', { group: 'result', ranked: false }));
  await expect(chips(page)).toHaveText(['Result=ok']);
  await expect(groupButton(page)).toHaveText('Group by · Result');
  // The page and its lists have no other control that groups. The chart has no switch of its own. The instance is no choice of Group by.
  await expect(page.locator('.mcpOverview__split')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Methods', exact: true })).toHaveCount(0);
  await groupButton(page).click();
  await expect(groupOption(page, 'instance')).toHaveCount(0);
  await expect(groupOption(page, 'type')).toHaveCount(0);
  await expect(groupOption(page, 'result')).toHaveAttribute('aria-selected', 'true');
});

// ---- long names ----------------------------------------------------------------------------------------------------------------------------

// The longest names that each dimension takes: a key of 32 characters, a method, a client, a result, and an instance of 64 characters.
const longNamesFilters = {
  key: 'long-key-'.padEnd(32, 'k'),
  method: 'a_very_long_method_name_'.padEnd(64, 'm'),
  client: 'A client with a name that goes on and on and on and on and on and on'.slice(0, 64).trim(),
  result: 'a_result_code_that_is_very_long_'.padEnd(64, 'r'),
  instance: 'node-with-a-very-long-name-'.padEnd(64, 'n'),
};
const longServerFilters = () => {
  const server = newServer();
  server.cells.push(cell(longNamesFilters.key, '2026-10-14T08:00', 'call', longNamesFilters.client, longNamesFilters.method, longNamesFilters.result, 7, 14, 3, 0, 700, longNamesFilters.instance));
  return server;
};
// This block gives the position of the six pickers of the bar: the left and the width of each (Group by and the five lists).
const pickerBoxesFilters = (page) => page.locator('#mcpBar .obsFilterBar__lead .tracePicker__button').evaluateAll((els) => els.map((el) => {
  const box = el.getBoundingClientRect();
  return [Math.round(box.left * 10) / 10, Math.round(box.top * 10) / 10, Math.round(box.width * 10) / 10];
}));

test('a long name does not break a list, a chip or a button: the name ends in an ellipsis with the whole name in its title, the count of its row stays in view, and nothing of the bar moves', async ({ page }) => {
  expect(Object.values(longNamesFilters).map((name) => name.length)).toEqual([32, 64, expect.any(Number), 64, 64]);
  expect(longNamesFilters.client.length).toBeGreaterThan(55);
  await open(page, '', longServerFilters());
  const bare = await pickerBoxesFilters(page);
  // A row of a list shows a name that is too long with an ellipsis. The name is cut by the width of the list, not wrapped. The whole name is in the title of the row.
  // The count is at the right end of the row, in view. The list has no sideways scroll.
  for (const [dimension, value] of Object.entries(longNamesFilters)) {
    const menu = await openPicker(page, dimension);
    const row = menu.locator('.mcpPicker__option', { has: page.locator('.mcpPicker__name', { hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    await expect(row, dimension).toHaveCount(1);
    await expect(row, dimension).toHaveAttribute('title', value);
    const m = await row.evaluate((el) => {
      const name = el.querySelector('.mcpPicker__name');
      const count = el.querySelector('.mcpPicker__count');
      const panel = el.closest('.mcpPicker__menu');
      const box = (node) => node.getBoundingClientRect();
      return {
        cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, nowrap: getComputedStyle(name).whiteSpace,
        count: count.textContent, countWidth: box(count).width, countInside: box(count).right <= box(panel).right + 0.5 && box(count).left >= box(panel).left - 0.5,
        sideways: panel.scrollWidth - panel.clientWidth, rowSideways: el.scrollWidth - el.clientWidth, height: box(el).height,
      };
    });
    // The 32 characters of a key fit the room of a name in a list. The 64 characters of the others do not fit. They are cut, and the cut ends in an ellipsis.
    expect(m.cut, `${dimension}: the name is cut`).toBe(dimension !== 'key');
    expect(m.ellipsis, dimension).toBe('ellipsis');
    expect(m.nowrap, dimension).toBe('nowrap');
    expect(m.count, dimension).toBe('7');
    expect(m.countWidth, `${dimension}: the count has its room`).toBeGreaterThan(4);
    expect(m.countInside, `${dimension}: the count is inside the list`).toBe(true);
    expect(m.sideways, `${dimension}: the list does not scroll sideways`).toBeLessThanOrEqual(0);
    expect(m.rowSideways, `${dimension}: the row does not scroll sideways`).toBeLessThanOrEqual(0);
    expect(m.height, `${dimension}: the row is one line`).toBeLessThan(40);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
  // Picked from the address, the five values are five chips. Each chip ends in an ellipsis past 28 rem. The whole filter is in its title, and its x is in the chip.
  // The buttons of the lists say the values as far as they have room. The whole name is in their title. The bar has not moved for any of this, and the page has no sideways scroll.
  const query = Object.entries(longNamesFilters).map(([dimension, value]) => `${dimension}=${encodeURIComponent(value)}`).join('&');
  await page.goto(`/mcp-integration/usage?${query}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(5);
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const chipBoxes = await chips(page).evaluateAll((els) => els.map((el) => {
    const value = el.querySelector('.chip__value');
    const remove = el.querySelector('.chip__remove');
    const box = el.getBoundingClientRect();
    return { title: el.title, width: box.width, cut: value.scrollWidth > value.clientWidth, removeInside: remove.getBoundingClientRect().right <= box.right + 0.5 && remove.getBoundingClientRect().width > 0, height: box.height };
  }));
  expect(chipBoxes.map((item) => item.title)).toEqual([
    `Key = ${longNamesFilters.key}`, `Method = ${longNamesFilters.method}`, `Client = ${longNamesFilters.client}`, `Instance = ${longNamesFilters.instance}`, `Result = ${longNamesFilters.result}`,
  ]);
  for (const item of chipBoxes) {
    expect(item.width, item.title).toBeLessThanOrEqual(28 * rem + 1);
    expect(item.removeInside, item.title).toBe(true);
    expect(item.height, item.title).toBeLessThan(30);
  }
  // The 64 characters of a method do not fit in 28 rem. That chip ends in an ellipsis.
  expect(chipBoxes[1].cut).toBe(true);
  const labels = await chipLabels(page);
  expect(labels[1]).toBe(`Remove filter Method = ${longNamesFilters.method}`);
  const picked = await pickerBoxesFilters(page);
  expect(picked.map(([left, top, width]) => [Math.round(left), Math.round(top), Math.round(width)])).toEqual(bare.map(([left, top, width]) => [Math.round(left), Math.round(top), Math.round(width)]));
  for (const [dimension, value] of Object.entries(longNamesFilters)) {
    await expect(pickerButton(page, dimension), dimension).toHaveAttribute('title', value);
    const label = pickerButton(page, dimension).locator('.tracePicker__label');
    await expect(label, dimension).toContainText(value.slice(0, 8));
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // The row of the chips is still one line of 35 px. The figures are those of the one cell that has all five values.
  expect((await layout(page)).stands['the chips row'][1]).toBeCloseTo(35, 0);
  expect(await tiles(page)).toMatchObject({ Requests: ['7', 'in the last 7 days'], 'Tool calls': ['7', '100% of the requests'], 'Active keys': ['1', 'of 5 keys'] });
  await screenshot(page, 'filters-long-names');
});

// ---- a dimension that has nothing to choose from -------------------------------------------------------------------------------------------
// A dimension has nothing to choose from when its facet has fewer than two values and no filter of its own. Its list in the bar is disabled. The list says the value, or says none.
// The entries of a legend grouped by that dimension are locked. A filter on the dimension keeps all of it offered, so the filter can be removed.
// The legacy key has no address. Its id is not `ui_` and 12 hexadecimal digits, so the page drops it from an address. The server refuses it. So a case that needs it picks it in a list.

test('one client is no choice: the Client list is off and says the client, and the entries of the six charts grouped by client are locked', async ({ page }) => {
  const server = await open(page, '?group=client');
  // All the clients are offered until a key is picked. The legacy key is the one of python-httpx alone.
  expect(await pickerState(page, 'client')).toMatchObject({ text: 'Client · All', title: 'All clients', disabled: false, off: false });
  await tickFilters(page, server, 'key', 'ui_legacy000000');
  await expect(chips(page)).toHaveText(['Key=legacy']);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ui_legacy000000', { group: 'client' }));
  // The list is disabled in its place. It has no arrow, it is dimmed, and it is not in the tab order. It says the client, and its title says why.
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · python-httpx', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  await expect(pickerButton(page, 'client')).toBeDisabled();
  // The other lists have values to choose from. The key that was picked has three methods and three results. Two instances are known.
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · legacy', disabled: false, off: false });
  expect(await pickerState(page, 'method')).toMatchObject({ text: 'Method · All', disabled: false });
  expect(await pickerState(page, 'result')).toMatchObject({ text: 'Result · All', disabled: false });
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · All (2)', disabled: false });
  // The six charts are grouped by client. The one entry of each legend is locked. The entry is a button that is off, with no aria-pressed, and its title says why.
  for (const id of CHARTS) {
    await expect(legend(page, id), id).toHaveCount(1);
    await expect(entry(page, 'client:python-httpx', id), id).toBeDisabled();
    await expect(entry(page, 'client:python-httpx', id), id).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(entry(page, 'client:python-httpx', id), id).toHaveAttribute('title', 'Only one client in this view');
  }
  // It cannot be pressed, not even by a click. The address and the chips are as they were.
  const count = server.calls.length;
  await entry(page, 'client:python-httpx').click({ force: true });
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(1);
  expect(server.calls).toHaveLength(count);
  expect(new URL(page.url()).searchParams.getAll('client')).toEqual([]);
  await screenshot(page, 'filters-one-client');
});

test('a dimension that has one value only is a list that is off, from the address too: the key of a deleted bot has one client, unknown', async ({ page }) => {
  // The address leads to a single value by one route. The deleted key made its requests with a client that said nothing about itself.
  await open(page, '?key=ui_dead00000001&group=client');
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · unknown', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  // The key was picked. Its list stays a list, because a filter keeps it. The lists that have two values or more stay on.
  // The key has two methods, two results and, with the two instances that the server knows, two instances.
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · old-bot', title: 'old-bot', disabled: false });
  for (const [dimension, label] of [['method', 'Method'], ['result', 'Result'], ['instance', 'Instance']]) {
    expect(await pickerState(page, dimension), dimension).toMatchObject({ text: expect.stringContaining(`${label} · All`), disabled: false, off: false });
  }
  // The legends of the charts that have something to draw have one locked entry. The deleted key has no error, so those two cards say so.
  for (const id of ['requests', 'refused', 'time', 'bytes']) {
    await expect(entry(page, 'client:unknown', id), id).toBeDisabled();
    await expect(entry(page, 'client:unknown', id), id).toHaveAttribute('title', 'Only one client in this view');
  }
  for (const id of ['errors', 'rate']) await expect(card(page, id).locator('.uiState--empty .uiState__title'), id).toHaveText('No errors in this window');
});

test('ping has one key, one client and one result: their lists are off, the lists that have a choice stay, and Tab goes past the lists that are off', async ({ page }) => {
  await open(page, '?method=ping');
  // The protocol method ping was sent by ops-all, through claude-code, and ended ok. So four dimensions have one value each.
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ops-all', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'client')).toEqual({ text: 'Client · claude-code', title: 'Only one client in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await pickerState(page, 'result')).toEqual({ text: 'Result · ok', title: 'Only one result in this view', disabled: true, ariaDisabled: 'true', off: true });
  // The method has a filter, so its list stays a list. The list lets the user remove ping. Both instances are known, so that list stays too.
  expect(await pickerState(page, 'method')).toMatchObject({ text: 'Method · ping', title: 'ping', disabled: false, off: false });
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · All (2)', title: 'The usage is summed over 2 instances. Pick some to see only theirs.', disabled: false, off: false });
  // From Group by, the keyboard goes to the Method list, then to the Instance list. The three lists that are disabled do not stop it.
  await groupButton(page).focus();
  await page.keyboard.press('Tab');
  await expect(pickerButton(page, 'method')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pickerButton(page, 'instance')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(windowButton(page, '1 h')).toBeFocused();
  // Back navigation works too. Shift+Tab goes from the window to the Instance list, then the Method list, then Group by. A list that is disabled is not a stop either way.
  await page.keyboard.press('Shift+Tab');
  await expect(pickerButton(page, 'instance')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pickerButton(page, 'method')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(groupButton(page)).toBeFocused();
  // One result is no choice either. When grouped by result, the one entry of each legend that has something to draw is locked. The title says why.
  // Ping has no error, no refusal and no call. Those cards say what they count.
  const server = await open(page, '?method=ping&group=result');
  for (const id of ['requests', 'bytes']) {
    await expect(legend(page, id), id).toHaveCount(1);
    await expect(entry(page, 'result:ok', id), id).toBeDisabled();
    await expect(entry(page, 'result:ok', id), id).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(entry(page, 'result:ok', id), id).toHaveAttribute('title', 'Only one result in this view');
  }
  const count = server.calls.length;
  await entry(page, 'result:ok').click({ force: true });
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(1);
  expect(server.calls).toHaveLength(count);
});

test('a filter on a dimension keeps it offered, so that it can be taken off: the list and the legend entry work, and go off with the filter', async ({ page }) => {
  // ci-bot made all the requests of Visual Studio Code. With the key and the client picked, the key has one value in its facet, and it is a filter.
  await open(page, '?group=key&key=ui_0a1b2c3d4e5f&client=Visual%20Studio%20Code');
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ci-bot', title: 'ci-bot', disabled: false, ariaDisabled: 'false', off: false });
  const menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ci-bot/ })).toBeChecked();
  await page.keyboard.press('Escape');
  // Its legend entry is a button that is pressed. A press lets the filter go.
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toBeEnabled();
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('aria-pressed', 'true');
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('title', 'Stop filtering by key ci-bot');
  // The chip removes the key. The client that is picked still leaves one key. So the dimension is not offered any more.
  await page.getByRole('button', { name: 'Remove filter Key = ci-bot' }).click();
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await settled(page);
  expect(await pickerState(page, 'key')).toEqual({ text: 'Key · ci-bot', title: 'Only one key in this view', disabled: true, ariaDisabled: 'true', off: true });
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toBeDisabled();
  await expect(entry(page, 'key:ui_0a1b2c3d4e5f')).toHaveAttribute('title', 'Only one key in this view');
  // The dimension is offered again as soon as the answer has a second value. Without the client filter, the list shows all the keys.
  await page.getByRole('button', { name: 'Remove filter Client = Visual Studio Code' }).click();
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  expect(await pickerState(page, 'key')).toMatchObject({ text: 'Key · All', title: 'All keys', disabled: false, off: false });
  await expect(entry(page, 'key:ops-all')).toBeEnabled();
});

test('unticking the last value of an open list keeps the list open, as it was; it is off once it closes', async ({ page }) => {
  await open(page, '?key=ui_0a1b2c3d4e5f&client=Visual%20Studio%20Code');
  const key = pickerButton(page, 'key');
  const menu = await openPicker(page, 'key');
  await menu.getByRole('checkbox', { name: /^ci-bot/ }).uncheck();
  // The filter is gone and the dimension has one value. The list does not close under the pointer. The page reads without the key filter.
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await expect.poll(() => new URL(page.url()).searchParams.getAll('key')).toEqual([]);
  await settled(page);
  await expect(menu).toBeVisible();
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(key).toBeEnabled();
  await expect(key).toHaveText('Key · All');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ci-bot']);
  await expect(menu.getByRole('checkbox', { name: /^ci-bot/ })).not.toBeChecked();
  // The next pick is still possible. Tick the key to put the filter back, and the list is what it was.
  await menu.getByRole('checkbox', { name: /^ci-bot/ }).check();
  await expect(chips(page)).toHaveText(['Key=ci-bot', 'Client=Visual Studio Code']);
  await settled(page);
  await expect(menu).toBeVisible();
  await expect(key).toHaveText('Key · ci-bot');
  await expect(key).toBeEnabled();
  // Unticked again, and closed, the list is disabled in its place. It says the key.
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
  // The next answer has no request at all. The page reads again from the code of the button. A press outside the list closes it, as it does.
  server.cells = [];
  await page.evaluate(() => document.querySelector('#mcpRefresh').click());
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('No methods in this view.');
  await expect(menu).toBeVisible();
  await expect(pickerButton(page, 'method')).toBeEnabled();
  // Closed, the list is disabled in its place and says none. The lists that were not open were disabled already. The instances are every instance that the server knows.
  // So that list has two values with no request, and it stays a list.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await pickerState(page, 'method')).toEqual({ text: 'Method · none', title: 'No method in this view', disabled: true, ariaDisabled: 'true', off: true });
  for (const [dimension, label, one] of [['key', 'Key', 'key'], ['client', 'Client', 'client'], ['result', 'Result', 'result']]) {
    expect(await pickerState(page, dimension), dimension).toMatchObject({ text: `${label} · none`, title: `No ${one} in this view`, disabled: true });
  }
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · All (2)', disabled: false });
});

// ---- the address ---------------------------------------------------------------------------------------------------------------------------

test('the address is the state: window, group and filters are read on load and written by every change', async ({ page }) => {
  const server = await open(page, '?window=30d&group=key&key=ops-all&method=query_table&client=claude-code');
  // The page reads once, as the address says. The key is the dimension of the group, and it is filtered. So the page asks for no ranking.
  expect(reads(server)).toEqual([readFilters('&key=ops-all&method=query_table&client=claude-code', { window: '30d', group: 'key', ranked: false })]);
  await expect(pressedWindow(page)).toHaveText('30 d');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = query_table', 'Remove filter Client = claude-code']);
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  await expect(pickerButton(page, 'method')).toHaveText('Method · query_table');
  await expect(pickerButton(page, 'client')).toHaveText('Client · claude-code');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by key');
  await expect(entry(page, 'key:ops-all')).toHaveAttribute('aria-pressed', 'true');
  await expect(period(page)).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  // The window counts from the first start with the file. A window older than that says so.
  await expect(page.locator('.mcpOverview__notes')).toContainText('Counted since Oct 1 08:00.');
  // A reload keeps all of it.
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all&method=query_table&client=claude-code', { window: '30d', group: 'key', ranked: false }));
  await expect(pressedWindow(page)).toHaveText('30 d');
  expect(await chipLabels(page)).toHaveLength(3);
  // A change writes the address. The defaults stay out of it.
  await windowButton(page, '7 d').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=key&key=ops-all&method=query_table&client=claude-code$/);
  await settled(page);
  await pickGroup(page, 'method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ops-all&method=query_table&client=claude-code$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all&method=query_table&client=claude-code', { ranked: false }));
  // The result is a group like the others. It is in the address as `group=result`. The default group is the method, and it is left out of the address.
  await pickGroup(page, 'result');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result&key=ops-all&method=query_table&client=claude-code$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all&method=query_table&client=claude-code', { group: 'result' }));
});

test('Back and Forward walk through the filters, the window and the group', async ({ page }) => {
  const server = await open(page);
  await tickFilters(page, server, 'key', 'ops-all');
  await expect(chips(page)).toHaveCount(1);
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
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all', { window: '24h' }));
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
  expect(reads(server).at(-1)).toBe(readFilters());
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  // Forward returns to each state.
  await page.goForward();
  await expect(chips(page)).toHaveCount(1);
  await settled(page);
  await page.goForward();
  await page.goForward();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&group=client&key=ops-all$/);
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by client');
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&key=ops-all', { window: '24h', group: 'client' }));
  // The result, as a group and as a filter, walks the same way. A pick in the Result list is an entry of the history, and so is the group.
  await page.goto('/mcp-integration/usage');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await pickGroup(page, 'result');
  await settled(page);
  await tickFilters(page, server, 'result', 'ok');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result&result=ok$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result$/);
  await expect(groupButton(page)).toHaveText('Group by · Result');
  await expect(pickerButton(page, 'result')).toHaveText('Result · All');
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('', { group: 'result' }));
  await page.goForward();
  await expect(chips(page)).toHaveText(['Result=ok']);
  await expect(pickerButton(page, 'result')).toHaveText('Result · ok');
  await settled(page);
  expect(reads(server).at(-1)).toBe(readFilters('&result=ok', { group: 'result', ranked: false }));
});

test('an address that the page cannot use is fixed at load: no window it does not keep, no group it does not offer, no value the server refuses', async ({ page }) => {
  // key=ui_zzzzzzzzzzzz has the shape of the id of a key made on the page, but its digits are not hexadecimal. The server answers 400 for it.
  // A client has no space at either end. `group=result` is the fourth group of the bar, and it stays. `split` is the old name of the group.
  const server = await open(page, '?window=48h&split=nope&group=result&key=BAD!&key=ui_zzzzzzzzzzzz&key=ui_0a1b&method=a%20b&client=%20padded&client=ok-client&type=call&type=call&result=ok&unknown=1');
  // The values that are fine stay. The address is replaced, not pushed. The page reads once, for the fixed state.
  // The result is filtered and it is the dimension of the group. So there is no ranking to ask for.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result&client=ok-client&result=ok&type=call$/);
  expect(reads(server)).toEqual([readFilters('&client=ok-client&result=ok&type=call', { group: 'result', ranked: false })]);
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(groupButton(page)).toHaveText('Group by · Result');
  expect(await chipLabels(page)).toEqual(['Remove filter Client = ok-client', 'Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  // The entry was replaced, not pushed. The page has one entry of the history.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  // A group that the bar does not offer is the default group, and the filter stays. The type is a filter only.
  await page.goto('/mcp-integration/usage?group=type&type=call');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?type=call$/);
  await expect(groupButton(page)).toHaveText('Group by · Method');
  expect(reads(server).at(-1)).toBe(readFilters('&type=call'));
  // An address of the old page, with its split alone, is the page with no group. The split goes, and nothing else is asked.
  const old = await open(page, '?split=result', newServer());
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  expect(reads(old)).toEqual([readFilters()]);
  expect(old.calls.filter((call) => call.path === '/usage/overview').every((call) => !call.query.includes('split'))).toBe(true);
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by method');
  // A client can have spaces inside. A method cannot.
  await page.goto('/mcp-integration/usage?client=Visual%20Studio%20Code&group=client');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  await expect(groupButton(page)).toHaveText('Group by · Client');
  // An address that has nothing to fix is left as it was written.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?client=Visual%20Studio%20Code&group=client$/);
  // A kind of filter takes 20 values. The 20 first values stay.
  const many = Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const other = newServer();
  await install(page, other);
  await page.goto(`/mcp-integration/usage?${many.map((name) => `method=${name}`).join('&')}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.getAll('method')).toEqual(many.slice(0, 20));
  expect(reads(other)).toEqual([readFilters(`&${many.slice(0, 20).map((name) => `method=${name}`).join('&')}`, { ranked: false })]);
  // A window that the retention does not keep is replaced by the default window. The meta lists the windows that it keeps.
  const short = newServer({ meta: { usage: { ...META.usage, retention_days: 7, windows: ['1h', '6h', '24h', '7d'], default_window: '24h' } } });
  await open(page, '?window=90d', short);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d']);
  await expect(pressedWindow(page)).toHaveText('24 h');
  expect(reads(short)).toEqual([readFilters('', { window: '24h' })]);
});

test('a filter on the dimension of the group asks for no ranking, a filter on another dimension keeps them: the read of each of the four groups', async ({ page }) => {
  // One read covers a window, a group and a set of filters. It asks for a ranking of the groups for each chart (`orders`), unless the dimension of the group is filtered.
  // In that case, its groups are the values that were picked. The same six values are in every chart.
  const cases = [
    ['key', '&key=ops-all', 'client=claude-code'],
    ['method', '&method=ping', 'client=claude-code'],
    ['client', '&client=claude-code', 'key=ops-all'],
    ['result', '&result=ok', 'key=ops-all'],
  ];
  for (const [group, own, other] of cases) {
    const asked = await open(page, `?group=${group}${own}`);
    expect(reads(asked), `${group}: its own dimension is filtered`).toEqual([readFilters(own, { group, ranked: false })]);
    expect(reads(asked)[0], group).not.toContain('orders=');
    const another = await open(page, `?group=${group}&${other}`);
    expect(reads(another), `${group}: another dimension is filtered`).toEqual([readFilters(`&${other}`, { group })]);
    expect(reads(another)[0], group).toContain('&orders=errors&orders=refused&orders=calls&orders=bytes');
  }
});

// ---- a filter never moves the page ---------------------------------------------------------------------------------------------------------
// The chips row is one line, and it is always there. The six cards have one height. A tile keeps the room of its sub line.
// A filter that is added or removed changes what the figures say. The answer that follows changes nothing of where they stand. The `walkFilters` function, in the header, makes the five changes.

for (const width of [1440, 1100, 820, 390]) {
  test(`nothing moves when a filter is added or removed, from a list, a legend, a chip or Clear filters, while the read runs and once it is drawn (${width} px)`, async ({ page }) => {
    // A phone folds its bar when the page opens. So the window has its size before the page loads. The bar is unfolded to reach its lists.
    await page.setViewportSize({ width, height: 900 });
    const server = await open(page);
    if (width <= 600) await page.locator('#mcpBar .obsFilterSummary').click();
    await fontsFilters(page);
    const base = await layout(page);
    expect(base.busy).toBe(false);
    // With no filter, the row is 35 px tall. The tiles and the cards stand where the others find them.
    expect(base.stands['the chips row'][1]).toBeCloseTo(35, 0);
    expect(base.stands['the tiles']).toHaveLength(7);
    expect(base.stands['the cards']).toHaveLength(6);
    await walkFilters(page, server, base);
  });
}

// ---- the bar at every width ----------------------------------------------------------------------------------------------------------------

// This block takes the measures of the eight controls of the bar: Group by, the five lists, the window and Refresh. It takes the box of each.
// It takes how much of the label of a list is cut (px). It takes the size of the bar and of its parts.
const barFilters = (page) => page.evaluate(() => {
  const bar = document.querySelector('#mcpBar');
  const controls = [...bar.querySelectorAll('.tracePicker__button, .mcpBar__windows, #mcpRefresh')].map((el) => {
    const box = el.getBoundingClientRect();
    const label = el.querySelector('.tracePicker__label');
    return { left: box.left, right: box.right, top: box.top, middle: box.top + box.height / 2, width: box.width, cut: label ? label.scrollWidth - label.clientWidth : 0 };
  });
  const panel = document.querySelector('#mcpPanel');
  return {
    height: bar.getBoundingClientRect().height, bar: bar.scrollWidth - bar.clientWidth, panel: panel.scrollWidth - panel.clientWidth,
    chips: document.querySelector('.mcpOverview__filters').getBoundingClientRect().width, controls,
  };
});
const settleFilters = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('the bar at every width: one row from 1101 px, the six pickers in a row down to 761 px, two to a row below, no sideways scroll, and no word of it cut at 1101 px', async ({ page }) => {
  await open(page);
  await fontsFilters(page);
  // The page loads once, then it is resized from wide to narrow. A phone folds the bar into its summary line. The summary line unfolds to reach the controls.
  for (const width of [1920, 1440, 1280, 1101, 1100, 900, 820, 761, 760, 601, 600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await settleFilters(page);
    if (width <= 600 && (await page.locator('#mcpBar .obsFilterSummary').getAttribute('aria-expanded')) === 'false') await page.locator('#mcpBar .obsFilterSummary').click();
    const m = await barFilters(page);
    const label = `${width} px`;
    expect(await horizontalOverflow(page), `${label}: the page`).toBeLessThanOrEqual(0);
    expect(m.bar, `${label}: the bar`).toBeLessThanOrEqual(0);
    expect(m.panel, `${label}: the panel`).toBeLessThanOrEqual(0);
    expect(m.controls, `${label}: the controls of the bar`).toHaveLength(8);
    expect(Math.max(...m.controls.map((control) => control.right)), `${label}: the right end of the bar`).toBeLessThanOrEqual(width);
    expect(Math.min(...m.controls.map((control) => control.left)), `${label}: the left end of the bar`).toBeGreaterThanOrEqual(0);
    const pickers = m.controls.slice(0, 6);
    const [windows, refresh] = m.controls.slice(6);
    const rows = [...new Set(pickers.map((control) => Math.round(control.middle / 4)))];
    if (width >= 1101) {
      // One row holds Group by, the five lists, the window and Refresh, from left to right. All are on one line, and the bar is one row high.
      expect(m.height, `${label}: the bar`).toBeLessThanOrEqual(52);
      expect(Math.max(...m.controls.map((control) => control.middle)) - Math.min(...m.controls.map((control) => control.middle)), `${label}: one row`).toBeLessThanOrEqual(2);
      expect(m.controls.map((control) => control.left), `${label}: left to right`).toEqual([...m.controls.map((control) => control.left)].sort((a, b) => a - b));
    } else if (width >= 761) {
      // The bar has two rows, as the bars of System do. The six pickers share the first row. The window and Refresh are the second row.
      expect(m.height, `${label}: the bar`).toBeGreaterThan(70);
      expect(rows, `${label}: the six pickers share a row`).toHaveLength(1);
      expect(windows.top, `${label}: the window is under the lists`).toBeGreaterThan(pickers[0].top + 20);
      expect(Math.abs(refresh.middle - windows.middle), `${label}: Refresh is the window's row`).toBeLessThanOrEqual(6);
    } else {
      // The lists wrap two to a row, which makes three rows of two. The window and Refresh are the last row.
      expect(rows, `${label}: three rows of lists`).toHaveLength(3);
      for (let i = 0; i < 6; i += 2) expect(Math.abs(pickers[i].middle - pickers[i + 1].middle), `${label}: two lists to a row`).toBeLessThanOrEqual(2);
      expect(pickers[1].left, `${label}: the second list is beside the first`).toBeGreaterThan(pickers[0].right - 1);
      expect(windows.top, `${label}: the window is under the lists`).toBeGreaterThan(pickers[4].top + 20);
      // The two lists of a row have the same width. The six lists have the same width.
      expect(new Set(pickers.map((control) => Math.round(control.width))).size, `${label}: one width for the six`).toBe(1);
    }
    // No word of the bar is cut from 820 px up. None is cut at 1101 px either, where the room is the smallest of the one-row bar.
    // From 761 px down, a long value ends in an ellipsis. Its title has the whole value.
    if (width >= 820) expect(pickers.map((control) => control.cut), `${label}: a cut label`).toEqual(Array(6).fill(0));
    if (width === 1101) {
      // Group by and the Instance list say the most when nothing is picked: "Group by · Method" and "Instance · All (2)".
      // They have more room than the four others (148 and 112 px). The four others have the same room.
      expect(pickers.map((control) => Math.round(control.width)), `${label}: the widths`).toEqual([148, 112, 112, 112, 112, 148]);
    }
    // The chips row is as wide as the bar.
    expect(m.chips, `${label}: the chips`).toBeGreaterThan(width - 4);
  }
  // A phone says what the row does with its hint. It says the first sentence only. The second is cut by the period.
  const hint = await page.locator('.mcpOverview__filtersHint').evaluate((el) => el.innerText.trim());
  expect(hint).toBe('No filters.');
  await expect(page.locator('.mcpOverview__filtersHintMore')).toBeHidden();
  await screenshot(page, 'filters-bar-phone');
});

test('the width of a list does not depend on what it says: with a value picked in each of the five lists, the six pickers stand where they stood, and a pick moves nothing', async ({ page }) => {
  for (const width of [1440, 1101, 820]) {
    await page.setViewportSize({ width, height: 900 });
    const server = await open(page);
    await fontsFilters(page);
    await settleFilters(page);
    const bare = await pickerBoxesFilters(page);
    const bareBar = await barFilters(page);
    // A pick in the list makes the button say the value, and nothing moves. The read is slowed down, so the page is seen while it runs too.
    server.delay['GET /usage/overview'] = 400;
    const menu = await openPicker(page, 'key');
    await menu.locator('input[value="ui_0a1b2c3d4e5f"]').check();
    await expect(pickerButton(page, 'key')).toHaveText('Key · ci-bot');
    await settleFilters(page);
    expect(await pickerBoxesFilters(page), `${width} px: after a pick`).toEqual(bare);
    await expect.poll(() => reads(server).length).toBeGreaterThan(1);
    await settled(page);
    await page.keyboard.press('Escape');
    expect(await pickerBoxesFilters(page), `${width} px: once it is read`).toEqual(bare);
    // The five lists have a value. One name is longer than "All", and the instance stands for "All (2)". The values come from the address, as they stand at load.
    await open(page, '?key=ops-all&method=query_table&client=claude-code&result=ok&instance=chdash-1');
    await fontsFilters(page);
    await settleFilters(page);
    for (const [dimension, text] of [['key', 'Key · ops-all'], ['method', 'Method · query_table'], ['client', 'Client · claude-code'], ['result', 'Result · ok'], ['instance', 'Instance · chdash-1']]) {
      await expect(pickerButton(page, dimension), `${width} px`).toHaveText(text);
    }
    expect(await pickerBoxesFilters(page), `${width} px: five values`).toEqual(bare);
    const picked = await barFilters(page);
    expect(Math.round(picked.height), `${width} px: the bar`).toBe(Math.round(bareBar.height));
    expect(picked.controls.map((control) => Math.round(control.left)), `${width} px: the window and Refresh`).toEqual(bareBar.controls.map((control) => Math.round(control.left)));
  }
});

// ---- the keyboard and the accessibility of the new controls ----------------------------------------------------------------------------------

test('the Result list from the keyboard: Down opens it on "All results", Down again reaches the first value, Space ticks it, "All results" clears it, Escape gives the focus back, and Tab goes through the six pickers in their order', async ({ page }) => {
  const server = await open(page);
  // Tab walks Group by and the five lists in the order of the bar, then the window. Every list is on while nothing is picked.
  await groupButton(page).focus();
  for (const dimension of ['key', 'method', 'client', 'result', 'instance']) {
    await page.keyboard.press('Tab');
    await expect(pickerButton(page, dimension), dimension).toBeFocused();
  }
  await page.keyboard.press('Tab');
  await expect(windowButton(page, '1 h')).toBeFocused();
  // The Result list: Down opens it on its first control, "All results". Down again reaches the first value, and Down once more the second.
  const result = pickerButton(page, 'result');
  await result.focus();
  await page.keyboard.press('ArrowDown');
  const menu = pickerMenu(page, 'result');
  await expect(menu).toBeVisible();
  await expect(result).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('button', { name: 'All results' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(pickerBox(page, 'result', 'ok')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(pickerBox(page, 'result', 'sql_error')).toBeFocused();
  // Space ticks the box. The pick is at once (the button and the chip). The read starts when the clicks pause. The box keeps the focus through it.
  await page.keyboard.press('Space');
  await expect(result).toHaveText('Result · sql_error');
  await expect(pickerBox(page, 'result', 'sql_error')).toBeChecked();
  await expect(chips(page)).toHaveText(['Result=sql_error']);
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters('&result=sql_error'));
  await settled(page);
  await expect(pickerBox(page, 'result', 'sql_error')).toBeFocused();
  // Up goes back to the action. Enter on it lets every result go. The list stays open, because the action is not a pick that closes it.
  await page.keyboard.press('ArrowUp');
  await expect(pickerBox(page, 'result', 'ok')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('button', { name: 'All results' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(result).toHaveText('Result · All');
  await expect(chips(page)).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect.poll(() => reads(server).at(-1)).toBe(readFilters());
  await settled(page);
  // Escape closes the list and gives the focus back to its button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(result).toHaveAttribute('aria-expanded', 'false');
  await expect(result).toBeFocused();
});

for (const theme of ['dark', 'light']) {
  test(`axe (${theme}): Group by with its four options, the Result list with a value picked, the chips and a view with lists that are off have no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    const server = await open(page, '?key=ops-all&client=claude-code');
    await page.waitForTimeout(1000);
    expect(await axeFilters(page), 'the bar with its chips').toEqual([]);
    // Group by is a list of one choice (a listbox). It has its name and four options.
    await groupButton(page).click();
    await expect(page.locator('.mcpBar__groupPicker .tracePicker__option')).toHaveText(['Key', 'Method', 'Client', 'Result']);
    await page.waitForTimeout(300);
    expect(await axeFilters(page), 'Group by with its four options').toEqual([]);
    await groupOption(page, 'result').click();
    await expect(groupButton(page)).toHaveText('Group by · Result');
    await settled(page);
    // The Result list is open. It is a dialog of check boxes with its counts. A pick checks the box and adds the chip. The list stays open.
    const menu = await openPicker(page, 'result');
    await page.waitForTimeout(300);
    expect(await axeFilters(page), 'the Result list').toEqual([]);
    const before = reads(server).length;
    await pickerBox(page, 'result', 'ok').check();
    await expect(chips(page)).toHaveCount(3);
    await expect.poll(() => reads(server).length).toBeGreaterThan(before);
    await settled(page);
    await page.waitForTimeout(300);
    expect(await axeFilters(page), 'the Result list with a value picked').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await axeFilters(page), 'the chips of three filters').toEqual([]);
    // This is a view in which three lists have one value. They are disabled in place: dimmed, with a title that says why.
    await page.goto('/mcp-integration/usage?method=ping');
    await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
    await expect(pickerButton(page, 'key')).toBeDisabled();
    await expect(pickerButton(page, 'client')).toBeDisabled();
    await expect(pickerButton(page, 'result')).toBeDisabled();
    await page.waitForTimeout(1000);
    expect(await axeFilters(page), 'lists that are off').toEqual([]);
    // The one list that has a choice still opens, beside the lists that are disabled.
    await openPicker(page, 'instance');
    await page.waitForTimeout(300);
    expect(await axeFilters(page), 'the list that is on, beside the ones that are off').toEqual([]);
  });
}

// ---- the six charts -----------------------------------------------------------------------------------------------------------------------
// Six charts show the steps of the window (app_mcp_charts.js, docs/mcp-integration-page.md, "The charts"): Requests, Errors, Error rate, Refused, Call time and Returned.
// All six are grouped by the Group by dimension (key, method, client or result), and cut by the same filters.
// Each chart draws the 8 groups that rank first for its own metric. The server ranks them once for each metric, in the one read of the tab: `order` and `orders`.
// The legend of the shared engine is the filter of the dimension that the charts are grouped by. The legend is a list, or the Values table.

// The names of the entries of a legend appear in their order. The id of an entry is `<dimension>:<value>`. The name is what the reader sees.
const legendNamesCharts = (page, id = 'requests') => legend(page, id).evaluateAll((items) => items.map((item) => item.querySelector('span').textContent));
// The Values table of a chart has a head and rows. Each row has the name of the group, then its figures.
const tableHeadCharts = (page, id = 'requests') => legendTable(page, id).locator('thead th').allTextContents();
const tableRowsCharts = (page, id = 'requests') => legendTable(page, id).locator('tbody tr').evaluateAll((rows) => rows.map((tr) => [...tr.cells].map((cell) => cell.textContent)));
// The legend of the six charts uses one mode. The mode is a preference of the browser. The button of any chart turns all six into the Values table, or back to the list.
const showValuesCharts = async (page) => {
  await modeButton(page).click();
  await expect(legendTable(page)).toBeVisible();
};
const showListCharts = async (page) => {
  await modeButton(page).click();
  await expect(legendTable(page)).toHaveCount(0);
};
// A card that has nothing to draw says so, in a box of the same size.
const emptyTitleCharts = (page, id) => card(page, id).locator('.uiState--empty .uiState__title');
// The colour of every entry of every chart: { group id: [the colours it has] }.
const coloursCharts = (page) => page.evaluate((ids) => {
  const found = {};
  for (const id of ids) {
    for (const item of document.querySelectorAll(`.mcpOverview__chart[data-chart="${id}"] .chartCore__legendItem`)) {
      (found[item.dataset.series] ||= []).push(getComputedStyle(item.querySelector('i')).backgroundColor);
    }
  }
  return found;
}, CHARTS);

// This is what each chart of the default view draws: the last 7 days, grouped by method. It lists the legend, entry by entry. Requests and Returned fold "2 more" methods.
// The other charts have nothing to fold into an entry. A method with none of the metric is left out, whatever the count of the groups.
const BY_METHOD_CHARTS = {
  requests: ['query_table', 'ping', 'list_hosts', 'tools/list', 'run_query', 'describe_table', 'initialize', 'notifications/initialized', '2 more'],
  errors: ['query_table', 'run_query', 'other'],
  rate: ['query_table', 'run_query', 'other'],
  refused: ['unread'],
  time: ['query_table', 'list_hosts', 'run_query', 'describe_table'],
  bytes: ['query_table', 'tools/list', 'run_query', 'describe_table', 'list_hosts', 'initialize', 'ping', 'unread', '2 more'],
};
const idsOfCharts = (dimension, names) => names.map((name) => (name.endsWith(' more') ? '~rest' : `${dimension}:${name}`));

test('the last 7 days: the tiles and six charts over the 56 steps of 3 hours, grouped by method, each with the legend of its own metric, read once', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`]);
  expect(server.calls.filter((call) => call.path === '/meta')).toHaveLength(1);
  // The tab has no heading row. The period is at the right end of the chips row. The h2 of the part is for screen readers.
  await expect(page.locator('#mcpOverviewTitle')).toHaveText('Usage of all keys');
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
  await expect(period(page)).toHaveAttribute('title', 'The period that the figures cover');
  // The windows that the retention keeps appear, finest first. The default window is pressed.
  await expect(page.locator('.mcpBar__windows [data-window]')).toHaveText(['1 h', '6 h', '24 h', '7 d', '30 d', '90 d']);
  await expect(pressedWindow(page)).toHaveText('7 d');
  expect(await tiles(page)).toEqual({
    Requests: ['1,101', 'in the last 7 days'],
    'Tool calls': ['889', '80.7% of the requests'],
    Errors: ['11', '1% of read requests'],
    Refused: ['3', '2 by the rate limit'],
    'Call time': ['17 ms', 'max 900 ms'],
    Returned: ['1.2 MB', '5,247 rows'],
    // Three of the five keys that exist have requests. The deleted key has requests too, and it is told apart.
    'Active keys': ['3', 'of 5 keys · 1 deleted'],
  });
  // Six charts cover the 56 steps of 3 hours of the window. The order is Requests, Errors, Error rate, Refused, Call time, Returned.
  // The counts and the bytes are bars. The two figures that are not sums (a rate and an average) are lines.
  expect(await titles(page)).toEqual(['Requests by method', 'Errors by method', 'Error rate by method', 'Refused by method', 'Call time by method', 'Returned by method']);
  await expect(page.locator('.mcpOverview__card')).toHaveCount(6);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta')).toHaveText('by 3 hours');
  for (const [id, type, name] of [['requests', 'bar', 'Requests'], ['errors', 'bar', 'Errors'], ['rate', 'line', 'Error rate'], ['refused', 'bar', 'Refused'], ['time', 'line', 'Call time'], ['bytes', 'bar', 'Returned']]) {
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-type', type);
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('aria-label', `${name} by method over time`);
  }
  const { from, points, stepMs } = geometry('7d');
  for (const id of CHARTS) expect(await xRange(page, id), id).toEqual([from, from + points * stepMs]);
  // Each chart keeps the groups that rank first for its own metric. It folds the others into "N more" when they have something to draw. So the legends are not the same six lists.
  // The errors and their rate have the same groups. A rate is ranked by the errors.
  for (const id of CHARTS) {
    expect(await legendNamesCharts(page, id), id).toEqual(BY_METHOD_CHARTS[id]);
    expect(await legendIds(page, id), id).toEqual(idsOfCharts('method', BY_METHOD_CHARTS[id]));
  }
  // Nothing on the page is a table. A value is picked in a list of the bar or in a legend.
  await expect(page.locator('.mcpOverview table')).toHaveCount(0);
  await screenshot(page, 'usage-default');
});

test('one read serves the six charts: each draws the ranking of its own metric, and the page asks for no ranking when the Group by dimension is filtered', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`]);
  // The server gives the answer. The requests rank the groups of the answer. The other four metrics have a ranking each, in `series.rankings`, in the order of the request.
  const answer = overviewOf(server, new URLSearchParams(`window=7d&group=method${ORDERS}`)).body;
  expect(answer.order).toBe('requests');
  expect(Object.keys(answer.series.rankings)).toEqual(['errors', 'refused', 'calls', 'bytes']);
  const ranked = { requests: answer.series, errors: answer.series.rankings.errors, rate: answer.series.rankings.errors, refused: answer.series.rankings.refused, time: answer.series.rankings.calls, bytes: answer.series.rankings.bytes };
  for (const id of CHARTS) {
    const groups = ranked[id].groups.map((group) => `method:${group.id}`);
    expect((await legendIds(page, id)).filter((value) => value !== '~rest'), `${id}: the groups of its ranking`).toEqual(groups);
  }
  // The charts do not draw the same groups. A method that is busy and never fails is in Requests, and not in Errors.
  expect(await legendIds(page, 'requests')).toContain('method:ping');
  expect(await legendIds(page, 'errors')).not.toContain('method:ping');
  expect(await legendIds(page, 'rate')).toEqual(await legendIds(page, 'errors'));
  // The Group by dimension is filtered. Its groups are the values that were picked, in their order, the same in every chart that draws. The read is the one without `orders`.
  // Every ranking has only those values, so the answer is much smaller.
  await open(page, '?method=run_query&method=query_table', server);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&order=requests&method=run_query&method=query_table');
  expect(reads(server).at(-1)).not.toContain('orders');
  for (const id of ['requests', 'errors', 'rate', 'time', 'bytes']) {
    expect(await legendIds(page, id), id).toEqual(['method:run_query', 'method:query_table']);
  }
  // A chart with nothing for them (no refusal) says so. The rest of the page does not change.
  await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
  // The filters of the other dimensions leave the ranking in the read. The dimension of the groups decides the ranking.
  await open(page, '?key=ops-all', server);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&key=ops-all`);
  await open(page, '?group=client&method=ping', server);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=client${ORDERS}&method=ping`);
});

test('Group by: key, method, client or result groups the six charts the same way, and the choice is in the address and in the read', async ({ page }) => {
  const server = await open(page);
  // The bar offers four groups. A pick that changes nothing reads nothing.
  await groupButton(page).click();
  await expect(page.locator('.mcpBar__groupPicker .tracePicker__option')).toHaveText(['Key', 'Method', 'Client', 'Result']);
  await groupOption(page, 'method').click();
  await expect(groupButton(page)).toHaveText('Group by · Method');
  expect(reads(server)).toHaveLength(1);
  // By client: the clients are the groups. Each chart has its own ranking.
  await pickGroup(page, 'client');
  await expect(groupButton(page)).toHaveText('Group by · Client');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=client$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=client${ORDERS}`);
  expect(await titles(page)).toEqual(['Requests by client', 'Errors by client', 'Error rate by client', 'Refused by client', 'Call time by client', 'Returned by client']);
  const byClient = {
    requests: ['claude-code', 'mcp-inspector', 'unknown', 'python-httpx', 'Visual Studio Code'],
    errors: ['claude-code', 'python-httpx'],
    rate: ['claude-code', 'python-httpx'],
    refused: ['python-httpx', 'unknown'],
    time: ['claude-code', 'mcp-inspector', 'unknown', 'python-httpx'],
    bytes: ['claude-code', 'mcp-inspector', 'unknown', 'Visual Studio Code', 'python-httpx'],
  };
  for (const id of CHARTS) {
    expect(await legendNamesCharts(page, id), id).toEqual(byClient[id]);
    expect(await legendIds(page, id), id).toEqual(idsOfCharts('client', byClient[id]));
  }
  await expect(chartBox(page, 'requests').locator('.chartCore')).toHaveAttribute('aria-label', 'Requests by client over time');
  await expect(chartBox(page, 'rate').locator('.chartCore')).toHaveAttribute('aria-label', 'Error rate by client over time');
  await expect(entry(page, 'client:claude-code')).toHaveAttribute('title', 'Filter by client claude-code');
  // By key: the groups are the keys, by their names, not their ids. A deleted key is a group like another.
  await pickGroup(page, 'key');
  await expect(groupButton(page)).toHaveText('Group by · Key');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=key$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=key${ORDERS}`);
  expect(await titles(page)).toEqual(['Requests by key', 'Errors by key', 'Error rate by key', 'Refused by key', 'Call time by key', 'Returned by key']);
  const byKey = {
    requests: ['ops-all', 'old-bot', 'legacy', 'ci-bot'],
    errors: ['ops-all', 'ci-bot', 'legacy'],
    rate: ['ops-all', 'ci-bot', 'legacy'],
    refused: ['legacy', 'old-bot'],
    time: ['ops-all', 'old-bot', 'legacy', 'ci-bot'],
    bytes: ['ops-all', 'old-bot', 'ci-bot', 'legacy'],
  };
  for (const id of CHARTS) expect(await legendNamesCharts(page, id), id).toEqual(byKey[id]);
  expect(await legendIds(page)).toEqual(['key:ops-all', 'key:ui_dead00000001', 'key:ui_legacy000000', 'key:ui_0a1b2c3d4e5f']);
  // By result: the groups are the codes. See the test of the result below.
  await pickGroup(page, 'result');
  await expect(groupButton(page)).toHaveText('Group by · Result');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=result${ORDERS}`);
  expect(await titles(page)).toEqual(['Requests by result', 'Errors by result', 'Error rate by result', 'Refused by result', 'Call time by result', 'Returned by result']);
  // A legend is the filter of the group. An entry picks that client. A second press releases it. A name with spaces stays one value.
  await pickGroup(page, 'client');
  await settled(page);
  await entry(page, 'client:Visual Studio Code', 'bytes').click();
  await expect(chips(page)).toHaveText(['Client=Visual Studio Code']);
  expect(new URL(page.url()).searchParams.getAll('client')).toEqual(['Visual Studio Code']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=client&order=requests&client=Visual+Studio+Code');
  expect(await legendIds(page)).toEqual(['client:Visual Studio Code']);
  // Method is the default again, which the address does not say.
  await pickGroup(page, 'method');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?client=Visual\+Studio\+Code$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&client=Visual+Studio+Code`);
});

test('grouped by result the charts show the codes: the error codes are the groups of Errors, ok is folded away, and the legend filters by result', async ({ page }) => {
  const server = await open(page, '?group=result');
  expect(reads(server)).toEqual([`?window=7d&group=result${ORDERS}`]);
  await expect(groupButton(page)).toHaveText('Group by · Result');
  expect(await titles(page)).toEqual(['Requests by result', 'Errors by result', 'Error rate by result', 'Refused by result', 'Call time by result', 'Returned by result']);
  // Every result that has requests is a group of Requests. The ok result comes first. The errors are the codes that ended in an error.
  // The ok result has no error. It is folded without an entry, because "N more" says nothing of a group that has nothing to draw. A refusal is no error, so the codes of the refusals are in Refused.
  const byResult = {
    requests: ['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', '413_payload_too_large', 'rpc_error_32601'],
    errors: ['sql_error', 'table_not_allowed', 'rpc_error_32601'],
    rate: ['sql_error', 'table_not_allowed', 'rpc_error_32601'],
    refused: ['429_rate_limited', '413_payload_too_large'],
    time: ['ok', 'sql_error', 'table_not_allowed'],
    bytes: ['ok', 'sql_error', 'table_not_allowed', '429_rate_limited', 'rpc_error_32601', '413_payload_too_large'],
  };
  for (const id of CHARTS) {
    expect(await legendNamesCharts(page, id), id).toEqual(byResult[id]);
    expect(await legendIds(page, id), id).toEqual(byResult[id].map((name) => `result:${name}`));
    await expect(legend(page, id).filter({ hasText: /more$/ }), `${id}: nothing is folded into an entry`).toHaveCount(0);
  }
  // The rate of an error code is 100%. All the requests of an error code are errors. The axis ends there.
  expect(await chartJson(chartBox(page, 'rate').locator('.chartCore'), 'data-y-ticks')).toEqual(['0', '25%', '50%', '75%', '100%']);
  // The words that stand for a code are in the title of its entry. A result is a code of the tools (`ok`), or what the server makes of a refusal or an error of the protocol.
  await expect(entry(page, 'result:ok')).toHaveAttribute('title', 'Filter by result ok\nThe request succeeded');
  await expect(entry(page, 'result:429_rate_limited')).toHaveAttribute('title', 'Filter by result 429_rate_limited\nRefused before its message was read (HTTP 429)');
  await expect(entry(page, 'result:sql_error')).toHaveAttribute('title', 'Filter by result sql_error');
  // The legend of Errors is the filter of the results. A code is a chip, `Result = ...`, and the figures follow. A JSON-RPC error is a request, not a call.
  await entry(page, 'result:rpc_error_32601', 'errors').click();
  await expect(chips(page)).toHaveText(['Result=rpc_error_32601']);
  expect(await chipLabels(page)).toEqual(['Remove filter Result = rpc_error_32601']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?group=result&result=rpc_error_32601$/);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=result&order=requests&result=rpc_error_32601');
  for (const id of ['requests', 'errors', 'rate', 'bytes']) expect(await legendIds(page, id), id).toEqual(['result:rpc_error_32601']);
  await expect(entry(page, 'result:rpc_error_32601', 'errors')).toHaveAttribute('title', 'Stop filtering by result rpc_error_32601\nA JSON-RPC error of the protocol (code -32601)');
  await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
  await expect(emptyTitleCharts(page, 'time')).toHaveText('No tool calls in this window');
  expect(await tiles(page)).toMatchObject({ Requests: ['1', 'in the last 7 days'], Errors: ['1', '100% of read requests'] });
});

test('the legends are the filter of the group: a pressed entry dims the others in the charts that have it, then the charts keep the groups that are picked', async ({ page }) => {
  const server = newServer();
  await open(page, '', server);
  // The entries that the filter leaves out are dimmed (`is-off`). None is dimmed while nothing is picked. None is pressed.
  const dimmed = (id) => legend(page, id).evaluateAll((items) => Object.fromEntries(items.map((item) => [item.dataset.series, item.classList.contains('is-off')])));
  const real = (all) => Object.entries(all).filter(([id]) => id !== '~rest');
  for (const id of CHARTS) expect(Object.values(await dimmed(id)).filter(Boolean), id).toEqual([]);
  await expect(legend(page).first()).toHaveAttribute('title', 'Filter by method query_table');
  await expect(legend(page).first()).toHaveAttribute('aria-pressed', 'false');
  // A click presses the entry, here in the legend of the bytes. Before the answer comes, the others dim in every chart that has the entry.
  // Ping has no error, no refusal and no call. So it is in two of the six legends: Requests and Returned.
  server.delay['GET /usage/overview'] = 700;
  await entry(page, 'method:ping', 'bytes').click();
  for (const id of ['requests', 'bytes']) {
    await expect(entry(page, 'method:ping', id)).toHaveAttribute('aria-pressed', 'true');
    await expect(entry(page, 'method:ping', id)).toHaveAttribute('title', 'Stop filtering by method ping\nA client checks that the server answers');
    await expect.poll(async () => {
      const all = await dimmed(id);
      return all['method:ping'] === false && real(all).filter(([name]) => name !== 'method:ping').every(([, off]) => off);
    }, { message: id }).toBe(true);
  }
  // The charts that do not have the entry draw as they did. Nothing is pressed there, so nothing dims.
  for (const id of ['errors', 'rate', 'refused', 'time']) expect(Object.values(await dimmed(id)).filter(Boolean), id).toEqual([]);
  await expect(page.locator('.mcpOverview__body')).toHaveAttribute('aria-busy', 'true');
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?method=ping$/);
  await expect(chips(page)).toHaveCount(1);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`, '?window=7d&group=method&order=requests&method=ping']);
  // The answer: the groups are the values that are picked, and every figure of the page has the filter. The calls of ping are protocol requests.
  // Ping has no error, no refusal and no call. So those four charts say so. The other two keep their group.
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:ping']);
  expect(await legendIds(page, 'bytes')).toEqual(['method:ping']);
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'true');
  for (const [id, title] of [['errors', 'No errors in this window'], ['rate', 'No errors in this window'], ['refused', 'No refused request in this window'], ['time', 'No tool calls in this window']]) {
    await expect(emptyTitleCharts(page, id), id).toHaveText(title);
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(0);
  }
  expect(await tiles(page)).toMatchObject({ Requests: ['100', 'in the last 7 days'], 'Tool calls': ['0', '0% of the requests'], 'Active keys': ['1', 'of 5 keys'] });
  // The keyboard stays on the entry that was pressed. A second press releases it. Then the charts have all their groups again.
  await expect(entry(page, 'method:ping', 'bytes')).toBeFocused();
  server.delay['GET /usage/overview'] = 0;
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(legend(page, 'bytes')).toHaveCount(9);
  await settled(page);
  await expect(entry(page, 'method:ping', 'bytes')).toHaveAttribute('aria-pressed', 'false');
  await expect(entry(page, 'method:ping', 'bytes')).toBeFocused();
  for (const id of CHARTS) expect(Object.values(await dimmed(id)).filter(Boolean), id).toEqual([]);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}`);
});

test('a legend entry filters from the keyboard, in the list and in the Values table: Tab goes past "N more", Enter picks, Space lets go, and the keyboard stays on the entry', async ({ page }) => {
  const server = await open(page);
  // The entries are buttons in the tab order. "N more" is no filter, and it is not a stop. So after the last entry comes the button that changes the mode.
  // Then comes the plot of the next chart, which is a stop of the keyboard, and its first entry. The cursor of the plot is that stop.
  await entry(page, 'method:notifications/initialized').focus();
  await page.keyboard.press('Tab');
  await expect(modeButton(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(chartBox(page, 'errors').locator('.chartCore__overlay')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(entry(page, 'method:query_table', 'errors')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(entry(page, 'method:notifications/initialized')).toBeFocused();
  await entry(page, 'method:run_query').focus();
  // Enter picks the entry: the chip, the address and the read follow. The charts are drawn again for the answer. The keyboard stays on the entry.
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveText(['Method=run_query']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&order=requests&method=run_query');
  await expect(entry(page, 'method:run_query')).toHaveAttribute('aria-pressed', 'true');
  await expect(entry(page, 'method:run_query')).toBeFocused();
  // Space releases the entry. All the groups are back, and the keyboard stays on the entry.
  await page.keyboard.press('Space');
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}`);
  await expect(entry(page, 'method:run_query')).toHaveAttribute('aria-pressed', 'false');
  await expect(entry(page, 'method:run_query')).toBeFocused();
  // The Values table: the entry is the first cell of its row. It is a button, as in the list, and it filters the same way.
  await showValuesCharts(page);
  const inTable = entry(page, 'method:query_table', 'errors');
  await expect(inTable).toHaveAttribute('aria-pressed', 'false');
  server.delay['GET /usage/overview'] = 500;
  await inTable.focus();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveText(['Method=query_table']);
  // The rows that the filter leaves out are dimmed with their entry while the page reads. The figures of a dimmed row are dimmed too.
  await expect(legendTable(page, 'errors').locator('tbody tr.is-off')).toHaveCount(2);
  await expect(legendTable(page, 'errors').locator('tbody tr:not(.is-off)')).toHaveCount(1);
  const colourOf = (selector) => legendTable(page, 'errors').locator(selector).first().evaluate((el) => getComputedStyle(el).color);
  expect(await colourOf('tbody tr.is-off td')).not.toBe(await colourOf('tbody tr:not(.is-off) td'));
  await settled(page);
  await expect(entry(page, 'method:query_table', 'errors')).toBeFocused();
  await expect(legendTable(page, 'errors')).toBeVisible();
  expect(await tableRowsCharts(page, 'errors')).toEqual([['query_table', '5', '0', '3', '0.0893', '2']]);
  server.delay['GET /usage/overview'] = 0;
  await page.keyboard.press('Space');
  await expect(chips(page)).toHaveCount(0);
  await settled(page);
  await expect(entry(page, 'method:query_table', 'errors')).toBeFocused();
  await expect(legend(page, 'errors')).toHaveCount(3);
});

test('"N more" folds the groups that a chart does not draw: its title says what the chart keeps, it is no filter, and it is left out when the folded groups have nothing to draw', async ({ page }) => {
  const server = await open(page);
  // Requests and Returned have ten methods. They keep the 8 that rank first for their metric. "2 more" is one entry. It is a button that is off, with no pressed state.
  // Its title says what the chart keeps, and where to pick the others.
  for (const [id, words] of [['requests', 'requests'], ['bytes', 'bytes returned']]) {
    await expect(entry(page, '~rest', id)).toBeDisabled();
    await expect(entry(page, '~rest', id)).not.toHaveAttribute('aria-pressed', /.*/);
    await expect(entry(page, '~rest', id)).toHaveText('2 more');
    await expect(entry(page, '~rest', id)).toHaveAttribute('title', `2 more methods that the chart folds together: it keeps the 8 that have the most ${words}. Pick them in the Method list of the bar`);
  }
  // The four others have fewer than 8 methods with something to draw. The methods that have none of their metric are folded, without an entry.
  // An entry "7 more" that held errors of zero says nothing.
  for (const id of ['errors', 'rate', 'refused', 'time']) await expect(entry(page, '~rest', id), id).toHaveCount(0);
  // A click on it filters nothing. It makes no chip and starts no read.
  const count = server.calls.length;
  await entry(page, '~rest').click({ force: true });
  await page.waitForTimeout(300);
  await expect(chips(page)).toHaveCount(0);
  expect(server.calls).toHaveLength(count);
  // The folded groups are in the list of the bar. A pick there filters by them. Unread is one of the two that Requests folds.
  const menu = await openPicker(page, 'method');
  await menu.locator('input[value="unread"]').check();
  await page.keyboard.press('Escape');
  await expect(chips(page)).toHaveCount(1);
  await expect.poll(() => reads(server).at(-1)).toBe('?window=7d&group=method&order=requests&method=unread');
  await settled(page);
  expect(await chipLabels(page)).toEqual(['Remove filter Method = unread']);
  // The charts with the picked groups have no "N more". The groups are the values that were picked.
  expect(await legendIds(page)).toEqual(['method:unread']);
  expect(await legendIds(page, 'refused')).toEqual(['method:unread']);
  await expect(legend(page).filter({ hasText: /more$/ })).toHaveCount(0);

  // Ten methods all fail. Errors, Error rate, Call time, Requests and Returned each keep 8 and fold two. The entry says what its chart keeps.
  // The rate is ranked by the errors. Refused has none to fold, because nothing was refused.
  const failing = newServer();
  failing.cells = Array.from({ length: 10 }, (_, i) => [
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', `tool_${String(i).padStart(2, '0')}`, 'ok', 20 - i, 100, 20, 1, 1000),
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', `tool_${String(i).padStart(2, '0')}`, 'sql_error', 3, 10, 5, 0, 100),
  ]).flat();
  await open(page, '', failing);
  const kept = { requests: 'requests', errors: 'errors', rate: 'errors', time: 'tool calls', bytes: 'bytes returned' };
  for (const [id, words] of Object.entries(kept)) {
    expect(await legendIds(page, id), id).toEqual([...Array.from({ length: 8 }, (_, i) => `method:tool_0${i}`), '~rest']);
    await expect(entry(page, '~rest', id), id).toHaveText('2 more');
    await expect(entry(page, '~rest', id), id).toHaveAttribute('title', `2 more methods that the chart folds together: it keeps the 8 that have the most ${words}. Pick them in the Method list of the bar`);
  }
  await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
  // The tie of the errors (3 each) is broken by the name, the smaller first. tool_08 and tool_09 are the two that are folded.
  await openPicker(page, 'method');
  await expect(pickerMenu(page, 'method').locator('.mcpPicker__name')).toHaveText(Array.from({ length: 10 }, (_, i) => `tool_0${i}`));
});

test('a group keeps its colour: it comes from its name, not from its rank, in every chart, window and group, and under every filter', async ({ page }) => {
  const server = await open(page);
  const hosts = await swatch(page, 'method:list_hosts');
  // list_hosts is third in Requests, second in Call time and fifth in Returned. The colour is not the colour of a rank.
  expect((await legendIds(page)).indexOf('method:list_hosts')).toBe(2);
  expect((await legendIds(page, 'time')).indexOf('method:list_hosts')).toBe(1);
  expect((await legendIds(page, 'bytes')).indexOf('method:list_hosts')).toBe(4);
  for (const id of ['requests', 'time', 'bytes']) expect(await swatch(page, 'method:list_hosts', id), id).toBe(hosts);
  // Every group has one colour in all the charts that draw it. No two groups of the six charts share one colour. There are fewer than 18 groups.
  const colours = await coloursCharts(page);
  const real = Object.entries(colours).filter(([id]) => id !== '~rest');
  for (const [id, list] of real) expect(new Set(list).size, id).toBe(1);
  expect(new Set(real.map(([, list]) => list[0])).size).toBe(real.length);
  expect(real.length).toBe(10);
  // "N more" is neutral. It has the colour of the others in every chart, and it is not the colour of a group.
  const other = await page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--qchart-other)';
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(colours['~rest']).toEqual([other, other]);
  expect(real.map(([, list]) => list[0])).not.toContain(other);
  // The key of the legacy client: list_hosts is the first method of the chart there. It has the same colour.
  const keys = await openPicker(page, 'key');
  await keys.locator('input[value="ui_legacy000000"]').check();
  await page.keyboard.press('Escape');
  await expect(chips(page)).toHaveCount(1);
  await expect.poll(() => reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&key=ui_legacy000000`);
  await settled(page);
  expect(await legendIds(page)).toEqual(['method:list_hosts', 'method:unread', 'method:other']);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another window: the same.
  await windowButton(page, '24 h').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by 15 minutes');
  await settled(page);
  expect(await swatch(page, 'method:list_hosts')).toBe(hosts);
  // Another group has its own groups, with the colour of their names.
  await pickGroup(page, 'client');
  await expect(card(page, 'requests').locator('.chartCard__title')).toHaveText('Requests by client');
  await settled(page);
  await expect(legend(page).locator('span')).toHaveText(['python-httpx']);
  const httpx = await swatch(page, 'client:python-httpx');
  await page.goto('/mcp-integration/usage?group=client');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(await swatch(page, 'client:python-httpx')).toBe(httpx);
});

// ---- the windows and their steps ------------------------------------------------------------------------------------------------------------
// The windows and their steps belong to the server (mcp_usage.hpp). Each window is cut in steps of its own. The six charts have the same x axis.
const WINDOW_CASES_CHARTS = [
  ['1 h', '1h', 'in the last hour', 'by the minute', 'Oct 14 09:01 → 10:00', '622'],
  ['6 h', '6h', 'in the last 6 hours', 'by 5 minutes', 'Oct 14 04:05 → 10:00', '685'],
  ['24 h', '24h', 'in the last 24 hours', 'by 15 minutes', 'Oct 13 10:15 → Oct 14 10:00', '750'],
  ['7 d', '7d', 'in the last 7 days', 'by 3 hours', 'Oct 7 12:00 → Oct 14 10:00', '1,101'],
  ['30 d', '30d', 'in the last 30 days', 'by 12 hours', 'Oct 1 08:00 → Oct 14 10:00', '1,207'],
  ['90 d', '90d', 'in the last 90 days', 'by the UTC day', 'Oct 1 08:00 → Oct 14 10:00', '1,207'],
];

test('each window reads again, with its own step: 1 h by the minute, 6 h by 5 minutes, 24 h by 15 minutes, 7 d by 3 hours, 30 d by 12 hours, 90 d by the day', async ({ page }) => {
  const server = await open(page);
  for (const [label, window, sub, step, range, requests] of WINDOW_CASES_CHARTS) {
    await windowButton(page, label).click();
    await expect(pressedWindow(page)).toHaveText(label);
    await settled(page);
    expect(reads(server).at(-1), window).toBe(`?window=${window}&group=method${ORDERS}`);
    await expect(period(page), window).toHaveText(range);
    expect((await tiles(page)).Requests, window).toEqual([requests, sub]);
    // The six charts show their step. They draw the window: as many steps as the server says, from the first one to the end of the last one.
    // Nobody was refused in the last hour. So Refused has nothing to draw there. Its card says so, and it keeps its step.
    for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta'), `${window} ${id}`).toHaveText(step);
    const { from, points, stepMs } = geometry(window);
    for (const id of CHARTS.filter((chart) => !(window === '1h' && chart === 'refused'))) expect(await xRange(page, id), `${window} ${id}`).toEqual([from, from + points * stepMs]);
    if (window === '1h') await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
    else await expect(page.locator('.mcpOverview__card .uiState--empty'), window).toHaveCount(0);
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
  expect(reads(server).at(-1)).toBe(`?window=365d&group=method${ORDERS}`);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=365d$/);
  expect((await tiles(page)).Requests).toEqual(['1,207', 'in the last 365 days']);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta'), id).toHaveText('by the UTC day');
  const { from, points, stepMs } = geometry('365d');
  expect(points).toBe(365);
  for (const id of CHARTS) expect(await xRange(page, id), id).toEqual([from, from + points * stepMs]);
  // The 12 months of bars fit the plot. The engine keeps the tallest of the bars that share a few pixels.
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('hovering a step reads it: its range, the groups that have a value in it and, for a stack, the total; each chart reads its own figure; a day is its UTC date', async ({ page }) => {
  await open(page);
  const hover = async (ms, id = 'requests') => {
    const at = await page.evaluate(([t, chart]) => window.ChDash.chartCore.of(document.querySelector(`.mcpOverview__chart[data-chart="${chart}"]`)).toClient(t, 0), [ms, id]);
    // This is the middle of the plot, whatever the scale of the chart.
    const [, top, , height] = String(await chartBox(page, id).locator('.chartCore').getAttribute('data-plot')).split(' ').map(Number);
    const box = await chartBox(page, id).locator('.chartCore__overlay').boundingBox();
    await page.mouse.move(at.x, box.y + top + height / 2);
  };
  const tip = (id = 'requests') => chartBox(page, id).locator('.chartCore__tooltip');
  const rows = (id = 'requests') => tip(id).locator('.chartCore__tipRow:not(.chartCore__tipRow--total) em');
  const values = (id = 'requests') => tip(id).locator('.chartCore__tipRow:not(.chartCore__tipRow--total) b');
  // The last step is 3 hours long, and the last hour is in it. The groups with a request come first, the biggest first. Then comes the total, which is the sum of the groups.
  await hover(Date.UTC(2026, 9, 14, 10, 30));
  await expect(tip()).toBeVisible();
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:00 → 12:00');
  await expect(rows()).toHaveText(['query_table', 'ping', 'tools/list', 'list_hosts', 'initialize']);
  await expect(values()).toHaveText(['402', '100', '60', '40', '20']);
  await expect(tip().locator('.chartCore__tipRow--total b')).toHaveText('622');
  // The step before has two groups, and the chart folds the rest, "2 more".
  await hover(Date.UTC(2026, 9, 14, 7, 30));
  await expect(tip().locator('strong')).toHaveText('Oct 14 06:00 → 09:00');
  await expect(rows()).toHaveText(['run_query', 'list_hosts', '2 more']);
  await expect(values()).toHaveText(['35', '25', '3']);
  await expect(tip().locator('.chartCore__tipRow--total b')).toHaveText('63');
  // A step with nothing says so.
  await hover(Date.UTC(2026, 9, 10, 13, 30));
  await expect(tip().locator('.chartCore__tipRow em')).toHaveText(['No value']);
  // The other charts read the same step with their own figure. The errors are a stack. Their rate and the time of the calls are lines.
// They have no total, and no row for a group with no value in the step.
  // The other figures are the refused requests of the step before, and the bytes.
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'errors');
  await expect(tip('errors').locator('strong')).toHaveText('Oct 14 09:00 → 12:00');
  await expect(rows('errors')).toHaveText(['query_table']);
  await expect(values('errors')).toHaveText(['2']);
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'rate');
  await expect(rows('rate')).toHaveText(['query_table']);
  await expect(values('rate')).toHaveText(['0.5%']);
  await expect(tip('rate').locator('.chartCore__tipRow--total')).toHaveCount(0);
  await hover(Date.UTC(2026, 9, 14, 7, 30), 'refused');
  await expect(tip('refused').locator('strong')).toHaveText('Oct 14 06:00 → 09:00');
  await expect(rows('refused')).toHaveText(['unread']);
  await expect(values('refused')).toHaveText(['2']);
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'time');
  await expect(rows('time')).toHaveText(['query_table', 'list_hosts']);
  await expect(values('time')).toHaveText(['14.9 ms', '4 ms']);
  await expect(tip('time').locator('.chartCore__tipRow--total')).toHaveCount(0);
  await hover(Date.UTC(2026, 9, 14, 10, 30), 'bytes');
  await expect(rows('bytes')).toHaveText(['query_table', 'tools/list', 'list_hosts', 'initialize', 'ping']);
  await expect(values('bytes')).toHaveText(['391.2 KB', '293.0 KB', '23.4 KB', '7.8 KB', '3.9 KB']);
  // By the minute: the range is the minute. Nothing comes before the calls of the 31st.
  await windowButton(page, '1 h').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by the minute');
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 31, 30));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:31 → 09:32');
  await expect(rows()).toHaveText(['query_table']);
  await expect(values()).toHaveText(['402']);
  // By 5 minutes and by 15 minutes: the range is the step.
  await windowButton(page, '6 h').click();
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 32));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:30 → 09:35');
  await windowButton(page, '24 h').click();
  await settled(page);
  await hover(Date.UTC(2026, 9, 14, 9, 40));
  await expect(tip().locator('strong')).toHaveText('Oct 14 09:30 → 09:45');
  // By the day: the UTC date is used, not the hours that the day starts at. The groups of the 90 days are not those of the week: "3 more".
  await windowButton(page, '90 d').click();
  await expect(card(page, 'requests').locator('.chartCard__meta')).toHaveText('by the UTC day');
  await settled(page);
  await hover(Date.UTC(2026, 9, 12, 12));
  await expect(tip().locator('strong')).toHaveText('2026-10-12 (UTC)');
  await expect(rows()).toHaveText(['query_table', '3 more']);
  await expect(values()).toHaveText(['340', '1']);
  await screenshot(page, 'usage-hover');
});

// The axis of the shared engine puts a tick where its labels do not overlap. A bar is a day from 90 d, so its labels are the dates.
// The option xDateOnly of the engine gives one line, with no date under the labels. The windows of 12 hours and 3 hours have ticks of days. Each tick shows the date, and the year under the first tick.
// The windows of 15 minutes, 5 minutes and a minute keep their hours. The date is under the first label and under midnight.
test('a chart by the UTC day is labelled by its dates, never by hours; the charts of the finer steps are labelled by their days or their hours', async ({ page }) => {
  await open(page, '?window=90d');
  const root = chartBox(page).locator('.chartCore');
  // This is the [label, date line] pair of each label that is drawn (data-x-ticks).
  const axis = async (id = 'requests') => (await chartJson(chartBox(page, id).locator('.chartCore'), 'data-x-ticks')).map(([label, context]) => [label, context]);
  const DATE = /^[A-Z][a-z]{2} \d{1,2}$/;
  const HOUR = /^\d\d:\d\d$/;
  // 90 days: the labels are dates. A week or a month separates them where the days do not fit. There is no hour, at every width and in every chart.
  for (const width of [1920, 1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of CHARTS) {
      await expect.poll(async () => (await axis(id)).length, { message: `${width} px ${id}` }).toBeGreaterThanOrEqual(3);
      expect((await axis(id)).filter(([label, context]) => !DATE.test(label) || context), `${width} px ${id}`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(root).toHaveAttribute('data-type', 'bar');
  // 12 hours and 3 hours: a tick for each day or each week, labelled by its date. The year is under the first tick.
  for (const name of ['30 d', '7 d']) {
    await windowButton(page, name).click();
    await expect(pressedWindow(page)).toHaveText(name);
    await settled(page);
    await expect.poll(async () => (await axis()).length, { message: name }).toBeGreaterThanOrEqual(4);
    const ticks = await axis();
    expect(ticks.filter(([label]) => !DATE.test(label)), name).toEqual([]);
    expect(ticks.map(([, context]) => context).filter(Boolean), name).toEqual(['2026']);
  }
  // 15 minutes: the labels are hours. The date is under the first label and under midnight.
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await settled(page);
  await expect.poll(async () => (await axis()).length, { message: '24 h' }).toBeGreaterThanOrEqual(4);
  let ticks = await axis();
  expect(ticks.filter(([label]) => !HOUR.test(label)), '24 h').toEqual([]);
  expect(ticks.map(([, context]) => context).filter(Boolean).map((context) => context.replace(/ \d{4}$/, '')), '24 h: the dates under the hours').toEqual(['Oct 13', 'Oct 14']);
  // 5 minutes and a minute: the labels are hours (and minutes) of the day. The date is under the first label.
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

// ---- a chart that has nothing to draw ----------------------------------------------------------------------------------------------------
// This describes what each card says when its figure is 0 over the window. The sentence is the `none` of its spec in app_mcp_charts.js.
const NOTHING_CHARTS = {
  errors: 'No errors in this window',
  rate: 'No errors in this window',
  refused: 'No refused request in this window',
  time: 'No tool calls in this window',
  bytes: 'Nothing was returned in this window',
};

test('an empty window keeps the six cards at the height they have with data: the Requests card says why, with "Clear filters" when filters are on, and the lists that have nothing say none', async ({ page }) => {
  // The height of the six cards with data is the reference for every state below.
  await open(page);
  const withData = await cardHeights(page);
  expect(withData).toHaveLength(6);
  expect(withData[0]).toBeGreaterThan(250);
  expectNear(withData, Array(6).fill(withData[0]), 'with data, the six cards');

  const server = newServer();
  server.cells = [];
  await open(page, '', server);
  // Nothing was counted. The tiles say 0, and the six cards are still there, as tall as the cards with data. The Requests card has the sentence. The five others say what they count.
  // The lists of the bar say none.
  expect(await tiles(page)).toMatchObject({ Requests: ['0', 'in the last 7 days'], 'Tool calls': ['0', ''], 'Call time': ['—', ''], Returned: ['0 B', ''], 'Active keys': ['0', 'of 5 keys'] });
  await expect(page.locator('.mcpOverview__charts')).toBeVisible();
  await expect(page.locator('.mcpOverview__card')).toHaveCount(6);
  expectNear(await cardHeights(page), withData, 'an empty window, the six cards');
  const requests = card(page, 'requests');
  await expect(requests.locator('.uiState--empty .uiState__title')).toHaveText('No request in the last 7 days');
  await expect(requests.locator('.uiState--empty .uiState__body')).toHaveText('Nothing was counted in this window.');
  await expect(requests.locator('.uiState button')).toHaveCount(0);
  for (const [id, title] of Object.entries(NOTHING_CHARTS)) await expect(emptyTitleCharts(page, id), id).toHaveText(title);
  await expect(page.locator('.mcpOverview__card .uiState--empty')).toHaveCount(6);
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(0);
  // The cards keep their title and their step. They say what is not there. Nothing is a table, and there is no legend to change the mode of.
  expect(await titles(page)).toEqual(['Requests by method', 'Errors by method', 'Error rate by method', 'Refused by method', 'Call time by method', 'Returned by method']);
  for (const id of CHARTS) await expect(card(page, id).locator('.chartCard__meta')).toHaveText('by 3 hours');
  await expect(page.locator('.mcpOverview__empty')).toHaveCount(0);
  await expect(page.locator('.mcpOverview table')).toHaveCount(0);
  await expect(page.locator('.chartCore__legendMode')).toHaveCount(0);
  // The lists of the bar that have nothing to offer are disabled, and they say none. The title says why. The instances are every instance that the server knows.
  // The list has the two of them, with no request. So it is still a list to open.
  for (const [dimension, label, one] of [['key', 'Key', 'key'], ['method', 'Method', 'method'], ['client', 'Client', 'client'], ['result', 'Result', 'result']]) {
    await expect(pickerButton(page, dimension)).toHaveText(`${label} · none`);
    await expect(pickerButton(page, dimension)).toBeDisabled();
    await expect(pickerButton(page, dimension)).toHaveAttribute('title', `No ${one} in this view`);
  }
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (2)');
  await expect(pickerButton(page, 'instance')).toBeEnabled();
  const instances = await openPicker(page, 'instance');
  await expect(instances.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(instances.locator('.mcpPicker__count')).toHaveText(['0', '0']);
  await page.keyboard.press('Escape');

  // With a filter, the same sentence says that no request has all of them. "Clear filters" is in the card, and the card is as tall as ever.
  await page.goto('/mcp-integration/usage?method=run_query&window=24h');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(requests.locator('.uiState--empty .uiState__title')).toHaveText('No request has all these filters');
  await expect(requests.locator('.uiState--empty .uiState__body')).toHaveText('Nothing in the last 24 hours matches them.');
  await expect(requests.getByRole('button', { name: 'Clear filters' })).toBeVisible();
  expectNear(await cardHeights(page), withData, 'an empty window with a filter, the six cards');
  // The list of the dimension that has a filter stays a list, so that the filter can be removed. The other lists say none.
  await expect(pickerButton(page, 'method')).toHaveText('Method · run_query');
  await expect(pickerButton(page, 'method')).toBeEnabled();
  await expect(pickerButton(page, 'key')).toHaveText('Key · none');
  server.cells = CELLS();
  await requests.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h$/);
  await expect(page.locator('.mcpOverview__chart .chartCore')).toHaveCount(6);
  await expect(page.locator('.mcpOverview__card .uiState--empty')).toHaveCount(0);
  await expect(pressedWindow(page)).toBeFocused();
  await settled(page);
  expectNear(await cardHeights(page), withData, 'with data again, the six cards');
  await screenshot(page, 'usage-empty');
});

test('a chart that has nothing to draw says so in its card: no errors, no refusal, no tool call, nothing returned; the others keep drawing', async ({ page }) => {
  // The protocol method ping has 100 requests of 40 bytes. It has no error, no refusal and no call. So four of the six charts have nothing to draw.
  await open(page, '?method=ping');
  expect(await tiles(page)).toMatchObject({ Requests: ['100', 'in the last 7 days'], Errors: ['0', '0% of read requests'], Refused: ['0', '0 by the rate limit'], 'Call time': ['—', ''] });
  for (const id of ['requests', 'bytes']) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(1);
  for (const id of ['errors', 'rate', 'refused', 'time']) {
    await expect(emptyTitleCharts(page, id), id).toHaveText(NOTHING_CHARTS[id]);
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(0);
    await expect(chartBox(page, id).locator('.chartCore__legend'), id).toHaveCount(0);
  }
  // The card keeps its title and its step. They say what is not there.
  await expect(card(page, 'errors').locator('.chartCard__title')).toHaveText('Errors by method');
  await expect(card(page, 'rate').locator('.chartCard__title')).toHaveText('Error rate by method');
  await expect(card(page, 'time').locator('.chartCard__meta')).toHaveText('by 3 hours');
  // Nothing was returned. A request is counted with no byte, no error, no refusal and no call. Only Requests draws.
  const silent = newServer();
  silent.cells = [cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'notifications/initialized', 'ok', 5)];
  await open(page, '', silent);
  await expect(chartBox(page, 'requests').locator('.chartCore')).toHaveCount(1);
  for (const [id, title] of Object.entries(NOTHING_CHARTS)) {
    await expect(emptyTitleCharts(page, id), id).toHaveText(title);
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(0);
  }
  expect(await legendIds(page)).toEqual(['method:notifications/initialized']);
});

test('a figure that is 0 in every step leaves its chart empty and the others drawn: calls that returned no byte have no Returned chart, and no errors, no refusals', async ({ page }) => {
  // Two groups of calls all succeeded and returned no byte. Requests and Call time have values. The four others have only zeros.
  const server = newServer();
  server.cells = [
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'list_hosts', 'ok', 5, 20, 8, 0, 0),
    cell('ops-all', '2026-10-14T08:10', 'call', 'claude-code', 'list_hosts', 'ok', 3, 12, 6, 0, 0),
    cell('ops-all', '2026-10-13T08:10', 'call', 'claude-code', 'list_databases', 'ok', 4, 8, 3, 0, 0),
  ];
  await open(page, '', server);
  for (const id of ['requests', 'time']) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(1);
  for (const id of ['errors', 'rate', 'refused', 'bytes']) {
    await expect(emptyTitleCharts(page, id), id).toHaveText(NOTHING_CHARTS[id]);
    await expect(chartBox(page, id).locator('.chartCore'), id).toHaveCount(0);
  }
  expect(await legendIds(page)).toEqual(['method:list_hosts', 'method:list_databases']);
  expect(await legendIds(page, 'time')).toEqual(['method:list_hosts', 'method:list_databases']);
  expect(await tiles(page)).toMatchObject({ Requests: ['12', 'in the last 7 days'], Errors: ['0', '0% of read requests'], Returned: ['0 B', ''], 'Call time': ['3 ms', 'max 8 ms'] });
  // The drawn charts have their Values table, with the zeros of the steps that had no request. A minimum of 0 says that the group had quiet steps.
  await showValuesCharts(page);
  expect(await tableRowsCharts(page)).toEqual([['list_hosts', '8', '0', '5', '0.143', '5'], ['list_databases', '4', '0', '4', '0.0714', '0']]);
  // The cards that say nothing have the height of the cards that draw, in the table mode too. Only the legend of a drawn chart changes size.
  const heights = await cardHeights(page);
  expectNear(heights, Array(6).fill(heights[0]), 'the Values mode, four cards that say nothing');
  await showListCharts(page);
  const listed = await cardHeights(page);
  expectNear(listed, Array(6).fill(listed[0]), 'the list mode, four cards that say nothing');
  expect(heights[0]).toBeGreaterThan(listed[0]);
});

test('Refused draws what was refused: by method only `unread` (it was refused before the message was read), by client, key and result the names that were', async ({ page }) => {
  const server = await open(page);
  // By method, every refusal is one method: `unread`. The legend says what it stands for. The tile counts the three refusals (two by the rate limit).
  expect(await legendIds(page, 'refused')).toEqual(['method:unread']);
  await expect(entry(page, 'method:unread', 'refused')).toHaveAttribute('title', /^Filter by method unread\nRefused before the message was read: the rate limit \(429\), a body that was too large \(413\)/);
  expect((await tiles(page)).Refused).toEqual(['3', '2 by the rate limit']);
  // The Values table of the chart has the three refusals. Two of them are in one step, and one is in another.
  await showValuesCharts(page);
  expect(await tableHeadCharts(page, 'refused')).toEqual(['Series', 'Total', 'Min', 'Max', 'Mean', 'Last']);
  expect(await tableRowsCharts(page, 'refused')).toEqual([['unread', '3', '0', '2', '0.0536', '0']]);
  // By client, key and result: the page shows who and what was refused, the most refused first. The rate limit counts for the key and the client of the request.
  const refused = {
    client: [['python-httpx', '2', '0', '2', '0.0357', '0'], ['unknown', '1', '0', '1', '0.0179', '0']],
    key: [['legacy', '2', '0', '2', '0.0357', '0'], ['old-bot', '1', '0', '1', '0.0179', '0']],
    result: [['429_rate_limited', '2', '0', '2', '0.0357', '0'], ['413_payload_too_large', '1', '0', '1', '0.0179', '0']],
  };
  for (const [group, rows] of Object.entries(refused)) {
    await pickGroup(page, group);
    await expect(card(page, 'refused').locator('.chartCard__title')).toHaveText(`Refused by ${group}`);
    await settled(page);
    expect(reads(server).at(-1)).toBe(`?window=7d&group=${group}${ORDERS}`);
    expect(await tableRowsCharts(page, 'refused'), group).toEqual(rows);
  }
  // A window that nobody was refused in is the last hour. The card says so. The mode button is not there, because it has no legend.
  await windowButton(page, '1 h').click();
  await settled(page);
  await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
  await expect(chartBox(page, 'refused').locator('.chartCore__legendMode')).toHaveCount(0);
});

// ---- the size of the cards --------------------------------------------------------------------------------------------------------------------
// The page opens with the legend in the mode `mode`. The mode is a preference of the browser (`chdash.chart.legendMode`: "list" or "table").
// The preference is read when the charts are drawn. So the page loads again after the preference is set.
async function openInModeCharts(page, query, server, mode) {
  await open(page, query, server);
  await page.evaluate((value) => localStorage.setItem('chdash.chart.legendMode', value), mode);
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await settled(page);
}
// The room of the legend as a list is `lines` entries of 20 px.
// There are 2 px between two entries, and 2 px of margin above and below. As a table, it is its head and six rows of 22 px.
const listRoomCharts = (lines) => lines * 20 + (lines - 1) * 2 + 4;
const TABLE_ROOM_CHARTS = 7 * 22;

test('the six cards have one height in every state and in each mode of the legend: with data, filtered, with charts that have nothing to draw, for an empty window; only the mode changes it', async ({ page }) => {
  const nothing = (server) => { server.cells = []; return server; };
  // Each state is [state, address, server, how many cards say that they have nothing to draw].
  const states = [
    ['with data', '', newServer(), 0],
    ['filtered: ci-bot has no refusal', '?key=ui_0a1b2c3d4e5f', newServer(), 1],
    ['four charts with nothing to draw (ping has no error, no refusal and no call)', '?method=ping', newServer(), 4],
    ['a filter that matches nothing', '?method=run_query', nothing(newServer()), 6],
    ['an empty window', '', nothing(newServer()), 6],
  ];
  for (const [width, lines] of [[1440, 3], [820, 3], [390, 4]]) {
    await page.setViewportSize({ width, height: 900 });
    const sizes = {};
    for (const mode of ['list', 'table']) {
      let reference = null;
      for (const [state, query, server, empty] of states) {
        await openInModeCharts(page, query, server, mode);
        await expect(page.locator('.mcpOverview__card .uiState--empty'), `${width} px, ${mode}, ${state}`).toHaveCount(empty);
        const heights = await cardHeights(page);
        // The card of the first state is the one that the others have. It is tall enough for a plot of 200 px and the legend of its mode.
        reference ??= heights[0];
        expect(reference, `${width} px, ${mode}`).toBeGreaterThan(280);
        expectNear(heights, Array(6).fill(reference), `${width} px, ${mode}, ${state}`);
      }
      sizes[mode] = reference;
      // The grid says which mode its legends are in. The card is sized for that mode: a list, or the table of the Values mode.
      await expect(page.locator('.mcpOverview__charts')).toHaveClass(mode === 'table' ? /is-values/ : /^(?!.*is-values)/);
    }
    // The cards of the two modes differ by what their legends need. The list has three lines (four on a phone). The table has six rows under its head.
    expect(sizes.table - sizes.list, `${width} px: the Values mode`).toBeCloseTo(TABLE_ROOM_CHARTS - listRoomCharts(lines), 0);
  }
});

test('a legend of more than three lines scrolls inside its card, which does not grow (four lines on a phone); the Values table has six rows under its head and scrolls too', async ({ page }) => {
  // Twelve tools have long names. The eight biggest are entries of a line each, and "4 more". That is far past the room of three lines.
  const long = newServer();
  long.cells = Array.from({ length: 12 }, (_, i) => cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', `a_very_long_tool_name_for_the_legend_of_the_chart_${String(i).padStart(2, '0')}`, 'ok', 50 - i, 100, 20, 1, 1000 + i));
  for (const [width, lines] of [[1440, 3], [390, 4]]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const reference = await cardHeights(page);
    await open(page, '', long);
    await settled(page);
    const room = listRoomCharts(lines);
    const boxes = await page.locator('.mcpOverview__card .chartCore__legendList').evaluateAll((els) => els.map((el) => ({
      card: el.closest('.mcpOverview__card').dataset.card, shown: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY, entries: el.children.length,
    })));
    // No call failed, was refused or returned no byte. The three charts that draw have the eight biggest tools, and "4 more".
    expect(boxes.map((box) => box.card), `${width} px`).toEqual(['requests', 'time', 'bytes']);
    for (const box of boxes) {
      expect(box.entries, `${width} px, ${box.card}`).toBe(9);
      expect(Math.abs(box.shown - room), `${width} px, ${box.card}: the room of ${lines} lines`).toBeLessThanOrEqual(1);
      expect(box.content, `${width} px, ${box.card}: more than the room`).toBeGreaterThan(box.shown + 40);
      expect(box.overflow, `${width} px, ${box.card}`).toBe('auto');
    }
    // The card has the height of the others, so the legend scrolls in it. The entries are buttons. When the keyboard reaches an entry below the room, the legend scrolls to it.
    // The card stays as it is.
    expectNear(await cardHeights(page), reference, `${width} px, long legends`);
    const last = entry(page, 'method:a_very_long_tool_name_for_the_legend_of_the_chart_07');
    await expect(last).toBeEnabled();
    const list = chartBox(page).locator('.chartCore__legendList');
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    await last.focus();
    await expect(last).toBeFocused();
    expect(await list.evaluate((el) => el.scrollTop), `${width} px: the legend scrolled to the entry`).toBeGreaterThan(0);
    expectNear(await cardHeights(page), reference, `${width} px, a legend scrolled`);
    // The entry is still a filter. Enter picks it, from the part of the legend that was hidden.
    await page.keyboard.press('Enter');
    await expect(chips(page)).toHaveText(['Method=a_very_long_tool_name_for_the_legend_of_the_chart_07']);
    await settled(page);
    expectNear(await cardHeights(page), reference, `${width} px, filtered`);

    // The Values table has the room of its head and six rows (four on a touch screen). The rows scroll under the head. The card has the height of the other cards of the mode.
    await open(page);
    await showValuesCharts(page);
    const tableReference = await cardHeights(page);
    await open(page, '', long);
    await settled(page);
    expectNear(await cardHeights(page), tableReference, `${width} px, the Values table of long legends`);
    const wraps = await page.locator('.mcpOverview__card .chartCore__legendTableWrap').evaluateAll((els) => els.map((el) => ({
      card: el.closest('.mcpOverview__card').dataset.card, shown: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY, rows: el.querySelectorAll('tbody tr').length,
    })));
    expect(wraps.map((wrap) => wrap.card), `${width} px`).toEqual(['requests', 'time', 'bytes']);
    for (const wrap of wraps) {
      expect(wrap.rows, `${width} px, ${wrap.card}`).toBe(9);
      expect(Math.abs(wrap.shown - TABLE_ROOM_CHARTS), `${width} px, ${wrap.card}: the room of the table`).toBeLessThanOrEqual(1);
      expect(wrap.content, `${width} px, ${wrap.card}: more than the room`).toBeGreaterThan(wrap.shown + 20);
      expect(wrap.overflow, `${width} px, ${wrap.card}`).toBe('auto');
    }
    // The head stays over the rows while they scroll. The keyboard brings an entry that is far down into view.
    const wrap = chartBox(page).locator('.chartCore__legendTableWrap');
    await wrap.evaluate((el) => { el.scrollTop = 60; });
    const head = await wrap.evaluate((el) => el.querySelector('thead th').getBoundingClientRect().top - el.getBoundingClientRect().top);
    expect(Math.abs(head), `${width} px: the head stays`).toBeLessThanOrEqual(2);
    await wrap.evaluate((el) => { el.scrollTop = 0; });
    await entry(page, 'method:a_very_long_tool_name_for_the_legend_of_the_chart_07').focus();
    const inside = await wrap.evaluate((el) => {
      const row = el.querySelectorAll('tbody tr')[7].getBoundingClientRect();
      const frame = el.getBoundingClientRect();
      return row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1;
    });
    expect(inside, `${width} px: the row of the entry is in view`).toBe(true);
    expectNear(await cardHeights(page), tableReference, `${width} px, a table scrolled`);
    await showListCharts(page);
  }
});

test('on a touch screen the rows of the legend are 32 px and its table has four rows: the six cards keep one height in both modes here too', async ({ browser }, testInfo) => {
  // A touch screen (the pointer is coarse) shows each entry as tall as a finger, with 8 px between two entries. The table shows four rows under its head.
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark', locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const nothing = (server) => { server.cells = []; return server; };
    const states = [['with data', '', newServer()], ['ping', '?method=ping', newServer()], ['an empty window', '', nothing(newServer())]];
    const sizes = {};
    for (const mode of ['list', 'table']) {
      let reference = null;
      for (const [state, query, server] of states) {
        await openInModeCharts(page, query, server, mode);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        const heights = await cardHeights(page);
        reference ??= heights[0];
        expectNear(heights, Array(6).fill(reference), `${mode}, ${state}`);
        if (state !== 'with data') continue;
        // The room of the legend is four lines of 32 px on a phone, with 8 px between two lines and 6 px of margin. The table has its head and four rows of 34 px.
        const room = await page.locator('.mcpOverview__chart[data-chart="requests"]').evaluate((el, which) => {
          const box = el.querySelector(which === 'list' ? '.chartCore__legendList' : '.chartCore__legendTableWrap');
          return { room: box.clientHeight, entry: el.querySelector('.chartCore__legendItem').getBoundingClientRect().height };
        }, mode);
        expect(room.entry).toBe(32);
        expect(Math.abs(room.room - (mode === 'list' ? 4 * 32 + 3 * 8 + 12 : 5 * 34)), mode).toBeLessThanOrEqual(1);
      }
      sizes[mode] = reference;
    }
    expect(sizes.table - sizes.list).toBeCloseTo(5 * 34 - (4 * 32 + 3 * 8 + 12), 0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});

// ---- the figures of the legend ----------------------------------------------------------------------------------------------------------------
test('the time of a call is an average that the table of the legend gives over the window, weighted by the calls of each step, and the rate of the errors by the requests: neither has a total', async ({ page }) => {
  const server = await open(page);
  await showValuesCharts(page);
  // A time and a rate do not add up. There is no Total column. The figures are those of the steps that had a call (or a request). A step with none is a gap.
  expect(await tableHeadCharts(page, 'time')).toEqual(['Series', 'Min', 'Max', 'Mean', 'Last']);
  expect(await tableHeadCharts(page, 'rate')).toEqual(['Series', 'Min', 'Max', 'Mean', 'Last']);
  for (const id of ['requests', 'errors', 'refused', 'bytes']) expect(await tableHeadCharts(page, id), id).toEqual(['Series', 'Total', 'Min', 'Max', 'Mean', 'Last']);
  // The time of the calls of query_table over their number in the window is 14.9 ms: 11,249 ms over 754 calls.
  // The mean of the averages of its four steps (15, 15, 11.75 and 14.94 ms) gives 14.2 ms. The table gives the weighted mean instead. It is the time of a call, as the tile counts it.
  const body = overviewOf(server, new URLSearchParams({ window: '7d' })).body;
  const query = body.series.groups.find((group) => group.id === 'query_table');
  const sums = [query.duration_ms_sum.reduce((a, b) => a + b, 0), query.calls.reduce((a, b) => a + b, 0)];
  expect(sums).toEqual([11249, 754]);
  const steps = query.calls.map((calls, i) => (calls > 0 ? query.duration_ms_sum[i] / calls : null)).filter((value) => value != null);
  expect(steps).toHaveLength(4);
  expect(steps.reduce((a, b) => a + b, 0) / steps.length).toBeCloseTo(14.17, 1);
  expect(await tableRowsCharts(page, 'time')).toEqual([
    ['query_table', '11.8 ms', '15 ms', '14.9 ms', '14.9 ms'],
    ['list_hosts', '4 ms', '4 ms', '4 ms', '4 ms'],
    ['run_query', '107 ms', '107 ms', '107 ms', '107 ms'],
    ['describe_table', '10 ms', '10 ms', '10 ms', '10 ms'],
  ]);
  // The rate of the errors of query_table over the window is 0.66%: its 5 errors over its 754 requests.
  // The mean of its four steps (0, 0, 25 and 0.5%) gives 6.4%. Its minimum is the rate of a step that had requests (0%).
  // The step of `other` had one step, so it has the 100% of that step. A step with no request is a gap and not a zero. Otherwise its minimum is 0%.
  expect(await tableRowsCharts(page, 'rate')).toEqual([
    ['query_table', '0%', '25%', '0.66%', '0.5%'],
    ['run_query', '14.3%', '14.3%', '14.3%', '14.3%'],
    ['other', '100%', '100%', '100%', '100%'],
  ]);
  // The engine says how many points and runs each line has. A step with no call is a gap. Its runs are what the line draws without a break.
  const stats = JSON.parse(await chartBox(page, 'time').locator('.chartCore').getAttribute('data-series-stats'));
  expect(stats.query_table).toEqual({ points: 4, runs: 4 });
  expect(stats.list_hosts).toEqual({ points: 3, runs: 2 });
  expect(Object.keys(stats)).toEqual(['query_table', 'list_hosts', 'run_query', 'describe_table']);
  // The counts have all their figures. The total is the sum of the steps. The mean is over the 56 steps, to three significant digits.
  expect((await tableRowsCharts(page, 'requests'))[0]).toEqual(['query_table', '754', '0', '402', '13.5', '402']);
  // The axes use milliseconds, then seconds for a long call. The bytes use the unit of 1024. The rate is in percent. The counts are shown as they are.
  const ticks = async (id) => chartJson(chartBox(page, id).locator('.chartCore'), 'data-y-ticks');
  expect(await ticks('time')).toEqual(['0', '50 ms', '100 ms', '150 ms', '200 ms']);
  expect(await ticks('bytes')).toEqual(['0', '200 KB', '400 KB', '600 KB', '800 KB']);
  expect(await ticks('requests')).toEqual(['0', '200', '400', '600', '800']);
  expect(await ticks('rate')).toEqual(['0', '25%', '50%', '75%', '100%']);
  // A long call moves the axis to seconds. A large answer moves it to megabytes.
  const slow = newServer();
  slow.cells = [cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'run_query', 'ok', 2, 9000, 5000, 0, 3 * 1024 * 1024)];
  await open(page, '', slow);
  expect((await ticks('time')).filter((label) => label !== '0').every((label) => /^\d+(\.\d+)? s$/.test(label))).toBe(true);
  expect((await ticks('bytes')).filter((label) => label !== '0').every((label) => /^\d+(\.\d+)? MB$/.test(label))).toBe(true);
});

test('the cursor and the zoom go from one chart to the others: the six share their axis, and the Values table follows the zoom', async ({ page }) => {
  const server = await open(page);
  await showValuesCharts(page);
  const at = await page.evaluate((t) => window.ChDash.chartCore.of(document.querySelector('.mcpOverview__chart[data-chart="requests"]')).toClient(t, 10), Date.UTC(2026, 9, 14, 10, 30));
  await page.mouse.move(at.x, at.y);
  // The other charts show the same instant, with a crosshair. Only the chart that is hovered has the tooltip.
  for (const id of CHARTS.slice(1)) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-sync-x', /\d/);
  await expect(chartBox(page, 'requests').locator('.chartCore__tooltip')).toBeVisible();
  for (const id of CHARTS.slice(1)) await expect(chartBox(page, id).locator('.chartCore__tooltip'), id).toBeHidden();
  // A drag over one chart zooms all six. They show the same range. The table of each legend reads the steps that are in view.
  const plot = await chartBox(page, 'requests').locator('.chartCore').getAttribute('data-plot');
  const [left, top, width, height] = plot.split(' ').map(Number);
  const box = await chartBox(page, 'requests').locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + left + width * 0.7, box.y + top + height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + left + width * 0.95, box.y + top + height / 2, { steps: 4 });
  await page.mouse.up();
  for (const id of CHARTS) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-zoomed', 'true');
  const zoomed = await Promise.all(CHARTS.map((id) => xRange(page, id)));
  expect(new Set(zoomed.map((pair) => pair.join())).size).toBe(1);
  const [from, to] = zoomed[0];
  const full = geometry('7d');
  expect(from).toBeGreaterThan(full.from);
  expect(to).toBeLessThan(full.from + full.points * full.stepMs);
  // The Total of query_table is the sum of the steps that are in view. A step is at the middle of its bar. The total is not the sum of the window.
  const body = overviewOf(server, new URLSearchParams({ window: '7d' })).body;
  const query = body.series.groups.find((group) => group.id === 'query_table');
  const inView = query.requests.reduce((sum, requests, i) => {
    const middle = full.from + i * full.stepMs + full.stepMs / 2;
    return sum + (middle >= from && middle <= to ? requests : 0);
  }, 0);
  expect(inView).toBeGreaterThan(0);
  expect(inView).toBeLessThan(754);
  await expect.poll(async () => (await tableRowsCharts(page))[0][1]).toBe(String(inView));
  // A double click resets the six charts. The table is the whole window again.
  await page.mouse.dblclick(box.x + left + width / 2, box.y + top + height / 2);
  for (const id of CHARTS) await expect(chartBox(page, id).locator('.chartCore'), id).toHaveAttribute('data-zoomed', 'false');
  await expect.poll(async () => (await tableRowsCharts(page))[0][1]).toBe('754');
});

// ---- the legend: the list and the Values table ----------------------------------------------------------------------------------------------
// The mouse over the plot of a chart selects the step that holds `ms`. The step is at the middle of the plot, whatever the scale of the chart.
const hoverStepCharts = async (page, ms, id = 'requests') => {
  const at = await page.evaluate(([t, chart]) => window.ChDash.chartCore.of(document.querySelector(`.mcpOverview__chart[data-chart="${chart}"]`)).toClient(t, 0), [ms, id]);
  const [, top, , height] = String(await chartBox(page, id).locator('.chartCore').getAttribute('data-plot')).split(' ').map(Number);
  const box = await chartBox(page, id).locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(at.x, box.y + top + height / 2);
};
const totalOfCharts = async (page, id) => (await tableRowsCharts(page, id)).reduce((sum, row) => sum + Number(row[1].replace(/,/g, '')), 0);

test('the legend is a list, and Values turns it into a table of the figures of each group over the window; the six charts share the mode, and the browser keeps it', async ({ page }) => {
  const server = await open(page);
  // The list is the default. There is no table. The button of each legend offers the figures of its table, because a time and a rate have no total.
  await expect(page.locator('.chartCore__legendTable')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).not.toBe('table');
  await expect(page.locator('.mcpOverview__charts')).not.toHaveClass(/is-values/);
  for (const id of CHARTS) {
    await expect(chartBox(page, id).locator('.chartCore__legend'), id).toHaveAttribute('data-mode', 'list');
    await expect(modeButton(page, id), id).toHaveText('Values');
    await expect(modeButton(page, id), id).toHaveAttribute('aria-pressed', 'false');
    await expect(modeButton(page, id), id).toHaveAttribute('title', ['rate', 'time'].includes(id) ? 'Show min / max / mean / last per series' : 'Show total / min / max / mean / last per series');
  }
  // The button of one chart turns the six legends into tables. It keeps the keyboard, because its legend is drawn again. A click is not a filter.
  const before = server.calls.length;
  await modeButton(page, 'bytes').click();
  expect(server.calls).toHaveLength(before);
  await expect(chips(page)).toHaveCount(0);
  await expect(modeButton(page, 'bytes')).toBeFocused();
  await expect(page.locator('.mcpOverview__charts')).toHaveClass(/is-values/);
  for (const id of CHARTS) {
    await expect(legendTable(page, id), id).toBeVisible();
    await expect(chartBox(page, id).locator('.chartCore__legend'), id).toHaveAttribute('data-mode', 'table');
    await expect(legendTable(page, id), id).toHaveAttribute('aria-label', 'Values of the series');
    await expect(modeButton(page, id), id).toHaveText('List');
    await expect(modeButton(page, id), id).toHaveAttribute('aria-pressed', 'true');
    await expect(modeButton(page, id), id).toHaveAttribute('title', 'Show the legend as a list');
    expect(await tableHeadCharts(page, id), id).toEqual(['rate', 'time'].includes(id) ? ['Series', 'Min', 'Max', 'Mean', 'Last'] : ['Series', 'Total', 'Min', 'Max', 'Mean', 'Last']);
    // Every column has a scope. Every row has a header: its first cell, the entry of the group.
    expect(await legendTable(page, id).evaluate((el) => [
      el.querySelectorAll('thead th[scope="col"]').length === el.querySelectorAll('thead th').length,
      [...el.querySelectorAll('tbody tr')].every((tr) => tr.firstElementChild.matches('th[scope="row"]')),
    ]), id).toEqual([true, true]);
  }
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('table');
  // The figures are those of the tiles. The groups of Requests, "2 more" included, add up to the 1,101 requests. The errors add up to 11, and the refusals to 3.
  expect(await totalOfCharts(page, 'requests')).toBe(1101);
  expect(await totalOfCharts(page, 'errors')).toBe(11);
  expect(await totalOfCharts(page, 'refused')).toBe(3);
  // The figures of a count are its total, its minimum and its maximum over the steps (zeros included). Its mean is over the 56 steps, to three significant digits.
  expect(await tableRowsCharts(page, 'requests')).toEqual([
    ['query_table', '754', '0', '402', '13.5', '402'],
    ['ping', '100', '0', '100', '1.79', '100'],
    ['list_hosts', '75', '0', '40', '1.34', '40'],
    ['tools/list', '65', '0', '60', '1.16', '60'],
    ['run_query', '35', '0', '35', '0.625', '0'],
    ['describe_table', '25', '0', '25', '0.446', '0'],
    ['initialize', '23', '0', '20', '0.411', '20'],
    ['notifications/initialized', '20', '0', '20', '0.357', '0'],
    ['2 more', '4', '0', '3', '0.0714', '0'],
  ]);
  // The bytes use the unit of 1024. Each cell has its own unit.
  expect((await tableRowsCharts(page, 'bytes'))[0]).toEqual(['query_table', '732.9 KB', '0 B', '391.2 KB', '13.1 KB', '391.2 KB']);
  // A pick, a read or a window keeps the mode. The tables are drawn again for each answer.
  await entry(page, 'method:ping', 'requests').click();
  await expect(chips(page)).toHaveText(['Method=ping']);
  await settled(page);
  await expect(legendTable(page, 'requests')).toBeVisible();
  expect(await tableRowsCharts(page, 'requests')).toEqual([['ping', '100', '0', '100', '1.79', '100']]);
  await expect(legendTable(page, 'errors')).toHaveCount(0);
  await expect(emptyTitleCharts(page, 'errors')).toHaveText('No errors in this window');
  await page.getByRole('button', { name: 'Remove filter Method = ping' }).click();
  await settled(page);
  await windowButton(page, '24 h').click();
  await settled(page);
  for (const id of CHARTS) await expect(legendTable(page, id), id).toBeVisible();
  // A reload keeps the mode (the preference of the browser). By key, the counts have their thousands separated.
  await page.goto('/mcp-integration/usage?group=key');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  for (const id of CHARTS) await expect(legendTable(page, id), id).toBeVisible();
  expect(await tableRowsCharts(page, 'requests')).toEqual([
    ['ops-all', '1,012', '0', '622', '18.1', '622'],
    ['old-bot', '41', '0', '41', '0.732', '0'],
    ['legacy', '28', '0', '28', '0.5', '0'],
    ['ci-bot', '20', '0', '20', '0.357', '0'],
  ]);
  expect(await tableRowsCharts(page, 'rate')).toEqual([
    ['ops-all', '0%', '14.3%', '0.69%', '0.32%'],
    ['ci-bot', '15%', '15%', '15%', '15%'],
    ['legacy', '3.57%', '3.57%', '3.57%', '3.57%'],
  ]);
  // The button gives the lists back to the six charts, and the preference follows. It works from the keyboard too. Each chart has its own button.
  await modeButton(page, 'errors').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.chartCore__legendTable')).toHaveCount(0);
  await expect(modeButton(page, 'errors')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('chdash.chart.legendMode'))).toBe('list');
  await expect(page.locator('.mcpOverview__charts')).not.toHaveClass(/is-values/);
  for (const id of CHARTS) await expect(modeButton(page, id), id).toHaveText('Values');
  await page.keyboard.press('Space');
  for (const id of CHARTS) await expect(legendTable(page, id), id).toBeVisible();
  await page.keyboard.press('Space');
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.chartCore__legendTable')).toHaveCount(0);
  await expect(page.locator('.chartCore__legendList')).toHaveCount(6);
});

// ---- the six charts are aligned ---------------------------------------------------------------------------------------------------------
test('the six charts are aligned: one plot box, five ticks of four equal intervals and one gutter, so their grid lines meet, in both modes and at every width', async ({ page }) => {
  // This is what each chart drew: its plot box (left, top, width and height in px of the chart).
// It also gives the ticks of its y axis, its step, and where the chart is on the page.
  const measure = () => page.locator('.mcpOverview__chart .chartCore').evaluateAll((els) => els.map((el) => {
    const box = el.getBoundingClientRect();
    return {
      id: el.closest('.mcpOverview__chart').dataset.chart, plot: el.dataset.plot.split(' ').map(Number), align: el.dataset.align, ticks: JSON.parse(el.dataset.yTicks),
      min: Number(el.dataset.yMin), max: Number(el.dataset.yMax), step: Number(el.dataset.yStep), x: box.left, y: box.top, xTicks: el.dataset.xTicks,
    };
  }));
  for (const [width, columns] of [[1440, 3], [820, 2], [390, 1]]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ['list', 'table']) {
      await openInModeCharts(page, '', newServer(), mode);
      const charts = await measure();
      const label = `${width} px, ${mode}`;
      expect(charts.map((chart) => chart.id), label).toEqual(CHARTS);
      // The six charts form one alignment group. They share one plot box: the same gutter at the left, the same top, and the same width and height.
      expect(new Set(charts.map((chart) => chart.align)), label).toEqual(new Set(['mcp-usage']));
      expect(new Set(charts.map((chart) => chart.plot.join(' '))).size, `${label}: the plot boxes ${charts.map((chart) => chart.plot.join(' ')).join(' / ')}`).toBe(1);
      expect(new Set(charts.map((chart) => chart.xTicks)).size, `${label}: the same x axis`).toBe(1);
      // The y axis has five ticks, with four equal intervals from 0. The grid lines of every chart are at the same heights of its plot. Only the numbers on them differ.
      for (const chart of charts) {
        expect(chart.ticks, `${label}, ${chart.id}`).toHaveLength(5);
        expect(chart.ticks[0], `${label}, ${chart.id}`).toBe('0');
        expect(chart.min, `${label}, ${chart.id}`).toBe(0);
        expect(chart.max, `${label}, ${chart.id}`).toBeCloseTo(4 * chart.step, 6);
      }
      expect(new Set(charts.map((chart) => chart.step)).size, `${label}: the scales differ`).toBeGreaterThan(3);
      // On the page, the charts of a row are at the same height. The charts of a column are at the same x. So the lines of the grid run across the row and down the column.
      // The cards are the same size.
      charts.forEach((chart, i) => {
        expect(Math.abs(chart.y - charts[i - (i % columns)].y), `${label}: ${chart.id} is in the row of the first of its row`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(chart.x - charts[i % columns].x), `${label}: ${chart.id} is in the column of the first of its column`).toBeLessThanOrEqual(0.5);
      });
      expect(new Set(charts.map((chart) => Math.round(chart.plot[2]))).size).toBe(1);
      expectNear(await cardHeights(page), Array(6).fill((await cardHeights(page))[0]), label);
    }
  }
  // The window is resized under the charts that are drawn. The charts are laid out again, and they keep one plot box.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openInModeCharts(page, '', newServer(), 'list');
  for (const width of [820, 1280, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => new Set((await measure()).map((chart) => chart.plot.join(' '))).size, { message: `resized to ${width} px` }).toBe(1);
    const sizes = await measure();
    expect(sizes[0].plot[2], `resized to ${width} px`).toBeGreaterThan(200);
    expect(new Set(sizes.map((chart) => chart.xTicks)).size, `resized to ${width} px: the same x axis`).toBe(1);
  }
  // The gutter is the widest of the labels of the six charts. With only the counts to draw (labels of one or two digits), the plot starts nearer to the edge.
  await open(page);
  const wide = (await page.locator('.mcpOverview__chart[data-chart="requests"] .chartCore').getAttribute('data-plot')).split(' ').map(Number);
  const silent = newServer();
  silent.cells = [cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'notifications/initialized', 'ok', 5)];
  await open(page, '', silent);
  const alone = (await page.locator('.mcpOverview__chart[data-chart="requests"] .chartCore').getAttribute('data-plot')).split(' ').map(Number);
  expect(alone[0]).toBeLessThan(wide[0]);
  expect(alone[2]).toBeGreaterThan(wide[2]);
  // A chart with nothing to draw leaves the others aligned among themselves. Ping is in Requests and Returned only.
  await open(page, '?method=ping');
  const two = await measure();
  expect(two.map((chart) => chart.id)).toEqual(['requests', 'bytes']);
  expect(two[0].plot).toEqual(two[1].plot);
  expect(two[0].ticks).toEqual(['0', '25', '50', '75', '100']);
  expect(two[1].ticks).toEqual(['0', '1 KB', '2 KB', '3 KB', '4 KB']);
});

// ---- the axis of the rate ---------------------------------------------------------------------------------------------------------------
// This is a server whose only step has `errors` errors in `requests` requests of one tool.
const failingStepCharts = (requests, errors) => {
  const server = newServer();
  server.cells = [
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'run_query', 'ok', requests - errors, 100, 20, 1, 1000),
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'run_query', 'sql_error', errors, 10, 5, 0, 100),
  ];
  return server;
};

test('the axis of Error rate is in percent and never passes 100%: steps of 1, 2, 2.5 or 5, and 0 to 100% in four of 25 when the data goes there', async ({ page }) => {
  const ticks = async () => chartJson(chartBox(page, 'rate').locator('.chartCore'), 'data-y-ticks');
  // This shows [errors, requests, the ticks]. The axis fits the highest rate, on a step of the 1-2-2.5-5 sequence, with as many decimals as the step needs.
  const cases = [
    [1, 1000, ['0', '0.025%', '0.050%', '0.075%', '0.100%']],
    [1, 400, ['0', '0.1%', '0.2%', '0.3%', '0.4%']],
    [3, 100, ['0', '1%', '2%', '3%', '4%']],
    [12, 100, ['0', '5%', '10%', '15%', '20%']],
    [60, 100, ['0', '20%', '40%', '60%', '80%']],
    [99, 100, ['0', '25%', '50%', '75%', '100%']],
    [100, 100, ['0', '25%', '50%', '75%', '100%']],
  ];
  for (const [errors, requests, expected] of cases) {
    await open(page, '', failingStepCharts(requests, errors));
    expect(await ticks(), `${errors} in ${requests}`).toEqual(expected);
    const last = Number(expected.at(-1).replace('%', ''));
    expect(last, `${errors} in ${requests}: it never passes 100%`).toBeLessThanOrEqual(100);
    expect(last).toBeGreaterThanOrEqual(errors / requests * 100);
  }
  // The data of the page has a step in which every request failed (`other`). So the axis goes to 100%. By client, by key and by result, each chart has its own top.
  await open(page);
  expect(await ticks()).toEqual(['0', '25%', '50%', '75%', '100%']);
  for (const [group, expected] of [['client', ['0', '10%', '20%', '30%', '40%']], ['key', ['0', '5%', '10%', '15%', '20%']], ['result', ['0', '25%', '50%', '75%', '100%']]]) {
    await pickGroup(page, group);
    await settled(page);
    expect(await ticks(), group).toEqual(expected);
  }
  // The rate is read in percent everywhere.
// It is in the tooltip (3 significant digits), in the table of the legend, and in the cursor badge of the axis.
  await pickGroup(page, 'method');
  await settled(page);
  await hoverStepCharts(page, Date.UTC(2026, 9, 14, 10, 30), 'rate');
  await expect(chartBox(page, 'rate').locator('.chartCore__tooltip .chartCore__tipRow b')).toHaveText(['0.5%']);
  await showValuesCharts(page);
  expect((await tableRowsCharts(page, 'rate')).flat().filter((cell) => /%$/.test(cell)).length).toBe(12);
  await expect(emptyTitleCharts(page, 'errors')).toHaveCount(0);
  // With no error at all, the chart is the empty card of Errors: "No errors in this window".
  await open(page, '?method=ping');
  await expect(emptyTitleCharts(page, 'rate')).toHaveText('No errors in this window');
  await expect(chartBox(page, 'rate').locator('.chartCore')).toHaveCount(0);
});

// ---- the groups ---------------------------------------------------------------------------------------------------------------------------
test('grouped by key the legends name the keys, not their ids, and the filter sends the id: a deleted key is a group like another, and a key name of 32 characters fits', async ({ page }) => {
  const server = newServer();
  const longName = 'k'.repeat(32);
  server.keys.push({ ...server.keys[1], id: 'ui_cccccccccccc', name: longName });
  server.cells.push(cell('ui_cccccccccccc', '2026-10-14T09:30', 'call', 'claude-code', 'list_tables', 'sql_error', 4, 40, 15, 0, 800));
  await open(page, '?group=key', server);
  expect(await legendNamesCharts(page)).toEqual(['ops-all', 'old-bot', 'legacy', 'ci-bot', longName]);
  expect(await legendIds(page)).toEqual(['key:ops-all', 'key:ui_dead00000001', 'key:ui_legacy000000', 'key:ui_0a1b2c3d4e5f', 'key:ui_cccccccccccc']);
  // The title and the swatch of an entry say the name. The deleted key is `old-bot`. It has no other mark in a legend. The lists of the bar say deleted.
  await expect(entry(page, 'key:ui_dead00000001')).toHaveAttribute('title', 'Filter by key old-bot');
  await expect(entry(page, 'key:ui_cccccccccccc')).toHaveAttribute('title', `Filter by key ${longName}`);
  expect(await page.locator('.mcpOverview__chart .chartCore__legendItem').evaluateAll((items) => items.map((item) => item.textContent.includes('ui_')))).not.toContain(true);
  // The filter is the id of the key, in the address and in the read. Its chip reads the name.
  await entry(page, 'key:ui_dead00000001').click();
  await expect(chips(page)).toHaveText(['Key=old-bot']);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = old-bot']);
  expect(new URL(page.url()).searchParams.getAll('key')).toEqual(['ui_dead00000001']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=key&order=requests&key=ui_dead00000001');
  expect(await legendIds(page)).toEqual(['key:ui_dead00000001']);
  await expect(entry(page, 'key:ui_dead00000001')).toHaveText('old-bot');
  // The deleted key is not one of the keys that exist. The tile says so.
  expect((await tiles(page))['Active keys']).toEqual(['0', 'of 6 keys · 1 deleted']);
});

test('twenty values picked in the Group by dimension are twenty groups in every chart that has something for them: the legends scroll inside their cards, the table too, and the read has no ranking', async ({ page }) => {
  // Names are long enough for twenty entries to need many lines, whatever the width of the card.
  const names = Array.from({ length: 20 }, (_, i) => `tool_with_a_long_name_${String(i).padStart(2, '0')}`);
  const server = newServer();
  server.cells = names.flatMap((name, i) => [
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', name, 'ok', 30 - i, 100, 20, 1, 1000 + i),
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', name, 'sql_error', 2, 10, 5, 0, 100),
  ]);
  await open(page);
  const reference = await cardHeights(page);
  const asked = names.map((name) => `method=${name}`).join('&');
  await open(page, `?${asked}`, server);
  // One read has no ranking. The groups are the twenty values, in the order that they were picked. The same groups appear in every chart that has a figure.
  expect(reads(server)).toEqual([`?window=7d&group=method&order=requests&${asked}`]);
  for (const id of ['requests', 'errors', 'rate', 'time', 'bytes']) {
    expect(await legendIds(page, id), id).toEqual(names.map((name) => `method:${name}`));
    // All the values are picked. Each entry is pressed, and none is dimmed.
    expect(await legend(page, id).evaluateAll((items) => items.every((item) => item.getAttribute('aria-pressed') === 'true' && !item.classList.contains('is-off'))), id).toBe(true);
  }
  await expect(emptyTitleCharts(page, 'refused')).toHaveText('No refused request in this window');
  await expect(chips(page)).toHaveCount(20);
  // Twenty entries are far past three lines. The legend scrolls inside the card, which has the height of any other card.
  await settled(page);
  expectNear(await cardHeights(page), Array(6).fill((await cardHeights(page))[0]), 'twenty entries');
  const list = await chartBox(page).locator('.chartCore__legendList').evaluate((el) => ({ shown: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  expect(list.content).toBeGreaterThan(list.shown + 40);
  expect(list.overflow).toBe('auto');
  // The table has twenty rows under their head, in the room of six rows, and it scrolls.
  await showValuesCharts(page);
  const table = await chartBox(page).locator('.chartCore__legendTableWrap').evaluate((el) => ({ shown: el.clientHeight, content: el.scrollHeight, rows: el.querySelectorAll('tbody tr').length }));
  expect(table.rows).toBe(20);
  expect(table.content).toBeGreaterThan(table.shown * 2);
  expect(Math.abs(table.shown - TABLE_ROOM_CHARTS)).toBeLessThanOrEqual(1);
  const rows = await tableRowsCharts(page);
  expect(rows[0]).toEqual(['tool_with_a_long_name_00', '32', '0', '32', '0.571', '32']);
  expect(rows[19]).toEqual(['tool_with_a_long_name_19', '13', '0', '13', '0.232', '13']);
  expect(await totalOfCharts(page, 'requests')).toBe(names.reduce((sum, _, i) => sum + 32 - i, 0));
  // The keyboard reaches the last entry, and the card does not move.
  await entry(page, 'method:tool_with_a_long_name_19').focus();
  await expect(entry(page, 'method:tool_with_a_long_name_19')).toBeFocused();
  const visible = await chartBox(page).locator('.chartCore__legendTableWrap').evaluate((el) => {
    const row = el.querySelectorAll('tbody tr')[19].getBoundingClientRect();
    const frame = el.getBoundingClientRect();
    return row.top >= frame.top - 1 && row.bottom <= frame.bottom + 1;
  });
  expect(visible).toBe(true);
  await showListCharts(page);
  expectNear(await cardHeights(page), reference, 'back to the list');
});

test('long names end in an ellipsis in the legend, the table and the chip, and are whole in their title and in the tooltip; the page does not scroll sideways', async ({ page }) => {
  const server = newServer();
  const method = 'm'.repeat(64);
  const client = `${'C'.repeat(30)} ${'d'.repeat(33)}`;
  server.cells = [
    cell('ops-all', '2026-10-14T09:30', 'call', client, method, 'ok', 5, 20, 8, 0, 100),
    cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'short', 'ok', 3, 20, 8, 0, 100),
  ];
  await open(page, '', server);
  // The entry is cut by the card with an ellipsis. The name has 64 characters, and the entry has its width. The title has the whole name.
  const cut = await entry(page, `method:${method}`).evaluate((el) => {
    const name = el.querySelector('span');
    return { cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, inside: el.getBoundingClientRect().right <= el.closest('.chartCore__legend').getBoundingClientRect().right + 0.5 };
  });
  expect(cut).toEqual({ cut: true, ellipsis: 'ellipsis', inside: true });
  await expect(entry(page, `method:${method}`)).toHaveAttribute('title', `Filter by method ${method}`);
  await expect(entry(page, 'method:short')).toHaveAttribute('title', 'Filter by method short');
  expect(await entry(page, 'method:short').evaluate((el) => { const name = el.querySelector('span'); return name.scrollWidth <= name.clientWidth; })).toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // The tooltip names the group whole.
  await hoverStepCharts(page, Date.UTC(2026, 9, 14, 10, 30));
  await expect(chartBox(page).locator('.chartCore__tooltip .chartCore__tipRow:not(.chartCore__tipRow--total) em')).toHaveText([method, 'short']);
  const tip = await chartBox(page).locator('.chartCore__tooltip').boundingBox();
  expect(tip.x + tip.width).toBeLessThanOrEqual(1440);
  // The table keeps the figures in view beside a name that is cut.
  await showValuesCharts(page);
  const row = await legendTable(page).locator('tbody tr').first().evaluate((tr) => {
    const name = tr.cells[0].querySelector('span');
    const frame = tr.closest('.chartCore__legendTableWrap').getBoundingClientRect();
    return { cut: name.scrollWidth > name.clientWidth, figures: [...tr.cells].slice(1).map((cell) => cell.textContent), last: tr.cells[tr.cells.length - 1].getBoundingClientRect().right <= frame.right + 0.5 };
  });
  expect(row).toEqual({ cut: true, figures: ['5', '0', '5', '0.0893', '5'], last: true });
  await showListCharts(page);
  // The chip has the whole name in its title, and it is cut at 28 rem. The filter is whole in the address.
  await entry(page, `method:${method}`).click();
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('title', `Method = ${method}`);
  expect(await chips(page).first().evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(449);
  expect(new URL(page.url()).searchParams.getAll('method')).toEqual([method]);
  await settled(page);
  expect(await legendIds(page)).toEqual([`method:${method}`]);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // A client name has spaces inside and 64 characters. It is one value, whole in the address (the spaces are plus signs), and cut in the legend.
  await open(page, '?group=client', server);
  await expect(entry(page, `client:${client}`)).toHaveAttribute('title', `Filter by client ${client}`);
  expect(await entry(page, `client:${client}`).evaluate((el) => { const name = el.querySelector('span'); return name.scrollWidth > name.clientWidth; })).toBe(true);
  await entry(page, `client:${client}`).click();
  await expect(chips(page)).toHaveCount(1);
  expect(new URL(page.url()).searchParams.getAll('client')).toEqual([client]);
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=client&order=requests&client=${client.replace(/ /g, '+')}`);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('the charts take three columns from 1280 px, two from 761 px and one below, with no sideways scroll, and a legend of four lines under 601 px', async ({ page }) => {
  await open(page);
  for (const [width, height, columns, lines] of [[390, 844, 1, 4], [600, 800, 1, 4], [601, 800, 1, 3], [760, 800, 1, 3], [761, 800, 2, 3], [1100, 800, 2, 3], [1279, 800, 2, 3], [1280, 800, 3, 3], [1440, 900, 3, 3], [1920, 1000, 3, 3]]) {
    await page.setViewportSize({ width, height });
    await expect(chartBox(page).locator('.chartCore')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await horizontalOverflow(page), `${width}: the page`).toBeLessThanOrEqual(0);
    const m = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector('.mcpOverview__charts')).gridTemplateColumns.split(' ').length,
      cards: [...document.querySelectorAll('.mcpOverview__card')].map((el) => { const box = el.getBoundingClientRect(); return { width: box.width, right: box.right, left: box.left }; }),
      legend: document.querySelector('.mcpOverview__chart[data-chart="requests"] .chartCore__legendList').clientHeight,
      panel: document.querySelector('#mcpPanel').scrollWidth - document.querySelector('#mcpPanel').clientWidth,
    }));
    expect(m.columns, `${width}: the columns`).toBe(columns);
    expect(m.panel, `${width}: the panel`).toBeLessThanOrEqual(0);
    // The six cards have the width of a column and fit the window. In one column, they are as wide as the panel.
    expectNear(m.cards.map((card) => card.width), Array(6).fill(m.cards[0].width), `${width}: the cards`);
    expect(Math.max(...m.cards.map((card) => card.right)), `${width}: the cards fit the window`).toBeLessThanOrEqual(width);
    expect(Math.min(...m.cards.map((card) => card.left)), `${width}: the cards fit the window`).toBeGreaterThanOrEqual(0);
    expect(m.cards[0].width, `${width}: a card`).toBeGreaterThan(columns === 1 ? width - 64 : width / columns - 60);
    // A legend has three lines, or four on a phone (601 px and above: three).
    expect(Math.abs(m.legend - listRoomCharts(lines)), `${width}: the legend of ${lines} lines`).toBeLessThanOrEqual(1);
  }
  // The table of a legend that is wider than its card scrolls in it. The names stay in view. On a phone, the Returned table is wider than its card.
  await page.setViewportSize({ width: 390, height: 844 });
  await showValuesCharts(page);
  const wraps = await page.locator('.mcpOverview__chart .chartCore__legendTableWrap').evaluateAll((els) => els.map((el) => ({
    id: el.closest('.mcpOverview__chart').dataset.chart, over: el.scrollWidth - el.clientWidth, overflow: getComputedStyle(el).overflowX, name: getComputedStyle(el.querySelector('tbody th')).position,
  })));
  expect(wraps.map((wrap) => wrap.id)).toEqual(CHARTS);
  for (const wrap of wraps) {
    expect(wrap.overflow, wrap.id).toBe('auto');
    expect(wrap.name, wrap.id).toBe('sticky');
  }
  expect(wraps.find((wrap) => wrap.id === 'bytes').over).toBeGreaterThan(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, 'usage-phone-values');
});

// ---- accessibility of the legends ---------------------------------------------------------------------------------------------------------
const axeViolationsCharts = (page) => new AxeBuilder({ page }).analyze().then((result) => result.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));

for (const theme of ['dark', 'light']) {
  test(`axe (${theme}): the legends of the six charts have no violation, as a list and as a table, with an entry pressed, and where a chart has nothing to draw`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    await open(page);
    await page.waitForTimeout(1200);
    expect(await axeViolationsCharts(page), 'the lists').toEqual([]);
    // A pressed entry dims the others. A muted name still has its contrast. The entry that is no filter ("N more") is disabled.
    await entry(page, 'method:query_table', 'errors').click();
    await expect(chips(page)).toHaveCount(1);
    await settled(page);
    await page.waitForTimeout(600);
    expect(await axeViolationsCharts(page), 'a pressed entry, the lists').toEqual([]);
    await showValuesCharts(page);
    await page.waitForTimeout(400);
    expect(await axeViolationsCharts(page), 'a pressed entry, the tables').toEqual([]);
    await page.getByRole('button', { name: 'Remove filter Method = query_table' }).click();
    await settled(page);
    await page.waitForTimeout(600);
    expect(await axeViolationsCharts(page), 'the tables').toEqual([]);
    // This covers the tables with rows that a filter leaves out (dimmed figures while the page reads), and the cards that have nothing to draw.
    await open(page, '?method=ping');
    await page.waitForTimeout(600);
    expect(await axeViolationsCharts(page), 'four charts with nothing to draw, the tables').toEqual([]);
    await showListCharts(page);
    await page.waitForTimeout(400);
    expect(await axeViolationsCharts(page), 'four charts with nothing to draw, the lists').toEqual([]);
    // A legend of twenty entries scrolls. A region that scrolls must be reached by the keyboard. Its entries are buttons.
    const names = Array.from({ length: 20 }, (_, i) => `tool_${String(i).padStart(2, '0')}`);
    const server = newServer();
    server.cells = names.map((name, i) => cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', name, 'ok', 30 - i, 100, 20, 1, 1000 + i));
    await open(page, `?${names.map((name) => `method=${name}`).join('&')}`, server);
    await page.waitForTimeout(600);
    expect(await axeViolationsCharts(page), 'twenty entries, the lists').toEqual([]);
    await showValuesCharts(page);
    await page.waitForTimeout(400);
    expect(await axeViolationsCharts(page), 'twenty entries, the tables').toEqual([]);
  });
}

// ---- more of the groups ---------------------------------------------------------------------------------------------------------------------
test('the title of an entry says what a word that stands for a group of messages is: a method of the protocol, a client that has no name, a result that is a code of the server', async ({ page }) => {
  await open(page);
  // A tool has no sentence. The methods of the protocol and the words that ClickHouse Dash creates do.
  await expect(entry(page, 'method:query_table')).toHaveAttribute('title', 'Filter by method query_table');
  await expect(entry(page, 'method:ping')).toHaveAttribute('title', 'Filter by method ping\nA client checks that the server answers');
  await expect(entry(page, 'method:tools/list')).toHaveAttribute('title', 'Filter by method tools/list\nThe client asks for the tools that its key may call');
  await expect(entry(page, 'method:initialize')).toHaveAttribute('title', 'Filter by method initialize\nThe start of a session: the client says who it is');
  await expect(entry(page, 'method:unread', 'refused')).toHaveAttribute('title', /^Filter by method unread\nRefused before the message was read: the rate limit \(429\), a body that was too large \(413\), a content type that is not JSON \(415\) or a request that was not valid \(400\)$/);
  await expect(entry(page, 'method:other', 'errors')).toHaveAttribute('title', /^Filter by method other\nA method that is not in the vocabulary of ClickHouse Dash/);
  // The words that stand for a client are `unknown` (no name, no User-Agent) and `other` (past the cap of the names that are kept).
  const clients = newServer();
  clients.cells = [
    cell('ops-all', '2026-10-14T09:30', 'call', 'unknown', 'list_hosts', 'ok', 5, 20, 8, 0, 100),
    cell('ops-all', '2026-10-14T09:30', 'call', 'other', 'list_hosts', 'ok', 4, 20, 8, 0, 100),
    cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'invalid', 'rpc_error_32700', 2, 2, 1, 0, 100),
    cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'response', 'ok', 3, 2, 1, 0, 100),
    cell('ops-all', '2026-10-14T09:30', 'request', 'claude-code', 'tools/call', 'rpc_error_32602', 1, 2, 1, 0, 100),
  ];
  await open(page, '?group=client', clients);
  await expect(entry(page, 'client:unknown')).toHaveAttribute('title', 'Filter by client unknown\nThe client sent no name in initialize and no User-Agent');
  await expect(entry(page, 'client:other')).toHaveAttribute('title', 'Filter by client other\nThe clients past the caps: a key keeps 16 client names, and ClickHouse Dash 4,096');
  await expect(entry(page, 'client:claude-code')).toHaveAttribute('title', 'Filter by client claude-code');
  await open(page, '', clients);
  await expect(entry(page, 'method:invalid')).toHaveAttribute('title', 'Filter by method invalid\nA message whose method could not be read: not JSON, a batch, no jsonrpc member, or a method that is not a string');
  await expect(entry(page, 'method:response')).toHaveAttribute('title', 'Filter by method response\nThe answer of a client to a request of the server');
  await expect(entry(page, 'method:tools/call')).toHaveAttribute('title', 'Filter by method tools/call\nA tool call that failed before the tool ran (an unknown tool, a missing argument)');
  // A result is `ok`, a code of a tool, or what the server makes of an error of the protocol or of a refusal.
  await open(page, '?group=result', clients);
  await expect(entry(page, 'result:rpc_error_32700')).toHaveAttribute('title', 'Filter by result rpc_error_32700\nA JSON-RPC error of the protocol (code -32700)');
});

test('a value that is picked and has nothing in the window stays in the legend at zero, and the other values are as they are', async ({ page }) => {
  const server = await open(page, '?method=ping&method=nothing');
  expect(reads(server)).toEqual(['?window=7d&group=method&order=requests&method=ping&method=nothing']);
  // The groups are the values that were picked, in the order that they were picked. This includes one value that nothing matches. Both are pressed.
  for (const id of ['requests', 'bytes']) {
    expect(await legendIds(page, id), id).toEqual(['method:ping', 'method:nothing']);
    await expect(entry(page, 'method:nothing', id)).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(entry(page, 'method:nothing')).toHaveAttribute('title', 'Stop filtering by method nothing');
  await showValuesCharts(page);
  expect(await tableRowsCharts(page)).toEqual([['ping', '100', '0', '100', '1.79', '100'], ['nothing', '0', '0', '0', '0', '0']]);
  expect(await tableRowsCharts(page, 'bytes')).toEqual([['ping', '3.9 KB', '0 B', '3.9 KB', '71 B', '3.9 KB'], ['nothing', '0 B', '0 B', '0 B', '0 B', '0 B']]);
  for (const id of ['errors', 'rate', 'refused', 'time']) await expect(emptyTitleCharts(page, id), id).toHaveText(NOTHING_CHARTS[id]);
  // The entry of the value that nothing matches is released like any other entry. The chart has the figures of ping alone.
  await entry(page, 'method:nothing').click();
  await expect(chips(page)).toHaveText(['Method=ping']);
  await settled(page);
  expect(reads(server).at(-1)).toBe('?window=7d&group=method&order=requests&method=ping');
  expect(await tableRowsCharts(page)).toEqual([['ping', '100', '0', '100', '1.79', '100']]);
});

test('two entries pressed while the page reads are two filters: the older read is cancelled, and only the last answer is drawn', async ({ page }) => {
  const server = await open(page);
  server.delay['GET /usage/overview'] = 600;
  await entry(page, 'method:ping').click();
  // The legend shows the pick at once: the entries that the filter leaves out are dimmed. The next entry can be pressed while the read runs.
  await expect(entry(page, 'method:ping')).toHaveAttribute('aria-pressed', 'true');
  await entry(page, 'method:list_hosts').click();
  await expect(entry(page, 'method:list_hosts')).toHaveAttribute('aria-pressed', 'true');
  await expect(chips(page)).toHaveText(['Method=ping', 'Method=list_hosts']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?method=ping&method=list_hosts$/);
  await settled(page);
  expect(reads(server)).toEqual([
    `?window=7d&group=method${ORDERS}`,
    '?window=7d&group=method&order=requests&method=ping',
    '?window=7d&group=method&order=requests&method=ping&method=list_hosts',
  ]);
  expect(await legendIds(page)).toEqual(['method:ping', 'method:list_hosts']);
  expect(await legendIds(page, 'bytes')).toEqual(['method:ping', 'method:list_hosts']);
  expect((await tiles(page)).Requests).toEqual(['175', 'in the last 7 days']);
  server.delay['GET /usage/overview'] = 0;
});

// ---- the states, the layout, the accessibility and the instances --------------------------------------------------------------
// This part covers what the tab does when it cannot show figures. Examples are a read that fails, MCP that is off, or the usage that is off.
// It also covers how the tab reads and moves: Refresh, the history, and the back/forward cache.
// It covers the layout from 1920 px down to a phone, in both themes, and for a screen reader. It also covers the instances that share the usage directory.
// The instances have no note of their own on this tab. The Instance list says how many there are, and what each one did last (docs/mcp-integration-page.md, "Instances").

const HCL_USAGE_States = 'mcp {\n  usage {\n    enabled = true\n    dir     = "/var/lib/chdash/mcp-usage"\n  }\n}';
// This is the state of the files of the instances: chdash-0 (this one), and the others as `others` says ([name, status, reason]).
const filesOfStates = (me, others) => [
  { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: me[0], reason: me[1] },
  ...others.map(([instance, status, reason], i) => ({ instance, written_at: status === 'ok' ? '2026-10-14T09:58:50Z' : `2026-10-14T0${i + 1}:00:00Z`, status, reason })),
];
// These are the two files of the default server. They come from INSTANCES of the fake, which the header does not import.
const INSTANCES_States = () => [
  { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'ok', reason: '' },
  { instance: 'chdash-1', written_at: '2026-10-14T09:58:50Z', status: 'ok', reason: '' },
];
const warningsStates = (page) => page.locator('.mcpOverview__warnings .uiBanner');
// This ticks a value in a list of the bar. The list stays open for the next pick. Escape closes it.
const tickStates = async (page, dimension, value) => {
  const menu = await openPicker(page, dimension);
  await menu.locator(`input[value="${value}"]`).check();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
};
// These are the calls that the page made, as "GET /meta".
const callsStates = (server) => server.calls.map((call) => `${call.method} ${call.path}`);

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
  // The row, the bar, the chips row and the window are there. The person can pick another window or another filter.
  // Nothing has been read, so the period has nothing to say.
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpBar')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(period(page)).toHaveText('');
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(groupButton(page)).toHaveText('Group by · Method');
  // Try again reads again. The next answer is fine.
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(failed).toHaveCount(0);
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`, `?window=7d&group=method${ORDERS}`]);
  // A failure follows a success: the figures go, the error shows, and another window reads again.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('.mcpOverview__state .uiState--error .uiState__body')).toHaveText('The usage could not be read.');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
  await expect(page.locator('#mcpBar')).toBeVisible();
  await windowButton(page, '30 d').click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpOverview__state')).toBeHidden();
  // A server that refuses a value says which value. The message is the page's, and the chip can go.
  server.errors['GET /usage/overview'] = { status: 400, body: { error_code: 'validation', message: 'key is not valid.', retryable: false, field: 'key', reason: 'invalid' } };
  await tickStates(page, 'key', 'ops-all');
  await expect(page.locator('.mcpOverview__state .uiState--error .uiState__body')).toHaveText('key is not valid.');
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all']);
  await page.getByRole('button', { name: 'Remove filter Key = ops-all' }).click();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  // Group by still works while a read fails. The bar says the group that was asked.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await pickGroup(page, 'client');
  await expect(page.locator('.mcpOverview__state .uiState--error')).toBeVisible();
  await expect(groupButton(page)).toHaveText('Group by · Client');
});

test('a read that keeps failing leaves the lists of the bar open on the values of the address, with no count, and a pick takes one off', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage/overview'] = { status: 500, keep: true, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await install(page, server);
  await page.goto('/mcp-integration/usage?key=ops-all&result=ok');
  await expect(page.locator('.mcpOverview__state .uiState--error')).toBeVisible();
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Result = ok']);
  // There is no answer and no facet. The list has the values that the address names (checked, with no count), and nothing else.
  const menu = await openPicker(page, 'key');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['ops-all']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['']);
  await expect(pickerBox(page, 'key', 'ops-all')).toBeChecked();
  await expect(pickerButton(page, 'key')).toHaveText('Key · ops-all');
  // The next answer is fine. Untick the key to remove the filter, and the page reads without it. The result stays.
  delete server.errors['GET /usage/overview'];
  await pickerBox(page, 'key', 'ops-all').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpOverview__state')).toBeHidden();
  expect(await chipLabels(page)).toEqual(['Remove filter Result = ok']);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&result=ok`);
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
  // There is no bar and no chip, because the page has nothing to filter.
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__filters')).toHaveCount(0);
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTab-usage')).toHaveAttribute('aria-current', 'page');
  expect(callsStates(server)).toEqual(['GET /meta']);
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('.mcpOff')).toBeVisible();
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  // The state of the meta fails. Retry reads it again, and the usage follows.
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

test('usage off: the tab says "Usage is off" and shows the block that turns it on, which copies; no bar, no chips, no tiles, and the page asks for nothing but the meta', async ({ page }) => {
  const server = newServer();
  setUsage(server, { enabled: false });
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  const off = page.locator('#mcpUsageOff');
  await expect(off).toBeVisible();
  await expect(off).toHaveAttribute('aria-label', 'Usage is off');
  await expect(off.locator('.uiState--empty .uiState__title')).toHaveText('Usage is off');
  // This is what the tab shows: the figures of every key over time, cut by key, method, client and instance. It is also what the details of a key would say.
  await expect(off.locator('.uiState__body')).toHaveText('ClickHouse Dash does not count what the keys do, so there is nothing to show here. Turned on, this tab shows the requests, the errors, '
    + 'the time of a call and the bytes of every key over time, by key, method, client and instance, and the details of a key say what it did and when it was last used.');
  // This is what to do: the block of the config file that turns it on, with its copy button, and what the directory needs.
  await expect(off.locator('.mcpNote').first()).toHaveText('Add this to the config file, then restart ClickHouse Dash:');
  expect(await off.locator('.mcpCode__pre').textContent()).toBe(HCL_USAGE_States);
  await expect(off.locator('.mcpNote').last()).toContainText('The directory must exist and be writable.');
  await expect(off.locator('.mcpNote').last()).toContainText('Several instances can share the directory: each saves its own file and reads the others, and every figure is then their sum.');
  await expect(off.locator('.mcpNote').last()).toContainText('retention_days (90 by default)');
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await off.getByRole('button', { name: 'Copy the HCL block' }).click();
  await expect.poll(copied).toBe(HCL_USAGE_States);
  await expect(off.locator('.mcpCode__copy')).toHaveClass(/is-copied/);
  // The row of the two pages stays. Nothing else of the tab is there: no bar, no chips, no tiles, no charts, and no period.
  await expect(page.locator('h1')).toHaveText('MCP usage');
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTab-usage')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__filters')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__tiles')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__card')).toHaveCount(0);
  await expect(period(page)).toHaveCount(0);
  await expect(page.locator('#mcpOverview')).toBeHidden();
  // The page does not ask for what is off. The meta is the only request. Nothing reads later either, a reload included.
  await page.waitForTimeout(600);
  expect(callsStates(server)).toEqual(['GET /meta']);
  await page.reload();
  await expect(off).toBeVisible();
  await page.waitForTimeout(400);
  expect(callsStates(server)).toEqual(['GET /meta', 'GET /meta']);
  // The link of the row opens the keys. The Usage link returns to the same state.
  await page.locator('#mcpTab-keys').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Keys');
  await page.locator('#mcpTab-usage').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await expect(page.locator('#mcpUsageOff')).toBeVisible();
  expect(callsStates(server).filter((call) => /usage\/overview|\/usage$/.test(call))).toEqual([]);
  await screenshot(page, 'usage-off');
  // A server whose meta says nothing of the usage (an older meta, from before the usage of the keys) has a usage that is off. The state is the same.
  const older = newServer();
  delete older.meta.usage;
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await install(page, older);
  await page.goto('/mcp-integration/usage');
  await expect(page.locator('#mcpUsageOff .uiState__title')).toHaveText('Usage is off');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(callsStates(older)).toEqual(['GET /meta']);
});

test('a read that answers "not_enabled" (the usage was turned off after the meta was read) ends in the same "Usage is off" state', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage/overview'] = { status: 404, body: { error_code: 'not_enabled', message: 'The usage of the keys is off (mcp.usage.enabled is false).', retryable: false } };
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  // The meta said that the usage is on, so the page asked for it. The answer ended the tab in the state of a usage that is off, and that is not an error.
  const off = page.locator('#mcpUsageOff');
  await expect(off).toBeVisible();
  await expect(off.locator('.uiState--empty .uiState__title')).toHaveText('Usage is off');
  expect(await off.locator('.mcpCode__pre').textContent()).toBe(HCL_USAGE_States);
  await expect(page.locator('.uiState--error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // The bar and the chips were drawn before the answer. They are hidden with the tab, and so are the figures and the period.
  await expect(page.locator('#mcpBar')).toBeHidden();
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await expect(page.locator('#mcpOverview')).toBeHidden();
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  await page.waitForTimeout(600);
  expect(callsStates(server)).toEqual(['GET /meta', 'GET /usage/overview']);
});

// A read of a page whose Group by dimension is filtered has no `orders`. The groups are the values that were picked, the same in every chart.
const ORDER_ONLY_States = '&order=requests';
// The room between the charts and the end of the content of the tab is 0 when there is no note under them. The row of the notes is hidden.
// So the grid of the content has no empty row and no gap for it. When there is a note, the room is a gap and the note.
const roomUnderChartsStates = (page) => page.evaluate(() => document.querySelector('.mcpOverview__content').getBoundingClientRect().bottom - document.querySelector('.mcpOverview__charts').getBoundingClientRect().bottom);

test('the counting says since when, for a window that starts before it, and the period starts there; nothing else is said about what the rows are or what was left out', async ({ page }) => {
  // The counting began on Oct 1 08:00 (the default meta). The last 7 days start after it, so they say nothing: no note, and no row for it.
  // The last 30 days start before it.
  await open(page);
  const notes = page.locator('.mcpOverview__notes p');
  await expect(page.locator('.mcpOverview__notes')).toBeHidden();
  await expect(page.locator('.mcpOverview__notes')).toHaveAttribute('hidden', '');
  expect(Math.abs(await roomUnderChartsStates(page))).toBeLessThanOrEqual(0.5);
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
  await windowButton(page, '30 d').click();
  await expect(pressedWindow(page)).toHaveText('30 d');
  await settled(page);
  await expect(notes).toHaveText(['Counted since Oct 1 08:00.']);
  await expect(page.locator('.mcpOverview__notes')).toBeVisible();
  expect(await roomUnderChartsStates(page)).toBeGreaterThan(20);
  await expect(period(page)).toHaveText('Oct 1 08:00 → Oct 14 10:00');
  // The old note about the rows is gone with the tables. The tile of the bytes says it in its title.
  await expect(page.locator('.mcpOverview__content')).not.toContainText('counts no row');
  await expect(tile(page, 'Returned')).toHaveAttribute('title', /\(an API tool counts no row\)$/);

  // The counting began at 08:00 today. The last 7 days, 24 hours and 6 hours start before it. The last hour starts at 09:01, after it.
  // The note is the same whether the usage is kept in files or not. It says when the counting began, and it says nothing about a restart or the memory.
  const server = newServer();
  server.meta.usage = { ...server.meta.usage, since: '2026-10-14T08:00:00Z' };
  // The lists that the server cut follow the contract. Each list has one count, and the instances are included. The page has no table to say so.
  server.overview = (srv, params) => {
    const answer = overviewOf(srv, params);
    if (answer.status === 200) answer.body.omitted = { keys: 0, methods: 12, results: 0, clients: 3, instances: 0 };
    return answer;
  };
  await open(page, '', server);
  await expect(notes).toHaveText(['Counted since Oct 14 08:00.']);
  await expect(page.locator('.mcpOverview__notes')).not.toContainText(/memory|restart|persist/i);
  await expect(period(page)).toHaveText('Oct 14 08:00 → 10:00');
  await expect(page.locator('.mcpOverview__content')).not.toContainText('not shown');
  for (const [label, range] of [['24 h', 'Oct 14 08:00 → 10:00'], ['6 h', 'Oct 14 08:00 → 10:00']]) {
    await windowButton(page, label).click();
    await expect(pressedWindow(page)).toHaveText(label);
    await settled(page);
    await expect(notes, label).toHaveText(['Counted since Oct 14 08:00.']);
    await expect(period(page), label).toHaveText(range);
  }
  await windowButton(page, '1 h').click();
  await expect(pressedWindow(page)).toHaveText('1 h');
  await settled(page);
  await expect(page.locator('.mcpOverview__notes')).toBeHidden();
  expect(Math.abs(await roomUnderChartsStates(page))).toBeLessThanOrEqual(0.5);
  await expect(period(page)).toHaveText('Oct 14 09:01 → 10:00');
  // A server that has no start of the counting to give (a usage that has just been turned on) says nothing. The period is the window.
  const fresh = newServer();
  fresh.meta.usage = { ...fresh.meta.usage, since: null };
  await open(page, '?window=30d', fresh);
  await expect(page.locator('.mcpOverview__notes')).toBeHidden();
  await expect(period(page)).toHaveText('Sep 14 12:00 → Oct 14 10:00');
});

test('Refresh reads again, nothing else does: no timer, the figures stay (dimmed) while it runs, and a newer read cancels the one in flight', async ({ page }) => {
  const server = await open(page);
  expect(reads(server)).toHaveLength(1);
  // At rest, nothing is read. There is no refresh on a timer.
  await page.waitForTimeout(2500);
  expect(reads(server)).toHaveLength(1);
  expect(server.calls.filter((call) => call.path === '/meta')).toHaveLength(1);
  server.delay['GET /usage/overview'] = 600;
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('#mcpRefresh')).toBeDisabled();
  const body = page.locator('.mcpOverview__body');
  await expect(body).toHaveAttribute('aria-busy', 'true');
  // The figures stay, dimmed, while the answer comes. There is no spinner in their place. The tiles and the charts are the old ones.
  await expect(body).toHaveClass(/is-loading/);
  expect(Number(await body.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  await expect(page.locator('.mcpOverview__state')).toBeHidden();
  await expect(tile(page, 'Requests')).toBeVisible();
  await expect(chartBox(page).locator('.chartCore')).toBeVisible();
  await settled(page);
  await expect(page.locator('#mcpRefresh')).toBeEnabled();
  await expect(body).not.toHaveClass(/is-loading/);
  expect(Number(await body.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`, `?window=7d&group=method${ORDERS}`]);
  // From the keyboard, the button is off while the read runs. That takes the focus from it, and the focus returns to it.
  await page.locator('#mcpRefresh').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mcpRefresh')).toBeDisabled();
  await settled(page);
  await expect(page.locator('#mcpRefresh')).toBeFocused();
  expect(reads(server)).toHaveLength(3);
  // A change while a read runs cancels it. Only the last answer is drawn. The legend entry of ping starts a slow read (1.2 s).
  // The window that follows reads again at once. A second after the answer of that one, the figures are still the ones of 24 hours with the filter (100 requests of ping).
  // The late answer of the older read is not drawn over them.
  server.delay['GET /usage/overview'] = 1200;
  await entry(page, 'method:ping').click();
  await expect.poll(() => reads(server).length).toBe(4);
  server.delay['GET /usage/overview'] = 0;
  await windowButton(page, '24 h').click();
  await expect(pressedWindow(page)).toHaveText('24 h');
  await expect(period(page)).toHaveText('Oct 13 10:15 → Oct 14 10:00');
  await settled(page);
  await page.waitForTimeout(1500);
  await expect(period(page)).toHaveText('Oct 13 10:15 → Oct 14 10:00');
  expect((await tiles(page)).Requests).toEqual(['100', 'in the last 24 hours']);
  await expect(chips(page)).toHaveText(['Method=ping']);
  expect(reads(server).slice(-2)).toEqual([`?window=7d&group=method${ORDER_ONLY_States}&method=ping`, `?window=24h&group=method${ORDER_ONLY_States}&method=ping`]);
  // The page has no timer of its own. A few seconds later, nothing was read and no chart was drawn again.
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
  // The bar is shown again with the tab, not twice. The chips row and the period are shown with it too.
  await expect(page.locator('#mcpBar')).toHaveCount(1);
  await expect(page.locator('#mcpBar')).toBeVisible();
  await expect(page.locator('.mcpOverview__filters')).toHaveCount(1);
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
});

test('desktop and phone: the page has no sideways scroll from 1920 px to 390 px; the bar is one row from 1101 px, the six lists share a row down to 761 px, and the charts take three columns, two or one', async ({ page }) => {
  await open(page, '?key=ops-all');
  for (const [width, height] of [[1920, 1000], [1440, 900], [1280, 800], [1101, 800], [1100, 800], [820, 800], [761, 800], [760, 800], [601, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await expect(chartBox(page).locator('.chartCore')).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await horizontalOverflow(page), `${width}: the page`).toBeLessThanOrEqual(0);
    const m = await page.evaluate(() => {
      const panel = document.querySelector('#mcpPanel');
      const bar = document.querySelector('#mcpBar');
      const box = (el) => el.getBoundingClientRect();
      return {
        panel: panel.scrollWidth - panel.clientWidth,
        bar: bar.scrollWidth - bar.clientWidth,
        barHeight: Math.round(box(bar).height),
        // The eight controls of the bar are Group by and the five lists (the lead), and the window and Refresh (the tail). They are measured left to right.
        // Each control gives its middle, its right edge and its width.
        controls: [...bar.querySelectorAll('.tracePicker__button, .mcpBar__windows, #mcpRefresh')].map((el) => {
          const b = box(el);
          return { middle: b.top + b.height / 2, right: b.right, width: b.width };
        }),
        // No word of a list is cut by an ellipsis when nothing is picked.
        cut: [...bar.querySelectorAll('.tracePicker__label')].filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent),
        chartColumns: getComputedStyle(document.querySelector('.mcpOverview__charts')).gridTemplateColumns.split(' ').length,
        tileLines: new Set([...document.querySelectorAll('.mcpOverview__tiles .statTile')].map((el) => Math.round(box(el).top))).size,
        charts: [...document.querySelectorAll('.mcpOverview__chart')].map((el) => Math.round(box(el).width)),
        chips: Math.round(box(document.querySelector('.mcpOverview__filters')).width),
        tables: document.querySelectorAll('.mcpOverview table:not(.chartCore__legendTable)').length,
      };
    });
    expect(m.panel, `${width}: the panel`).toBeLessThanOrEqual(0);
    expect(m.bar, `${width}: the bar`).toBeLessThanOrEqual(0);
    // There are two columns of charts from 761 px, and three from 1280 px. Seven tiles share one line from 1100 px. The six charts have the width of a column.
    expect(m.chartColumns, `${width}: the columns of the charts`).toBe(width >= 1280 ? 3 : width >= 761 ? 2 : 1);
    if (width >= 1100) expect(m.tileLines, `${width}: the tiles`).toBe(1);
    expect(new Set(m.charts).size, `${width}: the charts`).toBe(1);
    expect(m.charts[0], `${width}: a chart`).toBeGreaterThan(width / m.chartColumns - 70);
    // The tab has no table, except the Values table of a legend. There is none in the list mode.
    expect(m.tables, `${width}: no table of the tab`).toBe(0);
    // The eight controls do not go past the window.
    expect(m.controls, `${width}: the controls of the bar`).toHaveLength(8);
    expect(Math.max(...m.controls.map((control) => control.right)), `${width}: the right end of the bar`).toBeLessThanOrEqual(width);
    const lead = m.controls.slice(0, 6);
    const rowOf = (control) => Math.round(control.middle / 4);
    if (width > 1100) {
      // One row of 48 px holds the six lists, the window and Refresh. Group by and the Instance list have more room than the other four. They say the most by default: a basis of 140 px against 104.
      // So no word is cut, and the narrowest list keeps its 100 px.
      expect(m.barHeight, `${width}: the bar`).toBeLessThanOrEqual(52);
      expect(Math.max(...m.controls.map((control) => control.middle)) - Math.min(...m.controls.map((control) => control.middle)), `${width}: one row`).toBeLessThanOrEqual(2);
      expect(Math.min(...lead.map((control) => control.width)), `${width}: the narrowest list`).toBeGreaterThanOrEqual(100);
      if (width <= 1440) {
        expect(lead[0].width - lead[1].width, `${width}: Group by against Key`).toBeGreaterThan(30);
        expect(lead[5].width - lead[4].width, `${width}: Instance against Result`).toBeGreaterThan(30);
      }
    } else if (width >= 761) {
      // The lead is one row (the six lists). The window and Refresh are the row under it.
      expect(m.barHeight, `${width}: the bar`).toBeGreaterThan(70);
      expect(new Set(lead.map(rowOf)).size, `${width}: the lead is one row`).toBe(1);
      expect(m.controls[6].middle, `${width}: the window is under the lists`).toBeGreaterThan(m.controls[0].middle + 20);
      expect(m.controls[7].middle, `${width}: Refresh is with the window`).toBeCloseTo(m.controls[6].middle, 0);
    } else {
      // The lists share the rows two by two. The window and Refresh come last: four rows in all.
      expect(new Set(lead.map(rowOf)).size, `${width}: three rows of lists`).toBe(3);
      expect(m.controls[6].middle, `${width}: the window is under the lists`).toBeGreaterThan(Math.max(...lead.map((control) => control.middle)) + 20);
    }
    // From 800 px, the lists have the room that their words need. At 761 px, they have their basis and no more. "Method · All" is one pixel short there.
    if (width >= 800) expect(m.cut, `${width}: no word of the bar is cut`).toEqual([]);
    expect(m.chips, `${width}: the chips row`).toBeGreaterThan(width - 4);
  }
  await screenshot(page, 'usage-phone');
});

test('a phone folds the bar into one line, the window and the group and how many filters; it unfolds to the lists and folds again with Refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await open(page, '?key=ops-all&client=claude-code');
  const summary = page.locator('#mcpBar .obsFilterSummary');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  // The group is an order, not a filter. The line counts the two chips, and it names the window and the group where a time range is.
  await expect(summary).toHaveText('Last 7 days · by method · 2 filters');
  await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeHidden();
  await expect(page.locator('#mcpBar .obsFilterBar__tail')).toBeHidden();
  // The chips row folds with the bar, and the period folds with it. What is left of the head of the tab is the line.
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await expect(period(page)).toBeHidden();
  await screenshot(page, 'usage-phone-folded');
  // The line is a button that says what it does. The controls that it hides are not stops of the keyboard. From the line, the next stop is not in the bar.
  await expect(summary).toHaveAttribute('title', 'Show the filters');
  await summary.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.closest('#mcpBar'))).toBeNull();
  // It unfolds to the bar from the keyboard, and the chips come with it. The next stop is Group by.
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toHaveAttribute('title', 'Hide the filters');
  await expect(summary).toHaveText('Hide the filters');
  await page.keyboard.press('Tab');
  await expect(groupButton(page)).toBeFocused();
  for (const button of [groupButton(page), ...['key', 'method', 'client', 'result', 'instance'].map((dimension) => pickerButton(page, dimension)), windowButton(page, '24 h'), page.locator('#mcpRefresh')]) await expect(button).toBeVisible();
  await expect(chips(page)).toHaveCount(2);
  await expect(page.locator('.mcpOverview__filters')).toBeVisible();
  await expect(period(page)).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // A list opens inside the window, whatever the width of the field that it hangs from. The lists are two to a row.
  // The Key, Client and Instance lists hang from the right half. The Method and Result lists hang from the left half.
  for (const dimension of ['key', 'method', 'client', 'result', 'instance']) {
    const menu = await openPicker(page, dimension);
    const inside = await menu.evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; });
    expect(inside, `the ${dimension} list`).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
  await screenshot(page, 'usage-phone-bar');
  // The line follows a change of the window. Refresh (the action of the bar) folds it again.
  await windowButton(page, '24 h').click();
  await settled(page);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toHaveText('Last 24 hours · by method · 2 filters');
  await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeHidden();
  expect(reads(server).at(-1)).toBe(`?window=24h&group=method${ORDERS}&key=ops-all&client=claude-code`);
  // The line also follows a change of the group. It says by what the charts are grouped. This is an order, so it is no filter, and the count stays.
  await summary.click();
  await pickGroup(page, 'result');
  await expect(groupButton(page)).toHaveText('Group by · Result');
  await settled(page);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toHaveText('Last 24 hours · by result · 2 filters');
  expect(reads(server).at(-1)).toBe(`?window=24h&group=result${ORDERS}&key=ops-all&client=claude-code`);
});

test('the phone line counts the instance chip like the other filters, and the Instance list is in the unfolded bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const server = await open(page, '?instance=chdash-1');
  const summary = page.locator('#mcpBar .obsFilterSummary');
  // One chip is one filter. The singular is used: the line says "1 filter". The group and the window are not filters.
  await expect(summary).toHaveText('Last 7 days · by method · 1 filter');
  await expect(page.locator('.mcpOverview__filters')).toBeHidden();
  await summary.click();
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  expect(await chipLabels(page)).toEqual(['Remove filter Instance = chdash-1']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  // The list is a filter, and a chip is one. A second filter from the bar makes two. Refresh folds the bar over the new line.
  await tickStates(page, 'key', 'ops-all');
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Instance=chdash-1']);
  await settled(page);
  await expect.poll(() => reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&key=ops-all&instance=chdash-1`);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(summary).toHaveText('Last 7 days · by method · 2 filters');
  // The chip goes with its x, and the line follows.
  await summary.click();
  await page.getByRole('button', { name: 'Remove filter Instance = chdash-1' }).click();
  await expect(chips(page)).toHaveText(['Key=ops-all']);
  await settled(page);
  await page.locator('#mcpRefresh').click();
  await expect(summary).toHaveText('Last 7 days · by method · 1 filter');
});

// This block covers the widths of a phone, a tablet, and a laptop that shows the bar. 390 and 600 px fold the bar. 761 and 820 px do not.
// The server has two warnings: a conflict and a skipped file. The page is cut to one instance. So the warnings, the Instance list and the line of the fold are all there.
for (const width of [390, 600, 761, 820]) {
  test(`${width} px: the warnings fit the window, the bar ${width <= 600 ? 'folds into its line, which follows the group,' : 'stays a bar,'} the Instance list opens inside the window, and nothing scrolls sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const server = newServer();
    server.instances = filesOfStates(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'invalid']]);
    await open(page, '?instance=chdash-1', server);
    const summary = page.locator('#mcpBar .obsFilterSummary');
    const folds = width <= 600;
    // The warnings are two boxes. Each box is as wide as the window at most, over the tiles, whether the bar is folded or not.
    await expect(warningsStates(page)).toHaveCount(2);
    const boxes = await warningsStates(page).evaluateAll((els) => els.map((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, clipped: el.scrollWidth - el.clientWidth })));
    for (const item of boxes) {
      expect(item.left).toBeGreaterThanOrEqual(0);
      expect(item.right).toBeLessThanOrEqual(width);
      expect(item.clipped).toBeLessThanOrEqual(0);
    }
    expect(await horizontalOverflow(page), `${width} px: the page`).toBeLessThanOrEqual(0);
    if (folds) {
      await expect(summary).toBeVisible();
      await expect(summary).toHaveText('Last 7 days · by method · 1 filter');
      await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeHidden();
      await summary.click();
    } else {
      await expect(summary).toBeHidden();
      await expect(page.locator('#mcpBar .obsFilterBar__lead')).toBeVisible();
    }
    // The Instance list says how many files there are. It marks the two that are not read, and it opens inside the window.
    await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
    const menu = await openPicker(page, 'instance');
    await expect(menu.locator('.mcpPicker__option .badge')).toHaveText(['conflict', 'skipped']);
    const inside = await menu.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, clipped: el.scrollWidth - el.clientWidth, rows: [...el.querySelectorAll('.mcpPicker__option')].map((item) => item.scrollWidth - item.clientWidth), width: document.documentElement.clientWidth };
    });
    expect(inside.left).toBeGreaterThanOrEqual(0);
    expect(inside.right).toBeLessThanOrEqual(inside.width);
    expect(inside.clipped).toBeLessThanOrEqual(0);
    expect(inside.rows).toEqual([0, 0]);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    // The group is on the line of the fold: Group by Result. Then Refresh (the action of the bar) folds the bar over the new words.
    await pickGroup(page, 'result');
    await expect(groupButton(page)).toHaveText('Group by · Result');
    await settled(page);
    if (folds) {
      await page.locator('#mcpRefresh').click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect(summary).toHaveText('Last 7 days · by result · 1 filter');
    }
    expect(reads(server).at(-1)).toBe(`?window=7d&group=result${ORDERS}&instance=chdash-1`);
    expect(await horizontalOverflow(page), `${width} px: the page, after the changes`).toBeLessThanOrEqual(0);
  });
}

// ---- the instances ----------------------------------------------------------------------------------------------------------------------
// ChDash instances that share the usage directory add up (docs/mcp-integration-page.md, "Instances"). The fake has two: chdash-0, this one (918 of the 1,101 requests of the last 7 days), and chdash-1 (183).
// The field `server.instances` is the state of each file. `oneInstance(server)` leaves one.
// Only the Usage tab says so, in its Instance list: the button counts them, and each row says when its instance wrote last.
// A pick in a list reads when the clicks pause (200 ms). So a test waits for the read that it expects before it looks at the figures.

// The page has made `count` reads of the overview, and it has drawn the answer of the last one.
const drawnStates = async (page, server, count) => {
  await expect.poll(() => reads(server).length).toBeGreaterThanOrEqual(count);
  await settled(page);
};

test('the Instance list says how many instances the usage sums and what each one did last: the other filters cut the counts but not the instances, and a pick is a filter', async ({ page }) => {
  const server = await open(page);
  const instance = pickerButton(page, 'instance');
  await expect(instance).toHaveText('Instance · All (2)');
  await expect(instance).toHaveAttribute('title', 'The usage is summed over 2 instances. Pick some to see only theirs.');
  // The tab has no note of the instances. It has no list in a popover. The list of the bar is where it says that the figures are a sum.
  await expect(page.locator('.mcpInstances')).toHaveCount(0);
  await expect(page.locator('.mcpInstances__button')).toHaveCount(0);
  const menu = await openPicker(page, 'instance');
  // The two instances that the server knows are listed, the one with the most requests first. Each has its requests in the window. None is checked.
  // Two values are not a long list, so there is no field to narrow it. A row is two lines: the name and the count, then when the instance wrote last.
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183']);
  await expect(menu.locator('.mcpPicker__meta')).toHaveText(['this instance · wrote 30 s ago', 'wrote 1 min ago']);
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(menu.locator('.badge')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: 'All instances' })).toBeVisible();
  await expect(menu.locator('.mcpPicker__search')).toBeHidden();
  await expect(menu).toHaveAttribute('aria-label', 'Instance filter');
  await expect(menu.getByRole('group', { name: 'Instance' })).toBeVisible();
  // The name of a check box has the instance, its requests, and when it wrote last. So a screen reader says what the row shows.
  await expect(menu.getByRole('checkbox', { name: /^chdash-1 183 wrote 1 min ago$/ })).toBeVisible();
  await expect(menu.getByRole('checkbox', { name: /^chdash-0 918 this instance · wrote 30 s ago$/ })).toBeVisible();
  // A pick sets the button, the chip and the address at once. The page reads when the clicks pause. Every figure has the filter.
  await menu.getByRole('checkbox', { name: /^chdash-1/ }).check();
  await expect(instance).toHaveText('Instance · chdash-1');
  await expect(instance).toHaveAttribute('title', 'chdash-1');
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await drawnStates(page, server, 2);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`, `?window=7d&group=method${ORDERS}&instance=chdash-1`]);
  expect(await tiles(page)).toMatchObject({ Requests: ['183', 'in the last 7 days'], 'Active keys': ['2', 'of 5 keys'] });
  // The list has every filter but its own. The instance that is picked does not cut it. Both are still there to pick, with their counts.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183']);
  await expect(menu.getByRole('checkbox', { name: /^chdash-1/ })).toBeChecked();
  // The other lists have the filter of the instance: the keys that wrote to chdash-1 are ops-all and legacy.
  await page.keyboard.press('Escape');
  const keys = await openPicker(page, 'key');
  await expect(keys.locator('.mcpPicker__name')).toHaveText(['ops-all', 'legacy']);
  await expect(keys.locator('.mcpPicker__count')).toHaveText(['155', '28']);
  await page.keyboard.press('Escape');
  // The other way round: a key cuts the counts of the instances, not the instances. Ops-all has 857 requests in chdash-0 and 155 in chdash-1.
  await chips(page).first().locator('.chip__remove').click();
  await drawnStates(page, server, 3);
  await tickStates(page, 'key', 'ops-all');
  await drawnStates(page, server, 4);
  const again = await openPicker(page, 'instance');
  await expect(again.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(again.locator('.mcpPicker__count')).toHaveText(['857', '155']);
  // A key that never wrote to an instance stays listed, with 0 and its last write. The server lists every instance that it knows.
  // The legacy key wrote to chdash-1 only (28 requests), so chdash-0 is last.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove filter Key = ops-all' }).click();
  await drawnStates(page, server, 5);
  await tickStates(page, 'key', 'ui_legacy000000');
  await expect(chips(page)).toHaveText(['Key=legacy']);
  await drawnStates(page, server, 6);
  const none = await openPicker(page, 'instance');
  await expect(none.locator('.mcpPicker__name')).toHaveText(['chdash-1', 'chdash-0']);
  await expect(none.locator('.mcpPicker__count')).toHaveText(['28', '0']);
  await expect(none.locator('.mcpPicker__meta')).toHaveText(['wrote 1 min ago', 'this instance · wrote 30 s ago']);
  await screenshot(page, 'usage-picker-instance');
});

test('a row says this instance and when each wrote last, counted from the time of the answer, with the exact time in its title and "no write yet" for a file that has none', async ({ page }) => {
  const server = newServer();
  // The fake has six files. They were written 30 s, 1 min, 2 h, 6 days and a year before the answer (10:00 on Oct 14). One file has not been written yet.
  // Only the first two have requests. The others are listed after them (zeros, by name), with their last write all the same.
  server.instances = [
    { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'ok', reason: '' },
    { instance: 'chdash-1', written_at: '2026-10-14T09:58:50Z', status: 'ok', reason: '' },
    { instance: 'chdash-2', written_at: '2026-10-14T08:00:00Z', status: 'ok', reason: '' },
    { instance: 'chdash-3', written_at: '2026-10-08T10:00:00Z', status: 'ok', reason: '' },
    { instance: 'chdash-4', written_at: '2025-10-01T10:00:00Z', status: 'ok', reason: '' },
    { instance: 'chdash-5', written_at: null, status: 'ok', reason: '' },
  ];
  await open(page, '', server);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (6)');
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1', 'chdash-2', 'chdash-3', 'chdash-4', 'chdash-5']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183', '0', '0', '0', '0']);
  await expect(menu.locator('.mcpPicker__meta')).toHaveText(['this instance · wrote 30 s ago', 'wrote 1 min ago', 'wrote 2 h ago', 'wrote 6 d ago', 'wrote 1 y ago', 'no write yet']);
  // The exact time is in the title of the line (UTC here). A file with no write has no time to give.
  await expect(menu.locator('.mcpPicker__meta').nth(0)).toHaveAttribute('title', /^2026-10-14T09:59:30\.000Z\n/);
  await expect(menu.locator('.mcpPicker__meta').nth(1)).toHaveAttribute('title', /^2026-10-14T09:58:50\.000Z\n/);
  await expect(menu.locator('.mcpPicker__meta').nth(4)).toHaveAttribute('title', /^2025-10-01T10:00:00\.000Z\n/);
  expect(await menu.locator('.mcpPicker__meta').nth(5).getAttribute('title')).toBeFalsy();
  // The row of this instance is the one that the meta names (`usage.instance`). It can be anywhere in the list.
  server.meta.usage = { ...server.meta.usage, instance: 'chdash-1' };
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  const other = await openPicker(page, 'instance');
  await expect(other.locator('.mcpPicker__meta')).toHaveText(['wrote 30 s ago', 'this instance · wrote 1 min ago', 'wrote 2 h ago', 'wrote 6 d ago', 'wrote 1 y ago', 'no write yet']);
  // The times are counted from the answer, not from the clock of the browser. So the words are the same the next day.
  await page.clock.setFixedTime(new Date('2026-12-25T10:00:00Z'));
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  const later = await openPicker(page, 'instance');
  await expect(later.locator('.mcpPicker__meta').first()).toHaveText('wrote 30 s ago');
  // A meta that does not say which instance this is marks none of the rows. The other rows still say when they wrote.
  server.meta.usage = { ...server.meta.usage, instance: '' };
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  const nameless = await openPicker(page, 'instance');
  await expect(nameless.locator('.mcpPicker__meta')).toHaveText(['wrote 30 s ago', 'wrote 1 min ago', 'wrote 2 h ago', 'wrote 6 d ago', 'wrote 1 y ago', 'no write yet']);
});

test('"All instances" clears the filter, and an instance whose file is not read has its badge in the list, with the reason in its title', async ({ page }) => {
  const server = newServer();
  server.instances = filesOfStates(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'too_large']]);
  await open(page, '?instance=chdash-1', server);
  const menu = await openPicker(page, 'instance');
  // The two files are not read the same way. The file of this instance is in conflict, because another ChDash writes under its name. The other file is skipped.
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveText('conflict');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveText('skipped');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveAttribute('title', 'Another ChDash writes as chdash-0: this instance does not save its counts.');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveAttribute('title', 'chdash-1: its file was skipped (too large), so its counts are not in these figures.');
  // The badge is read with the row. The name of the check box has it between the name and the count.
  // The files of a skipped instance and of an instance in conflict were written 9 h and 30 s before the answer.
  await expect(menu.getByRole('checkbox', { name: 'chdash-1 skipped 183 wrote 9 h ago' })).toBeChecked();
  await expect(menu.getByRole('checkbox', { name: 'chdash-0 conflict 918 this instance · wrote 30 s ago' })).not.toBeChecked();
  // "All instances" lets the filter go. The button, the box, the chip and the address show this at once. Then the read follows.
  await menu.getByRole('button', { name: 'All instances' }).click();
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (2)');
  await expect(menu.locator('input:checked')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/mcp-integration\/usage$/);
  await drawnStates(page, server, 2);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}`);
  await expect(menu).toBeVisible();
});

test('a crowd of instances: the button counts them all, the list has a field that narrows it past 12, and takes 20 values at most', async ({ page }) => {
  // 25 instances share the directory, each with requests of its own. chdash-24 has the most.
  const server = newServer();
  server.instances = Array.from({ length: 25 }, (_, i) => ({ instance: `chdash-${i}`, written_at: '2026-10-14T09:59:00Z', status: 'ok', reason: '' }));
  server.cells = server.instances.map(({ instance }, i) => cell('ops-all', '2026-10-14T08:00', 'call', 'claude-code', 'query_table', 'ok', 1 + i, 5, 5, 1, 100, instance));
  await open(page, '', server);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (25)');
  await expect(pickerButton(page, 'instance')).toHaveAttribute('title', 'The usage is summed over 25 instances. Pick some to see only theirs.');
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(25);
  await expect(menu.locator('.mcpPicker__name').first()).toHaveText('chdash-24');
  await expect(menu.locator('.mcpPicker__count').first()).toHaveText('25');
  // Every row says when its instance wrote last. The list scrolls inside its box, which is 22 rem tall at most, with its head in view.
  await expect(menu.locator('.mcpPicker__meta')).toHaveCount(25);
  await expect(menu.locator('.mcpPicker__meta').first()).toHaveText('wrote 1 min ago');
  expect(await menu.evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, sideways: el.scrollWidth - el.clientWidth }))).toEqual({ scrolls: true, sideways: 0 });
  const search = menu.locator('.mcpPicker__search');
  await expect(search).toBeVisible();
  await expect(search).toHaveAttribute('aria-label', 'Filter the list of instances');
  await expect(search).toHaveAttribute('placeholder', 'Filter instances');
  // Text that is typed narrows the list to the names that hold the text, whatever the case. A text that no name holds gets a message that says so.
  await search.fill('CHDASH-2');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(6);
  await expect(menu.locator('.mcpPicker__option:not([hidden]) .mcpPicker__name')).toHaveText(['chdash-24', 'chdash-23', 'chdash-22', 'chdash-21', 'chdash-20', 'chdash-2']);
  await search.fill('zzz');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(0);
  await expect(menu.locator('.mcpPicker__none')).toHaveText('Nothing matches "zzz".');
  await search.fill('');
  await expect(menu.locator('.mcpPicker__option:not([hidden])')).toHaveCount(25);
  // Enter in the field does not submit. Down moves to the first value that is shown.
  const count = reads(server).length;
  await search.fill('chdash-1');
  await search.press('Enter');
  await page.waitForTimeout(400);
  expect(reads(server)).toHaveLength(count);
  await search.press('ArrowDown');
  await expect(menu.locator('.mcpPicker__option:not([hidden]) input').first()).toBeFocused();
  // The list shows 20 values at most. The 20th pick disables the boxes that are not checked, and says why. A box that is cleared enables them again.
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
  // The tab still has no note of its own for them. The button of the bar says how many there are.
  await expect(page.locator('.mcpInstances')).toHaveCount(0);
});

test('the button counts the instances that the usage sums: nothing to choose with one, then All (3), the instances that the server left out and a thousand', async ({ page }) => {
  // One instance: the list is disabled and says the instance. Below the list, nothing says "instances".
  const one = oneInstance(newServer());
  await open(page, '', one);
  expect(await pickerState(page, 'instance')).toEqual({ text: 'Instance · chdash-0', title: 'Only one instance in this view', disabled: true, ariaDisabled: 'true', off: true });
  // Three instances. The third has no request in the window. It is listed last, with its zeros. The summed sentence says three.
  const three = newServer();
  three.instances = [...INSTANCES_States(), { instance: 'chdash-2', written_at: '2026-10-14T09:57:00Z', status: 'ok', reason: '' }];
  await open(page, '', three);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (3)');
  await expect(pickerButton(page, 'instance')).toHaveAttribute('title', 'The usage is summed over 3 instances. Pick some to see only theirs.');
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1', 'chdash-2']);
  await expect(menu.locator('.mcpPicker__count')).toHaveText(['918', '183', '0']);
  await expect(menu.locator('.mcpPicker__meta')).toHaveText(['this instance · wrote 30 s ago', 'wrote 1 min ago', 'wrote 3 min ago']);
  await page.keyboard.press('Escape');
  // The server keeps 200 rows of a list and says how many it left out. The instances that it left out are instances all the same. 2 listed and 3 left out are 5.
  // 2 listed and 998 left out make 1,000, with its separator.
  for (const [omitted, text] of [[3, 'Instance · All (5)'], [998, 'Instance · All (1,000)']]) {
    const cut = newServer();
    cut.overview = (srv, params) => {
      const answer = overviewOf(srv, params);
      if (answer.status === 200) answer.body.omitted.instances = omitted;
      return answer;
    };
    await open(page, '', cut);
    await expect(pickerButton(page, 'instance'), `${omitted} left out`).toHaveText(text);
    await expect(pickerButton(page, 'instance')).toHaveAttribute('title', `The usage is summed over ${text.replace(/^Instance · All \((.*)\)$/, '$1')} instances. Pick some to see only theirs.`);
  }
  // A pick says the names and no count, whatever the server left out. The count is for when nothing is picked.
  await tickStates(page, 'instance', 'chdash-1');
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  await expect(pickerButton(page, 'instance')).toHaveAttribute('title', 'chdash-1');
});

test('the Instance list picks like the others: ticks that come together are one read and one entry of the history, ticks that cancel out are none, and the keyboard opens it, picks and closes it', async ({ page }) => {
  const server = await open(page);
  const instance = pickerButton(page, 'instance');
  const box = (value) => pickerBox(page, 'instance', value);
  const before = await page.evaluate(() => history.length);
  const menu = await openPicker(page, 'instance');
  // Two ticks that come together, from a person who ticks a few boxes, make one read and one entry of the history.
  await menu.evaluate((el) => { for (const input of el.querySelectorAll('input[type="checkbox"]')) input.click(); });
  await expect(instance).toHaveText('Instance · 2 selected');
  await expect(instance).toHaveAttribute('title', 'chdash-0, chdash-1');
  await expect(chips(page)).toHaveText(['Instance=chdash-0', 'Instance=chdash-1']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-0&instance=chdash-1$/);
  await drawnStates(page, server, 2);
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}`, `?window=7d&group=method${ORDERS}&instance=chdash-0&instance=chdash-1`]);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  // A box ticked and cleared before the clicks pause leaves the state as it was. There is no read and no entry of the history.
  await menu.evaluate((el) => { const input = el.querySelector('input[value="chdash-1"]'); input.click(); input.click(); });
  await page.waitForTimeout(500);
  await expect(instance).toHaveText('Instance · 2 selected');
  expect(reads(server)).toHaveLength(2);
  expect((await page.evaluate(() => history.length)) - before).toBe(1);
  await page.keyboard.press('Escape');
  // From the keyboard, Down opens the list on its first control, "All instances". Down again reaches the first value, and Space ticks it.
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
  await expect.poll(() => reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=chdash-1`);
  await settled(page);
  // The box keeps the focus through the read that follows its pick. Escape gives the focus back to the button.
  await expect(box('chdash-1')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(instance).toHaveAttribute('aria-expanded', 'false');
  await expect(instance).toBeFocused();
  // Up and Home/End move on the rows too. A second Space lets the instance go. The button says All again, with the count.
  await page.keyboard.press('ArrowUp');
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(box('chdash-1')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(instance).toHaveText('Instance · All (2)');
  await page.keyboard.press('Escape');
  await expect(instance).toBeFocused();
});

test('one instance is no choice: the Instance list is off and says it, nothing says "instances", the keyboard goes past it, and a conflict is still a warning', async ({ page }) => {
  const server = oneInstance(newServer());
  await open(page, '', server);
  // Everything is that one instance's: the figures are the same. The list is disabled in its place (no arrow, dimmed, not a stop of the keyboard).
  expect(await pickerState(page, 'instance')).toEqual({ text: 'Instance · chdash-0', title: 'Only one instance in this view', disabled: true, ariaDisabled: 'true', off: true });
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  await expect(pickerButton(page, 'key')).toBeEnabled();
  // With fewer than two instances, nothing is summed. So nothing on screen says "instances", and no warning is shown.
  expect(await page.evaluate(() => [document.querySelector('#mcpBar'), document.querySelector('.mcpOverview__filters'), document.querySelector('.mcpOverview__content')].map((el) => el.innerText).join('\n'))).not.toMatch(/instances/i);
  await expect(page.locator('.mcpInstances')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__warnings')).toBeHidden();
  await expect(warningsStates(page)).toHaveCount(0);
  // The keyboard goes past the list that is disabled, from the Result list to the window, and back.
  await pickerButton(page, 'result').focus();
  await page.keyboard.press('Tab');
  await expect(windowButton(page, '1 h')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pickerButton(page, 'result')).toBeFocused();
  // A conflict is about this instance. Another ChDash writes under its name, so its counts are not saved. It shows even with one instance.
  const conflict = oneInstance(newServer());
  conflict.instances[0] = { ...conflict.instances[0], status: 'conflict', reason: 'another process writes chdash-0.jsonl.zst' };
  await open(page, '', conflict);
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).');
  await expect(page.locator('.mcpOverview__warnings .uiBanner__summary')).toHaveText('Why');
  await expect(page.locator('.mcpInstances')).toHaveCount(0);
  expect(await pickerState(page, 'instance')).toMatchObject({ text: 'Instance · chdash-0', disabled: true });
});

test('the instance is in the address: read on load, in the order of the dimensions, written by a change, taken off by its chip, walked by Back and Forward', async ({ page }) => {
  // The address names the instance after the key and before the result. The chips and the reads have the order of the dimensions.
  const server = await open(page, '?result=ok&instance=chdash-1&key=ops-all');
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}&key=ops-all&instance=chdash-1&result=ok`]);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Instance = chdash-1', 'Remove filter Result = ok']);
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Instance=chdash-1', 'Result=ok']);
  await expect(chips(page).nth(1)).toHaveAttribute('title', 'Instance = chdash-1');
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  // Ops-all in chdash-1 that ended ok: 150 requests (155 less the 5 of run_query that ended in sql_error).
  expect(await tiles(page)).toMatchObject({ Requests: ['150', 'in the last 7 days'] });
  // An address that has nothing to fix is left as it was written. A change writes it in the order of the dimensions.
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?result=ok&instance=chdash-1&key=ops-all$/);
  await windowButton(page, '24 h').click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all&instance=chdash-1&result=ok$/);
  await settled(page);
  // The chip lets the instance go. The address and the list follow.
  await page.getByRole('button', { name: 'Remove filter Instance = chdash-1' }).click();
  await expect(chips(page)).toHaveText(['Key=ops-all', 'Result=ok']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?window=24h&key=ops-all&result=ok$/);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (2)');
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=24h&group=method${ORDERS}&key=ops-all&result=ok`);
  // All six dimensions are in an address, in no order. The chips, and the reads that the page makes, have the order of the dimensions: the instance is between the client and the result.
  // The method is filtered, and the charts are grouped by it. So the page asks for no ranking then.
  await page.goto('/mcp-integration/usage?type=call&result=ok&instance=chdash-1&client=claude-code&method=query_table&key=ops-all');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  expect(await chipLabels(page)).toEqual(['Remove filter Key = ops-all', 'Remove filter Method = query_table', 'Remove filter Client = claude-code', 'Remove filter Instance = chdash-1', 'Remove filter Result = ok', 'Remove filter Type = Tool calls']);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDER_ONLY_States}&key=ops-all&method=query_table&client=claude-code&instance=chdash-1&result=ok&type=call`);
  // A fresh load of an address with the instance reads it.
  await page.goto('/mcp-integration/usage?instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  // Back and Forward move through it. A pick in the list is an entry of the history.
  const menu = await openPicker(page, 'instance');
  await menu.getByRole('checkbox', { name: /^chdash-0/ }).check();
  await expect(chips(page)).toHaveText(['Instance=chdash-1', 'Instance=chdash-0']);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1&instance=chdash-0$/);
  await settled(page);
  await expect.poll(() => reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=chdash-1&instance=chdash-0`);
  await settled(page);
  expect(await tiles(page)).toMatchObject({ Requests: ['1,101', 'in the last 7 days'] });
  await page.keyboard.press('Escape');
  await page.goBack();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · chdash-1');
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=chdash-1`);
  expect(await tiles(page)).toMatchObject({ Requests: ['183', 'in the last 7 days'] });
  await page.goForward();
  await expect(chips(page)).toHaveText(['Instance=chdash-1', 'Instance=chdash-0']);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · 2 selected');
  await settled(page);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=chdash-1&instance=chdash-0`);
});

test('an instance that the page cannot use is dropped from the address at load: its characters, its length, a repeat, and more than 20 of them', async ({ page }) => {
  // An instance is 1 to 64 characters of letters, digits, dot, hyphen and underscore (the name of its file). A space, a slash, or a name of 65 characters is not valid.
  const server = await open(page, `?instance=bad%20name&instance=chdash-1&instance=a%2Fb&instance=chdash-1&instance=${'x'.repeat(65)}&instance=old_node.2-a&instance=${'y'.repeat(64)}`);
  // The valid values stay, once each, in the order that the address gave. The address is replaced, not pushed. The page reads once, for them.
  await expect(page).toHaveURL(new RegExp(`/mcp-integration/usage\\?instance=chdash-1&instance=old_node\\.2-a&instance=${'y'.repeat(64)}$`));
  expect(reads(server)).toEqual([`?window=7d&group=method${ORDERS}&instance=chdash-1&instance=old_node.2-a&instance=${'y'.repeat(64)}`]);
  expect(await chipLabels(page)).toEqual(['Remove filter Instance = chdash-1', 'Remove filter Instance = old_node.2-a', `Remove filter Instance = ${'y'.repeat(64)}`]);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  // The names that nobody writes under are picked all the same. The list has them, ticked, with no request and no write to tell. They are after the instances that the server knows.
  // The button counts the picks.
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · 3 selected');
  const picked = await openPicker(page, 'instance');
  await expect(picked.locator('.mcpPicker__name')).toHaveText(['chdash-0', 'chdash-1', 'old_node.2-a', 'y'.repeat(64)]);
  await expect(picked.locator('.mcpPicker__count')).toHaveText(['918', '183', '0', '0']);
  await expect(picked.locator('.mcpPicker__meta')).toHaveText(['this instance · wrote 30 s ago', 'wrote 1 min ago', 'no write yet', 'no write yet']);
  await expect(picked.locator('input:checked')).toHaveCount(3);
  await page.keyboard.press('Escape');
  // A kind of filter takes 20 values. The 20 first of 25 stay.
  const many = Array.from({ length: 25 }, (_, i) => `node-${String(i).padStart(2, '0')}`);
  const other = newServer();
  await install(page, other);
  await page.goto(`/mcp-integration/usage?${many.map((name) => `instance=${name}`).join('&')}`);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(chips(page)).toHaveCount(20);
  expect(new URL(page.url()).searchParams.getAll('instance')).toEqual(many.slice(0, 20));
  expect(reads(other)).toEqual([`?window=7d&group=method${ORDERS}&${many.slice(0, 20).map((name) => `instance=${name}`).join('&')}`]);
  // The instance is a filter, not a group of the charts. The bar groups by key, method, client or result. `group=instance` is a group that the bar does not offer.
  // So it is dropped, and the filter stays.
  await page.goto('/mcp-integration/usage?group=instance&instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-1$/);
  await expect(groupButton(page)).toHaveText('Group by · Method');
  await expect(chips(page)).toHaveText(['Instance=chdash-1']);
  expect(reads(other).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=chdash-1`);
  // An address with nothing to fix is left as it was written.
  await page.goto('/mcp-integration/usage?instance=chdash-0&instance=chdash-1');
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?instance=chdash-0&instance=chdash-1$/);
  await expect(chips(page)).toHaveText(['Instance=chdash-0', 'Instance=chdash-1']);
});

test('an instance named with 64 characters ends in an ellipsis in its row, its button and its chip, with its whole name in their titles, and nothing grows or scrolls sideways', async ({ page }) => {
  // The longest name that a file can have is 64 characters of letters, digits, dot, hyphen and underscore.
  const name = `chdash-${'long_node.'.repeat(5)}abcdefg`;
  expect(name).toHaveLength(64);
  const server = newServer();
  server.instances = [{ instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'ok', reason: '' }, { instance: name, written_at: '2026-10-14T09:58:00Z', status: 'ok', reason: '' }];
  server.cells = [...CELLS().filter((c) => c.instance === 'chdash-0'), cell('ops-all', '2026-10-14T09:20', 'call', 'claude-code', 'list_hosts', 'ok', 7, 14, 3, 0, 700, name)];
  await open(page, '', server);
  const button = pickerButton(page, 'instance');
  const width = (await button.boundingBox()).width;
  const menu = await openPicker(page, 'instance');
  // The row: the name is cut by an ellipsis in its box. The row says the whole name in its title. The list does not scroll sideways.
  // The count and the line of the last write keep their places.
  const row = menu.locator('.mcpPicker__option', { has: page.locator(`input[value="${name}"]`) });
  await expect(row).toHaveAttribute('title', name);
  expect(await row.locator('.mcpPicker__name').evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow }))).toEqual({ cut: true, overflow: 'ellipsis' });
  expect(await menu.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  await expect(row.locator('.mcpPicker__count')).toHaveText('7');
  await expect(row.locator('.mcpPicker__meta')).toHaveText('wrote 2 min ago');
  // A pick: the button keeps its width. The width of a list does not depend on what it says. The button ends in an ellipsis with the name in its title.
  await row.locator('input').check();
  await expect(button).toHaveText(`Instance · ${name}`);
  await expect(button).toHaveAttribute('title', name);
  expect(Math.abs((await button.boundingBox()).width - width)).toBeLessThanOrEqual(0.5);
  expect(await button.locator('.tracePicker__label').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(chips(page)).toHaveCount(1);
  await drawnStates(page, server, 2);
  // The chip is a box of 28 rem at most. The name is cut inside it, and its remove button is in view. The title says the whole name.
  const chip = chips(page).first();
  await expect(chip).toHaveAttribute('title', `Instance = ${name}`);
  const box = await chip.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const remove = el.querySelector('.chip__remove').getBoundingClientRect();
    return { width: r.width, removeInside: remove.left >= r.left && remove.right <= r.right + 0.5, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
  expect(box.width).toBeLessThanOrEqual(28 * box.rem + 1);
  expect(box.removeInside).toBe(true);
  expect(await chips(page).first().locator('.chip__remove').getAttribute('aria-label')).toBe(`Remove filter Instance = ${name}`);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // The address and the read carry the name whole. The figures are the ones of its 7 requests.
  expect(new URL(page.url()).searchParams.get('instance')).toBe(name);
  expect(reads(server).at(-1)).toBe(`?window=7d&group=method${ORDERS}&instance=${name}`);
  expect(await tiles(page)).toMatchObject({ Requests: ['7', 'in the last 7 days'] });
});

// ---- the warnings about the files that are not read ----------------------------------------------------------------------------------------

test('a skipped file is a warning above the tiles, a notice that waits its turn; it comes from the answer, so no filter takes it away or draws it again', async ({ page }) => {
  const server = newServer();
  server.instances = filesOfStates(['ok', ''], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  // This is one box. It is amber (the level warn of the banner). It has a status and not an alert. It has the sentence and no "Why", because a skipped file has no more to say.
  await expect(warningsStates(page)).toHaveCount(1);
  await expect(warningsStates(page)).toHaveClass(/uiBanner--warn/);
  await expect(warningsStates(page)).toHaveAttribute('role', 'status');
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  await expect(warningsStates(page).locator('details')).toHaveCount(0);
  await expect(page.locator('.mcpOverview__warnings')).toBeVisible();
  // It is the first thing in the panel, over the tiles. The bar and the chips are over the panel, which is what scrolls.
  const stack = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    return { content: box('.mcpOverview__content').top, warning: [box('.mcpOverview__warnings').top, box('.mcpOverview__warnings').bottom], tiles: box('.mcpOverview__tiles').top, chips: box('.mcpOverview__filters').bottom };
  });
  expect(stack.warning[0]).toBeGreaterThanOrEqual(stack.chips - 0.5);
  expect(Math.abs(stack.warning[0] - stack.content)).toBeLessThanOrEqual(0.5);
  expect(stack.warning[1]).toBeLessThanOrEqual(stack.tiles + 0.5);
  // The Instance list says the same. The instance has the badge, with the sentence in its title. The instance that is read has none.
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveText('skipped');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveAttribute('title', 'chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The warning is the `instances` of the answer, which the filters do not cut. It is there after each change, and it is the same box.
  // A box that is drawn again does not have the mark.
  await warningsStates(page).evaluate((el) => { el.dataset.mark = 'first'; });
  await tickStates(page, 'key', 'ops-all');
  await expect(chips(page)).toHaveCount(1);
  await drawnStates(page, server, 2);
  await expect(warningsStates(page)).toHaveCount(1);
  await expect(warningsStates(page)).toHaveAttribute('data-mark', 'first');
  await tickStates(page, 'instance', 'chdash-0');
  await expect(chips(page)).toHaveCount(2);
  await drawnStates(page, server, 3);
  await expect(warningsStates(page)).toHaveAttribute('data-mark', 'first');
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('chdash-1: its file was skipped (invalid), so its counts are not in these figures.');
  // With the filter of the instance, the file that is left out stays listed in the list of the bar, with its badge.
  const again = await openPicker(page, 'instance');
  await expect(again.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveText('skipped');
});

test('a conflict is a warning of its own, with the reason of the server behind "Why", and its instance has the badge in the list', async ({ page }) => {
  const server = newServer();
  server.instances = filesOfStates(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'ok', '']]);
  await open(page, '', server);
  await expect(warningsStates(page)).toHaveCount(1);
  await expect(warningsStates(page)).toHaveClass(/uiBanner--warn/);
  await expect(warningsStates(page)).toHaveAttribute('role', 'status');
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).');
  // The reason is behind "Why". The box is closed at first. When it opens, it shows the sentence of the server.
  const why = warningsStates(page).locator('details');
  await expect(why.locator('summary')).toHaveText('Why');
  await expect(why).not.toHaveAttribute('open', /.*/);
  await expect(why.locator('.uiBanner__more')).toBeHidden();
  await why.locator('summary').click();
  await expect(why.locator('.uiBanner__more')).toBeVisible();
  await expect(why.locator('.uiBanner__more')).toHaveText('another process writes chdash-0.jsonl.zst');
  // The list has the badge on this instance. The sentence is in its title, because the reason of a conflict is too long for a word of the row.
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveText('conflict');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' }).locator('.badge')).toHaveAttribute('title', 'Another ChDash writes as chdash-0: this instance does not save its counts.');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-0' })).not.toContainText('another process');
  await expect(menu.locator('.mcpPicker__option', { hasText: 'chdash-1' }).locator('.badge')).toHaveCount(0);
  // A filter keeps the warning, open as it was. The box is not drawn again.
  await page.keyboard.press('Escape');
  await tickStates(page, 'key', 'ops-all');
  await expect(chips(page)).toHaveCount(1);
  await drawnStates(page, server, 2);
  await expect(why).toHaveAttribute('open', /.*/);
  await expect(why.locator('.uiBanner__more')).toBeVisible();
});

test('several skipped files are one sentence that names the first three, a conflict is another warning above it, and the Instance list marks each file', async ({ page }) => {
  const server = newServer();
  server.instances = filesOfStates(['ok', ''], [
    ['chdash-1', 'ok', ''], ['chdash-2', 'skipped', 'invalid'], ['chdash-3', 'skipped', 'too_large'], ['chdash-4', 'skipped', 'invalid'],
    ['chdash-5', 'skipped', 'too_large'], ['chdash-6', 'skipped', 'invalid'],
  ]);
  await open(page, '', server);
  await expect(pickerButton(page, 'instance')).toHaveText('Instance · All (7)');
  await expect(warningsStates(page)).toHaveCount(1);
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('5 instance files were skipped, so their counts are not in these figures: chdash-2 (invalid), chdash-3 (too large), chdash-4 (invalid) and 2 more.');
  // The list has each of the seven. It has a badge on each of the five that are left out. The reason of each is in the title of its badge.
  const menu = await openPicker(page, 'instance');
  await expect(menu.locator('.mcpPicker__option')).toHaveCount(7);
  await expect(menu.locator('.badge')).toHaveText(['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  expect(await menu.locator('.badge').evaluateAll((els) => els.map((el) => el.title))).toEqual([
    'chdash-2: its file was skipped (invalid), so its counts are not in these figures.',
    'chdash-3: its file was skipped (too large), so its counts are not in these figures.',
    'chdash-4: its file was skipped (invalid), so its counts are not in these figures.',
    'chdash-5: its file was skipped (too large), so its counts are not in these figures.',
    'chdash-6: its file was skipped (invalid), so its counts are not in these figures.',
  ]);
  await page.keyboard.press('Escape');
  // Two skipped files make the plural of two. A conflict is its own warning, and it comes first.
  const some = newServer();
  some.instances = filesOfStates(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'ok', ''], ['chdash-2', 'skipped', 'invalid'], ['chdash-3', 'skipped', 'too_large']]);
  await open(page, '', some);
  await expect(warningsStates(page)).toHaveCount(2);
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText([
    'Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).',
    '2 instance files were skipped, so their counts are not in these figures: chdash-2 (invalid), chdash-3 (too large).',
  ]);
  // A skipped file that has no reason says only that it was skipped.
  const plain = newServer();
  plain.instances = filesOfStates(['ok', ''], [['chdash-1', 'skipped', '']]);
  await open(page, '', plain);
  await expect(warningsStates(page).locator('.uiBanner__text')).toHaveText('chdash-1: its file was skipped, so its counts are not in these figures.');
});

test('a warning moves nothing when a filter changes: the tiles and the cards stand where they stood, while the read runs and once it is drawn', async ({ page }) => {
  // A conflict and a skipped file are two boxes above the tiles, from the first answer to the last. They are in the `instances` of the answer, so a filter neither shows nor hides them.
  // The walk through the five ways to change a filter finds everything where it was.
  const server = newServer();
  server.instances = filesOfStates(['conflict', 'another process writes chdash-0.jsonl.zst'], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  await expect(warningsStates(page)).toHaveCount(2);
  await warningsStates(page).evaluateAll((els) => els.forEach((el, i) => { el.dataset.mark = String(i); }));
  const base = await layout(page);
  // The tiles stand under the two boxes. They are lower than with no warning, by their height and their gap.
  const box = await page.locator('.mcpOverview__warnings').evaluate((el) => el.getBoundingClientRect().height);
  expect(box).toBeGreaterThan(40);
  await walkFilters(page, server, base, async () => {
    // The boxes are drawn for each step. Each time, the same two boxes appear, in the same place.
    await expect(warningsStates(page)).toHaveCount(2);
    await expect(warningsStates(page).first()).toHaveAttribute('data-mark', '0');
    await expect(warningsStates(page).last()).toHaveAttribute('data-mark', '1');
    expect(await page.locator('.mcpOverview__warnings').evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(box, 0);
  });
});

// ---- accessibility and themes --------------------------------------------------------------------------------------------------------------
// This is the shared accessibility contract (axe) on the fake server. Any instance can run it. The checks cover the bar, its lists open (the Instance list with its badges too), the chips, and the legends in both modes.
// They also cover a view with lists that are disabled, and the warnings about the instances.
// They cover the folded bar of a phone, and the "Usage is off" state, in both themes.
// The a11y-contract.spec.js file runs the same checks on the real server.
const axeViolationsStates = (page) => new AxeBuilder({ page }).analyze().then((result) => result.violations.map((v) => ({ id: v.id, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })));

for (const theme of ['dark', 'light']) {
  test(`axe (${theme}): the bar, its lists open, the chips and the six charts with their legends, in the list and in the Values mode, have no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    await open(page, '?key=ops-all&client=claude-code');
    await page.waitForTimeout(1200);
    expect(await axeViolationsStates(page)).toEqual([]);
    for (const dimension of ['key', 'method', 'client', 'result', 'instance']) {
      await openPicker(page, dimension);
      await page.waitForTimeout(300);
      expect(await axeViolationsStates(page), `the ${dimension} list`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(pickerMenu(page, dimension)).toBeHidden();
    }
    await groupButton(page).click();
    await expect(groupOption(page, 'result')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'Group by').toEqual([]);
    await page.keyboard.press('Escape');
    // The Values mode of the six legends: a table for each chart. Each table has its figures, its scopes, and its button that says List.
    await modeButton(page).click();
    await expect(legendTable(page, 'bytes')).toBeVisible();
    await expect(modeButton(page, 'bytes')).toHaveText('List');
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'the Values tables').toEqual([]);
    // A legend entry is pressed (a chip is made) in the table. This case also groups by result, with its codes.
    await entry(page, 'method:query_table', 'errors').click();
    await expect(chips(page)).toHaveCount(3);
    await settled(page);
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'a pressed entry in a table').toEqual([]);
    await pickGroup(page, 'result');
    await settled(page);
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'grouped by result').toEqual([]);
  });

  test(`axe (${theme}): a view with lists that are off, and locked legend entries, has no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    // ping has one key and one client. Their lists are disabled, dimmed, with a title that says why. Grouped by client, it has one locked legend entry.
    await open(page, '?method=ping&group=client');
    await expect(pickerButton(page, 'key')).toBeDisabled();
    await expect(pickerButton(page, 'client')).toBeDisabled();
    await expect(entry(page, 'client:claude-code')).toBeDisabled();
    await page.waitForTimeout(1200);
    expect(await axeViolationsStates(page), 'lists that are off').toEqual([]);
    // The one list that has a choice still opens: the list of the instances, with the check boxes. Both of them are known.
    await openPicker(page, 'instance');
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'the list that is on, beside the ones that are off').toEqual([]);
  });

  test(`axe (${theme}): the warnings about the instances (a skipped file and a conflict) and the Instance list with its badges have no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    const server = newServer();
    server.instances = [
      { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'conflict', reason: 'another process writes chdash-0.jsonl.zst' },
      { instance: 'chdash-1', written_at: '2026-10-14T09:58:50Z', status: 'skipped', reason: 'invalid' },
      { instance: 'chdash-2', written_at: null, status: 'ok', reason: '' },
    ];
    await open(page, '', server);
    // A conflict (its reason is behind "Why") and a skipped file are two boxes above the tiles. They are amber, in a live region that waits its turn.
    await expect(page.locator('.mcpOverview__warnings .uiBanner--warn')).toHaveCount(2);
    await page.locator('.mcpOverview__warnings summary').click();
    await page.waitForTimeout(1200);
    expect(await axeViolationsStates(page), 'the warnings').toEqual([]);
    // The list of the bar shows the same files. Each has its badge (conflict or skipped), its last write, and "no write yet" for the third.
    await openPicker(page, 'instance');
    await expect(pickerMenu(page, 'instance').locator('.badge')).toHaveText(['conflict', 'skipped']);
    await expect(pickerMenu(page, 'instance').locator('.mcpPicker__meta')).toHaveText(['this instance · wrote 30 s ago', 'wrote 1 min ago', 'no write yet']);
    await page.waitForTimeout(300);
    expect(await axeViolationsStates(page), 'the Instance list with its badges').toEqual([]);
    // A row is picked: the check box, the chip and the warnings all change together.
    await pickerBox(page, 'instance', 'chdash-1').check();
    await page.keyboard.press('Escape');
    await expect(chips(page)).toHaveCount(1);
    await settled(page);
    await page.waitForTimeout(600);
    expect(await axeViolationsStates(page), 'a row picked').toEqual([]);
  });

  test(`axe (${theme}): the "Usage is off" state has no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    const server = newServer();
    setUsage(server, { enabled: false });
    await install(page, server);
    await page.goto('/mcp-integration/usage');
    await expect(page.locator('#mcpUsageOff')).toBeVisible();
    await page.waitForTimeout(1200);
    expect(await axeViolationsStates(page)).toEqual([]);
  });

  test(`axe (${theme}): the bar of a phone, folded and unfolded, with its lists open, has no violation`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '?key=ops-all&instance=chdash-1');
    const summary = page.locator('#mcpBar .obsFilterSummary');
    await expect(summary).toHaveText('Last 7 days · by method · 2 filters');
    await page.waitForTimeout(1200);
    expect(await axeViolationsStates(page), 'folded').toEqual([]);
    await summary.click();
    await expect(summary).toHaveText('Hide the filters');
    await page.waitForTimeout(400);
    expect(await axeViolationsStates(page), 'unfolded').toEqual([]);
    for (const dimension of ['result', 'instance']) {
      await openPicker(page, dimension);
      await page.waitForTimeout(300);
      expect(await axeViolationsStates(page), `the ${dimension} list on a phone`).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(pickerMenu(page, dimension)).toBeHidden();
    }
  });
}

test('both themes: the bar, the lists, the chips row, the period, the warnings, the charts and the tiles read in the light theme and in the dark one', async ({ page }) => {
  const server = newServer();
  server.instances = filesOfStates(['ok', ''], [['chdash-1', 'skipped', 'invalid']]);
  await open(page, '', server);
  const seen = {};
  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, theme);
    await page.evaluate(() => document.querySelectorAll('.mcpOverview__chart').forEach((el) => window.ChDash.chartCore.of(el)?.themeChanged()));
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const colours = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      // This is what a token of the design system is in this theme, as the browser computes it.
      const token = (name, property = 'color') => {
        const probe = document.createElement('i');
        document.body.appendChild(probe);
        probe.style[property] = `var(${name})`;
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      return {
        page: css('.mcpWorkspace', 'backgroundColor'), value: css('.statTile__value', 'color'),
        legend: css('.chartCore__legendItem', 'color'), picker: css('#mcpPickerButton-key', 'color'), pickerFill: css('#mcpPickerButton-key', 'backgroundColor'),
        windowOn: css('.mcpBar__windows [aria-pressed="true"]', 'backgroundColor'), windowOff: css('.mcpBar__windows [aria-pressed="false"]', 'backgroundColor'),
        // The hint of the chips row and the period are muted. The warning has the warning tint and the text colour.
        hint: css('.mcpOverview__filtersHint', 'color'), period: css('.mcpOverview__period', 'color'), muted: token('--muted'),
        warning: css('.mcpOverview__warnings .uiBanner--warn', 'backgroundColor'), warningFill: token('--warning-bg', 'backgroundColor'),
        warningText: css('.mcpOverview__warnings .uiBanner--warn', 'color'), text: token('--text'),
      };
    });
    expect(colours.value).not.toBe(colours.page);
    expect(colours.legend).not.toBe(colours.page);
    expect(colours.picker).not.toBe(colours.pickerFill);
    // The pressed window has the selected look. The others have none.
    expect(colours.windowOn).not.toBe(colours.windowOff);
    expect(colours.hint, 'the hint is muted').toBe(colours.muted);
    expect(colours.period, 'the period is muted').toBe(colours.muted);
    expect(colours.warning, 'the warning has the warning tint').toBe(colours.warningFill);
    expect(colours.warningText, 'the warning has the text colour').toBe(colours.text);
    expect(colours.muted).not.toBe(colours.text);
    seen[theme] = colours;
    await screenshot(page, `usage-${theme}`);
    // The Instance list: its names read, its counts and its last-write lines are muted. The badge of a file that is not read is there.
    const menu = await openPicker(page, 'instance');
    await expect(menu.locator('.mcpPicker__option')).toHaveCount(2);
    const open = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      const probe = document.createElement('i');
      document.body.appendChild(probe);
      probe.style.color = 'var(--muted)';
      const muted = getComputedStyle(probe).color;
      probe.remove();
      return {
        menu: css('#mcpPickerMenu-instance', 'backgroundColor'), name: css('#mcpPickerMenu-instance .mcpPicker__name', 'color'), count: css('#mcpPickerMenu-instance .mcpPicker__count', 'color'),
        meta: css('#mcpPickerMenu-instance .mcpPicker__meta', 'color'), muted, badge: css('#mcpPickerMenu-instance .badge', 'backgroundColor'),
      };
    });
    expect(open.name).not.toBe(open.menu);
    expect(open.count, 'the count is muted').toBe(open.muted);
    expect(open.meta, 'the line of the last write is muted').toBe(open.muted);
    expect(open.badge).not.toBe(open.menu);
    await screenshot(page, `usage-${theme}-picker`);
    await page.keyboard.press('Escape');
  }
  // The theme took effect. What the page paints is not the same in the two themes.
  expect(seen.dark.page).not.toBe(seen.light.page);
  expect(seen.dark.value).not.toBe(seen.light.value);
  expect(seen.dark.muted).not.toBe(seen.light.muted);
});

test('the tab is built for a screen reader: labelled regions, headings that never skip a level, charts and legends with their states, a scope on every header of the Values tables', async ({ page }) => {
  await open(page);
  await expect(page.locator('nav.mcpPage__nav')).toHaveCount(1);
  await expect(page.locator('nav.mcpPage__nav')).toHaveAttribute('aria-label', 'MCP sections');
  // The headings are these: the page (h1) and the part (h2), which are for screen readers only, and the six charts (h3). No level is skipped.
  const headings = await page.evaluate(() => [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => [Number(el.tagName[1]), el.textContent, el.classList.contains('srOnly')]));
  expect(headings.map(([level]) => level)).toEqual([1, 2, 3, 3, 3, 3, 3, 3]);
  expect(headings.map(([, text]) => text)).toEqual(['MCP usage', 'Usage of all keys', 'Requests by method', 'Errors by method', 'Error rate by method', 'Refused by method', 'Call time by method', 'Returned by method']);
  expect(headings.slice(0, 2).map(([, , hidden]) => hidden)).toEqual([true, true]);
  expect(headings.slice(1).every(([level], i) => level <= headings[i][0] + 1)).toBe(true);
  // The part is named by its heading. The other containers have their names.
  await expect(page.locator('section.pagePart')).toHaveAttribute('aria-labelledby', 'mcpOverviewTitle');
  await expect(page.locator('#mcpOverviewTitle')).toHaveText('Usage of all keys');
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('role', 'list');
  await expect(page.locator('.mcpOverview__chips')).toHaveAttribute('aria-label', 'Active filters');
  await expect(page.locator('.mcpOverview__tiles')).toHaveAttribute('aria-label', 'Totals');
  await expect(page.locator('.mcpBar__windows')).toHaveAttribute('aria-label', 'Window');
  // The tab has no table. The figures are in the tiles and the legends. A table is the Values mode of a legend (see below).
  await expect(page.locator('.mcpOverview table')).toHaveCount(0);
  // The six charts are sections. Each is named by its title, and the titles are headings under the one of the tab. Each chart is a group named for what it draws.
  await expect(page.locator('.mcpOverview__card')).toHaveCount(6);
  for (const id of CHARTS) {
    const heading = card(page, id).locator('h3.chartCard__title');
    await expect(card(page, id)).toHaveAttribute('aria-labelledby', await heading.getAttribute('id'));
    await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('role', 'group');
    await expect(chartBox(page, id).locator('.chartCore')).toHaveAttribute('aria-label', `${(await heading.textContent())} over time`);
    await expect(chartBox(page, id).locator('.chartCore__legend')).toHaveAttribute('aria-label', 'Series');
  }
  // Every legend entry is a button with its state. The entry of the folded groups is disabled.
  expect(await legend(page).evaluateAll((items) => items.map((item) => item.tagName + item.getAttribute('aria-pressed')))).toEqual(Array(8).fill('BUTTONfalse').concat(['BUTTONnull']));
  // The lists of the bar are dialogs of check boxes. Each is named by its label. The field that narrows them has a name.
  // The count of a value is in the name of its check box.
  const menu = await openPicker(page, 'method');
  await expect(menu).toHaveAttribute('aria-label', 'Method filter');
  await expect(menu.getByRole('checkbox', { name: /^query_table 754$/ })).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Method' })).toBeVisible();
  await page.keyboard.press('Escape');
  // In the Values mode, the button says what it does and is pressed. Each legend is a table with a name, a scope on every header, and a header on every row. The row header is the button of its series.
  // The call time and the rate of the errors have no Total. They are averages, and averages do not add up.
  const mode = modeButton(page, 'requests');
  await expect(mode).toHaveText('Values');
  await expect(mode).toHaveAttribute('aria-pressed', 'false');
  await expect(mode).toHaveAttribute('title', 'Show total / min / max / mean / last per series');
  await mode.click();
  await expect(mode).toHaveText('List');
  await expect(mode).toHaveAttribute('aria-pressed', 'true');
  await expect(mode).toHaveAttribute('title', 'Show the legend as a list');
  const heads = [];
  for (const id of CHARTS) {
    const table = legendTable(page, id);
    await expect(table, id).toHaveAttribute('aria-label', 'Values of the series');
    const shape = await table.evaluate((el) => ({
      heads: [...el.querySelectorAll('thead th')].map((th) => [th.textContent, th.getAttribute('scope')]),
      rows: [...el.querySelectorAll('tbody tr')].every((tr) => tr.firstElementChild.matches('th[scope="row"]') && tr.firstElementChild.querySelector('button.chartCore__legendItem') !== null),
      cells: [...el.querySelectorAll('tbody tr')].every((tr) => tr.children.length === el.querySelectorAll('thead th').length),
    }));
    expect(shape.heads.every(([, scope]) => scope === 'col'), id).toBe(true);
    expect(shape.rows, id).toBe(true);
    expect(shape.cells, id).toBe(true);
    heads.push(shape.heads.map(([text]) => text));
  }
  expect(heads).toEqual([
    ['Series', 'Total', 'Min', 'Max', 'Mean', 'Last'], ['Series', 'Total', 'Min', 'Max', 'Mean', 'Last'], ['Series', 'Min', 'Max', 'Mean', 'Last'],
    ['Series', 'Total', 'Min', 'Max', 'Mean', 'Last'], ['Series', 'Min', 'Max', 'Mean', 'Last'], ['Series', 'Total', 'Min', 'Max', 'Mean', 'Last'],
  ]);
  // The six charts change together: there is one mode for the page.
  for (const id of CHARTS) await expect(modeButton(page, id)).toHaveText('List');
});

test('a change is said once in the live region of the page, with what it found; the next read says it again, and a failure is the alert of its own', async ({ page }) => {
  const server = await open(page);
  const live = page.locator('#uiLiveStatus');
  // The first answer is not announced, because the reader has just opened the page. There is no region yet.
  // The warnings and the states are not live regions of their own. They are "status" and "alert" boxes, so the page has one region.
  await expect(live).toHaveCount(0);
  await tickStates(page, 'key', 'ops-all');
  await expect(live).toHaveText('1,012 requests in the last 7 days with these filters.');
  expect(await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((el) => el.id))).toEqual(['uiLiveStatus']);
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  // The filters leave the sentence with no "with these filters" part. A window says its own words.
  await page.getByRole('button', { name: 'Remove filter Key = ops-all' }).click();
  await expect(live).toHaveText('1,101 requests in the last 7 days.');
  await windowButton(page, '24 h').click();
  await expect(live).toHaveText('750 requests in the last 24 hours.');
  // A read that changes nothing is said again. The region is cleared, and it is written again on the next frame, so a reader hears it.
  await live.evaluate((el) => { el.textContent = 'stale'; });
  await page.locator('#mcpRefresh').click();
  await expect(live).toHaveText('750 requests in the last 24 hours.');
  // One request is not "1 requests", and none is "0 requests". This applies with the filters that the page has.
  server.cells = [cell('ops-all', '2026-10-14T09:30', 'call', 'claude-code', 'list_hosts', 'ok', 1, 4, 4, 0, 100)];
  await page.locator('#mcpRefresh').click();
  await expect(live).toHaveText('1 request in the last 24 hours.');
  server.cells = [];
  await page.locator('#mcpRefresh').click();
  await expect(live).toHaveText('0 requests in the last 24 hours.');
  // A read that fails has no figure to announce. The region keeps its words. The error is an alert, and it says so by itself.
  server.errors['GET /usage/overview'] = { status: 500, body: { error_code: 'internal_error', message: 'The usage could not be read.', retryable: false } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('.mcpOverview__state .uiState--error')).toHaveAttribute('role', 'alert');
  await expect(live).toHaveText('0 requests in the last 24 hours.');
});

test('the keyboard goes through the bar in the order of the screen: Group by, the five lists, the windows, Refresh, then the chips, Clear filters and the first chart', async ({ page }) => {
  // There are two filters, so that "Clear filters" is there. The key and the result leave two clients, so every list of the bar is on.
  await open(page, '?key=ops-all&result=ok');
  // This is what has the keyboard focus: the id of a control, or else its name.
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return el.id || el.getAttribute('aria-label') || el.textContent.trim();
  });
  await groupButton(page).focus();
  const order = [await focused()];
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press('Tab');
    order.push(await focused());
  }
  // The bar is the first thing on the page after its row of tabs. The chips row follows the bar, and the charts come after them.
  // The cursor of the first chart is the next stop. Its keys are in its name.
  expect(order.slice(0, 16)).toEqual([
    'mcpGroupButton', 'mcpPickerButton-key', 'mcpPickerButton-method', 'mcpPickerButton-client', 'mcpPickerButton-result', 'mcpPickerButton-instance',
    '1 h', '6 h', '24 h', '7 d', '30 d', '90 d', 'mcpRefresh', 'Remove filter Key = ops-all', 'Remove filter Result = ok', 'Clear filters',
  ]);
  expect(order[16]).toMatch(/^Chart cursor: Left \/ Right move it/);
  // Back: Shift+Tab walks the same stops in the other direction.
  for (const expected of ['Clear filters', 'Remove filter Result = ok', 'Remove filter Key = ops-all', 'mcpRefresh', '90 d']) {
    await page.keyboard.press('Shift+Tab');
    expect(await focused()).toBe(expected);
  }
  // A list that is disabled is no stop either way. Ping has one key, one client and one result. The stops are Group by, Method, Instance and the windows.
  await open(page, '?method=ping');
  for (const dimension of ['key', 'client', 'result']) await expect(pickerButton(page, dimension)).toBeDisabled();
  await groupButton(page).focus();
  const stops = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await focused());
  }
  expect(stops).toEqual(['mcpPickerButton-method', 'mcpPickerButton-instance', '1 h', '6 h']);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('mcpPickerButton-instance');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('mcpPickerButton-method');
  await page.keyboard.press('Shift+Tab');
  expect(await focused()).toBe('mcpGroupButton');
});

test('the first read shows its loading state in the place of the figures, under a bar that is already there, and the answer replaces it; the state of MCP has its own', async ({ page }) => {
  const server = newServer();
  server.delay['GET /meta'] = 900;
  server.delay['GET /usage/overview'] = 1200;
  await install(page, server);
  await page.goto('/mcp-integration/usage');
  // The meta comes first: a status in the state box of the page, and nothing of the tab yet. The bar is made when the usage is known to be on.
  const meta = page.locator('#mcpState .uiState--loading');
  await expect(meta).toBeVisible();
  await expect(meta).toHaveAttribute('role', 'status');
  await expect(meta).toContainText('Loading the MCP state');
  await expect(page.locator('#mcpBar')).toHaveCount(0);
  await expect(page.locator('#mcpTabs a')).toHaveText(['Keys', 'Usage']);
  // Then the usage: the bar, the window and the chips row are there. The state is the reading of the usage. The figures are not.
  const loading = page.locator('.mcpOverview__state .uiState--loading');
  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute('role', 'status');
  await expect(loading).toContainText('Reading the usage of the keys');
  await expect(page.locator('.mcpOverview__content')).toBeHidden();
  await expect(page.locator('#mcpBar')).toBeVisible();
  await expect(page.locator('.mcpOverview__filtersHint')).toBeVisible();
  await expect(pressedWindow(page)).toHaveText('7 d');
  await expect(page.locator('#mcpRefresh')).toBeDisabled();
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(loading).toBeHidden();
  await expect(page.locator('.mcpOverview__state')).toBeHidden();
  await expect(page.locator('#mcpRefresh')).toBeEnabled();
  await expect(period(page)).toHaveText('Oct 7 12:00 → Oct 14 10:00');
});
