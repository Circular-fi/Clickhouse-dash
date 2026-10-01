import { test, expect } from '@playwright/test';
import { openApp, openExplorer, openExplorerDatabase } from '../helpers/app.js';

// Explorer Storage section (server > database > table), the compact storage
// band of the database page, the Server operations section and the Functions
// overview.

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

async function openSection(page, buttonId) {
  await openApp(page);
  await openExplorer(page);
  await page.locator('#explorerSectionSelectButton').click();
  await page.locator(`#${buttonId}`).click();
}

// Rewrites the byte counters of real catalog tables, so a database can be
// given several tables of >= 1% while every click still opens a real object.
async function routeDatabaseSizes(page, database, sizes) {
  await page.route(new RegExp(`/api/explorer/catalog\\?.*database=${database}(?:&|$)`), async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const table of json.tables || []) {
      if (sizes[table.name] != null) {
        table.bytes = sizes[table.name];
        table.compressed_bytes = sizes[table.name];
      }
    }
    await route.fulfill({ response, json });
  });
}

function storageTable(name, bytes, rows, parts = 3, engine = 'MergeTree') {
  return { name, engine, bytes, rows, parts };
}

// A server whose distribution is worth a treemap: a big database, a narrow
// `system` database holding several tables, and a small one.
const SYNTHETIC_STORAGE = {
  version: 1, host_id: 'local', generated_at_ms: 1, stale: false, metric_scope: 'local-replica', byte_metric: 'bytes_on_disk',
  table_limit_per_database: 128, total_bytes: 1000e6, total_rows: 0, resident_bytes: 0, storing_tables: 7,
  databases: [
    { name: 'big', system: false, bytes: 880e6, rows: 9e6, resident_bytes: 0, objects: 2, storing_tables: 2, omitted_tables: 0, omitted_bytes: 0, omitted_rows: 0,
      tables: [storageTable('events', 800e6, 8e6), storageTable('events_index', 80e6, 1e6)] },
    { name: 'system', system: true, bytes: 80e6, rows: 3e6, resident_bytes: 0, objects: 120, storing_tables: 3, omitted_tables: 0, omitted_bytes: 0, omitted_rows: 0,
      tables: [storageTable('text_log', 50e6, 2e6), storageTable('query_log', 20e6, 6e5), storageTable('trace_log', 10e6, 4e5)] },
    { name: 'small', system: false, bytes: 40e6, rows: 1e5, resident_bytes: 1024, objects: 3, storing_tables: 2, omitted_tables: 0, omitted_bytes: 0, omitted_rows: 0,
      tables: [storageTable('facts', 39e6, 99000, 2, 'ReplacingMergeTree'), storageTable('tiny', 1e6, 1000, 1, 'TinyLog')] },
  ],
};

test('database page keeps storage compact: a share strip when one table dominates', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  const strip = page.locator('#explorerDatabaseStorageStrip');
  await expect(strip).toBeVisible();
  await expect(page.locator('#explorerDatabaseTreemap')).toHaveCount(0);
  const weather = strip.locator('.explorerStorageStrip__segment[data-table="weather_observations"]');
  await expect(weather).toContainText('weather_observations');
  // The small tables are grouped, resident-memory engines take no area.
  await expect(strip.locator('.explorerStorageStrip__segment.is-other')).toHaveCount(1);
  await expect(page.locator('.explorerStorageStrip__legend')).toContainText(/Others \(\d+ tables?\)/);
  await expect(strip.locator('[data-table="memory_weather"]')).toHaveCount(0);
  await expect(page.locator('.explorerDatabaseStorage__meta')).toContainText(/on disk · .*RAM/);
  // A dominant table no longer pushes the object list below the fold.
  expect((await strip.boundingBox()).height).toBeLessThan(40);
  expect((await page.locator('#explorerDatabaseObjects').boundingBox()).y).toBeLessThan(420);

  await weather.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');
  await expect(page.locator('#explorerDatabaseStorageStrip')).toHaveCount(0);
});

test('database page draws a bounded treemap band when three tables hold 1% or more', async ({ page }) => {
  await routeDatabaseSizes(page, 'chdash_ui', { weather_observations: 6_000_000, wide_types: 4_000_000, weather_daily_summary: 3_000_000 });
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  const map = page.locator('#explorerDatabaseTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/);
  await expect(page.locator('#explorerDatabaseStorageStrip')).toHaveCount(0);
  expect((await page.locator('#explorerDatabaseTreemap').boundingBox()).height).toBeLessThanOrEqual(242);
  const weather = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"][data-table="weather_observations"]');
  await expect(weather).toContainText('weather_observations');
  for (const table of ['wide_types', 'weather_daily_summary']) {
    await expect(page.locator(`#explorerDatabaseTreemap .explorerTreemap__node[data-table="${table}"]`)).toBeVisible();
  }
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="memory_weather"]')).toHaveCount(0);
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node.is-other')).toContainText(/Others/);
  await expect(page.locator('#explorerDetailContent .explorerTreemapFootnote')).toContainText(/On-disk bytes.*Others/);
  // Treemap labels use the text face, not monospace.
  const family = await weather.locator('.explorerTreemap__name').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).not.toMatch(/mono/i);

  await weather.hover();
  const tooltip = page.locator('#explorerDatabaseTreemap [data-treemap-tooltip]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('chdash_ui.weather_observations');
  await expect(tooltip).toContainText(/rows · Merge Tree · \d+(?:\.\d+)?% of chdash_ui/);
  await page.mouse.move(2, 2);
  await expect(tooltip).toBeHidden();

  await weather.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDatabaseTreemap')).toHaveCount(0);
});

test('database page links to the Storage section scoped to the database', async ({ page }) => {
  await openApp(page);
  await openExplorerDatabase(page);
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await page.locator('.explorerDatabaseStorage__link').click();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=chdash_ui$/);
  await expect(page.locator('.explorerStorageCrumbs__current')).toHaveText('chdash_ui');
  await expect(page.locator('#explorerStorageList tbody tr').first()).toHaveAttribute('data-name', 'weather_observations', { timeout: 15_000 });
});

test('Storage section lists databases by size and zooms into a database and a table with a breadcrumb', async ({ page }) => {
  await openSection(page, 'explorerSystemSectionButton');
  await expect(page).toHaveURL(/\/explorer\/_system$/);
  await expect(page.locator('#explorerSystemPane')).toBeVisible();
  await expect(page.locator('#explorerListView')).toBeHidden();
  await expect(page.locator('#explorerSectionSelectButton')).toHaveText('Storage');
  const list = page.locator('#explorerStorageList');
  await expect(list.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.explorerStorageView__meta')).toHaveText(/^[\d,]+ databases · [\d,]+ tables with data · \d+(?:\.\d+)?\s?[KMGTP]?B$/);
  await expect(list.locator('thead th')).toHaveText([/^Database/, /^Size/, /^Share/, /^Rows/, /^Tables/]);

  // Largest first; `system` is out of scope until the option is checked.
  const names = () => list.locator('tbody tr').evaluateAll((rows) => rows.map((tr) => tr.dataset.name));
  const sizes = await list.locator('tbody td.explorerStorageList__cell--bytes').evaluateAll((cells) => cells.map((td) => Number(td.dataset.value)));
  expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  expect(await names()).toContain('chdash_ui');
  expect(await names()).not.toContain('system');
  await page.locator('.explorerStorageView__option input').check();
  await expect(list.locator('tbody tr[data-name="system"]')).toBeVisible();
  await page.locator('.explorerStorageView__option input').uncheck();
  await expect(list.locator('tbody tr[data-name="system"]')).toHaveCount(0);

  // Sorting by name, then back to size.
  const nameHeader = list.locator('thead th').filter({ hasText: 'Database' });
  await nameHeader.locator('button').click();
  await expect(nameHeader).toHaveAttribute('data-sort', 'asc');
  const sortedNames = await names();
  expect(sortedNames).toEqual([...sortedNames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));

  // Zoom into a database: its storing tables, largest first.
  await list.locator('tbody tr[data-name="chdash_ui"] .explorerStorageList__name').click();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=chdash_ui$/);
  await expect(page.locator('.explorerStorageCrumbs__link')).toHaveText(['local']);
  await expect(page.locator('.explorerStorageCrumbs__current')).toHaveText('chdash_ui');
  await expect(list.locator('thead th')).toHaveText([/^Table/, /^Engine/, /^Size/, /^Share/, /^Rows/, /^Parts/]);
  await expect(list.locator('tbody tr').first()).toHaveAttribute('data-name', 'weather_observations');
  await expect(list.locator('tbody tr[data-name="memory_weather"]')).toHaveCount(0);
  await expect(page.locator('.explorerStorageView__footnote')).toContainText(/RAM of Memory \/ Buffer \/ Dictionary not counted/);

  // Zoom into a table: its partitions.
  await list.locator('tbody tr[data-name="weather_observations"]').click();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=chdash_ui&table=weather_observations$/);
  await expect(page.locator('.explorerStorageCrumbs__link')).toHaveText(['local', 'chdash_ui']);
  await expect(list.locator('thead th')).toHaveText([/^Partition/, /^Size/, /^Share/, /^Rows/, /^Parts/], { timeout: 15_000 });
  await expect(list.locator('tbody tr').first()).toBeVisible();
  await expect(page.locator('.explorerStorageView__meta')).toContainText(/Merge Tree · [\d,]+ partitions? · /);

  // A reload keeps the scope; the breadcrumb and Back zoom out.
  await page.reload();
  await expect(page.locator('.explorerStorageCrumbs__current')).toHaveText('weather_observations', { timeout: 15_000 });
  await page.locator('.explorerStorageCrumbs__link', { hasText: 'chdash_ui' }).click();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=chdash_ui$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=chdash_ui&table=weather_observations$/);
  await expect(page.locator('.explorerStorageCrumbs__current')).toHaveText('weather_observations');

  // "Open table" leaves for the table card.
  await page.locator('.explorerStorageView__open').click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/overview\?view=browse$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
});

test('Storage treemap is secondary: hidden for one dominant database, nested and zoomable otherwise', async ({ page }) => {
  // Real fixture: without system databases one database holds ~100%.
  await openSection(page, 'explorerSystemSectionButton');
  await expect(page.locator('#explorerStorageList tbody tr').first()).toBeVisible({ timeout: 15_000 });
  const before = await page.locator('#explorerStorageList tbody td.explorerStorageList__cell--share').evaluateAll((cells) => cells.map((td) => Number(td.dataset.value)));
  const significant = before.filter((share) => share >= 1).length;
  if (significant < 3) await expect(page.locator('.explorerStorageView__map')).toBeHidden();

  await page.route(/\/api\/explorer\/storage\?/, (route) => route.fulfill({ json: SYNTHETIC_STORAGE, headers: { 'Cache-Control': 'no-store' } }));
  await page.addInitScript(() => { try { localStorage.setItem('chdash.explorer.includeSystem', '1'); } catch (_) {} });
  await page.goto('/explorer/_system');
  const map = page.locator('#explorerStorageTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/, { timeout: 15_000 });
  // Limited height, below the list.
  const mapBox = await page.locator('#explorerStorageTreemap').boundingBox();
  const listBox = await page.locator('#explorerStorageList').boundingBox();
  expect(mapBox.height).toBeLessThanOrEqual(242);
  expect(mapBox.y).toBeGreaterThan(listBox.y + listBox.height - 1);
  // A header band per database, and the narrow `system` database still
  // draws its tables.
  const system = page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="database"][data-name="system"]');
  await expect(system).toHaveClass(/is-branch/);
  await expect(page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="table"][data-database="system"]').first()).toBeVisible();
  const big = page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="database"][data-name="big"]');
  await expect(big).toHaveClass(/is-branch/);
  // Every drawn table either shows a label or carries the sliver mark.
  const unlabelled = await page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="table"]').evaluateAll((nodes) => nodes
    .filter((node) => node.querySelector('.explorerTreemap__label.is-hidden') && !node.classList.contains('is-sliver')).length);
  expect(unlabelled).toBe(0);

  // Click-to-zoom on a database header band.
  const bigBox = await big.boundingBox();
  await page.mouse.click(bigBox.x + 30, bigBox.y + 8);
  await expect(page).toHaveURL(/\/explorer\/_system\?database=big$/);
  await expect(page.locator('.explorerStorageCrumbs__current')).toHaveText('big');
  await expect(page.locator('#explorerStorageList tbody tr')).toHaveCount(2);
  await page.locator('.explorerStorageCrumbs__link', { hasText: 'local' }).click();
  await expect(page).toHaveURL(/\/explorer\/_system$/);
  // Click-to-zoom on a table goes to its partitions level.
  await page.locator('#explorerStorageTreemap .explorerTreemap__node[data-kind="table"][data-table="text_log"]').click();
  await expect(page).toHaveURL(/\/explorer\/_system\?database=system&table=text_log$/);
});

test('Operations section reports replica health and Keeper, and lists problems first', async ({ page }) => {
  await openSection(page, 'explorerOpsSectionButton');
  await expect(page).toHaveURL(/\/explorer\/_operations$/);
  await expect(page.locator('#explorerOpsPane')).toBeVisible();
  const replicas = page.locator('#explorerOpsReplicas');
  await expect(replicas).toContainText('replicated_events', { timeout: 15_000 });
  const row = replicas.locator('tbody tr').filter({ hasText: 'replicated_events' }).first();
  await expect(row).toContainText('Healthy');
  await expect(row).toContainText('2 / 2');
  const keeper = page.locator('.explorerOpsSection[data-section="keeper"]');
  await expect(keeper).toContainText('Connected');
  await expect(keeper.locator('.explorerOpsTile').first()).toContainText(/Latency\s*\d+(?:\.\d+)? ms/);

  // Synthetic problems: failing mutation, lagging read-only replica,
  // postponed queue and a Distributed queue with errors.
  const activity = {
    version: 1, host_id: 'local', generated_at_ms: Date.now(), stale: false, row_limit: 200, unavailable_sections: [], truncated_sections: ['merges'],
    merges: [{ database: 'chdash_ui', table: 'weather_observations', elapsed_seconds: 12.5, progress: 0.42, num_parts: 3, result_part_name: '202609_1_9_2', partition_id: '202609', is_mutation: false, merge_type: 'Regular', total_bytes_compressed: 1048576, bytes_read_uncompressed: 0, rows_read: 0, memory_usage: 2097152 }],
    mutations: [{ database: 'chdash_ui', table: 'wide_types', mutation_id: 'mutation_7.txt', command: 'UPDATE v = 1 WHERE 1', create_time: '2026-09-30 10:00:00', parts_to_do: 2, is_done: false, is_killed: false, latest_failed_part: 'all_1_1_0', latest_fail_time: '2026-09-30 10:00:05', latest_fail_reason: 'Code: 395. DB::Exception: Value passed to throwIf function is non-zero', latest_fail_error_code_name: 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO' }],
    replication_queue: [{ database: 'chdash_repl', table: 'replicated_events', entries: 4, executing: 1, postponed: 2, max_tries: 9, oldest_create_time: '2026-09-30 09:00:00', types: ['GET_PART', 'MERGE_PARTS'], postpone_reason: 'Not executing fetch because the part is being merged', last_exception: '' }],
    replicas: [{ database: 'chdash_repl', table: 'replicated_events', replica_name: 'r1', is_leader: true, is_readonly: true, is_session_expired: false, queue_size: 4, inserts_in_queue: 1, merges_in_queue: 3, absolute_delay_seconds: 3700, queue_oldest_time: '2026-09-30 09:00:00', last_queue_update: '2026-09-30 10:00:00', last_queue_update_exception: '', total_replicas: 2, active_replicas: 1 }],
    distribution_queue: [{ database: 'chdash_repl', table: 'replicated_events_all', data_path: '/var/lib/clickhouse/store/abc/shard2_replica1/', is_blocked: false, error_count: 3, data_files: 12, data_compressed_bytes: 4096, broken_data_files: 0, broken_data_compressed_bytes: 0, last_exception: 'Connection refused' }],
  };
  await page.route(/\/api\/explorer\/ops\/activity\?/, (route) => route.fulfill({ json: activity, headers: { 'Cache-Control': 'no-store' } }));
  await page.locator('#explorerOpsRefreshButton').click();
  await expect(page.locator('#explorerOpsMutations')).toContainText('FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
  await expect(page.locator('#explorerOpsMutations')).toContainText('Part all_1_1_0: Code: 395.');
  await expect(page.locator('#explorerOpsReplicas tbody tr').first()).toContainText('Read-only');
  await expect(page.locator('#explorerOpsReplicas tbody tr').first()).toContainText('1 / 2');
  await expect(page.locator('#explorerOpsReplicas tbody tr').first()).toContainText('1 h 1 min');
  await expect(page.locator('#explorerOpsReplicationQueue')).toContainText('GET_PART, MERGE_PARTS');
  await expect(page.locator('#explorerOpsDistribution')).toContainText('Retrying');
  await expect(page.locator('#explorerOpsMerges')).toContainText('42%');
  await expect(page.locator('.explorerOpsSection[data-section="merges"]')).toContainText('first 200 shown');
  // Sections with problems come before the quiet ones (merges).
  const order = await page.locator('.explorerOpsView__body > .explorerOpsSection').evaluateAll((els) => els.map((el) => el.dataset.section));
  expect(order.indexOf('replicas')).toBeLessThan(order.indexOf('merges'));
  expect(order.indexOf('mutations')).toBeLessThan(order.indexOf('merges'));
  await expect(page.locator('#explorerOpsQuiet')).toHaveCount(0);

  // Auto-refresh polls while the section is visible; the choice is kept.
  await page.locator('#explorerOpsAutoRefresh').check();
  await page.waitForRequest(/\/api\/explorer\/ops\/activity\?/, { timeout: 9_000 });
  await page.reload();
  await expect(page.locator('#explorerOpsAutoRefresh')).toBeChecked({ timeout: 15_000 });
  await page.locator('#explorerOpsAutoRefresh').uncheck();

  // Object names open the table card.
  await page.locator('#explorerOpsMutations .explorerOpsTable__link', { hasText: 'wide_types' }).click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/overview\?view=browse$/);
});

test('Functions start from an overview, with merged counted categories and one line per function', async ({ page }) => {
  await page.goto('/explorer/functions');
  await expect(page.locator('#explorerFunctionCategories button').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerFunctionEmpty .explorerFunctionOverview__title')).toHaveText(/^[\d,]+ functions in \d+ categories$/);
  const groups = await page.locator('#explorerFunctionList .explorerFunctionGroup').evaluateAll((els) => els.map((el) => el.dataset.category));
  expect(groups).toContain('Aggregate');
  for (const duplicate of ['Aggregate Functions', 'Aggregate Function', 'Function']) expect(groups).not.toContain(duplicate);
  expect(new Set(groups.map((name) => name.toLowerCase())).size).toBe(groups.length);
  const listCount = Number((await page.locator('.explorerFunctionGroup[data-category="Aggregate"] .explorerFunctionGroup__count').textContent()).replace(/,/g, ''));
  const overviewCount = Number((await page.locator('#explorerFunctionCategories [data-category="Aggregate"] .explorerFunctionOverview__categoryCount').textContent()).replace(/,/g, ''));
  expect(listCount).toBeGreaterThan(50);
  expect(overviewCount).toBe(listCount);

  // A category of the overview expands its group in the list.
  await page.locator('#explorerFunctionCategories [data-category="Arrays"]').click();
  const arrays = page.locator('.explorerFunctionGroup[data-category="Arrays"]');
  await expect(arrays.locator('.explorerFunctionObject').first()).toBeVisible();
  // One line per function: no repeated "System · Function" meta.
  await expect(arrays.locator('.explorerTreeObject__meta')).toHaveCount(0);
  expect((await arrays.locator('.explorerFunctionObject').first().boundingBox()).height).toBeLessThan(32);

  await page.locator('#explorerFunctionPopular button', { hasText: /^arrayMap$/ }).click();
  await expect(page).toHaveURL(/\/explorer\/functions\/arrayMap$/);
  await expect(page.locator('#explorerFunctionDetailName')).toHaveText('arrayMap');
  await expect(page.locator('#explorerFunctionDetailMeta')).toHaveText(/^Arrays/);
  await expect(page.locator('#explorerFunctionDetailMeta')).not.toContainText('System');
  await expect(page.locator('#explorerFunctionList .explorerFunctionObject.is-selected')).toHaveText('arrayMap');
  await expect(page.locator('#explorerFunctionList .explorerFunctionObject.is-selected')).toBeInViewport();
});

for (const theme of ['dark', 'light']) {
  for (const viewport of VIEWPORTS) {
    test(`storage and operations fit ${viewport.name} in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => { try { localStorage.setItem('chdash.theme', value); } catch (_) {} }, theme);
      for (const path of ['/explorer/_system', '/explorer/_system?database=chdash_ui', '/explorer/_operations']) {
        await page.goto(path);
        const pane = path.includes('_operations') ? page.locator('#explorerOpsPane') : page.locator('#explorerSystemPane');
        const ready = path.includes('_operations') ? page.locator('.explorerOpsSection').first() : page.locator('#explorerStorageList tbody tr').first();
        await expect(ready).toBeVisible({ timeout: 15_000 });
        // No horizontal page overflow; wide tables scroll inside the pane.
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        if (!path.includes('_operations')) {
          const listWidth = await page.locator('#explorerStorageList').evaluate((el) => el.getBoundingClientRect().width);
          const paneWidth = await pane.evaluate((el) => el.clientWidth);
          expect(listWidth).toBeLessThanOrEqual(paneWidth);
        }
        // Text stays readable against the page background.
        const colors = await pane.evaluate((el) => {
          const body = getComputedStyle(document.body).backgroundColor;
          const text = getComputedStyle(el.querySelector('.explorerStorageView, .explorerOpsView')).color;
          return { body, text };
        });
        expect(colors.text).not.toBe(colors.body);
      }
    });
  }
}
