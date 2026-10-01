import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runQuery, runSuccessfulQuery, waitForTerminal } from '../helpers/app.js';

// Query library: the toolbar book button (between Format and the run settings
// cog) opens it in the shared modal dialog of the profiling (app_ui_dialog.js:
// same shell, size, backdrop and tabs), with two tabs, Saved (folders and saved
// queries) and History, and its prompts stacked over it. Browser mode keeps both in localStorage (chdash.queryLibrary.v2, migrated
// once from chdash.savedQueries.v1; chdash.queryHistory.v1). Server mode
// (features.query_library.enabled) goes through /api/query-library: here a
// small in-memory server behind page.route, writable or read-only, plus one
// live check when QUERY_LIBRARY_BASE_URL names a real instance.

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
const menuItem = (page, name) => page.locator('.qlMenu [role=menuitem]').filter({ has: page.locator('.qlMenu__label', { hasText: new RegExp(`^${name}`) }) });
const libraryState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryLibrary.v2') || 'null'));

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

const now = Date.UTC(2026, 9, 1, 12, 0, 0);
const LIBRARY = {
  version: 2,
  revision: 3,
  folders: [
    { id: 'f_ops', parent_id: null, name: 'Operations', description: 'Server health', created_at_ms: now, updated_at_ms: now },
    { id: 'f_merges', parent_id: 'f_ops', name: 'Merges', description: '', created_at_ms: now, updated_at_ms: now },
    { id: 'f_reports', parent_id: null, name: 'Reports', description: '', created_at_ms: now, updated_at_ms: now },
  ],
  queries: [
    { id: 'q_parts', folder_id: 'f_ops', name: 'Active parts', description: 'Active data parts per table', sql: 'SELECT table, count() AS parts FROM system.parts WHERE active GROUP BY table ORDER BY parts DESC', host_id: null, tags: ['storage'], created_at_ms: now, updated_at_ms: now },
    { id: 'q_merges', folder_id: 'f_merges', name: 'Running merges', description: 'What the merge pool is doing', sql: 'SELECT database, table, elapsed, progress FROM system.merges', host_id: null, tags: [], created_at_ms: now, updated_at_ms: now },
    { id: 'q_answer', folder_id: null, name: 'The answer', description: '', sql: 'SELECT 42 AS answer', host_id: null, tags: [], created_at_ms: now, updated_at_ms: now },
  ],
};

const panel = (page) => page.locator('#queryLibraryMenu');

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

async function rowMenu(page, name) {
  const item = node(page, name);
  await item.locator(':scope > .qlRow').hover();
  await item.locator(':scope > .qlRow .qlRow__more').click();
  await expect(page.locator('.qlMenu')).toBeVisible();
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

// --- Browser mode -----------------------------------------------------------

test('browser mode migrates chdash.savedQueries.v1 once and keeps the legacy key', async ({ page }) => {
  const legacy = [
    { name: 'Top tables', sql_raw: 'SELECT name FROM system.tables LIMIT 5', host_id: 'local', created_at_ms: now - 1000 },
    { name: 'Processes', sql_raw: 'SELECT query_id FROM system.processes', sql_formatted: 'SELECT\n    query_id\nFROM system.processes', host_id: null, created_at_ms: now - 2000 },
  ];
  await seed(page, { 'chdash.savedQueries.v1': legacy, 'chdash.queryLibrary.v2': null });
  await openLibrary(page);
  await expect(node(page, 'Top tables')).toBeVisible();
  await expect(node(page, 'Processes')).toBeVisible();
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText('2 queries');
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText('Stored in this browser');

  const stored = await libraryState(page);
  expect(stored.version).toBe(2);
  expect(stored.migrated_from).toBe('chdash.savedQueries.v1');
  expect(stored.queries.map((q) => q.name).sort()).toEqual(['Processes', 'Top tables']);
  expect(stored.queries.find((q) => q.name === 'Processes').sql).toBe('SELECT\n    query_id\nFROM system.processes');
  // The legacy key is left as it was: an older build still reads it.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('chdash.savedQueries.v1')))).toEqual(legacy);

  // Migrated once: a later change of the legacy list is not imported again.
  await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('chdash.savedQueries.v1'));
    list.push({ name: 'Late entry', sql_raw: 'SELECT 1', created_at_ms: Date.now() });
    localStorage.setItem('chdash.savedQueries.v1', JSON.stringify(list));
  });
  await page.reload();
  await showPanel(page);
  await expect(node(page, 'Top tables')).toBeVisible();
  await expect(node(page, 'Late entry')).toHaveCount(0);
  expect((await libraryState(page)).queries).toHaveLength(2);

  // Opening a migrated query fills the editor and closes the panel.
  await node(page, 'Processes').locator(':scope > .qlRow').click();
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT\n    query_id\nFROM system.processes');
  await expect(panel(page)).toBeHidden();
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
  // Confirmed, it goes.
  await page.keyboard.press('Delete');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(node(page, 'The answer')).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  expect((await libraryState(page)).queries.map((q) => q.id).sort()).toEqual(['q_merges', 'q_parts']);
  // Its toast is shown in the top dialog (the page under it is inert).
  await expect(page.locator('#queryLibraryMenu > .qlToast')).toContainText('Query deleted.');

  // Delete a non-empty folder: Escape keeps it.
  await rowMenu(page, 'Operations');
  await menuItem(page, 'Delete').click();
  await expect(confirm.locator('.uiDialog__title')).toHaveText('Delete folder');
  await expect(confirm).toContainText('2 queries and 1 subfolder');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(node(page, 'Operations')).toBeVisible();

  // The toast follows the page when the library closes.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.querySelector('.qlToast')?.parentElement === document.body)).toBe(true);
});

test('folders: create, nest, rename and delete a non-empty folder after confirmation', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] }, 'chdash.savedQueries.v1': null });
  await openLibrary(page);
  await expect(tree(page)).toContainText('No saved queries yet');

  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'Monitoring', description: 'Health checks' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, 'Monitoring')).toBeVisible();

  // Duplicate sibling names are refused in the dialog, case-insensitively.
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'monitoring', parent_id: 'Top level' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);

  // A subfolder from the folder menu, then a query saved into it.
  await rowMenu(page, 'Monitoring');
  await menuItem(page, 'New subfolder').click();
  await fillDialog(page, { name: 'Disks' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, 'Monitoring')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'Disks')).toHaveAttribute('aria-level', '2');

  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT name, free_space FROM system.disks');
  await showPanel(page);
  await rowMenu(page, 'Disks');
  await menuItem(page, 'Save the editor query here').click();
  await fillDialog(page, { name: 'Free space', description: 'Free bytes per disk' });
  await expect(dialog(page).locator('[name="folder_id"] option:checked')).toContainText('Disks');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expandFolder(page, 'Disks');
  await expect(node(page, 'Free space')).toHaveAttribute('aria-level', '3');

  // Rename (F2 on the focused folder).
  await node(page, 'Monitoring').locator(':scope > .qlRow .qlRow__name').click();
  await node(page, 'Monitoring').press('F2');
  await fillDialog(page, { name: 'Health' });
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Health')).toBeVisible();
  await expect(node(page, 'Monitoring')).toHaveCount(0);

  // Deleting a non-empty folder asks first and removes everything inside.
  await rowMenu(page, 'Health');
  await menuItem(page, 'Delete').click();
  await expect(dialog(page)).toContainText('1 query and 1 subfolder');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(node(page, 'Health')).toBeVisible();
  await rowMenu(page, 'Health');
  await menuItem(page, 'Delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
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
  await fillDialog(page, { name: 'Table count', description: 'How many tables', tags: 'catalog, quick', folder_id: 'Reports' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.qlToast')).toContainText('Query saved');
  await expect(node(page, 'Table count')).toBeVisible();
  let stored = await libraryState(page);
  const saved = stored.queries.find((q) => q.name === 'Table count');
  expect(saved).toMatchObject({ folder_id: 'f_reports', description: 'How many tables', sql: 'SELECT count() FROM system.tables', tags: ['catalog', 'quick'] });

  // A click opens a query in the editor (and closes the panel); the opened
  // query is marked.
  await node(page, 'The answer').locator(':scope > .qlRow').click();
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

  // Edit: name, description, tags and the SQL taken from the editor.
  await closePanel(page);
  await editor.fill('SELECT 6 * 7 AS answer');
  await showPanel(page);
  await rowMenu(page, 'The answer');
  await menuItem(page, 'Edit').click();
  await fillDialog(page, { name: 'Answer', description: 'Douglas Adams', tags: 'fun' });
  await dialog(page).locator('[name="replace_sql"]').check();
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(node(page, 'Answer')).toBeVisible();
  stored = await libraryState(page);
  expect(stored.queries.find((q) => q.id === 'q_answer')).toMatchObject({ name: 'Answer', description: 'Douglas Adams', tags: ['fun'], sql: 'SELECT 6 * 7 AS answer' });
});

test('move: drag and drop into a folder, Move to\u2026 for folders, no move into a descendant', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);

  // Drag the top-level query onto a folder.
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(node(page, 'Reports').locator(':scope > .qlRow'));
  await expect(page.locator('.qlToast')).toContainText('Moved to \u201cReports\u201d');
  await expect(node(page, 'Reports')).toHaveAttribute('aria-expanded', 'true');
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '2');
  expect((await libraryState(page)).queries.find((q) => q.id === 'q_answer').folder_id).toBe('f_reports');

  // Drag it back to the top level (the tree background).
  const box = await tree(page).boundingBox();
  await node(page, 'The answer').locator(':scope > .qlRow').dragTo(tree(page), { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(node(page, 'The answer')).toHaveAttribute('aria-level', '1');

  // Move to... a folder: its own subfolders are not offered.
  await rowMenu(page, 'Operations');
  await menuItem(page, 'Move to').click();
  const target = dialog(page).locator('select[name="target"]');
  await expect(target.locator('option')).toHaveText(['Top level', /Reports/]);
  await target.selectOption({ label: '\u00a0\u00a0\u00a0Reports' });
  await dialog(page).getByRole('button', { name: 'Move' }).click();
  await expect(node(page, 'Operations')).toHaveAttribute('aria-level', '2');
  const stored = await libraryState(page);
  expect(stored.folders.find((f) => f.id === 'f_ops').parent_id).toBe('f_reports');
  expect(stored.folders.find((f) => f.id === 'f_merges').parent_id).toBe('f_ops');
});

test('search covers names, descriptions and SQL; the hover preview shows description and highlighted SQL', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  await openLibrary(page);
  const search = page.locator('#queryLibraryViewSaved .qlSearch__input');
  const results = tree(page).locator('li[role=treeitem]');

  await search.fill('merge pool');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText('Running merges');
  await expect(results.first().locator('.qlRow__path')).toHaveText('Operations / Merges');

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

  // Hover: description, folder path and the SQL with keyword highlighting.
  await expandFolder(page, 'Operations');
  await node(page, 'Active parts').locator(':scope > .qlRow').hover();
  const preview = page.locator('#queryLibraryPreview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.qlPreview__title')).toHaveText('Active parts');
  await expect(preview.locator('.qlPreview__path')).toHaveText('Operations');
  await expect(preview.locator('.qlPreview__description')).toHaveText('Active data parts per table');
  await expect(preview.locator('.qlSql')).toContainText('FROM system.parts');
  await expect(preview.locator('.qlSql span').first()).toBeVisible();
  await expect(preview.locator('.qlTag')).toHaveText(['storage']);
  // The preview is a pane of the dialog, right of the list: it stays while
  // the pointer moves to it, and the next query replaces it.
  const geometry = await page.evaluate(() => {
    const pane = document.getElementById('queryLibraryPreview');
    const list = document.getElementById('queryLibraryViewSaved').getBoundingClientRect();
    return { inDialog: !!pane.closest('dialog#queryLibraryMenu'), beside: pane.getBoundingClientRect().left >= list.right - 1 };
  });
  expect(geometry).toEqual({ inDialog: true, beside: true });
  await page.locator('#queryLibraryViewSaved .ql__foot').hover();
  await preview.hover();
  await expect(preview.locator('.qlPreview__title')).toHaveText('Active parts');
  await node(page, 'The answer').locator(':scope > .qlRow').hover();
  await expect(preview.locator('.qlPreview__title')).toHaveText('The answer');
  await expect(preview.locator('.qlPreview__description')).toHaveCount(0);
});

test('a modifier-click adds the query as a new statement and turns multiquery on', async ({ page }) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY, 'chdash.runOptions.v1': { autoFormat: false, multiQuery: false, executionStats: false, flattenTuple: true } });
  await openLibrary(page);
  const editor = page.locator('#queryTextArea');
  await closePanel(page);
  await editor.fill('SELECT 1 AS first');
  await showPanel(page);
  await node(page, 'The answer').locator(':scope > .qlRow').click({ modifiers: ['ControlOrMeta'] });
  await expect(editor).toHaveValue('SELECT 1 AS first;\n\nSELECT 42 AS answer');
  await expect(page.locator('.qlToast')).toContainText('multiquery is now on');
  await expect(panel(page)).toBeHidden();
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await expect(page.locator('.resultsStack__block')).toHaveCount(2);
});

test('keyboard: tabs, tree navigation, expand / collapse, open, rename, menu and delete', async ({ page }) => {
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

  // Arrow keys move along the visible items.
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Operations');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Reports');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await expect(node(page, 'Operations')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowRight');
  expect(await focused()).toBe('Merges');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Active parts');
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

  // F2 renames; Escape closes the dialog and gives the focus back.
  await page.keyboard.press('F2');
  await fillDialog(page, { name: 'Answer 42' });
  await page.keyboard.press('Enter');
  await expect(node(page, 'Answer 42')).toBeVisible();

  // The item menu: Shift+F10, arrows, Escape.
  await node(page, 'Answer 42').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.locator('.qlMenu')).toBeVisible();
  await expect(page.locator('.qlMenu [role=menuitem]').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menuItem(page, 'Add as a new statement')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.qlMenu')).toHaveCount(0);
  expect(await focused()).toBe('Answer 42');

  // Enter opens the query in the editor and closes the panel.
  await page.keyboard.press('Enter');
  await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
  await expect(page.locator('#queryTextArea')).toBeFocused();
  await expect(panel(page)).toBeHidden();

  // Delete asks, Enter confirms.
  await showPanel(page);
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

test('history groups runs by day with status, elapsed time, rows and host; search, re-run, save and clear', async ({ page }) => {
  const day = 24 * 3600 * 1000;
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 1, folders: [], queries: [] },
    'chdash.queryHistory.v1': [{ ts_ms: Date.now() - 3 * day, sql_raw: 'SELECT \'older\' AS tag', host_id: 'local', status: 'ok', elapsed_ms: 12, rows: 1 }],
  });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(7)');
  await runQuery(page, 'SELECT * FROM chdash_ui.__missing_history_table');
  await waitForTerminal(page);
  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await expect(items).toHaveCount(3);
  await expect(page.locator('#queryLibraryViewHistory .qhDay').first()).toHaveText('Today');
  await expect(page.locator('#queryLibraryViewHistory .qhDay')).toHaveCount(2);

  const failed = items.nth(0);
  await expect(failed).toHaveClass(/qhItem--error/);
  await expect(failed.locator('.qhItem__status')).toHaveAttribute('aria-label', 'Failed');
  const ok = items.nth(1);
  await expect(ok).toHaveClass(/qhItem--ok/);
  await expect(ok.locator('.qhItem__sql')).toContainText('numbers(7)');
  await expect(ok.locator('.qhItem__rows')).toHaveText('7 rows');
  await expect(ok.locator('.qhItem__elapsed')).toHaveText(/^\d+(\.\d+)?m?s$/);
  await expect(ok.locator('.qhItem__host')).toHaveText('local');
  await expect(ok.locator('.qhItem__time')).toHaveText(/^\d\d:\d\d$/);

  // The failed run's preview shows the server error.
  await failed.hover();
  await expect(page.locator('#queryLibraryPreview .qlPreview__error')).toContainText(/__missing_history_table/);

  // Search.
  const search = page.locator('#queryLibraryViewHistory .qlSearch__input');
  await search.fill('older');
  await expect(items).toHaveCount(1);
  await search.fill('');
  await expect(items).toHaveCount(3);

  // Re-run loads and runs it (and closes the panel).
  await closePanel(page);
  await page.locator('#queryTextArea').fill('SELECT 0');
  await showPanel(page, 'history');
  await ok.hover();
  await ok.locator('[data-action="rerun"]').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#queryTextArea')).toHaveValue(/numbers\(7\)/);
  await waitForTerminal(page);
  await expect(page.locator('#resultTableBody tr:not(.resultTable__spacerRow)')).toHaveCount(7);

  // Save to library from the History.
  await showPanel(page, 'history');
  await items.filter({ hasText: 'older' }).hover();
  await items.filter({ hasText: 'older' }).locator('[data-action="save"]').click();
  await expect(dialog(page)).toContainText('SQL (from History)');
  await fillDialog(page, { name: 'Older one' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  expect((await libraryState(page)).queries.map((q) => q.sql)).toEqual(['SELECT \'older\' AS tag']);

  // Clear, after confirmation (always available in browser mode).
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('#queryLibraryViewHistory')).toContainText('No history yet');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryHistory.v1')))).toEqual([]);
});

test('the library opens in the profiling dialog: same shell, size and tabs; Escape, backdrop and close; focus in, trapped and back', async ({ page }) => {
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
    const tabs = dialog.querySelector(':scope > .uiDialog__frame > .uiDialog__tabs');
    const tab = tabs.querySelector('.uiDialog__tab[aria-selected="true"]');
    const tcs = getComputedStyle(tab);
    const close = head.querySelector('.uiDialog__close');
    return {
      tag: dialog.tagName,
      classes: [...dialog.classList].filter((c) => c.startsWith('uiDialog')).sort(),
      modal: dialog.matches(':modal'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      look: [cs.borderRadius, cs.backgroundColor, cs.borderTopColor, cs.boxShadow],
      backdrop: [getComputedStyle(dialog, '::backdrop').backgroundColor, getComputedStyle(dialog, '::backdrop').backdropFilter],
      head: [Math.round(head.getBoundingClientRect().height), getComputedStyle(head.querySelector('.uiDialog__title')).fontSize],
      close: [round(close.getBoundingClientRect().width), round(close.getBoundingClientRect().height), close.className],
      tab: [tcs.fontSize, tcs.fontWeight, tcs.borderBottomWidth, tcs.borderBottomColor, tcs.color, tcs.minHeight],
    };
  }, selector);

  await button.click();
  await expect(panel(page)).toBeVisible();
  await expect(tree(page)).toBeVisible();
  await settled(panel(page));
  const library = await shellOf('#queryLibraryMenu');
  expect(library.tag).toBe('DIALOG');
  expect(library.modal).toBe(true);
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
  await page.keyboard.press('Escape');
  await expect(page.locator('#analysisModal')).toBeHidden();
  expect(profiling).toEqual(library);
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

// An in-memory /api/query-library: revision, If-Match conflicts, read-only.
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
    server.requests.push({ method, path: path + url.search, ifMatch: headers['if-match'] || null, contentType: headers['content-type'] || null, body });
    if (method === 'GET' && path === '') {
      return json(route, 200, { revision: server.revision, updated_at_ms: now, folders: server.folders, queries: server.queries, writable, history_store: historyStore, load_error: null });
    }
    if (path.startsWith('/history')) {
      if (method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const entries = server.history.filter((e) => !q || e.sql.toLowerCase().includes(q)).sort((a, b) => b.ran_at_ms - a.ran_at_ms);
        return json(route, 200, { entries, has_more: false });
      }
      if (method === 'POST') {
        const id = `h_${++seq}`;
        server.history.push({ id, ...body });
        return json(route, 201, { id, revision: server.revision });
      }
      if (!writable) return json(route, 403, { error: 'read_only', error_code: 'read_only', message: 'the query library is read-only' });
      if (method === 'DELETE' && path === '/history') server.history = [];
      else server.history = server.history.filter((e) => `/history/${e.id}` !== path);
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
      if (server.folders.some((f) => f.parent_id === (body.parent_id || null) && f.name.toLowerCase() === body.name.toLowerCase())) {
        return json(route, 400, { error: 'validation', error_code: 'validation', field: 'name', reason: 'duplicate', message: 'a folder with this name already exists here' });
      }
      const folder = { id: `f_s${++seq}`, parent_id: body.parent_id || null, name: body.name, description: body.description || '', created_at_ms: now, updated_at_ms: now };
      server.folders.push(folder);
      bump();
      return json(route, 201, { ...folder, revision: server.revision });
    }
    if (method === 'POST' && path === '/queries') {
      const query = { id: `q_s${++seq}`, tags: [], host_id: null, description: '', ...body, created_at_ms: now, updated_at_ms: now };
      server.queries.push(query);
      bump();
      return json(route, 201, { ...query, revision: server.revision });
    }
    if (method === 'POST' && path === '/import') {
      const ids = {};
      for (const f of body.folders || []) {
        const folder = { id: `f_s${++seq}`, parent_id: ids[f.parent_id] || null, name: f.name, description: f.description || '', created_at_ms: now, updated_at_ms: now };
        ids[f.id] = folder.id;
        server.folders.push(folder);
      }
      for (const q of body.queries || []) server.queries.push({ id: `q_s${++seq}`, ...q, folder_id: ids[q.folder_id] || null, created_at_ms: now, updated_at_ms: now });
      bump();
      return json(route, 200, { ok: true, imported_queries: (body.queries || []).length, folder_ids: ids, revision: server.revision });
    }
    if ((m = /^\/(folders|queries)\/([^/?]+)$/.exec(path))) {
      const list = m[1] === 'folders' ? server.folders : server.queries;
      const item = list.find((x) => x.id === decodeURIComponent(m[2]));
      if (!item) return json(route, 404, { error: 'not_found', error_code: 'not_found', message: 'not found' });
      if (method === 'PATCH') {
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
  await seed(page, { 'chdash.queryLibrary.v2': null, 'chdash.savedQueries.v1': null });
  await openLibrary(page);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText('Stored on the server');
  await expect(page.locator('#queryLibraryViewSaved .qlBadge--readonly')).toHaveCount(0);
  await expect(node(page, 'Operations')).toBeVisible();

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
  expect(writes[1].body).toEqual({ parent_id: null, name: 'Shared', description: '' });

  // A server validation error (duplicate name) is shown in the dialog.
  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: 'shared', parent_id: 'Top level' });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(dialog(page).locator('.uiDialog__error')).toContainText('already exists');
  await page.keyboard.press('Escape');

  // Two conflicts in a row: the user is told and the library is reloaded.
  server.conflicts = 2;
  await rowMenu(page, 'The answer');
  await menuItem(page, 'Move to').click();
  await dialog(page).locator('select[name="target"]').selectOption({ label: '\u00a0\u00a0\u00a0Shared' });
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
  await rowMenu(page, 'Operations');
  await menuItem(page, 'Delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
  await expect(node(page, 'Operations')).toHaveCount(0);
  expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/folders/f_ops?recursive=1')).toBe(true);
  // Nothing was written to the browser library.
  expect(await libraryState(page)).toBeNull();
});

test('server mode: runs are appended to the server History, which can be searched and cleared', async ({ page }) => {
  const server = await mockServerLibrary(page, {
    writable: true,
    history: [{ id: 'h_old', sql: 'SELECT 1 AS earlier', host_id: 'local', ran_at_ms: Date.now() - 60_000, elapsed_ms: 3, rows: 1, status: 'ok', error: null }],
  });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number FROM numbers(3)');
  await expect.poll(() => server.history.length).toBe(2);
  const appended = server.history.find((e) => e.id !== 'h_old');
  expect(appended).toMatchObject({ status: 'ok', rows: 3, host_id: 'local' });
  expect(appended.sql).toContain('numbers(3)');
  expect(appended.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(server.requests.find((r) => r.method === 'POST' && r.path === '/history').ifMatch).toBeNull();

  await showPanel(page, 'history');
  const items = page.locator('#queryLibraryViewHistory .qhItem');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#queryLibraryViewHistory .ql__foot')).toContainText('Stored on the server');
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('earlier');
  await expect.poll(() => server.requests.some((r) => r.method === 'GET' && r.path.includes('q=earlier'))).toBe(true);
  await expect(items).toHaveCount(1);
  await page.locator('#queryLibraryViewHistory .qlSearch__input').fill('');
  await expect(items).toHaveCount(2);
  await page.locator('#queryLibraryViewHistory .qh__clear').click();
  await expect(dialog(page)).toContainText('Everyone using this server');
  await dialog(page).getByRole('button', { name: 'Clear' }).click();
  await expect(items).toHaveCount(0);
  expect(server.history).toEqual([]);
});

test('server mode read-only: badge, no editing controls, opening and copying still work', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: false });
  await seed(page, { 'chdash.savedQueries.v1': [{ name: 'Mine', sql_raw: 'SELECT 1', created_at_ms: now }] });
  await openLibrary(page);
  await expect(page.locator('#queryLibraryViewSaved .qlBadge--readonly')).toHaveText('Read-only library');
  await expect(page.locator('#queryLibraryViewSaved .ql__actions')).toBeHidden();
  // No import offer either: nothing can be written.
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
  await expect(tree(page).locator('li[draggable="true"]')).toHaveCount(0);

  await rowMenu(page, 'The answer');
  const labels = await page.locator('.qlMenu [role=menuitem] .qlMenu__label').allTextContents();
  expect(labels).toEqual(['Open in editor', 'Add as a new statement', 'Run', 'Copy SQL']);
  await menuItem(page, 'Open in editor').click();
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

  // History: no Clear and no Save to library on a read-only server.
  await runSuccessfulQuery(page, 'SELECT 5 AS five');
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toBeVisible();
  await expect(page.locator('#queryLibraryViewHistory .qh__clear')).toBeHidden();
  await expect(page.locator('#queryLibraryViewHistory .qhItem [data-action="save"]')).toHaveCount(0);
  expect(server.requests.filter((r) => r.method !== 'GET' && !r.path.startsWith('/history'))).toEqual([]);
});

test('server mode offers once to import the browser queries', async ({ page }) => {
  const server = await mockServerLibrary(page, { writable: true, library: { folders: [], queries: [] } });
  await seed(page, {
    'chdash.queryLibrary.v2': { version: 2, revision: 2, folders: [{ id: 'f_local', parent_id: null, name: 'Local folder', description: '' }], queries: [
      { id: 'q_l1', folder_id: 'f_local', name: 'Local one', description: 'from this browser', sql: 'SELECT 1', host_id: null, tags: [] },
      { id: 'q_l2', folder_id: null, name: 'Local two', description: '', sql: 'SELECT 2', host_id: null, tags: ['x'] },
    ] },
  });
  await openLibrary(page);
  const offer = page.locator('#queryLibraryViewSaved .qlNotice--import');
  await expect(offer).toContainText('2 queries are saved in this browser only');
  // The import asks first (the shared confirm, over the library).
  await offer.getByRole('button', { name: 'Import my browser queries' }).click();
  await expect(dialog(page).locator('.uiDialog__title')).toHaveText('Import browser queries');
  await expect(dialog(page)).toContainText('Import the 2 queries saved in this browser');
  await dialog(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(server.requests.some((r) => r.path === '/import')).toBe(false);
  await expect(offer).toBeVisible();
  await offer.getByRole('button', { name: 'Import my browser queries' }).click();
  await dialog(page).getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('.qlToast')).toContainText('Imported 2 browser queries');
  await expect(offer).toHaveCount(0);
  const call = server.requests.find((r) => r.method === 'POST' && r.path === '/import');
  expect(call.body.folders).toEqual([{ id: 'f_local', parent_id: null, name: 'Local folder', description: '' }]);
  expect(call.body.queries.map((q) => [q.name, q.folder_id])).toEqual([['Local one', 'f_local'], ['Local two', null]]);
  await expect(node(page, 'Local folder')).toBeVisible();
  await page.reload();
  await showPanel(page);
  await expect(page.locator('#queryLibraryViewSaved .qlNotice--import')).toHaveCount(0);
});

// --- Phone and themes -------------------------------------------------------

test('phone: the library and profiling dialogs are full-screen, a prompt is a bottom sheet, both themes', async ({ page }, testInfo) => {
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
    // No preview pane on a phone: the list takes the width.
    await expect(page.locator('#queryLibraryPreview')).toBeHidden();
    expect(Math.round((await page.locator('#queryLibraryViewSaved').boundingBox()).width)).toBe(390);
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-phone-library-${scheme}.png` });
    // A prompt is a bottom sheet over it.
    await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
    const sheet = await settled(dialog(page));
    expect([Math.round(sheet.x), Math.round(sheet.width), Math.round(sheet.y + sheet.height)]).toEqual([0, 390, 844]);
    expect(sheet.y).toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    // Choosing a query closes the sheet and fills the editor.
    await node(page, 'The answer').locator(':scope > .qlRow').click();
    await expect(panel(page)).toBeHidden();
    await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
    await button.click();
    await expect(panel(page)).toBeVisible();
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

test('themes: panel, tree and preview follow dark and light', async ({ page }, testInfo) => {
  await seed(page, { 'chdash.queryLibrary.v2': LIBRARY });
  const colors = {};
  for (const scheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: scheme });
    await openLibrary(page);
    await expandFolder(page, 'Operations');
    await node(page, 'Active parts').locator(':scope > .qlRow').hover();
    await expect(page.locator('#queryLibraryPreview .qlSql')).toBeVisible();
    colors[scheme] = await page.evaluate(() => ({
      nav: getComputedStyle(document.getElementById('queryLibraryMenu')).backgroundColor,
      name: getComputedStyle(document.querySelector('.qlRow__name')).color,
      preview: getComputedStyle(document.querySelector('#queryLibraryPreview .qlSql')).backgroundColor,
    }));
    await page.screenshot({ path: `${shotsDir}/${testInfo.project.name}-library-${scheme}.png` });
    await page.keyboard.press('Escape');
  }
  expect(colors.dark.nav).not.toBe(colors.light.nav);
  expect(colors.dark.name).not.toBe(colors.light.name);
  expect(colors.dark.preview).not.toBe(colors.light.preview);
});

// --- Live server (optional) -------------------------------------------------

const LIVE = process.env.QUERY_LIBRARY_BASE_URL || '';

test('live server library: create, save, move, reload and delete against a real instance', async ({ page }) => {
  test.skip(!LIVE, 'QUERY_LIBRARY_BASE_URL names a writable query library instance (tests/README.md).');
  const stamp = `pw-${Date.now().toString(36)}`;
  await page.goto(`${LIVE.replace(/\/+$/, '')}/query`);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  await showPanel(page);
  await expect(page.locator('#queryLibraryViewSaved .ql__foot')).toContainText('Stored on the server');

  await page.locator('#queryLibraryViewSaved [data-action="new-folder"]').click();
  await fillDialog(page, { name: `${stamp} folder` });
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(node(page, `${stamp} folder`)).toBeVisible();

  await closePanel(page);
  await page.locator('#queryTextArea').fill(`SELECT '${stamp}' AS stamp`);
  await showPanel(page);
  await page.locator('#queryLibraryViewSaved [data-action="save"]').click();
  await fillDialog(page, { name: `${stamp} query`, description: 'live check' });
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(node(page, `${stamp} query`)).toBeVisible();
  await node(page, `${stamp} query`).locator(':scope > .qlRow').dragTo(node(page, `${stamp} folder`).locator(':scope > .qlRow'));
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '2');

  // Reloaded from the server file.
  await page.reload();
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
  await showPanel(page);
  await expandFolder(page, `${stamp} folder`);
  await expect(node(page, `${stamp} query`)).toHaveAttribute('aria-level', '2');

  // The run lands in the server History.
  await node(page, `${stamp} query`).locator(':scope > .qlRow').click();
  await page.locator('#runButton').click();
  await waitForTerminal(page);
  await showPanel(page, 'history');
  await expect(page.locator('#queryLibraryViewHistory .qhItem').filter({ hasText: stamp }).first()).toBeVisible();
  await page.locator('#queryLibraryTabSaved').click();

  await rowMenu(page, `${stamp} folder`);
  await menuItem(page, 'Delete').click();
  await dialog(page).getByRole('button', { name: 'Delete all' }).click();
  await expect(node(page, `${stamp} folder`)).toHaveCount(0);
});
