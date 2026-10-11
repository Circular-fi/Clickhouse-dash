const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// app_util.js in a bare vm, with the real app_format.js behind it: the error texts, the superseded-request token, the
// debounce and the escaping that every page relies on.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let util;

test.before(async () => {
  const run = await esm.load({ root, globals: { AbortController, Event, clearTimeout, setTimeout } });
  util = (await run.import('app_util.js')).util;
});

test('escapeHtml escapes the five characters that open an attribute or a tag, and only them', () => {
  assert.equal(util.escapeHtml(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
  assert.equal(util.escapeHtml(12), '12');
  assert.equal(util.escapeHtml('plain text'), 'plain text');
});

test('the number formats keep "-" for a missing value and hand the rest to the shared formats', () => {
  assert.equal(util.formatInt(1234567), '1,234,567');
  assert.equal(util.formatInt('1234.9'), '1,234');
  assert.equal(util.formatInt(undefined), '-');
  assert.equal(util.formatInt('abc'), '-');
  assert.equal(util.formatBytes(1536), '1.5 KB');
  assert.equal(util.formatBytes(NaN), '-');
  assert.equal(util.formatSeconds(0.25), '250ms');
  assert.equal(util.formatSeconds(2.5), '2.500s');
  assert.equal(util.formatSeconds(25), '25.00s');
  assert.equal(util.formatSeconds(Infinity), '-');
});

test('latest: a newer request aborts the older one and makes it stale, a cancel aborts the current one', () => {
  const first = util.latest('unit.a');
  assert.equal(first.isCurrent(), true);
  const second = util.latest('unit.a');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
  util.latest.cancel('unit.a');
  assert.equal(second.signal.aborted, true);
  assert.equal(second.isCurrent(), false);
  // Another key is another slot.
  const other = util.latest('unit.b');
  const again = util.latest('unit.a');
  assert.equal(other.isCurrent(), true);
  assert.equal(again.isCurrent(), true);
});

test('latest.cancelPrefix aborts every slot of a module and leaves the others', () => {
  const traces = [util.latest('traces.search'), util.latest('traces.facets')];
  const logs = util.latest('logs.search');
  util.latest.cancelPrefix('traces.');
  assert.deepEqual(traces.map((token) => token.signal.aborted), [true, true]);
  assert.deepEqual(traces.map((token) => token.isCurrent()), [false, false]);
  assert.equal(logs.signal.aborted, false);
  assert.equal(logs.isCurrent(), true);
  util.latest.cancel('logs.search');
});

test('isAbort tells an aborted request from a failure', () => {
  assert.equal(util.isAbort({ name: 'AbortError' }), true);
  assert.equal(util.isAbort({ code: 'aborted' }), true);
  assert.equal(util.isAbort(new Error('boom')), false);
  assert.equal(util.isAbort(null), false);
});

test('errorText gives the sentence of the server without its code, our sentence for a network failure, else the fallback', () => {
  assert.equal(util.errorText({ code: 'network_error' }), 'The server could not be reached. Check the connection and retry.');
  assert.equal(util.errorText({ payload: { error_code: 'invalid_api_response' } }), 'The server sent an unexpected response. Retry, or reload the page.');
  assert.equal(util.errorText(Object.assign(new Error('query_failed: Table x does not exist'), { code: 'query_failed' })), 'Table x does not exist');
  assert.equal(util.errorText(new Error('bad_range: from is after to')), 'from is after to');
  assert.equal(util.errorText({ payload: { error_code: 'bad_range', message: 'bad_range: from is after to' }, code: 'bad_range' }), 'from is after to');
  assert.equal(util.errorText({ payload: { message: 'Not found' } }), 'Not found');
  assert.equal(util.errorText(null, 'Nothing came back.'), 'Nothing came back.');
  assert.equal(util.errorText(null), 'The request failed.');
});

test('queryErrorParts strips the prefixes of the server and the formatter, and splits a syntax error, the expected list and the trace', () => {
  const syntax = util.queryErrorParts('query_failed: Code: 62. DB::Exception: Syntax error: failed at position 8 (FROM) (line 1, col 8): FROM t. Expected one of: list of elements, WITH. (SYNTAX_ERROR) (version 26.7.5.10)');
  assert.equal(syntax.name, 'SYNTAX_ERROR');
  assert.equal(syntax.summary, 'Syntax error, line 1 col 8 near FROM');
  assert.equal(syntax.expected, 'list of elements, WITH');
  assert.equal(util.queryErrorParts('Syntax error: failed at position 3', { line: 2, col: 4, near: 'end of query' }).summary, 'Syntax error, line 2 col 4 at the end of the query');
  assert.equal(util.queryErrorParts('Syntax error: failed at position 3').summary, 'Syntax error, position 3');
  const executing = util.queryErrorParts("Code: 395. DB::Exception: Value passed to 'throwIf' function is non-zero: while executing 'FUNCTION throwIf(1 :: 0) -> throwIf(1)'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)");
  assert.equal(executing.summary, "Value passed to 'throwIf' function is non-zero");
  assert.equal(executing.trace, "while executing 'FUNCTION throwIf(1 :: 0) -> throwIf(1)'");
  assert.equal(executing.name, 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO');
  const served = util.queryErrorParts('DB::Exception: Syntax error: failed at position 13 (t): t. Expected one of: Comma, FROM, end of query', { line: 1, col: 13, near: 't' });
  assert.deepEqual(served, { summary: 'Syntax error, line 1 col 13 near t', expected: 'Comma, FROM, end of query', trace: '', name: '' });
  assert.equal(util.queryErrorParts('').summary, 'The query failed.');
  assert.equal(util.queryErrorParts(null).summary, 'The query failed.');
});

test('the API error payload is normalised: a code and a message always, the optional fields only when they are valid', () => {
  assert.deepEqual(util.normalizeApiErrorPayload(null, {}), { error_code: 'http_error', message: 'Request failed.' });
  assert.deepEqual(util.normalizeApiErrorPayload({ error_code: 'x', message: 'm', index: '2', query_id: 'q1', clickhouse: { code: '62', line: 1, col: 2, near: 'FROM', position: 7, junk: 1 } }),
    { error_code: 'x', message: 'm', index: 2, query_id: 'q1', clickhouse: { code: 62, position: 7, line: 1, col: 2, near: 'FROM' } });
  assert.deepEqual(util.normalizeApiErrorPayload({ message: 'm', index: 'nope', query_id: '', clickhouse: { code: 'nope' } }, { error_code: 'fallback' }),
    { error_code: 'fallback', message: 'm' });
  assert.equal(util.buildApiErrorText({ error_code: 'query_failed', message: 'boom' }), 'query_failed: boom');
  assert.equal(util.buildApiErrorText({ error_code: 'query_failed', message: 'query_failed: boom' }), 'query_failed: boom');
  assert.equal(util.buildApiErrorText(null, 'Offline'), 'http_error: Offline');
  assert.deepEqual(util.buildApiErrorFromResponse(503, null), { error_code: 'http_error', message: 'Request failed with status 503' });
  assert.deepEqual(util.buildApiErrorFromResponse('x', { error_code: 'server_busy', message: 'busy' }), { error_code: 'server_busy', message: 'busy' });
});

test('debounce runs the last call once after the delay; cancel drops it and flush runs it now', async () => {
  const calls = [];
  const run = util.debounce((value) => calls.push(value), 15);
  run(1); run(2); run(3);
  assert.deepEqual(calls, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, [3]);
  run(4);
  run.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, [3]);
  run(5);
  run.flush();
  assert.deepEqual(calls, [3, 5]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(calls, [3, 5], 'a flushed call does not run again');
});
