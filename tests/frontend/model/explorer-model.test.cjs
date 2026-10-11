const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The pure parts of the Explorer: what a catalog entry is (app_explorer_summary.js) and its addresses (app_explorer_route.js), in a
// bare vm with the real formatter and a router that reads the address of the test.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let summary;
let route;
let query = '';

test.before(async () => {
  const run = await esm.load({ root, stubs: {
    'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null }, h: () => null },
    'app_router.js': { router: { path: (value) => value, current: () => ({ params: new URLSearchParams(query) }), url: (value) => value } },
  } });
  summary = await run.import('app_explorer_summary.js');
  route = await run.import('app_explorer_route.js');
});

test('an engine is named by its letters and digits only, and the families are told from it', () => {
  assert.equal(summary.engineKey('Replicated MergeTree'), 'replicatedmergetree');
  assert.equal(summary.engineKey({ engine: 'ReplacingMergeTree' }), 'replacingmergetree');
  assert.equal(summary.engineKey(null), '');
  assert.equal(summary.isMergeTreeSummary({ engine: 'ReplicatedSummingMergeTree' }), true);
  assert.equal(summary.isResidentMemorySummary({ engine: 'Buffer' }), true);
  assert.equal(summary.isResidentMemorySummary({ engine: 'MergeTree' }), false);
  assert.equal(summary.humanEngine('replacing mergetree'), 'ReplacingMergeTree');
  assert.equal(summary.humanEngine('Kafka'), 'Kafka');
  assert.equal(summary.humanEngine(''), 'metadata pending');
});

test('the footprint of an object is the bytes it reports: on disk, or in memory for Memory, Buffer and dictionaries', () => {
  assert.equal(summary.summaryFootprintBytes({ engine: 'MergeTree', bytes: 100 }), 100);
  assert.equal(summary.summaryFootprintBytes({ engine: 'MergeTree', logical_bytes: 7, compressed_bytes: 3 }), 7);
  assert.equal(summary.summaryFootprintBytes({ engine: 'Memory', resident_bytes: 5 }), 5);
  assert.equal(summary.summaryFootprintBytes({ engine: 'MergeTree', bytes: -1 }), null);
  assert.equal(summary.summaryFootprintBytes({ engine: 'MergeTree' }), null);
  assert.equal(summary.summaryFootprintBytes(null), null);
  assert.equal(summary.summaryRowsLabel({ engine: 'Buffer', rows: 1200 }), '1,200 buffered rows');
  assert.equal(summary.summaryRowsLabel({ engine: 'MergeTree', rows: 3 }), '3 rows');
  assert.equal(summary.summaryRowsLabel({ engine: 'MergeTree' }), null);
});

test('the Storage graph takes the MergeTree and Log families, a table with a policy or disks, and Buffer', () => {
  assert.equal(summary.storageCatalogEligible({ engine: 'MergeTree' }), true);
  assert.equal(summary.storageCatalogEligible({ engine: 'TinyLog' }), true);
  assert.equal(summary.storageCatalogEligible({ engine: 'Buffer' }), true);
  assert.equal(summary.storageCatalogEligible({ engine: 'Kafka', storage_policy: 'tiered' }), true);
  assert.equal(summary.storageCatalogEligible({ engine: 'Kafka', disks: ['default'] }), true);
  assert.equal(summary.storageCatalogEligible({ engine: 'SystemColumns' }), false);
  assert.equal(summary.storageCatalogEligible(null), false);
});

test('a row of the tree has a kind, a filter chip and a verdict on whether it stores anything', () => {
  assert.equal(summary.treeKind({ engine: 'MaterializedView' }), 'mv');
  assert.equal(summary.treeKind({ engine: 'ParameterizedView' }), 'view');
  assert.equal(summary.treeKind({ engine: 'Distributed' }), 'distributed');
  assert.equal(summary.treeKind({ engine: 'MergeTree' }), 'table');
  assert.equal(summary.filterKindOf({ engine: 'MaterializedView' }), 'mv');
  assert.equal(summary.filterKindOf({ engine: 'View' }), 'views');
  assert.equal(summary.filterKindOf({ engine: 'Dictionary' }), 'dict');
  assert.equal(summary.filterKindOf({ engine: 'Log' }), 'tables');
  assert.equal(summary.nonStoringSummary({ engine: 'View' }), true);
  assert.equal(summary.nonStoringSummary({ engine: 'Buffer' }), true);
  assert.equal(summary.nonStoringSummary({ engine: 'MergeTree' }), false);
  assert.equal(summary.objectKind({ engine: 'materialized view' }), 'Materialized View');
  assert.equal(summary.isSystemDatabaseName('INFORMATION_SCHEMA'), true);
  assert.equal(summary.isSystemDatabaseName('default'), false);
});

test('the catalog is grouped by database once for a payload, and the first summary of a name wins', () => {
  const tables = [{ database: 'a', name: 't1' }, { database: 'b', name: 't2' }, { database: 'a', name: 't3' }];
  const grouped = summary.tablesByDatabase(tables);
  assert.deepEqual(grouped.get('a').map((table) => table.name), ['t1', 't3']);
  assert.equal(summary.tablesByDatabase(tables), grouped);
  const summaries = [{ name: 'a', tables: 1 }, { name: 'a', tables: 2 }, { name: 'b', tables: 3 }];
  assert.equal(summary.summaryByDatabase(summaries).get('a').tables, 1);
  assert.equal(summary.summaryByDatabase(summaries).size, 2);
});

test('a bar is a share of the largest value, and a share under 1% is no bar', () => {
  assert.equal(summary.barPercent(50, 200), 25);
  assert.equal(summary.barPercent(1, 1000), 0);
  assert.equal(summary.barPercent(0, 10), 0);
  assert.equal(summary.barPercent(5, 0), 0);
  assert.equal(summary.barPercent('x', 10), 0);
});

test('a function belongs to the first category that the server names, else to the one of its kind', () => {
  assert.equal(summary.functionCategory({ category: "['String', 'Other']", kind: 'Function' }), 'String');
  assert.equal(summary.functionCategory({ category: '', kind: 'Aggregate Function' }), 'Aggregate');
  assert.equal(summary.functionCategory({ category: 'Aggregate Function', kind: 'Aggregate Function' }), 'Aggregate');
  assert.equal(summary.functionCategory({ category: '', kind: 'Table Function' }), 'Table functions');
  assert.equal(summary.functionCategory({ category: '', kind: 'Function' }), 'Other');
  assert.equal(summary.functionKindBadge({ user_defined: true }, 'Other'), 'UDF');
  assert.equal(summary.functionKindBadge({ kind: 'Aggregate Function' }, 'Math'), 'aggregate');
  assert.equal(summary.functionKindBadge({ kind: 'Aggregate Function' }, 'Aggregate'), '');
});

test('an address names its database, table and tab, and the former addresses open the same place', () => {
  const read = (pathname, search = '') => { query = search; return route.parseExplorerRoute(pathname); };
  assert.deepEqual(read('/explorer'), { workspace: 'explorer', section: 'tables', database: '', table: '', tab: 'Columns', databaseFocus: '', mode: 'browse', graphType: 'logical', graphDepth: 1 });
  assert.equal(read('/query').workspace, 'query');
  const card = read('/explorer/catalog/db/t', '?tab=ddl');
  assert.deepEqual([card.database, card.table, card.tab], ['db', 't', 'DDL']);
  assert.equal(read('/explorer/catalog/db/t/preview').tab, 'Preview');
  assert.equal(read('/explorer/catalog/db/t', '?tab=schema').tab, 'Columns');
  assert.equal(read('/explorer/catalog/db', '?tab=storage').databaseFocus, 'storage');
  assert.equal(read('/explorer/catalog/db/t', '?tab=storage').databaseFocus, '');
  assert.equal(read('/explorer/db/t').database, 'db');
  assert.equal(read('/explorer/catalog/functions').database, 'functions');
  const system = read('/explorer/_system', '?database=db&table=t');
  assert.deepEqual([system.database, system.table, system.tab], ['db', 't', 'Storage']);
  assert.equal(read('/explorer/_system').databaseFocus, 'storage');
  const graph = read('/explorer/catalog/db', '?mode=graph&graph=storage&depth=99');
  assert.deepEqual([graph.mode, graph.graphType, graph.graphDepth], ['graph', 'physical', 8]);
  assert.equal(read('/explorer/catalog', '?view=graph').mode, 'graph');
  assert.equal(read('/explorer/catalog', '?mode=storage').tab, 'Storage');
  assert.deepEqual(read('/explorer/functions/sum'), { workspace: 'explorer', section: 'functions', functionName: 'sum' });
  assert.equal(read('/explorer/catalog/my%20db/a%2Fb').table, 'a/b');
});

test('an address is written back in the scheme that it was read in', () => {
  assert.equal(route.catalogPath(), '/explorer/catalog');
  assert.equal(route.catalogPath({ database: 'my db', table: 'a/b' }), '/explorer/catalog/my%20db/a%2Fb');
  assert.equal(route.catalogPath({ database: 'db', table: 't', tab: 'DDL' }), '/explorer/catalog/db/t?tab=ddl');
  assert.equal(route.catalogPath({ database: 'db', table: 't', tab: 'Columns' }), '/explorer/catalog/db/t');
  assert.equal(route.catalogPath({ database: 'db', tab: 'DDL' }), '/explorer/catalog/db');
  assert.equal(route.catalogPath({ database: 'db', mode: 'graph', graphRoute: { mode: 'logical', depth: 2 } }), '/explorer/catalog/db?mode=graph&graph=lineage&depth=2');
  assert.equal(route.catalogPath({ mode: 'graph', graphRoute: { mode: 'physical' } }), '/explorer/catalog?mode=graph&graph=storage');
});
