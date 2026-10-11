const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The model of a trace (app_trace_model.js): the tree of the spans, the critical path, the axis of durations, the sort of a
// list of traces and the spans' data, in a bare vm with the real formatter (no page).
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let m;

test.before(async () => {
  const run = await esm.load({ root, stubs: { 'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null } } } });
  m = await run.import('app_trace_model.js');
});

const span = (id, parent, start, duration, extra = {}) => ({ span_id: id, parent_span_id: parent, start_ns: start, duration_ns: duration, service_name: 'svc', span_name: `op-${id}`, status_code: 'Ok', ...extra });

test('a parent id of zeros is no parent, and a span with an unknown parent is a root of its own', () => {
  assert.equal(m.parentSpanId({ parent_span_id: '0000000000000000' }), '');
  assert.equal(m.parentSpanId({ parent_span_id: 'ab' }), 'ab');
  const tree = m.buildTree([span('a', '', 0, 100), span('b', 'a', 10, 20), span('c', 'zz', 5, 5)]);
  assert.deepEqual(tree.roots.map((node) => node.span.span_id), ['a', 'c']);
  assert.deepEqual(tree.roots[0].children.map((node) => node.span.span_id), ['b']);
  assert.equal(tree.nodes.find((node) => node.span.span_id === 'b').depth, 1);
});

test('children are ordered by start, a long chain does not exhaust the stack and a span is never its own parent', () => {
  const spans = [span('r', '', 0, 1000)];
  for (let i = 0; i < 20000; i += 1) spans.push(span(`s${i}`, i === 0 ? 'r' : `s${i - 1}`, i + 1, 1));
  const tree = m.buildTree(spans);
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.nodes[20000].depth, 32, 'the depth is capped');
  const self = m.buildTree([span('x', 'x', 0, 1)]);
  assert.equal(self.roots.length, 1);
  const order = m.buildTree([span('p', '', 0, 100), span('late', 'p', 50, 1), span('early', 'p', 5, 1)]);
  assert.deepEqual(order.roots[0].children.map((node) => node.span.span_id), ['early', 'late']);
});

test('the cache of a trace holds the order of the waterfall, the errors below a span and the bounds', () => {
  const cache = m.createTraceCache({ trace_id: 't', spans: [
    span('a', '', 0, 1000), span('b', 'a', 100, 300), span('c', 'b', 150, 50, { status_code: 'Error' }), span('d', 'a', 500, 100), span('e', 'x', 10, 10),
  ] });
  assert.deepEqual(cache.order.map((node) => node.span.span_id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(cache.order.map((node) => node.level), [0, 1, 2, 1, 0]);
  assert.equal(cache.errorCount, 1);
  assert.equal(cache.errorBelow.has(cache.nodeById.get('b')), true);
  assert.equal(cache.errorBelow.has(cache.nodeById.get('d')), false);
  assert.equal(cache.orphanCount, 1);
  assert.deepEqual(cache.bounds, { start: 0, end: 1000, duration: 1000 });
  assert.equal(cache.serviceCount, 1);
  assert.equal(cache.maxLevel, 2);
  assert.deepEqual(m.traceBounds([]), { start: 0, end: 1, duration: 1 });
});

test('the critical path follows the child that finishes last, and a consumer of a producer does not block it', () => {
  const cache = m.createTraceCache({ trace_id: 't', spans: [
    span('root', '', 0, 100), span('quick', 'root', 10, 20), span('slow', 'root', 20, 70),
  ] });
  const node = (id) => cache.nodeById.get(id);
  const sections = (id) => m.criticalSectionsFor(cache, node(id), false);
  assert.deepEqual(sections('slow'), [{ start: 20, end: 90 }]);
  assert.deepEqual(sections('quick'), []);
  // The sections of a span, in the order that the walk found them: compared by start.
  assert.deepEqual(sections('root').sort((a, b) => a.start - b.start), [{ start: 0, end: 20 }, { start: 90, end: 100 }]);
  const blocked = m.createTraceCache({ trace_id: 't', spans: [
    span('p', '', 0, 100, { span_kind: 'Producer' }), span('c', 'p', 10, 200, { span_kind: 'Consumer' }),
  ] });
  assert.deepEqual(m.criticalSectionsFor(blocked, blocked.nodeById.get('c'), false), []);
  // A collapsed span shows the sections of its whole subtree, merged.
  assert.deepEqual(m.criticalSectionsFor(cache, node('root'), true), [{ start: 0, end: 100 }]);
});

test('a timestamp is read as nanoseconds whatever its form, and a start as milliseconds', () => {
  assert.equal(m.timestampToNs('1700000000123456789'), 1700000000123456789);
  assert.equal(m.timestampToNs(1700000000123), 1700000000123e6);
  assert.equal(m.timestampToNs('2026-09-12 16:29:57.123456789'), Date.UTC(2026, 8, 12, 16, 29, 57, 123) * 1e6 + 456789);
  assert.equal(Number.isNaN(m.timestampToNs('')), true);
  assert.equal(Number.isNaN(m.timestampToNs('not a time')), true);
  assert.equal(m.parseStartMs('2026-09-12 16:29:57'), Date.UTC(2026, 8, 12, 16, 29, 57));
  assert.equal(m.parseStartMs(1700000000123), 1700000000123);
});

test('the duration axis takes round steps and a distinct label for each tick', () => {
  const axis = m.durationAxis(1200, 54000, 6);
  assert.ok(axis.axisMax > axis.axisMin);
  assert.equal(new Set(axis.values.map((tick) => tick.label)).size, axis.values.length);
  const flat = m.durationAxis(5e6, 5e6);
  assert.ok(flat.axisMax > flat.axisMin, 'a flat series still has a range');
  const ticks = m.durationTicks(1e9, 5);
  assert.equal(ticks.length >= 2, true);
  assert.equal(ticks[0].ns, 0);
  assert.equal(ticks[ticks.length - 1].ns, 1e9);
});

test('traces sort by a column in both directions, ties keep the newest first', () => {
  const rows = [
    { trace_id: 'b', root_service: 'api', root_operation: 'GET', duration_ns: 5, span_count: 3, error_count: 0, start_ms: 10, service_stats: [{}] },
    { trace_id: 'a', root_service: 'api', root_operation: 'GET', duration_ns: 5, span_count: 9, error_count: 1, start_ms: 20, service_stats: [{}, {}] },
    { trace_id: 'c', root_service: 'web', root_operation: 'POST', duration_ns: 1, span_count: 1, error_count: 0, start_ms: 5, service_stats: [] },
  ];
  const ids = (key, dir) => m.sortTraces(rows.slice(), { key, dir }).map((row) => row.trace_id);
  assert.deepEqual(ids('duration', 'desc'), ['a', 'b', 'c']);
  assert.deepEqual(ids('duration', 'asc'), ['c', 'a', 'b']);
  assert.deepEqual(ids('name', 'asc'), ['a', 'b', 'c']);
  assert.deepEqual(ids('spans', 'desc'), ['a', 'b', 'c']);
  assert.deepEqual(ids('start', 'asc'), ['c', 'b', 'a']);
  assert.deepEqual(m.LIST_SORTS.recent, { key: 'start', dir: 'desc' });
  assert.equal(m.TABLE_COLUMNS.length, 6);
  assert.deepEqual(m.orderByFirstSpan([{ service: 'b', first_span_ns: 5 }, { service: 'a', first_span_ns: 5 }, { service: 'z', first_span_ns: 1 }]).map((s) => s.service), ['z', 'a', 'b']);
});

test('the events and links of a span are data, ordered by time; a span is linked from the spans of its trace that link to it', () => {
  const holder = { span_id: 's1', events_timestamp: '["2026-09-12 16:29:58","2026-09-12 16:29:57"]', events_name: '["second","first"]', events_attributes: '[{"a":1},null]',
    links_trace_id: '["t"]', links_span_id: '["s2"]', links_attributes: '[{"k":"v"}]' };
  const events = m.spanEventList(holder);
  assert.deepEqual(events.map((event) => event.name), ['first', 'second']);
  assert.equal(events[1].attributes.a, 1);
  assert.deepEqual(m.spanLinkList(holder).map((link) => [link.traceId, link.spanId]), [['t', 's2']]);
  const cache = m.createTraceCache({ trace_id: 't', spans: [holder, span('s2', '', 0, 1)] });
  assert.deepEqual(m.linkedFromList(cache, cache.spans[1]).map((link) => link.spanId), ['s1']);
  assert.deepEqual(m.linkedFromList(cache, cache.spans[0]), []);
  assert.deepEqual(m.attributeEntries('{"b":1,"a":2}').map(([key]) => key), ['a', 'b']);
  assert.deepEqual(m.attributeEntries('[1]'), []);
  assert.equal(m.parseStructuredValue('not json'), null);
});

test('Copy trace JSON restores the exact nanoseconds of start_ns that a double lost', () => {
  const trace = { trace_id: 't', truncated: false, spans: [
    { trace_id: 't', span_id: 'b', start_ns: 1700000000123456800, timestamp: '2023-11-14 22:13:20.123456789', duration_ns: 1, span_attributes: '{"k":"v"}' },
    { trace_id: 't', span_id: 'a', start_ns: 5, timestamp: '2023-11-14 22:13:20.000000005', duration_ns: 2, events_name: '["e"]', events_timestamp: '["2023-11-14 22:13:20.000000007"]', events_attributes: '[{"x":1}]' },
  ] };
  const text = m.traceJsonText(trace);
  assert.match(text, /"start_ns": 1700000000123456789,/);
  const parsed = JSON.parse(text.replace(/"start_ns": 1700000000123456789/, '"start_ns": "big"'));
  assert.deepEqual(parsed.spans.map((s) => s.span_id), ['a', 'b']);
  assert.deepEqual(parsed.spans[0].events, [{ timestamp: '2023-11-14 22:13:20.000000007', name: 'e', attributes: { x: 1 } }]);
  assert.deepEqual(parsed.spans[1].span_attributes, { k: 'v' });
  assert.equal(parsed.span_count, 2);
});

test('the answer of the analytics is unpacked with defaults, and the durations of the last answer stay when the new one has none', () => {
  const first = m.unpackAnalytics({ range: [1, 2], bucket_ms: 1000, charts: ['counts', 'durations'], duration_quantiles: [[1, 2, 3]], trace_count_chart: [[0, 1]] });
  assert.deepEqual(first.range, [1, 2]);
  assert.equal(first.has_durations, true);
  const next = m.unpackAnalytics({ charts: ['counts'], trace_count_chart: [[0, 9]] }, first);
  assert.equal(next.has_durations, false);
  assert.deepEqual(next.duration_quantiles, [[1, 2, 3]]);
  assert.equal(next.bucket_ms, 60000);
  const grid = m.bucketGrid([[1000, 5], [3000, 7]], 1000, NaN);
  assert.equal(grid.starts.length, 3);
  assert.deepEqual(Array.from(grid.slot), [0, 2]);
});
