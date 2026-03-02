(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

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
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const payload = await readJsonBody(response);

    if (!response.ok) {
      const code = payload && payload.error_code ? String(payload.error_code) : "";
      const msg = payload && payload.message ? String(payload.message) : `Request failed with status ${response.status}`;
      const err = new Error(code ? `${code}: ${msg}` : msg);
      err.code = code || null;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async function getMeta(hostId, types) {
    if (!hostId) throw new Error("No host selected.");
    const arr = Array.isArray(types) ? types.filter((x) => x) : [];
    const typesCsv = arr.length ? arr.map((x) => String(x)).join(",") : "keywords";
    const qs = new URLSearchParams({ host_id: String(hostId), types: typesCsv }).toString();
    const response = await fetch(`api/meta?${qs}`, { cache: "no-store" });
    const payload = await readJsonBody(response);

    if (!response.ok) {
      const code = payload && payload.error_code ? String(payload.error_code) : "";
      const msg = payload && payload.message ? String(payload.message) : `Request failed with status ${response.status}`;
      const err = new Error(code ? `${code}: ${msg}` : msg);
      err.code = code || null;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async function formatSqls(hostId, sqls) {
    if (!hostId) throw new Error("No host selected.");
    if (!Array.isArray(sqls)) throw new Error("formatSqls expects an array.");

    const payload = await postJson("api/format", { host_id: hostId, sqls });

    if (payload && payload.error_code) {
      const code = String(payload.error_code || "format_failed");
      const msg = payload && payload.message ? `Format failed. Query n°${String(payload.message)}` : "Format failed.";
      const err = new Error(`${code}: ${msg} test`);
      err.code = code;
      err.payload = payload;
      throw err;
    }

    if (!payload || !Array.isArray(payload.formatted_sqls)) {
      throw new Error("Invalid format response.");
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