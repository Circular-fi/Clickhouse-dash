import { test, expect } from '@playwright/test';

// Logs explorer (/logs) against the otel_fixture logs. Ranges come from
// /api/logs/meta time_bounds; the Playwright browser runs in UTC, so the
// absolute range strings in the URL are UTC too.

const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function logsWindow(request, minutes = 30) {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
  const end = Number(meta.time_bounds.max_ms);
  const start = end - minutes * 60000;
  return { start, end, from: fmt(start), to: fmt(end + 1000) };
}

function logsUrl(win, extra = '') {
  return `/observability/logs?from=${encodeURIComponent(win.from)}&to=${encodeURIComponent(win.to)}${extra}`;
}

const rows = (page) => page.locator('#logsTableRows .logsRow[data-row-id]');

async function openLogs(page, url) {
  await page.goto(url);
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
}

function param(page, name) {
  return new URL(page.url()).searchParams.getAll(name);
}

// The histogram draws on the shared canvas engine: its data attributes say
// what each severity drew (seriesStats: { Error: { points } ... }).
const histogram = (page) => page.locator('#logsHistogram .chartCore');
async function barsOf(page) {
  const stats = JSON.parse((await histogram(page).getAttribute('data-series-stats')) || '{}');
  return Object.fromEntries(Object.entries(stats).map(([label, s]) => [label, s.points]));
}
async function expectBars(page) {
  await expect(histogram(page).locator('.chartCore__canvas')).toBeVisible();
  await expect.poll(async () => Number(await histogram(page).getAttribute('data-points-drawn'))).toBeGreaterThan(0);
}
// The plot rectangle in page coordinates.
async function plotBox(page) {
  const box = await histogram(page).locator('.chartCore__overlay').boundingBox();
  const [left, top, width, height] = (await histogram(page).getAttribute('data-plot')).split(' ').map(Number);
  return { x: box.x + left, y: box.y + top, width, height };
}

test('logs: search by text, URL round-trip and back navigation', async ({ page, request }) => {
  const win = await logsWindow(request);
  await openLogs(page, logsUrl(win));
  await expect(page.locator('#logsTotal')).toHaveText(/[\d,]+ logs/);
  await page.locator('#logsQuery').fill('cache miss');
  await page.locator('#logsSearchButton').click();
  await expect.poll(() => param(page, 'q')).toEqual(['cache miss']);
  await expect(rows(page).first()).toContainText('cache miss');
  const bodies = await page.locator('#logsTableRows .logsCell--body').allInnerTexts();
  expect(bodies.length).toBeGreaterThan(5);
  for (const body of bodies) expect(body).toContain('cache miss');
  // Reload keeps the whole search.
  await page.reload();
  await expect(page.locator('#logsQuery')).toHaveValue('cache miss');
  await expect(rows(page).first()).toContainText('cache miss');
  // Back returns to the unfiltered search.
  await page.goBack();
  await expect.poll(() => param(page, 'q')).toEqual([]);
  await expect(page.locator('#logsQuery')).toHaveValue('');
  await expect(rows(page).first()).toBeVisible();
});

test('logs: service, level and severity class filters', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win));
  await page.locator('#logsServiceButton').click();
  const options = page.locator('#logsServiceMenu .logsMultiPicker__option');
  await expect(options.first()).toBeVisible();
  const names = (await options.locator('.logsMultiPicker__name').allInnerTexts()).slice(0, 2);
  for (const name of names) await options.filter({ hasText: name }).locator('input').check();
  await expect.poll(() => param(page, 'service').sort()).toEqual([...names].sort());
  await expect(page.locator('#logsServiceButton')).toHaveText('Service · 2 selected');
  await page.mouse.click(5, 5);
  await expect.poll(async () => new Set(await page.locator('#logsTableRows .logsCell--service').allInnerTexts()).size).toBeLessThanOrEqual(2);
  for (const service of await page.locator('#logsTableRows .logsCell--service').allInnerTexts()) expect(names).toContain(service.trim());

  // Minimum level.
  await page.locator('.logsSearchField--level .tracePicker__button').click();
  await page.locator('.logsSearchField--level .tracePicker__option[data-value="17"]').click();
  await expect.poll(() => param(page, 'level')).toEqual(['17']);
  await expect(page.locator('.logsSearchField--level .tracePicker__button')).toHaveText('Level · ≥ ERROR');
  await expect(rows(page).first()).toBeVisible();
  for (const badge of await page.locator('#logsTableRows .logsSevBadge').allInnerTexts()) expect(badge).toMatch(/ERROR|FATAL/);

  // A severity class from the histogram legend.
  await page.goto(logsUrl(win));
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await page.locator('#logsLegend [data-sev="warn"]').click();
  await expect.poll(() => param(page, 'sev')).toEqual(['warn']);
  await expect(page.locator('#logsChips')).toContainText('Level: Warn');
  await expect(rows(page).first()).toBeVisible();
  for (const badge of await page.locator('#logsTableRows .logsSevBadge').allInnerTexts()) expect(badge).toBe('WARN');
  // The histogram refetches with the filter: only Warn bars are left.
  await expect.poll(async () => (await barsOf(page)).Info).toBe(0);
  expect((await barsOf(page)).Warn).toBeGreaterThan(0);
  // Removing the chip removes the filter.
  await page.locator('#logsChips .logsChip__remove').first().click();
  await expect.poll(() => param(page, 'sev')).toEqual([]);
});

test('logs: dragging over the histogram zooms the time range', async ({ page, request }) => {
  const win = await logsWindow(request, 30);
  await openLogs(page, logsUrl(win));
  await expectBars(page);
  const total = async () => Number((await page.locator('#logsTotal').innerText()).replace(/[^\d]/g, ''));
  const before = await total();
  const hit = await plotBox(page);
  // Hovering reads one bucket: its range, a row per severity and the total.
  await page.mouse.move(hit.x + hit.width * 0.45, hit.y + hit.height / 2);
  const tip = histogram(page).locator('.chartCore__tooltip');
  await expect(tip).toBeVisible();
  await expect(tip.locator('strong')).toContainText('\u2192');
  await expect(tip.locator('.chartCore__tipRow:not(.chartCore__tipRow--total) em')).toHaveText(['Error', 'Warn', 'Info', 'Debug']);
  await expect(tip.locator('.chartCore__tipRow--total')).toContainText('Total');
  await page.mouse.move(hit.x + hit.width * 0.4, hit.y + hit.height / 2);
  await page.mouse.down();
  await page.mouse.move(hit.x + hit.width * 0.5, hit.y + hit.height / 2, { steps: 6 });
  await expect(histogram(page).locator('.chartCore__select')).toBeVisible();
  await page.mouse.up();
  await expect.poll(() => param(page, 'from')[0]).not.toBe(win.from);
  const from = Date.parse(`${param(page, 'from')[0].replace(' ', 'T')}Z`);
  const to = Date.parse(`${param(page, 'to')[0].replace(' ', 'T')}Z`);
  expect(to - from).toBeGreaterThan(60_000);
  expect(to - from).toBeLessThan(6 * 60_000);
  expect(from).toBeGreaterThanOrEqual(win.start - 1000);
  await expect.poll(total).toBeLessThan(before);
  await expect(page.locator('#logsWorkspace .tracePicker--range .tracePicker__button')).not.toContainText('Last');
  // The newest shown row lies inside the zoomed range.
  const newest = await rows(page).first().getAttribute('data-row-id');
  const ms = Number(newest.split('-')[0].slice(0, -6));
  expect(ms).toBeGreaterThanOrEqual(from);
  expect(ms).toBeLessThanOrEqual(to);
});

test('logs: side panel fields filter, exclude, search only this and open trace', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win, '&q=inserted'));
  await rows(page).first().click();
  const panel = page.locator('#logsSidePanel');
  await expect(panel).toBeVisible();
  await expect(rows(page).first()).toHaveClass(/is-selected/);
  await expect(panel.locator('.logsBodyText')).toContainText('inserted');

  // Filter on the host of this record.
  const hostRow = panel.locator('.logsField').filter({ has: page.locator('.logsField__key', { hasText: /^host\.name$/ }) });
  const host = (await hostRow.locator('.logsField__value').innerText()).trim();
  await hostRow.hover();
  await hostRow.locator('[data-field-action="filter"]').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`ResourceAttributes.host.name=${host}`]);
  await expect(page.locator('#logsChips')).toContainText(`host.name = ${host}`);
  await expect(page.locator('#logsQuery')).toHaveValue('inserted');
  // Every row now comes from that host (host column added from the picker).
  await page.locator('#logsColumnsButton').click();
  await page.locator('#logsColumnsMenu input[value="host"]').check();
  await page.mouse.click(5, 5);
  await expect.poll(() => param(page, 'cols')).toEqual(['time,severity,service,host,body']);
  await expect(rows(page).first()).toBeVisible();
  const hosts = await page.locator('#logsTableRows .logsRow[data-row-id] .logsCell:nth-child(4)').allInnerTexts();
  expect(hosts.length).toBeGreaterThan(0);
  expect(new Set(hosts)).toEqual(new Set([host]));

  // Exclude one code.function value.
  await rows(page).first().click();
  const fnRow = panel.locator('.logsField').filter({ has: page.locator('.logsField__key', { hasText: /^code\.function$/ }) });
  const fn = (await fnRow.locator('.logsField__value').innerText()).trim();
  await fnRow.hover();
  await fnRow.locator('[data-field-action="exclude"]').click();
  await expect.poll(() => param(page, 'attr')).toContain(`LogAttributes.code.function!=${fn}`);
  await expect(page.locator('#logsChips .logsChip.is-negated')).toContainText(`code.function ≠ ${fn}`);
  // Every record of that host's "inserted" template has this function: the
  // exclusion empties the table, and removing its chip restores it.
  await expect(page.locator('#logsTableMessage')).toContainText('No logs match these filters');
  await page.locator('#logsChips .logsChip.is-negated .logsChip__remove').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`ResourceAttributes.host.name=${host}`]);
  await expect(rows(page).first()).toBeVisible();

  // "Search only this" drops the text search and the other filters.
  await rows(page).first().click();
  const levelRow = panel.locator('.logsField').filter({ has: page.locator('.logsField__key', { hasText: /^SeverityText$/ }) });
  const level = (await levelRow.locator('.logsField__value').innerText()).trim();
  await levelRow.hover();
  await levelRow.locator('[data-field-action="only"]').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`SeverityText=${level}`]);
  await expect.poll(() => param(page, 'q')).toEqual([]);
  await expect(page.locator('#logsQuery')).toHaveValue('');

  // Open trace links to the Traces view with the span focused.
  await rows(page).first().click();
  const traceId = (await panel.locator('.logsField').filter({ has: page.locator('.logsField__key', { hasText: /^TraceId$/ }) }).locator('.logsField__value').innerText()).trim();
  const spanId = (await panel.locator('.logsField').filter({ has: page.locator('.logsField__key', { hasText: /^SpanId$/ }) }).locator('.logsField__value').innerText()).trim();
  const open = page.locator('#logsOpenTrace');
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', new RegExp(`/observability/traces/${traceId}\\?span=${spanId}$`));
  // Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await rows(page).first().click();
  // The Traces view opens in place (no reload), with the logs time range.
  await page.evaluate(() => { window.__sameDocument = true; });
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${traceId}\\?span=${spanId}&from=`));
  await expect(page.locator('#traceDetail')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#logsWorkspace')).toBeHidden();
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  // Back returns to the record list as it was.
  await page.goBack();
  await expect(page.locator('#logsWorkspace')).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
});

test('logs: surrounding context presets', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win, '&q=inserted'));
  await rows(page).nth(3).click();
  const anchorId = await rows(page).nth(3).getAttribute('data-row-id');
  const service = (await rows(page).nth(3).locator('.logsCell--service').innerText()).trim();
  await page.locator('#logsSideTabContext').click();
  const context = page.locator('#logsContextRows');
  await expect(context.locator('.logsContextRow.is-anchor')).toHaveAttribute('data-context-id', anchorId);
  // Anything: other services around the record (the text search is not applied).
  await expect.poll(async () => new Set(await context.locator('.logsContextRow__service').allInnerTexts()).size).toBeGreaterThan(1);
  await page.locator('[data-context-preset="service"]').click();
  await expect(page.locator('[data-context-preset="service"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => [...new Set(await context.locator('.logsContextRow__service').allInnerTexts())]).toEqual([service]);
  const tracePreset = page.waitForResponse((r) => r.url().includes('/api/logs/context') && r.url().includes('preset=trace'));
  await page.locator('[data-context-preset="trace"]').click();
  const payload = await (await tracePreset).json();
  expect(payload.anchor_found).toBe(true);
  expect(new Set(payload.rows.map((r) => r.trace_id)).size).toBe(1);
  await expect(context.locator('.logsContextRow.is-anchor')).toHaveCount(1);
  const hostPreset = page.waitForResponse((r) => r.url().includes('/api/logs/context') && r.url().includes('preset=host'));
  await page.locator('[data-context-preset="host"]').click();
  const hostPayload = await (await hostPreset).json();
  expect(new Set(hostPayload.rows.map((r) => r.resource_attributes['host.name'])).size).toBe(1);
  // Window size.
  const wide = page.waitForResponse((r) => r.url().includes('/api/logs/context') && r.url().includes('window_ms=900000'));
  await page.locator('[data-context-window="900000"]').click();
  expect((await (await wide).json()).window_ms).toBe(900000);
  // A context row opens its details.
  await context.locator('.logsContextRow').first().click();
  await expect(page.locator('#logsSideDetails')).toBeVisible();
});

test('logs: patterns tab, denoise and filter by pattern', async ({ page, request }) => {
  const win = await logsWindow(request, 30);
  await openLogs(page, logsUrl(win));
  await page.locator('#logsTabPatterns').click();
  await expect.poll(() => param(page, 'tab')).toEqual(['patterns']);
  const patternRows = page.locator('#logsPatterns .logsPatternRow');
  await expect(patternRows.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.logsPatterns__summary')).toContainText(/patterns? in a sample of 10,000/);
  await expect(patternRows.first().locator('.logsSparkline polyline')).toHaveCount(1);
  await expect(patternRows.first().locator('.logsPattern__var').first()).toHaveText('<*>');
  const all = await patternRows.count();
  const shares = async () => (await page.locator('#logsPatterns .logsPatternRow__share').allInnerTexts()).map((t) => parseFloat(t));
  expect((await shares()).some((s) => s > 10)).toBe(true);
  await page.locator('#logsDenoise').check();
  await expect.poll(() => param(page, 'denoise')).toEqual(['1']);
  await expect.poll(() => patternRows.count()).toBeLessThan(all);
  for (const share of await shares()) expect(share).toBeLessThanOrEqual(10);
  await expect(page.locator('.logsPatterns__summary')).toContainText('denoise hides');
  // Reload keeps the tab and the toggle.
  await page.reload();
  await expect(patternRows.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#logsDenoise')).toBeChecked();
  // Clicking a pattern filters the results by its constant words.
  const target = patternRows.filter({ hasText: 'rows into analytics.events_buffer' }).first();
  await target.click();
  await expect.poll(() => param(page, 'tab')).toEqual([]);
  await expect(page.locator('#logsResultsPane')).toBeVisible();
  await expect(page.locator('#logsQuery')).toHaveValue(/inserted rows into analytics\.events_buffer in ms/);
  await expect(rows(page).first()).toBeVisible();
  for (const body of await page.locator('#logsTableRows .logsCell--body').allInnerTexts()) {
    expect(body).toMatch(/^inserted \d+ rows into analytics\.events_buffer in \d+ ms$/);
  }
});

function syntheticRow(tsMs, index, body) {
  const tsNs = `${tsMs}${String(index).padStart(6, '0')}`;
  return {
    id: `${tsNs}-${1000 + index}`, ts_ns: tsNs, ts_ms: tsMs, service: 'live_service', severity_text: 'INFO', severity_number: 9,
    body, trace_id: '', span_id: '', trace_flags: 0, scope_name: '', scope_version: '',
    log_attributes: {}, resource_attributes: { 'host.name': 'live-0' }, scope_attributes: {},
  };
}

test('logs: live tail prepends newer records', async ({ page }) => {
  const now = Date.now();
  const initial = [3, 2, 1].map((i) => syntheticRow(now - i * 60000, i, `initial record ${i}`));
  const tailRequests = [];
  let served = false;
  await page.route('**/api/logs/search**', async (route) => {
    const url = new URL(route.request().url());
    const after = url.searchParams.get('after');
    let rowsOut = initial;
    if (after) {
      tailRequests.push(after);
      rowsOut = served ? [] : [syntheticRow(Date.now(), 9, 'fresh live record')];
      served = true;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ v: 1, rows: rowsOut, row_count: rowsOut.length, next_cursor: null, exhausted: true, truncated: false,
        mode: after ? 'tail' : 'page', tail_gap: false, windows: [], text_search: { active: false } }),
    });
  });
  await page.goto('/observability/logs?from=now-15m&to=now');
  await expect(rows(page)).toHaveCount(3, { timeout: 30_000 });
  await page.locator('#logsLiveButton').click();
  await expect(page.locator('#logsLiveButton')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page).first()).toContainText('fresh live record', { timeout: 15_000 });
  await expect(rows(page)).toHaveCount(4);
  expect(tailRequests[0]).toBe(initial[0].id);
  await expect(page.locator('#logsStatus')).toContainText('live');
  // Later polls ask for records after the new newest one.
  await expect.poll(() => tailRequests.length, { timeout: 15_000 }).toBeGreaterThan(1);
  expect(tailRequests[tailRequests.length - 1]).toMatch(/-1009$/);
  await page.locator('#logsLiveButton').click();
  await expect(page.locator('#logsLiveButton')).toHaveAttribute('aria-pressed', 'false');
});

test('logs: an empty range offers the newest data, errors are shown', async ({ page, request }) => {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.time_bounds, 'no logs');
  test.skip(Date.now() - meta.time_bounds.max_ms < 20 * 60000, 'the fixture reaches the default range');
  await page.goto('/observability/logs');
  await expect(page.locator('#logsTableMessage')).toContainText('No logs match', { timeout: 30_000 });
  await page.locator('[data-jump-latest]').click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => param(page, 'from')[0]).toBe(fmt(meta.time_bounds.max_ms - 3600000));
  // A server error is displayed instead of an empty table.
  await page.route('**/api/logs/search**', (route) => route.fulfill({ status: 422, contentType: 'application/json',
    body: JSON.stringify({ error_code: 'logs_scan_limit', message: 'The logs query would read too many rows.' }) }));
  await page.locator('#logsSearchButton').click();
  await expect(page.locator('#logsError')).toContainText('too many rows');
  await expect(page.locator('#logsTableMessage')).toContainText('Search failed');
});

test('logs: on a phone the record panel is a solid bottom sheet; Escape closes it back to the table; a failed search has Retry and no error code', async ({ page, request }) => {
  const win = await logsWindow(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openLogs(page, logsUrl(win));
  await rows(page).nth(1).click();
  const side = page.locator('#logsSidePanel');
  await expect(side).toBeVisible();
  const sheet = await side.boundingBox();
  const nav = await page.locator('#obsNav').boundingBox();
  expect(sheet.x).toBe(0);
  expect(Math.round(sheet.width)).toBe(390);
  expect(sheet.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  expect(Math.round(sheet.y + sheet.height)).toBe(844);
  // Opaque, and on top: the table header under it does not show through.
  const background = await side.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).toMatch(/^rgb\(/);
  for (const selector of ['#logsSideTitle', '#logsSideClose', '#logsSideTabContext']) {
    const box = await page.locator(selector).boundingBox();
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('#logsSidePanel'), [box.x + box.width / 2, box.y + box.height / 2]), selector).toBe(true);
  }
  await page.locator('#logsSideTabDetails').focus();
  await page.keyboard.press('Escape');
  await expect(side).toBeHidden();
  await expect(page.locator('#logsTable')).toBeFocused();

  let fail = true;
  await page.route('**/api/logs/search**', (route) => (fail
    ? route.fulfill({ status: 503, json: { error_code: 'logs_source_unavailable', message: 'The logs table could not be read.' } })
    : route.fallback()));
  // (The form scrolls sideways on a phone: submit it rather than aim at its button.)
  await page.locator('#logsForm').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#logsError')).toContainText('The logs table could not be read.');
  await expect(page.locator('#logsError')).not.toContainText('logs_source_unavailable');
  await expect(page.locator('#logsTableMessage')).toContainText('Search failed');
  fail = false;
  await page.locator('#logsTableMessage').getByRole('button', { name: 'Retry' }).click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
});

test('logs: the page switcher reaches the Observability page, whose Logs tab opens the logs view', async ({ page, request }) => {
  const version = await (await request.get('/api/version')).json();
  test.skip(!version.features?.logs?.enabled, 'logs disabled');
  await page.goto('/query');
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Explorer', 'Observability']);
  await page.locator('#navObservabilityButton').click();
  await expect(page).toHaveURL(/\/observability\/(traces|logs|metrics)(\?|$)/);
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  await page.locator('#obsTab-logs').click();
  await expect(page).toHaveURL(/\/observability\/logs(\?|$)/);
  await expect(page.locator('#logsWorkspace')).toBeVisible();
  await expect(page.locator('#obsTab-logs')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Query', 'Explorer']);
  await page.locator('#navQueryButton').click();
  await expect(page).toHaveURL(/\/query$/);
  // The availability is cached for the next first paint.
  const nav = await page.evaluate(() => JSON.parse(localStorage.getItem('chdash.pageNav.v1')));
  expect(nav.logs).toBe(true);
});

test('logs: no page overflow and keyboard row navigation', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await rows(page).first().click();
  const first = await rows(page).first().getAttribute('data-row-id');
  await page.locator('#logsTable').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#logsTableRows .logsRow.is-selected')).not.toHaveAttribute('data-row-id', first);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Scrolling to the bottom loads older pages through the cursor.
  const before = await page.evaluate(() => window.ChDash.logs.model.rows.length);
  await page.locator('#logsTableViewport').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.evaluate(() => window.ChDash.logs.model.rows.length), { timeout: 20_000 }).toBeGreaterThan(before);
  const ids = await page.evaluate(() => window.ChDash.logs.model.rows.map((r) => r.id));
  expect(new Set(ids).size).toBe(ids.length);
});
