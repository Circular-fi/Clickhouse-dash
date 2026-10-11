const strict = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const esm = require('../../harness/esm_vm.js');
const root = path.join(__dirname, '../../..');
// The metadata cache of the Query page (app_meta.js) in a bare vm, with the real app_state.js and a fake API. What the page keeps in
// memory is bounded: at most two hosts, 32 tables and 10,000 columns for each host (the least recently read go first), and the columns of
// the whole cluster are never part of the catalogue that is read at start.
const assert = strict;

class Clock {
  constructor() { this.t = 1_000_000; }
  tick() { this.t += 1000; return this.t; }
}

async function load() {
  const clock = new Clock();
  const requests = [];
  const columnsOf = new Map();  // `${database}.${table}` -> number of columns to answer
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.t])); }
    static now() { return clock.t; }
  }
  const storage = new Map();
  const local = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key), key: (index) => [...storage.keys()][index] ?? null, get length() { return storage.size; },
  };
  const api = {
    async getMeta(hostId, types, scope) {
      requests.push({ hostId, types: [...types], scope });
      if (types.includes('columns') && scope) {
        const count = columnsOf.get(`${scope.database}.${scope.table}`) ?? 3;
        return { data: { columns: { updated_at_ms: clock.t, items: Array.from({ length: count }, (_, i) => ({ name: `c${i}`, type: 'String' })) } } };
      }
      return { data: {} };
    },
  };
  const run = await esm.load({
    root,
    globals: { Date: FakeDate, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }, setTimeout: () => 0, clearTimeout: () => {}, localStorage: local },
    window: { localStorage: local, sessionStorage: local, dispatchEvent() {}, addEventListener() {} },
    stubs: { 'app_api.js': { api }, 'app_header.js': { header: { onHostSelected() {} } } },
  });
  const { state } = await run.import('app_state.js');
  const { meta } = await run.import('app_meta.js');
  return { meta, state, clock, requests, columnsOf, storage };
}

async function fetchColumns(ctx, host, database, table) {
  ctx.clock.tick();
  await ctx.meta.fetchAndStore(host, ['columns'], { database, table });
}

test('the columns of a table are kept for 32 tables at most, the least recently read first', async () => {
  const ctx = await load();
  ctx.state.selectedHostId = 'h1';
  for (let i = 0; i < 32; i += 1) await fetchColumns(ctx, 'h1', 'db', `t${i}`);
  assert.equal(ctx.meta.getTableColumns('db', 't0').length, 3);  // reading t0 makes it the most recent
  await fetchColumns(ctx, 'h1', 'db', 't32');
  assert.equal(ctx.meta.getTableColumns('db', 't1'), null, 'the least recently read table goes');
  assert.ok(ctx.meta.getTableColumns('db', 't0'), 'the table that was just read stays');
  assert.ok(ctx.meta.getTableColumns('db', 't32'));
  for (let i = 33; i < 60; i += 1) await fetchColumns(ctx, 'h1', 'db', `t${i}`);
  let kept = 0;
  for (let i = 0; i < 60; i += 1) if (ctx.meta.getTableColumns('db', `t${i}`)) kept += 1;
  assert.equal(kept, 32);
});

test('the columns of a host are kept up to 10,000 in all: a wide table pushes the oldest ones out', async () => {
  const ctx = await load();
  ctx.state.selectedHostId = 'h1';
  ctx.columnsOf.set('db.a', 4000);
  ctx.columnsOf.set('db.b', 4000);
  ctx.columnsOf.set('db.c', 4000);
  await fetchColumns(ctx, 'h1', 'db', 'a');
  await fetchColumns(ctx, 'h1', 'db', 'b');
  assert.equal(ctx.meta.getTableColumns('db', 'a').length, 4000);
  await fetchColumns(ctx, 'h1', 'db', 'c');  // 12,000 > 10,000: the oldest read goes (b was read after a: a was read last, so b goes)
  assert.equal(ctx.meta.getTableColumns('db', 'b'), null);
  assert.equal(ctx.meta.getTableColumns('db', 'a').length, 4000);
  assert.equal(ctx.meta.getTableColumns('db', 'c').length, 4000);
});

test('the metadata of two hosts stays in memory: the third host takes the place of the least recently used one', async () => {
  const ctx = await load();
  for (const host of ['h1', 'h2', 'h3']) {
    ctx.state.selectedHostId = host;
    await fetchColumns(ctx, host, 'db', 't');
  }
  assert.deepEqual(Object.keys(ctx.state.meta.hosts).sort(), ['h2', 'h3']);
  ctx.state.selectedHostId = 'h2';
  ctx.clock.tick();
  ctx.meta.getTableColumns('db', 't');  // h2 is in use again: h4 pushes h3 out, not h2
  ctx.state.selectedHostId = 'h4';
  await fetchColumns(ctx, 'h4', 'db', 't');
  assert.deepEqual(Object.keys(ctx.state.meta.hosts).sort(), ['h2', 'h4']);
});

test('the catalogue read at start has no columns, and the old cluster-wide columns key of a host is removed unread', async () => {
  const ctx = await load();
  ctx.state.selectedHostId = 'h1';
  // A payload that an older page stored: it must be deleted by key, never parsed (it can hold hundreds of megabytes once expanded).
  ctx.storage.set('chdash.meta.v1.h1.columns', '{"not json');
  ctx.storage.set('chdash.meta.v1.h1.tables', JSON.stringify({ updated_at_ms: 1, items: [{ name: 't' }] }));
  ctx.meta.prepareHost('h1');
  assert.equal(ctx.storage.has('chdash.meta.v1.h1.columns'), false);
  assert.equal(ctx.storage.has('chdash.meta.v1.h1.tables'), true, 'the other catalogues stay');
  await ctx.meta.maybeRefreshOnUserAction();
  assert.ok(ctx.requests.length >= 1);
  for (const request of ctx.requests) {
    assert.ok(!request.types.includes('columns'), `the start asked for ${request.types}`);
    assert.equal(request.scope, null);
  }
  assert.deepEqual(ctx.requests[0].types, ['data_types', 'databases', 'formats', 'functions', 'keywords', 'settings', 'table_functions']);  // every catalogue type but the fresh one (tables) and the columns
});
