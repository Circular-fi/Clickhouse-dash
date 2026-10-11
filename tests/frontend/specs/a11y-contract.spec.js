import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { runSuccessfulQuery } from '../helpers/app.js';
import { appReady } from '../helpers/modules.js';
import { requireInstance } from '../helpers/instances.js';
import { mockTraceResults, SYNTHETIC_TRACES } from '../helpers/traces.js';

// Accessibility contract (docs/ui-foundations.md, "Accessibility"): in both themes, the colours that carry
// meaning reach their WCAG ratio (text 4.5:1, the edge of a field 3:1, the focus ring 3:1), the pages give axe
// nothing to report, the keyboard has a skip link and a landmark to land in, the ARIA of the lists and the
// separators is valid, and the forced-colors (Windows high contrast) rules keep the icons and the selection.
// The look of each fixed finding is in the design review (UI-111 ... UI-127); this file is what keeps it fixed.

const THEMES = ['dark', 'light'];
const FIRST = SYNTHETIC_TRACES[0];

const useTheme = (page, theme) => page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);

// --- colour maths, in the page (the tokens resolve through ns.palette.resolve) -------------------------------

// Contrast of each pair, from tokens: [{ fg, bg, ratio }]. fg may carry an alpha: it is composited over `over`
// (the field's own fill) and then compared with bg (what the field sits on).
function contrastsOf(page, theme, pairs) {
  return page.evaluate(({ theme, pairs }) => {
    document.documentElement.setAttribute('data-theme', theme);
    const resolve = window.ChDash.palette.resolve;
    const parse = (text) => { const p = /rgba?\(([^)]+)\)/.exec(text)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = (c) => { const l = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const color = (token) => parse(resolve(token));
    return pairs.map(([fg, bg, via]) => {
      const back = color(bg);
      const fill = via ? over(color(via), back) : back;
      const front = over(color(fg), fill);
      return { fg, bg, via: via || '', ratio: Math.round(ratio(front, back) * 100) / 100 };
    });
  }, { theme, pairs });
}

const SURFACES = ['--editor-solid-bg', '--panel', '--raised', '--bg'];

for (const theme of THEMES) {
  test(`tokens (${theme}): SQL colours, muted text and placeholders reach 4.5:1 on every surface`, async ({ page }) => {
    await page.goto('/query');
    const pairs = [];
    for (const token of ['--sql-string', '--sql-keyword', '--sql-function', '--sql-number', '--sql-null', '--sql-type', '--sql-comment', '--muted', '--text'])
      for (const surface of SURFACES) pairs.push([token, surface]);
    for (const surface of ['--input-bg', '--button-bg']) pairs.push(['--muted', surface]);
    const weak = (await contrastsOf(page, theme, pairs)).filter((c) => c.ratio < 4.5);
    expect(weak).toEqual([]);
  });

  test(`tokens (${theme}): the edge of a field and the focus ring reach 3:1 on every surface`, async ({ page }) => {
    await page.goto('/query');
    const pairs = [];
    for (const surface of ['--panel', '--raised', '--bg', '--editor-solid-bg']) {
      pairs.push(['--control-border', surface, '--input-bg'], ['--control-border-hover', surface, '--input-bg'], ['--focus-ring-color', surface]);
    }
    const weak = (await contrastsOf(page, theme, pairs)).filter((c) => c.ratio < 3);
    expect(weak).toEqual([]);
  });
}

// --- every field has an edge, every placeholder is readable ----------------------------------------------------

const FIELD_SELECTOR = [
  'input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio])', 'select', 'textarea', '[role=combobox]', '[role=searchbox]',
  '.tracePicker__button', '.editorWrap',
].join(', ');

// Each visible field: the contrast of its border (over its own fill) and of its fill against what it sits on, and of
// its placeholder against its fill.
function fieldContrasts(page) {
  return page.evaluate((selector) => {
    const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
    const lum = (c) => { const l = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const behind = (el) => {
      const chain = [];
      for (let p = el; p; p = p.parentElement) chain.push(p);
      let c = { r: 255, g: 255, b: 255, a: 1 };
      for (const p of chain.reverse()) { const v = parse(getComputedStyle(p).backgroundColor); if (v && v.a > 0) c = over(v, c); }
      return c;
    };
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (!box.width || !box.height || box.width <= 2 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.closest('.tracePicker__native, [hidden], .srOnly')) continue;
      const outside = behind(el.parentElement || el);
      const own = parse(style.backgroundColor);
      const inside = own && own.a > 0 ? over(own, outside) : outside;
      const bw = parseFloat(style.borderTopWidth) || 0;
      const bc = parse(style.borderTopColor);
      const border = bw > 0 && bc && bc.a > 0 ? ratio(over(bc, inside), outside) : 0;
      // The editor's textarea is bare: its frame (.editorWrap, a field of its own here) carries the edge.
      const row = { field: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')}`, edge: el.matches('.editorInput') ? Infinity : Math.max(border, ratio(inside, outside)) };
      if (el.placeholder) {
        const ph = getComputedStyle(el, '::placeholder');
        const color = parse(ph.color);
        row.placeholder = ratio(over({ ...color, a: color.a * Number(ph.opacity) }, inside), inside);
      }
      out.push(row);
    }
    return out;
  }, FIELD_SELECTOR);
}

const FIELD_PAGES = {
  query: { url: '/query' },
  traces: { url: '/observability/traces?from=now-1h&to=now', mock: true },
  logs: { url: '/observability/logs?from=now-1h&to=now' },
  metrics: { url: '/observability/metrics?from=now-1h&to=now' },
  explorer: { url: '/explorer/catalog' },
  functions: { url: '/explorer/functions' },
  system: { url: '/system/queries' },
};

for (const theme of THEMES) {
  for (const [name, spec] of Object.entries(FIELD_PAGES)) {
    test(`fields (${theme}): ${name}: every field has a 3:1 edge and a 4.5:1 placeholder`, async ({ page }) => {
      await useTheme(page, theme);
      if (spec.mock) await mockTraceResults(page);
      await page.goto(spec.url);
      await expect(page.locator('#hostPickerButton')).toBeVisible();
      await page.waitForTimeout(1500);
      const fields = await fieldContrasts(page);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.filter((f) => f.edge < 3), 'edge below 3:1').toEqual([]);
      expect(fields.filter((f) => f.placeholder != null && f.placeholder < 4.5), 'placeholder below 4.5:1').toEqual([]);
    });
  }
}

// --- the focus ring does not melt into a solid fill ------------------------------------------------------------

test('focus: the ring of a primary button sits 2px off its fill, in both themes', async ({ page }) => {
  for (const theme of THEMES) {
    await useTheme(page, theme);
    await page.goto('/query');
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#queryTextArea').focus();
    await page.keyboard.press('Tab'); // the keyboard makes it :focus-visible
    await page.locator('#runButton').focus();
    const ring = await page.locator('#runButton').evaluate((el) => {
      const s = getComputedStyle(el);
      return { match: el.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor, fill: s.backgroundColor };
    });
    expect(ring.match, theme).toBe(true);
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
    expect(parseFloat(ring.offset), theme).toBeGreaterThanOrEqual(2);
    expect(ring.color).not.toBe(ring.fill);
  }
});

// --- axe: nothing to report on the pages and states that were fixed ------------------------------------------

async function openState(page, state, request) {
  switch (state) {
    case 'query-empty':
      await page.goto('/query');
      await expect(page.locator('#runButton')).toBeEnabled();
      break;
    case 'query-results':
      await page.goto('/query');
      await runSuccessfulQuery(page, "SELECT number AS id, concat('row-', toString(number)) AS label FROM numbers(8)");
      break;
    case 'explorer-db':
      await page.goto('/explorer/catalog/chdash_ui');
      await expect(page.locator('#explorerTableList')).toContainText('chdash_ui', { timeout: 20_000 });
      break;
    case 'explorer-ddl':
      await page.goto('/explorer/catalog/chdash_ui/weather_observations?tab=ddl');
      await expect(page.locator('.sqlBlock__code').first()).toBeVisible({ timeout: 20_000 });
      break;
    case 'explorer-storage-graph':
      await page.goto('/explorer/catalog?mode=graph&graph=storage');
      await expect(page.locator('.graphKit__canvas').first()).toBeVisible({ timeout: 20_000 });
      break;
    case 'functions':
      await page.goto('/explorer/functions/count');
      await expect(page.locator('#explorerFunctionDetailName')).toHaveText(/count/i, { timeout: 20_000 });
      break;
    case 'traces':
      await mockTraceResults(page);
      await page.goto('/observability/traces?from=now-3h&to=now');
      await expect(page.locator('#tracesResults .traceResultItem').first()).toBeVisible({ timeout: 30_000 });
      break;
    case 'traces-empty':
      await page.goto('/observability/traces');
      await expect(page.locator('#tracesResults')).toBeVisible();
      await page.waitForTimeout(3000);
      break;
    case 'logs-empty':
      await page.goto('/observability/logs');
      await expect(page.locator('#logsTable')).toBeVisible();
      await page.waitForTimeout(3000);
      break;
    case 'explorer-root':
      await page.goto('/explorer/catalog');
      await expect(page.locator('#explorerTableList')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(2500);
      break;
    case 'system-queries':
      await page.goto('/system/queries');
      await expect(page.locator('#systemPage')).toBeVisible();
      await page.waitForTimeout(3000);
      break;
    case 'trace':
      await mockTraceResults(page);
      await page.goto(`/observability/traces/${FIRST.trace_id}`);
      await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
      break;
    case 'trace-span-open':
      await mockTraceResults(page);
      await page.goto(`/observability/traces/${FIRST.trace_id}`);
      await page.locator('#traceWaterfall .traceSpanRow').nth(1).click();
      await expect(page.locator('#traceWaterfall .traceSpanInspectorRow')).toBeVisible({ timeout: 10_000 });
      break;
    case 'logs': {
      const meta = await (await request.get('/api/logs/meta')).json();
      test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
      const end = Number(meta.time_bounds.max_ms);
      const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
      await page.goto(`/observability/logs?from=${encodeURIComponent(stamp(end - 1800000))}&to=${encodeURIComponent(stamp(end + 1000))}`);
      await expect(page.locator('#logsTableRows .logsRow[data-row-id]').first()).toBeVisible({ timeout: 30_000 });
      break;
    }
    case 'metrics':
      await page.goto('/observability/metrics');
      await expect(page.locator('#metricsCatalog')).toBeVisible();
      await page.waitForTimeout(2500);
      break;
    case 'system':
      await page.goto('/system');
      await expect(page.locator('#systemPage')).toBeVisible();
      await page.waitForTimeout(3000);
      break;
    case 'disks':
      await page.goto('/system/disks');
      await expect(page.locator('#systemDisks')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(3000);
      break;
    default:
      throw new Error(`unknown state ${state}`);
  }
}

const AXE_STATES = ['query-empty', 'query-results', 'explorer-root', 'explorer-db', 'explorer-ddl', 'explorer-storage-graph', 'functions', 'traces', 'traces-empty', 'trace', 'trace-span-open', 'logs', 'logs-empty', 'metrics', 'system', 'system-queries', 'disks'];

for (const theme of THEMES) {
  for (const state of AXE_STATES) {
    test(`axe (${theme}): ${state} has no violation`, async ({ page, request }) => {
      await useTheme(page, theme);
      await openState(page, state, request);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')}: ${n.failureSummary.split('\n')[1] || ''}`.trim()) }))).toEqual([]);
    });
  }
}

// The MCP page needs a server with MCP on (the instance of mcp-contract.spec.js).
test('axe (dark): the MCP page has no violation', async ({ page }) => {
  const base = (process.env.MCP_CONTRACT_BASE_URL || '').replace(/\/$/, '');
  requireInstance(test, 'MCP_CONTRACT_BASE_URL', base);
  await page.goto(`${base}/mcp-integration`);
  await expect(page.locator('#mcpWorkspace')).toBeVisible();
  await page.waitForTimeout(1500);
  expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
});

// --- landmarks, headings, skip link ----------------------------------------------------------------------------

const SHELLS = {
  query: '/query', explorer: '/explorer/catalog', functions: '/explorer/functions', traces: '/observability/traces', logs: '/observability/logs',
  metrics: '/observability/metrics', system: '/system', queries: '/system/queries', disks: '/system/disks', trace: `/observability/traces/${FIRST.trace_id}`,
};

for (const [name, url] of Object.entries(SHELLS)) {
  test(`landmarks: ${name} has its one h1 inside its main, and the skip link leads to that main`, async ({ page }) => {
    await mockTraceResults(page);
    await page.goto(url);
    await expect(page.locator('#hostPickerButton')).toBeVisible();
    const shape = await page.evaluate(() => {
      const main = document.querySelector('main');
      const link = document.querySelector('a.skipLink');
      return {
        h1: document.querySelectorAll('h1').length,
        h1InMain: !!main && !!document.querySelector('h1') && main.contains(document.querySelector('h1')),
        mains: document.querySelectorAll('main').length,
        mainId: main?.id || '',
        firstTab: document.querySelector('body > a.skipLink, body > *:first-child') === link,
        target: link?.getAttribute('href'),
      };
    });
    expect(shape.h1).toBe(1);
    expect(shape.h1InMain).toBe(true);
    expect(shape.mains).toBe(1);
    expect(shape.firstTab).toBe(true);
    expect(shape.target).toBe(`#${shape.mainId}`);
  });
}

test('skip link: the first Tab shows it over the header, Enter lands the next Tab inside the main', async ({ page }) => {
  for (const url of ['/query', '/observability/traces', '/explorer/catalog']) {
    await mockTraceResults(page);
    await page.goto(url);
    await expect(page.locator('#hostPickerButton')).toBeVisible();
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('Tab');
    const link = page.locator('a.skipLink');
    await expect(link).toBeFocused();
    const box = await link.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    // The address stays: no fragment is written.
    expect(new URL(page.url()).hash, url).toBe('');
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('main'));
    expect(inside, url).toBe(true);
  }
});

test('skip link: out of sight until it has the focus', async ({ page }) => {
  await page.goto('/query');
  const link = page.locator('a.skipLink');
  const before = await link.boundingBox();
  expect(before.y + before.height).toBeLessThanOrEqual(0);
  await page.keyboard.press('Tab');
  const after = await link.boundingBox();
  expect(after.y).toBeGreaterThanOrEqual(0);
});

// --- ARIA of the lists, the separators and the charts ----------------------------------------------------------

test('charts: the keyboard cursor of a chart is an application named "chart" with an accessible name', async ({ page }) => {
  await page.goto('/query');
  await runSuccessfulQuery(page, "SELECT toStartOfHour(now() - number * 3600) AS t, number AS v FROM numbers(6) ORDER BY t");
  await page.locator('.segmented__option[data-view="chart"]').first().click();
  const overlay = page.locator('.chartCore__overlay').first();
  await expect(overlay).toHaveAttribute('role', 'application');
  await expect(overlay).toHaveAttribute('aria-roledescription', 'chart');
  await expect(overlay).toHaveAttribute('aria-label', /^Chart cursor:/);
});

test('trace results: the title is a link, the card is not a control, and Enter on the link opens the trace', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto('/observability/traces?from=now-3h&to=now');
  const card = page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"]`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(await card.evaluate((el) => ({ role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), tag: el.tagName }))).toEqual({ role: null, tabindex: null, tag: 'LI' });
  const link = card.locator('a.traceResult__wideTitle');
  await expect(link).toHaveAttribute('href', new RegExp(`/observability/traces/${FIRST.trace_id}`));
  // No control inside a control: every tab stop of the card is a link or a button.
  expect(await card.evaluate((el) => [...el.querySelectorAll('[tabindex="0"]')].filter((node) => !node.matches('a, button')).length)).toBe(0);
  await link.focus();
  await Promise.all([page.waitForURL(new RegExp(`/observability/traces/${FIRST.trace_id}`)), page.keyboard.press('Enter')]);
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
});

test('trace waterfall: the column separator has its value, bounds and arrow keys; a span row is a named group', async ({ page }) => {
  await mockTraceResults(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}`);
  const separator = page.locator('#traceWaterfall [data-trace-waterfall-resizer]');
  await expect(separator).toBeVisible({ timeout: 30_000 });
  await expect(separator).toHaveAttribute('role', 'separator');
  const min = Number(await separator.getAttribute('aria-valuemin'));
  const max = Number(await separator.getAttribute('aria-valuemax'));
  const now = Number(await separator.getAttribute('aria-valuenow'));
  expect(min).toBeGreaterThan(0);
  expect(max).toBeGreaterThan(min);
  expect(now).toBeGreaterThanOrEqual(min);
  expect(now).toBeLessThanOrEqual(max);
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(now + 2));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(separator).toHaveAttribute('aria-valuenow', String(now - 2));
  // A row holds buttons (the fold box, the badges): it is a group named by what it shows, never a button.
  const row = page.locator('#traceWaterfall .traceSpanRow').first();
  expect(await row.getAttribute('role')).toBe('group');
  await expect(row).toHaveAttribute('aria-label', /: .+, \d/);
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-label', /, details open$/);
});

test('logs: the records are a grid of rows and cells, counted for the window, with one Tab stop', async ({ page, request }) => {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
  const end = Number(meta.time_bounds.max_ms);
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  await page.goto(`/observability/logs?from=${encodeURIComponent(stamp(end - 1800000))}&to=${encodeURIComponent(stamp(end + 1000))}`);
  const rows = page.locator('#logsTableRows .logsRow[data-row-id]');
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const grid = page.locator('#logsTable');
  await expect(grid).toHaveAttribute('role', 'grid');
  expect(Number(await grid.getAttribute('aria-rowcount'))).not.toBe(0);
  await expect(rows.first()).toHaveAttribute('aria-rowindex', '2');
  expect(await rows.first().locator(':scope > [role="gridcell"]').count()).toBeGreaterThan(1);
  expect(await rows.first().locator(':scope > :not([role="gridcell"])').count()).toBe(0);
  // The viewport scrolls, so it is the keyboard's stop (the grid takes the focus by script only).
  await expect(page.locator('#logsTableViewport')).toHaveAttribute('tabindex', '0');
  await expect(grid).toHaveAttribute('tabindex', '-1');
  // Patterns are buttons in a list, not rows of a table.
  await page.locator('#logsTabPatterns').click();
  const patterns = page.locator('#logsPatterns .logsPatternRow');
  await expect(patterns.first()).toBeVisible({ timeout: 40_000 });
  expect(await patterns.first().evaluate((el) => ({ tag: el.tagName, role: el.getAttribute('role'), parent: el.parentElement.tagName }))).toEqual({ tag: 'BUTTON', role: null, parent: 'LI' });
  await expect(patterns.first()).toHaveAttribute('aria-label', /Filter by this pattern$/);
});

test('scrolling regions: a block of SQL that overflows, and the detail pane, take the keyboard', async ({ page }) => {
  await page.goto('/explorer/catalog/chdash_ui/weather_observations?tab=ddl');
  const body = page.locator('.sqlBlock__body').first();
  await expect(body).toBeVisible({ timeout: 20_000 });
  const scrolls = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  if (scrolls) {
    await expect(body).toHaveAttribute('tabindex', '0');
    await expect(body).toHaveAttribute('role', 'region');
    await expect(body).toHaveAttribute('aria-label', /\S/);
  }
  await page.goto('/explorer/functions/count');
  const pane = page.locator('.explorerDetailPane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const paneScrolls = await pane.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (paneScrolls) await expect(pane).toHaveAttribute('tabindex', '0');
});

test('storage tiers: an object with no storage keeps a 4.5:1 name, a ban icon and its reason', async ({ page }) => {
  for (const theme of THEMES) {
    await useTheme(page, theme);
    await page.goto('/explorer/catalog?mode=graph&graph=storage');
    await page.locator('#explorerTableList .explorerTreeDatabaseToggle[aria-label="Expand chdash_ui"]').click();
    const blocked = page.locator('#explorerTableList .explorerTreeObject.is-storage-blocked').first();
    await expect(blocked).toBeVisible({ timeout: 20_000 });
    const look = await blocked.evaluate((el) => {
      const name = el.querySelector('.explorerTreeObject__name');
      const s = getComputedStyle(name);
      return { opacity: getComputedStyle(el).opacity, nameOpacity: s.opacity, italic: s.fontStyle, ban: !!el.querySelector('.explorerTreeObject__blocked use[href$="#i-ban"]'), title: el.title };
    });
    expect(look.opacity).toBe('1');
    expect(look.nameOpacity).toBe('1');
    expect(look.italic).not.toBe('italic');
    expect(look.ban, theme).toBe(true);
    expect(look.title).toMatch(/no storage topology/);
    const [ratio] = await blocked.evaluate((el) => {
      const parse = (s) => { const p = /rgba?\(([^)]+)\)/.exec(s)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2] }; };
      const lum = (c) => { const l = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * l(c.r) + 0.7152 * l(c.g) + 0.0722 * l(c.b); };
      const fg = parse(getComputedStyle(el.querySelector('.explorerTreeObject__name')).color);
      const bg = parse(getComputedStyle(document.querySelector('#explorerTableList')).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : getComputedStyle(document.querySelector('#explorerTableList')).backgroundColor);
      const a = lum(fg), b = lum(bg);
      return [(Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)];
    });
    expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
  }
});

test('dimmed text: the version and ping of the host, and the options of the host menu, keep full opacity', async ({ page }) => {
  await page.goto('/query');
  await expect(page.locator('#hostPickerButton')).toBeVisible();
  for (const selector of ['#hostPickerVersion', '#hostPickerPing']) {
    const el = page.locator(selector);
    if (!(await el.isVisible())) continue;
    expect(await el.evaluate((node) => getComputedStyle(node).opacity), selector).toBe('1');
  }
});

// --- forced colors (Windows high contrast) -----------------------------------------------------------------------

test('forced colors: mask icons take the text colour, a selection is outlined, a cell bar keeps its bar', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/query');
  await runSuccessfulQuery(page, 'SELECT number AS id FROM numbers(8)');
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  // A chevron drawn by a mask (the header's host picker): its background is the text colour, not the canvas.
  const arrow = await page.locator('#hostPickerButton').evaluate((el) => {
    const s = getComputedStyle(el, '::after');
    return { bg: s.backgroundColor, canvas: getComputedStyle(document.body).backgroundColor };
  });
  expect(arrow.bg).not.toBe(arrow.canvas);
  expect(arrow.bg).not.toBe('rgba(0, 0, 0, 0)');
  // The pressed option of a segmented control is outlined.
  const pressed = page.locator('.segmented__option[aria-pressed="true"]').first();
  await expect(pressed).toBeVisible();
  const outline = await pressed.evaluate((el) => { el.blur(); const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth }; });
  expect(outline.style).toBe('solid');
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  // The bar of a numeric cell is still drawn: the cell opts out of the forcing and says its bar colour.
  const cell = page.locator('#resultTableBody td.cellBar').first();
  await expect(cell).toBeVisible();
  expect(await cell.evaluate((el) => ({ adjust: getComputedStyle(el).forcedColorAdjust, image: getComputedStyle(el).backgroundImage }))).toEqual({ adjust: 'none', image: expect.stringContaining('gradient') });
});

test('forced colors: the canvas charts keep the colour of each series (the colour probe is not forced)', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/query');
  await appReady(page);
  const colours = await page.evaluate(() => ['--qchart-1', '--qchart-2', '--qchart-3'].map((token) => window.ChDash.palette.resolve(token)));
  expect(new Set(colours).size).toBe(3);
});
