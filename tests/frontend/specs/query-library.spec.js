import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

// Query library: the toolbar book button (between Format and the run settings
// cog) opens it in the shared modal dialog of the profiling (app_ui_dialog.js:
// same shell, size, backdrop and tab style), with two tabs in its head (no
// title), Saved (folders and saved queries) and History, and its prompts
// stacked over it. The list on the left only selects (no context menu, no
// "..." button); every action of the selected item is a button of the preview
// pane on the right: its tools (Edit, Move, Delete...) under the title, its
// actions in the foot, "Load in editor" (Ctrl/Cmd+Enter) last.
// Saved queries, folders and History are per host: the dialog shows the
// selected host's and follows a host switch. Browser mode keeps both in
// localStorage (chdash.queryLibrary.v2 and chdash.queryHistory.v1, every entry
// with its host_id; entries without one are purged). Server mode
// (features.query_library.enabled) goes through /api/query-library?host_id=:
// here a small in-memory server behind page.route, writable or read-only,
// plus one live check when QUERY_LIBRARY_BASE_URL names a real instance.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/query-library`;
const tree = (page) => page.locator('#queryLibraryViewSaved [role=tree]');
const node = (page, name) => tree(page).locator('li[role=treeitem]').filter({ has: page.locator(':scope > .qlRow .qlRow__name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const dialog = (page) => page.locator('dialog.qlDialog[open]');
const libraryState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryLibrary.v2') || 'null'));
const historyState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryHistory.v1') || 'null'));

// Seeds localStorage before the first page script, once per test.
async function seed(page, values) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem('ql.seeded')) return;
    sessionStorage.setItem('ql.seeded', '1');
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }, values);
}

// The compose instance has one host, "local".
const HOST = 'local';
const now = Date.UTC(2026, 9, 1, 12, 0, 0);
const LIBRARY = {
  version: 2,
  revision: 3,
  folders: [
    { id: 'f_ops', host_id: HOST, parent_id: null, name: 'Operations', description: 'Server health', created_at_ms: now, updated_at_ms: now },
    { id: 'f_merges', host_id: HOST, parent_id: 'f_ops', name: 'Merges', description: '', created_at_ms: now, updated_at_ms: now },
    { id: 'f_reports', host_id: HOST, parent_id: null, name: 'Reports', description: '', created_at_ms: now, updated_at_ms: now },
  ],
  queries: [
    { id: 'q_parts', folder_id: 'f_ops', name: 'Active parts', description: 'Active data parts per table', sql: 'SELECT table, count() AS parts FROM system.parts WHERE active GROUP BY table ORDER BY parts DESC', host_id: HOST, tags: ['storage'], created_at_ms: now, updated_at_ms: now },
    { id: 'q_merges', folder_id: 'f_merges', name: 'Running merges', description: 'What the merge pool is doing', sql: 'SELECT database, table, elapsed, progress FROM system.merges', host_id: HOST, tags: [], created_at_ms: now, updated_at_ms: now },
    { id: 'q_answer', folder_id: null, name: 'The answer', description: '', sql: 'SELECT 42 AS answer', host_id: HOST, tags: [], created_at_ms: now, updated_at_ms: now },
  ],
};

const panel = (page) => page.locator('#queryLibraryMenu');
const preview = (page) => page.locator('#queryLibraryPreview');
// The pane's foot (Copy SQL, Run... Load in editor) and its tools row.
const previewAction = (page, action) => preview(page).locator(`.qlPreview__foot [data-action="${action}"]`);
const previewTool = (page, action) => preview(page).locator(`.qlPreview__tools [data-action="${action}"]`);
const footLabels = (page) => preview(page).locator('.qlPreview__foot .button');
const toolLabels = (page) => preview(page).locator('.qlPreview__tools .button');
const facts = (page) => preview(page).locator('.qlPreview__facts').evaluate((dl) => {
  const out = {};
  for (const dt of dl.querySelectorAll('dt')) out[dt.textContent] = dt.nextElementSibling.textContent;
  return out;
});

// Selects a tree item without toggling it (the focus selects).
async function selectItem(page, name) {
  await node(page, name).focus();
  await expect(node(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(name);
}

// Selects a saved query (a click) and loads it with the preview's button.
async function loadSaved(page, name) {
  await node(page, name).locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(name);
  await previewAction(page, 'load').click();
}

// Opens the panel (from a closed state) on a tab.
async function showPanel(page, tab = 'saved') {
  if (await panel(page).isHidden()) await page.locator('#queryLibraryButton').click();
  await expect(panel(page)).toBeVisible();
  await page.locator(tab === 'history' ? '#queryLibraryTabHistory' : '#queryLibraryTabSaved').click();
  if (tab === 'history') await expect(page.locator('#queryLibraryViewHistory .qhList')).toBeVisible({ timeout: 10_000 });
  else await expect(tree(page)).toBeVisible({ timeout: 10_000 });
}

async function openLibrary(page) {
  await openApp(page);
  await showPanel(page);
}

// The library is modal: the editor behind it is inert until it closes.
async function closePanel(page) {
  if (await panel(page).isVisible()) await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
}

// Waits for the open animation (the dialog box is scaled meanwhile).
async function settled(locator) {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return locator.boundingBox();
}

async function expandFolder(page, name) {
  const folder = node(page, name);
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

async function fillDialog(page, fields) {
  const d = dialog(page);
  await expect(d).toBeVisible();
  for (const [name, value] of Object.entries(fields)) {
    const control = d.locator(`[name="${name}"]`);
    if ((await control.evaluate((el) => el.tagName)) === 'SELECT') await control.selectOption({ label: value });
    else await control.fill(value);
  }
}

// A second host, "other", next to the compose instance's "local": /api/hosts
// lists it, and the requests naming it are answered for "local" (the same
// ClickHouse), so the page has two hosts to switch between.
async function addSecondHost(page) {
  const withOther = (body) => {
    const hosts = Array.isArray(body.hosts) ? body.hosts : [];
    if (hosts.length && !hosts.some((h) => h.id === 'other')) hosts.push({ ...hosts[0], id: 'other', label: 'other' });
    return body;
  };
  await page.route('**/api/hosts', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: withOther(await response.json()) });
  });
  // The picker follows the hosts stream: one event with both hosts, then the
  // stream ends (the page polls api/hosts and reconnects).
  await page.route('**/api/hosts/stream', async (route) => {
    const response = await page.request.get(route.request().url().replace(/\/stream(\?.*)?$/, ''));
    const body = withOther(await response.json());
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: hosts\ndata: ${JSON.stringify(body)}\n\n` });
  });
  await page.route(/[?&]host_id=other(&|$)/, async (route) => {
    const url = route.request().url();
    if (url.includes('/api/query-library')) return route.fallback();
    return route.continue({ url: url.replace(/host_id=other/, 'host_id=local') });
  });
}

// Picks a host in the header (the library dialog must be closed: the page
// under a modal dialog is inert).
async function pickHost(page, id) {
  await page.locator('#hostPickerButton').click();
  await expect(page.locator('#hostPickerMenu')).toBeVisible();
  await page.locator('#hostPickerMenu .pickerOption').filter({ has: page.locator('.pickerOption__label', { hasText: new RegExp(`^${id}$`) }) }).click();
  await expect(page.locator('#hostPickerText')).toHaveText(id);
}

// The text the last copy put on the clipboard (http origins have no async
// clipboard to read: ui.copyText selects a textarea and runs the copy command).
async function captureCopies(page) {
  await page.evaluate(() => {
    window.__qlCopied = '';
    document.addEventListener('copy', (ev) => {
      const el = ev.target instanceof HTMLTextAreaElement ? ev.target : document.activeElement;
      if (el && typeof el.value === 'string') window.__qlCopied = el.value.slice(el.selectionStart, el.selectionEnd);
    }, true);
  });
}
const copiedText = (page) => page.evaluate(() => window.__qlCopied);

// No item menu anywhere on the left column: no "..." button, and a right
// click opens nothing of ours.
async function expectNoItemMenu(page, item) {
  await expect(item.locator('button')).toHaveCount(0);
  await item.click({ button: 'right' });
  await expect(page.locator('#queryLibraryMenu [role=menu]')).toHaveCount(0);
}

// --- Browser mode -----------------------------------------------------------

test('browser mode purges the entries without a host and no longer reads chdash.savedQueries.v1', async ({ page }) => {
  const legacy = [{ name: 'Legacy flat', sql_raw: 'SELECT 1', host_id: HOST, created_at_ms: now - 1000 }];
  await seed(page, {
    'chdash.savedQueries.v1': legacy,
    'chdash.queryLibrary.v2': {
      version: 2,
      revision: 4,
      folders: [
        { id: 'f_hostless', parent_id: null, name: 'Hostless folder', description: '' },
        { id: 'f_local', host_id: HOST, parent_id: null, name: 'Local folder', description: '' },
        { id: 'f_other', host_id: 'other', parent_id: null, name: 'Other folder', description: '' },
      ],
      queries: [
        { id: 'q_hostless', folder_id: null, name: 'Hostless query', sql: 'SELECT 2', host_id: null, tags: [] },
        { id: 'q_in_hostless', folder_id: 'f_hostless', name: 'Was in a hostless folder', sql: 'SELECT 3', host_id: HOST, tags: [] },
        { id: 'q_local', folder_id: 'f_local', name: 'Local query', sql: 'SELECT 4', host_id: HOST, tags: [] },
        { id: 'q_other', folder_id: 'f_other', name: 'Other query', sql: 'SELECT 5', host_id: 'other', tags: [] },
      ],
    },
    'chdash.queryHistory.v1': [
      { ts_ms: now - 3000, sql_raw: 'SELECT \'hostless run\'', host_id: null, status: 'ok' },
      { ts_ms: now - 2000, sql_raw: 'SELECT \'local run\'', host_id: HOST, status: 'ok' },
      { ts_ms: now - 1000, sql_raw: 'SELECT \'other run\'', host_id: 'other', status: 'ok' },
    ],
  });
  await openLibrary(page);
  // Only the current host's entries; a query of a removed folder is at the top level.
  await expect(node(page, 'Local folder')).toBeVisible();
  await expect(node(page, 'Was in a hostless folder')).toHaveAttribute('aria-level', '1');
  for (const gone of ['Hostless folder', 'Hostless query', 'Other folder', 'Other query', 'Legacy flat']) await expect(node(page, gone)).toHaveCount(0);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toHaveText(`2 queries \u00b7 ${HOST} \u00b7 Stored in this browser`);

  // The stored library lost its host-less entries (the other host's stay).
  const stored = await libraryState(page);
  expect(stored.version).toBe(2);
  expect(stored.folders.map((f) => f.id).sort()).toEqual(['f_local', 'f_other']);
  expect(stored.queries.map((q) => q.id).sort()).toEqual(['q_in_hostless', 'q_local', 'q_other']);
  expect(stored.queries.find((q) => q.id === 'q_in_hostless').folder_id).toBeNull();
  expect('migrated_from' in stored).toBe(false);
  // The legacy flat list is neither imported nor touched.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('chdash.savedQueries.v1')))).toEqual(legacy);
  // History: the host-less run is gone from the key, the other host's is kept but not shown.
  expect((await historyState(page)).map((h) => h.host_id).sort()).toEqual([HOST, 'other']);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveCount(1);
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toContainText('local run');

  // A run is recorded with its host; loading a query fills the editor.
  await page.locator('#queryLibraryTabSaved').click();
  await loadSaved(page, 'Was in a hostless folder');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 3');
  await expect(panel(page)).toBeHidden();
  await runSuccessfulQuery(page, 'SELECT 6 AS six');
  expect((await historyState(page))[0]).toMatchObject({ host_id: HOST, sql_raw: 'SELECT 6 AS six' });
});

test('confirm prompts: delete a query or a folder, clear the history; Cancel, Escape and the backdrop keep everything', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const confirm = dialog(page);

  // Delete a query: the shared confirm, over the library, focus on Cancel.
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveClass(/uiDialog--sm/);
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Delete query');
  await expect(confirm.locator('.uiDialog__message')).toContainText('Delete \u201cThe answer\u201d? This cannot be undone.');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Delete' })).toHaveClass(/button--danger/);
  // Enter on the focused Cancel keeps the query.
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'The answer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('li[role=treeitem]')?.dataset.id || '')).toBe('q_answer');
  // The backdrop of the confirm closes the confirm only.
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // Confirmed (from the preview's Delete), it goes.
  await previewTool(page, 'delete').click();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page)).queries.map((q) => q.id).sort()).toEqual(['q_merges', 'q_parts']);
  // Its toast is shown in the top dialog (the page under it is inert).
  await expect(page.locator('#queryLibraryMenu > .qlToast')).toContainText('Query deleted.');

  // Delete a non-empty folder: Escape keeps it.
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Delete folder');
  await expect(confirm).toContainText('2 queries and 1 subfolder');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'Operations')).toBeVisible();
  // An empty folder asks too (Delete key).
  await node(page, 'Reports').focus();
  await page.keyboard.press('Delete');
  await expect(confirm.locator('.uiDialog__message')).toHaveText('Delete the empty folder \u201cReports\u201d?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Reports')).toBeVisible();

  // The toast follows the page when the library closes.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.querySelector('.qlToast')?.parentElement === document.body)).toBe(true);
});

test('folders: create, nest, rename, move and delete from the preview; the picker writes folders as "/" paths', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] } });
  await openLibrary(page);
  await expect(tree(page)).toContainText(`No saved queries for ${HOST} yet`);

  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  // The picker: "/" is the top level, no "Top level" label.
  await expect(dialog(page).locator('[name="parent_id"] option')).toHaveText(['/']);
  await fillDialog(page, { name: 'Monitoring', description: 'Health checks' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, 'Monitoring')).toBeVisible();

  // Duplicate sibling names are refused in the dialog, case-insensitively.
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'monitoring', parent_id: '/' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  // A folder's preview: its path, contents and tools (no foot, no Load).
  await selectItem(page, 'Monitoring');
  expect(await facts(page)).toEqual({ Path: '/Monitoring', Contents: 'Empty' });
  await expect(toolLabels(page)).toHaveText(['Rename\u2026', 'Move\u2026', 'Delete', 'New subfolder\u2026']);
  await expect(preview(page).locator('.qlPreview__foot')).toHaveCount(0);
  await expectNoItemMenu(page, node(page, 'Monitoring'));

  // New subfolder, from the preview; the picker offers it as a path.
  await previewTool(page, 'new-subfolder').click();
  await expect(dialog(page).locator('[name="parent_id"] option')).toHaveText(['/', '/Monitoring']);
  await expect(dialog(page).locator('[name="parent_id"] option:checked')).toHaveText('/Monitoring');
  await fillDialog(page, { name: 'Disks' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'Disks')).toHaveAttribute('aria-level', '2');

  // Saving with the subfolder selected puts the query in it.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT name, free_space FROM system.disks');
  await showPanel(page);
  await selectItem(page, 'Disks');
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  await expect(dialog(page).locator('[name="folder_id"] option')).toHaveText(['/', '/Monitoring', '/Monitoring/Disks']);
  await expect(dialog(page).locator('[name="folder_id"] option:checked')).toHaveText('/Monitoring/Disks');
  await fillDialog(page, { name: 'Free space', description: 'Free bytes per disk' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expandFolder(page, 'Disks');
  await expect(node(page, 'Free space')).toHaveAttribute('aria-level', '3');
  await selectItem(page, 'Free space');
  expect((await facts(page)).Folder).toBe('/Monitoring/Disks');

  // Rename: F2 on the folder, or Rename... in the preview.
  await node(page, 'Monitoring').focus();
  await node(page, 'Monitoring').press('F2');
  await fillDialog(page, { name: 'Health' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Health')).toBeVisible();
  await expect(node(page, 'Monitoring')).toHaveCount(0);
  await selectItem(page, 'Disks');
  await previewTool(page, 'rename').click();
  await fillDialog(page, { name: 'Volumes' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Volumes')).toBeVisible();

  // Move... from the preview: to the top level ("/").
  await selectItem(page, 'Volumes');
  await previewTool(page, 'move').click();
  await expect(dialog(page).locator('select[name="target"] option')).toHaveText(['/', '/Health']);
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /.');
  await expect(node(page, 'Volumes')).toHaveAttribute('aria-level', '1');

  // Deleting a non-empty folder asks first and removes everything inside.
  await selectItem(page, 'Volumes');
  await previewTool(page, 'delete').click();
  await expect(dialog(page)).toContainText('1 query');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Volumes')).toBeVisible();
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
  await expect(node(page, 'Volumes')).toHaveCount(0);
  await selectItem(page, 'Health');
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(node(page, 'Health')).toHaveCount(0);
  const stored = await libraryState(page);
  expect(stored.folders).toEqual([]);
  expect(stored.queries).toEqual([]);
});

test('save, open, edit (name, description, SQL, tags) and update the opened query with Ctrl+S', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const editor = page.locator('#queryTextArea');

  // Save the editor with the panel's + button.
  await closePanel(page);
  await editor.fill('SELECT count() FROM system.tables');
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  await fillDialog(page, { name: 'Table count', description: 'How many tables', tags: 'catalog, quick', folder_id: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  await expect(node(page, 'Table count')).toBeVisible();
  let stored = await libraryState(page);
  const saved = stored.queries.find((q) => q.name === 'Table count');
  expect(saved).toMatchObject({ folder_id: 'f_reports', host_id: HOST, description: 'How many tables', sql: 'SELECT count() FROM system.tables', tags: ['catalog', 'quick'] });

  // A click selects a query: the preview shows it, the editor is unchanged
  // and the dialog stays open. "Load in editor" (bottom right) loads it,
  // closes the dialog and focuses the editor; the opened query is marked.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(node(page, 'The answer')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
  await expect(preview(page).locator('.qlSql')).toHaveText('SELECT 42 AS answer');
  await expect(panel(page)).toBeVisible();
  await expect(editor).toHaveValue('SELECT count() FROM system.tables');
  // Every action is in the pane: its tools under the title, the rest in the
  // foot, Load in editor last at the bottom right.
  await expect(toolLabels(page)).toHaveText(['Edit\u2026', 'Move\u2026', 'Delete']);
  await expect(previewTool(page, 'delete')).toHaveClass(/button--danger/);
  await expect(footLabels(page)).toHaveText(['Copy SQL', 'Append to editor', 'Run', 'Load in editor']);
  const load = previewAction(page, 'load');
  await expect(load).toHaveClass(/button--primary/);
  const geometry = await page.evaluate(() => {
    const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#queryLibraryPreview .qlPreview__foot .button')].map((b) => b.getBoundingClientRect());
    const last = buttons[buttons.length - 1];
    const tools = document.querySelector('#queryLibraryPreview .qlPreview__tools').getBoundingClientRect();
    const title = document.querySelector('#queryLibraryPreview .qlPreview__title').getBoundingClientRect();
    return {
      right: Math.round(pane.right - last.right),
      bottom: Math.round(pane.bottom - last.bottom),
      lastIsLoad: document.querySelector('#queryLibraryPreview .qlPreview__foot .button:last-child').dataset.action,
      oneRow: buttons.every((b) => Math.abs(b.top - last.top) < 2),
      toolsUnderTitle: tools.top >= title.bottom - 1,
    };
  });
  expect(geometry).toMatchObject({ lastIsLoad: 'load', oneRow: true, toolsUnderTitle: true });
  expect(geometry.right).toBeLessThanOrEqual(20);
  expect(geometry.bottom).toBeLessThanOrEqual(20);
  await expectNoItemMenu(page, node(page, 'The answer'));
  await load.click();
  await expect(editor).toHaveValue('SELECT 42 AS answer');
  await expect(panel(page)).toBeHidden();
  await expect(editor).toBeFocused();
  await showPanel(page);
  await expect(node(page, 'The answer')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();

  // Ctrl+S on an opened query updates it in place (the panel can stay closed).
  await editor.fill('SELECT 42 AS answer, 43 AS next');
  await editor.press('Control+s');
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Save \u201cThe answer\u201d');
  await dialog(page).getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.qlToast')).toContainText('Query updated');
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.id === 'q_answer').sql).toBe('SELECT 42 AS answer, 43 AS next');
  expect(stored.queries.filter((q) => q.name === 'The answer')).toHaveLength(1);

  // Edit... (the preview): name, description, tags and the SQL taken from the editor.
  await closePanel(page);
  await editor.fill('SELECT 6 * 7 AS answer');
  await showPanel(page);
  await selectItem(page, 'The answer');
  await previewTool(page, 'edit').click();
  await expect(dialog(page).locator('[name="folder_id"] option:checked')).toHaveText('/');
  await fillDialog(page, { name: 'Answer', description: 'Douglas Adams', tags: 'fun' });
  await dialog(page).locator('[name="replace_sql"]').check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Answer')).toBeVisible();
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'Answer', description: 'Douglas Adams', tags: ['fun'], sql: 'SELECT 6 * 7 AS answer', host_id: HOST });

  // Copy SQL: the button itself says it.
  await captureCopies(page);
  await previewAction(page, 'copy').click();
  await expect(previewAction(page, 'copy')).toHaveText('Copied');
  await expect.poll(() => copiedText(page)).toBe('SELECT 6 * 7 AS answer');
});

test('move: drag and drop into a folder, Move\u2026 from the preview, no move into a descendant', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);

  // Drag the top-level query onto a folder.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast')).toContainText('Moved to /Reports');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');

  // Drag it back to the top level (the tree background).
  const box = await tree(page).boundingBox();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(tree(page), { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '1');

  // Move... a query: every folder as a path.
  await selectItem(page, 'The answer');
  await previewTool(page, 'move').click();
  await expect(dialog(page).locator('select[name="target"] option')).toHaveText(['/', '/Operations', '/Operations/Merges', '/Reports']);
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/Operations/Merges' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /Operations/Merges');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_merges');

  // Move... a folder: its own subfolders are not offered.
  await selectItem(page, 'Operations');
  await previewTool(page, 'move').click();
  const target = dialog(page).locator('select[name="target"]');
  await expect(target.locator('option')).toHaveText(['/', '/Reports']);
  await target.selectOption({ label: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '2');
  const stored = await libraryState(page);
  expect(stored.folders.find((f) => f.id === 'f_ops').parent_id).toBe('f_reports');
  expect(stored.folders.find((f) => f.id === 'f_merges').parent_id).toBe('f_ops');
});

test('search covers names, descriptions and SQL; the selected query shows in the preview: description, folder, tags and highlighted SQL', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const search = page.locator('#queryLibraryViewSaved .qlSearch__input');
  const results = tree(page).locator('li[role=treeitem]');

  await search.fill('merge pool');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('Running merges');
  await expect(results.first().locator('.qlRow__path')).toHaveText('/Operations/Merges');

  await search.fill('system.parts');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('Active parts');

  await search.fill('answer');
  await expect(results).toHaveCount(1);
  await expect(results.first().locator('mark')).toHaveText('answer');

  await search.fill('nothing-like-this');
  await expect(tree(page)).toContainText('No saved query matches');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(node(page, 'Operations')).toBeVisible();

  // Nothing selected yet: the pane says how to fill it.
  const pane = preview(page);
  await expect(pane.locator('.qlPreview__empty')).toHaveText('Select a query to preview it here.');
  // A click selects: name, description, folder, tags, update time and the SQL
  // with keyword highlighting (ns.format time, its ISO value in the tooltip).
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').click();
  await expect(pane).toBeVisible();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Active parts');
  await expect(pane.locator('.qlPreview__description')).toHaveText('Active data parts per table');
  const shown = await facts(page);
  expect(Object.keys(shown)).toEqual(['Folder', 'Tags', 'Updated']);
  expect(shown.Folder).toBe('/Operations');
  expect(shown.Tags).toBe('storage');
  expect(shown.Updated).toMatch(/^Oct 1(, 2026)? 12:00:00$/);
  await expect(pane.locator('.qlPreview__facts time')).toHaveAttribute('datetime', '2026-10-01T12:00:00.000Z');
  await expect(pane.locator('.qlSql')).toContainText('FROM system.parts');
  await expect(pane.locator('.qlSql span').first()).toBeVisible();
  await expect(pane.locator('.qlTag')).toHaveText(['storage']);
  // The Back button is the phone step's only.
  await expect(pane.locator('.qlPreview__back')).toBeHidden();
  // The preview is a pane of the dialog, right of the list.
  const geometry = await page.evaluate(() => {
    const el = document.getElementById('queryLibraryPreview');
    const list = document.getElementById('queryLibraryViewSaved').getBoundingClientRect();
    return { inDialog: !!el.closest('dialog#queryLibraryMenu'), beside: el.getBoundingClientRect().left >= list.right - 1 };
  });
  expect(geometry).toEqual({ inDialog: true, beside: true });
  // Hovering another query changes nothing; selecting it does.
  await node(page, 'The answer').locator(':scope > .qlRow').hover();
  await page.waitForTimeout(500);
  await expect(pane.locator('.qlPreview__title')).toHaveText('Active parts');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('The answer');
  await expect(pane.locator('.qlPreview__description')).toHaveCount(0);
  expect((await facts(page)).Folder).toBe('/');
  // A selected folder shows its description, path and contents, with its tools.
  await node(page, 'Operations').locator(':scope > .qlRow .qlRow__name').click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.locator('.qlPreview__title')).toHaveText('Operations');
  await expect(pane.locator('.qlPreview__description')).toHaveText('Server health');
  expect(await facts(page)).toEqual({ Path: '/Operations', Contents: '2 queries \u00b7 1 subfolder' });
  await expect(pane.locator('.qlPreview__foot')).toHaveCount(0);
  await expect(toolLabels(page)).toHaveCount(4);
  // A renamed query stays selected and previewed under its new name.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await node(page, 'The answer').press('F2');
  await fillDialog(page, { name: 'Answer' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Answer');
  await expect(node(page, 'Answer')).toHaveAttribute('aria-selected', 'true');
});

test('Append to editor (the preview) adds the query as a new statement and turns multiquery on; a modifier-click only selects', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY, 'chdash.runOptions.v1': { autoFormat: false, multiQuery: false, executionStats: false, flattenTuple: true } });
  await openLibrary(page);
  const editor = page.locator('#queryTextArea');
  await closePanel(page);
  await editor.fill('SELECT 1 AS first');
  await showPanel(page);
  // A modifier-click selects, like a click.
  await node(page, 'The answer').locator(':scope > .qlRow').click({ modifiers: ['ControlOrMeta'] });
  await expect(node(page, 'The answer')).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page)).toBeVisible();
  await expect(editor).toHaveValue('SELECT 1 AS first');
  await node(page, 'The answer').locator(':scope > .qlRow').click({ modifiers: ['Shift'] });
  await expect(panel(page)).toBeVisible();
  await expect(editor).toHaveValue('SELECT 1 AS first');
  await previewAction(page, 'append').click();
  await expect(editor).toHaveValue('SELECT 1 AS first;\n\nSELECT 42 AS answer');
  await expect(page.locator('.qlToast')).toContainText('multiquery is now on');
  await expect(panel(page)).toBeHidden();
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await expect(page.locator('.resultsStack__block')).toHaveCount(2);
  // Run (the preview) loads and runs.
  await showPanel(page);
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').click();
  await previewAction(page, 'run').click();
  await expect(panel(page)).toBeHidden();
  await expect(editor).toHaveValue(/FROM system\.parts/);
  await waitForTerminal(page);
});

test('keyboard: tabs, tree navigation and selection, expand / collapse, preview and load, rename and delete; no item menu', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    return el?.closest?.('li[role=treeitem]')?.querySelector('.qlRow__name')?.textContent || el?.id || el?.className || '';
  });

  // The button opens the panel from the keyboard; the focus moves into it
  // (the search) and Escape gives it back to the button.
  const button = page.locator('#queryLibraryButton');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#queryLibraryViewSaved .qlSearch__input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryLibraryViewSaved .qlSearch__input')).toBeFocused();

  // Arrow keys move the selection along the visible items; the preview
  // follows.
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Operations');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Operations');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Reports');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  expect(await focused()).toBe('Merges');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Active parts');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Active parts');
  expect(await tree(page).locator('[aria-selected="true"]').count()).toBe(1);
  await page.keyboard.press('ArrowLeft');
  expect(await focused()).toBe('Operations');
  await page.keyboard.press('ArrowLeft');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('End');
  expect(await focused()).toBe('The answer');
  await page.keyboard.press('Home');
  expect(await focused()).toBe('Operations');
  // Type-ahead.
  await page.keyboard.press('t');
  expect(await focused()).toBe('The answer');

  // F2 edits; Enter submits.
  await page.keyboard.press('F2');
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Edit query');
  await fillDialog(page, { name: 'Answer 42' });
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toBeVisible();

  // No item menu: Shift+F10 and the context-menu key open nothing.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ContextMenu');
  await expect(page.locator('#queryLibraryMenu [role=menu]')).toHaveCount(0);
  expect(await focused()).toBe('Answer 42');

  // Enter moves to the preview, on "Load in editor"; Tab and Shift+Tab reach
  // its other buttons; Enter there loads the query and closes the panel.
  await page.keyboard.press('Enter');
  await expect(previewAction(page, 'load')).toBeFocused();
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Answer 42');
  await page.keyboard.press('Shift+Tab');
  await expect(previewAction(page, 'run')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
  await expect(page.locator('#queryTextArea')).toBeFocused();
  await expect(panel(page)).toBeHidden();

  // Ctrl/Cmd+Enter loads at once, from the list or from the preview (and
  // runs nothing).
  const runs = () => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryHistory.v1') || '[]').length);
  const before = await runs();
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page);
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Control+Enter');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page);
  await node(page, 'Answer 42').locator(':scope > .qlRow').click();
  await previewAction(page, 'run').focus();
  await page.keyboard.press('Control+Enter');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
  expect(await runs()).toBe(before);
  // Ctrl+Enter on a folder loads nothing.
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page);
  await node(page, 'Reports').focus();
  await page.keyboard.press('Control+Enter');
  await expect(panel(page)).toBeVisible();

  // F2 on a folder renames it.
  await page.keyboard.press('F2');
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Rename folder');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  // Delete asks, Enter confirms.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Delete');
  await expect(dialog(page)).toContainText('Delete \u201cAnswer 42\u201d');
  await dialog(page).getByRole('button', { name: 'Delete' }).focus();
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toHaveCount(0);

  // Tabs: arrows switch between Saved and History.
  await page.locator('#queryLibraryTabSaved').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#queryLibraryTabHistory')).toBeFocused();
  await expect(page.locator('#queryLibraryTabHistory')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#queryLibraryViewHistory')).toBeVisible();
  await expect(page.locator('#queryLibraryViewSaved')).toBeHidden();
});

test('history groups runs by day with status, elapsed time and rows; the preview copies, loads, runs, saves and removes; search and clear', async ({ page }) => {
  const day = 24 * 3600 * 1000;
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] },
    'chdash.queryHistory.v1': [
      { ts_ms: Date.now() - 3 * day, sql_raw: 'SELECT \'older\' AS tag', host_id: HOST, status: 'ok', elapsed_ms: 12, rows: 1 },
      { ts_ms: Date.now() - 4 * day, sql_raw: 'SELECT \'oldest\' AS tag', host_id: HOST, status: 'ok', elapsed_ms: 2, rows: 1 },
    ],
  });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(7)');
  await runQuery(page, 'SELECT * FROM chdash_ui.__missing_history_table');
  await waitForTerminal(page);
  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await expect(items).toHaveCount(4);
  await expect(page.locator('#queryLibraryViewHistory .qhDay').first()).toHaveText('Today');
  await expect(page.locator('#queryLibraryViewHistory .qhDay')).toHaveCount(3);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toHaveText(`4 entries \u00b7 ${HOST} \u00b7 Stored in this browser`);

  const failed = items.nth(0);
  await expect(failed).toHaveClass(/qhItem--error/);
  await expect(failed.locator('.qhItem__status')).toHaveAttribute('aria-label', 'Failed');
  const ok = items.nth(1);
  await expect(ok).toHaveClass(/qhItem--ok/);
  await expect(ok.locator('.qhItem__sql')).toContainText('numbers(7)');
  await expect(ok.locator('.qhItem__rows')).toHaveText('7 rows');
  // ns.format: "8 ms", "1.23 s"; the time of day is browser-local 24 h.
  await expect(ok.locator('.qhItem__elapsed')).toHaveText(/^\d+(\.\d+)? (\u00b5s|ms|s)$/);
  await expect(ok.locator('.qhItem__time')).toHaveText(/^\d\d:\d\d:\d\d$/);
  await expect(ok.locator('.qhItem__time')).toHaveAttribute('title', /^\d{4}-\d\d-\d\dT/);
  // The rows carry no buttons and no menu: every action is in the preview.
  await expectNoItemMenu(page, ok);

  // A click selects a run: the preview shows its status, time, elapsed time,
  // rows and SQL, with its tools (Save to library, Remove) and actions
  // (Copy SQL, Run, Load in editor).
  const pane = preview(page);
  await failed.click();
  await ok.click();
  await expect(ok).toHaveAttribute('aria-selected', 'true');
  await expect(pane.locator('.qlPreview__title')).toHaveText('Succeeded');
  await expect(pane.locator('.qlPreview__title .qhItem__status--ok')).toHaveCount(1);
  const shown = await facts(page);
  expect(Object.keys(shown)).toEqual(['Time', 'Elapsed', 'Rows']);
  expect(shown.Time).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d$/);
  expect(shown.Elapsed).toMatch(/^\d+(\.\d+)? (ns|\u00b5s|ms|s)$/);
  expect(shown.Rows).toBe('7');
  await expect(pane.locator('.qlSql')).toContainText('numbers(7)');
  await expect(toolLabels(page)).toHaveText(['Save to library\u2026', 'Remove']);
  await expect(footLabels(page)).toHaveText(['Copy SQL', 'Run', 'Load in editor']);
  await expect(panel(page)).toBeVisible();
  // The failed run's preview shows the server error.
  await failed.click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Failed');
  await expect(pane.locator('.qlPreview__error')).toContainText(/__missing_history_table/);
  // Arrows move the selection, the preview follows.
  await page.keyboard.press('ArrowDown');
  await expect(ok).toBeFocused();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Succeeded');

  // Copy SQL.
  await captureCopies(page);
  await previewAction(page, 'copy').click();
  await expect(previewAction(page, 'copy')).toHaveText('Copied');
  await expect.poll(() => copiedText(page)).toContain('numbers(7)');

  // Search.
  const search = page.locator('#queryLibraryViewHistory .qlSearch__input');
  await search.fill('older');
  await expect(items).toHaveCount(1);
  await search.fill('');
  await expect(items).toHaveCount(4);

  // Load in editor: the SQL, no run, the panel closes.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).click();
  await previewAction(page, 'load').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT \'older\' AS tag');
  await expect(page.locator('#queryTextArea')).toBeFocused();

  // Run loads and runs it (and closes the panel).
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page, 'history');
  await items.filter({ hasText: 'numbers(7)' }).click();
  await previewAction(page, 'run').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue(/numbers\(7\)/);
  await waitForTerminal(page);
  await expect(page.locator('#resultTableBody tr:not(.resultTable__spacerRow)')).toHaveCount(7);

  // Save to library from the History preview.
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).click();
  await previewTool(page, 'save').click();
  await expect(dialog(page)).toContainText('SQL (from History)');
  await expect(dialog(page).locator('[name="folder_id"] option')).toHaveText(['/']);
  await fillDialog(page, { name: 'Older one' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  expect((await libraryState(page)).queries.map((q) => [q.sql, q.host_id])).toEqual([['SELECT \'older\' AS tag', HOST]]);

  // Remove (the preview, or the Delete key): the entry goes, the selection moves on.
  await items.filter({ hasText: 'oldest' }).click();
  await previewTool(page, 'remove').click();
  await expect(items.filter({ hasText: 'oldest' })).toHaveCount(0);
  expect((await historyState(page)).some((h) => h.sql_raw.includes('oldest'))).toBe(false);
  await items.filter({ hasText: 'older' }).focus();
  await page.keyboard.press('Delete');
  await expect(items.filter({ hasText: 'older' })).toHaveCount(0);
  // Keyboard: Enter moves to the preview's Load in editor.
  await items.first().focus();
  await page.keyboard.press('Enter');
  await expect(previewAction(page, 'load')).toBeFocused();

  // Clear, after confirmation (always available in browser mode).
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await expect(dialog(page)).toContainText(`History of ${HOST} in this browser`);
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#queryLibraryViewHistory')).toContainText(`No history for ${HOST} yet`);
  expect(await historyState(page)).toEqual([]);
});

test('per host: the library and the History follow a host switch, live; saves and runs belong to the selected host', async ({ page }) => {
  await addSecondHost(page);
  const other = (q) => ({ ...q, host_id: 'other' });
  await seed(page, {
    'chdash.selectedHost': HOST,
    'chdash.queryLibrary.v2': {
      ...LIBRARY,
      folders: [...LIBRARY.folders, other({ id: 'f_other', parent_id: null, name: 'Other ops', description: '' })],
      queries: [...LIBRARY.queries, other({ id: 'q_other', folder_id: 'f_other', name: 'Other query', description: '', sql: 'SELECT \'other\'', tags: [] }),
        other({ id: 'q_other_top', folder_id: null, name: 'The answer', description: 'same name, other host', sql: 'SELECT 43', tags: [] })],
    },
    'chdash.queryHistory.v1': [
      { ts_ms: Date.now() - 2000, sql_raw: 'SELECT \'ran on local\'', host_id: HOST, status: 'ok' },
      { ts_ms: Date.now() - 1000, sql_raw: 'SELECT \'ran on other\'', host_id: 'other', status: 'ok' },
    ],
  });
  await openApp(page);
  await expect(page.locator('#hostPickerText')).toHaveText(HOST);
  await showPanel(page);
  await expect(node(page, 'Operations')).toBeVisible();
  await expect(node(page, 'Other ops')).toHaveCount(0);
  await selectItem(page, 'The answer');
  await expect(preview(page).locator('.qlSql')).toHaveText('SELECT 42 AS answer');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on local/]);

  // Switch the host in the header: the library shows the other host's.
  await closePanel(page);
  await pickHost(page, 'other');
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await expect(node(page, 'Operations')).toHaveCount(0);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText('2 queries \u00b7 other');
  // The selection was the other host's: nothing is previewed.
  await expect(preview(page).locator('.qlPreview__empty')).toBeVisible();
  await selectItem(page, 'The answer');
  await expect(preview(page).locator('.qlSql')).toHaveText('SELECT 43');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on other/]);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toContainText('other');

  // A save goes to the selected host; its folders are the only ones offered.
  await page.locator('#queryLibraryTabSaved').click();
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT \'saved on other\'');
  await page.locator('#queryTextArea').press('Control+s');
  await expect(dialog(page).locator('[name="folder_id"] option')).toHaveText(['/', '/Other ops']);
  await fillDialog(page, { name: 'Saved on other', folder_id: '/Other ops' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  const stored = await libraryState(page);
  expect(stored.queries.find((q) => q.name === 'Saved on other')).toMatchObject({ host_id: 'other', folder_id: 'f_other' });
  expect(stored.queries.filter((q) => q.host_id === HOST)).toHaveLength(3);

  // Live: a host switch while the dialog is open re-renders it.
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await page.evaluate((id) => window.ChDash.ui.setSelectedHostId(id), HOST);
  await expect(node(page, 'Operations')).toBeVisible();
  await expect(node(page, 'Other ops')).toHaveCount(0);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on local/]);
  await page.evaluate(() => window.ChDash.ui.setSelectedHostId('other'));
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on other/]);
  // Clear empties the selected host's History only.
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await expect(dialog(page)).toContainText('History of other');
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#queryLibraryViewHistory')).toContainText('No history for other yet');
  expect((await historyState(page)).map((h) => h.host_id)).toEqual([HOST]);
});

test('the library opens in the profiling dialog: same shell, size and tabs, the tabs in the head instead of a title; Escape, backdrop and close; focus in, trapped and back', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const button = page.locator('#queryLibraryButton');
  // An icon button like Format, between Format and the run settings cog.
  await expect(button).toHaveAttribute('aria-label', 'Query library');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  // The open-book icon (an SVG mask, like the Format icon).
  await expect(button.locator('.queryLibraryButton__icon')).toBeVisible();
  expect(await button.locator('.queryLibraryButton__icon').evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)).toContain('svg');
  const toolbar = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const f = box('formatButton'); const b = box('queryLibraryButton'); const c = box('runSettingsButton');
    const style = (id) => { const cs = getComputedStyle(document.getElementById(id)); return [cs.width, cs.height, cs.borderRadius, cs.backgroundColor]; };
    return { order: f.right <= b.left && b.right <= c.left, sameLine: Math.abs((b.top + b.bottom) / 2 - (f.top + f.bottom) / 2) <= 2, sameStyle: JSON.stringify(style('formatButton')) === JSON.stringify(style('queryLibraryButton')) };
  });
  expect(toolbar).toEqual({ order: true, sameLine: true, sameStyle: true });
  // Nothing of the dialog exists before it first opens.
  await expect(panel(page)).toHaveCount(0);

  // The shell of the library and of the profiling dialog, side by side.
  const shellOf = (selector) => page.evaluate((sel) => {
    const dialog = document.querySelector(sel);
    const r = dialog.getBoundingClientRect();
    const cs = getComputedStyle(dialog);
    const round = (v) => Math.round(v * 10) / 10;
    const head = dialog.querySelector(':scope > .uiDialog__frame > .uiDialog__head');
    const tab = dialog.querySelector(':scope > .uiDialog__frame .uiDialog__tabs .contentTabs__tab[aria-selected="true"]');
    const tcs = getComputedStyle(tab);
    const close = head.querySelector('.uiDialog__close');
    return {
      tag: dialog.tagName,
      classes: [...dialog.classList].filter((c) => c.startsWith('uiDialog')).sort(),
      modal: dialog.matches(':modal'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      look: [cs.borderRadius, cs.backgroundColor, cs.borderTopColor, cs.boxShadow],
      backdrop: [getComputedStyle(dialog, '::backdrop').backgroundColor, getComputedStyle(dialog, '::backdrop').backdropFilter],
      head: Math.round(head.getBoundingClientRect().height),
      close: [round(close.getBoundingClientRect().width), round(close.getBoundingClientRect().height), close.className],
      tab: [tcs.fontSize, tcs.fontWeight, tcs.borderBottomWidth, tcs.borderBottomColor, tcs.color],
    };
  }, selector);

  await button.click();
  await expect(panel(page)).toBeVisible();
  await expect(tree(page)).toBeVisible();
  await settled(panel(page));
  const library = await shellOf('#queryLibraryMenu');
  expect(library.tag).toBe('DIALOG');
  expect(library.modal).toBe(true);
  // Saved | History stand in the head where a title would be: no title or
  // subtitle, the dialog is named by aria-label, the close button stays in
  // the head, and no tab bar sits under it.
  const head = await page.evaluate(() => {
    const d = document.getElementById('queryLibraryMenu');
    const h = d.querySelector(':scope > .uiDialog__frame > .uiDialog__head');
    const tablist = h.querySelector(':scope > [role=tablist]');
    return {
      label: d.getAttribute('aria-label'),
      labelledby: d.getAttribute('aria-labelledby'),
      titles: d.querySelectorAll('.uiDialog__title, .uiDialog__subtitle, .uiDialog__heading').length,
      tabs: tablist ? [...tablist.querySelectorAll('[role=tab]')].map((t) => t.textContent) : [],
      tabsBelow: d.querySelectorAll(':scope > .uiDialog__frame > .uiDialog__tabs').length,
      close: !!h.querySelector(':scope > .uiDialog__actions > #queryLibraryClose'),
      named: d.textContent.includes('Query library'),
    };
  });
  expect(head).toEqual({ label: 'Query library', labelledby: null, titles: 0, tabs: ['Saved', 'History'], tabsBelow: 0, close: true, named: false });
  await expect(page.getByRole('dialog', { name: 'Query library' })).toBeVisible();
  // The selected tab's underline stands on the head's bottom border.
  const underline = await page.evaluate(() => {
    const h = document.querySelector('#queryLibraryMenu .uiDialog__head').getBoundingClientRect();
    const t = document.getElementById('queryLibraryTabSaved').getBoundingClientRect();
    return Math.round(h.bottom - t.bottom);
  });
  expect(Math.abs(underline)).toBeLessThanOrEqual(1);
  // Focus moved in (the search), the page behind is inert.
  await expect(page.locator('#queryLibraryViewSaved .qlSearch__input')).toBeFocused();
  expect(await page.evaluate(() => document.elementFromPoint(5, 5) === document.getElementById('queryLibraryMenu'))).toBe(true);
  // Tab cycles inside the dialog (and its browser chrome), never to the page.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || !!el?.closest('#queryLibraryMenu');
    })).toBe(true);
  }
  // Escape closes it; the focus is back on the book button.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // A click on the backdrop closes it; so does the close button.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(10, page.viewportSize().height - 10);
  await expect(panel(page)).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  // A click inside (and a press that ends outside) keeps it open.
  await page.locator('#queryLibraryViewSaved .ql__foot').click();
  const foot = await page.locator('#queryLibraryViewSaved .ql__foot').boundingBox();
  await page.mouse.move(foot.x + 5, foot.y + 5);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 3 });
  await page.mouse.up();
  await expect(panel(page)).toBeVisible();
  await page.locator('#queryLibraryClose').click();
  await expect(panel(page)).toBeHidden();
  await expect(button).toBeFocused();

  // The profiling dialog: the same element, classes, geometry, head, close
  // button, backdrop and tab style.
  await runSuccessfulQuery(page, 'SELECT count() FROM numbers(1000)', { profiling: true });
  await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
  await settled(page.locator('#analysisModal'));
  const profiling = await shellOf('#analysisModal');
  // The profiling dialog keeps its title, its tabs under the head.
  await expect(page.locator('#analysisModal .uiDialog__head .uiDialog__title')).toHaveText('Query Analysis');
  await expect(page.locator('#analysisModal > .uiDialog__frame > .uiDialog__tabs')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#analysisModal')).toBeHidden();
  const { head: profilingHead, ...profilingShell } = profiling;
  const { head: libraryHead, ...libraryShell } = library;
  expect(profilingShell).toEqual(libraryShell);
  expect(Math.abs(profilingHead - libraryHead)).toBeLessThanOrEqual(2);
  expect(library.classes).toEqual(['uiDialog', 'uiDialog--lg']);

  // A prompt opened from the library stacks over it: Escape closes the
  // prompt only, and the focus goes back into the library.
  await button.click();
  await expect(tree(page)).toBeVisible();
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[name="name"]')).toBeFocused();
  expect(await page.evaluate(() => [...document.querySelectorAll('dialog:modal')].map((d) => d.id || d.className))).toEqual(['queryLibraryMenu', 'uiDialog uiDialog--sm qlDialog']);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#queryLibraryMenu'))).toBe(true);

  // Closed and reopened at once (the browser's "close" event comes a task
  // later): it stays the top dialog, so its menus and toasts go in it.
  await page.evaluate(async () => {
    window.ChDash.ui.closeQueryLibrary();
    window.ChDash.ui.openQueryLibrary();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.ChDash.dialog.host().id)).toBe('queryLibraryMenu');
  // A prompt of the preview (Edit...) stacks over it; Escape closes the prompt only.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewTool(page, 'edit').click();
  expect(await page.evaluate(() => [...document.querySelectorAll('dialog:modal')].map((d) => d.id || d.className))).toEqual(['queryLibraryMenu', 'uiDialog uiDialog--sm qlDialog']);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // The last tab is remembered.
  await page.locator('#queryLibraryTabHistory').click();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#queryLibraryButton').click();
  await expect(page.locator('#queryLibraryTabHistory')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#queryLibraryViewHistory')).toBeVisible();
  await page.keyboard.press('Escape');

  // The editor / results split is remembered across sessions (localStorage).
  const handle = page.locator('.editorResizeHandle');
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 70, { steps: 5 });
  await page.mouse.up();
  const height = Math.round((await page.locator('.editorWrap').boundingBox()).height);
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem('chdash.editorHeight.v1')))).toBe(height);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled();
  expect(Math.round((await page.locator('.editorWrap').boundingBox()).height)).toBe(height);
});


// --- Server mode (mocked API) ---------------------------------------------------

// An in-memory /api/query-library: per-host reads (host_id required),
// writes stamped with their host, revision, If-Match conflicts, read-only.
async function mockServerLibrary(page, { writable = true, historyStore = 'server', conflicts = 0, library = LIBRARY, history = [] } = {}) {
  const server = {
    revision: 10,
    folders: structuredClone(library.folders),
    queries: structuredClone(library.queries),
    history: structuredClone(history),
    requests: [],
    conflicts,
  };
  let seq = 0;
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const missingHost = (route) => json(route, 400, { error: 'validation', error_code: 'validation', field: 'host_id', reason: 'required', message: 'host_id is required' });
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features = { ...(body.features || {}), query_library: { enabled: true, writable, history_store: historyStore } };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/query-library**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/query-library/, '');
    const method = req.method();
    const headers = req.headers();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    const host = url.searchParams.get('host_id');
    server.requests.push({ method, path: path + url.search, ifMatch: headers['if-match'] || null, contentType: headers['content-type'] || null, body });
    if (method === 'GET' && path === '') {
      if (!host) return missingHost(route);
      return json(route, 200, {
        host_id: host, revision: server.revision, updated_at_ms: now, writable, history_store: historyStore, load_error: null,
        folders: server.folders.filter((f) => f.host_id === host), queries: server.queries.filter((q) => q.host_id === host),
      });
    }
    if (path.startsWith('/history')) {
      if (method === 'GET') {
        if (!host) return missingHost(route);
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const entries = server.history.filter((e) => e.host_id === host && (!q || e.sql.toLowerCase().includes(q))).sort((a, b) => b.ran_at_ms - a.ran_at_ms);
        return json(route, 200, { entries, has_more: false });
      }
      if (method === 'POST') {
        if (!body?.host_id) return missingHost(route);
        const id = `h_${++seq}`;
        server.history.push({ id, ...body });
        return json(route, 201, { id, revision: server.revision });
      }
      if (!writable) return json(route, 403, { error: 'read_only', error_code: 'read_only', message: 'the query library is read-only' });
      if (method === 'DELETE' && path === '/history') {
        if (!host) return missingHost(route);
        server.history = server.history.filter((e) => e.host_id !== host);
      } else {
        server.history = server.history.filter((e) => `/history/${e.id}` !== path);
      }
      return json(route, 200, { ok: true, revision: server.revision });
    }
    if (!writable) return json(route, 403, { error: 'read_only', error_code: 'read_only', message: 'the query library is read-only' });
    if (headers['if-match'] && Number(headers['if-match']) !== server.revision) {
      return json(route, 409, { error: 'conflict', error_code: 'conflict', message: 'the library changed', revision: server.revision });
    }
    if (server.conflicts > 0) {
      server.conflicts -= 1;
      server.revision += 1; // someone else changed the library meanwhile
      return json(route, 409, { error: 'conflict', error_code: 'conflict', message: 'the library changed', revision: server.revision });
    }
    const bump = () => { server.revision += 1; };
    let m;
    if (method === 'POST' && path === '/folders') {
      if (!body.host_id) return missingHost(route);
      if (server.folders.some((f) => f.host_id === body.host_id && f.parent_id === (body.parent_id || null) && f.name.toLowerCase() === body.name.toLowerCase())) {
        return json(route, 400, { error: 'validation', error_code: 'validation', field: 'name', reason: 'duplicate', message: 'a folder with this name already exists here' });
      }
      const folder = { id: `f_s${++seq}`, host_id: body.host_id, parent_id: body.parent_id || null, name: body.name, description: body.description || '', created_at_ms: now, updated_at_ms: now };
      server.folders.push(folder);
      bump();
      return json(route, 201, { ...folder, revision: server.revision });
    }
    if (method === 'POST' && path === '/queries') {
      if (!body.host_id) return missingHost(route);
      const query = { id: `q_s${++seq}`, tags: [], description: '', ...body, created_at_ms: now, updated_at_ms: now };
      server.queries.push(query);
      bump();
      return json(route, 201, { ...query, revision: server.revision });
    }
    if (method === 'POST' && path === '/import') {
      if (!body.host_id) return missingHost(route);
      const ids = {};
      for (const f of body.folders || []) {
        const folder = { id: `f_s${++seq}`, host_id: body.host_id, parent_id: ids[f.parent_id] || null, name: f.name, description: f.description || '', created_at_ms: now, updated_at_ms: now };
        ids[f.id] = folder.id;
        server.folders.push(folder);
      }
      for (const q of body.queries || []) server.queries.push({ id: `q_s${++seq}`, ...q, host_id: body.host_id, folder_id: ids[q.folder_id] || null, created_at_ms: now, updated_at_ms: now });
      bump();
      return json(route, 200, { ok: true, imported_queries: (body.queries || []).length, folder_ids: ids, revision: server.revision });
    }
    if ((m = /^\/(folders|queries)\/([^/?]+)$/.exec(path))) {
      const list = m[1] === 'folders' ? server.folders : server.queries;
      const item = list.find((x) => x.id === decodeURIComponent(m[2]));
      if (!item) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'not found' });
      if (method === 'PATCH') {
        const target = body.folder_id ?? body.parent_id;
        if (target && server.folders.find((f) => f.id === target)?.host_id !== item.host_id) {
          return json(route, 400, { error: 'validation', error_code: 'validation', field: m[1] === 'folders' ? 'parent_id' : 'folder_id', reason: 'host_mismatch', message: 'a folder of another host' });
        }
        Object.assign(item, body);
        bump();
        return json(route, 200, { ...item, revision: server.revision });
      }
      if (method === 'DELETE') {
        if (m[1] === 'folders') {
          const doomed = new Set([item.id]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const f of server.folders) if (f.parent_id && doomed.has(f.parent_id) && !doomed.has(f.id)) { doomed.add(f.id); grew = true; }
          }
          const nonEmpty = doomed.size > 1 || server.queries.some((q) => doomed.has(q.folder_id));
          if (nonEmpty && url.searchParams.get('recursive') !== '1') return json(route, 409, { error: 'not_empty', error_code: 'not_empty', message: 'the folder is not empty' });
          server.folders = server.folders.filter((f) => !doomed.has(f.id));
          server.queries = server.queries.filter((q) => !doomed.has(q.folder_id));
        } else {
          server.queries = server.queries.filter((q) => q.id !== item.id);
        }
        bump();
        return json(route, 200, { ok: true, id: item.id, revision: server.revision });
      }
    }
    return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'unknown route' });
  });
  return server;
}

test('server mode: changes go through the API with If-Match; a conflict reloads and retries once', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true, conflicts: 1 });
  await seed(page, { 'chdash.queryLibrary.v2': null });
  await openLibrary(page);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText(`${HOST} · Stored on the server`);
  await expect(page.locator('#queryLibraryViewSaved .qlBadge--readonly')).toHaveCount(0);
  await expect(node(page, 'Operations')).toBeVisible();
  // Every read names the host.
  expect(server.requests.filter((r) => r.method === 'GET').every((r) => new URL(`http://x${r.path}`).searchParams.get('host_id') === HOST)).toBe(true);

  // Create: the first attempt conflicts, the library is reloaded, the retry wins.
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'Shared' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, 'Shared')).toBeVisible();
  const writes = server.requests.filter((r) => r.method !== 'GET');
  expect(writes.map((r) => [r.method, r.path])).toEqual([['POST', '/folders'], ['POST', '/folders']]);
  expect(writes[0].ifMatch).toBe('10');
  expect(writes[1].ifMatch).toBe('11');
  expect(writes.every((r) => r.contentType === 'application/json')).toBe(true);
  expect(writes[1].body).toEqual({ host_id: HOST, parent_id: null, name: 'Shared', description: '' });

  // A server validation error (duplicate name) is shown in the dialog.
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'shared', parent_id: '/' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');

  // Two conflicts in a row: the user is told and the library is reloaded.
  server.conflicts = 2;
  await selectItem(page, 'The answer');
  await previewTool(page, 'move').click();
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/Shared' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  // The dialog says so (the library was reloaded); Escape gives up.
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('changed by someone else');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '1');

  // Moving and recursive delete through the API.
  await expect(panel(page)).toBeVisible();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Shared').locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  expect(server.queries.find((q) => q.id === 'q_answer').folder_id).toBe(server.folders.find((f) => f.name === 'Shared').id);
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
  await expect(node(page, 'Operations')).toHaveCount(0);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/folders/f_ops?recursive=1')).toBe(true);
  // A saved query is stamped with the host.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 7 AS seven');
  await page.locator('#queryTextArea').press('Control+s');
  await fillDialog(page, { name: 'Seven' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect(server.requests.filter((r) => r.method === 'POST' && r.path === '/queries').at(-1).body).toMatchObject({ host_id: HOST, name: 'Seven', sql: 'SELECT 7 AS seven' });
  // Nothing was written to the browser library.
  expect(await libraryState(page)).toBeNull();
});

test('server mode: a host switch reloads the library and the History of the new host; a host_mismatch is reported', async ({ page }) => {
  await addSecondHost(page);
  const server = await mockServerLibrary(page, {
    writable: true,
    library: {
      folders: [...LIBRARY.folders, { id: 'f_other', host_id: 'other', parent_id: null, name: 'Other ops', description: '', created_at_ms: now, updated_at_ms: now }],
      queries: [...LIBRARY.queries, { id: 'q_other', host_id: 'other', folder_id: 'f_other', name: 'Other query', description: '', sql: 'SELECT 9', tags: [], created_at_ms: now, updated_at_ms: now }],
    },
    history: [
      { id: 'h_local', sql: 'SELECT \'on local\'', host_id: HOST, ran_at_ms: Date.now() - 2000, status: 'ok' },
      { id: 'h_other', sql: 'SELECT \'on other\'', host_id: 'other', ran_at_ms: Date.now() - 1000, status: 'ok' },
    ],
  });
  await seed(page, { 'chdash.selectedHost': HOST });
  await openLibrary(page);
  await expect(node(page, 'Operations')).toBeVisible();
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/on local/]);
  await closePanel(page);
  await pickHost(page, 'other');
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await expect(node(page, 'Operations')).toHaveCount(0);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/on other/]);
  const reads = server.requests.filter((r) => r.method === 'GET').map((r) => new URL(`http://x${r.path}`).searchParams.get('host_id'));
  expect(reads.at(-1)).toBe('other');
  expect(reads).toContain(HOST);
  // Clear: the other host's History only.
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await expect(dialog(page)).toContainText('History of other stored on the server');
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveCount(0);
  expect(server.history.map((e) => e.id)).toEqual(['h_local']);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/history?host_id=other')).toBe(true);

  // A move the server refuses (the folder moved to another host behind this
  // page's back: 400 host_mismatch) is told, and nothing moves.
  await page.locator('#queryLibraryTabSaved').click();
  await page.evaluate((id) => window.ChDash.ui.setSelectedHostId(id), HOST);
  await expect(node(page, 'Operations')).toBeVisible();
  server.folders.find((f) => f.id === 'f_reports').host_id = 'other';
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast--error')).toContainText('a folder of another host');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '1');
  expect(server.queries.find((q) => q.id === 'q_answer').folder_id).toBeNull();
});

test('server mode: runs are appended to the server History of their host, which can be searched and cleared', async ({ page }) => {
  const server = await mockServerLibrary(page, {
    writable: true,
    history: [{ id: 'h_old', sql: 'SELECT 1 AS earlier', host_id: HOST, ran_at_ms: Date.now() - 60_000, elapsed_ms: 3, rows: 1, status: 'ok', error: null }],
  });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(3)');
  await expect.poll(() => server.history.length).toBe(2);
  const appended = server.history.find((e) => e.id !== 'h_old');
  expect(appended).toMatchObject({ status: 'ok', rows: 3, host_id: HOST });
  expect(appended.sql).toContain('numbers(3)');
  expect(appended.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(server.requests.find((r) => r.method === 'POST' && r.path === '/history').ifMatch).toBeNull();

  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toContainText('Stored on the server');
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('earlier');
  await expect.poll(() => server.requests.some((r) => r.method === 'GET' && r.path.includes('q=earlier') && r.path.includes(`host_id=${HOST}`))).toBe(true);
  await expect(items).toHaveCount(1);
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('');
  await expect(items).toHaveCount(2);
  // Remove (the preview): DELETE /history/<id>.
  await items.filter({ hasText: 'earlier' }).click();
  await previewTool(page, 'remove').click();
  await expect(items).toHaveCount(1);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/history/h_old')).toBe(true);
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await expect(dialog(page)).toContainText('Everyone using this server');
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(items).toHaveCount(0);
  expect(server.history).toEqual([]);
});

test('server mode read-only: badge, no editing controls, opening and copying still work', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: false });
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [{ id: 'q_mine', folder_id: null, name: 'Mine', sql: 'SELECT 1', host_id: HOST, tags: [] }] } });
  await openLibrary(page);
  await expect(page.locator('#queryLibraryViewSaved .qlBadge--readonly')).toHaveText('Read-only library');
  await expect(page.locator('#queryLibraryViewSaved .ql__actions')).toBeHidden();
  // No import offer either: nothing can be written.
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
  await expect(tree(page).locator('li[draggable="true"]')).toHaveCount(0);

  // The preview has no tools, only the actions that change nothing.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(footLabels(page)).toHaveText(['Copy SQL', 'Append to editor', 'Run', 'Load in editor']);
  await selectItem(page, 'Operations');
  await expect(preview(page).locator('.qlPreview__tools, .qlPreview__foot')).toHaveCount(0);
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewAction(page, 'load').click();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');

  // Editing shortcuts are inert; Ctrl+S explains why.
  await showPanel(page);
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('F2');
  await expect(dialog(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('#queryTextArea').press('Control+s');
  await expect(page.locator('.qlToast--error')).toContainText('read-only');

  // History: no Clear, no Save to library and no Remove on a read-only server.
  await runSuccessfulQuery(page, 'SELECT 5 AS five');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await expect(page.locator('#queryLibraryViewHistory .qh__clear')).toBeHidden();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(footLabels(page)).toHaveText(['Copy SQL', 'Run', 'Load in editor']);
  expect(server.requests.filter((r) => r.method !== 'GET' && !r.path.startsWith('/history'))).toEqual([]);
});

test('server mode offers once per host to import the browser queries of that host', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true, library: { folders: [], queries: [] } });
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 2, folders: [{ id: 'f_local', host_id: HOST, parent_id: null, name: 'Local folder', description: '' }], queries: [
      { id: 'q_l1', folder_id: 'f_local', name: 'Local one', description: 'from this browser', sql: 'SELECT 1', host_id: HOST, tags: [] },
      { id: 'q_l2', folder_id: null, name: 'Local two', description: '', sql: 'SELECT 2', host_id: HOST, tags: ['x'] },
      { id: 'q_o1', folder_id: null, name: 'Of another host', description: '', sql: 'SELECT 3', host_id: 'other', tags: [] },
      { id: 'q_none', folder_id: null, name: 'Without a host', description: '', sql: 'SELECT 4', host_id: null, tags: [] },
    ] },
  });
  await openLibrary(page);
  const offer = page.locator('#queryLibraryViewSaved .qlNotice--import');
  await expect(offer).toContainText('2 queries of this host are saved in this browser only');
  // The import asks first (the shared confirm, over the library).
  await offer.getByRole('button', { name: 'Import my browser queries' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Import browser queries');
  await expect(dialog(page)).toContainText(`Import the 2 queries of ${HOST} saved in this browser`);
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(server.requests.some((r) => r.path === '/import')).toBe(false);
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Import my browser queries' }).click();
  await dialog(page).getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('.qlToast')).toContainText('Imported 2 browser queries');
  await expect(offer).toHaveCount(0);
  const call = server.requests.find((r) => r.method === 'POST' && r.path === '/import');
  expect(call.body.host_id).toBe(HOST);
  expect(call.body.folders).toEqual([{ id: 'f_local', parent_id: null, name: 'Local folder', description: '' }]);
  expect(call.body.queries.map((q) => [q.name, q.folder_id])).toEqual([['Local one', 'f_local'], ['Local two', null]]);
  expect(call.body.queries.every((q) => !('host_id' in q))).toBe(true);
  await expect(node(page, 'Local folder')).toBeVisible();
  expect(server.queries.every((q) => q.host_id === HOST)).toBe(true);
  // Remembered per host.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryLibrary.importOffer.v1')))).toMatchObject({ hosts: { [HOST]: { state: 'imported' } } });
  await page.reload();
  await showPanel(page);
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
});

// --- Phone and themes -------------------------------------------------------

test('phone: the library and profiling dialogs are full-screen, the list and the preview are two steps, a prompt is a bottom sheet, both themes', async ({ page }, testInfo) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    const button = page.locator('#queryLibraryButton');
    await expect(button).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Toolbar controls stay clickable (none hides under the metrics).
    await runSuccessfulQuery(page, 'SELECT number, toString(number) AS label FROM numbers(5)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await button.click();
    await expect(panel(page)).toBeVisible();
    await expect(tree(page)).toBeVisible();
    const box = await settled(panel(page));
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 390, 844]);
    // The first step is the list alone: no preview pane beside it.
    await expect(preview(page)).toBeHidden();
    expect(Math.round((await page.locator('#queryLibraryViewSaved').boundingBox()).width)).toBe(390);
    await expect(tree(page).locator('button')).toHaveCount(0);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-${scheme}.png` });
    // A prompt is a bottom sheet over it.
    await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
    const sheet = await settled(dialog(page));
    expect([Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 844]);
    expect(sheet.y).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // A tap shows the query's preview in place of the list, with a Back
    // button and every action; the focus is on Load in editor. Nothing is
    // loaded yet.
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await expect(preview(page)).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved')).toBeHidden();
    await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
    await expect(preview(page).locator('.qlPreview__back')).toBeVisible();
    await expect(previewAction(page, 'load')).toBeFocused();
    await expect(toolLabels(page)).toHaveText(['Edit…', 'Move…', 'Delete']);
    await expect(footLabels(page)).toHaveText(['Copy SQL', 'Append to editor', 'Run', 'Load in editor']);
    expect(Math.round((await preview(page).boundingBox()).width)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Every button of the pane is inside it, Load in editor last.
    const fit = await page.evaluate(() => {
      const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#queryLibraryPreview .button')].map((b) => b.getBoundingClientRect());
      return buttons.every((b) => b.left >= pane.left - 0.5 && b.right <= pane.right + 0.5 && b.bottom <= pane.bottom + 0.5);
    });
    expect(fit).toBe(true);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-preview-${scheme}.png` });
    // Back (and Escape) return to the list, on the item; the dialog stays.
    await preview(page).locator('.qlPreview__back').click();
    await expect(preview(page)).toBeHidden();
    await expect(node(page, 'The answer')).toBeFocused();
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await expect(preview(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(preview(page)).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(node(page, 'The answer')).toBeFocused();
    // A folder: the twisty opens or closes it, its name opens its preview
    // (its tools). (The expanded folders are remembered across the loop.)
    const expanded = await node(page, 'Operations').getAttribute('aria-expanded');
    await node(page, 'Operations').locator(':scope > .qlRow .qlRow__twisty').click();
    await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
    await expect(preview(page)).toBeHidden();
    await node(page, 'Operations').locator(':scope > .qlRow .qlRow__name').click();
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).locator('.qlPreview__title')).toHaveText('Operations');
    await expect(toolLabels(page)).toHaveText(['Rename…', 'Move…', 'Delete', 'New subfolder…']);
    await expect(previewTool(page, 'rename')).toBeFocused();
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-folder-${scheme}.png` });
    await preview(page).locator('.qlPreview__back').click();
    await expect(node(page, 'Operations')).toBeFocused();
    // Then Load in editor closes the dialog and fills the editor.
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await previewAction(page, 'load').click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
    // History: the same two steps; the dialog reopens on the list.
    await button.click();
    await expect(panel(page)).toBeVisible();
    await page.locator('#queryLibraryTabHistory').click();
    await expect(preview(page)).toBeHidden();
    await page.locator('#queryLibraryViewHistory .qhItem').first().click();
    await expect(preview(page)).toBeVisible();
    await expect(page.locator('#queryLibraryViewHistory')).toBeHidden();
    await expect(toolLabels(page)).toHaveText(['Save to library…', 'Remove']);
    await expect(footLabels(page)).toHaveText(['Copy SQL', 'Run', 'Load in editor']);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-history-preview-${scheme}.png` });
    await preview(page).locator('.qlPreview__back').click();
    await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeFocused();
    await page.locator('#queryLibraryTabSaved').click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    const background = await panel(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toMatch(scheme === 'dark' ? /rgba?\((1[0-9]|[0-9]|2[0-9]), / : /rgba?\(255, 255, 255/);
    // Profiling: the same full-screen dialog.
    await runSuccessfulQuery(page, 'SELECT count() FROM numbers(10)', { profiling: true });
    await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
    const analysis = await settled(page.locator('#analysisModal'));
    expect([Math.round(analysis.x), Math.round(analysis.y), Math.round(analysis.width), Math.round(analysis.height)]).toEqual([0, 0, 390, 844]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-profiling-${scheme}.png` });
    await page.locator('#analysisCloseButton').click();
    await expect(page.locator('#analysisModal')).toBeHidden();
  }
});

test('themes: panel, tree and preview (tools and actions) follow dark and light', async ({ page }, testInfo) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  const colors = {};
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await openLibrary(page);
    await expandFolder(page, 'Operations');
    await node(page, 'Active parts').locator(':scope > .qlRow').click();
    await expect(page.locator('#queryLibraryPreview .qlSql')).toBeVisible();
    colors[scheme] = await page.evaluate(() => ({
      nav: getComputedStyle(document.getElementById('queryLibraryMenu')).backgroundColor,
      name: getComputedStyle(document.querySelector('.qlRow__name')).color,
      preview: getComputedStyle(document.querySelector('#queryLibraryPreview .qlSql')).backgroundColor,
      tool: getComputedStyle(document.querySelector('#queryLibraryPreview .qlPreview__tools .button')).color,
      danger: getComputedStyle(document.querySelector('#queryLibraryPreview .qlPreview__tools .button--danger')).color,
    }));
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-library-${scheme}.png` });
    await selectItem(page, 'Operations');
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-library-folder-${scheme}.png` });
    await page.locator('#queryLibraryTabHistory').click();
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-library-history-${scheme}.png` });
    await page.locator('#queryLibraryTabSaved').click();
    await previewTool(page, 'move').click();
    await expect(dialog(page).locator('select[name="target"] option').first()).toHaveText('/');
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-library-move-${scheme}.png` });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
  expect(colors.dark.nav).not.toBe(colors.light.nav);
  expect(colors.dark.name).not.toBe(colors.light.name);
  expect(colors.dark.preview).not.toBe(colors.light.preview);
  expect(colors.dark.tool).not.toBe(colors.light.tool);
  expect(colors.dark.danger).not.toBe(colors.light.danger);
});

// --- Live server (optional) -------------------------------------------------

const LIVE = process.env.QUERY_LIBRARY_BASE_URL || '';

test('live server library: create, save, move, reload and delete against a real instance', async ({ page }) => {
  test.skip(!LIVE, 'QUERY_LIBRARY_BASE_URL names a writable query library instance (tests/README.md).');
  const stamp = `pw-${Date.now().toString(36)}`;
  await page.goto(`${LIVE.replace(/\/+$/, '')}/query`);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  const host = (await page.locator('#hostPickerText').textContent()).trim();
  await showPanel(page);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText(`${host} · Stored on the server`);

  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: `${stamp} folder` });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, `${stamp} folder`)).toBeVisible();

  await closePanel(page);
  await page.locator('#queryTextArea').fill(`SELECT '${stamp}' AS stamp`);
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  await fillDialog(page, { name: `${stamp} query`, description: 'live check', folder_id: '/' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node(page, `${stamp} query`)).toBeVisible();
  await node(page, `${stamp} query`).locator(':scope > .qlRow').dragTo(node(page, `${stamp} folder`).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '2');

  // Reloaded from the server file, for this host.
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  await showPanel(page);
  await expandFolder(page, `${stamp} folder`);
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '2');
  const library = await page.evaluate(async (id) => (await fetch(`api/query-library?host_id=${encodeURIComponent(id)}`)).json(), host);
  expect(library.queries.find((q) => q.name === `${stamp} query`).host_id).toBe(host);

  // The run lands in the server History of the host.
  await loadSaved(page, `${stamp} query`);
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').filter({ hasText: stamp }).first()).toBeVisible();
  await page.locator('#queryLibraryTabSaved').click();

  await selectItem(page, `${stamp} folder`);
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveCount(0);
});
