import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { mockTraceResults, SYNTHETIC_TRACES } from '../helpers/traces.js';

// ns.router (app_router.js): the one owner of the address bar and the
// history (docs/ui-foundations.md, "Routes"). Deep links open what they name,
// former names are aliases rewritten with replace, opens push and moves
// replace, Back / Forward walk views and panels, a hidden view never writes
// the URL, and every page has one popstate listener.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const param = (page, name) => new URL(page.url()).searchParams.get(name);
const historyLength = (page) => page.evaluate(() => window.history.length);
const entryState = (page) => page.evaluate(() => window.history.state);
const TRACE_ID = SYNTHETIC_TRACES[0].trace_id;

// The popstate listeners on window, counted by the browser (CDP), not by
// the app's own bookkeeping.
async function popstateListeners(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter((listener) => listener.type === 'popstate').length;
  } finally {
    await cdp.detach();
  }
}

const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function logsWindow(request, minutes = 30) {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
  const end = Number(meta.time_bounds.max_ms);
  return { from: fmt(end - minutes * 60000), to: fmt(end + 1000) };
}
const logRows = (page) => page.locator('#logsTableRows .logsRow[data-row-id]');
const obsTab = (page, view) => page.locator(`#obsTabs [data-obs-tab="${view}"]`);
const cardTab = (page) => page.locator('#explorerDetailTabs [aria-selected="true"]');
const traceTab = (page, name) => page.locator('#traceViewTabs [role="tab"]', { hasText: new RegExp(`^${name}$`) });

test.describe('router', () => {
  test('one popstate listener on every page, whatever the views shown', async ({ page }) => {
    await page.goto('/query');
    await expect(page.locator('#queryTextArea')).toBeVisible();
    expect(await popstateListeners(page)).toBe(1);
    expect((await page.evaluate(() => window.ChDash.router.debug())).popstateListeners).toBe(1);

    await page.goto('/explorer/chdash_ui/weather_observations');
    await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
    await page.locator('#explorerModeGraph').click();
    await page.locator('#explorerModeBrowse').click();
    expect(await popstateListeners(page)).toBe(1);

    await mockTraceResults(page);
    await page.goto('/observability/traces');
    await expect(page.locator('#tracesSearchView')).toBeVisible();
    for (const view of ['logs', 'metrics', 'traces', 'logs']) {
      await obsTab(page, view).click();
      await expect(page).toHaveURL(new RegExp(`/observability/${view}`));
    }
    expect(await popstateListeners(page)).toBe(1);
    // The entry state has one shape.
    expect(await entryState(page)).toMatchObject({ chdash: 1, view: 'logs' });
  });

  test('Explorer deep links open what they name; former forms are replaced, not pushed', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations?tab=lineage');
    await expect(cardTab(page)).toHaveText('Lineage', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/explorer\/chdash_ui\/weather_observations\?tab=lineage$/);

    // The card tab as a path segment (and a former slug): the ?tab= form, on
    // the same entry.
    for (const [from, to, tab] of [
      ['/explorer/chdash_ui/weather_observations/ddl', /\/weather_observations\?tab=ddl$/, 'DDL'],
      ['/explorer/chdash_ui/weather_observations/data', /\/weather_observations\?tab=preview$/, 'Preview'],
      ['/explorer/chdash_ui/weather_observations/columns', /\/weather_observations$/, 'Columns'],
    ]) {
      await page.goto(from);
      const length = await historyLength(page);
      await expect(page, from).toHaveURL(to);
      await expect(cardTab(page), from).toHaveText(tab, { timeout: 15_000 });
      expect(await historyLength(page), from).toBe(length);
    }

    await page.goto('/explorer/chdash_ui/weather_observations?mode=graph&graph=storage');
    await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#explorerGraphPhysicalButton')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    await page.goto('/explorer/chdash_ui?mode=graph&graph=lineage&depth=2');
    await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/\/explorer\/chdash_ui\?mode=graph&graph=lineage&depth=2$/);
    // The former Storage view and mode: the card's Storage tab.
    await page.goto('/explorer/_system?database=chdash_ui');
    await expect(page).toHaveURL(/\/explorer\/chdash_ui\?tab=storage$/);
    await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardTab(page)).toHaveText('Storage', { timeout: 15_000 });
    await page.goto('/explorer/_functions/arrayMap');
    await expect(page.locator('#explorerFunctionsTab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#explorerFunctionsPane')).toContainText('arrayMap', { timeout: 15_000 });
  });

  test('Explorer Back / Forward walk modes and card tabs', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations');
    await expect(cardTab(page)).toHaveText('Columns', { timeout: 15_000 });
    await page.locator('#explorerDetailTabs [role="tab"]', { hasText: /^DDL$/ }).click();
    await expect(page).toHaveURL(/\?tab=ddl$/);
    expect(await entryState(page)).toMatchObject({ chdash: 1, view: 'explorer' });
    await page.locator('#explorerModeGraph').click();
    await expect(page).toHaveURL(/\?mode=graph&graph=lineage&depth=1$/);
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=ddl$/);
    await expect(page.locator('#explorerModeBrowse')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardTab(page)).toHaveText('DDL');
    await page.goBack();
    await expect(page).toHaveURL(/\/weather_observations$/);
    await expect(cardTab(page)).toHaveText('Columns');
    await page.goForward();
    await page.goForward();
    await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-pressed', 'true');
  });

  test('Query deep link: ?sql= fills the editor and the address follows the run', async ({ page }) => {
    await page.goto(`/query?sql=${encodeURIComponent('SELECT 42 AS answer')}`);
    await expect(page.locator('#queryTextArea')).toHaveValue('SELECT 42 AS answer');
    const length = await historyLength(page);
    await page.locator('#runButton').click();
    await expect.poll(() => param(page, 'sql')).toMatch(/SELECT\s+42/);
    // The Query page only ever replaces its entry.
    expect(await historyLength(page)).toBe(length);
  });

  test('Observability deep links: views, sub-tabs, a trace tab and its former ?view=', async ({ page, request }) => {
    const win = await logsWindow(request);
    await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}&tab=patterns`);
    await expect(page.locator('#logsTabPatterns')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });

    await page.goto('/observability/metrics?from=now-1h&to=now&panel=metric%3Dx');
    await expect(page.locator('.metricsPanel')).toHaveCount(2, { timeout: 30_000 });
    expect(new URL(page.url()).searchParams.getAll('panel')).toHaveLength(1);

    await mockTraceResults(page);
    await page.goto('/observability/traces?tab=map');
    await expect(page.locator('#tracesTabs [data-trace-tab="map"]')).toHaveAttribute('aria-selected', 'true');
    // /observability opens the first enabled view in place.
    await page.goto('/observability');
    await expect(page).toHaveURL(/\/observability\/traces(\?|$)/);

    await page.goto(`/observability/traces/${TRACE_ID}?tab=flamegraph`);
    await expect(traceTab(page, 'Flamegraph')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}\\?tab=flamegraph$`));
    // The former ?view= (and a search tab= carried by an old trace URL): the
    // trace tab, on the same entry.
    await page.goto(`/observability/traces/${TRACE_ID}?view=statistics&tab=map`);
    const length = await historyLength(page);
    await expect(traceTab(page, 'Statistics')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}\\?tab=statistics$`));
    expect(await historyLength(page)).toBe(length);
    // A trace tab switch replaces the entry.
    await traceTab(page, 'Spans').click();
    await expect(page).toHaveURL(/\?tab=spans$/);
    expect(await historyLength(page)).toBe(length);
  });

  test('Back / Forward across views and a panel; opens push, moves replace', async ({ page, request }) => {
    const win = await logsWindow(request);
    await mockTraceResults(page);
    await page.goto('/observability/traces');
    await expect(page.locator('#tracesSearchView')).toBeVisible();
    await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`);
    await expect(logRows(page).nth(1)).toBeVisible({ timeout: 30_000 });
    const logsLength = await historyLength(page);
    const [first, second] = [await logRows(page).nth(0).getAttribute('data-row-id'), await logRows(page).nth(1).getAttribute('data-row-id')];
    const panel = page.locator('#logsSidePanel');

    // Open: one entry, marked as the panel's own.
    await logRows(page).nth(0).click();
    await expect(panel).toBeVisible();
    await expect.poll(() => param(page, 'log')).toBe(first);
    expect(await historyLength(page)).toBe(logsLength + 1);
    expect(await entryState(page)).toMatchObject({ chdash: 1, view: 'logs', detail: 'detail:log' });
    // Move: the same entry.
    await logRows(page).nth(1).click();
    await expect.poll(() => param(page, 'log')).toBe(second);
    expect(await historyLength(page)).toBe(logsLength + 1);

    // A view switch pushes; Back returns to Logs with the panel open.
    await obsTab(page, 'metrics').click();
    await expect(page).toHaveURL(/\/observability\/metrics/);
    expect(await historyLength(page)).toBe(logsLength + 2);
    await page.goBack();
    await expect(page).toHaveURL(/\/observability\/logs/);
    await expect(panel).toBeVisible();
    expect(param(page, 'log')).toBe(second);
    // Back closes the panel, then leaves Logs for Traces.
    await page.goBack();
    await expect(panel).toBeHidden();
    expect(param(page, 'log')).toBe(null);
    await page.goBack();
    await expect(page).toHaveURL(/\/observability\/traces/);
    await expect(page.locator('#tracesSearchView')).toBeVisible();
    expect(await historyLength(page)).toBe(logsLength + 2);
    // Forward walks the same entries again.
    await page.goForward();
    await expect(page).toHaveURL(/\/observability\/logs/);
    await page.goForward();
    await expect(panel).toBeVisible();
    await expect.poll(() => param(page, 'log')).toBe(second);
    // Closing the panel on its own entry goes Back (no entry left behind).
    await panel.locator('.uiDetail__close').click();
    await expect(panel).toBeHidden();
    await expect.poll(() => param(page, 'log')).toBe(null);
    await page.goForward();
    await expect(panel).toBeVisible();
  });

  test('a hidden view never writes the URL', async ({ page, request }) => {
    const win = await logsWindow(request);
    await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`);
    await expect(logRows(page).first()).toBeVisible({ timeout: 30_000 });
    await obsTab(page, 'metrics').click();
    await expect(page).toHaveURL(/\/observability\/metrics/);
    const url = page.url();
    const length = await historyLength(page);
    const written = await page.evaluate(async () => {
      const ns = window.ChDash;
      const logs = ns.router.owner('logs');
      const out = {
        active: logs.active(),
        metricsActive: ns.router.owner('metrics').active(),
        push: logs.push({ q: 'hidden' }),
        replace: logs.replace({ q: 'hidden' }),
        panel: logs.panel('log').open('x'),
      };
      // The Logs view's own search, run while it is hidden.
      ns.logs.model.q = 'hidden';
      await ns.logs.search({ push: true });
      return out;
    });
    expect(written).toEqual({ active: false, metricsActive: true, push: false, replace: false, panel: false });
    await expect(page).toHaveURL(url);
    expect(await historyLength(page)).toBe(length);
    // Back on Logs, the view writes again.
    await obsTab(page, 'logs').click();
    await expect(page).toHaveURL(/\/observability\/logs/);
    expect(await page.evaluate(() => window.ChDash.router.owner('logs').active())).toBe(true);
  });

  test('router.push / replace merge params and drop empty ones; panel helpers', async ({ page }) => {
    await page.goto('/query');
    await expect(page.locator('#queryTextArea')).toBeVisible();
    const result = await page.evaluate(() => {
      const r = window.ChDash.router;
      const start = window.history.length;
      const steps = {};
      r.push({ a: '1', b: ['x', 'y'] }, { view: 'query' });
      steps.push = [window.location.search, window.history.length - start, window.history.state];
      r.replace({ a: null, b: [], c: '' , d: '4' });
      steps.replace = [window.location.search, window.history.length - start];
      steps.noop = r.replace({ d: '4' });
      steps.samePush = r.push({ d: '4' });
      const p = r.panel('item');
      p.open('one');
      steps.open = [window.location.search, window.history.length - start, p.owned()];
      p.move('two');
      steps.move = [window.location.search, window.history.length - start, p.owned()];
      r.replace({ other: 'z' });
      steps.changed = p.owned();
      return steps;
    });
    expect(result.push).toEqual(['?a=1&b=x&b=y', 1, { chdash: 1, view: 'query' }]);
    expect(result.replace).toEqual(['?d=4', 1]);
    expect(result.noop).toBe(false);
    expect(result.samePush).toBe(false);
    expect(result.open).toEqual(['?d=4&item=one', 2, true]);
    expect(result.move).toEqual(['?d=4&item=two', 2, true]);
    // Something else changed on the entry: close() replaces instead of going Back.
    expect(result.changed).toBe(false);
    const closed = await page.evaluate(() => {
      const start = window.history.length;
      const back = window.ChDash.router.panel('item').close();
      return { back, search: window.location.search, length: window.history.length - start };
    });
    expect(closed).toEqual({ back: false, search: '?d=4&other=z', length: 0 });
  });
});
