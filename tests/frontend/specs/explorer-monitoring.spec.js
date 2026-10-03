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
  await expect(tabs(page)).toHaveText(['Overview', 'Performance', 'Activity']);
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
