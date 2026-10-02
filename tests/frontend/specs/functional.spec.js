import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { enableExecutionStats, expandExplorerDatabase, openApp, openExplorer, openExplorerDatabase, runQuery, runSuccessfulQuery, waitForTerminal, setFlattenTuple } from '../helpers/app.js';
import { SYNTHETIC_TRACES, mockTraceResults } from '../helpers/traces.js';
import { canvasPixel, chartCore, chartJson, plotBox } from '../helpers/charts.js';

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

test('the editor never traps the keyboard: Tab indents, Escape then Tab leaves it', async ({ page }) => {
  await openApp(page);
  const editor = page.locator('#queryTextArea');
  await editor.fill('SELECT 1');
  await editor.press('End');
  await editor.press('Tab');
  await expect(editor).toBeFocused();
  await expect(editor).not.toHaveValue('SELECT 1');
  await editor.press('Escape');
  await page.keyboard.press('Tab');
  await expect(editor).not.toBeFocused();
  // Back in, Tab indents again.
  await editor.focus();
  const before = await editor.inputValue();
  await editor.press('Tab');
  await expect(editor).toBeFocused();
  expect((await editor.inputValue()).length).toBeGreaterThan(before.length);
  await expect(editor).toHaveAttribute('aria-describedby', 'queryEditorKeysHint');
  await expect(page.locator('#queryEditorKeysHint')).toContainText('Escape, then Tab');
});

test('the address bar links to the query: ?sql= after a run, read back by a new tab', async ({ page, context }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 7 AS seven');
  await expect.poll(() => new URL(page.url()).searchParams.get('sql')).toMatch(/SELECT\s+7 AS `?seven`?/);
  const link = page.url();
  const other = await context.newPage();
  await other.goto(link);
  await expect(other.locator('#runButton')).toBeEnabled();
  await expect(other.locator('#queryTextArea')).toHaveValue(/SELECT\s+7 AS `?seven`?/);
  await other.close();
  // A reload keeps the tab's own draft over the link.
  await page.locator('#queryTextArea').fill('SELECT 8 AS draft');
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 8 AS draft');
});

test('the header wraps on narrow windows: brand, then host, page and theme, nothing clipped', async ({ page }) => {
  for (const width of [600, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await openApp(page);
    const boxes = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      return { brand: r('.appBrand'), host: r('#hostPickerButton'), pages: r('#pageSelectButton'), theme: r('#themeSelectButton'), vw: window.innerWidth, scroll: document.documentElement.scrollWidth };
    });
    expect(boxes.scroll).toBeLessThanOrEqual(width);
    expect(boxes.host.top).toBeGreaterThanOrEqual(boxes.brand.bottom - 1);
    for (const key of ['host', 'pages', 'theme']) {
      expect(boxes[key].left).toBeGreaterThanOrEqual(0);
      expect(boxes[key].right).toBeLessThanOrEqual(boxes.vw);
    }
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
  await page.goto('/explorer/_functions');
  await expect(page).toHaveURL(/\/explorer\/_functions$/);
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
  // Format is an icon button (indented lines) after Run, then the query
  // library (book icon) and the run settings cog, on the same line.
  await expect(format).toHaveAttribute('aria-label', 'Format SQL');
  await expect(format).toHaveText('');
  await expect(format.locator('.formatButton__icon')).toBeVisible();
  const order = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const r = box('runSplit'); const f = box('formatButton'); const l = box('queryLibraryButton'); const c = box('runSettingsButton');
    return { afterRun: f.left >= r.right, beforeLibrary: f.right <= l.left, libraryBeforeCog: l.right <= c.left, sameLine: Math.abs((f.top + f.bottom) / 2 - (c.top + c.bottom) / 2) <= 2 };
  });
  expect(order).toEqual({ afterRun: true, beforeLibrary: true, libraryBeforeCog: true, sameLine: true });
  await editor.fill('select  1 as x');
  await expect(format).toBeEnabled();
  await format.click();
  await expect(editor).toHaveValue(/SELECT/);
  await expect(format).toBeDisabled();
  await expect(clear).toBeDisabled();

  await runSuccessfulQuery(page, await editor.inputValue());
  await expect(clear).toBeEnabled();
  // Clear is the same frameless cross as the row details close button.
  await expect(clear).toHaveText('×');
  await expect(clear).toHaveAttribute('aria-label', 'Clear results');
  const idle = await clear.evaluate((el) => getComputedStyle(el).color);
  await clear.hover();
  await expect.poll(() => clear.evaluate((el) => getComputedStyle(el).color)).not.toBe(idle);
  expect(await clear.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
  })).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
  await clear.click();
  await expect(clear).toBeDisabled();
});

test('numeric gauges fill from the column baseline: most negative value empty, largest full', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT arrayJoin([-10, -3, 0, 5, 12]) AS v, v + 20 AS p ORDER BY v');
  const fills = (col) => page.locator('#resultTableBody tr:not(.resultTable__spacerRow)').evaluateAll((trs, c) =>
    trs.map((tr) => parseFloat(tr.cells[c].style.getPropertyValue('--gaugeFill'))), col);
  // v: range [-10, 12] -> -10 has no fill, 12 fills the cell, 0 sits at 10/22.
  const v = await fills(1);
  expect(v[0]).toBe(0);
  expect(v[4]).toBe(100);
  expect(v[2]).toBeCloseTo(100 * 10 / 22, 3);
  expect(v[1]).toBeCloseTo(100 * 7 / 22, 3);
  // p has no negatives: bars stay proportional to the values (baseline 0).
  const p = await fills(2);
  expect(p[0]).toBeCloseTo(100 * 10 / 32, 3);
  expect(p[4]).toBe(100);
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
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('\u2014');
  await expect(page.locator('#clickhouseElapsedWrap')).toBeVisible({ timeout: 12_000 });
  // ns.format.duration: "8 ms", "1.23 s".
  await expect(page.locator('#clickhouseElapsedText')).toHaveText(/^\d+(?:\.\d+)? (?:\u00b5s|ms|s)$/);
  const elapsedBox = await page.locator('#elapsedSecondsText').boundingBox();
  const systemBox = await page.locator('#clickhouseElapsedText').boundingBox();
  expect(elapsedBox && systemBox && systemBox.y > elapsedBox.y).toBeTruthy();
});

test('result values stay raw, a SQL NULL is the shared NULL token, and the metric rail uses the shared formats', async ({ page }) => {
  await openApp(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // Decision 45: no grouping, no reformatting of result values in the table
  // or its copies; timestamps stay as ClickHouse returned them.
  // Two rows: a single row would open the vertical one-row view.
  await runSuccessfulQuery(page, "SELECT toUInt64(1234567) + number AS n, toFloat64(1234.5) AS f, toDateTime('2026-09-12 16:29:57', 'UTC') AS t, CAST(NULL AS Nullable(UInt8)) AS z, 'null' AS s FROM numbers(2) ORDER BY n");
  const cells = page.locator('#resultTableBody tr').first().locator('td');
  await expect(cells.nth(1)).toHaveText('1234567');
  await expect(cells.nth(2)).toHaveText('1234.5');
  // The API sends DateTime as ISO 8601 UTC; the table shows it as sent.
  await expect(cells.nth(3)).toHaveText('2026-09-12T16:29:57Z');
  // A data NULL reads "NULL" in the --json-null italic token, as in the chart
  // tooltips; the string 'null' stays plain text.
  await expect(cells.nth(4).locator('.nullToken')).toHaveText('NULL');
  const token = await cells.nth(4).locator('.nullToken').evaluate((el) => ({
    style: getComputedStyle(el).fontStyle, color: getComputedStyle(el).color, expected: window.ChDash.palette.resolve('--json-null'),
  }));
  expect(token.style).toBe('italic');
  expect(token.color).toBe(token.expected);
  await expect(cells.nth(5)).toHaveText('null');
  await expect(cells.nth(5).locator('.nullToken')).toHaveCount(0);
  // Copy cell keeps the raw value too.
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
    }, true);
  });
  const readClipboard = () => page.evaluate(async () => {
    if (window.isSecureContext && navigator.clipboard) {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  });
  for (const [index, expected] of [[1, '1234567'], [3, '2026-09-12T16:29:57Z']]) {
    await cells.nth(index).click({ button: 'right' });
    await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Copy cell' }).click();
    await expect.poll(readClipboard).toBe(expected);
  }
  // The row Details view shows the same raw values and the NULL token.
  const details = await openRowDetailsFromRow(page, page.locator(`#resultTableBody ${dataRowsSelector}`).first());
  const values = details.locator('.rowDetails__value');
  await expect(values.nth(0)).toHaveText('1234567');
  await expect(values.nth(2)).toHaveText('2026-09-12T16:29:57Z');
  await expect(values.nth(3).locator('.nullToken')).toHaveText('NULL');
  await page.keyboard.press('Escape');
  // The rail: grouped totals, ns.format bytes / durations / percentages,
  // never the old "KiB", "1.00ms" or two-decimal counts (the unit keeps its
  // space, a no-break one in the split number / unit layout).
  await expect(page.locator('#readRowsTotalText')).toHaveText(/^\d{1,3}(,\d{3})*$/);
  await expect(page.locator('#readBytesTotalText')).toHaveText(/^\d+(\.\d)?\s(B|KB|MB)$/);
  await expect(page.locator('#elapsedSecondsText')).toHaveText(/^\d+(\.\d+)?\s(ns|\u00b5s|ms|s)$/);
  await expect(page.locator('#memoryMaxText')).not.toHaveText(/iB|\.\d\d/);
  for (const id of ['#cpuText', '#cpuMaxText', '#progressPercentText']) {
    // ns.format.percent: up to three significant digits, no trailing zeros
    // ("100%", "3.72%", "12.3%"), the em dash when unknown.
    await expect(page.locator(id)).toHaveText(/^(?:<0\.1%|\d+(?:\.\d*[1-9])?%|\u2014)$/);
  }
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
  await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
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

test('the profiling dialog is the shared modal: focus moves in and stays, Escape, backdrop and close return it', async ({ page }) => {
  await openApp(page);
  const modal = page.locator('#analysisModal');
  await runSuccessfulQuery(page, 'SELECT count() FROM numbers(1000)', { profiling: true });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  // A native modal <dialog> in the shared shell; the focus is inside it.
  expect(await modal.evaluate((el) => [el.tagName, el.matches(':modal'), el.classList.contains('uiDialog'), el.classList.contains('uiDialog--lg')])).toEqual(['DIALOG', true, true, true]);
  const inside = () => page.evaluate(() => {
    const el = document.activeElement;
    return el === document.body || !!el?.closest('#analysisModal');
  });
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#analysisModal'))).toBe(true);
  // Tab and Shift+Tab never reach the page behind.
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await inside()).toBe(true);
  }
  // The page behind is inert: a click on it lands on the backdrop.
  expect(await page.evaluate(() => document.elementFromPoint(4, 4)?.id)).toBe('analysisModal');
  // Escape closes; the focus returns where it was when the dialog opened (the
  // run gave it back to the editor).
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('#queryTextArea')).toBeFocused();
  await expect(page.locator('#analysisContent')).toBeEmpty();

  // Reopened from the results Analyze button: the backdrop closes it, and the
  // focus goes back to that button.
  const analyze = page.locator('#analyzeQueryButton');
  if (await analyze.isVisible()) {
    await analyze.click();
    await expect(modal).toBeVisible();
    await page.mouse.click(6, page.viewportSize().height - 6);
    await expect(modal).toBeHidden();
    await expect(analyze).toBeFocused();
  }

  // The close button too; a click inside the dialog does not. Opened from
  // the editor, the focus goes back to it.
  await page.locator('#queryTextArea').focus();
  await page.evaluate(() => window.ChDash.analysis.open());
  await expect(modal).toBeVisible();
  await page.locator('#analysisModalTitle').click();
  await expect(modal).toBeVisible();
  await page.locator('#analysisCloseButton').click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#queryTextArea')).toBeFocused();
  // Opened with the focus nowhere (on <body>), it falls back to Analyze.
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => window.ChDash.analysis.open());
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  // (the results Profiling button, else Run).
  const fallback = (await analyze.isVisible()) ? analyze : page.locator('#runButton');
  await expect(fallback).toBeFocused();
});

test('no Ctrl+Enter hint beside Run: the shortcut is in its tooltip and still runs the query', async ({ page }) => {
  await openApp(page);
  // Nothing next to Run but the Run split, Format, the library and the cog.
  await expect(page.locator('#runShortcutHint')).toHaveCount(0);
  await expect(page.locator('.queryActions kbd')).toHaveCount(0);
  await expect(page.locator('.queryActions')).not.toContainText(/Ctrl|⌘|Enter/);
  await expect(page.locator('#runButton')).toHaveAttribute('title', /^Run \((Ctrl|⌘)\+Enter\)$/);
  // The shortcut itself runs the editor content.
  await page.locator('#queryTextArea').fill('SELECT 4242 AS shortcut_answer');
  await page.locator('#queryTextArea').press('ControlOrMeta+Enter');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished/i);
  await expect(page.locator('#resultTableBody')).toContainText('4242');
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
  await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  // Database detail meta is "<n> tables · <database bytes>"; the per-database
  // disk list was replaced by a per-object list with rows/footprint stats.
  await expect(page.locator('#explorerDetailMeta')).toContainText(/^\d[\d,]* objects · \d+(?:\.\d)? [KMGTP]?B$/);
  await expect(page.locator('#explorerDetailTabs')).toBeHidden();
  await expect(page.locator('#explorerDatabaseObjects tbody tr').first()).toBeVisible();
  await expect(page.locator('#explorerDatabaseObjects tbody tr[data-table="weather_observations"]'))
    .toContainText(/weather_observations\s*Merge Tree\s*[\d,]+/);
  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('station_dictionary');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/Dictionary/i);

  await page.getByText('weather_observations', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailMeta')).not.toContainText('unknown engine');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);

  // Header: chips (engine, health, rows, size, parts) instead of a dotted
  // sentence; no ingress rate.
  const chips = page.locator('#explorerDetailMeta .explorerMetaChip');
  await expect(chips.first()).toHaveText('Merge Tree');
  await expect(page.locator('#explorerDetailMeta .explorerMetaChip--health .explorerHealthDot--healthy')).toBeVisible();
  await expect(page.locator('#explorerDetailMeta .explorerMetaChip--rows')).toHaveText(/^[\d,]+ rows$/);
  await expect(page.locator('#explorerDetailMeta .explorerMetaChip--size')).toHaveText(/on disk$/);
  await expect(page.locator('#explorerDetailMeta .explorerMetaChip--parts')).toHaveText(/^\d+ parts?$/);
  await expect(page.locator('#explorerDetailMeta')).not.toContainText('rows/s');

  // Columns first; tabs without content are hidden. Operations appears only
  // when merges, mutations or writes exist, otherwise About says "Idle".
  const detailTabs = page.locator('#explorerDetailTabs').getByRole('tab');
  const tabNames = await detailTabs.allTextContents();
  expect(tabNames.filter((name) => name !== 'Operations')).toEqual(['Columns', 'Preview', 'Storage', 'Lineage', 'DDL']);
  if (!tabNames.includes('Operations')) await expect(page.locator('.explorerAboutTile[data-tile="activity"]')).toContainText('Idle');
  const columns = page.locator('#explorerDetailContent .explorerColumnsTable');
  await expect(columns).toBeVisible();
  for (const header of ['Column', 'Type', 'Keys', 'Compressed', 'Ratio', '% table']) {
    await expect(columns.locator('thead th', { hasText: header }).first()).toBeVisible();
  }
  const observationDate = columns.locator('tbody tr').filter({ hasText: 'observation_date' }).first();
  await expect(observationDate.locator('.explorerBadge--order-by')).toBeVisible();
  await expect(observationDate.locator('.explorerBadge--partition')).toBeVisible();
  await expect(observationDate).toContainText(/MATERIALIZED\s*toDate\(observed_at\)/);
  const temperature = columns.locator('tbody tr').filter({ hasText: 'temperature_c' }).first();
  await expect(temperature).toContainText(/\d+(?:\.\d+)?\s*[KMG]?B/);
  await expect(columns.locator('.explorerStoragePercentCell').first()).toBeVisible();
  // Numbering starts at 1 for every table.
  await expect(columns.locator('tbody tr').first().locator('td').first()).toHaveText('1');

  // About: value + context tiles beside the tab body.
  const about = page.locator('#explorerDetailContent .explorerAbout');
  await expect(about).toBeVisible();
  await expect(about.locator('[data-tile="engine"]')).toContainText('Merge Tree');
  await expect(about.locator('[data-tile="size"]')).toContainText(/rows/);
  await expect(about.locator('[data-tile="sorting_key"]')).toContainText('station_id');
  await expect(about.locator('[data-tile="ttl"]')).toContainText(/3 rules/);
  await expect(about.locator('[data-tile="ttl"] li').nth(1)).toContainText(/60 d .*TO VOLUME/);
  await expect(about.locator('[data-tile="storage_policy"]')).toContainText('fixture_tiered');
  await expect(about.locator('[data-tile="share"]')).toContainText(/% of chdash_ui/);

  const lineageTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Lineage', exact: true });
  await lineageTab.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/lineage$/);
  const lineage = page.locator('#explorerDetailContent .explorerDependencyMatrix');
  await expect(lineage).toBeVisible();
  // Same-database objects use their short name; the tooltip keeps the full one.
  const upstream = lineage.locator('.explorerDependencyGroup[data-relation="upstream"] .explorerLineageChip').first();
  await expect(upstream.locator('.explorerLineageChip__name')).toHaveText('weather_buffer');
  await expect(upstream).toHaveAttribute('title', /^chdash_ui\.weather_buffer/);
  await expect(upstream.locator('.explorerObjIcon--buffer')).toBeVisible();
  await expect(lineage.locator('.explorerDependencyGroup[data-relation="downstream"]')).toContainText('weather_daily_summary_mv');

  const ddlTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'DDL', exact: true });
  await ddlTab.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/ddl$/);
  await expect(page.locator('#explorerDetailContent .explorerDdlWrap')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('temperature_c');

  const previewTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Preview', exact: true });
  await previewTab.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/preview$/);
  const explorerResults = page.locator('#explorerDetailContent .tableWrap .resultTable');
  await expect(explorerResults).toBeVisible({ timeout: 12_000 });
  await expect(explorerResults).toContainText('WX-');
  await expect(explorerResults).toContainText(/Paris|Reykjavik|Lisbon/);
  await expect(explorerResults).toContainText('synthetic-weather');
  // Row count + limit, column type sub-header, raw timestamps.
  await expect(page.locator('.explorerPreviewToolbar__count')).toHaveText('100 rows (LIMIT 100)');
  await expect(explorerResults.locator('thead th[data-type="DateTime64(3)"]')).toHaveText('observed_at');
  // Preview cells are result data: the DateTime64 stays as the API sent it (decision 45).
  await expect(explorerResults.locator('tbody tr').first().locator('td').nth(1)).toHaveText(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  await page.locator('.explorerSegmented__option', { hasText: /^50$/ }).click();
  await expect(page.locator('.explorerPreviewToolbar__count')).toHaveText('50 rows (LIMIT 50)', { timeout: 12_000 });
  await expect(explorerResults.locator('tbody tr')).toHaveCount(50);
  await page.locator('.explorerSegmented__option', { hasText: /^100$/ }).click();
  await expect(page.locator('.explorerPreviewToolbar__count')).toHaveText('100 rows (LIMIT 100)', { timeout: 12_000 });

  const storageTab = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true });
  await storageTab.click();
  await expect(storageTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/storage$/);
  const composition = page.locator('#explorerDetailContent .explorerStorageCompositionCard');
  await expect(composition).toBeVisible();
  await expect(composition).toContainText('Table storage');
  await expect(composition.locator('.explorerStorageStackedBar__segment').first()).toBeVisible();
  // Storage: disks, parts, partitions, indexes, projections (no merges/ingestion).
  for (const section of ['disks', 'parts', 'partitions', 'indexes', 'projections']) {
    await expect(page.locator(`#explorerDetailContent .explorerSection[data-section="${section}"]`)).toBeVisible();
  }
  await expect(page.locator('#explorerDetailContent .explorerSection[data-section="merges"]')).toHaveCount(0);
  const parts = page.locator('#explorerDetailContent .explorerTable--parts');
  const partHeaders = (await parts.locator('thead th').allTextContents()).map((text) => text.trim());
  expect(partHeaders).toEqual(['#', 'Part', 'Partition', 'Disk', 'Rows', 'Bytes', 'Marks', 'Files', 'Level', 'Age', 'State']);
  // Headers are fully readable, never ellipsized.
  const clipped = await parts.locator('thead th').evaluateAll((cells) => cells.filter((th) => th.scrollWidth > th.clientWidth + 1).length);
  expect(clipped).toBe(0);
  const indexes = page.locator('#explorerDetailContent .explorerStorageResultTable--indexes');
  await expect(indexes.locator('tbody tr').first().locator('td').first()).toHaveText('1');
  // Collapsible sections.
  const partsSummary = page.locator('#explorerDetailContent .explorerSection[data-section="parts"] > summary');
  await partsSummary.click();
  await expect(parts).toBeHidden();
  await partsSummary.click();
  await expect(parts).toBeVisible();

  // An old /data deep link opens Preview; an old /schema one opens Columns.
  await page.goto('/explorer/chdash_ui/weather_observations/data');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/preview$/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Preview', exact: true })).toHaveAttribute('aria-selected', 'true');

  await page.goto('/explorer/chdash_ui/weather_observations/schema');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);
  await expect(page.locator('#explorerDetailContent .explorerColumnsTable')).toBeVisible();

  const reloadedDdl = page.locator('#explorerDetailTabs').getByRole('tab', { name: 'DDL', exact: true });
  await reloadedDdl.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/ddl$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Columns', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailContent .explorerColumnsTable')).toContainText('temperature_c');
  await page.locator('#explorerFunctionsTab').click();
  await expect(page.locator('#explorerFunctionsPane')).toBeVisible();
  await page.locator('#explorerFunctionSearchInput').fill('array');
  const firstFunctionName = await page.locator('#explorerFunctionList .explorerFunctionObject .explorerTreeObject__name').first().textContent();
  expect(String(firstFunctionName || '').toLowerCase().startsWith('array')).toBeTruthy();
});

test('explorer renders MV lineage, engine-specific tables, TTL and separate DDL', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);

  await page.getByText('weather_daily_summary_mv', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Materialized View');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab')).toHaveText(['Columns', 'Lineage', 'DDL']);
  // About names the MV target as a lineage chip.
  await expect(page.locator('.explorerAboutTile[data-tile="target"] .explorerLineageChip')).toContainText('weather_daily_summary');
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Lineage', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerDependencyGroup[data-relation="upstream"]')).toContainText('weather_observations');
  await expect(page.locator('#explorerDetailContent .explorerDependencyGroup[data-relation="downstream"]')).toContainText('weather_daily_summary');
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'DDL', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerDdlGutter')).toBeVisible();
  await expect(page.locator('#explorerDetailContent .explorerDdlCopy')).toBeVisible();

  await page.getByText('weather_observations', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText(/(?:INTERVAL\s+60\s+DAY|toIntervalDay\(60\)).*TO VOLUME/i);
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('temperature_c');
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Schema', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Overview', exact: true })).toHaveCount(0);
  // TTL moves parts to the cold volume, so the storage policy is tiered.
  await expect(page.locator('.explorerAboutTile[data-tile="storage_policy"]')).toContainText('fixture_tiered');

  await page.getByText('memory_weather', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Memory');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/RAM/);
  const memoryTabs = await page.locator('#explorerDetailTabs').getByRole('tab').allTextContents();
  expect(memoryTabs.filter((name) => !['Operations', 'Lineage'].includes(name))).toEqual(['Columns', 'Preview', 'DDL']);
  expect(memoryTabs).not.toContain('Storage');
  await expect(page.locator('.explorerAboutTile[data-tile="share"]')).toHaveCount(0);

  await page.getByText('weather_buffer', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Buffer');
  await expect(page.locator('.explorerAboutTile[data-tile="target"]')).toContainText('Flushes to');
  await expect(page.locator('.explorerAboutTile[data-tile="target"] .explorerLineageChip')).toContainText('weather_observations');
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Lineage', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerDependencyGroup[data-relation="downstream"]')).toContainText('weather_observations');

  // Log-family tables are disk-backed: a Storage tab with their disks only
  // (no parts, partitions, merges or composition bar).
  await page.getByText('station_dictionary_source', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Tiny Log');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/on disk/);
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerStorageCompositionCard')).toHaveCount(0);
  await expect(page.locator('#explorerDetailContent .explorerSection[data-section="disks"]')).toContainText('storage medium');
  await expect(page.locator('#explorerDetailContent .explorerSection[data-section="parts"]')).toHaveCount(0);
  await expect(page.locator('#explorerDetailContent .explorerTable--disks thead')).not.toContainText('Parts');

  await page.getByText('station_dictionary', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailMeta')).toContainText('Dictionary');
  // Dictionary memory footprint is reported in the header ("<bytes> RAM").
  await expect(page.locator('#explorerDetailMeta')).toContainText(/\d+(?:\.\d+)?\s*[KMG]?B RAM/);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true })).toHaveCount(0);
  await expect(page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Operations', exact: true })).toHaveCount(0);
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'DDL', exact: true }).click();
  await expect(page.locator('#explorerDetailContent .explorerDdl')).toContainText('CREATE DICTIONARY');
});

test('replicated and Distributed tables show replication first and their local table', async ({ page }) => {
  await openApp(page);
  await page.goto('/explorer/chdash_repl/replicated_events/columns');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_repl.replicated_events', { timeout: 15_000 });
  // Replication banner at the top of the card.
  const banner = page.locator('#explorerSummaryCards .explorerReplicaBanner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Replicated\s*2\/2 replicas active · queue \d+ · delay \d+ s/);
  await expect(page.locator('.explorerAboutTile[data-tile="replicas"]')).toContainText('2/2 active');
  await expect(page.locator('.explorerAboutTile[data-tile="replicas"] .explorerReplicaChip')).toHaveCount(2);
  // The tree marks replicated tables with a health dot.
  await expect(page.locator('.explorerTreeObject[data-table="replicated_events"] .explorerTreeHealthDot')).toBeVisible();
  await banner.getByRole('button', { name: 'Details' }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_repl\/replicated_events\/operations$/);
  const replication = page.locator('#explorerDetailContent .explorerSection[data-section="replication"]');
  await expect(replication).toBeVisible();
  await expect(replication).toContainText('Keeper path');
  // Empty sections collapse into one muted line.
  await expect(page.locator('#explorerDetailContent .explorerIdleLine')).toContainText('Replication queue empty');

  await page.goto('/explorer/chdash_repl/replicated_events_all/columns');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_repl.replicated_events_all', { timeout: 15_000 });
  await expect(page.locator('#explorerSummaryCards')).toBeHidden();
  // No meaningless 0 B size for a Distributed table, no byte columns.
  await expect(page.locator('#explorerDetailMeta .explorerMetaChip--size')).toHaveCount(0);
  await expect(page.locator('#explorerDetailContent .explorerColumnsTable thead')).not.toContainText('Compressed');
  const local = page.locator('.explorerAboutTile[data-tile="local_table"]');
  await expect(local).toContainText('replicated_events');
  await expect(local).toContainText('chdash_cluster');
  await expect(page.locator('.explorerAboutTile[data-tile="cluster"]')).toContainText(/1 shard · 2 replicas/);
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Lineage', exact: true }).click();
  const route = page.locator('#explorerDetailContent .explorerLineage .explorerLineageChip[data-kind="distributed_route"]');
  await expect(route).toContainText('replicated_events');
  await expect(route).toContainText('on chdash_cluster');
  await route.click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_repl.replicated_events');
});

for (const scheme of ['dark', 'light']) {
  test(`table card on a phone (${scheme}): About above the tabs body, no page overflow, scrollable tables`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((theme) => { try { localStorage.setItem('chdash.theme', theme); } catch (_) {} }, scheme);
    await openApp(page);
    await page.goto('/explorer/chdash_ui/weather_observations/columns');
    await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
    const about = page.locator('#explorerDetailContent .explorerAbout');
    const columns = page.locator('#explorerDetailContent .explorerColumnsTable');
    await expect(columns).toBeVisible();
    // Narrow pane: About sits above the tab body, collapsed to its first tiles.
    expect((await about.boundingBox()).y).toBeLessThan((await columns.boundingBox()).y);
    await expect(about).toHaveClass(/is-collapsed/);
    await expect(about.locator('.explorerAboutTile').nth(4)).toBeHidden();
    await about.getByRole('button', { name: /Show all/ }).click();
    await expect(about.locator('.explorerAboutTile').nth(4)).toBeVisible();
    // Wide tables scroll inside their own wrapper, never the page.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    const chipsFit = await page.locator('#explorerDetailMeta .explorerMetaChip').evaluateAll((chips) => chips.every((chip) => chip.getBoundingClientRect().right <= window.innerWidth));
    expect(chipsFit).toBe(true);
    // Health dot uses the theme's status colour.
    const dot = await page.locator('#explorerDetailMeta .explorerHealthDot').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(dot).toBe(scheme === 'light' ? 'rgb(21, 128, 61)' : 'rgb(52, 211, 153)');
  });
}

test('graph table click keeps graph focus, browser selection and URL on the same table', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.getByText('weather_observations', { exact: true }).first().click();
  await page.locator('#explorerModeGraph').click();
  await expect(page.locator('#explorerGraphPane')).toBeVisible();
  // The graph is a canvas, so use the exported selection bridge to exercise the
  // same path as a logical-node click without relying on fragile pixel positions.
  await page.evaluate(() => window.ChDash.explorer.selectTable('chdash_ui', 'wide_types'));
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?mode=graph&graph=lineage&depth=1$/);
  await page.locator('#explorerModeBrowse').click();
  await expect(page.locator('.explorerTreeObject.is-selected')).toContainText('wide_types');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');
});

// Database detail object table (under the storage band): display-order snapshot of
// every row, numeric cells carry their raw value in data-value.
const DATABASE_OBJECT_HEADERS = ['#', 'Name', 'Engine', 'Rows', 'Size', 'Compressed', 'Ratio', '% database', 'Parts', 'Modified'];
const DATABASE_OBJECT_NUMERIC = (column) => column >= 2 && column <= 7;

async function databaseObjectRows(page) {
  return page.locator('#explorerDatabaseObjects tbody tr').evaluateAll((rows) => rows.map((tr) => ({
    name: tr.dataset.table,
    cells: [...tr.children].slice(1).map((td) => ({ text: td.textContent.trim(), value: td.dataset.value ?? null })),
  })));
}

function textSortKey(value) { return String(value).toLowerCase(); }

// Clicks a header and checks the displayed order: present values monotonic in
// the header's direction (numbers compared as numbers), missing values last.
async function expectObjectColumnSorted(page, column, direction) {
  const header = page.locator('#explorerDatabaseObjects thead th').nth(column + 1);
  await header.click();
  await expect(header).toHaveAttribute('data-sort', direction);
  const rows = await databaseObjectRows(page);
  const numeric = DATABASE_OBJECT_NUMERIC(column);
  const keys = rows.map((row) => {
    const cell = row.cells[column];
    if (numeric) return cell.value === '' || cell.value == null ? null : Number(cell.value);
    return cell.text === '—' ? null : textSortKey(cell.text);
  });
  const firstMissing = keys.indexOf(null);
  if (firstMissing >= 0) expect(keys.slice(firstMissing).every((key) => key === null), `column ${column}: missing values last`).toBe(true);
  const present = firstMissing >= 0 ? keys.slice(0, firstMissing) : keys;
  for (let index = 1; index < present.length; index++) {
    const ordered = direction === 'asc' ? present[index - 1] <= present[index] : present[index - 1] >= present[index];
    expect(ordered, `column ${column} ${direction} at ${index}: ${present[index - 1]} / ${present[index]}`).toBe(true);
  }
  return rows;
}

test('database detail lists every object under the storage band, sorts each column and opens a table', async ({ page }) => {
  const catalogResponse = page.waitForResponse((response) => response.url().includes('api/explorer/catalog') && response.url().includes('database=chdash_ui'));
  await openApp(page);
  await openExplorerDatabase(page);
  const catalog = await (await catalogResponse).json();
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  const objects = page.locator('#explorerDatabaseObjects');
  await expect(objects).toBeVisible();
  await expect(objects.locator('.resultTable thead th')).toHaveText(DATABASE_OBJECT_HEADERS);
  await expect(objects.locator('thead th.resultTable__thSortable')).toHaveCount(DATABASE_OBJECT_HEADERS.length);
  // Placed under the compact storage band.
  const storageBox = await page.locator('#explorerDetailContent .explorerDatabaseStorage').boundingBox();
  const tableBox = await objects.boundingBox();
  expect(tableBox.y).toBeGreaterThan(storageBox.y + storageBox.height - 1);

  // One row per object of the database, alphabetical by default.
  const expectedNames = catalog.tables.map((table) => table.name).sort((a, b) => a.localeCompare(b));
  let rows = await databaseObjectRows(page);
  expect(rows.map((row) => row.name)).toEqual(expectedNames);
  expect(rows.length).toBeGreaterThan(10);

  const weather = rows.find((row) => row.name === 'weather_observations').cells;
  const weatherSummary = catalog.tables.find((table) => table.name === 'weather_observations');
  expect(weather[1].text).toBe('Merge Tree');
  expect(Number(weather[2].value)).toBe(weatherSummary.rows);
  expect(Number(weather[3].value)).toBe(weatherSummary.bytes);
  // One byte format: one decimal and a unit (10.3 MB); rows are grouped.
  expect(weather[2].text).toBe(Number(weatherSummary.rows).toLocaleString('en-US'));
  expect(weather[3].text).toMatch(/^\d+\.\d [KMG]B$/);
  expect(weather[4].text).toMatch(/^\d+\.\d [KMG]B$/);
  // Uncompressed bytes moved into the Ratio tooltip (the table fits 1280 px).
  expect(weather[5].text).toMatch(/^\d+\.\d\d×$/);
  await expect(objects.locator('tbody tr[data-table="weather_observations"] td').nth(6)).toHaveAttribute('title', /uncompressed .* compressed/);
  expect(Number(weather[6].value)).toBeGreaterThan(50);
  expect(weather[6].text).toMatch(/^\d+(?:\.\d)?%$/);
  expect(Number(weather[7].value)).toBe(weatherSummary.active_parts);
  // Modified: the server's DateTime in the browser's zone, 24 h (decision
  // 48); the tooltip carries ISO, local, UTC and the server's zone.
  expect(weather[8].text).toMatch(/^[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d\d:\d\d:\d\d$/);
  await expect(objects.locator('tbody tr[data-table="weather_observations"] td').nth(9)).toHaveAttribute('title', /^\d{4}-\d\d-\d\dT[\d:.]+Z\n.* local \(.*\n.* UTC\n.* server \(/);
  // Resident memory is labelled and never takes a share of the on-disk total.
  const memory = rows.find((row) => row.name === 'memory_weather').cells;
  expect(memory[3].text).toMatch(/RAM$/);
  expect(memory[6].text).toBe('—');
  // Views have no storage: dashes, not zeros.
  const view = rows.find((row) => row.name === 'valid_weather_observations').cells;
  expect(view[1].text).toBe('View');
  expect(view[3].text).toBe('—');
  // Rows / bytes / share columns use the shared Explorer in-cell bar,
  // normalised to the column maximum (the largest object fills the cell).
  const weatherSize = objects.locator('tbody tr[data-table="weather_observations"] td').nth(4);
  await expect(weatherSize).toHaveClass(/explorerBar/);
  expect(await weatherSize.evaluate((td) => td.style.getPropertyValue('--bar-pct'))).toBe('100%');

  // Text columns start ascending, numeric ones descending; each toggles.
  for (let column = 0; column < 9; column++) {
    const numeric = DATABASE_OBJECT_NUMERIC(column);
    const first = numeric ? 'desc' : 'asc';
    const second = numeric ? 'asc' : 'desc';
    rows = await expectObjectColumnSorted(page, column, first);
    if (column === 3) expect(rows[0].name).toBe('weather_observations');
    rows = await expectObjectColumnSorted(page, column, second);
  }

  await objects.locator('.explorerDatabaseObjectsTable__open', { hasText: /^weather_observations$/ }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');
  await expect(page.locator('#explorerDatabaseObjects')).toHaveCount(0);
});

test('database object table handles hundreds of tables and empty databases', async ({ page }) => {
  // Synthetic catalogs through the real endpoint: 300 tables whose sizes sort
  // differently as text and as numbers, and a database without objects.
  const count = 300;
  const synthetic = Array.from({ length: count }, (_, index) => {
    const bytes = (index % 7 + 1) * 10 ** (index % 6);
    return {
      database: 'chdash_perf',
      name: `t_${String(index).padStart(3, '0')}`,
      engine: 'MergeTree',
      metadata_modification_time: '2026-09-01 00:00:00',
      rows: (index * 37) % 1000,
      bytes,
      compressed_bytes: bytes,
      uncompressed_bytes: bytes * (index % 4 + 1),
      active_parts: index % 11,
      last_part_time: `2026-09-${String(index % 28 + 1).padStart(2, '0')} 10:00:00`,
    };
  });
  await page.route(/\/api\/explorer\/catalog\?.*database=(chdash_perf|otel)(?:&|$)/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.tables = route.request().url().includes('database=otel') ? [] : synthetic;
    await route.fulfill({ response, json });
  });
  await openApp(page);
  await openExplorerDatabase(page, 'chdash_perf');
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_perf' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_perf');
  await expect(page.locator('#explorerDetailMeta')).toContainText(`${count} objects`);
  await expect(page.locator('#explorerDatabaseObjects tbody tr')).toHaveCount(count);

  const sizeHeader = page.locator('#explorerDatabaseObjects thead th').nth(4);
  const elapsedMs = await sizeHeader.evaluate((th) => {
    const started = performance.now();
    th.click();
    return performance.now() - started;
  });
  expect(elapsedMs).toBeLessThan(1000);
  await expect(sizeHeader).toHaveAttribute('data-sort', 'desc');
  const maxBytes = Math.max(...synthetic.map((table) => table.bytes));
  const rows = await databaseObjectRows(page);
  expect(Number(rows[0].cells[3].value)).toBe(maxBytes);
  expect(rows[0].cells[3].text).toMatch(/^\d+\.\d [KM]B$/);
  const sizes = rows.map((row) => Number(row.cells[3].value));
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  await expectObjectColumnSorted(page, 3, 'asc');
  await expectObjectColumnSorted(page, 2, 'desc');
  await expectObjectColumnSorted(page, 7, 'desc');

  await expandExplorerDatabase(page, 'otel');
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'otel' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('otel');
  await expect(page.locator('#explorerDetailMeta')).toContainText(/^0 objects/);
  // One empty state: no empty storage section above an empty object table.
  await expect(page.locator('#explorerDetailContent')).toHaveText('No objects in this database.');
  await expect(page.locator('#explorerDetailContent .explorerSectionTitle')).toHaveCount(0);
  await expect(page.locator('#explorerDatabaseObjects')).toHaveCount(0);
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

  // Storage: flat part-format / projection / index composition of the table footprint.
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Storage', exact: true }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/storage$/);
  const composition = page.locator('#explorerDetailContent .explorerStorageCompositionCard');
  await expect(composition).toBeVisible();
  await expect(composition.locator('.explorerStorageStackedBar__segment').first()).toBeVisible();
  const legendLabels = await composition.locator('.explorerStorageCompositionLegend__label').allTextContents();
  expect(legendLabels).toEqual(expect.arrayContaining(['Projections', 'Indexes']));
  expect(legendLabels.some((label) => label === 'Wide' || label === 'Compact')).toBeTruthy();

  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--indexes')).toContainText('idx_wide_types_state');
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--projections')).toContainText('prj_wide_types_state');
  await expect(page.locator('#explorerDetailContent .explorerStorageResultTable--projections .explorerStoragePercentCell').first()).toHaveText(/%/);

  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'DDL', exact: true }).click();
  const keywordTexts = await page.locator('#explorerDetailContent .explorerDdl .tok-kw').allTextContents();
  for (const keyword of ['INDEX', 'PROJECTION', 'TYPE', 'GRANULARITY']) {
    expect(keywordTexts.map((value) => value.toUpperCase())).toContain(keyword);
  }

  // Columns: per-column table with collapsible Tuple children.
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Columns', exact: true }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/columns$/);
  const columnStorage = page.locator('#explorerDetailContent .explorerStorageResultTable--columns');
  await expect(columnStorage).toBeVisible();
  const tupleChild = columnStorage.locator('tbody tr').filter({ hasText: 'tuple_value.code' }).first();
  await expect(tupleChild).toBeHidden();
  await columnStorage.getByRole('button', { name: 'Expand tuple_value', exact: true }).click();
  await expect(tupleChild).toBeVisible();

  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Preview', exact: true }).click();
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

test('right-click Details expands a result row inline, under the row, and closes only from its cross, Escape inside it or another Details', async ({ page }) => {
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
    const bar = (el) => {
      const cs = getComputedStyle(el, '::before');
      return { bg: cs.backgroundColor, width: cs.width, left: cs.left, top: cs.top, z: cs.zIndex };
    };
    return {
      row: inner(index), detail: inner(detail), rowBar: bar(index), detailBar: bar(detail),
      gap: detail.getBoundingClientRect().top - index.getBoundingClientRect().bottom,
    };
  });
  expect(Math.abs(bars.row - bars.detail)).toBeLessThan(0.5);
  // Same colour, drawn above the detail content (nothing tints it), and the
  // detail bar starts over the row's bottom border to meet the row bar.
  expect(bars.rowBar.bg).toBe('rgb(37, 99, 235)');
  expect(bars.detailBar.bg).toBe(bars.rowBar.bg);
  expect([bars.rowBar.width, bars.detailBar.width]).toEqual(['3px', '3px']);
  expect([bars.rowBar.left, bars.detailBar.left]).toEqual(['0px', '0px']);
  expect(bars.detailBar.top).toBe('-1px');
  expect(bars.detailBar.z).toBe('1');
  expect(Math.abs(bars.gap)).toBeLessThanOrEqual(1);
  // Result table wraps do not reserve a scrollbar gutter.
  expect(await page.locator('#resultTableBody').evaluate((tbody) => getComputedStyle(tbody.closest('.tableWrap')).scrollbarGutter)).toBe('auto');
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
  await expect(values.nth(6).locator('.nullToken')).toHaveText('NULL');
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

  // Clicks on another row or elsewhere on the page keep it open.
  await rows.nth(4).locator('td').nth(1).click();
  await page.locator('#resultsPanel .panel__header').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await expect(row3).toHaveClass(/is-rowExpanded/);
  // Escape outside the detail does not close it either.
  await page.locator('#queryTextArea').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await page.locator('.rowDetails__close').click();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(0);
  await expect(row3).not.toHaveClass(/is-rowExpanded/);

  // Only one expanded row at a time.
  await openRowDetailsFromRow(page, rows.nth(1));
  await openRowDetailsFromRow(page, rows.nth(3));
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await expect(rows.nth(1)).not.toHaveClass(/is-rowExpanded/);
  await expectDetailRightAfter(rows.nth(3));

  await page.locator('.rowDetails__close').click();
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

test('row menu Details on another row replaces the open detail, and copies a cell, the row or the column', async ({ page }) => {
  await openApp(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // Enough rows for the page to scroll past an open detail.
  await runSuccessfulQuery(page, rowDetailsQuery.replace('numbers(6)', 'numbers(60)'));
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await expect(rows.nth(5)).toBeVisible();
  // Outside a secure context the app copies through a hidden textarea:
  // capture what that copy selects (or read the clipboard when available).
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') {
        window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
      }
    }, true);
  });
  const readClipboard = () => page.evaluate(async () => {
    if (window.isSecureContext && navigator.clipboard) {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  });

  // The menu offers Details, Copy cell, Copy row and Copy column, with no
  // hint line, in compact items; the row shows its accent bar meanwhile.
  await rows.nth(2).locator('td').nth(2).click({ button: 'right' });
  const menu = page.locator('.rowDetailsMenu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Details', 'Copy cell', 'Copy row', 'Copy column']);
  await expect(menu).not.toContainText(/shift/i);
  expect((await menu.getByRole('menuitem').first().boundingBox()).height).toBeLessThanOrEqual(28);
  await expect(rows.nth(2)).toHaveClass(/is-rowMenuTarget/);
  expect(await rows.nth(2).locator('td.resultTable__rowIndex').evaluate((td) => getComputedStyle(td, '::before').backgroundColor)).toBe('rgb(37, 99, 235)');
  // Hovering an action lights exactly what it copies.
  const lit = () => page.evaluate(() => [...document.querySelectorAll('.is-copyTarget')].map((el) => {
    const tr = el.parentElement;
    return `${tr.parentElement.tagName}:${[...tr.parentElement.children].indexOf(tr)}:${el.cellIndex}`;
  }));
  const fill = () => page.evaluate(() => [...new Set([...document.querySelectorAll('td.is-copyTarget')].map((el) => {
    const cs = getComputedStyle(el);
    return `${cs.backgroundColor}|${cs.boxShadow}`;
  }))]);
  await menu.getByRole('menuitem', { name: 'Copy cell' }).hover();
  await expect.poll(lit).toEqual(['TBODY:2:2']);
  const cellFill = await fill();
  expect(cellFill).toHaveLength(1);
  await menu.getByRole('menuitem', { name: 'Copy row' }).hover();
  await expect.poll(async () => (await lit()).length).toBe(await rows.nth(2).locator('td').count());
  expect((await lit()).every((key) => key.startsWith('TBODY:2:'))).toBe(true);
  // Same highlight as Copy cell (the index cell keeps its accent bar).
  expect((await fill()).filter((f) => f !== cellFill[0]).length).toBeLessThanOrEqual(1);
  await menu.getByRole('menuitem', { name: 'Copy column' }).hover();
  await expect.poll(async () => (await lit()).every((key) => key.endsWith(':2'))).toBe(true);
  expect((await lit())[0]).toBe('THEAD:0:2');
  expect((await lit()).length).toBeGreaterThan(6);
  expect(await fill()).toEqual(cellFill);
  // Copy cell: the right-clicked cell only (`name` of row 3).
  await menu.getByRole('menuitem', { name: 'Copy cell' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.is-copyTarget')).toHaveCount(0);
  await expect(rows.nth(2)).not.toHaveClass(/is-rowMenuTarget/);
  await expect.poll(readClipboard).toBe('name-2');
  // Copy column: a JSON array of the column's values, in data order.
  await rows.nth(2).locator('td').nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy column' }).click();
  await expect.poll(async () => { try { return JSON.parse(await readClipboard()).slice(0, 3); } catch { return null; } }).toEqual(['name-0', 'name-1', 'name-2']);
  expect(JSON.parse(await readClipboard())).toHaveLength(60);
  await rows.nth(2).locator('td').nth(3).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy column' }).click();
  await expect.poll(async () => { try { return JSON.parse(await readClipboard())[2]; } catch { return null; } }).toEqual([0, 1, 2]);
  // Copy row: the whole row as JSON (tuple flattened like the table).
  await rows.nth(2).locator('td').nth(2).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy row' }).click();
  await expect.poll(async () => JSON.parse(await readClipboard()).name).toBe('name-2');
  const copiedRow = JSON.parse(await readClipboard());
  expect(Object.keys(copiedRow)).toEqual(['id', 'name', 'arr', 'm', 'tup.code', 'tup.label', 'maybe', 'long_text']);
  expect(copiedRow.arr).toEqual([0, 1, 2]);

  // Details on row 1, then scroll so its top is above the viewport: picking
  // Details on another row closes the old detail (which scrolls to keep the
  // rows in place) and must still open the new one.
  await openRowDetailsFromRow(page, rows.nth(0));
  await page.evaluate(() => {
    const detail = document.querySelector('#resultTableBody tr.resultTable__detailRow');
    const ws = document.getElementById('queryWorkspace');
    const owner = ws && ws.scrollHeight > ws.clientHeight + 1 ? ws : document.scrollingElement;
    const ownerTop = owner === document.scrollingElement ? 0 : owner.getBoundingClientRect().top;
    owner.scrollTop += detail.getBoundingClientRect().top - ownerTop + 60;
  });
  const next = rows.nth(1);
  await next.locator('td').nth(2).click({ button: 'right' });
  await expect(menu).toBeVisible();
  // A human press keeps the button down long enough for the scroll that
  // compensates the closing detail to land before the click.
  const box = await menu.getByRole('menuitem', { name: 'Details' }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await expect(page.locator('.rowDetails')).toHaveAttribute('data-row', '2');
  await expect(next).toHaveClass(/is-rowExpanded/);
  await expect(rows.nth(0)).not.toHaveClass(/is-rowExpanded/);
  await expectDetailRightAfter(next);

  // The expanded row's highlight fills its numeric gauge cells edge to edge
  // (the gauge bar is clipped to the content box, the row colour is not).
  const gaugeClip = await next.locator('td.resultTable__gaugeCell').first().evaluate((td) => getComputedStyle(td).backgroundClip);
  expect(gaugeClip).toBe('content-box, padding-box');

  // The close button is frameless, like the editor options cog.
  const close = page.locator('.rowDetails__close');
  const frame = await close.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderTopWidth, shadow: cs.boxShadow, bg: cs.backgroundColor };
  });
  expect(frame.border).toBe('0px');
  expect(frame.shadow).toBe('none');
  expect(frame.bg).toBe('rgba(0, 0, 0, 0)');
  // Hover highlights the cross itself: its colour changes, no shape appears.
  const idleColor = await close.evaluate((el) => getComputedStyle(el).color);
  const copyBtn = page.locator('.rowDetails__copy');
  const copyIdle = await copyBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.opacity, cs.backgroundColor, cs.color, cs.borderTopColor].join('|');
  });
  await close.hover();
  await expect.poll(() => close.evaluate((el) => getComputedStyle(el).color)).not.toBe(idleColor);
  const hovered = await close.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
  });
  expect(hovered).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
  // …and leaves Copy JSON next to it untouched.
  expect(await copyBtn.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.opacity, cs.backgroundColor, cs.color, cs.borderTopColor].join('|');
  })).toBe(copyIdle);
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

  // Opening another row's Details while this one is above the viewport
  // closes it without moving the rows the user is looking at.
  await scrollBy(Math.round(open.detail) + 40 * 32);
  await page.waitForTimeout(60);
  const before = await visibleRowIndex();
  expect(before).toBeGreaterThan(index);
  await openRowDetailsFromRow(page, rowFor(before + 10));
  await expect(body.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await expect(body.locator('.rowDetails')).toHaveAttribute('data-row', String(before + 10));
  await page.waitForTimeout(60);
  expect(Math.abs((await visibleRowIndex()) - before)).toBeLessThanOrEqual(1);
  await body.locator('.rowDetails__close').click();
  await expect(body.locator('tr.resultTable__detailRow')).toHaveCount(0);
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
  await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
  await view.locator('.rowDetails__close').click();
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

test('Explorer Preview cells stay raw like Query results: no grouping, no compact numbers, dates as returned', async ({ page }) => {
  await openApp(page);
  const response = page.waitForResponse((r) => r.url().includes('/api/explorer/table/data') && r.request().method() === 'POST');
  await page.goto('/explorer/chdash_ui/weather_observations/preview');
  const data = await (await response).json();
  const previewTable = page.locator('#explorerDetailContent .explorerResultTable--preview');
  await expect(previewTable.locator('tbody tr').first()).toBeVisible({ timeout: 12_000 });
  const headers = (await previewTable.locator('thead th').allTextContents()).map((text) => text.trim());
  const names = data.columns.map((column) => column.name);
  const cells = (rowIndex, name) => previewTable.locator(`tbody ${dataRowsSelector}`).nth(rowIndex).locator('td').nth(headers.indexOf(name));
  expect(headers.indexOf('id')).toBeGreaterThan(0);
  expect(headers.indexOf('observed_at')).toBeGreaterThan(0);
  for (let row = 0; row < 5; row += 1) {
    const source = data.rows[row];
    // UInt64 120064 stays "120064": the value as sent, never "120,064" or "120.1K".
    const id = String(source[names.indexOf('id')]);
    await expect(cells(row, 'id')).toHaveText(id);
    await expect(cells(row, 'id')).toHaveText(/^\d+$/);
    // DateTime64 stays as returned (no shortening, no zone conversion).
    await expect(cells(row, 'observed_at')).toHaveText(String(source[names.indexOf('observed_at')]));
    // A data NULL is the shared NULL token.
    const note = source[names.indexOf('notes')];
    if (note === null) await expect(cells(row, 'notes').locator('.nullToken')).toHaveText('NULL');
    else await expect(cells(row, 'notes')).toHaveText(String(note));
  }
  // The chrome around the data may group: the row count of the toolbar.
  await expect(page.locator('.explorerPreviewToolbar__count')).toHaveText(/^\d{1,3}(,\d{3})* rows? \(LIMIT \d+\)$/);
});

test('Explorer Parts: part ages follow the duration rule and the table fits beside About at 1440 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.goto('/explorer/chdash_ui/weather_observations/storage');
  const parts = page.locator('#explorerDetailContent .explorerTable--parts');
  await expect(parts.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerDetailContent .explorerAbout')).toBeVisible();
  const headers = (await parts.locator('thead th').allTextContents()).map((text) => text.trim());
  const age = parts.locator(`tbody ${dataRowsSelector}`).first().locator('td').nth(headers.indexOf('Age'));
  // ns.format.duration: "20 h 19 min", "3 d 4 h", "45 s", never "20.3 h".
  await expect(age).toHaveText(/^\d+(?:\.\d+)? (?:ms|s|min|h|d)(?: \d+ (?:s|min|h))?$/);
  await expect(age).not.toHaveText(/\d\.\d+ (?:h|d)$/);
  const fit = await parts.evaluate((wrap) => ({ scroll: wrap.scrollWidth, client: wrap.clientWidth }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client + 1);
});

// --- Trace links in the row menu ---------------------------------------------
// A row holding an OpenTelemetry trace id (32 hex digits, not all zeros, in a
// String / FixedString cell or array element, read raw) offers "Open trace"
// (a new tab on /observability/traces/<id>, ?span= when a span column pairs
// with it by name) and "Copy trace link"; several distinct ids make both
// submenus. Only when the traces feature is enabled.

const TRACE_A = '0af7651916cd43dd8448eb211c80319c';
const TRACE_B = '4bf92f3577b34da6a3ce929d0e0e4736';
const TRACE_C = '00f067aa0ba902b700f067aa0ba902b7';
const SPAN_A = 'b7ad6b7169203331';
const SPAN_B = '00f067aa0ba902b7';

const traceRowMenu = (page) => page.locator('.rowDetailsMenu:not(.rowDetailsMenu--sub)');
const traceSubMenu = (page) => page.locator('.rowDetailsMenu--sub');
const menuLabels = (menu) => menu.getByRole('menuitem').evaluateAll((items) => items.map((i) => i.textContent));
const menuHrefs = (menu) => menu.locator('a[role=menuitem]').evaluateAll((items) => items.map((a) => a.getAttribute('href')));
const tracePath = (id, span = '') => `/observability/traces/${id}${span ? `?span=${span}` : ''}`;
const ROW_COPIES = ['Copy cell', 'Copy row', 'Copy column'];

async function openTraceRowMenu(page, row, cell = 1) {
  await row.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await row.locator('td').nth(cell).click({ button: 'right' });
  await expect(traceRowMenu(page)).toBeVisible();
  return traceRowMenu(page);
}

async function closeTraceRowMenu(page) {
  await page.keyboard.press('Escape');
  if (await traceRowMenu(page).count()) await page.keyboard.press('Escape');
  await expect(traceRowMenu(page)).toHaveCount(0);
}

// Outside a secure context the app copies through a hidden textarea:
// capture what that copy selects (or read the clipboard when available).
async function captureCopies(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
    }, true);
  });
  return () => page.evaluate(async () => {
    if (window.isSecureContext && navigator.clipboard) {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  });
}

async function setTracesFeature(page, enabled) {
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features = { ...(body.features || {}), traces: { ...((body.features || {}).traces || {}), enabled } };
    await route.fulfill({ response, json: body });
  });
}

test('row menu: Open trace for a raw trace id cell (any case, trimmed, String or FixedString), never for zeros, wrong lengths, ids inside text or numbers', async ({ page }) => {
  await setTracesFeature(page, true);
  await openApp(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await runSuccessfulQuery(page, `SELECT number AS n,
  '${TRACE_A.toUpperCase()}' AS TraceId,
  '${SPAN_A}' AS SpanId,
  '00000000000000000000000000000000' AS zero_trace,
  '${TRACE_A.slice(0, 31)}' AS short_trace,
  '${TRACE_A}d' AS long_trace,
  'see ${TRACE_A}' AS note,
  'zz${TRACE_A.slice(2)}' AS not_hex,
  toUInt128('12345678901234567890123456789012') AS numeric_id
FROM numbers(3)`);
  await expect(rows).toHaveCount(3);
  // The cells stay raw (as ClickHouse sent them): upper case.
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText(TRACE_A.toUpperCase());
  let menu = await openTraceRowMenu(page, rows.nth(1), 4);
  // One trace id: flat entries, after Details.
  expect(await menuLabels(menu)).toEqual(['Details', 'Open trace', 'Copy trace link', ...ROW_COPIES]);
  // A link to the lower-cased id, on its span (TraceId pairs with SpanId),
  // in a new tab.
  const open = menu.getByRole('menuitem', { name: 'Open trace', exact: true });
  await expect(open).toHaveAttribute('href', tracePath(TRACE_A, SPAN_A));
  await expect(open).toHaveAttribute('target', '_blank');
  // Hovering it lights the trace id cell.
  await open.hover();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('td.is-copyTarget')].map((td) => td.cellIndex))).toEqual([2]);
  await closeTraceRowMenu(page);

  // FixedString(32), and a value padded with spaces.
  await runSuccessfulQuery(page, `SELECT number AS n, toFixedString('${TRACE_B}', 32) AS fixed_trace FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_B)]);
  await closeTraceRowMenu(page);
  await runSuccessfulQuery(page, `SELECT number AS n, concat('  ', '${TRACE_C}', '\\t') AS padded FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_C)]);
  await closeTraceRowMenu(page);

  // Nothing that is not a whole trace id.
  await runSuccessfulQuery(page, `SELECT number AS n, '00000000000000000000000000000000' AS TraceId, 'x ${TRACE_A}' AS trace_note, '${TRACE_A.slice(0, 16)}' AS half FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(1));
  expect(await menuLabels(menu)).toEqual(['Details', ...ROW_COPIES]);
  await closeTraceRowMenu(page);
});

test('row menu: one entry for a trace id found in several columns; the span pairs with its trace column by name, and an ambiguous span is left out', async ({ page }) => {
  await setTracesFeature(page, true);
  await openApp(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);

  // The same id twice (case aside): one entry naming the first column, the
  // other one in its tooltip.
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS TraceId, '${TRACE_A.toUpperCase()}' AS trace_id_copy, '${SPAN_A}' AS SpanId FROM numbers(2)`);
  let menu = await openTraceRowMenu(page, rows.nth(0));
  await expect(traceSubMenu(page)).toHaveCount(0);
  expect(await menuLabels(menu)).toEqual(['Details', 'Open trace (TraceId)', 'Copy trace link (TraceId)', ...ROW_COPIES]);
  const open = menu.getByRole('menuitem', { name: 'Open trace (TraceId)' });
  await expect(open).toHaveAttribute('title', 'Also in trace_id_copy');
  await expect(open).toHaveAttribute('href', tracePath(TRACE_A, SPAN_A));
  await closeTraceRowMenu(page);

  // Two span columns of the trace (SpanId and span_id) that disagree: the
  // trace opens without ?span=.
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS TraceId, '${SPAN_A}' AS SpanId, '${SPAN_B}' AS span_id FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_A)]);
  await closeTraceRowMenu(page);

  // A trace column whose name pairs with no span column: no ?span= either.
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS trace, '${SPAN_A}' AS SpanId FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_A)]);
  await closeTraceRowMenu(page);

  // trace_id pairs with span_id; an all-zero span is no span.
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS trace_id, if(number = 0, '0000000000000000', '${SPAN_A}') AS span_id FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_A)]);
  await closeTraceRowMenu(page);
  menu = await openTraceRowMenu(page, rows.nth(1));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_A, SPAN_A)]);
  await closeTraceRowMenu(page);

  // A prefix pairs too: parent_trace_id with parent_span_id, not SpanId.
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_B}' AS parent_trace_id, '${SPAN_B}' AS parent_span_id, '${SPAN_A}' AS SpanId FROM numbers(2)`);
  menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuHrefs(menu)).toEqual([tracePath(TRACE_B, SPAN_B)]);
  await closeTraceRowMenu(page);
});

test('row menu: several distinct trace ids make Open trace and Copy trace link submenus, keyboard driven; a link opens a new tab and keeps the results', async ({ page }) => {
  await setTracesFeature(page, true);
  await openApp(page);
  const readClipboard = await captureCopies(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS TraceId, '${SPAN_A}' AS SpanId, toFixedString('${TRACE_B}', 32) AS parent_trace_id, ' ${TRACE_C} ' AS LinkedTraceId FROM numbers(3)`);
  await expect(rows).toHaveCount(3);
  const menu = await openTraceRowMenu(page, rows.nth(1));
  expect(await menuLabels(menu)).toEqual(['Details', 'Open trace', 'Copy trace link', ...ROW_COPIES]);
  const openTrigger = menu.getByRole('menuitem', { name: 'Open trace', exact: true });
  const copyTrigger = menu.getByRole('menuitem', { name: 'Copy trace link', exact: true });
  await expect(openTrigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(openTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(menu.locator('a[role=menuitem]')).toHaveCount(0);

  // Keyboard: ArrowRight opens the submenu on its first item; arrows, Home
  // and End move in it; ArrowLeft and Escape close it, back on its item.
  await expect(menu.getByRole('menuitem', { name: 'Details' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(openTrigger).toBeFocused();
  await expect(traceSubMenu(page)).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  const sub = traceSubMenu(page);
  await expect(sub).toBeVisible();
  await expect(sub).toHaveAttribute('role', 'menu');
  await expect(openTrigger).toHaveAttribute('aria-expanded', 'true');
  expect(await menuLabels(sub)).toEqual([`TraceId · ${TRACE_A.slice(0, 8)}…`, `parent_trace_id · ${TRACE_B.slice(0, 8)}…`, `LinkedTraceId · ${TRACE_C.slice(0, 8)}…`]);
  expect(await menuHrefs(sub)).toEqual([tracePath(TRACE_A, SPAN_A), tracePath(TRACE_B), tracePath(TRACE_C)]);
  const subItems = sub.getByRole('menuitem');
  await expect(subItems.nth(0)).toBeFocused();
  await expect(subItems.nth(0)).toHaveAttribute('title', TRACE_A);
  // Beside the menu, to its right.
  const [mainBox, subBox] = [await menu.boundingBox(), await sub.boundingBox()];
  expect(subBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 8);
  await page.keyboard.press('ArrowDown');
  await expect(subItems.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(subItems.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(subItems.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sub).toHaveCount(0);
  await expect(openTrigger).toBeFocused();
  await expect(openTrigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(subItems.nth(0)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sub).toHaveCount(0);
  await expect(menu).toBeVisible();
  await expect(openTrigger).toBeFocused();
  // Enter opens it too; moving on in the menu closes it.
  await page.keyboard.press('ArrowDown');
  await expect(copyTrigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sub).toBeVisible();
  await expect(sub.locator('a')).toHaveCount(0);
  expect(await menuLabels(sub)).toHaveLength(3);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Copy cell' })).toBeFocused();
  await expect(sub).toHaveCount(0);
  await closeTraceRowMenu(page);

  // Enter on a trace opens it in a new tab, on its span; the results stay.
  await openTraceRowMenu(page, rows.nth(1));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(subItems.nth(0)).toBeFocused();
  const [tab] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('Enter')]);
  await tab.waitForLoadState('domcontentloaded');
  expect(new URL(tab.url()).pathname + new URL(tab.url()).search).toBe(tracePath(TRACE_A, SPAN_A));
  await tab.close();
  await expect(traceRowMenu(page)).toHaveCount(0);
  await expect(traceSubMenu(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/query/);
  await expect(rows).toHaveCount(3);

  // A pointer: hovering the item opens its submenu, a click on a trace opens
  // the new tab.
  await openTraceRowMenu(page, rows.nth(2));
  await openTrigger.hover();
  await expect(sub).toBeVisible();
  const [second] = await Promise.all([page.context().waitForEvent('page'), subItems.nth(1).click()]);
  await second.waitForLoadState('domcontentloaded');
  expect(new URL(second.url()).pathname).toBe(tracePath(TRACE_B));
  await second.close();
  await expect(rows).toHaveCount(3);

  // Copy trace link: the absolute URL of the chosen trace.
  await openTraceRowMenu(page, rows.nth(0));
  await copyTrigger.click();
  await expect(sub).toBeVisible();
  await subItems.nth(2).click();
  await expect(traceRowMenu(page)).toHaveCount(0);
  await expect.poll(readClipboard).toBe(new URL(tracePath(TRACE_C), page.url()).href);
});

test('row menu: trace ids in array cells count element by element and pair with the span array', async ({ page }) => {
  await setTracesFeature(page, true);
  await openApp(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await runSuccessfulQuery(page, `SELECT number AS n, '${TRACE_A}' AS TraceId, '${SPAN_A}' AS SpanId,
  ['${TRACE_B}', '${TRACE_A}', 'not-a-trace', '${TRACE_C}'] AS \`Links.TraceId\`,
  ['1111111111111111', '${SPAN_A}', '', '3333333333333333'] AS \`Links.SpanId\`
FROM numbers(2)`);
  const menu = await openTraceRowMenu(page, rows.nth(0));
  await menu.getByRole('menuitem', { name: 'Open trace', exact: true }).click();
  const sub = traceSubMenu(page);
  await expect(sub).toBeVisible();
  // Links.TraceId[2] is TraceId again: one entry, the element in its tooltip.
  expect(await menuLabels(sub)).toEqual([`TraceId · ${TRACE_A.slice(0, 8)}…`, `Links.TraceId[1] · ${TRACE_B.slice(0, 8)}…`, `Links.TraceId[4] · ${TRACE_C.slice(0, 8)}…`]);
  await expect(sub.getByRole('menuitem').first()).toHaveAttribute('title', `${TRACE_A}\nAlso in Links.TraceId[2]`);
  expect(await menuHrefs(sub)).toEqual([tracePath(TRACE_A, SPAN_A), tracePath(TRACE_B, '1111111111111111'), tracePath(TRACE_C, '3333333333333333')]);
  await closeTraceRowMenu(page);
});

test('row menu: the trace submenu stops at ten ids, then a disabled "+N more" the keys skip', async ({ page }) => {
  await setTracesFeature(page, true);
  await openApp(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  const sub = traceSubMenu(page);
  const twelve = Array.from({ length: 12 }, (_, i) => `'${'a'.repeat(30)}${String(i + 1).padStart(2, '0')}'`).join(', ');
  await runSuccessfulQuery(page, `SELECT number AS n, [${twelve}] AS trace_ids FROM numbers(2)`);
  await openTraceRowMenu(page, rows.nth(0));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(sub).toBeVisible();
  const labels = await menuLabels(sub);
  expect(labels).toHaveLength(11);
  expect(labels[0]).toBe('trace_ids[1] · aaaaaaaa…');
  expect(labels[10]).toBe('+2 more');
  await expect(sub.locator('a[role=menuitem]')).toHaveCount(10);
  expect((await menuHrefs(sub))[9]).toBe(tracePath(`${'a'.repeat(30)}10`));
  const more = sub.getByRole('menuitem', { name: '+2 more' });
  await expect(more).toBeDisabled();
  await expect(more).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('End');
  await expect(sub.locator('a[role=menuitem]').nth(9)).toBeFocused();
  await closeTraceRowMenu(page);
});

test('row menu: no trace entries when the traces feature is off; multiquery panels offer them too', async ({ page }) => {
  const sql = `SELECT number AS n, '${TRACE_A}' AS TraceId, '${SPAN_A}' AS SpanId FROM numbers(3)`;
  await setTracesFeature(page, false);
  await openApp(page);
  const rows = page.locator(`#resultTableBody ${dataRowsSelector}`);
  await runSuccessfulQuery(page, sql);
  const menu = await openTraceRowMenu(page, rows.nth(0));
  expect(await menuLabels(menu)).toEqual(['Details', ...ROW_COPIES]);
  await closeTraceRowMenu(page);

  await page.unroute('**/api/version');
  await setTracesFeature(page, true);
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await runQuery(page, `SELECT 1 AS a FROM numbers(2); ${sql};`);
  await waitForTerminal(page);
  const second = page.locator('.resultsStack__block').nth(1);
  if (await second.locator('.resultsStack__body').isHidden()) await second.locator('.resultsStack__toggle').click();
  const panelRows = second.locator(`tbody ${dataRowsSelector}`);
  await expect(panelRows).toHaveCount(3);
  const panelMenu = await openTraceRowMenu(page, panelRows.nth(2));
  expect(await menuLabels(panelMenu)).toEqual(['Details', 'Open trace', 'Copy trace link', ...ROW_COPIES]);
  expect(await menuHrefs(panelMenu)).toEqual([tracePath(TRACE_A, SPAN_A)]);
  await closeTraceRowMenu(page);
});

test('inline row details open from the Explorer data preview', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.getByText('wide_types', { exact: true }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');
  await page.locator('#explorerDetailTabs').getByRole('tab', { name: 'Preview', exact: true }).click();
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
    else {
      // Replaced by another row's Details, then closed.
      await openRowDetailsFromRow(page, rows.nth(0));
      await page.locator('.rowDetails__close').click();
    }
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

// Parks every request matching `pattern` until release(), so a test can look
// at the page exactly as it is painted before that resource answers.
async function holdRequests(page, pattern) {
  const parked = [];
  let released = false;
  await page.route(pattern, (route) => {
    if (released) return route.continue();
    parked.push(route);
  });
  return {
    count: () => parked.length,
    async release() {
      released = true;
      await Promise.all(parked.splice(0).map((route) => route.continue()));
    },
  };
}

for (const path of ['/query', '/explorer', '/observability/traces']) {
  test(`${path}: the theme button shows the saved theme from the first paint, before any page script`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    for (const mode of ['light', 'dark']) {
      await page.evaluate((m) => localStorage.setItem('chdash.theme', m), mode);
      const scripts = await holdRequests(page, '**/static/*.js');
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const icon = await page.evaluate((m) => {
          const probe = document.createElement('span');
          probe.className = `themeIcon themeIcon--${m}`;
          document.body.appendChild(probe);
          const expected = getComputedStyle(probe).maskImage;
          probe.remove();
          return { shown: getComputedStyle(document.getElementById('themeSelectText')).maskImage, expected, mode: document.documentElement.dataset.themeMode };
        }, mode);
        expect(icon.mode).toBe(mode);
        expect(icon.shown).toBe(icon.expected);
      } finally {
        await scripts.release();
      }
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
    await page.evaluate(() => localStorage.removeItem('chdash.theme'));
  });
}

test('/observability/traces: the analytics charts hold their place from the first paint, so the results never jump down', async ({ page }) => {
  test.setTimeout(90_000);
  // A first visit learns from /api/traces/meta that analytics are enabled.
  await page.goto('/observability/traces');
  await expect(page.locator('#traceAnalyticsGrid')).toBeVisible({ timeout: 30_000 });
  const toolbarTop = () => page.evaluate(() => Math.round(document.querySelector('.traceSearchResults__toolbar').getBoundingClientRect().top));
  const api = await holdRequests(page, '**/api/**');
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Page scripts are running but no API answer (meta included) arrived:
    // the grid is already laid out.
    await expect.poll(() => api.count()).toBeGreaterThan(0);
    await expect(page.locator('#traceAnalyticsGrid')).toBeVisible();
    const before = await toolbarTop();
    await api.release();
    await expect(page.locator('html')).not.toHaveClass(/chdash-trace-analytics/, { timeout: 30_000 });
    await expect(page.locator('#traceAnalyticsGrid')).toBeVisible();
    expect(Math.abs((await toolbarTop()) - before)).toBeLessThanOrEqual(1);
  } finally {
    await api.release();
  }
  // A deployment without analytics does not reserve the space. (Set before
  // any script of the next document runs: the open page may still re-render
  // its analytics and write the flag again.)
  await page.addInitScript(() => localStorage.setItem('chdash.traceAnalytics.v1', '0'));
  const held = await holdRequests(page, '**/api/**');
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#traceAnalyticsGrid')).toBeHidden();
  } finally {
    await held.release();
  }
});

for (const path of ['/query', '/explorer', '/observability/traces', '/observability/logs', '/observability/metrics']) {
  test(`${path}: the Query / Explorer / Observability switcher is painted with the shell, before any API answer`, async ({ page }) => {
    const api = await holdRequests(page, '**/api/**');
    try {
      const pageSelectBox = () => page.evaluate(() => {
        const el = document.getElementById('pageSelect');
        const r = el.getBoundingClientRect();
        return { hidden: el.hidden, display: getComputedStyle(el).display, x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#pageSelectButton')).toBeVisible();
      // Scripts have started and their /api calls (version, hosts) are parked.
      await expect.poll(() => api.count()).toBeGreaterThan(0);
      await expect(page.locator('#versionBadge')).toHaveText('--');
      await expect(page.locator('#pageSelectButton')).toBeVisible();
      const early = await pageSelectBox();
      expect(early.hidden).toBe(false);
      expect(early.width).toBeGreaterThan(0);

      await api.release();
      await expect(page.locator('#versionBadge')).not.toHaveText('--');
      await expect(page.locator('#hostPickerText')).not.toHaveText('Host');
      await expect(page.locator('#pageSelectButton')).toBeVisible();
      expect(await pageSelectBox()).toEqual(early);
      // The open menu lists the other pages (the current one is implied).
      await page.locator('#pageSelectButton').click();
      const current = path.startsWith('/observability') ? 'observability' : path.slice(1);
      const others = ['query', 'explorer', 'observability'].filter((name) => name !== current);
      await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(others.map((name) => name[0].toUpperCase() + name.slice(1)));
    } finally {
      await api.release();
    }
  });
}

test('traces: time range, status and result pickers have their final style at first paint', async ({ page }) => {
  const scripts = await holdRequests(page, '**/static/*.js');
  const api = await holdRequests(page, '**/api/**');
  try {
    const pickers = ['tracesRangeUnit', 'tracesStatus', 'tracesService', 'tracesOperation', 'tracesLimit', 'tracesSort'];
    const snapshot = (ids) => page.evaluate((list) => Object.fromEntries(list.map((id) => {
      const select = document.getElementById(id);
      const root = select.parentElement;
      const button = root.querySelector(':scope > .tracePicker__button');
      const cs = getComputedStyle(button);
      const r = button.getBoundingClientRect();
      const keys = ['display', 'height', 'width', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderTopStyle', 'borderTopColor',
        'borderTopLeftRadius', 'backgroundColor', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'opacity'];
      return [id, {
        rootClass: root.className,
        selectClass: select.className,
        selectPosition: getComputedStyle(select).position,
        buttonClass: button.className,
        text: button.textContent,
        disabled: button.disabled,
        box: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10),
        style: Object.fromEntries(keys.map((k) => [k, cs[k]])),
      }];
    })), ids);

    await page.goto('/observability/traces', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.styleSheets].some((sheet) => /style(\.[a-z]+)*\.css/.test(sheet.href || '') && sheet.cssRules.length > 0));
    // No application script has run yet: this is the page as first painted.
    expect(await page.evaluate(() => Boolean(window.ChDash && window.ChDash.traces))).toBe(false);
    const firstPaint = await snapshot(pickers);
    expect(firstPaint.tracesRangeUnit.text).toBe('Time range · Last 1 hour');
    expect(firstPaint.tracesStatus.text).toBe('Status · ALL');
    expect(firstPaint.tracesLimit.text).toBe('Results · 50');
    expect(firstPaint.tracesService.disabled).toBe(true);

    await scripts.release();
    await page.waitForFunction((ids) => window.ChDash && window.ChDash.traces
      && ids.every((id) => document.getElementById(id).dataset.tracePickerReady === '1'), pickers);
    await expect.poll(() => api.count()).toBeGreaterThan(0);
    expect(await snapshot(pickers)).toEqual(firstPaint);
    // One picker per select: the shipped markup is adopted, never doubled.
    await expect(page.locator('#tracesForm .tracePicker')).toHaveCount(5);
    await expect(page.locator('.traceResultsSort .tracePicker')).toHaveCount(1);

    // The search bar pickers do not depend on the answers either (the results
    // toolbar below them moves down once analytics render, which is expected).
    const settled = ['tracesRangeUnit', 'tracesStatus', 'tracesLimit'];
    await api.release();
    await expect(page.locator('#versionBadge')).not.toHaveText('--');
    await expect(page.locator('#hostPickerText')).not.toHaveText('Host');
    const afterData = await snapshot(settled);
    for (const id of settled) expect(afterData[id]).toEqual(firstPaint[id]);

    const statusPicker = page.locator('.traceSearchField--status .tracePicker');
    await statusPicker.locator('.tracePicker__button').click();
    await expect(statusPicker.locator('.tracePicker__option')).toHaveCount(4);
  } finally {
    await scripts.release();
    await api.release();
  }
});

test('traces: the trace header copies or downloads the whole trace as JSON with the query results control', async ({ page }) => {
  test.setTimeout(90_000);
  // Visual reference: the query results' Copy JSON split control.
  const splitLook = (mainSel, toggleSel) => page.evaluate(([m, t]) => {
    const pick = (el) => { const cs = getComputedStyle(el); return Object.fromEntries(['height', 'fontSize', 'fontWeight', 'borderTopWidth', 'borderTopStyle', 'backgroundColor', 'color', 'borderRadius', 'paddingLeft'].map((k) => [k, cs[k]])); };
    return { main: pick(document.querySelector(m)), toggle: pick(document.querySelector(t)) };
  }, [mainSel, toggleSel]);
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(3)');
  await expect(page.locator('#copyJsonButton')).toBeEnabled();
  await expect(page.locator('#copyJsonButton')).toHaveCSS('opacity', '1');
  const resultsLook = await splitLook('#copyJsonButton', '#copyMenuButton');

  // The OTel fixture is seeded days back: find the newest week holding traces.
  let rows = [];
  for (let week = 0; week < 6 && !rows.length; week += 1) {
    const endMs = Date.now() - week * 7 * 86_400_000;
    const response = await page.request.get('/api/traces/search', {
      params: { host_id: 'local', start_ms: String(endMs - 7 * 86_400_000 + 1), end_ms: String(endMs), limit: '20' },
      timeout: 60_000,
    });
    expect(response.ok(), await response.text()).toBe(true);
    rows = (await response.json()).rows || [];
  }
  expect(rows.length).toBeGreaterThan(0);
  const traceId = rows.filter((row) => Number(row[5]) > 1).sort((a, b) => Number(a[5]) - Number(b[5]))[0]?.[0] || rows[0][0];
  const detail = await page.request.get('/api/traces/trace', { params: { host_id: 'local', trace_id: traceId } });
  expect(detail.ok()).toBe(true);
  const detailText = await detail.text();
  const detailSpans = JSON.parse(detailText).spans;

  await page.goto(`/observability/traces/${encodeURIComponent(traceId)}`);
  await expect(page.locator('#traceDetail')).toBeVisible();
  const spanRows = page.locator('#traceWaterfall .traceSpanRow');
  await expect(spanRows).toHaveCount(detailSpans.length, { timeout: 30_000 });
  // The complete trace id, not clipped, like the result list.
  const headerId = page.locator('#traceDetailTitle .tracePageHeader__traceId code');
  await expect(headerId).toHaveText(traceId);
  expect(await headerId.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.tracePageHeader__titleRow').getBoundingClientRect().right)).toBe(true);
  const split = page.locator('#traceDetailHeader .tracePageHeader__titleRow > #traceCopySplit');
  const button = split.locator('#traceCopyJsonButton');
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Copy JSON');
  await expect(button).toHaveAttribute('title', 'Copy trace JSON');
  await expect(split.locator('#traceCopyMenuButton')).toBeEnabled();
  // Last control of the header row, after the trace start / duration stats.
  const [statsBox, splitBox, rowBox] = await Promise.all([
    page.locator('#traceDetailStats').boundingBox(),
    split.boundingBox(),
    page.locator('#traceDetailHeader .tracePageHeader__titleRow').boundingBox(),
  ]);
  expect(splitBox.x).toBeGreaterThanOrEqual(statsBox.x + statsBox.width - 1);
  expect(splitBox.x + splitBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  expect(splitBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
  expect(splitBox.y + splitBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  await expect(button).toHaveCSS('opacity', '1');
  expect(await splitLook('#traceCopyJsonButton', '#traceCopyMenuButton')).toEqual(resultsLook);

  // Outside a secure context the app copies through a hidden textarea:
  // capture what that copy selects (or read the clipboard when available).
  await page.evaluate(() => {
    window.__chdashTestCopiedText = '';
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') {
        window.__chdashTestCopiedText = active.value.slice(active.selectionStart, active.selectionEnd);
      }
    }, true);
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await button.click();
  // Same feedback as the results control.
  await expect(button).toHaveText('Copied');
  const copied = await page.evaluate(async () => {
    if (window.isSecureContext && navigator.clipboard) {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  });
  const doc = JSON.parse(copied);
  // Indented by 2 spaces (start_ns digits aside, which JS numbers round).
  const anyStart = (text) => text.replace(/"start_ns": \d+/g, '"start_ns": 0');
  expect(anyStart(copied)).toBe(anyStart(JSON.stringify(doc, null, 2)));
  expect(Object.keys(doc)).toEqual(['trace_id', 'truncated', 'span_count', 'spans']);
  expect(doc.trace_id).toBe(traceId);
  expect(doc.span_count).toBe(await spanRows.count());
  expect(doc.spans).toHaveLength(detailSpans.length);
  expect(doc.spans.map((span) => span.span_id).sort()).toEqual(detailSpans.map((span) => span.span_id).sort());
  const starts = doc.spans.map((span) => Number(span.start_ns));
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  // start_ns keeps every digit the endpoint sent (it is past 2^53).
  const exactStarts = (text, spacing) => [...text.matchAll(new RegExp(`"start_ns":${spacing}(\\d+)`, 'g'))].map((m) => m[1]).sort();
  expect(exactStarts(copied, ' ')).toEqual(exactStarts(detailText, ''));
  const byId = new Map(detailSpans.map((span) => [span.span_id, span]));
  for (const span of doc.spans) {
    const source = byId.get(span.span_id);
    expect(span.trace_id).toBe(traceId);
    for (const key of ['parent_span_id', 'service_name', 'span_name', 'span_kind', 'timestamp', 'duration_ns', 'status_code', 'status_message']) {
      expect(span[key]).toEqual(source[key]);
    }
    if ('span_attributes' in source) expect(span.span_attributes).toEqual(JSON.parse(source.span_attributes));
    if ('resource_attributes' in source) expect(span.resource_attributes).toEqual(JSON.parse(source.resource_attributes));
    if ('events_name' in source) expect(span.events).toHaveLength(JSON.parse(source.events_name).length);
    if ('links_trace_id' in source) expect(span.links).toHaveLength(JSON.parse(source.links_trace_id).length);
  }
  await expect(button).toHaveText('Copy JSON', { timeout: 4_000 });
  // Download JSON (menu): the same document, as trace-<id>.json.
  await split.locator('#traceCopyMenuButton').click();
  await expect(page.locator('#traceCopyMenu')).toBeVisible();
  await expect(page.locator('#traceCopyMenu').getByRole('menuitem')).toHaveText(['Download JSON']);
  // Painted on top (the service filter row below the header must not cover it).
  expect(await page.locator('#traceDownloadJsonButton').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#traceDownloadJsonButton').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`trace-${traceId}.json`);
  const fs = await import('node:fs/promises');
  const downloaded = await fs.readFile(await download.path(), 'utf8');
  expect(downloaded).toBe(copied);
  await expect(page.locator('#traceCopyMenu')).toBeHidden();

  // The header's Trace ID copy button also copies outside secure contexts
  // (shared clipboard helper with the textarea fallback).
  await page.evaluate(() => { window.__chdashTestCopiedText = ''; });
  await page.locator('#traceDetailTitle [data-copy-active-trace]').click();
  await expect.poll(() => page.evaluate(async () => {
    if (window.isSecureContext && navigator.clipboard) {
      try { return await navigator.clipboard.readText(); } catch (_) {}
    }
    return window.__chdashTestCopiedText || '';
  })).toBe(traceId);
});

async function otelRows(request, sql) {
  const base = (process.env.CLICKHOUSE_URL || 'http://clickhouse:8123').replace(/\/$/, '');
  const auth = Buffer.from(`${process.env.CLICKHOUSE_USER || 'test'}:${process.env.CLICKHOUSE_PASSWORD || 'test'}`).toString('base64');
  const response = await request.post(`${base}/`, { data: `${sql} FORMAT TSV`, headers: { Authorization: `Basic ${auth}` }, timeout: 60_000 });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.text()).split('\n').filter(Boolean).map((line) => line.split('\t'));
}

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

test('traces: each listed trace shows its services in the order of their first span start', async ({ page, request }) => {
  // The fixture's services join a trace 1 ms apart in name order, so a window
  // that starts a few ms into a trace cuts its first services off and the
  // earliest remaining span belongs to a service late in the alphabet: the
  // order by first span then differs from both name and span-count order.
  const [[endText]] = await otelRows(request, 'SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts');
  test.skip(!(Number(endText) > 0), 'OTEL fixture is empty');
  const [[traceStartText]] = await otelRows(request,
    `SELECT toUnixTimestamp64Milli(min(Timestamp)) FROM otel.otel_traces WHERE Timestamp >= fromUnixTimestamp64Milli(${Number(endText) - 1_800_000})`
    + ` AND Timestamp < fromUnixTimestamp64Milli(${Number(endText) - 1_790_000}) GROUP BY TraceId ORDER BY 1 LIMIT 1`);
  const startMs = Number(traceStartText) + 7;
  const endMs = startMs + 400;
  // The page asks for "last hour"; pin its trace searches to the cut window
  // (min_duration_ms makes the search rank traces by their window spans, so
  // traces whose first spans fall before the window are listed too).
  await page.route((url) => url.pathname.endsWith('/api/traces/search'), (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('start_ms', String(startMs));
    url.searchParams.set('end_ms', String(endMs));
    url.searchParams.set('min_duration_ms', '1');
    return route.continue({ url: url.toString() });
  });
  const searched = page.waitForResponse((response) => response.url().includes('/api/traces/search?'), { timeout: 60_000 });
  await page.goto('/observability/traces');
  const payload = await (await searched).json();
  expect(payload.rows.length).toBeGreaterThan(0);

  const rows = page.locator('#tracesResults .traceResult[data-trace-id]');
  await expect(rows).toHaveCount(payload.rows.length, { timeout: 30_000 });
  const rendered = Object.fromEntries(await rows.evaluateAll((items) => items.map((item) => [
    item.getAttribute('data-trace-id'),
    [...item.querySelectorAll('.traceSvcPills > .traceSvcPill')].map((pill) => pill.dataset.service),
  ])));

  const services = payload.services;
  let reordered = [];
  for (const [traceId, , , , , , , stats] of payload.rows) {
    const expected = [...stats].sort((a, b) => (a[3] - b[3]) || byCodePoint(services[a[0]], services[b[0]])).map((stat) => services[stat[0]]);
    expect(rendered[traceId], traceId).toEqual(expected);
    const byName = [...expected].sort(byCodePoint);
    const bySpans = stats.map((stat) => services[stat[0]]);
    if (JSON.stringify(expected) !== JSON.stringify(byName) && JSON.stringify(expected) !== JSON.stringify(bySpans)) reordered.push(traceId);
  }
  // The window does cut traces, so the check discriminates the ordering.
  expect(reordered.length).toBeGreaterThan(0);

  // Ground truth straight from the span table for a few traces.
  const sample = [...reordered.slice(0, 2), ...payload.rows.map((row) => row[0]).filter((id) => !reordered.includes(id)).slice(0, 1)];
  const truth = {};
  for (const [traceId, service] of await otelRows(request,
    `SELECT TraceId, ServiceName FROM otel.otel_traces WHERE Timestamp >= fromUnixTimestamp64Milli(${startMs}) AND Timestamp <= fromUnixTimestamp64Milli(${endMs})`
    + ` AND TraceId IN (${sample.map((id) => `'${id}'`).join(',')}) AND ServiceName != ''`
    + ' GROUP BY TraceId, ServiceName ORDER BY TraceId, min(Timestamp), ServiceName')) {
    (truth[traceId] ||= []).push(service);
  }
  for (const traceId of sample) expect(rendered[traceId], traceId).toEqual(truth[traceId]);
});

// --- Traces time range panel -------------------------------------------------
// Playwright runs the browser in UTC, so browser-local dates equal UTC dates.
const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMidnight = (ms) => Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate());
const searchParams = (request) => Object.fromEntries(new URL(request.url()).searchParams);
const isSearch = (request) => new URL(request.url()).pathname.endsWith('/api/traces/search');

async function openTracesIdle(page) {
  const firstSearch = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.goto('/observability/traces');
  await firstSearch;
  await page.waitForLoadState('networkidle');
}

async function openTimeRange(page) {
  await page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button').click();
  const panel = page.locator('#tracesTimeRangePanel');
  await expect(panel).toBeVisible();
  await expect(page.locator('#tracesRangeStart')).toBeFocused();
  return panel;
}

// Moves the calendar back month by month until the day is in the shown month.
async function showCalendarDay(page, key) {
  const day = page.locator(`#tracesTimeCalendar .timeCalendar__day:not(.is-outside)[data-day="${key}"]`);
  for (let i = 0; i < 36 && !(await day.count()); i += 1) await page.locator('#tracesTimeCalendar [data-cal-nav="-1"]').click();
  await expect(day).toHaveCount(1);
  return day;
}

test('traces: the calendar takes a start older than the max range, moves on to the end by itself, and Apply searches that window', async ({ page, request }) => {
  test.setTimeout(120_000);
  const [[endText]] = await otelRows(request, 'SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts');
  const dataEnd = Number(endText);
  const now = Date.now();
  // The fixture window when it is older than the 7-day max range (it is
  // seeded days back), otherwise a window ten days back.
  const fixtureIsOld = dataEnd > 0 && now - utcMidnight(dataEnd) > 9 * DAY_MS;
  const startDay = fixtureIsOld ? utcMidnight(dataEnd) - 2 * DAY_MS : utcMidnight(now) - 10 * DAY_MS;
  const endDay = fixtureIsOld ? utcMidnight(dataEnd) : startDay + 2 * DAY_MS;
  expect(now - startDay).toBeGreaterThan(7 * DAY_MS);

  await openTracesIdle(page);
  await openTimeRange(page);
  await expect(page.locator('#tracesTimeCalendarHint')).toHaveText('Pick the start date');
  const start = await showCalendarDay(page, utcDay(startDay));
  await start.click();
  // The start is taken as is (no "End − 7 days" floor) and the end selection opens.
  await expect(page.locator('#tracesRangeStart')).toHaveValue(`${utcDay(startDay)} 00:00:00`);
  await expect(page.locator('#tracesRangeEnd')).toBeFocused();
  await expect(page.locator('#tracesRangeEnd').locator('xpath=ancestor::label[1]')).toHaveClass(/is-active/);
  await expect(page.locator('#tracesTimeCalendarHint')).toHaveText('Pick the end date · max 7 days');
  await expect(start).toHaveClass(/is-start/);
  // Days whose start is 7 days or more after the start cannot end the range.
  const lastEnd = page.locator(`#tracesTimeCalendar [data-day="${utcDay(startDay + 6 * DAY_MS)}"]`).first();
  const tooFar = page.locator(`#tracesTimeCalendar [data-day="${utcDay(startDay + 7 * DAY_MS)}"]`).first();
  if (await tooFar.count()) await expect(tooFar).toHaveAttribute('aria-disabled', 'true');
  if (await lastEnd.count()) await expect(lastEnd).toHaveAttribute('aria-disabled', 'false');
  // Hovering previews the range.
  const end = page.locator(`#tracesTimeCalendar [data-day="${utcDay(endDay)}"]`).first();
  await end.hover();
  await expect(end).toHaveClass(/is-end/);
  await expect(page.locator('#tracesTimeCalendar .timeCalendar__day.is-preview')).toHaveCount(2);
  await end.click();
  await expect(page.locator('#tracesRangeEnd')).toHaveValue(`${utcDay(endDay)} 23:59:59`);
  await expect(page.locator('#tracesCustomRangeApply')).toBeFocused();
  await expect(page.locator('#tracesTimeCalendar .timeCalendar__day.is-inRange')).toHaveCount(1);

  const searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  const answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  const params = searchParams(await searched);
  expect(Number(params.start_ms)).toBe(startDay);
  expect(Number(params.end_ms)).toBe(endDay + DAY_MS - 1000);
  expect(params.align_buckets).toBe('0');
  await expect(page.locator('#tracesTimeRangePanel')).toBeHidden();
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText(`${utcDay(startDay)} 00:00 → ${utcDay(endDay)} 23:59`);
  const payload = await (await answered).json();
  if (fixtureIsOld) {
    expect(payload.rows.length).toBeGreaterThan(0);
    await expect(page.locator('#tracesResults .traceResult[data-trace-id]')).toHaveCount(payload.rows.length, { timeout: 30_000 });
    for (const row of payload.rows) {
      expect(Number(row[1])).toBeGreaterThanOrEqual(startDay - DAY_MS);
      expect(Number(row[1])).toBeLessThanOrEqual(endDay + DAY_MS);
    }
  }
});

test('traces: From / To take relative expressions, and invalid or too wide ranges get inline errors without searching', async ({ page }) => {
  test.setTimeout(90_000);
  await openTracesIdle(page);
  let searches = 0;
  page.on('request', (req) => { if (isSearch(req)) searches += 1; });
  const panel = await openTimeRange(page);
  const from = page.locator('#tracesRangeStart');
  const to = page.locator('#tracesRangeEnd');
  const apply = page.locator('#tracesCustomRangeApply');

  await from.fill('last tuesday');
  await to.fill('now');
  await apply.click();
  await expect(page.locator('#tracesRangeStartError')).toBeVisible();
  await expect(page.locator('#tracesRangeStartError')).toContainText('or a relative time like now-6h');
  await expect(from).toHaveAttribute('aria-invalid', 'true');
  await from.fill('now');
  await expect(page.locator('#tracesRangeStartError')).toBeHidden();

  await from.fill('2026-09-10 12:00:00');
  await to.fill('2026-09-10 08:00');
  await apply.click();
  await expect(page.locator('#tracesRangeError')).toHaveText('"From" must be before "To".');

  // Width above traces.max_lookback_minutes (7 days in this config).
  await from.fill('2026-01-01 00:00:00');
  await to.fill('2026-01-09');
  await to.press('Enter');
  await expect(page.locator('#tracesRangeError')).toHaveText('Max range is 7 days (server setting traces.max_lookback_minutes).');
  await page.waitForTimeout(500);
  expect(searches).toBe(0);
  await expect(panel).toBeVisible();

  // Grafana expressions, applied with Enter in the field.
  await from.fill('now-6h');
  await to.fill('now');
  const searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await to.press('Enter');
  const params = searchParams(await searched);
  const clock = Date.now();
  expect(Number(params.end_ms) - Number(params.start_ms)).toBe(6 * 3_600_000);
  expect(Math.abs(Number(params.end_ms) - clock)).toBeLessThan(15_000);
  expect(params.align_buckets).toBe('1');
  await expect(panel).toBeHidden();
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('Time range · Last 6 hours');

  // Rounding: "now/d" From / To covers today.
  await openTimeRange(page);
  await expect(from).toHaveValue('now-6h');
  await from.fill('now/d');
  await to.fill('now/d');
  const today = page.waitForRequest(isSearch, { timeout: 60_000 });
  await apply.click();
  const todayParams = searchParams(await today);
  expect(Number(todayParams.start_ms)).toBe(utcMidnight(Date.now()));
  expect(Number(todayParams.end_ms)).toBe(utcMidnight(Date.now()) + DAY_MS - 1);
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('Time range · Today');
});

test('traces: quick ranges are searchable and only offer ranges within the max range', async ({ page }) => {
  test.setTimeout(90_000);
  await openTracesIdle(page);
  await openTimeRange(page);
  const items = page.locator('#tracesQuickRanges [data-group="quick"] .timeRangeList__item');
  await expect(items.filter({ hasText: /^Last 7 days$/ })).toHaveCount(1);
  await expect(items.filter({ hasText: /^Last 30 days$/ })).toHaveCount(0);
  await expect(items.filter({ hasText: /^This month$/ })).toHaveCount(0);
  await expect(items.filter({ hasText: /^Last 1 hour$/ })).toHaveAttribute('aria-current', 'true');

  const search = page.locator('#tracesQuickRangeSearch');
  await search.fill('hour');
  await expect(items).toHaveText(['Last 1 hour', 'Last 6 hours', 'Last 24 hours']);
  await search.fill('day');
  await expect(items).toHaveText(['Last 7 days', 'Today', 'Yesterday']);
  await search.fill('nothing like this');
  await expect(items).toHaveCount(0);
  await expect(page.locator('#tracesQuickRanges .timeRangeList__empty')).toBeVisible();
  // A typed duration becomes a range of its own.
  await search.fill('45m');
  await expect(items.first()).toHaveText('Last 45 minutes');
  const searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await search.press('Enter');
  const params = searchParams(await searched);
  expect(Number(params.end_ms) - Number(params.start_ms)).toBe(45 * 60_000);
  await expect(page.locator('#tracesTimeRangePanel')).toBeHidden();
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('Time range · Last 45 minutes');

  await openTimeRange(page);
  const yesterday = page.waitForRequest(isSearch, { timeout: 60_000 });
  await items.filter({ hasText: /^Yesterday$/ }).click();
  const y = searchParams(await yesterday);
  expect(Number(y.start_ms)).toBe(utcMidnight(Date.now()) - DAY_MS);
  expect(Number(y.end_ms)).toBe(utcMidnight(Date.now()) - 1);
});

test('traces: recently used ranges persist across reloads and apply in one click', async ({ page }) => {
  test.setTimeout(90_000);
  await openTracesIdle(page);
  await openTimeRange(page);
  await expect(page.locator('#tracesQuickRanges [data-group="recent"]')).toHaveCount(0);
  await page.locator('#tracesRangeStart').fill('2026-09-14 06:00');
  await page.locator('#tracesRangeEnd').fill('2026-09-14 18:30');
  let answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  await answered;
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('2026-09-14 06:00 → 18:30');
  await openTimeRange(page);
  await page.locator('#tracesRangeStart').fill('now-2d');
  await page.locator('#tracesRangeEnd').fill('now-1d');
  answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  await answered;
  await page.waitForLoadState('networkidle');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await openTimeRange(page);
  const recent = page.locator('#tracesQuickRanges [data-group="recent"] .timeRangeList__item');
  await expect(recent).toHaveText(['now-2d → now-1d', '2026-09-14 06:00 → 18:30']);
  const searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await recent.nth(1).click();
  const params = searchParams(await searched);
  expect(Number(params.start_ms)).toBe(Date.UTC(2026, 8, 14, 6, 0, 0));
  expect(Number(params.end_ms)).toBe(Date.UTC(2026, 8, 14, 18, 30, 0));
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('2026-09-14 06:00 → 18:30');
  // Most recent first.
  await openTimeRange(page);
  await expect(recent).toHaveText(['2026-09-14 06:00 → 18:30', 'now-2d → now-1d']);
});

test('traces: the time range panel works from the keyboard (Escape, calendar arrows, Enter)', async ({ page }) => {
  test.setTimeout(90_000);
  await openTracesIdle(page);
  const button = page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button');
  await button.focus();
  await page.keyboard.press('Enter');
  const panel = page.locator('#tracesTimeRangePanel');
  await expect(panel).toBeVisible();
  await expect(page.locator('#tracesRangeStart')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');

  // Tabbing out of the panel closes it.
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await page.locator('#tracesRangeShiftForward').focus();
  await page.keyboard.press('Tab');
  await expect(panel).toBeHidden();

  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  // Tab order: From, To, the four calendar arrows, then the day grid.
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
  const focusedDay = () => page.evaluate(() => document.activeElement?.dataset?.day || '');
  // The calendar opens on the day of the applied From (now-1h).
  const base = utcMidnight(Date.now() - 3_600_000);
  expect(await focusedDay()).toBe(utcDay(base));
  await page.keyboard.press('ArrowRight');
  expect(await focusedDay()).toBe(utcDay(base + DAY_MS));
  await page.keyboard.press('ArrowUp');
  expect(await focusedDay()).toBe(utcDay(base - 6 * DAY_MS));
  await page.keyboard.press('ArrowLeft');
  const startKey = utcDay(base - 7 * DAY_MS);
  expect(await focusedDay()).toBe(startKey);
  // PageUp / PageDown move a month and keep the focus on a day of the grid.
  await page.keyboard.press('PageUp');
  const monthBack = await focusedDay();
  expect(monthBack.slice(0, 7) < startKey.slice(0, 7)).toBe(true);
  await page.keyboard.press('PageDown');
  expect(await focusedDay()).toBe(startKey);
  // Enter picks the start; the grid keeps the focus and now picks the end.
  await page.keyboard.press('Enter');
  await expect(page.locator('#tracesRangeStart')).toHaveValue(`${startKey} 00:00:00`);
  await expect(page.locator('#tracesTimeCalendarHint')).toHaveText('Pick the end date · max 7 days');
  expect(await focusedDay()).toBe(startKey);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tracesTimeCalendar .timeCalendar__day.is-preview')).toHaveCount(2);
  await page.keyboard.press('Enter');
  const endKey = utcDay(base - 5 * DAY_MS);
  await expect(page.locator('#tracesRangeEnd')).toHaveValue(`${endKey} 23:59:59`);
  await expect(page.locator('#tracesCustomRangeApply')).toBeFocused();
  const searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.keyboard.press('Enter');
  const params = searchParams(await searched);
  expect(Number(params.start_ms)).toBe(base - 7 * DAY_MS);
  expect(Number(params.end_ms)).toBe(base - 4 * DAY_MS - 1000);
  await expect(panel).toBeHidden();
  await expect(button).toHaveText(`${startKey} 00:00 → ${endKey} 23:59`);
});

test('traces: shift and zoom out move the applied window like Grafana, within the max range', async ({ page }) => {
  test.setTimeout(90_000);
  await openTracesIdle(page);
  await openTimeRange(page);
  await page.locator('#tracesRangeStart').fill('2026-09-14 06:00:00');
  await page.locator('#tracesRangeEnd').fill('2026-09-14 10:00:00');
  let searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  await searched;
  await openTimeRange(page);
  await expect(page.locator('#tracesTimeZone')).toHaveText('Browser time · UTC (UTC+00:00)');
  searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.locator('#tracesRangeShiftBack').click();
  let params = searchParams(await searched);
  expect([Number(params.start_ms), Number(params.end_ms)]).toEqual([Date.UTC(2026, 8, 14, 4), Date.UTC(2026, 8, 14, 8)]);
  // The panel stays open and follows the applied range.
  await expect(page.locator('#tracesRangeStart')).toHaveValue('2026-09-14 04:00:00');
  await page.waitForLoadState('networkidle');
  searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.locator('#tracesRangeZoomOut').click();
  params = searchParams(await searched);
  expect([Number(params.start_ms), Number(params.end_ms)]).toEqual([Date.UTC(2026, 8, 14, 2), Date.UTC(2026, 8, 14, 10)]);
  await page.waitForLoadState('networkidle');
  searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.locator('#tracesRangeShiftForward').click();
  params = searchParams(await searched);
  expect([Number(params.start_ms), Number(params.end_ms)]).toEqual([Date.UTC(2026, 8, 14, 6), Date.UTC(2026, 8, 14, 14)]);
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toHaveText('2026-09-14 06:00 → 14:00');
  await page.waitForLoadState('networkidle');
  // Zooming out stops at the max range.
  await page.locator('#tracesRangeStart').fill('2026-09-10 00:00:00');
  await page.locator('#tracesRangeEnd').fill('2026-09-17 00:00:00');
  searched = page.waitForRequest(isSearch, { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  await searched;
  await page.waitForLoadState('networkidle');
  await openTimeRange(page);
  await expect(page.locator('#tracesRangeZoomOut')).toBeDisabled();
});

// --- Traces analytics charts --------------------------------------------------
const isAnalyticsPart = (charts) => (response) => new URL(response.url()).pathname.endsWith('/api/traces/analytics')
  && new URL(response.url()).searchParams.get('charts') === charts;

test.describe('traces analytics in a UTC+2 browser', () => {
  // Paris in September: local midnight is 22:00 UTC, off the UTC 3 h grid
  // that used to leave the count chart empty for such ranges.
  test.use({ timezoneId: 'Europe/Paris' });

  test('traces: a 7-day range fills both charts with dated ticks, whole-unit durations, and hover snaps anywhere', async ({ page, request }) => {
    test.setTimeout(240_000);
    const [[endText]] = await otelRows(request, 'SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts');
    const dataEnd = Number(endText);
    test.skip(!(dataEnd > 0), 'OTEL fixture is empty');
    await openTracesIdle(page);
    // The fixture's last seven local days.
    const [firstDay, lastDay] = await page.evaluate((end) => {
      const last = new Date(end);
      const first = new Date(last.getFullYear(), last.getMonth(), last.getDate() - 6);
      const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return [day(first), day(last)];
    }, dataEnd);
    await openTimeRange(page);
    await page.locator('#tracesRangeStart').fill(`${firstDay} 00:00:00`);
    await page.locator('#tracesRangeEnd').fill(`${lastDay} 23:59:59`);
    const counts = page.waitForResponse(isAnalyticsPart('counts'), { timeout: 60_000 });
    const durations = page.waitForResponse(isAnalyticsPart('durations'), { timeout: 200_000 });
    await page.locator('#tracesCustomRangeApply').click();

    const countsResponse = await counts;
    expect(countsResponse.status()).toBe(200);
    const countsParams = new URL(countsResponse.url()).searchParams;
    // Buckets are anchored at the browser's local midnight (the range start).
    expect(countsParams.get('bucket_origin_ms')).toBe(countsParams.get('start_ms'));
    const countsPayload = await countsResponse.json();
    expect(countsPayload.trace_count_chart.length).toBeGreaterThan(0);
    const countChart = chartCore(page.locator('#traceServiceChart'));
    await expect(countChart).toHaveAttribute('data-points-drawn', /^[1-9]/, { timeout: 30_000 });

    const durationsResponse = await durations;
    expect(durationsResponse.status()).toBe(200);
    const durationsPayload = await durationsResponse.json();
    expect(durationsPayload.duration_quantiles.length).toBeGreaterThan(0);
    const durationChart = chartCore(page.locator('#traceDurationChart'));
    // One line per percentile (a lone bucket is a dot), over the listed traces.
    await expect(durationChart).toHaveAttribute('data-series-stats', /"P99"/);
    const stats = await chartJson(durationChart, 'data-series-stats');
    for (const q of ['P50', 'P90', 'P95', 'P99']) expect(stats[q].points).toBeGreaterThan(0);
    // One bar per bucket holding traces (the exact counts of the second answer).
    const [rangeStart, rangeEnd] = durationsPayload.range.map(Number);
    const bucketMs = Number(durationsPayload.bucket_ms);
    const nonEmpty = durationsPayload.trace_count_chart.filter(([bucket, count]) => Number(count) > 0 && Number(bucket) + bucketMs > rangeStart && Number(bucket) <= rangeEnd).length;
    await expect(countChart).toHaveAttribute('data-points-drawn', String(nonEmpty));

    for (const root of [countChart, durationChart]) {
      // [label, context, left, right] of every x label drawn.
      const ticks = await chartJson(root, 'data-x-ticks');
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      // A multi-day axis reads days ("Sep 13") or clock times dated where the
      // day changes ("00:00" over "Sep 14 2026"), the first label dated too.
      for (const [label, context] of ticks) {
        expect(label).toMatch(/^([A-Z][a-z]{2} \d{1,2}|\d\d:\d\d)$/);
        if (label === '00:00') expect(context).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{4}$/);
      }
      expect(ticks[0][1]).toMatch(/\d{4}$/);
      for (let i = 1; i < ticks.length; i += 1) expect(ticks[i][2]).toBeGreaterThan(ticks[i - 1][3] + 4);
    }
    // Whole units: "10 min", "8 min 30 s", never "8.5 min".
    const decimalUnits = /\d\.\d+\s*(min|h|d)\b/;
    for (const label of await chartJson(durationChart, 'data-y-ticks')) expect(label).not.toMatch(decimalUnits);
    for (const label of await page.locator('#tracesResults .traceResult__right > b').allTextContents()) expect(label).not.toMatch(decimalUnits);

    // Every x position over a chart snaps to a bucket: a tooltip with the
    // bucket's date and time, and exactly one cursor (a bucket or a picked dot).
    for (const root of [countChart, durationChart]) {
      const box = await plotBox(root);
      const tooltip = root.locator('.chartCore__tooltip');
      const marked = async () => Number((await root.getAttribute('data-cursor-index')) !== null) + Number((await root.getAttribute('data-pick')) !== null);
      for (let i = 0; i <= 30; i += 1) {
        await page.mouse.move(box.x + 1 + (box.width - 2) * (i / 30), box.y + box.height * (0.15 + 0.7 * ((i % 4) / 3)));
        await expect(tooltip).toBeVisible();
        // A bucket reads its range (format.range), a picked dot its start (format.time).
        await expect(tooltip).toContainText(/\d{4}-\d\d-\d\d \d\d:\d\d \u2192 |Start [A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d\d:\d\d:\d\d/);
        await expect(tooltip).not.toContainText(decimalUnits);
        // Near a listed trace's dot the dot is picked instead of the bucket.
        await expect.poll(marked).toBe(1);
      }
      await page.mouse.move(box.x + box.width / 2, box.y - 80);
      await expect(tooltip).toBeHidden();
      await expect.poll(marked).toBe(0);
    }
  });
});

test('traces: a result shows its error span count next to its title and the header counts traces with errors', async ({ page, request }) => {
  test.setTimeout(90_000);
  const [[endText]] = await otelRows(request, 'SELECT toUnixTimestamp64Milli(max(Start)) FROM otel.otel_traces_trace_id_ts');
  const dataEnd = Number(endText);
  test.skip(!(dataEnd > 0), 'OTEL fixture is empty');
  // Known error counts on the real answer: 3 and 1 on the first two traces, none elsewhere.
  const errorsById = new Map();
  await page.route('**/api/traces/search?**', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    errorsById.clear();
    payload.rows = (payload.rows || []).map((row, i) => {
      const copy = [...row];
      copy[6] = i === 0 ? 3 : i === 1 ? 1 : 0;
      errorsById.set(String(copy[0]), copy[6]);
      return copy;
    });
    await route.fulfill({ response, json: payload });
  });
  await openTracesIdle(page);
  const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  await openTimeRange(page);
  await page.locator('#tracesRangeStart').fill(utc(dataEnd - 3_600_000));
  await page.locator('#tracesRangeEnd').fill(utc(dataEnd + 1000));
  const answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.locator('#tracesCustomRangeApply').click();
  const rows = (await (await answered).json()).rows;
  expect(rows.length).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#tracesResults .traceResult[data-trace-id]')).toHaveCount(rows.length);
  await expect(page.locator('#tracesResultCount')).toHaveText(new RegExp(`^${rows.length} Traces \\(in [\\d.]+ (µs|ms|s)\\) · 2 with errors$`));
  for (const [id, errors] of errorsById) {
    const card = page.locator(`#tracesResults .traceResult[data-trace-id="${id}"]`);
    if (errors) {
      const badge = card.locator('.traceResult__wideTitle + .traceErrorCount--title');
      await expect(badge).toHaveText(`${errors} Error${errors === 1 ? '' : 's'}`);
      await expect(badge).toHaveAttribute('title', `${errors} error span${errors === 1 ? '' : 's'}`);
    } else {
      await expect(card.locator('.traceErrorCount--title')).toHaveCount(0);
    }
  }
  // The total is shown once, next to the title (per-service badges stay).
  await expect(page.locator('#tracesResults .traceErrorCount--total')).toHaveCount(0);
  const color = await page.locator('#tracesResults .traceErrorCount--title').first().evaluate((node) => getComputedStyle(node).color);
  expect(color).toBe('rgb(248, 113, 113)'); // --danger, dark theme
});

// --- Traces search results: Jaeger result items, table view, scatter -------
async function openSyntheticTraces(page, options = {}) {
  const searches = await mockTraceResults(page, options);
  const answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.goto('/observability/traces');
  await answered;
  await expect(page.locator('#tracesResults [data-trace-id]').first()).toBeVisible({ timeout: 30_000 });
  return searches;
}

const syntheticById = Object.fromEntries(SYNTHETIC_TRACES.map((trace) => [trace.trace_id, trace]));
const syntheticName = (trace) => `${trace.service}: ${trace.operation}`;

test('traces: result items carry a duration bar, Jaeger tags, the full trace id and one line of service pills', async ({ page }) => {
  test.setTimeout(90_000);
  await openSyntheticTraces(page);
  const items = page.locator('#tracesResults .traceResultItem[data-trace-id]');
  await expect(items).toHaveCount(SYNTHETIC_TRACES.length);
  // "N Traces (in X ms)": the search latency measured by the browser.
  await expect(page.locator('#tracesResultCount')).toHaveText(/^6 Traces \(in \d+(\.\d+)? (µs|ms|s)\) · 2 with errors$/);

  const maxMs = Math.max(...SYNTHETIC_TRACES.map((trace) => trace.duration_ms));
  for (const trace of SYNTHETIC_TRACES) {
    const item = page.locator(`#tracesResults .traceResultItem[data-trace-id="${trace.trace_id}"]`);
    // Duration bar: the share of the longest listed duration, behind the title line.
    const [barWidth, lineWidth] = await item.locator('.traceResultItem__title').evaluate((line) => [line.querySelector('.traceResultItem__durationBar').getBoundingClientRect().width, line.getBoundingClientRect().width]);
    expect(Math.abs(barWidth / lineWidth - trace.duration_ms / maxMs)).toBeLessThan(0.01);
    await expect(item.locator('.traceResult__wideTitle')).toHaveText(syntheticName(trace));
    // The full trace id, never shortened or clipped.
    const id = item.locator('.traceResult__fullId');
    await expect(id).toHaveText(trace.trace_id);
    expect(await id.evaluate((node) => node.scrollWidth <= node.clientWidth + 0.5)).toBe(true);
    await expect(item.locator('.traceTag--spans')).toHaveText(`${trace.spans} Span${trace.spans === 1 ? '' : 's'}`);
    const errorTag = item.locator('.traceResult__wideTitle + .traceErrorCount--title');
    if (trace.errors) {
      await expect(errorTag).toHaveText(`${trace.errors} Error${trace.errors === 1 ? '' : 's'}`);
      await expect(errorTag).toHaveAttribute('title', `${trace.errors} error span${trace.errors === 1 ? '' : 's'}`);
      expect(await errorTag.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(248, 113, 113)'); // --danger
    } else {
      await expect(item.locator('.traceErrorCount--title')).toHaveCount(0);
    }
    const incomplete = item.locator('.traceTag--incomplete');
    if (trace.missing) {
      await expect(incomplete).toHaveText('Incomplete');
      await expect(incomplete).toHaveAttribute('title', new RegExp(`may be incomplete: .*${trace.missing} parent spans`));
    } else {
      await expect(incomplete).toHaveCount(0);
    }
    // Service pills in first-span order, "name (count)", colored left border,
    // (!) before services with error spans.
    const pills = item.locator('.traceSvcPills > .traceSvcPill');
    const expected = [...trace.services].sort((a, b) => a[3] - b[3]);
    expect(await pills.evaluateAll((nodes) => nodes.map((node) => node.dataset.service))).toEqual(expected.map(([name]) => name));
    const first = pills.first();
    if (await first.isVisible()) {
      const [name, spans, errors] = expected[0];
      await expect(first).toHaveText(`${errors ? '!' : ''}${name} (${spans})`);
      const border = await first.evaluate((node) => { const style = getComputedStyle(node); return [style.borderLeftWidth, style.borderLeftColor, style.getPropertyValue('--trace-service-color').trim()]; });
      expect(border[0]).toBe('4px');
      const probe = await page.evaluate((color) => { const el = document.createElement('i'); el.style.color = color; document.body.appendChild(el); const out = getComputedStyle(el).color; el.remove(); return out; }, border[2]);
      expect(border[1]).toBe(probe);
    }
    for (const [name, , errors] of expected) {
      await expect(item.locator(`.traceSvcPill[data-service="${name}"] .traceSvcPill__error`)).toHaveCount(errors ? 1 : 0);
    }
  }

  // The 20-service trace: one line, the rest behind "+N" with a popover.
  const mesh = page.locator('#tracesResults .traceResultItem[data-trace-id="c1d2e3f4a5b60718293a4b5c6d7e8f90"]');
  const visible = mesh.locator('.traceSvcPills > .traceSvcPill:visible');
  const shown = await visible.count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(20);
  const more = mesh.locator('.traceSvcMore');
  await expect(more).toBeVisible();
  await expect(more).toHaveText(`+${20 - shown}`);
  const geometry = await mesh.locator('.traceSvcPills').evaluate((group) => {
    const box = group.getBoundingClientRect();
    const shownNodes = [...group.children].filter((node) => !node.hidden);
    return { tops: [...new Set(shownNodes.map((node) => Math.round(node.getBoundingClientRect().top)))], right: Math.max(...shownNodes.map((node) => node.getBoundingClientRect().right)), boxRight: box.right };
  });
  expect(geometry.tops).toHaveLength(1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.boxRight + 0.5);
  await more.hover();
  const popover = page.locator('.traceSvcPopover');
  await expect(popover).toBeVisible();
  const hiddenNames = await mesh.locator('.traceSvcPills > .traceSvcPill[hidden]').evaluateAll((nodes) => nodes.map((node) => node.dataset.service));
  expect(await popover.locator('.traceSvcPill').evaluateAll((nodes) => nodes.map((node) => node.dataset.service))).toEqual(hiddenNames);
  await page.mouse.move(5, 5);
  await expect(popover).toBeHidden();
  // A narrower window shows fewer pills, still on one line.
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => mesh.locator('.traceSvcPills > .traceSvcPill:visible').count()).toBeLessThan(shown);
  await expect(more).toHaveText(`+${20 - await mesh.locator('.traceSvcPills > .traceSvcPill:visible').count()}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('traces: the table view sorts every column both ways, opens a row, and is remembered', async ({ page }) => {
  test.setTimeout(90_000);
  await openSyntheticTraces(page);
  await expect(page.locator('[data-results-view="list"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-results-view="table"]').click();
  await expect(page.locator('[data-results-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceResultsView.v1'))).toBe('table');
  // Like Jaeger, the sort picker drives the list only.
  await expect(page.locator('.traceResultsSort')).toBeHidden();
  const table = page.locator('#tracesResults table.resultTable.traceTable');
  await expect(table).toBeVisible();
  await expect(table.locator('thead th')).toHaveText(['Name', 'Services', 'Spans', 'Errors', 'Duration', 'Start']);
  const rows = table.locator('tbody tr[data-trace-id]');
  await expect(rows).toHaveCount(SYNTHETIC_TRACES.length);
  const order = () => rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.traceId));
  // The picker's order (Most Recent) carries over: Start, newest first.
  await expect(table.locator('th[data-table-sort="start"]')).toHaveAttribute('data-sort', 'desc');
  const byKey = {
    name: (t) => syntheticName(t).toLowerCase(),
    services: (t) => t.services.length,
    spans: (t) => t.spans,
    errors: (t) => t.errors,
    duration: (t) => t.duration_ms,
    start: (t) => -t.minutesAgo,
  };
  const expectedOrder = (key, dir) => [...SYNTHETIC_TRACES].sort((a, b) => {
    const av = byKey[key](a), bv = byKey[key](b);
    const cmp = typeof av === 'string' ? (av < bv ? -1 : av > bv ? 1 : 0) : av - bv;
    return (dir === 'asc' ? cmp : -cmp) || (a.minutesAgo - b.minutesAgo);
  }).map((t) => t.trace_id);
  for (const key of ['name', 'services', 'spans', 'errors', 'duration', 'start']) {
    const th = table.locator(`th[data-table-sort="${key}"]`);
    await th.click();
    const firstDir = key === 'name' ? 'asc' : 'desc';
    await expect(th).toHaveAttribute('data-sort', firstDir);
    expect(await order(), `${key} ${firstDir}`).toEqual(expectedOrder(key, firstDir));
    await th.click();
    const secondDir = firstDir === 'asc' ? 'desc' : 'asc';
    await expect(th).toHaveAttribute('data-sort', secondDir);
    expect(await order(), `${key} ${secondDir}`).toEqual(expectedOrder(key, secondDir));
    await expect(table.locator('th[data-sort]')).toHaveCount(1);
  }
  // Cells: pills with overflow, error tag, relative duration bar, start.
  const mesh = rows.filter({ has: page.locator('[data-service="mesh-service-00"]') });
  await expect(mesh.locator('.traceSvcMore')).toBeVisible();
  await expect(mesh.locator('.traceSvcMore')).toHaveText(/^\+\d+$/);
  const failing = table.locator('tr[data-trace-id="0af7651916cd43dd8448eb211c80319c"]');
  await expect(failing.locator('[data-cell="errors"] .traceTag--error')).toHaveText('3');
  await expect(failing.locator('[data-cell="name"]')).toHaveText('frontend: GET /checkout');
  await expect(failing.locator('[data-cell="duration"]')).toContainText('420 ms');
  const percent = Number(await failing.locator('[data-cell="duration"] [data-duration-percent]').getAttribute('data-duration-percent'));
  expect(Math.abs(percent - (420 / 610) * 100)).toBeLessThan(0.05);
  await expect(table.locator('tr[data-trace-id="5b8efff798038103d269b633813fc60c"] .traceTag--incomplete')).toHaveCount(1);
  const start = failing.locator('[data-cell="start"]');
  // One 24 h format (ns.format.time), the year only when it is not this one;
  // the tooltip says how long ago, then ISO, local and UTC (format.timeTitle).
  await expect(start).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d\d:\d\d:\d\d$/);
  await expect(start).toHaveAttribute('title', /^\d+ \w+ ago\n\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n/);
  await table.locator('[data-start-toggle]').click();
  await expect(start).toHaveText(/^\d+ minutes? ago$/);
  await expect(start).toHaveAttribute('title', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n[A-Z][a-z]{2} \d{1,2}, \d{4} \d\d:\d\d:\d\d\.\d{3} local/);
  // Sorting by Start is numeric, not by the displayed text.
  await table.locator('th[data-table-sort="start"]').click();
  expect(await order()).toEqual(expectedOrder('start', 'desc'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The choice survives a reload.
  const again = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.reload();
  await again;
  await expect(page.locator('#tracesResults table.traceTable tbody tr[data-trace-id]')).toHaveCount(SYNTHETIC_TRACES.length);
  await expect(page.locator('[data-results-view="table"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#tracesResults table.traceTable [data-cell="start"]').first()).toHaveText(/ago$/);

  // A row (and Enter on a focused row) opens its trace.
  await page.locator('#tracesResults tr[data-trace-id="ffeeddccbbaa99887766554433221100"] [data-cell="spans"]').click();
  // The trace URL carries the search context (here the table view).
  await expect(page).toHaveURL(/\/observability\/traces\/ffeeddccbbaa99887766554433221100(?:\?results=table)?$/);
  await expect(page.locator('#traceDetail')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  const row = page.locator('#tracesResults tr[data-trace-id="00112233445566778899aabbccddeeff"]');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/observability\/traces\/00112233445566778899aabbccddeeff(?:\?results=table)?$/);
});

test('traces: the duration chart plots the listed traces as dots over a padded duration axis, and a dot opens its trace', async ({ page }) => {
  test.setTimeout(90_000);
  await openSyntheticTraces(page);
  const chart = page.locator('#traceDurationChart');
  const root = chartCore(chart);
  // The scatter as drawn (client coordinates), from the traces module's hook.
  const scatter = () => page.evaluate(() => window.ChDash.traces.scatterDots());
  await expect.poll(async () => (await scatter()).length).toBe(SYNTHETIC_TRACES.length);
  const dots = await scatter();
  expect(dots.map((dot) => dot.trace_id).sort()).toEqual(SYNTHETIC_TRACES.map((t) => t.trace_id).sort());
  const errorIds = SYNTHETIC_TRACES.filter((t) => t.errors).map((t) => t.trace_id).sort();
  expect(dots.filter((dot) => dot.error).map((dot) => dot.trace_id).sort()).toEqual(errorIds);
  // Error dots are red, the others teal (the canvas pixel at the dot farthest
  // from the percentile lines, 400-440 ms).
  const clear = (list) => list.map((dot) => [Math.abs(SYNTHETIC_TRACES.find((t) => t.trace_id === dot.trace_id).duration_ms - 420), dot]).sort((a, b) => b[0] - a[0])[0][1];
  const red = await canvasPixel(root, clear(dots.filter((dot) => dot.error)).x, clear(dots.filter((dot) => dot.error)).y);
  const teal = await canvasPixel(root, clear(dots.filter((dot) => !dot.error)).x, clear(dots.filter((dot) => !dot.error)).y);
  expect(red[0]).toBeGreaterThan(red[2] + 30);
  expect(teal[2]).toBeGreaterThan(teal[0] + 30);
  // Radius grows with the span count; a longer trace sits higher.
  const geometry = Object.fromEntries(dots.map((dot) => [dot.trace_id, { r: dot.r, cx: dot.x, cy: dot.y }]));
  const bySpans = [...SYNTHETIC_TRACES].sort((a, b) => a.spans - b.spans);
  for (let i = 1; i < bySpans.length; i += 1) expect(geometry[bySpans[i].trace_id].r).toBeGreaterThanOrEqual(geometry[bySpans[i - 1].trace_id].r);
  expect(geometry[bySpans[bySpans.length - 1].trace_id].r).toBeGreaterThan(geometry[bySpans[0].trace_id].r);
  const byDuration = [...SYNTHETIC_TRACES].sort((a, b) => a.duration_ms - b.duration_ms);
  for (let i = 1; i < byDuration.length; i += 1) expect(geometry[byDuration[i].trace_id].cy).toBeLessThan(geometry[byDuration[i - 1].trace_id].cy);
  const byStart = [...SYNTHETIC_TRACES].sort((a, b) => b.minutesAgo - a.minutesAgo);
  for (let i = 1; i < byStart.length; i += 1) expect(geometry[byStart[i].trace_id].cx).toBeGreaterThan(geometry[byStart[i - 1].trace_id].cx);

  // Padded min-max domain (Jaeger's ['auto', 'auto']): 330-610 ms of data and
  // 400-440 ms percentiles read 300 ms to 650 ms, not from 0.
  expect(Number(await root.getAttribute('data-y-min'))).toBe(300e6);
  expect(Number(await root.getAttribute('data-y-max'))).toBe(650e6);
  expect(await chartJson(root, 'data-y-ticks')).toEqual(['300 ms', '350 ms', '400 ms', '450 ms', '500 ms', '550 ms', '600 ms', '650 ms']);
  // The percentile lines share the axis (drawn, not clipped away).
  const stats = await chartJson(root, 'data-series-stats');
  expect(stats.P50.points).toBeGreaterThan(0);
  expect(stats.P99.points).toBeGreaterThan(0);

  // Hovering a dot picks it over the percentile snap; clicking opens the trace.
  const target = SYNTHETIC_TRACES[3];
  const dot = dots.find((d) => d.trace_id === target.trace_id);
  const box = { x: dot.x - dot.r, y: dot.y - dot.r, width: 2 * dot.r, height: 2 * dot.r };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tooltip = root.locator('.chartCore__tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('strong')).toHaveText(syntheticName(target));
  await expect(tooltip).toContainText(`Spans ${target.spans}`);
  await expect(tooltip).toContainText(`Services ${target.services.length}`);
  await expect(tooltip).toContainText('Duration 610 ms');
  await expect(tooltip).toContainText(/Start [A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d\d:\d\d:\d\d/);
  const order = (await page.evaluate(() => window.ChDash.traces.scatterDots().map((d) => d.trace_id))).indexOf(target.trace_id);
  await expect(root).toHaveAttribute('data-pick', `traces:${order}`);
  await expect(root.locator('.chartCore__pick')).toBeVisible();
  await expect(root).not.toHaveAttribute('data-cursor-index', /./);
  // Away from the dots the pointer snaps to the percentile buckets again.
  const plot = await plotBox(root);
  await page.mouse.move(plot.x + plot.width * 0.2, plot.y + 14);
  await expect(root).toHaveAttribute('data-cursor-index', /^\d+$/);
  await expect(root).not.toHaveAttribute('data-pick', /./);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${target.trace_id}$`));
  await expect(page.locator('#traceDetail')).toBeVisible();
});

test('traces: a drag across a chart searches that time range, and the charts share one crosshair', async ({ page }) => {
  test.setTimeout(90_000);
  const searches = await openSyntheticTraces(page);
  const counts = chartCore(page.locator('#traceServiceChart'));
  const durations = chartCore(page.locator('#traceDurationChart'));
  await expect(counts).toHaveAttribute('data-points-drawn', /^[1-9]/);
  await expect(durations).toHaveAttribute('data-points-drawn', /^[1-9]/);
  const box = await plotBox(counts);
  // Hovering one chart shows the same instant on the other.
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(counts).toHaveAttribute('data-cursor-index', /^\d+$/);
  await expect(durations).toHaveAttribute('data-sync-x', /^\d+(\.\d+)?$/);
  // Drag from a quarter to three quarters of the plot: a search of that range.
  const xMin = Number(await counts.getAttribute('data-x-min'));
  const span = Number(await counts.getAttribute('data-x-max')) - xMin;
  const before = searches.length;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => searches.length).toBeGreaterThan(before);
  const params = searches[searches.length - 1];
  expect(Math.abs(Number(params.start_ms) - (xMin + span * 0.25))).toBeLessThan(span * 0.03);
  expect(Math.abs(Number(params.end_ms) - (xMin + span * 0.75))).toBeLessThan(span * 0.03);
  await expect.poll(() => new URL(page.url()).searchParams.get('from')).toBeTruthy();
  // The new answer redraws the charts over the new range, not zoomed.
  await expect(counts).toHaveAttribute('data-zoomed', 'false');
  await expect.poll(async () => Number(await counts.getAttribute('data-x-max')) - Number(await counts.getAttribute('data-x-min'))).toBeLessThan(span * 0.6);
});

test('traces: an empty result names the searched range and zooms out from there', async ({ page }) => {
  test.setTimeout(90_000);
  const searches = await mockTraceResults(page, { traces: [] });
  const answered = page.waitForResponse((response) => isSearch(response.request()), { timeout: 60_000 });
  await page.goto('/observability/traces');
  await answered;
  const empty = page.locator('#tracesResults [data-empty-results]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No traces found');
  const first = searches[searches.length - 1];
  const format = (ms) => page.evaluate((value) => window.ChDash.format.time(value), ms);
  await expect(empty).toContainText(`No traces match these filters between ${await format(Number(first.start_ms))} and ${await format(Number(first.end_ms))}.`);
  await expect(page.locator('#tracesResultCount')).toHaveText(/^0 Traces \(in [\d.]+ (µs|ms|s)\)$/);
  const next = page.waitForRequest(isSearch, { timeout: 60_000 });
  await empty.locator('[data-results-zoom-out]').click();
  const params = searchParams(await next);
  const span = Number(first.end_ms) - Number(first.start_ms);
  expect(Number(params.end_ms) - Number(params.start_ms)).toBeGreaterThanOrEqual(span * 2 - 2000);
  expect(Number(params.start_ms)).toBeLessThan(Number(first.start_ms));
});
