import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';
import { MOCK_TRACE_START_NS, nestedTrace, routeTrace } from '../helpers/trace-mocks.js';

// OTel logs in the trace detail page (HyperDX's TraceLogsPanel feel): the
// header Logs toggle and panel, log count badges and markers on span rows,
// a span's logs listed under its row, the inspector Logs group, and a log
// click opening its span. The first test runs on a real fixture trace from
// the last hour of the logs window; the others on mocked answers.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => {
  observers.set(page, installObservers(page));
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__traceLogsInit')) {
        localStorage.removeItem('chdash.traceLogs.panelOpen');
        localStorage.removeItem('chdash.traceView');
        sessionStorage.setItem('__traceLogsInit', '1');
      }
    } catch (_) { /* storage is optional */ }
  });
});
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const SHOTS = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/trace-logs`;
const headerToggle = (page) => page.locator('#traceDetailStats [data-trace-header-item="Logs"] [data-trace-logs-toggle]');
const panel = (page) => page.locator('#traceLogsPanel');
const panelRows = (page) => page.locator('#traceLogsPanel .traceLog--panel');
const spanRow = (page, id) => page.locator(`#traceWaterfall .traceSpanRow[data-span-id="${id}"]`);
const inlineRows = (page, id) => page.locator(`#traceWaterfall .traceSpanLogsRow[data-span-logs-for="${id}"]`);
const inspector = (page, id) => page.locator(`#traceWaterfall [data-inspector-span="${id}"]`);

async function setTheme(page, theme) {
  await page.evaluate((mode) => localStorage.setItem('chdash.theme', mode), theme);
}

// A fixture trace of the last logs hour with error logs and a span holding
// several logs, from the APIs the page itself uses.
async function findFixtureTrace(request) {
  const version = await (await request.get('/api/version')).json();
  if (!version.features?.logs?.enabled || !version.features?.traces?.enabled) return null;
  const meta = await (await request.get('/api/logs/meta', { params: { host_id: 'local' } })).json();
  const endMs = Number(meta?.time_bounds?.max_ms || 0);
  if (!meta.table_exists || !(endMs > 0)) return null;
  const search = await request.get('/api/traces/search', {
    params: { host_id: 'local', start_ms: String(endMs - 55 * 60_000), end_ms: String(endMs - 5 * 60_000), limit: '20' },
    timeout: 60_000,
  });
  expect(search.ok(), await search.text()).toBe(true);
  const rows = ((await search.json()).rows || []).filter((row) => Number(row[5]) >= 20);
  for (const row of rows.slice(0, 12)) {
    const traceId = row[0];
    const detail = await (await request.get('/api/traces/trace', { params: { host_id: 'local', trace_id: traceId }, timeout: 60_000 })).json();
    const spans = detail.spans || [];
    const ids = spans.map((s) => s.span_id);
    if (new Set(ids).size !== ids.length) continue;
    const start = Math.min(...spans.map((s) => Number(s.start_ns)));
    const end = Math.max(...spans.map((s) => Number(s.start_ns) + Number(s.duration_ns)));
    const params = new URLSearchParams({ host_id: 'local', trace_id: traceId, start_ns: String(Math.floor(start)), end_ns: String(Math.ceil(end)) });
    for (const service of new Set(spans.map((s) => s.service_name))) params.append('service', service);
    const logs = await (await request.get(`/api/traces/logs?${params}`, { timeout: 60_000 })).json();
    const records = logs.logs || [];
    const perSpan = new Map();
    for (const r of records) if (r.span_id) perSpan.set(r.span_id, (perSpan.get(r.span_id) || 0) + 1);
    const busiest = [...perSpan.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (records.some((r) => r.severity_text === 'ERROR') && busiest && busiest[1] >= 2) {
      return { traceId, spans, logs: records, perSpan, busiest: busiest[0] };
    }
  }
  return null;
}

test('fixture trace: header count, panel filters, span badges, logs under a span, inspector group, a log opens its span', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await findFixtureTrace(request);
  test.skip(!fixture, 'OTel logs fixture is not available');
  const { traceId, spans, logs, perSpan, busiest } = fixture;

  await page.goto(`/observability/traces/${traceId}`);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(spans.length, { timeout: 30_000 });
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText(String(logs.length), { timeout: 30_000 });
  const errors = logs.filter((r) => r.severity_text === 'ERROR').length;
  await expect(headerToggle(page).locator('[data-trace-logs-errors]')).toHaveText(`${errors} ERR`);
  await expect(panel(page)).toBeHidden();

  // Badges: one per span with logs, with its count.
  await expect(page.locator('#traceWaterfall .traceSpanLogsBadge')).toHaveCount(perSpan.size);
  for (const [id, n] of [...perSpan.entries()].slice(0, 8)) {
    await expect(spanRow(page, id).locator('.traceSpanLogsBadge span')).toHaveText(String(n));
  }
  await expect(spanRow(page, busiest).locator('.traceSpanLogMarker').first()).toBeAttached();

  // The logs under a span: one line per log, details on click, closed again.
  await spanRow(page, busiest).locator('.traceSpanLogsBadge').click();
  await expect(inlineRows(page, busiest).locator('.traceLog--inline')).toHaveCount(perSpan.get(busiest));
  await expect(spanRow(page, busiest)).toHaveAttribute('aria-expanded', 'false');
  const line = inlineRows(page, busiest).locator('.traceLog--inline').first();
  await line.locator('.traceLog__row').click();
  await expect(line.locator('.traceLog__details .traceLog__attrs .traceKv')).toBeVisible();
  await expect(line.locator('.traceLog__details .kvList__row[data-kv-key="log.origin"]')).toBeVisible();
  // The row keeps the waterfall columns: the log line's timeline starts where the span row's does.
  const columns = await page.evaluate((id) => {
    const row = document.querySelector(`#traceWaterfall .traceSpanRow[data-span-id="${id}"] .traceSpanRow__timeline`);
    const logLine = document.querySelector(`#traceWaterfall .traceSpanLogsRow[data-span-logs-for="${id}"] .traceLogLine__timeline`);
    return [Math.round(row.getBoundingClientRect().left), Math.round(logLine.getBoundingClientRect().left)];
  }, busiest);
  expect(Math.abs(columns[0] - columns[1])).toBeLessThanOrEqual(1);
  if ([1280, 1920].includes(page.viewportSize().width)) await page.screenshot({ path: `${SHOTS}/inline-dark-${page.viewportSize().width}.png` });
  await spanRow(page, busiest).locator('.traceSpanLogsBadge').click();
  await expect(inlineRows(page, busiest)).toHaveCount(0);

  // The inspector's Logs group.
  await spanRow(page, busiest).locator('.traceSpanRow__name').click();
  const group = inspector(page, busiest).locator('[data-span-section="logs"]');
  await expect(group.locator(':scope > summary')).toContainText(`Logs(${perSpan.get(busiest)})`, { useInnerText: false });
  await group.locator(':scope > summary').click();
  await expect(group.locator('.traceLog--inspector')).toHaveCount(perSpan.get(busiest));
  await spanRow(page, busiest).locator('.traceSpanRow__name').click();
  await expect(inspector(page, busiest)).toHaveCount(0);

  // The panel: every log, then severity / service / text filters.
  await headerToggle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panelRows(page)).toHaveCount(Math.min(300, logs.length));
  const firstBody = panelRows(page).first().locator('.traceLog__body');
  await expect(firstBody).toHaveText(logs[0].body);
  await expect(panelRows(page).first().locator('.traceLog__offset')).toHaveText(/^[+−]\d/);
  await expect(panelRows(page).first().locator('.traceLog__offset')).toHaveAttribute('title', /UTC/);
  await page.locator('#traceLogsPanel [data-log-severity="error"]').click();
  await expect(panelRows(page)).toHaveCount(errors);
  await expect(page.locator('#traceLogsPanel .traceLog--panel[data-sev]:not([data-sev="error"])')).toHaveCount(0);
  await page.locator('#traceLogsPanel [data-log-severity="error"]').click();
  const service = logs[0].service_name;
  await page.locator('#traceLogsPanel .traceLogsPanel__service .tracePicker__button').click();
  await page.locator('#traceLogsPanel .traceLogsPanel__service .tracePicker__menu').getByRole('option', { name: new RegExp(`^${service} \\(`) }).click();
  await expect(panelRows(page)).toHaveCount(logs.filter((r) => r.service_name === service).length);
  await expect(panelRows(page).locator('.traceLog__service')).toHaveText(Array(logs.filter((r) => r.service_name === service).length).fill(service));
  await page.locator('#traceLogsPanel .traceLogsPanel__service .tracePicker__button').click();
  await page.locator('#traceLogsPanel .traceLogsPanel__service .tracePicker__menu').getByRole('option', { name: /^ALL/ }).click();
  const word = logs[0].body.split(/\s+/)[0];
  await page.locator('#traceLogsFilter').fill(word);
  const matching = logs.filter((r) => [r.body, r.severity_text, r.service_name, r.span_id, r.scope_name, r.log_attributes].join(' ').toLowerCase().includes(word.toLowerCase())).length;
  await expect(panelRows(page)).toHaveCount(Math.min(300, matching));
  await expect(page.locator('#traceLogsFilter')).toBeFocused();
  await page.locator('#traceLogsFilter').fill('');
  if ([1280, 1920].includes(page.viewportSize().width)) {
    for (const theme of ['dark', 'light']) {
      await setTheme(page, theme);
      await page.reload();
      await expect(panelRows(page).first()).toBeVisible({ timeout: 30_000 });
      await panelRows(page).first().locator('.traceLog__toggle').click();
      await spanRow(page, busiest).locator('.traceSpanLogsBadge').click();
      await page.screenshot({ path: `${SHOTS}/panel-${theme}-${page.viewportSize().width}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, theme).toBeLessThanOrEqual(1);
    }
    await page.evaluate(() => localStorage.removeItem('chdash.theme'));
    await page.reload();
    await expect(panelRows(page).first()).toBeVisible({ timeout: 30_000 });
  }

  // A log opens its span: ?span=, inspector with the Logs group open, the log marked.
  const target = logs.find((r) => r.span_id === busiest);
  const index = logs.indexOf(target);
  await panel(page).locator(`.traceLog--panel[data-log-index="${index}"] .traceLog__body`).click();
  await expect(page).toHaveURL(new RegExp(`[?&]span=${busiest}`));
  const card = inspector(page, busiest);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-span-section="logs"]')).toHaveAttribute('open', '');
  await expect(card.locator(`.traceLog.is-target[data-log-index="${index}"]`)).toBeVisible();
  await expect(spanRow(page, busiest)).toHaveClass(/is-deep-linked/);

  // Open in Logs: the Logs view, in place, on this trace and its log window; Back returns.
  await page.evaluate(() => { window.__sameDocument = true; });
  await panel(page).locator('[data-trace-logs-open]').click();
  await expect(page).toHaveURL(new RegExp(`/observability/logs\\?from=.+&trace_id=${traceId}`));
  await expect(page.locator('#logsWorkspace')).toBeVisible();
  await expect(page.locator('#logsTableRows .logsRow[data-row-id]').first()).toBeVisible({ timeout: 30_000 });
  // Every listed record belongs to the trace.
  await expect(page.locator('#logsChips')).toContainText(traceId.slice(0, 8));
  expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
  await page.goBack();
  await expect(page.locator('#traceDetail')).toBeVisible();
  testInfo.annotations.push({ type: 'trace', description: `${traceId}: ${logs.length} logs` });
});

// ---------------------------------------------------------------------------
// Mocked answers.

const TRACE = nestedTrace('b1b2c3d4e5f60718293a4b5c6d7e8f91');
const sid = (n) => n.toString(16).padStart(16, '0');
const SEV_NUMBER = { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 };

function logRecord({ span = '', at, sev = 'INFO', body = 'hello', service = 'frontend', attrs = {} }) {
  const ns = MOCK_TRACE_START_NS + BigInt(Math.round(at * 1000)) * 1000n;
  const seconds = ns / 1_000_000_000n;
  const iso = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    timestamp_ns: String(ns),
    timestamp: `${iso}.${String(ns % 1_000_000_000n).padStart(9, '0')}`,
    severity_text: sev,
    severity_number: SEV_NUMBER[sev] || 0,
    service_name: service,
    span_id: span,
    body,
    log_attributes: JSON.stringify(attrs),
    resource_attributes: JSON.stringify({ 'service.name': service }),
    scope_name: service,
  };
}

function logsAnswer(records, extra = {}) {
  return {
    enabled: true, signal: 'logs', table_exists: true, source_host_id: 'local', database: 'otel', table: 'otel_logs',
    trace_id: TRACE.trace_id, span_id: '', services: [], attributes: { log: 'map', resource: 'map' },
    window: { start_ns: String(MOCK_TRACE_START_NS), end_ns: String(MOCK_TRACE_START_NS + 100_000_000n), from_s: 0, to_s: 0, margin_before_s: 5, margin_after_s: 30, time_column: 'TimestampTime', clamped: false },
    limit: 1000, count: records.length, truncated: false, elapsed_ms: 3, logs: records, ...extra,
  };
}

async function routeLogs(page, handler) {
  const requests = [];
  await page.route((url) => url.pathname.endsWith('/api/traces/logs'), async (route) => {
    requests.push(new URL(route.request().url()));
    return handler(route, requests.length);
  });
  return requests;
}

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openMocked(page, trace = TRACE) {
  await routeTrace(page, trace);
  await page.goto(`/observability/traces/${trace.trace_id}`);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(trace.spans.length, { timeout: 20_000 });
}

test('mocked: logs load after the trace, with a loading state, the trace bounds and its services', async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = await routeLogs(page, async (route) => {
    await gate;
    return json(route, logsAnswer([logRecord({ span: sid(1), at: 5, body: 'request received' })]));
  });
  await openMocked(page);
  // The trace is on screen while the logs are still loading.
  await expect(headerToggle(page)).toHaveClass(/is-loading/);
  await headerToggle(page).click();
  await expect(panel(page).locator('[data-trace-logs-state="loading"]')).toBeVisible();
  expect(requests).toHaveLength(1);
  const params = requests[0].searchParams;
  expect(params.get('trace_id')).toBe(TRACE.trace_id);
  expect(params.get('start_ns')).toBe(String(MOCK_TRACE_START_NS));
  expect(BigInt(params.get('end_ns')) - MOCK_TRACE_START_NS).toBe(100_000_000n);
  expect(params.getAll('service').sort()).toEqual([...new Set(TRACE.spans.map((s) => s.service))].sort());
  release();
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText('1');
  await expect(panelRows(page)).toHaveCount(1);
  await expect(spanRow(page, sid(1)).locator('.traceSpanLogsBadge span')).toHaveText('1');
  // The panel stays open for the next trace (remembered).
  await page.reload();
  await expect(panelRows(page)).toHaveCount(1, { timeout: 20_000 });
});

test('mocked: an error answer shows in the header and the panel, Retry loads again', async ({ page }) => {
  await routeLogs(page, (route, n) => (n === 1
    ? json(route, { error_code: 'trace_logs_query_failed', message: 'Code: 159. Timeout exceeded' }, 503)
    : json(route, logsAnswer([logRecord({ span: sid(7), at: 20, sev: 'ERROR', body: 'lock timeout', service: 'inventory-db' })]))));
  await openMocked(page);
  await expect(headerToggle(page)).toHaveClass(/is-error/);
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText('!');
  await headerToggle(page).click();
  await expect(panel(page).locator('[data-trace-logs-state="error"]')).toContainText('Timeout exceeded');
  await panel(page).locator('[data-trace-logs-retry]').click();
  await expect(panelRows(page)).toHaveCount(1);
  await expect(panelRows(page).first()).toHaveAttribute('data-sev', 'error');
  await expect(spanRow(page, sid(7)).locator('.traceSpanLogsBadge')).toHaveAttribute('data-sev', 'error');
});

test('mocked: severities use the Logs view palette (info blue) in both themes; Escape closes the panel back to its toggle', async ({ page }) => {
  await routeLogs(page, (route) => json(route, logsAnswer([
    logRecord({ span: sid(1), at: 5, sev: 'INFO', body: 'request received' }),
    logRecord({ span: sid(2), at: 9, sev: 'WARN', body: 'slow cache' }),
    logRecord({ span: sid(7), at: 20, sev: 'ERROR', body: 'lock timeout' }),
    logRecord({ span: sid(7), at: 21, sev: 'DEBUG', body: 'retrying' }),
  ])));
  await openMocked(page);
  await headerToggle(page).click();
  await expect(panelRows(page)).toHaveCount(4);
  const colours = () => page.evaluate(() => {
    const probe = document.createElement('i');
    document.body.appendChild(probe);
    const out = {};
    for (const sev of ['error', 'warn', 'info', 'debug']) {
      probe.style.color = `var(--sev-${sev})`;
      // The severity chips are the shared severity badge: its text colour.
      const chip = document.querySelector(`#traceLogsPanel [data-log-severity="${sev}"]`);
      out[sev] = { logs: getComputedStyle(probe).color, trace: chip ? getComputedStyle(chip).color : null };
    }
    probe.remove();
    return out;
  });
  const blue = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return b > r + 60 && b > g + 30; };
  for (const theme of ['dark', 'light']) {
    await page.evaluate((mode) => { document.documentElement.dataset.theme = mode; }, theme);
    const seen = await colours();
    for (const [sev, { logs, trace }] of Object.entries(seen)) expect(trace, `${theme} ${sev}`).toBe(logs);
    expect(blue(seen.info.trace), `${theme} info ${seen.info.trace}`).toBe(true);
  }
  await panel(page).locator('#traceLogsFilter').focus();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(headerToggle(page)).toBeFocused();
});

test('mocked: many logs, truncated: the notice, paging, trace-level logs and the span column', async ({ page }) => {
  const services = ['frontend', 'checkout', 'inventory', 'payments'];
  const records = Array.from({ length: 1000 }, (_, i) => logRecord({
    span: i % 50 === 0 ? '' : sid(1 + (i % 12)), at: (i / 1000) * 100, sev: ['DEBUG', 'INFO', 'INFO', 'WARN', 'ERROR'][i % 5],
    body: `record ${i} of the trace`, service: services[i % services.length],
  }));
  await routeLogs(page, (route) => json(route, logsAnswer(records, { truncated: true, limit: 1000 })));
  await openMocked(page);
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText('1,000+');
  await headerToggle(page).click();
  await expect(panel(page).locator('[data-trace-logs-notice]')).toContainText('Showing the first 1,000 logs');
  await expect(panel(page).locator('[data-trace-logs-notice]')).toContainText('20 logs have no span of this trace');
  await expect(panelRows(page)).toHaveCount(300);
  await panel(page).locator('[data-trace-logs-more]').click();
  await expect(panelRows(page)).toHaveCount(600);
  await expect(panelRows(page).first().locator('.traceLog__span')).toHaveClass(/is-missing/);
  await expect(panelRows(page).nth(1).locator('.traceLog__span')).toHaveText('render');
  // Severity chips count every loaded log.
  await expect(panel(page).locator('[data-log-severity="error"] b')).toHaveText('200');
  await panel(page).locator('#traceLogsFilter').fill('record 99 of');
  await expect(panelRows(page)).toHaveCount(1);
  await expect(panel(page).locator('.traceLogsPanel__matches')).toHaveText('1 of 1,000 shown');
  await panel(page).locator('#traceLogsFilter').fill('no such text');
  await expect(panel(page).locator('[data-trace-logs-state="filtered"]')).toBeVisible();
  await panel(page).locator('[data-trace-logs-clear]').click();
  await expect(panelRows(page)).toHaveCount(300);
  // Every span row has a badge; markers are grouped per 0.2 % of the view.
  await expect(page.locator('#traceWaterfall .traceSpanLogsBadge')).toHaveCount(12);
  const markers = await spanRow(page, sid(1)).locator('.traceSpanLogMarker').count();
  expect(markers).toBeGreaterThan(0);
  expect(markers).toBeLessThanOrEqual(500);
  // A span with more than 100 logs lists 100 under its row, then a link to the panel.
  const busy = logRecordCount(records, sid(2));
  expect(busy).toBeGreaterThan(80);
  await spanRow(page, sid(2)).locator('.traceSpanLogsBadge').click();
  await expect(inlineRows(page, sid(2)).locator('.traceLog--inline')).toHaveCount(Math.min(100, busy));
});

function logRecordCount(records, id) {
  return records.filter((r) => r.span_id === id).length;
}

test('mocked: spans sharing a SpanId get the logs inside their own interval, else the nearest', async ({ page }) => {
  const trace = {
    trace_id: 'c1b2c3d4e5f60718293a4b5c6d7e8f92',
    spans: [
      { span_id: sid(1), name: 'root', service: 'api', start_ms: 0, duration_ms: 100 },
      { span_id: sid(2), parent_span_id: sid(1), name: 'retry', service: 'api', start_ms: 10, duration_ms: 10 },
      { span_id: sid(2), parent_span_id: sid(1), name: 'retry', service: 'api', start_ms: 60, duration_ms: 10 },
    ],
  };
  await routeLogs(page, (route) => json(route, logsAnswer([
    logRecord({ span: sid(2), at: 12, body: 'first attempt', service: 'api' }),
    logRecord({ span: sid(2), at: 65, body: 'second attempt', service: 'api' }),
    logRecord({ span: sid(2), at: 72, body: 'after the second attempt', service: 'api' }),
  ])));
  await openMocked(page, trace);
  const badges = page.locator(`#traceWaterfall .traceSpanRow[data-span-id="${sid(2)}"] .traceSpanLogsBadge span`);
  await expect(badges).toHaveText(['1', '2']);
});

test('mocked: an empty answer, a missing table and disabled logs', async ({ page }) => {
  let answer = logsAnswer([]);
  const requests = await routeLogs(page, (route) => json(route, answer));
  await openMocked(page);
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText('0');
  await headerToggle(page).click();
  await expect(panel(page).locator('[data-trace-logs-state="empty"]')).toContainText('No logs for this trace in otel.otel_logs');
  await expect(page.locator('#traceWaterfall .traceSpanLogsBadge')).toHaveCount(0);

  answer = { enabled: true, signal: 'logs', table_exists: false, error_code: 'logs_table_missing', message: 'Table otel.otel_logs does not exist on host local.', count: 0, truncated: false, logs: [] };
  await page.reload();
  await expect(headerToggle(page).locator('[data-trace-logs-count]')).toHaveText('—', { timeout: 20_000 });
  await expect(panel(page).locator('[data-trace-logs-state="unavailable"]')).toContainText('does not exist');

  // Disabled in /api/version: no header item, no panel, no logs request.
  await page.route((url) => url.pathname.endsWith('/api/version'), async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.features.logs = { enabled: false, body_search: 'off' };
    return route.fulfill({ response, body: JSON.stringify(body) });
  });
  const before = requests.length;
  const version = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/api/version'));
  await page.reload();
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(TRACE.spans.length, { timeout: 20_000 });
  // The features are known (the version answer applied): the header and the
  // panel have had their chance to show the logs.
  await version;
  await page.evaluate(() => window.ChDash.features.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#traceDetailStats [data-trace-header-item="Logs"]')).toHaveCount(0);
  await expect(panel(page)).toBeHidden();
  // The version answer may land after the trace: a request then is ignored.
  expect(requests.length - before).toBeLessThanOrEqual(1);
});

test('mocked: logs keep the waterfall usable: collapsing a branch removes its logs rows, keys open details', async ({ page }) => {
  await routeLogs(page, (route) => json(route, logsAnswer([
    logRecord({ span: sid(6), at: 20, body: 'SELECT stock started', service: 'inventory-db' }),
    logRecord({ span: sid(7), at: 25, sev: 'ERROR', body: 'lock timeout', service: 'inventory-db', attrs: { 'exception.type': 'LockTimeout' } }),
  ])));
  await openMocked(page);
  await spanRow(page, sid(7)).locator('.traceSpanLogsBadge').click();
  await expect(inlineRows(page, sid(7))).toHaveCount(1);
  // Keyboard: Enter on a log line opens its details.
  await inlineRows(page, sid(7)).locator('.traceLog__row').focus();
  await page.keyboard.press('Enter');
  await expect(inlineRows(page, sid(7)).locator('.kvList__row[data-kv-key="exception.type"]')).toBeVisible();
  // Collapsing an ancestor removes the span and its logs rows; expanding brings both back.
  await spanRow(page, sid(5)).locator('[data-toggle-span]').click();
  await expect(spanRow(page, sid(7))).toHaveCount(0);
  await expect(inlineRows(page, sid(7))).toHaveCount(0);
  await expect(spanRow(page, sid(8))).toHaveCount(1);
  await spanRow(page, sid(5)).locator('[data-toggle-span]').click();
  await expect(inlineRows(page, sid(7))).toHaveCount(1);
  // A marker click lists the logs too; the span row itself does not toggle.
  await spanRow(page, sid(6)).locator('.traceSpanLogMarker').first().click();
  await expect(inlineRows(page, sid(6))).toHaveCount(1);
  await expect(spanRow(page, sid(6))).toHaveAttribute('aria-expanded', 'false');
  // Inspector and logs rows side by side, in that order.
  await spanRow(page, sid(6)).locator('.traceSpanRow__name').click();
  const order = await page.evaluate((id) => {
    const row = document.querySelector(`#traceWaterfall .traceSpanRow[data-span-id="${id}"]`);
    return [row.nextElementSibling?.className || '', row.nextElementSibling?.nextElementSibling?.className || ''];
  }, sid(6));
  expect(order[0]).toContain('traceSpanInspectorRow');
  expect(order[1]).toContain('traceSpanLogsRow');
});
