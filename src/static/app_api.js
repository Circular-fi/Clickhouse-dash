(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { util } = ns;

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

  function setApiOnline(online) {
    const next = online !== false;
    const ui = ns.ui;
    if (ui && typeof ui.setApiOnline === "function") {
      ui.setApiOnline(next);
      return;
    }
    if (ns.state) ns.state.apiOnline = next;
    const run = ns.run;
    if (run && typeof run.updateActionButtons === "function") run.updateActionButtons();
  }

  async function readJsonBody(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      const contentType = String(response.headers.get("content-type") || "");
      const err = new Error(`API returned a non-JSON response (${contentType || "unknown content type"}). Check the application/subpath routing.`);
      err.code = "invalid_api_response";
      err.responseText = text.slice(0, 240);
      throw err;
    }
  }

  async function postJson(url, body) {
    let response;
    try {
      response = await fetch(resolveUrl(url), {
        method: "POST",
        headers: requestHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
        cache: "no-store",
      });
    } catch (e) {
      setApiOnline(false);
      const norm = util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." });
      const msg = util.buildApiErrorText(norm, "Network error.");
      const err = new Error(msg);
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }

    setApiOnline(true);

    const payload = await readJsonBody(response);

    if (!response.ok) {
      const norm = util.buildApiErrorFromResponse(response.status, payload);
      const msg = util.buildApiErrorText(norm, `Request failed with status ${response.status}`);
      const err = new Error(msg);
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }

    return payload;
  }

  async function getMeta(hostId, types, scope = null) {
    if (!hostId) throw new Error("No host selected.");
    const arr = Array.isArray(types) ? types.filter((x) => x) : [];
    const typesCsv = arr.length ? arr.map((x) => String(x)).join(",") : "keywords";
    const query = new URLSearchParams({ host_id: String(hostId), types: typesCsv });
    if (scope && scope.database != null) query.set("database", String(scope.database));
    if (scope && scope.table != null) query.set("table", String(scope.table));
    const qs = query.toString();
    let response;
    try {
      response = await fetch(resolveUrl(`api/meta?${qs}`), { headers: requestHeaders(), cache: "no-store" });
    } catch (e) {
      setApiOnline(false);
      const norm = util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." });
      const msg = util.buildApiErrorText(norm, "Network error.");
      const err = new Error(msg);
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }

    setApiOnline(true);
    const payload = await readJsonBody(response);

    if (!response.ok) {
      const norm = util.buildApiErrorFromResponse(response.status, payload);
      const msg = util.buildApiErrorText(norm, `Request failed with status ${response.status}`);
      const err = new Error(msg);
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }

    return payload;
  }


  async function getJson(url) {
    let response;
    try {
      response = await fetch(resolveUrl(url), { headers: requestHeaders(), cache: "no-store" });
    } catch (e) {
      setApiOnline(false);
      const norm = util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." });
      const err = new Error(util.buildApiErrorText(norm, "Network error."));
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }
    setApiOnline(true);
    const payload = await readJsonBody(response);
    if (!response.ok) {
      const norm = util.buildApiErrorFromResponse(response.status, payload);
      const err = new Error(util.buildApiErrorText(norm, `Request failed with status ${response.status}`));
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }
    return payload;
  }

  async function getExplorerCatalog(hostId, database = "", refresh = false) {
    if (!hostId) throw new Error("No host selected.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (database) query.set("database", String(database));
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/catalog?${query.toString()}`);
  }

  async function getExplorerTable(hostId, database, table, refresh = false) {
    if (!hostId || !database || !table) throw new Error("Explorer table scope is incomplete.");
    const query = new URLSearchParams({ host_id: String(hostId), database: String(database), table: String(table) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/table?${query.toString()}`);
  }

  async function getExplorerTableData(hostId, database, table, limit = 100) {
    if (!hostId || !database || !table) throw new Error("Explorer table scope is incomplete.");
    return postJson("api/explorer/table/data", {
      host_id: String(hostId),
      database: String(database),
      table: String(table),
      limit: Math.max(1, Math.min(500, Number(limit) || 100)),
    });
  }


  async function getExplorerGraph(hostId, options = {}) {
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
    }
    query.set("mode", options.mode === "physical" ? "physical" : "logical");
    if (options.includeSystem === true) query.set("include_system", "1");
    query.set("include_non_storing", options.includeNonStoring === false ? "0" : "1");
    if (options.refresh === true) query.set("refresh", "1");
    return getJson(`api/explorer/graph?${query.toString()}`);
  }

  async function getTracesMeta(hostId) {
    const query = new URLSearchParams();
    if (hostId) query.set("host_id", String(hostId));
    return getJson(`api/traces/meta?${query.toString()}`);
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

  async function prefillTraces(hostId, filters = {}) {
    return getJson(`api/traces/prefill?${traceQuery(hostId, filters).toString()}`);
  }

  async function searchTraces(hostId, filters = {}) {
    return getJson(`api/traces/search?${traceQuery(hostId, filters).toString()}`);
  }

  // Services and the calls between them (sampled on wide windows).
  async function getTraceServiceMap(hostId, filters = {}) {
    return getJson(`api/traces/service_map?${traceQuery(hostId, filters).toString()}`);
  }

  async function getTraceAnalytics(hostId, filters = {}) {
    return getJson(`api/traces/analytics?${traceQuery(hostId, filters).toString()}`);
  }

  // Duration heatmap (traces per time bucket x log duration row) and the
  // attribute comparison of a box of it (app_trace_heatmap.js).
  async function getTraceHeatmap(hostId, filters = {}) {
    return getJson(`api/traces/heatmap?${traceQuery(hostId, filters).toString()}`);
  }

  async function getTraceDeltas(hostId, filters = {}) {
    return getJson(`api/traces/deltas?${traceQuery(hostId, filters).toString()}`);
  }

  // Attribute keys / one key's values of the spans matching the filters
  // (bounded and cached server-side; "estimated" when a cap stopped the scan).
  async function getTraceFacets(hostId, filters = {}) {
    return getJson(`api/traces/facets?${traceQuery(hostId, filters).toString()}`);
  }

  async function getTraceFacetValues(hostId, filters = {}) {
    return getJson(`api/traces/facet_values?${traceQuery(hostId, filters).toString()}`);
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

  async function getTraceServices(hostId, filters = {}) {
    return getJson(`api/traces/services?${traceServicesQuery(hostId, filters).toString()}`);
  }

  async function getTraceServicesDb(hostId, filters = {}) {
    return getJson(`api/traces/services/db?${traceServicesQuery(hostId, filters).toString()}`);
  }

  async function getTrace(hostId, traceId) {
    if (!traceId) throw new Error("No trace selected.");
    const query = new URLSearchParams({ trace_id: String(traceId) });
    if (hostId) query.set("host_id", String(hostId));
    return getJson(`api/traces/trace?${query.toString()}`);
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
  async function getTraceLinkedFrom(hostId, params = {}) {
    return getJson(`api/traces/linked_from?${optionalParams(hostId, params).toString()}`);
  }

  // Spans around a span's start time (surrounding context).
  async function getTraceContext(hostId, params = {}) {
    return getJson(`api/traces/context?${optionalParams(hostId, params).toString()}`);
  }

  // Logs of one trace: the trace bounds (epoch ns) and its services bound
  // the lookup; span_id narrows it to one span.
  async function getTraceLogs(hostId, { traceId, startNs, endNs, services = [], spanId = "", limit = 0 } = {}) {
    if (!traceId) throw new Error("No trace selected.");
    const query = new URLSearchParams({ trace_id: String(traceId), start_ns: String(startNs), end_ns: String(endNs) });
    if (hostId) query.set("host_id", String(hostId));
    for (const service of services) if (service) query.append("service", String(service));
    if (spanId) query.set("span_id", String(spanId));
    if (limit) query.set("limit", String(limit));
    return getJson(`api/traces/logs?${query.toString()}`);
  }

  // Server-wide storage distribution (runner-visible databases -> tables) for
  // the Explorer System section treemap.
  async function getExplorerStorage(hostId, refresh = false) {
    if (!hostId) throw new Error("Explorer storage scope is incomplete.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/storage?${query.toString()}`);
  }

  async function getExplorerFunctions(hostId, refresh = false) {
    if (!hostId) throw new Error("No host selected.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/functions?${query.toString()}`);
  }


  async function formatSqls(hostId, sqls) {
    if (!hostId) throw new Error("No host selected.");
    if (!Array.isArray(sqls)) throw new Error("formatSqls expects an array.");

    const payload = await postJson("api/format", { host_id: hostId, sqls });

    if (!payload || !Array.isArray(payload.formatted_sqls)) {
      const norm = util.normalizeApiErrorPayload(payload, { error_code: "invalid_json", message: "Invalid format response." });
      const msg = util.buildApiErrorText(norm, "Invalid format response.");
      const err = new Error(msg);
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }

    return payload.formatted_sqls.map((s) => String(s || ""));
  }

  async function runSql(hostId, sql, mode = "normal") {
    if (!hostId) throw new Error("No host selected.");
    const runMode = String(mode || "normal").toLowerCase();
    if (runMode !== "normal" && runMode !== "profiling") throw new Error("Invalid run mode.");
    const payload = await postJson("api/query/run", { host_id: hostId, sql: String(sql || ""), mode: runMode });

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

  async function analyzeQuery(hostId, queryId, options = {}) {
    if (!hostId) throw new Error("No host selected.");
    if (!queryId) throw new Error("No query selected for analysis.");
    let response;
    try {
      response = await fetch(resolveUrl("api/query/analysis"), {
        method: "POST",
        headers: requestHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          host_id: String(hostId),
          query_id: String(queryId),
          ...(options.includeOriginalTrace === true ? { include_original_trace: true } : {}),
        }),
        cache: "no-store",
      });
    } catch (e) {
      setApiOnline(false);
      const norm = util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." });
      const err = new Error(util.buildApiErrorText(norm, "Network error."));
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }
    setApiOnline(true);
    if (!response.ok) {
      const errorPayload = await readJsonBody(response);
      const norm = util.buildApiErrorFromResponse(response.status, errorPayload);
      const err = new Error(util.buildApiErrorText(norm, `Request failed with status ${response.status}`));
      err.code = norm.error_code;
      err.payload = norm;
      throw err;
    }
    const payload = await readJsonBody(response);
    if (!payload || typeof payload !== "object") throw new Error("Invalid profiling response.");
    return payload;
  }


  async function prepareExport(hostId, format, queries) {
    if (!hostId) throw new Error("No host selected.");
    const normalizedFormat = String(format || "").toLowerCase();
    if (normalizedFormat !== "csv" && normalizedFormat !== "json") throw new Error("Invalid export format.");
    if (!Array.isArray(queries) || !queries.length) throw new Error("No export queries supplied.");
    const payload = await postJson("api/export/run", {
      host_id: String(hostId),
      format: normalizedFormat,
      queries: queries.map((query) => String(query || "")),
    });
    if (!payload || typeof payload.download_url !== "string" || !payload.download_url) {
      throw new Error("Invalid export handshake response.");
    }
    return {
      exportId: payload.export_id ? String(payload.export_id) : null,
      downloadUrl: resolveUrl(payload.download_url),
      expiresInMs: Number(payload.expires_in_ms) || 0,
      format: payload.format ? String(payload.format) : normalizedFormat,
    };
  }

  async function getQueryExecution(hostId, queryId) {
    if (!hostId) throw new Error("No host selected.");
    if (!queryId) throw new Error("No query selected for execution statistics.");
    const query = new URLSearchParams({ host_id: String(hostId), query_id: String(queryId) });
    return getJson(`api/query/execution?${query.toString()}`);
  }

  async function cancelQuery(cancelToken) {
    if (!cancelToken) throw new Error("No active query to cancel.");
    const payload = await postJson("api/query/cancel", { cancel_token: String(cancelToken) });
    return !!(payload && payload.ok);
  }

  // Logs explorer routes: api/logs/{meta,search,histogram,context,patterns,services}.
  async function getLogs(endpoint, params) {
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    return getJson(`api/logs/${endpoint}?${query.toString()}`);
  }

  ns.api = { resolveUrl, getJson,
    formatSqls, runSql, analyzeQuery, getQueryExecution, prepareExport, cancelQuery, getMeta,
    getExplorerCatalog, getExplorerTable, getExplorerTableData, getExplorerFunctions, getExplorerStorage,
    getExplorerGraph, getTracesMeta, prefillTraces, searchTraces, getTraceServiceMap, getTraceAnalytics, getTraceHeatmap, getTraceDeltas, getTraceFacets, getTraceFacetValues, getTrace, getTraceLogs,
    getTraceLinkedFrom, getTraceContext,
    getLogs,
    getTraceServices, getTraceServicesDb,
  };
})();