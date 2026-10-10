const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The values of a result (app_results_values.js) and the sort of its rows (app_results_sort.js) in a bare vm: no page behind them.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let values;
let sort;

test.before(async () => {
  const run = await esm.load({ root, stubs: {
    'app_state.js': { state: { runOptFlattenTuple: true } },
    'app_loader.js': { loader: {} },
    'app_wasm.js': { wasm: null },
  } });
  values = await run.import('app_results_values.js');
  sort = await run.import('app_results_sort.js');
});

const rowsOf = (list) => list.map((value, index) => { const row = [value]; row.__chdashRowIndex = index + 1; return row; });

test('JSON text is parsed without loss: a number that a double cannot keep stays its text, the keys keep their order', () => {
  const round = (text) => values.jsonText(values.parseJsonText(text));
  assert.equal(round('{"id":12345678901234567890,"a":1.0,"b":0.5}'), '{"id":12345678901234567890,"a":1.0,"b":0.5}');
  assert.equal(round('{"10":1,"2":2,"x":[1e100,-0.25]}'), '{"10":1,"2":2,"x":[1e100,-0.25]}');
  assert.equal(round('{"a":[1,2,{"b":null}],"c":"t\\u00e9xt"}'), '{"a":[1,2,{"b":null}],"c":"téxt"}');
  assert.equal(values.parseJsonText('{"a":'), undefined);
  assert.equal(values.jsonText(values.parseJsonText('{"10":1,"2":[3]}'), null, 2), '{\n  "10": 1,\n  "2": [\n    3\n  ]\n}');
});

test('the type of a column is parsed, and a quote in an Enum or a name does not split its arguments', () => {
  const ast = values.parseChType("Map(String, Tuple(a UInt8, `b,c` Array(String)))");
  assert.equal(ast.kind, 'Map');
  const enumAst = values.parseChType("Tuple(e Enum8('a,b' = 1, 'c' = 2), n UInt8)");
  assert.equal(enumAst.kind, 'Tuple');
  assert.equal(enumAst.fields.length, 2);
  assert.equal(values.isScalarNumericType(values.parseChType('Nullable(UInt64)')), true);
  assert.equal(values.isScalarNumericType(values.parseChType('Decimal(38, 18)')), true);
  assert.equal(values.isScalarNumericType(values.parseChType('String')), false);
  assert.equal(values.parseChType(''), null);
});

test('a value is written as the API sent it: a string stays a string, a Decimal keeps its digits, NULL is null', () => {
  const text = (raw, type = '') => values.formatCellForDisplayWithTypes(raw, 0, [values.parseChType(type)]);
  assert.equal(text('18446744073709551615', 'UInt64'), '18446744073709551615');
  assert.equal(text('1.500', 'Decimal(10, 3)'), '1.500');
  assert.equal(text(null, 'Nullable(String)'), 'null');
  assert.equal(text('nan', 'Float64'), 'nan');
  assert.equal(text('a\nb', 'String'), 'a\nb');
  assert.equal(text([1, 2], 'Array(UInt8)'), '[1,2]');
});

test('Copy JSON and Copy CSV have one serializer for a snapshot', () => {
  const snapshot = { columns: ['id', 'name', 'tags'], types: ['UInt64', 'String', 'Array(String)'], rows: [['18446744073709551615', 'a,b', ['x', 'y']], ['1', 'say "hi"', []]] };
  assert.equal(values.serialize.csv(snapshot), 'id,name,tags\n18446744073709551615,"a,b","[""x"",""y""]"\n1,"say ""hi""",[]');
  const json = JSON.parse(values.serialize.json(snapshot, 0));
  assert.equal(json.length, 2);
  assert.equal(json[0].name, 'a,b');
  assert.equal(values.serialize.json({ columns: [], types: [], rows: [] }), '[]');
});

test('a tuple column is flattened into columns, and a row follows the plan', () => {
  const plan = values.createTupleFlattenPlan(['t', 'n'], ['Tuple(a UInt8, b String)', 'UInt8'], true);
  assert.equal(plan.columns.length, 3);
  assert.equal(plan.columns[0], 't.a');
  assert.deepEqual(values.flattenTupleRow([[1, 'x'], 7], plan), [1, 'x', 7]);
  const off = values.createTupleFlattenPlan(['t'], ['Tuple(a UInt8, b String)'], false);
  assert.deepEqual(off.columns, ['t']);
});

test('numbers of a column: the decimal scale of a column is its longest scale, the bar spans from the column minimum', () => {
  assert.equal(values.extractDecimalScale('1.500'), 3);
  assert.equal(values.extractDecimalScale('12'), 0);
  assert.equal(values.formatNumericCellText('1.5', 0, [3]), '1.500');
  assert.equal(values.extractFiniteNumber('0x10'), null);
  assert.equal(values.extractFiniteNumber(' 12 '), 12);
  assert.equal(values.extractFiniteNumber('nan'), null);
  assert.equal(values.queryBarPercent(5, 0, 10), 50);
  assert.equal(values.queryBarPercent(-10, -10, 12), 0);
});

test('a numeric sort compares the digits of a UInt64 and of a long Decimal exactly; inf sorts as a number, nan with the NULLs', () => {
  const list = [
    '12345678901234567890.123456789', '12345678901234567890.123456788', '-12345678901234567890.123456789',
    '18446744073709551615', '18446744073709551614', 'inf', '-inf', 'nan', null, '0.000000001', '-0.000000001', '0',
  ];
  const rows = rowsOf(list);
  const asc = sort.sortNumericRows(rows, 0, 'asc').map((row) => row[0]);
  assert.deepEqual(asc, [
    '-inf', '-12345678901234567890.123456789', '-0.000000001', '0', '0.000000001',
    '12345678901234567890.123456788', '12345678901234567890.123456789', '18446744073709551614', '18446744073709551615', 'inf',
    'nan', null,
  ]);
  const byComparator = sort.sortNumericRowsByComparator(rows.slice(), 0, false).map((row) => row[0]);
  assert.deepEqual(byComparator, asc);
});

test('a text sort keeps equal texts in the order of the rows, and a descending sort reverses the others', () => {
  const rows = rowsOf(['b', 'a', 'B', 'a', null]);
  const text = (row, key) => String(row[key] ?? '');
  const asc = sort.sortTextRows(rows, 0, 'asc', text).map((row) => row.__chdashRowIndex);
  const reference = sort.sortTextRowsByComparator(rows.slice(), 0, false, text).map((row) => row.__chdashRowIndex);
  assert.deepEqual(asc, reference);
  const desc = sort.sortTextRows(rows, 0, 'desc', text).map((row) => row[0]);
  assert.equal(desc[0], 'b');
});
