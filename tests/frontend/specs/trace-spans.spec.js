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

const HOUR = 3_600_000;
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

// A dense fixture hour (two hours before the newest span) as from / to.
let hour = null;
async function denseHour(request) {
  if (hour) return hour;
  const [[newest]] = await otelRows(request, 'SELECT toUnixTimestamp64Milli(max(Timestamp)) FROM otel.otel_traces');
  test.skip(!(Number(newest) > 3 * HOUR), 'OTEL fixture is empty');
  const end = Math.floor(Number(newest) / HOUR) * HOUR - HOUR;
  hour = { from: stamp(end - HOUR), to: stamp(end) };
  return hour;
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
  const range = await denseHour(request);
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
  expect(Number(first.get('end_ms')) - Number(first.get('start_ms'))).toBe(HOUR);
  // Every listed span matches the (now span-level) status filter.
  const statuses = await rows(page).locator('.traceSpanListRow__cell--status').allTextContents();
  expect(statuses.length).toBeGreaterThan(10);
  expect(new Set(statuses)).toEqual(new Set(['OK']));

  // Kind and span duration filters join the URL and the request.
  await page.locator('#traceSpanTools .tracePicker__button').click();
  await page.locator('#traceSpanTools .tracePicker__option[data-value="Client"]').click();
  await expect(page).toHaveURL(/[?&]kind=Client(&|$)/);
  await waitRows(page);
  await expect.poll(() => requests[requests.length - 1].getAll('kind')).toEqual(['Client', 'SPAN_KIND_CLIENT']);
  await page.locator('#traceSpanMinDuration').fill('20');
  await page.locator('#traceSpanMinDuration').press('Enter');
  await expect(page).toHaveURL(/[?&]span_min_duration_ms=20(&|$)/);
  await expect.poll(() => requests[requests.length - 1].get('min_duration_ms')).toBe('20');
  await waitRows(page);
  await expect.poll(async () => (await rows(page).locator('.traceSpanListRow__cell--kind').allTextContents()).every((t) => t === 'Client')).toBe(true);

  // Reload: same mode and filters; Back returns to the trace list.
  await page.reload();
  await waitRows(page);
  await expect(page.locator('#traceSpanKind')).toHaveValue('Client');
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
  const range = await denseHour(request);
  await freshColumns(page);
  const requests = spanRequests(page);
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  // Only the rows in view are in the DOM.
  const rendered = await rows(page).count();
  expect(rendered).toBeGreaterThan(10);
  expect(rendered).toBeLessThan(100);
  await expect(page.locator('#traceSpanTable')).toHaveAttribute('aria-rowcount', '101');
  // Service colours, relative duration bars, status and kind cells.
  const firstRow = rows(page).first();
  await expect(firstRow.locator('.traceSpanListRow__dot')).toHaveCount(1);
  const color = await firstRow.evaluate((el) => el.style.getPropertyValue('--trace-service-color'));
  expect(color).toMatch(/^var\(--trace-span-color-\d+\)$/);
  const widths = await rows(page).locator('.traceSpanListRow__bar i').evaluateAll((els) => els.map((el) => parseFloat(el.style.width)));
  expect(Math.max(...widths)).toBeLessThanOrEqual(100);
  expect(Math.max(...widths)).toBeGreaterThan(0);

  // Column picker: add a span attribute column.
  await page.locator('#traceSpanColumnsButton').click();
  await expect(page.locator('#traceSpanColumnsMenu')).toBeVisible();
  await page.locator('#traceSpanColumnInput').fill('span:fixture.bucket');
  await page.locator('#traceSpanColumnInput').press('Enter');
  await expect.poll(() => requests[requests.length - 1].get('columns')).toBe('span:fixture.bucket');
  await expect(page.locator('.traceSpanTable__th--attr')).toHaveText('fixture.bucket');
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
  await expect(page.locator('.traceSpanTable__th--attr')).toHaveText('fixture.bucket');
  expect(requests[requests.length - 1].get('columns')).toBe('span:fixture.bucket');

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
  const range = await denseHour(request);
  await freshColumns(page);
  const requests = spanRequests(page);
  await page.goto(tracesUrl(range, { mode: 'spans' }));
  await waitRows(page);
  const row = rows(page).nth(3);
  const service = (await row.locator('.traceSpanListRow__cell--service').textContent()).trim();
  const operation = (await row.locator('.traceSpanListRow__cell--operation').textContent()).trim();
  await row.locator('.traceSpanListRow__cell--time').click();
  await expect(panel(page)).toBeVisible();
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).locator('.traceSpanPanel__title')).toContainText(service);
  await expect(panel(page).locator('#traceSpanPanelTitle')).toHaveText(operation);
  // Details from /api/traces/span: the span's attributes, with filter actions.
  const bucketRow = panel(page).locator('.traceKv__row[data-kv-key="fixture.bucket"]');
  await expect(bucketRow).toBeVisible({ timeout: 15_000 });
  await expect(panel(page).locator('.traceKv__row[data-kv-key="service.name"][data-filter-scope="resource"]')).toBeVisible();
  const bucket = JSON.parse(await bucketRow.getAttribute('data-kv-json'));
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
  await expect(page.locator('#traceSpanTable .traceSpanListRow.is-selected')).toHaveAttribute('data-span-index', '3');
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
  await bucketRow.locator('.traceKv__v').click();
  await expect(page.locator('#traceFilterMenu')).toBeVisible();
  await page.locator('#traceFilterMenu [data-filter-action="include"]').click();
  await expect(page.locator('#tracesFilterChips .traceFilterChip')).toHaveCount(1);
  await expect.poll(() => requests[requests.length - 1].getAll('tag')).toEqual([`span:fixture.bucket=${bucket}`]);
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
  const range = await denseHour(request);
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
  await other.click();
  await expect(page).toHaveURL(/[?&]tab=/);
  await expect(page.locator('#traceSpanTable')).toBeHidden();
  await expect(page.locator('#traceSpanTools')).toBeHidden();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-results-mode="spans"]')).toBeHidden();
  // The Search button runs the selected tab, never the span search.
  await page.waitForTimeout(300);
  const before = requests.length;
  await page.locator('#tracesSearchButton').click();
  await page.waitForTimeout(800);
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

test('spans: keyboard navigation through rows and the panel', async ({ page, request }) => {
  const range = await denseHour(request);
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
  const range = await denseHour(request);
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
      v: 1, source_host_id: 'local', range: [end - HOUR, end], limit: 100, attribute_columns: [], has_more: true,
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
    const range = await denseHour(request);
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((mode) => {
      try {
        localStorage.setItem('chdash.theme', mode);
        localStorage.setItem('chdash.traceSpanColumns.v1', JSON.stringify([{ scope: 'span', key: 'fixture.bucket' }, { scope: 'resource', key: 'deployment.environment.name' }]));
      } catch (_) {}
    }, theme);
    await page.goto(tracesUrl(range, { mode: 'spans', status_not: 'Unset' }));
    await waitRows(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await captureState(page, testInfo, `trace-spans-table-${theme}`);
    await rows(page).nth(1).locator('.traceSpanListRow__cell--time').click();
    await expect(panel(page).locator('.traceKv__row').first()).toBeVisible({ timeout: 15_000 });
    const panelBox = await panel(page).boundingBox();
    const viewport = page.viewportSize();
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await captureState(page, testInfo, `trace-spans-panel-${theme}`);
  });
}
