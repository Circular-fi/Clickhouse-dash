import { test, expect } from '@playwright/test';
import { expandExplorerDatabase } from '../helpers/app.js';

// Explorer shell (Catalog / Functions view tabs, the Catalog's Browse / Graph
// modes over one tree selection, the cards' Storage tabs, type chips, mobile
// drawer), the
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

    test('one nav row: Catalog / Functions tabs on the left, Browse and Graph modes as a segmented control on the right', async ({ page }) => {
      await page.goto('/explorer');
      await expect(page.locator('#explorerViewTabs .viewTab:visible')).toHaveText(['Catalog', 'Functions']);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      // The modes are a segmented control (modes) in the same row as the tabs
      // (sections are underlined tabs), on its right; the row is 48 px.
      const modes = page.locator('#explorerModeTabs .segmented__option:visible');
      await expect(modes).toHaveText(['Browse', 'Graph']);
      // Storage is a tab of the database and table cards, not a mode.
      await expect(page.locator('#explorerModeStorage, #explorerSystemPane, [data-mode="storage"]')).toHaveCount(0);
      await expect(page.locator('#explorerTopBar > #explorerModeBar > #explorerModeTabs')).toBeVisible();
      await expect(page.locator('#explorerModeTabs')).toHaveAttribute('role', 'group');
      await expect(page.locator('#explorerModeTabs [role="tab"]')).toHaveCount(0);
      await expect(page.locator('#explorerCatalogMain #explorerModeBar')).toHaveCount(0);
      const row = await page.locator('#explorerTopBar').boundingBox();
      const tabs = await page.locator('#explorerViewTabs').boundingBox();
      const seg = await page.locator('#explorerModeTabs').boundingBox();
      expect(row.height).toBeCloseTo(48, 0);
      expect(seg.x).toBeGreaterThan(tabs.x + tabs.width);
      expect(row.x + row.width - (seg.x + seg.width)).toBeLessThan(24);
      expect(Math.abs((seg.y + seg.height / 2) - (tabs.y + tabs.height / 2))).toBeLessThanOrEqual(1);
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-pressed', 'true');
      // Former tabs and switches are gone.
      await expect(page.locator('#explorerGraphTab, #explorerStorageTab, #explorerSectionSelectButton, #explorerModeSelectButton, #explorerTableSettingsButton')).toHaveCount(0);

      // The tree is there in every mode.
      for (const mode of ['Graph', 'Browse']) {
        await page.locator(`#explorerMode${mode}`).click();
        await expect(page.locator(`#explorerMode${mode}`)).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#explorerListPane')).toBeVisible();
        await expect(page.locator('#explorerTreeFilters')).toBeVisible();
      }
      await expect(page.locator('#explorerCatalogView')).toBeVisible();
      await expect(page.locator('#explorerGraphPane')).toBeHidden();

      // The modes are toggle buttons (Tab, Enter, Space); arrow keys move
      // between the view tabs.
      await page.locator('#explorerModeGraph').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#explorerModeGraph')).toBeFocused();
      await expect(page).toHaveURL(/\/explorer\?mode=graph&graph=lineage&depth=1$/);
      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#explorerModeBrowse')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/\/explorer$/);
      await page.locator('#explorerModeGraph').click();
      await page.locator('#explorerCatalogTab').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(/\/explorer\/_functions$/);
      // Functions has no modes; back on the Catalog, the mode is kept.
      await expect(page.locator('#explorerModeBar')).toBeHidden();
      await page.locator('#explorerCatalogTab').click();
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
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

      // Up (Graph only): the database scope, selected in the tree.
      const up = page.locator('#explorerScopeUp');
      await expect(up).toHaveText(/chdash_ui/);
      await up.click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?mode=graph/);
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(selectedObject(page)).toHaveCount(0);
      await expect(up).toHaveText(/All databases/);

      // Browse: the database card; its Storage tab, then a table of its map
      // opens on that table's Storage tab.
      await page.locator('#explorerModeBrowse').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(page.locator('#explorerScopeUp')).toBeHidden();
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/);
      const segment = page.locator('#explorerDatabaseTreemap .explorerTreemap__node[data-kind="table"], #explorerDatabaseStorageStrip button.explorerStorageStrip__segment').first();
      await expect(segment).toBeVisible({ timeout: 15_000 });
      const opened = await segment.evaluate((el) => el.dataset.table);
      await segment.click();
      await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${opened}\\?tab=storage$`));
      await expect(selectedObject(page)).toHaveAttribute('data-table', opened);
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage', { timeout: 15_000 });

      // A tree pick keeps the card tab; the database keeps its own.
      await page.locator('.explorerTreeObject[data-table="wide_types"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?tab=storage$/);
      await page.locator('.explorerTreeDatabase', { hasText: 'chdash_ui' }).first().click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/);

      // History walks back through tabs and scopes.
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types\?tab=storage$/);
      await expect(selectedObject(page)).toHaveAttribute('data-table', 'wide_types');
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${opened}\\?tab=storage$`));
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/);
      await expect(selectedDatabase(page)).toContainText('chdash_ui');
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage');
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui$/);
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Objects');
      await expect(page.locator('#explorerDatabaseObjects')).toBeVisible();
      await page.goForward();
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage');
    });

    test('a first visit to a card tab link opens that tab', async ({ browser }) => {
      // A new context has no stored host: the host is chosen while the route
      // waits for the catalog, and the tab survives it.
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto('/explorer/chdash_ui?tab=storage');
        await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui', { timeout: 20_000 });
        await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage');
        await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/);
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
        // The former Storage view and mode: the card's Storage tab, the
        // databases overview at the root.
        ['/explorer/_system', /\/explorer$/, 'browse'],
        ['/explorer?mode=storage', /\/explorer$/, 'browse'],
        ['/explorer/_system?database=chdash_ui', /\/explorer\/chdash_ui\?tab=storage$/, 'browse'],
        ['/explorer/chdash_ui?mode=storage', /\/explorer\/chdash_ui\?tab=storage$/, 'browse'],
        ['/explorer/_system?database=chdash_ui&table=weather_observations', /\/explorer\/chdash_ui\/weather_observations\?tab=storage$/, 'browse'],
        ['/explorer/chdash_ui/weather_observations?mode=storage', /\/explorer\/chdash_ui\/weather_observations\?tab=storage$/, 'browse'],
      ];
      for (const [from, to, mode] of cases) {
        await page.goto(from);
        await expect(page, from).toHaveURL(to);
        await expect(page.locator(`#explorerMode${mode[0].toUpperCase()}${mode.slice(1)}`), from).toHaveAttribute('aria-pressed', 'true');
        if (/mode=storage|_system/.test(from)) {
          if (/table=|\/weather_observations/.test(from)) {
            await expect(page.locator('#explorerDetailName'), from).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
            await expect(page.locator('#explorerDetailTabs [aria-selected="true"]'), from).toHaveText('Storage');
          } else if (/chdash_ui/.test(from)) {
            await expect(page.locator('#explorerDetailName'), from).toHaveText('chdash_ui', { timeout: 15_000 });
            await expect(page.locator('#explorerDetailTabs [aria-selected="true"]'), from).toHaveText('Storage');
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
      await expect(views).toBeDisabled();
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
      await expect(page.locator('.explorerTreeDatabase__name').first()).toHaveAttribute('title', /\S/);
      await expect(row).toHaveAttribute('title', /MergeTree · [\d,]+ rows · \d+\.\d MB on disk/);
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
      const picks = { Graph: 'wide_types', Browse: 'weather_observations' };
      for (const [mode, table] of Object.entries(picks)) {
        const tab = page.locator(`#explorerMode${mode}`);
        await tab.click();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute('aria-controls', 'explorerListPane');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect.poll(async () => (await pane.boundingBox()).x).toBeGreaterThanOrEqual(0);
        // The drawer opens under the nav row: the modes stay on top and usable.
        const bar = await page.locator('#explorerModeBar').boundingBox();
        expect((await pane.boundingBox()).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
        const center = await tab.boundingBox();
        expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#explorerModeTabs') != null,
          [center.x + center.width / 2, center.y + center.height / 2])).toBe(true);
        await expandExplorerDatabase(page, 'chdash_ui');
        await pane.locator(`.explorerTreeObject[data-table="${table}"]`).click();
        await expect(pane).toBeHidden();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        await expect(page).toHaveURL(new RegExp(`/explorer/chdash_ui/${table}`));
      }
      // The Storage tab at a phone width: the selection's partitions, without overflow.
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page.locator('#explorerDetailContent .explorerTable--partitions thead th').nth(1)).toHaveText(/^Partition/, { timeout: 15_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // And the database card's Storage tab.
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
