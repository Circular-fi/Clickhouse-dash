const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
let build;
// The real modules in a bare context (tests/harness/esm_vm.js); run with node --experimental-vm-modules.
test.before(async () => {
  // The page's DOM and components are stubs: the models under test are pure (the rest of the graph is real).
  const run = await esm.load({ root, stubs: {
    'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null } },
    'app_ui_icon.js': {}, 'app_ui_segmented.js': {}, 'app_ui_state.js': {},
  } });
  const modules = {};
  for (const file of ['app_trace_viewer.js']) Object.assign(modules, await run.import(file));
  build = modules.traceViewer.buildModel;
});

const span = (span_id, parent_span_id, operation_name, start_time_us, finish_time_us) => ({
  hostname: 'h', trace_id: 't', span_id, parent_span_id, operation_name,
  start_time_us, finish_time_us,
});

test('trailing numeric instance suffixes are removed repeatedly', () => {
  const model = build([
    span('a', '0', 'ExpressionTransform_12_3', 1000, 1200),
    span('b', '0', 'ExpressionTransform_worker12', 2000, 2200),
  ]);
  assert.equal(model.roots[0].operation, 'ExpressionTransform');
  assert.equal(model.roots[1].operation, 'ExpressionTransform_worker12');
});

test('same-parent numbered siblings merge recursively and keep all activity windows', () => {
  const model = build([
    span('root', '0', 'PipelineExecutor', 1000, 9000),
    span('expr0', 'root', 'ExpressionTransform_0', 1200, 2000),
    span('expr1', 'root', 'ExpressionTransform_1', 5000, 6000),
    span('agg0', 'expr0', 'AggregatingTransform_0', 1400, 1800),
    span('agg1', 'expr1', 'AggregatingTransform_1', 5200, 5600),
  ]);

  assert.equal(model.roots.length, 1);
  const root = model.roots[0];
  assert.equal(root.children.length, 1);
  const expression = root.children[0];
  assert.equal(expression.operation, 'ExpressionTransform');
  assert.equal(expression.mergedCount, 2);
  assert.equal(expression.segments.length, 2);
  assert.equal(JSON.stringify(expression.segments.map((item) => [item.start, item.finish])), JSON.stringify([[1200, 2000], [5000, 6000]]));
  assert.equal(expression.children.length, 1);
  const aggregate = expression.children[0];
  assert.equal(aggregate.operation, 'AggregatingTransform');
  assert.equal(aggregate.mergedCount, 2);
  assert.equal(aggregate.segments.length, 2);
  assert.equal(model.spans.length, 3);
});

test('same normalized name under different parents stays separate', () => {
  const model = build([
    span('root', '0', 'PipelineExecutor', 1000, 9000),
    span('left', 'root', 'BranchLeft', 1200, 4000),
    span('right', 'root', 'BranchRight', 4500, 8000),
    span('expr0', 'left', 'ExpressionTransform_0', 1300, 2000),
    span('expr1', 'right', 'ExpressionTransform_1', 5000, 6000),
  ]);
  assert.equal(model.spans.filter((item) => item.operation === 'ExpressionTransform').length, 2);
});
