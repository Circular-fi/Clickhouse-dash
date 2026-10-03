import { test, expect } from '@playwright/test';
import { horizontalOverflow } from '../helpers/app.js';

// The Explorer Monitoring view (docs/explorer.md "Monitoring"): a view tab of
// its own, underlined section tabs (Overview, Activity), its addresses and
// Back / Forward, the former /explorer/_operations, the lazy module group,
// and the degraded states from mocked answers (single node, no Keeper, a
// panel the system account may not read).

const tabs = (page) => page.locator('.explorerMonitor__tabs [role="tab"]');
const selectedSection = (page) => page.locator('.explorerMonitor__tabs [role="tab"][aria-selected="true"]');

async function openOverview(page) {
  await page.goto('/explorer/_monitoring');
  await expect(page.locator('#explorerMonitorTopology')).toBeVisible({ timeout: 20_000 });
}

// The real answer (fetched first), changed by `edit`.
async function routeOverview(page, edit) {
  await page.route(/\/api\/explorer\/monitor\/overview\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    edit(json);
    await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
  });
}

test('the Monitoring tab opens the Overview of this server', async ({ page }) => {
  await page.goto('/explorer');
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#explorerViewTabs .viewTab:visible')).toHaveText(['Catalog', 'Functions', 'Monitoring']);
  // The Catalog does not load the view's modules.
  expect(await page.evaluate(() => !!window.ChDash.explorerMonitor || !!window.ChDash.explorerOps)).toBe(false);
  await page.locator('#explorerMonitorTab').click();
  await expect(page).toHaveURL(/\/explorer\/_monitoring$/);
  await expect(page.locator('#explorerMonitorTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerMonitorPane')).toBeVisible();
  await expect(page.locator('#explorerListView')).toBeHidden();
  await expect(page.locator('#explorerModeBar')).toBeHidden();
  await expect(tabs(page)).toHaveText(['Overview', 'Activity']);
  await expect(selectedSection(page)).toHaveText('Overview');

  // The bar names the server the figures come from.
  await expect(page.locator('#explorerMonitorPanel-overview .explorerMonitorBar__meta')).toContainText(/This server: \S+ · ClickHouse \d+\.\d+/, { timeout: 20_000 });
  const tiles = page.locator('#explorerMonitorOverview .explorerMonitorTiles > .statTile');
  await expect(tiles).toHaveCount(8);
  await expect(tiles.locator('.statTile__label')).toHaveText(['Uptime', 'CPU', 'Memory', 'Load', 'Queries', 'Connections', 'Parts', 'Delayed inserts']);
  await expect(page.locator('[data-tile="uptime"] .statTile__value')).toHaveText(/^\d+ (?:s|min|h|d)/);
  await expect(page.locator('[data-tile="memory"] .statTile__sub')).toContainText(/of \d+(?:\.\d)? [KMGT]?B/);

  // Topology: the two replicas of chdash_cluster, this server marked.
  const cluster = page.locator('#explorerMonitorTopology .explorerMonitorCluster[data-cluster="chdash_cluster"]');
  await expect(cluster.locator('.explorerMonitorCluster__shape')).toHaveText('1 shard × 2 replicas');
  await expect(cluster.locator('tbody tr')).toHaveCount(2);
  await expect(cluster.locator('tbody tr.is-local')).toHaveCount(1);
  await expect(cluster.locator('tbody tr.is-local')).toContainText('this server');
  await expect(page.locator('#explorerMonitorTopology .explorerMonitorCard__note')).toContainText('"default": this server only');

  // Keeper (embedded in the test server) and the replicated fixture.
  await expect(page.locator('#explorerMonitorKeeper .explorerMonitorCard__head')).toContainText('Connected');
  await expect(page.locator('#explorerMonitorKeeper .kvList')).toContainText(/Leader|Follower|Standalone/);
  const replication = page.locator('#explorerMonitorReplication');
  await expect(replication).toContainText(/\d+ replicated tables/);
  await expect(replication.locator('[data-tile="status"] .statTile__value')).toHaveText('Healthy');
});

test('section tabs, deep links and Back / Forward', async ({ page }) => {
  await openOverview(page);
  await page.locator('#explorerMonitorTab-activity').click();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/activity$/);
  await expect(selectedSection(page)).toHaveText('Activity');
  await expect(page.locator('#explorerMonitorPanel-overview')).toBeHidden();
  await expect(page.locator('#explorerMonitorPanel-activity .explorerOpsSection').first()).toBeVisible({ timeout: 20_000 });
  // Arrow keys move between the sections (the shared tab behaviour).
  await page.locator('#explorerMonitorTab-activity').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\/explorer\/_monitoring$/);
  await expect(selectedSection(page)).toHaveText('Overview');

  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/activity$/);
  await expect(selectedSection(page)).toHaveText('Activity');
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_monitoring$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await expect(page.locator('#explorerMonitorPanel-overview')).toBeVisible();
  await page.goForward();
  await expect(selectedSection(page)).toHaveText('Activity');

  // Back to the Catalog and forward again.
  await page.locator('#explorerCatalogTab').click();
  await expect(page).toHaveURL(/\/explorer$/);
  await expect(page.locator('#explorerMonitorPane')).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/activity$/);
  await expect(page.locator('#explorerMonitorPane')).toBeVisible();

  // A deep link opens its section; a section this build does not have yet
  // falls back to Overview (the address replaced).
  await page.goto('/explorer/_monitoring/activity');
  await expect(selectedSection(page)).toHaveText('Activity', { timeout: 20_000 });
  await page.goto('/explorer/_monitoring/no-such-section');
  await expect(page).toHaveURL(/\/explorer\/_monitoring$/, { timeout: 20_000 });
  await expect(selectedSection(page)).toHaveText('Overview');
});

test('/explorer/_operations opens the Activity section', async ({ page }) => {
  await page.goto('/explorer/_operations');
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/activity$/, { timeout: 20_000 });
  await expect(page.locator('#explorerMonitorTab')).toHaveAttribute('aria-selected', 'true');
  await expect(selectedSection(page)).toHaveText('Activity');
  const replicas = page.locator('#explorerOpsReplicas');
  await expect(replicas).toContainText('replicated_events', { timeout: 20_000 });
  // The Server operations title gives way to the section tab.
  await expect(page.locator('.explorerOpsView__title')).toBeHidden();
  // One Auto-refresh choice for Overview and Activity.
  await page.locator('#explorerOpsAutoRefresh').check();
  await page.locator('#explorerMonitorTab-overview').click();
  await expect(page.locator('#explorerMonitorAutoRefresh-overview')).toBeChecked();
  await page.locator('#explorerMonitorAutoRefresh-overview').uncheck();
  await page.locator('#explorerMonitorTab-activity').click();
  await expect(page.locator('#explorerOpsAutoRefresh')).not.toBeChecked();
  // Object names open the table card in the Catalog.
  await replicas.locator('.explorerOpsTable__link', { hasText: 'replicated_events' }).first().click();
  await expect(page).toHaveURL(/\/explorer\/chdash_repl\/replicated_events$/);
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
});

test('a single server without Keeper says so instead of drawing empty cards', async ({ page }) => {
  await routeOverview(page, (json) => {
    json.topology.nodes = [{ cluster: 'default', shard_num: 1, shard_weight: 1, replica_num: 1, host_name: 'localhost', host_address: '127.0.0.1', port: 9000, is_local: true, errors_count: 0, slowdowns_count: 0, estimated_recovery_time: 0 }];
    for (const name of Object.keys(json.metrics)) if (/^(Keeper|ZooKeeper)/.test(name)) delete json.metrics[name];
    json.replication = { ...json.replication, tables: 0 };
  });
  await page.route(/\/api\/explorer\/ops\/keeper\?/, (route) => route.fulfill({
    json: { version: 1, host_id: 'local', generated_at_ms: Date.now(), stale: false, configured: false, unavailable_sections: [], connections: [], metrics: { ZooKeeperSession: 0 }, events: {}, average_wait_ms: null },
    headers: { 'Cache-Control': 'no-store' },
  }));
  await openOverview(page);
  const topology = page.locator('#explorerMonitorTopology');
  await expect(topology.locator('.uiState__title')).toHaveText('Single server, no multi-replica cluster');
  await expect(topology).toContainText('"default": this server only.');
  await expect(topology.locator('table')).toHaveCount(0);
  await expect(page.locator('#explorerMonitorNoKeeper .uiState__title')).toHaveText('No Keeper configured');
  await expect(page.locator('#explorerMonitorKeeper .badge')).toHaveCount(0);
  // No replicated table: no replication card.
  await expect(page.locator('#explorerMonitorReplication')).toHaveCount(0);
});

test('a panel the system account may not read shows why and the GRANT to run', async ({ page }) => {
  const grant = 'GRANT SELECT ON system.clusters TO chdash_system';
  await routeOverview(page, (json) => {
    json.topology.nodes = [];
    json.unavailable_panels = [{
      panel: 'topology', table: 'clusters', reason: 'not_granted', hint: grant,
      message: 'Code: 497. DB::Exception: chdash_system: Not enough privileges. (ACCESS_DENIED)',
    }];
  });
  await openOverview(page);
  const issue = page.locator('#explorerMonitorTopology .explorerMonitorIssue[data-reason="not_granted"]');
  await expect(issue).toBeVisible();
  await expect(issue.locator('.badge')).toHaveText('Not granted');
  await expect(issue).toContainText('The system account cannot read system.clusters.');
  await expect(issue.locator('.explorerMonitorIssue__code')).toHaveText(grant);
  await expect(issue.locator('.explorerMonitorIssue__copy')).toHaveAttribute('aria-label', 'Copy the GRANT statement');
  // Only that panel degrades.
  await expect(page.locator('#explorerMonitorOverview .explorerMonitorTiles > .statTile')).toHaveCount(8);
  await expect(page.locator('#explorerMonitorKeeper')).toBeVisible();
});

test('the tab follows explorer.monitoring.enabled', async ({ page }) => {
  await page.route(/\/api\/version$/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.features.explorer.monitoring.enabled = false;
    await route.fulfill({ response, json });
  });
  await page.goto('/explorer/_monitoring/activity');
  await expect(page).toHaveURL(/\/explorer$/, { timeout: 20_000 });
  await expect(page.locator('#explorerMonitorTab')).toBeHidden();
  await expect(page.locator('#explorerViewTabs .viewTab:visible')).toHaveText(['Catalog', 'Functions']);
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
});

for (const width of [390, 360]) {
  test.describe(`phone ${width}`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`Overview and Activity fit the viewport without sideways overflow at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      // Neither the page nor the Monitoring pane scrolls sideways: wide
      // tables scroll in their own wrap.
      const paneOverflow = () => page.locator('#explorerMonitorPane').evaluate((el) => el.scrollWidth - el.clientWidth);
      await openOverview(page);
      await expect(page.locator('#explorerMonitorReplication')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      // Two tiles a row; the topology keeps its key columns.
      const boxes = await page.locator('#explorerMonitorOverview .explorerMonitorTiles > .statTile').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(new Set(boxes).size).toBe(4);
      await expect(page.locator('#explorerMonitorTopology thead th:visible')).toHaveText(['Shard', 'Replica', 'Host', 'Errors']);
      await page.locator('#explorerMonitorTab-activity').click();
      await expect(page.locator('.explorerOpsSection').first()).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
    });
  });
}
