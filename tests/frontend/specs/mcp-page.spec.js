import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';

// The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md): the endpoint
// of the MCP server built into ChDash, and the access keys of its clients. The server side is a
// small in-memory server behind page.route (the JSON of /api/mcp/*, as the contract fixes it), so the
// page runs on any instance: the page route and /api/version are answered here too. The page is not
// tied to a host and sits in the page switcher as "MCP" only when features.mcp.enabled.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.consoleErrors.filter((entry) => !/Failed to load resource/.test(entry.text))).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/mcp-page`;
const SECRET = 'chm_Zk3Qw9Lx0TnV7bYhR2dPaE5sUcJf8GmI';
const ROTATED = 'chm_Rt4Yp2Vn8KdWq6LsE1jXb9AhUc3FgMoZ';

const TOOLS = [
  { name: 'list_hosts', group: 'schema', description: 'Hosts of the key and their health.', needs_all_data: false },
  { name: 'list_databases', group: 'schema', description: 'Databases the key can see.', needs_all_data: false },
  { name: 'list_tables', group: 'schema', description: 'Tables, engines, rows and size.', needs_all_data: false },
  { name: 'describe_table', group: 'schema', description: 'Columns, keys, engine and CREATE statement.', needs_all_data: false },
  { name: 'query_table', group: 'read', description: 'Rows of one table: ChDash builds the SQL.', needs_all_data: false },
  { name: 'run_query', group: 'sql', description: 'One SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN.', needs_all_data: true },
  { name: 'explain_query', group: 'sql', description: 'EXPLAIN of a query.', needs_all_data: true },
];

const META = {
  enabled: true,
  endpoint_path: '/mcp',
  storage_configured: true,
  manage_from_ui: true,
  can_manage: true,
  protocol_versions: ['2025-06-18', '2025-03-26', '2024-11-05'],
  hosts: [
    { name: 'prod', label: 'Production cluster', healthy: true },
    { name: 'staging', label: 'staging', healthy: false },
    { name: 'lab', label: 'Lab', healthy: null },
  ],
  tools: TOOLS,
  limits: { max_rows: 1000, max_result_bytes: 1048576, query_timeout_seconds: 30, max_sql_bytes: 65536, max_memory_bytes: 1073741824, max_rows_to_read: 0, rate_limit_per_minute: 600 },
  name_pattern: '^[a-z0-9][a-z0-9_-]{0,63}$',
  secret_min_bytes: 24,
};

const key = (over) => ({
  id: 'ui_0a1b2c3d4e5f', name: 'ci-bot', description: 'Nightly checks', source: 'ui', secret_hint: 'chm_AbCdEf12',
  hosts: ['prod'], tools: ['list_databases', 'query_table'], databases: ['otel', 'analytics.events'],
  max_rows: null, timeout_seconds: null, expires_at: null, enabled: true, state: 'active',
  created_at: '2026-10-08T10:00:00Z', last_used_at: null, ...over,
});

const KEYS = () => [
  key({ id: 'ops-all', name: 'ops-all', description: 'Full access for operations', source: 'config', secret_hint: '', hosts: ['*'], tools: ['*'], databases: ['*'], max_rows: 200, timeout_seconds: 10 }),
  key({}),
  key({ id: 'ui_111111111111', name: 'reporting', description: '', hosts: ['prod', 'staging'], databases: ['*'], tools: ['list_hosts', 'run_query'], last_used_at: '2026-10-07T08:30:00Z', expires_at: '2027-01-01T23:59:59Z' }),
  key({ id: 'ui_222222222222', name: 'paused', enabled: false, state: 'disabled' }),
  key({ id: 'ui_333333333333', name: 'old-key', state: 'expired', expires_at: '2026-01-01T23:59:59Z' }),
];

// The server: meta and keys in memory; every call recorded. `errors` makes the next call of a route fail.
function newServer(over = {}) {
  const server = { keys: KEYS(), calls: [], errors: {}, delay: {}, version: { mcp: { enabled: true } }, ...over };
  server.meta = { ...structuredClone(META), ...(over.meta || {}) };
  return server;
}

const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });

async function install(page, server) {
  // The shell is served at /mcp-integration only when the instance has MCP on: the request is sent on to
  // the shell's static file, which the document then shows under the page's own address.
  await page.route('**/mcp-integration', (route) => route.continue({ url: new URL('/static/mcp.html', route.request().url()).href }));
  await page.route('**/api/version', async (route) => {
    // A test that ends while this request is in flight disposes the response: nothing is left to answer.
    try {
      const response = await route.fetch();
      const body = await response.json();
      body.features = { ...body.features, ...server.version };
      await json(route, 200, body);
    } catch (error) {
      if (!/disposed|closed|ended/i.test(String(error && error.message))) throw error;
    }
  });
  await page.route('**/api/mcp/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/mcp/, '');
    const method = request.method();
    const body = method === 'GET' || method === 'DELETE' ? null : (request.postDataJSON() ?? null);
    server.calls.push({ method, path, body });
    const failure = server.errors[`${method} ${path}`] || server.errors[`${method} *`];
    if (failure) {
      if (!failure.keep) {
        delete server.errors[`${method} ${path}`];
        delete server.errors[`${method} *`];
      }
      return json(route, failure.status, failure.body);
    }
    const wait = server.delay[`${method} ${path}`];
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (method === 'GET' && path === '/meta') return json(route, 200, server.meta);
    if (!server.meta.enabled) return json(route, 404, { error: 'mcp_disabled', message: 'MCP is turned off.' });
    if (method === 'GET' && path === '/keys') return json(route, 200, { keys: server.keys });
    if (method === 'POST' && path === '/keys') {
      const created = key({ id: 'ui_aabbccddeeff', name: body.name, description: body.description || '', hosts: body.hosts, tools: body.tools, databases: body.databases, max_rows: body.max_rows ?? null, timeout_seconds: body.timeout_seconds ?? null, expires_at: body.expires_at ?? null, secret_hint: SECRET.slice(0, 12) });
      server.keys.push(created);
      return json(route, 201, { key: created, secret: SECRET });
    }
    const match = /^\/keys\/([^/]+)(\/rotate)?$/.exec(path);
    const found = match ? server.keys.find((k) => k.id === decodeURIComponent(match[1])) : null;
    if (!found) return json(route, 404, { error: 'not_found', message: 'No such key.' });
    if (found.source === 'config') return json(route, 409, { error: 'config_key', message: 'A key of the config file cannot change here.' });
    if (method === 'POST' && match[2]) return json(route, 200, { key: found, secret: ROTATED });
    if (method === 'PATCH') {
      Object.assign(found, body);
      if (body.enabled !== undefined) found.state = found.enabled ? 'active' : 'disabled';
      return json(route, 200, { key: found });
    }
    if (method === 'DELETE') {
      server.keys = server.keys.filter((k) => k !== found);
      return json(route, 200, { ok: true, id: found.id });
    }
    return json(route, 404, { error: 'not_found', message: 'No such route.' });
  });
}

async function open(page, server = newServer()) {
  await install(page, server);
  await page.goto('/mcp-integration');
  await page.waitForFunction(() => !!(window.ChDash?.features && window.ChDash?.mcpView));
  return server;
}

const rows = (page) => page.locator('#mcpKeysBody tbody tr');
const row = (page, name) => page.locator(`#mcpKeysBody tbody tr:has(.mcpKeyName:text-is("${name}"))`);
const dialog = (page) => page.locator('dialog.mcpDialog[open]');

async function screenshot(page, name) {
  // A dialog fades in: the picture waits for its end.
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shotsDir}/${name}.png`, fullPage: false });
}

test('the page is a page of its own: shell, modules, one heading, no host picker', async ({ page }) => {
  await open(page);
  await expect(page.locator('body')).toHaveAttribute('data-page', 'mcp');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('MCP integration');
  await expect(page).toHaveTitle(/MCP integration/);
  const state = await page.evaluate(() => ({
    page: window.ChDash.loader.page.name,
    scripts: [...document.scripts].map((s) => (s.getAttribute('src') || '').split('/').pop().split('?')[0]).filter(Boolean),
    sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0]),
  }));
  expect(state.page).toBe('mcp');
  expect(state.sheets).toEqual(['style.mcp.css']);
  for (const name of ['app_mcp_page.js', 'app_mcp_view.js', 'app_mcp_form.js', 'app_api.js']) expect(state.scripts, name).toContain(name);
  for (const name of ['app_explorer.js', 'app_system_view.js', 'app_traces.js', 'app_logs.js', 'app_sql.js']) expect(state.scripts, name).not.toContain(name);
  expect(new Set(state.scripts).size).toBe(state.scripts.length);
  // Not tied to a host: the picker is not on screen, the switcher and the theme are.
  await expect(page.locator('#hostPicker')).toBeHidden();
  await expect(page.locator('#pageSelect')).toBeVisible();
  await expect(page.locator('#themeSelect')).toBeVisible();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
});

test('the chrome is the one of System: a bar under the header, full width, no visible heading', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const h1 = box('h1');
    const bar = box('#mcpBar');
    const header = box('body > .appHeader');
    const gutter = parseFloat(getComputedStyle(document.querySelector('#mcpPanel')).paddingLeft);
    return {
      h1: [h1.width, h1.height],
      barTop: bar.top - header.bottom,
      barLeft: bar.left,
      barRight: window.innerWidth - bar.right,
      barClass: document.querySelector('#mcpBar').className,
      refreshRight: window.innerWidth - box('#mcpRefresh').right,
      newKeyRight: window.innerWidth - box('#mcpNewKey').right,
      gutter,
      contentLeft: box('#mcpHead').left,
      keysRight: window.innerWidth - box('#mcpKeysBody table').right,
      tiles: document.querySelector('.mcpTiles').className,
    };
  });
  // The heading stays for the screen reader; the switcher says where the reader is.
  expect(m.h1[0]).toBeLessThanOrEqual(1);
  expect(m.h1[1]).toBeLessThanOrEqual(1);
  // The bar is the filter bar: edge to edge, right under the header; Refresh then New key end it.
  expect(m.barClass).toContain('obsFilterBar');
  expect(Math.abs(m.barTop)).toBeLessThanOrEqual(1);
  expect(m.barLeft).toBe(0);
  expect(m.barRight).toBe(0);
  expect(m.newKeyRight).toBeCloseTo(m.gutter, 0);
  expect(m.refreshRight).toBeGreaterThan(m.newKeyRight);
  await expect(page.locator('#mcpRefresh')).toHaveClass(/refreshButton/);
  await expect(page.locator('#mcpNewKey')).toHaveClass(/button--primary/);
  // The content is full width with the standard gutter, not a centred column.
  expect(m.gutter).toBe(12);
  expect(m.contentLeft).toBe(m.gutter);
  expect(m.keysRight).toBeGreaterThanOrEqual(m.gutter - 1);
  expect(m.keysRight).toBeLessThanOrEqual(m.gutter + 14);
  // The shared components: stat tiles, parts, a compact data table, badges.
  expect(m.tiles).toContain('statTiles--boxed');
  await expect(page.locator('#mcpEndpoint.pagePart .pagePart__title')).toHaveText('Endpoint');
  // The status badges sit beside that title, not in the bar: the bar holds Refresh and New key only.
  await expect(page.locator('#mcpEndpoint .pagePart__head .mcpBadges .badge')).toHaveCount(3);
  await expect(page.locator('#mcpBar .badge')).toHaveCount(0);
  await expect(page.locator('#mcpKeysBody table')).toHaveClass(/dataTable--compact/);
  await expect(page.locator('#mcpKeysBody .dataTableWrap')).toHaveCount(1);
  await expect(page.locator('#mcpEndpointUrl')).toHaveClass(/uiInput/);
  await expect(page.locator('label[for="mcpEndpointUrl"]')).toHaveClass(/uiField__label/);
  await expect(row(page, 'ci-bot').locator('td').nth(6).locator('.badge')).toHaveText('Active');
});

test('the page switcher lists MCP, selected on this page, and every other page can open it', async ({ page }) => {
  await open(page);
  await page.locator('#pageSelectButton').click();
  const options = page.locator('#pageSelectMenu .themeSelect__option:visible');
  // The menu lists the other pages: the page's own entry is the button's label.
  await expect(options).toHaveText(['Query', 'Explorer', 'Observability', 'System']);
  await expect(page.locator('#navMcpButton')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pageSelectButton')).toHaveText('MCP');
  await page.keyboard.press('Escape');
  // From another page: the entry is there once /api/version reports features.mcp.enabled, and opens the page.
  await page.goto('/query');
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Explorer', 'Observability', 'System', 'MCP']);
  await page.locator('#navMcpButton').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // Going back to Query from MCP.
  await page.locator('#pageSelectButton').click();
  await page.locator('#navQueryButton').click();
  await expect(page).toHaveURL(/\/query$/);
});

test('the MCP entry is hidden while features.mcp is off, and its page shows how to turn MCP on', async ({ page }) => {
  const server = newServer({ version: { mcp: { enabled: false } }, meta: { enabled: false } });
  server.meta = { enabled: false };
  await install(page, server);
  await page.goto('/system');
  await page.locator('#pageSelectButton').click();
  expect(await page.locator('#pageSelectMenu .themeSelect__option:visible').allTextContents()).not.toContain('MCP');
  await expect(page.locator('#navMcpButton')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.goto('/mcp-integration');
  await expect(page.locator('.mcpOff')).toBeVisible();
  await expect(page.locator('.mcpOff')).toContainText('MCP is off');
  const hcl = page.locator('.mcpOff .mcpCode__pre');
  await expect(hcl).toContainText('mcp {');
  await expect(hcl).toContainText('enabled        = true');
  await expect(hcl).toContainText('mcp_uri');
  await expect(page.locator('#mcpKeys')).toBeHidden();
  await expect(page.locator('#mcpNewKey')).toHaveCount(0);
  expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /meta']);
});

test('the header block: endpoint URL with a copy button, state badges, hosts with their health, limits, help', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  await expect(page.locator('#mcpEndpointUrl')).toHaveValue(`${origin}/mcp`);
  const badges = page.locator('.mcpBadges [role="listitem"]');
  await expect(badges).toHaveText(['MCP enabled', 'Storage configured', 'Managed from the UI']);
  const hosts = page.locator('.mcpHosts tbody tr');
  await expect(hosts).toHaveCount(3);
  await expect(hosts.nth(0)).toContainText('prod');
  await expect(hosts.nth(0)).toContainText('Production cluster');
  // Health reads as a badge of the shared component, and the hosts are a data table.
  await expect(hosts.nth(0).locator('.badge--ok')).toHaveText('healthy');
  await expect(page.locator('#mcpHosts .dataTable--compact')).toHaveCount(1);
  await expect(hosts.nth(0)).toContainText('healthy');
  await expect(hosts.nth(1)).toContainText('down');
  await expect(hosts.nth(2)).toContainText('unknown');
  const tiles = page.locator('.mcpTiles .statTile');
  await expect(tiles).toHaveCount(7);
  await expect(page.locator('.mcpTiles')).toContainText('1,000');
  await expect(page.locator('.mcpTiles')).toContainText('30 s');
  await expect(page.locator('.mcpTiles')).toContainText('1.0 MB');
  await expect(page.locator('.mcpTiles')).toContainText('No limit');
  await expect(page.locator('.mcpTiles')).toContainText('600');
  // The copy button gives its feedback.
  const copy = page.locator('.mcpEndpoint__copy');
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  // "Connect a client": closed while keys exist, with the commands built from the real origin.
  const help = page.locator('#mcpHelp');
  await expect(help).not.toHaveJSProperty('open', true);
  await help.locator('summary').click();
  // One tab for each client: Claude Code first, then Claude Desktop, MCP Inspector and a JSON file.
  await expect(help.getByRole('group', { name: 'Client' }).getByRole('button')).toHaveText(['Claude Code', 'Claude Desktop', 'MCP Inspector', 'JSON']);
  await expect(help.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "Authorization: Bearer <secret>"`);
  await help.getByRole('button', { name: 'Claude Desktop' }).click();
  const desktop = JSON.parse(await help.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre').innerText());
  expect(desktop.mcpServers['chdash-name']).toEqual({ command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: 'Bearer <secret>' } });
  await help.getByRole('button', { name: 'MCP Inspector' }).click();
  await expect(help.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`URL              ${origin}/mcp`);
  await help.getByRole('button', { name: 'JSON' }).click();
  await expect(help.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`"url": "${origin}/mcp"`);
  await expect(help).toContainText('2025-06-18');
});

test('the keys table: name, source, scope, limits, expiry, last use, state and the actions', async ({ page }) => {
  await open(page);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('5');
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Source', 'Scope', 'Limits', 'Expires', 'Last used', 'State', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  // Rows keep the order the API gives.
  await expect(rows(page).locator('.mcpKeyName')).toHaveText(['ops-all', 'ci-bot', 'reporting', 'paused', 'old-key']);
  const config = row(page, 'ops-all');
  await expect(config.locator('td').nth(1)).toHaveText('config');
  await expect(config).toContainText('All hosts');
  await expect(config).toContainText('All tools');
  await expect(config).toContainText('All data');
  await expect(config).toContainText('200');
  await expect(config).toContainText('10 s');
  await expect(config.locator('td').nth(6)).toHaveText('Active');
  const ui = row(page, 'ci-bot');
  await expect(ui.locator('td').nth(1)).toHaveText('ui');
  await expect(ui).toContainText('chm_AbCdEf12');
  await expect(ui).toContainText('Nightly checks');
  await expect(ui).toContainText('2 tools: list_databases, query_table');
  await expect(ui).toContainText('otel, analytics.events');
  await expect(ui).toContainText('1,000 (default)');
  await expect(ui.locator('td').nth(4)).toHaveText('Never');
  await expect(ui.locator('td').nth(5)).toHaveText('Never');
  const reporting = row(page, 'reporting');
  await expect(reporting).toContainText('prod, staging');
  await expect(reporting.locator('td').nth(4)).not.toHaveText('Never');
  await expect(reporting.locator('td').nth(4).locator('time')).toHaveAttribute('datetime', '2027-01-01T23:59:59.000Z');
  await expect(reporting.locator('td').nth(5).locator('time')).toHaveAttribute('datetime', '2026-10-07T08:30:00.000Z');
  await expect(row(page, 'paused').locator('td').nth(6)).toHaveText('Disabled');
  await expect(row(page, 'old-key').locator('td').nth(6)).toHaveText('Expired');
  // Actions: a config key is read-only (one line "Config file" with the reason, no button), a UI key has all four.
  await expect(config.locator('[data-action]')).toHaveCount(0);
  await expect(config.locator('.mcpLocked')).toHaveText('Config file');
  await expect(config.locator('.mcpLocked')).toHaveAttribute('title', /Read-only: this key comes from the config file/);
  for (const action of ['edit', 'toggle', 'rotate', 'remove']) {
    await expect(ui.locator(`[data-action="${action}"]`)).toBeEnabled();
  }
  await expect(ui.locator('[data-action="toggle"]')).toHaveAttribute('aria-label', 'Disable ci-bot');
  await expect(row(page, 'paused').locator('[data-action="toggle"]')).toHaveAttribute('aria-label', 'Enable paused');
  await screenshot(page, 'keys-desktop');
});

test('loading skeleton, error with Retry, empty list', async ({ page }) => {
  const server = newServer();
  server.delay['GET /keys'] = 700;
  await install(page, server);
  await page.goto('/mcp-integration');
  await expect(page.locator('#mcpKeysBody .uiState--loading')).toBeVisible();
  await expect(page.locator('#mcpKeysBody .uiState--loading')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // An error of the keys call: the message and Retry.
  server.errors['GET /keys'] = { status: 500, body: { error: 'storage_error', message: 'The key storage could not be read.' } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('#mcpAlert')).toContainText('The key storage could not be read.');
  server.errors['GET /keys'] = { status: 500, body: { error: 'storage_error', message: 'The key storage could not be read.' } };
  await page.reload();
  const error = page.locator('#mcpKeysBody .uiState--error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Could not load the keys');
  await expect(error).toContainText('The key storage could not be read.');
  await error.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // An error of the meta call: the header block's state.
  server.errors['GET /meta'] = { status: 500, body: { error: 'internal', message: 'Meta failed.' } };
  await page.reload();
  await expect(page.locator('#mcpHead .uiState--error')).toContainText('Meta failed.');
  await page.locator('#mcpHead').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // Empty list.
  server.keys = [];
  await page.reload();
  const empty = page.locator('#mcpKeysBody .uiState--empty');
  await expect(empty).toContainText('No access keys yet');
  await expect(empty.getByRole('button', { name: 'New key' })).toBeVisible();
  // The help stays closed: the empty state and its New key come first.
  await expect(page.locator('#mcpHelp')).toHaveJSProperty('open', false);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('0');
});

test('storage not configured: creation is off with the reason, the config keys still list', async ({ page }) => {
  const server = newServer({ meta: { storage_configured: false, can_manage: false } });
  server.keys = [server.keys[0]];
  await open(page, server);
  await expect(page.locator('.mcpBadges')).toContainText('No storage file');
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(page.locator('#mcpNewKey')).toHaveAttribute('title', /mcp\.storage_file is not set/);
  await expect(page.locator('#mcpKeysNote')).toContainText('mcp.storage_file is not set');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'ops-all')).toBeVisible();
  await expect(page.locator('#mcpKeysBody [data-action]:enabled')).toHaveCount(0);
});

test('manage_from_ui = false: a read-only page', async ({ page }) => {
  const server = newServer({ meta: { manage_from_ui: false, can_manage: false } });
  await open(page, server);
  await expect(page.locator('.mcpBadges')).toContainText('Read-only');
  await expect(page.locator('#mcpKeysNote')).toContainText('manage_from_ui is false');
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('#mcpKeysBody [data-action]')).toHaveCount(0);
  await expect(row(page, 'ci-bot').locator('.mcpLocked')).toHaveText('Read-only');
  await expect(row(page, 'ci-bot').locator('.mcpLocked')).toHaveAttribute('title', /manage_from_ui is false/);
});

test('New key: the SQL tools stay off, with their reason, until All data', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('New key');
  // Hosts: All hosts and one box per host.
  await expect(dialog(page).locator('#mcpHost-all')).not.toBeChecked();
  await expect(dialog(page).locator('[id^="mcpHost-"]:not(#mcpHost-all)')).toHaveCount(3);
  // Tools in three groups, from /api/mcp/meta, with their descriptions.
  await expect(dialog(page).locator('.mcpToolGroup__title')).toHaveText(['Schema', 'Read', 'SQL']);
  await expect(dialog(page).locator('.mcpToolGroup').first()).toContainText('Databases the key can see.');
  const sql = ['run_query', 'explain_query'].map((name) => dialog(page).locator(`#mcpTool-${name}`));
  for (const box of sql) {
    await expect(box).toBeDisabled();
    await expect(box).not.toBeChecked();
  }
  await expect(dialog(page).locator('#mcpToolReason-sql')).toContainText('Needs All data');
  await expect(dialog(page).locator('#mcpTool-run_query')).toHaveAttribute('aria-describedby', 'mcpToolReason-sql');
  // The schema and read tools start on.
  await expect(dialog(page).locator('#mcpTool-query_table')).toBeChecked();
  // All data enables them (off until the user picks them) and the patterns box is off.
  await dialog(page).locator('#mcpData-all').check();
  await expect(dialog(page).locator('#mcpField-databases')).toBeDisabled();
  for (const box of sql) await expect(box).toBeEnabled();
  await expect(dialog(page).locator('#mcpToolReason-sql')).toBeHidden();
  await sql[0].check();
  // Back to selected data: the SQL tools are cleared and off again.
  await dialog(page).locator('#mcpData-list').check();
  await expect(sql[0]).toBeDisabled();
  await expect(sql[0]).not.toBeChecked();
  await expect(dialog(page).locator('#mcpField-databases')).toBeEnabled();
  await screenshot(page, 'form-desktop');
});

test('create a key: the request, the one-time secret and its commands, nothing left behind', async ({ page }) => {
  const server = await open(page);
  const origin = new URL(page.url()).origin;
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpField-description').fill('Read-only analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpData-list').check();
  await d.locator('#mcpField-databases').fill('otel\nanalytics.events\n\nlogs_*.*');
  await d.locator('#mcpTool-run_query').check({ force: true }).catch(() => {});
  await d.locator('#mcpField-max_rows').fill('200');
  await d.locator('#mcpField-timeout_seconds').fill('10');
  await d.locator('#mcpField-expires_at').fill('2027-03-01');
  await d.getByRole('button', { name: 'Create key' }).click();
  // The secret panel: once, with the copy buttons and the commands from the real origin.
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created');
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body).toEqual({
    name: 'analyst', description: 'Read-only analyst', hosts: ['prod'], databases: ['otel', 'analytics.events', 'logs_*.*'],
    tools: ['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table'], max_rows: 200, timeout_seconds: 10, expires_at: '2027-03-01T23:59:59Z',
  });
  const commands = d.locator('.mcpCode__pre');
  await expect(commands.nth(0)).toHaveText(`claude mcp add --transport http chdash-analyst ${origin}/mcp --header "Authorization: Bearer ${SECRET}"`);
  await d.getByRole('button', { name: 'JSON' }).click();
  const config = JSON.parse(await d.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre').innerText());
  expect(config).toEqual({ mcpServers: { 'chdash-analyst': { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${SECRET}` } } } });
  await d.locator('.mcpEndpoint__copy').click();
  await expect(d.locator('.mcpEndpoint__copy')).toHaveClass(/is-copied/);
  // Never in the browser's storage, never in the address, not even while it shows.
  const storage = () => page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href, document.cookie]));
  expect(await storage()).not.toContain(SECRET);
  await screenshot(page, 'secret-desktop');
  // The list behind it is already drawn again, with the hint only.
  await expect(row(page, 'analyst')).toHaveCount(1);
  await expect(row(page, 'analyst')).toContainText('chm_Zk3Qw9Lx');
  await expect(row(page, 'analyst')).not.toContainText(SECRET);
  // Done: the dialog and every node that held the secret leave the page.
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain('Bearer chm_');
  expect(await storage()).not.toContain(SECRET);
  await expect(row(page, 'analyst').locator('[data-action="edit"]')).toBeFocused();
});

test('the secret panel closes with Escape and the close button, and clears the DOM the same way', async ({ page }) => {
  await open(page);
  for (const how of ['Escape', 'cross']) {
    await page.locator('#mcpNewKey').click();
    const d = dialog(page);
    await d.locator('#mcpField-name').fill(how === 'Escape' ? 'by-escape' : 'by-cross');
    await d.locator('#mcpHost-all').check();
    await d.locator('#mcpData-all').check();
    await d.getByRole('button', { name: 'Create key' }).click();
    await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await d.locator('.uiDialog__close').click();
    await expect(page.locator('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET);
  }
});

test('validation: the form refuses a bad name, no host, no data and no tool, next to each field', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const create = d.getByRole('button', { name: 'Create key' });
  await create.click();
  await expect(d.locator('#mcpFieldError-name')).toContainText('Enter a name.');
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-invalid', 'true');
  await expect(d.locator('#mcpField-name')).toBeFocused();
  await d.locator('#mcpField-name').fill('Bad Name');
  await create.click();
  await expect(d.locator('#mcpFieldError-name')).toContainText('lower-case letters');
  await d.locator('#mcpField-name').fill('good-name');
  await create.click();
  await expect(d.locator('#mcpFieldError-name')).toBeHidden();
  await expect(d.locator('#mcpFieldError-hosts')).toContainText('Select at least one host.');
  await d.locator('#mcpHost-0').check();
  await create.click();
  await expect(d.locator('#mcpFieldError-databases')).toContainText('Choose All data');
  await expect(d.locator('#mcpField-databases')).toBeFocused();
  await d.locator('#mcpField-databases').fill('otel');
  await d.locator('#mcpToolsNone').click();
  await create.click();
  await expect(d.locator('#mcpFieldError-tools')).toContainText('Select at least one tool.');
  await d.locator('#mcpToolsAll').click();
  await d.locator('#mcpField-max_rows').fill('0');
  await create.click();
  await expect(d.locator('#mcpFieldError-max_rows')).toContainText('whole number');
  // Nothing was sent.
  expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await expect(d).toBeVisible();
});

test('server validation errors show next to their field, and the dialog stays open', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
  // A validation error with a field and a reason.
  server.errors['POST /keys'] = { status: 400, body: { error: 'validation', message: 'The pattern "otel" names no database.', field: 'databases', reason: 'invalid' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-databases')).toHaveText('The pattern "otel" names no database.');
  await expect(d.locator('#mcpField-databases')).toHaveAttribute('aria-invalid', 'true');
  await expect(d.locator('#mcpField-databases')).toBeFocused();
  await expect(d).toBeVisible();
  // A reason without a sentence, on an indexed field: the page's own sentence.
  server.errors['POST /keys'] = { status: 400, body: { error: 'validation', field: 'hosts[0]', reason: 'unknown_host' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-hosts')).toContainText('no mcp_uri');
  // A name that is taken (409) shows under the name.
  server.errors['POST /keys'] = { status: 409, body: { error: 'name_taken', message: 'A key named "analyst" exists.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-name')).toContainText('A key named "analyst" exists.');
  await expect(d.locator('#mcpField-name')).toBeFocused();
  // An error with no field shows at the foot of the dialog.
  server.errors['POST /keys'] = { status: 500, body: { error: 'storage_error', message: 'The storage file could not be written.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.uiDialog__error')).toContainText('The storage file could not be written.');
  await expect(d).toBeVisible();
  // The next try works, and the old errors are gone.
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
});

test('edit a key: the form holds its values, the PATCH sends them, a taken name shows on the field', async ({ page }) => {
  const server = await open(page);
  await row(page, 'reporting').locator('[data-action="edit"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Edit key reporting');
  await expect(d.locator('#mcpField-name')).toHaveValue('reporting');
  await expect(d.locator('#mcpHost-0')).toBeChecked();
  await expect(d.locator('#mcpHost-1')).toBeChecked();
  await expect(d.locator('#mcpHost-2')).not.toBeChecked();
  await expect(d.locator('#mcpData-all')).toBeChecked();
  await expect(d.locator('#mcpTool-run_query')).toBeChecked();
  await expect(d.locator('#mcpTool-run_query')).toBeEnabled();
  await expect(d.locator('#mcpField-expires_at')).toHaveValue('2027-01-01');
  // A taken name.
  server.errors['PATCH /keys/ui_111111111111'] = { status: 409, body: { error: 'name_taken', message: 'Another key has this name.' } };
  await d.locator('#mcpField-name').fill('ci-bot');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(d.locator('#mcpFieldError-name')).toHaveText('Another key has this name.');
  // A save: the date left as it was keeps the stored instant.
  await d.locator('#mcpField-name').fill('reporting-2');
  await d.locator('#mcpField-max_rows').fill('50');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const patch = server.calls.filter((call) => call.method === 'PATCH').pop();
  expect(patch.body).toMatchObject({ name: 'reporting-2', hosts: ['prod', 'staging'], databases: ['*'], max_rows: 50, timeout_seconds: null, expires_at: '2027-01-01T23:59:59Z' });
  await expect(row(page, 'reporting-2')).toContainText('50');
  await expect(row(page, 'reporting-2').locator('[data-action="edit"]')).toBeFocused();
});

test('disable asks first, enable does not; both reload the state', async ({ page }) => {
  const server = await open(page);
  const toggle = row(page, 'ci-bot').locator('[data-action="toggle"]');
  await toggle.click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Disable key ci-bot?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  expect(server.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  await expect(toggle).toBeFocused();
  await toggle.click();
  await dialog(page).getByRole('button', { name: 'Disable key' }).click();
  await expect(row(page, 'ci-bot').locator('td').nth(6)).toHaveText('Disabled');
  expect(server.calls.filter((call) => call.method === 'PATCH').pop()).toMatchObject({ path: '/keys/ui_0a1b2c3d4e5f', body: { enabled: false } });
  await expect(row(page, 'ci-bot').locator('[data-action="toggle"]')).toHaveAttribute('aria-label', 'Enable ci-bot');
  await row(page, 'ci-bot').locator('[data-action="toggle"]').click();
  await expect(row(page, 'ci-bot').locator('td').nth(6)).toHaveText('Active');
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(server.calls.filter((call) => call.method === 'PATCH').pop().body).toEqual({ enabled: true });
});

test('rotate asks first, then shows the new secret once; the old one is named dead', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="rotate"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Rotate the secret of ci-bot?');
  await expect(d).toContainText('The old secret stops working at once.');
  await d.getByRole('button', { name: 'Cancel' }).click();
  expect(server.calls.filter((call) => call.path.endsWith('/rotate'))).toHaveLength(0);
  await row(page, 'ci-bot').locator('[data-action="rotate"]').click();
  await dialog(page).getByRole('button', { name: 'Rotate secret' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('New secret');
  await expect(dialog(page)).toContainText('The old secret stopped working at once.');
  await expect(dialog(page).locator('#mcpSecret')).toHaveValue(ROTATED);
  await expect(dialog(page).locator('.mcpCode__pre').first()).toContainText(`Bearer ${ROTATED}`);
  await dialog(page).getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(ROTATED);
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]))).not.toContain(ROTATED);
  await expect(row(page, 'ci-bot').locator('[data-action="rotate"]')).toBeFocused();
});

test('delete asks first and removes the key', async ({ page }) => {
  const server = await open(page);
  await row(page, 'paused').locator('[data-action="remove"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Delete key paused?');
  // The focus starts on Cancel: the action destroys something.
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows(page)).toHaveCount(5);
  await row(page, 'paused').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(row(page, 'paused')).toHaveCount(0);
  expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/keys/ui_222222222222', body: null }]);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('4');
});

test('a failed action shows its error above the table; a key that is gone reloads the list', async ({ page }) => {
  const server = await open(page);
  server.errors['PATCH /keys/ui_0a1b2c3d4e5f'] = { status: 500, body: { error: 'storage_error', message: 'The storage file could not be written.' } };
  await row(page, 'ci-bot').locator('[data-action="toggle"]').click();
  await dialog(page).getByRole('button', { name: 'Disable key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('The storage file could not be written.');
  await expect(row(page, 'ci-bot').locator('td').nth(6)).toHaveText('Active');
  // Someone else deleted a key meanwhile.
  server.keys = server.keys.filter((k) => k.name !== 'paused');
  await row(page, 'paused').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('No such key.');
  await expect(row(page, 'paused')).toHaveCount(0);
});

test('the document never scrolls: the workspace is the scroller and the header stays', async ({ page }) => {
  const server = newServer();
  for (let i = 0; i < 25; i += 1) server.keys.push(key({ id: `ui_${String(i).padStart(12, '0')}`, name: `bulk-${i}` }));
  await open(page, server);
  await expect(rows(page)).toHaveCount(30);
  const measured = await page.evaluate(() => {
    const workspace = document.querySelector('.mcpPage__panel');
    workspace.scrollTop = 600;
    const root = document.scrollingElement;
    return {
      workspace: workspace.scrollTop,
      document: root.scrollTop,
      overflow: root.scrollHeight - window.innerHeight,
      header: document.querySelector('body > .appHeader').getBoundingClientRect().top,
    };
  });
  expect(measured.workspace).toBeGreaterThan(0);
  expect(measured.document).toBe(0);
  expect(measured.overflow).toBeLessThanOrEqual(0);
  expect(measured.header).toBe(0);
});

test('keyboard: New key opens from the keyboard, Escape closes it and gives the focus back', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').focus();
  await page.keyboard.press('Enter');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('#mcpField-name')).toBeFocused();
  // Tab walks the form in reading order: name, description, hosts.
  await page.keyboard.press('Tab');
  await expect(dialog(page).locator('#mcpField-description')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog(page).locator('#mcpHost-all')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog(page).locator('#mcpHost-all')).toBeChecked();
  // Every field has a label, every group a legend.
  const unnamed = await dialog(page).evaluate((root) => [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map((el) => el.id));
  expect(unnamed).toEqual([]);
  await expect(dialog(page).locator('fieldset > legend')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.locator('#mcpNewKey')).toBeFocused();
});

test('desktop: the page does not scroll sideways, in both themes', async ({ page }) => {
  await open(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, theme);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const colors = await page.evaluate(() => {
      const css = (selector, property) => getComputedStyle(document.querySelector(selector))[property];
      return { bg: css('.mcpWorkspace', 'backgroundColor'), text: css('.mcpKeyName', 'color'), badge: css('.mcpBadges .badge', 'color') };
    });
    expect(colors.bg).not.toBe(colors.text);
    await screenshot(page, `theme-${theme}`);
  }
  const bgs = await page.evaluate(() => [getComputedStyle(document.querySelector('.mcpWorkspace')).backgroundColor]);
  expect(bgs[0]).toMatch(/^rgb/);
});

test('New key: every problem shows at once, and a hint is the description of its field', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpTool-list_hosts').uncheck();
  await d.locator('#mcpTool-list_databases').uncheck();
  await d.locator('#mcpTool-list_tables').uncheck();
  await d.locator('#mcpTool-describe_table').uncheck();
  await d.locator('#mcpTool-query_table').uncheck();
  await d.getByRole('button', { name: 'Create key' }).click();
  for (const field of ['name', 'hosts', 'databases', 'tools']) {
    await expect(d.locator(`[data-wrap="${field}"] .uiField__error`)).toBeVisible();
  }
  await expect(d.locator('#mcpField-name')).toBeFocused();
  // The error comes first, the hint after it, in the description of the control.
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldError-name mcpFieldHint-name');
  await d.locator('#mcpField-name').fill('analyst');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('[data-wrap="name"] .uiField__error')).toBeHidden();
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldHint-name');
});

test('New key: a tool shows the first sentence of its description, without code quotes', async ({ page }) => {
  const server = newServer({ meta: { tools: TOOLS.map((tool) => (tool.name === 'list_hosts' ? { ...tool, description: 'List the hosts of this key. Every other tool takes an optional `host`; call this first.' } : tool)) } });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const label = dialog(page).locator('label[for="mcpTool-list_hosts"]');
  await expect(label).toContainText('List the hosts of this key.');
  await expect(label).not.toContainText('call this first');
  await expect(label).not.toContainText('`');
  await expect(label).toHaveAttribute('title', 'List the hosts of this key. Every other tool takes an optional host; call this first.');
});

test('a long list of keys has a filter that keeps its text and shows how many keys match', async ({ page }) => {
  const server = newServer();
  for (let index = 0; index < 10; index += 1) server.keys.push(key({ id: `ui_${String(index).padStart(12, '0')}`, name: `batch-${index}`, description: index === 3 ? 'The nightly export' : '' }));
  await open(page, server);
  const filter = page.locator('#mcpKeysFilter');
  await expect(filter).toBeVisible();
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('15');
  await filter.fill('export');
  await expect(rows(page).locator(':scope')).toHaveCount(15);
  await expect(page.locator('#mcpKeysBody tbody tr:not([hidden])')).toHaveCount(1);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('1 of 15');
  await filter.fill('no such key');
  await expect(page.locator('.mcpKeys__none')).toBeVisible();
  await filter.fill('');
  await expect(page.locator('#mcpKeysBody tbody tr:not([hidden])')).toHaveCount(15);
  // A short list has no filter.
  const small = newServer();
  await open(page, small);
  await expect(page.locator('#mcpKeysFilter')).toHaveCount(0);
});

test('a confirmation names what the action touches: the hosts and the last use of the key', async ({ page }) => {
  await open(page);
  await row(page, 'reporting').locator('[data-action="remove"]').click();
  const d = dialog(page);
  await expect(d).toContainText('This key reads prod, staging.');
  await expect(d).toContainText('Last used');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await expect(dialog(page)).toContainText('No use since ChDash started.');
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('390 px: no sideways scroll, the keys are cards, every action is reachable', async ({ page }) => {
    await open(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page.locator('#mcpKeysBody table')).toBeVisible();
    const first = rows(page).nth(1);
    expect((await first.evaluate((el) => getComputedStyle(el).display))).toBe('grid');
    await expect(first.locator('td').nth(2)).toHaveAttribute('data-label', 'Scope');
    expect(await first.locator('td').nth(2).evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Scope"');
    // The table keeps its semantics even as cards.
    await expect(page.locator('#mcpKeysBody [role="table"]')).toHaveCount(1);
    await expect(first).toHaveAttribute('role', 'row');
    const buttons = first.locator('[data-action]');
    await expect(buttons).toHaveCount(4);
    for (let i = 0; i < 4; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    await expect(buttons.nth(0)).toContainText('Edit');
    // Endpoint and code blocks scroll inside themselves, the page does not.
    await page.locator('#mcpHelp summary').click();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await screenshot(page, 'keys-phone');
    // The form as a bottom sheet that fits.
    await page.locator('#mcpNewKey').click();
    const box = await dialog(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await screenshot(page, 'form-phone');
    await dialog(page).locator('#mcpField-name').fill('phone-key');
    await dialog(page).locator('#mcpHost-all').check();
    await dialog(page).locator('#mcpData-all').check();
    await dialog(page).getByRole('button', { name: 'Create key' }).click();
    await expect(dialog(page).locator('#mcpSecret')).toHaveValue(SECRET);
    expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await screenshot(page, 'secret-phone');
  });

  test('390 px: the states fit too', async ({ page }) => {
    const server = newServer({ meta: { manage_from_ui: false, can_manage: false } });
    await open(page, server);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    server.meta = { enabled: false };
    await page.reload();
    await expect(page.locator('.mcpOff')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await screenshot(page, 'off-phone');
  });
});
