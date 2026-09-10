(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;
  const { dom, api, util } = ns;

  let current = null;
  let payload = null;

  const fmtInt = (v) => Number.isFinite(Number(v)) ? new Intl.NumberFormat().format(Number(v)) : "—";
  const fmtBytes = (v) => util && typeof util.formatBytes === "function" ? util.formatBytes(Number(v) || 0) : `${fmtInt(v)} B`;
  const fmtMs = (v) => Number.isFinite(Number(v)) ? `${Number(v).toLocaleString()} ms` : "—";
  const fmtSessionElapsed = (v) => Number.isFinite(Number(v)) && Number(v) >= 0
    ? (util && typeof util.formatSeconds === "function" ? util.formatSeconds(Number(v) / 1000) : fmtMs(v))
    : "—";

  function clear(el) { if (el) el.replaceChildren(); }
  function emptyState(text) { const el = document.createElement("div"); el.className = "analysisEmpty"; el.textContent = text; return el; }

  function setContext(ctx) {
    const candidate = ctx && ctx.hostId && ctx.queryId
      ? { hostId: String(ctx.hostId), queryId: String(ctx.queryId), runMode: String(ctx.runMode || "normal") }
      : null;
    current = candidate && candidate.runMode === "profiling" ? candidate : null;
    if (dom.analyzeQueryButton) dom.analyzeQueryButton.hidden = !current;
  }

  function close() { if (dom.analysisModalBackdrop) dom.analysisModalBackdrop.hidden = true; }

  function notice(text, kind = "info") {
    if (!dom.analysisNotice) return;
    dom.analysisNotice.textContent = String(text || "");
    dom.analysisNotice.dataset.kind = kind;
    dom.analysisNotice.hidden = !text;
  }

  function renderSummary(data) {
    if (!dom.analysisSummary) return;
    const overview = data?.overview || null;
    const parts = [data?.query_id || ""];
    if (overview && Number.isFinite(Number(overview.duration_ms))) parts.push(`ClickHouse ${fmtMs(overview.duration_ms)}`);
    if (Number.isFinite(Number(data?.session_elapsed_ms)) && Number(data.session_elapsed_ms) >= 0) parts.push(`Session ${fmtSessionElapsed(data.session_elapsed_ms)}`);
    if (overview && Number(overview.read_rows) > 0) parts.push(`${fmtInt(overview.read_rows)} rows read`);
    if (overview && Number(overview.memory_usage) > 0) parts.push(`${fmtBytes(overview.memory_usage)} memory`);
    dom.analysisSummary.textContent = parts.filter(Boolean).join(" · ");
  }

  function renderTrace() {
    const root = dom.analysisContent;
    clear(root);
    if (!root) return;

    const traceError = payload?.availability?.opentelemetry_span_log_error;
    const spans = Array.isArray(payload?.trace_spans) ? payload.trace_spans : [];
    if (!spans.length) {
      root.appendChild(emptyState(traceError
        ? `OpenTelemetry processor trace is unavailable: ${traceError}`
        : "No OpenTelemetry spans were recorded for this profiling run."));
      return;
    }

    if (!ns.traceViewer || typeof ns.traceViewer.render !== "function") {
      root.appendChild(emptyState("Trace viewer is unavailable."));
      return;
    }

    ns.traceViewer.render(root, {
      spans,
      attemptIds: Array.isArray(payload?.native_query_ids) ? payload.native_query_ids : [],
      truncated: payload?.trace_truncated === true,
      maxRows: 3000,
      emptyText: "No OpenTelemetry spans were recorded for this profiling run.",
    });
  }

  async function open(ctx = current) {
    if (ctx && ctx.hostId && ctx.queryId && String(ctx.runMode || "normal") === "profiling") {
      current = { hostId: String(ctx.hostId), queryId: String(ctx.queryId), runMode: "profiling" };
    }
    if (!current) return;
    if (dom.analysisModalBackdrop) dom.analysisModalBackdrop.hidden = false;
    clear(dom.analysisContent);
    notice("Loading ClickHouse execution logs…");
    if (dom.analysisSummary) dom.analysisSummary.textContent = current.queryId;
    try {
      payload = await api.analyzeQuery(current.hostId, current.queryId);
      renderSummary(payload);
      if (payload.partial_execution) notice("Execution stopped by result preview limit. Metrics describe a partial execution.", "warning");
      else if (payload.logs_pending) notice("ClickHouse system logs are still being populated; available data is shown.", "warning");
      else notice("");
      renderTrace();
    } catch (err) {
      payload = null;
      notice(err instanceof Error ? err.message : String(err), "error");
      if (dom.analysisContent) {
        clear(dom.analysisContent);
        dom.analysisContent.appendChild(emptyState("Analysis could not be loaded."));
      }
    }
  }

  function init() {
    dom.analyzeQueryButton?.addEventListener("click", () => open());
    dom.analysisCloseButton?.addEventListener("click", close);
    dom.analysisModalBackdrop?.addEventListener("click", (event) => { if (event.target === dom.analysisModalBackdrop) close(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && dom.analysisModalBackdrop && !dom.analysisModalBackdrop.hidden) close(); });
    setContext(null);
  }

  ns.analysis = { init, setContext, open, close };
})();
