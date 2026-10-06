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
  for (const badge of await page.locator('#logsTableRows .badge--sev').allInnerTexts()) expect(badge).toMatch(/ERROR|FATAL/);

  // A severity class from the histogram legend.
  await page.goto(logsUrl(win));
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  // The histogram's totals legend (the chart engine's): a click filters.
  await page.locator('#logsHistogram .chartCore__legendItem[data-series="warn"]').click();
  await expect.poll(() => param(page, 'sev')).toEqual(['warn']);
  await expect(page.locator('#logsChips')).toContainText('Level: Warn');
  await expect(rows(page).first()).toBeVisible();
  for (const badge of await page.locator('#logsTableRows .badge--sev').allInnerTexts()) expect(badge).toBe('WARN');
  // The histogram refetches with the filter: only Warn bars are left.
  await expect.poll(async () => (await barsOf(page)).Info).toBe(0);
  expect((await barsOf(page)).Warn).toBeGreaterThan(0);
  // Removing the chip removes the filter.
  await page.locator('#logsChips .chip__remove').first().click();
  await expect.poll(() => param(page, 'sev')).toEqual([]);
});

test('logs: only ERROR and FATAL are chips; WARN is amber text with the row bar, INFO muted, DEBUG and TRACE dimmed', async ({ page, request }) => {
  const win = await logsWindow(request);
  const levels = [['FATAL', 21], ['ERROR', 17], ['WARN', 13], ['INFO', 9], ['DEBUG', 5], ['TRACE', 1]];
  const mocked = levels.map(([text, number], i) => ({
    id: `1789867375742983150-${i}`, ts_ns: String(1789867375742983150n - BigInt(i) * 1000000n), ts_ms: 1789867375742 - i, service: 'sev_service',
    severity_text: text, severity_number: number, body: `${text.toLowerCase()} record`, trace_id: '', span_id: '', trace_flags: 0,
    scope_name: '', scope_version: '', log_attributes: {}, resource_attributes: {}, scope_attributes: {},
  }));
  await page.route('**/api/logs/search**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ v: 1, rows: mocked, row_count: mocked.length, next_cursor: null, exhausted: true, truncated: false, mode: 'page', tail_gap: false, windows: [], text_search: { active: false } }),
  }));
  await openLogs(page, logsUrl(win));
  await expect(rows(page)).toHaveCount(levels.length);
  await expect.poll(() => page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    const resolve = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
    const out = {};
    for (const row of document.querySelectorAll('#logsTableRows .logsRow[data-row-id]')) {
      const badge = row.querySelector('.badge--sev');
      const cs = getComputedStyle(badge);
      out[badge.textContent] = {
        chip: !badge.classList.contains('badge--sevText') && cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
        fill: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'none' : cs.backgroundColor === resolve('--sev-fatal') ? 'solid' : 'tint',
        color: [['--danger', 'danger'], ['--panel', 'panel'], ['--sev-warn', 'amber'], ['--muted', 'muted'], ['--sev-trace', 'dimmed']].find(([token]) => cs.color === resolve(token))?.[1] || cs.color,
        bar: getComputedStyle(row).boxShadow !== 'none',
      };
    }
    probe.remove();
    return out;
  })).toEqual({
    FATAL: { chip: true, fill: 'solid', color: 'panel', bar: true },
    ERROR: { chip: true, fill: 'tint', color: 'danger', bar: true },
    WARN: { chip: false, fill: 'none', color: 'amber', bar: true },
    INFO: { chip: false, fill: 'none', color: 'muted', bar: false },
    DEBUG: { chip: false, fill: 'none', color: 'dimmed', bar: false },
    TRACE: { chip: false, fill: 'none', color: 'dimmed', bar: false },
  });
});

test('logs: the histogram legend reads at full strength; a severity filter dims only the severities it leaves out', async ({ page, request }) => {
  const win = await logsWindow(request);
  await openLogs(page, logsUrl(win));
  await expectBars(page);
  const legend = page.locator('#logsHistogram .chartCore__legendItem');
  const states = () => legend.evaluateAll((items) => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    probe.style.color = 'var(--text)';
    const text = getComputedStyle(probe).color;
    probe.remove();
    return Object.fromEntries(items.map((item) => [item.dataset.series, getComputedStyle(item).color === text && getComputedStyle(item.querySelector('i')).opacity === '1' ? 'full' : 'dim']));
  });
  await expect.poll(async () => Object.values(await states()).every((state) => state === 'full')).toBe(true);
  await page.locator('#logsHistogram .chartCore__legendItem[data-series="error"]').click();
  await expect(page.locator('#logsHistogram .chartCore__legendItem[data-series="error"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => {
    const all = await states();
    return all.error === 'full' && Object.entries(all).filter(([id]) => id !== 'error').every(([, state]) => state === 'dim');
  }).toBe(true);
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

// The record panel keeps Body readable: below 1600 px the Fields panel folds
// to its rail while the record is open (and unfolds after), and the
// lowest-priority columns go before Body would shrink under 320 px. The Time
// header lines up with its values (left).
test('logs: the record panel folds Fields, drops low-priority columns before Body shrinks; Time header aligns with its values', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLogs(page, logsUrl(win, '&cols=time,severity,service,host,trace,span,scope,body'));
  const head = page.locator('#logsTableHead');
  await expect(head.locator('.logsTable__th')).toHaveText(['Time', 'Level', 'Service', 'host.name', 'TraceId', 'SpanId', 'Scope', 'Body']);
  const timeHead = await head.locator('.logsTable__th--time').boundingBox();
  const timeCell = await rows(page).first().locator('.logsCell--time').boundingBox();
  expect(Math.abs(timeHead.x - timeCell.x)).toBeLessThanOrEqual(2);
  expect(await head.locator('.logsTable__th--time').evaluate((el) => getComputedStyle(el).textAlign)).not.toBe('right');
  const fields = page.locator('#logsFacets');
  expect(Math.round((await fields.boundingBox()).width)).toBe(288);

  await rows(page).first().click();
  await expect(page.locator('#logsSidePanel')).toBeVisible();
  await expect.poll(async () => Math.round((await fields.boundingBox()).width)).toBe(32);
  // Body keeps its room: the scope, span and trace columns went first.
  await expect.poll(async () => Math.round((await rows(page).first().locator('.logsCell--body').boundingBox()).width)).toBeGreaterThanOrEqual(300);
  const shown = await head.locator('.logsTable__th').allInnerTexts();
  expect(shown.slice(0, 2)).toEqual(['Time', 'Level']);
  expect(shown[shown.length - 1]).toBe('Body');
  expect(shown).not.toContain('Scope');
  const cells = await rows(page).first().locator('.logsCell').count();
  expect(cells).toBe(shown.length);

  // Closed: the Fields panel and every column come back.
  await page.locator('#logsSidePanel .uiDetail__close').click();
  await expect(page.locator('#logsSidePanel')).toBeHidden();
  await expect.poll(async () => Math.round((await fields.boundingBox()).width)).toBe(288);
  await expect(head.locator('.logsTable__th')).toHaveCount(8);
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
  const hostRow = panel.locator('.kvList__row').filter({ has: page.locator('.kvList__key', { hasText: /^host\.name$/ }) });
  const host = (await hostRow.locator('.kvList__value').innerText()).trim();
  await hostRow.hover();
  await hostRow.locator('[data-kv-action="include"]').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`ResourceAttributes.host.name=${host}`]);
  await expect(page.locator('#logsChips')).toContainText(`host.name = ${host}`);
  await expect(page.locator('#logsQuery')).toHaveValue('inserted');
  // Every row now comes from that host (host column added from the picker;
  // the record panel closed, so no column gives way to Body).
  await page.locator('#logsSidePanel .uiDetail__close').click();
  await expect(panel).toBeHidden();
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
  const fnRow = panel.locator('.kvList__row').filter({ has: page.locator('.kvList__key', { hasText: /^code\.function$/ }) });
  const fn = (await fnRow.locator('.kvList__value').innerText()).trim();
  await fnRow.hover();
  const excludedSearch = page.waitForResponse((r) => r.url().includes('/api/logs/search') && decodeURIComponent(r.url()).includes(`code.function!=${fn}`));
  await fnRow.locator('[data-kv-action="exclude"]').click();
  await expect.poll(() => param(page, 'attr')).toContain(`LogAttributes.code.function!=${fn}`);
  await expect(page.locator('#logsChips .logsChip.is-negated')).toContainText(`code.function ≠ ${fn}`);
  // No record of the answer has that function. When every record of the
  // host's "inserted" template has it (the SQL-generated bulk fixture: one
  // operation per service) the exclusion empties the table; the Python one
  // (a fresh stack) logs it from several operations, whose records remain.
  const left = (await (await excludedSearch).json()).rows;
  expect(left.every((row) => row.log_attributes['code.function'] !== fn)).toBe(true);
  if (left.length) await expect(rows(page).first()).toBeVisible();
  else await expect(page.locator('#logsTableMessage')).toContainText('No logs match these filters');
  // Removing its chip restores it.
  await page.locator('#logsChips .logsChip.is-negated .chip__remove').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`ResourceAttributes.host.name=${host}`]);
  await expect(rows(page).first()).toBeVisible();

  // "Search only this" drops the text search and the other filters.
  await rows(page).first().click();
  const levelRow = panel.locator('.kvList__row').filter({ has: page.locator('.kvList__key', { hasText: /^SeverityText$/ }) });
  const level = (await levelRow.locator('.kvList__value').innerText()).trim();
  await levelRow.hover();
  await levelRow.locator('[data-kv-action="only"]').click();
  await expect.poll(() => param(page, 'attr')).toEqual([`SeverityText=${level}`]);
  await expect.poll(() => param(page, 'q')).toEqual([]);
  await expect(page.locator('#logsQuery')).toHaveValue('');

  // Open trace links to the Traces view with the span focused.
  await rows(page).first().click();
  const traceId = (await panel.locator('.kvList__row').filter({ has: page.locator('.kvList__key', { hasText: /^TraceId$/ }) }).locator('.kvList__value').innerText()).trim();
  const spanId = (await panel.locator('.kvList__row').filter({ has: page.locator('.kvList__key', { hasText: /^SpanId$/ }) }).locator('.kvList__value').innerText()).trim();
  const open = page.locator('#logsOpenTrace');
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', new RegExp(`/observability/traces/${traceId}\\?span=${spanId}$`));
  // Escape closes the panel.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await rows(page).first().click();
  // The trace opens as a page of its own (a navigation), with the logs time range.
  await page.evaluate(() => { window.__sameDocument = true; });
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${traceId}\\?span=${spanId}&from=`));
  await expect(page.locator('#traceDetail')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#logsWorkspace')).toHaveCount(0);
  expect(await page.evaluate(() => window.__sameDocument)).toBeUndefined();
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

test('logs: patterns tab, denoise and filter by pattern', async ({ page }) => {
  // Three hours of the rich day (2026-09-12 09:00-12:00, tests/README.md
  // "Rich OTel dataset"), on every stack: ~29 k records, request logs above
  // 10 % of them (noise) and dozens of quieter templates. (The bulk
  // fixture's newest records have no template above 10 % on a fresh stack.)
  const start = Date.UTC(2026, 8, 12, 9);
  const win = { start, end: start + 3 * 3_600_000, from: fmt(start), to: fmt(start + 3 * 3_600_000) };
  await openLogs(page, logsUrl(win));
  const mined = page.waitForResponse((r) => r.url().includes('/api/logs/patterns'), { timeout: 30_000 });
  await page.locator('#logsTabPatterns').click();
  await expect.poll(() => param(page, 'tab')).toEqual(['patterns']);
  const patternRows = page.locator('#logsPatterns .logsPatternRow');
  await expect(patternRows.first()).toBeVisible({ timeout: 30_000 });
  // The pattern clicked at the end: a quiet one, three constant words or
  // more around a variable.
  const quiet = ((await (await mined).json()).patterns || []).find((p) => !p.noisy && p.share < 0.07 && p.search
    && p.pattern.includes('<*>') && p.pattern.split(' ').filter((word) => word !== '<*>').length >= 3);
  expect(quiet, 'a quiet pattern with constant words').toBeTruthy();
  // The status line speaks for the Patterns tab: the sample and how the
  // counts were extrapolated from it (Results has its own line).
  const status = page.locator('#logsStatus');
  // The sample picks whole blocks of rows by hash: up to 10,000 records,
  // a little fewer when the hashes fall short of the target rate.
  await expect(status).toContainText(/patterns? in a sample of [\d,]+ of [\d,]+ logs/);
  const [sampled, total] = (await status.innerText()).match(/a sample of ([\d,]+) of ([\d,]+) logs/).slice(1).map((n) => Number(n.replace(/,/g, '')));
  expect(sampled).toBeLessThanOrEqual(10_000);
  expect(sampled).toBeGreaterThan(5_000);
  expect(total).toBeGreaterThan(sampled);
  await expect(status).toContainText(/counts extrapolated ×[\d.]+[KMB]? from the sample/);
  await expect(status).not.toContainText('logs shown');
  // A share is its figure beside its own bar, never a bar under the figure.
  const share = patternRows.first().locator('.shareBar');
  const text = await share.locator('.shareBar__text').boundingBox();
  const track = await share.locator('.shareBar__track').boundingBox();
  expect(track.x).toBeGreaterThanOrEqual(text.x + text.width);
  await expect(patternRows.first().locator('.logsSparkline polyline')).toHaveCount(1);
  await expect(patternRows.first().locator('.logsPattern__var').first()).toHaveText('<*>');
  const all = await patternRows.count();
  const shares = async () => (await page.locator('#logsPatterns .logsPatternRow__share').allInnerTexts()).map((t) => (t.startsWith('<') ? 0 : parseFloat(t)));
  expect((await shares()).some((s) => s > 10)).toBe(true);
  await page.locator('#logsDenoise').check();
  await expect.poll(() => param(page, 'denoise')).toEqual(['1']);
  await expect.poll(() => patternRows.count()).toBeLessThan(all);
  for (const share of await shares()) expect(share).toBeLessThanOrEqual(10);
  await expect(page.locator('#logsStatus')).toContainText('denoise hides');
  // Reload keeps the tab and the toggle.
  await page.reload();
  await expect(patternRows.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#logsDenoise')).toBeChecked();
  // Clicking a pattern filters the results by its constant words.
  const target = page.locator(`#logsPatterns .logsPatternRow[title="Filter by this pattern: ${quiet.search.replace(/["\\]/g, '\\$&')}"]`);
  await target.click();
  await expect.poll(() => param(page, 'tab')).toEqual([]);
  await expect(page.locator('#logsResultsPane')).toBeVisible();
  await expect(page.locator('#logsQuery')).toHaveValue(quiet.search);
  await expect(rows(page).first()).toBeVisible();
  // Every record shown has the pattern's shape (<*> is one token).
  const shape = new RegExp(`^${quiet.pattern.split('<*>').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\S+')}$`);
  for (const body of await page.locator('#logsTableRows .logsCell--body').allInnerTexts()) {
    expect(body).toMatch(shape);
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

test('logs: no live tail: no Live control, and no request fires on a timer after the search', async ({ page }) => {
  const now = Date.now();
  const initial = [3, 2, 1].map((i) => syntheticRow(now - i * 60000, i, `initial record ${i}`));
  const calls = { search: 0, histogram: 0, other: 0 };
  await page.clock.install();
  await page.route('**/api/logs/search**', async (route) => {
    calls.search += 1;
    expect(new URL(route.request().url()).searchParams.get('after')).toBeNull();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ v: 1, rows: initial, row_count: initial.length, next_cursor: null, exhausted: true, truncated: false,
        mode: 'page', windows: [], text_search: { active: false } }),
    });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/logs/histogram')) calls.histogram += 1;
    else if (/\/api\/logs\/(services|patterns|context)/.test(url)) calls.other += 1;
  });
  // A former link's live=1 is tolerated: the search runs, the parameter is dropped.
  await page.goto('/observability/logs?from=now-15m&to=now&live=1');
  await expect(rows(page)).toHaveCount(3, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/[?&]live=/);
  // The bar's only action is Search.
  await expect(page.locator('#logsForm .obsFilterBar__actions > *')).toHaveCount(1);
  await expect(page.locator('#logsForm .obsFilterBar__actions > :only-child')).toHaveId('logsSearchButton');
  await expect(page.locator('#logsLiveButton')).toHaveCount(0);
  await expect(page.locator('#logsStatus')).not.toContainText(/live/i);
  await page.waitForTimeout(500);
  const before = { ...calls };
  for (let i = 0; i < 10; i++) {
    await page.clock.runFor(30_000);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(300);
  expect(calls).toEqual(before);
  // Search reads again.
  await page.locator('#logsSearchButton').click();
  await expect.poll(() => calls.search).toBeGreaterThan(before.search);
});

test('logs: an empty range offers the newest data, errors are shown', async ({ page, request }) => {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.time_bounds, 'no logs');
  // An hour after the newest record (the default range holds a fresh
  // stack's newest records, not a long-lived one's).
  const after = Number(meta.time_bounds.max_ms) + 3_600_000;
  await page.goto(logsUrl({ from: fmt(after), to: fmt(after + 3_600_000) }));
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

// Audit round 2: the record's head on a phone: the title (severity and
// service, then the time on its own line, whole), the close cross beside it,
// the actions (Open trace, Copy JSON on one line) on a row of their own.
test('logs: on a phone the record head keeps the time whole and Copy JSON on one line', async ({ page, request }) => {
  const win = await logsWindow(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openLogs(page, logsUrl(win));
  await rows(page).nth(1).click();
  await expect(page.locator('#logsSidePanel')).toBeVisible();
  const head = await page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const time = document.querySelector('#logsSideTitle .logsSideTitle__time');
    const service = document.querySelector('#logsSideTitle .logsSideTitle__service');
    const copy = document.getElementById('logsCopyJson');
    const close = document.getElementById('logsSideClose');
    const title = document.getElementById('logsSideTitle');
    const actions = document.querySelector('.logsSidePanel__headerActions');
    return {
      timeBelow: box(time).top >= box(service).bottom - 1,
      timeWhole: time.scrollWidth <= time.clientWidth + 1 && box(time).right <= innerWidth,
      copyOneLine: box(copy).height <= 34 && copy.scrollWidth <= copy.clientWidth + 1,
      closeBesideTitle: box(close).top < box(title).bottom && box(close).left > box(title).right - 1,
      actionsBelow: box(actions).top >= box(title).bottom - 1,
    };
  });
  expect(head).toEqual({ timeBelow: true, timeWhole: true, copyOneLine: true, closeBesideTitle: true, actionsBelow: true });
});

test('logs: the page switcher reaches the Observability page, whose Logs tab opens the logs view', async ({ page, request }) => {
  const version = await (await request.get('/api/version')).json();
  test.skip(!version.features?.logs?.enabled, 'logs disabled');
  await page.goto('/query');
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Explorer', 'Observability', 'System']);
  await page.locator('#navObservabilityButton').click();
  await expect(page).toHaveURL(/\/observability\/(traces|logs|metrics)(\?|$)/);
  await expect(page.locator('#pageSelectButton')).toHaveText('Observability');
  await page.locator('#obsTab-logs').click();
  await expect(page).toHaveURL(/\/observability\/logs(\?|$)/);
  await expect(page.locator('#logsWorkspace')).toBeVisible();
  await expect(page.locator('#obsTab-logs')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#pageSelectButton').click();
  await expect(page.locator('#pageSelectMenu .themeSelect__option:visible')).toHaveText(['Query', 'Explorer', 'System']);
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

// --- Fields panel: the Traces Attributes facets (app_facet_panel.js) over
// /api/logs/facets and /api/logs/facet_values.

const fieldsPanel = (page) => page.locator('#logsFacets');
const field = (page, key) => fieldsPanel(page).locator(`.traceFacet[data-facet-key="${key}"]`);
const fieldValue = (page, key, value) => field(page, key).locator(`.traceFacetValue[data-facet-value="${value}"]`);

async function freshFields(page) {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__logsFieldsInit')) {
        localStorage.removeItem('chdash.logsFacetPins.v1');
        localStorage.removeItem('chdash.logsFacetsCollapsed.v1');
        sessionStorage.setItem('__logsFieldsInit', '1');
      }
    } catch (_) {}
  });
}

test('logs: the Fields panel lists fields and top values; include, exclude, pin and fold; the filters and the URL follow', async ({ page, request }) => {
  await freshFields(page);
  const facetRequests = [];
  page.on('request', (req) => { if (/\/api\/logs\/facet/.test(req.url())) facetRequests.push(new URL(req.url())); });
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win));
  const panel = fieldsPanel(page);
  await expect(panel).toBeVisible();
  // Left of the histogram and the results: the side panel shell (ns.sidePanel,
  // --side-w), as the Traces Attributes.
  const box = await panel.boundingBox();
  const histogramBox = await page.locator('#logsHistogramCard').boundingBox();
  const tableBox = await page.locator('#logsTable').boundingBox();
  expect(Math.round(box.width)).toBe(288);
  expect(box.x + box.width).toBeLessThanOrEqual(histogramBox.x);
  expect(box.x + box.width).toBeLessThanOrEqual(tableBox.x);
  // A full-height column of the view body (the shell's full-bleed side panel).
  const body = await page.locator('.logsSearchBody').boundingBox();
  expect(Math.abs(box.y - body.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - (body.y + body.height))).toBeLessThanOrEqual(1);
  await expect(page.locator('#logsFacetsToggle')).toContainText('Fields');
  // The sample the counts come from, named: "from a 3M sample" (or every
  // matching record counted: "120K logs").
  await expect(page.locator('#logsFacetsMeta')).toHaveText(/^(?:from a [\d.]+[KMB]? sample|[\d.]+[KMB]? logs)$/);
  // The keys under their scope's name, the record columns first, then the
  // attribute maps; no letter badges.
  await expect(panel.locator('.traceFacet__scope')).toHaveCount(0);
  const groups = panel.locator('.traceFacets__group:not(.traceFacets__group--pinned) > .traceFacets__groupTitle');
  await expect(groups.first()).toHaveText('Record');
  await expect(groups).toContainText(['Record', 'Log attributes', 'Resource attributes']);
  const group = (key) => field(page, key).locator('xpath=..').getAttribute('data-facet-group');
  expect(await group('SeverityText')).toBe('column');
  expect(await group('code.function')).toBe('log');
  expect(await group('host.name')).toBe('resource');
  await expect(field(page, 'code.function').locator('[data-facet-expand]')).toHaveAttribute('title', /code\.function · Log attribute/);
  await expect(panel.locator('.traceFacet[data-facet-key="TraceId"]')).toHaveCount(0);
  // The request carries the search's own filters and range.
  const keysRequest = facetRequests.find((url) => url.pathname.endsWith('/api/logs/facets'));
  expect(Number(keysRequest.searchParams.get('end_ms')) - Number(keysRequest.searchParams.get('start_ms'))).toBeGreaterThan(9 * 60000);

  // Key search.
  await page.locator('#logsFacetsSearch').fill('host');
  await expect(panel.locator('.traceFacet')).toHaveCount(1);
  await page.locator('#logsFacetsSearch').fill('');

  // Top values of SeverityText; include WARN, then ERROR as well (one key's
  // values match any of them).
  await field(page, 'SeverityText').locator('[data-facet-expand]').click();
  await expect(fieldValue(page, 'SeverityText', 'WARN')).toBeVisible();
  await expect(fieldValue(page, 'SeverityText', 'WARN').locator('.traceFacetValue__count')).toHaveText(/^[\d.]+[KMB]?$/);
  await fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]').check();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=WARN']);
  await expect(page.locator('#logsChips')).toContainText('SeverityText = WARN');
  await expect(rows(page).first()).toBeVisible();
  for (const badge of await page.locator('#logsTableRows .badge--sev').allInnerTexts()) expect(badge).toBe('WARN');
  await expect(fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]')).toBeChecked();
  await expect(field(page, 'SeverityText')).toHaveClass(/is-active/);
  // Its own filter is left out of its values: the other levels stay listed.
  await expect(fieldValue(page, 'SeverityText', 'ERROR')).toBeVisible();
  await fieldValue(page, 'SeverityText', 'ERROR').locator('[data-facet-include]').check();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=WARN', 'SeverityText=ERROR']);
  await expect.poll(async () => new Set(await page.locator('#logsTableRows .badge--sev').allInnerTexts())).toEqual(new Set(['WARN', 'ERROR']));
  const valuesRequest = facetRequests.filter((url) => url.pathname.endsWith('/facet_values')).pop();
  expect(valuesRequest.searchParams.get('scope')).toBe('column');
  expect(valuesRequest.searchParams.get('key')).toBe('SeverityText');

  // ServiceName is the service picker's filter.
  await field(page, 'ServiceName').locator('[data-facet-expand]').click();
  const service = await field(page, 'ServiceName').locator('.traceFacetValue').first().getAttribute('data-facet-value');
  await fieldValue(page, 'ServiceName', service).locator('[data-facet-include]').check();
  await expect.poll(() => param(page, 'service')).toEqual([service]);
  await expect(page.locator('#logsServiceButton')).toHaveText(`Service · ${service}`);
  await expect(fieldValue(page, 'ServiceName', service).locator('[data-facet-include]')).toBeChecked();
  expect(await field(page, 'ServiceName').locator('.traceFacetValue').count()).toBeGreaterThan(1);
  for (const name of await page.locator('#logsTableRows .logsCell--service').allInnerTexts()) expect(name.trim()).toBe(service);

  // Exclude a resource value: a negated map-qualified filter.
  await field(page, 'host.name').locator('[data-facet-expand]').click();
  const host = await field(page, 'host.name').locator('.traceFacetValue').first().getAttribute('data-facet-value');
  await fieldValue(page, 'host.name', host).locator('[data-facet-exclude]').click();
  await expect.poll(() => param(page, 'attr')).toContain(`ResourceAttributes.host.name!=${host}`);
  await expect(page.locator('#logsChips .logsChip.is-negated')).toContainText(`host.name ≠ ${host}`);
  await expect(fieldValue(page, 'host.name', host)).toHaveClass(/is-excluded/);
  await expect(fieldValue(page, 'host.name', host).locator('[data-facet-exclude]')).toHaveAttribute('aria-pressed', 'true');

  // Unchecking WARN drops its filter; a removed chip unchecks its value.
  await fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]').uncheck();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=ERROR', `ResourceAttributes.host.name!=${host}`]);
  await page.locator('#logsChips .logsChip.is-negated .chip__remove').click();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=ERROR']);
  await expect(fieldValue(page, 'host.name', host)).not.toHaveClass(/is-excluded/);

  // A filter typed in the Filter input shows in the panel too.
  await page.locator('#logsFilterInput').fill('SeverityText=WARN');
  await page.locator('#logsFilterInput').press('Enter');
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=ERROR', 'SeverityText=WARN']);
  await expect(fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]')).toBeChecked();

  // Pin a key: it moves to the pinned group and stays pinned after a reload,
  // where the URL brings the filters (and the checked values) back.
  await field(page, 'code.lineno').locator('[data-facet-pin]').click();
  await expect(panel.locator('.traceFacets__group--pinned .traceFacet__key')).toHaveText(['code.lineno']);
  await page.reload();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.traceFacets__group--pinned .traceFacet__key')).toHaveText(['code.lineno']);
  await expect(field(page, 'SeverityText')).toHaveClass(/is-active/);
  await field(page, 'SeverityText').locator('[data-facet-expand]').click();
  await expect(fieldValue(page, 'SeverityText', 'ERROR').locator('[data-facet-include]')).toBeChecked();
  // Back undoes the last filter.
  await page.goBack();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=ERROR']);
  await expect(fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]')).not.toBeChecked();

  // Folding: a 32 px rail, remembered across reloads; unfolding reloads the keys.
  await page.locator('#logsFacetsToggle').click();
  await expect(page.locator('#logsFacetsToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#logsFacetsList')).toBeHidden();
  expect(Math.round((await panel.boundingBox()).width)).toBe(32);
  await page.reload();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#logsFacetsToggle')).toHaveAttribute('aria-expanded', 'false');
  const before = facetRequests.length;
  await page.locator('#logsFacetsToggle').click();
  await expect(panel.locator('.traceFacet').first()).toBeVisible();
  expect(facetRequests.length).toBeGreaterThan(before);
  // The Traces Attributes panel keeps its own fold state.
  expect(await page.evaluate(() => document.documentElement.classList.contains('chdash-trace-facets-collapsed'))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('logs: the Results / Patterns tabs are the in-content tab component (arrow, Home and End keys)', async ({ page, request }) => {
  const win = await logsWindow(request, 10);
  await openLogs(page, logsUrl(win));
  const results = page.locator('#logsTabResults');
  const patterns = page.locator('#logsTabPatterns');
  await expect(results).toHaveAttribute('tabindex', '0');
  await expect(patterns).toHaveAttribute('tabindex', '-1');
  await results.focus();
  await page.keyboard.press('ArrowRight');
  await expect(patterns).toBeFocused();
  await expect(patterns).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => param(page, 'tab')).toEqual(['patterns']);
  await expect(page.locator('#logsPatternsPane')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(results).toBeFocused();
  await expect(results).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#logsResultsPane')).toBeVisible();
  await page.keyboard.press('End');
  await expect(patterns).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(results).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => param(page, 'tab')).toEqual([]);
  // Back steps through the tab changes.
  await page.goBack();
  await expect(patterns).toHaveAttribute('aria-selected', 'true');
});

test('logs: on a phone the Fields panel is a drawer, opened from the top of the records', async ({ page, request }) => {
  await freshFields(page);
  const win = await logsWindow(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await openLogs(page, logsUrl(win));
  const panel = fieldsPanel(page);
  const toggle = page.locator('#logsFacetsDrawerToggle');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', 'logsFacets');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.traceFacet').first()).toBeVisible({ timeout: 30_000 });
  // Over the records from the left edge, under the page chrome.
  await expect.poll(async () => Math.round((await panel.boundingBox()).x)).toBe(0);
  const box = await panel.boundingBox();
  const nav = await page.locator('#obsNav').boundingBox();
  expect(box.width).toBeLessThanOrEqual(390 * 0.86 + 1);
  expect(box.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  expect(Math.round(box.y + box.height)).toBe(844);
  await field(page, 'SeverityText').locator('[data-facet-expand]').click();
  await fieldValue(page, 'SeverityText', 'WARN').locator('[data-facet-include]').check();
  await expect.poll(() => param(page, 'attr')).toEqual(['SeverityText=WARN']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Escape closes it (ns.layers) and gives the focus back to its toggle.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toBeFocused();
  // A press on the scrim closes it too.
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(380, 600);
  await expect(panel).toBeHidden();
});

test.describe('logs on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('logs on a phone: each record is a two-line card, Time, Level and Service over the Body', async ({ page, request }) => {
    const win = await logsWindow(request);
    await openLogs(page, logsUrl(win));
    await expect(page.locator('#logsTable')).toHaveClass(/logsTable--cards/);
    await expect(page.locator('#logsTableHead')).toBeHidden();
    const first = rows(page).first();
    await expect(first).toHaveClass(/logsRow--card/);
    const card = await first.evaluate((row) => {
      const box = (cls) => row.querySelector(cls)?.getBoundingClientRect();
      const [time, sev, service, body] = ['.logsCell--time', '.logsCell--sev', '.logsCell--service', '.logsCell--body'].map(box);
      return {
        height: row.getBoundingClientRect().height,
        middle: [time, sev, service].map((r) => Math.round((r.top + r.bottom) / 2)),
        bodyBelow: body.top >= time.bottom - 1,
        bodyWide: body.width > row.getBoundingClientRect().width - 40,
        bodyText: row.querySelector('.logsCell--body').textContent.trim().length > 0,
        overflows: row.scrollWidth > row.clientWidth + 1,
      };
    });
    expect(card.height).toBe(52);
    expect(Math.max(...card.middle) - Math.min(...card.middle), 'Time, Level and Service on one line').toBeLessThanOrEqual(2);
    expect(card).toMatchObject({ bodyBelow: true, bodyWide: true, bodyText: true, overflows: false });
    // The cards are the virtual rows: scrolled, the list stays aligned.
    const viewport = page.locator('#logsTableViewport');
    await viewport.evaluate((el) => { el.scrollTop = 52 * 30; });
    await expect.poll(() => rows(page).first().getAttribute('data-row-index')).not.toBe('0');
    const index = Number(await rows(page).first().getAttribute('data-row-index'));
    const offset = await page.locator('#logsTableRows').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42);
    expect(offset).toBe(index * 52);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('logs on a touch screen: a field\'s actions open from its "..." button as a menu', async ({ page, request }) => {
    const win = await logsWindow(request);
    await openLogs(page, logsUrl(win));
    await rows(page).first().click();
    const side = page.locator('#logsSidePanel');
    await expect(side).toBeVisible();
    const row = side.locator('.kvList__row', { has: page.locator('[data-kv-more]') }).first();
    await expect(row).toBeVisible();
    // The single actions give way to the "..." button, --hit square.
    await expect(row.locator('[data-kv-action]').first()).toBeHidden();
    const more = row.locator('[data-kv-more]');
    const box = await more.boundingBox();
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([40, 40]);
    await more.tap();
    const menu = page.locator('.kvMenu[role="menu"]');
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const items = menu.locator('[role="menuitem"]');
    expect(await items.count()).toBeGreaterThanOrEqual(2);
    for (const item of await items.all()) expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(40);
    await expect(items.first()).toHaveText('Filter for this value');
    await items.first().tap();
    await expect(menu).toBeHidden();
    await expect.poll(() => param(page, 'attr').length + param(page, 'service').length + param(page, 'sev').length + param(page, 'level').length).toBeGreaterThan(0);
  });
});
