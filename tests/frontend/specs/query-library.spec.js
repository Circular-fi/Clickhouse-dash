import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { nextFrames, openApp, roundTrip, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';
import { historyRecords } from '../helpers/history.js';
import { captureCopies, copiedText } from '../helpers/clipboard.js';
import { requireInstance } from '../helpers/instances.js';

// Query library: the toolbar book button opens it. The button is between Format and the run
// settings cog. It opens the shared modal dialog of the profiling (app_ui_dialog.js: same shell,
// size, backdrop and tab style). The head of the dialog has two tabs and no title: Saved (folders
// and saved queries) and History.
//
// The Move and Remove prompts stack over the dialog. Save and Edit do not stack. They are a form in
// the right pane (Saved), in place of the preview. Saved is a tree, as in the Explorer. The
// storages are its top folders. Every folder opens in place.
//
// The head has a "New folder" button. It names the folder in its row. Each row has a "..." menu. A
// right click opens the same menu. The menu changes the folder.
//
// "Save" is the floppy button of the editor. It opens the form of the pane. The preview pane on the
// right shows the highlighted row.
//
// The tools are icon buttons at the right end of the one line in the head. The line holds the
// title, then "Updated ..." or the time and status of a run. The foot holds "Load" (Ctrl/Cmd+Enter)
// only.
//
// Saved holds two root folders. The first root is "Shared server storage". It is the server
// library, and it shows only when features.query_library is enabled. The second root is "Local
// browser storage" (localStorage chdash.queryLibrary.v2). Both roots are browsable. The pickers
// offer both roots. A move between the roots copies, then removes.
//
// Saved queries, folders and History are per host. The dialog shows the selected host's data. The
// dialog follows a host switch.
//
// The server is a small in-memory server behind page.route. It is writable or read-only. One live
// check is also possible. It runs when QUERY_LIBRARY_LIVE_URL names a real instance. History is the
// browser's record of what ran. Nothing in it can be removed.

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
// This prompt is over the library (Move, Remove). Save and Edit are not prompts: they are the form
// of the right pane.
const dialog = (page) => page.locator('dialog.qlDialog[open]');
const openDialogs = (page) => page.locator('dialog[open]');
const libraryState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryLibrary.v2') || 'null'));
// The runs of this browser are records in IndexedDB (app_history.js). The newest run is first.
const historyState = historyRecords;

// Seed localStorage before the first page script. Do this once for each test.
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

// The compose instance has one host: "local".
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
// The Save / Edit form is the content of the pane. It replaces the preview.
const saveForm = (page) => preview(page).locator('form.qlPaneForm');
const formTitle = (page) => saveForm(page).locator('.qlPreview__title');
const formButton = (page, name) => saveForm(page).getByRole('button', { name, exact: true });
// The folder picker (createFolderPicker) is a dropdown in the Save and Edit form. It is an open
// tree in Move to. Its element shows the chosen place. It uses data-value ("local:f_reports",
// "server:" for the top of a storage). It uses data-path ("/Reports").
const pickerOf = (scope) => scope.locator('.qlPicker');
const folderField = (page) => pickerOf(saveForm(page));
// The foot of the pane holds Load. The tools of the pane are icon buttons in the head.
const previewAction = (page, action) => preview(page).locator(`.qlPreview__foot [data-action="${action}"]`);
const previewTool = (page, action) => preview(page).locator(`.qlPreview__tools [data-action="${action}"]`);
const footLabels = (page) => preview(page).locator('.qlPreview__foot .button');
const toolNames = (page) => preview(page).locator('.qlPreview__tools button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
const facts = (page) => preview(page).locator('.qlPreview__facts').evaluate((dl) => {
  const out = {};
  for (const dt of dl.querySelectorAll('dt')) out[dt.textContent] = dt.nextElementSibling.textContent;
  return out;
}).catch(() => ({}));

// Select a tree item. Do not toggle it. Focus also selects the item.
async function selectItem(page, name) {
  await node(page, name).focus();
  await expect(node(page, name)).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(name);
}

// Select a saved query with a click. Load it with the button of the preview.
async function loadSaved(page, name) {
  await node(page, name).locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(name);
  await previewAction(page, 'load').click();
}

// Open the panel on a tab. Do this from a closed state.
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

// The library is modal. The editor behind it is inert until the library closes.
async function closePanel(page) {
  // A save form open in the pane takes the first Escape.
  if ((await panel(page).isVisible()) && (await saveForm(page).isVisible())) await page.keyboard.press('Escape');
  if (await panel(page).isVisible()) await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
}

// Wait for the open animation. The dialog box is scaled during this time.
async function settled(locator) {
  await locator.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return locator.boundingBox();
}

async function expandFolder(page, name) {
  const folder = node(page, name);
  if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
}

async function fillForm(page, fields) {
  const d = saveForm(page);
  await expect(d).toBeVisible();
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'folder_id') await pickPlace(d, value);
    else await d.locator(`[name="${name}"]`).fill(value);
  }
}

async function openPicker(scope) {
  const trigger = pickerOf(scope).locator('.qlPicker__button');
  if ((await trigger.count()) && (await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
}

// Open every folder of the tree that is shown. Open the dropdown, and open each closed folder.
async function expandPicker(scope) {
  await openPicker(scope);
  for (let i = 0; i < 12; i += 1) {
    const closed = pickerOf(scope).locator('.qlPicker__tree [role="treeitem"][aria-expanded="false"] > .qlPicker__row > [data-twisty]');
    if (!(await closed.count())) return;
    await closed.first().click();
  }
}

// Choose a place by value ("local:f_reports", "server:") or by path ("/Reports",
// "/Operations/Merges", "/" for a top).
async function pickPlace(scope, target) {
  await expandPicker(scope);
  const tree = pickerOf(scope).locator('.qlPicker__tree');
  const row = target.includes(':') ? tree.locator(`[role="treeitem"][data-key="${target}"]`) : tree.locator(`[role="treeitem"][data-path="${target}"]`).first();
  await row.locator('.qlPicker__row').click();
}

// The paths of the tree list the top of each storage first ("/"), then its folders. The same paths
// are grouped by storage: { "<storage>": ["/", "/Ops"] }. A read-only storage is named "<storage>
// (read-only)".
async function pickerOptions(scope) {
  await expandPicker(scope);
  return pickerOf(scope).locator('.qlPicker__tree [role="treeitem"]').evaluateAll((rows) => rows.map((row) => row.dataset.path));
}
async function pickerGroups(scope) {
  await expandPicker(scope);
  return pickerOf(scope).locator('.qlPicker__tree [role="treeitem"]').evaluateAll((rows) => {
    const groups = {};
    let current = null;
    for (const row of rows) {
      if (row.getAttribute('aria-level') === '1') {
        const name = row.querySelector('.qlPicker__name').textContent;
        current = row.querySelector('.qlPicker__lock') ? `${name} (read-only)` : name;
        groups[current] = [];
      }
      groups[current].push(row.dataset.path);
    }
    return groups;
  });
}

// A second host, "other", sits next to the compose instance's "local". /api/hosts lists it. The
// requests that name it get answers for "local" (the same ClickHouse). So the page has two hosts to
// switch between.
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
  // The picker follows the hosts stream. The stream sends one event with both hosts. Then the
  // stream ends. The page polls api/hosts and reconnects.
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

// Pick a host in the header. The library dialog must be closed first. The page under a modal dialog
// is inert.
async function pickHost(page, id) {
  await page.locator('#hostPickerButton').click();
  await expect(page.locator('#hostPickerMenu')).toBeVisible();
  await page.locator('#hostPickerMenu .pickerOption').filter({ has: page.locator('.pickerOption__label', { hasText: new RegExp(`^${id}$`) }) }).click();
  await expect(page.locator('#hostPickerText')).toHaveText(id);
}

// This is the text that the last copy put on the clipboard. http origins have no async clipboard to
// read. copy.text selects a textarea and runs the copy command.

// A History run has no menu and no button. Every action is in the preview. No action removes the
// run.
async function expectNoItemMenu(page, item) {
  await expect(item.locator('button')).toHaveCount(0);
  await item.click({ button: 'right' });
  await expect(page.locator('#queryLibraryMenu [role=menu]')).toHaveCount(0);
}

// This describes the "..." menu of a row: its items, and the menu itself.
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
  // There is one root. The server library is not enabled.
  await expect(tree(page).locator(':scope > li[role=treeitem]')).toHaveCount(1);
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-level', '1');
  await expect(node(page, LOCAL_ROOT)).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, SERVER_ROOT)).toHaveCount(0);
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['local']);
  // Only the entries of the current host appear. A query of a removed folder is at the top level of
  // its root.
  await expect(node(page, 'Local folder')).toBeVisible();
  await expect(node(page, 'Was in a hostless folder')).toHaveAttribute('aria-level', '2');
  for (const gone of ['Hostless folder', 'Hostless query', 'Other folder', 'Other query', 'Legacy flat']) await expect(node(page, gone)).toHaveCount(0);
  await expect(footCount(page)).toHaveText(`2 queries \u00b7 ${HOST}`);
  // The import offer is gone. Its stored state is removed.
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('chdash.queryLibrary.importOffer.v1'))).toBeNull();

  // The stored library lost its entries without a host. The entries of the other host stay.
  const stored = await libraryState(page);
  expect(stored.version).toBe(2);
  expect(stored.folders.map((f) => f.id).sort()).toEqual(['f_local', 'f_other']);
  expect(stored.queries.map((q) => q.id).sort()).toEqual(['q_in_hostless', 'q_local', 'q_other']);
  expect(stored.queries.find((q) => q.id === 'q_in_hostless').folder_id).toBeNull();
  expect('migrated_from' in stored).toBe(false);
  // The legacy flat list is not imported. The list is not changed either.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('chdash.savedQueries.v1')))).toEqual(legacy);
  // History: the run without a host is removed from the key. The run of the other host stays, but
  // is not shown.
  expect((await historyState(page)).map((h) => h.host_id).sort()).toEqual([HOST, 'other']);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveCount(1);
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toContainText('local run');

  // A run is recorded with its host. A loaded query fills the editor.
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

  // Remove a query. The shared confirm appears over the library. The focus is on Cancel.
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveClass(/uiDialog--sm/);
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Remove query');
  await expect(confirm.locator('.uiDialog__message')).toContainText('Remove \u201cThe answer\u201d? This cannot be undone.');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(confirm.getByRole('button', { name: 'Remove' })).toHaveClass(/button--danger/);
  // When Cancel has the focus, Enter keeps the query.
  await page.keyboard.press('Enter');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'The answer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('li[role=treeitem]')?.dataset.id || '')).toBe('q_answer');
  // A click on the backdrop of the confirm closes only the confirm.
  await page.keyboard.press('Delete');
  await expect(confirm).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // Confirm the removal from the preview's Remove button. The query is then removed.
  await previewTool(page, 'delete').click();
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page)).queries.map((q) => q.id).sort()).toEqual(['q_merges', 'q_parts']);
  // The toast appears in the top dialog. The page under it is inert.
  await expect(page.locator('#queryLibraryMenu > .qlToast')).toContainText('Query removed.');

  // Remove a non-empty folder. Press Escape to keep it.
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Remove folder');
  await expect(confirm).toContainText('2 queries and 1 subfolder');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'Operations')).toBeVisible();
  // An empty folder also asks first. This happens with the Delete key.
  await node(page, 'Reports').focus();
  await page.keyboard.press('Delete');
  await expect(confirm.locator('.uiDialog__message')).toHaveText('Remove the empty folder \u201cReports\u201d?');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Reports')).toBeVisible();
  // A root is never removed. The Delete key does nothing on a root.
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
  // With nothing saved, the tree shows its usual form: the root, which says it is empty. The root
  // has no screen of its own.
  await expect(node(page, LOCAL_ROOT)).toBeVisible();
  await expect(node(page, LOCAL_ROOT).locator('.qlTree__empty')).toHaveText('Empty');
  await expect(tree(page)).not.toContainText('No saved queries');
  // There is one focus ring. The search field draws it. The input inside does not draw it.
  const field = page.locator('#queryLibraryViewSaved .qlSearch');
  await field.locator('.qlSearch__input').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(field.locator('.qlSearch__input')).toBeFocused();
  const rings = await field.evaluate((el) => ({ field: getComputedStyle(el).boxShadow, input: getComputedStyle(el.querySelector('.qlSearch__input')).outlineColor }));
  expect(rings.field).not.toBe('none');
  expect(rings.input).toBe('rgba(0, 0, 0, 0)');

  // New folder adds a row for the name. The row is first in the root and has the focus. Escape
  // removes the row.
  const newFolder = page.locator('#queryLibraryViewSaved [data-action="new-folder"]');
  await newFolder.click();
  await expect(newFolderInput(page)).toBeFocused();
  await expect(page.locator('#queryLibraryViewSaved .qlRow__field')).not.toContainText('Description');
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page))?.folders || []).toEqual([]);
  // Enter creates the folder and highlights it.
  await newFolder.click();
  await newFolderInput(page).fill('Monitoring');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Monitoring')).toBeVisible();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-level', '2');
  await expect(page.locator('.qlToast')).toContainText('Folder created.');
  expect((await libraryState(page)).folders.map((f) => Object.keys(f).sort())).toEqual([['created_at_ms', 'host_id', 'id', 'name', 'parent_id', 'updated_at_ms']]);

  // The row refuses a duplicate name. The check ignores case. The row stays, so the user can
  // correct the name.
  await selectItem(page, LOCAL_ROOT);
  await newFolder.click();
  await newFolderInput(page).fill('monitoring');
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryLibraryViewSaved .qlRow__error')).toContainText('already exists');
  await expect(newFolderInput(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(newFolderInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);

  // The preview of a folder shows its path (root and folders), its contents and its tools. It has
  // no foot and no Load.
  await selectItem(page, 'Monitoring');
  expect(await facts(page)).toEqual({ Path: `${LOCAL_ROOT} /Monitoring`, Contents: 'Empty' });
  expect(await toolNames(page)).toEqual(['Rename', 'Move to\u2026', 'New subfolder', 'Remove']);
  await expect(preview(page).locator('.qlPreview__foot')).toHaveCount(0);
  await expect(preview(page).locator('.qlPreview__description')).toHaveCount(0);
  // This is the menu of the row.
  await openRowMenu(page, 'Monitoring');
  expect(await menuLabels(page)).toEqual(['Open', 'Rename', 'Move to\u2026', 'Export as JSON', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();

  // A new subfolder comes from the preview. The folder opens. The new subfolder is named inline in
  // the open folder.
  await previewTool(page, 'new-subfolder').click();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-expanded', 'true');
  await expect(newFolderInput(page)).toBeFocused();
  await newFolderInput(page).fill('Disks');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Disks')).toHaveAttribute('aria-level', '3');

  // When the subfolder is selected, the save adds the query to it.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT name, free_space FROM system.disks');
  await showPanel(page);
  await selectItem(page, 'Disks');
  await clickSave(page);
  expect(await pickerOptions(saveForm(page))).toEqual(['/', '/Monitoring', '/Monitoring/Disks']);
  await expect(folderField(page)).toHaveAttribute('data-path', '/Monitoring/Disks');
  await fillForm(page, { name: 'Free space', description: 'Free bytes per disk' });
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node(page, 'Free space')).toHaveAttribute('aria-level', '4');
  await expect(node(page, 'Free space')).toHaveAttribute('aria-selected', 'true');
  // A query's preview has no Folder line. The tree shows where the query is.
  expect(Object.keys(await facts(page))).not.toContain('Folder');
  const disks = (await libraryState(page)).folders.find((f) => f.name === 'Disks');
  expect((await libraryState(page)).queries.find((q) => q.name === 'Free space').folder_id).toBe(disks.id);

  // Rename a folder in place. Press F2 on the folder's row, or use Rename in the preview. Escape
  // keeps the old name.
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

  // Move to... in the preview moves the folder to the top level ("/").
  await selectItem(page, 'Volumes');
  await previewTool(page, 'move').click();
  expect(await pickerOptions(dialog(page))).toEqual(['/', '/Health']);
  await pickPlace(dialog(page), '/');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /.');
  await expect(node(page, 'Volumes')).toHaveAttribute('aria-level', '2');

  // A non-empty folder asks first when it is removed. The removal deletes everything inside the folder.
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

test('History keeps a run formatted: a run typed unformatted, and an older entry, get the formatter\'s text; the raw text stays', async ({ page }) => {
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] },
    'chdash.queryHistory.v1': [
      { ts_ms: Date.now() - 3600_000, sql_raw: 'select 1 as a,2 as b from system.one', host_id: HOST, status: 'ok', elapsed_ms: 3, rows: 1 },
      { ts_ms: Date.now() - 7200_000, sql_raw: 'select 0 from  system.one', sql_formatted: 'SELECT 0\nFROM system.one', formatted: true, host_id: HOST, status: 'ok', elapsed_ms: 3, rows: 1 },
    ],
  });
  await openApp(page);
  // A run that is typed without formatting (Auto-format is off) keeps the typed text in the entry. The
  // formatter's text follows.
  await runSuccessfulQuery(page, 'select number   from system.numbers limit 3');
  await expect.poll(async () => {
    const entry = (await historyState(page)).find((h) => h.sql_raw.startsWith('select number'));
    return entry ? { formatted: entry.formatted === true, text: entry.sql_formatted } : null;
  }).toEqual({ formatted: true, text: 'SELECT number\nFROM system.numbers\nLIMIT 3' });
  const typed = (await historyState(page)).find((h) => h.sql_raw.startsWith('select number'));
  expect(typed.sql_raw).toBe('select number   from system.numbers limit 3');
  // An older entry without formatted text gets it when the user selects it. An entry that already
  // has formatted text keeps it.
  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await items.filter({ hasText: 'select 1 as a' }).click();
  await expect.poll(async () => (await historyState(page)).find((h) => h.sql_raw.startsWith('select 1 as a')).formatted === true).toBe(true);
  const stored = await historyState(page);
  expect(stored.find((h) => h.sql_raw.startsWith('select 1 as a')).sql_formatted).toMatch(/^SELECT\s+1 AS `?a`?,\s+2 AS `?b`?\s+FROM system\.one$/);
  expect(stored.find((h) => h.sql_raw.startsWith('select 1 as a')).sql_raw).toBe('select 1 as a,2 as b from system.one');
  expect(stored.find((h) => h.sql_raw.startsWith('select 0')).sql_formatted).toBe('SELECT 0\nFROM system.one');
  // The preview then shows the formatted text. The list does not change. Each entry stays on one
  // line.
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText(/^SELECT\s+1 AS `?a`?,\s+2 AS `?b`?\s+FROM system\.one$/);
  await items.filter({ hasText: 'numbers' }).click();
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT number\nFROM system.numbers\nLIMIT 3');
  // A script that fails is kept as typed. The page does not request it again while the page is open.
  const calls = [];
  page.on('request', (request) => { if (request.url().includes('/api/format')) calls.push(request.postData()); });
  await closePanel(page);
  await runQuery(page, 'select ((( from');
  await waitForTerminal(page);
  await showPanel(page, 'history');
  await items.filter({ hasText: '(((' }).click();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toContainText('(((');
  const before = calls.length;
  await items.filter({ hasText: 'numbers' }).click();
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT number\nFROM system.numbers\nLIMIT 3');
  await items.filter({ hasText: '(((' }).click();
  // The preview shows the script again. The selection ran. Two frames and one round trip later, the
  // list holds the request that a second look sends.
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toContainText('(((');
  await nextFrames(page);
  await roundTrip(page);
  expect(calls.length).toBe(before);
  expect((await historyState(page)).find((h) => h.sql_raw === 'select ((( from').formatted).not.toBe(true);
});

test('Save: the query is saved formatted, the Formatted switch released keeps it as typed, and the preview shows what will be saved', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('select count() from system.tables where database = \'system\'');
  await showPanel(page);
  await clickSave(page);
  const d = saveForm(page);
  // The Formatted switch is the switch of the results. It is pressed by default.
  const formatted = d.locator('.qlForm__sql .sqlMode');
  await expect(formatted).toHaveText('Formatted');
  // It sits in the SQL block, left of the copy button. A result's statement has the same layout.
  const switchBox = await formatted.boundingBox();
  const copyBox = await d.locator('.qlForm__sql .sqlBlock__copy').boundingBox();
  expect(switchBox.x + switchBox.width).toBeLessThanOrEqual(copyBox.x);
  expect(Math.abs(switchBox.y - copyBox.y)).toBeLessThan(12);
  await expect(formatted).toHaveAttribute('aria-pressed', 'true');
  await expect(d.locator('.qlForm__sql .uiField__label')).toContainText('from the editor');
  // The preview shows the formatter's text. Keywords are in upper case. Each clause is on one line.
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText("SELECT count()\nFROM system.tables\nWHERE database = 'system'");
  // When the switch is released, the preview shows the text as typed.
  await formatted.click();
  await expect(formatted).toHaveAttribute('aria-pressed', 'false');
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText("select count() from system.tables where database = 'system'");
  await formatted.click();
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText("SELECT count()\nFROM system.tables\nWHERE database = 'system'");
  await fillForm(page, { name: 'Formatted one' });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  // Repeat the test with the Formatted switch released. The editor now holds the saved query. The
  // dialog offers Update and Save as new.
  await clickSave(page);
  await expect(saveForm(page).locator('.qlForm__sql .sqlMode')).toHaveAttribute('aria-pressed', 'true');
  await saveForm(page).locator('.qlForm__sql .sqlMode').click();
  await fillForm(page, { name: 'Raw one' });
  await saveForm(page).getByRole('button', { name: 'Save as new' }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  const stored = await libraryState(page);
  expect(stored.queries.find((q) => q.name === 'Formatted one').sql).toBe("SELECT count()\nFROM system.tables\nWHERE database = 'system'");
  expect(stored.queries.find((q) => q.name === 'Raw one').sql).toBe("select count() from system.tables where database = 'system'");
});

test('folder picker: the choice reads as a path, the tree opens on it and is browsed with the keys, the last places come first, Escape closes only the picker', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 7 AS seven');
  await showPanel(page);
  await clickSave(page);
  const picker = folderField(page);
  const trigger = picker.locator('.qlPicker__button');
  const panelOf = picker.locator('.qlPicker__panel');
  // When the picker is closed, it shows the top of the browser storage as a path.
  await expect(trigger).toContainText(LOCAL_ROOT);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(panelOf).toBeHidden();
  // When the picker is open, it shows the storages and their folders as a tree. A folder opens with
  // its twisty. A choice of a place closes the picker.
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(picker.locator('[role="treeitem"][data-key="local:f_merges"]')).toHaveCount(0);
  await picker.locator('[role="treeitem"][data-key="local:f_ops"] [data-twisty]').click();
  await picker.locator('[role="treeitem"][data-key="local:f_merges"] .qlPicker__row').click();
  await expect(panelOf).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger.locator('.qlPicker__crumb:not(.qlPicker__crumb--last)')).toHaveText([LOCAL_ROOT, 'Operations']);
  await expect(trigger.locator('.qlPicker__crumb--last')).toHaveText('Merges');
  await expect(picker).toHaveAttribute('data-path', '/Operations/Merges');
  // The choice is the folder where the query is saved. The tree behind the picker shows that
  // folder.
  await expect(page.locator('.qlRow--ghost')).toBeVisible();
  // Keys: Down opens the picker on the chosen place. Left goes to the parent of the place. Down
  // moves the selection. Enter chooses. Escape closes the picker and keeps the form and the dialog.
  await trigger.press('ArrowDown');
  await expect(picker.locator('[role="treeitem"][data-key="local:f_merges"][data-section="tree"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(picker.locator('[role="treeitem"][data-key="local:f_ops"][data-section="tree"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(picker.locator('[role="treeitem"][data-key="local:f_reports"][data-section="tree"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panelOf).toBeHidden();
  await expect(saveForm(page)).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(picker).toHaveAttribute('data-path', '/Operations/Merges');
  await trigger.press('ArrowDown');
  await picker.locator('[role="treeitem"][data-key="local:f_reports"][data-section="tree"]').focus();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveAttribute('data-path', '/Reports');
  // The places chosen last are first in the list. Each place shows its path.
  await trigger.click();
  const recent = picker.locator('[role="treeitem"][data-section="recent"]');
  await expect(recent).toHaveCount(2);
  await expect(recent.first()).toHaveAttribute('data-key', 'local:f_reports');
  await expect(recent.nth(1).locator('.qlPicker__path')).toHaveText(`${LOCAL_ROOT} / Operations`);
  await recent.nth(1).locator('.qlPicker__row').click();
  await expect(picker).toHaveAttribute('data-path', '/Operations/Merges');
  // The form saves the query where the picker says.
  await fillForm(page, { name: 'Picked' });
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.find((q) => q.name === 'Picked').folder_id).toBe('f_merges');
});

test('folder picker: with many folders a filter finds one by name and shows where it is', async ({ page }) => {
  const folders = Array.from({ length: 9 }, (_, i) => ({ id: `f_team${i}`, host_id: HOST, parent_id: null, name: `Team ${i}`, created_at_ms: now, updated_at_ms: now }));
  folders.push({ id: 'f_disks', host_id: HOST, parent_id: 'f_team3', name: 'Disks', created_at_ms: now, updated_at_ms: now });
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders, queries: [] } });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 8 AS eight');
  await showPanel(page);
  await clickSave(page);
  const picker = folderField(page);
  await picker.locator('.qlPicker__button').click();
  const filter = picker.locator('.qlPicker__filter');
  await expect(filter).toBeVisible();
  await filter.fill('disk');
  const rows = picker.locator('.qlPicker__tree [role="treeitem"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.qlPicker__path')).toHaveText(`${LOCAL_ROOT} / Team 3`);
  await filter.fill('nothing like it');
  await expect(picker.locator('.qlPicker__empty')).toBeVisible();
  await filter.fill('disk');
  await filter.press('Enter');
  await expect(picker).toHaveAttribute('data-path', '/Team 3/Disks');
  await expect(picker.locator('.qlPicker__panel')).toBeHidden();
});

test('every folder and storage says how many queries it holds, and its pane lists what is inside; a click on an entry opens it', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  // The tree shows the queries under each folder, subfolders included. It also shows the queries
  // under the storage. This happens before any folder is opened.
  const meta = (name) => node(page, name).locator(':scope > .qlRow .qlRow__meta');
  await expect(node(page, LOCAL_ROOT).locator(':scope > .qlRow .qlRow__count')).toHaveText('3 queries');
  await expect(meta('Operations')).toHaveText('2 queries');
  await expect(meta('Reports')).toHaveText('Empty');
  await expandFolder(page, 'Operations');
  await expect(meta('Merges')).toHaveText('1 query');
  // The pane of a folder lists its subfolders first. Then it lists its queries. Each item shows
  // what it holds.
  await selectItem(page, 'Operations');
  const entries = preview(page).locator('.qlContents__item');
  await expect(preview(page).locator('.qlContents__label')).toHaveText('In this folder');
  await expect(entries.locator('.qlContents__name')).toHaveText(['Merges', 'Active parts']);
  await expect(entries.nth(0).locator('.qlContents__meta')).toHaveText('1 query');
  await expect(entries.nth(1).locator('.qlContents__desc')).toHaveText('Active data parts per table');
  // A click on an entry opens it in the tree. The entry then shows its own pane.
  await entries.nth(0).click();
  await expect(node(page, 'Merges')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Merges');
  await expect(preview(page).locator('.qlContents__item .qlContents__name')).toHaveText(['Running merges']);
  await preview(page).locator('.qlContents__item').first().click();
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Running merges');
  // An empty folder says that it is empty. It also says how to fill it.
  await selectItem(page, 'Reports');
  await expect(preview(page).locator('.qlContents__empty')).toContainText('This folder is empty');
  // A storage shows its top level. Folders come first.
  await selectItem(page, LOCAL_ROOT);
  await expect(preview(page).locator('.qlContents__label')).toHaveText('In this library');
  await expect(preview(page).locator('.qlContents__item .qlContents__name')).toHaveText(['Operations', 'Reports', 'The answer']);
  await expect(preview(page).locator('.qlContents__item .qlContents__meta').first()).toHaveText('2 queries');
});

test('Save: a query that the formatter leaves as it is has no Formatted switch (there is one text to save)', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 1');
  await showPanel(page);
  await clickSave(page);
  const d = saveForm(page);
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText('SELECT 1');
  // The formatter answered with the same text. The toggle is removed. The label does not claim that
  // the text is formatted.
  await expect(d.locator('.qlForm__sql .sqlMode')).toBeHidden();
  await expect(d.locator('.qlForm__sql .uiField__label')).toHaveText('SQL (from the editor)');
  await fillForm(page, { name: 'Already formatted' });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.find((q) => q.name === 'Already formatted').sql).toBe('SELECT 1');
});

test('Save from History: the formatted text by default, the text as typed with the Formatted switch released; a script the formatter rejects is saved as typed', async ({ page }) => {
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] },
    'chdash.queryHistory.v1': [
      { ts_ms: Date.now() - 1000, sql_raw: 'select 1 as one from system.one', host_id: HOST, status: 'ok', elapsed_ms: 1, rows: 1 },
      { ts_ms: Date.now() - 2000, sql_raw: 'select ((( from', host_id: HOST, status: 'error', elapsed_ms: 1, rows: 0, error: 'Syntax error' },
    ],
  });
  await openApp(page);
  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await items.filter({ hasText: 'one' }).click();
  await previewTool(page, 'save').click();
  let d = saveForm(page);
  await expect(d).toContainText('SQL (from History');
  await expect(d.locator('.qlForm__sql .sqlMode')).toHaveAttribute('aria-pressed', 'true');
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText(/^SELECT\s+1 AS `?one`?\s+FROM system\.one$/);
  await d.locator('.qlForm__sql .sqlMode').click();
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText('select 1 as one from system.one');
  await fillForm(page, { name: 'From history raw' });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await libraryState(page)).queries.map((q) => q.sql)).toEqual(['select 1 as one from system.one']);
  // The formatter rejects a script. The switch is released and locked. Its title says why. The text
  // is saved as typed.
  await showPanel(page, 'history');
  await items.filter({ hasText: '(((' }).click();
  await previewTool(page, 'save').click();
  d = saveForm(page);
  await expect(d.locator('.qlForm__sql .sqlMode')).toHaveAttribute('aria-pressed', 'false');
  await expect(d.locator('.qlForm__sql .sqlMode')).toBeDisabled();
  await expect(d.locator('.qlForm__sql .sqlMode')).toHaveAttribute('title', /does not accept this query/);
  await expect(d.locator('.qlForm__sql .sqlBlock__code')).toHaveText('select ((( from');
  await fillForm(page, { name: 'Broken' });
  await d.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await libraryState(page)).queries.map((q) => q.sql)).toContain('select ((( from');
});

// --- Save and Edit are the form of the right pane (no window over the dialog) ---

const selectedRow = (page) => page.locator('#queryLibraryViewSaved li[role=treeitem][aria-selected="true"]');
// This is the floppy button of the editor. It sits between the copy button and the options cog. The
// editor is inert while the dialog is open. So a click that the test makes is the event itself. The
// handler is the same as for a real click.
const saveButton = (page) => page.locator('#editorSaveButton');
const clickSave = (page) => saveButton(page).dispatchEvent('click');
const focusIsInTree = (page) => page.evaluate(() => !!document.activeElement?.closest('#queryLibraryViewSaved .qlTree'));

test('Save opens no window: Saved shows the form in the right pane with Name focused; Escape drops the form first, the second Escape closes the dialog', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const editor = page.locator('#queryTextArea');
  await editor.fill('SELECT 1 AS one');
  // Ctrl+S with the library closed opens it on Saved. The form is in its pane.
  await editor.press('Control+s');
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#queryLibraryTabSaved')).toHaveAttribute('aria-selected', 'true');
  await expect(saveForm(page)).toBeVisible();
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(page.getByRole('form', { name: 'Save to library' })).toBeVisible();
  await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
  // The form has labelled fields. It also has the SQL that is saved with its label. The buttons are
  // in the foot of the pane.
  for (const label of ['Name', 'Description', 'Folder']) await expect(saveForm(page).getByLabel(label, { exact: true })).toBeVisible();
  await expect(saveForm(page).locator('.qlForm__sql .uiField__label')).toContainText('SQL (from the editor');
  await expect(saveForm(page).locator('.qlPreview__foot .button')).toHaveText(['Cancel', 'Save']);
  await expect(formButton(page, 'Save')).toHaveClass(/button--primary/);
  // The tree stays on the left and stays usable. The form is the pane, to the right of the tree.
  await expect(tree(page)).toBeVisible();
  const places = await page.evaluate(() => ({
    tree: document.querySelector('#queryLibraryViewSaved').getBoundingClientRect().right,
    form: document.querySelector('#queryLibraryPreview form').getBoundingClientRect().left,
    pane: document.querySelector('#queryLibraryPreview').getBoundingClientRect(),
    last: document.querySelector('#queryLibraryPreview form .qlPreview__foot .button:last-child').getBoundingClientRect(),
  }));
  expect(places.form).toBeGreaterThanOrEqual(places.tree - 1);
  expect(places.last.right).toBeLessThanOrEqual(places.pane.right + 0.5);
  expect(places.last.bottom).toBeLessThanOrEqual(places.pane.bottom + 0.5);
  // Press Escape. The form closes. The preview of the selection comes back. The dialog stays open.
  // The selected row has the focus.
  await page.keyboard.press('Escape');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(preview(page).locator('.qlPreview__title')).toBeVisible();
  await expect(selectedRow(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();

  // This test starts from the editor's button. Cancel puts the focus back in the list.
  await showPanel(page);
  await clickSave(page);
  await expect(saveForm(page)).toBeVisible();
  await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
  await formButton(page, 'Cancel').click();
  await expect(saveForm(page)).toHaveCount(0);
  expect(await focusIsInTree(page)).toBe(true);
  // Enter in the Name field saves the query. The toast appears. The query is selected in the tree,
  // and its preview is in the pane. The dialog stays the only dialog.
  await clickSave(page);
  await saveForm(page).locator('[name="name"]').fill('One');
  await saveForm(page).locator('[name="name"]').press('Enter');
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(node(page, 'One')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('One');
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 1 AS `one`');
  await expect(openDialogs(page)).toHaveCount(1);
  expect((await libraryState(page)).queries.find((q) => q.name === 'One')).toMatchObject({ folder_id: null, host_id: HOST });
  // Ctrl+S again, while the form is open, only focuses the form. The typed text stays.
  await page.keyboard.press('Control+s');
  await expect(saveForm(page)).toBeVisible();
  await saveForm(page).locator('[name="description"]').fill('typed');
  await page.keyboard.press('Control+s');
  await expect(saveForm(page).locator('[name="description"]')).toHaveValue('typed');
  await expect(saveForm(page).locator('[name="description"]')).toBeFocused();
});

test('Save with an empty editor says so and opens nothing', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  await page.locator('#queryTextArea').fill('');
  await page.locator('#queryTextArea').press('Control+s');
  await expect(page.locator('.qlToast')).toContainText('Write a query first');
  await expect(saveForm(page)).toHaveCount(0);
  await showPanel(page);
  await expect(saveButton(page)).toBeDisabled();
});

test('the editor has a floppy Save button between Copy and the options cog; the library foot has none; it opens the save form and waits for a query', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const editor = page.locator('#queryTextArea');
  await editor.fill('SELECT 1 AS `one`');
  // From the right, the order is: the options cog, Save, then Copy. So Copy is the leftmost of the
  // three buttons.
  const [copy, save, cog] = await Promise.all(['#editorCopyButton', '#editorSaveButton', '.editorAutocompleteControl__button'].map(async (selector) => (await page.locator(selector).boundingBox()).x));
  expect(copy).toBeLessThan(save);
  expect(save).toBeLessThan(cog);
  await expect(saveButton(page)).toHaveAttribute('aria-label', 'Save query');
  await expect(saveButton(page).locator('use')).toHaveAttribute('href', /#i-device-floppy$/);
  await expect(saveButton(page)).toHaveAttribute('title', /^Save query \((Ctrl|\u2318)\+S\)$/);
  // A real click opens the library on Saved, with the form. The Name field has the focus. The foot
  // has no Save button of its own.
  await saveButton(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(saveForm(page)).toBeVisible();
  await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
  await expect(page.locator('#queryLibraryViewSaved .ql__foot [data-action="save"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  // An empty editor has nothing to save. It also has nothing to copy.
  await editor.fill('');
  await expect(saveButton(page)).toBeDisabled();
  await editor.fill('SELECT 2');
  await expect(saveButton(page)).toBeEnabled();
});

test('Save from History: the library goes to Saved with the form, the draft stays when the tab changes, and the new query is selected after the save', async ({ page }) => {
  await seed(page, {
    'chdash.queryLibrary.v2': LIBRARY,
    'chdash.queryHistory.v1': [{ ts_ms: Date.now() - 1000, sql_raw: 'select 7 as seven', host_id: HOST, status: 'ok', elapsed_ms: 1, rows: 1 }],
  });
  await openApp(page);
  await showPanel(page, 'history');
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  await previewTool(page, 'save').click();
  await expect(page.locator('#queryLibraryTabSaved')).toHaveAttribute('aria-selected', 'true');
  await expect(saveForm(page)).toBeVisible();
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(saveForm(page).locator('.qlForm__sql .uiField__label')).toContainText('SQL (from History');
  await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
  // The draft stays when the other tab is shown.
  await saveForm(page).locator('[name="name"]').fill('Seven');
  await page.locator('#queryLibraryTabHistory').click();
  await expect(saveForm(page)).toHaveCount(0);
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await page.locator('#queryLibraryTabSaved').click();
  await expect(saveForm(page)).toBeVisible();
  await expect(saveForm(page).locator('[name="name"]')).toHaveValue('Seven');
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  await expect(node(page, 'Seven')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Seven');
  await expect(openDialogs(page)).toHaveCount(1);
  expect((await libraryState(page)).queries.find((q) => q.name === 'Seven').sql).toMatch(/^SELECT\s+7 AS `?seven`?$/);
});

test('update and Save as new: the editor holds a saved query, the form offers both; a folder picked in the tree moves it', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await loadSaved(page, 'The answer');
  await expect(panel(page)).toBeHidden();
  await page.locator('#queryTextArea').press('Control+s');
  await expect(formTitle(page)).toHaveText('Save “The answer”');
  await expect(saveForm(page).locator('.qlPreview__foot .button')).toHaveText(['Cancel', 'Save as new', 'Update']);
  await expect(formButton(page, 'Update')).toHaveClass(/button--primary/);
  await expect(saveForm(page).locator('[name="name"]')).toHaveValue('The answer');
  await expect(folderField(page)).toHaveAttribute('data-path', '/');
  // Pick Reports in the tree. Update then puts the query there.
  await node(page, 'Reports').locator(':scope > .qlRow').click();
  await expect(folderField(page)).toHaveAttribute('data-path', '/Reports');
  await formButton(page, 'Update').click();
  await expect(page.locator('.qlToast')).toContainText('Query updated.');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
  let stored = await libraryState(page);
  expect(stored.queries.filter((q) => q.name === 'The answer')).toHaveLength(1);
  expect(stored.queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');
  // Save as new creates a second query. The first query stays.
  await clickSave(page);
  await expect(formTitle(page)).toHaveText('Save “The answer”');
  await expect(folderField(page)).toHaveAttribute('data-path', '/Reports');
  await saveForm(page).locator('[name="name"]').fill('Answer copy');
  await formButton(page, 'Save as new').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  await expect(node(page, 'Answer copy')).toHaveAttribute('aria-selected', 'true');
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.name === 'Answer copy')).toMatchObject({ folder_id: 'f_reports' });
  expect(stored.queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'The answer', folder_id: 'f_reports' });
  await expect(openDialogs(page)).toHaveCount(1);
});

test('the folder follows the tree while the form is open, and what was typed survives every render of the tree', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 5 AS five');
  await showPanel(page);
  await expandFolder(page, 'Operations');
  await clickSave(page);
  await fillForm(page, { name: 'Draft', description: 'Typed text' });
  const name = saveForm(page).locator('[name="name"]');
  // A click on a folder, a root, an arrow, or a query sets the Folder.
  await node(page, 'Reports').locator(':scope > .qlRow').click();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_reports');
  await node(page, LOCAL_ROOT).focus();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await node(page, 'Merges').focus();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_merges');
  // The folder that the form names is open. The dashed row is in this folder. The arrow moves into
  // the folder, to its query.
  await page.keyboard.press('ArrowDown');
  await expect(selectedRow(page)).toHaveAttribute('data-id', 'q_merges');
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_merges');
  await node(page, 'Active parts').focus();
  await expect(selectedRow(page)).toHaveAttribute('data-id', 'q_parts');
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_ops');
  await node(page, 'The answer').focus();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await expect(name).toHaveValue('Draft');
  await expect(saveForm(page).locator('[name="description"]')).toHaveValue('Typed text');
  // A search draws the tree again. The form does not change. The tree still works.
  const search = page.locator('#queryLibraryViewSaved .qlSearch__input');
  await search.fill('merges');
  await expect(tree(page).locator('li[role=treeitem]')).toHaveCount(1);
  await expect(name).toHaveValue('Draft');
  await tree(page).locator('li[role=treeitem]').first().locator(':scope > .qlRow').click();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_merges');
  await search.fill('');
  await expect(node(page, 'Reports')).toBeVisible();
  // A folder closes and opens in the tree. The form shows no trace of this action.
  await node(page, 'Operations').locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(name).toHaveValue('Draft');
  // A new folder created while the form is open is in the list. The new folder is also chosen.
  await node(page, 'Reports').focus();
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('Fresh');
  await page.keyboard.press('Enter');
  await expect(node(page, 'Fresh')).toBeVisible();
  await expect(folderField(page)).toHaveAttribute('data-path', '/Reports/Fresh');
  await expect(name).toHaveValue('Draft');
  await expect(saveForm(page).locator('[name="description"]')).toHaveValue('Typed text');
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  const stored = await libraryState(page);
  const fresh = stored.folders.find((f) => f.name === 'Fresh');
  expect(stored.queries.find((q) => q.name === 'Draft')).toMatchObject({ folder_id: fresh.id, description: 'Typed text' });
  await expect(node(page, 'Draft')).toHaveAttribute('aria-selected', 'true');
});

test('Escape in the save form: from the tree, over a row menu, over a filled search and a folder name row, the form goes only when nothing nearer takes it', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 5 AS five');
  await showPanel(page);
  await clickSave(page);
  await expect(saveForm(page)).toBeVisible();
  // The menu of a row takes the Escape press.
  await node(page, 'The answer').focus();
  await page.keyboard.press('Shift+F10');
  await expect(rowMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  await expect(saveForm(page)).toBeVisible();
  // A filled search also takes the Escape press. The search is cleared. A folder name that the user
  // types also takes the Escape press.
  const search = page.locator('#queryLibraryViewSaved .qlSearch__input');
  await search.fill('answer');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(saveForm(page)).toBeVisible();
  await node(page, 'Reports').focus();
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await expect(newFolderInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);
  await expect(saveForm(page)).toBeVisible();
  // From the tree, from the search, or from the form itself, Escape removes the form. The dialog
  // stays open.
  await node(page, 'The answer').focus();
  await page.keyboard.press('Escape');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await clickSave(page);
  await search.focus();
  await page.keyboard.press('Escape');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await clickSave(page);
  await saveForm(page).locator('[name="description"]').press('Escape');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  // A second Escape closes the dialog.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  // Nothing was saved in this test.
  expect((await libraryState(page)).queries).toHaveLength(3);
});

test('Save: a missing or used name shows its message under the field (role alert, aria-invalid, focus), the form stays and nothing is saved', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 5 AS five');
  await showPanel(page);
  await clickSave(page);
  const name = saveForm(page).locator('[name="name"]');
  const error = saveForm(page).locator('#qlFormError-name');
  await formButton(page, 'Save').click();
  await expect(error).toHaveText('A name is required.');
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAttribute('aria-describedby', 'qlFormError-name');
  await expect(name).toBeFocused();
  await expect(saveForm(page)).toBeVisible();
  await expect(page.locator('.qlToast--error')).toHaveCount(0);
  expect((await libraryState(page)).queries).toHaveLength(3);
  // Text input clears it.
  await name.fill('x');
  await expect(error).toBeHidden();
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  // This test uses a name that the folder already holds.
  await name.fill('the answer');
  await name.press('Enter');
  await expect(error).toContainText('already exists in this folder');
  await expect(name).toBeFocused();
  await expect(saveForm(page)).toBeVisible();
  expect((await libraryState(page)).queries).toHaveLength(3);
  // The other folder accepts the name.
  await node(page, 'Reports').locator(':scope > .qlRow').click();
  await name.fill('the answer');
  await name.press('Enter');
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  expect((await libraryState(page)).queries.find((q) => q.name === 'the answer')).toMatchObject({ folder_id: 'f_reports' });
});

test('Edit is the same form in the pane: name, description and folder, the SQL only shown, the folder follows the tree', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await selectItem(page, 'The answer');
  await previewTool(page, 'edit').click();
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(formTitle(page)).toHaveText('Edit query');
  await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
  await expect(saveForm(page).locator('.qlForm__sql .sqlMode')).toHaveCount(0);
  await expect(saveForm(page).locator('.qlForm__sql .uiField__label')).toHaveText('SQL');
  await expect(saveForm(page).locator('.qlForm__sql .sqlBlock__code')).toHaveText('SELECT 42 AS answer');
  await expect(saveForm(page).locator('.qlPreview__foot .button')).toHaveText(['Cancel', 'Save']);
  // Cancel shows the preview again. The row has the focus.
  await formButton(page, 'Cancel').click();
  await expect(saveForm(page)).toHaveCount(0);
  await expect(node(page, 'The answer')).toBeFocused();
  await previewTool(page, 'edit').click();
  await node(page, 'Reports').locator(':scope > .qlRow').click();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_reports');
  await fillForm(page, { name: 'Renamed', description: 'Moved by the tree' });
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query updated.');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('Renamed');
  await expect(node(page, 'Renamed')).toHaveAttribute('aria-level', '3');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'Renamed', description: 'Moved by the tree', folder_id: 'f_reports', sql: 'SELECT 42 AS answer' });
  // The query is removed in the meantime. In this test, another tab removes it with a storage
  // event. The form then ends.
  await previewTool(page, 'edit').click();
  await expect(saveForm(page)).toBeVisible();
  await page.evaluate(() => {
    const lib = JSON.parse(localStorage.getItem('chdash.queryLibrary.v2'));
    lib.queries = lib.queries.filter((q) => q.id !== 'q_answer');
    lib.revision += 1;
    localStorage.setItem('chdash.queryLibrary.v2', JSON.stringify(lib));
    window.dispatchEvent(new StorageEvent('storage', { key: 'chdash.queryLibrary.v2' }));
  });
  await expect(saveForm(page)).toHaveCount(0);
  await expect(node(page, 'Renamed')).toHaveCount(0);
});

test('save, open, edit (name, description, SQL) and update the opened query with Ctrl+S; the foot is Load alone', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const editor = page.locator('#queryTextArea');

  // Save the editor with the + button of the panel.
  await closePanel(page);
  await editor.fill('SELECT count() FROM system.tables');
  await showPanel(page);
  await clickSave(page);
  // No window opens over the dialog. The form is the right pane. The fields are above the SQL that
  // they save.
  await expect(openDialogs(page)).toHaveCount(1);
  await expect(saveForm(page).locator('.qlPaneForm__fields')).toBeVisible();
  await expect(saveForm(page).locator('[name="tags"]')).toHaveCount(0);
  await fillForm(page, { name: 'Table count', description: 'How many tables', folder_id: '/Reports' });
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  await expect(node(page, 'Table count')).toBeVisible();
  let stored = await libraryState(page);
  const saved = stored.queries.find((q) => q.name === 'Table count');
  // The query is saved as the formatter writes it. The Formatted switch is pressed.
  expect(saved).toMatchObject({ folder_id: 'f_reports', host_id: HOST, description: 'How many tables', sql: 'SELECT count()\nFROM system.tables' });

  // A click selects a query. The preview shows the query. The editor does not change, and the
  // dialog stays open. The Load button (bottom right) loads the query. Load closes the dialog and
  // focuses the editor. The opened query is marked.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(node(page, 'The answer')).toHaveAttribute('aria-selected', 'true');
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 42 AS answer');
  await expect(panel(page)).toBeVisible();
  await expect(editor).toHaveValue('SELECT count() FROM system.tables');
  // The tools are the icon buttons of the head. The foot has only "Load", at the bottom right. The
  // foot has no Copy SQL, no Append to editor, and no Run.
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
  // The menu of the row has the same changes, and Load.
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

  // Ctrl+S on an opened query updates it in place. The panel can stay closed.
  await editor.fill('SELECT 42 AS answer, 43 AS next');
  await editor.press('Control+s');
  await expect(formTitle(page)).toHaveText('Save \u201cThe answer\u201d');
  await saveForm(page).getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.qlToast')).toContainText('Query updated');
  stored = await libraryState(page);
  // The update is also formatted. The Formatted switch is pressed.
  expect(stored.queries.find((q) => q.id === 'q_answer').sql).toBe('SELECT\n\t42 AS `answer`,\n\t43 AS `next`');
  expect(stored.queries.filter((q) => q.name === 'The answer')).toHaveLength(1);

  // Edit in the preview changes the name, the description and the folder. The SQL is only shown.
  // Ctrl+S, described above, updates the SQL from the editor.
  await closePanel(page);
  await editor.fill('SELECT 6 * 7 AS answer');
  await showPanel(page);
  await selectItem(page, 'The answer');
  await previewTool(page, 'edit').click();
  await expect(folderField(page)).toHaveAttribute('data-path', '/');
  await expect(saveForm(page).locator('[name="replace_sql"], .qlCheck')).toHaveCount(0);
  await expect(saveForm(page)).not.toContainText('Replace the SQL');
  await fillForm(page, { name: 'Answer', description: 'Douglas Adams' });
  await saveForm(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Answer')).toBeVisible();
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'Answer', description: 'Douglas Adams', sql: 'SELECT\n\t42 AS `answer`,\n\t43 AS `next`', host_id: HOST });

  // Copy uses the copy button of the SQL block.
  await captureCopies(page);
  const copy = preview(page).locator('.qlSql .sqlBlock__copy');
  await expect(copy).toHaveAttribute('aria-label', /^Copy /);
  await copy.click();
  await expect(copy).toHaveClass(/is-copied/);
  await expect.poll(() => copiedText(page)).toBe('SELECT\n\t42 AS `answer`,\n\t43 AS `next`');
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

  // Drag the query back to the top level, onto its root.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, LOCAL_ROOT).locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  // Drag the query again, then onto the tree background. This is the top level of the one root.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  const box = await tree(page).boundingBox();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(tree(page), { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');

  // Move to... for a query lists every folder as a path.
  await selectItem(page, 'The answer');
  await previewTool(page, 'move').click();
  expect(await pickerOptions(dialog(page))).toEqual(['/', '/Operations', '/Operations/Merges', '/Reports']);
  await pickPlace(dialog(page), '/Operations/Merges');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText('Moved to /Operations/Merges');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_merges');

  // Move to... for a folder does not offer its own subfolders.
  await selectItem(page, 'Operations');
  await previewTool(page, 'move').click();
  expect(await pickerOptions(dialog(page))).toEqual(['/', '/Reports']);
  await pickPlace(dialog(page), '/Reports');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '3');
  const stored = await libraryState(page);
  expect(stored.folders.find((f) => f.id === 'f_ops').parent_id).toBe('f_reports');
  expect(stored.folders.find((f) => f.id === 'f_merges').parent_id).toBe('f_ops');
  // A root does not move. It is not draggable, and it has no Move tool.
  await selectItem(page, LOCAL_ROOT);
  await expect(node(page, LOCAL_ROOT)).not.toHaveAttribute('draggable', 'true');
  expect(await toolNames(page)).toEqual(['New folder']);
});

test('rows: the "..." menu and the right click act on one row: Load, Move to..., Remove; Show in folder', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  await expandFolder(page, 'Operations');
  // The "..." button of a row opens its menu. A right click opens the same menu under the pointer.
  await openRowMenu(page, 'Active parts');
  expect(await menuLabels(page)).toEqual(['Load', 'Edit\u2026', 'Move to\u2026', 'Remove']);
  await page.keyboard.press('Escape');
  await node(page, 'Operations').locator(':scope > .qlRow').click({ button: 'right' });
  await expect(rowMenu(page)).toBeVisible();
  expect(await menuLabels(page)).toEqual(['Close', 'Rename', 'Move to\u2026', 'Export as JSON', 'Remove']);
  await page.keyboard.press('Escape');
  await expect(rowMenu(page)).toHaveCount(0);
  // A folder export includes everything in the folder. The export is the JSON that POST
  // /api/query-library/import takes.
  await node(page, 'Operations').locator(':scope > .qlRow').click({ button: 'right' });
  const [download] = await Promise.all([page.waitForEvent('download'), rowMenu(page).getByRole('menuitem', { name: 'Export as JSON' }).click()]);
  expect(download.suggestedFilename()).toBe('Operations.json');
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
  expect(exported.host_id).toBe(HOST);
  expect(exported.folders).toEqual([{ id: 'f_ops', parent_id: null, name: 'Operations' }, { id: 'f_merges', parent_id: 'f_ops', name: 'Merges' }]);
  expect(exported.queries.map((q) => [q.folder_id, q.name, q.sql])).toEqual([
    ['f_ops', 'Active parts', LIBRARY.queries[0].sql],
    ['f_merges', 'Running merges', LIBRARY.queries[1].sql],
  ]);
  expect(Object.keys(exported.queries[0]).sort()).toEqual(['created_at_ms', 'description', 'folder_id', 'name', 'sql', 'updated_at_ms']);
  await expect(page.locator('.qlToast')).toContainText('Exported 2 queries to Operations.json.');
  // There is no tick box and no bar. Change one row at a time.
  await expect(page.locator('#queryLibraryViewSaved .qlRow__check, #queryLibraryViewSaved .qlRow__box, #queryLibraryViewSaved .ql__bar')).toHaveCount(0);
  // The menu acts. Load fills the editor and closes the dialog.
  await openRowMenu(page, 'Active parts');
  await rowMenu(page).getByRole('menuitem', { name: /^Load/ }).click();
  await expect(page.locator('#queryTextArea')).toHaveValue(/FROM system\.parts/);
  await expect(panel(page)).toBeHidden();
  await showPanel(page);
  // Move to... opens the picker for this row. Remove asks first.
  await expandFolder(page, 'Operations');
  await openRowMenu(page, 'The answer');
  await rowMenu(page).getByRole('menuitem', { name: /^Move to/ }).click();
  await pickPlace(dialog(page), '/Reports');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect.poll(async () => (await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');
  await expandFolder(page, 'Reports');
  await openRowMenu(page, 'The answer');
  await rowMenu(page).getByRole('menuitem', { name: /^Remove/ }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Remove query');
  await dialog(page).getByRole('button', { name: 'Remove' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);

  // A search result has a menu with Show in folder. This item leaves the search and opens the
  // folders of the result.
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

  // Nothing is selected yet. The pane says how to fill it.
  const pane = preview(page);
  await expect(pane.locator('.qlPreview__empty')).toHaveText('Select a query to preview it here.');
  // A click selects the query. The pane shows the name, then "Updated ..." on its line. The time
  // uses ns.format. Its ISO value is in the tooltip. Then the pane shows the description and the
  // SQL, with the keywords highlighted. There is no Folder line.
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
  // The Back button is only in the phone step.
  await expect(pane.locator('.qlPreview__back')).toBeHidden();
  // The preview is a pane of the dialog. It is to the right of the list.
  const geometry = await page.evaluate(() => {
    const el = document.getElementById('queryLibraryPreview');
    const list = document.getElementById('queryLibraryViewSaved').getBoundingClientRect();
    return { inDialog: !!el.closest('dialog#queryLibraryMenu'), beside: el.getBoundingClientRect().left >= list.right - 1 };
  });
  expect(geometry).toEqual({ inDialog: true, beside: true });
  // Hover over another query changes nothing. Select the query to change the preview.
  const answer = node(page, 'The answer').locator(':scope > .qlRow');
  await answer.hover();
  // The row shows its hover state. Its handlers have run. Wait two frames after that.
  await expect.poll(() => answer.evaluate((el) => el.matches(':hover'))).toBe(true);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(pane.locator('.qlPreview__title')).toHaveText('Active parts');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(pane.locator('.qlPreview__title')).toHaveText('The answer');
  await expect(pane.locator('.qlPreview__description')).toHaveCount(0);
  await expect(pane.locator('.qlPreview__facts')).toHaveCount(0);
  // A click on the row of an open folder that is not selected selects the folder and leaves it
  // open. A click on a folder that is already selected (the blue frame) and open closes it. The
  // chevron does the same. A click on a closed folder opens it.
  const operationsRow = node(page, 'Operations').locator(':scope > .qlRow .qlRow__name');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-selected', 'false');
  await operationsRow.click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-selected', 'true');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'true');
  await operationsRow.click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'false');
  await operationsRow.click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'true');
  await node(page, 'Operations').locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'false');
  // A selected folder shows its path and its contents, with its tools. A folder has no description.
  await expect(pane.locator('.qlPreview__title')).toHaveText('Operations');
  await expect(pane.locator('.qlPreview__meta')).toHaveText(/^Updated /);
  await expect(pane.locator('.qlPreview__description')).toHaveCount(0);
  expect(await facts(page)).toEqual({ Path: `${LOCAL_ROOT} /Operations`, Contents: '2 queries \u00b7 1 subfolder' });
  await expect(pane.locator('.qlPreview__foot')).toHaveCount(0);
  expect(await toolNames(page)).toHaveLength(4);
  // A renamed query stays selected. Its preview shows the new name.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await node(page, 'The answer').press('F2');
  await fillForm(page, { name: 'Answer' });
  await saveForm(page).getByRole('button', { name: 'Save' }).click();
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
      // Icon only: there is no text. The button has a label and the same tooltip. The icon comes
      // from the sprite.
      expect(button.text).toBe('');
      expect(button.label).toBeTruthy();
      expect(button.title).toBe(button.label);
      expect(button.icon).toBe(icons[button.action]);
    }
  };
  // This is a saved query.
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').click();
  let shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['edit', 'move', 'delete']);
  // This is a folder.
  await selectItem(page, 'Operations');
  shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['rename', 'move', 'new-subfolder', 'delete']);
  // The heads of the lists have the same search row, in the same place. Saved is shown now. History
  // is below.
  const listHead = (tab) => page.evaluate((name) => {
    const head = document.querySelector(`#queryLibraryView${name} .ql__head`);
    const box = head.querySelector('.qlSearch').getBoundingClientRect();
    return { classes: [...head.children].map((el) => el.className.split(' ')[0]), search: [Math.round(box.x), Math.round(box.y), Math.round(box.height)] };
  }, tab);
  const savedHead = await listHead('Saved');
  // A History run has the same head. Its meta line shows the run's time and status.
  await showPanel(page, 'history');
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  shape = await head(page);
  check(shape);
  expect(shape.buttons.map((b) => b.action)).toEqual(['save']);
  // The run is formatted when it is looked at. The answer of /api/format replaces the shown text. A
  // quick run still reads the typed text. A slow run already reads the formatter's text, which
  // quotes the alias.
  await expect(preview(page).locator('.qlPreview__title')).toHaveText(/^SELECT 1 AS `?one`?$/);
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
  // Line numbers are on by default. The setting is chdash.editor.line_numbers.enabled.
  await node(page, 'Three lines').locator(':scope > .qlRow').click();
  const block = preview(page).locator('.qlSql');
  await expect(block).toHaveClass(/sqlBlock--gutter/);
  await expect(block.locator('.sqlBlock__gutter')).toHaveText('1\n2\n3');
  // Each number stays on its line. The lines scroll, and they do not wrap.
  await expect(block).not.toHaveClass(/sqlBlock--wrap/);
  // When the editor settings disable them, there is no gutter. The lines wrap.
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
  // The setting is remembered. It stays off after a reload.
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

  // The button opens the panel from the keyboard. The focus moves into the panel, to the search
  // field. Escape returns the focus to the button.
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

  // Arrow keys move the selection along the visible items. The root comes first. The preview
  // follows the selection.
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

  // Press F2 to edit. Press Enter to submit.
  await page.keyboard.press('F2');
  await expect(formTitle(page)).toHaveText('Edit query');
  await fillForm(page, { name: 'Answer 42' });
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toBeVisible();

  // Open the menu of the row with the keyboard. Use Shift+F10 or the context-menu key. The first
  // item has the focus. The arrow keys move in the menu. Escape closes the menu and returns the
  // focus to the row.
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

  // Space opens or closes a folder. Space does nothing on a query.
  await node(page, 'Reports').focus();
  await page.keyboard.press('Space');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'false');
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Space');
  await expect(panel(page)).toBeVisible();

  // Enter moves the focus to the preview, on "Load". Shift+Tab reaches the other controls of the
  // preview. Tab comes back to Load. Enter there loads the query and closes the panel.
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

  // Ctrl/Cmd+Enter loads the query at once. This works from the list or from the preview. It runs
  // nothing.
  const runs = async () => (await historyRecords(page)).length;
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

  // F2 on a folder renames the folder in its row.
  await page.keyboard.press('F2');
  await expect(newFolderInput(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);

  // Delete asks for a confirm. Enter confirms.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Delete');
  await expect(dialog(page)).toContainText('Remove \u201cAnswer 42\u201d');
  await dialog(page).getByRole('button', { name: 'Remove' }).focus();
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toHaveCount(0);

  // The arrow keys switch between the Saved and History tabs.
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
  // There is no Clear history button anywhere. The foot shows only the count line.
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
  // ns.format shows values such as "8 ms" and "1.23 s". The time of day uses the browser's local
  // time in 24 h format.
  await expect(ok.locator('.qhItem__elapsed')).toHaveText(/^\d+(\.\d+)? (\u00b5s|ms|s)$/);
  await expect(ok.locator('.qhItem__time')).toHaveText(/^\d\d:\d\d:\d\d$/);
  await expect(ok.locator('.qhItem__time')).toHaveAttribute('title', /^\d{4}-\d\d-\d\dT/);
  // The rows have no buttons and no menu. Every action is in the preview.
  await expectNoItemMenu(page, ok);

  // A click selects a run. The head shows its SQL, then its time and status. Below the head, the
  // preview shows the elapsed time, the rows and the SQL. The preview has its tools: Save to
  // library and Remove. The foot has only "Load".
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
  // History is the browser's record of what ran. No run can be removed, by a tool or by a key.
  await expect(previewTool(page, 'remove')).toHaveCount(0);
  const runs = await page.locator('.qhItem').count();
  await ok.focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.qhItem')).toHaveCount(runs);
  expect((await historyRecords(page)).length).toBeGreaterThanOrEqual(runs);
  await expect(footLabels(page)).toHaveText(['Load']);
  await expect(panel(page)).toBeVisible();
  // The preview of a failed run shows the server error.
  await failed.click();
  await expect(pane.locator('.qlPreview__meta')).toContainText('Failed');
  await expect(pane.locator('.qlPreview__error')).toContainText(/__missing_history_table/);
  // The arrow keys move the selection. The preview follows.
  await page.keyboard.press('ArrowDown');
  await expect(ok).toBeFocused();
  await expect(pane.locator('.qlPreview__meta')).toContainText('Succeeded');

  // Copy uses the button of the SQL block.
  await captureCopies(page);
  await pane.locator('.qlSql .sqlBlock__copy').click();
  await expect.poll(() => copiedText(page)).toContain('numbers(7)');

  // Search.
  const search = page.locator('#queryLibraryViewHistory .qlSearch__input');
  await search.fill('older');
  await expect(items).toHaveCount(1);
  await search.fill('');
  await expect(items).toHaveCount(4);

  // Load loads the SQL only, not the run. The panel closes.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page, 'history');
  // Load formats a run that was not formatted. This is an entry of the seed. The editor gets the
  // formatter's text.
  await items.filter({ hasText: 'older' }).click();
  await previewAction(page, 'load').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT \'older\' AS `tag`');
  await expect(page.locator('#queryTextArea')).toBeFocused();

  // Save to library uses the History preview.
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).click();
  await previewTool(page, 'save').click();
  await expect(saveForm(page)).toContainText('SQL (from History');
  expect(await pickerGroups(saveForm(page))).toEqual({ [LOCAL_ROOT]: ['/'] });
  await fillForm(page, { name: 'Older one' });
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  // The submit of the dialog is asynchronous. First it validates the input. Then the adapter writes
  // the query.
  await expect.poll(async () => (await libraryState(page)).queries.map((q) => [q.sql, q.host_id])).toEqual([['SELECT \'older\' AS `tag`', HOST]]);

  // The save ends on Saved, and the new query is selected. History is one click away.
  await expect(page.locator('#queryLibraryTabSaved')).toHaveAttribute('aria-selected', 'true');
  await showPanel(page, 'history');

  // No run is removed. Neither the preview nor the Delete key removes a run from History.
  await items.filter({ hasText: 'oldest' }).click();
  await expect(previewTool(page, 'remove')).toHaveCount(0);
  await items.filter({ hasText: 'older' }).focus();
  await page.keyboard.press('Delete');
  await expect(items.filter({ hasText: 'older' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'oldest' })).toHaveCount(1);
  expect((await historyState(page)).some((h) => h.sql_raw.includes('oldest'))).toBe(true);
  // With the keyboard, Enter moves the focus to the Load button of the preview.
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

  // Switch the host in the header. The library then shows the entries of the other host.
  await closePanel(page);
  await pickHost(page, 'other');
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await expect(node(page, 'Operations')).toHaveCount(0);
  await expect(footCount(page)).toContainText('2 queries \u00b7 other');
  // The selection belonged to the other host. Nothing is previewed.
  await expect(preview(page).locator('.qlPreview__empty')).toBeVisible();
  await selectItem(page, 'The answer');
  await expect(preview(page).locator('.qlSql')).toContainText('SELECT 43');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on other/]);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toContainText('other');

  // A save goes to the selected host. Only the folders of that host are offered.
  await page.locator('#queryLibraryTabSaved').click();
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT \'saved on other\'');
  await page.locator('#queryTextArea').press('Control+s');
  expect(await pickerOptions(saveForm(page))).toEqual(['/', '/Other ops']);
  await fillForm(page, { name: 'Saved on other', folder_id: '/Other ops' });
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  const stored = await libraryState(page);
  expect(stored.queries.find((q) => q.name === 'Saved on other')).toMatchObject({ host_id: 'other', folder_id: 'f_other' });
  expect(stored.queries.filter((q) => q.host_id === HOST)).toHaveLength(3);

  // A host switch renders the open dialog again.
  await showPanel(page);
  await expect(node(page, 'Other ops')).toBeVisible();
  await page.evaluate((id) => window.ChDash.header.setSelectedHostId(id), HOST);
  await expect(node(page, 'Operations')).toBeVisible();
  await expect(node(page, 'Other ops')).toHaveCount(0);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on local/]);
  await page.evaluate(() => window.ChDash.header.setSelectedHostId('other'));
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveText([/ran on other/]);
});

test('the library opens in the profiling dialog: same shell, size and tabs, the tabs in the head instead of a title; Escape, backdrop and close; focus in, trapped and back', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openApp(page);
  const button = page.locator('#queryLibraryButton');
  // This is an icon button like Format. It sits between Format and the run settings cog.
  await expect(button).toHaveAttribute('aria-label', 'Query library');
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
  // The open-book icon is the sprite's book, like the Format icon.
  await expect(button.locator('.queryLibraryButton__icon')).toBeVisible();
  await expect(button.locator('.queryLibraryButton__icon use')).toHaveAttribute('href', /#i-book$/);
  const toolbar = await page.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const f = box('formatButton'); const b = box('queryLibraryButton'); const c = box('runSettingsButton');
    const style = (id) => { const cs = getComputedStyle(document.getElementById(id)); return [cs.width, cs.height, cs.borderRadius, cs.backgroundColor]; };
    return { order: f.right <= b.left && b.right <= c.left, sameLine: Math.abs((b.top + b.bottom) / 2 - (f.top + f.bottom) / 2) <= 2, sameStyle: JSON.stringify(style('formatButton')) === JSON.stringify(style('queryLibraryButton')) };
  });
  expect(toolbar).toEqual({ order: true, sameLine: true, sameStyle: true });
  // No part of the dialog exists before it first opens.
  await expect(panel(page)).toHaveCount(0);

  // This test compares the shell of the library and the shell of the profiling dialog, side by
  // side.
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
  // Saved and History are in the head, in the place of a title. The head has no title and no
  // subtitle. The dialog is named by aria-label. The close button stays in the head. No tab bar is
  // under the head.
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
  // The underline of the selected tab is on the bottom border of the head.
  const underline = await page.evaluate(() => {
    const h = document.querySelector('#queryLibraryMenu .uiDialog__head').getBoundingClientRect();
    const t = document.getElementById('queryLibraryTabSaved').getBoundingClientRect();
    return Math.round(h.bottom - t.bottom);
  });
  expect(Math.abs(underline)).toBeLessThanOrEqual(1);
  // The focus moves into the dialog, to the search field. The page behind the dialog is inert.
  await expect(page.locator('#queryLibraryViewSaved .qlSearch__input')).toBeFocused();
  expect(await page.evaluate(() => document.elementFromPoint(5, 5) === document.getElementById('queryLibraryMenu'))).toBe(true);
  // Tab cycles inside the dialog and its browser chrome. Tab never moves to the page.
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const el = document.activeElement;
      return el === document.body || !!el?.closest('#queryLibraryMenu');
    })).toBe(true);
  }
  // Escape closes the dialog. The focus returns to the book button.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // A click on the backdrop closes the dialog. The close button also closes the dialog.
  await button.click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(10, page.viewportSize().height - 10);
  await expect(panel(page)).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  // A click inside the dialog keeps it open. A press that ends outside also keeps it open.
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

  // The profiling dialog uses the same element, classes, geometry, head, close button, backdrop and
  // tab style.
  await runSuccessfulQuery(page, 'SELECT count() FROM numbers(1000)', { profiling: true });
  await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
  await settled(page.locator('#analysisModal'));
  const profiling = await shellOf('#analysisModal');
  // The profiling dialog keeps its title. Its tabs are under the head.
  await expect(page.locator('#analysisModal .uiDialog__head .uiDialog__title')).toHaveText('Query analysis');
  await expect(page.locator('#analysisModal > .uiDialog__frame > .uiDialog__tabs')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#analysisModal')).toBeHidden();
  const { head: profilingHead, ...profilingShell } = profiling;
  const { head: libraryHead, ...libraryShell } = library;
  expect(profilingShell).toEqual(libraryShell);
  expect(Math.abs(profilingHead - libraryHead)).toBeLessThanOrEqual(2);
  expect(library.classes).toEqual(['uiDialog', 'uiDialog--lg']);

  // A prompt opened from the library is over the library. Escape closes only the prompt. The focus
  // returns to the library.
  await button.click();
  await expect(tree(page)).toBeVisible();
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewTool(page, 'move').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator('.qlPicker [role="treeitem"][aria-selected="true"]')).toBeFocused();
  expect(await page.evaluate(() => [...document.querySelectorAll('dialog:modal')].map((d) => d.id || d.className))).toEqual(['queryLibraryMenu', 'uiDialog uiDialog--sm qlDialog']);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('#queryLibraryMenu'))).toBe(true);

  // The dialog is closed and reopened at once. The browser sends its "close" event one task later.
  // The dialog stays the top dialog. So its menus and toasts appear in it.
  await page.evaluate(async () => {
    window.ChDash.queryUi.closeQueryLibrary();
    window.ChDash.queryUi.openQueryLibrary();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await expect(panel(page)).toBeVisible();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.ChDash.dialog.host().id)).toBe('queryLibraryMenu');
  // Edit... is the form of the pane, not a prompt. The library stays the only dialog. Escape
  // removes the form only.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewTool(page, 'edit').click();
  await expect(saveForm(page)).toBeVisible();
  expect(await page.evaluate(() => [...document.querySelectorAll('dialog:modal')].map((d) => d.id || d.className))).toEqual(['queryLibraryMenu']);
  await page.keyboard.press('Escape');
  await expect(saveForm(page)).toHaveCount(0);
  await expect(preview(page).locator('.qlPreview__title')).toHaveText('The answer');
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

  // The split between the editor and the results is remembered across sessions. It uses
  // localStorage.
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
    // The block of the pane is drawn. A click on a History row shows the preview one frame later. A
    // busy host takes a few more frames.
    await expect(block).toBeVisible();
    await expect.poll(() => block.evaluate((el) => el.scrollHeight)).toBeGreaterThan(0);
    const before = await block.evaluate((el) => ({ client: [el.clientWidth, el.clientHeight], scroll: [el.scrollWidth, el.scrollHeight] }));
    // The block fits in the pane. It does not push the content of the pane out. It has more content
    // to show.
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
  // The copy button sits left of the scrollbar of the body. It does not sit over the scrollbar.
  const clear = await preview(page).locator('.qlSql').evaluate((el) => {
    const body = el.querySelector('.sqlBlock__body').getBoundingClientRect();
    const bar = el.querySelector('.sqlBlock__body').offsetWidth - el.querySelector('.sqlBlock__body').clientWidth;
    return { bar, gap: body.right - bar - el.querySelector('.sqlBlock__copy').getBoundingClientRect().right };
  });
  expect(clear.gap).toBeGreaterThanOrEqual(0);
  // A short query is as tall as its line. The block is not stretched to the pane.
  await selectItem(page, 'Short one');
  expect(await block.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect((await preview(page).locator('.qlSql').boundingBox()).height).toBeLessThan(80);
  // The preview of History is the same block.
  await page.locator('#queryLibraryTabHistory').click();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  await scrolls();
});

// --- Server storage (mocked API) ----------------------------------------------

// This is an in-memory /api/query-library. Reads are per host, and they need host_id. Writes are
// stamped with their host and a revision. The server reports If-Match conflicts. It supports
// read-only mode and the copy mode of the import. In copy mode, a folder moves in from the
// browser's root. The server has no history route. The History belongs to the browser.
//
// GET /api/query-library answers with the children of a folder (src/query_library_read.cpp).
// Folders come first, then queries by name. The answer has as many levels as fit within `limit`
// items. Each item has the minimal data. A first level that is larger than a page is sent in
// windows (`cursor`).
function pageOf(server, host, parentId, cursor, limit) {
  const byName = (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : 1);
  const folders = server.folders.filter((f) => f.host_id === host);
  const queries = server.queries.filter((q) => q.host_id === host);
  const subFolders = (id) => folders.filter((f) => (f.parent_id || null) === (id || null)).sort(byName);
  const subQueries = (id) => queries.filter((q) => (q.folder_id || null) === (id || null)).sort(byName);
  const under = (id) => queries.filter((q) => { for (let cur = q.folder_id; cur; cur = folders.find((f) => f.id === cur)?.parent_id) if (cur === id) return true; return false; }).length;
  const children = (id) => subFolders(id).length + subQueries(id).length;
  const first = [...subFolders(parentId), ...subQueries(parentId)];
  const out = { folders: [], queries: [], loaded: new Set(), depth: 0, complete: false, nextCursor: null };
  const addFolder = (f) => out.folders.push({ id: f.id, parent_id: f.parent_id || null, name: f.name, updated_at_ms: f.updated_at_ms, query_count: under(f.id), child_count: children(f.id), subfolder_count: subFolders(f.id).length });
  const done = () => ({
    parent_id: parentId, depth: out.depth, complete: out.complete, next_cursor: out.nextCursor, level_total: first.length,
    totals: { folders: folders.length, queries: queries.length, parent_queries: parentId ? under(parentId) : queries.length },
    folders: out.folders.map((f) => ({ ...f, loaded: out.loaded.has(f.id) })),
    queries: out.queries.map((q) => ({ id: q.id, folder_id: q.folder_id || null, name: q.name, updated_at_ms: q.updated_at_ms })),
  });
  if (first.length > limit) {
    for (const item of first.slice(cursor, cursor + limit)) (item.parent_id !== undefined && folders.includes(item) ? addFolder(item) : out.queries.push(item));
    if (cursor + limit < first.length) out.nextCursor = cursor + limit;
    return done();
  }
  for (const f of subFolders(parentId)) addFolder(f);
  for (const q of subQueries(parentId)) out.queries.push(q);
  let total = first.length;
  let frontier = subFolders(parentId);
  while (frontier.length) {
    const next = frontier.reduce((n, f) => n + children(f.id), 0);
    if (next === 0 || total + next > limit) break;
    const nextFrontier = [];
    for (const f of frontier) {
      out.loaded.add(f.id);
      for (const child of subFolders(f.id)) { addFolder(child); nextFrontier.push(child); }
      for (const q of subQueries(f.id)) out.queries.push(q);
    }
    total += next;
    out.depth += 1;
    frontier = nextFrontier;
  }
  out.complete = true;
  for (const f of out.folders) { if (f.child_count === 0) out.loaded.add(f.id); if (!out.loaded.has(f.id)) out.complete = false; }
  return done();
}

async function mockServerLibrary(page, { writable = true, conflicts = 0, library = LIBRARY } = {}) {
  const server = {
    revision: 10,
    folders: structuredClone(library.folders),
    queries: structuredClone(library.queries),
    requests: [],
    conflicts,
    // Another client makes a change at the moment of a conflict. The onConflict(server) function
    // edits the library.
    onConflict: null,
    // The next GET requests for the library fail. This simulates a dropped connection after a
    // change went through.
    failNextGet: 0,
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
      if (server.failNextGet > 0) {
        server.failNextGet -= 1;
        return route.abort('failed');
      }
      if (!host) return missingHost(route);
      const parent = url.searchParams.get('parent_id') || null;
      if (parent && !server.folders.some((f) => f.id === parent && f.host_id === host)) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'no such folder' });
      return json(route, 200, {
        host_id: host, revision: server.revision, updated_at_ms: now, writable, load_error: null,
        ...pageOf(server, host, parent, Number(url.searchParams.get('cursor')) || 0, Math.min(100, Number(url.searchParams.get('limit')) || 100)),
      });
    }
    // One whole query is read. A search is one read. An export of a folder, or of the host, is also
    // one read. The page makes these reads when it needs more than one page.
    const wantedQuery = method === 'GET' ? /^\/queries\/([^/?]+)$/.exec(path) : null;
    if (wantedQuery) {
      const found = server.queries.find((q) => q.id === decodeURIComponent(wantedQuery[1]) && q.host_id === host);
      if (!found) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'no such query' });
      const ancestors = [];
      for (let cur = found.folder_id; cur; cur = server.folders.find((f) => f.id === cur)?.parent_id) ancestors.unshift(cur);
      return json(route, 200, { ...found, revision: server.revision, ancestors, path: `/${ancestors.map((id) => server.folders.find((f) => f.id === id)?.name).join('/')}` });
    }
    if (method === 'GET' && path === '/search') {
      const words = (url.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return json(route, 400, { error: 'validation', error_code: 'validation', field: 'q', reason: 'required', message: 'q is required' });
      const pathOf = (q) => { const names = []; for (let cur = q.folder_id; cur; cur = server.folders.find((f) => f.id === cur)?.parent_id) names.unshift(server.folders.find((f) => f.id === cur)?.name); return `/${names.join('/')}`; };
      const hits = server.queries.filter((q) => q.host_id === host && words.every((w) => `${q.name}\n${q.description || ''}\n${q.sql}\n${pathOf(q)}`.toLowerCase().includes(w))).sort((a, b) => a.name.localeCompare(b.name));
      return json(route, 200, { host_id: host, revision: server.revision, total: hits.length, truncated: hits.length > 100, results: hits.slice(0, 100).map((q) => ({ id: q.id, folder_id: q.folder_id, name: q.name, updated_at_ms: q.updated_at_ms, path: pathOf(q) })) });
    }
    if (method === 'GET' && path === '/export') {
      const root = url.searchParams.get('folder_id');
      const keep = new Set();
      if (root) { const walk = (id) => { keep.add(id); for (const f of server.folders.filter((x) => x.parent_id === id)) walk(f.id); }; walk(root); }
      return json(route, 200, {
        host_id: host, revision: server.revision, writable, load_error: null,
        folders: server.folders.filter((f) => f.host_id === host && (!root || keep.has(f.id))),
        queries: server.queries.filter((q) => q.host_id === host && (!root || (q.folder_id && keep.has(q.folder_id)))),
      });
    }
    // The server has no history. A page that asks for history has a bug.
    if (path.startsWith('/history')) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'no such route' });
    if (!writable) return json(route, 403, { error: 'read_only', error_code: 'read_only', message: 'the query library is read-only' });
    if (headers['if-match'] && Number(headers['if-match']) !== server.revision) {
      return json(route, 409, { error: 'conflict', error_code: 'conflict', message: 'the library changed', revision: server.revision });
    }
    if (server.conflicts > 0) {
      server.conflicts -= 1;
      server.revision += 1; // someone else changed the library meanwhile
      if (server.onConflict) server.onConflict(server);
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
  // Both roots are open. The tree shows the server's folders and queries, and the browser's folders
  // and queries.
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-level', '2');
  await expect(node(page, 'The answer')).toHaveAttribute('data-store', 'server');
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'local');
  // Each root counts its queries. The foot counts both roots.
  await expect(roots.nth(0).locator(':scope > .qlRow .qlRow__count')).toHaveText('3 queries');
  await expect(roots.nth(1).locator(':scope > .qlRow .qlRow__count')).toHaveText('1 query');
  await expect(footCount(page)).toHaveText(`4 queries · ${HOST}`);
  // The preview of a root shows what the root is, and its contents. New folder is the only tool.
  await selectItem(page, SERVER_ROOT);
  await expect(preview(page).locator('.qlPreview__description')).toContainText('Shared by everyone');
  await expect(preview(page).locator('.qlPreview__meta')).toHaveText('3 queries · 3 subfolders');
  expect(await toolNames(page)).toEqual(['New folder']);
  await selectItem(page, LOCAL_ROOT);
  await expect(preview(page).locator('.qlPreview__description')).toContainText('Only this browser');
  // A root closes and opens. Its state is remembered.
  await node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(node(page, SERVER_ROOT)).toHaveAttribute('aria-expanded', 'false');
  await expect(node(page, 'Operations')).toHaveCount(0);
  await page.reload();
  await showPanel(page);
  await expect(node(page, SERVER_ROOT)).toHaveAttribute('aria-expanded', 'false');
  await node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(node(page, 'Operations')).toBeVisible();
  // The save picker shows both roots, each with its folders. The server's root comes first.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 2 AS two');
  await page.locator('#queryTextArea').press('Control+s');
  expect(await pickerGroups(saveForm(page))).toEqual({
    [SERVER_ROOT]: ['/', '/Operations', '/Operations/Merges', '/Reports'],
    [LOCAL_ROOT]: ['/'],
  });
  // This test saves into the browser's root.
  await fillForm(page, { name: 'Two' });
  await pickPlace(saveForm(page), 'local:');
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.map((q) => q.name).sort()).toEqual(['Mine', 'Two']);
  // A search covers both roots. Each result names its root.
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

  // A query moves from the browser to the server, with Move to... . The picker shows both roots.
  await selectItem(page, 'Mine');
  await previewTool(page, 'move').click();
  expect(await pickerGroups(dialog(page))).toEqual({ [SERVER_ROOT]: ['/', '/Operations', '/Operations/Merges', '/Reports'], [LOCAL_ROOT]: ['/', '/Local folder', '/Local folder/Sub'] });
  await pickPlace(dialog(page), '/Operations');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${SERVER_ROOT} /Operations.`);
  const copied = server.queries.find((q) => q.name === 'Mine');
  expect(copied).toMatchObject({ host_id: HOST, folder_id: 'f_ops', sql: 'SELECT 1', description: 'one' });
  expect(server.requests.find((r) => r.method === 'POST' && r.path === '/queries').ifMatch).toBe('10');
  expect((await libraryState(page)).queries.map((q) => q.id)).not.toContain('q_mine');
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'server');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-level', '3');
  await expect(node(page, 'Mine')).toHaveAttribute('aria-selected', 'true');

  // A query moves from the server to the browser. This is a drag and drop onto the browser's root.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, LOCAL_ROOT).locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast')).toContainText(`Moved to ${LOCAL_ROOT} /.`);
  expect(server.queries.find((q) => q.id === 'q_answer')).toBeUndefined();
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/queries/q_answer')).toBe(true);
  expect((await libraryState(page)).queries.find((q) => q.name === 'The answer')).toMatchObject({ folder_id: null, sql: 'SELECT 42 AS answer', host_id: HOST });
  await expect(node(page, 'The answer')).toHaveAttribute('data-store', 'local');

  // A folder with everything in it moves from the browser to the server. The page sends one copy
  // request (POST /import, copy mode) under the target folder. Then the browser's copy is removed.
  await selectItem(page, 'Local folder');
  await previewTool(page, 'move').click();
  await pickPlace(dialog(page), '/Reports');
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

  // A folder moves from the server to the browser. The folder is Operations, with Merges and two
  // queries.
  await selectItem(page, 'Operations');
  await previewTool(page, 'move').click();
  await pickPlace(dialog(page), 'local:');
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

  // The dialog refuses a name clash in the target. Nothing is copied or removed.
  await selectItem(page, SERVER_ROOT);
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('Operations');
  await page.keyboard.press('Enter');
  await expect(tree(page).locator('li[data-store="server"][data-kind="folder"]').filter({ has: page.locator(':scope > .qlRow .qlRow__name', { hasText: /^Operations$/ }) })).toHaveCount(1);
  const requests = server.requests.length;
  const localOps = tree(page).locator('li[data-store="local"][data-kind="folder"]').filter({ has: page.locator(':scope > .qlRow .qlRow__name', { hasText: /^Operations$/ }) });
  await localOps.focus();
  await previewTool(page, 'move').click();
  await pickPlace(dialog(page), 'server:');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  expect(server.requests.slice(requests).filter((r) => r.method !== 'GET')).toEqual([]);
  expect((await libraryState(page)).folders.some((f) => f.name === 'Operations')).toBe(true);
});

test('server storage: a conflict does not replay an edit of an item that someone else changed meanwhile (ARCH-F-085)', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true, conflicts: 1 });
  // At the moment of the conflict, another client renames the same query. This page is about to
  // rename that query too.
  server.onConflict = (state) => {
    const query = state.queries.find((q) => q.id === 'q_answer');
    query.name = 'Their name';
    query.updated_at_ms += 5000;
  };
  await seed(page, { 'chdash.queryLibrary.v2': null });
  await openLibrary(page);
  await selectItem(page, 'The answer');
  await previewTool(page, 'edit').click();
  await fillForm(page, { name: 'My name' });
  await saveForm(page).getByRole('button', { name: /save/i }).click();
  await expect(saveForm(page).locator('.qlPaneForm__error')).toContainText('changed by someone else');
  await page.keyboard.press('Escape');
  // The page sends one PATCH. It does not replay the request. The name of the other client stays on
  // the server.
  expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  expect(server.queries.find((q) => q.id === 'q_answer').name).toBe('Their name');
});

test('server storage: a change that went through is not announced as failed when the reload after it fails (ARCH-F-084)', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true });
  await seed(page, { 'chdash.queryLibrary.v2': null });
  await openLibrary(page);
  await selectItem(page, SERVER_ROOT);
  server.failNextGet = 1;
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('Reloaded later');
  await page.keyboard.press('Enter');
  // The folder exists on the server. It shows after the library is read again. Nothing tells the
  // user that the change failed.
  await expect(node(page, 'Reloaded later')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.qlToast--error')).toHaveCount(0);
  await expect(page.locator('#queryLibraryViewSaved .qlRow__error')).toHaveCount(0);
  expect(server.folders.some((f) => f.name === 'Reloaded later')).toBe(true);
});

test('a description longer than the form takes is read whole, never cut on the way in (ARCH-F-086)', async ({ page }) => {
  const long = 'd'.repeat(10_000);
  await seed(page, { 'chdash.queryLibrary.v2': { ...LIBRARY, queries: [...LIBRARY.queries, { id: 'q_long', folder_id: null, name: 'Long description', description: long, sql: 'SELECT 1', host_id: HOST, created_at_ms: now, updated_at_ms: now }] } });
  await openLibrary(page);
  await selectItem(page, 'Long description');
  await expect(preview(page).locator('.qlPreview__description')).toHaveText(long);
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

  // Create a query in the server's root, which is the default. The first attempt conflicts. The
  // library is reloaded. The retry is accepted.
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

  // The row shows a server validation error for a duplicate name.
  await selectItem(page, SERVER_ROOT);
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await newFolderInput(page).fill('shared');
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryLibraryViewSaved .qlRow__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(newFolderInput(page)).toHaveCount(0);

  // Two conflicts in a row. The user sees a message, and the library is reloaded.
  server.conflicts = 2;
  await selectItem(page, 'The answer');
  await previewTool(page, 'move').click();
  await pickPlace(dialog(page), '/Shared');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  // The dialog says that the library was reloaded. Escape stops the action.
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('changed by someone else');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');

  // The move and the recursive remove use the API.
  await expect(panel(page)).toBeVisible();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Shared').locator(':scope > .qlRow'));
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '3');
  expect(server.queries.find((q) => q.id === 'q_answer').folder_id).toBe(server.folders.find((f) => f.name === 'Shared').id);
  await selectItem(page, 'Operations');
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove all' }).click();
  await expect(node(page, 'Operations')).toHaveCount(0);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/folders/f_ops?recursive=1')).toBe(true);
  // A saved query is stamped with its host.
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 7 AS seven');
  await page.locator('#queryTextArea').press('Control+s');
  await fillForm(page, { name: 'Seven' });
  await pickPlace(saveForm(page), 'server:');
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect(server.requests.filter((r) => r.method === 'POST' && r.path === '/queries').at(-1).body).toMatchObject({ host_id: HOST, name: 'Seven', sql: 'SELECT 7 AS `seven`' });
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

  // The server refuses a move when the folder moved to another host. This happens behind the page's
  // back: 400 host_mismatch. The page tells the user, and nothing moves.
  await page.locator('#queryLibraryTabSaved').click();
  await page.evaluate((id) => window.ChDash.header.setSelectedHostId(id), HOST);
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
  // No request about the History reached the server.
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
  // New folder and Save in the list act on the browser's root.
  await expect(page.locator('#queryLibraryViewSaved .ql__actions')).toBeVisible();
  // Nothing in the server's root can be dragged. Items in the browser's root can be dragged.
  await expect(tree(page).locator('li[data-store="server"][draggable="true"]')).toHaveCount(0);
  await expect(node(page, 'Mine')).toHaveAttribute('draggable', 'true');
  // The menu of the server only lists the actions that a read-only item allows.
  await openRowMenu(page, 'The answer');
  expect(await menuLabels(page)).toEqual(['Load']);
  await page.keyboard.press('Escape');

  // The items and the root of the server have no tools. A query keeps Load.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(footLabels(page)).toHaveText(['Load']);
  await selectItem(page, 'Operations');
  await expect(preview(page).locator('.qlPreview__tools, .qlPreview__foot')).toHaveCount(0);
  await selectItem(page, SERVER_ROOT);
  await expect(preview(page).locator('.qlPreview__tools')).toHaveCount(0);
  await expect(preview(page).locator('.qlPreview__meta')).toContainText('Read-only');
  // The query of the browser keeps its tools. Its Move picker shows the server root, but the root
  // is disabled.
  await selectItem(page, 'Mine');
  expect(await toolNames(page)).toEqual(['Edit', 'Move to…', 'Remove']);
  await previewTool(page, 'move').click();
  const serverTop = pickerOf(dialog(page)).locator('[role="treeitem"][data-key="server:"]');
  await expect(serverTop.locator('.qlPicker__lock')).toBeVisible();
  await expect(serverTop).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await previewAction(page, 'load').click();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');

  // The edit shortcuts do nothing on a server item. No item can be dropped into the server root.
  await showPanel(page);
  await node(page, 'The answer').focus();
  await page.keyboard.press('Delete');
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+m');
  await expect(dialog(page)).toHaveCount(0);
  await expect(saveForm(page)).toHaveCount(0);
  await node(page, 'Mine').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(node(page, 'Mine')).toHaveAttribute('data-store', 'local');
  // Ctrl+S saves into the browser's root. The server group is disabled.
  await page.keyboard.press('Escape');
  await page.locator('#queryTextArea').press('Control+s');
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await openPicker(saveForm(page));
  await expect(pickerOf(saveForm(page)).locator('[role="treeitem"][data-key="server:"] .qlPicker__lock')).toBeVisible();
  await fillForm(page, { name: 'Mine too' });
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  expect((await libraryState(page)).queries.map((q) => q.name).sort()).toEqual(['Mine', 'Mine too']);
  // The library stays open on the saved query. The editor behind it is inert until the library
  // closes.
  await closePanel(page);

  // History has Save to library, which saves into the browser's root. History also has Remove. The
  // History is the browser's, whatever the server root is.
  await runSuccessfulQuery(page, 'SELECT 5 AS five');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  expect(await toolNames(page)).toEqual(['Save to library…']);
  await expect(footLabels(page)).toHaveText(['Load']);
  expect(server.requests.filter((r) => r.method !== 'GET')).toEqual([]);
});

test('Save with a read-only server root: its group is off, its rows in the tree are no target, the save goes to the browser root', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: false });
  await seed(page, { 'chdash.queryLibrary.v2': MINE });
  await openLibrary(page);
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 9 AS nine');
  await showPanel(page);
  await clickSave(page);
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await openPicker(saveForm(page));
  await expect(folderField(page).locator('[role="treeitem"][data-key="server:"] .qlPicker__lock')).toBeVisible();
  await expect(folderField(page).locator('[role="treeitem"][data-key="server:"]')).toHaveAttribute('aria-disabled', 'true');
  // The server's root, its folders and its queries are in the tree. A click on them does not make
  // them the Folder.
  await expandFolder(page, SERVER_ROOT);
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await node(page, 'The answer').locator(':scope > .qlRow').click();
  await expect(folderField(page)).toHaveAttribute('data-value', 'local:');
  await expect(saveForm(page)).toBeVisible();
  await saveForm(page).locator('[name="name"]').fill('Nine');
  await formButton(page, 'Save').click();
  await expect(page.locator('.qlToast')).toContainText('Query saved.');
  expect((await libraryState(page)).queries.map((q) => q.name).sort()).toEqual(['Mine', 'Nine']);
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
    // Toolbar controls stay clickable. None of them hides under the metrics.
    await runSuccessfulQuery(page, 'SELECT number, toString(number) AS label FROM numbers(5)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await button.click();
    await expect(panel(page)).toBeVisible();
    await expect(tree(page)).toBeVisible();
    const box = await settled(panel(page));
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 390, 844]);
    // The first step shows the list only. There is no preview pane beside it.
    await expect(preview(page)).toBeHidden();
    expect(Math.round((await page.locator('#queryLibraryViewSaved').boundingBox()).width)).toBe(390);
    // Use the editor button to save. The list has no Save in its foot. New folder is in the
    // head.
    await expect(page.locator('#queryLibraryViewSaved [data-action="save"]')).toHaveCount(0);
    await expect(page.locator('#queryLibraryViewSaved [data-action="new-folder"]')).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved .qlRow__meta').first()).toBeHidden();
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-${scheme}.png` });
    // A tap shows the preview of the query in place of the list. The preview has a Back button and
    // every action. The focus is on Load. Nothing is loaded yet.
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
    // Every button of the pane is inside the pane. The title stays on its line, with Back and the
    // tools. The meta goes under the title.
    await settled(panel(page));
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
    // A prompt is a bottom sheet over the dialog.
    await previewTool(page, 'move').click();
    const sheet = await settled(dialog(page));
    expect([Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 844]);
    expect(sheet.y).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(preview(page)).toBeVisible();
    // Back and Escape return to the list, on the same item. The dialog stays open.
    await preview(page).locator('.qlPreview__back').click();
    await expect(preview(page)).toBeHidden();
    await expect(node(page, 'The answer')).toBeFocused();
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await expect(preview(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(preview(page)).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await expect(node(page, 'The answer')).toBeFocused();
    // A folder has a twisty. The twisty opens or closes the folder. Its name opens the preview of
    // the folder, with its tools. The expanded folders are remembered across the loop.
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
    // History uses the same two steps. The dialog reopens on the list.
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
    // The profiling dialog is the same full-screen dialog.
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
  // The menu button of the list is there without a hover. Its size is --hit square.
  await preview(page).locator('.qlPreview__back').click();
  const menu = node(page, 'The answer').locator(':scope > .qlRow > .qlRow__menu');
  expect(await menu.evaluate((el) => [Math.round(el.getBoundingClientRect().width), Math.round(el.getBoundingClientRect().height), getComputedStyle(el).opacity])).toEqual([40, 40, '1']);
  });
});

test('phone: the save form is the pane step (Back keeps it, a tapped folder is the Folder, Cancel and Escape go back to the list), in both themes; a tablet keeps it beside the tree', async ({ page }, testInfo) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await page.locator('#queryTextArea').fill('SELECT 3 AS three');
    await page.locator('#queryLibraryButton').click();
    await expect(tree(page)).toBeVisible();
    await clickSave(page);
    // The pane replaces the list. The form fits the pane. The Name field has the focus. It is the
    // only dialog.
    await expect(saveForm(page)).toBeVisible();
    await expect(page.locator('#queryLibraryViewSaved')).toBeHidden();
    await expect(openDialogs(page)).toHaveCount(1);
    await expect(saveForm(page).locator('[name="name"]')).toBeFocused();
    await expect(saveForm(page).locator('.qlPreview__back')).toBeVisible();
    await saveForm(page).locator('[name="name"]').fill(`Phone ${scheme}`);
    await saveForm(page).locator('[name="description"]').fill('Typed on a phone');
    const fit = await page.evaluate(() => {
      const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
      const form = document.querySelector('#queryLibraryPreview form');
      const controls = [...form.querySelectorAll('button, input, select, textarea')].filter((c) => c.getClientRects().length).map((c) => c.getBoundingClientRect());
      return {
        page: document.documentElement.scrollWidth,
        formWhole: form.scrollWidth <= form.clientWidth + 1,
        inside: controls.every((b) => b.left >= pane.left - 0.5 && b.right <= pane.right + 0.5 && b.bottom <= pane.bottom + 0.5),
        paneWidth: Math.round(pane.width),
      };
    });
    expect(fit).toEqual({ page: 390, formWhole: true, inside: true, paneWidth: 390 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The buttons have a size that is easy to touch.
    for (const label of ['Cancel', 'Save']) expect((await formButton(page, label).boundingBox()).height).toBeGreaterThanOrEqual(36);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-save-form-${scheme}.png` });
    // Back shows the list, and the form stays. The Save button of the editor shows the form again,
    // as it was.
    await saveForm(page).locator('.qlPreview__back').click();
    await expect(preview(page)).toBeHidden();
    await clickSave(page);
    await expect(saveForm(page).locator('[name="name"]')).toHaveValue(`Phone ${scheme}`);
    await expect(saveForm(page).locator('[name="description"]')).toHaveValue('Typed on a phone');
    // A folder tapped in the list becomes the Folder. The form is shown again.
    await saveForm(page).locator('.qlPreview__back').click();
    await node(page, 'Reports').locator(':scope > .qlRow .qlRow__name').click();
    await expect(saveForm(page)).toBeVisible();
    await expect(folderField(page)).toHaveAttribute('data-value', 'local:f_reports');
    await expect(saveForm(page).locator('[name="name"]')).toHaveValue(`Phone ${scheme}`);
    await formButton(page, 'Save').click();
    await expect(page.locator('.qlToast')).toContainText('Query saved.');
    // The preview of the new query is the next step. Its Load button has the focus.
    await expect(saveForm(page)).toHaveCount(0);
    await expect(preview(page)).toBeVisible();
    await expect(preview(page).locator('.qlPreview__title')).toHaveText(`Phone ${scheme}`);
    await expect(previewAction(page, 'load')).toBeFocused();
    await preview(page).locator('.qlPreview__back').click();
    await expect(node(page, `Phone ${scheme}`)).toHaveAttribute('aria-level', '3');
    // Escape and Cancel remove the form and show the list. The focus is in the list.
    await clickSave(page);
    await expect(saveForm(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(saveForm(page)).toHaveCount(0);
    await expect(preview(page)).toBeHidden();
    await expect(panel(page)).toBeVisible();
    expect(await focusIsInTree(page)).toBe(true);
    await clickSave(page);
    await formButton(page, 'Cancel').click();
    await expect(preview(page)).toBeHidden();
    expect(await focusIsInTree(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  }
  // A tablet shows two columns. The form is the right pane, and it fits the pane.
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.locator('#queryLibraryButton').click();
  await expect(tree(page)).toBeVisible();
  await clickSave(page);
  await expect(saveForm(page)).toBeVisible();
  await expect(tree(page)).toBeVisible();
  const tablet = await page.evaluate(() => {
    const pane = document.getElementById('queryLibraryPreview').getBoundingClientRect();
    const form = document.querySelector('#queryLibraryPreview form');
    const controls = [...form.querySelectorAll('button, input, select, textarea')].filter((c) => c.getClientRects().length).map((c) => c.getBoundingClientRect());
    return { formWhole: form.scrollWidth <= form.clientWidth + 1, inside: controls.every((b) => b.left >= pane.left - 0.5 && b.right <= pane.right + 0.5), narrow: pane.width < 600 };
  });
  expect(tablet).toEqual({ formWhole: true, inside: true, narrow: true });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
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
    expect((await pickerOptions(dialog(page)))[0]).toBe('/');
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

// --- Several libraries on the server -----------------------------------------

test('several server libraries: one named root each (the first is the default), a read-only one cannot be changed, each is read with its own ?library=', async ({ page }) => {
  const requests = [];
  const content = {
    default: [{ id: 'q_team', folder_id: null, name: 'Team one', description: '', sql: 'SELECT 1 AS team', host_id: HOST, created_at_ms: now, updated_at_ms: now }],
    runbooks: [{ id: 'q_book', folder_id: null, name: 'Runbook one', description: '', sql: 'SELECT 2 AS runbook', host_id: HOST, created_at_ms: now, updated_at_ms: now }],
  };
  await page.route('**/api/version', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features = {
      ...(body.features || {}),
      query_library: {
        enabled: true,
        writable: true,
        libraries: [
          { name: 'default', writable: true },
          { name: 'runbooks', writable: false },
        ],
      },
    };
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/query-library**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.search}`);
    const name = url.searchParams.get('library') || 'default';
    const writable = name === 'default';
    const wanted = /\/queries\/([^/?]+)$/.exec(url.pathname);
    if (wanted) {
      // The page reads one whole query when the query is opened.
      const found = (content[name] || []).find((q) => q.id === decodeURIComponent(wanted[1]));
      return route.fulfill({ status: found ? 200 : 404, contentType: 'application/json', body: JSON.stringify(found ? { ...found, revision: 1, ancestors: [], path: '/' } : { error: 'not_found', error_code: 'not_found', message: 'no such query' }) });
    }
    const minimal = (content[name] || []).map((q) => ({ id: q.id, folder_id: q.folder_id, name: q.name, updated_at_ms: q.updated_at_ms }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        host_id: url.searchParams.get('host_id'), revision: 1, updated_at_ms: now, writable, load_error: null, parent_id: null, depth: 0, complete: true, next_cursor: null,
        level_total: minimal.length, totals: { folders: 0, queries: minimal.length, parent_queries: minimal.length }, folders: [], queries: minimal,
      }),
    });
  });
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] } });
  await openLibrary(page);

  const roots = tree(page).locator(':scope > li[role=treeitem]');
  await expect(roots).toHaveCount(3);
  await expect(roots.locator(':scope > .qlRow .qlRow__name')).toHaveText(['default', 'runbooks', LOCAL_ROOT]);
  await expect(roots.nth(0)).toHaveAttribute('data-store', 'server');
  await expect(roots.nth(1)).toHaveAttribute('data-store', 'server~runbooks');
  await expect(roots.nth(2)).toHaveAttribute('data-store', 'local');
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['server', 'server~runbooks', 'local']);
  // Both server roots have the database icon. Only the read-only root says that it is read-only.
  await expect(roots.nth(0).locator(':scope > .qlRow .qlIcon--server use')).toHaveAttribute('href', /#i-database$/);
  await expect(roots.nth(1).locator(':scope > .qlRow .qlIcon--server use')).toHaveAttribute('href', /#i-database$/);
  await expect(roots.nth(0).locator(':scope > .qlRow .qlBadge--readonly')).toHaveCount(0);
  await expect(roots.nth(1).locator(':scope > .qlRow .qlBadge--readonly')).toHaveCount(1);
  // Each library is read by its own name.
  expect(requests.some((r) => r.includes('library=runbooks'))).toBe(true);
  expect(requests.some((r) => r.includes('library=default'))).toBe(true);

  // The read-only library has no New folder in its preview. Its query has no Edit, Move, or Remove.
  // The writable library has these actions.
  await selectItem(page, 'runbooks');
  expect(await toolNames(page)).toEqual([]);
  await expect(preview(page).locator('.qlPreview__meta')).toContainText('Read-only');
  await selectItem(page, 'Runbook one');
  expect(await toolNames(page)).toEqual([]);
  await selectItem(page, 'default');
  expect(await toolNames(page)).toEqual(['New folder']);

  // A query of a read-only library loads into the editor, like any other query.
  await loadSaved(page, 'Runbook one');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 2 AS runbook');
});

// --- A large library of the server: pages, levels, and the SQL read when a query is opened ----------------

const bigQuery = (i, folder = null, prefix = 'Query') => ({ id: `${folder || 'q'}_${i}`, folder_id: folder, name: `${prefix} ${String(i).padStart(3, '0')}`, description: `Number ${i}`, sql: `SELECT ${i} AS n`, host_id: HOST, created_at_ms: now, updated_at_ms: now });
const emptyLocal = { version: 2, revision: 1, folders: [], queries: [] };
const serverRows = (page) => tree(page).locator('li[data-kind="query"][data-store="server"]');

test('a level that is larger than a page comes in windows of 100: the next one is read on demand', async ({ page }) => {
  const queries = Array.from({ length: 250 }, (_, i) => bigQuery(i));
  const server = await mockServerLibrary(page, { writable: true, library: { folders: [], queries } });
  await seed(page, { 'chdash.queryLibrary.v2': emptyLocal });
  await openLibrary(page);
  // The storage shows how many queries it holds (250). It shows the first 100. Its page has no SQL
  // and no description.
  await expect(node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__count')).toHaveText('250 queries');
  await expect(serverRows(page)).toHaveCount(100);
  const more = tree(page).locator('[data-more]').first();
  await expect(more).toContainText('Show 100 more');
  expect(server.requests.filter((r) => r.method === 'GET' && !r.path.includes('/'))).toHaveLength(1);
  await more.click();
  await expect(serverRows(page)).toHaveCount(200);
  await tree(page).locator('[data-more]').first().click();
  await expect(serverRows(page)).toHaveCount(250);
  await expect(tree(page).locator('[data-more]')).toHaveCount(0);
  expect(server.requests.filter((r) => r.path.includes('cursor=')).map((r) => /cursor=(\d+)/.exec(r.path)[1])).toEqual(['100', '200']);
  // The pane of the storage also lists the first level. It lists 200 items at most. It says how
  // many items are left.
  await selectItem(page, SERVER_ROOT);
  await expect(preview(page).locator('.qlContents__item')).toHaveCount(200);
  await expect(preview(page).locator('p.qlContents__more')).toContainText('50 more');
});

test('the SQL and the description of a query are read when it is opened, once; a library that fits in a page comes whole in one read', async ({ page }) => {
  const queries = Array.from({ length: 30 }, (_, i) => bigQuery(i));
  const server = await mockServerLibrary(page, { writable: true, library: { folders: [], queries } });
  await seed(page, { 'chdash.queryLibrary.v2': emptyLocal });
  await openLibrary(page);
  await expect(serverRows(page)).toHaveCount(30);
  expect(server.requests.filter((r) => r.method === 'GET')).toHaveLength(1);
  // Only the names of the queries were read.
  expect(server.requests.some((r) => r.path.startsWith('/queries/'))).toBe(false);
  await node(page, 'Query 005').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 5 AS n');
  await expect(preview(page).locator('.qlPreview__description')).toHaveText('Number 5');
  await node(page, 'Query 006').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 6 AS n');
  await node(page, 'Query 005').locator(':scope > .qlRow').click();
  await expect(preview(page).locator('.qlSql .sqlBlock__code')).toHaveText('SELECT 5 AS n');
  // The page reads each opened query once. This is true whatever the number of times the query is
  // shown.
  expect(server.requests.filter((r) => r.path.startsWith('/queries/')).map((r) => r.path.split('?')[0]).sort()).toEqual(['/queries/q_5', '/queries/q_6']);
  // Load fills the editor with the query.
  await previewAction(page, 'load').click();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 5 AS n');
});

test('a large library comes by levels: the folders first, the children of a folder when it is opened', async ({ page }) => {
  const folders = Array.from({ length: 11 }, (_, i) => ({ id: `f_${i}`, host_id: HOST, parent_id: null, name: `Team ${String(i).padStart(2, '0')}`, created_at_ms: now, updated_at_ms: now }));
  const queries = folders.flatMap((f) => Array.from({ length: 9 }, (_, j) => bigQuery(j, f.id, 'Run')));
  const server = await mockServerLibrary(page, { writable: true, library: { folders, queries } });
  await seed(page, { 'chdash.queryLibrary.v2': emptyLocal });
  await openLibrary(page);
  // 11 folders and 99 queries do not fit in one page (110 items). The page shows the folders, and
  // each folder shows its count of queries.
  await expect(node(page, SERVER_ROOT).locator(':scope > .qlRow .qlRow__count')).toHaveText('99 queries');
  await expect(tree(page).locator('li[data-kind="folder"][data-store="server"]')).toHaveCount(11);
  await expect(serverRows(page)).toHaveCount(0);
  await expect(node(page, 'Team 03').locator(':scope > .qlRow .qlRow__meta')).toHaveText('9 queries');
  expect(server.requests.some((r) => r.path.includes('parent_id='))).toBe(false);
  // When a folder opens, the page reads its children. The page reads only those children.
  await node(page, 'Team 03').locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(serverRows(page)).toHaveCount(9);
  expect(server.requests.filter((r) => r.path.includes('parent_id=')).map((r) => /parent_id=([^&]+)/.exec(r.path)[1])).toEqual(['f_3']);
  // A folder that is closed and opened again is not read again.
  await node(page, 'Team 03').locator(':scope > .qlRow .qlRow__twisty').click();
  await node(page, 'Team 03').locator(':scope > .qlRow .qlRow__twisty').click();
  await expect(serverRows(page)).toHaveCount(9);
  expect(server.requests.filter((r) => r.path.includes('parent_id='))).toHaveLength(1);
});

test('the search of a library of the server is made by the server: its answers carry their path, and one opens in its folder', async ({ page }) => {
  const folders = [{ id: 'f_ops', host_id: HOST, parent_id: null, name: 'Operations', created_at_ms: now, updated_at_ms: now }];
  const queries = [{ ...bigQuery(1, 'f_ops', 'Parts'), sql: 'SELECT table FROM system.parts' }, bigQuery(2)];
  const server = await mockServerLibrary(page, { writable: true, library: { folders, queries } });
  await seed(page, { 'chdash.queryLibrary.v2': emptyLocal });
  await openLibrary(page);
  await page.locator('#queryLibraryViewSaved .qlSearch__input').fill('system.parts');
  await expect(tree(page).locator('li[data-kind="query"]')).toHaveCount(1);
  await expect(tree(page).locator('.qlRow__path')).toContainText('Operations');
  expect(server.requests.some((r) => r.path.startsWith('/search?') && r.path.includes('q=system.parts'))).toBe(true);
});

// --- Live server (optional) -------------------------------------------------

const LIVE = process.env.QUERY_LIBRARY_LIVE_URL || '';

// The live instance has two libraries: default and reference. The first library shows its name.
const LIVE_SERVER_ROOT = 'default';
test('live server library: both roots; create, save, move within and across the roots, reload and remove against a real instance', async ({ page }) => {
  requireInstance(test, 'QUERY_LIBRARY_LIVE_URL', LIVE);
  const stamp = `pw-${Date.now().toString(36)}`;
  await page.goto(`${LIVE.replace(/\/+$/, '')}/query`);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  const host = (await page.locator('#hostPickerText').textContent()).trim();
  await showPanel(page);
  await expect(footCount(page)).toContainText(`· ${host}`);
  expect(await page.evaluate(() => window.ChDash.queryLibrary.roots)).toEqual(['server', 'server~reference', 'local']);
  await expect(node(page, LIVE_SERVER_ROOT)).toBeVisible();
  await expect(node(page, LOCAL_ROOT)).toBeVisible();

  await selectItem(page, LIVE_SERVER_ROOT);
  await previewTool(page, 'new-subfolder').click();
  await expect(newFolderInput(page)).toBeFocused();
  await newFolderInput(page).fill(`${stamp} folder`);
  await page.keyboard.press('Enter');
  await expect(node(page, `${stamp} folder`)).toBeVisible();
  await expect(node(page, `${stamp} folder`)).toHaveAttribute('data-store', 'server');

  await closePanel(page);
  await page.locator('#queryTextArea').fill(`SELECT '${stamp}' AS stamp`);
  await showPanel(page);
  await clickSave(page);
  await fillForm(page, { name: `${stamp} query`, description: 'live check' });
  await pickPlace(saveForm(page), 'server:');
  await saveForm(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node(page, `${stamp} query`)).toBeVisible();
  await node(page, `${stamp} query`).locator(':scope > .qlRow').dragTo(node(page, `${stamp} folder`).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '3');

  // The library is reloaded from the server file, for this host.
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  await showPanel(page);
  await expandFolder(page, `${stamp} folder`);
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '3');
  let library = await page.evaluate(async (id) => (await fetch(`api/query-library/export?host_id=${encodeURIComponent(id)}`)).json(), host);
  expect(library.queries.find((q) => q.name === `${stamp} query`).host_id).toBe(host);

  // The run appears in the History of this browser, for the host.
  await loadSaved(page, `${stamp} query`);
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').filter({ hasText: stamp }).first()).toBeVisible();
  await page.locator('#queryLibraryTabSaved').click();

  // The folder moves to this browser. It is copied, then removed from the server. The folder then
  // moves back. This uses one copy-mode import on the real server.
  await selectItem(page, `${stamp} folder`);
  await previewTool(page, 'move').click();
  await pickPlace(dialog(page), 'local:');
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveAttribute('data-store', 'local');
  library = await page.evaluate(async (id) => (await fetch(`api/query-library/export?host_id=${encodeURIComponent(id)}`)).json(), host);
  expect(library.folders.some((f) => f.name === `${stamp} folder`)).toBe(false);
  expect(library.queries.some((q) => q.name === `${stamp} query`)).toBe(false);
  expect((await libraryState(page)).queries.find((q) => q.name === `${stamp} query`)).toMatchObject({ host_id: host, description: 'live check' });
  await node(page, `${stamp} folder`).locator(':scope > .qlRow').dragTo(node(page, LIVE_SERVER_ROOT).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} folder`)).toHaveAttribute('data-store', 'server');
  library = await page.evaluate(async (id) => (await fetch(`api/query-library/export?host_id=${encodeURIComponent(id)}`)).json(), host);
  const folder = library.folders.find((f) => f.name === `${stamp} folder`);
  expect(library.queries.find((q) => q.name === `${stamp} query`)).toMatchObject({ folder_id: folder.id, sql: `SELECT '${stamp}' AS \`stamp\`` });
  expect((await libraryState(page)).folders.some((f) => f.name === `${stamp} folder`)).toBe(false);

  await selectItem(page, `${stamp} folder`);
  await previewTool(page, 'delete').click();
  await dialog(page).getByRole('button', { name: 'Remove all' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveCount(0);
});

// Audit round 2. An empty tab shows one empty state. The empty state is centred across the dialog.
// No "select an item" pane is beside it.
test('an empty History is one centred empty state across the dialog; an empty library is the plain tree of its roots', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] }, 'chdash.queryHistory.v1': [] });
  await openLibrary(page);
  const body = page.locator('.queryLibraryDialog__body');
  // With nothing saved, Saved shows the classic tree. The tree has the root, and the server root
  // when the library is enabled. Each root says that it is empty. The preview pane is beside the
  // tree. There is no "No saved queries" screen.
  await expect(body).not.toHaveClass(/is-empty/);
  await expect(preview(page)).toBeVisible();
  await expect(node(page, LOCAL_ROOT).locator('.qlTree__empty')).toHaveText('Empty');
  await expect(page.locator('#queryLibraryViewSaved .qlTree__empty--root')).toHaveCount(0);
  await expect(panel(page)).not.toContainText('No saved queries');
  await expect(panel(page)).not.toContainText('in the editor');
  // History with no run shows one empty state. The empty state is centred across the dialog. It has
  // no preview pane.
  await showPanel(page, 'history');
  const empty = page.locator('#queryLibraryViewHistory .qlTree__empty--root');
  await expect(empty).toContainText(`No history for ${HOST} yet`);
  await expect(body).toHaveClass(/is-empty/);
  await expect(preview(page)).toBeHidden();
  const [bodyBox, emptyBox, listBox] = await Promise.all([body.boundingBox(), empty.boundingBox(), page.locator('#queryLibraryViewHistory .qhList').boundingBox()]);
  // The empty state is centred across the width of the dialog and in the height of the list.
  expect(Math.abs((emptyBox.x + emptyBox.width / 2) - (bodyBox.x + bodyBox.width / 2))).toBeLessThanOrEqual(24);
  expect(Math.abs((emptyBox.y + emptyBox.height / 2) - (listBox.y + listBox.height / 2))).toBeLessThanOrEqual(24);
  // A first entry shows the list and its preview pane again.
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
  // It is in the same place as the foot of Saved, at the bottom of its column.
  const [foot, list] = await Promise.all([view.locator('.ql__foot').boundingBox(), view.locator('.qhList').boundingBox()]);
  expect(foot.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
  expect(await page.evaluate(() => [...document.querySelectorAll('#queryLibraryViewHistory .ql > *')].map((el) => el.className.split(' ')[0]))).toEqual(['ql__head', 'qhList', 'ql__foot']);
});
