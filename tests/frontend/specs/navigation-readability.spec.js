import { test, expect } from '@playwright/test';
import { openApp, runQuery, waitForTerminal, runSuccessfulQuery } from '../helpers/app.js';
import { mockTraceFacets, mockTraceResults } from '../helpers/traces.js';
import { settle } from '../helpers/graph-kit.js';

// Design lot 3 (docs/ui-foundations.md): navigation and readability. The page switcher is a nav of links (UI-001), the
// host's name is never cut (UI-002), a menu keeps its current option (UI-003, UI-004), a number's header is over its
// figures (UI-013), a table's head stays in the scroller (UI-091), the Query rail does not cross its own figures nor repeat
// "no run" (UI-011, UI-014, UI-015, UI-017), a trace row names three services and one thin duration rule (UI-049, UI-060),
// and a graph names its cards in full (UI-044, UI-053).

// ---- the page switcher ----------------------------------------------------------------------------------------------

test('the page switcher is a nav of links, the current page marked, any of them a new tab away', async ({ page, context }) => {
  await page.goto('/query');
  await expect.poll(() => page.evaluate(() => window.ChDash?.features?.known?.() === true)).toBe(true);
  const nav = page.getByRole('navigation', { name: 'Pages' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveText(['Query', 'Explorer', 'Observability', 'System']);
  await expect(nav.getByRole('link', { name: 'Explorer' })).toHaveAttribute('href', '/explorer/catalog');
  await expect(nav.getByRole('link', { name: 'Query' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'System' })).not.toHaveAttribute('aria-current', 'page');
  // From 821 px the links are in the header, not behind a button.
  await expect(page.locator('#pageSelectButton')).toBeHidden();
  // Underlined on the header's own bottom border.
  const marks = await page.evaluate(() => {
    const link = document.querySelector('#navQueryLink').getBoundingClientRect();
    const header = document.querySelector('header.appHeader').getBoundingClientRect();
    return { linkBottom: link.bottom, headerBottom: header.bottom };
  });
  expect(Math.abs(marks.headerBottom - marks.linkBottom)).toBeLessThanOrEqual(2);
  // A link is a link: Ctrl+click opens the page in a tab of its own.
  const opened = context.waitForEvent('page');
  await nav.getByRole('link', { name: 'Explorer' }).click({ modifiers: ['Control'] });
  const tab = await opened;
  await tab.waitForLoadState('domcontentloaded');
  expect(new URL(tab.url()).pathname).toBe('/explorer/catalog');
  await tab.close();
  // The same nav, with the current page changed, on another page.
  await page.goto('/system');
  await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'System' })).toHaveAttribute('aria-current', 'page');
});

test('under 821 px the links fold into a menu named for the current page, which keeps the current page in its list', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/query');
  await expect.poll(() => page.evaluate(() => window.ChDash?.features?.known?.() === true)).toBe(true);
  const button = page.locator('#pageSelectButton');
  await expect(button).toBeVisible();
  await expect(button).toHaveText('Query');
  await expect(page.locator('#pageSelectMenu')).toBeHidden();
  await button.click();
  const menu = page.locator('#pageSelectMenu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link')).toHaveText(['Query', 'Explorer', 'Observability', 'System']);
  await expect(menu.getByRole('link', { name: 'Query' })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

// ---- the host picker ------------------------------------------------------------------------------------------------

// A host with a long name next to the instance's own: /api/hosts and its stream list both.
async function twoHosts(page, label = 'Production ClickHouse') {
  const withOther = (body) => {
    const hosts = Array.isArray(body.hosts) ? body.hosts : [];
    if (hosts.length === 1) hosts.push({ ...hosts[0], id: 'other', label });
    return body;
  };
  await page.route('**/api/hosts', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withOther(await response.json()) });
  });
  await page.route('**/api/hosts/stream', async (route) => {
    const response = await page.request.get(route.request().url().replace(/\/stream(\?.*)?$/, ''));
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: hosts\ndata: ${JSON.stringify(withOther(await response.json()))}\n\n` });
  });
}

for (const width of [1440, 1280, 1024]) {
  test(`the host's name is never cut, at ${width} px; the menu lists every host, the current one selected`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await twoHosts(page);
    await openApp(page);
    await page.evaluate(() => window.ChDash.header.setSelectedHostId('other'));
    const text = page.locator('#hostPickerText');
    await expect(text).toHaveText('Production ClickHouse');
    const cut = await text.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(cut.scroll, 'the name is not clipped').toBeLessThanOrEqual(cut.client);
    // Under 1280 px the version and the ping stay in the menu: never the name.
    await page.locator('#hostPickerButton').click();
    const options = page.locator('#hostPickerMenu .pickerOption');
    await expect(options).toHaveCount(2);
    const selected = page.locator('#hostPickerMenu .pickerOption[aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected.locator('.pickerOption__label')).toHaveText('Production ClickHouse');
    const box = await page.locator('#hostPickerMenu').boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
    await page.keyboard.press('Escape');
  });
}

test('a select menu keeps its current option in the list, marked, and opens on it', async ({ page }) => {
  await mockTraceResults(page);
  await mockTraceFacets(page);
  await page.goto('/observability/traces?from=now-2h&to=now');
  await expect(page.locator('#tracesResults .traceResultItem').first()).toBeVisible({ timeout: 30_000 });
  const picker = page.locator('#tracesForm .tracePicker:has(#tracesStatus)');
  await picker.locator('.tracePicker__button').focus();
  await page.keyboard.press('Enter');
  const options = picker.locator('.tracePicker__option');
  await expect(options).toHaveText(['All', 'OK', 'Error', 'Unset']);
  await expect(picker.locator('.tracePicker__option[aria-selected="true"]')).toHaveText('All');
  // It opens on the chosen option, and the chosen option is one an assistive technology can see.
  await expect(picker.locator('.tracePicker__option[aria-selected="true"]')).toBeFocused();
  await expect(picker.locator('.tracePicker__option[aria-selected="true"]')).toBeVisible();
  await page.keyboard.press('Escape');
  // The theme menu too.
  await page.locator('#themeSelectButton').click();
  await expect(page.locator('#themeSelectMenu [role="option"]')).toHaveCount(3);
  await expect(page.locator('#themeSelectMenu [role="option"][aria-selected="true"]')).toBeVisible();
  await page.keyboard.press('Escape');
});

// ---- tables -----------------------------------------------------------------------------------------------------------

test('a number\'s column header is on the right, over its figures; a text column\'s on the left', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, "SELECT number AS n, toString(number) AS label, number / 3 AS ratio FROM numbers(5)");
  const heads = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#resultTableHead th')].map((th) => [th.textContent.trim(), getComputedStyle(th).textAlign])));
  expect(heads.n).toBe('right');
  expect(heads.ratio).toBe('right');
  expect(heads.label).toBe('left');
  // The Explorer's Catalog tables too (Rows, Size, % server).
  await page.goto('/explorer/catalog');
  const overview = page.locator('#explorerDatabasesOverview thead th');
  await expect(overview.first()).toBeVisible({ timeout: 30_000 });
  const explorer = await overview.evaluateAll((cells) => Object.fromEntries(cells.map((th) => [th.textContent.trim(), getComputedStyle(th).textAlign])));
  expect(explorer.Database).toBe('left');
  for (const name of ['Objects', 'Rows', 'Size', '% server']) expect(explorer[name], name).toBe('right');
});

test('System > Queries: the table is the scroller under the tiles and its head stays over the rows', async ({ page }) => {
  // Forty shapes, so that the table scrolls.
  await page.route(/\/api\/system\/queries\?/, async (route) => {
    try {
      const response = await route.fetch();
      const json = await response.json();
      const rows = json.queries || [];
      if (rows.length) json.queries = Array.from({ length: 40 }, (_, i) => ({ ...rows[i % rows.length], hash: String(9000 + i) }));
      await route.fulfill({ response, json, headers: { 'Cache-Control': 'no-store' } });
    } catch {
      // The page or the test is gone.
    }
  });
  await page.goto('/system/queries');
  const wrap = page.locator('.systemQueries__wrap');
  await expect(wrap).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#systemQueriesTable tbody tr')).toHaveCount(40);
  const scrolls = await wrap.evaluate((el) => ({ over: el.scrollHeight - el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  expect(scrolls.over, 'forty rows scroll inside the wrap').toBeGreaterThan(100);
  await wrap.evaluate((el) => { el.scrollTop = 600; });
  await page.waitForTimeout(100);
  const head = await page.evaluate(() => {
    const th = document.querySelector('#systemQueriesTable thead th[data-col="total"]').getBoundingClientRect();
    const box = document.querySelector('.systemQueries__wrap').getBoundingClientRect();
    return { thTop: th.top, boxTop: box.top, thBottom: th.bottom, boxBottom: box.bottom };
  });
  expect(Math.abs(head.thTop - head.boxTop), 'the header is at the top of the scroller').toBeLessThanOrEqual(2);
  expect(head.thBottom).toBeLessThan(head.boxBottom);
  // The page itself does not scroll (a second scroller would put the head away again).
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(1);
});

// ---- the Query rail -----------------------------------------------------------------------------------------------------

test('the rail shows its tiles with dashes before any run, and the editor keeps its height when the figures come', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#runStatsTiles .metricCompact:visible')).toHaveCount(6);
  for (const id of ['elapsedSecondsText', 'progressPercentText', 'readRowsTotalText', 'readBytesTotalText', 'cpuMaxText', 'memoryMaxText']) {
    await expect(page.locator(`#${id}`), `${id} is a dash before a run`).toHaveText('\u2014');
  }
  const before = await page.locator('#queryTextArea').evaluate((el) => el.closest('.editorWrap').getBoundingClientRect().height);
  await runSuccessfulQuery(page, 'SELECT number AS n FROM numbers(1000)');
  await expect(page.locator('#runStatsTiles .metricCompact:visible')).toHaveCount(6);
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('\u2014');
  const after = await page.locator('#queryTextArea').evaluate((el) => el.closest('.editorWrap').getBoundingClientRect().height);
  expect(Math.abs(after - before), 'no jump of the editor').toBeLessThanOrEqual(1);
});

test('the trend of a tile is under its figures, and a finished run\'s Progress tile stops being lit', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS n, toString(number) AS s FROM numbers(300000)');
  const geometry = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('#runStatsTiles .metricCompact')].filter((tile) => tile.querySelector('.metricCompact__bgChart') && tile.getClientRects().length);
    return tiles.map((tile) => {
      const chart = tile.querySelector('.metricCompact__bgChart').getBoundingClientRect();
      const value = tile.querySelector('.metricCompact__value').getBoundingClientRect();
      return { id: tile.querySelector('.metricCompact__label').textContent, chartTop: chart.top, valueBottom: value.bottom };
    });
  });
  expect(geometry.length).toBeGreaterThan(2);
  for (const tile of geometry) expect(tile.chartTop, `${tile.id}: the line starts under the figure`).toBeGreaterThanOrEqual(tile.valueBottom - 1);
  const progress = page.locator('#progressCard');
  await expect(page.locator('#progressPercentText')).toHaveText('100%');
  await expect(progress).toHaveClass(/is-complete/);
  const lit = await progress.evaluate((el) => ({ fill: getComputedStyle(el, '::before').display, color: getComputedStyle(el.querySelector('.statTile__value')).color }));
  expect(lit.fill, 'no tint over the tile').toBe('none');
  expect(lit.color).not.toBe(await page.locator('#elapsedSecondsText').evaluate((el) => getComputedStyle(el).color));
});

test('a failed run keeps the elapsed time and the tiles that have a figure, no row of dashes', async ({ page }) => {
  await openApp(page);
  await runQuery(page, 'SELECT FROM');
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText('Error');
  const visible = await page.locator('#runStatsTiles .metricCompact:visible .metricCompact__label').allTextContents();
  expect(visible).toContain('Elapsed');
  expect(visible.length).toBeLessThanOrEqual(2);
  // A new run brings every tile back.
  await runSuccessfulQuery(page, 'SELECT 1 AS one');
  await expect(page.locator('#runStatsTiles .metricCompact:visible')).toHaveCount(6);
});

test('from 1100 px down the rail folds into one summary line, so the results stay above the fold', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS n FROM numbers(30)');
  const summary = page.locator('#runStatsSummary');
  await expect(summary).toBeVisible();
  await expect(page.locator('#runStatsTiles')).toBeHidden();
  await expect(summary).toContainText('30 rows');
  const top = await page.locator('#resultsPanel').evaluate((el) => el.getBoundingClientRect().top);
  expect(top, 'the results start in the first screen').toBeLessThan(700);
  await summary.click();
  await expect(page.locator('#runStatsTiles')).toBeVisible();
});

// ---- Traces ---------------------------------------------------------------------------------------------------------------

test('a trace row has one 3 px duration rule from 0, names its three most costly services, and the page names its longest bar', async ({ page }) => {
  await mockTraceResults(page);
  await mockTraceFacets(page);
  await page.goto('/observability/traces?from=now-2h&to=now');
  const rows = page.locator('#tracesResults .traceResultItem');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const bars = await page.evaluate(() => [...document.querySelectorAll('.traceResultItem__durationBar')].map((bar) => {
    const title = bar.parentElement.getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    return { height: box.height, bottom: Math.round(title.bottom - box.bottom), width: box.width / title.width, percent: Number(bar.dataset.durationPercent) };
  }));
  expect(bars.length).toBeGreaterThan(3);
  for (const bar of bars) {
    expect(bar.height, 'a rule, not a ribbon').toBeLessThanOrEqual(3.5);
    expect(bar.bottom).toBeLessThanOrEqual(1);
    expect(bar.width * 100, 'from 0, against the longest').toBeCloseTo(bar.percent, 0);
  }
  expect(Math.max(...bars.map((bar) => bar.percent))).toBeCloseTo(100, 1);
  await expect(page.locator('#tracesResultCount .tracesResultCount__scale')).toContainText(/bars up to \d/);
  // The most costly three: the many-service trace shows three chips and "+17", the table the same.
  const mesh = page.locator('#tracesResults li[data-trace-id="c1d2e3f4a5b60718293a4b5c6d7e8f90"]');
  await expect(mesh.locator('.traceSvcPill:not([hidden])')).toHaveCount(3);
  await expect(mesh.locator('.traceSvcMore')).toHaveText('+17');
  await page.locator('[data-results-view="table"]').click();
  const row = page.locator('#tracesResults tr[data-trace-id="c1d2e3f4a5b60718293a4b5c6d7e8f90"]');
  // As many as the column holds, three at most.
  const shown = await row.locator('.traceSvcPill:not([hidden])').count();
  expect(shown).toBeGreaterThanOrEqual(2);
  expect(shown).toBeLessThanOrEqual(3);
  await expect(row.locator('.traceSvcMore')).toHaveText(`+${20 - shown}`);
});

test('the service map is a block of columns, not a tower, and opens with its cards in full', async ({ page }) => {
  const callees = Array.from({ length: 11 }, (_, i) => `service-with-a-long-name-${String(i).padStart(2, '0')}`);
  const node = (service, spans, p95) => ({ service, spans, errors: 0, error_rate: 0, sampled_count: 1, p50_ns: p95 * 1e6 / 3, p95_ns: p95 * 1e6, p99_ns: p95 * 1.4e6 });
  const payload = {
    v: 1, source_host_id: 'local', range: [0, 3600_000], edge_rule: 'parent_child_cross_service',
    sampled: false, sample_factor: 1, truncated: false,
    sampling: { trace_factor: 1, time_coverage: 1, slices: 1, estimated_spans: 1_000_000, estimate_source: 'explain' },
    timing_ms: { estimate: 1, query: 10, total: 11 },
    nodes: [node('gateway', 5_000_000, 180), ...callees.map((name, i) => node(name, 400_000 - i * 1000, 40 + i))],
    edges: callees.map((name, i) => ({ source: 'gateway', target: name, kind: 'sync', ...node('', 100_000, 40 + i), service: undefined, calls: 100_000 - i * 500 })),
  };
  await mockTraceResults(page);
  await mockTraceFacets(page);
  await page.route('**/api/traces/service_map?**', (route) => route.fulfill({ json: payload }));
  await page.goto('/observability/traces?tab=map');
  await expect.poll(() => page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0), { timeout: 30_000 }).toBe(12);
  await settle(page);
  const state = await page.evaluate(() => window.ChDash.traceMap.inspect());
  const columns = new Map();
  for (const item of state.nodes) {
    const key = Math.round(item.x / 10);
    columns.set(key, (columns.get(key) || 0) + 1);
  }
  expect(Math.max(...columns.values()), 'at most six cards in a column').toBeLessThanOrEqual(6);
  expect(state.compact, 'the map opens on full cards, not a map of titles').toBe(false);
  for (const item of state.nodes) expect(item.height, 'a readable card').toBeGreaterThan(40);
});
