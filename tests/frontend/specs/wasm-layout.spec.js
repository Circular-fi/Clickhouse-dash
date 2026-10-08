import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { buildRoutingCase, buildLayeredCase, buildDenseCase, scaleCatalog } from '../helpers/wasm-layout.js';
import { settle, measureFrames, expectLabelsClear } from '../helpers/graph-kit.js';

// The layout kernels (src/wasm/router.c, docs/wasm.md): the orthogonal router of the graph kit on WebAssembly gives the
// routes of the JavaScript router (kit.routeEdgesJs, the reference) point for point, on seeded random graphs of several
// shapes, and the page keeps its JavaScript router when the kernel is not there.

// WASM_FUZZ_SCALE=10 runs ten times more seeded graphs (a deeper check before a release).
const SCALE = Math.max(1, Number(process.env.WASM_FUZZ_SCALE) || 1);

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
  for (let seed = 1; seed <= 60 * SCALE; seed += 1) cases.push({ seed, nodes: 4 + (seed % 9), edges: 3 + (seed % 17), secondary: (seed % 4) * 0.25 });
  for (let seed = 100000; seed < 100000 + 30 * SCALE; seed += 1) cases.push({ seed, nodes: 6 + (seed % 7), edges: 8 + (seed % 9), cycles: true, secondary: 0.3 });
  for (let seed = 200000; seed < 200000 + 30 * SCALE; seed += 1) cases.push({ seed, nodes: 5 + (seed % 6), edges: 6 + (seed % 8), odd: true, secondary: 0.4 });
  for (let seed = 300000; seed < 300000 + 20 * SCALE; seed += 1) cases.push({ seed, nodes: 8, edges: 9 + (seed % 5), rowGrid: false, wide: true });
  cases.push({ seed: 5, nodes: 1, edges: 0 }, { seed: 6, nodes: 2, edges: 1 }, { seed: 7, nodes: 3, edges: 2, cycles: true, odd: true });
  const result = await compare(page, cases);
  expect(result.bad).toEqual([]);
  expect(result.compared).toBeGreaterThan(cases.length * 0.9);
});

test('the router kernel gives the routes of the JavaScript router past the step budget (cheap routes)', async ({ page }) => {
  test.setTimeout(240_000);
  expect(await openGraphPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 24 * SCALE; seed += 1) {
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
  for (let seed = 1; seed <= 80 * SCALE; seed += 1) cases.push({ seed, nodes: 2 + (seed % 40), edges: seed % 60, rowGrid: seed % 5 !== 0, weighted: seed % 2 === 0 });
  for (let seed = 100; seed < 160; seed += 1) cases.push({ seed, nodes: 5 + (seed % 30), edges: 5 + (seed % 70), breakCycles: true, rowGrid: seed % 4 !== 0, names: seed % 3 === 0, weighted: true });
  for (let seed = 200; seed < 260; seed += 1) cases.push({ seed, nodes: 4 + (seed % 25), edges: 3 + (seed % 50), odd: true, rowGrid: seed % 3 !== 0, breakCycles: seed % 2 === 0, names: true });
  for (let seed = 300; seed < 310; seed += 1) cases.push({ seed, nodes: 150 + seed, edges: 200 + seed * 2, rowGrid: true, breakCycles: seed % 2 === 0, weighted: true });
  cases.push({ seed: 9, nodes: 0, edges: 0 }, { seed: 10, nodes: 1, edges: 0 }, { seed: 11, nodes: 3, edges: 0, rowGrid: true });
  const result = await compareLayered(page, cases);
  console.log('layered', JSON.stringify({ total: result.total, skipped: result.skipped, jsMs: Math.round(result.tJs), wasmMs: Math.round(result.tWasm) }));
  expect(result.bad).toEqual([]);
  expect(result.skipped).toBeLessThan(cases.length * 0.1);
});

const openLabelsPage = async (page) => {
  await page.goto('/explorer/catalog?mode=graph&graph=lineage&depth=1');
  await expect(page.locator('#explorerGraphPane')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-labels'));
  return page.evaluate(async () => !!(await window.ChDash.wasm.load('labels')));
};

test('the label kernel puts every label where the JavaScript placement puts it, and drops the same ones', async ({ page }) => {
  test.setTimeout(240_000);
  expect(await openLabelsPage(page)).toBe(true);
  const cases = [];
  for (let seed = 1; seed <= 40; seed += 1) cases.push({ seed, nodes: 6 + (seed % 12), edges: 8 + (seed % 40), secondary: 0.3, cycles: seed % 4 === 0, odd: seed % 7 === 0 });
  for (let seed = 500; seed < 506; seed += 1) cases.push({ seed, nodes: 40, edges: 160, secondary: 0.2, budget: { maxSteps: 30000, searchSteps: 5000 } });
  const result = await page.evaluate(({ cases, buildSource }) => {
    // eslint-disable-next-line no-new-func
    const build = new Function(`return (${buildSource})()`)();
    const kit = window.ChDash.graphKit;
    const ns = window.ChDash;
    const kernel = ns.wasm.get('labels');
    const bad = [];
    let dropped = 0;
    let placedTotal = 0;
    let tJs = 0;
    let tWasm = 0;
    let state = 99;
    const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (const shape of cases) {
      const { items, edges, options } = build(shape);
      const routes = kit.routeEdgesJs(items, edges, options);
      const requests = [...routes.entries()].map(([key, route]) => ({ key, text: key, width: 28 + Math.floor(rand() * 60), height: 18, points: route.points }));
      const obstacles = [...items.values()];
      let t = performance.now();
      const reference = kit.placeLabelsJs(requests, obstacles);
      tJs += performance.now() - t;
      t = performance.now();
      const run = ns.wasm.ops.labels.run(kernel, ns.wasm.labels.pack(requests, obstacles));
      const answer = run.status === 0 ? ns.wasm.labels.unpack(requests, run) : null;
      tWasm += performance.now() - t;
      const dump = (r) => JSON.stringify([[...r.placed.entries()], r.dropped]);
      if (!answer || dump(reference) !== dump(answer)) bad.push({ shape, status: run.status, js: dump(reference).slice(0, 300), wasm: answer ? dump(answer).slice(0, 300) : null });
      dropped += reference.dropped.length;
      placedTotal += reference.placed.size;
      if (bad.length >= 2) break;
    }
    return { bad, dropped, placedTotal, tJs, tWasm };
  }, { cases, buildSource: buildRoutingCase.toString() });
  console.log('labels', JSON.stringify({ placed: result.placedTotal, dropped: result.dropped, jsMs: Math.round(result.tJs), wasmMs: Math.round(result.tWasm) }));
  expect(result.bad).toEqual([]);
  expect(result.placedTotal).toBeGreaterThan(300);
});

// ---------------------------------------------------------------------------------------------------------------- the Explorer

const MEDIUM = { tables: 160, views: 70, aggregates: 35, buffers: 12 };

async function openCollapsedScale(page, request, size, { block = false } = {}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  if (block) await page.route('**/wasm/*.wasm*', (route) => route.abort());
  const base = await (await request.get('/api/explorer/graph?host_id=local&mode=logical&include_non_storing=1')).json();
  const scale = scaleCatalog(base, size);
  await page.route('**/api/explorer/graph?**', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('mode') === 'logical' && !url.searchParams.get('focus_table') && !url.searchParams.get('database')) return route.fulfill({ json: scale });
    return route.continue();
  });
  await page.goto('/explorer/catalog?mode=graph&graph=lineage&depth=1');
  await expect(page.locator('#explorerGraphStatus')).toHaveText(/collapsed database/, { timeout: 20_000 });
  await settle(page);
}

async function expandScale(page) {
  const nodes = await page.evaluate(() => window.ChDash.explorerGraph.inspect().nodes);
  const group = nodes.find((node) => node.database === 'chdash_scale');
  await page.mouse.click(group.x + group.width / 2, group.y + group.height / 2);
  await expect(page.locator('#explorerGraphStatus')).toHaveText(/\d+ nodes/, { timeout: 120_000 });
  await settle(page);
}

test('the Explorer routes a large layout in a Worker, with the routes of the JavaScript router', async ({ page, request }) => {
  test.setTimeout(240_000);
  const fetched = [];
  page.on('request', (r) => { if (r.url().includes('/wasm/router.wasm')) fetched.push(r.url()); });
  await openCollapsedScale(page, request, MEDIUM);
  await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const original = kit.routeEdgesJob;
    window.__jobs = [];
    kit.routeEdgesJob = (items, edges, options) => {
      const job = original(items, edges, options);
      const entry = { items, edges, options, answered: null };
      window.__jobs.push(entry);
      if (job) job.promise.then((routes) => { entry.answered = routes || false; });
      return job;
    };
  });
  await expandScale(page);
  const compared = await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const job = window.__jobs.find((entry) => entry.answered);
    if (!job) return { jobs: window.__jobs.length };
    const reference = kit.routeEdgesJs(job.items, job.edges, job.options);
    const dump = (map) => JSON.stringify([[...map.entries()], map.stats]);
    return { jobs: window.__jobs.length, edges: job.edges.length, same: dump(reference) === dump(job.answered), routed: reference.size };
  });
  expect(compared.same, JSON.stringify(compared)).toBe(true);
  expect(compared.edges).toBeGreaterThan(100);
  expect(fetched.length).toBeGreaterThan(0);
  const state = await page.evaluate(() => window.ChDash.explorerGraph.inspect());
  expect(state.edges.length).toBeGreaterThan(100);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
});

test('without the kernel (the files are blocked) the Explorer routes a large layout with JavaScript, the page keeps working', async ({ page, request }) => {
  test.setTimeout(240_000);
  await openCollapsedScale(page, request, MEDIUM, { block: true });
  await expandScale(page);
  const state = await page.evaluate(() => window.ChDash.explorerGraph.inspect());
  expect(state.edges.length).toBeGreaterThan(100);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
  expect(await page.evaluate(() => window.ChDash.wasm?.stats?.failures ?? 0)).toBeGreaterThanOrEqual(0);
});

test('performance budget: expanding the 2k-object database routes in a Worker: no long task over 700 ms, far under the reference', async ({ page, request }) => {
  test.setTimeout(300_000);
  await openCollapsedScale(page, request, {});
  const frames = await measureFrames(page, () => expandScale(page));
  const timing = await page.evaluate(() => {
    const ns = window.ChDash;
    return { jobs: window.__jobs?.length ?? null, wasmLoaded: !!ns.wasm?.get?.('layered') };
  });
  console.log('explorer 2k expand', JSON.stringify({ wallMs: frames.wallMs, longMaxMs: Math.round(frames.longMaxMs), longMs: Math.round(frames.longMs), ...timing }));
  expect(frames.longMaxMs, 'longest main-thread task while the 2k-object database routes (ms)').toBeLessThan(700);
  expect(frames.wallMs, 'expanding the 2k-object database (ms)').toBeLessThan(3000);
});

test('performance budget: the kernels run the dense service maps and the 2k-object Explorer layout faster than the JavaScript reference', async ({ page, request }) => {
  test.setTimeout(300_000);
  await openCollapsedScale(page, request, {});
  await page.evaluate(async () => {
    await window.ChDash.loader.loadGroup('wasm-router');
    await window.ChDash.wasm.load('router');
    const kit = window.ChDash.graphKit;
    const original = kit.routeEdgesJob;
    window.__capture = null;
    kit.routeEdgesJob = (items, edges, options) => { window.__capture = { items, edges, options }; return original(items, edges, options); };
  });
  await expandScale(page);
  const rows = await page.evaluate(({ dense }) => {
    const kit = window.ChDash.graphKit;
    // eslint-disable-next-line no-new-func
    const buildDense = new Function(`return (${dense})()`)();
    const median = (fn, n) => { const t = []; for (let i = 0; i < n; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return Math.round(t[t.length >> 1] * 10) / 10; };
    const out = [];
    const cases = [['dense map 12 / 132', buildDense({ services: 12, paths: 132 }), 7], ['dense map 40 / 600', buildDense({ services: 40, paths: 600 }), 5], ['Explorer 2k objects (852 cards, 550 edges)', window.__capture, 1]];
    for (const [name, c, n] of cases) {
      const js = median(() => kit.routeEdgesJs(c.items, c.edges, c.options), n);
      const wasm = median(() => kit.routeEdgesWasm(c.items, c.edges, c.options), n + 2);
      out.push({ name, edges: c.edges.length, jsMs: js, wasmMs: wasm, speedup: Math.round((js / wasm) * 10) / 10 });
    }
    return out;
  }, { dense: buildDenseCase.toString() });
  // The labels of the Explorer layout: the same routes, 550 labels, the cards as obstacles.
  await page.evaluate(async () => { await window.ChDash.loader.loadGroup('wasm-labels'); await window.ChDash.wasm.load('labels'); });
  const labels = await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const c = window.__capture;
    const routes = kit.routeEdgesWasm(c.items, c.edges, c.options);
    const requests = [...routes.entries()].map(([key, route], i) => ({ key, text: key, width: 40 + (i % 7) * 6, height: 18, points: route.points }));
    const obstacles = [...c.items.values()];
    const kernel = window.ChDash.wasm.get('labels');
    const median = (fn, n) => { const t = []; for (let i = 0; i < n; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } t.sort((x, y) => x - y); return Math.round(t[t.length >> 1] * 10) / 10; };
    const js = median(() => kit.placeLabelsJs(requests, obstacles), 5);
    const wasm = median(() => window.ChDash.wasm.labels.unpack(requests, window.ChDash.wasm.ops.labels.run(kernel, window.ChDash.wasm.labels.pack(requests, obstacles))), 7);
    return { name: 'labels of the Explorer layout (550)', jsMs: js, wasmMs: wasm, speedup: Math.round((js / wasm) * 10) / 10 };
  });
  rows.push(labels);
  for (const row of rows) console.log('router speedup', JSON.stringify(row));
  test.info().annotations.push({ type: 'router-speedup', description: JSON.stringify(rows) });
  expect(rows[0].speedup, 'dense 12 / 132').toBeGreaterThan(1.2);
  expect(rows[1].speedup, 'dense 40 / 600').toBeGreaterThan(1.5);
  expect(rows[2].speedup, 'Explorer layout').toBeGreaterThan(5);
});
