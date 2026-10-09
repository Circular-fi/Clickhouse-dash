import { test, expect } from '@playwright/test';
import { horizontalOverflow, smallTouchTargets } from '../helpers/app.js';
import { xLabelCollisions, xRepeatedYears } from '../helpers/charts.js';

// The System page (docs/system.md): its entry in the page switcher, its
// underlined section tabs (Overview, Queries, Disks), its addresses and Back /
// Forward, the redirects of the Explorer's former Monitoring and Server
// operations addresses, the merged Overview (tiles, databases, cluster,
// performance, activity, top to bottom), and the
// degraded states from mocked answers (single node, no Keeper, a panel the
// system account may not read, an answer that fails).

// The sections are three pages of their own: the row is links, the current page marked.
const tabs = (page) => page.locator('.systemPage__tabs a');
const selectedSection = (page) => page.locator('.systemPage__tabs a[aria-current="page"]');
const panel = (page, section) => page.locator(`#systemPanel-${section}`);
const tiles = (page) => page.locator('#systemServer .systemTiles > .statTile');

async function openOverview(page, path = '/system') {
  await page.goto(path);
  await expect(page.locator('#systemTopology')).toBeVisible({ timeout: 20_000 });
}

// The real answer (fetched first), changed by `edit`.
function routeJson(pattern) {
  return async (page, edit) => {
    await page.route(pattern, async (route) => {
      try {
        const response = await route.fetch();
        const json = await response.json();
        edit(json);
        await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
      } catch {
        // The page or the test is gone.
      }
    });
  };
}
const routeOverview = routeJson(/\/api\/system\/overview\?/);

test('the page switcher opens the System page: Overview, Queries, Disks', async ({ page }) => {
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
  await page.locator('#pageSelectButton').click();
  const menu = page.locator('#pageSelectMenu');
  await expect(menu).toBeVisible();
  // The menu lists the other pages.
  await expect(menu.locator('.themeSelect__option:visible')).toHaveText(['Query', 'Observability', 'System']);
  await menu.locator('#navSystemButton').click();
  await expect(page).toHaveURL(/\/system$/, { timeout: 20_000 });
  await expect(page).toHaveTitle('ClickHouse Dash · System');
  await expect(page.locator('#pageSelectButton')).toHaveText('System');
  await expect(page.locator('#navSystemButton')).toHaveAttribute('aria-selected', 'true');
  await expect(tabs(page)).toHaveText(['Overview', 'Queries', 'Disks']);
  await expect(selectedSection(page)).toHaveText('Overview');
  await expect(panel(page, 'overview')).toBeVisible();
  // From the System page, the other pages are a click away.
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Query', 'Explorer', 'Observability']);
  await page.locator('#navExplorerButton').click();
  await expect(page).toHaveURL(/\/explorer\/catalog$/, { timeout: 20_000 });
});

test('the Explorer shows only Catalog | Functions and loads no System module', async ({ page }) => {
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#explorerViewTabs .contentTabs__tab')).toHaveText(['Catalog', 'Functions']);
  await expect(page.locator('#explorerMonitorTab, #explorerMonitorPane, #explorerOpsTab, #explorerOpsPane')).toHaveCount(0);
  expect(await page.evaluate(() => !!window.ChDash.systemView || !!window.ChDash.explorerMonitor || !!window.ChDash.explorerOps)).toBe(false);
});

test('the Overview runs top to bottom: tiles, databases, cluster, performance, activity, and no caption line', async ({ page }) => {
  await openOverview(page);
  // The parts in order, one under the other.
  const order = ['#systemServer', '#systemPart-databases', '#systemPart-cluster', '#systemPart-performance', '#systemPart-activity'];
  for (const selector of order) await expect(page.locator(selector)).toBeAttached();
  const tops = await page.evaluate((list) => list.map((selector) => document.querySelector(selector).getBoundingClientRect().top), order);
  for (let i = 1; i < tops.length; i++) expect(tops[i], order[i]).toBeGreaterThan(tops[i - 1]);
  await expect(page.locator('.pagePart__title')).toHaveText(['Databases', 'Cluster', 'Performance', 'Activity']);
  // No "This server: ... · Updated ..." line in any section: the header names the host.
  for (const section of ['overview', 'queries', 'disks']) {
    if (section !== 'overview') await page.locator(`#systemTab-${section}`).click();
    await expect(panel(page, section)).toBeVisible();
    await expect(page.locator('.systemBar__meta, .explorerMonitorBar__meta')).toHaveCount(0);
    await expect(page.locator('.systemPage')).not.toContainText(/This server:|Updated \d/);
  }
  await page.locator('#systemTab-overview').click();
  await expect(page.locator('#hostPickerText')).toHaveText(/\S/);

  // Eight tiles, each figure once: the charts below never repeat them.
  await expect(tiles(page)).toHaveCount(8);
  await expect(tiles(page).locator('.statTile__label')).toHaveText(['Uptime', 'CPU', 'Memory', 'Load', 'Queries', 'Connections', 'Parts', 'Delayed inserts']);
  await expect(page.locator('[data-tile="uptime"] .statTile__value')).toHaveText(/^\d+ (?:s|min|h|d)/);
  await expect(page.locator('[data-tile="memory"] .statTile__sub')).toContainText(/of \d+(?:\.\d)? [KMGT]?B/);
  await expect(page.locator('.systemTiles')).toHaveCount(1);

  // Topology: the two replicas of chdash_cluster, this server marked.
  const cluster = page.locator('#systemTopology .systemCluster[data-cluster="chdash_cluster"]');
  await expect(cluster.locator('.systemCluster__shape')).toHaveText('1 shard × 2 replicas');
  await expect(cluster.locator('tbody tr')).toHaveCount(2);
  await expect(cluster.locator('tbody tr.is-local')).toHaveCount(1);
  await expect(cluster.locator('tbody tr.is-local')).toContainText('this server');
  await expect(page.locator('#systemTopology .systemCard__note')).toContainText('"default": this server only');

  // One Keeper card (embedded in the test server), the Activity has none.
  const keeper = page.locator('#systemKeeper');
  await expect(keeper.locator('.systemCard__head')).toContainText('Connected');
  await expect(keeper.locator('.kvList')).toContainText(/Leader|Follower|Standalone/);
  await expect(keeper.locator('[data-row="latency"]')).toContainText(/\d+(?:\.\d+)? (?:ns|\u00b5s|ms|s) average/);
  await expect(keeper.locator('[data-row="requests"]')).toContainText('in flight');
  await expect(page.locator('#systemKeeper')).toHaveCount(1);
  await expect(page.locator('.systemActivitySection[data-section="keeper"]')).toHaveCount(0);
  const replication = page.locator('#systemReplication');
  await expect(replication).toContainText(/\d+ replicated tables/);
  await expect(replication.locator('[data-tile="status"] .statTile__value')).toHaveText('Healthy');
  // Two balanced columns: the replication summary under the topology, Keeper beside them.
  const [topologyBox, replicationBox, keeperBox] = await Promise.all(['#systemTopology', '#systemReplication', '#systemKeeper'].map((sel) => page.locator(sel).boundingBox()));
  expect(Math.abs(replicationBox.x - topologyBox.x)).toBeLessThanOrEqual(1);
  expect(replicationBox.y).toBeGreaterThanOrEqual(topologyBox.y + topologyBox.height);
  expect(keeperBox.x).toBeGreaterThanOrEqual(topologyBox.x + topologyBox.width);
  // No dead area under the shorter column: the two columns end within a card's height.
  expect(Math.abs((replicationBox.y + replicationBox.height) - (keeperBox.y + keeperBox.height))).toBeLessThan(160);

  // Performance and Activity draw on the same page.
  await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemActivityReplicas')).toContainText('replicated_events', { timeout: 20_000 });
  // The Replication card has no "Show the tables" link: the replicas are the Activity's, further down.
  await expect(page.locator('#systemReplicationTables')).toHaveCount(0);
  await expect(page.locator('#systemReplication .systemCard__head button')).toHaveCount(0);
});

test('the treemap of the databases draws their bytes on disk and a database opens its Explorer card', async ({ page }) => {
  // Sizes that spread (no database holds most of the bytes): the treemap.
  await routeJson(/\/api\/system\/disks\?/)(page, (json) => {
    const names = [...new Set((json.usage?.rows || []).map((row) => row.database))];
    for (const row of json.usage?.rows || []) row.bytes = 1_000_000_000 + names.indexOf(row.database) * 100_000_000;
  });
  await openOverview(page);
  const map = page.locator('#systemDatabaseMap');
  const node = map.locator('.explorerTreemap__node[data-kind="database"][data-path]').first();
  await expect(node).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemDatabasesCount')).toHaveText(/^\d+ databases? · [\d.]+ [KMGT]?B on disk$/);
  await expect(page.locator('#systemDatabasesFoot')).toContainText('Bytes on disk of the active parts of the databases the runner can see');
  // The sizes are the disks answer's, summed by database.
  const disks = await page.evaluate(async () => (await fetch('/api/system/disks?host_id=' + encodeURIComponent(window.ChDash.state.selectedHostId))).json());
  const totals = new Map();
  for (const row of disks.usage.rows) totals.set(row.database, (totals.get(row.database) || 0) + Number(row.bytes));
  const name = await node.getAttribute('data-name');
  expect(Number(await node.getAttribute('data-size'))).toBe(totals.get(name));
  // A database counts its parts, not tables.
  await expect(node).toHaveAttribute('aria-label', /\d+ parts?/);
  // One height for every size band (--sizemap-h).
  expect((await map.boundingBox()).height).toBeLessThanOrEqual(182);
  await node.click();
  await expect(page).toHaveURL(new RegExp(`/explorer/catalog/${encodeURIComponent(name)}$`), { timeout: 20_000 });
});

test('one database holding most of the bytes: still the treemap (never the strip), capped, Others on its chip and in its legend', async ({ page }) => {
  await routeJson(/\/api\/system\/disks\?/)(page, (json) => {
    for (const row of json.usage?.rows || []) row.bytes = row.database === 'chdash_ui' ? 50_000_000_000 : 1_000_000;
  });
  await openOverview(page);
  const map = page.locator('#systemDatabaseMap');
  await expect(map.locator('.explorerTreemap__node[data-kind="database"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemPart-databases .explorerStorageStrip')).toHaveCount(0);
  await expect(page.locator('#systemPart-databases .explorerTreemapBand')).toHaveAttribute('data-mode', 'map');
  const box = await map.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(158);
  expect(box.height).toBeLessThanOrEqual(182);
  const others = map.locator('.explorerTreemap__node[data-kind="other"]');
  await expect(others.locator('.explorerTreemap__label')).toContainText('Others');
  await expect(page.locator('#systemPart-databases .explorerTreemapLegend__item--other')).toContainText(/Others/);
  await expect(page.locator('#systemDatabasesFoot')).toContainText('Bytes on disk of the active parts');
  const segment = map.locator('.explorerTreemap__node[data-kind="database"][data-database="chdash_ui"]');
  const name = await segment.getAttribute('data-database');
  await segment.click();
  await expect(page).toHaveURL(new RegExp(`/explorer/catalog/${encodeURIComponent(name)}$`), { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#explorerDetailName')).toContainText(name, { timeout: 20_000 });
});

test('the sections are pages of their own: links, deep links and Back / Forward', async ({ page }) => {
  await openOverview(page);
  await page.locator('#systemTab-disks').click();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  // Only this section's panel and filter bar are in the page.
  await expect(panel(page, 'overview')).toHaveCount(0);
  await expect(page.locator('#systemDiskCards .systemDisk').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemBar-disks')).toBeVisible();
  await expect(page.locator('#systemBar-overview')).toHaveCount(0);
  // The links are plain links, followed one after the other.
  await page.locator('#systemTab-overview').click();
  await expect(page).toHaveURL(/\/system$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await page.locator('#systemTab-queries').click();
  await expect(page).toHaveURL(/\/system\/queries$/);
  await expect(selectedSection(page)).toHaveText('Queries');
  await page.goBack();
  await expect(page).toHaveURL(/\/system$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await page.goBack();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  await page.goForward();
  await expect(selectedSection(page)).toHaveText('Overview');
  await expect(panel(page, 'overview')).toBeVisible();

  // A deep link opens its section; an unknown one is the Overview (the server redirects it,
  // the query string kept).
  await page.goto('/system/queries');
  await expect(selectedSection(page)).toHaveText('Queries', { timeout: 20_000 });
  await page.goto('/system/no-such-section?from=now-6h&to=now');
  await expect(page).toHaveURL(/\/system\?from=now-6h&to=now$/, { timeout: 20_000 });
  await expect(selectedSection(page)).toHaveText('Overview');
});

test('the former Explorer addresses redirect to the matching System address, parameters kept', async ({ page }) => {
  await page.goto('/explorer/_monitoring/queries?from=now-6h&to=now&sort=calls');
  await expect(page).toHaveURL(/\/system\/queries\?from=now-6h&to=now&sort=calls$/, { timeout: 20_000 });
  await expect(selectedSection(page)).toHaveText('Queries');
  await expect(page.locator('#systemQueriesRangeButton')).toHaveText('Time range · Last 6 hours');
  await expect(page.locator('#systemQueriesTable th[data-col="calls"]')).toHaveAttribute('aria-sort', 'descending', { timeout: 30_000 });
  await page.goto('/explorer/_monitoring/disks');
  await expect(page).toHaveURL(/\/system\/disks$/, { timeout: 20_000 });
  await expect(selectedSection(page)).toHaveText('Disks');
  // Performance: the Overview, its charts in view, the range kept.
  await page.goto('/explorer/_monitoring/performance?from=now-3h&to=now');
  await expect(page).toHaveURL(/\/system\?from=now-3h&to=now#performance$/, { timeout: 20_000 });
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Time range · Last 3 hours');
  // It stays in view while the parts above it fill in.
  await expect(page.locator('#systemDatabaseMap .explorerTreemap__node, #systemDatabaseStrip .explorerStorageStrip__segment').first()).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('#systemTopology')).toBeAttached({ timeout: 20_000 });
  await expect(page.locator('#systemPart-performance')).toBeInViewport({ timeout: 20_000 });
  // The v2.14.0 Server operations and the former Activity: the Overview's Activity.
  for (const path of ['/explorer/_operations', '/explorer/_monitoring/activity']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/system#activity$/, { timeout: 20_000 });
    await expect(selectedSection(page)).toHaveText('Overview');
    await expect(page.locator('#systemActivityReplicas')).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('#systemPart-activity')).toBeInViewport({ timeout: 20_000 });
  }
  await page.goto('/explorer/_monitoring');
  await expect(page).toHaveURL(/\/system$/, { timeout: 20_000 });
});

test('the Activity lists the replicas and its tables open their Explorer card', async ({ page }) => {
  await openOverview(page);
  const replicas = page.locator('#systemActivityReplicas');
  await expect(replicas).toContainText('replicated_events', { timeout: 20_000 });
  await expect(page.locator('#systemActivityQuiet')).toContainText('No ');
  await replicas.locator('.systemActivityTable__link', { hasText: 'replicated_events' }).first().click();
  await expect(page).toHaveURL(/\/explorer\/catalog\/chdash_repl\/replicated_events$/, { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-current', 'page');
});

test('the Activity reports replica health and lists problems first; the Keeper card the session', async ({ page }) => {
  await openOverview(page);
  const replicas = page.locator('#systemActivityReplicas');
  await expect(replicas).toContainText('replicated_events', { timeout: 15_000 });
  const row = replicas.locator('tbody tr').filter({ hasText: 'replicated_events' }).first();
  await expect(row).toContainText('Healthy');
  await expect(row).toContainText('2 / 2');
  const keeper = page.locator('#systemKeeper');
  await expect(keeper).toContainText('Connected');
  await expect(keeper.locator('[data-row="latency"]')).toContainText(/\d+(?:\.\d+)? (?:ns|\u00b5s|ms|s) average/);

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
  await page.route(/\/api\/system\/activity\?/, (route) => route.fulfill({ json: activity, headers: { 'Cache-Control': 'no-store' } }));
  await page.locator('#systemRefresh-overview').click();
  await expect(page.locator('#systemActivityMutations')).toContainText('FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
  await expect(page.locator('#systemActivityMutations')).toContainText('Part all_1_1_0: Code: 395.');
  await expect(page.locator('#systemActivityReplicas tbody tr').first()).toContainText('Read-only');
  await expect(page.locator('#systemActivityReplicas tbody tr').first()).toContainText('1 / 2');
  // 3,700 s: two whole units, rounded (ns.format.duration).
  await expect(page.locator('#systemActivityReplicas tbody tr').first()).toContainText('1 h 2 min');
  await expect(page.locator('#systemActivityReplicationQueue')).toContainText('GET_PART, MERGE_PARTS');
  await expect(page.locator('#systemActivityDistribution')).toContainText('Retrying');
  await expect(page.locator('#systemActivityMerges')).toContainText('42%');
  await expect(page.locator('.systemActivitySection[data-section="merges"]')).toContainText('first 200 shown');
  // Sections with problems come before the quiet ones (merges).
  const order = await page.locator('#systemActivity > .systemActivitySection').evaluateAll((els) => els.map((el) => el.dataset.section));
  expect(order.indexOf('replicas')).toBeLessThan(order.indexOf('merges'));
  expect(order.indexOf('mutations')).toBeLessThan(order.indexOf('merges'));
  await expect(page.locator('#systemActivityQuiet')).toHaveCount(0);

  // Object names open the table card.
  await page.locator('#systemActivityMutations .systemActivityTable__link', { hasText: 'wide_types' }).click();
  await expect(page).toHaveURL(/\/explorer\/catalog\/chdash_ui\/wide_types$/);
});

test('no live refresh: no Live / Auto-refresh control, and no request fires on a timer after load, even a stored former choice', async ({ page }) => {
  // A browser that stored the former Auto-refresh choice: ignored, then removed.
  await page.addInitScript(() => { if (!sessionStorage.getItem('sl.seeded')) { sessionStorage.setItem('sl.seeded', '1'); localStorage.setItem('chdash.system.autoRefresh', '1'); } });
  await page.clock.install();
  const counts = { overview: 0, keeper: 0, activity: 0, series: 0, disks: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/system/overview?')) counts.overview += 1;
    else if (url.includes('/api/system/keeper?')) counts.keeper += 1;
    else if (url.includes('/api/system/activity?')) counts.activity += 1;
    else if (url.includes('/api/system/series?')) counts.series += 1;
    else if (url.includes('/api/system/disks?')) counts.disks += 1;
  });
  // A link with a live= / auto= parameter (none was ever written) is tolerated.
  await openOverview(page, '/system?live=1&auto=1');
  await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  const bar = page.locator('#systemBar-overview');
  await expect(bar.locator('[id^="systemAutoRefresh"], [id^="systemLive"], .obsFilterBar__secondary, .obsFilterBar__toggleDot')).toHaveCount(0);
  await expect(bar).not.toContainText(/auto-refresh|live/i);
  expect(await page.evaluate(() => localStorage.getItem('chdash.system.autoRefresh'))).toBeNull();
  await page.waitForTimeout(500);
  // Five minutes on the clock, the tab visible, then hidden and back: nothing reads.
  const before = { ...counts };
  for (let i = 0; i < 10; i++) {
    await page.clock.runFor(30_000);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  expect(counts).toEqual(before);
  // The refresh button reads every part again.
  await page.locator('#systemRefresh-overview').click();
  await expect.poll(() => counts.overview).toBeGreaterThan(before.overview);
  await expect.poll(() => counts.series).toBeGreaterThan(before.series);
});

test('a single server without Keeper says so instead of drawing empty cards', async ({ page }) => {
  await routeOverview(page, (json) => {
    json.topology.nodes = [{ cluster: 'default', shard_num: 1, shard_weight: 1, replica_num: 1, host_name: 'localhost', host_address: '127.0.0.1', port: 9000, is_local: true, errors_count: 0, slowdowns_count: 0, estimated_recovery_time: 0 }];
    for (const name of Object.keys(json.metrics)) if (/^(Keeper|ZooKeeper)/.test(name)) delete json.metrics[name];
    json.replication = { ...json.replication, tables: 0 };
  });
  await page.route(/\/api\/system\/keeper\?/, (route) => route.fulfill({
    json: { version: 1, host_id: 'local', generated_at_ms: Date.now(), stale: false, configured: false, unavailable_sections: [], connections: [], metrics: { ZooKeeperSession: 0 }, events: {}, average_wait_ms: null },
    headers: { 'Cache-Control': 'no-store' },
  }));
  await openOverview(page);
  const topology = page.locator('#systemTopology');
  await expect(topology.locator('.uiState__title')).toHaveText('Single server, no multi-replica cluster');
  await expect(topology).toContainText('"default": this server only.');
  await expect(topology.locator('table')).toHaveCount(0);
  await expect(page.locator('#systemNoKeeper .uiState__title')).toHaveText('No Keeper configured');
  await expect(page.locator('#systemKeeper .badge')).toHaveCount(0);
  // No replicated table: no replication card.
  await expect(page.locator('#systemReplication')).toHaveCount(0);
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
  const issue = page.locator('#systemTopology .systemIssue[data-reason="not_granted"]');
  await expect(issue).toBeVisible();
  await expect(issue.locator('.badge')).toHaveText('Not granted');
  await expect(issue).toContainText('The system account cannot read system.clusters.');
  await expect(issue.locator('.systemIssue__code')).toHaveText(grant);
  await expect(issue.locator('.systemIssue__copy')).toHaveAttribute('aria-label', 'Copy the GRANT statement');
  // Only that panel degrades.
  await expect(tiles(page)).toHaveCount(8);
  await expect(page.locator('#systemKeeper')).toBeVisible();
});

test('each part of the Overview degrades on its own', async ({ page }) => {
  const fail = (status, code) => (route) => route.fulfill({ status, json: { error_code: code, message: `${code} (mocked)` }, headers: { 'Cache-Control': 'no-store' } });
  await page.route(/\/api\/system\/overview\?/, fail(503, 'system_monitor_unavailable'));
  await page.route(/\/api\/system\/activity\?/, fail(503, 'system_activity_unavailable'));
  await page.goto('/system');
  // The tiles and the cluster cards: a banner with Retry, the cluster part gone.
  await expect(page.locator('#systemServer .uiBanner')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemPart-cluster')).toBeHidden();
  await expect(page.locator('#systemActivity .uiBanner')).toBeVisible();
  // The rest draws.
  await expect(page.locator('#systemDatabaseMap .explorerTreemap__node, #systemDatabaseStrip .explorerStorageStrip__segment').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  // Retry once the answer is back.
  await page.unroute(/\/api\/system\/overview\?/);
  await page.locator('#systemServer .uiBanner button').first().click();
  await expect(tiles(page)).toHaveCount(8, { timeout: 20_000 });
  await expect(page.locator('#systemTopology')).toBeVisible();

  // The databases, the charts: each its own state.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(/\/api\/system\/disks\?/, fail(503, 'system_monitor_unavailable'));
  await page.route(/\/api\/system\/series\?/, fail(503, 'system_monitor_unavailable'));
  await page.reload();
  await expect(page.locator('#systemDatabasesNotes .uiBanner')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemDatabaseMap')).toBeHidden();
  await expect(page.locator('#systemPerfNotes .uiBanner')).toBeVisible();
  await expect(tiles(page)).toHaveCount(8, { timeout: 20_000 });
  await expect(page.locator('#systemActivityReplicas')).toBeVisible({ timeout: 20_000 });
  // A usage panel the system account may not read: the databases say so.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await routeJson(/\/api\/system\/disks\?/)(page, (json) => {
    json.usage = { rows: [], disks: {}, truncated: false };
    json.unavailable_panels = [{ panel: 'usage', table: 'parts', reason: 'not_granted', message: 'Code: 497.', hint: 'GRANT SELECT ON system.parts TO chdash_system' }];
  });
  await page.reload();
  await expect(page.locator('#systemDatabasesNotes .systemIssue[data-reason="not_granted"] .systemIssue__code')).toHaveText('GRANT SELECT ON system.parts TO chdash_system', { timeout: 20_000 });
  await expect(page.locator('#systemDatabaseMap')).toBeHidden();
});

test('the page follows system.enabled', async ({ page }) => {
  await page.route(/\/api\/version$/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.features.system.enabled = false;
    await route.fulfill({ response, json });
  });
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#navSystemButton')).toBeHidden();
  // A System page still open when the server turns it off leaves for Query.
  await page.goto('/system');
  await expect(page).toHaveURL(/\/query$/, { timeout: 20_000 });
});

for (const width of [390, 360]) {
  test.describe(`phone ${width}`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`the Overview fits the viewport without sideways overflow at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      // Neither the page nor the section scrolls sideways: wide tables
      // scroll in their own wrap.
      const panelOverflow = () => panel(page, 'overview').evaluate((el) => el.scrollWidth - el.clientWidth);
      await openOverview(page);
      await expect(page.locator('#systemReplication')).toBeVisible();
      await expect(page.locator('#systemActivityReplicas')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await panelOverflow()).toBeLessThanOrEqual(0);
      // The tabs on their own row, the filter bar under them; two tiles a row; the topology keeps its key columns.
      const tabsBox = await page.locator('.systemPage__tabs').boundingBox();
      const bar = await page.locator('#systemBar-overview').boundingBox();
      expect(bar.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1);
      const rows = await tiles(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(new Set(rows).size).toBe(4);
      await expect(page.locator('#systemTopology thead th:visible')).toHaveText(['Shard', 'Replica', 'Host', 'Errors']);
      // 40 px targets: the tabs, refresh, the range (the bar unfolded from its summary line).
      await page.locator('#systemBar-overview .obsFilterSummary').click();
      for (const selector of ['#systemTab-overview', '#systemRefresh-overview', '#systemPerfRangeButton']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(40);
      }
      // A size band cell (treemap rectangle, strip segment) is as large as its share of the data.
      expect(await smallTouchTargets(page, { skip: ['.explorerTreemap__node', '.explorerStorageStrip__segment'] })).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Performance: the Overview's ten charts on the shared engine over /api/system/series.
// The windows are relative to now (the default 1 h, or the server's own
// windows), so a fresh stack with minutes of logs draws as a long-lived one.

const CHARTS = ['queries', 'latency', 'cpu', 'memory', 'merges', 'inserts', 'parts', 'pools', 'reads', 'replication'];
const chartCard = (page, id) => page.locator(`#systemChart-${id}`);
const chartRoot = (page, id) => chartCard(page, id).locator('.chartCore');
// The charts drawn on a plot: a chart at 0 over the whole range (no
// replication delay on a healthy stack) is a one-line card (.is-flat).
const drawnCharts = (page) => page.locator('#systemPerfGrid .systemChart:not([hidden]):not(.is-flat)').evaluateAll((els) => els.map((el) => el.dataset.chart));

// The next series answer whose window spans about `spanMs`.
function seriesOf(page, spanMs) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith('/api/system/series') || url.searchParams.get('panel')) return false;
    const span = Number(url.searchParams.get('to_ms')) - Number(url.searchParams.get('from_ms'));
    return Math.abs(span - spanMs) < 120_000;
  }, { timeout: 30_000 });
}

async function openPerformance(page, query = '') {
  await page.goto(`/system${query}`);
  // The charts sit under the tiles, the databases and the cluster.
  await page.locator('#systemPart-performance').scrollIntoViewIfNeeded();
  await expect(chartRoot(page, 'cpu').locator('canvas')).toBeVisible({ timeout: 20_000 });
  await expect(chartRoot(page, 'cpu')).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
}

// The real series answer (fetched first), changed by `edit`.
async function routeSeries(page, edit) {
  await page.route(/\/api\/system\/series\?/, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    edit(json);
    await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
  });
}

// A source this server lacks: its status, its series gone, its panel listed.
function dropSource(json, source, status, names, message = '') {
  json.sources[source] = { ...json.sources[source], status, message, rows_read: 0, elapsed_ms: 0 };
  for (const name of names) delete json.series[name];
  if (status !== 'out_of_range') json.unavailable_panels.push({ panel: source, table: source, reason: status, message, hint: '' });
}

const METRIC_LOG = ['qps', 'select_qps', 'insert_qps', 'failed_qps', 'avg_query_ms', 'cpu_cores', 'io_wait_cores', 'memory_tracked',
  'memory_tracked_max', 'memory_merges', 'queries_running', 'merges_running', 'mutations_running', 'merged_rows_s', 'inserted_rows_s',
  'inserted_bytes_s', 'delayed_inserts_s', 'rejected_inserts_s', 'selected_rows_s', 'selected_bytes_s', 'pool_merges_task',
  'pool_merges_size', 'pool_fetches_task', 'pool_fetches_size', 'pool_moves_task', 'pool_schedule_task', 'pool_common_task',
  'parts_active', 'parts_outdated'];
const ASYNC = ['os_user_cores', 'os_system_cores', 'os_iowait_cores', 'os_user_ratio', 'load_1m', 'memory_resident',
  'os_memory_available', 'parts_total', 'parts_max_partition', 'replicas_max_delay', 'replicas_queue'];
const QUERY_LOG = ['finished_qps', 'error_qps', 'p50_ms', 'p95_ms', 'p99_ms'];

test('Performance draws ten charts of this server over the default hour', async ({ page }) => {
  await openPerformance(page);
  await expect(page).toHaveURL(/\/system$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Time range \u00b7 Last 1 hour');
  // The range leads the filter bar, where Queries and Disks have theirs (not on the part's heading).
  await expect(page.locator('#systemBar-overview .obsFilterBar__range #systemPerfRangeButton')).toBeVisible();
  await expect(page.locator('#systemPart-performance .pagePart__head #systemPerfRangeButton')).toHaveCount(0);
  // Every chart has a card; the replicated fixture shows Replication too
  // (a line when its delay stays 0).
  for (const id of CHARTS) {
    await expect(chartCard(page, id)).toBeVisible();
    if (await chartCard(page, id).evaluate((el) => el.classList.contains('is-flat'))) continue;
    await expect(chartRoot(page, id)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/);
  }
  await expect(page.locator('#systemPerfGrid .systemChart:visible')).toHaveCount(10);
  await expect(chartCard(page, 'queries')).toHaveAttribute('data-source', 'metric_log');
  await expect(chartCard(page, 'queries').locator('.chartCore__legendItem')).toHaveText(['SELECT', 'INSERT', 'Other', 'Failed']);
  await expect(chartCard(page, 'latency').locator('.chartCore__legendItem')).toHaveText(['p50', 'p95', 'p99']);
  await expect(chartCard(page, 'cpu').locator('.chartCard__meta')).toContainText(/\d+ cores?/);
  // Two charts a row at desktop width, each filling its cell.
  const boxes = await page.locator('#systemPerfGrid .systemChart:not(.is-flat)').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const plot = el.querySelector('.chartCore').getBoundingClientRect();
    return { left: Math.round(r.left), width: r.width, plot: plot.width };
  }));
  expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
  for (const box of boxes) expect(box.plot).toBeGreaterThan(box.width - 24);
  // No notes: every log is there.
  await expect(page.locator('#systemPerfNotes .systemIssue')).toHaveCount(0);
  // No live refresh control.
  await expect(page.locator('#systemAutoRefresh-overview')).toHaveCount(0);
});

test('the charts share one crosshair', async ({ page }) => {
  await openPerformance(page);
  const box = await chartRoot(page, 'cpu').locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await expect(chartRoot(page, 'cpu').locator('.chartCore__tooltip')).toBeVisible();
  // The other charts follow the cursor's time.
  for (const id of ['memory', 'queries', 'reads']) await expect(chartRoot(page, id)).toHaveAttribute('data-sync-x', /^\d+/);
  const xs = await page.locator('#systemPerfGrid .chartCore[data-sync-x]').evaluateAll((els) => new Set(els.map((el) => el.dataset.syncX)).size);
  expect(xs).toBe(1);
});

test('a drag over one chart sets the range of every chart and the address', async ({ page }) => {
  await openPerformance(page);
  const before = Number(await chartRoot(page, 'memory').getAttribute('data-x-min'));
  const box = await chartRoot(page, 'cpu').locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/system\?from=\d{4}-\d\d-\d\d(\+|%20)\d\d(%3A|:)\d\d(%3A|:)\d\d&to=/);
  const range = await page.evaluate(() => {
    const params = new URLSearchParams(window.location.search);
    return { from: window.ChDash.timeRange.parseTime(params.get('from'), false), to: window.ChDash.timeRange.parseTime(params.get('to'), true) };
  });
  // About 40 % of the hour.
  expect(range.to - range.from).toBeGreaterThan(15 * 60_000);
  expect(range.to - range.from).toBeLessThan(35 * 60_000);
  // Every chart redraws on the new window (10 s or 30 s buckets around it).
  for (const id of await drawnCharts(page)) {
    const root = chartRoot(page, id);
    await expect.poll(async () => Number(await root.getAttribute('data-x-min')), { timeout: 15_000 }).toBeGreaterThan(before);
    const [lo, hi] = [Number(await root.getAttribute('data-x-min')), Number(await root.getAttribute('data-x-max'))];
    expect(lo).toBeGreaterThanOrEqual(range.from - 30_000);
    expect(hi).toBeLessThanOrEqual(range.to + 30_000);
    await expect(root).toHaveAttribute('data-zoomed', 'false');
  }
  // The picker shows the absolute range.
  await expect(page.locator('#systemPerfRangeButton')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(?:, \d{4})? \d\d:\d\d \u2192 /);
  // Back: the default hour again.
  await page.goBack();
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Time range \u00b7 Last 1 hour');
  await expect.poll(async () => Number(await chartRoot(page, 'memory').getAttribute('data-x-min')), { timeout: 15_000 }).toBeLessThan(range.from - 60_000);
  // A deep link opens its range; another section's page is not given it.
  await page.goForward();
  await expect(page).toHaveURL(/\/system\?from=/);
  await page.locator('#systemTab-queries').click();
  await expect(page).toHaveURL(/\/system\/queries$/);
});

test('the picker applies a quick range and writes it to the address', async ({ page }) => {
  await openPerformance(page);
  await page.locator('#systemPerfRangeButton').click();
  const panel = page.locator('#systemPerfTimeRangePanel');
  await expect(panel).toBeVisible();
  // The panel stays in the viewport (it hangs from the button's right edge).
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  const answer = seriesOf(page, 24 * 3600_000);
  await panel.locator('.timeRangeList__item', { hasText: 'Last 24 hours' }).click();
  await expect(page).toHaveURL(/\/system\?from=now-24h&to=now$/);
  // 5 min buckets.
  expect((await (await answer).json()).step_seconds).toBe(300);
  await page.reload();
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Time range \u00b7 Last 24 hours', { timeout: 20_000 });
});

test('without metric_log the charts fall back to query_log or say what they need', async ({ page }) => {
  await routeSeries(page, (json) => dropSource(json, 'metric_log', 'disabled', METRIC_LOG, 'Code: 60. DB::Exception: Table system.metric_log does not exist. (UNKNOWN_TABLE)'));
  await openPerformance(page);
  const queries = chartCard(page, 'queries');
  await expect(queries).toHaveAttribute('data-source', 'query_log');
  await expect(queries.locator('.chartCard__meta')).toContainText('query_log');
  await expect(queries.locator('.chartCore__legendItem')).toHaveText(['Finished', 'Failed']);
  await expect(chartCard(page, 'latency')).toHaveAttribute('data-source', 'query_log');
  // CPU and Memory keep their asynchronous_metric_log series.
  await expect(chartCard(page, 'cpu').locator('.chartCore__legendItem')).toHaveText(['OS user', 'OS system']);
  await expect(chartCard(page, 'memory').locator('.chartCore__legendItem')).toHaveText(['Resident']);
  // The charts that only metric_log feeds say so.
  for (const id of ['merges', 'inserts', 'pools', 'reads']) {
    await expect(chartCard(page, id).locator('.uiState__title')).toHaveText('Needs system.metric_log');
    await expect(chartCard(page, id).locator('.chartCore')).toBeHidden();
  }
  const issue = page.locator('#systemPerfNotes .systemIssue[data-reason="disabled"]');
  await expect(issue).toContainText('system.metric_log is disabled on this server');
});

test('metric_log in the transposed layout reads as no metric_log; past query_log the latency is the average', async ({ page }) => {
  await routeSeries(page, (json) => {
    dropSource(json, 'metric_log', 'unsupported', METRIC_LOG.filter((name) => name !== 'avg_query_ms'),
      'system.metric_log uses the transposed layout (no ProfileEvent_* columns), which this version does not read.');
    json.sources.metric_log.status = 'ok';
    json.unavailable_panels = [];
    dropSource(json, 'query_log', 'out_of_range', QUERY_LOG);
  });
  await openPerformance(page);
  const latency = chartCard(page, 'latency');
  await expect(latency).toHaveAttribute('data-source', 'metric_log');
  await expect(latency).toHaveClass(/is-fallback/);
  await expect(latency.locator('.chartCore__legendItem')).toHaveText(['Average']);
  await expect(latency.locator('.chartCard__meta')).toContainText('average');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await routeSeries(page, (json) => dropSource(json, 'metric_log', 'unsupported', METRIC_LOG,
    'system.metric_log uses the transposed layout (no ProfileEvent_* columns), which this version does not read.'));
  await page.reload();
  await expect(page.locator('#systemPerfNotes .systemIssue[data-reason="unsupported"]')).toContainText('transposed layout', { timeout: 20_000 });
  await expect(chartCard(page, 'queries')).toHaveAttribute('data-source', 'query_log');
});

test('without any history the charts point to the current values above', async ({ page }) => {
  await routeSeries(page, (json) => {
    dropSource(json, 'metric_log', 'disabled', METRIC_LOG);
    dropSource(json, 'asynchronous_metric_log', 'not_granted', ASYNC, 'Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)');
    json.sources.asynchronous_metric_log.hint = 'GRANT SELECT ON system.asynchronous_metric_log TO chdash_system';
    json.unavailable_panels[1].hint = json.sources.asynchronous_metric_log.hint;
  });
  await page.goto('/system');
  const current = page.locator('#systemPerfCurrent');
  await expect(current).toContainText('History needs system.metric_log or system.asynchronous_metric_log', { timeout: 20_000 });
  // The current values are the tiles at the top, never a second time.
  await expect(current).toContainText('the tiles at the top');
  await expect(tiles(page)).toHaveCount(8);
  await expect(page.locator('.systemTiles')).toHaveCount(1);
  await expect(page.locator('#systemPerfNotes .systemIssue__code')).toHaveText('GRANT SELECT ON system.asynchronous_metric_log TO chdash_system');
  // query_log still gives queries/s and the latency; the rest is hidden, not eight empty cards.
  await expect(page.locator('#systemPerfGrid .systemChart:visible')).toHaveCount(2);
  await expect(chartCard(page, 'queries')).toBeVisible();
  await expect(chartCard(page, 'latency')).toBeVisible();
});

test('the error share reads neutral under 1 %, warning to 5 %, danger past it', async ({ page }) => {
  let share = 0;
  await routeSeries(page, (json) => {
    json.series.failed_qps = json.series.qps.map((v) => (v == null ? null : v * share));
  });
  const badge = chartCard(page, 'queries').locator('[data-error-rate]');
  for (const [value, tone] of [[0.004, 'neutral'], [0.03, 'warn'], [0.08, 'error']]) {
    share = value;
    await openPerformance(page);
    await expect(badge).toHaveAttribute('data-error-rate', tone);
    await expect(badge).toHaveClass(new RegExp(`badge--${tone}`));
  }
});

test('each section page loads its own section and none of the others', async ({ page }) => {
  const modules = () => page.evaluate(() => ({
    perf: !!window.ChDash.systemPerf, activity: !!window.ChDash.systemActivity,
    queries: !!window.ChDash.systemQuerySql || [...document.scripts].some((s) => /app_system_queries\.js/.test(s.src)),
    disks: [...document.scripts].some((s) => /app_system_disks\.js/.test(s.src)),
    overview: [...document.scripts].some((s) => /app_system_overview\.js/.test(s.src)),
  }));
  await openOverview(page);
  expect(await modules()).toMatchObject({ perf: true, activity: true, overview: true, queries: false, disks: false });
  await page.goto('/system/disks');
  await expect(page.locator('#systemBar-disks')).toBeVisible({ timeout: 20_000 });
  expect(await modules()).toMatchObject({ perf: false, activity: false, overview: false, queries: false, disks: true });
  await page.goto('/system/queries');
  await expect(page.locator('#systemBar-queries')).toBeVisible({ timeout: 20_000 });
  expect(await modules()).toMatchObject({ perf: false, activity: false, overview: false, disks: false });
  // Each page has its own sheet.
  for (const [path, sheet] of [['/system', 'style.system.css'], ['/system/queries', 'style.queries.css'], ['/system/disks', 'style.disks.css']]) {
    await page.goto(path);
    expect(await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0]))).toEqual([sheet]);
  }
});

test('Performance renders ten charts over 30 days within the performance budget', async ({ page }) => {
  await openPerformance(page);
  // Long tasks from here on: the 30-day answer and its ten charts.
  await page.evaluate(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration)); })
      .observe({ type: 'longtask' });
    window.ChDash.chartCore.resetCounters();
  });
  await page.locator('#systemPerfRangeButton').click();
  await page.locator('#systemPerfRangeStart').fill('now-30d');
  await page.locator('#systemPerfRangeEnd').fill('now');
  const answer = seriesOf(page, 30 * 86400_000);
  await page.locator('#systemPerfCustomRangeApply').click();
  // 3 h buckets.
  expect((await (await answer).json()).step_seconds).toBe(3 * 3600);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 300)))));
  const { longTasks, counters } = await page.evaluate(() => ({ longTasks: window.__longTasks, counters: window.ChDash.chartCore.counters() }));
  expect(counters.draws).toBeGreaterThanOrEqual((await drawnCharts(page)).length);
  test.info().annotations.push({ type: 'longest task (ms)', description: String(Math.max(0, ...longTasks)) },
    { type: 'draw time (ms)', description: counters.drawMs.toFixed(1) });
  expect(Math.max(0, ...longTasks)).toBeLessThanOrEqual(200);
});

for (const width of [390, 360]) {
  test.describe(`Performance on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`Performance charts fit the viewport one a row at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      await openPerformance(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await panel(page, 'overview').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      const boxes = await page.locator('#systemPerfGrid .systemChart:visible:not(.is-flat)').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), plot: el.querySelector('.chartCore').getBoundingClientRect().width };
      }));
      expect(new Set(boxes.map((box) => box.left)).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(width - 40);
        expect(box.plot).toBeGreaterThan(box.width - 24);
      }
      // 40 px targets: the range, refresh (the bar unfolded) and the legend.
      await page.locator('#systemBar-overview .obsFilterSummary').click();
      for (const selector of ['#systemPerfRangeButton', '#systemRefresh-overview']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(40);
      }
      const legend = await chartCard(page, 'cpu').locator('.chartCore__legendItem').first().boundingBox();
      expect(legend.height).toBeGreaterThanOrEqual(40);
      // The range panel opens inside the screen.
      await page.locator('#systemPerfRangeButton').scrollIntoViewIfNeeded();
      await page.locator('#systemPerfRangeButton').click();
      const rangePanel = await page.locator('#systemPerfTimeRangePanel').boundingBox();
      expect(rangePanel.x).toBeGreaterThanOrEqual(0);
      expect(rangePanel.x + rangePanel.width).toBeLessThanOrEqual(width);
    });
  });
}

// ---------------------------------------------------------------------------
// Queries: the top query shapes of the window (/api/system/queries,
// the runner account), a shape's page (/system/queries/<hash>) and Open in Query.
// Every stack has queries in its last hour (the tests' own), so the default
// window is enough; the degraded states are mocked answers.

const queryRows = (page) => page.locator('#systemQueriesTable tbody tr');

// The hash of the shape's page, from its address (/system/queries/<hash>).
const shapeHash = (page) => /\/system\/queries\/(\d+)/.exec(new URL(page.url()).pathname)[1];

async function openQueries(page, query = '') {
  await page.goto(`/system/queries${query}`);
  await expect(queryRows(page).first()).toBeVisible({ timeout: 30_000 });
}

// The real queries answer (fetched first), changed by `edit`.
async function routeQueries(page, edit) {
  await page.route(/\/api\/system\/queries\?/, async (route) => {
    // A request still in flight when the test ends is let go.
    try {
      const response = await route.fetch();
      const json = await response.json();
      edit(json);
      await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // The page or the test is gone.
    }
  });
}

function degrade(json, status, extra = {}) {
  Object.assign(json, { status, message: '', hint: '', suggested_span_ms: null, queries: [], totals: { calls: 0, errors: 0, total_ms: 0, read_bytes: 0, shapes: 0 }, ...extra });
  json.unavailable_panels = [{ panel: 'queries', table: 'query_log', reason: status, message: json.message, hint: json.hint }];
}

const numberOf = (text) => {
  const match = /^([\d,.]+)\s*([KMB])?/.exec(String(text).trim());
  if (!match) return NaN;
  return Number(match[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]] || 1);
};

test('Queries lists the top query shapes of the hour, sorted by total time', async ({ page }) => {
  await openQueries(page);
  await expect(page).toHaveURL(/\/system\/queries$/);
  await expect(selectedSection(page)).toHaveText('Queries');
  await expect(page.locator('#systemQueriesRangeButton')).toHaveText('Time range · Last 1 hour');
  await expect(page.locator('.systemQueries__tiles [data-tile="shapes"] .statTile__sub')).toHaveText(/^(normalized queries|the top [\d,]+ listed)$/);
  // No Auto-refresh: a window is read once.
  await expect(page.locator('#systemAutoRefresh-queries')).toHaveCount(0);
  await expect(page.locator('.systemQueries__tiles > .statTile .statTile__label')).toHaveText(['Queries', 'Shapes', 'Total time', 'Errors', 'Read']);
  await expect(page.locator('#systemQueriesTable thead th')).toHaveText(['#', 'Query', 'Kind', 'Calls', 'Errors', 'Total time', 'Avg', 'p95', 'Max', 'Read rows', 'Read', 'Memory', 'Users', 'Tables']);
  await expect(page.locator('#systemQueriesTable th[data-col="total"]')).toHaveAttribute('aria-sort', 'descending');
  const count = await queryRows(page).count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(50);
  // The normalized SQL is highlighted text (the highlighter's spans), two lines at most.
  const sql = queryRows(page).first().locator('.systemQueries__sql');
  await expect(sql.locator('.sqlBlock__code')).not.toBeEmpty();
  expect(await sql.getAttribute('title')).toBeTruthy();
  const lines = await sql.locator('.sqlBlock__pre').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeLessThanOrEqual(2);
  // Mono for SQL, sans tabular figures for measures.
  const fonts = await page.evaluate(() => {
    const row = document.querySelector('#systemQueriesTable tbody tr');
    const style = (el) => getComputedStyle(el);
    return { sql: style(row.querySelector('.sqlBlock__code')).fontFamily, total: style(row.querySelector('.systemQueries__total')).fontFamily, nums: style(row.querySelector('.systemQueries__total')).fontVariantNumeric };
  });
  expect(fonts.sql).toMatch(/mono/i);
  expect(fonts.total).not.toMatch(/mono/i);
  expect(fonts.nums).toContain('tabular-nums');
});

test('the headers sort and the kind and Hide ChDash filter, through the address', async ({ page }) => {
  await openQueries(page);
  await page.locator('#systemQueriesTable th[data-col="calls"] .dataTable__sort').click();
  await expect(page).toHaveURL(/queries\?sort=calls$/);
  await expect(page.locator('#systemQueriesTable th[data-col="calls"]')).toHaveAttribute('aria-sort', 'descending', { timeout: 20_000 });
  const calls = (await queryRows(page).locator('td:nth-child(4)').allTextContents()).map(numberOf);
  expect(calls.length).toBeGreaterThan(0);
  for (let i = 1; i < calls.length; i++) expect(calls[i - 1]).toBeGreaterThanOrEqual(calls[i]);
  // SELECT only.
  await pick(page.locator('.systemQueries__kindPicker'), 'Select');
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('.systemQueries__kindPicker .tracePicker__button')).toHaveText('Kind \u00b7 SELECT');
  await expect.poll(async () => [...new Set(await queryRows(page).evaluateAll((rows) => rows.map((row) => row.dataset.kind)))], { timeout: 20_000 }).toEqual(['Select']);
  // ChDash's own queries: shown on request (a toggle chip of the bar).
  await expect(page.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'true');
  const asked = page.waitForRequest((request) => request.url().includes('/api/system/queries?') && request.url().includes('hide_chdash=0'));
  await page.locator('#systemQueriesHide').click();
  await expect(page.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'false');
  await asked;
  await expect(page).toHaveURL(/kind=Select&hide=0$/);
  // Back: the previous filters.
  await page.goBack();
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(page.locator('#systemQueriesKind')).toHaveValue('all');
  await expect(page.locator('.systemQueries__kindPicker .tracePicker__button')).toHaveText('Kind \u00b7 All');
});

test('a row opens its shape as a page of its own: timeline, runs, deep link and Back', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const row = queryRows(page).first();
  const hash = await row.getAttribute('data-hash');
  expect(hash).toMatch(/^\d+$/);
  // A real navigation: the shape is /system/queries/<hash>, not a pane of the list.
  await page.evaluate(() => { window.__sameDocument = true; });
  await Promise.all([page.waitForURL(new RegExp(`/system/queries/${hash}\\?sort=calls$`)), row.click()]);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
  await expect(page.locator('body')).toHaveAttribute('data-page', 'shape');
  const drill = page.locator('#systemQuery');
  await expect(drill).toBeVisible();
  // The page header stays; the System section tabs and the list do not.
  await expect(page.locator('.appHeader')).toBeVisible();
  await expect(page.locator('#pageSelectButton')).toHaveText('System');
  for (const id of ['systemTabs', 'systemQueriesTable']) await expect(page.locator(`#${id}`), id).toHaveCount(0);
  await expect(page.locator('#systemQueriesList')).toBeHidden();
  await expect(queryRows(page)).toHaveCount(0);
  // The head holds the way back, the time range and the refresh button; the query is
  // right under it, so the page has no title of its own and no copy button for the hash.
  const head = drill.locator('.systemQuery__head');
  await expect(head.locator('#systemQueryBack')).toBeVisible();
  await expect(head.locator('#systemQueriesRangeButton')).toBeVisible();
  await expect(head.locator('#systemRefresh-queries')).toBeVisible();
  await expect(drill.locator('.systemQuery__name, .systemQuery__copyHash')).toHaveCount(0);
  await expect(page.locator('#systemBar-queries')).toHaveCount(0);
  await expect(page.locator('#systemQuerySql')).toBeVisible({ timeout: 20_000 });
  // The browser tab names the shape by its first words, so several shapes can be told apart.
  await expect(page).toHaveTitle(/ \u00b7 Query shape$/);
  expect((await page.title()).length).toBeLessThanOrEqual(90);
  await expect(drill.locator('.systemQuery__tiles .statTile__label')).toHaveText(['Calls', 'Errors', 'Total time', 'p95', 'Read', 'Memory', 'CPU'], { timeout: 20_000 });
  for (const id of ['calls', 'latency', 'cpu']) {
    await expect(page.locator(`#systemQueryChart-${id} .chartCore`)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  }
  const runs = page.locator('#systemQueryRuns tbody tr');
  const total = await runs.count();
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(20);
  // The slowest first.
  const durations = await runs.locator('td:nth-child(2)').allTextContents();
  expect(durations.length).toBe(total);
  // The latest runs instead: the order is in the address, next to the list's parameters.
  await page.locator('#systemQueryRunsOrder [data-order="latest"]').click();
  await expect(page).toHaveURL(new RegExp(`/system/queries/${hash}\\?sort=calls&runs=latest$`));
  await expect(page.locator('#systemQueryRunsOrder [data-order="latest"]')).toHaveAttribute('aria-pressed', 'true');
  // The trace page's arrow, no "All queries" label and no "Example: the latest run" note.
  const arrow = page.locator('#systemQueryBack');
  await expect(arrow).toHaveClass(/\bpageBack\b/);
  await expect(arrow).toHaveAccessibleName('Back to the list of queries');
  await expect(arrow).toHaveText('');
  expect(await arrow.boundingBox()).toMatchObject({ width: 28, height: 36 });
  await expect(arrow.locator('use')).toHaveAttribute('href', /#i-arrow-left$/);
  await expect(drill.locator('.systemQuery__example')).toHaveCount(0);
  await expect(drill).not.toContainText('Copy as logged');
  // The list again, with the list's parameters (not the shape's runs=).
  await arrow.click();
  await expect(page).toHaveURL(/\/system\/queries\?sort=calls$/);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'system');
  await expect(queryRows(page).first()).toBeVisible();
  // The browser's Forward returns to the shape, a deep link opens it, and so does
  // the former address (?q=), with the list's parameters kept.
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/system/queries/${hash}\\?sort=calls&runs=latest$`));
  await expect(drill).toBeVisible();
  await page.goto(`/system/queries/${hash}`);
  await expect(page.locator('#systemQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`/system/queries?sort=calls&q=${hash}`);
  await expect(page).toHaveURL(new RegExp(`/system/queries/${hash}\\?sort=calls$`));
  await expect(page.locator('#systemQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
  // Keyboard: Enter on a row of the list opens its page.
  await page.locator('#systemQueryBack').click();
  await queryRows(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/system\/queries\/\d+/);
});

test('on a wide screen a shape\'s figures sit right of its query, two to a row, and the charts run under both; on a narrower one all go in one column', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/system/queries/${hash}?sort=calls`);
  const sql = page.locator('#systemQuerySql');
  const tiles = page.locator('.systemQuery__tiles');
  const charts = page.locator('.systemQuery__charts');
  await expect(tiles).toBeVisible({ timeout: 30_000 });
  await expect(sql).toBeVisible();
  await expect(charts).toBeVisible();
  const [sqlBox, tilesBox, chartsBox] = [await sql.boundingBox(), await tiles.boundingBox(), await charts.boundingBox()];
  // The figures: right of the query, level with its top, a short query stretched to their height;
  // the charts run under both, the right one under the figures (no empty space there).
  expect(tilesBox.x).toBeGreaterThanOrEqual(sqlBox.x + sqlBox.width);
  expect(Math.abs(tilesBox.y - sqlBox.y)).toBeLessThan(4);
  expect(Math.abs(sqlBox.height - tilesBox.height)).toBeLessThan(3);
  expect(Math.abs(chartsBox.x - sqlBox.x)).toBeLessThan(2);
  expect(Math.abs((chartsBox.x + chartsBox.width) - (tilesBox.x + tilesBox.width))).toBeLessThan(2);
  expect(chartsBox.y).toBeGreaterThanOrEqual(Math.max(sqlBox.y + sqlBox.height, tilesBox.y + tilesBox.height) - 1);
  // No gap on the shape's page, the list keeps its own.
  expect(await page.locator('#systemQueries').evaluate((el) => getComputedStyle(el).rowGap)).toBe('0px');
  // The query keeps most of the width; two figures to a row.
  expect(sqlBox.width).toBeGreaterThan(tilesBox.width * 2);
  const first = await tiles.locator('.statTile').nth(0).boundingBox();
  const second = await tiles.locator('.statTile').nth(1).boundingBox();
  const third = await tiles.locator('.statTile').nth(2).boundingBox();
  expect(Math.abs(first.y - second.y)).toBeLessThan(2);
  expect(third.y).toBeGreaterThan(first.y + first.height - 1);
  // The runs stay full width under all of it.
  const runsBox = await page.locator('.systemQuery__runs').boundingBox();
  expect(runsBox.y).toBeGreaterThanOrEqual(tilesBox.y + tilesBox.height);
  // At 1280 px and below the figures go back under the query, the charts under them.
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect.poll(async () => (await tiles.boundingBox()).y).toBeGreaterThanOrEqual((await sql.boundingBox()).y + (await sql.boundingBox()).height - 1);
  const narrow = await tiles.boundingBox();
  expect(Math.abs(narrow.x - (await sql.boundingBox()).x)).toBeLessThan(2);
  expect((await charts.boundingBox()).y).toBeGreaterThanOrEqual(narrow.y + narrow.height - 1);
});

test('a shape\'s SQL has line numbers and the Query editor\'s colours (keywords, functions), readable in the light theme', async ({ page, request }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  await page.route(new RegExp(`/api/system/queries/${hash}\\?`), async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.normalized = 'SELECT count() AS calls, toDate(now()) AS day, sum(bytes) FROM db.events WHERE id IN (?..) AND ts > ? GROUP BY day ORDER BY calls DESC LIMIT ?';
    await route.fulfill({ response, json });
  });
  await page.goto(`/system/queries/${hash}?sort=calls`);
  const block = page.locator('#systemQuerySql .sqlBlock');
  await expect(block).toBeVisible({ timeout: 30_000 });
  // Line numbers, one per line of the formatted query, no wrapping.
  await expect(block).toHaveClass(/\bsqlBlock--gutter\b/);
  await expect(block).not.toHaveClass(/\bsqlBlock--wrap\b/);
  const numbers = (await block.locator('.sqlBlock__gutter').textContent()).trim().split('\n');
  expect(numbers[0]).toBe('1');
  expect(numbers.length).toBeGreaterThan(1);
  // The editor's highlighter with the host's function list: keywords and functions each have a colour.
  await expect(block.locator('.tok-kw').first()).toBeVisible();
  await expect(block.locator('.tok-fn').first()).toBeVisible({ timeout: 20_000 });
  const colour = (selector) => block.locator(selector).first().evaluate((el) => getComputedStyle(el).color);
  expect(await colour('.tok-kw')).not.toBe(await colour('.tok-fn'));
  // Light theme: keywords reach 4.5:1 on the editor surface.
  await page.emulateMedia({ colorScheme: 'light' });
  const ratio = await block.evaluate((el) => {
    const parse = (value) => {
      const probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = '#000';
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const fg = lum(parse(getComputedStyle(el.querySelector('.tok-kw')).color));
    const bg = lum(parse(getComputedStyle(el).backgroundColor));
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('a shape\'s time range and refresh button are in its head: the range applies at once and is in the address', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  await page.goto(`/system/queries/${hash}?sort=calls`);
  const head = page.locator('#systemQuery .systemQuery__head');
  await expect(head.locator('#systemQueryRuns, #systemQueryBack').first()).toBeVisible({ timeout: 30_000 });
  await expect(head.locator('#systemQueriesRangeButton')).toBeVisible();
  await expect(head.locator('#systemRefresh-queries')).toBeVisible();
  await head.locator('#systemQueriesRangeButton').click();
  await page.locator('#systemQueriesQuickRanges .timeRangeList__item[data-from="now-6h"]').click();
  await expect(page).toHaveURL(new RegExp(`/system/queries/${hash}\\?from=now-6h&to=now&sort=calls$`));
  // The head is drawn again with the new window; the controls stay in it.
  await expect(head.locator('#systemQueriesRangeButton')).toContainText('Last 6 hours');
  const refreshed = page.waitForRequest((request) => request.url().includes(`/api/system/queries/${hash}?`) && request.url().includes('refresh=1'));
  await head.locator('#systemRefresh-queries').click();
  await refreshed;
  // The list's way back keeps the range.
  await head.locator('#systemQueryBack').click();
  await expect(page).toHaveURL(/\/system\/queries\?from=now-6h&to=now&sort=calls$/);
});

test('Open in Query puts the example or the history in the editor without running it', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  await queryRows(page).first().click();
  const example = page.locator('#systemQueryOpenExample');
  await expect(example).toBeEnabled({ timeout: 20_000 });
  const runs = [];
  page.on('request', (request) => { if (request.url().includes('/api/query/run')) runs.push(request.url()); });
  await example.click();
  await expect(page).toHaveURL(/\/query$/, { timeout: 20_000 });
  await expect(page.locator('#queryTextArea')).toHaveValue(/\S/);
  await page.goBack();
  await expect(page.locator('#systemQueryOpenHistory')).toBeVisible({ timeout: 20_000 });
  await page.locator('#systemQueryOpenHistory').click();
  await expect(page).toHaveURL(/\/query$/, { timeout: 20_000 });
  const editor = page.locator('#queryTextArea');
  await expect(editor).toHaveValue(new RegExp(`normalized_query_hash = ${hash}`));
  await expect(editor).toHaveValue(/FROM system\.query_log/);
  await expect(editor).toHaveValue(/event_time >= now\(\) - INTERVAL 1 HOUR/);
  await page.waitForTimeout(500);
  expect(runs).toEqual([]);
});

// The text the last copy put on the clipboard (http origins have no async
// clipboard to read: ui.copyText selects a textarea and runs the copy command).
async function captureCopies(page) {
  await page.evaluate(() => {
    window.__sqCopied = '';
    document.addEventListener('copy', (ev) => {
      const el = ev.target instanceof HTMLTextAreaElement ? ev.target : document.activeElement;
      if (el && typeof el.value === 'string') window.__sqCopied = el.value.slice(el.selectionStart, el.selectionEnd);
    }, true);
  });
}
const copiedText = (page) => page.evaluate(() => window.__sqCopied);

// Order by: the server's allowlist, in this order; the header each one sorts.
const ORDER_BY = [
  ['calls', 'Calls', 'calls'], ['total_time', 'Total time', 'total'], ['avg', 'Avg', 'avg'], ['p95', 'p95', 'p95'],
  ['max', 'Max', 'max'], ['errors', 'Errors', 'errors'], ['read_rows', 'Read rows', 'rows'], ['read_bytes', 'Read bytes', 'bytes'],
  ['max_memory', 'Memory', 'memory'],
];
const orderPicker = (page) => page.locator('.systemQueries__orderPicker');
const userPicker = (page) => page.locator('.systemQueries__userPicker');
const listRequest = (page, check) => page.waitForRequest((request) => {
  if (!request.url().includes('/api/system/queries?')) return false;
  return check(new URL(request.url()).searchParams);
});

async function pick(picker, value) {
  await picker.locator('.tracePicker__button').click();
  await picker.locator(`.tracePicker__option[data-value="${value}"]`).click();
}

test('Order by: every measure of the allowlist, on the server, in the address, one setting with the headers', async ({ page }) => {
  await openQueries(page);
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Total time');
  await expect(page.locator('#systemQueriesOrder')).toHaveValue('total_time');
  await orderPicker(page).locator('.tracePicker__button').click();
  await expect(orderPicker(page).locator('.tracePicker__option')).toHaveText(ORDER_BY.map(([, label]) => label));
  await page.keyboard.press('Escape');
  // A pick reads the top 50 by that measure: the request, the address and
  // the header's arrow follow.
  for (const [value, label, col] of ORDER_BY.filter(([value]) => value !== 'total_time')) {
    const asked = listRequest(page, (params) => params.get('sort') === value);
    await pick(orderPicker(page), value);
    await asked;
    await expect(page).toHaveURL(new RegExp(`queries\\?sort=${value}$`));
    await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText(`Order by \u00b7 ${label}`);
    await expect(page.locator(`#systemQueriesTable th[data-col="${col}"]`)).toHaveAttribute('aria-sort', 'descending', { timeout: 20_000 });
    await expect(page.locator('#systemQueriesTable th[aria-sort="descending"]')).toHaveCount(1);
  }
  // Avg, by the picker: the rows come largest first.
  await pick(orderPicker(page), 'avg');
  await expect(page.locator('#systemQueriesTable th[data-col="avg"]')).toHaveAttribute('aria-sort', 'descending', { timeout: 20_000 });
  const avgIndex = await page.locator('#systemQueriesTable thead th').evaluateAll((ths) => ths.findIndex((th) => th.dataset.col === 'avg'));
  const ms = (text) => {
    const m = /^([\d.,]+)\s*(ns|\u00b5s|ms|s|min)/.exec(text.trim());
    return m ? Number(m[1].replace(/,/g, '')) * ({ ns: 1e-6, '\u00b5s': 1e-3, ms: 1, s: 1e3, min: 6e4 }[m[2]]) : NaN;
  };
  const avgs = (await queryRows(page).locator(`td:nth-child(${avgIndex + 1})`).allTextContents()).map(ms);
  for (let i = 1; i < avgs.length; i++) expect(avgs[i - 1]).toBeGreaterThanOrEqual(avgs[i] * 0.995);
  // A header sorts too, and moves the picker.
  const byHeader = listRequest(page, (params) => params.get('sort') === 'read_rows');
  await page.locator('#systemQueriesTable th[data-col="rows"] .dataTable__sort').click();
  await byHeader;
  await expect(page).toHaveURL(/queries\?sort=read_rows$/);
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Read rows');
  await expect(page.locator('#systemQueriesOrder')).toHaveValue('read_rows');
  // Back and Forward restore it; an address opens it; an unknown one is the default.
  await page.goBack();
  await expect(page).toHaveURL(/queries\?sort=avg$/);
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Avg');
  await expect(page.locator('#systemQueriesTable th[data-col="avg"]')).toHaveAttribute('aria-sort', 'descending');
  await page.goForward();
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Read rows');
  await openQueries(page, '?sort=max');
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Max');
  await expect(page.locator('#systemQueriesTable th[data-col="max"]')).toHaveAttribute('aria-sort', 'descending');
  const fallback = listRequest(page, (params) => params.get('sort') === 'total_time');
  await page.goto('/system/queries?sort=total_ms%20DESC');
  await fallback;
  await expect(orderPicker(page).locator('.tracePicker__button')).toHaveText('Order by \u00b7 Total time');
});

test('Errors and User filter the list on the server, in the address, with Back', async ({ page }) => {
  await openQueries(page);
  const errorsPicker = page.locator('.systemQueries__errorsPicker');
  await expect(errorsPicker.locator('.tracePicker__button')).toHaveText('Errors \u00b7 All');
  await errorsPicker.locator('.tracePicker__button').click();
  await expect(errorsPicker.locator('.tracePicker__option')).toHaveText(['All', 'With errors', 'Without errors']);
  await page.keyboard.press('Escape');
  // Without errors: every listed shape finished every run.
  let asked = listRequest(page, (params) => params.get('errors') === 'without');
  await pick(errorsPicker, 'without');
  await asked;
  await expect(page).toHaveURL(/queries\?errors=without$/);
  await expect(errorsPicker.locator('.tracePicker__button')).toHaveText('Errors \u00b7 Without errors');
  await expect.poll(() => page.locator('#systemQueriesTable tbody .systemQueries__errors').evaluateAll((tds) => tds.length > 0 && tds.every((td) => td.textContent.trim() === '0')), { timeout: 20_000 }).toBe(true);
  // With errors: every listed shape has a failed run (or none is listed).
  asked = listRequest(page, (params) => params.get('errors') === 'with');
  await pick(errorsPicker, 'with');
  await asked;
  await expect(page).toHaveURL(/queries\?errors=with$/);
  await expect.poll(() => page.locator('#systemQueriesTable tbody .systemQueries__errors').evaluateAll((tds) => tds.every((td) => td.querySelector('[data-error-rate]') != null)), { timeout: 20_000 }).toBe(true);
  await pick(errorsPicker, 'all');
  await expect(page).toHaveURL(/\/system\/queries$/);

  // User: All, then the window's users with their counts, most active first.
  await expect(userPicker(page).locator('.tracePicker__button')).toHaveText('User \u00b7 All');
  await userPicker(page).locator('.tracePicker__button').click();
  const options = userPicker(page).locator('.tracePicker__option');
  await expect(options.first()).toHaveText('All');
  const labels = await options.allTextContents();
  expect(labels.length).toBeGreaterThan(1);
  const counts = labels.slice(1).map((text) => Number(/\(([\d,]+)\)$/.exec(text)[1].replace(/,/g, '')));
  expect(counts).toEqual([...counts].sort((a, b) => b - a));
  expect(labels.slice(1).some((text) => text.startsWith('chdash_runner ('))).toBe(true);
  expect(labels.some((text) => text.startsWith('chdash_system'))).toBe(false);
  asked = listRequest(page, (params) => params.get('user') === 'chdash_runner');
  await userPicker(page).locator('.tracePicker__option[data-value="chdash_runner"]').click();
  await asked;
  await expect(page).toHaveURL(/queries\?user=chdash_runner$/);
  await expect(userPicker(page).locator('.tracePicker__button')).toHaveText(/^User \u00b7 chdash_runner/);
  await expect.poll(async () => [...new Set(await page.locator('#systemQueriesTable tbody td.is-mid.systemQueries__names').allTextContents())], { timeout: 20_000 }).toEqual(['chdash_runner']);
  // The other users stay offered while one is picked.
  await userPicker(page).locator('.tracePicker__button').click();
  await expect(options).toHaveCount(labels.length);
  await page.keyboard.press('Escape');
  // Filters combine, and the cache keeps them apart.
  asked = listRequest(page, (params) => params.get('user') === 'chdash_runner' && params.get('errors') === 'without' && params.get('kind') === 'Select');
  await pick(errorsPicker, 'without');
  await pick(page.locator('.systemQueries__kindPicker'), 'Select');
  await asked;
  await expect(page).toHaveURL(/queries\?kind=Select&errors=without&user=chdash_runner$/);
  // Back: one filter at a time.
  await page.goBack();
  await expect(page).toHaveURL(/queries\?errors=without&user=chdash_runner$/);
  await expect(page.locator('#systemQueriesKind')).toHaveValue('all');
  await page.goBack();
  await expect(page).toHaveURL(/queries\?user=chdash_runner$/);
  await expect(page.locator('#systemQueriesErrors')).toHaveValue('all');
  await page.goBack();
  await expect(page).toHaveURL(/\/system\/queries$/);
  await expect(userPicker(page).locator('.tracePicker__button')).toHaveText('User \u00b7 All');
});

test('a user name with quotes and backslashes is sent as it is and matches no query', async ({ page }) => {
  const user = "o'brien\\x\" OR '1'='1";
  const asked = listRequest(page, (params) => params.get('user') === user);
  await page.goto(`/system/queries?user=${encodeURIComponent(user)}&errors=bogus`);
  const request = await asked;
  // The unknown errors value never reaches the server.
  expect(new URL(request.url()).searchParams.get('errors')).toBeNull();
  const answer = await (await request.response()).json();
  expect(answer.status).toBe('ok');
  expect(answer.user).toBe(user);
  expect(answer.queries).toEqual([]);
  await expect(page.locator('#systemQueriesEmpty')).toBeVisible({ timeout: 20_000 });
  await expect(userPicker(page).locator('.tracePicker__button')).toHaveText(`User \u00b7 ${user}`);
  // The address keeps it as it is; a filter change writes it back whole
  // (the unknown errors value is not).
  await pick(page.locator('.systemQueries__kindPicker'), 'Select');
  await expect.poll(() => new URL(page.url()).searchParams.get('kind')).toBe('Select');
  expect(new URL(page.url()).searchParams.get('user')).toBe(user);
  expect(new URL(page.url()).searchParams.get('errors')).toBeNull();
});

// The database and table filters (user, 2026-10-04 evening): two pickers
// after User, "Database · All" and "Table · All" (narrowed by the database),
// the window's names from the list read; a pick is a bound parameter of the
// read, kept in the address, restored by Back / Forward.
const DB_CHOICES = [{ name: 'chdash_ui', calls: 9 }, { name: "o'brien", calls: 3 }];
const TABLE_CHOICES = [{ name: 'chdash_ui.weather_observations', calls: 9 }, { name: 'chdash_ui.my.dotted', calls: 2 }, { name: "o'brien.t\\x", calls: 1 }];
async function routeObjectChoices(page) {
  await page.route(/\/api\/system\/queries\?/, async (route) => {
    try {
      const response = await route.fetch();
      const json = await response.json();
      json.databases = DB_CHOICES;
      json.tables = TABLE_CHOICES;
      await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // The page or the test is gone.
    }
  });
}

test('Database and Table filter the list on the server, narrowed by the database, in the address, with Back', async ({ page }) => {
  await routeObjectChoices(page);
  await openQueries(page);
  const databasePicker = page.locator('.systemQueries__databasePicker');
  const tablePicker = page.locator('.systemQueries__tablePicker');
  // After User, before Order by, in the bar.
  const order = await page.locator('#systemBar-queries').evaluate((bar) => [...bar.querySelectorAll('.obsFilterBar__field select')].map((el) => el.id));
  expect(order).toEqual(['systemQueriesKind', 'systemQueriesErrors', 'systemQueriesUser', 'systemQueriesDatabase', 'systemQueriesTableFilter', 'systemQueriesOrder']);
  await expect(databasePicker.locator('.tracePicker__button')).toHaveText('Database · All');
  await expect(tablePicker.locator('.tracePicker__button')).toHaveText('Table · All');
  await databasePicker.locator('.tracePicker__button').click();
  await expect(databasePicker.locator('.tracePicker__option')).toHaveText(['All', 'chdash_ui (9)', "o'brien (3)"]);
  // A database: the read, the address, and the tables narrowed to it.
  let asked = listRequest(page, (params) => params.get('database') === 'chdash_ui' && !params.has('table'));
  await databasePicker.locator('.tracePicker__option[data-value="chdash_ui"]').click();
  await asked;
  await expect(page).toHaveURL(/queries\?database=chdash_ui$/);
  await tablePicker.locator('.tracePicker__button').click();
  await expect(tablePicker.locator('.tracePicker__option')).toHaveText(['All', 'chdash_ui.weather_observations (9)', 'chdash_ui.my.dotted (2)']);
  // A table with a dot in its name: sent whole.
  asked = listRequest(page, (params) => params.get('database') === 'chdash_ui' && params.get('table') === 'chdash_ui.my.dotted');
  await tablePicker.locator('.tracePicker__option[data-value="chdash_ui.my.dotted"]').click();
  await asked;
  await expect(page).toHaveURL(/queries\?database=chdash_ui&table=chdash_ui\.my\.dotted$/);
  await expect(tablePicker.locator('.tracePicker__button')).toHaveText('Table · chdash_ui.my.dotted (2)');
  // Another database drops a table of the first.
  asked = listRequest(page, (params) => params.get('database') === "o'brien" && !params.has('table'));
  await pick(databasePicker, "o'brien");
  await asked;
  expect(new URL(page.url()).searchParams.get('table')).toBeNull();
  // Back: one step at a time; a reload keeps the address's filters.
  await page.goBack();
  await expect(page).toHaveURL(/queries\?database=chdash_ui&table=chdash_ui\.my\.dotted$/);
  await expect(page.locator('#systemQueriesTableFilter')).toHaveValue('chdash_ui.my.dotted');
  await page.goBack();
  await expect(page).toHaveURL(/queries\?database=chdash_ui$/);
  await expect(page.locator('#systemQueriesTableFilter')).toHaveValue('');
  await page.reload();
  await expect(page.locator('#systemQueriesDatabase')).toHaveValue('chdash_ui', { timeout: 20_000 });
  // (A list read for one database names that one: its count is not known.)
  await expect(databasePicker.locator('.tracePicker__button')).toHaveText('Database · chdash_ui');
});

test('a database or table name with quotes, backslashes and dots goes to the server as it is', async ({ page }) => {
  const database = "o'brien\\x\" OR '1'='1";
  const table = `${database}.my.t'able`;
  const asked = listRequest(page, (params) => params.get('database') === database && params.get('table') === table);
  await page.goto(`/system/queries?database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`);
  const request = await asked;
  const answer = await (await request.response()).json();
  expect(answer.status).toBe('ok');
  expect([answer.database, answer.table]).toEqual([database, table]);
  expect(answer.queries).toEqual([]);
  await expect(page.locator('#systemQueriesEmpty')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.systemQueries__databasePicker .tracePicker__button')).toHaveText(`Database · ${database}`);
  await expect(page.locator('.systemQueries__tablePicker .tracePicker__button')).toHaveText(`Table · ${table}`);
  // The address keeps them whole through another filter's change; an
  // invalid table (no dot) never reaches the server.
  await pick(page.locator('.systemQueries__kindPicker'), 'Select');
  await expect.poll(() => new URL(page.url()).searchParams.get('kind')).toBe('Select');
  expect(new URL(page.url()).searchParams.get('database')).toBe(database);
  expect(new URL(page.url()).searchParams.get('table')).toBe(table);
  const plain = listRequest(page, (params) => !params.has('table'));
  await page.goto('/system/queries?table=nodot');
  await plain;
});

test('a shape\'s SQL is formatted by the Query page\'s formatter; copy gives the formatted text', async ({ page }) => {
  const formats = [];
  page.on('request', (request) => { if (request.url().includes('/api/format')) formats.push(JSON.parse(request.postData() || '{}')); });
  await openQueries(page, '?sort=calls&kind=Select');
  // A shape with a FROM clause and literals (normalized to ?).
  const index = await queryRows(page).evaluateAll((rows) => rows.findIndex((row) => {
    const sql = row.querySelector('.systemQueries__sql')?.title || '';
    return /^SELECT\b/.test(sql) && /\bFROM\b/.test(sql) && sql.includes('?') && sql.length > 50;
  }));
  expect(index).toBeGreaterThanOrEqual(0);
  await queryRows(page).nth(index).click();
  const wrap = page.locator('#systemQuerySql');
  await expect(wrap).toHaveAttribute('data-formatted', '1', { timeout: 20_000 });
  const code = wrap.locator('.sqlBlock__code');
  const shown = await code.textContent();
  // Formatted: on several lines, the clauses at the start of a line.
  expect(shown.split('\n').length).toBeGreaterThan(1);
  expect(shown).toMatch(/^SELECT\b/);
  expect(shown).toMatch(/\n\s*FROM\b/);
  // The normalized placeholders are back: no numeric stand-in left.
  expect(shown).not.toMatch(/\b9\d{4}\b/);
  // The formatter got numeric literals, never normalizeQuery's ? (no SQL parses it).
  expect(formats.length).toBeGreaterThan(0);
  const sent = formats[formats.length - 1].sqls[0];
  expect(sent).not.toContain('?');
  // The same text, whitespace aside, as the normalized query (the formatter
  // may spell a keyword in capitals or add ASC).
  const raw = await page.evaluate(async (hash) => {
    const host = window.ChDash.state.selectedHostId;
    const response = await fetch(`/api/system/queries/${hash}?host_id=${encodeURIComponent(host)}`);
    return (await response.json()).normalized;
  }, shapeHash(page));
  const placeholders = (text) => (text.match(/\?(\.\.)?/g) || []).join(' ');
  expect(placeholders(shown)).toBe(placeholders(raw));
  // Copy gives the formatted text; no other copy button (the raw text is not offered).
  await captureCopies(page);
  await wrap.locator('.sqlBlock__copy').click();
  await expect.poll(() => copiedText(page)).toBe(shown.replace(/\s+$/, ''));
  await expect(page.locator('#systemQueryCopyRaw')).toHaveCount(0);
});

test('a shape\'s INSERT with many columns is laid out by the formatter: the columns break, FORMAT has its line', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  const columns = Array.from({ length: 18 }, (_, i) => `\`column_${i}\``).join(', ');
  await page.route(new RegExp(`/api/system/queries/${hash}\\?`), async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.normalized = `INSERT INTO db.events (${columns}) FORMAT Native`;
    await route.fulfill({ response, json });
  });
  await page.goto(`/system/queries/${hash}?sort=calls`);
  const wrap = page.locator('#systemQuerySql');
  await expect(wrap).toHaveAttribute('data-formatted', '1', { timeout: 30_000 });
  const lines = (await wrap.locator('.sqlBlock__code').textContent()).split('\n');
  expect(lines[0]).toBe('INSERT INTO db.events');
  expect(lines.length).toBe(18 + 4);
  expect(lines.at(-1)).toBe('FORMAT Native');
});

test('a long shape SQL scrolls inside its block (no "Show all N lines"), and Raw shows the normalized text', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  const columns = Array.from({ length: 40 }, (_, i) => `col${i}`).join(', ');
  const normalized = `SELECT ${columns} FROM db.events WHERE id IN (?..) AND ts > ? LIMIT ?`;
  await page.route(new RegExp(`/api/system/queries/${hash}\\?`), async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.normalized = normalized;
    await route.fulfill({ response, json });
  });
  await page.goto(`/system/queries/${hash}?sort=calls`);
  const wrap = page.locator('#systemQuerySql');
  await expect(wrap).toHaveAttribute('data-formatted', '1', { timeout: 30_000 });
  const block = wrap.locator('.sqlBlock');
  // A scroll bar, no fold: the block is as tall as 14 lines and its body scrolls.
  await expect(block.locator('.sqlBlock__expand')).toHaveCount(0);
  await expect(block).toHaveClass(/\bis-scroll\b/);
  const body = block.locator('.sqlBlock__body');
  const metrics = await body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  expect(metrics.overflowY).toBe('auto');
  expect(metrics.scroll).toBeGreaterThan(metrics.client + 20);
  expect((await block.locator('.sqlBlock__gutter').textContent()).trim().split('\n').length).toBeGreaterThan(40);
  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The text is the formatter's (one column to a line); Raw shows what query_log has, and back.
  const view = page.locator('#systemQueryView');
  const raw = view.getByRole('button', { name: 'Raw' });
  const formatted = view.getByRole('button', { name: 'Formatted' });
  await expect(formatted).toHaveAttribute('aria-pressed', 'true');
  await expect(raw).toHaveAttribute('aria-pressed', 'false');
  expect((await block.locator('.sqlBlock__code').textContent()).split('\n').length).toBeGreaterThan(40);
  await raw.click();
  await expect(raw).toHaveAttribute('aria-pressed', 'true');
  await expect(formatted).toHaveAttribute('aria-pressed', 'false');
  await expect(wrap).toHaveAttribute('data-raw', '1');
  await expect(wrap).toHaveAttribute('data-formatted', '0');
  await expect(wrap.locator('.sqlBlock__code')).toHaveText(normalized);
  await formatted.click();
  await expect(raw).toHaveAttribute('aria-pressed', 'false');
  await expect(formatted).toHaveAttribute('aria-pressed', 'true');
  await expect(wrap).toHaveAttribute('data-formatted', '1');
  expect((await wrap.locator('.sqlBlock__code').textContent()).split('\n').length).toBeGreaterThan(40);
});

test('a shape\'s SQL the formatter cannot parse stays as logged', async ({ page }) => {
  await page.route(/\/api\/format$/, (route) => route.fulfill({ status: 422, json: { error_code: 'format_failed', message: 'Syntax error' } }));
  await openQueries(page, '?sort=calls');
  await queryRows(page).first().click();
  const wrap = page.locator('#systemQuerySql');
  await expect(wrap).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expect(wrap).toHaveAttribute('data-formatted', '0');
  await expect(page.locator('#systemQueryCopyRaw')).toHaveCount(0);
  const hash = shapeHash(page);
  const raw = await page.evaluate(async (h) => {
    const host = window.ChDash.state.selectedHostId;
    return (await (await fetch(`/api/system/queries/${h}?host_id=${encodeURIComponent(host)}`)).json()).normalized;
  }, hash);
  expect((await wrap.locator('.sqlBlock__code').textContent()).replace(/\s+$/, '')).toBe(raw.replace(/\s+$/, ''));
});

test('the placeholder mask leaves quoted text alone and keeps the AS column aligned', async ({ page }) => {
  await openQueries(page);
  const out = await page.evaluate(() => {
    const { maskPlaceholders, restorePlaceholders } = window.ChDash.systemQuerySql;
    const a = maskPlaceholders("SELECT `a?b`, \"c?\", '?' AS q, x IN (?..), [?..], ? -- why?\nFROM t /* ? */ LIMIT ?");
    const formatted = 'SELECT\n    sleepEachRow(90900)  AS `s`,\n    number               AS `n`\nFROM numbers(90901)';
    return {
      masked: a.sql,
      marks: a.marks,
      restored: restorePlaceholders(formatted, ['?', '?']),
      missing: restorePlaceholders('SELECT 90900', ['?', '?']),
      twice: restorePlaceholders('SELECT 90900, 90900', ['?']),
      collision: maskPlaceholders('SELECT 91234, ?'),
      ident: restorePlaceholders('SELECT x90900, 90900', ['?']),
    };
  });
  expect(out.masked).toBe("SELECT `a?b`, \"c?\", '?' AS q, x IN (90900), [90901], 90902 -- why?\nFROM t /* ? */ LIMIT 90903");
  expect(out.marks).toEqual(['?..', '?..', '?', '?']);
  expect(out.restored).toBe('SELECT\n    sleepEachRow(?)      AS `s`,\n    number               AS `n`\nFROM numbers(?)');
  expect(out.missing).toBeNull();
  expect(out.twice).toBeNull();
  expect(out.collision).toBeNull();
  expect(out.ident).toBe('SELECT x90900, ?');
});

test('a runner without the grant sees the GRANT; a disabled query_log says how to enable it', async ({ page }) => {
  const grant = 'GRANT SELECT ON system.query_log TO chdash_runner';
  let status = 'not_granted';
  await routeQueries(page, (json) => degrade(json, status, status === 'not_granted'
    ? { message: 'DB::Exception: chdash_runner: Not enough privileges. (ACCESS_DENIED)', hint: grant }
    : { message: 'system.query_log does not exist on this server.' }));
  await page.goto('/system/queries');
  const issue = page.locator('#systemQueriesNotes .systemIssue[data-reason="not_granted"]');
  await expect(issue).toBeVisible({ timeout: 20_000 });
  await expect(issue.locator('.badge')).toHaveText('Not granted');
  await expect(issue).toContainText('The runner account cannot read system.query_log');
  await expect(issue.locator('.systemIssue__code')).toHaveText(grant);
  await expect(issue.locator('.systemIssue__copy')).toHaveAttribute('aria-label', 'Copy the GRANT statement');
  // The list's filters leave the bar; the range and the refresh button stay.
  for (const selector of ['.systemQueries__kindPicker', '.systemQueries__errorsPicker', '.systemQueries__userPicker', '.systemQueries__databasePicker', '.systemQueries__tablePicker', '.systemQueries__orderPicker', '#systemQueriesHide']) {
    await expect(page.locator(selector), selector).toBeHidden();
  }
  await expect(page.locator('#systemQueriesRangeButton')).toBeVisible();
  await expect(page.locator('#systemRefresh-queries')).toBeVisible();
  await expect(queryRows(page)).toHaveCount(0);
  status = 'disabled';
  await page.reload();
  const disabled = page.locator('#systemQueriesNotes .systemIssue[data-reason="disabled"]');
  await expect(disabled).toContainText('system.query_log is disabled on this server', { timeout: 20_000 });
  await expect(disabled).toContainText('log_queries = 1');
  await expect(disabled.locator('.systemIssue__code')).toHaveCount(0);
});

test('a window past the read cap or the lookback narrows in one click', async ({ page }) => {
  let tooLarge = true;
  await routeQueries(page, (json) => {
    if (tooLarge) degrade(json, 'window_too_large', { message: "DB::Exception: Limit for rows (controlled by 'max_rows_to_read' setting) exceeded", suggested_span_ms: 900_000 });
  });
  await page.goto('/system/queries?from=now-24h&to=now');
  const issue = page.locator('#systemQueriesNotes .systemIssue[data-reason="window_too_large"]');
  await expect(issue).toContainText('system.query_log_max_rows', { timeout: 20_000 });
  await expect(issue).toContainText('50,000,000 rows');
  tooLarge = false;
  await issue.locator('#systemQueriesNarrow').click();
  await expect(page).toHaveURL(/queries\?from=now-15m&to=now$/);
  await expect(queryRows(page).first()).toBeVisible({ timeout: 20_000 });
  // Past query_log_max_lookback_hours (a deep link): the last 7 days instead.
  await page.goto('/system/queries?from=now-30d&to=now');
  const lookback = page.locator('#systemQueriesNotes .systemIssue[data-reason="range_too_large"]');
  await expect(lookback).toContainText('at most 7 days', { timeout: 20_000 });
  await lookback.locator('#systemQueriesNarrow').click();
  await expect(page).toHaveURL(/queries\?from=now-7d&to=now$/);
  await expect(page.locator('#systemQueriesRangeButton')).toHaveText('Time range · Last 7 days');
});

test('the error share of a shape reads neutral under 1 %, warning to 5 %, danger past it', async ({ page }) => {
  await routeQueries(page, (json) => {
    const shares = [0.004, 0.03, 0.08];
    json.queries.slice(0, 3).forEach((item, i) => {
      item.calls = 1000;
      item.errors = Math.round(1000 * shares[i]);
    });
  });
  await openQueries(page);
  const badges = queryRows(page).locator('.systemQueries__errors [data-error-rate]');
  await expect(badges.nth(0)).toHaveAttribute('data-error-rate', 'neutral');
  await expect(badges.nth(1)).toHaveAttribute('data-error-rate', 'warn');
  await expect(badges.nth(2)).toHaveAttribute('data-error-rate', 'error');
  await expect(badges.nth(2)).toHaveClass(/badge--error/);
  await expect(badges.nth(1)).toHaveText('30 · 3%');
});

for (const width of [390, 360]) {
  test.describe(`Queries on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`Queries and a shape fit the viewport at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      const paneOverflow = () => panel(page, 'queries').evaluate((el) => el.scrollWidth - el.clientWidth);
      await openQueries(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      // The query and its total time; the calls, kind and users in its meta line.
      await expect(page.locator('#systemQueriesTable thead th:visible')).toHaveText(['Query', 'Total time']);
      await expect(queryRows(page).first().locator('.systemQueries__metaCalls')).toBeVisible();
      // The filter bar folds into its summary line; unfolded, it wraps: Kind,
      // Errors, User, Order by and Hide ChDash all visible inside the
      // viewport, none cut, none overlapping.
      await expect(page.locator('#systemBar-queries .obsFilterSummary')).toHaveAttribute('aria-expanded', 'false');
      await page.locator('#systemBar-queries .obsFilterSummary').click();
      const filters = ['.systemQueries__kindPicker', '.systemQueries__errorsPicker', '.systemQueries__userPicker', '.systemQueries__databasePicker', '.systemQueries__tablePicker', '.systemQueries__orderPicker', '#systemQueriesHide'];
      const boxes = [];
      for (const sel of filters) {
        await expect(page.locator(sel)).toBeVisible();
        const box = await page.locator(sel).boundingBox();
        expect(box.x, sel).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, sel).toBeLessThanOrEqual(width + 0.5);
        boxes.push({ sel, ...box });
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const overlap = a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
          expect(overlap, `${a.sel} / ${b.sel}`).toBe(false);
        }
      }
      expect(await page.locator('#systemBar-queries').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      await expect(page.locator('#systemQueriesSort')).toHaveCount(0);
      const wrap = await page.locator('.systemQueries__wrap').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(wrap).toBeLessThanOrEqual(0);
      // 40 px targets, the rows too.
      expect(await smallTouchTargets(page)).toEqual([]);
      expect((await queryRows(page).first().boundingBox()).height).toBeGreaterThanOrEqual(40);
      // The range alone on its first row; the refresh button ends the bar.
      const range = await page.locator('#systemQueriesRangeButton').boundingBox();
      const refresh = await page.locator('#systemRefresh-queries').boundingBox();
      const barBox = await page.locator('#systemBar-queries').boundingBox();
      expect(range.width).toBeGreaterThan(width - 40);
      expect(refresh.y).toBeGreaterThan(range.y + range.height / 2);
      expect(Math.round(barBox.x + barBox.width - refresh.x - refresh.width)).toBe(12);
      await queryRows(page).first().click();
      await expect(page.locator('#systemQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      await expect(page.locator('#systemQueryRuns thead th:visible')).toHaveText(['Time', 'Duration', 'Status']);
      // A size band cell (treemap rectangle, strip segment) is as large as its share of the data.
      expect(await smallTouchTargets(page, { skip: ['.explorerTreemap__node', '.explorerStorageStrip__segment'] })).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Disks: a card per disk, the growth, the bytes by database (a database opens
// its storage in the Explorer) and the policies, over /api/system/disks and the
// series panel disk_growth. Fill tones and forecasts come from mocked answers:
// the stack's own disk is whatever the machine has.

// The card of a disk (one per filesystem: data-disks lists its disks) and the
// disk's own facts (the card of a disk alone, or its block in a shared card).
const diskCard = (page, name) => page.locator(`#systemDiskCards .systemDisk[data-disks~="${name}"]`);
const diskOwn = (page, name) => page.locator(`#systemDiskCards [data-disk="${name}"]`);

async function openDisks(page, query = '') {
  await page.goto(`/system/disks${query}`);
  await expect(diskCard(page, 'default')).toBeVisible({ timeout: 30_000 });
}

const routeDisks = routeJson(/\/api\/system\/disks\?/);
const routeGrowth = routeJson(/\/api\/system\/series\?.*panel=disk_growth/);

test('Disks shows a card per disk, its growth, the bytes by database and the policies', async ({ page }) => {
  await openDisks(page);
  await expect(selectedSection(page)).toHaveText('Disks');
  await expect(page.locator('#systemDisksRangeButton')).toHaveText('Time range · Last 7 days');
  // No Auto-refresh: the disks are cached a minute, the growth five.
  await expect(page.locator('#systemAutoRefresh-disks')).toHaveCount(0);
  // Three tiles: no "Soonest full" (each disk's card says how long it lasts).
  await expect(page.locator('.systemDisks__tiles > .statTile .statTile__label')).toHaveText(['Disks', 'Fullest', 'ClickHouse data']);
  await expect(page.locator('[data-tile="soonest"]')).toHaveCount(0);
  await expect(panel(page, 'disks')).not.toContainText('Soonest full');
  // The fixture disks, their fill on its own track, their policies.
  for (const name of ['default', 'fixture_hot', 'fixture_warm']) {
    const card = diskCard(page, name);
    await expect(card.locator('.systemDisk__name')).toContainText(name);
    await expect(card.locator('.shareBar__text')).toHaveText(/^\d+(?:\.\d+)?%$/);
    await expect(diskOwn(page, name).locator('[data-fact="path"] .systemDisk__value')).toHaveText(/^\/var\/lib\/clickhouse\//);
  }
  await expect(diskOwn(page, 'fixture_hot').locator('[data-fact="policies"]')).toContainText('fixture_tiered / hot');
  await expect(diskOwn(page, 'fixture_warm').locator('[data-fact="policies"]')).toContainText('fixture_tiered / warm');
  // The growth charts draw (the week, or whatever this stack holds).
  await expect(page.locator('#systemDiskChart-used .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemDiskChart-merge_tree')).toBeVisible();
  await expect(page.locator('#systemDiskChart-written')).toBeVisible();
  await expect(page.locator('#systemDiskChart-used .chartCore__legendItem').first()).toContainText('default');
  // Bytes by database: the tiered fixture on its hot disk, a share bar beside its figure.
  const hot = page.locator('.systemDiskDb[data-disk="fixture_hot"]');
  await expect(hot.locator('tbody tr[data-database="chdash_ui"] .shareBar__text')).toHaveText(/%$/);
  await expect(hot.locator('.explorerStorageStrip__segment[data-database="chdash_ui"]')).toBeAttached();
  // The policies, volumes in priority order.
  const policy = page.locator('#systemDiskPolicyTable');
  await expect(policy.locator('tr[data-policy="fixture_tiered"]')).toHaveCount(2);
  await expect(policy.locator('tr[data-policy="fixture_tiered"] td:nth-child(2)')).toHaveText(['hot #1', 'warm #2']);
});

test('a database opens on its storage in the Explorer, from the table or the stacked bar', async ({ page }) => {
  await openDisks(page);
  const hot = page.locator('.systemDiskDb[data-disk="fixture_hot"]');
  const link = hot.locator('tbody tr[data-database="chdash_ui"] a.systemDiskDb__link');
  // The former Storage tab address: the database page, scrolled to its storage.
  await expect(link).toHaveAttribute('href', /\/explorer\/catalog\/chdash_ui\?tab=storage$/);
  await link.click();
  await expect(page).toHaveURL(/\/explorer\/catalog\/chdash_ui$/, { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#explorerDatabaseStorageStrip, #explorerDatabaseTreemap').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#explorerDatabaseStorage')).toBeInViewport();
  // Back returns to the section.
  await page.goBack();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  // A segment of the stacked bar does the same.
  await expect(hot).toBeVisible({ timeout: 20_000 });
  await hot.locator('.explorerStorageStrip__segment[data-database="chdash_ui"]').click();
  await expect(page).toHaveURL(/\/explorer\/catalog\/chdash_ui$/, { timeout: 20_000 });
});

test('the fill reads neutral under 80 %, warning to 90 %, danger from 90 %', async ({ page }) => {
  const shares = { default: 0.79, fixture_hot: 0.85, fixture_warm: 0.95 };
  await routeDisks(page, (json) => {
    for (const disk of json.disks) {
      const share = shares[disk.name];
      if (share == null) continue;
      disk.total_space = 1000 * 2 ** 30;
      disk.free_space = Math.round(disk.total_space * (1 - share));
      disk.used_space = disk.total_space - disk.free_space;
    }
  });
  await openDisks(page);
  await expect(diskCard(page, 'default')).toHaveAttribute('data-fill', 'neutral');
  await expect(diskCard(page, 'fixture_hot')).toHaveAttribute('data-fill', 'warn');
  await expect(diskCard(page, 'fixture_warm')).toHaveAttribute('data-fill', 'error');
  await expect(diskCard(page, 'fixture_warm').locator('.shareBar__text')).toHaveText('95%');
  await expect(diskCard(page, 'fixture_hot').locator('.systemDisk__summary')).toHaveText('850.0 GB used of 1.0 TB');
  const fullest = page.locator('[data-tile="fullest"]');
  await expect(fullest).toHaveAttribute('data-fill', 'error');
  await expect(fullest.locator('.statTile__sub')).toHaveText('fixture_warm');
});

test('days until full: a growing disk, a flat one, too little history', async ({ page }) => {
  await routeGrowth(page, (json) => {
    const set = (name, trend) => { const disk = json.disks.find((d) => d.name === name); if (disk) disk.trend = { points: 168, span_seconds: 601200, ...trend }; };
    set('default', { status: 'growing', slope_bytes_per_day: 10 * 2 ** 30, days_until_full: 5.4 });
    set('fixture_hot', { status: 'not_growing', slope_bytes_per_day: -(2 ** 20), days_until_full: null });
    set('fixture_warm', { status: 'not_enough_history', points: 3, span_seconds: 1200, slope_bytes_per_day: null, days_until_full: null });
  });
  // Three filesystems (the fixture's disks share one: their capacities apart).
  await routeDisks(page, (json) => {
    json.disks.forEach((disk, index) => { disk.total_space = (1000 + index) * 2 ** 30; disk.free_space = Math.round(disk.total_space * 0.5); });
  });
  await openDisks(page);
  const until = (name) => diskCard(page, name).locator('[data-fact="until_full"]');
  await expect(until('default').locator('.systemDisk__value')).toHaveText(/^5 days\s*\+10\.0 GB\/day$/, { timeout: 20_000 });
  await expect(until('default')).toHaveAttribute('data-tone', 'error');
  await expect(until('fixture_hot').locator('.systemDisk__value')).toContainText('Not growing');
  await expect(until('fixture_warm').locator('.systemDisk__value')).toContainText('Not enough history');
  // The forecast lives on the disk's card only.
  await expect(page.locator('[data-tile="soonest"]')).toHaveCount(0);
});

test('fifteen minutes of history makes no forecast', async ({ page }) => {
  const answer = page.waitForResponse((response) => response.url().includes('/api/system/series?') && response.url().includes('panel=disk_growth'), { timeout: 30_000 });
  await openDisks(page, '?from=now-15m&to=now');
  await expect(page.locator('#systemDiskHistoryNote')).toContainText('Not enough history for a forecast: it needs at least 6 samples over 6 h', { timeout: 20_000 });
  await expect(diskCard(page, 'default').locator('[data-fact="until_full"]')).toContainText('Not enough history');
  // 10 s buckets.
  expect((await (await answer).json()).step_seconds).toBe(10);
});

test('without asynchronous_metric_log the growth says what it needs', async ({ page }) => {
  await routeGrowth(page, (json) => {
    json.sources.asynchronous_metric_log = { ...json.sources.asynchronous_metric_log, status: 'disabled', message: '', hint: '', rows_read: 0 };
    delete json.series.merge_tree_bytes;
    for (const disk of json.disks) { disk.used = []; disk.trend = { status: 'not_enough_history', points: 0, span_seconds: 0, slope_bytes_per_day: null, days_until_full: null }; }
    json.unavailable_panels = [{ panel: 'asynchronous_metric_log', table: 'asynchronous_metric_log', reason: 'disabled', message: '', hint: '' }];
  });
  await openDisks(page);
  await expect(page.locator('#systemDiskGrowthNotes')).toContainText('Growth needs system.asynchronous_metric_log', { timeout: 20_000 });
  await expect(page.locator('#systemDiskChart-used')).toBeHidden();
  await expect(page.locator('#systemDiskChart-merge_tree')).toBeHidden();
  // part_log still says what was written, on the whole row.
  await expect(page.locator('#systemDiskChart-written')).toBeVisible();
  await expect(page.locator('#systemDiskChart-written')).toHaveClass(/is-alone/);
  await expect(diskCard(page, 'default').locator('[data-fact="until_full"]')).toContainText('Needs asynchronous_metric_log');
});

test('a panel the system account may not read shows the GRANT; the rest stays', async ({ page }) => {
  const hint = 'GRANT SELECT ON system.storage_policies TO chdash_system';
  await routeDisks(page, (json) => {
    json.policies = [];
    json.unavailable_panels = [{ panel: 'policies', table: 'storage_policies', reason: 'not_granted', message: 'Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)', hint }];
  });
  await openDisks(page);
  const issue = page.locator('#systemDiskPolicies .systemIssue[data-reason="not_granted"]');
  await expect(issue.locator('.systemIssue__code')).toHaveText(hint);
  await expect(page.locator('[data-tile="disks"] .statTile__sub')).toHaveText('storage policies unreadable');
  await expect(page.locator('#systemDiskDatabases tbody tr').first()).toBeVisible();
});

test('only the default policy reads as one line; a drag narrows the growth window', async ({ page }) => {
  await routeDisks(page, (json) => {
    json.policies = [{ name: 'default', volumes: [{ name: 'default', priority: 1, disks: ['default'], volume_type: 'JBOD', max_data_part_size: 0, move_factor: 0, prefer_not_to_merge: false, perform_ttl_move_on_insert: true, load_balancing: 'ROUND_ROBIN' }] }];
  });
  await openDisks(page, '?from=now-6h&to=now');
  await expect(page.locator('#systemDiskPolicySingle')).toHaveText('Only the default policy: every MergeTree table writes to default.');
  const plot = page.locator('#systemDiskChart-used .chartCore');
  await expect(plot).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  const box = await plot.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/system\/disks\?from=\d{4}-\d\d-\d\d(?:\+|%20)\d\d%3A\d\d%3A\d\d&to=/);
});

for (const width of [390, 360]) {
  test.describe(`Disks on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`Disks fits the viewport at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      await openDisks(page);
      await expect(page.locator('#systemDiskChart-used .chartCore canvas')).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await panel(page, 'disks').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      // One card a row, long paths wrapped rather than cut.
      const cards = await page.locator('#systemDiskCards .systemDisk').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(cards).size).toBe(1);
      const path = diskOwn(page, 'fixture_warm').locator('[data-fact="path"] .systemDisk__value');
      expect(await path.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe('ellipsis');
      expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      // The tables fit without their own sideways scroll.
      for (const wrap of await page.locator('#systemDiskDatabases .dataTableWrap, #systemDiskPolicies .dataTableWrap').all()) {
        expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      }
      await expect(page.locator('#systemDiskPolicyTable thead th:visible')).toHaveText(['Policy', 'Volume', 'Disks']);
      // 40 px targets, the database links included; unfolded, the range
      // leads the bar and the refresh button ends it.
      await page.locator('#systemBar-disks .obsFilterSummary').click();
      expect(await smallTouchTargets(page)).toEqual([]);
      const range = await page.locator('#systemDisksRangeButton').boundingBox();
      const refresh = await page.locator('#systemRefresh-disks').boundingBox();
      const barBox = await page.locator('#systemBar-disks').boundingBox();
      expect(refresh.y).toBeGreaterThan(range.y + range.height / 2);
      expect(Math.round(barBox.x + barBox.width - refresh.x - refresh.width)).toBe(12);
    });
  });
}

// ---------------------------------------------------------------------------
// Time axes of every System chart: the labels and the date lines under
// them never run into each other ("Oct 2 2026Oct 3 2026" under the first
// ticks of a 24 h Disks chart), and the year shows on the first date only
// (and where it changes), at each quick range, on a desktop and a phone page.

test('time axes keep their labels and date lines apart at 1 h, 24 h, 7 d and 30 d, on 1440 and 390 px pages', async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of ['overview', 'queries', 'disks']) {
      // Queries reads at most 7 days of query_log (a longer range offers the last 7 days).
      for (const range of section === 'queries' ? ['1h', '24h', '7d'] : ['1h', '24h', '7d', '30d']) {
        await page.goto(`${section === 'overview' ? '/system' : `/system/${section}`}?from=now-${range}&to=now`);
        // Queries charts the timeline of a shape: the first one opens.
        if (section === 'queries') {
          await expect(queryRows(page).first()).toBeVisible({ timeout: 30_000 });
          await queryRows(page).first().click();
        }
        const charts = page.locator(section === 'overview' ? '#systemPerfGrid .chartCore' : `#systemPanel-${section} .chartCore`);
        await expect(charts.first()).toHaveAttribute('data-x-ticks', /^\[\["/, { timeout: 30_000 });
        const where = `${section} ${range} at ${width}`;
        if (section === 'overview') await page.locator('#systemPart-performance').scrollIntoViewIfNeeded();
        // [label, date line, left, right, date left, date right] of each label drawn.
        const axes = await charts.evaluateAll((els) => els.filter((el) => el.offsetWidth && el.dataset.xTicks).map((el) => JSON.parse(el.dataset.xTicks)));
        expect(axes.length, where).toBeGreaterThanOrEqual(1);
        for (const ticks of axes) {
          if (!ticks.length) continue;
          expect(xLabelCollisions(ticks), `${where}: ${JSON.stringify(ticks)}`).toEqual([]);
          expect(xRepeatedYears(ticks), `${where}: ${JSON.stringify(ticks)}`).toEqual([]);
          expect(ticks.find((t) => t[1])?.[1], `${where}: ${JSON.stringify(ticks)}`).toMatch(/ ?\d{4}$/);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Audit round 2, System: the Overview's range in the tab row, charts at 0 as
// one line, legend swatches, axis units; the query shape's title, durations
// and kind casing; one card per filesystem on Disks, the cards sharing the row.

test.describe('audit round 2: System', () => {
  test('the Overview\'s time range leads its filter bar, before the refresh button, as on Queries and Disks', async ({ page }) => {
    await openOverview(page);
    const bar = page.locator('#systemBar-overview');
    await expect(bar.locator('#systemPerfRangeButton')).toBeVisible();
    const order = await bar.evaluate((el) => [...el.querySelectorAll('.obsFilterBar__range, #systemRefresh-overview')]
      .map((node) => [node.classList.contains('obsFilterBar__range') ? 'range' : 'refresh', Math.round(node.getBoundingClientRect().left)]));
    expect(order.map(([name]) => name)).toEqual(['range', 'refresh']);
    expect(order.map(([, x]) => x)).toEqual([...order.map(([, x]) => x)].sort((a, b) => a - b));
    await expect(page.locator('#systemPart-performance .pagePart__head .tracePicker--range')).toHaveCount(0);
    // The same place as on Queries.
    const overview = await page.locator('#systemPerfRangeButton').boundingBox();
    await page.locator('#systemTab-queries').click();
    const queries = await page.locator('#systemQueriesRangeButton').boundingBox();
    expect(Math.abs(overview.y - queries.y)).toBeLessThanOrEqual(1);
  });

  test('a chart at 0 over the whole range is its title and one line, last, on its own row; a chart left alone takes its row', async ({ page }) => {
    await routeSeries(page, (json) => {
      json.series.replicas_max_delay = json.series.replicas_max_delay.map((v) => (v == null ? null : 0));
    });
    await openPerformance(page);
    const card = chartCard(page, 'replication');
    await expect(card).toHaveClass(/is-flat/, { timeout: 20_000 });
    await expect(card.locator('.systemChart__flat')).toHaveText('Max delay 0 s over the whole range');
    await expect(card.locator('.chartCore')).toHaveCount(0);
    await expect(card.locator('.chartCard__meta')).toHaveText('');
    const grid = await page.locator('#systemPerfGrid').boundingBox();
    const flat = await card.boundingBox();
    expect(flat.width).toBeGreaterThan(grid.width - 2);
    expect(flat.height).toBeLessThan(110);
    // Last in the grid; the charts above it two a row, an odd one out on the whole row.
    const cards = await page.locator('#systemPerfGrid .systemChart:not([hidden])').evaluateAll((els) => els
      .map((el) => ({ id: el.dataset.chart, top: el.getBoundingClientRect().top, width: el.getBoundingClientRect().width, alone: el.classList.contains('is-alone') }))
      .sort((a, b) => a.top - b.top));
    expect(cards[cards.length - 1].id).toBe('replication');
    const drawn = cards.filter((item) => item.id !== 'replication');
    if (drawn.length % 2 === 1) {
      const last = drawn[drawn.length - 1];
      expect(last.alone).toBe(true);
      expect(last.width).toBeGreaterThan(grid.width - 2);
    }
    expect(drawn.filter((item) => item.alone).length).toBe(drawn.length % 2);
  });

  test('a delay above 0 draws the Replication chart again', async ({ page }) => {
    await routeSeries(page, (json) => {
      json.series.replicas_max_delay = json.series.replicas_max_delay.map((v, i) => (v == null ? null : (i % 7) * 3));
    });
    await openPerformance(page);
    await expect(chartRoot(page, 'replication')).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
    await expect(chartCard(page, 'replication')).not.toHaveClass(/is-flat/);
  });

  test('axes carry their units (CPU in cores, merges in tasks running); a hidden series keeps a full-colour swatch, its name struck through', async ({ page }) => {
    await routeSeries(page, (json) => {
      json.series.merges_running = json.series.merges_running.map((v, i) => (v == null ? null : (i % 5) / 10));
    });
    await openPerformance(page);
    const cpuTicks = JSON.parse(await chartRoot(page, 'cpu').getAttribute('data-y-ticks'));
    expect(cpuTicks.filter((label) => label !== '0').length).toBeGreaterThan(0);
    for (const label of cpuTicks) expect(label).toMatch(/^0$| cores$/);
    await expect(chartRoot(page, 'merges')).toHaveAttribute('data-y-ticks', /running/, { timeout: 20_000 });
    for (const label of JSON.parse(await chartRoot(page, 'merges').getAttribute('data-y-ticks'))) expect(label).toMatch(/^0$| running$/);
    // Background pools: the pool sizes start hidden.
    const hidden = chartCard(page, 'pools').locator('.chartCore__legendItem[aria-pressed="false"]');
    await expect(hidden).toHaveCount(2);
    for (const item of await hidden.all()) {
      expect(await item.locator('i').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      expect(await item.locator('span').evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('line-through');
    }
    const shown = chartCard(page, 'pools').locator('.chartCore__legendItem[aria-pressed="true"]').first();
    expect(await shown.locator('span').evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none');
  });

  test('a query shape: its first line as title (the hash in the tooltip), CPU as a duration, kinds as SQL writes them; sparse runs are dots under some headroom', async ({ page }) => {
    await openQueries(page, '?sort=calls');
    // The kind column and the filter read the same: SELECT, INSERT.
    const kinds = await queryRows(page).locator('td:nth-child(3)').allTextContents();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) expect(kind).toMatch(/^([A-Z]+|—)$/);
    await expect(page.locator('#systemQueriesKind option[value="Select"]')).toHaveText('SELECT');
    const row = queryRows(page).first();
    const hash = await row.getAttribute('data-hash');
    const normalized = await row.locator('.systemQueries__sql').getAttribute('title');
    const answer = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/api/system/queries/${hash}`));
    await row.click();
    const shape = await (await answer).json();
    const drill = page.locator('#systemQuery');
    // The query is drawn under the head, which has no title; the hash only names a shape without text.
    if (normalized) await expect(page.locator('#systemQuerySql')).toBeVisible({ timeout: 20_000 });
    await expect(drill.locator('.systemQuery__hash')).toHaveCount(normalized ? 0 : 1);
    await expect(drill.locator('.systemQuery__kind')).toHaveCount(0);
    // CPU: one duration format ("72.9 ms"), never "0.0729 s".
    const cpu = drill.locator('.systemQuery__tiles [data-tile="cpu"] .statTile__value');
    await expect(cpu).toHaveText(/^(<1 ms|\d+(?:\.\d+)? (?:ns|µs|ms|s)|\d+ min(?: \d+ s)?|\d+ h(?: \d+ min)?)$/, { timeout: 20_000 });
    await expect(cpu).not.toHaveText(/\d\.\d{3,} s/);
    await expect(page.locator('#systemQueryChart-cpu .chartCore')).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
    for (const label of JSON.parse(await page.locator('#systemQueryChart-cpu .chartCore').getAttribute('data-y-ticks'))) expect(label).toMatch(/^0$| (ms|s)$/);
    // The duration chart: p50 and p95, room above the largest run (yHeadroom).
    const latency = page.locator('#systemQueryChart-latency .chartCore');
    await expect(latency).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/);
    expect(Object.keys(JSON.parse(await latency.getAttribute('data-series-stats')))).toEqual(['p50', 'p95']);
    const largest = Math.max(...[...(shape.series.p50_ms || []), ...(shape.series.p95_ms || [])].filter((v) => v != null).map(Number));
    expect(largest).toBeGreaterThan(0);
    expect(Number(await latency.getAttribute('data-y-max'))).toBeGreaterThanOrEqual(largest * 1.14);
  });

  test('a sparse series marks its points (few values between gaps), a dense one stays a line; yHeadroom leaves room above the largest', async ({ page }) => {
    await openOverview(page);
    const result = await page.evaluate(async () => {
      const ns = window.ChDash;
      const host = document.createElement('div');
      host.style.width = '600px';
      document.body.appendChild(host);
      const xs = Float64Array.from({ length: 300 }, (_, i) => i * 60000);
      const sparse = new Float64Array(300).fill(NaN);
      for (const i of [10, 11, 80, 81, 82, 200]) sparse[i] = 1 + (i % 3);
      const dense = Float64Array.from(xs, (_, i) => 1 + Math.sin(i / 9));
      const draw = (values) => new Promise((resolve) => {
        const chart = ns.chartCore.create(host, { xs, xKind: 'time', series: [{ id: 's', label: 's', color: 'var(--qchart-1)', values, nulls: null }], height: 160, yHeadroom: 0.15, yInclude: [0] });
        const done = () => {
          const root = host.querySelector('.chartCore');
          if (!root || !root.dataset.pointsMarked) { requestAnimationFrame(done); return; }
          const out = { marked: root.dataset.pointsMarked, yMax: Number(root.dataset.yMax) };
          chart.destroy();
          resolve(out);
        };
        requestAnimationFrame(done);
      });
      const out = { sparse: await draw(sparse), dense: await draw(dense) };
      host.remove();
      return out;
    });
    expect(result.sparse.marked).toBe('1');
    expect(result.dense.marked).toBe('0');
    // The largest sparse value is 3: 15 % of the range above it.
    expect(result.sparse.yMax).toBeGreaterThanOrEqual(3.4);
  });

  test('Disks: disks on one filesystem share one card (its fill and forecast once, each disk\'s data, path and policies)', async ({ page }) => {
    await routeDisks(page, (json) => {
      for (const disk of json.disks) { disk.total_space = 1000 * 2 ** 30; disk.free_space = 400 * 2 ** 30 + (disk.name === 'fixture_hot' ? 4096 : 0); disk.unreserved_space = disk.free_space; }
    });
    await openDisks(page);
    const card = page.locator('#systemDiskCards .systemDisk.is-group');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-disks', 'default fixture_hot fixture_warm');
    await expect(card.locator('.systemDisk__name')).toHaveText('default, fixture_hot, fixture_warm');
    await expect(card.locator('.systemDisk__group')).toHaveText('3 disks, one filesystem');
    // The filesystem once: one fill, one free space, one forecast.
    await expect(card.locator('.shareBar__text')).toHaveCount(1);
    await expect(card.locator('.shareBar__text')).toHaveText('60%');
    await expect(card.locator('[data-fact="free"]')).toHaveCount(1);
    await expect(card.locator('[data-fact="until_full"]')).toHaveCount(1);
    // Each disk: its own data, path and policies.
    await expect(card.locator('.systemDisk__member')).toHaveCount(3);
    await expect(card.locator('.systemDisk__memberName')).toHaveText(['default', 'fixture_hot', 'fixture_warm']);
    for (const name of ['default', 'fixture_hot', 'fixture_warm']) {
      const own = card.locator(`.systemDisk__member[data-disk="${name}"]`);
      await expect(own.locator('[data-fact="path"]')).toHaveCount(1);
      await expect(own.locator('[data-fact="data"]')).toHaveCount(1);
      await expect(own.locator('[data-fact="policies"]')).toHaveCount(1);
    }
    await expect(page.locator('#systemDiskCards .systemDisk')).toHaveCount(1);
  });

  test('Disks: the cards share the row (auto-fit: no empty track after the last one)', async ({ page }) => {
    await routeDisks(page, (json) => {
      json.disks.forEach((disk, index) => { disk.total_space = (1000 + index) * 2 ** 30; disk.free_space = 500 * 2 ** 30; });
    });
    await openDisks(page);
    const cards = page.locator('#systemDiskCards .systemDisk');
    await expect(cards).toHaveCount(3);
    const grid = await page.locator('#systemDiskCards').boundingBox();
    const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ top: Math.round(r.top), left: r.left, right: r.right, width: r.width })));
    // One row (3 x 340 px fit at desktop width), the last card ending at the grid's edge.
    expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
    expect(Math.abs(boxes[boxes.length - 1].right - (grid.x + grid.width))).toBeLessThanOrEqual(1);
    for (const box of boxes) expect(box.width).toBeGreaterThanOrEqual(340);
  });
});
