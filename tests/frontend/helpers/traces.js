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

// Attribute facets: 25 keys (span + resource), sampled (estimated) counts.
export const FACET_KEYS = [
  ['span', 'http.method', 1200],
  ['resource', 'deployment.environment', 1100],
  ...Array.from({ length: 23 }, (_, i) => ['span', `app.key${String(i).padStart(2, '0')}`, 900 - i]),
];

// Serves /api/traces/facets and /api/traces/facet_values (25 keys, values
// for http.method and deployment.environment); returns the requests seen.
export async function mockTraceFacets(page) {
  const seen = { keys: [], values: [] };
  await page.route('**/api/traces/facets?**', (route) => {
    seen.keys.push(new URL(route.request().url()).searchParams);
    return route.fulfill({ json: { v: 1, supported: true, scopes: ['span', 'resource'], estimated: true, timed_out: false, sampled_spans: 3000000, truncated: false, keys: FACET_KEYS } });
  });
  await page.route('**/api/traces/facet_values?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.values.push(params);
    const limit = Number(params.get('limit'));
    const values = params.get('key') === 'http.method'
      ? [['GET', 700], ['POST', 300], ['PUT', 120], ['DELETE', 50], ['PATCH', 20], ['HEAD', 9], ['OPTIONS', 8], ['TRACE', 4], ['CONNECT', 2], ['LINK', 1], ['UNLINK', 1]].slice(0, limit)
      : [['prod', 800], ['staging', 300]];
    return route.fulfill({ json: { v: 1, scope: params.get('scope'), key: params.get('key'), limit, estimated: false, spans_with_key: 1300, distinct_values: params.get('key') === 'http.method' ? 11 : 2, has_more: params.get('key') === 'http.method' && limit < 11, values } });
  });
  return seen;
}

// Services view (/api/traces/services and /services/db): four services with
// per-minute series; the drill-down adds endpoints, slowest spans (synthetic
// traces, so opening one loads its mocked detail) and two releases. The OTel
// fixture has no service.version nor db.* attributes, hence the mocks.
export const SYNTHETIC_SERVICES = [
  // name, spans, errors, p50 ms, p95 ms, p99 ms, total time weight
  ['checkout', 36000, 720, 40, 180, 420, 9],
  ['frontend', 72000, 72, 12, 60, 95, 6],
  ['orders', 18000, 0, 25, 70, 140, 3],
  ['auth', 9000, 450, 5, 30, 800, 1],
];

export function syntheticServices(params, { estimated = false, releases = true } = {}) {
  const start = Number(params.get('start_ms'));
  const end = Number(params.get('end_ms'));
  const bucket = 60_000;
  const detail = params.get('detail') || '';
  const services = params.getAll('service');
  const pick = SYNTHETIC_SERVICES.filter(([name]) => (!detail || name === detail) && (!services.length || services.includes(name)));
  const seconds = (end - start) / 1000;
  const rows = pick.map(([name, spans, errors, p50, p95, p99, weight]) => [name, spans, errors, p50 * MS, p95 * MS, p99 * MS, weight * seconds * 1e9]);
  const series = {};
  for (const [name, spans, errors, p50, p95, p99] of pick) {
    const points = [];
    const count = Math.max(1, Math.round((end - start) / bucket));
    for (let t = Math.floor(start / bucket) * bucket, i = 0; t < end; t += bucket, i += 1) {
      const wave = 1 + 0.3 * Math.sin(i / 4);
      points.push([t, Math.round((spans / count) * wave), i % 7 === 0 ? Math.round((errors / count) * 7) : 0, p50 * MS, Math.round(p95 * MS * wave), Math.round(p99 * MS * wave)]);
    }
    series[name] = points;
  }
  const payload = {
    v: 1, source_host_id: 'local', scope: params.get('scope') || 'entry', detail,
    range: [start, end], window: [start, end], bucket_ms: bucket, bucket_origin_ms: 0,
    estimated, sample_fraction: estimated ? 0.1 : 1, estimated_rows: estimated ? 900000000 : 1000000, exact_rows_limit: 150000000,
    partial: false, timing_ms: { estimate: 1, services: 12, slowest: 0, releases: 0, total: 14 },
    columns: ['service', 'spans', 'errors', 'p50_ns', 'p95_ns', 'p99_ns', 'total_ns'], services: rows,
    series_columns: ['bucket_ms', 'spans', 'errors', 'p50_ns', 'p95_ns', 'p99_ns'], series,
  };
  if (detail) {
    const [, spans, errors, p50, p95, p99] = pick[0] || [detail, 0, 0, 0, 0, 0];
    payload.endpoints_truncated = false;
    payload.endpoints = [
      ['POST /checkout', Math.round(spans * 0.6), Math.round(errors * 0.8), p50 * MS, p95 * MS, p99 * MS, 6 * seconds * 1e9],
      ['GET /cart', Math.round(spans * 0.4), Math.round(errors * 0.2), p50 * MS / 2, p95 * MS / 2, p99 * MS / 2, 2 * seconds * 1e9],
    ];
    payload.slowest_columns = ['trace_id', 'span_id', 'operation', 'start_ms', 'duration_ns', 'status'];
    payload.slowest = [
      [SYNTHETIC_TRACES[0].trace_id, '0000000000000001', 'POST /checkout', end - 5 * 60_000, 2400 * MS, 'Error'],
      [SYNTHETIC_TRACES[1].trace_id, '0000000000000001', 'GET /cart', end - 10 * 60_000, 1900 * MS, 'Ok'],
    ];
    payload.releases_supported = true;
    payload.releases_estimated = false;
    payload.releases = releases ? [['1.4.0', start + 20 * 60_000, 1200], ['1.5.0-rc.1', start + 40 * 60_000, 800]] : [];
  }
  return payload;
}

export const SYNTHETIC_DB_STATEMENTS = [
  ['checkout', 'SELECT * FROM carts WHERE user_id = ?', 'postgresql', 5400, 3, 812 * 1e9, 48 * MS],
  ['checkout', 'INSERT INTO orders (id, total) VALUES (?, ?)', 'postgresql', 900, 0, 95 * 1e9, 210 * MS],
];

// Mocks both services endpoints; returns the requests seen (URLSearchParams).
export async function mockTraceServices(page, { estimated = false, releases = true, statements = SYNTHETIC_DB_STATEMENTS, dbSupported = true } = {}) {
  const seen = { services: [], db: [] };
  // The service / operation pickers list the synthetic pairs.
  await page.route('**/api/traces/prefill?**', (route) => route.fulfill({ json: {
    v: 1, source_host_id: 'local', truncated: false, tag_filtered: false,
    pairs: SYNTHETIC_SERVICES.flatMap(([name]) => [[name, 'POST /checkout'], [name, 'GET /cart']]),
  } }));
  await page.route('**/api/traces/services?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.services.push(params);
    return route.fulfill({ json: syntheticServices(params, { estimated: estimated && params.get('exact') !== '1', releases }) });
  });
  await page.route('**/api/traces/services/db?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    seen.db.push(params);
    const detail = params.get('detail') || '';
    return route.fulfill({ json: {
      v: 1, source_host_id: 'local', supported: dbSupported, detail, range: [Number(params.get('start_ms')), Number(params.get('end_ms'))],
      estimated: false, timing_ms: { query: 3 }, columns: ['service', 'statement', 'db_system', 'spans', 'errors', 'total_ns', 'p95_ns'],
      statements: dbSupported ? statements.filter((row) => !detail || row[0] === detail) : [],
    } });
  });
  return seen;
}
