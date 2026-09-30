import { test, expect } from '@playwright/test';
import { captureState } from '../helpers/review.js';
import { installObservers } from '../helpers/observability.js';
import { openApp, openExplorer, openExplorerDatabase, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

const deterministicQuery = `
SELECT
  number AS id,
  concat('row-', toString(number)) AS label,
  number % 2 = 0 AS even,
  round(number / 3, 2) AS score
FROM numbers(24)
ORDER BY id
`;

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
});

test('query workspace loads cleanly', async ({ page }, testInfo) => {
  await openApp(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/idle|-|connected/i);
  await captureState(page, testInfo, 'query-empty');

  await page.locator('#runMenuButton').click();
  await expect(page.locator('#runMenu')).toBeVisible();
  await captureState(page, testInfo, 'query-run-menu');
  await page.locator('#runMenuButton').click();
  await expect(page.locator('#runMenu')).toBeHidden();

  const hostPicker = page.locator('#hostPickerButton');
  if ((await hostPicker.getAttribute('aria-disabled')) === 'true') {
    await captureState(page, testInfo, 'host-picker-static');
  } else {
    await hostPicker.click();
    await expect(page.locator('#hostPickerMenu')).toBeVisible();
    await captureState(page, testInfo, 'host-picker');
  }
});

test('captures editor and result popup menus', async ({ page }, testInfo) => {
  await openApp(page);

  const editorOptionsButton = page.locator('.editorAutocompleteControl__button');
  await editorOptionsButton.click();
  await expect(page.locator('.editorAutocompleteControl__menu')).toBeVisible();
  await captureState(page, testInfo, 'editor-options-menu');
  await editorOptionsButton.click();
  await expect(page.locator('.editorAutocompleteControl__menu')).toBeHidden();

  const editor = page.locator('#queryTextArea');
  await editor.focus(); // metadata is intentionally loaded lazily on editor focus
  await page.waitForFunction(() => {
    const state = window.ChDash && window.ChDash.state;
    const hostId = state && state.selectedHostId;
    const meta = hostId && state.meta && state.meta.hosts && state.meta.hosts[String(hostId)];
    return Boolean(meta && ((meta.keywords && meta.keywords.items && meta.keywords.items.length) ||
      (meta.functions && meta.functions.items && meta.functions.items.length)));
  }, null, { timeout: 15_000 });

  await editor.fill('SELECT cou');
  await editor.press('Control+Space');
  await expect(page.locator('#autocompleteMenu')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('#autocompleteMenu .autocompleteItem')).not.toHaveCount(0);
  await captureState(page, testInfo, 'autocomplete-suggestions');
  await editor.press('Escape');
  await expect(page.locator('#autocompleteMenu')).toBeHidden();

  await page.locator('#themeSelectButton').click();
  await expect(page.locator('#themeSelectMenu')).toBeVisible();
  await captureState(page, testInfo, 'theme-menu');
  await page.locator('#themeSelectButton').click();
  await expect(page.locator('#themeSelectMenu')).toBeHidden();

  await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'copy-row-\', toString(number)) AS label FROM numbers(4)');
  await page.locator('#copyMenuButton').click();
  await expect(page.locator('#copyMenu')).toBeVisible();
  await captureState(page, testInfo, 'results-copy-menu');
});

test('runs a query and renders deterministic results', async ({ page }, testInfo) => {
  await openApp(page);
  await runSuccessfulQuery(page, deterministicQuery);
  await expect(page.locator('#resultsPanel')).toBeVisible();
  await expect(page.locator('#resultTableBody tr')).toHaveCount(24);
  await expect(page.locator('#resultTableBody')).toContainText('row-23');
  await captureState(page, testInfo, 'query-results');
});

test('renders wide result data without losing the workspace', async ({ page }, testInfo) => {
  await openApp(page);
  await runSuccessfulQuery(page, `SELECT
    number AS id,
    concat('alpha-', toString(number)) AS alpha,
    concat('beta-', toString(number), '-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') AS beta_long_value,
    toNullable(if(number % 3 = 0, NULL, number)) AS nullable_value,
    arrayMap(x -> x + number, range(8)) AS array_value,
    map('station_id', 'visual-test', 'row', toString(number)) AS map_value,
    now64(3) AS timestamp_value
  FROM numbers(18) ORDER BY id`);
  await expect(page.locator('#resultTableHead th')).toHaveCount(8);
  await captureState(page, testInfo, 'query-wide-results');
});

test('captures running and canceled states', async ({ page }, testInfo) => {
  await openApp(page);
  await runQuery(page, `SELECT sleepEachRow(0.02) AS delay, number FROM numbers(100)`);
  await expect(page.locator('#queryStatusText')).toHaveText(/running|done/i);
  if ((await page.locator('#queryStatusText').innerText()).toLowerCase() === 'running') {
    await captureState(page, testInfo, 'query-running');
    await expect(page.locator('#runButton')).toHaveText('Cancel');
    await page.locator('#runButton').click();
    await waitForTerminal(page);
  }
  await captureState(page, testInfo, 'query-terminal-after-cancel');
});

test('renders a server error state', async ({ page }, testInfo) => {
  await openApp(page);
  await runQuery(page, 'SELECT * FROM chdash_ui.__definitely_missing_visual_test_table');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
  await expect(page.locator('#errorBanner')).toBeVisible();
  await captureState(page, testInfo, 'query-error');
});

test('normal runs do not expose Analyze', async ({ page }, testInfo) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT sum(number) AS total FROM numbers(100000)');
  await expect(page.locator('#analyzeQueryButton')).toBeHidden();
  await captureState(page, testInfo, 'query-normal-no-analysis');
});

test('profiling analysis renders Pipeline first and Tracing second', async ({ page }, testInfo) => {
  await openApp(page);
  await runSuccessfulQuery(page, `SELECT city, count() AS rows, avg(temperature_c) AS avg_temperature
    FROM chdash_ui.mild_weather_observations
    GROUP BY city ORDER BY city`, { profiling: true });
  await expect(page.locator('#analysisModalBackdrop')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pipelineViewer__row').first()).toBeVisible({ timeout: 15_000 });
  await captureState(page, testInfo, 'analysis-pipeline');
  await page.locator('#analysisTraceTab').click();
  await expect(page.locator('.traceViewer__row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer__bar').first()).toBeVisible();
  await captureState(page, testInfo, 'analysis-trace');
  await expect(page.locator('#deepAnalyzeButton')).toHaveCount(0);
});

test('explorer captures file tree, all table views, graphs and function documentation', async ({ page }, testInfo) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await expect(page).toHaveURL(/\/explorer$/);
  await expect(page.locator('#explorerWorkspace')).toContainText('chdash_ui', { timeout: 15_000 });
  await expect(page.locator('#explorerTableList')).toContainText('weather_observations');
  await expect(page.locator('#explorerTableList')).toContainText('valid_weather_observations');
  await expect(page.locator('#explorerTableList')).toContainText('weather_daily_summary_mv');
  await expect(page.locator('#explorerTableList')).toContainText('station_dictionary');
  await captureState(page, testInfo, 'explorer-file-tree');

  const dictionary = page.getByText('station_dictionary', { exact: true }).first();
  await dictionary.click();
  await expect(page.locator('#explorerDetailMeta')).toContainText(/Dictionary/i);
  await captureState(page, testInfo, 'explorer-dictionary-overview');

  const fixture = page.getByText('weather_observations', { exact: true }).first();
  await expect(fixture).toBeVisible({ timeout: 15_000 });
  await fixture.click();
  await expect(page.locator('#explorerDetail')).toBeVisible();
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailMeta')).not.toContainText('unknown engine');

  // MergeTree tables expose Overview (footprint + lineage + DDL), Data and
  // Storage (storage + former Operations sections).
  await expect(page.locator('#explorerDetailTabs').getByRole('tab')).toHaveText(['Overview', 'Data', 'Storage']);
  for (const [name, capture] of [
    ['Overview', 'explorer-table-overview-schema'],
    ['Data', 'explorer-table-data'],
    ['Storage', 'explorer-table-storage'],
  ]) {
    const tab = page.locator('#explorerDetailTabs').getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    if (name === 'Overview') await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();
    if (name === 'Data') await expect(page.locator('#explorerDetailContent .resultTable tbody tr').first()).toBeVisible({ timeout: 12_000 });
    if (name === 'Storage') await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--columns')).toBeVisible();
    await captureState(page, testInfo, capture);
  }

  // Lineage is rendered inside Overview rather than as its own tab.
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Overview', exact: true }).click();
  const lineage = page.locator('#explorerDetailContent .explorerDependencyMatrix');
  await expect(lineage).toBeVisible();
  await expect(lineage).toContainText('chdash_ui.weather_daily_summary_mv');
  await lineage.scrollIntoViewIfNeeded();
  await captureState(page, testInfo, 'explorer-table-lineage');

  // Operations remains a tab for non-disk engines such as Buffer.
  await page.getByText('weather_buffer', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_buffer');
  const operations = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Operations', exact: true });
  await operations.click();
  await expect(operations).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailContent')).toContainText('Ingestion activity');
  await captureState(page, testInfo, 'explorer-table-operations');

  await fixture.click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');

  await page.locator('#explorerModeSelectButton').click();
  await page.locator('#explorerGraphModeButton').click();
  await expect(page.locator('#explorerGraphPane')).toBeVisible();
  await expect(page.locator('#explorerGraphStatus')).not.toContainText('0 nodes · 0 edges', { timeout: 12_000 });
  await captureState(page, testInfo, 'explorer-graph-lineage');
  const expand = page.locator('#explorerGraphExpandButton');
  await expect(expand).toBeVisible();
  await expect(expand).toBeEnabled();
  await expand.click();
  await captureState(page, testInfo, 'explorer-graph-lineage-expanded');
  await page.locator('#explorerGraphTypeSelectButton').click();
  await page.locator('#explorerGraphPhysicalButton').click();
  await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('aria-selected', 'true');
  await captureState(page, testInfo, 'explorer-graph-storage-topology');

  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerFunctionsSectionButton').click();
  await expect(page.locator('#explorerFunctionsPane')).toBeVisible();
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup').first()).toBeVisible({ timeout: 15_000 });
  await page.locator('#explorerFunctionSearchInput').fill('arrayMap');
  const arrayMap = page.getByText('arrayMap', { exact: true }).first();
  await expect(arrayMap).toBeVisible({ timeout: 15_000 });
  await arrayMap.click();
  await expect(page.locator('#explorerFunctionDetail')).toBeVisible();
  await expect(page.locator('#explorerFunctionDescription')).not.toBeEmpty();
  await expect(page.locator('#explorerFunctionDescription a')).toHaveCount(0);
  await captureState(page, testInfo, 'explorer-function-markdown');

  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerTablesSectionButton').click();
  // The Tables section keeps the graph mode chosen above; database detail is
  // a browse-mode surface (in graph mode a database click focuses the graph).
  await page.locator('#explorerModeSelectButton').click();
  await page.locator('#explorerListModeButton').click();
  await expect(page.locator('#explorerGraphPane')).toBeHidden();
  const database = page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first();
  await expect(database).toBeVisible();
  await database.click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/^\d[\d,]* tables · \d+(?:\.\d+)?\s*[KMGTP]?i?B$/);
  await expect(page.locator('#explorerDatabaseObjects tbody tr').first()).toBeVisible();
  await captureState(page, testInfo, 'explorer-database-detail');
});

test('explorer captures database and System storage treemaps', async ({ page }, testInfo) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  const weather = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="weather_observations"]');
  await expect(weather).toBeVisible({ timeout: 15_000 });
  await weather.hover();
  await expect(page.locator('#explorerDatabaseTreemap [data-treemap-tooltip]')).toBeVisible();
  await captureState(page, testInfo, 'explorer-database-treemap');

  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerSystemSectionButton').click();
  await expect(page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="database"]').first()).toBeVisible({ timeout: 15_000 });
  await captureState(page, testInfo, 'explorer-system-storage-databases');

  await page.locator('#explorerSystemTablesButton').click();
  await page.locator('#explorerSystemIncludeSystem').check();
  await expect(page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="table"]').first()).toBeVisible();
  const table = page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="table"]').first();
  await table.hover();
  await expect(page.locator('#explorerSystemTreemap [data-treemap-tooltip]')).toBeVisible();
  await captureState(page, testInfo, 'explorer-system-storage-tables');
});


test('captures query library and history navigation', async ({ page }, testInfo) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 42 AS answer');
  await page.locator('#queryLibraryButton').click();
  await expect(page.locator('#queryLibraryMenu')).toBeVisible();
  await captureState(page, testInfo, 'query-library');
  const history = page.locator('#queryLibraryTabHistory');
  await expect(history).toBeVisible();
  await history.click();
  await captureState(page, testInfo, 'query-library-history');
});

test('captures the light theme as a separate design state', async ({ page }, testInfo) => {
  await openApp(page);
  await page.locator('#themeSelectButton').click();
  const light = page.locator('.themeSelect__option[data-value="light"]');
  await expect(light).toBeVisible();
  await light.click();
  await expect(page.locator('#themeSelectButton')).toHaveAttribute('aria-label', 'Theme: light');
  await expect(page.locator('#themeSelectText')).toHaveClass(/themeIcon--light/);
  await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'light-row-\', toString(number)) AS label FROM numbers(8)');
  await captureState(page, testInfo, 'query-results-light');
});

const rowDetailsDesignQuery = `SELECT
  number AS id,
  concat('alpha-', toString(number)) AS alpha,
  toNullable(if(number % 3 = 2, NULL, number)) AS nullable_value,
  arrayMap(x -> x + number, range(6)) AS array_value,
  map('station_id', 'visual-test', 'row', toString(number)) AS map_value,
  CAST((number, concat('code-', toString(number))), 'Tuple(code UInt64, label String)') AS tuple_value,
  concat('long-', repeat('lorem ipsum dolor sit amet ', 12), 'end') AS long_text
FROM numbers(18) ORDER BY id`;

async function openRowDetailsForDesign(page, testInfo, suffix) {
  await runSuccessfulQuery(page, rowDetailsDesignQuery);
  const rows = page.locator('#resultTableBody tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)');
  const row = rows.nth(2);
  await row.locator('td').nth(2).click({ button: 'right' });
  await expect(page.locator('.rowDetailsMenu')).toBeVisible();
  await captureState(page, testInfo, `row-details-menu${suffix}`);
  await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Details' }).click();
  const detail = page.locator('#resultTableBody tr.resultTable__detailRow');
  await expect(detail).toBeVisible();
  // Keep the header, the expanded row and the rows pushed below it in view.
  await detail.evaluate((tr) => tr.closest('table').scrollIntoView({ block: 'start' }));
  await page.mouse.move(2, 2);
  await captureState(page, testInfo, `row-details${suffix}`);
}

test('captures the inline result row details', async ({ page }, testInfo) => {
  await openApp(page);
  await openRowDetailsForDesign(page, testInfo, '');
});

test('captures the inline result row details in the light theme', async ({ page }, testInfo) => {
  await openApp(page);
  await page.locator('#themeSelectButton').click();
  await page.locator('.themeSelect__option[data-value="light"]').click();
  await expect(page.locator('#themeSelectButton')).toHaveAttribute('aria-label', 'Theme: light');
  await openRowDetailsForDesign(page, testInfo, '-light');
});

for (const theme of ['dark', 'light']) {
  test(`captures the traces time range panel (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    await page.goto('/traces');
    await page.waitForLoadState('networkidle');
    const button = page.locator('.tracePicker--range .tracePicker__button');
    await button.click();
    const panel = page.locator('#tracesTimeRangePanel');
    await expect(panel).toBeVisible();
    await captureState(page, testInfo, `traces-time-range-${theme}`);
    // The panel fits the viewport and hangs from its button.
    const [panelBox, buttonBox] = await Promise.all([panel.boundingBox(), button.boundingBox()]);
    const viewport = page.viewportSize();
    expect(panelBox.x).toBeGreaterThanOrEqual(0);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height);
    expect(Math.abs(panelBox.x - buttonBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(panelBox.y - (buttonBox.y + buttonBox.height))).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Mid-selection: a start picked, the end previewed, then a too wide range.
    const days = page.locator('#tracesTimeCalendar .timeCalendar__day:not(.is-outside)');
    await days.nth(9).click();
    await days.nth(12).hover();
    await captureState(page, testInfo, `traces-time-range-picking-${theme}`);
    await page.locator('#tracesRangeEnd').fill('now+30d');
    await page.locator('#tracesCustomRangeApply').click();
    await expect(page.locator('#tracesRangeError')).toBeVisible();
    await captureState(page, testInfo, `traces-time-range-error-${theme}`);
  });
}
