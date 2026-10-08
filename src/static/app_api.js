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
  // online flag, a JSON answer and one error shape (Error with .code,
  // .payload, and for an HTTP error .status and .body, the answer as sent).
  // options: { method, body (JSON-encoded), headers (added, e.g. If-Match),
  // signal }.
  async function request(path, { method = "GET", body, headers, signal } = {}) {
    if (signal?.aborted) throw abortError();
    let response;
    try {
      response = await fetch(resolveUrl(path), {
        method,
        headers: requestHeaders({ ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(headers || {}) }),
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
    if (!response.ok) {
      const err = apiError(util.buildApiErrorFromResponse(response.status, payload), `Request failed with status ${response.status}`);
      err.status = response.status;
      err.body = payload;
      throw err;
    }
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

  // --- MCP integration (docs/mcp.md, app_mcp_page.js) -------------------------------
  // The one place that knows the JSON of /api/mcp/*: the page's modules read the shapes
  // normalized here and never the raw answers, so a change of the server's JSON is fixed here.
  //   getMcpMeta()                  the state, endpoint, hosts, tools and limits ({ enabled: false } when off)
  //   getMcpKeys()                  [key]
  //   createMcpKey(input)           { key, secret }   (the secret comes once)
  //   updateMcpKey(id, input)       key
  //   rotateMcpKey(id)              { key, secret }
  //   deleteMcpKey(id)              id
  // A failed call rejects with an Error that carries err.mcp = { status, code, message, field, reason }
  // (the answer's `error`, `message`, `field` and `reason`; `field` without a position suffix: "tools[1]" is "tools").
  const MCP_TOOL_GROUPS = ["schema", "read", "sql"];
  const mcpText = (value) => (typeof value === "string" ? value : "");
  const mcpList = (value) => (Array.isArray(value) ? value.map((item) => String(item)) : []);
  const mcpLimit = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

  function normalizeMcpMeta(raw) {
    const meta = raw && typeof raw === "object" ? raw : {};
    if (meta.enabled !== true) return { enabled: false };
    const limits = meta.limits && typeof meta.limits === "object" ? meta.limits : {};
    const can = meta.can_manage === true;
    return {
      enabled: true,
      endpointPath: mcpText(meta.endpoint_path) || "/mcp",
      storageConfigured: meta.storage_configured === true,
      manageFromUi: meta.manage_from_ui !== false,
      canManage: can,
      protocolVersions: mcpList(meta.protocol_versions),
      hosts: (Array.isArray(meta.hosts) ? meta.hosts : []).map((host) => ({
        name: mcpText(host?.name),
        label: mcpText(host?.label),
        healthy: host?.healthy === true ? true : host?.healthy === false ? false : null,
      })).filter((host) => host.name),
      tools: (Array.isArray(meta.tools) ? meta.tools : []).map((tool) => ({
        name: mcpText(tool?.name),
        group: MCP_TOOL_GROUPS.includes(tool?.group) ? tool.group : "read",
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
      namePattern: mcpText(meta.name_pattern) || "^[a-z0-9][a-z0-9_-]{0,63}$",
      secretMinBytes: mcpLimit(meta.secret_min_bytes) || 24,
    };
  }

  function normalizeMcpKey(raw) {
    const key = raw && typeof raw === "object" ? raw : {};
    const state = ["active", "disabled", "expired"].includes(key.state) ? key.state : "active";
    return {
      id: mcpText(key.id),
      name: mcpText(key.name),
      description: mcpText(key.description),
      source: key.source === "config" ? "config" : "ui",
      secretHint: mcpText(key.secret_hint),
      hosts: mcpList(key.hosts),
      tools: mcpList(key.tools),
      databases: mcpList(key.databases),
      maxRows: mcpLimit(key.max_rows),
      timeoutSeconds: mcpLimit(key.timeout_seconds),
      expiresAt: mcpText(key.expires_at) || null,
      enabled: key.enabled !== false,
      state,
      createdAt: mcpText(key.created_at) || null,
      lastUsedAt: mcpText(key.last_used_at) || null,
    };
  }

  // The body of a create or an edit: the fields the caller names (camelCase), in the server's names.
  function mcpKeyBody(input = {}) {
    const names = { name: "name", description: "description", hosts: "hosts", tools: "tools", databases: "databases", maxRows: "max_rows", timeoutSeconds: "timeout_seconds", expiresAt: "expires_at", enabled: "enabled" };
    const body = {};
    for (const [from, to] of Object.entries(names)) if (input[from] !== undefined) body[to] = input[from];
    return body;
  }

  async function mcpRequest(path, options = {}) {
    try {
      return await request(`api/mcp${path}`, options);
    } catch (error) {
      const body = error?.body && typeof error.body === "object" ? error.body : null;
      if (body && typeof body.error === "string") {
        error.mcp = {
          status: Number(error.status) || 0,
          code: body.error,
          message: mcpText(body.message),
          field: mcpText(body.field).replace(/[[.].*$/, ""),
          reason: mcpText(body.reason),
        };
        error.code = body.error;
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

  async function updateMcpKey(id, input, { signal } = {}) {
    const payload = await mcpRequest(`/keys/${encodeURIComponent(id)}`, { method: "PATCH", body: mcpKeyBody(input), signal });
    return normalizeMcpKey(payload?.key);
  }

  async function rotateMcpKey(id, { signal } = {}) {
    const payload = await mcpRequest(`/keys/${encodeURIComponent(id)}/rotate`, { method: "POST", body: {}, signal });
    return { key: normalizeMcpKey(payload?.key), secret: mcpText(payload?.secret) };
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

    emit(type, data) {
      const event = { type, data, target: this };
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
      try {
        const response = await fetch(this.url, { signal: this.abort.signal, headers: { Accept: "text/event-stream" }, cache: "no-store" });
        if (!response.ok || !response.body) throw new Error(`The stream answered ${response.status}.`);
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
      this.emit("error", undefined);
    }
  }

  // The event stream of a run: the fetch reader where the browser can stream a response body.
  function openEventStream(url) {
    if (typeof ReadableStream !== "function" || typeof TextDecoder !== "function" || typeof AbortController !== "function") return new EventSource(url);
    return new FetchEventStream(url);
  }

  // Every request of the page's API client rejects with util.errorText's
  // message (the original text on error.rawMessage), so a view shows a
  // sentence rather than "trace_not_found: Trace was not found...". Called
  // once by the controller of a page that shows API errors (Observability,
  // one trace).
  function humanizeErrors() {
    const client = ns.api;
    if (!client || client.__humanErrors) return;
    for (const [name, fn] of Object.entries(client)) {
      if (typeof fn !== "function" || name === "resolveUrl" || name === "humanizeErrors") continue;
      client[name] = function (...args) {
        const out = fn.apply(this, args);
        if (!out || typeof out.then !== "function") return out;
        return out.catch((error) => {
          if (error instanceof Error && error.code && error.rawMessage == null) {
            error.rawMessage = error.message;
            error.message = ns.util.errorText(error);
          }
          throw error;
        });
      };
    }
    Object.defineProperty(client, "__humanErrors", { value: true });
  }

  // Every call takes a last { signal } (AbortSignal, e.g. util.latest).
  ns.api = { resolveUrl, request, getJson, postJson, getHosts, getVersion,
    formatSqls, runSql, openEventStream, analyzeQuery, getQueryExecution, prepareExport, cancelQuery, getMeta,
    getExplorerCatalog, getExplorerTable, getExplorerTableData, getExplorerFunctions,
    getSystemActivity, getSystemKeeper, getSystemOverview, getSystemSeries,
    getSystemQueries, getSystemQuery, getSystemDisks, getSystemDiskGrowth,
    getExplorerGraph, getExplorerGraphDefinition, getTracesMeta, prefillTraces, searchTraces, getTraceServiceMap, getTraceAnalytics, getTraceHeatmap, getTraceDeltas, getTraceFacets, getTraceFacetValues, getTrace, getTraceLogs,
    getTraceLinkedFrom, getTraceContext,
    getLogs,
    getTraceServices, getTraceServicesDb,
    searchTraceSpans, getTraceSpan,
    getMetricsMeta, getMetricsCatalog, getMetricsSeries, getMetricsExemplars, getMetricsAttributes,
    getMcpMeta, getMcpKeys, createMcpKey, updateMcpKey, rotateMcpKey, deleteMcpKey,
    humanizeErrors,
  };
})();