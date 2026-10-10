const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');

// The host cycle of an Observability view (app_obs_view.js) and the checks of a time range (app_timerange.js), in a bare vm.
async function load() {
  const listeners = new Map();
  const slots = [];
  const flags = [];
  const state = { selectedHostId: 'a' };
  const window = {
    sessionStorage: esm.memoryStorage(),
    localStorage: esm.memoryStorage(),
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const run = await esm.load({ root, window, stubs: {
    'app_state.js': { state, features: { on: (fn) => flags.push(fn), get: () => undefined }, storage: { pref: () => ({ get: () => [], set() {} }), KEYS: {} } },
    'app_util.js': { util: { latest: { cancelPrefix: (prefix) => slots.push(prefix) }, escapeHtml: String } },
    'app_router.js': { router: { current: () => ({ params: new URLSearchParams() }) } },
    'app_format.js': { format: { setRangeNamer() {} } },
    'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null } },
    'app_ui_icon.js': {}, 'app_ui_menu.js': {}, 'app_ui_search.js': {},
  } });
  const { obsView } = await run.import('app_obs_view.js');
  const { timeRange } = await run.import('app_timerange.js');
  return { obsView, timeRange, listeners, slots, flags, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the cycle loads when it starts with a host, and once per host while a load runs', async () => {
  const { obsView, listeners, slots, state } = await load();
  const calls = [];
  const releases = [];
  const cycle = obsView.hostCycle({
    feature: 'logs', cancel: ['logs.', 'facets.'], reset: () => calls.push('reset'),
    load: (stale) => new Promise((resolve) => { releases.push(() => resolve(stale())); calls.push('load'); }),
  });
  cycle.start();
  assert.deepEqual(calls, ['reset', 'load']);
  assert.deepEqual(slots, ['logs.', 'facets.']);
  // The same host asks again (the feature flags and the host change arrive together): it joins the load that runs.
  const first = cycle.reload();
  assert.equal(cycle.reload(), first);
  assert.deepEqual(calls, ['reset', 'load']);
  // Another host: everything of the old one stops, and a new load starts.
  state.selectedHostId = 'b';
  listeners.get('chdash:host-changed')();
  assert.deepEqual(calls, ['reset', 'load', 'reset', 'load']);
  assert.deepEqual(slots, ['logs.', 'facets.', 'logs.', 'facets.']);
  releases.forEach((release) => release());
  assert.equal(await first, true, 'the load of the old host sees stale()');
});

test('a load of the old host sees stale() turn true', async () => {
  const { obsView, state } = await load();
  const seen = [];
  const gates = [];
  const cycle = obsView.hostCycle({
    feature: 'traces',
    load: async (stale) => { await new Promise((resolve) => gates.push(resolve)); seen.push(stale()); },
  });
  const first = cycle.reload();
  state.selectedHostId = 'b';
  const second = cycle.reload();
  gates.forEach((open) => open());
  await Promise.all([first, second]);
  assert.deepEqual(seen, [true, false]);
});

test('the feature flags start a first load only when none ran, and not for a view that they turn off', async () => {
  const { obsView, flags, state } = await load();
  let loads = 0;
  const cycle = obsView.hostCycle({ feature: 'metrics', load: async () => { loads += 1; } });
  state.selectedHostId = '';
  cycle.start();
  assert.equal(loads, 0);
  const [onFlags] = flags;
  onFlags({ metrics: { enabled: false } });
  state.selectedHostId = 'a';
  onFlags({ metrics: { enabled: false } });
  assert.equal(loads, 0);
  onFlags({ metrics: { enabled: true } });
  await settle();
  assert.equal(loads, 1);
  onFlags({ metrics: { enabled: true } });
  await settle();
  assert.equal(loads, 1, 'a view that loaded is not loaded again by the flags');
});

test('loaded() decides whether the flags retry the load', async () => {
  const { obsView, flags } = await load();
  let loads = 0;
  let meta = null;
  const cycle = obsView.hostCycle({ feature: 'traces', loaded: () => !!meta, load: async () => { loads += 1; } });
  cycle.start();
  await settle();
  assert.equal(loads, 1);
  flags[0]({ traces: { enabled: true } });
  await settle();
  assert.equal(loads, 2, 'no meta: the flags try again');
  meta = {};
  flags[0]({ traces: { enabled: true } });
  await settle();
  assert.equal(loads, 2);
});

test('checkRange says what is wrong with a range, in the words the views show', async () => {
  const { timeRange } = await load();
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const ok = timeRange.checkRange({ from: 'now-1h', to: 'now' }, 1440, 'traces.max_lookback_minutes', now);
  assert.equal(ok.error, '');
  assert.equal(ok.endMs - ok.startMs, 3600000);
  assert.equal(timeRange.checkRange({ from: 'now', to: 'now-1h' }, 1440, '', now).error, 'Select a valid time range.');
  assert.equal(timeRange.checkRange({ from: 'nonsense', to: 'now' }, 1440, '', now).error, 'Select a valid time range.');
  assert.equal(timeRange.checkRange({ from: 'now-3d', to: 'now' }, 1440, 'server setting logs.max_lookback_minutes', now).error,
    'Max range is 1 day (server setting logs.max_lookback_minutes).');
  assert.equal(timeRange.checkRange({ from: 'now-3d', to: 'now' }, 1440, '', now).error, 'Max range is 1 day.');
  assert.equal(timeRange.checkRange({ from: 'now-30d', to: 'now' }, 0, '', now).error, '', 'no bound');
  assert.throws(() => timeRange.resolveBounded({ from: 'now-3d', to: 'now' }, 1440, '', now), /Max range is 1 day/);
  assert.equal(timeRange.resolveBounded({ from: 'now-1h', to: 'now' }, 1440, '', now).startMs, now - 3600000);
});

test('sameRange compares both sides as text, localMidnight is the start of the local day', async () => {
  const { timeRange } = await load();
  assert.equal(timeRange.sameRange({ from: 'now-1h', to: 'now' }, { from: 'now-1h', to: 'now' }), true);
  assert.equal(timeRange.sameRange({ from: 'now-1h', to: 'now' }, { from: 'now-2h', to: 'now' }), false);
  assert.equal(timeRange.sameRange(null, { from: '', to: '' }), true);
  const noon = new Date(2026, 9, 10, 12, 34, 56).getTime();
  assert.equal(timeRange.localMidnight(noon), new Date(2026, 9, 10).getTime());
  assert.equal(timeRange.localMidnight(String(noon)), new Date(2026, 9, 10).getTime());
});
