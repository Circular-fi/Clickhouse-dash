import { test, expect } from '@playwright/test';
import { horizontalOverflow, smallTouchTargets } from '../helpers/app.js';
import { xLabelCollisions, xRepeatedYears } from '../helpers/charts.js';

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
  await expect(tabs(page)).toHaveText(['Overview', 'Performance', 'Queries', 'Disks', 'Activity']);
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
  // The tab keys move between the sections (the shared tab behaviour).
  await page.locator('#explorerMonitorTab-activity').focus();
  await page.keyboard.press('Home');
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

// ---------------------------------------------------------------------------
// Performance: ten charts on the shared engine over /api/explorer/monitor/series.
// The windows are relative to now (the default 1 h, or the server's own
// windows), so a fresh stack with minutes of logs draws as a long-lived one.

const CHARTS = ['queries', 'latency', 'cpu', 'memory', 'merges', 'inserts', 'parts', 'pools', 'reads', 'replication'];
const chartCard = (page, id) => page.locator(`#explorerMonitorChart-${id}`);
const chartRoot = (page, id) => chartCard(page, id).locator('.chartCore');

async function openPerformance(page, query = '') {
  await page.goto(`/explorer/_monitoring/performance${query}`);
  await expect(chartRoot(page, 'cpu').locator('canvas')).toBeVisible({ timeout: 20_000 });
  await expect(chartRoot(page, 'cpu')).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
}

// The real series answer (fetched first), changed by `edit`.
async function routeSeries(page, edit) {
  await page.route(/\/api\/explorer\/monitor\/series\?/, async (route) => {
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
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/performance$/);
  await expect(selectedSection(page)).toHaveText('Performance');
  await expect(page.locator('#explorerMonitorRangeButton')).toHaveText('Time range \u00b7 Last 1 hour');
  await expect(page.locator('#explorerMonitorPanel-performance .explorerMonitorBar__meta')).toContainText(/This server .* 30 s buckets/);
  // Every chart has a card; the replicated fixture shows Replication too.
  for (const id of CHARTS) {
    await expect(chartCard(page, id)).toBeVisible();
    await expect(chartRoot(page, id)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/);
  }
  await expect(page.locator('#explorerMonitorPerfGrid .explorerMonitorChart:visible')).toHaveCount(10);
  await expect(chartCard(page, 'queries')).toHaveAttribute('data-source', 'metric_log');
  await expect(chartCard(page, 'queries').locator('.chartCore__legendItem')).toHaveText(['SELECT', 'INSERT', 'Other', 'Failed']);
  await expect(chartCard(page, 'latency').locator('.chartCore__legendItem')).toHaveText(['p50', 'p95', 'p99']);
  await expect(chartCard(page, 'cpu').locator('.chartCard__meta')).toContainText(/\d+ cores?/);
  // Two charts a row at desktop width, each filling its cell.
  const boxes = await page.locator('#explorerMonitorPerfGrid .explorerMonitorChart').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const plot = el.querySelector('.chartCore').getBoundingClientRect();
    return { left: Math.round(r.left), width: r.width, plot: plot.width };
  }));
  expect(new Set(boxes.map((box) => box.left)).size).toBe(2);
  for (const box of boxes) expect(box.plot).toBeGreaterThan(box.width - 24);
  // No notes: every log is there.
  await expect(page.locator('#explorerMonitorPerfNotes .explorerMonitorIssue')).toHaveCount(0);
  // Auto-refresh is off by default and allowed on a relative hour.
  await expect(page.locator('#explorerMonitorAutoRefresh-performance')).not.toBeChecked();
  await expect(page.locator('#explorerMonitorAutoRefresh-performance')).toBeEnabled();
});

test('the charts share one crosshair', async ({ page }) => {
  await openPerformance(page);
  const box = await chartRoot(page, 'cpu').locator('.chartCore__overlay').boundingBox();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await expect(chartRoot(page, 'cpu').locator('.chartCore__tooltip')).toBeVisible();
  // The other charts follow the cursor's time.
  for (const id of ['memory', 'queries', 'reads']) await expect(chartRoot(page, id)).toHaveAttribute('data-sync-x', /^\d+/);
  const xs = await page.locator('#explorerMonitorPerfGrid .chartCore[data-sync-x]').evaluateAll((els) => new Set(els.map((el) => el.dataset.syncX)).size);
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
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/performance\?from=\d{4}-\d\d-\d\d(\+|%20)\d\d(%3A|:)\d\d(%3A|:)\d\d&to=/);
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
  // The picker shows the absolute range; Auto-refresh does not follow it.
  await expect(page.locator('#explorerMonitorRangeButton')).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d \u2192 /);
  await expect(page.locator('#explorerMonitorAutoRefresh-performance')).toBeDisabled();
  // Back: the default hour again.
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/performance$/);
  await expect(page.locator('#explorerMonitorRangeButton')).toHaveText('Time range \u00b7 Last 1 hour');
  await expect.poll(async () => Number(await chartRoot(page, 'memory').getAttribute('data-x-min')), { timeout: 15_000 }).toBeLessThan(range.from - 60_000);
  // A deep link opens its range; another section drops it from the address.
  await page.goForward();
  await expect(page).toHaveURL(/performance\?from=/);
  await page.locator('#explorerMonitorTab-overview').click();
  await expect(page).toHaveURL(/\/explorer\/_monitoring$/);
  await page.locator('#explorerMonitorTab-performance').click();
  await expect(page).toHaveURL(/performance\?from=/);
});

test('the picker applies a quick range and writes it to the address', async ({ page }) => {
  await openPerformance(page);
  await page.locator('#explorerMonitorRangeButton').click();
  const panel = page.locator('#explorerMonitorTimeRangePanel');
  await expect(panel).toBeVisible();
  // The panel stays in the viewport (it hangs from the button's right edge).
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await panel.locator('.timeRangeList__item', { hasText: 'Last 24 hours' }).click();
  await expect(page).toHaveURL(/performance\?from=now-24h&to=now$/);
  await expect(page.locator('#explorerMonitorPanel-performance .explorerMonitorBar__meta')).toContainText('5 min buckets', { timeout: 15_000 });
  await expect(page.locator('#explorerMonitorAutoRefresh-performance')).toBeDisabled();
  await page.reload();
  await expect(page.locator('#explorerMonitorRangeButton')).toHaveText('Time range \u00b7 Last 24 hours', { timeout: 20_000 });
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
  const issue = page.locator('#explorerMonitorPerfNotes .explorerMonitorIssue[data-reason="disabled"]');
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
  await expect(page.locator('#explorerMonitorPerfNotes .explorerMonitorIssue[data-reason="unsupported"]')).toContainText('transposed layout', { timeout: 20_000 });
  await expect(chartCard(page, 'queries')).toHaveAttribute('data-source', 'query_log');
});

test('without any history the section shows the current values', async ({ page }) => {
  await routeSeries(page, (json) => {
    dropSource(json, 'metric_log', 'disabled', METRIC_LOG);
    dropSource(json, 'asynchronous_metric_log', 'not_granted', ASYNC, 'Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)');
    json.sources.asynchronous_metric_log.hint = 'GRANT SELECT ON system.asynchronous_metric_log TO chdash_system';
    json.unavailable_panels[1].hint = json.sources.asynchronous_metric_log.hint;
  });
  await page.goto('/explorer/_monitoring/performance');
  const current = page.locator('#explorerMonitorPerfCurrent');
  await expect(current).toContainText('History needs system.metric_log or system.asynchronous_metric_log', { timeout: 20_000 });
  await expect(current.locator('.explorerMonitorTiles > .statTile')).toHaveCount(8);
  await expect(page.locator('#explorerMonitorPerfNotes .explorerMonitorIssue__code')).toHaveText('GRANT SELECT ON system.asynchronous_metric_log TO chdash_system');
  // query_log still gives queries/s and the latency; the rest is hidden, not eight empty cards.
  await expect(page.locator('#explorerMonitorPerfGrid .explorerMonitorChart:visible')).toHaveCount(2);
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

test('a hidden section draws nothing', async ({ page }) => {
  await openPerformance(page);
  // A refresh whose answer lands after the section is hidden.
  let landed = false;
  await page.route(/\/api\/explorer\/monitor\/series\?/, async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ response });
    landed = true;
  });
  await page.locator('#explorerMonitorRefresh-performance').click();
  await page.locator('#explorerMonitorTab-overview').click();
  await expect(page.locator('#explorerMonitorPanel-performance')).toBeHidden();
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
  await page.locator('#explorerMonitorTab-performance').click();
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
  await page.locator('#explorerMonitorRangeButton').click();
  await page.locator('#explorerMonitorRangeStart').fill('now-30d');
  await page.locator('#explorerMonitorRangeEnd').fill('now');
  await page.locator('#explorerMonitorCustomRangeApply').click();
  await expect(page.locator('#explorerMonitorPanel-performance .explorerMonitorBar__meta')).toContainText('3 h buckets', { timeout: 20_000 });
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
      expect(await page.locator('#explorerMonitorPane').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      const boxes = await page.locator('#explorerMonitorPerfGrid .explorerMonitorChart:visible').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), width: Math.round(r.width), plot: el.querySelector('.chartCore').getBoundingClientRect().width };
      }));
      expect(new Set(boxes.map((box) => box.left)).size).toBe(1);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(width - 40);
        expect(box.plot).toBeGreaterThan(box.width - 24);
      }
      // 40 px targets: the range, Auto-refresh, refresh and the legend.
      for (const selector of ['#explorerMonitorRangeButton', '#explorerMonitorRefresh-performance', '#explorerMonitorPanel-performance .explorerMonitorBar__option']) {
        const box = await page.locator(selector).boundingBox();
        expect(box.height, selector).toBeGreaterThanOrEqual(40);
      }
      const legend = await chartCard(page, 'cpu').locator('.chartCore__legendItem').first().boundingBox();
      expect(legend.height).toBeGreaterThanOrEqual(40);
      // The range panel opens inside the screen.
      await page.locator('#explorerMonitorRangeButton').click();
      const panel = await page.locator('#explorerMonitorTimeRangePanel').boundingBox();
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
    });
  });
}

// ---------------------------------------------------------------------------
// Queries: the top query shapes of the window (/api/explorer/monitor/queries,
// the runner account), a shape's drill-down (?q=<hash>) and Open in Query.
// Every stack has queries in its last hour (the tests' own), so the default
// window is enough; the degraded states are mocked answers.

const queryRows = (page) => page.locator('#explorerMonitorQueriesTable tbody tr');

async function openQueries(page, query = '') {
  await page.goto(`/explorer/_monitoring/queries${query}`);
  await expect(queryRows(page).first()).toBeVisible({ timeout: 30_000 });
}

// The real queries answer (fetched first), changed by `edit`.
async function routeQueries(page, edit) {
  await page.route(/\/api\/explorer\/monitor\/queries\?/, async (route) => {
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
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/queries$/);
  await expect(selectedSection(page)).toHaveText('Queries');
  await expect(page.locator('#explorerMonitorQueriesRangeButton')).toHaveText('Time range · Last 1 hour');
  await expect(page.locator('#explorerMonitorPanel-queries .explorerMonitorBar__meta')).toContainText(/This server .* [\d,]+ shapes?/);
  // No Auto-refresh: a window is read once.
  await expect(page.locator('#explorerMonitorAutoRefresh-queries')).toHaveCount(0);
  await expect(page.locator('.explorerMonitorQueries__tiles > .statTile .statTile__label')).toHaveText(['Queries', 'Shapes', 'Total time', 'Errors', 'Read']);
  await expect(page.locator('#explorerMonitorQueriesTable thead th')).toHaveText(['#', 'Query', 'Kind', 'Calls', 'Errors', 'Total time', 'Avg', 'p95', 'Max', 'Read rows', 'Read', 'Memory', 'Users', 'Tables']);
  await expect(page.locator('#explorerMonitorQueriesTable th[data-col="total"]')).toHaveAttribute('aria-sort', 'descending');
  const count = await queryRows(page).count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(50);
  // The normalized SQL is highlighted text (the highlighter's spans), two lines at most.
  const sql = queryRows(page).first().locator('.explorerMonitorQueries__sql');
  await expect(sql.locator('.sqlBlock__code')).not.toBeEmpty();
  expect(await sql.getAttribute('title')).toBeTruthy();
  const lines = await sql.locator('.sqlBlock__pre').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(lines).toBeLessThanOrEqual(2);
  // Mono for SQL, sans tabular figures for measures.
  const fonts = await page.evaluate(() => {
    const row = document.querySelector('#explorerMonitorQueriesTable tbody tr');
    const style = (el) => getComputedStyle(el);
    return { sql: style(row.querySelector('.sqlBlock__code')).fontFamily, total: style(row.querySelector('.explorerMonitorQueries__total')).fontFamily, nums: style(row.querySelector('.explorerMonitorQueries__total')).fontVariantNumeric };
  });
  expect(fonts.sql).toMatch(/mono/i);
  expect(fonts.total).not.toMatch(/mono/i);
  expect(fonts.nums).toContain('tabular-nums');
});

test('the headers sort and the kind and Hide ChDash filter, through the address', async ({ page }) => {
  await openQueries(page);
  await page.locator('#explorerMonitorQueriesTable th[data-col="calls"] .dataTable__sort').click();
  await expect(page).toHaveURL(/queries\?sort=calls$/);
  await expect(page.locator('#explorerMonitorQueriesTable th[data-col="calls"]')).toHaveAttribute('aria-sort', 'descending', { timeout: 20_000 });
  const calls = (await queryRows(page).locator('td:nth-child(4)').allTextContents()).map(numberOf);
  expect(calls.length).toBeGreaterThan(0);
  for (let i = 1; i < calls.length; i++) expect(calls[i - 1]).toBeGreaterThanOrEqual(calls[i]);
  // SELECT only.
  await page.locator('#explorerMonitorQueriesKind [data-kind="Select"]').click();
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('#explorerMonitorQueriesKind [data-kind="Select"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => [...new Set(await queryRows(page).evaluateAll((rows) => rows.map((row) => row.dataset.kind)))], { timeout: 20_000 }).toEqual(['Select']);
  // ChDash's own queries: shown on request.
  await expect(page.locator('#explorerMonitorQueriesHide')).toBeChecked();
  const asked = page.waitForRequest((request) => request.url().includes('/api/explorer/monitor/queries?') && request.url().includes('hide_chdash=0'));
  await page.locator('#explorerMonitorQueriesHide').uncheck();
  await asked;
  await expect(page).toHaveURL(/kind=Select&hide=0$/);
  // Back: the previous filters.
  await page.goBack();
  await expect(page).toHaveURL(/sort=calls&kind=Select$/);
  await expect(page.locator('#explorerMonitorQueriesHide')).toBeChecked();
  await page.goBack();
  await expect(page.locator('#explorerMonitorQueriesKind [data-kind="all"]')).toHaveAttribute('aria-pressed', 'true');
});

test('a row opens its shape: timeline, runs, deep link and Back', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const row = queryRows(page).first();
  const hash = await row.getAttribute('data-hash');
  expect(hash).toMatch(/^\d+$/);
  await row.click();
  await expect(page).toHaveURL(new RegExp(`queries\\?sort=calls&q=${hash}$`));
  const drill = page.locator('#explorerMonitorQuery');
  await expect(drill).toBeVisible();
  await expect(page.locator('#explorerMonitorQueriesList')).toBeHidden();
  await expect(drill.locator('.explorerMonitorQuery__hash')).toHaveText(hash);
  await expect(drill.locator('.explorerMonitorQuery__tiles .statTile__label')).toHaveText(['Calls', 'Errors', 'Total time', 'p95', 'Read', 'Memory', 'CPU'], { timeout: 20_000 });
  for (const id of ['calls', 'latency', 'cpu']) {
    await expect(page.locator(`#explorerMonitorQueryChart-${id} .chartCore`)).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  }
  const runs = page.locator('#explorerMonitorQueryRuns tbody tr');
  const total = await runs.count();
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(20);
  // The slowest first.
  const durations = await runs.locator('td:nth-child(2)').allTextContents();
  expect(durations.length).toBe(total);
  // The latest runs instead: the order is in the address.
  await page.locator('#explorerMonitorQueryRunsOrder [data-order="latest"]').click();
  await expect(page).toHaveURL(new RegExp(`q=${hash}&runs=latest$`));
  await expect(page.locator('#explorerMonitorQueryRunsOrder [data-order="latest"]')).toHaveAttribute('aria-pressed', 'true');
  // Back to the list, the row marked; a deep link opens the shape again.
  await page.locator('#explorerMonitorQueryBack').click();
  await expect(page).toHaveURL(/queries\?sort=calls$/);
  await expect(queryRows(page).first()).toBeVisible();
  await expect(page.locator(`#explorerMonitorQueriesTable tr[data-hash="${hash}"]`)).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`q=${hash}&runs=latest$`));
  await expect(drill).toBeVisible();
  await page.goto(`/explorer/_monitoring/queries?q=${hash}`);
  await expect(page.locator('#explorerMonitorQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
  // Keyboard: Enter on a row opens it.
  await page.locator('#explorerMonitorQueryBack').click();
  await queryRows(page).first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=\d+/);
});

test('Open in Query puts the example or the history in the editor without running it', async ({ page }) => {
  await openQueries(page, '?sort=calls');
  const hash = await queryRows(page).first().getAttribute('data-hash');
  await queryRows(page).first().click();
  const example = page.locator('#explorerMonitorQueryOpenExample');
  await expect(example).toBeEnabled({ timeout: 20_000 });
  const runs = [];
  page.on('request', (request) => { if (request.url().includes('/api/query/run')) runs.push(request.url()); });
  await example.click();
  await expect(page).toHaveURL(/\/query$/, { timeout: 20_000 });
  await expect(page.locator('#queryTextArea')).toHaveValue(/\S/);
  await page.goBack();
  await expect(page.locator('#explorerMonitorQueryOpenHistory')).toBeVisible({ timeout: 20_000 });
  await page.locator('#explorerMonitorQueryOpenHistory').click();
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
  await page.goto('/explorer/_monitoring/queries');
  const issue = page.locator('#explorerMonitorQueriesNotes .explorerMonitorIssue[data-reason="not_granted"]');
  await expect(issue).toBeVisible({ timeout: 20_000 });
  await expect(issue.locator('.badge')).toHaveText('Not granted');
  await expect(issue).toContainText('The runner account cannot read system.query_log');
  await expect(issue.locator('.explorerMonitorIssue__code')).toHaveText(grant);
  await expect(issue.locator('.explorerMonitorIssue__copy')).toHaveAttribute('aria-label', 'Copy the GRANT statement');
  await expect(page.locator('#explorerMonitorQueriesFilters')).toBeHidden();
  await expect(queryRows(page)).toHaveCount(0);
  status = 'disabled';
  await page.reload();
  const disabled = page.locator('#explorerMonitorQueriesNotes .explorerMonitorIssue[data-reason="disabled"]');
  await expect(disabled).toContainText('system.query_log is disabled on this server', { timeout: 20_000 });
  await expect(disabled).toContainText('log_queries = 1');
  await expect(disabled.locator('.explorerMonitorIssue__code')).toHaveCount(0);
});

test('a window past the read cap or the lookback narrows in one click', async ({ page }) => {
  let tooLarge = true;
  await routeQueries(page, (json) => {
    if (tooLarge) degrade(json, 'window_too_large', { message: "DB::Exception: Limit for rows (controlled by 'max_rows_to_read' setting) exceeded", suggested_span_ms: 900_000 });
  });
  await page.goto('/explorer/_monitoring/queries?from=now-24h&to=now');
  const issue = page.locator('#explorerMonitorQueriesNotes .explorerMonitorIssue[data-reason="window_too_large"]');
  await expect(issue).toContainText('explorer.monitoring.query_log_max_rows', { timeout: 20_000 });
  await expect(issue).toContainText('50,000,000 rows');
  tooLarge = false;
  await issue.locator('#explorerMonitorQueriesNarrow').click();
  await expect(page).toHaveURL(/queries\?from=now-15m&to=now$/);
  await expect(queryRows(page).first()).toBeVisible({ timeout: 20_000 });
  // Past query_log_max_lookback_hours (a deep link): the last 7 days instead.
  await page.goto('/explorer/_monitoring/queries?from=now-30d&to=now');
  const lookback = page.locator('#explorerMonitorQueriesNotes .explorerMonitorIssue[data-reason="range_too_large"]');
  await expect(lookback).toContainText('at most 7 days', { timeout: 20_000 });
  await lookback.locator('#explorerMonitorQueriesNarrow').click();
  await expect(page).toHaveURL(/queries\?from=now-7d&to=now$/);
  await expect(page.locator('#explorerMonitorQueriesRangeButton')).toHaveText('Time range · Last 7 days');
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
  const badges = queryRows(page).locator('.explorerMonitorQueries__errors [data-error-rate]');
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
      const paneOverflow = () => page.locator('#explorerMonitorPane').evaluate((el) => el.scrollWidth - el.clientWidth);
      await openQueries(page);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      // The query and its total time; the calls, kind and users in its meta line.
      await expect(page.locator('#explorerMonitorQueriesTable thead th:visible')).toHaveText(['Query', 'Total time']);
      await expect(queryRows(page).first().locator('.explorerMonitorQueries__metaCalls')).toBeVisible();
      await expect(page.locator('#explorerMonitorQueriesSort')).toBeVisible();
      const wrap = await page.locator('.explorerMonitorQueries__wrap').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(wrap).toBeLessThanOrEqual(0);
      // 40 px targets (a segmented option through its band), the rows too.
      expect(await smallTouchTargets(page)).toEqual([]);
      expect((await queryRows(page).first().boundingBox()).height).toBeGreaterThanOrEqual(40);
      // The refresh button stays beside the range.
      const range = await page.locator('#explorerMonitorQueriesRangeButton').boundingBox();
      const refresh = await page.locator('#explorerMonitorRefresh-queries').boundingBox();
      const middle = refresh.y + refresh.height / 2;
      expect(middle).toBeGreaterThan(range.y);
      expect(middle).toBeLessThan(range.y + range.height);
      await queryRows(page).first().click();
      await expect(page.locator('#explorerMonitorQueryRuns tbody tr').first()).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await paneOverflow()).toBeLessThanOrEqual(0);
      await expect(page.locator('#explorerMonitorQueryRuns thead th:visible')).toHaveText(['Time', 'Duration', 'Status']);
      expect(await smallTouchTargets(page)).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// Disks: a card per disk, the growth, the bytes by database (a database opens
// its Storage tab) and the policies, over /api/explorer/monitor/disks and the
// series panel disk_growth. Fill tones and forecasts come from mocked answers:
// the stack's own disk is whatever the machine has.

const diskCard = (page, name) => page.locator(`#explorerMonitorDiskCards .explorerMonitorDisk[data-disk="${name}"]`);

async function openDisks(page, query = '') {
  await page.goto(`/explorer/_monitoring/disks${query}`);
  await expect(diskCard(page, 'default')).toBeVisible({ timeout: 30_000 });
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
const routeDisks = routeJson(/\/api\/explorer\/monitor\/disks\?/);
const routeGrowth = routeJson(/\/api\/explorer\/monitor\/series\?.*panel=disk_growth/);

test('Disks shows a card per disk, its growth, the bytes by database and the policies', async ({ page }) => {
  await openDisks(page);
  await expect(selectedSection(page)).toHaveText('Disks');
  await expect(page.locator('#explorerMonitorDisksRangeButton')).toHaveText('Time range · Last 7 days');
  // No Auto-refresh: the disks are cached a minute, the growth five.
  await expect(page.locator('#explorerMonitorAutoRefresh-disks')).toHaveCount(0);
  await expect(page.locator('#explorerMonitorPanel-disks .explorerMonitorBar__meta')).toContainText(/This server · \d+ disks · growth .* · 1 h buckets/);
  await expect(page.locator('.explorerMonitorDisks__tiles > .statTile .statTile__label')).toHaveText(['Disks', 'Fullest', 'Soonest full', 'ClickHouse data']);
  // The fixture disks, their fill on its own track, their policies.
  for (const name of ['default', 'fixture_hot', 'fixture_warm']) {
    const card = diskCard(page, name);
    await expect(card.locator('.explorerMonitorDisk__name')).toHaveText(name);
    await expect(card.locator('.shareBar__text')).toHaveText(/^\d+(?:\.\d+)?%$/);
    await expect(card.locator('[data-fact="path"] .explorerMonitorDisk__value')).toHaveText(/^\/var\/lib\/clickhouse\//);
  }
  await expect(diskCard(page, 'fixture_hot').locator('[data-fact="policies"]')).toContainText('fixture_tiered / hot');
  await expect(diskCard(page, 'fixture_warm').locator('[data-fact="policies"]')).toContainText('fixture_tiered / warm');
  // The growth charts draw (the week, or whatever this stack holds).
  await expect(page.locator('#explorerMonitorDiskChart-used .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#explorerMonitorDiskChart-merge_tree')).toBeVisible();
  await expect(page.locator('#explorerMonitorDiskChart-written')).toBeVisible();
  await expect(page.locator('#explorerMonitorDiskChart-used .chartCore__legendItem').first()).toContainText('default');
  // Bytes by database: the tiered fixture on its hot disk, a share bar beside its figure.
  const hot = page.locator('.explorerMonitorDiskDb[data-disk="fixture_hot"]');
  await expect(hot.locator('tbody tr[data-database="chdash_ui"] .shareBar__text')).toHaveText(/%$/);
  await expect(hot.locator('.explorerMonitorDiskDb__segment[data-database="chdash_ui"]')).toBeAttached();
  // The policies, volumes in priority order.
  const policy = page.locator('#explorerMonitorDiskPolicyTable');
  await expect(policy.locator('tr[data-policy="fixture_tiered"]')).toHaveCount(2);
  await expect(policy.locator('tr[data-policy="fixture_tiered"] td:nth-child(2)')).toHaveText(['hot #1', 'warm #2']);
});

test('a database opens on its Storage tab, from the table or the stacked bar', async ({ page }) => {
  await openDisks(page);
  const hot = page.locator('.explorerMonitorDiskDb[data-disk="fixture_hot"]');
  const link = hot.locator('tbody tr[data-database="chdash_ui"] a.explorerMonitorDiskDb__link');
  await expect(link).toHaveAttribute('href', /\/explorer\/chdash_ui\?tab=storage$/);
  await link.click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/, { timeout: 20_000 });
  await expect(page.locator('#explorerCatalogTab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDatabaseStorageStrip, #explorerDatabaseTreemap').first()).toBeVisible({ timeout: 20_000 });
  // Back returns to the section.
  await page.goBack();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/disks$/);
  await expect(selectedSection(page)).toHaveText('Disks');
  // A segment of the stacked bar does the same.
  await expect(hot).toBeVisible({ timeout: 20_000 });
  await hot.locator('.explorerMonitorDiskDb__segment[data-database="chdash_ui"]').click();
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
  await expect(diskCard(page, 'fixture_hot').locator('.explorerMonitorDisk__summary')).toHaveText('850.0 GB used of 1000.0 GB');
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
  await expect(until('default').locator('.explorerMonitorDisk__value')).toHaveText(/^5 days\s*\+10\.0 GB\/day$/, { timeout: 20_000 });
  await expect(until('default')).toHaveAttribute('data-tone', 'error');
  await expect(until('fixture_hot').locator('.explorerMonitorDisk__value')).toContainText('Not growing');
  await expect(until('fixture_warm').locator('.explorerMonitorDisk__value')).toContainText('Not enough history');
  await expect(page.locator('[data-tile="soonest"] .statTile__value')).toHaveText('5 days');
  await expect(page.locator('[data-tile="soonest"] .statTile__sub')).toHaveText('default');
});

test('fifteen minutes of history makes no forecast', async ({ page }) => {
  await openDisks(page, '?from=now-15m&to=now');
  await expect(page.locator('#explorerMonitorDiskHistoryNote')).toContainText('Not enough history for a forecast: it needs at least 6 samples over 6 h', { timeout: 20_000 });
  await expect(diskCard(page, 'default').locator('[data-fact="until_full"]')).toContainText('Not enough history');
  await expect(page.locator('#explorerMonitorPanel-disks .explorerMonitorBar__meta')).toContainText('10 s buckets');
});

test('without asynchronous_metric_log the growth says what it needs', async ({ page }) => {
  await routeGrowth(page, (json) => {
    json.sources.asynchronous_metric_log = { ...json.sources.asynchronous_metric_log, status: 'disabled', message: '', hint: '', rows_read: 0 };
    delete json.series.merge_tree_bytes;
    for (const disk of json.disks) { disk.used = []; disk.trend = { status: 'not_enough_history', points: 0, span_seconds: 0, slope_bytes_per_day: null, days_until_full: null }; }
    json.unavailable_panels = [{ panel: 'asynchronous_metric_log', table: 'asynchronous_metric_log', reason: 'disabled', message: '', hint: '' }];
  });
  await openDisks(page);
  await expect(page.locator('#explorerMonitorDiskGrowthNotes')).toContainText('Growth needs system.asynchronous_metric_log', { timeout: 20_000 });
  await expect(page.locator('#explorerMonitorDiskChart-used')).toBeHidden();
  await expect(page.locator('#explorerMonitorDiskChart-merge_tree')).toBeHidden();
  // part_log still says what was written, on the whole row.
  await expect(page.locator('#explorerMonitorDiskChart-written')).toBeVisible();
  await expect(page.locator('#explorerMonitorDiskChart-written')).toHaveClass(/is-alone/);
  await expect(diskCard(page, 'default').locator('[data-fact="until_full"]')).toContainText('Needs asynchronous_metric_log');
});

test('a panel the system account may not read shows the GRANT; the rest stays', async ({ page }) => {
  const hint = 'GRANT SELECT ON system.storage_policies TO chdash_system';
  await routeDisks(page, (json) => {
    json.policies = [];
    json.unavailable_panels = [{ panel: 'policies', table: 'storage_policies', reason: 'not_granted', message: 'Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)', hint }];
  });
  await openDisks(page);
  const issue = page.locator('#explorerMonitorDiskPolicies .explorerMonitorIssue[data-reason="not_granted"]');
  await expect(issue.locator('.explorerMonitorIssue__code')).toHaveText(hint);
  await expect(page.locator('[data-tile="disks"] .statTile__sub')).toHaveText('storage policies unreadable');
  await expect(page.locator('#explorerMonitorDiskDatabases tbody tr').first()).toBeVisible();
});

test('only the default policy reads as one line; a drag narrows the growth window', async ({ page }) => {
  await routeDisks(page, (json) => {
    json.policies = [{ name: 'default', volumes: [{ name: 'default', priority: 1, disks: ['default'], volume_type: 'JBOD', max_data_part_size: 0, move_factor: 0, prefer_not_to_merge: false, perform_ttl_move_on_insert: true, load_balancing: 'ROUND_ROBIN' }] }];
  });
  await openDisks(page, '?from=now-6h&to=now');
  await expect(page.locator('#explorerMonitorDiskPolicySingle')).toHaveText('Only the default policy: every MergeTree table writes to default.');
  const plot = page.locator('#explorerMonitorDiskChart-used .chartCore');
  await expect(plot).toHaveAttribute('data-points-drawn', /^[1-9]\d*$/, { timeout: 20_000 });
  const box = await plot.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/explorer\/_monitoring\/disks\?from=\d{4}-\d\d-\d\d(?:\+|%20)\d\d%3A\d\d%3A\d\d&to=/);
});

for (const width of [390, 360]) {
  test.describe(`Disks on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test(`Disks fits the viewport at ${width} px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
      await openDisks(page);
      await expect(page.locator('#explorerMonitorDiskChart-used .chartCore canvas')).toBeVisible({ timeout: 20_000 });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(await page.locator('#explorerMonitorPane').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      // One card a row, long paths wrapped rather than cut.
      const cards = await page.locator('#explorerMonitorDiskCards .explorerMonitorDisk').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
      expect(new Set(cards).size).toBe(1);
      const path = diskCard(page, 'fixture_warm').locator('[data-fact="path"] .explorerMonitorDisk__value');
      expect(await path.evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe('ellipsis');
      expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      // The tables fit without their own sideways scroll.
      for (const wrap of await page.locator('#explorerMonitorDiskDatabases .explorerMonitorTableWrap, #explorerMonitorDiskPolicies .explorerMonitorTableWrap').all()) {
        expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
      }
      await expect(page.locator('#explorerMonitorDiskPolicyTable thead th:visible')).toHaveText(['Policy', 'Volume', 'Disks']);
      // 40 px targets, the database links included; the refresh stays beside the range.
      expect(await smallTouchTargets(page)).toEqual([]);
      const range = await page.locator('#explorerMonitorDisksRangeButton').boundingBox();
      const refresh = await page.locator('#explorerMonitorRefresh-disks').boundingBox();
      const middle = refresh.y + refresh.height / 2;
      expect(middle).toBeGreaterThan(range.y);
      expect(middle).toBeLessThan(range.y + range.height);
    });
  });
}

// ---------------------------------------------------------------------------
// Time axes of every Monitoring chart: the labels and the date lines under
// them never run into each other ("Oct 2 2026Oct 3 2026" under the first
// ticks of a 24 h Disks chart), and the year shows on the first date only
// (and where it changes), at each quick range, on a desktop and a phone page.

test('time axes keep their labels and date lines apart at 1 h, 24 h, 7 d and 30 d, on 1440 and 390 px pages', async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const section of ['performance', 'queries', 'disks']) {
      // Queries reads at most 7 days of query_log (a longer range offers the last 7 days).
      for (const range of section === 'queries' ? ['1h', '24h', '7d'] : ['1h', '24h', '7d', '30d']) {
        await page.goto(`/explorer/_monitoring/${section}?from=now-${range}&to=now`);
        // Queries charts the timeline of a shape: the first one opens.
        if (section === 'queries') {
          await expect(queryRows(page).first()).toBeVisible({ timeout: 30_000 });
          await queryRows(page).first().click();
        }
        const charts = page.locator(`#explorerMonitorPanel-${section} .chartCore`);
        await expect(charts.first()).toHaveAttribute('data-x-ticks', /^\[\["/, { timeout: 30_000 });
        const where = `${section} ${range} at ${width}`;
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
