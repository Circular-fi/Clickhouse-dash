import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp } from '../helpers/app.js';

// The general path of the Query chart model on WebAssembly (src/wasm/chartprep.c, docs/wasm.md): rows that are not one
// per x in ascending order are sorted, merged and summed by the kernel. The model must equal the JavaScript one, double
// for double, on seeded results of every shape; without the kernel the JavaScript path answers.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const SHAPES = [
  { name: 'unsorted numbers with duplicates, NaN x and NULL values', kind: 'numbers', rows: 30000, seed: 1, types: ['Float64', 'Float64', 'Float64'], columns: ['x', 'a', 'b'] },
  { name: 'unsorted numbers, one series', kind: 'numbers', rows: 25000, seed: 2, types: ['Int64', 'Float64'], columns: ['x', 'a'] },
  { name: 'times out of order, duplicates and invalid text', kind: 'times', rows: 40000, seed: 3, types: ['DateTime', 'Float64', 'UInt32'], columns: ['t', 'a', 'b'] },
  { name: 'times with a group column folded into Other', kind: 'grouped', rows: 50000, seed: 4, types: ['DateTime', 'String', 'Float64'], columns: ['t', 'g', 'v'], groups: 30 },
  { name: 'times with a few groups and two series', kind: 'grouped', rows: 30000, seed: 5, types: ['DateTime', 'String', 'Float64', 'Float64'], columns: ['t', 'g', 'v', 'w'], groups: 3 },
  { name: 'categories', kind: 'categories', rows: 30000, seed: 6, types: ['String', 'Float64', 'Float64', 'Float64'], columns: ['k', 'a', 'b', 'c'], config: { x: 0, xAuto: false } },
  { name: 'zeros, negative zeros and infinities', kind: 'special', rows: 30000, seed: 7, types: ['Float64', 'Float64'], columns: ['x', 'a'] },
  { name: 'every x is NaN', kind: 'nan', rows: 25000, seed: 8, types: ['Float64', 'Float64'], columns: ['x', 'a'] },
  { name: 'ascending with one dip at the end', kind: 'dip', rows: 30000, seed: 9, types: ['Float64', 'Float64'], columns: ['x', 'a'] },
  { name: 'the row number as x (no x column)', kind: 'numbers', rows: 25000, seed: 10, types: ['Float64', 'Float64'], columns: ['x', 'a'], config: { x: -1, xAuto: false } },
  { name: 'below the kernel threshold', kind: 'numbers', rows: 500, seed: 11, types: ['Float64', 'Float64'], columns: ['x', 'a'] },
  { name: 'a large result', kind: 'times', rows: 250000, seed: 12, types: ['DateTime', 'Float64', 'UInt32'], columns: ['t', 'a', 'b'] },
];

// Runs in the page: builds the model of each seeded result with the kernel and with JavaScript and lists the differences.
async function compare(page, shapes) {
  return page.evaluate(async (shapes) => {
    const ns = window.ChDash;
    await ns.queryChart.loadCore();
    const t = ns.queryChart.testing;
    const gen = {
      numbers: (rand, r) => [rand() < 0.02 ? 'n/a' : String(Math.floor(rand() * 5000)), rand() < 0.1 ? null : (rand() * 100).toFixed(3), rand() < 0.05 ? 'x' : Math.floor(rand() * 10)],
      times: (rand, r) => [rand() < 0.01 ? 'soon' : new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 90000) * 1000).toISOString().replace('.000Z', 'Z'), rand() < 0.1 ? null : Math.floor(rand() * 1000) / 4, Math.floor(rand() * 50)],
      grouped: (rand, r, s) => [new Date(Date.UTC(2026, 0, 1) + Math.floor(rand() * 600) * 60000).toISOString().replace('.000Z', 'Z'), 'g' + Math.floor(rand() * rand() * s.groups), Math.floor(rand() * 100) - 20, rand() < 0.2 ? null : Math.floor(rand() * 9)],
      categories: (rand, r) => ['k' + Math.floor(rand() * 40), Math.floor(rand() * 100), rand() < 0.3 ? null : rand() * 3, Math.floor(rand() * 7)],
      special: (rand, r) => [[0, -0, 0, 1, -1, Infinity, -Infinity, 1e300, 5e-324][Math.floor(rand() * 9)], [0, -0, 1.5, Infinity, -Infinity, 1e308, 1e308, NaN][Math.floor(rand() * 8)]],
      nan: (rand, r) => [NaN, rand()],
      dip: (rand, r, s) => [r === s.rows - 1 ? -5 : r, rand()],
    };
    const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v === 0 ? 0 : v, b[i] === 0 ? 0 : b[i]));
    const summary = (model) => ({
      xKind: model.xKind, skipped: model.skipped, summed: model.summed, rowCount: model.rowCount, subMillisecond: model.subMillisecond, folded: model.foldedGroups,
      xs: Array.from(model.xs), categories: model.categories,
      lines: model.lines.map((line) => ({ id: line.id, slot: line.slot, values: Array.from(line.values), nulls: line.nulls ? Array.from(line.nulls) : null })),
    });
    const diffs = [];
    for (const shape of shapes) {
      let seed = shape.seed >>> 0;
      const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const rows = [];
      for (let r = 0; r < shape.rows; r += 1) rows.push(gen[shape.kind](rand, r, shape));
      const meta = { kinds: shape.types.map((type) => ns.queryChart.columnKind(type)), columns: shape.columns };
      const cfg = t.normalizeConfig({ ...t.defaultConfig(meta), ...(shape.config || {}) }, meta);
      t.setWasm(false);
      const js = summary(t.buildModel(JSON.parse(JSON.stringify(cfg)), meta, rows, t.createStore()));
      t.setWasm(true);
      const wasm = summary(t.buildModel(JSON.parse(JSON.stringify(cfg)), meta, rows, t.createStore()));
      const problems = [];
      for (const key of ['xKind', 'skipped', 'summed', 'rowCount', 'subMillisecond', 'folded']) if (js[key] !== wasm[key]) problems.push(`${key}: ${js[key]} vs ${wasm[key]}`);
      if (!same(js.xs, wasm.xs)) problems.push('xs');
      if (JSON.stringify(js.categories) !== JSON.stringify(wasm.categories)) problems.push('categories');
      if (js.lines.length !== wasm.lines.length) problems.push('line count');
      else js.lines.forEach((line, i) => {
        if (line.id !== wasm.lines[i].id || line.slot !== wasm.lines[i].slot) problems.push(`line ${i} identity`);
        if (!same(line.values, wasm.lines[i].values)) problems.push(`line ${i} values`);
        if (JSON.stringify(line.nulls) !== JSON.stringify(wasm.lines[i].nulls)) problems.push(`line ${i} nulls`);
      });
      if (problems.length) diffs.push({ name: shape.name, problems: problems.slice(0, 5) });
    }
    return { diffs, kernel: !!ns.wasm.get('chartprep') };
  }, shapes);
}

test('the kernel builds the same chart model as JavaScript on seeded results of every shape', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  const result = await compare(page, SHAPES);
  expect(result.kernel).toBe(true);
  expect(result.diffs).toEqual([]);
});

test('without the kernel (the file is blocked) the chart model is still built by JavaScript', async ({ page }) => {
  await page.route('**/wasm/chartprep.wasm*', (route) => route.abort());
  await openApp(page);
  const result = await compare(page, SHAPES.slice(0, 3));
  expect(result.kernel).toBe(false);
  expect(result.diffs).toEqual([]);
});

test('performance budget: the kernel builds the model of 1,000,000 unsorted rows at least three times faster than JavaScript', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const result = await page.evaluate(async () => {
    const ns = window.ChDash;
    await ns.queryChart.loadCore();
    const t = ns.queryChart.testing;
    let seed = 99;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const rows = [];
    for (let r = 0; r < 1000000; r += 1) rows.push([String(Math.floor(rand() * 3000000)), Math.floor(rand() * 1000), rand() * 1e6]);
    const meta = { kinds: ['number', 'number', 'number'], columns: ['x', 'a', 'b'] };
    const cfg = t.normalizeConfig({ ...t.defaultConfig(meta) }, meta);
    const store = t.createStore();
    // Parse once (shared): both paths time the general path on parsed columns, as buildModel does after parsing.
    t.buildModel(JSON.parse(JSON.stringify(cfg)), meta, rows, store);
    const time = (on) => { t.setWasm(on); const a = performance.now(); t.buildModel(JSON.parse(JSON.stringify(cfg)), meta, rows, store); return performance.now() - a; };
    const median = (on) => { const v = [time(on), time(on), time(on)].sort((p, q) => p - q); return v[1]; };
    return { js: median(false), wasm: median(true) };
  });
  test.info().annotations.push({ type: 'chartprep-ms', description: JSON.stringify(result) });
  console.log('chartprep 1M unsorted rows (ms)', JSON.stringify(result));
  expect(result.wasm * 3).toBeLessThan(result.js);
});
