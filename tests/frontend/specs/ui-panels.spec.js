import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { mockTraceFacets, mockTraceResults, mockTraceServices } from '../helpers/traces.js';
import { settle, cameraIdle } from '../helpers/graph-kit.js';

// ns.detailPanel (app_ui_panel.js): one right panel for one entity, docked
// beside the content (Logs record, Spans, Services) or floating over a canvas
// (the graph-kit panel of the Explorer graph, the service map and the trace
// graph). One head (eyebrow, title, subtitle, actions, the .closeCross close
// button), --detail-w wide, Escape through ns.layers, a bottom sheet at
// --bp-md and below. A panel showing one entity writes one URL parameter:
// pushed when it opens, replaced when it moves, and Back closes it.

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

// The shell every detail panel shares.
async function expectShell(panel, { layout }) {
  await expect(panel).toHaveClass(new RegExp(`uiDetail--${layout}`));
  await expect(panel).toHaveAttribute('role', 'dialog');
  const head = panel.locator(':scope > .uiDetail__head');
  await expect(head).toHaveCount(1);
  await expect(head.locator('.uiDetail__title')).toBeVisible();
  await expect(head.locator(':scope > .closeCross.uiDetail__close')).toHaveCount(1);
  await expect(panel.locator('.closeCross')).toHaveCount(1);
}

// ------------------------------------------------------------------ Logs

const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function logsWindow(request, minutes = 30) {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
  const end = Number(meta.time_bounds.max_ms);
  return { from: fmt(end - minutes * 60000), to: fmt(end + 1000) };
}
const logRows = (page) => page.locator('#logsTableRows .logsRow[data-row-id]');

test.describe('detail panels', () => {
  test('Logs: the record panel is a docked shell; log= is pushed, replaced by another record, and Back closes it', async ({ page, request }) => {
    const win = await logsWindow(request);
    await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`);
    await expect(logRows(page).nth(2)).toBeVisible({ timeout: 30_000 });
    const panel = page.locator('#logsSidePanel');
    const first = await logRows(page).nth(0).getAttribute('data-row-id');
    const second = await logRows(page).nth(1).getAttribute('data-row-id');
    const before = await historyLength(page);
    await logRows(page).nth(0).click();
    await expect(panel).toBeVisible();
    await expectShell(panel, { layout: 'docked' });
    expect(param(page, 'log')).toBe(first);
    expect(await historyLength(page)).toBe(before + 1);
    // Width: --detail-w (min(600px, 45vw)).
    const width = (await panel.boundingBox()).width;
    const vw = page.viewportSize().width;
    expect(Math.round(width)).toBe(Math.round(Math.max(320, Math.min(600, vw * 0.45))));
    // Another record: the same entry, replaced.
    await logRows(page).nth(1).click();
    await expect.poll(() => param(page, 'log')).toBe(second);
    expect(await historyLength(page)).toBe(before + 1);
    // Back closes it.
    await page.goBack();
    await expect(panel).toBeHidden();
    expect(param(page, 'log')).toBe(null);
    // Forward reopens it on the record.
    await page.goForward();
    await expect(panel).toBeVisible();
    await expect(logRows(page).nth(1)).toHaveClass(/is-selected/);
    // Escape closes it and goes Back (the entry was the panel's own).
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect.poll(() => param(page, 'log')).toBe(null);
    // A link with log= opens the record once it is listed.
    await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}&log=${encodeURIComponent(second)}`);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`#logsTableRows .logsRow[data-row-id="${second}"]`)).toHaveClass(/is-selected/);
    // Closing a panel a link opened drops log= without leaving the page.
    await panel.locator('.uiDetail__close').click();
    await expect(panel).toBeHidden();
    expect(param(page, 'log')).toBe(null);
    await expect(page).toHaveURL(/\/observability\/logs\?/);
  });

  test('Services: the service detail is a docked shell beside the list', async ({ page }) => {
    await mockTraceServices(page);
    await mockTraceResults(page);
    await page.goto('/observability/traces?tab=services');
    // The fixture's services: the first row opens a docked detail.
    const row = page.locator('.traceSvcTable:not(.traceSvcTable--compact) tbody tr[data-svc-row]').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const panel = page.locator('#traceSvcDetail');
    await expect(panel).toBeVisible();
    await expectShell(panel, { layout: 'docked' });
    // Beside the list, not over it.
    const [list, side] = await Promise.all([page.locator('.traceSvc__main').boundingBox(), panel.boundingBox()]);
    expect(list.x + list.width).toBeLessThanOrEqual(side.x + 1);
    expect(param(page, 'svc')).toBe(await row.getAttribute('data-svc-row'));
    await page.goBack();
    await expect(panel).toBeHidden();
  });

  // ---------------------------------------------------------------- Map

  test('Map: the graph-kit panel is a floating shell; node= is pushed, replaced by another service, and Back closes it', async ({ page }) => {
    await mockTraceResults(page);
    await mockTraceFacets(page);
    await page.route('**/api/traces/service_map?**', (route) => route.fulfill({ json: {
      v: 1, source_host_id: 'local', range: [0, 3600_000], edge_rule: 'parent_child_cross_service', sampled: false, truncated: false,
      nodes: ['frontend', 'checkout', 'payment'].map((service, i) => ({ service, spans: 1000 * (i + 1), errors: i, error_rate: i / 1000, sampled_count: 10, p50_ns: 1e6, p95_ns: 2e6, p99_ns: 3e6 })),
      edges: [['frontend', 'checkout'], ['checkout', 'payment']].map(([source, target]) => ({ source, target, kind: 'sync', calls: 100, errors: 0, error_rate: 0, p50_ns: 1e6, p95_ns: 2e6, p99_ns: 3e6 })),
    } }));
    await page.goto('/observability/traces?tab=map');
    await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceMap?.inspect?.().nodes.length || 0)), { timeout: 30_000 }).toBe(3);
    await settle(page);
    const click = async (name) => {
      const found = (await page.evaluate(() => window.ChDash.traceMap.inspect())).nodes.find((node) => node.service === name);
      // A point of the card on screen (the camera may have moved it partly out).
      const x = Math.max(found.x + 12, Math.min(found.x + found.width / 2, found.x + found.width - 12));
      await page.mouse.click(Math.max(8, x), found.y + found.height / 2);
    };
    const panel = page.locator('#traceMapPanel');
    const before = await historyLength(page);
    await click('checkout');
    await expect(panel).toBeVisible();
    await expectShell(panel, { layout: 'floating' });
    await expect(panel.locator('.uiDetail__eyebrow')).toHaveText('Service');
    await expect.poll(() => param(page, 'node')).toBe('checkout');
    expect(await historyLength(page)).toBe(before + 1);
    await cameraIdle(page, 'ChDash.traceMap');
    // Another service (left of the panel): the same entry, replaced.
    await click('frontend');
    await expect(panel.locator('.uiDetail__title')).toHaveText('frontend');
    await expect.poll(() => param(page, 'node')).toBe('frontend');
    expect(await historyLength(page)).toBe(before + 1);
    await page.goBack();
    await expect(panel).toBeHidden();
    expect(param(page, 'node')).toBe(null);
    await page.goForward();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.uiDetail__title')).toHaveText('frontend');
    // Escape (focus in the panel) closes it through ns.layers; the focus goes
    // back to the canvas.
    await panel.locator('.uiDetail__close').focus();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#traceMapCanvas')).toBeFocused();
    await expect.poll(() => param(page, 'node')).toBe(null);
    // A link with node= opens the service's panel once the map is drawn.
    await page.goto('/observability/traces?tab=map&node=payment');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('.uiDetail__title')).toHaveText('payment');
  });
});

for (const theme of ['dark', 'light']) {
  test.describe(`detail panels at 390 px (${theme})`, () => {
    test.use({ colorScheme: theme, viewport: { width: 390, height: 844 } });

    test('a docked panel is a bottom sheet under the page chrome, its close button on top', async ({ page, request }) => {
      const win = await logsWindow(request);
      await page.goto(`/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}`);
      await expect(logRows(page).first()).toBeVisible({ timeout: 30_000 });
      await logRows(page).first().click();
      const panel = page.locator('#logsSidePanel');
      await expect(panel).toBeVisible();
      const sheet = await panel.boundingBox();
      const nav = await page.locator('#obsNav').boundingBox();
      expect(sheet.x).toBe(0);
      expect(Math.round(sheet.width)).toBe(390);
      expect(sheet.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
      expect(Math.round(sheet.y + sheet.height)).toBe(844);
      const close = await panel.locator('.uiDetail__close').boundingBox();
      expect(close.width).toBeGreaterThanOrEqual(32);
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.uiDetail__close'), [close.x + close.width / 2, close.y + close.height / 2])).toBe(true);
    });
  });
}

// ------------------------------------------------------------ side panels

// ns.sidePanel: the left list of a page. Each one: a head (title / toggle,
// meta, a 30 px search), a body scrolling on its own, --side-w (288 px) wide,
// a 32 px rail when folded on wide windows, a drawer with a toggle on phones.
const OBS_HOUR = 'from=2026-09-19%2012:30:00&to=2026-09-19%2013:30:00';
const SIDES = [
  { name: 'Explorer tree', url: '/explorer', panel: '#explorerListPane', collapse: '#explorerTreeCollapse', drawer: '#explorerTreeToggle', ready: '#explorerTableList > *' },
  { name: 'Explorer Functions', url: '/explorer/_functions', panel: '#explorerFunctionListPane', collapse: '#explorerFunctionCollapse', drawer: '#explorerTreeToggle', ready: '#explorerFunctionList > *' },
  { name: 'Traces Attributes', url: `/observability/traces?${OBS_HOUR}`, panel: '#traceFacets', collapse: '#traceFacetsToggle', drawer: '#traceFacetsDrawerToggle', ready: '#traceFacetsList > *' },
  { name: 'Logs Fields', url: `/observability/logs?${OBS_HOUR}`, panel: '#logsFacets', collapse: '#logsFacetsToggle', drawer: '#logsFacetsDrawerToggle', ready: '#logsFacetsList > *' },
  { name: 'Metrics catalog', url: `/observability/metrics?${OBS_HOUR}`, panel: '#metricsSidebar', collapse: '#metricsSidebarToggle', drawer: '#metricsSidebarDrawerToggle', ready: '#metricsCatalog > *' },
];

async function unfolded(page) {
  // The facets fold by default below 1100 px: start every panel open.
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('side-spec-reset')) return;
      sessionStorage.setItem('side-spec-reset', '1');
      for (const key of ['chdash.traceFacetsCollapsed.v1', 'chdash.logsFacetsCollapsed.v1', 'chdash.metricsCatalogCollapsed.v1', 'chdash.explorerTreeCollapsed.v1', 'chdash.explorerFunctionsCollapsed.v1']) localStorage.setItem(key, '0');
    } catch (_) {}
  });
}

test.describe('side panels', () => {
  for (const side of SIDES) {
    test(`${side.name}: the shell, --side-w wide, folds to a 32 px rail and back (remembered)`, async ({ page }) => {
      await unfolded(page);
      await page.goto(side.url);
      const panel = page.locator(side.panel);
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(side.ready).first()).toBeAttached({ timeout: 30_000 });
      await expect(panel).toHaveClass(/\buiSide\b/);
      const m = await panel.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const head = el.querySelector(':scope > .uiSide__head');
        const body = el.querySelector(':scope > .uiSide__body');
        const search = head?.querySelector('.uiSide__search');
        return {
          width: Math.round(r.width), x: Math.round(r.left), border: getComputedStyle(el).borderRightWidth, radius: getComputedStyle(el).borderTopLeftRadius,
          search: search ? Math.round(search.getBoundingClientRect().height) : 0,
          bodyScrolls: body ? ['auto', 'scroll'].includes(getComputedStyle(body).overflowY) : false,
          headCount: el.querySelectorAll(':scope > .uiSide__head').length,
        };
      });
      expect(m).toMatchObject({ width: 288, x: 0, border: '1px', radius: '0px', search: 30, bodyScrolls: true, headCount: 1 });
      const toggle = page.locator(side.collapse);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(32);
      await expect(panel.locator('.uiSide__search')).toBeHidden();
      await expect(toggle).toBeVisible();
      // Remembered across a reload.
      await page.reload();
      await expect(page.locator(side.collapse)).toHaveAttribute('aria-expanded', 'false');
      await expect.poll(async () => Math.round((await page.locator(side.panel).boundingBox()).width)).toBe(32);
      await page.locator(side.collapse).click();
      await expect.poll(async () => Math.round((await page.locator(side.panel).boundingBox()).width)).toBe(288);
    });
  }
});

for (const theme of ['dark', 'light']) {
  test.describe(`side panels at 390 px (${theme})`, () => {
    test.use({ colorScheme: theme, viewport: { width: 390, height: 844 } });

    for (const side of SIDES) {
      test(`${side.name}: a drawer under the page chrome; Escape and the scrim close it, the focus goes back to its toggle`, async ({ page }) => {
        await unfolded(page);
        await page.goto(side.url);
        const panel = page.locator(side.panel);
        const toggle = page.locator(side.drawer);
        await expect(toggle).toBeVisible({ timeout: 20_000 });
        // The Explorer opens its tree when nothing is selected: start closed.
        await page.waitForLoadState('networkidle');
        if ((await toggle.getAttribute('aria-expanded')) === 'true') {
          await page.keyboard.press('Escape');
          await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        }
        await expect(panel).toBeHidden();
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(panel).toBeVisible();
        await expect.poll(async () => Math.round((await panel.boundingBox()).x)).toBe(0);
        const box = await panel.boundingBox();
        expect(box.width).toBeLessThanOrEqual(390 * 0.86 + 1);
        expect(Math.round(box.y + box.height)).toBe(844);
        const top = await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue('--shell-top')) || 0);
        expect(box.y).toBeGreaterThanOrEqual(top - 1);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(toggle).toBeFocused();
        await toggle.click();
        await expect(panel).toBeVisible();
        await page.mouse.click(380, 700);
        await expect(panel).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }
  });
}
