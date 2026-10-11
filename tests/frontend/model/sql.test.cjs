const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The statements of a script (app_sql.js) in a bare vm, on the JavaScript path: the WebAssembly kernel is not loaded
// (specs/wasm-sql.spec.js compares the kernel with these answers). Run, Format and the History cut a script this way.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let sql;
let formatCalls;

test.before(async () => {
  formatCalls = [];
  const run = await esm.load({ root, stubs: {
    'app_api.js': { api: { formatSqls: async (host, statements) => { formatCalls.push([host, statements]); return statements.map((s) => s.replace(/\s+/g, ' ').replace(/^select /i, 'SELECT\n    ')); } } },
    'app_wasm.js': { wasm: null },
  } });
  sql = (await run.import('app_sql.js')).sql;
});

test('the statements of a script are cut at the ";" that is not in a string, a name or a comment', () => {
  assert.deepEqual(sql.splitSqlStatements('SELECT 1; SELECT 2;\nSELECT 3'), ['SELECT 1', 'SELECT 2', 'SELECT 3']);
  assert.deepEqual(sql.splitSqlStatements("SELECT ';' AS a; SELECT `x;y`, \"z;\" ; SELECT 1 -- a; comment\n; /* ; */ SELECT 2"),
    ["SELECT ';' AS a", 'SELECT `x;y`, "z;"', 'SELECT 1 -- a; comment', '/* ; */ SELECT 2']);
  assert.deepEqual(sql.splitSqlStatements(''), []);
  assert.deepEqual(sql.splitSqlStatements(null), []);
  assert.deepEqual(sql.splitSqlStatements(' ;; \n ; '), []);
});

test('a statement keeps the place of its text in the script, without the blanks around it', () => {
  const script = '  SELECT 1 ;\n\n\tSELECT 2;';
  const spans = sql.splitStatementSpans(script);
  assert.deepEqual(spans, [{ text: 'SELECT 1', start: 2, end: 10 }, { text: 'SELECT 2', start: 15, end: 23 }]);
  for (const span of spans) assert.equal(script.slice(span.start, span.end), span.text);
});

test('normalizeStatementText drops the blanks and every ";" at the end', () => {
  assert.equal(sql.normalizeStatementText('  SELECT 1 ;; '), 'SELECT 1');
  assert.equal(sql.normalizeStatementText(null), '');
  assert.equal(sql.normalizeStatementText(';'), '');
});

test('joinSqlStatements writes the statements one blank line apart and drops the empty ones', () => {
  assert.equal(sql.joinSqlStatements(['SELECT 1;', ' SELECT 2 ', '', ';']), 'SELECT 1;\n\nSELECT 2');
  assert.equal(sql.joinSqlStatements(['SELECT 1']), 'SELECT 1');
  assert.equal(sql.joinSqlStatements([]), '');
  assert.equal(sql.joinSqlStatements('SELECT 1'), '');
});

test('the leading spaces of a formatted query become tabs, the rest of a line is left alone', () => {
  assert.equal(sql.tabifyLeadingIndent('SELECT\n    a,\n        b,\n      c\n  d  e'), 'SELECT\n\ta,\n\t\tb,\n\t  c\n  d  e');
  assert.equal(sql.tabifyLeadingIndent('SELECT\n  a', 2), 'SELECT\n\ta');
  assert.equal(sql.tabifyLeadingIndent(null), '');
});

test('a script shorter than the kernel threshold is cut by the JavaScript path, and the kernel path answers null', () => {
  assert.equal(sql.splitWasmMinChars, 20000);
  assert.equal(sql.splitStatementSpansWasm('SELECT 1; SELECT 2'), null);
  assert.equal(sql.splitRangesWasm('x'.repeat(30000)), null, 'no kernel loaded');
  assert.deepEqual(sql.splitSqlStatements('SELECT 1; SELECT 2'), JSON.parse(JSON.stringify(sql.splitSqlStatementsJs('SELECT 1; SELECT 2'))));
});

test('formatText sends the statements one by one to the formatter and writes the answer with tabs', async () => {
  const text = await sql.formatText('local', 'select a,b from t; select 2');
  assert.deepEqual(formatCalls.at(-1), ['local', ['select a,b from t', 'select 2']]);
  assert.equal(text, 'SELECT\n\ta,b from t;\n\nSELECT\n\t2');
  assert.equal(await sql.formatText('local', '  '), '');
});
