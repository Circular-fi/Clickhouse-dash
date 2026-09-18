const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const context = { window: { ChDash: {} } };
vm.createContext(context);
for (const name of ['app_analysis_data.js', 'app_pipeline_viewer.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../src/static', name), 'utf8'), context);
}
const { decodeProcessors } = context.window.ChDash.analysisData;
const { buildModel } = context.window.ChDash.pipelineViewer;
const plain = value => JSON.parse(JSON.stringify(value));
const modelSnapshot = value => JSON.parse(JSON.stringify(value, (key, item) =>
  key === 'processorRows' ? undefined : Object.prototype.toString.call(item) === '[object Set]' ? [...item].sort() : item));
const compact = () => ({ processors_compact: {
  format: 'chdash.processors.json.v1', strings: ['', 'h', 'q', '9007199254740993', '9007199254740994', '0', 'Expression', 't', 'root'],
  row_schema: ['hostname_ref','initial_query_id_ref','query_id_ref','id_ref','parent_id_refs','plan_step_ref','plan_step_name_ref','plan_step_description_ref','plan_group_ref','name_ref','elapsed_us','input_wait_elapsed_us','output_wait_elapsed_us','input_rows','input_bytes','output_rows','output_bytes'],
  rows: [[1,2,2,3,[4],3,6,0,5,6,17,100,20,10,80,10,80]],
  summary_origin_us: 1000000, summary_row_count: 2,
  summary_series_schema: ['hostname_ref','trace_id_ref','query_id_ref','parent_span_id_ref','operation_name_ref','windows'],
  summary_window_schema: ['start_offset_us','finish_offset_us','active_time_us','event_count'],
  summary_series: [[1,7,2,8,6,[0,10,7,1,30,50,10,2]]],
} });

test('positional rows preserve UInt64 graph identities and every counter', () => {
  const data = decodeProcessors(compact());
  assert.deepEqual(plain(data.processors[0]), {
    hostname:'h', initial_query_id:'q', query_id:'q', id:'9007199254740993', parent_ids:['9007199254740994'],
    plan_step:'9007199254740993', plan_step_name:'Expression', plan_step_description:'', plan_group:'0', name:'Expression',
    elapsed_us:17, input_wait_elapsed_us:100, output_wait_elapsed_us:20, input_rows:10, input_bytes:80, output_rows:10, output_bytes:80,
  });
});

test('summary iteration is repeatable, exact and does not retain expanded objects', () => {
  const { processorTraceSummary: rows } = decodeProcessors(compact());
  assert.equal(Array.isArray(rows), false);
  assert.equal(rows.length, 2);
  const first = [...rows];
  assert.deepEqual(plain(first), plain([...rows]));
  assert.notEqual(first[0], [...rows][0]);
  assert.equal(first[0].first_start_time_us, 1000000);
  assert.equal(first[1].last_finish_time_us, 1000050);
  assert.equal(first[1].active_time_us, 10);
  assert.equal(first[1].event_count, 2);
  const model = buildModel({ ...decodeProcessors(compact()), summaryBucketUs: 10 });
  assert.equal(model.groups[0].segments.length, 2);
  assert.equal(model.groups[0].traceActiveUs, 17);
});

test('large counters and timestamp origins round-trip as exact decimal strings', () => {
  const payload = compact();
  payload.processors_compact.rows[0][14] = '18446744073709551615';
  payload.processors_compact.summary_origin_us = '9007199254740993';
  const decoded = decodeProcessors(payload);
  assert.equal(decoded.processors[0].input_bytes, '18446744073709551615');
  assert.equal([...decoded.processorTraceSummary][1].last_finish_time_us, '9007199254741043');
});

test('legacy object payloads remain usable without a compact block', () => {
  const processors = [{ id:'1', parent_ids:[], elapsed_us:10 }];
  const summary = [{ operation_name:'Expression', first_start_time_us:10, last_finish_time_us:20 }];
  const decoded = decodeProcessors({ processors, processor_trace_summary:summary });
  assert.equal(decoded.processors, processors);
  assert.equal(decoded.processorTraceSummary, summary);
  assert.equal(decodeProcessors({}).processors.length, 0);
});

test('an unsupported compact version fails explicitly despite legacy duplicates', () => {
  const payload = compact(); payload.processors_compact.format = 'chdash.processors.json.v99'; payload.processors = [];
  assert.throws(() => decodeProcessors(payload), /unsupported format/);
  assert.throws(() => decodeProcessors({ processors_compact:null }), /compact block must be an object/);
});

test('malformed compact schemas, references, windows and counts are rejected', () => {
  const mutations = [
    p => p.row_schema.reverse(), p => p.rows[0].pop(), p => p.rows[0][0] = 999,
    p => p.rows[0][4] = '1', p => p.rows[0][10] = -1,
    p => p.rows[0][10] = 9007199254740992, p => p.rows[0][10] = '18446744073709551616',
    p => p.summary_series[0][5].pop(), p => p.summary_series[0][5][0] = 20,
    p => p.summary_row_count = 3, p => p.strings[1] = 1,
    p => p.summary_origin_us = '18446744073709551615',
    p => p.rows = Array(10001).fill(p.rows[0]), p => p.summary_series = Array(65537).fill(p.summary_series[0]),
  ];
  for (const mutate of mutations) { const payload = compact(); mutate(payload.processors_compact); assert.throws(() => decodeProcessors(payload), /Invalid processor profiling data/); }
});

const driver = process.env.PROCESSOR_JSON_DRIVER;
function encode(payload) {
  const result = spawnSync(driver, [], { input:JSON.stringify(payload), encoding:'utf8', maxBuffer:64*1024*1024, timeout:30000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}
const processor = (i, extra = {}) => ({
  hostname:'host', initial_query_id:'query', query_id:'query', id:String(9000+i), parent_ids:[], plan_step:String(i),
  plan_step_name:'Expression', plan_step_description:'Tuple("é", array)\u0000tail', plan_group:'0', name:'Expression',
  elapsed_us:100, input_wait_elapsed_us:200, output_wait_elapsed_us:10, input_rows:1000, input_bytes:8000, output_rows:500, output_bytes:4000, ...extra,
});
const summary = (i, extra = {}) => ({
  hostname:'host', trace_id:'trace', query_id:'query', parent_span_id:'9007199254740993', operation_name:'Expression',
  first_start_time_us:1789693398087568+i*1000, last_finish_time_us:1789693398087618+i*1000, active_time_us:50, event_count:1, ...extra,
});
const sorted = rows => plain(rows).sort((a,b) => a.hostname.localeCompare(b.hostname) || a.query_id.localeCompare(b.query_id) || a.first_start_time_us-b.first_start_time_us);

test('real C++ encoder to JS decoder preserves scopes, fields, IDs and timing gaps', { skip:!driver }, () => {
  const original = { processors:[
    processor(1,{id:'9007199254740993',parent_ids:['9007199254740994']}),
    processor(2,{id:'9007199254740994',input_bytes:'18446744073709551615'}),
    processor(1,{hostname:'other',query_id:'retry',id:'9007199254740993'}),
  ], processor_trace_summary:[summary(0),summary(5),summary(1,{hostname:'other',query_id:'retry'})] };
  const decoded = decodeProcessors(encode(original));
  assert.deepEqual(plain(decoded.processors),original.processors);
  assert.deepEqual(sorted([...decoded.processorTraceSummary]),sorted(original.processor_trace_summary));
  const before = buildModel({ processors:original.processors,processorTraceSummary:original.processor_trace_summary,summaryBucketUs:100 });
  const after = buildModel({ ...decoded,summaryBucketUs:100 });
  assert.deepEqual(modelSnapshot(after),modelSnapshot(before));
  assert.deepEqual(plain(decodeProcessors(encode({processors:[],processor_trace_summary:[]})).processors),[]);
});

test('real codec preserves all rows at configured caps with bounded summary iteration', { skip:!driver }, () => {
  const original = { processors:Array.from({length:10000},(_,i)=>processor(i)),
    processor_trace_summary:Array.from({length:65536},(_,i)=>summary(i)) };
  const encoded = encode(original);
  const decoded = decodeProcessors(encoded);
  assert.equal(decoded.processors.length,10000);
  assert.equal(decoded.processorTraceSummary.length,65536);
  let count=0;let active=0;for(const row of decoded.processorTraceSummary){count++;active+=row.active_time_us;}
  assert.equal(count,65536);assert.equal(active,65536*50);
  assert.ok(JSON.stringify(encoded).length < JSON.stringify(original).length / 3);
});
