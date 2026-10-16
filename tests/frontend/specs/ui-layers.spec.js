import { test, expect } from '@playwright/test';
import { IS_RUN, installObservers } from '../helpers/observability.js';
import { installLeakTracker, leakStats, leakDiff, leakSummary } from '../helpers/leaks.js';
import { SYNTHETIC_TRACES, mockTraceResults } from '../helpers/traces.js';

// ns.layers (app_ui_layers.js): one stack of open layers (menus, popovers,
// panels, sheets, dialogs). Escape closes the top layer only. One capture
// listener closes a layer on a press outside. The focus goes back to the opener.
// ns.lifecycle.scope(): what a view binds (listeners, observers, timers,
// channels) belongs to its page. Each Observability view is a page of its own
// (the row of tabs is made of links). A leak can only build up inside one page.
// The cycles below run in one page, many times. The tracker (helpers/leaks.js,
// tested by leak-tracker.spec.js) must read the same after the last cycle as
// after the second.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => {
  observers.set(page, installObservers(page));
  await installLeakTracker(page);
});
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const VIEWS = ['traces', 'logs', 'metrics'];
// Two hours of the rich fixture day: every view has data. A cycle moves the range from one to the other.
const HOURS = [['2026-09-12 12:30:00', '2026-09-12 13:30:00'], ['2026-09-12 12:00:00', '2026-09-12 13:00:00']];
const HOUR = `?from=${encodeURIComponent(HOURS[0][0])}&to=${encodeURIComponent(HOURS[0][1])}`;
const BAR = { traces: '#tracesForm', logs: '#logsForm', metrics: '#metricsToolbar' };
const WORKSPACE = { traces: '#tracesWorkspace', logs: '#logsWorkspace', metrics: '#metricsWorkspace' };
const CYCLES = 12;
const SWITCHES = 30;

// Every request that the page sent has completed. Two frames have rendered
// what the requests brought. A view adds its listeners as it renders.
function trackRequests(page) {
  const pending = new Set();
  // The hosts status stream (an EventSource) stays open for the life of the page.
  page.on('request', (request) => { if (request.resourceType() !== 'eventsource') pending.add(request); });
  for (const event of ['requestfinished', 'requestfailed']) page.on(event, (request) => pending.delete(request));
  return async () => {
    await expect.poll(() => pending.size, { timeout: 30_000 }).toBe(0);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
}

// A view is idle when its search has answered. Nothing in the view is busy any more.
async function viewIdle(page, view, answered) {
  if (answered) await answered;
  await expect(page.locator(`${BAR[view]} .obsFilterBar__submit`)).not.toHaveClass(/is-loading/);
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, { timeout: 30_000 });
}

async function obsFeatures(request) {
  const version = await (await request.get('/api/version')).json();
  test.skip(!VIEWS.every((view) => version.features?.[view]?.enabled === true), 'needs traces, logs and metrics enabled');
}

async function openView(page, view) {
  const run = page.waitForResponse((response) => IS_RUN[view](response.url()), { timeout: 30_000 });
  await page.goto(`/observability/${view}${HOUR}`);
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', view);
  await viewIdle(page, view, run);
}

// Wait for the answer of the view's search, if one comes. A range or a search that the view answers from its own cache sends
// nothing. The wait is short, and its end is not a failure. The cycle needs the view to be idle.
const answer = (page, view) => page.waitForResponse((response) => IS_RUN[view](response.url()), { timeout: 4_000 }).catch(() => null);

// Run the view's search again. Wait until the view is idle.
async function search(page, view) {
  const run = answer(page, view);
  await page.locator(`${BAR[view]} .obsFilterBar__submit`).click();
  await viewIdle(page, view, run);
}

// Open the range panel, type the range, and apply it. Wait until the view is idle.
async function setRange(page, view, [from, to]) {
  await page.locator(`${WORKSPACE[view]} .tracePicker--range > .tracePicker__button`).click();
  await page.locator(`#${view}RangeStart`).fill(from);
  await page.locator(`#${view}RangeEnd`).fill(to);
  const run = answer(page, view);
  await page.locator(`#${view}CustomRangeApply`).click();
  await viewIdle(page, view, run);
}

// Everything the cycle builds exists after two rounds. CYCLES more cycles must add nothing.
async function expectNoLeak(page, testInfo, cycle) {
  // 14 rounds of a few requests each, on the 22 k spans of the rich fixture hour.
  test.setTimeout(240_000);
  for (let round = 0; round < 2; round += 1) await cycle(round);
  const before = await leakStats(page, true);
  for (let i = 0; i < CYCLES; i += 1) await cycle(i);
  const after = await leakStats(page, true);
  console.log(`${testInfo.title}: before ${leakSummary(before)}; after ${CYCLES} cycles ${leakSummary(after)}`);
  testInfo.annotations.push({ type: 'leaks', description: JSON.stringify({ before, after }) });
  expect(leakDiff(before, after)).toEqual({});
  expect(after.global).toBeLessThanOrEqual(before.global);
  expect(after.connected).toBeLessThanOrEqual(before.connected);
}

test.describe('what a view binds is released: cycles inside one page', () => {
  test(`Traces: ${CYCLES} rounds of searching, changing the range and switching the result view leave no listener, observer or timer`, async ({ page, request }, testInfo) => {
    await obsFeatures(request);
    await openView(page, 'traces');
    const results = (kind) => page.locator(`[data-results-view="${kind}"]`);
    await expectNoLeak(page, testInfo, async (round) => {
      await search(page, 'traces');
      await setRange(page, 'traces', HOURS[(round + 1) % HOURS.length]);
      await results(round % 2 ? 'list' : 'table').click();
    });
  });

  test(`Logs: ${CYCLES} rounds of searching, changing the range, opening the record panel and the column picker leave none`, async ({ page, request }, testInfo) => {
    await obsFeatures(request);
    await openView(page, 'logs');
    const rows = page.locator('#logsTableRows .logsRow[data-row-id]');
    const panel = page.locator('#logsSidePanel');
    await expectNoLeak(page, testInfo, async (round) => {
      await search(page, 'logs');
      await setRange(page, 'logs', HOURS[(round + 1) % HOURS.length]);
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      await rows.first().click();
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      // Close goes Back, because log= was the panel's own entry.
      await expect.poll(() => new URL(page.url()).searchParams.get('log')).toBe(null);
      await page.locator('#logsColumnsButton').click();
      await expect(page.locator('#logsColumnsMenu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#logsColumnsMenu')).toBeHidden();
    });
    expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(0);
  });

  test(`Metrics: ${CYCLES} rounds of searching and changing the range leave none`, async ({ page, request }, testInfo) => {
    await obsFeatures(request);
    await openView(page, 'metrics');
    await expectNoLeak(page, testInfo, async (round) => {
      await search(page, 'metrics');
      await setRange(page, 'metrics', HOURS[(round + 1) % HOURS.length]);
    });
  });

  test(`Trace page: ${CYCLES} rounds of opening and closing the span inspector of two spans leave none`, async ({ page }, testInfo) => {
    await mockTraceResults(page);
    await page.goto(`/observability/traces/${SYNTHETIC_TRACES[0].trace_id}`);
    const rows = page.locator('#traceWaterfall .traceSpanRow');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const inspector = page.locator('#traceWaterfall .traceSpanInspectorRow');
    await expectNoLeak(page, testInfo, async (round) => {
      const row = rows.nth(round % 2);
      await row.click();
      await expect(inspector).toBeVisible({ timeout: 10_000 });
      // A second click on the open span closes its inspector.
      await row.click();
      await expect(inspector).toHaveCount(0);
    });
  });

  test(`Explorer: switching modes and card tabs ${SWITCHES} times keeps the counts flat`, async ({ page }, testInfo) => {
    const settle = trackRequests(page);
    await page.goto('/explorer/catalog/chdash_ui/weather_observations/columns');
    await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
    await settle();
    const steps = [
      () => page.locator('#explorerModeGraph').click(),
      () => page.locator('#explorerModeBrowse').click(),
      () => page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click(),
      () => page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Columns' }).click(),
    ];
    // Run two rounds of the four steps first. Every mode must load and render its content.
    for (let round = 0; round < 2; round += 1) for (const step of steps) { await step(); await settle(); }
    const before = await leakStats(page, true);
    for (let i = 0; i < SWITCHES; i += 1) { await steps[i % steps.length](); await settle(); }
    const after = await leakStats(page, true);
    console.log(`explorer: before ${leakSummary(before)}; after ${SWITCHES} switches ${leakSummary(after)}`);
    testInfo.annotations.push({ type: 'leaks', description: JSON.stringify({ before, after }) });
    expect(leakDiff(before, after)).toEqual({});
    expect(after.global).toBeLessThanOrEqual(before.global);
    expect(after.connected).toBeLessThanOrEqual(before.connected);
  });
});

// A scratch stack on a real page. It has layers, and each layer has an opener button.
async function scratchLayers(page, specs) {
  await page.evaluate((list) => {
    window.__dismissed = [];
    window.__handles = {};
    for (const spec of list) {
      const opener = document.createElement('button');
      opener.id = `${spec.name}Opener`;
      opener.textContent = spec.name;
      opener.style.cssText = `position:fixed;left:${spec.x}px;top:8px;z-index:2000`;
      const el = document.createElement('div');
      el.id = `${spec.name}Layer`;
      el.style.cssText = `position:fixed;left:${spec.x}px;top:60px;width:160px;height:80px;background:Canvas;z-index:2000`;
      el.innerHTML = `<button id="${spec.name}First">a</button><input id="${spec.name}Field"><button id="${spec.name}Last">b</button>`;
      document.body.append(opener, el);
      opener.focus();
      window.__handles[spec.name] = window.ChDash.layers.push({
        el,
        name: spec.name,
        modal: !!spec.modal,
        docked: !!spec.docked,
        trapFocus: !!spec.trapFocus,
        onDismiss: (reason) => { window.__dismissed.push(`${spec.name}:${reason}`); el.remove(); },
      });
      el.querySelector('button').focus();
    }
  }, specs);
}

const dismissed = (page) => page.evaluate(() => window.__dismissed);

test.describe('ns.layers', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/explorer/catalog');
    await page.waitForFunction(() => window.ChDash?.layers && window.ChDash?.lifecycle && window.ChDash?.explorer);
  });

  test('Escape closes the top layer only and the focus goes back to its opener', async ({ page }) => {
    await scratchLayers(page, [{ name: 'panel', x: 10, docked: true }, { name: 'popover', x: 200 }, { name: 'menu', x: 400 }]);
    expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(3);
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual(['menu:escape']);
    await expect(page.locator('#menuOpener')).toBeFocused();
    // The focus left the popover. It is on the menu's opener.
    // Close the popover. It does not take the focus back.
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual(['menu:escape', 'popover:escape']);
    await expect(page.locator('#menuOpener')).toBeFocused();
    await page.locator('#panelLast').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('#panelOpener')).toBeFocused();
    expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(0);
  });

  test('a press outside dismisses the floating layers down to the one it lands in; docked panels stay', async ({ page }) => {
    await scratchLayers(page, [{ name: 'panel', x: 10, docked: true }, { name: 'popover', x: 200 }, { name: 'menu', x: 400 }]);
    // Inside the popover, only the menu above it closes.
    await page.mouse.click(300, 130);
    expect(await dismissed(page)).toEqual(['menu:outside']);
    // On the page, the popover closes. The docked panel stays open.
    await page.mouse.click(900, 600);
    expect(await dismissed(page)).toEqual(['menu:outside', 'popover:outside']);
    await expect(page.locator('#panelLayer')).toBeVisible();
  });

  test('the opener of a layer is not outside it: its own click toggles', async ({ page }) => {
    await scratchLayers(page, [{ name: 'popover', x: 200 }]);
    await page.locator('#popoverOpener').click();
    expect(await dismissed(page)).toEqual([]);
  });

  test('a modal layer stops presses and Escape from reaching the layers under it; trapFocus keeps Tab inside', async ({ page }) => {
    await scratchLayers(page, [{ name: 'popover', x: 10 }, { name: 'sheet', x: 300, modal: true, trapFocus: true }]);
    await page.mouse.click(900, 600);
    expect(await dismissed(page)).toEqual([]);
    await expect(page.locator('#sheetFirst')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#sheetField')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#sheetLast')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#sheetFirst')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#sheetLast')).toBeFocused();
    // Escape typed in a field inside the top layer closes it.
    await page.locator('#sheetField').focus();
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual(['sheet:escape']);
    await expect(page.locator('#sheetOpener')).toBeFocused();
  });

  test('Escape in a page field outside the layers stays the field\'s; a key a handler consumed is not seen', async ({ page }) => {
    await scratchLayers(page, [{ name: 'popover', x: 10 }]);
    await page.locator('#explorerSearchInput').focus();
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual([]);
    await page.evaluate(() => {
      document.getElementById('popoverFirst').addEventListener('keydown', (event) => { if (event.key === 'Escape') event.preventDefault(); });
    });
    await page.locator('#popoverFirst').focus();
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual([]);
    await page.locator('#popoverLast').focus();
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual(['popover:escape']);
  });

  test('an entry may name its elements with a function (ns.menu): each counts as inside; release() keeps the focus', async ({ page }) => {
    const out = await page.evaluate(() => {
      const a = document.createElement('div');
      const b = document.createElement('button');
      a.style.cssText = 'position:fixed;left:10px;top:200px;width:80px;height:40px';
      b.style.cssText = 'position:fixed;left:300px;top:200px;width:80px;height:40px';
      document.body.append(a, b);
      const log = [];
      const handle = window.ChDash.layers.push({ el: () => [a, b], onDismiss: (reason) => log.push(reason) });
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const afterInside = log.length;
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      const second = window.ChDash.layers.push({ el: [a], onDismiss: () => {} });
      second.release();
      return { afterInside, log, size: window.ChDash.layers.size(), open: handle.isOpen() };
    });
    expect(out).toEqual({ afterInside: 0, log: ['outside'], size: 0, open: false });
  });

  test('closing a layer closes the layers opened from it; a scope removes its listeners', async ({ page }) => {
    const out = await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.innerHTML = '<button id="inner">open</button>';
      document.body.appendChild(panel);
      const child = document.createElement('div');
      child.textContent = 'popover';
      document.body.appendChild(child);
      const log = [];
      const parent = window.ChDash.layers.push({ el: panel, docked: true, onDismiss: (r) => log.push(`panel:${r}`) });
      document.getElementById('inner').focus();
      window.ChDash.layers.push({ el: child, onDismiss: (r) => log.push(`child:${r}`) });
      parent.close();
      const scope = window.ChDash.lifecycle.scope();
      let hits = 0;
      scope.listen(document, 'chdash:test', () => { hits += 1; });
      const nested = scope.child();
      nested.listen(window, 'chdash:test2', () => { hits += 10; });
      document.dispatchEvent(new Event('chdash:test'));
      window.dispatchEvent(new Event('chdash:test2'));
      scope.dispose();
      document.dispatchEvent(new Event('chdash:test'));
      window.dispatchEvent(new Event('chdash:test2'));
      const view = window.ChDash.lifecycle.enter('scratch');
      const again = window.ChDash.lifecycle.enter('scratch');
      window.ChDash.lifecycle.leave('scratch');
      return { log, size: window.ChDash.layers.size(), hits, nestedAborted: nested.signal.aborted, firstAborted: view.signal.aborted, secondAborted: again.signal.aborted };
    });
    expect(out).toEqual({ log: ['child:parent'], size: 0, hits: 11, nestedAborted: true, firstAborted: true, secondAborted: true });
  });
});

test('ns.dialog is a modal layer: Escape closes it and the focus goes back to its opener', async ({ page }) => {
  await page.goto('/query');
  await page.waitForFunction(() => window.ChDash?.dialog && window.ChDash?.layers);
  const button = page.locator('#queryLibraryButton');
  await button.click();
  await expect(page.locator('#queryLibraryMenu')).toBeVisible();
  expect(await page.evaluate(() => {
    const top = window.ChDash.layers.top();
    return { size: window.ChDash.layers.size(), top: top?.el?.id };
  })).toEqual({ size: 1, top: 'queryLibraryMenu' });
  // A press outside a modal dialog, on its backdrop, belongs to the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator('#queryLibraryMenu')).toBeHidden();
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(0);
});
