import { expect } from '@playwright/test';

// The in-memory MCP server that the mcp-page spec runs the page against (the JSON of /api/mcp/*, as docs/mcp-integration-page.md
// fixes it). mcp-contract.spec.js runs the same routes against a real instance and compares the shapes of the answers with the
// ones this server gives: a change of the real JSON that this file does not follow fails there.

export const SECRET = '3f2a9c1e-7b4d-4e8a-9a6f-5c0d2b1e7a34';

// A few tools of each family of the server's table (the real one has 61): enough to see how the page draws
// families, locks and counts.
// `section`: the sub-heading of a family that has sections (Observability: traces, logs, metrics).
export const T = (name, group, description, needs = false, section = '') => ({ name, group, section, description, needs_all_data: needs });
export const TOOLS = [
  T('list_hosts', 'data', 'Hosts of the key and their health.'),
  T('list_databases', 'data', 'Databases the key can see.'),
  T('list_tables', 'data', 'Tables, engines, rows and size.'),
  T('describe_table', 'data', 'Columns, keys, engine and CREATE statement.'),
  T('query_table', 'data', 'Rows of one table: ChDash builds the SQL.'),
  T('list_services', 'observability', 'Services that sent data, with spans and errors.', false, 'traces'),
  T('search_traces', 'observability', 'Recent traces by their root span.', false, 'traces'),
  T('get_trace', 'observability', 'Every span of one trace.', false, 'traces'),
  T('traces_search', 'observability', 'Search traces (Jaeger semantics).', false, 'traces'),
  T('traces_trace', 'observability', 'One whole trace: every span.', false, 'traces'),
  T('search_logs', 'observability', 'Recent log records.', false, 'logs'),
  T('logs_search', 'observability', 'Search log records, newest first.', false, 'logs'),
  T('list_metrics', 'observability', 'Metrics reported lately.', false, 'metrics'),
  T('query_metric', 'observability', 'One metric as a time series.', false, 'metrics'),
  T('metrics_series', 'observability', 'One metric as time series.', false, 'metrics'),
  T('explorer_catalog', 'explorer', 'The databases and tables that the Explorer shows.'),
  T('explorer_table', 'explorer', 'Everything the Explorer knows about one table.'),
  T('system_overview', 'system', 'The state of the server in one answer.'),
  T('system_disks', 'system', 'Disks, free space and the size of tables.'),
  T('query_library', 'query', 'The saved queries and their folders.'),
  T('format_sql', 'query', 'Format SQL text like the Format button.'),
  T('run_query', 'sql', 'One SELECT, WITH, SHOW, DESCRIBE, EXISTS or EXPLAIN.', true),
  T('explain_query', 'sql', 'EXPLAIN of a query.', true),
];
export const SECTIONS = [{ id: 'traces', title: 'Traces' }, { id: 'logs', title: 'Logs' }, { id: 'metrics', title: 'Metrics' }];
export const GROUPS = [
  { id: 'data', title: 'Data', note: 'hosts, databases, tables and columns, and the rows of a table', sections: [] },
  { id: 'explorer', title: 'Explorer', note: 'the Explorer page', sections: [] },
  { id: 'system', title: 'System', note: 'the System page', sections: [] },
  { id: 'observability', title: 'Observability', note: 'traces, logs and metrics: the pages and the simple tools', sections: SECTIONS },
  { id: 'query', title: 'Query', note: 'the Query page', sections: [] },
  { id: 'sql', title: 'SQL', note: 'free SQL written by the client', sections: [] },
];

// The settings profile of an MCP user that sets nothing, and the limits of a key of its host (the MCP server's, as the configuration says).
const NO_PROFILE = { known: true, readonly: 0, max_execution_time: 0, max_result_rows: 0 };
const LIMITS = { max_rows: { value: 1000, source: 'mcp' }, timeout_seconds: { value: 30, source: 'mcp' } };
export const META = {
  enabled: true,
  endpoint_path: '/mcp',
  auth_header: 'Authorization',
  storage_configured: true,
  manage_from_ui: true,
  can_manage: true,
  protocol_versions: ['2025-06-18', '2025-03-26', '2024-11-05'],
  // The MCP user of each host: "ok" (it connects), "unavailable" (no key can read the host) or "unknown" (not checked yet);
  // and the tools that it cannot serve, with the grant that is missing.
  hosts: [
    { name: 'prod', label: 'Production cluster', healthy: true, mcp: { user: 'chdash_mcp', state: 'ok', error: '', reads_nothing: false, profile: NO_PROFILE, limits: LIMITS, unavailable_tools: [] } },
    { name: 'staging', label: 'staging', healthy: false, mcp: { user: 'chdash_mcp', state: 'unavailable', error: 'Code: 516. Authentication failed', reads_nothing: false, profile: NO_PROFILE, limits: LIMITS, unavailable_tools: [] } },
    {
      name: 'lab', label: 'Lab', healthy: null,
      mcp: {
        user: 'chdash_lab', state: 'ok', error: '', reads_nothing: false, profile: NO_PROFILE, limits: LIMITS,
        unavailable_tools: [
          { tool: 'traces_search', role: 'system user', user: 'chdash_sys', grants: ['SELECT ON otel.otel_traces'], statement: 'GRANT SELECT ON otel.otel_traces TO chdash_sys;' },
          { tool: 'logs_search', role: 'system user', user: 'chdash_sys', grants: ['SELECT ON otel.otel_logs', 'SELECT ON system.parts'], statement: 'GRANT SELECT ON otel.otel_logs, system.parts TO chdash_sys;' },
          { tool: 'search_logs', role: 'system user', user: 'chdash_sys', grants: ['SELECT ON otel.otel_logs'], statement: 'GRANT SELECT ON otel.otel_logs TO chdash_sys;' },
        ],
      },
    },
  ],
  tool_groups: GROUPS,
  tools: TOOLS,
  limits: { max_rows: 1000, max_result_bytes: 1048576, query_timeout_seconds: 30, max_sql_bytes: 65536, max_memory_bytes: 1073741824, max_rows_to_read: 0, rate_limit_per_minute: 600 },
  name_pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
  // The usage of the keys (mcp_usage.hpp): kept in mcp.usage_file, and the windows of its answers.
  usage: { persisted: true, retention_days: 90, windows: ['24h', '7d', '30d', '90d'], default_window: '7d', since: '2026-10-01T08:00:00Z', cost_windows: ['24h', '7d'] },
};

// The mask of a secret as the server sends it (mcp_secret_mask): the shape of a UUID, the hint in clear.
export const maskOf = (hint) => (/^[0-9a-f]{8}$/.test(hint) ? hint : '\u2022'.repeat(8)) + '-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-' + '\u2022'.repeat(12);
export const key = (over) => {
  const made = {
    id: 'ui_0a1b2c3d4e5f', name: 'ci-bot', source: 'ui', secret_hint: 'a1b2c3d4',
    hosts: ['prod'], tools: ['list_databases', 'query_table'], databases: ['otel', 'analytics.events'],
    max_rows: null, timeout_seconds: null, created_at: '2026-10-08T10:00:00Z', last_used_at: null, ...over,
  };
  return { ...made, secret_mask: maskOf(made.secret_hint) };
};

export const KEYS = () => [
  key({ id: 'ops-all', name: 'ops-all', source: 'config', secret_hint: 'c0ffee00', hosts: ['prod'], tools: ['*'], databases: ['*'], max_rows: 200, timeout_seconds: 10 }),
  key({}),
  key({ id: 'ui_111111111111', name: 'reporting', hosts: ['prod', 'staging'], databases: ['*'], tools: ['list_hosts', 'explorer_catalog', 'system_overview'] }),
  key({ id: 'ui_222222222222', name: 'second-ui-key', secret_hint: '9d4e6b20' }),
  key({ id: 'ui_legacy000000', name: 'legacy', secret_hint: '', hosts: ['prod'], tools: ['list_hosts'], databases: ['*'] }),  // a key of a file that kept no hint
];

// What a key reaches: the tables that the MCP user of each host reads, cut by the key's patterns.
export const reachOf = (owner) => ({
  id: owner.id, name: owner.name, all_data: owner.databases.includes('*'), databases: owner.databases,
  hosts: owner.hosts.map((host) => (host === 'prod' ? {
    host: 'prod', label: 'Production cluster', user: 'chdash_mcp', status: 'ok', readable_by_user: 12, acl_truncated: false, excluded_by_key: owner.databases.includes('*') ? 0 : 7,
    databases: [
      { name: 'otel', table_count: 3, truncated: false, tables: [{ name: 'otel_logs', columns: 'all' }, { name: 'otel_traces', columns: 'all' }, { name: 'otel_metrics_gauge', columns: 'some' }] },
      { name: 'analytics', table_count: 1, truncated: false, tables: [{ name: 'events', columns: 'all' }] },
    ],
  } : { host, label: host, user: 'chdash_mcp', status: 'unavailable', error: 'cannot connect as the MCP user', databases: [] })),
});

// How many databases and tables each key reaches (GET /api/mcp/access): the same data as reachOf, counted.
export const summaryOf = (keys) => ({
  keys: keys.map((owner) => {
    const reach = reachOf(owner).hosts[0];
    if (!owner.hosts.length) return { id: owner.id, status: 'no_host' };
    if (!reach || reach.status !== 'ok') return { id: owner.id, status: 'unavailable', error: reach?.error || 'cannot connect as the MCP user' };
    return {
      id: owner.id, status: 'ok', host: reach.host, user: reach.user, all_data: owner.databases.includes('*'),
      databases: reach.databases.length, tables: reach.databases.reduce((sum, db) => sum + db.table_count, 0), partial_tables: 1, truncated: false,
    };
  }),
});

// What the keys did (GET /api/mcp/usage, /keys/<id>/usage): the answers end at USAGE_TO, so the page reads "2 min ago" whatever the clock.
export const USAGE_TO = '2026-10-14T10:00:00Z';
const WINDOW_FROM = { '24h': '2026-10-13T11:00:00Z', '7d': '2026-10-08T00:00:00Z', '30d': '2026-09-15T00:00:00Z', '90d': '2026-07-17T00:00:00Z' };
export const USAGE_OF = {
  'ops-all': { requests: 1300, calls: 1204, errors: 2, first_used_at: '2026-10-01T09:00:00Z', last_used_at: '2026-10-14T09:58:00Z' },
  ui_0a1b2c3d4e5f: { requests: 20, calls: 12, errors: 3, first_used_at: '2026-10-09T08:00:00Z', last_used_at: '2026-10-13T10:00:00Z' },
  ui_222222222222: { first_used_at: '2026-10-02T10:00:00Z', last_used_at: '2026-10-04T10:00:00Z' },
  ui_legacy000000: { requests: 30, calls: 25, rate_limited: 2, first_used_at: '2026-10-10T10:00:00Z', last_used_at: '2026-10-14T07:00:00Z' },
};
// A deleted key that keeps its usage.
export const DELETED = () => [{
  id: 'ui_dead00000001', name: 'old-bot', host: 'prod', source: 'ui', deleted_at: '2026-10-12T08:00:00Z', requests: 50, calls: 40, errors: 0,
  rate_limited: 0, rejected: 0, first_used_at: '2026-10-05T08:00:00Z', last_used_at: '2026-10-12T07:59:00Z',
}];
const usageLine = (owner, over = {}) => ({
  id: owner.id, name: owner.name, host: owner.hosts.length === 1 ? owner.hosts[0] : '', source: owner.source, deleted_at: null,
  requests: 0, calls: 0, errors: 0, rate_limited: 0, rejected: 0, first_used_at: null, last_used_at: null, ...over,
});
const usageWindow = (server, window) => ({
  window, from: WINDOW_FROM[window] || WINDOW_FROM['7d'], to: USAGE_TO, since: server.meta.usage.since, persisted: server.meta.usage.persisted,
  retention_days: server.meta.usage.retention_days,
});
export const usageSummaryOf = (server, window) => ({
  ...usageWindow(server, window),
  keys: [...server.keys.map((owner) => usageLine(owner, server.usageOf[owner.id])), ...server.deleted],
});
// One key: one point for each hour (24h) or day of the window, the calls in the last one.
export function keyUsageOf(server, id, window) {
  const owner = server.keys.find((k) => k.id === id);
  const line = owner ? usageLine(owner, server.usageOf[owner.id]) : server.deleted.find((k) => k.id === id);
  if (!line) return null;
  const hourly = window === '24h';
  const count = hourly ? 24 : Number.parseInt(window, 10) || 7;
  const end = Date.parse(USAGE_TO);
  const step = hourly ? 3600000 : 86400000;
  const last = hourly ? end - step : Math.floor(end / step) * step;
  const points = Array.from({ length: count }, (_, i) => {
    const t = new Date(last - (count - 1 - i) * step).toISOString().replace('.000Z', 'Z');
    const now = i === count - 1;
    return { t, requests: now ? line.requests : 0, calls: now ? line.calls : 0, errors: now ? line.errors : 0 };
  });
  const used = line.calls > 0;
  return {
    id: line.id, name: line.name, host: line.host, source: line.source, deleted_at: line.deleted_at,
    first_used_at: line.first_used_at, last_used_at: line.last_used_at, ...usageWindow(server, window),
    totals: {
      requests: line.requests, calls: line.calls, errors: line.errors, rate_limited: line.rate_limited, rejected: line.rejected,
      duration_ms_avg: used ? 14 : null, duration_ms_max: used ? 380 : null, rows: line.calls * 3, bytes: line.requests * 1200,
    },
    series: { step: hourly ? 'hour' : 'day', points },
    tools: used ? [
      { tool: 'query_table', calls: line.calls - 2, errors: line.errors, duration_ms_avg: 15, duration_ms_max: 380, rows: line.calls * 3, bytes: line.calls * 1000 },
      { tool: 'list_tables', calls: 2, errors: 0, duration_ms_avg: 3, duration_ms_max: 4, rows: 0, bytes: 900 },
    ] : [],
    statuses: used ? [{ status: 'ok', count: line.calls - line.errors }, ...(line.errors ? [{ status: 'table_not_allowed', count: line.errors }] : [])] : [],
    clients: used ? [{ name: 'claude-code', version: '2.1.3', user_agent: 'claude-code/2.1.3 (node)', first_seen_at: line.first_used_at, last_seen_at: line.last_used_at, requests: line.requests }] : [],
  };
}
// What the statements of a key cost ClickHouse (GET /api/mcp/keys/<id>/cost); the key `reporting` cannot be read (the runner lacks
// the grant on system.query_log).
export function costOf(server, id, window) {
  const known = server.keys.some((k) => k.id === id) || server.deleted.some((k) => k.id === id);
  if (!known) return null;
  const base = {
    id, host: 'prod', window, from: window === '7d' ? '2026-10-07T10:01:00Z' : '2026-10-13T10:01:00Z', to: '2026-10-14T10:01:00Z',
    max_lookback_hours: 168, clamped: false, read_at: '2026-10-14T10:00:30Z', reason: '', error: '', statement: '', suggested_window: '',
    tables_truncated: false, rows_truncated: false,
  };
  const zero = { statements: 0, failed: 0, canceled: 0, read_rows: 0, read_bytes: 0, result_rows: 0, result_bytes: 0, duration_ms: 0, cpu_ms: 0, memory_peak_bytes: 0 };
  if (id === 'ui_111111111111') {
    return { ...base, read_at: null, status: 'unavailable', reason: 'not_granted', error: 'Code: 497. chdash_runner: Not enough privileges.',
      statement: 'GRANT SELECT ON system.query_log TO chdash_runner', totals: zero, identities: [], tools: [], tables: [] };
  }
  const figures = (statements, read) => ({ statements, failed: 1, canceled: 0, read_rows: read * 10, read_bytes: read * 1000, duration_ms: statements * 4, cpu_ms: statements, memory_peak_bytes: 4194304 });
  return {
    ...base, status: 'ok',
    totals: { ...figures(12, 900), failed: 2, result_rows: 120, result_bytes: 64000 },
    identities: [{ user: 'chdash_mcp', role: 'mcp', ...figures(10, 800) }, { user: 'chdash_system', role: 'system', ...figures(2, 100) }],
    tools: [{ tool: 'query_table', ...figures(10, 800) }, { tool: 'traces_search', ...figures(2, 100) }],
    tables: [{ name: 'otel.otel_logs', statements: 8 }, { name: 'analytics.events', statements: 2 }],
  };
}

// ---- the usage of every key (GET /api/mcp/usage/overview) ------------------------------------------------------------------------
// What the keys did, as the server keeps it: cells of one key in one hour, by kind (call, request, limited, rejected), method and result.
// The answers are computed from them by the rules of the contract (docs/mcp-integration-page.md, "The Usage tab"): every filter cuts the totals
// and the series; a table has all the filters but its own; a value that a filter picks is in its table whatever its count; the series keeps the
// 8 biggest groups of the split and sums the others as `rest`; the clients take the key filter only, and no window. The checks are in the order
// of the real route (the window, a name that is not a parameter, the split, then each dimension: de-duplicated, at most 20, valid), and a key
// has one last use for every window and every filter (mcp-contract.spec.js compares the shapes with the real answers). A spec changes
// `server.cells` (a list of what the keys did) or `server.overview` (the whole answer).
// A cell: [key id, hour, kind, method, result, count, the time of the calls added up (ms), the longest (ms), rows, bytes].
const cell = (keyId, at, kind, method, result, count, ms = 0, max = 0, rows = 0, bytes = 0) => ({ key: keyId, at: Date.parse(`${at}:00:00Z`), kind, method, result, count, ms, max, rows, bytes });
export const CELLS = () => [
  // ops-all, the busy key of the config file: 24 h, 7 d and 30 d
  cell('ops-all', '2026-10-14T09', 'call', 'query_table', 'ok', 400, 6000, 380, 1200, 400000),
  cell('ops-all', '2026-10-14T09', 'call', 'query_table', 'table_not_allowed', 2, 8, 5, 0, 600),
  cell('ops-all', '2026-10-14T09', 'call', 'list_hosts', 'ok', 40, 160, 9, 0, 24000),
  cell('ops-all', '2026-10-14T09', 'request', 'tools/list', 'ok', 60, 90, 4, 0, 300000),
  cell('ops-all', '2026-10-14T09', 'request', 'initialize', 'ok', 20, 60, 6, 0, 8000),
  cell('ops-all', '2026-10-14T09', 'request', 'ping', 'ok', 100, 50, 2, 0, 4000),
  cell('ops-all', '2026-10-14T08', 'call', 'run_query', 'ok', 30, 3600, 900, 3000, 90000),
  cell('ops-all', '2026-10-14T08', 'call', 'run_query', 'sql_error', 5, 150, 60, 0, 2500),
  cell('ops-all', '2026-10-13T15', 'call', 'describe_table', 'ok', 25, 250, 30, 0, 50000),
  cell('ops-all', '2026-10-13T15', 'request', 'notifications/initialized', 'ok', 20, 10, 1, 0, 0),
  // 7 d and 30 d
  cell('ops-all', '2026-10-12T12', 'call', 'query_table', 'ok', 300, 4500, 200, 900, 300000),
  cell('ops-all', '2026-10-09T12', 'call', 'list_hosts', 'ok', 10, 40, 6, 0, 6000),
  // 30 d only
  cell('ops-all', '2026-10-02T12', 'call', 'query_table', 'ok', 100, 1500, 120, 300, 100000),
  cell('ui_222222222222', '2026-10-04T10', 'call', 'list_tables', 'ok', 6, 30, 9, 0, 7000),
  // ci-bot, last used yesterday
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12', 'call', 'query_table', 'ok', 9, 135, 30, 27, 9000),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12', 'call', 'query_table', 'table_not_allowed', 3, 6, 3, 0, 900),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12', 'request', 'initialize', 'ok', 3, 9, 4, 0, 1200),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12', 'request', 'tools/list', 'ok', 5, 10, 3, 0, 20000),
  // legacy: a refusal of the rate limit, and a method that the vocabulary does not know
  cell('ui_legacy000000', '2026-10-14T07', 'call', 'list_hosts', 'ok', 25, 100, 8, 0, 15000),
  cell('ui_legacy000000', '2026-10-14T07', 'limited', 'unread', '429_rate_limited', 2, 0, 0, 0, 200),
  cell('ui_legacy000000', '2026-10-14T07', 'request', 'other', 'rpc_error_32601', 1, 1, 1, 0, 150),
  // a deleted key keeps its usage
  cell('ui_dead00000001', '2026-10-12T07', 'call', 'query_table', 'ok', 40, 600, 50, 120, 40000),
  cell('ui_dead00000001', '2026-10-12T07', 'rejected', 'unread', '413_payload_too_large', 1, 0, 0, 0, 120),
];
// The clients of each key, for as long as the retention keeps them (they take no window).
export const CLIENTS = () => [
  { key: 'ops-all', name: 'claude-code', version: '2.1.3', user_agent: 'claude-code/2.1.3 (node)', requests: 900, first: '2026-10-01T09:00:00Z', last: '2026-10-14T09:58:00Z' },
  { key: 'ops-all', name: 'mcp-inspector', version: '0.14.0', user_agent: 'node', requests: 40, first: '2026-10-05T11:00:00Z', last: '2026-10-09T12:00:00Z' },
  { key: 'ui_0a1b2c3d4e5f', name: 'claude-code', version: '2.1.3', user_agent: 'claude-code/2.1.3 (node)', requests: 20, first: '2026-10-09T08:00:00Z', last: '2026-10-13T12:00:00Z' },
  { key: 'ui_legacy000000', name: '', version: '', user_agent: 'python-httpx/0.27.0', requests: 28, first: '2026-10-10T10:00:00Z', last: '2026-10-14T07:00:00Z' },
];

const DIMENSIONS = ['key', 'method', 'result', 'type'];
const VALID = { key: /^[a-z0-9][a-z0-9_-]*$/, method: /^[A-Za-z0-9_/]{1,64}$/, result: /^[a-z0-9_]{1,64}$/, type: /^(?:call|request|limited|rejected)$/ };
const PROTOCOL = [
  'initialize', 'ping', 'tools/list', 'tools/call', 'response', 'notifications/initialized', 'notifications/cancelled', 'notifications/progress',
  'notifications/roots/list_changed', 'resources/list', 'resources/read', 'resources/templates/list', 'resources/subscribe', 'resources/unsubscribe',
  'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel', 'other', 'invalid',
];
const TYPES = ['call', 'request', 'limited', 'rejected'];
const invalid = (field, reason, message) => ({ status: 400, body: { error_code: 'validation', message, retryable: false, field, reason } });
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
// The server counts whole milliseconds: an average is a whole number, and 0 is a time under a millisecond.
const average = (total, n) => (n ? Math.round(total / n) : null);
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const newest = (list) => (list.length ? iso(Math.max(...list)) : null);

// The answer of the server for the query string of the page: { status, body }.
export function overviewOf(server, params) {
  // The window (an empty one is the default), then a name that is not a parameter, then the split (an empty one is not valid).
  const window = params.get('window') || server.meta.usage.default_window;
  if (!server.meta.usage.windows.includes(window)) return invalid('window', 'invalid', `window must be one of ${server.meta.usage.windows.join(', ')}`);
  for (const name of new Set(params.keys())) {
    if (!['window', 'split', ...DIMENSIONS].includes(name)) return invalid(name, 'unknown', `unknown parameter: ${name}`);
  }
  const split = params.has('split') ? params.get('split') : 'method';
  if (!DIMENSIONS.includes(split)) return invalid('split', 'invalid', 'split must be key, method, result or type');
  // Each dimension: the repeated values once each (the first one stays), at most 20, each one valid.
  const filters = {};
  for (const dimension of DIMENSIONS) {
    const values = [...new Set(params.getAll(dimension))];
    if (values.length > 20) return invalid(dimension, 'too_many', `${dimension} takes at most 20 values`);
    if (values.some((value) => !VALID[dimension].test(value))) return invalid(dimension, 'invalid', `${dimension} is not valid`);
    filters[dimension] = values;
  }

  const hourly = window === '24h';
  const step = hourly ? 3600000 : 86400000;
  const buckets = hourly ? 24 : Number.parseInt(window, 10);
  const from = Date.parse(WINDOW_FROM[window]);
  const names = new Map([...server.keys, ...server.deleted].map((owner) => [owner.id, owner.name]));
  const valueOf = (dimension, c) => (dimension === 'key' ? c.key : dimension === 'type' ? c.kind : c[dimension]);
  // The cells of the window that every filter but `skip` lets through.
  const inWindow = server.cells.filter((c) => c.at >= from && c.at < from + buckets * step);
  const cut = (skip) => inWindow.filter((c) => DIMENSIONS.every((dimension) => dimension === skip || !filters[dimension].length || filters[dimension].includes(valueOf(dimension, c))));
  const errorOf = (c) => c.result !== 'ok' && (c.kind === 'call' || c.kind === 'request');
  const figures = (list) => {
    const calls = list.filter((c) => c.kind === 'call');
    return {
      requests: sum(list, (c) => c.count),
      calls: sum(calls, (c) => c.count),
      errors: sum(list.filter(errorOf), (c) => c.count),
      rate_limited: sum(list.filter((c) => c.kind === 'limited'), (c) => c.count),
      rejected: sum(list.filter((c) => c.kind === 'rejected'), (c) => c.count),
      duration_ms_avg: average(sum(calls, (c) => c.ms), sum(calls, (c) => c.count)),
      duration_ms_max: calls.length ? Math.max(...calls.map((c) => c.max)) : null,
      rows: sum(list, (c) => c.rows),
      bytes: sum(list, (c) => c.bytes),
    };
  };
  const distinct = (list, dimension) => new Set(list.map((c) => valueOf(dimension, c))).size;

  // The totals and the series: every filter.
  const all = cut(null);
  const totals = { ...figures(all), active_keys: distinct(all, 'key'), keys: server.keys.length };
  const labelOf = (id) => (split === 'key' ? names.get(id) || id : id);
  const groupIds = filters[split].length ? filters[split] : [...new Set(all.map((c) => valueOf(split, c)))];
  const valuesOf = (ids) => Array.from({ length: buckets }, (_, i) => sum(all.filter((c) => ids.includes(valueOf(split, c)) && Math.floor((c.at - from) / step) === i), (c) => c.count));
  const groups = groupIds.map((id) => ({ id, label: labelOf(id), total: sum(all.filter((c) => valueOf(split, c) === id), (c) => c.count), values: valuesOf([id]) }))
    .sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1));
  const shown = filters[split].length ? groups : groups.slice(0, 8);
  const folded = filters[split].length ? [] : groups.slice(8);
  const series = {
    step: hourly ? 'hour' : 'day',
    t: Array.from({ length: buckets }, (_, i) => iso(from + i * step)),
    groups: shown,
    rest: { groups: folded.length, total: sum(folded, (g) => g.total), values: valuesOf(folded.map((g) => g.id)) },
  };

  // The tables: every filter but their own, the rows that have requests and the values that a filter picks.
  const rows = (dimension, byOf, build) => {
    const list = cut(dimension);
    const ids = new Set([...list.map(byOf), ...filters[dimension]]);
    return [...ids].map((id) => build(id, list.filter((c) => byOf(c) === id)));
  };
  const keys = rows('key', (c) => c.key, (id, list) => {
    const owner = server.keys.find((k) => k.id === id);
    const gone = server.deleted.find((k) => k.id === id);
    const own = server.cells.filter((c) => c.key === id);
    return {
      id, name: names.get(id) || id, host: owner && owner.hosts.length === 1 ? owner.hosts[0] : gone ? gone.host : '', source: (owner || gone || { source: '' }).source,
      deleted_at: gone ? gone.deleted_at : null, ...figures(list), last_used_at: newest(own.map((c) => c.at)),
    };
  }).sort((a, b) => b.requests - a.requests || (a.name < b.name ? -1 : 1));
  // A method row has times when it has requests (the refused ones too), and none when a filter picked a method that nothing matches.
  // Its kind comes from its name: a tool is a call, `unread` is refused, the vocabulary of the protocol is a request.
  const methods = rows('method', (c) => c.method, (id, list) => ({
    method: id, kind: PROTOCOL.includes(id) ? 'request' : id === 'unread' ? 'refused' : 'call', requests: sum(list, (c) => c.count), errors: sum(list.filter(errorOf), (c) => c.count),
    duration_ms_avg: average(sum(list, (c) => c.ms), sum(list, (c) => c.count)), duration_ms_max: list.length ? Math.max(...list.map((c) => c.max)) : null,
    rows: sum(list, (c) => c.rows), bytes: sum(list, (c) => c.bytes), keys: distinct(list, 'key'),
  })).sort((a, b) => b.requests - a.requests || (a.method < b.method ? -1 : 1));
  const results = rows('result', (c) => c.result, (id, list) => ({ result: id, count: sum(list, (c) => c.count), keys: distinct(list, 'key') }))
    .sort((a, b) => b.count - a.count || (a.result < b.result ? -1 : 1));
  const typeList = cut('type');
  const types = TYPES.map((type) => ({ type, requests: sum(typeList.filter((c) => c.kind === type), (c) => c.count) }));

  // The clients: the key filter only, grouped by name and version (by User-Agent when the client has no name).
  const clients = new Map();
  for (const client of server.clients.filter((c) => !filters.key.length || filters.key.includes(c.key))) {
    const id = client.name ? `${client.name}\n${client.version}` : `\n${client.user_agent}`;
    const found = clients.get(id) || { name: client.name, version: client.version, user_agent: client.user_agent, keys: new Set(), requests: 0, first: client.first, last: client.last };
    found.keys.add(client.key);
    found.requests += client.requests;
    found.first = found.first < client.first ? found.first : client.first;
    found.last = found.last > client.last ? found.last : client.last;
    clients.set(id, found);
  }
  const clientRows = [...clients.values()].sort((a, b) => (a.last < b.last ? 1 : -1))
    .map((c) => ({ name: c.name, version: c.version, user_agent: c.user_agent, keys: c.keys.size, requests: c.requests, first_seen_at: c.first, last_seen_at: c.last }));

  return {
    status: 200,
    body: {
      ...usageWindow(server, window), split, filters, totals, series, keys, methods, results, types, clients: clientRows,
      omitted: { keys: 0, methods: 0, results: 0, clients: 0 },
    },
  };
}

// The server: meta and keys in memory; every call recorded. `errors` makes the next call of a route fail.
export function newServer(over = {}) {
  const server = { keys: KEYS(), calls: [], errors: {}, delay: {}, version: { mcp: { enabled: true } }, access: reachOf, summary: summaryOf,
    usageOf: USAGE_OF, deleted: DELETED(), usage: usageSummaryOf, keyUsage: keyUsageOf, cost: costOf, cells: CELLS(), clients: CLIENTS(), overview: overviewOf, ...over };
  server.meta = { ...structuredClone(META), ...(over.meta || {}) };
  return server;
}

export const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export async function install(page, server) {
  // The shell is served at /mcp-integration only when the instance has MCP on: the request is sent on to
  // the shell's static file, which the document then shows under the page's own address.
  await page.route('**/mcp-integration', (route) => route.continue({ url: new URL('/static/mcp.html', route.request().url()).href }));
  // The Usage page, with the window, the split and the filters in its address.
  await page.route(/\/mcp-integration\/usage\/?(\?.*)?$/, (route) => route.continue({ url: new URL('/static/mcpusage.html', route.request().url()).href }));
  await page.route('**/api/version', async (route) => {
    // A test that ends while this request is in flight disposes the response: nothing is left to answer.
    try {
      const response = await route.fetch();
      const body = await response.json();
      body.features = { ...body.features, ...server.version };
      await json(route, 200, body);
    } catch (error) {
      if (!/disposed|closed|ended/i.test(String(error && error.message))) throw error;
    }
  });
  await page.route('**/api/mcp/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/mcp/, '');
    const method = request.method();
    const body = method === 'GET' || method === 'DELETE' ? null : (request.postDataJSON() ?? null);
    server.calls.push({ method, path, body, query: url.search });
    const failure = server.errors[`${method} ${path}`] || server.errors[`${method} *`];
    if (failure) {
      if (!failure.keep) {
        delete server.errors[`${method} ${path}`];
        delete server.errors[`${method} *`];
      }
      return json(route, failure.status, failure.body);
    }
    const wait = server.delay[`${method} ${path}`];
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (method === 'GET' && path === '/meta') return json(route, 200, server.meta);
    if (!server.meta.enabled) return json(route, 404, { error_code: 'mcp_disabled', message: 'MCP is turned off.', retryable: false });
    if (method === 'GET' && path === '/keys') return json(route, 200, { keys: server.keys });
    if (method === 'GET' && path === '/access') return json(route, 200, server.summary(server.keys));
    if (method === 'POST' && path === '/keys') {
      const created = key({ id: 'ui_aabbccddeeff', name: body.name, hosts: body.hosts, tools: body.tools, databases: body.databases, max_rows: body.max_rows ?? null, timeout_seconds: body.timeout_seconds ?? null, secret_hint: SECRET.slice(0, 8) });
      server.keys.push(created);
      return json(route, 201, { key: created, secret: SECRET });
    }
    if (method === 'GET' && path === '/usage/overview') {
      const answer = server.overview(server, url.searchParams);
      return json(route, answer.status, answer.body);
    }
    if (method === 'GET' && path === '/usage') {
      const window = url.searchParams.get('window') || server.meta.usage.default_window;
      if (!server.meta.usage.windows.includes(window)) return json(route, 400, { error_code: 'validation', message: 'window must be one of the windows of the retention', retryable: false, field: 'window', reason: 'invalid' });
      return json(route, 200, server.usage(server, window));
    }
    const usage = method === 'GET' ? /^\/keys\/([^/]+)\/(usage|cost)$/.exec(path) : null;
    if (usage) {
      const id = decodeURIComponent(usage[1]);
      const window = url.searchParams.get('window') || (usage[2] === 'usage' ? server.meta.usage.default_window : '24h');
      const answer = usage[2] === 'usage' ? server.keyUsage(server, id, window) : server.cost(server, id, window, url.searchParams.get('refresh') === '1');
      if (!answer) return json(route, 404, { error_code: 'not_found', message: 'no such key', retryable: false });
      return json(route, 200, answer);
    }
    const reach = method === 'GET' ? /^\/keys\/([^/]+)\/access$/.exec(path) : null;
    if (reach) {
      const owner = server.keys.find((k) => k.id === decodeURIComponent(reach[1]));
      if (!owner) return json(route, 404, { error_code: 'not_found', message: 'No such key.', retryable: false });
      return json(route, 200, server.access(owner, url.searchParams.get('refresh') === '1'));
    }
    const match = /^\/keys\/([^/]+)$/.exec(path);
    const found = match ? server.keys.find((k) => k.id === decodeURIComponent(match[1])) : null;
    if (!found) return json(route, 404, { error_code: 'not_found', message: 'No such key.', retryable: false });
    if (found.source === 'config') return json(route, 409, { error_code: 'config_key', message: 'A key of the config file cannot change here.', retryable: false });
    if (method === 'DELETE') {
      server.keys = server.keys.filter((k) => k !== found);
      return json(route, 200, { ok: true, id: found.id });
    }
    return json(route, 404, { error_code: 'not_found', message: 'No such route.', retryable: false });
  });
}
