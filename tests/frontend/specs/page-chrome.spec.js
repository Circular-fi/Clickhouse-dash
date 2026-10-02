import { test, expect } from '@playwright/test';
import { expandExplorerDatabase } from '../helpers/app.js';

// The page shell (style.css "Page shell" block): one full-bleed chrome for
// Query, Explorer and Observability. Header, then the page's nav row (46 px,
// --nav-row-h), then the regions edge to edge on a flat background, split by
// 1 px borders and inset by the 12 px gutter (10 px at --bp-md and below).
// The document never scrolls: each page's content region is its scroller.
// Desktop blocks run on every project (1920 / 1440 / 1280) in both themes;
// the phone block pins 390 x 844.

// shells: the page wrapper and the frame boxes in it, each edge to edge.
const PAGES = {
  query: { path: '/query', ready: '#runButton', nav: null, shells: ['#queryWorkspace', '.panel--query', '.panel--metrics', '#resultsPanel'] },
  explorer: { path: '/explorer/chdash_ui/weather_observations/columns', ready: '#explorerDetailName', nav: '#explorerTopBar', shells: ['#explorerWorkspace', '.explorerShell', '.explorerGrid:not([hidden])', '#explorerCatalogMain'] },
  traces: { path: '/observability/traces', ready: '#tracesForm', nav: '#obsNav', shells: ['#tracesWorkspace', '#tracesWorkspace > .tracesShell'] },
  logs: { path: '/observability/logs', ready: '#logsForm', nav: '#obsNav', shells: ['#logsWorkspace', '#logsWorkspace > .tracesShell'] },
  metrics: { path: '/observability/metrics', ready: '#metricsToolbar', nav: '#obsNav', shells: ['#metricsWorkspace'] },
};

async function open(page, name) {
  const spec = PAGES[name];
  await page.goto(spec.path);
  await expect(page.locator(spec.ready)).toBeVisible({ timeout: 15_000 });
  if (name === 'explorer') await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Geometry and style of the chrome, in one pass.
function chrome({ nav: navSelector, shells: shellSelectors }) {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right };
  };
  const css = (el) => (el ? getComputedStyle(el) : null);
  const probe = (value) => {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;visibility:hidden;color:${value};background:${value}`;
    document.body.appendChild(el);
    const out = getComputedStyle(el).color;
    el.remove();
    return out;
  };
  const header = document.querySelector('body > .appHeader');
  const nav = navSelector ? document.querySelector(navSelector) : null;
  const main = document.querySelector('main[role="main"]:not([hidden])');
  // Scroll containers above the chrome: none, so the chrome never scrolls away.
  const scrollingAncestor = (el) => {
    for (let node = el?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.id || node.className;
    }
    return null;
  };
  // The page frame: none of its boxes is a rounded, shadowed or inset card.
  const vw = window.innerWidth;
  const shells = shellSelectors.map((selector) => document.querySelector(selector))
    .filter((el) => el && el.getClientRects().length)
    .map((el) => {
      const s = getComputedStyle(el);
      return { el: el.id || String(el.className).split(' ')[0], radius: parseFloat(s.borderTopLeftRadius) || 0, shadow: s.boxShadow, margin: s.margin };
    });
  // The frame boxes, laid side by side or stacked, cover the width edge to edge.
  const frameRight = Math.max(...shellSelectors.map((selector) => document.querySelector(selector))
    .filter((el) => el && el.getClientRects().length).map((el) => el.getBoundingClientRect().right));
  const se = document.scrollingElement;
  return {
    vw,
    header: box(header),
    headerPad: parseFloat(css(header).paddingLeft),
    headerBorder: [css(header).borderBottomWidth, css(header).borderBottomColor],
    nav: box(nav),
    navPad: nav ? parseFloat(css(nav).paddingLeft) : null,
    navStyle: nav ? [css(nav).borderBottomWidth, css(nav).borderBottomColor, css(nav).backgroundColor] : null,
    tokens: { border: probe('var(--border)'), panel: probe('var(--panelBg)'), bg: probe('var(--bg)') },
    bodyBg: [css(document.body).backgroundImage, css(document.body).backgroundColor],
    main: box(main),
    shells,
    frameRight,
    chromeScroller: [scrollingAncestor(header), scrollingAncestor(nav)],
    doc: { overflowY: css(document.documentElement).overflowY, bodyOverflowY: css(document.body).overflowY, sh: se.scrollHeight, ch: se.clientHeight, sw: document.documentElement.scrollWidth },
    shellTop: document.documentElement.style.getPropertyValue('--shell-top'),
  };
}

async function measure(page, name) {
  return page.evaluate(chrome, { nav: PAGES[name].nav, shells: PAGES[name].shells });
}

function expectFrame(m, name, gutter) {
  // Full bleed: the page wrapper spans the viewport from x = 0, right under
  // the header (#explorerTopBar is its first row; #obsNav sits before it).
  expect(m.main.x, name).toBe(0);
  expect(Math.round(m.main.w), name).toBe(m.vw);
  const chromeBottom = m.nav ? m.nav.bottom : m.header.bottom;
  expect(Math.abs(m.main.y - (name.startsWith('explorer') ? m.header.bottom : chromeBottom)), name).toBeLessThanOrEqual(0.5);
  expect(Math.round(m.frameRight), name).toBe(m.vw);
  expect(m.shells.length, name).toBeGreaterThan(0);
  for (const shell of m.shells) {
    expect(shell.radius, `${name}: ${shell.el} radius`).toBe(0);
    expect(shell.shadow, `${name}: ${shell.el} shadow`).toBe('none');
    expect(shell.margin, `${name}: ${shell.el} margin`).toBe('0px');
  }
  // The header and the nav row: the same inset, separator and surface.
  expect(m.headerPad, name).toBe(gutter);
  expect(m.headerBorder, name).toEqual(['1px', m.tokens.border]);
  if (m.nav) {
    expect(Math.round(m.nav.h), `${name} nav row height`).toBe(46);
    expect(Math.abs(m.nav.y - m.header.bottom), name).toBeLessThanOrEqual(0.5);
    expect(m.navPad, name).toBe(gutter);
    expect(m.navStyle, name).toEqual(['1px', m.tokens.border, m.tokens.panel]);
  }
  // Flat page background; the document never scrolls, the chrome is outside every scroller.
  expect(m.bodyBg, name).toEqual(['none', m.tokens.bg]);
  expect(m.doc.overflowY, name).toBe('hidden');
  expect(m.doc.bodyOverflowY, name).toBe('hidden');
  expect(m.doc.sh, name).toBeLessThanOrEqual(m.doc.ch);
  expect(m.chromeScroller, name).toEqual([null, null]);
  // No horizontal overflow.
  expect(m.doc.sw, name).toBeLessThanOrEqual(m.vw);
  // --shell-top: the bottom of the header and the nav row (app_dom.js).
  expect(m.shellTop, name).toBe(`${Math.round(chromeBottom)}px`);
}

for (const theme of ['dark', 'light']) {
  test.describe(`page chrome (${theme})`, () => {
    test.use({ colorScheme: theme });

    test('every page is full bleed under one header and one 46 px nav row', async ({ page }) => {
      const headers = {};
      for (const name of Object.keys(PAGES)) {
        await open(page, name);
        const m = await measure(page, name);
        expectFrame(m, name, 12);
        headers[name] = Math.round(m.header.h);
      }
      // The same header on every page.
      expect(new Set(Object.values(headers)).size, JSON.stringify(headers)).toBe(1);
    });

    test('Query: editor, metric rail and results are full-bleed regions, the workspace is the one scroller', async ({ page }) => {
      await open(page, 'query');
      await page.locator('#queryTextArea').fill('SELECT number, toString(number) AS s FROM numbers(300)');
      await page.locator('#runButton').click();
      await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached/i, { timeout: 20_000 });
      await expect(page.locator('#resultsPanel')).toBeVisible();
      await expect.poll(() => page.locator('#queryWorkspace').evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
      const m = await page.evaluate(() => {
        const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
        const s = (sel) => getComputedStyle(document.querySelector(sel));
        const ws = document.getElementById('queryWorkspace');
        return {
          vw: window.innerWidth,
          editor: box('.panel--query'), rail: box('.panel--metrics'), results: box('#resultsPanel'),
          editorWrap: box('.editorWrap'), toolbar: box('.panel--query .panel_bottom'), status: box('.panel--query .statusPill'),
          header: box('#resultsPanel > .panel__header'), title: box('#resultsPanel .panel__title'), table: box('#resultsPanel > .tableWrap'),
          editorBorders: [s('.panel--query').borderRightWidth, s('.panel--query').borderBottomWidth],
          railBorder: s('.panel--metrics').borderBottomWidth,
          headerBorder: s('#resultsPanel > .panel__header').borderBottomWidth,
          tableBorder: [s('#resultsPanel > .tableWrap').borderTopWidth, s('#resultsPanel > .tableWrap').borderTopLeftRadius],
          panelBg: [s('.panel--query').backgroundColor, s('.panel--metrics').backgroundColor, s('#resultsPanel').backgroundColor],
          scroll: { sh: ws.scrollHeight, ch: ws.clientHeight, overflowY: getComputedStyle(ws).overflowY },
        };
      });
      // Regions edge to edge, split by 1 px borders.
      expect(m.editor.x).toBe(0);
      expect(m.results.x).toBe(0);
      expect(m.editorBorders).toEqual(['1px', '1px']);
      expect(m.railBorder).toBe('1px');
      expect(Math.abs(m.rail.x - m.editor.right)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(m.results.y - m.editor.bottom)).toBeLessThanOrEqual(0.5);
      expect(new Set(m.panelBg).size).toBe(1);
      // The gutter: the editor, its toolbar and the results header start 12 px in.
      expect(m.editorWrap.x).toBe(12);
      expect(m.status.x).toBe(12);
      expect(m.title.x).toBe(12);
      // The results header row lines up with the editor toolbar: same inset,
      // a nav-row height, a separator, then the table edge to edge.
      expect(Math.round(m.header.h)).toBe(46);
      expect(m.headerBorder).toBe('1px');
      expect(m.table.x).toBe(0);
      expect(m.tableBorder).toEqual(['0px', '0px']);
      // One scroller: the workspace, under a header that stays put.
      expect(m.scroll.overflowY).toBe('auto');
      expect(m.scroll.sh).toBeGreaterThan(m.scroll.ch);
      const before = await page.locator('body > .appHeader').boundingBox();
      await page.locator('#queryWorkspace').evaluate((el) => { el.scrollTop = 600; });
      expect(await page.locator('#queryWorkspace').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.locator('body > .appHeader').boundingBox()).toEqual(before);
      expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
      // The editor / results split still resizes.
      const wrap = page.locator('.editorWrap');
      await page.locator('#queryWorkspace').evaluate((el) => { el.scrollTop = 0; });
      const initial = await wrap.boundingBox();
      const grip = await page.locator('.editorResizeHandle').boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 60, { steps: 4 });
      await page.mouse.up();
      expect((await wrap.boundingBox()).height).toBeGreaterThanOrEqual(initial.height + 40);
    });

    test('Explorer: tree and content run edge to edge with one separator, both nav rows share the tokens', async ({ page }) => {
      await open(page, 'explorer');
      const m = await page.evaluate(() => {
        const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
        const s = (sel) => getComputedStyle(document.querySelector(sel));
        return {
          vw: window.innerWidth, vh: window.innerHeight,
          shell: box('.explorerShell'), tree: box('#explorerListPane'), main: box('#explorerCatalogMain'),
          top: box('#explorerTopBar'), modeBar: box('#explorerModeBar'), tabs: box('#explorerViewTabs'), modeTabs: box('#explorerModeTabs'),
          detailPad: s('#explorerDetailPane').paddingLeft,
          treeBorder: s('#explorerListPane').borderRightWidth,
          shellStyle: [s('.explorerShell').borderTopWidth, s('.explorerShell').borderTopLeftRadius, s('.explorerShell').boxShadow],
          rows: ['#explorerTopBar', '#explorerModeBar'].map((sel) => [s(sel).minHeight, s(sel).paddingLeft, s(sel).borderBottomWidth, s(sel).borderBottomColor, s(sel).backgroundColor]),
          tabSize: [s('#explorerModeBrowse').height, s('#explorerCatalogTab').height, s('#explorerModeBrowse').fontSize, s('#explorerCatalogTab').fontSize],
        };
      });
      expect(m.shell).toMatchObject({ x: 0, w: m.vw });
      expect(m.shellStyle).toEqual(['0px', '0px', 'none']);
      expect(Math.round(m.shell.bottom)).toBe(m.vh);
      expect(m.tree.x).toBe(0);
      expect(m.treeBorder).toBe('1px');
      expect(Math.abs(m.main.x - m.tree.right)).toBeLessThanOrEqual(0.5);
      expect(Math.round(m.main.right)).toBe(m.vw);
      // Both rows: 46 px, the gutter, the same separator and surface; the tabs sit 12 px in.
      expect(m.rows[0]).toEqual(m.rows[1]);
      expect(m.rows[0].slice(0, 3)).toEqual(['46px', '12px', '1px']);
      expect(Math.round(m.top.h)).toBe(46);
      expect(Math.round(m.modeBar.h)).toBe(46);
      expect(m.tabs.x).toBe(12);
      expect(Math.round(m.modeTabs.x - m.tree.right)).toBe(12);
      expect(m.tabSize[0]).toBe(m.tabSize[1]);
      expect(m.tabSize[2]).toBe(m.tabSize[3]);
      expect(m.detailPad).toBe('12px');
      // Graph and Storage keep the frame; Functions mirrors the tree.
      for (const mode of ['Graph', 'Storage']) {
        await page.locator(`#explorerMode${mode}`).click();
        await expect(page.locator(`#explorerMode${mode}`)).toHaveAttribute('aria-selected', 'true');
        expectFrame(await measure(page, 'explorer'), `explorer ${mode}`, 12);
      }
      await page.locator('#explorerFunctionsTab').click();
      await expect(page.locator('#explorerFunctionListPane')).toBeVisible();
      expectFrame(await measure(page, 'explorer'), 'explorer functions', 12);
      expect((await page.locator('#explorerFunctionListPane').boundingBox()).x).toBe(0);
    });
  });
}

test.describe('page chrome on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the header wraps the same way on every page, nav rows stay 46 px, content scrolls inside', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
    const headers = {};
    for (const name of Object.keys(PAGES)) {
      await open(page, name);
      if (name === 'explorer' && await page.locator('#explorerListPane').isVisible()) await page.locator('#explorerTreeToggle').click();
      const m = await measure(page, name);
      expectFrame(m, name, 10);
      headers[name] = Math.round(m.header.h);
    }
    expect(new Set(Object.values(headers)).size, JSON.stringify(headers)).toBe(1);

    // Explorer: the tree drawer opens under the mode bar; the Functions
    // overview scrolls inside its pane, never the document.
    await page.goto('/explorer');
    await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
    const toggle = page.locator('#explorerTreeToggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expandExplorerDatabase(page, 'chdash_ui');
    const bar = await page.locator('#explorerModeBar').boundingBox();
    expect(Math.round(bar.height)).toBe(46);
    expect((await page.locator('#explorerListPane').boundingBox()).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    await page.locator('#explorerFunctionsTab').click();
    const pane = page.locator('#explorerFunctionsPane .explorerDetailPane');
    await expect(pane).toContainText(/functions in/i, { timeout: 15_000 });
    const scroll = await pane.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, bottom: el.getBoundingClientRect().bottom }));
    expect(scroll.sh).toBeGreaterThan(scroll.ch);
    expect(Math.round(scroll.bottom)).toBeLessThanOrEqual(844);
    await pane.evaluate((el) => { el.scrollTop = 400; });
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => [document.scrollingElement.scrollTop, document.scrollingElement.scrollHeight <= innerHeight, document.documentElement.scrollWidth <= innerWidth])).toEqual([0, true, true]);
  });
});
