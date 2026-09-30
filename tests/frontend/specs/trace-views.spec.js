import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// Span detail inspector (Jaeger's SpanDetail) and the alternative trace views
// (Trace Graph / Statistics / Spans Table / Flamegraph) on a mocked trace:
// the OTel fixture only holds flat traces without events, links or JSON
// attributes.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
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
  await page.goto(`/traces/${TRACE_ID}${query}`);
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

async function pickView(page, label) {
  await page.locator('#traceViewBar .traceViewBar__picker .tracePicker__button').click();
  await page.locator('#traceViewBar .traceViewBar__picker .tracePicker__menu').getByRole('option', { name: label, exact: true }).click();
}

async function pickTool(page, selectId, label) {
  const root = page.locator(`#traceViewTools .tracePicker:has(#${selectId})`);
  await root.locator('.tracePicker__button').click();
  await root.locator('.tracePicker__menu').getByRole('option', { name: label, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('__traceViewsInit')) { localStorage.removeItem('chdash.traceView'); sessionStorage.setItem('__traceViewsInit', '1'); } } catch (_) {} });
});

test('span inspector: attribute table layout, typed values, JSON trees and per-row copy', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(MOCK_SPANS.length, { timeout: 30_000 });
  await openSpan(page, ID.A);
  const card = inspector(page, ID.A);
  await expect(card).toBeVisible();
  const tags = card.locator('[data-span-section="tags"]');
  // Collapsed: the k=v preview beside the label; open: the table only.
  await expect(tags.locator(':scope > summary .traceJaegerSummaryPreview')).toBeVisible();
  await expect(tags.locator(':scope > summary')).toContainText('Tags:');
  await tags.locator(':scope > summary').click();
  await expect(tags.locator(':scope > summary .traceJaegerSummaryPreview')).toBeHidden();
  await expect(tags.locator(':scope > summary')).toHaveText('Tags', { useInnerText: true });
  const table = tags.locator('.traceKv');
  await expect(table).toBeVisible();

  // The value column starts right after the longest key (capped at 40 %).
  const layout = await table.evaluate((el) => {
    const t = el.getBoundingClientRect();
    const keys = [...el.querySelectorAll('.traceKv__row:not(.traceKv__row--tree) > .traceKv__key')];
    const cells = [...el.querySelectorAll('.traceKv__row:not(.traceKv__row--tree) > .traceKv__cell')];
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
  const kv = (key) => table.locator(`.traceKv__row[data-kv-key="${key}"]`);
  await expect(kv('http.status_code').locator('.traceKv__v')).toHaveClass(/traceKv__v--number/);
  await expect(kv('cache.hit').locator('.traceKv__v')).toHaveClass(/traceKv__v--bool/);
  await expect(kv('http.method').locator('.traceKv__v')).toHaveClass(/traceKv__v--string/);
  const colours = await Promise.all(['http.status_code', 'cache.hit', 'http.method'].map((key) => kv(key).locator('.traceKv__v').evaluate((el) => getComputedStyle(el).color)));
  expect(new Set(colours).size).toBe(3);
  await expect(kv('otel.scope.name').locator('.traceKv__key')).toHaveCSS('font-style', 'italic');
  await expect(kv('http.method').locator('.traceKv__key')).toHaveCSS('font-style', 'normal');
  // HTTP header arrays are a plain list.
  await expect(kv('http.request.header.accept').locator('.traceKv__cell')).toContainText('text/html, application/json');

  // JSON-looking strings: a pretty tree on its own full-width row; a value of
  // at most 10 keys opens fully, a larger one keeps nested levels closed.
  const cart = kv('app.cart');
  await expect(cart).toHaveClass(/traceKv__row--tree/);
  await expect(cart.locator('.traceJson').first()).toHaveAttribute('open', '');
  expect(await cart.locator('details.traceJson').evaluateAll((els) => els.every((el) => el.open))).toBe(true);
  await expect(cart.locator('.traceJson__key').first()).toHaveText('items');
  await expect(cart.locator('.traceKv__v--null')).toHaveText('null');
  const flags = kv('app.flags');
  expect(await flags.locator('details.traceJson').evaluateAll((els) => els.map((el) => el.open))).toEqual([true, false]);
  await flags.locator('details.traceJson details.traceJson > summary').click();
  expect(await flags.locator('details.traceJson').evaluateAll((els) => els.map((el) => el.open))).toEqual([true, true]);
  const cartBox = await cart.locator('.traceKv__cell').boundingBox();
  const tableBox = await table.boundingBox();
  expect(cartBox.x - tableBox.x).toBeLessThan(12);

  // Copy (value) / JSON actions appear on hover.
  const status = kv('http.status_code');
  await expect(status.locator('[data-kv-copy="value"]')).toBeHidden();
  await status.hover();
  await expect(status.locator('[data-kv-copy="value"]')).toBeVisible();
  await captureCopies(page);
  await status.locator('[data-kv-copy="value"]').click();
  await expect.poll(() => lastCopy(page)).toBe('200');
  await status.locator('[data-kv-copy="json"]').click();
  await expect.poll(() => lastCopy(page)).toBe(JSON.stringify({ key: 'http.status_code', value: '200' }, null, 2));
  await cart.hover();
  await cart.locator('[data-kv-copy="value"]').click();
  await expect.poll(() => lastCopy(page)).toBe(MOCK_SPANS[0].span_attributes && JSON.parse(MOCK_SPANS[0].span_attributes)['app.cart']);
  // The row stays open: copying does not toggle the span.
  await expect(card).toBeVisible();

  // Process (resource) section: same accordion.
  const process = card.locator('[data-span-section="process"]');
  await expect(process.locator(':scope > summary .traceJaegerSummaryPreview')).toContainText('host.name=web-1');
  await process.locator(':scope > summary').click();
  await expect(process.locator('.traceKv__row[data-kv-key="host.name"] .traceKv__v')).toHaveText('web-1');
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
  await expect(items.first().locator('time')).toHaveAttribute('title', /12:00:00\.001.*2026-09-19 12:00:00\.001000000 UTC/);
  await events.locator('[data-events-more]').click();
  await expect(events.locator('.traceSpanEvents__list > .traceSpanEvent:visible > summary > b')).toHaveText(['request.received', 'session.found', 'auth.checked', 'render.start', 'cart.loaded']);
  await expect(items.nth(4).locator('time')).toHaveText('(50.1 ms)');
  await expect(events.locator('[data-events-more]')).toHaveText('show less');
  // An event's attributes: preview while collapsed, table once open.
  const auth = items.nth(2);
  await expect(auth.locator(':scope > summary .traceJaegerSummaryPreview')).toContainText('auth.method=cookie');
  await auth.locator(':scope > summary').click();
  await expect(auth.locator(':scope > summary .traceJaegerSummaryPreview')).toBeHidden();
  await expect(auth.locator('.traceKv__row[data-kv-key="auth.method"] .traceKv__v')).toHaveText('cookie');
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
  await expect(items.nth(1).locator('.traceKv__row[data-kv-key="link.reason"]')).toContainText('retry');
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
  await expect(page).toHaveURL(new RegExp(`/traces/${OTHER_TRACE_ID}\\?span=${OTHER_SPAN_ID}$`));
  await expect(row(page, OTHER_SPAN_ID)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, OTHER_SPAN_ID)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/traces/${TRACE_ID}\\?span=${ID.B}$`));
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
  await expect(meta.locator('[title*="2026-09-19 12:00:00.030000000 UTC"]')).toHaveCount(1);
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
  await expect.poll(() => lastCopy(page)).toMatch(new RegExp(`/traces/${TRACE_ID}\\?span=${ID.D}$`));
  const deepLink = await lastCopy(page);
  expect(new URL(deepLink).origin).toBe(new URL(page.url()).origin);

  // Closing the span drops it from the URL.
  await openSpan(page, ID.D);
  await expect(card).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('span')).toBe(null);

  // Opening the deep link: the span's inspector is open, scrolled to, highlighted.
  await page.goto('/traces');
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

test('trace statistics: self time, grouping, sub-groups, sorting and heat colouring', async ({ page }) => {
  await openTrace(page);
  await pickView(page, 'Trace Statistics');
  await expect(page).toHaveURL(/\?view=statistics$/);
  await expect(page.locator('.traceTimelineFrame')).toBeHidden();
  await expect(page.locator('#traceOverview')).toBeHidden();
  const table = page.locator('#traceAltView .traceStats__table');
  await expect(table).toBeVisible();
  const cells = (group) => table.locator(`tr[data-stats-group="${group}"] > *`);
  // Default sort: count, descending (Jaeger's); ties by name.
  await expect(table.locator('tbody tr > th')).toHaveText(['checkout', 'frontend', 'payments', 'fraud']);
  // By hand: frontend = A (100 ms, self 100 - 80 = 20), G (20 ms; child H
  // clipped at G's end: self 15), H (15 ms, self 15).
  await expect(cells('frontend')).toHaveText(['frontend', '3', '135 ms', '45 ms', '15 ms', '100 ms', '50 ms', '16.7 ms', '15 ms', '20 ms', '37.04%']);
  // checkout = B (60 ms; children cover [15, 60]: self 15), C (20), C2 (5).
  await expect(cells('checkout')).toHaveText(['checkout', '3', '85 ms', '28.3 ms', '5 ms', '60 ms', '40 ms', '13.3 ms', '5 ms', '20 ms', '47.06%']);
  // payments = D (30 ms, child E 8 ms: self 22), E (8 ms, child F 5 ms: self 3).
  await expect(cells('payments')).toHaveText(['payments', '2', '38 ms', '19 ms', '8 ms', '30 ms', '25 ms', '12.5 ms', '3 ms', '22 ms', '65.79%']);
  await expect(cells('fraud')).toHaveText(['fraud', '1', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '5 ms', '100.00%']);
  // Service colour on the group cell.
  expect(await table.locator('tr[data-stats-group="frontend"] > th').evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/inset/);

  // Sorting: a header click sorts descending by it, a second click ascending.
  await table.getByRole('button', { name: 'ST Total' }).click();
  await expect(table.locator('tbody tr > th')).toHaveText(['frontend', 'checkout', 'payments', 'fraud']);
  await table.getByRole('button', { name: /ST Total/ }).click();
  await expect(table.locator('tbody tr > th')).toHaveText(['fraud', 'payments', 'checkout', 'frontend']);

  // Heat colouring by a column: 8 % to 60 % of the column maximum.
  await pickTool(page, 'traceStatsColorBy', 'Total');
  const weight = (group) => table.locator(`tr[data-stats-group="${group}"]`).evaluate((el) => el.style.getPropertyValue('--trace-heat-weight'));
  expect(await weight('frontend')).toBe('60%');
  expect(await weight('checkout')).toBe(`${Math.round((8 + (85 / 135) * 52) * 100) / 100}%`);
  expect(await table.locator('tr[data-stats-group="frontend"] > td').first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');

  // Group by operation, then service + operation.
  await pickTool(page, 'traceStatsGroupBy', 'Operation Name');
  await expect(cells('SELECT orders').nth(1)).toHaveText('2');
  await expect(cells('SELECT orders').nth(2)).toHaveText('25 ms');
  await pickTool(page, 'traceStatsGroupBy', 'Service & Operation');
  await expect(table.locator('tbody tr')).toHaveCount(8);
  await expect(cells('checkout · SELECT orders').nth(1)).toHaveText('2');

  // Service, sub-grouped by operation: detail rows under each service.
  await pickTool(page, 'traceStatsGroupBy', 'Service Name');
  await pickTool(page, 'traceStatsSubGroup', 'Operation Name');
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
  await pickView(page, 'Trace Spans Table');
  await expect(page).toHaveURL(/\?view=spans$/);
  const table = page.locator('#traceAltView .traceSpansTable__table');
  await expect(table.locator('tbody tr')).toHaveCount(9);
  await expect(page.locator('#traceSpansCount')).toHaveText('9 of 9 spans');
  // Default: start order.
  await expect(table.locator('tbody td[data-col="start"]')).toHaveText(['0 ns', '10 ms', '15 ms', '30 ms', '32 ms', '33 ms', '40 ms', '75 ms', '90 ms']);
  await table.getByRole('button', { name: 'Duration' }).click();
  await expect(table.locator('tbody td[data-col="duration"]')).toHaveText(['100 ms', '60 ms', '30 ms', '20 ms', '20 ms', '15 ms', '8 ms', '5 ms', '5 ms']);
  await expect(table.locator('tbody td[data-col="operation"]')).toHaveText(['GET /checkout', 'POST /cart/checkout', 'charge', 'SELECT orders', 'render', 'hydrate', 'fraud.check', 'score', 'SELECT orders']);
  await table.getByRole('button', { name: /Duration/ }).click();
  await expect(table.locator('tbody td[data-col="duration"]').first()).toHaveText('5 ms');
  await table.getByRole('button', { name: 'Service Name' }).click();
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
  await pickView(page, 'Trace Timeline');
  await row(page, ID.A).locator('[data-toggle-span]').click();
  await expect(row(page, ID.F)).toHaveCount(0);
  await pickView(page, 'Trace Spans Table');
  await table.locator(`tr[data-table-span="${ID.F}"]`).click();
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/traces/${TRACE_ID}\\?span=${ID.F}$`));
  await expect(row(page, ID.F)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, ID.F)).toBeVisible();
  await expect(page.locator('#traceViewSelect')).toHaveValue('timeline');
  await page.goBack();
  await expect(page).toHaveURL(/\?view=spans$/);
  await expect(page.locator('#traceAltView .traceSpansTable')).toBeVisible();
  await page.goForward();
  await expect(inspector(page, ID.F)).toBeVisible();
});

test('trace flamegraph: widths follow durations, a click zooms into a frame, reset zooms out', async ({ page }) => {
  await openTrace(page, '?view=flamegraph');
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

test('trace graph: one node per call path with counts and times, edges between them', async ({ page }) => {
  await openTrace(page, '?view=graph');
  const graph = page.locator('#traceAltView .traceGraph');
  await expect(graph).toBeVisible();
  // SELECT orders twice under POST /cart/checkout: one node, count 2.
  await expect(graph.locator('.traceGraph__node')).toHaveCount(8);
  await expect(graph.locator('.traceGraph__edge')).toHaveCount(7);
  const node = (key) => graph.locator(`.traceGraph__node[data-graph-node="${key}"]`);
  await expect(node('checkout SELECT orders').locator('.traceGraph__count')).toHaveText('2 / 0');
  await expect(node('checkout SELECT orders').locator('.traceGraph__time')).toHaveText('25 ms (23.81%)');
  await expect(node('checkout SELECT orders').locator('.traceGraph__avg')).toHaveText('12.5 ms');
  await expect(node('payments charge').locator('.traceGraph__count')).toHaveText('1 / 1');
  await expect(node('payments charge').locator('.traceGraph__self')).toHaveText('22 ms (73.33%)');
  await expect(node('frontend GET /checkout').locator('.traceGraph__time')).toHaveText('100 ms (95.24%)');
  // Parents above their children.
  const top = (key) => node(key).evaluate((el) => parseFloat(el.style.top));
  expect(await top('frontend GET /checkout')).toBeLessThan(await top('checkout POST /cart/checkout'));
  expect(await top('checkout POST /cart/checkout')).toBeLessThan(await top('payments charge'));
  await pickTool(page, 'traceGraphMode', 'Self time');
  await expect(node('payments charge')).toHaveClass(/traceGraph__node--selftime/);
  expect(await node('payments charge').evaluate((el) => el.style.getPropertyValue('--trace-graph-heat'))).toBe('73.33%');
});

test('trace view persists in the URL and in localStorage; timeline by default', async ({ page }) => {
  await openTrace(page);
  await expect(page.locator('#traceViewSelect')).toHaveValue('timeline');
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(page.locator('#traceAltView')).toBeHidden();
  await pickView(page, 'Trace Graph');
  await expect(page).toHaveURL(new RegExp(`/traces/${TRACE_ID}\\?view=graph$`));
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('graph');
  await page.reload();
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await expect(page.locator('#traceViewBar .traceViewBar__picker .tracePicker__button')).toHaveText('Trace Graph');
  // Without ?view=, the stored view opens (and shows in the URL).
  await page.goto(`/traces/${TRACE_ID}`);
  await expect(page.locator('#traceAltView .traceGraph')).toBeVisible();
  await expect(page).toHaveURL(/\?view=graph$/);
  // ?view= wins over the stored one; a deep link opens the timeline.
  await page.goto(`/traces/${TRACE_ID}?view=statistics`);
  await expect(page.locator('#traceAltView .traceStats')).toBeVisible();
  await page.goto(`/traces/${TRACE_ID}?span=${ID.C}`);
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
  await expect(inspector(page, ID.C)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('statistics');
  // The menu lists the other views only.
  await page.locator('#traceViewBar .traceViewBar__picker .tracePicker__button').click();
  await expect(page.locator('#traceViewBar .traceViewBar__picker .tracePicker__menu [role="option"]:visible')).toHaveText(['Trace Graph', 'Trace Statistics', 'Trace Spans Table', 'Trace Flamegraph']);
  await page.locator('#traceViewBar .traceViewBar__picker .tracePicker__button').click();
  await pickView(page, 'Trace Flamegraph');
  await pickView(page, 'Trace Timeline');
  expect(await page.evaluate(() => localStorage.getItem('chdash.traceView'))).toBe('timeline');
  await expect(page).toHaveURL(new RegExp(`/traces/${TRACE_ID}$`));
  await page.goto(`/traces/${TRACE_ID}`);
  await expect(page).toHaveURL(new RegExp(`/traces/${TRACE_ID}$`));
  await expect(page.locator('.traceTimelineFrame')).toBeVisible();
});

test('trace views: no horizontal page overflow and readable in both themes', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await mockTraces(page);
    await page.goto('/traces');
    await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
    for (const [name, query] of [['timeline', '?view=timeline'], ['statistics', '?view=statistics'], ['spans', '?view=spans'], ['flamegraph', '?view=flamegraph'], ['graph', '?view=graph']]) {
      await page.goto(`/traces/${TRACE_ID}${query}`);
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
