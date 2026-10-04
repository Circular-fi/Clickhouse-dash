import { test, expect } from '@playwright/test';
import { expandExplorerDatabase, horizontalOverflow, runSuccessfulQuery, smallTouchTargets } from '../helpers/app.js';
import { nestedTrace, routeTrace } from '../helpers/trace-mocks.js';

// The page shell (style.css "Page shell" block): one full-bleed chrome for
// Query, Explorer, Observability and System. Header, then the page's nav row (48 px,
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
  // the header (#explorerTopBar and the System tab row are its first row;
  // #obsNav sits before it).
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
  // The header and the nav row: the same inset, separator and surface.
  expect(m.headerPad, name).toBe(gutter);
  expect(m.headerBorder, name).toEqual(['1px', m.tokens.border]);
  if (m.nav) {
    // 48 px; on a phone the Explorer's Catalog modes and the System
    // section's controls take a line of their own.
    if ((name === 'explorer' || name === 'system') && m.vw <= 600) expect(Math.round(m.nav.h), `${name} nav row height`).toBeGreaterThanOrEqual(48);
    else expect(Math.round(m.nav.h), `${name} nav row height`).toBe(48);
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

    test('every page is full bleed under one header and one 48 px nav row', async ({ page }) => {
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
      expect(Math.round(m.header.h)).toBe(48);
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

    test('Explorer: tree and content run edge to edge with one separator, one 48 px nav row holds the tabs and Browse | Graph', async ({ page }) => {
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
      // One row: 48 px, the gutter, the separator; the tabs sit 12 px in,
      // then the divider and Browse | Graph, on the same line, standing on
      // the row's bottom border like the view tabs (second-level sections).
      expect(m.rows[0].slice(0, 3)).toEqual(['48px', '12px', '1px']);
      expect(Math.round(m.top.h)).toBe(48);
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
      // The card's Storage tab and Graph keep the frame; Functions mirrors the tree.
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

  test('the header wraps the same way on every page, nav rows stay 48 px, content scrolls inside', async ({ page }, testInfo) => {
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

    // Explorer: the tree drawer opens under the nav row (Browse | Graph on
    // the row's own line); the Functions overview scrolls inside its pane,
    // never the document.
    await page.goto('/explorer');
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

// Touch screens (docs/ui-foundations.md, "Touch and phones"): on a coarse
// pointer every control takes 40 px or more on both axes, on phones and the
// tablet alike, and no page scrolls sideways.
const HOUR = '?from=2026-09-12%2012:30:00&to=2026-09-12%2013:30:00';
const TOUCH_STATES = {
  query: async (page) => {
    await page.goto('/query');
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
    await runSuccessfulQuery(page, 'SELECT city, count() AS n, round(avg(temperature_c), 2) AS avg_t FROM chdash_ui.weather_observations GROUP BY city ORDER BY n DESC');
  },
  // The profiling dialog: the pipeline's controls, then the tracing tree's toggles.
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
  // All databases: the overview table's database links.
  databases: async (page) => {
    await page.goto('/explorer');
    await expect(page.locator('#explorerDatabasesOverview .explorerDatabaseObjectsTable__open').first()).toBeVisible({ timeout: 15_000 });
    // The tree drawer (it opens on a phone) closed, its slide over.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#explorerListPane').evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  },
  // A database page: its objects table's links.
  database: async (page) => {
    await page.goto('/explorer/chdash_ui');
    await expect(page.locator('#explorerDatabaseObjects .explorerDatabaseObjectsTable__open').first()).toBeVisible({ timeout: 15_000 });
    // The tree drawer (it opens on a phone) closed, its slide over.
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('#explorerListPane').evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  },
  // The Functions overview: the popular chips and the Categories grid.
  functions: async (page) => {
    await page.goto('/explorer/_functions');
    await expect(page.locator('#explorerFunctionCategories .explorerFunctionOverview__category').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#explorerFunctionListPane')).not.toBeInViewport();
  },
  system: async (page) => {
    await page.goto('/system');
    await expect(page.locator('#systemTopology')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#systemDatabaseMap .explorerTreemap__node, #systemDatabaseStrip .explorerStorageStrip__segment').first()).toBeVisible({ timeout: 20_000 });
  },
  // The Overview's charts and activity, scrolled into view.
  performance: async (page) => {
    await page.goto('/system#performance');
    await expect(page.locator('#systemChart-cpu .chartCore canvas')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.systemActivitySection').first()).toBeVisible({ timeout: 20_000 });
    // The part's heading at the top of the scroller: no control cut by its edge.
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
  // A span open: the inspector's summaries and copy buttons (its title row is the trace views').
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
        // A treemap rectangle or a strip segment (the size bands) is as large as its share of the data.
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
    // A row that fits carries no cue.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(nav).not.toHaveClass(/has-edge-(start|end)/);
  });

  test('the header shows the host ClickHouse version in full on phones', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'the phone viewports are pinned: one project is enough');
    for (const size of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      await page.setViewportSize(size);
      for (const name of ['query', 'traces']) {
        await open(page, name);
        const version = page.locator('#hostPickerVersion');
        await expect(version).toHaveText(/\d+\.\d+/, { timeout: 15_000 });
        await expect(version).toBeVisible();
        const fit = await version.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const button = el.closest('button').getBoundingClientRect();
          return { clipped: el.scrollWidth > el.clientWidth + 1, inside: r.left >= button.left && r.right <= button.right };
        });
        expect(fit, `${name} @ ${size.width}`).toEqual({ clipped: false, inside: true });
      }
    }
  });
});
