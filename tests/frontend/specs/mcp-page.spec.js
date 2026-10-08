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
const SECRET = '3f2a9c1e-7b4d-4e8a-9a6f-5c0d2b1e7a34';
const ROTATED = '9d4e6b20-1c3f-4a57-8e2b-6f7a0c5d3b19';

const TOOLS = [
  { name: 'list_hosts', group: 'schema', description: 'Hosts of the key and their health.', needs_all_data: false },
  { name: 'list_databases', group: 'schema', description: 'Databases the key can see.', needs_all_data: false },
  { name: 'list_tables', group: 'schema', description: 'Tables, engines, rows and size.', needs_all_data: false },
  { name: 'describe_table', group: 'schema', description: 'Columns, keys, engine and CREATE statement.', needs_all_data: false },
  { name: 'query_table', group: 'read', description: 'Rows of one table: ChDash builds the SQL.', needs_all_data: false },
  { name: 'list_services', group: 'observability', description: 'Services that sent data, with spans and errors.', needs_all_data: false },
  { name: 'search_traces', group: 'observability', description: 'Recent traces by their root span.', needs_all_data: false },
  { name: 'get_trace', group: 'observability', description: 'Every span of one trace.', needs_all_data: false },
  { name: 'search_logs', group: 'observability', description: 'Recent log records.', needs_all_data: false },
  { name: 'list_metrics', group: 'observability', description: 'Metrics reported lately.', needs_all_data: false },
  { name: 'query_metric', group: 'observability', description: 'One metric as a time series.', needs_all_data: false },
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
  name_pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
  secret_min_bytes: 24,
};

const key = (over) => ({
  id: 'ui_0a1b2c3d4e5f', name: 'ci-bot', source: 'ui', secret_hint: 'a1b2c3d4', secret_available: true,
  hosts: ['prod'], tools: ['list_databases', 'query_table'], databases: ['otel', 'analytics.events'],
  max_rows: null, timeout_seconds: null, enabled: true, state: 'active',
  created_at: '2026-10-08T10:00:00Z', last_used_at: null, ...over,
});

const KEYS = () => [
  key({ id: 'ops-all', name: 'ops-all', source: 'config', secret_hint: 'ops-all-', hosts: ['*'], tools: ['*'], databases: ['*'], max_rows: 200, timeout_seconds: 10 }),
  key({}),
  key({ id: 'ui_111111111111', name: 'reporting', hosts: ['prod', 'staging'], databases: ['*'], tools: ['list_hosts', 'run_query'] }),
  key({ id: 'ui_222222222222', name: 'paused', enabled: false, state: 'disabled' }),
  key({ id: 'hashed', name: 'hashed', source: 'config', secret_hint: '', secret_available: false, hosts: ['prod'], tools: ['list_hosts'], databases: ['*'] }),
];

// The server: meta and keys in memory; every call recorded. `errors` makes the next call of a route fail.
function newServer(over = {}) {
  const server = { keys: KEYS(), secrets: {}, calls: [], errors: {}, delay: {}, version: { mcp: { enabled: true } }, ...over };
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
      const created = key({ id: 'ui_aabbccddeeff', name: body.name, hosts: body.hosts, tools: body.tools, databases: body.databases, max_rows: body.max_rows ?? null, timeout_seconds: body.timeout_seconds ?? null, secret_hint: SECRET.slice(0, 8) });
      server.keys.push(created);
      server.secrets[created.id] = SECRET;
      return json(route, 201, { key: created, secret: SECRET });
    }
    const shown = method === 'GET' ? /^\/keys\/([^/]+)\/secret$/.exec(path) : null;
    if (shown) {
      const owner = server.keys.find((k) => k.id === decodeURIComponent(shown[1]));
      if (!owner) return json(route, 404, { error: 'not_found', message: 'No such key.' });
      if (!owner.secret_available) return json(route, 404, { error: 'secret_unavailable', message: 'ChDash has no secret for this key.' });
      return json(route, 200, { id: owner.id, secret: server.secrets[owner.id] || `${owner.secret_hint}-the-rest-of-the-secret-of-${owner.id}` });
    }
    const match = /^\/keys\/([^/]+)(\/rotate)?$/.exec(path);
    const found = match ? server.keys.find((k) => k.id === decodeURIComponent(match[1])) : null;
    if (!found) return json(route, 404, { error: 'not_found', message: 'No such key.' });
    if (found.source === 'config') return json(route, 409, { error: 'config_key', message: 'A key of the config file cannot change here.' });
    if (method === 'POST' && match[2]) {
      server.secrets[found.id] = ROTATED;
      return json(route, 200, { key: found, secret: ROTATED });
    }
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

// The four buttons of a key (the eye and the copy button of its secret are not actions on the key).
const ROW_ACTIONS = ['edit', 'toggle', 'rotate', 'remove'].map((name) => `[data-action="${name}"]`).join(', ');
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

test('the layout wastes no room: a strip on top, the keys beside a side column, one line for each key', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const h1 = box('h1');
    const header = box('body > .appHeader');
    const strip = box('.mcpStrip');
    const table = box('#mcpKeysBody table');
    const side = box('#mcpSide');
    const gutter = parseFloat(getComputedStyle(document.querySelector('#mcpPanel')).paddingLeft);
    return {
      h1: [h1.width, h1.height],
      stripTop: strip.top - header.bottom,
      stripLeft: strip.left,
      stripRight: window.innerWidth - strip.right,
      newKeyRight: strip.right - box('#mcpNewKey').right,
      refreshRight: box('#mcpNewKey').left - box('#mcpRefresh').right,
      gutter,
      tableTop: table.top - header.bottom,
      tableRight: table.right,
      sideLeft: side.left,
      sideRight: window.innerWidth - side.right,
      sideWidth: side.width,
      sideTop: side.top,
      stripBottom: strip.bottom,
      rowHeights: [...document.querySelectorAll('#mcpKeysBody tbody tr')].map((tr) => tr.getBoundingClientRect().height),
      bar: document.querySelector('#mcpBar') !== null,
    };
  });
  // The heading stays for the screen reader; the switcher says where the reader is.
  expect(m.h1[0]).toBeLessThanOrEqual(1);
  expect(m.h1[1]).toBeLessThanOrEqual(1);
  // No bar of its own: Refresh and New key end the strip, which is the first thing under the header.
  expect(m.bar).toBe(false);
  expect(m.gutter).toBe(12);
  expect(m.stripTop).toBeCloseTo(m.gutter, 0);
  expect(m.stripLeft).toBe(m.gutter);
  expect(m.stripRight).toBe(m.gutter);
  expect(m.refreshRight).toBeGreaterThan(0);
  expect(m.newKeyRight).toBeLessThanOrEqual(m.gutter + 2);
  await expect(page.locator('#mcpRefresh')).toHaveClass(/refreshButton/);
  await expect(page.locator('#mcpNewKey')).toHaveClass(/button--primary/);
  // The keys table starts high, and the side column stands beside it, full height of the gutter.
  expect(m.tableTop).toBeLessThan(150);
  expect(m.sideLeft).toBeGreaterThanOrEqual(m.tableRight);
  expect(m.sideRight).toBe(m.gutter);
  expect(m.sideWidth).toBeGreaterThan(400);
  expect(m.sideWidth).toBeLessThan(450);  // 30% of 1440 px
  expect(m.sideTop).toBeGreaterThanOrEqual(m.stripBottom);
  // A key is one table line (the header row and a row with its four action buttons included).
  for (const height of m.rowHeights) expect(height).toBeLessThanOrEqual(34);
  // The shared components: a compact data table, badges, fields.
  // The strip says nothing of the state of MCP: what stops a change is the note under the title of the keys.
  await expect(page.locator('.mcpStrip .badge, .mcpBadges')).toHaveCount(0);
  await expect(page.getByText('MCP enabled')).toHaveCount(0);
  await expect(page.getByText('Storage configured')).toHaveCount(0);
  await expect(page.getByText('Managed from the UI')).toHaveCount(0);
  await expect(page.locator('#mcpKeysBody table')).toHaveClass(/dataTable--compact/);
  await expect(page.locator('#mcpKeysBody .dataTableWrap')).toHaveCount(1);
  await expect(page.locator('#mcpEndpointUrl')).toHaveClass(/uiInput/);
  await expect(page.locator('label[for="mcpEndpointUrl"]')).toHaveText('Endpoint');
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

test('the strip and the side column: endpoint with a copy button, connect tabs, hosts with their health, limits', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  await expect(page.locator('#mcpEndpointUrl')).toHaveValue(`${origin}/mcp`);
  // The hosts: a list of the side column, each with its label and a health badge of the shared component.
  const hosts = page.locator('#mcpSide .mcpHostRow');
  await expect(hosts).toHaveCount(3);
  await expect(hosts.nth(0)).toContainText('prod');
  await expect(hosts.nth(0)).toContainText('Production cluster');
  await expect(hosts.nth(0).locator('.badge--ok')).toHaveText('healthy');
  await expect(hosts.nth(1)).toContainText('down');
  await expect(hosts.nth(2)).toContainText('unknown');
  // A host whose label is its name shows the name once.
  await expect(hosts.nth(1).locator('.mcpHostRow__label')).toHaveCount(0);
  const limits = page.locator('#mcpSide .mcpLimits');
  await expect(limits.locator('dt')).toHaveText(['Rows per result', 'Timeout', 'Result size', 'SQL size', 'Memory per query', 'Rows read', 'Requests per minute']);
  await expect(limits).toContainText('1,000');
  await expect(limits).toContainText('30 s');
  await expect(limits).toContainText('1.0 MB');
  await expect(limits).toContainText('No limit');
  await expect(limits).toContainText('600');
  // The copy button gives its feedback.
  const copy = page.locator('.mcpStrip .mcpEndpoint__copy');
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  // "Connect a client" is always open (it is part of the side column), with the commands built from the real origin.
  const connect = page.locator('#mcpConnect');
  await expect(connect).toBeVisible();
  // One tab for each client: Claude Code first, then Desktop, Inspector and a JSON file.
  await expect(connect.getByRole('group', { name: 'Client' }).getByRole('button')).toHaveText(['Claude Code', 'Desktop', 'Inspector', 'JSON']);
  await expect(connect.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "Authorization: Bearer <secret>"`);
  await connect.getByRole('button', { name: 'Desktop' }).click();
  const desktop = JSON.parse(await connect.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre').innerText());
  expect(desktop.mcpServers['chdash-name']).toEqual({ command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: 'Bearer <secret>' } });
  await connect.getByRole('button', { name: 'Inspector' }).click();
  await expect(connect.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`URL              ${origin}/mcp`);
  await connect.getByRole('button', { name: 'JSON' }).click();
  await expect(connect.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre')).toContainText(`"url": "${origin}/mcp"`);
  await expect(connect).toContainText('2025-06-18');
});

test('the keys table: one line for each key, its secret, scope, limits, state and the actions', async ({ page }) => {
  await open(page);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('5');
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Secret', 'Hosts', 'Tools', 'Data', 'Limits', 'State', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  // Rows keep the order the API gives.
  await expect(rows(page).locator('.mcpKeyName')).toHaveText(['ops-all', 'ci-bot', 'reporting', 'paused', 'hashed']);
  const cells = (name) => row(page, name).locator('td');
  const config = row(page, 'ops-all');
  // No description, no expiry and no last use: those are gone from the page.
  for (const gone of ['Expires', 'Last used', 'Source', 'Description']) await expect(page.locator('#mcpKeysBody thead')).not.toContainText(gone);
  await expect(cells('ops-all').nth(2)).toHaveText('All');
  await expect(cells('ops-all').nth(3)).toHaveText('All');
  // The data of a key is a list of patterns: * is all of it, and reads as the pattern it is.
  await expect(cells('ops-all').nth(4)).toHaveText('*');
  // The key's own limits read at full strength: 200 rows, 10 s.
  await expect(cells('ops-all').nth(5)).toHaveText('200 · 10 s');
  await expect(config.locator('.mcpLimitPair .mcpMuted').first()).toHaveText('·');
  await expect(cells('ops-all').nth(6)).toHaveText('Active');
  const ui = row(page, 'ci-bot');
  await expect(ui.locator('.mcpKeyOpen')).toHaveAttribute('title', /ci-bot/);
  await expect(cells('ci-bot').nth(2)).toHaveText('prod');
  // Two tools read as a count, the title lists them; the data patterns read as code.
  await expect(cells('ci-bot').nth(3)).toHaveText('2 tools');
  await expect(cells('ci-bot').nth(3).locator('.mcpMono')).toHaveAttribute('title', 'list_databases, query_table');
  await expect(cells('ci-bot').nth(4)).toContainText('otel, analytics.events');
  // The global limit that a key inherits reads muted and a screen reader hears "(default)".
  await expect(cells('ci-bot').nth(5)).toContainText('1,000 (default)');
  await expect(cells('ci-bot').nth(5).locator('.mcpMuted').first()).toContainText('1,000');
  await expect(row(page, 'reporting')).toContainText('prod, staging');
  await expect(cells('paused').nth(6)).toHaveText('Disabled');
  // Actions: a config key is read-only (a lock with the reason, no button), a UI key has all four.
  await expect(config.locator('[data-action="edit"], [data-action="toggle"], [data-action="rotate"], [data-action="remove"]')).toHaveCount(0);
  await expect(config.locator('.mcpLocked')).toHaveText('Config file');
  await expect(config.locator('.mcpLocked')).toHaveAttribute('title', /Read-only: this key comes from the config file/);
  for (const action of ['edit', 'toggle', 'rotate', 'remove']) {
    await expect(ui.locator(`[data-action="${action}"]`)).toBeEnabled();
  }
  await expect(ui.locator('[data-action="toggle"]')).toHaveAttribute('aria-label', 'Disable ci-bot');
  await expect(row(page, 'paused').locator('[data-action="toggle"]')).toHaveAttribute('aria-label', 'Enable paused');
  await screenshot(page, 'keys-desktop');
});

test('the secret of a key: its first characters and dots, the eye shows it, the copy button copies it', async ({ page }) => {
  const server = await open(page);
  const ui = row(page, 'ci-bot');
  const text = ui.locator('.mcpSecret__text');
  const eye = ui.locator('[data-action="reveal"]');
  // Masked: the hint and dots, nothing else. The list never carries a secret.
  await expect(text).toHaveText(/^a1b2c3d4•+$/);
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(eye).toHaveAttribute('aria-label', 'Show the secret of ci-bot');
  expect(server.calls.filter((call) => call.path.endsWith('/secret'))).toHaveLength(0);
  // The eye asks for the secret of that key and shows all of it; the eye changes.
  await eye.click();
  await expect(text).toHaveText('a1b2c3d4-the-rest-of-the-secret-of-ui_0a1b2c3d4e5f');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(eye).toHaveAttribute('aria-label', 'Hide the secret of ci-bot');
  expect(server.calls.filter((call) => call.path === '/keys/ui_0a1b2c3d4e5f/secret')).toHaveLength(1);
  // Another key stays masked, and the table did not grow sideways.
  await expect(row(page, 'reporting').locator('.mcpSecret__text')).toHaveText(/•+$/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, 'secret-shown');
  // Hide: the secret leaves the page.
  await eye.click();
  await expect(text).toHaveText(/^a1b2c3d4•+$/);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('the-rest-of-the-secret');
  // Copy: the same secret, asked for when the button is pressed.
  await page.evaluate(() => {
    window.__copied = null;
    if (navigator.clipboard) navigator.clipboard.writeText = async (value) => { window.__copied = value; };
    const original = document.execCommand.bind(document);
    document.execCommand = (command) => {
      if (command !== 'copy') return original(command);
      window.__copied = document.querySelector('textarea[readonly]')?.value ?? null;
      return true;
    };
  });
  await ui.locator('[data-action="copy-secret"]').click();
  await expect.poll(() => page.evaluate(() => window.__copied)).toBe('a1b2c3d4-the-rest-of-the-secret-of-ui_0a1b2c3d4e5f');
  // Never kept by the browser.
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href]))).not.toContain('the-rest-of-the-secret');
  // A config key whose secret is its hash: no secret to show, the buttons say why.
  const hashed = row(page, 'hashed');
  await expect(hashed.locator('.mcpSecret__text')).toHaveText('Not available');
  await expect(hashed.locator('[data-action="reveal"]')).toBeDisabled();
  await expect(hashed.locator('[data-action="copy-secret"]')).toBeDisabled();
  await expect(hashed.locator('[data-action="reveal"]')).toHaveAttribute('title', /secret_sha256/);
  // A config key with a plain secret shows it like a page key.
  await row(page, 'ops-all').locator('[data-action="reveal"]').click();
  await expect(row(page, 'ops-all').locator('.mcpSecret__text')).toContainText('ops-all--the-rest-of-the-secret');
});

test('a secret that the server cannot give is said, not shown', async ({ page }) => {
  const server = await open(page);
  server.errors['GET /keys/ui_0a1b2c3d4e5f/secret'] = { status: 404, body: { error: 'secret_unavailable', message: 'ChDash has no secret for this key.' } };
  await row(page, 'ci-bot').locator('[data-action="reveal"]').click();
  await expect(row(page, 'ci-bot').locator('.mcpSecret__text')).toHaveText(/^a1b2c3d4•+$/);
  await expect(row(page, 'ci-bot').locator('[data-action="reveal"]')).toHaveAttribute('aria-pressed', 'false');
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
  // The side column stays: the commands to connect are next to the empty list.
  await expect(page.locator('#mcpConnect')).toBeVisible();
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('0');
});

test('storage not configured: creation is off with the reason, the config keys still list', async ({ page }) => {
  const server = newServer({ meta: { storage_configured: false, can_manage: false } });
  server.keys = [server.keys[0]];
  await open(page, server);
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(page.locator('#mcpNewKey')).toHaveAttribute('title', /mcp\.storage_file is not set/);
  await expect(page.locator('#mcpKeysNote')).toContainText('mcp.storage_file is not set');
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, 'ops-all')).toBeVisible();
  await expect(page.locator('#mcpKeysBody').locator(ROW_ACTIONS.split(', ').map((one) => `${one}:enabled`).join(', '))).toHaveCount(0);
});

test('manage_from_ui = false: a read-only page', async ({ page }) => {
  const server = newServer({ meta: { manage_from_ui: false, can_manage: false } });
  await open(page, server);
  await expect(page.locator('#mcpKeysNote')).toContainText('manage_from_ui is false');
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('#mcpKeysBody').locator(ROW_ACTIONS)).toHaveCount(0);
  await expect(row(page, 'ci-bot').locator('.mcpLocked')).toHaveText('Read-only');
  await expect(row(page, 'ci-bot').locator('.mcpLocked')).toHaveAttribute('title', /manage_from_ui is false/);
});

test('New key: the form fits the dialog without a scroll, at the size of a small laptop', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('New key');
  const m = await d.evaluate((el) => {
    const body = el.querySelector('.uiDialog__body');
    const box = el.getBoundingClientRect();
    return { overflow: body.scrollHeight - body.clientHeight, top: box.top, bottom: window.innerHeight - box.bottom };
  });
  expect(m.overflow).toBeLessThanOrEqual(0);
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeGreaterThanOrEqual(0);
  await screenshot(page, 'form-small');
});

test('New key: a token page like the one of GitHub: name, access, permissions with their level, one line of summary', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  // Hosts: a list of the hosts that have an mcp_uri, none ticked, and no "All hosts".
  await expect(d.locator('[id^="mcpHost-"]')).toHaveCount(3);
  await expect(d.locator('[id^="mcpHost-"]:checked')).toHaveCount(0);
  await expect(d.getByText('All hosts')).toHaveCount(0);
  await expect(d.getByText('All data')).toHaveCount(0);
  // Data: patterns only, and * alone is everything.
  await expect(d.locator('#mcpField-databases')).toBeEnabled();
  await expect(d.locator('input[type="radio"]')).toHaveCount(0);
  // Permissions in four groups from /api/mcp/meta, each tool a line with a level: No access or Read-only.
  await expect(d.locator('.mcpToolGroup__title')).toHaveText(['Schema', 'Read', 'Observability', 'SQL']);
  await expect(d.locator('.mcpToolGroup').first()).toContainText('Databases the key can see.');
  await expect(d.locator('.mcpToolGroup').nth(2).locator('.mcpPerm__name')).toHaveText(['list_services', 'search_traces', 'get_trace', 'search_logs', 'list_metrics', 'query_metric']);
  const level = d.locator('#mcpTool-query_table');
  await expect(level.locator('option')).toHaveText(['No access', 'Read-only']);
  await expect(level).toHaveValue('read');
  // The schema and read tools start on; the observability tools start off (they need the otel data).
  await expect(d.locator('#mcpTool-search_traces')).toHaveValue('none');
  const sql = ['run_query', 'explain_query'].map((name) => d.locator(`#mcpTool-${name}`));
  for (const select of sql) {
    await expect(select).toBeDisabled();
    await expect(select).toHaveValue('none');
  }
  await expect(d.locator('#mcpToolReason-sql')).toContainText('Needs the data pattern *');
  await expect(d.locator('#mcpTool-run_query')).toHaveAttribute('aria-describedby', 'mcpToolReason-sql');
  // The summary says what is missing, then what the key will be.
  const summary = d.locator('#mcpSummary');
  await expect(summary).toContainText('a name');
  await expect(summary).toContainText('a host');
  await expect(summary).toContainText('data');
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpHost-1').check();
  await d.locator('#mcpField-databases').fill('otel\nanalytics.*');
  await expect(summary).not.toHaveClass(/is-warn/);
  await expect(summary).toContainText('analyst');
  await expect(summary).toContainText('2 hosts');
  await expect(summary).toContainText('2 patterns');
  await expect(summary).toContainText('5 of 13 permissions, read-only');
  // The pattern * alone unlocks the SQL tools (off until picked); any other list locks and clears them again.
  await d.locator('#mcpField-databases').fill('*');
  for (const select of sql) await expect(select).toBeEnabled();
  await expect(d.locator('#mcpToolReason-sql')).toBeHidden();
  await expect(summary).toContainText('all the data');
  await sql[0].selectOption('read');
  await expect(summary).toContainText('6 of 13 permissions');
  await d.locator('#mcpField-databases').fill('otel');
  await expect(sql[0]).toBeDisabled();
  await expect(sql[0]).toHaveValue('none');
  await expect(summary).toContainText('5 of 13 permissions');
  // No description, no expiry field, a name of 32 characters at most.
  await expect(d.locator('#mcpField-description, #mcpField-expires_at')).toHaveCount(0);
  await expect(d.locator('#mcpField-name')).toHaveAttribute('maxlength', '32');
  await screenshot(page, 'form-desktop');
});

test('New key: the observability tools are chosen like any other permission', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('watcher');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
  for (const tool of ['list_services', 'search_traces', 'get_trace', 'search_logs']) await d.locator(`#mcpTool-${tool}`).selectOption('read');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.tools).toEqual(['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table', 'list_services', 'search_traces', 'get_trace', 'search_logs']);
  expect(post.body.databases).toEqual(['otel']);
});

test('New key: a single host is ticked and cannot be unticked', async ({ page }) => {
  const server = newServer({ meta: { hosts: [{ name: 'prod', label: 'Production cluster', healthy: true }] } });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await expect(d.locator('[id^="mcpHost-"]')).toHaveCount(1);
  await expect(d.locator('#mcpHost-0')).toBeChecked();
  await expect(d.locator('#mcpHost-0')).toBeDisabled();
  await d.locator('#mcpField-name').fill('solo');
  await d.locator('#mcpField-databases').fill('otel');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  expect(server.calls.find((call) => call.method === 'POST' && call.path === '/keys').body.hosts).toEqual(['prod']);
});

test('create a key: the request, the one-time secret and its commands, nothing left behind', async ({ page }) => {
  const server = await open(page);
  const origin = new URL(page.url()).origin;
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel\nanalytics.events\n\nlogs_*.*');
  await d.locator('#mcpField-max_rows').fill('200');
  await d.locator('#mcpField-timeout_seconds').fill('10');
  await d.getByRole('button', { name: 'Create key' }).click();
  // The secret panel: the secret with its copy button, and the commands from the real origin.
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created');
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body).toEqual({
    name: 'analyst', hosts: ['prod'], databases: ['otel', 'analytics.events', 'logs_*.*'],
    tools: ['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table'], max_rows: 200, timeout_seconds: 10,
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
  // The list behind it is already drawn again, with the first characters and dots only.
  await expect(row(page, 'analyst')).toHaveCount(1);
  await expect(row(page, 'analyst').locator('.mcpSecret__text')).toHaveText(/^3f2a9c1e\u2022+$/);
  await expect(row(page, 'analyst')).not.toContainText(SECRET);
  // Done: the dialog and every node that held the secret leave the page.
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain('Bearer 3f2a9c1e');
  expect(await storage()).not.toContain(SECRET);
  await expect(row(page, 'analyst').locator('[data-action="edit"]')).toBeFocused();
});

test('the secret panel closes with Escape and the close button, and clears the DOM the same way', async ({ page }) => {
  await open(page);
  for (const how of ['Escape', 'cross']) {
    await page.locator('#mcpNewKey').click();
    const d = dialog(page);
    await d.locator('#mcpField-name').fill(how === 'Escape' ? 'by-escape' : 'by-cross');
    await d.locator('#mcpHost-0').check();
    await d.locator('#mcpField-databases').fill('*');
    await d.getByRole('button', { name: 'Create key' }).click();
    await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
    if (how === 'Escape') await page.keyboard.press('Escape');
    else await d.locator('.uiDialog__close').click();
    await expect(page.locator('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET);
  }
});

test('validation: Create key stays off until the key is valid, and its title says what is missing', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const create = d.getByRole('button', { name: 'Create key' });
  // Nothing is set: the button is off, the title names the first thing that is missing.
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Enter a name.');
  await expect(d.locator('#mcpSummary')).toHaveClass(/is-warn/);
  await d.locator('#mcpField-name').fill('Bad Name');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /lower-case letters/);
  await expect(d.locator('#mcpSummary')).toContainText('a valid name');
  await d.locator('#mcpField-name').fill('good-name');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Select at least one host.');
  await d.locator('#mcpHost-0').check();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /Enter at least one data pattern/);
  await d.locator('#mcpField-databases').fill('otel');
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute('title', '');
  // Every permission cleared: off again. Then back on.
  await d.locator('#mcpToolsNone').click();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /at least one permission/);
  await d.locator('#mcpToolsAll').click();
  await expect(create).toBeEnabled();
  await d.locator('#mcpField-max_rows').fill('0');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /whole number/);
  await d.locator('#mcpField-max_rows').fill('');
  await expect(create).toBeEnabled();
  // Enter in the name field does not send an invalid key either.
  await d.locator('#mcpField-name').fill('');
  await d.locator('#mcpField-name').press('Enter');
  expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await expect(d).toBeVisible();
  // A valid key goes.
  await d.locator('#mcpField-name').fill('good-name');
  await create.click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
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
  await expect(d.locator('#mcpField-databases')).toHaveValue('*');
  await expect(d.locator('#mcpTool-run_query')).toHaveValue('read');
  await expect(d.locator('#mcpTool-run_query')).toBeEnabled();
  // A taken name.
  server.errors['PATCH /keys/ui_111111111111'] = { status: 409, body: { error: 'name_taken', message: 'Another key has this name.' } };
  await d.locator('#mcpField-name').fill('ci-bot');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(d.locator('#mcpFieldError-name')).toHaveText('Another key has this name.');
  // A save.
  await d.locator('#mcpField-name').fill('reporting-2');
  await d.locator('#mcpField-max_rows').fill('50');
  await d.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog(page)).toHaveCount(0);
  const patch = server.calls.filter((call) => call.method === 'PATCH').pop();
  expect(patch.body).toMatchObject({ name: 'reporting-2', hosts: ['prod', 'staging'], databases: ['*'], max_rows: 50, timeout_seconds: null });
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
  // Tab walks the form in reading order: name, then the hosts.
  await page.keyboard.press('Tab');
  await expect(dialog(page).locator('#mcpHost-0')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog(page).locator('#mcpHost-0')).toBeChecked();
  // Every field has a label, every group a legend.
  const unnamed = await dialog(page).evaluate((root) => [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map((el) => el.id));
  expect(unnamed).toEqual([]);
  await expect(dialog(page).locator('fieldset > legend')).toHaveCount(2);
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
      return { bg: css('.mcpWorkspace', 'backgroundColor'), text: css('.mcpKeyName', 'color'), badge: css('.mcpTable .badge', 'color') };
    });
    expect(colors.bg).not.toBe(colors.text);
    await screenshot(page, `theme-${theme}`);
  }
  const bgs = await page.evaluate(() => [getComputedStyle(document.querySelector('.mcpWorkspace')).backgroundColor]);
  expect(bgs[0]).toMatch(/^rgb/);
});

test('New key: a hint is the description of its field, the error of the server comes before it', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldHint-name');
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
  server.errors['POST /keys'] = { status: 409, body: { error: 'name_taken', message: 'A key named "analyst" exists.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  // The error comes first, the hint after it, in the description of the control.
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldError-name mcpFieldHint-name');
  await expect(d.locator('#mcpFieldError-name')).toBeVisible();
  await expect(d.locator('#mcpField-name')).toBeFocused();
});

test('New key: a tool shows the first sentence of its description, without code quotes', async ({ page }) => {
  const server = newServer({ meta: { tools: TOOLS.map((tool) => (tool.name === 'list_hosts' ? { ...tool, description: 'List the hosts of this key. Every other tool takes an optional `host`; call this first.' } : tool)) } });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const label = dialog(page).locator('label[for="mcpTool-list_hosts"]');
  await expect(label).toContainText('List the hosts of this key.');
  await expect(label).not.toContainText('call this first');
  await expect(label).not.toContainText('`');
  await expect(dialog(page).locator('.mcpPerm').first()).toHaveAttribute('title', 'List the hosts of this key. Every other tool takes an optional host; call this first.');
});

test('a long list of keys has a filter that keeps its text and shows how many keys match', async ({ page }) => {
  const server = newServer();
  for (let index = 0; index < 10; index += 1) server.keys.push(key({ id: `ui_${String(index).padStart(12, '0')}`, name: index === 3 ? 'nightly-export' : `batch-${index}` }));
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

test('a confirmation names what the action touches: the hosts of the key', async ({ page }) => {
  await open(page);
  await row(page, 'reporting').locator('[data-action="remove"]').click();
  const d = dialog(page);
  await expect(d).toContainText('This key reads prod, staging.');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await expect(dialog(page)).toContainText('This key reads prod.');
});

test('a click on a key opens its details: state, secret, hosts, data, limits and every permission', async ({ page }) => {
  await open(page);
  // The name is a button; a click on the row outside its buttons does the same.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Key ci-bot');
  const facts = d.locator('.mcpAbout');
  await expect(facts).toContainText('Active');
  await expect(facts).toContainText('page');
  await expect(facts.locator('.mcpChip')).toHaveText(['prod', 'otel', 'analytics.events']);
  await expect(facts).toContainText('1,000 rows (default) · 30 s (default)');
  // Every tool of the server is listed, by group, with what the key may do with it.
  await expect(d.locator('.mcpDetails__title')).toContainText('Permissions');
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('2 of 13');
  await expect(d.locator('.mcpToolGroup__title')).toHaveText(['Schema', 'Read', 'Observability', 'SQL']);
  await expect(d.locator('.mcpGrant')).toHaveCount(13);
  await expect(d.locator('.mcpGrant[data-held="yes"] .mcpGrant__name')).toHaveText(['list_databases', 'query_table']);
  await expect(d.locator('.mcpGrant[data-tool="query_table"] .mcpGrant__level')).toHaveText('Read-only');
  await expect(d.locator('.mcpGrant[data-tool="search_traces"] .mcpGrant__level')).toHaveText('No access');
  await expect(d.locator('.mcpGrant[data-tool="query_table"]')).toContainText('Rows of one table');
  // The secret is there to show and to copy, as in the table.
  const secret = d.locator('.mcpSecret__text');
  await expect(secret).toHaveText(/^a1b2c3d4•+$/);
  await d.locator('[data-action="reveal"]').click();
  await expect(secret).toHaveText('a1b2c3d4-the-rest-of-the-secret-of-ui_0a1b2c3d4e5f');
  // The actions of the key stand at the foot.
  await expect(d.locator('.uiDialog__foot .button')).toHaveText(['Close', 'Delete', 'Rotate secret', 'Disable', 'Edit']);
  await screenshot(page, 'details');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('the-rest-of-the-secret');
  await expect(row(page, 'ci-bot').locator('[data-action="open"]')).toBeFocused();
  // A click on a cell of the row (not on a button) opens it too, and the eye of the table does not.
  await row(page, 'reporting').locator('td').nth(2).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Key reporting');
  await page.keyboard.press('Escape');
  await row(page, 'reporting').locator('[data-action="reveal"]').click();
  await expect(page.locator('dialog')).toHaveCount(0);
});

test('the details of a key with every tool name the tools it holds, the SQL ones only with all the data', async ({ page }) => {
  await open(page);
  // ops-all: tools ["*"] and data "*": all 13. A key with "*" and a narrower data holds no SQL tool.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  let d = dialog(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('13 of 13');
  await expect(d.locator('.mcpGrant[data-held="no"]')).toHaveCount(0);
  await expect(d.locator('.mcpAbout')).toContainText('config file');
  await expect(d.locator('.mcpAbout')).toContainText('200 rows · 10 s');
  // A key of the config file cannot change here: Close only.
  await expect(d.locator('.uiDialog__foot .button')).toHaveText(['Close']);
  await page.keyboard.press('Escape');
  const server = newServer();
  server.keys.push(key({ id: 'ui_444444444444', name: 'star-narrow', tools: ['*'], databases: ['otel'] }));
  await open(page, server);
  await row(page, 'star-narrow').locator('[data-action="open"]').click();
  d = dialog(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('11 of 13');
  await expect(d.locator('.mcpGrant[data-held="no"] .mcpGrant__name')).toHaveText(['run_query', 'explain_query']);
  await page.keyboard.press('Escape');
  // A key whose secret ChDash does not have says so in the details too.
  await row(page, 'hashed').locator('[data-action="open"]').click();
  await expect(dialog(page).locator('.mcpSecret__text')).toHaveText('Not available');
});

test('the buttons of the details run the action on the key: edit, disable, rotate, delete', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await dialog(page).getByRole('button', { name: 'Edit' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Edit key ci-bot');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await dialog(page).getByRole('button', { name: 'Disable' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Disable key ci-bot?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await dialog(page).getByRole('button', { name: 'Rotate secret' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Rotate the secret of ci-bot?');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await dialog(page).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Delete key ci-bot?');
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(row(page, 'ci-bot')).toHaveCount(0);
  expect(server.calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
});

test('a page that cannot change keys opens the details with Close only', async ({ page }) => {
  await open(page, newServer({ meta: { manage_from_ui: false, can_manage: false } }));
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(dialog(page).locator('.uiDialog__foot .button')).toHaveText(['Close']);
  await expect(dialog(page).locator('.mcpGrant')).toHaveCount(13);
});

test.describe('tablet', () => {
  test.use({ viewport: { width: 800, height: 800 } });

  test('800 px: the side column goes under the keys, its blocks side by side, and the page does not scroll sideways', async ({ page }) => {
    await open(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const m = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const wrap = document.querySelector('#mcpKeysBody .dataTableWrap');
      return { keysBottom: box('#mcpKeys').bottom, sideTop: box('#mcpSide').top, connect: box('#mcpConnect'), hosts: box('#mcpHosts'), wrapScrolls: wrap.scrollWidth > wrap.clientWidth };
    });
    expect(m.sideTop).toBeGreaterThanOrEqual(m.keysBottom);
    expect(m.hosts.left).toBeGreaterThanOrEqual(m.connect.right);
    // The table keeps its width and scrolls inside its box.
    expect(m.wrapScrolls).toBe(true);
    await screenshot(page, 'keys-tablet');
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('390 px: no sideways scroll, the keys are cards, every action is reachable', async ({ page }) => {
    await open(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expect(page.locator('#mcpKeysBody table')).toBeVisible();
    const first = rows(page).nth(1);
    expect((await first.evaluate((el) => getComputedStyle(el).display))).toBe('grid');
    await expect(first.locator('td').nth(2)).toHaveAttribute('data-label', 'Hosts');
    expect(await first.locator('td').nth(2).evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Hosts"');
    // The table keeps its semantics even as cards.
    await expect(page.locator('#mcpKeysBody [role="table"]')).toHaveCount(1);
    await expect(first).toHaveAttribute('role', 'row');
    const buttons = first.locator(ROW_ACTIONS);
    await expect(buttons).toHaveCount(4);
    // The eye and the copy button of the secret are reachable too, at the size of a finger.
    for (const action of ['reveal', 'copy-secret']) {
      const box = await first.locator(`[data-action="${action}"]`).boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(32);
    }
    for (let i = 0; i < 4; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    await expect(buttons.nth(0)).toContainText('Edit');
    // The strip and the code blocks scroll inside themselves, the page does not: the side column comes after the keys.
    await page.locator('#mcpConnect').scrollIntoViewIfNeeded();
    await expect(page.locator('#mcpConnect')).toBeVisible();
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
    await dialog(page).locator('#mcpHost-0').check();
    await dialog(page).locator('#mcpField-databases').fill('*');
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
