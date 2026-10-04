import { test, expect } from '@playwright/test';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';
import { nestedTrace, routeTrace } from '../helpers/trace-mocks.js';

// Navigation and choice controls, one component each (docs/ui-foundations.md
// "Components"): tabs (ns.tabs: one underline row, .contentTabs, and
// .contentTabs--nav in a nav row),
// segmented controls (ns.segmented) and menus (ns.menu). Every page that uses
// them, both themes, desktop and a 390 px phone.

const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() || '');
const focusedId = (page) => page.evaluate(() => document.activeElement?.id || '');

// A tab row: role, one selected tab that is the only Tab stop, and the keys.
async function expectTabRow(page, list, { nav = false } = {}) {
  await expect(list).toHaveAttribute('role', 'tablist');
  const tabs = list.locator('[role="tab"]:visible');
  const count = await tabs.count();
  expect(count).toBeGreaterThan(1);
  await expect(list.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
  const stops = await list.locator('[role="tab"]').evaluateAll((els) => els.filter((el) => el.tabIndex === 0).length);
  expect(stops).toBe(1);
  await expect(tabs.first()).toHaveClass(/\bcontentTabs__tab\b/);
  await expect(list).toHaveClass(/\bcontentTabs\b/);
  if (nav) await expect(list).toHaveClass(/\bcontentTabs--nav\b/);
  return tabs;
}

async function arrowThrough(page, list) {
  const selected = list.locator('[role="tab"][aria-selected="true"]');
  await selected.focus();
  const start = await selected.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(list.locator('[role="tab"][aria-selected="true"]')).not.toHaveText(start);
  // The selected tab keeps the focus (even when its row rebuilds).
  const handle = await list.elementHandle();
  await expect.poll(() => page.evaluate((el) => el.contains(document.activeElement) && document.activeElement.getAttribute('aria-selected'), handle)).toBe('true');
  await page.keyboard.press('End');
  const last = (await list.locator('[role="tab"]:visible').last().textContent()).trim();
  await expect.poll(() => focusedText(page)).toBe(last);
  await expect(list.locator('[role="tab"][aria-selected="true"]')).toHaveText(last);
  await page.keyboard.press('Home');
  const first = (await list.locator('[role="tab"]:visible').first().textContent()).trim();
  await expect.poll(() => focusedText(page)).toBe(first);
  await expect(list.locator('[role="tab"][aria-selected="true"]')).toHaveText(first);
}

for (const scheme of ['dark', 'light']) {
  test.describe(`ui components (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('tabs: the Explorer view and card rows are tier 1 / tier 2 rows with one keyboard; the Catalog modes are a segmented control', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      await expectTabRow(page, page.locator('#explorerViewTabs'), { nav: true });
      // Segmented = modes (aria-pressed toggles), underline = sections.
      await expect(page.locator('#explorerModeTabs')).toHaveAttribute('role', 'group');
      await expect(page.locator('#explorerModeTabs')).toHaveClass(/\bsegmented\b/);
      // Browse | Graph: Storage is a card tab, not a mode.
      await expect(page.locator('#explorerModeTabs .segmented__option')).toHaveCount(2);
      const card = page.locator('#explorerDetailTabs');
      await expectTabRow(page, card, {});
      // The card row is underlined (tier 2), not an outlined box.
      const look = await card.locator('[aria-selected="true"]').evaluate((el) => {
        const s = getComputedStyle(el);
        return { bottom: s.borderBottomWidth, left: s.borderLeftWidth, radius: s.borderTopLeftRadius };
      });
      expect(look).toEqual({ bottom: '2px', left: '0px', radius: '0px' });
      await arrowThrough(page, card);
      await expect(page).toHaveURL(/\/weather_observations$/);
      // The modes: Enter on Graph presses it and shows it.
      await page.locator('#explorerModeGraph').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#explorerModeGraph')).toBeFocused();
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
    });

    test('tabs: the Observability views and Traces sub-tabs, the trace views and the log record tabs', async ({ page }) => {
      await page.goto('/observability/traces');
      await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
      await expectTabRow(page, page.locator('#obsTabs'), { nav: true });
      const sub = page.locator('#tracesTabs');
      await expectTabRow(page, sub, { nav: true });
      await sub.locator('[data-trace-tab="search"]').focus();
      await page.keyboard.press('ArrowRight');
      await expect(sub.locator('[data-trace-tab="services"]')).toHaveAttribute('aria-selected', 'true');
      await expect(sub.locator('[data-trace-tab="services"]')).toBeFocused();
      await page.keyboard.press('Home');
      await expect(sub.locator('[data-trace-tab="search"]')).toBeFocused();
      // The view row: Right opens Logs and keeps the focus on its tab.
      await page.locator('#obsTab-traces').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#obsTab-logs')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#obsTab-logs')).toBeFocused();
      await expect(page).toHaveURL(/\/observability\/logs/);
      await expectTabRow(page, page.locator('.logsTabs'), {});

      const trace = nestedTrace();
      await routeTrace(page, trace);
      await page.goto(`/observability/traces/${trace.trace_id}`);
      await expect(page.locator('#traceViewTabs')).toBeVisible({ timeout: 15_000 });
      await expectTabRow(page, page.locator('#traceViewTabs'), {});
    });

    test('tabs: the profiling and library dialog rows are tier 2 rows', async ({ page }) => {
      await openApp(page);
      await page.locator('#queryLibraryButton').click();
      const tabs = page.locator('#queryLibraryMenu [role="tablist"]');
      await expect(tabs).toBeVisible();
      await expectTabRow(page, tabs, {});
      await tabs.locator('[aria-selected="true"]').focus();
      await page.keyboard.press('End');
      await expect(page.locator('#queryLibraryTabHistory')).toBeFocused();
      await expect(page.locator('#queryLibraryTabHistory')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(page.locator('#queryLibraryTabSaved')).toHaveAttribute('aria-selected', 'true');
    });

    test('segmented: groups of pressed buttons, 28 / 24 px, the active token', async ({ page }) => {
      await page.goto('/observability/traces');
      await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
      const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--seg-active-bg').trim());
      expect(token).toMatch(scheme === 'dark' ? /^rgba\(53, 111, 230, 0\.22\)$/ : /^rgba\(37, 88, 217, 0\.12\)$/);
      expect(token.endsWith(scheme === 'dark' ? '0.22)' : '0.12)')).toBe(true);
      for (const [selector, height] of [['.traceModeToggle', 28], ['.traceResultsViewToggle', 28], ['.traceDurationViews', 24]]) {
        const group = page.locator(selector);
        await expect(group).toHaveAttribute('role', 'group');
        await expect(group).toHaveClass(/\bsegmented\b/);
        const box = await group.boundingBox();
        expect(Math.round(box.height)).toBe(height);
        const pressed = group.locator('[aria-pressed="true"]');
        await expect(pressed).toHaveCount(1);
        const bg = await pressed.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg.replace(/\s/g, '')).toBe(token.replace(/\s/g, ''));
      }
      // A click presses the option and switches the view.
      await page.locator('[data-results-view="table"]').click();
      await expect(page.locator('[data-results-view="table"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-results-view="list"]')).toHaveAttribute('aria-pressed', 'false');
      await page.locator('[data-results-view="list"]').click();

      // Lineage | Tiers in the Explorer graph is a segmented control.
      await page.goto('/explorer?mode=graph&graph=lineage&depth=1');
      const type = page.locator('#explorerGraphTypeSelect');
      await expect(type).toBeVisible({ timeout: 15_000 });
      await expect(type).toHaveAttribute('role', 'group');
      await expect(page.locator('#explorerGraphLogicalButton')).toHaveAttribute('aria-pressed', 'true');
      expect(Math.round((await type.boundingBox()).height)).toBe(24);
      await page.locator('#explorerGraphPhysicalButton').click();
      await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#explorerGraphLogicalButton')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.explorerGraphDepthControls__name')).toHaveCount(1);
    });

    test('menus: keys, type-ahead, Escape, focus return and one open at a time (header)', async ({ page }) => {
      await openApp(page);
      const theme = page.locator('#themeSelectButton');
      // Keyboard open: the selected option takes the focus, or the first
      // shown one (these menus leave the current choice out of the list).
      await theme.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#themeSelectMenu')).toBeVisible();
      await expect(theme).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#themeSelectMenu [role="option"]:visible').first()).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.locator('#themeSelectMenu [role="option"]:visible').last()).toBeFocused();
      await page.keyboard.press('Home');
      await expect(page.locator('#themeSelectMenu [role="option"]:visible').first()).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('#themeSelectMenu [role="option"]:visible').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#themeSelectMenu')).toBeHidden();
      await expect(theme).toBeFocused();
      await expect(theme).toHaveAttribute('aria-expanded', 'false');

      // Down on the button opens on the first item; type-ahead jumps.
      const pageButton = page.locator('#pageSelectButton');
      await pageButton.focus();
      await page.keyboard.press('ArrowDown');
      const pages = page.locator('#pageSelectMenu [role="option"]:visible');
      await expect(pages.first()).toBeFocused();
      const lastPage = (await pages.last().textContent()).trim();
      await page.keyboard.press(lastPage[0].toLowerCase());
      await expect(pages.last()).toBeFocused();
      // Tab closes it.
      await page.keyboard.press('Tab');
      await expect(page.locator('#pageSelectMenu')).toBeHidden();

      // One menu at a time; a click outside closes the open one.
      await theme.click();
      await expect(page.locator('#themeSelectMenu')).toBeVisible();
      await page.locator('#runSettingsButton').click();
      await expect(page.locator('#runSettingsMenu')).toBeVisible();
      await expect(page.locator('#themeSelectMenu')).toBeHidden();
      // A settings item keeps the menu open; a click outside closes it.
      await page.locator('#runOptAutoFormat').click();
      await expect(page.locator('#runSettingsMenu')).toBeVisible();
      await page.locator('#runOptAutoFormat').click();
      await page.locator('#queryTextArea').click();
      await expect(page.locator('#runSettingsMenu')).toBeHidden();

      // A split button: the toggle opens the menu on its first enabled item.
      await page.locator('#queryTextArea').fill('SELECT 1');
      await page.locator('#runMenuButton').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#runMenu')).toBeVisible();
      await expect(page.locator('#runMenu [role="menuitem"]:not(:disabled)').first()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('#runMenuButton')).toBeFocused();
    });

    test('menus: Observability pickers keep the label inside and the native select out of the tab order', async ({ page }) => {
      await page.goto('/observability/traces');
      await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
      for (const id of ['tracesStatus', 'tracesLimit', 'tracesSort']) {
        const select = page.locator(`#${id}`);
        await expect(select).toHaveAttribute('tabindex', '-1');
        await expect(select).toHaveAttribute('aria-hidden', 'true');
      }
      await expect(page.locator('.traceResultsSort .tracePicker__button')).toHaveText('Sort · Most Recent');
      await expect(page.locator('.traceResultsSort')).not.toContainText('Sort:');
      const sort = page.locator('.traceResultsSort .tracePicker__button');
      await sort.focus();
      await page.keyboard.press('Enter');
      const list = page.locator('.traceResultsSort .tracePicker__menu');
      await expect(list).toBeVisible();
      await expect(list.locator('[role="option"]:visible').first()).toBeFocused();
      const second = (await list.locator('[role="option"]:visible').nth(1).getAttribute('data-value'));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(list).toBeHidden();
      await expect(page.locator('#tracesSort')).toHaveValue(second);
      await expect(sort).toHaveText(/^Sort · /);
      await expect(sort).toBeFocused();

      // Logs: the multi-select service picker stays open on each pick.
      await page.goto('/observability/logs');
      await expect(page.locator('#logsForm')).toBeVisible({ timeout: 15_000 });
      await page.locator('#logsServiceButton').click();
      await expect(page.locator('#logsServiceMenu')).toBeVisible();
      await expect(page.locator('#logsServiceMenu')).toHaveAttribute('aria-multiselectable', 'true');
      await page.keyboard.press('Escape');
      await expect(page.locator('#logsServiceMenu')).toBeHidden();
      await expect(page.locator('#logsServiceButton')).toBeFocused();

      // Metrics: the time range panel opens and closes through the same layer.
      await page.goto('/observability/metrics');
      const range = page.locator('#metricsWorkspace .tracePicker--range .tracePicker__button');
      await expect(range).toBeVisible({ timeout: 15_000 });
      await range.click();
      await expect(range).toHaveAttribute('aria-expanded', 'true');
      await page.locator('#metricsCatalog').click({ position: { x: 5, y: 5 }, force: true });
      await expect(range).toHaveAttribute('aria-expanded', 'false');
    });

    test('menus: the Query chart pickers and the row context menu in the results', async ({ page }) => {
      await openApp(page);
      await runSuccessfulQuery(page, 'SELECT number AS n, number * 2 AS d FROM numbers(5)');
      await page.locator('#resultsPanel .resultsViewToggle--main [data-view="chart"]').click();
      const chart = page.locator('#resultsPanel .queryChart');
      await expect(chart).toBeVisible();
      await expect(chart.locator('.queryChart__picker .tracePicker__button')).toHaveText([/^X axis · /, /^Y values · /, /^Split by · /]);
      await expect(chart.locator('.queryChart__x')).toHaveAttribute('aria-hidden', 'true');
      await chart.locator('.queryChart__seriesButton').click();
      await expect(chart.locator('.queryChart__seriesMenu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(chart.locator('.queryChart__seriesMenu')).toBeHidden();
      await page.locator('#resultsPanel .resultsViewToggle--main [data-view="table"]').click();

      // The row menu: a right click opens it on Details; Escape closes it.
      const cell = page.locator('#resultTableBody tr').first().locator('td').nth(1);
      await cell.click({ button: 'right' });
      const menu = page.locator('.rowDetailsMenu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Details' })).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem').last()).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });
  });
}

test.describe('ui components on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  // A picker's "Label · value" sits in its own span: a long value ends in
  // an ellipsis before the chevron, the whole of it in the title.
  test('picker labels end in an ellipsis and keep the whole label in the title', async ({ page }) => {
    await page.goto('/observability/traces');
    await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
    // A phone folds the bar into its summary line: unfold it.
    await page.locator('#tracesForm .obsFilterSummary').click();
    const button = page.locator('#tracesForm .tracePicker:has(#tracesStatus) .tracePicker__button');
    await expect(button.locator('.tracePicker__label')).toHaveText('Status · All');
    await expect(button).toHaveAttribute('title', 'Status · All');
    const cut = await button.evaluate((el) => {
      // A value far longer than the button.
      const label = el.querySelector('.tracePicker__label');
      const text = label.textContent;
      label.textContent = `Status · ${'very-long-value-'.repeat(20)}`;
      const style = getComputedStyle(label);
      const out = { overflow: style.textOverflow, clipped: label.scrollWidth > label.clientWidth, inside: label.getBoundingClientRect().right <= el.getBoundingClientRect().right };
      label.textContent = text;
      return out;
    });
    expect(cut).toEqual({ overflow: 'ellipsis', clipped: true, inside: true });
  });

  test('menus stay in the viewport and the tab rows scroll sideways', async ({ page }) => {
    await page.goto('/observability/traces');
    await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
    await page.locator('#tracesForm .obsFilterSummary').click();
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    for (const picker of ['#tracesForm .tracePicker:has(#tracesStatus)', '#tracesForm .tracePicker:has(#tracesLimit)']) {
      const button = page.locator(`${picker} .tracePicker__button`);
      await button.scrollIntoViewIfNeeded();
      await button.click();
      const list = page.locator(`${picker} .tracePicker__menu`);
      await expect(list).toBeVisible();
      await settle(page);
      const box = await list.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
      await page.keyboard.press('Escape');
      await expect(list).toBeHidden();
    }
    // The tab rows keep one row.
    const row = await page.locator('#obsNav').boundingBox();
    expect(row.height).toBeLessThanOrEqual(49);
    // The header menus too.
    await page.locator('#pageSelectButton').click();
    const menu = await page.locator('#pageSelectMenu').boundingBox();
    expect(menu.x + menu.width).toBeLessThanOrEqual(vw + 0.5);
    await page.keyboard.press('Escape');
  });
});
