// Synthetic Traces search / analytics answers for cases the OTel fixture
// lacks (error spans, missing parents, many services, close percentiles).

const MS = 1e6;

// Spans are in ms of the trace; start offsets are minutes before the range end.
export const SYNTHETIC_TRACES = [
  {
    trace_id: '0af7651916cd43dd8448eb211c80319c', minutesAgo: 5, service: 'frontend', operation: 'GET /checkout',
    duration_ms: 420, spans: 12, errors: 3, missing: 0,
    services: [['frontend', 4, 1, 0], ['checkout', 8, 2, 3]],
  },
  {
    trace_id: '5b8efff798038103d269b633813fc60c', minutesAgo: 10, service: 'gateway', operation: 'POST /orders',
    duration_ms: 380, spans: 40, errors: 0, missing: 2,
    services: [['gateway', 10, 0, 0], ['orders', 20, 0, 1], ['billing', 10, 0, 2]],
  },
  {
    trace_id: 'c1d2e3f4a5b60718293a4b5c6d7e8f90', minutesAgo: 15, service: 'mesh', operation: 'fanout',
    duration_ms: 350, spans: 20, errors: 0, missing: 0,
    // 20 services: the one-line pills overflow into "+N". The first span
    // order (offsets) differs from name order.
    services: Array.from({ length: 20 }, (_, i) => [`mesh-service-${String(19 - i).padStart(2, '0')}`, 1, 0, i]),
  },
  {
    trace_id: 'ffeeddccbbaa99887766554433221100', minutesAgo: 20, service: 'batch', operation: 'nightly.rollup',
    duration_ms: 610, spans: 90, errors: 1, missing: 0,
    services: [['batch', 60, 1, 0], ['warehouse', 30, 0, 5]],
  },
  {
    trace_id: '00112233445566778899aabbccddeeff', minutesAgo: 25, service: 'cron', operation: 'tick',
    duration_ms: 330, spans: 1, errors: 0, missing: 0,
    services: [['cron', 1, 0, 0]],
  },
  {
    trace_id: '1234567890abcdef1234567890abcdef', minutesAgo: 30, service: 'api', operation: 'GET /users',
    duration_ms: 450, spans: 20, errors: 0, missing: 0,
    services: [['api', 12, 0, 0], ['users', 8, 0, 2]],
  },
];

export function syntheticSearch(endMs, traces = SYNTHETIC_TRACES) {
  const services = [];
  const index = (name) => { let i = services.indexOf(name); if (i < 0) { i = services.length; services.push(name); } return i; };
  const rows = traces.map((t) => [
    t.trace_id,
    Math.round(endMs - t.minutesAgo * 60_000),
    t.operation,
    index(t.service),
    t.duration_ms * MS,
    t.spans,
    t.errors,
    t.services.map(([name, spans, errors, firstMs]) => [index(name), spans, errors, firstMs * MS]),
    t.missing,
  ]);
  return {
    v: 3, source_host_id: 'local', search_path: 'trace_index', timing_ms: { candidates: 1, summary: 1, total: 2 },
    services,
    columns: ['trace_id', 'start_ms', 'root_operation', 'root_service', 'duration_ns', 'span_count', 'error_count', 'service_stats', 'missing_parents'],
    rows,
  };
}

// Close percentiles (400 / 420 / 430 / 440 ms) in 5-minute buckets.
export function syntheticAnalytics(startMs, endMs) {
  const bucket = 300_000;
  const first = Math.floor(startMs / bucket) * bucket;
  const counts = [];
  const quantiles = [];
  for (let t = first; t < endMs; t += bucket) {
    counts.push([t, 10]);
    quantiles.push([t, 400 * MS, 420 * MS, 430 * MS, 440 * MS]);
  }
  return {
    range: [startMs, endMs], bucket_ms: bucket, quantile_bucket_ms: bucket, charts: ['counts', 'durations'],
    trace_count_chart: counts, trace_count_source: 'span_bounds', duration_quantiles: quantiles,
  };
}

// A trace detail answer: one span per service, children of the root span.
export function syntheticTrace(trace, endMs = Date.now()) {
  const startNs = Math.round(endMs - trace.minutesAgo * 60_000) * MS;
  const spans = trace.services.map(([name, , errors, firstMs], i) => {
    const start = startNs + firstMs * MS;
    return {
      timestamp: new Date(start / MS).toISOString().replace('T', ' ').replace('Z', ''),
      start_ns: String(start),
      duration_ns: String(i ? Math.max(MS, (trace.duration_ms - firstMs) * MS / 2) : trace.duration_ms * MS),
      trace_id: trace.trace_id,
      span_id: `${String(i + 1).padStart(16, '0')}`,
      parent_span_id: i ? '0000000000000001' : '',
      span_name: i ? `${name}.work` : trace.operation,
      span_kind: 'Server',
      service_name: i ? name : trace.service,
      status_code: errors ? 'Error' : 'Ok',
      status_message: '',
      span_attributes: {},
      resource_attributes: {},
      events_timestamp: [], events_name: [], events_attributes: [],
      links_trace_id: [], links_span_id: [],
    };
  });
  return { source_host_id: 'local', trace_id: trace.trace_id, range_source: 'synthetic', truncated: false, spans };
}

// Answers every search / analytics / trace request of the page with the
// synthetic payloads for the requested window; returns the searches seen.
export async function mockTraceResults(page, { traces = SYNTHETIC_TRACES } = {}) {
  const searches = [];
  await page.route('**/api/traces/trace?**', (route) => {
    const id = new URL(route.request().url()).searchParams.get('trace_id');
    const trace = traces.find((item) => item.trace_id === id);
    return trace ? route.fulfill({ json: syntheticTrace(trace) }) : route.continue();
  });
  await page.route('**/api/traces/search?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    searches.push(Object.fromEntries(params));
    return route.fulfill({ json: syntheticSearch(Number(params.get('end_ms')), traces) });
  });
  await page.route('**/api/traces/analytics?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: syntheticAnalytics(Number(params.get('start_ms')), Number(params.get('end_ms'))) });
  });
  return searches;
}
