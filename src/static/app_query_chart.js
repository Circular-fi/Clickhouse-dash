(() => {
  "use strict";

  // Query result charts: a Table / Chart toggle for a result panel and a
  // client-side chart drawn from the rows the panel already received (no
  // re-query). Each result panel (the main one and every multiquery panel)
  // owns one controller, so its view and chart settings live with the result.
  //
  // The chart is drawn once, when the stream has ended (done(): finished,
  // canceled or failed, with the rows received); while rows stream in, the
  // chart area only says how many have arrived. The rows are then parsed into
  // typed columns over a few frames (PARSE_BUDGET) and drawn by the shared
  // canvas engine (app_chart_core.js), loaded on the first Chart view.
  const ns = window.ChDash;
  if (!ns) return;
  const { $ } = ns.dom;
  const { h } = ns;

  const viewPref = () => ns.storage.pref(ns.storage.KEYS.resultsView, "table", { allowed: ["table", "chart"] });
  // Coloured series slots (--qchart-1..8); further groups fold into "Other".
  const MAX_SERIES = 8;
  const PLOT_HEIGHT = 300;
  // Values parsed per model build (about 5 ms), and builds per frame for at
  // most PARSE_SLICE_MS: a large result (1,000,000 rows of 5 columns) is
  // parsed over several frames, then drawn once, instead of one long task.
  const PARSE_BUDGET = 240000;
  const PARSE_SLICE_MS = 40;
  const SYNC_KEY = "query-results";
  // The chart engine: modules.json pages.query.lazy.chart.
  const CORE_GROUP = "chart";
  // The chart types: icon options (sprite names), named by aria-label (the
  // label) and title (the description), like the Table / Chart switch.
  const CHART_TYPES = [
    ["line", "Line", "One line per series", "chart-line"],
    ["area", "Area", "Stacked areas: the series add up", "chart-area-line"],
    ["bar", "Bars", "Bars: split values stack, Y columns stand side by side", "chart-bar"],
    ["number", "Number", "One big number per value (single-row results)", "number-123"],
  ];
  const NO_NUMERIC_TITLE = "Chart unavailable: the result has no numeric column";
  // The Table / Chart switch: icon options (16 px grid, stroked in
  // currentColor by .segmented__option svg), named by aria-label and title.
  const VIEW_ICONS = {
    table: ns.icon("table"),
    chart: ns.icon("chart-line"),
  };
  const VIEW_OPTIONS = [
    { value: "table", label: "Table view", title: "Show the rows as a table", html: VIEW_ICONS.table, iconOnly: true },
    { value: "chart", label: "Chart view", title: "Chart the received rows", html: VIEW_ICONS.chart, iconOnly: true },
  ];

  // Work counters of every result chart (test and profiling hooks:
  // ns.queryChart.counters(), resetCounters()). Increments only.
  const COUNTER_NAMES = ["renders", "plots", "modelBuilds", "modelMs", "rowsParsed", "typeDetections", "toolbarBuilds", "allocBytes"];
  const counters = {};
  function resetCounters() { for (const name of COUNTER_NAMES) counters[name] = 0; }
  resetCounters();

  function readStoredView() {
    return viewPref().get();
  }

  function storeView(view) {
    viewPref().set(view === "chart" ? "chart" : "table");
  }

  // --- Chart engine (lazy) ---------------------------------------------------

  let corePromise = null;

  function loadCore() {
    if (ns.chartCore) return Promise.resolve(ns.chartCore);
    if (!corePromise) {
      corePromise = ns.loader.loadGroup(CORE_GROUP).then(() => {
        if (!ns.chartCore) throw new Error("chart engine missing");
        return ns.chartCore;
      });
      corePromise.catch(() => { corePromise = null; });
    }
    return corePromise;
  }

  // --- Column types ---------------------------------------------------------

  function unwrapType(type) {
    let text = String(type || "").trim();
    for (let guard = 0; guard < 8; guard++) {
      const wrapper = /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(text);
      if (wrapper) { text = wrapper[1].trim(); continue; }
      const simple = /^SimpleAggregateFunction\([^,]+,\s*(.*)\)$/.exec(text);
      if (simple) { text = simple[1].trim(); continue; }
      break;
    }
    return text;
  }

  // "date" | "time" | "number" | "string" | "other"
  function columnKind(type) {
    counters.typeDetections++;
    const t = unwrapType(type);
    if (/^Date(?:32)?$/.test(t)) return "date";
    if (/^DateTime(?:64)?(?:\(.*\))?$/.test(t)) return "time";
    if (/^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|BFloat16|Decimal(?:32|64|128|256)?(?:\(.*\))?)$/.test(t)) return "number";
    if (/^(?:String|FixedString\(\d+\)|Enum(?:8|16)?\(.*\)|UUID|IPv4|IPv6|Bool)$/.test(t)) return "string";
    return "other";
  }

  function axisKindOf(columnKindValue) {
    if (columnKindValue === "date" || columnKindValue === "time") return "time";
    if (columnKindValue === "number") return "number";
    return "category";
  }

  // Short type name for the pickers: "DateTime", "UInt64", "Array(UInt64)".
  function typeHint(type) {
    const t = unwrapType(type);
    return t.length > 24 ? `${t.slice(0, 23)}\u2026` : t;
  }

  // --- Values ---------------------------------------------------------------

  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value === "string") {
      if (!value.trim()) return NaN;
      const n = Number(value);
      return Number.isFinite(n) ? n : NaN;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return NaN;
  }

  const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

  // Timestamps as the server writes them ("2026-10-01T09:27:06Z",
  // "...06.123Z", "...06+02:00", or local "2026-10-01 09:27:06") parse with
  // digit arithmetic: the date part is cached (rows usually share it), so no
  // Date or RegExp runs per row. Anything else returns NaN (slow path).
  const hourCache = new Map();
  let lastPrefix = "";
  let lastPrefixMs = 0;
  let lastPrefixUtc = false;
  const digit = (text, i) => text.charCodeAt(i) - 48;
  const two = (text, i) => digit(text, i) * 10 + digit(text, i + 1);

  function quickTimeText(text) {
    let end = text.length;
    if (end < 19 || text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45 || text.charCodeAt(13) !== 58 || text.charCodeAt(16) !== 58) return NaN;
    const sep = text.charCodeAt(10);
    if (sep !== 32 && sep !== 84) return NaN;
    let utc = false;
    let offsetMs = 0;
    const last = text.charCodeAt(end - 1);
    if (last === 90) { utc = true; end -= 1; } else if (end >= 25 && text.charCodeAt(end - 3) === 58) {
      const sign = text.charCodeAt(end - 6);
      if (sign === 43 || sign === 45) {
        utc = true;
        offsetMs = (two(text, end - 5) * 60 + two(text, end - 2)) * 60000 * (sign === 45 ? -1 : 1);
        end -= 6;
      }
    }
    let frac = 0;
    if (end > 19) {
      if (text.charCodeAt(19) !== 46) return NaN;
      let scale = 100;
      for (let i = 20; i < end; i++) {
        const d = digit(text, i);
        if (d < 0 || d > 9) return NaN;
        frac += d * scale;
        scale /= 10;
      }
    }
    const mm = two(text, 14), ss = two(text, 17);
    if (!(mm >= 0 && mm < 60 && ss >= 0 && ss < 61)) return NaN;
    // UTC: cache the day; local: cache the hour (offsets change on DST days).
    const prefixLen = utc ? 10 : 13;
    let base;
    if (lastPrefixUtc === utc && lastPrefix.length === prefixLen && text.startsWith(lastPrefix)) base = lastPrefixMs;
    else {
      const key = text.slice(0, prefixLen);
      const cacheKey = utc ? key : `L${key}`;
      base = hourCache.get(cacheKey);
      if (base === undefined) {
        const y = Number(text.slice(0, 4)), mo = two(text, 5) - 1, d = two(text, 8);
        base = utc ? Date.UTC(y, mo, d) : new Date(y, mo, d, two(text, 11)).getTime();
        if (hourCache.size > 8192) hourCache.clear();
        hourCache.set(cacheKey, base);
      }
      lastPrefix = key;
      lastPrefixMs = base;
      lastPrefixUtc = utc;
    }
    if (!(base === base)) return NaN;
    const ms = utc ? base + two(text, 11) * 3600000 + mm * 60000 + ss * 1000 - offsetMs : base + mm * 60000 + ss * 1000;
    return ms + frac;
  }

  // Milliseconds since the epoch (fractional below a millisecond). A bare date
  // is a calendar day (local midnight), so it reads the same day everywhere.
  function toTimeMs(value, kind) {
    if (value == null) return NaN;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return NaN;
      return kind === "date" ? value * 86400000 : value * 1000;
    }
    const quick = typeof value === "string" ? quickTimeText(value) : NaN;
    if (quick === quick) return quick;
    const text = String(value).trim();
    const m = ISO_TIME.exec(text);
    if (!m) {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    const [, y, mo, d, hour = "0", mi = "0", s = "0", frac = "", zone] = m;
    const fracMs = frac ? Number(`0.${frac}`) * 1000 : 0;
    const wholeMs = Math.floor(fracMs);
    if (!zone) {
      return new Date(Number(y), Number(mo) - 1, Number(d), Number(hour), Number(mi), Number(s), wholeMs).getTime() + (fracMs - wholeMs);
    }
    let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hour), Number(mi), Number(s), wholeMs) + (fracMs - wholeMs);
    if (zone !== "Z") {
      const sign = zone[0] === "-" ? -1 : 1;
      const digits = zone.slice(1).replace(":", "");
      ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
    }
    return ms;
  }

  function categoryKey(value) {
    if (value == null) return "NULL";
    if (typeof value === "object") {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }

  // --- Typed columns, parsed incrementally from the panel's rows ------------

  function growable(capacity = 1024) {
    counters.allocBytes += 8 * capacity;
    return { data: new Float64Array(capacity), length: 0 };
  }

  function pushValue(col, value) {
    if (col.length === col.data.length) {
      const next = new Float64Array(Math.max(1024, col.data.length * 2));
      counters.allocBytes += 8 * next.length;
      next.set(col.data);
      col.data = next;
    }
    col.data[col.length++] = value;
  }

  // One store per result: each column the chart reads is parsed once, up to
  // the rows received so far (rows only ever get appended).
  function createStore() {
    let rowsRef = null;
    const columns = new Map(); // "kind:index" -> parsed column

    function reset(rows) {
      rowsRef = rows;
      columns.clear();
    }

    // Parses the column up to row `end` (default: every row received).
    function column(rows, index, kind, columnKindValue, end = rows.length) {
      if (rows !== rowsRef) reset(rows);
      const key = `${kind}:${index}`;
      let col = columns.get(key);
      if (!col || col.parsed > rows.length) {
        col = { kind, parsed: 0, values: growable(Math.max(1024, rows.length)), keys: null, keyIndex: null };
        if (kind === "key") { col.keys = []; col.keyIndex = new Map(); }
        columns.set(key, col);
      }
      const values = col.values;
      counters.rowsParsed += Math.max(0, end - col.parsed);
      for (let r = col.parsed; r < end; r++) {
        const row = rows[r];
        let v;
        if (!Array.isArray(row)) v = NaN;
        else if (kind === "num") v = toNumber(row[index]);
        else if (kind === "time") v = toTimeMs(row[index], columnKindValue);
        else if (kind === "row") v = Number(row.__chdashRowIndex) || r + 1;
        else {
          const k = categoryKey(row[index]);
          v = col.keyIndex.get(k);
          if (v === undefined) {
            v = col.keys.length;
            col.keys.push(k);
            col.keyIndex.set(k, v);
          }
        }
        pushValue(values, v);
      }
      if (end > col.parsed) col.parsed = end;
      return col;
    }

    return { column, reset: () => reset(null) };
  }

  // --- Configuration --------------------------------------------------------

  function metaSignature(columns, types) {
    return JSON.stringify([columns, types]);
  }

  function autoX(kinds) {
    let x = kinds.findIndex((kind) => kind === "time" || kind === "date");
    if (x < 0) {
      const numeric = kinds.filter((kind) => kind === "number").length;
      if (kinds[0] === "number" && numeric >= 2) x = 0;
      else if (kinds[0] === "string") x = 0;
      else x = -1;
    }
    return x;
  }

  function defaultConfig(meta) {
    const { kinds } = meta;
    const x = autoX(kinds);
    const series = [];
    for (let i = 0; i < kinds.length; i++) if (kinds[i] === "number" && i !== x && series.length < MAX_SERIES) series.push(i);
    // A time series with a label column is usually the long form of
    // GROUP BY time, label: one line per label.
    let group = -1;
    if (x >= 0 && axisKindOf(kinds[x]) === "time") {
      group = kinds.findIndex((kind, i) => kind === "string" && i !== x);
    }
    return { x, xAuto: true, series, group, type: "line", typeAuto: true };
  }

  function normalizeConfig(cfg, meta) {
    const { kinds } = meta;
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < kinds.length;
    if (cfg.xAuto) cfg.x = autoX(kinds);
    if (cfg.x !== -1 && !valid(cfg.x)) cfg.x = -1;
    cfg.series = cfg.series.filter((i, pos, all) => valid(i) && i !== cfg.x && kinds[i] === "number" && all.indexOf(i) === pos).slice(0, MAX_SERIES);
    if (cfg.group !== -1 && (!valid(cfg.group) || cfg.group === cfg.x || cfg.series.includes(cfg.group))) cfg.group = -1;
    if (cfg.typeAuto) {
      const xKind = cfg.x < 0 ? "index" : axisKindOf(kinds[cfg.x]);
      cfg.type = xKind === "category" ? "bar" : "line";
    }
    return cfg;
  }

  // --- Model: typed columns -> ascending x and one value array per line -----

  // ns.palette: --qchart-1..8, and --qchart-other for a negative slot.
  function slotColor(slot) {
    return ns.palette.categorical(slot);
  }

  // What a model build learnt about the x column, kept for the next build of
  // the same result and configuration (rows are only appended): whether x is
  // ascending so far (the direct path) and has sub-millisecond instants, up
  // to which row. Once x goes down the general path stays.
  function modelKey(cfg) {
    return `${cfg.x}|${cfg.series.join(",")}|${cfg.group}`;
  }

  // The model of the first `limit` rows (default: all of them).
  function buildModel(cfg, meta, rows, store, scan = null, limit = rows.length) {
    const { kinds, columns } = meta;
    const xi = cfg.x;
    const xKind = xi < 0 ? "index" : axisKindOf(kinds[xi]);
    const xColumnKind = xi < 0 ? "" : kinds[xi];
    const n = Math.min(rows.length, limit);
    const xCol = xi < 0 ? store.column(rows, -1, "row", "", n)
      : xKind === "time" ? store.column(rows, xi, "time", xColumnKind, n)
        : xKind === "number" ? store.column(rows, xi, "num", "", n) : store.column(rows, xi, "key", "", n);
    const X = xCol.values.data;
    const series = cfg.series.slice();
    const seriesCols = series.map((col) => store.column(rows, col, "num", "", n).values.data);
    const gi = series.length ? cfg.group : -1;
    const groupCol = gi >= 0 ? store.column(rows, gi, "key", "", n) : null;
    const model = {
      xKind,
      xColumnKind,
      xLabel: xi < 0 ? "Row" : String(columns[xi]),
      xs: null,
      categories: xKind === "category" ? xCol.keys.slice() : [],
      lines: [],
      rowCount: n,
      skipped: 0,
      summed: false,
      foldedGroups: 0,
      subMillisecond: false,
    };

    // Lines: one per series column, or per series column and kept group.
    let groupSlotOf = null; // group code -> slot (kept groups), else Other
    let groupCount = 0;
    let hasOther = false;
    if (groupCol) {
      const codes = groupCol.values.data;
      const keys = groupCol.keys;
      const totals = new Float64Array(keys.length);
      const s0 = seriesCols[0];
      for (let r = 0; r < n; r++) {
        const v = s0[r];
        if (v === v) totals[codes[r]] += Math.abs(v);
      }
      const topN = Math.max(1, Math.floor(MAX_SERIES / series.length));
      const ranked = keys.map((key, code) => code).sort((a, b) => totals[b] - totals[a] || a - b);
      // Colours follow the group's first appearance, not its rank.
      const kept = ranked.slice(0, topN).sort((a, b) => a - b);
      model.foldedGroups = Math.max(0, ranked.length - kept.length);
      hasOther = model.foldedGroups > 0;
      groupCount = kept.length;
      groupSlotOf = new Int32Array(keys.length).fill(-1);
      kept.forEach((code, slot) => { groupSlotOf[code] = slot; });
      series.forEach((col, j) => {
        kept.forEach((code, g) => {
          const key = keys[code];
          model.lines.push({ id: `${col}\u0001${key}`, label: series.length > 1 ? `${columns[col]} \u00b7 ${key}` : key, slot: j * groupCount + g, seriesIndex: j });
        });
        if (hasOther) model.lines.push({ id: `${col}\u0001\u0002other`, label: series.length > 1 ? `${columns[col]} \u00b7 Other` : "Other", slot: -1, seriesIndex: j });
      });
    } else {
      series.forEach((col, j) => model.lines.push({ id: String(col), label: String(columns[col]), slot: j, seriesIndex: j }));
    }
    const perSeries = groupCol ? groupCount + (hasOther ? 1 : 0) : 1;

    // Direct path: one row per x, already ascending (ORDER BY x, numbers(),
    // GROUP BY with ORDER BY): the parsed columns are the drawn arrays.
    // The x scan resumes where the previous build of this result stopped.
    const key = modelKey(cfg);
    const resume = scan && scan.key === key && scan.n <= n ? scan : null;
    if (!groupCol && xKind !== "category" && (!resume || resume.increasing)) {
      const from = resume ? resume.n : 0;
      let increasing = n > 0;
      for (let r = from; r < n && increasing; r++) if (!(X[r] === X[r]) || (r > 0 && !(X[r] > X[r - 1]))) increasing = false;
      if (increasing) {
        model.xs = X.subarray(0, n);
        model.lines.forEach((line, j) => { line.values = seriesCols[j].subarray(0, n); line.nulls = null; });
        let sub = !!(resume && resume.subMillisecond);
        if (xKind === "time" && !sub) for (let r = from; r < n; r++) if (X[r] % 1 !== 0) { sub = true; break; }
        model.subMillisecond = sub;
        model.scan = { key, n, increasing: true, direct: true, subMillisecond: sub };
        return model;
      }
    }
    model.scan = { key, n, increasing: false, direct: false, subMillisecond: false };

    // General path: rows sorted by x (stable), equal x merged (values summed),
    // a NULL kept apart from a missing row (lines break at NULL, connect over
    // missing rows).
    let order;
    let valid = 0;
    const ordered = new Uint32Array(n);
    counters.allocBytes += 4 * n;
    for (let r = 0; r < n; r++) {
      if (X[r] === X[r]) ordered[valid++] = r;
      else model.skipped++;
    }
    order = ordered.subarray(0, valid);
    if (xKind !== "category") {
      let sorted = true;
      for (let k = 1; k < valid; k++) if (X[order[k]] < X[order[k - 1]]) { sorted = false; break; }
      if (!sorted) { order = Uint32Array.from(order).sort((a, b) => X[a] - X[b] || a - b); counters.allocBytes += 4 * valid; }
    }
    let u;
    let slotOf;
    if (xKind === "category") {
      u = xCol.keys.length;
      slotOf = (r) => X[r];
    } else {
      // Unique x positions along the order.
      const pos = new Uint32Array(n);
      const xsTmp = new Float64Array(valid);
      counters.allocBytes += 4 * n + 8 * valid;
      u = 0;
      for (let k = 0; k < valid; k++) {
        const r = order[k];
        if (u === 0 || X[r] !== xsTmp[u - 1]) xsTmp[u++] = X[r];
        pos[r] = u - 1;
      }
      model.xs = xsTmp.slice(0, u);
      slotOf = (r) => pos[r];
    }
    if (xKind === "category") {
      model.xs = new Float64Array(u);
      for (let i = 0; i < u; i++) model.xs[i] = i;
    }
    const codes = groupCol ? groupCol.values.data : null;
    const values = model.lines.map(() => new Float64Array(u).fill(NaN));
    const nulls = model.lines.map(() => new Uint8Array(u));
    counters.allocBytes += 9 * u * model.lines.length;
    const S = series.length;
    for (let k = 0; k < valid; k++) {
      const r = order[k];
      const idx = slotOf(r);
      let offset = 0;
      if (codes) {
        const slot = groupSlotOf[codes[r]];
        offset = slot < 0 ? groupCount : slot;
      }
      for (let j = 0; j < S; j++) {
        const v = seriesCols[j][r];
        const li = j * perSeries + offset;
        const column = values[li];
        const current = column[idx];
        if (!(v === v)) {
          if (!(current === current)) nulls[li][idx] = 1;
          continue;
        }
        if (current === current) { column[idx] = current + v; model.summed = true; } else { column[idx] = v; nulls[li][idx] = 0; }
      }
    }
    model.lines.forEach((line, li) => { line.values = values[li]; line.nulls = nulls[li]; });
    if (xKind === "time") model.subMillisecond = hasSubMillisecond(model.xs);
    return model;
  }

  function hasSubMillisecond(xs) {
    const step = Math.max(1, Math.floor(xs.length / 2000));
    for (let i = 0; i < xs.length; i += step) if (xs[i] % 1 !== 0) return true;
    return false;
  }

  // --- Controller -----------------------------------------------------------

  function createController({ getData, viewRoot, onViewChange = null, toggleClassName = "" } = {}) {
    // Table | Chart (icons) and the chart types: shared segmented controls
    // (app_ui_segmented.js), the main panel's and every multiquery panel's.
    const toggleEl = document.createElement("div");
    toggleEl.className = `resultsViewToggle ${toggleClassName}`.trim();
    toggleEl.hidden = true;
    ns.segmented.render(toggleEl, VIEW_OPTIONS, { attr: "view", value: "table", label: "Result view" });
    const chartBtn = $('[data-view="chart"]', toggleEl);

    const hostEl = document.createElement("div");
    hostEl.className = "queryChart chartCard";
    hostEl.innerHTML = `
      <div class="queryChart__toolbar chartCard__head">
        <div class="segmented queryChart__types chartCard__actions" role="group" aria-label="Chart type"></div>
        <div class="queryChart__field queryChart__xField" title="Column on the horizontal axis. Auto: the first date / time column, else the first numeric or text column, else the row number.">
          <select class="queryChart__x" data-field-label="X axis" aria-label="X axis column"></select>
        </div>
        <div class="queryChart__field queryChart__seriesField" title="Numeric columns drawn as series on the vertical axis.">
          <div class="themeSelect tracePicker queryChart__picker">
            <button type="button" class="button themeSelect__button tracePicker__button queryChart__seriesButton" aria-label="Y value columns"></button>
            <div class="themeSelect__menu tracePicker__menu queryChart__seriesMenu" role="listbox" aria-multiselectable="true" aria-label="Y value columns" tabindex="-1" hidden></div>
          </div>
        </div>
        <div class="queryChart__field queryChart__groupField" title="One series per distinct value of this column (long-format results such as GROUP BY time, label). The 8 largest are kept, the rest add up into Other.">
          <select class="queryChart__group" data-field-label="Split by" aria-label="Split by column"></select>
        </div>
        <span class="queryChart__note chartCard__meta"></span>
      </div>
      <div class="queryChart__range" hidden>
        <span class="queryChart__rangeText"></span>
        <span class="queryChart__rangeHint">Drag to zoom \u00b7 double-click to reset</span>
        <button type="button" class="queryChart__resetZoom" hidden title="Show the whole x range again (or double-click the plot)">Reset zoom</button>
      </div>
      <div class="queryChart__stage chartCard__body">
        <div class="queryChart__message" hidden></div>
        <div class="queryChart__numbers" hidden></div>
      </div>`;
    const typesEl = $(".queryChart__types", hostEl);
    const xSelect = $(".queryChart__x", hostEl);
    const seriesButton = $(".queryChart__seriesButton", hostEl);
    const seriesMenu = $(".queryChart__seriesMenu", hostEl);
    const groupSelect = $(".queryChart__group", hostEl);
    // X axis, Y values and Split by: ns.menu pickers (app_ui_menu.js), the
    // label inside the button ("X axis \u00b7 Auto (time)").
    ns.menu?.select(xSelect, { className: "queryChart__picker" });
    ns.menu?.select(groupSelect, { className: "queryChart__picker" });
    const seriesPicker = ns.menu?.multi(seriesButton, seriesMenu, { root: seriesButton.parentElement }) || null;
    const noteEl = $(".queryChart__note", hostEl);
    const rangeEl = $(".queryChart__range", hostEl);
    const rangeText = $(".queryChart__rangeText", hostEl);
    const resetZoomBtn = $(".queryChart__resetZoom", hostEl);
    const stageEl = $(".queryChart__stage", hostEl);
    const messageEl = $(".queryChart__message", hostEl);
    const numbersEl = $(".queryChart__numbers", hostEl);
    ns.segmented.render(typesEl, CHART_TYPES.map(([value, label, title, icon]) => ({ value, label, title, html: ns.icon(icon), iconOnly: true })), { attr: "type", label: "Chart type" });
    const typeButtons = new Map();
    for (const [type, , title] of CHART_TYPES) {
      const btn = $(`[data-type="${type}"]`, typesEl);
      btn.dataset.title = title;
      typeButtons.set(type, btn);
    }
    // A click pins the type, the pressed one included (Auto picks Number for
    // one row, Bars for a text x axis): syncTypeButtons marks the result.
    typesEl.addEventListener("click", (event) => {
      const btn = event.target instanceof Element ? event.target.closest("[data-type]") : null;
      if (!btn || btn.disabled || !cfg) return;
      cfg.type = btn.dataset.type;
      cfg.typeAuto = false;
      rememberConfig();
      syncToolbar();
      render();
    });

    let meta = null; // { columns, types, kinds, signature }
    let cfg = null;
    let lastCfg = null; // kept across results with the same columns and types
    let chosenView = readStoredView();
    let effective = "table";
    let model = null;
    let dirty = true;
    let renderRaf = 0;
    const hidden = new Set();
    let destroyed = false;
    let chart = null;
    let store = createStore();
    let scan = null; // buildModel's x scan, resumed by the next build
    let toolbarKey = "";
    let typeShown = "";
    let rangeKey = "";
    // A zoom reset goes with the next data the chart gets (one draw).
    let zoomReset = false;
    // The chart works only while it can be seen: in the Chart view (effective),
    // in a panel that is not collapsed (the host has a box) and in a tab that
    // is not in the background. Hidden, rows only mark the model dirty; the
    // chart is built when it shows.
    let hostVisible = false;
    const visibilityObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
        const box = entries[entries.length - 1].contentRect;
        const visible = box.width > 0 || box.height > 0;
        if (visible === hostVisible) return;
        hostVisible = visible;
        if (visible) scheduleRender();
      })
      : null;
    if (visibilityObserver) visibilityObserver.observe(hostEl); else hostVisible = true;
    const onDocumentVisibility = () => { if (!document.hidden) scheduleRender(); };
    document.addEventListener("visibilitychange", onDocumentVisibility);
    const canWork = () => !destroyed && effective === "chart" && hostVisible && !document.hidden;
    // Until the terminal event the chart area only shows the streaming
    // placeholder: the chart is drawn once, from the final rows (and a
    // one-row result may still grow: the Number view needs the stream done).
    let streamDone = false;

    function chartable() {
      return !!(meta && meta.kinds.some((kind) => kind === "number"));
    }

    function applyView() {
      const next = chosenView === "chart" && chartable() ? "chart" : "table";
      const can = chartable();
      toggleEl.hidden = !meta;
      chartBtn.disabled = !can;
      chartBtn.title = can ? "Chart the received rows" : NO_NUMERIC_TITLE;
      toggleEl.title = can ? "" : NO_NUMERIC_TITLE;
      ns.segmented?.set(toggleEl, next, "view");
      toggleEl.dataset.view = next;
      const changed = next !== effective;
      effective = next;
      if (viewRoot) viewRoot.classList.toggle("is-chartView", next === "chart");
      if (next === "chart") {
        syncToolbar();
        scheduleRender();
      } else {
        closeSeriesMenu();
        if (chart) chart.release();
      }
      if (changed && typeof onViewChange === "function") onViewChange(next);
    }

    function setView(view) {
      chosenView = view === "chart" ? "chart" : "table";
      storeView(chosenView);
      applyView();
    }

    ns.segmented.bind(toggleEl, { attr: "view", onChange: (view) => { setView(view); return false; } });
    // Fetch the engine as soon as a chart is likely.
    const prefetch = () => { if (chartable()) loadCore().catch(() => {}); };
    chartBtn.addEventListener("pointerenter", prefetch);
    chartBtn.addEventListener("focus", prefetch);

    // --- toolbar ---

    function syncToolbar() {
      if (!meta || !cfg) return;
      const key = `${meta.signature}|${cfg.x}|${cfg.xAuto}|${cfg.series.join(",")}|${cfg.group}`;
      if (key === toolbarKey) { syncTypeButtons(currentRows().length); return; }
      toolbarKey = key;
      counters.toolbarBuilds++;
      const { kinds, columns, types } = meta;
      const auto = autoX(kinds);
      const autoName = auto < 0 ? "row number" : columns[auto];
      const xOptions = [h("option", { value: "auto" }, `Auto (${autoName})`), h("option", { value: "-1" }, "Row number")];
      kinds.forEach((kind, i) => {
        xOptions.push(h("option", { value: i }, `${columns[i]} \u00b7 ${typeHint(types[i])}`));
      });
      h.replace(xSelect, xOptions);
      xSelect.value = cfg.xAuto ? "auto" : String(cfg.x);
      xSelect.dataset.column = String(cfg.x);
      xSelect.title = cfg.x < 0 ? "Row number" : `${columns[cfg.x]} (${types[cfg.x]})`;

      const options = [];
      kinds.forEach((kind, i) => {
        if (i === cfg.x) return;
        if (kind === "number") {
          const checked = cfg.series.includes(i);
          const disabled = !checked && cfg.series.length >= MAX_SERIES;
          options.push(h("label", { class: "queryChart__seriesOpt", title: disabled ? `At most ${MAX_SERIES} series` : null },
            h("input", { type: "checkbox", value: i, checked, disabled }), h("span", null, columns[i]), h("small", null, typeHint(types[i]))));
        } else {
          options.push(h("label", { class: "queryChart__seriesOpt is-unavailable", title: `${columns[i]} is ${types[i]}: only numeric columns can be drawn as Y values` },
            h("input", { type: "checkbox", disabled: true }), h("span", null, columns[i]), h("small", null, `${typeHint(types[i])} \u00b7 not numeric`)));
        }
      });
      h.replace(seriesMenu, options.length ? options : h("span", { class: "queryChart__seriesEmpty" }, "No other column"));
      const names = cfg.series.map((i) => meta.columns[i]);
      seriesButton.textContent = `Y values \u00b7 ${names.length ? names.join(", ") : "None"}`;
      seriesButton.title = names.length ? names.join(", ") : "Pick at least one numeric column";

      const groupOptions = [h("option", { value: "-1" }, "None")];
      kinds.forEach((kind, i) => {
        if (i === cfg.x || cfg.series.includes(i) || kind === "other") return;
        groupOptions.push(h("option", { value: i }, `${columns[i]} \u00b7 ${typeHint(types[i])}`));
      });
      h.replace(groupSelect, groupOptions);
      groupSelect.value = String(cfg.group);

      syncTypeButtons(currentRows().length);
    }

    function effectiveType(rowCount) {
      if (!cfg) return "line";
      if (rowCount === 1 && streamDone && (cfg.typeAuto || cfg.type === "number")) return "number";
      if (cfg.type === "number") return "line";
      return cfg.type;
    }

    function syncTypeButtons(rowCount) {
      const type = effectiveType(rowCount);
      for (const [key, btn] of typeButtons) {
        if (key === "number") {
          const disabled = !(rowCount === 1 && streamDone);
          if (btn.disabled !== disabled) {
            btn.disabled = disabled;
            btn.title = disabled ? "Number needs a single-row result" : btn.dataset.title;
          }
        }
      }
      if (type === typeShown) return;
      typeShown = type;
      ns.segmented?.set(typesEl, type, "type");
      hostEl.dataset.chartType = type;
    }

    xSelect.addEventListener("change", () => {
      if (!cfg) return;
      if (xSelect.value === "auto") {
        cfg.xAuto = true;
        cfg.x = autoX(meta.kinds);
      } else {
        const x = Number(xSelect.value);
        cfg.xAuto = false;
        cfg.x = Number.isInteger(x) ? x : -1;
      }
      if (cfg.group === cfg.x) cfg.group = -1;
      cfg.series = cfg.series.filter((i) => i !== cfg.x);
      if (!cfg.series.length) {
        const first = meta.kinds.findIndex((kind, i) => kind === "number" && i !== cfg.x);
        if (first >= 0) cfg.series = [first];
      }
      normalizeConfig(cfg, meta);
      configChanged({ resetZoom: true });
    });

    groupSelect.addEventListener("change", () => {
      if (!cfg) return;
      const g = Number(groupSelect.value);
      cfg.group = Number.isInteger(g) ? g : -1;
      normalizeConfig(cfg, meta);
      configChanged();
    });

    seriesMenu.addEventListener("change", (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement) || !cfg) return;
      const col = Number(input.value);
      if (input.checked) {
        if (!cfg.series.includes(col) && cfg.series.length < MAX_SERIES) cfg.series.push(col);
      } else cfg.series = cfg.series.filter((i) => i !== col);
      cfg.series.sort((a, b) => a - b);
      normalizeConfig(cfg, meta);
      configChanged({ keepMenu: true });
      const again = $(`input[value="${col}"]`, seriesMenu);
      if (again) again.focus({ preventScroll: true });
    });

    function closeSeriesMenu() {
      seriesPicker?.close({ immediate: true, focus: false });
    }

    resetZoomBtn.addEventListener("click", () => { if (chart) chart.resetZoom(); });

    function rememberConfig() {
      lastCfg = cfg ? { ...cfg, series: cfg.series.slice(), signature: meta.signature } : null;
    }

    function configChanged({ keepMenu = false, resetZoom = false } = {}) {
      rememberConfig();
      dirty = true;
      if (resetZoom) zoomReset = true;
      if (!keepMenu) closeSeriesMenu();
      syncToolbar();
      scheduleRender();
    }

    // --- data flow ---

    function currentRows() {
      const data = typeof getData === "function" ? getData() : null;
      return data && Array.isArray(data.rows) ? data.rows : [];
    }

    function setMeta(columns, types) {
      const cols = Array.isArray(columns) ? columns.map((c) => String(c ?? "")) : [];
      const tys = Array.isArray(types) ? types.map((t) => String(t ?? "")) : [];
      const signature = metaSignature(cols, tys);
      meta = { columns: cols, types: tys, kinds: tys.map(columnKind), signature };
      if (lastCfg && lastCfg.signature === signature) {
        cfg = normalizeConfig({ ...lastCfg, series: lastCfg.series.slice() }, meta);
      } else {
        cfg = normalizeConfig(defaultConfig(meta), meta);
        hidden.clear();
      }
      // A new result starts from the last view chosen anywhere.
      chosenView = readStoredView();
      streamDone = false;
      model = null;
      store = createStore();
      scan = null;
      toolbarKey = "";
      typeShown = "";
      delete hostEl.dataset.rowsCharted;
      dirty = true;
      zoomReset = true;
      rangeKey = "";
      hostEl.dataset.chartType = cfg.type;
      if (chosenView === "chart") prefetch();
      applyView();
    }

    // Streamed rows only update the placeholder's count (once per frame).
    function rowsChanged() {
      dirty = true;
      if (!canWork()) return;
      scheduleRender();
    }

    function done() {
      streamDone = true;
      dirty = true;
      if (effective !== "chart") return;
      syncToolbar();
      scheduleRender();
    }

    function reset() {
      meta = null;
      cfg = null;
      model = null;
      store = createStore();
      scan = null;
      toolbarKey = "";
      typeShown = "";
      delete hostEl.dataset.rowsCharted;
      dirty = true;
      if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
      clearPlot();
      applyView();
    }

    // At most one render per animation frame.
    function scheduleRender() {
      if (!canWork()) return;
      if (!renderRaf) renderRaf = requestAnimationFrame(() => { renderRaf = 0; render(); });
    }

    function setStage(mode) {
      messageEl.hidden = mode !== "message";
      numbersEl.hidden = mode !== "numbers";
      if (chart) chart.root.hidden = mode !== "chart";
      if (chart && mode !== "chart") chart.release();
      rangeEl.hidden = mode !== "chart";
      hostEl.dataset.stage = mode;
    }

    function clearPlot() {
      setStage("none");
      noteEl.textContent = "";
      delete hostEl.dataset.pointsDrawn;
    }

    function showMessage(text, { busy = false } = {}) {
      setStage("message");
      messageEl.classList.toggle("is-busy", busy);
      if (messageEl.textContent !== text) messageEl.textContent = text;
      noteEl.textContent = notChartedNote();
      delete hostEl.dataset.pointsDrawn;
    }

    // The chart area while rows stream in, or while the final rows parse.
    function showStreaming(count, verb = "Streaming") {
      showMessage(`${verb}\u2026 ${ns.format.countLabel(count, "row")}`, { busy: true });
    }

    function render() {
      if (!canWork() || !meta || !cfg) return;
      // A panel collapsed since the resize observer last reported (the end
      // of a multiquery statement folds its panel): checked once per render.
      if (typeof hostEl.checkVisibility === "function" && !hostEl.checkVisibility()) { hostVisible = false; return; }
      const rows = currentRows();
      syncTypeButtons(rows.length);
      // Nothing is drawn before the stream has ended.
      if (!streamDone) { showStreaming(rows.length); return; }
      if (!rows.length) { showMessage("No rows to chart."); return; }
      if (!cfg.series.length) { showMessage("Select at least one numeric column in Y values."); return; }
      const type = effectiveType(rows.length);
      if (type === "number") { renderNumber(rows); return; }
      if (!ns.chartCore) {
        if (!chart) showMessage("Loading the chart\u2026");
        loadCore().then(() => scheduleRender(), () => showMessage("The chart engine failed to load."));
        return;
      }
      const t0 = performance.now();
      counters.renders++;
      if (dirty || !model) {
        // The direct path (ascending x) parses PARSE_BUDGET new values per
        // build and builds for PARSE_SLICE_MS per frame; the chart is drawn
        // once every row is parsed. The general path sorts every row anyway.
        const perRow = 1 + cfg.series.length + (cfg.group >= 0 ? 1 : 0);
        const step = Math.max(1024, Math.floor(PARSE_BUDGET / perRow));
        do {
          const tm = performance.now();
          const sameScan = scan && scan.key === modelKey(cfg) ? scan : null;
          const limit = !sameScan || sameScan.direct ? Math.min(rows.length, (sameScan ? sameScan.n : 0) + step) : rows.length;
          model = buildModel(cfg, meta, rows, store, scan, limit);
          scan = model.scan;
          counters.modelBuilds++;
          counters.modelMs += performance.now() - tm;
        } while (model.rowCount < rows.length && performance.now() - t0 < PARSE_SLICE_MS);
        if (model.rowCount < rows.length) {
          // Rows left to parse: the next frame goes on.
          showStreaming(rows.length, "Charting");
          scheduleRender();
          return;
        }
        // Test hook: the rows the chart shows.
        hostEl.dataset.rowsCharted = String(model.rowCount);
        hostEl.dataset.modelMs = (performance.now() - t0).toFixed(2);
        dirty = false;
      }
      if (hostEl.dataset.xKind !== model.xKind) hostEl.dataset.xKind = model.xKind;
      if (!model.xs.length) { showMessage(`No chartable rows: ${model.xLabel} has no usable values.`); return; }
      renderPlot(type);
      hostEl.dataset.renderMs = (performance.now() - t0).toFixed(2);
    }

    function renderNumber(rows) {
      setStage("numbers");
      const row = rows[0];
      // One row: every charted value, the numeric X column included.
      const cols = cfg.series.slice();
      if (cfg.x >= 0 && meta.kinds[cfg.x] === "number" && !cols.includes(cfg.x)) cols.push(cfg.x);
      cols.sort((a, b) => a - b);
      const format = ns.chartCore ? ns.chartCore.formatValue : formatFullNumber;
      h.replace(numbersEl, cols.map((col) => {
        const v = toNumber(Array.isArray(row) ? row[col] : NaN);
        return h("div", { class: "queryChart__number" }, h("span", { class: "queryChart__numberLabel" }, meta.columns[col]),
          h("span", { class: "queryChart__numberValue" }, v === v ? format(v) : h.html(ns.format.nullToken())));
      }));
      noteEl.textContent = "1 row";
      delete hostEl.dataset.pointsDrawn;
    }

    function notChartedNote() {
      if (!meta || !cfg) return "";
      const skipped = meta.kinds.map((kind, i) => (kind !== "number" && i !== cfg.x && i !== cfg.group ? i : -1)).filter((i) => i >= 0);
      if (!skipped.length) return "";
      const names = skipped.slice(0, 2).map((i) => meta.columns[i]).join(", ");
      return `not numeric, not drawn: ${names}${skipped.length > 2 ? ` +${skipped.length - 2}` : ""}`;
    }

    function buildNote() {
      const fmt = ns.chartCore.formatExact;
      const parts = [`${fmt(model.rowCount)} row${model.rowCount === 1 ? "" : "s"}`];
      const width = chart && chart.layout() ? chart.layout().plotW : 1000;
      if (model.xs.length > width * 2) parts.push(`${fmt(model.xs.length)} points, min/max envelope per pixel`);
      if (model.summed) parts.push(`rows sharing the same ${model.xLabel} are summed`);
      if (model.foldedGroups) parts.push(`${model.foldedGroups} group${model.foldedGroups === 1 ? "" : "s"} folded into Other`);
      if (model.skipped) parts.push(`${fmt(model.skipped)} row${model.skipped === 1 ? "" : "s"} without ${model.xLabel} skipped`);
      const other = notChartedNote();
      if (other) parts.push(other);
      return parts.join(" \u00b7 ");
    }

    function rangeLabel(info) {
      const core = ns.chartCore;
      const xs = model.xs;
      const zoomed = info && info.zoomed;
      let lo = zoomed ? info.xLo : xs[0];
      let hi = zoomed ? info.xHi : xs[xs.length - 1];
      const label = h("b", null, model.xLabel);
      if (model.xKind === "category") {
        const a = Math.max(0, Math.ceil(lo)), b = Math.min(xs.length - 1, Math.floor(hi));
        const count = Math.max(0, b - a + 1);
        return [label, ` ${core.formatExact(count)} of ${core.formatExact(xs.length)} values${zoomed && count ? `: ${model.categories[a]} \u2026 ${model.categories[b]}` : ""}`];
      }
      if (model.xKind === "time") {
        const digits = model.xColumnKind === "date" ? 0 : model.subMillisecond ? 6 : 3;
        const text = (v) => (model.xColumnKind === "date" ? core.formatInstant(v, 0).slice(0, 10) : core.formatInstant(v, digits));
        let to = text(hi);
        const from = text(lo);
        if (to.slice(0, 10) === from.slice(0, 10)) to = to.slice(11);
        return [label, ` ${from} \u2192 ${to} `, h("span", null, `${core.formatDuration(hi - lo)} \u00b7 ${core.utcOffsetText(lo)}`)];
      }
      if (zoomed) { lo = Number(lo.toPrecision(10)); hi = Number(hi.toPrecision(10)); }
      return [label, ` ${core.formatExact(lo)} \u2192 ${core.formatExact(hi)}`];
    }

    function onDraw(info) {
      hostEl.dataset.pointsDrawn = String(info.points);
      hostEl.dataset.zoomed = String(info.zoomed);
      resetZoomBtn.hidden = !info.zoomed;
      rangeEl.classList.toggle("is-zoomed", info.zoomed);
      if (!model || !model.xs.length) return;
      const xs = model.xs;
      const key = `${model.xLabel}|${model.xKind}|${info.zoomed ? `${info.xLo}|${info.xHi}` : `${xs[0]}|${xs[xs.length - 1]}|${xs.length}`}`;
      if (key === rangeKey) return;
      rangeKey = key;
      h.replace(rangeText, rangeLabel(info));
    }

    function renderPlot(type) {
      counters.plots++;
      const core = ns.chartCore;
      const lines = model.lines;
      const series = lines.map((line) => ({
        id: line.id,
        label: line.label,
        color: slotColor(line.slot),
        values: line.values,
        nulls: line.nulls,
        // Areas stack every line; bars stack the groups of one Y column and
        // put the columns side by side (different measures never add up).
        group: type === "area" ? 0 : line.seriesIndex,
      }));
      const data = {
        xKind: model.xKind,
        xs: model.xs,
        categories: model.categories,
        series,
        type,
        stack: type === "area" || type === "bar",
        xLabel: model.xLabel,
        xFractionDigits: model.subMillisecond ? 6 : 3,
        xDateOnly: model.xColumnKind === "date",
        hidden: Array.from(hidden),
      };
      if (zoomReset) { data.zoom = null; zoomReset = false; }
      setStage("chart");
      if (!chart) {
        chart = core.create(stageEl, {
          ...data,
          height: PLOT_HEIGHT,
          syncKey: SYNC_KEY,
          onDraw,
          onHiddenChange: (next) => { hidden.clear(); for (const id of next) hidden.add(id); },
        });
      } else {
        if (chart.root.hidden) chart.root.hidden = false;
        chart.update(data);
        // Already in an animation frame: draw now, not one frame later.
        chart.flush();
      }
      const label = chartAriaLabel(type);
      if (chart.root.getAttribute("aria-label") !== label) chart.root.setAttribute("aria-label", label);
      if (chart.root.getAttribute("role") !== "img") chart.root.setAttribute("role", "img");
      const note = buildNote();
      if (noteEl.textContent !== note) noteEl.textContent = note;
    }

    function chartAriaLabel(type) {
      const names = model.lines.map((line) => line.label).join(", ");
      const kind = type === "area" ? "Stacked area chart" : type === "bar" ? "Bar chart" : "Line chart";
      return `${kind} of ${names} by ${model.xLabel}`;
    }

    function destroy() {
      destroyed = true;
      if (visibilityObserver) visibilityObserver.disconnect();
      document.removeEventListener("visibilitychange", onDocumentVisibility);
      closeSeriesMenu();
      if (renderRaf) cancelAnimationFrame(renderRaf);
      renderRaf = 0;
      if (chart) chart.destroy();
      chart = null;
      model = null;
      store = createStore();
    }

    return {
      toggleEl,
      hostEl,
      setMeta,
      rowsChanged,
      done,
      reset,
      destroy,
      getView: () => effective,
      setView,
      getChart: () => chart,
    };
  }

  // The Number view formats before the engine has loaded.
  function formatFullNumber(value) {
    if (!Number.isFinite(value)) return "null";
    if (Number.isInteger(value)) return value.toLocaleString("en-US");
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 1e-6 || abs >= 1e15)) return value.toPrecision(6);
    return Number(value.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  }

  ns.queryChart = {
    createController,
    loadCore,
    // Exposed for reuse and tests.
    columnKind,
    toTimeMs,
    counters: () => ({ ...counters }),
    resetCounters,
  };
})();
