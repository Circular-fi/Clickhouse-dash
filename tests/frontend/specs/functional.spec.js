import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, openExplorer, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

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
  await runSuccessfulQuery(page, `SELECT number AS id, concat('row-', toString(number)) AS label FROM numbers(24) ORDER BY id`);
  await expect(page.locator('#resultTableBody tr')).toHaveCount(24);
  await expect(page.locator('#resultTableBody')).toContainText('row-23');
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('-');
  await expect(page.locator('#clickhouseElapsedWrap')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#clickhouseElapsedText')).toHaveText(/^(?:\d+ms|\d+(?:\.\d+)?s)$/i);
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

test('profiling auto-opens a compact Jaeger-style wall-clock trace', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT city, count(), avg(temperature_c) FROM chdash_ui.weather_observations GROUP BY city ORDER BY city', { profiling: true });
  await expect(page.locator('#analysisModalBackdrop')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#analysisTabs')).toHaveCount(0);
  await expect(page.locator('[data-analysis-tab]')).toHaveCount(0);
  await expect(page.locator('.analysisFlowIntro')).toHaveCount(0);
  await expect(page.locator('.analysisOtelTraceIntro')).toHaveCount(0);
  await expect(page.locator('.analysisFootnote.analysisOtelTrace__note')).toHaveCount(0);
  await expect(page.locator('.traceViewer')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer__row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.traceViewer__bar').first()).toBeVisible();
  await expect(page.locator('.analysisOtelTraceRow__marker')).toHaveCount(0);
  await expect(page.locator('[data-analysis-tab="raw"]')).toHaveCount(0);
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
  await openExplorer(page);
  await expect(page.locator('#explorerWorkspace')).toContainText('chdash_ui', { timeout: 15_000 });
  const documentScroll = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: window.innerHeight }));
  expect(documentScroll.height).toBeLessThanOrEqual(documentScroll.viewport + 1);
  await expect(page.locator('#explorerTableList')).toContainText('weather_observations');
  await expect(page.locator('#explorerTableList')).toContainText('station_dictionary');
  const databaseRow = page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first();
  await databaseRow.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/tables.*total/i);
  await expect(page.locator('#explorerDetailContent')).toContainText('Disks used by this database');
  await expect(page.locator('#explorerDetailContent .explorerDatabaseDetailTable').first()).toBeVisible();
  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('station_dictionary');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/Dictionary/i);

  await page.getByText('weather_observations', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailMeta')).not.toContainText('unknown engine');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);

  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Schema', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailContent .explorerStorageBreakdown')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerStorageBreakdown__row').filter({ hasText: 'temperature_c' }).first()).toContainText('temperature_c');
  await expect(page.locator('#explorerDetailContent .explorerPercentBar').first()).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();
  await expect(page.locator('#explorerDetailContent')).toContainText('Lineage');

  const dataTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true });
  await dataTab.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/data\?view=browse$/);
  const explorerResults = page.locator('#explorerDetailContent .tableWrap .resultTable');
  await expect(explorerResults).toBeVisible({ timeout: 12_000 });
  await expect(explorerResults).toContainText('WX-');
  await expect(explorerResults).toContainText(/Paris|Reykjavik|Lisbon/);
  await expect(explorerResults).toContainText('synthetic-weather');

  for (const name of ['Storage', 'Operations']) {
    const tab = page.locator('#explorerDetailTabs').getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/weather_observations/${name.toLowerCase()}\\?view=browse$`));
  }

  await page.goto('/explorer/chdash_ui/weather_observations/schema');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailContent .explorerStorageBreakdown')).toBeVisible();

  const reloadedData = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true });
  await reloadedData.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/data\?view=browse$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailContent .explorerStorageBreakdown__row').filter({ hasText: 'temperature_c' }).first()).toContainText('temperature_c');
  await page.locator('#explorerSectionSelectButton').click();
  await page.locator('#explorerFunctionsSectionButton').click();
  await expect(page.locator('#explorerFunctionsPane')).toBeVisible();
  await page.locator('#explorerFunctionSearchInput').fill('array');
  const firstFunctionName = await page.locator('#explorerFunctionList .explorerFunctionObject .explorerTreeObject__name').first().textContent();
  expect(String(firstFunctionName || '').toLowerCase().startsWith('array')).toBeTruthy();
});

test('explorer renders MV lineage, engine-specific tables, TTL and merged schema/DDL', async ({ page }) => {
  await openApp(page);
  await openExplorer(page);

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
  await expect(page.locator('#explorerDetailContent')).toContainText(/(?:INTERVAL\s+60\s+DAY|toIntervalDay\(60\)).*TO VOLUME/i);
  await expect(page.locator('#explorerDetailContent .explorerStorageBreakdown__row').filter({ hasText: 'temperature_c' }).first()).toContainText('temperature_c');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Schema', exact: true })).toHaveCount(0);

  await page.getByText('memory_weather', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Memory');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);

  await page.getByText('weather_buffer', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Buffer');
  await expect(page.locator('#explorerDetailContent')).toContainText('chdash_ui.weather_observations');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);

  await page.getByText('station_dictionary_source', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Tiny Log');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);

  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Dictionary');
  await expect(page.locator('#explorerDetailContent')).toContainText(/Size|Allocated/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Operations', exact: true })).toHaveCount(0);
});

test('graph table click keeps graph focus, browser selection and URL on the same table', async ({ page }) => {
  await openApp(page);
  await openExplorer(page);
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
  await openExplorer(page);
  await page.getByText('wide_types', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');

  const breakdown = page.locator('#explorerDetailContent .explorerStorageBreakdown');
  await expect(breakdown).toBeVisible();
  await expect(breakdown).toContainText('tuple_value.code');
  await expect(breakdown).toContainText('idx_wide_types_state');
  await expect(breakdown).toContainText('prj_wide_types_state');
  await expect(page.locator('#explorerDetailContent .explorerWideSummary').first()).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerPercentBar').first()).toBeVisible();

  const keywordTexts = await page.locator('#explorerDetailContent .explorerDdl .tok-kw').allTextContents();
  for (const keyword of ['INDEX', 'PROJECTION', 'TYPE', 'GRANULARITY']) {
    expect(keywordTexts.map((value) => value.toUpperCase())).toContain(keyword);
  }

  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerResultTable--preview')).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Open in Query', exact: true }).click();
  await expect(page).toHaveURL(/\/query$/);
  await expect(page.locator('#queryTextArea')).toHaveValue(/FROM `chdash_ui`\.`wide_types`/);
  await expect(page.locator('#queryTextArea')).not.toHaveValue(/`tuple_value\.code`/);
});
