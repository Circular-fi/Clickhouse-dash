import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// Explorer graph: readable fit, database groups, per-node expansion, side
// panel, edge definitions, impact list, light theme tokens and the phone
// layout. The graph is a canvas: ChDash.explorerGraph.inspect() reports the
// last drawn frame in client coordinates so the tests click real pixels.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
});

const VIEWPORTS = {
  'desktop-1440': { width: 1440, height: 900 },
  'laptop-1280': { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

function focusUrl(database, table, { mode = 'lineage', depth = 1 } = {}) {
  return `/explorer/${database}/${table}/overview?view=graph&graph=${mode}${mode === 'lineage' ? `&depth=${depth}` : ''}`;
}

async function graphReady(page, pattern = /[1-9]\d* (nodes|collapsed)/) {
  await expect(page.locator('#explorerGraphPane')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerGraphStatus')).toHaveText(pattern, { timeout: 20_000 });
  // Two frames: the layout of the payload has been drawn at least once.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function inspect(page) {
  return page.evaluate(() => window.ChDash.explorerGraph.inspect());
}

async function clickBox(page, box) {
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function nodeBox(page, id) {
  const state = await inspect(page);
  const node = state.nodes.find((candidate) => candidate.id === id);
  expect(node, `${id} is drawn`).toBeTruthy();
  return node;
}

test('unfocused lineage collapses databases, hides objects without dependencies and expands a database in place', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto('/explorer?view=graph&graph=lineage&depth=1');
  await graphReady(page, /collapsed database/);
  let state = await inspect(page);
  const groups = state.nodes.filter((node) => node.kind === 'database_group').map((node) => node.database).sort();
  // Only databases with at least one dependency are listed; otel has none.
  expect(groups).toEqual(expect.arrayContaining(['chdash_repl', 'chdash_ui']));
  expect(groups).not.toContain('otel');
  expect(state.nodes.every((node) => node.kind === 'database_group')).toBe(true);
  await expect(page.locator('#explorerGraphStatus')).toContainText('without dependencies hidden');
  // Collapsed cards stay readable at Fit.
  expect(state.scale).toBeGreaterThanOrEqual(state.readableScale - 1e-6);

  await clickBox(page, state.nodes.find((node) => node.database === 'chdash_ui'));
  await graphReady(page, /\d+ nodes/);
  state = await inspect(page);
  const ui = state.nodes.filter((node) => node.database === 'chdash_ui');
  expect(ui.map((node) => node.name)).toEqual(expect.arrayContaining(['weather_observations', 'weather_daily_summary_mv', 'station_dictionary']));
  // wide_types has no dependency: hidden until asked for.
  expect(ui.map((node) => node.name)).not.toContain('wide_types');
  expect(state.nodes.some((node) => node.kind === 'database_group' && node.database === 'chdash_repl')).toBe(true);

  await page.locator('#explorerGraphShowIsolated').check();
  await expect(page.locator('#explorerGraphStatus')).not.toContainText('without dependencies hidden');
  state = await inspect(page);
  expect(state.nodes.some((node) => node.name === 'wide_types')).toBe(true);
  expect(state.nodes.some((node) => node.kind === 'database_group' && node.database === 'otel')).toBe(true);
});

test('fit keeps canvas text readable and cards carry the short name with the database as subtitle', async ({ page }) => {
  for (const viewport of [VIEWPORTS['desktop-1440'], VIEWPORTS['laptop-1280']]) {
    await page.setViewportSize(viewport);
    await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 3 }));
    await graphReady(page, /neighborhood depth 3/);
    const state = await inspect(page);
    // 12px is the smallest Lineage font: Fit keeps it at >= 11 CSS pixels.
    expect(state.scale * 12).toBeGreaterThanOrEqual(11 - 1e-6);
    const focus = state.nodes.find((node) => node.id === 'table:chdash_ui.weather_observations');
    expect(focus.height).toBeGreaterThanOrEqual(72);
    // The focused neighbourhood no longer fits at that scale: the minimap
    // shows where the rest is.
    if (state.nodes.some((node) => node.x + node.width > viewport.width || node.y + node.height > viewport.height)) {
      await expect(page.locator('#explorerGraphMinimap')).toBeVisible();
    }
  }
});

test('node click opens the side panel with summary, definition and columns, and Open card opens the table card', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_daily_summary_mv'));
  await graphReady(page, /neighborhood depth 1/);
  await clickBox(page, await nodeBox(page, 'table:chdash_ui.weather_daily_summary_mv'));
  const panel = page.locator('#explorerGraphPanel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.explorerGraphPanel__title')).toHaveText('weather_daily_summary_mv');
  await expect(panel.locator('.explorerGraphPanel__subtitle')).toHaveText('chdash_ui');
  await expect(panel).toContainText('Writes to');
  await expect(panel).toContainText('chdash_ui.weather_daily_summary');
  await expect(panel.locator('.explorerGraphPanel__sql')).toContainText('countState()');
  await expect(panel.locator('.explorerGraphPanel__sql .tok-kw').first()).toBeVisible();
  await expect(panel.locator('.explorerGraphPanel__columns')).toContainText('observation_count');
  // The URL and tree follow the clicked object, the Browse card is not opened.
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_daily_summary_mv\/[a-z]+\?view=graph/);
  await expect(page.locator('#explorerGraphPane')).toBeVisible();

  await panel.locator('#explorerGraphPanelOpenCard').click();
  await expect(page.locator('#explorerGraphPane')).toBeHidden();
  await expect(page.locator('#explorerDetailName')).toContainText('weather_daily_summary_mv');
  await expect(page).not.toHaveURL(/view=graph/);
});

test('edge click explains the Materialized View SELECT, the dictionary source and the Distributed route', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  const panel = page.locator('#explorerGraphPanel');

  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  let state = await inspect(page);
  const mvLabel = state.edgeLabels.find((label) => label.kind === 'materialized_view');
  expect(mvLabel, 'MV trigger edge is labelled').toBeTruthy();
  expect(mvLabel.text).toBe('MV');
  await clickBox(page, mvLabel);
  await expect(panel).toHaveAttribute('data-panel-type', 'edge');
  await expect(panel.locator('.explorerGraphPanel__title')).toHaveText('Materialized View trigger');
  await expect(panel).toContainText('chdash_ui.weather_observations');
  await expect(panel.locator('.explorerGraphPanel__sql')).toContainText('FROM chdash_ui.weather_observations');

  await page.goto(focusUrl('chdash_ui', 'station_dictionary'));
  await graphReady(page, /neighborhood depth 1/);
  state = await inspect(page);
  const dictionaryLabel = state.edgeLabels.find((label) => label.kind === 'dictionary_source');
  expect(dictionaryLabel, 'dictionary source edge from loading_dependencies').toBeTruthy();
  expect(dictionaryLabel.from).toBe('table:chdash_ui.station_dictionary_source');
  await clickBox(page, dictionaryLabel);
  await expect(panel.locator('.explorerGraphPanel__title')).toHaveText('Dictionary source');
  await expect(panel).toContainText('CLICKHOUSE · chdash_ui.station_dictionary_source');
  await expect(panel).toContainText('COMPLEX_KEY_HASHED');
  await expect(panel).toContainText('MIN 0 MAX 0');
  // Connection arguments of SOURCE() never reach the panel.
  await expect(panel).not.toContainText(/PASSWORD|chdash_runner|HIDDEN/);

  await page.goto(focusUrl('chdash_repl', 'replicated_events_all'));
  await graphReady(page, /neighborhood depth 1/);
  state = await inspect(page);
  const routeLabel = state.edgeLabels.find((label) => label.kind === 'distributed_route');
  expect(routeLabel).toBeTruthy();
  await clickBox(page, routeLabel);
  await expect(panel.locator('.explorerGraphPanel__title')).toHaveText('Distributed route');
  await expect(panel).toContainText('chdash_cluster');
  await expect(panel).toContainText('chdash_repl.replicated_events');
  await expect(panel).toContainText('rand()');
  await expect(panel).toContainText('1 shard × 2 replicas');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('per-node expand adds one hop in one direction on top of the global depth and collapses back', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  let state = await inspect(page);
  expect(state.nodes.some((node) => node.name === 'weather_buffer_alert_mv')).toBe(false);
  const buffer = state.nodes.find((node) => node.id === 'table:chdash_ui.weather_buffer');
  expect(buffer.hiddenDownstream).toBe(2);
  const plus = state.controls.find((control) => control.nodeId === buffer.id && control.direction === 'down');
  expect(plus.label).toBe('+2');

  const request = page.waitForRequest((req) => req.url().includes('/api/explorer/graph?')
    && new URL(req.url()).searchParams.getAll('expand').includes('down:table:chdash_ui.weather_buffer'));
  await clickBox(page, plus);
  await request;
  await graphReady(page, /\+ 1 expanded/);
  state = await inspect(page);
  expect(state.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(['weather_buffer_alert_mv', 'weather_buffer_city_mv']));
  expect(state.expansions).toEqual(['down\u0000table:chdash_ui.weather_buffer']);
  // The global depth is unchanged; the URL keeps it.
  await expect(page.locator('#explorerGraphDepthValue')).toHaveText('1');
  const minus = state.controls.find((control) => control.nodeId === buffer.id && control.direction === 'down');
  expect(minus.label).toBe('\u2212');
  // Revealed nodes offer their own next hop.
  expect(state.controls.some((control) => control.nodeId === 'table:chdash_ui.weather_buffer_alert_mv' && control.label === '+1')).toBe(true);

  await clickBox(page, minus);
  await graphReady(page, /neighborhood depth 1$/);
  state = await inspect(page);
  expect(state.nodes.some((node) => node.name === 'weather_buffer_alert_mv')).toBe(false);
});

test('impact list gives direction and depth relative to the focus and refocuses on click', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['laptop-1280']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 2 }));
  await graphReady(page, /neighborhood depth 2/);
  await page.locator('#explorerGraphListViewButton').click();
  const list = page.locator('#explorerGraphImpact');
  await expect(list).toBeVisible();
  await expect(page.locator('#explorerGraphCanvas')).toHaveCSS('visibility', 'hidden');
  await expect(list.locator('thead th')).toHaveText(['Object', 'Type', 'Direction', 'Depth', 'Database']);
  const row = (name) => list.locator(`tbody tr[data-node-id="table:chdash_ui.${name}"] td`);
  await expect(row('weather_buffer').nth(2)).toHaveText('upstream');
  await expect(row('weather_buffer').nth(3)).toHaveText('1');
  await expect(row('weather_observations').nth(2)).toHaveText('selected');
  await expect(row('weather_daily_summary_mv').nth(2)).toHaveText('downstream');
  await expect(row('weather_daily_summary').nth(3)).toHaveText('2');
  await expect(list.locator('.explorerGraphImpact__meta')).toContainText(/\d+ upstream · \d+ downstream · depth 2/);

  await row('weather_daily_summary_mv').first().locator('button').click();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_daily_summary_mv\//);
  await expect(list.locator('.explorerGraphImpact__title')).toHaveText('Impact of chdash_ui.weather_daily_summary_mv');
  await expect(page.locator('#explorerGraphPanel')).toBeVisible();
  await page.locator('#explorerGraphCanvasViewButton').click();
  await expect(page.locator('#explorerGraphCanvas')).toHaveCSS('visibility', 'visible');
});

test('graph colour tokens stay readable in both themes and Storage keeps its readable fit', async ({ page }) => {
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => { try { localStorage.setItem('chdash.theme', t); } catch (_) {} }, theme);
    await page.goto(focusUrl('chdash_ui', 'weather_observations', { mode: 'storage' }));
    await graphReady(page, /\d+ nodes/);
    const tokens = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      const read = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
      const out = { muted: read('--graphMuted'), accent: read('--graphAccentText'), halo: read('--graphHalo'), bg: read('--graphNodeBg') };
      probe.remove();
      return out;
    });
    const rgb = (value) => value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    // TTL expressions use the accent text token, secondary text the muted one.
    expect(contrast(rgb(tokens.accent), rgb(tokens.bg)), `${theme} accent`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens.muted), rgb(tokens.bg)), `${theme} muted`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(rgb(tokens.halo), rgb(tokens.bg)), `${theme} focus halo`).toBeGreaterThanOrEqual(3);
    const state = await inspect(page);
    // 11px is the smallest Storage font.
    expect(state.scale * 11).toBeGreaterThanOrEqual(11 - 1e-6);
    expect(state.nodes.some((node) => node.kind === 'storage_tier')).toBe(true);
  }
});

test('phones show lineage as a list, keep every graph control inside the pane and open details as a bottom sheet', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.mobile);
  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  const list = page.locator('#explorerGraphImpact');
  await expect(list).toBeVisible();
  await expect(page.locator('#explorerGraphListViewButton')).toHaveAttribute('aria-selected', 'true');
  const pane = await page.locator('#explorerGraphPane').boundingBox();
  for (const control of await page.locator('.explorerGraphViewportControls > :not([hidden])').all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(pane.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  }
  const listBox = await list.boundingBox();
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  await list.locator('tbody tr[data-node-id="table:chdash_ui.weather_buffer"] button').click();
  const panel = page.locator('#explorerGraphPanel');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox.width).toBeGreaterThan(VIEWPORTS.mobile.width - 60);
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(VIEWPORTS.mobile.height + 1);
  await expect(panel.locator('#explorerGraphPanelOpenCard')).toBeVisible();

  // The canvas is one tap away and its toolbar wraps instead of being cut.
  await panel.locator('.explorerGraphPanel__close').click();
  await page.locator('#explorerGraphCanvasViewButton').click();
  await expect(page.locator('#explorerGraphCanvas')).toHaveCSS('visibility', 'visible');
  for (const control of await page.locator('.explorerGraphViewportControls > :not([hidden])').all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
  }
});
