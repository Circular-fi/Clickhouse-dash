const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The editor's diagnostics (app_autocomplete.js) with the real state and the rest of its imports stubbed, as the module loads on the page.
// The formatter side of the same cases is tests/api/format (fixtures 082 and 083).
let autocomplete;

const tableColumns = {
  'system.tables': [
    { name: 'parameterized_view_parameters', insertName: 'parameterized_view_parameters', type: 'Array(String)' },
    { name: 'name', insertName: 'name', type: 'String' },
  ],
};
const tables = [{ database: 'system', name: 'tables' }];
const meta = {
  databases: { items: [{ name: 'system' }] },
  tables: { items: tables },
  table_functions: { items: [{ name: 'numbers' }] },
  functions: { items: [] },
  keywords: { items: ['SELECT', 'FROM', 'AS', 'ARRAY', 'JOIN'].map((name) => ({ name })) },
  autocomplete: { tablesByDatabase: new Map([['system', tables]]) },
};

test.before(async () => {
  const run = await esm.load({
    root,
    stubs: {
      'app_meta.js': { meta: { getTableColumns: (database, table) => tableColumns[`${database}.${table}`] || [], ensureTableColumns() {} } },
      'app_dom.js': {}, 'app_highlight.js': {}, 'app_loader.js': {}, 'app_ui_icon.js': {}, 'app_ui_menu.js': {},
      'app_ui_popover.js': {}, 'app_util.js': {}, 'app_wasm.js': {},
    },
  });
  ({ autocomplete } = await run.import('app_autocomplete.js'));
});

const diagnose = (query) => JSON.parse(JSON.stringify(autocomplete.diagnose(query, meta)));

test('an ARRAY JOIN alias, a repeated ARRAY JOIN and a column of the table are not unknown references', () => {
  assert.deepEqual(diagnose(`SELECT
    param,
    num
FROM system.tables
ARRAY JOIN
    parameterized_view_parameters AS param
    ARRAY JOIN[1, 2] AS num`), []);
});

test('a reserved word used as an alias (AS FROM) is an alias, not the start of the FROM clause', () => {
  assert.deepEqual(diagnose('SELECT 1 AS FROM, number FROM numbers(10)'), []);
  assert.deepEqual(diagnose('SELECT 1 AS FROM, number\nFROM numbers(10)'), []);
});

test('a table that is not in the catalogue is reported, with the span of its name', () => {
  const sql = 'SELECT 1 FROM system.nothing_here';
  assert.deepEqual(diagnose(sql), [{ start: 14, end: 33, kind: 'unknown_table', message: "Unknown table 'system.nothing_here'." }]);
  assert.equal(sql.slice(14, 33), 'system.nothing_here');
});
