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

  // The one request path of every api.* call: the request headers, the
  // online flag, a JSON answer and one error shape (Error with .code and
  // .payload). options: { method, body (JSON-encoded), signal }.
  async function request(path, { method = "GET", body, signal } = {}) {
    if (signal?.aborted) throw abortError();
    let response;
    try {
      response = await fetch(resolveUrl(path), {
        method,
        headers: requestHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === "AbortError") throw abortError();
      setApiOnline(false);
      throw apiError(util.normalizeApiErrorPayload(null, { error_code: "network_error", message: e instanceof Error ? String(e.message || "Network error.") : "Network error." }), "Network error.");
    }
    setApiOnline(true);
    let payload;
    try {
      payload = await readJsonBody(response);
    } catch (e) {
      if (signal?.aborted || e?.name === "AbortError") throw abortError();
      throw e;
    }
    if (!response.ok) throw apiError(util.buildApiErrorFromResponse(response.status, payload), `Request failed with status ${response.status}`);
    return payload;
  }

  const getJson = (url, { signal } = {}) => request(url, { signal });
  const postJson = (url, body, { signal } = {}) => request(url, { method: "POST", body, signal });

  async function getMeta(hostId, types, scope = null, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    const arr = Array.isArray(types) ? types.filter((x) => x) : [];
    const typesCsv = arr.length ? arr.map((x) => String(x)).join(",") : "keywords";
    const query = new URLSearchParams({ host_id: String(hostId), types: typesCsv });
    if (scope && scope.database != null) query.set("database", String(scope.database));
    if (scope && scope.table != null) query.set("table", String(scope.table));
    return getJson(`api/meta?${query.toString()}`, { signal });
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

  // Server-wide storage distribution (runner-visible databases -> tables) for
  // the Explorer System section treemap.
  async function getExplorerStorage(hostId, refresh = false, { signal } = {}) {
    if (!hostId) throw new Error("Explorer storage scope is incomplete.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/storage?${query.toString()}`, { signal });
  }

  // Explorer Server operations view: background activity (merges, mutations,
  // replication, Distributed queues) and Keeper session status.
  async function getExplorerOpsActivity(hostId, refresh = false, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/ops/activity?${query.toString()}`, { signal });
  }

  async function getExplorerOpsKeeper(hostId, refresh = false, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/ops/keeper?${query.toString()}`, { signal });
  }

  async function getExplorerFunctions(hostId, refresh = false, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    const query = new URLSearchParams({ host_id: String(hostId) });
    if (refresh) query.set("refresh", "1");
    return getJson(`api/explorer/functions?${query.toString()}`, { signal });
  }


  async function formatSqls(hostId, sqls, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    if (!Array.isArray(sqls)) throw new Error("formatSqls expects an array.");

    const payload = await postJson("api/format", { host_id: hostId, sqls }, { signal });

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

  async function analyzeQuery(hostId, queryId, options = {}) {
    if (!hostId) throw new Error("No host selected.");
    if (!queryId) throw new Error("No query selected for analysis.");
    const payload = await postJson("api/query/analysis", {
      host_id: String(hostId),
      query_id: String(queryId),
      ...(options.includeOriginalTrace === true ? { include_original_trace: true } : {}),
    }, { signal: options.signal });
    if (!payload || typeof payload !== "object") throw new Error("Invalid profiling response.");
    return payload;
  }


  async function prepareExport(hostId, format, queries, { signal } = {}) {
    if (!hostId) throw new Error("No host selected.");
    const normalizedFormat = String(format || "").toLowerCase();
    if (normalizedFormat !== "csv" && normalizedFormat !== "json") throw new Error("Invalid export format.");
    if (!Array.isArray(queries) || !queries.length) throw new Error("No export queries supplied.");
    const payload = await postJson("api/export/run", {
      host_id: String(hostId),
      format: normalizedFormat,
      queries: queries.map((query) => String(query || "")),
    }, { signal });
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

  // Logs explorer routes: api/logs/{meta,search,histogram,context,patterns,services}.
  async function getLogs(endpoint, params, { signal } = {}) {
    const query = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
    return getJson(`api/logs/${endpoint}?${query.toString()}`, { signal });
  }

  // Every call takes a last { signal } (AbortSignal, e.g. util.latest).
  ns.api = { resolveUrl, request, getJson, postJson, getHosts, getVersion,
    formatSqls, runSql, analyzeQuery, getQueryExecution, prepareExport, cancelQuery, getMeta,
    getExplorerCatalog, getExplorerTable, getExplorerTableData, getExplorerFunctions, getExplorerStorage,
    getExplorerOpsActivity, getExplorerOpsKeeper,
    getExplorerGraph, getExplorerGraphDefinition, getTracesMeta, prefillTraces, searchTraces, getTraceServiceMap, getTraceAnalytics, getTraceHeatmap, getTraceDeltas, getTraceFacets, getTraceFacetValues, getTrace, getTraceLogs,
    getTraceLinkedFrom, getTraceContext,
    getLogs,
    getTraceServices, getTraceServicesDb,
  };
})();