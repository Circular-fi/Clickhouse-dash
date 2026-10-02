import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { installListenerTracker, listenerStats, listenerDiff } from '../helpers/listeners.js';

// ns.layers (app_ui_layers.js): one stack of open layers (menus, popovers,
// panels, sheets, dialogs). Escape closes the top one only, one capture
// listener closes on a press outside, the focus goes back to the opener.
// ns.lifecycle.scope(): the listeners a view binds while shown are removed
// when it is hidden, so switching views never adds listeners.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => {
  observers.set(page, installObservers(page));
  await installListenerTracker(page);
});
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const VIEWS = ['traces', 'logs', 'metrics'];
const HOUR = '?from=2026-09-19%2012:30:00&to=2026-09-19%2013:30:00';
const SWITCHES = 30;

async function obsFeatures(request) {
  const version = await (await request.get('/api/version')).json();
  test.skip(!VIEWS.every((view) => version.features?.[view]?.enabled === true), 'needs traces, logs and metrics enabled');
}

async function showView(page, view) {
  await page.locator(`#obsTabs [data-obs-tab="${view}"]`).click();
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', view);
  await page.waitForLoadState('networkidle');
}

test.describe('listener lifecycle', () => {
  test(`switching Observability views ${SWITCHES} times keeps the listener count flat`, async ({ page, request }, testInfo) => {
    await obsFeatures(request);
    await page.goto(`/observability/traces${HOUR}`);
    await expect(page.locator('html')).toHaveAttribute('data-obs-view', 'traces');
    await page.waitForLoadState('networkidle');
    // One round first: every view has run init() and shown once.
    for (const view of ['logs', 'metrics', 'traces']) await showView(page, view);
    const before = await listenerStats(page, true);
    for (let i = 0; i < SWITCHES; i += 1) await showView(page, VIEWS[(i + 1) % VIEWS.length]);
    // The last switch lands back on traces, the view measured before.
    if ((await page.locator('html').getAttribute('data-obs-view')) !== 'traces') await showView(page, 'traces');
    const after = await listenerStats(page, true);
    testInfo.annotations.push({ type: 'listeners', description: JSON.stringify({ before: { global: before.global, connected: before.connected }, after: { global: after.global, connected: after.connected } }) });
    console.log(`observability listeners: before ${before.global} global / ${before.connected} connected, after ${SWITCHES} switches ${after.global} / ${after.connected}`);
    expect(listenerDiff(before, after)).toEqual({});
    expect(after.types).toEqual(before.types);
    expect(after.global).toBe(before.global);
    expect(after.connected).toBe(before.connected);
  });

  test(`switching Explorer modes and tabs ${SWITCHES} times keeps the listener count flat`, async ({ page }, testInfo) => {
    await page.goto('/explorer/chdash_ui/weather_observations/columns');
    await expect(page.locator('#explorerDetailName')).toContainText('weather_observations', { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    const steps = [
      () => page.locator('#explorerModeGraph').click(),
      () => page.locator('#explorerModeStorage').click(),
      () => page.locator('#explorerModeBrowse').click(),
      () => page.locator('#explorerFunctionsTab').click(),
      () => page.locator('#explorerCatalogTab').click(),
    ];
    const settle = async () => { await page.waitForLoadState('networkidle'); await page.waitForTimeout(50); };
    // Two rounds first: every mode has loaded and rendered its content.
    for (let round = 0; round < 2; round += 1) for (const step of steps) { await step(); await settle(); }
    const before = await listenerStats(page, true);
    for (let i = 0; i < SWITCHES; i += 1) { await steps[i % steps.length](); await settle(); }
    const after = await listenerStats(page, true);
    console.log(`explorer listeners: before ${before.global} global / ${before.connected} connected, after ${SWITCHES} switches ${after.global} / ${after.connected}`);
    testInfo.annotations.push({ type: 'listeners', description: JSON.stringify({ before: { global: before.global, connected: before.connected }, after: { global: after.global, connected: after.connected } }) });
    expect(listenerDiff(before, after)).toEqual({});
    expect(after.types).toEqual(before.types);
    expect(after.global).toBe(before.global);
    expect(after.connected).toBe(before.connected);
  });
});

test.describe('listener lifecycle of views and layers', () => {
  test('a view\'s global listeners live while it shows; opening and closing panels and pickers 30 times adds none', async ({ page, request }, testInfo) => {
    await obsFeatures(request);
    await page.goto(`/observability/traces${HOUR}`);
    await expect(page.locator('html')).toHaveAttribute('data-obs-view', 'traces');
    await page.waitForLoadState('networkidle');
    for (const view of ['logs', 'traces']) await showView(page, view);
    const onTraces = await listenerStats(page);
    await showView(page, 'logs');
    await expect(page.locator('#logsTableRows .logsRow[data-row-id]').first()).toBeVisible({ timeout: 30_000 });
    const onLogs = await listenerStats(page);
    // The Traces keys (trace page shortcuts, the span panel's arrows, the
    // value menu's triggers) are bound while Traces shows only.
    expect(onLogs.types['document:keydown'] || 0).toBeLessThan(onTraces.types['document:keydown'] || 0);
    const rows = page.locator('#logsTableRows .logsRow[data-row-id]');
    const panel = page.locator('#logsSidePanel');
    const picker = page.locator('#logsColumnsButton');
    // One round first (the panel and the picker built), then 30.
    const cycle = async () => {
      await rows.first().click();
      await expect(panel).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      // Closing went Back (log= was the panel's own entry).
      await expect.poll(() => new URL(page.url()).searchParams.get('log')).toBe(null);
      await picker.click();
      await expect(page.locator('#logsColumnsMenu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('#logsColumnsMenu')).toBeHidden();
    };
    await cycle();
    const before = await listenerStats(page, true);
    for (let i = 0; i < SWITCHES; i += 1) await cycle();
    const after = await listenerStats(page, true);
    console.log(`document keydown listeners: ${onTraces.types['document:keydown'] || 0} on Traces, ${onLogs.types['document:keydown'] || 0} on Logs; logs panel + picker x${SWITCHES}: ${before.global} / ${before.connected} -> ${after.global} / ${after.connected}`);
    testInfo.annotations.push({ type: 'listeners', description: JSON.stringify({ traces: onTraces.types, logs: onLogs.types, before: before.global, after: after.global }) });
    expect(listenerDiff(before, after)).toEqual({});
    expect(after.global).toBe(before.global);
    expect(after.connected).toBe(before.connected);
    expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(0);
  });
});

// A scratch stack on a real page: layers, each with an opener button.
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
    await page.goto('/explorer');
    await page.waitForFunction(() => window.ChDash?.layers && window.ChDash?.lifecycle && window.ChDash?.explorer);
  });

  test('Escape closes the top layer only and the focus goes back to its opener', async ({ page }) => {
    await scratchLayers(page, [{ name: 'panel', x: 10, docked: true }, { name: 'popover', x: 200 }, { name: 'menu', x: 400 }]);
    expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(3);
    await page.keyboard.press('Escape');
    expect(await dismissed(page)).toEqual(['menu:escape']);
    await expect(page.locator('#menuOpener')).toBeFocused();
    // The focus left the popover (it is on the menu's opener): closing the
    // popover does not take it back.
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
    // Inside the popover: only the menu above it goes.
    await page.mouse.click(300, 130);
    expect(await dismissed(page)).toEqual(['menu:outside']);
    // On the page: the popover goes, the docked panel stays.
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
  // A press outside a modal dialog (on its backdrop) is the dialog's own.
  await page.keyboard.press('Escape');
  await expect(page.locator('#queryLibraryMenu')).toBeHidden();
  await expect(button).toBeFocused();
  expect(await page.evaluate(() => window.ChDash.layers.size())).toBe(0);
});
