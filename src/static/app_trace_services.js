(() => {
  "use strict";
  // Services tab of the Traces page, after HyperDX's ServicesDashboardPage:
  // RED metrics (rate, errors, duration) of every service's entry spans
  // (SpanKind Server / Consumer or root spans) from /api/traces/services, a
  // sortable table with sparklines and, per service, a detail panel with rate
  // / error rate / latency charts, release markers (first span of each
  // service.version), the most time-consuming endpoints, the slowest spans and
  // the database statements (/api/traces/services/db). The search bar's
  // range, pickers and chips apply here as span filters of the entry spans.
  const ns = window.ChDash;
  if (!ns?.traceTabs) return;

  const SORT_KEYS = ["name", "rate", "errors", "p50", "p95", "p99", "time"];
  const DEFAULT_SORT = { key: "time", dir: "desc" };
  const DETAIL_CHART_HEIGHT = 150;
  const SPARK_W = 112;
  const SPARK_H = 24;

  let ctx = null;
  let root = null;
  const esc = (value) => ctx.esc(value);
  const fmt = (ns_) => ctx.formatDuration(ns_);

  const view = {
    seq: 0,
    key: "",
    payload: null,
    loading: false,
    error: "",
    sort: { ...DEFAULT_SORT },
    scope: "entry",
    exact: false,
    detailName: "",
    detail: { key: "", payload: null, loading: false, error: "", seq: 0 },
    db: { key: "", payload: null, loading: false, error: "", seq: 0 },
    filters: null,
    searchKey: null,
  };

  // ------------------------------------------------------------ formatting

  // A failed request's Retry: "list", "detail" or "db" (onClick).
  const RETRY = (what) => `<button type="button" class="button button--small" data-svc-retry="${what}">Retry</button>`;

  // A request rate in the largest unit it reaches 1 in: 2.4/s, 29/min, 6/h.
  const RATE_UNITS = [{ per: 1, suffix: "/s", word: "second" }, { per: 60, suffix: "/min", word: "minute" }, { per: 3600, suffix: "/h", word: "hour" }];
  function rateUnit(perSecond) {
    const value = Number(perSecond);
    if (!Number.isFinite(value) || value <= 0) return RATE_UNITS[0];
    return RATE_UNITS.find((unit) => value * unit.per >= 1) || RATE_UNITS[RATE_UNITS.length - 1];
  }

  function rateText(perSecond, unit = rateUnit(perSecond)) {
    const value = Number(perSecond);
    if (!Number.isFinite(value) || value <= 0) return `0${unit.suffix}`;
    return `${compact(value * unit.per)}${unit.suffix}`;
  }

  function compact(value) {
    const n = Number(value || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
    if (n >= 100) return String(Math.round(n));
    if (n >= 10) return n.toFixed(1).replace(/\.0$/, "");
    return n.toFixed(2).replace(/\.?0+$/, "");
  }

  function percentText(value) {
    const n = Number(value || 0);
    if (!n) return "0%";
    if (n < 0.01) return "<0.01%";
    return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)}%`.replace(/\.0+%$/, "%");
  }

  // Axis ticks of a detail chart (app_chart_core.js yAxis): round values in
  // [0, max], each labelled by the table's own formatter, so the axis, the
  // cursor readout, the tooltip and the table share one unit and precision
  // ("29/min" in the table against "20/min, 40/min"; "1.21%" against
  // "0.50%, 1%, 1.50%").
  function unitAxis(yMax, label) {
    const ticks = ns.chartCore.linearTicks(0, yMax > 0 ? yMax : 1, 4);
    const top = ticks.values[ticks.values.length - 1];
    const max = top < yMax ? yMax : top;
    return { min: 0, max, step: ticks.step, ticks: ticks.values.map((v) => ({ v, label: label(v) })) };
  }

  // Seconds of the window a payload describes.
  function windowSeconds(payload) {
    const range = Array.isArray(payload?.window) ? payload.window : payload?.range || [0, 1];
    return Math.max(1, (Number(range[1]) - Number(range[0])) / 1000);
  }

  function statsRow(row) {
    return {
      name: String(row?.[0] ?? ""),
      spans: Number(row?.[1] || 0),
      errors: Number(row?.[2] || 0),
      p50: Number(row?.[3] || 0),
      p95: Number(row?.[4] || 0),
      p99: Number(row?.[5] || 0),
      total: Number(row?.[6] || 0),
    };
  }

  function withRates(rows, payload) {
    const seconds = windowSeconds(payload);
    const total = rows.reduce((sum, row) => sum + row.total, 0) || 1;
    return rows.map((row) => ({ ...row, rate: row.spans / seconds, errorPct: row.spans ? (row.errors / row.spans) * 100 : 0, share: (row.total / total) * 100 }));
  }

  function seriesOf(payload, name) {
    const points = payload?.series?.[name];
    return (Array.isArray(points) ? points : []).map((p) => ({
      t: Number(p[0]), spans: Number(p[1] || 0), errors: Number(p[2] || 0), p50: Number(p[3] || 0), p95: Number(p[4] || 0), p99: Number(p[5] || 0),
    })).sort((a, b) => a.t - b.t);
  }

  function durationFilterEnabled() {
    return ctx?.model?.meta?.features?.duration_filter !== false;
  }

  // ------------------------------------------------------------ requests

  function requestFilters(filters) {
    const out = { ...filters, bucket_origin_ms: String(ctx.localMidnight(Number(filters.start_ms))), scope: view.scope };
    delete out.limit;
    if (view.exact) out.exact = "1";
    return out;
  }

  // Relative ranges resolve anew for every search: within the same minute
  // the answer is reused (Back from a trace, tab switches).
  function keyOf(params) {
    return JSON.stringify({ ...params, start_ms: Math.floor(Number(params.start_ms) / 60000), end_ms: Math.floor(Number(params.end_ms) / 60000) });
  }

  // force: an explicit search (Search button, scope / exact toggles) asks
  // again even within the same minute.
  async function run(filters, { force = false } = {}) {
    view.filters = filters;
    view.searchKey = ns.traceSearch?.searchKey?.() || "";
    const params = requestFilters(filters);
    const key = keyOf(params);
    if (!force && key === view.key && (view.payload || view.loading)) {
      render();
      if (view.detailName) void loadDetail();
      return;
    }
    view.key = key;
    const seq = ++view.seq;
    view.loading = true;
    view.error = "";
    render();
    try {
      const payload = await ctx.api.getTraceServices(ctx.currentHost(), params);
      if (seq !== view.seq) return;
      view.payload = payload;
      ctx.registerServiceColors((payload?.services || []).map((row) => row[0]));
    } catch (error) {
      if (seq !== view.seq) return;
      view.payload = null;
      view.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === view.seq) {
        view.loading = false;
        render();
      }
    }
    if (seq === view.seq && view.detailName) void loadDetail();
  }

  async function loadDetail() {
    const name = view.detailName;
    if (!name || !view.filters) return;
    const params = { ...requestFilters(view.filters), detail: name };
    const key = keyOf(params);
    const detail = view.detail;
    if (detail.key === key && (detail.payload || detail.loading)) { renderDetail(); return; }
    detail.key = key;
    const seq = ++detail.seq;
    detail.loading = true;
    detail.error = "";
    detail.payload = null;
    renderDetail();
    void loadDb(params);
    try {
      const payload = await ctx.api.getTraceServices(ctx.currentHost(), params);
      if (seq !== detail.seq) return;
      detail.payload = payload;
    } catch (error) {
      if (seq !== detail.seq) return;
      detail.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === detail.seq) {
        detail.loading = false;
        renderDetail();
      }
    }
  }

  async function loadDb(params) {
    const db = view.db;
    const dbParams = { ...params };
    delete dbParams.exact;
    delete dbParams.scope;
    delete dbParams.bucket_origin_ms;
    const key = keyOf(dbParams);
    if (db.key === key && (db.payload || db.loading)) return;
    db.key = key;
    const seq = ++db.seq;
    db.loading = true;
    db.error = "";
    db.payload = null;
    try {
      const payload = await ctx.api.getTraceServicesDb(ctx.currentHost(), dbParams);
      if (seq !== db.seq) return;
      db.payload = payload;
    } catch (error) {
      if (seq !== db.seq) return;
      db.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === db.seq) {
        db.loading = false;
        renderDetail();
      }
    }
  }

  // ------------------------------------------------------------- the table

  function sortRows(rows) {
    const { key, dir } = view.sort;
    const value = (row) => ({ name: row.name, rate: row.rate, errors: row.errorPct, p50: row.p50, p95: row.p95, p99: row.p99, time: row.total }[key]);
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = value(a), y = value(b);
      if (key === "name") return sign * (x < y ? -1 : x > y ? 1 : 0);
      return sign * (x - y) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
  }

  function sparkline(points, field, cls, maxValue = null) {
    if (points.length < 2) return `<svg class="traceSvcSpark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" aria-hidden="true"></svg>`;
    const range = view.payload?.range || [points[0].t, points[points.length - 1].t];
    const t0 = Number(range[0]), t1 = Math.max(t0 + 1, Number(range[1]));
    const max = maxValue ?? Math.max(1, ...points.map((p) => p[field]));
    const xOf = (t) => ((t - t0) / (t1 - t0)) * SPARK_W;
    const yOf = (v) => SPARK_H - 1.5 - (Math.max(0, v) / (max || 1)) * (SPARK_H - 3);
    const line = (key) => points.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p[key]).toFixed(1)}`).join(" ");
    const errors = field === "spans" && points.some((p) => p.errors > 0)
      ? `<polyline class="traceSvcSpark__errors" points="${line("errors")}"/>` : "";
    return `<svg class="traceSvcSpark ${cls}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true"><polyline class="traceSvcSpark__line" points="${line(field)}"/>${errors}</svg>`;
  }

  function headerCell(key, label, title, numeric = true) {
    const active = view.sort.key === key;
    const sort = active ? (view.sort.dir === "asc" ? "ascending" : "descending") : "none";
    return `<th scope="col" class="${numeric ? "is-num" : ""}" aria-sort="${sort}"><button type="button" class="traceSvcSort${active ? " is-active" : ""}" data-svc-sort="${key}" title="${esc(title)}">${esc(label)}${active ? `<span class="traceSvcSort__dir" aria-hidden="true">${view.sort.dir === "asc" ? "\u25b2" : "\u25bc"}</span>` : ""}</button></th>`;
  }

  function p99Cell(row, service, operation = "") {
    if (!durationFilterEnabled() || !(row.p99 > 0)) return esc(fmt(row.p99));
    return `<button type="button" class="traceSvcLink traceSvcLink--p99" data-svc-p99="${esc(row.p99)}" data-svc-service="${esc(service)}" data-svc-operation="${esc(operation)}" title="Search traces${operation ? ` of ${esc(operation)}` : ""} lasting at least the P99 (${esc(fmt(row.p99))})">${esc(fmt(row.p99))}</button>`;
  }

  function tableHtml(rows) {
    const body = sortRows(rows).map((row) => {
      const points = seriesOf(view.payload, row.name);
      const selected = row.name === view.detailName;
      return `<tr class="traceSvcRow${selected ? " is-selected" : ""}" data-svc-row="${esc(row.name)}" tabindex="0" aria-selected="${selected ? "true" : "false"}" style="--trace-service-color:${ctx.serviceColor(row.name)}">
        <th scope="row" class="traceSvcRow__name"><span class="traceSvcRow__cell"><span class="traceSvcDot" aria-hidden="true"></span><span class="traceSvcRow__label" title="${esc(row.name)}">${esc(row.name)}</span></span></th>
        <td class="is-num" data-svc-col="rate" title="${esc(`${Math.round(row.spans).toLocaleString()} entry spans`)}">${esc(rateText(row.rate))}</td>
        <td class="is-num${row.errors ? " has-errors" : ""}" data-svc-col="errors" title="${esc(`${Math.round(row.errors).toLocaleString()} errors`)}">${esc(percentText(row.errorPct))}</td>
        <td class="is-num" data-svc-col="p50">${esc(fmt(row.p50))}</td>
        <td class="is-num" data-svc-col="p95">${esc(fmt(row.p95))}</td>
        <td class="is-num" data-svc-col="p99">${p99Cell(row, row.name)}</td>
        <td class="traceSvcShare" data-svc-col="time" title="${esc(`${fmt(row.total)} in total`)}"><span class="traceSvcShare__bar" style="--share:${Math.min(100, row.share).toFixed(2)}%"></span><span class="traceSvcShare__text">${esc(percentText(row.share))}</span></td>
        <td class="traceSvcTrend" title="Requests over time (errors in red)">${sparkline(points, "spans", "traceSvcSpark--rate")}</td>
        <td class="traceSvcTrend" title="P95 over time">${sparkline(points, "p95", "traceSvcSpark--p95")}</td>
      </tr>`;
    }).join("");
    return `<table class="traceSvcTable" aria-label="Services">
      <thead><tr>${headerCell("name", "Service", "Sort by service name", false)}${headerCell("rate", "Requests", "Entry spans per second, minute or hour: the largest unit the rate reaches 1 in")}${headerCell("errors", "Errors", "Share of entry spans with StatusCode Error")}${headerCell("p50", "P50", "Median entry span duration")}${headerCell("p95", "P95", "95th percentile entry span duration")}${headerCell("p99", "P99", "99th percentile entry span duration; click one to search slower traces")}${headerCell("time", "Time share", "Share of the total time spent in entry spans (sum of Duration)", false)}<th scope="col" class="traceSvcTrend">Requests trend</th><th scope="col" class="traceSvcTrend">P95 trend</th></tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function statusHtml(payload) {
    if (!payload) return "";
    const bits = [];
    const fraction = Number(payload.sample_fraction || 1);
    if (payload.estimated) {
      bits.push(`<span class="traceSvcBadge traceSvcBadge--estimated" title="${esc(`The window holds about ${Number(payload.estimated_rows || 0).toLocaleString()} spans (over ${Number(payload.exact_rows_limit || 0).toLocaleString()}): one time slice per chart bucket was read and the counts scaled up. Percentiles come from the sampled spans.`)}">\u2248 Estimated from ${esc(percentText(fraction * 100))} of the window</span><button type="button" class="traceSvcAction" data-svc-exact>Compute exactly</button>`);
    }
    if (payload.partial) bits.push('<span class="traceSvcBadge traceSvcBadge--partial" title="The query reached its time budget before reading the whole window: the numbers cover only part of it.">Partial: time budget reached</span>');
    if (view.exact && !payload.estimated) bits.push('<button type="button" class="traceSvcAction" data-svc-sampled title="Go back to the time-sampled answer on large windows">Allow sampling</button>');
    return bits.join("");
  }

  function scopeHtml() {
    const option = (value, label, title) => `<button type="button" class="traceSvcScope__option${view.scope === value ? " is-active" : ""}" data-svc-scope="${value}" aria-pressed="${view.scope === value ? "true" : "false"}" title="${esc(title)}">${esc(label)}</button>`;
    return `<div class="traceSvcScope" role="group" aria-label="Spans measured">${option("entry", "Entry spans", "Spans receiving work: SpanKind Server or Consumer, or root spans")}${option("root", "Root spans", "Only root spans (no parent): cheaper on long ranges, one per trace entry")}</div>`;
  }

  function render() {
    if (!root) return;
    const payload = view.payload;
    const rows = payload ? withRates((payload.services || []).map(statsRow), payload) : [];
    const count = rows.length;
    const bucket = payload ? fmt(Number(payload.bucket_ms || 60000) * 1e6) : "";
    const timing = payload?.timing_ms?.total != null ? ` · ${(Number(payload.timing_ms.total) / 1000).toFixed(2)} s` : "";
    const meta = payload ? `${view.scope === "root" ? "root spans" : "entry spans"} · ${bucket} buckets${timing}` : "";
    let body;
    if (view.error && !payload) body = `<div class="tracesEmpty traceChartError" role="alert">${esc(view.error)} ${RETRY("list")}</div>`;
    else if (!payload) body = `<div class="tracesEmpty">${view.loading ? "Loading services\u2026" : "Search to load services."}</div>`;
    else if (!count) body = `<div class="tracesEmpty">No ${view.scope === "root" ? "root" : "entry"} spans match in this range.</div>`;
    else body = tableHtml(rows);
    releaseDetailCharts();
    root.innerHTML = `<div class="traceSvc${view.loading ? " is-loading" : ""}" aria-busy="${view.loading ? "true" : "false"}">
      <div class="traceSvc__toolbar">
        <h2 id="traceSvcCount">${payload ? `${count} Service${count === 1 ? "" : "s"}` : "Services"}</h2>
        <span class="traceSvc__meta" title="Entry spans: SpanKind Server / Consumer (and SPAN_KIND_* spellings) or root spans. The search filters apply to these spans.">${esc(meta)}</span>
        <span class="traceSvc__status">${statusHtml(payload)}${view.loading && payload ? '<span class="traceSvcBadge">Loading\u2026</span>' : ""}</span>
        ${scopeHtml()}
      </div>
      ${view.error && payload ? `<div class="traceSvc__error" role="alert">${esc(view.error)}</div>` : ""}
      <div class="traceSvc__table">${body}</div>
      <aside id="traceSvcDetail" class="traceSvcDetail" role="dialog" aria-modal="false" aria-labelledby="traceSvcDetailTitle" hidden></aside>
    </div>`;
    renderDetail();
  }

  // ------------------------------------------------------------ the detail

  // The detail charts draw on the shared canvas engine (app_chart_core.js):
  // per chart one canvas, the engine's cursor and tooltip (one crosshair over
  // the three charts), release markers as DOM annotations, drag to search a
  // range. points: [{ t (bucket start), ... }].
  function detailChart(container, { start, end, bucketMs, points, series, type, axis, releases, footer, format }) {
    const chart = ctx.chart;
    if (!points.length) { chart.chartMessage(container, "No data in this range."); return; }
    const grid = chart.bucketGrid(points.map((p) => [p.t]), bucketMs);
    const n = grid.starts.length;
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i += 1) xs[i] = grid.starts[i] + bucketMs / 2;
    // Lines break over buckets without spans (NULL); bars there are empty.
    const nulls = new Uint8Array(n).fill(1);
    points.forEach((p, k) => { nulls[grid.slot[k]] = 0; });
    const columns = series.map((s) => {
      const values = new Float64Array(n).fill(type === "bar" ? 0 : NaN);
      points.forEach((p, k) => { const v = s.value(p); if (Number.isFinite(v)) values[grid.slot[k]] = v; });
      return { id: s.id, label: s.label, color: s.color, values, nulls: type === "bar" ? null : nulls };
    });
    let yAxis;
    if (axis === "duration") {
      yAxis = (yMin, yMax) => {
        const scale = chart.durationAxis(yMin, yMax, 5);
        return { min: scale.axisMin, max: scale.axisMax, ticks: scale.values.map((t) => ({ v: t.value, label: t.label })) };
      };
    } else {
      // "rate" (values already in the table's rate unit) and "percent": the
      // axis labels are what the readouts print.
      yAxis = (yMin, yMax) => unitAxis(yMax, format);
    }
    const byIndex = new Map(points.map((p, k) => [grid.slot[k], p]));
    chart.mountChart(container, "service", {
      height: DETAIL_CHART_HEIGHT, xKind: "time", xs, xDomain: [start, end], zoom: null,
      series: columns, type, stack: type === "bar", legend: false, syncKey: "traces-service", tooltipNulls: false,
      yAxis, annotations: releases,
      xReadout: (i) => chart.bucketRangeLabel(xs[i] - bucketMs / 2, bucketMs),
      formatValue: (v) => format(v),
      formatY: (v) => format(Math.max(0, v)),
      tooltipFooter: footer ? (i) => { const p = byIndex.get(i); return p ? footer(p) : ""; } : null,
      onZoom: (range, fromUser) => { if (fromUser && range) chart.zoomSearchRange(range); },
    });
  }

  // The detail's charts leave with it (their engine state is released).
  function releaseDetailCharts() {
    root?.querySelectorAll("#traceSvcDetail [data-svc-chart]").forEach((el) => ctx.chart.unmountChart(el));
  }

  function drawDetailCharts() {
    const panel = root?.querySelector("#traceSvcDetail");
    const payload = view.detail.payload;
    if (!panel || panel.hidden || !payload) return;
    const points = seriesOf(payload, view.detailName);
    const range = payload.range || [0, 1];
    const start = Number(range[0]), end = Math.max(start + 1000, Number(range[1]));
    const bucketMs = Math.max(1000, Number(payload.bucket_ms || 60000));
    const bucketSeconds = bucketMs / 1000;
    const releases = (payload.releases || []).map((r) => ({ label: String(r[0]), x: Number(r[1]), title: `Release ${r[0]}: first span ${new Date(Number(r[1])).toLocaleString()}`, className: "traceSvcRelease" }));
    const spansText = (p) => `${Math.round(p.spans).toLocaleString()} spans${p.errors ? `, ${Math.round(p.errors).toLocaleString()} errors` : ""}`;
    // The rate chart counts in the unit of the service's Requests figure
    // (table row and detail header): 29/min there, a per-minute axis here.
    const unit = rateUnit(detailRow(payload, view.detailName)?.rate);
    const perUnit = unit.per / bucketSeconds;
    const rate = panel.querySelector('[data-svc-chart="rate"]');
    if (rate) detailChart(rate, {
      start, end, bucketMs, points, type: "bar", axis: "rate", releases, footer: spansText, format: (v) => rateText(v / unit.per, unit),
      series: [
        { id: "ok", label: "Successful", color: ctx.serviceColor(view.detailName), value: (p) => Math.max(0, p.spans - p.errors) * perUnit },
        { id: "errors", label: "Errors", color: "var(--traceError)", value: (p) => p.errors * perUnit },
      ],
    });
    const errors = panel.querySelector('[data-svc-chart="errors"]');
    if (errors) detailChart(errors, {
      start, end, bucketMs, points, type: "line", axis: "percent", releases, footer: spansText, format: percentText,
      series: [{ id: "error_rate", label: "Error rate", color: "var(--traceError)", value: (p) => (p.spans ? (p.errors / p.spans) * 100 : 0) }],
    });
    const latency = panel.querySelector('[data-svc-chart="latency"]');
    if (latency) detailChart(latency, {
      start, end, bucketMs, points, type: "line", axis: "duration", releases, format: fmt,
      series: [["p50", "P50", "#54a24b"], ["p95", "P95", "#f58518"], ["p99", "P99", "#b279a2"]].map(([id, label, color]) => ({ id, label, color, value: (p) => p[id] })),
    });
  }

  function endpointsHtml(payload, service) {
    const rows = withRates((payload.endpoints || []).map(statsRow), payload);
    if (!rows.length) return '<div class="traceSvcEmpty">No endpoints in this range.</div>';
    const body = rows.map((row) => `<tr data-svc-endpoint="${esc(row.name)}">
      <th scope="row"><button type="button" class="traceSvcLink" data-svc-operation-search="${esc(row.name)}" title="Search traces of ${esc(service)} / ${esc(row.name)}">${esc(row.name)}</button></th>
      <td class="is-num">${esc(rateText(row.rate))}</td>
      <td class="is-num${row.errors ? " has-errors" : ""}">${esc(percentText(row.errorPct))}</td>
      <td class="is-num">${esc(fmt(row.p95))}</td>
      <td class="is-num">${p99Cell(row, service, row.name)}</td>
      <td class="traceSvcShare" title="${esc(`${fmt(row.total)} in total`)}"><span class="traceSvcShare__bar" style="--share:${Math.min(100, row.share).toFixed(2)}%"></span><span class="traceSvcShare__text">${esc(fmt(row.total))}</span></td>
    </tr>`).join("");
    return `<table class="traceSvcTable traceSvcTable--compact" aria-label="Most time-consuming endpoints"><thead><tr><th scope="col">Endpoint</th><th scope="col" class="is-num">Requests</th><th scope="col" class="is-num">Errors</th><th scope="col" class="is-num">P95</th><th scope="col" class="is-num">P99</th><th scope="col">Total time</th></tr></thead><tbody>${body}</tbody></table>${payload.endpoints_truncated ? '<div class="traceSvcEmpty">Only the 100 most time-consuming endpoints are listed.</div>' : ""}`;
  }

  function slowestHtml(payload) {
    const rows = Array.isArray(payload.slowest) ? payload.slowest : [];
    if (!rows.length) return '<div class="traceSvcEmpty">No spans in this range.</div>';
    return `<ol class="traceSvcSlowest">${rows.map((row) => {
      const [traceId, spanId, operation, startMs, durationNs, status] = row;
      const href = ctx.spanTraceUrl(String(traceId), String(spanId || ""));
      return `<li><a class="traceSvcSlowest__link" href="${esc(href)}" data-svc-trace="${esc(traceId)}" data-svc-span="${esc(spanId)}" title="Open trace ${esc(traceId)}"><b class="traceSvcSlowest__duration">${esc(fmt(durationNs))}</b><span class="traceSvcSlowest__op">${esc(operation)}</span>${status === "Error" ? '<span class="traceSvcSlowest__error">ERROR</span>' : ""}<time class="traceSvcSlowest__time">${esc(new Date(Number(startMs)).toLocaleString())}</time><code>${esc(String(traceId).slice(0, 12))}</code></a></li>`;
    }).join("")}</ol>`;
  }

  function releasesHtml(payload) {
    if (payload.releases_supported === false) return "";
    const rows = Array.isArray(payload.releases) ? payload.releases : [];
    const items = rows.length
      ? rows.map((r) => `<li data-release-version="${esc(r[0])}"><b>${esc(r[0])}</b><span>${esc(new Date(Number(r[1])).toLocaleString())}</span></li>`).join("")
      : '<li class="traceSvcEmpty">No ResourceAttributes[\'service.version\'] on this service\'s spans in range.</li>';
    return `<section class="traceSvcSection"><h4>Releases${payload.releases_estimated ? ' <span class="traceSvcBadge traceSvcBadge--estimated" title="The read cap stopped the scan: later versions may be missing.">\u2248</span>' : ""}</h4><ul class="traceSvcReleases">${items}</ul></section>`;
  }

  function dbHtml() {
    const db = view.db;
    if (db.loading && !db.payload) return '<div class="traceSvcEmpty">Loading database statements\u2026</div>';
    if (db.error) return `<div class="traceSvcEmpty traceChartError" role="alert">${esc(db.error)} ${RETRY("db")}</div>`;
    const payload = db.payload;
    if (!payload) return "";
    if (payload.supported === false) return '<div class="traceSvcEmpty">Span attributes are not stored as a Map column (or are disabled): database statements are unavailable.</div>';
    const rows = Array.isArray(payload.statements) ? payload.statements : [];
    if (!rows.length) return '<div class="traceSvcEmpty">No database spans (db.query.text / db.statement) for this service in range.</div>';
    const seconds = Math.max(1, (Number(payload.range?.[1]) - Number(payload.range?.[0])) / 1000);
    const total = rows.reduce((sum, r) => sum + Number(r[5] || 0), 0) || 1;
    return `<table class="traceSvcTable traceSvcTable--compact traceSvcDb" aria-label="Database statements"><thead><tr><th scope="col">Statement</th><th scope="col">System</th><th scope="col" class="is-num">Count</th><th scope="col" class="is-num">Throughput</th><th scope="col" class="is-num">P95</th><th scope="col">Total time</th></tr></thead><tbody>${rows.map((r) => {
      const share = (Number(r[5] || 0) / total) * 100;
      return `<tr data-db-statement="${esc(r[1])}"><th scope="row"><code class="traceSvcDb__stmt" title="${esc(r[1])}">${esc(r[1])}</code></th><td>${esc(r[2] || "\u2014")}</td><td class="is-num">${Number(r[3] || 0).toLocaleString()}</td><td class="is-num">${esc(rateText(Number(r[3] || 0) / seconds))}</td><td class="is-num">${esc(fmt(r[6]))}</td><td class="traceSvcShare"><span class="traceSvcShare__bar" style="--share:${share.toFixed(2)}%"></span><span class="traceSvcShare__text">${esc(fmt(r[5]))}</span></td></tr>`;
    }).join("")}</tbody></table>${payload.estimated ? '<div class="traceSvcEmpty">\u2248 The read cap or time budget stopped the scan: counts are partial.</div>' : ""}`;
  }

  // The selected service's totals row of a detail payload (rates included).
  function detailRow(payload, name) {
    return payload ? withRates((payload.services || []).map(statsRow), payload).find((r) => r.name === name) || null : null;
  }

  function renderDetail() {
    const panel = root?.querySelector("#traceSvcDetail");
    if (!panel) return;
    const name = view.detailName;
    panel.hidden = !name;
    root.querySelector(".traceSvc")?.classList.toggle("has-detail", !!name);
    releaseDetailCharts();
    if (!name) { panel.innerHTML = ""; return; }
    const detail = view.detail;
    const payload = detail.payload;
    const row = detailRow(payload, name);
    const stat = (labelText, value, extra = "") => `<div class="traceSvcStat${extra}"><span>${esc(labelText)}</span><b>${value}</b></div>`;
    const stats = row
      ? stat("Requests", esc(rateText(row.rate))) + stat("Errors", esc(percentText(row.errorPct)), row.errors ? " has-errors" : "") + stat("P50", esc(fmt(row.p50))) + stat("P95", esc(fmt(row.p95))) + stat("P99", p99Cell(row, name)) + stat("Total time", esc(fmt(row.total)))
      : "";
    let body;
    if (detail.error) body = `<div class="tracesEmpty traceChartError" role="alert">${esc(detail.error)} ${RETRY("detail")}</div>`;
    else if (!payload) body = '<div class="tracesEmpty">Loading service\u2026</div>';
    else if (!row) body = '<div class="tracesEmpty">No entry spans of this service match in this range.</div>';
    else {
      body = `${payload.estimated ? `<div class="traceSvcNote">\u2248 Estimated from ${esc(percentText(Number(payload.sample_fraction || 1) * 100))} of the window (one time slice per bucket). <button type="button" class="traceSvcAction" data-svc-exact>Compute exactly</button></div>` : ""}
        <div class="traceSvcCharts">
          <article class="traceAnalyticsCard"><header><strong>Requests</strong><span>${view.scope === "root" ? "root" : "entry"} spans per ${rateUnit(row.rate).word} · errors in red</span></header><div class="traceChart traceSvcChart" data-svc-chart="rate"></div></article>
          <article class="traceAnalyticsCard"><header><strong>Error rate</strong><span>% of entry spans with status Error</span></header><div class="traceChart traceSvcChart" data-svc-chart="errors"></div></article>
          <article class="traceAnalyticsCard"><header><strong>Latency</strong><span class="traceChartLegend--quantiles"><span class="p50">P50</span> <span class="p95">P95</span> <span class="p99">P99</span></span></header><div class="traceChart traceSvcChart" data-svc-chart="latency"></div></article>
        </div>
        ${releasesHtml(payload)}
        <section class="traceSvcSection"><h4>Most time-consuming endpoints</h4>${endpointsHtml(payload, name)}</section>
        <section class="traceSvcSection"><h4>Slowest spans</h4>${slowestHtml(payload)}</section>
        <section class="traceSvcSection"><h4>Database statements</h4>${dbHtml()}</section>`;
    }
    panel.innerHTML = `<header class="traceSvcDetail__head" style="--trace-service-color:${ctx.serviceColor(name)}">
        <span class="traceSvcDot" aria-hidden="true"></span>
        <h3 id="traceSvcDetailTitle" title="${esc(name)}">${esc(name)}</h3>
        ${detail.loading && payload ? '<span class="traceSvcBadge">Loading\u2026</span>' : ""}
        <button type="button" class="traceSvcAction" data-svc-search="${esc(name)}" title="Search the traces of ${esc(name)}">Search traces</button>
        <button type="button" class="traceSvcDetail__close" data-svc-close aria-label="Close service details" title="Close (Esc)">×</button>
      </header>
      ${stats ? `<div class="traceSvcStats">${stats}</div>` : ""}
      <div class="traceSvcDetail__body">${body}</div>`;
    drawDetailCharts();
  }

  // --------------------------------------------------------------- actions

  function openDetail(name, { push = true } = {}) {
    view.detailName = name || "";
    if (push) ns.traceSearch?.writeUrl?.("push");
    const table = root?.querySelector(".traceSvcTable");
    table?.querySelectorAll("[data-svc-row]").forEach((tr) => {
      const on = tr.getAttribute("data-svc-row") === view.detailName;
      tr.classList.toggle("is-selected", on);
      tr.setAttribute("aria-selected", on ? "true" : "false");
    });
    renderDetail();
    if (view.detailName) void loadDetail();
  }

  // The drawer's × and Escape: focus goes back to the service's row.
  function closeDetail() {
    const name = view.detailName;
    openDetail("");
    if (name) root?.querySelector(`[data-svc-row="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
  }

  function searchFor(spec) {
    ns.traceSearch?.applySearch?.(spec);
    ns.traceTabs.select("search");
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const sort = target.closest("[data-svc-sort]");
    if (sort) {
      const key = sort.getAttribute("data-svc-sort");
      view.sort = view.sort.key === key ? { key, dir: view.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" };
      ns.traceSearch?.writeUrl?.("replace");
      render();
      root.querySelector(`[data-svc-sort="${key}"]`)?.focus({ preventScroll: true });
      return;
    }
    const scope = target.closest("[data-svc-scope]");
    if (scope) {
      const value = scope.getAttribute("data-svc-scope") === "root" ? "root" : "entry";
      if (value !== view.scope) { view.scope = value; void ctx.runSearch({ url: "push" }); }
      return;
    }
    const retry = target.closest("[data-svc-retry]")?.getAttribute("data-svc-retry");
    if (retry === "list" && view.filters) { void run(view.filters, { force: true }); return; }
    if (retry === "detail") { view.detail.key = ""; void loadDetail(); return; }
    if (retry === "db" && view.filters && view.detailName) {
      view.db.key = "";
      void loadDb({ ...requestFilters(view.filters), detail: view.detailName });
      renderDetail();
      return;
    }
    if (target.closest("[data-svc-exact]")) { view.exact = true; void ctx.runSearch({ url: "push" }); return; }
    if (target.closest("[data-svc-sampled]")) { view.exact = false; void ctx.runSearch({ url: "push" }); return; }
    const p99 = target.closest("[data-svc-p99]");
    if (p99) {
      event.stopPropagation();
      searchFor({ service: p99.getAttribute("data-svc-service") || "", operation: p99.getAttribute("data-svc-operation") || "", minDurationMs: Number(p99.getAttribute("data-svc-p99")) / 1e6 });
      return;
    }
    const operation = target.closest("[data-svc-operation-search]");
    if (operation) { searchFor({ service: view.detailName, operation: operation.getAttribute("data-svc-operation-search") || "" }); return; }
    const searchButton = target.closest("[data-svc-search]");
    if (searchButton) { searchFor({ service: searchButton.getAttribute("data-svc-search") || "" }); return; }
    if (target.closest("[data-svc-close]")) { closeDetail(); return; }
    const trace = target.closest("[data-svc-trace]");
    if (trace) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
      event.preventDefault();
      ctx.model.pendingSpanId = trace.getAttribute("data-svc-span") || "";
      void ctx.loadTrace(trace.getAttribute("data-svc-trace"), { push: true });
      return;
    }
    const row = target.closest("[data-svc-row]");
    if (row) {
      const name = row.getAttribute("data-svc-row") || "";
      openDetail(name === view.detailName ? "" : name);
    }
  }

  function onKeydown(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (event.key === "Escape" && view.detailName && root && !root.hidden && !event.defaultPrevented
      && (!ns.observability || ns.observability.isActive("traces"))
      && !document.querySelector(".tracePicker.themeSelect--open, .traceSearchBar [aria-expanded='true']")) {
      event.preventDefault();
      closeDetail();
      return;
    }
    const row = target?.closest?.("[data-svc-row]");
    if (row && row === target && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openDetail(row.getAttribute("data-svc-row") || "");
    }
  }

  // ----------------------------------------------------------- URL state

  function writeParams(params) {
    if (view.scope !== "entry") params.set("svc_scope", view.scope);
    if (view.exact) params.set("svc_exact", "1");
    if (view.sort.key !== DEFAULT_SORT.key || view.sort.dir !== DEFAULT_SORT.dir) params.set("svc_sort", `${view.sort.key}:${view.sort.dir}`);
    if (view.detailName) params.set("svc", view.detailName);
  }

  function applyParams(params) {
    view.scope = params.get("svc_scope") === "root" ? "root" : "entry";
    view.exact = params.get("svc_exact") === "1";
    const [key, dir] = String(params.get("svc_sort") || "").split(":");
    view.sort = SORT_KEYS.includes(key) ? { key, dir: dir === "asc" ? "asc" : "desc" } : { ...DEFAULT_SORT };
    const name = params.get("svc") || "";
    const changed = name !== view.detailName;
    view.detailName = name;
    // Back / Forward within the view (sort, detail): no new search.
    if (view.payload && root && !root.hidden) {
      render();
      if (changed && name) void loadDetail();
    }
  }

  function mount(element, context) {
    ctx = context;
    root = element;
    root.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    render();
  }

  // Shown from a click or Back / Forward: the current search refreshes the
  // view unless it already shows it.
  function onShow() {
    const key = ns.traceSearch?.searchKey?.() || "";
    if (key !== view.searchKey || (!view.payload && !view.loading)) void ctx.runSearch({ url: "none" });
    else render();
  }

  ns.traceTabs.register({
    id: "services",
    label: "Services",
    order: 10,
    panelId: "traceServicesView",
    available: (meta) => meta?.analytics_enabled === true,
    install: (context) => { const element = document.getElementById("traceServicesView"); if (element) mount(element, context); },
    onSearch: (filters, options) => run(filters, options),
    onShow,
    params: ["svc", "svc_sort"],
    writeParams,
    applyParams,
  });

  ns.traceServices = { state: view };
})();
