import { test, expect } from '@playwright/test';
import { captureState } from '../helpers/review.js';
import { IS_RUN, installObservers } from '../helpers/observability.js';
import { openApp, openExplorer, openExplorerDatabase, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';
import { SYNTHETIC_TRACES, mockTraceFacets, mockTraceResults } from '../helpers/traces.js';

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
  await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
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

  // MergeTree tables open on Columns; Preview, Storage, Lineage and DDL are
  // their own tabs, and the About panel sits beside (or above) every tab.
  const tabNames = await page.locator('#explorerDetailTabs').getByRole('tab').allTextContents();
  expect(tabNames.filter((name) => name !== 'Operations')).toEqual(['Columns', 'Preview', 'Storage', 'Lineage', 'DDL']);
  for (const [name, capture] of [
    ['Columns', 'explorer-table-columns'],
    ['Preview', 'explorer-table-preview'],
    ['Storage', 'explorer-table-storage'],
    ['Lineage', 'explorer-table-lineage'],
    ['DDL', 'explorer-table-ddl'],
  ]) {
    const tab = page.locator('#explorerDetailTabs').getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#explorerDetailContent .explorerAbout')).toBeVisible();
    if (name === 'Columns') await expect(page.locator('#explorerDetailContent .explorerColumnsTable')).toBeVisible();
    if (name === 'Preview') await expect(page.locator('#explorerDetailContent .resultTable tbody tr').first()).toBeVisible({ timeout: 12_000 });
    if (name === 'Storage') await expect(page.locator('#explorerDetailContent .explorerTable--parts')).toBeVisible();
    if (name === 'Lineage') await expect(page.locator('#explorerDetailContent .explorerDependencyMatrix')).toContainText('weather_daily_summary_mv');
    if (name === 'DDL') await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();
    await captureState(page, testInfo, capture);
  }

  // Replicated table: replication banner first, Operations tab with sections.
  await page.goto('/explorer/chdash_repl/replicated_events/operations');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_repl.replicated_events', { timeout: 15_000 });
  await expect(page.locator('#explorerSummaryCards .explorerReplicaBanner')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerSection[data-section="replication"]')).toBeVisible();
  await captureState(page, testInfo, 'explorer-table-operations');
  await page.goto('/explorer/chdash_ui/weather_observations/columns');
  await expect(fixture).toBeVisible({ timeout: 15_000 });

  await fixture.click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');

  await page.locator('#explorerModeGraph').click();
  await expect(page.locator('#explorerGraphPane')).toBeVisible();
  await expect(page.locator('#explorerGraphStatus')).not.toContainText('0 nodes · 0 edges', { timeout: 12_000 });
  await captureState(page, testInfo, 'explorer-graph-lineage');
  const expand = page.locator('#explorerGraphExpandButton');
  await expect(expand).toBeVisible();
  await expect(expand).toBeEnabled();
  await expand.click();
  await captureState(page, testInfo, 'explorer-graph-lineage-expanded');
  await page.locator('#explorerGraphPhysicalButton').click();
  await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('aria-pressed', 'true');
  await captureState(page, testInfo, 'explorer-graph-storage-topology');

  await page.locator('#explorerFunctionsTab').click();
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

  await page.locator('#explorerCatalogTab').click();
  // The Catalog keeps the Graph mode chosen above; the database detail is a
  // Browse surface (in Graph a database click focuses the graph).
  await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#explorerModeBrowse').click();
  await expect(page.locator('#explorerGraphPane')).toBeHidden();
  const database = page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first();
  await expect(database).toBeVisible();
  await database.click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/^\d[\d,]* objects · \d+(?:\.\d)? [KMGTP]?B$/);
  await expect(page.locator('#explorerDatabaseObjects tbody tr').first()).toBeVisible();
  await captureState(page, testInfo, 'explorer-database-detail');
});

test('explorer captures database storage, the Storage mode and Server operations', async ({ page }, testInfo) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDatabaseStorageStrip, #explorerDatabaseTreemap').first()).toBeVisible({ timeout: 15_000 });
  await captureState(page, testInfo, 'explorer-database-storage');

  // Storage shows the selected database; Up leaves for the server.
  await page.locator('#explorerModeStorage').click();
  await expect(page.locator('#explorerStorageList tbody tr[data-name="weather_observations"]')).toBeVisible({ timeout: 15_000 });
  await page.locator('#explorerScopeUp').click();
  await expect(page.locator('#explorerStorageList tbody tr[data-name="chdash_ui"]')).toBeVisible({ timeout: 15_000 });
  await captureState(page, testInfo, 'explorer-storage-server');

  // The tree's System chip brings the system databases into Storage.
  await page.locator('.explorerFilterChip[data-filter="system"]').click();
  await page.locator('#explorerStorageList tbody tr[data-name="system"] .explorerStorageList__name').click();
  await expect(page.locator('#explorerTableList .explorerTreeDatabaseRow.is-selected')).toContainText('system');
  await expect(page.locator('#explorerStorageList tbody tr').first()).toBeVisible();
  const table = page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="table"]').first();
  if (await table.isVisible().catch(() => false)) {
    await table.hover();
    await expect(page.locator('#explorerStorageTreemap [data-treemap-tooltip]')).toBeVisible();
  }
  await captureState(page, testInfo, 'explorer-storage-system-database');
  await page.locator('#explorerScopeUp').click();
  await page.locator('.explorerFilterChip[data-filter="system"]').click();

  // Server operations is hidden for now (app.js does not load its module).
  if (await page.evaluate(() => !!window.ChDash?.explorerOps)) {
    await page.locator('#explorerOpsTab').click();
    await expect(page.locator('.explorerOpsSection').first()).toBeVisible({ timeout: 15_000 });
    await captureState(page, testInfo, 'explorer-server-operations');
  } else {
    await expect(page.locator('#explorerOpsTab')).toBeHidden();
  }
});


test('captures the query library panel: saved queries, preview and history', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('design.seeded')) return;
    sessionStorage.setItem('design.seeded', '1');
    const now = Date.now();
    localStorage.setItem('chdash.queryLibrary.v2', JSON.stringify({
      version: 2, revision: 1,
      folders: [{ id: 'f_ops', host_id: 'local', parent_id: null, name: 'Operations', description: 'Server health' }],
      queries: [
        { id: 'q_parts', folder_id: 'f_ops', name: 'Active parts', description: 'Parts per table', sql: 'SELECT table, count() FROM system.parts WHERE active GROUP BY table', host_id: 'local', tags: ['storage'], created_at_ms: now, updated_at_ms: now },
        { id: 'q_answer', folder_id: null, name: 'The answer', description: '', sql: 'SELECT 42 AS answer', host_id: 'local', tags: [], created_at_ms: now, updated_at_ms: now },
      ],
    }));
  });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 42 AS answer');
  await page.locator('#queryLibraryButton').click();
  const panel = page.locator('#queryLibraryMenu');
  await expect(panel).toBeVisible();
  await expect(page.locator('#queryLibraryViewSaved [role=tree]')).toBeVisible();
  await page.locator('#queryLibraryViewSaved [role=treeitem][data-kind=folder]').first().locator('.qlRow__twisty').click();
  await expect(page.locator('#queryLibraryViewSaved [role=treeitem][data-id=q_parts]')).toBeVisible();
  await captureState(page, testInfo, 'query-library');
  // A click selects the query: the pane shows it (it does not load it).
  await page.locator('#queryLibraryViewSaved [role=treeitem][data-id=q_parts] > .qlRow').click();
  await expect(page.locator('#queryLibraryPreview .qlPreview__title')).toHaveText('Active parts');
  await captureState(page, testInfo, 'query-library-preview');
  await page.locator('#queryLibraryTabHistory').click();
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await captureState(page, testInfo, 'query-library-history');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
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
    const searched = page.waitForResponse((response) => /\/api\/traces\/search/.test(response.url()), { timeout: 30_000 });
    await page.goto('/observability/traces');
    // The first search and its charts have answered.
    await searched;
    await expect(page.locator('#traceAnalyticsGrid')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
    const button = page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button');
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

for (const theme of ['dark', 'light']) {
  test(`captures the Traces, Logs and Metrics filter bars and their range panels (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    const bars = { traces: '#tracesForm', logs: '#logsForm', metrics: '#metricsToolbar' };
    const heights = [];
    for (const [view, selector] of Object.entries(bars)) {
      // An hour of the rich fixture day (data on every view, ~22 k spans).
      const ran = page.waitForResponse((response) => IS_RUN[view](response.url()), { timeout: 30_000 });
      await page.goto(`/observability/${view}?from=2026-09-12%2012:30:00&to=2026-09-12%2013:30:00`);
      const bar = page.locator(selector);
      await expect(bar).toBeVisible();
      await ran;
      await expect(bar.locator('.obsFilterBar__submit')).not.toHaveClass(/is-loading/);
      heights.push(Math.round((await bar.boundingBox()).height));
      await captureState(page, testInfo, `${view}-filter-bar-${theme}`);
      await bar.locator('.tracePicker--range > .tracePicker__button').click();
      await expect(page.locator(`#${view}TimeRangePanel`)).toBeVisible();
      await captureState(page, testInfo, `${view}-filter-bar-range-${theme}`);
      await page.keyboard.press('Escape');
    }
    // One bar height on the three views.
    expect(new Set(heights).size).toBe(1);
  });
}

for (const theme of ['dark', 'light']) {
  test(`captures the traces filter chips, attribute facets and click-to-filter menu (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => {
      localStorage.setItem('chdash.theme', mode);
      localStorage.setItem('chdash.traceFacetsCollapsed.v1', '0');
      localStorage.setItem('chdash.traceFacetPins.v1', JSON.stringify([['resource', 'deployment.environment']]));
    }, theme);
    await mockTraceResults(page);
    await mockTraceFacets(page);
    await page.goto('/observability/traces?tag=span%3Ahttp.method%3DGET&tag_not=resource%3Adeployment.environment%3Dstaging&tag_exists=db.system&service_not=cron');
    await expect(page.locator('#tracesResults .traceResultItem')).toHaveCount(SYNTHETIC_TRACES.length, { timeout: 30_000 });
    await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(4);
    const method = page.locator('#traceFacets .traceFacet[data-facet-key="http.method"]');
    await method.locator('[data-facet-expand]').click();
    await expect(method.locator('.traceFacetValue')).toHaveCount(10);
    const env = page.locator('#traceFacets .traceFacet[data-facet-key="deployment.environment"]');
    await env.locator('[data-facet-expand]').click();
    await expect(env.locator('.traceFacetValue.is-excluded')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureState(page, testInfo, `traces-filters-facets-${theme}`);
    await page.locator('#tracesResults .traceSvcPill[data-service="checkout"]').first().click();
    await expect(page.locator('#traceFilterMenu')).toBeVisible();
    await captureState(page, testInfo, `traces-filters-menu-${theme}`);
    await page.keyboard.press('Escape');
    await page.locator('#traceFacetsToggle').click();
    await expect(page.locator('#traceFacetsToggle')).toHaveAttribute('aria-expanded', 'false');
    await captureState(page, testInfo, `traces-filters-facets-folded-${theme}`);
  });
}

for (const theme of ['dark', 'light']) {
  test(`captures the traces search results as a list and as a table (${theme})`, async ({ page }, testInfo) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    await mockTraceResults(page);
    await page.goto('/observability/traces');
    await expect(page.locator('#tracesResults .traceResultItem')).toHaveCount(SYNTHETIC_TRACES.length, { timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.ChDash.traces.scatterDots().length)).toBe(SYNTHETIC_TRACES.length);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await captureState(page, testInfo, `traces-results-list-${theme}`);
    await page.locator('.traceSvcMore:visible').first().hover();
    await expect(page.locator('.traceSvcPopover')).toBeVisible();
    await captureState(page, testInfo, `traces-results-services-popover-${theme}`);
    const [dot] = await page.evaluate(() => window.ChDash.traces.scatterDots());
    await page.mouse.move(dot.x, dot.y);
    await expect(page.locator('#traceDurationChart .chartCore__tooltip')).toBeVisible();
    await captureState(page, testInfo, `traces-results-scatter-${theme}`);
    await page.locator('[data-results-view="table"]').click();
    await expect(page.locator('#tracesResults table.traceTable tbody tr')).toHaveCount(SYNTHETIC_TRACES.length);
    await page.mouse.move(2, 2);
    expect(await noOverflow()).toBe(true);
    await captureState(page, testInfo, `traces-results-table-${theme}`);
  });
}

test('traces search bar fits the viewport: nothing clipped, Search fully visible', async ({ page }) => {
  await page.goto('/observability/traces');
  await page.locator('#tracesSearchButton').waitFor();
  const fit = await page.evaluate(() => {
    const bar = document.querySelector('#tracesForm');
    const button = document.getElementById('tracesSearchButton').getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return {
      overflow: bar.scrollWidth - bar.clientWidth,
      buttonInside: button.left >= barBox.left - 1 && button.right <= Math.min(barBox.right, window.innerWidth) + 1,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(fit.overflow).toBeLessThanOrEqual(1);
  expect(fit.buttonInside).toBe(true);
  expect(fit.docOverflow).toBeLessThanOrEqual(1);
});

for (const theme of ['dark', 'light']) {
  test(`captures the logs explorer: results, record panel, context and patterns (${theme})`, async ({ page, request }, testInfo) => {
    const meta = await (await request.get('/api/logs/meta')).json();
    test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const end = Number(meta.time_bounds.max_ms);
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    await page.goto(`/observability/logs?from=${encodeURIComponent(fmt(end - 30 * 60000))}&to=${encodeURIComponent(fmt(end + 1000))}`);
    const rows = page.locator('#logsTableRows .logsRow[data-row-id]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#logsHistogram .chartCore__canvas')).toBeVisible();
    await expect.poll(async () => Number(await page.locator('#logsHistogram .chartCore').getAttribute('data-points-drawn'))).toBeGreaterThan(0);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noOverflow()).toBe(true);
    await captureState(page, testInfo, `logs-results-${theme}`);
    await rows.nth(1).click();
    await expect(page.locator('#logsSidePanel')).toBeVisible();
    expect(await noOverflow()).toBe(true);
    await captureState(page, testInfo, `logs-record-${theme}`);
    await page.locator('#logsSideTabContext').click();
    await expect(page.locator('#logsContextRows .logsContextRow.is-anchor')).toBeVisible();
    await captureState(page, testInfo, `logs-context-${theme}`);
    await page.locator('#logsSideClose').click();
    await page.locator('#logsTabPatterns').click();
    await expect(page.locator('#logsPatterns .logsPatternRow').first()).toBeVisible({ timeout: 30_000 });
    expect(await noOverflow()).toBe(true);
    await captureState(page, testInfo, `logs-patterns-${theme}`);
  });
}
