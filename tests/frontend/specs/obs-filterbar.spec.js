import { test, expect } from '@playwright/test';
import { IS_RUN, installObservers } from '../helpers/observability.js';

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
const PRIMARY = { traces: 'Search', logs: 'Search', metrics: 'Search' };
// An absolute hour of the rich fixture day (tests/README.md, "Rich OTel
// dataset"): traces, logs and metrics on every view, ~22 k spans
// rather than the bulk fixture's millions.
const HOUR = '?from=2026-09-12%2012:30:00&to=2026-09-12%2013:30:00';

async function features(request) {
  const version = await (await request.get('/api/version')).json();
  test.skip(!VIEWS.every((view) => version.features?.[view]?.enabled === true), 'needs traces, logs and metrics enabled');
}

async function openView(page, view, query = HOUR) {
  const firstRun = page.waitForResponse((response) => IS_RUN[view](response.url()), { timeout: 30_000 });
  await page.goto(`/observability/${view}${query}`);
  await expect(page.locator('html')).toHaveAttribute('data-obs-view', view);
  const bar = page.locator(BAR[view]);
  await expect(bar).toBeVisible();
  // The view module has mounted the range picker (it builds the panel).
  await expect(bar.locator('.tracePicker--range > .timeRangePanel')).toHaveCount(1);
  // The first run is over: the primary is back to its idle look.
  await firstRun;
  await expect(bar.locator('.obsFilterBar__submit')).toBeAttached();
  await unfold(bar);
  await expect(bar.locator('.obsFilterBar__submit')).toBeEnabled();
  await expect(bar.locator('.obsFilterBar__submit')).not.toHaveClass(/is-loading/);
  return bar;
}

// On a phone (600 px and below) the bar starts folded into its summary line:
// unfold it.
async function unfold(bar) {
  const summary = bar.locator('.obsFilterSummary');
  if (await summary.isVisible() && (await summary.getAttribute('aria-expanded')) === 'false') await summary.click();
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
    const summary = el.querySelector('.obsFilterSummary');
    const cs = getComputedStyle(el);
    const ss = getComputedStyle(submit);
    const rs = getComputedStyle(range);
    return {
      width: Math.round(origin.width), height: Math.round(origin.height), left: Math.round(origin.left),
      position: cs.position, padding: cs.padding, gap: cs.columnGap,
      // The phone summary line, above the bar's parts when it shows.
      top: summary && summary.getClientRects().length ? box(summary).y + box(summary).h + parseFloat(cs.rowGap) : 8,
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
      expect([m.range.x, m.range.y], label).toEqual([12, m.top]);
      if (width > 600) expect(m.top, label).toBe(8);
      expect(m.range.truncated, label).toBe(false);
      expect(m.range.text, label).toBe('Sep 12 12:30 → 13:30');
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
    [HOUR, 'Sep 12 12:30 → 13:30'],
    // Seconds only under 10 minutes.
    ['?from=2026-09-12%2012:30:05&to=2026-09-12%2012:35:10', 'Sep 12 12:30:05 → 12:35:10'],
    ['?from=2026-09-12%2000:52:55&to=2026-09-12%2001:22:56', 'Sep 12 00:52 → 01:22'],
    // The date again when the day changes.
    ['?from=2026-09-11%2023:00:00&to=2026-09-12%2001:00:00', 'Sep 11 23:00 → Sep 12 01:00'],
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

  // Add panel (Metrics): the secondary style, right before the primary; Logs
  // has no secondary action (no Live: nothing refreshes on a timer).
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
  expect(secondary.metrics.height).toBe(31);
  expect(secondary.logs.classes).toEqual(['primary']);
  await expect(page.locator('#logsLiveButton, #logsForm .obsFilterBar__toggleDot')).toHaveCount(0);
});

test('filter bar: the primary re-runs the search on every view', async ({ page, request }) => {
  await features(request);
  for (const view of VIEWS) {
    const bar = await openView(page, view);
    const request = page.waitForRequest((r) => IS_RUN[view](r.url()), { timeout: 30_000 });
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
      await expect(page.locator(BAR[view])).toBeVisible();
      await unfold(page.locator(BAR[view]));
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

// Phones (600 px and below): content first. The bar folds into one summary
// line (range, filter count), a search folds it again; the overview charts
// start folded to their head.
test.describe('filter bar on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('filter bar on a phone: one summary line "<range> · N filters" that unfolds the bar; the charts start folded', async ({ page, request }) => {
    await features(request);
    for (const view of VIEWS) {
      const firstRun = page.waitForResponse((response) => IS_RUN[view](response.url()), { timeout: 30_000 });
      await page.goto(`/observability/${view}${HOUR}${view === 'logs' ? '&service=api_service&level=13' : ''}`);
      await firstRun;
      const bar = page.locator(BAR[view]);
      const summary = bar.locator('.obsFilterSummary');
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect(summary).toContainText('Sep 12 12:30 → 13:30');
      if (view === 'logs') await expect(summary).toContainText(/· [2-9] filters/);
      else await expect(summary).not.toContainText('filter');
      // Folded: the summary is the bar, one line, the content right under it.
      await expect(bar.locator('.tracePicker--range .tracePicker__button')).toBeHidden();
      const box = await bar.boundingBox();
      expect(box.height, view).toBeLessThanOrEqual(60);
      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      await expect(bar.locator('.tracePicker--range .tracePicker__button')).toBeVisible();
      await expect(bar.locator('.obsFilterBar__submit')).toBeVisible();
      // A search folds it again.
      await bar.locator('.obsFilterBar__submit').click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
    }
    // The overview charts start folded to their head; the chevron unfolds one.
    await page.goto(`/observability/traces${HOUR}`);
    await expect(page.locator('#tracesResults .traceResultItem').first()).toBeVisible({ timeout: 30_000 });
    const cards = page.locator('#traceAnalyticsGrid .chartCard');
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all()) {
      await expect(card).toHaveClass(/is-folded/);
      await expect(card.locator('.chartCard__body')).toBeHidden();
      expect((await card.boundingBox()).height).toBeLessThanOrEqual(60);
    }
    const first = cards.first();
    await first.locator('.chartCard__fold').click();
    await expect(first.locator('.chartCard__fold')).toHaveAttribute('aria-expanded', 'true');
    await expect(first.locator('.chartCore__canvas')).toBeVisible();
    await expect.poll(async () => (await first.locator('.chartCore__canvas').boundingBox())?.width || 0).toBeGreaterThan(200);
    await page.goto(`/observability/logs${HOUR}`);
    await expect(page.locator('#logsHistogramCard')).toHaveClass(/is-folded/);
    await expect(page.locator('#logsHistogram')).toBeHidden();
    // A wide window shows everything: no summary, no fold.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#logsForm .obsFilterSummary')).toBeHidden();
    await expect(page.locator('#logsHistogram')).toBeVisible();
    await expect(page.locator('#logsForm .tracePicker--range .tracePicker__button')).toBeVisible();
  });
});

// Audit round 2: the same slots on the three bars (a Service picker and a
// search field on Metrics too); the pickers keep their place between the
// Traces tabs; on a phone the selected tab of the nav row shows whole.
test('filter bar: Metrics holds the slots of Logs (Service picker, search field), "Search" as its primary', async ({ page, request }) => {
  await features(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const kinds = {};
  for (const view of ['logs', 'metrics']) {
    const bar = await openView(page, view);
    kinds[view] = (await measure(bar)).parts.map((part) => part.kind);
    await expect(bar.locator('.obsFilterBar__field .tracePicker__button').first()).toHaveText(/^Service · /);
    await expect(bar.locator('.obsFilterBar__search .obsFilterBar__searchIcon')).toHaveCount(1);
  }
  // Metrics' Add panel (a secondary action) sits right before Search; Logs has none (no Live).
  expect(kinds.logs).not.toContain('secondary');
  expect(kinds.metrics.slice(-2)).toEqual(['secondary', 'submit']);
  expect(kinds.metrics.filter((kind) => kind !== 'secondary')).toEqual(kinds.logs.filter((kind, index, all) => !(kind === 'field' && all.indexOf('field') !== index) && !(kind === 'text' && all.indexOf('text') !== index)));
  await expect(page.locator('#metricsToolbar #metricsSearch')).toHaveAttribute('placeholder', /Search metrics/);
  await expect(page.locator('#metricsSidebar #metricsSearch')).toHaveCount(0);
  await expect(page.locator('#metricsToolbar .obsFilterBar__submit')).toHaveText('Search');
});

test('filter bar: the Traces pickers keep their place on Search, Services and the map', async ({ page, request }) => {
  await features(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const places = {};
  for (const tab of ['search', 'services', 'map']) {
    await page.goto(`/observability/traces${HOUR}&tab=${tab}`);
    const bar = page.locator('#tracesForm');
    await expect(bar).toBeVisible();
    await expect(bar.locator('.tracePicker--range > .timeRangePanel')).toHaveCount(1);
    places[tab] = await bar.locator('.obsFilterBar__field').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.width)]; }));
  }
  expect(places.services).toEqual(places.search);
  expect(places.map).toEqual(places.search);
});

test.describe('the Observability nav row on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('nav row on a phone: the selected tab shows whole, clear of the faded edges', async ({ page, request }) => {
    await features(request);
    for (const tab of ['search', 'services', 'map']) {
      await page.goto(`/observability/traces${HOUR}&tab=${tab}`);
      const nav = page.locator('#obsNav');
      const active = nav.locator('#tracesTabs [aria-selected="true"]');
      await expect(active).toBeVisible();
      await expect.poll(() => nav.evaluate((el) => {
        const sel = el.querySelector('#tracesTabs [aria-selected="true"]').getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const fade = parseFloat(getComputedStyle(el).getPropertyValue('--edge-fade')) || 24;
        const clearEnd = !el.classList.contains('has-edge-end') || sel.right <= box.right - fade + 1;
        const clearStart = !el.classList.contains('has-edge-start') || sel.left >= box.left + fade - 1;
        return sel.left >= box.left - 0.5 && sel.right <= box.right + 0.5 && clearEnd && clearStart;
      }), tab).toBe(true);
    }
    // The last tab: the row scrolled to its very end, no fade left on it.
    await expect(page.locator('#obsNav')).not.toHaveClass(/has-edge-end/);
  });
});

// ---------------------------------------------------------------------------
// One filter bar for Observability and System (user, 2026-10-04 evening):
// the System sections (Overview, Queries, Disks) carry the same bar
// (ns.filterBar, app_ui_filterbar.js) under their tab row: the time range
// first on the left (the same picker), the section's filters as the same
// "Label · Value" pickers (Queries: Kind, Errors, User, Order by; Hide
// ChDash a toggle chip), then at the right end the action: Observability's "Search", System's refresh icon button
// (a change applies at once). Same height, padding, gaps and phone fold.

const SYSTEM = { overview: '#systemBar-overview', queries: '#systemBar-queries', disks: '#systemBar-disks' };
const SYSTEM_RANGE = { overview: '#systemPerfRangeButton', queries: '#systemQueriesRangeButton', disks: '#systemDisksRangeButton' };

async function systemFeatures(request) {
  const version = await (await request.get('/api/version')).json();
  const system = version.features?.system;
  test.skip(!(system?.enabled && system?.top_queries), 'needs the System page with Queries');
}

async function openSystem(page, section, query = '') {
  await page.goto(`/system${section === 'overview' ? '' : `/${section}`}${query}`);
  const bar = page.locator(SYSTEM[section]);
  await expect(bar).toBeVisible({ timeout: 20_000 });
  await expect(bar.locator('.tracePicker--range > .timeRangePanel')).toHaveCount(1);
  await unfold(bar);
  await expect(bar.locator('.obsFilterBar__submit')).toBeVisible();
  return bar;
}

for (const width of [1440, 1280, 900, 768]) {
  test(`one filter bar: the six views of Observability and System share its geometry at ${width} px`, async ({ page, request }) => {
    await features(request);
    await systemFeatures(request);
    await page.setViewportSize({ width, height: 900 });
    const bars = {};
    for (const view of VIEWS) bars[view] = await measure(await openView(page, view));
    for (const section of Object.keys(SYSTEM)) bars[section] = await measure(await openSystem(page, section));
    const first = bars.traces;
    for (const [name, m] of Object.entries(bars)) {
      const label = `${name} @ ${width}`;
      expect(m.overflow, label).toBeLessThanOrEqual(0);
      expect(m.barOverflow, label).toBeLessThanOrEqual(1);
      // The time range first, at the top-left padding corner; the action
      // last, at the bottom-right one; every control one height.
      expect(m.parts[0].kind, label).toBe('range');
      expect([m.range.x, m.range.y], label).toEqual([12, 8]);
      expect(m.range.truncated, label).toBe(false);
      expect(m.parts.at(-1).kind, label).toBe('submit');
      expect([m.submit.right, m.submit.bottom], label).toEqual([12, 9]);
      expectReadingOrder(m.parts, label);
      for (const part of m.parts) expect(part.h, `${label} ${part.kind}`).toBe(31);
      // Same padding, gap, height (rows) and range width as Traces.
      expect([m.padding, m.gap], label).toEqual([first.padding, first.gap]);
      expect(m.height, label).toBe(first.height);
      expect(m.range.w, label).toBe(first.range.w);
      expect(m.range.font, label).toBe(first.range.font);
      expect(m.submit.h, label).toBe(first.submit.h);
      // One bar row under the tab row, full width.
      expect(m.left, label).toBe(0);
    }
    // The action: Search on Observability (the queries run on demand), a
    // square refresh icon button on System (a change applies at once).
    for (const section of Object.keys(SYSTEM)) {
      const m = bars[section];
      expect(m.submit.text, section).toBe('');
      expect(m.submit.w, section).toBe(m.submit.h);
    }
    for (const view of VIEWS) expect(bars[view].submit.text, view).toBe('Search');
    // The parts of each System bar, left to right.
    expect(bars.overview.parts.map((part) => part.kind)).toEqual(['range', 'submit']);
    expect(bars.queries.parts.map((part) => part.kind)).toEqual(['range', 'field', 'field', 'field', 'field', 'field', 'field', 'option', 'submit']);
    expect(bars.disks.parts.map((part) => part.kind)).toEqual(['range', 'submit']);
  });
}

test('one filter bar: the time range leaves the System tab row; the bar sits under it, as on Observability', async ({ page, request }) => {
  await features(request);
  await systemFeatures(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const section of Object.keys(SYSTEM)) {
    const bar = await openSystem(page, section);
    await expect(page.locator('.systemPage__nav .tracePicker, .systemPage__nav button:not([role="tab"])')).toHaveCount(0);
    const [nav, box] = await Promise.all([page.locator('.systemPage__nav').boundingBox(), bar.boundingBox()]);
    expect(Math.abs(box.y - (nav.y + nav.height)), section).toBeLessThanOrEqual(1);
    await expect(bar.locator(`.obsFilterBar__range ${SYSTEM_RANGE[section]}`)).toBeVisible();
  }
  // The same place as Observability's bar.
  const system = await page.locator(SYSTEM.disks).boundingBox();
  await openView(page, 'logs');
  const logs = await page.locator(BAR.logs).boundingBox();
  expect(Math.abs(system.y - logs.y)).toBeLessThanOrEqual(1);
  expect(system.height).toBe(logs.height);
});

test('one filter bar: the System Queries filters live in the bar and round-trip through the address', async ({ page, request }) => {
  await systemFeatures(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  const query = '?from=now-6h&to=now&sort=calls&kind=Insert&errors=without&user=chdash_runner&hide=0';
  const bar = await openSystem(page, 'queries', query);
  const button = (cls) => bar.locator(`.${cls} .tracePicker__button`);
  await expect(bar.locator('#systemQueriesRangeButton')).toHaveText('Time range · Last 6 hours');
  await expect(button('systemQueries__kindPicker')).toHaveText('Kind · INSERT');
  await expect(button('systemQueries__errorsPicker')).toHaveText('Errors · Without errors');
  await expect(button('systemQueries__userPicker')).toHaveText(/^User · chdash_runner/);
  await expect(button('systemQueries__orderPicker')).toHaveText('Order by · Calls');
  await expect(bar.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'false');
  // Nothing of them stays in the section's body.
  await expect(page.locator('#systemPanel-queries .systemQueries > .tracePicker, #systemPanel-queries #systemQueriesFilters')).toHaveCount(0);
  // A change applies at once and writes the address; Back restores it.
  const asked = page.waitForRequest((r) => r.url().includes('/api/system/queries?') && new URL(r.url()).searchParams.get('kind') === 'Select');
  await button('systemQueries__kindPicker').click();
  await bar.locator('.systemQueries__kindPicker .tracePicker__option[data-value="Select"]').click();
  await asked;
  await expect.poll(() => new URL(page.url()).searchParams.get('kind')).toBe('Select');
  await bar.locator('#systemQueriesHide').click();
  await expect.poll(() => new URL(page.url()).searchParams.get('hide')).toBeNull();
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({ from: 'now-6h', to: 'now', sort: 'calls', kind: 'Select', errors: 'without', user: 'chdash_runner' });
  // A reload reads every one back into the bar.
  await page.reload();
  await expect(bar.locator('.tracePicker--range > .timeRangePanel')).toHaveCount(1);
  await expect(button('systemQueries__kindPicker')).toHaveText('Kind · SELECT');
  await expect(button('systemQueries__errorsPicker')).toHaveText('Errors · Without errors');
  await expect(button('systemQueries__orderPicker')).toHaveText('Order by · Calls');
  await expect(bar.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'true');
  await page.goBack();
  await expect(bar.locator('#systemQueriesHide')).toHaveAttribute('aria-pressed', 'false');
  await expect(button('systemQueries__kindPicker')).toHaveText('Kind · SELECT');
  // The Overview and Disks keep their range in the address too.
  const overview = await openSystem(page, 'overview', '?from=now-3h&to=now');
  await expect(overview.locator('#systemPerfRangeButton')).toHaveText('Time range · Last 3 hours');
  const disks = await openSystem(page, 'disks', '?from=now-24h&to=now');
  await expect(disks.locator('#systemDisksRangeButton')).toHaveText('Time range · Last 24 hours');
  // The refresh button reloads the section (the form's action).
  const refreshed = page.waitForRequest((r) => r.url().includes('/api/system/disks?'));
  await disks.locator('#systemRefresh-disks').click();
  await refreshed;
  await expect(page).toHaveURL(/\/system\/disks\?from=now-24h&to=now$/);
});

test.describe('one filter bar on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('one filter bar on a phone: each System bar folds into "<range> · N filters"; it unfolds, and the refresh folds it again', async ({ page, request }) => {
    await features(request);
    await systemFeatures(request);
    const cases = [
      ['overview', '', 'Last 1 hour', ''],
      ['disks', '?from=now-24h&to=now', 'Last 24 hours', ''],
      // Kind, User and Hide ChDash off are filters; Order by is not.
      ['queries', '?kind=Select&user=chdash_runner&hide=0&sort=calls', 'Last 1 hour', ' · 3 filters'],
    ];
    for (const [section, query, range, count] of cases) {
      await page.goto(`/system${section === 'overview' ? '' : `/${section}`}${query}`);
      const bar = page.locator(SYSTEM[section]);
      const summary = bar.locator('.obsFilterSummary');
      await expect(summary).toBeVisible({ timeout: 20_000 });
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      await expect(summary.locator('.foldSummary__text')).toHaveText(range);
      await expect(summary.locator('.foldSummary__meta')).toHaveText(count);
      // Folded: one line, the section right under it.
      await expect(bar.locator(SYSTEM_RANGE[section])).toBeHidden();
      expect((await bar.boundingBox()).height, section).toBeLessThanOrEqual(60);
      const style = await summary.evaluate((el) => { const s = getComputedStyle(el); return [s.height, s.fontSize, s.borderRadius, s.paddingLeft]; });
      await summary.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'true');
      await expect(bar.locator(SYSTEM_RANGE[section])).toBeVisible();
      const refresh = bar.locator('.obsFilterBar__submit');
      await expect(refresh).toBeVisible();
      // Unfolded: the range alone on its row, full width; the action ends the bar.
      const [rangeBox, barBox, actionBox] = await Promise.all([bar.locator(SYSTEM_RANGE[section]).boundingBox(), bar.boundingBox(), refresh.boundingBox()]);
      expect(Math.round(rangeBox.width), section).toBe(Math.round(barBox.width) - 24);
      expect(Math.round(barBox.x + barBox.width - actionBox.x - actionBox.width), section).toBe(12);
      await refresh.click();
      await expect(summary).toHaveAttribute('aria-expanded', 'false');
      // The same summary line as Observability's.
      await page.goto(`/observability/logs${HOUR}`);
      const logs = page.locator('#logsForm .obsFilterSummary');
      await expect(logs).toBeVisible({ timeout: 20_000 });
      expect(await logs.evaluate((el) => { const s = getComputedStyle(el); return [s.height, s.fontSize, s.borderRadius, s.paddingLeft]; }), section).toEqual(style);
    }
  });
});
