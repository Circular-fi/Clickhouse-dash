(() => {
  "use strict";

  // The Performance part of the System Overview (docs/system.md
  // "Performance"): the selected server's history, read from its system logs
  // through /api/system/series (one pass each over metric_log,
  // asynchronous_metric_log and narrow query_log columns; the server picks
  // the step, at most 300 buckets).
  //
  // Ten charts on the shared engine (ns.chartCore) in ui.chartCardHtml
  // cards, two a row (one on a phone). They share a crosshair (syncKey) and
  // a drag over any of them sets the time range of all of them, as on
  // Metrics. The range is the Observability picker (ns.timeRange) on the
  // section's tab row, written to the address as from / to
  // (ns.timeRange.url) through the Overview's ctx.setQuery. Each chart has
  // one unit; a figure in another unit (bytes next to rows, the replication
  // queue next to its delay) is in the card's summary and in the tooltip at
  // the cursor.
  //
  // A source the server lacks (a disabled log, metric_log in the transposed
  // layout, a missing grant) degrades only the charts that need it: they
  // fall back to another source when one says the same thing (queries/s and
  // the average latency), otherwise they say what is missing. Without
  // metric_log and asynchronous_metric_log the part says so: the current
  // values are the Overview's tiles above it.
  //
  // ns.systemPerf.create({ setQuery, rangeRoot }) -> { el,
  //   show(addressQuery), hide(), load(force), reset(), query() }
  // No timer: the charts read on show (again when a relative range was read
  // STALE_AFTER_MS ago or more), on a range change and the refresh button.
  // rangeRoot: the time range slot of the Overview's filter bar (its
  // picker root, the "systemPerf" ids), on which the range mounts.

  const ns = window.ChDash;
  if (!ns || !ns.systemView) return;
  const { h } = ns;
  const { $ } = ns.dom;
  const format = ns.format;
  const kit = ns.systemView.kit;
  const SEP = kit.SEP;

  const SYNC_KEY = "systemPerf";
  const PLOT_HEIGHT = 172;
  // A relative range read this long ago reads again when the Overview shows.
  const STALE_AFTER_MS = 30000;
  // A drag narrower than this widens around its centre (one 10 s bucket
  // a point would draw nothing readable).
  const MIN_ZOOM_MS = 60000;
  // The error share of finished queries: neutral under 1 %, a warning to 5 %,
  // danger from there.
  const ERROR_WARN = 0.01;
  const ERROR_DANGER = 0.05;

  const settings = () => kit.features() || {};
  const maxMinutes = () => Math.max(1, Number(settings().max_lookback_days) || 30) * 1440;
  const defaultRange = () => ({ from: `now-${ns.timeRange.minutesToSpan(Number(settings().default_lookback_minutes) || 60)}`, to: "now" });
  const sameRange = (a, b) => String(a?.from || "") === String(b?.from || "") && String(a?.to || "") === String(b?.to || "");

  // --- Units -------------------------------------------------------------------

  const BYTE_STEPS = [[1024 ** 4, "TB"], [1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  const UNITS = {
    qps: { value: (v) => format.rate(v), axis: (max) => compactAxis(max, "/s") },
    rows: { value: (v) => format.rate(v, "rows"), axis: (max) => compactAxis(max, "/s") },
    count: { value: (v) => format.number(v), axis: (max) => compactAxis(max, "") },
    // Tasks running (an average per bucket: "0.05 running").
    running: { value: (v) => `${format.number(v)} running`, axis: (max) => compactAxis(max, " running") },
    cores: { value: (v) => `${format.number(v)} cores`, axis: () => ({ factor: 1, suffix: " cores" }) },
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
            // Sparse percentiles are dots: room above the largest.
            yHeadroom: 0.15,
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
          unit: "running",
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

  // --- Part ------------------------------------------------------------------

  function create(ctx) {
    const state = {
      range: defaultRange(),
      resolved: null,
      loadedRange: null,
      data: null,
      d: null,
      error: null,
      loading: false,
      serial: 0,
      active: false,
      host: "",
      loadedAt: 0,
      pendingRender: false,
      charts: new Map(),
    };

    // The range picker leads the Overview's filter bar (as on Queries and
    // Disks).
    const part = kit.part("performance", "Performance");
    const notes = h("div", { class: "systemPerf__notes", id: "systemPerfNotes" });
    const grid = h("div", { class: "systemPerf__grid", id: "systemPerfGrid" });
    const body = h("div", { class: "systemPerf", id: "systemPerf" }, notes, grid);
    part.body.appendChild(body);

    const range = ns.timeRange.create(ctx.rangeRoot, {
      idPrefix: "systemPerf",
      getValue: () => state.range,
      getMaxMinutes: maxMinutes,
      settingName: "system.max_lookback_days",
      onApply: (raw) => {
        range.close();
        applyRange(raw);
      },
    });

    // The cards, built once in chart order; each holds its chart once drawn.
    for (const spec of CHARTS) {
      grid.insertAdjacentHTML("beforeend", ns.ui.chartCardHtml({
        title: spec.title,
        className: "systemChart",
        id: `systemChart-${spec.id}`,
        bodyClass: "systemChart__body",
        attrs: { "data-chart": spec.id },
      }));
      const card = grid.lastElementChild;
      const head = $(".chartCard__head", card);
      $(".chartCard__title", card).title = spec.help;
      const badge = h("span", { class: "systemChart__badge" });
      head.appendChild(badge);
      const plot = h("div", { class: "systemChart__plot" });
      const empty = h("div", { class: "systemChart__empty", hidden: true });
      $(".chartCard__body", card).append(plot, empty);
      card.hidden = true;
      state.charts.set(spec.id, { spec, card, plot, empty, badge, meta: $(".chartCard__meta", card), chart: null });
    }

    const stale = () => ns.timeRange.isRelative(state.range) && Date.now() - state.loadedAt >= STALE_AFTER_MS;

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
      range.refresh();
      ctx.setQuery(query(), { history });
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
        state.error = new Error(`Max range is ${ns.timeRange.formatMinutes(maxMinutes())} (system.max_lookback_days).`);
        render();
        return;
      }
      const serial = ++state.serial;
      state.loading = true;
      ns.uiState.busy(body, !state.data);
      let data = null;
      let error = null;
      try {
        data = await ns.api.getSystemSeries(host, { fromMs: resolved.startMs, toMs: Math.min(resolved.endMs, Date.now()) }, force);
      } catch (e) {
        error = e;
      }
      if (serial !== state.serial || kit.hostId() !== host) return;
      state.loading = false;
      ns.uiState.busy(body, false);
      state.host = host;
      state.loadedAt = Date.now();
      if (data) {
        state.data = data;
        state.d = null;
        state.error = null;
        state.resolved = resolved;
        state.loadedRange = { ...state.range };
      } else {
        state.error = error;
      }
      // An answer that lands while the Overview is hidden (another section)
      // draws when it shows again, not now.
      if (!state.active) {
        state.pendingRender = true;
        return;
      }
      render();
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
      state.pendingRender = false;
      range.refresh();
      const data = state.data;
      const children = [];
      if (state.error) {
        children.push(ns.uiState.banner(h("div"), { message: ns.util.errorText(state.error, "The performance history is unavailable."), retry: () => void load(true), inset: true }));
      }
      if (!data) {
        if (!state.error) children.push(ns.uiState.block("loading", { label: "Loading the performance history\u2026", compact: true }));
        h.replace(notes, children);
        notes.hidden = !children.length;
        for (const entry of state.charts.values()) entry.card.hidden = true;
        return;
      }
      const issues = sourceIssues(data);
      const noHistory = !sourceOk(data, "metric_log") && !sourceOk(data, "asynchronous_metric_log");
      if (noHistory) {
        children.push(h("p", { class: "systemCard__note systemPerf__current", id: "systemPerfCurrent" },
          "History needs system.metric_log or system.asynchronous_metric_log (server configuration): the current values are the tiles at the top."));
      }
      for (const issue of issues) children.push(kit.issueBlock(issue));
      h.replace(notes, children);
      notes.hidden = !children.length;
      const d = dataView(data);
      for (const entry of state.charts.values()) drawChart(entry, d, noHistory);
      balanceGrid();
    }

    // Two charts a row: the flat cards (one line each) go last, on rows of
    // their own; a chart left alone on its row takes the whole row.
    function balanceGrid() {
      const shown = [...state.charts.values()].filter((entry) => !entry.card.hidden);
      const full = shown.filter((entry) => !entry.card.classList.contains("is-flat"));
      for (const entry of shown) entry.card.classList.remove("is-alone");
      if (full.length % 2 === 1) full[full.length - 1].card.classList.add("is-alone");
    }

    // A chart whose every series is 0 (or has no sample) over the range: a
    // line that says so instead of an empty plot.
    function flatSeries(series) {
      let seen = false;
      for (const s of series) {
        const values = s.values || [];
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (v !== v) continue;
          if (v !== 0) return false;
          seen = true;
        }
      }
      return seen;
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
      entry.card.classList.remove("is-flat");
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
      const unit = UNITS[result.unit] || UNITS.count;
      const flat = flatSeries(result.series);
      entry.card.classList.toggle("is-flat", flat);
      if (flat) {
        entry.meta.textContent = "";
        entry.badge.replaceChildren();
        entry.card.dataset.tone = "";
        entry.plot.hidden = true;
        entry.empty.hidden = false;
        const names = result.series.map((s) => s.label);
        h.replace(entry.empty, h("p", { class: "systemChart__flat" },
          h("b", null, `${names.join(", ")} ${unit.value(0)}`), " over the whole range"));
        entry.chart?.destroy?.();
        entry.chart = null;
        return;
      }
      entry.plot.hidden = false;
      entry.empty.hidden = true;
      ns.util.setMetaLine(entry.meta, result.meta || "");
      entry.card.dataset.tone = result.tone || "";
      if (result.badge) entry.badge.replaceChildren(ns.badge.el(result.badge.text, { tone: result.badge.tone, title: result.badge.title, attrs: { "data-error-rate": result.badge.tone } }));
      else entry.badge.replaceChildren();
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
        yHeadroom: result.yHeadroom || 0,
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

    function reset() {
      state.data = null;
      state.d = null;
      state.error = null;
      state.serial += 1;
      state.loading = false;
      state.loadedAt = 0;
      render();
    }

    render();
    return {
      el: part.el,
      // addressQuery: the address's from / to when the address opened the
      // Overview (undefined: keep the range).
      show(addressQuery) {
        state.active = true;
        if (addressQuery !== undefined) {
          const next = ns.timeRange.url.read(new URLSearchParams(String(addressQuery || ""))) || defaultRange();
          if (!sameRange(next, state.range)) {
            state.range = next;
            state.loadedAt = 0;
          }
        }
        if (state.host && state.host !== kit.hostId()) reset();
        if (state.pendingRender) render();
        range.refresh();
        if (!state.data || !sameRange(state.loadedRange, state.range) || stale()) void load(false);
      },
      hide() {
        state.active = false;
        if (range.isOpen()) range.close();
      },
      load,
      reset,
      query,
    };
  }

  ns.systemPerf = { create, CHARTS: CHARTS.map((spec) => spec.id) };
})();
