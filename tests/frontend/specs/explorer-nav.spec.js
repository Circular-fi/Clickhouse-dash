import { test, expect } from '@playwright/test';
import { expandExplorerDatabase } from '../helpers/app.js';

// Explorer shell (view tabs, breadcrumb, type chips, mobile drawer), the
// one-line object tree, the shared number formats / in-cell bars and the
// database page object table. Runs on every desktop project (1920 / 1440 /
// 1280); the mobile block pins a phone viewport, and each block runs in both
// themes.

async function openDatabasePage(page, database = 'chdash_ui') {
  await page.goto(`/explorer/${database}?view=browse`);
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

for (const theme of ['dark', 'light']) {
  test.describe(`explorer shell (${theme})`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => { try { localStorage.setItem('chdash.theme', t); } catch (_) {} }, theme);
      await resetExplorerFilters(page);
    });

    test('view tabs switch Catalog / Graph / Storage / Functions and keep the routes', async ({ page }) => {
      await page.goto('/explorer');
      const tabs = page.locator('#explorerViewTabs .explorerViewTab:visible');
      await expect(tabs).toHaveText(['Catalog', 'Graph', 'Storage', 'Functions', 'Operations']);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      // The former section dropdown and Browse/Graph icon menu are gone.
      await expect(page.locator('#explorerSectionSelectButton, #explorerModeSelectButton, #explorerTableSettingsButton')).toHaveCount(0);

      await expandExplorerDatabase(page, 'chdash_ui');
      await page.locator('.explorerTreeObject[data-table="weather_observations"]').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns\?view=browse$/);

      await page.locator('#explorerGraphTab').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns\?view=graph&graph=lineage&depth=1$/);
      await expect(page.locator('#explorerGraphPane')).toBeVisible();
      await expect(page.locator('#explorerCatalogView')).toBeHidden();
      await expect(page.locator('#explorerListPane')).toBeVisible();
      await expect(page.locator('#explorerGraphTab')).toHaveAttribute('aria-selected', 'true');

      // Storage opens at the server scope (its own breadcrumb zooms in).
      await page.locator('#explorerStorageTab').click();
      await expect(page).toHaveURL(/\/explorer\/_system$/);
      await expect(page.locator('#explorerSystemPane')).toBeVisible();
      await expect(page.locator('#explorerListView')).toBeHidden();

      await page.locator('#explorerOpsTab').click();
      await expect(page).toHaveURL(/\/explorer\/_operations$/);
      await expect(page.locator('#explorerOpsPane')).toBeVisible();
      await expect(page.locator('#explorerSystemPane')).toBeHidden();

      await page.locator('#explorerFunctionsTab').click();
      await expect(page).toHaveURL(/\/explorer\/_functions$/);
      await expect(page.locator('#explorerFunctionsPane')).toBeVisible();

      await page.locator('#explorerCatalogTab').click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\/columns\?view=browse$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations');

      // History walks back through the views.
      await page.goBack();
      await expect(page).toHaveURL(/\/explorer\/_functions$/);
      await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');

      // Arrow keys move between tabs.
      await page.locator('#explorerFunctionsTab').focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('#explorerOpsTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerOpsTab')).toBeFocused();
    });

    test('operations disabled by the server: no tab and the route falls back to Catalog', async ({ page }) => {
      await page.route(/\/api\/version(?:\?|$)/, async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        json.features = json.features || {};
        json.features.explorer = { ...(json.features.explorer || {}), operations: { enabled: false } };
        await route.fulfill({ response, json });
      });
      await page.goto('/explorer/_operations');
      await expect(page.locator('#explorerOpsTab')).toBeHidden();
      await expect(page).toHaveURL(/\/explorer\?view=browse$/);
      await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#explorerOpsPane')).toBeHidden();
    });

    test('breadcrumb shows host > database > table and navigates up', async ({ page }) => {
      await page.goto('/explorer/chdash_ui/weather_observations/columns?view=browse');
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
      const crumbs = page.locator('#explorerBreadcrumb .explorerBreadcrumb__item');
      await expect(crumbs).toHaveText([/\S/, 'chdash_ui', 'weather_observations']);
      await expect(crumbs.last()).toHaveAttribute('aria-current', 'location');
      await crumbs.nth(1).click();
      await expect(page).toHaveURL(/\/explorer\/chdash_ui\?view=browse$/);
      await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui');
      await expect(crumbs).toHaveCount(2);
      await crumbs.first().click();
      await expect(page).toHaveURL(/\/explorer\?view=browse$/);
      await expect(crumbs).toHaveCount(1);
      await expect(page.locator('#explorerEmptyState')).toBeVisible();
    });

    test('type chips filter the tree, lock the selected type and persist', async ({ page }) => {
      await page.goto('/explorer/chdash_ui?view=browse');
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
      await page.goto('/explorer/chdash_ui/valid_weather_observations/columns?view=browse');
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
      await page.goto('/explorer?view=browse');
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
      const formats = await page.goto('/explorer').then(() => page.waitForFunction(() => window.ChDash?.explorerFormat)).then(() => page.evaluate(() => {
        const f = window.ChDash.explorerFormat;
        return {
          int: f.fmtInt(120064), compact: f.fmtCompactInt(120064), million: f.fmtCompactInt(3_250_000), small: f.fmtCompactInt(999),
          zero: f.fmtBytes(0), bytes: f.fmtBytes(205), kb: f.fmtBytes(1740), mb: f.fmtBytes(10.3 * 1024 * 1024), carry: f.fmtBytes(1024 * 1024 - 1),
          storage: f.fmtStorageBytes(10.3 * 1024 * 1024), missing: f.fmtBytes(null), missingInt: f.fmtInt(undefined), rate: f.fmtRate(120064, 'rows/s'),
          percent: f.fmtPercent(0.05),
        };
      }));
      expect(formats).toEqual({
        int: '120,064', compact: '120.1K', million: '3.3M', small: '999',
        zero: '0 B', bytes: '205 B', kb: '1.7 KB', mb: '10.3 MB', carry: '1.0 MB',
        storage: '10.3 MB', missing: '—', missingInt: '—', rate: '120.1K rows/s',
        percent: '<0.1%',
      });

      await openDatabasePage(page);
      const objects = page.locator('#explorerDatabaseObjects');
      const weather = objects.locator('tbody tr[data-table="weather_observations"]');
      // Rows are grouped (B4), bytes carry one decimal and a unit.
      await expect(weather.locator('td').nth(3)).toHaveText(/^\d{1,3}(,\d{3})+$/);
      await expect(weather.locator('td').nth(4)).toHaveText(/^\d+\.\d MB$/);
      // In-cell bars: normalised to the column max, ~35% fill in both themes (B6).
      const size = weather.locator('td').nth(4);
      expect(await size.evaluate((td) => td.style.getPropertyValue('--bar-pct'))).toBe('100%');
      const alpha = await size.evaluate((td) => getComputedStyle(td).getPropertyValue('--explorer-bar-alpha').trim());
      expect(alpha).toBe('35%');
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
      await page.goto('/explorer/chdash_ui/weather_observations/columns?view=graph&graph=storage');
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

      // Tabs and breadcrumb fit the phone width.
      const tabs = await page.locator('#explorerViewTabs').boundingBox();
      expect(tabs.x + tabs.width).toBeLessThanOrEqual(390);
      await expect(page.locator('#explorerBreadcrumb .explorerBreadcrumb__item')).toHaveCount(3);
      // Views without a side panel hide the drawer button.
      await page.locator('#explorerStorageTab').click();
      await expect(toggle).toBeHidden();
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
      const response = await route.fetch();
      const json = await response.json();
      json.databases = [...new Set([...(json.databases || []), name])].sort();
      await route.fulfill({ response, json });
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
    await expect(page).toHaveURL(/\/explorer(\?view=browse)?$/);
    await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
  });

  test('a database named functions opens as a database', async ({ page }) => {
    await withDatabase(page, 'functions');
    await page.goto('/explorer/functions');
    await expect(page.locator('#explorerDetailName')).toHaveText('functions', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/explorer\/functions(\?view=browse)?$/);
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
    await expect(page).toHaveURL(/\/explorer\/databases(\?view=browse)?$/);
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
    await page.goto('/explorer/chdash_ui/weather_observations/ddl?view=browse');
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
