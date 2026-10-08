import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp } from '../helpers/app.js';

// The sort of a result column (the numeric one on WebAssembly: src/wasm/rowsort.c, docs/wasm.md): the keys of the column are read
// once and the kernel orders the rows. The order must equal the one of the comparator the page used before (every
// comparison normalised both values), for every kind of value, ties and direction; without the kernel the keyed
// JavaScript order answers.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const SHAPES = [
  { name: 'numbers and numeric strings with nulls', kind: 'mixed', rows: 20000, seed: 1 },
  { name: 'many ties (ten distinct values)', kind: 'ties', rows: 30000, seed: 2 },
  { name: 'integers as strings (UInt64 columns)', kind: 'ints', rows: 25000, seed: 3 },
  { name: 'padded text numbers, empty strings, infinities and NaN', kind: 'odd', rows: 20000, seed: 4 },
  { name: 'a huge integer forces the comparator path', kind: 'huge', rows: 20000, seed: 5 },
  { name: 'text in a numeric column forces the comparator path', kind: 'text', rows: 20000, seed: 6 },
  { name: 'row numbers out of order and repeated', kind: 'ranks', rows: 20000, seed: 7 },
  { name: 'below the kernel threshold', kind: 'mixed', rows: 800, seed: 8 },
  { name: 'one row and no row', kind: 'tiny', rows: 1, seed: 9 },
  { name: 'a large result', kind: 'mixed', rows: 200000, seed: 10 },
];

async function compare(page, shapes) {
  return page.evaluate(async (shapes) => {
    const ns = window.ChDash;
    await window.ChDash.loader.loadGroup('wasm-rowsort');
    await ns.wasm.load('rowsort');
    const t = ns.results.testing;
    const gen = {
      mixed: (rand) => { const roll = rand(); return roll < 0.1 ? null : roll < 0.5 ? Math.floor(rand() * 1000) - 300 : roll < 0.8 ? ((rand() - 0.5) * 1e4).toFixed(2) : String(Math.floor(rand() * 1e6)); },
      ties: (rand) => (rand() < 0.1 ? null : Math.floor(rand() * 10)),
      ints: (rand) => String(Math.floor(rand() * 9007199254740991)),
      odd: (rand) => [' 12 ', '', '  ', '1e3', '.5', '-.5', '+7', Infinity, -Infinity, NaN, '0', '-0', 0, -0, '00012', '1E-2'][Math.floor(rand() * 16)],
      huge: (rand) => (rand() < 0.001 ? '123456789012345678901234567890' : Math.floor(rand() * 100)),
      text: (rand) => (rand() < 0.001 ? 'n/a' : Math.floor(rand() * 100)),
      ranks: (rand) => Math.floor(rand() * 50),
      tiny: () => 5,
    };
    const out = [];
    for (const shape of shapes) {
      let seed = shape.seed >>> 0;
      const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const rows = [];
      for (let r = 0; r < shape.rows; r += 1) {
        const row = [gen[shape.kind](rand), rand()];
        row.__chdashRowIndex = shape.kind === 'ranks' ? (rand() < 0.1 ? 0 : Math.floor(rand() * 40)) : r + 1;
        rows.push(row);
      }
      for (const key of [0, -1]) {
        for (const dir of ['asc', 'desc']) {
          const reference = t.sortNumericRowsByComparator(rows.slice(), key, dir === 'desc');
          for (const wasm of [false, true]) {
            t.setWasm(wasm);
            const got = t.sortNumericRows(rows, key, dir);
            let at = -1;
            if (got.length !== reference.length) at = -2;
            else for (let i = 0; i < got.length; i += 1) if (got[i] !== reference[i]) { at = i; break; }
            if (at !== -1) out.push({ shape: shape.name, key, dir, wasm, at });
          }
        }
      }
    }
    t.setWasm(true);
    return { diffs: out, kernel: !!ns.wasm.get('rowsort') };
  }, shapes);
}

test('the kernel orders a numeric column like the comparator, ties and both directions included', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const result = await compare(page, SHAPES);
  expect(result.kernel).toBe(true);
  expect(result.diffs).toEqual([]);
});

const TEXT_SHAPES = [
  { name: 'ASCII words in mixed case', kind: 'words', rows: 20000, seed: 21 },
  { name: 'Unicode letters, surrogate pairs and lone surrogates', kind: 'unicode', rows: 20000, seed: 22 },
  { name: 'texts that differ by case only', kind: 'case', rows: 20000, seed: 23 },
  { name: 'empty strings, nulls and numbers', kind: 'blank', rows: 20000, seed: 24 },
  { name: 'a prefix of another text', kind: 'prefix', rows: 20000, seed: 25 },
  { name: 'below the kernel threshold', kind: 'words', rows: 700, seed: 26 },
  { name: 'a large result', kind: 'words', rows: 200000, seed: 27 },
];

async function compareText(page, shapes) {
  return page.evaluate(async (shapes) => {
    const ns = window.ChDash;
    await ns.loader.loadGroup('wasm-rowsort');
    await ns.wasm.load('rowsort');
    const t = ns.results.testing;
    const gen = {
      words: (rand) => ['Alpha', 'beta', 'GAMMA', 'delta', 'Epsilon', 'zeta'][Math.floor(rand() * 6)] + '-' + Math.floor(rand() * 5000),
      unicode: (rand) => ['\u00e9t\u00e9', '\u00c9T\u00c9', '\u0130stanbul', 'stra\u00dfe', 'STRASSE', '\ud83d\ude00x', 'x\ud800', '\udc00y', '\u4e2d\u6587', 'ab', 'AB', '\u212a'][Math.floor(rand() * 12)] + (rand() < 0.5 ? '' : String(Math.floor(rand() * 20))),
      case: (rand) => { const w = 'sOrTeD'; let s = ''; for (const c of w) s += rand() < 0.5 ? c.toLowerCase() : c.toUpperCase(); return s; },
      blank: (rand) => [null, '', undefined, 0, 12, '12', ' ', 'a'][Math.floor(rand() * 8)],
      prefix: (rand) => 'abcdef'.slice(0, Math.floor(rand() * 7)) + (rand() < 0.2 ? 'Z' : ''),
    };
    const textOf = (row, key) => String((key === -1 ? row.__chdashRowIndex : row[key]) ?? '');
    const out = [];
    for (const shape of shapes) {
      let seed = shape.seed >>> 0;
      const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const rows = [];
      for (let r = 0; r < shape.rows; r += 1) {
        const row = [gen[shape.kind](rand), rand()];
        row.__chdashRowIndex = rand() < 0.05 ? 0 : (rand() < 0.5 ? r + 1 : Math.floor(rand() * 100));
        rows.push(row);
      }
      for (const key of [0, -1]) {
        for (const dir of ['asc', 'desc']) {
          const reference = t.sortTextRowsByComparator(rows.slice(), key, dir === 'desc', textOf);
          for (const wasm of [false, true]) {
            t.setWasm(wasm);
            const got = t.sortTextRows(rows, key, dir, textOf);
            let at = -1;
            if (got.length !== reference.length) at = -2;
            else for (let i = 0; i < got.length; i += 1) if (got[i] !== reference[i]) { at = i; break; }
            if (at !== -1) out.push({ shape: shape.name, key, dir, wasm, at });
          }
        }
      }
    }
    t.setWasm(true);
    return { diffs: out, kernel: !!ns.wasm.get('rowsort') };
  }, shapes);
}

test('a text column is ordered like the comparator, case, Unicode and ties included', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  const result = await compareText(page, TEXT_SHAPES);
  expect(result.kernel).toBe(true);
  expect(result.diffs).toEqual([]);
});

test('without the kernel (the file is blocked) a numeric column is still sorted by JavaScript', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/wasm/rowsort.wasm*', (route) => route.abort());
  await openApp(page);
  const result = await compare(page, SHAPES.slice(0, 3));
  expect(result.kernel).toBe(false);
  expect(result.diffs).toEqual([]);
});

test('performance budget: sorting 200,000 rows by a numeric column', async ({ page }) => {
  test.setTimeout(180_000);
  await openApp(page);
  await page.evaluate(async () => { await window.ChDash.loader.loadGroup('wasm-rowsort'); await window.ChDash.wasm.load('rowsort'); });
  const result = await page.evaluate(() => {
    const t = window.ChDash.results.testing;
    let seed = 5;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const rows = [];
    for (let r = 0; r < 200000; r += 1) { const row = [rand() < 0.05 ? null : String(Math.floor(rand() * 1e9)), 'x', ['Alpha', 'beta', 'GAMMA', 'delta'][Math.floor(rand() * 4)] + '-' + Math.floor(rand() * 100000)]; row.__chdashRowIndex = r + 1; rows.push(row); }
    const time = (fn) => { const v = []; for (let i = 0; i < 3; i += 1) { const a = performance.now(); fn(); v.push(performance.now() - a); } return Math.round(v.sort((p, q) => p - q)[1] * 10) / 10; };
    return {
      comparator: time(() => t.sortNumericRowsByComparator(rows.slice(), 0, true)),
      keyedJs: time(() => { t.setWasm(false); t.sortNumericRows(rows, 0, 'desc'); }),
      kernel: time(() => { t.setWasm(true); t.sortNumericRows(rows, 0, 'desc'); }),
      keys: time(() => t.numericSortKeys(rows, 0)),
      textComparator: time(() => t.sortTextRowsByComparator(rows.slice(), 1, true, (row) => String(row[2]))),
      textKeyedJs: time(() => { t.setWasm(false); t.sortTextRows(rows, 2, 'desc', (row) => String(row[2])); }),
    };
  });
  test.info().annotations.push({ type: 'rowsort-ms', description: JSON.stringify(result) });
  console.log('rowsort 200k rows (ms)', JSON.stringify(result));
  expect(result.kernel).toBeLessThan(result.comparator);
});
