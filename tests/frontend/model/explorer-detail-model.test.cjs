const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The pure part of the table card (app_explorer_detail_model.js): what a detail payload says as data. The SQL helpers of the card (keys, TTL)
// have their own checks in tests/harness/explorer_card_unit.js; here the tabs, the sections, the rows of the Columns tab, the split of the
// storage and the preview SELECT, in a bare vm with the real formatter.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let model;

test.before(async () => {
  const run = await esm.load({ root });
  model = await run.import('app_explorer_detail_model.js');
});

const mergeTree = (extra = {}) => ({ engine: 'MergeTree', database: 'db', name: 't', rows: 10, ...extra });

test('a MergeTree table has every tab that it has content for, a view has no Preview or Storage', () => {
  assert.deepEqual(model.availableTabs({ summary: mergeTree({ rows: 10 }), ddl: 'CREATE TABLE ...' }), ['Columns', 'Preview', 'Storage', 'DDL']);
  assert.deepEqual(model.availableTabs({ summary: { engine: 'View', rows: 0 } }), ['Columns']);
  assert.deepEqual(model.availableTabs({ summary: { engine: 'MaterializedView' }, ddl: 'x' }), ['Columns', 'DDL']);
});

test('an empty table keeps Columns, Lineage and DDL only', () => {
  const detail = { summary: mergeTree({ rows: 0 }), ddl: 'x', dependencies: [{ database: 'db', table: 'src', relation: 'upstream' }] };
  assert.deepEqual(model.availableTabs(detail), ['Columns', 'Lineage', 'DDL']);
});

test('a card that is still loading shows every tab that can come, Operations included', () => {
  assert.deepEqual(model.availableTabs({ summary: mergeTree(), _loading: true }), ['Columns', 'Preview', 'Storage', 'Operations', 'Lineage', 'DDL']);
});

test('Operations is a tab once one of its sections has data: a pending mutation, a running merge, a replicated table', () => {
  const idle = { summary: mergeTree() };
  assert.equal(model.hasOperations(idle), false);
  assert.equal(model.hasOperations({ summary: mergeTree(), mutations: [{ done: false }] }), true);
  assert.equal(model.hasOperations({ summary: mergeTree(), merges: [{}] }), true);
  assert.equal(model.hasOperations({ summary: mergeTree({ replication: { available: true } }) }), true);
  assert.equal(model.hasOperations({ summary: { engine: 'View' } }), false);
});

test('the sections of Operations say why they are empty, and an unavailable section says so', () => {
  const sections = model.operationSectionList({ summary: mergeTree(), unavailable_sections: ['merges'] });
  assert.deepEqual(sections.map((item) => item.id), ['merges', 'mutations', 'ingestion']);
  assert.equal(sections[0].emptyText, 'Merge metadata unavailable');
  assert.equal(sections[1].emptyText, 'No mutations');
  assert.equal(sections[2].emptyText, 'Write activity unavailable (query_log / part_log)');
  const distributed = model.operationSectionList({ summary: { engine: 'Distributed' }, distributed: { cluster: 'main' }, topology: [{ shard_num: 1 }] });
  assert.deepEqual(distributed.map((item) => item.id), ['distribution_queue', 'cluster']);
  assert.equal(distributed[1].title, 'Cluster main');
  assert.equal(distributed[1].hasData, true);
});

test('ingestion is active when any rate is above zero, idle when all are zero, unavailable when none is known', () => {
  assert.equal(model.ingestionState({}), 'unavailable');
  assert.equal(model.ingestionState({ client_ingress: { rows_per_second_1m: 0 } }), 'idle');
  assert.equal(model.ingestionState({ physical_ingress: { bytes_per_second_1h: 4 } }), 'active');
});

test('an unavailable section is named by the payload of the card, not by the page', () => {
  assert.equal(model.sectionUnavailable({ unavailable_sections: ['parts'] }, 'parts'), true);
  assert.equal(model.sectionUnavailable({ unavailable_sections: ['parts'] }, 'merges'), false);
  assert.equal(model.sectionUnavailable(null, 'parts'), false);
});

test('dependencies hide the row pseudo-objects; an object is told by its engine', () => {
  assert.deepEqual(model.visibleDependencies({ dependencies: [{ table: 'row' }, { table: '_row' }, { table: 'ok' }] }).map((dep) => dep.table), ['ok']);
  assert.equal(model.objectType('MaterializedView'), 'mv');
  assert.equal(model.objectType('Distributed'), 'distributed');
  assert.equal(model.objectType(''), 'unknown');
  assert.equal(model.objectType('ReplicatedMergeTree'), 'table');
  assert.equal(model.shortName('db', 't', 'db'), 't');
  assert.equal(model.shortName('other', 't', 'db'), 'other.t');
});

test('numbers: an empty value is no number, a share is clamped to 0-100, a ratio has one decimal under ten', () => {
  assert.equal(model.optionalNumber(''), null);
  assert.equal(model.optionalNumber(null), null);
  assert.equal(model.optionalNumber('12'), 12);
  assert.equal(model.optionalNumber('x'), null);
  assert.equal(model.percentValue(5, 10), 50);
  assert.equal(model.percentValue(50, 10), 100);
  assert.equal(model.percentValue(5, 0), null);
  assert.equal(model.ratioLabel(300, 100), '3.0×');
  assert.equal(model.ratioLabel(3000, 100), '30×');
  assert.equal(model.ratioLabel(300, 0), null);
  assert.equal(model.columnMax([{ v: 3 }, { v: -9 }, { v: null }], (item) => item.v), 9);
});

test('the TTL of a table is its own field, else the TTL clause of its DDL; a rule is written short', () => {
  assert.equal(model.extractTableTtl({ table_ttl: 'ts + 1' }), 'ts + 1');
  assert.equal(model.extractTableTtl({ ddl: 'CREATE TABLE t (ts DateTime)\nENGINE = MergeTree\nORDER BY ts\nTTL ts + toIntervalDay(30)\nSETTINGS a = 1' }), 'ts + toIntervalDay(30)');
  assert.equal(model.extractTableTtl({ ddl: 'CREATE TABLE t (ts DateTime) ENGINE = Log' }), '');
  assert.deepEqual(model.prettyTtlParts('ts + toIntervalDay(30)'), ['ts + 30 d', 'DELETE']);
  assert.deepEqual(model.prettyTtlParts('ts + INTERVAL 1 MONTH RECOMPRESS CODEC(ZSTD(3))'), ['ts + 1 mo', 'RECOMPRESS ZSTD(3)']);
  assert.deepEqual(model.prettyTtlParts('ts + INTERVAL 1 DAY TO VOLUME \'cold\''), ['ts + 1 d', 'TO VOLUME \'cold\'']);
});

test('the engine arguments and settings are what no other tile shows', () => {
  const full = "ReplicatedMergeTree('/path/{shard}', '{replica}') ORDER BY id SETTINGS index_granularity = 8192, storage_policy = 'tiered'";
  assert.equal(model.engineArguments({ engine: 'ReplicatedMergeTree', engine_full: full }), "ReplicatedMergeTree('/path/{shard}', '{replica}')");
  assert.deepEqual(model.engineSettingsOf({ engine_full: full }), ['index_granularity = 8192', "storage_policy = 'tiered'"]);
  assert.equal(model.engineArguments({ engine: 'MergeTree', engine_full: 'MergeTree ORDER BY id' }), '');
  assert.deepEqual(model.engineSettingsOf({ engine_full: "MergeTree ORDER BY id COMMENT 'SETTINGS x'" }), []);
});

test('the Columns rows: a column carries its keys with their positions, a tuple root its children and an offset stream', () => {
  const detail = {
    summary: mergeTree({ sorting_key: 'a, b', primary_key: 'a, b', partition_key: 'toYYYYMM(b)', bytes: 1000 }),
    default_compression_codecs: ['LZ4'],
    columns: [
      { name: 'a', type: 'String', is_in_sorting_key: true, is_in_primary_key: true, compressed_bytes: 100, uncompressed_bytes: 300 },
      { name: 'b', type: 'DateTime', is_in_sorting_key: true, is_in_partition_key: true, codec: 'CODEC(Delta(8), ZSTD(1))', compressed_bytes: 50 },
      { name: 'n', type: 'Array(Tuple(x UInt8, y String))', compressed_bytes: 10 },
      { name: 'n.x', type: 'Array(UInt8)', is_subcolumn: true, compressed_bytes: 4 },
      { name: 'n.size0', type: 'UInt64', is_subcolumn: true, compressed_bytes: 6 },
    ],
  };
  const rows = model.columnRows(detail);
  assert.deepEqual(rows.map((row) => row.name), ['a', 'b', 'n', 'n.[offsets]', 'n.x']);
  assert.deepEqual(rows.map((row) => row.position), [1, 2, 3, null, null]);
  assert.deepEqual(rows[0].keys.map((key) => key[0]), ['ORDER BY · 0']);
  assert.deepEqual(rows[1].keys.map((key) => key[0]), ['ORDER BY · 1', 'PARTITION · 0']);
  assert.equal(rows[0].codec, 'LZ4');
  assert.equal(rows[0].codec_note, 'default');
  assert.equal(rows[1].codec, 'Delta(8), ZSTD(1)');
  assert.equal(rows[1].explicit_codec, true);
  assert.equal(rows[0].percent, 10);
  assert.equal(rows[2].tuple_root, 'n');
  assert.equal(rows[4].tuple_parent, 'n');
  assert.equal(rows[3].compressed, 6);
  assert.equal(rows[3].tuple_parent, 'n');
  assert.match(rows[3].type, /Physical Array offset stream: n\.size0/);
});

test('the column size tree holds the top-level columns that have bytes, for the measure asked', () => {
  const rows = [
    { name: 'a', type: 'String', compressed: 5, uncompressed: 50, is_subcolumn: false },
    { name: 'b', type: 'UInt8', compressed: 0, uncompressed: 9, is_subcolumn: false },
    { name: 'a.x', type: 'UInt8', compressed: 3, uncompressed: 3, is_subcolumn: true },
  ];
  const tree = model.columnSizeTree({ summary: { database: 'db', name: 't' } }, rows, 'compressed');
  assert.deepEqual(tree.children.map((child) => child.name), ['a']);
  assert.equal(tree.bytes, 5);
  assert.equal(model.columnSizeTree({ summary: { database: 'db', name: 't' } }, rows, 'uncompressed').children.length, 2);
  assert.deepEqual(model.COLUMN_MEASURES.map((item) => item.value), ['compressed', 'uncompressed']);
});

test('the storage of a table splits into Wide, Compact, projections and indexes that add up to its bytes', () => {
  const both = model.storageComposition({
    summary: mergeTree({ bytes: 1000, secondary_indices_bytes: 100 }),
    column_storage: { wide_parts: 1, compact_parts: 1, wide_on_disk_bytes: 600, compact_on_disk_bytes: 200 },
    indexes_and_projections: [{ kind: 'projection:normal', on_disk_bytes: 100 }],
  });
  assert.equal(both.known, true);
  assert.deepEqual(both.items.map((item) => item.variant), ['wide', 'compact', 'projection', 'index']);
  assert.equal(both.items.reduce((sum, item) => sum + item.bytes, 0), 1000);
  assert.equal(both.items[2].bytes, 100);
  assert.equal(both.items[3].bytes, 100);
  assert.equal(both.items[0].bytes, 600);
  const wideOnly = model.storageComposition({ summary: mergeTree({ bytes: 500 }), column_storage: { wide_parts: 2, wide_on_disk_bytes: 480 } });
  assert.equal(wideOnly.items[0].bytes, 500);
  assert.equal(wideOnly.items[1].bytes, 0);
});

test('the storage is unknown when a byte count is missing or the parts do not add up', () => {
  assert.equal(model.storageComposition({ summary: mergeTree({}), column_storage: {} }).known, false);
  assert.equal(model.storageComposition({ summary: mergeTree({ bytes: 100 }), column_storage: { wide_parts: 1, wide_on_disk_bytes: null } }).known, false);
  const over = model.storageComposition({
    summary: mergeTree({ bytes: 100 }),
    column_storage: { wide_parts: 1, wide_on_disk_bytes: 100 },
    indexes_and_projections: [{ kind: 'projection:normal', on_disk_bytes: 200 }],
  });
  assert.equal(over.known, false);
});

test('partitions and structures: a partition without a name is "(no partition)", an index is told from a projection by its prefix', () => {
  const tree = model.partitionTree({ summary: { database: 'db', name: 't', engine: 'MergeTree' }, partitions: [{ partition: '', bytes: 5, rows: 1 }, { partition: '202401', bytes: 7 }] });
  assert.deepEqual(tree.children.map((child) => child.name), ['(no partition)', '202401']);
  assert.equal(tree.bytes, 12);
  assert.equal(tree.children[1].rows, null);
  const detail = { summary: mergeTree({ bytes: 1000 }), indexes_and_projections: [
    { kind: 'index:minmax', name: 'i1', compressed_bytes: 20, expression: 'a' },
    { kind: 'projection:normal', name: 'p1', compressed_bytes: 100 },
  ] };
  assert.deepEqual(model.structureItems(detail, 'index:').map((item) => [item.name, item.type, item.percent]), [['i1', 'minmax', 2]]);
  assert.deepEqual(model.structureItems(detail, 'projection:').map((item) => [item.name, item.type]), [['p1', 'normal']]);
});

test('the preview SELECT names every column, finalizes an aggregate state and keeps the limit of the preview', () => {
  const detail = {
    summary: { database: 'db', name: 'we`ird' },
    columns: [{ name: 'id', type: 'UInt64' }, { name: 'state', type: 'AggregateFunction(sum, UInt64)' }, { name: 'n.x', type: 'UInt8', is_subcolumn: true }],
  };
  assert.equal(model.buildPreviewSelectSql(detail, [], 100), 'SELECT `id`, finalizeAggregation(`state`) AS `state`\nFROM `db`.`we``ird`\nLIMIT 100');
  assert.equal(model.buildPreviewSelectSql({ summary: { database: 'd', name: 't' }, columns: [] }, [], 50), 'SELECT *\nFROM `d`.`t`\nLIMIT 50');
  // The columns the preview answered with name a state that the table card does not (a finalized column).
  assert.match(model.buildPreviewSelectSql(detail, [{ name: 'id', finalized_for_preview: true }], 500), /finalizeAggregation\(`id`\) AS `id`/);
  assert.equal(model.aggregatePreviewColumn({ type: ' AggregateFunction(count)' }), true);
  assert.equal(model.aggregatePreviewColumn({ type: 'UInt8' }), false);
  assert.deepEqual(model.PREVIEW_LIMITS, [50, 100, 500]);
});
