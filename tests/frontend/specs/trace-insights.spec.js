import { test, expect } from '@playwright/test';
import { installObservers, unexpectedFailures } from '../helpers/observability.js';

// Span insights on the trace page (app_trace_insights.js): exceptions with
// parsed stack traces, highlighted attributes in the trace header, spans of
// other traces linking here (/api/traces/linked_from) and the surrounding
// context panel (/api/traces/context). The OTel fixture has no exceptions,
// links, hosts or pods: traces and the two lookups are mocked, except for
// one context check on a real fixture trace.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(unexpectedFailures(obs.failedRequests)).toEqual([]);
});

const TRACE_ID = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
const OTHER_TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const OTHER_SPAN_ID = 'b7ad6b7169203331';
const BASE_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const ID = { R: 'e000000000000001', P: 'e000000000000002', Q: 'e000000000000003', S: 'e000000000000004' };

const exactNs = (offsetMs) => BigInt(BASE_MS) * 1000000n + BigInt(Math.round(offsetMs * 1e6));
function stamp(offsetMs) {
  const totalNs = exactNs(offsetMs);
  const iso = new Date(Number(totalNs / 1000000n)).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}.${String(totalNs % 1000000000n).padStart(9, '0')}`;
}

function span({ id, parent = '', service, name, start, dur, status = 'Unset', attrs = {}, resource = {}, events = [], traceId = TRACE_ID }) {
  return {
    timestamp: stamp(start),
    start_ns: Number(exactNs(start)),
    duration_ns: Math.round(dur * 1e6),
    trace_id: traceId,
    span_id: id,
    parent_span_id: parent,
    span_name: name,
    span_kind: 'Server',
    service_name: service,
    status_code: status,
    status_message: '',
    span_attributes: JSON.stringify(attrs),
    resource_attributes: JSON.stringify({ 'service.name': service, ...resource }),
    events_timestamp: JSON.stringify(events.map((e) => stamp(e.at))),
    events_name: JSON.stringify(events.map((e) => e.name)),
    events_attributes: JSON.stringify(events.map((e) => e.attrs || {})),
    links_trace_id: '[]',
    links_span_id: '[]',
    links_attributes: '[]',
  };
}

const JAVA_STACK = `java.lang.IllegalStateException: order 42 is locked
\tat com.acme.orders.OrderService.lock(OrderService.java:88)
\tat com.acme.orders.OrderService.update(OrderService.java:61)
\tat com.acme.orders.OrderController.put(OrderController.java:40)
\tat jdk.internal.reflect.GeneratedMethodAccessor12.invoke(Unknown Source)
\tat java.base/java.lang.reflect.Method.invoke(Method.java:580)
\tat org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:255)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:885)
\tat java.base/java.lang.Thread.run(Thread.java:1583)
Caused by: java.sql.SQLTimeoutException: lock wait timeout
\tat com.acme.db.Pool.acquire(Pool.java:12)
\tat com.acme.orders.OrderService.lock(OrderService.java:85)
\t... 6 more`;

const PYTHON_STACK = `Traceback (most recent call last):
  File "/app/handlers.py", line 42, in post
    order = load(order_id)
  File "/app/orders.py", line 17, in load
    return db.fetch(order_id)
  File "/usr/lib/python3.12/site-packages/db/client.py", line 88, in fetch
    raise KeyError(key)
KeyError: 'order-42'`;

const GO_STACK = `panic: runtime error: index out of range [5] with length 3

goroutine 1 [running]:
main.pick(...)
\t/app/main.go:21 +0x1d
main.handler(0xc000012345, 0x3)
\t/app/main.go:12 +0x25
net/http.(*conn).serve(0xc0000b4000, {0x8b0f68, 0xc0000a2000})
\t/usr/local/go/src/net/http/server.go:2092 +0x5c5
created by net/http.(*Server).Serve in goroutine 1
\t/usr/local/go/src/net/http/server.go:3290 +0x4b4`;

const JS_STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at chargeCard (/srv/billing/charge.js:14:22)
    at async Promise.all (index 0)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)
    at /srv/billing/index.js:30:7`;

const DOTNET_STACK = `System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at Acme.Billing.Invoices.Latest(IEnumerable\`1 items) in /src/Billing/Invoices.cs:line 27
   at Acme.Billing.Api.Get(Int32 id) in /src/Billing/Api.cs:line 12`;

const RUBY_STACK = `app/models/order.rb:12:in \`lock!': order locked (RuntimeError)
\tfrom app/controllers/orders_controller.rb:8:in \`update'
\tfrom /usr/local/bundle/gems/actionpack-7.1.0/lib/action_controller/metal/basic_implicit_render.rb:6:in \`send_action'`;

const MOCK_SPANS = [
  span({ id: ID.R, service: 'gateway', name: 'GET /orders', start: 0, dur: 100, attrs: { 'http.method': 'GET' },
    resource: { 'service.version': '1.4.2', 'deployment.environment.name': 'prod' } }),
  span({ id: ID.P, parent: ID.R, service: 'orders', name: 'PUT /orders/{id}', start: 10, dur: 60, status: 'Error',
    attrs: { 'http.route': '/orders/{id}', 'user.id': 'u-42' },
    events: [
      { at: 20, name: 'exception', attrs: { 'exception.type': 'java.lang.IllegalStateException', 'exception.message': 'order 42 is locked', 'exception.stacktrace': JAVA_STACK, 'exception.escaped': 'true' } },
      { at: 30, name: 'retry' },
      { at: 40, name: 'exception', attrs: { 'exception.type': 'KeyError', 'exception.message': "'order-42'", 'exception.stacktrace': PYTHON_STACK } },
    ] }),
  span({ id: ID.Q, parent: ID.R, service: 'billing', name: 'charge', start: 72, dur: 20, status: 'Error',
    attrs: { 'exception.type': 'TypeError', 'exception.message': "Cannot read properties of undefined (reading 'id')", 'exception.stacktrace': JS_STACK, 'user.id': 'u-99' },
    resource: { 'host.name': 'billing-7', 'k8s.pod.name': 'billing-7f9c' } }),
  span({ id: ID.S, parent: ID.R, service: 'billing', name: 'refund', start: 93, dur: 5 }),
];

const OTHER_SPANS = [
  span({ id: 'c000000000000001', service: 'scheduler', name: 'retry.schedule', start: 0, dur: 12, traceId: OTHER_TRACE_ID }),
  span({ id: OTHER_SPAN_ID, parent: 'c000000000000001', service: 'checkout', name: 'retry.checkout', start: 2, dur: 8, traceId: OTHER_TRACE_ID }),
];

async function mockTraces(page) {
  await page.route((url) => url.pathname.endsWith('/api/traces/trace'), (route) => {
    const id = new URL(route.request().url()).searchParams.get('trace_id');
    const spans = id === TRACE_ID ? MOCK_SPANS : id === OTHER_TRACE_ID ? OTHER_SPANS : null;
    if (!spans) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ source_host_id: 'local', trace_id: id, range_source: 'trace_index', truncated: false, spans }) });
  });
}

async function openTrace(page, query = '') {
  await mockTraces(page);
  await page.goto(`/observability/traces/${TRACE_ID}${query}`);
  await expect(page.locator('#traceDetail')).toBeVisible();
}

const row = (page, id) => page.locator(`#traceWaterfall .traceSpanRow[data-span-id="${id}"]`);
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

test('stack traces parse into frames for Java, Python, Go, JavaScript, .NET and Ruby', async ({ page }) => {
  await openTrace(page);
  const parsed = await page.evaluate((stacks) => Object.fromEntries(Object.entries(stacks).map(([key, text]) => {
    const out = window.ChDash.traceInsights.parseStackTrace(text);
    return [key, { format: out.format, frames: out.frames, innermostLast: out.innermostLast,
      rows: out.rows.map((r) => (r.kind === 'frame' ? { kind: r.kind, fn: r.fn, file: r.file, line: r.line, col: r.col, library: r.library, code: r.code || '' } : { kind: r.kind, text: r.text })) }];
  })), { java: JAVA_STACK, python: PYTHON_STACK, go: GO_STACK, js: JS_STACK, dotnet: DOTNET_STACK, ruby: RUBY_STACK, text: 'something failed\nno frame here' });

  const frames = (key) => parsed[key].rows.filter((r) => r.kind === 'frame');
  expect(parsed.java.format).toBe('java');
  expect(parsed.java.frames).toBe(10);
  expect(parsed.java.innermostLast).toBe(false);
  expect(frames('java')[0]).toMatchObject({ fn: 'com.acme.orders.OrderService.lock', file: 'OrderService.java', line: '88', library: false });
  expect(frames('java')[3]).toMatchObject({ fn: 'jdk.internal.reflect.GeneratedMethodAccessor12.invoke', file: 'Unknown Source', line: '', library: true });
  expect(frames('java')[4]).toMatchObject({ fn: 'java.base/java.lang.reflect.Method.invoke', library: true });
  expect(parsed.java.rows.filter((r) => r.kind === 'cause').map((r) => r.text)).toEqual(['Caused by: java.sql.SQLTimeoutException: lock wait timeout']);
  expect(parsed.java.rows.filter((r) => r.kind === 'omitted').map((r) => r.text)).toEqual(['... 6 more']);
  expect(parsed.java.rows[0]).toEqual({ kind: 'text', text: 'java.lang.IllegalStateException: order 42 is locked' });

  expect(parsed.python.format).toBe('python');
  expect(parsed.python.innermostLast).toBe(true);
  expect(frames('python')).toEqual([
    { kind: 'frame', fn: 'post', file: '/app/handlers.py', line: '42', col: '', library: false, code: 'order = load(order_id)' },
    { kind: 'frame', fn: 'load', file: '/app/orders.py', line: '17', col: '', library: false, code: 'return db.fetch(order_id)' },
    { kind: 'frame', fn: 'fetch', file: '/usr/lib/python3.12/site-packages/db/client.py', line: '88', col: '', library: true, code: 'raise KeyError(key)' },
  ]);
  expect(parsed.python.rows.at(-1)).toEqual({ kind: 'text', text: "KeyError: 'order-42'" });

  expect(parsed.go.format).toBe('go');
  expect(frames('go').map((f) => [f.fn, f.file, f.line, f.library])).toEqual([
    ['main.pick', '/app/main.go', '21', false],
    ['main.handler', '/app/main.go', '12', false],
    ['net/http.(*conn).serve', '/usr/local/go/src/net/http/server.go', '2092', true],
    ['created by net/http.(*Server).Serve', '/usr/local/go/src/net/http/server.go', '3290', true],
  ]);

  expect(parsed.js.format).toBe('javascript');
  expect(frames('js').map((f) => [f.fn, f.file, f.line, f.col, f.library])).toEqual([
    ['chargeCard', '/srv/billing/charge.js', '14', '22', false],
    ['processTicksAndRejections', 'node:internal/process/task_queues', '95', '5', true],
    ['<anonymous>', '/srv/billing/index.js', '30', '7', false],
  ]);
  expect(parsed.js.rows.find((r) => r.kind === 'text' && r.text.startsWith('at async'))).toBeTruthy();

  expect(parsed.dotnet.format).toBe('dotnet');
  expect(frames('dotnet').map((f) => [f.fn, f.file, f.line, f.library])).toEqual([
    ['System.Linq.ThrowHelper.ThrowNoElementsException()', '', '', true],
    ['Acme.Billing.Invoices.Latest(IEnumerable`1 items)', '/src/Billing/Invoices.cs', '27', false],
    ['Acme.Billing.Api.Get(Int32 id)', '/src/Billing/Api.cs', '12', false],
  ]);

  expect(parsed.ruby.format).toBe('ruby');
  expect(frames('ruby').map((f) => [f.fn, f.file, f.line, f.library])).toEqual([
    ['update', 'app/controllers/orders_controller.rb', '8', false],
    ['send_action', '/usr/local/bundle/gems/actionpack-7.1.0/lib/action_controller/metal/basic_implicit_render.rb', '6', true],
  ]);

  expect(parsed.text).toMatchObject({ format: '', frames: 0 });
});

test('exceptions: section on top of the span inspector, frames, show all, raw, copy, row and header markers', async ({ page }) => {
  await openTrace(page);
  await captureCopies(page);
  // Waterfall: P (two exception events) and Q (exception.* attributes) carry a marker.
  await expect(row(page, ID.P).locator('[data-span-exception]')).toHaveAttribute('title', '2 exceptions: java.lang.IllegalStateException: order 42 is locked; KeyError: \'order-42\'');
  await expect(row(page, ID.Q).locator('[data-span-exception]')).toHaveAttribute('title', /^Exception: TypeError: Cannot read properties/);
  await expect(row(page, ID.R).locator('[data-span-exception]')).toHaveCount(0);
  await expect(row(page, ID.S).locator('[data-span-exception]')).toHaveCount(0);

  // Trace header: 3 exceptions in 2 spans; the button opens the first one.
  const tag = page.locator('#traceDetailStats [data-trace-exceptions]');
  await expect(tag).toContainText('3 exceptions');
  await expect(tag).toHaveAttribute('title', /3 exceptions in 2 spans: java\.lang\.IllegalStateException, KeyError, TypeError/);
  await tag.click();
  const card = inspector(page, ID.P);
  await expect(card).toBeVisible();
  expect(new URL(page.url()).searchParams.get('span')).toBe(ID.P);

  // The section comes first, right after the header.
  const section = card.locator('[data-span-section="exception"]');
  await expect(section.locator('.traceException__head')).toHaveText('Exceptions(2)');
  expect(await card.evaluate((el) => el.querySelector('.traceInspectorHead').nextElementSibling?.getAttribute('data-span-section'))).toBe('exception');
  const items = section.locator('.traceException__item');
  await expect(items).toHaveCount(2);
  const java = items.nth(0);
  await expect(java.locator('.traceException__type')).toHaveText('java.lang.IllegalStateException');
  await expect(java.locator('.traceException__message')).toHaveText('order 42 is locked');
  await expect(java.locator('.traceException__badge')).toHaveText('escaped');
  await expect(java.locator('.traceException__time')).toHaveText('at 20 ms');
  const typeColor = await java.locator('.traceException__type').evaluate((el) => getComputedStyle(el).color);
  const errorColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.querySelector('#traceDetail').appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(typeColor).toBe(errorColor);

  // First 5 of 10 frames, the exception and cause lines always shown.
  await expect(java.locator('.traceStack__meta')).toHaveText('10 frames · Java · most recent call first');
  await expect(java.locator('.traceStack__frame:visible')).toHaveCount(5);
  await expect(java.locator('.traceStack__frame:visible .traceStack__fn').first()).toHaveText('com.acme.orders.OrderService.lock');
  await expect(java.locator('.traceStack__frame:visible .traceStack__loc').first()).toHaveText('OrderService.java:88');
  await expect(java.locator('.traceStack__row--cause')).toHaveText('Caused by: java.sql.SQLTimeoutException: lock wait timeout');
  await expect(java.locator('.traceStack__hidden')).toHaveText('5 more frames hidden');
  await expect(java.locator('.traceStack__frame.is-library:visible')).toHaveCount(2);
  await java.getByRole('button', { name: 'Show all 10 frames' }).click();
  await expect(java.locator('.traceStack__frame:visible')).toHaveCount(10);
  await expect(java.getByRole('button', { name: 'Show fewer frames' })).toBeFocused();
  // Raw text and back.
  await java.getByRole('button', { name: 'Raw' }).click();
  await expect(java.locator('.traceStack__raw')).toHaveText(JAVA_STACK.replace(/\t/g, '\t'));
  await java.getByRole('button', { name: 'Frames' }).click();
  await expect(java.locator('.traceStack__frame:visible')).toHaveCount(10);
  // Copy: the stack already starts with the exception line.
  await java.getByRole('button', { name: 'Copy stack' }).click();
  await expect.poll(() => lastCopy(page)).toBe(JAVA_STACK);

  // Python: the last 5 frames nearest the throw (here all 3), innermost last.
  const python = items.nth(1);
  await expect(python.locator('.traceException__type')).toHaveText('KeyError');
  await expect(python.locator('.traceStack__meta')).toHaveText('3 frames · Python · most recent call last');
  await expect(python.locator('.traceStack__frame:visible .traceStack__fn')).toHaveText(['post', 'load', 'fetch']);
  await expect(python.locator('.traceStack__frame').first().locator('.traceStack__code')).toHaveText('order = load(order_id)');
  await expect(python.getByRole('button', { name: /Show all/ })).toHaveCount(0);

  // The expansion survives a re-render of the waterfall (collapse + expand all).
  await page.locator('#traceWaterfall [data-trace-collapse-all]').click();
  await page.locator('#traceWaterfall [data-trace-expand-all]').click();
  await expect(inspector(page, ID.P).locator('.traceException__item').nth(0).locator('.traceStack__frame:visible')).toHaveCount(10);

  // Span attributes: one exception, labelled as such; copy prefixes the header.
  await openSpan(page, ID.Q);
  const q = inspector(page, ID.Q).locator('[data-span-section="exception"]');
  await expect(q.locator('.traceException__head')).toHaveText('Exception');
  await expect(q.locator('.traceException__badge')).toHaveText('span attributes');
  await expect(q.locator('.traceStack__meta')).toHaveText('3 frames · JavaScript · most recent call first');
  await expect(q.locator('.traceStack__row--text')).toHaveText([JS_STACK.split('\n')[0], 'at async Promise.all (index 0)']);

  // No exception: no section.
  await openSpan(page, ID.S);
  await expect(inspector(page, ID.S).locator('[data-span-section="exception"]')).toHaveCount(0);
});

test('exceptions: an unparseable stack is preformatted text', async ({ page }) => {
  const spans = [span({ id: ID.R, service: 'gateway', name: 'GET /', start: 0, dur: 10, events: [
    { at: 1, name: 'exception', attrs: { 'exception.type': 'Boom', 'exception.stacktrace': 'first line\n  second line' } },
  ] })];
  await page.route((url) => url.pathname.endsWith('/api/traces/trace'), (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ source_host_id: 'local', trace_id: TRACE_ID, range_source: 'trace_index', truncated: false, spans }) }));
  await page.goto(`/observability/traces/${TRACE_ID}?span=${ID.R}`);
  const section = inspector(page, ID.R).locator('[data-span-section="exception"]');
  await expect(section.locator('.traceStack__meta')).toHaveText('Stack trace');
  await expect(section.locator('.traceStack__raw')).toHaveText('first line\n  second line');
  await expect(section.getByRole('button', { name: 'Raw' })).toHaveCount(0);
  await expect(section.locator('.traceException__message')).toHaveCount(0);
});

test('highlighted attributes: chips from the configured keys, root span first, click copies', async ({ page }) => {
  await openTrace(page);
  await captureCopies(page);
  const chips = page.locator('#traceHighlights .traceHighlight');
  // Defaults: service.version, deployment.environment.name, deployment.environment, http.route, user.id.
  await expect(chips.locator('.traceHighlight__key')).toHaveText(['service.version', 'deployment.environment.name', 'http.route', 'user.id']);
  await expect(chips.locator('.traceHighlight__value')).toHaveText(['1.4.2', 'prod', '/orders/{id}', 'u-42']);
  await expect(chips.nth(0)).toHaveAttribute('title', /from the root span/);
  await expect(chips.nth(3)).toHaveAttribute('title', /from the span orders::PUT \/orders\/\{id\}/);
  await chips.nth(2).click();
  await expect.poll(() => lastCopy(page)).toBe('/orders/{id}');
});

test('highlighted attributes follow traces.highlighted_attributes from /api/traces/meta', async ({ page }) => {
  await page.route((url) => url.pathname.endsWith('/api/traces/meta'), async (route) => {
    const response = await route.fetch();
    const meta = await response.json();
    expect(meta.highlighted_attributes).toEqual(['service.version', 'deployment.environment.name', 'deployment.environment', 'http.route', 'user.id']);
    return route.fulfill({ response, json: { ...meta, highlighted_attributes: ['host.name', 'missing.key', 'user.id'] } });
  });
  await openTrace(page);
  const chips = page.locator('#traceHighlights .traceHighlight');
  await expect(chips.locator('.traceHighlight__key')).toHaveText(['host.name', 'user.id']);
  await expect(chips.locator('.traceHighlight__value')).toHaveText(['billing-7', 'u-42']);
  // A trace without any of the keys hides the row.
  await page.goto(`/observability/traces/${OTHER_TRACE_ID}`);
  await expect(page.locator('#traceWaterfall .traceSpanRow')).toHaveCount(2);
  await expect(page.locator('#traceHighlights')).toBeHidden();
});

test('linked from other traces: loaded when References opens, open linked trace focuses the span', async ({ page }) => {
  const requests = [];
  await page.route((url) => url.pathname.endsWith('/api/traces/linked_from'), (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(Object.fromEntries(params.entries()));
    const rows = params.get('span_id') === ID.R ? [{
      timestamp: '2026-09-19 12:05:00.000000000', start_ns: Number(exactNs(300000)), start_ns_text: String(exactNs(300000)), duration_ns: 8000000,
      trace_id: OTHER_TRACE_ID, span_id: OTHER_SPAN_ID, parent_span_id: 'c000000000000001', span_name: 'retry.checkout', span_kind: 'Consumer',
      service_name: 'checkout', status_code: 'Error', link_span_ids: JSON.stringify([ID.R]), link_attributes: JSON.stringify([{ 'link.reason': 'retry' }]),
    }] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      source_host_id: 'local', trace_id: params.get('trace_id'), span_id: params.get('span_id'), range_source: 'request',
      range: [BASE_MS - 3600000, BASE_MS + 3600100], margin_minutes: 60, limit: 100, truncated: false, elapsed_ms: 12, rows,
    }) });
  });
  await openTrace(page);
  await openSpan(page, ID.R);
  const refs = inspector(page, ID.R).locator('[data-span-section="references"]');
  // A root span without links still has the section (the lookup is its only content).
  await expect(refs.locator(':scope > summary')).toHaveText('References');
  expect(requests).toEqual([]);
  await refs.locator(':scope > summary').click();
  const group = refs.locator('.traceLinkedFrom');
  await expect(group.locator('.traceLinkedFrom__head')).toHaveText('Linked from (other traces)(1)');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ trace_id: TRACE_ID, span_id: ID.R, start_ms: String(BASE_MS), end_ms: String(BASE_MS + 100) });
  const item = group.locator('.traceLinkedFrom__item');
  await expect(item.locator('.traceSpanRefs__main')).toContainText('checkoutretry.checkout');
  await expect(item.locator('.traceSpanRefs__ids')).toContainText(`TraceID: ${OTHER_TRACE_ID}`);
  await expect(item.locator('.kvList__row[data-kv-key="link.reason"]')).toContainText('retry');
  // The local references keep their own list and count.
  await expect(refs.locator('.traceSpanRefs__item')).toHaveCount(0);

  // Re-rendering keeps the loaded answer (no second request).
  await page.locator('#traceWaterfall [data-trace-collapse-all]').click();
  await page.locator('#traceWaterfall [data-trace-expand-all]').click();
  await expect(inspector(page, ID.R).locator('.traceLinkedFrom__item')).toHaveCount(1);
  expect(requests).toHaveLength(1);

  // Another span: its own lookup, an empty answer.
  await openSpan(page, ID.S);
  const sRefs = inspector(page, ID.S).locator('[data-span-section="references"]');
  await expect(sRefs.locator(':scope > summary')).toHaveText('References(1)');
  await sRefs.locator(':scope > summary').click();
  await expect(sRefs.locator('[data-linked-from-empty]')).toContainText('No span of another trace links here');
  await expect(sRefs.locator('[data-linked-from-empty]')).toContainText('±1 h around this trace');

  await item.getByRole('link', { name: 'Open linked trace' }).click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${OTHER_TRACE_ID}\\?span=${OTHER_SPAN_ID}$`));
  await expect(row(page, OTHER_SPAN_ID)).toHaveClass(/is-deep-linked/);
  await expect(inspector(page, OTHER_SPAN_ID)).toBeVisible();
});

test('linked from: a failed lookup shows the error and retries', async ({ page }) => {
  let calls = 0;
  await page.route((url) => url.pathname.endsWith('/api/traces/linked_from'), (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error_code: 'trace_linked_from_failed', message: 'Timeout exceeded' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ range: [BASE_MS - 3600000, BASE_MS + 3600100], margin_minutes: 60, truncated: false, rows: [] }) });
  });
  await openTrace(page);
  await openSpan(page, ID.S);
  const refs = inspector(page, ID.S).locator('[data-span-section="references"]');
  await refs.locator(':scope > summary').click();
  await expect(refs.locator('.traceLinkedFrom__note.is-error')).toContainText('Timeout exceeded');
  await refs.getByRole('button', { name: 'Retry' }).click();
  await expect(refs.locator('[data-linked-from-empty]')).toBeVisible();
  expect(calls).toBe(2);
});

// Context answers: rows spaced 100 ms apart around the anchor (P starts at 10 ms).
function contextRows(anchorNs, count, direction, cursorNs) {
  const step = 100000000n;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    let ns;
    if (direction === 'older') ns = BigInt(cursorNs) - step * BigInt(i + 1);
    else if (direction === 'newer') ns = BigInt(cursorNs) + step * BigInt(count - i);
    else ns = anchorNs + step * BigInt(Math.floor(count / 2) - i);
    const same = ns === anchorNs;
    rows.push({
      timestamp: stamp(Number(ns - BigInt(BASE_MS) * 1000000n) / 1e6), start_ns: Number(ns), start_ns_text: String(ns), duration_ns: 1500000,
      trace_id: same ? TRACE_ID : OTHER_TRACE_ID,
      span_id: same ? ID.P : direction === 'newer' && i === 0 ? OTHER_SPAN_ID : `d${String(ns).slice(-15)}`,
      parent_span_id: '',
      span_name: same ? 'PUT /orders/{id}' : `op-${i}`, span_kind: 'Server', service_name: same ? 'orders' : 'checkout', status_code: i === 1 ? 'Error' : 'Unset',
    });
  }
  return rows;
}

async function mockContext(page, requests) {
  await page.route((url) => url.pathname.endsWith('/api/traces/context'), (route) => {
    const params = Object.fromEntries(new URL(route.request().url()).searchParams.entries());
    requests.push(params);
    const anchor = BigInt(params.timestamp_ns);
    const direction = params.direction;
    const rows = contextRows(anchor, direction === 'around' ? 5 : 3, direction, params.cursor_ns);
    const body = { timestamp_ns: params.timestamp_ns, window_ms: Number(params.window_ms), filter: params.filter, direction, limit: 50, elapsed_ms: 7.4, rows };
    if (direction !== 'newer') body.has_older = direction === 'around';
    if (direction !== 'older') body.has_newer = direction === 'around';
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('surrounding context: presets, filters, keyset paging and opening a span', async ({ page }) => {
  const requests = [];
  await mockContext(page, requests);
  await openTrace(page);
  await openSpan(page, ID.P);
  const trigger = inspector(page, ID.P).getByRole('button', { name: 'Context' });
  await trigger.click();
  const panel = page.locator('#traceContextPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.locator('#traceContextTitle')).toHaveText('Surrounding context');
  await expect(panel.locator('[data-context-summary]')).toHaveText('5 spans · ±1 min · Same service · 7.4 ms');
  // Default: same service, ±1 min, exact anchor nanoseconds.
  expect(requests.at(-1)).toMatchObject({ timestamp_ns: String(exactNs(10)), window_ms: '60000', filter: 'service', service: 'orders', direction: 'around', limit: '50' });
  const rows = panel.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.locator('.traceContextRow__offset')).toHaveText(['+200 ms', '+100 ms', '0', '−100 ms', '−200 ms']);
  await expect(rows.nth(2)).toHaveClass(/is-anchor/);
  await expect(rows.nth(1)).toHaveClass(/is-error/);
  await expect(panel.locator('thead th')).toHaveText(['Offset', 'Time', 'Service', 'Operation', 'Duration', 'Status']);

  // Host and pod need the resource attributes: P has none.
  await expect(panel.getByRole('button', { name: 'Same host' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Same pod' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Anything' }).click();
  await expect.poll(() => requests.at(-1)?.filter).toBe('any');
  expect(requests.at(-1).service).toBeUndefined();
  await panel.getByRole('button', { name: '±5 min' }).click();
  await expect.poll(() => requests.at(-1)?.window_ms).toBe('300000');
  await expect(panel.getByRole('button', { name: '±5 min' })).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'Custom attribute' }).click();
  await expect.poll(() => requests.at(-1)?.filter).toBe('attribute');
  expect(requests.at(-1)).toMatchObject({ attr_scope: 'span', attr_key: 'http.route', attr_value: '/orders/{id}' });
  await panel.locator('[data-context-attribute]').selectOption({ label: 'resource · service.name = orders' });
  await expect.poll(() => requests.at(-1)?.attr_scope).toBe('resource');
  expect(requests.at(-1)).toMatchObject({ attr_key: 'service.name', attr_value: 'orders' });

  // Keyset: older from the last row, newer from the first row.
  await panel.getByRole('button', { name: 'Load older' }).click();
  await expect(rows).toHaveCount(8);
  const older = requests.at(-1);
  expect(older).toMatchObject({ direction: 'older', cursor_ns: String(exactNs(10) - 200000000n) });
  await expect(panel.getByRole('button', { name: 'Load older' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Load newer' }).click();
  await expect(rows).toHaveCount(11);
  expect(requests.at(-1)).toMatchObject({ direction: 'newer', cursor_ns: String(exactNs(10) + 200000000n) });
  await expect(rows.locator('.traceContextRow__offset').first()).toHaveText('+500 ms');
  await expect(panel.getByRole('button', { name: 'Load newer' })).toHaveCount(0);

  // A row of another trace opens it on that span; the panel stays open.
  const target = rows.nth(0);
  const spanId = await target.getAttribute('data-context-span');
  await target.click();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${OTHER_TRACE_ID}\\?span=${spanId}$`));
  await expect(panel).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}`));
  // Escape closes it and gives the focus back.
  await panel.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('surrounding context: same host / same pod send the span resource values', async ({ page }) => {
  const requests = [];
  await mockContext(page, requests);
  await openTrace(page);
  await openSpan(page, ID.Q);
  await inspector(page, ID.Q).getByRole('button', { name: 'Context' }).click();
  const panel = page.locator('#traceContextPanel');
  await expect(panel.locator('tbody tr')).toHaveCount(5);
  await panel.getByRole('button', { name: 'Same host' }).click();
  await expect.poll(() => requests.at(-1)?.filter).toBe('host');
  expect(requests.at(-1).value).toBe('billing-7');
  await panel.getByRole('button', { name: 'Same pod' }).click();
  await expect.poll(() => requests.at(-1)?.filter).toBe('pod');
  expect(requests.at(-1).value).toBe('billing-7f9c');
  // The anchor row of this trace focuses it without a reload.
  await panel.getByRole('button', { name: 'Same service' }).click();
  await expect.poll(() => requests.at(-1)?.filter).toBe('service');
  await panel.getByRole('button', { name: 'Close surrounding context' }).click();
  await expect(panel).toBeHidden();
  await expect(inspector(page, ID.Q).getByRole('button', { name: 'Context' })).toBeFocused();
});

test('surrounding context on a real fixture trace lists the spans around it', async ({ page, request }) => {
  // Traces of the rich day (2026-09-12 09:00-12:00, tests/README.md), on
  // every stack.
  const end = Date.UTC(2026, 8, 12, 12, 0, 0);
  const search = await request.get(`/api/traces/search?host_id=local&start_ms=${end - 3 * 3600000}&end_ms=${end}&limit=5`);
  const rows = search.ok() ? (await search.json()).rows || [] : [];
  test.skip(!rows.length, 'the rich OTel dataset (2026-09-12) is not loaded');
  const traceId = rows[0][0];
  await page.goto(`/observability/traces/${traceId}`);
  const first = page.locator('#traceWaterfall .traceSpanRow[data-span-id]').first();
  await expect(first).toBeVisible();
  const spanId = await first.getAttribute('data-span-id');
  await first.locator('.traceSpanRow__name').click();
  await inspector(page, spanId).getByRole('button', { name: 'Context' }).click();
  const panel = page.locator('#traceContextPanel');
  await expect(panel.locator('tr.is-anchor')).toHaveCount(1, { timeout: 15000 });
  await expect(panel.locator('tr.is-anchor')).toHaveAttribute('data-context-span', spanId);
  const services = await panel.locator('tbody .traceContextRow__service').allTextContents();
  expect(new Set(services).size).toBe(1);
  await panel.getByRole('button', { name: 'Anything' }).click();
  await expect(panel.locator('[data-context-summary]')).toContainText('Anything', { timeout: 15000 });
  await expect(panel.locator('tr.is-anchor')).toHaveCount(1);
});

test('span insights: screenshots in both themes, no page overflow', async ({ page }) => {
  await page.route((url) => url.pathname.endsWith('/api/traces/linked_from'), (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: [BASE_MS - 3600000, BASE_MS + 3600100], margin_minutes: 60, truncated: false, rows: [] }) }));
  const requests = [];
  await mockContext(page, requests);
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 1080 });
      await mockTraces(page);
      await page.goto('/observability/traces');
      await page.evaluate((m) => localStorage.setItem('chdash.theme', m), theme);
      await page.goto(`/observability/traces/${TRACE_ID}?span=${ID.P}`);
      const card = inspector(page, ID.P);
      await expect(card.locator('[data-span-section="exception"]')).toBeVisible();
      await card.locator('[data-span-section="references"] > summary').click();
      await expect(card.locator('[data-linked-from-empty]')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      const dir = `${process.env.FRONTEND_ARTIFACTS_DIR || '/tmp'}/trace-insights`;
      await page.screenshot({ path: `${dir}/exception-${theme}-${width}.png` });
      await card.getByRole('button', { name: 'Context' }).click();
      await expect(page.locator('#traceContextPanel tbody tr')).toHaveCount(5);
      await page.screenshot({ path: `${dir}/context-${theme}-${width}.png` });
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => localStorage.removeItem('chdash.theme'));
});
