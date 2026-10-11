import fs from 'node:fs';
import path from 'node:path';

// Shared pieces of the WebAssembly equivalence specs (docs/wasm.md): the SQL corpus of the repository, a seeded
// generator of awkward SQL, and a seeded random source. A spec runs the JavaScript reference and the kernel on the
// same inputs and compares the answers.

// The SQL files of the repository: the formatter corpus (tests/api/format/input) and the fixtures, when the test
// image has them (WASM_SQL_DIRS, colon separated, replaces the list; an empty WASM_SQL_DIRS asks for no corpus). A
// corpus that is missing or small is an error, not a quieter run: the comparisons would pass on the generated texts
// alone and say nothing of the real SQL of the repository.
export const MIN_CORPUS_FILES = 50;

export function sqlCorpus() {
  const explicit = process.env.WASM_SQL_DIRS;
  const dirs = (explicit ?? '/tests/api/format/input:/tests/clickhouse-init:/work/sql').split(':').filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort(); } catch (error) { continue; }
    for (const name of names) out.push({ name: path.join(path.basename(dir), name), sql: fs.readFileSync(path.join(dir, name), 'utf8') });
  }
  if (explicit !== '' && out.length < MIN_CORPUS_FILES) {
    throw new Error(`the SQL corpus has ${out.length} files (at least ${MIN_CORPUS_FILES} are needed) in ${dirs.join(', ')}: mount tests/api/format/input or set WASM_SQL_DIRS`);
  }
  return out;
}

// Loads a kernel group in the page and waits for its kernel: `ready` is the expression that answers with the kernel
// (the module's own ready()). Answers { loaded, fallbacks } (streaming compile fallbacks of the loader).
export async function loadKernel(page, group, ready) {
  await page.evaluate((name) => window.ChDash.loader.loadGroup(name), group);
  return page.evaluate(`(async () => {
    const kernel = await (${ready});
    return { loaded: !!kernel, fallbacks: window.ChDash.wasm.stats.streamingFallbacks };
  })()`);
}

// A small deterministic generator (LCG): the same numbers on every run and machine.
export function rng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick(list) { return list[Math.floor(next() * list.length)]; },
  };
}

const WORDS = ['select', 'SELECT', 'From', 'where', 'WITH', 'as', 'AND', 'or', 'not', 'in', 'is', 'NULL', 'null', 'Null', 'distinct',
  'limit', 'settings', 'format', 'join', 'on', 'having', 'union', 'all', 'ALL', 'index', 'type', 'engine', 'create', 'table', 'x', 'y_1',
  '_z', 'col', 'userId', 'a1', 'T', 'count', 'sum', 'now', 'toDate', 'uniqState', 'sumState', 'State', 'myCsFn', 'MYCSFN', 'toString',
  'date', 'Date', 'DateTime64', 'UInt64', 'Nullable', 'LowCardinality', 'Array', 'String', 'Float64', 'IntervalDay', 'Enum8', 'JSON',
  'kéy', 'café', 'xK', '中文', 'state'];
const PAIRS = ['GROUP BY', 'group by', 'Group   By', 'GROUP\nBY', 'GROUP\t\tBY', 'ORDER BY', 'order  by', 'UNION ALL', 'union\nall', 'LEFT JOIN', 'left\njoin',
  'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ARRAY JOIN', 'array join', 'LEFT ARRAY JOIN', 'left  array  join', 'GROUP BY',
  'GROUP BY', 'ORDER﻿BY', 'GROUP　BY', 'LEFT ARRAY JOIN', 'GROUPBY', 'GROUP BYX', 'XGROUP BY', 'GROUP_BY', 'ORDER BY1'];
const BACKTICK_PAIRS = ['`GROUP BY`', '`GROUP /* c */ BY`', '`LEFT --c\n JOIN`', '`ORDER # c\nBY`', '`UNION /* a */ /* b */ ALL`', '`GROUP /* x */ y */ BY`',
  '`LEFT /* a */ ARRAY /* b */ JOIN`', '`ARRAY /**/ JOIN`', '`a /* b */ c`', '`GROUP /* unterminated BY`'];
const NUMBERS = ['0', '1', '42', '-7', '3.14', '-0.5', '1e5', '1E-3', '2.5e+10', '1e', '1.', '.5', '5.e3', '007', '1.2.3', '12abc', 'abc12', '-', '--1', '- 1', '1-2',
  '0x1F', '1_000', '9999999999999999999'];
const STRINGS = ["'plain'", "'it''s'", "'a\\'b'", "'tail\\", "'open", "''", "'multi\nline'", "'é中'", '"dq"', '"a\\"b"', '"open', "'emoji 😀'", "'lone \ud800 x'"];
const COMMENTS = ['-- line\n', '-- end of text', '# hash\n', '#x', '/* block */', '/* a\nb */', '/* open', '/**/', '/*/', '*/', '--\n', '/* -- */', '-- /* \n*/'];
const PUNCT = ['(', ')', ',', '.', ';', '=', '<', '>', '<=', '*', '+', '-', '/', '%', '[', ']', '{', '}', ':', '||', '&', '"', "'", '`', '\\', ' ', ' ', '﻿', '😀', '\ud800', '\udc00', '<b>', '&amp;'];
const SPACES = [' ', ' ', ' ', '  ', '\n', '\t', '\r\n', ''];
// A quoted name with a letter beyond ASCII before a "(": the kernel hands the text to the JavaScript lexer.
const NON_ASCII_CALLS = ['`caf\u00e9`(', '`\u212aount`(', '`\u00c9`('];
const CALLS = ['count(', 'sum (', 'toDate/* c */(', 'now\n(', 'toString(', 'uniqState(', 'sumState (', 'myCsFn(', 'MYCSFN(', 'unknownFn(', 'Date(', 'date(', 'x(',
  '`count`(', '`sum` (', '`my col`(', '`uniq`State(', '`uniqState`(', '`café`(', '`Kount`(', '`now` -- c\n(', 'if(', 'IF(', 'Array(', 'State('];

export function fuzzSql(seed, count, maxParts = 60) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const parts = 1 + r.int(maxParts);
    const calls = r.next() < 0.1 ? [...CALLS, ...NON_ASCII_CALLS] : CALLS;
    let text = '';
    for (let p = 0; p < parts; p += 1) {
      const roll = r.next();
      let piece;
      if (roll < 0.28) piece = r.pick(WORDS);
      else if (roll < 0.38) piece = r.pick(PAIRS);
      else if (roll < 0.43) piece = r.pick(BACKTICK_PAIRS);
      else if (roll < 0.52) piece = r.pick(NUMBERS);
      else if (roll < 0.62) piece = r.pick(STRINGS);
      else if (roll < 0.70) piece = r.pick(COMMENTS);
      else if (roll < 0.82) piece = r.pick(calls);
      else piece = r.pick(PUNCT);
      text += piece + r.pick(SPACES);
    }
    out.push(text);
  }
  return out;
}
