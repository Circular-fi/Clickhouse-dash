const test = require('node:test');
const strict = require('node:assert/strict');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The access part of /api/version in the page (app_state.js, docs/access.md "Hosts"): the actions that the user may use somewhere, the
// decisions on each visible host, and the hosts that the picker of each page shows. The real app_state.js runs in the vm.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
let features;

test.before(async () => {
  const window = { sessionStorage: esm.memoryStorage(), localStorage: esm.memoryStorage(), dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
  const run = await esm.load({ root, window, globals: { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } } } });
  ({ features } = await run.import('app_state.js'));
});

const authzen = (hosts) => ({
  access: {
    mode: 'authzen',
    subject: 'alice',
    actions: { 'system.read': true, 'explorer.read': true, 'query.run.read': false, 'mcp.keys.read': true },
    ...(hosts === undefined ? {} : { hosts }),
  },
  system: { enabled: true },
  explorer: { enabled: true },
});

test('the picker of a page shows the hosts on which the user holds an action of that page', () => {
  features.set(authzen({ local: { 'system.read': true, 'explorer.read': false }, other: { 'system.read': false, 'explorer.read': true } }));
  assert.equal(features.hostAllowed('local', 'system'), true);
  assert.equal(features.hostAllowed('other', 'system'), false);
  assert.equal(features.hostAllowed('local', 'shape'), true);
  assert.equal(features.hostAllowed('local', 'explorer'), false);
  assert.equal(features.hostAllowed('other', 'explorer'), true);
  // A host that the server did not list, and the Query page without a run action anywhere.
  assert.equal(features.hostAllowed('nosuch', 'system'), false);
  assert.equal(features.hostAllowed('local', 'query'), false);
  // The MCP pages are not tied to a host.
  assert.equal(features.hostAllowed('other', 'mcp'), true);
  // The decisions keep only true and false.
  assert.deepEqual(features.get('access').hosts, { local: { 'system.read': true, 'explorer.read': false }, other: { 'system.read': false, 'explorer.read': true } });
});

test('without decisions by host, and in the open mode, every host shows', () => {
  features.set(authzen(undefined));
  assert.equal(features.get('access').hosts, null);
  assert.equal(features.hostAllowed('other', 'system'), true);
  features.set({ access: { mode: 'open' } });
  assert.equal(features.hostAllowed('other', 'query'), true);
});
