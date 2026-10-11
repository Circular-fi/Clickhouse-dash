import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { readZip } from '../helpers/zip.js';

// The streamed export (docs/massive-export.md) from a browser. The pages of ChDash do not use it, but a browser is the
// client that matters for its guards: it sends the Origin of the page, it cannot send a JSON body from a form, and it
// puts every address in a history and a log. The backend tests (backend-functional/test_export_protocol.py) cover the
// answers with a script; these tests run the handshake and the download with the page's own fetch, read the archive,
// and look at what a page of another site can and cannot do.

// The server runs a bounded number of streams at once (export.max_concurrent): one test at a time.
test.describe.configure({ mode: 'default' });

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const FIRST = 'SELECT number AS n, toString(number) AS s FROM numbers(3)';
const SECOND = "SELECT 'a,b' AS answer, 42 AS n";

// The handshake, then the download of its token, with the fetch of the page. Answers what the test inspects.
async function exportFrom(page, { format, queries, reuse = false }) {
  return page.evaluate(async ({ format, queries, reuse }) => {
    const json = { 'Content-Type': 'application/json' };
    const handshake = await fetch('api/export/run', { method: 'POST', headers: json, body: JSON.stringify({ host_id: 'local', format, queries }) });
    const grant = await handshake.json();
    const stream = (token) => fetch(grant.stream_url, { method: 'POST', headers: json, body: JSON.stringify({ token }) });
    const response = await stream(grant.token);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const again = reuse ? await stream(grant.token) : null;
    return {
      handshake: { status: handshake.status, grant },
      stream: { status: response.status, type: response.headers.get('content-type'), disposition: response.headers.get('content-disposition'), cache: response.headers.get('cache-control'), body: btoa(binary) },
      again: again && { status: again.status, body: await again.json() },
    };
  }, { format, queries, reuse });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('a multi-query CSV export: the handshake gives a token, the download is an archive of each statement, its SQL, its rows and its execution', async ({ page }) => {
  const addresses = [];
  page.on('request', (request) => addresses.push(request.url()));
  const out = await exportFrom(page, { format: 'csv', queries: [FIRST, SECOND] });
  expect(out.handshake.status).toBe(200);
  expect(out.handshake.grant).toMatchObject({ format: 'csv', stream_url: 'api/export/stream' });
  expect(out.handshake.grant.token.split('.')).toHaveLength(3);
  expect(out.stream.status).toBe(200);
  expect(out.stream.type).toBe('application/zip');
  expect(out.stream.disposition).toBe('attachment; filename="queries.zip"');
  expect(out.stream.cache).toContain('no-store');

  const entries = readZip(Buffer.from(out.stream.body, 'base64'));
  expect(entries.map((entry) => entry.name)).toEqual([
    'query-001/query.sql', 'query-001/results.csv', 'query-001/execution.csv',
    'query-002/query.sql', 'query-002/results.csv', 'query-002/execution.csv',
  ]);
  const text = Object.fromEntries(entries.map((entry) => [entry.name, entry.text()]));
  expect(text['query-001/query.sql']).toBe(FIRST);
  expect(text['query-001/results.csv']).toBe('n,s\n0,0\n1,1\n2,2\n');
  // A comma in a value is quoted, the header comes first.
  expect(text['query-002/results.csv']).toBe('answer,n\n"a,b",42\n');
  expect(text['query-002/query.sql']).toBe(SECOND);
  // The execution of each statement is the one ClickHouse logged: its status and the rows it returned.
  for (const [name, rows] of [['query-001/execution.csv', '3'], ['query-002/execution.csv', '1']]) {
    const [header, row] = text[name].trim().split('\n');
    const columns = header.split(',');
    expect(columns.slice(0, 5)).toEqual(['query_id', 'native_query_id', 'status', 'event_time', 'duration_ms']);
    const values = row.split(',');
    expect(values[columns.indexOf('status')]).toBe('finished');
    expect(values[columns.indexOf('result_rows')]).toBe(rows);
  }

  // The capability never travels in an address: not in the handshake, not in the download.
  const exportCalls = addresses.filter((url) => url.includes('/api/export/'));
  expect(exportCalls.map((url) => new URL(url).pathname)).toEqual(['/api/export/run', '/api/export/stream']);
  for (const url of exportCalls) expect(new URL(url).search).toBe('');
  expect(addresses.filter((url) => url.includes(out.handshake.grant.token))).toEqual([]);
});

test('a one-statement JSON export has flat entries and a results.json of one object a line', async ({ page }) => {
  const out = await exportFrom(page, { format: 'json', queries: [FIRST] });
  expect(out.stream.status).toBe(200);
  const entries = readZip(Buffer.from(out.stream.body, 'base64'));
  expect(entries.map((entry) => entry.name)).toEqual(['query.sql', 'results.json', 'execution.csv']);
  const rows = entries[1].text().trim().split('\n').map((line) => JSON.parse(line));
  expect(rows).toEqual([{ n: '0', s: '0' }, { n: '1', s: '1' }, { n: '2', s: '2' }]);
});

test('a token is good once: the second download answers 404 export_not_found', async ({ page }) => {
  const out = await exportFrom(page, { format: 'csv', queries: ['SELECT 1 AS one'], reuse: true });
  expect(out.stream.status).toBe(200);
  expect(out.again.status).toBe(404);
  expect(out.again.body.error_code).toBe('export_not_found');
});

test('a GET starts nothing, with or without the token in the address: 405 with Allow POST', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const grant = await (await fetch('api/export/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host_id: 'local', format: 'csv', queries: ['SELECT 1'] }) })).json();
    const plain = await fetch('api/export/stream');
    const withToken = await fetch(`api/export/stream?token=${encodeURIComponent(grant.token)}`);
    const used = await fetch(grant.stream_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: grant.token }) });
    return { plain: [plain.status, plain.headers.get('allow')], withToken: [withToken.status, withToken.headers.get('allow')], used: used.status };
  });
  expect(out.plain).toEqual([405, 'POST']);
  expect(out.withToken).toEqual([405, 'POST']);
  // The GET did not use up the token: the POST still downloads.
  expect(out.used).toBe(200);
});

test('a statement the policy refuses stops the handshake before any download: KILL QUERY is 403 sql_forbidden', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const response = await fetch('api/export/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host_id: 'local', format: 'csv', queries: ['SELECT 1', "KILL QUERY WHERE query_id = 'x'"] }) });
    return { status: response.status, body: await response.json() };
  });
  expect(out.status).toBe(403);
  expect(out.body.error_code).toBe('sql_forbidden');
});

test('a page of another site cannot start an export: its form post is refused, and so is its fetch', async ({ page, baseURL }) => {
  // "Another site": an address the test serves, in the same browser, so the requests carry its Origin.
  const other = 'http://other-site.test';
  await page.route(`${other}/**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>other</title>
    <form id="f" method="post" enctype="text/plain" action="${baseURL}/api/export/run">
      <input name='{"host_id":"local","format":"csv","queries":["SELECT 1"],"x":"' value='"}'>
    </form>` }));
  await page.goto(`${other}/`);
  const refused = page.waitForResponse((response) => response.url().endsWith('/api/export/run') && response.request().method() === 'POST');
  await page.evaluate(() => document.getElementById('f').submit());
  const form = await refused;
  // A form cannot send application/json: 415. If it could, the Origin is not ours: 403.
  expect([403, 415]).toContain(form.status());
  expect((await form.json()).error_code).toMatch(/^(unsupported_media_type|cross_site_request)$/);

  await page.goto(`${other}/`);
  const viaFetch = await page.evaluate(async (url) => {
    try {
      const response = await fetch(`${url}/api/export/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host_id: 'local', format: 'csv', queries: ['SELECT 1'] }) });
      return { status: response.status };
    } catch (error) {
      // The browser may refuse the answer to a request of another origin (CORS): the request was still made, and
      // the server decided on its Origin. What matters is that no grant came back.
      return { status: 0 };
    }
  }, baseURL);
  expect(viaFetch.status).not.toBe(200);
});
