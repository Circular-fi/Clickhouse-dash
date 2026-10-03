(() => {
  "use strict";

  // Explorer Monitoring, Performance section (docs/explorer.md "Monitoring"):
  // the selected server's history, read from its system logs through
  // /api/explorer/monitor/series (one pass each over metric_log,
  // asynchronous_metric_log and narrow query_log columns; the server picks
  // the step, at most 300 buckets).
  //
  // Ten charts on the shared engine (ns.chartCore) in ui.chartCardHtml
  // cards, two a row (one on a phone). They share a crosshair (syncKey) and
  // a drag over any of them sets the time range of all of them, as on
  // Metrics. The range is the Observability picker (ns.timeRange), written
  // to the address as from / to (ns.timeRange.url) and kept by the view
  // through ctx.setQuery. Each chart has one unit; a figure in another unit
  // (bytes next to rows, the replication queue next to its delay) is in the
  // card's summary and in the tooltip at the cursor.
  //
  // A source the server lacks (a disabled log, metric_log in the transposed
  // layout, a missing grant) degrades only the charts that need it: they
  // fall back to another source when one says the same thing (queries/s and
  // the average latency), otherwise they say what is missing. Without
  // metric_log and asynchronous_metric_log the section shows the current
  // values instead (the Overview's tiles).

  const ns = window.ChDash;
  if (!ns || !ns.explorerMonitor) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const kit = ns.explorerMonitor.kit;
  const SEP = kit.SEP;
  const DASH = format.EMPTY;

  const SYNC_KEY = "explorerMonitorPerf";
  const PLOT_HEIGHT = 172;
  const AUTO_REFRESH_MS = 30000;
  // Auto-refresh follows the clock: relative ranges of 6 h or less only.
  const AUTO_REFRESH_MAX_SPAN_MS = 6 * 3600000;
  // A drag narrower than this widens around its centre (one 10 s bucket
  // a point would draw nothing readable).
  const MIN_ZOOM_MS = 60000;
  // The error share of finished queries: neutral under 1 %, a warning to 5 %,
  // danger from there.
  const ERROR_WARN = 0.01;
  const ERROR_DANGER = 0.05;

  const autoRefreshPref = () => ns.storage.pref(ns.storage.KEYS.explorerPerfAutoRefresh, false);
  const settings = () => ns.features.get("explorer")?.monitoring || {};
  const maxMinutes = () => Math.max(1, Number(settings().max_lookback_days) || 30) * 1440;
  const defaultRange = () => ({ from: `now-${ns.timeRange.minutesToSpan(Number(settings().default_lookback_minutes) || 60)}`, to: "now" });
  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");

  // --- Units -------------------------------------------------------------------

  const BYTE_STEPS = [[1024 ** 4, "TB"], [1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  const UNITS = {
    qps: { value: (v) => format.rate(v), axis: (max) => compactAxis(max, "/s") },
    rows: { value: (v) => format.rate(v, "rows"), axis: (max) => compactAxis(max, "/s") },
    count: { value: (v) => format.number(v), axis: (max) => compactAxis(max, "") },
    cores: { value: (v) => `${format.number(v)} cores`, axis: () => ({ factor: 1, suffix: "" }) },
    bytes: {
      value: (v) => format.bytes(v),
      axis: (max) => byteUnit(max),
      // Round ticks in the 1024 unit ("1 GB, 2 GB"), not 1.862645 GB.
      yAxis: (dataMin, dataMax, plotH) => {
        const unit = byteUnit(Math.max(Math.abs(dataMin), Math.abs(dataMax)));
        const lo = Math.min(0, dataMin);
        const hi = Math.max(dataMax * 1.06, lo + unit.factor * 0.001);
        const ticks = ns.chartCore.linearTicks(lo / unit.factor, hi / unit.factor, Math.max(2, Math.floor(plotH / 34)));
        const decimals = ns.chartCore.decimalsFor(ticks.step);
        return {
          min: lo,
          max: hi,
          step: ticks.step * unit.factor,
          ticks: ticks.values.map((v) => ({ v: v * unit.factor, label: v === 0 ? "0" : `${v.toFixed(decimals)}${unit.suffix}` })),
        };
      },
    },
    ms: {
      value: (v) => format.duration.fromMs(v),
      axis: (max) => (max >= 1000 ? { factor: 1000, suffix: " s" } : { factor: 1, suffix: " ms" }),
    },
    seconds: {
      value: (v) => seconds(v),
      axis: (max) => (max >= 7200 ? { factor: 3600, suffix: " h" } : max >= 120 ? { factor: 60, suffix: " min" } : { factor: 1, suffix: " s" }),
    },
  };

  // A delay in seconds: "0 s" rather than "0 ns".
  function seconds(value) {
    return Number(value) > 0 ? format.duration.fromSeconds(value) : "0 s";
  }

  function byteUnit(max) {
    for (const [factor, suffix] of BYTE_STEPS) if (max >= factor) return { factor, suffix: ` ${suffix}` };
    return { factor: 1, suffix: " B" };
  }

  function compactAxis(max, suffix) {
    const unit = ns.chartCore.compactUnitFor(max);
    return { factor: unit.factor, suffix: `${unit.suffix}${suffix}` };
  }

  // Okabe-Ito first (--qchart-1..8), a series per slot in chart order.
  const slot = (n) => `var(--qchart-${n})`;
  const DASHED = [4, 3];

  // --- Data --------------------------------------------------------------------

  // The answer as columns: Float64Array per series (NaN: no sample).
  function columns(data) {
    const xs = Float64Array.from(data.timestamps || [], Number);
    const cols = new Map();
    for (const [name, values] of Object.entries(data.series || {})) {
      const col = new Float64Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        const v = values[i];
        col[i] = v == null ? NaN : Number(v);
      }
      cols.set(name, col);
    }
    return { xs, cols };
  }

  function stats(values) {
    let sum = 0, count = 0, max = -Infinity;
    if (values) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v !== v) continue;
        sum += v;
        count += 1;
        if (v > max) max = v;
      }
    }
    return { avg: count ? sum / count : NaN, sum, count, max: count ? max : NaN };
  }

  const sourceOk = (data, name) => data?.sources?.[name]?.status === "ok";

  // --- Charts --------------------------------------------------------------------
  //
  // build(d) -> null (the chart does not apply: hidden), { need } (the
  // sources it needs are missing: says so) or { series, unit, type, stack,
  // meta, badge, footer(i), markers, source }. d: { data, cols, col(name),
  // ok(source), stepLabel }.

  function line(d, key, label, color, extra = {}) {
    const values = d.col(key);
    return values ? { id: key, label, color, values, nulls: null, ...extra } : null;
  }

  function present(list) {
    return list.filter(Boolean);
  }

  function errorBadge(errors, total) {
    if (!(total > 0)) return null;
    const ratio = errors / total;
    const tone = ratio >= ERROR_DANGER ? "error" : ratio >= ERROR_WARN ? "warn" : "neutral";
    return { text: `Errors ${format.percent(ratio)}`, tone, title: `${format.count(errors)} failed of ${format.count(total)} queries in the range (warning from 1 %, danger from 5 %)` };
  }

  const CHARTS = [
    {
      id: "queries",
      title: "Queries/s",
      help: "Queries started per second (metric_log: SelectQuery, InsertQuery, the rest, and FailedQuery); without metric_log, the initial queries finished per second (query_log).",
      build(d) {
        if (d.ok("metric_log") && d.col("qps")) {
          const qps = d.col("qps");
          const select = d.col("select_qps");
          const insert = d.col("insert_qps");
          const other = new Float64Array(qps.length);
          for (let i = 0; i < qps.length; i++) {
            const total = qps[i];
            other[i] = total !== total ? NaN : Math.max(0, total - (select?.[i] || 0) - (insert?.[i] || 0));
          }
          const failed = d.col("failed_qps");
          const totalQ = stats(qps).sum;
          return {
            unit: "qps",
            type: "area",
            stack: true,
            series: present([
              line(d, "select_qps", "SELECT", slot(1)),
              line(d, "insert_qps", "INSERT", slot(2)),
              { id: "other_qps", label: "Other", color: slot(3), values: other, nulls: null },
              failed ? { id: "failed_qps", label: "Failed", color: "var(--danger)", values: failed, nulls: null, type: "line" } : null,
            ]),
            badge: failed ? errorBadge(stats(failed).sum, totalQ) : null,
            meta: `avg ${format.rate(stats(qps).avg)}`,
            source: "metric_log",
          };
        }
        if (d.ok("query_log") && d.col("finished_qps")) {
          const finished = d.col("finished_qps");
          const errors = d.col("error_qps");
          const ok = new Float64Array(finished.length);
          for (let i = 0; i < finished.length; i++) ok[i] = finished[i] !== finished[i] ? NaN : Math.max(0, finished[i] - (errors?.[i] || 0));
          return {
            unit: "qps",
            type: "area",
            stack: true,
            series: present([
              { id: "finished_ok_qps", label: "Finished", color: slot(1), values: ok, nulls: null },
              errors ? { id: "error_qps", label: "Failed", color: "var(--danger)", values: errors, nulls: null, type: "line" } : null,
            ]),
            badge: errors ? errorBadge(stats(errors).sum, stats(finished).sum) : null,
            meta: `initial queries finished${SEP}query_log`,
            source: "query_log",
          };
        }
        return { need: ["metric_log", "query_log"] };
      },
    },
    {
      id: "latency",
      title: "Query latency",
      help: "Duration of the initial queries finished in each bucket: 50th, 95th and 99th percentiles (query_log); without query_log, or past its lookback, the average from metric_log.",
      build(d) {
        if (d.ok("query_log") && d.col("p50_ms")) {
          return {
            unit: "ms",
            series: present([
              line(d, "p50_ms", "p50", "var(--pct-p50)"),
              line(d, "p95_ms", "p95", "var(--pct-p95)"),
              line(d, "p99_ms", "p99", "var(--pct-p99)"),
            ]),
            meta: `p95 max ${format.duration.fromMs(stats(d.col("p95_ms")).max)}`,
            source: "query_log",
          };
        }
        if (d.ok("metric_log") && d.col("avg_query_ms")) {
          const reason = d.data.sources?.query_log?.status === "out_of_range"
            ? `percentiles up to ${format.countLabel(d.data.limits?.query_log_max_lookback_hours || 168, "hour")}`
            : "no query_log";
          return {
            unit: "ms",
            series: [line(d, "avg_query_ms", "Average", "var(--pct-p95)")],
            meta: `average${SEP}${reason}`,
            fallback: true,
            source: "metric_log",
          };
        }
        return { need: ["query_log", "metric_log"] };
      },
    },
    {
      id: "cpu",
      title: "CPU",
      help: "CPU used, in cores: ClickHouse's own threads and their I/O wait (metric_log), the whole machine in user and kernel mode (asynchronous_metric_log). The tooltip adds the 1-minute load.",
      build(d) {
        const series = present([
          d.ok("metric_log") ? line(d, "cpu_cores", "ClickHouse", slot(1)) : null,
          d.ok("metric_log") ? line(d, "io_wait_cores", "I/O wait", slot(2)) : null,
          d.ok("asynchronous_metric_log") ? line(d, "os_user_cores", "OS user", slot(3)) : null,
          d.ok("asynchronous_metric_log") ? line(d, "os_system_cores", "OS system", slot(4)) : null,
        ]);
        if (!series.length) return { need: ["metric_log", "asynchronous_metric_log"] };
        const user = d.col("os_user_cores");
        const ratio = d.col("os_user_ratio");
        let cores = NaN;
        if (user && ratio) {
          for (let i = ratio.length - 1; i >= 0; i--) if (ratio[i] > 0.001 && user[i] === user[i]) { cores = Math.round(user[i] / ratio[i]); break; }
        }
        const load = d.col("load_1m");
        return {
          unit: "cores",
          series,
          yInclude: [0],
          meta: Number.isFinite(cores) && cores > 0 ? format.countLabel(cores, "core") : "",
          footer: load ? (i) => (load[i] === load[i] ? `Load (1 min) ${format.number(load[i])}` : "") : null,
        };
      },
    },
    {
      id: "memory",
      title: "Memory",
      help: "Memory tracked by ClickHouse (average and peak), the part of it merges and mutations hold (metric_log), and the server's resident memory (asynchronous_metric_log).",
      build(d) {
        const series = present([
          d.ok("metric_log") ? line(d, "memory_tracked", "Tracked", slot(1)) : null,
          d.ok("metric_log") ? line(d, "memory_tracked_max", "Tracked peak", slot(1), { dash: DASHED }) : null,
          d.ok("metric_log") ? line(d, "memory_merges", "Merges & mutations", slot(2)) : null,
          d.ok("asynchronous_metric_log") ? line(d, "memory_resident", "Resident", slot(3)) : null,
        ]);
        if (!series.length) return { need: ["metric_log", "asynchronous_metric_log"] };
        const available = d.col("os_memory_available");
        const peak = stats(d.col("memory_tracked_max") || d.col("memory_resident")).max;
        return {
          unit: "bytes",
          series,
          meta: Number.isFinite(peak) ? `peak ${format.bytes(peak)}` : "",
          footer: available ? (i) => (available[i] === available[i] ? `OS memory available ${format.bytes(available[i])}` : "") : null,
        };
      },
    },
    {
      id: "merges",
      title: "Merges & mutations",
      help: "Merges and part mutations running (average per bucket, metric_log). The summary and the tooltip add the rows merged per second.",
      build(d) {
        if (!d.ok("metric_log")) return { need: ["metric_log"] };
        const merged = d.col("merged_rows_s");
        return {
          unit: "count",
          series: present([
            line(d, "merges_running", "Merges", slot(1)),
            line(d, "mutations_running", "Mutations", slot(2)),
          ]),
          meta: merged ? `${format.rate(stats(merged).avg, "rows")} merged` : "",
          footer: merged ? (i) => (merged[i] === merged[i] ? `Merged ${format.rate(merged[i], "rows")}` : "") : null,
        };
      },
    },
    {
      id: "inserts",
      title: "Inserts",
      help: "Rows inserted per second (metric_log). A marker shows a bucket with delayed or rejected inserts (too many parts). The summary and the tooltip add the bytes.",
      build(d) {
        if (!d.ok("metric_log")) return { need: ["metric_log"] };
        const bytes = d.col("inserted_bytes_s");
        const delayed = d.col("delayed_inserts_s");
        const rejected = d.col("rejected_inserts_s");
        const markers = [];
        for (let i = 0; i < d.xs.length; i++) {
          const late = delayed?.[i] > 0 ? delayed[i] : 0;
          const refused = rejected?.[i] > 0 ? rejected[i] : 0;
          if (!late && !refused) continue;
          const parts = [];
          if (refused) parts.push(`rejected ${format.rate(refused)}`);
          if (late) parts.push(`delayed ${format.rate(late)}`);
          const text = `Inserts ${parts.join(", ")} at ${format.time(d.xs[i], { date: "never" })}`;
          markers.push({ x: d.xs[i], y: null, label: text, className: refused ? "is-rejected" : "is-delayed", attrs: { "data-insert-marker": refused ? "rejected" : "delayed" } });
        }
        return {
          unit: "rows",
          series: present([line(d, "inserted_rows_s", "Rows", slot(1))]),
          markers,
          meta: [bytes ? format.bytesRate(stats(bytes).avg) : "", markers.length ? format.countLabel(markers.length, "delayed bucket") : ""].filter(Boolean).join(SEP),
          footer: bytes ? (i) => (bytes[i] === bytes[i] ? `Inserted ${format.bytesRate(bytes[i])}` : "") : null,
        };
      },
    },
    {
      id: "parts",
      title: "Parts",
      help: "Active parts of MergeTree tables and the most parts in one partition (asynchronous_metric_log); active and outdated data parts (metric_log). Inserts slow down at 1,000 parts in a partition.",
      build(d) {
        const series = present([
          d.ok("asynchronous_metric_log") ? line(d, "parts_total", "MergeTree parts", slot(1)) : null,
          d.ok("metric_log") ? line(d, "parts_active", "Active", slot(2)) : null,
          d.ok("metric_log") ? line(d, "parts_outdated", "Outdated", slot(3)) : null,
          d.ok("asynchronous_metric_log") ? line(d, "parts_max_partition", "Max per partition", slot(4)) : null,
        ]);
        if (!series.length) return { need: ["asynchronous_metric_log", "metric_log"] };
        const most = stats(d.col("parts_max_partition")).max;
        return { unit: "count", series, meta: Number.isFinite(most) ? `max ${format.count(most)}/partition` : "", tone: most >= 1000 ? "error" : most >= 300 ? "warn" : "" };
      },
    },
    {
      id: "pools",
      title: "Background pools",
      help: "Tasks running in the background pools (metric_log): merges and mutations, fetches and moves, schedule and common; the dashed lines are the pool sizes.",
      build(d) {
        if (!d.ok("metric_log")) return { need: ["metric_log"] };
        return {
          unit: "count",
          series: present([
            line(d, "pool_merges_task", "Merges & mutations", slot(1)),
            line(d, "pool_merges_size", "Merges & mutations size", slot(1), { dash: DASHED }),
            line(d, "pool_fetches_task", "Fetches", slot(2)),
            line(d, "pool_fetches_size", "Fetches size", slot(2), { dash: DASHED }),
            line(d, "pool_moves_task", "Moves", slot(3)),
            line(d, "pool_schedule_task", "Schedule", slot(4)),
            line(d, "pool_common_task", "Common", slot(5)),
          ]),
          hidden: ["pool_merges_size", "pool_fetches_size"],
        };
      },
    },
    {
      id: "reads",
      title: "Reads",
      help: "Rows selected per second by queries (metric_log). The summary and the tooltip add the bytes.",
      build(d) {
        if (!d.ok("metric_log")) return { need: ["metric_log"] };
        const bytes = d.col("selected_bytes_s");
        return {
          unit: "rows",
          series: present([line(d, "selected_rows_s", "Rows", slot(1))]),
          meta: bytes ? format.bytesRate(stats(bytes).avg) : "",
          footer: bytes ? (i) => (bytes[i] === bytes[i] ? `Read ${format.bytesRate(bytes[i])}` : "") : null,
        };
      },
    },
    {
      id: "replication",
      title: "Replication",
      help: "The largest replica delay of the replicated tables (asynchronous_metric_log). The summary and the tooltip add the replication queue.",
      build(d) {
        if (!d.data.replicated_tables) return null;
        if (!d.ok("asynchronous_metric_log")) return { need: ["asynchronous_metric_log"] };
        const queue = d.col("replicas_queue");
        const delay = stats(d.col("replicas_max_delay")).max;
        return {
          unit: "seconds",
          series: present([line(d, "replicas_max_delay", "Max delay", slot(1))]),
          yInclude: [0, 1],
          meta: [Number.isFinite(delay) ? `max ${seconds(delay)}` : "", queue ? `queue max ${format.count(stats(queue).max)}` : ""].filter(Boolean).join(SEP),
          tone: delay > 300 ? "warn" : "",
          footer: queue ? (i) => (queue[i] === queue[i] ? `Queue ${format.count(queue[i])}` : "") : null,
        };
      },
    },
  ];

  const SOURCE_TEXT = {
    disabled: (table) => `system.${table} is disabled on this server (server configuration).`,
    unsupported: (table, source) => (table === "metric_log" && /transposed/i.test(source.message || "")
      ? "system.metric_log uses the transposed layout, which this version does not read: its charts use the other logs."
      : `This ClickHouse version lacks columns of system.${table}.`),
    not_granted: (table) => `The system account cannot read system.${table}.`,
    window_too_large: (table) => `Reading system.${table} for this range hit the time or row limit: pick a shorter range.`,
  };

  // --- Section ---------------------------------------------------------------

  function createPerformance(ctx) {
    const state = {
      range: defaultRange(),
      resolved: null,
      data: null,
      d: null,
      overview: null,
      error: null,
      loading: false,
      serial: 0,
      active: false,
      host: "",
      timer: 0,
      loadedAt: 0,
      charts: new Map(),
    };

    // The time range picker: the Observability component on its markup root
    // (the hidden native select of the filter bars is optional: no form here).
    const pickerRoot = h("div", { class: "themeSelect tracePicker tracePicker--range" },
      h("button", { type: "button", class: "button themeSelect__button tracePicker__button", id: "explorerMonitorRangeButton", aria: { haspopup: "dialog", expanded: "false" } }, "Time range"));
    const range = h("div", { class: "traceSearchBar explorerMonitorRange" }, h("div", { class: "traceSearchBar__range explorerMonitorRange__picker" }, pickerRoot));
    const controls = kit.sectionBar({
      id: "performance",
      label: "the performance charts",
      autoRefreshMs: AUTO_REFRESH_MS,
      lead: range,
      onRefresh: () => void load(true),
      onAutoRefresh: (on) => {
        autoRefreshPref().set(on);
        schedule();
        if (on && canAutoRefresh()) void load(false);
      },
    });
    const notes = h("div", { class: "explorerMonitorPerf__notes", id: "explorerMonitorPerfNotes" });
    const grid = h("div", { class: "explorerMonitorPerf__grid", id: "explorerMonitorPerfGrid" });
    const body = h("div", { class: "explorerMonitorPerf", id: "explorerMonitorPerf" }, notes, grid);
    ctx.panel.append(controls.bar, body);

    const picker = ns.timeRange.create(pickerRoot, {
      idPrefix: "explorerMonitor",
      getValue: () => state.range,
      getMaxMinutes: maxMinutes,
      settingName: "explorer.monitoring.max_lookback_days",
      onApply: (raw) => {
        picker.close();
        applyRange(raw);
      },
    });

    // The cards, built once in chart order; each holds its chart once drawn.
    for (const spec of CHARTS) {
      grid.insertAdjacentHTML("beforeend", ns.ui.chartCardHtml({
        title: spec.title,
        className: "explorerMonitorChart",
        id: `explorerMonitorChart-${spec.id}`,
        bodyClass: "explorerMonitorChart__body",
        attrs: { "data-chart": spec.id },
      }));
      const card = grid.lastElementChild;
      const head = $(".chartCard__head", card);
      $(".chartCard__title", card).title = spec.help;
      const badge = h("span", { class: "explorerMonitorChart__badge" });
      head.appendChild(badge);
      const plot = h("div", { class: "explorerMonitorChart__plot" });
      const empty = h("div", { class: "explorerMonitorChart__empty", hidden: true });
      $(".chartCard__body", card).append(plot, empty);
      card.hidden = true;
      state.charts.set(spec.id, { spec, card, plot, empty, badge, meta: $(".chartCard__meta", card), chart: null });
    }

    const autoRefresh = () => !!autoRefreshPref().get();
    const visible = () => state.active && ctx.panel.isConnected && !ctx.panel.hidden && ctx.panel.offsetParent !== null && !document.hidden;
    function spanMs() {
      const r = ns.timeRange.resolveRange(state.range, Date.now());
      return Number.isFinite(r.startMs) && Number.isFinite(r.endMs) ? r.endMs - r.startMs : Infinity;
    }
    const canAutoRefresh = () => ns.timeRange.isRelative(state.range) && spanMs() <= AUTO_REFRESH_MAX_SPAN_MS;

    document.addEventListener("visibilitychange", () => {
      if (autoRefresh() && canAutoRefresh() && visible() && Date.now() - state.loadedAt >= AUTO_REFRESH_MS) void load(false);
    });

    function schedule() {
      clearTimeout(state.timer);
      if (!state.active || !autoRefresh() || !canAutoRefresh()) return;
      state.timer = setTimeout(async () => {
        if (visible()) await load(false);
        schedule();
      }, AUTO_REFRESH_MS);
    }

    function query() {
      if (sameRange(state.range, defaultRange())) return "";
      return ns.timeRange.url.write(new URLSearchParams(), state.range).toString();
    }

    function applyRange(raw, { history = "push" } = {}) {
      const next = { from: String(raw.from), to: String(raw.to) };
      if (sameRange(next, state.range)) {
        void load(false);
        return;
      }
      state.range = next;
      picker.refresh();
      ctx.setQuery(query(), { history });
      schedule();
      void load(false);
    }

    // A drag over any chart: that window, whole seconds, for every chart.
    function onZoom(windowMs, fromUser) {
      if (!fromUser || !windowMs) return;
      let startMs = Math.floor(windowMs[0] / 1000) * 1000;
      let endMs = Math.ceil(windowMs[1] / 1000) * 1000;
      if (endMs - startMs < MIN_ZOOM_MS) {
        const centre = (startMs + endMs) / 2;
        startMs = Math.floor((centre - MIN_ZOOM_MS / 2) / 1000) * 1000;
        endMs = startMs + MIN_ZOOM_MS;
      }
      for (const entry of state.charts.values()) entry.chart?.setZoom(startMs, endMs);
      applyRange({ from: ns.timeRange.formatDateTime(startMs), to: ns.timeRange.formatDateTime(endMs) });
    }

    async function load(force = false) {
      const host = kit.hostId();
      if (!host) return;
      const resolved = ns.timeRange.resolveRange(state.range, Date.now());
      if (!Number.isFinite(resolved.startMs) || !Number.isFinite(resolved.endMs) || resolved.endMs <= resolved.startMs) {
        state.error = new Error("Select a valid time range.");
        render();
        return;
      }
      if (resolved.endMs - resolved.startMs > maxMinutes() * 60000) {
        state.error = new Error(`Max range is ${ns.timeRange.formatMinutes(maxMinutes())} (explorer.monitoring.max_lookback_days).`);
        render();
        return;
      }
      const serial = ++state.serial;
      state.loading = true;
      renderStatus();
      let data = null;
      let error = null;
      try {
        data = await ns.api.getExplorerMonitorSeries(host, { fromMs: resolved.startMs, toMs: Math.min(resolved.endMs, Date.now()) }, force);
      } catch (e) {
        error = e;
      }
      if (serial !== state.serial || kit.hostId() !== host) return;
      state.loading = false;
      state.host = host;
      state.loadedAt = Date.now();
      if (data) {
        state.data = data;
        state.d = null;
        state.error = null;
        state.resolved = resolved;
        state.loadedRange = { ...state.range };
        // No history at all: the current values instead (the Overview's answer).
        if (!sourceOk(data, "metric_log") && !sourceOk(data, "asynchronous_metric_log")) {
          try { state.overview = await ns.api.getExplorerMonitorOverview(host, false); } catch { state.overview = null; }
          if (serial !== state.serial) return;
        } else {
          state.overview = null;
        }
      } else {
        state.error = error;
      }
      render();
    }

    function renderStatus() {
      ns.uiState.busy(controls.button, state.loading);
      ns.uiState.busy(body, state.loading && !state.data);
      const data = state.data;
      const parts = ["This server"];
      if (state.resolved && ns.timeRange.isRelative(state.range)) parts.push(format.range(state.resolved.startMs, state.resolved.endMs));
      if (data?.step_seconds) parts.push(`${format.duration.fromSeconds(data.step_seconds)} buckets`);
      if (state.loading && !data) parts.push("Loading\u2026");
      else if (data?.generated_at_ms) parts.push(`Updated ${format.time(Number(data.generated_at_ms), { date: "never" })}${data.stale ? " (stale)" : ""}`);
      ns.util.setMetaLine(controls.meta, parts.join(SEP));
      controls.meta.title = "System logs are local to each node: every chart here is this server's own. Add each replica as a host to see it.";
      const allowed = canAutoRefresh();
      controls.input.disabled = !allowed;
      controls.input.checked = allowed && autoRefresh();
      controls.option.title = allowed ? "" : "Auto-refresh follows relative ranges of 6 hours or less";
      controls.option.classList.toggle("is-disabled", !allowed);
    }

    function dataView(data) {
      if (state.d && state.d.data === data) return state.d;
      const { xs, cols } = columns(data);
      state.d = {
        data,
        xs,
        col: (name) => cols.get(name) || null,
        ok: (source) => sourceOk(data, source),
      };
      return state.d;
    }

    function sourceIssues(data) {
      const issues = [];
      for (const [name, source] of Object.entries(data.sources || {})) {
        if (!source || source.status === "ok" || source.status === "out_of_range") continue;
        const text = SOURCE_TEXT[source.status];
        issues.push({ panel: name, table: source.table || name, reason: source.status, message: source.message, hint: source.hint, text: text ? text(source.table || name, source) : "" });
      }
      return issues;
    }

    function render() {
      renderStatus();
      picker.refresh();
      const data = state.data;
      const children = [];
      if (state.error) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.error, "The performance history is unavailable."), retry: () => void load(true), inset: true }));
      }
      if (!data) {
        if (!state.error) children.push(ns.uiState.block("loading", { label: "Loading the performance history\u2026", compact: true }));
        h.replace(notes, children);
        for (const entry of state.charts.values()) entry.card.hidden = true;
        return;
      }
      const issues = sourceIssues(data);
      const noHistory = !sourceOk(data, "metric_log") && !sourceOk(data, "asynchronous_metric_log");
      if (noHistory) {
        children.push(h("section", { class: "explorerMonitorPerf__current", id: "explorerMonitorPerfCurrent" },
          h("p", { class: "explorerMonitorCard__note" }, "History needs system.metric_log or system.asynchronous_metric_log (server configuration). The current values:"),
          state.overview ? kit.serverTiles(state.overview) : null));
      }
      for (const issue of issues) children.push(kit.issueBlock(issue));
      h.replace(notes, children);
      notes.hidden = !children.length;
      const d = dataView(data);
      for (const entry of state.charts.values()) drawChart(entry, d, noHistory);
    }

    function needText(sources) {
      return `Needs ${sources.map((name) => `system.${name}`).join(" or ")}`;
    }

    function drawChart(entry, d, noHistory) {
      const result = entry.spec.build(d);
      entry.card.dataset.source = result?.source || "";
      entry.card.classList.toggle("is-fallback", !!result?.fallback);
      if (!result || (result.need && noHistory)) {
        entry.card.hidden = true;
        return;
      }
      entry.card.hidden = false;
      if (result.need || !result.series?.length) {
        entry.meta.textContent = "";
        entry.badge.replaceChildren();
        entry.plot.hidden = true;
        entry.empty.hidden = false;
        const reasons = (result.need || []).map((name) => d.data.sources?.[name]?.status).filter(Boolean);
        h.replace(entry.empty, ns.uiState.block("empty", {
          title: needText(result.need || []),
          body: reasons.includes("not_granted") ? "The system account may not read it (see above)." : "Not available on this server (see above).",
          compact: true,
        }));
        return;
      }
      entry.plot.hidden = false;
      entry.empty.hidden = true;
      ns.util.setMetaLine(entry.meta, result.meta || "");
      entry.card.dataset.tone = result.tone || "";
      if (result.badge) entry.badge.replaceChildren(ns.badge.el(result.badge.text, { tone: result.badge.tone, title: result.badge.title, attrs: { "data-error-rate": result.badge.tone } }));
      else entry.badge.replaceChildren();
      const unit = UNITS[result.unit] || UNITS.count;
      const xs = d.xs;
      const step = Number(d.data.step_seconds || 0) * 1000;
      const options = {
        xs,
        xDomain: xs.length > 1 ? [xs[0], xs[xs.length - 1]] : undefined,
        series: result.series,
        type: result.type || "line",
        stack: !!result.stack,
        // Always a legend, so the cards of a row keep one height.
        legend: "always",
        markers: result.markers || [],
        yInclude: result.yInclude || [0],
        yUnit: (maxAbs) => unit.axis(maxAbs),
        yAxis: unit.yAxis || null,
        formatValue: (v) => unit.value(v),
        formatY: (v) => unit.value(v),
        bucketMs: step || undefined,
        tooltipFooter: (i) => {
          const extra = typeof result.footer === "function" ? result.footer(i) : "";
          const bucket = step ? `${format.duration.fromMs(step)} bucket` : "";
          return [extra, bucket].filter(Boolean).join(SEP);
        },
      };
      if (!entry.chart) {
        entry.chart = ns.chartCore.create(entry.plot, {
          ...options,
          hidden: result.hidden || [],
          xKind: "time",
          height: PLOT_HEIGHT,
          xFractionDigits: 0,
          syncKey: SYNC_KEY,
          legendClick: "toggle",
          tooltipNulls: false,
          onZoom,
        });
        entry.chart.root.setAttribute("role", "group");
        entry.chart.root.setAttribute("aria-label", `${entry.spec.title} chart`);
      } else {
        entry.chart.setData({ ...options, zoom: null });
      }
    }

    function resetForHost() {
      state.data = null;
      state.d = null;
      state.overview = null;
      state.error = null;
      state.serial += 1;
      state.loading = false;
      render();
    }

    return {
      // query: the address's from / to when the address opened the section.
      show(addressQuery) {
        state.active = true;
        if (addressQuery !== undefined) {
          const next = ns.timeRange.url.read(new URLSearchParams(String(addressQuery || ""))) || defaultRange();
          if (!sameRange(next, state.range)) {
            state.range = next;
            state.loadedAt = 0;
          }
        }
        if (state.host && state.host !== kit.hostId()) resetForHost();
        picker.refresh();
        renderStatus();
        const stale = ns.timeRange.isRelative(state.range) && Date.now() - state.loadedAt >= AUTO_REFRESH_MS;
        if (!state.data || !sameRange(state.loadedRange, state.range) || stale) void load(false);
        schedule();
      },
      hide() {
        state.active = false;
        clearTimeout(state.timer);
        if (picker.isOpen()) picker.close();
      },
      refresh(force = true) {
        if (state.host !== kit.hostId()) resetForHost();
        void load(force);
      },
      query,
    };
  }

  ns.explorerMonitor.register({ id: "performance", label: "Performance", order: 20, available: (f) => !!f.monitoring?.enabled && !!ns.chartCore && !!ns.timeRange, create: createPerformance });
})();
