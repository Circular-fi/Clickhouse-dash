import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { expandExplorerDatabase, horizontalOverflow, runSuccessfulQuery, smallTouchTargets } from '../helpers/app.js';
import { appReady } from '../helpers/modules.js';
import { requireInstance } from '../helpers/instances.js';
import { nestedTrace, routeTrace } from '../helpers/trace-mocks.js';

// The page shell (style.css "Page shell" block) gives one full-bleed chrome to
// Query, Explorer, Observability and System. The header comes first, then the nav row.
// The nav row of each page is 40 px high (--nav-row-h). On a phone or a touch screen, it is 41 px high.
// Its tabs keep 40 px on its border.
//
// Below the nav row, the regions go edge to edge on a flat background.
// The regions are split by 1 px borders and inset by the 12 px gutter (10 px at --bp-md and below).
// The document never scrolls. The content region of each page is its scroller.
// Desktop blocks run on every project (1920 / 1440 / 1280) in both themes.
// The phone block pins 390 x 844.

// The shells are the page wrapper and the frame boxes in it. Each one is edge to edge.
const PAGES = {
  query: { path: '/query', ready: '#runButton', nav: null, shells: ['#queryWorkspace', '.panel--query', '.panel--metrics', '#resultsPanel'] },
  explorer: { path: '/explorer/catalog/chdash_ui/weather_observations/columns', ready: '#explorerDetailName', nav: '#explorerTopBar', shells: ['#explorerWorkspace', '.explorerShell', '.explorerGrid:not([hidden])', '#explorerCatalogMain'] },
  traces: { path: '/observability/traces', ready: '#tracesForm', nav: '#obsNav', shells: ['#tracesWorkspace', '#tracesWorkspace > .tracesShell'] },
  logs: { path: '/observability/logs', ready: '#logsForm', nav: '#obsNav', shells: ['#logsWorkspace', '#logsWorkspace > .tracesShell'] },
  metrics: { path: '/observability/metrics', ready: '#metricsToolbar', nav: '#obsNav', shells: ['#metricsWorkspace'] },
  system: { path: '/system', ready: '#systemTopology', nav: '.systemPage__nav', shells: ['#systemWorkspace', '#systemPage', '#systemPanel-overview'] },
};

async function open(page, name) {
  const spec = PAGES[name];
  await page.goto(spec.path);
  await expect(page.locator(spec.ready)).toBeVisible({ timeout: 15_000 });
  if (name === 'explorer') await expect(page.locator('#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
  if (name === 'system') await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// This section sets the geometry and the style of the chrome in one pass.
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
  // There are no scroll containers above the chrome. So the chrome never scrolls away.
  const scrollingAncestor = (el) => {
    for (let node = el?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node.id || node.className;
    }
    return null;
  };
  // The page frame has no rounded, shadowed or inset card. None of its boxes is a card.
  const vw = window.innerWidth;
  const shells = shellSelectors.map((selector) => document.querySelector(selector))
    .filter((el) => el && el.getClientRects().length)
    .map((el) => {
      const s = getComputedStyle(el);
      return { el: el.id || String(el.className).split(' ')[0], radius: parseFloat(s.borderTopLeftRadius) || 0, shadow: s.boxShadow, margin: s.margin };
    });
  // The frame boxes cover the width edge to edge. They are side by side or stacked.
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
    tokens: { border: probe('var(--border)'), panel: probe('var(--panel)'), bg: probe('var(--bg)') },
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
  await appReady(page);
  return page.evaluate(chrome, { nav: PAGES[name].nav, shells: PAGES[name].shells });
}

function expectFrame(m, name, gutter) {
  // Full bleed: the page wrapper spans the viewport from x = 0. It is right under the header.
  // #explorerTopBar and the System tab row are its first row. #obsNav is before it.
  expect(m.main.x, name).toBe(0);
  expect(Math.round(m.main.w), name).toBe(m.vw);
  const chromeBottom = m.nav ? m.nav.bottom : m.header.bottom;
  expect(Math.abs(m.main.y - (name.startsWith('explorer') || name === 'system' ? m.header.bottom : chromeBottom)), name).toBeLessThanOrEqual(0.5);
  expect(Math.round(m.frameRight), name).toBe(m.vw);
  expect(m.shells.length, name).toBeGreaterThan(0);
  for (const shell of m.shells) {
    expect(shell.radius, `${name}: ${shell.el} radius`).toBe(0);
    expect(shell.shadow, `${name}: ${shell.el} shadow`).toBe('none');
    expect(shell.margin, `${name}: ${shell.el} margin`).toBe('0px');
  }
  // The header and the nav row have the same inset, separator and surface.
  expect(m.headerPad, name).toBe(gutter);
  expect(m.headerBorder, name).toEqual(['1px', m.tokens.border]);
  if (m.nav) {
    // The row is 40 px high, or 41 px on a phone. The tabs on its 1 px border keep 40 px of hit area.
    // On a phone, the Explorer's Catalog modes and the System section's controls can take a line of their own.
    const navH = m.vw <= 760 ? 41 : 40;
    if ((name === 'explorer' || name === 'system') && m.vw <= 600) expect(Math.round(m.nav.h), `${name} nav row height`).toBeGreaterThanOrEqual(navH);
    else expect(Math.round(m.nav.h), `${name} nav row height`).toBe(navH);
    expect(Math.abs(m.nav.y - m.header.bottom), name).toBeLessThanOrEqual(0.5);
    expect(m.navPad, name).toBe(gutter);
    expect(m.navStyle, name).toEqual(['1px', m.tokens.border, m.tokens.panel]);
  }
  // The page background is flat. The document never scrolls. The chrome is outside every scroller.
  expect(m.bodyBg, name).toEqual(['none', m.tokens.bg]);
  expect(m.doc.overflowY, name).toBe('hidden');
  expect(m.doc.bodyOverflowY, name).toBe('hidden');
  expect(m.doc.sh, name).toBeLessThanOrEqual(m.doc.ch);
  expect(m.chromeScroller, name).toEqual([null, null]);
  // No horizontal overflow.
  expect(m.doc.sw, name).toBeLessThanOrEqual(m.vw);
  // --shell-top is the bottom of the header and the nav row (app_dom.js).
  expect(m.shellTop, name).toBe(`${Math.round(chromeBottom)}px`);
}

for (const theme of ['dark', 'light']) {
  test.describe(`page chrome (${theme})`, () => {
    test.use({ colorScheme: theme });

    test('every page is full bleed under one header and one 40 px nav row', async ({ page }) => {
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
      // The gutter applies to the editor, its toolbar and the results header. They start 12 px in.
      expect(m.editorWrap.x).toBe(12);
      expect(m.status.x).toBe(12);
      expect(m.title.x).toBe(12);
      // The results header row lines up with the editor toolbar. It has the same inset.
      // It has the height of a nav row and a separator. Then the table goes edge to edge.
      expect(Math.round(m.header.h)).toBe(40);
      expect(m.headerBorder).toBe('1px');
      expect(m.table.x).toBe(0);
      expect(m.tableBorder).toEqual(['0px', '0px']);
      // The workspace is the one scroller. It is under a header that stays in place.
      expect(m.scroll.overflowY).toBe('auto');
      expect(m.scroll.sh).toBeGreaterThan(m.scroll.ch);
      const before = await page.locator('body > .appHeader').boundingBox();
      await page.locator('#queryWorkspace').evaluate((el) => { el.scrollTop = 600; });
      expect(await page.locator('#queryWorkspace').evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await page.locator('body > .appHeader').boundingBox()).toEqual(before);
      expect(await page.evaluate(() => document.scrollingElement.scrollTop)).toBe(0);
      // The split between the editor and the results still resizes.
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

    test('Explorer: tree and content run edge to edge with one separator, one 40 px nav row holds the tabs and Browse | Graph', async ({ page }) => {
      await open(page, 'explorer');
      const m = await page.evaluate(() => {
        const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
        const s = (sel) => getComputedStyle(document.querySelector(sel));
        return {
          vw: window.innerWidth, vh: window.innerHeight,
          shell: box('.explorerShell'), tree: box('#explorerListPane'), main: box('#explorerCatalogMain'),
          top: box('#explorerTopBar'), navTabs: box('#explorerNavTabs'), sep: box('#explorerModeSep'), tabs: box('#explorerViewTabs'), modeTabs: box('#explorerModeTabs'),
          detailPad: s('#explorerDetailPane').paddingLeft,
          treeBorder: s('#explorerListPane').borderRightWidth,
          shellStyle: [s('.explorerShell').borderTopWidth, s('.explorerShell').borderTopLeftRadius, s('.explorerShell').boxShadow],
          rows: ['#explorerTopBar'].map((sel) => [s(sel).minHeight, s(sel).paddingLeft, s(sel).borderBottomWidth, s(sel).borderBottomColor, s(sel).backgroundColor]),
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
      // One row has these parts: 40 px, the gutter and the separator. The tabs sit 12 px in.
      // Then come the divider and Browse | Graph, on the same line.
      // They stand on the bottom border of the row, like the view tabs (second-level sections).
      expect(m.rows[0].slice(0, 3)).toEqual(['40px', '12px', '1px']);
      expect(Math.round(m.top.h)).toBe(40);
      expect(m.navTabs.y).toBeGreaterThanOrEqual(m.top.y);
      expect(m.navTabs.bottom).toBeLessThanOrEqual(m.top.bottom);
      expect(m.tabs.x).toBe(12);
      expect(m.sep.x).toBeGreaterThanOrEqual(m.tabs.right - 0.5);
      expect(m.modeTabs.x).toBeGreaterThanOrEqual(m.sep.right - 0.5);
      expect(m.top.right - m.modeTabs.right).toBeGreaterThan(400);
      expect(Math.abs(m.modeTabs.bottom - m.tabs.bottom)).toBeLessThanOrEqual(0.5);
      expect(Math.abs((m.modeTabs.y + m.modeTabs.h / 2) - (m.tabs.y + m.tabs.h / 2))).toBeLessThanOrEqual(1);
      // The tree starts under the row.
      expect(Math.abs(m.tree.y - m.top.bottom)).toBeLessThanOrEqual(1);
      expect(m.detailPad).toBe('12px');
      // The Storage tab and the Graph of the card keep the frame. Functions mirrors the tree.
      await page.locator('#explorerDetailTabs [role="tab"]', { hasText: 'Storage' }).click();
      await expect(page.locator('#explorerDetailTabs [aria-selected="true"]')).toHaveText('Storage');
      expectFrame(await measure(page, 'explorer'), 'explorer storage tab', 12);
      await page.locator('#explorerModeGraph').click();
      await expect(page.locator('#explorerModeGraph')).toHaveAttribute('aria-selected', 'true');
      expectFrame(await measure(page, 'explorer'), 'explorer Graph', 12);
      await page.locator('#explorerFunctionsTab').click();
      await expect(page.locator('#explorerFunctionListPane')).toBeVisible();
      expectFrame(await measure(page, 'explorer'), 'explorer functions', 12);
      expect((await page.locator('#explorerFunctionListPane').boundingBox()).x).toBe(0);
    });
  });
}

test.describe('page chrome on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the header wraps the same way on every page, nav rows are 41 px, content scrolls inside', async ({ page }, testInfo) => {
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

    // Explorer: the tree drawer opens under the nav row. Browse | Graph is on the row's own line.
    // The Functions overview scrolls inside its pane. It never scrolls the document.
    await page.goto('/explorer/catalog');
    await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
    const toggle = page.locator('#explorerTreeToggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expandExplorerDatabase(page, 'chdash_ui');
    const bar = await page.locator('#explorerTopBar').boundingBox();
    const modes = await page.locator('#explorerModeTabs').boundingBox();
    expect(modes.y + modes.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5);
    expect((await page.locator('#explorerListPane').boundingBox()).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
    await page.locator('#explorerFunctionsTab').click();
    const pane = page.locator('#explorerFunctionsPane .explorerDetailPane');
    await expect(pane).toContainText(/functions in/i, { timeout: 15_000 });
    const scroll = await pane.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, bottom: el.getBoundingClientRect().bottom, overflowY: getComputedStyle(el).overflowY }));
    expect(['auto', 'scroll']).toContain(scroll.overflowY);
    expect(Math.round(scroll.bottom)).toBeLessThanOrEqual(844);
    if (scroll.sh > scroll.ch) {
      await pane.evaluate((el) => { el.scrollTop = 400; });
      expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => [document.scrollingElement.scrollTop, document.scrollingElement.scrollHeight <= innerHeight, document.documentElement.scrollWidth <= innerWidth])).toEqual([0, true, true]);
  });
});

// Touch screens (docs/ui-foundations.md, "Touch and phones") have a coarse pointer.
// On a coarse pointer, every control takes 40 px or more on both axes. This applies to phones and tablets.
// No page scrolls sideways.
const HOUR = '?from=2026-09-12%2012:30:00&to=2026-09-12%2013:30:00';
const TOUCH_STATES = {
  query: async (page) => {
    await page.goto('/query');
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
    await runSuccessfulQuery(page, 'SELECT city, count() AS n, round(avg(temperature_c), 2) AS avg_t FROM chdash_ui.weather_observations GROUP BY city ORDER BY n DESC');
    // The suggestions of the last typed word (DESC) can still be on their way. Dismiss them.
    // Then the audit never meets the transient popup. Its rows are not page controls.
    await page.locator('#queryTextArea').evaluate((el) => el.blur());
    await page.keyboard.press('Escape');
    await expect(page.locator('.autocompleteMenu:visible')).toHaveCount(0);
  },
  // The profiling dialog has the pipeline's controls. Then it has the toggles of the tracing tree.
  pipeline: async (page) => {
    await page.goto('/query');
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
    await runSuccessfulQuery(page, 'SELECT city, count() AS n FROM chdash_ui.weather_observations GROUP BY city', { profiling: true });
    await expect(page.locator('#analysisModal')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#analysisModal .pipelineViewer__control').first()).toBeVisible({ timeout: 15_000 });
  },
  tracing: async (page) => {
    await page.locator('#analysisTraceTab').click();
    await expect(page.locator('#analysisModal .traceViewer__toggle').first()).toBeVisible({ timeout: 15_000 });
  },
  explorer: (page) => open(page, 'explorer'),
  // All databases: the database links of the overview table.
  databases: async (page) => {
    await page.goto('/explorer/catalog');
    await expect(page.locator('#explorerDatabasesOverview .explorerDatabaseObjectsTable__open').first()).toBeVisible({ timeout: 15_000 });
    // Close the tree drawer. It opens on a phone. Wait until its slide is over.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#explorerListPane').evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  },
  // A database page: the links of its objects table.
  database: async (page) => {
    await page.goto('/explorer/catalog/chdash_ui');
    await expect(page.locator('#explorerDatabaseObjects .explorerDatabaseObjectsTable__open').first()).toBeVisible({ timeout: 15_000 });
    // Close the tree drawer. It opens on a phone. Wait until its slide is over.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#explorerListPane').evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  },
  // The Functions overview has the popular chips and the Categories grid.
  functions: async (page) => {
    await page.goto('/explorer/functions');
    await expect(page.locator('#explorerFunctionCategories .explorerFunctionOverview__category').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#explorerFunctionListPane')).not.toBeInViewport();
  },
  system: async (page) => {
    await page.goto('/system');
    await expect(page.locator('#systemTopology')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#systemDatabaseMap .explorerTreemap__node, #systemDatabaseStrip .explorerStorageStrip__segment').first()).toBeVisible({ timeout: 20_000 });
  },
  // Scroll the Overview's charts and activity into view.
  performance: async (page) => {
    await page.goto('/system#performance');
    await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.systemActivitySection').first()).toBeVisible({ timeout: 20_000 });
    // The heading of the part is at the top of the scroller. No control is cut by its edge.
    await page.locator('#systemPart-performance').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  },
  activity: async (page) => {
    await page.goto('/system#activity');
    await expect(page.locator('.systemActivitySection').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
    await page.locator('#systemPart-activity').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  },
  queries: async (page) => {
    await page.goto('/system/queries');
    await expect(page.locator('#systemQueriesTable tbody tr').first()).toBeVisible({ timeout: 30_000 });
  },
  disks: async (page) => {
    await page.goto('/system/disks');
    await expect(page.locator('#systemDiskDatabases tbody tr').first()).toBeVisible({ timeout: 30_000 });
  },
  traces: async (page) => {
    await page.goto(`/observability/traces${HOUR}`);
    await expect(page.locator('#tracesResults .traceResultItem').first()).toBeVisible({ timeout: 30_000 });
  },
  trace: async (page) => {
    const trace = nestedTrace();
    await routeTrace(page, trace);
    await page.goto(`/observability/traces/${trace.trace_id}`);
    await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(trace.spans.length, { timeout: 20_000 });
  },
  // A span is open. This checks the inspector's summaries and copy buttons. Its title row is the title row of the trace views.
  span: async (page) => {
    const trace = nestedTrace();
    await routeTrace(page, trace);
    await page.goto(`/observability/traces/${trace.trace_id}?span=${trace.spans[1].span_id}`);
    await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(trace.spans.length, { timeout: 20_000 });
    await expect(page.locator('.traceInspector details > summary').first()).toBeVisible({ timeout: 15_000 });
    return { only: '.traceInspector summary, .traceInspector .uiCopy, #traceDetailHeader .uiCopy' };
  },
  logs: async (page) => {
    await page.goto(`/observability/logs${HOUR}`);
    await expect(page.locator('#logsTableRows .logsRow[data-row-id]').first()).toBeVisible({ timeout: 30_000 });
  },
  metrics: async (page) => {
    await page.goto(`/observability/metrics${HOUR}`);
    await expect(page.locator('#metricsToolbar .obsFilterSummary')).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('#metricsCatalog .uiState--loading')).toHaveCount(0, { timeout: 30_000 });
  },
};

test.describe('touch screens', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('every control is 40 px or more on a touch screen and no page scrolls sideways (390, 360, 768)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'the touch viewports are pinned: one project is enough');
    test.setTimeout(180_000);
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 768, height: 1024 }]) {
      await page.setViewportSize(size);
      for (const [name, show] of Object.entries(TOUCH_STATES)) {
        const { only = '' } = (await show(page)) || {};
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), name).toBe(true);
        // A treemap rectangle or a strip segment (the size bands) has the size of its share of the data.
        expect(await smallTouchTargets(page, { skip: ['.explorerTreemap__node', '.explorerStorageStrip__segment'], only }), `${name} @ ${size.width}`).toEqual([]);
        expect(await horizontalOverflow(page), `${name} @ ${size.width}`).toBeLessThanOrEqual(0);
      }
    }
  });

  test('a tab row that scrolls sideways fades the side it hides tabs on', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewport is pinned: one project is enough');
    await page.goto('/observability/traces');
    const nav = page.locator('#obsNav');
    await expect(nav).toHaveClass(/has-edge-end/);
    await expect(nav).not.toHaveClass(/has-edge-start/);
    const fade = await nav.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    expect(fade).toContain('linear-gradient');
    await nav.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(nav).toHaveClass(/has-edge-start/);
    await expect(nav).not.toHaveClass(/has-edge-end/);
    // A row that fits has no cue.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(nav).not.toHaveClass(/has-edge-(start|end)/);
  });

  test('the header on a phone is one row: the logo, the host, the page menu and the theme; the host\'s version and ping stay in its menu', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewports are pinned: one project is enough');
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      await page.setViewportSize(size);
      for (const name of ['query', 'traces']) {
        await open(page, name);
        const header = await page.evaluate(() => {
          const box = (el) => el.getBoundingClientRect();
          const text = document.getElementById('hostPickerText');
          return {
            height: box(document.querySelector('header.appHeader')).height,
            versionShown: getComputedStyle(document.getElementById('hostPickerVersion')).display !== 'none',
            badgeShown: getComputedStyle(document.getElementById('versionBadge')).display !== 'none',
            clipped: text.scrollWidth > text.clientWidth + 1,
            tops: ['hostPickerButton', 'pageSelectButton', 'themeSelectButton'].map((id) => Math.round(box(document.getElementById(id)).top)),
          };
        });
        expect(header.height, `${name} @ ${size.width}`).toBeLessThanOrEqual(64);
        expect(header.versionShown && header.badgeShown, `${name} @ ${size.width}`).toBe(false);
        expect(new Set(header.tops).size, `${name} @ ${size.width}: one row`).toBe(1);
        expect(header.clipped, `${name} @ ${size.width}`).toBe(false);
      }
    }
  });
});

// ---- the navigation follows the access of the human (docs/access.md, "Navigation", user decision 2026-10-18) -----------------------
//
// The instance is ACCESS_BASE_URL: tests/config/access.authzen.hcl (compose service chdash_access), in the authzen mode, with the fake
// PDP ACCESS_PDP_URL. That configuration has no OpenTelemetry tables, so Observability is not a page there. Each request of the browser carries an identity token, signed here with the Ed25519 test key
// (tests/config/secrets/access-identity-keys.pem has its public key). The PDP gives each test subject its whole grant.
const ACCESS = (process.env.ACCESS_BASE_URL || '').replace(/\/$/, '');
const ACCESS_PDP = (process.env.ACCESS_PDP_URL || '').replace(/\/$/, '');
const ACCESS_KEY = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1))]),
  format: 'der',
  type: 'pkcs8',
});
const b64url = (data) => Buffer.from(data).toString('base64url');
function identityToken(sub) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: 'https://access.test', sub, aud: 'db', iat: now - 5, exp: now + 240 }))}`;
  return `${input}.${b64url(crypto.sign(null, Buffer.from(input), ACCESS_KEY))}`;
}
const ALL_ACTIONS = ['query.run.read', 'query.run.write', 'query.export', 'library.read', 'library.write', 'explorer.read', 'system.read',
  'system.kill_query', 'observability.read', 'mcp.keys.read', 'mcp.keys.write', 'mcp.usage.read'];
const GRANTS = {
  'nav-querier': ['query.run.read', 'query.run.write', 'query.export'],
  'nav-explorer': ['explorer.read'],
  'nav-usage': ['query.run.read', 'mcp.usage.read'],
  'nav-admin': ALL_ACTIONS,
};
const NAV_LINKS = { query: '#navQueryLink', explorer: '#navExplorerLink', observability: '#navObservabilityLink', system: '#navSystemLink', mcp: '#navMcpLink' };
const DENIED_PATHS = { explorer: '/explorer/catalog', system: '/system', 'mcp-keys': '/mcp-integration', 'mcp-usage': '/mcp-integration/usage', query: '/query' };

async function asHuman(page, sub) {
  await page.setExtraHTTPHeaders({ 'X-Identity-Token': identityToken(sub) });
}
// The links of the header that a human sees. A wide window shows the switcher as a row of links; a narrow one has a button that opens it.
async function visibleNavLinks(page) {
  const shown = [];
  if (await page.locator('#pageSelect').isHidden()) return shown;
  const toggle = page.locator('#pageSelectButton');
  const narrow = await toggle.isVisible();
  if (narrow) await toggle.click();
  for (const [name, selector] of Object.entries(NAV_LINKS)) {
    if (await page.locator(selector).isVisible()) shown.push(name);
  }
  if (narrow) await page.keyboard.press('Escape');
  return shown;
}
async function expectDenied(page, path, label, action, allowed) {
  const response = await page.goto(`${ACCESS}${path}`);
  expect(response.status(), path).toBe(403);
  await expect(page.locator('#accessDenied h1')).toHaveText(`You cannot open ${label}`);
  await expect(page.locator('#accessDenied code')).toHaveText(action);
  // No partial render: no script, no header, no data of the page.
  expect(await page.evaluate(() => ({ scripts: document.scripts.length, header: !!document.querySelector('header.appHeader') }))).toEqual({ scripts: 0, header: false });
  await expect(page.locator('#accessDeniedPages a')).toHaveText(allowed);
}

test.describe('the navigation follows the access of the human', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ request }, testInfo) => {
    if (!ACCESS || !ACCESS_PDP || testInfo.project.name !== 'desktop-1440') return;
    const answer = await request.post(`${ACCESS_PDP}/control/answer`, { data: { default: false, subjects: GRANTS } });
    expect(answer.ok()).toBe(true);
    // The cache of the decisions of the instance (pdp.cache_ttl = 1s) forgets the former answers.
    await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  test.afterAll(async ({ request }, testInfo) => {
    if (ACCESS_PDP && testInfo.project.name === 'desktop-1440') await request.post(`${ACCESS_PDP}/control/reset`, { data: {} });
  });
  test.beforeEach(({}, testInfo) => {
    // The fake PDP is one for the whole run: one project sets it and runs these tests, so no other project resets it meanwhile.
    test.skip(testInfo.project.name !== 'desktop-1440', 'the access of a human does not depend on the viewport: one project is enough');
    requireInstance(test, 'ACCESS_BASE_URL', ACCESS);
    requireInstance(test, 'ACCESS_PDP_URL', ACCESS_PDP);
  });

  test('a human with only query actions sees the Query page and no link to another page; the other pages answer 403', async ({ page }) => {
    await asHuman(page, 'nav-querier');
    await page.goto(`${ACCESS}/query`);
    await expect(page.locator('#runButton')).toBeVisible({ timeout: 15_000 });
    // The server lists the pages of this render, and hides the links of the others from the first paint.
    await expect(page.locator('#chdashPages')).toHaveAttribute('content', 'query');
    for (const name of ['explorer', 'observability', 'system', 'mcp']) {
      await expect(page.locator(NAV_LINKS[name])).toHaveAttribute('data-denied', '');
    }
    // After /api/version answers, nothing comes back: the page switcher has no other page, so it is not shown.
    await expect(page.locator('#versionBadge')).not.toHaveText('--');
    await expect(page.locator('#pageSelect')).toBeHidden();
    expect(await visibleNavLinks(page)).toEqual([]);
    expect(await page.evaluate(() => ['query', 'explorer', 'observability', 'system', 'mcp-keys', 'mcp-usage'].filter((name) => window.ChDash.features.page(name))))
      .toEqual(['query']);
    // Each page that the human cannot use answers 403 with a clear page and the links that the human can use.
    await expectDenied(page, DENIED_PATHS.explorer, 'Explorer', 'explorer.read', ['Query']);
    await expectDenied(page, '/explorer/catalog/chdash_ui/weather_observations', 'Explorer', 'explorer.read', ['Query']);
    await expectDenied(page, DENIED_PATHS.system, 'System', 'system.read', ['Query']);
    await expectDenied(page, '/system/disks', 'System', 'system.read', ['Query']);
    await expectDenied(page, DENIED_PATHS['mcp-keys'], 'MCP integration', 'mcp.keys.read', ['Query']);
    await expectDenied(page, DENIED_PATHS['mcp-usage'], 'MCP usage', 'mcp.usage.read', ['Query']);
    // The link of the 403 page opens the Query page under the same root.
    await page.locator('#accessDeniedPages a', { hasText: 'Query' }).click();
    await expect(page.locator('#runButton')).toBeVisible({ timeout: 15_000 });
  });

  test('a human with only explorer.read: the root opens the Explorer, Query is not a link, and Open in Query is not offered', async ({ page }) => {
    await asHuman(page, 'nav-explorer');
    await page.goto(`${ACCESS}/`);
    await expect(page).toHaveURL(/\/explorer\/catalog$/);
    await expect(page.locator('#chdashPages')).toHaveAttribute('content', 'explorer');
    await expect(page.locator('#navQueryLink')).toHaveAttribute('data-denied', '');
    await expect(page.locator('#versionBadge')).not.toHaveText('--');
    expect(await visibleNavLinks(page)).toEqual(['explorer']);
    // The preview of a table has no Open in Query.
    await page.goto(`${ACCESS}/explorer/catalog/chdash_ui/weather_observations/preview`);
    await expect(page.locator('.explorerDataToolbar__actions')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Open in Query' })).toHaveCount(0);
    await expectDenied(page, DENIED_PATHS.query, 'Query', 'query.run.read', ['Explorer']);
    await expectDenied(page, DENIED_PATHS.system, 'System', 'system.read', ['Explorer']);
    await expectDenied(page, DENIED_PATHS['mcp-keys'], 'MCP integration', 'mcp.keys.read', ['Explorer']);
  });

  test('a human with the usage of the keys and not the keys: the MCP entry leads to the usage, and the Keys tab is not a link', async ({ page }) => {
    await asHuman(page, 'nav-usage');
    await page.goto(`${ACCESS}/mcp-integration/usage`);
    await expect(page.locator('#mcpTab-usage')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#mcpTab-keys')).toBeHidden();
    await expect(page.locator('#mcpTab-keys')).toHaveAttribute('data-denied', '');
    expect(new URL(await page.locator('#navMcpLink').getAttribute('href'), ACCESS).pathname).toBe('/mcp-integration/usage');
    await expectDenied(page, DENIED_PATHS['mcp-keys'], 'MCP integration', 'mcp.keys.read', ['Query', 'MCP usage']);
  });

  test('a human with every action sees every page and every link', async ({ page }) => {
    await asHuman(page, 'nav-admin');
    await page.goto(`${ACCESS}/query`);
    await expect(page.locator('#runButton')).toBeVisible({ timeout: 15_000 });
    // Every page of this configuration: it turns Observability off, so its link is the one that is denied.
    await expect(page.locator('#chdashPages')).toHaveAttribute('content', 'query explorer system mcp-keys mcp-usage');
    await expect(page.locator('[data-denied]')).toHaveCount(1);
    await expect(page.locator('#navObservabilityLink')).toHaveAttribute('data-denied', '');
    await expect(page.locator('#versionBadge')).not.toHaveText('--');
    expect(await visibleNavLinks(page)).toEqual(['query', 'explorer', 'system', 'mcp']);
    for (const path of ['/explorer/catalog', '/explorer/functions', '/system', '/system/disks', '/mcp-integration', '/mcp-integration/usage']) {
      const response = await page.goto(`${ACCESS}${path}`);
      expect(response.status(), path).toBe(200);
      // The shell of a human is never kept by a cache.
      expect(response.headers()['cache-control'], path).toBe('no-store');
    }
    await page.goto(`${ACCESS}/explorer/catalog/chdash_ui/weather_observations/preview`);
    await expect(page.getByRole('button', { name: 'Open in Query' })).toBeVisible({ timeout: 15_000 });
  });
});

test('the open mode keeps every link: no list of pages, nothing denied', async ({ page }) => {
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#chdashPages')).toHaveCount(0);
  await expect(page.locator('[data-denied]')).toHaveCount(0);
  expect(await page.evaluate(() => ['query', 'explorer', 'system'].every((name) => window.ChDash.features.page(name)))).toBe(true);
});

