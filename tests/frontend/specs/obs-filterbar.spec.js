import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// The Observability filter bar (.obsFilterBar): Traces, Logs and Metrics lay
// their bar out the same way at every width. Left to right: the time range
// (first, one width), the field pickers, the free-text inputs, the view
// options, the secondary actions, then the primary submit at the right end;
// one range label format; the Metrics bar spans the catalog and the panels.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const VIEWS = ['traces', 'logs', 'metrics'];
const BAR = { traces: '#tracesForm', logs: '#logsForm', metrics: '#metricsToolbar' };
const PRIMARY = { traces: 'Search', logs: 'Search', metrics: 'Refresh' };
// An absolute hour inside the fixtures' days, valid on every view.
const HOUR = '?from=2026-09-19%2012:30:00&to=2026-09-19%2013:30:00';

async function features(request) {
  const version = await (await request.get('/api/version')).json();
  test.skip(!VIEWS.every((view) => version.features?.[view]?.enabled === true), 'needs traces, logs and metrics enabled');
}

async function openView(page, view, query = HOUR) {
  await page.goto(`/observability/${view}${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', view);
  const bar = page.locator(BAR[view]);
  await expect(bar).toBeVisible();
  // The view module has mounted the range picker (it builds the panel).
  await expect(bar.locator('.tracePicker--range > .timeRangePanel')).toHaveCount(1);
  // The first run is over: the primary is back to its idle look.
  await page.waitForLoadState('networkidle');
  await expect(bar.locator('.obsFilterBar__submit')).toBeEnabled();
  await expect(bar.locator('.obsFilterBar__submit')).not.toHaveClass(/is-loading/);
  return bar;
}

// Boxes of the bar and of its parts, in DOM order, relative to the bar.
function measure(bar) {
  return bar.evaluate((el) => {
    const origin = el.getBoundingClientRect();
    const box = (node) => {
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.left - origin.left), y: Math.round(r.top - origin.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(origin.right - r.right), bottom: Math.round(origin.bottom - r.bottom) };
    };
    const kinds = ['range', 'field', 'text', 'option', 'secondary', 'submit'];
    const parts = [...el.querySelectorAll(kinds.map((k) => `.obsFilterBar__${k}`).join(','))]
      .filter((node) => node.getClientRects().length && !node.classList.contains('obsFilterBar__info'))
      .map((node) => ({ kind: kinds.find((k) => node.classList.contains(`obsFilterBar__${k}`)), ...box(node) }));
    const range = el.querySelector('.tracePicker--range > .tracePicker__button');
    const submit = el.querySelector('.obsFilterBar__submit');
    const cs = getComputedStyle(el);
    const ss = getComputedStyle(submit);
    const rs = getComputedStyle(range);
    return {
      width: Math.round(origin.width), height: Math.round(origin.height), left: Math.round(origin.left),
      position: cs.position, padding: cs.padding, gap: cs.columnGap,
      parts,
      range: { ...box(range), text: range.textContent, truncated: range.scrollWidth > range.clientWidth + 1, font: `${rs.fontWeight} ${rs.fontSize} ${rs.fontFamily}` },
      submit: { ...box(submit), text: submit.textContent.trim(), type: submit.type, style: { radius: ss.borderRadius, font: `${ss.fontWeight} ${ss.fontSize} ${ss.fontFamily}`, background: ss.backgroundColor, color: ss.color, padding: ss.padding } },
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      barOverflow: el.scrollWidth - el.clientWidth,
    };
  });
}

// Reading order (rows top to bottom, then left to right) is the DOM order.
function expectReadingOrder(parts, label) {
  for (let i = 1; i < parts.length; i += 1) {
    const [a, b] = [parts[i - 1], parts[i]];
    const nextRow = b.y >= a.y + a.h - 1;
    const sameRowRight = Math.abs(b.y - a.y) <= 1 && b.x >= a.x + a.w - 1;
    expect(nextRow || sameRowRight, `${label}: ${a.kind} then ${b.kind}`).toBe(true);
  }
  const order = ['range', 'field', 'text', 'option', 'secondary', 'submit'];
  const ranks = parts.map((part) => order.indexOf(part.kind));
  expect(ranks, `${label}: range, pickers, inputs, options, secondary, primary`).toEqual([...ranks].sort((x, y) => x - y));
}

for (const width of [1440, 1280, 900, 768, 390]) {
  test(`filter bar: the same layout on Traces, Logs and Metrics at ${width} px`, async ({ page, request }) => {
    await features(request);
    await page.setViewportSize({ width, height: 900 });
    const bars = {};
    for (const view of VIEWS) bars[view] = await measure(await openView(page, view));

    for (const view of VIEWS) {
      const m = bars[view];
      const label = `${view} @ ${width}`;
      expect(m.overflow, label).toBeLessThanOrEqual(0);
      expect(m.barOverflow, label).toBeLessThanOrEqual(1);
      // The range comes first, at the bar's top-left padding corner, untruncated.
      expect(m.parts[0].kind, label).toBe('range');
      expect([m.range.x, m.range.y], label).toEqual([12, 8]);
      expect(m.range.truncated, label).toBe(false);
      expect(m.range.text, label).toBe('2026-09-19 12:30 → 13:30');
      // The primary submit comes last, at the bottom-right padding corner.
      expect(m.parts.at(-1).kind, label).toBe('submit');
      expect([m.submit.right, m.submit.bottom], label).toEqual([12, 9]);
      expect(m.submit.text, label).toBe(PRIMARY[view]);
      expect(m.submit.type, label).toBe('submit');
      expectReadingOrder(m.parts, label);
      // Every control of the bar is one height.
      for (const part of m.parts) expect(part.h, `${label} ${part.kind}`).toBe(31);
    }

    const [first, ...others] = VIEWS.map((view) => bars[view]);
    for (const [index, m] of others.entries()) {
      const label = `${VIEWS[index + 1]} vs traces @ ${width}`;
      // Same padding, gap and sticky behaviour; same range width; same primary.
      expect([m.position, m.padding, m.gap], label).toEqual([first.position, first.padding, first.gap]);
      // (Phones: the full bar width; the Traces view keeps a scrollbar gutter.)
      if (width > 760) expect(m.range.w, label).toBe(first.range.w);
      else expect(m.width - m.range.w, label).toBe(first.width - first.range.w);
      expect(m.range.font, label).toBe(first.range.font);
      expect([m.submit.w, m.submit.h], label).toEqual([first.submit.w, first.submit.h]);
      expect(m.submit.style, label).toEqual(first.submit.style);
      // The bars have as many rows (Traces holds more pickers than the
      // others, so phones stack it higher).
      if (width > 760) expect(m.height, label).toBe(first.height);
    }

    // Widths: one row above 1100 px, the lead and the tail a row each down
    // to 761 px, the range alone on its row (full width) on phones.
    const rows = (m) => new Set(m.parts.map((part) => part.y)).size;
    for (const view of VIEWS) {
      const m = bars[view];
      if (width > 1100) expect(rows(m), view).toBe(1);
      else if (width > 760) expect(rows(m), view).toBe(2);
      else {
        expect(m.range.w, view).toBe(m.width - 24);
        expect(m.parts.filter((part) => part.y === m.range.y), view).toHaveLength(1);
      }
      expect(m.position, view).toBe(width > 760 ? 'sticky' : 'static');
    }
    expect(bars.traces.range.w).toBe(width > 760 ? 264 : bars.traces.width - 24);
  });
}

test('filter bar: one range label format on every view', async ({ page, request }) => {
  await features(request);
  const cases = [
    // 24 h, the date once when the day does not change.
    ['?from=2026-09-19%2012:30:00&to=2026-09-19%2013:30:00', '2026-09-19 12:30 → 13:30'],
    // Seconds only under 10 minutes.
    ['?from=2026-09-19%2012:30:05&to=2026-09-19%2012:35:10', '2026-09-19 12:30:05 → 12:35:10'],
    ['?from=2026-09-19%2000:52:55&to=2026-09-19%2001:22:56', '2026-09-19 00:52 → 01:22'],
    // The date again when the day changes.
    ['?from=2026-09-19%2023:00:00&to=2026-09-20%2001:00:00', '2026-09-19 23:00 → 2026-09-20 01:00'],
    // Relative presets by name.
    ['?from=now-1h&to=now', 'Time range · Last 1 hour'],
  ];
  for (const view of VIEWS) {
    for (const [query, text] of cases) {
      const bar = await openView(page, view, query);
      const button = bar.locator('.tracePicker--range > .tracePicker__button');
      await expect(button, `${view} ${query}`).toHaveText(text);
      expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${view} ${query}`).toBe(true);
    }
  }
});

test('filter bar: the range panel is built per view with its own ids, inputs use the UI font', async ({ page, request }) => {
  await features(request);
  for (const view of VIEWS) {
    const bar = await openView(page, view);
    const button = bar.locator('.tracePicker--range > .tracePicker__button');
    await expect(button).toHaveAttribute('aria-controls', `${view}TimeRangePanel`);
    await button.click();
    const panel = page.locator(`#${view}TimeRangePanel`);
    await expect(panel).toBeVisible();
    for (const suffix of ['RangeStart', 'RangeEnd', 'TimeCalendar', 'CustomRangeApply', 'QuickRangeSearch', 'QuickRanges', 'TimeZone', 'RangeShiftBack', 'RangeZoomOut', 'RangeShiftForward']) {
      await expect(panel.locator(`#${view}${suffix}`), `${view}${suffix}`).toHaveCount(1);
    }
    await expect(panel.locator(`#${view}QuickRangesHeading`)).toHaveText('Quick ranges');
    // The panel hangs from its button, inside the window.
    const [panelBox, buttonBox] = await Promise.all([panel.boundingBox(), button.boundingBox()]);
    expect(Math.abs(panelBox.x - buttonBox.x)).toBeLessThanOrEqual(1);
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(page.viewportSize().width);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    // Free-text inputs use the pickers' sans font, never monospace.
    const fonts = await bar.locator('.obsFilterBar__input').evaluateAll((inputs) => inputs.map((input) => getComputedStyle(input).fontFamily));
    for (const font of fonts) expect(font, view).not.toMatch(/mono/i);
  }
  // Only one copy of each id in the document, with all three views shown.
  const duplicates = await page.evaluate(() => {
    const seen = new Map();
    for (const node of document.querySelectorAll('[id]')) seen.set(node.id, (seen.get(node.id) || 0) + 1);
    return [...seen].filter(([, count]) => count > 1).map(([id]) => id);
  });
  expect(duplicates).toEqual([]);
});

test('filter bar: Metrics spans the catalog and the panels; secondary actions sit before the primary', async ({ page, request }) => {
  await features(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const bar = await openView(page, 'metrics');
  const [barBox, sidebar, main] = await Promise.all([bar.boundingBox(), page.locator('#metricsSidebar').boundingBox(), page.locator('.metricsMain').boundingBox()]);
  expect(barBox.x).toBe(0);
  expect(barBox.width).toBe(1440);
  expect(sidebar.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  expect(main.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 0.5);
  // The range sits above the catalog, not to its right.
  const range = await bar.locator('.tracePicker--range > .tracePicker__button').boundingBox();
  expect(range.x).toBeLessThan(sidebar.x + sidebar.width);

  // Add panel (Metrics) and Live (Logs): one secondary style, right before the primary.
  const secondary = {};
  for (const view of ['metrics', 'logs']) {
    const b = await openView(page, view);
    secondary[view] = await b.locator('.obsFilterBar__actions').evaluate((el) => {
      const buttons = [...el.children];
      const s = getComputedStyle(buttons[0]);
      return {
        classes: buttons.map((button) => button.classList.contains('obsFilterBar__submit') ? 'primary' : button.classList.contains('obsFilterBar__secondary') ? 'secondary' : 'other'),
        height: Math.round(buttons[0].getBoundingClientRect().height),
        style: [s.borderRadius, s.fontSize, s.fontWeight, s.fontFamily, s.paddingLeft],
      };
    });
  }
  expect(secondary.metrics.classes).toEqual(['secondary', 'primary']);
  expect(secondary.logs.classes).toEqual(['secondary', 'primary']);
  expect(secondary.logs.height).toBe(31);
  expect(secondary.logs.style).toEqual(secondary.metrics.style);
  // Live is a toggle: pressed while the tail runs.
  const live = page.locator('#logsLiveButton');
  await expect(live).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#logsForm .obsFilterBar__actions > #logsLiveButton')).toHaveCount(1);
});

test('filter bar: the primary re-runs the search on every view', async ({ page, request }) => {
  await features(request);
  const isRun = {
    traces: (url) => /\/api\/traces\/search/.test(url),
    logs: (url) => /\/api\/logs\/(search|histogram)/.test(url),
    metrics: (url) => /\/api\/metrics\/catalog/.test(url),
  };
  for (const view of VIEWS) {
    const bar = await openView(page, view);
    await page.waitForLoadState('networkidle');
    const request = page.waitForRequest((r) => isRun[view](r.url()), { timeout: 30_000 });
    await bar.locator('.obsFilterBar__submit').click();
    await request;
  }
});

test('the quick and recently used ranges fit the time range panel without scrolling', async ({ page, request }) => {
  await features(request);
  await page.addInitScript(() => {
    try { localStorage.setItem('chdash.traceTimeRanges.v1', JSON.stringify([{ from: 'now-45m', to: 'now' }, { from: 'now-2h', to: 'now-1h' }])); } catch { /* storage may be unavailable */ }
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
    for (const view of VIEWS) {
      await page.goto(`/observability/${view}`);
      const button = page.locator(`${BAR[view]} .tracePicker--range .tracePicker__button`);
      await button.click();
      const list = page.locator(`#${view}QuickRanges`);
      await expect(list.locator('[data-group="quick"] .timeRangeList__item').first()).toBeVisible();
      await expect(list.locator('.timeRangeList__heading')).toHaveText(['Recently used', 'Quick ranges']);
      const box = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
      expect(box.scroll, `${view} at ${width} px`).toBeLessThanOrEqual(box.client + 1);
      await page.keyboard.press('Escape');
    }
  }
});
