const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// api.request (app_api.js): the one request path of every call, with the real app_util.js and app_state.js behind it and a fake fetch. What it
// promises the pages: an answer that is not JSON fails closed (a proxy or a wrong subpath answers a shell), an HTTP error keeps its status and
// its body, a network failure is told from the caller's abort and from a timeout, and only a dead server turns the online flag off.
// Objects made inside the vm are of another realm: compare them as JSON.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let api;
let state;
let fetchImpl;
let calls;
let window;

function response(status, text, contentType = 'application/json') {
  return { status, ok: status >= 200 && status < 300, headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) }, text: async () => text };
}

// A fetch that never answers and ends with AbortError when its signal is aborted.
function hanging(url, init) {
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

test.before(async () => {
  window = { sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, dispatchEvent() {} };
  const run = await esm.load({
    root,
    window,
    globals: { AbortController, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, fetch: (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); } },
  });
  ({ api } = await run.import('app_api.js'));
  ({ state } = await run.import('app_state.js'));
});

test.beforeEach(() => {
  calls = [];
  state.apiOnline = true;
  delete window.__chdashUrl;
  delete window.__CHDASH_BASE_PATH__;
});

test('an answer that is not JSON fails closed with the code invalid_api_response and a hint about the routing', async () => {
  fetchImpl = async () => response(200, `<!doctype html><title>shell</title>${'x'.repeat(500)}`, 'text/html');
  await assert.rejects(api.getVersion(), (error) => {
    assert.equal(error.code, 'invalid_api_response');
    assert.match(error.message, /non-JSON response \(text\/html\)/);
    assert.match(error.message, /subpath routing/);
    assert.equal(error.responseText.length, 240, 'the text kept for the error is cut');
    return true;
  });
  assert.equal(state.apiOnline, true, 'a server that answered is online');
});

test('an HTTP error keeps its status and the answer as sent, and an HTML page of a proxy is a status, not a JSON error', async () => {
  fetchImpl = async () => response(409, JSON.stringify({ error_code: 'conflict', message: 'Revision changed.', current: 7 }));
  await assert.rejects(api.getVersion(), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'conflict');
    assert.equal(error.body.current, 7);
    return true;
  });
  fetchImpl = async () => response(502, '<html>Bad gateway</html>', 'text/html');
  await assert.rejects(api.getVersion(), (error) => {
    assert.equal(error.status, 502);
    assert.notEqual(error.code, 'invalid_api_response');
    assert.deepEqual(error.body, { text: '<html>Bad gateway</html>' });
    return true;
  });
  assert.equal(state.apiOnline, false, 'a 5xx with no JSON of ours is a proxy in front of a stopped server');
});

test('a 5xx with the JSON of the application is a server that answers: the flag stays on', async () => {
  fetchImpl = async () => response(503, JSON.stringify({ error_code: 'runner_unavailable', message: 'down' }));
  await assert.rejects(api.getVersion(), (error) => error.status === 503 && error.code === 'runner_unavailable');
  assert.equal(state.apiOnline, true);
});

test('a network failure is a network_error and turns the online flag off; the next answer turns it on', async () => {
  fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api.getVersion(), (error) => error.code === 'network_error');
  assert.equal(state.apiOnline, false);
  fetchImpl = async () => response(200, '{"name":"clickhouse-dash"}');
  assert.deepEqual(await api.getVersion(), { name: 'clickhouse-dash' });
  assert.equal(state.apiOnline, true);
});

test('a request that gets no answer in time is a timeout and does not turn the flag off', async () => {
  fetchImpl = hanging;
  await assert.rejects(api.request('api/slow', { timeoutMs: 20 }), (error) => error.code === 'timeout' && error.name === 'TimeoutError');
  assert.equal(state.apiOnline, true);
});

test('a request that the caller aborts is an abort: no network error, no offline flag, and a signal that is already aborted never reaches fetch', async () => {
  fetchImpl = hanging;
  const controller = new AbortController();
  const pending = api.request('api/slow', { signal: controller.signal, timeoutMs: 0 });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted' && error.name === 'AbortError');
  assert.equal(state.apiOnline, true);
  const before = calls.length;
  await assert.rejects(api.request('api/slow', { signal: controller.signal }), (error) => error.code === 'aborted');
  assert.equal(calls.length, before);
});

test('an address is resolved under the mount path of the page, and an absolute address is left alone', async () => {
  fetchImpl = async () => response(200, '{}');
  window.__CHDASH_BASE_PATH__ = '/dash/';
  await api.request('/api/version');
  window.__chdashUrl = (raw) => `/proxy/${raw}`;
  await api.request('api/hosts');
  await api.request('https://example.test/x');
  assert.deepEqual(calls.map((call) => call.url), ['/dash/api/version', '/proxy/api/hosts', 'https://example.test/x']);
  assert.equal(calls[0].init.cache, 'no-store');
});

test('a body is sent as JSON with its content type, and a GET sends none', async () => {
  fetchImpl = async () => response(200, '{}');
  await api.request('api/x', { method: 'POST', body: { a: 1 }, headers: { 'If-Match': '3' } });
  await api.request('api/y');
  assert.equal(calls[0].init.body, '{"a":1}');
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', 'If-Match': '3' });
  assert.equal(calls[1].init.body, undefined);
  assert.deepEqual(calls[1].init.headers, {});
});
