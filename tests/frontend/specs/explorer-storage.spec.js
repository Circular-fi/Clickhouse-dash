import { test, expect } from '@playwright/test';
import { openApp, openExplorer, openExplorerDatabase } from '../helpers/app.js';

// The Explorer card: the Storage tabs of the database and table cards (the
// former Storage mode), the Columns tab's sizes and size map, the keys one
// element per line, the expressions coloured by the shared highlighter, the
// About panel that never truncates, the tree without a reserved scrollbar
// gutter; and the Functions overview. The server's activity is the System
// page's (system.spec.js).

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

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

// Rewrites a table detail (the real one, fetched first) through `edit`.
async function routeTableDetail(page, table, edit) {
  await page.route(new RegExp(`/api/explorer/table\\?.*table=${table}(?:&|$)`), async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    edit(json);
    await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
  });
}

async function openCard(page, path, name) {
  await page.goto(path);
  await expect(page.locator('#explorerDetailName')).toHaveText(name, { timeout: 20_000 });
}

const selectedTab = (page) => page.locator('#explorerDetailTabs [aria-selected="true"]');

test('the database page shows its objects, then its storage: a share strip when one table dominates, and the disks', async ({ page }) => {
  await openApp(page);
  const catalogResponse = page.waitForResponse((response) => /api\/explorer\/catalog\?.*database=chdash_ui/.test(response.url()));
  await openExplorerDatabase(page);
  const catalog = await (await catalogResponse).json();
  await page.locator('.explorerTreeDatabase').filter({ hasText: 'chdash_ui' }).first().click();
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
  // One page, no tabs (user, 2026-10-04): the objects, then the storage.
  await expect(page.locator('#explorerDetailTabs')).toBeHidden();
  await expect(page.locator('#explorerDatabaseObjects')).toBeVisible();
  await expect(page.locator('#explorerDatabaseStorage')).toBeAttached();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
  // Which drawing shows depends on the data: a treemap for three tables of
  // >= 1% of the database's on-disk bytes, otherwise one share strip.
  const disk = (catalog.tables || []).filter((table) => !['Memory', 'Buffer', 'Dictionary'].includes(table.engine) && Number(table.bytes) > 0);
  const total = disk.reduce((sum, table) => sum + Number(table.bytes), 0);
  const significant = disk.filter((table) => Number(table.bytes) >= Math.floor((total + 99) / 100)).length;
  const dominant = Math.max(...disk.map((table) => Number(table.bytes))) / total > 0.85;
  if (significant >= 3 && !dominant) {
    await expect(page.locator('#explorerDatabaseTreemap')).toBeVisible();
  } else {
    const strip = page.locator('#explorerDatabaseStorageStrip');
    await expect(strip).toBeVisible();
    await expect(page.locator('#explorerDatabaseTreemap')).toHaveCount(0);
    const weather = strip.locator('.explorerStorageStrip__segment[data-table="weather_observations"]');
    await expect(weather).toContainText('weather_observations');
    // The small tables are grouped, resident-memory engines take no area.
    await expect(strip.locator('[data-table="memory_weather"]')).toHaveCount(0);
  }
  // The header carries the size, the footnote the RAM: the section head
  // counts the tables with data only.
  await expect(page.locator('.explorerDatabaseStorage__tables .explorerSectionHead')).toHaveText(/^Tables by size\s*\d+ tables? with data$/);
  await expect(page.locator('.explorerDatabaseStorage')).toContainText(/RAM of Memory \/ Buffer \/ Dictionary not counted/);
  // The disks the database's parts are on, with their capacity.
  const disks = page.locator('#explorerDatabaseDisks');
  await expect(disks.locator('thead th')).toHaveText(['#', 'Disk', 'Path', 'Type', 'Size', 'Free', 'Capacity']);
  await expect(disks.locator('tbody tr').filter({ hasText: 'fixture_hot' })).toBeVisible();
  await expect(disks.locator('tbody tr').filter({ hasText: 'fixture_hot' }).locator('td').nth(4)).toHaveText(/^\d+(?:\.\d)? [KMGT]?B$/);

  // A reload shows the same page.
  await page.reload();
  await expect(page.locator('#explorerDatabaseDisks tbody tr').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerDatabaseObjects')).toBeVisible();
});

test('the database storage draws a treemap for three tables of 1% or more; a rectangle opens the table on its Storage tab', async ({ page }) => {
  await routeDatabaseSizes(page, 'chdash_ui', { weather_observations: 6_000_000, wide_types: 4_000_000, weather_daily_summary: 3_000_000 });
  await openApp(page);
  // The former ?tab=storage: the database page, scrolled to its storage.
  await page.goto('/explorer/chdash_ui?tab=storage');
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
  const map = page.locator('#explorerDatabaseTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/);
  await expect(page.locator('#explorerDatabaseStorageStrip')).toHaveCount(0);
  // One height for every size band (--sizemap-h, 180 px).
  const box = await page.locator('#explorerDatabaseTreemap').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(158);
  expect(box.height).toBeLessThanOrEqual(182);
  const weather = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"][data-table="weather_observations"]');
  await expect(weather).toContainText('weather_observations');
  for (const table of ['wide_types', 'weather_daily_summary']) {
    await expect(page.locator(`#explorerDatabaseTreemap .explorerTreemap__node[data-table="${table}"]`)).toBeVisible();
  }
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-table="memory_weather"]')).toHaveCount(0);
  await expect(page.locator('#explorerDatabaseTreemap .explorerTreemap__node.is-other')).toContainText(/Others/);
  // Others is an item of the legend too; tables are one accent tint, no colour from a name.
  await expect(page.locator('#explorerDatabaseStorage .explorerTreemapLegend__item--other')).toContainText(/Others\s*\d+ tables? · [\d.]+ [KMGT]?B/);
  const fills = await page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"]').evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).backgroundColor))]);
  expect(fills).toHaveLength(1);
  await expect(page.locator('#explorerDetailContent .explorerTreemapFootnote')).toContainText(/On-disk bytes.*Others/);
  // Treemap labels use the text face, not monospace.
  const family = await weather.locator('.explorerTreemap__name').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).not.toMatch(/mono/i);

  await weather.hover();
  const tooltip = page.locator('#explorerDatabaseTreemap [data-treemap-tooltip]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('chdash_ui.weather_observations');
  await expect(tooltip).toContainText(/rows · MergeTree · \d+(?:\.\d+)?% of chdash_ui/);
  await page.mouse.move(2, 2);
  await expect(tooltip).toBeHidden();

  await weather.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?tab=storage$/);
  await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
  await expect(selectedTab(page)).toHaveText('Storage');
  await expect(page.locator('#explorerDatabaseTreemap')).toHaveCount(0);
});

test('the table Storage tab merges Parts & disks with the former Storage mode, without duplicates', async ({ page }) => {
  // Four partitions of >= 1% so the partition map shows on every stack.
  await routeTableDetail(page, 'weather_observations', (json) => {
    const total = Math.max(4_000_000, Number(json.summary?.logical_bytes || 0));
    json.partitions = [
      { partition: '202606', rows: 1000, bytes: Math.round(total * 0.4), parts: 2 },
      { partition: '202607', rows: 800, bytes: Math.round(total * 0.3), parts: 1 },
      { partition: '202608', rows: 600, bytes: Math.round(total * 0.2), parts: 1 },
      { partition: '202609', rows: 400, bytes: Math.round(total * 0.1), parts: 1 },
    ];
  });
  await openApp(page);
  await openCard(page, '/explorer/chdash_ui/weather_observations?tab=storage', 'chdash_ui.weather_observations');
  await expect(selectedTab(page)).toHaveText('Storage');
  await expect(page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Parts & disks' })).toHaveCount(0);
  const content = page.locator('#explorerDetailContent .explorerCard__main');
  // How the bytes split, where they are, how they spread, then the parts.
  await expect(content.locator('.explorerStorageCompositionCard')).toBeVisible();
  const order = await content.locator(':scope > .explorerSection').evaluateAll((els) => els.map((el) => el.dataset.section));
  expect(order.slice(0, 3)).toEqual(['disks', 'partitions', 'parts']);
  // One partitions list (no second "Storage" list of the same rows): the
  // former Storage mode's share column, largest first, and its map.
  await expect(content.locator('.explorerTable--partitions')).toHaveCount(1);
  await expect(page.locator('#explorerStorageList')).toHaveCount(0);
  const partitions = content.locator('.explorerTable--partitions');
  await expect(partitions.locator('thead th')).toHaveText(['#', 'Partition', 'Size', 'Share', 'Rows', 'Parts']);
  await expect(partitions.locator('tbody tr').first()).toHaveAttribute('data-partition', '202606');
  await expect(partitions.locator('tbody tr').first().locator('.shareBar')).toContainText('40%');
  const map = page.locator('#explorerPartitionTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/);
  await expect(page.locator('#explorerPartitionTreemap .explorerTreemap__node[data-kind="partition"]')).toHaveCount(4);
  const mapBox = await page.locator('#explorerPartitionTreemap').boundingBox();
  expect(mapBox.height).toBeLessThanOrEqual(242);
  expect(mapBox.y).toBeLessThan((await partitions.boundingBox()).y);
  await page.locator('#explorerPartitionTreemap .explorerTreemap__node[data-name="202606"]').hover();
  await expect(page.locator('#explorerPartitionTreemap [data-treemap-tooltip]')).toContainText('Partition 202606');
  for (const section of ['disks', 'parts', 'indexes', 'projections']) {
    await expect(content.locator(`.explorerSection[data-section="${section}"]`)).toHaveCount(1);
  }
});

test('Columns: the uncompressed size next to the compressed one, and a column size treemap', async ({ page }) => {
  await openApp(page);
  await openCard(page, '/explorer/chdash_ui/weather_observations', 'chdash_ui.weather_observations');
  const columns = page.locator('#explorerDetailContent .explorerColumnsTable');
  await expect(columns).toBeVisible({ timeout: 15_000 });
  const headers = (await columns.locator('thead th').allTextContents()).map((text) => text.trim());
  expect(headers.indexOf('Uncompressed')).toBe(headers.indexOf('Compressed') + 1);
  // Real values from system.columns data_uncompressed_bytes.
  const row = columns.locator('tbody tr').filter({ hasText: 'random_token' }).first();
  const cell = row.locator('td.explorerColumns__uncompressed');
  await expect(cell).toHaveText(/^\d+(?:\.\d)? [KMG]?B$/);
  await expect(cell).toHaveAttribute('title', /^\d+(?:\.\d)?× compression/);
  // Fits beside the About panel from 1440 px: nothing scrolls sideways.
  if ((page.viewportSize()?.width || 0) >= 1440) {
    const scroll = await columns.evaluate((el) => {
      const wrap = el.closest('.tableWrap') || el;
      return wrap.scrollWidth - wrap.clientWidth;
    });
    expect(scroll).toBeLessThanOrEqual(1);
  }

  // The size map: top-level columns by compressed bytes, by type family.
  const map = page.locator('#explorerColumnTreemap .explorerTreemap');
  await expect(map).not.toHaveClass(/is-layout-pending/);
  const nodes = page.locator('#explorerColumnTreemap .explorerTreemap__node[data-kind="column"]');
  expect(await nodes.count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#explorerColumnTreemap .explorerTreemap__node[data-name="random_token"]')).toBeVisible();
  await expect(page.locator('.explorerColumnSizes .explorerTreemapLegend')).toContainText('Strings');
  await expect(page.locator('#explorerColumnTreemap .explorerTreemap__node.is-other')).not.toContainText(/tables/);
  await page.locator('#explorerColumnTreemap .explorerTreemap__node[data-name="random_token"]').hover();
  await expect(page.locator('#explorerColumnTreemap [data-treemap-tooltip]')).toContainText('Column random_token');
  const compressedSize = await page.locator('#explorerColumnTreemap .explorerTreemap__node[data-name="random_token"]').getAttribute('data-size');
  // Compressed | Uncompressed: the same map of the other measure.
  const measure = page.locator('.explorerColumnSizes__measure');
  await expect(measure.locator('[data-measure="compressed"]')).toHaveAttribute('aria-pressed', 'true');
  await measure.locator('[data-measure="uncompressed"]').click();
  await expect(measure.locator('[data-measure="uncompressed"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.explorerColumnSizes .explorerTreemapFootnote')).toContainText('Uncompressed bytes');
  await expect.poll(() => page.locator('#explorerColumnTreemap .explorerTreemap__node[data-name="random_token"]').getAttribute('data-size')).not.toBe(compressedSize);
});

test('Keys: every key one element per line with its position; nested commas do not split; function names coloured', async ({ page }) => {
  await routeTableDetail(page, 'wide_types', (json) => {
    json.summary.sorting_key = "created_on, cityHash64(id, toString(id)), if(id > 0, 'a, b', 'c')";
    json.summary.primary_key = 'created_on, cityHash64(id, toString(id))';
    json.summary.partition_key = 'toYYYYMM(created_on)';
    json.summary.sampling_key = 'cityHash64(id, toString(id))';
  });
  await openApp(page);
  await openCard(page, '/explorer/chdash_ui/wide_types', 'chdash_ui.wide_types');
  const keys = page.locator('#explorerDetailContent .explorerAboutTile[data-tile="keys"]');
  await expect(keys).toBeVisible({ timeout: 15_000 });
  const lines = async (key) => keys.locator(`[data-key="${key}"] .explorerKeys__item`).evaluateAll((items) => items.map((li) => [li.dataset.position, li.querySelector('.explorerKeys__expr').textContent]));
  expect(await lines('order_by')).toEqual([['0', 'created_on'], ['1', 'cityHash64(id, toString(id))'], ['2', "if(id > 0, 'a, b', 'c')"]]);
  expect(await lines('primary_key')).toEqual([['0', 'created_on'], ['1', 'cityHash64(id, toString(id))']]);
  expect(await lines('partition_by')).toEqual([['0', 'toYYYYMM(created_on)']]);
  expect(await lines('sample_by')).toEqual([['0', 'cityHash64(id, toString(id))']]);
  await expect(keys.locator('.explorerKeys__name')).toHaveText(['ORDER BY', 'PRIMARY KEY', 'PARTITION BY', 'SAMPLE BY']);
  // One element per line: each item sits under the previous one.
  const tops = await keys.locator('[data-key="order_by"] .explorerKeys__item').evaluateAll((items) => items.map((li) => li.getBoundingClientRect().top));
  for (let i = 1; i < tops.length; i += 1) expect(tops[i]).toBeGreaterThan(tops[i - 1]);
  // The shared highlighter's function class, the Query editor's colour.
  const fn = keys.locator('[data-key="partition_by"] .tok-fn');
  await expect(fn).toHaveText('toYYYYMM', { timeout: 15_000 });
  const colours = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'tok-fn';
    document.body.appendChild(probe);
    const shared = getComputedStyle(probe).color;
    probe.remove();
    return { shared, key: getComputedStyle(document.querySelector('[data-tile="keys"] .tok-fn')).color };
  });
  expect(colours.key).toBe(colours.shared);
  // The Columns tab's key badges carry the column's position in the key.
  const created = page.locator('#explorerDetailContent .explorerColumnsTable tbody tr').filter({ hasText: 'created_on' }).first();
  await expect(created.locator('.explorerBadge--order-by')).toHaveText('ORDER BY · 0');
  await expect(created.locator('.explorerBadge--order-by')).toHaveAttribute('title', 'Position 0 in the sorting key (ORDER BY)');
});

test('expressions of the card use the shared highlighter: defaults, TTL rules, index expressions', async ({ page }) => {
  await openApp(page);
  await openCard(page, '/explorer/chdash_ui/weather_observations', 'chdash_ui.weather_observations');
  const columns = page.locator('#explorerDetailContent .explorerColumnsTable');
  await expect(columns).toBeVisible({ timeout: 15_000 });
  // MATERIALIZED toDate(observed_at): the function is a .tok-fn token.
  const materialized = columns.locator('tbody tr').filter({ hasText: 'observation_date' }).first().locator('.explorerColumns__expr');
  await expect(materialized.locator('.tok-fn')).toHaveText('toDate', { timeout: 15_000 });
  // TTL rules: numbers and keywords in the highlighter's classes.
  const ttl = page.locator('#explorerDetailContent .explorerAboutTile[data-tile="ttl"]');
  await expect(ttl.locator('.explorerExpr .tok-num').first()).toBeVisible();
  await expect(ttl.locator('.explorerExpr .tok-str').first()).toHaveText("'warm'");
  // No colour of its own: every token class is one of the highlighter's.
  const classes = await page.locator('#explorerDetailContent .explorerExpr [class]').evaluateAll((els) => [...new Set(els.map((el) => el.className))]);
  for (const name of classes) expect(name).toMatch(/^tok-(?:kw|fn|str|num|null|com|err)$/);
});

// Elements of the About panel cut with an ellipsis or wider than their box.
async function aboutTruncations(page) {
  return page.locator('#explorerDetailContent .explorerAbout').evaluate((about) => [...about.querySelectorAll('*')]
    .filter((el) => el.getClientRects().length && !el.closest('svg'))
    .filter((el) => {
      const style = getComputedStyle(el);
      const ellipsis = style.textOverflow === 'ellipsis' && style.overflow !== 'visible' && style.whiteSpace === 'nowrap';
      return ellipsis || el.scrollWidth > el.clientWidth + 1;
    })
    .map((el) => `${el.className || el.tagName}: ${(el.textContent || '').slice(0, 60)}`));
}

for (const theme of ['dark', 'light']) {
  for (const viewport of VIEWPORTS) {
    test(`About shows every value whole on ${viewport.name} in ${theme} theme: no ellipsis, nothing overflows`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => { try { localStorage.setItem('chdash.theme', value); } catch (_) {} }, theme);
      // Long values on every stack: engine arguments (the Keeper path of a
      // replicated table), engine settings, keys, TTL rules, a storage
      // policy, a cluster, a Distributed local table.
      for (const [path, name] of [
        ['/explorer/chdash_ui/weather_observations', 'chdash_ui.weather_observations'],
        ['/explorer/chdash_repl/replicated_events', 'chdash_repl.replicated_events'],
        ['/explorer/chdash_repl/replicated_events_all', 'chdash_repl.replicated_events_all'],
        ['/explorer/otel/otel_traces', 'otel.otel_traces'],
      ]) {
        await openCard(page, path, name);
        const about = page.locator('#explorerDetailContent .explorerAbout');
        await expect(about).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('#explorerDetailContent .explorerEmptyNote', { hasText: 'Loading detailed metadata' })).toHaveCount(0, { timeout: 20_000 });
        // A narrow pane folds the tiles behind "Show all": open them.
        const toggle = about.locator('.explorerAbout__toggle');
        if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
        expect(await aboutTruncations(page), path).toEqual([]);
      }
      // The Keeper path and the engine arguments are shown, not hidden in a title.
      await page.goto('/explorer/chdash_repl/replicated_events');
      await expect(page.locator('.explorerAboutTile[data-tile="keeper_path"]')).toContainText('/clickhouse/tables/', { timeout: 15_000 });
      await expect(page.locator('.explorerAboutTile[data-tile="engine"] .explorerAboutTile__expr')).toContainText("ReplicatedMergeTree('/clickhouse/tables/");
    });
  }
}

test('the object tree reserves no scrollbar gutter, with and without a scrollbar', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.removeItem('chdash.explorer.includeSystem'); } catch (_) {} });
  await page.goto('/explorer');
  const list = page.locator('#explorerTableList');
  await expect(list.locator('.explorerTreeDatabaseRow').first()).toBeVisible({ timeout: 15_000 });
  for (const selector of ['#explorerListPane', '#explorerTableList', '#explorerFunctionListPane']) {
    expect(await page.locator(selector).evaluate((el) => getComputedStyle(el).scrollbarGutter), selector).toBe('auto');
  }
  const geometry = () => list.evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight + 1,
    gutter: el.offsetWidth - el.clientWidth - parseFloat(getComputedStyle(el).borderLeftWidth) - parseFloat(getComputedStyle(el).borderRightWidth),
    overflowX: el.scrollWidth - el.clientWidth,
    rowRight: Math.max(...[...el.querySelectorAll('.explorerTreeDatabaseRow')].map((row) => row.getBoundingClientRect().right)),
    listRight: el.getBoundingClientRect().left + el.clientWidth,
  }));
  // Without a scrollbar: no empty strip on the right of the rows.
  const short = await geometry();
  if (!short.scrolls) expect(short.gutter).toBe(0);
  expect(short.overflowX).toBeLessThanOrEqual(1);
  expect(short.listRight - short.rowRight).toBeLessThan(12);
  // With one (the system database open): the rows still fit, no sideways scroll.
  await page.locator('.explorerFilterChip[data-filter="system"]').click();
  const toggle = page.locator('#explorerTableList .explorerTreeDatabaseToggle[aria-label="Expand system"]');
  await toggle.click();
  await expect(list.locator('.explorerTreeObject[data-database="system"]').first()).toBeVisible({ timeout: 15_000 });
  const long = await geometry();
  expect(long.scrolls).toBe(true);
  expect(long.overflowX).toBeLessThanOrEqual(1);
  expect(long.listRight - long.rowRight).toBeLessThan(12);
  await page.locator('.explorerFilterChip[data-filter="system"]').click();
});

test('Functions start from an overview (popular names in mono, the categories once: in the list), one line per function', async ({ page }) => {
  await page.goto('/explorer/_functions');
  await expect(page.locator('#explorerFunctionPopular button').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerFunctionEmpty .explorerFunctionOverview__title')).toHaveText(/^[\d,]+ functions in \d+ categories$/);
  // The categories are the list's groups, not a second grid in the overview.
  await expect(page.locator('#explorerFunctionCategories, .explorerFunctionOverview__category')).toHaveCount(0);
  const groups = await page.locator('#explorerFunctionList .explorerFunctionGroup').evaluateAll((els) => els.map((el) => el.dataset.category));
  expect(groups).toContain('Aggregate');
  for (const duplicate of ['Aggregate Functions', 'Aggregate Function', 'Function']) expect(groups).not.toContain(duplicate);
  expect(new Set(groups.map((name) => name.toLowerCase())).size).toBe(groups.length);
  const listCount = Number((await page.locator('.explorerFunctionGroup[data-category="Aggregate"] .explorerFunctionGroup__count').textContent()).replace(/,/g, ''));
  expect(listCount).toBeGreaterThan(50);
  // Function names are identifiers: mono in the chips, the list and the title.
  const mono = (locator) => locator.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await mono(page.locator('#explorerFunctionPopular button').first())).toMatch(/^"?IBM Plex Mono/);

  // A category of the list expands its group.
  await page.locator('.explorerFunctionGroup[data-category="Arrays"] .explorerTreeDatabase').first().click();
  const arrays = page.locator('.explorerFunctionGroup[data-category="Arrays"]');
  expect(await mono(arrays.locator('.explorerFunctionObject__name').first())).toMatch(/^"?IBM Plex Mono/);
  await expect(arrays.locator('.explorerFunctionObject').first()).toBeVisible();
  // One line per function: no repeated "System · Function" meta.
  await expect(arrays.locator('.explorerTreeObject__meta')).toHaveCount(0);
  expect((await arrays.locator('.explorerFunctionObject').first().boundingBox()).height).toBeLessThan(32);

  await page.locator('#explorerFunctionPopular button', { hasText: /^arrayMap$/ }).click();
  await expect(page).toHaveURL(/\/explorer\/_functions\/arrayMap$/);
  await expect(page.locator('#explorerFunctionDetailName')).toHaveText('arrayMap');
  expect(await mono(page.locator('#explorerFunctionDetailName'))).toMatch(/^"?IBM Plex Mono/);
  // Inline markdown reads as code, also inside a link label
  // ("[`Array(T)`](/sql-reference/...)"): no backtick is left in the text.
  const doc = page.locator('#explorerFunctionDescription');
  await expect(doc.locator('.functionDoc__inlineCode').filter({ hasText: /^Array\(T\)$/ }).first()).toBeVisible();
  expect(await doc.locator('.functionDoc__markdown').evaluateAll((els) => els.map((el) => el.textContent).join(' '))).not.toContain('`');
  await expect(page.locator('#explorerFunctionDetailMeta')).toHaveText(/^Arrays/);
  await expect(page.locator('#explorerFunctionDetailMeta')).not.toContainText('System');
  await expect(page.locator('#explorerFunctionList .explorerFunctionObject.is-selected')).toHaveText('arrayMap');
  await expect(page.locator('#explorerFunctionList .explorerFunctionObject.is-selected')).toBeInViewport();
  // The list scrolled under its head: the head marks it (a soft edge).
  const head = page.locator('#explorerFunctionToolbar');
  const list = page.locator('#explorerFunctionList');
  const scrolled = await list.evaluate((el) => el.scrollTop);
  await list.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(head).not.toHaveClass(/is-scrolled/);
  await list.evaluate((el) => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')); });
  await expect(head).toHaveClass(/is-scrolled/);
  expect(await head.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  await list.evaluate((el, top) => { el.scrollTop = top; }, scrolled);

  // The list pane mirrors the object tree: search + refresh, then kind chips.
  const toolbar = page.locator('#explorerFunctionToolbar');
  await expect(toolbar.locator('#explorerFunctionSearchInput')).toBeVisible();
  await expect(toolbar.locator('#explorerFunctionRefreshButton')).toBeVisible();
  await expect(page.locator('#explorerFunctionSettingsButton')).toHaveCount(0);
  const chips = page.locator('#explorerFunctionFilters .explorerFilterChip');
  await expect(chips).toHaveText(['Functions', 'Aggregate', 'Table', 'UDF']);
  const width = (selector) => page.locator(selector).evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(await width('#explorerFunctionListPane')).toBe(await page.locator('#explorerCatalogTab').click().then(() => width('#explorerListPane')));
  await page.locator('#explorerFunctionsTab').click();
  // One kind at a time; the pressed chip again lists every function.
  const aggregate = chips.filter({ hasText: 'Aggregate' });
  await aggregate.click();
  await expect(aggregate).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup[data-category="Arrays"]')).toHaveCount(0);
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup[data-category="Aggregate"]')).toBeVisible();
  await chips.filter({ hasText: 'Table' }).click();
  await expect(aggregate).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup[data-category="Aggregate"]')).toHaveCount(0);
  await chips.filter({ hasText: 'Table' }).click();
  await expect(page.locator('#explorerFunctionFilters .explorerFilterChip[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator('#explorerFunctionList .explorerFunctionGroup[data-category="Arrays"]')).toBeVisible();
});

for (const theme of ['dark', 'light']) {
  for (const viewport of VIEWPORTS) {
    test(`storage tabs and operations fit ${viewport.name} in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => { try { localStorage.setItem('chdash.theme', value); } catch (_) {} }, theme);
      const paths = ['/explorer/chdash_ui?tab=storage', '/explorer/chdash_ui/weather_observations?tab=storage', '/explorer/chdash_ui/weather_observations'];
      paths.push('/system#activity');
      for (const path of paths) {
        await page.goto(path);
        const ops = path.startsWith('/system');
        const pane = ops ? page.locator('#systemPanel-overview') : page.locator('#explorerDetailPane');
        const ready = ops ? page.locator('.systemActivitySection').first()
          : path.endsWith('?tab=storage') && !path.includes('weather') ? page.locator('#explorerDatabaseDisks tbody tr').first()
            : path.includes('?tab=storage') ? page.locator('.explorerTable--partitions tbody tr').first()
              : page.locator('#explorerColumnTreemap .explorerTreemap:not(.is-layout-pending)');
        await expect(ready).toBeVisible({ timeout: 15_000 });
        // No horizontal page overflow; wide tables scroll inside the pane.
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
        expect(overflow, path).toBeLessThanOrEqual(1);
        if (!ops) {
          const contentWidth = await page.locator('#explorerDetailContent').evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(contentWidth, path).toBeLessThanOrEqual(1);
        }
        // Text stays readable against the page background.
        const colors = await pane.evaluate((el) => ({ body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(el).color }));
        expect(colors.text).not.toBe(colors.body);
      }
    });
  }
}
