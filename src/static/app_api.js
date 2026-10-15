import { state } from "./app_state.js";
import { util } from "./app_util.js";

function resolveUrl(path) {
  const raw = String(path || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return raw;
  if (typeof window.__chdashUrl === "function") return window.__chdashUrl(raw);
  const base = String(window.__CHDASH_BASE_PATH__ || "/");
  return `${base}${raw.replace(/^\/+/, "")}`;
}

function requestHeaders(base = {}) {
  return { ...base };
}

// Whether the API answers: state.apiOnline, and chdash:api-online (detail.online) when it changes. The header's host
// picker and the Run buttons follow on their own (app_header.js, app_run.js).
function setApiOnline(online) {
  const next = online !== false;
  if (state.apiOnline === next) return;
  state.apiOnline = next;
  window.dispatchEvent(new CustomEvent("chdash:api-online", { detail: { online: next } }));
}

// The answer of a response: its JSON, `null` when the body is empty, and `undefined` when it is
// not JSON (a page of a proxy: its text is kept for the error).
async function readBody(response) {
  const text = await response.text();
  if (!text) return { payload: {}, text };
  try {
    return { payload: JSON.parse(text), text };
  } catch {
    return { payload: undefined, text };
  }
}

function notJsonError(response, text) {
  const contentType = String(response.headers.get("content-type") || "");
  const err = new Error(`API returned a non-JSON response (${contentType || "unknown content type"}). Check the application/subpath routing.`);
  err.code = "invalid_api_response";
  err.responseText = text.slice(0, 240);
  return err;
}

function apiError(norm, fallback) {
  const err = new Error(util.buildApiErrorText(norm, fallback));
  err.code = norm.error_code;
  err.payload = norm;
  return err;
}

// A request the caller aborted (its AbortSignal, e.g. util.latest): no
// network error, no offline flag; util.isAbort(error) is true.
function abortError() {
  const err = new Error("The request was aborted.");
  err.name = "AbortError";
  err.code = "aborted";
  return err;
}

// A request that got no answer in time: a network failure that the caller
// can tell from its own abort (code "timeout", not util.isAbort).
function timeoutError(ms) {
  const err = new Error(`The server did not answer within ${Math.round(ms / 1000)} s.`);
  err.name = "TimeoutError";
  err.code = "timeout";
  return err;
}

// Every request ends: no answer within this time is an error, not a spinner
// that never stops. A call that may run longer says so (timeoutMs).
const DEFAULT_TIMEOUT_MS = 30000;

// The one request path of every api.* call: the request headers, the
// online flag, a JSON answer and one error shape (Error with .code,
// .payload, and for an HTTP error .status and .body, the answer as sent).
// options: { method, body (JSON-encoded), headers (added, e.g. If-Match),
// signal, timeoutMs (default 30 s; 0: none) }.
// The timeout covers the headers and the body of the answer. A timeout does
// not turn the online flag off (one slow call is not a dead server).
async function request(path, { method = "GET", body, headers, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (signal?.aborted) throw abortError();
  // One controller cuts the fetch: the caller's signal and the timer both abort it.
  const cut = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => cut.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; cut.abort(); }, timeoutMs) : 0;
  const failed = (e) => {
    if (signal?.aborted) return abortError();
    if (timedOut) return timeoutError(timeoutMs);
    if (e?.name === "AbortError") return abortError();
    return null;
  };
  try {
    let response;
    try {
      response = await fetch(resolveUrl(path), {
        method,
        headers: requestHeaders({ ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(headers || {}) }),
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: cut.signal,
      });
    } catch (e) {
      const known = failed(e);
      if (known) throw known;
      setApiOnline(false);
      throw apiError(util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." }), "Network error.");
    }
    let read;
    try {
      read = await readBody(response);
    } catch (e) {
      const known = failed(e);
      if (known) throw known;
      throw apiError(util.normalizeApiErrorPayload(null, { error_code: "network_error", message: "The answer was cut." }), "Network error.");
    }
    // Online: the transport answered with something the application sent. A 5xx with no JSON of ours is a proxy in
    // front of a stopped server.
    setApiOnline(response.status < 500 || (read.payload !== null && typeof read.payload === "object" && Object.keys(read.payload).length > 0));
    if (!response.ok) {
      // The status first: an HTML page of a proxy (413, 502, 504) is an error with its status, not "invalid_api_response".
      const object = read.payload && typeof read.payload === "object" ? read.payload : {};
      const err = apiError(util.buildApiErrorFromResponse(response.status, object), `Request failed with status ${response.status}`);
      err.status = response.status;
      err.body = read.payload === undefined ? { text: read.text.slice(0, 240) } : read.payload;
      throw err;
    }
    if (read.payload === undefined) throw notJsonError(response, read.text);
    return read.payload;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

const getJson = (url, { signal, timeoutMs } = {}) => request(url, { signal, timeoutMs });
const postJson = (url, body, { signal, timeoutMs } = {}) => request(url, { method: "POST", body, signal, timeoutMs });

async function getMeta(hostId, types, scope = null, { signal, timeoutMs } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const arr = Array.isArray(types) ? types.filter((x) => x) : [];
  const typesCsv = arr.length ? arr.map((x) => String(x)).join(",") : "keywords";
  const query = new URLSearchParams({ host_id: String(hostId), types: typesCsv });
  if (scope && scope.database != null) query.set("database", String(scope.database));
  if (scope && scope.table != null) query.set("table", String(scope.table));
  return getJson(`api/meta?${query.toString()}`, { signal, timeoutMs });
}

// The hosts and their health (the host picker, app_ui.js).
const getHosts = ({ signal } = {}) => getJson("api/hosts", { signal });

// The version and the feature flags (ns.features, app_ui.js).
const getVersion = ({ signal } = {}) => getJson("api/version", { signal });

async function getExplorerCatalog(hostId, database = "", refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (database) query.set("database", String(database));
  if (refresh) query.set("refresh", "1");
  return getJson(`api/explorer/catalog?${query.toString()}`, { signal });
}

async function getExplorerTable(hostId, database, table, refresh = false, { signal } = {}) {
  if (!hostId || !database || !table) throw new Error("Explorer table scope is incomplete.");
  const query = new URLSearchParams({ host_id: String(hostId), database: String(database), table: String(table) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/explorer/table?${query.toString()}`, { signal });
}

async function getExplorerTableData(hostId, database, table, limit = 100, { signal } = {}) {
  if (!hostId || !database || !table) throw new Error("Explorer table scope is incomplete.");
  return postJson("api/explorer/table/data", {
    host_id: String(hostId),
    database: String(database),
    table: String(table),
    limit: Math.max(1, Math.min(500, Number(limit) || 100)),
  }, { signal });
}

async function getExplorerGraph(hostId, options = {}, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  const database = String(options.database || "");
  const focusDatabase = String(options.focusDatabase || "");
  const focusTable = String(options.focusTable || "");
  if (database) query.set("database", database);
  if (focusDatabase && focusTable) {
    query.set("focus_database", focusDatabase);
    query.set("focus_table", focusTable);
    query.set("depth", String(Math.max(0, Math.min(8, Number(options.depth) || 0))));
    for (const item of Array.isArray(options.expand) ? options.expand.slice(0, 64) : []) query.append("expand", String(item));
  }
  query.set("mode", options.mode === "physical" ? "physical" : "logical");
  if (options.includeSystem === true) query.set("include_system", "1");
  query.set("include_non_storing", options.includeNonStoring === false ? "0" : "1");
  if (options.refresh === true) query.set("refresh", "1");
  return getJson(`api/explorer/graph?${query.toString()}`, { signal });
}

// SELECT / source / route of one graph object, for the graph side panel.
async function getExplorerGraphDefinition(hostId, database, table, { signal } = {}) {
  if (!hostId || !database || !table) throw new Error("Explorer graph object scope is incomplete.");
  const query = new URLSearchParams({ host_id: String(hostId), database: String(database), table: String(table) });
  return getJson(`api/explorer/graph/definition?${query.toString()}`, { signal });
}

async function getTracesMeta(hostId, { signal } = {}) {
  const query = new URLSearchParams();
  if (hostId) query.set("host_id", String(hostId));
  return getJson(`api/traces/meta?${query.toString()}`, { signal });
}

function traceQuery(hostId, filters = {}) {
  const query = new URLSearchParams();
  if (hostId) query.set("host_id", String(hostId));
  for (const key of ["start_ms", "end_ms", "service", "operation", "status", "service_not", "operation_not", "status_not", "tag", "tag_not", "tag_exists", "tag_missing", "tag_scope", "tag_key", "tag_value", "min_duration_ms", "max_duration_ms", "limit", "align_buckets", "bucket_origin_ms", "charts", "scope", "key", "rows", "t0", "t1", "d0", "d1", "baseline", "sample"]) {
    const value = filters?.[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item != null && String(item) !== "") query.append(key, String(item));
    } else if (value != null && String(value) !== "") {
      query.set(key, String(value));
    }
  }
  return query;
}

async function prefillTraces(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/prefill?${traceQuery(hostId, filters).toString()}`, { signal });
}

async function searchTraces(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/search?${traceQuery(hostId, filters).toString()}`, { signal });
}

// Services and the calls between them (sampled on wide windows).
async function getTraceServiceMap(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/service_map?${traceQuery(hostId, filters).toString()}`, { signal });
}

async function getTraceAnalytics(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/analytics?${traceQuery(hostId, filters).toString()}`, { signal });
}

// Duration heatmap (traces per time bucket x log duration row) and the
// attribute comparison of a box of it (app_trace_heatmap.js).
async function getTraceHeatmap(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/heatmap?${traceQuery(hostId, filters).toString()}`, { signal });
}

async function getTraceDeltas(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/deltas?${traceQuery(hostId, filters).toString()}`, { signal });
}

// Attribute keys / one key's values of the spans matching the filters
// (bounded and cached server-side; "estimated" when a cap stopped the scan).
async function getTraceFacets(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/facets?${traceQuery(hostId, filters).toString()}`, { signal });
}

async function getTraceFacetValues(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/facet_values?${traceQuery(hostId, filters).toString()}`, { signal });
}

// Services view (RED metrics of entry spans): the search filters plus
// detail (one service's drill-down), scope (entry | root) and exact.
function traceServicesQuery(hostId, filters = {}) {
  const query = traceQuery(hostId, filters);
  for (const key of ["detail", "exact"]) {
    const value = filters?.[key];
    if (value != null && String(value) !== "") query.set(key, String(value));
  }
  return query;
}

async function getTraceServices(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/services?${traceServicesQuery(hostId, filters).toString()}`, { signal });
}

async function getTraceServicesDb(hostId, filters = {}, { signal } = {}) {
  return getJson(`api/traces/services/db?${traceServicesQuery(hostId, filters).toString()}`, { signal });
}

async function getTrace(hostId, traceId, { signal } = {}) {
  if (!traceId) throw new Error("No trace selected.");
  const query = new URLSearchParams({ trace_id: String(traceId) });
  if (hostId) query.set("host_id", String(hostId));
  return getJson(`api/traces/trace?${query.toString()}`, { signal });
}

function optionalParams(hostId, params) {
  const query = new URLSearchParams();
  if (hostId) query.set("host_id", String(hostId));
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && String(value) !== "") query.set(key, String(value));
  }
  return query;
}

// Spans of other traces whose links point to this trace (or span).
async function getTraceLinkedFrom(hostId, params = {}, { signal } = {}) {
  return getJson(`api/traces/linked_from?${optionalParams(hostId, params).toString()}`, { signal });
}

// Spans around a span's start time (surrounding context).
async function getTraceContext(hostId, params = {}, { signal } = {}) {
  return getJson(`api/traces/context?${optionalParams(hostId, params).toString()}`, { signal });
}

// Logs of one trace: the trace bounds (epoch ns) and its services bound
// the lookup; span_id narrows it to one span.
async function getTraceLogs(hostId, { traceId, startNs, endNs, services = [], spanId = "", limit = 0 } = {}, { signal } = {}) {
  if (!traceId) throw new Error("No trace selected.");
  const query = new URLSearchParams({ trace_id: String(traceId), start_ns: String(startNs), end_ns: String(endNs) });
  if (hostId) query.set("host_id", String(hostId));
  for (const service of services) if (service) query.append("service", String(service));
  if (spanId) query.set("span_id", String(spanId));
  if (limit) query.set("limit", String(limit));
  return getJson(`api/traces/logs?${query.toString()}`, { signal });
}

// System page, Overview: the background activity (merges, mutations,
// replication, Distributed queues) and the Keeper session status.
async function getSystemActivity(hostId, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/activity?${query.toString()}`, { signal });
}

async function getSystemKeeper(hostId, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/keeper?${query.toString()}`, { signal });
}

// System page, Overview: the server tiles, topology,
// replication summary, detected system logs).
async function getSystemOverview(hostId, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/overview?${query.toString()}`, { signal });
}

// System page, Overview: the performance history of a
// window (whole milliseconds; the server picks the step).
async function getSystemSeries(hostId, { fromMs, toMs }, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId), from_ms: String(Math.floor(fromMs)), to_ms: String(Math.ceil(toMs)) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/series?${query.toString()}`, { signal });
}

// System page: the disks, storage policies and
// bytes by disk and database (the server caches them 60 s).
async function getSystemDisks(hostId, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/disks?${query.toString()}`, { signal });
}

// The disks' growth over a window (the series panel disk_growth): used
// bytes per disk, trend and days until full, written and moved bytes.
async function getSystemDiskGrowth(hostId, { fromMs, toMs }, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId), panel: "disk_growth", from_ms: String(Math.floor(fromMs)), to_ms: String(Math.ceil(toMs)) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/series?${query.toString()}`, { signal });
}

// System page, Queries: the top query shapes of a window
// (allowlisted sort / kind; hideChdash drops the system account's queries).
// errors: all | with | without; user: one user's queries ("" for all).
async function getSystemQueries(hostId, { fromMs, toMs, sort, kind, errors, user, database, table, hideChdash = true }, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId), from_ms: String(Math.floor(fromMs)), to_ms: String(Math.ceil(toMs)) });
  if (sort) query.set("sort", String(sort));
  if (kind) query.set("kind", String(kind));
  if (errors && errors !== "all") query.set("errors", String(errors));
  if (user) query.set("user", String(user));
  if (database) query.set("database", String(database));
  if (table) query.set("table", String(table));
  query.set("hide_chdash", hideChdash ? "1" : "0");
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/queries?${query.toString()}`, { signal });
}

// One query shape (its normalized_query_hash, a decimal string): timeline,
// its 20 slowest / latest / largest runs and the latest run's text.
async function getSystemQuery(hostId, hash, { fromMs, toMs, order, hideChdash = true }, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  if (!/^\d{1,20}$/.test(String(hash || ""))) throw new Error("Invalid query hash.");
  const query = new URLSearchParams({ host_id: String(hostId), from_ms: String(Math.floor(fromMs)), to_ms: String(Math.ceil(toMs)) });
  if (order) query.set("order", String(order));
  query.set("hide_chdash", hideChdash ? "1" : "0");
  if (refresh) query.set("refresh", "1");
  return getJson(`api/system/queries/${encodeURIComponent(String(hash))}?${query.toString()}`, { signal });
}

async function getExplorerFunctions(hostId, refresh = false, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const query = new URLSearchParams({ host_id: String(hostId) });
  if (refresh) query.set("refresh", "1");
  return getJson(`api/explorer/functions?${query.toString()}`, { signal });
}

// One entry for each text of `sqls` (POST api/format answers a status for each statement, so one that fails does not fail the
// others): { status: "formatted", formatted } or { status: "error" | "skipped", error }, `error` the payload of the API's error
// ({ error_code, message, index, clickhouse }, util.normalizeApiErrorPayload). A request that fails as a whole (an unknown host,
// a body that is refused, the network) rejects.
async function formatSqlsEach(hostId, sqls, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  if (!Array.isArray(sqls)) throw new Error("formatSqls expects an array.");

  const payload = await postJson("api/format", { host_id: hostId, sqls }, { signal });

  if (!payload || !Array.isArray(payload.results) || payload.results.length !== sqls.length) {
    const norm = util.normalizeApiErrorPayload(payload, { error_code: "invalid_json", message: "Invalid format response." });
    const msg = util.buildApiErrorText(norm, "Invalid format response.");
    const err = new Error(msg);
    err.code = norm.error_code;
    err.payload = norm;
    throw err;
  }

  return payload.results.map((item, index) => {
    if (item && item.status === "formatted") return { status: "formatted", formatted: String(item.formatted_sql || "") };
    const status = item && item.status === "skipped" ? "skipped" : "error";
    return { status, error: util.normalizeApiErrorPayload(item && item.error, { error_code: "format_failed", message: "Format failed.", index }) };
  });
}

// The Error of a statement that was not formatted: the message, the code and the payload of the API, which `index` places in the text.
function formatFailure(item) {
  const norm = item.error;
  const err = new Error(util.buildApiErrorText(norm, "Format failed."));
  err.code = norm.error_code;
  err.payload = norm;
  return err;
}

// The formatted texts, in order. It rejects with the first statement that was not formatted (the others of the batch were).
async function formatSqls(hostId, sqls, { signal } = {}) {
  const items = await formatSqlsEach(hostId, sqls, { signal });
  const failed = items.find((item) => item.status !== "formatted");
  if (failed) throw formatFailure(failed);
  return items.map((item) => item.formatted);
}

async function runSql(hostId, sql, mode = "normal", { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  const runMode = String(mode || "normal").toLowerCase();
  if (runMode !== "normal" && runMode !== "profiling") throw new Error("Invalid run mode.");
  const payload = await postJson("api/query/run", { host_id: hostId, sql: String(sql || ""), mode: runMode }, { signal });

  if (!payload || typeof payload.query_id !== "string" || typeof payload.stream_url !== "string") {
    throw new Error("Invalid run response.");
  }

  return {
    queryId: payload.query_id,
    cancelToken: payload.cancel_token ? String(payload.cancel_token) : null,
    streamUrl: resolveUrl(payload.stream_url),
    runMode: payload.run_mode ? String(payload.run_mode) : runMode,
    analysisAvailable: payload.analysis_available === true,
  };
}

// The analysis and the export handshake read ClickHouse logs and may take longer than a page read.
const ANALYSIS_TIMEOUT_MS = 120000;

async function analyzeQuery(hostId, queryId, options = {}) {
  if (!hostId) throw new Error("No host selected.");
  if (!queryId) throw new Error("No query selected for analysis.");
  const payload = await postJson("api/query/analysis", {
    host_id: String(hostId),
    query_id: String(queryId),
    ...(options.includeOriginalTrace === true ? { include_original_trace: true } : {}),
  }, { signal: options.signal, timeoutMs: ANALYSIS_TIMEOUT_MS });
  if (!payload || typeof payload !== "object") throw new Error("Invalid profiling response.");
  return payload;
}

async function getQueryExecution(hostId, queryId, { signal } = {}) {
  if (!hostId) throw new Error("No host selected.");
  if (!queryId) throw new Error("No query selected for execution statistics.");
  const query = new URLSearchParams({ host_id: String(hostId), query_id: String(queryId) });
  return getJson(`api/query/execution?${query.toString()}`, { signal });
}

async function cancelQuery(cancelToken, { signal } = {}) {
  if (!cancelToken) throw new Error("No active query to cancel.");
  const payload = await postJson("api/query/cancel", { cancel_token: String(cancelToken) }, { signal });
  return !!(payload && payload.ok);
}

// A route's query string from the caller's parameters: a URLSearchParams
// as built, or an object (arrays repeat the key; null and "" are left out).
function queryOf(params) {
  if (params instanceof URLSearchParams) return params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      for (const item of value) if (item != null && String(item) !== "") query.append(key, String(item));
    } else if (value != null && String(value) !== "") {
      query.set(key, String(value));
    }
  }
  return query;
}

// Logs explorer routes: api/logs/{meta,search,histogram,context,patterns,services}.
async function getLogs(endpoint, params, { signal } = {}) {
  const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
  return getJson(`api/logs/${endpoint}?${query.toString()}`, { signal });
}

// Spans mode of the trace search (app_trace_spans.js): one row per span,
// keyset pages by cursor; and one span's full record.
async function searchTraceSpans(params, { signal } = {}) {
  return getJson(`api/traces/spans?${queryOf(params).toString()}`, { signal });
}

async function getTraceSpan(hostId, { traceId, spanId, timestampNs } = {}, { signal } = {}) {
  if (!traceId || !spanId) throw new Error("No span selected.");
  const query = queryOf({ host_id: hostId, trace_id: traceId, span_id: spanId, timestamp_ns: timestampNs });
  return getJson(`api/traces/span?${query.toString()}`, { signal });
}

// Metrics browser routes (app_metrics.js, docs/metrics.md): the enabled
// kinds, the catalog of a window, a panel's series and exemplars, and its
// attribute keys (or one key's values with `key`).
async function getMetricsMeta(params, { signal } = {}) {
  return getJson(`api/metrics/meta?${queryOf(params).toString()}`, { signal });
}

async function getMetricsCatalog(params, { signal } = {}) {
  return getJson(`api/metrics/catalog?${queryOf(params).toString()}`, { signal });
}

async function getMetricsSeries(params, { signal } = {}) {
  return getJson(`api/metrics/series?${queryOf(params).toString()}`, { signal });
}

async function getMetricsExemplars(params, { signal } = {}) {
  return getJson(`api/metrics/exemplars?${queryOf(params).toString()}`, { signal });
}

async function getMetricsAttributes(params, { signal } = {}) {
  return getJson(`api/metrics/attributes?${queryOf(params).toString()}`, { signal });
}

// --- MCP integration (docs/mcp.md, app_page_mcp.js) -------------------------------
// The one place that knows the JSON of /api/mcp/*: the page's modules read the shapes
// normalized here and never the raw answers, so a change of the server's JSON is fixed here.
//   getMcpMeta()                  the state, endpoint, hosts, tool groups, tools and limits ({ enabled: false } when off)
//   getMcpKeys()                  [key]
//   createMcpKey(input)           { key, secret }   (the secret comes once: no call gives it again)
//   getMcpKeyAccess(id, {refresh})  the data that a key reaches: the tables of the MCP user of each host, cut by the key's patterns
//   getMcpAccessSummary({refresh})  for each key, how many databases and tables it reaches (a Map by key id)
//   getMcpUsageSummary({window})  what each key did in a window: { keys: Map by key id, deleted: [the deleted keys that keep usage] }
//   getMcpKeyUsage(id, {window})  what one key did: totals, one point for each hour or day, tools, results, clients
//   getMcpUsageOverview({window, split, filters})  what every key did, cut by key, method, result and type (the Usage tab): totals,
//                                 a stacked series by `split`, one table for each of the four, the clients
//   getMcpKeyCost(id, {window, refresh})  what the statements of a key cost ClickHouse (read from system.query_log)
//   deleteMcpKey(id)              id
// A failed call rejects with an Error that carries err.mcp = { status, code, message, field, reason }
// (the answer's `error`, `message`, `field` and `reason`; `field` without a position suffix: "tools[1]" is "tools").
const mcpText = (value) => (typeof value === "string" ? value : "");
const mcpList = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : []);
const mcpLimit = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);
// A count of the usage or of the cost (a JSON number; a string of digits is read too). 0 when absent.
const mcpCount = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : 0);
// An ISO time of the server, as milliseconds; null when absent.
const mcpTime = (value) => {
  const ms = typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

// What a key of a host can ask for at most, and what binds it: "mcp" (the configuration of MCP), "clickhouse" (the settings profile of the
// ClickHouse user of the host) or "both" (equal). null when the server did not say.
function normalizeMcpHostLimit(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = mcpLimit(raw.value);
  if (value == null) return null;
  return { value, source: raw.source === "clickhouse" || raw.source === "both" ? raw.source : "mcp" };
}

function normalizeMcpHostUser(raw) {
  const mcp = raw && typeof raw === "object" ? raw : {};
  const state = mcp.state === "ok" || mcp.state === "unavailable" ? mcp.state : "unknown";
  const profile = mcp.profile && typeof mcp.profile === "object" ? mcp.profile : {};
  const caps = mcp.limits && typeof mcp.limits === "object" ? mcp.limits : {};
  return {
    user: mcpText(mcp.user),
    state,
    error: mcpText(mcp.error),
    readsNothing: mcp.reads_nothing === true,
    // The settings profile of the MCP user (readonly, and the limits that it sets: 0 = none).
    profile: {
      known: profile.known === true,
      readonly: Number(profile.readonly) || 0,
      maxExecutionTime: Number(profile.max_execution_time) || 0,
      maxResultRows: Number(profile.max_result_rows) || 0,
    },
    limits: { maxRows: normalizeMcpHostLimit(caps.max_rows), timeoutSeconds: normalizeMcpHostLimit(caps.timeout_seconds) },
    unavailableTools: (Array.isArray(mcp.unavailable_tools) ? mcp.unavailable_tools : []).map((item) => ({
      tool: mcpText(item?.tool),
      // Who lacks the grants: "MCP user" or "system user", and its name.
      role: mcpText(item?.role) || "MCP user",
      user: mcpText(item?.user),
      grants: mcpList(item?.grants),
      statement: mcpText(item?.statement),
    })).filter((item) => item.tool),
  };
}

function normalizeMcpMeta(raw) {
  const meta = raw && typeof raw === "object" ? raw : {};
  if (meta.enabled !== true) return { enabled: false };
  const limits = meta.limits && typeof meta.limits === "object" ? meta.limits : {};
  const can = meta.can_manage === true;
  return {
    enabled: true,
    endpointPath: mcpText(meta.endpoint_path) || "/mcp",
    authHeader: mcpText(meta.auth_header),
    storageConfigured: meta.storage_configured === true,
    manageFromUi: meta.manage_from_ui !== false,
    canManage: can,
    protocolVersions: mcpList(meta.protocol_versions),
    hosts: (Array.isArray(meta.hosts) ? meta.hosts : []).map((host) => ({
      name: mcpText(host?.name),
      label: mcpText(host?.label),
      healthy: host?.healthy === true ? true : host?.healthy === false ? false : null,
      // The MCP user of the host: "ok" (it connects), "unavailable" (it does not: no key can read the host) or
      // "unknown" (not checked yet). The tools it cannot serve come with the grant that is missing.
      mcp: normalizeMcpHostUser(host?.mcp),
    })).filter((host) => host.name),
    // The families of permissions, in the order of the page. A group is a row of the server's table: the page
    // draws whatever the server sends.
    toolGroups: (Array.isArray(meta.tool_groups) ? meta.tool_groups : []).map((group) => ({
      id: mcpText(group?.id),
      title: mcpText(group?.title) || mcpText(group?.id),
      note: mcpText(group?.note),
      // The sub-headings of the card of the family (Observability: Traces, Logs, Metrics), in the order of the page.
      sections: (Array.isArray(group?.sections) ? group.sections : []).map((section) => ({ id: mcpText(section?.id), title: mcpText(section?.title) || mcpText(section?.id) })).filter((section) => section.id),
    })).filter((group) => group.id),
    tools: (Array.isArray(meta.tools) ? meta.tools : []).map((tool) => ({
      name: mcpText(tool?.name),
      group: mcpText(tool?.group) || "data",
      section: mcpText(tool?.section),
      description: mcpText(tool?.description),
      needsAllData: tool?.needs_all_data === true,
    })).filter((tool) => tool.name),
    limits: {
      maxRows: mcpLimit(limits.max_rows),
      maxResultBytes: mcpLimit(limits.max_result_bytes),
      queryTimeoutSeconds: mcpLimit(limits.query_timeout_seconds),
      maxSqlBytes: mcpLimit(limits.max_sql_bytes),
      maxMemoryBytes: mcpLimit(limits.max_memory_bytes),
      maxRowsToRead: mcpLimit(limits.max_rows_to_read),
      rateLimitPerMinute: mcpLimit(limits.rate_limit_per_minute),
    },
    namePattern: mcpText(meta.name_pattern) || "^[a-z0-9][a-z0-9_-]{0,31}$",
    usage: normalizeMcpUsageMeta(meta.usage),
  };
}

// Where the usage of the keys is kept (mcp.usage_file, or memory since the start), the windows of its answers, and those of the cost.
function normalizeMcpUsageMeta(raw) {
  const usage = raw && typeof raw === "object" ? raw : {};
  const windows = mcpList(usage.windows);
  return {
    persisted: usage.persisted === true,
    retentionDays: mcpCount(usage.retention_days),
    windows: windows.length ? windows : ["24h"],
    defaultWindow: mcpText(usage.default_window) || (windows.includes("7d") ? "7d" : "24h"),
    since: mcpTime(usage.since),
    costWindows: mcpList(usage.cost_windows),
  };
}

function normalizeMcpKey(raw) {
  const key = raw && typeof raw === "object" ? raw : {};
  return {
    id: mcpText(key.id),
    name: mcpText(key.name),
    source: key.source === "config" ? "config" : "ui",
    secretHint: mcpText(key.secret_hint),
    // What the page shows of the secret: the shape of a UUID, the hint in clear, a bullet for the other characters.
    // The server keeps the hash of a secret only: nothing gives the secret after its creation.
    secretMask: mcpText(key.secret_mask),
    hosts: mcpList(key.hosts),
    tools: mcpList(key.tools),
    databases: mcpList(key.databases),
    maxRows: mcpLimit(key.max_rows),
    timeoutSeconds: mcpLimit(key.timeout_seconds),
    createdAt: mcpText(key.created_at) || null,
  };
}

// The body of a create or an edit: the fields the caller names (camelCase), in the server's names.
function mcpKeyBody(input = {}) {
  const names = { name: "name", hosts: "hosts", tools: "tools", databases: "databases", maxRows: "max_rows", timeoutSeconds: "timeout_seconds" };
  const body = {};
  for (const [from, to] of Object.entries(names)) if (input[from] !== undefined) body[to] = input[from];
  return body;
}

async function mcpRequest(path, options = {}) {
  try {
    return await request(`api/mcp${path}`, options);
  } catch (error) {
    const body = error?.body && typeof error.body === "object" ? error.body : null;
    // The server sends {error_code, message, ...} (docs/operations.md, "Errors").
    const code = body && typeof body.error_code === "string" ? body.error_code : "";
    if (code) {
      error.mcp = {
        status: Number(error.status) || 0,
        code,
        message: mcpText(body.message),
        field: mcpText(body.field).replace(/[[.].*$/, ""),
        reason: mcpText(body.reason),
      };
      error.code = code;
      if (error.mcp.message) error.message = error.mcp.message;
    }
    throw error;
  }
}

// A server without the MCP routes answers 404: the same as MCP turned off.
async function getMcpMeta({ signal } = {}) {
  try {
    return normalizeMcpMeta(await mcpRequest("/meta", { signal }));
  } catch (error) {
    if (error?.status === 404) return { enabled: false };
    throw error;
  }
}

async function getMcpKeys({ signal } = {}) {
  const payload = await mcpRequest("/keys", { signal });
  return (Array.isArray(payload?.keys) ? payload.keys : []).map(normalizeMcpKey);
}

async function createMcpKey(input, { signal } = {}) {
  const payload = await mcpRequest("/keys", { method: "POST", body: mcpKeyBody(input), signal });
  return { key: normalizeMcpKey(payload?.key), secret: mcpText(payload?.secret) };
}

// The data that a key reaches (GET /api/mcp/keys/<id>/access): for each host of the key, the tables that the MCP
// ClickHouse user may read, cut by the patterns of the key.
async function getMcpKeyAccess(id, { refresh = false, signal } = {}) {
  const payload = await mcpRequest(`/keys/${encodeURIComponent(id)}/access${refresh ? "?refresh=1" : ""}`, { signal });
  return {
    id: mcpText(payload?.id),
    allData: payload?.all_data === true,
    patterns: mcpList(payload?.databases),
    hosts: (Array.isArray(payload?.hosts) ? payload.hosts : []).map((host) => ({
      host: mcpText(host?.host),
      label: mcpText(host?.label),
      user: mcpText(host?.user),
      status: host?.status === "ok" ? "ok" : "unavailable",
      error: mcpText(host?.error),
      readableByUser: Number(host?.readable_by_user) || 0,
      excludedByKey: Number(host?.excluded_by_key) || 0,
      databases: (Array.isArray(host?.databases) ? host.databases : []).map((database) => ({
        name: mcpText(database?.name),
        tableCount: Number(database?.table_count) || 0,
        truncated: database?.truncated === true,
        tables: (Array.isArray(database?.tables) ? database.tables : []).map((table) => ({
          name: mcpText(table?.name),
          // "all", or "some" when the user reads some columns only (they are checked when a tool opens the table).
          columns: table?.columns === "all" || table?.columns === "some" ? table.columns : Number(table?.columns) || 0,
        })),
      })),
    })),
  };
}

// How many databases and tables each key reaches (GET /api/mcp/access): what the MCP user of the host of the key may read,
// cut by the patterns of the key. A Map of the key id to { status: "ok" | "unavailable" | "no_host", databases, tables,
// partialTables, host, user, error }. The grants of a host are read once for all its keys.
async function getMcpAccessSummary({ refresh = false, signal } = {}) {
  const payload = await mcpRequest(`/access${refresh ? "?refresh=1" : ""}`, { signal });
  const out = new Map();
  for (const item of Array.isArray(payload?.keys) ? payload.keys : []) {
    const id = mcpText(item?.id);
    if (!id) continue;
    out.set(id, {
      status: item?.status === "ok" ? "ok" : item?.status === "no_host" ? "no_host" : "unavailable",
      host: mcpText(item?.host),
      user: mcpText(item?.user),
      error: mcpText(item?.error),
      databases: Number(item?.databases) || 0,
      tables: Number(item?.tables) || 0,
      partialTables: Number(item?.partial_tables) || 0,
      allData: item?.all_data === true,
    });
  }
  return out;
}

// One line of the usage of a key in a window.
function normalizeMcpUsageLine(item) {
  return {
    id: mcpText(item?.id),
    name: mcpText(item?.name),
    host: mcpText(item?.host),
    source: item?.source === "config" ? "config" : "ui",
    deletedAt: mcpTime(item?.deleted_at),
    requests: mcpCount(item?.requests),
    calls: mcpCount(item?.calls),
    errors: mcpCount(item?.errors),
    rateLimited: mcpCount(item?.rate_limited),
    rejected: mcpCount(item?.rejected),
    firstUsedAt: mcpTime(item?.first_used_at),
    lastUsedAt: mcpTime(item?.last_used_at),
  };
}

// The window of an answer of the usage: its name, from its start to the time of the answer, since when the usage is counted.
const mcpUsageWindow = (payload) => ({
  window: mcpText(payload?.window),
  from: mcpTime(payload?.from),
  to: mcpTime(payload?.to),
  since: mcpTime(payload?.since),
  persisted: payload?.persisted === true,
  retentionDays: mcpCount(payload?.retention_days),
});

// What each key did in a window (GET /api/mcp/usage): `keys` is a Map of the id of a live key to its line; `deleted` the deleted keys that
// still keep usage, the last deletion first.
async function getMcpUsageSummary({ window = "", signal } = {}) {
  const payload = await mcpRequest(`/usage${window ? `?window=${encodeURIComponent(window)}` : ""}`, { signal });
  const keys = new Map();
  const deleted = [];
  for (const item of Array.isArray(payload?.keys) ? payload.keys : []) {
    const line = normalizeMcpUsageLine(item);
    if (!line.id) continue;
    if (line.deletedAt != null) deleted.push(line);
    else keys.set(line.id, line);
  }
  return { ...mcpUsageWindow(payload), keys, deleted };
}

// What one key did in a window (GET /api/mcp/keys/<id>/usage). `series.points` has one point for each hour or day of the window.
async function getMcpKeyUsage(id, { window = "", signal } = {}) {
  const payload = await mcpRequest(`/keys/${encodeURIComponent(id)}/usage${window ? `?window=${encodeURIComponent(window)}` : ""}`, { signal });
  const totals = payload?.totals && typeof payload.totals === "object" ? payload.totals : {};
  const series = payload?.series && typeof payload.series === "object" ? payload.series : {};
  return {
    id: mcpText(payload?.id),
    name: mcpText(payload?.name),
    host: mcpText(payload?.host),
    source: payload?.source === "config" ? "config" : "ui",
    deletedAt: mcpTime(payload?.deleted_at),
    firstUsedAt: mcpTime(payload?.first_used_at),
    lastUsedAt: mcpTime(payload?.last_used_at),
    ...mcpUsageWindow(payload),
    totals: {
      requests: mcpCount(totals.requests),
      calls: mcpCount(totals.calls),
      errors: mcpCount(totals.errors),
      rateLimited: mcpCount(totals.rate_limited),
      rejected: mcpCount(totals.rejected),
      durationMsAvg: mcpLimit(totals.duration_ms_avg),
      durationMsMax: mcpLimit(totals.duration_ms_max),
      rows: mcpCount(totals.rows),
      bytes: mcpCount(totals.bytes),
    },
    series: {
      step: series.step === "hour" ? "hour" : "day",
      points: (Array.isArray(series.points) ? series.points : []).map((point) => ({
        t: mcpTime(point?.t),
        requests: mcpCount(point?.requests),
        calls: mcpCount(point?.calls),
        errors: mcpCount(point?.errors),
      })).filter((point) => point.t != null),
    },
    tools: (Array.isArray(payload?.tools) ? payload.tools : []).map((tool) => ({
      tool: mcpText(tool?.tool),
      calls: mcpCount(tool?.calls),
      errors: mcpCount(tool?.errors),
      durationMsAvg: mcpLimit(tool?.duration_ms_avg),
      durationMsMax: mcpLimit(tool?.duration_ms_max),
      rows: mcpCount(tool?.rows),
      bytes: mcpCount(tool?.bytes),
    })).filter((tool) => tool.tool),
    statuses: (Array.isArray(payload?.statuses) ? payload.statuses : []).map((item) => ({
      status: mcpText(item?.status),
      count: mcpCount(item?.count),
    })).filter((item) => item.status),
    clients: (Array.isArray(payload?.clients) ? payload.clients : []).map((client) => ({
      name: mcpText(client?.name),
      version: mcpText(client?.version),
      userAgent: mcpText(client?.user_agent),
      firstSeenAt: mcpTime(client?.first_seen_at),
      lastSeenAt: mcpTime(client?.last_seen_at),
      requests: mcpCount(client?.requests),
    })),
  };
}

// The four dimensions that the Usage tab splits and filters by, in the order of its filter parameters.
const MCP_USAGE_DIMENSIONS = ["key", "method", "result", "type"];

// What every key did in a window (GET /api/mcp/usage/overview), cut by `filters` ({ key, method, result, type }: lists of values, any of
// the values of one dimension and all the dimensions together; each a repeated parameter). The totals and the series have every filter;
// each table of a dimension has all but its own, so a filter shows its alternatives. `series.groups` are the biggest groups of `split`
// (`rest` is what the others add up to); `series.t` has one time for each hour or day. The clients take the key filter only.
async function getMcpUsageOverview({ window = "", split = "", filters = {}, signal } = {}) {
  const params = new URLSearchParams();
  if (window) params.set("window", window);
  if (split) params.set("split", split);
  for (const dimension of MCP_USAGE_DIMENSIONS) for (const value of mcpList(filters?.[dimension])) params.append(dimension, value);
  const query = params.toString();
  const payload = await mcpRequest(`/usage/overview${query ? `?${query}` : ""}`, { signal });
  const list = (value) => (Array.isArray(value) ? value : []);
  const totals = payload?.totals && typeof payload.totals === "object" ? payload.totals : {};
  const series = payload?.series && typeof payload.series === "object" ? payload.series : {};
  // One value for each time (a time that does not read is left out with its values), whatever the answer holds.
  const sentTimes = list(series.t).map(mcpTime);
  const kept = sentTimes.map((t, i) => (t == null ? -1 : i)).filter((i) => i >= 0);
  const times = kept.map((i) => sentTimes[i]);
  const values = (raw) => {
    const sent = list(raw);
    return kept.map((i) => mcpCount(sent[i]));
  };
  const rest = series.rest && typeof series.rest === "object" ? series.rest : {};
  const omitted = payload?.omitted && typeof payload.omitted === "object" ? payload.omitted : {};
  const sent = payload?.filters && typeof payload.filters === "object" ? payload.filters : {};
  return {
    ...mcpUsageWindow(payload),
    split: mcpText(payload?.split),
    filters: Object.fromEntries(MCP_USAGE_DIMENSIONS.map((dimension) => [dimension, mcpList(sent[dimension])])),
    totals: {
      requests: mcpCount(totals.requests),
      calls: mcpCount(totals.calls),
      errors: mcpCount(totals.errors),
      rateLimited: mcpCount(totals.rate_limited),
      rejected: mcpCount(totals.rejected),
      durationMsAvg: mcpLimit(totals.duration_ms_avg),
      durationMsMax: mcpLimit(totals.duration_ms_max),
      rows: mcpCount(totals.rows),
      bytes: mcpCount(totals.bytes),
      activeKeys: mcpCount(totals.active_keys),
      keys: mcpCount(totals.keys),
    },
    series: {
      step: series.step === "hour" ? "hour" : "day",
      times,
      groups: list(series.groups).map((group) => ({
        id: mcpText(group?.id),
        label: mcpText(group?.label) || mcpText(group?.id),
        total: mcpCount(group?.total),
        values: values(group?.values),
      })).filter((group) => group.id),
      rest: { groups: mcpCount(rest.groups), total: mcpCount(rest.total), values: values(rest.values) },
    },
    keys: list(payload?.keys).map((item) => ({
      id: mcpText(item?.id),
      name: mcpText(item?.name) || mcpText(item?.id),
      host: mcpText(item?.host),
      source: item?.source === "config" ? "config" : "ui",
      deletedAt: mcpTime(item?.deleted_at),
      requests: mcpCount(item?.requests),
      calls: mcpCount(item?.calls),
      errors: mcpCount(item?.errors),
      rateLimited: mcpCount(item?.rate_limited),
      rejected: mcpCount(item?.rejected),
      durationMsAvg: mcpLimit(item?.duration_ms_avg),
      durationMsMax: mcpLimit(item?.duration_ms_max),
      rows: mcpCount(item?.rows),
      bytes: mcpCount(item?.bytes),
      lastUsedAt: mcpTime(item?.last_used_at),
    })).filter((item) => item.id),
    // kind: "call" (a tool), "request" (a method of the MCP protocol) or "refused" (`unread`: refused before the message was read).
    methods: list(payload?.methods).map((item) => ({
      method: mcpText(item?.method),
      kind: item?.kind === "request" || item?.kind === "refused" ? item.kind : "call",
      requests: mcpCount(item?.requests),
      errors: mcpCount(item?.errors),
      durationMsAvg: mcpLimit(item?.duration_ms_avg),
      durationMsMax: mcpLimit(item?.duration_ms_max),
      rows: mcpCount(item?.rows),
      bytes: mcpCount(item?.bytes),
      keys: mcpCount(item?.keys),
    })).filter((item) => item.method),
    results: list(payload?.results).map((item) => ({ result: mcpText(item?.result), count: mcpCount(item?.count), keys: mcpCount(item?.keys) })).filter((item) => item.result),
    types: list(payload?.types).map((item) => ({ type: mcpText(item?.type), requests: mcpCount(item?.requests) })).filter((item) => item.type),
    clients: list(payload?.clients).map((client) => ({
      name: mcpText(client?.name),
      version: mcpText(client?.version),
      userAgent: mcpText(client?.user_agent),
      keys: mcpCount(client?.keys),
      requests: mcpCount(client?.requests),
      firstSeenAt: mcpTime(client?.first_seen_at),
      lastSeenAt: mcpTime(client?.last_seen_at),
    })),
    // The rows that the server cut (200 for a table, 50 for the clients); a value that a filter selects is never cut.
    omitted: { keys: mcpCount(omitted.keys), methods: mcpCount(omitted.methods), results: mcpCount(omitted.results), clients: mcpCount(omitted.clients) },
  };
}

// The figures of a part of the cost of a key.
const mcpCostFigures = (raw) => ({
  statements: mcpCount(raw?.statements),
  failed: mcpCount(raw?.failed),
  canceled: mcpCount(raw?.canceled),
  readRows: mcpCount(raw?.read_rows),
  readBytes: mcpCount(raw?.read_bytes),
  resultRows: mcpCount(raw?.result_rows),
  resultBytes: mcpCount(raw?.result_bytes),
  durationMs: mcpCount(raw?.duration_ms),
  cpuMs: mcpCount(raw?.cpu_ms),
  memoryPeakBytes: mcpCount(raw?.memory_peak_bytes),
});

// What the statements of a key cost ClickHouse in a window (GET /api/mcp/keys/<id>/cost), read from system.query_log of its host.
// status "unavailable" says why in `reason` (with the GRANT `statement` when the runner may not read query_log).
async function getMcpKeyCost(id, { window = "", refresh = false, signal } = {}) {
  const query = [window ? `window=${encodeURIComponent(window)}` : "", refresh ? "refresh=1" : ""].filter(Boolean).join("&");
  const payload = await mcpRequest(`/keys/${encodeURIComponent(id)}/cost${query ? `?${query}` : ""}`, { signal });
  return {
    id: mcpText(payload?.id),
    host: mcpText(payload?.host),
    window: mcpText(payload?.window),
    from: mcpTime(payload?.from),
    to: mcpTime(payload?.to),
    maxLookbackHours: mcpCount(payload?.max_lookback_hours),
    clamped: payload?.clamped === true,
    readAt: mcpTime(payload?.read_at),
    status: payload?.status === "ok" ? "ok" : "unavailable",
    reason: mcpText(payload?.reason),
    error: mcpText(payload?.error),
    statement: mcpText(payload?.statement),
    suggestedWindow: mcpText(payload?.suggested_window),
    totals: mcpCostFigures(payload?.totals),
    identities: (Array.isArray(payload?.identities) ? payload.identities : []).map((item) => ({
      user: mcpText(item?.user),
      role: item?.role === "mcp" || item?.role === "system" ? item.role : "other",
      ...mcpCostFigures(item),
    })),
    tools: (Array.isArray(payload?.tools) ? payload.tools : []).map((item) => ({ tool: mcpText(item?.tool), ...mcpCostFigures(item) })).filter((item) => item.tool),
    tables: (Array.isArray(payload?.tables) ? payload.tables : []).map((item) => ({ name: mcpText(item?.name), statements: mcpCount(item?.statements) })).filter((item) => item.name),
    tablesTruncated: payload?.tables_truncated === true,
  };
}

async function deleteMcpKey(id, { signal } = {}) {
  await mcpRequest(`/keys/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  return id;
}

// A server-sent event stream read with fetch, with the surface of EventSource that
// the Query page uses: addEventListener(type, fn), onerror, close(), readyState.
// Chrome's own EventSource needs about as long again as the bytes take to arrive
// (37 MB of rows: 700 ms against 350 ms for fetch with the same JSON.parse), because
// it splits and dispatches the stream on the main thread line by line. Here the
// chunks are decoded once and cut at the blank line that ends an event (the server
// writes "\n" line ends only).
// A stream that fails or ends fires "error" without data, like EventSource, but
// never reconnects: a run is not repeated. A named "error" event keeps its data.
const STREAM_CONNECTING = 0;
const STREAM_OPEN = 1;
const STREAM_CLOSED = 2;

class FetchEventStream {
  constructor(url) {
    this.url = url;
    this.readyState = STREAM_CONNECTING;
    this.closed = false;
    this.onerror = null;
    this.listeners = new Map();
    this.abort = new AbortController();
    void this.read();
  }

  addEventListener(type, listener) {
    if (typeof listener !== "function") return;
    const list = this.listeners.get(type) || [];
    if (!list.includes(listener)) list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((item) => item !== listener));
  }

  close() {
    this.closed = true;
    this.readyState = STREAM_CLOSED;
    this.abort.abort();
  }

  emit(type, data, status = 0) {
    // `status`: the HTTP status of an answer that was not a stream (a result stream that expired is a 404, one that
    // was read already a 409); 0 for a stream that was cut.
    const event = { type, data, target: this, status };
    for (const listener of this.listeners.get(type) || []) {
      if (this.closed) return;
      try {
        listener.call(this, event);
      } catch (error) {
        // A failing listener does not end the stream (EventSource reports it and goes on).
        if (typeof reportError === "function") reportError(error);
        else setTimeout(() => { throw error; }, 0);
      }
    }
    if (type === "error" && typeof this.onerror === "function" && !this.closed) this.onerror.call(this, event);
  }

  // One event: its lines, "event:" (the type, "message" by default), "data:" (joined by a newline), comments ignored.
  dispatch(block) {
    let type = "message";
    let data = null;
    let start = 0;
    while (start <= block.length) {
      let end = block.indexOf("\n", start);
      if (end < 0) end = block.length;
      if (block.charCodeAt(start) !== 58 /* ":" */ && end > start) {
        const colon = block.indexOf(":", start);
        const field = colon >= 0 && colon < end ? block.slice(start, colon) : block.slice(start, end);
        let value = colon >= 0 && colon < end ? block.slice(colon + 1, end) : "";
        if (value.charCodeAt(0) === 32) value = value.slice(1);
        if (value.endsWith("\r")) value = value.slice(0, -1);
        if (field === "event") type = value;
        else if (field === "data") data = data === null ? value : `${data}\n${value}`;
      }
      start = end + 1;
    }
    if (data !== null) this.emit(type, data);
  }

  async read() {
    let status = 0;
    try {
      const response = await fetch(this.url, { signal: this.abort.signal, headers: { Accept: "text/event-stream" }, cache: "no-store" });
      if (!response.ok || !response.body) {
        status = response.status;
        throw new Error(`The stream answered ${response.status}.`);
      }
      if (this.closed) return;
      this.readyState = STREAM_OPEN;
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let from = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let start = 0;
        let end = buffer.indexOf("\n\n", from);
        while (end >= 0) {
          this.dispatch(buffer.slice(start, end));
          if (this.closed) return;
          start = end + 2;
          end = buffer.indexOf("\n\n", start);
        }
        if (start) buffer = buffer.slice(start);
        // The next search starts where this one ended (a blank line can be cut between two chunks).
        from = Math.max(0, buffer.length - 1);
      }
    } catch (error) {
      // A failed read ends the stream like its end does.
    }
    if (this.closed) return;
    // The end of the stream, normal or not: the page already has its "done" or it fails the run.
    this.readyState = STREAM_CLOSED;
    this.emit("error", undefined, status);
  }
}

// The event stream of a run: the fetch reader. There is no EventSource fallback: a native EventSource reconnects by
// itself, and a run is never repeated (the server refuses a second attach with 409 and cancels the query when the
// stream ends); every browser the page supports reads a response body as a stream.
function openEventStream(url) {
  return new FetchEventStream(url);
}

// Every request of the page's API client rejects with util.errorText's
// message (the original text on error.rawMessage), so a view shows a
// sentence rather than "trace_not_found: Trace was not found...". Called
// once by the controller of a page that shows API errors (Observability,
// one trace).
function humanizeErrors() {
  const client = api;
  if (!client || client.__humanErrors) return;
  for (const [name, fn] of Object.entries(client)) {
    if (typeof fn !== "function" || name === "resolveUrl" || name === "humanizeErrors") continue;
    client[name] = function (...args) {
      const out = fn.apply(this, args);
      if (!out || typeof out.then !== "function") return out;
      return out.catch((error) => {
        if (error instanceof Error && error.code && error.rawMessage == null) {
          error.rawMessage = error.message;
          error.message = util.errorText(error);
        }
        throw error;
      });
    };
  }
  Object.defineProperty(client, "__humanErrors", { value: true });
}

// Every call takes a last { signal } (AbortSignal, e.g. util.latest).
export const api = { resolveUrl, request, getJson, postJson, getHosts, getVersion,
  setApiOnline, formatSqls, formatSqlsEach, formatFailure, runSql, openEventStream, analyzeQuery, getQueryExecution, cancelQuery, getMeta,
  getExplorerCatalog, getExplorerTable, getExplorerTableData, getExplorerFunctions,
  getSystemActivity, getSystemKeeper, getSystemOverview, getSystemSeries,
  getSystemQueries, getSystemQuery, getSystemDisks, getSystemDiskGrowth,
  getExplorerGraph, getExplorerGraphDefinition, getTracesMeta, prefillTraces, searchTraces, getTraceServiceMap, getTraceAnalytics, getTraceHeatmap, getTraceDeltas, getTraceFacets, getTraceFacetValues, getTrace, getTraceLogs,
  getTraceLinkedFrom, getTraceContext,
  getLogs,
  getTraceServices, getTraceServicesDb,
  searchTraceSpans, getTraceSpan,
  getMetricsMeta, getMetricsCatalog, getMetricsSeries, getMetricsExemplars, getMetricsAttributes,
  getMcpMeta, getMcpKeys, createMcpKey, getMcpKeyAccess, getMcpAccessSummary, getMcpUsageSummary, getMcpKeyUsage, getMcpUsageOverview, getMcpKeyCost, deleteMcpKey,
  humanizeErrors,
};
