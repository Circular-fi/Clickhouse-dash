import { test, expect } from '@playwright/test';

// The catalog's database summaries (All databases), the real answer edited.
async function routeDatabaseSummaries(page, edit) {
  await page.route(/\/api\/explorer\/catalog\?(?!.*database=)/, async (route) => {
    try {
      const response = await route.fetch();
      const json = await response.json();
      edit(json.database_summaries || []);
      await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // The page or the test is gone.
    }
  });
}
import { expandExplorerDatabase } from '../helpers/app.js';

// Explorer shell (Catalog / Functions view tabs, the Catalog's Browse / Graph
// modes over one tree selection, "All databases" and its treemap, the
// database page (objects then storage, no tabs), the table card's Storage
// tab, type chips, mobile drawer), the
// one-line object tree, the shared number formats / in-cell bars and the
// database page object table. Runs on every desktop project (1920 / 1440 /
// 1280); the mobile block pins a phone viewport, and each block runs in both
// themes.

async function openDatabasePage(page, database = 'chdash_ui') {
  await page.goto(`/explorer/${database}`);
  await expect(page.locator('#explorerDetailName')).toHaveText(database, { timeout: 15_000 });
  await expect(page.locator('#explorerDatabaseObjects tbody tr').first()).toBeVisible({ timeout: 15_000 });
}

async function resetExplorerFilters(page) {
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('nav-spec-reset')) return;
      sessionStorage.setItem('nav-spec-reset', '1');
      localStorage.removeItem('chdash.explorer.typeFilters.v1');
      localStorage.removeItem('chdash.explorer.includeSystem');
      localStorage.removeItem('chdash.explorer.includeNonStoring');
    } catch (_) {}
  });
}

const selectedObject = (page) => page.locator('#explorerTableList .explorerTreeObject.is-selected');
const selectedDatabase = (page) => page.locator('#explorerTableList .explorerTreeDatabaseRow.is-selected');

for (const theme of ['dark', 'light']) {
  test.describe(`explorer shell (${theme})`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('chdash.theme', t); } catch (_) {} }, theme);
      await resetExplorerFilters(page);
    });

    test('one nav row: Catalog | Functions, a divider, then the Catalog\'s Browse | Graph tabs (second-level sections)', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerViewTabs .contentTabs__tab:visible')).toHaveText(['Catalog', 'Functions']);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      // Browse | Graph are underline tabs in the same row as Catalog |
      // Functions, after a divider, as Observability's Search / Services /
      // Service map after Traces / Logs / Metrics; the row is 48 px.
      const modes = page.locator('#explorerModeTabs .contentTabs__tab:visible');
      await expect(modes).toHaveText(['Browse', 'Graph']);
      // Storage is a tab of the table card and part of the database page, not a mode.
      await expect(page.locator('#explorerModeStorage, #explorerSystemPane, [data-mode="storage"]')).toHaveCount(0);
      await expect(page.locator('#explorerTopBar > #explorerNavTabs > #explorerModeTabs')).toBeVisible();
      await expect(page.locator('#explorerModeTabs')).toHaveAttribute('role', 'tablist');
      await expect(page.locator('#explorerModeTabs')).toHaveClass(/contentTabs--nav/);
      await expect(page.locator('#explorerModeTabs [role="tab"]')).toHaveCount(2);
      await expect(page.locator('#explorerModeTabs .segmented__option, #explorerModeBar')).toHaveCount(0);
      await expect(page.locator('#explorerNavTabs > #explorerModeSep')).toBeVisible();
      const row = await page.locator('#explorerTopBar').boundingBox();
      const tabs = await page.locator('#explorerViewTabs').boundingBox();
      const sep = await page.locator('#explorerModeSep').boundingBox();
      const sub = await page.locator('#explorerModeTabs').boundingBox();
      const functionsTab = await page.locator('#explorerFunctionsTab').boundingBox();
      const browse = await page.locator('#explorerModeBrowse').boundingBox();
      expect(row.height).toBeCloseTo(48, 0);
      // Left to right: the view tabs, the divider, Browse | Graph, right
      // after them (not pushed to the row's right edge).
      expect(sep.x).toBeGreaterThanOrEqual(tabs.x + tabs.width - 0.5);
      expect(sub.x).toBeGreaterThanOrEqual(sep.x + sep.width - 0.5);
      expect(browse.x - (functionsTab.x + functionsTab.width)).toBeLessThan(40);
      expect(row.x + row.width - (sub.x + sub.width)).toBeGreaterThan(200);
      // One look: the same underline tab, the same height and font, both rows
      // standing on the nav row's bottom border.
      const look = (sel) => page.locator(sel).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { font: `${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily}`, border: cs.borderBottomWidth, bottom: Math.round(el.getBoundingClientRect().bottom) };
      });
      expect(await look('#explorerModeBrowse')).toEqual(await look('#explorerCatalogTab'));
      expect(Math.abs((sep.y + sep.height / 2) - (row.y + row.height / 2))).toBeLessThanOrEqual(1.5);
      await expect(page.locator('#explorerModeBrowse')).toHaveClass(/is-active/);
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'false');
      // Former tabs and switches are gone.
      await expect(page.locator('#explorerGraphTab, #explorerStorageTab, #explorerSectionSelectButton, #explorerModeSelectButton, #explorerTableSettingsButton')).toHaveCount(0);

      // The tree is there in every mode.
      for (const mode of ['Graph', 'Browse']) {
        await page.locator(`#explorerMode${mode}`).click();
        await expect(page.locator(`#explorerMode${mode}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#explorerListPane')).toBeVisible();
        await expect(page.locator('#explorerTreeFilters')).toBeVisible();
      }
      await expect(page.locator('#explorerCatalogView')).toBeVisible();
      await expect(page.locator('#explorerGraphPane')).toBeHidden();

      // Keys (ns.tabs): each row is its own tablist with a roving tabindex;
      // Right / Left / Home / End move and select within it, and ?mode follows.
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('tabindex', '0');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('tabindex', '-1');
      await page.locator('#explorerModeBrowse').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerModeGraph')).toBeFocused();
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      await expect(page).toHaveURL(/\/explorer\?mode=graph&graph=lineage&depth=1$/);
      // The row wraps around within its own tablist, never into Catalog | Functions.
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerModeBrowse')).toBeFocused();
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/explorer$/);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('End');
      await expect(page.locator('#explorerModeGraph')).toBeFocused();
      await expect(page).toHaveURL(/\/explorer\?mode=graph/);
      await page.keyboard.press('Home');
      await expect(page.locator('#explorerModeBrowse')).toBeFocused();
      await expect(page).toHaveURL(/\/explorer$/);
      // Shift+Tab leaves the row for the view tabs' selected tab (one stop each).
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#explorerCatalogTab')).toBeFocused();
      // Back and Forward follow ?mode.
      await page.locator('#explorerModeGraph').click();
      await expect(page).toHaveURL(/mode=graph/);
      await page.goBack();
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerCatalogView')).toBeVisible();
      await page.goForward();
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      // An address opens its mode.
      await page.goto('/explorer?mode=graph');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerModeGraph')).toHaveClass(/is-active/);

      await page.locator('#explorerCatalogTab').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/explorer\/_functions$/);
      // Functions has no Browse | Graph: the row and its divider are hidden;
      // back on the Catalog, the mode is kept.
      await expect(page.locator('#explorerModeTabs')).toBeHidden();
      await expect(page.locator('#explorerModeSep')).toBeHidden();
      await page.locator('#explorerCatalogTab').click();
      await expect(page.locator('#explorerModeTabs')).toBeVisible();
      await expect(page.locator('#explorerModeSep')).toBeVisible();
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      // A Functions address never shows them, from the first load.
      await page.goto('/explorer/_functions');
      await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerModeTabs')).toBeHidden();
      await expect(page.locator('#explorerModeSep')).toBeHidden();
    });

    test('the Catalog root is the databases overview; a database opens from it', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerDetailName')).toHaveText('All databases', { timeout: 15_000 });
      await expect(page.locator('#explorerEmptyState')).toBeHidden();
      await expect(page.locator('#explorerDetailMeta')).toHaveText(/^\d+ databases · [\d.]+ [KMGT]?B on disk$/);
      const table = page.locator('#explorerDatabasesOverview');
      await expect(table.locator('thead th')).toContainText(['Database', 'Objects', 'Rows', 'Size', '% server']);
      const row = table.locator('tbody tr[data-database="chdash_ui"]');
      await expect(row).toBeVisible();
      await expect(row.locator('td').nth(2)).toHaveText(/^\d{1,3}(,\d{3})*$/);
      // System databases only with the System chip, as in the tree.
      await expect(table.locator('tbody tr[data-database="system"]')).toHaveCount(0);
      await row.locator('button').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
      await page.goBack();
      await expect(page.locator('#explorerDetailName')).toHaveText('All databases');
    });

    test('"All databases" heads the tree: current at the root, a click or Enter opens it', async ({ page }) => {
      await page.goto('/explorer/chdash_ui');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui', { timeout: 15_000 });
      const root = page.locator('#explorerTableList > .explorerTreeRootGroup > #explorerTreeRoot');
      // The first row of the tree, a database row with the stack icon.
      await expect(page.locator('#explorerTableList > *').first()).toHaveClass(/explorerTreeRootGroup/);
      await expect(root).toHaveText('All databases');
      await expect(root).toHaveClass(/explorerTreeDatabase/);
      await expect(root.locator('svg.icon use')).toHaveAttribute('href', /#i-stack$/);
      await expect(root).not.toHaveAttribute('aria-current', /./);
      await expect(root).not.toHaveClass(/is-selected/);
      await root.click();
      await expect(page).toHaveURL(/\/explorer$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('All databases');
      await expect(root).toHaveAttribute('aria-current', 'true');
      await expect(root).toHaveClass(/is-selected/);
      await expect(page.locator('#explorerTableList .explorerTreeDatabaseRow.is-selected')).toHaveCount(0);
      // The selected look is the database rows' one.
      const look = (el) => getComputedStyle(el).backgroundColor;
      await page.locator('.explorerTreeDatabase', { hasText: 'chdash_ui' }).first().click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      const selectedBg = await page.locator('#explorerTableList .explorerTreeDatabaseRow.is-selected').evaluate(look);
      await expect(root).not.toHaveAttribute('aria-current', /./);
      // Keyboard: Tab reaches it, Enter opens the root.
      await root.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/explorer$/);
      await expect(root).toHaveAttribute('aria-current', 'true');
      expect(await root.evaluate(look)).toBe(selectedBg);
      // In Graph too: the root is every database.
      await page.locator('#explorerModeGraph').click();
      await expect(page).toHaveURL(/\/explorer\?mode=graph/);
      await expect(root).toHaveAttribute('aria-current', 'true');
    });

    test('the databases overview opens on a treemap of the databases; a rectangle opens its database', async ({ page }) => {
      // Sizes that spread (no database holds most of the bytes): the treemap.
      await routeDatabaseSummaries(page, (summaries) => summaries.forEach((item, index) => { item.bytes = 1_000_000_000 + index * 100_000_000; }));
      await page.goto('/explorer');
      await expect(page.locator('#explorerDetailName')).toHaveText('All databases', { timeout: 15_000 });
      const map = page.locator('#explorerDatabasesTreemap');
      await expect(map.locator('.explorerTreemap')).toBeVisible({ timeout: 15_000 });
      // Above the overview table, in one section; nothing repeated: the
      // header names the page and counts the databases and their bytes, the
      // section has no title ("Databases" under "All databases") nor count.
      const section = page.locator('.explorerDatabasesOverview');
      await expect(section.locator('.explorerSectionHead, .explorerSectionTitle')).toHaveCount(0);
      await expect(section).toHaveAttribute('aria-label', 'Databases');
      await expect(section.locator('.explorerSectionCount')).toHaveCount(0);
      const mapBox = await map.boundingBox();
      const tableBox = await page.locator('#explorerDatabasesOverview').boundingBox();
      expect(mapBox.y + mapBox.height).toBeLessThanOrEqual(tableBox.y);
      // One height for every size band (--sizemap-h).
      expect(mapBox.height).toBeGreaterThanOrEqual(158);
      expect(mapBox.height).toBeLessThanOrEqual(182);
      // The System Overview's treemap: database rectangles by bytes on disk.
      const node = map.locator('.explorerTreemap__node[data-kind="database"][data-database="chdash_ui"]');
      const anyDatabase = map.locator('.explorerTreemap__node[data-kind="database"]').first();
      await expect(anyDatabase).toBeVisible();
      await expect(page.locator('.explorerDatabasesOverview .explorerTreemapFootnote')).toContainText('On-disk bytes of active parts');
      await anyDatabase.hover();
      await expect(map.locator('[data-treemap-tooltip]')).toBeVisible();
      const target = (await node.count()) ? node : anyDatabase;
      const name = await target.getAttribute('data-database');
      await target.click();
      await expect(page).toHaveURL(new RegExp(`/explorer/${name}$`));
      await expect(page.locator('#explorerDetailName')).toHaveText(name);
      // The system databases follow the System chip, as in the table.
      await page.goBack();
      await expect(map.locator('.explorerTreemap__node[data-database="system"]')).toHaveCount(0);
    });

    test('one database holding most of the bytes: still the treemap (never the strip), capped, Others on its chip and in the legend; a cell opens its database', async ({ page }) => {
      await routeDatabaseSummaries(page, (summaries) => summaries.forEach((item) => { item.bytes = item.name === 'chdash_ui' ? 50_000_000_000 : 1_000_000; }));
      await page.goto('/explorer');
      await expect(page.locator('#explorerDetailName')).toHaveText('All databases', { timeout: 15_000 });
      const map = page.locator('#explorerDatabasesTreemap');
      await expect(map.locator('.explorerTreemap__node[data-kind="database"]').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.explorerDatabasesOverview .explorerStorageStrip')).toHaveCount(0);
      await expect(page.locator('.explorerDatabasesOverview .explorerTreemapBand')).toHaveAttribute('data-mode', 'map');
      // The size band's height (--sizemap-h: 180 px, 160 px on a narrow screen), the table under it.
      const box = await map.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(158);
      expect(box.height).toBeLessThanOrEqual(182);
      expect(box.y + box.height).toBeLessThanOrEqual((await page.locator('#explorerDatabasesOverview').boundingBox()).y);
      // Others: a hatched cell whose label sits on a solid chip, and an item of the legend.
      const others = map.locator('.explorerTreemap__node[data-kind="other"]');
      await expect(others).toBeVisible();
      await expect(others.locator('.explorerTreemap__label')).toContainText('Others');
      const chip = await others.locator('.explorerTreemap__label').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(chip).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      const legend = page.locator('.explorerDatabasesOverview .explorerTreemapLegend');
      await expect(legend.locator('.explorerTreemapLegend__item--other')).toContainText(/Others\s*\d+ databases? · [\d.]+ [KMGT]?B/);
      const cell = map.locator('.explorerTreemap__node[data-kind="database"][data-database="chdash_ui"]');
      await expect(cell).toContainText('chdash_ui');
      await cell.click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
    });

    test('the card tab reads Storage (?tab=storage), the graph type Lineage | Tiers (?graph=storage)', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations?tab=storage');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      const tabs = page.locator('#explorerDetailTabs [role="tab"]');
      await expect(tabs).toContainText(['Columns', 'Preview', 'Storage']);
      await expect(tabs.filter({ hasText: 'Parts & disks' })).toHaveCount(0);
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage');
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Columns' }).click();
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page).toHaveURL(/\?tab=storage$/);
      await page.goto('/explorer/chdash_ui/weather_observations?mode=graph&graph=storage');
      await expect(page.locator('#explorerGraphTypeSelect .segmented__option')).toHaveText(['Lineage', 'Tiers']);
      await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('title', /^Tiers: /);
    });

    test('the tree selection is the scope of every mode; the Storage tabs open each other and history walks back', async ({ page }) => {
      await page.goto('/explorer');
      await expandExplorerDatabase(page, 'chdash_ui');
      await page.locator('.explorerTreeObject[data-table="weather_observations"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });

      // Graph focuses the selected table.
      await page.locator('#explorerModeGraph').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?mode=graph&graph=lineage&depth=1$/);
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      await expect(page.locator('#explorerCatalogView')).toBeHidden();
      await expect(page.locator('#explorerGraphStatus')).toContainText('chdash_ui.weather_observations', { timeout: 20_000 });
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');

      // Up (Graph only): an icon tool of the graph toolbar, first of the
      // scope controls (not a link in the nav row, where it read as the
      // removed breadcrumb): the database scope, selected in the tree.
      const up = page.locator('#explorerScopeUp');
      await expect(page.locator('#explorerGraphPane > .graphKitBar .explorerGraphScopeControls > #explorerScopeUp:first-child')).toBeVisible();
      await expect(page.locator('#explorerTopBar #explorerScopeUp')).toHaveCount(0);
      await expect(up).toHaveClass(/graphKitTool--icon/);
      await expect(up).toHaveText('');
      await expect(up.locator('svg.icon use')).toHaveAttribute('href', /#i-arrow-up$/);
      await expect(up).toHaveAttribute('aria-label', 'Up to chdash_ui');
      await expect(up).toHaveAttribute('title', 'Up to chdash_ui');
      const tool = await up.boundingBox();
      const zoomTool = await page.locator('#explorerGraphZoomInButton').boundingBox();
      expect(Math.abs(tool.height - zoomTool.height)).toBeLessThanOrEqual(1);
      await up.click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?mode=graph/);
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(selectedObject(page)).toHaveCount(0);
      await expect(up).toHaveAttribute('aria-label', 'Up to all databases');

      // Browse: the database page (no tabs: its objects, then its storage);
      // a table of its map opens on that table's Storage tab.
      await page.locator('#explorerModeBrowse').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(page.locator('#explorerScopeUp')).toBeHidden();
      await expect(page.locator('#explorerDetailTabs')).toBeHidden();
      await expect(page.locator('#explorerDatabaseObjects')).toBeVisible({ timeout: 15_000 });
      const segment = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"], #explorerDatabaseStorageStrip button.explorerStorageStrip__segment').first();
      await expect(segment).toBeVisible({ timeout: 15_000 });
      const opened = await segment.evaluate((el) => el.dataset.table);
      await segment.click();
      await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${opened}\\?tab=storage$`));
      await expect(selectedObject(page)).toHaveAttribute('data-table', opened);
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage', { timeout: 15_000 });

      // A tree pick keeps the card tab; the database page has none.
      await page.locator('.explorerTreeObject[data-table="wide_types"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?tab=storage$/);
      await page.locator('.explorerTreeDatabase', { hasText: 'chdash_ui' }).first().click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(page.locator('#explorerDetailTabs')).toBeHidden();

      // History walks back through tabs and scopes.
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?tab=storage$/);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'wide_types');
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${opened}\\?tab=storage$`));
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(page.locator('#explorerDatabaseObjects')).toBeVisible();
      await expect(page.locator('#explorerDatabaseStorage')).toBeAttached();
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${opened}\\?tab=storage$`));
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage', { timeout: 15_000 });
    });

    test('the database page: its objects, then its storage, without tabs or repeated figures', async ({ page }) => {
      await openDatabasePage(page);
      await expect(page.locator('#explorerDetailTabs')).toBeHidden();
      await expect(page.locator('#explorerDetailTabs [role="tab"]')).toHaveCount(0);
      const content = page.locator('#explorerDetailContent .explorerDatabaseCard');
      // Objects, Tables by size (treemap or share strip, legend, footnote), Disks.
      await expect(content.locator('.explorerSectionTitle')).toHaveText(['Objects', 'Tables by size', 'Disks']);
      const objects = await page.locator('#explorerDatabaseObjects').boundingBox();
      const storage = await page.locator('#explorerDatabaseStorage').boundingBox();
      expect(objects.y + objects.height).toBeLessThanOrEqual(storage.y);
      await expect(page.locator('#explorerDatabaseStorageStrip, #explorerDatabaseTreemap').first()).toBeVisible();
      await expect(page.locator('#explorerDatabaseStorage .explorerTreemapFootnote').first()).toContainText('On-disk bytes of active parts');
      await expect(page.locator('#explorerDatabaseDisks tbody tr').first()).toBeVisible();
      // The header counts the objects and the bytes; the sections do not repeat them.
      const meta = await page.locator('#explorerDetailMeta').textContent();
      expect(meta).toMatch(/^\d+ objects · [\d.]+ [KMGT]?B$/);
      await expect(page.locator('.explorerDatabaseObjects .explorerSectionCount')).toHaveCount(0);
      const tablesHead = page.locator('.explorerDatabaseStorage__tables .explorerSectionHead');
      await expect(tablesHead).toHaveText(/^Tables by size\s*\d+ tables? with data$/);
      await expect(tablesHead).not.toContainText(meta.split(' · ')[1]);
      await expect(tablesHead).not.toContainText('RAM');
      // The former tab addresses open this page, the storage scrolled into view.
      for (const tab of ['storage', 'objects']) {
        await page.goto(`/explorer/chdash_ui?tab=${tab}`);
        await expect(page).toHaveURL(/\/explorer\/chdash_ui$/, { timeout: 15_000 });
        await expect(page.locator('#explorerDatabaseObjects')).toBeAttached({ timeout: 15_000 });
        await expect(page.locator('#explorerDatabaseStorage')).toBeAttached();
      }
      await page.goto('/explorer/chdash_ui?tab=storage');
      await expect(page.locator('#explorerDatabaseStorage')).toBeInViewport({ timeout: 15_000 });
    });

    test('a first visit to a card tab link opens that tab', async ({ browser }) => {
      // A new context has no stored host: the host is chosen while the route
      // waits for the catalog, and the tab survives it.
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        // The former database Storage tab: the database page, its storage in view.
        await page.goto('/explorer/chdash_ui?tab=storage');
        await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui', { timeout: 20_000 });
        await expect(page.locator('#explorerDatabaseStorage')).toBeInViewport({ timeout: 20_000 });
        await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
        await page.goto('/explorer/chdash_ui/weather_observations?tab=preview');
        await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Preview', { timeout: 20_000 });
      } finally {
        await context.close();
      }
    });

    test('the catalog root keeps the databases overview, without a Storage tab', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#explorerDetailTabs')).toBeHidden();
      await expect(page.locator('#explorerDetailTabs [role="tab"]')).toHaveCount(0);
    });

    test('the view tabs are Catalog and Functions; the server is the System page', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerViewTabs .contentTabs__tab')).toHaveText(['Catalog', 'Functions']);
      // The Explorer loads no System module.
      await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
      expect(await page.evaluate(() => !!window.ChDash?.explorer && !window.ChDash.systemView && !window.ChDash.explorerOps && !window.ChDash.explorerMonitor)).toBe(true);
      // Its former Monitoring and Server operations addresses open the System page.
      await page.goto('/explorer/_operations');
      await expect(page).toHaveURL(/\/system#activity$/, { timeout: 15_000 });
      await page.goto('/explorer/_monitoring/disks');
      await expect(page).toHaveURL(/\/system\/disks$/, { timeout: 15_000 });
      await expect(page.locator('#explorerMonitorTab, #explorerMonitorPane, #explorerOpsTab, #explorerOpsPane')).toHaveCount(0);
    });

    test('no breadcrumb: the tree selection carries the location', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      await expect(page.locator('#explorerBreadcrumb, .explorerBreadcrumb, nav[aria-label="Location"]')).toHaveCount(0);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');
      // Browse has no Up button: the tree and the card header name the object.
      await expect(page.locator('#explorerScopeUp')).toBeHidden();
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page.locator('#explorerDetailContent .explorerTable--partitions')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.explorerStorageCrumbs, [aria-label="Storage scope"]')).toHaveCount(0);
    });

    test('former URLs are aliases of the Catalog scheme', async ({ page }) => {
      const cases = [
        ['/explorer/chdash_ui/weather_observations/columns?view=browse', /\/explorer\/chdash_ui\/weather_observations$/, 'browse'],
        ['/explorer/chdash_ui?view=browse', /\/explorer\/chdash_ui$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations/schema', /\/explorer\/chdash_ui\/weather_observations$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations/overview?view=graph&graph=lineage&depth=2', /\/explorer\/chdash_ui\/weather_observations\?mode=graph&graph=lineage&depth=2$/, 'graph'],
        ['/explorer?view=graph', /\/explorer\?mode=graph&graph=lineage&depth=1$/, 'graph'],
        // The former Storage view and mode: the table card's Storage tab, the
        // database page (its storage in view), the databases overview at the root.
        ['/explorer/_system', /\/explorer$/, 'browse'],
        ['/explorer?mode=storage', /\/explorer$/, 'browse'],
        ['/explorer/_system?database=chdash_ui', /\/explorer\/chdash_ui$/, 'browse'],
        ['/explorer/chdash_ui?mode=storage', /\/explorer\/chdash_ui$/, 'browse'],
        ['/explorer/_system?database=chdash_ui&table=weather_observations', /\/explorer\/chdash_ui\/weather_observations\?tab=storage$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations?mode=storage', /\/explorer\/chdash_ui\/weather_observations\?tab=storage$/, 'browse'],
      ];
      for (const [from, to, mode] of cases) {
        await page.goto(from);
        await expect(page, from).toHaveURL(to);
        await expect(page.locator(`#explorerMode${mode[0].toUpperCase()}${mode.slice(1)}`), from).toHaveAttribute('aria-selected', 'true');
        if (/mode=storage|_system/.test(from)) {
          if (/table=|\/weather_observations/.test(from)) {
            await expect(page.locator('#explorerDetailName'), from).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
            await expect(page.locator('#explorerDetailTabs [aria-selected="true"]'), from).toHaveText('Storage');
          } else if (/chdash_ui/.test(from)) {
            await expect(page.locator('#explorerDetailName'), from).toHaveText('chdash_ui', { timeout: 15_000 });
            await expect(page.locator('#explorerDatabaseStorage'), from).toBeInViewport({ timeout: 15_000 });
          } else {
            await expect(page.locator('#explorerDatabasesOverview'), from).toBeVisible({ timeout: 15_000 });
          }
        }
      }
      // The last alias opened the table's partitions with the table selected.
      await expect(page.locator('#explorerDetailContent .explorerTable--partitions thead th').nth(1)).toHaveText(/^Partition/, { timeout: 15_000 });
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');
      // A deep link reloads as it was.
      await page.reload();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?tab=storage$/);
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage', { timeout: 15_000 });
    });

    test('type chips filter the tree, lock the selected type and persist', async ({ page }) => {
      await page.goto('/explorer/chdash_ui');
      await expandExplorerDatabase(page, 'chdash_ui');
      const tree = page.locator('#explorerTableList');
      const views = page.locator('.explorerFilterChip[data-filter="views"]');
      await expect(page.locator('#explorerTreeFilters .explorerFilterChip')).toHaveText(['Tables', 'Views', 'MV', 'Dict', 'System']);
      await expect(views).toHaveAttribute('aria-pressed', 'true');
      await expect(tree.locator('.explorerTreeObject[data-kind="view"]').first()).toBeVisible();

      await views.click();
      await expect(views).toHaveAttribute('aria-pressed', 'false');
      await expect(tree.locator('.explorerTreeObject[data-kind="view"]')).toHaveCount(0);
      await expect(tree.locator('.explorerTreeObject[data-table="weather_observations"]')).toBeVisible();
      // The database page lists the same filtered set.
      await expect(page.locator('#explorerDatabaseObjects tbody tr[data-table="valid_weather_observations"]')).toHaveCount(0);

      await page.locator('.explorerFilterChip[data-filter="mv"]').click();
      await expect(tree.locator('.explorerTreeObject[data-kind="mv"]')).toHaveCount(0);
      await page.reload();
      await expandExplorerDatabase(page, 'chdash_ui');
      await expect(views).toHaveAttribute('aria-pressed', 'false');
      await expect(tree.locator('.explorerTreeObject[data-kind="mv"]')).toHaveCount(0);

      // Opening a view by URL turns its chip back on and locks it.
      await page.goto('/explorer/chdash_ui/valid_weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.valid_weather_observations', { timeout: 15_000 });
      await expect(views).toHaveAttribute('aria-pressed', 'true');
      // Locked: aria-disabled (still reachable by keyboard), its reason read
      // out through aria-describedby; a click changes nothing.
      expect(await views.evaluate((el) => el.disabled)).toBe(false);
      await expect(views).toHaveAttribute('aria-disabled', 'true');
      const reasonId = await views.getAttribute('aria-describedby');
      await expect(page.locator(`#${reasonId}`)).toHaveText(/Required while the selected object/);
      await views.dispatchEvent('click');
      await expect(views).toHaveAttribute('aria-pressed', 'true');
      await expect(tree.locator('.explorerTreeObject.is-selected')).toHaveAttribute('data-table', 'valid_weather_observations');

      // System databases appear only with the System chip.
      await expect(tree.locator('.explorerTreeDatabase', { hasText: /^system/ })).toHaveCount(0);
      await page.locator('.explorerFilterChip[data-filter="system"]').click();
      await expect(tree.locator('.explorerTreeDatabaseToggle[aria-label="Expand system"]')).toBeVisible();
      await page.locator('.explorerFilterChip[data-filter="system"]').click();
      await page.locator('.explorerFilterChip[data-filter="mv"]').click();
    });

    test('tree rows are one line with a plain size, a middle-truncated name with its title, and search highlights', async ({ page }) => {
      await page.goto('/explorer');
      await expandExplorerDatabase(page, 'chdash_ui');
      const row = page.locator('.explorerTreeObject[data-table="weather_observations"]');
      const box = await row.boundingBox();
      expect(box.height).toBeLessThanOrEqual(28);
      await expect(row.locator('.explorerTreeObject__meta')).toHaveCount(0);
      const badge = row.locator('.explorerTreeObject__size');
      await expect(badge).toHaveText(/^\d+\.\d MB$/);
      // A plain figure: no fill behind the largest object (the shares are in
      // the databases overview and the database page).
      expect(await badge.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
      expect(await page.locator('#explorerTableList .explorerTreeDatabase__size').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundImage))).toEqual(expect.arrayContaining(['none']));
      // Long names are cut in the middle: the end stays, the title has it all.
      const long = page.locator('.explorerTreeObject[data-table="weather_observation_quality_by_city"] .explorerTreeObject__name');
      if (await long.count()) {
        await expect(long).toHaveAttribute('title', 'weather_observation_quality_by_city');
        await expect(long.locator('.midTrunc__tail')).toBeVisible();
        const cut = await long.evaluate((el) => {
          const head = el.querySelector('.midTrunc__head');
          const tail = el.querySelector('.midTrunc__tail');
          return { clipped: head.scrollWidth > head.clientWidth + 1, tail: tail.textContent, tailRight: tail.getBoundingClientRect().right, nameRight: el.getBoundingClientRect().right };
        });
        expect(cut.clipped).toBe(true);
        expect('weather_observation_quality_by_city'.endsWith(cut.tail)).toBe(true);
        expect(cut.tailRight).toBeLessThanOrEqual(cut.nameRight + 1);
      }
      await expect(page.locator('.explorerTreeDatabaseRow .explorerTreeDatabase__name').first()).toHaveAttribute('title', /\S/);
      await expect(row).toHaveAttribute('title', /MergeTree · [\d,]+ rows · \d+\.\d MB on disk/);
      // The figure column is bytes only: views carry no badge; what lives in
      // memory (Memory, Buffer) reads "<bytes> RAM", or nothing while it holds
      // no measurable memory (its rows are in the title), never "rows".
      await expect(page.locator('.explorerTreeObject[data-table="valid_weather_observations"] .explorerTreeObject__size')).toHaveCount(0);
      await expect(page.locator('.explorerTreeObject[data-table="memory_weather"] .explorerTreeObject__size')).toHaveText(/^\d+(?:\.\d)? [KMGT]?B RAM$/);
      for (const name of ['weather_buffer', 'weather_alert_buffer']) {
        const size = page.locator(`.explorerTreeObject[data-table="${name}"] .explorerTreeObject__size`);
        if (await size.count()) await expect(size).toHaveText(/^\d+(?:\.\d)? [KMGT]?B RAM$/);
        await expect(page.locator(`.explorerTreeObject[data-table="${name}"]`)).toHaveAttribute('title', /rows/);
      }
      await expect(page.locator('#explorerTableList .explorerTreeObject__size').filter({ hasText: /rows/ })).toHaveCount(0);
      // Database rows: the same byte format, the object count in the title
      // (never a column that takes the name's room).
      const database = page.locator('.explorerTreeDatabase', { hasText: 'chdash_ui' }).first();
      await expect(database.locator('.explorerTreeDatabase__count')).toBeHidden();
      await expect(database).toHaveAttribute('title', /^chdash_ui · \d+ objects · /);
      await expect(database.locator('.explorerTreeDatabase__size')).toHaveText(/^\d+\.\d MB$/);
      expect(await page.locator('#explorerTableList .explorerTreeDatabase__count').evaluateAll((els) => els.filter((el) => el.offsetParent && el.textContent !== 'Loading\u2026').length)).toBe(0);
      // Names cut on their last "_": the scratch databases read alike.
      for (const name of ['chdash_rich_scratch', 'chdash_rich_scratch2']) {
        const tail = page.locator('.explorerTreeDatabase', { hasText: name }).locator('.midTrunc__tail').first();
        if (await tail.count()) await expect(tail).toHaveText(name.slice(name.lastIndexOf('_')));
      }

      await page.locator('#explorerSearchInput').fill('buffer_c');
      await expect(page.locator('#explorerTableList .explorerTreeObject')).toHaveCount(1);
      await expect(page.locator('.explorerTreeObject[data-table="weather_buffer_city_mv"] mark.explorerTreeMark')).toHaveText('buffer_c');
      await page.locator('#explorerSearchInput').fill('');
      await expect(page.locator('#explorerTableList mark')).toHaveCount(0);
    });

    test('one number format and readable in-cell bars on the database page', async ({ page }) => {
      // The Explorer formats through the app-wide ns.format (docs/ui-foundations.md).
      const formats = await page.goto('/explorer').then(() => page.waitForFunction(() => window.ChDash?.explorer)).then(() => page.evaluate(() => {
        const f = window.ChDash.format;
        return {
          explorerCopy: 'explorerFormat' in window.ChDash,
          int: f.count(120064), compact: f.compact(120064), million: f.compact(3_250_000), small: f.compact(999),
          zero: f.bytes(0), bytes: f.bytes(205), kb: f.bytes(1740), mb: f.bytes(10.3 * 1024 * 1024), carry: f.bytes(1024 * 1024 - 1),
          missing: f.bytes(null), missingInt: f.count(undefined), rate: f.rate(120064, 'rows'),
          percent: f.percent(0.0005), objects: f.countLabel(1, 'object'),
        };
      }));
      expect(formats).toEqual({
        explorerCopy: false,
        int: '120,064', compact: '120.1K', million: '3.3M', small: '999',
        zero: '0 B', bytes: '205 B', kb: '1.7 KB', mb: '10.3 MB', carry: '1.0 MB',
        missing: '\u2014', missingInt: '\u2014', rate: '120.1K rows/s',
        percent: '<0.1%', objects: '1 object',
      });

      await openDatabasePage(page);
      const objects = page.locator('#explorerDatabaseObjects');
      const weather = objects.locator('tbody tr[data-table="weather_observations"]');
      // Rows are grouped (B4), bytes carry one decimal and a unit.
      await expect(weather.locator('td').nth(3)).toHaveText(/^\d{1,3}(,\d{3})+$/);
      await expect(weather.locator('td').nth(4)).toHaveText(/^\d+\.\d MB$/);
      // In-cell bars: the shared .cellBar, normalised to the column max (B6).
      const size = weather.locator('td').nth(4);
      await expect(size).toHaveClass(/cellBar/);
      expect(await size.evaluate((td) => td.style.getPropertyValue('--cellBar'))).toBe('100.00%');
      // Typography (B3): headers are smaller than the section title above.
      const sizes = await page.evaluate(() => ({
        title: parseFloat(getComputedStyle(document.querySelector('.explorerDatabaseObjects .explorerSectionTitle')).fontSize),
        head: parseFloat(getComputedStyle(document.querySelector('#explorerDatabaseObjects thead th')).fontSize),
        cell: parseFloat(getComputedStyle(document.querySelector('#explorerDatabaseObjects tbody td')).fontSize),
      }));
      expect(sizes.cell).toBe(13);
      expect(sizes.head).toBeLessThan(sizes.title);
      // Every column fits the pane without horizontal scrolling at 1280 px and up (B5).
      const overflow = await objects.evaluate((wrap) => wrap.scrollWidth - wrap.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test('greyed Storage-graph objects stay readable', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations?mode=graph&graph=storage');
      await expandExplorerDatabase(page, 'chdash_ui');
      const blocked = page.locator('.explorerTreeObject.is-storage-blocked[data-table="valid_weather_observations"]');
      await expect(blocked).toBeVisible({ timeout: 15_000 });
      await expect(blocked).toBeDisabled();
      expect(await blocked.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    });
  });

  test.describe(`explorer mobile shell (${theme})`, () => {
    test.use({ colorScheme: theme, viewport: { width: 390, height: 844 } });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('chdash.theme', t); } catch (_) {} }, theme);
      await resetExplorerFilters(page);
    });

    test('header does not overlap and the tree is a drawer', async ({ page }) => {
      await page.goto('/explorer');
      const brand = await page.locator('.appBrand').boundingBox();
      const host = await page.locator('#hostPicker').boundingBox();
      const overlaps = !(brand.x + brand.width <= host.x || host.x + host.width <= brand.x || brand.y + brand.height <= host.y || host.y + host.height <= brand.y);
      expect(overlaps).toBe(false);
      await expect(page.locator('#hostPickerText')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // Nothing selected: the root page (All databases) shows, the drawer
      // stays closed until its toggle opens it (it never covers the page on
      // arrival).
      const toggle = page.locator('#explorerTreeToggle');
      await expect(toggle).toBeVisible();
      await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#explorerListPane')).toBeHidden();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#explorerListPane')).toBeVisible();
      await expandExplorerDatabase(page, 'chdash_ui');
      await page.locator('.explorerTreeObject[data-table="weather_observations"]').click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#explorerListPane')).toBeHidden();
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      // Detail uses the full width.
      const detail = await page.locator('#explorerDetailPane').boundingBox();
      expect(detail.width).toBeGreaterThan(340);

      await toggle.click();
      await expect(page.locator('#explorerListPane')).toBeVisible();
      await page.locator('#explorerTreeBackdrop').click({ position: { x: 370, y: 400 } });
      await expect(page.locator('#explorerListPane')).toBeHidden();
      await toggle.click();
      await page.keyboard.press('Escape');
      await expect(page.locator('#explorerListPane')).toBeHidden();

      // The one tab row (Catalog | Functions, the divider, Browse | Graph)
      // fits the phone width on the nav row's line; no breadcrumb.
      const topBar = await page.locator('#explorerTopBar').boundingBox();
      for (const id of ['#explorerNavTabs', '#explorerViewTabs', '#explorerModeSep', '#explorerModeTabs']) {
        const box = await page.locator(id).boundingBox();
        expect(box.x + box.width, id).toBeLessThanOrEqual(390);
        expect(box.y + box.height, id).toBeLessThanOrEqual(topBar.y + topBar.height + 0.5);
      }
      await expect(page.locator('#explorerBreadcrumb')).toHaveCount(0);
      // 40 px hit areas on a touch screen (the row is the 48 px nav row).
      for (const id of ['#explorerCatalogTab', '#explorerFunctionsTab', '#explorerModeBrowse', '#explorerModeGraph']) {
        const box = await page.locator(id).boundingBox();
        expect(box.height, id).toBeGreaterThanOrEqual(40);
        expect(box.width, id).toBeGreaterThanOrEqual(40);
      }
    });

    test('a nav row too narrow for its tabs scrolls sideways with its edge cues, never the page', async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await page.goto('/explorer?mode=graph');
      const row = page.locator('#explorerNavTabs');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
      const sizes = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
      expect(sizes.ox).toBe('auto');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (sizes.sw > sizes.cw + 1) {
        // The selected tab is kept in view; the hidden side fades.
        const box = await row.boundingBox();
        const graph = await page.locator('#explorerModeGraph').boundingBox();
        expect(graph.x + graph.width).toBeLessThanOrEqual(box.x + box.width + 1);
        await expect(row).toHaveClass(/has-edge-start/);
        await row.evaluate((el) => { el.scrollLeft = 0; });
        await expect(row).toHaveClass(/has-edge-end/);
        await expect(row).not.toHaveClass(/has-edge-start/);
      } else {
        await expect(row).not.toHaveClass(/has-edge-(start|end)/);
      }
    });

    test('the tree drawer works in every Catalog mode and the mode bar stays in reach', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      const toggle = page.locator('#explorerTreeToggle');
      const pane = page.locator('#explorerListPane');
      const picks = { Graph: 'wide_types', Browse: 'weather_observations' };
      for (const [mode, table] of Object.entries(picks)) {
        const tab = page.locator(`#explorerMode${mode}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-controls', 'explorerListPane');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(async () => (await pane.boundingBox()).x).toBeGreaterThanOrEqual(0);
        // The drawer opens under the nav row: the modes stay on top and usable.
        const bar = await page.locator('#explorerTopBar').boundingBox();
        expect((await pane.boundingBox()).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
        const center = await tab.boundingBox();
        expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#explorerModeTabs') != null,
          [center.x + center.width / 2, center.y + center.height / 2])).toBe(true);
        await expandExplorerDatabase(page, 'chdash_ui');
        await pane.locator(`.explorerTreeObject[data-table="${table}"]`).click();
        await expect(pane).toBeHidden();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${table}`));
      }
      // The Storage tab at a phone width: the selection's partitions, without overflow.
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page.locator('#explorerDetailContent .explorerTable--partitions thead th').nth(1)).toHaveText(/^Partition/, { timeout: 15_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // And the database page's storage.
      await page.goto('/explorer/chdash_ui?tab=storage');
      await expect(page.locator('#explorerDatabaseDisks')).toBeVisible({ timeout: 15_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      expect(await page.locator('#explorerDetailContent').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });

    test('the Functions list is a drawer too', async ({ page }) => {
      await page.goto('/explorer/_functions');
      const toggle = page.locator('#explorerTreeToggle');
      const pane = page.locator('#explorerFunctionListPane');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-controls', 'explorerFunctionListPane');
      await expect(toggle).toHaveAttribute('aria-label', 'Show functions');
      await expect(pane).toBeHidden();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(pane).toBeVisible();
      // On screen once the slide-in settles.
      await expect.poll(async () => (await pane.boundingBox()).x).toBeGreaterThanOrEqual(0);
      const box = await pane.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      await page.locator('#explorerFunctionSearchInput').fill('arrayMap');
      await page.locator('.explorerFunctionObject', { hasText: /^arrayMap$/ }).first().click();
      await expect(page).toHaveURL(/\/explorer\/_functions\/arrayMap$/);
      await expect(pane).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      // Backdrop and Escape close it, as for the object tree.
      await toggle.click();
      await expect(pane).toBeVisible();
      await page.locator('#explorerFunctionsPane .explorerTreeBackdrop').click({ position: { x: 370, y: 400 } });
      await expect(pane).toBeHidden();
      // Back on Catalog the button controls the object tree again.
      await page.locator('#explorerCatalogTab').click();
      await expect(toggle).toHaveAttribute('aria-controls', 'explorerListPane');
    });
  });
}

// Reserved routes start with "_" so no database name can shadow them; the
// former /explorer/functions and /explorer/databases stay aliases unless a
// database of that name exists.
test.describe('explorer reserved routes', () => {
  async function withDatabase(page, name) {
    await page.route(/\/api\/explorer\/catalog\?/, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('database') === name) {
        await route.fulfill({ json: { databases: [name], tables: [] } });
        return;
      }
      // The page may navigate away while the real answer is in flight: a
      // disposed response is then ignored instead of failing the test.
      try {
        const response = await route.fetch();
        const json = await response.json();
        json.databases = [...new Set([...(json.databases || []), name])].sort();
        await route.fulfill({ response, json });
      } catch (error) {
        if (!/disposed|closed|Target page/i.test(String(error?.message || error))) throw error;
      }
    });
  }

  test('functions routes use the reserved segment and keep the old alias', async ({ page }) => {
    await page.goto('/explorer/_functions/arrayMap');
    await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#explorerFunctionDetail')).toContainText('arrayMap', { timeout: 15_000 });

    await page.goto('/explorer/functions/arrayMap');
    await expect(page).toHaveURL(/\/explorer\/_functions\/arrayMap$/);
    await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#explorerFunctionDetail')).toContainText('arrayMap', { timeout: 15_000 });

    await page.goto('/explorer/functions');
    await expect(page).toHaveURL(/\/explorer\/_functions$/);
    await expect(page.locator('#explorerFunctionsPane')).toBeVisible();

    await page.goto('/explorer/databases');
    await expect(page).toHaveURL(/\/explorer$/);
    await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
  });

  test('a database named functions opens as a database', async ({ page }) => {
    await withDatabase(page, 'functions');
    await page.goto('/explorer/functions');
    await expect(page.locator('#explorerDetailName')).toHaveText('functions', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/explorer\/functions$/);
    await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#explorerFunctionsPane')).toBeHidden();
    // The Functions view is still one tab away, on its reserved route.
    await page.locator('#explorerFunctionsTab').click();
    await expect(page).toHaveURL(/\/explorer\/_functions$/);
    await page.goBack();
    await expect(page.locator('#explorerDetailName')).toHaveText('functions');
  });

  test('a database named databases opens as a database', async ({ page }) => {
    await withDatabase(page, 'databases');
    await page.goto('/explorer/databases');
    await expect(page.locator('#explorerDetailName')).toHaveText('databases', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/explorer\/databases$/);
  });
});

// The CREATE statement scrolls sideways inside its block: it never runs over
// the About column next to it, and it is set in the monospace token.
test.describe('explorer DDL block', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('long DDL lines scroll inside the DDL block', async ({ page }) => {
    await page.route(/\/api\/explorer\/table\?/, async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      const long = `-- ${'x'.repeat(400)}`;
      json.ddl = `${json.ddl || 'CREATE TABLE t'}\n${long}`;
      if (json.formatted_ddl) json.formatted_ddl = `${json.formatted_ddl}\n${long}`;
      await route.fulfill({ response, json });
    });
    await page.goto('/explorer/chdash_ui/weather_observations/ddl');
    const pre = page.locator('.explorerDdlWrap .explorerDdl');
    await expect(pre).toBeVisible({ timeout: 15_000 });
    const geometry = await page.evaluate(() => {
      const code = document.querySelector('.explorerDdlWrap .explorerDdl');
      const wrap = code.closest('.explorerDdlWrap');
      const text = code.querySelector('.sqlBlock__pre');
      const about = document.querySelector('.explorerCard > :not(.explorerCard__main)');
      const box = (el) => el.getBoundingClientRect();
      return {
        scrollable: code.scrollWidth > code.clientWidth + 100,
        overflowX: getComputedStyle(code).overflowX,
        codeRight: box(code).right,
        wrapLeft: box(wrap).left,
        wrapRight: box(wrap).right,
        aboutLeft: about ? box(about).left : -1,
        font: getComputedStyle(text).fontFamily,
      };
    });
    expect(geometry.overflowX).toBe('auto');
    expect(geometry.scrollable).toBe(true);
    expect(geometry.codeRight).toBeLessThanOrEqual(geometry.wrapRight + 1);
    // At 1440 the About column sits to the right of the DDL.
    expect(geometry.aboutLeft).toBeGreaterThan(geometry.wrapLeft);
    expect(geometry.wrapRight).toBeLessThanOrEqual(geometry.aboutLeft + 1);
    expect(geometry.font).toMatch(/monospace/);
  });
});

// Audit round 2 (Explorer): an unknown address is a "not found" page, the
// type chips keep their width when locked, DDL types share one token, the
// Functions pages read from the pane's left edge, Preview types show whole,
// Storage parts chip only the exception.
test.describe('explorer audit round 2', () => {
  test.beforeEach(async ({ page }) => { await resetExplorerFilters(page); });

  test('an unknown database or table is a "not found" page with its ways out, never a tree row', async ({ page }) => {
    await page.goto('/explorer');
    await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
    const count = await page.locator('#explorerTreeMeta').textContent();
    await page.goto('/explorer/no_such_db_zz');
    const notFound = page.locator('#explorerNotFound');
    await expect(notFound).toBeVisible({ timeout: 15_000 });
    await expect(notFound.locator('.uiState__title')).toHaveText('Database not found');
    await expect(notFound).toContainText('no_such_db_zz');
    await expect(notFound.getByRole('button')).toHaveText(['All databases', 'Refresh']);
    await expect(page.locator('#explorerDetail')).toBeHidden();
    await expect(page.locator('#explorerError')).toBeHidden();
    // Not added to the tree; the count is unchanged; the address stays.
    await expect(page.locator('#explorerTableList .explorerTreeDatabase', { hasText: 'no_such_db_zz' })).toHaveCount(0);
    await expect(page.locator('#explorerTreeMeta')).toHaveText(count);
    await expect(page).toHaveURL(/\/explorer\/no_such_db_zz$/);
    // Refresh asks the server again and stays on the page.
    await notFound.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('#explorerNotFound .uiState__title')).toHaveText('Database not found', { timeout: 15_000 });
    await expect(page.locator('#explorerTableList .explorerTreeDatabase', { hasText: 'no_such_db_zz' })).toHaveCount(0);
    await page.locator('#explorerNotFound').getByRole('button', { name: 'All databases' }).click();
    await expect(page.locator('#explorerDatabasesOverview')).toBeVisible();
    await expect(page).toHaveURL(/\/explorer$/);

    // A table: the same page, with a way to its database.
    await page.goto('/explorer/chdash_ui/no_such_table_zz');
    await expect(page.locator('#explorerNotFound .uiState__title')).toHaveText('Table not found', { timeout: 15_000 });
    await expect(page.locator('#explorerNotFound')).toContainText('chdash_ui.no_such_table_zz');
    await expect(page.locator('#explorerError')).toBeHidden();
    await expect(page.locator('#explorerTableList .explorerTreeObject[data-table="no_such_table_zz"]')).toHaveCount(0);
    await page.locator('#explorerNotFound').getByRole('button', { name: 'Open chdash_ui' }).click();
    await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
    await expect(page.locator('#explorerNotFound')).toBeHidden();
    await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
  });

  test('a locked type chip keeps its width and its line: the tree never shifts', async ({ page }) => {
    await page.goto('/explorer/chdash_ui');
    await expect(page.locator('#explorerDatabaseObjects tbody tr').first()).toBeVisible({ timeout: 15_000 });
    const measure = () => page.evaluate(() => ({
      chips: [...document.querySelectorAll('#explorerTreeFilters .explorerFilterChip')].map((el) => Math.round(el.getBoundingClientRect().width)),
      tree: Math.round(document.getElementById('explorerTableList').getBoundingClientRect().top),
      wraps: [...document.querySelectorAll('#explorerTreeFilters .explorerFilterChip')].some((el) => getComputedStyle(el).whiteSpace !== 'nowrap'),
    }));
    const before = await measure();
    await page.goto('/explorer/chdash_ui/weather_observations');
    await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
    await expect(page.locator('.explorerFilterChip[data-filter="tables"]')).toHaveAttribute('aria-disabled', 'true');
    const after = await measure();
    expect(after.chips).toEqual(before.chips);
    expect(after.tree).toBe(before.tree);
    expect(after.wraps).toBe(false);
  });

  test('DDL: every ClickHouse type takes the one type token', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations?tab=ddl');
    const ddl = page.locator('#explorerDetailContent .explorerDdl');
    await expect(ddl).toBeVisible({ timeout: 15_000 });
    const types = await ddl.locator('.tok-type').allTextContents();
    for (const type of ['DateTime64', 'Date', 'LowCardinality', 'String', 'UInt64', 'Bool']) expect(types, type).toContain(type);
    const keywords = await ddl.locator('.tok-kw').allTextContents();
    expect(keywords.filter((word) => /^(Date|Array|Float\d+|Nullable|LowCardinality|DateTime64)$/.test(word))).toEqual([]);
    const colors = await ddl.locator('.tok-type').evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
    expect(colors).toHaveLength(1);
  });

  test('Functions pages are centred: the overview in the pane, the documentation under the header', async ({ page }) => {
    // Restored (user 2026-10-04): the design from before 2026-10-03, a
    // centred page. The header stays on the pane's left edge.
    await page.goto('/explorer/_functions/arrayMap');
    const name = page.locator('#explorerFunctionDetailName');
    await expect(name).toHaveText('arrayMap', { timeout: 15_000 });
    const description = page.locator('#explorerFunctionDescription');
    await expect(description).toBeVisible();
    const content = await page.locator('#explorerFunctionsPane .explorerDetailPane').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { left: r.left + parseFloat(cs.paddingLeft) + el.clientLeft, right: r.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight) };
    });
    const [nameBox, descBox] = await Promise.all([name.boundingBox(), description.boundingBox()]);
    expect(Math.abs(nameBox.x - content.left)).toBeLessThanOrEqual(2);
    if (content.right - content.left > 1000) {
      // Narrower than the pane (980 px at most) and centred in it.
      expect(descBox.width).toBeLessThanOrEqual(981);
      expect(descBox.x - nameBox.x).toBeGreaterThan(20);
      expect(Math.abs((descBox.x - content.left) - (content.right - (descBox.x + descBox.width)))).toBeLessThanOrEqual(3);
    }
    await page.goto('/explorer/_functions');
    const overview = page.locator('.explorerFunctionOverview');
    await expect(overview).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#explorerFunctionCategories')).toBeVisible();
    const pane = await page.locator('#explorerFunctionsPane .explorerDetailPane').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left + el.clientLeft, right: r.left + el.clientLeft + el.clientWidth };
    });
    const box = await overview.boundingBox();
    expect(box.width).toBeLessThanOrEqual(821);
    if (pane.right - pane.left > 900) {
      expect(box.x - pane.left).toBeGreaterThan(40);
      expect(Math.abs((box.x - pane.left) - (pane.right - (box.x + box.width)))).toBeLessThanOrEqual(3);
    }
  });

  test('Functions kind chips: every chip filled while the list shows every kind; one kind at a time', async ({ page }) => {
    // Unchanged by the restore (user 2026-10-04): filled = listed.
    await page.goto('/explorer/_functions');
    const chips = page.locator('#explorerFunctionFilters .explorerFilterChip');
    await expect(chips).toHaveText(['Functions', 'Aggregate', 'Table', 'UDF'], { timeout: 15_000 });
    expect(await chips.evaluateAll((els) => els.map((el) => el.getAttribute('aria-pressed')))).toEqual(['true', 'true', 'true', 'true']);
    await chips.filter({ hasText: 'Aggregate' }).click();
    expect(await chips.evaluateAll((els) => els.map((el) => el.getAttribute('aria-pressed')))).toEqual(['false', 'true', 'false', 'false']);
    await chips.filter({ hasText: 'Aggregate' }).click();
    expect(await chips.evaluateAll((els) => els.map((el) => el.getAttribute('aria-pressed')))).toEqual(['true', 'true', 'true', 'true']);
  });

  test('Preview headers show each column type whole', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations?tab=preview');
    const heads = page.locator('#explorerDetailContent .explorerPreviewTable thead th[data-type]');
    await expect(heads.first()).toBeVisible({ timeout: 15_000 });
    const cut = await heads.evaluateAll((ths) => ths.filter((th) => {
      const after = getComputedStyle(th, '::after');
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${after.font}`;
      probe.textContent = th.dataset.type;
      document.body.appendChild(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      const cs = getComputedStyle(th);
      const room = th.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(after.paddingLeft) - parseFloat(after.paddingRight);
      return after.position === 'absolute' || after.textOverflow === 'ellipsis' || need > room + 1;
    }).map((th) => th.dataset.type));
    expect(cut).toEqual([]);
    await expect(heads.filter({ hasText: 'city' }).first()).toHaveAttribute('title', /LowCardinality\(String\)/);
  });

  test('Storage parts: "active" is plain text, only an inactive part is a chip', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations?tab=storage');
    const parts = page.locator('#explorerDetailContent .explorerPartState');
    await expect(parts.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#explorerDetailContent .explorerBadge--active')).toHaveCount(0);
    expect(await parts.evaluateAll((els) => els.every((el) => el.textContent === 'active' && getComputedStyle(el).borderTopWidth === '0px'))).toBe(true);
  });
});
