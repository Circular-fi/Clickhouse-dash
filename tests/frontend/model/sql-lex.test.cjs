const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const esm = require('../../harness/esm_vm.js');
// The lexer runs in a vm context: what it returns has the prototypes of that context, so a result is compared as JSON.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
const root = path.join(__dirname, '../../..');
// The one SQL lexer of the page (app_sql_lex.js) in a bare vm. sql-lex-vectors.json holds its answers on a list of texts: the
// WebAssembly kernels (tests/frontend/specs/wasm-sql.spec.js) and the lexer of the backend (tests/native/sql_test.cpp) are
// read against the same file.
let lex;
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'sql-lex-vectors.json'), 'utf8'));
const KINDS = ['', 'line', 'block', 'string', 'dquote', 'backtick'];

test.before(async () => {
  const run = await esm.load({ root });
  lex = (await run.import('app_sql_lex.js')).sqlLex;
});

test('the vectors: spans, the pieces of a script, the statement around a cursor and the mask of every text', () => {
  assert.ok(vectors.length >= 35);
  for (const vector of vectors) {
    const label = JSON.stringify(vector.sql);
    assert.deepEqual(lex.spans(vector.sql).map((s) => [s.start, s.end, KINDS[s.kind], s.closed]), vector.spans, `spans of ${label}`);
    assert.deepEqual(lex.splitRanges(vector.sql), vector.split, `pieces of ${label}`);
    assert.deepEqual(vector.statements.map(([pos]) => { const r = lex.statementAt(vector.sql, pos); return [pos, r.start, r.end]; }), vector.statements, `statements of ${label}`);
    assert.equal(lex.mask(vector.sql), vector.mask, `mask of ${label}`);
  }
});

test('the spans are in order, apart, and the mask keeps the length and the line breaks', () => {
  for (const { sql } of vectors) {
    let at = 0;
    for (const span of lex.spans(sql)) {
      assert.ok(span.start >= at && span.end > span.start && span.end <= sql.length, JSON.stringify(sql));
      at = span.end;
    }
    const masked = lex.mask(sql);
    assert.equal(masked.length, sql.length);
    for (let i = 0; i < sql.length; i += 1) if (sql[i] === '\n') assert.equal(masked[i], '\n');
  }
});

test('the four differences from ClickHouse are the rules of the page, on purpose', () => {
  const kinds = (sql) => lex.spans(sql).map((s) => KINDS[s.kind]);
  // 1. a "#" starts a comment wherever it is
  assert.deepEqual(kinds('select 1 #a'), ['line']);
  // 2. a block comment does not nest
  assert.deepEqual(lex.spans('/* a /* b */ c */').map((s) => [s.start, s.end]), [[0, 12]]);
  // 3. $$ is no text: the quote inside opens a string
  assert.deepEqual(kinds("select $$a'b$$"), ['string']);
  // 4. a backslash is a character in a name in backticks, but the DDL of the server escapes there
  assert.deepEqual(lex.spans('`a\\`').map((s) => [s.start, s.end]), [[0, 4]]);
  assert.deepEqual(lex.spans('`a\\`; `b`').map((s) => [s.start, s.end]), [[0, 4], [6, 9]]);
  assert.deepEqual(lex.spans('`a\\`; `b`', { clickhouse: true }).map((s) => [s.start, s.end]), [[0, 7], [8, 9]]);
});

test('a doubled quote: two names side by side for the page, one name for the DDL of the server', () => {
  assert.deepEqual(lex.spans('"a""b"').map((s) => [s.start, s.end]), [[0, 3], [3, 6]]);
  assert.deepEqual(lex.spans('"a""b"', { clickhouse: true }).map((s) => [s.start, s.end]), [[0, 6]]);
  assert.deepEqual(lex.spans("'a''b'").map((s) => [s.start, s.end]), [[0, 6]]);
  assert.deepEqual(lex.spans('`a``b`', { clickhouse: true }).map((s) => [s.start, s.end]), [[0, 6]]);
});

test('nextSpan scans from a place, and a "-" or a "/" that starts no comment is a character', () => {
  assert.equal(lex.nextSpan('a - b / c', 0), null);
  const span = lex.nextSpan("a - 'x' -- y", 0);
  assert.deepEqual([span.start, span.end, KINDS[span.kind], span.closed], [4, 7, 'string', true]);
  const next = lex.nextSpan("a - 'x' -- y", span.end);
  assert.deepEqual([next.start, next.end, KINDS[next.kind], next.closed], [8, 12, 'line', false]);
  assert.equal(lex.spanAt('abc', 1), null);
  assert.deepEqual(lex.spanAt('#x\ny', 0), [lex.LINE, 3, true]);
});

test('matchParen skips what is not code', () => {
  assert.equal(lex.matchParen('f(a, (b), c)', 1), 11);
  assert.equal(lex.matchParen("f(')', 1) -- )", 1), 8);
  assert.equal(lex.matchParen('f(a /* ) */)', 1), 11);
  assert.equal(lex.matchParen('f("a)")', 1), 6);
  assert.equal(lex.matchParen('f(a', 1), -1);
});

test('splitTopLevel cuts where the separator is code at depth 0, with the place of each piece', () => {
  assert.deepEqual(lex.splitTopLevel("a, f(b, c), 'd,e', `f,g`, \"h,i\" -- j,k\n, l").map((p) => p.text), ['a', 'f(b, c)', "'d,e'", '`f,g`', '"h,i" -- j,k', 'l']);
  assert.deepEqual(lex.splitTopLevel(' a ,  , b', ',', { base: 10 }), [{ text: 'a', start: 11, end: 12 }, { text: 'b', start: 18, end: 19 }]);
  // a type: the quotes of an Enum are no separators; brackets count when asked
  assert.deepEqual(lex.splitTopLevel("'a,b' = 1, 'c' = 2").map((p) => p.text), ["'a,b' = 1", "'c' = 2"]);
  assert.deepEqual(lex.splitTopLevel('a, [b, c], {d, e}', ',', { brackets: true }).map((p) => p.text), ['a', '[b, c]', '{d, e}']);
  assert.deepEqual(lex.splitTopLevel('a, [b, c]').map((p) => p.text), ['a', '[b', 'c]']);
  assert.deepEqual(lex.splitTopLevel('a; b', ';').map((p) => p.text), ['a', 'b']);
});

test('statementStart is the start of the last statement of a text', () => {
  assert.equal(lex.statementStart('select 1; select 2'), 9);
  assert.equal(lex.statementStart("select 'a;'"), 0);
  assert.equal(lex.statementStart('select f(1;'), 0);
  assert.equal(lex.statementStart(''), 0);
});

test('statementAt reads the whole text: a cursor inside a string or a parenthesis, a name after the cursor', () => {
  assert.deepEqual(lex.statementAt("select 'a;b' ; x", 10), { start: 0, end: 13 });
  assert.deepEqual(lex.statementAt('select 1 from `a;b`; select 2', 3), { start: 0, end: 19 });
  assert.deepEqual(lex.statementAt('select f(a, ; b) ; x', 10), { start: 0, end: 17 });
  assert.deepEqual(lex.statementAt('a; b; c', -5), { start: 0, end: 1 });
  assert.deepEqual(lex.statementAt('a; b; c', 99), { start: 5, end: 7 });
  assert.deepEqual(lex.statementAt('a; b; c', null), { start: 5, end: 7 });
});

test('the lexer is linear: a long script with a million characters is cut at once', () => {
  const script = "select 'a;b', \"c;d\", `e;f` -- g;h\n".repeat(30000);
  const started = Date.now();
  const pieces = lex.splitRanges(`${script};x`);
  assert.equal(pieces.length, 2);
  assert.ok(Date.now() - started < 3000, 'a million characters');
});
