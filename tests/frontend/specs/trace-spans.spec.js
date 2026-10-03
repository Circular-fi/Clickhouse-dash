import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { captureState } from '../helpers/review.js';

// Spans mode of the trace search page (HyperDX's row search): the mode in
// the URL, the virtualised span table with its column picker, infinite
// scroll by cursor, the span side panel (click-to-filter, Open in trace and
// Back) and keyboard navigation, against the live OTel fixture.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests.filter((r) => !/net::ERR_ABORTED/.test(r.error || ''))).toEqual([]);
});

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function otelRows(request, sql) {
  const base = (process.env.CLICKHOUSE_URL || 'http://clickhouse:8123').replace(/\/$/, '');
  const auth = Buffer.from(`${process.env.CLICKHOUSE_USER || 'test'}:${process.env.CLICKHOUSE_PASSWORD || 'test'}`).toString('base64');
  const response = await request.post(`${base}/`, { data: `${sql} FORMAT TSV`, headers: { Authorization: `Basic ${auth}` }, timeout: 60_000 });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.text()).split('\n').filter(Boolean).map((line) => line.split('\t'));
}

// Five minutes of the rich fixture day (2026-09-12 10:00-10:05,
// tests/README.md "Rich OTel dataset") as from / to: ~1.8 k spans of nine
// services (~550 Server spans, ~130 Ok or Error ones), more than the two
// pages any test reads, on every stack. Every Server span carries
// server.port; every span the resource host.name.
const WINDOW = 5 * 60_000;
const RICH_START = Date.UTC(2026, 8, 12, 10, 0, 0);
let dense = null;
async function denseWindow(request) {
  if (dense) return dense;
  const [[spans]] = await otelRows(request, `SELECT count() FROM otel.otel_traces WHERE Timestamp >= fromUnixTimestamp64Milli(${RICH_START}) AND Timestamp <= fromUnixTimestamp64Milli(${RICH_START + WINDOW})`);
  test.skip(!(Number(spans) > 300), 'the rich OTel dataset (2026-09-12) is not loaded');
  dense = { from: stamp(RICH_START), to: stamp(RICH_START + WINDOW) };
  return dense;
}

function tracesUrl(range, extra = {}) {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else params.set(key, value);
  }
  return `/observability/traces?${params.toString()}`;
}

// /api/traces/spans requests as URLSearchParams.
function spanRequests(page) {
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/traces/spans')) requests.push(url.searchParams);
  });
  return requests;
}

const rows = (page) => page.locator('#traceSpanTable .traceSpanListRow');
const panel = (page) => page.locator('#traceSpanPanel');

async function waitRows(page) {
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
}

async function freshColumns(page) {
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('spansTestInit')) { localStorage.removeItem('chdash.traceSpanColumns.v1'); sessionStorage.setItem('spansTestInit', '1'); } } catch (_) {} });
}

test('spans: the Traces | Spans toggle switches the results and lives in the URL', async ({ page, request }) => {
  const range = await denseWindow(request);
  const requests = spanRequests(page);
  await page.goto(tracesUrl(range, { status: 'Ok' }));
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-results-mode="traces"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#traceSpanTools')).toBeHidden();

  await page.locator('[data-results-mode="spans"]').click();
  await waitRows(page);
  await expect(page).toHaveURL(/[?&]mode=spans(&|$)/);
  await expect(page.locator('[data-results-mode="spans"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#traceSpanTools')).toBeVisible();
  await expect(page.locator('.traceResultsViewToggle')).toBeHidden();
  await expect(page.locator('.traceResultsSort')).toBeHidden();
  await expect(page.locator('#tracesResultCount')).toContainText(/Spans/);
  const first = requests[requests.length - 1];
  expect(first.get('status')).toBe('Ok');
  expect(first.get('limit')).toBe('100');
  expect(first.get('cursor')).toBeNull();
  expect(Number(first.get('end_ms')) - Number(first.get('start_ms'))).toBe(WINDOW);
  // Every listed span matches the (now span-level) status filter.
  const statuses = await rows(page).locator('.traceSpanListRow__cell--status').allTextContents();
  expect(statuses.length).toBeGreaterThan(10);
  expect(new Set(statuses)).toEqual(new Set(['OK']));

  // Kind and span duration filters join the URL and the request (the rich
  // day's Ok spans are Internal ones).
  await page.locator('#traceSpanTools .tracePicker__button').click();
  await page.locator('#traceSpanTools .tracePicker__option[data-value="Internal"]').click();
  await expect(page).toHaveURL(/[?&]kind=Internal(&|$)/);
  await waitRows(page);
  await expect.poll(() => requests[requests.length - 1].getAll('kind')).toEqual(['Internal', 'SPAN_KIND_INTERNAL']);
  await page.locator('#traceSpanMinDuration').fill('20');
  await page.locator('#traceSpanMinDuration').press('Enter');
  await expect(page).toHaveURL(/[?&]span_min_duration_ms=20(&|$)/);
  await expect.poll(() => requests[requests.length - 1].get('min_duration_ms')).toBe('20');
  await waitRows(page);
  await expect.poll(async () => (await rows(page).locator('.traceSpanListRow__cell--kind').allTextContents()).every((t) => t === 'Internal')).toBe(true);

  // Reload: same mode and filters; Back returns to the trace list.
  await page.reload();
  await waitRows(page);
  await expect(page.locator('#traceSpanKind')).toHaveValue('Internal');
  await expect(page.locator('#traceSpanMinDuration')).toHaveValue('20');
  await page.locator('[data-results-mode="traces"]').click();
  await expect(page).not.toHaveURL(/mode=spans/);
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#traceSpanTable')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/[?&]mode=spans(&|$)/);
  await waitRows(page);
});

test('spans: virtualised table, attribute column picker (remembered) and infinite scroll', async ({ page, request }) => {
  const range = await denseWindow(request);
  await freshColumns(page);
  const requests = spanRequests(page);
  // Server spans: every one carries server.port.
  await page.goto(tracesUrl(range, { mode: 'spans', kind: 'Server' }));
  await waitRows(page);
  // Only the rows in view are in the DOM.
  const rendered = await rows(page).count();
  expect(rendered).toBeGreaterThan(10);
  expect(rendered).toBeLessThan(100);
  await expect(page.locator('#traceSpanTable')).toHaveAttribute('aria-rowcount', '101');
  // Service colours, relative duration bars, status and kind cells.
  const firstRow = rows(page).first();
  await expect(firstRow.locator('.serviceSwatch')).toHaveCount(1);
  const color = await firstRow.evaluate((el) => el.style.getPropertyValue('--trace-service-color'));
  expect(color).toMatch(/^var\(--trace-span-color-\d+\)$/);
  const widths = await rows(page).locator('.traceSpanListRow__cell--duration.cellBar').evaluateAll((els) => els.map((el) => parseFloat(el.style.getPropertyValue('--cellBar'))));
  expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  expect(Math.max(...widths)).toBeGreaterThan(0);

  // Column picker: add a span attribute column.
  await page.locator('#traceSpanColumnsButton').click();
  await expect(page.locator('#traceSpanColumnsMenu')).toBeVisible();
  await page.locator('#traceSpanColumnInput').fill('span:server.port');
  await page.locator('#traceSpanColumnInput').press('Enter');
  await expect.poll(() => requests[requests.length - 1].get('columns')).toBe('span:server.port');
  await expect(page.locator('.traceSpanTable__th--attr')).toHaveText('server.port');
  await waitRows(page);
  const values = await rows(page).locator('.traceSpanListRow__cell--attr').allTextContents();
  expect(values.length).toBeGreaterThan(5);
  for (const value of values) expect(value).toMatch(/^\d+$/);
  await expect(page.locator('#traceSpanColumnsButton')).toHaveText('Columns · 1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#traceSpanColumnsMenu')).toBeHidden();

  // Remembered across reloads.
  await page.reload();
  await waitRows(page);
  await expect(page.locator('.traceSpanTable__th--attr')).toHaveText('server.port');
  expect(requests[requests.length - 1].get('columns')).toBe('span:server.port');

  // Infinite scroll: the end of the table loads the next page by cursor.
  const before = requests.length;
  await page.locator('#tracesSearchView').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => requests.length).toBeGreaterThan(before);
  const next = requests[requests.length - 1];
  expect(next.get('cursor')).toMatch(/^1\.\d+\.\d+\.[kb]\./);
  await expect(page.locator('#traceSpanTable')).toHaveAttribute('aria-rowcount', '201', { timeout: 30_000 });
  await expect(page.locator('#tracesResultCount')).toContainText('200+ Spans');
  // The rows are newest first with no repeated span across the page seam.
  const keys = await page.evaluate(() => {
    const view = document.getElementById('tracesSearchView');
    const out = [];
    const seen = new Set();
    const collect = () => document.querySelectorAll('#traceSpanTable .traceSpanListRow').forEach((row) => {
      const i = Number(row.dataset.spanIndex);
      if (!seen.has(i)) { seen.add(i); out.push([i, row.querySelector('.traceSpanListRow__cell--time').title]); }
    });
    return new Promise((resolve) => {
      let top = 0;
      const step = () => {
        view.scrollTop = top;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          collect();
          top += view.clientHeight / 2;
          if (top < view.scrollHeight && out.length < 200) step(); else resolve(out.sort((a, b) => a[0] - b[0]));
        }));
      };
      step();
    });
  });
  expect(keys.length).toBeGreaterThanOrEqual(150);
  for (let i = 1; i < keys.length; i += 1) expect(keys[i - 1][1] >= keys[i][1]).toBe(true);

  // Remove the column again.
  await page.locator('#traceSpanColumnsButton').click();
  await page.locator('[data-column-remove="0"]').click();
  await expect(page.locator('.traceSpanTable__th--attr')).toHaveCount(0);
  await expect.poll(() => requests[requests.length - 1].get('columns')).toBeNull();
});

test('spans: side panel, click-to-filter, Open in trace and Back', async ({ page, request }) => {
  const range = await denseWindow(request);
  await freshColumns(page);
  const requests = spanRequests(page);
  // A span from the third row on whose host runs other services too, so
  // that once filtered on that host and its service excluded, spans remain:
  // the window's newest spans in the table's order, from ClickHouse.
  const inWindow = `Timestamp >= fromUnixTimestamp64Milli(${RICH_START}) AND Timestamp <= fromUnixTimestamp64Milli(${RICH_START + WINDOW})`;
  const newest = (await otelRows(request, `SELECT ResourceAttributes['host.name'] FROM otel.otel_traces WHERE ${inWindow} ORDER BY Timestamp DESC, SpanId DESC, TraceId DESC LIMIT 30`)).map(([host]) => host);
  const shared = new Set((await otelRows(request, `SELECT ResourceAttributes['host.name'] AS h FROM otel.otel_traces WHERE ${inWindow} GROUP BY h HAVING uniqExact(ServiceName) > 1`)).map(([host]) => host));
  const index = newest.findIndex((host, i) => i >= 3 && shared.has(host));
  expect(index).toBeGreaterThanOrEqual(3);
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  const row = rows(page).nth(index);
  await row.scrollIntoViewIfNeeded();
  const service = (await row.locator('.traceSpanListRow__cell--service').textContent()).trim();
  const operation = (await row.locator('.traceSpanListRow__cell--operation').textContent()).trim();
  await row.locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).locator('.traceSpanPanel__title')).toContainText(service);
  await expect(panel(page).locator('#traceSpanPanelTitle')).toHaveText(operation);
  // Details from /api/traces/span: the span's attributes, with filter actions.
  const hostRow = panel(page).locator('.kvList__row[data-kv-key="host.name"][data-filter-scope="resource"]');
  await expect(hostRow).toBeVisible({ timeout: 15_000 });
  await expect(panel(page).locator('.kvList__row[data-kv-key="service.name"][data-filter-scope="resource"]')).toBeVisible();
  const host = JSON.parse(await hostRow.getAttribute('data-kv-json'));
  expect(host).toBe(newest[index]);
  const spanId = (await panel(page).locator('.traceSpanPanel__fact', { hasText: 'Span ID' }).locator('code').textContent()).trim();
  const traceId = (await panel(page).locator('.traceSpanPanel__fact', { hasText: 'Trace ID' }).locator('code').textContent()).trim();

  // Open in trace: the trace detail, focused on the span, carrying the search.
  const searchesBefore = requests.length;
  await panel(page).locator('[data-span-open-trace]').click();
  await expect(page.locator('#traceDetail')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${traceId}\\?span=${spanId}&.*mode=spans`));
  await expect(page.locator(`#traceWaterfall [data-inspector-span="${spanId}"]`)).toBeVisible({ timeout: 30_000 });
  // Back: the same spans, selection and panel, without searching again.
  await page.locator('#traceBackButton').click();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect(page).toHaveURL(/\/traces\?.*mode=spans/);
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#traceSpanTable .traceSpanListRow.is-selected')).toHaveAttribute('data-span-index', String(index));
  expect(requests.length).toBe(searchesBefore);
  // Browser Back from a trace opened again works the same way (the trace URL
  // is pushed once the trace has loaded).
  await panel(page).locator('[data-span-open-trace]').click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${traceId}\\?span=${spanId}`));
  await expect(page.locator(`#traceWaterfall [data-inspector-span="${spanId}"]`)).toBeVisible({ timeout: 30_000 });
  await page.goBack();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect(panel(page)).toBeVisible();

  // Click-to-filter on an attribute value: a chip and a new span search.
  await hostRow.locator('.kv__v').click();
  await expect(page.locator('#traceFilterMenu')).toBeVisible();
  await page.locator('#traceFilterMenu [data-filter-action="include"]').click();
  await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(1);
  await expect.poll(() => requests[requests.length - 1].getAll('tag')).toEqual([`resource:host.name=${host}`]);
  await expect(panel(page)).toBeHidden();
  await waitRows(page);
  // Click-to-filter on a row value: exclude its service.
  const excluded = (await rows(page).first().locator('.traceSpanListRow__cell--service').textContent()).trim();
  await rows(page).first().locator('.traceSpanListRow__cell--service [data-filter-field="service"]').click();
  await page.locator('#traceFilterMenu [data-filter-action="exclude"]').click();
  await expect.poll(() => requests[requests.length - 1].getAll('service_not')).toEqual([excluded]);
  await waitRows(page);
  const services = await rows(page).locator('.traceSpanListRow__cell--service').allTextContents();
  expect(services.map((s) => s.trim())).not.toContain(excluded);
});

test('spans: another Traces tab hides the span mode; the trace-duration chip stays out of span searches', async ({ page, request }) => {
  const range = await denseWindow(request);
  const requests = spanRequests(page);
  // min/max_duration_ms are the trace-duration chip (heatmap); span_* are
  // the span table's own duration range.
  await page.goto(tracesUrl(range, { mode: 'spans', min_duration_ms: '10', max_duration_ms: '5000', span_min_duration_ms: '2' }));
  await waitRows(page);
  await expect(page.locator('#tracesFilterChips [data-chip-kind="duration"]')).toBeVisible();
  const first = requests[requests.length - 1];
  expect(first.get('min_duration_ms')).toBe('2');
  expect(first.get('max_duration_ms')).toBeNull();
  await expect(page.locator('#traceSpanMinDuration')).toHaveValue('2');
  await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();

  const other = page.locator('#tracesTabs [data-trace-tab]:not([data-trace-tab="search"])').first();
  test.skip(!(await other.isVisible()), 'no other Traces tab in this configuration');
  // The other tabs (Services, Service map) run their own request.
  const isTabRun = (r) => /\/api\/traces\/(services|service_map)$/.test(new URL(r.url()).pathname);
  const shown = page.waitForRequest(isTabRun, { timeout: 30_000 });
  await other.click();
  await shown;
  await expect(page).toHaveURL(/[?&]tab=/);
  await expect(page.locator('#traceSpanTable')).toBeHidden();
  await expect(page.locator('#traceSpanTools')).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-results-mode="spans"]')).toBeHidden();
  // The Search button runs the selected tab, never the span search.
  const before = requests.length;
  const searched = page.waitForRequest(isTabRun, { timeout: 30_000 });
  await page.locator('#tracesSearchButton').click();
  await searched;
  expect(requests.length).toBe(before);

  // Back on the Search tab: still Spans mode, with the same filters.
  await page.locator('#tracesTabs [data-trace-tab="search"]').click();
  await expect(page).not.toHaveURL(/[?&]tab=/);
  await expect(page).toHaveURL(/[?&]mode=spans(&|$)/);
  await waitRows(page);
  await expect(page.locator('#traceSpanTools')).toBeVisible();
  const last = requests[requests.length - 1];
  expect(last.get('min_duration_ms')).toBe('2');
  expect(last.get('max_duration_ms')).toBeNull();
});

test('spans: the side panel opens under the search bar; on a phone, a bottom sheet with its close button in reach and room for values', async ({ page, request }) => {
  const range = await denseWindow(request);
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  await rows(page).first().locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  // Desktop: right under the sticky search bar (header + #obsNav + bar,
  // whatever their height).
  const form = await page.locator('#tracesForm').boundingBox();
  const side = await panel(page).boundingBox();
  expect(Math.abs(side.y - (form.y + form.height))).toBeLessThanOrEqual(1);
  // Phone: the header wraps to two rows; the panel is a bottom sheet under
  // the page chrome, full width.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => Math.round((await panel(page).boundingBox()).width)).toBe(390);
  const nav = await page.locator('#obsNav').boundingBox();
  const header = await page.locator('body > .appHeader').boundingBox();
  expect(header.height).toBeGreaterThan(60);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--shell-top'))).toBe(`${Math.round(nav.y + nav.height)}px`);
  const sheet = await panel(page).boundingBox();
  expect(sheet.x).toBe(0);
  expect(sheet.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  // Nothing covers the head: the title, prev / next and close are hit-tested.
  for (const selector of ['#traceSpanPanelTitle', '[data-span-panel-nav="next"]', '.traceSpanPanel__close']) {
    const box = await panel(page).locator(selector).boundingBox();
    expect(await page.evaluate(([x, y, sel]) => !!document.elementFromPoint(x, y)?.closest(sel), [box.x + box.width / 2, box.y + box.height / 2, selector]), selector).toBe(true);
  }
  // Tag values get a column a value fits in (not one character per line).
  const value = panel(page).locator('[data-span-section="tags"] .kvList__row:not(.kvList__row--tree) .kvList__value').first();
  await expect(value).toBeVisible({ timeout: 15_000 });
  expect((await value.boundingBox()).width).toBeGreaterThan(150);
  // The close button closes it and gives focus back to the table.
  await panel(page).locator('.traceSpanPanel__close').click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#traceSpanTable')).toBeFocused();
});

// Every shown column ends inside the table (nothing clipped by the results
// column); the labels of the shown headers.
async function spanColumns(page) {
  return page.evaluate(() => {
    const table = document.getElementById('traceSpanTable');
    const box = table.getBoundingClientRect();
    const shown = [...table.querySelectorAll('.dataList__th')].filter((th) => th.getClientRects().length);
    const cells = [...table.querySelectorAll('.traceSpanListRow:first-child > .dataList__cell')].filter((cell) => cell.getClientRects().length);
    const inside = (el) => el.getBoundingClientRect().right <= box.right + 0.5 && el.getBoundingClientRect().left >= box.left - 0.5;
    return {
      labels: shown.map((th) => th.textContent.trim()),
      inside: shown.every(inside) && cells.every(inside),
      cells: cells.length,
      fits: table.scrollWidth <= table.clientWidth + 1,
      fit: table.dataset.fit || '',
    };
  });
}

// Below 1600 px a docked detail panel folds the side panel (Attributes) to
// its rail while it is open, and unfolds it once closed; a rail the viewer
// chose stays; at 1600 px and more nothing folds.
test('spans: the docked panel folds Attributes to its rail below 1600 px and unfolds it on close', async ({ page, request }) => {
  const range = await denseWindow(request);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  const facets = page.locator('#traceFacets');
  const width = async () => Math.round((await facets.boundingBox()).width);
  expect(await width()).toBe(288);
  await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(width).toBe(32);
  // Not the viewer's fold: nothing is remembered.
  expect(['true', '1']).not.toContain(await page.evaluate(() => localStorage.getItem('chdash.traceFacetsCollapsed.v1')));
  // Moving to another span keeps it folded; closing unfolds it.
  await rows(page).nth(2).locator('.traceSpanListRow__cell--time').click();
  expect(await width()).toBe(32);
  await panel(page).locator('.traceSpanPanel__close').click();
  await expect(panel(page)).toBeHidden();
  await expect.poll(width).toBe(288);
  // A rail the viewer chose stays a rail after the panel closes.
  await page.locator('#traceFacetsToggle').click();
  await expect.poll(width).toBe(32);
  await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  await panel(page).locator('.traceSpanPanel__close').click();
  await expect(panel(page)).toBeHidden();
  expect(await width()).toBe(32);
  await page.locator('#traceFacetsToggle').click();
  await expect.poll(width).toBe(288);
  // 1920 px: room for both, nothing folds.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  expect(await width()).toBe(288);
});

test('spans: beside the docked panel the table fits its column (Kind goes first, Status stays); 1920 px shows every column', async ({ page, request }) => {
  const range = await denseWindow(request);
  await freshColumns(page);
  await page.setViewportSize({ width: 1200, height: 900 });
  // Spans with a drawn status (Unset draws nothing in the Status column).
  await page.goto(tracesUrl(range, { mode: 'spans', status_not: 'Unset' }));
  await waitRows(page);
  const all = ['Time', 'Service', 'Operation', 'Duration', 'Status', 'Kind'];
  expect((await spanColumns(page)).labels).toEqual(all);
  await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await spanColumns(page)).fit).not.toBe('');
  const narrow = await spanColumns(page);
  expect(narrow.labels).toEqual(['Time', 'Service', 'Operation', 'Duration', 'Status']);
  expect(narrow).toMatchObject({ inside: true, fits: true, cells: 5 });
  // The status (an Error chip or OK text) is whole and hit-testable at the table's right edge.
  const status = rows(page).nth(1).locator('.traceSpanListRow__cell--status [data-status]');
  const badge = await status.boundingBox();
  const table = await page.locator('#traceSpanTable').boundingBox();
  expect(badge.x + badge.width).toBeLessThanOrEqual(table.x + table.width);
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.traceSpanListRow__cell--status'), [badge.x + badge.width / 2, badge.y + badge.height / 2])).toBe(true);
  // 1920 px with the panel still open: every column again.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await spanColumns(page)).labels).toEqual(all);
  expect(await spanColumns(page)).toMatchObject({ inside: true, fits: true, cells: 6, fit: '' });
  // Closing the panel at 1200 px gives the full table back.
  await page.setViewportSize({ width: 1200, height: 900 });
  await panel(page).locator('.traceSpanPanel__close').click();
  await expect(panel(page)).toBeHidden();
  await expect.poll(async () => (await spanColumns(page)).labels).toEqual(all);
});

// Traces | Spans heads the results toolbar, left of the results line, at
// the same place in both modes.
test('spans: the Traces | Spans switch keeps its place, left of the results line', async ({ page, request }) => {
  const range = await denseWindow(request);
  await page.goto(tracesUrl(range));
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
  // The analytics charts above the results may draw after them (and take
  // their final height then): measure once both have drawn.
  const drawn = () => page.locator('#traceServiceChart .chartCore, #traceDurationChart .chartCore')
    .evaluateAll((charts) => charts.filter((chart) => Number(chart.dataset.pointsDrawn || 0) > 0).length);
  await expect.poll(drawn, { timeout: 30_000 }).toBe(2);
  const toggle = page.locator('.traceModeToggle');
  const count = page.locator('#tracesResultCount');
  const inTraces = await toggle.boundingBox();
  expect(inTraces.x + inTraces.width).toBeLessThanOrEqual((await count.boundingBox()).x);
  await toggle.locator('[data-results-mode="spans"]').click();
  await waitRows(page);
  await expect.poll(drawn, { timeout: 30_000 }).toBe(2);
  const inSpans = await toggle.boundingBox();
  expect(Math.abs(inSpans.x - inTraces.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(inSpans.y - inTraces.y)).toBeLessThanOrEqual(1);
  expect(inSpans.x + inSpans.width).toBeLessThanOrEqual((await count.boundingBox()).x);
});

test('spans: keyboard navigation through rows and the panel', async ({ page, request }) => {
  const range = await denseWindow(request);
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  const table = page.locator('#traceSpanTable');
  await table.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#traceSpanTable .traceSpanListRow.is-selected')).toHaveAttribute('data-span-index', '2');
  await expect(table).toHaveAttribute('aria-activedescendant', 'traceSpanListRow-2');
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.traceSpanPanel__position')).toHaveText(/^3 \/ 100\+$/);
  await page.keyboard.press('ArrowDown');
  await expect(panel(page).locator('.traceSpanPanel__position')).toHaveText(/^4 \/ 100\+$/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(panel(page).locator('.traceSpanPanel__position')).toHaveText(/^2 \/ 100\+$/);
  // The panel's own buttons move too, and Escape closes it.
  await panel(page).locator('[data-span-panel-nav="next"]').click();
  await expect(panel(page).locator('.traceSpanPanel__position')).toHaveText(/^3 \/ 100\+$/);
  await page.keyboard.press('ArrowDown');
  await expect(panel(page).locator('.traceSpanPanel__position')).toHaveText(/^4 \/ 100\+$/);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  // End jumps to the last loaded row (loading the next page).
  await table.focus();
  await page.keyboard.press('End');
  await expect(page.locator('#traceSpanTable .traceSpanListRow.is-selected')).toBeVisible();
  await expect(table).toHaveAttribute('aria-rowcount', '201', { timeout: 30_000 });
});

test('spans: loading, empty, error and "more available" states', async ({ page, request }) => {
  const range = await denseWindow(request);
  // Empty: a filter that matches nothing.
  await page.goto(tracesUrl(range, { mode: 'spans', tag: 'span:fixture.bucket=no-such-bucket' }));
  await expect(page.locator('[data-span-empty]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-span-empty]')).toContainText('No spans found');
  await expect(page.locator('#tracesResultCount')).toContainText('0 Spans');

  // Budget stops with nothing found yet: the table continues on its own a
  // few times, then says how far it searched and continues on demand; an
  // error offers Retry (from the same cursor).
  let failing = false;
  const cursors = [];
  await page.route('**/api/traces/spans?*', async (route) => {
    const url = new URL(route.request().url());
    cursors.push(url.searchParams.get('cursor'));
    if (failing) return route.fulfill({ status: 503, json: { error_code: 'trace_spans_failed', message: 'ClickHouse is busy' } });
    await new Promise((resolve) => setTimeout(resolve, url.searchParams.get('cursor') ? 50 : 400));
    const end = Number(url.searchParams.get('end_ms'));
    return route.fulfill({ json: {
      v: 1, source_host_id: 'local', range: [end - WINDOW, end], limit: 100, attribute_columns: [], has_more: true,
      cursor: `1.${(end - 600_000) * 1e6}.900000000000.b..`, incomplete: true, budget_ms: 2000, stop_reason: 'time_budget',
      searched_to_ns: String((end - 600_000) * 1e6), slices: [], timing_ms: { queries: 2000, total: 2000 }, rows: [] } });
  });
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await expect(page.locator('.traceSpanTable__foot[role="status"]')).toContainText('Searching spans');
  await expect(page.locator('[data-span-more-available]')).toContainText('Searched back to', { timeout: 30_000 });
  await expect(page.locator('[data-span-load-more]')).toHaveText('Keep searching');
  // The first page, then two automatic continuations by cursor.
  const firstPage = cursors.lastIndexOf(null);
  expect(cursors.slice(firstPage + 1)).toHaveLength(2);
  for (const cursor of cursors.slice(firstPage + 1)) expect(cursor).toMatch(/^1\.\d+\.900000000000\.b\./);
  await expect(page.locator('#tracesResultCount')).toContainText('0+ Spans');
  failing = true;
  await page.locator('[data-span-load-more]').click();
  await expect(page.locator('.traceSpanTable__foot.is-error')).toContainText('ClickHouse is busy');
  const failed = cursors.length;
  await page.locator('[data-span-retry]').click();
  await expect.poll(() => cursors.length).toBe(failed + 1);
  expect(cursors[failed]).toBe(cursors[failed - 1]);
  await expect(page.locator('.traceSpanTable__foot.is-error')).toBeVisible();
  await page.unroute('**/api/traces/spans?*');
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  await expect(page.locator('#tracesResultCount')).toContainText('more available');
});

for (const theme of ['dark', 'light']) {
  test(`spans: captures the span table and panel (${theme})`, async ({ page, request }, testInfo) => {
    test.skip(!['desktop-1920', 'laptop-1280', 'desktop-1440'].includes(testInfo.project.name));
    const range = await denseWindow(request);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((mode) => {
      try {
        localStorage.setItem('chdash.theme', mode);
        localStorage.setItem('chdash.traceSpanColumns.v1', JSON.stringify([{ scope: 'span', key: 'server.port' }, { scope: 'resource', key: 'deployment.environment.name' }]));
      } catch (_) {}
    }, theme);
    await page.goto(tracesUrl(range, { mode: 'spans', status_not: 'Unset' }));
    await waitRows(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await captureState(page, testInfo, `trace-spans-table-${theme}`);
    await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
    await expect(panel(page).locator('.kvList__row').first()).toBeVisible({ timeout: 15_000 });
    const panelBox = await panel(page).boundingBox();
    const viewport = page.viewportSize();
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await captureState(page, testInfo, `trace-spans-panel-${theme}`);
  });
}
