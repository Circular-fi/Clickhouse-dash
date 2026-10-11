const test = require('node:test');
const strict = require('node:assert/strict');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The time range of the Observability and System pages (app_timerange.js): how "now-6h", "2026-09-12 14:30" and
// "now/d" become instants, what the picker calls a range, and the text of a duration. The page works in the local
// time of the browser; the tests pin it to UTC, and one test moves it to a zone with a daylight saving shift.
// The objects of the vm have another prototype: they are compared as JSON.
const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual: (actual, expected, message) => strict.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message),
});
process.env.TZ = 'UTC';
let timeRange;

test.before(async () => {
  const format = { setRangeNamer() {}, range: (a, b) => `${a}-${b}`, time: (ms, { precision }) => `${new Date(ms).toISOString().slice(0, precision === 's' ? 19 : 16)}` };
  const run = await esm.load({ root, window: { sessionStorage: esm.memoryStorage(), localStorage: esm.memoryStorage() }, stubs: {
    'app_state.js': { state: {}, features: {}, storage: { pref: () => ({ get: () => [], set() {} }), KEYS: {} } },
    'app_util.js': { util: { escapeHtml: String } },
    'app_router.js': { router: {} },
    'app_format.js': { format },
    'app_dom.js': { dom: { $: () => null, $$: () => [], byId: () => null } },
    'app_ui_icon.js': {}, 'app_ui_menu.js': {}, 'app_ui_search.js': {}, 'app_ui_state.js': {},
  } });
  timeRange = (await run.import('app_timerange.js')).timeRange;
});

const NOW = Date.UTC(2026, 9, 10, 12, 34, 56, 789);
const at = (text) => Date.parse(`${text}Z`);

test('relative times: now, now-6h, units from seconds to years, and several steps in a row', () => {
  assert.equal(timeRange.parseTime('now', false, NOW), NOW);
  assert.equal(timeRange.parseTime('now-6h', false, NOW), NOW - 6 * 3600000);
  assert.equal(timeRange.parseTime('now-15m', false, NOW), NOW - 15 * 60000);
  assert.equal(timeRange.parseTime('now-30s', false, NOW), NOW - 30000);
  assert.equal(timeRange.parseTime('NOW - 2 d', false, NOW), NOW - 2 * 86400000);
  assert.equal(timeRange.parseTime('now+1h', true, NOW), NOW + 3600000);
  assert.equal(timeRange.parseTime('now-1d-12h', false, NOW), NOW - 36 * 3600000);
  assert.equal(timeRange.parseTime('now-1w', false, NOW), NOW - 7 * 86400000);
  assert.equal(timeRange.parseTime('now-1M', false, NOW), at('2026-09-10T12:34:56.789'));
  assert.equal(timeRange.parseTime('now-1y', false, NOW), at('2025-10-10T12:34:56.789'));
});

test('rounding: /d is the start of the day for a start and its last millisecond for an end', () => {
  assert.equal(timeRange.parseTime('now/d', false, NOW), at('2026-10-10T00:00:00.000'));
  assert.equal(timeRange.parseTime('now/d', true, NOW), at('2026-10-10T23:59:59.999'));
  assert.equal(timeRange.parseTime('now-1d/d', false, NOW), at('2026-10-09T00:00:00.000'));
  assert.equal(timeRange.parseTime('now/h', false, NOW), at('2026-10-10T12:00:00.000'));
  assert.equal(timeRange.parseTime('now/M', true, NOW), at('2026-10-31T23:59:59.999'));
  // The week starts on Monday: 2026-10-10 is a Saturday.
  assert.equal(timeRange.parseTime('now/w', false, NOW), at('2026-10-05T00:00:00.000'));
  assert.equal(timeRange.parseTime('now/y', false, NOW), at('2026-01-01T00:00:00.000'));
});

test('absolute times: a date alone is a whole day when it ends a range, seconds and milliseconds are optional, a wrong date is NaN', () => {
  assert.equal(timeRange.parseTime('2026-09-12', false, NOW), at('2026-09-12T00:00:00.000'));
  assert.equal(timeRange.parseTime('2026-09-12', true, NOW), at('2026-09-12T23:59:59.999'));
  assert.equal(timeRange.parseTime('2026-09-12 14:30', true, NOW), at('2026-09-12T14:30:00.000'));
  assert.equal(timeRange.parseTime('2026-9-2T4:05:06', false, NOW), at('2026-09-02T04:05:06.000'));
  assert.equal(timeRange.parseTime('2026-09-12 14:30:15.5', false, NOW), at('2026-09-12T14:30:15.500'));
  assert.equal(timeRange.parseTime('2026-09-12||+1d', false, NOW), at('2026-09-13T00:00:00.000'));
  for (const bad of ['2026-02-30', '2026-13-01', '2026-09-12 24:00', '2026-09-12 14:60', 'yesterday', '', null, 'now-', 'now-6x', 'now*2']) {
    assert.ok(Number.isNaN(timeRange.parseTime(bad, false, NOW)), `${bad} is not a time`);
  }
});

test('the end of a month is kept when a month is added or taken away', () => {
  const march31 = at('2026-03-31T10:00:00.000');
  assert.equal(timeRange.parseTime('now-1M', false, march31), at('2026-02-28T10:00:00.000'));
  assert.equal(timeRange.parseTime('now-1y', false, at('2024-02-29T10:00:00.000')), at('2023-02-28T10:00:00.000'));
});

test('resolveRange reads both sides; isRelative says whether either side moves with the clock', () => {
  assert.deepEqual(timeRange.resolveRange({ from: 'now-1h', to: 'now' }, NOW), { startMs: NOW - 3600000, endMs: NOW });
  const odd = timeRange.resolveRange({ from: 'x', to: '2026-09-12' }, NOW);
  assert.ok(Number.isNaN(odd.startMs));
  assert.equal(odd.endMs, at('2026-09-12T23:59:59.999'));
  assert.equal(timeRange.isRelative({ from: 'now-1h', to: 'now' }), true);
  assert.equal(timeRange.isRelative({ from: '2026-09-12 10:00', to: 'NOW' }), true);
  assert.equal(timeRange.isRelative({ from: '2026-09-12 10:00', to: '2026-09-12 11:00' }), false);
  assert.equal(timeRange.isRelative(null), false);
});

test('describeRange names a quick range, a "last N" range and an absolute one; anything else is shown as typed', () => {
  assert.deepEqual(timeRange.describeRange({ from: 'now-5m', to: 'now' }, NOW), { text: 'Last 5 minutes', relative: true });
  assert.deepEqual(timeRange.describeRange({ from: 'now-90m', to: 'now' }, NOW), { text: 'Last 90 minutes', relative: true });
  assert.deepEqual(timeRange.describeRange({ from: 'now-1w', to: 'now' }, NOW).relative, true);
  const absolute = timeRange.describeRange({ from: '2026-09-12 10:00', to: '2026-09-12 11:00' }, NOW);
  assert.equal(absolute.relative, false);
  assert.equal(absolute.text, `${at('2026-09-12T10:00:00.000')}-${at('2026-09-12T11:00:00.000')}`);
  // One side relative: the absolute side is formatted, the relative one stays as typed.
  assert.deepEqual(timeRange.describeRange({ from: '2026-09-12 10:00', to: 'now' }, NOW), { text: '2026-09-12T10:00 → now', relative: true });
  // Under ten minutes the seconds show.
  assert.equal(timeRange.describeRange({ from: '2026-09-12 10:00:00', to: 'now' }, at('2026-09-12T10:05:00.000')).text, '2026-09-12T10:00:00 → now');
});

test('minutesToSpan writes a number of minutes in the unit of the quick ranges: days from two, hours, else minutes; 60 when it is not a number', () => {
  assert.equal(timeRange.minutesToSpan(1440), '24h');
  assert.equal(timeRange.minutesToSpan(2880), '2d');
  assert.equal(timeRange.minutesToSpan(120), '2h');
  assert.equal(timeRange.minutesToSpan(90), '90m');
  assert.equal(timeRange.minutesToSpan(0), '1h');
  assert.equal(timeRange.minutesToSpan('abc'), '1h');
});

test('formatMinutes says how long a bound is, in words', () => {
  assert.equal(timeRange.formatMinutes(1440), '1 day');
  assert.equal(timeRange.formatMinutes(4320), '3 days');
  assert.equal(timeRange.formatMinutes(120), '2 hours');
  assert.equal(timeRange.formatMinutes(60), '1 hour');
  assert.equal(timeRange.formatMinutes(90), '90 minutes');
  assert.equal(timeRange.formatMinutes(0), '1 minute');
});

test('formatDateTime writes the local time the pickers read back', () => {
  assert.equal(timeRange.formatDateTime(at('2026-09-12T04:05:06.000')), '2026-09-12 04:05:06');
  assert.equal(timeRange.parseTime(timeRange.formatDateTime(NOW), false, NOW), NOW - 789);
});

test('a zone with a daylight saving shift: a day is not always 24 hours', () => {
  const was = process.env.TZ;
  process.env.TZ = 'Europe/Paris';
  try {
    // 2026-03-29 is the spring-forward day in Paris: 23 hours.
    const noon = new Date(2026, 2, 29, 12, 0, 0).getTime();
    const start = timeRange.parseTime('now/d', false, noon);
    const end = timeRange.parseTime('now/d', true, noon);
    assert.equal(new Date(start).getHours(), 0);
    assert.equal(end - start + 1, 23 * 3600000);
    assert.equal(timeRange.parseTime('now-1d', false, noon), new Date(2026, 2, 28, 12, 0, 0).getTime());
  } finally {
    process.env.TZ = was;
  }
});
