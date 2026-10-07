import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

// Query library: the toolbar book button (between Format and the run settings
// cog) opens it in the shared modal dialog of the profiling (app_ui_dialog.js:
// same shell, size, backdrop and tab style), with two tabs in its head (no
// title), Saved (folders and saved queries) and History, and its prompts
// stacked over it. Saved is a tree, as in the Explorer: the storages are its
// top folders and every folder opens in place. A "New folder" button in the
// head names the folder in its row, a "..." menu on each row (also the right
// click) changes it, "Save query" is
// in the foot, and the preview pane on the right shows the highlighted row:
// its tools are icon buttons at the right end of the head's one line (title,
// then "Updated ..." or a run's time and status), its foot holds "Load"
// (Ctrl/Cmd+Enter) only.
// Saved holds two root folders: "Shared server storage" (the server library,
// only when features.query_library is enabled) and "Local browser storage"
// (localStorage chdash.queryLibrary.v2), both browsable; the pickers offer
// both; a move between them copies, then removes. Saved queries, folders and
// History are per host: the dialog shows the selected host's and follows a
// host switch. The server is a small in-memory server behind page.route,
// writable or read-only, plus one live check when QUERY_LIBRARY_BASE_URL
// names a real instance. History is the browser's record of what ran:
// nothing in it can be removed.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const shotsDir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/query-library`;
const LOCAL_ROOT = 'Local browser storage';
const SERVER_ROOT = 'Shared server storage';
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
    { id: 'f_ops', host_id: HOST, parent_id: null, name: 'Operations', created_at_ms: now, updated_at_ms: now },
    { id: 'f_merges', host_id: HOST, parent_id: 'f_ops', name: 'Merges', created_at_ms: now, updated_at_ms: now },
    { id: 'f_reports', host_id: HOST, parent_id: null, name: 'Reports', created_at_ms: now, updated_at_ms: now },
  ],
  queries: [
    { id: 'q_parts', folder_id: 'f_ops', name: 'Active parts', description: 'Active data parts per table', sql: 'SELECT table, count() AS parts FROM system.parts WHERE active GROUP BY table ORDER BY parts DESC', host_id: HOST, created_at_ms: now, updated_at_ms: now },
    { id: 'q_merges', folder_id: 'f_merges', name: 'Running merges', description: 'What the merge pool is doing', sql: 'SELECT database, table, elapsed, progress FROM system.merges', host_id: HOST, created_at_ms: now, updated_at_ms: now },
    { id: 'q_answer', folder_id: null, name: 'The answer', description: '', sql: 'SELECT 42 AS answer', host_id: HOST, created_at_ms: now, updated_at_ms: now },
  ],
};

const panel = (page) => page.locator('#queryLibraryMenu');
const preview = (page) => page.locator('#queryLibraryPreview');
// The pane's foot (Load) and its tools (icon buttons of the head).
const previewAction = (page, action) => preview(page).locator(`.qlPreview__foot [data-action="${action}"]`);
const previewTool = (page, action) => preview(page).locator(`.qlPreview__tools [data-action="${action}"]`);
const footLabels = (page) => preview(page).locator('.qlPreview__foot .button');
const toolNames = (page) => preview(page).locator('.qlPreview__tools button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
const facts = (page) => preview(page).locator('.qlPreview__facts').evaluate((dl) => {
  const out = {};
  for (const dt of dl.querySelectorAll('dt')) out[dt.textContent] = dt.nextElementSibling.textContent;
  return out;
}).catch(() => ({}));

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

// The options of a folder picker, by root: { "<root label>": ["/", "/Ops"] }.
const pickerGroups = (select) => select.evaluate((el) => Object.fromEntries([...el.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)])));

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

// A History run carries no menu and no button: every action is in the preview, and none removes it.
async function expectNoItemMenu(page, item) {
  await expect(item.locator('button')).toHaveCount(0);
  await item.click({ button: 'right' });
  await expect(page.locator('#queryLibraryMenu [role=menu]')).toHaveCount(0);
}

// A row's "..." menu: its items, and the menu itself.
const rowMenu = (page) => page.locator('.qlMenu[role=menu]');
const menuLabels = (page) => rowMenu(page).locator('[role=menuitem] .runMenu__optText').allTextContents();
async function openRowMenu(page, name) {
  await node(page, name).locator(':scope > .qlRow').hover();
  await node(page, name).locator(':scope > .qlRow > [data-action="row-menu"]').click();
  await expect(rowMenu(page)).toBeVisible();
}
const footCount = (page) => page.locator('#queryLibraryViewSaved .qlFoot__count');
const newFolderInput = (page) => page.locator('#queryLibraryViewSaved .qlRow__input');

// --- Browser storage only (query_library disabled) ---------------------------

test('browser mode: one root, Local browser storage; the entries without a host are purged and chdash.savedQueries.v1 is not read', async ({ page }) => {
  const legacy = [{ name: 'Legacy flat', sql_raw: 'SELECT 1', host_id: HOST, created_at_ms: now - 1000 }];
  await seed(page, {
    'chdash.savedQueries.v1': legacy,
    'chdash.queryLibrary.importOffer.v1': { hosts: { [HOST]: { state: 'dismissed', at_ms: now } } },
    'chdash.queryLibrary.v2': {
      version: 2,
      revision: 4,
      folders: [
        { id: 'f_hostless', parent_id: null, name: 'Hostless folder' },
        { id: 'f_local', host_id: HOST, parent_id: null, name: 'Local folder' },
        { id: 'f_other', host_id: 'other', parent_id: null, name: 'Other folder' },
      ],
      queries: [
        { id: 'q_hostless', folder_id: null, name: 'Hostless query', sql: 'SELECT 2', host_id: null },
        { id: 'q_in_hostless', folder_id: 'f_hostless', name: 'Was in a hostless folder', sql: 'SELECT 3', host_id: HOST },
        { id: 'q_local', folder_id: 'f_local', name: 'Local query', sql: 'SELECT 4', host_id: HOST },
        { id: 'q_other', folder_id: 'f_other', name: 'Other query', sql: 'SELECT 5', host_id: 'other' },
      ],
    },
    'chdash.queryHistory.v1': [
      { ts_ms: now - 3000, sql_raw: 'SELECT \'hostless run\'', host_id: null, status: 'ok' },
      { ts_ms: now - 2000, sql_raw: 'SELECT \'local run\'', host_id: HOST, status: 'ok' },
      { ts_ms: now - 1000, sql_raw: 'SELECT \'other run\'', host_id: 'other', status: 'ok' },
    ],
  });
  await openLibrary(page);
  // One root: the server library is not enabled.
  await expect(tree(page).locator(':scope > li[role=treeitem]')).toHaveCount(1);
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-level', '1');
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, SERVER_ROOT)).toHaveCount(0);
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['local']);
  // Only the current host's entries; a query of a removed folder is at the top level of its root.
  await expect(node(page, 'Local folder')).toBeVisible();
  await expect(node(page, 'Was in a hostless folder')).toHaveAttribute('aria-level', '2');
  for (const gone of ['Hostless folder', 'Hostless query', 'Other folder', 'Other query', 'Legacy flat']) await expect(node(page, gone)).toHaveCount(0);
  await expect(footCount(page)).toHaveText(`2 queries \u00b7 ${HOST}`);
  // No import offer any more (and its stored state is removed).
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('chdash.queryLibrary.importOffer.v1'))).toBeNull();

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

test('confirm prompts: remove a query or a folder; Cancel, Escape and the backdrop keep everything', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const confirm = dialog(page);

  // Remove a query: the shared confirm, over the library, focus on Cancel.
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveClass(/uiDialog--sm/);
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Remove query');
  await expect(confirm.locator('.uiDialog__message')).toContainText('Remove \u201cThe answer\u201d? This cannot be undone.');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Remove' })).toHaveClass(/button--danger/);
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
  // Confirmed (from the preview's Remove), it goes.
  await previewTool(page, 'delete').click();
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page)).queries.map((q) => q.id).sort()).toEqual(['q_merges', 'q_parts']);
  // Its toast is shown in the top dialog (the page under it is inert).
  await expect(page.locator('#queryLibraryMenu > .qlToast')).toContainText('Query removed.');

  // Remove a non-empty folder: Escape keeps it.
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Remove folder');
  await expect(confirm).toContainText('2 queries and 1 subfolder');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'Operations')).toBeVisible();
  // An empty folder asks too (Delete key).
  await node(page, 'Reports').focus();
  await page.keyboard.press('Delete');
  await expect(confirm.locator('.uiDialog__message')).toHaveText('Remove the empty folder \u201cReports\u201d?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Reports')).toBeVisible();
  // A root is never removed: Delete on it does nothing.
  await node(page, LOCAL_ROOT).focus();
  await page.keyboard.press('Delete');
  await expect(confirm).toHaveCount(0);

  // The toast follows the page when the library closes.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.querySelector('.qlToast')?.parentElement === document.body)).toBe(true);
});

test('folders: named in place, nested, renamed in place, moved and removed; the picker writes folders as "/" paths under their root; a folder has a name and a place, nothing else', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] } });
  await openLibrary(page);
  // Nothing saved is the usual tree: the root, saying it is empty (no screen of its own).
  await expect(node(page, LOCAL_ROOT)).toBeVisible();
  await expect(node(page, LOCAL_ROOT).locator('.qlTree__empty')).toHaveText('Empty');
  await expect(tree(page)).not.toContainText('No saved queries');
  // One focus ring: the search field draws it, the input inside does not.
  const field = page.locator('#queryLibraryViewSaved .qlSearch');
  await field.locator('.qlSearch__input').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(field.locator('.qlSearch__input')).toBeFocused();
  const rings = await field.evaluate((el) => ({ field: getComputedStyle(el).boxShadow, input: getComputedStyle(el.querySelector('.qlSearch__input')).outlineColor }));
  expect(rings.field).not.toBe('none');
  expect(rings.input).toBe('rgba(0, 0, 0, 0)');

  // New folder: a row to type the name in, first in the root, focused. Escape drops it.
  const newFolder = page.locator('#queryLibraryViewSaved [data-action="new-folder"]');
  await newFolder.click();
  await expect(newFolderInput(page)).toBeFocused();
  await expect(page.locator('#queryLibraryViewSaved .qlRow__field')).not.toContainText('Description');
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page))?.folders || []).toEqual([]);
  // Enter makes it, and highlights it.
  await newFolder.click();
  await newFolderInput(page).fill('Monitoring');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Monitoring')).toBeVisible();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-level', '2');
  await expect(page.locator('.qlToast')).toContainText('Folder created.');
  expect((await libraryState(page)).folders.map((f) => Object.keys(f).sort())).toEqual([['created_at_ms', 'host_id', 'id', 'name', 'parent_id', 'updated_at_ms']]);

  // A duplicate name is refused in the row, case-insensitively, and the row stays to be corrected.
  await selectItem(page, LOCAL_ROOT);
  await newFolder.click();
  await newFolderInput(page).fill('monitoring');
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryLibraryViewSaved .qlRow__error')).toContainText('already exists');
  await expect(newFolderInput(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(newFolderInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);

  // A folder's preview: its path (root and folders), contents and tools (no foot, no Load).
  await selectItem(page, 'Monitoring');
  expect(await facts(page)).toEqual({ Path: `${LOCAL_ROOT} /Monitoring`, Contents: 'Empty' });
  expect(await toolNames(page)).toEqual(['Rename', 'Move to\u2026', 'New subfolder', 'Remove']);
  await expect(preview(page).locator('.qlPreview__foot')).toHaveCount(0);
  await expect(preview(page).locator('.qlPreview__description')).toHaveCount(0);
  // Its row's menu.
  await openRowMenu(page, 'Monitoring');
  expect(await menuLabels(page)).toEqual(['Open', 'Rename', 'Move to\u2026', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // New subfolder, from the preview: the folder opens and the new one is named in it.
  await previewTool(page, 'new-subfolder').click();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-expanded', 'true');
  await expect(newFolderInput(page)).toBeFocused();
  await newFolderInput(page).fill('Disks');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Disks')).toHaveAttribute('aria-level', '3');

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
  await expect(node(page, 'Free space')).toHaveAttribute('aria-level', '4');
  await expect(node(page, 'Free space')).toHaveAttribute('aria-selected', 'true');
  // No Folder line in a query's preview (the tree shows where it is).
  expect(Object.keys(await facts(page))).not.toContain('Folder');
  const disks = (await libraryState(page)).folders.find((f) => f.name === 'Disks');
  expect((await libraryState(page)).queries.find((q) => q.name === 'Free space').folder_id).toBe(disks.id);

  // Rename in place: F2 on the folder's row, or Rename in the preview; Escape keeps the name.
  await node(page, 'Monitoring').focus();
  await node(page, 'Monitoring').press('F2');
  await expect(newFolderInput(page)).toBeFocused();
  await expect(newFolderInput(page)).toHaveValue('Monitoring');
  await page.keyboard.press('Escape');
  await expect(node(page, 'Monitoring')).toBeVisible();
  await node(page, 'Monitoring').press('F2');
  await newFolderInput(page).fill('Health');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Health')).toBeVisible();
  await expect(node(page, 'Monitoring')).toHaveCount(0);
  await selectItem(page, 'Disks');
  await previewTool(page, 'rename').click();
  await newFolderInput(page).fill('Volumes');
  await newFolderInput(page).press('Enter');
  await expect(node(page, 'Volumes')).toBeVisible();

  // Move to... from the preview: to the top level ("/").
  await selectItem(page, 'Volumes');
  await previewTool(page, 'move').click();
  await expect(dialog(page).locator('select[name="target"] option')).toHaveText(['/', '/Health']);
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /.');
  await expect(node(page, 'Volumes')).toHaveAttribute('aria-level', '2');

  // Removing a non-empty folder asks first and removes everything inside.
  await selectItem(page, 'Volumes');
  await previewTool(page, 'delete').click();
  await expect(dialog(page)).toContainText('1 query');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Volumes')).toBeVisible();
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove all' }).click();
  await expect(node(page, 'Volumes')).toHaveCount(0);
  await selectItem(page, 'Health');
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(node(page, 'Health')).toHaveCount(0);
  const stored = await libraryState(page);
  expect(stored.folders).toEqual([]);
  expect(stored.queries).toEqual([]);
});

test('save, open, edit (name, description, SQL) and update the opened query with Ctrl+S; the foot is Load alone', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const editor = page.locator('#queryTextArea');

  // Save the editor with the panel's + button.
  await closePanel(page);
  await editor.fill('SELECT count() FROM system.tables');
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  // The Save window is wide: the fields beside the SQL they save.
  expect((await dialog(page).boundingBox()).width).toBeGreaterThan(800);
  await expect(dialog(page).locator('.qlForm--split .qlForm__fields')).toBeVisible();
  await expect(dialog(page).locator('[name="tags"]')).toHaveCount(0);
  await fillDialog(page, { name: 'Table count', description: 'How many tables', folder_id: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  await expect(node(page, 'Table count')).toBeVisible();
  let stored = await libraryState(page);
  const saved = stored.queries.find((q) => q.name === 'Table count');
  expect(saved).toMatchObject({ folder_id: 'f_reports', host_id: HOST, description: 'How many tables', sql: 'SELECT count() FROM system.tables' });

  // A click selects a query: the preview shows it, the editor is unchanged
  // and the dialog stays open. "Load" (bottom right) loads it,
  // closes the dialog and focuses the editor; the opened query is marked.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(node(page, 'The answer')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 42 AS answer');
  await expect(panel(page)).toBeVisible();
  await expect(editor).toHaveValue('SELECT count() FROM system.tables');
  // The tools are the head's icon buttons; the foot is "Load"
  // alone, at the bottom right: no Copy SQL, Append to editor or Run.
  expect(await toolNames(page)).toEqual(['Edit', 'Move to\u2026', 'Remove']);
  await expect(previewTool(page, 'delete')).toHaveClass(/qlPreview__tool--danger/);
  await expect(footLabels(page)).toHaveText(['Load']);
  await expect(preview(page).locator('[data-action="copy"], [data-action="append"], [data-action="run"]')).toHaveCount(0);
  await expect(preview(page)).not.toContainText(/Append to editor|Copy SQL/);
  const load = previewAction(page, 'load');
  await expect(load).toHaveClass(/button--primary/);
  await expect(load).toHaveAttribute('title', /^Load \((Ctrl|\u2318)\+Enter\)$/);
  const geometry = await page.evaluate(() => {
    const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
    const last = document.querySelector('#queryLibraryPreview .qlPreview__foot .button:last-child').getBoundingClientRect();
    return { right: Math.round(pane.right - last.right), bottom: Math.round(pane.bottom - last.bottom) };
  });
  expect(geometry.right).toBeLessThanOrEqual(20);
  expect(geometry.bottom).toBeLessThanOrEqual(20);
  // The row's menu: the same changes, and Load.
  await openRowMenu(page, 'The answer');
  expect(await menuLabels(page)).toEqual(['Load', 'Edit\u2026', 'Move to\u2026', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
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

  // Edit (the preview): name, description and the SQL taken from the editor.
  await closePanel(page);
  await editor.fill('SELECT 6 * 7 AS answer');
  await showPanel(page);
  await selectItem(page, 'The answer');
  await previewTool(page, 'edit').click();
  await expect(dialog(page).locator('[name="folder_id"] option:checked')).toHaveText('/');
  await fillDialog(page, { name: 'Answer', description: 'Douglas Adams' });
  await dialog(page).locator('[name="replace_sql"]').check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Answer')).toBeVisible();
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'Answer', description: 'Douglas Adams', sql: 'SELECT 6 * 7 AS answer', host_id: HOST });

  // Copy: the SQL block's own copy button.
  await captureCopies(page);
  const copy = preview(page).locator('.qlSql .sqlBlock__copy');
  await expect(copy).toHaveAttribute('aria-label', /^Copy /);
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  await expect.poll(() => copiedText(page)).toBe('SELECT 6 * 7 AS answer');
});

test('move: drag and drop into a folder, Move to\u2026 from the preview, no move into a descendant', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);

  // Drag the top-level query onto a folder.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast')).toContainText('Moved to /Reports');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');

  // Drag it back to the top level (onto its root).
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, LOCAL_ROOT).locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  // And again, then onto the tree background (the one root's top level).
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  const box = await tree(page).boundingBox();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(tree(page), { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');

  // Move to... a query: every folder as a path.
  await selectItem(page, 'The answer');
  await previewTool(page, 'move').click();
  await expect(dialog(page).locator('select[name="target"] option')).toHaveText(['/', '/Operations', '/Operations/Merges', '/Reports']);
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/Operations/Merges' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /Operations/Merges');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_merges');

  // Move to... a folder: its own subfolders are not offered.
  await selectItem(page, 'Operations');
  await previewTool(page, 'move').click();
  const target = dialog(page).locator('select[name="target"]');
  await expect(target.locator('option')).toHaveText(['/', '/Reports']);
  await target.selectOption({ label: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '3');
  const stored = await libraryState(page);
  expect(stored.folders.find((f) => f.id === 'f_ops').parent_id).toBe('f_reports');
  expect(stored.folders.find((f) => f.id === 'f_merges').parent_id).toBe('f_ops');
  // A root does not move: it is not draggable and has no Move tool.
  await selectItem(page, LOCAL_ROOT);
  await expect(node(page, LOCAL_ROOT)).not.toHaveAttribute('draggable', 'true');
  expect(await toolNames(page)).toEqual(['New folder']);
});

test('rows: the "..." menu and the right click act on one row: Load, Move to..., Remove; Show in folder', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await expandFolder(page, 'Operations');
  // The "..." button of a row opens its menu; the right click opens the same one under the pointer.
  await openRowMenu(page, 'Active parts');
  expect(await menuLabels(page)).toEqual(['Load', 'Edit\u2026', 'Move to\u2026', 'Remove']);
  await page.keyboard.press('Escape');
  await node(page, 'Operations').locator(':scope > .qlRow').click({ button: 'right' });
  await expect(rowMenu(page)).toBeVisible();
  expect(await menuLabels(page)).toEqual(['Close', 'Rename', 'Move to\u2026', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  // No tick box and no bar: a row is changed one at a time.
  await expect(page.locator('#queryLibraryViewSaved .qlRow__check, #queryLibraryViewSaved .qlRow__box, #queryLibraryViewSaved .ql__bar')).toHaveCount(0);
  // The menu acts: Load fills the editor and closes the dialog.
  await openRowMenu(page, 'Active parts');
  await rowMenu(page).getByRole('menuitem', { name: /^Load/ }).click();
  await expect(page.locator('#queryTextArea')).toHaveValue(/FROM system\.parts/);
  await expect(panel(page)).toBeHidden();
  await showPanel(page);
  // Move to... opens the picker for this row; Remove asks first.
  await expandFolder(page, 'Operations');
  await openRowMenu(page, 'The answer');
  await rowMenu(page).getByRole('menuitem', { name: /^Move to/ }).click();
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect.poll(async () => (await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');
  await expandFolder(page, 'Reports');
  await openRowMenu(page, 'The answer');
  await rowMenu(page).getByRole('menuitem', { name: /^Remove/ }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Remove query');
  await dialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);

  // A search result: its menu has Show in folder, which leaves the search and opens its folders.
  await page.locator('#queryLibraryViewSaved .qlSearch__input').fill('merges');
  await expect(tree(page).locator('li.qlNode')).toHaveCount(1);
  await openRowMenu(page, 'Running merges');
  expect(await menuLabels(page)).toEqual(['Load', 'Show in folder', 'Edit\u2026', 'Move to\u2026', 'Remove']);
  await rowMenu(page).getByRole('menuitem', { name: 'Show in folder' }).click();
  await expect(page.locator('#queryLibraryViewSaved .qlSearch__input')).toHaveValue('');
  await expect(node(page, 'Running merges')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'Running merges')).toHaveAttribute('aria-level', '4');
});

test('search covers names, descriptions and SQL; the preview shows the description, "Updated ..." beside the title and the highlighted SQL, never a Folder line', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const search = page.locator('#queryLibraryViewSaved .qlSearch__input');
  const results = tree(page).locator('li[role=treeitem]');

  await search.fill('merge pool');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('Running merges');
  await expect(results.first().locator('.qlRow__path')).toHaveText(`${LOCAL_ROOT} /Operations/Merges`);

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
  // A click selects: name, then "Updated ..." on its line (ns.format time,
  // its ISO value in the tooltip), the description and the SQL
  // with keyword highlighting; no Folder line.
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Active parts');
  await expect(pane.locator('.qlPreview__head .qlPreview__meta')).toHaveText(/^Updated Oct 1(, 2026)? 12:00:00$/);
  await expect(pane.locator('.qlPreview__meta time')).toHaveAttribute('datetime', '2026-10-01T12:00:00.000Z');
  await expect(pane.locator('.qlPreview__description')).toHaveText('Active data parts per table');
  await expect(pane.locator('.qlPreview__facts')).toHaveCount(0);
  await expect(pane).not.toContainText('Folder');
  await expect(pane.locator('.qlSql')).toContainText('FROM system.parts');
  await expect(pane.locator('.qlSql .sqlBlock__code span').first()).toBeVisible();
  await expect(pane.locator('.qlTag, .qlPreview__tags')).toHaveCount(0);
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
  const answer = node(page, 'The answer').locator(':scope > .qlRow');
  await answer.hover();
  // The row shows its hover (its handlers have run), then two frames.
  await expect.poll(() => answer.evaluate((el) => el.matches(':hover'))).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(pane.locator('.qlPreview__title')).toHaveText('Active parts');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('The answer');
  await expect(pane.locator('.qlPreview__description')).toHaveCount(0);
  await expect(pane.locator('.qlPreview__facts')).toHaveCount(0);
  // A selected folder shows its path and contents, with its tools: a folder has no description.
  await node(page, 'Operations').locator(':scope > .qlRow .qlRow__name').click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'false');
  await expect(pane.locator('.qlPreview__title')).toHaveText('Operations');
  await expect(pane.locator('.qlPreview__meta')).toHaveText(/^Updated /);
  await expect(pane.locator('.qlPreview__description')).toHaveCount(0);
  expect(await facts(page)).toEqual({ Path: `${LOCAL_ROOT} /Operations`, Contents: '2 queries \u00b7 1 subfolder' });
  await expect(pane.locator('.qlPreview__foot')).toHaveCount(0);
  expect(await toolNames(page)).toHaveLength(4);
  // A renamed query stays selected and previewed under its new name.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await node(page, 'The answer').press('F2');
  await fillDialog(page, { name: 'Answer' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('Answer');
  await expect(node(page, 'Answer')).toHaveAttribute('aria-selected', 'true');
});

test('the preview head: title, then its meta, then the tools as icon buttons at the right end of the same line; Saved and History alike', async ({ page }) => {
  await seed(page, {
    'chdash.queryLibrary.v2': LIBRARY,
    'chdash.queryHistory.v1': [{ ts_ms: now, sql_raw: 'SELECT 1 AS one', host_id: HOST, status: 'ok', elapsed_ms: 4, rows: 1 }],
  });
  await openLibrary(page);
  const icons = { edit: 'pencil', move: 'folder-symlink', delete: 'trash', rename: 'pencil', 'new-subfolder': 'folder-plus', save: 'device-floppy', remove: 'trash' };
  const head = (page) => page.evaluate(() => {
    const pane = document.getElementById('queryLibraryPreview');
    const box = (el) => el.getBoundingClientRect();
    const head = pane.querySelector('.qlPreview__head');
    const title = head.querySelector('.qlPreview__title');
    const meta = head.querySelector('.qlPreview__meta');
    const tools = head.querySelector('.qlPreview__tools');
    const mid = (el) => box(el).top + box(el).height / 2;
    const content = box(pane.querySelector('.qlPreview__content'));
    const paddingRight = parseFloat(getComputedStyle(pane.querySelector('.qlPreview__content')).paddingRight);
    return {
      order: [...head.children].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.className.split(' ')[0]),
      oneLine: [title, meta, tools].every((el) => Math.abs(mid(el) - mid(title)) <= 3),
      metaRightOfTitle: box(meta).left >= box(title).right - 0.5,
      toolsAtRightEnd: Math.abs(box(tools).right - (content.right - paddingRight)) <= 2,
      toolsRightOfMeta: box(tools).left >= box(meta).right,
      buttons: [...tools.querySelectorAll('button')].map((b) => ({
        action: b.dataset.action,
        label: b.getAttribute('aria-label'),
        title: b.title,
        text: b.textContent.trim(),
        icon: b.querySelector('svg.icon use')?.getAttribute('href')?.replace(/^.*#i-/, '') || '',
      })),
    };
  });
  const check = (shape) => {
    expect(shape.order).toEqual(['qlPreview__title', 'qlPreview__meta', 'qlPreview__tools']);
    expect(shape).toMatchObject({ oneLine: true, metaRightOfTitle: true, toolsAtRightEnd: true, toolsRightOfMeta: true });
    for (const button of shape.buttons) {
      // Icon only: no text, a label and the same tooltip, the sprite's drawing.
      expect(button.text).toBe('');
      expect(button.label).toBeTruthy();
      expect(button.title).toBe(button.label);
      expect(button.icon).toBe(icons[button.action]);
    }
  };
  // A saved query.
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').click();
  let shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['edit', 'move', 'delete']);
  // A folder.
  await selectItem(page, 'Operations');
  shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['rename', 'move', 'new-subfolder', 'delete']);
  // The lists' heads: the same search row, the same place (Saved now, History below).
  const listHead = (tab) => page.evaluate((name) => {
    const head = document.querySelector(`#queryLibraryView${name} .ql__head`);
    const box = head.querySelector('.qlSearch').getBoundingClientRect();
    return { classes: [...head.children].map((el) => el.className.split(' ')[0]), search: [Math.round(box.x), Math.round(box.y), Math.round(box.height)] };
  }, tab);
  const savedHead = await listHead('Saved');
  // A History run: the same head, its meta the run's time and status.
  await showPanel(page, 'history');
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['save']);
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('SELECT 1 AS one');
  await expect(preview(page).locator('.qlPreview__meta')).toHaveText(/^Oct 1(, 2026)? \d\d:\d\d:\d\d \u00b7 Succeeded$/);
  await expect(preview(page).locator('.qlPreview__meta .qhItem__status--ok')).toHaveCount(1);
  const historyHead = await listHead('History');
  expect(historyHead.classes).toEqual(savedHead.classes);
  expect(historyHead.search.slice(0, 2)).toEqual(savedHead.search.slice(0, 2));
  expect(historyHead.search[2]).toBe(savedHead.search[2]);
});

test('the SQL preview shows the line-number gutter when the editor shows line numbers, and none when they are off', async ({ page }) => {
  const multiline = { ...LIBRARY.queries[2], id: 'q_lines', name: 'Three lines', sql: 'SELECT 1\nUNION ALL\nSELECT 2' };
  await seed(page, { 'chdash.queryLibrary.v2': { ...LIBRARY, queries: [...LIBRARY.queries, multiline] } });
  await openLibrary(page);
  // On by default (the editor's setting, chdash.editor.line_numbers.enabled).
  await node(page, 'Three lines').locator(':scope > .qlRow').click();
  const block = preview(page).locator('.qlSql');
  await expect(block).toHaveClass(/sqlBlock--gutter/);
  await expect(block.locator('.sqlBlock__gutter')).toHaveText('1\n2\n3');
  // Each number on its line: the lines scroll rather than wrap.
  await expect(block).not.toHaveClass(/sqlBlock--wrap/);
  // Off in the editor's settings: no gutter (the lines wrap).
  await closePanel(page);
  await page.locator('.editorAutocompleteControl__button').click();
  const item = page.locator('.editorAutocompleteControl__menu [data-line-numbers-toggle]');
  await expect(item).toHaveAttribute('aria-checked', 'true');
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chdash.editor.line_numbers.enabled'))).toMatch(/^(false|0)$/);
  await showPanel(page);
  await node(page, 'Three lines').locator(':scope > .qlRow').click();
  await expect(block.locator('.sqlBlock__gutter')).toHaveCount(0);
  await expect(block).not.toHaveClass(/sqlBlock--gutter/);
  await expect(block).toHaveClass(/sqlBlock--wrap/);
  // Remembered: still off after a reload.
  await page.reload();
  await showPanel(page);
  await node(page, 'Three lines').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlSql .sqlBlock__gutter')).toHaveCount(0);
});

test('keyboard: tabs, tree navigation and selection, expand / collapse, the row menu, preview and load, rename and remove', async ({ page }) => {
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

  // Arrow keys move the selection along the visible items, the root first;
  // the preview follows.
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe(LOCAL_ROOT);
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(LOCAL_ROOT);
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
  expect(await focused()).toBe(LOCAL_ROOT);
  // A root closes and opens like a folder.
  await page.keyboard.press('ArrowLeft');
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-expanded', 'false');
  await expect(node(page, 'Operations')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-expanded', 'true');
  // Type-ahead.
  await page.keyboard.press('t');
  expect(await focused()).toBe('The answer');

  // F2 edits; Enter submits.
  await page.keyboard.press('F2');
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Edit query');
  await fillDialog(page, { name: 'Answer 42' });
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toBeVisible();

  // The row's menu from the keyboard: Shift+F10 or the context-menu key; its first item has the focus,
  // the arrows move in it, Escape closes it and gives the focus back to the row.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Shift+F10');
  await expect(rowMenu(page)).toBeVisible();
  await expect(rowMenu(page).locator('[role=menuitem]').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rowMenu(page).locator('[role=menuitem]').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect(await focused()).toBe('Answer 42');
  await page.keyboard.press('ContextMenu');
  await expect(rowMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);

  // Space opens or closes a folder, and does nothing on a query.
  await node(page, 'Reports').focus();
  await page.keyboard.press('Space');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'false');
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Space');
  await expect(panel(page)).toBeVisible();

  // Enter moves to the preview, on "Load"; Shift+Tab reaches its
  // other controls and Tab comes back; Enter there loads the query and closes the panel.
  await page.keyboard.press('Enter');
  await expect(previewAction(page, 'load')).toBeFocused();
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Answer 42');
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#queryLibraryPreview'))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(previewAction(page, 'load')).toBeFocused();
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
  await previewTool(page, 'edit').focus();
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

  // F2 on a folder renames it in its row.
  await page.keyboard.press('F2');
  await expect(newFolderInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);

  // Delete asks, Enter confirms.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Delete');
  await expect(dialog(page)).toContainText('Remove \u201cAnswer 42\u201d');
  await dialog(page).getByRole('button', { name: 'Remove' }).focus();
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

test('history groups runs by day with status, elapsed time and rows; the preview loads and saves, never removes; search; no Clear history', async ({ page }) => {
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
  // No Clear history anywhere: the foot is the count line alone.
  await expect(page.locator('#queryLibraryMenu .qh__clear, #queryLibraryMenu .qh__footBar')).toHaveCount(0);
  await expect(page.locator('#queryLibraryMenu').getByRole('button', { name: /clear/i })).toHaveCount(0);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot button')).toHaveCount(0);

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

  // A click selects a run: the head shows its SQL, then its time and
  // status; its elapsed time, rows and SQL below, with its tools (Save to
  // library, Remove) and "Load" alone in the foot.
  const pane = preview(page);
  await failed.click();
  await ok.click();
  await expect(ok).toHaveAttribute('aria-selected', 'true');
  await expect(pane.locator('.qlPreview__title')).toHaveText('SELECT number FROM numbers(7)');
  await expect(pane.locator('.qlPreview__meta')).toHaveText(/^[A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \u00b7 Succeeded$/);
  await expect(pane.locator('.qlPreview__meta .qhItem__status--ok')).toHaveCount(1);
  const shown = await facts(page);
  expect(Object.keys(shown)).toEqual(['Elapsed', 'Rows']);
  expect(shown.Elapsed).toMatch(/^\d+(\.\d+)? (ns|\u00b5s|ms|s)$/);
  expect(shown.Rows).toBe('7');
  await expect(pane.locator('.qlSql')).toContainText('numbers(7)');
  expect(await toolNames(page)).toEqual(['Save to library\u2026']);
  // History is the browser's record of what ran: no run can be removed, by tool or by key.
  await expect(previewTool(page, 'remove')).toHaveCount(0);
  const runs = await page.locator('.qhItem').count();
  await ok.focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.qhItem')).toHaveCount(runs);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryHistory.v1') || '[]').length)).toBeGreaterThanOrEqual(runs);
  await expect(footLabels(page)).toHaveText(['Load']);
  await expect(panel(page)).toBeVisible();
  // The failed run's preview shows the server error.
  await failed.click();
  await expect(pane.locator('.qlPreview__meta')).toContainText('Failed');
  await expect(pane.locator('.qlPreview__error')).toContainText(/__missing_history_table/);
  // Arrows move the selection, the preview follows.
  await page.keyboard.press('ArrowDown');
  await expect(ok).toBeFocused();
  await expect(pane.locator('.qlPreview__meta')).toContainText('Succeeded');

  // Copy: the SQL block's own button.
  await captureCopies(page);
  await pane.locator('.qlSql .sqlBlock__copy').click();
  await expect.poll(() => copiedText(page)).toContain('numbers(7)');

  // Search.
  const search = page.locator('#queryLibraryViewHistory .qlSearch__input');
  await search.fill('older');
  await expect(items).toHaveCount(1);
  await search.fill('');
  await expect(items).toHaveCount(4);

  // Load: the SQL, no run, the panel closes.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).click();
  await previewAction(page, 'load').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT \'older\' AS tag');
  await expect(page.locator('#queryTextArea')).toBeFocused();

  // Save to library from the History preview.
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).click();
  await previewTool(page, 'save').click();
  await expect(dialog(page)).toContainText('SQL (from History)');
  expect(await pickerGroups(dialog(page).locator('[name="folder_id"]'))).toEqual({ [LOCAL_ROOT]: ['/'] });
  await fillDialog(page, { name: 'Older one' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  // The dialog's submit is asynchronous (validation, then the adapter's write).
  await expect.poll(async () => (await libraryState(page)).queries.map((q) => [q.sql, q.host_id])).toEqual([['SELECT \'older\' AS tag', HOST]]);

  // No removal: neither the preview nor the Delete key takes a run out of History.
  await items.filter({ hasText: 'oldest' }).click();
  await expect(previewTool(page, 'remove')).toHaveCount(0);
  await items.filter({ hasText: 'older' }).focus();
  await page.keyboard.press('Delete');
  await expect(items.filter({ hasText: 'older' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'oldest' })).toHaveCount(1);
  expect((await historyState(page)).some((h) => h.sql_raw.includes('oldest'))).toBe(true);
  // Keyboard: Enter moves to the preview's Load.
  await items.first().focus();
  await page.keyboard.press('Enter');
  await expect(previewAction(page, 'load')).toBeFocused();
});

test('per host: the library and the History follow a host switch, live; saves and runs belong to the selected host', async ({ page }) => {
  await addSecondHost(page);
  const other = (q) => ({ ...q, host_id: 'other' });
  await seed(page, {
    'chdash.selectedHost': HOST,
    'chdash.queryLibrary.v2': {
      ...LIBRARY,
      folders: [...LIBRARY.folders, other({ id: 'f_other', parent_id: null, name: 'Other ops' })],
      queries: [...LIBRARY.queries, other({ id: 'q_other', folder_id: 'f_other', name: 'Other query', description: '', sql: 'SELECT \'other\'' }),
        other({ id: 'q_other_top', folder_id: null, name: 'The answer', description: 'same name, other host', sql: 'SELECT 43' })],
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
  await expect(preview(page).locator('.qlSql')).toContainText('SELECT 42 AS answer');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on local/]);

  // Switch the host in the header: the library shows the other host's.
  await closePanel(page);
  await pickHost(page, 'other');
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await expect(node(page, 'Operations')).toHaveCount(0);
  await expect(footCount(page)).toContainText('2 queries \u00b7 other');
  // The selection was the other host's: nothing is previewed.
  await expect(preview(page).locator('.qlPreview__empty')).toBeVisible();
  await selectItem(page, 'The answer');
  await expect(preview(page).locator('.qlSql')).toContainText('SELECT 43');
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
});

test('the library opens in the profiling dialog: same shell, size and tabs, the tabs in the head instead of a title; Escape, backdrop and close; focus in, trapped and back', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const button = page.locator('#queryLibraryButton');
  // An icon button like Format, between Format and the run settings cog.
  await expect(button).toHaveAttribute('aria-label', 'Query library');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  // The open-book icon (the sprite's book, like the Format icon).
  await expect(button.locator('.queryLibraryButton__icon')).toBeVisible();
  await expect(button.locator('.queryLibraryButton__icon use')).toHaveAttribute('href', /#i-book$/);
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
  await footCount(page).click();
  const foot = await footCount(page).boundingBox();
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
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewTool(page, 'move').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('[name="target"]')).toBeFocused();
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
  expect(await page.evaluate(() => [...document.querySelectorAll('dialog:modal')].map((d) => d.id || d.className))).toEqual(['queryLibraryMenu', 'uiDialog uiDialog--sm qlDialog qlDialog--wide']);
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


test('a long query in a preview (Saved or History) scrolls inside its block, both ways with the line numbers; a short one keeps its height', async ({ page }) => {
  const long = Array.from({ length: 70 }, (_, i) => `SELECT column_${i}, other_${i} FROM database_${i}.table_${i} WHERE x = ${i} -- ${'y'.repeat(120)}`).join('\n');
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [
      { id: 'q_long', folder_id: null, name: 'Long one', description: '', sql: long, host_id: HOST },
      { id: 'q_short', folder_id: null, name: 'Short one', description: '', sql: 'SELECT 1', host_id: HOST },
    ] },
    'chdash.queryHistory.v1': [{ ts_ms: now, sql_raw: long, host_id: HOST, status: 'ok', elapsed_ms: 4, rows: 1 }],
    'chdash.editor.line_numbers.enabled': '1',
  });
  await openLibrary(page);
  const block = preview(page).locator('.qlSql .sqlBlock__body');
  const scrolls = async () => {
    const before = await block.evaluate((el) => ({ client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] }));
    // The block fits in the pane (it does not push the pane's content out) and has more to show.
    expect(before.scroll[1]).toBeGreaterThan(before.client[1] * 2);
    expect(before.scroll[0]).toBeGreaterThan(before.client[0]); // the line numbers keep each line on one row
    const box = await preview(page).locator('.qlSql').boundingBox();
    const pane = await preview(page).locator('.qlPreview__content').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    await block.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => block.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    await page.mouse.wheel(300, 0);
    await expect.poll(() => block.evaluate((el) => el.scrollLeft)).toBeGreaterThan(50);
  };
  await selectItem(page, 'Long one');
  await scrolls();
  // The copy button sits left of the body's scrollbar, not over it.
  const clear = await preview(page).locator('.qlSql').evaluate((el) => {
    const body = el.querySelector('.sqlBlock__body').getBoundingClientRect();
    const bar = el.querySelector('.sqlBlock__body').offsetWidth - el.querySelector('.sqlBlock__body').clientWidth;
    return { bar, gap: body.right - bar - el.querySelector('.sqlBlock__copy').getBoundingClientRect().right };
  });
  expect(clear.gap).toBeGreaterThanOrEqual(0);
  // A short query is as tall as its line: the block is not stretched to the pane.
  await selectItem(page, 'Short one');
  expect(await block.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect((await preview(page).locator('.qlSql').boundingBox()).height).toBeLessThan(80);
  // The History's preview is the same block.
  await page.locator('#queryLibraryTabHistory').click();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  await scrolls();
});

// --- Server storage (mocked API) ----------------------------------------------

// An in-memory /api/query-library: per-host reads (host_id required),
// writes stamped with their host, revision, If-Match conflicts, read-only,
// the import's copy mode (a folder moved in from the browser's root). It has
// no history route: the History is the browser's.
async function mockServerLibrary(page, { writable = true, conflicts = 0, library = LIBRARY } = {}) {
  const server = {
    revision: 10,
    folders: structuredClone(library.folders),
    queries: structuredClone(library.queries),
    requests: [],
    conflicts,
  };
  let seq = 0;
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const missingHost = (route) => json(route, 400, { error: 'validation', error_code: 'validation', field: 'host_id', reason: 'required', message: 'host_id is required' });
  const duplicate = (route, field) => json(route, 400, { error: 'validation', error_code: 'validation', field, reason: 'duplicate', message: 'the name already exists there' });
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features = { ...(body.features || {}), query_library: { enabled: true, writable } };
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
        host_id: host, revision: server.revision, updated_at_ms: now, writable, load_error: null,
        folders: server.folders.filter((f) => f.host_id === host), queries: server.queries.filter((q) => q.host_id === host),
      });
    }
    // The server has no history: a page asking for one is a bug.
    if (path.startsWith('/history')) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'no such route' });
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
    const clash = (list, hostId, key, parent, name) => list.some((x) => x.host_id === hostId && (x[key] || null) === (parent || null) && x.name.toLowerCase() === String(name).toLowerCase());
    let m;
    if (method === 'POST' && path === '/folders') {
      if (!body.host_id) return missingHost(route);
      if (clash(server.folders, body.host_id, 'parent_id', body.parent_id, body.name)) return duplicate(route, 'name');
      const folder = { id: `f_s${++seq}`, host_id: body.host_id, parent_id: body.parent_id || null, name: body.name, created_at_ms: now, updated_at_ms: now };
      server.folders.push(folder);
      bump();
      return json(route, 201, { ...folder, revision: server.revision });
    }
    if (method === 'POST' && path === '/queries') {
      if (!body.host_id) return missingHost(route);
      if (clash(server.queries, body.host_id, 'folder_id', body.folder_id, body.name)) return duplicate(route, 'name');
      const query = { id: `q_s${++seq}`, description: '', ...body, created_at_ms: now, updated_at_ms: now };
      server.queries.push(query);
      bump();
      return json(route, 201, { ...query, revision: server.revision });
    }
    if (method === 'POST' && path === '/import') {
      if (!body.host_id) return missingHost(route);
      const ids = {};
      const known = (id) => (server.folders.some((f) => f.id === id && f.host_id === body.host_id) ? id : null);
      for (const f of body.folders || []) {
        const parent = ids[f.parent_id] || known(f.parent_id);
        if (body.copy && clash(server.folders, body.host_id, 'parent_id', parent, f.name)) return duplicate(route, 'folders[0].name');
        const folder = { id: `f_s${++seq}`, host_id: body.host_id, parent_id: parent, name: f.name, created_at_ms: now, updated_at_ms: now };
        ids[f.id] = folder.id;
        server.folders.push(folder);
      }
      for (const q of body.queries || []) server.queries.push({ id: `q_s${++seq}`, description: '', ...q, host_id: body.host_id, folder_id: ids[q.folder_id] || known(q.folder_id), created_at_ms: now, updated_at_ms: now });
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

const MINE = { version: 2, revision: 1, folders: [], queries: [{ id: 'q_mine', folder_id: null, name: 'Mine', sql: 'SELECT 1', host_id: HOST, created_at_ms: now, updated_at_ms: now }] };

test('server storage enabled: two roots, Shared server storage then Local browser storage, both browsable; the pickers offer both', async ({ page }) => {
  await mockServerLibrary(page, { writable: true });
  await seed(page, { 'chdash.queryLibrary.v2': MINE });
  await openLibrary(page);
  const roots = tree(page).locator(':scope > li[role=treeitem]');
  await expect(roots).toHaveCount(2);
  await expect(roots.locator(':scope > .qlRow .qlRow__name')).toHaveText([SERVER_ROOT, LOCAL_ROOT]);
  await expect(roots.nth(0)).toHaveAttribute('data-store', 'server');
  await expect(roots.nth(1)).toHaveAttribute('data-store', 'local');
  await expect(roots.nth(0).locator(':scope > .qlRow .qlIcon use')).toHaveAttribute('href', /#i-database$/);
  await expect(roots.nth(1).locator(':scope > .qlRow .qlIcon use')).toHaveAttribute('href', /#i-device-desktop$/);
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['server', 'local']);
  // Both open: the server's folders and queries, and the browser's.
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'The answer')).toHaveAttribute('data-store', 'server');
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'local');
  // Each root counts its queries; the foot counts both.
  await expect(roots.nth(0).locator(':scope > .qlRow .qlRow__count')).toHaveText('3');
  await expect(roots.nth(1).locator(':scope > .qlRow .qlRow__count')).toHaveText('1');
  await expect(footCount(page)).toHaveText(`4 queries · ${HOST}`);
  // A root's preview: what it is, its contents, New folder as its one tool.
  await selectItem(page, SERVER_ROOT);
  await expect(preview(page).locator('.qlPreview__description')).toContainText('Shared by everyone');
  await expect(preview(page).locator('.qlPreview__meta')).toHaveText('3 queries · 3 subfolders');
  expect(await toolNames(page)).toEqual(['New folder']);
  await selectItem(page, LOCAL_ROOT);
  await expect(preview(page).locator('.qlPreview__description')).toContainText('Only this browser');
  // A root closes and opens; its state is remembered.
  await node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(node(page, SERVER_ROOT)).toHaveAttribute('aria-expanded', 'false');
  await expect(node(page, 'Operations')).toHaveCount(0);
  await page.reload();
  await showPanel(page);
  await expect(node(page, SERVER_ROOT)).toHaveAttribute('aria-expanded', 'false');
  await node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(node(page, 'Operations')).toBeVisible();
  // The save picker: both roots, each with its folders; the server's first.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 2 AS two');
  await page.locator('#queryTextArea').press('Control+s');
  expect(await pickerGroups(dialog(page).locator('[name="folder_id"]'))).toEqual({
    [SERVER_ROOT]: ['/', '/Operations', '/Operations/Merges', '/Reports'],
    [LOCAL_ROOT]: ['/'],
  });
  // Into the browser's root.
  await fillDialog(page, { name: 'Two' });
  await dialog(page).locator('[name="folder_id"]').selectOption('local:');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.map((q) => q.name).sort()).toEqual(['Mine', 'Two']);
  // A search covers both roots, each result names its root.
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved .qlSearch__input').fill('SELECT');
  await expect(tree(page).locator('.qlRow__path')).toContainText([`${SERVER_ROOT} /Operations`]);
  await expect(tree(page).locator('li[role=treeitem]').filter({ hasText: 'Mine' }).locator('.qlRow__path')).toHaveText(`${LOCAL_ROOT} /`);
});

test('a move between the roots copies into the target, then removes from the source: queries and folders, both ways', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true });
  await seed(page, {
    'chdash.queryLibrary.v2': {
      version: 2, revision: 1,
      folders: [
        { id: 'f_local', host_id: HOST, parent_id: null, name: 'Local folder', created_at_ms: now, updated_at_ms: now },
        { id: 'f_local_sub', host_id: HOST, parent_id: 'f_local', name: 'Sub', created_at_ms: now, updated_at_ms: now },
      ],
      queries: [
        { id: 'q_mine', folder_id: null, name: 'Mine', sql: 'SELECT 1', host_id: HOST, description: 'one', created_at_ms: now, updated_at_ms: now },
        { id: 'q_in_local', folder_id: 'f_local', name: 'In local', sql: 'SELECT 11', host_id: HOST, created_at_ms: now, updated_at_ms: now },
        { id: 'q_in_sub', folder_id: 'f_local_sub', name: 'In sub', sql: 'SELECT 12', host_id: HOST, created_at_ms: now, updated_at_ms: now },
      ],
    },
  });
  await openLibrary(page);

  // A query, browser -> server, from Move to...: the picker shows both roots.
  await selectItem(page, 'Mine');
  await previewTool(page, 'move').click();
  const target = dialog(page).locator('select[name="target"]');
  expect(await pickerGroups(target)).toEqual({ [SERVER_ROOT]: ['/', '/Operations', '/Operations/Merges', '/Reports'], [LOCAL_ROOT]: ['/', '/Local folder', '/Local folder/Sub'] });
  await target.selectOption({ label: '/Operations' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${SERVER_ROOT} /Operations.`);
  const copied = server.queries.find((q) => q.name === 'Mine');
  expect(copied).toMatchObject({ host_id: HOST, folder_id: 'f_ops', sql: 'SELECT 1', description: 'one' });
  expect(server.requests.find((r) => r.method === 'POST' && r.path === '/queries').ifMatch).toBe('10');
  expect((await libraryState(page)).queries.map((q) => q.id)).not.toContain('q_mine');
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'server');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-level', '3');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-selected', 'true');

  // A query, server -> browser, by drag and drop onto the browser's root.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, LOCAL_ROOT).locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${LOCAL_ROOT} /.`);
  expect(server.queries.find((q) => q.id === 'q_answer')).toBeUndefined();
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/queries/q_answer')).toBe(true);
  expect((await libraryState(page)).queries.find((q) => q.name === 'The answer')).toMatchObject({ folder_id: null, sql: 'SELECT 42 AS answer', host_id: HOST });
  await expect(node(page, 'The answer')).toHaveAttribute('data-store', 'local');

  // A folder with everything in it, browser -> server: one copy request
  // (POST /import, copy mode) under the target folder, then the browser's goes.
  await selectItem(page, 'Local folder');
  await previewTool(page, 'move').click();
  await dialog(page).locator('select[name="target"]').selectOption({ label: '/Reports' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${SERVER_ROOT} /Reports.`);
  const call = server.requests.find((r) => r.method === 'POST' && r.path === '/import');
  expect(call.body).toMatchObject({ host_id: HOST, copy: true });
  expect(call.body.folders).toEqual([
    { id: 'f_local', parent_id: 'f_reports', name: 'Local folder' },
    { id: 'f_local_sub', parent_id: 'f_local', name: 'Sub' },
  ]);
  expect(call.body.queries.map((q) => [q.name, q.folder_id])).toEqual([['In local', 'f_local'], ['In sub', 'f_local_sub']]);
  const moved = server.folders.find((f) => f.name === 'Local folder');
  expect(moved.parent_id).toBe('f_reports');
  expect(server.queries.find((q) => q.name === 'In sub').folder_id).toBe(server.folders.find((f) => f.name === 'Sub').id);
  expect((await libraryState(page)).folders).toEqual([]);
  await expect(node(page, 'Local folder')).toHaveAttribute('data-store', 'server');

  // A folder, server -> browser (Operations, with Merges and two queries).
  await selectItem(page, 'Operations');
  await previewTool(page, 'move').click();
  await dialog(page).locator('select[name="target"]').selectOption('local:');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${LOCAL_ROOT} /.`);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/folders/f_ops?recursive=1')).toBe(true);
  const local = await libraryState(page);
  const ops = local.folders.find((f) => f.name === 'Operations');
  expect(ops).toMatchObject({ parent_id: null, host_id: HOST });
  expect(ops).not.toHaveProperty('description');
  expect(local.folders.find((f) => f.name === 'Merges').parent_id).toBe(ops.id);
  expect(local.queries.filter((q) => q.name === 'Active parts' || q.name === 'Running merges' || q.name === 'Mine')).toHaveLength(3);
  expect(server.folders.map((f) => f.name).sort()).toEqual(['Local folder', 'Reports', 'Sub']);

  // A clash in the target is refused in the dialog; nothing is copied or removed.
  await selectItem(page, SERVER_ROOT);
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('Operations');
  await page.keyboard.press('Enter');
  await expect(tree(page).locator('li[data-store="server"][data-kind="folder"]').filter({ has: page.locator(':scope > .qlRow .qlRow__name', { hasText: /^Operations$/ }) })).toHaveCount(1);
  const requests = server.requests.length;
  const localOps = tree(page).locator('li[data-store="local"][data-kind="folder"]').filter({ has: page.locator(':scope > .qlRow .qlRow__name', { hasText: /^Operations$/ }) });
  await localOps.focus();
  await previewTool(page, 'move').click();
  await dialog(page).locator('select[name="target"]').selectOption('server:');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  expect(server.requests.slice(requests).filter((r) => r.method !== 'GET')).toEqual([]);
  expect((await libraryState(page)).folders.some((f) => f.name === 'Operations')).toBe(true);
});

test('server storage: changes go through the API with If-Match; a conflict reloads and retries once', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true, conflicts: 1 });
  await seed(page, { 'chdash.queryLibrary.v2': null });
  await openLibrary(page);
  await expect(footCount(page)).toContainText(`queries · ${HOST}`);
  await expect(page.locator('#queryLibraryViewSaved .qlBadge--readonly')).toHaveCount(0);
  await expect(node(page, 'Operations')).toBeVisible();
  // Every read names the host.
  expect(server.requests.filter((r) => r.method === 'GET').every((r) => new URL(`http://x${r.path}`).searchParams.get('host_id') === HOST)).toBe(true);

  // Create (into the server's root, the default): the first attempt
  // conflicts, the library is reloaded, the retry wins.
  await selectItem(page, SERVER_ROOT);
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('Shared');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Shared')).toBeVisible();
  const writes = server.requests.filter((r) => r.method !== 'GET');
  expect(writes.map((r) => [r.method, r.path])).toEqual([['POST', '/folders'], ['POST', '/folders']]);
  expect(writes[0].ifMatch).toBe('10');
  expect(writes[1].ifMatch).toBe('11');
  expect(writes.every((r) => r.contentType === 'application/json')).toBe(true);
  expect(writes[1].body).toEqual({ host_id: HOST, parent_id: null, name: 'Shared' });

  // A server validation error (duplicate name) is shown in the row.
  await selectItem(page, SERVER_ROOT);
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('shared');
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryLibraryViewSaved .qlRow__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);

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
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');

  // Moving and recursive remove through the API.
  await expect(panel(page)).toBeVisible();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Shared').locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  expect(server.queries.find((q) => q.id === 'q_answer').folder_id).toBe(server.folders.find((f) => f.name === 'Shared').id);
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove all' }).click();
  await expect(node(page, 'Operations')).toHaveCount(0);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/folders/f_ops?recursive=1')).toBe(true);
  // A saved query is stamped with the host.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 7 AS seven');
  await page.locator('#queryTextArea').press('Control+s');
  await fillDialog(page, { name: 'Seven' });
  await dialog(page).locator('[name="folder_id"]').selectOption('server:');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect(server.requests.filter((r) => r.method === 'POST' && r.path === '/queries').at(-1).body).toMatchObject({ host_id: HOST, name: 'Seven', sql: 'SELECT 7 AS seven' });
  // Nothing was written to the browser library.
  expect(await libraryState(page)).toBeNull();
});

test('server storage: a host switch reloads both roots and the browser History follows the host; a host_mismatch is reported', async ({ page }) => {
  await addSecondHost(page);
  const server = await mockServerLibrary(page, {
    writable: true,
    library: {
      folders: [...LIBRARY.folders, { id: 'f_other', host_id: 'other', parent_id: null, name: 'Other ops', created_at_ms: now, updated_at_ms: now }],
      queries: [...LIBRARY.queries, { id: 'q_other', host_id: 'other', folder_id: 'f_other', name: 'Other query', description: '', sql: 'SELECT 9', created_at_ms: now, updated_at_ms: now }],
    },
  });
  await seed(page, { 'chdash.selectedHost': HOST, 'chdash.queryHistory.v1': [
    { ts_ms: Date.now() - 2000, sql_raw: 'SELECT \'on local\'', host_id: HOST, status: 'ok' },
    { ts_ms: Date.now() - 1000, sql_raw: 'SELECT \'on other\'', host_id: 'other', status: 'ok' },
  ], 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [
    { id: 'q_mine', folder_id: null, name: 'Mine on local', sql: 'SELECT 1', host_id: HOST },
    { id: 'q_mine_other', folder_id: null, name: 'Mine on other', sql: 'SELECT 2', host_id: 'other' },
  ] } });
  await openLibrary(page);
  await expect(node(page, 'Operations')).toBeVisible();
  await expect(node(page, 'Mine on local')).toBeVisible();
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/on local/]);
  await closePanel(page);
  await pickHost(page, 'other');
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await expect(node(page, 'Mine on other')).toBeVisible();
  await expect(node(page, 'Operations')).toHaveCount(0);
  await expect(node(page, 'Mine on local')).toHaveCount(0);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/on other/]);
  const reads = server.requests.filter((r) => r.method === 'GET').map((r) => new URL(`http://x${r.path}`).searchParams.get('host_id'));
  expect(reads.at(-1)).toBe('other');
  expect(reads).toContain(HOST);

  // A move the server refuses (the folder moved to another host behind this
  // page's back: 400 host_mismatch) is told, and nothing moves.
  await page.locator('#queryLibraryTabSaved').click();
  await page.evaluate((id) => window.ChDash.ui.setSelectedHostId(id), HOST);
  await expect(node(page, 'Operations')).toBeVisible();
  server.folders.find((f) => f.id === 'f_reports').host_id = 'other';
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast--error')).toContainText('a folder of another host');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  expect(server.queries.find((q) => q.id === 'q_answer').folder_id).toBeNull();
});

test('server storage: the History stays in the browser, whatever the server root does: runs are never sent, no entry can be removed, there is no Clear', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true });
  await seed(page, { 'chdash.queryHistory.v1': [{ ts_ms: Date.now() - 60_000, sql_raw: 'SELECT 1 AS earlier', host_id: HOST, status: 'ok', elapsed_ms: 3, rows: 1 }] });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(3)');
  await expect.poll(async () => (await historyState(page)).length).toBe(2);

  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toContainText('Stored in this browser');
  await expect(page.locator('#queryLibraryMenu .qh__clear')).toHaveCount(0);
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('earlier');
  await expect(items).toHaveCount(1);
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('');
  await expect(items).toHaveCount(2);
  await items.filter({ hasText: 'earlier' }).click();
  await expect(previewTool(page, 'remove')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(items).toHaveCount(2);
  expect((await historyState(page)).some((h) => h.sql_raw.includes('earlier'))).toBe(true);
  // Not one request about the History reached the server.
  expect(server.requests.filter((r) => r.path.startsWith('/history'))).toEqual([]);
});

test('a read-only server root: shown with its badge and no edit tools; the browser root stays editable', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: false });
  await seed(page, { 'chdash.queryLibrary.v2': MINE });
  await openLibrary(page);
  const serverRoot = node(page, SERVER_ROOT);
  await expect(serverRoot.locator(':scope > .qlRow .qlBadge--readonly')).toHaveText('Read-only');
  await expect(serverRoot.locator(':scope > .qlRow .qlBadge--readonly use')).toHaveAttribute('href', /#i-lock$/);
  await expect(node(page, LOCAL_ROOT).locator('.qlBadge--readonly')).toHaveCount(0);
  // The list's New folder and Save act on the browser's root.
  await expect(page.locator('#queryLibraryViewSaved .ql__actions')).toBeVisible();
  // Nothing of the server's root drags; the browser's does.
  await expect(tree(page).locator('li[data-store="server"][draggable="true"]')).toHaveCount(0);
  await expect(node(page, 'Mine')).toHaveAttribute('draggable', 'true');
  // The server's menu only lists what a read-only item can do.
  await openRowMenu(page, 'The answer');
  expect(await menuLabels(page)).toEqual(['Load']);
  await page.keyboard.press('Escape');

  // The server's items and root: no tools; a query keeps Load.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(footLabels(page)).toHaveText(['Load']);
  await selectItem(page, 'Operations');
  await expect(preview(page).locator('.qlPreview__tools, .qlPreview__foot')).toHaveCount(0);
  await selectItem(page, SERVER_ROOT);
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(preview(page).locator('.qlPreview__meta')).toContainText('Read-only');
  // The browser's query keeps its tools; its Move picker offers the server root disabled.
  await selectItem(page, 'Mine');
  expect(await toolNames(page)).toEqual(['Edit', 'Move to…', 'Remove']);
  await previewTool(page, 'move').click();
  const group = dialog(page).locator('select[name="target"] optgroup[data-store="server"]');
  await expect(group).toHaveAttribute('label', `${SERVER_ROOT} (read-only)`);
  expect(await group.evaluate((g) => g.disabled)).toBe(true);
  await page.keyboard.press('Escape');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewAction(page, 'load').click();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');

  // Editing shortcuts on a server item are inert; no drop into the server root.
  await showPanel(page);
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+m');
  await expect(dialog(page)).toHaveCount(0);
  await node(page, 'Mine').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'local');
  // Ctrl+S saves into the browser's root (the server's group is disabled).
  await page.keyboard.press('Escape');
  await page.locator('#queryTextArea').press('Control+s');
  await expect(dialog(page).locator('[name="folder_id"] optgroup[data-store="server"]')).toHaveAttribute('label', `${SERVER_ROOT} (read-only)`);
  expect(await dialog(page).locator('[name="folder_id"]').inputValue()).toBe('local:');
  await fillDialog(page, { name: 'Mine too' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.map((q) => q.name).sort()).toEqual(['Mine', 'Mine too']);

  // History: Save to library (into the browser's root) and Remove (the History is the browser's, whatever the server root).
  await runSuccessfulQuery(page, 'SELECT 5 AS five');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  expect(await toolNames(page)).toEqual(['Save to library…']);
  await expect(footLabels(page)).toHaveText(['Load']);
  expect(server.requests.filter((r) => r.method !== 'GET')).toEqual([]);
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
    // "Save query" is at the bottom of the list, New folder in the head.
    await expect(page.locator('#queryLibraryViewSaved [data-action="save"]')).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved [data-action="new-folder"]')).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved .qlRow__meta').first()).toBeHidden();
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-${scheme}.png` });
    // A tap shows the query's preview in place of the list, with a Back
    // button and every action; the focus is on Load. Nothing is
    // loaded yet.
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await expect(preview(page)).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved')).toBeHidden();
    await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
    await expect(preview(page).locator('.qlPreview__back')).toBeVisible();
    await expect(previewAction(page, 'load')).toBeFocused();
    expect(await toolNames(page)).toEqual(['Edit', 'Move to…', 'Remove']);
    await expect(footLabels(page)).toHaveText(['Load']);
    expect(Math.round((await preview(page).boundingBox()).width)).toBe(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Every button of the pane is inside it; the title keeps its line with
    // Back and the tools, the meta goes under it.
    const fit = await page.evaluate(() => {
      const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#queryLibraryPreview button')].filter((b) => b.getClientRects().length).map((b) => b.getBoundingClientRect());
      const title = document.querySelector('#queryLibraryPreview .qlPreview__title');
      const meta = document.querySelector('#queryLibraryPreview .qlPreview__meta').getBoundingClientRect();
      return {
        inside: buttons.every((b) => b.left >= pane.left - 0.5 && b.right <= pane.right + 0.5 && b.bottom <= pane.bottom + 0.5),
        titleWhole: title.scrollWidth <= title.clientWidth,
        metaUnder: meta.top >= title.getBoundingClientRect().bottom - 1,
      };
    });
    expect(fit).toEqual({ inside: true, titleWhole: true, metaUnder: true });
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-preview-${scheme}.png` });
    // A prompt is a bottom sheet over it.
    await previewTool(page, 'move').click();
    const sheet = await settled(dialog(page));
    expect([Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 844]);
    expect(sheet.y).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(preview(page)).toBeVisible();
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
    expect(await toolNames(page)).toEqual(['Rename', 'Move to…', 'New subfolder', 'Remove']);
    await expect(previewTool(page, 'rename')).toBeFocused();
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-folder-${scheme}.png` });
    await preview(page).locator('.qlPreview__back').click();
    await expect(node(page, 'Operations')).toBeFocused();
    // Then Load closes the dialog and fills the editor.
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
    expect(await toolNames(page)).toEqual(['Save to library…']);
    await expect(footLabels(page)).toHaveText(['Load']);
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

test.describe('touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('the preview\'s icon tools are --hit (40 px) square', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  await page.locator('#queryLibraryButton').click();
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(preview(page)).toBeVisible();
  const sizes = await preview(page).locator('.qlPreview__tools button, .qlPreview__back').evaluateAll((els) => els.map((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height)]));
  expect(sizes.length).toBe(4);
  for (const [w, h] of sizes) expect([w, h]).toEqual([40, 40]);
  // The list's menu button is there without a hover, --hit square.
  await preview(page).locator('.qlPreview__back').click();
  const menu = node(page, 'The answer').locator(':scope > .qlRow > .qlRow__menu');
  expect(await menu.evaluate((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), getComputedStyle(el).opacity])).toEqual([40, 40, '1']);
  });
});

test('themes: panel, tree and preview (tools and SQL) follow dark and light', async ({ page }, testInfo) => {
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
      tool: getComputedStyle(document.querySelector('#queryLibraryPreview .qlPreview__tools button')).color,
      meta: getComputedStyle(document.querySelector('#queryLibraryPreview .qlPreview__meta')).color,
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
  expect(colors.dark.meta).not.toBe(colors.light.meta);
});

// --- Live server (optional) -------------------------------------------------

const LIVE = process.env.QUERY_LIBRARY_BASE_URL || '';

test('live server library: both roots; create, save, move within and across the roots, reload and remove against a real instance', async ({ page }) => {
  test.skip(!LIVE, 'QUERY_LIBRARY_BASE_URL names a writable query library instance (tests/README.md).');
  const stamp = `pw-${Date.now().toString(36)}`;
  await page.goto(`${LIVE.replace(/\/+$/, '')}/query`);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  const host = (await page.locator('#hostPickerText').textContent()).trim();
  await showPanel(page);
  await expect(footCount(page)).toContainText(`· ${host}`);
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['server', 'local']);
  await expect(node(page, SERVER_ROOT)).toBeVisible();
  await expect(node(page, LOCAL_ROOT)).toBeVisible();

  await selectItem(page, SERVER_ROOT);
  await previewTool(page, 'new-subfolder').click();
  expect(await dialog(page).locator('[name="parent_id"]').inputValue()).toBe('server:');
  await fillDialog(page, { name: `${stamp} folder` });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, `${stamp} folder`)).toBeVisible();

  await closePanel(page);
  await page.locator('#queryTextArea').fill(`SELECT '${stamp}' AS stamp`);
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  await fillDialog(page, { name: `${stamp} query`, description: 'live check' });
  await dialog(page).locator('[name="folder_id"]').selectOption('server:');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node(page, `${stamp} query`)).toBeVisible();
  await node(page, `${stamp} query`).locator(':scope > .qlRow').dragTo(node(page, `${stamp} folder`).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '3');

  // Reloaded from the server file, for this host.
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  await showPanel(page);
  await expandFolder(page, `${stamp} folder`);
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '3');
  let library = await page.evaluate(async (id) => (await fetch(`api/query-library?host_id=${encodeURIComponent(id)}`)).json(), host);
  expect(library.queries.find((q) => q.name === `${stamp} query`).host_id).toBe(host);

  // The run lands in this browser's History, for the host.
  await loadSaved(page, `${stamp} query`);
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').filter({ hasText: stamp }).first()).toBeVisible();
  await page.locator('#queryLibraryTabSaved').click();

  // The folder to this browser (copied, then removed from the server), and back
  // (one copy-mode import on the real server).
  await selectItem(page, `${stamp} folder`);
  await previewTool(page, 'move').click();
  await dialog(page).locator('select[name="target"]').selectOption('local:');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveAttribute('data-store', 'local');
  library = await page.evaluate(async (id) => (await fetch(`api/query-library?host_id=${encodeURIComponent(id)}`)).json(), host);
  expect(library.folders.some((f) => f.name === `${stamp} folder`)).toBe(false);
  expect(library.queries.some((q) => q.name === `${stamp} query`)).toBe(false);
  expect((await libraryState(page)).queries.find((q) => q.name === `${stamp} query`)).toMatchObject({ host_id: host, description: 'live check' });
  await node(page, `${stamp} folder`).locator(':scope > .qlRow').dragTo(node(page, SERVER_ROOT).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} folder`)).toHaveAttribute('data-store', 'server');
  library = await page.evaluate(async (id) => (await fetch(`api/query-library?host_id=${encodeURIComponent(id)}`)).json(), host);
  const folder = library.folders.find((f) => f.name === `${stamp} folder`);
  expect(library.queries.find((q) => q.name === `${stamp} query`)).toMatchObject({ folder_id: folder.id, sql: `SELECT '${stamp}' AS stamp` });
  expect((await libraryState(page)).folders.some((f) => f.name === `${stamp} folder`)).toBe(false);

  await selectItem(page, `${stamp} folder`);
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove all' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveCount(0);
});

// Audit round 2: an empty tab is one empty state centred across the dialog
// (no "select an item" pane beside it).
test('an empty History is one centred empty state across the dialog; an empty library is the plain tree of its roots', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] }, 'chdash.queryHistory.v1': [] });
  await openLibrary(page);
  const body = page.locator('.queryLibraryDialog__body');
  // Saved with nothing saved is the classic tree: the root (and the server's when the library is
  // enabled), each saying it is empty, with the preview pane beside it; no "No saved queries" screen.
  await expect(body).not.toHaveClass(/is-empty/);
  await expect(preview(page)).toBeVisible();
  await expect(node(page, LOCAL_ROOT).locator('.qlTree__empty')).toHaveText('Empty');
  await expect(page.locator('#queryLibraryViewSaved .qlTree__empty--root')).toHaveCount(0);
  await expect(panel(page)).not.toContainText('No saved queries');
  await expect(panel(page)).not.toContainText('in the editor');
  // History with no run is one empty state centred across the dialog, without the preview pane.
  await showPanel(page, 'history');
  const empty = page.locator('#queryLibraryViewHistory .qlTree__empty--root');
  await expect(empty).toContainText(`No history for ${HOST} yet`);
  await expect(body).toHaveClass(/is-empty/);
  await expect(preview(page)).toBeHidden();
  const [bodyBox, emptyBox, listBox] = await Promise.all([body.boundingBox(), empty.boundingBox(), page.locator('#queryLibraryViewHistory .qhList').boundingBox()]);
  // Centred across the dialog's width and in the list's height.
  expect(Math.abs((emptyBox.x + emptyBox.width / 2) - (bodyBox.x + bodyBox.width / 2))).toBeLessThanOrEqual(24);
  expect(Math.abs((emptyBox.y + emptyBox.height / 2) - (listBox.y + listBox.height / 2))).toBeLessThanOrEqual(24);
  // A first entry brings the list and its preview pane back.
  await closePanel(page);
  await runSuccessfulQuery(page, 'SELECT 1 AS one');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveCount(1);
  await expect(body).not.toHaveClass(/is-empty/);
  await expect(preview(page)).toBeVisible();
});

test('History: no "Clear history"; its foot is the count line, as the Saved foot', async ({ page }) => {
  await seed(page, { 'chdash.queryHistory.v1': null });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 1 AS one');
  await showPanel(page, 'history');
  const view = page.locator('#queryLibraryViewHistory');
  await expect(view.locator('.qhItem')).toHaveCount(1);
  await expect(view.locator('.qh__clear, .qh__footBar')).toHaveCount(0);
  await expect(view.getByRole('button', { name: /clear history/i })).toHaveCount(0);
  await expect(view.locator('.ql > .ql__foot')).toHaveText(`1 entry · ${HOST} · Stored in this browser`);
  // The same place as Saved's foot, at the bottom of its column.
  const [foot, list] = await Promise.all([view.locator('.ql__foot').boundingBox(), view.locator('.qhList').boundingBox()]);
  expect(foot.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(await page.evaluate(() => [...document.querySelectorAll('#queryLibraryViewHistory .ql > *')].map((el) => el.className.split(' ')[0]))).toEqual(['ql__head', 'qhList', 'ql__foot']);
});
