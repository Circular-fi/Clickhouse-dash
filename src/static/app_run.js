(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const { dom, state, storage, api, sql, results, util, ui, analysis, download } = ns;
  const { $$ } = ns.dom;

  let activeEventSource = null;
  let lockProgressIndeterminate = false;

  const series = {
    readRowsPerSec: [],
    readBytesPerSec: [],
    writtenRowsPerSec: [],
    writtenBytesPerSec: [],
    cpu: [],
    memBytes: [],
  };

  const MAX_STORE_POINTS = 2400;
  const STORE_TRIM_SLACK = 160;
  const EPS_T = 1e-9;

  let chartsFrame = 0;

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
    // Trim in chunks instead of moving the entire backing array for every
    // point once the graph reaches its retention limit.
    if (arr.length > MAX_STORE_POINTS + STORE_TRIM_SLACK) {
      arr.splice(0, arr.length - MAX_STORE_POINTS);
    }
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

  // An empty sparkline (a hidden tab keeps no drawing).
  function releaseCanvasBuffer(el) {
    if (!el || !el.__sparkline) return;
    el.__sparkline = "";
    el.replaceChildren();
  }

  // The shared sparkline (ui.sparkline, --sparkline-color): the series
  // decimated, from opts.min, its top the max (or a quantile of it), never
  // under opts.minMax.
  function drawSparkline(el, points, opts = {}) {
    if (!el || !Array.isArray(points) || points.length === 0 || document.hidden) {
      releaseCanvasBuffer(el);
      return;
    }
    let drawable = decimate(points, 120);
    if (drawable.length === 1) drawable = [drawable[0], { t: drawable[0].t + 1, v: drawable[0].v }];
    const vMin = opts.min ?? 0;
    let vMax = opts.max != null && Number.isFinite(opts.max) ? opts.max : computeAutoMax(drawable, opts);
    if (vMax == null || !Number.isFinite(vMax)) {
      vMax = -Infinity;
      for (const p of drawable) if (Number.isFinite(p.v)) vMax = Math.max(vMax, p.v);
    }
    if (opts.minMax != null && Number.isFinite(opts.minMax)) vMax = Math.max(vMax, opts.minMax);
    if (!Number.isFinite(vMax) || vMax <= vMin) vMax = vMin + 1;
    ns.ui.sparkline.draw(el, drawable.map((p) => p.v), { xs: drawable.map((p) => p.t), min: vMin, max: vMax, area: true });
  }

  const chartCanvases = () => [
    dom.readRowsChart,
    dom.readBytesChart,
    dom.writtenRowsChart,
    dom.writtenBytesChart,
    dom.cpuChart,
    dom.memoryChart,
  ].filter(Boolean);

  function releaseChartBuffers() {
    for (const canvas of chartCanvases()) releaseCanvasBuffer(canvas);
  }

  function renderCharts() {
    if (document.hidden) {
      releaseChartBuffers();
      return;
    }

    drawSparkline(dom.readRowsChart, series.readRowsPerSec, { min: 0 });
    drawSparkline(dom.readBytesChart, series.readBytesPerSec, { min: 0 });
    drawSparkline(dom.writtenRowsChart, series.writtenRowsPerSec, { min: 0 });
    drawSparkline(dom.writtenBytesChart, series.writtenBytesPerSec, { min: 0 });

    drawSparkline(dom.cpuChart, series.cpu, {
      min: 0,
      autoMaxQuantile: 0.98,
      autoMaxPadFactor: 1.10,
      minMax: 100,
      clampMax: true,
    });

    drawSparkline(dom.memoryChart, series.memBytes, { min: 0 });
  }

  function scheduleChartsRender() {
    if (chartsFrame || document.hidden) return;
    chartsFrame = requestAnimationFrame(() => {
      chartsFrame = 0;
      renderCharts();
    });
  }

  function resetCharts() {
    series.readRowsPerSec.length = 0;
    series.readBytesPerSec.length = 0;
    series.writtenRowsPerSec.length = 0;
    series.writtenBytesPerSec.length = 0;
    series.cpu.length = 0;
    series.memBytes.length = 0;
    releaseChartBuffers();
    scheduleChartsRender();
  }

  // The metric rail in ns.format (docs/ui-foundations.md): durations
  // "1 ms" / "8 min 30 s", sizes "15.2 KB", rates "1.2K/s" and "1.7 KB/s",
  // totals "120,064", percentages "12.3%", and EMPTY for a missing value.
  const format = ns.format;
  const EMPTY = format.EMPTY;
  const rowsRate = (value) => `${format.compact(value)}/s`;
  // ClickHouse reports CPU and progress in hundredths of a percent.
  const percentFromCenti = (value) => format.percent(Number(value) / 10000);

  // The rail's tiles show what the run amounts to: rows and bytes read (or
  // written) and the CPU and memory peaks, the large value; the sub-line is
  // labelled: "Now" with the current rate or level while the query runs,
  // "Avg" with the run's average once it ended (setRailPhase, finishRail).
  function setRailPhase(phase) {
    const label = phase === "done" ? "Avg" : "Now";
    for (const el of $$(".metricColumn [data-rail-sub]")) {
      if (el.textContent !== label) el.textContent = label;
    }
  }

  const mean = (points) => {
    let sum = 0;
    let count = 0;
    for (const point of points) {
      if (!Number.isFinite(point.v)) continue;
      sum += point.v;
      count += 1;
    }
    return count ? sum / count : null;
  };

  // A run's totals for the rail, from its done event and the stream's
  // aggregate (agg) and samples (series). Multiquery adds them up (addRailTotals).
  function railTotals(done, agg) {
    const pick = (value, fallback) => (value != null && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : (fallback ?? null));
    const cpuAvg = mean(series.cpu);
    const memAvg = mean(series.memBytes);
    return {
      runs: 1,
      elapsedS: done && done.elapsed_seconds != null && Number.isFinite(Number(done.elapsed_seconds)) ? Number(done.elapsed_seconds) : null,
      readRows: pick(done?.read_rows, agg?.lastReadRows),
      readBytes: pick(done?.read_bytes, agg?.lastReadBytes),
      writtenRows: pick(done?.written_rows, agg?.lastWrittenRows),
      writtenBytes: pick(done?.written_bytes, agg?.lastWrittenBytes),
      cpuPeakCenti: agg && agg.cpuMaxCenti > 0 ? agg.cpuMaxCenti : null,
      memPeak: agg && agg.memMax > 0 ? agg.memMax : null,
      cpuSum: cpuAvg == null ? 0 : cpuAvg * series.cpu.length,
      cpuCount: cpuAvg == null ? 0 : series.cpu.length,
      memSum: memAvg == null ? 0 : memAvg * series.memBytes.length,
      memCount: memAvg == null ? 0 : series.memBytes.length,
    };
  }

  function addRailTotals(sum, next) {
    if (!sum) return { ...next };
    const add = (a, b) => (a == null ? b : b == null ? a : a + b);
    const max = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));
    return {
      runs: sum.runs + next.runs,
      elapsedS: add(sum.elapsedS, next.elapsedS),
      readRows: add(sum.readRows, next.readRows),
      readBytes: add(sum.readBytes, next.readBytes),
      writtenRows: add(sum.writtenRows, next.writtenRows),
      writtenBytes: add(sum.writtenBytes, next.writtenBytes),
      cpuPeakCenti: max(sum.cpuPeakCenti, next.cpuPeakCenti),
      memPeak: max(sum.memPeak, next.memPeak),
      cpuSum: sum.cpuSum + next.cpuSum,
      cpuCount: sum.cpuCount + next.cpuCount,
      memSum: sum.memSum + next.memSum,
      memCount: sum.memCount + next.memCount,
    };
  }

  // The ended run on the rail: totals and peaks as values, averages on the
  // sub-lines (rates over the elapsed time, CPU and memory over the samples).
  function finishRail(totals) {
    if (!totals) return;
    const perSecond = (value) => (value != null && totals.elapsedS > 0 ? value / totals.elapsedS : null);
    const show = (el, value, fmt) => util.setMetricText(el, value == null || !Number.isFinite(value) ? EMPTY : fmt(value));
    if (totals.elapsedS != null) util.setMetricText(dom.elapsedSecondsText, format.duration.fromSeconds(totals.elapsedS));
    show(dom.readRowsTotalText, totals.readRows, format.count);
    show(dom.readBytesTotalText, totals.readBytes, format.bytes);
    show(dom.readRowsRateText, perSecond(totals.readRows), rowsRate);
    show(dom.readBytesRateText, perSecond(totals.readBytes), format.bytesRate);
    const wrote = (totals.writtenRows || 0) > 0 || (totals.writtenBytes || 0) > 0;
    if (dom.writtenRowsCard) dom.writtenRowsCard.classList.toggle("is-hidden", !wrote);
    if (dom.writtenBytesCard) dom.writtenBytesCard.classList.toggle("is-hidden", !wrote);
    if (wrote) {
      show(dom.writtenRowsTotalText, totals.writtenRows ?? 0, format.count);
      show(dom.writtenBytesTotalText, totals.writtenBytes ?? 0, format.bytes);
      show(dom.writtenRowsRateText, perSecond(totals.writtenRows), rowsRate);
      show(dom.writtenBytesRateText, perSecond(totals.writtenBytes), format.bytesRate);
    }
    util.setText(dom.cpuMaxText, totals.cpuPeakCenti == null ? EMPTY : percentFromCenti(totals.cpuPeakCenti));
    util.setText(dom.cpuText, totals.cpuCount ? format.percent(totals.cpuSum / totals.cpuCount / 100) : EMPTY);
    show(dom.memoryMaxText, totals.memPeak, format.bytes);
    show(dom.memoryText, totals.memCount ? totals.memSum / totals.memCount : null, format.bytes);
    setRailPhase("done");
  }

  // Before the first run (and after Clear) the rail is idle: its tiles say
  // "No run yet" rather than a column of dashes; a run puts the dashes back
  // until its figures arrive.
  const IDLE_TEXT = "No run yet";
  const IDLE_VALUES = ["elapsedSecondsText", "progressPercentText", "readRowsTotalText", "readBytesTotalText", "cpuMaxText", "memoryMaxText"];

  function resetMetrics({ idle = false } = {}) {
    lockProgressIndeterminate = false;
    setRailPhase("live");
    util.setMetricText(dom.elapsedSecondsText, EMPTY);
    util.setText(dom.clickhouseElapsedText, "");
    if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;
    if (dom.clickhouseElapsedText) dom.clickhouseElapsedText.removeAttribute("title");
    util.setText(dom.progressPercentText, EMPTY);
    util.setMetricText(dom.readRowsRateText, EMPTY);
    util.setMetricText(dom.readRowsTotalText, EMPTY);
    util.setMetricText(dom.readBytesRateText, EMPTY);
    util.setMetricText(dom.readBytesTotalText, EMPTY);
    util.setMetricText(dom.writtenRowsRateText, EMPTY);
    util.setMetricText(dom.writtenRowsTotalText, EMPTY);
    util.setMetricText(dom.writtenBytesRateText, EMPTY);
    util.setMetricText(dom.writtenBytesTotalText, EMPTY);
    if (dom.writtenRowsCard) dom.writtenRowsCard.classList.add("is-hidden");
    if (dom.writtenBytesCard) dom.writtenBytesCard.classList.add("is-hidden");
    util.setText(dom.cpuText, EMPTY);
    util.setText(dom.cpuMaxText, EMPTY);
    util.setMetricText(dom.memoryText, EMPTY);
    util.setMetricText(dom.memoryMaxText, EMPTY);
    if (dom.progressCard) {
      dom.progressCard.classList.remove("is-indeterminate");
      dom.progressCard.style.setProperty("--p", "0");
    }
    dom.runStatsTiles?.classList.toggle("is-idle", idle);
    if (idle) for (const id of IDLE_VALUES) util.setText(dom[id], IDLE_TEXT);
    resetCharts();
  }

  // A run that finished: the progress tile full.
  function setProgressDone() {
    util.setText(dom.progressPercentText, format.percent(1));
    if (dom.progressCard) dom.progressCard.style.setProperty("--p", "1");
    setProgressIndeterminate(false);
  }

  function setProgressIndeterminate(enabled) {
    if (!dom.progressCard) return;
    dom.progressCard.classList.toggle("is-indeterminate", !!enabled);
  }

  async function refreshClickHouseElapsed(hostId, queryId) {
    if (!state.runOptExecutionStats) {
      if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;
      return;
    }
    if (!dom.clickhouseElapsedText || !hostId || !queryId || !api || typeof api.getQueryExecution !== "function") return;
    if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;
    dom.clickhouseElapsedText.removeAttribute("title");
    try {
      const payload = await api.getQueryExecution(hostId, queryId);
      if (payload && payload.available === true && Number.isFinite(Number(payload.duration_ms))) {
        util.setText(dom.clickhouseElapsedText, format.duration.fromMs(payload.duration_ms));
        if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = false;
        return;
      }
      const detail = payload && payload.error ? String(payload.error)
        : (payload && payload.logs_pending ? "ClickHouse query_log has not published this execution yet." : "ClickHouse elapsed is unavailable.");
      util.setText(dom.clickhouseElapsedText, payload && payload.logs_pending ? "pending" : "unavailable");
      if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = false;
      dom.clickhouseElapsedText.title = detail;
    } catch (e) {
      util.setText(dom.clickhouseElapsedText, "error");
      if (dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = false;
      dom.clickhouseElapsedText.title = ns.util.errorText(e, "ClickHouse execution lookup failed.");
    }
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
    const cpuCenti = arr[8] == null ? null : Number(arr[8]);
    const cpuMaxCenti = arr[9] == null ? null : Number(arr[9]);
    const memInst = arr[10] == null ? null : Number(arr[10]);
    const memMax = arr[11] == null ? null : Number(arr[11]);
    // Positions 12 and 13 are reserved compatibility placeholders. The source
    // dashboard always sends null because ClickHouse does not expose a stable
    // live active-thread count in native query telemetry.
    const samples = Array.isArray(arr[14]) ? arr[14] : null;
    const writtenRowsTotal = arr[15] == null ? null : Number(arr[15]);
    const writtenBytesTotal = arr[16] == null ? null : Number(arr[16]);
    const writtenRowsPerSec = arr[17] == null ? null : Number(arr[17]);
    const writtenBytesPerSec = arr[18] == null ? null : Number(arr[18]);

    if (Number.isFinite(elapsedMs)) util.setMetricText(dom.elapsedSecondsText, format.duration.fromMs(elapsedMs));

    if (percentKnown && Number.isFinite(percentCenti)) {
      const pct = Math.max(0, Math.min(100, percentCenti / 100));
      util.setText(dom.progressPercentText, format.percent(pct / 100));
      if (dom.progressCard) dom.progressCard.style.setProperty("--p", String(pct / 100));
      setProgressIndeterminate(false);
    } else {
      util.setText(dom.progressPercentText, EMPTY);
      if (state.isRunning && !lockProgressIndeterminate) setProgressIndeterminate(true);
      else setProgressIndeterminate(false);
    }

    if (Number.isFinite(rowsPerSec)) util.setMetricText(dom.readRowsRateText, rowsRate(rowsPerSec));
    if (Number.isFinite(readRowsTotal)) util.setMetricText(dom.readRowsTotalText, format.count(readRowsTotal));

    if (Number.isFinite(bytesPerSec)) util.setMetricText(dom.readBytesRateText, format.bytesRate(bytesPerSec));
    if (Number.isFinite(readBytesTotal)) util.setMetricText(dom.readBytesTotalText, format.bytes(readBytesTotal));

    const hasWrites = (Number.isFinite(writtenRowsTotal) && writtenRowsTotal > 0) ||
      (Number.isFinite(writtenBytesTotal) && writtenBytesTotal > 0);
    if (hasWrites) {
      if (dom.writtenRowsCard) dom.writtenRowsCard.classList.remove("is-hidden");
      if (dom.writtenBytesCard) dom.writtenBytesCard.classList.remove("is-hidden");
      if (Number.isFinite(writtenRowsPerSec)) util.setMetricText(dom.writtenRowsRateText, rowsRate(writtenRowsPerSec));
      if (Number.isFinite(writtenRowsTotal)) util.setMetricText(dom.writtenRowsTotalText, format.count(writtenRowsTotal));
      if (Number.isFinite(writtenBytesPerSec)) util.setMetricText(dom.writtenBytesRateText, format.bytesRate(writtenBytesPerSec));
      if (Number.isFinite(writtenBytesTotal)) util.setMetricText(dom.writtenBytesTotalText, format.bytes(writtenBytesTotal));
    }

    util.setText(dom.cpuText, cpuCenti == null ? EMPTY : percentFromCenti(cpuCenti));
    util.setText(dom.cpuMaxText, cpuMaxCenti == null ? EMPTY : percentFromCenti(cpuMaxCenti));

    util.setMetricText(dom.memoryText, memInst == null ? EMPTY : format.bytes(memInst));
    util.setMetricText(dom.memoryMaxText, memMax == null ? EMPTY : format.bytes(memMax));

    if (agg) {
      if (Number.isFinite(readRowsTotal)) agg.lastReadRows = readRowsTotal;
      if (Number.isFinite(readBytesTotal)) agg.lastReadBytes = readBytesTotal;
      if (Number.isFinite(writtenRowsTotal)) agg.lastWrittenRows = writtenRowsTotal;
      if (Number.isFinite(writtenBytesTotal)) agg.lastWrittenBytes = writtenBytesTotal;
      if (Number.isFinite(cpuMaxCenti)) agg.cpuMaxCenti = Math.max(agg.cpuMaxCenti, cpuMaxCenti);
      if (Number.isFinite(memMax)) agg.memMax = Math.max(agg.memMax, memMax);

      const tSec = Number.isFinite(elapsedMs) ? elapsedMs / 1000 : null;
      if (tSec != null) {
        if (Number.isFinite(rowsPerSec) && rowsPerSec >= 0) pushPointMonotone(series.readRowsPerSec, tSec, rowsPerSec);
        if (Number.isFinite(bytesPerSec) && bytesPerSec >= 0) pushPointMonotone(series.readBytesPerSec, tSec, bytesPerSec);
        if (Number.isFinite(writtenRowsPerSec) && writtenRowsPerSec >= 0) pushPointMonotone(series.writtenRowsPerSec, tSec, writtenRowsPerSec);
        if (Number.isFinite(writtenBytesPerSec) && writtenBytesPerSec >= 0) pushPointMonotone(series.writtenBytesPerSec, tSec, writtenBytesPerSec);
        if (Number.isFinite(cpuCenti)) pushPointMonotone(series.cpu, tSec, cpuCenti / 100);
        if (memInst != null && Number.isFinite(memInst)) pushPointMonotone(series.memBytes, tSec, memInst);
      }

      if (samples && Array.isArray(samples) && samples.length > 0) {
        for (const s of samples) {
          if (!Array.isArray(s) || s.length < 2) continue;
          const sm = Number(s[0]);
          const st = Number.isFinite(sm) ? sm / 1000 : null;
          if (st == null) continue;

          // Current source layout (five values):
          // [elapsedMs, readRowsTotal, readBytesTotal, cpuCenti, memBytes, writtenRowsTotal, writtenBytesTotal].
          // Older releases may append legacy fields after memory; values are
          // treated as write telemetry only when both appended counters exist.
          const hasReadRows = s.length >= 5;
          const rr = hasReadRows ? Number(s[1]) : null;
          const rb = hasReadRows ? Number(s[2]) : Number(s[1]);
          const cpuIndex = hasReadRows ? 3 : 2;
          const memoryIndex = hasReadRows ? 4 : 3;
          const cpu = s[cpuIndex] == null ? null : Number(s[cpuIndex]);
          const mem = s[memoryIndex] == null ? null : Number(s[memoryIndex]);
          const swr = s.length >= 7 ? Number(s[5]) : null;
          const swb = s.length >= 7 ? Number(s[6]) : null;

          if (cpu != null && Number.isFinite(cpu)) pushPointMonotone(series.cpu, st, cpu / 100);
          if (mem != null && Number.isFinite(mem)) pushPointMonotone(series.memBytes, st, mem);

          if (Number.isFinite(rr) && agg.lastSampleReadRows != null && agg.lastSampleReadRowsT != null) {
            const dt = st - agg.lastSampleReadRowsT;
            if (dt > 1e-9) {
              const rps = (rr - agg.lastSampleReadRows) / dt;
              if (Number.isFinite(rps) && rps >= 0) pushPointMonotone(series.readRowsPerSec, st, rps);
            }
          }

          if (Number.isFinite(rb) && agg.lastSampleReadBytes != null && agg.lastSampleReadBytesT != null) {
            const dt = st - agg.lastSampleReadBytesT;
            if (dt > 1e-9) {
              const bps = (rb - agg.lastSampleReadBytes) / dt;
              if (Number.isFinite(bps) && bps >= 0) pushPointMonotone(series.readBytesPerSec, st, bps);
            }
          }

          if (Number.isFinite(swr) && agg.lastSampleWrittenRows != null && agg.lastSampleWrittenRowsT != null) {
            const dt = st - agg.lastSampleWrittenRowsT;
            if (dt > 1e-9) {
              const rps = (swr - agg.lastSampleWrittenRows) / dt;
              if (Number.isFinite(rps) && rps >= 0) pushPointMonotone(series.writtenRowsPerSec, st, rps);
            }
          }

          if (Number.isFinite(swb) && agg.lastSampleWrittenBytes != null && agg.lastSampleWrittenBytesT != null) {
            const dt = st - agg.lastSampleWrittenBytesT;
            if (dt > 1e-9) {
              const bps = (swb - agg.lastSampleWrittenBytes) / dt;
              if (Number.isFinite(bps) && bps >= 0) pushPointMonotone(series.writtenBytesPerSec, st, bps);
            }
          }

          if (Number.isFinite(swr)) {
            agg.lastSampleWrittenRows = swr;
            agg.lastSampleWrittenRowsT = st;
          }
          if (Number.isFinite(swb)) {
            agg.lastSampleWrittenBytes = swb;
            agg.lastSampleWrittenBytesT = st;
          }

          if (Number.isFinite(rr)) {
            agg.lastSampleReadRows = rr;
            agg.lastSampleReadRowsT = st;
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
    if (done.elapsed_seconds != null) util.setMetricText(dom.elapsedSecondsText, format.duration.fromSeconds(done.elapsed_seconds));

    const rr = done.read_rows != null ? Number(done.read_rows) : null;
    const rb = done.read_bytes != null ? Number(done.read_bytes) : null;
    const wr = done.written_rows != null ? Number(done.written_rows) : null;
    const wb = done.written_bytes != null ? Number(done.written_bytes) : null;

    if (rr != null && Number.isFinite(rr) && rr > 0) util.setMetricText(dom.readRowsTotalText, format.count(rr));
    else if (agg && agg.lastReadRows != null) util.setMetricText(dom.readRowsTotalText, format.count(agg.lastReadRows));

    if (rb != null && Number.isFinite(rb) && rb > 0) util.setMetricText(dom.readBytesTotalText, format.bytes(rb));
    else if (agg && agg.lastReadBytes != null) util.setMetricText(dom.readBytesTotalText, format.bytes(agg.lastReadBytes));

    const finalWrittenRows = wr != null && Number.isFinite(wr) ? wr : (agg ? agg.lastWrittenRows : null);
    const finalWrittenBytes = wb != null && Number.isFinite(wb) ? wb : (agg ? agg.lastWrittenBytes : null);
    if ((finalWrittenRows != null && finalWrittenRows > 0) || (finalWrittenBytes != null && finalWrittenBytes > 0)) {
      if (dom.writtenRowsCard) dom.writtenRowsCard.classList.remove("is-hidden");
      if (dom.writtenBytesCard) dom.writtenBytesCard.classList.remove("is-hidden");
      if (finalWrittenRows != null) util.setMetricText(dom.writtenRowsTotalText, format.count(finalWrittenRows));
      if (finalWrittenBytes != null) util.setMetricText(dom.writtenBytesTotalText, format.bytes(finalWrittenBytes));
    }

    setProgressIndeterminate(false);
  }

  function setQueryIdText(queryId) {
    util.setText(dom.queryIdentifierText, queryId ? `#${queryId}` : EMPTY);
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
    finished: 40,
    "limit reached": 40,
    result_limit_reached: 40,
    canceled: 50,
    error: 60,
  };

  function normalizeStatusText(value) {
    if (!value) return "-";
    const v = String(value).toLowerCase();
    if (v === "cancelled") return "canceled";
    if (v === "success") return "done";
    if (v === "result_limit_reached") return "limit reached";
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
    setPanelRunState(runStateFor(next));
  }

  function runStateFor(status) {
    const s = String(status || "").toLowerCase();
    if (s.startsWith("running") || s === "connected" || s === "canceling") return "running";
    if (s === "error") return "error";
    if (s === "canceled") return "canceled";
    if (s === "done" || s === "finished" || s === "limit reached") return "ok";
    return "idle";
  }

  // History: each run is recorded when it starts (storage.addHistoryEntry);
  // its outcome is added once it ended, and sent to the server History when
  // the query library keeps it there (features.query_library.history_store).
  function historyStatusFor(status) {
    const s = runStateFor(status);
    if (s === "ok") return "ok";
    if (s === "canceled") return "cancelled";
    return "error";
  }

  function recordRunOutcome(run) {
    if (!run || !run.tsMs) return;
    const outcome = {
      status: historyStatusFor(state.queryStatusText),
      elapsed_ms: Math.max(0, Math.round(Number.isFinite(run.elapsedMs) ? run.elapsedMs : Date.now() - run.startedAt)),
      rows: Math.max(0, Math.trunc(Number(run.rows) || 0)),
    };
    const errorText = String(run.error || (results && typeof results.getErrorText === "function" ? results.getErrorText() : "") || "");
    if (outcome.status === "error" && errorText) outcome.error = errorText.slice(0, 2048);
    storage.completeHistoryEntry(run.tsMs, run.sql, outcome);
    const entry = { sql: run.sql, host_id: run.hostId || null, ran_at_ms: run.tsMs, ...outcome };
    const toServer = ns.features.get("query_library.history_store") === "server";
    const notify = (detail) => {
      try {
        window.dispatchEvent(new CustomEvent("chdash:query-history", { detail }));
      } catch (_) {}
    };
    if (!toServer) {
      notify({ entry, store: "browser" });
      return;
    }
    api.addQueryHistory(entry)
      .then((response) => notify({ entry: { ...entry, id: response && response.id }, store: "server", revision: response && response.revision }))
      .catch(() => notify({ entry, store: "browser", failed: true }));
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

  // The server ends the response right after "done" (api_query_stream.cpp):
  // closing the EventSource on "done" can beat the response's last chunk and
  // abort a finished request (net::ERR_ABORTED). A stream that said "done" is
  // closed once the server has ended it (the error event of an ended stream,
  // fired before the browser would reconnect), or after STREAM_END_GRACE_MS
  // if the server never ends it.
  const STREAM_END_GRACE_MS = 2000;
  function retireStream(es) {
    if (activeEventSource === es) activeEventSource = null;
    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      es.onerror = null;
      try { es.close(); } catch { /* already closed */ }
    };
    if (es.readyState !== EventSource.OPEN) { close(); return; }
    es.onerror = close;
    timer = setTimeout(close, STREAM_END_GRACE_MS);
  }

  function isFormatLocked() {
    const ta = dom.queryTextArea;
    if (!ta) return false;
    if (!state.lastFormatOk) return false;
    const hostId = state.selectedHostId ? String(state.selectedHostId) : null;
    if (!hostId) return false;
    if (state.lastFormatHostId && String(state.lastFormatHostId) !== hostId) return false;
    return String(ta.value || "") === String(state.lastFormatEditorValue || "");
  }

  function selectedHostSupportsFullProfiling() {
    const hostId = String(state.selectedHostId || "");
    const hosts = Array.isArray(state.hostsSnapshot?.hosts) ? state.hostsSnapshot.hosts : [];
    const host = hosts.find((item) => item && String(item.id || "") === hostId);
    const tables = host?.system_tables || {};
    return tables.processors_profile_log === true && tables.opentelemetry_span_log === true;
  }

  // updateActionButtons runs on every editor input; splitting a large script
  // (character-by-character scanner) on each keystroke is wasted work when the
  // text has not changed since the previous call (state/host/button updates).
  let cachedEditorStatementsText = null;
  let cachedEditorStatements = [];
  function editorStatementsForButtons() {
    const text = String(dom.queryTextArea?.value || "").trim();
    if (text !== cachedEditorStatementsText) {
      cachedEditorStatementsText = text;
      cachedEditorStatements = sql.splitSqlStatements(text);
    }
    return cachedEditorStatements;
  }

  function updateActionButtons() {
    const busy = state.isRunning || state.isFormatting;
    const offline = state.apiOnline === false;

    // During execution the primary action becomes Cancel in-place. Keeping the
    // control in the same location avoids a moving target and removes the old
    // duplicate Cancel button beside the split Run control.
    if (dom.runButton) {
      dom.runButton.textContent = state.isRunning ? "Cancel" : "Run";
      dom.runButton.classList.toggle("runSplit__main--cancel", state.isRunning);
      dom.runButton.disabled = state.isRunning
        ? (state.isFormatting || offline || !state.cancelToken)
        : (state.isFormatting || offline);
    }
    if (dom.runMenuButton) {
      dom.runMenuButton.hidden = state.isRunning;
      dom.runMenuButton.disabled = busy || offline;
    }
    const editorStatements = editorStatementsForButtons();
    const editorIsMulti = editorStatements.length > 1;
    if (dom.runWithProfilingButton) {
      const profilingAvailable = selectedHostSupportsFullProfiling();
      const profilingHidden = editorIsMulti || !profilingAvailable;
      dom.runWithProfilingButton.hidden = profilingHidden;
      dom.runWithProfilingButton.disabled = busy || offline || editorStatements.length !== 1 || !profilingAvailable;
      const divider = dom.runWithProfilingButton.nextElementSibling;
      if (divider?.classList?.contains("runMenu__divider")) divider.hidden = profilingHidden;
    }
    const exportBusy = ns.massExport && typeof ns.massExport.isPreparing === "function" && ns.massExport.isPreparing();
    if (dom.downloadCsvButton) {
      dom.downloadCsvButton.hidden = editorIsMulti;
      dom.downloadCsvButton.disabled = busy || offline || exportBusy || editorStatements.length !== 1;
    }
    if (dom.downloadJsonButton) dom.downloadJsonButton.disabled = busy || offline || exportBusy || editorStatements.length < 1;
    if (dom.downloadDebugButton) dom.downloadDebugButton.disabled = busy || offline || editorStatements.length < 1;
    const editorEmpty = !String(dom.queryTextArea?.value || "").trim();
    if (dom.formatButton) dom.formatButton.disabled = busy || offline || editorEmpty || isFormatLocked();

    const hasClearableState = !!state.activeQueryId
      || String(state.queryStatusText || "-") !== "-"
      || !!(results && typeof results.getErrorText === "function" && results.getErrorText())
      || !!(results && typeof results.getRowCount === "function" && results.getRowCount() > 0);
    if (dom.clearResultsButton) dom.clearResultsButton.disabled = state.isRunning || state.isFormatting || !hasClearableState;
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

  // The results' Copy JSON split (ui.copySplit): JSON on the main button,
  // CSV and Download JSON (app_download.js) in its menu.
  function liveJsonText() {
    return state.lastRunMode === "batch" && download && typeof download.buildGlobalJson === "function"
      ? download.buildGlobalJson()
      : (results && typeof results.buildCopyText === "function" ? results.buildCopyText("json") : "");
  }

  function liveCsvText() {
    return results && typeof results.buildCopyText === "function" ? results.buildCopyText("csv") : "";
  }


  function tabifyLeadingIndent(text, tabWidth = 4) {
    const src = String(text ?? "");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Only convert leading indentation (spaces at line start)
      const m = ln.match(/^( +)/);
      if (!m) continue;
      const lead = m[1];
      const nTabs = Math.floor(lead.length / tabWidth);
      if (nTabs <= 0) continue;
      const restSpaces = lead.length % tabWidth;
      lines[i] = "\t".repeat(nTabs) + " ".repeat(restSpaces) + ln.slice(lead.length);
    }
    return lines.join("\n");
  }

  async function formatEditorSql() {
    const hostId = getSelectedHostId();
    const ta = dom.queryTextArea;
    const raw = ta ? ta.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) throw new Error("Nothing to format.");

    if (state.lastFormatOk && String(state.lastFormatHostId || "") === String(hostId || "") && String(state.lastFormatEditorValue || "") === String(raw || "")) {
      const st = sql.splitSqlStatements(trimmed);
      return st.map(sql.normalizeStatementText).filter(Boolean);
    }

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

    const joinedTabified = tabifyLeadingIndent(joined, 4);

    const shouldRestoreSelection = (() => {
      if (!ta) return false;
      if (document.activeElement === ta) return true;
      try {
        const r = ta.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!(vh > 0) || !(r.height > 0)) return false;
        if (r.bottom <= 0 || r.top >= vh) return false;
        const visTop = Math.max(0, r.top);
        const visBottom = Math.min(vh, r.bottom);
        const vis = Math.max(0, visBottom - visTop);
        return vis / r.height >= 0.95;
      } catch {
        return false;
      }
    })();

    const view = (() => {
      if (!ta) return null;
      const start = Number.isFinite(ta.selectionStart) ? ta.selectionStart : 0;
      const end = Number.isFinite(ta.selectionEnd) ? ta.selectionEnd : start;
      const scrollTop = Number.isFinite(ta.scrollTop) ? ta.scrollTop : 0;

      const toLineCol = (text, pos) => {
        let line = 0;
        let col = 0;
        for (let i = 0; i < pos && i < text.length; i++) {
          const ch = text[i];
          if (ch === "\n") {
            line++;
            col = 0;
          } else {
            col++;
          }
        }
        return { line, col };
      };

      return {
        scrollTop,
        startLc: toLineCol(raw, start),
        endLc: toLineCol(raw, end),
      };
    })();

    if (ta) {
      util.replaceTextAreaValue(ta, joinedTabified);
      if (view) {
        const fromLineCol = (text, lc) => {
          let line = 0;
          let col = 0;
          for (let i = 0; i < text.length; i++) {
            if (line > lc.line) return i;
            if (line === lc.line && col >= lc.col) return i;
            const ch = text[i];
            if (ch === "\n") {
              line++;
              col = 0;
            } else {
              col++;
            }
          }
          return text.length;
        };

        const newStart = fromLineCol(joinedTabified, view.startLc);
        const newEnd = fromLineCol(joinedTabified, view.endLc);
        const applyView = () => {
          if (shouldRestoreSelection) {
            try {
              ta.setSelectionRange(newStart, newEnd);
            } catch {
              null;
            }
          }
          const maxTop = Math.max(0, ta.scrollHeight - ta.clientHeight);
          ta.scrollTop = Math.min(Math.max(0, view.scrollTop), maxTop);
          // Formatted lines start at their indentation: show them from the
          // left edge, not where the long unformatted line was scrolled to
          // (a phone showed the ends of the lines).
          ta.scrollLeft = 0;
        };

        requestAnimationFrame(() => {
          applyView();
          requestAnimationFrame(applyView);
        });
      }
    }

    if (ui && typeof ui.clearEditorError === "function") ui.clearEditorError();

    storage.addHistoryEntry({
      ts_ms: Date.now(),
      host_id: hostId,
      sql_raw: trimmed,
      sql_formatted: joinedTabified,
    });

    state.lastFormatOk = true;
    state.lastFormatHostId = hostId;
    state.lastFormatEditorValue = ta ? String(ta.value || "") : joinedTabified;
    updateActionButtons();

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

  function parseLineColFromText(text) {
    const s = String(text || "");
    let m = s.match(/\(\s*line\s+(\d+)\s*,\s*col\s+(\d+)\s*\)/i);
    if (!m) m = s.match(/\bline\s+(\d+)\s*,\s*col\s+(\d+)\b/i);
    if (!m) return null;
    const line = Number(m[1]) | 0;
    const col = Number(m[2]) | 0;
    if (line <= 0 || col <= 0) return null;
    return { line, col };
  }

  function extractFormatErrorLocation(err) {
    const payload = err && err.payload ? err.payload : null;
    const loc = payload && payload.location && typeof payload.location === "object" ? payload.location : null;
    if (loc) {
      const line = Number(loc.line) | 0;
      const col = Number(loc.col) | 0;
      if (line > 0 && col > 0) return { line, col };
    }
    if (payload) {
      const line = Number(payload.line) | 0;
      const col = Number(payload.col != null ? payload.col : payload.column) | 0;
      if (line > 0 && col > 0) return { line, col };
    }
    const msg = payload && payload.message ? String(payload.message) : err instanceof Error ? String(err.message || "") : "";
    return parseLineColFromText(msg);
  }

function splitSqlStatementsWithRanges(sqlText) {
  const s = String(sqlText || "");
  const out = [];
  let buf = "";
  let bufStart = 0;

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

  const pushStmt = (rawStmt, startPos) => {
    const norm = sql.normalizeStatementText(rawStmt);
    if (!norm) return;
    let a = 0;
    while (a < rawStmt.length && isWs(rawStmt[a])) a += 1;
    let b = rawStmt.length;
    while (b > a && isWs(rawStmt[b - 1])) b -= 1;
    out.push({ text: norm, start: startPos + a, end: startPos + b });
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const nx = i + 1 < s.length ? s[i + 1] : "";

    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      buf += ch;
      if (ch === "*" && nx === "/") {
        buf += nx;
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingle) {
      buf += ch;
      if (ch === "\\") {
        if (nx) {
          buf += nx;
          i++;
        }
        continue;
      }
      if (ch === "'" && nx === "'") {
        buf += nx;
        i++;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      buf += ch;
      if (ch === "\\") {
        if (nx) {
          buf += nx;
          i++;
        }
        continue;
      }
      if (ch === "\"") inDouble = false;
      continue;
    }

    if (inBacktick) {
      buf += ch;
      if (ch === "`") inBacktick = false;
      continue;
    }

    if (ch === "-" && nx === "-") {
      buf += ch + nx;
      i++;
      inLineComment = true;
      continue;
    }

    if (ch === "#") {
      buf += ch;
      inLineComment = true;
      continue;
    }

    if (ch === "/" && nx === "*") {
      buf += ch + nx;
      i++;
      inBlockComment = true;
      continue;
    }

    if (ch === "'") {
      buf += ch;
      inSingle = true;
      continue;
    }

    if (ch === "\"") {
      buf += ch;
      inDouble = true;
      continue;
    }

    if (ch === "`") {
      buf += ch;
      inBacktick = true;
      continue;
    }

    if (ch === ";") {
      pushStmt(buf, bufStart);
      buf = "";
      bufStart = i + 1;
      continue;
    }

    buf += ch;
  }

  pushStmt(buf, bufStart);
  return out;
}

function lineColToOffset(text, line1, col1) {
  const s = String(text || "");
  const line = Math.max(1, Number(line1) | 0);
  const col = Math.max(1, Number(col1) | 0);

  let ln = 1;
  let lineStart = 0;
  for (let i = 0; i < s.length && ln < line; i++) {
    if (s[i] === "\n") {
      ln += 1;
      lineStart = i + 1;
    }
  }

  let lineEnd = s.indexOf("\n", lineStart);
  if (lineEnd < 0) lineEnd = s.length;

  let off = lineStart + (col - 1);
  if (off > lineEnd) off = lineEnd;
  if (off < 0) off = 0;
  if (off > s.length) off = s.length;
  return off;
}

function offsetToLineCol(text, pos0) {
  const s = String(text || "");
  const pos = Math.max(0, Math.min(Number(pos0) | 0, s.length));
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos; i++) {
    if (s[i] === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function mapStatementLocToEditorLoc(editorText, statementIndex, loc) {
  const raw = String(editorText || "");
  let trimStart = 0;
  while (trimStart < raw.length && (raw[trimStart] === " " || raw[trimStart] === "\t" || raw[trimStart] === "\n" || raw[trimStart] === "\r")) trimStart += 1;
  let trimEnd = raw.length;
  while (trimEnd > trimStart && (raw[trimEnd - 1] === " " || raw[trimEnd - 1] === "\t" || raw[trimEnd - 1] === "\n" || raw[trimEnd - 1] === "\r")) trimEnd -= 1;

  const trimmed = raw.slice(trimStart, trimEnd);
  const spans = splitSqlStatementsWithRanges(trimmed);
  const idx = Number(statementIndex) | 0;
  if (idx < 0 || idx >= spans.length) return null;

  const span = spans[idx];
  const offStmt = lineColToOffset(span.text, loc.line, loc.col);
  const offDoc = trimStart + span.start + offStmt;
  return offsetToLineCol(raw, offDoc);
}

function normalizeNear(near) {
  const s = typeof near === "string" ? near : "";
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === "`" && b === "`") || (a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1);
  }
  return s;
}

function findNearOffset(text, near) {
  const s = String(text || "");
  const n = normalizeNear(near);
  if (!n) return null;
  const idx = s.lastIndexOf(n);
  if (idx < 0) return null;
  return idx;
}

function guessPositionOffset(text, position, near) {
  const s = String(text || "");
  const p = Number(position);
  if (!Number.isFinite(p)) return null;

  const n = normalizeNear(near);
  const p0 = Math.max(0, Math.min((p | 0), s.length));
  const p1 = Math.max(0, Math.min(((p | 0) - 1), s.length));

  if (n) {
    if (p1 >= 0 && p1 + n.length <= s.length && s.slice(p1, p1 + n.length) === n) return p1;
    if (p0 >= 0 && p0 + n.length <= s.length && s.slice(p0, p0 + n.length) === n) return p0;
  }

  if ((p | 0) >= 1 && (p | 0) <= s.length + 1) return p1;
  return p0;
}

function extractClickhouseInfo(payload, fallbackMsg) {
  const p = payload && typeof payload === "object" ? payload : null;
  const ch = p && p.clickhouse && typeof p.clickhouse === "object" ? p.clickhouse : null;

  const near = ch && typeof ch.near === "string" ? ch.near : (p && typeof p.near === "string" ? p.near : "");
  const idxRaw = p && p.index != null ? p.index : (ch && ch.index != null ? ch.index : null);
  const index = idxRaw != null && Number.isFinite(Number(idxRaw)) ? (Number(idxRaw) | 0) : -1;

  const lineRaw = ch && ch.line != null ? ch.line : (p && p.line != null ? p.line : null);
  const colRaw = ch && ch.col != null ? ch.col : (p && (p.col != null ? p.col : p.column));
  let line = lineRaw != null ? (Number(lineRaw) | 0) : 0;
  let col = colRaw != null ? (Number(colRaw) | 0) : 0;

  const posRaw = ch && ch.position != null ? ch.position : (p && p.position != null ? p.position : null);
  const position = posRaw != null && Number.isFinite(Number(posRaw)) ? Number(posRaw) : null;

  if (line <= 0 || col <= 0) {
    const msg = fallbackMsg != null ? String(fallbackMsg) : (p && p.message ? String(p.message) : "");
    const parsed = parseLineColFromText(msg);
    if (parsed) {
      line = parsed.line;
      col = parsed.col;
    }
  }

  return { line, col, position, near, index };
}

function mapStatementPosToEditorLoc(editorText, statementIndex, position, near) {
  const raw = String(editorText || "");
  let trimStart = 0;
  while (trimStart < raw.length && (raw[trimStart] === " " || raw[trimStart] === "\t" || raw[trimStart] === "\n" || raw[trimStart] === "\r")) trimStart += 1;
  let trimEnd = raw.length;
  while (trimEnd > trimStart && (raw[trimEnd - 1] === " " || raw[trimEnd - 1] === "\t" || raw[trimEnd - 1] === "\n" || raw[trimEnd - 1] === "\r")) trimEnd -= 1;

  const trimmed = raw.slice(trimStart, trimEnd);
  const spans = splitSqlStatementsWithRanges(trimmed);
  const idx = Number(statementIndex) | 0;
  if (idx < 0 || idx >= spans.length) return null;

  const span = spans[idx];
  const offStmt = guessPositionOffset(span.text, position, near);
  if (offStmt == null) return null;
  const offDoc = trimStart + span.start + offStmt;
  return offsetToLineCol(raw, offDoc);
}

function mapStatementNearToEditorLoc(editorText, statementIndex, near) {
  const raw = String(editorText || "");
  let trimStart = 0;
  while (trimStart < raw.length && (raw[trimStart] === " " || raw[trimStart] === "\t" || raw[trimStart] === "\n" || raw[trimStart] === "\r")) trimStart += 1;
  let trimEnd = raw.length;
  while (trimEnd > trimStart && (raw[trimEnd - 1] === " " || raw[trimEnd - 1] === "\t" || raw[trimEnd - 1] === "\n" || raw[trimEnd - 1] === "\r")) trimEnd -= 1;

  const trimmed = raw.slice(trimStart, trimEnd);
  const spans = splitSqlStatementsWithRanges(trimmed);
  const idx = Number(statementIndex) | 0;
  if (idx < 0 || idx >= spans.length) return null;

  const span = spans[idx];
  const offStmt = findNearOffset(span.text, near);
  if (offStmt == null) return null;
  const offDoc = trimStart + span.start + offStmt;
  return offsetToLineCol(raw, offDoc);
}

function resolveEditorErrorLocation(editorText, statementIndexHint, payload, msg) {
  const info = extractClickhouseInfo(payload, msg);
  const editor = String(editorText || "");
  const idx = statementIndexHint != null && Number.isFinite(Number(statementIndexHint)) ? (Number(statementIndexHint) | 0) : info.index;

  if (idx >= 0) {
    if (info.line > 0 && info.col > 0) {
      const mapped = mapStatementLocToEditorLoc(editor, idx, { line: info.line, col: info.col });
      if (mapped) return { line: mapped.line, col: mapped.col, near: info.near };
    }
    if (info.position != null) {
      const mapped = mapStatementPosToEditorLoc(editor, idx, info.position, info.near);
      if (mapped) return { line: mapped.line, col: mapped.col, near: info.near };
    }
    if (info.near) {
      const mapped = mapStatementNearToEditorLoc(editor, idx, info.near);
      if (mapped) return { line: mapped.line, col: mapped.col, near: info.near };
    }
    const parsed = parseLineColFromText(msg);
    if (parsed) {
      const mapped = mapStatementLocToEditorLoc(editor, idx, parsed);
      if (mapped) return { line: mapped.line, col: mapped.col, near: info.near };
    }
    return null;
  }

  if (info.line > 0 && info.col > 0) return { line: info.line, col: info.col, near: info.near };
  if (info.position != null) {
    const off = guessPositionOffset(editor, info.position, info.near);
    if (off != null) {
      const lc = offsetToLineCol(editor, off);
      return { line: lc.line, col: lc.col, near: info.near };
    }
  }
  if (info.near) {
    const off = findNearOffset(editor, info.near);
    if (off != null) {
      const lc = offsetToLineCol(editor, off);
      return { line: lc.line, col: lc.col, near: info.near };
    }
  }
  const parsed = parseLineColFromText(msg);
  if (parsed) return { line: parsed.line, col: parsed.col, near: info.near };
  return null;
}

function applyEditorErrorDecoration(editorText, statementIndexHint, payload, msg) {
  if (!ui || typeof ui.setEditorError !== "function") return;
  const loc = resolveEditorErrorLocation(editorText, statementIndexHint, payload, msg);
  if (!loc) return;
  ui.setEditorError({ line: loc.line, col: loc.col, near: loc.near, message: msg });
}


  function showFormatFailure(err) {
    const msg = buildFormatErrorText(err);

    state.lastFormatOk = false;
    state.lastFormatHostId = null;
    state.lastFormatEditorValue = null;
    updateActionButtons();
    const payload = err && err.payload ? err.payload : null;
    const editorText = dom.queryTextArea ? String(dom.queryTextArea.value || "") : "";
    applyEditorErrorDecoration(editorText, null, payload, msg);
    results.clearResultsStack();
    results.clearLiveResults();
    results.setError(msg, payload?.clickhouse || null);
    results.setStatus("error");
    setQueryStatusText("error");
    results.setResultsVisible(true);
    if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
  }

  // Run formats first when "Format on run" is on. A formatter failure never
  // blocks the run: the text runs as typed and the server's own error (or
  // result) shows. Only a format that answered replaces the statements.
  // The Format button alone still reports its failure (showFormatFailure).
  async function formattedOrTyped(statements) {
    try {
      return await formatEditorSql();
    } catch {
      state.lastFormatOk = false;
      state.lastFormatHostId = null;
      state.lastFormatEditorValue = null;
      return statements;
    }
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
      lastWrittenRows: null,
      lastWrittenBytes: null,
      cpuMaxCenti: 0,
      memMax: 0,
      lastSampleReadRows: null,
      lastSampleReadRowsT: null,
      lastSampleReadBytes: null,
      lastSampleReadBytesT: null,
      lastSampleWrittenRows: null,
      lastSampleWrittenRowsT: null,
      lastSampleWrittenBytes: null,
      lastSampleWrittenBytesT: null,
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
    setError: (msg, where = null) => {
      if (s && typeof s.setError === "function") return s.setError(msg, where);
      if (results && typeof results.setError === "function") return results.setError(msg, where);
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

function streamQuery(streamUrl, agg, sink, ctx) {
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

        const cols = Array.isArray(data.columns)
          ? data.columns
          : [];
        const transportTypes = Array.isArray(data.types)
          ? data.types
          : [];
        const originalTypes = Array.isArray(data.original_types)
          ? data.original_types
          : [];
        const displayTypes = cols.map((_, index) => {
          const originalType = originalTypes[index];
          if (typeof originalType === "string" && originalType.trim()) {
            return originalType;
          }
          return transportTypes[index] ?? "";
        });

        streamSink.renderTableMeta(cols, displayTypes);
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
        const editorText = ctx && typeof ctx.editorText === "string" ? ctx.editorText : (dom.queryTextArea ? String(dom.queryTextArea.value || "") : "");
        const statementIndex = ctx && ctx.statementIndex != null ? ctx.statementIndex : null;
        applyEditorErrorDecoration(editorText, statementIndex, data, msg);
        streamSink.setError(msg, data.clickhouse || null);
        streamSink.setStatus("error");
        lockProgressIndeterminate = true;
        if (agg) agg.terminal = true;
        setProgressIndeterminate(false);
      });

      es.addEventListener("done", (ev) => {
        const data = parseSseJson(ev) || {};
        doneReceived = true;
        // "done" is the last event: the stream closes once the server ends it.
        retireStream(es);
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
          util.setText(dom.progressPercentText, format.percent(1));
          if (dom.progressCard) dom.progressCard.style.setProperty("--p", "1");
        }

        applyDoneMetrics(data, agg);
        // Row decoding/render bookkeeping is intentionally cooperative for large
        // streams. Do not publish the terminal result until the background row
        // queue has drained, otherwise row counts/copy/export can observe a
        // partially ingested response.
        Promise.resolve(streamSink.finalizeAfterDone()).then(() => {
          if (agg) agg.terminal = true;
          resolve({ ...data, status: st });
        });
      });

      // A stream that ends without "done" still ends its result: the rows
      // received get their bars and their chart (finalizeAfterDone).
      const endWithoutDone = (status) => {
        closeActiveStream();
        Promise.resolve(streamSink.finalizeAfterDone()).catch(() => {}).then(() => resolve({ status }));
      };

      es.onerror = () => {
        if (doneReceived || sseErrorEventReceived) return;

        // If the user requested cancellation, the server may close the SSE stream without a final "done".
        // Treat this as a canceled query to avoid getting stuck in "canceling".
        if (state.cancelRequested) {
          state.cancelRequested = false;
          streamSink.setStatus("canceled");
          setQueryStatusText("canceled");
          if (results && typeof results.setStatus === "function") results.setStatus("canceled");
          endWithoutDone("canceled");
          return;
        }

        const errVisible = dom.errorBanner && !dom.errorBanner.hidden && String(dom.errorBanner.textContent || "").trim().length > 0;
        if (errVisible) {
          // Even if we don't want to overwrite the banner, we must still resolve to unblock the runner.
          endWithoutDone("error");
          return;
        }

        streamSink.setError("Connection lost.");
        streamSink.setStatus("error");
        lockProgressIndeterminate = true;
        if (agg) agg.terminal = true;
        setProgressIndeterminate(false);
        endWithoutDone("error");
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

  // Result header and multiquery panel summary, in ns.format: "236 rows,
  // 5 columns · 4 ms · read 236 rows, 15.2 KB" (a meta line: its parts after
  // the third go to its tooltip).
  function buildCompactMeta({ status, elapsedSeconds, outRows, outCols, readRows, readBytes, cpuMaxCenti, memMax, truncated }) {
    const parts = [];
    if (status) parts.push(statusLabel(status));
    const shape = [];
    if (outRows != null) shape.push(`${format.countLabel(outRows, "row")}${truncated ? " (preview)" : ""}`);
    if (outCols != null) shape.push(format.countLabel(outCols, "column"));
    if (shape.length) parts.push(shape.join(", "));
    if (elapsedSeconds != null && Number.isFinite(elapsedSeconds)) parts.push(format.duration.fromSeconds(elapsedSeconds));
    const read = [];
    if (readRows != null && Number(readRows) > 0) read.push(format.countLabel(readRows, "row"));
    if (readBytes != null && Number(readBytes) > 0) read.push(format.bytes(readBytes));
    if (read.length) parts.push(`read ${read.join(", ")}`);

    if (cpuMaxCenti != null && cpuMaxCenti > 0) parts.push(`max CPU ${percentFromCenti(cpuMaxCenti)}`);
    if (memMax != null && memMax > 0) parts.push(`max RAM ${format.bytes(memMax)}`);
    return parts.join(" \u00b7 ");
  }

  // The single-query result header: rows and columns received, elapsed time and
  // what the server read. Hidden until a run produced a terminal state.
  function setResultSummary(text) {
    const el = dom.resultSummaryText;
    if (!el) return;
    util.setMetaLine(el, text || "");
    el.hidden = !text;
    if (dom.resultColumnsText) dom.resultColumnsText.classList.toggle("is-summarized", !!text);
  }

  // Running state on the editor panel: the toolbar, editor border and status
  // chip follow it (css/20-features/query.css).
  function setPanelRunState(stateName) {
    const panel = dom.queryTextArea ? dom.queryTextArea.closest(".panel--query") : null;
    if (!panel) return;
    panel.dataset.runState = stateName || "idle";
  }

  async function runOneStatement(statement, sink, ctx = null, runMode = "normal") {
    resetMetrics();
    setProgressIndeterminate(true);

    const hostId = getSelectedHostId();
    const { queryId, cancelToken, streamUrl, analysisAvailable } = await api.runSql(hostId, statement, runMode);

    state.activeQueryId = queryId;
    state.cancelToken = cancelToken;
    updateActionButtons();

    setQueryIdText(queryId);
    // New run should always reset the status indicator, even if a previous run ended in a terminal state.
    setQueryStatusText("running", { force: true });
    results.setStatus("running");
    state.cancelRequested = false;

    const agg = createStatementAgg();
    const done = await streamQuery(streamUrl, agg, sink, ctx);

    let finalStatus = done && done.status ? String(done.status) : "done";
    // normalize spelling
    const fsLower = String(finalStatus).toLowerCase();
    if (fsLower === "cancelled") finalStatus = "canceled";
    setQueryStatusText(statusLabel(finalStatus));
    results.setStatus(finalStatus);

    state.activeQueryId = null;
    state.cancelToken = null;
    state.cancelRequested = false;

    return { done, agg, queryId, runMode, analysisAvailable };
  }

  async function performRequestedDownload(kind) {
    if (!kind || !download) return;
    let ok = true;
    if (kind === "json" && typeof download.downloadJson === "function") ok = download.downloadJson() !== false;
    else if (kind === "csv" && typeof download.downloadCsv === "function") ok = download.downloadCsv() !== false;
    else if (kind === "debug" && typeof download.downloadDebug === "function") ok = await download.downloadDebug({ throwOnError: true });
    if (!ok) throw new Error(`Download ${kind} failed.`);
  }

  async function handleRunMode(runMode = "normal", { downloadAfter = "" } = {}) {
    const downloadKind = ["json", "csv", "debug"].includes(String(downloadAfter)) ? String(downloadAfter) : "";
    let downloadRunFailed = false;
    if (state.isRunning || state.isFormatting) return;
    if (state.apiOnline === false) {
      results.setError("API is offline.");
      results.setStatus("error");
      return;
    }

    state.suppressResultsVisibility = !!downloadKind;
    const runStartedAt = Date.now();
    let historyRun = null;
    setResultSummary("");
    results.clearResultsStack();
    results.clearLiveResults();
    if (downloadKind) results.setResultsVisible(false);
    resetMetrics();
    setQueryIdText(null);
    if (analysis && typeof analysis.setContext === "function") analysis.setContext(null);

    results.setError("");
    if (ui && typeof ui.clearEditorError === "function") ui.clearEditorError();
    ui && ui.closeRunMenu && ui.closeRunMenu({ immediate: false });

    const hostId = getSelectedHostId();
    if (!hostId) {
      state.suppressResultsVisibility = false;
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    const raw = dom.queryTextArea ? dom.queryTextArea.value : "";
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
      state.suppressResultsVisibility = false;
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    let statements = sql.splitSqlStatements(trimmed);
    if (!statements.length) {
      state.suppressResultsVisibility = false;
      results.setError("Query is empty.");
      results.setStatus("error");
      return;
    }

    if (downloadKind === "csv" && statements.length !== 1) {
      state.suppressResultsVisibility = false;
      results.setError("Download CSV is available only for a single query.");
      results.setStatus("error");
      return;
    }

    if (runMode === "profiling" && statements.length !== 1 && downloadKind !== "debug") {
      state.suppressResultsVisibility = false;
      results.setError("Run with profiling is available only for a single query.");
      results.setStatus("error");
      return;
    }

    if (statements.length > 1 && !state.runOptMultiQuery) {
      state.suppressResultsVisibility = false;
      results.setError("Multiquery is disabled. Enable \u201cAllow multiquery\u201d in Run settings.");
      results.setStatus("error");
      return;
    }

    results.clearResultsStack();
    results.clearLiveResults();
    // Starting a new run behaves exactly like Clear: stale result rows/panels
    // disappear while the new query is loading and are shown again only when
    // the new run produces rows, a terminal result, or an error.
    results.setResultsVisible(false);
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
    if (download && typeof download.resetRun === "function") {
      download.resetRun({ hostId, multi: statements.length > 1 });
    }

    setBusy({ running: true, formatting: false, batch: statements.length > 1 });
    state.batchStopRequested = false;

    try {
      if (state.runOptAutoFormat) statements = await formattedOrTyped(statements);
      const editorTextForErrors = dom.queryTextArea ? String(dom.queryTextArea.value || "") : "";


      historyRun = { tsMs: Date.now(), startedAt: runStartedAt, sql: trimmed, hostId, rows: 0, elapsedMs: NaN, error: "" };
      // The address bar links to what ran (?sql= / ?saved=).
      if (!downloadKind) ui?.syncQueryUrl?.(dom.queryTextArea ? dom.queryTextArea.value : trimmed);
      storage.addHistoryEntry({
        ts_ms: historyRun.tsMs,
        host_id: hostId,
        sql_raw: trimmed,
        sql_formatted: dom.queryTextArea ? dom.queryTextArea.value : trimmed,
      });

      if (statements.length === 1) {
        const out = await runOneStatement(statements[0], null, { editorText: editorTextForErrors, statementIndex: 0 }, runMode);
        {
          const done = out && out.done ? out.done : {};
          const rows = results.getRowCount();
          historyRun.rows = rows;
          if (done.elapsed_seconds != null) historyRun.elapsedMs = Number(done.elapsed_seconds) * 1000;
          const terminal = String(done.status || "done").toLowerCase();
          if (!statusIsStopping(terminal) && !downloadKind) {
            setResultSummary(buildCompactMeta({
              outRows: rows,
              outCols: results.getColCount(),
              elapsedSeconds: done.elapsed_seconds != null ? Number(done.elapsed_seconds) : null,
              readRows: Number(done.read_rows) > 0 ? Number(done.read_rows) : out?.agg?.lastReadRows,
              readBytes: Number(done.read_bytes) > 0 ? Number(done.read_bytes) : out?.agg?.lastReadBytes,
              truncated: !!done.result_truncated || terminal === "result_limit_reached",
            }));
          }
        }
        if (analysis && typeof analysis.setContext === "function" && out && out.queryId && out.analysisAvailable) {
          analysis.setContext({ hostId, queryId: out.queryId, runMode });
        }
        if (download && typeof download.recordQuery === "function") {
          const done = out && out.done ? out.done : {};
          download.recordQuery({
            index: 0,
            hostId,
            runMode,
            sql: statements[0],
            queryId: out && out.queryId ? out.queryId : null,
            status: done.status || "done",
            partial: !!done.result_truncated || String(done.status || "").toLowerCase() === "result_limit_reached",
            errorText: results && typeof results.getErrorText === "function" ? results.getErrorText() : "",
            snapshot: results && typeof results.getSnapshot === "function" ? results.getSnapshot() : null,
          });
        }
        if (out && out.queryId && state.runOptExecutionStats) await refreshClickHouseElapsed(hostId, out.queryId);
        finishRail(railTotals(out?.done, out?.agg));
        const terminalStatus = String(out?.done?.status || "done").toLowerCase();
        if (downloadKind && statusIsStopping(terminalStatus)) {
          downloadRunFailed = true;
          state.suppressResultsVisibility = false;
          if (!results.getErrorText?.()) results.setError(`Query ended with status ${terminalStatus}.`);
          if (downloadKind === "debug") await performRequestedDownload(downloadKind);
          results.setResultsVisible(true);
        } else if (downloadKind) {
          await performRequestedDownload(downloadKind);
          results.setResultsVisible(false);
        } else if (statusIsStopping(terminalStatus)) {
          // Keep the error banner, but never resurrect the result table after
          // setError() hid it. A terminal query failure is not a result set.
          if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
          results.setResultsVisible(true);
        } else if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = false;

        if (runMode === "profiling" && !downloadKind && out?.queryId && out?.analysisAvailable && analysis && typeof analysis.open === "function") {
          await analysis.open({ hostId, queryId: out.queryId, runMode: "profiling" });
        }
        return;
      }

      const total = statements.length;
      // A batch that ran every statement ends like one query: "finished" at
      // 100 %; "error" or "canceled" when a statement stopped it.
      let batchFinalStatus = "finished";
      // The rail ends on the batch: every statement's rows and bytes read,
      // the highest peaks, the averages over all of them.
      let batchTotals = null;

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
        let statementQueryId = null;
        try {
          const out = await runOneStatement(stmt, perQuerySink, { editorText: editorTextForErrors, statementIndex: i }, runMode);
          done = out.done;
          agg = out.agg;
          statementQueryId = out.queryId || null;
          if (perQuerySink && typeof perQuerySink.setAnalyzeAction === "function" && out.queryId && analysis && typeof analysis.open === "function") {
            if (out.analysisAvailable) perQuerySink.setAnalyzeAction(() => analysis.open({ hostId, queryId: out.queryId, runMode }));
          }
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
        else if (batchFinalStatus !== "error" && batchFinalStatus !== "canceled") batchFinalStatus = "finished";
        const outRows = perQuerySink && perQuerySink.getRowCount ? perQuerySink.getRowCount() : results.getRowCount();
        const outCols = perQuerySink && perQuerySink.getColumnCount ? perQuerySink.getColumnCount() : results.getColCount();
        if (historyRun) {
          historyRun.rows += Number(outRows) || 0;
          if (done && done.elapsed_seconds != null) historyRun.elapsedMs = (Number.isFinite(historyRun.elapsedMs) ? historyRun.elapsedMs : 0) + Number(done.elapsed_seconds) * 1000;
          if (!historyRun.error && done && String(done.status || "").toLowerCase() === "error") {
            historyRun.error = perQuerySink && typeof perQuerySink.getErrorText === "function" ? perQuerySink.getErrorText() : "";
          }
        }

        batchTotals = addRailTotals(batchTotals, railTotals(done, agg));
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
          truncated: !!(done && done.result_truncated),
        });

        // IMPORTANT: do not clear local errors at finalize time; keep them visible in the panel.
        const hasError = !!(perQuerySink && typeof perQuerySink.getErrorText === "function"
          ? perQuerySink.getErrorText()
          : results.getErrorText());
        // A batch of three statements or fewer shows every result; a longer
        // one opens the first, and any statement that failed.
        const expandedByDefault = statusIsStopping(st) || hasError || total <= 3 || i === 0;

        if (results && typeof results.endMultiqueryPanel === "function" && perQuerySink) {
          // Finalize the already-streaming panel (keeps same DOM/classes as live renderer)
          results.endMultiqueryPanel(perQuerySink, { expandedByDefault, metaText });
        } else {
          // Backward-compatible path: snapshot from the global live renderer
          const copyText = {
            json: results.buildCopyJsonText(),
            csv: typeof results.buildCopyCsvText === "function" ? results.buildCopyCsvText() : results.buildCopyJsonText(),
          };
          const errorText = results.takeErrorText();
          results.pushResultsBlock(`Query ${i + 1}/${total}`, metaText, copyText, { expandedByDefault, errorText });
        }

        if (download && typeof download.recordQuery === "function") {
          const errorText = perQuerySink && typeof perQuerySink.getErrorText === "function"
            ? perQuerySink.getErrorText()
            : (results && typeof results.getErrorText === "function" ? results.getErrorText() : "");
          download.recordQuery({
            index: i,
            hostId,
            runMode,
            sql: stmt,
            queryId: statementQueryId,
            status: st,
            partial: !!(done && done.result_truncated) || String(st).toLowerCase() === "result_limit_reached",
            errorText,
            snapshot: perQuerySink && typeof perQuerySink.getSnapshot === "function"
              ? perQuerySink.getSnapshot()
              : (results && typeof results.getSnapshot === "function" ? results.getSnapshot() : null),
          });
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
      finishRail(batchTotals);
      if (batchFinalStatus === "finished") setProgressDone();
      if (downloadKind && (batchFinalStatus === "error" || batchFinalStatus === "canceled")) {
        downloadRunFailed = true;
        state.suppressResultsVisibility = false;
        if (!results.getErrorText?.() && batchFinalStatus === "error") results.setError("Multiquery stopped on an error.");
        if (downloadKind === "debug") await performRequestedDownload(downloadKind);
        results.setResultsVisible(true);
      } else if (downloadKind) {
        await performRequestedDownload(downloadKind);
        results.setResultsVisible(false);
      }
    } catch (err) {
      downloadRunFailed = !!downloadKind;
      state.suppressResultsVisibility = false;
      if (isFormatFailedError(err)) {
        showFormatFailure(err);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (historyRun && !historyRun.error) historyRun.error = msg;
        // No per-query sink available here; show globally.
        results.setError(msg);
        results.setStatus("error");
        setQueryStatusText("error");
        if (dom.liveResultsWrap) dom.liveResultsWrap.hidden = true;
        results.setResultsVisible(true);
      }
    } finally {
      closeActiveStream();
      state.cancelToken = null;
      state.activeQueryId = null;
      state.suppressResultsVisibility = false;
      if (downloadKind && !downloadRunFailed) results.setResultsVisible(false);
      setBusy({ running: false, formatting: false, batch: false });
      recordRunOutcome(historyRun);
    }
  }

  async function handleRun() {
    return handleRunMode("normal");
  }

  async function handleRunWithProfiling() {
    ui && ui.closeRunMenu && ui.closeRunMenu({ immediate: true });
    return handleRunMode("profiling");
  }

  async function handleDownloadRun(kind) {
    ui?.closeRunMenu?.({ immediate: true });
    // A debug download is a diagnostic run, not a normal export: execute every
    // statement with profiling enabled so the archive can include the complete
    // post-run analysis. CSV/JSON exports keep their normal execution mode.
    const mode = String(kind || "") === "debug" ? "profiling" : "normal";
    return handleRunMode(mode, { downloadAfter: kind });
  }

  async function handleFormat() {
    if (state.isRunning || state.isFormatting) return;
    if (state.apiOnline === false) {
      results.setError("API is offline.");
      results.setStatus("error");
      return;
    }

    results.setError("");
    if (ui && typeof ui.clearEditorError === "function") ui.clearEditorError();
    const hostId = getSelectedHostId();
    if (!hostId) {
      results.setError("No host selected.");
      results.setStatus("error");
      return;
    }

    setBusy({ running: false, formatting: true, batch: false });

    try {
      await formatEditorSql();
      if (ui && typeof ui.clearEditorError === "function") ui.clearEditorError();
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
      if (download && typeof download.resetRun === "function") download.resetRun({ hostId: getSelectedHostId(), multi: false });
      if (ui && typeof ui.clearEditorError === "function") ui.clearEditorError();
      results.clearResultsStack();
      results.clearLiveResults();
      results.setResultsVisible(false);
      resetMetrics({ idle: true });
      setResultSummary("");
      setQueryIdText(null);
      setQueryStatusText("-", { force: true });
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
    window.addEventListener("resize", scheduleChartsRender, { passive: true });
    const themeObserver = new MutationObserver(() => scheduleChartsRender());
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (chartsFrame) cancelAnimationFrame(chartsFrame);
        chartsFrame = 0;
        releaseChartBuffers();
      } else {
        scheduleChartsRender();
      }
    });
    scheduleChartsRender();
  }

  function init() {
    updateActionButtons();
    initCharts();

    if (dom.queryTextArea) dom.queryTextArea.addEventListener("input", updateActionButtons);
    if (dom.runButton) dom.runButton.addEventListener("click", () => {
      if (state.isRunning) void handleCancelOrClear();
      else void handleRun();
    });
    if (dom.runWithProfilingButton) dom.runWithProfilingButton.addEventListener("click", handleRunWithProfiling);
    if (dom.downloadJsonButton) dom.downloadJsonButton.addEventListener("click", () => handleDownloadRun("json"));
    if (dom.downloadCsvButton) dom.downloadCsvButton.addEventListener("click", () => handleDownloadRun("csv"));
    if (dom.downloadDebugButton) dom.downloadDebugButton.addEventListener("click", () => handleDownloadRun("debug"));
    if (dom.formatButton) dom.formatButton.addEventListener("click", handleFormat);
    if (dom.clearResultsButton) dom.clearResultsButton.addEventListener("click", handleCancelOrClear);
    if (dom.copySplit) {
      ns.ui.copySplit({
        root: dom.copySplit,
        getText: liveJsonText,
        items: [
          { el: dom.copyCsvButton, copy: liveCsvText },
          { el: dom.downloadReceivedJsonButton },
        ],
      });
    }
  }

  ns.run = { init, handleRun, handleRunWithProfiling, handleDownloadRun, handleFormat, handleCancelOrClear, updateActionButtons };
})();