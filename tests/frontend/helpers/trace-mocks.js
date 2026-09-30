// Synthetic /api/traces/trace answers for the trace detail page. The OTel
// fixture traces are flat (every span a child of the root), so the tree,
// error, critical path and scale checks run on these mocked traces instead.
//
// Each answer is built as JSON text with exact start_ns digits (past 2^53),
// like the real endpoint.

export const MOCK_TRACE_START_NS = 1789867372000000000n;

function spanJson(trace, span) {
  const start = MOCK_TRACE_START_NS + BigInt(Math.round(span.start_ms * 1000)) * 1000n;
  const duration = BigInt(Math.round(span.duration_ms * 1000)) * 1000n;
  const seconds = start / 1_000_000_000n;
  const frac = String(start % 1_000_000_000n).padStart(9, '0');
  const iso = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const fields = {
    timestamp: `${iso}.${frac}`,
    start_ns: '__START__',
    duration_ns: Number(duration),
    trace_id: trace.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id || '',
    span_name: span.name,
    span_kind: span.kind || 'Internal',
    service_name: span.service,
    status_code: span.error ? 'Error' : (span.status || 'Unset'),
    status_message: span.error ? 'boom' : '',
    span_attributes: JSON.stringify(span.attributes || {}),
    resource_attributes: JSON.stringify({ 'service.name': span.service }),
    events_timestamp: '[]',
    events_name: '[]',
    events_attributes: '[]',
    links_trace_id: '[]',
    links_span_id: '[]',
    links_attributes: '[]',
  };
  return JSON.stringify(fields).replace('"__START__"', String(start));
}

export function traceBody(trace) {
  const spans = trace.spans.map((span) => spanJson(trace, span)).join(',');
  return `{"source_host_id":"local","trace_id":"${trace.trace_id}","range_source":"trace_index","truncated":false,"spans":[${spans}]}`;
}

const hex = (value, size) => value.toString(16).padStart(size, '0');

// A 5-level checkout trace:
//
// frontend GET /checkout                              0 .. 100 ms (http 200)
// ├─ frontend render                                  2 .. 12
// ├─ checkout POST /api/checkout (client)            10 .. 90   (http 502)
// │  └─ checkout handle checkout (server)            12 .. 88
// │     ├─ inventory reserve items (rpc grpc)        14 .. 40
// │     │  └─ inventory-db SELECT stock (db pg)      16 .. 38
// │     │     └─ inventory-db lock rows              18 .. 30   ERROR
// │     └─ payments charge card (rpc grpc)           42 .. 86
// │        ├─ payments-db INSERT charge (mysql)      44 .. 50
// │        └─ fraud score (http POST 503)            52 .. 84   ERROR
// ├─ queue publish order (producer, kafka)           91 .. 93
// │  └─ worker consume order (consumer)              94 .. 99
// └─ (orphan) mailer send mail                       60 .. 70   parent not in trace
export function nestedTrace(traceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90') {
  const id = (n) => hex(n, 16);
  const spans = [
    { span_id: id(1), name: 'GET /checkout', service: 'frontend', kind: 'Server', start_ms: 0, duration_ms: 100, attributes: { 'http.method': 'GET', 'http.status_code': 200 } },
    { span_id: id(2), parent_span_id: id(1), name: 'render', service: 'frontend', start_ms: 2, duration_ms: 10 },
    { span_id: id(3), parent_span_id: id(1), name: 'POST /api/checkout', service: 'checkout', kind: 'Client', start_ms: 10, duration_ms: 80, attributes: { 'http.request.method': 'POST', 'http.response.status_code': 502 } },
    { span_id: id(4), parent_span_id: id(3), name: 'handle checkout', service: 'checkout', kind: 'Server', start_ms: 12, duration_ms: 76 },
    { span_id: id(5), parent_span_id: id(4), name: 'reserve items', service: 'inventory', kind: 'Client', start_ms: 14, duration_ms: 26, attributes: { 'rpc.system': 'grpc' } },
    { span_id: id(6), parent_span_id: id(5), name: 'SELECT stock', service: 'inventory-db', kind: 'Client', start_ms: 16, duration_ms: 22, attributes: { 'db.system': 'postgresql' } },
    { span_id: id(7), parent_span_id: id(6), name: 'lock rows', service: 'inventory-db', start_ms: 18, duration_ms: 12, error: true },
    { span_id: id(8), parent_span_id: id(4), name: 'charge card', service: 'payments', kind: 'Client', start_ms: 42, duration_ms: 44, attributes: { 'rpc.system.name': 'grpc' } },
    { span_id: id(9), parent_span_id: id(8), name: 'INSERT charge', service: 'payments-db', kind: 'Client', start_ms: 44, duration_ms: 6, attributes: { 'db.system.name': 'mysql' } },
    { span_id: id(10), parent_span_id: id(8), name: 'score', service: 'fraud', kind: 'Client', start_ms: 52, duration_ms: 32, error: true, attributes: { 'http.method': 'POST', 'http.status_code': '503' } },
    { span_id: id(11), parent_span_id: id(1), name: 'publish order', service: 'queue', kind: 'Producer', start_ms: 91, duration_ms: 2, attributes: { 'messaging.system': 'kafka' } },
    { span_id: id(12), parent_span_id: id(11), name: 'consume order', service: 'worker', kind: 'Consumer', start_ms: 94, duration_ms: 5 },
    { span_id: id(13), parent_span_id: id(99), name: 'send mail', service: 'mailer', start_ms: 60, duration_ms: 10 },
  ];
  return { trace_id: traceId, spans };
}

// A large trace: `count` spans, up to `depth` levels, deterministic.
export function largeTrace(count = 2000, traceId = 'f00dfeedf00dfeedf00dfeedf00dfeed', depth = 6) {
  const services = ['gateway', 'orders', 'billing', 'stock', 'search', 'users', 'mailer', 'ledger'];
  const spans = [{ span_id: hex(1, 16), name: 'GET /bulk', service: 'gateway', kind: 'Server', start_ms: 0, duration_ms: 4000, level: 0 }];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 2; i <= count; i += 1) {
    // Pick a parent among recent spans that still has room below it.
    let parent = spans[Math.floor(rand() * spans.length)];
    if (parent.level >= depth - 1) parent = spans[0];
    const start = parent.start_ms + rand() * parent.duration_ms * 0.8;
    const duration = Math.max(0.01, (parent.start_ms + parent.duration_ms - start) * rand() * 0.9);
    spans.push({
      span_id: hex(i, 16),
      parent_span_id: parent.span_id,
      name: `op-${i % 37}`,
      service: services[i % services.length],
      start_ms: start,
      duration_ms: duration,
      level: parent.level + 1,
      error: i % 97 === 0,
      attributes: i % 5 === 0 ? { 'db.system': 'postgresql' } : {},
    });
  }
  return { trace_id: traceId, spans };
}

// Serves a search answer listing `traces` (one row each) for /api/traces/search.
export async function routeSearch(page, traces) {
  const services = [...new Set(traces.flatMap((trace) => trace.spans.map((span) => span.service)))].sort();
  const rows = traces.map((trace) => {
    const root = trace.spans[0];
    const stats = services
      .map((service, index) => [index, trace.spans.filter((span) => span.service === service)])
      .filter(([, spans]) => spans.length)
      .map(([index, spans]) => [index, spans.length, spans.filter((span) => span.error).length, Math.round(Math.min(...spans.map((span) => span.start_ms)) * 1e6)]);
    const end = Math.max(...trace.spans.map((span) => span.start_ms + span.duration_ms));
    return [trace.trace_id, Number(MOCK_TRACE_START_NS / 1_000_000n), root.name, services.indexOf(root.service), Math.round(end * 1e6), trace.spans.length, trace.spans.filter((span) => span.error).length, stats];
  });
  await page.route((url) => url.pathname.endsWith('/api/traces/search'), (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ v: 3, source_host_id: 'local', search_path: 'trace_index', services, columns: ['trace_id', 'start_ms', 'root_operation', 'root_service', 'duration_ns', 'span_count', 'error_count', 'service_stats'], rows }),
  }));
}

// Serves `trace` for /api/traces/trace?trace_id=<its id>.
export async function routeTrace(page, trace) {
  await page.route((url) => url.pathname.endsWith('/api/traces/trace') && url.searchParams.get('trace_id') === trace.trace_id, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: traceBody(trace),
  }));
}
