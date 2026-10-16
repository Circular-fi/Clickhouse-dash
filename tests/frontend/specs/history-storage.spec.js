import { test, expect } from '@playwright/test';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';
import { historyRecords } from '../helpers/history.js';

// The browser storage budgets are in docs/query-library.md ("History") and docs/ui-foundations.md ("Browser storage").
// The query History is in IndexedDB. A run writes its own record. A list is never read and written as a whole.
// A refused write gives a visible warning. Each host has its own cap.
//
// The metadata catalogue of localStorage is a cache for two hosts at most. It is stored in a compact form.
// It is removed before the user library is.

const HOST = 'local';

async function seed(page, values) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem('hs.seeded')) return;
    sessionStorage.setItem('hs.seeded', '1');
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }, values);
}

// ---- History in IndexedDB -------------------------------------------------------------------------------------------

test('a run is recorded in IndexedDB, with its outcome, and localStorage holds no History', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 7 AS indexeddb_probe');
  await expect.poll(async () => (await historyRecords(page)).find((r) => r.sql_raw === 'SELECT 7 AS indexeddb_probe')?.status).toBe('ok');
  const record = (await historyRecords(page)).find((r) => r.sql_raw === 'SELECT 7 AS indexeddb_probe');
  expect(record).toMatchObject({ host_id: HOST, status: 'ok', rows: 1 });
  expect(typeof record.id).toBe('number');
  expect(await page.evaluate(() => localStorage.getItem('chdash.queryHistory.v1'))).toBeNull();
});

test('a run does not read or write the whole list: one record is put for its start and one for its outcome', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.ChDash.history.ready;
    window.__puts = 0;
    window.__getAlls = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function counted(...args) { window.__puts += 1; return put.apply(this, args); };
    // The list of a host is read through its index (app_history.js). The reads of the test use the store.
    const getAll = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function counted(...args) { window.__getAlls += 1; return getAll.apply(this, args); };
  });
  await runSuccessfulQuery(page, 'SELECT 8 AS one_record_per_write');
  await expect.poll(async () => (await historyRecords(page)).find((r) => r.sql_raw === 'SELECT 8 AS one_record_per_write')?.status).toBe('ok');
  const counts = await page.evaluate(() => ({ puts: window.__puts, getAlls: window.__getAlls }));
  // The start and the outcome are single records. The History formats an unformatted query when it shows that query.
  expect(counts.puts).toBeLessThanOrEqual(2);
  // The page reads the list of the host once, at the first add of the page. A run never reads the list again.
  expect(counts.getAlls).toBeLessThanOrEqual(1);
});

test('the Format button writes no History entry, and a run does not ask the formatter on behalf of its History', async ({ page }) => {
  await openApp(page);
  const formats = [];
  await page.route('**/api/format', async (route) => { formats.push(route.request().postData()); await route.continue(); });
  // Clear the auto-format option. A run then sends no format request of its own.
  await page.locator('#runSettingsButton').click();
  if ((await page.locator('#runOptAutoFormat').getAttribute('aria-checked')) === 'true') await page.locator('#runOptAutoFormat').click();
  await expect(page.locator('#runOptAutoFormat')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#runSettingsButton').click();
  await runSuccessfulQuery(page, 'select 9 as history_without_format');
  await expect.poll(async () => (await historyRecords(page)).find((r) => r.sql_raw === 'select 9 as history_without_format')?.status).toBe('ok');
  await page.waitForTimeout(500);
  expect(formats).toHaveLength(0);
  const before = (await historyRecords(page)).length;
  // The Format button formats the editor. It records nothing.
  await page.locator('#queryTextArea').fill('select 10 as only_formatted');
  await page.locator('#formatButton').click();
  await expect.poll(() => formats.length).toBe(1);
  await page.waitForTimeout(500);
  const after = await historyRecords(page);
  expect(after.length).toBe(before);
  expect(after.some((r) => r.sql_raw.includes('only_formatted'))).toBe(false);
});

test('the older localStorage History is moved into the database once and its key is removed', async ({ page }) => {
  const day = Date.UTC(2026, 9, 1, 12, 0, 0);
  await seed(page, {
    'chdash.queryHistory.v1': [
      { ts_ms: day, sql_raw: 'SELECT 1 AS older_one', host_id: HOST, status: 'ok', elapsed_ms: 3, rows: 1 },
      { ts_ms: day + 1000, sql_raw: 'SELECT 2 AS older_two', host_id: 'elsewhere', status: 'ok', elapsed_ms: 3, rows: 1 },
      { ts_ms: day + 2000, sql_raw: 'SELECT 3 AS hostless', status: 'ok' },
    ],
  });
  await openApp(page);
  const records = await historyRecords(page);
  expect(records.map((r) => r.sql_raw).sort()).toEqual(['SELECT 1 AS older_one', 'SELECT 2 AS older_two']);
  expect(await page.evaluate(() => localStorage.getItem('chdash.queryHistory.v1'))).toBeNull();
  // The History tab of the library reads the records from the database.
  await page.locator('#queryLibraryButton').click();
  await page.locator('#queryLibraryTabHistory').click();
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toHaveCount(1);
  await expect(page.locator('#queryLibraryViewHistory .qhItem')).toContainText('older_one');
});

test('each host has its own cap: 50 runs, the same text once, and a busy host does not push the others out', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const history = window.ChDash.history;
    await history.ready;
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 3; i += 1) await history.add({ ts_ms: base + i, host_id: 'quiet', sql_raw: `SELECT ${i} AS quiet` });
    for (let i = 0; i < 60; i += 1) await history.add({ ts_ms: base + 100 + i, host_id: 'busy', sql_raw: `SELECT ${i} AS busy` });
    // The same text again moves to the top. It makes no second entry.
    await history.add({ ts_ms: base + 500, host_id: 'busy', sql_raw: 'SELECT 59 AS busy' });
    const busy = await history.list('busy');
    const quiet = await history.list('quiet');
    return { busy: busy.length, first: busy[0].sql_raw, firstTs: busy[0].ts_ms, base, last: busy[busy.length - 1].sql_raw, quiet: quiet.length, limits: history.LIMITS };
  });
  expect(result.busy).toBe(50);
  expect(result.first).toBe('SELECT 59 AS busy');
  expect(result.firstTs).toBe(result.base + 500);
  expect(result.last).toBe('SELECT 10 AS busy');
  expect(result.quiet).toBe(3);
  expect(result.limits).toMatchObject({ entries: 50, bytes: 2 * 1024 * 1024, sqlChars: 256 * 1024 });
  // The same records are in the database after a reload.
  await page.reload();
  const records = await historyRecords(page);
  expect(records.filter((r) => r.host_id === 'busy')).toHaveLength(50);
  expect(records.filter((r) => r.host_id === 'quiet')).toHaveLength(3);
});

test('a text over the cap is stored cut and says so; Load reaches the preview with the note', async ({ page }) => {
  await openApp(page);
  const flagged = await page.evaluate(async () => {
    const history = window.ChDash.history;
    await history.ready;
    await history.add({ ts_ms: Date.now(), host_id: 'local', sql_raw: `SELECT '${'x'.repeat(300 * 1024)}'` });
    const [entry] = await history.list('local');
    return { truncated: entry.truncated === true, length: entry.sql_raw.length };
  });
  expect(flagged).toEqual({ truncated: true, length: 256 * 1024 });
  await page.locator('#queryLibraryButton').click();
  await page.locator('#queryLibraryTabHistory').click();
  await page.locator('#queryLibraryViewHistory .qhItem').first().click();
  await expect(page.locator('#queryLibraryPreview .qlPreview__facts')).toContainText('Cut at 262,144 characters');
});

test('a refused write is a visible warning, and the query still runs', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    await window.ChDash.history.ready;
    IDBObjectStore.prototype.put = function refuse() { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
    IDBObjectStore.prototype.add = IDBObjectStore.prototype.put;
  });
  await runSuccessfulQuery(page, 'SELECT 9 AS quota_probe');
  const toast = page.locator('#historyToast');
  await expect(toast).toBeVisible({ timeout: 10_000 });
  await expect(toast).toContainText('History could not be saved');
  await expect(toast).toContainText('storage is full');
  await expect(toast).toHaveAttribute('role', 'alert');
  // A click dismisses it.
  await toast.click();
  await expect(toast).toBeHidden();
  // The page still lists the run of this session in its History.
  await page.locator('#queryLibraryButton').click();
  await page.locator('#queryLibraryTabHistory').click();
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toContainText('quota_probe');
});

test('without IndexedDB the runs stay in the page, with a warning once', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); });
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT 10 AS memory_only');
  await expect(page.locator('#historyToast')).toContainText('kept in this page only');
  const status = await page.evaluate(() => window.ChDash.history.status());
  expect(status.stored).toBe(false);
  await page.locator('#queryLibraryButton').click();
  await page.locator('#queryLibraryTabHistory').click();
  await expect(page.locator('#queryLibraryViewHistory .qhItem').first()).toContainText('memory_only');
});

test('another tab that runs a query makes this tab read the list again', async ({ context, page }) => {
  await openApp(page);
  await page.locator('#queryLibraryButton').click();
  await page.locator('#queryLibraryTabHistory').click();
  await expect(page.locator('#queryLibraryViewHistory .qhList, #queryLibraryViewHistory .qlEmpty').first()).toBeVisible();
  const before = await page.locator('#queryLibraryViewHistory .qhItem').count();
  const other = await context.newPage();
  await openApp(other);
  await runSuccessfulQuery(other, 'SELECT 11 AS from_the_other_tab');
  await expect.poll(() => page.locator('#queryLibraryViewHistory .qhItem').count(), { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(page.locator('#queryLibraryViewHistory')).toContainText('from_the_other_tab');
  await other.close();
});

// ---- the metadata cache of localStorage -------------------------------------------------------------------------------

test('the metadata catalogue keeps two hosts at most: the least recently used host loses its keys', async ({ page }) => {
  const meta = (host) => ({
    [`chdash.meta.v1.${host}.keywords`]: { updated_at_ms: Date.now(), items: ['SELECT', 'FROM'] },
    [`chdash.meta.v1.${host}.functions`]: { updated_at_ms: Date.now(), items: [{ name: 'abs' }] },
    [`chdash.meta.v1.${host}.settings`]: { updated_at_ms: Date.now(), items: [{ name: 'max_threads' }] },
  });
  await seed(page, { ...meta('h1'), ...meta('h2'), ...meta('h3'), ...meta('h4'), 'chdash.meta.v1.hosts': ['h1', 'h2', 'h3', 'h4'] });
  await openApp(page);
  // The page uses the host "local". Its catalogue is the most recent. The catalogue before it stays. The other catalogues are removed.
  const hosts = await page.evaluate(() => {
    window.ChDash.meta.hydrateFromStorage('local');
    const found = new Set();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const match = /^chdash\.meta\.v1\.(.+)\.(keywords|functions|settings|tables|databases|formats|data_types|table_functions)$/.exec(key);
      if (match) found.add(match[1]);
    }
    return { found: [...found].sort(), list: JSON.parse(localStorage.getItem('chdash.meta.v1.hosts')) };
  });
  expect(hosts.found.length).toBeLessThanOrEqual(2);
  expect(hosts.found).not.toContain('h1');
  expect(hosts.found).not.toContain('h2');
  expect(hosts.list.at(-1)).toBe('local');
  expect(hosts.list.length).toBeLessThanOrEqual(2);
});

test('the catalogue of a host is stored compact: the empty fields and the false flags are left out', async ({ page }) => {
  await openApp(page);
  await page.locator('#queryTextArea').focus();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('chdash.meta.v1.local.functions') !== null), { timeout: 20_000 }).toBe(true);
  const sizes = await page.evaluate(() => {
    const out = {};
    for (const type of ['functions', 'settings', 'tables']) out[type] = (localStorage.getItem(`chdash.meta.v1.local.${type}`) || '').length;
    const functions = JSON.parse(localStorage.getItem('chdash.meta.v1.local.functions')).items;
    return { sizes: out, withFalse: functions.filter((item) => item.is_aggregate === false || item.origin === '').length, count: functions.length };
  });
  expect(sizes.withFalse).toBe(0);
  expect(sizes.count).toBeGreaterThan(100);
  // A function takes about 30 characters here, not the 118 characters of its full form.
  expect(sizes.sizes.functions / sizes.count).toBeLessThan(70);
  // When the page reads the compact form, it gets the full form.
  const back = await page.evaluate(() => {
    window.ChDash.meta.hydrateFromStorage('local');
    const item = window.ChDash.state.meta.hosts.local.functions.items[0];
    return { aggregate: typeof item.is_aggregate, origin: typeof item.origin };
  });
  expect(back).toEqual({ aggregate: 'boolean', origin: 'string' });
});

test('a library write that the browser refuses drops the metadata cache first, then succeeds', async ({ page }) => {
  await seed(page, {
    'chdash.meta.v1.local.keywords': { updated_at_ms: Date.now(), items: ['SELECT'] },
    'chdash.meta.v1.local.functions': { updated_at_ms: Date.now(), items: [{ name: 'abs' }] },
  });
  await openApp(page);
  await page.evaluate(() => {
    // The quota is full while the cache holds any data. Only a library write after the cache is removed succeeds.
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function limited(key, value) {
      if (key === 'chdash.queryLibrary.v2' && Object.keys(localStorage).some((k) => k.startsWith('chdash.meta.v1.') && k !== 'chdash.meta.v1.hosts')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
  });
  await page.locator('#queryTextArea').fill('SELECT 12 AS saved_when_full');
  await page.locator('#editorSaveButton').click();
  await page.locator('#queryLibraryPreview form.qlPaneForm [name="name"]').waitFor();
  await page.locator('#queryLibraryPreview form.qlPaneForm [name="name"]').fill('Saved when full');
  await page.locator('#queryLibraryPreview form.qlPaneForm button[type="submit"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('chdash.queryLibrary.v2') || 'null')?.queries?.some((q) => q.name === 'Saved when full') === true), { timeout: 10_000 }).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /^chdash\.meta\.v1\.local\./.test(k)).length)).toBe(0);
});

test('a metadata read that fails is not asked again at once', async ({ page }) => {
  await openApp(page);
  let asked = 0;
  await page.route(/\/api\/meta\?.*types=columns/, (route) => { asked += 1; return route.fulfill({ status: 500, json: { error: 'boom', message: 'boom' } }); });
  const answers = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 5; i += 1) out.push(await window.ChDash.meta.ensureTableColumns('chdash_ui', 'weather_observations'));
    return out;
  });
  expect(answers).toEqual([null, null, null, null, null]);
  expect(asked).toBe(1);
});
