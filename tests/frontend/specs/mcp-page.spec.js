import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { horizontalOverflow } from '../helpers/app.js';
import { fetchedModules } from '../helpers/modules.js';
import { ELSEWHERE, GROUPS, KEYS, META, SECRET, SECTIONS, TOOLS, T, costOf, install, json, key, maskOf, newServer, oneInstance, reachOf, setUsage, summaryOf } from '../helpers/mcp-fake.js';

// The MCP integration page (mcp.html, /mcp-integration, docs/mcp-integration-page.md) shows the access keys of the MCP server built into ChDash.
// It also shows how to connect a client.
// The server side is a small in-memory server behind page.route, with the JSON of /api/mcp/*, as the contract fixes it.
// The page runs on any instance, so the page route and /api/version are answered here too.
// The page is not tied to a host.
// The page appears in the page switcher as "MCP" only when features.mcp.enabled is set.
//
// The page makes or deletes a key. It never changes a key.

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
// A secret is not shown in full. The page shows its first 8 characters, the hint, to tell the keys apart.
// Then dots follow for the rest. The hyphens of the UUID stay (MASKED, in the title of the cell). The cell is short: the hint, the next group and an ellipsis (SHORT).
const MASKED = /^[0-9a-f]{8}-\u2022{4}-\u2022{4}-\u2022{4}-\u2022{12}$/;
const SHORT = /^[0-9a-f]{8}-\u2022{4}\u2026$/;
const maskTitle = (hint) => new RegExp(`^${hint}-\u2022{4}-\u2022{4}-\u2022{4}-\u2022{12}\n`);

async function open(page, server = newServer()) {
  await install(page, server);
  await page.goto('/mcp-integration');
  await page.waitForFunction(() => !!(window.ChDash?.features && window.ChDash?.mcpView));
  return server;
}

const rows = (page) => page.locator('#mcpKeysBody tbody tr');
const row = (page, name) => page.locator(`#mcpKeysBody tbody tr:has(.mcpKeyName:text-is("${name}"))`);
const dialog = (page) => page.locator('dialog.mcpDialog[open]');
// The details of a key open in a row under it. Only one key is open at a time.
const details = (page) => page.locator('#mcpKeysBody tr.mcpDetailRow');
// The tools of a family are behind its arrow. A test opens the card before it touches a tool.
const openGroup = async (d, id) => {
  const toggle = d.locator(`[aria-controls="mcpGroupBody-${id}"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};
// A family of one tool has no arrow and no box of its own. Its check box is the tool.
const family = (d, id) => d.locator(`#mcpGroup-${id}`);
// Observability has one card for each signal: "Observability - Traces", "Observability - Logs", "Observability - Metrics".
const SIGNALS = ['observability-traces', 'observability-logs', 'observability-metrics'];
const checkObservability = async (d) => { for (const id of SIGNALS) await family(d, id).check(); };
const fillValid = async (d) => {
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel');
};

async function screenshot(page, name) {
  // A dialog appears slowly. The picture waits until the dialog is fully visible.
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
    sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0]),
  }));
  state.scripts = await fetchedModules(page);
  expect(state.page).toBe('mcp');
  expect(state.sheets).toEqual(['style.mcp.css']);
  // The file app_mcp_instances.js holds the note "Summed over 2 instances" and its warnings.
  // It is a module of Keys too. The usage of a key and the column Used need it.
  for (const name of ['app_page_mcp.js', 'app_mcp_view.js', 'app_mcp_form.js', 'app_mcp_usage.js', 'app_mcp_instances.js', 'app_api.js']) expect(state.scripts, name).toContain(name);
  for (const name of ['app_explorer.js', 'app_system_view.js', 'app_traces.js', 'app_logs.js', 'app_sql.js', 'app_ui_filterbar.js', 'app_mcp_overview.js', 'app_mcp_bar.js', 'app_mcp_charts.js', 'app_chart_core.js', 'app_page_mcpusage.js']) expect(state.scripts, name).not.toContain(name);
  expect(new Set(state.scripts).size).toBe(state.scripts.length);
  // The page is not tied to a host. The host picker is not on screen. The page switcher and the theme are on screen.
  await expect(page.locator('#hostPicker')).toBeHidden();
  await expect(page.locator('#pageSelect')).toBeVisible();
  await expect(page.locator('#themeSelect')).toBeVisible();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // The row of the two MCP pages has Keys (this page, the current one) and Usage (mcp-usage.spec.js).
  await expect(page.locator('#mcpTabs a.contentTabs__tab')).toHaveText(['Keys', 'Usage']);
  await expect(page.locator('#mcpTabs [aria-current="page"]')).toHaveText('Keys');
  await expect(page.locator('#mcpTab-usage')).toHaveAttribute('href', '/mcp-integration/usage');
});

test('the layout wastes no room: the keys beside a wide side column, New key in the heading, no strip', async ({ page }) => {
  await open(page);
  const m = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect();
    const h1 = box('h1');
    // The row of the two MCP pages (Keys, Usage) is the nav row under the header. The content starts under it.
    const nav = box('.mcpPage__nav');
    const table = box('#mcpKeysBody table');
    const side = box('#mcpSide');
    const head = box('.mcpKeys__head');
    const panel = document.querySelector('#mcpPanel');
    const gutter = parseFloat(getComputedStyle(panel).paddingLeft);
    const bar = panel.offsetWidth - panel.clientWidth;  // the room kept for the scrollbar
    return {
      bar,
      h1: [h1.width, h1.height],
      gutter,
      headTop: head.top - nav.bottom,
      refreshRight: box('#mcpNewKey').left - box('#mcpRefresh').right,
      tableRight: table.right,
      sideLeft: side.left,
      sideRight: window.innerWidth - side.right,
      sideWidth: side.width,
      sideTop: side.top - nav.bottom,
      rowHeights: [...document.querySelectorAll('#mcpKeysBody tbody tr')].map((tr) => tr.getBoundingClientRect().height),
      nameWidth: box('#mcpKeysBody th.mcpCell--name').width,
    };
  });
  // The heading stays for the screen reader. The page switcher tells the reader where the reader is.
  expect(m.h1[0]).toBeLessThanOrEqual(1);
  expect(m.h1[1]).toBeLessThanOrEqual(1);
  // No strip and no state container is on screen. The keys start at the top of the panel, under the row of links.
  // New key is at the right end of the heading of the keys, and Refresh is before it.
  await expect(page.locator('#mcpHead, .mcpStrip, .mcpBadges')).toHaveCount(0);
  await expect(page.locator('#mcpState')).toBeHidden();
  expect(m.gutter).toBe(12);
  expect(m.headTop).toBeLessThan(m.gutter + 40);
  expect(m.refreshRight).toBeGreaterThan(0);
  await expect(page.locator('#mcpKeys #mcpNewKey')).toHaveClass(/button--primary/);
  await expect(page.locator('#mcpKeys #mcpRefresh')).toHaveClass(/refreshButton/);
  // The side column takes the room: more than a third of the window (36% of 1440 px), beside the keys.
  expect(m.sideLeft).toBeGreaterThanOrEqual(m.tableRight);
  expect(m.sideRight).toBe(m.gutter + m.bar);  // the scrollbar has its room, scrolling or not
  expect(m.sideWidth).toBeGreaterThan(480);
  expect(m.sideWidth).toBeLessThan(560);
  expect(m.sideTop).toBeLessThan(m.gutter + 4);
  // A key is one table line. Its name column is narrow: a name has 32 characters at most.
  for (const height of m.rowHeights) expect(height).toBeLessThanOrEqual(38);
  expect(m.nameWidth).toBeLessThanOrEqual(200);
  // The shared components are a compact data table and the part heading.
  await expect(page.locator('#mcpKeysBody table')).toHaveClass(/dataTable--compact/);
  await expect(page.locator('#mcpKeysBody .dataTableWrap')).toHaveCount(1);
  // The text about muted limits is gone. The explanation of the status of MCP is gone too.
  await expect(page.getByText('A muted limit')).toHaveCount(0);
  for (const text of ['MCP enabled', 'Storage configured', 'Managed from the UI']) await expect(page.getByText(text)).toHaveCount(0);
});

test('the page switcher lists MCP, selected on this page, and every other page can open it', async ({ page }) => {
  await open(page);
  // Every page is a link of the switcher. The link of this page is the current one.
  await expect(page.locator('#pageSelectMenu a:visible')).toHaveText(['Query', 'Explorer', 'Observability', 'System', 'MCP']);
  await expect(page.locator('#navMcpLink')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#navMcpLink')).toHaveAttribute('href', '/mcp-integration');
  await expect(page.locator('#pageSelectButton')).toHaveText('MCP');
  // From another page, the MCP entry appears once /api/version reports features.mcp.enabled. The entry opens the page.
  await page.goto('/query');
  await expect(page.locator('#pageSelectMenu a:visible')).toHaveText(['Query', 'Explorer', 'Observability', 'System', 'MCP']);
  await page.locator('#navMcpLink').click();
  await expect(page).toHaveURL(/\/mcp-integration$/);
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // Go back to Query from MCP.
  await page.locator('#navQueryLink').click();
  await expect(page).toHaveURL(/\/query$/);
});

test('the MCP entry is hidden while features.mcp is off, and its page shows how to turn MCP on', async ({ page }) => {
  const server = newServer({ version: { mcp: { enabled: false } }, meta: { enabled: false } });
  server.meta = { enabled: false };
  await install(page, server);
  await page.goto('/system');
  expect(await page.locator('#pageSelectMenu a:visible').allTextContents()).not.toContain('MCP');
  await expect(page.locator('#navMcpLink')).toBeHidden();
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
  // The row of the two pages stays. Usage shows the same state.
  await expect(page.locator('#mcpTabs a.contentTabs__tab')).toHaveText(['Keys', 'Usage']);
});

test('the side column: the endpoint with a copy button, connect tabs, hosts with their health, limits', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  const connect = page.locator('#mcpConnect');
  // The endpoint is the first item of the column. It is a read-only field with its copy button.
  await expect(connect.locator('#mcpEndpointUrl')).toHaveValue(`${origin}/mcp`);
  await expect(connect.locator('#mcpEndpointUrl')).toHaveClass(/uiInput/);
  await expect(connect.locator('label[for="mcpEndpointUrl"]')).toHaveText('Endpoint');
  const copy = connect.locator('.mcpEndpoint__copy');
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  // The hosts are a list. Each host has its label and a health badge of the shared component.
  const hosts = page.locator('#mcpSide .mcpHostRow');
  await expect(hosts).toHaveCount(3);
  await expect(hosts.nth(0)).toContainText('prod');
  await expect(hosts.nth(0)).toContainText('Production cluster');
  await expect(hosts.nth(0).locator('.badge--ok')).toHaveText('Healthy');
  // A host whose MCP user cannot connect says so, in place of its health.
  // The other hosts show the user that the tools run as.
  await expect(hosts.nth(1).locator('.badge--error')).toHaveText('MCP user down');
  await expect(hosts.nth(1).locator('.badge--error')).toHaveAttribute('title', /Authentication failed/);
  await expect(hosts.nth(0).locator('.mcpHostRow__user')).toHaveText('chdash_mcp');
  await expect(hosts.nth(2)).toContainText('unknown');
  await expect(hosts.nth(1).locator('.mcpHostRow__label')).toHaveCount(0);
  const limits = page.locator('#mcpSide .mcpLimits');
  await expect(limits.locator('dt')).toHaveText(['Rows per result', 'Timeout', 'Result size', 'SQL size', 'Memory per query', 'Rows read', 'Requests per minute']);
  await expect(limits).toContainText('1,000');
  await expect(limits).toContainText('30 s');
  await expect(limits).toContainText('No limit');
  // The rate limit is a counter for each instance. Every ChDash that shares the usage directory has its own counter.
  // The note says so.
  await expect(page.locator('#mcpLimitsBlock .mcpNote')).toHaveText('A key can lower the rows and the timeout. It never raises them. The request limit counts for each key, on each instance.');
  // The "Connect a client" part is always open. Its commands use the real origin.
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
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Used', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  // Rows keep the order that the API gives.
  await expect(rows(page).locator('.mcpKeyName')).toHaveText(['ops-all', 'ci-bot', 'reporting', 'second-ui-key', 'legacy']);
  const cells = (name) => row(page, name).locator('td');
  for (const gone of ['Expires', 'Last used', 'Source', 'Description', 'State']) await expect(page.locator('#mcpKeysBody thead')).not.toContainText(gone);
  // The host is its name, because a key reads one host. Tools read "n/total", "All" or "None". Data has no total. It reads "All", "None" or a count of patterns.
  // A key of an older file that names several hosts says "n hosts" in the warning colour.
  // The tools count the two tools that every key has: mcp_analysis_my_limits and mcp_analysis_my_usage. The count is out of the 25 tools that this server offers.
  // The third tool of the analysis is not offered while mcp.usage.all_keys is off.
  await expect(cells('ops-all').nth(2)).toHaveText('prod');
  await expect(cells('ops-all').nth(3)).toHaveText('All');
  // "*" leaves nothing out here. The tool that "*" never gives is not offered, so the title has nothing to say about it.
  await expect(cells('ops-all').nth(3).locator('.mcpMuted')).toHaveAttribute('title', 'All tools');
  // The data is the number of databases and tables that the key reaches. The server counts them once for all the keys.
  await expect(cells('ops-all').nth(4)).toHaveText('2 dbs \u00b7 4 tables');
  // The limits of the key read at full strength: 200 rows and 10 s.
  await expect(cells('ops-all').nth(5)).toHaveText('200 · 10 s');
  await expect(cells('ci-bot').nth(2)).toHaveText('prod');
  await expect(cells('ci-bot').nth(2).locator('.mcpHostCell')).toHaveAttribute('title', 'prod');
  await expect(cells('ci-bot').nth(3)).toHaveText('4/25');
  await expect(cells('ci-bot').nth(3).locator('.mcpMono')).toHaveAttribute('title', 'list_databases, query_table, mcp_analysis_my_limits, mcp_analysis_my_usage');
  await expect(cells('ci-bot').nth(4)).toHaveText('2 dbs \u00b7 4 tables');
  await expect(cells('ci-bot').nth(4).locator('.mcpDataCell')).toHaveAttribute('title', /Data patterns: otel, analytics\.events/);
  await expect(cells('reporting').nth(2)).toHaveText('2 hosts');
  await expect(cells('reporting').nth(2).locator('.mcpWarn')).toHaveAttribute('title', /prod, staging\nA key reads one host now/);
  await expect(cells('reporting').nth(3)).toHaveText('5/25');
  await expect(cells('reporting').nth(4)).toHaveText('2 dbs \u00b7 4 tables');
  await expect(cells('legacy').nth(3)).toHaveText('3/25');
  // The global limit that a key inherits reads muted. A screen reader hears "(default)".
  await expect(cells('ci-bot').nth(5)).toContainText('1,000 (default)');
  await expect(cells('ci-bot').nth(5).locator('.mcpMuted').first()).toContainText('1,000');
  // A key is made or deleted. There is no edit, no disable and no rotation. Only Delete is on the page, for a key of the page.
  // On a config key, nothing shows: no lock and no icon.
  await expect(page.locator('#mcpKeysBody').locator('[data-action="edit"], [data-action="toggle"], [data-action="rotate"]')).toHaveCount(0);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(4);  // the keys of the page, the old one included
  await expect(row(page, 'ci-bot').locator('[data-action="remove"]')).toHaveAttribute('aria-label', 'Delete ci-bot');
  const config = row(page, 'ops-all');
  await expect(config.locator('[data-action="remove"]')).toHaveCount(0);
  // No Delete is shown. A lock stands in its place, and the lock says why.
  await expect(config.locator('td.mcpCell--actions button')).toHaveCount(0);
  await expect(config.locator('td.mcpCell--actions .mcpLock')).toHaveAttribute('title', /config file/);
  // The Delete icon has no frame, like the other icons of the table.
  const frame = await row(page, 'ci-bot').locator('[data-action="remove"]').evaluate((el) => { const c = getComputedStyle(el); return { border: c.borderTopColor, width: c.borderTopWidth, bg: c.backgroundColor }; });
  expect(frame.bg).toBe('rgba(0, 0, 0, 0)');
  expect(frame.border).toBe('rgba(0, 0, 0, 0)');
  await row(page, 'ci-bot').locator('[data-action="remove"]').hover();
  expect(await row(page, 'ci-bot').locator('[data-action="remove"]').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgba(0, 0, 0, 0)');
  await screenshot(page, 'keys-desktop');
});

test('an orphan key says that it is refused, and Adopt makes the person its creator with the same secret', async ({ page }) => {
  // User decision 2026-10-18: a key of the page with no creator, or whose creator the PDP does not know any more, is refused until a
  // person adopts it. The list shows it with a warning and Adopt beside Delete.
  const server = newServer();
  const orphan = server.keys.find((k) => k.name === 'second-ui-key');
  Object.assign(orphan, { creator: 'leaver', orphan: 'creator_gone' });
  await open(page, server);
  const target = row(page, 'second-ui-key');
  await expect(target.locator('.mcpCell--name .badge')).toHaveText('Refused');
  await expect(target.locator('.mcpCell--name .badge')).toHaveAttribute('title', /does not know the creator of this key: the account was deleted.*until a person adopts it/);
  // Only the orphan key has Adopt. The other keys keep Delete alone.
  await expect(page.locator('#mcpKeysBody [data-action="adopt"]')).toHaveCount(1);
  await expect(target.locator('[data-action="adopt"]')).toHaveAttribute('aria-label', 'Adopt second-ui-key');
  await expect(row(page, 'ci-bot').locator('.badge')).toHaveCount(0);
  // The two actions fit their column: nothing overflows the cell or the page.
  const cell = await target.locator('td.mcpCell--actions').evaluate((td) => ({ scroll: td.scrollWidth, client: td.clientWidth }));
  expect(cell.scroll).toBeLessThanOrEqual(cell.client);
  expect(await horizontalOverflow(page)).toBe(0);
  await target.locator('[data-action="adopt"]').click();
  await expect(dialog(page)).toContainText('You become the creator of this key. The secret does not change');
  await dialog(page).getByRole('button', { name: 'Adopt key' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(server.calls.filter((c) => c.method === 'POST' && c.path === `/keys/${orphan.id}/adopt`)).toHaveLength(1);
  // The list is read again: the key has a creator, no warning and no Adopt.
  await expect(target.locator('.badge')).toHaveCount(0);
  await expect(page.locator('#mcpKeysBody [data-action="adopt"]')).toHaveCount(0);
  // A refusal of the server shows its message.
  Object.assign(orphan, { creator: null, orphan: 'no_creator' });
  server.errors[`POST /keys/${orphan.id}/adopt`] = { status: 403, body: { error_code: 'forbidden', action: 'explorer.read', message: 'The action explorer.read is not allowed.', retryable: false } };
  await page.locator('#mcpRefresh').click();
  await expect(target.locator('.mcpCell--name .badge')).toHaveAttribute('title', /has no creator/);
  await target.locator('[data-action="adopt"]').click();
  await dialog(page).getByRole('button', { name: 'Adopt key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('explorer.read');
});

test('the details of a key: Observability is one card for each signal, with the tools the key holds in it', async ({ page }) => {
  const server = newServer();
  server.keys.push(key({ id: 'ui_obs', name: 'obs-key', tools: ['search_traces', 'search_logs', 'query_metric', 'traces_search'], databases: ['*'] }));
  await open(page, server);
  await row(page, 'obs-key').locator('[data-action="open"]').click();
  // The cards hold a tool of the key: the three signals, and the analysis. A key holds the two tools that every key has, listed or not.
  const cards = details(page).locator('.mcpGrantGroup:has(.mcpGrant)[data-group^="observability"]');
  await expect(cards.locator('.mcpGrantGroup__title')).toHaveText(['Observability - Traces', 'Observability - Logs', 'Observability - Metrics']);
  await expect(details(page).locator('.mcpGrantGroup:has(.mcpGrant)')).toHaveCount(4);
  await expect(details(page).locator('[data-group="mcp_analysis"] .mcpGrant__name')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  await expect(details(page).locator('[data-group="observability-traces"] .mcpGrantGroup__count')).toHaveText('2 of 5');
  await expect(details(page).locator('[data-group="observability-logs"] .mcpGrantGroup__count')).toHaveText('1 of 2');
  await expect(details(page).locator('[data-group="observability-metrics"] .mcpGrantGroup__count')).toHaveText('1 of 3');
  await expect(details(page).locator('[data-group="observability-traces"] .mcpGrant__name')).toHaveText(['search_traces', 'traces_search']);
  // No card holds the three signals together.
  await expect(details(page).locator('[data-group="observability"]')).toHaveCount(0);
});

test('a key shows the first 8 characters of its secret, so that the keys can be told apart', async ({ page }) => {
  await open(page);
  // The hint, the next group of dots and an ellipsis are shown. The title has the whole shape of the UUID.
  // A key of a file that kept no hint has dots only.
  await expect(row(page, 'ci-bot').locator('.mcpSecret__text')).toHaveText('a1b2c3d4-\u2022\u2022\u2022\u2022\u2026');
  await expect(row(page, 'ci-bot').locator('.mcpSecret__text')).toHaveAttribute('title', maskTitle('a1b2c3d4'));
  await expect(row(page, 'second-ui-key').locator('.mcpSecret__text')).toHaveText(/^9d4e6b20-\u2022{4}\u2026$/);
  await expect(row(page, 'ops-all').locator('.mcpSecret__text')).toHaveText(SHORT);
  await expect(row(page, 'legacy').locator('.mcpSecret__text')).toHaveText(/^\u2022{8}-\u2022{4}\u2026$/);
});

test('the data of a key is how many databases and tables it reaches, counted once for all the keys', async ({ page }) => {
  const server = newServer({
    keys: [
      key({ id: 'ui_one', name: 'one-table', hosts: ['prod'], databases: ['otel.otel_logs'] }),
      key({ id: 'ui_none', name: 'nothing', hosts: ['prod'], databases: ['nowhere'] }),
      key({ id: 'ui_down', name: 'down-host', hosts: ['staging'], databases: ['*'] }),
      key({ id: 'ui_many', name: 'everything', hosts: ['prod'], databases: ['*'] }),
    ],
    summary: (keys) => ({
      keys: keys.map((owner) => ({
        ui_one: { id: owner.id, status: 'ok', host: 'prod', user: 'chdash_mcp', databases: 1, tables: 1, partial_tables: 1, all_data: false },
        ui_none: { id: owner.id, status: 'ok', host: 'prod', user: 'chdash_mcp', databases: 0, tables: 0, partial_tables: 0, all_data: false },
        ui_down: { id: owner.id, status: 'unavailable', error: 'Authentication failed' },
        ui_many: { id: owner.id, status: 'ok', host: 'prod', user: 'chdash_mcp', databases: 12, tables: 1840, partial_tables: 0, all_data: true },
      })[owner.id]),
    }),
  });
  server.delay['GET /access'] = 400;
  await open(page, server);
  const data = (name) => row(page, name).locator('.mcpDataCell');
  // Until the answer comes, the cell says that it counts. The table is already on the screen.
  await expect(data('one-table')).toHaveText('\u2026');
  await expect(data('one-table')).toHaveAttribute('title', /Counting the databases and tables/);
  await expect(data('one-table')).toHaveText('1 db \u00b7 1 table');
  await expect(data('everything')).toHaveText('12 dbs \u00b7 1,840 tables');
  // The title says what the number is, with the patterns of the key. A table read in part is counted apart.
  await expect(data('one-table')).toHaveAttribute('title', /1 database and 1 table on prod, as the MCP user chdash_mcp\.\n1 table is read in part \(some columns\)\.\nData patterns: otel\.otel_logs/);
  await expect(data('everything')).toHaveAttribute('title', /Data patterns: \*/);
  // A key that reaches nothing says so in the warning colour. A host whose MCP user cannot connect is not counted.
  await expect(data('nothing')).toHaveText('0 dbs \u00b7 0 tables');
  await expect(data('nothing')).toHaveClass(/mcpWarn/);
  await expect(data('nothing')).toHaveAttribute('title', /match nothing that the MCP user may read/);
  await expect(data('down-host')).toHaveText('\u2014');
  await expect(data('down-host')).toHaveAttribute('title', /Not counted: Authentication failed/);
  // The page makes one request for all the keys, not one for each key.
  expect(server.calls.filter((call) => call.path === '/access')).toHaveLength(1);
  // A key that is open stays open when the counts arrive. The table is not drawn again.
  await row(page, 'everything').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  await page.locator('#mcpRefresh').click();
  await expect.poll(() => server.calls.filter((call) => call.path === '/access' && call.query === '?refresh=1').length).toBe(1);
  await expect(data('everything')).toHaveText('12 dbs \u00b7 1,840 tables');
});

test('the data of the keys cannot be counted: the cells say so and the table stays', async ({ page }) => {
  const server = newServer();
  server.errors['GET /access'] = { status: 503, body: { error_code: 'host_unavailable', message: 'The MCP user cannot connect.' } };
  await open(page, server);
  await expect(row(page, 'ci-bot').locator('.mcpDataCell')).toHaveText('\u2014');
  await expect(row(page, 'ci-bot').locator('.mcpDataCell')).toHaveAttribute('title', /Data patterns: otel, analytics\.events/);
  await expect(rows(page)).toHaveCount(5);
});

test('the secret of a key is never shown again: no eye, no copy, no request for it (SEC-009)', async ({ page }) => {
  const server = await open(page);
  const ui = row(page, 'ci-bot');
  const text = ui.locator('.mcpSecret__text');
  // The page shows only the hint and dots. The server keeps a hash of the secret, and no route gives the secret.
  await expect(text).toHaveText(SHORT);
  await expect(text).toHaveAttribute('title', /ClickHouse Dash showed it once.*delete the key and make a new one/);
  expect((await text.getAttribute('title')).split('\n')[0]).toMatch(MASKED);
  for (const name of ['ci-bot', 'ops-all', 'legacy']) {
    await expect(row(page, name).locator('td.mcpCell--secret button')).toHaveCount(0);
  }
  await expect(page.locator('[data-action="reveal"], [data-action="copy-secret"]')).toHaveCount(0);
  await ui.locator('td.mcpCell--secret').click();
  expect(server.calls.filter((call) => call.path.endsWith('/secret'))).toHaveLength(0);
  // The column fits the mask on one line, beside the hosts.
  const fit = await text.evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) || 16 }));
  expect(fit.clipped).toBe(false);
  expect(fit.height).toBeLessThanOrEqual(fit.line * 1.5);
  const box = await text.boundingBox();
  const hosts = await ui.locator('td.mcpCell--hosts').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(hosts.x + 1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // The side column says how to get a secret: copy it when the key is made.
  await expect(page.locator('#mcpConnect')).toContainText('copy its secret when ClickHouse Dash shows it (only once)');
});

test('loading skeleton, error with Retry, empty list', async ({ page }) => {
  const server = newServer();
  server.delay['GET /keys'] = 700;
  await install(page, server);
  await page.goto('/mcp-integration');
  await expect(page.locator('#mcpKeysBody .uiState--loading')).toBeVisible();
  await expect(page.locator('#mcpKeysBody .uiState--loading')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // An error of the keys call shows the message and Retry.
  server.errors['GET /keys'] = { status: 500, body: { error_code: 'storage_error', message: 'The key storage could not be read.' } };
  await page.locator('#mcpRefresh').click();
  await expect(page.locator('#mcpAlert')).toContainText('The key storage could not be read.');
  server.errors['GET /keys'] = { status: 500, body: { error_code: 'storage_error', message: 'The key storage could not be read.' } };
  await page.reload();
  const error = page.locator('#mcpKeysBody .uiState--error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('Could not load the keys');
  await expect(error).toContainText('The key storage could not be read.');
  await error.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  // An error of the meta call shows in the state container, with Retry.
  server.errors['GET /meta'] = { status: 500, body: { error_code: 'internal', message: 'Meta failed.' } };
  await page.reload();
  await expect(page.locator('#mcpState .uiState--error')).toContainText('Meta failed.');
  await page.locator('#mcpState').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#mcpKeysBody table')).toBeVisible();
  await expect(page.locator('#mcpState')).toBeHidden();
  // The list is empty.
  server.keys = [];
  await page.reload();
  const empty = page.locator('#mcpKeysBody .uiState--empty');
  await expect(empty).toContainText('No access keys yet');
  await expect(empty.getByRole('button', { name: 'New key' })).toBeVisible();
  // The side column stays. The commands to connect are next to the empty list.
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

test('keys.mode = static: a read-only page', async ({ page }) => {
  const server = newServer({ meta: { manage_from_ui: false, keys_mode: 'static', can_manage: false } });
  await open(page, server);
  await expect(page.locator('#mcpKeysNote')).toContainText('keys.mode is static');
  await expect(page.locator('#mcpNewKey')).toBeDisabled();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(0);
  await expect(row(page, 'ci-bot').locator('td.mcpCell--actions button')).toHaveCount(0);
  await expect(row(page, 'ci-bot').locator('td.mcpCell--actions .mcpLock')).toHaveAttribute('title', /read-only/);
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

test('New key: Max rows and Timeout stop at the largest value as the number is typed, and say who limits it (the MCP server or the ClickHouse user)', async ({ page }) => {
  const limit = (value, source) => ({ value, source });
  const server = newServer({
    meta: {
      limits: { ...META.limits, max_rows: 1000, query_timeout_seconds: 30 },
      hosts: [
        { name: 'prod', label: 'Production', healthy: true, mcp: { user: 'dashboard-arb', state: 'ok', error: '', reads_nothing: false, unavailable_tools: [], profile: { known: true, readonly: 2, max_execution_time: 30, max_result_rows: 500 }, limits: { max_rows: limit(500, 'clickhouse'), timeout_seconds: limit(30, 'both') } } },
        { name: 'lab', label: 'Lab', healthy: true, mcp: { user: 'chdash_lab', state: 'ok', error: '', reads_nothing: false, unavailable_tools: [], profile: { known: true, readonly: 0, max_execution_time: 0, max_result_rows: 0 }, limits: { max_rows: limit(1000, 'mcp'), timeout_seconds: limit(30, 'mcp') } } },
      ],
    },
  });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const rows = d.locator('#mcpField-max_rows');
  const timeout = d.locator('#mcpField-timeout_seconds');
  const rowsHint = d.locator('#mcpFieldHint-max_rows');
  const timeoutHint = d.locator('#mcpFieldHint-timeout_seconds');
  // The first host has a ClickHouse user that limits the rows to 500. Both the MCP server and the ClickHouse user set the time.
  await expect(rows).toHaveAttribute('max', '500');
  await expect(rowsHint).toContainText('At most 500: limited by the ClickHouse user dashboard-arb');
  await expect(rowsHint).toContainText('max_result_rows');
  await expect(timeoutHint).toContainText('set by the MCP server (mcp.query_timeout_seconds) and by the ClickHouse user dashboard-arb');
  // A number above the largest value is brought back to that value at each keystroke. The form does not wait until it is sent.
  await rows.click();
  await page.keyboard.type('60');
  await expect(rows).toHaveValue('60');
  await page.keyboard.type('0');
  await expect(rows).toHaveValue('500');
  await expect(rowsHint).toHaveClass(/is-capped/);
  await rows.fill('');
  await page.keyboard.type('250');
  await expect(rows).toHaveValue('250');
  await expect(rowsHint).not.toHaveClass(/is-capped/);
  await timeout.fill('99');
  await expect(timeout).toHaveValue('30');
  // The second host has the MCP server limits. A value that is too large for the new host is brought back.
  await rows.fill('500');
  await d.locator('label[for="mcpHost-1"]').click();
  await expect(rows).toHaveAttribute('max', '1000');
  await expect(rowsHint).toContainText('At most 1,000: limited by the MCP server (mcp.max_rows)');
  await expect(rows).toHaveValue('500');
  await d.locator('label[for="mcpHost-0"]').click();
  await expect(rows).toHaveValue('500');
  await rows.fill('500');
  await d.locator('label[for="mcpHost-1"]').click();
  await rows.fill('900');
  await d.locator('label[for="mcpHost-0"]').click();
  await expect(rows).toHaveValue('500');
});

test('New key: a single host is a fact, not a choice: nothing to click, its name centred with its health, label and MCP user', async ({ page }) => {
  const server = newServer({
    meta: {
      hosts: [{ name: 'prod-local-dash', label: 'ClickHouse production arb', healthy: true, mcp: { user: 'dashboard-arb', state: 'ok', error: '', reads_nothing: false, unavailable_tools: [] } }],
    },
  });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const fact = d.locator('.mcpHostOnly');
  await expect(fact).toBeVisible();
  await expect(fact.locator('.mcpHostOnly__name')).toHaveText('prod-local-dash');
  await expect(fact.locator('.mcpHostOnly__label')).toHaveText('ClickHouse production arb');
  await expect(fact.locator('.mcpHostOnly__note')).toHaveText('as dashboard-arb');
  // No radio button is shown. Nothing in the fact answers a click.
  await expect(d.locator('input[name="host"]:visible')).toHaveCount(0);
  await expect(d.locator('label[for="mcpHost-0"]')).toHaveCount(0);
  // The name is centred on the line of the dot, the icon and the label. The test measures these parts at the same instant.
  // The dialog moves while it opens.
  const offsets = await fact.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const mid = (node) => { const r = node.getBoundingClientRect(); return r.top + r.height / 2 - (box.top + box.height / 2); };
    return ['.mcpHostOnly__dot', '.mcpHostOnly__icon', '.mcpHostOnly__name', '.mcpHostOnly__label', '.mcpHostOnly__note'].map((sel) => mid(el.querySelector(sel)));
  });
  for (const offset of offsets) expect(Math.abs(offset)).toBeLessThanOrEqual(2);
  // The key is still made for that host.
  await d.locator('#mcpField-name').fill('arb-reader');
  await d.getByRole('button', { name: 'Create key' }).click();
  // The request leaves after the click. Wait for the request.
  await expect.poll(() => server.calls.some((call) => call.method === 'POST' && call.path === '/keys')).toBe(true);
  const created = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(created.body.hosts).toEqual(['prod-local-dash']);
});

test('New key: name, hosts in a column, data, and one card for each family of permissions', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  // The name has 32 characters at most. The fields that must be filled are marked.
  await expect(d.locator('#mcpField-name')).toHaveAttribute('maxlength', '32');
  await expect(d.locator('.mcpRequired')).toHaveCount(4);  // name, hosts, data, permissions
  await expect(d.getByText('TO DO', { exact: false })).toHaveCount(0);
  await expect(d.locator('#mcpSummary, .mcpSummary, .mcpOverview')).toHaveCount(0);
  // The host field: a key reads one host. Only hosts with an mcp_uri are listed, one under the other, as radio buttons.
  // The first host whose MCP user connects is chosen. A host whose MCP user cannot connect is greyed, and the reason is shown. No "All hosts" option exists.
  const hosts = d.locator('[id^="mcpHost-"]');
  await expect(hosts).toHaveCount(3);
  expect(await hosts.evaluateAll((els) => els.map((el) => el.type))).toEqual(['radio', 'radio', 'radio']);
  await expect(d.locator('[id^="mcpHost-"]:checked')).toHaveCount(1);
  await expect(d.locator('#mcpHost-0')).toBeChecked();
  await expect(d.locator('#mcpHost-1')).toBeDisabled();
  await expect(d.locator('label[for="mcpHost-1"] .mcpHostDown')).toHaveText('The MCP user chdash_mcp cannot connect');
  await expect(d.locator('label[for="mcpHost-1"]')).toHaveAttribute('title', /Authentication failed/);
  await expect(d.locator('#mcpHost-2')).toBeEnabled();
  await expect(d.locator('[data-wrap="hosts"] legend')).toContainText('Host');
  const boxes = await hosts.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y) })));
  expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
  expect(boxes[1].y).toBeGreaterThan(boxes[0].y);
  expect(boxes[2].y).toBeGreaterThan(boxes[1].y);
  await expect(d.getByText('All hosts')).toHaveCount(0);
  await expect(d.getByText('All data')).toHaveCount(0);
  // Data holds patterns only. The * pattern alone means everything.
  await expect(d.locator('#mcpField-databases')).toBeEnabled();
  await expect(d.locator('.mcpGroups input[type="radio"]')).toHaveCount(0);
  // Permissions: each family of the server has one card, in the order of the server.
  // A border sets each card apart. Each card has a check box, not a choice between two levels.
  await expect(d.locator('.mcpGroup__head .uiCheck')).toHaveText(['Data', 'Explorer', 'System', 'Observability - Traces', 'Observability - Logs', 'Observability - Metrics', 'Query', 'SQL']);
  // The ninth card, the analysis of the usage, has a title and no box. It holds tools that every key has, or that a key names. See its own test cases.
  await expect(d.locator('.mcpGroup')).toHaveCount(9);
  expect(await d.locator('.mcpGroup').evaluateAll((els) => els.map((el) => el.dataset.group))).toEqual(['data', 'explorer', 'system', ...SIGNALS, 'query', 'sql', 'mcp_analysis']);
  await expect(d.locator('.mcpGroup__head .mcpGroup__title')).toHaveText(['MCP analysis']);
  // Every family has at least two tools. So every card has an arrow, and no card is a lone check box.
  await expect(d.locator('.mcpGroup--single')).toHaveCount(0);
  await expect(d.locator('.mcpGroup__toggle')).toHaveCount(9);
  expect(await d.locator('.mcpGroup').first().evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');
  await expect(d.locator('select')).toHaveCount(0);
  // The data tools start on. The other families start off.
  await expect(d.locator('#mcpGroup-data')).toBeChecked();
  for (const id of SIGNALS) await expect(family(d, id)).not.toBeChecked();
  await expect(d.locator('[data-group="data"] .mcpGroup__count')).toHaveText('5/5');
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('0/5');
  await expect(d.locator('[data-group="observability-logs"] .mcpGroup__count')).toHaveText('0/2');
  await expect(d.locator('[data-group="observability-metrics"] .mcpGroup__count')).toHaveText('0/3');
  // The tools of a family are behind its arrow. Each tool has one check box and a text that says what the tool does.
  await expect(d.locator('#mcpGroupBody-observability-traces')).toBeHidden();
  await openGroup(d, 'observability-traces');
  await openGroup(d, 'observability-logs');
  await openGroup(d, 'observability-metrics');
  await expect(d.locator('#mcpGroupBody-observability-traces')).toBeVisible();
  // Observability has a card for each signal. The page tools and the simple tools of a signal stay together in one card.
  await expect(d.locator('#mcpGroupBody-observability-traces .uiCheck__label')).toHaveText(['list_services', 'search_traces', 'get_trace', 'traces_search', 'traces_trace']);
  await expect(d.locator('#mcpGroupBody-observability-logs .uiCheck__label')).toHaveText(['search_logs', 'logs_search']);
  await expect(d.locator('#mcpGroupBody-observability-metrics .uiCheck__label')).toHaveText(['list_metrics', 'query_metric', 'metrics_series']);
  await expect(d.locator('#mcpGroupBody-observability-traces')).toContainText('Recent traces by their root span.');
  await expect(d.locator('#mcpTool-search_traces')).not.toBeChecked();
});

test('New key: the box of a family is all its tools, half ticked when only some are on', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const group = d.locator('#mcpGroup-observability-traces');
  await d.locator('#mcpField-databases').fill('otel');  // the tools of this family read the otel tables
  await group.check();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('5/5');
  // The other signals have their own cards. They stay off.
  await expect(d.locator('[data-group="observability-logs"] .mcpGroup__count')).toHaveText('0/2');
  await openGroup(d, 'observability-traces');
  for (const name of ['list_services', 'search_traces', 'get_trace', 'traces_search']) await expect(d.locator(`#mcpTool-${name}`)).toBeChecked();
  // One tool is off. The box of the family is half ticked and counts 4/5.
  await d.locator('#mcpTool-get_trace').uncheck();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('4/5');
  expect(await group.evaluate((el) => el.indeterminate)).toBe(true);
  await expect(group).not.toBeChecked();
  // The box of the family sets all tools again, and then clears them.
  await group.check();
  await expect(d.locator('#mcpTool-get_trace')).toBeChecked();
  await group.uncheck();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('0/5');
  await expect(d.locator('#mcpTool-search_traces')).not.toBeChecked();
  expect(await group.evaluate((el) => el.indeterminate)).toBe(false);
});

test('New key: only the SQL tools need *; every other tool is given by its permission', async ({ page }) => {
  await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  // The data is * by default. The MCP user grants still limit what a key reads, so every family can be ticked.
  // The SQL tools cannot be cut by a pattern. They need the data * alone.
  // Every other tool is read as the pages read it. The MCP user is the runner, and the system user adds the figures and reads the otel tables.
  // Other tools follow the patterns of the key (the catalog, one table). The permission gives each tool, with any data.
  await expect(d.locator('#mcpField-databases')).toHaveValue('*');
  await expect(family(d, 'sql')).toBeEnabled();
  await d.locator('#mcpField-databases').fill('chdash_ui');
  await expect(family(d, 'sql')).toBeDisabled();
  await expect(d.locator('[data-group="sql"] .mcpGroup__reason')).toHaveText('needs data *');
  for (const id of ['data', 'explorer', 'system', ...SIGNALS, 'query']) {
    await expect(family(d, id)).toBeEnabled();
    await expect(d.locator(`[data-group="${id}"] .mcpGroup__reason`)).toBeHidden();
  }
  for (const id of SIGNALS) await openGroup(d, id);
  for (const name of ['list_services', 'search_traces', 'get_trace', 'search_logs', 'list_metrics', 'query_metric', 'traces_search', 'logs_search', 'metrics_series']) {
    await expect(d.locator(`#mcpTool-${name}`)).toBeEnabled();
  }
  // Other patterns do not unlock the SQL tools. Only * unlocks them.
  await d.locator('#mcpField-databases').fill('otel');
  await expect(family(d, 'sql')).toBeDisabled();
  await d.locator('#mcpField-databases').fill('chdash_ui\n*');
  await expect(d.locator('#mcpGroup-sql')).toBeDisabled();
  await d.locator('#mcpField-databases').fill('*');
  await expect(family(d, 'sql')).toBeEnabled();
  await expect(d.locator('[data-group="sql"] .mcpGroup__reason')).toBeHidden();
  // The families are off until they are chosen. A family is chosen as a whole. The tools of the other families stay as they are.
  await expect(d.locator('#mcpGroup-sql')).not.toBeChecked();
  await d.locator('#mcpGroup-sql').check();
  await checkObservability(d);
  await expect(d.locator('[data-group="sql"] .mcpGroup__count')).toHaveText('2/2');
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('5/5');
  // Go back to a narrower scope. The SQL tools are cleared and locked again. The other tools stay as they are.
  await d.locator('#mcpField-databases').fill('chdash_ui');
  await expect(d.locator('[data-group="sql"] .mcpGroup__count')).toHaveText('0/2');
  await expect(family(d, 'sql')).toBeDisabled();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('5/5');
  await screenshot(page, 'form-desktop');
});

test('New key: a single host is chosen already', async ({ page }) => {
  const server = newServer({ meta: { hosts: [{ name: 'prod', label: 'Production cluster', healthy: true }] } });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await expect(d.locator('[id^="mcpHost-"]')).toHaveCount(1);
  await expect(d.locator('#mcpHost-0')).toBeChecked();
  await d.locator('#mcpField-name').fill('solo');
  await d.locator('#mcpField-databases').fill('otel');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  expect(server.calls.find((call) => call.method === 'POST' && call.path === '/keys').body.hosts).toEqual(['prod']);
});

test('New key: no host can be chosen when the MCP user of every host cannot connect', async ({ page }) => {
  const down = { user: 'chdash_mcp', state: 'unavailable', error: 'connection refused', reads_nothing: false, unavailable_tools: [] };
  const server = newServer({ meta: { hosts: [{ name: 'prod', label: 'Production cluster', healthy: false, mcp: down }, { name: 'lab', label: 'Lab', healthy: null, mcp: down }] } });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await expect(d.locator('[id^="mcpHost-"]:checked')).toHaveCount(0);
  await expect(d.locator('[id^="mcpHost-"]:enabled')).toHaveCount(0);
  await d.locator('#mcpField-name').fill('nowhere');
  await d.locator('#mcpField-databases').fill('otel');
  const create = d.getByRole('button', { name: 'Create key' });
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Choose the host that the key reads.');
});

test('New key: the tools that the MCP user of the chosen host cannot serve are greyed, with the grant that is missing', async ({ page }) => {
  const server = await open(page);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-databases').fill('*');
  await d.locator('#mcpField-name').fill('lab-key');
  // The prod host has no missing grant.
  await expect(d.locator('.mcpHostNote')).toHaveText('Tools run as chdash_mcp.');
  for (const id of SIGNALS) await openGroup(d, id);
  await expect(d.locator('#mcpTool-search_logs')).toBeEnabled();
  await checkObservability(d);
  await expect(d.locator('#mcpTool-traces_search')).toBeChecked();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('5/5');
  await expect(d.locator('[data-group="observability-logs"] .mcpGroup__count')).toHaveText('2/2');
  await expect(d.locator('[data-group="observability-metrics"] .mcpGroup__count')).toHaveText('3/3');
  // The lab host lacks three grants. Three tools are unticked and locked. The title says what to grant.
  await d.locator('#mcpHost-2').check();
  await expect(d.locator('.mcpHostNote')).toHaveText('Tools run as chdash_lab. 3 tools need a grant that this user lacks: they are greyed.');
  await expect(d.locator('#mcpTool-search_logs')).toBeDisabled();
  await expect(d.locator('#mcpTool-search_logs')).not.toBeChecked();
  await expect(d.locator('label[for="mcpTool-search_logs"]')).toHaveAttribute('title', /The system user chdash_sys cannot serve this tool: it lacks SELECT ON otel\.otel_logs\.\nGRANT SELECT ON otel\.otel_logs TO chdash_sys;/);
  await expect(d.locator('#mcpTool-search_traces')).toBeEnabled();
  await expect(d.locator('#mcpTool-search_traces')).toBeChecked();
  // The tools of the pages read with the system user. The title names the user that lacks the grant.
  // The other tools do not change.
  await expect(d.locator('label[for="mcpTool-traces_search"]')).toHaveAttribute('title', /The system user chdash_sys cannot serve this tool: it lacks SELECT ON otel\.otel_traces\./);
  await expect(d.locator('#mcpTool-traces_search')).toBeDisabled();
  await expect(d.locator('#mcpTool-traces_search')).not.toBeChecked();
  await expect(d.locator('#mcpTool-traces_trace')).toBeEnabled();
  await expect(d.locator('#mcpTool-traces_trace')).toBeChecked();
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__count')).toHaveText('4/5');
  await expect(d.locator('[data-group="observability-logs"] .mcpGroup__count')).toHaveText('0/2');
  await expect(d.locator('[data-group="observability-metrics"] .mcpGroup__count')).toHaveText('3/3');
  // A card whose tools all lack a grant says so in its head. The other cards say nothing.
  await expect(d.locator('[data-group="observability-logs"] .mcpGroup__reason')).toHaveText('no grant');
  await expect(d.locator('[data-group="observability-traces"] .mcpGroup__reason')).toBeHidden();
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.hosts).toEqual(['lab']);
  expect(post.body.tools).not.toContain('traces_search');
  expect(post.body.tools).not.toContain('logs_search');
  expect(post.body.tools).not.toContain('search_logs');
  expect(post.body.tools).toContain('search_traces');
});

test('create a key: the request, the one-time secret and its commands, nothing left behind', async ({ page }) => {
  const server = await open(page);
  const origin = new URL(page.url()).origin;
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await d.locator('#mcpField-name').fill('analyst');
  await d.locator('#mcpHost-0').check();
  await d.locator('#mcpField-databases').fill('otel\nanalytics.events\n\nlogs_*.*');
  await checkObservability(d);
  await d.locator('#mcpField-max_rows').fill('200');
  await d.locator('#mcpField-timeout_seconds').fill('10');
  await d.getByRole('button', { name: 'Create key' }).click();
  // The secret panel shows the secret with its copy button, and the commands with the real origin.
  // This is the only time the secret is shown. The panel says so.
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created');
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  await expect(d.locator('.mcpReveal__warn')).toContainText('ClickHouse Dash shows it only this time');
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body).toEqual({
    name: 'analyst', hosts: ['prod'], databases: ['otel', 'analytics.events', 'logs_*.*'],
    tools: ['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table', 'list_services', 'search_traces', 'get_trace', 'traces_search', 'traces_trace', 'search_logs', 'logs_search', 'list_metrics', 'query_metric', 'metrics_series'],
    max_rows: 200, timeout_seconds: 10,
  });
  const commands = d.locator('.mcpCode__pre');
  await expect(commands.nth(0)).toHaveText(`claude mcp add --transport http chdash-analyst ${origin}/mcp --header "Authorization: Bearer ${SECRET}"`);
  await d.getByRole('button', { name: 'JSON' }).click();
  const config = JSON.parse(await d.locator('.mcpClients__panel:not([hidden]) .mcpCode__pre').innerText());
  expect(config).toEqual({ mcpServers: { 'chdash-analyst': { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${SECRET}` } } } });
  await d.locator('.mcpEndpoint__copy').click();
  await expect(d.locator('.mcpEndpoint__copy')).toHaveClass(/is-copied/);
  // The secret is never in the browser storage and never in the address. This holds even while the panel shows it.
  const storage = () => page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href, document.cookie]));
  expect(await storage()).not.toContain(SECRET);
  await screenshot(page, 'secret-desktop');
  // The list behind the panel is drawn again. It shows only the first characters and dots.
  await expect(row(page, 'analyst')).toHaveCount(1);
  await expect(row(page, 'analyst').locator('.mcpSecret__text')).toHaveText(SHORT);
  await expect(row(page, 'analyst')).not.toContainText(SECRET);
  // When done, the dialog and every node that held the secret leave the page.
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
  for (const id of ['explorer', 'system', ...SIGNALS, 'query', 'sql']) await family(d, id).check();
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.databases).toEqual(['*']);
  expect(post.body.tools).toEqual(expect.arrayContaining(['explorer_catalog', 'explorer_table', 'system_overview', 'traces_search', 'logs_search', 'metrics_series', 'query_library', 'format_sql', 'run_query', 'explain_query', 'list_hosts']));
  // Every family that has a box has the two tools that every key has. Those two tools are checked and locked. They are never sent.
  expect(post.body.tools).toHaveLength(23);
  expect(post.body.tools).not.toContain('mcp_analysis_my_limits');
  expect(post.body.tools).not.toContain('mcp_analysis_my_usage');
});

// The analysis of the usage in the key form. `mcp_analysis` is a family of the server table, like the others.
// The catalog flags draw its tools: `always` (every key has it), `explicit_only` ("*" does not give it), and `available` (the server offers it now). The page never draws a tool by its name.
const DATA_TOOLS = ['list_hosts', 'list_databases', 'list_tables', 'describe_table', 'query_table'];

test('New key: the analysis card is open, the two tools that every key has are checked and locked, and the tool of all the keys is off', async ({ page }) => {
  const server = setUsage(newServer(), { allKeys: true });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const card = d.locator('[data-group="mcp_analysis"]');
  // The last card has a title and no box of its own. No tool of it is chosen as a whole.
  // The last card opens at once, so nothing hides what the key holds. The other families stay behind their arrow.
  await expect(d.locator('.mcpGroup').last()).toHaveAttribute('data-group', 'mcp_analysis');
  await expect(card.locator('.mcpGroup__title')).toHaveText('MCP analysis');
  await expect(d.locator('#mcpGroup-mcp_analysis')).toHaveCount(0);
  await expect(card.locator('.mcpGroup__toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(d.locator('#mcpGroupBody-mcp_analysis')).toBeVisible();
  await expect(d.locator('#mcpGroupBody-data')).toBeHidden();
  await expect(d.locator('#mcpGroupBody-mcp_analysis .uiCheck__label')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage', 'mcp_analysis_all_usage']);
  // The tools that every key has are on and locked. The label says so, and a screen reader hears it with the name of the tool.
  for (const name of ['mcp_analysis_my_limits', 'mcp_analysis_my_usage']) {
    const box = d.locator(`#mcpTool-${name}`);
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    await expect(d.locator(`label[for="mcpTool-${name}"]`)).toHaveClass(/is-always/);
    await expect(d.locator(`label[for="mcpTool-${name}"] .uiCheck__note`)).toHaveText('Every key has it');
    await expect(box).toHaveAccessibleName(new RegExp(`${name}\\s*Every key has it`));
  }
  // The tool that "*" does not give is off. It is free to tick, and its label says that "*" leaves it out.
  const all = d.locator('#mcpTool-mcp_analysis_all_usage');
  await expect(all).not.toBeChecked();
  await expect(all).toBeEnabled();
  await expect(d.locator('label[for="mcpTool-mcp_analysis_all_usage"] .uiCheck__note')).toHaveText('"*" does not include it');
  await expect(all).toHaveAccessibleName(/"\*" does not include it/);
  // Two of the three tools are on. No tool is locked, so the head of the family gives no reason.
  await expect(card.locator('.mcpGroup__count')).toHaveText('2/3');
  await expect(card.locator('.mcpGroup__reason')).toBeHidden();
  // No box ticks this tool. No box unticks the two tools that every key has.
  // The card has no box. The box of another family belongs to that family.
  const families = ['data', 'explorer', 'system', ...SIGNALS, 'query', 'sql'];
  await d.locator('#mcpField-databases').fill('*');
  for (const id of families) await family(d, id).check();
  await expect(all).not.toBeChecked();
  await expect(card.locator('.mcpGroup__count')).toHaveText('2/3');
  for (const id of families) await family(d, id).uncheck();
  await expect(all).not.toBeChecked();
  await expect(d.locator('#mcpTool-mcp_analysis_my_limits')).toBeChecked();
  await expect(d.locator('#mcpTool-mcp_analysis_my_usage')).toBeChecked();
  await expect(card.locator('.mcpGroup__count')).toHaveText('2/3');
});

test('New key: the tools that every key has are never sent and make no permission, and the tool of all the keys is not sent while it is off', async ({ page }) => {
  const server = setUsage(newServer(), { allKeys: true });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  const create = d.getByRole('button', { name: 'Create key' });
  // Without a tool of its own, the key is not valid, even when two tools are checked.
  // Those two tools belong to the key, whatever the key says. They are not a choice.
  await d.locator('#mcpGroup-data').uncheck();
  await expect(d.locator('#mcpTool-mcp_analysis_my_limits')).toBeChecked();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /at least one permission/);
  await d.locator('#mcpGroup-data').check();
  await expect(create).toBeEnabled();
  await create.click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.tools).toEqual(DATA_TOOLS);
});

test('New key: the tool of all the keys is sent when it is ticked, and only then, with no tool that every key has', async ({ page }) => {
  const server = setUsage(newServer(), { allKeys: true });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  const all = d.locator('#mcpTool-mcp_analysis_all_usage');
  const count = d.locator('[data-group="mcp_analysis"] .mcpGroup__count');
  await all.check();
  await expect(count).toHaveText('3/3');
  await all.uncheck();
  await expect(count).toHaveText('2/3');
  await all.check();
  await expect(count).toHaveText('3/3');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.tools).toEqual([...DATA_TOOLS, 'mcp_analysis_all_usage']);
  expect(post.body.tools).not.toContain('mcp_analysis_my_limits');
  expect(post.body.tools).not.toContain('mcp_analysis_my_usage');
  // The list behind the dialog shows the tools of the key.
  // The key holds the two tools that every key has, and the one that it named, with its data tools (8 of 26).
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(row(page, 'analyst').locator('td').nth(3)).toHaveText('8/26');
  await expect(row(page, 'analyst').locator('td').nth(3).locator('.mcpMono')).toHaveAttribute('title', `${DATA_TOOLS.join(', ')}, mcp_analysis_my_limits, mcp_analysis_my_usage, mcp_analysis_all_usage`);
});

test('New key: a tool that "*" does not give is a choice of its own in any family: the box of the family neither ticks nor unticks it', async ({ page }) => {
  // The page knows no tool by its name. The catalog flag says which tool it is.
  // Here, a family that has a box (Data) holds such a tool too.
  const server = newServer();
  server.meta.tools.push(T('data_audit', 'data', 'Reads what the other tools of the family do not.', false, '', { explicit_only: true }));
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  const audit = d.locator('#mcpTool-data_audit');
  const box = d.locator('#mcpGroup-data');
  const count = d.locator('[data-group="data"] .mcpGroup__count');
  // The card opens at once, because it holds a tool to name.
  // Data starts on, without the tool that must be named.
  await expect(d.locator('#mcpGroupBody-data')).toBeVisible();
  await expect(box).toBeChecked();
  await expect(audit).not.toBeChecked();
  await expect(audit).toBeEnabled();
  await expect(d.locator('label[for="mcpTool-data_audit"] .uiCheck__note')).toHaveText('"*" does not include it');
  await expect(count).toHaveText('5/6');
  // The box clears the plain tools and sets them again. The tool to name stays off.
  await box.uncheck();
  await expect(count).toHaveText('0/6');
  await box.check();
  await expect(count).toHaveText('5/6');
  await expect(audit).not.toBeChecked();
  // When ticked by hand, the tool stays on if the box is cleared. The box covers the plain tools only, and the box does not need this tool ticked.
  await audit.check();
  await expect(count).toHaveText('6/6');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(audit).toBeChecked();
  await expect(count).toHaveText('1/6');
  await box.check();
  await expect(count).toHaveText('6/6');
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.tools).toEqual([...DATA_TOOLS, 'data_audit']);
});

test('New key: the tool of all the keys is not offered while mcp.usage.all_keys is off, and the card holds the two tools that every key has', async ({ page }) => {
  await open(page);  // all_keys is off in the fake by default: the catalog says that the tool is not available
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const card = d.locator('[data-group="mcp_analysis"]');
  await expect(d.locator('#mcpTool-mcp_analysis_all_usage')).toHaveCount(0);
  await expect(d.locator('#mcpGroupBody-mcp_analysis .uiCheck__label')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  await expect(card.locator('.mcpGroup__count')).toHaveText('2/2');
  // Two tools are given, and there is nothing to choose. The card still has its own title, opens, and locks nothing.
  await expect(card.locator('.mcpGroup__toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.mcpGroup__reason')).toBeHidden();
  await expect(d.locator('#mcpGroup-mcp_analysis')).toHaveCount(0);
  await expect(d.locator('#mcpTool-mcp_analysis_my_limits')).toBeDisabled();
  await expect(d.locator('#mcpTool-mcp_analysis_my_usage')).toBeDisabled();
});

test('New key: with the usage off the analysis card is the one tool that every key has, with no arrow, and nothing of the usage is offered', async ({ page }) => {
  const server = setUsage(newServer(), { enabled: false });
  await open(page, server);
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  const card = d.locator('[data-group="mcp_analysis"]');
  // Nothing is counted, so the analysis of the usage is not offered. Only the tool that reads the limits of the key is offered.
  await expect(d.locator('[id^="mcpTool-mcp_analysis"]')).toHaveCount(1);
  await expect(d.locator('#mcpTool-mcp_analysis_my_limits')).toBeChecked();
  await expect(d.locator('#mcpTool-mcp_analysis_my_limits')).toBeDisabled();
  await expect(d.locator('#mcpTool-mcp_analysis_my_usage')).toHaveCount(0);
  await expect(d.locator('#mcpTool-mcp_analysis_all_usage')).toHaveCount(0);
  // A family of one tool is the tool itself. It has a check box in the head, no arrow and no count.
  // The note says that every key has it.
  await expect(d.locator('.mcpGroup')).toHaveCount(9);
  await expect(card).toHaveClass(/mcpGroup--single/);
  await expect(d.locator('.mcpGroup--single')).toHaveCount(1);
  await expect(card.locator('.mcpGroup__toggle, .mcpGroup__count')).toHaveCount(0);
  await expect(d.locator('.mcpGroup__toggle')).toHaveCount(8);
  await expect(card.locator('.uiCheck__note')).toHaveText('Every key has it');
  await expect(card.locator('.mcpGroup__reason')).toBeHidden();
  // The tool is not sent. The key is made with its data tools alone.
  await fillValid(d);
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  const post = server.calls.find((call) => call.method === 'POST' && call.path === '/keys');
  expect(post.body.tools).toEqual(DATA_TOOLS);
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
  // Only the name is missing. The host is chosen, and the data is * by default. The button is off, and its title says so.
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', 'Enter a name.');
  await d.locator('#mcpField-name').fill('Bad Name');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /lower-case letters/);
  await d.locator('#mcpField-name').fill('good-name');
  // The first host whose MCP user connects is chosen already. The data is *, so the key is valid.
  await expect(create).toBeEnabled();
  await expect(create).toHaveAttribute('title', '');
  // Without a pattern, the data is missing.
  await d.locator('#mcpField-databases').fill('');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /Enter at least one data pattern/);
  await d.locator('#mcpField-databases').fill('otel');
  await expect(create).toBeEnabled();
  // Clear every permission. Each box of a family turns off. Then tick each box again.
  await openGroup(d, 'data');
  await d.locator('#mcpTool-query_table').uncheck();
  await expect(create).toBeEnabled();  // the other data tools are still on
  await d.locator('#mcpGroup-data').check();  // half ticked: the box sets them all, then none
  await d.locator('#mcpGroup-data').uncheck();
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /at least one permission/);
  await d.locator('#mcpGroup-data').check();
  await expect(create).toBeEnabled();
  await d.locator('#mcpField-max_rows').fill('0');
  await expect(create).toBeDisabled();
  await expect(create).toHaveAttribute('title', /whole number/);
  await d.locator('#mcpField-max_rows').fill('');
  await expect(create).toBeEnabled();
  // Press Enter in the name field. The form does not send an invalid key.
  await d.locator('#mcpField-name').fill('');
  await d.locator('#mcpField-name').press('Enter');
  expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await expect(d).toBeVisible();
  // A valid key is sent.
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
  // A validation error shows a field and a reason.
  server.errors['POST /keys'] = { status: 400, body: { error_code: 'validation', message: 'The pattern "otel" names no database.', field: 'databases', reason: 'invalid' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-databases')).toHaveText('The pattern "otel" names no database.');
  await expect(d.locator('#mcpField-databases')).toHaveAttribute('aria-invalid', 'true');
  await expect(d.locator('#mcpField-databases')).toBeFocused();
  await expect(d).toBeVisible();
  // A reason without a sentence, on an indexed field, gets the sentence of the page.
  server.errors['POST /keys'] = { status: 400, body: { error_code: 'validation', field: 'hosts[0]', reason: 'unknown_host' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-hosts')).toContainText('no mcp_uri');
  // A name that is taken (409) shows under the name, before the hint.
  server.errors['POST /keys'] = { status: 409, body: { error_code: 'name_taken', message: 'A key named "analyst" exists.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpFieldError-name')).toContainText('A key named "analyst" exists.');
  await expect(d.locator('#mcpField-name')).toBeFocused();
  await expect(d.locator('#mcpField-name')).toHaveAttribute('aria-describedby', 'mcpFieldError-name mcpFieldHint-name');
  // An error with no field shows at the foot of the dialog.
  server.errors['POST /keys'] = { status: 500, body: { error_code: 'storage_error', message: 'The storage file could not be written.' } };
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.uiDialog__error')).toContainText('The storage file could not be written.');
  await expect(d).toBeVisible();
  // The next try works. The old errors are gone.
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
});

test('a key is made or deleted: nothing on the page changes it, and no request does', async ({ page }) => {
  const server = await open(page);
  // The names of the actions that no longer exist are not shown. They are not in the table and not in the details.
  for (const label of ['Edit', 'Disable', 'Enable', 'Rotate', 'Rotate secret']) await expect(page.getByRole('button', { name: label })).toHaveCount(0);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  for (const label of ['Edit', 'Disable', 'Enable', 'Rotate', 'Rotate secret']) await expect(details(page).getByRole('button', { name: label })).toHaveCount(0);
  // The details only show data. A button checks the grants again.
  // The details also show the list of the instances that the usage sums (two here), the windows of the usage, and the cost that opens.
  await expect(details(page).getByRole('button')).toHaveText(['Check again', 'Summed over 2 instances', '1 h', '6 h', '24 h', '7 d', '30 d', '90 d', 'ClickHouse cost']);
  expect(server.calls.filter((call) => ['PATCH', 'PUT'].includes(call.method) || call.path.endsWith('/rotate'))).toHaveLength(0);
});

test('delete asks first and removes the key', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  const d = dialog(page);
  await expect(d.locator('.uiDialog__title')).toHaveText('Delete key ci-bot?');
  await expect(d).toContainText('This cannot be undone');
  await expect(d).toContainText('This key reads prod.');
  // The focus starts on Cancel. Cancel keeps the key.
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
  server.errors['DELETE /keys/ui_0a1b2c3d4e5f'] = { status: 500, body: { error_code: 'storage_error', message: 'The storage file could not be written.' } };
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(page.locator('#mcpAlert')).toContainText('The storage file could not be written.');
  await expect(row(page, 'ci-bot')).toHaveCount(1);
  // Another user deleted a key in the meantime.
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
  // Tab moves through the form in reading order: name, then the hosts.
  await page.keyboard.press('Tab');
  await expect(dialog(page).locator('#mcpHost-0')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog(page).locator('#mcpHost-0')).toBeChecked();
  // Every field has a label. Every group has a legend.
  const unnamed = await dialog(page).evaluate((root) => [...root.querySelectorAll('input, textarea, select')]
    .filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label')).map((el) => el.id));
  expect(unnamed).toEqual([]);
  await expect(dialog(page).locator('fieldset > legend')).toHaveCount(2);
  // The arrow of a family is a button. The button says what it opens and whether it is open.
  const arrow = dialog(page).locator('[aria-controls="mcpGroupBody-data"]');
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

test('the keys table loses Tools, Data, Limits and Used from 820 px down, and the box does not scroll; a phone keeps every field in its card (UI-130)', async ({ page }) => {
  await open(page);
  const state = () => page.evaluate(() => {
    const wrap = document.querySelector('.mcpTableWrap');
    const table = wrap.querySelector('table');
    return {
      over: wrap.scrollWidth - wrap.clientWidth,
      heads: [...table.querySelectorAll('thead th')].filter((th) => th.offsetParent !== null).map((th) => th.textContent.trim()),
      cells: [...table.querySelectorAll('tbody tr[data-key-id]:first-child td')].filter((td) => td.offsetParent !== null).map((td) => td.dataset.label),
    };
  });
  await page.setViewportSize({ width: 1100, height: 900 });
  expect((await state()).heads).toEqual(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Used', 'Actions']);
  await page.setViewportSize({ width: 820, height: 900 });
  let now = await state();
  expect(now.heads).toEqual(['Name', 'Secret', 'Host', 'Actions']);
  expect(now.cells).toEqual(['Name', 'Secret', 'Host', 'Actions']);
  expect(now.over).toBeLessThanOrEqual(1);
  // The details of a key show the fields that the row does not hold. They appear under the row, inside the box.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  await expect(details(page).first()).toContainText('Timeout');
  expect((await state()).over).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 640, height: 900 });
  expect((await state()).over).toBeLessThanOrEqual(1);
  // A phone draws each key as a card, with every field.
  await page.setViewportSize({ width: 390, height: 800 });
  now = await state();
  expect(now.cells).toEqual(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Used', 'Actions']);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
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
  // The filter is in the heading, before Refresh and New key.
  const at = await page.evaluate(() => ({ filter: document.querySelector('#mcpKeysFilter').getBoundingClientRect().right, refresh: document.querySelector('#mcpRefresh').getBoundingClientRect().left }));
  expect(at.refresh).toBeGreaterThan(at.filter);
  // A short list has no filter.
  const small = newServer();
  await open(page, small);
  await expect(page.locator('#mcpKeysFilter')).toHaveCount(0);
});

test('the panel keeps the room of its scrollbar: opening the details of a key does not move the table', async ({ page }) => {
  await open(page);
  const panel = page.locator('#mcpPanel');
  expect(await panel.evaluate((el) => getComputedStyle(el).scrollbarGutter)).toContain('stable');
  const width = () => page.locator('#mcpKeysBody table').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
  const before = await width();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  expect(await width()).toBe(before);
});

test('a click on a key opens its details under it, one key at a time: source, hosts, data, limits and the permissions by family', async ({ page }) => {
  await open(page);
  // The name is a button. A click on the row, outside its buttons, does the same.
  const open1 = row(page, 'ci-bot').locator('[data-action="open"]');
  await expect(open1).toHaveAttribute('aria-expanded', 'false');
  await expect(details(page)).toHaveCount(0);
  // A chevron at the left of the name shows that the key unfolds. It points right when the key is folded, and down when the key is open.
  const chevron = open1.locator('svg.mcpKeyChevron');
  await expect(chevron).toBeVisible();
  const turn = () => chevron.evaluate((el) => getComputedStyle(el).transform);
  expect(await turn()).toBe('none');
  await open1.click();
  await expect.poll(turn).not.toBe('none');
  // There is no popup. The details are a row of the table, right under the key.
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
  // Every family of the server is listed, with what the key holds in it. The tools that the key holds are named.
  // The key lists 2 tools and holds 4. The two tools that every key has count as well. They are the analysis of its own limits and usage, out of the 25 tools that the server offers.
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('4 of 25');
  // The families are in two balanced columns. In the source of the page, one column comes after the other. Every family appears once.
  expect((await d.locator('.mcpGrantGroup__title').allTextContents()).sort()).toEqual(['Data', 'Explorer', 'MCP analysis', 'Observability - Logs', 'Observability - Metrics', 'Observability - Traces', 'Query', 'SQL', 'System']);
  await expect(d.locator('[data-group="data"] .mcpGrantGroup__count')).toHaveText('2 of 5');
  await expect(d.locator('[data-group="explorer"] .mcpGrantGroup__count')).toHaveText('0 of 2');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('2 of 2');
  await expect(d.locator('.mcpGrant .mcpGrant__name')).toHaveText(['list_databases', 'query_table', 'mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  await expect(d.locator('.mcpGrant[data-tool="query_table"]')).toContainText('Rows of one table');
  // A tool that every key has says so. The other tools say what they do.
  await expect(d.locator('.mcpGrant[data-tool="mcp_analysis_my_limits"] .mcpGrant__note')).toHaveText('every key has it');
  await expect(d.locator('.mcpGrantGroup.is-empty')).toHaveCount(7);
  // The details span the width of the table. The reader needs no scroll of the page to read them.
  const wide = await d.evaluate((el) => ({ cell: el.querySelector('td').getBoundingClientRect().width, table: el.closest('table').getBoundingClientRect().width }));
  expect(wide.cell).toBeGreaterThan(wide.table - 4);
  await screenshot(page, 'details');
  // Only one key is open at a time. Another key closes this one.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(1);
  await expect(page.locator('tr[data-key-id="ui_111111111111"] + tr.mcpDetailRow')).toHaveCount(1);
  await expect(open1).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'reporting').locator('[data-action="open"]')).toHaveAttribute('aria-expanded', 'true');
  // Click the same key again to close it. The focus stays on the name of the key.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(0);
  await expect(row(page, 'reporting').locator('[data-action="open"]')).toBeFocused();
  // A click on a cell of the row opens the key, but not on a button. A click on Delete does not open the key.
  await row(page, 'reporting').locator('td').nth(2).click();
  await expect(details(page)).toHaveCount(1);
  await row(page, 'reporting').locator('td').nth(2).click();
  await expect(details(page)).toHaveCount(0);
  await row(page, 'reporting').locator('[data-action="remove"]').click();
  await expect(details(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The open key stays open when the list is drawn again.
  await open1.click();
  await page.locator('#mcpRefresh').click();
  await expect(details(page)).toHaveCount(1);
  await expect(page.locator('tr[data-key-id="ui_0a1b2c3d4e5f"] + tr.mcpDetailRow')).toHaveCount(1);
  // When the key is deleted, its details are removed too.
  await row(page, 'ci-bot').locator('[data-action="remove"]').click();
  await dialog(page).getByRole('button', { name: 'Delete key' }).click();
  await expect(row(page, 'ci-bot')).toHaveCount(0);
  await expect(details(page)).toHaveCount(0);
});

test('the details of a key with every tool name the tools it holds, the ones that need all the data only with it', async ({ page }) => {
  const server = newServer();
  server.keys.push(key({ id: 'ui_444444444444', name: 'star-narrow', tools: ['*'], databases: ['otel'] }));
  await open(page, server);
  // ops-all has tools ["*"] and data "*", so it holds all of them.
  // A key with "*" and narrower data holds the tools that do not need all the data.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  let d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('25 of 25');
  await expect(d.locator('.mcpGrantGroup.is-empty')).toHaveCount(0);
  await expect(d.locator('.mcpAbout')).toContainText('The config file');
  await expect(d.locator('.mcpAbout')).toContainText('200');
  await expect(d.locator('.mcpAbout')).toContainText('10 s');
  await row(page, 'star-narrow').locator('[data-action="open"]').click();
  d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('23 of 25');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('2 of 2');
  await expect(d.locator('[data-group="sql"] .mcpGrantGroup__count')).toHaveText('0 of 2');
  await expect(d.locator('[data-group="explorer"] .mcpGrantGroup__count')).toHaveText('2 of 2');
  await expect(d.locator('[data-group="observability-traces"] .mcpGrantGroup__count')).toHaveText('5 of 5');
  await expect(d.locator('[data-group="observability-logs"] .mcpGrantGroup__count')).toHaveText('2 of 2');
  await expect(d.locator('[data-group="observability-metrics"] .mcpGrantGroup__count')).toHaveText('3 of 3');
});

test('a key that names mcp_analysis_all_usage holds it: its Tools cell counts it, "*" does not give it, and its details list it', async ({ page }) => {
  const server = setUsage(newServer(), { allKeys: true });  // the server offers 26 tools now: the one of all the keys is one of them
  server.keys.push(key({ id: 'ui_aa0000000001', name: 'auditor', tools: ['list_hosts', 'mcp_analysis_all_usage'], databases: ['*'] }));
  server.keys.push(key({ id: 'ui_aa0000000002', name: 'star-and-all', tools: ['*', 'mcp_analysis_all_usage'], databases: ['*'] }));
  await open(page, server);
  const cell = (name) => row(page, name).locator('td').nth(3);
  // The key that names the tool holds the tool, the two tools that every key has, and the one that it named.
  // The title lists them in the order of the catalog.
  await expect(cell('auditor')).toHaveText('4/26');
  await expect(cell('auditor').locator('.mcpMono')).toHaveAttribute('title', 'list_hosts, mcp_analysis_my_limits, mcp_analysis_my_usage, mcp_analysis_all_usage');
  // A key that does not name the tool does not hold it.
  await expect(cell('ci-bot')).toHaveText('4/26');
  await expect(cell('ci-bot').locator('.mcpMono')).toHaveAttribute('title', 'list_databases, query_table, mcp_analysis_my_limits, mcp_analysis_my_usage');
  // "*" does not give this tool. The cell says "All", and its title says what "*" leaves out.
  // When the key names the tool next to "*", the key holds it. Nothing is left out.
  await expect(cell('ops-all')).toHaveText('All');
  await expect(cell('ops-all').locator('.mcpMuted')).toHaveAttribute('title', 'All tools but mcp_analysis_all_usage: a key has it only when its list names it');
  await expect(cell('star-and-all')).toHaveText('All');
  await expect(cell('star-and-all').locator('.mcpMuted')).toHaveAttribute('title', 'All tools');
  // The details show the family card. The card lists the three tools of the key that names one of them.
  // The card also says what each tool does, and says "every key has it" for the two other tools.
  await row(page, 'auditor').locator('[data-action="open"]').click();
  let d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('4 of 26');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('3 of 3');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrant__name')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage', 'mcp_analysis_all_usage']);
  await expect(d.locator('.mcpGrant[data-tool="mcp_analysis_all_usage"] .mcpGrant__note')).toHaveText('What all the keys of all the instances did.');
  await expect(d.locator('.mcpGrant[data-tool="mcp_analysis_my_usage"] .mcpGrant__note')).toHaveText('every key has it');
  // "*" holds the other two tools, but not this one.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('25 of 26');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('2 of 3');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrant__name')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
  await expect(d.locator('.mcpGrant[data-tool="mcp_analysis_all_usage"]')).toHaveCount(0);
  await row(page, 'star-and-all').locator('[data-action="open"]').click();
  d = details(page);
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('26 of 26');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('3 of 3');
});

test('a key with no tool of its own holds the ones that every key has: its Tools cell never says None', async ({ page }) => {
  const server = newServer();
  server.keys.push(key({ id: 'ui_bb0000000001', name: 'bare-key', tools: [], databases: ['otel'] }));
  await open(page, server);
  const cell = row(page, 'bare-key').locator('td').nth(3);
  await expect(cell).toHaveText('2/25');
  await expect(cell.locator('.mcpMono')).toHaveAttribute('title', 'mcp_analysis_my_limits, mcp_analysis_my_usage');
  await row(page, 'bare-key').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpDetails__title .pagePart__count')).toHaveText('2 of 25');
  await expect(details(page).locator('.mcpGrantGroup:not(.is-empty)')).toHaveCount(1);
  await expect(details(page).locator('[data-group="mcp_analysis"] .mcpGrant__name')).toHaveText(['mcp_analysis_my_limits', 'mcp_analysis_my_usage']);
});

test('a key that names a tool that the server does not offer now does not hold it: the cell and the details leave it out', async ({ page }) => {
  // When mcp.usage.all_keys is off, the tool for all the keys is not offered (25 tools).
  // The key that names the tool holds the same tools as any other key.
  const server = newServer();
  server.keys.push(key({ id: 'ui_aa0000000001', name: 'auditor', tools: ['list_hosts', 'mcp_analysis_all_usage'], databases: ['*'] }));
  await open(page, server);
  const cell = row(page, 'auditor').locator('td').nth(3);
  await expect(cell).toHaveText('3/25');
  await expect(cell.locator('.mcpMono')).toHaveAttribute('title', 'list_hosts, mcp_analysis_my_limits, mcp_analysis_my_usage');
  await row(page, 'auditor').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpDetails__title .pagePart__count')).toHaveText('3 of 25');
  await expect(details(page).locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('2 of 2');
  await expect(details(page).locator('.mcpGrant[data-tool="mcp_analysis_all_usage"]')).toHaveCount(0);
  // The usage is off. Not even the tool that reads the usage of the key is offered.
  // "*" has nothing to leave out of the 24 tools that are offered.
  const off = setUsage(newServer(), { enabled: false });
  off.keys.push(key({ id: 'ui_aa0000000002', name: 'usage-reader', tools: ['list_hosts', 'mcp_analysis_my_usage', 'mcp_analysis_all_usage'], databases: ['*'] }));
  await open(page, off);
  await expect(row(page, 'usage-reader').locator('td').nth(3)).toHaveText('2/24');
  await expect(row(page, 'usage-reader').locator('td').nth(3).locator('.mcpMono')).toHaveAttribute('title', 'list_hosts, mcp_analysis_my_limits');
  await row(page, 'usage-reader').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpDetails__title .pagePart__count')).toHaveText('2 of 24');
  await expect(details(page).locator('[data-group="mcp_analysis"] .mcpGrant__name')).toHaveText(['mcp_analysis_my_limits']);
});

test('a page that cannot change keys still shows the details of a key', async ({ page }) => {
  await open(page, newServer({ meta: { manage_from_ui: false, keys_mode: 'static', can_manage: false } }));
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpGrantGroup')).toHaveCount(9);
  await expect(page.locator('#mcpKeysBody [data-action="remove"]')).toHaveCount(0);
});

test('Connect a client: the blocks of code are coloured (JSON, command, values), and copy the plain text', async ({ page }) => {
  await open(page);
  const origin = new URL(page.url()).origin;
  const panel = (name) => page.locator(`#mcpHelpClient-${name} .mcpCode__pre`);
  // The command has colours for the program, the flags, the URL and the quoted header.
  await expect(panel('code')).toHaveText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "Authorization: Bearer <secret>"`);
  await expect(panel('code').locator('.tok-kw')).toHaveText(['claude']);
  await expect(panel('code').locator('.tok-type')).toHaveText(['--transport', '--header']);
  await expect(panel('code').locator('.tok-fn')).toHaveText([`${origin}/mcp`]);
  await expect(panel('code').locator('.tok-str')).toHaveText(['"Authorization: Bearer <secret>"']);
  // In the JSON, the keys and the strings have different colours. The numbers and literals too.
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
  // The off state shows the HCL block, also with colours.
  const off = newServer({ meta: { enabled: false } });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, off);
  await expect(page.locator('#mcpOff .mcpCode__pre .tok-fn').first()).toHaveText('enabled');
  await expect(page.locator('#mcpOff .mcpCode__pre .tok-kw')).toHaveText(['mcp', 'keys', 'clickhouse', 'host']);
});

test('the header of the key comes from the config (mcp.auth_header): the commands name it, Authorization is the default', async ({ page }) => {
  const server = newServer({ meta: { auth_header: 'X-ChDash-Key' } });
  await open(page, server);
  const origin = new URL(page.url()).origin;
  // Another header takes the key alone, without the word Bearer.
  await expect(page.locator('#mcpHelpClient-code .mcpCode__pre')).toHaveText(`claude mcp add --transport http chdash-name ${origin}/mcp --header "X-ChDash-Key: <secret>"`);
  await page.getByRole('button', { name: 'JSON' }).click();
  expect(JSON.parse(await page.locator('#mcpHelpClient-json .mcpCode__pre').innerText())).toEqual({ mcpServers: { 'chdash-name': { type: 'http', url: `${origin}/mcp`, headers: { 'X-ChDash-Key': '<secret>' } } } });
  await page.getByRole('button', { name: 'Desktop' }).click();
  const desktop = JSON.parse(await page.locator('#mcpHelpClient-desktop .mcpCode__pre').innerText());
  expect(desktop.mcpServers['chdash-name']).toEqual({ command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'X-ChDash-Key:${AUTH_HEADER}'], env: { AUTH_HEADER: '<secret>' } });
  await page.getByRole('button', { name: 'Inspector' }).click();
  await expect(page.locator('#mcpHelpClient-inspector .mcpCode__pre')).toContainText('Header name      X-ChDash-Key');
  await expect(page.locator('#mcpConnect')).toContainText('The key in the X-ChDash-Key header');
  // The panel after a create also names the key.
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
  // When families open, or when an error shows under a field, the size does not change.
  for (const id of ['data', 'explorer', 'system', ...SIGNALS, 'query']) await openGroup(d, id);
  await d.locator('#mcpField-name').fill('Bad Name');
  const after = await d.boundingBox();
  expect(Math.round(after.width)).toBe(Math.round(before.width));
  expect(Math.round(after.height)).toBe(Math.round(before.height));
  expect(after.y + after.height).toBeLessThanOrEqual(900);
  // The permissions column scrolls by itself. The dialog does not scroll.
  const scroll = await d.locator('.mcpKeyForm__perms').evaluate((el) => ({ scrolls: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY }));
  expect(scroll).toEqual({ scrolls: true, overflowY: 'auto' });
  expect(await d.locator('.uiDialog__body').evaluate((el) => getComputedStyle(el).overflowY)).toBe('hidden');
  // The foot of the dialog stays in view.
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

test('the multi-line text of the page is justified', async ({ page }) => {
  await open(page);
  expect(await page.locator('#mcpConnect .mcpNote').first().evaluate((el) => getComputedStyle(el).textAlign)).toBe('justify');
  await page.locator('#mcpNewKey').click();
  await openGroup(dialog(page), 'observability-traces');
  expect(await dialog(page).locator('.mcpGroup__tip').first().evaluate((el) => getComputedStyle(el).textAlign)).toBe('justify');
});

test('the details of a key: two columns of about the same height, in the order of the families', async ({ page }) => {
  const server = newServer();
  server.keys.push(key({ id: 'ui_555555555555', name: 'wide-key', tools: ['*'], databases: ['*'] }));
  await open(page, server);
  for (const name of ['ci-bot', 'ops-all', 'wide-key']) {
    await row(page, name).locator('[data-action="open"]').click();
    const cols = await details(page).locator('.mcpGrantCol').evaluateAll((els) => els.map((el) => ({ h: el.getBoundingClientRect().height, groups: [...el.querySelectorAll('.mcpGrantGroup')].map((g) => g.dataset.group) })));
    expect(cols).toHaveLength(2);
    // The two columns have the same height. They differ by less than a fifth.
    expect(Math.abs(cols[0].h - cols[1].h)).toBeLessThan(Math.max(cols[0].h, cols[1].h) * 0.2);
    // Together, the two columns hold every family once.
    // Each column follows the order of the families, and the first family comes first.
    const ORDER = ['data', 'explorer', 'system', ...SIGNALS, 'query', 'sql', 'mcp_analysis'];
    expect([...cols[0].groups, ...cols[1].groups].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y))).toEqual(ORDER);
    for (const col of cols) expect(col.groups).toEqual([...col.groups].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y)));
    expect(cols[0].groups[0]).toBe('data');
    expect(cols[0].groups.length).toBeGreaterThan(0);
    expect(cols[1].groups.length).toBeGreaterThan(0);
  }
  // A narrow column puts the text of a tool under its name.
  const narrow = await details(page).locator('.mcpGrant').first().evaluate((el) => ({ rows: getComputedStyle(el).gridTemplateColumns.split(' ').length, col: el.closest('.mcpGrantCol').getBoundingClientRect().width }));
  expect(narrow.rows).toBe(narrow.col <= 26 * 16 ? 1 : 2);
});

test('the details of a key list the data that it reads: each host, its databases, their tables', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const reach = details(page).locator('.mcpReach');
  await expect(reach.locator('.mcpReachHost')).toHaveCount(1);
  const prod = reach.locator('.mcpReachHost[data-host="prod"]');
  await expect(prod).toContainText('as chdash_mcp');
  await expect(prod).toContainText('4 tables in 2 databases');
  // Why: this shows what the MCP user reads, and what the patterns of the key leave out.
  await expect(prod.locator('.mcpReachHost__why')).toContainText('The ClickHouse grants of the MCP user let it read 12 tables');
  await expect(prod.locator('.mcpReachHost__why')).toContainText('otel, analytics.events');
  await expect(prod.locator('.mcpReachHost__why')).toContainText('leaves out 7');
  // The databases open on their tables. A table read in part shows "some columns".
  // The backend checks the columns only when a tool opens the table.
  const otel = prod.locator('.mcpReachDb[data-database="otel"]');
  await expect(otel.locator('.mcpReachTables')).toBeHidden();
  await otel.locator('summary').click();
  await expect(otel.locator('.mcpReachTable code')).toHaveText(['otel_logs', 'otel_traces', 'otel_metrics_gauge']);
  await expect(otel.locator('.mcpReachTable').nth(2)).toContainText('some columns');
  expect(server.calls.filter((call) => call.path === '/keys/ui_0a1b2c3d4e5f/access')).toHaveLength(1);
  await screenshot(page, 'reach');
  // Check again asks the server to check the grants again.
  await reach.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => server.calls.filter((call) => call.path === '/keys/ui_0a1b2c3d4e5f/access').length).toBe(2);
  // A key with all the data holds all that the MCP user reads.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  const all = details(page).locator('.mcpReach');
  await expect(all.locator('.mcpReachHost__why').first()).toContainText("This key's data is *: all of them.");
  // A key of an older file that names two hosts has an entry for each host.
  // The entry that cannot be checked says why.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  const two = details(page).locator('.mcpReach');
  await expect(two.locator('.mcpReachHost')).toHaveCount(2);
  await expect(two.locator('.mcpReachHost[data-host="staging"]')).toContainText('Not checked: cannot connect as the MCP user');
});

test('the details of a key name its host and mark the tools that the MCP user of that host cannot serve', async ({ page }) => {
  const server = newServer({ keys: [
    key({ id: 'ui_lab', name: 'lab-reader', hosts: ['lab'], tools: ['list_hosts', 'search_traces', 'search_logs', 'traces_search', 'logs_search'], databases: ['*'] }),
    key({ id: 'ui_old', name: 'old-key', hosts: ['prod', 'staging'], tools: ['list_hosts'], databases: ['otel'] }),
    key({ id: 'ui_gone', name: 'gone-host', hosts: ['retired'], tools: ['list_hosts'], databases: ['otel'] }),
    key({ id: 'ui_down', name: 'down-host', hosts: ['staging'], tools: ['list_hosts'], databases: ['otel'] }),
  ] });
  await open(page, server);
  // The table shows the host by its name. Two hosts, or a host that no longer exists, read in the warning colour.
  const cells = (name) => row(page, name).locator('td');
  await expect(cells('lab-reader').nth(2)).toHaveText('lab');
  await expect(cells('lab-reader').nth(2).locator('.mcpWarn')).toHaveCount(0);
  await expect(cells('old-key').nth(2)).toHaveText('2 hosts');
  await expect(cells('gone-host').nth(2).locator('.mcpWarn')).toHaveAttribute('title', /no mcp_uri any more/);
  await expect(cells('down-host').nth(2).locator('.mcpWarn')).toHaveAttribute('title', /the MCP user cannot connect/);
  // lab-reader: the table shows the host and its user, and the tools that are not served because a grant is missing.
  await row(page, 'lab-reader').locator('[data-action="open"]').click();
  const d = details(page);
  await expect(d.locator('.mcpAbout dt').nth(1)).toHaveText('Host');
  await expect(d.locator('.mcpAbout dd').nth(1)).toHaveText('lab as chdash_lab');
  await expect(d.locator('.mcpLostCount')).toHaveText('3 not served');
  const lost = d.locator('.mcpGrant.is-lost');
  await expect(lost).toHaveCount(3);
  await expect(d.locator('.mcpGrant[data-tool="traces_search"]')).toHaveClass(/is-lost/);
  await expect(d.locator('.mcpGrant[data-tool="traces_search"] .mcpGrant__note')).toHaveText('not served: chdash_sys lacks otel.otel_traces');
  await expect(d.locator('.mcpGrant[data-tool="logs_search"] .mcpGrant__note')).toHaveText('not served: chdash_sys lacks otel.otel_logs and more');
  await expect(d.locator('.mcpGrant[data-tool="logs_search"]')).toHaveAttribute('title', /GRANT SELECT ON otel\.otel_logs, system\.parts TO chdash_sys;/);
  await expect(d.locator('.mcpGrant[data-tool="search_traces"]')).not.toHaveClass(/is-lost/);
  await screenshot(page, 'details-not-served');
  // A key of an older file with two hosts says what to do.
  // A host that no longer exists, or whose MCP user is down, says so.
  await row(page, 'old-key').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpHostWarn')).toContainText('A key reads one host now. Make one key for each host.');
  await row(page, 'gone-host').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpHostWarn')).toContainText('no mcp_uri any more');
  await row(page, 'down-host').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpHostWarn')).toContainText('The MCP user chdash_mcp cannot connect.');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('the data of a key that cannot be listed says so and the rest of the details stay', async ({ page }) => {
  const server = newServer();
  server.errors['GET /keys/ui_0a1b2c3d4e5f/access'] = { status: 500, body: { error_code: 'storage_error', message: 'The grants could not be read.' } };
  await open(page, server);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpReach')).toContainText('The data of this key cannot be listed');
  await expect(details(page).locator('.mcpReach')).toContainText('The grants could not be read.');
  await expect(details(page).locator('.mcpGrantGroup')).toHaveCount(9);
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
    // Under 820 px, the columns Tools, Data and Limits leave the table (UI-130).
    // The columns that stay, with the whole secret in its column, fit the box.
    expect(m.wrapScrolls).toBe(false);
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
    await expect(first.locator('td').nth(2)).toHaveAttribute('data-label', 'Host');
    expect(await first.locator('td').nth(2).evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"Host"');
    // The table keeps its semantics, even as cards.
    await expect(page.locator('#mcpKeysBody [role="table"]')).toHaveCount(1);
    await expect(first).toHaveAttribute('role', 'row');
    const remove = first.locator('[data-action="remove"]');
    await expect(remove).toHaveCount(1);
    const box = await remove.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(24);
    await expect(remove).toContainText('Delete');
    // The secret shows its hint and dots on its own line, inside the card.
    const secretText = await first.locator('.mcpSecret__text').boundingBox();
    expect(secretText.x + secretText.width).toBeLessThanOrEqual(390);
    // New key is in the heading and fits.
    const create = await page.locator('#mcpNewKey').boundingBox();
    expect(create.x + create.width).toBeLessThanOrEqual(390);
    await page.locator('#mcpConnect').scrollIntoViewIfNeeded();
    await expect(page.locator('#mcpConnect')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await screenshot(page, 'keys-phone');
    // The form is a bottom sheet that fits the screen.
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
    const server = newServer({ meta: { manage_from_ui: false, keys_mode: 'static', can_manage: false } });
    await open(page, server);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    server.meta = { enabled: false };
    await page.reload();
    await expect(page.locator('.mcpOff')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await screenshot(page, 'off-phone');
  });

  test('390 px: the warning about an instance, the note of the usage of a key and its open list stay inside the page', async ({ page }) => {
    const server = newServer();
    server.instances[1] = { instance: 'chdash-1', status: 'skipped', reason: 'invalid', written_at: null };
    await open(page, server);
    // Under the keys, the note and the warning are as wide as the page, at most.
    const warning = page.locator('.mcpUsedNote + .mcpUsedWarn .mcpInstances__warn');
    await expect(warning).toBeVisible();
    const box = await warning.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390.5);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    // The usage of a key: the head wraps. No dot comes before "Summed over 2 instances" where that text starts a line. The warning is above the tiles.
    await row(page, 'ci-bot').locator('[data-action="open"]').click();
    const usage = details(page).locator('.mcpUsage');
    await expect(usage.locator('.statTile')).toHaveCount(6);
    await expect(usage.locator('.mcpInstances__sep')).toBeHidden();
    await expect(usage.locator('.mcpUsage__warnings .mcpInstances__warn')).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const note = usage.locator('.mcpInstances__button');
    const noteBox = await note.boundingBox();
    expect(noteBox.x).toBeGreaterThanOrEqual(0);
    expect(noteBox.x + noteBox.width).toBeLessThanOrEqual(390.5);
    // The list is a popover as wide as the page allows. It has a column for each instance: the name, then when the instance wrote.
    await note.click();
    const popover = page.locator('.mcpInstancesPopover');
    await expect(popover).toBeVisible();
    const list = await popover.boundingBox();
    expect(list.x).toBeGreaterThanOrEqual(0);
    expect(list.x + list.width).toBeLessThanOrEqual(390.5);
    expect(await popover.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const row0 = await popover.locator('.mcpInstancesList__row').first().evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    expect(row0).toBe(1);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  });
});

// ---- Requests that end, and answers that do not race (ARCH-F-183, 187, 188, 189, 191) ----

// The URL of every fetch whose signal aborted is listed in window.__aborted.
async function trackAborts(page) {
  await page.addInitScript(() => {
    window.__aborted = [];
    const original = window.fetch;
    window.fetch = function tracked(input, init) {
      const url = String((input && input.url) || input);
      if (init && init.signal) init.signal.addEventListener('abort', () => window.__aborted.push(url));
      return original.apply(this, arguments);
    };
  });
}

test('the key form cannot be dismissed while the key is made: Escape, the cross and the backdrop wait for the answer', async ({ page }) => {
  const server = await open(page);
  server.delay['POST /keys'] = 1200;
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  await d.getByRole('button', { name: 'Create key' }).click();
  // The request is on its way. Nothing closes the form.
  // If the form closed, the answer would be dropped, and the key would exist but not show.
  await page.keyboard.press('Escape');
  await d.locator('.uiDialog__close').click({ force: true });
  await page.mouse.click(2, 2);
  await expect(d.locator('.uiDialog__title')).toHaveText('New key');
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created', { timeout: 10_000 });
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(row(page, 'analyst')).toHaveCount(1);
});

test('the secret shows as soon as the key is made, before the list is read again', async ({ page }) => {
  const server = await open(page);
  // The list takes 4 s to come back. The secret panel does not wait for the list.
  server.delay['GET /keys'] = 4000;
  await page.locator('#mcpNewKey').click();
  const d = dialog(page);
  await fillValid(d);
  await d.getByRole('button', { name: 'Create key' }).click();
  await expect(d.locator('.uiDialog__title')).toHaveText('Key created', { timeout: 2500 });
  await expect(d.locator('#mcpSecret')).toHaveValue(SECRET);
  await d.getByRole('button', { name: 'Done' }).click();
  await expect(row(page, 'analyst')).toHaveCount(1, { timeout: 10_000 });
});

test('a server that says on for the meta and off for the keys is asked once more, then the page says so (no loop of requests)', async ({ page }) => {
  const server = newServer();
  server.errors['GET /keys'] = { status: 404, body: { error_code: 'mcp_disabled', message: 'MCP is turned off.' }, keep: true };
  await open(page, server);
  await expect(page.locator('#mcpKeysBody')).toContainText('Could not load the keys', { timeout: 10_000 });
  await page.waitForTimeout(1000);
  expect(server.calls.filter((call) => call.method === 'GET' && call.path === '/keys')).toHaveLength(2);
});

test('"Data it reads" is read once for a key within a minute, "Check again" reads anew, and closing the details aborts a read in flight', async ({ page }) => {
  await trackAborts(page);
  const server = await open(page);
  const accessCalls = (id) => server.calls.filter((call) => call.path === `/keys/${id}/access`);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpReachHost')).toBeVisible();
  expect(accessCalls('ui_0a1b2c3d4e5f')).toHaveLength(1);
  // When the details are closed and opened again, the page shows what it read. The page asks for nothing.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(0);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpReachHost')).toBeVisible();
  expect(accessCalls('ui_0a1b2c3d4e5f')).toHaveLength(1);
  await details(page).getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => accessCalls('ui_0a1b2c3d4e5f').length).toBe(2);
  // A key whose read is slow: when its details close, the read is aborted.
  server.delay['GET /keys/ui_222222222222/access'] = 3000;
  await row(page, 'second-ui-key').locator('[data-action="open"]').click();
  await expect.poll(() => accessCalls('ui_222222222222').length).toBe(1);
  await row(page, 'second-ui-key').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__aborted.filter((url) => url.includes('/keys/ui_222222222222/access')).length)).toBe(1);
});

test('a page restored from the back/forward cache reads the keys again', async ({ page }) => {
  const server = await open(page);
  const before = server.calls.filter((call) => call.method === 'GET' && call.path === '/keys').length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => server.calls.filter((call) => call.method === 'GET' && call.path === '/keys').length).toBeGreaterThan(before);
});

// ---- The usage of the keys ----

const used = (page, name) => row(page, name).locator('.mcpUsedCell');
const callsTo = (server, path) => server.calls.filter((call) => call.path === path).map((call) => call.query);

test('the column Used: the last use and the tool calls of the last 7 days, read once for all the keys after the table', async ({ page }) => {
  const server = newServer();
  server.delay['GET /usage'] = 400;
  await open(page, server);
  // An ellipsis shows while the one request of the page runs. Then the answer appears in every cell.
  await expect(used(page, 'ci-bot')).toHaveText('…');
  await expect(used(page, 'ci-bot')).toHaveText('1 d ago · 12');
  expect(callsTo(server, '/usage')).toEqual(['?window=7d']);
  await expect(used(page, 'ops-all')).toHaveText('2 min ago · 1.2K');
  await expect(used(page, 'legacy')).toHaveText('3 h ago · 25');
  await expect(used(page, 'second-ui-key')).toHaveText('10 d ago · 0');
  // The count began before the keys were made (usage.since is Oct 1).
  // A key without a use was never used. Its title says since when the count began.
  await expect(used(page, 'reporting')).toHaveText('Never');
  await expect(used(page, 'reporting')).toHaveAttribute('title', /^Never used\. Counted since Oct 1 08:00\.\n0 tool calls in 0 requests in the last 7 days\.$/);
  // Muted text means no call in the window. The warning colour marks errors (3 of 12) or refusals of the rate limit.
  await expect(used(page, 'reporting')).toHaveClass(/mcpMuted/);
  await expect(used(page, 'second-ui-key')).toHaveClass(/mcpMuted/);
  await expect(used(page, 'ci-bot')).toHaveClass(/mcpWarn/);
  await expect(used(page, 'legacy')).toHaveClass(/mcpWarn/);
  await expect(used(page, 'ops-all')).not.toHaveClass(/mcpWarn|mcpMuted/);
  await expect(used(page, 'ci-bot')).toHaveAttribute('title', /^Last used .*\n12 tool calls in 20 requests in the last 7 days\.\n3 errors\.$/);
  await expect(used(page, 'legacy')).toHaveAttribute('title', /2 refused by the rate limit\./);
  await expect(page.locator('#mcpKeysBody th.mcpCell--used')).toHaveAttribute('title', 'When the key was last used, and its tool calls in the last 7 days');
  // The note says what the column counts.
  // The fake has two instances that share the usage directory, so the note says over how many instances the figures are summed.
  // The window starts after the count began. So there is no "Counted since" text.
  await expect(page.locator('.mcpUsedNote')).toHaveText('Used: when each key was last used, and its tool calls in the last 7 days. Summed over 2 instances.');
  // A key that is open stays open when the counts arrive. Refresh reads them again.
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  await page.locator('#mcpRefresh').click();
  await expect.poll(() => callsTo(server, '/usage').length).toBe(2);
  await expect(details(page)).toHaveCount(1);
  await expect(used(page, 'ops-all')).toHaveText('2 min ago · 1.2K');
});

test('the column Used says when it cannot read the usage, and since when it counts when the counting began after the window starts', async ({ page }) => {
  const failing = newServer();
  failing.errors['GET /usage'] = { status: 503, body: { error_code: 'server_busy', message: 'Too many heavy requests.', retryable: true } };
  await open(page, failing);
  await expect(used(page, 'ci-bot')).toHaveText('—');
  await expect(used(page, 'ci-bot')).toHaveAttribute('title', /Too many heavy requests/);
  await expect(page.locator('.mcpUsedNote')).toBeHidden();
  // Nothing remains of an answer that was not read.
  // The page shows no warning about the instances and no line of other keys.
  await expect(page.locator('.mcpUsedWarn')).toBeHidden();
  await expect(page.locator('.mcpDeleted')).toBeHidden();

  // The usage is counted in files that survive a restart. So the page shows since when it counts (usage.since), and says nothing about a restart.
  // The window of 7 days starts before the count here. The note says so ("Counted since").
  // A key that is older than the count may have been used before it began. The page shows a dash, not "Never". A key made after the count began was never used.
  const late = newServer();
  late.meta.usage = { ...late.meta.usage, since: '2026-10-14T08:00:00Z' };
  late.keys.push(key({ id: 'ui_young0000000', name: 'young-key', created_at: '2026-10-14T09:00:00Z' }));
  late.keys.push(key({ id: 'quiet-config', name: 'quiet-config', source: 'config', secret_hint: '', created_at: null }));
  await open(page, late);
  await expect(page.locator('.mcpUsedNote')).toHaveText('Used: when each key was last used, and its tool calls in the last 7 days. Counted since Oct 14 08:00. Summed over 2 instances.');
  await expect(page.locator('.mcpUsedNote')).not.toContainText(/memory|restart/);
  await expect(used(page, 'reporting')).toHaveText('\u2014');
  await expect(used(page, 'reporting')).toHaveAttribute('title', /^Not used since Oct 14 08:00, when the counting began\. The key is older: it may have been used before\.\n0 tool calls in 0 requests in the last 7 days\.$/);
  await expect(used(page, 'young-key')).toHaveText('Never');
  await expect(used(page, 'young-key')).toHaveAttribute('title', /^Never used\. Counted since Oct 14 08:00\.\n0 tool calls in 0 requests in the last 7 days\.$/);
  // A key of the config file has no date of creation (null). Only its use tells the page about it.
  // Without a use, the key was never used. It was not used before the count.
  await expect(used(page, 'quiet-config')).toHaveText('Never');
  // A key that was used shows its use, whenever the count began.
  await expect(used(page, 'ci-bot')).toHaveText('1 d ago \u00b7 12');
  // The usage of a key says it too. The dates of its window start where the count started.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(usage.locator('.mcpNote--fine').first()).toHaveText('Counted since Oct 14 08:00.');
  await expect(usage.locator('.mcpUsage__range')).toHaveText('Oct 14 08:00 \u2192 10:00');
  await expect(usage).not.toContainText(/memory|restart/);
});

// ---- The usage is off (mcp.usage.enabled is false). Nothing is counted, so the page shows nothing of it ----

test('usage off: no column Used, no note, no line of other keys, and no request for the usage; the data of the keys still counts', async ({ page }) => {
  const server = setUsage(newServer(), { enabled: false });
  await open(page, server);
  // The table has every column except Used. It has nothing that the usage writes.
  // The table has no cell, no note under the table, no warning about the instances, and no line of the keys that keep usage. The fake has a deleted key that would otherwise be listed.
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('th.mcpCell--used, td.mcpCell--used, .mcpUsedCell, .mcpUsedNote, .mcpUsedWarn, .mcpDeleted')).toHaveCount(0);
  // The data of the keys is counted by /access. This count does not depend on the usage.
  await expect(row(page, 'ci-bot').locator('.mcpDataCell')).toHaveText('2 dbs \u00b7 4 tables');
  await expect(row(page, 'ops-all').locator('.mcpDataCell')).toHaveText('2 dbs \u00b7 4 tables');
  expect(callsTo(server, '/access')).toHaveLength(1);
  // While the usage is off, this server offers 24 tools, out of the 26 tools of the fake. The two tools of the usage are not among them.
  // A key that lists 2 tools holds 3 tools, because it holds the one tool that every key has. The title does not name the tools that are not offered.
  await expect(row(page, 'ci-bot').locator('td').nth(3)).toHaveText('3/24');
  await expect(row(page, 'ci-bot').locator('td').nth(3).locator('.mcpMono')).toHaveAttribute('title', 'list_databases, query_table, mcp_analysis_my_limits');
  await expect(row(page, 'ops-all').locator('td').nth(3).locator('.mcpMuted')).toHaveAttribute('title', 'All tools');
  // Refresh asks for the keys and the meta again. It does not ask for the usage.
  await page.locator('#mcpRefresh').click();
  await expect.poll(() => callsTo(server, '/access').length).toBe(2);
  await expect(rows(page)).toHaveCount(5);
  expect(server.calls.filter((call) => call.path.includes('usage'))).toEqual([]);
  // A phone draws the card of a key without the field Used, too.
  await page.setViewportSize({ width: 390, height: 800 });
  const fields = await page.evaluate(() => [...document.querySelectorAll('#mcpKeysBody tbody tr[data-key-id]:first-child td')].filter((td) => td.offsetParent !== null).map((td) => td.dataset.label));
  expect(fields).toEqual(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Actions']);
});

test('usage off: the details of a key have no usage and no link to the Usage tab, and the ClickHouse cost has the buttons of its own window', async ({ page }) => {
  const server = setUsage(newServer(), { enabled: false });
  await open(page, server);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const d = details(page);
  // The rest of the details stays on the page: the grants, the data, and the 3 tools that this key holds, out of the 24 offered.
  await expect(d.locator('.mcpReach .mcpReachHost')).toBeVisible();
  await expect(d.locator('.mcpDetails__title .pagePart__count')).toHaveText('3 of 24');
  await expect(d.locator('[data-group="mcp_analysis"] .mcpGrantGroup__count')).toHaveText('1 of 1');
  await expect(d.locator('.mcpUsage, .mcpInstances')).toHaveCount(0);
  await expect(d.getByRole('link', { name: 'Open in Usage' })).toHaveCount(0);
  await expect(d.getByRole('button')).toHaveText(['Check again', 'ClickHouse cost']);
  // The cost is the one section after the data. Its window buttons are its own.
  // While the section is closed, the buttons are not there, and nothing is read yet.
  const cost = d.locator('.mcpCost');
  const toggle = cost.getByRole('button', { name: 'ClickHouse cost' });
  const windows = cost.locator('.mcpCost__windows');
  await expect(cost).toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(windows).toHaveCount(1);
  await expect(windows).toBeHidden();
  expect(server.calls.filter((call) => call.path.endsWith('/cost'))).toHaveLength(0);
  // When opened, the section reads the cost in the largest window (7 d).
  // The usage that would hold the choice is not there, so the section shows its buttons.
  await toggle.click();
  await expect(windows).toBeVisible();
  await expect(cost.getByRole('group', { name: 'Window of the cost' })).toBeVisible();
  await expect(windows.getByRole('button')).toHaveText(['1 h', '6 h', '24 h', '7 d']);
  await expect(windows.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(cost.locator('.statTile')).toHaveCount(6);
  await expect(cost.locator('.statTile').first()).toContainText('12');
  await expect(cost).toContainText('otel.otel_logs');
  expect(callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d']);
  // A button reads the cost in its window. Check again reads system.query_log anew, in the same window.
  await windows.getByRole('button', { name: '24 h' }).click();
  await expect(windows.getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'true');
  await expect(windows.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'false');
  await expect(cost.locator('.mcpCost__range')).toHaveText('Oct 13 10:01 \u2192 Oct 14 10:01');
  await cost.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d', '?window=24h', '?window=24h&refresh=1']);
  // When closed, the cost section removes its buttons. The window that was picked is kept for the next key.
  await toggle.click();
  await expect(windows).toBeHidden();
  await row(page, 'reporting').locator('[data-action="open"]').click();
  const other = details(page).locator('.mcpCost');
  await other.getByRole('button', { name: 'ClickHouse cost' }).click();
  await expect(other.locator('.mcpCost__windows').getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'true');
  // The runner of the host of this key may not read query_log. The page shows the reason and the GRANT, as with the usage on.
  await expect(other.locator('.mcpCost__reason')).toHaveText('The runner account of the host may not read system.query_log.');
  await expect(other.locator('.mcpCode__pre')).toHaveText('GRANT SELECT ON system.query_log TO chdash_runner');
  // The page sends no request for the usage of a key, or for the usage of all the keys.
  expect(server.calls.filter((call) => call.path.includes('usage'))).toEqual([]);
});

test('the cost that asks for a smaller window says where to pick it: in Usage while the usage is on, in its own buttons while it is off', async ({ page }) => {
  // The runner could not read so many rows. The server suggests 24 hours.
  // The shape of an answer that is not "ok" is the same as for a key that the runner may not read, with another reason.
  const tooLarge = (srv, id, window) => ({
    ...costOf(srv, 'ui_111111111111', window), id, reason: 'window_too_large', suggested_window: '24h', error: 'Too many rows in system.query_log.', statement: '',
  });
  const on = newServer();
  on.cost = tooLarge;
  await open(page, on);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await details(page).locator('.mcpCost').getByRole('button', { name: 'ClickHouse cost' }).click();
  await expect(details(page).locator('.mcpCost__reason')).toHaveText('system.query_log has too many rows in this window for one read.');
  await expect(details(page).locator('.mcpCost__body')).toContainText('Pick the window of 24 hours in Usage: the cost follows it.');

  const off = setUsage(newServer(), { enabled: false });
  off.cost = tooLarge;
  await open(page, off);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await details(page).locator('.mcpCost').getByRole('button', { name: 'ClickHouse cost' }).click();
  await expect(details(page).locator('.mcpCost__reason')).toHaveText('system.query_log has too many rows in this window for one read.');
  await expect(details(page).locator('.mcpCost__body')).toContainText('Pick the window of 24 hours.');
  await expect(details(page).locator('.mcpCost__body')).not.toContainText('in Usage');
});

test('usage turned off after the meta was read (404 not_enabled): the keys are drawn again as with the usage off, and the page asks the usage once', async ({ page }) => {
  const server = newServer();
  server.errors['GET /usage'] = { status: 404, body: { error_code: 'not_enabled', message: 'The usage of the keys is off (mcp.usage.enabled is false).', retryable: false } };
  await open(page, server);
  // The meta said on, so the table was drawn with its column.
  // The answer of the usage draws the table again, without the column. This is a state, not an error.
  await expect(page.locator('#mcpKeysBody thead th')).toHaveText(['Name', 'Secret', 'Host', 'Tools', 'Data', 'Limits', 'Actions']);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.locator('th.mcpCell--used, td.mcpCell--used, .mcpUsedCell, .mcpUsedNote, .mcpUsedWarn, .mcpDeleted')).toHaveCount(0);
  await expect(page.locator('#mcpAlert')).toBeHidden();
  await expect(page.locator('#mcpKeysBody .uiState--error')).toHaveCount(0);
  await expect(row(page, 'ci-bot').locator('.mcpDataCell')).toHaveText('2 dbs \u00b7 4 tables');
  // There is one read, and no other. The table that is drawn again does not ask for the usage.
  expect(callsTo(server, '/usage')).toEqual(['?window=7d']);
  // The details of a key show a usage that is off. They show the ClickHouse cost alone, with the buttons of its window.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpReach .mcpReachHost')).toBeVisible();
  await expect(details(page).locator('.mcpUsage, .mcpInstances')).toHaveCount(0);
  await expect(details(page).locator('.mcpCost .mcpCost__windows')).toHaveCount(1);
  expect(server.calls.filter((call) => call.path.includes('usage') && call.path !== '/usage')).toEqual([]);
});

test('the usage of a key in its details: a window, the tiles, the trend, the tools, the results and the clients', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(usage.locator('.statTile').first()).toContainText('Tool calls');
  await expect(usage.locator('.statTile').first()).toContainText('12');
  await expect(usage.locator('.statTile').nth(1)).toHaveClass(/is-error/);  // 3 errors of 12 calls
  expect(callsTo(server, '/keys/ui_0a1b2c3d4e5f/usage')).toEqual(['?window=7d']);
  await expect(usage.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true');
  await expect(usage.locator('svg.sparkline')).toHaveCount(1);
  // The sparkline has a point for each step of the window: 3 hours for 7 d.
  await expect(usage.locator('svg.sparkline')).toHaveAttribute('aria-label', /^Tool calls by 3 hours in the last 7 days, the errors in red; the most: 12 \(Oct 14 09:00\)$/);
  await expect(usage.locator('.mcpUsage__table').first()).toContainText('query_table');
  await expect(usage).toContainText('table_not_allowed');
  await expect(usage).toContainText('claude-code');
  await expect(usage).toContainText('claude-code/2.1.3 (node)');
  // Another window reads again, by 15 minutes. The choice holds for another key.
  await usage.getByRole('button', { name: '24 h' }).click();
  await expect.poll(() => callsTo(server, '/keys/ui_0a1b2c3d4e5f/usage')).toEqual(['?window=7d', '?window=24h']);
  await expect(usage.locator('svg.sparkline')).toHaveAttribute('aria-label', /^Tool calls by 15 minutes in the last 24 hours, the errors in red; the most: 12 \(Oct 14 10:00\)$/);
  await row(page, 'ops-all').locator('[data-action="open"]').click();
  await expect.poll(() => callsTo(server, '/keys/ops-all/usage')).toEqual(['?window=24h']);
  // If opened again within a minute, the page shows what it read, with no request.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpUsage .statTile')).toHaveCount(6);
  expect(callsTo(server, '/keys/ui_0a1b2c3d4e5f/usage')).toHaveLength(2);
  // A key without a request in the window says so.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpUsage__empty')).toHaveText('No request in the last 24 hours.');
  // A phone keeps the cost in the page.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(details(page).locator('.mcpUsage .statTile')).toHaveCount(6);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // Each window has the step of the server in its sparkline.
  // The steps are the minute, 5 minutes, 15 minutes, 3 hours, 12 hours and the day.
  for (const [name, text] of [['1 h', 'minute in the last hour'], ['6 h', '5 minutes in the last 6 hours'], ['24 h', '15 minutes in the last 24 hours'], ['7 d', '3 hours in the last 7 days'], ['30 d', '12 hours in the last 30 days'], ['90 d', 'day in the last 90 days']]) {
    await usage.getByRole('button', { name }).click();
    await expect(usage.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await expect(usage.locator('svg.sparkline')).toHaveAttribute('aria-label', new RegExp(`^Tool calls by ${text}, the errors in red; the most: 12 \\(`));
  }
  // The peak of a day is shown as a date. The peak of a step shorter than a day is shown as a time of the day.
  await expect(usage.locator('.mcpUsage__peak')).toHaveText('Peak 12 calls, 2026-10-14');
  await usage.getByRole('button', { name: '1 h' }).click();
  await expect(usage.locator('.mcpUsage__peak')).toHaveText('Peak 12 calls, Oct 14 10:00');
});

// ---- The instances that share the usage directory. The usage is their sum. A file that is left out gives a warning ----

// The warnings about the instances come from app_mcp_instances.js (uiState.banner level warn).
// They show under the note of the table, and above the figures of the usage of a key that is open.
const tableWarnings = (page) => page.locator('.mcpUsedNote + .mcpUsedWarn .mcpInstances__warn');
const keyWarnings = (page) => details(page).locator('.mcpUsage .mcpUsage__warnings .mcpInstances__warn');
const NOTE = 'Used: when each key was last used, and its tool calls in the last 7 days.';
// A file of an instance is listed as the usage routes list it. This instance comes first.
const instanceFile = (instance, status = 'ok', reason = '', writtenAt = '2026-10-14T09:59:00Z') => ({ instance, status, reason, written_at: status === 'skipped' ? null : writtenAt });

test('the usage of a key says that it is summed over the instances: the note opens the list (this one first, when each wrote), and Escape closes it and gives the focus back', async ({ page }) => {
  await open(page);
  // All is well. The files are read, so no warning shows under the table or above the figures.
  await expect(page.locator('.mcpUsedNote')).toHaveText(`${NOTE} Summed over 2 instances.`);
  await expect(page.locator('.mcpUsedWarn')).toBeHidden();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(usage.locator('.mcpUsage__warnings')).toHaveCount(0);
  // The head of the usage says it after the dates of the window. A button says what it opens.
  const note = usage.locator('.mcpInstances__button');
  await expect(usage.locator('.mcpInstances')).toBeVisible();
  await expect(note).toHaveText('Summed over 2 instances');
  await expect(note).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(note).toHaveAttribute('aria-expanded', 'false');
  await expect(note).toHaveAttribute('title', 'The usage is summed over 2 instances. Open the list.');
  await expect(page.locator('.mcpInstancesPopover')).toHaveCount(0);
  await note.click();
  const popover = page.locator('.mcpInstancesPopover');
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute('role', 'dialog');
  await expect(popover).toHaveAttribute('aria-label', 'Instances of the usage');
  await expect(note).toHaveAttribute('aria-expanded', 'true');
  await expect(popover).toBeFocused();
  await expect(popover.locator('.mcpInstancesList__lead')).toHaveText('The usage is summed over 2 instances: each one saves the file of its own in the usage directory and reads the files of the others.');
  // This instance comes first, because the meta names it. Then the other instances follow.
  // Each instance says when its file was written, as of the time of the answer (10:00).
  const items = popover.locator('.mcpInstancesList__row');
  await expect(items.locator('code')).toHaveText(['chdash-0', 'chdash-1']);
  await expect(items.nth(0)).toContainText('this instance');
  await expect(items.nth(1)).not.toContainText('this instance');
  await expect(items.nth(0).locator('.mcpInstancesList__meta')).toHaveText('wrote 30 s ago');
  await expect(items.nth(1).locator('.mcpInstancesList__meta')).toHaveText('wrote 1 min ago');
  // Both files are read. There is no badge and no reason.
  await expect(popover.locator('.badge')).toHaveCount(0);
  // Press Escape to close it. The focus goes back to the note, and the details stay open.
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(note).toBeFocused();
  await expect(note).toHaveAttribute('aria-expanded', 'false');
  await expect(details(page)).toHaveCount(1);
  // The note opens the list and closes it again.
  await note.click();
  await expect(popover).toBeVisible();
  await note.click();
  await expect(popover).toHaveCount(0);
  // From the keyboard, press Enter on the note to open the list and move the focus into it.
  // Press Escape to close the list. The focus then returns to the note.
  await note.focus();
  await page.keyboard.press('Enter');
  await expect(popover).toBeVisible();
  await expect(popover).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(note).toBeFocused();
  // The list does not stay after the details that hold its note are closed. When the details close, the list is removed.
  await note.click();
  await expect(popover).toBeVisible();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page)).toHaveCount(0);
  await expect(popover).toHaveCount(0);
});

test('the list of instances has this one first and the others by name, a number in a name sorting by its value', async ({ page }) => {
  const server = newServer();
  // The list shows the instances as the server lists them. Sorted as text, chdash-10 comes before chdash-2, and this instance (chdash-0) is not first.
  server.instances = [instanceFile('chdash-2'), instanceFile('chdash-10'), instanceFile('chdash-0'), instanceFile('chdash-1')];
  await open(page, server);
  await expect(page.locator('.mcpUsedNote')).toHaveText(`${NOTE} Summed over 4 instances.`);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const note = details(page).locator('.mcpUsage .mcpInstances__button');
  await expect(note).toHaveText('Summed over 4 instances');
  await note.click();
  const items = page.locator('.mcpInstancesPopover .mcpInstancesList__row');
  await expect(items.locator('code')).toHaveText(['chdash-0', 'chdash-1', 'chdash-2', 'chdash-10']);
  await expect(page.locator('.mcpInstancesPopover .mcpInstancesList__row', { hasText: 'this instance' })).toHaveCount(1);
  await expect(items.first()).toContainText('this instance');
});

test('with one instance nothing is summed: no note under the table or in the usage of a key, and no list to open', async ({ page }) => {
  const server = oneInstance(newServer());
  await open(page, server);
  await expect(page.locator('.mcpUsedNote')).toHaveText(NOTE);
  await expect(used(page, 'ci-bot')).toHaveText('1 d ago \u00b7 12');
  await expect(page.locator('.mcpUsedWarn')).toBeHidden();
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(usage.locator('.mcpInstances')).toBeHidden();
  await expect(details(page).getByRole('button', { name: /instances/ })).toHaveCount(0);
  await expect(usage.locator('.mcpUsage__warnings')).toHaveCount(0);
  await expect(page.locator('.mcpInstancesPopover')).toHaveCount(0);
});

test('a skipped file is a warning under the note of the table and above the figures of the usage of a key, and the list says why', async ({ page }) => {
  const server = newServer();
  server.instances[1] = { instance: 'chdash-1', status: 'skipped', reason: 'invalid', written_at: null };
  await open(page, server);
  const message = 'chdash-1: its file was skipped (invalid), so its counts are not in these figures.';
  // Under the note of the table, the page still says over how many files the figures are summed.
  await expect(page.locator('.mcpUsedNote')).toHaveText(`${NOTE} Summed over 2 instances.`);
  await expect(tableWarnings(page)).toHaveCount(1);
  await expect(tableWarnings(page)).toHaveText(message);
  await expect(tableWarnings(page)).toHaveClass(/uiBanner--warn/);
  // A warning waits for its turn. It is a status, not an alert, so it does not interrupt.
  await expect(tableWarnings(page)).toHaveAttribute('role', 'status');
  await expect(page.locator('.mcpUsedWarn')).toBeVisible();
  // Above the tiles of the usage of a key, the page uses the same words.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(keyWarnings(page)).toHaveCount(1);
  await expect(keyWarnings(page)).toHaveText(message);
  const above = await keyWarnings(page).boundingBox();
  const tiles = await usage.locator('.mcpUsage__tiles').boundingBox();
  expect(above.y + above.height).toBeLessThanOrEqual(tiles.y);
  // The list names the file that is left out. It shows a badge, the reason in one word, and "no write yet", because the file has no date.
  await usage.locator('.mcpInstances__button').click();
  const skipped = page.locator('.mcpInstancesList__row[data-instance="chdash-1"]');
  await expect(skipped).toHaveAttribute('data-status', 'skipped');
  await expect(skipped.locator('.badge')).toHaveText('skipped');
  await expect(skipped.locator('.badge')).toHaveAttribute('title', message);
  await expect(skipped.locator('.mcpInstancesList__name')).toContainText('invalid');
  await expect(skipped.locator('.mcpInstancesList__meta')).toHaveText('no write yet');
  await expect(page.locator('.mcpInstancesList__row[data-instance="chdash-0"] .badge')).toHaveCount(0);
});

test('several skipped files are one warning that names the first three, and the list has each of them', async ({ page }) => {
  const server = newServer();
  // A rolling upgrade of a cluster can skip dozens of files. The page shows one sentence, not one box for each file.
  server.instances = [instanceFile('chdash-0'), instanceFile('chdash-1', 'skipped', 'invalid'), instanceFile('chdash-2', 'skipped', 'too_large'), instanceFile('chdash-3', 'skipped', 'invalid'),
    instanceFile('chdash-4', 'skipped', 'the file is larger than 8 MiB')];
  await open(page, server);
  const message = '4 instance files were skipped, so their counts are not in these figures: chdash-1 (invalid), chdash-2 (too large), chdash-3 (invalid) and 1 more.';
  await expect(page.locator('.mcpUsedNote')).toHaveText(`${NOTE} Summed over 5 instances.`);
  await expect(tableWarnings(page)).toHaveCount(1);
  await expect(tableWarnings(page)).toHaveText(message);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpUsage .statTile')).toHaveCount(6);
  await expect(keyWarnings(page)).toHaveCount(1);
  await expect(keyWarnings(page)).toHaveText(message);
  // The list has every file. The four files that were left out have a badge.
  // The reason shows as the server sent it. An underscore shows as a space.
  await details(page).locator('.mcpUsage .mcpInstances__button').click();
  const items = page.locator('.mcpInstancesPopover .mcpInstancesList__row');
  await expect(items).toHaveCount(5);
  await expect(items.locator('code')).toHaveText(['chdash-0', 'chdash-1', 'chdash-2', 'chdash-3', 'chdash-4']);
  await expect(page.locator('.mcpInstancesPopover .badge')).toHaveText(['skipped', 'skipped', 'skipped', 'skipped']);
  await expect(items.nth(2).locator('.mcpInstancesList__name')).toContainText('too large');
  await expect(items.nth(4).locator('.mcpInstancesList__name')).toContainText('the file is larger than 8 MiB');
  await expect(items.nth(4).locator('.badge')).toHaveAttribute('title', 'chdash-4: its file was skipped (the file is larger than 8 MiB), so its counts are not in these figures.');
});

test('a name that two ChDash write under is a warning of its own, with its reason behind Why, even when this is the only instance listed', async ({ page }) => {
  const server = oneInstance(newServer());
  const reason = 'another ChDash process writes the file of this instance: give each instance its own mcp.usage.instance';
  server.instances[0] = { instance: 'chdash-0', status: 'conflict', reason, written_at: '2026-10-14T09:59:30Z' };
  await open(page, server);
  const message = 'Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).';
  // There is one instance, so nothing is summed.
  // A conflict is about this instance, so its warning shows anyway.
  await expect(page.locator('.mcpUsedNote')).toHaveText(NOTE);
  await expect(tableWarnings(page)).toHaveCount(1);
  await expect(tableWarnings(page).locator('.uiBanner__text')).toHaveText(message);
  const why = tableWarnings(page).locator('.uiBanner__details');
  await expect(why.locator('summary')).toHaveText('Why');
  await expect(why.locator('.uiBanner__more')).toBeHidden();
  await why.locator('summary').click();
  await expect(why.locator('.uiBanner__more')).toBeVisible();
  await expect(why.locator('.uiBanner__more')).toHaveText(reason);
  // The warning also shows above the figures of the usage of a key. There is still no note.
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(keyWarnings(page)).toHaveCount(1);
  await expect(keyWarnings(page).locator('.uiBanner__text')).toHaveText(message);
  await expect(usage.locator('.mcpInstances')).toBeHidden();
});

test('a conflict and a skipped file are two warnings, the conflict first, and the list marks each file', async ({ page }) => {
  const server = newServer();
  const reason = 'another ChDash process writes the file of this instance: give each instance its own mcp.usage.instance';
  server.instances = [{ instance: 'chdash-0', status: 'conflict', reason, written_at: '2026-10-14T09:59:30Z' }, instanceFile('chdash-1', 'skipped', 'invalid')];
  await open(page, server);
  const conflict = 'Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance).';
  const skipped = 'chdash-1: its file was skipped (invalid), so its counts are not in these figures.';
  await expect(tableWarnings(page)).toHaveCount(2);
  await expect(tableWarnings(page).locator('.uiBanner__text')).toHaveText([conflict, skipped]);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  await expect(details(page).locator('.mcpUsage .statTile')).toHaveCount(6);
  await expect(keyWarnings(page).locator('.uiBanner__text')).toHaveText([conflict, skipped]);
  await details(page).locator('.mcpUsage .mcpInstances__button').click();
  await expect(page.locator('.mcpInstancesList__row[data-instance="chdash-0"] .badge')).toHaveText('conflict');
  await expect(page.locator('.mcpInstancesList__row[data-instance="chdash-1"] .badge')).toHaveText('skipped');
});

test('the ClickHouse cost of a key is read only when it is opened, and says why the runner cannot read query_log', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const cost = details(page).locator('.mcpCost');
  const toggle = cost.getByRole('button', { name: 'ClickHouse cost' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(details(page).locator('.mcpUsage .statTile')).toHaveCount(6);
  expect(server.calls.filter((call) => call.path.endsWith('/cost'))).toHaveLength(0);
  await toggle.click();
  await expect(cost.locator('.statTile')).toHaveCount(6);
  expect(callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d']);
  await expect(cost.locator('.statTile').first()).toContainText('12');
  await expect(cost).toContainText('otel.otel_logs');
  await expect(cost).toContainText('chdash_system');
  await expect(cost).toContainText('system user');
  // Check again reads system.query_log anew. The cost follows the window of the usage.
  await cost.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d', '?window=7d&refresh=1']);
  await details(page).locator('.mcpUsage').getByRole('button', { name: '24 h' }).click();
  await expect.poll(() => callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d', '?window=7d&refresh=1', '?window=24h']);
  // The windows of the cost are 1 h, 6 h, 24 h and 7 d.
  // The cost uses the window of the usage when it can. Otherwise it uses the largest window (7 d), as it was read a minute ago. There is no new read for 30 d and 90 d.
  const usageBox = details(page).locator('.mcpUsage');
  for (const [name, range] of [['1 h', 'Oct 14 09:01 → 10:01'], ['6 h', 'Oct 14 04:01 → 10:01'], ['30 d', 'Oct 7 10:01 → Oct 14 10:01'], ['90 d', 'Oct 7 10:01 → Oct 14 10:01']]) {
    await usageBox.getByRole('button', { name }).click();
    await expect(usageBox.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await expect(details(page).locator('.mcpCost__range'), name).toHaveText(range);
  }
  expect(callsTo(server, '/keys/ui_0a1b2c3d4e5f/cost')).toEqual(['?window=7d', '?window=7d&refresh=1', '?window=24h', '?window=1h', '?window=6h']);
  // A key whose runner may not read query_log shows the reason and the GRANT to give.
  await row(page, 'reporting').locator('[data-action="open"]').click();
  const other = details(page).locator('.mcpCost');
  await other.getByRole('button', { name: 'ClickHouse cost' }).click();
  await expect(other.locator('.mcpCost__reason')).toHaveText('The runner account of the host may not read system.query_log.');
  await expect(other.locator('.mcpCode__pre')).toHaveText('GRANT SELECT ON system.query_log TO chdash_runner');
});

test('the usage of a key leads to the Usage tab, cut by the key, in the window that is picked', async ({ page }) => {
  const server = await open(page);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const usage = details(page).locator('.mcpUsage');
  const link = usage.getByRole('link', { name: 'Open in Usage' });
  await expect(link).toHaveAttribute('href', '/mcp-integration/usage?key=ui_0a1b2c3d4e5f&window=7d');
  await expect(link).toHaveAttribute('title', /Usage tab/);
  // The link follows the window of the usage. The link uses the id of the key, never its name.
  await usage.getByRole('button', { name: '24 h' }).click();
  await expect(link).toHaveAttribute('href', '/mcp-integration/usage?key=ui_0a1b2c3d4e5f&window=24h');
  // It is a link. The Usage tab opens with the key as a filter, in that window.
  await link.click();
  await expect(page).toHaveURL(/\/mcp-integration\/usage\?key=ui_0a1b2c3d4e5f&window=24h$/);
  await expect(page.locator('.mcpOverview__tiles .statTile')).toHaveCount(7);
  await expect(page.locator('.mcpBar__windows [aria-pressed="true"]')).toHaveText('24 h');
  await expect(page.locator('.mcpOverview__chips .chip')).toHaveText('Key=ci-bot');
  await expect(page.locator('#mcpPickerButton-key')).toHaveText('Key · ci-bot');
  // There is one read. It groups by method and ranks the groups for each chart (`orders`). The Usage tab draws six charts, each with the groups that rank first for its own metric.
  // The key is the only filter. It is not the dimension that the charts group by, so the rankings are asked for.
  expect(callsTo(server, '/usage/overview')).toEqual(['?window=24h&group=method&order=requests&orders=errors&orders=refused&orders=calls&orders=bytes&key=ui_0a1b2c3d4e5f']);
});

test('a long name in the tables read ends in an ellipsis in its column, with the whole name in its title', async ({ page }) => {
  const long = 'chdash_ui.weather_observations_of_every_station_in_the_world_since_1900';
  const server = newServer();
  server.cost = (srv, id, window, refresh) => {
    const answer = costOf(srv, id, window, refresh);
    if (answer?.tables?.length) answer.tables[0].name = long;
    return answer;
  };
  await open(page, server);
  await row(page, 'ci-bot').locator('[data-action="open"]').click();
  const cost = details(page).locator('.mcpCost');
  await cost.getByRole('button', { name: 'ClickHouse cost' }).click();
  const read = cost.locator('.mcpUsage__block', { hasText: 'Tables read' });
  const name = read.locator('tbody tr').first().locator('code');
  await expect(name).toHaveText(long);
  await expect(name).toHaveAttribute('title', long);
  // The table is as wide as its box. Nothing scrolls in the box or in the page. The name is cut with an ellipsis.
  const m = await read.evaluate((el) => {
    const wrap = el.querySelector('.dataTableWrap');
    const cell = el.querySelector('tbody tr td');
    return { wrap: wrap.scrollWidth - wrap.clientWidth, cell: cell.scrollWidth - cell.clientWidth, overflow: getComputedStyle(cell).textOverflow };
  });
  expect(m.wrap).toBeLessThanOrEqual(0);
  expect(m.cell).toBeGreaterThan(0);
  expect(m.overflow).toBe('ellipsis');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // The count of statements has its own column.
  await expect(read.locator('tbody tr').first().locator('.shareBar__text')).toHaveText('8');
});

test('a deleted key keeps its usage: a line under the keys opens on it, and its details show what it did and cost', async ({ page }) => {
  const server = await open(page);
  const block = page.locator('.mcpDeleted');
  await expect(block).toBeVisible();
  const toggle = block.locator('.mcpDeletedToggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('Deleted keys');
  await expect(block).toContainText('Their usage stays 90 days.');
  // The table is built when the line opens. Until then, the page has only the table of the keys.
  await expect(page.locator('#mcpKeysBody table')).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const line = block.locator('tbody tr[data-deleted-id="ui_dead00000001"]');
  await expect(line.locator('.mcpKeyName')).toHaveText('old-bot');
  await expect(line.locator('td.mcpCell--used')).toHaveText('2 d ago · 40');
  // Only deleted keys are listed. The column says when each key was deleted. No key is marked as a key of another instance.
  await expect(block.locator('table')).toHaveAttribute('aria-label', 'Deleted keys');
  await expect(block.locator('thead th')).toHaveText(['Name', 'Host', 'Deleted', 'Used']);
  await expect(line).toHaveAttribute('data-state', 'deleted');
  await expect(line.locator('td.mcpCell--deleted')).toHaveText('Oct 12 08:00');
  await expect(block.locator('.badge')).toHaveCount(0);
  await line.locator('[data-action="open"]').click();
  const detail = block.locator('.mcpDetailRow');
  await expect(detail.locator('.mcpUsage .statTile')).toHaveCount(6);
  await expect(detail.getByRole('link', { name: 'Open in Usage' })).toHaveAttribute('href', '/mcp-integration/usage?key=ui_dead00000001&window=7d');
  await expect(detail.locator('.mcpAbout dt')).toHaveText(['Host', 'Deleted']);
  await expect(detail.locator('.mcpAbout')).toContainText('Deleted');
  await expect(detail.locator('.mcpDetails__perms')).toHaveCount(0);
  expect(callsTo(server, '/keys/ui_dead00000001/usage')).toEqual(['?window=7d']);
  // The keys of the table are the live keys. The filter and the count do not see the deleted keys.
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('5');
  await expect(page.locator('#mcpKeysBody tr[data-key-id="ui_dead00000001"]')).toHaveCount(0);
});

test('no deleted key and no key of another instance: there is no line under the keys', async ({ page }) => {
  const server = newServer();
  server.deleted = [];
  await open(page, server);
  await expect(rows(page)).toHaveCount(5);
  await expect(used(page, 'ci-bot')).toHaveText('1 d ago \u00b7 12');
  await expect(page.locator('.mcpDeleted')).toBeHidden();
  await expect(page.locator('.mcpDeleted .mcpDeletedToggle')).toHaveCount(0);
});

test('a key that only another instance knows: a line "Keys of other instances" opens on it, with its badge, its use, and what it did and cost', async ({ page }) => {
  const server = newServer();
  server.deleted = [];  // the line is about the keys of other instances alone
  server.elsewhere = ELSEWHERE();
  await open(page, server);
  const block = page.locator('.mcpDeleted');
  const toggle = block.locator('.mcpDeletedToggle');
  await expect(block).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('Keys of other instances');
  await expect(toggle).not.toContainText('Deleted');
  await expect(toggle.locator('.mcpDeleted__count')).toHaveText('1');
  // Nothing was deleted. The line says why the key is listed, instead of how long its usage stays.
  await expect(block).toContainText('Only another instance knows them: this instance has no key of their name.');
  await expect(block).not.toContainText('Their usage stays');
  await expect(page.locator('#mcpKeysBody table')).toHaveCount(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(block.locator('table')).toHaveAttribute('aria-label', 'Keys of other instances');
  // The column does not say "Deleted" for a key that was not deleted. It says "State", and the state is the badge.
  await expect(block.locator('thead th')).toHaveText(['Name', 'Host', 'State', 'Used']);
  const line = block.locator('tbody tr[data-deleted-id="ui_ee0000000001"]');
  await expect(block.locator('tbody tr')).toHaveCount(1);
  await expect(line).toHaveAttribute('data-state', 'elsewhere');
  await expect(line.locator('.mcpKeyName')).toHaveText('etl-bot');
  await expect(line.locator('td.mcpCell--hosts')).toHaveText('prod');
  await expect(line.locator('td.mcpCell--deleted .badge')).toHaveText('other instance');
  await expect(line.locator('td.mcpCell--deleted .badge')).toHaveAttribute('title', /^Only another instance knows this key: its usage comes from the file of that instance$/);
  await expect(line.locator('[data-action="open"]')).toHaveAttribute('aria-label', 'Usage of etl-bot, a key of another instance');
  // Its use reads like the use of the other keys. The page shows when it was last used, and its tool calls in the last 7 days.
  await expect(line.locator('td.mcpCell--used')).toHaveText('1 h ago \u00b7 12');
  await expect(line.locator('td.mcpCell--used span')).toHaveAttribute('title', /^Last used .*\n12 tool calls in 15 requests in the last 7 days\.$/);
  // Its details are those of a key that is not in the list.
  // The details show where the key comes from, then its usage and its cost. The details show no permissions and no Delete.
  await line.locator('[data-action="open"]').click();
  await expect(line.locator('[data-action="open"]')).toHaveAttribute('aria-expanded', 'true');
  const detail = block.locator('.mcpDetailRow');
  await expect(detail).toHaveCount(1);
  await expect(detail.locator('.mcpAbout dt')).toHaveText(['Host', 'Known to']);
  await expect(detail.locator('.mcpAbout dd')).toHaveText(['prod', 'Another instance only']);
  await expect(detail.locator('.mcpAbout dd').nth(1)).toHaveAttribute('title', /no key of this name/);
  await expect(detail.locator('.mcpDetails__perms')).toHaveCount(0);
  await expect(detail.locator('[data-action="remove"]')).toHaveCount(0);
  const usage = detail.locator('.mcpUsage');
  await expect(usage.locator('.statTile')).toHaveCount(6);
  await expect(usage.locator('.statTile').first()).toContainText('12');
  await expect(usage.getByRole('link', { name: 'Open in Usage' })).toHaveAttribute('href', '/mcp-integration/usage?key=ui_ee0000000001&window=7d');
  expect(callsTo(server, '/keys/ui_ee0000000001/usage')).toEqual(['?window=7d']);
  // The cost is read when the key opens, as for the other keys.
  const cost = detail.locator('.mcpCost');
  expect(callsTo(server, '/keys/ui_ee0000000001/cost')).toEqual([]);
  await cost.getByRole('button', { name: 'ClickHouse cost' }).click();
  await expect(cost.locator('.statTile')).toHaveCount(6);
  expect(callsTo(server, '/keys/ui_ee0000000001/cost')).toEqual(['?window=7d']);
  // It is not a key of the table. The count and the rows are the keys that exist here.
  await expect(page.locator('#mcpKeys .pagePart__count')).toHaveText('5');
  await expect(page.locator('#mcpKeysBody tr[data-key-id="ui_ee0000000001"]')).toHaveCount(0);
  // Click the same key again to close its details.
  await line.locator('[data-action="open"]').click();
  await expect(detail).toHaveCount(0);
});

test('deleted keys and keys of other instances share one line under the keys: it says both, the column is State, and each key says which it is', async ({ page }) => {
  const server = newServer();
  server.elsewhere = ELSEWHERE();  // the fake already has a deleted key (old-bot)
  await open(page, server);
  const block = page.locator('.mcpDeleted');
  const toggle = block.locator('.mcpDeletedToggle');
  await expect(toggle).toContainText('Deleted keys and keys of other instances');
  await expect(toggle.locator('.mcpDeleted__count')).toHaveText('2');
  await expect(block).toContainText('Their usage stays 90 days. A key that only another instance knows is listed too.');
  await toggle.click();
  await expect(block.locator('table')).toHaveAttribute('aria-label', 'Deleted keys and keys of other instances');
  await expect(block.locator('thead th')).toHaveText(['Name', 'Host', 'State', 'Used']);
  await expect(block.locator('tbody tr .mcpKeyName')).toHaveText(['old-bot', 'etl-bot']);
  // A deleted key says that it is deleted, and when. A key of another instance shows the badge, where the time would be.
  const gone = block.locator('tbody tr[data-deleted-id="ui_dead00000001"]');
  const apart = block.locator('tbody tr[data-deleted-id="ui_ee0000000001"]');
  await expect(gone).toHaveAttribute('data-state', 'deleted');
  await expect(gone.locator('td.mcpCell--deleted')).toHaveText('Deleted Oct 12 08:00');
  await expect(gone.locator('.badge')).toHaveCount(0);
  await expect(gone.locator('[data-action="open"]')).toHaveAttribute('aria-label', 'Usage of the deleted key old-bot');
  await expect(apart).toHaveAttribute('data-state', 'elsewhere');
  await expect(apart.locator('td.mcpCell--deleted')).toHaveText('other instance');
  await expect(apart.locator('.badge')).toHaveCount(1);
  await expect(gone.locator('td.mcpCell--used')).toHaveText('2 d ago \u00b7 40');
  await expect(apart.locator('td.mcpCell--used')).toHaveText('1 h ago \u00b7 12');
  // Only one key is open under the line at a time.
  // The details of a deleted key say when it was deleted. The details of another key say where it comes from.
  await gone.locator('[data-action="open"]').click();
  await expect(block.locator('.mcpDetailRow')).toHaveCount(1);
  await expect(block.locator('.mcpDetailRow .mcpAbout dt')).toHaveText(['Host', 'Deleted']);
  await expect(block.locator('.mcpDetailRow .mcpUsage .statTile')).toHaveCount(6);
  await apart.locator('[data-action="open"]').click();
  await expect(block.locator('.mcpDetailRow')).toHaveCount(1);
  await expect(gone.locator('[data-action="open"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(block.locator('.mcpDetailRow .mcpAbout dt')).toHaveText(['Host', 'Known to']);
  await expect(block.locator('.mcpDetailRow .mcpUsage .statTile')).toHaveCount(6);
  expect(callsTo(server, '/keys/ui_dead00000001/usage')).toEqual(['?window=7d']);
  expect(callsTo(server, '/keys/ui_ee0000000001/usage')).toEqual(['?window=7d']);
  // The line stays open when the list is drawn again (Refresh), on the same key.
  await page.locator('#mcpRefresh').click();
  await expect.poll(() => callsTo(server, '/usage').length).toBe(2);
  await expect(block.locator('.mcpDetailRow')).toHaveCount(1);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(block.locator('tbody tr.is-open .mcpKeyName')).toHaveText('etl-bot');
});
