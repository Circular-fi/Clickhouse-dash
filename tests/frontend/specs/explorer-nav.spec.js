import { test, expect } from '@playwright/test';
import { expandExplorerDatabase } from '../helpers/app.js';

// Explorer shell (Catalog / Functions view tabs, the Catalog's Browse / Graph
// / Storage modes over one tree selection, type chips, mobile drawer), the
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

    test('top tabs are Catalog / Functions; Browse, Graph and Storage are modes of one Catalog', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerViewTabs .viewTab:visible')).toHaveText(['Catalog', 'Functions']);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      // The mode switch heads the content, not the top tab row.
      const modes = page.locator('#explorerModeTabs .viewTab:visible');
      await expect(modes).toHaveText(['Browse', 'Graph', 'Storage']);
      await expect(page.locator('#explorerTopBar #explorerModeTabs')).toHaveCount(0);
      await expect(page.locator('#explorerCatalogMain > #explorerModeBar #explorerModeTabs')).toBeVisible();
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      // Former tabs and switches are gone.
      await expect(page.locator('#explorerGraphTab, #explorerStorageTab, #explorerSectionSelectButton, #explorerModeSelectButton, #explorerTableSettingsButton')).toHaveCount(0);

      // The tree is there in every mode.
      for (const mode of ['Graph', 'Storage', 'Browse']) {
        await page.locator(`#explorerMode${mode}`).click();
        await expect(page.locator(`#explorerMode${mode}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#explorerListPane')).toBeVisible();
        await expect(page.locator('#explorerTreeFilters')).toBeVisible();
      }
      await expect(page.locator('#explorerCatalogView')).toBeVisible();
      await expect(page.locator('#explorerGraphPane')).toBeHidden();
      await expect(page.locator('#explorerSystemPane')).toBeHidden();

      // Arrow keys move between the mode tabs, and between the view tabs.
      await page.locator('#explorerModeBrowse').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerModeGraph')).toBeFocused();
      await expect(page).toHaveURL(/\/explorer\?mode=graph&graph=lineage&depth=1$/);
      await page.keyboard.press('End');
      await expect(page.locator('#explorerModeStorage')).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/explorer\?mode=storage$/);
      await page.locator('#explorerCatalogTab').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/explorer\/_functions$/);
      // Back on the Catalog, the mode is kept.
      await page.locator('#explorerCatalogTab').click();
      await expect(page.locator('#explorerModeStorage')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerSystemPane')).toBeVisible();
    });

    test('the tree selection is the scope of every mode; Storage drills move it and history walks back', async ({ page }) => {
      await page.goto('/explorer');
      await expandExplorerDatabase(page, 'chdash_ui');
      await page.locator('.explorerTreeObject[data-table="weather_observations"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });

      // Graph focuses the selected table.
      await page.locator('#explorerModeGraph').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?mode=graph&graph=lineage&depth=1$/);
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      await expect(page.locator('#explorerCatalogView')).toBeHidden();
      await expect(page.locator('#explorerGraphStatus')).toContainText('chdash_ui.weather_observations', { timeout: 20_000 });
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');

      // Storage shows the selected table's partitions.
      await page.locator('#explorerModeStorage').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?mode=storage$/);
      const list = page.locator('#explorerStorageList');
      await expect(list.locator('thead th')).toHaveText([/^Partition/, /^Size/, /^Share/, /^Rows/, /^Parts/], { timeout: 15_000 });
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');

      // Up: the database scope, selected in the tree.
      const up = page.locator('#explorerScopeUp');
      await expect(up).toHaveText(/chdash_ui/);
      await up.click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?mode=storage$/);
      await expect(list.locator('tbody tr').first()).toHaveAttribute('data-name', 'weather_observations', { timeout: 15_000 });
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(selectedObject(page)).toHaveCount(0);
      await expect(up).toHaveText(/All databases/);

      // A Storage zoom moves the tree selection, and Browse follows.
      await list.locator('tbody tr[data-name="wide_types"] .explorerStorageList__name').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?mode=storage$/);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'wide_types');
      await expect(list.locator('thead th').first()).toHaveText(/^Partition/, { timeout: 15_000 });
      await page.locator('#explorerModeBrowse').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/columns$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types', { timeout: 15_000 });
      // A tree pick in Graph keeps Graph and refocuses it.
      await page.locator('#explorerModeGraph').click();
      await page.locator('.explorerTreeObject[data-table="weather_observations"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?mode=graph&graph=lineage&depth=1$/);
      await expect(page.locator('#explorerGraphStatus')).toContainText('chdash_ui.weather_observations', { timeout: 20_000 });

      // History walks back through modes and scopes.
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?mode=graph&graph=lineage&depth=1$/);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'wide_types');
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\/columns$/);
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.wide_types');
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?mode=storage$/);
      await expect(page.locator('#explorerSystemPane')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?mode=storage$/);
      await expect(list.locator('thead th').first()).toHaveText(/^Table/);
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(selectedObject(page)).toHaveCount(0);
      await page.goForward();
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'wide_types');

      // Up from a database reaches the server scope (Graph: all databases).
      await page.locator('#explorerScopeUp').click();
      await page.locator('#explorerScopeUp').click();
      await expect(page).toHaveURL(/\/explorer\?mode=storage$/);
      await expect(list.locator('thead th').first()).toHaveText(/^Database/);
      await expect(selectedDatabase(page)).toHaveCount(0);
      await expect(page.locator('#explorerScopeUp')).toBeHidden();

      // Open card leaves Storage for the table card in Browse.
      await list.locator('tbody tr[data-name="chdash_ui"] .explorerStorageList__name').click();
      await list.locator('tbody tr[data-name="weather_observations"] .explorerStorageList__open').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns$/);
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
    });

    test('the System chip drives Storage; Storage has no checkbox of its own', async ({ page }) => {
      await page.goto('/explorer?mode=storage');
      const list = page.locator('#explorerStorageList');
      await expect(list.locator('tbody tr[data-name="chdash_ui"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#explorerSystemPane input[type="checkbox"], .explorerStorageView__option')).toHaveCount(0);
      await expect(list.locator('tbody tr[data-name="system"]')).toHaveCount(0);
      const chip = page.locator('.explorerFilterChip[data-filter="system"]');
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(list.locator('tbody tr[data-name="system"]')).toBeVisible();
      await expect(page.locator('#explorerTableList .explorerTreeDatabaseToggle[aria-label="Expand system"]')).toBeVisible();
      // Zooming into a system database selects it and locks the chip.
      await list.locator('tbody tr[data-name="system"] .explorerStorageList__name').click();
      await expect(page).toHaveURL(/\/explorer\/system\?mode=storage$/);
      await expect(selectedDatabase(page)).toContainText('system');
      await expect(chip).toBeDisabled();
      await page.locator('#explorerScopeUp').click();
      await expect(chip).toBeEnabled();
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
      await expect(list.locator('tbody tr[data-name="system"]')).toHaveCount(0);
      await expect(list.locator('tbody tr[data-name="chdash_ui"]')).toBeVisible();
    });

    test('Operations is hidden for now and its deep link falls back to the Catalog', async ({ page }) => {
      await page.goto('/explorer/_operations');
      await expect(page).toHaveURL(/\/explorer$/);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerOpsTab')).toBeHidden();
      await expect(page.locator('#explorerOpsPane')).toBeHidden();
      await expect(page.locator('#explorerViewTabs .viewTab:visible')).toHaveText(['Catalog', 'Functions']);
      // The module is not even loaded.
      expect(await page.evaluate(() => !!window.ChDash?.explorer && !window.ChDash.explorerOps)).toBe(true);
    });

    test('no breadcrumb: the tree selection carries the location', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      await expect(page.locator('#explorerBreadcrumb, .explorerBreadcrumb, nav[aria-label="Location"]')).toHaveCount(0);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');
      // Browse has no Up button: the tree and the card header name the object.
      await expect(page.locator('#explorerScopeUp')).toBeHidden();
      await page.locator('#explorerModeStorage').click();
      await expect(page.locator('#explorerStorageList tbody tr').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.explorerStorageCrumbs, [aria-label="Storage scope"]')).toHaveCount(0);
    });

    test('former URLs are aliases of the Catalog scheme', async ({ page }) => {
      const cases = [
        ['/explorer/chdash_ui/weather_observations/columns?view=browse', /\/explorer\/chdash_ui\/weather_observations\/columns$/, 'browse'],
        ['/explorer/chdash_ui?view=browse', /\/explorer\/chdash_ui$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations/schema', /\/explorer\/chdash_ui\/weather_observations\/columns$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations/overview?view=graph&graph=lineage&depth=2', /\/explorer\/chdash_ui\/weather_observations\?mode=graph&graph=lineage&depth=2$/, 'graph'],
        ['/explorer?view=graph', /\/explorer\?mode=graph&graph=lineage&depth=1$/, 'graph'],
        ['/explorer/_system', /\/explorer\?mode=storage$/, 'storage'],
        ['/explorer/_system?database=chdash_ui', /\/explorer\/chdash_ui\?mode=storage$/, 'storage'],
        ['/explorer/_system?database=chdash_ui&table=weather_observations', /\/explorer\/chdash_ui\/weather_observations\?mode=storage$/, 'storage'],
      ];
      for (const [from, to, mode] of cases) {
        await page.goto(from);
        await expect(page, from).toHaveURL(to);
        await expect(page.locator(`#explorerMode${mode[0].toUpperCase()}${mode.slice(1)}`), from).toHaveAttribute('aria-selected', 'true');
      }
      // The last alias opened the table's partitions with the table selected.
      await expect(page.locator('#explorerStorageList thead th').first()).toHaveText(/^Partition/, { timeout: 15_000 });
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'weather_observations');
      // A deep link per mode reloads as it was.
      await page.reload();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?mode=storage$/);
      await expect(page.locator('#explorerStorageList thead th').first()).toHaveText(/^Partition/, { timeout: 15_000 });
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
      await expect(views).toBeDisabled();
      await expect(tree.locator('.explorerTreeObject.is-selected')).toHaveAttribute('data-table', 'valid_weather_observations');

      // System databases appear only with the System chip.
      await expect(tree.locator('.explorerTreeDatabase', { hasText: /^system/ })).toHaveCount(0);
      await page.locator('.explorerFilterChip[data-filter="system"]').click();
      await expect(tree.locator('.explorerTreeDatabaseToggle[aria-label="Expand system"]')).toBeVisible();
      await page.locator('.explorerFilterChip[data-filter="system"]').click();
      await page.locator('.explorerFilterChip[data-filter="mv"]').click();
    });

    test('tree rows are one line with a size badge, a relative bar and search highlights', async ({ page }) => {
      await page.goto('/explorer');
      await expandExplorerDatabase(page, 'chdash_ui');
      const row = page.locator('.explorerTreeObject[data-table="weather_observations"]');
      const box = await row.boundingBox();
      expect(box.height).toBeLessThanOrEqual(28);
      await expect(row.locator('.explorerTreeObject__meta')).toHaveCount(0);
      const badge = row.locator('.explorerTreeObject__size');
      await expect(badge).toHaveText(/^\d+\.\d MB$/);
      // Largest object of the database: full bar; the bar is a visible fill.
      expect(await badge.evaluate((el) => el.style.getPropertyValue('--bar-pct'))).toBe('100%');
      expect(await badge.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/gradient/);
      await expect(row).toHaveAttribute('title', /Merge Tree · [\d,]+ rows · \d+\.\d MB on disk/);
      // Views carry no badge; a Buffer shows its resident bytes, or its
      // buffered rows while it holds no measurable memory.
      await expect(page.locator('.explorerTreeObject[data-table="valid_weather_observations"] .explorerTreeObject__size')).toHaveCount(0);
      await expect(page.locator('.explorerTreeObject[data-table="weather_buffer"] .explorerTreeObject__size')).toHaveText(/^(?:\d+(?:\.\d)? [KMGT]?B|[\d,.]+[KMBT]? rows)$/);
      // Database rows: "N objects" + the same byte format.
      const database = page.locator('.explorerTreeDatabase', { hasText: 'chdash_ui' }).first();
      await expect(database.locator('.explorerTreeDatabase__count')).toHaveText(/^\d+ objects$/);
      await expect(database.locator('.explorerTreeDatabase__size')).toHaveText(/^\d+\.\d MB$/);
      await expect(page.locator('#explorerTableList .explorerTreeDatabase__count').filter({ hasText: /^Tables$/ })).toHaveCount(0);

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

      // Nothing selected: the drawer starts open.
      const toggle = page.locator('#explorerTreeToggle');
      await expect(toggle).toBeVisible();
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

      // The tabs and the mode bar fit the phone width; no breadcrumb.
      for (const id of ['#explorerViewTabs', '#explorerModeBar', '#explorerModeTabs']) {
        const box = await page.locator(id).boundingBox();
        expect(box.x + box.width, id).toBeLessThanOrEqual(390);
      }
      await expect(page.locator('#explorerBreadcrumb')).toHaveCount(0);
    });

    test('the tree drawer works in every Catalog mode and the mode bar stays in reach', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      const toggle = page.locator('#explorerTreeToggle');
      const pane = page.locator('#explorerListPane');
      const picks = { Graph: 'wide_types', Storage: 'weather_observations', Browse: 'wide_types' };
      for (const [mode, table] of Object.entries(picks)) {
        const tab = page.locator(`#explorerMode${mode}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-controls', 'explorerListPane');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(async () => (await pane.boundingBox()).x).toBeGreaterThanOrEqual(0);
        // The drawer opens under the mode bar: its tabs stay on top and usable.
        const bar = await page.locator('#explorerModeBar').boundingBox();
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
      // Storage at a phone width: the selection's partitions, without overflow.
      await page.locator('#explorerModeStorage').click();
      await expect(page.locator('#explorerStorageList thead th').first()).toHaveText(/^Partition/, { timeout: 15_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
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
      const about = document.querySelector('.explorerCard > :not(.explorerCard__main)');
      const box = (el) => el.getBoundingClientRect();
      return {
        scrollable: code.scrollWidth > code.clientWidth + 100,
        overflowX: getComputedStyle(code).overflowX,
        codeRight: box(code).right,
        wrapLeft: box(wrap).left,
        wrapRight: box(wrap).right,
        aboutLeft: about ? box(about).left : -1,
        font: getComputedStyle(code).fontFamily,
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
