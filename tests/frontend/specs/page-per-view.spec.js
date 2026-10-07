import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';

// Every view of Observability, System and the Explorer is an HTML page of its own: its own shell,
// its own modules, its own stylesheet, one controller. Each opens without a script error, names
// itself (body data-page, the loader's page entry), lists only the modules of its view, and links
// to its siblings, itself marked as the current page.

const PAGES = [
  { path: '/observability/traces', name: 'traces', body: 'observability', row: '#obsTabs', current: '#obsTab-traces', controller: 'app_obs_page.js', own: ['app_traces.js'], never: ['app_logs.js', 'app_metrics.js', 'app_system_view.js', 'app_explorer.js'] },
  { path: '/observability/logs', name: 'logs', body: 'observability', row: '#obsTabs', current: '#obsTab-logs', controller: 'app_obs_page.js', own: ['app_logs.js'], never: ['app_traces.js', 'app_metrics.js', 'app_system_view.js', 'app_explorer.js'] },
  { path: '/observability/metrics', name: 'metrics', body: 'observability', row: '#obsTabs', current: '#obsTab-metrics', controller: 'app_obs_page.js', own: ['app_metrics.js'], never: ['app_traces.js', 'app_logs.js', 'app_system_view.js', 'app_explorer.js'] },
  { path: '/system', name: 'system', body: 'system', row: '#systemTabs', current: '#systemTab-overview', controller: 'app_system.js', own: ['app_system_overview.js', 'app_system_perf.js'], never: ['app_system_queries.js', 'app_system_disks.js', 'app_traces.js', 'app_explorer.js'] },
  { path: '/system/queries', name: 'queries', body: 'system', row: '#systemTabs', current: '#systemTab-queries', controller: 'app_system.js', own: ['app_system_queries.js'], never: ['app_system_overview.js', 'app_system_disks.js', 'app_system_perf.js', 'app_explorer.js'] },
  { path: '/system/disks', name: 'disks', body: 'system', row: '#systemTabs', current: '#systemTab-disks', controller: 'app_system.js', own: ['app_system_disks.js'], never: ['app_system_overview.js', 'app_system_queries.js', 'app_system_perf.js', 'app_explorer.js'] },
  { path: '/explorer/catalog', name: 'explorer', body: 'explorer', row: '#explorerViewTabs', current: '#explorerCatalogTab', controller: 'app.js', own: ['app_explorer.js', 'app_explorer_graph.js', 'app_explorer_detail.js'], never: ['app_system_view.js', 'app_traces.js'] },
  { path: '/explorer/functions', name: 'functions', body: 'explorer', row: '#explorerViewTabs', current: '#explorerFunctionsTab', controller: 'app.js', own: ['app_explorer.js'], never: ['app_explorer_graph.js', 'app_explorer_detail.js', 'app_explorer_storage.js', 'app_explorer_treemap.js', 'app_system_view.js', 'app_traces.js'] },
];

for (const spec of PAGES) {
  test(`${spec.path} is a page of its own: ${spec.name}`, async ({ page }) => {
    const observers = installObservers(page);
    await page.goto(spec.path);
    await page.waitForFunction(() => !!(window.ChDash?.features && window.ChDash?.api && window.ChDash?.ui));
    await expect(page.locator('body')).toHaveAttribute('data-page', spec.body);
    const state = await page.evaluate(() => ({
      page: window.ChDash.loader.page.name,
      scripts: [...document.scripts].map((s) => (s.getAttribute('src') || '').split('/').pop().split('?')[0]).filter(Boolean),
      sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0]),
    }));
    expect(state.page).toBe(spec.name);
    expect(state.sheets).toEqual([`style.${spec.name}.css`]);
    // The controller and the modules of this view, none of the other views'.
    expect(state.scripts.filter((name) => name === spec.controller)).toHaveLength(1);
    for (const name of spec.own) expect(state.scripts, name).toContain(name);
    for (const name of spec.never) expect(state.scripts, name).not.toContain(name);
    expect(new Set(state.scripts).size).toBe(state.scripts.length);
    // The row of links: this page current, the others plain links to their own pages.
    const links = page.locator(`${spec.row} a.contentTabs__tab:visible`);
    expect(await links.count()).toBeGreaterThan(1);
    await expect(page.locator(spec.current)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator(`${spec.row} [aria-current="page"]`)).toHaveCount(1);
    const hrefs = await links.evaluateAll((els) => els.map((el) => new URL(el.href).pathname));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    await page.waitForTimeout(1500);
    expect(observers.pageErrors).toEqual([]);
    expect(observers.consoleErrors.filter((entry) => !/Failed to load resource/.test(entry.text))).toEqual([]);
    expect(unexpectedFailures(observers.failedRequests)).toEqual([]);
  });
}

test('the links of a row open the sibling pages', async ({ page }) => {
  for (const [from, link, to] of [
    ['/observability/traces', '#obsTab-logs', '/observability/logs'],
    ['/observability/logs', '#obsTab-metrics', '/observability/metrics'],
    ['/system', '#systemTab-disks', '/system/disks'],
    ['/system/disks', '#systemTab-queries', '/system/queries'],
    ['/system/queries', '#systemTab-overview', '/system'],
    ['/explorer/catalog', '#explorerFunctionsTab', '/explorer/functions'],
    ['/explorer/functions', '#explorerCatalogTab', '/explorer/catalog'],
  ]) {
    await page.goto(from);
    await page.locator(link).click();
    await expect(page).toHaveURL(new RegExp(`${to.replace(/\//g, '\\/')}$`));
  }
});
