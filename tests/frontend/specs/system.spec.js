import { test, expect } from '@playwright/test';
import { horizontalOverflow, smallTouchTargets } from '../helpers/app.js';
import { xLabelCollisions, xRepeatedYears } from '../helpers/charts.js';

// The System page (docs/system.md): its entry in the page switcher, its
// underlined section tabs (Overview, Queries, Disks), its addresses and Back /
// Forward, the redirects of the Explorer's former Monitoring and Server
// operations addresses, the merged Overview (tiles, databases, cluster,
// performance, activity, top to bottom) with its Auto-refresh, and the
// degraded states from mocked answers (single node, no Keeper, a panel the
// system account may not read, an answer that fails).

const tabs = (page) => page.locator('.systemPage__tabs [role="tab"]');
const selectedSection = (page) => page.locator('.systemPage__tabs [role="tab"][aria-selected="true"]');
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
  await page.goto('/explorer');
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
  await expect(page).toHaveURL(/\/explorer$/, { timeout: 20_000 });
});

test('the Explorer shows only Catalog | Functions and loads no System module', async ({ page }) => {
  await page.goto('/explorer');
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
  await expect(page.locator('#explorerViewTabs .viewTab')).toHaveText(['Catalog', 'Functions']);
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
  await expect(page.locator('.systemPart__title')).toHaveText(['Databases', 'Cluster', 'Performance', 'Activity']);
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
  await expect(keeper.locator('[data-row="latency"]')).toContainText(/\d+(?:\.\d+)? ms average/);
  await expect(keeper.locator('[data-row="requests"]')).toContainText('in flight');
  await expect(page.locator('#systemKeeper')).toHaveCount(1);
  await expect(page.locator('.systemActivitySection[data-section="keeper"]')).toHaveCount(0);
  const replication = page.locator('#systemReplication');
  await expect(replication).toContainText(/\d+ replicated tables/);
  await expect(replication.locator('[data-tile="status"] .statTile__value')).toHaveText('Healthy');

  // Performance and Activity draw on the same page.
  await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemActivityReplicas')).toContainText('replicated_events', { timeout: 20_000 });
  // "Show the tables" brings the Activity's replicas into view.
  await page.locator('#systemReplicationTables').click();
  await expect(page.locator('.systemActivitySection[data-section="replicas"]')).toBeInViewport({ timeout: 5_000 });
});

test('the treemap of the databases draws their bytes on disk and a database opens its Explorer card', async ({ page }) => {
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
  await node.click();
  await expect(page).toHaveURL(new RegExp(`/explorer/${encodeURIComponent(name)}$`), { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailName')).toContainText(name, { timeout: 20_000 });
});

test('section tabs, deep links and Back / Forward', async ({ page }) => {
  await openOverview(page);
  await page.locator('#systemTab-disks').click();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  await expect(panel(page, 'overview')).toBeHidden();
  await expect(page.locator('#systemDiskCards .systemDisk').first()).toBeVisible({ timeout: 20_000 });
  // The controls of the section on screen sit in the tab row.
  await expect(page.locator('.systemPage__actions[data-section="disks"]')).toBeVisible();
  await expect(page.locator('.systemPage__actions[data-section="overview"]')).toBeHidden();
  // The tab keys move between the sections (the shared tab behaviour).
  await page.locator('#systemTab-disks').focus();
  await page.keyboard.press('Home');
  await expect(page).toHaveURL(/\/system$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/system\/queries$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/system$/);
  await expect(selectedSection(page)).toHaveText('Overview');
  await page.goBack();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  await page.goForward();
  await expect(selectedSection(page)).toHaveText('Overview');
  await expect(panel(page, 'overview')).toBeVisible();

  // A deep link opens its section; an unknown one falls back to Overview
  // (the address replaced).
  await page.goto('/system/queries');
  await expect(selectedSection(page)).toHaveText('Queries', { timeout: 20_000 });
  await page.goto('/system/no-such-section');
  await expect(page).toHaveURL(/\/system$/, { timeout: 20_000 });
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
  await expect(page.locator('#systemPart-performance')).toBeInViewport({ timeout: 20_000 });
  // The v2.14.0 Server operations and the former Activity: the Overview's Activity.
  for (const path of ['/explorer/_operations', '/explorer/_monitoring/activity']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/system#activity$/, { timeout: 20_000 });
    await expect(selectedSection(page)).toHaveText('Overview');
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
  await expect(page).toHaveURL(/\/explorer\/chdash_repl\/replicated_events$/, { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
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
  await expect(keeper.locator('[data-row="latency"]')).toContainText(/\d+(?:\.\d+)? ms average/);

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
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/wide_types$/);
});

test('Auto-refresh: tiles, cluster and activity every 5 s, charts every 30 s on short relative ranges, never while hidden', async ({ page }) => {
  await page.clock.install();
  const counts = { overview: 0, activity: 0, series: 0, disks: 0 };
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/system/overview?')) counts.overview += 1;
    else if (url.includes('/api/system/activity?')) counts.activity += 1;
    else if (url.includes('/api/system/series?')) counts.series += 1;
    else if (url.includes('/api/system/disks?')) counts.disks += 1;
  });
  await openOverview(page);
  await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  const option = page.locator('#systemAutoRefresh-overview');
  await expect(option).not.toBeChecked();
  // Off: nothing polls.
  let before = { ...counts };
  await page.clock.runFor(31_000);
  expect(counts.overview - before.overview).toBe(0);
  expect(counts.series - before.series).toBe(0);
  // On: the live parts at once and every 5 s, the charts every 30 s; the databases do not poll.
  await option.check();
  await page.waitForTimeout(300);
  before = { ...counts };
  for (let i = 0; i < 6; i++) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(150);
  }
  expect(counts.overview - before.overview).toBeGreaterThanOrEqual(5);
  expect(counts.activity - before.activity).toBeGreaterThanOrEqual(5);
  expect(counts.series - before.series).toBeGreaterThanOrEqual(1);
  expect(counts.series - before.series).toBeLessThanOrEqual(2);
  expect(counts.disks - before.disks).toBe(0);
  // Remembered per browser.
  expect(await page.evaluate(() => localStorage.getItem('chdash.system.autoRefresh'))).toBe('1');
  // Another section on screen: the Overview does not poll.
  await page.locator('#systemTab-queries').click();
  await page.waitForTimeout(300);
  before = { ...counts };
  await page.clock.runFor(31_000);
  await page.waitForTimeout(300);
  expect(counts.overview - before.overview).toBe(0);
  expect(counts.series - before.series).toBe(0);
  // A long or absolute range: the charts stop following the clock.
  await page.locator('#systemTab-overview').click();
  await page.locator('#systemPerfRangeButton').click();
  await page.locator('#systemPerfTimeRangePanel .timeRangeList__item', { hasText: 'Last 24 hours' }).click();
  await expect(page).toHaveURL(/\/system\?from=now-24h&to=now$/);
  await page.waitForTimeout(500);
  before = { ...counts };
  for (let i = 0; i < 7; i++) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(150);
  }
  expect(counts.series - before.series).toBe(0);
  expect(counts.overview - before.overview).toBeGreaterThanOrEqual(5);
  await option.uncheck();
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
  await expect(page.locator('#systemDatabaseMap .explorerTreemap__node').first()).toBeVisible({ timeout: 20_000 });
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
  await page.goto('/explorer');
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
      // The tabs on their own row, the controls under them; two tiles a row; the topology keeps its key columns.
      const tabsBox = await page.locator('.systemPage__tabs').boundingBox();
      const actions = await page.locator('.systemPage__actions[data-section="overview"]').boundingBox();
      expect(actions.y).toBeGreaterThanOrEqual(tabsBox.y + tabsBox.height - 1);
      const rows = await tiles(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
      expect(new Set(rows).size).toBe(4);
      await expect(page.locator('#systemTopology thead th:visible')).toHaveText(['Shard', 'Replica', 'Host', 'Errors']);
      // 40 px targets: the tabs, Auto-refresh, refresh, the range.
      for (const selector of ['#systemTab-overview', '#systemRefresh-overview', '.systemPage__actions[data-section="overview"] .systemBar__option', '#systemPerfRangeButton', '#systemReplicationTables']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(40);
      }
      // A treemap rectangle is as large as its share of the data.
      expect(await smallTouchTargets(page, { skip: ['.explorerTreemap__node'] })).toEqual([]);
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
  // The range sits on the part's heading.
  await expect(page.locator('#systemPart-performance .systemPart__head #systemPerfRangeButton')).toBeVisible();
  // Every chart has a card; the replicated fixture shows Replication too.
  for (const id of CHARTS) {
    await expect(chartCard(page, id)).toBeVisible();
    await expect(chartRoot(page, id)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/);
  }
  await expect(page.locator('#systemPerfGrid .systemChart:visible')).toHaveCount(10);
  await expect(chartCard(page, 'queries')).toHaveAttribute('data-source', 'metric_log');
  await expect(chartCard(page, 'queries').locator('.chartCore__legendItem')).toHaveText(['SELECT', 'INSERT', 'Other', 'Failed']);
  await expect(chartCard(page, 'latency').locator('.chartCore__legendItem')).toHaveText(['p50', 'p95', 'p99']);
  await expect(chartCard(page, 'cpu').locator('.chartCard__meta')).toContainText(/\d+ cores?/);
  // Two charts a row at desktop width, each filling its cell.
  const boxes = await page.locator('#systemPerfGrid .systemChart').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const plot = el.querySelector('.chartCore').getBoundingClientRect();
    return { left: Math.round(r.left), width: r.width, plot: plot.width };
  }));
  expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
  for (const box of boxes) expect(box.plot).toBeGreaterThan(box.width - 24);
  // No notes: every log is there.
  await expect(page.locator('#systemPerfNotes .systemIssue')).toHaveCount(0);
  // Auto-refresh (the Overview's one choice) is off by default.
  await expect(page.locator('#systemAutoRefresh-overview')).not.toBeChecked();
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
  for (const id of CHARTS) {
    const root = chartRoot(page, id);
    await expect.poll(async () => Number(await root.getAttribute('data-x-min')), { timeout: 15_000 }).toBeGreaterThan(before);
    const [lo, hi] = [Number(await root.getAttribute('data-x-min')), Number(await root.getAttribute('data-x-max'))];
    expect(lo).toBeGreaterThanOrEqual(range.from - 30_000);
    expect(hi).toBeLessThanOrEqual(range.to + 30_000);
    await expect(root).toHaveAttribute('data-zoomed', 'false');
  }
  // The picker shows the absolute range.
  await expect(page.locator('#systemPerfRangeButton')).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d \u2192 /);
  // Back: the default hour again.
  await page.goBack();
  await expect(page).toHaveURL(/\/system$/);
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Time range \u00b7 Last 1 hour');
  await expect.poll(async () => Number(await chartRoot(page, 'memory').getAttribute('data-x-min')), { timeout: 15_000 }).toBeLessThan(range.from - 60_000);
  // A deep link opens its range; another section drops it from the address.
  await page.goForward();
  await expect(page).toHaveURL(/\/system\?from=/);
  await page.locator('#systemTab-queries').click();
  await expect(page).toHaveURL(/\/system\/queries$/);
  await page.locator('#systemTab-overview').click();
  await expect(page).toHaveURL(/\/system\?from=/);
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

test('a hidden Overview draws no chart', async ({ page }) => {
  await openPerformance(page);
  // A refresh whose answer lands after the section is hidden.
  let landed = false;
  await page.route(/\/api\/system\/series\?/, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ response });
    landed = true;
  });
  await page.locator('#systemRefresh-overview').click();
  await page.locator('#systemTab-queries').click();
  await expect(page.locator('#systemPart-performance')).toBeHidden();
  // A draw already scheduled before the click runs in the next frame.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => window.ChDash.chartCore.resetCounters());
  await expect.poll(() => landed, { timeout: 10_000 }).toBe(true);
  // A resize and a theme change would redraw every chart on screen.
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 300)));
  expect((await page.evaluate(() => window.ChDash.chartCore.counters())).draws).toBe(0);
  // Shown again: one coalesced draw per chart.
  await page.locator('#systemTab-overview').click();
  await expect(chartRoot(page, 'cpu')).toBeVisible();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const draws = (await page.evaluate(() => window.ChDash.chartCore.counters())).draws;
  expect(draws).toBeGreaterThanOrEqual(1);
  expect(draws).toBeLessThanOrEqual(CHARTS.length * 2);
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
  expect(counters.draws).toBeGreaterThanOrEqual(CHARTS.length);
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
      const boxes = await page.locator('#systemPerfGrid .systemChart:visible').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), plot: el.querySelector('.chartCore').getBoundingClientRect().width };
      }));
      expect(new Set(boxes.map((box) => box.left)).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(width - 40);
        expect(box.plot).toBeGreaterThan(box.width - 24);
      }
      // 40 px targets: the range, Auto-refresh, refresh and the legend.
      for (const selector of ['#systemPerfRangeButton', '#systemRefresh-overview', '.systemPage__actions[data-section="overview"] .systemBar__option']) {
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
// the runner account), a shape's drill-down (?q=<hash>) and Open in Query.
// Every stack has queries in its last hour (the tests' own), so the default
// window is enough; the degraded states are mocked answers.

const queryRows = (page) => page.locator('#systemQueriesTable tbody tr');

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
  await page.locator('#systemQueriesKind [data-kind="Select"]').click();
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('#systemQueriesKind [data-kind="Select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => [...new Set(await queryRows(page).evaluateAll((rows) => rows.map((row) => row.dataset.kind)))], { timeout: 20_000 }).toEqual(['Select']);
  // ChDash's own queries: shown on request.
  await expect(page.locator('#systemQueriesHide')).toBeChecked();
  const asked = page.waitForRequest((request) => request.url().includes('/api/system/queries?') && request.url().includes('hide_chdash=0'));
  await page.locator('#systemQueriesHide').uncheck();
  await asked;
  await expect(page).toHaveURL(/kind=Select&hide=0$/);
  // Back: the previous filters.
  await page.goBack();
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('#systemQueriesHide')).toBeChecked();
  await page.goBack();
  await expect(page.locator('#systemQueriesKind [data-kind="all"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a row opens its shape: timeline, runs, deep link and Back', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const row = queryRows(page).first();
  const hash = await row.getAttribute('data-hash');
  expect(hash).toMatch(/^\d+$/);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`queries\\?sort=calls&q=${hash}$`));
  const drill = page.locator('#systemQuery');
  await expect(drill).toBeVisible();
  await expect(page.locator('#systemQueriesList')).toBeHidden();
  await expect(drill.locator('.systemQuery__hash')).toHaveText(hash);
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
  // The latest runs instead: the order is in the address.
  await page.locator('#systemQueryRunsOrder [data-order="latest"]').click();
  await expect(page).toHaveURL(new RegExp(`q=${hash}&runs=latest$`));
  await expect(page.locator('#systemQueryRunsOrder [data-order="latest"]')).toHaveAttribute('aria-pressed', 'true');
  // Back to the list, the row marked; a deep link opens the shape again.
  await page.locator('#systemQueryBack').click();
  await expect(page).toHaveURL(/queries\?sort=calls$/);
  await expect(queryRows(page).first()).toBeVisible();
  await expect(page.locator(`#systemQueriesTable tr[data-hash="${hash}"]`)).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`q=${hash}&runs=latest$`));
  await expect(drill).toBeVisible();
  await page.goto(`/system/queries?q=${hash}`);
  await expect(page.locator('#systemQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
  // Keyboard: Enter on a row opens it.
  await page.locator('#systemQueryBack').click();
  await queryRows(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=\d+/);
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
  await expect(page.locator('#systemQueriesFilters')).toBeHidden();
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
      await expect(page.locator('#systemQueriesSort')).toBeVisible();
      const wrap = await page.locator('.systemQueries__wrap').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(wrap).toBeLessThanOrEqual(0);
      // 40 px targets (a segmented option through its band), the rows too.
      expect(await smallTouchTargets(page)).toEqual([]);
      expect((await queryRows(page).first().boundingBox()).height).toBeGreaterThanOrEqual(40);
      // The refresh button stays beside the range.
      const range = await page.locator('#systemQueriesRangeButton').boundingBox();
      const refresh = await page.locator('#systemRefresh-queries').boundingBox();
      const middle = refresh.y + refresh.height / 2;
      expect(middle).toBeGreaterThan(range.y);
      expect(middle).toBeLessThan(range.y + range.height);
      await queryRows(page).first().click();
      await expect(page.locator('#systemQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      await expect(page.locator('#systemQueryRuns thead th:visible')).toHaveText(['Time', 'Duration', 'Status']);
      // A treemap rectangle is as large as its share of the data.
      expect(await smallTouchTargets(page, { skip: ['.explorerTreemap__node'] })).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Disks: a card per disk, the growth, the bytes by database (a database opens
// its Storage tab) and the policies, over /api/system/disks and the
// series panel disk_growth. Fill tones and forecasts come from mocked answers:
// the stack's own disk is whatever the machine has.

const diskCard = (page, name) => page.locator(`#systemDiskCards .systemDisk[data-disk="${name}"]`);

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
    await expect(card.locator('.systemDisk__name')).toHaveText(name);
    await expect(card.locator('.shareBar__text')).toHaveText(/^\d+(?:\.\d+)?%$/);
    await expect(card.locator('[data-fact="path"] .systemDisk__value')).toHaveText(/^\/var\/lib\/clickhouse\//);
  }
  await expect(diskCard(page, 'fixture_hot').locator('[data-fact="policies"]')).toContainText('fixture_tiered / hot');
  await expect(diskCard(page, 'fixture_warm').locator('[data-fact="policies"]')).toContainText('fixture_tiered / warm');
  // The growth charts draw (the week, or whatever this stack holds).
  await expect(page.locator('#systemDiskChart-used .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#systemDiskChart-merge_tree')).toBeVisible();
  await expect(page.locator('#systemDiskChart-written')).toBeVisible();
  await expect(page.locator('#systemDiskChart-used .chartCore__legendItem').first()).toContainText('default');
  // Bytes by database: the tiered fixture on its hot disk, a share bar beside its figure.
  const hot = page.locator('.systemDiskDb[data-disk="fixture_hot"]');
  await expect(hot.locator('tbody tr[data-database="chdash_ui"] .shareBar__text')).toHaveText(/%$/);
  await expect(hot.locator('.systemDiskDb__segment[data-database="chdash_ui"]')).toBeAttached();
  // The policies, volumes in priority order.
  const policy = page.locator('#systemDiskPolicyTable');
  await expect(policy.locator('tr[data-policy="fixture_tiered"]')).toHaveCount(2);
  await expect(policy.locator('tr[data-policy="fixture_tiered"] td:nth-child(2)')).toHaveText(['hot #1', 'warm #2']);
});

test('a database opens on its Storage tab, from the table or the stacked bar', async ({ page }) => {
  await openDisks(page);
  const hot = page.locator('.systemDiskDb[data-disk="fixture_hot"]');
  const link = hot.locator('tbody tr[data-database="chdash_ui"] a.systemDiskDb__link');
  await expect(link).toHaveAttribute('href', /\/explorer\/chdash_ui\?tab=storage$/);
  await link.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/, { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDatabaseStorageStrip, #explorerDatabaseTreemap').first()).toBeVisible({ timeout: 20_000 });
  // Back returns to the section.
  await page.goBack();
  await expect(page).toHaveURL(/\/system\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  // A segment of the stacked bar does the same.
  await expect(hot).toBeVisible({ timeout: 20_000 });
  await hot.locator('.systemDiskDb__segment[data-database="chdash_ui"]').click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/, { timeout: 20_000 });
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
  await expect(diskCard(page, 'fixture_hot').locator('.systemDisk__summary')).toHaveText('850.0 GB used of 1000.0 GB');
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
      const path = diskCard(page, 'fixture_warm').locator('[data-fact="path"] .systemDisk__value');
      expect(await path.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe('ellipsis');
      expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      // The tables fit without their own sideways scroll.
      for (const wrap of await page.locator('#systemDiskDatabases .systemTableWrap, #systemDiskPolicies .systemTableWrap').all()) {
        expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      }
      await expect(page.locator('#systemDiskPolicyTable thead th:visible')).toHaveText(['Policy', 'Volume', 'Disks']);
      // 40 px targets, the database links included; the refresh stays beside the range.
      expect(await smallTouchTargets(page)).toEqual([]);
      const range = await page.locator('#systemDisksRangeButton').boundingBox();
      const refresh = await page.locator('#systemRefresh-disks').boundingBox();
      const middle = refresh.y + refresh.height / 2;
      expect(middle).toBeGreaterThan(range.y);
      expect(middle).toBeLessThan(range.y + range.height);
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
