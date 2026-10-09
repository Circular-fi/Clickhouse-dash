import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';

// The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md): the access keys
// of the MCP server built into ChDash, and how to connect a client. The server side is a small in-memory
// server behind page.route (the JSON of /api/mcp/*, as the contract fixes it), so the page runs on any
// instance: the page route and /api/version are answered here too. The page is not tied to a host and
// sits in the page switcher as "MCP" only when features.mcp.enabled. A key is made or deleted, never changed.

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

// A few tools of each family of the server's table (the real one has 61): enough to see how the page draws
// families, locks and counts.
const T = (name, group, description, needs = false) => ({ name, group, description, needs_all_data: needs });
const TOOLS = [
  T('list_hosts', 'schema', 'Hosts of the key and their health.'),
  T('list_databases', 'schema', 'Databases the key can see.'),
  T('list_tables', 'schema', 'Tables, engines, rows and size.'),
  T('describe_table', 'schema', 'Columns, keys, engine and CREATE statement.'),
  T('query_table', 'read', 'Rows of one table: ChDash builds the SQL.'),
  T('list_services', 'observability', 'Services that sent data, with spans and errors.'),
  T('search_traces', 'observability', 'Recent traces by their root span.'),
  T('get_trace', 'observability', 'Every span of one trace.'),
  T('search_logs', 'observability', 'Recent log records.'),
  T('list_metrics', 'observability', 'Metrics reported lately.'),
  T('query_metric', 'observability', 'One metric as a time series.'),
  T('explorer_catalog', 'explorer', 'The databases and tables that the Explorer shows.', true),
  T('explorer_table', 'explorer', 'Everything the Explorer knows about one table.', true),
  T('system_overview', 'system', 'The state of the server in one answer.', true),
  T('system_disks', 'system', 'Disks, free space and the size of tables.', true),
  T('traces_search', 'traces', 'Search traces (Jaeger semantics).', true),
  T('traces_trace', 'traces', 'One whole trace: every span.', true),
  T('logs_search', 'logs', 'Search log records, newest first.', true),
  T('metrics_series', 'metrics', 'One metric as time series.', true),
  T('query_library', 'library', 'The saved queries and their folders.', true),
  T('format_sql', 'query', 'Format SQL text like the Format button.', true),
  T('run_query', 'sql', 'One SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN.', true),
  T('explain_query', 'sql', 'EXPLAIN of a query.', true),
];
const GROUPS = [
  { id: 'schema', title: 'Schema', note: 'names, columns and engines' },
  { id: 'read', title: 'Read', note: 'rows of a table that ChDash selects' },
  { id: 'observability', title: 'Observability', note: 'simple tools on the traces, logs and metrics tables' },
  { id: 'explorer', title: 'Explorer', note: 'the Explorer page' },
  { id: 'system', title: 'System', note: 'the System page' },
  { id: 'traces', title: 'Traces', note: 'the Traces page' },
  { id: 'logs', title: 'Logs', note: 'the Logs page' },
  { id: 'metrics', title: 'Metrics', note: 'the Metrics page' },
  { id: 'library', title: 'Library', note: 'the saved queries' },
  { id: 'query', title: 'Query', note: 'helpers of the Query page' },
  { id: 'sql', title: 'SQL', note: 'free SQL written by the client' },
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
  tool_groups: GROUPS,
  tools: TOOLS,
  limits: { max_rows: 1000, max_result_bytes: 1048576, query_timeout_seconds: 30, max_sql_bytes: 65536, max_memory_bytes: 1073741824, max_rows_to_read: 0, rate_limit_per_minute: 600 },
  name_pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
  secret_min_bytes: 24,
};

const key = (over) => ({
  id: 'ui_0a1b2c3d4e5f', name: 'ci-bot', source: 'ui', secret_hint: 'a1b2c3d4', secret_available: true,
  hosts: ['prod'], tools: ['list_databases', 'query_table'], databases: ['otel', 'analytics.events'],
  max_rows: null, timeout_seconds: null, created_at: '2026-10-08T10:00:00Z', last_used_at: null, ...over,
});

const KEYS = () => [
  key({ id: 'ops-all', name: 'ops-all', source: 'config', secret_hint: 'ops-all-', hosts: ['*'], tools: ['*'], databases: ['*'], max_rows: 200, timeout_seconds: 10 }),
  key({}),
  key({ id: 'ui_111111111111', name: 'reporting', hosts: ['prod', 'staging'], databases: ['*'], tools: ['list_hosts', 'explorer_catalog', 'system_overview'] }),
  key({ id: 'ui_222222222222', name: 'second-ui-key', secret_hint: '9d4e6b20' }),
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
      return json(route, 200, { id: owner.id, secret: server.secrets[owner.id] || `${owner.secret_hint}-0000-4000-8000-${owner.id.replace(/[^0-9a-f]/g, '0').padEnd(12, '0').slice(0, 12)}` });
    }
    const match = /^\/keys\/([^/]+)$/.exec(path);
    const found = match ? server.keys.find((k) => k.id === decodeURIComponent(match[1])) : null;
    if (!found) return json(route, 404, { error: 'not_found', message: 'No such key.' });
    if (found.source === 'config') return json(route, 409, { error: 'config_key', message: 'A key of the config file cannot change here.' });
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
// The details of a key open in a row under it (one at a time).
const details = (page) => page.locator('#mcpKeysBody tr.mcpDetailRow');
// The tools of a family are behind its arrow: a test opens the card before it touches a tool.
const openGroup = async (d, id) => {
  const toggle = d.locator(`[aria-controls="mcpGroupBody-${id}"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};
// A family of one tool has no arrow and no box of its own: its check box is the tool.
const FAMILY_BOX = { read: '#mcpTool-query_table', logs: '#mcpTool-logs_search', metrics: '#mcpTool-metrics_series', library: '#mcpTool-query_library', query: '#mcpTool-format_sql' };
const family = (d, id) => d.locator(FAMILY_BOX[id] || `#mcpGroup-${id}`);
const fillValid = async (d) => {
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
};

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
  for (const name of ['app_explorer.js', 'app_system_view.js', 'app_traces.js', 'app_logs.js', 'app_sql.js', 'app_ui_filterbar.js']) expect(state.scripts, name).not.toContain(name);
  expect(new Set(state.scripts).size).toBe(state.scripts.length);
  // Not tied to a host: the picker is not on screen, the switcher and the theme are.
  await expect(page.locator('#hostPicker')).toBeHidden();
  await expect(page.locator('#pageSelect')).toBeVisible();
  await expect(page.locator('#themeSelect')).toBeVisible();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
});

test('the layout wastes no room: the keys beside a wide side column, New key in the heading, no strip', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const h1 = box('h1');
    const header = box('body > .appHeader');
    const table = box('#mcpKeysBody table');
    const side = box('#mcpSide');
    const head = box('.mcpKeys__head');
    const gutter = parseFloat(getComputedStyle(document.querySelector('#mcpPanel')).paddingLeft);
    return {
      h1: [h1.width, h1.height],
      gutter,
      headTop: head.top - header.bottom,
      refreshRight: box('#mcpNewKey').left - box('#mcpRefresh').right,
      tableRight: table.right,
      sideLeft: side.left,
      sideRight: window.innerWidth - side.right,
      sideWidth: side.width,
      sideTop: side.top - header.bottom,
      rowHeights: [...document.querySelectorAll('#mcpKeysBody tbody tr')].map((tr) => tr.getBoundingClientRect().height),
      nameWidth: box('#mcpKeysBody th.mcpCell--name').width,
    };
  });
  // The heading stays for the screen reader; the switcher says where the reader is.
  expect(m.h1[0]).toBeLessThanOrEqual(1);
  expect(m.h1[1]).toBeLessThanOrEqual(1);
  // No strip and no state container on screen: the keys start at the top of the panel, with New key at the
  // right end of their heading (Refresh before it).
  await expect(page.locator('#mcpHead, .mcpStrip, .mcpBadges')).toHaveCount(0);
  await expect(page.locator('#mcpState')).toBeHidden();
  expect(m.gutter).toBe(12);
  expect(m.headTop).toBeLessThan(m.gutter + 40);
  expect(m.refreshRight).toBeGreaterThan(0);
  await expect(page.locator('#mcpKeys #mcpNewKey')).toHaveClass(/button--primary/);
  await expect(page.locator('#mcpKeys #mcpRefresh')).toHaveClass(/refreshButton/);
  // The side column takes the room: more than a third of the window (36% of 1440 px), beside the keys.
  expect(m.sideLeft).toBeGreaterThanOrEqual(m.tableRight);
  expect(m.sideRight).toBe(m.gutter);
  expect(m.sideWidth).toBeGreaterThan(480);
  expect(m.sideWidth).toBeLessThan(560);
  expect(m.sideTop).toBeLessThan(m.gutter + 4);
  // A key is one table line, and its name column is narrow: a name has 32 characters at most.
  for (const height of m.rowHeights) expect(height).toBeLessThanOrEqual(34);
  expect(m.nameWidth).toBeLessThanOrEqual(200);
  // The shared components: a compact data table, the part heading.
  await expect(page.locator('#mcpKeysBody table')).toHaveClass(/dataTable--compact/);
  await expect(page.locator('#mcpKeysBody .dataTableWrap')).toHaveCount(1);
  // The text about muted limits is gone, and so is the explanation of the status of MCP.
  await expect(page.getByText('A muted limit')).toHaveCount(0);
  for (const text of ['MCP enabled', 'Storage configured', 'Managed from the UI']) await expect(page.getByText(text)).toHaveCount(0);
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
  await expect(page.locator('#mcpLayout')).toBeHidden();
  await expect(page.locator('#mcpNewKey')).toHaveCount(0);
  expect(server.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /meta']);
});

test('the side column: the endpoint with a copy button, connect tabs, hosts with their health, limits', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  const connect = page.locator('#mcpConnect');
  // The endpoint is the first thing of the column, a read-only field with its copy button.
  await expect(connect.locator('#mcpEndpointUrl')).toHaveValue(`${origin}/mcp`);
  await expect(connect.locator('#mcpEndpointUrl')).toHaveClass(/uiInput/);
  await expect(connect.locator('label[for="mcpEndpointUrl"]')).toHaveText('Endpoint');
  const copy = connect.locator('.mcpEndpoint__copy');
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  // The hosts: a list, each with its label and a health badge of the shared component.
  const hosts = page.locator('#mcpSide .mcpHostRow');
  await expect(hosts).toHaveCount(3);
  await expect(hosts.nth(0)).toContainText('prod');
  await expect(hosts.nth(0)).toContainText('Production cluster');
  await expect(hosts.nth(0).locator('.badge--ok')).toHaveText('healthy');
  await expect(hosts.nth(1)).toContainText('down');
  await expect(hosts.nth(2)).toContainText('unknown');
  await expect(hosts.nth(1).locator('.mcpHostRow__label')).toHaveCount(0);
  const limits = page.locator('#mcpSide .mcpLimits');
  await expect(limits.locator('dt')).toHaveText(['Rows per result', 'Timeout', 'Result size', 'SQL size', 'Memory per query', 'Rows read', 'Requests per minute']);
  await expect(limits).toContainText('1,000');
  await expect(limits).toContainText('30 s');
  await expect(limits).toContainText('No limit');
  // "Connect a client" is always open, with the commands built from the real origin.
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

test('the keys table: one line for each key, its secret, scope and limits, and Delete as the only action', async ({ page }) => {
  await open(page);
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('5');
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Secret', 'Hosts', 'Tools', 'Data', 'Limits', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  // Rows keep the order the API gives.
  await expect(rows(page).locator('.mcpKeyName')).toHaveText(['ops-all', 'ci-bot', 'reporting', 'second-ui-key', 'hashed']);
  const cells = (name) => row(page, name).locator('td');
  for (const gone of ['Expires', 'Last used', 'Source', 'Description', 'State']) await expect(page.locator('#mcpKeysBody thead')).not.toContainText(gone);
  // Hosts and tools read "n/total", "All" or "None"; data has no total, so it is "All", "None" or a count of patterns.
  await expect(cells('ops-all').nth(2)).toHaveText('All');
  await expect(cells('ops-all').nth(3)).toHaveText('All');
  await expect(cells('ops-all').nth(4)).toHaveText('All');
  // The key's own limits read at full strength: 200 rows, 10 s.
  await expect(cells('ops-all').nth(5)).toHaveText('200 · 10 s');
  await expect(cells('ci-bot').nth(2)).toHaveText('1/3');
  await expect(cells('ci-bot').nth(2).locator('.mcpMono')).toHaveAttribute('title', 'prod');
  await expect(cells('ci-bot').nth(3)).toHaveText('2/23');
  await expect(cells('ci-bot').nth(3).locator('.mcpMono')).toHaveAttribute('title', 'list_databases, query_table');
  await expect(cells('ci-bot').nth(4)).toHaveText('2 patterns');
  await expect(cells('ci-bot').nth(4).locator('.mcpMono')).toHaveAttribute('title', 'otel, analytics.events');
  await expect(cells('reporting').nth(2)).toHaveText('2/3');
  await expect(cells('reporting').nth(3)).toHaveText('3/23');
  await expect(cells('reporting').nth(4)).toHaveText('All');
  await expect(cells('hashed').nth(3)).toHaveText('1/23');
  // The global limit that a key inherits reads muted and a screen reader hears "(default)".
  await expect(cells('ci-bot').nth(5)).toContainText('1,000 (default)');
  await expect(cells('ci-bot').nth(5).locator('.mcpMuted').first()).toContainText('1,000');
  // A key is made or deleted: no edit, no disable, no rotation anywhere. Delete only, on a key of the page; a lock on a config key.
  await expect(page.locator('#mcpKeysBody').locator('[data-action="edit"], [data-action="toggle"], [data-action="rotate"]')).toHaveCount(0);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(3);
  await expect(row(page, 'ci-bot').locator('[data-action="remove"]')).toHaveAttribute('aria-label', 'Delete ci-bot');
  const config = row(page, 'ops-all');
  await expect(config.locator('[data-action="remove"]')).toHaveCount(0);
  await expect(config.locator('.mcpLocked')).toHaveText('Config file');
  await expect(config.locator('.mcpLocked')).toHaveAttribute('title', /Read-only: this key comes from the config file/);
  await screenshot(page, 'keys-desktop');
});

test('the secret of a key: its first characters and dots, the eye shows it on one line, the copy button copies it', async ({ page }) => {
  const server = await open(page);
  const ui = row(page, 'ci-bot');
  const text = ui.locator('.mcpSecret__text');
  const eye = ui.locator('[data-action="reveal"]');
  // Masked: the hint and dots, nothing else. The list never carries a secret.
  await expect(text).toHaveText(/^a1b2c3d4•+$/);
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(eye).toHaveAttribute('aria-label', 'Show the secret of ci-bot');
  expect(server.calls.filter((call) => call.path.endsWith('/secret'))).toHaveLength(0);
  const maskedHeight = (await ui.boundingBox()).height;
  // The eye asks for the secret of that key and shows all of it, on a single line; the eye changes.
  await eye.click();
  await expect(text).toHaveText('a1b2c3d4-0000-4000-8000-0000a1b2c3d4');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await expect(eye).toHaveAttribute('aria-label', 'Hide the secret of ci-bot');
  expect(server.calls.filter((call) => call.path === '/keys/ui_0a1b2c3d4e5f/secret')).toHaveLength(1);
  expect((await ui.boundingBox()).height).toBe(maskedHeight);
  const fit = await text.evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || 16 }));
  expect(fit.clipped).toBe(false);
  expect(fit.height).toBeLessThanOrEqual(fit.line * 1.5);
  // The column is wide enough for the whole secret: it stays in its cell and hides neither the hosts nor the side column.
  const box = await text.boundingBox();
  const cell = await ui.locator('td.mcpCell--secret').boundingBox();
  const hosts = await ui.locator('td.mcpCell--hosts').boundingBox();
  const side = await page.locator('#mcpSide').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(hosts.x + 1);
  expect(box.x + box.width).toBeLessThanOrEqual(side.x);
  await expect(ui.locator('td.mcpCell--hosts')).toBeVisible();
  // Another key stays masked, and the table did not grow sideways.
  await expect(row(page, 'reporting').locator('.mcpSecret__text')).toHaveText(/•+$/);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await screenshot(page, 'secret-shown');
  // Hide: the secret leaves the page.
  await eye.click();
  await expect(text).toHaveText(/^a1b2c3d4•+$/);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('8000-0000a1b2c3d4');
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
  await expect.poll(() => page.evaluate(() => window.__copied)).toBe('a1b2c3d4-0000-4000-8000-0000a1b2c3d4');
  // Never kept by the browser.
  expect(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href]))).not.toContain('8000-0000a1b2c3d4');
  // A config key whose secret is its hash: no secret to show, the buttons say why.
  const hashed = row(page, 'hashed');
  await expect(hashed.locator('.mcpSecret__text')).toHaveText('Not available');
  await expect(hashed.locator('[data-action="reveal"]')).toBeDisabled();
  await expect(hashed.locator('[data-action="copy-secret"]')).toBeDisabled();
  await expect(hashed.locator('[data-action="reveal"]')).toHaveAttribute('title', /secret_sha256/);
  // A config key with a plain secret shows it like a page key.
  await row(page, 'ops-all').locator('[data-action="reveal"]').click();
  await expect(row(page, 'ops-all').locator('.mcpSecret__text')).toContainText('ops-all-');
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
  // An error of the meta call: the state container shows it, with Retry.
  server.errors['GET /meta'] = { status: 500, body: { error: 'internal', message: 'Meta failed.' } };
  await page.reload();
  await expect(page.locator('#mcpState .uiState--error')).toContainText('Meta failed.');
  await page.locator('#mcpState').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  await expect(page.locator('#mcpState')).toBeHidden();
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
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(0);
});

test('manage_from_ui = false: a read-only page', async ({ page }) => {
  const server = newServer({ meta: { manage_from_ui: false, can_manage: false } });
  await open(page, server);
  await expect(page.locator('#mcpKeysNote')).toContainText('manage_from_ui is false');
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(0);
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

test('New key: name, hosts in a column, data, and one card for each family of permissions', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  // The name has 32 characters at most; the fields that must be filled say it.
  await expect(d.locator('#mcpField-name')).toHaveAttribute('maxlength', '32');
  await expect(d.locator('.mcpRequired')).toHaveCount(4);  // name, hosts, data, permissions
  await expect(d.getByText('TO DO', { exact: false })).toHaveCount(0);
  await expect(d.locator('#mcpSummary, .mcpSummary, .mcpOverview')).toHaveCount(0);
  // Hosts: the hosts that have an mcp_uri, one under the other, none ticked, and no "All hosts".
  const hosts = d.locator('[id^="mcpHost-"]');
  await expect(hosts).toHaveCount(3);
  await expect(d.locator('[id^="mcpHost-"]:checked')).toHaveCount(0);
  const boxes = await hosts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })));
  expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[2].y).toBeGreaterThan(boxes[1].y);
  await expect(d.getByText('All hosts')).toHaveCount(0);
  await expect(d.getByText('All data')).toHaveCount(0);
  // Data: patterns only, and * alone is everything.
  await expect(d.locator('#mcpField-databases')).toBeEnabled();
  await expect(d.locator('input[type="radio"]')).toHaveCount(0);
  // Permissions: one card for each family of the server, in its order, set apart by a border; a check box,
  // never a choice between two levels.
  await expect(d.locator('.mcpGroup__head .uiCheck')).toHaveText(['Schema', 'query_table', 'Observability', 'Explorer', 'System', 'Traces', 'logs_search', 'metrics_series', 'query_library', 'format_sql', 'SQL']);
  await expect(d.locator('.mcpGroup')).toHaveCount(11);
  // A family of one tool has nothing to open: no arrow, and its box is the tool itself.
  await expect(d.locator('.mcpGroup--single')).toHaveCount(5);
  await expect(d.locator('.mcpGroup--single .mcpGroup__toggle')).toHaveCount(0);
  await expect(d.locator('[data-group="library"] #mcpTool-query_library')).toHaveCount(1);
  await expect(d.locator('.mcpGroup__toggle')).toHaveCount(6);
  expect(await d.locator('.mcpGroup').first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  await expect(d.locator('select')).toHaveCount(0);
  // The schema and the read tools start on; the other families start off.
  await expect(d.locator('#mcpGroup-schema')).toBeChecked();
  await expect(family(d, 'read')).toBeChecked();
  await expect(d.locator('#mcpGroup-observability')).not.toBeChecked();
  await expect(d.locator('[data-group="schema"] .mcpGroup__count')).toHaveText('4/4');
  await expect(d.locator('[data-group="observability"] .mcpGroup__count')).toHaveText('0/6');
  // The tools of a family are behind its arrow, one check box each, with what the tool does.
  await expect(d.locator('#mcpGroupBody-observability')).toBeHidden();
  await openGroup(d, 'observability');
  await expect(d.locator('#mcpGroupBody-observability')).toBeVisible();
  await expect(d.locator('#mcpGroupBody-observability .uiCheck__label')).toHaveText(['list_services', 'search_traces', 'get_trace', 'search_logs', 'list_metrics', 'query_metric']);
  await expect(d.locator('#mcpGroupBody-observability')).toContainText('Recent traces by their root span.');
  await expect(d.locator('#mcpTool-search_traces')).not.toBeChecked();
});

test('New key: the box of a family is all its tools, half ticked when only some are on', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const group = d.locator('#mcpGroup-observability');
  await group.check();
  await expect(d.locator('[data-group="observability"] .mcpGroup__count')).toHaveText('6/6');
  await openGroup(d, 'observability');
  for (const name of ['list_services', 'search_traces', 'get_trace', 'search_logs', 'list_metrics', 'query_metric']) await expect(d.locator(`#mcpTool-${name}`)).toBeChecked();
  // One tool off: the box of the family is half ticked and counts 5/6.
  await d.locator('#mcpTool-get_trace').uncheck();
  await expect(d.locator('[data-group="observability"] .mcpGroup__count')).toHaveText('5/6');
  expect(await group.evaluate((el) => el.indeterminate)).toBe(true);
  await expect(group).not.toBeChecked();
  // The box of the family sets all of them again, then none.
  await group.check();
  await expect(d.locator('#mcpTool-get_trace')).toBeChecked();
  await group.uncheck();
  await expect(d.locator('[data-group="observability"] .mcpGroup__count')).toHaveText('0/6');
  await expect(d.locator('#mcpTool-search_logs')).not.toBeChecked();
  expect(await group.evaluate((el) => el.indeterminate)).toBe(false);
});

test('New key: the families that need all the data are locked, with their reason, until the data is *', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const locked = ['explorer', 'system', 'traces', 'logs', 'metrics', 'library', 'query', 'sql'];
  for (const id of locked) {
    await expect(family(d, id)).toBeDisabled();
    await expect(d.locator(`[data-group="${id}"] .mcpGroup__reason`)).toHaveText('needs data *');
  }
  await openGroup(d, 'explorer');
  await expect(d.locator('#mcpTool-explorer_catalog')).toBeDisabled();
  await expect(d.locator('#mcpTool-explorer_catalog')).not.toBeChecked();
  // Other patterns do not unlock them; * alone does.
  await d.locator('#mcpField-databases').fill('otel\n*');
  await expect(d.locator('#mcpGroup-explorer')).toBeDisabled();
  await d.locator('#mcpField-databases').fill('*');
  for (const id of locked) {
    await expect(family(d, id)).toBeEnabled();
    await expect(d.locator(`[data-group="${id}"] .mcpGroup__reason`)).toBeHidden();
  }
  await expect(d.locator('#mcpTool-explorer_catalog')).toBeEnabled();
  // They are off until chosen. A family is chosen whole; the tools of the others stay as they are.
  await expect(d.locator('#mcpGroup-explorer')).not.toBeChecked();
  await d.locator('#mcpGroup-explorer').check();
  await d.locator('#mcpGroup-sql').check();
  await expect(d.locator('[data-group="explorer"] .mcpGroup__count')).toHaveText('2/2');
  await expect(d.locator('[data-group="sql"] .mcpGroup__count')).toHaveText('2/2');
  // Back to a table scope: they are cleared and locked again.
  await d.locator('#mcpField-databases').fill('otel');
  await expect(d.locator('#mcpGroup-explorer')).toBeDisabled();
  await expect(d.locator('#mcpGroup-explorer')).not.toBeChecked();
  await expect(d.locator('[data-group="sql"] .mcpGroup__count')).toHaveText('0/2');
  await screenshot(page, 'form-desktop');
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
  await d.locator('#mcpGroup-observability').check();
  await d.locator('#mcpField-max_rows').fill('200');
  await d.locator('#mcpField-timeout_seconds').fill('10');
  await d.getByRole('button', { name: 'Create key' }).click();
  // The secret panel: the secret with its copy button, and the commands from the real origin.
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created');
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body).toEqual({
    name: 'analyst', hosts: ['prod'], databases: ['otel', 'analytics.events', 'logs_*.*'],
    tools: ['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table', 'list_services', 'search_traces', 'get_trace', 'search_logs', 'list_metrics', 'query_metric'],
    max_rows: 200, timeout_seconds: 10,
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
  await expect(row(page, 'analyst').locator('.mcpSecret__text')).toHaveText(/^3f2a9c1e•+$/);
  await expect(row(page, 'analyst')).not.toContainText(SECRET);
  // Done: the dialog and every node that held the secret leave the page.
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET);
  expect(html).not.toContain('Bearer 3f2a9c1e');
  expect(await storage()).not.toContain(SECRET);
  await expect(row(page, 'analyst').locator('[data-action="open"]')).toBeFocused();
});

test('a key made with all the data can hold the API tools', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('everything');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('*');
  for (const id of ['explorer', 'system', 'traces', 'logs', 'metrics', 'library', 'query', 'sql']) await family(d, id).check();
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.databases).toEqual(['*']);
  expect(post.body.tools).toEqual(expect.arrayContaining(['explorer_catalog', 'explorer_table', 'system_overview', 'traces_search', 'logs_search', 'metrics_series', 'query_library', 'format_sql', 'run_query', 'explain_query', 'list_hosts']));
  expect(post.body.tools).toHaveLength(17);  // every family but Observability (not ticked)
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

test('Create key stays off until the key is valid, and its title says what is missing', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const create = d.getByRole('button', { name: 'Create key' });
  // Nothing is set: the button is off, the title names the first thing that is missing.
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Enter a name.');
  await d.locator('#mcpField-name').fill('Bad Name');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /lower-case letters/);
  await d.locator('#mcpField-name').fill('good-name');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Select at least one host.');
  await d.locator('#mcpHost-0').check();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /Enter at least one data pattern/);
  await d.locator('#mcpField-databases').fill('otel');
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute('title', '');
  // Every permission cleared: off again (the box of each family). Then back on.
  await d.locator('#mcpGroup-schema').uncheck();
  await expect(create).toBeEnabled();  // the read family is still on
  await family(d, 'read').uncheck();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /at least one permission/);
  await d.locator('#mcpGroup-schema').check();
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
  await fillValid(d);
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
  // A name that is taken (409) shows under the name, before its hint.
  server.errors['POST /keys'] = { status: 409, body: { error: 'name_taken', message: 'A key named "analyst" exists.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-name')).toContainText('A key named "analyst" exists.');
  await expect(d.locator('#mcpField-name')).toBeFocused();
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldError-name mcpFieldHint-name');
  // An error with no field shows at the foot of the dialog.
  server.errors['POST /keys'] = { status: 500, body: { error: 'storage_error', message: 'The storage file could not be written.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.uiDialog__error')).toContainText('The storage file could not be written.');
  await expect(d).toBeVisible();
  // The next try works, and the old errors are gone.
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
});

test('a key is made or deleted: nothing on the page changes it, and no request does', async ({ page }) => {
  const server = await open(page);
  // The names of the actions that do not exist any more are nowhere: not in the table, not in the details.
  for (const label of ['Edit', 'Disable', 'Enable', 'Rotate', 'Rotate secret']) await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  for (const label of ['Edit', 'Disable', 'Enable', 'Rotate', 'Rotate secret']) await expect(details(page).getByRole('button', { name: label })).toHaveCount(0);
  await expect(details(page).getByRole('button')).toHaveCount(0);
  expect(server.calls.filter((call) => ['PATCH', 'PUT'].includes(call.method) || call.path.endsWith('/rotate'))).toHaveLength(0);
});

test('delete asks first and removes the key', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Delete key ci-bot?');
  await expect(d).toContainText('This cannot be undone');
  await expect(d).toContainText('This key reads prod.');
  // The focus starts on Cancel; Cancel keeps the key.
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await d.getByRole('button', { name: 'Cancel' }).click();
  expect(server.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(row(page, 'ci-bot')).toHaveCount(0);
  expect(server.calls.filter((call) => call.method === 'DELETE').pop()).toMatchObject({ path: '/keys/ui_0a1b2c3d4e5f' });
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('4');
});

test('a failed delete shows its error above the table; a key that is gone reloads the list', async ({ page }) => {
  const server = await open(page);
  server.errors['DELETE /keys/ui_0a1b2c3d4e5f'] = { status: 500, body: { error: 'storage_error', message: 'The storage file could not be written.' } };
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('The storage file could not be written.');
  await expect(row(page, 'ci-bot')).toHaveCount(1);
  // Someone else deleted a key meanwhile.
  server.keys = server.keys.filter((k) => k.name !== 'second-ui-key');
  await row(page, 'second-ui-key').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('No such key.');
  await expect(row(page, 'second-ui-key')).toHaveCount(0);
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
  // The arrow of a family is a button that says what it opens and whether it is open.
  const arrow = dialog(page).locator('[aria-controls="mcpGroupBody-schema"]');
  await expect(arrow).toHaveAttribute('aria-expanded', 'false');
  await arrow.focus();
  await page.keyboard.press('Enter');
  await expect(arrow).toHaveAttribute('aria-expanded', 'true');
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
      return { bg: css('.mcpWorkspace', 'backgroundColor'), text: css('.mcpKeyName', 'color'), badge: css('#mcpSide .badge', 'color') };
    });
    expect(colors.bg).not.toBe(colors.text);
    await screenshot(page, `theme-${theme}`);
  }
  const bgs = await page.evaluate(() => [getComputedStyle(document.querySelector('.mcpWorkspace')).backgroundColor]);
  expect(bgs[0]).toMatch(/^rgb/);
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
  // The filter sits in the heading, before Refresh and New key.
  const at = await page.evaluate(() => ({ filter: document.querySelector('#mcpKeysFilter').getBoundingClientRect().right, refresh: document.querySelector('#mcpRefresh').getBoundingClientRect().left }));
  expect(at.refresh).toBeGreaterThan(at.filter);
  // A short list has no filter.
  const small = newServer();
  await open(page, small);
  await expect(page.locator('#mcpKeysFilter')).toHaveCount(0);
});

test('a click on a key opens its details under it, one key at a time: source, hosts, data, limits and the permissions by family', async ({ page }) => {
  await open(page);
  // The name is a button; a click on the row outside its buttons does the same.
  const open1 = row(page, 'ci-bot').locator('[data-action="open"]');
  await expect(open1).toHaveAttribute('aria-expanded', 'false');
  await expect(details(page)).toHaveCount(0);
  await open1.click();
  // No popup: the details are a row of the table, right under the key.
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(details(page)).toHaveCount(1);
  await expect(page.locator('tr[data-key-id="ui_0a1b2c3d4e5f"] + tr.mcpDetailRow')).toHaveCount(1);
  await expect(open1).toHaveAttribute('aria-expanded', 'true');
  await expect(open1).toHaveAttribute('aria-controls', 'mcpDetail-ui_0a1b2c3d4e5f');
  const d = details(page);
  const about = d.locator('.mcpAbout');
  await expect(about).toContainText('This page');
  await expect(about).not.toContainText('Secret');
  await expect(about.locator('.mcpChip')).toHaveText(['prod', 'otel', 'analytics.events']);
  await expect(about).toContainText('1,000 (default)');
  await expect(about).toContainText('30 s (default)');
  // Every family of the server is listed with what the key holds in it; the tools it holds are named.
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('2 of 23');
  await expect(d.locator('.mcpGrantGroup__title')).toHaveText(['Schema', 'Read', 'Observability', 'Explorer', 'System', 'Traces', 'Logs', 'Metrics', 'Library', 'Query', 'SQL']);
  await expect(d.locator('[data-group="schema"] .mcpGrantGroup__count')).toHaveText('1 of 4');
  await expect(d.locator('[data-group="read"] .mcpGrantGroup__count')).toHaveText('1 of 1');
  await expect(d.locator('[data-group="explorer"] .mcpGrantGroup__count')).toHaveText('0 of 2');
  await expect(d.locator('.mcpGrant .mcpGrant__name')).toHaveText(['list_databases', 'query_table']);
  await expect(d.locator('.mcpGrant[data-tool="query_table"]')).toContainText('Rows of one table');
  await expect(d.locator('.mcpGrantGroup.is-empty')).toHaveCount(9);
  // The details span the table's width and need no scroll of the page's own to be read.
  const wide = await d.evaluate((el) => ({ cell: el.querySelector('td').getBoundingClientRect().width, table: el.closest('table').getBoundingClientRect().width }));
  expect(wide.cell).toBeGreaterThan(wide.table - 4);
  await screenshot(page, 'details');
  // One at a time: another key closes this one.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  await expect(page.locator('tr[data-key-id="ui_111111111111"] + tr.mcpDetailRow')).toHaveCount(1);
  await expect(open1).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'reporting').locator('[data-action="open"]')).toHaveAttribute('aria-expanded', 'true');
  // The same key again closes it, and the focus stays on its name.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(0);
  await expect(row(page, 'reporting').locator('[data-action="open"]')).toBeFocused();
  // A click on a cell of the row (not on a button) opens it too, and the eye of the table does not.
  await row(page, 'reporting').locator('td').nth(2).click();
  await expect(details(page)).toHaveCount(1);
  await row(page, 'reporting').locator('td').nth(2).click();
  await expect(details(page)).toHaveCount(0);
  await row(page, 'reporting').locator('[data-action="reveal"]').click();
  await expect(details(page)).toHaveCount(0);
  // The open key stays open when the list is drawn again.
  await open1.click();
  await page.locator('#mcpRefresh').click();
  await expect(details(page)).toHaveCount(1);
  await expect(page.locator('tr[data-key-id="ui_0a1b2c3d4e5f"] + tr.mcpDetailRow')).toHaveCount(1);
  // Deleting the key takes its details with it.
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(row(page, 'ci-bot')).toHaveCount(0);
  await expect(details(page)).toHaveCount(0);
});

test('the details of a key with every tool name the tools it holds, the ones that need all the data only with it', async ({ page }) => {
  const server = newServer();
  server.keys.push(key({ id: 'ui_444444444444', name: 'star-narrow', tools: ['*'], databases: ['otel'] }));
  await open(page, server);
  // ops-all: tools ["*"] and data "*": all of them. A key with "*" and a narrower data holds the tools that do not need all the data.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  let d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('23 of 23');
  await expect(d.locator('.mcpGrantGroup.is-empty')).toHaveCount(0);
  await expect(d.locator('.mcpAbout')).toContainText('The config file');
  await expect(d.locator('.mcpAbout')).toContainText('200');
  await expect(d.locator('.mcpAbout')).toContainText('10 s');
  await row(page, 'star-narrow').locator('[data-action="open"]').click();
  d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('11 of 23');
  await expect(d.locator('[data-group="sql"] .mcpGrantGroup__count')).toHaveText('0 of 2');
  await expect(d.locator('[data-group="explorer"] .mcpGrantGroup__count')).toHaveText('0 of 2');
  await expect(d.locator('[data-group="observability"] .mcpGrantGroup__count')).toHaveText('6 of 6');
});

test('a page that cannot change keys still shows the details of a key', async ({ page }) => {
  await open(page, newServer({ meta: { manage_from_ui: false, can_manage: false } }));
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpGrantGroup')).toHaveCount(11);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(0);
});

test('Connect a client: the blocks of code are coloured (JSON, command, values), and copy the plain text', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  const panel = (name) => page.locator(`#mcpHelpClient-${name} .mcpCode__pre`);
  // The command: the program, the flags, the URL and the quoted header have their own colours.
  await expect(panel('code')).toHaveText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "Authorization: Bearer <secret>"`);
  await expect(panel('code').locator('.tok-kw')).toHaveText(['claude']);
  await expect(panel('code').locator('.tok-type')).toHaveText(['--transport', '--header']);
  await expect(panel('code').locator('.tok-fn')).toHaveText([`${origin}/mcp`]);
  await expect(panel('code').locator('.tok-str')).toHaveText(['"Authorization: Bearer <secret>"']);
  // JSON: the keys and the strings differ, the numbers and literals too.
  await page.getByRole('button', { name: 'JSON' }).click();
  await expect(panel('json').locator('.tok-fn')).toHaveText(['"mcpServers"', '"chdash-name"', '"type"', '"url"', '"headers"', '"Authorization"']);
  await expect(panel('json').locator('.tok-str')).toHaveText(['"http"', `"${origin}/mcp"`, '"Bearer <secret>"']);
  const colour = (loc) => loc.first().evaluate((el) => getComputedStyle(el).color);
  const [plain, key, str] = [await panel('json').evaluate((el) => getComputedStyle(el).color), await colour(panel('json').locator('.tok-fn')), await colour(panel('json').locator('.tok-str'))];
  expect(new Set([plain, key, str]).size).toBe(3);
  await page.getByRole('button', { name: 'Desktop' }).click();
  await expect(panel('desktop').locator('.tok-str')).toContainText(['"npx"', '"-y"', '"mcp-remote"']);
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(panel('inspector').locator('.tok-fn')).toHaveText(['Transport Type', 'URL', 'Header name', 'Header value']);
  // The off state shows the HCL block, coloured as well.
  const off = newServer({ meta: { enabled: false } });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, off);
  await expect(page.locator('#mcpOff .mcpCode__pre .tok-fn').first()).toHaveText('enabled');
  await expect(page.locator('#mcpOff .mcpCode__pre .tok-kw')).toHaveText(['mcp', 'clickhouse', 'host']);
});

test('the header of the key comes from the config (mcp.auth_header): the commands name it, Authorization is the default', async ({ page }) => {
  const server = newServer({ meta: { auth_header: 'X-ChDash-Key' } });
  await open(page, server);
  const origin = new URL(page.url()).origin;
  // Another header takes the key alone, without Bearer.
  await expect(page.locator('#mcpHelpClient-code .mcpCode__pre')).toHaveText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "X-ChDash-Key: <secret>"`);
  await page.getByRole('button', { name: 'JSON' }).click();
  expect(JSON.parse(await page.locator('#mcpHelpClient-json .mcpCode__pre').innerText())).toEqual({ mcpServers: { 'chdash-name': { type: 'http', url: `${origin}/mcp`, headers: { 'X-ChDash-Key': '<secret>' } } } });
  await page.getByRole('button', { name: 'Desktop' }).click();
  const desktop = JSON.parse(await page.locator('#mcpHelpClient-desktop .mcpCode__pre').innerText());
  expect(desktop.mcpServers['chdash-name']).toEqual({ command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'X-ChDash-Key:${AUTH_HEADER}'], env: { AUTH_HEADER: '<secret>' } });
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(page.locator('#mcpHelpClient-inspector .mcpCode__pre')).toContainText('Header name      X-ChDash-Key');
  await expect(page.locator('#mcpConnect')).toContainText('The key in the X-ChDash-Key header');
  // The panel after a create names it too.
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.mcpCode__pre').first()).toContainText(`--header "X-ChDash-Key: ${SECRET}"`);
});

test('New key: the window keeps its size whatever the content, and the columns scroll inside it', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await page.waitForTimeout(400);
  const before = await d.boundingBox();
  // Opening families, an error under a field: the size does not move.
  for (const id of ['schema', 'observability', 'explorer', 'system', 'traces']) await openGroup(d, id);
  await d.locator('#mcpField-name').fill('Bad Name');
  const after = await d.boundingBox();
  expect(Math.round(after.width)).toBe(Math.round(before.width));
  expect(Math.round(after.height)).toBe(Math.round(before.height));
  expect(after.y + after.height).toBeLessThanOrEqual(900);
  // The permissions column scrolls by itself; the dialog does not.
  const scroll = await d.locator('.mcpKeyForm__perms').evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  expect(scroll).toEqual({ scrolls: true, overflowY: 'auto' });
  expect(await d.locator('.uiDialog__body').evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden');
  // The foot stays in view.
  await expect(d.getByRole('button', { name: 'Create key' })).toBeInViewport();
});

test('the details of a key: the families sit in tidy columns, without gaps of a row between them', async ({ page }) => {
  await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const gaps = await details(page).locator('.mcpGranted').evaluate((el) => {
    const boxes = [...el.querySelectorAll('.mcpGrantGroup')].map((g) => g.getBoundingClientRect());
    const columns = new Map();
    for (const b of boxes) { const key = Math.round(b.left); columns.set(key, [...(columns.get(key) || []), b]); }
    return [...columns.values()].flatMap((list) => list.slice(1).map((b, i) => Math.round(b.top - list[i].bottom)));
  });
  expect(gaps.length).toBeGreaterThan(0);
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(10);
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
    // The table is 49 rem wide at least (the whole secret fits its column): at 800 px it keeps its width and scrolls inside its box.
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
    const remove = first.locator('[data-action="remove"]');
    await expect(remove).toHaveCount(1);
    const box = await remove.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(24);
    await expect(remove).toContainText('Delete');
    // The eye and the copy button of the secret are reachable too, at the size of a finger.
    for (const action of ['reveal', 'copy-secret']) {
      const secretBox = await first.locator(`[data-action="${action}"]`).boundingBox();
      expect(secretBox.x + secretBox.width).toBeLessThanOrEqual(390);
      expect(secretBox.height).toBeGreaterThanOrEqual(32);
    }
    // New key is in the heading and fits.
    const create = await page.locator('#mcpNewKey').boundingBox();
    expect(create.x + create.width).toBeLessThanOrEqual(390);
    await page.locator('#mcpConnect').scrollIntoViewIfNeeded();
    await expect(page.locator('#mcpConnect')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await screenshot(page, 'keys-phone');
    // The form as a bottom sheet that fits.
    await page.locator('#mcpNewKey').click();
    const sheet = await dialog(page).boundingBox();
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(390.5);
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
