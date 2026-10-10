import { test, expect } from '@playwright/test';
import { expandExplorerDatabase } from '../helpers/app.js';
import { appReady } from '../helpers/modules.js';

// Reads that end, and answers that never overwrite a newer one (docs/ui-foundations.md, "Requests"): the one request
// path has a timeout, an HTML answer of a proxy keeps its status, and the Explorer, System and Observability pages abort
// what a newer read, a changed filter or another host makes useless. A read that is superseded stops in the browser
// (and so on the server), and its answer is never drawn.

// Every fetch that gets an AbortSignal is recorded when that signal aborts: window.__aborted lists the URLs.
async function trackAborts(page) {
  await page.addInitScript(() => {
    window.__aborted = [];
    const original = window.fetch;
    window.fetch = function tracked(input, init) {
      const url = String((input && input.url) || input);
      const signal = init && init.signal;
      if (signal) signal.addEventListener('abort', () => window.__aborted.push(url));
      return original.apply(this, arguments);
    };
  });
}
const aborted = (page, part) => page.evaluate((needle) => window.__aborted.filter((url) => url.includes(needle)).length, part);

// ---- the request path ---------------------------------------------------------------------------------------------

test('a request that gets no answer ends with a timeout, told from an abort, and does not mark the server offline', async ({ page }) => {
  await page.goto('/system');
  await appReady(page);
  const result = await page.evaluate(async () => {
    const api = window.ChDash.api;
    const realFetch = window.fetch;
    window.fetch = (url, init) => new Promise((resolve, reject) => {
      // A fetch that never answers; it rejects only when its signal aborts, like a real one.
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const out = {};
    const t0 = performance.now();
    try { await api.request('api/never', { timeoutMs: 250 }); } catch (e) { out.timeout = { code: e.code, name: e.name, abort: window.ChDash.util.isAbort(e), ms: Math.round(performance.now() - t0) }; }
    const own = new AbortController();
    setTimeout(() => own.abort(), 50);
    try { await api.request('api/never', { signal: own.signal, timeoutMs: 5000 }); } catch (e) { out.abort = { code: e.code, abort: window.ChDash.util.isAbort(e) }; }
    out.online = window.ChDash.state.apiOnline;
    window.fetch = realFetch;
    return out;
  });
  expect(result.timeout.code).toBe('timeout');
  expect(result.timeout.abort).toBe(false);
  expect(result.timeout.ms).toBeGreaterThanOrEqual(240);
  expect(result.timeout.ms).toBeLessThan(2000);
  expect(result.abort).toEqual({ code: 'aborted', abort: true });
  expect(result.online).toBe(true);
});

test('an HTML answer of a proxy keeps its status: 404, 413 and 502 are errors with .status, and a 502 is not an online server', async ({ page }) => {
  await page.goto('/system');
  await appReady(page);
  const result = await page.evaluate(async () => {
    const api = window.ChDash.api;
    const realFetch = window.fetch;
    const html = (status) => new Response('<html><body>Bad Gateway</body></html>', { status, headers: { 'Content-Type': 'text/html' } });
    const out = {};
    for (const status of [404, 413, 502]) {
      window.fetch = () => Promise.resolve(html(status));
      try { await api.request('api/x'); } catch (e) { out[status] = { status: e.status, code: e.code, online: window.ChDash.state.apiOnline, body: typeof e.body }; }
    }
    // The JSON error of the application itself, with a 503, is the application answering: online.
    window.ChDash.state.apiOnline = true;
    window.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'refresh_in_progress', error_code: 'refresh_in_progress', message: 'busy' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    try { await api.request('api/x'); } catch (e) { out.app503 = { status: e.status, code: e.code, online: window.ChDash.state.apiOnline }; }
    // A 200 that is not JSON is still an invalid answer.
    window.fetch = () => Promise.resolve(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    try { await api.request('api/x'); } catch (e) { out.notJson = { code: e.code, status: e.status ?? null }; }
    window.fetch = realFetch;
    return out;
  });
  expect(result[404].status).toBe(404);
  expect(result[413].status).toBe(413);
  expect(result[502]).toMatchObject({ status: 502, online: false, body: 'object' });
  expect(result.app503).toEqual({ status: 503, code: 'refresh_in_progress', online: true });
  expect(result.notJson).toEqual({ code: 'invalid_api_response', status: null });
});

// ---- the Explorer -------------------------------------------------------------------------------------------------

test('a stored host that is not listed: its catalog read is aborted when the page switches host, and the tree loads the real one', async ({ page }) => {
  await trackAborts(page);
  await page.addInitScript(() => { try { localStorage.setItem('chdash.selectedHost', 'ghost'); } catch (_) {} });
  // The ghost's answer is slow: the hosts stream switches the page to the first listed host meanwhile.
  await page.route(/\/api\/explorer\/catalog\?.*host_id=ghost/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.fulfill({ status: 404, json: { error: 'unknown_host', message: 'Unknown host.' } }).catch(() => {});
  });
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerTableList')).toContainText('chdash_ui', { timeout: 8000 });
  await expect(page.locator('#explorerTableList')).not.toContainText('Loading databases');
  expect(await aborted(page, 'host_id=ghost')).toBeGreaterThan(0);
});

test('a click on another table while a database loads: the newer click is the card, the older one never replaces it', async ({ page }) => {
  await trackAborts(page);
  await page.goto('/explorer/catalog');
  await expandExplorerDatabase(page, 'chdash_ui');
  // The branch of the other database answers late.
  await page.route(/\/api\/explorer\/catalog\?.*database=chdash_rich_scratch/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => {});
  });
  await page.evaluate(() => { void window.ChDash.explorer.selectTable('chdash_rich_scratch', 'otel_logs'); });
  await page.locator('#explorerTableList .explorerTreeObject[data-table="weather_observations"]').click();
  await expect(page.locator('#explorerDetailName')).toHaveText(/weather_observations/, { timeout: 15_000 });
  // The late branch has answered by now: the card is still the newer click.
  await page.waitForTimeout(2200);
  await expect(page.locator('#explorerDetailName')).toHaveText(/weather_observations/);
  await expect(page).toHaveURL(/weather_observations/);
});

test('the preview of a table that was left is aborted, and the preview of the next table loads (it never waits for the first)', async ({ page }) => {
  await trackAborts(page);
  await page.goto('/explorer/catalog/chdash_ui/weather_observations');
  await expect(page.locator('#explorerDetailName')).toHaveText(/weather_observations/, { timeout: 15_000 });
  await page.route('**/api/explorer/table/data', async (route) => {
    const body = route.request().postDataJSON();
    if (body.table === 'weather_observations') await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue().catch(() => {});
  });
  await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Preview' }).click();
  await expect(page.locator('#explorerDetailContent')).toContainText('Loading the preview');
  // Another table, the Preview tab kept: its preview is asked for at once.
  await expandExplorerDatabase(page, 'chdash_ui');
  await page.locator('#explorerTableList .explorerTreeObject[data-table="weather_daily_summary"]').click();
  await expect(page.locator('#explorerDetailName')).toHaveText(/weather_daily_summary/, { timeout: 15_000 });
  await expect(page.locator('.explorerPreviewToolbar')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#explorerDetailContent')).not.toContainText('Loading the preview');
  expect(await aborted(page, '/api/explorer/table/data')).toBeGreaterThan(0);
});

test('an unknown function in the address keeps the catalog: the list stays, the page says the function is not there', async ({ page }) => {
  await page.goto('/explorer/functions/doesNotExistFunction');
  await expect(page.locator('#explorerFunctionList')).toContainText(/All functions \(\d/, { timeout: 20_000 });
  await expect(page.locator('#explorerFunctionList')).not.toContainText('No functions found');
  await expect(page.locator('#explorerError')).toContainText('doesNotExistFunction is not a function of this host');
});

// ---- System -------------------------------------------------------------------------------------------------------

test('System Overview: a forced Refresh replaces the read in flight (it is aborted) instead of being ignored', async ({ page }) => {
  await trackAborts(page);
  const seen = [];
  let first = true;
  await page.route(/\/api\/system\/overview\?/, async (route) => {
    seen.push(route.request().url());
    if (first) {
      first = false;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    await route.continue().catch(() => {});
  });
  // 'commit': the held read must not make the navigation wait for it.
  await page.goto('/system', { waitUntil: 'commit' });
  await expect.poll(() => seen.length).toBe(1);
  // The Refresh button is disabled while the section loads: a forced refresh in flight comes from the view's own call
  // (a host change, or the page showing again).
  await page.evaluate(() => window.ChDash.systemView.refresh(true));
  await expect.poll(() => seen.some((url) => url.includes('refresh=1'))).toBe(true);
  expect(await aborted(page, '/api/system/overview')).toBe(1);
  await expect(page.locator('#systemTopology')).toBeVisible({ timeout: 20_000 });
});

test('System Queries: a changed filter aborts the read in flight, and the page shows the answer of the last filter', async ({ page }) => {
  await trackAborts(page);
  const kinds = [];
  await page.route(/\/api\/system\/queries\?/, async (route) => {
    const url = new URL(route.request().url());
    kinds.push(url.searchParams.get('kind') || 'all');
    if (kinds.length === 1) await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue().catch(() => {});
  });
  await page.goto('/system/queries?sort=calls', { waitUntil: 'commit' });
  await expect.poll(() => kinds.length).toBe(1);
  await page.evaluate(() => {
    const select = document.getElementById('systemQueriesKind');
    select.value = 'Select';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(() => kinds.length).toBe(2);
  expect(kinds[1]).toBe('Select');
  expect(await aborted(page, '/api/system/queries?')).toBe(1);
  await expect(page).toHaveURL(/kind=Select/);
});

// ---- Observability ------------------------------------------------------------------------------------------------

for (const [name, path, search] of [
  ['Logs', '/observability/logs', '/api/logs/search'],
  ['Traces', '/observability/traces', '/api/traces/search'],
]) {
  test(`${name}: a host change aborts the search of the old host at once`, async ({ page }) => {
    await trackAborts(page);
    let held = 0;
    await page.route(new RegExp(search.replace(/\//g, '\\/')), async (route) => {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue().catch(() => {});
    });
    await page.goto(path, { waitUntil: 'commit' });
    await expect.poll(() => held).toBeGreaterThan(0);
    // Another host is selected: the old host's search stops now, not when its answer comes.
    await page.evaluate(() => {
      window.ChDash.state.selectedHostId = 'ghost-host';
      window.dispatchEvent(new CustomEvent('chdash:host-changed', { detail: { hostId: 'ghost-host' } }));
    });
    await expect.poll(() => aborted(page, search)).toBeGreaterThan(0);
  });
}
