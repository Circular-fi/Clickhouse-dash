(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, api, sql, results, util, ui } = ns;

  let activeEventSource = null;
  let lockProgressIndeterminate = false;

  const metricCharts = (() => {
    const maxPoints = 64;

    function cssVar(name) {
      const v = getComputedStyle(dom.root).getPropertyValue(name);
      return String(v || "").trim();
    }

    function ensureCanvas(canvas) {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      const wantW = Math.max(1, Math.floor(w * dpr));
      const wantH = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== wantW || canvas.height !== wantH) {
        canvas.width = wantW;
        canvas.height = wantH;
      }
      const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!ctx) return null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { ctx, w, h };
    }

    function makeSpark(canvas, { fixedMax = null } = {}) {
      const points = [];
      let maxHint = null;

      function push(value, hint) {
        const n = Number(value);
        if (!Number.isFinite(n)) return;
        points.push(n);
        if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
        if (hint != null) {
          const h = Number(hint);
          if (Number.isFinite(h) && h > 0) maxHint = h;
        }
      }

      function clear() {
        points.length = 0;
        maxHint = null;
        render();
      }

      function render() {
        const info = ensureCanvas(canvas);
        if (!info) return;
        const { ctx, w, h } = info;
        ctx.clearRect(0, 0, w, h);
        if (points.length < 2) return;

        const maxPoint = points.reduce((m, v) => (v > m ? v : m), 0);
        const maxValue = fixedMax != null ? fixedMax : maxHint != null ? maxHint : maxPoint;
        const denom = maxValue > 0 ? maxValue : 1;

        const stroke = cssVar("--accentBorder") || "#2563eb";
        const fill = cssVar("--accent") || "rgba(37,99,235,0.14)";

        const n = points.length;
        const dx = w / (n - 1);

        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1;
        ctx.strokeStyle = stroke;

        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = i * dx;
          const y = h - (points[i] / denom) * (h - 2) - 1;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        ctx.globalAlpha = 0.18;
        ctx.fillStyle = fill;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = i * dx;
          const y = h - (points[i] / denom) * (h - 2) - 1;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fill();
      }

      return { push, clear, render };
    }

    const rows = makeSpark(dom.readRowsChart);
    const bytes = makeSpark(dom.readBytesChart);
    const cpu = makeSpark(dom.cpuChart, { fixedMax: 100 });
    const memory = makeSpark(dom.memoryChart);
    const threads = makeSpark(dom.threadChart);

    function reset() {
      rows.clear();
      bytes.clear();
      cpu.clear();
      memory.clear();
      threads.clear();
    }

    function pushTick({ rowsPerSec, bytesPerSec, cpuPct, memInst, memMax, thrInst, thrMax }) {
      rows.push(rowsPerSec);
      bytes.push(bytesPerSec);
      cpu.push(cpuPct);
      memory.push(memInst, memMax);
      threads.push(thrInst, thrMax);
    }

    function renderAll() {
      rows.render();
      bytes.render();
      cpu.render();
      memory.render();
      threads.render();
    }

    let rafId = 0;
    function scheduleRender() {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        renderAll();
      });
    }

    window.addEventListener(
      "resize",
      () => {
        scheduleRender();
      },
      { passive: true }
    );

    return { reset, pushTick, renderAll, scheduleRender };
  })();

  function formatIntShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    if (abs < 1000) return `${sign}${Math.round(abs)}`;
    if (abs < 1e6) return `${sign}${(abs / 1e3).toFixed(abs < 1e4 ? 2 : 1)}k`;
    if (abs < 1e9) return `${sign}${(abs / 1e6).toFixed(abs < 1e7 ? 2 : 1)}M`;
    return `${sign}${(abs / 1e9).toFixed(abs < 1e10 ? 2 : 1)}B`;
  }

  function formatSecondsFromMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "-";
    const s = n / 1000;
    if (s < 10) return `${s.toFixed(3)}s`;
    if (s < 100) return `${s.toFixed(2)}s`;
    if (s < 1000) return `${s.toFixed(1)}s`;
    return `${Math.round(s)}s`;
  }

  function formatSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "-";
    if (n < 10) return `${n.toFixed(3)}s`;
    if (n < 100) return `${n.toFixed(2)}s`;
    if (n < 1000) return `${n.toFixed(1)}s`;
    return `${Math.round(n)}s`;
  }

  function formatBytesShort(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return "-";
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let v = n;
    let u = -1;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    const d = v < 10 ? 2 : v < 100 ? 1 : 0;
    return `${v.toFixed(d)} ${units[u]}`;
  }

  function formatPercentFromCenti(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${(n / 100).toFixed(1)}%`;
  }

  function resetMetrics() {
    lockProgressIndeterminate = false;
    util.setText(dom.elapsedSecondsText, "-");
    util.setText(dom.progressPercentText, "-");
    util.setText(dom.readRowsRateText, "-");
    util.setText(dom.readRowsTotalText, "-");
    util.setText(dom.readBytesRateText, "-");
    util.setText(dom.readBytesTotalText, "-");
    util.setText(dom.cpuText, "-");
    util.setText(dom.cpuMaxText, "-");
    util.setText(dom.memoryText, "-");
    util.setText(dom.memoryMaxText, "-");
    util.setText(dom.threadText, "-");
    util.setText(dom.threadMaxText, "-");
    if (dom.progressCard) {
      dom.progressCard.classList.remove("is-indeterminate");
      dom.progressCard.style.setProperty("--p", "0");
    }
    metricCharts.reset();
  }

  function setProgressIndeterminate(enabled) {
    if (!dom.progressCard) return;
    dom.progressCard.classList.toggle("is-indeterminate", !!enabled);
  }

  function applyTickMetrics(arr) {
    if (!Array.isArray(arr) || arr.length < 14) return;

    const elapsedMs = Number(arr[0]);
    const percentCenti = Number(arr[1]);
    const knownInt = Number(arr[2]);
    const readRowsTotal = Number(arr[3]);
    const readBytesTotal = Number(arr[4]);
    const rowsPerSec = Number(arr[6]);
    const bytesPerSec = Number(arr[7]);
    const cpuCenti = Number(arr[8]);
    const cpuMaxCenti = Number(arr[9]);
    const memInst = arr[10] == null ? null : Number(arr[10]);
    const memMax = arr[11] == null ? null : Number(arr[11]);
    const thrInst = Number(arr[12]);
    const thrMax = Number(arr[13]);

    util.setText(dom.elapsedSecondsText, formatSecondsFromMs(elapsedMs));

    if (knownInt === 1 && Number.isFinite(percentCenti)) {
      const pct = Math.max(0, Math.min(100, percentCenti / 100));
      util.setText(dom.progressPercentText, `${pct.toFixed(2)}%`);
      if (dom.progressCard) dom.progressCard.style.setProperty("--p", String(pct / 100));
      setProgressIndeterminate(false);
    } else {
      util.setText(dom.progressPercentText, "-");
      if (state.isRunning && !lockProgressIndeterminate) setProgressIndeterminate(true);
      else setProgressIndeterminate(false);
    }

    util.setText(dom.readRowsRateText, `${formatIntShort(rowsPerSec)}/s`);
    util.setText(dom.readRowsTotalText, formatIntShort(readRowsTotal));

    util.setText(dom.readBytesRateText, `${formatBytesShort(bytesPerSec)}/s`);
    util.setText(dom.readBytesTotalText, formatBytesShort(readBytesTotal));

    util.setText(dom.cpuText, formatPercentFromCenti(cpuCenti));
    util.setText(dom.cpuMaxText, formatPercentFromCenti(cpuMaxCenti));

    util.setText(dom.memoryText, memInst == null ? "-" : formatBytesShort(memInst));
    util.setText(dom.memoryMaxText, memMax == null ? "-" : formatBytesShort(memMax));

    util.setText(dom.threadText, Number.isFinite(thrInst) ? String(thrInst) : "-");
    util.setText(dom.threadMaxText, Number.isFinite(thrMax) ? String(thrMax) : "-");

    metricCharts.pushTick({
      rowsPerSec,
      bytesPerSec,
      cpuPct: Number.isFinite(cpuCenti) ? cpuCenti / 100 : NaN,
      memInst: memInst == null ? NaN : memInst,
      memMax: memMax == null ? null : memMax,
      thrInst,
      thrMax,
    });
    metricCharts.scheduleRender();
  }

  function applyDoneMetrics(done) {
    if (!done || typeof done !== "object") return;
    lockProgressIndeterminate = true;
    if (done.elapsed_seconds != null) util.setText(dom.elapsedSecondsText, formatSeconds(done.elapsed_seconds));
    if (done.read_rows != null) util.setText(dom.readRowsTotalText, formatIntShort(done.read_rows));
    if (done.read_bytes != null) util.setText(dom.readBytesTotalText, formatBytesShort(done.read_bytes));
    setProgressIndeterminate(false);
    metricCharts.scheduleRender();
  }

  function setQueryIdText(queryId) {
    util.setText(dom.queryIdentifierText, queryId ? `#${queryId}` : "#-");
  }

  function setQueryStatusText(value) {
    util.setText(dom.queryStatusText, value || "-");
  }

  function closeActiveStream() {
    if (!activeEventSource) return;
    try {
      activeEventSource.close();
    } catch {
      return;
    } finally {
      activeEventSource = null;
    }
  }

  function updateActionButtons() {
    const busy = state.isRunning || state.isFormatting;
    if (dom.runButton) dom.runButton.disabled = busy;
    if (dom.formatButton) dom.formatButton.disabled = busy;

    if (dom.cancelButton) {
      dom.cancelButton.disabled = state.isFormatting;
      dom.cancelButton.textContent = state.isRunning ? "Cancel" : "Clear";
    }
  }

  function setBusy({ running, formatting, batch }) {
    state.isRunning = !!running;
    state.isFormatting = !!formatting;
    state.isBatchRun = !!batch;
    updateActionButtons();
  }

  function getSelectedHostId() {
    return state.selectedHostId;
  }

  async function handleCopyLiveJson() {
    try {
      const copyText = results.buildCopyJsonText();
      await util.copyTextToClipboard(copyText);
      util.flashButtonText(dom.copyJsonButton, { copiedText: "Copied" });
    } catch {
      return;
    }
  }

  async function formatEditorSql() {
    const hostId = getSelectedHostId();
    const raw = dom.queryTextArea ? dom.queryTextArea.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) throw new Error("Nothing to format.");

    const statements = sql.splitSqlStatements(trimmed);
    if (!statements.length) throw new Error("Nothing to format.");

    const formatted = await api.formatSqls(hostId, statements);
    const normalized = formatted.map(sql.normalizeStatementText).filter(Boolean);
    const joined = sql.joinSqlStatements(normalized);

    if (dom.queryTextArea) dom.queryTextArea.value = joined;

    storage.addHistoryEntry({
      ts_ms: Date.now(),
      host_id: hostId,
      sql_raw: trimmed,
      sql_formatted: joined,
    });

    return normalized;
  }

  function parseSseJson(ev) {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  }

  function streamQuery(streamUrl) {
    return new Promise((resolve) => {
      let doneReceived = false;
      let sseErrorEventReceived = false;

      const es = new EventSource(streamUrl);
      activeEventSource = es;

      es.addEventListener("result_meta", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        const cols = Array.isArray(data.columns) ? data.columns : [];
        const types = Array.isArray(data.types) ? data.types : [];
        results.renderTableMeta(cols, types);
      });

      es.addEventListener("result_rows", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        results.appendRows(Array.isArray(data.rows) ? data.rows : []);
      });

      es.addEventListener("tick", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        if (lockProgressIndeterminate) return;
        applyTickMetrics(data);
      });

      es.addEventListener("error", (ev) => {
        if (!ev || typeof ev.data !== "string" || !ev.data) return;
        const data = parseSseJson(ev);
        if (!data) return;
        sseErrorEventReceived = true;
        const msg = data && data.message ? String(data.message) : "Query error.";
        results.setError(msg);
        results.setStatus("error");
        lockProgressIndeterminate = true;
        setProgressIndeterminate(false);
      });

      es.addEventListener("done", (ev) => {
        const data = parseSseJson(ev) || {};
        doneReceived = true;
        const st = data && data.status ? String(data.status) : "done";
        results.setStatus(st);
        if (st.toLowerCase() === "error" && data && data.message) {
          const current = dom.errorBanner && !dom.errorBanner.hidden ? String(dom.errorBanner.textContent || "") : "";
          if (!current.trim()) results.setError(String(data.message));
        }
        applyDoneMetrics(data);
        closeActiveStream();
        resolve({ ...data, status: st });
      });

      es.onerror = () => {
        if (doneReceived || sseErrorEventReceived) return;
        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        if (errVisible) return;
        results.setError("Connection lost.");
        results.setStatus("error");
        lockProgressIndeterminate = true;
        setProgressIndeterminate(false);
        closeActiveStream();
        resolve({ status: "error" });
      };
    });
  }

  function getLiveRowCount() {
    if (!dom.resultTableBody) return 0;
    return dom.resultTableBody.querySelectorAll("tr").length;
  }

  function getLiveColCount() {
    if (!dom.resultTableHead) return 0;
    const tr = dom.resultTableHead.querySelector("tr");
    if (!tr) return 0;
    return tr.querySelectorAll("th").length;
  }

  function statusLabel(status) {
    const s = String(status || "").toLowerCase();
    if (s === "finished") return "finished";
    if (s === "done") return "done";
    if (s === "error") return "error";
    if (s === "canceled" || s === "cancelled") return "canceled";
    if (s === "result_limit_reached") return "limit reached";
    return s || "-";
  }

  async function runOneStatement(statement) {
    resetMetrics();
    setProgressIndeterminate(true);

    const hostId = getSelectedHostId();
    const { queryId, cancelToken, streamUrl } = await api.runSql(hostId, statement);

    state.activeQueryId = queryId;
    state.cancelToken = cancelToken;

    setQueryIdText(queryId);
    setQueryStatusText("running");
    results.setStatus("running");

    const done = await streamQuery(streamUrl);

    const finalStatus = done && done.status ? String(done.status) : "done";
    setQueryStatusText(statusLabel(finalStatus));
    results.setStatus(finalStatus);

    state.activeQueryId = null;
    state.cancelToken = null;

    return done;
  }

  async function handleRun() {
    if (state.isRunning || state.isFormatting) return;

    results.setError("");
    ui && ui.closeRunMenu && ui.closeRunMenu({ immediate: false });

    const hostId = getSelectedHostId();
    if (!hostId) {
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    const raw = dom.queryTextArea ? dom.queryTextArea.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    let statements = sql.splitSqlStatements(trimmed);
    if (!statements.length) {
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    if (statements.length > 1 && !state.runOptMultiQuery) {
      results.setError("Multiquery is disabled. Enable \u201cAllow multiquery\u201d in the Run menu.");
      results.setStatus("error");
      return;
    }

    results.clearResultsStack();
    results.clearLiveResults();
    resetMetrics();
    setQueryIdText(null);
    setQueryStatusText("running");

    if (statements.length > 1) {
      state.lastRunMode = "batch";
      results.setMultiqueryMode(true);
    } else {
      state.lastRunMode = "single";
      results.setMultiqueryMode(false);
    }

    setBusy({ running: true, formatting: false, batch: statements.length > 1 });
    state.batchStopRequested = false;

    try {
      if (state.runOptAutoFormat) {
        const formattedStatements = await formatEditorSql();
        statements = formattedStatements;
      }

      storage.addHistoryEntry({
        ts_ms: Date.now(),
        host_id: hostId,
        sql_raw: trimmed,
        sql_formatted: dom.queryTextArea ? dom.queryTextArea.value : trimmed,
      });

      if (statements.length === 1) {
        await runOneStatement(statements[0]);
        if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
        return;
      }

      const total = statements.length;

      for (let i = 0; i < total; i++) {
        if (state.batchStopRequested) break;

        results.clearLiveResults();
        resetMetrics();
        setQueryIdText(null);
        setQueryStatusText(`running (${i + 1}/${total})`);

        const stmt = statements[i];
        const done = await runOneStatement(stmt);

        const st = done && done.status ? String(done.status) : "done";
        const rows = getLiveRowCount();
        const cols = getLiveColCount();

        const metaParts = [
          statusLabel(st),
          done && done.elapsed_seconds != null ? formatSeconds(done.elapsed_seconds) : "-",
          `${rows} ${rows === 1 ? "row" : "rows"}`,
          `${cols} ${cols === 1 ? "column" : "columns"}`,
        ];
        if (done && done.read_rows != null) metaParts.push(`read ${formatIntShort(done.read_rows)}`);
        if (done && done.read_bytes != null) metaParts.push(`disk ${formatBytesShort(done.read_bytes)}`);
        if (done && done.result_truncated) metaParts.push("truncated");
        const metaText = metaParts.filter((x) => String(x || "").trim()).join(" \u00b7 ");

        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        const expandedByDefault = errVisible || ["error", "canceled", "cancelled"].includes(String(st).toLowerCase());

        const copyText = results.buildCopyJsonText();
        results.pushResultsBlock(`Query ${i + 1}/${total}`, metaText, copyText, { expandedByDefault });

        if (["error", "canceled", "cancelled"].includes(String(st).toLowerCase())) {
          state.batchStopRequested = true;
          break;
        }
      }

      results.hideLiveWrapIfStackHasBlocks();
      setQueryIdText(null);
      setQueryStatusText("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.setError(msg);
      results.setStatus("error");
      setQueryStatusText("error");
    } finally {
      closeActiveStream();
      state.cancelToken = null;
      state.activeQueryId = null;
      setBusy({ running: false, formatting: false, batch: false });
    }
  }

  async function handleFormat() {
    if (state.isRunning || state.isFormatting) return;

    results.setError("");
    const hostId = getSelectedHostId();
    if (!hostId) {
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    setBusy({ running: false, formatting: true, batch: false });

    try {
      await formatEditorSql();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.setError(msg);
      results.setStatus("error");
    } finally {
      setBusy({ running: false, formatting: false, batch: false });
    }
  }

  async function handleCancelOrClear() {
    if (state.isFormatting) return;

    if (!state.isRunning) {
      closeActiveStream();
      state.batchStopRequested = false;
      state.cancelToken = null;
      state.activeQueryId = null;
      state.lastRunMode = "single";
      results.setMultiqueryMode(false);
      results.clearResultsStack();
      results.clearLiveResults();
      resetMetrics();
      setQueryIdText(null);
      setQueryStatusText("-");
      updateActionButtons();
      return;
    }

    state.batchStopRequested = true;

    const token = state.cancelToken;
    if (!token) {
      results.setError("No active query to cancel.");
      results.setStatus("error");
      return;
    }

    try {
      const ok = await api.cancelQuery(token);
      if (ok && state.isBatchRun) {
        results.setError("Query canceled successfully.");
        results.setStatus("canceled");
        lockProgressIndeterminate = true;
        setProgressIndeterminate(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.setError(msg);
      results.setStatus("error");
    }
  }

  function init() {
    updateActionButtons();
    metricCharts.renderAll();
    if (dom.runButton) dom.runButton.addEventListener("click", handleRun);
    if (dom.formatButton) dom.formatButton.addEventListener("click", handleFormat);
    if (dom.cancelButton) dom.cancelButton.addEventListener("click", handleCancelOrClear);
    if (dom.copyJsonButton) dom.copyJsonButton.addEventListener("click", handleCopyLiveJson);
  }

  ns.run = { init, handleRun, handleFormat, handleCancelOrClear, updateActionButtons };
})();
