import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { buildRoutingCase, buildLayeredCase } from '../helpers/wasm-layout.js';

// The layout kernels (src/wasm/router.c, docs/wasm.md): the orthogonal router of the graph kit on WebAssembly gives the
// routes of the JavaScript router (kit.routeEdgesJs, the reference) point for point, on seeded random graphs of several
// shapes, and the page keeps its JavaScript router when the kernel is not there.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const openGraphPage = async (page) => {
  await page.goto('/explorer/catalog?mode=graph&graph=lineage&depth=1');
  await expect(page.locator('#explorerGraphPane')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-router'));
  return page.evaluate(async () => !!(await window.ChDash.wasm.load('router')));
};

// Runs both routers on each case; returns the first differences.
async function compare(page, cases) {
  return page.evaluate(({ cases, buildSource }) => {
    // eslint-disable-next-line no-new-func
    const build = new Function(`return (${buildSource})()`)();
    const kit = window.ChDash.graphKit;
    const bad = [];
    let skipped = 0;
    let compared = 0;
    let cheap = 0;
    let tPlain = 0;
    let tWasm = 0;
    for (const shape of cases) {
      const { items, edges, options } = build(shape);
      let t = performance.now();
      const reference = kit.routeEdgesJs(items, edges, options);
      tPlain += performance.now() - t;
      t = performance.now();
      const routed = kit.routeEdgesWasm(items, edges, options);
      tWasm += performance.now() - t;
      if (!routed) { skipped += 1; continue; }
      compared += 1;
      if (reference.stats.cheap) cheap += 1;
      const dump = (map) => JSON.stringify([[...map.entries()], map.stats]);
      if (dump(reference) !== dump(routed)) {
        const a = [...reference.entries()];
        const b = [...routed.entries()];
        let at = a.findIndex((entry, i) => !b[i] || JSON.stringify(entry) !== JSON.stringify(b[i]));
        if (at < 0) at = Math.min(a.length, b.length);
        bad.push({ shape, count: [a.length, b.length], stats: [reference.stats, routed.stats], at, js: a[at], wasm: b[at] });
      }
      if (bad.length >= 2) break;
    }
    return { bad, skipped, compared, cheap, tPlain, tWasm };
  }, { cases, buildSource: buildRoutingCase.toString() });
}

test('the router kernel loads as application/wasm and instantiates by streaming', async ({ page }) => {
  const responses = [];
  page.on('response', (response) => { if (response.url().includes('/wasm/router.wasm')) responses.push(response); });
  expect(await openGraphPage(page)).toBe(true);
  expect(responses[0].headers()['content-type']).toBe('application/wasm');
  expect(await page.evaluate(() => window.ChDash.wasm.stats.streamingFallbacks)).toBe(0);
});

test('the router kernel gives the routes of the JavaScript router on small graphs, edge cases included', async ({ page }) => {
  test.setTimeout(180_000);
  expect(await openGraphPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 60; seed += 1) cases.push({ seed, nodes: 4 + (seed % 9), edges: 3 + (seed % 17), secondary: (seed % 4) * 0.25 });
  for (let seed = 100; seed < 130; seed += 1) cases.push({ seed, nodes: 6 + (seed % 7), edges: 8 + (seed % 9), cycles: true, secondary: 0.3 });
  for (let seed = 200; seed < 230; seed += 1) cases.push({ seed, nodes: 5 + (seed % 6), edges: 6 + (seed % 8), odd: true, secondary: 0.4 });
  for (let seed = 300; seed < 320; seed += 1) cases.push({ seed, nodes: 8, edges: 9 + (seed % 5), rowGrid: false, wide: true });
  cases.push({ seed: 5, nodes: 1, edges: 0 }, { seed: 6, nodes: 2, edges: 1 }, { seed: 7, nodes: 3, edges: 2, cycles: true, odd: true });
  const result = await compare(page, cases);
  expect(result.bad).toEqual([]);
  expect(result.compared).toBeGreaterThan(cases.length * 0.9);
});

test('the router kernel gives the routes of the JavaScript router past the step budget (cheap routes)', async ({ page }) => {
  test.setTimeout(240_000);
  expect(await openGraphPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 24; seed += 1) {
    cases.push({ seed, nodes: 10 + (seed % 6), edges: 40 + seed * 3, cycles: seed % 3 === 0, secondary: 0.2, budget: { maxSteps: 4000 + seed * 500, searchSteps: 800 + seed * 40 } });
  }
  cases.push({ seed: 77, nodes: 12, edges: 60, budget: { maxSteps: 1, searchSteps: 1 } });
  cases.push({ seed: 78, nodes: 12, edges: 60, budget: { maxSteps: 0, searchSteps: 0 } });
  const result = await compare(page, cases);
  expect(result.bad).toEqual([]);
  expect(result.cheap).toBeGreaterThan(5);
  expect(result.compared).toBeGreaterThan(cases.length * 0.9);
});

test('the router kernel gives the routes of the JavaScript router on 100 to 300 edges', async ({ page }) => {
  test.setTimeout(300_000);
  expect(await openGraphPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 8; seed += 1) cases.push({ seed: 1000 + seed, nodes: 40 + seed * 10, edges: 100 + seed * 25, secondary: 0.25, budget: { maxSteps: 160000, searchSteps: 40000 } });
  const result = await compare(page, cases);
  console.log('router 100-300 edges', JSON.stringify({ compared: result.compared, skipped: result.skipped, jsMs: Math.round(result.tPlain), wasmMs: Math.round(result.tWasm) }));
  expect(result.bad).toEqual([]);
  expect(result.compared).toBeGreaterThan(cases.length - 2);
});

test('without the kernel (the file is blocked) kit.routeEdges still routes with JavaScript', async ({ page }) => {
  await page.route('**/wasm/router.wasm*', (route) => route.abort());
  expect(await openGraphPage(page)).toBe(false);
  const state = await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const items = new Map([['a', { x: 0, y: 0, width: 190, height: 56, lineageRow: 0 }], ['b', { x: 400, y: 0, width: 190, height: 56, lineageRow: 0 }]]);
    const edges = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b' }));
    const routes = kit.routeEdges(items, edges);
    return { count: routes.size, points: routes.get('e0').points.length, wasm: kit.routeEdgesWasm(items, edges) };
  });
  expect(state.count).toBe(9);
  expect(state.points).toBeGreaterThanOrEqual(2);
  expect(state.wasm).toBe(null);
});

const openLayeredPage = async (page) => {
  await page.goto('/explorer/catalog?mode=graph&graph=lineage&depth=1');
  await expect(page.locator('#explorerGraphPane')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-layered'));
  return page.evaluate(async () => !!(await window.ChDash.wasm.load('layered')));
};

// The columns, their order, the levels, the back edges and the rows of both layouts, for each case.
async function compareLayered(page, cases) {
  return page.evaluate(({ cases, buildSource }) => {
    // eslint-disable-next-line no-new-func
    const build = new Function(`return (${buildSource})()`)();
    const kit = window.ChDash.graphKit;
    const ns = window.ChDash;
    const kernel = ns.wasm.get('layered');
    const bad = [];
    let skipped = 0;
    let tJs = 0;
    let tWasm = 0;
    const dump = (r) => JSON.stringify({
      levels: r.levels, columns: [...r.columns.entries()].map(([l, g]) => [l, g.map((n) => n.id)]).sort((a, b) => a[0] - b[0]),
      level: [...r.level.entries()], back: [...r.backEdges].sort(), rows: [...r.lineageRows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    });
    for (const shape of cases) {
      const options = build(shape);
      let t = performance.now();
      const reference = kit.layeredOrderJs(options);
      tJs += performance.now() - t;
      t = performance.now();
      const input = ns.wasm.layered.pack(options);
      const result = input ? ns.wasm.ops.layered.run(kernel, input) : { status: -2 };
      const answer = result.status === 0 ? ns.wasm.layered.unpack(options, result) : null;
      tWasm += performance.now() - t;
      if (!answer) { skipped += 1; continue; }
      if (dump(reference) !== dump(answer)) bad.push({ shape, js: dump(reference).slice(0, 400), wasm: dump(answer).slice(0, 400) });
      if (bad.length >= 2) break;
    }
    return { bad, skipped, total: cases.length, tJs, tWasm };
  }, { cases, buildSource: buildLayeredCase.toString() });
}

test('the layered kernel gives the columns, the order and the rows of the JavaScript layout', async ({ page }) => {
  test.setTimeout(240_000);
  expect(await openLayeredPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 80; seed += 1) cases.push({ seed, nodes: 2 + (seed % 40), edges: seed % 60, rowGrid: seed % 5 !== 0, weighted: seed % 2 === 0 });
  for (let seed = 100; seed < 160; seed += 1) cases.push({ seed, nodes: 5 + (seed % 30), edges: 5 + (seed % 70), breakCycles: true, rowGrid: seed % 4 !== 0, names: seed % 3 === 0, weighted: true });
  for (let seed = 200; seed < 260; seed += 1) cases.push({ seed, nodes: 4 + (seed % 25), edges: 3 + (seed % 50), odd: true, rowGrid: seed % 3 !== 0, breakCycles: seed % 2 === 0, names: true });
  for (let seed = 300; seed < 310; seed += 1) cases.push({ seed, nodes: 150 + seed, edges: 200 + seed * 2, rowGrid: true, breakCycles: seed % 2 === 0, weighted: true });
  cases.push({ seed: 9, nodes: 0, edges: 0 }, { seed: 10, nodes: 1, edges: 0 }, { seed: 11, nodes: 3, edges: 0, rowGrid: true });
  const result = await compareLayered(page, cases);
  console.log('layered', JSON.stringify({ total: result.total, skipped: result.skipped, jsMs: Math.round(result.tJs), wasmMs: Math.round(result.tWasm) }));
  expect(result.bad).toEqual([]);
  expect(result.skipped).toBeLessThan(cases.length * 0.1);
});
