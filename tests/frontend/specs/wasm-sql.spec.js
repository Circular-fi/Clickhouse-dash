import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp } from '../helpers/app.js';
import { sqlCorpus, fuzzSql } from '../helpers/wasm.js';
import { metaSpec, corpusMeta, fuzzScripts } from '../helpers/wasm-sql.js';

// The editor diagnostics on WebAssembly (src/wasm/sqlscan.c, docs/wasm.md): the unknown table, column and function
// marks of app_autocomplete.js are the same whether the JavaScript reference or the kernel scans the script.

// WASM_FUZZ_SCALE=20 runs twenty times more seeded scripts.
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
  await page.evaluate(() => window.ChDash.loader.loadGroup('wasm-sqlscan'));
  return page.evaluate(async () => {
    const kernel = await window.ChDash.autocomplete.wasmReady();
    return { loaded: !!kernel, fallbacks: window.ChDash.wasm.stats.streamingFallbacks };
  });
}

// Builds the host metadata of a spec (the shapes of app_meta.js) in the page, with the column lists the editor reads
// through ns.meta.getTableColumns; returns it, and restores the page's own functions with restore().
const BUILD_META = (spec, mode) => {
  const ns = window.ChDash;
  const lower = (list) => new Set(list.map((name) => name.toLowerCase()));
  const tablesByDatabase = new Map();
  const items = spec.tables.map((t) => ({ name: t.name, database: t.database, table: '', type: '', detail: 'MergeTree', parent: '' }));
  for (const t of items) {
    const key = t.database.toLowerCase();
    if (!tablesByDatabase.has(key)) tablesByDatabase.set(key, []);
    tablesByDatabase.get(key).push(t);
  }
  const columns = new Map(spec.tables.map((t) => [`${t.database}.${t.name}`, t.columns.map((name) => ({ name, insertName: name, type: name.includes('ts') ? 'DateTime' : 'String', database: t.database, table: t.name }))]));
  const meta = {
    autocomplete: { tablesByDatabase },
    keywords: { items: spec.keywords, set: lower(spec.keywords) },
    databases: { items: [...new Set(spec.tables.map((t) => t.database))].map((name) => ({ name })) },
    table_functions: { items: spec.tableFunctions.map((name) => ({ name, columns: name === 'numbers' ? [{ name: 'number', type: 'UInt64', insertName: 'number' }] : [] })) },
    data_types: { items: spec.dataTypes.map((name) => ({ name })) },
  };
  if (mode !== 'no-tables') meta.tables = { items };
  if (mode !== 'no-functions') {
    const fnItems = spec.functions.map((name) => ({ name, is_aggregate: false, case_insensitive: name === 'now' }));
    meta.functions = { items: fnItems, ci: new Set(), cs: new Set(), meta: new Map() };
    if (mode === 'with-set') meta.functions.set = new Set(['extrafn', 'now', 'MixedCase']);
  }
  const saved = { get: ns.meta.getTableColumns, ensure: ns.meta.ensureTableColumns };
  ns.meta.getTableColumns = (database, table) => columns.get(`${database}.${table}`) || (mode === 'unknown-columns' ? null : []);
  ns.meta.ensureTableColumns = () => {};
  window.__metaRestore = () => { ns.meta.getTableColumns = saved.get; ns.meta.ensureTableColumns = saved.ensure; };
  window.__meta = meta;
  return true;
};

// Runs both implementations on `texts` with the warning switches of `switches`; returns the first differences.
async function compare(page, texts, spec, mode, switches) {
  return page.evaluate(({ texts, spec, mode, switches, build }) => {
    // eslint-disable-next-line no-new-func
    new Function('spec', 'mode', `(${build})(spec, mode)`)(spec, mode);
    const ac = window.ChDash.autocomplete;
    ac.setReferenceDiagnosticsEnabled(true);
    ac.setTableWarningsEnabled(switches[0]);
    ac.setColumnWarningsEnabled(switches[1]);
    ac.setFunctionWarningsEnabled(switches[2]);
    const meta = window.__meta;
    const bad = [];
    let skipped = 0;
    let marks = 0;
    for (const text of texts) {
      const wasm = ac.diagnoseWasm(text, meta);
      if (wasm === null) { skipped += 1; continue; }
      const js = ac.diagnoseJs(text, meta);
      marks += js.length;
      if (JSON.stringify(js) !== JSON.stringify(wasm)) {
        if (bad.length < 3) {
          const i = js.findIndex((t, k) => JSON.stringify(t) !== JSON.stringify(wasm[k]));
          bad.push({ text: text.slice(0, 300), at: i, js: js[i], wasm: wasm[i], jsCount: js.length, wasmCount: wasm.length });
        }
      }
    }
    window.__metaRestore();
    return { bad, skipped, total: texts.length, marks };
  }, { texts, spec, mode, switches, build: BUILD_META.toString() });
}

test('the kernel loads as application/wasm and answers like the reference on a small script', async ({ page }) => {
  await openApp(page);
  const responses = [];
  page.on('response', (response) => { if (response.url().includes('/wasm/sqlscan.wasm')) responses.push(response); });
  const state = await loadKernel(page);
  expect(state.loaded).toBe(true);
  expect(responses[0].headers()['content-type']).toBe('application/wasm');
  expect(state.fallbacks).toBe(0);
  const result = await compare(page, ['SELECT id, nope FROM shop.orders WHERE zz = 1;\nSELECT 1 FROM missing.table_x; SELECT unknownfn(1)'], metaSpec('x'), 'full', [true, true, true]);
  expect(result.skipped).toBe(0);
  expect(result.bad).toEqual([]);
  expect(result.marks).toBeGreaterThanOrEqual(3);
});

test('the kernel marks the SQL files of the repository like the reference, whatever the switches', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const corpus = sqlCorpus().map((file) => file.sql);
  expect(corpus.length).toBeGreaterThan(50);
  // The reference needs seconds for a long script: the long text is a slice of the files, once per switch set.
  const texts = [...corpus, corpus.slice(0, 25).join(';\n')];
  for (const [mode, spec] of [['full', corpusMeta(corpus)], ['with-set', metaSpec('x')], ['no-tables', corpusMeta(corpus)], ['no-functions', corpusMeta(corpus)]]) {
    for (const switches of [[true, true, true], [true, false, false], [false, true, false], [false, false, true]]) {
      const result = await compare(page, texts, spec, mode, switches);
      expect(result.skipped, `${mode} ${switches}`).toBe(0);
      expect(result.bad, `${mode} ${switches}`).toEqual([]);
    }
  }
});

test('the kernel marks like the reference with the real metadata of the host (5,000 functions, the fixture tables)', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  await page.waitForFunction(() => { const ns = window.ChDash; const h = ns.state.meta?.hosts?.[String(ns.state.selectedHostId)]; return h && h.functions && h.tables && h.keywords && h.table_functions && h.data_types; }, null, { timeout: 30_000 });
  const corpus = sqlCorpus().map((file) => file.sql);
  const texts = [...corpus, corpus.slice(0, 20).join(';\n'), ...fuzzScripts(41, 150 * SCALE, 5), 'SELECT number, nope FROM numbers(3);\nSELECT * FROM system.tables WHERE nope = 1;\nSELECT unknownfn(1), count(), toDate(now()) FROM system.nothing'];
  const result = await page.evaluate((texts) => {
    const ns = window.ChDash;
    const ac = ns.autocomplete;
    const meta = ns.state.meta.hosts[String(ns.state.selectedHostId)];
    ac.setReferenceDiagnosticsEnabled(true);
    ac.setTableWarningsEnabled(true); ac.setColumnWarningsEnabled(true); ac.setFunctionWarningsEnabled(true);
    const bad = [];
    let marks = 0;
    for (const text of texts) {
      const wasm = ac.diagnoseWasm(text, meta);
      const js = ac.diagnoseJs(text, meta);
      marks += js.length;
      if (wasm === null || JSON.stringify(js) !== JSON.stringify(wasm)) {
        if (bad.length < 3) bad.push({ text: text.slice(0, 300), js: js.slice(0, 3), wasm: wasm && wasm.slice(0, 3) });
      }
    }
    return { bad, marks, functions: meta.functions.items.length };
  }, texts);
  expect(result.functions).toBeGreaterThan(1000);
  expect(result.bad).toEqual([]);
  expect(result.marks).toBeGreaterThan(100);
});

test('the kernel marks seeded scripts (CTEs, aliases, lambdas, array joins, quotes, comments, broken text) like the reference', async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  let marks = 0;
  for (const [mode, seed] of [['full', 1], ['with-set', 2], ['unknown-columns', 3], ['no-tables', 4], ['no-functions', 5]]) {
    for (const [offset, count, statements] of [[0, 400 * SCALE, 3], [100, 80 * SCALE, 14]]) {
      const result = await compare(page, fuzzScripts(seed * 1000 + offset, count, statements), metaSpec('x'), mode, [true, true, true]);
      expect(result.skipped, mode).toBe(0);
      expect(result.bad, mode).toEqual([]);
      marks += result.marks;
    }
  }
  expect(marks).toBeGreaterThan(500);
});

test('the kernel marks token soup (the generator of the highlighter spec, unbalanced quotes and parentheses) like the reference', async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  for (const [seed, count, parts] of [[11, 500 * SCALE, 30], [12, 120 * SCALE, 160]]) {
    const result = await compare(page, fuzzSql(seed, count, parts), metaSpec('x'), 'full', [true, true, true]);
    expect(result.skipped).toBe(0);
    expect(result.bad).toEqual([]);
  }
});

test('the kernel scans a script of a million characters without a limit, and the answer is capped like the reference', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const big = fuzzScripts(5, 3000, 3, 0).join(';\n');
  expect(big.length).toBeGreaterThan(400_000);
  const state = await page.evaluate(({ spec, build, big }) => {
    // eslint-disable-next-line no-new-func
    new Function('spec', 'mode', `(${build})(spec, mode)`)(spec, 'full');
    const ac = window.ChDash.autocomplete;
    ac.setReferenceDiagnosticsEnabled(true);
    ac.setTableWarningsEnabled(true); ac.setColumnWarningsEnabled(true); ac.setFunctionWarningsEnabled(true);
    const a = performance.now();
    const wasm = ac.diagnoseWasm(big, window.__meta);
    const ms = performance.now() - a;
    window.__metaRestore();
    return { count: wasm.length, ms, sorted: wasm.every((issue, i) => i === 0 || wasm[i - 1].start <= issue.start) };
  }, { spec: metaSpec('x'), build: BUILD_META.toString(), big });
  expect(state.count).toBe(200);
  expect(state.sorted).toBe(true);
});

test('the kernel finds the statement around any cursor like the reference (quotes, comments, parentheses, Unicode)', async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const texts = [...fuzzSql(21, 300 * SCALE, 40), ...fuzzScripts(22, 120 * SCALE, 6), ...sqlCorpus().slice(0, 40).map((file) => file.sql), '', ';', ');(;', "';", '-- ;\n;'];
  const result = await page.evaluate((texts) => {
    const ac = window.ChDash.autocomplete;
    const bad = [];
    let checked = 0;
    let seed = 7;
    const rand = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (const text of texts) {
      const positions = text.length < 60 ? Array.from({ length: text.length + 1 }, (_, i) => i) : [0, text.length, ...Array.from({ length: 24 }, () => rand(text.length + 1)), -3, text.length + 9];
      for (const pos of positions) {
        const js = ac.statementAtJs(text, pos);
        const wasm = ac.statementAtWasm(text, pos);
        checked += 1;
        if (js !== wasm && bad.length < 3) bad.push({ text: text.slice(0, 200), pos, js, wasm });
      }
      const before = ac.statementBeforeJs(text);
      const beforeWasm = ac.statementBeforeWasm(text);
      if (before !== beforeWasm && bad.length < 3) bad.push({ text: text.slice(0, 200), before, beforeWasm });
    }
    return { bad, checked };
  }, texts);
  expect(result.bad).toEqual([]);
  expect(result.checked).toBeGreaterThan(5000);
});

test('the kernel cuts a script into statements like the loops of app_sql.js and app_run.js', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  const texts = [...fuzzSql(31, 500 * SCALE, 60), ...fuzzScripts(32, 150 * SCALE, 8), ...sqlCorpus().map((file) => file.sql), sqlCorpus().map((file) => file.sql).join(';\n'),
    '', ';', ';;', ' ; ', "';", "';'';", '\\', "'\\", '-- ;', '/* ; */;x', '#;\n;y', '`;`;z', '"a;\\";b'];
  const result = await page.evaluate((texts) => {
    const { sql, run } = window.ChDash;
    const bad = [];
    let kernelAnswers = 0;
    for (const text of texts) {
      const js = sql.splitSqlStatementsJs(text);
      const wasm = sql.splitSqlStatementsWasm(text, 0);
      const jsRanges = run.splitSqlStatementsWithRangesJs(text);
      const wasmRanges = run.splitSqlStatementsWithRangesWasm(text, 0);
      if (wasm === null || wasmRanges === null) { bad.push({ text: text.slice(0, 100), why: 'no answer' }); continue; }
      kernelAnswers += 1;
      if (JSON.stringify(js) !== JSON.stringify(wasm) && bad.length < 3) bad.push({ text: text.slice(0, 200), js, wasm });
      if (JSON.stringify(jsRanges) !== JSON.stringify(wasmRanges) && bad.length < 3) bad.push({ text: text.slice(0, 200), jsRanges, wasmRanges });
    }
    return { bad, kernelAnswers, minChars: sql.splitWasmMinChars };
  }, texts);
  expect(result.bad).toEqual([]);
  expect(result.kernelAnswers).toBe(texts.length);
  expect(result.minChars).toBeGreaterThan(1000);
});

test('without the kernel (the file is blocked) the editor marks come from JavaScript, and the page does not fail', async ({ page }) => {
  await page.route('**/wasm/sqlscan.wasm*', (route) => route.abort());
  await openApp(page);
  const state = await page.evaluate(async ({ spec, build }) => {
    await window.ChDash.loader.loadGroup('wasm-sqlscan');
    const kernel = await window.ChDash.autocomplete.wasmReady();
    // eslint-disable-next-line no-new-func
    new Function('spec', 'mode', `(${build})(spec, mode)`)(spec, 'full');
    const ac = window.ChDash.autocomplete;
    ac.setReferenceDiagnosticsEnabled(true);
    ac.setTableWarningsEnabled(true); ac.setColumnWarningsEnabled(true); ac.setFunctionWarningsEnabled(true);
    const text = 'SELECT id, nope FROM shop.orders;\nSELECT nofn(1) FROM missing.tbl';
    const marks = ac.diagnose(text, window.__meta);
    const same = JSON.stringify(marks) === JSON.stringify(ac.diagnoseJs(text, window.__meta));
    window.__metaRestore();
    return { kernel, marks: marks.length, same, wasm: ac.diagnoseWasm(text, window.__meta), failures: window.ChDash.wasm.stats.failures };
  }, { spec: metaSpec('x'), build: BUILD_META.toString() });
  expect(state.kernel).toBe(null);
  expect(state.marks).toBeGreaterThanOrEqual(3);
  expect(state.same).toBe(true);
  expect(state.wasm).toBe(null);
  expect(state.failures).toBe(1);
});

test('performance budget: the kernel marks a long script faster than the JavaScript reference', async ({ page }) => {
  test.setTimeout(300_000);
  await openApp(page);
  expect((await loadKernel(page)).loaded).toBe(true);
  // Clean scripts: balanced quotes and parentheses, as a person writes them (a stray quote makes one huge statement).
  const scripts = fuzzScripts(9, 4000, 2, 0, { clean: true }).join(';\n');
  const rows = await page.evaluate(({ spec, build, scripts }) => {
    // eslint-disable-next-line no-new-func
    new Function('spec', 'mode', `(${build})(spec, mode)`)(spec, 'full');
    const ac = window.ChDash.autocomplete;
    ac.setReferenceDiagnosticsEnabled(true);
    ac.setTableWarningsEnabled(true); ac.setColumnWarningsEnabled(true); ac.setFunctionWarningsEnabled(true);
    const meta = window.__meta;
    const median = (fn, runs) => { const t = []; for (let i = 0; i < runs; i += 1) { const a = performance.now(); fn(); t.push(performance.now() - a); } return t.sort((x, y) => x - y)[Math.floor(runs / 2)]; };
    const round = (n) => Math.round(n * 100) / 100;
    const out = [];
    for (const size of [120, 500, 2000, 8000, 16000, 30000, 100000, 400000]) {
      const text = scripts.slice(0, size);
      ac.diagnoseWasm(text, meta);
      const runs = size > 30000 ? 1 : size > 8000 ? 3 : 9;
      const cursor = text.length - 20;
      out.push({
        size,
        // the reference needs minutes for 400,000 characters: only the kernel runs there
        js: size > 100000 ? null : round(median(() => ac.diagnoseJs(text, meta), runs)),
        wasm: round(median(() => ac.diagnoseWasm(text, meta), runs)),
        // the statement around the cursor: a new text each time, as in typing
        statementJs: round(median(() => ac.statementAtJs(text + ' '.repeat(Math.random() * 50 | 0), cursor), 15)),
        statementWasm: round(median(() => ac.statementAtWasm(text + ' '.repeat(Math.random() * 50 | 0), cursor), 15)),
        splitJs: round(median(() => window.ChDash.sql.splitSqlStatementsJs(text), 9)),
        splitWasm: round(median(() => window.ChDash.sql.splitSqlStatementsWasm(text, 0), 9)),
      });
    }
    window.__metaRestore();
    return out;
  }, { spec: metaSpec('x'), build: BUILD_META.toString(), scripts });
  test.info().annotations.push({ type: 'diagnostics-timing-ms', description: JSON.stringify(rows) });
  console.log('diagnostics timing (ms)', JSON.stringify(rows));
  const large = rows.find((row) => row.size === 30000);
  expect(large.wasm).toBeLessThan(large.js);
  expect(rows.find((row) => row.size === 100000).statementWasm).toBeLessThan(rows.find((row) => row.size === 100000).statementJs);
});
