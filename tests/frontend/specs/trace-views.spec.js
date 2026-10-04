import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { largeTrace, routeTrace } from '../helpers/trace-mocks.js';
import {
  settle, cameraIdle, contrast, tokenColors, pixel, colorDistance, expectDotGrid, expectKitChrome, expectLabelsClear, expectClearOfChrome, freeArea, measureFrames, expectTouchCanvas, expectFullFit, expectFit, expectLevelOfDetail,
} from '../helpers/graph-kit.js';

// Span detail inspector (Jaeger's SpanDetail) and the alternative trace views
// (Trace Graph / Statistics / Spans Table / Flamegraph) on a mocked trace:
// the OTel fixture only holds flat traces without events, links or JSON
// attributes. The Trace Graph runs on the shared canvas graph kit and is
// checked with the graph-kit helpers, like the Explorer graph and the
// Service map.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const OTHER_SPAN_ID = 'b7ad6b7169203331';
const BASE_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const ID = { A: 'a000000000000001', B: 'a000000000000002', C: 'a000000000000003', D: 'a000000000000004', E: 'a000000000000005', F: 'a000000000000006', C2: 'a000000000000007', G: 'a000000000000008', H: 'a000000000000009' };

// "2026-09-19 12:00:00.010000000" for an offset in ms from BASE_MS.
function stamp(offsetMs) {
  const totalNs = BigInt(BASE_MS) * 1000000n + BigInt(Math.round(offsetMs * 1e6));
  const ms = Number(totalNs / 1000000n);
  const iso = new Date(ms).toISOString();
  const fraction = String(totalNs % 1000000000n).padStart(9, '0');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${fraction}`;
}

function span({ id, parent = '', service, name, start, dur, kind = 'Internal', status = 'Unset', message = '', attrs = {}, resource = {}, events = [], links = [], traceId = TRACE_ID }) {
  return {
    timestamp: stamp(start),
    start_ns: Number(BigInt(BASE_MS) * 1000000n + BigInt(Math.round(start * 1e6))),
    duration_ns: Math.round(dur * 1e6),
    trace_id: traceId,
    span_id: id,
    parent_span_id: parent,
    span_name: name,
    span_kind: kind,
    service_name: service,
    status_code: status,
    status_message: message,
    span_attributes: JSON.stringify(attrs),
    resource_attributes: JSON.stringify({ 'service.name': service, ...resource }),
    events_timestamp: JSON.stringify(events.map((e) => stamp(e.at))),
    events_name: JSON.stringify(events.map((e) => e.name)),
    events_attributes: JSON.stringify(events.map((e) => e.attrs || {})),
    links_trace_id: JSON.stringify(links.map((l) => l.traceId)),
    links_span_id: JSON.stringify(links.map((l) => l.spanId)),
    links_attributes: JSON.stringify(links.map((l) => l.attrs || {})),
  };
}

const MANY_FLAGS = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`flag${String(i).padStart(2, '0')}`, i === 0 ? { nested: true } : i]));

// Times in ms from the trace start. Self times: A 20, B 15, C 20, D 22, E 3,
// F 5, C2 5, G 15 (its child H is clipped at G's end), H 15.
const MOCK_SPANS = [
  span({ id: ID.A, service: 'frontend', name: 'GET /checkout', start: 0, dur: 100, kind: 'Server', status: 'Ok',
    attrs: {
      'http.method': 'GET', 'http.status_code': '200', 'http.url': 'https://shop.example/checkout', 'cache.hit': 'false',
      'app.cart': '{"items":[{"sku":"A1","qty":2}],"total":42.5,"coupon":null}', 'app.flags': JSON.stringify(MANY_FLAGS),
      'otel.scope.name': 'frontend', 'http.request.header.accept': '["text/html","application/json"]',
    },
    resource: { 'host.name': 'web-1' },
    events: [
      { at: 50.08, name: 'cart.loaded', attrs: { 'cart.items': '1' } },
      { at: 1, name: 'request.received' },
      { at: 3, name: 'auth.checked', attrs: { 'auth.method': 'cookie' } },
      { at: 50, name: 'render.start' },
      { at: 2, name: 'session.found' },
    ] }),
  span({ id: ID.B, parent: ID.A, service: 'checkout', name: 'POST /cart/checkout', start: 10, dur: 60, kind: 'Server', attrs: { 'http.method': 'POST', 'http.route': '/cart/checkout' } }),
  span({ id: ID.C, parent: ID.B, service: 'checkout', name: 'SELECT orders', start: 15, dur: 20, kind: 'Client', attrs: { 'db.system': 'clickhouse', 'db.statement': 'SELECT * FROM orders WHERE user_id = 42' } }),
  span({ id: ID.D, parent: ID.B, service: 'payments', name: 'charge', start: 30, dur: 30, kind: 'Client', status: 'Error', message: 'card declined',
    events: [{ at: 45, name: 'exception', attrs: { 'exception.type': 'CardDeclined', 'exception.message': 'insufficient funds' } }] }),
  span({ id: ID.E, parent: ID.D, service: 'payments', name: 'fraud.check', start: 32, dur: 8 }),
  span({ id: ID.F, parent: ID.E, service: 'fraud', name: 'score', start: 33, dur: 5 }),
  span({ id: ID.C2, parent: ID.B, service: 'checkout', name: 'SELECT orders', start: 40, dur: 5, kind: 'Client', attrs: { 'db.system': 'clickhouse' } }),
  span({ id: ID.G, parent: ID.A, service: 'frontend', name: 'render', start: 75, dur: 20,
    links: [
      { traceId: OTHER_TRACE_ID, spanId: OTHER_SPAN_ID, attrs: { 'link.reason': 'retry' } },
      { traceId: TRACE_ID, spanId: ID.B },
    ] }),
  span({ id: ID.H, parent: ID.G, service: 'frontend', name: 'hydrate', start: 90, dur: 15 }),
];

const OTHER_SPANS = [
  span({ id: 'c000000000000001', service: 'scheduler', name: 'retry.schedule', start: 0, dur: 12, traceId: OTHER_TRACE_ID }),
  span({ id: OTHER_SPAN_ID, parent: 'c000000000000001', service: 'checkout', name: 'retry.checkout', start: 2, dur: 8, traceId: OTHER_TRACE_ID }),
];

async function mockTraces(page) {
  await page.route((url) => url.pathname.endsWith('/api/traces/trace'), (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('trace_id');
    const spans = id === TRACE_ID ? MOCK_SPANS : id === OTHER_TRACE_ID ? OTHER_SPANS : null;
    if (!spans) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ source_host_id: 'local', trace_id: id, range_source: 'trace_index', truncated: false, spans }),
    });
  });
}

async function openTrace(page, query = '') {
  await mockTraces(page);
  await page.goto(`/observability/traces/${TRACE_ID}${query}`);
  await expect(page.locator('#traceDetail')).toBeVisible();
}

const row = (page, id) => page.locator(`#traceWaterfall .traceSpanRow[data-span-id="${id}"]`);
// On the span name: the left edge holds the tree guides and collapse box.
const openSpan = (page, id) => row(page, id).locator('.traceSpanRow__name').click();
const inspector = (page, id) => page.locator(`#traceWaterfall [data-inspector-span="${id}"]`);

async function captureCopies(page) {
  await page.evaluate(() => {
    window.__copies = [];
    document.addEventListener('copy', () => {
      const active = document.activeElement;
      if (active && typeof active.value === 'string') window.__copies.push(active.value.slice(active.selectionStart, active.selectionEnd));
    }, true);
  });
}
const lastCopy = (page) => page.evaluate(() => window.__copies[window.__copies.length - 1] || '');

// The trace views are a tab row (Timeline | Graph | Statistics | Spans |
// Flamegraph); below 820 px the "View" dropdown stands in for it.
const viewTabs = (page) => page.locator('#traceViewTabs');
const viewTab = (page, label) => viewTabs(page).getByRole('tab', { name: label, exact: true });
const viewPicker = (page) => page.locator('#traceViewBar .traceViewBar__picker');

async function pickView(page, label) {
  await viewTab(page, label).click();
  await expect(viewTab(page, label)).toHaveAttribute('aria-selected', 'true');
}

async function pickTool(page, selectId, label) {
  const root = page.locator(`#traceViewTools .tracePicker:has(#${selectId})`);
  await root.locator('.tracePicker__button').click();
  await root.locator('.tracePicker__menu').getByRole('option', { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('__traceViewsInit')) { localStorage.removeItem('chdash.traceView'); sessionStorage.setItem('__traceViewsInit', '1'); } } catch (_) {} });
});

// The sticky waterfall head (z-index --z-panel) covers every layer of the
// rows (bars, markers), and a row scrolled into view lands below it
// (scroll-padding-top), so a row half under the head stays clickable.
test.describe('waterfall head at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('a span row under the sticky waterfall head stays clickable', async ({ page }) => {
    await openTrace(page);
    await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(MOCK_SPANS.length, { timeout: 30_000 });
    // Three open inspectors make the waterfall taller than its pane.
    for (const span of [ID.A, ID.B, ID.C]) {
      await openSpan(page, span);
      await expect(inspector(page, span)).toBeVisible();
    }
    const id = await page.evaluate(() => {
      const scroller = document.getElementById('traceWaterfall');
      const rows = [...scroller.querySelectorAll('.traceSpanRow[data-span-id]')];
      // The first row past the visible part: it needs a scroll.
      const bottom = scroller.getBoundingClientRect().bottom;
      return rows.find((el) => el.getBoundingClientRect().top > bottom)?.getAttribute('data-span-id') || '';
    });
    expect(id).not.toBe('');
    // Half under the head: the head is on top there, not the row.
    const covered = await page.evaluate((spanId) => {
      const scroller = document.getElementById('traceWaterfall');
      const head = scroller.querySelector('.traceWaterfallHead');
      const target = scroller.querySelector(`.traceSpanRow[data-span-id="${spanId}"]`);
      scroller.scrollTop += target.getBoundingClientRect().top - head.getBoundingClientRect().bottom + target.offsetHeight / 2 - target.offsetHeight;
      const h = head.getBoundingClientRect();
      const points = [0.2, 0.5, 0.8].map((x) => document.elementFromPoint(h.left + h.width * x, h.bottom - 4));
      return points.every((el) => head.contains(el));
    }, id);
    expect(covered).toBe(true);
    // A click on it lands on the row: its inspector opens.
    await openSpan(page, id);
    await expect(inspector(page, id)).toBeVisible();
    // Scrolled into view, a row sits below the head.
    const landed = await page.evaluate((spanId) => {
      const scroller = document.getElementById('traceWaterfall');
      const head = scroller.querySelector('.traceWaterfallHead');
      const target = scroller.querySelector(`.traceSpanRow[data-span-id="${spanId}"]`);
      scroller.scrollTop = scroller.scrollHeight;
      target.scrollIntoView({ block: 'start' });
      return Math.round(target.getBoundingClientRect().top - head.getBoundingClientRect().bottom);
    }, ID.A);
    expect(landed).toBeGreaterThanOrEqual(0);
  });
});

// The tab row sits right under the trace header on every view: the
// Timeline's own head (service filters, overview) comes under the tabs and
// goes with the Timeline.
test('trace detail: the tab row keeps its place on every view; the Timeline head sits under it', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
  const tabs = page.locator('#traceViewTabs');
  const header = await page.locator('#traceDetailHeader').boundingBox();
  const first = await tabs.boundingBox();
  expect(first.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  const head = page.locator('#traceTimelineHead');
  await expect(head).toBeVisible();
  expect((await head.boundingBox()).y).toBeGreaterThanOrEqual(first.y + first.height - 1);
  await expect(head.locator('#traceOverview')).toBeVisible();
  for (const view of ['graph', 'statistics', 'spans', 'flamegraph', 'timeline']) {
    await page.locator(`#traceViewTab-${view}`).click();
    await expect(page.locator(`#traceViewTab-${view}`)).toHaveAttribute('aria-selected', 'true');
    const box = await tabs.boundingBox();
    expect(Math.abs(box.y - first.y), view).toBeLessThanOrEqual(1);
    if (view === 'timeline') await expect(head).toBeVisible();
    else await expect(head).toBeHidden();
  }
});

test('span inspector: attribute table layout, typed values, JSON trees and per-row copy', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(MOCK_SPANS.length, { timeout: 30_000 });
  await openSpan(page, ID.A);
  const card = inspector(page, ID.A);
  await expect(card).toBeVisible();
  const tags = card.locator('[data-span-section="tags"]');
  // The inline card uses the waterfall's full width: it starts at the span's
  // tree line, not after the name column.
  const span = await card.evaluate((el) => {
    const row = el.closest('.traceSpanInspectorRow').getBoundingClientRect();
    const panelBox = el.closest('.traceSpanInspectorRow__panel').getBoundingClientRect();
    return { left: panelBox.left - row.left, width: panelBox.width, rowWidth: row.width };
  });
  expect(span.left).toBeLessThan(80);
  expect(span.width).toBeGreaterThan(span.rowWidth - 80);
  // Collapsed: "Tags N", then two-line key / value cells (key, then value);
  // open: the table only.
  await expect(tags.locator(':scope > summary > b')).toHaveText('Tags');
  await expect(tags.locator(':scope > summary .traceJaegerGroup__count')).toHaveText(/^\d+$/);
  const cells = tags.locator(':scope > summary .traceAttrGrid > .traceAttrCell');
  await expect(cells.first()).toBeVisible();
  // The grid takes a line of its own, under "Tags N", across the card.
  const under = await tags.evaluate((el) => {
    const label = el.querySelector(':scope > summary > b').getBoundingClientRect();
    const grid = el.querySelector(':scope > summary .traceAttrGrid').getBoundingClientRect();
    return { below: grid.top >= label.bottom - 1, wide: grid.width > el.getBoundingClientRect().width * 0.8 };
  });
  expect(under).toEqual({ below: true, wide: true });
  expect(await cells.count()).toBeLessThanOrEqual(8);
  const cell = await cells.first().evaluate((el) => {
    const key = el.querySelector('.traceAttrCell__key').getBoundingClientRect();
    const value = el.querySelector('.traceAttrCell__value').getBoundingClientRect();
    return { below: value.top >= key.bottom - 1, family: getComputedStyle(el.querySelector('.traceAttrCell__value')).fontFamily };
  });
  expect(cell.below).toBe(true);
  expect(cell.family).toMatch(/^"?IBM Plex Mono/);
  await tags.locator(':scope > summary').click();
  await expect(tags.locator(':scope > summary .traceJaegerSummaryPreview')).toBeHidden();
  await expect(tags.locator(':scope > summary')).toHaveText(/^Tags\s*\d+$/, { useInnerText: true });
  const table = tags.locator('.traceKv');
  await expect(table).toBeVisible();

  // The value column starts right after the longest key (capped at 40 %).
  const layout = await table.evaluate((el) => {
    const t = el.getBoundingClientRect();
    const keys = [...el.querySelectorAll('.kvList__row:not(.kvList__row--tree) > .kvList__key')];
    const cells = [...el.querySelectorAll('.kvList__row:not(.kvList__row--tree) > .kvList__value')];
    const widest = Math.max(...keys.map((k) => {
      const range = document.createRange();
      range.selectNodeContents(k);
      return range.getBoundingClientRect().width;
    }));
    const lefts = cells.map((c) => Math.round(c.getBoundingClientRect().left));
    return { tableLeft: t.left, tableWidth: t.width, widest, valueLeft: lefts[0], sameColumn: new Set(lefts).size === 1 };
  });
  expect(layout.sameColumn).toBe(true);
  expect(layout.valueLeft - layout.tableLeft).toBeLessThanOrEqual(Math.min(layout.widest + 24, layout.tableWidth * 0.4 + 2));

  // Values coloured by type; otel.* keys in italics.
  const kv = (key) => table.locator(`.kvList__row[data-kv-key="${key}"]`);
  await expect(kv('http.status_code').locator('.kv__v')).toHaveClass(/kv__v--number/);
  await expect(kv('cache.hit').locator('.kv__v')).toHaveClass(/kv__v--bool/);
  await expect(kv('http.method').locator('.kv__v')).toHaveClass(/kv__v--string/);
  const colours = await Promise.all(['http.status_code', 'cache.hit', 'http.method'].map((key) => kv(key).locator('.kv__v').evaluate((el) => getComputedStyle(el).color)));
  expect(new Set(colours).size).toBe(3);
  await expect(kv('otel.scope.name').locator('.kvList__key')).toHaveCSS('font-style', 'italic');
  await expect(kv('http.method').locator('.kvList__key')).toHaveCSS('font-style', 'normal');
  // HTTP header arrays are a plain list.
  await expect(kv('http.request.header.accept').locator('.kvList__value')).toContainText('text/html, application/json');

  // JSON-looking strings: a pretty tree on its own full-width row; a value of
  // at most 10 keys opens fully, a larger one keeps nested levels closed.
  const cart = kv('app.cart');
  await expect(cart).toHaveClass(/kvList__row--tree/);
  await expect(cart.locator('.kvTree').first()).toHaveAttribute('open', '');
  expect(await cart.locator('details.kvTree').evaluateAll((els) => els.every((el) => el.open))).toBe(true);
  await expect(cart.locator('.kvTree__key').first()).toHaveText('items');
  await expect(cart.locator('.kv__v--null')).toHaveText('null');
  const flags = kv('app.flags');
  expect(await flags.locator('details.kvTree').evaluateAll((els) => els.map((el) => el.open))).toEqual([true, false]);
  await flags.locator('details.kvTree details.kvTree > summary').click();
  expect(await flags.locator('details.kvTree').evaluateAll((els) => els.map((el) => el.open))).toEqual([true, true]);
  const cartBox = await cart.locator('.kvList__value').boundingBox();
  const tableBox = await table.boundingBox();
  expect(cartBox.x - tableBox.x).toBeLessThan(12);

  // Copy (value) / JSON actions appear on hover.
  const status = kv('http.status_code');
  const actionOpacity = () => status.locator('.kvList__actions').evaluate((el) => getComputedStyle(el).opacity);
  await page.mouse.move(0, 0);
  expect(await actionOpacity()).toBe('0');
  await status.locator('.kvList__key').hover();
  await expect.poll(actionOpacity).toBe('1');
  await captureCopies(page);
  await status.locator('[data-kv-action="copy"]').click();
  await expect.poll(() => lastCopy(page)).toBe('200');
  await status.locator('[data-kv-action="json"]').click();
  await expect.poll(() => lastCopy(page)).toBe(JSON.stringify({ key: 'http.status_code', value: '200' }, null, 2));
  await cart.hover();
  await cart.locator('[data-kv-action="copy"]').click();
  await expect.poll(() => lastCopy(page)).toBe(MOCK_SPANS[0].span_attributes && JSON.parse(MOCK_SPANS[0].span_attributes)['app.cart']);
  // The row stays open: copying does not toggle the span.
  await expect(card).toBeVisible();

  // Process (resource) section: same accordion.
  const process = card.locator('[data-span-section="process"]');
  const host = process.locator(':scope > summary .traceAttrCell').filter({ has: page.locator('.traceAttrCell__key', { hasText: /^host\.name$/ }) });
  await expect(host.locator('.traceAttrCell__value')).toHaveText('web-1');
  await process.locator(':scope > summary').click();
  await expect(process.locator('.kvList__row[data-kv-key="host.name"] .kv__v')).toHaveText('web-1');
});

test('span inspector: events relative to the trace start, sorted, first three then show more', async ({ page }) => {
  await openTrace(page);
  await openSpan(page, ID.A);
  const events = inspector(page, ID.A).locator('[data-span-section="events"]');
  await expect(events.locator(':scope > summary')).toHaveText('Events(5)');
  await events.locator(':scope > summary').click();
  const items = events.locator('.traceSpanEvents__list > .traceSpanEvent');
  await expect(items).toHaveCount(5);
  await expect(events.locator('.traceSpanEvents__list > .traceSpanEvent:visible > summary > b')).toHaveText(['request.received', 'session.found', 'auth.checked']);
  await expect(events.locator('.traceSpanEvents__list > .traceSpanEvent:visible > summary > time')).toHaveText(['(1 ms)', '(2 ms)', '(3 ms)']);
  await expect(events.locator('.traceSpanEvents__note')).toHaveText('Event timestamps are relative to the start time of the full trace.');
  // Absolute time in the tooltip.
  await expect(items.first().locator('time')).toHaveAttribute('title', /^2026-09-19T12:00:00\.001Z\n.*\nSep 19, 2026 12:00:00\.001000000 UTC$/);
  await events.locator('[data-events-more]').click();
  await expect(events.locator('.traceSpanEvents__list > .traceSpanEvent:visible > summary > b')).toHaveText(['request.received', 'session.found', 'auth.checked', 'render.start', 'cart.loaded']);
  await expect(items.nth(4).locator('time')).toHaveText('(50.1 ms)');
  await expect(events.locator('[data-events-more]')).toHaveText('show less');
  // An event's attributes: preview while collapsed, table once open.
  const auth = items.nth(2);
  await expect(auth.locator(':scope > summary .traceJaegerSummaryPreview')).toContainText('auth.method=cookie');
  await auth.locator(':scope > summary').click();
  await expect(auth.locator(':scope > summary .traceJaegerSummaryPreview')).toBeHidden();
  await expect(auth.locator('.kvList__row[data-kv-key="auth.method"] .kv__v')).toHaveText('cookie');
  await events.locator('[data-events-more]').click();
  await expect(events.locator('.traceSpanEvents__list > .traceSpanEvent:visible')).toHaveCount(3);

  // Offsets are from the trace start, not the span start.
  await openSpan(page, ID.D);
  const dEvents = inspector(page, ID.D).locator('[data-span-section="events"]');
  await dEvents.locator(':scope > summary').click();
  await expect(dEvents.locator('.traceSpanEvent time')).toHaveText('(45 ms)');
});

test('span bar event markers: grouped at 0.2 % steps, a click lists the group in a popover', async ({ page }) => {
  await openTrace(page);
  await expect(row(page, ID.A)).toBeVisible();
  const markers = row(page, ID.A).locator('.traceSpanEventMarker');
  await expect(markers).toHaveCount(5);
  // 50 ms and 50.08 ms (47.62 % and 47.70 % of 105 ms) share a group.
  const lefts = await markers.evaluateAll((els) => els.map((el) => parseFloat(el.style.left)));
  const at50 = lefts.findIndex((left) => Math.abs(left - (50 / 105) * 100) < 0.01);
  await markers.nth(at50).click({ force: true });
  const popover = page.locator('.traceEventPopover');
  await expect(popover).toBeVisible();
  await expect(popover.locator('.traceEventPopover__head b')).toHaveText('2 events');
  await expect(popover.locator('.traceSpanEvent > summary > b')).toHaveText(['render.start', 'cart.loaded']);
  await expect(popover.locator('.traceSpanEvent > summary > time')).toHaveText(['(50 ms)', '(50.1 ms)']);
  // The marker click does not open the span inspector.
  await expect(inspector(page, ID.A)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  const at1 = lefts.findIndex((left) => Math.abs(left - (1 / 105) * 100) < 0.01);
  await markers.nth(at1).click({ force: true });
  await expect(popover.locator('.traceSpanEvent > summary > b')).toHaveText(['request.received']);
  await page.locator('#traceViewBar').click();
  await expect(popover).toHaveCount(0);
});

test('span inspector: references list links, the parent and linked-from spans', async ({ page }) => {
  await openTrace(page);
  await openSpan(page, ID.G);
  const refs = inspector(page, ID.G).locator('[data-span-section="references"]');
  await expect(refs.locator(':scope > summary')).toHaveText('References(3)');
  await refs.locator(':scope > summary').click();
  const items = refs.locator('.traceSpanRefs__item');
  await expect(items.locator('.traceSpanRefs__kind')).toHaveText(['child of', 'follows from', 'follows from']);
  await expect(items.nth(0).locator('.traceSpanRefs__main')).toContainText('frontendGET /checkout');
  await expect(items.nth(1).locator('.traceSpanRefs__main')).toContainText('< span in another trace >');
  await expect(items.nth(1).locator('.traceSpanRefs__ids')).toContainText(`TraceID: ${OTHER_TRACE_ID}`);
  await expect(items.nth(1).locator('.traceSpanRefs__ids')).toContainText(`SpanID: ${OTHER_SPAN_ID}`);
  await expect(items.nth(1).locator('.kvList__row[data-kv-key="link.reason"]')).toContainText('retry');
  await expect(items.nth(2).locator('.traceSpanRefs__main')).toContainText('checkoutPOST /cart/checkout');

  // Same trace: "Go to span" focuses it.
  await items.nth(2).getByRole('button', { name: 'Go to span' }).click();
  await expect(row(page, ID.B)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, ID.B)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('span')).toBe(ID.B);
  // B knows it is linked from G (data of the loaded trace only).
  const bRefs = inspector(page, ID.B).locator('[data-span-section="references"]');
  await bRefs.locator(':scope > summary').click();
  await expect(bRefs.locator('.traceSpanRefs__kind')).toHaveText(['child of', 'linked from']);
  await expect(bRefs.locator('.traceSpanRefs__item').nth(1)).toContainText('frontendrender');

  // Another trace: "Open linked trace" loads it focused on the linked span.
  await items.nth(1).getByRole('link', { name: 'Open linked trace' }).click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${OTHER_TRACE_ID}\\?span=${OTHER_SPAN_ID}$`));
  await expect(row(page, OTHER_SPAN_ID)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, OTHER_SPAN_ID)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}\\?span=${ID.B}$`));
  await expect(inspector(page, ID.B)).toBeVisible();
});

test('span inspector header and the ?span= deep link round trip (copy, reload, back)', async ({ page }) => {
  await openTrace(page);
  await openSpan(page, ID.D);
  const card = inspector(page, ID.D);
  const head = card.locator('.traceInspectorHead');
  await expect(head.locator('strong')).toHaveText('charge');
  const meta = head.locator('.traceInspectorHead__meta');
  await expect(meta).toContainText('Service: payments');
  await expect(meta).toContainText('Duration: 30 ms');
  await expect(meta).toContainText('Start Time: 30 ms');
  await expect(meta).toContainText('Kind: Client');
  await expect(meta.locator('.traceStatus')).toHaveText('Error');
  await expect(meta.locator('[title*="Sep 19, 2026 12:00:00.030000000 UTC"]')).toHaveCount(1);
  await expect(card.locator('.traceInspectorStatusMessage')).toContainText('card declined');
  const identity = card.locator('.traceInspectorIdentity');
  await expect(identity).toContainText(`SpanID: ${ID.D}`);
  await expect(identity).toContainText(`Parent: ${ID.B}`);
  // Opening a span points the URL at it.
  expect(new URL(page.url()).searchParams.get('span')).toBe(ID.D);

  await captureCopies(page);
  await identity.locator(`[data-copy-span-field="${ID.D}"]`).click();
  await expect.poll(() => lastCopy(page)).toBe(ID.D);
  await identity.locator(`[data-copy-span-field="${ID.B}"]`).click();
  await expect.poll(() => lastCopy(page)).toBe(ID.B);
  await identity.getByRole('button', { name: 'Copy deep link' }).click();
  await expect.poll(() => lastCopy(page)).toMatch(new RegExp(`/observability/traces/${TRACE_ID}\\?span=${ID.D}$`));
  const deepLink = await lastCopy(page);
  expect(new URL(deepLink).origin).toBe(new URL(page.url()).origin);

  // Closing the span drops it from the URL.
  await openSpan(page, ID.D);
  await expect(card).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('span')).toBe(null);

  // Opening the deep link: the span's inspector is open, scrolled to, highlighted.
  await page.goto('/observability/traces');
  await page.goto(deepLink);
  await expect(row(page, ID.D)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, ID.D)).toBeVisible();
  await expect(row(page, ID.D)).toBeInViewport();
  await page.reload();
  await expect(row(page, ID.D)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, ID.D)).toBeVisible();
  // Back returns to the page opened before the deep link.
  await page.goBack();
  await expect(page).toHaveURL(/\/traces$/);
  await page.goForward();
  await expect(inspector(page, ID.D)).toBeVisible();
});

// Audit round 2: a bar that reaches the right edge labels inside itself (no
// room before it) or before it, never cut by the edge; the service name
// stays whole and the operation after it takes the ellipsis.
test('waterfall: an edge bar labels inside or before itself, never cut; the service keeps its name', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(MOCK_SPANS.length, { timeout: 30_000 });
  // The root (0 to 100 % of the trace): inside, in the bar's readable colour.
  const root = row(page, ID.A).locator('.traceSpanBar');
  await expect(root).toHaveClass(/traceSpanBar--labelInside/);
  await expect(root.locator('.traceSpanBar__label b')).toHaveText('100 ms');
  // "render" (75 to 95 %): before the bar.
  await expect(row(page, ID.G).locator('.traceSpanBar')).toHaveClass(/traceSpanBar--labelLeft/);
  const cut = await page.locator('#traceWaterfall .traceSpanRow').evaluateAll((rows) => rows.map((r) => {
    const cell = r.querySelector('.traceSpanRow__timeline').getBoundingClientRect();
    const label = r.querySelector('.traceSpanBar__label b')?.getBoundingClientRect();
    return label && (label.width === 0 || label.right > cell.right + 1 || label.left < cell.left - 1) ? r.dataset.spanId : null;
  }).filter(Boolean));
  expect(cut).toEqual([]);
  const services = await page.locator('#traceWaterfall .traceSpanRow__service').evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
  expect(services).toEqual([]);
  const service = await row(page, ID.B).locator('.traceSpanRow__service').evaluate((el) => ({ flex: getComputedStyle(el).flexShrink, max: getComputedStyle(el).maxWidth }));
  expect(service.flex).toBe('0');
});

test('span inspector: a neutral raised surface under a 3 px rule in the service colour', async ({ page }) => {
  await openTrace(page);
  await openSpan(page, ID.D);
  const card = inspector(page, ID.D);
  await expect(card).toBeVisible();
  const look = await card.evaluate((el) => {
    const probe = document.createElement('i');
    probe.style.background = 'var(--raised)';
    probe.style.color = 'var(--trace-service-color)';
    el.appendChild(probe);
    const raised = getComputedStyle(probe).backgroundColor;
    const service = getComputedStyle(probe).color;
    probe.remove();
    const panel = el.closest('.traceSpanInspectorRow__panel');
    return { bg: getComputedStyle(panel).backgroundColor, raised, rule: getComputedStyle(el).borderTopWidth, ruleColor: getComputedStyle(el).borderTopColor, service, spacer: getComputedStyle(el.closest('.traceSpanInspectorRow').querySelector('.traceSpanInspectorRow__spacer')).backgroundColor };
  });
  expect(look.bg).toBe(look.raised);
  expect(look.rule).toBe('3px');
  expect(look.ruleColor).toBe(look.service);
  expect(look.spacer).toBe('rgba(0, 0, 0, 0)');
});

test.describe('span inspector on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('span inspector at 390 px: facts stacked one per line, nothing cut, no indent under the span', async ({ page }) => {
    await openTrace(page);
    await expect(row(page, ID.D)).toBeVisible({ timeout: 30_000 });
    await openSpan(page, ID.D);
    const card = inspector(page, ID.D);
    await expect(card).toBeVisible();
    const meta = card.locator('.traceInspectorHead__meta');
    await expect(meta).toContainText('Start Time:');
    const m = await card.evaluate((el) => {
      const head = el.querySelector('.traceInspectorHead__meta');
      const facts = [...head.querySelectorAll(':scope > span')];
      const box = el.getBoundingClientRect();
      const waterfall = el.closest('#traceWaterfall').getBoundingClientRect();
      return {
        direction: getComputedStyle(head).flexDirection,
        lefts: [...new Set(facts.map((f) => Math.round(f.getBoundingClientRect().left)))],
        cut: facts.filter((f) => f.scrollWidth > f.clientWidth + 1 || f.getBoundingClientRect().right > innerWidth + 1).map((f) => f.textContent),
        headCut: head.scrollWidth > head.clientWidth + 1,
        indent: Math.round(box.left - waterfall.left),
        identity: Math.round(el.querySelector('.traceInspectorIdentity').getBoundingClientRect().left - box.left),
      };
    });
    expect(m.direction).toBe('column');
    expect(m.lefts).toHaveLength(1);
    expect(m.cut).toEqual([]);
    expect(m.headCut).toBe(false);
    expect(m.indent).toBeLessThanOrEqual(1);
    expect(m.identity).toBeLessThanOrEqual(12);
  });
});

test('trace statistics: self time, grouping, sub-groups, sorting and heat colouring', async ({ page }) => {
  await openTrace(page);
  await pickView(page, 'Statistics');
  await expect(page).toHaveURL(/\?tab=statistics$/);
  await expect(page.locator('.traceTimelineFrame')).toBeHidden();
  await expect(page.locator('#traceOverview')).toBeHidden();
  const table = page.locator('#traceAltView .traceStats__table');
  await expect(table).toBeVisible();
  // Sentence case, as every label of the app.
  await expect(page.locator('#traceViewTools .tracePicker__button')).toHaveText(['Group by · Service name', 'Sub-group · No sub-group', 'Color by · None']);
  await expect(table.locator('thead th').first()).toHaveText(/^Service name/);
  const cells = (group) => table.locator(`tr[data-stats-group="${group}"] > *`);
  // Default sort: count, descending (Jaeger's); ties by name.
  await expect(table.locator('tbody tr > th')).toHaveText(['checkout', 'frontend', 'payments', 'fraud']);
  // By hand: frontend = A (100 ms, self 100 - 80 = 20), G (20 ms; child H
  // clipped at G's end: self 15), H (15 ms, self 15).
  await expect(cells('frontend')).toHaveText(['frontend', '3', '135 ms', '45 ms', '15 ms', '100 ms', '50 ms', '16.7 ms', '15 ms', '20 ms', '37%']);
  // checkout = B (60 ms; children cover [15, 60]: self 15), C (20), C2 (5).
  await expect(cells('checkout')).toHaveText(['checkout', '3', '85 ms', '28.3 ms', '5 ms', '60 ms', '40 ms', '13.3 ms', '5 ms', '20 ms', '47.1%']);
  // payments = D (30 ms, child E 8 ms: self 22), E (8 ms, child F 5 ms: self 3).
  await expect(cells('payments')).toHaveText(['payments', '2', '38 ms', '19 ms', '8 ms', '30 ms', '25 ms', '12.5 ms', '3 ms', '22 ms', '65.8%']);
  await expect(cells('fraud')).toHaveText(['fraud', '1', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '100%']);
  // Service colour on the group cell.
  expect(await table.locator('tr[data-stats-group="frontend"] > th').evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);

  // Sorting: a header click sorts descending by it, a second click ascending.
  await table.getByRole('button', { name: 'Self total' }).click();
  await expect(table.locator('tbody tr > th')).toHaveText(['frontend', 'checkout', 'payments', 'fraud']);
  await table.getByRole('button', { name: /Self total/ }).click();
  await expect(table.locator('tbody tr > th')).toHaveText(['fraud', 'payments', 'checkout', 'frontend']);

  // Heat colouring by a column: 8 % to 60 % of the column maximum.
  await pickTool(page, 'traceStatsColorBy', 'Total');
  const weight = (group) => table.locator(`tr[data-stats-group="${group}"]`).evaluate((el) => el.style.getPropertyValue('--trace-heat-weight'));
  expect(await weight('frontend')).toBe('60%');
  expect(await weight('checkout')).toBe(`${Math.round((8 + (85 / 135) * 52) * 100) / 100}%`);
  expect(await table.locator('tr[data-stats-group="frontend"] > td').first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');

  // Group by operation, then service + operation.
  await pickTool(page, 'traceStatsGroupBy', 'Operation name');
  await expect(cells('SELECT orders').nth(1)).toHaveText('2');
  await expect(cells('SELECT orders').nth(2)).toHaveText('25 ms');
  await pickTool(page, 'traceStatsGroupBy', 'Service & operation');
  await expect(table.locator('tbody tr')).toHaveCount(8);
  await expect(cells('checkout · SELECT orders').nth(1)).toHaveText('2');

  // Service, sub-grouped by operation: detail rows under each service.
  await pickTool(page, 'traceStatsGroupBy', 'Service name');
  await pickTool(page, 'traceStatsSubGroup', 'Operation name');
  const checkoutDetails = table.locator('tr[data-stats-group="checkout"] ~ tr.traceStats__row--detail');
  await expect(table.locator('tr.traceStats__row--detail')).toHaveCount(8);
  await expect(checkoutDetails.first().locator('th')).toBeVisible();
  const detailOrder = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => `${r.classList.contains('traceStats__row--detail') ? '  ' : ''}${r.querySelector('th').textContent}`));
  const checkoutAt = detailOrder.indexOf('checkout');
  expect(detailOrder.slice(checkoutAt, checkoutAt + 3).sort()).toEqual(['  POST /cart/checkout', '  SELECT orders', 'checkout'].sort());

  // Group by a tag key.
  await pickTool(page, 'traceStatsSubGroup', 'No sub-group');
  await pickTool(page, 'traceStatsGroupBy', 'Tag: db.system');
  await expect(cells('clickhouse').nth(1)).toHaveText('2');
  await expect(cells('Without db.system').nth(1)).toHaveText('7');
});

test('trace spans table: sort, filter, and a row click focuses the span in the timeline (back returns)', async ({ page }) => {
  await openTrace(page);
  await pickView(page, 'Spans');
  await expect(page).toHaveURL(/\?tab=spans$/);
  const table = page.locator('#traceAltView .traceSpansTable__table');
  await expect(table.locator('tbody tr')).toHaveCount(9);
  await expect(page.locator('#traceSpansCount')).toHaveText('9 of 9 spans');
  // Default: start order.
  await expect(table.locator('tbody td[data-col="start"]')).toHaveText(['0 ns', '10 ms', '15 ms', '30 ms', '32 ms', '33 ms', '40 ms', '75 ms', '90 ms']);
  // Status: OK is discreet text (no chip), Error a red chip, Unset nothing.
  const statusCells = table.locator('tbody td[data-col="status"]');
  await expect(statusCells.first().locator('.statusText')).toHaveText('OK');
  await expect(statusCells.first().locator('.badge')).toHaveCount(0);
  await expect(table.locator('tbody td[data-col="status"] .badge')).toHaveCount(1);
  await expect(table.locator('tbody td[data-col="status"] .badge.badge--error')).toHaveText('Error');
  expect(await statusCells.evaluateAll((cells) => cells.filter((cell) => cell.textContent === '' && !cell.children.length).length)).toBe(7);
  await table.getByRole('button', { name: 'Duration' }).click();
  await expect(table.locator('tbody td[data-col="duration"]')).toHaveText(['100 ms', '60 ms', '30 ms', '20 ms', '20 ms', '15 ms', '8 ms', '5 ms', '5 ms']);
  await expect(table.locator('tbody td[data-col="operation"]')).toHaveText(['GET /checkout', 'POST /cart/checkout', 'charge', 'SELECT orders', 'render', 'hydrate', 'fraud.check', 'score', 'SELECT orders']);
  await table.getByRole('button', { name: /Duration/ }).click();
  await expect(table.locator('tbody td[data-col="duration"]').first()).toHaveText('5 ms');
  await table.getByRole('button', { name: 'Service name' }).click();
  await expect(table.locator('tbody td[data-col="service"]').first()).toHaveText('checkout');

  await page.locator('#traceSpansFilter').fill('select');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('#traceSpansCount')).toHaveText('2 of 9 spans');
  await page.locator('#traceSpansFilter').fill('');
  await pickTool(page, 'traceSpansStatus', 'Error');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(table.locator('tbody td[data-col="operation"]')).toHaveText('charge');
  await pickTool(page, 'traceSpansStatus', 'Any status');
  await pickTool(page, 'traceSpansService', 'frontend');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await pickTool(page, 'traceSpansService', 'All services');

  // Collapse the root in the timeline first: the focus expands the ancestors.
  await pickView(page, 'Timeline');
  await row(page, ID.A).locator('[data-toggle-span]').click();
  await expect(row(page, ID.F)).toHaveCount(0);
  await pickView(page, 'Spans');
  await table.locator(`tr[data-table-span="${ID.F}"]`).click();
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}\\?span=${ID.F}$`));
  await expect(row(page, ID.F)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, ID.F)).toBeVisible();
  await expect(page.locator('#traceViewSelect')).toHaveValue('timeline');
  await page.goBack();
  await expect(page).toHaveURL(/\?tab=spans$/);
  await expect(page.locator('#traceAltView .traceSpansTable')).toBeVisible();
  await page.goForward();
  await expect(inspector(page, ID.F)).toBeVisible();
});

test('trace flamegraph: widths follow durations, a click zooms into a frame, reset zooms out', async ({ page }) => {
  await openTrace(page, '?tab=flamegraph');
  const canvas = page.locator('#traceAltView .traceFlame__canvas');
  await expect(canvas).toBeVisible();
  const frames = canvas.locator('.traceFlame__frame');
  await expect(frames).toHaveCount(9);
  const box = (name) => canvas.locator(`.traceFlame__frame[data-flame-name="${name}"]`).evaluate((el) => ({ left: parseFloat(el.style.left), width: parseFloat(el.style.width), top: parseFloat(el.style.top) }));
  // Same-name siblings merge (SELECT orders: 20 + 5 ms); widths = share of 100 ms.
  expect(await box('frontend: GET /checkout')).toEqual({ left: 0, width: 100, top: 20 });
  expect(await box('checkout: POST /cart/checkout')).toEqual({ left: 0, width: 60, top: 40 });
  expect(await box('frontend: render')).toEqual({ left: 60, width: 20, top: 40 });
  expect(await box('checkout: SELECT orders')).toEqual({ left: 0, width: 25, top: 60 });
  expect(await box('payments: charge')).toEqual({ left: 25, width: 30, top: 60 });
  expect(await box('fraud: score')).toMatchObject({ width: 5, top: 100 });
  await expect(canvas.locator('[data-flame-name="checkout: SELECT orders"]')).toHaveAttribute('data-flame-count', '2');
  // Hover tooltip.
  await canvas.locator('[data-flame-name="payments: charge"]').hover();
  await expect(page.locator('.traceFlame__tip')).toContainText('payments: charge');
  await expect(page.locator('.traceFlame__tip')).toContainText('Duration: 30 ms');
  // Zoom into POST /cart/checkout: it spans the width, ancestors stay on top.
  await canvas.locator('[data-flame-name="checkout: POST /cart/checkout"]').click();
  expect(await box('checkout: POST /cart/checkout')).toEqual({ left: 0, width: 100, top: 40 });
  const select = await box('checkout: SELECT orders');
  expect(select.width).toBeCloseTo((25 / 60) * 100, 3);
  expect((await box('payments: charge')).width).toBeCloseTo(50, 3);
  await expect(canvas.locator('.traceFlame__frame.is-ancestor')).toHaveCount(2);
  await expect(canvas.locator('[data-flame-name="frontend: render"]')).toHaveCount(0);
  await expect(page.locator('#traceFlameCrumb')).toHaveText('Zoomed: checkout: POST /cart/checkout');
  await page.locator('#traceFlameReset').click();
  await expect(frames).toHaveCount(9);
  expect((await box('checkout: POST /cart/checkout')).width).toBe(60);
  await expect(page.locator('#traceFlameReset')).toBeDisabled();
});

// WCAG contrast of two computed colours (rgb() or a color-mix()'s color(srgb ...)), in the page.
const CONTRAST_JS = `(a, b) => {
  const lum = (c) => {
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b2] = c.replace(/^color\\(srgb/, '').match(/[\\d.]+(?:e-?\\d+)?/g).slice(0, 3).map((v) => {
      const x = Number(v) / scale;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}`;

test('trace flamegraph: a frame is its service colour 40 % into the surface under a 2 px edge, its label passes 4.5:1 in both themes', async ({ page }) => {
  await openTrace(page, '?tab=flamegraph');
  const canvas = page.locator('#traceAltView .traceFlame__canvas');
  await expect(canvas.locator('.traceFlame__frame')).toHaveCount(9);
  for (const theme of ['dark', 'light']) {
    // A theme switch picks the labels again.
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await expect.poll(() => page.evaluate(([contrastSource]) => {
      const contrast = new Function(`return ${contrastSource}`)();
      const probe = document.createElement('i');
      document.body.appendChild(probe);
      const resolve = (expr) => { probe.style.color = ''; probe.style.color = expr; return getComputedStyle(probe).color; };
      const frames = [...document.querySelectorAll('#traceAltView .traceFlame__frame:not(.is-ancestor)')].filter((el) => el.style.getPropertyValue('--trace-service-color'));
      const out = frames.map((el) => {
        const cs = getComputedStyle(el);
        const service = el.style.getPropertyValue('--trace-service-color');
        return {
          name: el.dataset.flameName,
          ratio: contrast(cs.backgroundColor, cs.color),
          edge: cs.borderTopWidth === '2px' && cs.borderTopColor === resolve(service),
          fill: cs.backgroundColor === resolve(`color-mix(in srgb, ${service} 40%, var(--panelBg))`),
        };
      });
      probe.remove();
      return out.length > 0 && out.every((f) => f.ratio >= 4.5 && f.edge && f.fill);
    }, [CONTRAST_JS])).toBe(true);
    // Every one of the 18 service colours gets a readable label on its frame fill.
    const ratios = await page.evaluate(([contrastSource]) => {
      const contrast = new Function(`return ${contrastSource}`)();
      const { palette } = window.ChDash;
      const probe = document.createElement('i');
      document.body.appendChild(probe);
      const resolve = (expr) => { probe.style.color = ''; probe.style.color = expr; return getComputedStyle(probe).color; };
      const out = [];
      for (let i = 1; i <= palette.SERVICE_SLOTS; i += 1) {
        const fill = `color-mix(in srgb, var(--trace-span-color-${i}) 40%, var(--panelBg))`;
        out.push(contrast(resolve(fill), resolve(palette.readableText(fill))));
      }
      probe.remove();
      return out;
    }, [CONTRAST_JS]);
    expect(ratios).toHaveLength(18);
    for (const ratio of ratios) expect(ratio, theme).toBeGreaterThanOrEqual(4.5);
  }
});

// ---------------------------------------------------------------- trace graph
// The Trace Graph is drawn with the shared canvas graph kit (app_graph_kit.js)
// like the Explorer graph and the Service map; ChDash.traceGraph.inspect()
// reports the drawn frame in client coordinates.

const inspectGraph = (page) => page.evaluate(() => window.ChDash.traceGraph.inspect());

async function openGraph(page, count = 8) {
  await openTrace(page, '?tab=graph');
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceGraph?.inspect?.().nodes.length || 0)), { timeout: 20_000 }).toBe(count);
  await settle(page);
}

async function graphNode(page, label) {
  const found = (await inspectGraph(page)).nodes.find((candidate) => candidate.label === label);
  expect(found, `${label} is drawn`).toBeTruthy();
  return found;
}

async function pickGraphColour(page, label) {
  const root = page.locator('#traceGraphBar .tracePicker:has(#traceGraphMode)');
  await root.locator('.tracePicker__button').click();
  await root.locator('.tracePicker__menu').getByRole('option', { name: label, exact: true }).click();
  await settle(page);
}

const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (rect, area) => rect.x >= area.x - 1 && rect.y >= area.y - 1 && rect.x + rect.width <= area.x + area.width + 1 && rect.y + rect.height <= area.y + area.height + 1;
const mix = (a, b, t) => a.slice(0, 3).map((value, i) => Math.round(value + (b[i] - value) * t));
const legendToggle = (page) => page.locator('#traceGraphPane .graphKitStatus .graphKitLegendToggle');

test('trace graph: the graph kit canvas, one card per call path with counts and times, a left-to-right tree, orthogonal edges labelled with the span count', async ({ page }) => {
  // Wide enough for Fit to show the whole graph at the readable scale.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGraph(page);
  const state = await inspectGraph(page);
  expect(state.kit).toBe(true);
  // SELECT orders twice under POST /cart/checkout: one call path, count 2.
  expect(state.nodes).toHaveLength(8);
  expect(state.edges).toHaveLength(7);
  await expect(page.locator('#traceAltView .traceGraph__node, #traceAltView svg.traceGraph__edges')).toHaveCount(0);
  const at = Object.fromEntries(state.nodes.map((n) => [n.label, n]));
  // Card rows: service (title), operation, "count / errors · avg", "time % · self %".
  expect(at['checkout SELECT orders'].countText).toBe('2 / 0 · avg 12.5 ms');
  expect(at['checkout SELECT orders'].timeText).toBe('25 ms (23.8%) · self 25 ms (100%)');
  expect(at['payments charge'].countText).toBe('1 / 1 · avg 30 ms');
  expect(at['payments charge'].timeText).toBe('30 ms (28.6%) · self 22 ms (73.3%)');
  expect(at['payments charge'].status).toBe('error');
  expect(at['checkout SELECT orders'].status).toBe(null);
  expect(at['frontend GET /checkout'].timeText).toMatch(/^100 ms \(95\.2%\) · self 20 ms/);
  // Rectangular cards of one size.
  expect(new Set(state.nodes.map((n) => `${Math.round(n.width)}x${Math.round(n.height)}`)).size).toBe(1);
  // Left to right in call order: a callee right of its caller, the first one
  // on the caller's row, the next ones below.
  const A = at['frontend GET /checkout'];
  const B = at['checkout POST /cart/checkout'];
  const S = at['checkout SELECT orders'];
  const D = at['payments charge'];
  const G = at['frontend render'];
  expect(B.x).toBeGreaterThan(A.x + A.width);
  expect(S.x).toBeGreaterThan(B.x + B.width);
  expect(Math.abs(B.y - A.y)).toBeLessThan(0.5);
  expect(Math.abs(S.y - B.y)).toBeLessThan(0.5);
  expect(D.y).toBeGreaterThan(S.y + S.height);
  expect(G.y).toBeGreaterThan(D.y);
  expect(Math.abs(G.x - B.x)).toBeLessThan(0.5);
  // Orthogonal edges; the first call of a path is a straight line; the dash
  // pattern is the call kind (SELECT orders is a database call); an edge into
  // an erroring call path is red.
  const edge = (from, to) => state.edges.find((e) => e.source === from.id && e.target === to.id);
  for (const e of state.edges) expect(e.orthogonal, e.id).toBe(true);
  expect(edge(A, B).bends).toBe(0);
  expect(edge(B, S).bends).toBe(0);
  expect(edge(B, D).bends).toBeGreaterThan(0);
  expect(edge(B, S).kind).toBe('db');
  expect(edge(B, S).dash.length).toBeGreaterThan(0);
  expect(edge(A, B).kind).toBe('sync');
  expect(edge(A, B).dash).toEqual([]);
  expect(edge(B, D).error).toBe(true);
  expect(edge(A, B).error).toBe(false);
  // Every edge carries its "×count" label, none on another label or a card.
  expect(state.edgeLabelsPlaced).toBe(7);
  expect(state.edgeLabelsDropped).toEqual([]);
  expect(state.edgeLabels.find((l) => l.id === S.id)?.text).toBe('×2');
  for (const l of state.edgeLabels) expect(l.text).toMatch(/^×\d+$/);
  expectLabelsClear(state);
  // The strip is the service colour of the waterfall.
  const strip = await pixel(page, '#traceGraphCanvas', S.x + 2, S.y + S.height / 2);
  const serviceRgb = await page.evaluate(() => {
    const probe = document.createElement('div');
    document.body.append(probe);
    probe.style.color = window.ChDash.palette.service('checkout');
    const rgb = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number);
    probe.remove();
    return rgb;
  });
  expect(colorDistance(strip, serviceRgb)).toBeLessThan(12);
  // The kit chrome: icon toolbar with the Colour picker, legend and status
  // line bottom-left, the dot grid, nothing under the chrome after the fit.
  await expectKitChrome(page, {
    pane: '#traceGraphPane', zoomOut: '#traceGraphZoomOut', fit: '#traceGraphFit', zoomIn: '#traceGraphZoomIn',
    legend: '#traceGraphLegend', status: '#traceGraphPane .graphKitStatus',
  });
  await expectClearOfChrome(page, '#traceGraphPane', state);
  await expect(page.locator('#traceGraphBar.graphKitBar #traceGraphMode')).toHaveCount(1);
  await expect(page.locator('#traceViewTools [data-view-tools="graph"]')).toHaveCount(0);
  await expect(page.locator('#traceGraphPane .graphKitStatus')).toContainText('8 call paths · 9 spans · depth 5');
  await expect(page.locator('#traceGraphLegend')).toContainText('count / errors · avg');
  await expect(page.locator('#traceGraphLegend')).toContainText('database');
  await expect(page.locator('#traceGraphLegend')).toContainText('spans of the callee');
  const colors = await tokenColors(page, ['--graph-bg', '--bg']);
  expect(colors['--graph-bg']).toEqual(colors['--bg']);
  await expectDotGrid(page, '#traceGraphCanvas', state, colors['--graph-bg']);
  // The canvas takes the keyboard and the global focus ring.
  await page.locator('#traceGraphCanvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#traceGraphCanvas')).toBeFocused();
  expect(await page.locator('#traceGraphCanvas').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('trace graph: fit, zoom tools and keys, the minimap once a card is clipped; the legend folds when the graph needs its room', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGraph(page);
  let state = await inspectGraph(page);
  const fitted = state;
  // It fits beside the legend: everything in the free area, no minimap.
  await expect(legendToggle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#traceGraphLegend')).toBeVisible();
  expect(state.minimapVisible).toBe(false);
  expect(state.scale).toBeGreaterThanOrEqual(state.readableScale - 1e-6);
  const free = await freeArea(page, '#traceGraphCanvas');
  for (const n of state.nodes) expect(inside(n, free), n.label).toBe(true);
  for (let i = 0; i < 5 && !(await inspectGraph(page)).minimapVisible; i += 1) await page.locator('#traceGraphZoomIn').click();
  state = await inspectGraph(page);
  expect(state.scale).toBeGreaterThan(fitted.scale);
  expect(state.minimapVisible).toBe(true);
  await expect(page.locator('#traceGraphMinimap')).toBeVisible();
  await page.locator('#traceGraphFit').click();
  state = await inspectGraph(page);
  expect(state.scale).toBeCloseTo(fitted.scale, 6);
  expect(state.offsetX).toBeCloseTo(fitted.offsetX, 3);
  expect(state.offsetY).toBeCloseTo(fitted.offsetY, 3);
  const canvas = page.locator('#traceGraphCanvas');
  await canvas.focus();
  await page.keyboard.press('+');
  const zoomed = (await inspectGraph(page)).scale;
  expect(zoomed).toBeGreaterThan(fitted.scale);
  await page.keyboard.press('-');
  expect((await inspectGraph(page)).scale).toBeLessThan(zoomed);
  await page.keyboard.press('0');
  expect((await inspectGraph(page)).scale).toBeCloseTo(fitted.scale, 6);
  // Wheel zoom and drag pan.
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 40);
  await page.mouse.wheel(0, -200);
  expect((await inspectGraph(page)).scale).not.toBeCloseTo(fitted.scale, 3);
  const before = await inspectGraph(page);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height - 80, { steps: 5 });
  await page.mouse.up();
  expect((await inspectGraph(page)).offsetX).not.toBeCloseTo(before.offsetX, 0);
  await page.keyboard.press('0');

  // Narrower: the graph no longer fits beside the legend at the readable
  // scale, so the legend folds; still slightly too large, Fit opens at the
  // readable scale on the root (full cards), the minimap giving the rest.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(legendToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#traceGraphLegend')).toBeHidden();
  await settle(page);
  state = await inspectGraph(page);
  const root = state.nodes.find((n) => n.label === 'frontend GET /checkout');
  expect(await expectFit(page, { canvas: '#traceGraphCanvas', minimap: '#traceGraphMinimap' }, state, root.id)).toBe('anchored');
  expect(state.compact).toBe(false);
  await expectClearOfChrome(page, '#traceGraphPane', { nodes: [root], edgeLabels: [] });
  // The viewer opens it: a choice the next fits keep (they leave room for it).
  await legendToggle(page).click();
  await expect(page.locator('#traceGraphLegend')).toBeVisible();
  await expect(legendToggle(page)).toHaveAttribute('aria-label', 'Hide the legend');
  expect(await page.evaluate(() => localStorage.getItem('chdash.graphLegend'))).toBe('shown');
  await page.locator('#traceGraphFit').click();
  await expect(page.locator('#traceGraphLegend')).toBeVisible();
  await expectClearOfChrome(page, '#traceGraphPane', { nodes: [root], edgeLabels: [] });
  // Folded by the viewer, it stays folded, also on a wide screen and after a reload.
  await legendToggle(page).click();
  expect(await page.evaluate(() => localStorage.getItem('chdash.graphLegend'))).toBe('hidden');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.reload();
  await expect.poll(async () => (await page.evaluate(() => window.ChDash?.traceGraph?.inspect?.().nodes.length || 0)), { timeout: 20_000 }).toBe(8);
  await expect(legendToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#traceGraphLegend')).toBeHidden();
});

// O1: a compact card is never the service alone ("frontend" x5): its title
// row reads "service \u00b7 operation" and the call path's time, and it shrinks
// to that row. A full card shows service, operation, counts and times.
test('trace graph: every card shows its operation and time, compact cards "service · operation" and the duration', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openGraph(page);
  await cameraIdle(page, 'ChDash.traceGraph');
  let state = await inspectGraph(page);
  expect(state.compact, 'the 1440 open shows full cards').toBe(false);
  await expectLevelOfDetail(page, state, { cardHeight: 82, minFont: 12 });
  for (const n of state.nodes) expect(n.shown, n.label).toEqual([n.service, n.operation, n.countText, n.timeText]);
  // A small window: the graph is far larger than the view, Fit opens on the
  // whole graph with compact cards.
  await page.setViewportSize({ width: 900, height: 640 });
  await expect.poll(async () => (await inspectGraph(page)).compact).toBe(true);
  await settle(page);
  state = await inspectGraph(page);
  await expectLevelOfDetail(page, state, { cardHeight: 82, minFont: 12 });
  const titles = state.nodes.map((n) => n.shown[0]);
  for (const n of state.nodes) {
    expect(n.shown[0], n.label).toBe(`${n.service} \u00b7 ${n.operation}`);
    expect(n.shown[1], n.label).toMatch(/^[\d.]+ (ms|s|\u00b5s|ns)$/);
  }
  expect(state.nodes.find((n) => n.label === 'checkout SELECT orders').shown[1]).toBe('25 ms');
  // Call paths of one service stay apart.
  expect(new Set(titles).size).toBe(state.nodes.length);
});

test('trace graph: hover outlines the card; a click recentres on it and opens its panel; the panel jumps to its spans in the timeline', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openGraph(page);
  const D = await graphNode(page, 'payments charge');
  const other = await graphNode(page, 'checkout SELECT orders');
  const halo = (await tokenColors(page, ['--graph-halo']))['--graph-halo'];
  const top = (n) => pixel(page, '#traceGraphCanvas', n.x + n.width / 2, n.y + 0.5);
  const beforeD = await top(D);
  const beforeOther = await top(other);
  await page.mouse.move(D.x + D.width / 2, D.y + D.height / 2);
  await settle(page);
  expect((await inspectGraph(page)).hovered).toEqual({ type: 'node', id: D.id });
  await expect(page.locator('#traceGraphCanvas')).toHaveClass(/is-clickable/);
  expect(colorDistance(await top(D), halo)).toBeLessThan(colorDistance(beforeD, halo));
  expect(colorDistance(await top(other), beforeOther)).toBeLessThan(2);
  await expect(page.locator('#traceGraphPane [role="tooltip"]')).toHaveCount(0);

  await page.mouse.click(D.x + D.width / 2, D.y + D.height / 2);
  const panel = page.locator('#traceGraphPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/graphKitPanel/);
  await expect(panel.locator('.graphKitPanel__eyebrow')).toHaveText('Call path');
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('payments');
  await expect(panel.locator('.graphKitPanel__subtitle')).toHaveText('charge');
  await expect(panel.locator('.graphKitPanel__stats')).toContainText('73.3%');
  await expect(panel).toContainText('Called from');
  await expect(panel.locator('[data-graph-select]')).toHaveText([/frontend\s*GET \/checkout/, /checkout\s*POST \/cart\/checkout/, /payments\s*fraud\.check/]);
  await cameraIdle(page, 'ChDash.traceGraph');
  let state = await inspectGraph(page);
  expect(state.selected).toBe(D.id);
  // Recentred in the area the panel and the chrome leave free.
  const free = await freeArea(page, '#traceGraphCanvas', '#traceGraphPanel');
  const moved = state.nodes.find((n) => n.id === D.id);
  expect(Math.abs(centre(moved).x - (free.x + free.width / 2))).toBeLessThan(3);
  expect(Math.abs(centre(moved).y - (free.y + free.height / 2))).toBeLessThan(3);
  expect(moved.x + moved.width).toBeLessThan((await panel.boundingBox()).x);
  // A caller in the panel selects it.
  await panel.locator('[data-graph-select]').first().click();
  await expect(panel.locator('.graphKitPanel__title')).toHaveText('frontend');
  // Escape closes; the keyboard opens the call path it lands on.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.locator('#traceGraphCanvas').focus();
  await page.keyboard.press('ArrowRight');
  state = await inspectGraph(page);
  expect(state.keyboardId).toBeTruthy();
  const chosen = state.nodes.find((n) => n.id === state.keyboardId);
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.graphKitPanel__title')).toHaveText(chosen.service);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // The panel's button focuses the span in the timeline; Back returns to the graph.
  await cameraIdle(page, 'ChDash.traceGraph');
  const again = await graphNode(page, 'payments charge');
  await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
  await panel.getByRole('button', { name: 'Show in the timeline' }).click();
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?span=${ID.D}$`));
  await expect(inspector(page, ID.D)).toBeVisible();
  await page.goBack();
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await expect(page).toHaveURL(/\?tab=graph$/);
  // A call path of two spans lists both: the second one jumps to C2.
  await expect.poll(async () => (await inspectGraph(page)).nodes.length).toBe(8);
  await cameraIdle(page, 'ChDash.traceGraph');
  const S = await graphNode(page, 'checkout SELECT orders');
  await page.mouse.click(S.x + S.width / 2, S.y + S.height / 2);
  await expect(panel.locator('.traceGraphPanel__spans [data-graph-span]')).toHaveCount(2);
  await panel.locator(`.traceGraphPanel__spans [data-graph-span="${ID.C2}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?span=${ID.C2}$`));
  await expect(inspector(page, ID.C2)).toBeVisible();
});

test('trace graph: Time and Self time fill the cards with a heat between --graph-node-bg and --graph-heat, readable in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await mockTraces(page);
    await page.goto('/observability/traces');
    await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
    await openGraph(page);
    const tokens = await tokenColors(page, ['--graph-node-bg', '--graph-heat', '--graph-text', '--graph-muted']);
    const bg = tokens['--graph-node-bg'];
    const heat = tokens['--graph-heat'];
    // Inside the card's bottom-right corner, clear of the text rows.
    const fillAt = (n) => pixel(page, '#traceGraphCanvas', n.x + n.width - 8 * (n.width / 264), n.y + n.height - 6 * (n.height / 82));
    let D = await graphNode(page, 'payments charge');
    expect(D.heat).toBe(null);
    expect(colorDistance(await fillAt(D), bg)).toBeLessThan(4);

    await pickGraphColour(page, 'Time');
    await expect(page.locator('#traceGraphLegend')).toContainText('time: 0');
    expect((await inspectGraph(page)).mode).toBe('time');
    D = await graphNode(page, 'payments charge');
    const H = await graphNode(page, 'frontend hydrate');
    // 28.57 % of the trace: past 20 %, the full heat (45 % of --graph-heat).
    expect(D.heat).toBe(1);
    expect(colorDistance(await fillAt(D), mix(bg, heat, 0.45)), `${theme} hot fill`).toBeLessThan(6);
    // 14.29 % of the trace: 71 % of the heat.
    expect(H.heat).toBeCloseTo(15 / 105 / 0.2, 3);
    expect(colorDistance(await fillAt(H), mix(bg, heat, 0.32)), `${theme} warm fill`).toBeLessThan(6);
    // Text keeps its contrast on the hottest fill.
    const hot = mix(bg, heat, 0.45);
    expect(contrast(tokens['--graph-text'], hot), `${theme} text on heat`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['--graph-muted'], hot), `${theme} muted on heat`).toBeGreaterThanOrEqual(4.5);

    await pickGraphColour(page, 'Self time');
    await expect(page.locator('#traceGraphLegend')).toContainText('self time: 0');
    D = await graphNode(page, 'payments charge');
    expect(D.heat).toBeCloseTo(22 / 30, 3);
    expect(colorDistance(await fillAt(D), mix(bg, heat, 0.33)), `${theme} self-time fill`).toBeLessThan(6);
    await pickGraphColour(page, 'Service');
    expect(colorDistance(await fillAt(await graphNode(page, 'payments charge')), bg)).toBeLessThan(4);
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});

test.describe('trace graph on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('trace graph: phones show the canvas (no list), pan and pinch by touch and open a call path as a bottom sheet', async ({ page }) => {
    await openGraph(page);
    // T-E2: a phone opens on the root and its callees at 0.7 or more (full
    // cards, 8 px text at the least), never the whole graph at ~6 px.
    await cameraIdle(page, 'ChDash.traceGraph');
    const opened = await inspectGraph(page);
    const first = opened.nodes.find((n) => n.label === 'frontend GET /checkout');
    expect(await expectFit(page, { canvas: '#traceGraphCanvas', minimap: '#traceGraphMinimap' }, opened, first.id)).toBe('anchored');
    expect(opened.scale).toBeGreaterThanOrEqual(0.7 - 1e-6);
    expect(opened.compact).toBe(false);
    await expect(page.locator('#traceGraphList, #traceGraphListViewButton, #traceGraphCanvasViewButton')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await expectTouchCanvas(page, { pane: '#traceGraphPane', canvas: '#traceGraphCanvas', zoomIn: '#traceGraphZoomIn', inspect: () => inspectGraph(page) });
    // Fit from the icon toolbar (the root opens top-left), then tap it.
    await page.locator('#traceGraphFit').tap();
    await settle(page);
    const root = await graphNode(page, 'frontend GET /checkout');
    await page.touchscreen.tap(root.x + root.width / 2, root.y + root.height / 2);
    const panel = page.locator('#traceGraphPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.graphKitPanel__title')).toHaveText('frontend');
    const pane = await page.locator('#traceGraphPane').boundingBox();
    const sheet = await panel.boundingBox();
    expect(sheet.width).toBeGreaterThan(390 - 40);
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(pane.y + pane.height + 1);
    // Recentred above the sheet.
    await cameraIdle(page, 'ChDash.traceGraph');
    const moved = await graphNode(page, 'frontend GET /checkout');
    expect(moved.y + moved.height / 2).toBeLessThan(sheet.y);
    await panel.getByRole('button', { name: 'Show in the timeline' }).tap();
    await expect(page.locator('.traceTimelineFrame')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?span=${ID.A}$`));
    await page.goBack();
    await expect(page.locator('#traceGraphCanvas')).toBeVisible();
    await expect(page.locator('#traceGraphZoomIn')).toBeVisible();
  });
});

// 10,000 spans whose call paths stay under the graph's limit: per level the
// operation comes from a 4-letter alphabet (at most 4 + 16 + ... + 4^5 paths).
function pathTrace(count = 10_000, fanout = 4, depth = 5, traceId = 'beef0000000000000000000000010000') {
  const services = ['gateway', 'orders', 'billing', 'stock', 'search', 'users', 'mailer', 'ledger'];
  const hex = (v) => v.toString(16).padStart(16, '0');
  const spans = [{ span_id: hex(1), name: 'GET /bulk', service: 'gateway', kind: 'Server', start_ms: 0, duration_ms: 4000, level: 0 }];
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 2; i <= count; i += 1) {
    let parent = spans[Math.floor(rand() * spans.length)];
    if (parent.level >= depth) parent = spans[Math.floor(rand() * Math.min(spans.length, 50))];
    if (parent.level >= depth) parent = spans[0];
    const pick = Math.floor(rand() * fanout);
    const start = parent.start_ms + rand() * parent.duration_ms * 0.8;
    spans.push({
      span_id: hex(i), parent_span_id: parent.span_id, name: `op-${parent.level + 1}-${pick}`,
      service: services[(parent.level + 1 + pick) % services.length], start_ms: start,
      duration_ms: Math.max(0.01, (parent.start_ms + parent.duration_ms - start) * rand() * 0.9),
      level: parent.level + 1, error: i % 97 === 0, attributes: pick === 3 ? { 'db.system': 'postgresql' } : {},
    });
  }
  return { trace_id: traceId, spans };
}

test('performance budget: the graph of a 10,000-span trace builds, routes and draws within budget; past the call-path limit the view says so', async ({ page }) => {
  test.setTimeout(120_000);
  const big = pathTrace();
  await routeTrace(page, big);
  await page.goto(`/observability/traces/${big.trace_id}`);
  await expect(page.locator(`#traceWaterfall .traceWaterfallBody[data-virtual-rows="${big.spans.length}"]`)).toHaveCount(1, { timeout: 30_000 });
  // Graph build (call paths, layout, routes, labels) and the first frame.
  const ms = await page.evaluate(() => new Promise((resolve) => {
    const started = performance.now();
    window.ChDash.traceViews.setView('graph', { url: null, persist: false });
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
  }));
  console.log(`trace graph of ${big.spans.length} spans: built and drawn in ${Math.round(ms)} ms`);
  expect(ms, 'graph build + first draw (ms)').toBeLessThan(2500);
  const state = await inspectGraph(page);
  expect(state.nodes.length).toBeGreaterThan(500);
  expect(state.nodes.length).toBeLessThanOrEqual(1500);
  expect(state.timing.routeMs, 'routing (ms)').toBeLessThan(1500);
  for (const e of state.edges) expect(e.orthogonal, e.id).toBe(true);
  expect(state.edgeLabelsDropped.length, 'labels without a free spot').toBeLessThan(state.edges.length * 0.05);
  expectLabelsClear({ ...state, edgeLabelsDropped: [] });
  // Pan frames stay cheap (cards, edges and labels off screen are skipped).
  const box = await page.locator('#traceGraphCanvas').boundingBox();
  const pan = await measureFrames(page, async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i < 20; i += 1) { await page.mouse.move(box.x + box.width / 2 - i * 9, box.y + box.height / 2 - i * 14); await settle(page); }
    await page.mouse.up();
  });
  expect(pan.p95, 'pan frame p95 (ms)').toBeLessThan(25);
  // The 10,000-span fixture trace has 8,612 call paths: over the limit.
  const fixture = largeTrace(10_000, 'bead0000000000000000000000010000', 8);
  await routeTrace(page, fixture);
  await page.goto(`/observability/traces/${fixture.trace_id}?tab=graph`);
  await expect(page.locator('#traceAltView')).toContainText('distinct call paths: too many to draw (limit 1500)', { timeout: 30_000 });
});

test('trace view persists in the URL and in localStorage; timeline by default', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceViewSelect')).toHaveValue('timeline');
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(page.locator('#traceAltView')).toBeHidden();
  await pickView(page, 'Graph');
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}\\?tab=graph$`));
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('graph');
  await page.reload();
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await expect(viewTabs(page).locator('[aria-selected="true"]')).toHaveText('Graph');
  // Without ?tab=, the stored view opens (and shows in the URL).
  await page.goto(`/observability/traces/${TRACE_ID}`);
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await expect(page).toHaveURL(/\?tab=graph$/);
  // ?tab= wins over the stored one; a deep link opens the timeline.
  await page.goto(`/observability/traces/${TRACE_ID}?tab=statistics`);
  await expect(page.locator('#traceAltView .traceStats')).toBeVisible();
  await page.goto(`/observability/traces/${TRACE_ID}?span=${ID.C}`);
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(inspector(page, ID.C)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('statistics');
  await expect(viewTabs(page).getByRole('tab')).toHaveText(['Timeline', 'Graph', 'Statistics', 'Spans', 'Flamegraph']);
  await pickView(page, 'Flamegraph');
  await pickView(page, 'Timeline');
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('timeline');
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}$`));
  await page.goto(`/observability/traces/${TRACE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}$`));
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
});

test('trace views: no horizontal page overflow and readable in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await mockTraces(page);
    await page.goto('/observability/traces');
    await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
    for (const [name, query] of [['timeline', '?tab=timeline'], ['statistics', '?tab=statistics'], ['spans', '?tab=spans'], ['flamegraph', '?tab=flamegraph'], ['graph', '?tab=graph']]) {
      await page.goto(`/observability/traces/${TRACE_ID}${query}`);
      await expect(page.locator('#traceDetail')).toBeVisible();
      if (name === 'timeline') {
        await openSpan(page, ID.A);
        const card = inspector(page, ID.A);
        await card.locator('[data-span-section="tags"] > summary').click();
        await card.locator('[data-span-section="events"] > summary').click();
      } else {
        await expect(page.locator('#traceAltView > *')).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${theme} ${name}`).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(theme);
      if (process.env.TRACE_SHOTS) {
        const vp = page.viewportSize();
        await page.screenshot({ path: `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/trace-views/${name}-${theme}-${vp.width}.png` });
      }
    }
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});


test('trace views: a tab row with arrow / Home / End keys that follows ?tab= and Back / Forward, a dropdown below 820 px', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(MOCK_SPANS.length, { timeout: 30_000 });
  const tabs = viewTabs(page);
  await expect(tabs).toBeVisible();
  await expect(tabs).toHaveAttribute('role', 'tablist');
  await expect(viewPicker(page)).toBeHidden();
  // The Logs Results / Patterns tab look: one in-content tab component.
  const look = (el) => { const cs = getComputedStyle(el); return [cs.fontSize, cs.fontWeight, cs.height, cs.borderBottomWidth, cs.borderBottomStyle]; };
  expect(await viewTab(page, 'Timeline').evaluate(look)).toEqual(['13px', '600', '28px', '2px', 'solid']);
  // Roving tabindex: Tab reaches the selected tab only.
  await expect(tabs.locator('[tabindex="0"]')).toHaveText('Timeline');
  await expect(viewTab(page, 'Timeline')).toHaveAttribute('aria-controls', 'traceTimelineFrame');
  await expect(viewTab(page, 'Graph')).toHaveAttribute('aria-controls', 'traceAltView');
  await viewTab(page, 'Timeline').focus();
  await page.keyboard.press('ArrowRight');
  await expect(viewTab(page, 'Graph')).toBeFocused();
  await expect(viewTab(page, 'Graph')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\?tab=graph$/);
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await page.keyboard.press('End');
  await expect(viewTab(page, 'Flamegraph')).toBeFocused();
  await expect(page).toHaveURL(/\?tab=flamegraph$/);
  await page.keyboard.press('ArrowRight');
  await expect(viewTab(page, 'Timeline')).toBeFocused();
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/\?tab=flamegraph$/);
  await page.keyboard.press('Home');
  await expect(viewTab(page, 'Timeline')).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
  // The view is the URL's ?tab= (replaced, as before the tabs); Back and
  // Forward over a deep-linked span bring the view and its tab back.
  await pickView(page, 'Spans');
  await expect(page).toHaveURL(/\?tab=spans$/);
  await page.locator(`#traceAltView tr[data-table-span="${ID.C}"]`).click();
  await expect(page).toHaveURL(new RegExp(`\\?span=${ID.C}$`));
  await expect(viewTab(page, 'Timeline')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(page).toHaveURL(/\?tab=spans$/);
  await expect(viewTab(page, 'Spans')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#traceAltView .traceSpansTable')).toBeVisible();
  await page.goForward();
  await expect(viewTab(page, 'Timeline')).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page, ID.C)).toBeVisible();
  await page.goto(`/observability/traces/${TRACE_ID}?tab=statistics`);
  await expect(page.locator('#traceAltView .traceStats')).toBeVisible();
  await expect(viewTab(page, 'Statistics')).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.locator('[tabindex="0"]')).toHaveText('Statistics');

  // Below 820 px: the dropdown, listing the other views; the tabs follow it.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(tabs).toBeHidden();
  await expect(viewPicker(page)).toBeVisible();
  await expect(viewPicker(page).locator('.tracePicker__button')).toHaveText('View \u00b7 Statistics');
  await viewPicker(page).locator('.tracePicker__button').click();
  await expect(viewPicker(page).locator('.tracePicker__menu [role="option"]:visible')).toHaveText(['Timeline', 'Graph', 'Spans', 'Flamegraph']);
  await viewPicker(page).locator('.tracePicker__menu').getByRole('option', { name: 'Spans', exact: true }).click();
  await expect(page).toHaveURL(/\?tab=spans$/);
  await expect(page.locator('#traceAltView .traceSpansTable')).toBeVisible();
  await expect(page.locator('#traceViewSelect')).toHaveValue('spans');
  await expect(viewPicker(page).locator('.tracePicker__button')).toHaveText('View \u00b7 Spans');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(viewPicker(page)).toBeHidden();
  await expect(viewTab(page, 'Spans')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
