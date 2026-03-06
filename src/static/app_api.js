(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { util } = ns;

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
      return {};
    }
  }

  async function postJson(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  async function getMeta(hostId, types) {
    if (!hostId) throw new Error("No host selected.");
    const arr = Array.isArray(types) ? types.filter((x) => x) : [];
    const typesCsv = arr.length ? arr.map((x) => String(x)).join(",") : "keywords";
    const qs = new URLSearchParams({ host_id: String(hostId), types: typesCsv }).toString();
    let response;
    try {
      response = await fetch(`api/meta?${qs}`, { cache: "no-store" });
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

  async function runSql(hostId, sql) {
    if (!hostId) throw new Error("No host selected.");
    const payload = await postJson("api/query/run", { host_id: hostId, sql: String(sql || "") });

    if (!payload || typeof payload.query_id !== "string" || typeof payload.stream_url !== "string") {
      throw new Error("Invalid run response.");
    }

    return {
      queryId: payload.query_id,
      cancelToken: payload.cancel_token ? String(payload.cancel_token) : null,
      streamUrl: payload.stream_url,
    };
  }

  async function cancelQuery(cancelToken) {
    if (!cancelToken) throw new Error("No active query to cancel.");
    const payload = await postJson("api/query/cancel", { cancel_token: String(cancelToken) });
    return !!(payload && payload.ok);
  }

  ns.api = { formatSqls, runSql, cancelQuery, getMeta };
})();