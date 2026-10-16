import { test, expect } from '@playwright/test';
import { compareShapes, shapeOf } from '../helpers/shape.js';
import { newServer, install, setUsage } from '../helpers/mcp-fake.js';
import { requireInstance } from '../helpers/instances.js';

// The fake MCP server of mcp-page.spec.js (helpers/mcp-fake.js) and the real server answer the same routes.
// This spec sends the same calls to both, from a page. It compares the shape of each answer.
// A key that the real JSON has and the fake lacks fails the test. So does the reverse.
// A type that differs also fails the test.
// This check stops the page spec from passing on a contract that no longer exists.
//
// The spec then drives the real page against the real server. It checks the keys of the config file. It makes a key in the page.
// The secret of that key is shown once, and it is never given back. Then the spec deletes the key.
// The instance is MCP_CONTRACT_BASE_URL. It is a server with tests/config/mcp.hcl and a writable /data (the `chdash_mcp` service of tests/docker-compose.yml).
// The usage is on in this instance, with `all_keys` on.
//
// The usage is off in the instance of tests/config/mcp.profile.hcl. Its URL is MCP_PROFILE_BASE_URL. Its service is `chdash_mcp_profile`. MCP is on, and there is no `mcp.usage` block.
//
// Keys that only another instance knows (`elsewhere`) cannot be made from a page. The directory belongs to the server.
// The shapes of these answers are the shapes of a one-instance answer: a list of instances, and a flag on every key.
// The test_mcp.py file plays the files of several instances against a real server.

const BASE = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');
// The contract instance records its usage under the name in mcp.usage.instance (tests/config/mcp.hcl).
// The name is fixed, because the host name of a container changes.
const PROFILE = (process.env.MCP_PROFILE_BASE_URL || '').replace(/\/$/, '');
const INSTANCE = 'chdash-mcp-test';
// The file of an instance is written once a minute, when something changed. An instance that has just started has `written_at: null`. That means no write yet.
const wroteOrNot = (value) => value === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value);

test.beforeEach(() => { requireInstance(test, 'MCP_CONTRACT_BASE_URL', BASE); });

// The instance keeps its keys between runs. Each test deletes what it made when the test ends, whether it failed or not.
// A name that a failed run left behind makes the next run fail with "a key named ... exists".
const PROBE = `probe-${Date.now().toString(36)}`;
test.afterEach(async ({ request }) => {
  if (!BASE) return;
  const keys = (await (await request.get(`${BASE}/api/mcp/keys`)).json()).keys || [];
  for (const key of keys.filter((entry) => entry.source === 'ui' && entry.name.startsWith(PROBE))) {
    await request.delete(`${BASE}/api/mcp/keys/${key.id}`, { headers: { 'Content-Type': 'application/json' } });
  }
});

// A call as the page makes it. The answer comes from whatever the page talks to: { status, body }.
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const response = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}, { method, path, body });

// The page talks to the real server or to the fake. While the fake is installed, its routes are the routes of the fake.
// `base` is another real instance: the one that has the usage off.
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
  // Ask the real server. The page talks to it.
  await realPage(page);
  const real = await requestOf(page);
  // Ask the fake. Load any page of the instance under test. The in-memory server answers the routes.
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

// The catalog of the tools has the flags `always`, `explicit_only` and `available` on every tool.
// It also has the family of the analysis of the keys: the limits and the usage of a key, and the usage of all of them.
// The fake's catalog is a part of the real catalog. It has the same family and the same flags for each tool.
test('GET /api/mcp/meta: the catalog says which tools every key has, which ones "*" leaves out and which ones are offered now', async ({ page }) => {
  await realPage(page);
  const real = await call(page, 'GET', '/api/mcp/meta');
  expect(real.status).toBe(200);
  const tool = (name) => real.body.tools.find((item) => item.name === name);
  expect(real.body.tool_groups.map((group) => group.id)).toContain('mcp_analysis');
  for (const item of real.body.tools) {
    for (const flag of ['always', 'explicit_only', 'available', 'needs_all_data']) expect(typeof item[flag], `${item.name}.${flag}`).toBe('boolean');
  }
  // Every key has its limits. While the usage is on, every key also has its own usage.
  // This is true whatever the list of the key says.
  // The usage of all the keys is in the list of a key only by its name, never by "*".
  // It is in the list only when mcp.usage.all_keys is on, and here it is on.
  expect(tool('mcp_analysis_my_limits')).toMatchObject({ group: 'mcp_analysis', always: true, explicit_only: false, available: true });
  expect(tool('mcp_analysis_my_usage')).toMatchObject({ group: 'mcp_analysis', always: true, explicit_only: false, available: true });
  expect(tool('mcp_analysis_all_usage')).toMatchObject({ group: 'mcp_analysis', always: false, explicit_only: true, available: true });
  expect(real.body.tools.filter((item) => item.always).map((item) => item.name).sort()).toEqual(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  expect(real.body.tools.filter((item) => item.explicit_only).map((item) => item.name)).toEqual(['mcp_analysis_all_usage']);
  expect(real.body.tools.filter((item) => !item.available)).toEqual([]);
  // The usage block shows these values. The usage is on. The storage is the files of a directory.
  // The instance is the one of the configuration. The all_keys setting is on.
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

// The usage is off, and there is no `mcp.usage` block. The meta says so.
// The analysis of the usage is not offered, but the limits of a key are.
// The three usage routes answer 404 `not_enabled`.
// The cost of a key does not come from the usage, so it still answers.
// The fake, in the same state, answers in the same way.
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
  // Every answer of the usage says which instances it sums. This instance comes first.
  // Each instance has a note of how its file was read. No answer has `persisted`.
  // A key has `elsewhere`. The value is true when only another instance knows the key.
  // Here there is one instance, so the value is false.
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
  // The step of the series is a number of seconds: 900 for 24 h, and 60 for 1 h, whatever the window.
  // The windows of the cost run from 1 h to 7 d.
  compare({ real: real.usageByMinute, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/usage?window=1h`) }, 'usage of a key in the last hour');
  expect(real.usage.body.series.step, 'the real step of 24 h').toBe(900);
  expect(real.usageByMinute.body.series.step, 'the real step of 1 h').toBe(60);
  expect(real.usageByMinute.body.series.points, 'the real points of 1 h').toHaveLength(60);
  compare({ real: real.cost, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=24h`) }, 'cost of a key');
  compare({ real: real.costOfAnHour, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=1h`) }, 'cost of a key in the last hour');
  compare({ real: real.unknown, fake: await call(page, 'GET', '/api/mcp/keys/nope/usage') }, 'usage of an unknown key');
  compare({ real: real.window, fake: await call(page, 'GET', '/api/mcp/usage?window=48h') }, 'a window that the retention does not keep');
});

// The usage of every key (GET /api/mcp/usage/overview). An empty list accepts any shape.
// So the test makes the usage first, on the real instance. It uses the key of the config file that reads everything (tests/config/mcp.hcl).
// The calls are an initialize that names a client, tools/list, a tool call, a method that nobody knows, and a notification.
//
// Then the test compares the page's own calls.
// They are: the answer with nothing asked, a filtered answer, and an answer grouped by key, by client or by instance.
// They also include an answer cut to an instance, the finest window, and the ranking of the groups.
// The ranking uses `order`, and `orders` with its `series.rankings`. This is the read that the six charts of the tab make.
//
// The test also checks the refusals.
// They are these refusals: the old `split`, a group that does not exist, and an order that is not one.
// A value that is not valid is refused, and so is a client or an instance that is not valid.
// A parameter that is not one is refused too, as are more than 20 values and more than 5 orders.
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
  // A request for a method that nobody knows gets a JSON-RPC error (200). A notification has no answer (202).
  expect(answers.map((answer) => answer.status())).toEqual([200, 200, 200, 200, 202]);
}

test('GET /api/mcp/usage/overview: the same shape for the answer, a filtered one, a group by key, by client and by result, the rankings of `orders`, the same refusals', async ({ page, request }) => {
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
    // The ranking of the groups uses one metric. That metric picks the 8 biggest groups (`order`).
    // More rankings come in the same read (`orders`). The page asks for them.
    ordered: '/api/mcp/usage/overview?window=24h&group=method&order=errors',
    rankings: '/api/mcp/usage/overview?window=7d&group=method&order=requests&orders=errors&orders=refused&orders=calls&orders=bytes',
    byResultErrors: '/api/mcp/usage/overview?window=24h&group=result&order=errors&orders=errors&orders=bytes',
    rankedAndFiltered: '/api/mcp/usage/overview?window=24h&group=method&method=tools/list&method=list_hosts&orders=errors&orders=bytes',
    repeatedOrders: '/api/mcp/usage/overview?window=24h&orders=calls&orders=errors&orders=calls',
    badWindow: '/api/mcp/usage/overview?window=48h',
    badGroup: '/api/mcp/usage/overview?group=nope',
    badOrder: '/api/mcp/usage/overview?order=bogus',
    badOrders: '/api/mcp/usage/overview?orders=bogus',
    // Six values. The number is checked before the values.
    // The sixth value is no order either, but the answer is `too_many`, not `invalid`.
    tooManyOrders: '/api/mcp/usage/overview?orders=requests&orders=errors&orders=refused&orders=calls&orders=bytes&orders=bogus',
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
  // The data that the page reads is there. It is the usage that was just made: by the key, the methods and the client.
  expect(real.plain.status).toBe(200);
  expect(real.plain.body.totals.requests).toBeGreaterThanOrEqual(5);
  expect(real.plain.body.keys.map((item) => item.id)).toContain('all-data');
  expect(real.plain.body.methods.map((item) => item.method)).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'list_hosts', 'other', 'notifications/initialized']));
  // A client is a dimension of the window. Its name comes from clientInfo. The rows are { client, ... }.
  // `group` is the name of what the series groups.
  expect(real.plain.body.clients.map((item) => item.client)).toContain('chdash-contract');
  expect(real.plain.body.group).toBe('method');
  expect(real.byClient.body.group).toBe('client');
  expect(real.byClient.body.series.groups.map((item) => item.id)).toEqual(['chdash-contract']);
  expect(real.byClient.body.clients.map((item) => item.client)).toContain('chdash-contract');
  // The series has six figures for each group. The sixth figure is the requests that were refused.
  // The step is in seconds: a minute for 1 h, and 15 minutes for 24 h.
  expect(Object.keys(real.byClient.body.series.groups[0]).sort()).toEqual(['bytes', 'calls', 'duration_ms_sum', 'errors', 'id', 'label', 'refused', 'requests', 'total']);
  expect(Object.keys(real.byClient.body.series.rest).sort()).toEqual(['bytes', 'calls', 'duration_ms_sum', 'errors', 'groups', 'refused', 'requests', 'total']);
  expect(real.byClient.body.series.step).toBe(60);
  expect(real.byKey.body.series.step).toBe(900);
  expect(real.byClient.body.series.t).toHaveLength(60);
  expect(real.filtered.body.filters).toEqual({ key: ['all-data'], method: ['tools/list'], client: [], instance: [], result: [], type: [] });
  // The instance is a dimension of the answer. The answer lists the instances. This instance comes first.
  // Its entry has its name, how its file was read, its figures, its keys in the view, and the facet of the filter by instance.
  // A group by instance has one group for each instance. A filter keeps only the instances that it names.
  // A name that nobody writes under is in the facet with zeros and its own status.
  // When the server cuts a list, the answer says how many rows it left out.
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
  // The answer repeats the order. The default order is requests. The series has no `rankings` unless `orders` asks for them.
  expect(real.plain.body.order).toBe('requests');
  expect(real.ordered.body.order).toBe('errors');
  expect(real.plain.body.series).not.toHaveProperty('rankings');
  expect(real.ordered.body.series).not.toHaveProperty('rankings');
  // `orders` is the read that the page makes. It gives one ranking for each value, in the order that was asked.
  // Each ranking has `groups` and `rest`, as the series has. The steps are those of the series, so a ranking does not repeat them.
  // The series itself still follows `order`.
  const ranked = real.rankings.body.series;
  expect(real.rankings.body.order).toBe('requests');
  expect(Object.keys(ranked.rankings)).toEqual(['errors', 'refused', 'calls', 'bytes']);
  for (const [name, ranking] of Object.entries(ranked.rankings)) {
    expect(Object.keys(ranking).sort(), name).toEqual(['groups', 'rest']);
    expect(ranking.groups.length, name).toBeLessThanOrEqual(8);
    for (const group of ranking.groups) expect(group.refused, name).toHaveLength(ranked.t.length);
    expect(ranking.rest.requests, name).toHaveLength(ranked.t.length);
  }
  expect(ranked.t).toHaveLength(56);
  expect(ranked.step).toBe(10800);
  // A method that has none of the metric of a ranking is in its `rest`. This is true even when there are fewer than 8 methods.
  // The instance keeps the data of the other specs too. So the test checks what a ranking must hold, not an exact list.
  // Each ranking holds every method once, and a group has some of its metric.
  // The contract traffic is there: the method that nobody knows made an error, and list_hosts made a call.
  const methods = ranked.groups.length + ranked.rest.groups;
  for (const [name, metric] of [['errors', 'errors'], ['refused', 'refused'], ['calls', 'calls'], ['bytes', 'bytes']]) {
    const ranking = ranked.rankings[name];
    expect(ranking.groups.length + ranking.rest.groups, `${name}: every method is in the ranking or in its rest`).toBe(methods);
    for (const group of ranking.groups) expect(group[metric].some((value) => value > 0), `${name}: ${group.id} has some`).toBe(true);
    expect(ranking.rest[metric].reduce((a, b) => a + b, 0) >= 0).toBe(true);
  }
  expect(ranked.rankings.errors.groups.map((item) => item.id)).toContain('other');
  expect(ranked.rankings.calls.groups.map((item) => item.id)).toContain('list_hosts');
  expect(ranked.rankings.errors.groups.map((item) => item.id)).not.toContain('initialize');
  // By result, and by errors, the groups are the error codes. `ok` has no error, so it is in `rest`.
  const codes = real.byResultErrors.body.series;
  expect(real.byResultErrors.body).toMatchObject({ group: 'result', order: 'errors' });
  expect(codes.groups.map((item) => item.id)).toContain('rpc_error_32601');
  expect(codes.groups.map((item) => item.id)).not.toContain('ok');
  for (const group of codes.groups) expect(group.errors.some((value) => value > 0), group.id).toBe(true);
  expect(codes.rest.groups).toBeGreaterThanOrEqual(1);
  expect(codes.rest.errors.reduce((a, b) => a + b, 0), 'ok has no error: the rest has none').toBe(0);
  expect(Object.keys(codes.rankings)).toEqual(['errors', 'bytes']);
  expect(codes.rankings.errors).toEqual({ groups: codes.groups, rest: codes.rest });
  // A filtered dimension keeps the values that were picked, in their order, in every ranking. The page then asks for no ranking.
  const picked = real.rankedAndFiltered.body.series;
  expect(picked.groups.map((item) => item.id)).toEqual(['tools/list', 'list_hosts']);
  for (const name of ['errors', 'bytes']) expect(picked.rankings[name]).toEqual({ groups: picked.groups, rest: picked.rest });
  expect(picked.rest.groups).toBe(0);
  // A repeated value in `orders` counts once. The rankings come in the order of the request.
  expect(real.repeatedOrders.status).toBe(200);
  expect(Object.keys(real.repeatedOrders.body.series.rankings)).toEqual(['calls', 'errors']);
  // The refusals are these. A group or a value that is not valid gives 400 invalid.
  // The old name `split`, which `group` replaced, is unknown. So is a parameter that is not valid.
  // A kind of filter takes 20 values at most.
  expect(real.badGroup.status).toBe(400);
  expect(real.badGroup.body).toMatchObject({ error_code: 'validation', field: 'group', reason: 'invalid' });
  expect(real.badOrder.status).toBe(400);
  expect(real.badOrder.body).toMatchObject({ error_code: 'validation', field: 'order', reason: 'invalid', message: 'order must be requests, errors, refused, calls or bytes' });
  expect(real.badOrders.status).toBe(400);
  expect(real.badOrders.body).toMatchObject({ error_code: 'validation', field: 'orders', reason: 'invalid', message: 'orders must be requests, errors, refused, calls or bytes' });
  expect(real.tooManyOrders.status).toBe(400);
  expect(real.tooManyOrders.body).toMatchObject({ error_code: 'validation', field: 'orders', reason: 'too_many' });
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
  // The secret is shown once. No later answer carries it. The list holds only its mask.
  const realKeys = await call(page, 'GET', '/api/mcp/keys');
  expect(JSON.stringify(realKeys.body)).not.toContain(realCreated.body.secret);
  expect(realKeys.body.keys.find((key) => key.id === realId).secret_mask).toMatch(/^mcp_[A-Za-z0-9_-]{8}\u2022{35}$/);
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
  // A token of the contract starts with mcp_. The rest is the base64url text of 32 random bytes.
  expect(secret).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/);
  // The secret is shown once. The list behind the dialog and the server answers hold only the mask.
  const row = page.locator(`#mcpKeysBody tbody tr:has(.mcpKeyName:text-is("${PROBE}-page"))`);
  await expect(row.locator('.mcpSecret__text')).toHaveText(/^mcp_[A-Za-z0-9_-]{8}\u2022\u2026$/);
  expect(JSON.stringify(await (await request.get(`${BASE}/api/mcp/keys`)).json())).not.toContain(secret);
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(secret);
  // The key works as a bearer token on the endpoint. Then the page deletes the key, and the real server refuses it.
  const tools = await request.post(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  expect(tools.status(), await tools.text()).toBe(200);
  await row.locator('[data-action="remove"]').click();
  await page.locator('dialog.mcpDialog[open]').getByRole('button', { name: 'Delete key' }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });
  const after = await request.post(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  expect(after.status()).toBe(401);
});
