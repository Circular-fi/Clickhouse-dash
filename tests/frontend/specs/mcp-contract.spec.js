import { test, expect } from '@playwright/test';
import { compareShapes, shapeOf } from '../helpers/shape.js';
import { newServer, install, setUsage } from '../helpers/mcp-fake.js';
import { requireInstance } from '../helpers/instances.js';

// The fake MCP server of mcp-page.spec.js (helpers/mcp-fake.js) and the real one answer the same routes. This spec plays
// the same calls against both, from a page, and compares the shape of each answer: a key that the real JSON has and the
// fake lacks (or the other way round), or a type that differs, fails here instead of letting the page spec pass on a
// contract that no longer exists. It then drives the real page against the real server: the keys of the config file, a key
// made in the page (its secret shown once, never given back) and deleted.
// The instance: MCP_CONTRACT_BASE_URL, a server with tests/config/mcp.hcl and a writable /data (the `chdash_mcp` service of
// tests/docker-compose.yml). It has the usage on (one instance, `all_keys` on). The usage OFF is the instance of tests/config/mcp.profile.hcl
// (MCP_PROFILE_BASE_URL, the `chdash_mcp_profile` service): MCP on and no `mcp.usage` block. Several instances that share a directory and the keys
// that only another one knows (`elsewhere`) cannot be made from a page (the directory is the server's): their shapes are the ones of the one-instance
// answers (a list of instances, a flag on every key), and test_mcp.py plays the files of several instances against a real server.

const BASE = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');
// The instance with the usage off (tests/config/mcp.profile.hcl), and the name that the instance of the contract counts under (mcp.usage.instance
// of tests/config/mcp.hcl: a fixed name, since the host name of a container changes).
const PROFILE = (process.env.MCP_PROFILE_BASE_URL || '').replace(/\/$/, '');
const INSTANCE = 'chdash-mcp-test';
// The file of an instance is written once a minute when something changed: an instance that has just started has `written_at: null` (no write yet).
const wroteOrNot = (value) => value === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value);

test.beforeEach(() => { requireInstance(test, 'MCP_CONTRACT_BASE_URL', BASE); });

// The instance keeps its keys between runs: what a test made is deleted when it ends, failed or not, and a name that a
// failed run left behind would make the next one fail on "a key named ... exists".
const PROBE = `probe-${Date.now().toString(36)}`;
test.afterEach(async ({ request }) => {
  if (!BASE) return;
  const keys = (await (await request.get(`${BASE}/api/mcp/keys`)).json()).keys || [];
  for (const key of keys.filter((entry) => entry.source === 'ui' && entry.name.startsWith(PROBE))) {
    await request.delete(`${BASE}/api/mcp/keys/${key.id}`, { headers: { 'Content-Type': 'application/json' } });
  }
});

// A call as the page makes it, answered by whoever the page talks to: { status, body }.
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}, { method, path, body });

// The page talks to the real server, or to the fake: its routes are the fake's while it is installed. `base`: another real instance (the one
// that has the usage off).
async function realPage(page, base = BASE) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto(`${base}/query`);
}

async function fakePage(page, fake) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await install(page, fake);
  await page.goto('/query');
}

async function bothAnswers(page, requestOf) {
  // The real server: the page is its own.
  await realPage(page);
  const real = await requestOf(page);
  // The fake: any page of the instance under test, with the routes answered by the in-memory server.
  await fakePage(page, newServer());
  return { real, fake: await requestOf(page) };
}

const compare = ({ real, fake }, label) => {
  expect(fake.status, `${label}: status`).toBe(real.status);
  expect(compareShapes(shapeOf(real.body), shapeOf(fake.body)), label).toEqual([]);
};

test('GET /api/mcp/meta: the real answer and the fake have the same shape', async ({ page }) => {
  compare(await bothAnswers(page, (p) => call(p, 'GET', '/api/mcp/meta')), 'meta');
});

// The catalog of the tools: `always`, `explicit_only` and `available` on every tool, the family of the analysis of the keys (the limits and the usage
// of a key, and the usage of all of them), and the fake's catalog, which is a part of the real one: the same family and the same flags for each tool.
test('GET /api/mcp/meta: the catalog says which tools every key has, which ones "*" leaves out and which ones are offered now', async ({ page }) => {
  await realPage(page);
  const real = await call(page, 'GET', '/api/mcp/meta');
  expect(real.status).toBe(200);
  const tool = (name) => real.body.tools.find((item) => item.name === name);
  expect(real.body.tool_groups.map((group) => group.id)).toContain('mcp_analysis');
  for (const item of real.body.tools) {
    for (const flag of ['always', 'explicit_only', 'available', 'needs_all_data']) expect(typeof item[flag], `${item.name}.${flag}`).toBe('boolean');
  }
  // Every key has the limits and (while the usage is on) the usage of its own, whatever its list says; the usage of all the keys is in the list of a
  // key only by its name, never by "*", and only when mcp.usage.all_keys is on (it is, here).
  expect(tool('mcp_analysis_my_limits')).toMatchObject({ group: 'mcp_analysis', always: true, explicit_only: false, available: true });
  expect(tool('mcp_analysis_my_usage')).toMatchObject({ group: 'mcp_analysis', always: true, explicit_only: false, available: true });
  expect(tool('mcp_analysis_all_usage')).toMatchObject({ group: 'mcp_analysis', always: false, explicit_only: true, available: true });
  expect(real.body.tools.filter((item) => item.always).map((item) => item.name).sort()).toEqual(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  expect(real.body.tools.filter((item) => item.explicit_only).map((item) => item.name)).toEqual(['mcp_analysis_all_usage']);
  expect(real.body.tools.filter((item) => !item.available)).toEqual([]);
  // The usage block: on, in the files of a directory, as the instance of the configuration, and the setting of all the keys.
  expect(real.body.usage).toMatchObject({ enabled: true, storage: 'files', instance: INSTANCE, all_keys: true });
  expect(real.body.usage.windows).toEqual(expect.arrayContaining(['1h', '24h', '7d']));
  expect(real.body.usage).not.toHaveProperty('persisted');
  // The fake's catalog is a part of the real one.
  const fake = newServer();
  for (const item of fake.meta.tools) {
    const found = tool(item.name);
    expect(found, `${item.name} is a tool of the server`).toBeTruthy();
    expect({ group: found.group, always: found.always, explicit_only: found.explicit_only }, item.name).toEqual({ group: item.group, always: item.always, explicit_only: item.explicit_only });
  }
  expect(fake.meta.tool_groups.map((group) => group.id)).toEqual(real.body.tool_groups.map((group) => group.id));
});

// The usage off: no `mcp.usage` block. The meta says so, the analysis of the usage is not offered (the limits of a key are), the three routes of the
// usage answer 404 `not_enabled`, and the cost of a key, which does not come from the usage, still answers. The fake in the same state answers alike.
test('the usage is off: the meta and the three usage routes say so in the shapes of the fake, and the cost of a key still answers', async ({ page }) => {
  requireInstance(test, 'MCP_PROFILE_BASE_URL', PROFILE);
  await realPage(page, PROFILE);
  const config = (await call(page, 'GET', '/api/mcp/keys')).body.keys.find((key) => key.source === 'config');
  const real = {
    meta: await call(page, 'GET', '/api/mcp/meta'),
    summary: await call(page, 'GET', '/api/mcp/usage?window=7d'),
    overview: await call(page, 'GET', '/api/mcp/usage/overview?window=7d'),
    usage: await call(page, 'GET', `/api/mcp/keys/${config.id}/usage?window=24h`),
    cost: await call(page, 'GET', `/api/mcp/keys/${config.id}/cost?window=24h`),
  };
  expect(real.meta.body.usage).toEqual({ enabled: false, cost_windows: ['1h', '6h', '24h', '7d'] });
  const offered = (name) => real.meta.body.tools.find((item) => item.name === name).available;
  expect([offered('mcp_analysis_my_limits'), offered('mcp_analysis_my_usage'), offered('mcp_analysis_all_usage')]).toEqual([true, false, false]);
  for (const name of ['summary', 'overview', 'usage']) {
    expect(real[name].status, name).toBe(404);
    expect(real[name].body, name).toMatchObject({ error_code: 'not_enabled', retryable: false });
  }
  expect(real.cost.status).toBe(200);
  expect(real.cost.body.id).toBe(config.id);
  const fake = newServer();
  setUsage(fake, { enabled: false });
  await fakePage(page, fake);
  const fakeConfig = fake.keys.find((key) => key.source === 'config');
  const fakeMeta = await call(page, 'GET', '/api/mcp/meta');
  compare({ real: { status: 200, body: real.meta.body.usage }, fake: { status: 200, body: fakeMeta.body.usage } }, 'the usage block of the meta, usage off');
  const fakeOffered = (name) => fakeMeta.body.tools.find((item) => item.name === name).available;
  expect([fakeOffered('mcp_analysis_my_limits'), fakeOffered('mcp_analysis_my_usage'), fakeOffered('mcp_analysis_all_usage')]).toEqual([true, false, false]);
  compare({ real: real.summary, fake: await call(page, 'GET', '/api/mcp/usage?window=7d') }, 'usage of the keys, usage off');
  compare({ real: real.overview, fake: await call(page, 'GET', '/api/mcp/usage/overview?window=7d') }, 'usage overview, usage off');
  compare({ real: real.usage, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/usage?window=24h`) }, 'usage of a key, usage off');
  expect((await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=24h`)).status, 'the cost of a key, usage off').toBe(200);
});

test('GET /api/mcp/keys and /api/mcp/access: the same shape', async ({ page }) => {
  compare(await bothAnswers(page, (p) => call(p, 'GET', '/api/mcp/keys')), 'keys');
  compare(await bothAnswers(page, (p) => call(p, 'GET', '/api/mcp/access')), 'access');
});

test('a key of the config file: its reach has the same shape, an unknown key and a key of the config file refuse in the same words', async ({ page }) => {
  const fake = newServer();
  const configKey = (keys) => keys.find((key) => key.source === 'config');
  await realPage(page);
  const realConfig = configKey((await call(page, 'GET', '/api/mcp/keys')).body.keys);
  const real = {
    reach: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/access`),
    unknown: await call(page, 'GET', '/api/mcp/keys/nope/access'),
    removal: await call(page, 'DELETE', `/api/mcp/keys/${realConfig.id}`),
  };
  await fakePage(page, fake);
  const fakeConfig = configKey(fake.keys);
  compare({ real: real.reach, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/access`) }, 'reach of a key');
  compare({ real: real.unknown, fake: await call(page, 'GET', '/api/mcp/keys/nope/access') }, 'unknown key');
  compare({ real: real.removal, fake: await call(page, 'DELETE', `/api/mcp/keys/${fakeConfig.id}`) }, 'delete of a config key');
});

test('the usage of the keys, the usage of a key and its cost: the same shape, the same refusals', async ({ page }) => {
  await realPage(page);
  const realConfig = (await call(page, 'GET', '/api/mcp/keys')).body.keys.find((key) => key.source === 'config');
  const real = {
    summary: await call(page, 'GET', '/api/mcp/usage?window=7d'),
    usage: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/usage?window=24h`),
    usageByMinute: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/usage?window=1h`),
    cost: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/cost?window=24h`),
    costOfAnHour: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/cost?window=1h`),
    unknown: await call(page, 'GET', '/api/mcp/keys/nope/usage'),
    window: await call(page, 'GET', '/api/mcp/usage?window=48h'),
  };
  // Every answer of the usage says which instances it sums (this one first, each with how its file was read) and has no `persisted`; a key has
  // `elsewhere` (true when only another instance knows it: not here, there is one instance).
  for (const name of ['summary', 'usage', 'usageByMinute']) {
    const [only, ...others] = real[name].body.instances;
    expect(others, name).toEqual([]);
    expect(only, name).toMatchObject({ instance: INSTANCE, status: 'ok', reason: '' });
    expect(wroteOrNot(only.written_at), `${name}: written_at`).toBe(true);
    expect(real[name].body, name).not.toHaveProperty('persisted');
  }
  expect(real.summary.body.keys.map((item) => item.elsewhere)).not.toContain(true);
  expect(real.summary.body.keys.every((item) => typeof item.elsewhere === 'boolean')).toBe(true);
  expect(real.usage.body.elsewhere).toBe(false);
  const fake = newServer();
  await fakePage(page, fake);
  const fakeConfig = fake.keys.find((key) => key.source === 'config');
  compare({ real: real.summary, fake: await call(page, 'GET', '/api/mcp/usage?window=7d') }, 'usage of the keys');
  compare({ real: real.usage, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/usage?window=24h`) }, 'usage of a key');
  // The step of the series is a number of seconds (900 for 24 h, 60 for 1 h), whatever the window; the windows of the cost are 1 h to 7 d.
  compare({ real: real.usageByMinute, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/usage?window=1h`) }, 'usage of a key in the last hour');
  expect(real.usage.body.series.step, 'the real step of 24 h').toBe(900);
  expect(real.usageByMinute.body.series.step, 'the real step of 1 h').toBe(60);
  expect(real.usageByMinute.body.series.points, 'the real points of 1 h').toHaveLength(60);
  compare({ real: real.cost, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=24h`) }, 'cost of a key');
  compare({ real: real.costOfAnHour, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=1h`) }, 'cost of a key in the last hour');
  compare({ real: real.unknown, fake: await call(page, 'GET', '/api/mcp/keys/nope/usage') }, 'usage of an unknown key');
  compare({ real: real.window, fake: await call(page, 'GET', '/api/mcp/usage?window=48h') }, 'a window that the retention does not keep');
});

// The usage of every key (GET /api/mcp/usage/overview). A list that is empty accepts any shape, so the usage is made first on the real
// instance, with the key of the config file that reads everything (tests/config/mcp.hcl): an initialize that names a client, tools/list, a
// tool call, a method that nobody knows and a notification. Then the page's own calls are compared: the answer with nothing asked, a
// filtered one, one grouped by key, by client and by instance, one cut to an instance, the finest window, and the refusals (the old `split`, a
// group that does not exist, a value that is not valid, a client or an instance that is not valid, a parameter that is not one, more than 20
// values).
const ALL_DATA_KEY = 'a11da7a0-0000-4000-8000-000000000001';

async function makeUsage(request) {
  const post = (data) => request.post(`${BASE}/mcp`, {
    headers: { Authorization: `Bearer ${ALL_DATA_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data,
  });
  const answers = [
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chdash-contract', version: '1.0.0' } } }),
    await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_hosts', arguments: {} } }),
    await post({ jsonrpc: '2.0', id: 4, method: 'nothing/known' }),
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  ];
  // The request of a method that nobody knows is a JSON-RPC error (200), the notification has no answer (202).
  expect(answers.map((answer) => answer.status())).toEqual([200, 200, 200, 200, 202]);
}

test('GET /api/mcp/usage/overview: the same shape for the answer, a filtered one, a group by key and by client, the same refusals', async ({ page, request }) => {
  await makeUsage(request);
  const asked = {
    plain: '/api/mcp/usage/overview',
    filtered: '/api/mcp/usage/overview?window=24h&group=client&key=all-data&method=tools/list',
    byKey: '/api/mcp/usage/overview?window=24h&group=key',
    byClient: '/api/mcp/usage/overview?window=1h&group=client&client=chdash-contract',
    byResult: '/api/mcp/usage/overview?window=6h&group=result&result=ok',
    byType: '/api/mcp/usage/overview?window=24h&group=type&type=call&type=request',
    byInstance: '/api/mcp/usage/overview?window=24h&group=instance',
    ofInstance: `/api/mcp/usage/overview?window=24h&group=key&instance=${INSTANCE}`,
    ofOtherInstance: '/api/mcp/usage/overview?window=24h&instance=nobody-writes-this',
    badWindow: '/api/mcp/usage/overview?window=48h',
    badGroup: '/api/mcp/usage/overview?group=nope',
    oldSplit: '/api/mcp/usage/overview?split=method',
    badValue: '/api/mcp/usage/overview?key=BAD!',
    badClient: '/api/mcp/usage/overview?client=%20padded',
    badInstance: '/api/mcp/usage/overview?instance=bad%20name',
    unknown: '/api/mcp/usage/overview?bogus=1',
    tooMany: `/api/mcp/usage/overview?${Array.from({ length: 21 }, (_, i) => `method=m${i}`).join('&')}`,
    tooManyClients: `/api/mcp/usage/overview?${Array.from({ length: 21 }, (_, i) => `client=c${i}`).join('&')}`,
    tooManyInstances: `/api/mcp/usage/overview?${Array.from({ length: 21 }, (_, i) => `instance=i${i}`).join('&')}`,
  };
  await realPage(page);
  const real = {};
  for (const [name, path] of Object.entries(asked)) real[name] = await call(page, 'GET', path);
  // What the page reads is there: the usage that was just made, by the key, the methods and the client.
  expect(real.plain.status).toBe(200);
  expect(real.plain.body.totals.requests).toBeGreaterThanOrEqual(5);
  expect(real.plain.body.keys.map((item) => item.id)).toContain('all-data');
  expect(real.plain.body.methods.map((item) => item.method)).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'list_hosts', 'other', 'notifications/initialized']));
  // A client is a dimension of the window, named by its clientInfo: the rows are { client, ... }, and `group` is the name of what the series groups.
  expect(real.plain.body.clients.map((item) => item.client)).toContain('chdash-contract');
  expect(real.plain.body.group).toBe('method');
  expect(real.byClient.body.group).toBe('client');
  expect(real.byClient.body.series.groups.map((item) => item.id)).toEqual(['chdash-contract']);
  expect(real.byClient.body.clients.map((item) => item.client)).toContain('chdash-contract');
  // The series has five figures for each group, and a step in seconds (a minute for 1 h, 15 minutes for 24 h).
  expect(Object.keys(real.byClient.body.series.groups[0]).sort()).toEqual(['bytes', 'calls', 'duration_ms_sum', 'errors', 'id', 'label', 'requests', 'total']);
  expect(real.byClient.body.series.step).toBe(60);
  expect(real.byKey.body.series.step).toBe(900);
  expect(real.byClient.body.series.t).toHaveLength(60);
  expect(real.filtered.body.filters).toEqual({ key: ['all-data'], method: ['tools/list'], client: [], instance: [], result: [], type: [] });
  // The instance is a dimension: the answer lists the instances (this one first: its name, how its file was read, its figures and its keys in the
  // view, the facet of the filter by instance), a group by instance has one group for each, a filter keeps the instances that it names (a name that
  // nobody writes under is in the facet with zeros and its own status), and the lists that the server cuts say how many rows they left out.
  const instanceRow = real.plain.body.instances[0];
  expect(real.plain.body.instances.map((item) => item.instance)).toEqual([INSTANCE]);
  expect(instanceRow).toMatchObject({ status: 'ok', reason: '' });
  expect(wroteOrNot(instanceRow.written_at)).toBe(true);
  expect(Object.keys(instanceRow).sort()).toEqual(['bytes', 'calls', 'duration_ms_avg', 'duration_ms_max', 'errors', 'instance', 'keys', 'rate_limited', 'reason', 'rejected', 'requests', 'rows', 'status', 'written_at']);
  expect(instanceRow.requests).toBe(real.plain.body.totals.requests);
  expect(real.plain.body.omitted).toEqual({ keys: 0, methods: 0, results: 0, clients: 0, instances: 0 });
  expect(real.byInstance.body.group).toBe('instance');
  expect(real.byInstance.body.series.groups.map((item) => item.id)).toEqual([INSTANCE]);
  expect(real.ofInstance.body.filters.instance).toEqual([INSTANCE]);
  expect(real.ofInstance.body.totals.requests).toBe(real.plain.body.totals.requests);
  expect(real.ofOtherInstance.status).toBe(200);
  expect(real.ofOtherInstance.body.totals.requests).toBe(0);
  expect(real.ofOtherInstance.body.instances.map((item) => item.instance)).toEqual([INSTANCE, 'nobody-writes-this']);
  expect(real.ofOtherInstance.body.instances[1]).toMatchObject({ status: 'unknown', written_at: null, requests: 0 });
  expect(real.plain.body).not.toHaveProperty('persisted');
  expect(real.plain.body.keys.every((item) => typeof item.elsewhere === 'boolean')).toBe(true);
  // The refusals: a group or a value that is not one is 400 invalid; `split` (what `group` was called) and a parameter that is not one are
  // unknown; a kind of filter takes 20 values.
  expect(real.badGroup.status).toBe(400);
  expect(real.badGroup.body).toMatchObject({ error_code: 'validation', field: 'group', reason: 'invalid' });
  expect(real.oldSplit.status).toBe(400);
  expect(real.oldSplit.body).toMatchObject({ error_code: 'validation', field: 'split', reason: 'unknown' });
  expect(real.badClient.body).toMatchObject({ error_code: 'validation', field: 'client', reason: 'invalid' });
  expect(real.badInstance.body).toMatchObject({ error_code: 'validation', field: 'instance', reason: 'invalid' });
  expect(real.unknown.body).toMatchObject({ error_code: 'validation', field: 'bogus', reason: 'unknown' });
  expect(real.tooMany.body).toMatchObject({ error_code: 'validation', field: 'method', reason: 'too_many' });
  expect(real.tooManyClients.body).toMatchObject({ error_code: 'validation', field: 'client', reason: 'too_many' });
  expect(real.tooManyInstances.body).toMatchObject({ error_code: 'validation', field: 'instance', reason: 'too_many' });
  await fakePage(page, newServer());
  for (const [name, path] of Object.entries(asked)) compare({ real: real[name], fake: await call(page, 'GET', path) }, `usage overview, ${name}`);
});

test('POST then DELETE /api/mcp/keys: the grant has the shape the page reads, and the secret is given once', async ({ page }) => {
  const make = { name: `${PROBE}-api`, hosts: ['local'], tools: ['list_hosts'], databases: ['*'] };
  await realPage(page);
  const realCreated = await call(page, 'POST', '/api/mcp/keys', make);
  expect(realCreated.status).toBe(201);
  const realId = realCreated.body.key.id;
  // The secret is shown once: no later answer carries it, and the list holds its mask only.
  const realKeys = await call(page, 'GET', '/api/mcp/keys');
  expect(JSON.stringify(realKeys.body)).not.toContain(realCreated.body.secret);
  expect(realKeys.body.keys.find((key) => key.id === realId).secret_mask).toMatch(/^[0-9a-f]{8}-\u2022{4}-\u2022{4}-\u2022{4}-\u2022{12}$/);
  const realDeleted = await call(page, 'DELETE', `/api/mcp/keys/${realId}`);
  await fakePage(page, newServer());
  const fakeCreated = await call(page, 'POST', '/api/mcp/keys', { ...make, hosts: ['prod'] });
  compare({ real: realCreated, fake: fakeCreated }, 'create');
  compare({ real: realDeleted, fake: await call(page, 'DELETE', `/api/mcp/keys/${fakeCreated.body.key.id}`) }, 'delete');
});

test('the real page on the real server lists the config keys, makes a key, shows its secret once and deletes it', async ({ page, request }) => {
  await page.goto(`${BASE}/mcp-integration`);
  await expect(page.locator('#mcpWorkspace')).toBeVisible();
  const names = page.locator('#mcpKeysBody tbody tr .mcpKeyName');
  await expect(names.filter({ hasText: 'weather-only' })).toHaveCount(1, { timeout: 20_000 });
  await page.locator('#mcpNewKey').click();
  const d = page.locator('dialog.mcpDialog[open]');
  await expect(d).toBeVisible();
  await d.locator('#mcpField-name').fill(`${PROBE}-page`);
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created');
  const secret = await d.locator('#mcpSecret').inputValue();
  expect(secret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // Shown once: the list behind the dialog and the server's answers hold the mask only.
  const row = page.locator(`#mcpKeysBody tbody tr:has(.mcpKeyName:text-is("${PROBE}-page"))`);
  await expect(row.locator('.mcpSecret__text')).toHaveText(/^[0-9a-f]{8}-\u2022{4}\u2026$/);
  expect(JSON.stringify(await (await request.get(`${BASE}/api/mcp/keys`)).json())).not.toContain(secret);
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(secret);
  // The key works as a bearer on the endpoint, then goes: the real server deletes it.
  const tools = await request.post(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(tools.status(), await tools.text()).toBe(200);
  await row.locator('[data-action="remove"]').click();
  await page.locator('dialog.mcpDialog[open]').getByRole('button', { name: 'Delete key' }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });
  const after = await request.post(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  expect(after.status()).toBe(401);
});
