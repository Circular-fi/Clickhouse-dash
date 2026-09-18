const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: { ChDash: {} } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../src/static/app_pipeline_viewer.js'), 'utf8'), context);
const build = context.window.ChDash.pipelineViewer.buildModel;
const processor = (id, step, extra = {}) => ({
  hostname: 'h', query_id: 'q', id: String(id), plan_step: String(step),
  parent_ids: [], name: 'ExpressionTransform', elapsed_us: 1000,
  input_rows: 100, output_rows: 100, input_bytes: 800, output_bytes: 800, ...extra,
});
const summary = (operation, start, finish, extra = {}) => ({
  hostname: 'h', trace_id: 't', query_id: 'q', parent_span_id: 'root',
  operation_name: operation, first_start_time_us: start, last_finish_time_us: finish,
  active_time_us: 1000, event_count: 10, ...extra,
});
const stage = (model, step, query = 'q', host = 'h') => model.groups.find((group) =>
  group.planStep === String(step) && group.queryId === query && group.hostname === host);

test('parallel lanes are summed once at stage boundaries', () => {
  const model = build({ processors: [
    processor(1, 1, { parent_ids: ['3'] }), processor(2, 1, { parent_ids: ['4'] }),
    processor(3, 1, { output_rows: 10 }), processor(4, 1, { output_rows: 20 }),
  ] });
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].inputRows, 200);
  assert.equal(model.groups[0].outputRows, 30);
  assert.equal(model.groups[0].inputBytes, 1600);
  assert.equal(model.groups[0].elapsedSum, 4000);
});

test('UInt64 processor and step identities remain distinct beyond 2^53', () => {
  const model = build({ processors: [
    processor('9007199254740992', '9007199254740992', { parent_ids: ['9007199254740993'] }),
    processor('9007199254740993', '9007199254740993'),
  ] });
  assert.equal(model.groups.length, 2);
  assert.equal(model.groups[0].downstream.size, 1);
  assert.equal(model.groups[1].upstream.size, 1);
});

test('reused processor IDs cannot connect different query attempts or hosts', () => {
  const processors = [];
  for (const query_id of ['q', 'retry']) for (const hostname of ['h', 'other']) {
    processors.push(processor(1, 1, { query_id, hostname, parent_ids: ['2'] }));
    processors.push(processor(2, 2, { query_id, hostname }));
  }
  const model = build({ processors });
  assert.equal(model.groups.length, 8);
  for (const group of model.groups) for (const key of group.downstream) {
    const target = model.groups.find((candidate) => candidate.key === key);
    assert.equal(target.hostname, group.hostname);
    assert.equal(target.queryId, group.queryId);
  }
});

test('trace ownership uses query_id when an earlier attempt has no trace', () => {
  const model = build({
    processors: [processor(1, 1, { query_id: 'first' }), processor(1, 1, { query_id: 'retry' })],
    attemptIds: ['first', 'retry'], processorTraceSummary: [
      summary('TCPHandler', 1000, 9000, { query_id: 'retry' }),
      summary('ExpressionTransform_0', 2000, 8000, { query_id: '' }),
    ],
  });
  assert.equal(stage(model, 1, 'first').segments.length, 0);
  assert.equal(stage(model, 1, 'retry').segments[0].start, 2000);
});

test('legacy traces without ownership do not guess the attempt by timestamp order', () => {
  const model = build({
    processors: [processor(1, 1, { query_id: 'a' }), processor(1, 1, { query_id: 'b' })],
    processorTraceSummary: [summary('ExpressionTransform_0', 1000, 2000, { query_id: '' })],
  });
  assert.equal(model.tracedCount, 0);
  assert.equal(model.finish, 2000);
});

test('duplicate names with distinct costs get separate measured envelopes and estimated associations', () => {
  const model = build({
    processors: [processor(1, 1, { elapsed_us: 1000 }), processor(2, 2, { elapsed_us: 8000 })],
    processorTraceSummary: [
      summary('ExpressionTransform_1', 8000, 9000, { parent_span_id: 'left' }),
      summary('ExpressionTransform_2', 1000, 7000, { active_time_us: 8000, parent_span_id: 'right' }),
    ],
  });
  assert.equal(stage(model, 1).segments[0].start, 8000);
  assert.equal(stage(model, 2).segments[0].start, 1000);
  assert.equal(model.estimatedCount, 2);
});

test('equal costs across stages stay ambiguous instead of being assigned arbitrarily', () => {
  const model = build({
    processors: [processor(1, 1), processor(2, 2)],
    processorTraceSummary: [summary('ExpressionTransform_1', 1000, 2000)],
  });
  assert.equal(model.tracedCount, 0);
  assert.equal(model.unmatched, 1);
});

test('unrelated cost does not force a match to the busiest stage', () => {
  const model = build({
    processors: [processor(1, 1), processor(2, 2, { elapsed_us: 8000 })],
    processorTraceSummary: [summary('ExpressionTransform_1', 1000, 2000, { active_time_us: 1000000 })],
  });
  assert.equal(model.tracedCount, 0);
});

test('near-equal competing stages remain ambiguous beyond same-stage cost neighbors', () => {
  const model = build({
    processors: [
      processor(1, 1), processor(2, 1, { elapsed_us: 1001 }),
      processor(3, 1, { elapsed_us: 1002 }), processor(4, 2, { elapsed_us: 1010 }),
    ],
    processorTraceSummary: [summary('ExpressionTransform_1', 1000, 2000)],
  });
  assert.equal(model.tracedCount, 0);
  assert.equal(model.unmatched, 1);
});

test('partial summary coverage still permits detail fallback for another unique family', () => {
  const model = build({
    processors: [processor(1, 1), processor(2, 2, { name: 'LimitTransform' })],
    processorTraceSummary: [summary('ExpressionTransform_1', 1000, 4000)],
    spans: [{ hostname: 'h', query_id: 'q', trace_id: 't', operation_name: 'LimitTransform_2', start_time_us: 3000, finish_time_us: 3500 }],
  });
  assert.equal(model.tracedCount, 2);
  assert.equal(stage(model, 2).segments[0].start, 3000);
});

test('full trace summary retains late stages beyond the detailed span limit', () => {
  const model = build({
    processors: [processor(1, 1)],
    processorTraceSummary: [summary('ExpressionTransform_0', 1000, 9000000)],
    spans: [{ trace_id: 't', operation_name: 'ExpressionTransform_0', start_time_us: 1000, finish_time_us: 2000 }],
  });
  assert.equal(model.finish, 9000000);
  assert.equal(model.groups[0].segments[0].finish, 9000000);
});

test('bucketed summary preserves idle gaps while matching on total active work', () => {
  const model = build({
    processors: [processor(1, 1, { elapsed_us: 1000 })],
    summaryBucketUs: 1000,
    processorTraceSummary: [
      summary('ExpressionTransform_0', 1000, 1200, { active_time_us: 400, event_count: 4 }),
      summary('ExpressionTransform_0', 5000, 5300, { active_time_us: 600, event_count: 6 }),
    ],
  });
  const group = stage(model, 1);
  assert.equal(group.segments.length, 2);
  assert.equal(group.segments[0].start, 1000);
  assert.equal(group.segments[0].finish, 1200);
  assert.equal(group.segments[1].start, 5000);
  assert.equal(group.segments[1].finish, 5300);
  assert.equal(group.traceActiveUs, 1000);
  assert.equal(group.traceEventCount, 10);
  assert.equal(group.segments[0].density, 2);
  assert.equal(group.segments[1].density, 2);
  assert.equal(model.start, 1000);
  assert.equal(model.finish, 5300);
});

test('waiting-only processors are retained without subtracting waits from active work', () => {
  const model = build({ processors: [processor(1, 1, {
    elapsed_us: 0, input_rows: 0, output_rows: 0, input_bytes: 0, output_bytes: 0,
    input_wait_elapsed_us: 5000000,
  }), processor(2, 2)] });
  assert.equal(model.groups.length, 2);
  assert.equal(stage(model, 1).elapsedSum, 0);
  assert.equal(stage(model, 1).inputWaitMax, 5000000);
});

test('unowned output processors do not collapse into one false logical stage', () => {
  const model = build({ processors: [processor(1, 0), processor(2, 0, { name: 'LazyOutputFormat' })] });
  assert.equal(model.groups.length, 2);
});

test('unsafe old numeric IDs do not create rounded graph links', () => {
  const model = build({ processors: [processor(9007199254740992, 1, {
    id: 9007199254740992, parent_ids: ['2'],
  }), processor(2, 2)] });
  assert.equal(model.invalidIdentities, 1);
  assert.equal(stage(model, 1).downstream.size, 0);
  assert.equal(stage(model, 1).flowApproximate, true);
});

test('truncated or mixed stage boundaries are visibly approximate', () => {
  const model = build({ processorsTruncated: true, processors: [processor(1, 1)] });
  assert.equal(model.groups[0].flowApproximate, true);
  const mixed = build({ processors: [
    processor(1, 1, { parent_ids: ['2', '3'] }), processor(2, 1), processor(3, 2),
  ] });
  assert.equal(stage(mixed, 1).flowApproximate, true);
});

test('cyclic stage graphs terminate and retain all stages', () => {
  const model = build({ processors: [processor(1, 1, { parent_ids: ['2'] }), processor(2, 2, { parent_ids: ['1'] })] });
  assert.equal(model.cyclic, true);
  assert.equal(model.groups.length, 2);
});

test('empty profiling remains a valid empty model', () => {
  const model = build();
  assert.equal(model.groups.length, 0);
  assert.equal(model.start, 0);
  assert.equal(model.finish, 0);
});


test('numbered processor instances merge for unowned plan step zero', () => {
  const model = build({ processors: [
    processor(1, 0, { name: 'Resize_0' }),
    processor(2, 0, { name: 'Resize_1' }),
  ] });
  assert.equal(model.groups.length, 1);
  assert.equal(model.groups[0].lanes, 2);
  assert.deepEqual(Array.from(model.groups[0].processorNames), ['Resize']);
});

test('numbered summary operations merge before stage timing association', () => {
  const model = build({
    processors: [processor(1, 1, { name: 'ExpressionTransform', elapsed_us: 2000 })],
    summaryBucketUs: 1000,
    processorTraceSummary: [
      summary('ExpressionTransform_0', 1000, 1500, { active_time_us: 1000, event_count: 1 }),
      summary('ExpressionTransform_1', 1600, 1900, { active_time_us: 1000, event_count: 1 }),
    ],
  });
  const group = stage(model, 1);
  assert.equal(group.traceActiveUs, 2000);
  assert.deepEqual(Array.from(group.traceOperations), ['ExpressionTransform']);
});

test('configured maximum processor and summary counts remain bounded', () => {
  const processors = Array.from({ length: 10000 }, (_, i) => processor(i + 1, i + 1, { elapsed_us: i + 100 }));
  const processorTraceSummary = Array.from({ length: 65536 }, (_, i) => summary(
    `ExpressionTransform_${i}`, 1000 + i, 2000 + i, { active_time_us: i + 100 },
  ));
  const start = performance.now();
  const model = build({ processors, processorTraceSummary });
  assert.equal(model.groups.length, 10000);
  assert.equal(model.finish, 67535);
  assert.ok(model.tracedCount <= processors.length);
  console.log(`Maximum model: ${Math.round(performance.now() - start)} ms`);
});

const { projectActivity, selectWindow } = context.window.ChDash.pipelineViewer;

test('legacy envelopes are never projected as continuous activity', () => {
  const model = build({ processors: [processor(1, 1)],
    processorTraceSummary: [summary('ExpressionTransform_0', 1000, 9000000)] });
  assert.equal(model.envelopeCount, 1);
  assert.equal(model.groups[0].segments[0].envelope, true);
  assert.equal(projectActivity(model.groups[0].segments, model.start, model.finish).length, 0);
  assert.equal(model.totalWorkUs, 1000);
});

test('projected summary density conserves work and keeps separated windows apart', () => {
  const segments = [
    { start: 1000, finish: 2000, density: 0.2, bucketed: true },
    { start: 8000, finish: 10000, density: 2, bucketed: true },
  ];
  const cells = projectActivity(segments, 0, 10000, 100);
  assert.equal(cells.reduce((sum, cell) => sum + cell.workUs, 0), 4200);
  assert.ok(cells.every(cell => cell.finish <= 2000 || cell.start >= 8000));
  assert.equal(cells[0].density, 0.2);
  assert.equal(cells.at(-1).density, 2);
  assert.ok(cells.length <= 100);
});

test('zoom clips activity without moving it or including windows outside the view', () => {
  const segments = [{ start: 1000, finish: 3000, density: 0.5, bucketed: true },
    { start: 5000, finish: 6000, density: 1, bucketed: true }];
  const cells = projectActivity(segments, 2000, 4000, 20);
  assert.equal(cells.reduce((sum, cell) => sum + cell.workUs, 0), 500);
  assert.ok(cells.every(cell => cell.start >= 2000 && cell.finish <= 3000));
  assert.equal(projectActivity(segments, 3500, 4500).length, 0);
});

test('overlapping work remains additive while zero-duration events stay visible', () => {
  const cells = projectActivity([
    { start: 1000, finish: 2000, density: 1, bucketed: true },
    { start: 1500, finish: 2500, density: 2, bucketed: true },
    { start: 3000, finish: 3000, detail: true },
  ], 1000, 3000, 20);
  assert.equal(cells.reduce((sum, cell) => sum + cell.workUs, 0), 3000);
  assert.equal(cells.find(cell => cell.start === 1500).density, 3);
  assert.equal(cells.at(-1).start, 3000);
  assert.equal(cells.at(-1).workUs, 0);
});

test('work shares use total work, including stages without attributable timing', () => {
  const model = build({ processors: [processor(1, 1, { elapsed_us: 300 }),
    processor(2, 2, { elapsed_us: 700 }), processor(3, 3, { elapsed_us: 0 })] });
  assert.equal(model.totalWorkUs, 1000);
  assert.deepEqual(Array.from(model.groups, g => g.workShare), [0.3, 0.7, 0]);
  assert.equal(model.tracedCount, 0);
  const zero = build({ processors: [processor(1, 1, { elapsed_us: 0 })] });
  assert.equal(zero.groups[0].workShare, 0);
});

test('timeline navigation clamps at both ends and preserves the zoom width', () => {
  const model = { window: 1000 };
  assert.deepEqual({ ...selectWindow(model, -100, 100) }, { start: 0, finish: 200, width: 200 });
  assert.deepEqual({ ...selectWindow(model, 900, 1100) }, { start: 800, finish: 1000, width: 200 });
  assert.deepEqual({ ...selectWindow(model, 0, 2000) }, { start: 0, finish: 1000, width: 1000 });
  assert.equal(selectWindow(model, 500, 500).width, 1);
});
