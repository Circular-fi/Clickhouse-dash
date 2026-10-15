import { test, expect } from '@playwright/test';
import { compareShapes, shapeOf } from '../helpers/shape.js';
import { newServer, install } from '../helpers/mcp-fake.js';
import { requireInstance } from '../helpers/instances.js';

// The fake MCP server of mcp-page.spec.js (helpers/mcp-fake.js) and the real one answer the same routes. This spec plays
// the same calls against both, from a page, and compares the shape of each answer: a key that the real JSON has and the
// fake lacks (or the other way round), or a type that differs, fails here instead of letting the page spec pass on a
// contract that no longer exists. It then drives the real page against the real server: the keys of the config file, a key
// made in the page (its secret shown once, never given back) and deleted.
// The instance: MCP_CONTRACT_BASE_URL, a server with tests/config/mcp.hcl and a writable /data (the `chdash_mcp` service of
// tests/docker-compose.yml).

const BASE = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');

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

// The page talks to the real server, or to the fake: its routes are the fake's while it is installed.
async function realPage(page) {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.goto(`${BASE}/query`);
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
    cost: await call(page, 'GET', `/api/mcp/keys/${realConfig.id}/cost?window=24h`),
    unknown: await call(page, 'GET', '/api/mcp/keys/nope/usage'),
    window: await call(page, 'GET', '/api/mcp/usage?window=48h'),
  };
  const fake = newServer();
  await fakePage(page, fake);
  const fakeConfig = fake.keys.find((key) => key.source === 'config');
  compare({ real: real.summary, fake: await call(page, 'GET', '/api/mcp/usage?window=7d') }, 'usage of the keys');
  compare({ real: real.usage, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/usage?window=24h`) }, 'usage of a key');
  compare({ real: real.cost, fake: await call(page, 'GET', `/api/mcp/keys/${fakeConfig.id}/cost?window=24h`) }, 'cost of a key');
  compare({ real: real.unknown, fake: await call(page, 'GET', '/api/mcp/keys/nope/usage') }, 'usage of an unknown key');
  compare({ real: real.window, fake: await call(page, 'GET', '/api/mcp/usage?window=48h') }, 'a window that the retention does not keep');
});

// The usage of every key (GET /api/mcp/usage/overview). A list that is empty accepts any shape, so the usage is made first on the real
// instance, with the key of the config file that reads everything (tests/config/mcp.hcl): an initialize that names a client, tools/list,
// a tool call, a method that nobody knows and a notification. Then the page's own calls are compared: the answer with nothing asked, a
// filtered one, one split by key, and the refusals (a split that does not exist, a value that is not valid, a parameter that is not one,
// more than 20 values).
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

test('GET /api/mcp/usage/overview: the same shape for the answer, a filtered one and a split by key, the same refusals', async ({ page, request }) => {
  await makeUsage(request);
  const asked = {
    plain: '/api/mcp/usage/overview',
    filtered: '/api/mcp/usage/overview?window=24h&split=result&key=all-data&method=tools/list',
    byKey: '/api/mcp/usage/overview?window=24h&split=key',
    byType: '/api/mcp/usage/overview?window=24h&split=type&type=call&type=request',
    badWindow: '/api/mcp/usage/overview?window=48h',
    badSplit: '/api/mcp/usage/overview?split=nope',
    badValue: '/api/mcp/usage/overview?key=BAD!',
    unknown: '/api/mcp/usage/overview?bogus=1',
    tooMany: `/api/mcp/usage/overview?${Array.from({ length: 21 }, (_, i) => `method=m${i}`).join('&')}`,
  };
  await realPage(page);
  const real = {};
  for (const [name, path] of Object.entries(asked)) real[name] = await call(page, 'GET', path);
  // What the page reads is there: the usage that was just made, by the key, the methods and the client.
  expect(real.plain.status).toBe(200);
  expect(real.plain.body.totals.requests).toBeGreaterThanOrEqual(5);
  expect(real.plain.body.keys.map((item) => item.id)).toContain('all-data');
  expect(real.plain.body.methods.map((item) => item.method)).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'list_hosts', 'other', 'notifications/initialized']));
  expect(real.plain.body.clients.map((item) => item.name)).toContain('chdash-contract');
  expect(real.filtered.body.filters).toEqual({ key: ['all-data'], method: ['tools/list'], result: [], type: [] });
  expect(real.badSplit.status).toBe(400);
  expect(real.badSplit.body).toMatchObject({ error_code: 'validation', field: 'split', reason: 'invalid' });
  expect(real.unknown.body).toMatchObject({ error_code: 'validation', field: 'bogus', reason: 'unknown' });
  expect(real.tooMany.body).toMatchObject({ error_code: 'validation', field: 'method', reason: 'too_many' });
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
