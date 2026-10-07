import { test, expect } from '@playwright/test';
import { runSuccessfulQuery } from '../helpers/app.js';
import { nestedTrace, routeTrace } from '../helpers/trace-mocks.js';

// Cross-cutting foundations (docs/ui-foundations.md): guards that hold on
// every page, so a later page or component cannot bring the old drift back.
//  - type: no element computes Arial (form controls inherit the page font),
//    and code / pre / kbd / samp are the mono token at the size around them;
//  - tabs: every row of sections is the one underline row (.contentTabs);
//  - contrast: the header's version badge and the size maps' labels keep
//    4.5:1 in both themes;
//  - dates: the range buttons read through ns.format.range, never ISO;
//  - headings: one h1 per page, an h2 per Observability view and per card.

const HOUR = '?from=2026-09-12%2012:30:00&to=2026-09-12%2013:30:00';

// Each page and a state that shows its type, its tab rows and its code.
const PAGES = {
  query: async (page) => {
    await page.goto('/query');
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 15_000 });
    await runSuccessfulQuery(page, 'SELECT number AS n, toString(number) AS s FROM numbers(5)');
  },
  explorer: async (page) => {
    await page.goto('/explorer');
    await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
  },
  ddl: async (page) => {
    await page.goto('/explorer/chdash_ui/weather_observations?tab=ddl');
    await expect(page.locator('#explorerDetailContent pre, #explorerDetailContent code').first()).toBeVisible({ timeout: 15_000 });
  },
  functions: async (page) => {
    await page.goto('/explorer/_functions/arrayMap');
    await expect(page.locator('#explorerFunctionDetailName')).toHaveText(/arrayMap/, { timeout: 15_000 });
  },
  traces: async (page) => {
    await page.goto(`/observability/traces${HOUR}`);
    await expect(page.locator('#tracesForm')).toBeVisible({ timeout: 15_000 });
  },
  trace: async (page) => {
    const trace = nestedTrace();
    await routeTrace(page, trace);
    await page.goto(`/observability/traces/${trace.trace_id}`);
    await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(trace.spans.length, { timeout: 20_000 });
  },
  logs: async (page) => {
    await page.goto(`/observability/logs${HOUR}`);
    await expect(page.locator('#logsForm')).toBeVisible({ timeout: 15_000 });
  },
  metrics: async (page) => {
    await page.goto(`/observability/metrics${HOUR}`);
    await expect(page.locator('#metricsToolbar')).toBeVisible({ timeout: 15_000 });
  },
  system: async (page) => {
    await page.goto('/system');
    await expect(page.locator('#systemTopology')).toBeVisible({ timeout: 20_000 });
  },
  queries: async (page) => {
    await page.goto('/system/queries');
    await expect(page.locator('#systemQueriesTable')).toBeVisible({ timeout: 20_000 });
  },
  disks: async (page) => {
    await page.goto('/system/disks');
    await expect(page.locator('.systemDiskDb').first()).toBeAttached({ timeout: 20_000 });
  },
};

const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('no element computes Arial, and code / pre / kbd / samp are the mono token', async ({ page }) => {
  test.setTimeout(150_000);
  for (const [name, show] of Object.entries(PAGES)) {
    await show(page);
    await settle(page);
    const found = await page.evaluate(() => {
      const first = (family) => family.split(',')[0].trim().replace(/^["']|["']$/g, '');
      const key = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].slice(0, 2).join('.')}`;
      const arial = [];
      const code = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg') || !el.getClientRects().length) continue;
        const family = getComputedStyle(el).fontFamily;
        if (/^arial$/i.test(first(family))) arial.push(key(el));
        if (el.matches('code, pre, kbd, samp')) {
          if (first(family) !== 'IBM Plex Mono') code.push(`${key(el)} ${family}`);
        }
      }
      return { arial: arial.slice(0, 12), code: code.slice(0, 12) };
    });
    expect(found.arial, `${name}: Arial`).toEqual([]);
    expect(found.code, `${name}: code`).toEqual([]);
  }
});

test('every row of sections is the one underline row (tabs), never a pill row', async ({ page }) => {
  test.setTimeout(120_000);
  for (const name of ['explorer', 'ddl', 'functions', 'traces', 'trace', 'logs', 'metrics', 'system']) {
    await PAGES[name](page);
    await settle(page);
    // A row is a tablist, or a row of links to pages of their own (Observability, System): same look.
    const rows = await page.evaluate(() => [...document.querySelectorAll('[role="tablist"], .contentTabs[role="group"]')].filter((list) => list.getClientRects().length && getComputedStyle(list).visibility !== 'hidden').map((list) => {
      const tabs = [...list.querySelectorAll('[role="tab"], a.contentTabs__tab')].filter((tab) => tab.getClientRects().length);
      const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('aria-current') === 'page');
      const look = (tab) => {
        const cs = getComputedStyle(tab);
        return { bg: cs.backgroundColor, radius: cs.borderTopLeftRadius, bottom: `${cs.borderBottomWidth} ${cs.borderBottomStyle}`, top: cs.borderTopWidth, shadow: cs.boxShadow };
      };
      return {
        id: list.id || list.className,
        classes: [list.classList.contains('contentTabs'), tabs.every((tab) => tab.classList.contains('contentTabs__tab'))],
        selected: selected ? look(selected) : null,
        other: tabs.filter((tab) => tab !== selected).map((tab) => getComputedStyle(tab).borderBottomColor),
      };
    }));
    expect(rows.length, name).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.classes, `${name} ${row.id}`).toEqual([true, true]);
      // The selected tab: a 2 px underline, no pill (no fill, no frame, no radius).
      expect(row.selected, `${name} ${row.id}`).toEqual({ bg: 'rgba(0, 0, 0, 0)', radius: '0px', bottom: '2px solid', top: '0px', shadow: 'none' });
      for (const color of row.other) expect(color, `${name} ${row.id}`).toBe('rgba(0, 0, 0, 0)');
    }
  }
});

// Effective contrast of each element's text over what it is drawn on (the
// backgrounds of its ancestors composed, opacity folded into the text).
async function contrasts(page, selector) {
  return page.evaluate((selector) => {
    const parse = (text) => {
      let m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)/.exec(text);
      if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
      m = /color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+))?\)/.exec(text);
      if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] == null ? 1 : +m[4] };
      return null;
    };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = (c) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.getClientRects().length || !el.textContent.trim() || getComputedStyle(el).visibility === 'hidden') continue;
      const layers = [];
      let alpha = 1;
      for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
        const cs = getComputedStyle(node);
        alpha *= Number(cs.opacity);
        const bg = parse(cs.backgroundColor);
        if (bg && bg.a > 0) layers.push(bg);
        if (bg && bg.a >= 1) break;
      }
      let base = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) base = over(layer, base);
      const color = parse(getComputedStyle(el).color);
      const text = over({ ...color, a: color.a * alpha }, base);
      const [hi, lo] = [lum(text), lum(base)].sort((a, b) => b - a);
      out.push({ text: el.textContent.trim().slice(0, 24), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 });
    }
    return out;
  }, selector);
}

for (const theme of ['dark', 'light']) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test(`the version badge and the size map labels keep 4.5:1 (${theme})`, async ({ page }) => {
      test.setTimeout(120_000);
      const labels = '.explorerTreemap__label:not(.is-hidden) > *:not([hidden]), .explorerStorageStrip__label, .explorerTreemapLegend__item > span:not(.explorerTreemapLegend__swatch), .explorerTreemapFootnote';
      const states = [
        ['all databases', PAGES.explorer, '.explorerDatabasesOverview .explorerTreemapBand'],
        ['columns', async (p) => { await p.goto('/explorer/chdash_ui/weather_observations'); }, '#explorerColumnTreemap .explorerTreemap__node'],
        ['system database', async (p) => { await p.goto('/explorer/system'); }, '#explorerDatabaseStorage .explorerTreemapBand'],
        ['overview', PAGES.system, '#systemDatabaseMap .explorerTreemap__node, #systemDatabaseStrip .explorerStorageStrip__segment'],
        ['disks', PAGES.disks, '.systemDiskDb .explorerStorageStrip__segment'],
      ];
      for (const [name, show, ready] of states) {
        await show(page);
        await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#versionBadge')).not.toHaveText('--');
        await settle(page);
        const measured = [...await contrasts(page, '#versionBadge'), ...await contrasts(page, labels)];
        expect(measured.length, name).toBeGreaterThan(1);
        expect(measured.filter((item) => item.ratio < 4.5), name).toEqual([]);
      }
    });
  });
}

test('the range buttons read the shared range format (Sep 12 12:30 → 13:30), never ISO', async ({ page }) => {
  await PAGES.traces(page);
  const button = page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button');
  await expect(button).toHaveText('Sep 12 12:30 → 13:30');
  const shared = await page.evaluate(() => window.ChDash.format.range(new Date(2026, 8, 12, 12, 30).getTime(), new Date(2026, 8, 12, 13, 30).getTime()));
  await expect(button).toHaveText(shared);
  // Across midnight the date repeats; under ten minutes the seconds show.
  expect(await page.evaluate(() => [
    window.ChDash.format.range(new Date(2026, 8, 11, 23, 0).getTime(), new Date(2026, 8, 12, 1, 0).getTime()),
    window.ChDash.format.range(new Date(2026, 8, 12, 12, 30, 5).getTime(), new Date(2026, 8, 12, 12, 35, 10).getTime()),
    window.ChDash.format.range(new Date(2026, 8, 12, 12, 30, 5, 120).getTime(), new Date(2026, 8, 12, 12, 30, 5, 460).getTime(), { precision: 'ms' }),
    window.ChDash.format.range(new Date(2026, 8, 12).getTime(), new Date(2026, 8, 14).getTime(), { precision: 'day' }),
  ])).toEqual(['Sep 11 23:00 → Sep 12 01:00', 'Sep 12 12:30:05 → 12:35:10', 'Sep 12 12:30:05.120 → 12:30:05.460', 'Sep 12 → Sep 14']);
  // The System Overview's performance range too.
  await page.goto(`/system${HOUR}`);
  await expect(page.locator('#systemPerfRangeButton')).toHaveText('Sep 12 12:30 → 13:30', { timeout: 20_000 });
});

test('a line of the chrome holds two " · " separators at most (the rest is in its tooltip)', async ({ page }) => {
  test.setTimeout(150_000);
  for (const [name, show] of Object.entries(PAGES)) {
    await show(page);
    await settle(page);
    const lines = await page.evaluate(() => {
      const many = (el) => ((el.innerText || '').match(/ · /g) || []).length >= 3;
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        // Data (tables, code, tooltips) is not chrome.
        if (!el.getClientRects().length || el.closest('svg, table, pre, code, [role=tooltip], .dataList')) continue;
        const display = getComputedStyle(el).display;
        if (display === 'inline' || display === 'contents') continue;
        const text = (el.innerText || '').trim();
        if (!text || text.includes('\n') || !many(el)) continue;
        if ([...el.children].some((child) => many(child) && getComputedStyle(child).display !== 'inline')) continue;
        out.push(`${el.id || el.className}: ${text.slice(0, 80)}`);
      }
      return out;
    });
    expect(lines, name).toEqual([]);
  }
});

test('one h1 per page, an h2 per Observability view and for the Explorer card', async ({ page }) => {
  for (const path of ['/query', '/explorer', '/system']) {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1);
  }
  for (const view of ['traces', 'logs', 'metrics']) {
    await page.goto(`/observability/${view}`);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText('Observability');
    const heading = page.locator(`#${view}Workspace > h2`).first();
    await expect(heading).toHaveText(view[0].toUpperCase() + view.slice(1));
  }
  await page.goto('/explorer/chdash_ui/weather_observations');
  await expect(page.locator('h2#explorerDetailName')).toHaveText('chdash_ui.weather_observations', { timeout: 15_000 });
  await page.goto('/explorer/_functions/arrayMap');
  await expect(page.locator('h2#explorerFunctionDetailName')).toContainText('arrayMap', { timeout: 15_000 });
});
