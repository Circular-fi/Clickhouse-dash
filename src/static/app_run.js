(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, api, sql, results, util, ui } = ns;

  let activeEventSource = null;
  let lockProgressIndeterminate = false;

  const series = {
    readRowsPerSec: [],
    readBytesPerSec: [],
    cpu: [],
    memBytes: [],
    threads: [],
  };

  const MAX_STORE_POINTS = 2400;
  const EPS_T = 1e-9;

  let chartsScheduled = false;

  function getCssVar(name, fallback = "") {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  }

  function pushPointMonotone(arr, t, v) {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    const n = arr.length;
    if (n === 0) {
      arr.push({ t, v });
      return;
    }
    const last = arr[n - 1];
    if (t < last.t - EPS_T) return;
    if (Math.abs(t - last.t) <= EPS_T) {
      last.v = v;
      return;
    }
    arr.push({ t, v });
    if (arr.length > MAX_STORE_POINTS) {
      arr.splice(0, arr.length - MAX_STORE_POINTS);
    }
  }

  function prepareCanvas(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx, w, h };
  }

  function quantile(values, q) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[idx];
  }

  function computeAutoMax(points, opts) {
    const q = opts.autoMaxQuantile;
    if (!q || !Array.isArray(points) || points.length < 2) return null;
    const vals = [];
    for (const p of points) if (Number.isFinite(p.v)) vals.push(p.v);
    if (vals.length === 0) return null;
    const qv = quantile(vals, q);
    if (qv == null) return null;
    return qv * (opts.autoMaxPadFactor ?? 1.10);
  }

  function decimate(points, maxPoints) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    const out = [];
    for (let i = 0; i < points.length; i += step) out.push(points[i]);
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  function drawSparkline(canvas, points, opts = {}) {
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const { ctx, w, h } = prepared;

    ctx.clearRect(0, 0, w, h);

    const pad = Math.round(h * 0.10);
    const topReserved = Math.round(h * 0.46);
    const x0 = pad;
    const y0 = topReserved;
    const x1 = w - pad;
    const y1 = h - pad;

    const border = getCssVar("--border", "rgba(148,163,184,0.14)");
    ctx.globalAlpha = 1;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.floor(x0) + 0.5, Math.floor(y0) + 0.5, Math.floor(x1 - x0), Math.floor(y1 - y0));

    if (!Array.isArray(points) || points.length === 0) return;

    const drawable = decimate(points, Math.max(80, Math.floor(w * 1.2)));
    if (drawable.length === 1) {
      const p = drawable[0];
      const line = opts.lineColor || getCssVar("--accentBorder", "#2563eb");
      ctx.globalAlpha = 0.70;
      ctx.fillStyle = line;
      ctx.beginPath();
      ctx.arc(Math.floor((x0 + x1) * 0.5), Math.floor((y0 + y1) * 0.5), 3, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const tMin = drawable[0].t;
    const tMax = drawable[drawable.length - 1].t;
    const tSpan = Math.max(1e-12, tMax - tMin);

    const vMin = opts.min ?? 0;

    let vMax = null;
    if (opts.max != null && Number.isFinite(opts.max)) {
      vMax = opts.max;
    } else {
      const auto = computeAutoMax(drawable, opts);
      if (auto != null && Number.isFinite(auto)) vMax = auto;
      else {
        let m = -Infinity;
        for (const p of drawable) if (Number.isFinite(p.v)) m = Math.max(m, p.v);
        vMax = Number.isFinite(m) ? m : (vMin + 1);
      }
    }

    const minMax = opts.minMax ?? null;
    if (minMax != null && Number.isFinite(minMax)) vMax = Math.max(vMax, minMax);
    if (!Number.isFinite(vMax) || vMax <= vMin) vMax = vMin + 1;

    const line = opts.lineColor || getCssVar("--accentBorder", "#2563eb");
    const fillAlpha = opts.fillAlpha ?? 0.12;

    function X(t) {
      return x0 + ((t - tMin) / tSpan) * (x1 - x0);
    }

    function Y(v) {
      const vv = opts.clampMax ? Math.min(v, vMax) : v;
      return y1 - ((vv - vMin) / (vMax - vMin)) * (y1 - y0);
    }

    ctx.beginPath();
    ctx.moveTo(X(drawable[0].t), y1);
    for (const p of drawable) ctx.lineTo(X(p.t), Y(p.v));
    ctx.lineTo(X(drawable[drawable.length - 1].t), y1);
    ctx.closePath();
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = line;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(X(drawable[0].t), Y(drawable[0].v));
    for (let i = 1; i < drawable.length; i++) ctx.lineTo(X(drawable[i].t), Y(drawable[i].v));
    ctx.globalAlpha = 0.90;
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  function renderCharts() {
    drawSparkline(dom.readRowsChart, series.readRowsPerSec, { min: 0 });
    drawSparkline(dom.readBytesChart, series.readBytesPerSec, { min: 0 });

    drawSparkline(dom.cpuChart, series.cpu, {
      min: 0,
      autoMaxQuantile: 0.98,
      autoMaxPadFactor: 1.10,
      minMax: 100,
      clampMax: true,
    });

    drawSparkline(dom.memoryChart, series.memBytes, { min: 0 });
    drawSparkline(dom.threadChart, series.threads, { min: 0 });
  }

  function scheduleChartsRender() {
    if (chartsScheduled) return;
    chartsScheduled = true;
    requestAnimationFrame(() => {
      chartsScheduled = false;
      renderCharts();
    });
  }

  function resetCharts() {
    series.readRowsPerSec.length = 0;
    series.readBytesPerSec.length = 0;
    series.cpu.length = 0;
    series.memBytes.length = 0;
    series.threads.length = 0;
    scheduleChartsRender();
  }

  function formatShort(value, mul = 1000, units = ['k', 'M', 'B', 'T'], fixed=2, space=false) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    const sign = n < 0 ? '-' : '';
    if (n < mul) return `${Math.round(n)} B`;
    let v = Math.abs(n);
    let u = -1;
    while (v >= mul && u < units.length - 1) {
      v /= mul;
      u++;
    }
    const d = u > 1 ? 2 : 0;
    return `${sign}${v.toFixed(fixed)}${space?' ':''}${units[u]}`;
  }

  function formatBytesShort(value) {
    return formatShort(value, 1024, ["KiB", "MiB", "GiB", "TiB"],  2, true);
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

  function formatPercentFromCenti(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${(n / 100).toFixed(2)}%`;
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
    resetCharts();
  }

  function resetLiveMetrics() {
    lockProgressIndeterminate = false;
    // util.setText(dom.elapsedSecondsText, "-");
    // util.setText(dom.progressPercentText, "-");
    util.setText(dom.readRowsRateText, "-");
    util.setText(dom.readBytesRateText, "-");
    util.setText(dom.cpuText, "-");
    util.setText(dom.memoryText, "-");
    util.setText(dom.threadText, "-");
  }

  function setProgressIndeterminate(enabled) {
    if (!dom.progressCard) return;
    dom.progressCard.classList.toggle("is-indeterminate", !!enabled);
  }

  function applyTickMetrics(arr, agg) {
    if (!Array.isArray(arr) || arr.length < 14) return;

    const elapsedMs = Number(arr[0]);
    const percentCenti = Number(arr[1]);
    const percentKnown = !!arr[2];
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
    const samples = Array.isArray(arr[14]) ? arr[14] : null;

    if (Number.isFinite(elapsedMs)) util.setText(dom.elapsedSecondsText, formatSecondsFromMs(elapsedMs));

    if (percentKnown && Number.isFinite(percentCenti)) {
      const pct = Math.max(0, Math.min(100, percentCenti / 100));
      util.setText(dom.progressPercentText, `${pct.toFixed(2)}%`);
      if (dom.progressCard) dom.progressCard.style.setProperty("--p", String(pct / 100));
      setProgressIndeterminate(false);
    } else {
      util.setText(dom.progressPercentText, "-");
      if (state.isRunning && !lockProgressIndeterminate) setProgressIndeterminate(true);
      else setProgressIndeterminate(false);
    }

    if (Number.isFinite(rowsPerSec)) util.setText(dom.readRowsRateText, `${formatShort(rowsPerSec)}/s`);
    if (Number.isFinite(readRowsTotal)) util.setText(dom.readRowsTotalText, formatShort(readRowsTotal));

    if (Number.isFinite(bytesPerSec)) util.setText(dom.readBytesRateText, `${formatBytesShort(bytesPerSec)}/s`);
    if (Number.isFinite(readBytesTotal)) util.setText(dom.readBytesTotalText, formatBytesShort(readBytesTotal));

    util.setText(dom.cpuText, formatPercentFromCenti(cpuCenti));
    util.setText(dom.cpuMaxText, formatPercentFromCenti(cpuMaxCenti));

    util.setText(dom.memoryText, memInst == null ? "-" : formatBytesShort(memInst));
    util.setText(dom.memoryMaxText, memMax == null ? "-" : formatBytesShort(memMax));

    util.setText(dom.threadText, Number.isFinite(thrInst) ? String(thrInst) : "-");
    util.setText(dom.threadMaxText, Number.isFinite(thrMax) ? String(thrMax) : "-");

    if (agg) {
      if (Number.isFinite(readRowsTotal)) agg.lastReadRows = readRowsTotal;
      if (Number.isFinite(readBytesTotal)) agg.lastReadBytes = readBytesTotal;
      if (Number.isFinite(cpuMaxCenti)) agg.cpuMaxCenti = Math.max(agg.cpuMaxCenti, cpuMaxCenti);
      if (Number.isFinite(memMax)) agg.memMax = Math.max(agg.memMax, memMax);
      if (Number.isFinite(thrMax)) agg.thrMax = Math.max(agg.thrMax, thrMax);

      const tSec = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : null;
      if (tSec != null) {
        if (Number.isFinite(rowsPerSec) && rowsPerSec >= 0) pushPointMonotone(series.readRowsPerSec, tSec, rowsPerSec);
        if (Number.isFinite(bytesPerSec) && bytesPerSec >= 0) pushPointMonotone(series.readBytesPerSec, tSec, bytesPerSec);
        if (Number.isFinite(cpuCenti)) pushPointMonotone(series.cpu, tSec, cpuCenti / 100);
        if (memInst != null && Number.isFinite(memInst)) pushPointMonotone(series.memBytes, tSec, memInst);
        if (Number.isFinite(thrInst)) pushPointMonotone(series.threads, tSec, thrInst);
      }

      if (samples && Array.isArray(samples) && samples.length > 0) {
        for (const s of samples) {
          if (!Array.isArray(s) || s.length < 2) continue;
          const sm = Number(s[0]);
          const st = Number.isFinite(sm) ? sm / 1000 : null;
          if (st == null) continue;

          const rb = Number(s[1]);
          const cpu = s[2] == null ? null : Number(s[2]);
          const mem = s[3] == null ? null : Number(s[3]);
          const thr = s[4] == null ? null : Number(s[4]);

          if (cpu != null && Number.isFinite(cpu)) pushPointMonotone(series.cpu, st, cpu / 100);
          if (mem != null && Number.isFinite(mem)) pushPointMonotone(series.memBytes, st, mem);
          if (thr != null && Number.isFinite(thr)) pushPointMonotone(series.threads, st, thr);

          if (Number.isFinite(rb) && agg.lastSampleReadBytes != null && agg.lastSampleReadBytesT != null) {
            const dt = st - agg.lastSampleReadBytesT;
            if (dt > 1e-9) {
              const bps = (rb - agg.lastSampleReadBytes) / dt;
              if (Number.isFinite(bps) && bps >= 0) pushPointMonotone(series.readBytesPerSec, st, bps);
            }
          }

          if (Number.isFinite(rb)) {
            agg.lastSampleReadBytes = rb;
            agg.lastSampleReadBytesT = st;
          }
        }
      }
    }

    scheduleChartsRender();
  }

  function applyDoneMetrics(done, agg) {
    if (!done || typeof done !== "object") return;
    lockProgressIndeterminate = true;
    if (done.elapsed_seconds != null) util.setText(dom.elapsedSecondsText, util.formatSeconds(done.elapsed_seconds));

    const rr = done.read_rows != null ? Number(done.read_rows) : null;
    const rb = done.read_bytes != null ? Number(done.read_bytes) : null;

    if (rr != null && Number.isFinite(rr) && rr > 0) util.setText(dom.readRowsTotalText, formatShort(rr));
    else if (agg && agg.lastReadRows != null) util.setText(dom.readRowsTotalText, formatShort(agg.lastReadRows));

    if (rb != null && Number.isFinite(rb) && rb > 0) util.setText(dom.readBytesTotalText, formatBytesShort(rb));
    else if (agg && agg.lastReadBytes != null) util.setText(dom.readBytesTotalText, formatBytesShort(agg.lastReadBytes));

    setProgressIndeterminate(false);
  }

  function setQueryIdText(queryId) {
    util.setText(dom.queryIdentifierText, queryId ? `#${queryId}` : "#-");
  }

  // Prevent out-of-order SSE/UI updates from regressing the status text.
  // Example: if a "done/canceled" arrives before the click-handler sets
  // "canceling", we must NOT allow the later "canceling" to overwrite it.
  const STATUS_RANK = {
    "-": 0,
    connected: 10,
    running: 20,
    canceling: 30,
    done: 40,
    canceled: 50,
    error: 60,
  };

  function normalizeStatusText(value) {
    if (!value) return "-";
    const v = String(value).toLowerCase();
    if (v === "cancelled") return "canceled";
    if (v === "finished" || v === "success") return "done";
    return v;
  }

  function setQueryStatusText(value, opts) {
    const force = !!(opts && opts.force);
    const next = normalizeStatusText(value);
    const nextRank = STATUS_RANK[next] ?? STATUS_RANK["-"];
    const cur = state.queryStatusText || "-";
    const curRank = STATUS_RANK[cur] ?? STATUS_RANK["-"];

    // Allow upgrades, block regressions (unless forced).
    if (!force && nextRank < curRank) return;

    state.queryStatusText = next;
    util.setText(dom.queryStatusText, next || "-");
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
    if (dom.runMenuButton) dom.runMenuButton.disabled = busy;
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
      const copyText = perQuerySink && perQuerySink.buildCopyJsonText ? perQuerySink.buildCopyJsonText() : results.buildCopyJsonText();
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
    if (!Array.isArray(formatted) || formatted.length !== statements.length) {
      const err = new Error("format_failed: Invalid format response.");
      err.code = "format_failed";
      throw err;
    }

    const normalized = formatted.map(sql.normalizeStatementText).filter(Boolean);
    const joined = sql.joinSqlStatements(normalized);

    if (dom.queryTextArea) util.replaceTextAreaValue(dom.queryTextArea, joined);

    storage.addHistoryEntry({
      ts_ms: Date.now(),
      host_id: hostId,
      sql_raw: trimmed,
      sql_formatted: joined,
    });

    return normalized;
  }

  function isFormatFailedError(err) {
    const code = err && err.code ? String(err.code) : "";
    const payloadCode = err && err.payload && err.payload.error_code ? String(err.payload.error_code) : "";
    return code === "format_failed" || payloadCode === "format_failed";
  }

  function buildFormatErrorText(err) {
    const payload = err && err.payload ? err.payload : null;
    const code = payload && payload.error_code ? String(payload.error_code) : err && err.code ? String(err.code) : "";
    const msg = payload && payload.message ? String(payload.message) : err instanceof Error ? String(err.message || "") : String(err || "");
    const clean = msg.trim();
    if (!code) return clean || "Format failed.";
    if (clean.toLowerCase().startsWith(code.toLowerCase() + ":")) return clean;
    return `${code}: ${clean || "Format failed."}`;
  }

  function showFormatFailure(err) {
    const msg = buildFormatErrorText(err);
    results.clearResultsStack();
    results.clearLiveResults();
    results.setError(msg);
    results.setStatus("error");
    setQueryStatusText("error");
    results.setResultsVisible(true);
    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
  }

  function parseSseJson(ev) {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  }

  function createStatementAgg() {
    return {
      lastReadRows: null,
      lastReadBytes: null,
      cpuMaxCenti: 0,
      memMax: 0,
      thrMax: 0,
      lastSampleReadBytes: null,
      lastSampleReadBytesT: null,
      terminal: false,
    };
  }

  
function makeStreamSink(sink) {
  // Sink can redirect table meta/rows rendering to a per-query panel during multiquery.
  // If not provided, fall back to the global results renderer.
  const s = sink && typeof sink === "object" ? sink : null;

  const api = {
    // Table streaming
    renderTableMeta: (cols, types) => {
      if (s && typeof s.renderTableMeta === "function") return s.renderTableMeta(cols, types);
      if (results && typeof results.renderTableMeta === "function") return results.renderTableMeta(cols, types);
    },
    appendRows: (rows) => {
      if (s && typeof s.appendRows === "function") return s.appendRows(rows);
      if (results && typeof results.appendRows === "function") return results.appendRows(rows);
    },
    clearLiveResults: () => {
      if (s && typeof s.clearLiveResults === "function") return s.clearLiveResults();
      if (results && typeof results.clearLiveResults === "function") return results.clearLiveResults();
    },
    // Errors/status (still global unless sink overrides)
    setError: (msg) => {
      if (s && typeof s.setError === "function") return s.setError(msg);
      if (results && typeof results.setError === "function") return results.setError(msg);
    },
    getErrorText: () => {
      if (s && typeof s.getErrorText === "function") return s.getErrorText();
      if (results && typeof results.getErrorText === "function") return results.getErrorText();
      return "";
    },
    setStatus: (st) => {
      if (s && typeof s.setStatus === "function") return s.setStatus(st);
      if (results && typeof results.setStatus === "function") return results.setStatus(st);
    },
    finalizeAfterDone: () => {
      if (s && typeof s.finalizeAfterDone === "function") return s.finalizeAfterDone();
      if (results && typeof results.finalizeAfterDone === "function") return results.finalizeAfterDone();
    },
  };

  return api;
}

function streamQuery(streamUrl, agg, sink) {
    return new Promise((resolve) => {
      const streamSink = makeStreamSink(sink);
      let doneReceived = false;
      let sseErrorEventReceived = false;

      const es = new EventSource(streamUrl);
      activeEventSource = es;

      es.addEventListener("meta", (ev) => {
        const data = parseSseJson(ev);
        if (data && data.status) {
          const st = String(data.status);
          if (st) setQueryStatusText(st);
        }
      });

      es.addEventListener("result_meta", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        const cols = Array.isArray(data.columns) ? data.columns : [];
        const types = Array.isArray(data.types) ? data.types : [];
        streamSink.renderTableMeta(cols, types);
      });

      es.addEventListener("result_rows", (ev) => {
        const data = parseSseJson(ev);
        if (!data) return;
        streamSink.appendRows(Array.isArray(data.rows) ? data.rows : []);
      });

      es.addEventListener("tick", (ev) => {
        if (agg && agg.terminal) return;
        const data = parseSseJson(ev);
        if (!data) return;
        applyTickMetrics(data, agg);
      });

      es.addEventListener("error", (ev) => {
        if (!ev || typeof ev.data !== "string" || !ev.data) return;
        const data = parseSseJson(ev);
        if (!data) return;
        sseErrorEventReceived = true;
        const msg = data && data.message ? String(data.message) : "Query error.";
        streamSink.setError(msg);
        streamSink.setStatus("error");
        lockProgressIndeterminate = true;
        if (agg) agg.terminal = true;
        setProgressIndeterminate(false);
      });

      es.addEventListener("done", (ev) => {
        const data = parseSseJson(ev) || {};
        doneReceived = true;
        const st = data && data.status ? String(data.status) : "done";

        if (st) setQueryStatusText(st);
        state.cancelRequested = false;
        streamSink.setStatus(st);

        // Keep the global run status in sync when a query terminates with an error/cancel.
        // (The bottom-right dashboard indicator is global, not per-query.)
        const lowerGlobal = String(st).toLowerCase();
        if (lowerGlobal === "canceled" || lowerGlobal === "cancelled") {
          if (results && typeof results.setStatus === "function") results.setStatus("canceled");
        } else if (lowerGlobal === "error") {
          if (results && typeof results.setStatus === "function") results.setStatus("error");
        }

        const lower = st.toLowerCase();
        // In multiquery, cancellation must be shown in the active query panel, not the global banner.
        // In single-query, streamSink maps to the global renderer anyway.
        if (lower === "canceled" || lower === "cancelled") {
          const hasLocalErr = typeof streamSink.getErrorText === "function" && String(streamSink.getErrorText() || "").trim().length > 0;
          if (!hasLocalErr) streamSink.setError("Query canceled.");
        }

        if (lower === "finished") {
          util.setText(dom.progressPercentText, "100.00%");
          if (dom.progressCard) dom.progressCard.style.setProperty("--p", "1");
        }

        applyDoneMetrics(data, agg);
        streamSink.finalizeAfterDone();

        if (agg) agg.terminal = true;
        closeActiveStream();
        resolve({ ...data, status: st });
      });

      es.onerror = () => {
        if (doneReceived || sseErrorEventReceived) return;

        // If the user requested cancellation, the server may close the SSE stream without a final "done".
        // Treat this as a canceled query to avoid getting stuck in "canceling".
        if (state.cancelRequested) {
          state.cancelRequested = false;
          streamSink.setStatus("canceled");
          setQueryStatusText("canceled");
          if (results && typeof results.setStatus === "function") results.setStatus("canceled");
          closeActiveStream();
          resolve({ status: "canceled" });
          return;
        }

        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        if (errVisible) {
          // Even if we don't want to overwrite the banner, we must still resolve to unblock the runner.
          closeActiveStream();
          resolve({ status: "error" });
          return;
        }

        streamSink.setError("Connection lost.");
        streamSink.setStatus("error");
        lockProgressIndeterminate = true;
        if (agg) agg.terminal = true;
        setProgressIndeterminate(false);
        closeActiveStream();
        resolve({ status: "error" });
      };
    });
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

  function statusIsStopping(status) {
    const s = String(status || "").toLowerCase();
    return s === "error" || s === "canceled" || s === "cancelled";
  }

  function buildCompactMeta({ status, elapsedSeconds, outRows, outCols, readRows, readBytes, cpuMaxCenti, memMax, thrMax, truncated }) {
    const parts = [];
    parts.push(statusLabel(status));
    if (elapsedSeconds != null) parts.push(util.formatSeconds(elapsedSeconds));
    if (outRows != null && outCols != null) parts.push(`${outRows} row${outRows > 1 ? 's' : ''} ${outCols} column${outCols > 1 ? 's' : ''}`);
    if (readRows != null) parts.push(`${formatShort(readRows)} row${readRows > 1 ? 's' : ''}`);
    if (readBytes != null) parts.push(`${formatBytesShort(readBytes)}`);;
    
    if (cpuMaxCenti != null && cpuMaxCenti > 0) parts.push(`max CPU ${formatPercentFromCenti(cpuMaxCenti)}`);
    if (memMax != null && memMax > 0) parts.push(`max RAM ${formatBytesShort(memMax)}`);
    if (thrMax != null && thrMax > 0) parts.push(`max thread${thrMax > 1 ? 's' : ''} ${thrMax}`);
    return parts.join(" · ");
  }

  async function runOneStatement(statement, sink, streamSink = null) {
    resetMetrics();
    setProgressIndeterminate(true);

    const hostId = getSelectedHostId();
    const { queryId, cancelToken, streamUrl } = await api.runSql(hostId, statement);

    state.activeQueryId = queryId;
    state.cancelToken = cancelToken;

    setQueryIdText(queryId);
    // New run should always reset the status indicator, even if a previous run ended in a terminal state.
    setQueryStatusText("running", { force: true });
    results.setStatus("running");
    state.cancelRequested = false;

    const agg = createStatementAgg();
    const done = await streamQuery(streamUrl, agg, sink);

    let finalStatus = done && done.status ? String(done.status) : "done";
    // normalize spelling
    const fsLower = String(finalStatus).toLowerCase();
    if (fsLower === "cancelled") finalStatus = "canceled";
    setQueryStatusText(statusLabel(finalStatus));
    results.setStatus(finalStatus);

    state.activeQueryId = null;
    state.cancelToken = null;
    state.cancelRequested = false;

    return { done, agg };
  }

  async function handleRun() {
    if (state.isRunning || state.isFormatting) return;

    results.clearResultsStack();
    results.clearLiveResults();
    resetMetrics();
    setQueryIdText(null);

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
      results.setError("Multiquery is disabled. Enable “Allow multiquery” in the Run menu.");
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

      console.log('here', statements.length);

      storage.addHistoryEntry({
        ts_ms: Date.now(),
        host_id: hostId,
        sql_raw: trimmed,
        sql_formatted: dom.queryTextArea ? dom.queryTextArea.value : trimmed,
      });

      if (statements.length === 1) {
        await runOneStatement(statements[0]);
        resetLiveMetrics()
        if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;
        return;
      }

      const total = statements.length;
      let batchFinalStatus = "done";

      for (let i = 0; i < total; i++) {
        if (state.batchStopRequested) break;

        // Create/activate the per-query panel and stream directly into it.
        const perQuerySink = results && typeof results.beginMultiqueryPanel === "function"
          ? results.beginMultiqueryPanel({ index: i, total, autoToggle: true })
          : null;

        // Clear only the target we are about to stream into (global in single-query, panel in multiquery)
        if (perQuerySink && typeof perQuerySink.clearLiveResults === "function") perQuerySink.clearLiveResults();
        else results.clearLiveResults();

        resetMetrics();
        setQueryIdText(null);
        setQueryStatusText(`running (${i + 1}/${total})`);

        const stmt = statements[i];
        let done = null;
        let agg = null;
        try {
          const out = await runOneStatement(stmt, perQuerySink);
          done = out.done;
          agg = out.agg;
        } catch (err) {
          // Per-statement failure: show inside the active panel when in multiquery.
          const msg = err instanceof Error ? err.message : String(err);
          if (perQuerySink && typeof perQuerySink.setError === "function") perQuerySink.setError(msg);
          else results.setError(msg);
          done = { status: "error" };
          agg = createStatementAgg();
          state.batchStopRequested = true;
        }

        let st = done && done.status ? String(done.status) : "done";
        const stLower = String(st).toLowerCase();
        if (stLower === "cancelled") st = "canceled";
        // Track final batch status for the global indicator
        if (stLower === "error") batchFinalStatus = "error";
        else if (stLower === "canceled" || stLower === "cancelled") batchFinalStatus = "canceled";
        else if (batchFinalStatus !== "error" && batchFinalStatus !== "canceled") batchFinalStatus = "done";
        const outRows = perQuerySink && perQuerySink.getRowCount ? perQuerySink.getRowCount() : results.getRowCount();
        const outCols = perQuerySink && perQuerySink.getColumnCount ? perQuerySink.getColumnCount() : results.getColCount();

        const readRows = done && Number(done.read_rows) > 0 ? Number(done.read_rows) : agg.lastReadRows;
        const readBytes = done && Number(done.read_bytes) > 0 ? Number(done.read_bytes) : agg.lastReadBytes;

        const metaText = buildCompactMeta({
          status: st,
          elapsedSeconds: done && done.elapsed_seconds != null ? Number(done.elapsed_seconds) : null,
          outRows,
          outCols,
          readRows,
          readBytes,
          cpuMaxCenti: agg.cpuMaxCenti || null,
          memMax: agg.memMax || null,
          thrMax: agg.thrMax || null,
          truncated: !!(done && done.result_truncated),
        });

        // IMPORTANT: do not clear local errors at finalize time; keep them visible in the panel.
        const hasError = !!(perQuerySink && typeof perQuerySink.getErrorText === "function"
          ? perQuerySink.getErrorText()
          : results.getErrorText());
        const expandedByDefault = statusIsStopping(st) || hasError;

        if (results && typeof results.endMultiqueryPanel === "function" && perQuerySink) {
          // Finalize the already-streaming panel (keeps same DOM/classes as live renderer)
          results.endMultiqueryPanel(perQuerySink, { expandedByDefault, metaText });
        } else {
          // Backward-compatible path: snapshot from the global live renderer
          const copyText = results.buildCopyJsonText();
          const errorText = results.takeErrorText();
          results.pushResultsBlock(`Query ${i + 1}/${total}`, metaText, copyText, { expandedByDefault, errorText });
        }

        if (statusIsStopping(st)) {
          state.batchStopRequested = true;
          break;
        }
      }

      results.hideLiveWrapIfStackHasBlocks();
      setQueryIdText(null);
      setQueryStatusText(statusLabel(batchFinalStatus));
      results.setStatus(batchFinalStatus);
      resetMetrics();
      resetCharts();
      resetLiveMetrics();
    } catch (err) {
      if (isFormatFailedError(err)) {
        showFormatFailure(err);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        // No per-query sink available here; show globally.
        results.setError(msg);
        results.setStatus("error");
        setQueryStatusText("error");
        results.setResultsVisible(true);
      }
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
      showFormatFailure(err);
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
      await api.cancelQuery(token);
      state.cancelRequested = true;
      setQueryStatusText("canceling");
      results.setStatus("canceling");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.setError(msg);
      results.setStatus("error");
    }
  }

  function initCharts() {
    window.addEventListener("resize", scheduleChartsRender);
    const themeObserver = new MutationObserver(() => scheduleChartsRender());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    scheduleChartsRender();
  }

  function init() {
    updateActionButtons();
    initCharts();

    if (dom.runButton) dom.runButton.addEventListener("click", handleRun);
    if (dom.formatButton) dom.formatButton.addEventListener("click", handleFormat);
    if (dom.cancelButton) dom.cancelButton.addEventListener("click", handleCancelOrClear);
    if (dom.copyJsonButton) dom.copyJsonButton.addEventListener("click", handleCopyLiveJson);
  }

  ns.run = { init, handleRun, handleFormat, handleCancelOrClear, updateActionButtons };
})();