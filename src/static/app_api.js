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
      const msg = payload && payload.message ? String(payload.message) : `Request failed with status ${response.status}`;
      throw new Error(msg);
    }

    return payload;
  }

  async function formatSqls(hostId, sqls) {
    if (!hostId) throw new Error("No host selected.");
    if (!Array.isArray(sqls)) throw new Error("formatSqls expects an array.");

    const payload = await postJson("api/format", { host_id: hostId, sqls });

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

  ns.api = { formatSqls, runSql, cancelQuery };
})();