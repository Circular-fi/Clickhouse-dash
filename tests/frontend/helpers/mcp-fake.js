import { expect } from '@playwright/test';

// The in-memory MCP server that the mcp-page spec runs the page against. It gives the JSON of /api/mcp/*, as docs/mcp-integration-page.md fixes it.
// mcp-contract.spec.js runs the same routes against a real instance. It compares the shapes of the answers with the answers of this server.
// A change of the real JSON that this file does not follow fails in that spec.
// The usage has three states here, as on the real server.
// The first state is on, with two instances that share the usage directory. This is the default. The instances are `chdash-0`, this one, and `chdash-1`.
// Each cell of the usage says which file it comes from.
// The second state is on, with one instance (`oneInstance(server)`).
// The third state is off (`setUsage(server, { enabled: false })`). The usage routes answer 404 `not_enabled`, and the tools of the analysis of the usage are not offered.
// A spec sets `server.instances` (the state of each file: ok, skipped, conflict). It sets `server.elsewhere` (the keys that only another instance knows).

export const SECRET = '3f2a9c1e-7b4d-4e8a-9a6f-5c0d2b1e7a34';

// The server table has a few tools in each family. The real table has 64 tools. These few tools are enough to show how the page draws
// families, locks and counts.
// `section` is the sub-heading of a family that has sections (Observability: traces, logs, metrics).
// `flags` has three values.
//   `always`: every key has the tool, whatever its list says.
//   `explicit_only`: a "*" does not give the tool. A key has it only when its list names it.
//   `available`: the server offers the tool now. The tools of the analysis of the usage need the usage. The tool of all the keys also needs mcp.usage.all_keys.
export const T = (name, group, description, needs = false, section = '', flags = {}) => ({
  name, group, section, description, needs_all_data: needs, always: false, explicit_only: false, available: true, ...flags,
});
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
  T('mcp_analysis_my_limits', 'mcp_analysis', 'The limits of your key: the rate, the rows, the timeout and the sizes.', false, '', { always: true }),
  T('mcp_analysis_my_usage', 'mcp_analysis', 'What your key did: the totals, the tools, the errors and the clients.', false, '', { always: true }),
  T('mcp_analysis_all_usage', 'mcp_analysis', 'What all the keys of all the instances did.', false, '', { explicit_only: true }),
];
export const SECTIONS = [{ id: 'traces', title: 'Traces' }, { id: 'logs', title: 'Logs' }, { id: 'metrics', title: 'Metrics' }];
export const GROUPS = [
  { id: 'data', title: 'Data', note: 'hosts, databases, tables and columns, and the rows of a table', sections: [] },
  { id: 'explorer', title: 'Explorer', note: 'the Explorer page', sections: [] },
  { id: 'system', title: 'System', note: 'the System page', sections: [] },
  { id: 'observability', title: 'Observability', note: 'traces, logs and metrics: the pages and the simple tools', sections: SECTIONS },
  { id: 'query', title: 'Query', note: 'the Query page', sections: [] },
  { id: 'sql', title: 'SQL', note: 'free SQL written by the client', sections: [] },
  { id: 'mcp_analysis', title: 'MCP analysis', note: 'your own limits and usage, and the usage of all the keys', sections: [] },
];

// The settings profile of an MCP user that sets nothing. It also gives the limits of a key of its host. The limits are the MCP server limits, as the configuration says.
const NO_PROFILE = { known: true, readonly: 0, max_execution_time: 0, max_result_rows: 0 };
const LIMITS = { max_rows: { value: 1000, source: 'mcp' }, timeout_seconds: { value: 30, source: 'mcp' } };
export const META = {
  enabled: true,
  endpoint_path: '/mcp',
  auth_header: 'Authorization',
  storage_configured: true,
  manage_from_ui: true,
  keys_mode: 'hybrid',
  can_manage: true,
  protocol_versions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  // Each host has an MCP user with one of three states. "ok" means it connects. "unavailable" means no key can read the host. "unknown" means it is not checked yet.
  // The same entry also lists the tools that it cannot serve, with the grant that is missing.
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
  // The analysis of the usage is offered while the usage is on. The usage of all the keys needs mcp.usage.all_keys. It is off here, because setUsage sets it to on.
  tools: TOOLS.map((tool) => (tool.name === 'mcp_analysis_all_usage' ? { ...tool, available: false } : tool)),
  limits: { max_rows: 1000, max_result_bytes: 1048576, query_timeout_seconds: 30, max_sql_bytes: 65536, max_memory_bytes: 1073741824, max_rows_to_read: 0, rate_limit_per_minute: 600 },
  name_pattern: '^[a-z0-9][a-z0-9_-]{0,31}$',
  // The usage of the keys is set by mcp.usage in the config. When it is on, the usage is kept in the files of a directory that several ChDash instances may share.
  // When it is off, only the windows of the cost stay (usageMeta below). `all_keys` lets a key have the usage of all the keys.
  usage: usageMeta(),
};

// The `usage` entry of the meta has two states. When it is on, it has this instance, the retention and the windows. When it is off, it has the windows of the cost only.
export function usageMeta({ enabled = true, allKeys = false } = {}) {
  if (!enabled) return { enabled: false, cost_windows: ['1h', '6h', '24h', '7d'] };
  return {
    enabled: true, storage: 'files', instance: 'chdash-0', retention_days: 90, windows: ['1h', '6h', '24h', '7d', '30d', '90d'], default_window: '7d',
    since: '2026-10-01T08:00:00Z', cost_windows: ['1h', '6h', '24h', '7d'], all_keys: allKeys,
  };
}

// Sets the usage of a server to on or to off. It also sets the setting of all the keys. This changes the usage block of the meta and the tools that depend on it.
// The tools of the analysis of the usage are offered only while the usage is on. The tool of all the keys is offered only with `all_keys`.
export function setUsage(server, options = {}) {
  server.meta.usage = usageMeta(options);
  const { enabled = true, allKeys = false } = options;
  for (const tool of server.meta.tools) {
    if (tool.name === 'mcp_analysis_my_usage') tool.available = enabled;
    if (tool.name === 'mcp_analysis_all_usage') tool.available = enabled && allKeys;
  }
  return server;
}

// The mask of a secret, as the server sends it (mcp_secret_mask). It has the shape of a UUID, and the hint in clear text.
export const maskOf = (hint) => (/^[0-9a-f]{8}$/.test(hint) ? hint : '\u2022'.repeat(8)) + '-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-' + '\u2022'.repeat(12);
export const key = (over) => {
  const made = {
    id: 'ui_0a1b2c3d4e5f', name: 'ci-bot', source: 'ui', secret_hint: 'a1b2c3d4',
    hosts: ['prod'], tools: ['list_databases', 'query_table'], databases: ['otel', 'analytics.events'],
    max_rows: null, timeout_seconds: null, subject: null, creator: null, orphan: null, expires_at: null, created_at: '2026-10-08T10:00:00Z', last_used_at: null, ...over,
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

// This shows what a key reaches. These are the tables that the MCP user of each host reads, cut by the key patterns.
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

// This counts the databases and tables that each key reaches (GET /api/mcp/access). The data is the same as reachOf, counted.
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

// This shows what the keys did (GET /api/mcp/usage, /keys/<id>/usage). The answers end at USAGE_TO. The page therefore reads "2 min ago" whatever the clock says.
export const USAGE_TO = '2026-10-14T10:00:00Z';
// The windows, as the server cuts them (mcp_usage.hpp). Each window has a step in seconds and a number of points.
// A window has `points` steps of `step` seconds, aligned to UTC. The last step holds the time of the answer.
export const WINDOWS = { '1h': [60, 60], '6h': [300, 72], '24h': [900, 96], '7d': [10800, 56], '30d': [43200, 60], '90d': [86400, 90], '365d': [86400, 365] };
export function geometry(window) {
  const [step, points] = WINDOWS[window] || WINDOWS['7d'];
  const stepMs = step * 1000;
  const last = Math.floor(Date.parse(USAGE_TO) / stepMs) * stepMs;
  return { step, points, stepMs, from: last - (points - 1) * stepMs };
}
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
// A key that only another instance knows (`elsewhere`). It is made on the page of another ChDash instance that shares the usage directory.
// The answer that lists the usage of the keys includes it, with the deleted keys. By default there are none. A spec or a picture sets `server.elsewhere`.
export const ELSEWHERE = () => [{
  id: 'ui_ee0000000001', name: 'etl-bot', host: 'prod', source: 'ui', deleted_at: null, elsewhere: true, requests: 15, calls: 12, errors: 0,
  rate_limited: 0, rejected: 0, first_used_at: '2026-10-11T08:00:00Z', last_used_at: '2026-10-14T09:00:00Z',
}];

// The instances that share the usage directory. Every answer of the usage lists them, this one first.
// Each entry has the last write of its file, and whether the file can be read. The state is "ok", "skipped" (its file is excluded from the sums), or "conflict" (another ChDash writes with the name of this one).
// A spec sets `server.instances`. `oneInstance(server)` is a server that has this instance only.
export const INSTANCES = () => [
  { instance: 'chdash-0', written_at: '2026-10-14T09:59:30Z', status: 'ok', reason: '' },
  { instance: 'chdash-1', written_at: '2026-10-14T09:58:50Z', status: 'ok', reason: '' },
];
export function oneInstance(server) {
  server.instances = INSTANCES().slice(0, 1);
  for (const c of server.cells) c.instance = 'chdash-0';
  return server;
}
const usageLine = (owner, over = {}) => ({
  id: owner.id, name: owner.name, host: owner.hosts.length === 1 ? owner.hosts[0] : '', source: owner.source, deleted_at: null, elsewhere: false,
  requests: 0, calls: 0, errors: 0, rate_limited: 0, rejected: 0, first_used_at: null, last_used_at: null, ...over,
});
const usageWindow = (server, window) => ({
  window, from: new Date(geometry(window).from).toISOString().replace('.000Z', 'Z'), to: USAGE_TO, since: server.meta.usage.since,
  retention_days: server.meta.usage.retention_days, instances: server.instances,
});
export const usageSummaryOf = (server, window) => ({
  ...usageWindow(server, window),
  // Every line says whether only another instance knows the key (`elsewhere`), as the real answer does.
  keys: [...server.keys.map((owner) => usageLine(owner, server.usageOf[owner.id])), ...server.deleted.map((line) => ({ elsewhere: false, ...line })),
    ...server.elsewhere.map((line) => ({ elsewhere: true, ...line }))],
});
// One key has one point for each step of the window (1 min to 1 day). The last point has the calls.
export function keyUsageOf(server, id, window) {
  const owner = server.keys.find((k) => k.id === id);
  const line = owner ? usageLine(owner, server.usageOf[owner.id]) : [...server.deleted, ...server.elsewhere].find((k) => k.id === id);
  if (!line) return null;
  const { step, points: count, stepMs, from } = geometry(window);
  const points = Array.from({ length: count }, (_, i) => {
    const t = new Date(from + i * stepMs).toISOString().replace('.000Z', 'Z');
    const now = i === count - 1;
    return { t, requests: now ? line.requests : 0, calls: now ? line.calls : 0, errors: now ? line.errors : 0 };
  });
  const used = line.calls > 0;
  return {
    id: line.id, name: line.name, host: line.host, source: line.source, deleted_at: line.deleted_at, elsewhere: line.elsewhere === true,
    first_used_at: line.first_used_at, last_used_at: line.last_used_at, ...usageWindow(server, window),
    totals: {
      requests: line.requests, calls: line.calls, errors: line.errors, rate_limited: line.rate_limited, rejected: line.rejected,
      duration_ms_avg: used ? 14 : null, duration_ms_max: used ? 380 : null, rows: line.calls * 3, bytes: line.requests * 1200,
    },
    series: { step, points },
    tools: used ? [
      { tool: 'query_table', calls: line.calls - 2, errors: line.errors, duration_ms_avg: 15, duration_ms_max: 380, rows: line.calls * 3, bytes: line.calls * 1000 },
      { tool: 'list_tables', calls: 2, errors: 0, duration_ms_avg: 3, duration_ms_max: 4, rows: 0, bytes: 900 },
    ] : [],
    statuses: used ? [{ status: 'ok', count: line.calls - line.errors }, ...(line.errors ? [{ status: 'table_not_allowed', count: line.errors }] : [])] : [],
    clients: used ? [{ name: 'claude-code', version: '2.1.3', user_agent: 'claude-code/2.1.3 (node)', first_seen_at: line.first_used_at, last_seen_at: line.last_used_at, requests: line.requests }] : [],
  };
}
// This shows what the statements of a key cost ClickHouse (GET /api/mcp/keys/<id>/cost). The key `reporting` cannot be read,
// because the runner lacks the grant on system.query_log.
export function costOf(server, id, window) {
  const known = server.keys.some((k) => k.id === id) || server.deleted.some((k) => k.id === id) || server.elsewhere.some((k) => k.id === id);
  if (!known) return null;
  const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[window] || 24;
  const base = {
    id, host: 'prod', window, from: new Date(Date.parse('2026-10-14T10:01:00Z') - hours * 3600000).toISOString().replace('.000Z', 'Z'), to: '2026-10-14T10:01:00Z',
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
// What the keys did, as the server keeps it. The server keeps cells of one key in one minute, by kind (call, request, limited, rejected), client, method and result.
// The answers are computed from the cells by the rules of the contract (docs/mcp-integration-page.md, "The Usage tab").
// The window has `points` steps of its own (1 h by the minute ... 90 d by the day). A cell is in the step that holds its minute.
// Every filter cuts the totals and the series.
// A facet (keys, methods, results, types, clients, instances) has all the filters except its own. A facet lists a value that a filter picks, whatever its count. A facet keeps 200 rows.
// The instances are every instance that the server knows, with zeros when it has no request.
// Each group in the series has six figures. They are the requests, the errors, the refused requests, the tool calls and their time, and the bytes.
// The series shows the 8 biggest groups of the dimension that it groups by. The biggest groups are chosen by `order` (requests, errors, refused, calls or bytes).
// Requests are the order when `order` is omitted, and the answer echoes it. The series can also show the values that are picked when that dimension is filtered.
// The other groups are summed as `rest`. A group that has none of the ranking metric is in `rest`.
// `orders` has the same five names, at most five. A repeated name counts once. `orders` adds `series.rankings`: one member for each order, in the order of the request.
// Each member is made as `groups` and `rest` are made for that order. The steps are those of `series`, and a ranking does not repeat them. Without `orders`, there is no `rankings`.
// The checks run in the order of the real route. They check the window, a name that is not a parameter, the group, the order, the orders, and then each dimension.
// Each dimension is de-duplicated, has at most 20 values, and each value must be valid. Each key has one last use for every window and every filter.
// mcp-contract.spec.js compares the shapes with the real answers. A spec changes `server.cells` (a list of what the keys did) or `server.overview` (the whole answer).
// A cell is: [key id, minute, kind, client, method, result, count, the time of the calls added up (ms), the longest (ms), rows, bytes, instance].
// A client that a cell omits is `unknown`. The instance is the one whose file holds the cell (this one, `chdash-0`, by default).
export const cell = (keyId, at, kind, client, method, result, count, ms = 0, max = 0, rows = 0, bytes = 0, instance = 'chdash-0') => ({ key: keyId, at: Date.parse(`${at}:00Z`), kind, client, method, result, count, ms, max, rows, bytes, instance });
export const CELLS = () => [
  // ops-all is the busy key of the config file. It has the last hour (by the minute), 6 h, 24 h, 7 d and 30 d.
  cell('ops-all', '2026-10-14T09:31', 'call', 'claude-code', 'query_table', 'ok', 400, 6000, 380, 1200, 400000),
  cell('ops-all', '2026-10-14T09:31', 'call', 'claude-code', 'query_table', 'table_not_allowed', 2, 8, 5, 0, 600),
  cell('ops-all', '2026-10-14T09:58', 'call', 'mcp-inspector', 'list_hosts', 'ok', 40, 160, 9, 0, 24000, 'chdash-1'),
  cell('ops-all', '2026-10-14T09:15', 'request', 'mcp-inspector', 'tools/list', 'ok', 60, 90, 4, 0, 300000, 'chdash-1'),
  cell('ops-all', '2026-10-14T09:15', 'request', 'mcp-inspector', 'initialize', 'ok', 20, 60, 6, 0, 8000, 'chdash-1'),
  cell('ops-all', '2026-10-14T09:44', 'request', 'claude-code', 'ping', 'ok', 100, 50, 2, 0, 4000),
  cell('ops-all', '2026-10-14T08:20', 'call', 'claude-code', 'run_query', 'ok', 30, 3600, 900, 3000, 90000, 'chdash-1'),
  cell('ops-all', '2026-10-14T08:20', 'call', 'claude-code', 'run_query', 'sql_error', 5, 150, 60, 0, 2500, 'chdash-1'),
  cell('ops-all', '2026-10-13T15:40', 'call', 'claude-code', 'describe_table', 'ok', 25, 250, 30, 0, 50000),
  cell('ops-all', '2026-10-13T15:40', 'request', 'claude-code', 'notifications/initialized', 'ok', 20, 10, 1, 0, 0),
  // 7 d and 30 d
  cell('ops-all', '2026-10-12T12:30', 'call', 'claude-code', 'query_table', 'ok', 300, 4500, 200, 900, 300000),
  cell('ops-all', '2026-10-09T12:30', 'call', 'mcp-inspector', 'list_hosts', 'ok', 10, 40, 6, 0, 6000),
  // 30 d only
  cell('ops-all', '2026-10-02T12:30', 'call', 'claude-code', 'query_table', 'ok', 100, 1500, 120, 300, 100000),
  cell('ui_222222222222', '2026-10-04T10:30', 'call', 'mcp-inspector', 'list_tables', 'ok', 6, 30, 9, 0, 7000),
  // ci-bot was last used yesterday: claude-code, and an editor whose name has spaces.
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12:20', 'call', 'claude-code', 'query_table', 'ok', 9, 135, 30, 27, 9000),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12:20', 'call', 'claude-code', 'query_table', 'table_not_allowed', 3, 6, 3, 0, 900),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12:20', 'request', 'Visual Studio Code', 'initialize', 'ok', 3, 9, 4, 0, 1200),
  cell('ui_0a1b2c3d4e5f', '2026-10-13T12:20', 'request', 'Visual Studio Code', 'tools/list', 'ok', 5, 10, 3, 0, 20000),
  // legacy has no clientInfo, and it has the User-Agent of python-httpx. It has a refusal of the rate limit, and a method that the vocabulary does not know.
  cell('ui_legacy000000', '2026-10-14T07:30', 'call', 'python-httpx', 'list_hosts', 'ok', 25, 100, 8, 0, 15000, 'chdash-1'),
  cell('ui_legacy000000', '2026-10-14T07:30', 'limited', 'python-httpx', 'unread', '429_rate_limited', 2, 0, 0, 0, 200, 'chdash-1'),
  cell('ui_legacy000000', '2026-10-14T07:30', 'request', 'python-httpx', 'other', 'rpc_error_32601', 1, 1, 1, 0, 150, 'chdash-1'),
  // A deleted key keeps its usage. Its client gave no information about itself.
  cell('ui_dead00000001', '2026-10-12T07:30', 'call', 'unknown', 'query_table', 'ok', 40, 600, 50, 120, 40000),
  cell('ui_dead00000001', '2026-10-12T07:30', 'rejected', 'unknown', 'unread', '413_payload_too_large', 1, 0, 0, 0, 120),
];
// The clients that each key kept for its whole life. Each client has a version, and the time when it was first and last seen.
// The `versions` and `last_seen_at` of a client row come from these records. The windows and the filters do not apply to them.
export const CLIENTS = () => [
  { key: 'ops-all', client: 'claude-code', version: '2.1.3', first: '2026-10-01T09:00:00Z', last: '2026-10-14T09:44:00Z' },
  { key: 'ops-all', client: 'claude-code', version: '2.0.9', first: '2026-09-20T09:00:00Z', last: '2026-10-05T09:00:00Z' },
  { key: 'ops-all', client: 'mcp-inspector', version: '0.14.0', first: '2026-10-05T11:00:00Z', last: '2026-10-14T09:58:00Z' },
  { key: 'ui_0a1b2c3d4e5f', client: 'claude-code', version: '2.1.3', first: '2026-10-09T08:00:00Z', last: '2026-10-13T12:20:00Z' },
  { key: 'ui_0a1b2c3d4e5f', client: 'Visual Studio Code', version: '1.95.0', first: '2026-10-13T12:20:00Z', last: '2026-10-13T12:20:00Z' },
  { key: 'ui_222222222222', client: 'mcp-inspector', version: '0.13.2', first: '2026-10-02T10:00:00Z', last: '2026-10-04T10:30:00Z' },
  { key: 'ui_legacy000000', client: 'python-httpx', version: '0.27.0', first: '2026-10-10T10:00:00Z', last: '2026-10-14T07:30:00Z' },
];

const DIMENSIONS = ['key', 'method', 'client', 'instance', 'result', 'type'];
const VALID = {
  key: /^[a-z0-9][a-z0-9_-]*$/,
  method: /^[A-Za-z0-9_/]{1,64}$/,
  client: /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/,
  instance: /^[A-Za-z0-9._-]{1,64}$/,
  result: /^[a-z0-9_]{1,64}$/,
  type: /^(?:call|request|limited|rejected)$/,
};
const PROTOCOL = [
  'initialize', 'ping', 'tools/list', 'tools/call', 'response', 'notifications/initialized', 'notifications/cancelled', 'notifications/progress',
  'notifications/roots/list_changed', 'resources/list', 'resources/read', 'resources/templates/list', 'resources/subscribe', 'resources/unsubscribe',
  'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel', 'other', 'invalid',
];
const TYPES = ['call', 'request', 'limited', 'rejected'];
// This sets what the groups of the series are ranked by.
const ORDERS = ['requests', 'errors', 'refused', 'calls', 'bytes'];
// A facet keeps this many rows. A value that a filter picks is never cut.
const FACET_ROWS = 200;
const invalid = (field, reason, message) => ({ status: 400, body: { error_code: 'validation', message, retryable: false, field, reason } });
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
// The server counts whole milliseconds. An average is a whole number. The value 0 is a time under one millisecond.
const average = (total, n) => (n ? Math.round(total / n) : null);
const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
const newest = (list) => (list.length ? iso(Math.max(...list)) : null);

// The answer of the server for the query string of the page is { status, body }.
export function overviewOf(server, params) {
  // The window comes first. An empty window is the default. Then comes a name that is not a parameter (`split` was one, and it is refused now). Then comes the group.
  const window = params.get('window') || server.meta.usage.default_window;
  if (!server.meta.usage.windows.includes(window)) return invalid('window', 'invalid', `window must be one of ${server.meta.usage.windows.join(', ')}`);
  for (const name of new Set(params.keys())) {
    if (!['window', 'group', 'order', 'orders', ...DIMENSIONS].includes(name)) return invalid(name, 'unknown', `unknown parameter: ${name}`);
  }
  const group = params.has('group') ? params.get('group') : 'method';
  if (!DIMENSIONS.includes(group)) return invalid('group', 'invalid', 'group must be key, method, client, instance, result or type');
  const order = params.has('order') ? params.get('order') : 'requests';
  if (!ORDERS.includes(order)) return invalid('order', 'invalid', 'order must be requests, errors, refused, calls or bytes');
  // The orders of the rankings. A repeated value counts once, and the first one keeps its place. There are at most 5 orders. The number is checked before the values.
  const orders = [...new Set(params.getAll('orders'))];
  if (orders.length > ORDERS.length) return invalid('orders', 'too_many', `orders takes at most ${ORDERS.length} values`);
  if (orders.some((name) => !ORDERS.includes(name))) return invalid('orders', 'invalid', 'orders must be requests, errors, refused, calls or bytes');
  // Each dimension is checked. A repeated value counts once, and the first one stays. There are at most 20 values, and each value must be valid.
  const filters = {};
  for (const dimension of DIMENSIONS) {
    const values = [...new Set(params.getAll(dimension))];
    if (values.length > 20) return invalid(dimension, 'too_many', `${dimension} takes at most 20 values`);
    if (values.some((value) => !VALID[dimension].test(value))) return invalid(dimension, 'invalid', `${dimension} is not valid`);
    filters[dimension] = values;
  }

  const { step, points, stepMs, from } = geometry(window);
  const names = new Map([...server.keys, ...server.deleted, ...server.elsewhere].map((owner) => [owner.id, owner.name]));
  const clientOf = (c) => c.client || 'unknown';
  const valueOf = (dimension, c) => (dimension === 'key' ? c.key : dimension === 'type' ? c.kind : dimension === 'client' ? clientOf(c) : dimension === 'instance' ? c.instance || 'chdash-0' : c[dimension]);
  // These are the cells of the window that every filter except `skip` lets through.
  const inWindow = server.cells.filter((c) => c.at >= from && c.at < from + points * stepMs);
  const cut = (skip) => inWindow.filter((c) => DIMENSIONS.every((dimension) => dimension === skip || !filters[dimension].length || filters[dimension].includes(valueOf(dimension, c))));
  const isCall = (c) => c.kind === 'call';
  const errorOf = (c) => c.result !== 'ok' && (c.kind === 'call' || c.kind === 'request');
  // A refused request is the rate limit (429), or a refusal before the message was read (400, 413, 415).
  const refusedOf = (c) => c.kind === 'limited' || c.kind === 'rejected';
  const figures = (list) => {
    const calls = list.filter(isCall);
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

  // The totals and the series use every filter. A step has the requests and the bytes of every request, the errors, the calls and the time of the calls.
  // These come from the cells that count them.
  const all = cut(null);
  // `keys` lists the keys that exist. These are the keys of this instance, and the keys that only another instance knows. The deleted keys are not listed.
  const totals = { ...figures(all), active_keys: distinct(all, 'key'), keys: server.keys.length + server.elsewhere.length };
  const metric = (list, pick, keep = () => true) => {
    const out = new Array(points).fill(0);
    for (const c of list) if (keep(c)) out[Math.floor((c.at - from) / stepMs)] += pick(c);
    return out;
  };
  const seriesOf = (list) => ({
    requests: metric(list, (c) => c.count),
    errors: metric(list, (c) => c.count, errorOf),
    refused: metric(list, (c) => c.count, refusedOf),
    calls: metric(list, (c) => c.count, isCall),
    duration_ms_sum: metric(list, (c) => c.ms, isCall),
    bytes: metric(list, (c) => c.bytes),
  });
  const labelOf = (id) => (group === 'key' ? names.get(id) || id : id);
  const groupIds = filters[group].length ? filters[group] : [...new Set(all.map((c) => valueOf(group, c)))];
  // A group is ranked by its total of the metric that an order names.
  const rankOf = (list, by) => sum(by === 'errors' ? list.filter(errorOf) : by === 'refused' ? list.filter(refusedOf) : by === 'calls' ? list.filter(isCall) : list,
    (c) => (by === 'bytes' ? c.bytes : c.count));
  const built = groupIds.map((id) => ({ id, list: all.filter((c) => valueOf(group, c) === id) }));
  const lineOf = ({ id, list }) => ({ id, label: labelOf(id), total: sum(list, (c) => c.count), ...seriesOf(list) });
  // The groups of a ranking, and the total of the others. The 8 groups with the most of the metric are listed. When two totals are equal, the smaller id comes first.
  // A group that has none of the metric is in `rest`, even when there are fewer than 8 groups. The values that are picked are listed in their order, when the dimension is filtered.
  const rankingOf = (by) => {
    if (filters[group].length) return { groups: built.map(lineOf), rest: { groups: 0, total: 0, ...seriesOf([]) } };
    const ordered = built.map((item) => ({ item, rank: rankOf(item.list, by) })).sort((a, b) => b.rank - a.rank || (a.item.id < b.item.id ? -1 : 1));
    const shown = ordered.filter((entry, i) => i < 8 && entry.rank > 0).map((entry) => entry.item);
    const folded = ordered.filter((entry, i) => !(i < 8 && entry.rank > 0)).map((entry) => entry.item);
    return {
      groups: shown.map(lineOf),
      rest: { groups: folded.length, total: sum(folded, (item) => sum(item.list, (c) => c.count)), ...seriesOf(folded.flatMap((item) => item.list)) },
    };
  };
  const series = {
    step,
    t: Array.from({ length: points }, (_, i) => iso(from + i * stepMs)),
    ...rankingOf(order),
    ...(orders.length ? { rankings: Object.fromEntries(orders.map((by) => [by, rankingOf(by)])) } : {}),
  };

  // The facets use every filter except their own. The rows have requests, or they are values that a filter picks. The rows with the most requests come first.
  const omitted = {};
  const facet = (dimension, name, byOf, build, order) => {
    const list = cut(dimension);
    const ids = new Set([...list.map(byOf), ...filters[dimension]]);
    const rows = [...ids].map((id) => build(id, list.filter((c) => byOf(c) === id))).sort(order);
    const kept = rows.filter((row, i) => i < FACET_ROWS || filters[dimension].includes(row[name]));
    omitted[dimension] = rows.length - kept.length;
    return kept;
  };
  const keys = facet('key', 'id', (c) => c.key, (id, list) => {
    const owner = server.keys.find((k) => k.id === id);
    const gone = server.deleted.find((k) => k.id === id);
    const apart = server.elsewhere.find((k) => k.id === id);
    const own = server.cells.filter((c) => c.key === id);
    return {
      id, name: names.get(id) || id, host: owner && owner.hosts.length === 1 ? owner.hosts[0] : (gone || apart) ? (gone || apart).host : '',
      source: (owner || gone || apart || { source: '' }).source,
      deleted_at: gone ? gone.deleted_at : null, elsewhere: !owner && !gone && !!apart, ...figures(list), last_used_at: newest(own.map((c) => c.at)),
    };
  }, (a, b) => b.requests - a.requests || (a.name < b.name ? -1 : 1));
  // A method row has times when it has requests. The refused requests count too. A method row has no times when a filter picks a method that nothing matches.
  // The kind comes from the name. A tool is a call. `unread` is refused. A name from the vocabulary of the protocol is a request.
  const methods = facet('method', 'method', (c) => c.method, (id, list) => ({
    method: id, kind: PROTOCOL.includes(id) ? 'request' : id === 'unread' ? 'refused' : 'call', requests: sum(list, (c) => c.count), errors: sum(list.filter(errorOf), (c) => c.count),
    duration_ms_avg: average(sum(list, (c) => c.ms), sum(list, (c) => c.count)), duration_ms_max: list.length ? Math.max(...list.map((c) => c.max)) : null,
    rows: sum(list, (c) => c.rows), bytes: sum(list, (c) => c.bytes), keys: distinct(list, 'key'),
  }), (a, b) => b.requests - a.requests || (a.method < b.method ? -1 : 1));
  const results = facet('result', 'result', (c) => c.result, (id, list) => ({ result: id, count: sum(list, (c) => c.count), keys: distinct(list, 'key') }),
    (a, b) => b.count - a.count || (a.result < b.result ? -1 : 1));
  const typeList = cut('type');
  const types = TYPES.map((type) => ({ type, requests: sum(typeList.filter((c) => c.kind === type), (c) => c.count) }));
  // A client row has the same figures as a key row. It also has its versions, the latest first, five at most, and its last sight. These come from what the keys kept.
  const clients = facet('client', 'client', clientOf, (id, list) => {
    const owners = new Set(list.map((c) => c.key));
    const kept = server.clients.filter((record) => record.client === id && owners.has(record.key)).sort((a, b) => (a.last < b.last ? 1 : -1));
    return { client: id, ...figures(list), keys: owners.size, versions: [...new Set(kept.map((record) => record.version))].slice(0, 5), last_seen_at: kept.length ? kept[0].last : null };
  }, (a, b) => b.requests - a.requests || (a.client < b.client ? -1 : 1));

  // This lists every instance that the server knows, this one first. Each instance has the state of its file and its figures.
  // The figures are zeros when it has no request in the view. The list also has the instances that a filter picks.
  const instanceList = cut('instance');
  const known = server.instances.map((item) => item.instance);
  for (const c of server.cells) if (!known.includes(valueOf('instance', c))) known.push(valueOf('instance', c));
  const instances = [...new Set([...known, ...filters.instance])].map((id) => {
    const info = server.instances.find((item) => item.instance === id);
    const list = instanceList.filter((c) => valueOf('instance', c) === id);
    return { instance: id, status: info ? info.status : known.includes(id) ? 'ok' : 'unknown', reason: info ? info.reason : '', written_at: info ? info.written_at : null, ...figures(list), keys: distinct(list, 'key') };
  });
  omitted.instance = 0;

  return {
    status: 200,
    body: {
      ...usageWindow(server, window), group, order, filters, totals, series, keys, methods, results, types, clients, instances,
      omitted: { keys: omitted.key, methods: omitted.method, results: omitted.result, clients: omitted.client, instances: omitted.instance },
    },
  };
}

// The server keeps the meta and the keys in memory. It records every call. `errors` makes the next call of a route fail.
export function newServer(over = {}) {
  const server = { keys: KEYS(), calls: [], errors: {}, delay: {}, version: { mcp: { enabled: true } }, access: reachOf, summary: summaryOf,
    usageOf: USAGE_OF, deleted: DELETED(), elsewhere: [], instances: INSTANCES(), usage: usageSummaryOf, keyUsage: keyUsageOf, cost: costOf, cells: CELLS(), clients: CLIENTS(), overview: overviewOf, ...over };
  server.meta = { ...structuredClone(META), ...(over.meta || {}) };
  return server;
}

export const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });

export async function install(page, server) {
    // The shell is served at /mcp-integration only when the instance has MCP on. Otherwise the request is passed to
    // the static file of the shell. The document then shows that file under the address of the page.
  await page.route('**/mcp-integration', (route) => route.continue({ url: new URL('/static/mcp.html', route.request().url()).href }));
  // The Usage page keeps the window, the group and the filters in its address.
  await page.route(/\/mcp-integration\/usage\/?(\?.*)?$/, (route) => route.continue({ url: new URL('/static/mcpusage.html', route.request().url()).href }));
  await page.route('**/api/version', async (route) => {
    // A test can end while this request is still in flight. The response is then disposed, so nothing is left to answer.
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
    // The usage is off (mcp.usage.enabled). Its three routes answer 404 not_enabled. The cost of a key does not depend on the usage.
    const usageRoute = method === 'GET' && (path === '/usage' || path === '/usage/overview' || /^\/keys\/[^/]+\/usage$/.test(path));
    if (usageRoute && !server.meta.usage.enabled) return json(route, 404, { error_code: 'not_enabled', message: 'The usage of the keys is off (mcp.usage.enabled is false).', retryable: false });
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
    // A person adopts an orphan key (docs/mcp.md, "Adoption of a key"): the person becomes the creator; the secret does not change.
    const adopt = method === 'POST' ? /^\/keys\/([^/]+)\/adopt$/.exec(path) : null;
    if (adopt) {
      const owner = server.keys.find((k) => k.id === decodeURIComponent(adopt[1]));
      if (!owner) return json(route, 404, { error_code: 'not_found', message: 'No such key.', retryable: false });
      if (!owner.orphan) return json(route, 409, { error_code: 'not_adoptable', message: 'the creator of the key still holds its actions', retryable: false });
      Object.assign(owner, { creator: server.adopter || 'heir', orphan: null });
      return json(route, 200, { key: owner });
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
