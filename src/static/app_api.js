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

  ns.api = { resolveUrl,
    formatSqls, runSql, analyzeQuery, getQueryExecution, prepareExport, cancelQuery, getMeta,
    getExplorerCatalog, getExplorerTable, getExplorerTableData, getExplorerFunctions,
    getExplorerGraph,
  };
})();