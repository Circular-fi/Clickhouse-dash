const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The pure parts of the Explorer graph: the request of a scope, the Lineage and Storage projections of a payload, the database groups of the
// overview, the neighbourhood of a focus (app_explorer_graph_model.js), the labels (_text), the shapes of an edge (_geometry) and the positions
// of the cards (_layout, over the real layered kit), in a bare vm with the page stubbed.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let model;
let text;
let geometry;
let layout;

test.before(async () => {
  const run = await esm.load({ root, stubs: { 'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null }, h: () => null } } });
  model = await run.import('app_explorer_graph_model.js');
  text = await run.import('app_explorer_graph_text.js');
  geometry = await run.import('app_explorer_graph_geometry.js');
  layout = await run.import('app_explorer_graph_layout.js');
});

const table = (database, name, extra = {}) => ({ id: `table:${database}.${name}`, layer: 'logical', kind: 'table', database, name, ...extra });
const view = (database, name) => table(database, name, { kind: 'view' });
const edge = (from, to, kind = 'view', extra = {}) => ({ id: `${from}>${to}`, from: from.id || from, to: to.id || to, kind, ...extra });

test('a table id names its database and table, and a node id or a focus names the table that it stands on', () => {
  assert.deepEqual(model.parseLogicalTableId('table:db.t'), { database: 'db', table: 't' });
  assert.deepEqual(model.parseLogicalTableId('table:db.a.b'), { database: 'db', table: 'a.b' });
  assert.equal(model.parseLogicalTableId('disk:d1'), null);
  assert.equal(model.parseLogicalTableId('table:.t'), null);
  const graph = { nodes: [table('db', 't')] };
  assert.deepEqual(model.focusScopeOf(graph, 'table:db.t'), { database: 'db', table: 't' });
  assert.deepEqual(model.focusScopeOf({ nodes: [] }, 'table:db.u'), { database: 'db', table: 'u' });
  assert.equal(model.focusScopeOf(graph, null), null);
});

test('the request asks for what is on screen: the focus with its depth and expansions, or the database, and nothing else', () => {
  const view_ = { detailMode: 'logical', includeSystem: false, includeNonStoring: true, focus: { database: 'db', table: 't' }, focusDepth: 12, expansions: new Set(['up\u0000b', 'down\u0000a']), database: 'x' };
  assert.deepEqual(model.graphRequestOptions(view_, true), {
    mode: 'logical', includeSystem: false, includeNonStoring: true, refresh: true,
    focusDatabase: 'db', focusTable: 't', depth: 8, expand: ['down:a', 'up:b'],
  });
  assert.equal(model.graphRequestOptions({ ...view_, detailMode: 'physical' }).depth, 0);
  assert.equal(model.graphRequestOptions({ ...view_, detailMode: 'physical' }).expand, undefined);
  assert.deepEqual(model.graphRequestOptions({ ...view_, focus: null }), { mode: 'logical', includeSystem: false, includeNonStoring: true, refresh: false, database: 'x' });
  const same = model.graphRequestKey(model.graphRequestOptions(view_));
  assert.equal(same, model.graphRequestKey(model.graphRequestOptions({ ...view_, focusDepth: 8 })));
  assert.notEqual(same, model.graphRequestKey(model.graphRequestOptions({ ...view_, focusDepth: 2 })));
});

test('Lineage hides the system databases, and contracts a hidden view into one edge between the objects that stay', () => {
  const a = table('db', 'a');
  const v = view('db', 'v');
  const b = table('db', 'b');
  const sys = table('system', 'tables');
  const graph = { nodes: [a, v, b, sys], edges: [edge(a, v), edge(v, b), edge(sys, b)] };
  const all = model.buildLogicalProjection(graph, { includeSystem: true, includeNonStoring: true, focusedId: null });
  assert.deepEqual(all.nodes.map((node) => node.name), ['a', 'v', 'b', 'tables']);
  assert.equal(all.edges.length, 3);
  const user = model.buildLogicalProjection(graph, { includeSystem: false, includeNonStoring: true, focusedId: null });
  assert.deepEqual(user.nodes.map((node) => node.name), ['a', 'v', 'b']);
  assert.equal(user.edges.length, 2);
  const contracted = model.buildLogicalProjection(graph, { includeSystem: false, includeNonStoring: false, focusedId: null });
  assert.deepEqual(contracted.nodes.map((node) => node.name), ['a', 'b']);
  assert.equal(contracted.edges.length, 1);
  assert.equal(contracted.edges[0].from, a.id);
  assert.equal(contracted.edges[0].to, b.id);
  assert.equal(contracted.edges[0].collapsed, true);
  assert.equal(contracted.edges[0].label, 'via hidden object');
  assert.deepEqual(contracted.edges[0].collapsed_path, [v.id]);
  // The focused object always shows, even a view.
  const focused = model.buildLogicalProjection(graph, { includeSystem: false, includeNonStoring: false, focusedId: v.id });
  assert.deepEqual(focused.nodes.map((node) => node.name), ['a', 'v', 'b']);
});

test('a hidden Buffer stands for the table it flushes into', () => {
  const src = table('db', 'src');
  const buffer = { ...table('db', 'buf'), kind: 'buffer' };
  const target = table('db', 'target');
  const graph = { nodes: [src, buffer, target], edges: [edge(src, buffer, 'buffer'), edge(buffer, target, 'buffer')] };
  const projection = model.buildLogicalProjection(graph, { includeSystem: false, includeNonStoring: false, focusedId: null });
  assert.deepEqual(projection.nodes.map((node) => node.name), ['src', 'target']);
  assert.equal(projection.edges.length, 1);
  assert.equal(projection.edges[0].kind, 'buffer');
});

test('the neighbourhood of a focus is the objects within its depth, either direction', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => table('db', name));
  const projection = { nodes: [a, b, c, d], edges: [edge(a, b), edge(b, c), edge(c, d)] };
  assert.deepEqual([...model.neighborhoodIds(projection, b.id, 1)].sort(), [a.id, b.id, c.id]);
  assert.deepEqual([...model.neighborhoodIds(projection, b.id, 2)].sort(), [a.id, b.id, c.id, d.id]);
  assert.deepEqual([...model.neighborhoodIds(projection, b.id, 0)], [b.id]);
  assert.equal(model.neighborhoodIds(projection, 'table:db.zzz', 1), null);
  assert.equal(model.neighborhoodIds(projection, null, 1), null);
});

test('the overview collapses the databases that are not expanded into one card, with the edges between them counted', () => {
  const a1 = table('a', 'one');
  const a2 = table('a', 'two');
  const b1 = table('b', 'one');
  const lone = table('b', 'lonely');
  const nodes = [a1, a2, b1, lone];
  const edges = [edge(a1, b1), edge(a2, b1)];
  const grouped = model.groupOverview(nodes, edges, { expandedGroups: new Set(), showIsolated: false });
  assert.deepEqual(grouped.nodes.map((node) => node.id), ['group:a', 'group:b']);
  assert.equal(grouped.edges.length, 1);
  assert.equal(grouped.edges[0].aggregated, true);
  assert.equal(grouped.edges[0].members.length, 2);
  assert.equal(grouped.stats.get('b').total, 2);
  assert.equal(grouped.stats.get('b').connected, 1);
  const open = model.groupOverview(nodes, edges, { expandedGroups: new Set(['a']), showIsolated: true });
  assert.deepEqual(open.nodes.map((node) => node.id), [a1.id, a2.id, 'group:b']);
  const onlyOne = model.groupOverview([a1, a2], [edge(a1, a2)], { expandedGroups: new Set(), showIsolated: false });
  assert.deepEqual(onlyOne.nodes.map((node) => node.id), [a1.id, a2.id]);
});

test('an object keeps storage when a physical node hangs on it, or a Buffer reaches one that does', () => {
  const stored = table('db', 'stored');
  const buffer = { ...table('db', 'buf'), kind: 'buffer' };
  const plain = view('db', 'v');
  const volume = { id: 'volume:hot', layer: 'physical', kind: 'volume', name: 'hot' };
  const graph = { nodes: [stored, buffer, plain, volume], edges: [edge(stored, volume, 'volume_tier'), edge(buffer, stored, 'buffer')] };
  assert.equal(model.canUseStorage(graph, stored.id), true);
  assert.equal(model.canUseStorage(graph, buffer.id), true);
  assert.equal(model.canUseStorage(graph, plain.id), false);
  assert.equal(model.canUseStorage(graph, volume.id), false);
  assert.equal(model.canUseStorage(null, stored.id), false);
  // The backend's flag wins when it answers.
  assert.equal(model.canUseStorage({ nodes: [{ ...plain, storage_available: true }], edges: [] }, plain.id), true);
});

test('the focus stands on a logical object: a click on a disk keeps the focused table, else the table that owns the disk', () => {
  const t = table('db', 't');
  const other = table('db', 'o');
  const disk = { id: 'disk:d', layer: 'physical', kind: 'disk', name: 'd' };
  const graph = { nodes: [t, other, disk], edges: [edge(t, disk, 'contains')] };
  assert.equal(model.logicalFocusId(graph, null, t.id), t.id);
  assert.equal(model.logicalFocusId(graph, other.id, disk.id), other.id);
  assert.equal(model.logicalFocusId(graph, null, disk.id), t.id);
  assert.equal(model.logicalFocusId(graph, null, 'table:db.missing'), null);
  assert.equal(model.logicalFocusId(null, null, 'x'), 'x');
});

test('Storage folds a volume and its disks into one tier, and a TTL delete adds the terminal that the data goes to', () => {
  const t = table('db', 't', { ttl_rules: [{ expression: 'ts + 30', action: 'delete', base_expression: 'ts', offset_label: '+ 30 d' }] });
  const volume = { id: 'volume:hot', layer: 'physical', kind: 'volume', name: 'hot', volume_priority: 1 };
  const disk = { id: 'disk:d1', layer: 'physical', kind: 'disk', name: 'd1', disk_name: 'd1' };
  const graph = { nodes: [t, volume, disk], edges: [edge(t, volume, 'volume_tier'), edge(volume, disk, 'volume_disk')] };
  const projection = model.buildStorageProjection(graph, { includeSystem: false, includeNonStoring: true, focusedId: null });
  const kinds = projection.nodes.map((node) => node.kind).sort();
  assert.deepEqual(kinds, ['storage_tier', 'table', 'ttl_expired']);
  const tier = projection.nodes.find((node) => node.kind === 'storage_tier');
  assert.deepEqual(tier.tier_disks.map((item) => item.name), ['d1']);
  assert.deepEqual(tier.root_logical_ids, [t.id]);
  assert.equal(projection.nodes.find((node) => node.kind === 'table').storage_disabled, false);
  assert.deepEqual(projection.edges.map((item) => item.kind).sort(), ['ttl_delete', 'volume_tier']);
});

test('Storage leaves out an object that keeps no data, and keeps the Buffer that flushes into one that does', () => {
  const stored = table('db', 'stored');
  const plain = view('db', 'v');
  const buffer = { ...table('db', 'buf'), kind: 'buffer' };
  const volume = { id: 'volume:hot', layer: 'physical', kind: 'volume', name: 'hot' };
  const graph = { nodes: [stored, plain, buffer, volume], edges: [edge(stored, volume, 'volume_tier'), edge(buffer, stored, 'buffer')] };
  const projection = model.buildStorageProjection(graph, { includeSystem: false, includeNonStoring: true, focusedId: null });
  assert.deepEqual(projection.nodes.filter((node) => node.layer === 'logical').map((node) => node.name).sort(), ['buf', 'stored']);
});

test('what the focus needs of the visibility switches, and what a switch lets through', () => {
  const sys = table('system', 'tables');
  const v = view('db', 'v');
  const t = table('db', 't');
  const graph = { nodes: [sys, v, t] };
  assert.deepEqual(model.requiredVisibility(graph, sys.id), { includeSystem: true, includeNonStoring: false });
  assert.deepEqual(model.requiredVisibility(graph, v.id), { includeSystem: false, includeNonStoring: true });
  assert.deepEqual(model.requiredVisibility(graph, null), { includeSystem: false, includeNonStoring: false });
  assert.equal(model.logicalNodeAllowed(v, { includeSystem: false, includeNonStoring: false, focusedId: null }), false);
  assert.equal(model.logicalNodeAllowed(v, { includeSystem: false, includeNonStoring: false, focusedId: v.id }), true);
  assert.equal(model.logicalNodeAllowed(sys, { includeSystem: false, includeNonStoring: true }), false);
  assert.equal(model.logicalNodeAllowed(t, { includeSystem: false, includeNonStoring: false }), true);
});

test('a card has the size of what it shows: a table, a buffer, a Storage tier with its disks and events', () => {
  assert.deepEqual(model.nodeSize(table('db', 't'), 'logical'), { width: model.NODE_WIDTH, height: model.NODE_HEIGHT });
  assert.equal(model.nodeSize({ ...table('db', 'b'), kind: 'buffer' }, 'logical').height, 96);
  assert.deepEqual(model.nodeSize({ layer: 'physical', kind: 'disk' }, 'physical'), { width: model.PHYSICAL_WIDTH, height: model.PHYSICAL_HEIGHT });
  assert.deepEqual(model.nodeSize({ kind: 'storage_tier', tier_disks: [{}, {}], ttl_events: [] }, 'physical'), { width: 290, height: 59 + 2 * 33 });
  const ttl = [{ expression: 'x' }];
  assert.equal(model.nodeSize(table('db', 't', { ttl_rules: ttl }), 'physical').height, 96);
  assert.equal(model.nodeSize(table('db', 't', { ttl_rules: ttl }), 'logical').height, model.NODE_HEIGHT);
  assert.equal(model.nodeSize(table('db', 't', { storage_policy: 'p', ttl_rules: ttl }), 'physical').height, 114);
});

test('the labels of a card and of an edge', () => {
  assert.equal(text.kindCode('materialized_view'), 'MaterializedView');
  assert.equal(text.kindCode('some_new_kind'), 'some new kind');
  assert.equal(text.humanEngine('replacing mergetree'), 'ReplacingMergeTree');
  assert.equal(text.humanEngine('Kafka'), 'Kafka');
  assert.equal(text.humanEngine(''), 'Table');
  assert.equal(text.nodeKindLabel({ layer: 'logical', kind: 'table', engine: 'mergetree' }), 'MergeTree');
  assert.equal(text.nodeKindLabel({ layer: 'physical', kind: 'disk' }), 'Disk');
  assert.equal(text.nodeSizeLabel({ kind: 'table', rows: 1200, logical_bytes: 2048 }), '1,200 rows · 2.0 KB logical');
  assert.equal(text.nodeSizeLabel({ kind: 'buffer', rows: 3, resident_bytes: 1024 }), '3 buffered rows · 1.0 KB RAM');
  assert.match(text.nodeSizeLabel({ kind: 'table' }), /rows/);
  assert.equal(text.ttlActionSummary({ action: 'move', target: 'cold', target_kind: 'volume' }), 'MOVE → VOLUME cold');
  assert.equal(text.ttlActionSummary({ action: 'delete' }), 'DELETE');
  assert.equal(text.ttlTimingSummary({ base_expression: 'ts', offset_label: '+ 7 d' }), 'ts + 7 d');
  assert.equal(text.ttlTimingSummary({}), 'expiry expression');
  assert.equal(text.ttlBaseSummary({ ttl_rules: [{ expression: 'a', base_expression: 'ts' }, { expression: 'b', base_expression: 'ts' }] }), 'ts');
  assert.equal(text.ttlBaseSummary({ ttl_rules: [{ expression: 'a', base_expression: 'x' }, { expression: 'b', base_expression: 'y' }] }), 'multiple expressions');
  assert.equal(text.edgeShortLabel({ kind: 'materialized_view' }), 'MV');
  assert.equal(text.edgeShortLabel({ kind: 'view', collapsed: true, collapsed_path: ['a', 'b'] }), 'view · via 2');
  assert.equal(text.edgeShortLabel({ aggregated: true, members: [1, 2, 3] }), '×3');
  assert.equal(text.edgeLongLabel({ kind: 'buffer' }), 'Buffer flush');
  assert.equal(text.edgeLongLabel({ aggregated: true, members: [1] }), '1 dependency between databases');
  assert.deepEqual(text.ttlEdgeLabelLines({ ttl_events: [{ base_expression: 'ts', offset_label: '+ 1 d', action: 'move', target_kind: 'disk', target: 'cold' }] }), ['ts + 1 d', 'MOVE → DISK cold']);
  assert.equal(text.diskCapacitySummary({ disk_free_space: 50, disk_total_space: 100 }), '50% used · 50 B free');
  assert.equal(text.diskCapacitySummary({}), '');
});

test('the card texts are made once per node', () => {
  const node = { database: 'db', kind: 'buffer', layer: 'logical', rows: 5, resident_bytes: 10, buffer_min_time: 1, buffer_max_time: 9, buffer_min_rows: 10, buffer_max_rows: 100, storage_policy: 'tiered' };
  const texts = text.nodeTexts(node);
  assert.equal(texts, text.nodeTexts(node));
  assert.equal(texts.subtitle, 'db · Buffer');
  assert.equal(texts.policy, 'Storage policy · tiered');
  assert.equal(texts.flush, 'flush 1s–9s · 10–100 rows');
});

test('a curve starts and ends on its anchors; a Storage edge is a route that leaves from the side or the bottom of a card', () => {
  const p0 = { x: 0, y: 0 };
  const p3 = { x: 30, y: 60 };
  assert.deepEqual(geometry.bezierPoint(p0, { x: 10, y: 0 }, { x: 20, y: 60 }, p3, 0), p0);
  assert.deepEqual(geometry.bezierPoint(p0, { x: 10, y: 0 }, { x: 20, y: 60 }, p3, 1), p3);
  assert.equal(geometry.bezierRoutePoints(p0, p0, p3, p3, 10).length, 11);
  const card = (x, y, node = {}) => ({ x, y, width: 100, height: 40, node });
  const flat = geometry.storageRouteGeometry(card(0, 0), card(200, 0), { kind: 'storage_policy' });
  assert.equal(flat.vertical, false);
  assert.deepEqual(flat.points.map((p) => p.x), [100, 200]);
  const stacked = geometry.storageRouteGeometry(card(0, 0, { kind: 'storage_tier' }), card(0, 100, { kind: 'storage_tier' }), { kind: 'ttl_move' });
  assert.equal(stacked.vertical, true);
  assert.deepEqual(stacked.points, [{ x: 50, y: 40 }, { x: 50, y: 100 }]);
  const buffer = geometry.storageRouteGeometry(card(0, 0), card(20, 100), { kind: 'buffer' });
  assert.equal(buffer.vertical, true);
  assert.equal(buffer.points[0].y, 40);
  const stepped = geometry.storageRouteGeometry(card(0, 0), card(250, 90), { kind: 'volume_tier' });
  assert.equal(stepped.points.length, 4);
});

test('which edges are data flow, and which draw as routes (Storage only)', () => {
  assert.equal(geometry.isInsertFlowEdge({ kind: 'materialized_view' }), true);
  assert.equal(geometry.isInsertFlowEdge({ kind: 'buffer' }), true);
  assert.equal(geometry.isInsertFlowEdge({ kind: 'view' }), false);
  assert.equal(geometry.isRefreshFlowEdge({ kind: 'refreshable_mv_output' }), true);
  assert.equal(geometry.isStorageRouteEdge({ kind: 'ttl_move' }, 'physical'), true);
  assert.equal(geometry.isStorageRouteEdge({ kind: 'ttl_move' }, 'logical'), false);
  assert.equal(geometry.isStorageRouteEdge({ kind: 'view' }, 'physical'), false);
});

test('cards overlap with a margin, and the box of a layout is the cards plus 50 units', () => {
  assert.equal(layout.rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }), true);
  assert.equal(layout.rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 25, y: 0, width: 10, height: 10 }), false);
  assert.equal(layout.rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 11, y: 0, width: 10, height: 10 }, 0), false);
  assert.deepEqual(layout.layoutBounds(new Map()), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(layout.layoutBounds(new Map([['a', { x: 10, y: 20, width: 100, height: 50 }], ['b', { x: 200, y: 0, width: 10, height: 10 }]])), { x: -40, y: -50, width: 300, height: 170 });
});

test('Lineage puts a dependency one column to the right, on the same row, and gives every card its size', () => {
  const a = table('db', 'a');
  const b = table('db', 'b');
  const { positions, bounds } = layout.layoutNodes({ nodes: [a, b], edges: [edge(a, b)], detailMode: 'logical' });
  const pa = positions.get(a.id);
  const pb = positions.get(b.id);
  assert.equal(pa.width, model.NODE_WIDTH);
  assert.equal(pa.height, model.NODE_HEIGHT);
  assert.ok(pb.x > pa.x + pa.width);
  assert.equal(pb.y, pa.y);
  assert.equal(JSON.stringify(bounds), JSON.stringify(layout.layoutBounds(positions)));
});

test('a layout that keeps the previous cards where they were places the new one without covering them', () => {
  const a = table('db', 'a');
  const b = table('db', 'b');
  const c = table('db', 'c');
  const first = layout.layoutNodes({ nodes: [a, b], edges: [edge(a, b)], detailMode: 'logical' }).positions;
  const moved = new Map([...first].map(([id, item]) => [id, { ...item, x: item.x + 1000, y: item.y + 500 }]));
  const second = layout.layoutNodes({ nodes: [a, b, c], edges: [edge(a, b), edge(b, c)], detailMode: 'logical', previousLayout: moved, focusedId: a.id }).positions;
  assert.equal(second.get(a.id).x, moved.get(a.id).x);
  assert.equal(second.get(b.id).y, moved.get(b.id).y);
  for (const id of [a.id, b.id]) assert.equal(layout.rectsOverlap(second.get(c.id), second.get(id)), false);
});

test('a mostly disconnected graph wraps into lanes instead of one tall column', () => {
  const nodes = Array.from({ length: 30 }, (_, index) => table('db', `t${String(index).padStart(2, '0')}`));
  const { positions } = layout.layoutNodes({ nodes, edges: [], detailMode: 'logical' });
  assert.equal(positions.size, 30);
  const columns = new Set([...positions.values()].map((item) => item.x));
  assert.ok(columns.size > 1);
  const rows = Math.max(...[...positions.values()].map((item) => item.lineageRow)) + 1;
  assert.ok(rows >= 8 && rows < 30);
});

test('Lineage groups the cards of one database into a band, the focused database first', () => {
  const nodes = [table('a', 'x'), table('a', 'y'), table('b', 'z')];
  const positions = new Map(nodes.map((node, index) => [node.id, { x: 70, y: 70 + index * 100, width: 264, height: 80, node, lineageRow: index }]));
  layout.groupLogicalPositionsByDatabase(positions, 'logical', { database: 'b', table: 'z' });
  assert.ok(positions.get('table:b.z').y < positions.get('table:a.x').y);
  const untouched = new Map(nodes.map((node, index) => [node.id, { x: 70, y: 70 + index * 100, width: 264, height: 80, node }]));
  layout.groupLogicalPositionsByDatabase(untouched, 'physical', null);
  assert.equal(untouched.get('table:b.z').y, 270);
});
