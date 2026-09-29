import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { enableExecutionStats, openApp, openExplorer, openExplorerDatabase, runQuery, runSuccessfulQuery, waitForTerminal, setFlattenTuple } from '../helpers/app.js';

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
});

test('workspace controls load and menus operate', async ({ page }) => {
  await openApp(page);
  await expect(page).toHaveURL(/\/query$/);
  await expect(page.locator('#queryStatusText')).toBeVisible();
  await page.locator('#runMenuButton').click();
  await expect(page.locator('#runMenu')).toBeVisible();
  await page.locator('#runMenuButton').click();
  await expect(page.locator('#runMenu')).toBeHidden();
  const hostPicker = page.locator('#hostPickerButton');
  const hostPickerDisabled = await hostPicker.getAttribute('aria-disabled');
  if (hostPickerDisabled === 'true') {
    await expect(hostPicker).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#hostPickerMenu')).toBeHidden();
  } else {
    await hostPicker.click();
    await expect(page.locator('#hostPickerMenu')).toBeVisible();
  }
});

test('query editor keeps the production sizing model with a centered bottom resize handle and Run becomes Cancel in place', async ({ page }) => {
  await openApp(page);
  const wrap = page.locator('.editorWrap');
  const handle = page.locator('.editorResizeHandle');
  const initial = await wrap.boundingBox();
  const panel = await page.locator('.panel--query').boundingBox();
  expect(initial && panel && initial.height >= panel.height - 100).toBeTruthy();
  await expect(handle).toBeVisible();
  const resizeMode = await wrap.evaluate((el) => getComputedStyle(el).resize);
  expect(resizeMode).toBe('none');
  const grip = await handle.boundingBox();
  expect(grip).toBeTruthy();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 64, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const resized = await wrap.boundingBox();
  expect(resized && initial && resized.height >= initial.height + 40).toBeTruthy();

  await runQuery(page, 'SELECT sleepEachRow(0.03), number FROM numbers(100)');
  if ((await page.locator('#queryStatusText').innerText()).toLowerCase() === 'running') {
    await expect(page.locator('#runButton')).toHaveText('Cancel');
    await expect(page.locator('#runMenuButton')).toBeHidden();
    await page.locator('#runButton').click();
    await waitForTerminal(page);
    await expect(page.locator('#runButton')).toHaveText('Run');
  }
});

test('query and explorer are real browser routes with independent layouts', async ({ page }) => {
  await openApp(page);
  await openExplorer(page);
  await expect(page).toHaveURL(/\/explorer$/);
  await page.goto('/explorer');
  await expect(page).toHaveURL(/\/explorer$/);
  await expect(page.locator('#explorerWorkspace')).toBeVisible();
  await expect(page.locator('#queryWorkspace')).toBeHidden();
  await page.locator('#pageSelectButton').click();
  await page.locator('#navQueryButton').click();
  await expect(page).toHaveURL(/\/query$/);
  await expect(page.locator('#queryWorkspace')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer$/);
  await expect(page.locator('#explorerWorkspace')).toBeVisible();
  await page.goto('/explorer/functions');
  await expect(page).toHaveURL(/\/explorer\/functions$/);
  await expect(page.locator('#explorerFunctionsPane')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup').first()).toBeVisible({ timeout: 15_000 });
});

test('format and clear buttons follow actual editor and result state', async ({ page }) => {
  await openApp(page);
  const editor = page.locator('#queryTextArea');
  const format = page.locator('#formatButton');
  const clear = page.locator('#clearResultsButton');

  await expect(format).toBeDisabled();
  await expect(clear).toBeDisabled();
  await editor.fill('select  1 as x');
  await expect(format).toBeEnabled();
  await format.click();
  await expect(editor).toHaveValue(/SELECT/);
  await expect(format).toBeDisabled();
  await expect(clear).toBeDisabled();

  await runSuccessfulQuery(page, await editor.inputValue());
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(clear).toBeDisabled();
});

test('normal query cannot expose analysis', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT sum(number) AS total FROM numbers(100000)');
  await expect(page.locator('#analyzeQueryButton')).toBeHidden();
});

test('query execution renders rows and terminal status', async ({ page }) => {
  await openApp(page);
  await enableExecutionStats(page);
  await runSuccessfulQuery(page, `SELECT number AS id, concat('row-', toString(number)) AS label FROM numbers(24) ORDER BY id`);
  await expect(page.locator('#resultTableBody tr')).toHaveCount(24);
  await expect(page.locator('#resultTableBody')).toContainText('row-23');
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('-');
  await expect(page.locator('#clickhouseElapsedWrap')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#clickhouseElapsedText')).toHaveText(/^\d+(?:\.\d+)?(?:ms|s)$/i);
  const elapsedBox = await page.locator('#elapsedSecondsText').boundingBox();
  const systemBox = await page.locator('#clickhouseElapsedText').boundingBox();
  expect(elapsedBox && systemBox && systemBox.y > elapsedBox.y).toBeTruthy();
});

test('query errors are surfaced', async ({ page }) => {
  await openApp(page);
  await runQuery(page, 'SELECT * FROM chdash_ui.__missing_front_functional_table');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/error/i);
  await expect(page.locator('#errorBanner')).toBeVisible();
  await expect(page.locator('#liveResultsWrap')).toBeHidden();
  await expect(page.locator('#resultTable')).toBeHidden();
});

test('profiling auto-opens Pipeline and lazily mounts Tracing', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT city, count(), avg(temperature_c) FROM chdash_ui.weather_observations GROUP BY city ORDER BY city', { profiling: true });
  await expect(page.locator('#analysisModalBackdrop')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#analysisPipelineTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysisTraceTab')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('.pipelineViewer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.pipelineViewer__row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer')).toHaveCount(0);
  await page.locator('#analysisTraceTab').click();
  await expect(page.locator('#analysisTraceTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.traceViewer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer__row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer__bar').first()).toBeVisible();
  await expect(page.locator('#deepAnalyzeButton')).toHaveCount(0);
});

test('profiling is unavailable for multiquery editor content', async ({ page }) => {
  await openApp(page);
  await page.locator('#queryTextArea').fill('SELECT 1; SELECT 2');
  await page.locator('#runMenuButton').click();
  await expect(page.locator('#runMenu')).toBeVisible();
  await expect(page.locator('#runWithProfilingButton')).toBeHidden();
});

test('known table diagnostics stay quiet across query reload metadata hydration', async ({ page }) => {
  await openApp(page);
  const sql = `SELECT
    \`observation_date\`,
    \`region\`,
    \`observation_count\`,
    \`average_temperature\`
FROM chdash_ui.weather_daily_summary
LIMIT 100`;
  const editor = page.locator('#queryTextArea');
  await editor.fill(sql);
  await page.waitForTimeout(700);
  await expect(page.locator('.editorDiagnostic--unknown_table')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#queryWorkspace')).toBeVisible();
  await expect(editor).toHaveValue(sql, { timeout: 10_000 });
  await page.waitForTimeout(900);
  await expect(page.locator('.editorDiagnostic--unknown_table')).toHaveCount(0);
});

test('explorer opens fixture database and six table views', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await expect(page.locator('#explorerWorkspace')).toContainText('chdash_ui', { timeout: 15_000 });
  const documentScroll = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: window.innerHeight }));
  expect(documentScroll.height).toBeLessThanOrEqual(documentScroll.viewport + 1);
  await expect(page.locator('#explorerTableList')).toContainText('weather_observations');
  await expect(page.locator('#explorerTableList')).toContainText('station_dictionary');
  const databaseRow = page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first();
  await databaseRow.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  // Database detail meta is "<n> tables · <database bytes>"; the per-database
  // disk list was replaced by a per-object list with rows/footprint stats.
  await expect(page.locator('#explorerDetailMeta')).toContainText(/^\d[\d,]* tables · \d+(?:\.\d+)?\s*[KMGTP]?i?B$/);
  await expect(page.locator('#explorerDetailTabs')).toBeHidden();
  await expect(page.locator('#explorerDetailContent .explorerDatabaseDetailTable').first()).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDatabaseDetailTable').filter({ has: page.getByText('weather_observations', { exact: true }) }))
    .toContainText(/Merge Tree.*rows/);
  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('station_dictionary');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/Dictionary/i);

  await page.getByText('weather_observations', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailMeta')).not.toContainText('unknown engine');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);

  // Overview merges footprint, lineage and schema/DDL. Schema and Lineage are
  // not separate tabs; MergeTree operations are folded into Storage.
  const detailTabs = page.locator('#explorerDetailTabs').getByRole('tab');
  await expect(detailTabs).toHaveText(['Overview', 'Data', 'Storage']);
  await expect(page.locator('#explorerDetailContent .explorerScopeMeter--database .explorerScopeMeter__fill')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerScopeMeter--clickhouse')).toBeVisible();
  const composition = page.locator('#explorerDetailContent .explorerStorageCompositionCard');
  await expect(composition).toBeVisible();
  await expect(composition).toContainText('Table storage');
  await expect(composition.locator('.explorerStorageStackedBar__segment').first()).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('temperature_c');
  const lineage = page.locator('#explorerDetailContent .explorerDependencyMatrix');
  await expect(lineage).toBeVisible();
  await expect(lineage.locator('.explorerDependencyGroup').filter({ hasText: 'Upstream' })).toContainText('chdash_ui.weather_buffer');
  await expect(lineage.locator('.explorerDependencyGroup').filter({ hasText: 'Downstream' })).toContainText('chdash_ui.weather_daily_summary_mv');

  const dataTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true });
  await dataTab.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/data\?view=browse$/);
  const explorerResults = page.locator('#explorerDetailContent .tableWrap .resultTable');
  await expect(explorerResults).toBeVisible({ timeout: 12_000 });
  await expect(explorerResults).toContainText('WX-');
  await expect(explorerResults).toContainText(/Paris|Reykjavik|Lisbon/);
  await expect(explorerResults).toContainText('synthetic-weather');

  const storageTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true });
  await storageTab.click();
  await expect(storageTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/storage\?view=browse$/);
  // Per-column storage accounting lives in the Storage tab's shared result table.
  const columnStorage = page.locator('#explorerDetailContent .explorerStorageResultTable--columns');
  await expect(columnStorage).toBeVisible();
  await expect(columnStorage.locator('tbody tr').filter({ hasText: 'temperature_c' }).first()).toContainText(/\d+(?:\.\d+)?\s*[KMG]?B/);
  await expect(columnStorage.locator('.explorerStoragePercentCell').first()).toBeVisible();
  // The former Operations surface is merged into Storage for MergeTree tables.
  await expect(page.locator('#explorerDetailContent')).toContainText('Ingestion activity');
  await expect(page.locator('#explorerDetailContent')).toContainText('Merge activity');
  // An old /operations deep link for a MergeTree table falls back to Overview.
  await page.goto('/explorer/chdash_ui/weather_observations/operations');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toBeVisible();

  await page.goto('/explorer/chdash_ui/weather_observations/schema');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();

  const reloadedData = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true });
  await reloadedData.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/data\?view=browse$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('temperature_c');
  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerFunctionsSectionButton').click();
  await expect(page.locator('#explorerFunctionsPane')).toBeVisible();
  await page.locator('#explorerFunctionSearchInput').fill('array');
  const firstFunctionName = await page.locator('#explorerFunctionList .explorerFunctionObject .explorerTreeObject__name').first().textContent();
  expect(String(firstFunctionName || '').toLowerCase().startsWith('array')).toBeTruthy();
});

test('explorer renders MV lineage, engine-specific tables, TTL and merged schema/DDL', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);

  await page.getByText('weather_daily_summary_mv', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Materialized View');
  await expect(page.locator('#explorerDetailContent')).toContainText('Upstream');
  await expect(page.locator('#explorerDetailContent')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailContent')).toContainText('Downstream');
  await expect(page.locator('#explorerDetailContent')).toContainText('weather_daily_summary');
  await expect(page.locator('#explorerDetailTabs')).toBeHidden();
  await expect(page.locator('#explorerDetailContent .explorerDdlGutter')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdlCopy')).toBeVisible();

  await page.getByText('weather_observations', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText(/(?:INTERVAL\s+60\s+DAY|toIntervalDay\(60\)).*TO VOLUME/i);
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('temperature_c');
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toBeVisible();
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Schema', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Lineage', exact: true })).toHaveCount(0);
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--columns tbody tr').filter({ hasText: 'temperature_c' }).first()).toBeVisible();
  // TTL moves parts to the cold volume, so the storage policy is tiered.
  await expect(page.locator('#explorerDetailContent .explorerStorageMetaLine')).toContainText('fixture_tiered');

  await page.getByText('memory_weather', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Memory');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/RAM/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab')).toHaveText(['Overview', 'Data', 'Operations']);
  await expect(page.locator('#explorerDetailContent .explorerScopeMeters')).toHaveCount(0);

  await page.getByText('weather_buffer', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Buffer');
  await expect(page.locator('#explorerDetailContent .explorerDependencyGroup').filter({ hasText: 'Downstream' })).toContainText('chdash_ui.weather_observations');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab')).toHaveText(['Overview', 'Data', 'Operations']);

  // Log-family tables are disk-backed: they now get a Storage tab limited to
  // real storage + ingestion surfaces (no MergeTree merges/parts sections).
  await page.getByText('station_dictionary_source', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Tiny Log');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/on disk/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab')).toHaveText(['Overview', 'Data', 'Storage']);
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toHaveCount(0);
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerStorageMetaLine')).toContainText(/Storage medium\s*Disk/);
  await expect(page.locator('#explorerDetailContent')).toContainText('Ingestion activity');
  await expect(page.locator('#explorerDetailContent')).not.toContainText('Merge activity');
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--columns')).toHaveCount(0);

  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Dictionary');
  // Dictionary memory footprint is reported in the header meta ("<bytes> RAM").
  await expect(page.locator('#explorerDetailMeta')).toContainText(/\d+(?:\.\d+)?\s*[KMG]?B RAM/);
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('CREATE DICTIONARY');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Operations', exact: true })).toHaveCount(0);
});

test('graph table click keeps graph focus, browser selection and URL on the same table', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.getByText('weather_observations', { exact: true }).first().click();
  await page.locator('#explorerModeSelectButton').click();
  await page.locator('#explorerGraphModeButton').click();
  await expect(page.locator('#explorerGraphPane')).toBeVisible();
  // The graph is a canvas, so use the exported selection bridge to exercise the
  // same path as a logical-node click without relying on fragile pixel positions.
  await page.evaluate(() => window.ChDash.explorer.selectTable('chdash_ui', 'wide_types'));
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/overview\?view=graph&graph=lineage&depth=1$/);
  await page.locator('#explorerModeSelectButton').click();
  await page.locator('#explorerListModeButton').click();
  await expect(page.locator('.explorerTreeObject.is-selected')).toContainText('wide_types');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');
});

test('database detail treemap sizes tables, shows a hover tooltip and opens the table', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  const map = page.locator('#explorerDatabaseTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/);
  const weather = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"][data-table="weather_observations"]');
  await expect(weather).toBeVisible();
  await expect(weather).toContainText('weather_observations');
  // weather_observations holds almost all of chdash_ui, the remaining tiny
  // tables are below 1% and must be grouped instead of drawn as slivers.
  const box = await weather.boundingBox();
  const mapBox = await map.boundingBox();
  expect(box.width * box.height).toBeGreaterThan(mapBox.width * mapBox.height * 0.5);
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="wide_types"]')).toHaveCount(0);
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node.is-other')).toContainText(/Others/);
  // Resident-memory engines never become on-disk treemap area.
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="memory_weather"]')).toHaveCount(0);
  await expect(page.locator('#explorerDetailContent .explorerTreemapFootnote')).toContainText(/On-disk bytes.*Others/);

  await weather.hover();
  const tooltip = page.locator('#explorerDatabaseTreemap [data-treemap-tooltip]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('chdash_ui.weather_observations');
  await expect(tooltip).toContainText(/\d(?:\.\d+)?[KMG]B · .*rows · Merge Tree · \d+(?:\.\d+)?% of chdash_ui/);
  await expect(weather).toHaveClass(/is-hovered/);
  await page.mouse.move(2, 2);
  await expect(tooltip).toBeHidden();

  await weather.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');
  await expect(page.locator('#explorerDatabaseTreemap')).toHaveCount(0);
});

test('System section maps server storage by database, by table and drills into a database', async ({ page }) => {
  await openApp(page);
  await openExplorer(page);
  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerSystemSectionButton').click();
  await expect(page).toHaveURL(/\/explorer\/_system$/);
  await expect(page.locator('#explorerSystemPane')).toBeVisible();
  await expect(page.locator('#explorerListView')).toBeHidden();
  await expect(page.locator('#explorerTableModeTabs')).toBeHidden();
  await expect(page.locator('#explorerSectionSelectButton')).toHaveText('System');
  await expect(page.locator('#explorerSystemMeta')).toContainText(/^[\d,]+ databases · [\d,]+ tables with data · \d+(?:\.\d+)?[KMGTP]?B$/, { timeout: 15_000 });

  const otel = page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="database"][data-name="otel"]');
  await expect(otel).toBeVisible();
  await expect(otel).toHaveClass(/is-terminal/);
  await expect(page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="table"]')).toHaveCount(0);
  await expect(page.locator('#explorerSystemDatabaseList .explorerSystemDatabase[data-database="chdash_ui"]')).toBeVisible();
  await expect(page.locator('#explorerSystemDatabaseList .explorerSystemDatabase[data-database="system"]')).toHaveCount(0);

  await otel.hover();
  await expect(page.locator('#explorerSystemTreemap [data-treemap-tooltip]')).toContainText(/^otel/);

  // The shared "include system databases" option adds system to the scope.
  await page.locator('#explorerSystemIncludeSystem').check();
  await expect(page.locator('#explorerSystemDatabaseList .explorerSystemDatabase[data-database="system"]')).toBeVisible();
  await page.locator('#explorerSystemIncludeSystem').uncheck();
  await expect(page.locator('#explorerSystemDatabaseList .explorerSystemDatabase[data-database="system"]')).toHaveCount(0);

  await page.locator('#explorerSystemTablesButton').click();
  await expect(page).toHaveURL(/\/explorer\/_system\?level=tables$/);
  await expect(page.locator('#explorerSystemTablesButton')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="table"][data-table="otel_traces"]')).toBeVisible();
  await expect(page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="database"][data-name="otel"]')).toHaveClass(/is-branch/);

  // A reload keeps the requested level.
  await page.reload();
  await expect(page.locator('#explorerSystemTablesButton')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await page.locator('#explorerSystemDatabasesButton').click();
  await expect(page).toHaveURL(/\/explorer\/_system$/);

  await page.locator('#explorerSystemTreemap .explorerTreemap__node[data-kind="database"][data-name="otel"]').click();
  await expect(page).toHaveURL(/\/explorer\/otel\?view=browse$/);
  await expect(page.locator('#explorerSectionSelectButton')).toHaveText('Tables');
  await expect(page.locator('#explorerDetailName')).toHaveText('otel', { timeout: 15_000 });
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="otel_traces"]')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_system$/);
  await expect(page.locator('#explorerSystemPane')).toBeVisible();
  await page.locator('#explorerSystemDatabaseList .explorerSystemDatabase[data-database="chdash_ui"]').click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui', { timeout: 15_000 });
});

test('multiquery exposes global copy JSON and raw JSON download without clearing results', async ({ page }) => {
  await openApp(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string' && Number.isInteger(active.selectionStart) && Number.isInteger(active.selectionEnd)) {
        window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
      }
    }, true);
  });
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();

  await runQuery(page, 'SELECT 1 AS id, \'first\' AS label; SELECT 2 AS id, \'second\' AS label;');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished/i);
  await expect(page.locator('#copySplit')).toBeVisible();
  await expect(page.locator('#copyJsonButton')).toBeEnabled();
  await page.locator('#copyJsonButton').click();
  const copied = await page.evaluate(async () => {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  });
  const copiedPayload = JSON.parse(copied);
  expect(copiedPayload.queries).toHaveLength(2);
  expect(copiedPayload.queries[0].data[0]).toMatchObject({ id: 1, label: 'first' });
  expect(copiedPayload.queries[1].data[0]).toMatchObject({ id: 2, label: 'second' });

  await page.locator('#copyMenuButton').click();
  await expect(page.locator('#downloadReceivedJsonButton')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#downloadReceivedJsonButton').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('queries.json');
  const stream = await download.createReadStream();
  let jsonText = '';
  for await (const chunk of stream) jsonText += chunk.toString('utf8');
  const downloadedPayload = JSON.parse(jsonText);
  expect(downloadedPayload.queries).toHaveLength(2);
  await expect(page.locator('.resultsStack__block')).toHaveCount(2);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished/i);
});

test('wide_types browse shows flat storage accounting, contextual DDL keywords and opens Query with SQL', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.getByText('wide_types', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');

  // Overview: flat part-format / projection / index composition of the table footprint.
  const composition = page.locator('#explorerDetailContent .explorerStorageCompositionCard');
  await expect(composition).toBeVisible();
  await expect(composition.locator('.explorerStorageStackedBar__segment').first()).toBeVisible();
  const legendLabels = await composition.locator('.explorerStorageCompositionLegend__label').allTextContents();
  expect(legendLabels).toEqual(expect.arrayContaining(['Projections', 'Indexes']));
  expect(legendLabels.some((label) => label === 'Wide' || label === 'Compact')).toBeTruthy();

  const keywordTexts = await page.locator('#explorerDetailContent .explorerDdl .tok-kw').allTextContents();
  for (const keyword of ['INDEX', 'PROJECTION', 'TYPE', 'GRANULARITY']) {
    expect(keywordTexts.map((value) => value.toUpperCase())).toContain(keyword);
  }

  // Storage: per-column table with collapsible Tuple children, plus separate
  // index and projection accounting tables.
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/storage\?view=browse$/);
  const columnStorage = page.locator('#explorerDetailContent .explorerStorageResultTable--columns');
  await expect(columnStorage).toBeVisible();
  const tupleChild = columnStorage.locator('tbody tr').filter({ hasText: 'tuple_value.code' }).first();
  await expect(tupleChild).toBeHidden();
  await columnStorage.getByRole('button', { name: 'Expand tuple_value', exact: true }).click();
  await expect(tupleChild).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--indexes')).toContainText('idx_wide_types_state');
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--projections')).toContainText('prj_wide_types_state');
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--projections .explorerStoragePercentCell').first()).toHaveText(/%/);

  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true }).click();
  const previewTable = page.locator('#explorerDetailContent .explorerResultTable--preview');
  await expect(previewTable).toBeVisible({ timeout: 12_000 });
  const previewHeaders = await previewTable.locator('thead th').allTextContents();
  for (const column of ['tuple_value.code', 'tuple_value.name', 'nested_array.k', 'nested_array.v']) {
    expect(previewHeaders).toContain(column);
  }
  await page.getByRole('button', { name: 'Open in Query', exact: true }).click();
  await expect(page).toHaveURL(/\/query$/);
  await expect(page.locator('#queryTextArea')).toHaveValue(/FROM `chdash_ui`\.`wide_types`/);
  await expect(page.locator('#queryTextArea')).not.toHaveValue(/`tuple_value\.code`/);
});


const rowDetailsQuery = `SELECT
  number AS id,
  concat('name-', toString(number)) AS name,
  range(number + 1) AS arr,
  map('k', number, 'z', number * 2) AS m,
  CAST((number, concat('t', toString(number))), 'Tuple(code UInt64, label String)') AS tup,
  if(number = 2, NULL, toNullable(number)) AS maybe,
  concat('long-', repeat('abcdefghij', 40), '-end') AS long_text
FROM numbers(6)
ORDER BY id`;

const dataRowsSelector = 'tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)';

async function openRowDetailsFromRow(page, row) {
  // The menu closes on scroll: let a scroll-into-view settle before the click.
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await row.locator('td').nth(2).click({ button: 'right' });
  const menu = page.locator('.rowDetailsMenu');
  await expect(menu).toBeVisible();
  const details = menu.getByRole('menuitem', { name: 'Details' });
  await expect(details).toBeFocused();
  await details.click();
  await expect(menu).toHaveCount(0);
  const view = page.locator('tr.resultTable__detailRow .rowDetails');
  await expect(view).toBeVisible();
  await expect(row).toHaveClass(/is-rowExpanded/);
  return view;
}

// The detail <tr> must be the very next sibling of its data row.
async function expectDetailRightAfter(row) {
  expect(await row.evaluate((tr) => {
    const next = tr.nextElementSibling;
    return !!next && next.classList.contains('resultTable__detailRow')
      && tr.parentElement.querySelectorAll('tr.resultTable__detailRow').length === 1
      && next.cells.length === 1 && next.cells[0].colSpan === tr.cells.length;
  })).toBe(true);
}

test('row details menu is not offered for a single-row (already vertical) result', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, "SELECT 1 AS a, 'x' AS b, [1, 2] AS c");
  await expect(page.locator('#resultTableBody').locator('xpath=..')).toHaveClass(/resultTable--vertical/);
  const cell = page.locator('#resultTableBody td').first();
  await cell.click({ button: 'right' });
  await expect(page.locator('.rowDetailsMenu')).toHaveCount(0);
  const prevented = await cell.evaluate((td) => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    td.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test('right-click Details expands a result row inline, under the row, and dismisses on outside click or Escape', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, rowDetailsQuery);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await expect(rows).toHaveCount(6);
  const row3 = rows.nth(2);

  // Shift+right-click keeps the browser menu (no custom menu).
  await row3.locator('td').nth(2).click({ button: 'right', modifiers: ['Shift'] });
  await expect(page.locator('.rowDetailsMenu')).toHaveCount(0);

  // Escape closes the custom menu without opening details.
  await row3.locator('td').nth(2).click({ button: 'right' });
  await expect(page.locator('.rowDetailsMenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.rowDetailsMenu')).toHaveCount(0);
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);

  const row4Before = await rows.nth(3).evaluate((tr) => tr.getBoundingClientRect().top);
  const view = await openRowDetailsFromRow(page, row3);
  await expectDetailRightAfter(row3);
  await expect(view).toHaveAttribute('data-row', '3');
  // Same presentation as a one-row (LIMIT 1) result: column names only, no type line.
  const names = await view.locator('.rowDetails__name').allTextContents();
  expect(names).toEqual(['id', 'name', 'arr', 'm', 'tup.code', 'tup.label', 'maybe', 'long_text']);
  await expect(view.locator('.rowDetails__type')).toHaveCount(0);
  // The detail's accent bar sits at exactly the same x as the expanded row's bar.
  const bars = await page.evaluate(() => {
    const index = document.querySelector('#resultTableBody tr.is-rowExpanded td.resultTable__rowIndex');
    const detail = document.querySelector('.rowDetails');
    const inner = (el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).borderLeftWidth);
    return { row: inner(index), detail: inner(detail) };
  });
  expect(Math.abs(bars.row - bars.detail)).toBeLessThan(0.5);
  const values = view.locator('.rowDetails__value');
  await expect(values).toHaveCount(8);
  await expect(values.nth(0)).toHaveText('2');
  await expect(values.nth(1)).toHaveText('name-2');
  // Arrays and maps are pretty-printed on several lines and highlighted.
  await expect(values.nth(2)).toHaveText(/^\[\s+0,\s+1,\s+2\s+\]$/);
  expect(await values.nth(2).evaluate((el) => el.textContent.split('\n').length)).toBeGreaterThan(3);
  await expect(values.nth(3)).toContainText('"z": 4');
  await expect(values.nth(3).locator('.tok-num').first()).toBeVisible();
  await expect(values.nth(4)).toHaveText('2');
  await expect(values.nth(5)).toHaveText('t2');
  await expect(values.nth(6).locator('.tok-null')).toHaveText('null');
  await expect(values.nth(7)).toContainText(`long-${'abcdefghij'.repeat(40)}-end`);

  // Row 4 is pushed below the detail; the detail is exactly the visible
  // table width, sticks to its left edge and never widens the page.
  const geometry = await page.evaluate(() => {
    const detail = document.querySelector('#resultTableBody tr.resultTable__detailRow');
    const content = detail.querySelector('.rowDetails');
    const wrap = detail.closest('.tableWrap');
    const rows = [...document.querySelectorAll('#resultTableBody tr:not(.resultTable__detailRow)')];
    const d = detail.getBoundingClientRect();
    const c = content.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return {
      detailTop: d.top, detailBottom: d.bottom, detailHeight: d.height,
      row3Bottom: rows[2].getBoundingClientRect().bottom,
      row4Top: rows[3].getBoundingClientRect().top,
      contentLeft: c.left, contentWidth: c.width, wrapLeft: w.left + wrap.clientLeft, wrapWidth: wrap.clientWidth,
      wrapScrollable: wrap.scrollWidth - wrap.clientWidth,
      contentOverflowX: content.scrollWidth - content.clientWidth,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(Math.abs(geometry.detailTop - geometry.row3Bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.row4Top - geometry.detailBottom)).toBeLessThanOrEqual(1);
  expect(geometry.row4Top - row4Before).toBeGreaterThan(geometry.detailHeight - 2);
  expect(Math.abs(geometry.contentLeft - geometry.wrapLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.contentWidth - geometry.wrapWidth)).toBeLessThanOrEqual(1);
  expect(geometry.contentOverflowX).toBeLessThanOrEqual(1);
  expect(geometry.docOverflowX).toBeLessThanOrEqual(1);
  if (geometry.wrapScrollable > 40) {
    // Scrolling a wide table horizontally keeps the detail in view.
    const stuck = await page.evaluate(() => {
      const wrap = document.querySelector('#resultTableBody').closest('.tableWrap');
      wrap.scrollLeft = 200;
      const c = document.querySelector('#resultTableBody .rowDetails').getBoundingClientRect();
      const left = wrap.getBoundingClientRect().left + wrap.clientLeft;
      wrap.scrollLeft = 0;
      return Math.abs(c.left - left);
    });
    expect(stuck).toBeLessThanOrEqual(1);
  }

  // Clicking / selecting inside keeps it open.
  await values.nth(1).click();
  await values.nth(7).dblclick();
  await expect(view).toBeVisible();
  const selected = await page.evaluate(() => String(window.getSelection()));
  expect(selected.length).toBeGreaterThan(0);
  await view.locator('.rowDetails__copy').click();
  await expect(view).toBeVisible();

  // A click on another row dismisses it.
  await rows.nth(4).locator('td').nth(1).click();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  await expect(row3).not.toHaveClass(/is-rowExpanded/);

  // Only one expanded row at a time.
  await openRowDetailsFromRow(page, rows.nth(1));
  await openRowDetailsFromRow(page, rows.nth(3));
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await expect(rows.nth(1)).not.toHaveClass(/is-rowExpanded/);
  await expectDetailRightAfter(rows.nth(3));

  // A click elsewhere on the page dismisses it.
  await page.locator('#resultsPanel .panel__header').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);

  // The close button and Escape dismiss it; the keyboard path (Enter on the
  // focused item) works.
  await openRowDetailsFromRow(page, rows.nth(0));
  await page.locator('.rowDetails__close').click();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  await rows.nth(4).locator('td').nth(1).click({ button: 'right' });
  await expect(page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Details' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.rowDetails')).toHaveAttribute('data-row', '5');
  await page.keyboard.press('Escape');
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);

  // Sorting keeps the detail attached to the same data row.
  await openRowDetailsFromRow(page, rows.nth(2));
  await page.locator('#resultTableHead th[data-sort-key="0"]').click();
  await page.locator('#resultTableHead th[data-sort-key="0"]').click();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  const expanded = page.locator('#resultTableBody tr.is-rowExpanded');
  await expect(expanded.locator('td.resultTable__rowIndex')).toHaveText('3');
  await expectDetailRightAfter(expanded);

  // Starting a new query dismisses it too.
  await page.locator('#queryTextArea').focus();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  await waitForTerminal(page);
});

test('inline row details stay attached to their virtualized row and are counted in the scroll extent', async ({ page }) => {
  const total = 20000;
  await openApp(page);
  await runSuccessfulQuery(page, `SELECT number AS id, concat('row-', toString(number)) AS label, [number, number + 1] AS pair,
    map('n', number) AS m, if(number % 7 = 0, NULL, toNullable(number * 3)) AS maybe FROM numbers(${total})`);
  const body = page.locator('#resultTableBody');
  await expect(body.locator('tr.resultTable__spacerRow').first()).toBeAttached();
  const extent = () => page.evaluate(() => {
    const tbody = document.getElementById('resultTableBody');
    const data = tbody.querySelector('tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)');
    const detail = tbody.querySelector('tr.resultTable__detailRow');
    return {
      body: tbody.getBoundingClientRect().height,
      rowH: data ? data.getBoundingClientRect().height : 0,
      detail: detail ? detail.getBoundingClientRect().height : 0,
    };
  });
  // Wait until the streamed rows are all accounted for by rows + spacers.
  await expect.poll(async () => {
    const e = await extent();
    return e.rowH > 0 ? Math.round(e.body / e.rowH) : 0;
  }, { timeout: 15_000 }).toBe(total);

  const scrollBy = (dy) => page.evaluate((delta) => {
    const ws = document.getElementById('queryWorkspace');
    const owner = ws && ws.scrollHeight > ws.clientHeight + 1 ? ws : document.scrollingElement;
    owner.scrollTop += delta;
  }, dy);
  const visibleRowIndex = () => page.evaluate(() => {
    const el = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
    const tr = el && el.closest('#resultTableBody tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)');
    return tr ? Number(tr.querySelector('.resultTable__rowIndex').textContent) : 0;
  });
  // Every mounted data row sits at (index - 1) * rowH, plus the detail height
  // for rows after the expanded one: no jump anywhere in the window.
  const layoutError = (expandedIndex, detailH, rowH) => page.evaluate(({ expandedIndex, detailH, rowH }) => {
    const tbody = document.getElementById('resultTableBody');
    const top = tbody.getBoundingClientRect().top;
    let worst = 0;
    for (const tr of tbody.querySelectorAll('tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)')) {
      const index = Number(tr.querySelector('.resultTable__rowIndex').textContent);
      const expected = (index - 1) * rowH + (index > expandedIndex ? detailH : 0);
      worst = Math.max(worst, Math.abs(tr.getBoundingClientRect().top - top - expected));
    }
    return worst;
  }, { expandedIndex, detailH, rowH });

  await scrollBy(10000 * 32);
  await expect.poll(visibleRowIndex, { timeout: 10_000 }).toBeGreaterThan(2000);
  const index = await visibleRowIndex();
  const rowFor = (n) => body.locator('tr').filter({ has: page.locator(`td.resultTable__rowIndex:text-is("${n}")`) });
  const closed = await extent();
  const view = await openRowDetailsFromRow(page, rowFor(index));
  await expect(view).toHaveAttribute('data-row', String(index));
  await expect(view.locator('.rowDetails__value').nth(1)).toHaveText(`row-${index - 1}`);
  await expectDetailRightAfter(rowFor(index));
  const open = await extent();
  expect(open.detail).toBeGreaterThan(100);
  expect(Math.abs(open.body - (total * closed.rowH + open.detail))).toBeLessThanOrEqual(2);
  expect(await layoutError(index, open.detail, closed.rowH)).toBeLessThanOrEqual(2);

  // Scroll far away (both directions, detail unmounted into a spacer) and back.
  const probe = await page.evaluate(() => {
    const el = document.querySelector('#resultTableBody tr.resultTable__detailRow');
    el.__rowDetailsProbe = true;
    return true;
  });
  expect(probe).toBe(true);
  for (const dy of [3000 * 32, -6000 * 32]) {
    await scrollBy(dy);
    await expect.poll(async () => Math.abs((await visibleRowIndex()) - index), { timeout: 10_000 }).toBeGreaterThan(1500);
    await expect(body.locator('tr.resultTable__detailRow')).toHaveCount(0);
    const away = await extent();
    expect(Math.abs(away.body - (total * closed.rowH + open.detail))).toBeLessThanOrEqual(2);
    expect(await layoutError(index, open.detail, closed.rowH)).toBeLessThanOrEqual(2);
  }
  await scrollBy(3000 * 32);
  await expect.poll(async () => body.locator('tr.resultTable__detailRow').count(), { timeout: 10_000 }).toBe(1);
  await expectDetailRightAfter(rowFor(index));
  await expect(body.locator('tr.is-rowExpanded td.resultTable__rowIndex')).toHaveText(String(index));
  // The same detail content is re-inserted (not rebuilt) after the new <tr>.
  expect(await page.evaluate(() => document.querySelector('#resultTableBody tr.resultTable__detailRow').__rowDetailsProbe === true)).toBe(true);

  // Small scrolls across the expanded row: exactly one detail, always right
  // after its data row, rows never jump.
  for (let i = 0; i < 6; i++) {
    await scrollBy(i % 2 ? -180 : 260);
    await page.waitForTimeout(40);
    await expect(body.locator('tr.resultTable__detailRow')).toHaveCount(1);
    await expectDetailRightAfter(rowFor(index));
    expect(await layoutError(index, open.detail, closed.rowH)).toBeLessThanOrEqual(2);
  }
  const back = await extent();
  expect(Math.abs(back.body - (total * closed.rowH + open.detail))).toBeLessThanOrEqual(2);

  // Closing while the detail is above the viewport does not move the rows
  // the user is looking at.
  await scrollBy(Math.round(open.detail) + 40 * 32);
  await page.waitForTimeout(60);
  const before = await visibleRowIndex();
  expect(before).toBeGreaterThan(index);
  await page.keyboard.press('Escape');
  await expect(body.locator('tr.resultTable__detailRow')).toHaveCount(0);
  await page.waitForTimeout(60);
  expect(Math.abs((await visibleRowIndex()) - before)).toBeLessThanOrEqual(1);
  const after = await extent();
  expect(Math.abs(after.body - total * closed.rowH)).toBeLessThanOrEqual(2);
  expect(await layoutError(total + 1, 0, closed.rowH)).toBeLessThanOrEqual(2);
});

test('inline row details work in multiquery result panels', async ({ page }) => {
  await openApp(page);
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await runQuery(page, `SELECT number AS a, 'first' AS b FROM numbers(3); SELECT number AS x, concat('second-', toString(number)) AS y, [number] AS z FROM numbers(4); SELECT 1 AS only; SELECT number AS v, concat('v-', toString(number)) AS s FROM numbers(2000);`);
  await waitForTerminal(page);
  const second = page.locator('.resultsStack__block').nth(1);
  if (await second.locator('.resultsStack__body').isHidden()) await second.locator('.resultsStack__toggle').click();
  const rows = second.locator(`tbody ${dataRowsSelector}`);
  await expect(rows).toHaveCount(4);
  const view = await openRowDetailsFromRow(page, rows.nth(2));
  await expectDetailRightAfter(rows.nth(2));
  expect(await view.locator('.rowDetails__name').allTextContents()).toEqual(['x', 'y', 'z']);
  await expect(view.locator('.rowDetails__value').nth(1)).toHaveText('second-2');
  await expect(view.locator('.rowDetails__value').nth(2)).toHaveText(/^\[\s+2\s+\]$/);
  const pushed = await rows.nth(3).evaluate((tr) => tr.getBoundingClientRect().top - tr.previousElementSibling.getBoundingClientRect().bottom);
  expect(Math.abs(pushed)).toBeLessThanOrEqual(1);
  await page.mouse.click(4, 4);
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);

  // The single-row panel is vertical: no custom menu there.
  const third = page.locator('.resultsStack__block').nth(2);
  if (await third.locator('.resultsStack__body').isHidden()) await third.locator('.resultsStack__toggle').click();
  await third.locator('tbody td').first().click({ button: 'right' });
  await expect(page.locator('.rowDetailsMenu')).toHaveCount(0);

  // A virtualized panel counts the detail height in its scroll extent.
  const fourth = page.locator('.resultsStack__block').nth(3);
  if (await fourth.locator('.resultsStack__body').isHidden()) await fourth.locator('.resultsStack__toggle').click();
  await expect(fourth.locator('tbody tr.resultTable__spacerRow').first()).toBeAttached();
  const bigRows = fourth.locator(`tbody ${dataRowsSelector}`);
  const measure = () => fourth.locator('tbody').evaluate((tbody) => ({
    body: tbody.getBoundingClientRect().height,
    rowH: tbody.querySelector('tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)').getBoundingClientRect().height,
    detail: tbody.querySelector('tr.resultTable__detailRow')?.getBoundingClientRect().height || 0,
  }));
  const plain = await measure();
  expect(Math.abs(plain.body - 2000 * plain.rowH)).toBeLessThanOrEqual(2);
  await openRowDetailsFromRow(page, bigRows.nth(4));
  await expectDetailRightAfter(bigRows.nth(4));
  const expanded = await measure();
  expect(expanded.detail).toBeGreaterThan(60);
  expect(Math.abs(expanded.body - (2000 * plain.rowH + expanded.detail))).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  expect(Math.abs((await measure()).body - 2000 * plain.rowH)).toBeLessThanOrEqual(2);
});

test('inline row details open from the Explorer data preview', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.getByText('wide_types', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true }).click();
  const previewTable = page.locator('#explorerDetailContent .explorerResultTable--preview');
  await expect(previewTable).toBeVisible({ timeout: 12_000 });
  const rows = previewTable.locator(`tbody ${dataRowsSelector}`);
  expect(await rows.count()).toBeGreaterThan(2);
  const headers = (await previewTable.locator('thead th').allTextContents()).slice(1);
  const view = await openRowDetailsFromRow(page, rows.nth(1));
  await expectDetailRightAfter(rows.nth(1));
  expect(await view.locator('.rowDetails__name').allTextContents()).toEqual(headers);
  expect(headers).toContain('tuple_value.code');
  const fit = await page.evaluate(() => {
    const content = document.querySelector('.explorerResultTable--preview .rowDetails');
    const wrap = content.closest('.tableWrap');
    return {
      width: Math.abs(content.getBoundingClientRect().width - wrap.clientWidth),
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(fit.width).toBeLessThanOrEqual(1);
  expect(fit.docOverflowX).toBeLessThanOrEqual(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
});

test('inline row details remove every document/window listener they add', async ({ page }) => {
  await page.addInitScript(() => {
    const ids = new WeakMap();
    let nextId = 1;
    const live = new Set();
    const key = (target, type, fn, options) => {
      if (!ids.has(fn)) ids.set(fn, nextId++);
      const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
      return `${target === window ? 'w' : 'd'}|${type}|${capture}|${ids.get(fn)}`;
    };
    for (const target of [window, document]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = (type, fn, options) => { if (fn) live.add(key(target, type, fn, options)); return add(type, fn, options); };
      target.removeEventListener = (type, fn, options) => { if (fn) live.delete(key(target, type, fn, options)); return remove(type, fn, options); };
    }
    window.__chdashLiveListenerCount = () => live.size;
  });
  await openApp(page);
  await runSuccessfulQuery(page, rowDetailsQuery);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  // Playwright's own injected hit-target listeners install on first use.
  await rows.nth(1).scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.__chdashLiveListenerCount());
  for (let i = 0; i < 4; i++) {
    await openRowDetailsFromRow(page, rows.nth(i % 2 ? 1 : 3));
    expect(await page.evaluate(() => window.__chdashLiveListenerCount())).toBeGreaterThan(before);
    if (i === 0) await page.keyboard.press('Escape');
    else if (i === 1) await page.locator('.rowDetails__close').click();
    else await page.locator('#resultsPanel .panel__header').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  }
  await rows.nth(1).locator('td').nth(1).click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.rowDetailsMenu')).toHaveCount(0);
  expect(await page.evaluate(() => window.__chdashLiveListenerCount())).toBe(before);
});


for (const flatten of [true, false]) {
  test(`row Details renders exactly like the one-row (LIMIT 1) view (flatten=${flatten})`, async ({ page }) => {
    await openApp(page);
    await setFlattenTuple(page, flatten);
    const query = (n) => `SELECT number AS id, concat('alpha-', toString(number)) AS alpha,
  if(number % 2 = 0, NULL, number) AS maybe, range(number, number + 3) AS arr, map('k', toString(number)) AS m,
  CAST((number, concat('code-', toString(number))), 'Tuple(code UInt64, label String)') AS tup, number % 2 = 0 AS flag
FROM numbers(${n})`;
    const snapshot = (page, nameSel, valueSel) => page.evaluate(([n, v]) => {
      const names = [...document.querySelectorAll(n)].map((el) => el.textContent.trim());
      const values = [...document.querySelectorAll(v)].map((el) => ({
        text: el.innerText.trim(),
        tokens: [...el.querySelectorAll('span')].map((s) => `${s.className}=${getComputedStyle(s).color}`).join('|'),
        weight: getComputedStyle(el).fontWeight,
        size: getComputedStyle(el).fontSize,
      }));
      return { names, values };
    }, [nameSel, valueSel]);
    // Row 2 (number = 1) of a 3-row result vs the same row alone.
    await runSuccessfulQuery(page, `${query(3)} LIMIT 1 OFFSET 1`);
    const vertical = await snapshot(page, '#resultTableBody tr th', '#resultTableBody tr td');
    await runSuccessfulQuery(page, query(3));
    const row2 = page.locator('#resultTableBody tr:not(.resultTable__spacerRow)').nth(1);
    await openRowDetailsFromRow(page, row2);
    const details = await snapshot(page, '.rowDetails__name', '.rowDetails__valueContent');
    expect(details.names).toEqual(vertical.names);
    expect(details.names.includes('tup.code')).toBe(flatten);
    expect(details.values).toEqual(vertical.values);
  });
}
