import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runSuccessfulQuery, enableExecutionStats, nextFrames } from '../helpers/app.js';

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

test('large streamed results stay virtualized and reach the last row', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'row-\', toString(number)) AS label FROM numbers(20000)');
  const body = page.locator('#resultTableBody');
  await expect(body.locator('tr.resultTable__spacerRow').first()).toBeAttached();
  const mounted = await body.locator('tr:not(.resultTable__spacerRow)').count();
  expect(mounted).toBeGreaterThan(0);
  expect(mounted).toBeLessThan(2000);
  // Each append from the stream grows the bottom spacer.
  // After the last render frame runs, the mounted rows and spacers must cover the full result height.
  await expect.poll(async () => page.evaluate(() => {
    const tbody = document.getElementById('resultTableBody');
    let spacer = 0;
    for (const tr of tbody.querySelectorAll('tr.resultTable__spacerRow')) spacer += tr.getBoundingClientRect().height;
    const rows = tbody.querySelectorAll('tr:not(.resultTable__spacerRow)');
    const rowH = rows.length ? rows[0].getBoundingClientRect().height : 0;
    return rowH > 0 ? (spacer / rowH + rows.length) / 20000 : 0;
  }), { timeout: 10_000 }).toBeGreaterThan(0.95);
  await page.evaluate(() => {
    const tbody = document.getElementById('resultTableBody');
    tbody.lastElementChild.scrollIntoView({ block: 'end' });
  });
  await expect(body).toContainText('row-19999', { timeout: 10_000 });
});

test('tuple columns are flattened into leaf columns', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, `SELECT CAST((number, concat('n', toString(number))), 'Tuple(code UInt64, name String)') AS t,
    [CAST((1, 'a'), 'Tuple(k UInt8, v String)'), CAST((2, 'b'), 'Tuple(k UInt8, v String)')] AS arr
  FROM numbers(3) ORDER BY number`);
  const head = page.locator('#resultTableHead');
  await expect(head).toContainText('t.code');
  await expect(head).toContainText('t.name');
  await expect(head).toContainText('arr.k');
  await expect(head).toContainText('arr.v');
  await expect(page.locator('#resultTableBody')).toContainText('n2');
});

// The test reads the result stream with fetch (ns.api.openEventStream). The function has the surface of an EventSource.
// The test cuts a fake response in the page at awkward places. The check tests the parsing without the server.
test('the event stream reader cuts events like EventSource: split chunks, comments, several data lines, a failing listener', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: result_meta\ndata: {"a":1}\n', '\nevent: result_rows\nda', 'ta: [1,2]\n\n: keep alive\n\n',
      'data: plain\n\nevent: multi\ndata: x\ndata: y\n\n',
      'event: tail\ndata: not ended',
    ];
    const realFetch = window.fetch;
    window.fetch = async () => new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const seen = [];
    const errors = [];
    const stream = window.ChDash.api.openEventStream('api/query/stream?query_id=fake');
    for (const type of ['result_meta', 'result_rows', 'message', 'multi', 'tail']) {
      stream.addEventListener(type, (event) => { seen.push([event.type, event.data]); if (type === 'message') throw new Error('a listener that fails'); });
    }
    stream.addEventListener('error', (event) => { errors.push(event.data === undefined ? 'end' : event.data); });
    const reported = [];
    // The report reaches the page's error handler. The test handles it here, so it is not a failure of the page.
    window.addEventListener('error', (event) => { reported.push(event.message); event.preventDefault(); });
    await new Promise((resolve) => { stream.onerror = resolve; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.fetch = realFetch;
    return { seen, errors, reported, readyState: stream.readyState };
  });
  expect(result.seen).toEqual([
    ['result_meta', '{"a":1}'], ['result_rows', '[1,2]'], ['message', 'plain'], ['multi', 'x\ny'],
  ]);
  // A last event without its blank line does not count as an event. The end of the stream is an "error" without data, like EventSource.
  expect(result.errors).toEqual(['end']);
  // The stream reports a failing listener, as EventSource does. The stream continues.
  expect(result.reported.join(' ')).toContain('a listener that fails');
  expect(result.readyState).toBe(2);
});

test('a stream that the server refuses or that fails reports an error without data, and close() ends it quietly', async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const realFetch = window.fetch;
    const out = {};
    window.fetch = async () => new Response('nope', { status: 404 });
    let stream = window.ChDash.api.openEventStream('api/query/stream?query_id=missing');
    out.refused = await new Promise((resolve) => { stream.onerror = (event) => resolve([event.data === undefined, stream.readyState]); });
    window.fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    stream = window.ChDash.api.openEventStream('api/query/stream?query_id=hang');
    let errored = false;
    stream.onerror = () => { errored = true; };
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    out.closed = [errored, stream.readyState];
    window.fetch = realFetch;
    return out;
  });
  expect(result.refused).toEqual([true, 2]);
  expect(result.closed).toEqual([false, 2]);
});

test('performance budget: the fetch reader takes a 120k-row result in less time than EventSource', async ({ page }) => {
  // The two readers take the same stream, one run each. The test keeps the best of three runs.
  // The load of the machine slows both readers, so the budget is a ratio. The budget is 700 ms against 350 ms on the development machine.
  test.setTimeout(120_000);
  await openApp(page);
  const timings = await page.evaluate(async () => {
    const sql = 'SELECT * FROM chdash_ui.weather_buffer';
    const start = async () => (await window.ChDash.api.runSql('local', sql)).streamUrl;
    const read = (open) => new Promise((resolve, reject) => {
      start().then((url) => {
        const t0 = performance.now();
        let rows = 0;
        const stream = open(url);
        stream.addEventListener('result_rows', (event) => { rows += JSON.parse(event.data).rows.length; });
        stream.addEventListener('done', () => { stream.close(); resolve({ ms: performance.now() - t0, rows }); });
      }, reject);
    });
    const best = { fetch: Infinity, eventSource: Infinity, rows: 0 };
    for (let i = 0; i < 3; i += 1) {
      const a = await read((url) => window.ChDash.api.openEventStream(url));
      const b = await read((url) => new EventSource(url));
      best.fetch = Math.min(best.fetch, a.ms);
      best.eventSource = Math.min(best.eventSource, b.ms);
      best.rows = Math.min(a.rows, b.rows);
    }
    return best;
  });
  expect(timings.rows).toBeGreaterThan(100_000);
  expect(timings.fetch, JSON.stringify(timings)).toBeLessThan(timings.eventSource * 0.85);
});

// The text that shows the Elapsed figure states what it measures (docs/telemetry.md).
test('the Elapsed tile says what it measures, and the run ends before the System figure arrives', async ({ page }) => {
  let executionCalls = 0;
  await page.route('**/api/query/execution**', async (route) => {
    executionCalls += 1;
    // A lookup of the query log can take seconds on a busy server. The lookup flushes the log.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await openApp(page);
  await enableExecutionStats(page);
  await runSuccessfulQuery(page, 'SELECT number AS id, toString(number) AS label FROM numbers(30000)');
  // The run is over: Run is back and the status is final. The System figure is still on its way.
  await expect(page.locator('#runButton')).toHaveText(/^Run$/);
  await expect(page.locator('#clickhouseElapsedWrap')).toBeHidden();
  const tile = page.locator('.metricCompact--elapsed .metricCompact__content');
  const title = await tile.getAttribute('title');
  expect(title).toMatch(/^Elapsed: the time ClickHouse Dash needed from the start of the stream to the last row it sent\./);
  expect(title).toMatch(/ClickHouse and column decoding [\d.]+ (?:\u00b5s|ms|s), JSON encoding [\d.]+ (?:\u00b5s|ms|s)/);
  expect(title).toMatch(/The browser had every row [\d.]+ (?:\u00b5s|ms|s) after the click\./);
  await expect(page.locator('#clickhouseElapsedWrap')).toBeVisible({ timeout: 10_000 });
  expect(await page.locator('#clickhouseElapsedWrap').getAttribute('title')).toMatch(/query_duration_ms of ClickHouse \(system\.query_log\).*waited for ClickHouse Dash to read the blocks/);
  expect(executionCalls).toBe(1);
  // A new run clears the tooltip with the figures.
  await page.locator('#queryTextArea').fill('SELECT 1');
  await page.locator('#runButton').click();
  await expect(page.locator('#runButton')).toHaveText(/Cancel|Run/);
});

test('the System figure of an earlier run never lands on the tile of the next run', async ({ page }) => {
  let calls = 0;
  let lateAnswerSent;
  let lateRequest = null;
  const lateAnswer = new Promise((resolve) => { lateAnswerSent = resolve; });
  await page.route('**/api/query/execution**', async (route) => {
    calls += 1;
    if (calls === 1) {
      lateRequest = route.request();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, duration_ms: 111111 }) });
      lateAnswerSent();
      return;
    }
    await route.continue();
  });
  const finished = new Set();
  page.on('requestfinished', (request) => finished.add(request));
  await openApp(page);
  await enableExecutionStats(page);
  await runSuccessfulQuery(page, 'SELECT 1');
  await runSuccessfulQuery(page, 'SELECT 2');
  await expect(page.locator('#clickhouseElapsedWrap')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => calls).toBe(2);
  // The first answer arrives late. The page drops it. The request has ended, and the page has had two frames to show it.
  await lateAnswer;
  await expect.poll(() => finished.has(lateRequest)).toBe(true);
  await nextFrames(page);
  await expect(page.locator('#clickhouseElapsedText')).not.toHaveText(/1 min 51|111/);
  await expect(page.locator('#clickhouseElapsedText')).toHaveText(/^(?:\d+(?:\.\d+)? (?:\u00b5s|ms|s)|0 ns)$/);
});
