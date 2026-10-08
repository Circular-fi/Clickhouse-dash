import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { rng } from '../helpers/wasm.js';

// The colour arithmetic on WebAssembly (src/wasm/color.c, docs/wasm.md): normalize, readable text, hash slots, sequential and
// categorical slots (ns.palette.batch), mixColorBatch (the graph kit), parseColors and rgbaBatch (the chart engine). Each batch
// op must give what the single JavaScript function gives, byte for byte; the items the kernel hands back run the single function.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const SCALE = Math.max(1, Number(process.env.WASM_FUZZ_SCALE) || 1);

async function openTraces(page) {
  await page.goto('/observability/traces');
  await page.waitForFunction(() => !!(window.ChDash && window.ChDash.palette && window.ChDash.graphKit && window.ChDash.chartCore));
}

async function loadKernel(page) {
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-color'));
  return page.evaluate(async () => {
    const kernel = await window.ChDash.wasm.load('color');
    return { loaded: !!kernel, fallbacks: window.ChDash.wasm.stats.streamingFallbacks };
  });
}

const NUM = ['0', '1', '7', '12', '127.5', '255', '256', '300', '0.5', '.5', '5.', '0.123456', '99.9', '1e3', '-1', '1.2.3', '.', '0.0005', '0.9995', '0.001', '0.0015', '0.9994999', '12345678901234567890'];
const WS = [' ', '  ', '', '\t', ' ', ' ', ','];
const NAMES = ['red', 'transparent', '#abc', '#aabbcc', '#AABBCC', '#12345g', 'var(--x)', 'hsl(0 0% 0%)', 'oklch(0.5 0.1 20)', '', 'rgb', 'rgb(', 'rgb(1,2', 'color(display-p3 1 0 0)'];

function colorTexts(seed, count) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const roll = r.next();
    const n = () => r.pick(NUM);
    const sep = () => r.pick([', ', ',', ' ', '  ', ' , ', ' ']);
    if (roll < 0.34) out.push(`${r.pick(['rgb', 'rgba'])}(${r.pick(WS)}${n()}${sep()}${n()}${sep()}${n()}${r.pick(['', `${r.pick([', ', ' / ', ',', '/'])}${n()}`, `${r.pick([', ', ' / '])}${r.pick(['0', '50', '100', '12.5'])}%`])}${r.pick(WS)})`);
    else if (roll < 0.52) out.push(`color(srgb ${r.pick(['0.5', '1', '0', '0.123', '.25', '1e-2', '0.5e0', '-0.1'])} ${r.pick(['0.5', '1', '0.9'])} ${r.pick(['0.5', '1', '0.999'])}${r.pick(['', ' / 0.5', ' / 1', ' / 0.25', ' / 12%'])})`);
    else if (roll < 0.62) out.push(`rgb(${r.int(256)}, ${r.int(256)}, ${r.int(256)})`);
    else if (roll < 0.72) out.push(`rgba(${r.int(256)}, ${r.int(256)}, ${r.int(256)}, ${r.pick(['0', '0.5', '0.25', '0.05', '0.999', '1', '0.3', '0.14', '0.0005', '0.0015', '0.09'])})`);
    else if (roll < 0.78) out.push(`  ${r.pick(NAMES)}  `);
    else if (roll < 0.9) out.push(`rgb(${r.int(300)}.${r.int(10)}, ${r.int(300)}, ${r.int(256)}.${r.int(100)})`);
    else out.push(r.pick(NAMES));
  }
  return out;
}

test('the kernel loads as application/wasm and is instantiated by streaming', async ({ page }) => {
  await openTraces(page);
  const responses = [];
  page.on('response', (response) => { if (response.url().includes('/wasm/color.wasm')) responses.push(response); });
  const state = await loadKernel(page);
  expect(state.loaded).toBe(true);
  expect(responses[0].headers()['content-type']).toBe('application/wasm');
  expect(state.fallbacks).toBe(0);
});

test('normalize, readable text, slots and steps give the single functions\' answers, item by item', async ({ page }) => {
  test.setTimeout(120_000);
  await openTraces(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const texts = colorTexts(21, 3000 * SCALE);
  const names = [];
  const r = rng(5);
  for (let i = 0; i < 1500 * SCALE; i += 1) names.push(r.pick(['', 'checkout', 'cart-api', 'café', '中文', 'emoji😀', 'lone\ud800', 'a'.repeat(1 + r.int(200)), `svc-${r.int(100000)}`, `S${r.int(50)}`]));
  const fills = [];
  for (let n = 1; n <= 18; n += 1) fills.push(`--qchart-${n}`, `--trace-span-color-${n}`, `var(--trace-span-color-${n})`, `color-mix(in srgb, var(--trace-span-color-${n}) 40%, var(--panelBg))`, `color-mix(in srgb, var(--qchart-${n}) 60%, white)`);
  fills.push('', 'garbage', '#fff', '#000000', 'rgb(10, 20, 30)', 'rgba(255, 255, 255, 0.5)', 'red', 'rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'rgb(128, 128, 128)', 'rgb(118, 118, 118)', 'rgb(119, 119, 119)');
  const result = await page.evaluate(({ texts, names, fills }) => {
    const p = window.ChDash.palette;
    const b = p.batch;
    const out = {};
    const same = (list, ref) => { const bad = []; list.forEach((v, i) => { if (JSON.stringify(v) !== JSON.stringify(ref[i]) && bad.length < 3) bad.push({ i, got: v, want: ref[i] }); }); return bad; };
    out.normalize = same(b.normalizeBatch(texts, true), texts.map((t) => b.normalize(t)));
    // How many items the kernel itself answered (the rest ran the single function).
    const kernel = window.ChDash.wasm.get('color');
    const direct = window.ChDash.wasm.ops.color.normalize(kernel, { texts: texts.map((t) => String(t).trim()) });
    out.decided = direct.status.filter((s) => s !== 2).length / texts.length;
    out.readable = same(b.readableTextBatch(fills, true), fills.map((f) => p.readableText(f)));
    out.readableTokens = new Set(b.readableTextBatch(fills, true)).size;
    out.slots = same(b.hashSlotBatch(names, true), names.map((n) => p.serviceSlot(n, { assign: false })));
    const ts = [0, 1, 0.5, 0.07, 0.43, 0.9999, -3, 7, NaN, Infinity, -Infinity, '0.3', null, undefined, 'x', 0.0625, 0.125, 0.1875, 0.4999999, 0.5000001, 0.3125];
    for (let i = 0; i < 400; i += 1) ts.push(Math.random() < 0.5 ? i / 399 : Math.sin(i * 12.9898) * 0.7 + 0.5);
    out.sequential = same(b.sequentialBatch(ts, true), ts.map((t) => p.sequential(t)));
    const idx = [0, 1, 17, 18, 19, 35, 36, -1, -0.5, 0.9, 2.7, NaN, Infinity, '3', null, undefined, 'x', 1e15, 2 ** 53, 2 ** 60, -0];
    for (let i = 0; i < 300; i += 1) idx.push(i * 7 - 20);
    out.categorical = same(b.categoricalBatch(idx, true), idx.map((i) => p.categorical(i)));
    return out;
  }, { texts, names, fills });
  expect(result.normalize).toEqual([]);
  expect(result.decided).toBeGreaterThan(0.7);
  expect(result.readable).toEqual([]);
  expect(result.readableTokens).toBe(2);
  expect(result.slots).toEqual([]);
  expect(result.sequential).toEqual([]);
  expect(result.categorical).toEqual([]);
});

test('mixColorBatch, parseColors and rgbaBatch give the single functions\' answers', async ({ page }) => {
  test.setTimeout(120_000);
  await openTraces(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const texts = colorTexts(77, 2500 * SCALE);
  const result = await page.evaluate((texts) => {
    const kit = window.ChDash.graphKit;
    const { parseColor, parseColors, rgba, rgbaBatch } = window.ChDash.chartCore.colors;
    const same = (list, ref) => { const bad = []; list.forEach((v, i) => { if (JSON.stringify(v) !== JSON.stringify(ref[i]) && bad.length < 3) bad.push({ i, got: v, want: ref[i] }); }); return bad; };
    const out = {};
    const weights = [0, 1, 0.5, 0.25, 0.46, 0.45, 0.07, 0.333, -1, 2, NaN, '0.3', null, undefined, Infinity, 0.9999999, 0.0000001];
    for (let i = 0; i < 300; i += 1) weights.push(Math.round(i * 0.37 * 100) / 100 % 1);
    for (const [a, b] of [['#112233', '#ffeedd'], ['rgba(10, 20, 30, 0.5)', 'rgb(255, 128, 0)'], ['red', 'hsl(200 50% 50%)'], ['#000', '#fff'], ['transparent', 'rgb(1, 1, 1)'], ['not a colour', '#abcdef']]) {
      out[`mix ${a} ${b}`] = same(kit.mixColorBatch(a, b, weights, true), weights.map((t) => kit.mixColor(a, b, t)));
    }
    const parsed = parseColors(texts, true);
    out.parse = same(parsed, texts.map((t) => parseColor(t)));
    const alphas = [1, 0.8, 0.09, 0.55, 0.14 * 0.37, 0.3 * 0.5, 0, 0.0005, 0.85, 2, -0.5, 1e-9];
    const colors = [...parsed.slice(0, 600), { r: 12.5, g: 254.5, b: 0.49999999999999994, a: 0.123456 }, { r: -3, g: 400, b: NaN, a: 1 }, { r: 1e12, g: 0, b: 0, a: 1 }];
    for (const alpha of alphas) out[`rgba ${alpha}`] = same(rgbaBatch(colors, alpha, true), colors.map((c) => rgba(c, alpha)));
    return out;
  }, texts);
  for (const [name, bad] of Object.entries(result)) expect(bad, name).toEqual([]);
});

test('without the kernel (the file is blocked) every batch answers like the single functions', async ({ page }) => {
  await page.route('**/wasm/color.wasm*', (route) => route.abort());
  await openTraces(page);
  const state = await page.evaluate(async () => {
    await window.ChDash.loader.loadGroup('wasm-color');
    const kernel = await window.ChDash.wasm.load('color');
    const b = window.ChDash.palette.batch;
    const fills = Array.from({ length: 60 }, (_, i) => `--qchart-${(i % 18) + 1}`);
    const got = b.readableTextBatch(fills);
    const want = fills.map((f) => window.ChDash.palette.readableText(f));
    const mixes = window.ChDash.graphKit.mixColorBatch('#000', '#fff', Array.from({ length: 60 }, (_, i) => i / 60));
    return { kernel, same: JSON.stringify(got) === JSON.stringify(want), mixes: mixes.length, failures: window.ChDash.wasm.stats.failures };
  });
  expect(state.kernel).toBe(null);
  expect(state.same).toBe(true);
  expect(state.mixes).toBe(60);
  expect(state.failures).toBe(1);
});

test('the trace graph and the flame view keep their colours with the kernel loaded', async ({ page }) => {
  // The pages call the batches themselves (heat fills, flame labels): a long list goes through the kernel and the same strings come back.
  await openTraces(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const state = await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const weights = Array.from({ length: 200 }, (_, i) => Math.round((i / 199) * 0.45 * 100) / 100);
    const a = kit.mixColorBatch(kit.color('nodeBg'), kit.theme.cssVar('--graph-heat'), weights, true);
    const b = weights.map((t) => kit.mixColor(kit.color('nodeBg'), kit.theme.cssVar('--graph-heat'), t));
    return { same: JSON.stringify(a) === JSON.stringify(b), distinct: new Set(a).size };
  });
  expect(state.same).toBe(true);
  expect(state.distinct).toBeGreaterThan(10);
});

test('performance budget: batch colour arithmetic on the kernel and in JavaScript', async ({ page }) => {
  test.setTimeout(120_000);
  await openTraces(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const rows = await page.evaluate(() => {
    const p = window.ChDash.palette;
    const b = p.batch;
    const kit = window.ChDash.graphKit;
    const { parseColor, parseColors, rgba, rgbaBatch } = window.ChDash.chartCore.colors;
    const median = (fn) => { const t = []; for (let i = 0; i < 15; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } return t.sort((x, y) => x - y)[7]; };
    const round = (n) => Math.round(n * 1000) / 1000;
    const out = [];
    for (const n of [16, 48, 100, 200, 500, 1000, 5000, 20000]) {
      const texts = Array.from({ length: n }, (_, i) => `rgba(${i % 256}, ${(i * 7) % 256}, ${(i * 13) % 256}, ${((i % 20) / 20).toFixed(2)})`);
      const names = Array.from({ length: n }, (_, i) => `service-${i}`);
      const ts = Array.from({ length: n }, (_, i) => i / n);
      const parsed = texts.map(parseColor);
      const normalizedTexts = texts.slice();
      out.push({
        n,
        normalizeJs: round(median(() => normalizedTexts.map((t) => b.normalize(t)))), normalizeWasm: round(median(() => b.normalizeBatch(normalizedTexts, true))),
        parseJs: round(median(() => texts.map(parseColor))), parseWasm: round(median(() => parseColors(texts, true))),
        rgbaJs: round(median(() => parsed.map((c) => rgba(c, 0.5)))), rgbaWasm: round(median(() => rgbaBatch(parsed, 0.5, true))),
        mixJs: round(median(() => ts.map((t) => kit.mixColor('#102030', '#f0e0d0', t)))), mixWasm: round(median(() => kit.mixColorBatch('#102030', '#f0e0d0', ts, true))),
        slotsJs: round(median(() => names.map((x) => p.serviceSlot(x, { assign: false })))), slotsWasm: round(median(() => b.hashSlotBatch(names, true))),
        stepsJs: round(median(() => ts.map((t) => p.sequential(t)))), stepsWasm: round(median(() => b.sequentialBatch(ts, true))),
      });
    }
    return out;
  });
  console.log('color timing (ms)', JSON.stringify(rows));
  test.info().annotations.push({ type: 'color-timing-ms', description: JSON.stringify(rows) });
  expect(rows.length).toBe(8);
});
