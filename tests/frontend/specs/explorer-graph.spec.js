import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import {
  settle, cameraIdle, overlaps, contrast, tokenColors, pixel, colorDistance, expectDotGrid, expectKitChrome, expectLabelsClear, measureFrames, visibleArea, expectCentred, expectClearOfChrome, expectTouchCanvas, expectFullFit, expectFit, expectLevelOfDetail, expectOwnLanes,
} from '../helpers/graph-kit.js';

// Explorer graph on the shared canvas graph kit (app_graph_kit.js): readable
// fit, database groups, per-node expansion, side panel, edge definitions,
// the kit's look (dot grid, cards, orthogonal edges, always
// visible labels, legend / status bottom-left, minimap, icon toolbar), hover
// halo, click = recentre + select, keyboard, both themes, the phone layout
// (the canvas with touch pan / pinch and a bottom-sheet panel: there is no
// List view) and performance budgets. The graph is a canvas:
// ChDash.explorerGraph.inspect() reports the last drawn frame in client
// coordinates so the tests click real pixels.

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
// Fit opens readable (kit.fitView): on 1440 x 900 a depth-2 lineage opens at
// the readable scale on its focus, clipped. Tests reading every card, edge
// label or expand control at Fit use a screen where the whole graph fits.
const WIDE = { width: 1920, height: 1080 };

// Graph is a mode of the Catalog, focused on the tree selection.
function focusUrl(database, table, { mode = 'lineage', depth = 1 } = {}) {
  return `/explorer/${database}/${table}?mode=graph&graph=${mode}${mode === 'lineage' ? `&depth=${depth}` : ''}`;
}

async function graphReady(page, pattern = /[1-9]\d* (nodes|collapsed)/) {
  await expect(page.locator('#explorerGraphPane')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#explorerGraphStatus')).toHaveText(pattern, { timeout: 20_000 });
  // Two frames: the layout of the payload has been drawn at least once.
  await settle(page);
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
  await page.goto('/explorer?mode=graph&graph=lineage&depth=1');
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

// Fit (on open, the Fit button, 0), kit.fitView: a graph readable as a
// whole opens whole (no card clipped or under the chrome, no minimap over a
// card); one slightly too large opens at the readable scale on the focused
// object, the minimap (bottom-right) giving the rest; a phone opens on the
// focus and its neighbours at PHONE_MIN_SCALE or more. Lineage at depth 2
// and 3 and Tiers (Storage), at 1440, 1280 and on a phone. The level of
// detail follows the card on screen: full cards at every open, never a
// compact title in an empty frame.
test('fit opens readable: the whole graph, or the readable scale on the focus with the minimap; a phone on the focus at 0.7 or more', async ({ page }) => {
  const FOCUS = 'table:chdash_ui.weather_observations';
  const cases = [
    [VIEWPORTS['desktop-1440'], focusUrl('chdash_ui', 'weather_observations', { depth: 2 }), /neighborhood depth 2/, 'anchored'],
    [VIEWPORTS['desktop-1440'], focusUrl('chdash_ui', 'weather_observations', { depth: 3 }), /neighborhood depth 3/, null],
    [VIEWPORTS['desktop-1440'], focusUrl('chdash_ui', 'weather_observations', { mode: 'storage' }), /\d+ nodes/, null],
    [VIEWPORTS['laptop-1280'], focusUrl('chdash_ui', 'weather_observations', { depth: 3 }), /neighborhood depth 3/, null],
    [VIEWPORTS.mobile, focusUrl('chdash_ui', 'weather_observations', { depth: 1 }), /neighborhood depth 1/, 'anchored'],
    [VIEWPORTS.mobile, focusUrl('chdash_ui', 'weather_observations', { mode: 'storage' }), /\d+ nodes/, 'anchored'],
  ];
  for (const [viewport, url, ready, expected] of cases) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await graphReady(page, ready);
    await cameraIdle(page, 'ChDash.explorerGraph');
    await settle(page);
    const storage = url.includes('graph=storage');
    let state = await inspect(page);
    const opened = await expectFit(page, { canvas: '#explorerGraphCanvas', minimap: '#explorerGraphMinimap' }, state, FOCUS);
    if (expected) expect(opened, `${url} at ${viewport.width} px`).toBe(expected);
    expect(state.compact, `${url} at ${viewport.width} px opens on full cards`).toBe(false);
    await expectLevelOfDetail(page, state, storage ? { cardHeight: 60, minFont: 11 } : { cardHeight: 80, minFont: 12 });
    if (opened === 'whole') await expectClearOfChrome(page, '#explorerGraphPane', { nodes: state.nodes, edgeLabels: [] });
    if (viewport === VIEWPORTS.mobile) continue;
    // Zoomed in until a card is clipped: the minimap, bottom-right of the pane.
    for (let i = 0; i < 8 && !(await inspect(page)).minimapVisible; i += 1) await page.locator('#explorerGraphZoomInButton').click();
    await expect(page.locator('#explorerGraphMinimap')).toBeVisible();
    const canvas = await page.locator('#explorerGraphCanvas').boundingBox();
    const minimap = await page.locator('#explorerGraphMinimap').boundingBox();
    expect(canvas.x + canvas.width - (minimap.x + minimap.width)).toBeLessThan(20);
    expect(canvas.y + canvas.height - (minimap.y + minimap.height)).toBeLessThan(20);
    // Fit again: the same view as on open.
    await page.locator('#explorerGraphFitButton').click();
    await cameraIdle(page, 'ChDash.explorerGraph');
    await settle(page);
    const again = await inspect(page);
    expect(again.scale).toBeCloseTo(state.scale, 6);
    expect(again.offsetX).toBeCloseTo(state.offsetX, 3);
    expect(again.offsetY).toBeCloseTo(state.offsetY, 3);
    state = again;
  }
});

// The level of detail follows the card on screen, not the zoom: zooming out
// from the readable open keeps full cards while an ordinary card stays 40 px
// tall and its text 7.5 px, then every card shrinks to its title row (no
// title floating in an empty 264 x 80 frame); edge labels and expand
// controls go with the full cards.
test('compact cards follow the on-screen card height and shrink to their title row', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 2 }));
  await graphReady(page, /neighborhood depth 2/);
  await cameraIdle(page, 'ChDash.explorerGraph');
  let state = await inspect(page);
  expect(await expectLevelOfDetail(page, state, { cardHeight: 80, minFont: 12 })).toBe(false);
  expect(state.edgeLabels.length).toBeGreaterThan(0);
  const seen = new Set();
  // Below the Fit the zoom stops at the whole-graph overview: lower the floor
  // by opening a depth-3 neighbourhood on a small window.
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 3 }));
  await graphReady(page, /neighborhood depth 3/);
  await cameraIdle(page, 'ChDash.explorerGraph');
  for (let i = 0; i < 6 && (await inspect(page)).compact; i += 1) await page.locator('#explorerGraphZoomInButton').click();
  for (let i = 0; i < 12; i += 1) {
    state = await inspect(page);
    const compact = await expectLevelOfDetail(page, state, { cardHeight: 80, minFont: 12 });
    seen.add(compact);
    if (compact) {
      expect(state.edgeLabels, 'no edge label on compact cards').toEqual([]);
      for (const node of state.nodes) expect(node.height, node.id).toBeLessThan(80 * state.scale - 4);
    }
    const before = state.scale;
    await page.locator('#explorerGraphZoomOutButton').click();
    await settle(page);
    if ((await inspect(page)).scale >= before - 1e-9) break;
  }
  expect([...seen].sort(), 'both levels of detail reached').toEqual([false, true]);
});

// T-E12: the dashed View edges under valid_weather_observations used to run
// 5-7 px apart and read as one closed frame: every route keeps its lane.
test('parallel edges keep their own lanes (no doubled dashed lines)', async ({ page }) => {
  for (const table of ['valid_weather_observations', 'weather_observations']) {
    for (const viewport of [VIEWPORTS['desktop-1440'], WIDE]) {
      await page.setViewportSize(viewport);
      await page.goto(focusUrl('chdash_ui', table, { depth: 2 }));
      await graphReady(page, /neighborhood depth 2/);
      await cameraIdle(page, 'ChDash.explorerGraph');
      const state = await inspect(page);
      expect(state.edges.length, table).toBeGreaterThan(4);
      expectOwnLanes(state, 12 * state.scale);
    }
  }
});

test('the kit look: dot grid, icon toolbar, legend and status bottom-left, orthogonal edges and labels on every edge', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 2 }));
  await graphReady(page, /neighborhood depth 2/);
  const state = await inspect(page);
  expect(state.kit).toBe(true);
  const colors = await tokenColors(page, ['--graph-bg', '--bg']);
  expect(colors['--graph-bg']).toEqual(colors['--bg']);
  expect(colors['--graph-bg'][3]).toBe(1);
  await expectDotGrid(page, '#explorerGraphCanvas', state, colors['--graph-bg']);
  await expectKitChrome(page, {
    pane: '#explorerGraphPane', zoomOut: '#explorerGraphZoomOutButton', fit: '#explorerGraphFitButton', zoomIn: '#explorerGraphZoomInButton',
    legend: '#explorerGraphPane .graphKitLegend', status: '#explorerGraphPane .graphKitStatus',
  });
  await expect(page.locator('#explorerGraphPane .graphKitLegend')).toContainText('data flow');
  // The fit leaves the toolbar, legend and status line free of cards and labels.
  await expectClearOfChrome(page, '#explorerGraphPane', state);
  // Every Lineage edge is orthogonal (axis-aligned segments) and labelled.
  expect(state.edges.length).toBeGreaterThan(3);
  for (const edge of state.edges) {
    expect(edge.points.length, edge.id).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      expect(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${edge.id} segment ${i}`).toBe(true);
    }
  }
  expect(state.edgeLabelsPlaced).toBe(state.edges.length);
  expectLabelsClear(state);
});

test('edge labels stay clear of each other when a node is selected (flush / MV next to weather_buffer)', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_buffer'));
  await graphReady(page, /neighborhood depth 1/);
  await clickBox(page, await nodeBox(page, 'table:chdash_ui.weather_buffer'));
  await expect(page.locator('#explorerGraphPanel')).toBeVisible();
  await settle(page);
  // Hovering the selected node highlights all of its edges: their labels keep
  // their places instead of being forced on top of each other.
  const buffer = await nodeBox(page, 'table:chdash_ui.weather_buffer');
  await page.mouse.move(buffer.x + buffer.width / 2, buffer.y + buffer.height / 2);
  await settle(page);
  const state = await inspect(page);
  const texts = state.edgeLabels.map((label) => label.text).sort();
  expect(texts).toEqual(expect.arrayContaining(['MV', 'flush']));
  expectLabelsClear(state);
});

test('hover outlines the hovered card only and click recentres on the card and selects it', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  let state = await inspect(page);
  const target = state.nodes.find((node) => node.name === 'weather_daily_summary_mv');
  const other = state.nodes.find((node) => node.name === 'valid_weather_observations');
  const halo = (await tokenColors(page, ['--graph-halo']))['--graph-halo'];
  // Pixels along the top edge, on the rows the 1-2 px stroke can cover: a dashed (View / MV)
  // outline has gaps wherever its dash phase falls, and the card's y is fractional.
  const edgePixels = (node) => Promise.all([0.3, 0.4, 0.5, 0.6, 0.7].flatMap((f) => [-0.5, 0, 0.5]
    .map((dy) => pixel(page, '#explorerGraphCanvas', node.x + node.width * f, node.y + dy))));
  const nearest = (pixels, colour) => Math.min(...pixels.map((p) => colorDistance(p, colour)));
  const beforeTarget = await edgePixels(target);
  const beforeOther = await edgePixels(other);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await settle(page);
  state = await inspect(page);
  expect(state.hoveredId).toBe(target.id);
  await expect(page.locator('#explorerGraphCanvas')).toHaveClass(/is-clickable/);
  // The hovered card's outline turns to the halo colour; the others are untouched (no dimming).
  expect(nearest(await edgePixels(target), halo)).toBeLessThan(nearest(beforeTarget, halo));
  const afterOther = await edgePixels(other);
  expect(Math.max(...afterOther.map((p, i) => colorDistance(p, beforeOther[i])))).toBeLessThan(2);
  // No hover popup on the canvas.
  await expect(page.locator('#explorerGraphPane [role="tooltip"]')).toHaveCount(0);

  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  const panel = page.locator('#explorerGraphPanel');
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_daily_summary_mv\?mode=graph/);
  await cameraIdle(page, 'ChDash.explorerGraph');
  state = await inspect(page);
  expect(state.focusedId).toBe(target.id);
  expect(state.panel).toEqual({ type: 'node', id: target.id });
  // Recentred in the visible canvas the panel and the chrome leave free (the
  // kit's visible area: below the toolbar, above the legend, status line and
  // minimap).
  const canvas = await page.locator('#explorerGraphCanvas').boundingBox();
  const panelBox = await panel.boundingBox();
  const free = await visibleArea(page, '#explorerGraphCanvas', '#explorerGraphPanel');
  const node = state.nodes.find((candidate) => candidate.id === target.id);
  expect(Math.abs(node.x + node.width / 2 - (canvas.x + (panelBox.x - canvas.x) / 2))).toBeLessThan(3);
  expect(Math.abs(node.y + node.height / 2 - (free.y + free.height / 2))).toBeLessThan(3);
  expect(node.x + node.width).toBeLessThan(panelBox.x);
});

// Focus centring (user, 2026-10-04 evening): a selection opens the side panel
// and the canvas left visible shrinks; the selected card ends centred in the
// visible canvas (beside the panel, or above the bottom sheet on a phone,
// clear of the toolbar, the legend / status dock and the minimap) once the
// panel's size has settled (its content arrives after it opens), and again
// in the whole canvas when the panel closes (kit follow()).
for (const [label, viewport] of [['desktop', VIEWPORTS['desktop-1440']], ['phone', VIEWPORTS.mobile]]) {
  test(`focus centring (${label}): the selected card is centred in the visible canvas once the panel settles, and again once it closes`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 2 }));
    await graphReady(page, /neighborhood depth 2/);
    await cameraIdle(page, 'ChDash.explorerGraph');
    // A card drawn whole on screen, away from the middle, other than the focus.
    const canvasBox = await page.locator('#explorerGraphCanvas').boundingBox();
    const free = await visibleArea(page, '#explorerGraphCanvas');
    const state = await inspect(page);
    const visible = state.nodes.filter((node) => node.id !== state.focusedId && node.kind !== 'database_group'
      && node.x >= free.x && node.y >= free.y && node.x + node.width <= free.x + free.width && node.y + node.height <= free.y + free.height);
    expect(visible.length, 'a card in view').toBeGreaterThan(0);
    const middle = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
    const target = visible.sort((a, b) => Math.hypot(b.x + b.width / 2 - middle.x, b.y + b.height / 2 - middle.y) - Math.hypot(a.x + a.width / 2 - middle.x, a.y + a.height / 2 - middle.y))[0];
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    const panel = page.locator('#explorerGraphPanel');
    await expect(panel).toBeVisible();
    // The panel's content has arrived (its size is final).
    await expect(panel.locator('.graphKitPanel__title')).toHaveText(target.name);
    await expectCentred(page, { hook: 'ChDash.explorerGraph', canvas: '#explorerGraphCanvas', panel: '#explorerGraphPanel', id: target.id, label: `${target.name} beside the panel` });
    const open = (await inspect(page)).nodes.find((node) => node.id === target.id);
    const sheet = await panel.boundingBox();
    if (label === 'phone') expect(open.y + open.height, 'above the sheet').toBeLessThanOrEqual(sheet.y + 1);
    else expect(open.x + open.width, 'left of the panel').toBeLessThanOrEqual(sheet.x + 1);
    // Closed: centred again in the canvas the panel gave back.
    await panel.locator('.uiDetail__close').click();
    await expect(panel).toBeHidden();
    await expectCentred(page, { hook: 'ChDash.explorerGraph', canvas: '#explorerGraphCanvas', id: target.id, label: `${target.name} once the panel closed` });
    const closed = (await inspect(page)).nodes.find((node) => node.id === target.id);
    expect(Math.hypot(closed.x - open.x, closed.y - open.y), 'it moved to the new centre').toBeGreaterThan(10);
  });
}

test('node click opens the side panel with summary, definition and columns, and Open card opens the table card', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto(focusUrl('chdash_ui', 'weather_daily_summary_mv'));
  await graphReady(page, /neighborhood depth 1/);
  await clickBox(page, await nodeBox(page, 'table:chdash_ui.weather_daily_summary_mv'));
  const panel = page.locator('#explorerGraphPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/graphKitPanel/);
  await expect(panel.locator('.graphKitPanel__eyebrow')).toHaveText('MaterializedView');
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('weather_daily_summary_mv');
  await expect(panel.locator('.graphKitPanel__subtitle')).toHaveText('chdash_ui');
  await expect(panel).toContainText('Writes to');
  await expect(panel).toContainText('chdash_ui.weather_daily_summary');
  await expect(panel.locator('.explorerGraphPanel__sql')).toContainText('countState()');
  await expect(panel.locator('.explorerGraphPanel__sql .tok-kw').first()).toBeVisible();
  await expect(panel.locator('.explorerGraphPanel__columns')).toContainText('observation_count');
  // The URL and tree follow the clicked object, the Browse card is not opened.
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_daily_summary_mv\?mode=graph/);
  await expect(page.locator('#explorerTableList .explorerTreeObject.is-selected')).toHaveAttribute('data-table', 'weather_daily_summary_mv');
  await expect(page.locator('#explorerGraphPane')).toBeVisible();

  // Open card switches the Catalog to Browse on the same object.
  await panel.locator('#explorerGraphPanelOpenCard').click();
  await expect(page.locator('#explorerGraphPane')).toBeHidden();
  await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#explorerDetailName')).toContainText('weather_daily_summary_mv');
  await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_daily_summary_mv$/);
});

test('edge click explains the Materialized View SELECT, the dictionary source and the Distributed route', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const panel = page.locator('#explorerGraphPanel');

  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  let state = await inspect(page);
  const mvLabel = state.edgeLabels.find((label) => label.kind === 'materialized_view');
  expect(mvLabel, 'MV trigger edge is labelled').toBeTruthy();
  expect(mvLabel.text).toBe('MV');
  await clickBox(page, mvLabel);
  await expect(panel).toHaveAttribute('data-panel-type', 'edge');
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('Materialized View trigger');
  await expect(panel).toContainText('chdash_ui.weather_observations');
  await expect(panel.locator('.explorerGraphPanel__sql')).toContainText('FROM chdash_ui.weather_observations');

  await page.goto(focusUrl('chdash_ui', 'station_dictionary'));
  await graphReady(page, /neighborhood depth 1/);
  state = await inspect(page);
  const dictionaryLabel = state.edgeLabels.find((label) => label.kind === 'dictionary_source');
  expect(dictionaryLabel, 'dictionary source edge from loading_dependencies').toBeTruthy();
  expect(dictionaryLabel.from).toBe('table:chdash_ui.station_dictionary_source');
  await clickBox(page, dictionaryLabel);
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('Dictionary source');
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
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('Distributed route');
  await expect(panel).toContainText('chdash_cluster');
  await expect(panel).toContainText('chdash_repl.replicated_events');
  await expect(panel).toContainText('rand()');
  await expect(panel).toContainText('1 shard × 2 replicas');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('per-node expand adds one hop in one direction on top of the global depth and collapses back', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  let state = await inspect(page);
  expect(state.nodes.some((node) => node.name === 'weather_buffer_alert_mv')).toBe(false);
  const buffer = state.nodes.find((node) => node.id === 'table:chdash_ui.weather_buffer');
  expect(buffer.hiddenDownstream).toBe(2);
  const plus = state.controls.find((control) => control.nodeId === buffer.id && control.direction === 'down');
  expect(plus.label).toBe('+2');
  // Labels never sit on an expand control.
  for (const label of state.edgeLabels) for (const control of state.controls) expect(overlaps(label, control), `${label.text} on ${control.label}`).toBe(false);

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
  expect(minus.label).toBe('−');
  // Revealed nodes offer their own next hop.
  expect(state.controls.some((control) => control.nodeId === 'table:chdash_ui.weather_buffer_alert_mv' && control.label === '+1')).toBe(true);

  await clickBox(page, minus);
  await graphReady(page, /neighborhood depth 1$/);
  state = await inspect(page);
  expect(state.nodes.some((node) => node.name === 'weather_buffer_alert_mv')).toBe(false);
});

test('keyboard: the canvas takes the focus, arrows move between cards, Enter selects, + - 0 zoom and Escape closes', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations'));
  await graphReady(page, /neighborhood depth 1/);
  const canvas = page.locator('#explorerGraphCanvas');
  await expect(canvas).toHaveAttribute('tabindex', '0');
  await canvas.focus();
  const fitted = (await inspect(page)).scale;
  await page.keyboard.press('+');
  expect((await inspect(page)).scale).toBeGreaterThan(fitted);
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  expect((await inspect(page)).scale).toBeLessThan(fitted + 1e-9);
  await page.keyboard.press('0');
  expect(Math.abs((await inspect(page)).scale - fitted)).toBeLessThan(1e-6);

  // The first arrow picks the focused object (the selection), the next one moves right.
  await page.keyboard.press('ArrowRight');
  let state = await inspect(page);
  const first = state.keyboardId;
  expect(first).toBeTruthy();
  expect(state.hoveredId).toBe(first);
  await page.keyboard.press('ArrowRight');
  state = await inspect(page);
  expect(state.keyboardId).not.toBe(first);
  const from = state.nodes.find((node) => node.id === first);
  const to = state.nodes.find((node) => node.id === state.keyboardId);
  expect(to.x).toBeGreaterThan(from.x);
  await expect(page.locator('#explorerGraphPane [aria-live="polite"]')).toContainText(to.name);
  const chosen = state.keyboardId;
  await page.keyboard.press('Enter');
  await expect(page.locator('#explorerGraphPanel')).toBeVisible();
  expect((await inspect(page)).panel).toEqual({ type: 'node', id: chosen });
  await canvas.focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#explorerGraphPanel')).toBeHidden();
});

test('graph colour tokens stay readable in both themes and Storage keeps its readable fit', async ({ page }) => {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => { try { localStorage.setItem('chdash.theme', t); } catch (_) {} }, theme);
    await page.goto(focusUrl('chdash_ui', 'weather_observations', { mode: 'storage' }));
    await graphReady(page, /\d+ nodes/);
    const tokens = await tokenColors(page, ['--graph-text', '--graph-muted', '--graph-accent-text', '--graph-halo', '--graph-node-bg',
      '--graph-label-bg', '--graph-bg', '--graph-warn', '--graph-error', '--graph-edge']);
    const bg = tokens['--graph-node-bg'];
    // Card and label text, TTL expressions (accent text) and secondary text.
    for (const name of ['--graph-text', '--graph-muted', '--graph-accent-text']) {
      expect(contrast(tokens[name], bg), `${theme} ${name} on cards`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens[name], tokens['--graph-label-bg']), `${theme} ${name} on labels`).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['--graph-halo', '--graph-warn', '--graph-error', '--graph-edge']) {
      expect(contrast(tokens[name], bg), `${theme} ${name}`).toBeGreaterThanOrEqual(3);
      expect(contrast(tokens[name], tokens['--graph-bg']), `${theme} ${name} on the background`).toBeGreaterThanOrEqual(3);
    }
    // The graph's accent and edges are solid colours, never the page's translucent accent tint.
    for (const name of ['--graph-halo', '--graph-edge']) expect(tokens[name][3], `${theme} ${name}`).toBe(1);
    const state = await inspect(page);
    // Fit shows every card of the storage graph.
    await expectFullFit(page, { canvas: '#explorerGraphCanvas', minimap: '#explorerGraphMinimap' }, state);
    expect(state.nodes.some((node) => node.kind === 'storage_tier')).toBe(true);
    await expectDotGrid(page, '#explorerGraphCanvas', state, tokens['--graph-bg']);
    // A graph larger than the view folds the legend (the kit leaves the room
    // to the cards): its button in the status line opens it.
    const legendToggle = page.locator('#explorerGraphPane .graphKitStatus .graphKitLegendToggle');
    if ((await legendToggle.getAttribute('aria-expanded')) === 'false') await legendToggle.click();
    await expect(page.locator('#explorerGraphLegendTtl')).toBeVisible();
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: VIEWPORTS.mobile, hasTouch: true });

  test('phones show the lineage canvas (no list), keep every control inside the pane, pan and pinch by touch and open details as a bottom sheet', async ({ page }) => {
    await page.goto(focusUrl('chdash_ui', 'weather_observations'));
    await graphReady(page, /neighborhood depth 1/);
    await expect(page.locator('#explorerGraphImpact, #explorerGraphListViewButton, #explorerGraphCanvasViewButton')).toHaveCount(0);
    const pane = await page.locator('#explorerGraphPane').boundingBox();
    // The toolbar wraps instead of being cut.
    for (const control of await page.locator('.explorerGraphViewportControls > :not([hidden])').all()) {
      const box = await control.boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(pane.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
    }
    await expectTouchCanvas(page, { pane: '#explorerGraphPane', canvas: '#explorerGraphCanvas', zoomIn: '#explorerGraphZoomInButton', inspect: () => inspect(page) });
    // The icon toolbar works too: Fit (the whole graph), then a tap on the
    // focused card opens the sheet.
    await page.locator('#explorerGraphFitButton').tap();
    await cameraIdle(page, 'ChDash.explorerGraph');
    const focused = await nodeBox(page, 'table:chdash_ui.weather_observations');
    await page.touchscreen.tap(focused.x + focused.width / 2, focused.y + focused.height / 2);
    const panel = page.locator('#explorerGraphPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.graphKitPanel__title')).toHaveText('weather_observations');
    const panelBox = await panel.boundingBox();
    expect(panelBox.width).toBeGreaterThan(VIEWPORTS.mobile.width - 60);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(VIEWPORTS.mobile.height + 1);
    expect(panelBox.y).toBeGreaterThan(pane.y + 40);
    await expect(panel.locator('#explorerGraphPanelOpenCard')).toBeVisible();
    // Recentred above the sheet.
    await cameraIdle(page, 'ChDash.explorerGraph');
    const moved = await nodeBox(page, 'table:chdash_ui.weather_observations');
    expect(moved.y + moved.height / 2).toBeLessThan(panelBox.y);
    await panel.locator('.graphKitPanel__close').tap();
    await expect(panel).toBeHidden();
  });
});

// A synthetic 2k-object database (1500 tables, 300 views, 100 MVs and their
// targets, 50 buffers) mocked into the all-databases payload.
function scaleCatalog(base) {
  const template = base.nodes.find((node) => node.layer === 'logical');
  const nodes = [];
  const edges = [];
  const node = (name, kind, engine, extra = {}) => nodes.push({ ...template, id: `table:chdash_scale.${name}`, database: 'chdash_scale', name, label: name, kind, engine, rows: 1000, logical_bytes: 24000, ...extra });
  const edge = (from, to, kind) => edges.push({ id: `edge:s${edges.length}`, from: `table:chdash_scale.${from}`, to: `table:chdash_scale.${to}`, kind, label: kind, can_animate: kind !== 'view' });
  const t = (i) => `t${String(i).padStart(4, '0')}`;
  for (let i = 0; i < 1500; i += 1) node(t(i), 'mergetree', 'MergeTree');
  for (let i = 0; i < 300; i += 1) { node(`v${i}`, 'view', 'View', { rows: null }); edge(t(i), `v${i}`, 'view'); }
  for (let i = 0; i < 100; i += 1) {
    node(`agg${i}`, 'mergetree', 'SummingMergeTree');
    node(`mv${i}`, 'materialized_view', 'MaterializedView', { rows: null });
    edge(t(i), `mv${i}`, 'materialized_view');
    edge(`mv${i}`, `agg${i}`, 'materialized_view_output');
  }
  for (let i = 0; i < 50; i += 1) { node(`buf${i}`, 'buffer', 'Buffer'); edge(`buf${i}`, t(i), 'buffer'); }
  return { ...base, nodes: [...base.nodes, ...nodes], edges: [...base.edges, ...edges] };
}

test('performance budgets: hover and redraw on the fixture, expanding a 2k-object database', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORTS['desktop-1440']);
  await page.goto(focusUrl('chdash_ui', 'weather_observations', { depth: 2 }));
  await graphReady(page, /neighborhood depth 2/);
  // Pointer moves are hit-tested synchronously and redraw once per frame.
  const hover = await page.evaluate(async () => {
    const canvas = document.getElementById('explorerGraphCanvas');
    const box = canvas.getBoundingClientRect();
    let sync = 0;
    for (let i = 0; i < 120; i += 1) {
      const started = performance.now();
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + 40 + (i * 11) % (box.width - 80), clientY: box.top + 40 + (i * 7) % (box.height - 80), bubbles: true }));
      sync += performance.now() - started;
      if (i % 4 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) window.ChDash.explorerGraph.redrawThemeNow();
    return { sync, redraw: (performance.now() - started) / 20 };
  });
  expect(hover.sync, 'hit testing of 120 pointer moves (ms)').toBeLessThan(120);
  expect(hover.redraw, 'one full redraw (ms)').toBeLessThan(12);

  const base = await (await request.get('/api/explorer/graph?host_id=local&mode=logical&include_non_storing=1')).json();
  const scale = scaleCatalog(base);
  await page.route('**/api/explorer/graph?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('mode') === 'logical' && !url.searchParams.get('focus_table') && !url.searchParams.get('database')) return route.fulfill({ json: scale });
    return route.continue();
  });
  await page.goto('/explorer?mode=graph&graph=lineage&depth=1');
  await graphReady(page, /collapsed database/);
  const group = (await inspect(page)).nodes.find((node) => node.database === 'chdash_scale');
  // Layout + orthogonal routing of 852 cards and 550 edges (7 s before the kit router).
  const expand = await measureFrames(page, async () => {
    await clickBox(page, group);
    await expect(page.locator('#explorerGraphStatus')).toHaveText(/\d+ nodes/, { timeout: 60_000 });
  });
  expect(expand.wallMs, 'expanding the 2k-object database (ms)').toBeLessThan(6000);
  const state = await inspect(page);
  expect(state.nodes.length).toBeGreaterThan(800);
  // Sub-columns 28 px apart share every gap: most labels still find a free
  // spot (never on top of a card or another label), a regression guard.
  expect(state.edgeLabelsDropped.length, 'labels that found no free spot').toBeLessThan(state.edges.length * 0.25);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
  const box = await page.locator('#explorerGraphCanvas').boundingBox();
  const pan = await measureFrames(page, async () => {
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 20; i += 1) { await page.mouse.move(box.x + box.width / 3 - i * 8, box.y + box.height / 2 - i * 3); await settle(page); }
    await page.mouse.up();
  });
  expect(pan.p95, 'pan frame p95 on 852 cards (ms)').toBeLessThan(40);
});
