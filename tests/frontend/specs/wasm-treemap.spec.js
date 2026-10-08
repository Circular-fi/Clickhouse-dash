import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// The treemap layout on WebAssembly (src/wasm/treemap.c, docs/wasm.md): the kernel places the nodes of a group with the
// numbers of the JavaScript layout (app_explorer_treemap.js, layoutNodesJs), and the page keeps working without it.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

async function openMap(page) {
  await page.goto('/explorer');
  await expect(page.locator('#explorerTableList')).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => !!(window.ChDash && window.ChDash.explorerTreemap));
}

async function loadKernel(page) {
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-treemap'));
  return page.evaluate(async () => {
    const kernel = await window.ChDash.explorerTreemap.ready();
    return { loaded: !!kernel, fallbacks: window.ChDash.wasm.stats.streamingFallbacks };
  });
}

// Seeded groups of nodes: ties, a dominant node, tiny and huge sizes, fractions, "Others", zero and unusable sizes.
function makeGroups(seed, count) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const groups = [];
  for (let g = 0; g < count; g += 1) {
    const n = 1 + Math.floor(next() * (g % 7 === 0 ? 400 : g % 3 === 0 ? 60 : 12));
    const mode = g % 6;
    const nodes = [];
    for (let i = 0; i < n; i += 1) {
      let bytes;
      if (mode === 0) bytes = Math.floor(Math.pow(next(), 4) * 1e9) + 1;
      else if (mode === 1) bytes = 1000 + (i % 3);
      else if (mode === 2) bytes = i === 0 ? 2 ** 52 : 1 + Math.floor(next() * 100);
      else if (mode === 3) bytes = next() * 1000 + 0.001;
      else if (mode === 4) bytes = next() < 0.2 ? 0 : Math.floor(next() * 5000);
      else bytes = Math.floor(next() * 1e12) + 1;
      const kind = next() < 0.12 ? 'other' : (next() < 0.5 ? 'table' : 'database');
      nodes.push({ name: `n${String(Math.floor(next() * 40)).padStart(2, '0')}`, bytes, kind, id: i });
    }
    const size = [[800, 400], [1440, 640], [300, 900], [60, 60], [5, 800], [1200, 1], [0, 100], [100, 20], [37.5, 91.25]][g % 9];
    groups.push({ nodes, x: Math.floor(next() * 10) * 0.5, y: Math.floor(next() * 10) * 0.25, width: size[0], height: size[1] });
  }
  return groups;
}

async function compare(page, groups) {
  return page.evaluate((groups) => {
    const { layoutNodesJs, layoutNodesWasm } = window.ChDash.explorerTreemap;
    const key = (rects) => JSON.stringify(rects.map((r) => [r.node.id, r.x, r.y, r.width, r.height]));
    const bad = [];
    let placed = 0;
    for (const [i, g] of groups.entries()) {
      const js = layoutNodesJs(g.nodes, g.x, g.y, g.width, g.height);
      const wasm = layoutNodesWasm(g.nodes, g.x, g.y, g.width, g.height);
      if (wasm === null) { bad.push({ i, reason: 'no kernel' }); continue; }
      placed += js.length;
      if (key(js) !== key(wasm) && bad.length < 3) bad.push({ i, n: g.nodes.length, js: key(js).slice(0, 300), wasm: key(wasm).slice(0, 300) });
    }
    return { bad, placed };
  }, groups);
}

test('the kernel loads as application/wasm and is instantiated by streaming', async ({ page }) => {
  await openMap(page);
  const responses = [];
  page.on('response', (response) => { if (response.url().includes('/wasm/treemap.wasm')) responses.push(response); });
  const state = await loadKernel(page);
  expect(state.loaded).toBe(true);
  expect(responses[0].headers()['content-type']).toBe('application/wasm');
  expect(state.fallbacks).toBe(0);
});

test('the kernel places every node of seeded groups exactly like the JavaScript layout', async ({ page }) => {
  test.setTimeout(120_000);
  await openMap(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const scale = Math.max(1, Number(process.env.WASM_FUZZ_SCALE) || 1);
  const result = await compare(page, makeGroups(11, 600 * scale));
  expect(result.bad).toEqual([]);
  expect(result.placed).toBeGreaterThan(2000);
});

test('a 5,000-leaf group and edge cases give the same rectangles on both paths', async ({ page }) => {
  await openMap(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const big = [];
  for (let i = 0; i < 5000; i += 1) big.push({ name: `t${i}`, bytes: 1 + ((i * 7919) % 100003), kind: i % 97 === 0 ? 'other' : 'table', id: i });
  const edge = [
    { nodes: [{ name: 'a', bytes: 5, kind: 'table', id: 0 }], x: 0, y: 0, width: 100, height: 100 },
    { nodes: [{ name: 'o', bytes: 5, kind: 'other', id: 0 }], x: 0, y: 0, width: 100, height: 100 },
    { nodes: [{ name: 'a', bytes: 5, kind: 'table', id: 0 }, { name: 'o', bytes: 1, kind: 'other', id: 1 }], x: 0, y: 0, width: 100, height: 20 },
    { nodes: [{ name: 'a', bytes: 5, kind: 'table', id: 0 }, { name: 'o', bytes: 1, kind: 'other', id: 1 }], x: 0, y: 0, width: 100, height: 0 },
    { nodes: [{ name: 'a', bytes: 0, kind: 'table', id: 0 }, { name: 'b', bytes: -3, kind: 'table', id: 1 }, { name: 'c', bytes: NaN, kind: 'table', id: 2 }], x: 0, y: 0, width: 100, height: 100 },
    { nodes: [], x: 0, y: 0, width: 100, height: 100 },
    { nodes: big, x: 0, y: 0, width: 1440, height: 800 },
    { nodes: big.slice(0, 1200), x: 3, y: 4, width: 333.3, height: 777.7 },
  ];
  const result = await compare(page, edge);
  expect(result.bad).toEqual([]);
});

test('without the kernel (the file is blocked) the map is drawn by JavaScript', async ({ page }) => {
  await page.route('**/wasm/treemap.wasm*', (route) => route.abort());
  await openMap(page);
  const state = await page.evaluate(async () => {
    await window.ChDash.loader.loadGroup('wasm-treemap');
    const kernel = await window.ChDash.explorerTreemap.ready();
    const nodes = Array.from({ length: 60 }, (_, i) => ({ name: `t${i}`, bytes: 100 + i, kind: 'table', id: i }));
    const rects = window.ChDash.explorerTreemap.layoutNodesWasm(nodes, 0, 0, 600, 300);
    return { kernel, wasm: rects, failures: window.ChDash.wasm.stats.failures };
  });
  expect(state.kernel).toBe(null);
  expect(state.wasm).toBe(null);
  expect(state.failures).toBe(1);
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerTableList')).toBeVisible({ timeout: 15_000 });
});

test('performance budget: the kernel places 5,000 nodes faster than the JavaScript layout', async ({ page }) => {
  test.setTimeout(120_000);
  await openMap(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const rows = await page.evaluate(() => {
    const { layoutNodesJs, layoutNodesWasm } = window.ChDash.explorerTreemap;
    const median = (fn) => { const t = []; for (let i = 0; i < 15; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } return t.sort((x, y) => x - y)[7]; };
    const round = (n) => Math.round(n * 1000) / 1000;
    const out = [];
    for (const n of [10, 24, 100, 1000, 5000]) {
      const nodes = Array.from({ length: n }, (_, i) => ({ name: `t${i}`, bytes: 1 + ((i * 7919) % 100003), kind: i % 97 === 96 ? 'other' : 'table', id: i }));
      layoutNodesWasm(nodes, 0, 0, 1440, 800);
      out.push({ n, js: round(median(() => layoutNodesJs(nodes, 0, 0, 1440, 800))), wasm: round(median(() => layoutNodesWasm(nodes, 0, 0, 1440, 800))) });
    }
    return out;
  });
  console.log('treemap timing (ms)', JSON.stringify(rows));
  test.info().annotations.push({ type: 'treemap-timing-ms', description: JSON.stringify(rows) });
  const big = rows.find((row) => row.n === 5000);
  expect(big.wasm).toBeLessThan(big.js);
});
