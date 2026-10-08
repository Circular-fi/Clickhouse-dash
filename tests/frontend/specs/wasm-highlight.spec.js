import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp } from '../helpers/app.js';
import { sqlCorpus, fuzzSql } from '../helpers/wasm.js';

// The SQL syntax colouring on WebAssembly (src/wasm/highlight.c, docs/wasm.md): the kernel gives the tokens of the
// JavaScript lexer (app_highlight.js, lexAllJs) byte for byte, on the repository's SQL files and on seeded
// awkward input; without the kernel the page keeps its JavaScript path.

// WASM_FUZZ_SCALE=20 runs twenty times more seeded texts (a deeper check before a release).
const SCALE = Math.max(1, Number(process.env.WASM_FUZZ_SCALE) || 1);

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

async function loadKernel(page) {
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-highlight'));
  return page.evaluate(async () => {
    const kernel = await window.ChDash.highlight.ready();
    return { loaded: !!kernel, fallbacks: window.ChDash.wasm.stats.streamingFallbacks };
  });
}

// The host's keyword and function sets the highlighter reads, replaced for the call.
const META_VARIANTS = ['none', 'keywords', 'functions', 'both'];
const installMeta = (variant) => {
  const ns = window.ChDash;
  const id = String(ns.state.selectedHostId || 'local');
  ns.state.selectedHostId = id;
  ns.state.meta = ns.state.meta || { hosts: {} };
  ns.state.meta.hosts = ns.state.meta.hosts || {};
  const host = (ns.state.meta.hosts[id] = ns.state.meta.hosts[id] || {});
  delete host.keywords;
  delete host.functions;
  if (variant === 'keywords' || variant === 'both') host.keywords = { set: new Set(['limit', 'format', 'settings', 'prewhere', 'final', 'array', 'x', 'date', 'state', 'kéy']) };
  if (variant === 'functions' || variant === 'both') {
    const items = [
      { name: 'count', is_aggregate: true, case_insensitive: true },
      { name: 'sum', is_aggregate: true, case_insensitive: true },
      { name: 'uniq', is_aggregate: true, case_insensitive: false },
      { name: 'myCsFn', is_aggregate: false, case_insensitive: false },
      { name: 'toString', is_aggregate: false, case_insensitive: true },
      { name: 'now', is_aggregate: false, case_insensitive: true },
      { name: 'toDate', is_aggregate: false, case_insensitive: false },
      { name: 'if', is_aggregate: false, case_insensitive: true },
      { name: 'café', is_aggregate: false, case_insensitive: true },
      { name: 'my col', is_aggregate: false, case_insensitive: false },
      { name: 'x', is_aggregate: false, case_insensitive: false },
      { name: 'Date', is_aggregate: false, case_insensitive: false },
    ];
    const ci = new Set(); const cs = new Set(); const meta = new Map();
    for (const it of items) { (it.case_insensitive ? ci : cs).add(it.case_insensitive ? it.name.toLowerCase() : it.name); meta.set(it.name, it); }
    host.functions = { ci, cs, meta };
  }
};

// Compares both lexers on `texts`; returns the first differences (at most 3).
async function compare(page, texts, variant) {
  return page.evaluate(({ texts, variant, installSource }) => {
    // eslint-disable-next-line no-new-func
    new Function('variant', `(${installSource})(variant)`)(variant);
    const { lexAllJs, lexAllWasm } = window.ChDash.highlight;
    const bad = [];
    let skipped = 0;
    for (const text of texts) {
      const wasm = lexAllWasm(text);
      if (wasm === null) { skipped += 1; continue; }
      const js = lexAllJs(text);
      if (JSON.stringify(js) !== JSON.stringify(wasm)) {
        if (bad.length < 3) {
          const i = js.findIndex((t, k) => JSON.stringify(t) !== JSON.stringify(wasm[k]));
          bad.push({ text: text.slice(0, 200), at: i, js: js[i], wasm: wasm[i], jsCount: js.length, wasmCount: wasm.length });
        }
      }
    }
    return { bad, skipped, total: texts.length };
  }, { texts, variant, installSource: installMeta.toString() });
}

test('the kernel loads as application/wasm and is instantiated by streaming', async ({ page }) => {
  await openApp(page);
  const responses = [];
  page.on('response', (response) => { if (response.url().includes('/wasm/highlight.wasm')) responses.push(response); });
  const state = await loadKernel(page);
  expect(state.loaded).toBe(true);
  expect(responses.length).toBeGreaterThan(0);
  expect(responses[0].headers()['content-type']).toBe('application/wasm');
  expect(state.fallbacks).toBe(0);
});

test('the kernel lexes the SQL files of the repository like the JavaScript lexer, with and without host metadata', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const corpus = sqlCorpus().map((file) => file.sql);
  // The files alone, and their concatenation (long text: statements, comments, strings).
  const texts = [...corpus, corpus.join('\n;\n'), corpus.slice(0, 40).join('\n'), corpus.join('\n').repeat(3)];
  for (const variant of META_VARIANTS) {
    const result = await compare(page, texts, variant);
    expect(result.skipped, `variant ${variant}`).toBe(0);
    expect(result.bad, `variant ${variant}`).toEqual([]);
  }
});

test('the kernel lexes seeded awkward SQL like the JavaScript lexer (quotes, comments, quoted names, Unicode spaces, surrogates)', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  for (const variant of META_VARIANTS) {
    for (const [seed, count, parts] of [[1, 1500, 24], [2, 600, 90], [3, 60, 700]]) {
      const result = await compare(page, fuzzSql(seed * 31 + META_VARIANTS.indexOf(variant), count * SCALE, parts), variant);
      // A text the kernel hands back to the reference (a quoted name with a non-ASCII letter before "(", which a stray
      // backtick of the generator makes likely in the longest texts) is not compared.
      if (seed < 3) expect(result.skipped, `variant ${variant}, seed ${seed}`).toBeLessThan(result.total * 0.3);
      expect(result.bad, `variant ${variant}, seed ${seed}`).toEqual([]);
    }
  }
});

test('toHtml and the editor overlay give the same HTML on both paths, and short text stays on JavaScript', async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const texts = fuzzSql(77, 40, 400).filter((text) => text.length > 1500);
  expect(texts.length).toBeGreaterThan(5);
  const result = await page.evaluate((texts) => {
    const { toHtml, lexAllJs, wasmMinChars } = window.ChDash.highlight;
    const out = { same: 0, different: [], minChars: wasmMinChars };
    for (const text of texts) {
      const reference = lexAllJs(text).map((t) => t.html).join('');
      if (toHtml(text) === reference) out.same += 1; else out.different.push(text.slice(0, 80));
    }
    out.short = window.ChDash.highlight.lexAllWasm('select 1') !== null;
    return out;
  }, texts);
  expect(result.different).toEqual([]);
  expect(result.same).toBe(texts.length);
  expect(result.minChars).toBeGreaterThan(200);
});

test('without the kernel (the file is blocked) long SQL is still coloured by JavaScript', async ({ page }) => {
  await page.route('**/wasm/highlight.wasm*', (route) => route.abort());
  await openApp(page);
  const text = 'SELECT count(), now() FROM t WHERE a = 1 GROUP BY b -- note\n'.repeat(60);
  const state = await page.evaluate(async (text) => {
    await window.ChDash.loader.loadGroup('wasm-highlight');
    const kernel = await window.ChDash.highlight.ready();
    const html = window.ChDash.highlight.toHtml(text);
    const reference = window.ChDash.highlight.lexAllJs(text).map((t) => t.html).join('');
    return { kernel, same: html === reference, hasKeyword: html.includes('tok-kw'), failures: window.ChDash.wasm.stats.failures };
  }, text);
  expect(state.kernel).toBe(null);
  expect(state.same).toBe(true);
  expect(state.hasKeyword).toBe(true);
  expect(state.failures).toBe(1);
});

test('a refused streaming response (wrong content type) still instantiates from bytes', async ({ page }) => {
  await page.route('**/wasm/highlight.wasm*', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'application/octet-stream' } });
  });
  await openApp(page);
  const state = await loadKernel(page);
  expect(state.loaded).toBe(true);
  expect(state.fallbacks).toBe(1);
});

test('performance budget: the kernel colours a long text faster than the JavaScript lexer', async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const corpus = sqlCorpus().map((file) => file.sql);
  const base = corpus.length ? corpus.join('\n;\n') : fuzzSql(5, 400, 60).join('\n;\n');
  const rows = await page.evaluate(({ base, installSource }) => {
    // eslint-disable-next-line no-new-func
    new Function('variant', `(${installSource})(variant)`)('both');
    const { lexAllJs, lexAllWasm, toHtml } = window.ChDash.highlight;
    const kernel = window.ChDash.wasm.get('highlight');
    const median = (fn) => { const t = []; for (let i = 0; i < 9; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } return t.sort((x, y) => x - y)[4]; };
    const round = (n) => Math.round(n * 100) / 100;
    const out = [];
    for (const size of [300, 1500, 6000, 25000, 100000, 400000, 1500000]) {
      let text = '';
      while (text.length < size) text += base.slice(0, size - text.length) + '\n';
      text = text.slice(0, size);
      lexAllWasm(text);
      out.push({
        size,
        tokensJs: round(median(() => lexAllJs(text))),
        tokensWasm: round(median(() => lexAllWasm(text))),
        htmlJs: round(median(() => lexAllJs(text).map((t) => t.html).join(''))),
        htmlWasm: round(median(() => toHtml(text))),
        kernelOnly: round(median(() => window.ChDash.wasm.ops.highlight.run(kernel, { text }))),
      });
    }
    return out;
  }, { base, installSource: installMeta.toString() });
  test.info().annotations.push({ type: 'highlight-timing-ms', description: JSON.stringify(rows) });
  console.log('highlight timing (ms)', JSON.stringify(rows));
  const large = rows.find((row) => row.size === 400000);
  expect(large.htmlWasm).toBeLessThan(large.htmlJs);
});
