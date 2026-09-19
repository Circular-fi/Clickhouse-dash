(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;
  const { dom, api, util } = ns;

  let current = null;
  let payload = null;
  let decodedProcessors = null;
  let traceSpans = null;
  let pipelineModel = null;
  let traceController = null;
  let loadGeneration = 0;
  let activeTab = "pipeline";

  const fmtInt = (v) => Number.isFinite(Number(v)) ? new Intl.NumberFormat().format(Number(v)) : "—";
  const fmtBytes = (v) => util && typeof util.formatBytes === "function" ? util.formatBytes(Number(v) || 0) : `${fmtInt(v)} B`;
  const fmtMs = (v) => Number.isFinite(Number(v)) ? `${Number(v).toLocaleString()} ms` : "—";
  const fmtSessionElapsed = (v) => Number.isFinite(Number(v)) && Number(v) >= 0
    ? (util && typeof util.formatSeconds === "function" ? util.formatSeconds(Number(v) / 1000) : fmtMs(v))
    : "—";

  function clear(el) {
    if (el) {
      traceController?.destroy?.();
      traceController = null;
      ns.pipelineViewer?.dispose?.(el);
      el.replaceChildren();
    }
  }
  function releaseData() {
    payload = null;
    decodedProcessors = null;
    traceSpans = null;
    pipelineModel = null;
  }
  function emptyState(text) { const el = document.createElement("div"); el.className = "analysisEmpty"; el.textContent = text; return el; }

  function decodeTraceSpans(data) {
    const compact = data?.trace_compact;
    if (compact && String(compact.format || "") === "chdash.trace.json.lod.v2") {
      const origin = Number(compact.origin_us) || 0;
      const duration = Math.max(1, Number(compact.duration_us) || 1);
      const timelinePx = Math.max(1, Number(compact.timeline_px) || 3840);
      const hosts = Array.isArray(compact.hosts) ? compact.hosts : [];
      const traces = Array.isArray(compact.traces) ? compact.traces : [];
      const operations = Array.isArray(compact.operations) ? compact.operations : [];
      const nodes = Array.isArray(compact.nodes) ? compact.nodes : [];

      return nodes.map((row, index) => {
        if (!Array.isArray(row)) return null;
        const traceIndex = Number(row[0]) || 0;
        const hostRef = Number(row[1]) || 0;
        const parentRef = Number(row[2]) || 0;
        const operationIndex = Number(row[3]) || 0;
        const leafGroup = (Number(row[4]) & 1) !== 0;
        const wireSegments = Array.isArray(row[5]) ? row[5] : [];
        const segments = [];
        for (let i = 0; i + 1 < wireSegments.length; i += 2) {
          const startPx = Math.max(0, Math.min(timelinePx, Number(wireSegments[i]) || 0));
          const finishPx = Math.max(startPx, Math.min(timelinePx, Number(wireSegments[i + 1]) || 0));
          const start = origin + Math.floor((startPx * duration) / timelinePx);
          const finish = origin + Math.ceil((finishPx * duration) / timelinePx);
          segments.push({ start_time_us: start, finish_time_us: Math.max(start, finish) });
        }
        if (!segments.length) segments.push({ start_time_us: origin, finish_time_us: origin });
        const start = segments[0].start_time_us;
        const finish = segments[segments.length - 1].finish_time_us;
        const activeDuration = segments.reduce(
          (sum, segment) => sum + Math.max(0, segment.finish_time_us - segment.start_time_us),
          0,
        );
        return {
          hostname: hostRef > 0 ? String(hosts[hostRef - 1] || "") : "",
          trace_id: String(traces[traceIndex] || ""),
          span_id: leafGroup ? `__leaf_group_${index}` : `__trace_node_${index}`,
          parent_span_id: parentRef > 0 ? `__trace_node_${parentRef - 1}` : "",
          operation_name: String(operations[operationIndex] || "span"),
          start_time_us: start,
          finish_time_us: finish,
          duration_us: activeDuration,
          segments,
          compact_leaf_group: leafGroup,
          temporal_lod_px: timelinePx,
        };
      }).filter(Boolean);
    }

    const rows = Array.isArray(data?.trace_spans) ? data.trace_spans : [];
    if (!rows.length) return [];
    // Legacy saved/debug artifacts remain readable.
    if (!Array.isArray(rows[0])) return rows;

    const rowSchema = Array.isArray(data?.trace_span_schema) ? data.trace_span_schema : [];
    const segmentSchema = Array.isArray(data?.trace_segment_schema) ? data.trace_segment_schema : [];
    const traceOriginUs = Number(data?.trace_origin_us) || 0;
    const ri = Object.fromEntries(rowSchema.map((name, index) => [String(name), index]));
    const si = Object.fromEntries(segmentSchema.map((name, index) => [String(name), index]));
    const spans = [];
    let syntheticLeafId = 0;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const hostname = String(row[ri.hostname ?? 0] ?? "");
      const traceId = String(row[ri.trace_id ?? 1] ?? "");
      const parentSpanId = String(row[ri.parent_span_id ?? 2] ?? "");
      const operationName = String(row[ri.operation_name ?? 3] ?? "span");
      const wireSpanId = String(row[ri.span_id ?? 4] ?? "");
      const rawSegments = row[ri.segments ?? 5];
      if (!Array.isArray(rawSegments) || !rawSegments.length) continue;
      const segments = rawSegments
        .filter(Array.isArray)
        .map((segment) => {
          const startOffset = Number(segment[si.start_offset_us ?? si.start_time_us ?? 0]) || 0;
          const finishOffset = Number(segment[si.finish_offset_us ?? si.finish_time_us ?? 1]) || 0;
          const start = traceOriginUs > 0 ? traceOriginUs + startOffset : startOffset;
          const finish = traceOriginUs > 0 ? traceOriginUs + finishOffset : finishOffset;
          return { start_time_us: start, finish_time_us: finish };
        })
        .filter((segment) => segment.start_time_us > 0 && segment.finish_time_us >= segment.start_time_us);
      if (!segments.length) continue;
      const start = Math.min(...segments.map((segment) => segment.start_time_us));
      const finish = Math.max(...segments.map((segment) => segment.finish_time_us));
      const activeDuration = segments.reduce((sum, segment) => sum + Math.max(0, segment.finish_time_us - segment.start_time_us), 0);
      spans.push({
        hostname,
        trace_id: traceId,
        parent_span_id: parentSpanId,
        operation_name: operationName,
        span_id: wireSpanId || `__leaf_group_${syntheticLeafId++}`,
        start_time_us: start,
        finish_time_us: finish,
        duration_us: activeDuration,
        segments,
        compact_leaf_group: !wireSpanId,
      });
    }
    return spans;
  }

  function setContext(ctx) {
    const candidate = ctx && ctx.hostId && ctx.queryId
      ? { hostId: String(ctx.hostId), queryId: String(ctx.queryId), runMode: String(ctx.runMode || "normal") }
      : null;
    current = candidate && candidate.runMode === "profiling" ? candidate : null;
    if (dom.analyzeQueryButton) dom.analyzeQueryButton.hidden = !current;
  }

  function close() {
    loadGeneration += 1;
    if (dom.analysisModalBackdrop) dom.analysisModalBackdrop.hidden = true;
    clear(dom.analysisContent);
    releaseData();
  }

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

  function decodedSpans() {
    if (!traceSpans) traceSpans = decodeTraceSpans(payload);
    return traceSpans;
  }

  function renderPipeline() {
    const root = dom.analysisContent;
    clear(root);
    if (!root) return;
    root.classList.remove("traceViewerHost");

    if (!ns.pipelineViewer || typeof ns.pipelineViewer.render !== "function") {
      root.appendChild(emptyState("Pipeline viewer is unavailable."));
      return;
    }

    if (!decodedProcessors) decodedProcessors = ns.analysisData.decodeProcessors(payload);
    const options = {
      processors: decodedProcessors.processors,
      processorTraceSummary: decodedProcessors.processorTraceSummary,
      spans: decodedSpans(),
      attemptIds: Array.isArray(payload?.native_query_ids) ? payload.native_query_ids : [],
      overview: payload?.overview || null,
      truncated: payload?.trace_truncated === true,
      processorsTruncated: payload?.processors_truncated === true,
      summaryTruncated: payload?.processor_trace_summary_truncated === true,
      summaryBucketUs: Number(payload?.processor_trace_bucket_us) || 0,
      traceError: payload?.availability?.opentelemetry_span_log_error || "",
      summaryError: payload?.availability?.processor_trace_summary_error || "",
      error: payload?.availability?.processors_profile_error || "",
      profilingStatus: payload?.processor_profiling_status || "",
      profilingRequested: payload?.processor_profiling_requested === true,
    };
    if (!pipelineModel) pipelineModel = ns.pipelineViewer.buildModel(options);
    ns.pipelineViewer.render(root, { ...options, model: pipelineModel });
  }

  function renderTrace() {
    const root = dom.analysisContent;
    clear(root);
    if (!root) return;
    root.classList.remove("pipelineViewerHost");

    const traceError = payload?.availability?.opentelemetry_span_log_error;
    const spans = decodedSpans();
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

    traceController = ns.traceViewer.render(root, {
      spans,
      attemptIds: Array.isArray(payload?.native_query_ids) ? payload.native_query_ids : [],
      truncated: payload?.trace_truncated === true,
      processorSummaryOverlay: payload?.trace_compact?.processor_summary_overlay === true,
      processorSummaryBucketUs: Number(payload?.trace_compact?.processor_summary_bucket_us) || 0,
      maxRows: 3000,
      emptyText: "No OpenTelemetry spans were recorded for this profiling run.",
    });
  }

  function profilingViews() {
    if (!payload) return { pipeline: true, tracing: true };
    const availability = payload?.availability || {};
    const pipeline = availability.processors_profile_log === true;
    const tracing = availability.opentelemetry_span_log === true;
    return { pipeline, tracing };
  }

  function normalizeActiveTab() {
    const views = profilingViews();
    if (activeTab === "pipeline" && !views.pipeline && views.tracing) activeTab = "tracing";
    else if (activeTab === "tracing" && !views.tracing && views.pipeline) activeTab = "pipeline";
    return views;
  }

  function syncTabs() {
    const views = normalizeActiveTab();
    const showSelector = views.pipeline && views.tracing;
    if (dom.analysisTabs) dom.analysisTabs.hidden = !showSelector;
    const pipelineActive = activeTab === "pipeline";
    if (dom.analysisPipelineTab) {
      dom.analysisPipelineTab.hidden = !views.pipeline;
      dom.analysisPipelineTab.classList.toggle("is-active", pipelineActive);
      dom.analysisPipelineTab.setAttribute("aria-selected", pipelineActive ? "true" : "false");
      dom.analysisPipelineTab.tabIndex = pipelineActive ? 0 : -1;
    }
    if (dom.analysisTraceTab) {
      dom.analysisTraceTab.hidden = !views.tracing;
      dom.analysisTraceTab.classList.toggle("is-active", !pipelineActive);
      dom.analysisTraceTab.setAttribute("aria-selected", pipelineActive ? "false" : "true");
      dom.analysisTraceTab.tabIndex = pipelineActive ? -1 : 0;
    }
    return views;
  }

  function renderActiveTab() {
    const views = syncTabs();
    if (!payload) return;
    try {
      if (!views.pipeline && !views.tracing) {
        clear(dom.analysisContent);
        dom.analysisContent?.appendChild(emptyState("No profiling views are available for this host/query."));
      } else if (activeTab === "tracing") renderTrace();
      else renderPipeline();
    } catch (err) {
      releaseData();
      notice(err instanceof Error ? err.message : String(err), "error");
      clear(dom.analysisContent);
      dom.analysisContent?.appendChild(emptyState("Analysis could not be loaded."));
    }
  }

  function setActiveTab(tab) {
    const views = profilingViews();
    const requested = tab === "tracing" ? "tracing" : "pipeline";
    const next = requested === "tracing"
      ? (views.tracing ? "tracing" : views.pipeline ? "pipeline" : requested)
      : (views.pipeline ? "pipeline" : views.tracing ? "tracing" : requested);
    if (activeTab === next) {
      syncTabs();
      return;
    }
    activeTab = next;
    renderActiveTab();
  }

  async function open(ctx = current) {
    if (ctx && ctx.hostId && ctx.queryId && String(ctx.runMode || "normal") === "profiling") {
      current = { hostId: String(ctx.hostId), queryId: String(ctx.queryId), runMode: "profiling" };
    }
    if (!current) return;
    const generation = ++loadGeneration;
    activeTab = "pipeline";
    syncTabs();
    if (dom.analysisModalBackdrop) dom.analysisModalBackdrop.hidden = false;
    clear(dom.analysisContent);
    notice("Loading ClickHouse execution logs…");
    if (dom.analysisSummary) dom.analysisSummary.textContent = current.queryId;
    try {
      releaseData();
      const response = await api.analyzeQuery(current.hostId, current.queryId);
      if (generation !== loadGeneration) return;
      payload = response;
      renderSummary(payload);
      if (payload.partial_execution) notice("Execution stopped by result preview limit. Metrics describe a partial execution.", "warning");
      else if (payload.logs_pending) notice("ClickHouse system logs are still being populated; available data is shown.", "warning");
      else notice("");
      renderActiveTab();
    } catch (err) {
      if (generation !== loadGeneration) return;
      releaseData();
      notice(err instanceof Error ? err.message : String(err), "error");
      if (dom.analysisContent) {
        clear(dom.analysisContent);
        dom.analysisContent.appendChild(emptyState("Analysis could not be loaded."));
      }
    }
  }

  function init() {
    dom.analyzeQueryButton?.addEventListener("click", () => open());
    dom.analysisPipelineTab?.addEventListener("click", () => setActiveTab("pipeline"));
    dom.analysisTraceTab?.addEventListener("click", () => setActiveTab("tracing"));
    dom.analysisTabs?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const views = profilingViews();
      if (!(views.pipeline && views.tracing)) return;
      setActiveTab(activeTab === "pipeline" ? "tracing" : "pipeline");
      (activeTab === "pipeline" ? dom.analysisPipelineTab : dom.analysisTraceTab)?.focus();
    });
    dom.analysisCloseButton?.addEventListener("click", close);
    dom.analysisModalBackdrop?.addEventListener("click", (event) => { if (event.target === dom.analysisModalBackdrop) close(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && dom.analysisModalBackdrop && !dom.analysisModalBackdrop.hidden) close(); });
    setContext(null);
  }

  ns.analysis = { init, setContext, open, close, setActiveTab };
})();
